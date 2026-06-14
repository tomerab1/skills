---
name: github-todos
description: Scan GitHub (singit-dev-org) for PRs awaiting my review, my own PRs that are blocked or ready to merge, @mentions, and issues/PRs assigned to me, and maintain an organized todo digest in a dedicated "GitHub Todos" Slack canvas (in his Slack DM to himself). Use when the user wants to catch up on what's pending on GitHub.
---

# GitHub → Todo Digest (Slack canvas)

Sibling of the `dm-todos` / `clickup-todos` skills — same output (a Slack canvas in the user's self-DM), different source. Source: GitHub org **`singit-dev-org`** via the `gh` CLI (authenticated as `tomerab1`).

The user is Tomer (Slack user id `U0A1G6UUGUQ`; GitHub login `tomerab1` — use `@me` in `gh` queries). Every `gh` query is scoped to `--owner singit-dev-org`.

## Steps

1. **Determine the window & state.**
   - Read `~/.claude/github-todos-state.json` if it exists: `{"last_run": "<unix>", "canvas_id": "F...", "last_drain": "<YYYY-MM-DD>"}`.
   - If missing, look back 14 days. Get the current unix timestamp with `date +%s` via Bash.

2. **Gather from GitHub** (via Bash `gh`; all scoped to `--owner singit-dev-org`):
   - **PRs awaiting my review:** `gh search prs --review-requested=@me --state=open --owner=singit-dev-org --json number,title,url,repository,updatedAt,author`
   - **My open PRs:** `gh search prs --author=@me --state=open --owner=singit-dev-org --json number,title,url,repository,updatedAt,isDraft`. For each, enrich with `gh pr view <url> --json reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,isDraft` to detect blockers.
   - **@mentions:** `gh search prs --mentions=@me --state=open --owner=singit-dev-org ...` and `gh search issues --mentions=@me --state=open --owner=singit-dev-org ...`
   - **Assigned to me:** `gh search prs --assignee=@me --state=open --owner=singit-dev-org ...` and `gh search issues --assignee=@me --state=open --owner=singit-dev-org ...`
   - **Recently merged/closed (mine):** `gh search prs --author=@me --owner=singit-dev-org --merged --json number,title,url,repository,closedAt` (and closed) since the window start, for the "Recently done" section.
   - Dedupe across all queries by URL.

3. **Classify.**
   - **Needs action** — a PR awaiting my review; one of my PRs that is **blocked** (`reviewDecision = CHANGES_REQUESTED`, CI failing = `statusCheckRollup` has FAILURE, or conflicting = `mergeStateStatus = DIRTY`) or **ready to merge** (`reviewDecision = APPROVED` and `mergeable = MERGEABLE`); an open issue/PR assigned to me.
   - **Awaiting reply** — an @mention/comment asking me something I haven't answered.
   - **FYI / context** — e.g. a PR of mine just approved, or CI turned green.
   - **Recently done** — my PRs merged/closed since the window; reviews I completed.

4. **Update the Slack canvas.** Maintain the "GitHub Todos" Slack canvas (load canvas tools via ToolSearch if needed) — a **separate** canvas from the other todo skills:
   - Get `canvas_id` from state. If present, `slack_read_canvas` first, then `slack_update_canvas` with `action: "replace"` and NO `section_id` — full replacement; this canvas is owned by the skill.
   - If `canvas_id` is missing (or the read fails because it was deleted), `slack_create_canvas` titled **"GitHub Todos"**, save the new id to state, and send its link to the user's self-DM (`slack_send_message`, channel_id `U0A1G6UUGUQ`).
   - **Completing items.** When a PR/issue is merged or closed (or a requested review is submitted, or the user ticks `[x]`), move it to "Recently done" (kept as `[x]`). Never leave a merged/closed item in an active section, and never silently delete it.
   - **Daily drain.** "Recently done" is cleared once per calendar day via `last_drain` (missing or before today → empty it this run and set `last_drain` to today). Same-day completions survive until the next day's first run. Within-day safety cap: ~15.
   - **Don't short-circuit on "nothing new".** A newly merged/closed PR or a due daily-drain is itself a reason to rewrite the canvas. Only skip the write when the canvas is already fully correct.
   - Structure (canvas-flavored markdown — the title is set separately, don't repeat it):
     ```markdown
     _Updated: <YYYY-MM-DD HH:MM>_

     ## 🔴 Needs action
     - [ ] **<repo#num>**: <one line — why it needs me (review / CI red / changes requested / ready to merge / assigned)> [↗](<pr or issue url>) _(<updated>)_

     ## 💬 Awaiting your reply
     - [ ] **<who> on <repo#num>**: <their question> [↗](<url>) _(<date>)_

     ## 📋 FYI
     - <one-liner> [↗](<url>) _(<date>)_

     ## ✅ Recently done
     - [x] ...
     ```
   - **Write items in English.** Keep repo names, PR/issue numbers, branch names, and code identifiers verbatim.
   - One line per item; end each with a compact `[↗](<url>)` to the PR/issue. If no reliable URL, omit the ref.

5. **Save state.** Write `~/.claude/github-todos-state.json` with `last_run` (now), `canvas_id`, and `last_drain` (today's date if drained this run, else carry the previous value).

6. **Report.** Show the "Needs action" and "Awaiting your reply" sections directly in the response, plus the canvas link and a one-line count of FYIs. If nothing new came in, say so plainly.
