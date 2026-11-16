// SPDX-License-Identifier: AGPL-3.0-only
// Development helper: does the free camera follow the mouse, the keys and the fingers?
//   node tools/dev/camtest.mjs [mouse|touch]
// Loads the game headlessly in the free view, moves the camera the ways a player would and prints
// what each of them changed.  Needs a running dev/preview server (FS_URL, default http://127.0.0.1:5173/).
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

const mode = process.argv[2] === 'touch' ? 'touch' : 'mouse';
const W = 480;
const H = 270;
const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const touch = mode === 'touch';
const page = await browser.newPage({ viewport: { width: W, height: H }, isMobile: touch, hasTouch: touch });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const url = (process.env.FS_URL ?? 'http://127.0.0.1:5173/') + `?start=free&quality=low&traffic=0&view=free${touch ? '&touch=on' : ''}`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction(() => window.__fs && window.__fs.ready === true, null, { timeout: Number(process.env.FS_TIMEOUT ?? 1200000) });

const state = () =>
  page.evaluate(() => {
    const g = window.__fs.game;
    const r = (v) => Math.round(v * 1000) / 1000;
    return { mode: g.cameraMode, yaw: r(g.fc.yaw), pitch: r(g.fc.pitch), x: r(g.fc.off.x), y: r(g.fc.off.y), z: r(g.fc.off.z), dist: r(Math.hypot(g.fc.off.x, g.fc.off.y, g.fc.off.z)), frames: g.frames, kmh: r(g.vehicle.speed * 3.6) };
  });
/** let the game draw a few frames, so that it has taken up what was done */
const frames = async (n = 3) => {
  const from = (await state()).frames;
  await page.waitForFunction((f) => window.__fs.game.frames >= f, from + n, { timeout: 600000 });
};
const results = [];
let before = await state();
const step = async (what, act, changed) => {
  await act();
  await frames();
  const after = await state();
  const d = { yaw: after.yaw - before.yaw, pitch: after.pitch - before.pitch, x: after.x - before.x, y: after.y - before.y, z: after.z - before.z, dist: after.dist - before.dist };
  const ok = changed(d, after);
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}: ` + Object.entries(d).filter(([, v]) => Math.abs(v) > 0.0005).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v.toFixed(3)}`).join(', '));
  before = after;
  return ok;
};
await frames(3);
before = await state();
results.push(`start: ${JSON.stringify(before)}`);
const cx = W / 2;
const cy = H / 2 - 20;
let all = true;
if (!touch) {
  all = (await step('left mouse button held and moved', async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 10, { steps: 4 });
    await page.mouse.move(cx + 120, cy + 30, { steps: 4 });
    await page.mouse.up();
  }, (d) => Math.abs(d.yaw) > 0.05 && Math.abs(d.pitch) > 0.01 && Math.abs(d.x) + Math.abs(d.z) < 0.01)) && all;
  all = (await step('Alt held and the mouse moved (no button)', async () => {
    await page.keyboard.down('Alt');
    await page.mouse.move(cx + 40, cy - 10, { steps: 6 });
    await page.keyboard.up('Alt');
  }, (d) => Math.abs(d.yaw) > 0.05)) && all;
  all = (await step('mouse moved without Alt or a button (nothing may change)', async () => {
    await page.mouse.move(cx - 60, cy + 40, { steps: 6 });
  }, (d) => Math.abs(d.yaw) < 0.001 && Math.abs(d.pitch) < 0.001 && Math.abs(d.x) + Math.abs(d.y) + Math.abs(d.z) < 0.001)) && all;
  all = (await step('wheel (towards)', async () => {
    await page.mouse.wheel(0, -360);
  }, (d) => Math.abs(d.x) + Math.abs(d.y) + Math.abs(d.z) > 0.2 && Math.abs(d.yaw) < 0.001)) && all;
  all = (await step('right mouse button held and moved', async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 80, cy + 40, { steps: 6 });
    await page.mouse.up({ button: 'right' });
  }, (d) => Math.abs(d.x) + Math.abs(d.z) > 0.2 && Math.abs(d.yaw) < 0.001)) && all;
  all = (await step('Alt + W held (fly forwards; the car must not drive off)', async () => {
    await page.keyboard.down('Alt');
    await page.keyboard.down('KeyW');
    await frames(3);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('Alt');
  }, (d, s) => Math.abs(d.x) + Math.abs(d.z) > 0.5 && Math.abs(s.kmh) < 3)) && all;
  all = (await step('Alt + E held (up)', async () => {
    await page.keyboard.down('Alt');
    await page.keyboard.down('KeyE');
    await frames(3);
    await page.keyboard.up('KeyE');
    await page.keyboard.up('Alt');
  }, (d) => d.y > 0.3)) && all;
} else {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
  const drag = async (from, to, n = 6) => {
    await send('touchStart', from);
    for (let i = 1; i <= n; i++) await send('touchMove', from.map(([x, y], k) => [x + ((to[k][0] - x) * i) / n, y + ((to[k][1] - y) * i) / n]));
    await send('touchEnd', []);
  };
  all = (await step('one finger moved across the picture', () => drag([[cx, cy]], [[cx + 110, cy + 25]]), (d) => Math.abs(d.yaw) > 0.05 && Math.abs(d.x) + Math.abs(d.z) < 0.01)) && all;
  all = (await step('two fingers moved together', () => drag([[cx - 30, cy], [cx + 30, cy]], [[cx + 40, cy + 30], [cx + 100, cy + 30]]), (d) => Math.abs(d.x) + Math.abs(d.z) > 0.2 && Math.abs(d.yaw) < 0.02)) && all;
  all = (await step('two fingers spread apart', () => drag([[cx - 25, cy], [cx + 25, cy]], [[cx - 95, cy], [cx + 95, cy]]), (d) => Math.abs(d.x) + Math.abs(d.y) + Math.abs(d.z) > 0.2)) && all;
}
results.push(`end: ${JSON.stringify(before)}`);
console.log(results.join('\n'));
if (logs.length) console.log(logs.join('\n'));
console.log(all ? 'OK: the free camera follows' : 'FAILED');
await browser.close();
process.exit(all ? 0 : 1);
