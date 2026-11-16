// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 2D geometry helpers on the ground plane.
 *
 * Ground-plane convention: points are (x, z) with x = east and z = SOUTH.
 * Seen from above this is a left-handed pair, so "left of travel" is spelled
 * out explicitly here instead of relying on the usual maths conventions:
 *
 *   travel direction d = (dx, dz)   →   left = (dz, -dx),  right = (-dz, dx)
 *
 * `angleOf` returns the mathematical angle with north up (counter-clockwise
 * positive when seen from above), so sorting by it walks around a junction
 * counter-clockwise.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Counter-clockwise (seen from above) angle of a ground direction, 0 = east. */
export function angleOf(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

/** Wrap to (-π, π]. */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** Wrap to [0, 2π). */
export function wrap2Pi(a: number): number {
  a = a % TAU;
  return a < 0 ? a + TAU : a;
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz;
}

export function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(bx - ax, bz - az);
}

/**
 * Intersection of two infinite lines p + t·d and q + u·e.
 * Returns [t, u] or null when (nearly) parallel.
 */
export function lineLine(
  px: number,
  pz: number,
  dx: number,
  dz: number,
  qx: number,
  qz: number,
  ex: number,
  ez: number,
): [number, number] | null {
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-9) return null;
  const rx = qx - px;
  const rz = qz - pz;
  return [(rx * ez - rz * ex) / den, (rx * dz - rz * dx) / den];
}

/** Segment/segment intersection parameters in [0,1] or null. */
export function segSeg(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): [number, number] | null {
  const r = lineLine(ax, az, bx - ax, bz - az, cx, cz, dx - cx, dz - cz);
  if (!r) return null;
  if (r[0] < 0 || r[0] > 1 || r[1] < 0 || r[1] > 1) return null;
  return r;
}

/** Signed area of a flat [x,z,x,z,…] ring (positive = counter-clockwise seen from above). */
export function ringArea(ring: ArrayLike<number>): number {
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    // north-up coordinates are (x, -z)
    a += ring[i] * -ring[j + 1] - ring[j] * -ring[i + 1];
  }
  return a / 2;
}

/** Even-odd point-in-ring test for a flat [x,z,…] ring. */
export function pointInRing(x: number, z: number, ring: ArrayLike<number>): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i];
    const zi = ring[i + 1];
    const xj = ring[j];
    const zj = ring[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Closest point on segment a-b to p. Returns parameter t in [0,1]. */
export function projectOnSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  if (l2 < 1e-12) return 0;
  return clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
}

/**
 * A polyline stored as stride-3 [x, y, z] vertices (y = height) with cached
 * cumulative ground-plane arc length.  Used for road centrelines and lanes.
 */
export interface Polyline3 {
  pts: Float32Array | Float64Array | number[];
  cum: Float32Array | Float64Array | number[];
  len: number;
}

export function makePolyline(pts: Float32Array | Float64Array | number[]): Polyline3 {
  const n = pts.length / 3;
  const cum = new Float64Array(n);
  let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 2] - pts[i * 3 - 1]);
    cum[i] = acc;
  }
  return { pts, cum, len: acc };
}

export interface PolySample {
  x: number;
  y: number;
  z: number;
  /** unit ground-plane tangent */
  tx: number;
  tz: number;
  /** segment index used */
  seg: number;
}

export function newPolySample(): PolySample {
  return { x: 0, y: 0, z: 0, tx: 1, tz: 0, seg: 0 };
}

/** Sample position and tangent at arc length `s` (clamped). `hint` = previous segment index. */
export function samplePolyline(pl: Polyline3, s: number, out: PolySample, hint = 0): PolySample {
  const { pts, cum } = pl;
  const n = cum.length;
  if (n < 2) {
    out.x = pts[0];
    out.y = pts[1];
    out.z = pts[2];
    out.tx = 1;
    out.tz = 0;
    out.seg = 0;
    return out;
  }
  s = clamp(s, 0, pl.len);
  let i = clamp(hint, 0, n - 2);
  if (cum[i] > s || cum[i + 1] < s) {
    // binary search
    let lo = 0;
    let hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    i = lo;
  }
  const segLen = cum[i + 1] - cum[i];
  const t = segLen > 1e-9 ? (s - cum[i]) / segLen : 0;
  const a = i * 3;
  const dx = pts[a + 3] - pts[a];
  const dz = pts[a + 5] - pts[a + 2];
  const l = Math.hypot(dx, dz) || 1;
  out.x = pts[a] + dx * t;
  out.y = pts[a + 1] + (pts[a + 4] - pts[a + 1]) * t;
  out.z = pts[a + 2] + dz * t;
  out.tx = dx / l;
  out.tz = dz / l;
  out.seg = i;
  return out;
}

export interface PolyProjection {
  /** arc length of the closest point */
  s: number;
  /** signed lateral offset, positive = LEFT of the polyline direction */
  off: number;
  /** squared distance */
  d2: number;
  seg: number;
}

/** Project a point onto a polyline (closest point over all segments in [i0, i1]). */
export function projectOnPolyline(
  pl: Polyline3,
  x: number,
  z: number,
  out: PolyProjection,
  i0 = 0,
  i1 = pl.cum.length - 2,
): PolyProjection {
  const { pts, cum } = pl;
  let best = Infinity;
  let bestS = 0;
  let bestOff = 0;
  let bestSeg = i0;
  for (let i = i0; i <= i1; i++) {
    const a = i * 3;
    const ax = pts[a];
    const az = pts[a + 2];
    const dx = pts[a + 3] - ax;
    const dz = pts[a + 5] - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-12 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + dx * t;
    const cz = az + dz * t;
    const ex = x - cx;
    const ez = z - cz;
    const d2 = ex * ex + ez * ez;
    if (d2 < best) {
      best = d2;
      const l = Math.sqrt(l2) || 1;
      bestS = cum[i] + l * t;
      // left of direction (dx,dz) is (dz,-dx)
      bestOff = (ex * dz - ez * dx) / l;
      bestSeg = i;
    }
  }
  out.s = bestS;
  out.off = bestOff;
  out.d2 = best;
  out.seg = bestSeg;
  return out;
}

/**
 * Offset a stride-3 polyline sideways (positive = left) with mitred joints.
 * Heights are copied.  Returns a new stride-3 array of the same vertex count.
 */
export function offsetPolyline(pts: ArrayLike<number>, off: number, miterLimit = 2.5): Float64Array {
  const n = pts.length / 3;
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = i * 3;
    let nx = 0;
    let nz = 0;
    let scale = 1;
    if (i > 0 && i < n - 1) {
      let d1x = pts[a] - pts[a - 3];
      let d1z = pts[a + 2] - pts[a - 1];
      let d2x = pts[a + 3] - pts[a];
      let d2z = pts[a + 5] - pts[a + 2];
      const l1 = Math.hypot(d1x, d1z) || 1;
      const l2 = Math.hypot(d2x, d2z) || 1;
      d1x /= l1;
      d1z /= l1;
      d2x /= l2;
      d2z /= l2;
      // average of the two left normals
      nx = d1z + d2z;
      nz = -d1x - d2x;
      const nl = Math.hypot(nx, nz);
      if (nl < 1e-6) {
        nx = d1z;
        nz = -d1x;
      } else {
        nx /= nl;
        nz /= nl;
        // miter length = 1 / cos(half angle)
        const cosHalf = nx * d1z + nz * -d1x;
        scale = Math.min(miterLimit, 1 / Math.max(cosHalf, 1e-3));
      }
    } else {
      const b = i === 0 ? a : a - 3;
      const dx = pts[b + 3] - pts[b];
      const dz = pts[b + 5] - pts[b + 2];
      const l = Math.hypot(dx, dz) || 1;
      nx = dz / l;
      nz = -dx / l;
    }
    out[a] = pts[a] + nx * off * scale;
    out[a + 1] = pts[a + 1];
    out[a + 2] = pts[a + 2] + nz * off * scale;
  }
  return out;
}

/** Cut a stride-3 polyline to the arc-length window [s0, s1]. */
export function slicePolyline(pl: Polyline3, s0: number, s1: number): Float64Array {
  const out: number[] = [];
  const tmp = newPolySample();
  s0 = clamp(s0, 0, pl.len);
  s1 = clamp(s1, s0, pl.len);
  samplePolyline(pl, s0, tmp);
  out.push(tmp.x, tmp.y, tmp.z);
  const n = pl.cum.length;
  for (let i = tmp.seg + 1; i < n; i++) {
    if (pl.cum[i] <= s0 + 1e-6) continue;
    if (pl.cum[i] >= s1 - 1e-6) break;
    out.push(pl.pts[i * 3], pl.pts[i * 3 + 1], pl.pts[i * 3 + 2]);
  }
  samplePolyline(pl, s1, tmp);
  out.push(tmp.x, tmp.y, tmp.z);
  return Float64Array.from(out);
}

/** Uniform spatial hash over the ground plane for coarse neighbourhood queries. */
export class Grid2<T> {
  readonly cell: number;
  private readonly map = new Map<number, T[]>();

  constructor(cell: number) {
    this.cell = cell;
  }

  private key(ix: number, iz: number): number {
    return (ix + 32768) * 65536 + (iz + 32768);
  }

  insertBox(minX: number, minZ: number, maxX: number, maxZ: number, item: T): void {
    const c = this.cell;
    const x0 = Math.floor(minX / c);
    const x1 = Math.floor(maxX / c);
    const z0 = Math.floor(minZ / c);
    const z1 = Math.floor(maxZ / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = this.key(ix, iz);
        let arr = this.map.get(k);
        if (!arr) this.map.set(k, (arr = []));
        arr.push(item);
      }
    }
  }

  insertPoint(x: number, z: number, item: T): void {
    this.insertBox(x, z, x, z, item);
  }

  /** Take an item out again – with the box it was put in with. */
  removeBox(minX: number, minZ: number, maxX: number, maxZ: number, item: T): void {
    const c = this.cell;
    const x0 = Math.floor(minX / c);
    const x1 = Math.floor(maxX / c);
    const z0 = Math.floor(minZ / c);
    const z1 = Math.floor(maxZ / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = this.key(ix, iz);
        const arr = this.map.get(k);
        if (!arr) continue;
        const i = arr.indexOf(item);
        if (i < 0) continue;
        arr[i] = arr[arr.length - 1];
        arr.pop();
        if (arr.length === 0) this.map.delete(k);
      }
    }
  }

  /** Items whose cells overlap the query cell containing (x,z). */
  at(x: number, z: number): readonly T[] {
    const c = this.cell;
    return this.map.get(this.key(Math.floor(x / c), Math.floor(z / c))) ?? EMPTY;
  }

  /** Visit every item in cells overlapping the box (items may repeat). */
  queryBox(minX: number, minZ: number, maxX: number, maxZ: number, visit: (item: T) => void): void {
    const c = this.cell;
    const x0 = Math.floor(minX / c);
    const x1 = Math.floor(maxX / c);
    const z0 = Math.floor(minZ / c);
    const z1 = Math.floor(maxZ / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const arr = this.map.get(this.key(ix, iz));
        if (arr) for (let i = 0; i < arr.length; i++) visit(arr[i]);
      }
    }
  }
}

const EMPTY: readonly never[] = [];

/** Small deterministic PRNG (mulberry32) so generated content is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash → [0,1). */
export function hash01(n: number): number {
  let t = (n ^ 0x9e3779b9) >>> 0;
  t = Math.imul(t ^ (t >>> 16), 0x85ebca6b);
  t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}
