# tomerab-skills

Personal [Claude Code](https://code.claude.com/docs/en/skills) skills.

## Skills

### ai-radar

A personal radar for the AI dev ecosystem — discover new models & providers,
Claude Code skills/plugins, agent frameworks & MCP, and devtools, then read
them in a polished HTML dashboard:

1. A cheap, deterministic ingest (GitHub via `gh`, the claude-code
   `CHANGELOG.md`, provider RSS/Atom feeds, Hacker News, Lobsters, Reddit
   multi-subreddit RSS, Hugging Face trending models, the npm registry, arXiv)
   into a local SQLite **knowledge graph** (`~/ai-radar/radar.db`, via Node's
   built-in `node:sqlite` — no native deps). Designed for a pure-Node hourly
   cron — **no `claude -p`, no Anthropic SDK, no metered calls** anywhere in
   the automated path
2. On demand (`/ai-radar`), the in-session model also scrapes the logged-in X
   feed and web search, ranks everything against your interests with a
   one-line "why you'd care", and renders a self-contained dashboard
3. Items are deduped by **normalized URL** across sources — when the same
   story lands via a feed, HN, and Reddit it becomes one card with
   "also on…" badges linking each discussion — and curated reports mark
   items seen/featured in the graph, so the next run surfaces what's
   genuinely new
4. The dashboard (warm-dark theme, coral accent, grotesk + serif type) has a
   filter/search/sort toolbar, a scrollspy section rail, deterministic
   relevance scoring (off-topic items dimmed, not dropped), ★ save and
   read-state persisted across reports, `j`/`k`/`o`/`s` keyboard navigation,
   "new since last visit" markers, trending-repo star deltas with sparklines,
   markdown-rendered cards, and a report archive
5. A zero-LLM `--from-db` render mode builds straight from the graph, so the
   hourly cron keeps `latest.html` fresh for free

Reuses the `x-reading` logged-in Chrome profile for the X source. Tune sources,
watched repos/packages, subreddits, interests, relevance keywords, and X
mute-words via `config.example.json` (copied to `~/ai-radar/config.json` at
setup).

### debrief

Pay down comprehension debt on code that Claude/agents shipped for you — so you
can defend the work in reviews and interviews:

1. `/debrief <ticket|PR|branch|"last week">` gathers the diff (the 5-9 files
   that matter) and, with approval, mines your local CC transcripts for the
   *rationale* — decisions and rejected alternatives that diffs don't contain
2. Writes a 15-minute brief to `~/debriefs/<repo>/` (private — transcript-mined
   content never lands in work repos): elevator, mermaid data flow, files that
   matter, decisions & alternatives, invariants & gotchas
3. Generates an interactive HTML quiz (free-text + MCQ) whose answers submit
   **directly into your running session** via a custom [Claude Code
   channel](https://code.claude.com/docs/en/channels) (`channel/debrief-channel.mjs`,
   localhost + token-gated); Claude grades honestly and the report streams back
   into the quiz page over SSE
4. Wrong answers feed SM-2-lite spaced repetition (`~/debriefs/state.json`) so
   weak concepts resurface in future quizzes

Channel setup: `npm install` in `skills/debrief/channel/`, register with
`claude mcp add --scope user debrief -- node <abs-path>/debrief-channel.mjs`,
then run sessions with `claude --dangerously-load-development-channels
server:debrief` (channels are a research preview). Copy-to-clipboard fallback
works without the channel.

### test-planner

Interactive test planning that keeps the developer in the loop at the step
that matters — choosing *what must be true*:

1. Analyzes a file / diff / feature adversarially (invariants and round-trips
   first, then seams, failure paths, boundaries)
2. Proposes a checklist of test cases with rationale
3. **Stops** — the developer adds, strikes, and amends cases
4. Persists the approved plan to a committed markdown file
5. Generates the tests in the repository's house style, wires them into the
   build/runner, runs them, and reports per-case results

Motivation: tests written by the same model that wrote the code inherit its
blind spots. The curation step injects developer domain knowledge before any
test code exists, and the committed plan makes "what we decided to verify"
reviewable history.

### dm-todos

On-demand Slack catch-up — no scheduled agents, runs only when invoked:

1. Scans DMs, group DMs, and channel @-mentions since the last run
   (tracked in `~/.claude/dm-todos-state.json`; first run looks back 7 days)
2. Classifies what needs attention: **Needs action**, **Awaiting your
   reply**, **FYI** — skipping chatter, resolved threads, and bot noise
3. Maintains a "Slack Todos" canvas (linked in the self-DM) as a persistent
   checklist; unchecked items carry over between runs, resolved ones move to
   "Recently done"
4. Shows the actionable sections directly in the response

Requires the Slack MCP integration. Handles Hebrew and English messages.

### clickup-todos

The ClickUp sibling of `dm-todos` — same output, different source:

1. Scans the user's ClickUp tasks and the comments/@mentions on them since
   the last run (tracked in `~/.claude/clickup-todos-state.json`; first run
   looks back 14 days)
2. Surfaces what needs attention — tasks assigned to him, mentions, and
   recently updated/commented items
3. Maintains a dedicated "ClickUp Todos" canvas (in the self-DM) as a
   persistent checklist; unchecked items carry over between runs, resolved
   ones drain to "Recently done"

Requires the ClickUp and Slack MCP integrations.

### github-todos

The GitHub sibling of `dm-todos` / `clickup-todos` — scoped to the
`singit-dev-org` org via the `gh` CLI:

1. Scans for PRs awaiting his review, his own PRs that are blocked or ready
   to merge, @mentions, and issues/PRs assigned to him (state tracked in
   `~/.claude/github-todos-state.json`; first run looks back 14 days)
2. Enriches each of his open PRs with review/merge/CI status to flag blockers
3. Maintains a dedicated "GitHub Todos" canvas (in the self-DM) as a
   persistent checklist; unchecked items carry over between runs, resolved
   ones drain to "Recently done"

Requires the `gh` CLI (authenticated) and the Slack MCP integration.

### hike-research

Research a hiking destination from real trip reports (*sipurei derech*) on
[sipurderech.co.il](https://www.sipurderech.co.il) and distill the important
points into a source-anchored brief:

1. Matches a destination (Hebrew or English) against the site's sitemap, then
   politely fetches the region hub and the relevant trip stories — rate-limited
   and disk-cached under `~/.claude/hike-research/`, so it stays targeted and
   each page is pulled at most once
2. Builds a local **knowledge graph** of the fetched pages (region → sub-region
   → trip-story → author, plus link relations) so several reports about the
   same trip can be clustered and cross-checked
3. Synthesizes the points that matter for *your* group's hike — season,
   route, difficulty, huts/water/logistics, gear, warnings, highlights — with
   every claim linked back to the specific source page
4. Optionally renders the brief as a **PDF** in Hebrew (RTL), English, or
   bilingual via headless Chrome (correct Hebrew bidi, no extra dependencies)

Two pure-stdlib helpers ship with it: `sipur.py` (discover / fetch / cache /
graph / related) and `render_pdf.py` (Markdown → styled PDF). Content is
Hebrew; the skill translates for English/bilingual output. For personal trip
planning — it deliberately never crawls the whole site.

### walk-route

The on-the-ground companion to `hike-research`: turn a place + preferences into
a **followable GPX walking route**, built from OpenStreetMap:

1. **Geocodes** the start / endpoints (Nominatim — Hebrew or English)
2. **Discovers what's around** via Overpass — parks, water, viewpoints, paths,
   cafés, playgrounds, … filtered by the walk's theme
3. **Routes it for real** with BRouter foot profiles: fits a round-trip of a
   target distance through spread-out POIs, or routes an A→B through chosen
   waypoints
4. **Writes a `.gpx`** (track + the chosen POIs as waypoints) to load on a
   phone / GPS watch / Komoot / Gaia, plus a short in-chat summary and an
   optional one-click overpass-turbo.eu link to eyeball the OSM data on a map

One pure-stdlib helper ships with it — `walk.py` (`geocode` / `features` /
`route` / `loop` / `turbo`). Talks only to free OSM-ecosystem services, with
every response disk-cached and each host rate-limited. For personal route
planning — keep it targeted, not bulk harvesting.

### x-reading

A reading-digest sibling of the todo skills, sourced from X (Twitter):

1. Scrapes the **logged-in** X feed / a List via Playwright driving the
   existing Chrome session — pulling tweets that share *external articles*
2. Ranks them by the user's interests (software engineering & devtools,
   AI/ML/LLMs), skipping threads, promos, and link-less chatter
3. Maintains a dedicated "X Reading" canvas (in the self-DM) as a curated,
   de-duplicated reading list that carries over between runs

Requires a logged-in Chrome session (Playwright) and the Slack MCP integration.

### pr-review

Reviews GitHub PRs by **actually running them**, not just reading the diff:

1. Clones each PR and detects what it changes — a server (tested via `curl`)
   and/or a native iOS app (built, booted on the simulator, driven through the
   UI via `simctl` / `idb`)
2. Combines a code-level read of the diff with **real runtime evidence**
   (requests/responses, screenshots, logs)
3. Writes a per-PR markdown review

Ships two helper agents — `pr-server-tester` and `pr-ios-tester`. Requires the
`gh` CLI; iOS testing needs Xcode + a simulator.

### rn-devtools

Chrome-DevTools-style **Console + Network** (plus live `eval`) for a running
React Native / Hermes app on the iOS Simulator, driven from the terminal:

1. Attaches to Metro's built-in CDP inspector proxy (`localhost:8081`) — no
   proxy, cert, or Flipper needed
2. Streams `console.*` / exceptions and full network requests
   (method/status/timing/size, optional bodies) into queryable JSONL buffers
3. Filterable queries (`console --level error`, `net --failed --since 2m`), a
   `wait --match` trigger that fires when a matching request lands, and `eval`
   to run JS in the app's context

Zero dependencies (Node 22 built-in `WebSocket`/`fetch`). The connector is a
single client — don't run React Native DevTools at the same time.

### whatsapp-kg

Archive **one** WhatsApp group into a local store and distill it into a
queryable knowledge graph, so its knowledge stays available years later:

1. **Ingestion** via Baileys (run always-on under pm2) into a local SQLite store
2. **Extraction** of an entity/relation knowledge graph from the messages
3. **Q&A** over the graph through Claude Code itself — no Anthropic SDK

Run `npm install` in the skill dir first (Baileys, `better-sqlite3`). The
WhatsApp session auth and the chat database are kept **local and gitignored**.

## Install

**Per-user (all projects):**

```sh
mkdir -p ~/.claude/skills
cp -R skills/<skill-name> ~/.claude/skills/
```

**Per-project:** copy `skills/<skill-name>` into the project's
`.claude/skills/` and commit it.

**As a plugin (development):**

```sh
claude --plugin-dir /path/to/tomerab-skills
```

## Running

Each skill is invoked from inside Claude Code by name:

```
/dm-todos
/clickup-todos
/github-todos
/test-planner <file | diff | feature>
/hike-research <destination + when / how many days / who's going>
/walk-route <start place + distance or A→B, e.g. "4km park loop from Rothschild Blvd">
/x-reading
/pr-review <GitHub PR links>
/rn-devtools <what to debug in the running RN app>
/whatsapp-kg <ingest | extract | a question about the archived group>
```

The three todo-digest skills (`dm-todos`, `clickup-todos`, `github-todos`)
are on-demand and stateful — they track the last run in
`~/.claude/<skill>-state.json` and pick up where they left off, so they're
made to be run repeatedly.

To run one on a recurring basis, use the built-in `/loop` skill with an
interval:

```
/loop 30m /dm-todos
```

Omit the interval to let Claude self-pace the cadence. `/loop` keeps the
catch-up running in the background without any external scheduler.
