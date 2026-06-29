#!/usr/bin/env bash
# iOS simulator test harness for the pr-review skill.
# Subcommands give the pr-ios-tester agent reliable building blocks; the agent drives
# the actual UI interaction with `idb` against the booted UDID this prints.
#
#   ios_test.sh discover  <repo_dir>
#   ios_test.sh prepare   <repo_dir>                         # pod install if needed
#   ios_test.sh build     <flag> <container> <scheme> <dd>   # flag = -workspace|-project
#   ios_test.sh boot                                         # -> prints booted UDID
#   ios_test.sh run       <app_path>                         # install+launch -> {udid,bundle_id}
#   ios_test.sh screenshot <udid> <out.png>
#   ios_test.sh idb_connect <udid>                           # make sim visible to idb
#
# Sim defaults to "iPhone 16 Pro"; override with PR_REVIEW_SIM.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SIM_NAME="${PR_REVIEW_SIM:-iPhone 16 Pro}"
CMD="${1:?usage: ios_test.sh <discover|prepare|build|boot|run|screenshot|idb_connect> ...}"; shift || true

_sim_udid() {
  xcrun simctl list devices available --json \
    | jq -r --arg n "$SIM_NAME" '.devices|to_entries[].value[]|select(.name==$n)|.udid' | head -1
}

discover() {
  local dir="${1:?dir}" ws proj cf container schemes
  ws="$(find "$dir" -maxdepth 3 -name '*.xcworkspace' -not -path '*/.git/*' -not -path '*/Pods/*' 2>/dev/null | head -1)"
  proj="$(find "$dir" -maxdepth 3 -name '*.xcodeproj' -not -path '*/.git/*' 2>/dev/null | head -1)"
  if   [[ -n "$ws"   ]]; then cf="-workspace"; container="$ws"
  elif [[ -n "$proj" ]]; then cf="-project";   container="$proj"
  else die "no .xcworkspace or .xcodeproj found under $dir"; fi
  schemes="$(xcodebuild -list -json $cf "$container" 2>/dev/null \
    | jq -c '(.workspace.schemes // .project.schemes // [])')" || schemes='[]'
  local podfile=false spm=false
  [[ -f "$dir/Podfile" ]] && podfile=true
  find "$dir" -maxdepth 2 -name 'Package.swift' -not -path '*/.git/*' 2>/dev/null | grep -q . && spm=true
  jq -n --arg ws "$ws" --arg proj "$proj" --arg cf "$cf" --arg c "$container" \
        --argjson schemes "$schemes" --argjson podfile $podfile --argjson spm $spm --arg sim "$SIM_NAME" \
        '{workspace:$ws, project:$proj, container_flag:$cf, container:$c, schemes:$schemes, podfile:$podfile, spm:$spm, simulator:$sim}'
}

prepare() {
  local dir="${1:?dir}"
  if [[ -f "$dir/Podfile" ]]; then
    log "pod install (this can take a while)..."
    ( cd "$dir" && { pod install --silent || pod install; } ) >"$PR_REVIEW_LOGS/pod.log" 2>&1 \
      || die "pod install failed — see $PR_REVIEW_LOGS/pod.log"
  fi
  log "prepare complete"
}

build() {
  local cf="${1:?flag}" container="${2:?container}" scheme="${3:?scheme}" dd="${4:?derivedData}"
  local blog="$PR_REVIEW_LOGS/xcodebuild-$(basename "$scheme").log"
  log "xcodebuild '$scheme' for '$SIM_NAME' (signing disabled)..."
  set +e
  xcodebuild $cf "$container" -scheme "$scheme" \
    -sdk iphonesimulator -configuration Debug \
    -destination "platform=iOS Simulator,name=$SIM_NAME" \
    -derivedDataPath "$dd" \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
    build >"$blog" 2>&1
  local rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    log "build FAILED (rc=$rc). Last lines:"; tail -50 "$blog" >&2
    die "build failed; full log: $blog"
  fi
  local app
  app="$(find "$dd/Build/Products" -maxdepth 2 -name '*.app' -path '*iphonesimulator*' 2>/dev/null | head -1)"
  [[ -z "$app" ]] && app="$(find "$dd/Build/Products" -maxdepth 2 -name '*.app' 2>/dev/null | head -1)"
  [[ -z "$app" ]] && die "build succeeded but no .app produced under $dd/Build/Products"
  log "built: $app (log: $blog)"
  printf '%s\n' "$app"
}

boot() {
  local udid; udid="$(_sim_udid)"
  [[ -z "$udid" ]] && die "simulator '$SIM_NAME' not found (xcrun simctl list devices)"
  local state
  state="$(xcrun simctl list devices --json | jq -r --arg u "$udid" '.devices|to_entries[].value[]|select(.udid==$u)|.state')"
  [[ "$state" != "Booted" ]] && xcrun simctl boot "$udid"
  open -a Simulator >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || true
  log "simulator booted: $udid"
  printf '%s\n' "$udid"
}

run() {
  local app="${1:?app path}" udid bundle
  udid="$(boot)"
  bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist" 2>/dev/null \
           || plutil -extract CFBundleIdentifier raw "$app/Info.plist")"
  [[ -z "$bundle" ]] && die "could not read CFBundleIdentifier from $app/Info.plist"
  xcrun simctl install "$udid" "$app"
  xcrun simctl launch "$udid" "$bundle" >/dev/null
  log "installed + launched $bundle on $udid"
  jq -n --arg u "$udid" --arg b "$bundle" --arg a "$app" '{udid:$u, bundle_id:$b, app:$a}'
}

screenshot() {
  local udid="${1:?udid}" out="${2:?out.png}"
  xcrun simctl io "$udid" screenshot "$out" >/dev/null 2>&1 || die "screenshot failed"
  printf '%s\n' "$out"
}

# Make a booted simulator addressable by idb (so `idb ui tap/swipe/text` work).
idb_connect() {
  local udid="${1:?udid}"
  idb connect "$udid" >/dev/null 2>&1 || idb_companion --udid "$udid" >/dev/null 2>&1 &
  idb list-targets 2>/dev/null | grep -i "$udid" >&2 || log "idb may need a moment; retry 'idb ui describe-all --udid $udid'"
  log "idb ready for $udid  (e.g. idb ui tap 200 400 --udid $udid)"
}

case "$CMD" in
  discover)    discover "$@";;
  prepare)     prepare "$@";;
  build)       build "$@";;
  boot)        boot "$@";;
  run)         run "$@";;
  screenshot)  screenshot "$@";;
  idb_connect) idb_connect "$@";;
  *) die "unknown subcommand: $CMD";;
esac
