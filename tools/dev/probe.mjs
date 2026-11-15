// SPDX-License-Identifier: AGPL-3.0-only
// Development helper: load the page headlessly and print what a selector looks like.
//   node tools/dev/probe.mjs "<query string>" "<selector>" [width] [height]
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  for (const d of readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
    for (const sub of readdirSync(join(cache, d))) {
      const p = join(cache, d, sub, 'chrome');
      if (existsSync(p)) return p;
    }
  }
  throw new Error('No Chromium found');
}
const [query = '', selector = 'body', w = '480', h = '270'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const mobile = !!process.env.FS_MOBILE;
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, isMobile: mobile, hasTouch: mobile });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto((process.env.FS_URL ?? 'http://127.0.0.1:5173/') + (query ? `?${query}` : ''), { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction(() => window.__fs && window.__fs.ready === true, null, { timeout: Number(process.env.FS_TIMEOUT ?? 300000) }).catch(() => logs.push('[probe] not ready'));
await page.waitForTimeout(Number(process.env.FS_EXTRA ?? 1500));
const out = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => {
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  return { cls: e.className, text: (e.textContent ?? '').slice(0, 120), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], display: cs.display, opacity: cs.opacity, visibility: cs.visibility, bg: cs.backgroundColor, inline: e.getAttribute('style') };
}), selector);
console.log(JSON.stringify(out, null, 1));
for (const l of logs.filter((x) => !x.includes('useProgram')).slice(0, 20)) console.log(l);
await browser.close();
