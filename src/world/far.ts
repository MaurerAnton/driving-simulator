// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The far view of the region (far.bin.gz, made by tools/build-far.ts): its
 * ground on a coarse grid – a point every 100 m with its height and what
 * covers it – for what lies beyond the tiles around the camera.
 */

/** metres between the points */
export const FAR_CELL = 100;
/** the height of a point where no ground is known */
export const FAR_NONE = 65535;

export interface FarGround {
  minX: number;
  minZ: number;
  cell: number;
  w: number;
  h: number;
  /** metres: base + v · step, FAR_NONE where none */
  base: number;
  step: number;
  heights: Uint16Array;
  cover: Uint8Array;
  /** how tall the buildings around each point are (half metres; 0: none there) – null in a file without them */
  buildings: Uint8Array | null;
}

/** Read far.bin (already inflated); null if it is not one. */
export function parseFar(buf: ArrayBuffer): FarGround | null {
  const b = new Uint8Array(buf);
  if (b.length < 32 || b[0] !== 0x46 || b[1] !== 0x41 || b[2] !== 0x52 || (b[3] !== 0x31 && b[3] !== 0x32)) return null;
  const withBuildings = b[3] === 0x32;
  const dv = new DataView(buf);
  const minX = dv.getInt32(4, true);
  const minZ = dv.getInt32(8, true);
  const cell = dv.getInt32(12, true);
  const w = dv.getInt32(16, true);
  const h = dv.getInt32(20, true);
  const base = dv.getFloat32(24, true);
  const step = dv.getFloat32(28, true);
  const n = w * h;
  if (b.length < 32 + n * (withBuildings ? 4 : 3)) return null;
  // (the heights start at an even offset: 32)
  const heights = new Uint16Array(buf.slice(32, 32 + n * 2));
  const cover = new Uint8Array(buf.slice(32 + n * 2, 32 + n * 3));
  const buildings = withBuildings ? new Uint8Array(buf.slice(32 + n * 3, 32 + n * 4)) : null;
  return { minX, minZ, cell, w, h, base, step, heights, cover, buildings };
}

/**
 * What kind of place a point lies in, by the buildings around it: 0 no
 * buildings (the open country), 1 small houses (up to two storeys), 2 rows
 * of houses and blocks of flats, 3 tall buildings (the middle of a town) –
 * -1 if the file does not say.
 */
export function farBuilt(f: FarGround, x: number, z: number): number {
  if (!f.buildings) return -1;
  const i = Math.round((x - f.minX) / f.cell);
  const j = Math.round((z - f.minZ) / f.cell);
  if (i < 0 || j < 0 || i >= f.w || j >= f.h) return 0;
  // (the cell and its neighbours: a street runs between the houses)
  let n = 0;
  let sum = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= f.w || jj >= f.h) continue;
      const v = f.buildings[jj * f.w + ii];
      if (v === 0) continue;
      n++;
      sum += v / 2;
    }
  }
  if (n < 2) return 0;
  const tall = sum / n;
  return tall < 5.5 ? 1 : tall < 9 ? 2 : 3;
}

/** The far ground's height at a place (bilinear between its points), NaN outside it. */
export function farHeight(f: FarGround, x: number, z: number): number {
  const fx = (x - f.minX) / f.cell;
  const fz = (z - f.minZ) / f.cell;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  if (i < 0 || j < 0 || i >= f.w - 1 || j >= f.h - 1) return Number.NaN;
  const k = j * f.w + i;
  const a = f.heights[k];
  const b = f.heights[k + 1];
  const c = f.heights[k + f.w];
  const d = f.heights[k + f.w + 1];
  if (a === FAR_NONE || b === FAR_NONE || c === FAR_NONE || d === FAR_NONE) return Number.NaN;
  const tx = fx - i;
  const tz = fz - j;
  const v = (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  return f.base + v * f.step;
}
