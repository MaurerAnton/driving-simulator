// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The release step for the detail region (tools/mapgen/detailregion.ts): a
 * patch of the published map with exactly the files the region changes.
 *
 *   node tools/build-detail.ts [--skip-graph] [--previous <tiles-patch.tar>] [--apply]
 *
 * 1. The road network of the whole region (tools/build-graph.ts, ~30 min,
 *    4 GB) into a folder of its own (DETAIL_DIR, default data/work/detail:
 *    out/ for the map files, work/ for the blocks) – public/map and
 *    data/work/graph stay as they are.  --skip-graph uses the network built
 *    there before.
 * 2. The tiles of every block the region reaches into (tools/build-tiles.ts,
 *    one block at a time, ~3 GB): those that hold a road built anew, and
 *    those whose tiles (with their ring of one tile) reach into a box.
 * 3. Every file built is compared with public/map (the published map with
 *    the patches made after it): the chunks of the network (w/), net.bin.gz
 *    and the tiles that differ go into DETAIL_DIR/patch/map/,
 *    with map/patch.json ({"patched": "<time>"}); and that folder into
 *    DETAIL_DIR/tiles-patch.tar, the file of the release that
 *    tools/fetch-map.ts unpacks over the map (it sets meta.patched in
 *    map.json, which is part of the address of every file of the map: no
 *    browser keeps an old chunk, net.bin or tile).
 *
 * A release has one tiles-patch.tar: the files of earlier patches must be in
 * it again.  public/map holds them; they are the files written after its
 * map.json (the time of the map release) – or the files public/map/patch.json
 * lists (a patch of this tool, fetched or applied), or with --previous the
 * files of the earlier tiles-patch.tar.  They go into the patch as well.
 *
 * --apply: copy the patch into public/map and set meta.patched in its
 * map.json (what tools/fetch-map.ts does with the release's patch).
 *
 * The patch can only change files: a chunk or tile that public/map does not
 * have (the index, map.json, lists them) is reported and left out.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { detailBoxes, rectInDetail } from './mapgen/detailregion.ts';
import { BLOCK, GRID_OFFSET, HALO, TILE, gridRect, grow } from './mapgen/store.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const value = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const dir = resolve(root, process.env.DETAIL_DIR ?? 'data/work/detail');
const out = resolve(dir, 'out');
const work = resolve(dir, 'work');
const patch = resolve(dir, 'patch');
const live = resolve(root, 'public/map');
const t0 = Date.now();
const lap = (msg: string): void => console.log(`[${((Date.now() - t0) / 60000).toFixed(1).padStart(6)} min] ${msg}`);
const env = { ...process.env, MAP_OUT: out, MAP_WORK: work };

if (detailBoxes().length === 0) {
  console.error('[detail] there is no detail region (tools/mapgen/detail-region.json, DETAIL_REGION)');
  process.exit(1);
}
if (!existsSync(resolve(live, 'map.json'))) {
  console.error('[detail] public/map is missing: the patch is made against the published map (npm run map:fetch)');
  process.exit(1);
}

// ---- 1. the road network ----
if (!flag('--skip-graph') || !existsSync(resolve(work, 'plan.json'))) {
  mkdirSync(out, { recursive: true });
  lap('the road network of the whole region …');
  const r = spawnSync('node', ['--max-old-space-size=4096', resolve(root, 'tools/build-graph.ts')], { stdio: 'inherit', cwd: root, env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// ---- 2. the tiles of the blocks the region reaches into ----
// Besides the detail region, a block is rebuilt when it holds tiles whose signs are to be
// those of the current sign placer rather than the frozen 1.3.0 ones (tools/mapgen/legacy/
// patch-1.6.0-tiles.json): the conditional speed limits that drew no sign in 1.3.0.  Such a
// block is outside the detail region, so it rebuilds on the legacy path (cover, roads, … to
// the byte) and only the sign step switches – the patch is a sign change, nothing else.
const signTiles = new Set((JSON.parse(readFileSync(resolve(root, 'tools/mapgen/legacy/patch-1.6.0-tiles.json'), 'utf8')) as { tiles: string[] }).tiles);
const hasSignTile = (r: { minX: number; minZ: number; maxX: number; maxZ: number }): boolean => {
  for (const t of signTiles) {
    const [ix, iz] = t.split('_').map(Number);
    const x0 = ix * TILE - GRID_OFFSET, z0 = iz * TILE - GRID_OFFSET;
    if (x0 + TILE > r.minX && x0 < r.maxX && z0 + TILE > r.minZ && z0 < r.maxZ) return true;
  }
  return false;
};
const plan = JSON.parse(readFileSync(resolve(work, 'plan.json'), 'utf8')) as { blocks: Array<[number, number]> };
const blocks: string[] = [];
for (const [bx, bz] of plan.blocks) {
  const w = grow(gridRect(bx, bz, BLOCK), HALO);
  const file = resolve(work, `b_${bx}_${bz}.json.gz`);
  let fresh = 0;
  if (existsSync(file)) fresh = ((JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as { fresh?: number[] }).fresh ?? []).length;
  if (fresh > 0 || rectInDetail(w.minX, w.minZ, w.maxX, w.maxZ) || hasSignTile(w)) blocks.push(`${bx}_${bz}`);
}
lap(`blocks to build (region, fresh roads or sign tiles): ${blocks.join(', ')}`);
rmSync(resolve(out, 'tiles'), { recursive: true, force: true });
for (const b of blocks) {
  const r = spawnSync('node', ['--max-old-space-size=3072', resolve(root, 'tools/build-tiles.ts'), b], { stdio: 'inherit', cwd: root, env });
  if (r.status !== 0) process.exit(r.status ?? 1);
  lap(`block ${b} built`);
}

// ---- 3. what differs from the published map ----
const same = (a: string, b: string): boolean => {
  if (!existsSync(b)) return false;
  if (statSync(a).size !== statSync(b).size) return false;
  return readFileSync(a).equals(readFileSync(b));
};
const changed: string[] = [];
const missing: string[] = [];
const compare = (rel: string): void => {
  const a = resolve(out, rel);
  const b = resolve(live, rel);
  if (!existsSync(b)) missing.push(rel);
  else if (!same(a, b)) changed.push(rel);
};
let chunks = 0;
for (const f of readdirSync(resolve(out, 'w')).sort()) {
  chunks++;
  compare(`w/${f}`);
}
// (rails.json.gz is not taken: the published one is the network build's with what tools/build-stops.ts adds to
// it – the stops on the tracks –, never the same bytes; the tracks of the region keep their published course)
compare('net.bin.gz');
let tiles = 0;
for (const f of existsSync(resolve(out, 'tiles')) ? readdirSync(resolve(out, 'tiles')).sort() : []) {
  tiles++;
  compare(`tiles/${f}`);
}
lap(`${chunks} chunks and ${tiles} tiles compared with public/map: ${changed.length} files differ${missing.length ? `; ${missing.length} not in public/map, left out: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}` : ''}`);

// the files of earlier patches (in public/map: written after its map.json, or listed in --previous)
const earlier: string[] = [];
const seen = new Set<string>();
const add = (rel: string): void => {
  if (rel && !rel.endsWith('/') && rel !== 'patch.json' && !seen.has(rel)) {
    seen.add(rel);
    earlier.push(rel);
  }
};
// (the published patch's own list: the files of earlier patches that a release already carries.
//  It is always taken, so a stale --previous cannot leave files out of the new patch – the patch
//  a release ships is cumulative: it has every file of the patches before it.)
if (existsSync(resolve(live, 'patch.json')) && Array.isArray((JSON.parse(readFileSync(resolve(live, 'patch.json'), 'utf8')) as { files?: unknown }).files)) {
  for (const f of (JSON.parse(readFileSync(resolve(live, 'patch.json'), 'utf8')) as { files: string[] }).files) add(f);
}
const previous = value('--previous');
if (previous) {
  const r = spawnSync('tar', ['-tf', resolve(previous)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar -tf ${previous}: ${r.stderr}`);
  for (const line of r.stdout.split('\n')) add(line.trim().replace(/^map\//, ''));
} else {
  const since = statSync(resolve(live, 'map.json')).mtimeMs;
  const walk = (sub: string): void => {
    for (const f of readdirSync(resolve(live, sub))) {
      const rel = `${sub}/${f}`;
      if (statSync(resolve(live, rel)).mtimeMs > since) earlier.push(rel);
    }
  };
  for (const sub of ['w', 'tiles']) if (existsSync(resolve(live, sub))) walk(sub);
}
const carried = earlier.filter((rel) => !changed.includes(rel) && existsSync(resolve(live, rel)));

// The patch a release ships is cumulative: it must carry every file of the patches before it.
// A --previous that is behind the published patch used to drop those files silently, so the
// patch was short – and installing it fresh lost what it did not list.  Refuse to write one.
{
  const published = new Set<string>();
  const pj = resolve(live, 'patch.json');
  if (existsSync(pj)) {
    const j = JSON.parse(readFileSync(pj, 'utf8')) as { files?: unknown };
    if (Array.isArray(j.files)) for (const f of j.files) if (typeof f === 'string') published.add(f);
  }
  const out = new Set([...changed, ...carried]);
  const missing = [...published].filter((f) => !out.has(f)).sort();
  if (missing.length > 0) {
    const shown = missing.slice(0, 8).join(', ') + (missing.length > 8 ? `, … (${missing.length} more)` : '');
    console.error(`[detail] the patch would leave out ${missing.length} of the ${published.size} published files: ${shown}`);
    console.error(`[detail] a release's patch is cumulative – it must carry them again.  Use the published patch as --previous (or none), not a stale one.`);
    process.exit(1);
  }
}

rmSync(patch, { recursive: true, force: true });
mkdirSync(resolve(patch, 'map'), { recursive: true });
let bytes = 0;
const put = (from: string, rel: string): void => {
  const to = resolve(patch, 'map', rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  bytes += statSync(to).size;
};
for (const rel of changed) put(resolve(out, rel), rel);
for (const rel of carried) put(resolve(live, rel), rel);
const patched = new Date().toISOString();
const files = [...changed, ...carried].sort();
writeFileSync(resolve(patch, 'map', 'patch.json'), JSON.stringify({ patched, region: detailBoxes(), files }));
const tar = resolve(dir, 'tiles-patch.tar');
rmSync(tar, { force: true });
const t = spawnSync('tar', ['-cf', tar, '-C', patch, 'map'], { stdio: 'inherit' });
if (t.status !== 0) process.exit(t.status ?? 1);
const count = (pre: string): number => changed.filter((r) => r.startsWith(pre)).length;
lap(
  `patch: ${count('w/')} chunks, ${count('tiles/')} tiles${changed.includes('net.bin.gz') ? ', net.bin.gz' : ''} ` +
    `and ${carried.length} files of earlier patches – ${(bytes / 1048576).toFixed(1)} MB; ${relative(root, tar)} ${(statSync(tar).size / 1048576).toFixed(1)} MB`,
);
writeFileSync(resolve(dir, 'patch-files.txt'), [...changed.map((r) => `new ${r}`), ...carried.map((r) => `earlier ${r}`)].join('\n') + '\n');

// ---- --apply: into public/map, as tools/fetch-map.ts would ----
if (flag('--apply')) {
  for (const rel of changed) copyFileSync(resolve(out, rel), resolve(live, rel));
  const index = resolve(live, 'map.json');
  const json = JSON.parse(readFileSync(index, 'utf8')) as { meta: { patched?: string } };
  json.meta.patched = patched;
  writeFileSync(index, JSON.stringify(json));
  copyFileSync(resolve(patch, 'map', 'patch.json'), resolve(live, 'patch.json'));
  lap(`applied to public/map (meta.patched ${patched})`);
}
