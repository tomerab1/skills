---
name: debrief
description: "Rebuild comprehension of code that Claude/agents shipped for you — post-merge briefs, interactive HTML quizzes graded by Claude, and spaced repetition on weak concepts — so you can defend the work in reviews and interviews. Use after merging a feature you didn't fully read, before an interview/design review, for a weekly 'what did the loops ship', or to grade a completed quiz. Args: PR number, branch, commit range, ticket ID, 'last week', or --grade."
---

# debrief — pay down comprehension debt, fast

The loops ship more code than there's time to read. This skill produces (1) a **brief** at the
right altitude, (2) an **interactive HTML quiz** (free-text + MCQ) whose answers Claude grades
honestly, and (3) **spaced repetition** so weak concepts resurface. In-session only — no cron,
no metered calls.

## Files
- Briefs & quizzes: `~/debriefs/<repo>/<feature>-<date>.md` and `...-quiz.html` (create dirs).
- Spaced-repetition state: `~/debriefs/state.json` — `{concepts: {"<repo>/<concept-slug>": {ease, intervalDays, due, lastScore, feature}}}`.
- Quiz template: `quiz-template.html` in this skill dir — adapt it, don't reinvent.

## Mode — infer from `$ARGUMENTS`, don't ask
- Period ("last week", "since Monday") → **hygiene digest**: one skimmable file covering all merged
  work in the window; ≤1 page per feature; quiz optional (offer, don't force).
- Ticket / PR / branch → **pre-review brief**: full brief + quiz for that feature.
- Contains "interview" or "--deep" → **interview mode**: richest brief, hardest quiz, and pull
  due/weak concepts from state.json into the drill.
- `--grade` → skip to Grading below.
- Ambiguous → one AskUserQuestion, then proceed.

## Step 1 — Gather (be selective; files can be huge)
- `gh pr view/diff` / `git log --stat` for the range → identify the **5–9 files that matter**
  (core logic, models, entry points; skip lockfiles/generated). Read those only.
- **Transcript mining** (recovers decisions + rejected alternatives — the "why" diffs don't have):
  ASK per run via AskUserQuestion ("Mine CC transcripts for rationale? slower but richer") —
  sessions can be >100MB. If yes: `grep -l "<ticket-or-branch>" ~/.claude/projects/*/*.jsonl`,
  then stream ONLY user prompts + short assistant texts (never whole files):
  `node -e "const rl=require('readline').createInterface({input:require('fs').createReadStream(F)});rl.on('line',l=>{try{const j=JSON.parse(l);if(j.type==='user'&&typeof j.message?.content==='string'&&!j.message.content.startsWith('<'))console.log(j.message.content.slice(0,300))}catch{}})"

## Step 2 — Write the brief (`~/debriefs/<repo>/<feature>-<date>.md`)
Readable in 15 minutes (digest mode: 5). Structure:
1. **Elevator** — 3 sentences: what, for whom, how.
2. **Data flow** — one mermaid diagram.
3. **Files that matter** — 5–9 `path:line` anchors, one line each.
4. **Decisions & rejected alternatives** — from transcripts when mined; this is what interviews probe.
5. **Invariants & gotchas** — what must stay true; what will surprise a future editor; tech debt.
6. **Concept list** — 5–10 kebab-case concept slugs (used for quiz + spaced repetition).

## Step 3 — Generate the quiz (`...-quiz.html`)
Adapt `quiz-template.html` (self-contained, warm-dark theme — bg #1b1a16, coral #d97757,
Familjen Grotesk + Source Serif 4). Content:
- 6–10 questions per feature: mix **free-text** ("explain why the cache is keyed on
  sha256(line+lang)") and MCQ with plausible distractors. Free-text is the point — it trains
  articulation for interviews.
- Interview mode: also mix in 2–3 **due/weak concepts** from state.json (due <= today or
  lastScore < 0.6), labeled "review".
- Each question carries `data-concept="<slug>"`. Answers auto-save to
  `localStorage["debrief:v1:<quizId>"]` on input (quizId = `<repo>/<feature>-<date>`).
  A "Copy answers for Claude" button is the fallback submit path.
- Replace `{{CHANNEL_TOKEN}}` in the generated quiz with the contents of
  `~/debriefs/.channel-token` (create with 32 random hex chars if missing) — never commit
  the real token anywhere.
- Open it (`open <file>`), tell the user to fill it whenever — grading can happen days later.

## Grading
PRIMARY PATH — the debrief CHANNEL: quiz pages have a "Submit to Claude" button that POSTs to
the channel server (`channel/debrief-channel.mjs`, registered as user-scope MCP server
`debrief`, port 8789, token in `~/debriefs/.channel-token`). When the session runs with
`claude --dangerously-load-development-channels server:debrief`, submissions arrive as
`<channel source="debrief" kind="quiz_submission">` events — grade immediately and send the
report back via the channel's `reply` tool (it renders inside the quiz page).
Fallbacks (`/debrief --grade` or pasted JSON):
1. Get answers via claude-in-chrome (ToolSearch first): tabs_context to find the quiz tab, else
   open the quiz `file://` URL, then javascript_tool:
   `localStorage.getItem("debrief:v1:<quizId>")`. Or accept pasted JSON.
2. Grade free-text HONESTLY — right / partial / wrong, never soften; give the model answer for
   every miss. MCQ is mechanical.
3. Update `state.json` per concept (SM-2 lite): right → ease+0.1, interval×2 (start 2d);
   partial → interval unchanged; wrong → interval=1d, ease−0.2 (floor 1.3). Set `due`.
   Mark quizId graded.
4. Append `## Drill log — <date>` (scores + weak spots) to the feature's brief, and tell the
   user their 3 weakest concepts and when they're due for review.

## Rules
- Altitude over completeness: concepts, flows, decisions — not line-by-line narration.
- Grounded only: every claim anchored in the diff or a transcript quote; mark inferences.
- Never soften a grade — honest failure signal is the product.
- Briefs may contain private transcript-mined rationale: they live in ~/debriefs only, never
  inside a work repo.
- For flagship features, suggest (don't auto-run) `/explain-video` on the brief.
