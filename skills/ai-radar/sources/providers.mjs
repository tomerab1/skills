// sources/providers.mjs — pull AI provider / blog feeds (Anthropic, OpenAI, Google, HF,
// GitHub, Simon Willison, Latent Space). Generic RSS+Atom parsing with no dependency —
// good enough for titles/links/dates, fails gracefully per-feed.
import { upsertItem } from '../db.mjs';

const log = (...a) => process.stderr.write('[providers] ' + a.join(' ') + '\n');

function clean(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? clean(m[1]) : '';
};

function parseFeed(xml) {
  const out = [];
  // Atom <entry>
  for (const b of xml.match(/<entry[\s\S]*?<\/entry>/g) || []) {
    const title = tag(b, 'title');
    let link =
      (b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || [])[1] ||
      (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || '';
    const date = tag(b, 'updated') || tag(b, 'published');
    const summary = tag(b, 'summary') || tag(b, 'content');
    if (title && link) out.push({ title, link, date, summary: summary.slice(0, 500) });
  }
  // RSS <item>
  for (const b of xml.match(/<item[\s\S]*?<\/item>/g) || []) {
    const title = tag(b, 'title');
    const link = tag(b, 'link') || (b.match(/<link[^>]*>([^<]+)<\/link>/i) || [])[1] || '';
    const date = tag(b, 'pubDate') || tag(b, 'date');
    const summary = tag(b, 'description');
    if (title && link) out.push({ title, link, date, summary: summary.slice(0, 500) });
  }
  return out;
}

async function fetchFeed(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, xml: await r.text() };
  } catch (e) {
    return { ok: false, status: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(to);
  }
}

export async function ingestProviders(db, cfg) {
  let scanned = 0, added = 0, okFeeds = 0;
  const cutoff = Date.now() - (cfg.lookbackDays || 21) * 86400000;
  for (const p of (cfg.providers || [])) {
    const res = await fetchFeed(p.url);
    if (!res.ok) { log(`skip ${p.name} (${res.status})`); continue; }
    okFeeds++;
    const entries = parseFeed(res.xml).slice(0, 15);
    for (const e of entries) {
      const t = Date.parse(e.date);
      if (Number.isFinite(t) && t < cutoff) continue; // older than lookback
      scanned++;
      const isNew = upsertItem(db, {
        source: 'provider', kind: 'post', title: e.title, url: e.link,
        summary: e.summary, author: p.name,
        published: Number.isFinite(t) ? new Date(t).toISOString() : null,
        tags: ['post', p.name],
      });
      if (isNew) added++;
    }
  }
  log(`feeds ok ${okFeeds}/${(cfg.providers || []).length}, scanned ${scanned}, new ${added}`);
  return { scanned, added, okFeeds };
}
