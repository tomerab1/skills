// sources/x.mjs — the ONLY heavy source: scrape AI/agent/skill chatter from your logged-in X.
// It reuses the x-reading skill's tested scraper (Playwright + your persistent Chrome profile),
// so there's no new auth and no new Chrome profile. This launches a real browser, so it's an
// ON-DEMAND step only (run during /ai-radar) — never in the hourly pure-Node cron.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { openDb, loadConfig, upsertItem, upsertEntity } from '../db.mjs';

const exec = promisify(execFile);
const log = (...a) => process.stderr.write('[x] ' + a.join(' ') + '\n');
const SCRAPER = path.join(os.homedir(), '.claude', 'skills', 'x-reading', 'scrape-x.mjs');

async function scrapeOne(url, scrolls, max) {
  const { stdout } = await exec('node', [SCRAPER, `--url=${url}`, `--scrolls=${scrolls}`, `--max=${max}`],
    { maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
  return JSON.parse(stdout || '{}').items || [];
}

export async function ingestX(db, cfg) {
  const x = cfg.x || {};
  if (!x.enabled) return { scanned: 0, added: 0, skipped: 'disabled' };
  const mute = (x.muteWords || []).map(w => String(w).toLowerCase());
  let scanned = 0, added = 0, muted = 0;
  for (const url of (x.searchUrls || [])) {
    let items = [];
    try { items = await scrapeOne(url, x.scrolls ?? 6, x.max ?? 40); }
    catch (e) { log('scrape failed (X not logged in, or Chrome busy):', e.shortMessage || e.message); continue; }
    for (const it of items) {
      scanned++;
      const title = it.cardTitle || (it.tweetText || '').slice(0, 120) || it.url;
      // config-driven noise filter: crypto spam, listicle bait, link shorteners…
      const txt = `${title} ${it.tweetText || ''} ${it.url || ''}`.toLowerCase();
      if (mute.some(w => txt.includes(w))) { muted++; continue; }
      const isNew = upsertItem(db, {
        source: 'x', kind: 'tweet', title, url: it.url,
        summary: it.tweetText || '', author: it.handle || it.author, published: it.postedAt,
        tags: ['x', it.domain].filter(Boolean), raw: it,
      });
      if (isNew) added++;
      if (it.handle) upsertEntity(db, { type: 'person', name: it.handle, url: `https://x.com/${String(it.handle).replace(/^@/, '')}` });
    }
  }
  log(`scanned ${scanned}, new ${added}, muted ${muted}`);
  return { scanned, added, muted };
}

// Standalone: `node sources/x.mjs` — used by the /ai-radar on-demand step.
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  ingestX(db, loadConfig())
    .then(r => { process.stdout.write(JSON.stringify(r) + '\n'); db.close(); })
    .catch(e => { log('FATAL:', e.message); process.exit(1); });
}
