// SPDX-License-Identifier: AGPL-3.0-only
/** Geometry accumulation per map tile (pipeline side). */
import { POS_XZ_SCALE, POS_Y_SCALE, UV_SCALE, tileKey } from '../../src/world/tilefmt.ts';
import type { SectionArray, SignPost, TileObject } from '../../src/world/tilefmt.ts';
import type { ParkedCar } from '../../src/world/parked.ts';

/** Growable indexed triangle mesh with `stride` extra bytes/shorts per vertex. */
export class MeshAcc {
  readonly pos: number[] = [];
  /** per-vertex byte attributes (material id, or r,g,b …) */
  readonly a8: number[] = [];
  /** per-vertex short attributes (uv, wall dimensions …) in metres */
  readonly a16: number[] = [];
  readonly idx: number[] = [];
  readonly n8: number;
  readonly n16: number;

  constructor(n8: number, n16 = 0) {
    this.n8 = n8;
    this.n16 = n16;
  }

  get count(): number {
    return this.pos.length / 3;
  }

  vert(x: number, y: number, z: number, ...attrs: number[]): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    for (let k = 0; k < this.n8; k++) this.a8.push(attrs[k] ?? 0);
    for (let k = 0; k < this.n16; k++) this.a16.push(attrs[this.n8 + k] ?? 0);
    return i;
  }

  /** Add a triangle, flipped if necessary so that its normal has a positive dot with (nx,ny,nz). */
  tri(a: number, b: number, c: number, nx = 0, ny = 1, nz = 0): void {
    const p = this.pos;
    const ax = p[a * 3];
    const ay = p[a * 3 + 1];
    const az = p[a * 3 + 2];
    const ux = p[b * 3] - ax;
    const uy = p[b * 3 + 1] - ay;
    const uz = p[b * 3 + 2] - az;
    const vx = p[c * 3] - ax;
    const vy = p[c * 3 + 1] - ay;
    const vz = p[c * 3 + 2] - az;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-12) return; // degenerate
    if (cx * nx + cy * ny + cz * nz >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  quad(a: number, b: number, c: number, d: number, nx = 0, ny = 1, nz = 0): void {
    this.tri(a, b, c, nx, ny, nz);
    this.tri(a, c, d, nx, ny, nz);
  }
}

export class TileData {
  readonly ix: number;
  readonly iz: number;
  /** road surfaces, sidewalks, kerbs, verges: 1 byte material */
  readonly ground = new MeshAcc(1);
  /** paint: 1 byte material */
  readonly mark = new MeshAcc(1);
  /** buildings: style, r, g, b + (u, v, wallLength, wallHeight) */
  readonly bldg = new MeshAcc(4, 4);
  /** bridges, walls, fences, guard rails: r, g, b */
  readonly struct = new MeshAcc(3);
  /** the measured details of walls – windows, doors, balconies …: r, g, b (tools/mapgen/facadedetail.ts) */
  readonly fdet = new MeshAcc(3);
  /** the walls in `bldg` that have them: first corner, how many corners */
  readonly bldgObs: number[] = [];
  readonly signs: SignPost[] = [];
  readonly objects: TileObject[] = [];
  /** x, y, z, height, kind */
  readonly trees: number[] = [];
  /** collision rings: flat x,z with per-ring vertex counts and top heights */
  readonly collPts: number[] = [];
  readonly collCnt: number[] = [];
  /** collision segments x1,z1,x2,z2,baseY (walls, parapets, guard rails) */
  readonly collSeg: number[] = [];
  /** cars parked along the streets (tools/mapgen/parking.ts) */
  readonly parked: ParkedCar[] = [];

  constructor(ix: number, iz: number) {
    this.ix = ix;
    this.iz = iz;
  }
}

export class TileSet {
  readonly minX: number;
  readonly minZ: number;
  readonly size: number;
  readonly nx: number;
  readonly nz: number;
  readonly tiles = new Map<string, TileData>();

  constructor(minX: number, minZ: number, maxX: number, maxZ: number, size: number) {
    this.minX = minX;
    this.minZ = minZ;
    this.size = size;
    this.nx = Math.round((maxX - minX) / size);
    this.nz = Math.round((maxZ - minZ) / size);
  }

  at(x: number, z: number): TileData {
    const ix = Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.minX) / this.size)));
    const iz = Math.max(0, Math.min(this.nz - 1, Math.floor((z - this.minZ) / this.size)));
    const key = tileKey(ix, iz);
    let t = this.tiles.get(key);
    if (!t) this.tiles.set(key, (t = new TileData(ix, iz)));
    return t;
  }

  centre(t: TileData): [number, number] {
    return [this.minX + (t.ix + 0.5) * this.size, this.minZ + (t.iz + 0.5) * this.size];
  }
}

export type Layer = 'ground' | 'mark' | 'struct' | 'bldg';

/**
 * A band between two stride-3 polylines with the same vertex count
 * (e.g. the two edges of a lane).  Quads are sorted into tiles by centroid;
 * vertices are shared along the band inside a tile.
 */
export function addBand(
  ts: TileSet,
  layer: Layer,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  attrs: number[],
  nx = 0,
  ny = 1,
  nz = 0,
): void {
  const n = a.length / 3;
  let prevTile: TileData | null = null;
  let pa = -1;
  let pb = -1;
  for (let i = 0; i < n - 1; i++) {
    const i3 = i * 3;
    const cx = (a[i3] + a[i3 + 3] + b[i3] + b[i3 + 3]) / 4;
    const cz = (a[i3 + 2] + a[i3 + 5] + b[i3 + 2] + b[i3 + 5]) / 4;
    const tile = ts.at(cx, cz);
    const m = tile[layer];
    if (tile !== prevTile) {
      pa = m.vert(a[i3], a[i3 + 1], a[i3 + 2], ...attrs);
      pb = m.vert(b[i3], b[i3 + 1], b[i3 + 2], ...attrs);
      prevTile = tile;
    }
    const na = m.vert(a[i3 + 3], a[i3 + 4], a[i3 + 5], ...attrs);
    const nb = m.vert(b[i3 + 3], b[i3 + 4], b[i3 + 5], ...attrs);
    m.quad(pa, na, nb, pb, nx, ny, nz);
    pa = na;
    pb = nb;
  }
}

/** A single convex quad given by four [x,y,z] corners (in order around the quad). */
export function addQuad(
  ts: TileSet,
  layer: Layer,
  p: ArrayLike<number>,
  attrs: number[],
  nx = 0,
  ny = 1,
  nz = 0,
): void {
  const tile = ts.at((p[0] + p[3] + p[6] + p[9]) / 4, (p[2] + p[5] + p[8] + p[11]) / 4);
  const m = tile[layer];
  const i0 = m.vert(p[0], p[1], p[2], ...attrs);
  const i1 = m.vert(p[3], p[4], p[5], ...attrs);
  const i2 = m.vert(p[6], p[7], p[8], ...attrs);
  const i3 = m.vert(p[9], p[10], p[11], ...attrs);
  m.quad(i0, i1, i2, i3, nx, ny, nz);
}

/** Triangle soup (indices into stride-3 `p`) placed into the tile of its centroid. */
export function addTriangles(
  ts: TileSet,
  layer: Layer,
  p: ArrayLike<number>,
  tris: ArrayLike<number>,
  attrs: number[] | ((vertex: number) => number[]),
  nx = 0,
  ny = 1,
  nz = 0,
): void {
  if (tris.length === 0) return;
  let cx = 0;
  let cz = 0;
  const n = p.length / 3;
  for (let i = 0; i < n; i++) {
    cx += p[i * 3];
    cz += p[i * 3 + 2];
  }
  const tile = ts.at(cx / n, cz / n);
  const m = tile[layer];
  const map = new Int32Array(n).fill(-1);
  const vi = (i: number): number => {
    if (map[i] < 0) {
      const at = typeof attrs === 'function' ? attrs(i) : attrs;
      map[i] = m.vert(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], ...at);
    }
    return map[i];
  };
  for (let t = 0; t < tris.length; t += 3) m.tri(vi(tris[t]), vi(tris[t + 1]), vi(tris[t + 2]), nx, ny, nz);
}

function quantise(
  src: number[],
  cx: number,
  cz: number,
  yBase: number,
): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = Math.max(-32767, Math.min(32767, Math.round((src[i] - cx) / POS_XZ_SCALE)));
    out[i + 1] = Math.max(-32767, Math.min(32767, Math.round((src[i + 1] - yBase) / POS_Y_SCALE)));
    out[i + 2] = Math.max(-32767, Math.min(32767, Math.round((src[i + 2] - cz) / POS_XZ_SCALE)));
  }
  return out;
}

/** Serialise one mesh into tile sections `<name>_pos`, `<name>_idx`, `<name>_a8`, `<name>_a16`. */
export function meshSections(
  name: string,
  m: MeshAcc,
  cx: number,
  cz: number,
  yBase: number,
  out: Record<string, SectionArray>,
): void {
  if (m.idx.length === 0) return;
  out[`${name}_pos`] = quantise(m.pos, cx, cz, yBase);
  out[`${name}_idx`] = m.count > 65535 ? Uint32Array.from(m.idx) : Uint16Array.from(m.idx);
  if (m.n8 > 0) out[`${name}_a8`] = Uint8Array.from(m.a8);
  if (m.n16 > 0) {
    const a = new Int16Array(m.a16.length);
    for (let i = 0; i < a.length; i++) a[i] = Math.max(-32767, Math.min(32767, Math.round(m.a16[i] / UV_SCALE)));
    out[`${name}_a16`] = a;
  }
}
