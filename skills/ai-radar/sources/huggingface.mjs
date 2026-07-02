// sources/huggingface.mjs — trending models from the Hugging Face hub API (no auth, pure
// HTTP, cron-safe). Records trendingScore/downloads/likes into metrics so the KG can answer
// "which models are heating up" via deltas, same as repo stars.
import { openDb, loadConfig, upsertItem, upsertEntity, recordMetric } from '../db.mjs';

const log = (...a) => process.stderr.write('[hf] ' + a.join(' ') + '\n');
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

export async function ingestHuggingFace(db, cfg) {
  const hf = cfg.huggingface || {};
  if (hf.enabled === false) return { scanned: 0, added: 0, skipped: 'disabled' };
  const max = hf.max ?? 15;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  let models = [];
  try {
    const r = await fetch(`https://huggingface.co/api/models?sort=trendingScore&limit=${max}`,
      { signal: ctrl.signal, headers: { 'user-agent': 'ai-radar/0.1' } });
    if (!r.ok) { log(`HTTP ${r.status}`); return { scanned: 0, added: 0 }; }
    models = await r.json();
  } catch (e) {
    log('fetch failed:', e.name === 'AbortError' ? 'timeout' : e.message);
    return { scanned: 0, added: 0 };
  } finally { clearTimeout(to); }

  let scanned = 0, added = 0;
  for (const m of models) {
    if (!m.id) continue;
    scanned++;
    const url = `https://huggingface.co/${m.id}`;
    const bits = [m.pipeline_tag, `▼ ${fmt(m.downloads || 0)} downloads`, `♥ ${fmt(m.likes || 0)}`]
      .filter(Boolean).join(' · ');
    const isNew = upsertItem(db, {
      source: 'huggingface', kind: 'model', title: m.id, url,
      summary: bits, author: m.id.split('/')[0], published: m.createdAt,
      tags: ['model', m.pipeline_tag].filter(Boolean),
      raw: { likes: m.likes, downloads: m.downloads, trendingScore: m.trendingScore },
    });
    if (isNew) added++;
    upsertEntity(db, { type: 'model', name: m.id, url });
    recordMetric(db, `hf:${m.id}`, 'trend', m.trendingScore);
    recordMetric(db, `hf:${m.id}`, 'downloads', m.downloads);
  }
  log(`scanned ${scanned}, new ${added}`);
  return { scanned, added };
}

// Standalone: `node sources/huggingface.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  ingestHuggingFace(db, loadConfig())
    .then(r => { process.stdout.write(JSON.stringify(r) + '\n'); db.close(); })
    .catch(e => { log('FATAL:', e.message); process.exit(1); });
}
