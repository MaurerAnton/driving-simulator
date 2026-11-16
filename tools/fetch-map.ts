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
 * instead; the file `map.release` at the top of the repository names the
 * release the code at hand goes with.
 *
 * Needs curl and tar.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tag = readFileSync(resolve(root, 'map.release'), 'utf8').trim();
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { repository: { url: string } };
const repo = pkg.repository.url.replace(/\.git$/, '');
const url = `${repo}/releases/download/${tag}/map.tar`;
const target = resolve(root, 'public');

console.log(`[map] ${url}`);
mkdirSync(target, { recursive: true });
// (into a folder beside the old one first: an interrupted download leaves the map that was there)
const fresh = resolve(target, 'map.fetching');
rmSync(fresh, { recursive: true, force: true });
mkdirSync(fresh);
// (-sS: no progress meter – it fills the log of a build –, but errors are shown)
const curl = spawn('curl', ['-fsSL', '--retry', '3', '-A', 'map-fetch/0.1', url], { stdio: ['ignore', 'pipe', 'inherit'] });
const tar = spawn('tar', ['-x', '-C', fresh], { stdio: ['pipe', 'inherit', 'inherit'] });
curl.stdout.pipe(tar.stdin);
const done = (p: ReturnType<typeof spawn>): Promise<number> => new Promise((r) => p.on('close', (code) => r(code ?? 1)));
const [c, t] = await Promise.all([done(curl), done(tar)]);
if (c !== 0 || t !== 0 || !existsSync(resolve(fresh, 'map', 'map.json'))) {
  rmSync(fresh, { recursive: true, force: true });
  console.error(`[map] could not fetch the map (curl ${c}, tar ${t}). Is there a release "${tag}" with a file map.tar?`);
  process.exit(1);
}
const { renameSync } = await import('node:fs');
rmSync(resolve(target, 'map'), { recursive: true, force: true });
renameSync(resolve(fresh, 'map'), resolve(target, 'map'));
rmSync(fresh, { recursive: true, force: true });
console.log(`[map] the map of release ${tag} is in public/map`);
