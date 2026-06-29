#!/usr/bin/env bash
# Heuristically classify what a PR touches: native (iOS) and/or server, plus stack hints.
# Usage: classify.sh <repo_dir> [changed_files_list]
# Output (stdout): JSON. The agent makes the final call; this is signal, not gospel.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

DIR="${1:?usage: classify.sh <repo_dir> [changed_files_list]}"
FILES="${2:-}"

changed=""
[[ -n "$FILES" && -f "$FILES" ]] && changed="$(cat "$FILES")"
changed_has() { [[ -n "$changed" ]] && grep -qiE "$1" <<<"$changed"; }
repo_has() { find "$DIR" -maxdepth 3 \( -path '*/.git' -o -path '*/Pods' -o -path '*/node_modules' \) -prune -o -iname "$1" -print 2>/dev/null | grep -q .; }

# ---- iOS / native ----
ios=false; ios_reason="no iOS files in diff"
if changed_has '\.(swift|m|mm|h|storyboard|xib)$|\.pbxproj|\.xcassets|Info\.plist|Podfile|Package\.swift|\.xcodeproj|\.xcworkspace'; then
  ios=true; ios_reason="diff touches iOS/Swift files"
elif repo_has '*.xcodeproj' || repo_has '*.xcworkspace'; then
  ios_reason="repo is an Xcode project but diff is elsewhere"
fi
podfile=false;  [[ -f "$DIR/Podfile" ]] && podfile=true
spm=false;      find "$DIR" -maxdepth 2 -name 'Package.swift' -not -path '*/.git/*' 2>/dev/null | grep -q . && spm=true

# ---- server / back-end ----
server=false; server_reason="no server files in diff"
if changed_has 'Dockerfile|docker-compose|compose\.ya?ml|\.(go|py|rb|java|kt|rs|php)$|(^|/)(src|api|routes?|controllers?|handlers?|server)/|requirements\.txt|go\.mod|pom\.xml|build\.gradle|\.proto$|openapi|swagger|\.(ts|js)$'; then
  server=true; server_reason="diff touches server/back-end files"
fi
dockerfile=false; [[ -f "$DIR/Dockerfile" ]] && dockerfile=true
compose="$(find "$DIR" -maxdepth 2 \( -iname 'docker-compose*.y*ml' -o -iname 'compose.y*ml' \) -not -path '*/.git/*' 2>/dev/null | head -1)"
pkg=false; [[ -f "$DIR/package.json" ]] && pkg=true

langs=()
[[ -f "$DIR/go.mod" ]] && langs+=(go)
[[ -f "$DIR/requirements.txt" || -f "$DIR/pyproject.toml" || -f "$DIR/manage.py" ]] && langs+=(python)
[[ -f "$DIR/package.json" ]] && langs+=(node)
[[ -f "$DIR/Gemfile" ]] && langs+=(ruby)
[[ -f "$DIR/pom.xml" || -f "$DIR/build.gradle" ]] && langs+=(jvm)
[[ -f "$DIR/Cargo.toml" ]] && langs+=(rust)
lang_hints="$(printf '%s\n' "${langs[@]:-}" | jq -R . | jq -cs 'map(select(length>0))')"

kinds="$(jq -cn --argjson i $ios --argjson s $server '[ (if $i then "native" else empty end), (if $s then "server" else empty end) ]')"

jq -n \
  --argjson kinds "$kinds" \
  --argjson ios $ios --arg ios_reason "$ios_reason" --argjson podfile $podfile --argjson spm $spm \
  --argjson server $server --arg server_reason "$server_reason" \
  --argjson dockerfile $dockerfile --arg compose "${compose:-}" --argjson pkg $pkg --argjson langs "$lang_hints" \
  '{kinds:$kinds,
    ios:    {detected:$ios, reason:$ios_reason, podfile:$podfile, spm:$spm},
    server: {detected:$server, reason:$server_reason, dockerfile:$dockerfile, compose:$compose, package_json:$pkg, lang_hints:$langs}}'
