// SPDX-License-Identifier: AGPL-3.0-only
// Headless screenshot helper for development:
//   node tools/dev/shot.mjs "<query string>" out.png [width] [height] [extraWaitMs]
// Needs a running dev/preview server (default http://127.0.0.1:5173) and a
// Chromium binary (CHROME_BIN, or the one Playwright cached).
// Environment: FS_URL, FS_TIMEOUT (ms), FS_FILES (pictures for the reality view, separated like PATH),
// FS_MOBILE=1 (a phone: touch screen, no mouse), FS_FILL="<selector>=<text>" (type into a field and wait
// for FS_WAIT_FOR, a selector), FS_CLICK="<selector>" (then click), FS_STEPS (keys, clicks, waits – see below).
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
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
const mobile = !!process.env.FS_MOBILE;
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
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
// FS_FILES=a.jpg:b.jpg – hand these files to the reality view (as if chosen with "Choose pictures …")
if (process.env.FS_FILES) {
  await page.setInputFiles('.reality input[type=file]', process.env.FS_FILES.split(delimiter));
  await page
    .waitForFunction(() => {
      const r = window.__fs.info().reality;
      return r && r.own > 0 && r.current && (r.current.pano ? r.panoActive : true);
    }, null, { timeout: 240000 })
    .catch((e) => logs.push(`[shot] the files did not show: ${e.message.split('\n')[0]}`));
}
if (process.env.FS_FILL) {
  const at = process.env.FS_FILL.indexOf('=');
  await page.fill(process.env.FS_FILL.slice(0, at), process.env.FS_FILL.slice(at + 1));
  if (process.env.FS_WAIT_FOR) await page.waitForSelector(process.env.FS_WAIT_FOR, { timeout: 120000 }).catch((e) => logs.push(`[shot] ${e.message.split('\n')[0]}`));
}
if (process.env.FS_CLICK) await page.click(process.env.FS_CLICK, { timeout: 120000 }).catch((e) => logs.push(`[shot] ${e.message.split('\n')[0]}`));
// FS_STEPS="key:Escape;;click:<selector>;;wait:800;;hold:KeyU;;select:<selector>=<value>;;eval:<statements using g>"
// – things to do one after the other before the picture is taken
for (const step of (process.env.FS_STEPS ?? '').split(';;').filter(Boolean)) {
  const at = step.indexOf(':');
  const [what, arg] = [step.slice(0, at), step.slice(at + 1)];
  try {
    if (what === 'key') await page.keyboard.press(arg);
    else if (what === 'hold') await page.keyboard.down(arg);
    else if (what === 'click') await page.click(arg, { timeout: 120000 });
    else if (what === 'wait') await page.waitForTimeout(Number(arg));
    else if (what === 'select') {
      // select:<selector>=<value> chooses an option of a list
      const eq = arg.lastIndexOf('=');
      await page.selectOption(arg.slice(0, eq), arg.slice(eq + 1), { timeout: 120000 });
    } else if (what === 'eval') {
      // eval:<statements> runs in the page; `g` is the game
      const r = await page.evaluate((src) => String(new Function('g', src)(window.__fs.game)), arg);
      if (r !== 'undefined') logs.push(`[eval] ${r}`);
    }
    else if (what === 'drag') {
      // drag:x1,y1,x2,y2 with the mouse
      const [x1, y1, x2, y2] = arg.split(',').map(Number);
      await page.mouse.move(x1, y1);
      await page.mouse.down();
      await page.mouse.move(x2, y2, { steps: 6 });
      await page.mouse.up();
    }
  } catch (e) {
    logs.push(`[shot] ${step}: ${e.message.split('\n')[0]}`);
  }
}
await page.waitForTimeout(Number(extra));
await page.screenshot({ path: out, timeout: 240000 });
const info = await page.evaluate(() => (window.__fs ? window.__fs.info() : null)).catch(() => null);
console.log(JSON.stringify({ ms: Date.now() - t0, info }));
for (const l of logs.slice(0, 40)) console.log(l);
await browser.close();
