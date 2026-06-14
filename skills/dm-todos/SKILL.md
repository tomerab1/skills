---
name: dm-todos
description: Scan recent Slack DMs and @-mentions, extract action items, and maintain an organized todo list in the user's "Slack Todos" canvas (in his Slack DM to himself). Use when the user wants to catch up on Slack messages they may have missed or asks "what do I need to do from Slack?".
---

# Slack DM → Todo List

Build/refresh an organized todo list from the user's recent Slack DMs and mentions.

The user is Tomer (Slack user ID `U0A1G6UUGUQ`). He often misses DMs, so the goal is a glanceable, organized list of what needs his attention.

## Steps

1. **Determine the time window.**
   - Read `~/.claude/dm-todos-state.json` if it exists; it contains `{"last_run": "<unix timestamp>", "canvas_id": "F..."}`.
   - If missing, default to 7 days ago. Get the current unix timestamp with `date +%s` via Bash.
   - Scan from `last_run` minus a 1-hour overlap (to avoid missing edge messages) up to now.

2. **Gather messages.** Use `slack_search_public_and_private` (load via ToolSearch if needed):
   - DMs and group DMs: query `to:me`, `channel_types: "im,mpim"`, `sort: "timestamp"`, with `after` set to the window start. Paginate with the cursor until results are exhausted or older than the window.
   - Mentions in channels: query `to:me`, `channel_types: "public_channel,private_channel"`, same window.
   - Note: messages may be in Hebrew or English — handle both.
   - If a result looks like part of a longer exchange and its meaning is unclear, use `slack_read_channel` or `slack_read_thread` on that conversation to get context before classifying it.

3. **Extract and classify.** For each conversation, identify:
   - **Action items** — things someone asked Tomer to do, review, fix, answer, or decide.
   - **Awaiting reply** — direct questions to Tomer that he hasn't answered (check if the last message in the exchange is from the other person).
   - **FYI / context** — important info that needs no action (decisions made, status updates, things that got resolved on their own).
   - Skip pure chatter, resolved back-and-forths, and bot noise.
   - For every item you keep, record the source message's **permalink** — the `Permalink` field in each search/read result — so the canvas can link straight to it.

4. **Update the canvas.** Maintain the "Slack Todos" Slack canvas (load canvas tools via ToolSearch if needed):
   - Get `canvas_id` from the state file. If present, `slack_read_canvas` first: preserve unchecked items from previous runs unless this run's messages show they were resolved — in that case check them off (move to "Recently done", keep max ~10 there). Also respect items the user checked off himself. Then `slack_update_canvas` with `action: "replace"` and NO `section_id` — full replacement is intended; this canvas is owned by the skill.
   - If `canvas_id` is missing (or reading it fails because it was deleted), `slack_create_canvas` titled "Slack Todos", save the new ID to state, and send its link to the user's self-DM (`slack_send_message` with channel_id `U0A1G6UUGUQ`) so it's findable in his "to myself" PM.
   - Structure (canvas-flavored markdown — the title is set separately, don't repeat it):
     ```markdown
     _עודכן: <YYYY-MM-DD HH:MM>_

     ## 🔴 Needs action
     - [ ] **<Person>**: <what they need, in one line> [↗](<source message permalink>) _(<date>)_

     ## 💬 Awaiting your reply
     - [ ] **<Person>**: <their question> [↗](<source message permalink>) _(<date>)_

     ## 📋 FYI
     - <one-liner> [↗](<source message permalink>) _(<date>)_

     ## ✅ Recently done
     - [x] ...
     ```
   - Write items in the language the user would expect (keep Hebrew items in Hebrew, English in English).
   - Keep each item to one line; the canvas is for glancing, not reading.
   - **Message reference.** End each item with a compact `[↗](<permalink>)` link to its exact source message — never paste the raw URL as text. Use the `Permalink` from the search/read result, or build it as `https://<workspace>.slack.com/archives/<channel_id>/p<ts with the dot removed>` (for a thread reply, append `?thread_ts=<parent_ts>&cid=<channel_id>`). If an item has no reliable permalink, omit the ref rather than guess. Carried-over items from a previous canvas keep whatever ref they already had; only newly found items get a fresh one.

5. **Save state.** Write `~/.claude/dm-todos-state.json` with the current unix timestamp as `last_run` and the `canvas_id`.

6. **Report.** Show the user the "Needs action" and "Awaiting your reply" sections directly in the response (not just "canvas updated"), plus the canvas link and a one-line note of how many FYIs were filed. If nothing new came in, say so plainly.
