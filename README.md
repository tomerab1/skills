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
