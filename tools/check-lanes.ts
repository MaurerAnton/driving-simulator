// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Does anything of the scenery stand in a lane?  Drives a car-wide circle
 * along every lane and every path through a junction of the built map and
 * lists what it touches: sign posts, lamps, trees, walls, buildings – as
 * the game sees them (tiles that are not marked as cleared by the map build
 * are cleared the way the game does it when it loads them).
 *
 *   node --max-old-space-size=3072 tools/check-lanes.ts [--traffic] [--list]
 *
 * With --traffic only the lanes ordinary traffic uses are checked; without
 * it also driveways and tracks.  --list prints every place.
 * MAP_DIR=<folder>: another map than public/map.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { newPolySample, samplePolyline } from '../src/core/geom.ts';
import { clearObjects, clearSigns, clearWalls, postInLane } from '../src/sim/clearlanes.ts';
import { followMap } from '../src/sim/follow.ts';
import { CHUNK, GRID_OFFSET, GridSet } from '../src/world/grid.ts';
import type { GridBits } from '../src/world/grid.ts';
import { LaneGraph, TURN, lanePoint } from '../src/world/lanes.ts';
import { MapLoader } from '../src/world/loader.ts';
import { unpackTile } from '../src/world/tilefmt.ts';
import { diskFiles } from './mapgen/mapfiles.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mapDir = resolve(root, process.env.MAP_DIR ?? 'public/map');
const args = new Set(process.argv.slice(2));
const ALL = !args.has('--traffic');
const LIST = args.has('--list');
/** half the width of a car plus a hand's breadth */
const R = 0.95;

interface Prim {
  kind: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  r: number;
  y: number;
}

const map = await MapLoader.open(diskFiles(mapDir));
const world = map.world;
const lanes = new LaneGraph(world);
followMap(map, { lanes });

const CELL = 16;
let grid = new Map<number, Prim[]>();
const put = (p: Prim): void => {
  const x0 = Math.floor((Math.min(p.x1, p.x2) - p.r) / CELL);
  const x1 = Math.floor((Math.max(p.x1, p.x2) + p.r) / CELL);
  const z0 = Math.floor((Math.min(p.z1, p.z2) - p.r) / CELL);
  const z1 = Math.floor((Math.max(p.z1, p.z2) + p.r) / CELL);
  for (let ix = x0; ix <= x1; ix++) {
    for (let iz = z0; iz <= z1; iz++) {
      const k = (ix + 32768) * 65536 + iz + 32768;
      const list = grid.get(k);
      if (list) list.push(p);
      else grid.set(k, [p]);
    }
  }
};
const cleared = { moved: 0, dropped: 0, lamps: 0, walls: 0, trees: 0, tiles: 0, marked: 0 };

/** The colliders of a tile, as the game takes them up. */
function takeTile(ix: number, iz: number): void {
  const file = resolve(mapDir, 'tiles', `${ix}_${iz}.fsb`);
  if (!existsSync(file)) return;
  const buf = gunzipSync(readFileSync(file));
  const tile = unpackTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const signs = tile.header.signs;
  const objects = tile.header.objects;
  const rings = tile.get('collPts') as Float32Array | null;
  const counts = tile.get('collCnt') as Uint16Array | null;
  const segs = tile.get('collSeg') as Float32Array | null;
  const trees = tile.get('trees') as Float32Array | null;
  const clear = !tile.header.clr;
  cleared.tiles++;
  if (!clear) cleared.marked++;
  if (clear) {
    const [moved, dropped] = clearSigns(lanes, signs);
    cleared.moved += moved;
    cleared.dropped += dropped;
    cleared.lamps += clearObjects(lanes, objects);
    const walls = clearWalls(lanes, rings, counts, segs);
    let before = (segs?.length ?? 0) / 5;
    if (counts) for (const n of counts) before += n;
    cleared.walls += before - walls.length / 5;
    for (let i = 0; i + 4 < walls.length; i += 5) put({ kind: Number.isNaN(walls[i + 4]) ? 'building' : 'wall', x1: walls[i], z1: walls[i + 1], x2: walls[i + 2], z2: walls[i + 3], r: 0, y: walls[i + 4] });
  } else {
    const skip = tile.get('collSkip') as Uint8Array | null;
    if (rings && counts) {
      let o = 0;
      for (const n of counts) {
        for (let i = 0; i < n; i++) {
          const side = o / 2 + i;
          if (skip && (skip[side >> 3] & (1 << (side & 7))) !== 0) continue;
          const j = (i + 1) % n;
          put({ kind: 'building', x1: rings[o + i * 2], z1: rings[o + i * 2 + 1], x2: rings[o + j * 2], z2: rings[o + j * 2 + 1], r: 0, y: NaN });
        }
        o += n * 2;
      }
    }
    if (segs) for (let i = 0; i + 4 < segs.length; i += 5) put({ kind: 'wall', x1: segs[i], z1: segs[i + 1], x2: segs[i + 2], z2: segs[i + 3], r: 0, y: segs[i + 4] });
  }
  if (trees) {
    for (let i = 0; i < trees.length; i += 5) {
      if (trees[i + 4] === 2) continue;
      if (clear && postInLane(lanes, trees[i], trees[i + 1], trees[i + 2])) cleared.trees++;
      else put({ kind: 'tree', x1: trees[i], z1: trees[i + 2], x2: trees[i], z2: trees[i + 2], r: trees[i + 4] === 3 ? 0.12 : 0.22, y: trees[i + 1] });
    }
  }
  for (const s of signs) put({ kind: `sign ${s.s[0] ?? ''}`.trim(), x1: s.x, z1: s.z, x2: s.x, z2: s.z, r: 0.06, y: s.y });
  for (const o of objects) if (o.k === 'lamp') put({ kind: 'lamp', x1: o.x, z1: o.z, x2: o.x, z2: o.z, r: 0.09, y: o.y });
}

interface Find {
  kind: string;
  x: number;
  z: number;
  where: string;
  cls: number;
}
const found: Find[] = [];
let hitNow = new Set<Prim>();
const touch = (x: number, y: number, z: number, where: string, cls: number): void => {
  const list = grid.get((Math.floor(x / CELL) + 32768) * 65536 + Math.floor(z / CELL) + 32768);
  if (!list) return;
  for (const p of list) {
    if (hitNow.has(p)) continue;
    // (as the game does: what stands on another level does not count)
    if (!Number.isNaN(p.y) && Math.abs(y - p.y) > 2.6) continue;
    const dx = p.x2 - p.x1;
    const dz = p.z2 - p.z1;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-9 ? ((x - p.x1) * dx + (z - p.z1) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (p.x1 + dx * t), z - (p.z1 + dz * t));
    if (d < R + p.r) {
      hitNow.add(p);
      found.push({ kind: p.kind, x: p.x1 + dx * t, z: p.z1 + dz * t, where, cls });
    }
  }
};

const smp = newPolySample();
let km = 0;
/** Check the lanes of the roads whose middle lies in the rectangle (all roads: null). */
function check(rect: { minX: number; minZ: number; maxX: number; maxZ: number } | null): void {
  const inside = (x: number, z: number): boolean => !rect || (x >= rect.minX && x < rect.maxX && z >= rect.minZ && z < rect.maxZ);
  for (const lane of lanes.lanes) {
    if (!lane || !LaneGraph.drivable(lane.edge, !ALL)) continue;
    const mid = (lane.edge.pl.pts.length / 3) >> 1;
    if (!inside(lane.edge.pl.pts[mid * 3], lane.edge.pl.pts[mid * 3 + 2])) continue;
    km += lane.len / 1000;
    const where = `${lane.edge.name || lane.edge.ref || 'road'} (edge ${lane.edge.id})`;
    for (let d = 0; d <= lane.len; d += 1.2) {
      lanePoint(lane, d, smp);
      touch(smp.x, smp.y, smp.z, where, lane.edge.cls);
    }
  }
  for (const c of lanes.connectors) {
    if (!LaneGraph.drivable(c.from.edge, !ALL) || !LaneGraph.drivable(c.to.edge, !ALL) || !inside(c.node.x, c.node.z)) continue;
    // (turning round at the end of a street without a turning circle is a manoeuvre, not a path to follow)
    if (c.turn === TURN.UTURN && c.node.arms.length === 1 && !(c.node.tc > 0)) continue;
    const where = `junction ${c.node.id} (${c.from.edge.name || c.from.edge.ref || 'road'} → ${c.to.edge.name || c.to.edge.ref || 'road'})`;
    for (let d = 0; d <= c.len; d += 1.2) {
      samplePolyline(c.pl, d, smp);
      touch(smp.x, smp.y, smp.z, where, Math.min(c.from.edge.cls, c.to.edge.cls));
    }
  }
}

const { x0, z0, size } = map.tiles;
if (!map.pieces) {
  const m = world.meta;
  for (let iz = 0; iz * size < m.maxZ - m.minZ; iz++) for (let ix = 0; ix * size < m.maxX - m.minX; ix++) if (map.tiles.has(ix, iz)) takeTile(ix, iz);
  check(null);
} else {
  // chunk by chunk: its roads with the roads around them, and the tiles they run through
  const index = JSON.parse(readFileSync(resolve(mapDir, 'map.json'), 'utf8')) as { chunks: GridBits };
  const chunks = GridSet.from(index.chunks);
  let done = 0;
  for (let cz = chunks.z0; cz < chunks.z0 + chunks.h; cz++) {
    for (let cx = chunks.x0; cx < chunks.x0 + chunks.w; cx++) {
      if (!chunks.has(cx, cz)) continue;
      const rect = { minX: cx * CHUNK - GRID_OFFSET, minZ: cz * CHUNK - GRID_OFFSET, maxX: (cx + 1) * CHUNK - GRID_OFFSET, maxZ: (cz + 1) * CHUNK - GRID_OFFSET };
      const mx = rect.minX + CHUNK / 2;
      const mz = rect.minZ + CHUNK / 2;
      map.loadRadius = CHUNK * 0.71 + 1200;
      map.keepRadius = CHUNK * 0.71 + 4200;
      await map.loadAround(mx, mz);
      for (let i = 0; i < 40; i++) map.update(mx, mz, Infinity);
      grid = new Map();
      hitNow = new Set();
      // (roads reach up to a kilometre over the rim of their chunk)
      for (let iz = Math.floor((rect.minZ - 1000 - z0) / size); iz <= Math.floor((rect.maxZ + 1000 - z0) / size); iz++) {
        for (let ix = Math.floor((rect.minX - 1000 - x0) / size); ix <= Math.floor((rect.maxX + 1000 - x0) / size); ix++) if (map.tiles.has(ix, iz)) takeTile(ix, iz);
      }
      check(rect);
      process.stdout.write(`\r[check-lanes] chunk ${++done} of ${chunks.count}: ${found.length} found  `);
    }
  }
  process.stdout.write('\n');
}

if (cleared.tiles > cleared.marked) {
  console.log(
    `[check-lanes] ${cleared.tiles - cleared.marked} tiles were cleared as the game does it when it loads them: ${cleared.moved} signs moved, ${cleared.dropped} dropped, ${cleared.lamps} lamps, ` +
      `${cleared.trees} trunks, ${cleared.walls} pieces of wall`,
  );
}
const byKind = new Map<string, number>();
for (const f of found) {
  const k = f.kind.split(' ')[0];
  byKind.set(k, (byKind.get(k) ?? 0) + 1);
}
console.log(`[check-lanes] ${km.toFixed(0)} km of lanes${ALL ? ' (all)' : ''}: ${found.length} things stand in a lane – ${[...byKind.entries()].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`);
if (LIST) for (const f of found.sort((a, b) => a.cls - b.cls)) console.log(`  ${f.kind.padEnd(14)} at ${f.x.toFixed(1)}, ${f.z.toFixed(1)}  on ${f.where}`);
process.exitCode = found.length > 0 ? 1 : 0;
