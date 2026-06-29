---
name: whatsapp-kg
description: Archive ONE WhatsApp group into a local store and distill it into a queryable knowledge graph, so its knowledge stays available months/years later. Ingestion is Baileys (always-on under pm2); the graph is extracted and queried through Claude Code itself — no Anthropic SDK. Use when the user wants to capture a group's history and later ask "what did we figure out about X?".
---

# WhatsApp group → knowledge graph

Capture one (archived) WhatsApp group and turn it into a **local, source-anchored
knowledge graph** you can ask in plain language a year from now. Three parts:

1. **Ingest** — `ingest.mjs` (Baileys) mirrors the group into `messages.db`. Pure
   Node, always-on under pm2. Runs once for the backlog, then keeps live messages.
2. **Extract** — a scheduled **headless `claude` run** (like the `*-todos` skills)
   reads *new* messages and folds them into `graph.json`. The LLM work is Claude
   Code, **not** an SDK call.
3. **Ask** — `/whatsapp-kg "<question>"` answers from `graph.json` + the supporting
   messages in `messages.db`, with citations (who said it, when).

**No Anthropic SDK anywhere.** Ingestion needs no LLM; extraction and Q&A are done
by Claude under Claude Code.

## Where things live (under `~/.claude/whatsapp-kg/`)

| path | what |
|---|---|
| `auth/` | Baileys paired-device credentials (one QR scan, persisted) |
| `config.json` | `{ "groupJid": "...", "groupName": "..." }` — the one target group |
| `messages.db` | raw messages, deduped (SQLite) — see schema below |
| `graph.json` | the knowledge graph (nodes + edges), built by **Extract** |
| `state.json` | `{ "last_extracted_ts": <unix> }` — extraction watermark |

`messages.db` schema (table `messages`): `id` (pk / dedup key), `chat_jid`,
`sender_jid`, `sender_name`, `ts` (unix seconds), `kind`
(`text`/`image`/`voice`/…), `text` (body or caption), `quoted_id`, `raw` (full
message json, kept for phase-2 media). Query it with the `sqlite3` CLI.

---

## Invoking this skill

- `/whatsapp-kg extract` → run **Part 2**: loop `batch` → reason → `merge` to grow the
  graph from new messages. Cap a scheduled run at ~10 batches, then exit (it resumes next
  fire). This is what the pm2 cron calls.
- `/whatsapp-kg "<question>"` → run **Part 3**: answer from the graph, cited.
- bare `/whatsapp-kg` → report `node extract.mjs status` + `node ingest.mjs stats`.

## Part 1 — Ingest (Baileys)

First-time setup, from this skill's directory:

```bash
npm install                                  # once
node ingest.mjs login                        # scan the QR with your phone, then Ctrl-C
node ingest.mjs groups                        # lists your groups: <jid> | members | name
node ingest.mjs set "<jid-of-the-group>"      # picks the target (writes config.json)
node ingest.mjs start                         # captures backlog + live → messages.db
node ingest.mjs stats                         # message count + date range captured
```

`start` is **always-on** (a persistent socket). Run it under pm2 so it survives
reboots and reconnects:

```bash
pm2 start ingest.mjs --name whatsapp-kg-ingest --interpreter node -- start
pm2 save
```

- **Read-only.** The skill never sends messages; `markOnlineOnConnect:false` keeps
  you invisible. Lowest-risk way to run an unofficial client on your own group.
- **Backlog caveat.** `syncFullHistory:true` + a desktop browser signature pull as
  much history as WhatsApp will hand over on link — but it can still be a partial
  window, not the full multi-year backlog. After the first `start`, check `stats`.
  If the earliest date is thinner than expected, seed history once via WhatsApp's
  **Export chat** (`.txt`) and import it (a small loader can be added), then let
  Baileys carry the live stream from there.
- `login`/`groups` will show a QR if not yet paired, so `groups` alone is enough to
  pair the first time.
- **Pairing code instead of QR:** `node ingest.mjs login <phone>` (international
  digits only, e.g. Israel `9725XXXXXXXX` — country code, no leading 0, no `+`)
  prints an 8-char code to enter via WhatsApp → *Link with phone number instead*.
  Use this if the QR fails with "check your connection".
- **Version pinning.** The socket advertises the **live** WhatsApp-Web version
  (`fetchLatestWaWebVersion`), not Baileys' baked-in one — the baked-in version on
  an RC build lags and causes "couldn't link device / check your connection". If
  linking ever starts failing again, that stale version is the first thing to check.

## Part 2 — Extract (incremental, through Claude Code)

Goal: fold **only the new messages** into `graph.json`, with entity resolution, so
the graph grows without reprocessing everything. Run by a scheduled headless
`claude` (see "Scheduling"), or on demand by invoking this skill.

Fold **only new messages** into `graph.json` via the `extract.mjs` helper: Claude does
the reasoning, the script does the file mutation (entity resolution by id, dedup,
watermark). The loop (run by Claude — `/whatsapp-kg extract`, or the scheduled headless
`claude`):

1. `node extract.mjs batch` → writes `~/.claude/whatsapp-kg/.batch.json`
   (`{ batch_max_ts, count, remaining_after, entities[], messages[] }`). **Read that file.**
   `entities` is everything already in the graph (`id`, `label`, `aliases`) — resolve against it.
2. From `messages`, extract **nodes** and **edges**:
   - **node types** (a guide — this group is IDF EVO-Max drone ops): `equipment`
     (drone / controller / prop / battery models), `software` (app + firmware versions),
     `system` (e.g. מערכת שור), `issue` (a fault / failure mode), `procedure` (a how-to /
     SOP / fix), `resource` (a shared file, link, or contact list), `org` (unit / body —
     חט"ל, תשלס, מב"א, a lab), `person` (rarely — senders show as anonymous `…12345`
     ids; only when an edge needs an actor), `topic`.
   - node: `{ id, type, label, aliases[], summary, msg_ids[] }`; `id` = `type:slug`
     (e.g. `software:evo-pilot-6-1-2`, `issue:spoof-on-landing`).
   - edge: `{ src, rel, dst, note, ts, msg_ids[] }` — e.g.
     `software:idf-sv2-3 —fixes→ issue:spoof-on-landing`.
   - **Always attach `msg_ids`** (the `id` of each supporting message) to every node and
     edge — that is what makes answers citable.
   - **Entity resolution:** reuse an existing `entities[].id` when it's the same thing
     (Hebrew *and* transliteration — "איבו" == "EVO Max"; "ד״ר כהן" == "Dr. Cohen").
     Reusing the id makes `merge` extend that node instead of duplicating it.
   - Skip chatter / greetings. Capture knowledge: fixes, decisions, version releases,
     recalls, shared resources, who-to-contact, recurring failure modes.
3. Write `~/.claude/whatsapp-kg/.merge.json` =
   `{ "processed_through_ts": <batch_max_ts, copied verbatim>, "nodes": [...], "edges": [...] }`,
   then `node extract.mjs merge`. The watermark advances to `processed_through_ts` even when a
   batch yields no nodes, so noise isn't reprocessed.
4. Repeat until `batch` reports `remaining_after: 0`. `node extract.mjs status` shows the
   watermark, remaining count, and node/edge tallies. A scheduled run should cap itself
   (~10 batches) and resume next time.
5. After the batches, run `node vault.mjs` to refresh the Obsidian vault at
   `~/.claude/whatsapp-kg/vault/` (one note per entity, `[[wikilinks]]` per edge, source
   messages inline) so the visual Graph View stays current.

`graph.json` shape:
```json
{
  "meta": { "group_jid": "...", "group_name": "...", "built_through_ts": 0, "message_count": 0, "node_count": 0, "edge_count": 0 },
  "nodes": [ { "id": "software:idf-sv2-3", "type": "software", "label": "Firmware IDF-SV2.3",
               "aliases": ["SV2.3"], "summary": "firmware fixing landing altitude immunity (spoofing on landing); released 2026-04-09",
               "msg_ids": ["3AF1..."] } ],
  "edges": [ { "src": "software:idf-sv2-3", "rel": "fixes", "dst": "issue:spoof-on-landing",
               "note": "altitude immunity in landing", "ts": 1712690000, "msg_ids": ["3AF1..."] } ]
}
```

## Part 3 — Ask (`/whatsapp-kg "<question>"`)

1. Load `graph.json`. Find nodes/edges relevant to the question by matching
   `label`/`aliases`/`summary` and `rel`, then expand to their neighbours.
2. For recall beyond the graph, keyword-search the raw text:
   ```bash
   sqlite3 -json ~/.claude/whatsapp-kg/messages.db \
     "SELECT ts, sender_name, text FROM messages
      WHERE chat_jid='<groupJid>' AND text LIKE '%<term>%' ORDER BY ts;"
   ```
3. Pull the supporting messages for the chosen nodes/edges by their `msg_ids`.
4. **Answer concisely and cite** every claim as `— <sender>, <YYYY-MM-DD>`.
   When sources disagree, say so and cite both. Don't assert specifics that aren't
   in the messages.

## Scheduling (pm2, mirrors the `*-todos` setup)

Two registered jobs. The extract job uses a bash wrapper that exports nvm's PATH (the
pm2 daemon doesn't inherit it), exactly like `~/.claude/dm-todos-loop.sh`.

- **Ingest** — always-on Baileys daemon (autorestart):
  ```bash
  pm2 start ~/.claude/skills/whatsapp-kg/ingest.mjs --name whatsapp-kg-ingest \
    --interpreter /Users/tomerab/.nvm/versions/node/v22.18.0/bin/node -- start
  ```
- **Extract** — headless `claude` on a cron via `~/.claude/whatsapp-kg-extract-loop.sh`:
  ```bash
  pm2 start ~/.claude/whatsapp-kg-extract-loop.sh --name whatsapp-kg-extract \
    --interpreter bash --no-autorestart --cron "0 11,17 * * 0-4"
  ```
  Force an immediate run with `pm2 restart whatsapp-kg-extract`.
- **Persist:** `pm2 save`. ⚠️ `pm2 save` overwrites `~/.pm2/dump.pm2` with only the
  *running* processes — it will drop saved-but-stopped jobs like the `*-todos`. Back up
  the dump first and re-merge their entries (this skill's setup did exactly that).

## Notes & limits

- **Hebrew first.** The group is likely Hebrew; extract in the source language but
  keep `aliases` for transliterations so entity resolution and Q&A work both ways.
- **Privacy.** Everything is local. The only data that reaches Anthropic is what
  passes through Claude Code during extract/ask — the same trust boundary as the
  rest of your skills. Other people's messages never leave the machine otherwise.
- **One group by design.** `config.json` holds a single `groupJid`; ingestion
  filters to it so the store stays focused.
- **Media is phase 2.** Text + captions are captured now; voice-note transcription
  and image/doc understanding can be added later off the `raw` column.
