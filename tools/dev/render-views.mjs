// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Render the game from a list of viewpoints (tools/dev/views-baunatal.json), two directions each, for comparing the
 * world with street-level photos by eye.  One browser per group of viewpoints (a long session grows), each started at
 * its first viewpoint so that only that part of the map loads.  Used by .github/workflows/render-views.yml, and locally:
 *
 *   node tools/dev/render-views.mjs <views.json> <out dir> [--shard i/n] [--group 10] [--quality medium] [--size 960x600]
 *
 * Needs a running server of the built game (FS_URL, default http://127.0.0.1:4173/) and Chromium (CHROME_BIN or the
 * playwright cache).  Writes <out>/game-NNN-K.jpg (K 0: the viewpoint's heading, 1: the opposite) and <out>/log.txt.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const [file, out] = args;
const [si, sn] = opt('--shard', '0/1').split('/').map(Number);
const group = Number(opt('--group', '10'));
const quality = opt('--quality', 'medium');
const [W, H] = opt('--size', '960x600').split('x').map(Number);
const base = process.env.FS_URL ?? 'http://127.0.0.1:4173/';
mkdirSync(out, { recursive: true });
const log = (s) => {
  console.log(s);
  appendFileSync(join(out, 'log.txt'), s + '\n');
};

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  for (const d of existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [])
    for (const sub of readdirSync(join(cache, d))) {
      const p = join(cache, d, sub, 'chrome');
      if (existsSync(p)) return p;
    }
  throw new Error('No Chromium found. Set CHROME_BIN or run: npx playwright install chromium');
}

const all = JSON.parse(readFileSync(file, 'utf8')).views;
const mine = all.filter((_, i) => i % sn === si);
const todo = () => mine.filter((v) => ![0, 1].every((k) => existsSync(join(out, `game-${String(v.id).padStart(3, '0')}-${k}.jpg`))));
let tries = 0;
while (todo().length > 0 && tries++ < Math.ceil(mine.length / group) * 3) {
  const batch = todo().slice(0, group);
  const first = batch[0];
  const t0 = Date.now();
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
    await page.goto(`${base}?start=free&vehicle=car&spawn=0&quality=${quality}&lang=en&at=${first.x},${first.z},0`, { waitUntil: 'domcontentloaded', timeout: 300000 });
    await page.waitForFunction(() => window.__fs && window.__fs.ready === true, null, { timeout: 1800000 });
    await page.evaluate(() => (document.getElementById('ui').style.visibility = 'hidden'));
    for (const v of batch) {
      for (const k of [0, 1]) {
        const hd = k === 0 ? v.heading : (v.heading + 180) % 360;
        await page.evaluate(([x, y, z, h]) => window.__fs.game.devView(x, y, z, h, -10, 65, true), [v.x, v.y, v.z, hd]);
        await page.waitForTimeout(k === 0 ? 25000 : 5000);
        await page.screenshot({ path: join(out, `game-${String(v.id).padStart(3, '0')}-${k}.jpg`), type: 'jpeg', quality: 88, timeout: 300000 });
      }
      log(`view ${v.id} done (${Math.round((Date.now() - t0) / 1000)} s into the session)`);
    }
  } catch (e) {
    log(`[session from ${first.id}] ${String(e.message).split('\n')[0]}`);
  } finally {
    await browser.close().catch(() => {});
  }
}
log(`shard ${si}/${sn}: ${mine.length - todo().length} of ${mine.length} viewpoints rendered`);
