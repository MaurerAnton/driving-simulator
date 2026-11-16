// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Map pipeline: from the extracts to public/map.
 *
 *   node tools/build-map.ts [--jobs 3] [--tiles] [--only <bx>_<bz>,…] [--resume]
 *
 * Runs tools/build-graph.ts (the road network of the region; skipped with
 * --tiles, --only and --resume), then tools/build-tiles.ts for every block
 * of 8 km – several at a time –, and writes the index of the map
 * (map.json).  See docs/MAP_DATA.md for the steps before it:
 *
 *   python3 -I tools/fetch-geodata.py --district …   terrain and building models
 *   node tools/osm-extract.ts                        OpenStreetMap, cut to the region
 *
 * --resume builds only the blocks that are not there yet (after an interruption).
 * MAP_OUT=<folder> builds into another folder than public/map.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GridSet } from '../src/world/grid.ts';
import type { GridBits } from '../src/world/grid.ts';
import type { MapIndexJson, PlaceJson, SpawnJson, WorldJson, YardJson } from '../src/world/types.ts';
import { BLOCK, gridIndex } from './mapgen/store.ts';
import type { BlockResult } from './build-tiles.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, process.env.MAP_OUT ?? 'public/map');
const workDir = resolve(root, 'data/work/graph');
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const value = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const jobs = Math.max(1, Number(value('--jobs') ?? 3));
const only = value('--only')?.split(',').filter(Boolean);
const resume = flag('--resume');
const t0 = Date.now();
const lap = (msg: string): void => console.log(`[${((Date.now() - t0) / 60000).toFixed(1).padStart(6)} min] ${msg}`);

if (!flag('--tiles') && !only && !resume) {
  // (--expose-gc: the step reports what it holds in memory)
  const r = spawnSync('node', ['--max-old-space-size=6144', '--expose-gc', resolve(root, 'tools/build-graph.ts')], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
  // (tiles of an earlier build do not fit the new network)
  rmSync(resolve(outDir, 'tiles'), { recursive: true, force: true });
  lap('the road network is built');
}

interface Plan {
  meta: WorldJson['meta'];
  nodes: number;
  edges: number;
  blocks: Array<[number, number]>;
  chunks: GridBits;
  places: PlaceJson[];
  spawns: SpawnJson[];
}
const plan = JSON.parse(readFileSync(resolve(workDir, 'plan.json'), 'utf8')) as Plan;
// the blocks around the first start point come first: what is looked at first is there first
const home = plan.spawns[0] ?? { x: 0, z: 0 };
const hx = gridIndex(home.x, BLOCK);
const hz = gridIndex(home.z, BLOCK);
let todo = plan.blocks.map(([bx, bz]) => `${bx}_${bz}`).sort((a, b) => {
  const d = (k: string): number => {
    const [x, z] = k.split('_').map(Number);
    return Math.hypot(x - hx, z - hz);
  };
  return d(a) - d(b);
});
if (only) todo = todo.filter((b) => only.includes(b));
if (resume) todo = todo.filter((b) => !existsSync(resolve(workDir, `r_${b}.json`)));
lap(`${todo.length} of ${plan.blocks.length} blocks to build, ${jobs} at a time`);

let failed = 0;
let done = 0;
const total = todo.length;
await new Promise<void>((finish) => {
  let running = 0;
  const next = (): void => {
    if (todo.length === 0) {
      if (running === 0) finish();
      return;
    }
    const name = todo.shift() as string;
    running++;
    const child = spawn('node', ['--max-old-space-size=3072', resolve(root, 'tools/build-tiles.ts'), name], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => {
      running--;
      done++;
      if (code !== 0) {
        failed++;
        console.error(`[map] block ${name} failed (${code}):\n${out.split('\n').slice(-12).join('\n')}`);
      } else {
        const line = out.split('\n').find((l) => l.startsWith('[tiles] block')) ?? `[tiles] block ${name}`;
        lap(`${done}/${total} ${line.replace('[tiles] ', '')}`);
      }
      next();
    });
  };
  for (let i = 0; i < jobs; i++) next();
});
if (failed > 0) {
  console.error(`[map] ${failed} blocks failed – fix and run again with --resume`);
  process.exit(1);
}

// ---- the index of the map: what there is, where to start ----
const tiles: Array<[number, number]> = [];
let bytes = 0;
let triangles = 0;
let yard: YardJson | null = null;
const cleared = [0, 0, 0, 0, 0];
for (const [bx, bz] of plan.blocks) {
  const file = resolve(workDir, `r_${bx}_${bz}.json`);
  if (!existsSync(file)) continue;
  const r = JSON.parse(readFileSync(file, 'utf8')) as BlockResult;
  tiles.push(...r.tiles);
  bytes += r.bytes;
  triangles += r.triangles;
  if (r.yard) yard = r.yard;
  r.cleared.forEach((v, i) => (cleared[i] += v));
}
const index: MapIndexJson = {
  version: 2,
  meta: plan.meta,
  places: plan.places,
  spawns: plan.spawns,
  tiles: GridSet.of(tiles).toJSON(),
  chunks: plan.chunks,
  nodes: plan.nodes,
  edges: plan.edges,
};
if (yard) index.yard = yard;
writeFileSync(resolve(outDir, 'map.json'), JSON.stringify(index));
// (what an earlier form of the map consisted of)
rmSync(resolve(outDir, 'world.json'), { force: true });

const sizeOf = (dir: string): number => {
  let n = 0;
  for (const f of readdirSync(dir, { withFileTypes: true })) n += f.isDirectory() ? sizeOf(resolve(dir, f.name)) : statSync(resolve(dir, f.name)).size;
  return n;
};
const all = sizeOf(outDir);
lap(
  `${tiles.length} tiles (${(bytes / 1048576).toFixed(0)} MB, ${Math.round(triangles / 1e6)} million triangles); out of the lanes: ${cleared[0]} signs moved, ${cleared[1]} dropped, ` +
    `${cleared[2]} lamps, ${cleared[3]} trunks, ${cleared[4]} sides of buildings; ${yard ? `practice yard at ${yard.x}, ${yard.z}` : 'no practice yard'}`,
);
lap(`${outDir}: ${(all / 1048576).toFixed(0)} MB${all > 950 * 1048576 ? ' – MORE THAN A SITE ON GITHUB PAGES MAY HOLD (1 GB with the game itself)' : ''}`);
