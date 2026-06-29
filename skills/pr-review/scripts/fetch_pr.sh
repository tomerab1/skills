#!/usr/bin/env bash
# Fetch a GitHub PR: pull metadata, clone the repo, check out the PR head, compute the diff.
# Usage: fetch_pr.sh <github-pr-url>
# Output (stdout): a single JSON object describing the checkout. Logs go to stderr.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

URL="${1:?usage: fetch_pr.sh <github-pr-url>}"
read -r OWNER REPO NUM < <(parse_pr_url "$URL")
SLUG="${OWNER}-${REPO}-pr${NUM}"
DIR="$PR_REVIEW_WORK/$SLUG"
DIFF_FILE="$PR_REVIEW_LOGS/$SLUG.diff"
FILES_FILE="$PR_REVIEW_LOGS/$SLUG.files"

log "PR ${OWNER}/${REPO}#${NUM}"

META_JSON="$(gh pr view "$NUM" --repo "$OWNER/$REPO" \
  --json number,title,body,author,state,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,url,isCrossRepository,mergeable,labels \
  2>/dev/null)" || die "gh pr view failed for ${OWNER}/${REPO}#${NUM} (no access / private / wrong url?)"

# Clone or refresh.
if [[ -d "$DIR/.git" ]]; then
  log "reusing clone at $DIR"
  ( cd "$DIR" && git fetch --quiet --all --prune ) || log "warning: fetch failed; using existing state"
else
  log "cloning ${OWNER}/${REPO} ..."
  gh repo clone "$OWNER/$REPO" "$DIR" -- --quiet || die "git clone failed"
fi

# Check out the PR head (gh handles forks by adding the contributor's remote).
( cd "$DIR" && gh pr checkout "$NUM" >/dev/null 2>&1 ) \
  || ( cd "$DIR" && git fetch --quiet origin "pull/$NUM/head:pr-$NUM" && git checkout --quiet "pr-$NUM" ) \
  || die "could not check out PR #$NUM head"

BASE="$(jq -r '.baseRefName' <<<"$META_JSON")"
( cd "$DIR" && git fetch --quiet origin "$BASE" ) || true

# Compute the diff against the merge-base with the target branch.
( cd "$DIR"
  if git rev-parse --verify --quiet "origin/$BASE" >/dev/null; then
    git diff "origin/$BASE...HEAD" > "$DIFF_FILE" 2>/dev/null || : > "$DIFF_FILE"
    git diff --name-only "origin/$BASE...HEAD" > "$FILES_FILE" 2>/dev/null || : > "$FILES_FILE"
  else
    log "warning: origin/$BASE not found; diffing against HEAD~1"
    git diff "HEAD~1...HEAD" > "$DIFF_FILE" 2>/dev/null || : > "$DIFF_FILE"
    git diff --name-only "HEAD~1...HEAD" > "$FILES_FILE" 2>/dev/null || : > "$FILES_FILE"
  fi
)

DIFF_LINES="$(wc -l < "$DIFF_FILE" | tr -d ' ')"
log "checked out at $DIR — diff: $DIFF_LINES lines, $(wc -l < "$FILES_FILE" | tr -d ' ') files"

jq -n \
  --arg slug "$SLUG" --arg owner "$OWNER" --arg repo "$REPO" --arg num "$NUM" \
  --arg dir "$DIR" --arg diff "$DIFF_FILE" --arg files "$FILES_FILE" \
  --arg difflines "$DIFF_LINES" --argjson meta "$META_JSON" \
  '{slug:$slug, owner:$owner, repo:$repo, number:($num|tonumber),
    dir:$dir, diff_file:$diff, files_list:$files, diff_lines:($difflines|tonumber),
    meta:$meta}'
