# tomerab-skills

Personal [Claude Code](https://code.claude.com/docs/en/skills) skills.

## Skills

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
