---
name: pr-review
description: Review one or more GitHub PRs by actually running them, not just reading the diff. Clones each PR, detects whether it changes a server (tests via curl) and/or a native iOS app (builds + boots the simulator and drives the UI via simctl/idb), then writes a per-PR markdown review combining a code-level read of the diff with real runtime evidence. Use when I paste GitHub PR links and want a functional PR review.
---

# PR Review (functional — actually runs the code)

Given one or more GitHub PR links, produce a real review: clone the PR, figure out what kind of change it is, **exercise it at runtime**, and write the verdict to a local markdown file. The differentiator vs. a normal review is **evidence** — curl responses for server changes, simulator screenshots for native changes.

Entry point: the user pastes PR URLs (e.g. `/pr-review https://github.com/owner/repo/pull/123 ...`). Forms accepted: full PR URL or `owner/repo#123`.

Scripts live in `scripts/` next to this file; specialized subagents are `pr-server-tester` and `pr-ios-tester`. Reports + clones + logs live under `~/.pr-review/`.

## Steps

1. **Collect PR refs** from the user's args (space/comma/newline separated). If none, ask which PR(s).

2. **For each PR — prep (deterministic, via Bash):**
   ```bash
   bash ~/.claude/skills/pr-review/scripts/fetch_pr.sh "<pr-url>"     # -> JSON: dir, diff_file, files_list, meta
   bash ~/.claude/skills/pr-review/scripts/classify.sh "<dir>" "<files_list>"   # -> JSON: kinds + stack hints
   ```
   Keep the returned JSON. `kinds` is `["native"]`, `["server"]`, both, or neither. Read `diff_file` yourself for the code-level review. If `fetch_pr.sh` fails (no access / private), report that for this PR and move on.

3. **Fan out testing.** Default to **one subagent per (PR × kind)** in parallel — send the Agent tool calls in a single message so they run concurrently:
   - For `server` → `pr-server-tester`
   - For `native` → `pr-ios-tester`
   Give each agent: `dir`, `diff_file`, the PR title/body, the classification hints, and (for iOS) a `report_shots_dir` of `~/.pr-review/screenshots/<slug>/`. Ask it to return its structured findings (build/startup status, checks pass/fail, bugs with evidence, coverage gaps).
   - If a PR is neither kind (docs/config only), skip runtime testing and just do the code review with a note.
   - **Scale option:** if given a large batch (say >4 PRs), instead drive the fan-out with the dynamic **Workflow** tool (pipeline over PRs, one tester stage per kind) for deterministic concurrency — but for a handful, parallel Agent calls are simpler and preferred.

4. **Code-level review of the diff** (you, in parallel with/after testing). Read `diff_file` and assess: correctness & logic, edge cases, security (authz, injection, secrets, input validation), error handling, performance, API/contract changes, tests added, and style/consistency with the surrounding code. Tie findings to file:line from the diff.

5. **Compose one markdown report per PR** and write it to `~/.pr-review/reviews/<slug>-$(date +%Y%m%d-%H%M).md` (use the Write tool). Structure:
   ```markdown
   # PR Review — <owner>/<repo>#<num>: <title>
   _Reviewed <date> · <url> · base ← head · +<adds>/-<dels> across <n> files_

   ## Verdict
   <Approve / Approve with comments / Request changes> — one-paragraph summary.

   ## What this PR does
   <2–4 lines, from the diff + description.>

   ## Functional test evidence
   ### Server (if applicable)
   - Startup: <method, pass/fail>
   - <check> → `curl ...` → `HTTP 200 {...}` ✅ / ❌
   ### Native iOS (if applicable)
   - Build: <pass/fail> · Launch: <pass/fail>
   - <step> — observed <...> ![](screenshots/<slug>/NN-step.png)
   - Verdict per check: ...

   ## Code review findings
   - **[severity]** `path:line` — issue, why it matters, suggested fix.

   ## Coverage gaps / not tested
   - ...

   ## Suggested PR comment
   > <a concise, paste-ready review comment summarizing the above>
   ```
   Severity tags: 🔴 blocker / 🟠 major / 🟡 minor / 🔵 nit. Only claim something "works" if a tester produced evidence (response or screenshot); otherwise say "not verified".

6. **Report back** in chat: per PR, the verdict, the headline findings (blockers/majors first), and the path to the full markdown report (and screenshots dir for native). Keep it tight; the file has the detail.

## Notes / conventions
- **Output is local markdown only** (per the user's setup) — do NOT post to GitHub or Slack unless explicitly asked. The "Suggested PR comment" section makes it easy to paste manually.
- Simulator defaults to **iPhone 16 Pro**; override per-run with `PR_REVIEW_SIM` (e.g. `PR_REVIEW_SIM='iPhone 17 Pro'`).
- Reuses clones across runs (faster re-review). Clones: `~/.pr-review/work/`. Build/diff/server logs: `~/.pr-review/logs/`.
- Per-repo build/startup is inherently fragile (deps, schemes, env, seed data). When a tester can't get something running, the review must say so honestly and mark the relevant checks "not verified" — never fabricate evidence.
- Requires: `gh` (authed), `git`, `xcodebuild`+`xcrun simctl` (full Xcode), `idb`/`idb_companion` for UI driving, `docker`/runtime as needed per repo, `jq`, `nc`.
