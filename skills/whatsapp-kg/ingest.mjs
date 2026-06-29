// ingest.mjs — archive ONE WhatsApp group into a local SQLite store via Baileys.
// No Anthropic SDK here; this half is pure ingestion. The graph/Q&A work happens
// through Claude Code (see SKILL.md).
//
// Subcommands:
//   node ingest.mjs login          pair this machine (scan QR), persist auth
//   node ingest.mjs groups         list the groups you're in, so you can pick one
//   node ingest.mjs set "<jid>"    record the target group jid in config.json
//   node ingest.mjs start          connect & capture backlog + live into messages.db (run under pm2)
//   node ingest.mjs stats          row count + date range for the target group
//
// State lives under ~/.claude/whatsapp-kg/ (auth/, config.json, messages.db),
// mirroring how hike-research stores its cache + graph.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  Browsers,
} from 'baileys'
import qrcode from 'qrcode-terminal'
import Database from 'better-sqlite3'
import P from 'pino'

const DATA_DIR = join(homedir(), '.claude', 'whatsapp-kg')
const AUTH_DIR = join(DATA_DIR, 'auth')
const DB_PATH = join(DATA_DIR, 'messages.db')
const CFG_PATH = join(DATA_DIR, 'config.json')
mkdirSync(AUTH_DIR, { recursive: true })

const cfg = existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, 'utf8')) : {}
const saveCfg = () => writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n')

// ---------- store ----------
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,   -- WhatsApp message id (dedup key)
    chat_jid    TEXT NOT NULL,
    sender_jid  TEXT,
    sender_name TEXT,               -- pushName at time of send
    ts          INTEGER,            -- unix seconds
    kind        TEXT,               -- text | image | video | voice | document | ...
    text        TEXT,               -- body or media caption ('' for non-text)
    quoted_id   TEXT,               -- id of the message this replies to, if any
    raw         TEXT                -- full message json (for phase-2 media work)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_ts   ON messages(ts);
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid);
`)
const insert = db.prepare(`
  INSERT OR IGNORE INTO messages
    (id, chat_jid, sender_jid, sender_name, ts, kind, text, quoted_id, raw)
  VALUES (@id, @chat_jid, @sender_jid, @sender_name, @ts, @kind, @text, @quoted_id, @raw)
`)

const safeJson = (o) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

const toTs = (t) =>
  typeof t === 'number' ? t : t?.toNumber ? t.toNumber() : Number(t) || null

function extractText(msg) {
  const m = msg.message
  if (!m) return { kind: 'empty', text: '' }
  if (m.conversation) return { kind: 'text', text: m.conversation }
  if (m.extendedTextMessage?.text) return { kind: 'text', text: m.extendedTextMessage.text }
  if (m.imageMessage) return { kind: 'image', text: m.imageMessage.caption || '' }
  if (m.videoMessage) return { kind: 'video', text: m.videoMessage.caption || '' }
  if (m.documentMessage)
    return { kind: 'document', text: m.documentMessage.caption || m.documentMessage.fileName || '' }
  if (m.audioMessage) return { kind: m.audioMessage.ptt ? 'voice' : 'audio', text: '' }
  if (m.stickerMessage) return { kind: 'sticker', text: '' }
  return { kind: Object.keys(m)[0] || 'other', text: '' }
}

// Returns the number of NEW rows actually inserted (dupes are ignored).
function store(messages, chatJid) {
  let n = 0
  const tx = db.transaction((arr) => {
    for (const msg of arr) {
      const jid = msg.key?.remoteJid
      if (!jid || jid !== chatJid) continue
      const { kind, text } = extractText(msg)
      const info = insert.run({
        id: msg.key.id,
        chat_jid: jid,
        sender_jid: msg.key.participant || msg.participant || (msg.key.fromMe ? 'me' : jid),
        sender_name: msg.pushName || null,
        ts: toTs(msg.messageTimestamp),
        kind,
        text,
        quoted_id: msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null,
        raw: safeJson(msg),
      })
      n += info.changes
    }
  })
  tx(messages)
  return n
}

// ---------- connection ----------
// Prefer the LIVE WhatsApp-Web version; Baileys' baked-in one lags behind and is
// the usual cause of "couldn't link device / check your connection" on an RC build.
async function getVersion() {
  try {
    return (await fetchLatestWaWebVersion({})).version
  } catch {
    return (await fetchLatestBaileysVersion()).version
  }
}

async function connect({ onReady, pairPhone } = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const version = await getVersion()
  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: process.env.WA_LOG || 'silent' }),
    browser: Browsers.macOS('Desktop'), // desktop signature → fuller history sync
    syncFullHistory: true, // ask WhatsApp for as much backlog as it will give
    markOnlineOnConnect: false, // stay invisible; we only read
  })

  sock.ev.on('creds.update', saveCreds)

  // Backlog: WhatsApp pushes history in batches after login.
  sock.ev.on('messaging-history.set', ({ messages, progress, syncType }) => {
    if (!cfg.groupJid) return
    const n = store(messages || [], cfg.groupJid)
    if (n) console.log(`history +${n}  (progress ${progress ?? '?'}%, type ${syncType ?? '?'})`)
  })

  // Live: new (and back-filled) messages as they arrive.
  sock.ev.on('messages.upsert', ({ messages }) => {
    if (!cfg.groupJid) return
    const n = store(messages || [], cfg.groupJid)
    if (n) console.log(`live +${n}`)
  })

  let pairRequested = false
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) {
      if (pairPhone && !pairRequested) {
        // Pairing-code path: request once, the user types the code into WhatsApp.
        pairRequested = true
        try {
          const code = await sock.requestPairingCode(pairPhone)
          console.log(`\n  Pairing code:  ${code}\n`)
          console.log('WhatsApp → Settings → Linked devices → Link a device →')
          console.log('"Link with phone number instead", then enter the code above.\n')
        } catch (e) {
          console.error('pairing-code request failed:', e?.message || e)
        }
      } else if (!pairPhone) {
        console.log('\nWhatsApp → Settings → Linked devices → Link a device, then scan:\n')
        qrcode.generate(qr, { small: true })
      }
    }
    if (connection === 'open') {
      console.log('connected.')
      onReady?.(sock)
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const reason = Object.entries(DisconnectReason).find(([, v]) => v === code)?.[0] || 'unknown'
      if (code === DisconnectReason.loggedOut) {
        console.log('logged out — delete ~/.claude/whatsapp-kg/auth and run `login` again.')
        process.exit(1)
      }
      // Reconnect after a short delay so rapid closes can't tight-loop / self-replace.
      console.log(`connection closed (${code} ${reason}) — reconnecting in 3s…`)
      setTimeout(() => connect({ onReady, pairPhone }), 3000)
    }
  })

  return sock
}

// ---------- commands ----------
const cmd = process.argv[2]

if (cmd === 'login') {
  // Optional phone number → pairing-code login instead of QR.
  // International format, digits only (Israel: 972 + number without the leading 0).
  const phone = (process.argv[3] || '').replace(/[^0-9]/g, '')
  if (phone) console.log('pairing via phone code for', phone)
  await connect({
    pairPhone: phone || undefined,
    onReady: () => console.log('paired ✓  next:  node ingest.mjs groups   (then leave with Ctrl-C)'),
  })
} else if (cmd === 'groups') {
  await connect({
    onReady: async (sock) => {
      try {
        const groups = await sock.groupFetchAllParticipating()
        const rows = Object.values(groups)
          .map((g) => ({ jid: g.id, name: g.subject, size: g.participants?.length }))
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        console.log(`\n${rows.length} groups:\n`)
        for (const r of rows) console.log(`  ${r.jid}   ${String(r.size ?? '?').padStart(3)} members   ${r.name}`)
        console.log('\nthen:  node ingest.mjs set "<jid>"')
      } catch (e) {
        console.error('failed to list groups:', e?.message || e)
      }
      process.exit(0)
    },
  })
} else if (cmd === 'set') {
  const jid = process.argv[3]
  if (!jid) {
    console.error('usage: node ingest.mjs set "<group-jid>"')
    process.exit(1)
  }
  cfg.groupJid = jid
  saveCfg()
  console.log('target group set:', jid)
  process.exit(0)
} else if (cmd === 'start') {
  if (!cfg.groupJid) {
    console.error('no target group yet — run `groups` then `set` first.')
    process.exit(1)
  }
  console.log('capturing', cfg.groupJid, '— Ctrl-C to stop (or run under pm2).')
  await connect({})
} else if (cmd === 'stats') {
  const row = db
    .prepare(`SELECT COUNT(*) c, MIN(ts) mn, MAX(ts) mx FROM messages WHERE chat_jid = ?`)
    .get(cfg.groupJid || '')
  const d = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '—')
  console.log(`group:    ${cfg.groupJid || '(none set)'}`)
  console.log(`messages: ${row.c}`)
  console.log(`range:    ${d(row.mn)} → ${d(row.mx)}`)
  process.exit(0)
} else {
  console.log('usage: node ingest.mjs <login | groups | set "<jid>" | start | stats>')
  process.exit(1)
}
