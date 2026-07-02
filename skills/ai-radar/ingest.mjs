#!/usr/bin/env node
// ingest.mjs — the cheap, deterministic, LLM-free ingest. This is what the hourly pm2
// cron runs. It only touches structured sources (GitHub via gh, provider RSS/Atom feeds),
// upserts them into the local SQLite knowledge graph, and exits. No Chrome, no `claude -p`,
// tiny RAM, ~zero cost. The expensive sources (X scrape, web search) and the curation +
// pretty HTML happen on demand when you run /ai-radar in your normal session.
import { openDb, loadConfig, countsBySource } from './db.mjs';
import { ingestGitHub } from './sources/github.mjs';
import { ingestProviders } from './sources/providers.mjs';
import { ingestHackerNews } from './sources/hackernews.mjs';
import { ingestArxiv } from './sources/arxiv.mjs';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

async function main() {
  const cfg = loadConfig();
  const db = openDb();
  const t0 = Date.now();
  log(`[ingest] start ${new Date().toISOString()}`);

  const results = {};
  try { results.github = await ingestGitHub(db, cfg); }
  catch (e) { log('[ingest] github error:', e.message); results.github = { error: e.message }; }
  try { results.providers = await ingestProviders(db, cfg); }
  catch (e) { log('[ingest] providers error:', e.message); results.providers = { error: e.message }; }
  try { results.hackernews = await ingestHackerNews(db, cfg); }
  catch (e) { log('[ingest] hackernews error:', e.message); results.hackernews = { error: e.message }; }
  try { results.arxiv = await ingestArxiv(db, cfg); }
  catch (e) { log('[ingest] arxiv error:', e.message); results.arxiv = { error: e.message }; }

  const totals = countsBySource(db);
  const newCount = (results.github?.added || 0) + (results.providers?.added || 0)
    + (results.hackernews?.added || 0) + (results.arxiv?.added || 0);
  log(`[ingest] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${newCount} new item(s).`);
  log('[ingest] KG totals: ' + totals.map(r => `${r.source}=${r.n}`).join(' '));

  // stdout = a compact machine-readable summary (handy for logs / the render step).
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), newCount, results, totals }) + '\n');
  db.close();
}

main().catch((e) => { log('[ingest] FATAL:', e.stack || e.message); process.exit(1); });
