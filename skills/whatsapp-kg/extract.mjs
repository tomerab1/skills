// extract.mjs — incremental knowledge-graph extraction helper for whatsapp-kg.
//
// The LLM work is done THROUGH Claude Code (no SDK). This script is the deterministic
// glue around it: it hands Claude a batch of new messages + the entities already in
// the graph, and merges Claude's extracted nodes/edges back into graph.json.
//
//   node extract.mjs batch [N]   write .batch.json (next N unprocessed msgs + known entities)
//   node extract.mjs merge       fold .merge.json (Claude's nodes/edges) into graph.json
//   node extract.mjs status      watermark, remaining messages, node/edge counts
//
// Loop (done by Claude per SKILL.md):  batch -> reason -> write .merge.json -> merge -> repeat.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const DATA_DIR = join(homedir(), '.claude', 'whatsapp-kg')
const DB_PATH = join(DATA_DIR, 'messages.db')
const CONFIG = join(DATA_DIR, 'config.json')
const GRAPH = join(DATA_DIR, 'graph.json')
const STATE = join(DATA_DIR, 'state.json')
const BATCH_FILE = join(DATA_DIR, '.batch.json')
const MERGE_FILE = join(DATA_DIR, '.merge.json')

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback)
const uniq = (a) => [...new Set((a || []).filter(Boolean))]
const cfg = readJson(CONFIG, {})
if (!cfg.groupJid) {
  console.error('no target group in config.json — run the ingest setup first.')
  process.exit(1)
}

function loadGraph() {
  const g = readJson(GRAPH, null)
  if (g) return g
  return {
    meta: { group_jid: cfg.groupJid, group_name: cfg.groupName || null, built_through_ts: 0, message_count: 0, node_count: 0, edge_count: 0 },
    nodes: [],
    edges: [],
  }
}

const shortWho = (jid) => {
  if (!jid || jid === 'me') return jid || '?'
  const d = String(jid).replace(/\D/g, '')
  return d ? '…' + d.slice(-5) : '?'
}

const cmd = process.argv[2]

if (cmd === 'batch') {
  const db = new Database(DB_PATH, { readonly: true })
  const state = readJson(STATE, {})
  const last = state.last_extracted_ts || 0
  const N = Number(process.argv[3]) || 150
  const rows = db
    .prepare(`SELECT id, ts, sender_jid, kind, text FROM messages
              WHERE chat_jid=? AND ts > ? AND text != '' ORDER BY ts LIMIT ?`)
    .all(cfg.groupJid, last, N)
  const remaining = db
    .prepare(`SELECT COUNT(*) c FROM messages WHERE chat_jid=? AND ts > ? AND text != ''`)
    .get(cfg.groupJid, last).c
  const g = loadGraph()
  const batch_max_ts = rows.length ? rows[rows.length - 1].ts : last
  const out = {
    batch_max_ts, // copy this verbatim into .merge.json as processed_through_ts
    count: rows.length,
    remaining_after: Math.max(0, remaining - rows.length),
    entities: g.nodes.map((n) => ({ id: n.id, label: n.label, aliases: n.aliases || [] })),
    messages: rows.map((r) => ({
      id: r.id,
      date: new Date(r.ts * 1000).toISOString().slice(0, 16).replace('T', ' '),
      who: shortWho(r.sender_jid),
      kind: r.kind,
      text: r.text,
    })),
  }
  writeFileSync(BATCH_FILE, JSON.stringify(out, null, 2))
  console.log(
    `batch: ${rows.length} msgs → ${BATCH_FILE}  | ${out.remaining_after} remaining after | ${out.entities.length} known entities`
  )
} else if (cmd === 'merge') {
  const incoming = readJson(MERGE_FILE, null)
  if (!incoming) {
    console.error(`merge: ${MERGE_FILE} not found — write Claude's {processed_through_ts, nodes, edges} there first.`)
    process.exit(1)
  }
  const through = Number(incoming.processed_through_ts)
  if (!through) {
    console.error('merge: .merge.json needs a numeric processed_through_ts (copy batch_max_ts from .batch.json).')
    process.exit(1)
  }
  const db = new Database(DB_PATH, { readonly: true })
  const maxTs = db.prepare(`SELECT MAX(ts) m FROM messages WHERE chat_jid=?`).get(cfg.groupJid).m || 0
  if (through > maxTs) {
    console.error(`merge: processed_through_ts (${through}) is beyond the latest message (${maxTs}); refusing.`)
    process.exit(1)
  }

  const g = loadGraph()
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]))
  let addedN = 0
  for (const n of incoming.nodes || []) {
    if (!n.id) continue
    const ex = nodeById.get(n.id)
    if (ex) {
      ex.aliases = uniq([...(ex.aliases || []), ...(n.aliases || [])])
      ex.msg_ids = uniq([...(ex.msg_ids || []), ...(n.msg_ids || [])])
      if (n.summary && n.summary.length > (ex.summary || '').length) ex.summary = n.summary
    } else {
      const node = {
        id: n.id,
        type: n.type || 'topic',
        label: n.label || n.id,
        aliases: uniq(n.aliases || []),
        summary: n.summary || '',
        msg_ids: uniq(n.msg_ids || []),
      }
      g.nodes.push(node)
      nodeById.set(node.id, node)
      addedN++
    }
  }

  const ekey = (e) => `${e.src}|${e.rel}|${e.dst}`
  const edgeByKey = new Map(g.edges.map((e) => [ekey(e), e]))
  let addedE = 0
  for (const e of incoming.edges || []) {
    if (!e.src || !e.rel || !e.dst) continue
    const ex = edgeByKey.get(ekey(e))
    if (ex) {
      ex.msg_ids = uniq([...(ex.msg_ids || []), ...(e.msg_ids || [])])
      if (e.note && !ex.note) ex.note = e.note
      if (e.ts && (!ex.ts || e.ts < ex.ts)) ex.ts = e.ts
    } else {
      g.edges.push({ src: e.src, rel: e.rel, dst: e.dst, note: e.note || '', ts: e.ts || null, msg_ids: uniq(e.msg_ids || []) })
      edgeByKey.set(ekey(e), g.edges[g.edges.length - 1])
      addedE++
    }
  }

  const state = readJson(STATE, {})
  state.last_extracted_ts = Math.max(state.last_extracted_ts || 0, through)
  const processed = db
    .prepare(`SELECT COUNT(*) c FROM messages WHERE chat_jid=? AND ts <= ? AND text != ''`)
    .get(cfg.groupJid, state.last_extracted_ts).c
  g.meta.built_through_ts = state.last_extracted_ts
  g.meta.node_count = g.nodes.length
  g.meta.edge_count = g.edges.length
  g.meta.message_count = processed
  writeFileSync(GRAPH, JSON.stringify(g, null, 2))
  writeFileSync(STATE, JSON.stringify(state, null, 2))
  writeFileSync(MERGE_FILE, '{}') // clear so a stale file can't be re-applied
  console.log(
    `merged: +${addedN} nodes, +${addedE} edges (now ${g.nodes.length}/${g.edges.length}) | watermark → ${new Date(state.last_extracted_ts * 1000).toISOString().slice(0, 10)}`
  )
} else if (cmd === 'status') {
  const db = new Database(DB_PATH, { readonly: true })
  const state = readJson(STATE, {})
  const last = state.last_extracted_ts || 0
  const remaining = db
    .prepare(`SELECT COUNT(*) c FROM messages WHERE chat_jid=? AND ts > ? AND text != ''`)
    .get(cfg.groupJid, last).c
  const g = loadGraph()
  const byType = {}
  for (const n of g.nodes) byType[n.type] = (byType[n.type] || 0) + 1
  console.log(`watermark:  ${last ? new Date(last * 1000).toISOString().slice(0, 10) : '(none)'}`)
  console.log(`remaining:  ${remaining} messages to extract`)
  console.log(`nodes:      ${g.nodes.length}  ${JSON.stringify(byType)}`)
  console.log(`edges:      ${g.edges.length}`)
} else {
  console.log('usage: node extract.mjs <batch [N] | merge | status>')
  process.exit(1)
}
