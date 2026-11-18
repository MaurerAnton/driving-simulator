// SPDX-License-Identifier: AGPL-3.0-only
/** Ground under the wheels: analytic road surfaces first, terrain tiles otherwise. */
import { newPolySample, samplePolyline } from '../core/geom.ts';
import { COVER } from '../world/cover.ts';
import { SURF_GRIP, SURF_ROLLING } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { SurfaceHit, World } from '../world/world.ts';
import type { Ground, GroundSample } from './vehicle/types.ts';

export interface TerrainSource {
  heightAt(x: number, z: number): number;
  coverAt(x: number, z: number): number;
}

export class WorldGround implements Ground {
  private readonly world: World;
  private readonly terrain: TerrainSource;
  /** result of the most recent road lookup (shared scratch object) */
  readonly hit: SurfaceHit = newSurfaceHit();
  private readonly tmp = newPolySample();
  private lastY = 0;
  /** global grip multiplier (rain, ice) */
  weatherGrip = 1;
  /**
   * The road physics switched off (an arcade option, game/arcadedrive.ts): every road and every
   * piece of land grips and rolls as dry asphalt, whatever the weather – water stays water.
   */
  even = false;
  /** places that are paved for the time being, whatever the map says (the practice yard laid over a field) */
  paved: ((x: number, z: number) => boolean) | null = null;
  /** how much a thing laid on the ground for the time being raises it (m – the ramp of the hill start on the practice yard, game/drillplay.ts) */
  raise: ((x: number, z: number) => number) | null = null;
  /** how deep the water is at a place where the cover is water (m; game/wading.ts) – the wheels go down to its bed */
  waterDepth: ((x: number, z: number) => number) | null = null;

  constructor(world: World, terrain: TerrainSource) {
    this.world = world;
    this.terrain = terrain;
  }

  sample(x: number, z: number, yRef: number, out: GroundSample): void {
    const hit = this.hit;
    if (this.world.surfaceAt(x, z, yRef, hit)) {
      out.y = hit.y;
      if (hit.node) {
        const gx = hit.node.gx;
        const gz = hit.node.gz;
        const l = Math.hypot(gx, 1, gz);
        out.nx = -gx / l;
        out.ny = 1 / l;
        out.nz = -gz / l;
      } else if (hit.edge) {
        // slope of the centreline at this station
        const pl = hit.edge.pl;
        samplePolyline(pl, hit.s, this.tmp);
        const i = this.tmp.seg;
        const segLen = pl.cum[i + 1] - pl.cum[i];
        const slope = segLen > 1e-6 ? (pl.pts[i * 3 + 4] - pl.pts[i * 3 + 1]) / segLen : 0;
        const nx = -slope * this.tmp.tx;
        const nz = -slope * this.tmp.tz;
        const l = Math.hypot(nx, 1, nz);
        out.nx = nx / l;
        out.ny = 1 / l;
        out.nz = nz / l;
      } else {
        out.nx = 0;
        out.ny = 1;
        out.nz = 0;
      }
      out.grip = this.even ? 1 : SURF_GRIP[hit.surf] * this.weatherGrip;
      out.rolling = this.even ? 1 : SURF_ROLLING[hit.surf];
      this.lastY = out.y;
      return;
    }
    const t = this.terrain;
    let y = t.heightAt(x, z);
    if (Number.isNaN(y)) {
      // tile not loaded (yet): pretend the last known ground continues
      out.y = this.lastY;
      out.nx = 0;
      out.ny = 1;
      out.nz = 0;
      out.grip = 0.5;
      out.rolling = 3;
      return;
    }
    const e = 0.7;
    let hx = t.heightAt(x + e, z);
    let hz = t.heightAt(x, z + e);
    if (Number.isNaN(hx)) hx = y;
    if (Number.isNaN(hz)) hz = y;
    if (this.raise) {
      y += this.raise(x, z);
      hx += this.raise(x + e, z);
      hz += this.raise(x, z + e);
    }
    const nx = -(hx - y) / e;
    const nz = -(hz - y) / e;
    const l = Math.hypot(nx, 1, nz);
    out.y = y;
    out.nx = nx / l;
    out.ny = 1 / l;
    out.nz = nz / l;
    const c = t.coverAt(x, z);
    if (c === COVER.ASPHALT || c === COVER.PAVED || this.paved?.(x, z)) {
      out.grip = 0.95 * this.weatherGrip;
      out.rolling = 1.1;
    } else if (c === COVER.WATER) {
      const depth = this.waterDepth ? this.waterDepth(x, z) : 0;
      out.y = y - depth;
      out.grip = 0.3;
      out.rolling = 12 + 10 * depth;
      this.lastY = out.y;
      return;
    } else if (c === COVER.FARMLAND || c === COVER.BARE) {
      out.grip = 0.45 * this.weatherGrip;
      out.rolling = 5;
    } else {
      out.grip = 0.5 * this.weatherGrip;
      out.rolling = 3.5;
    }
    if (this.even) {
      out.grip = 1;
      out.rolling = 1;
    }
    this.lastY = y;
  }
}
