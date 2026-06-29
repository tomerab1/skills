#!/usr/bin/env node
// rn-devtools CLI: start/stop the connector and query the captured Console + Network
// buffers, or eval JS live in the running app. Zero deps (Node 22 WebSocket/fetch).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DIR = import.meta.dirname;
const RUNTIME = path.join(DIR, '.runtime');
fs.mkdirSync(RUNTIME, { recursive: true });
const P = (f) => path.join(RUNTIME, f);
const META_URL = process.env.METRO_URL || 'http://localhost:8081';

// ---- arg parsing -----------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {}; const pos = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; flags[k] = v; }
  else pos.push(a);
}

// ---- helpers ---------------------------------------------------------------
const readPid = () => { try { return +fs.readFileSync(P('connector.pid'), 'utf8'); } catch { return 0; } };
const isAlive = (pid = readPid()) => { try { process.kill(pid, 0); return !!pid; } catch { return false; } };
const readState = () => { try { return JSON.parse(fs.readFileSync(P('state.json'), 'utf8')); } catch { return null; } };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const tfmt = (ts) => { try { return new Date(ts).toISOString().slice(11, 23); } catch { return '????'; } };
const pad = (s, n = 7) => String(s || '').padEnd(n).slice(0, n);
function sinceTs(d) { if (!d || d === true) return 0; const m = /^(\d+)(s|m|h)$/.exec(d); if (!m) return 0; return Date.now() - (+m[1]) * ({ s: 1e3, m: 6e4, h: 36e5 }[m[2]]); }
function statusMatch(expr, status) {
  if (status == null) return false;
  const m = /^(>=|<=|>|<|=)?\s*(\d+)$/.exec(String(expr).trim());
  if (!m) return false; const op = m[1] || '='; const n = +m[2];
  return { '>=': status >= n, '<=': status <= n, '>': status > n, '<': status < n, '=': status === n }[op];
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function discover() {
  const list = await (await fetch(META_URL + '/json/list')).json();
  return list.find(t => /bridgeless|hermes/i.test(t.description || '') && t.webSocketDebuggerUrl)
      || list.find(t => t.reactNative?.capabilities?.prefersFuseboxFrontend && t.webSocketDebuggerUrl)
      || list.find(t => t.webSocketDebuggerUrl);
}

// ---- commands --------------------------------------------------------------
async function main() {
  switch (cmd) {
    case 'start': {
      if (isAlive()) { console.log(`connector already running (pid ${readPid()})`); break; }
      const env = { ...process.env };
      if (flags.bodies) env.CAPTURE_BODIES = '1';
      if (flags.metro) env.METRO_URL = flags.metro;
      const out = fs.openSync(P('connector.log'), 'a');
      const child = spawn(process.execPath, [path.join(DIR, 'connector.mjs')], { detached: true, stdio: ['ignore', out, out], env });
      fs.writeFileSync(P('connector.pid'), String(child.pid));
      child.unref();
      console.log(`started connector (pid ${child.pid})${flags.bodies ? ' with body capture' : ''}`);
      console.log('give it ~1s, then: node devtools.mjs status');
      break;
    }
    case 'stop': {
      const pid = readPid();
      if (isAlive(pid)) { process.kill(pid, 'SIGTERM'); console.log(`stopped connector (pid ${pid})`); }
      else console.log('connector not running');
      break;
    }
    case 'status': {
      const st = readState(); const alive = isAlive();
      console.log(`connector:  ${alive ? 'running (pid ' + readPid() + ')' : 'NOT running'}`);
      if (st) {
        console.log(`attached:   ${st.connected ? 'yes' : 'no'} ${st.target ? '→ ' + st.target : ''}`);
        console.log(`metro:      ${st.metro}`);
        console.log(`captured:   ${st.consoleCount} console · ${st.networkCount} network${st.capturingBodies ? ' (bodies on)' : ''}`);
        console.log(`last event: ${st.lastEventTs ? tfmt(st.lastEventTs) + ' (' + Math.round((Date.now() - st.lastEventTs) / 1000) + 's ago)' : 'none yet'}`);
      }
      break;
    }
    case 'console': {
      let rows = readLines(P('console.jsonl'));
      const since = sinceTs(flags.since); if (since) rows = rows.filter(r => r.ts >= since);
      if (flags.level) { const map = { error: ['error'], warn: ['warning', 'warn'], warning: ['warning', 'warn'], info: ['info', 'log'] }; const allow = map[flags.level] || [flags.level]; rows = rows.filter(r => allow.includes(r.level)); }
      if (flags.grep) { const re = new RegExp(flags.grep, 'i'); rows = rows.filter(r => re.test(r.text || '')); }
      rows = rows.slice(-(+(flags.tail || 50)));
      if (!rows.length) { console.log('(no matching console events)'); break; }
      for (const r of rows) console.log(`${tfmt(r.ts)} ${pad(r.level)} ${(r.text || '').split('\n')[0].slice(0, 400)}${r.src ? '  (' + r.src + ')' : ''}`);
      break;
    }
    case 'net': {
      let rows = readLines(P('network.jsonl'));
      const since = sinceTs(flags.since); if (since) rows = rows.filter(r => r.startTs >= since);
      if (flags.host) rows = rows.filter(r => (r.url || '').includes(flags.host));
      if (flags.method) rows = rows.filter(r => (r.method || '').toUpperCase() === String(flags.method).toUpperCase());
      if (flags.failed) rows = rows.filter(r => r.failed || (r.status >= 400));
      if (flags.status) rows = rows.filter(r => statusMatch(flags.status, r.status));
      if (flags.grep) { const re = new RegExp(flags.grep, 'i'); rows = rows.filter(r => re.test(r.url || '')); }
      rows = rows.slice(-(+(flags.tail || 50)));
      if (!rows.length) { console.log('(no matching network requests)'); break; }
      for (const r of rows) {
        const code = r.failed ? 'ERR' : (r.status ?? '---');
        const size = r.encodedDataLength != null ? (r.encodedDataLength < 1024 ? r.encodedDataLength + 'B' : Math.round(r.encodedDataLength / 1024) + 'K') : '-';
        console.log(`${tfmt(r.startTs)} ${pad(r.method, 5)} ${pad(code, 4)} ${pad(r.durationMs + 'ms', 7)} ${pad(size, 6)} ${r.url}${r.errorText ? '  !' + r.errorText : ''}`);
        if (flags.body && r.body) console.log('    body: ' + r.body.replace(/\n/g, '\n    '));
      }
      break;
    }
    case 'eval': {
      const expr = (flags.expr && flags.expr !== true) ? flags.expr : pos.join(' ');
      if (!expr) { console.log('usage: eval "<js expression>"'); break; }
      const st = readState();
      let r;
      if (isAlive() && st?.controlPort) {
        // Route through the connector's existing session (avoids bumping it).
        try {
          const resp = await fetch(`http://127.0.0.1:${st.controlPort}/eval`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expr }) });
          const j = await resp.json();
          if (j.error) { console.log('Error:', j.error); break; }
          r = j.result || {};
        } catch (e) { console.log('control channel failed:', e.message); break; }
      } else {
        // No connector running: one-shot direct session (this would bump any other debugger).
        const target = await discover();
        if (!target) { console.log('no debuggable target (is Metro running and the app open?)'); break; }
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true } }));
        const m = await new Promise((res) => ws.addEventListener('message', (ev) => { const d = JSON.parse(ev.data); if (d.id === 1) res(d); }));
        ws.close();
        r = m.result || {};
      }
      if (r.exceptionDetails) console.log('Error:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      else { const v = r.result?.value; console.log(v !== undefined ? (typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)) : (r.result?.description ?? 'undefined')); }
      break;
    }
    case 'wait': {
      const m = (flags.match && flags.match !== true) ? flags.match : pos.join('|');
      if (!m) { console.log('usage: wait --match "<url-regex>" [--timeout 600]'); break; }
      const re = new RegExp(m, 'i');
      const deadline = Date.now() + (+(flags.timeout || 600)) * 1000;
      const ignore = new Set(readLines(P('network.jsonl')).map(r => r.requestId)); // only catch NEW ones
      console.log(`waiting for a request matching /${m}/i (timeout ${(deadline - Date.now()) / 1000}s)…`);
      while (Date.now() < deadline) {
        const hit = readLines(P('network.jsonl')).find(r => !ignore.has(r.requestId) && re.test(r.url || ''));
        if (hit) {
          const out = P(`capture-${hit.requestId}.json`);
          if (typeof hit.body === 'string') { try { fs.writeFileSync(out, hit.body); } catch {} }
          console.log(`\nMATCH  ${hit.method} ${hit.url}`);
          console.log(`status ${hit.status}  ${hit.durationMs}ms  ${hit.encodedDataLength}B wire  bodyTruncated=${hit.bodyTruncated || false}`);
          if (hit.postData) console.log(`reqPayload: ${String(hit.postData).slice(0, 600)}`);
          console.log(`body saved: ${out}  (${(hit.body || '').length} chars)`);
          return;
        }
        await sleep(500);
      }
      console.log(`timeout: no request matching /${m}/i appeared`);
      break;
    }
    case 'clear': {
      for (const f of ['console.jsonl', 'network.jsonl']) { try { fs.writeFileSync(P(f), ''); } catch {} }
      console.log('buffers cleared');
      break;
    }
    default:
      console.log(`rn-devtools — DevTools console/network for a running RN/Hermes app

  node devtools.mjs start [--bodies] [--metro http://host:port]   attach & begin capturing
  node devtools.mjs status                                        connection + counts
  node devtools.mjs console [--grep RE] [--level error|warn] [--since 2m] [--tail N]
  node devtools.mjs net [--grep RE] [--status '>=400'] [--host H] [--method GET] [--failed] [--since 2m] [--tail N] [--body]
  node devtools.mjs eval "<js>"                                   run JS in the app's context
  node devtools.mjs clear                                         empty the buffers
  node devtools.mjs stop                                          detach`);
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
