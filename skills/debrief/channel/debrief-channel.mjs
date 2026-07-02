#!/usr/bin/env node
// debrief-channel.mjs — Claude Code CHANNEL for /debrief quizzes.
// Quiz pages POST answers to :8789 → pushed into the running session as a channel event →
// Claude grades per the debrief skill → calls the `reply` tool → grade streams back to the
// quiz page over SSE. Localhost-only + shared-token gate (~/debriefs/.channel-token).
// Run via: claude --dangerously-load-development-channels server:debrief
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 8789;
const TOKEN = fs.readFileSync(path.join(os.homedir(), 'debriefs', '.channel-token'), 'utf8').trim();

// SSE listeners, each tagged with the quiz_id it watches
const listeners = new Set(); // { quizId, res }
function broadcast(quizId, text) {
  const payload = 'data: ' + JSON.stringify({ quizId, text }) + '\n\n';
  for (const l of listeners) if (!l.quizId || l.quizId === quizId) l.res.write(payload);
}

const mcp = new Server(
  { name: 'debrief', version: '1.0.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions:
      'Events from the debrief channel are quiz submissions: <channel source="debrief" kind="quiz_submission" quiz_id="...">JSON with questions+answers</channel>. ' +
      'Handle per the debrief skill: grade each answer HONESTLY (right/partial/wrong, model answer for every miss — never soften), ' +
      'update ~/debriefs/state.json (SM-2 lite: right ease+0.1 interval×2 start 2d; partial interval unchanged; wrong interval=1d ease−0.2 floor 1.3; set due; mark quizId graded), ' +
      'append "## Drill log — <date>" to the feature brief in ~/debriefs/<repo>/, ' +
      'then call the debrief reply tool with the quiz_id and a compact markdown grade report (per-question verdict + one-line model answers + 3 weakest concepts). The report renders inside the quiz page.',
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send the grade report back to the debrief quiz page',
    inputSchema: {
      type: 'object',
      properties: {
        quiz_id: { type: 'string', description: 'quiz_id from the channel event' },
        text: { type: 'string', description: 'Markdown grade report to render in the page' },
      },
      required: ['quiz_id', 'text'],
    },
  }],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const { quiz_id, text } = req.params.arguments;
    broadcast(quiz_id, text);
    return { content: [{ type: 'text', text: 'delivered to quiz page' }] };
  }
  throw new Error('unknown tool: ' + req.params.name);
});

await mcp.connect(new StdioServerTransport());

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  // file:// pages have Origin "null" — allow all; the token is the real gate
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Debrief-Token');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const l = { quizId: url.searchParams.get('quiz_id') || null, res };
    listeners.add(l);
    req.on('close', () => listeners.delete(l));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/submit') {
    // gate: shared token embedded in quiz pages (sender check per channel docs)
    if ((req.headers['x-debrief-token'] || url.searchParams.get('token')) !== TOKEN) {
      res.writeHead(403); return res.end('forbidden');
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let quizId = 'unknown';
    try { quizId = JSON.parse(body).quizId || 'unknown'; } catch { /* pass raw */ }
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: body, meta: { kind: 'quiz_submission', quiz_id: quizId } },
    });
    res.writeHead(200); return res.end('submitted');
  }

  res.writeHead(404); res.end('not found');
}).listen(PORT, '127.0.0.1');
