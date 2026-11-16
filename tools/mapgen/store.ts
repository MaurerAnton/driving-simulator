// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where the reduced source data of the map build lies (data/work), and how
 * the region is cut into pieces.  Everything is addressed by world
 * coordinates (x east, z south, metres from the world origin) on fixed
 * grids, so that any part of the region can be built without the rest:
 *
 *   tiles   500 m   what the game streams: terrain, meshes, scenery
 *   chunks  4 km    the road network as the game loads it
 *   blocks  8 km    what one run of the tile build works on
 *   bins    2 km    the building models (data/work/lod2)
 *
 * The region itself is whatever the terrain model was fetched for
 * (tools/fetch-geodata.py → data/work/dgm2): no terrain, no map.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { WORLD_ORIGIN_E, WORLD_ORIGIN_N } from '../../src/geo/utm.ts';

export { CHUNK, GRID_OFFSET, TILE, gridIndex } from '../../src/world/grid.ts';
import { GRID_OFFSET, TILE, gridIndex } from '../../src/world/grid.ts';

export const BLOCK = 8000;
/** what a block's build sees beyond the block: one ring of tiles */
export const HALO = TILE;

/** Side of the squares the building models are sorted into (data/work/lod2/<municipality>/<bx>_<bz>.ndjson.gz). */
export const LOD2_BIN = 2000;

export function lod2BinKey(x: number, z: number): string {
  return `${Math.floor((x + GRID_OFFSET) / LOD2_BIN)}_${Math.floor((z + GRID_OFFSET) / LOD2_BIN)}`;
}

export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** The square (ix, iz) of a grid of side `size`. */
export function gridRect(ix: number, iz: number, size: number): Rect {
  return { minX: ix * size - GRID_OFFSET, minZ: iz * size - GRID_OFFSET, maxX: (ix + 1) * size - GRID_OFFSET, maxZ: (iz + 1) * size - GRID_OFFSET };
}

export function grow(r: Rect, by: number): Rect {
  return { minX: r.minX - by, minZ: r.minZ - by, maxX: r.maxX + by, maxZ: r.maxZ + by };
}

/** The terrain tiles (1 km, by their south-west corner in km of UTM 32) that were fetched, and what they cover. */
export class Coverage {
  private readonly tiles = new Set<number>();
  /** the rectangle around everything covered (world coordinates) */
  readonly bbox: Rect = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  readonly count: number;

  /**
   * `region`: the region an extract of OpenStreetMap was cut for
   * (data/work/osm/region.json, written by tools/osm-extract.ts) – the steps
   * after it build that, even if more terrain was fetched in the meantime.
   * Without it: all the terrain there is.
   */
  constructor(root: string, region = false) {
    const list: Array<[number, number]> = [];
    const file = resolve(root, 'data/work/osm/region.json');
    if (region) {
      if (!existsSync(file)) throw new Error('data/work/osm/region.json is missing – run tools/osm-extract.ts first');
      list.push(...((JSON.parse(readFileSync(file, 'utf8')) as { tiles: Array<[number, number]> }).tiles));
    } else {
      const dir = resolve(root, 'data/work/dgm2');
      for (const f of existsSync(dir) ? readdirSync(dir) : []) {
        const m = /^(\d+)_(\d+)\.dgm$/.exec(f);
        if (m) list.push([Number(m[1]), Number(m[2])]);
      }
    }
    for (const [e, n] of list) {
      this.tiles.add(e * 10000 + n);
      const x0 = e * 1000 - WORLD_ORIGIN_E;
      const z0 = WORLD_ORIGIN_N - (n + 1) * 1000;
      this.bbox.minX = Math.min(this.bbox.minX, x0);
      this.bbox.maxX = Math.max(this.bbox.maxX, x0 + 1000);
      this.bbox.minZ = Math.min(this.bbox.minZ, z0);
      this.bbox.maxZ = Math.max(this.bbox.maxZ, z0 + 1000);
    }
    this.count = this.tiles.size;
  }

  /** The terrain tiles: [E km, N km] of their south-west corners. */
  list(): Array<[number, number]> {
    return [...this.tiles].sort((a, b) => a - b).map((k) => [Math.floor(k / 10000), k % 10000]);
  }

  /** Is there terrain at this place? */
  covered(x: number, z: number): boolean {
    return this.tiles.has(Math.floor((x + WORLD_ORIGIN_E) / 1000) * 10000 + Math.floor((WORLD_ORIGIN_N - z) / 1000));
  }

  /** Does any terrain tile reach into the rectangle? */
  touches(r: Rect): boolean {
    for (let x = Math.floor(r.minX / 1000) * 1000 + 500; x < r.maxX + 500; x += 1000) {
      for (let z = Math.floor(r.minZ / 1000) * 1000 + 500; z < r.maxZ + 500; z += 1000) {
        // (a terrain tile reaches in when it overlaps by more than its edge)
        if (x + 500 > r.minX && x - 500 < r.maxX && z + 500 > r.minZ && z - 500 < r.maxZ && this.covered(x, z)) return true;
      }
    }
    return false;
  }

  /** The squares of a grid of side `size` that hold terrain: [ix, iz] pairs, row by row. */
  squares(size: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    if (this.count === 0) return out;
    for (let iz = gridIndex(this.bbox.minZ, size); iz <= gridIndex(this.bbox.maxZ - 1, size); iz++) {
      for (let ix = gridIndex(this.bbox.minX, size); ix <= gridIndex(this.bbox.maxX - 1, size); ix++) {
        if (this.touches(gridRect(ix, iz, size))) out.push([ix, iz]);
      }
    }
    return out;
  }
}
