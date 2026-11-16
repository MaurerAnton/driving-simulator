// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The terrain model (Hessen open geodata DGM1, EPSG:25832, DHHN2016), as
 * tools/fetch-geodata.py reduced it: tiles of 1 km on a grid of 2 m, heights
 * in steps of 2 cm (data/work/dgm2/<E km>_<N km>.dgm).
 *
 * The tiles are read when they are first asked for and kept while they are
 * in use – the model of the whole region does not fit into memory at once.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { WORLD_ORIGIN_E, WORLD_ORIGIN_N } from '../../src/geo/utm.ts';

const TILE = 1000;

export class Dgm {
  private readonly dir: string;
  private readonly have = new Set<number>();
  private readonly cache = new Map<number, Uint16Array | null>();
  private readonly limit: number;
  /** cells per side of a tile, their size and the height step (from the first tile read) */
  private n = 500;
  private cellSize = 2;
  private step = 0.02;
  private lastKey = -1;
  private lastTile: Uint16Array | null = null;
  readonly count: number;

  private static key(eKm: number, nKm: number): number {
    return eKm * 10000 + nKm;
  }

  /** `limit`: how many tiles are kept in memory (half a megabyte each). */
  constructor(dir: string, limit = 400) {
    this.dir = dir;
    this.limit = limit;
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      const m = /^(\d+)_(\d+)\.dgm$/.exec(f);
      if (m) this.have.add(Dgm.key(Number(m[1]), Number(m[2])));
    }
    this.count = this.have.size;
    if (this.count === 0) throw new Error(`no terrain tiles in ${dir} – fetch them with tools/fetch-geodata.py`);
  }

  private load(eKm: number, nKm: number): Uint16Array | null {
    const k = Dgm.key(eKm, nKm);
    if (k === this.lastKey) return this.lastTile;
    let t = this.cache.get(k);
    if (t === undefined) {
      t = null;
      if (this.have.has(k)) {
        const raw = readFileSync(join(this.dir, `${eKm}_${nKm}.dgm`));
        if (raw.toString('latin1', 0, 4) !== 'DGM2') throw new Error(`${eKm}_${nKm}.dgm: not a reduced terrain tile`);
        const n = raw.readUInt16LE(4);
        this.n = n;
        this.cellSize = TILE / n;
        this.step = raw.readUInt16LE(6) / 1000;
        const planes = inflateSync(raw.subarray(8));
        const q = new Uint16Array(n * n);
        // each cell was stored as what its left, upper and upper-left neighbours do not foretell
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < n; c++) {
            const i = r * n + c;
            const zz = planes[i] | (planes[n * n + i] << 8);
            const rest = (zz >>> 1) ^ -(zz & 1);
            q[i] = (rest + (c > 0 ? q[i - 1] : 0) + (r > 0 ? q[i - n] : 0) - (r > 0 && c > 0 ? q[i - n - 1] : 0)) & 0xffff;
          }
        }
        t = q;
      }
      if (this.cache.size >= this.limit) {
        // the tile that was not asked for for the longest time goes
        const oldest = this.cache.keys().next().value as number;
        this.cache.delete(oldest);
      }
    } else this.cache.delete(k);
    this.cache.set(k, t);
    this.lastKey = k;
    this.lastTile = t;
    return t;
  }

  /** Is the 1 km tile containing this UTM position available? */
  coveredUtm(e: number, n: number): boolean {
    return this.have.has(Dgm.key(Math.floor(e / TILE), Math.floor(n / TILE)));
  }

  /** World-space coverage test. */
  covered(x: number, z: number): boolean {
    return this.coveredUtm(x + WORLD_ORIGIN_E, WORLD_ORIGIN_N - z);
  }

  /** The value of a cell given by its column and row in the grid of the whole zone (rows count northwards); NaN: none. */
  private cell(gc: number, gr: number): number {
    const n = this.n;
    const eKm = Math.floor(gc / n);
    const nKm = Math.floor(gr / n);
    const t = this.load(eKm, nKm);
    if (!t) return NaN;
    // (row 0 of a tile is its northern edge)
    const v = t[(n - 1 - (gr - nKm * n)) * n + (gc - eKm * n)];
    return v === 0 ? NaN : v * this.step;
  }

  /** Bilinear height at a UTM position; NaN where there is no terrain. */
  heightUtm(e: number, n: number): number {
    // cell centres lie half a cell inside
    const fx = e / this.cellSize - 0.5;
    const fy = n / this.cellSize - 0.5;
    const c0 = Math.floor(fx);
    const r0 = Math.floor(fy);
    const tx = fx - c0;
    const ty = fy - r0;
    const h00 = this.cell(c0, r0);
    const h10 = this.cell(c0 + 1, r0);
    const h01 = this.cell(c0, r0 + 1);
    const h11 = this.cell(c0 + 1, r0 + 1);
    if (Number.isNaN(h00 + h10 + h01 + h11)) {
      // at the rim of the model: the nearest corner that is there
      const near = [
        [h00, tx + ty],
        [h10, 1 - tx + ty],
        [h01, tx + 1 - ty],
        [h11, 2 - tx - ty],
      ].sort((a, b) => a[1] - b[1]);
      for (const [h] of near) if (!Number.isNaN(h)) return h;
      return NaN;
    }
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
  }

  /** Bilinear height at a world position (x east, z south); NaN when not covered. */
  height(x: number, z: number): number {
    return this.heightUtm(x + WORLD_ORIGIN_E, WORLD_ORIGIN_N - z);
  }

  /** Mean height over a small disc – robust against single-pixel noise. */
  heightAvg(x: number, z: number, radius: number): number {
    let sum = 0;
    let cnt = 0;
    const step = Math.max(1, radius / 2);
    for (let dx = -radius; dx <= radius + 1e-6; dx += step) {
      for (let dz = -radius; dz <= radius + 1e-6; dz += step) {
        if (dx * dx + dz * dz > radius * radius + 1e-6) continue;
        const h = this.height(x + dx, z + dz);
        if (!Number.isNaN(h)) {
          sum += h;
          cnt++;
        }
      }
    }
    return cnt ? sum / cnt : NaN;
  }
}
