#!/usr/bin/env node
// scrape-x.mjs — drive a logged-in, dedicated Chrome profile via Playwright (playwright-core
// + the system Google Chrome), scroll an X List/timeline, and emit external article links
// found in tweets as JSON on stdout. All diagnostics go to stderr so stdout stays pure JSON.
//
// Modes:
//   node scrape-x.mjs --login      Open Chrome HEADED so you can log into X once. The session
//                                  is saved in the persistent profile and reused thereafter.
//   node scrape-x.mjs              Scrape (headless by default). Reads ~/.x-reading/config.json.
//
// Flags: --headed  --url=<override>  --scrolls=<n>  --max=<n>
//
// Exit codes: 0 ok | 2 NOT_LOGGED_IN (run --login) | 3 config/launch error.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const RUNTIME = path.join(HOME, '.x-reading');
const PROFILE = path.join(RUNTIME, 'chrome-profile');
const CONFIG_PATH = path.join(RUNTIME, 'config.json');

// playwright-core is installed in the runtime dir (~/.x-reading), not next to this script,
// so resolve the bare specifier from there instead of relative to this file's location.
const require = createRequire(path.join(RUNTIME, 'package.json'));
const { chromium } = require('playwright-core');

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

function parseArgs(argv) {
  const a = { login: false, headed: false };
  for (const tok of argv) {
    if (tok === '--login') a.login = true;
    else if (tok === '--headed') a.headed = true;
    else if (tok.startsWith('--url=')) a.url = tok.slice(6);
    else if (tok.startsWith('--scrolls=')) a.scrolls = Number(tok.slice(10));
    else if (tok.startsWith('--max=')) a.max = Number(tok.slice(6));
  }
  return a;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

// ---- in-page extraction: pull article links out of currently-rendered tweets ----------
function pageExtract() {
  const items = [];
  for (const art of document.querySelectorAll('article')) {
    const timeEl = art.querySelector('time');
    const statusA = timeEl ? timeEl.closest('a[href*="/status/"]') : null;
    const tweetUrl = statusA ? statusA.href : null;
    const time = timeEl ? timeEl.getAttribute('datetime') : null;

    let name = null, handle = null;
    const userBlock = art.querySelector('[data-testid="User-Name"]');
    if (userBlock) {
      const parts = userBlock.innerText.split('\n').map(s => s.trim()).filter(Boolean);
      name = parts[0] || null;
      handle = parts.find(s => s.startsWith('@')) || null;
    }

    const textEl = art.querySelector('[data-testid="tweetText"]');
    const text = textEl ? textEl.innerText : '';

    // Prefer the link card (summary_large_image / player cards) — that's an article share.
    let link = null;
    const card = art.querySelector('[data-testid="card.wrapper"]');
    if (card) {
      const a = card.querySelector('a[href]');
      if (a) {
        const spans = Array.from(card.querySelectorAll('span'))
          .map(s => s.innerText.trim()).filter(Boolean);
        const domain = spans.find(t => /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(t) && !t.includes(' ')) || null;
        const title = spans.filter(t => t !== domain).sort((x, y) => y.length - x.length)[0] || null;
        link = { tco: a.href, domain, title };
      }
    }
    // Fallback: a bare t.co link in the tweet body (X shortens every external URL to t.co).
    if (!link) {
      const a = Array.from(art.querySelectorAll('a[href*="t.co/"]'))
        .find(x => !/\/status\//.test(x.href));
      if (a) link = { tco: a.href, domain: a.innerText.trim() || null, title: null };
    }

    if (tweetUrl && link && link.tco) items.push({ tweetUrl, name, handle, time, text, link });
  }
  return items;
}

// ---- resolve t.co -> final URL (follow redirects), with small concurrency -------------
async function resolveAll(tcos) {
  const out = new Map();
  const queue = [...tcos];
  const SELF = /(^|\.)(x\.com|twitter\.com|t\.co)$/i;
  async function worker() {
    while (queue.length) {
      const tco = queue.shift();
      let finalUrl = tco, ok = false;
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 12000);
        const r = await fetch(tco, {
          method: 'GET', redirect: 'follow', signal: ctrl.signal,
          headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        });
        clearTimeout(to);
        finalUrl = r.url || tco;
        ok = true;
      } catch { /* keep tco */ }
      let domain = null;
      try { domain = new URL(finalUrl).hostname.replace(/^www\./, ''); } catch {}
      out.set(tco, { finalUrl, domain, ok, external: domain ? !SELF.test(domain) : false });
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, queue.length || 1) }, worker));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();

  const targetUrl = args.url || cfg.listUrl || 'https://x.com/home';
  const scrolls = Number.isFinite(args.scrolls) ? args.scrolls : (cfg.scrolls ?? 10);
  const maxItems = Number.isFinite(args.max) ? args.max : (cfg.max ?? 60);
  const headless = args.login ? false : (args.headed ? false : (cfg.headless ?? true));
  const channel = cfg.channel || 'chrome';

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE, {
      headless,
      channel,
      // For login use the natural window size (null) so scrolling/zoom behave like a real
      // browser; for scraping use a tall fixed viewport so more tweets render per scroll.
      viewport: args.login ? null : { width: 1280, height: 1900 },
      locale: 'en-US',
      timezoneId: 'Asia/Jerusalem',
      args: args.login
        ? ['--disable-blink-features=AutomationControlled', '--start-maximized']
        : ['--disable-blink-features=AutomationControlled'],
    });
  } catch (e) {
    log('LAUNCH_ERROR:', e.message);
    log('Is Google Chrome installed? channel=' + channel);
    process.exit(3);
  }

  const page = context.pages()[0] || await context.newPage();

  // ---- LOGIN MODE: open headed, poll for the auth_token session cookie, then persist. --
  // Cookie-based detection is robust: it doesn't depend on which page X lands you on, and
  // it survives X's frequent DOM/testid changes. As soon as auth_token exists, we're in.
  if (args.login) {
    log('Opening X. Log in fully IN THE WINDOW THAT JUST OPENED (not your normal browser).');
    log('Auto-detecting login (polling every 3s, up to 10 min)…');
    await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' }).catch(() => {});
    const deadline = Date.now() + 10 * 60 * 1000;
    let authed = false;
    while (Date.now() < deadline) {
      try { await page.waitForTimeout(3000); } catch { break; } // window closed
      let cookies = [];
      try { cookies = await context.cookies(); } catch { break; }
      if (cookies.some(c => c.name === 'auth_token' && c.value)) { authed = true; break; }
    }
    if (authed) {
      await page.waitForTimeout(1500).catch(() => {});
      log('LOGIN_OK — session saved to ' + PROFILE);
    } else {
      log('LOGIN_NOT_DETECTED — no auth_token cookie appeared (window closed or timed out before login completed).');
    }
    await context.close().catch(() => {});
    return;
  }

  // ---- SCRAPE MODE --------------------------------------------------------------------
  log(`Navigating: ${targetUrl} (headless=${headless}, scrolls=${scrolls})`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  // Logged-in check.
  const url = page.url();
  if (/\/(login|i\/flow\/login)/.test(url)) {
    log('NOT_LOGGED_IN — redirected to ' + url + '. Run: node scrape-x.mjs --login');
    await context.close();
    process.exit(2);
  }
  try {
    await page.waitForSelector('article, [data-testid="primaryColumn"]', { timeout: 30000 });
  } catch {
    log('NO_CONTENT — no tweets rendered (possible login wall or empty list).');
    await context.close();
    process.exit(2);
  }

  // Scroll, accumulating tweets across the virtualized DOM (offscreen ones get recycled).
  const byTweet = new Map();
  for (let i = 0; i <= scrolls; i++) {
    let batch = [];
    try { batch = await page.evaluate(pageExtract); } catch {}
    for (const it of batch) if (!byTweet.has(it.tweetUrl)) byTweet.set(it.tweetUrl, it);
    log(`  scroll ${i}/${scrolls} — ${byTweet.size} tweets-with-links so far`);
    if (byTweet.size >= maxItems) break;
    await page.mouse.wheel(0, 2200 + Math.floor(i % 3) * 400);
    await page.waitForTimeout(1600 + (i % 4) * 500);
  }

  const items = Array.from(byTweet.values());
  await context.close();

  // Resolve t.co links and keep only genuinely external ones; dedupe by final URL.
  const tcos = [...new Set(items.map(it => it.link.tco))];
  log(`Resolving ${tcos.length} t.co links…`);
  const resolved = await resolveAll(tcos);

  const seen = new Set();
  const out = [];
  for (const it of items) {
    const r = resolved.get(it.link.tco);
    if (!r || !r.external) continue;
    if (seen.has(r.finalUrl)) continue;
    seen.add(r.finalUrl);
    out.push({
      url: r.finalUrl,
      domain: r.domain,
      cardTitle: it.link.title || null,
      tweetUrl: it.tweetUrl,
      author: it.name,
      handle: it.handle,
      postedAt: it.time,
      tweetText: it.text,
    });
  }

  log(`Done: ${out.length} external article links from ${items.length} tweets.`);
  process.stdout.write(JSON.stringify({ source: targetUrl, count: out.length, items: out }, null, 2) + '\n');
}

main().catch((e) => { log('FATAL:', e.stack || e.message); process.exit(3); });
