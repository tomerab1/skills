#!/usr/bin/env bash
# Server test harness for the pr-review skill.
# Generic server startup is inherently repo-specific, so this script DETECTS how to run
# the service and gives helpers; the pr-server-tester agent runs the start command (so it
# can adapt from the README), then curls and tears down.
#
#   server_test.sh discover  <repo_dir>          # -> JSON: method, port, start_cmd hints
#   server_test.sh waitport  <port> [timeout=60] # block until something listens (or fail)
#   server_test.sh probe     <base_url>          # curl a few common health endpoints
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

CMD="${1:?usage: server_test.sh <discover|waitport|probe> ...}"; shift || true

discover() {
  local dir="${1:?dir}" method="unknown" start_cmd="" port="" compose dockerfile pkg
  compose="$(find "$dir" -maxdepth 2 \( -iname 'docker-compose*.y*ml' -o -iname 'compose.y*ml' \) -not -path '*/.git/*' 2>/dev/null | head -1)"
  [[ -f "$dir/Dockerfile" ]] && dockerfile="$dir/Dockerfile"
  [[ -f "$dir/package.json" ]] && pkg="$dir/package.json"

  if   [[ -n "${compose:-}" ]]; then method="docker-compose"; start_cmd="docker compose -f '$compose' up -d --build"
  elif [[ -f "$dir/manage.py" ]]; then method="django";       start_cmd="pip install -r requirements.txt && python manage.py migrate && python manage.py runserver 0.0.0.0:8000"
  elif [[ -n "${pkg:-}" ]]; then
       if   jq -e '.scripts.start' "$pkg" >/dev/null 2>&1; then method="node"; start_cmd="npm ci && npm run start"
       elif jq -e '.scripts.dev'   "$pkg" >/dev/null 2>&1; then method="node"; start_cmd="npm ci && npm run dev"
       elif jq -e '.scripts.serve' "$pkg" >/dev/null 2>&1; then method="node"; start_cmd="npm ci && npm run serve"; fi
  elif [[ -f "$dir/go.mod" ]]; then  method="go";             start_cmd="go run ./..."
  elif [[ -n "${dockerfile:-}" ]]; then method="docker";      start_cmd="docker build -t pr-review-img '$dir' && docker run -d -P pr-review-img"
  fi

  # Best-effort port guess (each substitution falls back to empty; never fails the script).
  if [[ -n "${dockerfile:-}" ]]; then
    port="$(grep -hoiE 'EXPOSE[[:space:]]+[0-9]+' "$dockerfile" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
  fi
  if [[ -z "$port" && -n "${compose:-}" ]]; then
    port="$(grep -oE '[0-9]+:[0-9]+' "$compose" 2>/dev/null | head -1 | cut -d: -f1 || true)"
  fi
  if [[ -z "$port" && "$method" == "django" ]]; then port="8000"; fi
  if [[ -z "$port" && "$method" == "node" ]]; then
    port="$(grep -rhoiE 'PORT[^0-9]{0,4}[0-9]{2,5}' "$dir" --include='*.env*' --include='*.js' --include='*.ts' 2>/dev/null | grep -oE '[0-9]{2,5}' | head -1 || true)"
  fi
  if [[ -z "$port" ]]; then port="3000"; fi

  jq -n --arg m "$method" --arg s "$start_cmd" --arg p "$port" \
        --arg compose "${compose:-}" --arg dockerfile "${dockerfile:-}" --arg pkg "${pkg:-}" \
        '{method:$m, start_cmd:$s, port:($p|tonumber), compose:$compose, dockerfile:$dockerfile, package_json:$pkg,
          note:"start_cmd is a heuristic guess; check README and adjust."}'
}

waitport() {
  local port="${1:?port}" timeout="${2:-60}" i=0
  log "waiting up to ${timeout}s for localhost:$port ..."
  while (( i < timeout )); do
    if nc -z localhost "$port" 2>/dev/null; then log "port $port is up"; return 0; fi
    sleep 1; i=$((i+1))
  done
  die "nothing listening on localhost:$port after ${timeout}s"
}

probe() {
  local base="${1:?base_url}" ep
  for ep in "/" "/health" "/healthz" "/api/health" "/status" "/ping" "/version"; do
    printf '\n### GET %s%s\n' "$base" "$ep" >&2
    curl -sS -m 10 -o - -w '\n[HTTP %{http_code}  %{time_total}s]\n' "$base$ep" 2>&1 | head -40 >&2 || true
  done
}

case "$CMD" in
  discover) discover "$@";;
  waitport) waitport "$@";;
  probe)    probe "$@";;
  *) die "unknown subcommand: $CMD";;
esac
