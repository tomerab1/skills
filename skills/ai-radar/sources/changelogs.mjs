// sources/changelogs.mjs — parse raw CHANGELOG.md files (e.g. anthropics/claude-code) into
// release items. Deliberately targets the SAME URL as the GitHub release for each version, so
// upsertItem enriches the existing (often body-less) release item with real notes instead of
// creating a duplicate card. Replaces the dead anthropic.com RSS feed. Pure HTTP, cron-safe.
import { openDb, loadConfig, upsertItem } from '../db.mjs';

const log = (...a) => process.stderr.write('[changelogs] ' + a.join(' ') + '\n');

async function fetchText(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'ai-radar/0.1' } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; } finally { clearTimeout(to); }
}

// Split on "## <heading>" sections; each heading that contains a semver-ish version becomes one entry.
function parseChangelog(md, max) {
  const out = [];
  const parts = String(md).split(/^##\s+/m).slice(1); // drop preamble
  for (const part of parts) {
    if (out.length >= max) break;
    const nl = part.indexOf('\n');
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = (nl === -1 ? '' : part.slice(nl + 1)).trim();
    const ver = heading.match(/(\d+\.\d+\.\d+(?:[-.][\w.]+)?)/);
    if (!ver) continue;
    out.push({ version: ver[1], body: body.slice(0, 900) });
  }
  return out;
}

export async function ingestChangelogs(db, cfg) {
  let scanned = 0, added = 0;
  for (const c of (cfg.changelogs || [])) {
    // c = { repo: 'anthropics/claude-code', url: '<raw CHANGELOG.md>', tagPrefix: 'v', max: 6 }
    const md = await fetchText(c.url);
    if (!md) { log(`skip ${c.repo} (fetch failed)`); continue; }
    for (const e of parseChangelog(md, c.max ?? 6)) {
      scanned++;
      const tag = `${c.tagPrefix ?? 'v'}${e.version}`;
      const isNew = upsertItem(db, {
        source: 'github', kind: 'release',
        title: `${c.repo} ${tag}`,
        // Same URL as the gh-releases scan → enriches that item rather than duplicating it.
        url: `https://github.com/${c.repo}/releases/tag/${tag}`,
        summary: e.body, author: c.repo.split('/')[0],
        tags: ['release', c.repo, 'changelog'],
      });
      if (isNew) added++;
    }
  }
  log(`scanned ${scanned}, new ${added}`);
  return { scanned, added };
}

// Standalone: `node sources/changelogs.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  ingestChangelogs(db, loadConfig())
    .then(r => { process.stdout.write(JSON.stringify(r) + '\n'); db.close(); })
    .catch(e => { log('FATAL:', e.message); process.exit(1); });
}
