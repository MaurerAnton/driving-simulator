// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Terrain height grid for the whole world rectangle.
 *
 *  1. sample the 1 m terrain model on a coarser grid,
 *  2. extrapolate into the corners the state tiles do not cover,
 *  3. bench the terrain to road level along every road so that the road mesh
 *     never floats above or sinks into the ground.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { smoothstep } from '../../src/core/geom.ts';
import { EF } from '../../src/world/types.ts';
import { newSurfaceHit } from '../../src/world/world.ts';
import type { SurfaceHit, World } from '../../src/world/world.ts';
import type { Dgm } from './dgm.ts';

export class TerrainGrid {
  readonly cell: number;
  readonly minX: number;
  readonly minZ: number;
  readonly w: number;
  readonly h: number;
  readonly data: Float32Array;
  /** 1 where the height comes from the terrain model (not extrapolated) */
  readonly known: Uint8Array;

  constructor(minX: number, minZ: number, maxX: number, maxZ: number, cell: number) {
    this.cell = cell;
    this.minX = minX;
    this.minZ = minZ;
    this.w = Math.round((maxX - minX) / cell) + 1;
    this.h = Math.round((maxZ - minZ) / cell) + 1;
    this.data = new Float32Array(this.w * this.h);
    this.known = new Uint8Array(this.w * this.h);
  }

  /** Height with the same triangle split the renderer uses (diagonal from (i,j+1) to (i+1,j)). */
  at(x: number, z: number): number {
    const fx = Math.max(0, Math.min(this.w - 1.0001, (x - this.minX) / this.cell));
    const fz = Math.max(0, Math.min(this.h - 1.0001, (z - this.minZ) / this.cell));
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const i = iz * this.w + ix;
    const h00 = this.data[i];
    const h10 = this.data[i + 1];
    const h01 = this.data[i + this.w];
    const h11 = this.data[i + this.w + 1];
    return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }
}

/** how far from a road the ground is shaped to it, and how far below the road it then lies */
const REACH = 20;
const DROP = 0.25;

/** The natural ground at a point: the terrain model through a small box filter (NaN where there is none). */
export function naturalHeight(dgm: Dgm, x: number, z: number): number {
  let sum = 0;
  let cnt = 0;
  for (let k = 0; k < 5; k++) {
    const v = dgm.height(x + (k === 1 ? -1.2 : k === 2 ? 1.2 : 0), z + (k === 3 ? -1.2 : k === 4 ? 1.2 : 0));
    if (!Number.isNaN(v)) {
      sum += v;
      cnt++;
    }
  }
  return cnt ? sum / cnt : NaN;
}

/** Ground of height `h` at a point, benched to the roads near it (`cell`: spacing of the terrain grid). */
export function benched(world: World, x: number, z: number, h: number, cell: number, hit: SurfaceHit): number {
  if (!world.nearestRoad(x, z, REACH, EF.BRIDGE, hit)) return h;
  // every cell touching a road is fully benched
  const flat = cell * Math.SQRT2 + 0.3;
  const wgt = hit.off <= flat ? 1 : 1 - smoothstep(flat, REACH, hit.off);
  return wgt <= 0 ? h : h + (hit.y - DROP - h) * wgt;
}

/**
 * The ground as the tiles will have it, at any point – for what is laid out
 * before the tiles are built (the tracks of the railways).  Away from the
 * points of the terrain grid it differs a little from the grid's own.
 */
export function groundAt(dgm: Dgm, world: World, cell: number): { at(x: number, z: number): number } {
  const hit = newSurfaceHit();
  return {
    at(x: number, z: number): number {
      const h = naturalHeight(dgm, x, z);
      return Number.isNaN(h) ? NaN : benched(world, x, z, h, cell, hit);
    },
  };
}

export function buildTerrain(
  dgm: Dgm,
  world: World,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  cell: number,
  cachePath: string | null = null,
): TerrainGrid {
  const g = new TerrainGrid(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ, cell);
  const { w, h, data, known } = g;

  // ---- 1. natural terrain (cached: it only depends on the terrain model) ---
  let cached = false;
  if (cachePath && existsSync(cachePath)) {
    const buf = readFileSync(cachePath);
    if (buf.byteLength === data.byteLength) {
      data.set(new Float32Array(buf.buffer, buf.byteOffset, data.length));
      cached = true;
    }
  }
  if (!cached) {
    for (let iz = 0; iz < h; iz++) {
      const z = g.minZ + iz * cell;
      for (let ix = 0; ix < w; ix++) {
        const x = g.minX + ix * cell;
        data[iz * w + ix] = naturalHeight(dgm, x, z);
      }
    }
    if (cachePath) writeFileSync(cachePath, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }
  for (let i = 0; i < data.length; i++) known[i] = Number.isNaN(data[i]) ? 0 : 1;

  // ---- 2. extrapolate into uncovered areas (nearest value, then relax) -----
  const queue = new Int32Array(w * h);
  let qh = 0;
  let qt = 0;
  for (let i = 0; i < data.length; i++) if (known[i]) queue[qt++] = i;
  const filled = known.slice();
  while (qh < qt) {
    const i = queue[qh++];
    const ix = i % w;
    const iz = (i / w) | 0;
    const v = data[i];
    if (ix > 0 && !filled[i - 1]) {
      filled[i - 1] = 1;
      data[i - 1] = v;
      queue[qt++] = i - 1;
    }
    if (ix < w - 1 && !filled[i + 1]) {
      filled[i + 1] = 1;
      data[i + 1] = v;
      queue[qt++] = i + 1;
    }
    if (iz > 0 && !filled[i - w]) {
      filled[i - w] = 1;
      data[i - w] = v;
      queue[qt++] = i - w;
    }
    if (iz < h - 1 && !filled[i + w]) {
      filled[i + w] = 1;
      data[i + w] = v;
      queue[qt++] = i + w;
    }
  }
  for (let pass = 0; pass < 60; pass++) {
    for (let iz = 1; iz < h - 1; iz++) {
      for (let ix = 1; ix < w - 1; ix++) {
        const i = iz * w + ix;
        if (known[i]) continue;
        data[i] = (data[i - 1] + data[i + 1] + data[i - w] + data[i + w]) * 0.25;
      }
    }
  }

  // ---- 3. bench the terrain along roads ------------------------------------
  // coarse mask of vertices that can be near a road at all
  const near = new Uint8Array(w * h);
  for (const e of world.edges) {
    const pad = e.width / 2 + Math.max(e.swL, e.swR) + REACH;
    const pts = e.pl.pts;
    const n = e.pl.cum.length;
    for (let k = 0; k < n; k++) {
      const x = pts[k * 3];
      const z = pts[k * 3 + 2];
      const x0 = Math.max(0, Math.floor((x - pad - g.minX) / cell));
      const x1 = Math.min(w - 1, Math.ceil((x + pad - g.minX) / cell));
      const z0 = Math.max(0, Math.floor((z - pad - g.minZ) / cell));
      const z1 = Math.min(h - 1, Math.ceil((z + pad - g.minZ) / cell));
      for (let iz = z0; iz <= z1; iz++) near.fill(1, iz * w + x0, iz * w + x1 + 1);
    }
  }
  for (const node of world.nodes) {
    const sh = node.shape;
    if (!sh) continue;
    const x0 = Math.max(0, Math.floor((sh.minX - REACH - g.minX) / cell));
    const x1 = Math.min(w - 1, Math.ceil((sh.maxX + REACH - g.minX) / cell));
    const z0 = Math.max(0, Math.floor((sh.minZ - REACH - g.minZ) / cell));
    const z1 = Math.min(h - 1, Math.ceil((sh.maxZ + REACH - g.minZ) / cell));
    for (let iz = z0; iz <= z1; iz++) near.fill(1, iz * w + x0, iz * w + x1 + 1);
  }
  const hit = newSurfaceHit();
  let benchedCount = 0;
  for (let iz = 0; iz < h; iz++) {
    const z = g.minZ + iz * cell;
    for (let ix = 0; ix < w; ix++) {
      const i = iz * w + ix;
      if (!near[i]) continue;
      const v = benched(world, g.minX + ix * cell, z, data[i], cell, hit);
      if (v !== data[i]) {
        data[i] = v;
        benchedCount++;
      }
    }
  }
  console.log(`[terrain] ${w}x${h} grid, ${benchedCount} vertices shaped by roads${cached ? ' (natural terrain from cache)' : ''}`);
  return g;
}
