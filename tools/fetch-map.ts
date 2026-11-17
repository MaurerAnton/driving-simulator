// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fetch the map the game runs on into public/map.
 *
 *   node tools/fetch-map.ts
 *
 * The map – terrain, roads and buildings of northern Hesse as tiles, close
 * to a gigabyte – is built from open geodata (docs/MAP_DATA.md) and is not
 * part of the repository: every rebuild would add its full size to the
 * history for good.  It is kept as a file of a release of the project
 * instead (map.tar, or in parts: map.tar.00, map.tar.01, …); the file
 * `map.release` at the top of the repository names the release the code at
 * hand goes with.
 *
 * Data that is built after a map release – small files such as the tram
 * timetables or the bus lines (EXTRA below) – may be added to the release
 * as files of their own; they are fetched too when they are there, and take
 * the place of those in map.tar.
 *
 * Needs curl and tar.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tag = readFileSync(resolve(root, 'map.release'), 'utf8').trim();
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { repository: { url: string } };
const repo = pkg.repository.url.replace(/\.git$/, '');
const url = `${repo}/releases/download/${tag}/map.tar`;
const target = resolve(root, 'public');
/** files a release may have beside map.tar, put into the map folder */
const EXTRA = ['timetable.json.gz', 'buslines.json.gz', 'signs.json.gz', 'services.json.gz'];

console.log(`[map] ${url}`);
mkdirSync(target, { recursive: true });
// (into a folder beside the old one first: an interrupted download leaves the map that was there)
const fresh = resolve(target, 'map.fetching');
rmSync(fresh, { recursive: true, force: true });
mkdirSync(fresh);

/** Download a file of the release to `to`; false if the release has no such file. */
async function download(name: string, to: string): Promise<boolean> {
  // (-sS: no progress meter – it fills the log of a build –, but errors are shown; -f: an HTTP error is a failure)
  const curl = spawn('curl', ['-fsSL', '--retry', '5', '--retry-all-errors', '--retry-delay', '3', '-A', 'map-fetch/0.1', '-o', to, `${repo}/releases/download/${tag}/${name}`], { stdio: ['ignore', 'inherit', 'pipe'] });
  let err = '';
  curl.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const code = await new Promise<number>((r) => curl.on('close', (c) => r(c ?? 1)));
  if (code === 0) return true;
  // 22: the server said no (404: there is no such file)
  if (code === 22 && /\b404\b/.test(err)) return false;
  throw new Error(`curl ${code}: ${err.trim()}`);
}

// The map is one tar archive – in one file (map.tar) or, since a file of a gigabyte does not always
// get through in one go, cut into parts (map.tar.00, map.tar.01, …) that are put together again here.
const tar = spawn('tar', ['-x', '-C', fresh], { stdio: ['pipe', 'inherit', 'inherit'] });
const untarred = new Promise<number>((r) => tar.on('close', (c) => r(c ?? 1)));
const part = resolve(fresh, 'part.tmp');
const feed = (file: string): Promise<void> =>
  new Promise((done, fail) => {
    const src = createReadStream(file);
    src.on('error', fail);
    src.on('end', () => done());
    src.pipe(tar.stdin, { end: false });
  });
let ok = false;
try {
  if (await download('map.tar', part)) {
    await feed(part);
    ok = true;
  } else {
    let n = 0;
    for (; n < 100; n++) {
      if (!(await download(`map.tar.${String(n).padStart(2, '0')}`, part))) break;
      await feed(part);
      process.stdout.write(`\r[map] part ${n + 1}  `);
    }
    process.stdout.write('\n');
    ok = n > 0;
  }
} catch (e) {
  console.error(`[map] ${(e as Error).message}`);
}
tar.stdin.end();
const t = await untarred;
rmSync(part, { force: true });
if (!ok || t !== 0 || !existsSync(resolve(fresh, 'map', 'map.json'))) {
  rmSync(fresh, { recursive: true, force: true });
  console.error(`[map] could not fetch the map (tar ${t}). Is there a release "${tag}" with a file map.tar or files map.tar.00 …?`);
  process.exit(1);
}
for (const name of EXTRA) {
  try {
    const to = resolve(fresh, 'map', name);
    // (under another name first: a file that is not in this release leaves what map.tar had untouched)
    const tmp = `${to}.part`;
    if (await download(name, tmp)) {
      renameSync(tmp, to);
      console.log(`[map] ${name}`);
    } else rmSync(tmp, { force: true });
  } catch (e) {
    rmSync(resolve(fresh, 'map', `${name}.part`), { force: true });
    console.error(`[map] ${name}: ${(e as Error).message}`);
  }
}
rmSync(resolve(target, 'map'), { recursive: true, force: true });
renameSync(resolve(fresh, 'map'), resolve(target, 'map'));
rmSync(fresh, { recursive: true, force: true });
console.log(`[map] the map of release ${tag} is in public/map`);
