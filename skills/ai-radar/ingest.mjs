#!/usr/bin/env node
// ingest.mjs — the cheap, deterministic, LLM-free ingest. This is what the hourly pm2
// cron runs. It only touches structured sources (GitHub via gh, RSS/Atom feeds, public
// JSON APIs: HN, Lobsters, Reddit RSS, HF hub, npm registry, raw changelogs), upserts them
// into the local SQLite knowledge graph, and exits. No Chrome, no `claude -p`, tiny RAM,
// ~zero cost. The expensive sources (X scrape, web search) and the curation + pretty HTML
// happen on demand when you run /ai-radar in your normal session.
import { openDb, loadConfig, countsBySource } from './db.mjs';
import { ingestGitHub } from './sources/github.mjs';
import { ingestProviders } from './sources/providers.mjs';
import { ingestHackerNews } from './sources/hackernews.mjs';
import { ingestArxiv } from './sources/arxiv.mjs';
import { ingestLobsters } from './sources/lobsters.mjs';
import { ingestReddit } from './sources/reddit.mjs';
import { ingestHuggingFace } from './sources/huggingface.mjs';
import { ingestNpm } from './sources/npmjs.mjs';
import { ingestChangelogs } from './sources/changelogs.mjs';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const SOURCES = [
  ['github',      ingestGitHub],
  ['changelogs',  ingestChangelogs],   // after github so release items exist to enrich
  ['providers',   ingestProviders],
  ['hackernews',  ingestHackerNews],
  ['lobsters',    ingestLobsters],
  ['reddit',      ingestReddit],
  ['huggingface', ingestHuggingFace],
  ['npm',         ingestNpm],
  ['arxiv',       ingestArxiv],
];

async function main() {
  const cfg = loadConfig();
  const db = openDb();
  const t0 = Date.now();
  log(`[ingest] start ${new Date().toISOString()}`);

  const results = {};
  for (const [name, fn] of SOURCES) {
    try { results[name] = await fn(db, cfg); }
    catch (e) { log(`[ingest] ${name} error:`, e.message); results[name] = { error: e.message }; }
  }

  const totals = countsBySource(db);
  const newCount = Object.values(results).reduce((n, r) => n + (r?.added || 0), 0);
  log(`[ingest] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${newCount} new item(s).`);
  log('[ingest] KG totals: ' + totals.map(r => `${r.source}=${r.n}`).join(' '));

  // stdout = a compact machine-readable summary (handy for logs / the render step).
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), newCount, results, totals }) + '\n');
  db.close();
}

main().catch((e) => { log('[ingest] FATAL:', e.stack || e.message); process.exit(1); });
