// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where a vehicle may be put down: the reckoning behind "a car here"
 * (game/spawncar.ts), behind a start at the very place chosen ("place
 * precisely") and behind the vehicle standing behind the main menu.
 *
 * A vehicle can only be put where the world is in memory – the tiles that
 * are loaded round the player (`LoadedArea`, drawn on the large map as a
 * line round them) – and only where it stands free: not in a wall (the
 * collider says that) and not inside a building (the footprints of the
 * buildings say that: the collider only knows their walls).  When the place
 * asked for is not free, the nearest free one round it is taken.
 *
 * And a tap on the 3D picture: where the ray from the eye through the finger
 * meets the ground, and whether it meets a vehicle standing there first.
 * Everything here is plain arithmetic, tested in tests/game/spawnplace.test.ts.
 */

/**
 * The start places chosen "precisely" (at the very place, not in the lane of
 * the nearest road): the game fits them to the ground and the vehicle once
 * it is loaded there.
 */
export const exactSpots = new WeakSet<object>();

/** A square tile of the world that is loaded: its centre and side (m). */
export interface TileBox {
  cx: number;
  cz: number;
  size: number;
}

/** The tiles in memory: where a vehicle may be put, and the line round them for the map. */
export class LoadedArea {
  private readonly tiles = new Map<string, TileBox>();
  private outlineCache: Float32Array | null = null;

  set(key: string, box: TileBox, loaded: boolean): void {
    if (loaded) this.tiles.set(key, { cx: box.cx, cz: box.cz, size: box.size });
    else this.tiles.delete(key);
    this.outlineCache = null;
  }

  clear(): void {
    this.tiles.clear();
    this.outlineCache = null;
  }

  get size(): number {
    return this.tiles.size;
  }

  /** Is (x, z) on a loaded tile, at least `margin` metres inside the edge of the loaded area? */
  has(x: number, z: number, margin = 0): boolean {
    if (margin <= 0) return this.on(x, z);
    return this.on(x, z) && this.on(x - margin, z) && this.on(x + margin, z) && this.on(x, z - margin) && this.on(x, z + margin);
  }

  private on(x: number, z: number): boolean {
    for (const t of this.tiles.values()) {
      const h = t.size / 2;
      if (x >= t.cx - h && x <= t.cx + h && z >= t.cz - h && z <= t.cz + h) return true;
    }
    return false;
  }

  /** The line round the loaded area: the sides of the tiles that no other loaded tile shares (x1, z1, x2, z2 per side). */
  outline(): Float32Array {
    if (this.outlineCache) return this.outlineCache;
    this.outlineCache = tileOutline([...this.tiles.values()]);
    return this.outlineCache;
  }
}

/** The outer sides of a set of square tiles of one grid (x1, z1, x2, z2 per side). */
export function tileOutline(tiles: readonly TileBox[]): Float32Array {
  const key = (x: number, z: number): string => `${Math.round(x * 10)}|${Math.round(z * 10)}`;
  const at = new Set(tiles.map((t) => key(t.cx, t.cz)));
  const out: number[] = [];
  for (const t of tiles) {
    const h = t.size / 2;
    const x0 = t.cx - h;
    const x1 = t.cx + h;
    const z0 = t.cz - h;
    const z1 = t.cz + h;
    if (!at.has(key(t.cx, t.cz - t.size))) out.push(x0, z0, x1, z0);
    if (!at.has(key(t.cx + t.size, t.cz))) out.push(x1, z0, x1, z1);
    if (!at.has(key(t.cx, t.cz + t.size))) out.push(x1, z1, x0, z1);
    if (!at.has(key(t.cx - t.size, t.cz))) out.push(x0, z1, x0, z0);
  }
  return Float32Array.from(out);
}

/** Is (x, z) inside the ring that starts at `o` (x, z pairs) and has `n` corners? */
export function inRing(x: number, z: number, pts: ArrayLike<number>, o: number, n: number): boolean {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[o + i * 2];
    const zi = pts[o + i * 2 + 1];
    const xj = pts[o + j * 2];
    const zj = pts[o + j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

interface TileRings {
  pts: ArrayLike<number>;
  counts: ArrayLike<number>;
  /** per ring: its first number in `pts`, and its box (x0, z0, x1, z1) */
  start: Uint32Array;
  box: Float32Array;
  /** of all rings: x0, z0, x1, z1 */
  all: [number, number, number, number];
}

/** The footprints of the buildings of the loaded tiles (the rings of their walls): is a point inside one? */
export class Footprints {
  private readonly tiles = new Map<string, TileRings>();

  set(key: string, pts: ArrayLike<number> | null, counts: ArrayLike<number> | null): void {
    if (!pts || !counts || counts.length === 0) {
      this.tiles.delete(key);
      return;
    }
    const start = new Uint32Array(counts.length);
    const box = new Float32Array(counts.length * 4);
    const all: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    let o = 0;
    for (let r = 0; r < counts.length; r++) {
      start[r] = o;
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (let i = 0; i < counts[r]; i++) {
        const x = pts[o + i * 2];
        const z = pts[o + i * 2 + 1];
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      box.set([x0, z0, x1, z1], r * 4);
      all[0] = Math.min(all[0], x0);
      all[1] = Math.min(all[1], z0);
      all[2] = Math.max(all[2], x1);
      all[3] = Math.max(all[3], z1);
      o += counts[r] * 2;
    }
    this.tiles.set(key, { pts, counts, start, box, all });
  }

  remove(key: string): void {
    this.tiles.delete(key);
  }

  /** Is (x, z) inside a building? */
  inside(x: number, z: number): boolean {
    for (const t of this.tiles.values()) {
      if (x < t.all[0] || x > t.all[2] || z < t.all[1] || z > t.all[3]) continue;
      for (let r = 0; r < t.counts.length; r++) {
        const b = r * 4;
        if (x < t.box[b] || x > t.box[b + 2] || z < t.box[b + 1] || z > t.box[b + 3]) continue;
        if (inRing(x, z, t.pts, t.start[r], t.counts[r])) return true;
      }
    }
    return false;
  }
}

/** The outline of a vehicle in the plan, from its model origin (as VehicleDef.outline). */
export interface Outline {
  front: number;
  rear: number;
  hw: number;
}

/**
 * The points of a vehicle's plan that must not lie inside a building: its
 * middle, the middle of its front and of its rear, and its four corners.
 */
export function outlinePoints(x: number, z: number, yaw: number, o: Outline): number[] {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  // (right of the way it faces)
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const pts = [x, z, x + fx * o.front, z + fz * o.front, x - fx * o.rear, z - fz * o.rear];
  for (const a of [o.front, -o.rear]) for (const s of [o.hw, -o.hw]) pts.push(x + fx * a + rx * s, z + fz * a + rz * s);
  return pts;
}

/** Does the plan of a vehicle standing at (x, z), facing yaw, reach into a building? */
export function inBuilding(x: number, z: number, yaw: number, o: Outline, inside: (x: number, z: number) => boolean): boolean {
  const p = outlinePoints(x, z, yaw, o);
  for (let i = 0; i < p.length; i += 2) if (inside(p[i], p[i + 1])) return true;
  return false;
}

/**
 * The free place nearest to (x, z): (x, z) itself if it is free, else the
 * first free one on rings round it, `step` metres apart, out to `maxR` – the
 * vehicle facing `yaw` (or the other way, if only that fits).  Null: none.
 */
export function freeNear(x: number, z: number, yaw: number, free: (x: number, z: number, yaw: number) => boolean, maxR = 40, step = 1.5): { x: number; z: number; yaw: number } | null {
  if (free(x, z, yaw)) return { x, z, yaw };
  for (let r = step; r <= maxR + 1e-9; r += step) {
    const n = Math.max(6, Math.round((2 * Math.PI * r) / step));
    for (const y of [yaw, yaw + Math.PI]) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (free(px, pz, y)) return { x: px, z: pz, yaw: y };
      }
    }
  }
  return null;
}

/**
 * A place beside somebody standing at (x, z) facing yaw, for a car to be put
 * at: a few steps to the right, else to the left, ahead, behind – the car
 * facing the same way – else the nearest free place round them.
 */
export function besidePlace(x: number, z: number, yaw: number, free: (x: number, z: number, yaw: number) => boolean, maxR = 30): { x: number; z: number; yaw: number } | null {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  for (const [a, s] of [
    [0, 3.5],
    [0, -3.5],
    [0, 5],
    [0, -5],
    [6, 0],
    [-6, 0],
  ]) {
    const px = x + fx * a + rx * s;
    const pz = z + fz * a + rz * s;
    if (free(px, pz, yaw)) return { x: px, z: pz, yaw };
  }
  return freeNear(x, z, yaw, (px, pz, py) => Math.hypot(px - x, pz - z) >= 2.5 && free(px, pz, py), maxR);
}

/**
 * Where a ray (from the eye o, along d) first meets the ground (heightAt:
 * NaN where the ground is not known) – within `max` metres.  Null: it does not.
 */
export function rayGround(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, heightAt: (x: number, z: number) => number, max = 800): { x: number; y: number; z: number } | null {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return null;
  dx /= len;
  dy /= len;
  dz /= len;
  const above = (t: number): number => {
    const h = heightAt(ox + dx * t, oz + dz * t);
    return Number.isNaN(h) ? NaN : oy + dy * t - h;
  };
  let t0 = 0;
  let a0 = above(0);
  for (let t = 0; t < max; ) {
    const t1 = t + Math.max(0.5, t * 0.02);
    const a1 = above(t1);
    if (!Number.isNaN(a0) && !Number.isNaN(a1) && a0 >= 0 && a1 < 0) {
      // between the two: halve until it is near enough
      let lo = t0;
      let hi = t1;
      for (let i = 0; i < 16; i++) {
        const m = (lo + hi) / 2;
        if (above(m) >= 0) lo = m;
        else hi = m;
      }
      const t2 = (lo + hi) / 2;
      const x = ox + dx * t2;
      const z = oz + dz * t2;
      return { x, y: heightAt(x, z), z };
    }
    t0 = t1;
    a0 = a1;
    t = t1;
  }
  return null;
}

/** A vehicle standing: its plan (from its model origin at x, y, z, facing yaw) and its height. */
export interface StandingBox extends Outline {
  x: number;
  y: number;
  z: number;
  yaw: number;
  height: number;
}

/** How far along a ray (from o, along d – of any length) it meets a standing vehicle's box; −1: it does not. */
export function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: StandingBox): number {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return -1;
  // into the vehicle's frame: along its front, to its right, up
  const fx = -Math.sin(b.yaw);
  const fz = -Math.cos(b.yaw);
  const rx = Math.cos(b.yaw);
  const rz = -Math.sin(b.yaw);
  const px = ox - b.x;
  const pz = oz - b.z;
  const o = [px * fx + pz * fz, px * rx + pz * rz, oy - b.y];
  const d = [(dx * fx + dz * fz) / len, (dx * rx + dz * rz) / len, dy / len];
  const lo = [-b.rear, -b.hw, 0];
  const hi = [b.front, b.hw, b.height];
  let tn = 0;
  let tf = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < lo[i] || o[i] > hi[i]) return -1;
      continue;
    }
    let a = (lo[i] - o[i]) / d[i];
    let c = (hi[i] - o[i]) / d[i];
    if (a > c) [a, c] = [c, a];
    tn = Math.max(tn, a);
    tf = Math.min(tf, c);
    if (tn > tf) return -1;
  }
  return tn;
}
