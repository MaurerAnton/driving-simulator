// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the faces of a building need for their facades.
 *
 * Every corner of a face carries four numbers for the shader: where on the
 * face it lies (u along it, v up it) and, for walls, how long and how high
 * the wall is (L, H) – rows and columns of windows are fitted to these.
 * They follow from where the corners of the face are, so a tile does not
 * store them: it says for each face which rule gives them (FACE), and the
 * game works them out when it loads the tile.  Only the faces for which the
 * rule does not give what the map build wanted (to a few centimetres) keep
 * their numbers.  That saves about an eighth of a tile in town.
 *
 * A face is a run of corners that follow each other in the list of
 * vertices, in the order of its outline.
 */
import { POS_XZ_SCALE, POS_Y_SCALE, UV_SCALE } from './tilefmt.ts';
import { wasmUnpackFaces } from '../wasm/kernels.ts';

export const FACE = {
  /** the four numbers of each corner are stored */
  EXPLICIT: 0,
  /** a level roof: u east, v south */
  ROOF_FLAT: 1,
  /** a sloping roof: u level along it, v up the slope */
  ROOF_SLOPED: 2,
  /** a wall: u level along it, v up from its lowest corner */
  WALL: 3,
  /** a wall whose foot is sunk into the ground (SINK): v counts from where the foot was */
  WALL_SUNK: 4,
} as const;

/** how far the map build sinks the foot of a wall that stands on the ground into it */
export const SINK = 1.6;
/** a corner higher than this above the foot of a wall can be its eave */
const EAVE_ABOVE = 0.6;
/** how far (in units of UV_SCALE) what a rule gives may be from what the map build wanted */
const TOLERANCE = 2;
/** a run is written as  corners × 8 + rule  in 16 bits */
const MAX_RUN = 8191;

const q16 = (v: number): number => Math.max(-32767, Math.min(32767, Math.round(v / UV_SCALE)));

/**
 * The numbers of the corners `first` … `first + n − 1` by a rule, written to
 * `out` (four per corner, at the corner's place in the list).  False if the
 * rule cannot be applied to this face.
 */
export function deriveFace(pos: ArrayLike<number>, first: number, n: number, rule: number, out: Int16Array): boolean {
  if (n < 3) return false;
  const o = first * 3;
  if (rule === FACE.ROOF_FLAT) {
    let uMin = Infinity;
    let vMin = Infinity;
    for (let i = 0; i < n; i++) {
      uMin = Math.min(uMin, pos[o + i * 3]);
      vMin = Math.min(vMin, pos[o + i * 3 + 2]);
    }
    for (let i = 0; i < n; i++) {
      const k = (first + i) * 4;
      out[k] = q16((pos[o + i * 3] - uMin) * POS_XZ_SCALE);
      out[k + 1] = q16((pos[o + i * 3 + 2] - vMin) * POS_XZ_SCALE);
      out[k + 2] = 0;
      out[k + 3] = 0;
    }
    return true;
  }
  // which way the face looks (Newell): the corners in metres, around the first one
  const x0 = pos[o];
  const y0 = pos[o + 1];
  const z0 = pos[o + 2];
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < n; i++) {
    const a = o + i * 3;
    const b = o + ((i + 1) % n) * 3;
    const ax = (pos[a] - x0) * POS_XZ_SCALE;
    const ay = (pos[a + 1] - y0) * POS_Y_SCALE;
    const az = (pos[a + 2] - z0) * POS_XZ_SCALE;
    const bx = (pos[b] - x0) * POS_XZ_SCALE;
    const by = (pos[b + 1] - y0) * POS_Y_SCALE;
    const bz = (pos[b + 2] - z0) * POS_XZ_SCALE;
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const hl = Math.sqrt(nx * nx + nz * nz);
  if (!(hl > 1e-9)) return false;
  // level, along the face
  const ux = nz / hl;
  const uz = -nx / hl;
  let uMin = Infinity;
  let uMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const u = (pos[o + i * 3] - x0) * POS_XZ_SCALE * ux + (pos[o + i * 3 + 2] - z0) * POS_XZ_SCALE * uz;
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
  }
  if (rule === FACE.ROOF_SLOPED) {
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const mx = nx / nl;
    const my = ny / nl;
    const mz = nz / nl;
    // up the slope: across the normal and the level direction
    let vx = my * uz;
    let vy = mz * ux - mx * uz;
    let vz = -my * ux;
    if (vy < 0) {
      vx = -vx;
      vy = -vy;
      vz = -vz;
    }
    let vMin = Infinity;
    for (let i = 0; i < n; i++) {
      const v = (pos[o + i * 3] - x0) * POS_XZ_SCALE * vx + (pos[o + i * 3 + 1] - y0) * POS_Y_SCALE * vy + (pos[o + i * 3 + 2] - z0) * POS_XZ_SCALE * vz;
      vMin = Math.min(vMin, v);
    }
    for (let i = 0; i < n; i++) {
      const k = (first + i) * 4;
      const x = (pos[o + i * 3] - x0) * POS_XZ_SCALE;
      const y = (pos[o + i * 3 + 1] - y0) * POS_Y_SCALE;
      const z = (pos[o + i * 3 + 2] - z0) * POS_XZ_SCALE;
      out[k] = q16(x * ux + z * uz - uMin);
      out[k + 1] = q16(x * vx + y * vy + z * vz - vMin);
      out[k + 2] = 0;
      out[k + 3] = 0;
    }
    return true;
  }
  if (rule !== FACE.WALL && rule !== FACE.WALL_SUNK) return false;
  // a wall: heights above its foot (where the foot was before it was sunk)
  let low = Infinity;
  for (let i = 0; i < n; i++) low = Math.min(low, pos[o + i * 3 + 1]);
  const sunk = rule === FACE.WALL_SUNK;
  const lo = low * POS_Y_SCALE + (sunk ? SINK : 0);
  const height = (i: number): number => {
    const y = pos[o + i * 3 + 1] * POS_Y_SCALE;
    return sunk && y < low * POS_Y_SCALE + SINK / 2 ? y + SINK : y;
  };
  let hi = -Infinity;
  for (let i = 0; i < n; i++) hi = Math.max(hi, height(i));
  let eave = hi;
  for (let i = 0; i < n; i++) {
    const y = height(i);
    if (y > lo + EAVE_ABOVE && y < eave) eave = y;
  }
  const L = q16(uMax - uMin);
  const H = q16(eave - lo);
  for (let i = 0; i < n; i++) {
    const k = (first + i) * 4;
    out[k] = q16((pos[o + i * 3] - x0) * POS_XZ_SCALE * ux + (pos[o + i * 3 + 2] - z0) * POS_XZ_SCALE * uz - uMin);
    out[k + 1] = q16(height(i) - lo);
    out[k + 2] = L;
    out[k + 3] = H;
  }
  return true;
}

export interface PackedFaces {
  /** per run of corners: corners × 8 + rule */
  run: Uint16Array;
  /** the four numbers of each corner of the runs without a rule, in their order */
  uvx: Int16Array;
  /** how many corners were given a rule */
  ruled: number;
}

/**
 * For the map build: find the faces of a mesh (triangles that share corners
 * belong together; a face's corners follow each other in the list) and the
 * rule that gives each face's numbers `a16` (four per corner).
 */
export function packFaces(pos: Int16Array, idx: ArrayLike<number>, a16: Int16Array): PackedFaces {
  const count = pos.length / 3;
  // which corners belong together
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = find(idx[t]);
    const b = find(idx[t + 1]);
    const c = find(idx[t + 2]);
    const m = Math.min(a, b, c);
    parent[a] = m;
    parent[b] = m;
    parent[c] = m;
  }
  const run: number[] = [];
  const uvx: number[] = [];
  const tmp = new Int16Array(a16.length);
  let ruled = 0;
  const explicit = (first: number, n: number): void => {
    for (let i = first * 4; i < (first + n) * 4; i++) uvx.push(a16[i]);
    // (runs without a rule that follow each other are one run)
    const last = run.length - 1;
    if (last >= 0 && (run[last] & 7) === FACE.EXPLICIT && (run[last] >> 3) + n <= MAX_RUN) run[last] += n << 3;
    else run.push((n << 3) | FACE.EXPLICIT);
  };
  const fits = (first: number, n: number): boolean => {
    for (let i = first * 4; i < (first + n) * 4; i++) if (Math.abs(tmp[i] - a16[i]) > TOLERANCE) return false;
    return true;
  };
  let first = 0;
  while (first < count) {
    const group = find(first);
    let n = 1;
    while (first + n < count && n < MAX_RUN && find(first + n) === group) n++;
    let rule: number = FACE.EXPLICIT;
    for (const r of [FACE.WALL_SUNK, FACE.WALL, FACE.ROOF_SLOPED, FACE.ROOF_FLAT]) {
      if (deriveFace(pos, first, n, r, tmp) && fits(first, n)) {
        rule = r;
        break;
      }
    }
    if (rule === FACE.EXPLICIT) explicit(first, n);
    else {
      run.push((n << 3) | rule);
      ruled += n;
    }
    first += n;
  }
  return { run: Uint16Array.from(run), uvx: Int16Array.from(uvx), ruled };
}

/** For the game: the four numbers of every corner, from the runs of a tile. */
export function unpackFaces(pos: ArrayLike<number>, run: ArrayLike<number>, uvx: ArrayLike<number> | null): Int16Array {
  // (the same in WebAssembly where it is there – src/wasm/kernels.ts; null: not there)
  const fast = wasmUnpackFaces(pos, run, uvx);
  if (fast) return fast;
  const out = new Int16Array((pos.length / 3) * 4);
  let first = 0;
  let x = 0;
  for (let r = 0; r < run.length; r++) {
    const n = run[r] >> 3;
    const rule = run[r] & 7;
    if (rule === FACE.EXPLICIT) {
      if (uvx) for (let i = first * 4; i < (first + n) * 4; i++) out[i] = uvx[x++];
    } else deriveFace(pos, first, n, rule, out);
    first += n;
  }
  return out;
}
