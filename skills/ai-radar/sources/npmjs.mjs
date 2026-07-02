// sources/npmjs.mjs — npm registry watch (no auth, pure HTTP, cron-safe). Two jobs:
//   1) watchPackages: poll <registry>/<pkg>/latest (tiny JSON) — a new version becomes a new
//      item because the URL embeds the version. Catches releases before GitHub tags land.
//   2) searchQueries: the registry search API surfaces NEW packages (e.g. keywords:mcp-server),
//      filtered to the lookback window by their last-publish date.
import { openDb, loadConfig, upsertItem, upsertEntity } from '../db.mjs';

const log = (...a) => process.stderr.write('[npm] ' + a.join(' ') + '\n');

async function getJson(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'ai-radar/0.1' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(to); }
}

export async function ingestNpm(db, cfg) {
  const np = cfg.npm || {};
  if (np.enabled === false) return { scanned: 0, added: 0, skipped: 'disabled' };
  const cutoff = Date.now() - (cfg.lookbackDays || 21) * 86400000;
  let scanned = 0, added = 0;

  // 1) version bumps on watched packages
  for (const pkg of (np.watchPackages || [])) {
    const j = await getJson(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%2F', '/')}/latest`);
    if (!j?.version) { log(`skip ${pkg} (no latest)`); continue; }
    scanned++;
    const isNew = upsertItem(db, {
      source: 'npm', kind: 'release',
      title: `${pkg} ${j.version} (npm)`,
      url: `https://www.npmjs.com/package/${pkg}/v/${j.version}`,
      summary: (j.description || '').slice(0, 300),
      author: pkg.startsWith('@') ? pkg.slice(1).split('/')[0] : (j.author?.name || null),
      tags: ['npm', 'release', pkg],
    });
    if (isNew) added++;
  }

  // 2) new-package discovery via registry search
  for (const q of (np.searchQueries || [])) {
    const j = await getJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=${np.searchSize ?? 20}`);
    for (const o of (j?.objects || [])) {
      const p = o.package;
      if (!p?.name) continue;
      const t = Date.parse(p.date);
      if (Number.isFinite(t) && t < cutoff) continue; // stale package, not news
      scanned++;
      const url = p.links?.npm || `https://www.npmjs.com/package/${p.name}`;
      const isNew = upsertItem(db, {
        source: 'npm', kind: 'package', title: p.name, url,
        summary: (p.description || '').slice(0, 300),
        author: p.publisher?.username || null,
        published: p.date,
        tags: ['npm', q.replace(/^keywords:/, '')],
        raw: { version: p.version, repo: p.links?.repository },
      });
      if (isNew) added++;
      if (p.links?.repository) {
        const m = String(p.links.repository).match(/github\.com\/([\w.-]+\/[\w.-]+)/);
        if (m) upsertEntity(db, { type: 'repo', name: m[1].replace(/\.git$/, ''), url: `https://github.com/${m[1].replace(/\.git$/, '')}` });
      }
    }
  }

  log(`scanned ${scanned}, new ${added}`);
  return { scanned, added };
}

// Standalone: `node sources/npmjs.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  ingestNpm(db, loadConfig())
    .then(r => { process.stdout.write(JSON.stringify(r) + '\n'); db.close(); })
    .catch(e => { log('FATAL:', e.message); process.exit(1); });
}
