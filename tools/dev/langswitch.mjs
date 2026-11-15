// SPDX-License-Identifier: AGPL-3.0-only
// Development helper: switch the language in the main menu of a running build and
// print what the page shows afterwards (texts fetched on demand, writing direction).
//   node tools/dev/langswitch.mjs uk fa de
// Environment: FS_URL (default http://127.0.0.1:5173/), FS_TIMEOUT (ms), CHROME_BIN.
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

const langs = process.argv.slice(2);
const base = process.env.FS_URL ?? 'http://127.0.0.1:5173/';
const timeout = Number(process.env.FS_TIMEOUT ?? 600000);
const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 }, locale: 'en-GB' });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text());
});
page.on('pageerror', (e) => problems.push(String(e)));
const chunks = [];
page.on('response', (r) => {
  const m = /\/assets\/([a-z]{2})-[\w-]+\.js$/.exec(r.url());
  if (m) chunks.push(`${m[1]}:${r.status()}`);
});
await page.goto(`${base}?quality=low&traffic=0`, { waitUntil: 'domcontentloaded', timeout });
await page.waitForSelector('.panel select.lang', { timeout });
const state = () =>
  page.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.getElementById('ui')?.dir,
    title: document.title,
    picker: document.querySelector('.panel select.lang')?.value,
    options: document.querySelectorAll('.panel select.lang option').length,
    heading: document.querySelector('.panel h2')?.textContent,
    firstCard: document.querySelector('.panel .card b, .panel .card strong, .panel .card')?.textContent?.slice(0, 40),
    saved: (() => {
      try {
        return Object.values(localStorage).map((v) => /"lang":"(\w+)"/.exec(v)?.[1]).filter(Boolean)[0];
      } catch {
        return undefined;
      }
    })(),
  }));
console.log('start', JSON.stringify(await state()));
for (const l of langs) {
  await page.selectOption('.panel select.lang', l);
  await page.waitForFunction((code) => document.querySelector('.panel select.lang')?.value === code && document.documentElement.lang.startsWith(code), l, { timeout: 120000 }).catch(() => problems.push(`${l}: the page did not switch`));
  console.log(l, JSON.stringify(await state()));
}
console.log('language files fetched:', chunks.join(' ') || 'none');
console.log(problems.length ? `problems: ${problems.join(' | ').slice(0, 600)}` : 'no errors on the page');
await browser.close();
