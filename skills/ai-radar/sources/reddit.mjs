// sources/reddit.mjs — top posts from AI/agent subreddits. Reddit blocks anonymous use of the
// .json API (403) but serves RSS/Atom feeds to clients with a descriptive User-Agent. It also
// rate-limits bursts hard (429), so we fetch ONE multi-subreddit feed (r/a+b+c/top.rss) per run
// — a single request per hour — with one backoff retry. Pure HTTP, cron-safe.
//
// For link posts the entry <link> is the comments page and the external article URL is inside
// the content html as <a href="...">[link]</a>; we prefer the external URL as the item URL so
// cross-source dedup (same article on HN / a feed / X) works, and keep the discussion link in
// the summary. Each entry's <category term> names its subreddit.
import { openDb, loadConfig, upsertItem } from '../db.mjs';

const log = (...a) => process.stderr.write('[reddit] ' + a.join(' ') + '\n');
const UA = 'macos:ai-radar:v0.1 (personal news aggregator)';

const unesc = (s) => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&#32;/g, ' ').replace(/&amp;/g, '&');
const strip = (s) => unesc(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function fetchFeed(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': UA } });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, xml: await r.text() };
  } catch (e) {
    return { ok: false, status: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(to); }
}

function parseEntries(xml) {
  const out = [];
  for (const b of xml.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
    const title = strip((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const comments = (b.match(/<link href="([^"]+)"/) || [])[1] || '';
    const published = (b.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
    const author = strip((b.match(/<name>([\s\S]*?)<\/name>/) || [])[1] || '');
    const sub = (b.match(/<category term="([^"]+)"/) || [])[1] || '';
    const contentRaw = unesc((b.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '');
    // external article URL: the <a href="...">[link]</a> anchor, when it isn't the comments page
    let external = '';
    const linkA = contentRaw.match(/<a href="([^"]+)">\s*\[link\]\s*<\/a>/);
    if (linkA && !linkA[1].includes('reddit.com')) external = linkA[1];
    // self-post body: the div.md block, stripped
    const bodyM = contentRaw.match(/<div class="md">([\s\S]*?)<\/div>/);
    const body = bodyM ? strip(bodyM[1]).slice(0, 400) : '';
    if (title && comments) out.push({ title, comments, external, published, author, body, sub });
  }
  return out;
}

export async function ingestReddit(db, cfg) {
  const rd = cfg.reddit || {};
  if (rd.enabled === false || !(rd.subreddits || []).length) return { scanned: 0, added: 0, skipped: 'disabled' };
  const cutoff = Date.now() - (cfg.lookbackDays || 21) * 86400000;
  const url = `https://www.reddit.com/r/${rd.subreddits.join('+')}/top.rss?t=${rd.window || 'day'}&limit=${rd.max ?? 25}`;

  let res = await fetchFeed(url);
  if (!res.ok && res.status === 429) {
    log('429 — backing off 20s and retrying once');
    await new Promise(r => setTimeout(r, 20000));
    res = await fetchFeed(url);
  }
  if (!res.ok) { log(`skip (${res.status})`); return { scanned: 0, added: 0, error: String(res.status) }; }

  let scanned = 0, added = 0;
  for (const e of parseEntries(res.xml)) {
    const t = Date.parse(e.published);
    if (Number.isFinite(t) && t < cutoff) continue;
    scanned++;
    const subTag = e.sub ? `r/${e.sub}` : 'reddit';
    const summary = [e.body, `[${subTag} discussion](${e.comments})`].filter(Boolean).join(' · ');
    const isNew = upsertItem(db, {
      source: 'reddit', kind: 'discussion',
      title: e.title,
      url: e.external || e.comments, // external article when present → cross-source dedup
      summary, author: e.author,
      published: Number.isFinite(t) ? new Date(t).toISOString() : null,
      tags: ['reddit', subTag],
      raw: { comments: e.comments, external: e.external || null, sub: e.sub },
      discussion: { url: e.comments, note: subTag },
    });
    if (isNew) added++;
  }
  log(`scanned ${scanned}, new ${added}`);
  return { scanned, added };
}

// Standalone: `node sources/reddit.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  ingestReddit(db, loadConfig())
    .then(r => { process.stdout.write(JSON.stringify(r) + '\n'); db.close(); })
    .catch(e => { log('FATAL:', e.message); process.exit(1); });
}
