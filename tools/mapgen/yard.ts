// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A place for the manoeuvres of the truck lessons (reversing with a trailer,
 * the ramp, coupling): the flattest open field of the map that is big
 * enough, has no road, building or tree on it and lies as near to the first
 * start point as possible.
 *
 * Only the place is chosen here.  The map itself is not changed: the game
 * lays its practice yard (asphalt, markings, cones) over the field while such
 * a lesson runs.
 */
import { COVER } from '../../src/world/cover.ts';
import type { YardJson } from '../../src/world/types.ts';
import type { World } from '../../src/world/world.ts';
import type { CoverMap } from './cover.ts';
import type { OsmData } from './osm.ts';
import type { TerrainGrid } from './terrain.ts';

/** size of the yard: long enough to reverse a 17 m combination round a corner and straight back */
const LEN = 150;
const WID = 66;
/** the search works on squares of this size */
const CELL = 10;

export function findYard(cover: CoverMap, terrain: TerrainGrid, world: World, osm: OsmData, bmask: Uint8Array, inWorld: (x: number, z: number) => boolean, near: { x: number; z: number }): YardJson | null {
  const w = Math.floor((cover.w * cover.cell) / CELL);
  const h = Math.floor((cover.h * cover.cell) / CELL);
  const open = new Uint8Array(w * h);
  const k = CELL / cover.cell;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = cover.minX + (i + 0.5) * CELL;
      const z = cover.minZ + (j + 0.5) * CELL;
      if (!inWorld(x, z)) continue;
      // every corner and the middle: field or meadow, nothing built
      let ok = true;
      for (const [dx, dz] of [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) {
        const ci = Math.floor((i + dx) * k);
        const cj = Math.floor((j + dz) * k);
        const c = cover.data[cj * cover.w + ci];
        if ((c !== COVER.FARMLAND && c !== COVER.MEADOW) || bmask[cj * cover.w + ci]) {
          ok = false;
          break;
        }
      }
      if (ok) open[j * w + i] = 1;
    }
  }
  // single trees, pylons and the like stand in the way
  for (const n of osm.nodes.values()) {
    if (!n.tags || !(n.tags.natural === 'tree' || n.tags.power || n.tags.man_made || n.tags.barrier)) continue;
    const i = Math.floor((n.x - cover.minX) / CELL);
    const j = Math.floor((n.z - cover.minZ) / CELL);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (i + di >= 0 && j + dj >= 0 && i + di < w && j + dj < h) open[(j + dj) * w + i + di] = 0;
  }
  // how many open squares lie above and to the left of each square (for counting rectangles in one step)
  const sum = new Int32Array((w + 1) * (h + 1));
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) sum[(j + 1) * (w + 1) + i + 1] = open[j * w + i] + sum[j * (w + 1) + i + 1] + sum[(j + 1) * (w + 1) + i] - sum[j * (w + 1) + i];
  const count = (i0: number, j0: number, i1: number, j1: number): number => sum[j1 * (w + 1) + i1] - sum[j0 * (w + 1) + i1] - sum[j1 * (w + 1) + i0] + sum[j0 * (w + 1) + i0];

  let best: (YardJson & { score: number }) | null = null;
  for (const rot of [0, 1]) {
    const ni = Math.ceil((rot === 0 ? LEN : WID) / CELL) + 2;
    const nj = Math.ceil((rot === 0 ? WID : LEN) / CELL) + 2;
    for (let j = 0; j + nj <= h; j += 2) {
      for (let i = 0; i + ni <= w; i += 2) {
        if (count(i, j, i + ni, j + nj) !== ni * nj) continue;
        const x0 = cover.minX + i * CELL;
        const z0 = cover.minZ + j * CELL;
        const x1 = x0 + ni * CELL;
        const z1 = z0 + nj * CELL;
        // how level is it?
        let lo = Infinity;
        let hi = -Infinity;
        for (let z = z0; z <= z1; z += 10) {
          for (let x = x0; x <= x1; x += 10) {
            const y = terrain.at(x, z);
            if (y < lo) lo = y;
            if (y > hi) hi = y;
          }
        }
        const range = hi - lo;
        if (!(range < 2.6)) continue;
        const cx = (x0 + x1) / 2;
        const cz = (z0 + z1) / 2;
        const score = range + Math.hypot(cx - near.x, cz - near.z) / 2200;
        if (best && score >= best.score) continue;
        // no road or track across it or right beside it
        let road = false;
        world.edgesInBox(x0 - 6, z0 - 6, x1 + 6, z1 + 6, () => {
          road = true;
        });
        if (road) continue;
        best = { x: Math.round(cx), z: Math.round(cz), len: LEN, wid: WID, rot, score };
      }
    }
  }
  if (!best) return null;
  const { score: _score, ...yard } = best;
  return yard;
}
