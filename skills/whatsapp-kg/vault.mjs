// vault.mjs — generate an Obsidian vault from graph.json so the knowledge graph is
// browsable in Obsidian's Graph View. One note per entity, [[wikilinks]] per edge,
// source WhatsApp messages inline, plus an index note. Idempotent: rebuilds fully.
//
//   node vault.mjs        (re)build ~/.claude/whatsapp-kg/vault/ from graph.json

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const DATA = join(homedir(), '.claude', 'whatsapp-kg')
const GRAPH = join(DATA, 'graph.json')
const VAULT = join(DATA, 'vault')
const DB = join(DATA, 'messages.db')

if (!existsSync(GRAPH)) {
  console.error('no graph.json yet — run `node extract.mjs` first.')
  process.exit(1)
}
const g = JSON.parse(readFileSync(GRAPH, 'utf8'))
mkdirSync(VAULT, { recursive: true })
for (const f of readdirSync(VAULT)) if (f.endsWith('.md')) rmSync(join(VAULT, f)) // keep .obsidian config

// One unique, link-safe filename per node (Obsidian links resolve to the filename).
const sanitize = (s) => (s || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim() || 'untitled'
const fileById = new Map()
const used = new Set()
for (const n of g.nodes) {
  let base = sanitize(n.label), name = base, i = 2
  while (used.has(name.toLowerCase())) {
    name = i === 2 ? `${base} (${n.type})` : `${base} ${i}`
    i++
  }
  used.add(name.toLowerCase())
  fileById.set(n.id, name)
}

// Source-message lookup from the raw store.
const db = existsSync(DB) ? new Database(DB, { readonly: true }) : null
const msgStmt = db ? db.prepare('SELECT ts, sender_jid, text FROM messages WHERE id = ?') : null
const shortWho = (j) => (j && j !== 'me' ? '…' + String(j).replace(/\D/g, '').slice(-5) : j || '?')
const fmtMsg = (id) => {
  if (!msgStmt) return `- \`${id}\``
  const r = msgStmt.get(id)
  if (!r) return `- \`${id}\` _(not in store)_`
  const d = r.ts ? new Date(r.ts * 1000).toISOString().slice(0, 10) : '?'
  let t = (r.text || '').replace(/\s+/g, ' ').trim()
  if (t.length > 220) t = t.slice(0, 220) + '…'
  return `- _${d}_ · ${shortWho(r.sender_jid)} — ${t}`
}

const outByNode = new Map()
for (const e of g.edges) (outByNode.get(e.src) || outByNode.set(e.src, []).get(e.src)).push(e)

const yaml = (s) => `"${(s || '').replace(/"/g, "'")}"`
let count = 0
for (const n of g.nodes) {
  const aliases = [n.id, ...(n.aliases || [])].filter(Boolean)
  const out = outByNode.get(n.id) || []
  const L = ['---', `type: ${n.type}`, `aliases: [${aliases.map(yaml).join(', ')}]`, `source_messages: ${(n.msg_ids || []).length}`, '---', '', `# ${n.label}`, '']
  if (n.summary) L.push(n.summary, '')
  if (out.length) {
    L.push('## Connections')
    for (const e of out) L.push(`- **${e.rel}** → [[${fileById.get(e.dst) || e.dst}]]${e.note ? ` — ${e.note}` : ''}`)
    L.push('')
  }
  if ((n.msg_ids || []).length) {
    L.push(`## Source messages (${n.msg_ids.length})`)
    for (const id of n.msg_ids) L.push(fmtMsg(id))
    L.push('')
  }
  writeFileSync(join(VAULT, `${fileById.get(n.id)}.md`), L.join('\n'))
  count++
}

// Index note.
const byType = {}
for (const n of g.nodes) (byType[n.type] ||= []).push(n)
const through = g.meta.built_through_ts ? new Date(g.meta.built_through_ts * 1000).toISOString().slice(0, 10) : '?'
const idx = ['---', 'type: index', '---', '', '# WhatsApp KG — index', '', `_${g.nodes.length} entities · ${g.edges.length} links · graph built through ${through}_`, '', 'Open **Graph View** (the constellation icon, left ribbon) to explore visually. Or browse by type:', '']
for (const t of Object.keys(byType).sort()) {
  idx.push(`## ${t} (${byType[t].length})`)
  for (const n of byType[t].sort((a, b) => a.label.localeCompare(b.label))) idx.push(`- [[${fileById.get(n.id)}]]`)
  idx.push('')
}
writeFileSync(join(VAULT, 'WhatsApp KG.md'), idx.join('\n'))

console.log(`vault rebuilt: ${count} entity notes + index → ${VAULT}`)
