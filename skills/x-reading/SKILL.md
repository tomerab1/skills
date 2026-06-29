---
name: x-reading
description: Scrape my logged-in X (Twitter) feed/List for tweets that share external articles, rank them by my interests (software engineering & devtools, AI/ML/LLMs), and maintain a curated reading digest in a dedicated "X Reading" Slack canvas (in my Slack DM to myself). Use when I want to catch up on articles worth reading from X.
---

# X (Twitter) → Reading Digest (Slack canvas)

Sibling of the `dm-todos` / `clickup-todos` / `github-todos` skills — same output shape (a Slack canvas in the user's self-DM), different source. Source: the user's **logged-in X feed**, scraped via a dedicated Chrome profile + Playwright. The user is Tomer (Slack user id `U0A1G6UUGUQ`).

The user's interests (rank for these): **software engineering & developer tools** and **AI / ML / LLMs**. Long, substantive articles beat hot takes, threads-with-no-link, and marketing fluff.

## How it works
A Node + Playwright scraper (`scrape-x.mjs`, run via Bash) attaches to a dedicated, already-logged-in Chrome profile, scrolls the configured X List, extracts external article links from tweets, resolves `t.co` redirects, and prints JSON. This skill then dedupes against state, ranks by interest, and writes the digest to the Slack canvas. The scraper is to X what `gh` is to the github-todos skill — it does the mechanical fetch; this skill does the judgement.

## Steps

1. **Determine state.**
   - Read `~/.claude/x-reading-state.json` if it exists: `{"last_run":"<unix>", "canvas_id":"F...", "last_drain":"<YYYY-MM-DD>", "seen":["<url>", ...]}`.
   - `seen` is the list of article URLs already posted (most-recent-last, capped at ~300). If missing, treat as empty.
   - Get the current unix time with `date +%s` and the local date with `TZ=Asia/Jerusalem date '+%Y-%m-%d'`.

2. **Scrape X** (via Bash):
   ```bash
   node ~/.claude/skills/x-reading/scrape-x.mjs
   ```
   - Reads its target List URL and options from `~/.x-reading/config.json`. Output is JSON: `{ source, count, items: [{url, domain, cardTitle, tweetUrl, author, handle, postedAt, tweetText}, ...] }`.
   - **Exit code 2 = NOT_LOGGED_IN / no content.** Do NOT rewrite the canvas with "nothing found". Instead report to the user that the X session needs a (re)login: tell them to run `bash ~/.claude/skills/x-reading/setup.sh` (or `node ~/.claude/skills/x-reading/scrape-x.mjs --login`) to log in again, then stop.
   - **Exit code 3 = launch/config error** (e.g. Chrome busy, profile locked). Report the stderr and stop; don't touch the canvas.
   - If `config.json` still has the placeholder `listUrl`, tell the user to set their X List URL there and stop.

3. **Dedupe & filter.**
   - Drop any item whose `url` is already in `seen`.
   - Drop obvious non-articles: bare domains with no path, pure x.com/twitter.com links, image hosts, app-store links.

4. **Rank by interest.** For each remaining item, judge relevance to **software engineering / devtools** and **AI / ML / LLMs** using `cardTitle` + `tweetText` + `domain` as context:
   - **Worth reading** — clearly on-topic and substantive (a real article/post/paper, not a product page or thread teaser). Write a tight one-line **why-you'd-care** (what it covers + why it's notable). Note a rough read weight if obvious (paper / longread / quick).
   - **Maybe** — adjacent or interesting but lower-confidence / lighter.
   - Drop the rest silently (off-topic, spam, marketing).
   - Keep titles/links/handles verbatim; write all prose in **English**.

5. **Update the Slack canvas.** Maintain the **"X Reading"** canvas — a *separate* canvas from the other todo skills (load canvas tools via ToolSearch if needed):
   - Get `canvas_id` from state. If present, `slack_read_canvas` first, then `slack_update_canvas` with `action:"replace"` and NO `section_id` — full replacement; this canvas is owned by the skill.
   - If `canvas_id` is missing (or the read fails because it was deleted), `slack_create_canvas` titled **"X Reading"**, save the new id to state, and send its link to the self-DM (`slack_send_message`, channel_id `U0A1G6UUGUQ`).
   - **New items go to the top of "Worth reading".** Carry forward items from the previous canvas that the user hasn't ticked `[x]` (re-read the canvas to preserve their checkmarks).
   - **Daily drain.** "Recently sent" / read items are cleared once per calendar day via `last_drain` (missing or before today → empty that section this run and set `last_drain` to today). Within-day safety cap ~25.
   - **Don't short-circuit on "nothing new"** if a daily-drain is due or the user left checkmarks to reconcile. Only skip the write when the canvas is already correct AND nothing new came in AND no drain is due — in that case say so plainly and still save state.
   - Structure (canvas-flavored markdown — the title is set separately, don't repeat it):
     ```markdown
     _Updated: <YYYY-MM-DD HH:MM>_  ·  _Source: <list name/handle>_

     ## 📚 Worth reading
     - [ ] **<title or short headline>** — <one-line why you'd care> · _<domain>_ · via <handle> [↗](<article url>) · [tweet](<tweetUrl>)

     ## 🤔 Maybe
     - [ ] **<title>** — <one line> · _<domain>_ · via <handle> [↗](<article url>)

     ## ✅ Read / archived
     - [x] ...
     ```
   - One item per line. Always link the **article** via `[↗](<url>)`; include a small `[tweet]` backlink for "Worth reading" items.

6. **Save state.** Write `~/.claude/x-reading-state.json` with `last_run` (now), `canvas_id`, `last_drain` (today if drained, else carry previous), and `seen` = previous seen + all newly-posted article URLs, **capped at the most recent ~300**.

7. **Report.** Show the "Worth reading" items directly in the response (title + why + link), the canvas link, and a one-line count of "Maybe"/dropped. If the scrape returned nothing new, say so plainly. If the session needs re-login (exit 2), say only that and how to fix it.

## Setup / maintenance notes
- **One-time login:** `bash ~/.claude/skills/x-reading/setup.sh` installs `playwright-core` into `~/.x-reading/` and opens Chrome headed so the user logs into X once. The session persists in `~/.x-reading/chrome-profile/`.
- **Config:** `~/.x-reading/config.json` — `listUrl` (the X List to scrape), `scrolls`, `max`, `headless` (default true), `channel` (default `chrome`).
- **Schedule:** pm2 app `x-reading`, config `~/.claude/x-reading.ecosystem.config.js`, `cron_restart: "0 12,17 * * 0-4"` (12:00 & 17:00, Sun–Thu, Asia/Jerusalem; `autorestart:false`). Wrapper `~/.claude/x-reading-loop.sh` runs `claude -p "/x-reading" --model sonnet --permission-mode bypassPermissions`. Logs `~/.claude/logs/x-reading.{out,err}.log`.
- If headless scrapes start hitting a login wall, set `"headless": false` in config (X is stricter on headless); the window can be ignored.
- Keep runs gentle and low-volume — this is read-only scraping of the user's own feed.
