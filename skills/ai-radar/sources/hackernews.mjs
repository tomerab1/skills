// sources/hackernews.mjs — top AI/agent/Claude/MCP stories from Hacker News via the public
// Algolia HN Search API (no auth, pure HTTP) — cheap enough for the hourly cron. Filters by
// points + recency so only stories that actually got traction land in the knowledge graph.
import { openDb, loadConfig, upsertItem } from '../db.mjs';

const log = (...a) => process.stderr.write('[hn] ' + a.join(' ') + '\n');

async function searchHN(query, sinceTs) {
  // NB: the HN Algolia index only allows `created_at_i` in numericFilters (not `points`),
  // so we filter recency server-side and points client-side from each hit's `points`.
  const params = new URLSearchParams({
    query, tags: 'story', hitsPerPage: '30',
    numericFilters: `created_at_i>=${sinceTs}`,
  });
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`https://hn.algolia.com/api/v1/search?${params}`, {
      signal: ctrl.signal, headers: { 'user-agent': 'ai-radar/0.1' },
    });
    if (!r.ok) { log(`search "${query}" -> HTTP ${r.status}`); return []; }
    return (await r.json()).hits || [];
  } catch (e) {
    log(`search "${query}" failed:`, e.name === 'AbortError' ? 'timeout' : e.message);
    return [];
  } finally { clearTimeout(to); }
}

export async function ingestHackerNews(db, cfg) {
  const hn = cfg.hackernews || {};
  if (hn.enabled === false) return { scanned: 0, added: 0, skipped: 'disabled' };
  const minPoints = hn.minPoints ?? 40;
  const sinceTs = Math.floor((Date.now() - (cfg.lookbackDays || 21) * 86400000) / 1000);
  let scanned = 0, added = 0;
  const seen = new Set();
  for (const q of (hn.queries || [])) {
    for (const h of await searchHN(q, sinceTs)) {
      if (!h.title || (h.points || 0) < minPoints || seen.has(h.objectID)) continue;
      seen.add(h.objectID);
      scanned++;
      const hnUrl = `https://news.ycombinator.com/item?id=${h.objectID}`;
      const isNew = upsertItem(db, {
        source: 'hackernews', kind: 'story',
        title: h.title, url: h.url || hnUrl,
        summary: `▲ ${h.points} points · ${h.num_comments || 0} comments · [HN discussion](${hnUrl})`,
        author: h.author, published: new Date(h.created_at_i * 1000).toISOString(),
        tags: ['hn', q], raw: { points: h.points, comments: h.num_comments, id: h.objectID },
      });
      if (isNew) added++;
    }
  }
  log(`scanned ${scanned}, new ${added}`);
  return { scanned, added };
}

// Standalone: `node sources/hackernews.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  ingestHackerNews(db, loadConfig())
    .then(r => { process.stdout.write(JSON.stringify(r) + '\n'); db.close(); })
    .catch(e => { log('FATAL:', e.message); process.exit(1); });
}
