// SPDX-License-Identifier: AGPL-3.0-only
// A picture of one model from several sides (tools/dev/models.html), headless:
//   node tools/dev/modelshot.mjs <scene> out.png [views] [width] [height] [extra query]
// Needs a Vite dev server of this repository: MS_URL (default http://127.0.0.1:5181/).
// views: see tools/dev/models.ts (default 30:15:1.6,90:0:1.6,180:20:1.6,eye).
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

const [scene = 'plane', out = 'model.png', views = '', w = '1200', h = '900', extra = ''] = process.argv.slice(2);
const base = process.env.MS_URL ?? 'http://127.0.0.1:5181/';
const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const query = new URLSearchParams({ scene });
if (views) query.set('views', views);
for (const [k, v] of new URLSearchParams(extra)) query.set(k, v);
const t0 = Date.now();
await page.goto(`${base}tools/dev/models.html?${query}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: Number(process.env.MS_TIMEOUT ?? 300000) });
const error = await page.evaluate(() => window.__error ?? null);
await page.screenshot({ path: out, timeout: 0 });
await browser.close();
for (const l of logs.filter((l) => !l.includes('[vite]'))) console.log(l);
if (error) console.log(`[error] ${error}`);
console.log(`[modelshot] ${out} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
