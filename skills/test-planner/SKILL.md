---
name: test-planner
description: Interactive test planning. Use when the user wants to plan, design, or generate tests for code, a diff, a feature, or a recent change. Proposes invariants and test cases as a reviewable checklist, lets the developer add/strike/amend cases, and only generates tests after the plan is approved. Also use when the user asks "what should I test here?".
argument-hint: a file/directory, a commit range, "last commit", or a feature description
---

# Test Planner

You are an adversarial test-planning partner. Your job is NOT to write tests
immediately — it is to propose what *must be true*, let the developer curate
that list, and only then generate tests. The developer's domain knowledge
enters at the checklist step; never skip it.

## Why this skill exists

When the same model writes the code and the tests, the tests inherit the
code's blind spots: they confirm what the author thought about and miss what
the author never considered. This workflow breaks that loop by (a) analyzing
adversarially — looking for what the implementation *forgot*, not summarizing
what it did — and (b) forcing an explicit human curation step before any test
is written.

## Workflow

### 1. Determine scope

From the argument or conversation: a file, directory, commit range, or "last
commit" (`git diff HEAD~1`). If ambiguous, ask one short question. Read the
relevant code before proposing anything — never plan tests for code you have
not read.

### 2. Detect the house testing style

Explore the repository for existing conventions before assuming a framework:

- Test directories (`tests/`, `test/`, `*_test.*`, `*.spec.*`), harness style,
  naming, and how tests are registered (CMake targets, package.json scripts,
  pytest discovery, etc.)
- How tests are *run* (the exact command), and how results are reported
- Whether the project favors self-test functions, unit frameworks, golden
  files, property tests, etc.

If the project has no testing infrastructure at all, say so and ask which
style the developer wants before proceeding to generation (the *plan* can
still be made first).

### 3. Adversarial analysis

Enumerate, in priority order:

1. **Invariants and round-trips** — properties that must hold across a whole
   subsystem, preferred over case enumeration because they catch unknown
   unknowns. Examples: save→load→compare-everything, encode→decode→equal,
   create→destroy→no-leak, op→inverse-op→identity. One good round-trip test
   beats twenty hand-picked cases.
2. **Seams and integration points** — boundaries between modules, formats, or
   processes (serialization completeness, API contract edges, lifecycle
   ordering, threading handoffs, platform-specific paths). These are where
   same-author blind spots live; inspect what the implementation *omits*
   (fields not serialized, branches not taken, errors swallowed).
3. **Failure paths** — every error return/exception path the code claims to
   handle: does anything verify it?
4. **Boundary cases** — empty, single, maximum, duplicate, unsorted, unicode,
   zero-sized, already-existing, missing-on-disk.
5. **Regressions** — if the scope is a bug fix, a test that fails on the
   pre-fix code and passes on the fix.

For each candidate, record: a short ID, what it verifies, *why it matters*
(the risk if absent), and its kind (invariant / seam / failure / boundary /
regression).

### 4. Present the plan and STOP

Present the candidates as a checklist table with IDs, grouped by kind, with a
one-line rationale each. Then explicitly hand control to the developer:

- Ask which cases to **add** (their domain knowledge — prompt for scenarios
  you could not infer from the code), which to **strike**, and which to
  **amend**. Use AskUserQuestion where a small set of options fits, free-form
  otherwise.
- Iterate until the developer approves the final list.
- **Do not write any test code before approval.** This rule has no
  exceptions; the curation step is the point of the skill.

### 5. Persist the approved plan

Write the approved checklist to a markdown file committed alongside the tests
(e.g. `docs/test-plans/<yyyy-mm-dd>-<topic>.md`, or the project's existing
docs location). Each entry keeps its ID and rationale, and notes which test
implements it. The plan is reviewable history, not chat scrollback.

### 6. Generate, wire up, run

- Implement exactly the approved cases, in the house style found in step 2,
  one test per checklist ID where practical (name or comment tests with
  their plan ID).
- Register the tests with the build/runner so they execute in CI or the
  project's normal test command.
- Run them. Report pass/fail per plan ID. A new regression test for an
  existing bug must be shown to fail before the fix / pass after.
- Keep tests deterministic: no wall-clock dependence, no network, fixed
  seeds, temp dirs cleaned up.

## Constraints

- Prefer invariants/round-trips over enumerated examples whenever both could
  catch the same class of bug.
- Never mark the plan complete with unimplemented approved cases — if
  something turned out infeasible, return to the developer and say so.
- If during generation you discover an untested risk not in the plan,
  propose a plan amendment — do not silently add or skip tests.
