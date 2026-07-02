// sources/arxiv.mjs — recent agent/LLM research from arXiv via its public Atom API (no auth).
// Pure HTTP, polite spacing between queries — safe for the hourly cron. Uses the entry <id>
// (canonical abs URL) since arXiv puts href before rel on <link>, which trips order-sensitive regex.
import { openDb, loadConfig, upsertItem } from '../db.mjs';

const log = (...a) => process.stderr.write('[arxiv] ' + a.join(' ') + '\n');
const clean = (s) => (s ? s.replace(/\s+/g, ' ').trim() : '');
const pick = (b, t) => { const m = b.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'i')); return m ? clean(m[1]) : ''; };

function parseArxiv(xml) {
  const out = [];
  for (const b of xml.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
    const title = pick(b, 'title');
    const url = pick(b, 'id').replace(/^http:/, 'https:'); // http://arxiv.org/abs/NNNN
    const summary = pick(b, 'summary');
    const published = pick(b, 'published');
    const authors = (b.match(/<name>([\s\S]*?)<\/name>/g) || []).map(m => clean(m.replace(/<\/?name>/g, '')));
    const cat = (b.match(/<category[^>]*term="([^"]+)"/) || [])[1] || '';
    if (title && url) out.push({ title, url, summary, published, authors, cat });
  }
  return out;
}

async function query(q, max) {
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&sortBy=submittedDate&sortOrder=descending&max_results=${max}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'ai-radar/0.1' } });
    if (!r.ok) { log(`"${q}" -> HTTP ${r.status}`); return []; }
    return parseArxiv(await r.text());
  } catch (e) {
    log(`"${q}" failed:`, e.name === 'AbortError' ? 'timeout' : e.message); return [];
  } finally { clearTimeout(to); }
}

export async function ingestArxiv(db, cfg) {
  const ax = cfg.arxiv || {};
  if (ax.enabled === false) return { scanned: 0, added: 0, skipped: 'disabled' };
  const cutoff = Date.now() - (cfg.lookbackDays || 21) * 86400000;
  let scanned = 0, added = 0, first = true;
  const seen = new Set();
  for (const q of (ax.queries || [])) {
    if (!first) await new Promise(r => setTimeout(r, 1100)); // be polite to the arXiv API
    first = false;
    for (const e of await query(q, ax.max ?? 12)) {
      const t = Date.parse(e.published);
      if (Number.isFinite(t) && t < cutoff) continue;
      if (seen.has(e.url)) continue;
      seen.add(e.url);
      scanned++;
      const author = e.authors.length ? e.authors[0] + (e.authors.length > 1 ? ` +${e.authors.length - 1}` : '') : null;
      const isNew = upsertItem(db, {
        source: 'arxiv', kind: 'paper', title: e.title, url: e.url,
        summary: e.summary.slice(0, 400), author,
        published: Number.isFinite(t) ? new Date(t).toISOString() : null,
        tags: ['arxiv', e.cat].filter(Boolean),
      });
      if (isNew) added++;
    }
  }
  log(`scanned ${scanned}, new ${added}`);
  return { scanned, added };
}

// Standalone: `node sources/arxiv.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  ingestArxiv(db, loadConfig())
    .then(r => { process.stdout.write(JSON.stringify(r) + '\n'); db.close(); })
    .catch(e => { log('FATAL:', e.message); process.exit(1); });
}
