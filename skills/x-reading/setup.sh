#!/usr/bin/env bash
# One-time setup for the x-reading skill:
#   1. ensure the ~/.x-reading runtime dir + package.json + config.json exist
#   2. install playwright-core (drives the system Google Chrome — no big browser download)
#   3. open Chrome HEADED so you can log into X once; the session is saved to the
#      dedicated profile at ~/.x-reading/chrome-profile and reused by every scheduled run.
set -euo pipefail

RUNTIME="$HOME/.x-reading"
SKILL_DIR="$HOME/.claude/skills/x-reading"
mkdir -p "$RUNTIME/chrome-profile"

# package.json
if [ ! -f "$RUNTIME/package.json" ]; then
  cat > "$RUNTIME/package.json" <<'JSON'
{
  "name": "x-reading-runtime",
  "private": true,
  "type": "module",
  "dependencies": { "playwright-core": "^1.49.0" }
}
JSON
fi

# config.json (placeholder listUrl — EDIT this to your X List URL)
if [ ! -f "$RUNTIME/config.json" ]; then
  cat > "$RUNTIME/config.json" <<'JSON'
{
  "listUrl": "https://x.com/i/lists/REPLACE_WITH_YOUR_LIST_ID",
  "scrolls": 10,
  "max": 60,
  "headless": true,
  "channel": "chrome"
}
JSON
  echo ">> Wrote $RUNTIME/config.json — set \"listUrl\" to your X List URL."
fi

echo ">> Installing playwright-core into $RUNTIME ..."
( cd "$RUNTIME" && npm install --no-audit --no-fund --silent )

echo ">> Opening Chrome for X login (headed). Log in fully, then come back."
node "$SKILL_DIR/scrape-x.mjs" --login

echo ">> Setup done."
echo "   - Edit $RUNTIME/config.json -> listUrl  (your X List)"
echo "   - Test:  node $SKILL_DIR/scrape-x.mjs | head"
echo "   - Schedule: pm2 start ~/.claude/x-reading.ecosystem.config.js && pm2 save"
