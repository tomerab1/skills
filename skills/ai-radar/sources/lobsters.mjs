// sources/lobsters.mjs — lobste.rs tag feeds via their public JSON API (no auth, pure HTTP,
// cron-safe). Tiny volume, very high signal-to-noise — a good complement to Hacker News.
import { openDb, loadConfig, upsertItem } from '../db.mjs';

const log = (...a) => process.stderr.write('[lobsters] ' + a.join(' ') + '\n');

async function getJson(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'ai-radar/0.1' } });
    if (!r.ok) { log(`${url} -> HTTP ${r.status}`); return []; }
    return await r.json();
  } catch (e) {
    log('fetch failed:', e.name === 'AbortError' ? 'timeout' : e.message);
    return [];
  } finally { clearTimeout(to); }
}

export async function ingestLobsters(db, cfg) {
  const lb = cfg.lobsters || {};
  if (lb.enabled === false) return { scanned: 0, added: 0, skipped: 'disabled' };
  const minScore = lb.minScore ?? 5;
  const cutoff = Date.now() - (cfg.lookbackDays || 21) * 86400000;
  let scanned = 0, added = 0;
  const seen = new Set();
  for (const tag of (lb.tags || ['ai'])) {
    for (const s of await getJson(`https://lobste.rs/t/${tag}.json`)) {
      if (!s.title || seen.has(s.short_id_url)) continue;
      seen.add(s.short_id_url);
      if ((s.score || 0) < minScore) continue;
      const t = Date.parse(s.created_at);
      if (Number.isFinite(t) && t < cutoff) continue;
      scanned++;
      const isNew = upsertItem(db, {
        source: 'lobsters', kind: 'story',
        title: s.title, url: s.url || s.short_id_url,
        summary: `▲ ${s.score} · ${s.comment_count || 0} comments · [discussion](${s.short_id_url})`,
        author: s.submitter_user?.username || s.submitter_user || null,
        published: Number.isFinite(t) ? new Date(t).toISOString() : null,
        tags: ['lobsters', ...(s.tags || []).slice(0, 3)],
        raw: { score: s.score, comments: s.comment_count, discussion: s.short_id_url },
        discussion: { url: s.short_id_url, note: `Lobsters ▲${s.score}` },
      });
      if (isNew) added++;
    }
  }
  log(`scanned ${scanned}, new ${added}`);
  return { scanned, added };
}

// Standalone: `node sources/lobsters.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  ingestLobsters(db, loadConfig())
    .then(r => { process.stdout.write(JSON.stringify(r) + '\n'); db.close(); })
    .catch(e => { log('FATAL:', e.message); process.exit(1); });
}
