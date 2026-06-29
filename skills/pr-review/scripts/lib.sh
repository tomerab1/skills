#!/usr/bin/env bash
# Shared helpers for the pr-review skill.
# Source this from the other scripts: source "$(dirname "$0")/lib.sh"
set -euo pipefail

PR_REVIEW_HOME="${PR_REVIEW_HOME:-$HOME/.pr-review}"
PR_REVIEW_WORK="$PR_REVIEW_HOME/work"        # clones live here
PR_REVIEW_OUT="$PR_REVIEW_HOME/reviews"      # markdown reports land here
PR_REVIEW_LOGS="$PR_REVIEW_HOME/logs"        # build/diff/server logs
PR_REVIEW_SHOTS="$PR_REVIEW_HOME/screenshots"
mkdir -p "$PR_REVIEW_WORK" "$PR_REVIEW_OUT" "$PR_REVIEW_LOGS" "$PR_REVIEW_SHOTS"

log() { printf '[pr-review] %s\n' "$*" >&2; }
die() { printf '[pr-review][ERROR] %s\n' "$*" >&2; exit 1; }

# Parse a GitHub PR reference into "OWNER REPO NUMBER".
# Accepts:  https://github.com/owner/repo/pull/123  (with optional ?/# suffix)
#           git@github.com:owner/repo/pull/123
#           owner/repo#123
parse_pr_url() {
  local url="$1" owner repo num
  url="${url%%\?*}"; url="${url%%#*}"; url="${url%/}"
  if [[ "$url" =~ github\.com[:/]+([^/]+)/([^/]+)/pull/([0-9]+) ]]; then
    owner="${BASH_REMATCH[1]}"; repo="${BASH_REMATCH[2]}"; num="${BASH_REMATCH[3]}"
  elif [[ "$1" =~ ^([^/]+)/([^/#]+)#([0-9]+)$ ]]; then
    owner="${BASH_REMATCH[1]}"; repo="${BASH_REMATCH[2]}"; num="${BASH_REMATCH[3]}"
  else
    die "Cannot parse PR reference: $1"
  fi
  printf '%s %s %s\n' "$owner" "$repo" "$num"
}
