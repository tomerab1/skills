---
name: ai-radar
description: "Discover the latest in the AI ecosystem — new models & provider releases, Claude Code skills/plugins/subagents, agent frameworks & MCP, and devtools/best-practices — by scanning GitHub, npm, Hugging Face, provider changelogs, HN/Lobsters/Reddit, the web, and your logged-in X, then rendering a polished, navigable HTML dashboard. Backed by a local SQLite knowledge graph that an hourly pure-Node cron keeps fresh. Use when you want to catch up on what's new/trending or find new skills/agents/tools worth adopting."
---

# ai-radar

A personal radar for the AI dev ecosystem. Cheap, deterministic ingestion runs hourly into a
local **knowledge graph**; the rich, ranked **HTML dashboard** is produced on demand.

## Cost & resource rules (important)
- **No `claude -p`, no Anthropic SDK, no metered calls anywhere in the automated path.** The hourly
  cron is pure Node (gh CLI + RSS/Atom + public JSON APIs). The only LLM step is the *in-session*
  curation below — i.e. you, the model already in this Claude Code session — which is just normal usage.
- The only heavyweight step is the **X scrape** (launches headless Chrome via the reused
  `~/.x-reading` profile). It's **on-demand only**, never in the cron. Skip it on request.

## Sources (all cron-safe except X)
GitHub search + watched-repo releases (`gh`), **claude-code CHANGELOG.md** (enriches release
items with real notes — Anthropic's RSS is dead), provider RSS/Atom (Simon Willison, OpenAI,
Google, HF blog, GitHub blog, Latent Space, Cursor changelog, Anthropic YouTube), Hacker News
(Algolia API), **Lobsters** (`/t/ai.json`), **Reddit** (ONE multi-subreddit RSS request —
`r/a+b+c/top.rss` with descriptive UA; the .json API 403s and per-sub bursts 429), **Hugging Face
trending models** (hub API), **npm** (watched packages `/latest` + `keywords:mcp-server` search),
arXiv, X (on-demand scrape with config-driven `muteWords` noise filter).

## Files
- Skill: `~/.claude/skills/ai-radar/` — `ingest.mjs`, `render.mjs`, `db.mjs`, `shot.mjs`,
  `sources/{github,changelogs,providers,hackernews,lobsters,reddit,huggingface,npmjs,arxiv,x}.mjs`
- Runtime: `~/ai-radar/` — `config.json` (sources, watched repos/packages, subreddits, interests,
  X search URLs + muteWords), `radar.db` (SQLite KG), `reports/` (HTML + `latest.html` + `index.html` archive).
- Cron: `~/.claude/ai-radar.ecosystem.config.js` + `~/.claude/ai-radar-ingest.sh` (pm2, hourly).

## When the user runs `/ai-radar` (the on-demand, curated path)
Do these steps in order. Keep it tight; the goal is a great dashboard + a 4-6 line spoken summary.

1. **Refresh cheap sources** (unless ingested in the last ~30 min):
   `node ~/.claude/skills/ai-radar/ingest.mjs` — all cron-safe sources → KG. ~60s, no LLM.

2. **X (optional, heavy).** Unless the user asked to skip it or wants it fast/lite:
   `node ~/.claude/skills/ai-radar/sources/x.mjs` — scrapes AI/agent/skill chatter from the
   logged-in X profile into the KG. If it logs "not logged in" / Chrome busy, just continue.

3. **Web.** Use the `WebSearch` tool for a few date-bounded queries across the user's focus
   (models & providers, Claude Code skills/plugins, agents & MCP, devtools/best-practices), e.g.
   "claude code skills 2026", "MCP servers new", "<provider> model release". Keep ~10-15 fresh,
   high-signal links. `WebFetch` one or two only if a title is ambiguous.

4. **Read the knowledge graph:**
   `node ~/.claude/skills/ai-radar/render.mjs --json` → the structured item set (with trending
   repos + rising HN stories). Items carry `seen`/`featured` flags — **prefer unseen items**;
   previously-featured ones were already in an earlier report (only re-feature on major updates).
   Cross-source `also` entries (HN/Reddit/Lobsters threads about the same URL) render as badges.

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
         "items": [ { "title": "...", "url": "...", "source": "github|provider|web|x|reddit|npm|huggingface|lobsters",
                      "date": "2026-06-30", "whyYouCare": "one line", "tags": ["..."],
                      "isNew": true, "signal": "" } ] }
     ],
     "stats": { "scanned": <int>, "new": <int>, "sources": { "github": N, "provider": N, "web": N, "x": N } }
   }
   ```
   (`whyYouCare` may contain light markdown — it's rendered. `trending`/`rising` are filled from
   the KG if omitted.)

7. **Render & open:**
   `node ~/.claude/skills/ai-radar/render.mjs --curated ~/ai-radar/reports/curated-latest.json --open`
   This also **marks every curated item seen/featured in the KG** (the curation loop), so the next
   run's `--json` can tell you what's genuinely new.

8. **Tell the user** the top 4-6 highlights in chat (what's genuinely new/notable and why), and the report path.

## Passive / no-LLM path
`node ~/.claude/skills/ai-radar/render.mjs --from-db --open` renders straight from the KG (grouped
by type, with trending + sparklines) — zero LLM. The hourly cron already refreshes `latest.html`
this way. `reports/index.html` is the archive of past reports.

## Dashboard UX
Search / per-source filters / recency / sort; `j`/`k`/`o`/`s` keyboard nav; ★ save (persistent,
localStorage) with a Saved filter; read-state dimming + Hide-read; NEW-since-last-visit pills;
✓ marks previously-featured items; trending cards carry star-history sparklines; "🔥 rising on HN"
chips appear once point-velocity data accrues.

## Knowledge graph
`radar.db` (Node built-in `node:sqlite`): `items` (deduped by NORMALIZED url — tracking params &
fragments stripped, so the same story via HN/Reddit/feeds is ONE row; other discoverers land in
`items.also`), `entities` (repos/orgs/models/people — auto-extracted from item text at ingest),
`edges` (item→entity mentions), `metrics` (stars/forks/HN-points/HF-trend snapshots → deltas).
Query it directly with a small `node` script importing `./db.mjs` for ad-hoc questions like
"which repos gained the most stars this week?" or "what's connected to MCP lately?".

## Tuning
Edit `~/ai-radar/config.json`: `github.searchQueries` / `watchRepos`, `providers[]` feeds,
`reddit.subreddits`, `npm.watchPackages`, `lobsters.tags`, `huggingface.max`,
`changelogs[]`, `x.searchUrls` / `x.muteWords`, `interests`, `lookbackDays`.
