#!/usr/bin/env node
// rn-devtools connector: attaches to a running React Native / Hermes app via Metro's
// CDP inspector proxy and streams Console + Network events to JSONL files.
// Zero dependencies — uses Node 22's built-in WebSocket + fetch.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const RUNTIME = path.join(import.meta.dirname, '.runtime');
fs.mkdirSync(RUNTIME, { recursive: true });
const P = (f) => path.join(RUNTIME, f);
const CONSOLE = P('console.jsonl');
const NETWORK = P('network.jsonl');
const STATE = P('state.json');
const LOG = P('connector.log');

const META_URL = process.env.METRO_URL || 'http://localhost:8081';
const CAPTURE_BODIES = process.env.CAPTURE_BODIES === '1';
const CONTROL_PORT = +(process.env.CONTROL_PORT || 8099);
const MAX_LINES = 20000;

let ws, idc = 0, reconnectDelay = 1000;
const pending = new Map();   // network requestId -> partial record
const replyWaiters = new Map(); // command id -> resolver (for getResponseBody)

const state = {
  connected: false, target: null, metro: META_URL, since: Date.now(),
  consoleCount: 0, networkCount: 0, lastEventTs: null, capturingBodies: CAPTURE_BODIES,
  controlPort: CONTROL_PORT, pid: process.pid,
};

function log(...a) { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${a.join(' ')}\n`); } catch {} }
function saveState() { try { fs.writeFileSync(STATE, JSON.stringify(state, null, 2)); } catch {} }
function append(file, obj) { try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch {} }
function trim(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) fs.writeFileSync(file, lines.slice(-MAX_LINES).join('\n') + '\n');
  } catch {}
}
setInterval(() => { trim(CONSOLE); trim(NETWORK); saveState(); }, 15000);

function fmtArg(a) {
  if (a == null) return 'null';
  if (a.value !== undefined) return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
  if (a.unserializableValue !== undefined) return String(a.unserializableValue);
  if (a.preview?.properties) {
    const props = a.preview.properties.map(p => `${p.name}: ${p.value}`).join(', ');
    return `${a.className || a.subtype || a.type}{ ${props}${a.preview.overflow ? ', …' : ''} }`;
  }
  return a.description || a.type || '';
}

async function discover() {
  const list = await (await fetch(META_URL + '/json/list')).json();
  return list.find(t => /bridgeless|hermes/i.test(t.description || '') && t.webSocketDebuggerUrl)
      || list.find(t => t.reactNative?.capabilities?.prefersFuseboxFrontend && t.webSocketDebuggerUrl)
      || list.find(t => t.webSocketDebuggerUrl);
}

const send = (method, params = {}) => { const id = ++idc; ws.send(JSON.stringify({ id, method, params })); return id; };

function getResponseBody(requestId) {
  return new Promise((resolve) => {
    const id = send('Network.getResponseBody', { requestId });
    replyWaiters.set(id, resolve);
    setTimeout(() => { replyWaiters.delete(id); resolve(null); }, 10000);
  });
}

async function finishNet(requestId, extra) {
  const r = pending.get(requestId); if (!r) return;
  pending.delete(requestId);
  Object.assign(r, extra);
  r.durationMs = Date.now() - r.startTs;
  if (CAPTURE_BODIES && !r.failed) {
    try {
      const b = await getResponseBody(requestId);
      if (b) {
        let text;
        if (b.base64Encoded) {
          const isText = /json|text|xml|javascript|urlencoded|csv/i.test(r.mimeType || '');
          text = isText ? Buffer.from(b.body, 'base64').toString('utf8') : `(binary ${r.mimeType || '?'} ${b.body.length}B base64)`;
        } else text = String(b.body);
        r.bodyTruncated = text.length > 1000000;
        r.body = text.slice(0, 1000000);
      }
    } catch {}
  }
  append(NETWORK, r);
  state.networkCount++;
}

function onMessage(ev) {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && replyWaiters.has(msg.id)) { replyWaiters.get(msg.id)(msg.result); replyWaiters.delete(msg.id); return; }
  if (!msg.method) return;
  state.lastEventTs = Date.now();
  const p = msg.params || {};
  switch (msg.method) {
    case 'Runtime.consoleAPICalled': {
      const frame = p.stackTrace?.callFrames?.[0];
      append(CONSOLE, {
        ts: p.timestamp ? Math.round(p.timestamp) : Date.now(),
        level: p.type,
        text: (p.args || []).map(fmtArg).join(' '),
        src: frame ? `${(frame.url || '').split('/').pop()}:${frame.lineNumber}` : undefined,
      });
      state.consoleCount++; break;
    }
    case 'Runtime.exceptionThrown': {
      const d = p.exceptionDetails || {};
      append(CONSOLE, {
        ts: Date.now(), level: 'error',
        text: d.exception?.description || d.text || 'exception',
        src: d.url ? `${d.url.split('/').pop()}:${d.lineNumber}` : undefined,
      });
      state.consoleCount++; break;
    }
    case 'Log.entryAdded': {
      const e = p.entry || {};
      append(CONSOLE, { ts: e.timestamp ? Math.round(e.timestamp) : Date.now(), level: e.level, text: e.text, src: e.url });
      state.consoleCount++; break;
    }
    case 'Network.requestWillBeSent':
      pending.set(p.requestId, {
        requestId: p.requestId, startTs: Date.now(),
        method: p.request?.method, url: p.request?.url,
        reqHeaders: p.request?.headers, postData: p.request?.postData?.slice?.(0, 4000),
        type: p.type,
      });
      break;
    case 'Network.responseReceived': {
      const r = pending.get(p.requestId);
      if (r) { r.status = p.response?.status; r.mimeType = p.response?.mimeType; r.resHeaders = p.response?.headers; }
      break;
    }
    case 'Network.loadingFinished':
      finishNet(p.requestId, { encodedDataLength: p.encodedDataLength }); break;
    case 'Network.loadingFailed':
      finishNet(p.requestId, { failed: true, errorText: p.errorText, canceled: p.canceled }); break;
  }
}

function runEval(expr) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) return resolve({ error: 'connector not attached to app' });
    const id = send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true });
    replyWaiters.set(id, (result) => resolve({ result }));
    setTimeout(() => { if (replyWaiters.has(id)) { replyWaiters.delete(id); resolve({ error: 'eval timeout' }); } }, 12000);
  });
}

// Local control channel so the CLI can eval over the connector's single session
// instead of opening a competing one (the RN inspector is single-client).
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/eval') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try { const { expr } = JSON.parse(body || '{}'); const r = await runEval(expr); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); }
      catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    });
  } else if (req.url === '/ping') { res.end('ok'); }
  else { res.writeHead(404); res.end(); }
}).listen(CONTROL_PORT, '127.0.0.1', () => log('control server on 127.0.0.1:' + CONTROL_PORT))
  .on('error', (e) => log('control server error:', e.message));

async function connect() {
  let target;
  try { target = await discover(); } catch (e) { log('discover failed:', e.message); }
  if (!target) { state.connected = false; saveState(); return setTimeout(connect, 2000); }
  state.target = `${target.title} — ${target.description}`;
  log('attaching to', state.target, target.webSocketDebuggerUrl);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('open', () => {
    state.connected = true; reconnectDelay = 1000; saveState();
    send('Runtime.enable'); send('Log.enable'); send('Network.enable');
    log('connected; domains enabled');
  });
  ws.addEventListener('message', onMessage);
  ws.addEventListener('error', (e) => log('ws error:', e.message || ''));
  ws.addEventListener('close', () => {
    state.connected = false; saveState();
    log('disconnected; reconnecting in', reconnectDelay, 'ms (app reload?)');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  });
}

process.on('SIGTERM', () => { saveState(); process.exit(0); });
process.on('SIGINT', () => { saveState(); process.exit(0); });
saveState();
connect();
