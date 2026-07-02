#!/usr/bin/env node
// shot.mjs — headless screenshots of a rendered report, for visual verification.
// Reuses playwright-core + system Chrome from the x-reading runtime (no new install).
//   node shot.mjs [htmlPathOrUrl] [outDir]
// Writes desktop-top, desktop-mid, and mobile-top PNGs and prints their paths.
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(path.join(os.homedir(), '.x-reading', 'package.json'));
const { chromium } = require('playwright-core');

const target = process.argv[2] || path.join(os.homedir(), 'ai-radar', 'reports', 'latest.html');
const outDir = process.argv[3] || path.join(os.homedir(), 'ai-radar', 'reports');
const url = /^(https?:|file:)/.test(target) ? target : 'file://' + path.resolve(target);

const shots = [
  { name: 'desktop-top', width: 1280, scroll: 0 },
  { name: 'desktop-mid', width: 1280, scroll: 760 },
  { name: 'mobile-top',  width: 390,  scroll: 0 },
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const s of shots) {
    const page = await browser.newPage({ viewport: { width: s.width, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    if (s.scroll) { await page.evaluate(y => window.scrollTo(0, y), s.scroll); await page.waitForTimeout(300); }
    const out = path.join(outDir, `shot-${s.name}.png`);
    await page.screenshot({ path: out, fullPage: false });
    process.stdout.write(out + '\n');
    await page.close();
  }
} finally {
  await browser.close();
}
