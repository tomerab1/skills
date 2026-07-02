// db.mjs — the ai-radar local knowledge graph, backed by Node's built-in node:sqlite.
// No native deps to compile (important on a 16GB machine), no Anthropic SDK, no `claude -p`.
//
// Tables:
//   items    — every discovered thing (repo / release / post / tweet), deduped by normalized-URL hash.
//   entities — repos / orgs / models / skills / topics, with mention counts and first/last seen.
//   edges    — relationships (mentions / released_by) — extracted deterministically at ingest.
//   metrics  — time-series snapshots (repo stars/forks, HN points) → "trending"/"rising" via deltas.
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

// Canonicalize a URL for identity/dedup: same story shared via HN, a feed, and X should
// hash to one id. Strips tracking params + fragments (#atom-everything…), normalizes
// protocol/host, drops trailing slashes, and sorts the surviving query params.
const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|igshid|mc_cid|mc_eid|ref_src|ref_url|cmpid|linkid|ck_subscriber_id|share_id|rdt)$/i;
export function normalizeUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(String(u).trim());
    url.protocol = 'https:';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    const keep = [...url.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    url.search = new URLSearchParams(keep).toString();
    return url.toString().replace(/\/+$/, '');
  } catch { return String(u).trim(); }
}

// The one true item id. Everything that needs to reference an item by URL (metrics,
// mark-seen, dedup) must go through this so identities line up.
export const itemIdFor = (urlOrTitle) => sha1(normalizeUrl(urlOrTitle).toLowerCase());

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
  migrate(db);
  return db;
}

// One-time, idempotent migrations keyed off PRAGMA user_version.
// v2: item ids move from sha1(lowercased raw url) to sha1(normalized url) — recompute
// every id and merge rows that now collide (same story ingested with tracking params).
// v3: items.also column — when a second SOURCE discovers the same URL (HN thread about a
// blog post, reddit thread about a repo…), we record {source, url, note} there instead of
// losing it to dedup. Render shows these as extra badges on the one card.
function migrate(db) {
  const { user_version } = db.prepare('PRAGMA user_version').get();
  if (user_version >= 3) return;
  if (user_version < 3 && user_version >= 2) {
    try { db.exec('ALTER TABLE items ADD COLUMN also TEXT'); } catch { /* already there */ }
    db.exec('PRAGMA user_version = 3');
    return;
  }
  const rows = db.prepare('SELECT id, url, title, captured FROM items').all();
  const upd = db.prepare('UPDATE items SET id=? WHERE id=?');
  const del = db.prepare('DELETE FROM items WHERE id=?');
  let renamed = 0, merged = 0;
  for (const r of rows) {
    const nid = itemIdFor(r.url || r.title || '');
    if (nid === r.id) continue;
    const clash = db.prepare('SELECT id, captured FROM items WHERE id=?').get(nid);
    if (clash) {
      // Keep the earliest-captured row as canonical; fold the other away.
      if (String(r.captured) >= String(clash.captured)) del.run(r.id);
      else { del.run(nid); upd.run(nid, r.id); }
      merged++;
    } else {
      upd.run(nid, r.id);
      renamed++;
    }
  }
  try { db.exec('ALTER TABLE items ADD COLUMN also TEXT'); } catch { /* already there */ }
  db.exec('PRAGMA user_version = 3');
  if (renamed || merged) process.stderr.write(`[db] id migration: ${renamed} renamed, ${merged} merged\n`);
}

// Insert if new; otherwise refresh title + last_seen, keep the RICHEST summary (so a
// changelog body can enrich an empty GitHub release, and a later empty scan can't
// clobber it back), and backfill published if we finally learned it.
//
// Cross-source hits: when a DIFFERENT source rediscovers the same normalized URL (HN thread
// about a blog post we already have), we keep the original card but append the discoverer to
// `also` — optionally with it.discussion = {url, note} pointing at the thread.
// Returns true when the item is new.
export function upsertItem(db, it) {
  const id = itemIdFor(it.url || it.title || '');
  const existing = db.prepare('SELECT id, source, also FROM items WHERE id = ?').get(id);
  const ts = nowISO();
  if (existing) {
    db.prepare(`UPDATE items SET
        title = ?,
        summary = CASE WHEN length(COALESCE(?, '')) > length(COALESCE(summary, '')) THEN ? ELSE summary END,
        published = COALESCE(published, ?),
        last_seen = ?
      WHERE id = ?`)
      .run(it.title ?? null, it.summary ?? null, it.summary ?? null, it.published ?? null, ts, id);
    if (it.source && it.source !== existing.source) {
      let also = [];
      try { also = JSON.parse(existing.also || '[]'); } catch { /* reset */ }
      if (!also.some(a => a.source === it.source)) {
        also.push({ source: it.source, url: it.discussion?.url || null, note: it.discussion?.note || null });
        db.prepare('UPDATE items SET also=? WHERE id=?').run(JSON.stringify(also).slice(0, 2000), id);
      }
    }
    return false;
  }
  db.prepare(`INSERT INTO items
    (id, source, kind, title, url, summary, author, published, captured, last_seen, seen, score, tags, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`)
    .run(id, it.source ?? null, it.kind ?? null, it.title ?? null, it.url ?? null,
         it.summary ?? null, it.author ?? null, it.published ?? null, ts, ts,
         it.tags ? JSON.stringify(it.tags) : null,
         it.raw ? JSON.stringify(it.raw).slice(0, 4000) : null);
  extractEdges(db, id, `${it.title || ''} ${it.summary || ''}`);
  return true;
}

// ---- deterministic edge extraction (no LLM) ------------------------------------------
// Wires new items into the graph: mentioned GitHub repos and model families become
// entities with item->entity 'mentions' edges. Cheap regexes, best-effort only.
const STOP_OWNERS = new Set(['search', 'features', 'topics', 'orgs', 'sponsors', 'marketplace',
  'apps', 'about', 'blog', 'collections', 'trending', 'settings', 'login', 'signup', 'site',
  'contact', 'pricing', 'enterprise', 'readme', 'explore']);
const MODEL_NAMES = ['claude', 'sonnet', 'opus', 'haiku', 'fable', 'mythos', 'gpt-5', 'gpt-4',
  'gemini', 'gemma', 'glm', 'qwen', 'llama', 'mistral', 'deepseek', 'phi-4', 'kimi', 'grok', 'minimax'];
export function extractEdges(db, itemId, text) {
  if (!text) return;
  try {
    const seenRepos = new Set();
    for (const m of text.matchAll(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)) {
      const owner = m[1];
      const repo = m[2].replace(/\.git$/, '').replace(/[.,)\]'"]+$/, '');
      const full = `${owner}/${repo}`;
      if (!repo || STOP_OWNERS.has(owner.toLowerCase()) || seenRepos.has(full)) continue;
      seenRepos.add(full);
      const ent = upsertEntity(db, { type: 'repo', name: full, url: `https://github.com/${full}` });
      addEdge(db, `item:${itemId}`, ent, 'mentions');
    }
    const lc = ` ${text.toLowerCase()} `;
    for (const name of MODEL_NAMES) {
      if (new RegExp(`[^a-z0-9]${name.replace(/-/g, '\\-')}[^a-z0-9]`).test(lc)) {
        const ent = upsertEntity(db, { type: 'model', name });
        addEdge(db, `item:${itemId}`, ent, 'mentions');
      }
    }
  } catch { /* edges are best-effort — never fail an ingest over them */ }
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

// Star-count history for one repo (for sparklines on trending cards).
export function starSeries(db, name, days = 14) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare("SELECT ts, value FROM metrics WHERE entity=? AND metric='stars' AND ts>=? ORDER BY ts")
    .all(name, since);
}

// Rising HN stories: biggest point gains across scans (metric entity = item id).
export function risingStories(db, days = 3, limit = 8) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.prepare(`
    SELECT entity, MAX(value)-MIN(value) AS delta, MAX(value) AS latest, COUNT(*) AS n
    FROM metrics WHERE metric='hn_points' AND ts >= ?
    GROUP BY entity HAVING n >= 2 AND delta >= 20
    ORDER BY delta DESC LIMIT ?`).all(since, limit);
  return rows.map(r => {
    const it = db.prepare('SELECT title, url FROM items WHERE id=?').get(r.entity);
    return it ? { title: it.title, url: it.url, delta: Math.round(r.delta), latest: Math.round(r.latest) } : null;
  }).filter(Boolean);
}

export function markSeen(db, ids) {
  const stmt = db.prepare('UPDATE items SET seen=1 WHERE id=?');
  for (const id of ids) stmt.run(id);
}

// Close the curation loop: items featured in a curated report get seen=1 and a score bump,
// so the next /ai-radar run can prefer genuinely-unseen material. Returns rows touched.
export function markSeenByUrls(db, urls) {
  const stmt = db.prepare('UPDATE items SET seen=1, score=COALESCE(score,0)+1 WHERE id=?');
  let n = 0;
  for (const u of urls) {
    if (!u) continue;
    n += stmt.run(itemIdFor(u)).changes;
  }
  return n;
}
