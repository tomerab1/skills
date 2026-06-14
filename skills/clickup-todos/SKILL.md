---
name: clickup-todos
description: Scan the user's ClickUp tasks (and the comments/@mentions on them) for what needs his attention, and maintain an organized todo digest in a dedicated "ClickUp Todos" Slack canvas (in his Slack DM to himself). Use when the user wants to catch up on what's pending in ClickUp.
---

# ClickUp → Todo Digest (Slack canvas)

Build/refresh an organized todo digest from the user's ClickUp tasks and the comments/@mentions on them, and write it to a Slack canvas. This is the ClickUp sibling of the `dm-todos` skill — same output (a Slack canvas in his self-DM), different source (ClickUp instead of Slack messages).

The user is Tomer (Slack user id `U0A1G6UUGUQ`; ClickUp user id `107480763` — still call `clickup_resolve_assignees(["me"])` to be safe).

## Steps

1. **Determine the window & state.**
   - Read `~/.claude/clickup-todos-state.json` if it exists: `{"last_run": "<unix>", "canvas_id": "F...", "last_drain": "<YYYY-MM-DD>"}`.
   - If missing, look back 14 days. Get the current unix timestamp with `date +%s` via Bash.
   - "Recently updated/commented" means since `last_run` minus a 1-hour overlap (or the 14-day default on first run).

2. **Gather from ClickUp** (load tools via ToolSearch if needed):
   - Resolve the user id: `clickup_resolve_assignees(["me"])`.
   - `clickup_filter_tasks(assignees=[<me>], order_by="updated", include_closed=true)` to get tasks involving him; paginate as needed.
   - **Keep a task if ANY of:** it's **overdue or due within 3 days**; it's in an **active status assigned to me** (e.g. "to do", "in progress", "code review" — not done/closed/parked); its **priority is high or urgent** (read `task.priority` client-side; `filter_tasks` has no priority filter); or it was **updated since the window start**.
   - For each kept task, `clickup_get_task_comments` (and `clickup_get_threaded_comments` for threads) and find comments that **@mention me or ask me a direct question**, especially since the window start. Skip resolved back-and-forth and bot noise.
   - **Known limitation:** there is no global "@mentions to me" feed in the available API, so mentions are only found on tasks surfaced above — a mention on a task the user isn't on won't be caught.

3. **Classify.** For each task/comment, identify:
   - **Needs action** — a task that needs work/decision, or a comment asking the user to do something.
   - **Awaiting reply** — a direct question to the user in a comment he hasn't answered.
   - **FYI / context** — status changes or decisions that need no action.
   - **Recently done** — tasks whose status is now done/closed, or threads that got resolved.

4. **Update the Slack canvas.** Maintain the "ClickUp Todos" Slack canvas (load canvas tools via ToolSearch if needed) — this is a **separate** canvas from the `dm-todos` "Slack Todos" one:
   - Get `canvas_id` from state. If present, `slack_read_canvas` first, then `slack_update_canvas` with `action: "replace"` and NO `section_id` — full replacement is intended; this canvas is owned by the skill.
   - If `canvas_id` is missing (or the read fails because it was deleted), `slack_create_canvas` titled **"ClickUp Todos"**, save the new id to state, and send its link to the user's self-DM (`slack_send_message`, channel_id `U0A1G6UUGUQ`) so it's findable in his "to myself" PM.
   - **Completing items.** When a referenced task's status becomes done/closed (or the user ticks an item `[x]`), move it to "Recently done" (kept as `[x]`). Never leave a done task in an active section, and never silently delete it.
   - **Daily drain.** "Recently done" is cleared once per calendar day: if `last_drain` is missing or before today, empty that section this run and set `last_drain` to today. Same-day completions accumulate and survive until the next day's first run. Within-day safety cap: ~15.
   - **Don't short-circuit on "nothing new".** A newly-completed task or a due daily-drain is itself a reason to rewrite the canvas, even when no new comments arrived. Only skip the write when the canvas is already fully correct.
   - Structure (canvas-flavored markdown — the title is set separately, don't repeat it):
     ```markdown
     _Updated: <YYYY-MM-DD HH:MM>_

     ## 🔴 Needs action
     - [ ] **<task / who>**: <one line> [↗](<task url>) _(<due / updated>)_

     ## 💬 Awaiting your reply
     - [ ] **<who>**: <their question> [↗](<task or comment url>) _(<date>)_

     ## 📋 FYI
     - <one-liner> [↗](<task url>) _(<date>)_

     ## ✅ Recently done
     - [x] ...
     ```
   - **Write items in English** (translate Hebrew comments to concise English), keeping names, ticket/PR refs, code identifiers, and task IDs verbatim.
   - One line per item; end each with a compact `[↗](<url>)` to its ClickUp task (`task.url`) — or the specific comment when available. If no reliable URL, omit the ref.

5. **Save state.** Write `~/.claude/clickup-todos-state.json` with `last_run` (now), `canvas_id`, and `last_drain` (today's date if drained this run, else carry the previous value).

6. **Report.** Show the "Needs action" and "Awaiting your reply" sections directly in the response, plus the canvas link and a one-line count of FYIs. If nothing new came in, say so plainly.
