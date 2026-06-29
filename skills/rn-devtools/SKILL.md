---
name: rn-devtools
description: Console + Network "DevTools" for a running React Native / Hermes app on the iOS Simulator, driven from the terminal. Attaches to Metro's CDP inspector and streams console logs + network requests to queryable buffers, plus live eval in the app's JS context. Use when debugging the native app — "why is this request failing", "what's logging", "what's the error", "inspect a global".
---

# rn-devtools

Gives Claude the Chrome-DevTools experience (Console tab, Network tab, console prompt)
for a **React Native app running on Hermes**, by attaching to Metro's built-in CDP
inspector proxy. Zero dependencies — pure Node 22 (`WebSocket`/`fetch`). No proxy, no
cert, no Flipper.

App at work: `io.singit.app` (Expo / expo-router, Hermes, Bridgeless/fusebox).

## Prerequisites
- Metro running (`http://localhost:8081`) and the app open on the iOS Simulator.
  Verify: `curl -s http://localhost:8081/json/list | jq '.[].title'` should list the app.
- A booted simulator with the app foregrounded (so it's a debuggable target).

## Commands (run from this skill dir)
```
node devtools.mjs start [--bodies] [--metro URL]   # attach + begin capturing (idempotent)
node devtools.mjs status                           # connected? counts? last event?
node devtools.mjs console [--grep RE] [--level error|warn] [--since 2m] [--tail N]
node devtools.mjs net [--grep RE] [--status '>=400'] [--host H] [--method GET] [--failed] [--since 2m] [--tail N] [--body]
node devtools.mjs eval "<js>"                       # run JS in the app's global context
node devtools.mjs clear                            # empty local buffers
node devtools.mjs stop                             # detach
```
`--bodies` makes the connector best-effort capture response bodies (off by default; can be
large/sensitive). `--since` accepts `30s` / `5m` / `1h`. `--status` accepts `>=400`, `404`, `<300`, etc.

## Typical workflow for Claude
1. `node devtools.mjs start` then `node devtools.mjs status` (confirm `attached: yes`).
2. Ask the user to reproduce the bug in the app (or drive the UI via Maestro / the
   `ios-scenario-runner` agent).
3. Inspect:
   - Failing API call? `node devtools.mjs net --failed --since 2m` (add `--host api...` / `--body`).
   - Errors/warnings? `node devtools.mjs console --level error --since 2m`
   - Specific thing? `... console --grep "checkout"` / `... net --grep "/cart"`
4. Probe state live: `node devtools.mjs eval "<expr>"`.
5. `node devtools.mjs stop` when done (on-demand; nothing is left running/scheduled).

## Hard-won constraints (important)
- **Single debugger client.** The RN/fusebox inspector serves ONE session at a time. The
  connector holds it. Do NOT also open React Native DevTools / Chrome `chrome://inspect`
  while the connector runs — they'll fight and bump each other. `eval` is safe: it routes
  THROUGH the connector via a local control server (127.0.0.1:8099), it does not open a
  second session.
- **`eval` runs in GLOBAL scope.** `require('react-native')` and module-scoped vars are not
  reachable. Works: `__DEV__`, `globalThis.*`, anything the app assigns to `global`, pure JS.
  To inspect app modules, have the app expose them on `global` in dev.
- **`eval` does not await promises** (Hermes ignores CDP `awaitPromise`). Async results come
  back as a raw Promise. Workaround: `eval "globalThis.__x=undefined; somePromise.then(v=>globalThis.__x=v)"`
  then read `eval "globalThis.__x"` a moment later.
- **Console history is replayed** by Metro on attach, so old entries (with their original
  timestamps) appear after `start`/`clear`. Use `--since` to focus on the repro window.
- The app is chatty (Expo Router warnings); default queries `--tail 50`. Lean on
  `--grep` / `--level` / `--since`.

## How it works
`connector.mjs` finds the Hermes/Bridgeless target in `GET /json/list`, opens its
`webSocketDebuggerUrl`, enables `Runtime` + `Log` + `Network`, and appends events to
`.runtime/console.jsonl` and `.runtime/network.jsonl` (network requestIds correlated into
complete records with status/timing/size). `devtools.mjs` is a thin reader/launcher over
those files plus the eval control channel. State lives in `.runtime/state.json`.

## Future options (not built)
- Graduate to a real MCP server exposing `read_console` / `read_network` / `eval` as tools.
- Android (`adb logcat` + CDP via the same Metro inspector).
- mitmproxy fallback if you ever debug a non-Hermes / pure-native build (network via proxy).
