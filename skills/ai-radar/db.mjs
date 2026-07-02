// db.mjs — the ai-radar local knowledge graph, backed by Node's built-in node:sqlite.
// No native deps to compile (important on a 16GB machine), no Anthropic SDK, no `claude -p`.
//
// Tables:
//   items    — every discovered thing (repo / release / post / tweet), deduped by URL hash.
//   entities — repos / orgs / models / skills / topics, with mention counts and first/last seen.
//   edges    — relationships (mentions / released_by / depends_on) — scaffolded, enriched in-session.
//   metrics  — time-series snapshots (e.g. repo star counts) so we can compute "trending" via deltas.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const RUNTIME = path.join(os.homedir(), 'ai-radar');
export const DB_PATH = path.join(RUNTIME, 'radar.db');
export const CONFIG_PATH = path.join(RUNTIME, 'config.json');

export const nowISO = () => new Date().toISOString();
export const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
export const loadConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

export function openDb() {
  fs.mkdirSync(RUNTIME, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS items(
      id TEXT PRIMARY KEY, source TEXT, kind TEXT, title TEXT, url TEXT,
      summary TEXT, author TEXT, published TEXT,
      captured TEXT, last_seen TEXT, seen INTEGER DEFAULT 0,
      score REAL, tags TEXT, raw TEXT
    );
    CREATE TABLE IF NOT EXISTS entities(
      id TEXT PRIMARY KEY, type TEXT, name TEXT, url TEXT,
      first_seen TEXT, last_seen TEXT, mentions INTEGER DEFAULT 0, meta TEXT
    );
    CREATE TABLE IF NOT EXISTS edges(
      src TEXT, dst TEXT, rel TEXT, weight REAL DEFAULT 1, last_seen TEXT,
      PRIMARY KEY(src, dst, rel)
    );
    CREATE TABLE IF NOT EXISTS metrics(
      entity TEXT, ts TEXT, metric TEXT, value REAL
    );
    CREATE INDEX IF NOT EXISTS idx_items_captured ON items(captured);
    CREATE INDEX IF NOT EXISTS idx_items_source   ON items(source);
    CREATE INDEX IF NOT EXISTS idx_metrics_entity ON metrics(entity, metric, ts);
  `);
  return db;
}

// Insert if new; otherwise refresh title/summary + last_seen. Returns true when the item is new.
export function upsertItem(db, it) {
  const id = sha1((it.url || it.title || '').toLowerCase());
  const existing = db.prepare('SELECT id FROM items WHERE id = ?').get(id);
  const ts = nowISO();
  if (existing) {
    db.prepare('UPDATE items SET title=?, summary=?, last_seen=? WHERE id=?')
      .run(it.title ?? null, it.summary ?? null, ts, id);
    return false;
  }
  db.prepare(`INSERT INTO items
    (id, source, kind, title, url, summary, author, published, captured, last_seen, seen, score, tags, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`)
    .run(id, it.source ?? null, it.kind ?? null, it.title ?? null, it.url ?? null,
         it.summary ?? null, it.author ?? null, it.published ?? null, ts, ts,
         it.tags ? JSON.stringify(it.tags) : null,
         it.raw ? JSON.stringify(it.raw).slice(0, 4000) : null);
  return true;
}

export function upsertEntity(db, { type, name, url = null, meta = null }) {
  const id = `${type}:${String(name).toLowerCase()}`;
  const ts = nowISO();
  const row = db.prepare('SELECT id, mentions FROM entities WHERE id = ?').get(id);
  if (row) {
    db.prepare('UPDATE entities SET last_seen=?, mentions=mentions+1, url=COALESCE(?, url) WHERE id=?')
      .run(ts, url, id);
  } else {
    db.prepare('INSERT INTO entities (id, type, name, url, first_seen, last_seen, mentions, meta) VALUES (?,?,?,?,?,?,1,?)')
      .run(id, type, name, url, ts, ts, meta ? JSON.stringify(meta) : null);
  }
  return id;
}

export function addEdge(db, src, dst, rel, weight = 1) {
  const ts = nowISO();
  db.prepare(`INSERT INTO edges (src, dst, rel, weight, last_seen) VALUES (?,?,?,?,?)
              ON CONFLICT(src, dst, rel) DO UPDATE SET weight=weight+?, last_seen=?`)
    .run(src, dst, rel, weight, ts, weight, ts);
}

export function recordMetric(db, entity, metric, value) {
  if (value == null || Number.isNaN(Number(value))) return;
  db.prepare('INSERT INTO metrics (entity, ts, metric, value) VALUES (?,?,?,?)')
    .run(entity, nowISO(), metric, Number(value));
}

// ---- read helpers used by render.mjs -------------------------------------------------
export function newItemsSince(db, sinceISO, limit = 200) {
  return db.prepare('SELECT * FROM items WHERE captured >= ? ORDER BY captured DESC LIMIT ?')
    .all(sinceISO, limit);
}
export function recentItems(db, days = 21, limit = 400) {
  // Anchor recency on capture (discovery) time, not publish time: a repo we just found may
  // have been created years ago, but it's "new to the radar". Order newest-discovered first,
  // tie-broken by publish date so fresh news floats above older-but-just-discovered repos.
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare("SELECT * FROM items WHERE captured >= ? ORDER BY captured DESC, COALESCE(published,'') DESC LIMIT ?")
    .all(since, limit);
}
export function countsBySource(db) {
  return db.prepare('SELECT source, COUNT(*) n FROM items GROUP BY source ORDER BY n DESC').all();
}

// Trending repos: biggest star delta across snapshots within `days`, needing >=2 data points.
export function trendingRepos(db, days = 14, limit = 12) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.prepare(`
    SELECT entity,
           MAX(value) - MIN(value) AS delta,
           MAX(value) AS latest,
           COUNT(*) AS points
    FROM metrics WHERE metric='stars' AND ts >= ?
    GROUP BY entity HAVING points >= 2 AND delta > 0
    ORDER BY delta DESC LIMIT ?`).all(since, limit);
  return rows.map(r => {
    const ent = db.prepare("SELECT url FROM entities WHERE id = ?").get(`repo:${r.entity.toLowerCase()}`);
    return { name: r.entity, delta: Math.round(r.delta), latest: Math.round(r.latest), url: ent?.url || `https://github.com/${r.entity}` };
  });
}

export function markSeen(db, ids) {
  const stmt = db.prepare('UPDATE items SET seen=1 WHERE id=?');
  for (const id of ids) stmt.run(id);
}
