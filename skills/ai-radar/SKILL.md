---
name: ai-radar
description: "Discover the latest in the AI ecosystem — new models & provider releases, Claude Code skills/plugins/subagents, agent frameworks & MCP, and devtools/best-practices — by scanning GitHub, provider changelogs, the web, and your logged-in X, then rendering a polished, navigable HTML dashboard. Backed by a local SQLite knowledge graph that an hourly pure-Node cron keeps fresh. Use when you want to catch up on what's new/trending or find new skills/agents/tools worth adopting."
---

# ai-radar

A personal radar for the AI dev ecosystem. Cheap, deterministic ingestion runs hourly into a
local **knowledge graph**; the rich, ranked **HTML dashboard** is produced on demand.

## Cost & resource rules (important)
- **No `claude -p`, no Anthropic SDK, no metered calls anywhere in the automated path.** The hourly
  cron is pure Node (GitHub via `gh` + RSS feeds). The only LLM step is the *in-session* curation
  below — i.e. you, the model already in this Claude Code session — which is just normal usage.
- The only heavyweight step is the **X scrape** (launches headless Chrome via the reused
  `~/.x-reading` profile). It's **on-demand only**, never in the cron. Skip it on request.

## Files
- Skill: `~/.claude/skills/ai-radar/` — `ingest.mjs`, `render.mjs`, `db.mjs`, `shot.mjs`, `sources/{github,providers,hackernews,x}.mjs`
- Runtime: `~/ai-radar/` — `config.json` (sources, watched repos, interests, X search URLs),
  `radar.db` (the SQLite knowledge graph), `reports/` (HTML output + `latest.html`).
- Cron: `~/.claude/ai-radar.ecosystem.config.js` + `~/.claude/ai-radar-ingest.sh` (pm2, hourly).

## When the user runs `/ai-radar` (the on-demand, curated path)
Do these steps in order. Keep it tight; the goal is a great dashboard + a 4-6 line spoken summary.

1. **Refresh cheap sources** (unless ingested in the last ~30 min):
   `node ~/.claude/skills/ai-radar/ingest.mjs` — GitHub + provider feeds + Hacker News → KG. ~30s, no LLM.
   (HN via the public Algolia API: `created_at_i` filters recency server-side; points filtered in code.)

2. **X (optional, heavy).** Unless the user asked to skip it or wants it fast/lite:
   `node ~/.claude/skills/ai-radar/sources/x.mjs` — scrapes AI/agent/skill chatter from the
   logged-in X profile into the KG. If it logs "not logged in" / Chrome busy, just continue.

3. **Web.** Use the `WebSearch` tool for a few date-bounded queries across the user's focus
   (models & providers, Claude Code skills/plugins, agents & MCP, devtools/best-practices), e.g.
   "claude code skills 2026", "MCP servers new", "<provider> model release". Keep ~10-15 fresh,
   high-signal links. `WebFetch` one or two only if a title is ambiguous.

4. **Read the knowledge graph:**
   `node ~/.claude/skills/ai-radar/render.mjs --json` → the structured item set (with trending repos).

5. **Curate (your judgment).** Merge KG items + web + X. Rank by the user's interests in
   `config.json`. For each kept item write a ONE-LINE "why you'd care" (concrete, not generic).
   Drop noise and near-duplicates. Group into these sections (omit any that end up empty):
   `Models & providers`, `Claude Code skills & plugins`, `Agents & frameworks`,
   `Devtools & best practices`, and an optional `Also worth a look`. Cap ~8-12 items/section,
   freshest first. Mark `isNew: true` for things surfaced today; add a `signal` string for
   trending repos (e.g. "+420 stars / 14d").

6. **Write the curated payload** to `~/ai-radar/reports/curated-latest.json` with this shape:
   ```json
   {
     "title": "AI Radar",
     "windowLabel": "since <last run / last 7 days>",
     "mode": "curated · in-session",
     "sections": [
       { "id": "models", "title": "Models & providers", "blurb": "...",
         "items": [ { "title": "...", "url": "...", "source": "github|provider|web|x",
                      "date": "2026-06-30", "whyYouCare": "one line", "tags": ["..."],
                      "isNew": true, "signal": "" } ] }
     ],
     "stats": { "scanned": <int>, "new": <int>, "sources": { "github": N, "provider": N, "web": N, "x": N } }
   }
   ```
   (`whyYouCare` may contain light markdown — it's rendered. `trending` is filled from the KG if omitted.)

7. **Render & open:**
   `node ~/.claude/skills/ai-radar/render.mjs --curated ~/ai-radar/reports/curated-latest.json --open`

8. **Tell the user** the top 4-6 highlights in chat (what's genuinely new/notable and why), and the report path.

## Passive / no-LLM path
`node ~/.claude/skills/ai-radar/render.mjs --from-db --open` renders straight from the KG (grouped by
type, with trending) — zero LLM. The hourly cron already refreshes `latest.html` this way.

## Knowledge graph
`radar.db` (Node built-in `node:sqlite`): `items` (deduped discoveries), `entities`
(repos/orgs/models/people), `edges` (relationships), `metrics` (star snapshots → trending deltas).
You can query it directly with a small `node` script importing `./db.mjs` for ad-hoc questions like
"which repos gained the most stars this week?" or "what MCP servers showed up recently?".

## Tuning
Edit `~/ai-radar/config.json`: `github.searchQueries` / `watchRepos`, `providers[]` feeds,
`x.searchUrls`, `interests`, `lookbackDays`.
