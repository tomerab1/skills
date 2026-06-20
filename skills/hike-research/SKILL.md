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
   The output also lists the page's **SECTIONS** — each chapter/heading with a
   section-level deep link (`<url>#chapter-…`, plus `#tips`, `#links`). Get just
   that map with `python3 sipur.py sections <slug>`. **Cite these section URLs,
   not the bare page URL**, so a reference jumps the reader to the exact part.

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
   matter for *this* group's hike. Use the renderer's two features to keep it
   clean (see "Markdown the renderer understands" below):
   - **Footnote citations, not inline links.** Define each source once at the
     bottom as `[^1]: <author> — <title> § <section> <section-URL>` and cite it
     in the text with a compact `[^1]`. This renders as a small superscript and a
     single consolidated **References** list — far less clutter than a
     `[source]` after every line. Reuse the same `[^n]` for every claim from
     that source; add a new number only for a new source (or a meaningfully
     different section). Aim for one citation per bullet/row, not several.
   - **Tables for comparisons.** Put the at-a-glance summary and any
     side-by-side comparison (e.g. routes × duration/difficulty/season) in a
     pipe table.
   Translate to the chosen language (for `he` write Hebrew; for `bi` lead in
   English keeping Hebrew place names). Suggested shape:
   ```markdown
   # <Route / destination>
   _Synthesized from N trip reports on sipurderech.co.il_

   ## At a glance
   | | |
   |---|---|
   | **Region** | … |
   | **Best season** | … [^1] |
   | **Duration / difficulty** | … [^2] |

   ## Recommended route(s)
   - <segment / day breakdown> [^1]

   ## Season & conditions
   - <when to go, weather, snow> [^3]

   ## Logistics
   - Getting there, huts/camping, water, permits, costs [^1]

   ## Tips & warnings from hikers
   - <personal tip / hazard> [^2]

   ## Highlights
   - <views, peaks, lakes> [^3]

   [^1]: Maya Shemesh — 3-day Bucegi trek § Route <section-URL>
   [^2]: Omer Noy — Omu ascent § Day 2 <section-URL>
   [^3]: Omer Ohayon — 7-day ridge trek <page-URL>
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

   **Markdown the renderer understands:** `#`–`######` headings; `-`/`*`/`1.`
   lists; `> ` blockquotes; `---` rules; `**bold**`, `_italic_`, `` `code` ``;
   `[text](url)` inline links; **GitHub pipe tables** (header row + `|---|---|`
   separator); and **footnote citations** — `[^id]` in the body plus
   `[^id]: label… <url>` definitions, rendered as superscripts and a numbered
   References list (use numeric ids for clean superscripts). Inline links get a
   `↗`; footnote superscripts don't. Tables and citations are the two features
   to lean on for a clean, low-clutter brief.

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
