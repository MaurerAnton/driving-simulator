// SPDX-License-Identifier: AGPL-3.0-only
// Headless screenshot helper for development:
//   node tools/dev/shot.mjs "<query string>" out.png [width] [height] [extraWaitMs]
// Needs a running dev/preview server (default http://127.0.0.1:5173) and a
// Chromium binary (CHROME_BIN, or the one Playwright cached).
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      for (const sub of readdirSync(join(cache, d))) {
        const p = join(cache, d, sub, 'chrome');
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('No Chromium found. Set CHROME_BIN or run: npx playwright install chromium');
}

const [query = '', out = 'shot.png', w = '1280', h = '720', extra = '500'] = process.argv.slice(2);
const base = process.env.FS_URL ?? 'http://127.0.0.1:5173/';
const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('response', (r) => {
  if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`);
});
page.on('requestfailed', (r) => logs.push(`[failed] ${r.url()} ${r.failure()?.errorText ?? ''}`));
const t0 = Date.now();
await page.goto(base + (query ? `?${query}` : ''), { waitUntil: 'domcontentloaded', timeout: 240000 });
try {
  await page.waitForFunction(() => window.__fs && window.__fs.ready === true, null, { timeout: Number(process.env.FS_TIMEOUT ?? 180000) });
} catch (e) {
  logs.push(`[shot] not ready: ${e.message.split('\n')[0]}`);
}
await page.waitForTimeout(Number(extra));
await page.screenshot({ path: out, timeout: 240000 });
const info = await page.evaluate(() => (window.__fs ? window.__fs.info() : null)).catch(() => null);
console.log(JSON.stringify({ ms: Date.now() - t0, info }));
for (const l of logs.slice(0, 40)) console.log(l);
await browser.close();
