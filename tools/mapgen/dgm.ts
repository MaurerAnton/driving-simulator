// SPDX-License-Identifier: AGPL-3.0-only
/**
 * DGM1 terrain access (Hessen open geodata, 1 m grid, EPSG:25832, DHHN2016).
 *
 * The state publishes 1 km × 1 km GeoTIFF tiles named
 *   DGM1_32_<E km>_<N km>_1_he.tif   (lower-left corner in kilometres)
 * Decoding LZW in JS is slow on small machines, so decoded tiles are cached
 * as raw float32 next to the pipeline's other work files.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromFile } from 'geotiff';
import { WORLD_ORIGIN_E, WORLD_ORIGIN_N } from '../../src/geo/utm.ts';

const TILE = 1000;

export class Dgm {
  private readonly tiles = new Map<number, Float32Array>();
  minE = Infinity;
  maxE = -Infinity;
  minN = Infinity;
  maxN = -Infinity;

  private static key(eKm: number, nKm: number): number {
    return eKm * 10000 + nKm;
  }

  static async load(tifDir: string, cacheDir: string): Promise<Dgm> {
    const dgm = new Dgm();
    mkdirSync(cacheDir, { recursive: true });
    const files = readdirSync(tifDir).filter((f) => /^DGM1_32_\d+_\d+_1_he\.tif$/.test(f));
    if (files.length === 0) throw new Error(`no DGM1 tiles in ${tifDir}`);
    let decoded = 0;
    for (const f of files) {
      const m = /^DGM1_32_(\d+)_(\d+)_/.exec(f)!;
      const eKm = Number(m[1]);
      const nKm = Number(m[2]);
      const cache = join(cacheDir, `${eKm}_${nKm}.f32`);
      let data: Float32Array;
      if (existsSync(cache)) {
        const buf = readFileSync(cache);
        data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
      } else {
        const tiff = await fromFile(join(tifDir, f));
        const img = await tiff.getImage();
        if (img.getWidth() !== TILE || img.getHeight() !== TILE) {
          throw new Error(`${f}: expected ${TILE}x${TILE}, got ${img.getWidth()}x${img.getHeight()}`);
        }
        const rasters = await img.readRasters({ interleave: true });
        data = Float32Array.from(rasters as ArrayLike<number>);
        writeFileSync(cache, Buffer.from(data.buffer));
        decoded++;
        if (decoded % 8 === 0) process.stdout.write(`\r[dgm] decoded ${decoded} tiles …`);
      }
      dgm.tiles.set(Dgm.key(eKm, nKm), data);
      dgm.minE = Math.min(dgm.minE, eKm * 1000);
      dgm.maxE = Math.max(dgm.maxE, eKm * 1000 + TILE);
      dgm.minN = Math.min(dgm.minN, nKm * 1000);
      dgm.maxN = Math.max(dgm.maxN, nKm * 1000 + TILE);
    }
    if (decoded > 0) process.stdout.write(`\r[dgm] decoded ${decoded} tiles (cached for next run)\n`);
    console.log(`[dgm] ${dgm.tiles.size} tiles, E ${dgm.minE}–${dgm.maxE}, N ${dgm.minN}–${dgm.maxN}`);
    return dgm;
  }

  /** Is the 1 km tile containing this UTM position available? */
  coveredUtm(e: number, n: number): boolean {
    return this.tiles.has(Dgm.key(Math.floor(e / TILE), Math.floor(n / TILE)));
  }

  /** World-space coverage test. */
  covered(x: number, z: number): boolean {
    return this.coveredUtm(x + WORLD_ORIGIN_E, WORLD_ORIGIN_N - z);
  }

  /** Raw cell value (nearest), NaN outside coverage or at nodata. */
  private cell(tile: Float32Array, col: number, row: number): number {
    const v = tile[row * TILE + col];
    return v < -1000 ? NaN : v;
  }

  /** Bilinear height at a UTM position; NaN when not covered. */
  heightUtm(e: number, n: number): number {
    const eKm = Math.floor(e / TILE);
    const nKm = Math.floor(n / TILE);
    const tile = this.tiles.get(Dgm.key(eKm, nKm));
    if (!tile) return NaN;
    // pixel centres sit at +0.5 m; row 0 is the northern edge
    const fx = e - eKm * TILE - 0.5;
    const fy = (nKm + 1) * TILE - n - 0.5;
    const c0 = Math.max(0, Math.min(TILE - 1, Math.floor(fx)));
    const r0 = Math.max(0, Math.min(TILE - 1, Math.floor(fy)));
    const c1 = Math.min(TILE - 1, c0 + 1);
    const r1 = Math.min(TILE - 1, r0 + 1);
    const tx = Math.max(0, Math.min(1, fx - c0));
    const ty = Math.max(0, Math.min(1, fy - r0));
    const h00 = this.cell(tile, c0, r0);
    const h10 = this.cell(tile, c1, r0);
    const h01 = this.cell(tile, c0, r1);
    const h11 = this.cell(tile, c1, r1);
    if (Number.isNaN(h00 + h10 + h01 + h11)) {
      // fall back to any valid corner
      for (const h of [h00, h10, h01, h11]) if (!Number.isNaN(h)) return h;
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
