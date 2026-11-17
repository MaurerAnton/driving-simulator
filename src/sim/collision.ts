// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Collisions of the player's car with scenery: buildings, walls, guard
 * rails, trees, lamp and sign posts.  The car is approximated by three
 * circles along its axis, the scenery by line segments and discs in a
 * uniform grid that follows the loaded map tiles.
 */
import type { Vehicle } from './vehicle/vehicle.ts';

interface Prim {
  /** 0 = segment (x1,z1,x2,z2), 1 = disc (x1,z1,r) */
  kind: number;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  r: number;
  /** base height; NaN = applies at any height */
  y: number;
}

export interface CollisionSource {
  key: string;
  /** building footprints: flat x,z rings and their vertex counts */
  rings: Float32Array | null;
  ringCounts: Uint16Array | null;
  /** sides of the footprints that do not count (they would stand in a lane): one bit per side, in the order of `rings` */
  ringSkip?: Uint8Array | null;
  /** x1,z1,x2,z2,y per segment */
  segments: Float32Array | null;
  /** x,y,z,radius per post / trunk */
  discs: number[];
}

const CELL = 16;

export class SceneryCollider {
  private readonly grid = new Map<number, Prim[]>();
  private readonly byTile = new Map<string, Array<[number, Prim]>>();
  /** circle centres along the car axis (model frame, metres from the wheelbase centre; - = front) */
  private offsets: readonly number[] = [-1.28, -0.05, 1.18];
  private radius = 0.93;
  private readonly tmp = new Float64Array(3);

  /** Another vehicle: circle centres along its axis (metres from the model origin; - = front) and their radius. */
  setShape(offsets: readonly number[], radius: number): void {
    this.offsets = offsets;
    this.radius = radius;
  }

  private static key(ix: number, iz: number): number {
    return (ix + 2048) * 4096 + (iz + 2048);
  }

  private insert(tile: Array<[number, Prim]>, p: Prim): void {
    const pad = p.kind === 1 ? p.r : 0;
    const x0 = Math.floor((Math.min(p.x1, p.kind === 0 ? p.x2 : p.x1) - pad) / CELL);
    const x1 = Math.floor((Math.max(p.x1, p.kind === 0 ? p.x2 : p.x1) + pad) / CELL);
    const z0 = Math.floor((Math.min(p.z1, p.kind === 0 ? p.z2 : p.z1) - pad) / CELL);
    const z1 = Math.floor((Math.max(p.z1, p.kind === 0 ? p.z2 : p.z1) + pad) / CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = SceneryCollider.key(ix, iz);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(p);
        tile.push([k, p]);
      }
    }
  }

  add(src: CollisionSource): void {
    const tile: Array<[number, Prim]> = [];
    if (src.rings && src.ringCounts) {
      let o = 0;
      const skip = src.ringSkip ?? null;
      for (const n of src.ringCounts) {
        for (let i = 0; i < n; i++) {
          const side = o / 2 + i;
          if (skip && (skip[side >> 3] & (1 << (side & 7))) !== 0) continue;
          const j = (i + 1) % n;
          this.insert(tile, { kind: 0, x1: src.rings[o + i * 2], z1: src.rings[o + i * 2 + 1], x2: src.rings[o + j * 2], z2: src.rings[o + j * 2 + 1], r: 0, y: NaN });
        }
        o += n * 2;
      }
    }
    if (src.segments) {
      const s = src.segments;
      for (let i = 0; i + 4 < s.length; i += 5) this.insert(tile, { kind: 0, x1: s[i], z1: s[i + 1], x2: s[i + 2], z2: s[i + 3], r: 0, y: s[i + 4] });
    }
    for (let i = 0; i + 3 < src.discs.length; i += 4) {
      this.insert(tile, { kind: 1, x1: src.discs[i], z1: src.discs[i + 2], x2: 0, z2: 0, r: src.discs[i + 3], y: src.discs[i + 1] });
    }
    this.byTile.set(src.key, tile);
  }

  remove(key: string): void {
    const tile = this.byTile.get(key);
    if (!tile) return;
    for (const [k, p] of tile) {
      const list = this.grid.get(k);
      if (!list) continue;
      const i = list.indexOf(p);
      if (i >= 0) {
        list[i] = list[list.length - 1];
        list.pop();
      }
      if (list.length === 0) this.grid.delete(k);
    }
    this.byTile.delete(key);
  }

  /**
   * Would the vehicle touch anything standing at (x, z) on the ground at
   * height y, heading `yaw`?  `margin` metres of air are asked for on top.
   * For putting the vehicle somewhere: not into a wall or onto a post.
   */
  blocked(x: number, y: number, z: number, yaw: number, margin = 0.1): boolean {
    const R = this.radius + margin;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    for (let c = 0; c < this.offsets.length; c++) {
      // (the model looks along -z: forward = (-sin yaw, -cos yaw), and offsets count backwards)
      const cx = x + sin * this.offsets[c];
      const cz = z + cos * this.offsets[c];
      const ix0 = Math.floor((cx - R) / CELL);
      const ix1 = Math.floor((cx + R) / CELL);
      const iz0 = Math.floor((cz - R) / CELL);
      const iz1 = Math.floor((cz + R) / CELL);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const list = this.grid.get(SceneryCollider.key(ix, iz));
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (!Number.isNaN(p.y) && Math.abs(y - p.y) > 2.6) continue;
            let px = p.x1;
            let pz = p.z1;
            if (p.kind === 0) {
              const dx = p.x2 - p.x1;
              const dz = p.z2 - p.z1;
              const l2 = dx * dx + dz * dz;
              let t = l2 > 1e-9 ? ((cx - p.x1) * dx + (cz - p.z1) * dz) / l2 : 0;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              px = p.x1 + dx * t;
              pz = p.z1 + dz * t;
            }
            const rad = R + (p.kind === 1 ? p.r : 0);
            if ((cx - px) * (cx - px) + (cz - pz) * (cz - pz) < rad * rad) return true;
          }
        }
      }
    }
    return false;
  }

  /** Does a circle of radius `r` at (x, z), on the ground at height y, touch anything?  (Somebody on foot.) */
  circleBlocked(x: number, y: number, z: number, r: number): boolean {
    const ix0 = Math.floor((x - r) / CELL);
    const ix1 = Math.floor((x + r) / CELL);
    const iz0 = Math.floor((z - r) / CELL);
    const iz1 = Math.floor((z + r) / CELL);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const list = this.grid.get(SceneryCollider.key(ix, iz));
        if (!list) continue;
        for (const p of list) {
          if (!Number.isNaN(p.y) && Math.abs(y - p.y) > 2.6) continue;
          let px = p.x1;
          let pz = p.z1;
          if (p.kind === 0) {
            const dx = p.x2 - p.x1;
            const dz = p.z2 - p.z1;
            const l2 = dx * dx + dz * dz;
            let t = l2 > 1e-9 ? ((x - p.x1) * dx + (z - p.z1) * dz) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            px = p.x1 + dx * t;
            pz = p.z1 + dz * t;
          }
          const rad = r + (p.kind === 1 ? p.r : 0);
          if ((x - px) * (x - px) + (z - pz) * (z - pz) < rad * rad) return true;
        }
      }
    }
    return false;
  }

  /** the largest impact speed (m/s) into the wall of a building in the last `resolve` */
  lastBuilding = 0;

  /**
   * Push the car out of anything it penetrates and take the velocity into
   * the obstacle away.  Returns the largest impact speed (m/s) of this call.
   */
  resolve(v: Vehicle): number {
    let impact = 0;
    this.lastBuilding = 0;
    const mo = v.modelOrigin;
    const R = this.radius;
    for (let c = 0; c < this.offsets.length; c++) {
      // circle centre in the world, at centre-of-mass height
      v.toWorld(mo[0], 0, mo[2] + this.offsets[c], this.tmp);
      const cx = this.tmp[0];
      const cy = this.tmp[1];
      const cz = this.tmp[2];
      const ix0 = Math.floor((cx - R) / CELL);
      const ix1 = Math.floor((cx + R) / CELL);
      const iz0 = Math.floor((cz - R) / CELL);
      const iz1 = Math.floor((cz + R) / CELL);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const list = this.grid.get(SceneryCollider.key(ix, iz));
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (!Number.isNaN(p.y) && Math.abs(cy - 0.5 - p.y) > 2.6) continue;
            let px: number;
            let pz: number;
            let rad = R;
            if (p.kind === 0) {
              const dx = p.x2 - p.x1;
              const dz = p.z2 - p.z1;
              const l2 = dx * dx + dz * dz;
              let t = l2 > 1e-9 ? ((cx - p.x1) * dx + (cz - p.z1) * dz) / l2 : 0;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              px = p.x1 + dx * t;
              pz = p.z1 + dz * t;
            } else {
              px = p.x1;
              pz = p.z1;
              rad = R + p.r;
            }
            const nx = cx - px;
            const nz = cz - pz;
            const d2 = nx * nx + nz * nz;
            if (d2 >= rad * rad || d2 < 1e-10) continue;
            const d = Math.sqrt(d2);
            const ux = nx / d;
            const uz = nz / d;
            const depth = rad - d;
            // velocity of the contact point (ground-plane part)
            const rx = px - v.pos[0];
            const rz = pz - v.pos[2];
            const vx = v.vel[0] - v.angVel[1] * -rz;
            const vz = v.vel[2] - v.angVel[1] * rx;
            const vn = vx * ux + vz * uz;
            v.translate(ux * depth, 0, uz * depth);
            if (vn < 0) {
              impact = Math.max(impact, -vn);
              // (into the wall of a building – a footprint, not a fence or a post)
              if (p.kind === 0 && Number.isNaN(p.y)) this.lastBuilding = Math.max(this.lastBuilding, -vn);
              // inelastic hit with a little bounce; applied at centre-of-mass height so the car does not flip
              const m = v.spec.mass * 0.55;
              const j = -(1.15 * vn) * m;
              // scrape friction along the obstacle
              const tx = -uz;
              const tz = ux;
              const vt = vx * tx + vz * tz;
              const jt = -Math.max(-0.35 * j, Math.min(0.35 * j, vt * m));
              v.applyImpulse(px, v.pos[1], pz, ux * j + tx * jt, 0, uz * j + tz * jt);
            }
          }
        }
      }
    }
    return impact;
  }
}
