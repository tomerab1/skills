---
name: hike-research
description: Research a hiking destination using personal trip reports ("sipurei derech") from sipurderech.co.il, build a local cache + knowledge graph of the relevant pages, and produce a source-anchored trip brief — optionally as a Hebrew/English/bilingual PDF. Use when planning a hike and you want the important points distilled from real people's experiences on that site.
---

# Hike research from sipurderech.co.il

Turn a hiking destination + constraints into a distilled, **source-anchored** trip
brief built from real trip reports on `sipurderech.co.il`, with everything cached
locally as a small **knowledge graph** so the data can be explored, clustered, and
re-used across runs. Optionally render the brief as a PDF in Hebrew (RTL),
English, or bilingual.

The site is a Hebrew Next.js site. Two helper scripts live next to this file:
- `sipur.py` — discover / fetch / cache / graph / related (pure stdlib).
- `render_pdf.py` — Markdown brief → styled HTML → PDF via headless Chrome
  (correct Hebrew RTL with no extra dependencies).

State lives under `~/.claude/hike-research/` (`cache/`, `graph.json`,
`sitemap.json`). Run the scripts from this skill's directory, e.g.
`python3 "$SKILL_DIR/sipur.py" ...`.

## Be a polite guest (read this first)

The site's `robots.txt` sets `User-agent: * → Allow: /` but explicitly
**disallows AI crawler bots** (`ClaudeBot`, `GPTBot`, …) and signals
`ai-train=no`. This skill is for **personal trip planning**, equivalent to a
person browsing — not bulk ingestion or training. So:
- **Stay targeted.** Fetch only the handful of pages relevant to the asked hike
  (a region hub + its trip stories). Never crawl the whole 8,900-URL sitemap.
- The fetcher is **rate-limited and disk-cached** — each page is pulled at most
  once per 14 days. Don't bypass that.
- **Attribute, don't redistribute.** The brief quotes/summarizes and links back
  to each source; it is for the user and their hiking group, not for publishing.
- If the user asks to mass-scrape the site, push back and offer the targeted
  flow instead.

## Workflow

1. **Get the ask.** Destination/route (Hebrew or English) plus any constraints —
   days available, season/month, difficulty, group type (friends / family /
   kids), and what they care about (water, huts, gear, logistics, highlights).
   Also confirm the **PDF language** if they want a PDF: `he` (Hebrew, RTL),
   `en` (English), `bi` (bilingual). Default to no PDF unless asked.

2. **Discover candidate pages.**
   ```
   python3 sipur.py discover "<place>" --limit 25
   ```
   Matches the cached sitemap. Hebrew place names match best (e.g. `רומניה`,
   `בוצ'גי`); latin slugs exist too. Pick the region **hub** plus activity
   sub-pages (e.g. `<region>/טרקים` = treks, `/טיולי-יום` = day trips).

3. **Fetch the hub, then the trip stories.**
   ```
   python3 sipur.py fetch <hub-slug> [<sub-slug> ...]
   ```
   Each fetch caches the page and folds it into the graph. Read the hub with
   `python3 sipur.py show <slug>` — its links list the individual **trip
   stories** (type `story`), each shown with month/year, view count, title, a
   one-line description, and author. Fetch the most relevant/popular/recent
   stories (typically 3–8). Story slugs are nested, e.g.
   `רומניה/טרק-ברכס-הרי-בוצ'גי`.

4. **Read the stories.** `python3 sipur.py show <story-slug>` prints the full
   narrative plus the structured fields the site exposes — **תאריך הטיול**
   (trip date), **משך הטיול** (duration), **עונה מומלצת** (recommended season),
   route/map links, and a table of contents. These are the backbone of the brief.

5. **Explore the graph / cluster multiple reports of the same trip.**
   ```
   python3 sipur.py related <slug> --depth 1     # neighbours of a page
   python3 sipur.py graph                         # whole local graph
   ```
   Use `related` to find several *sipurei derech* covering the same area/route so
   you can cross-check (e.g. season advice, difficulty, water sources) and call
   out where reports agree or differ. Enrich by fetching neighbours that look
   relevant, then re-running `related`.

6. **Synthesize a source-anchored brief (Markdown).** Pull out the points that
   matter for *this* group's hike. Every non-obvious claim ends with a Markdown
   link to the **specific** source page it came from — use each record's `url`
   (already percent-encoded). Suggested shape (translate to the chosen language;
   for `he` write Hebrew, for `bi` lead in English keeping Hebrew place names):
   ```markdown
   # <Route / destination>
   _Synthesized from N trip reports on sipurderech.co.il_

   ## At a glance
   - Region · best season · typical duration · difficulty · group fit

   ## Recommended route(s)
   - <segment/day breakdown> [source](<story url>)

   ## Season & conditions
   - <when to go, weather, snow> [source](<url>)

   ## Logistics
   - Getting there, huts/camping, water, permits, costs [source](<url>)

   ## Tips & warnings from hikers
   - <personal tip / hazard> — <author> [source](<url>)

   ## Highlights
   - <views, peaks, lakes> [source](<url>)

   ## Sources
   - <title> — <author>, <month year> [↗](<url>)
   ```
   When reports disagree, say so and cite both. Don't invent specifics
   (distances, altitudes, prices) that aren't in the sources — attribute or omit.

7. **Render the PDF (if requested).** Write the brief to a `.md` file, then:
   ```
   python3 render_pdf.py --in brief.md --out "<dest>-trip.pdf" \
       --lang he|en|bi --title "<title>"
   ```
   `--lang he` sets RTL + Hebrew fonts; verified to render Hebrew correctly via
   headless Chrome. Confirm the output path back to the user. If no Chrome is
   found it falls back to weasyprint, else writes the `.html` to print manually.

8. **Report.** Show the brief (or its key sections) in chat, note how many
   reports it draws on, and give the PDF path if one was made. Mention any place
   where the hikers' reports conflicted.

## Notes & limits

- **Hebrew first.** Search and content are Hebrew; matching on Hebrew place names
  is most reliable. The agent translates for English/bilingual output.
- **Discovery is sitemap-based**, so a page must be in `sitemap.xml` to be found
  by `discover`; you can always `fetch` a known slug/URL directly.
- **`type` is a heuristic** (`hub` / `story` / `page`) — confirm by reading.
- **Caches persist** across runs (14-day page TTL, 1-day sitemap TTL). Re-running
  for the same destination is fast and makes no new requests. Delete
  `~/.claude/hike-research/` to reset.
