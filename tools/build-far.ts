// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The far view: the ground of the whole region on a coarse grid – a point
 * every 100 m with its height and what covers it (forest, field, town, …) –
 * for what lies beyond the tiles around the camera: the hills on the
 * horizon, and the land below an aeroplane.
 *
 *   node --max-old-space-size=2048 tools/build-far.ts
 *
 * Read from the map's own tiles (MAP_OUT, default public/map), so that the
 * far ground is the near ground seen from further away.  Writes far.bin.gz:
 *
 *   "FAR2", then little-endian int32 minX, minZ, cell, w, h, float32 base, step,
 *   then w·h uint16 heights (base + v·step metres; 65535: no ground known),
 *   w·h uint8 cover classes (src/world/cover.ts) and w·h uint8 building
 *   heights (how tall the buildings around the point are, half metres; 0: none),
 *   row by row from minZ.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { POS_XZ_SCALE, POS_Y_SCALE, tileGround, unpackSections } from '../src/world/tilefmt.ts';
import type { TileHeader } from '../src/world/tilefmt.ts';
import { FAR_CELL, FAR_NONE } from '../src/world/far.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mapDir = resolve(root, process.env.MAP_OUT ?? 'public/map');
const meta = (JSON.parse(readFileSync(resolve(mapDir, 'map.json'), 'utf8')) as { meta: { minX: number; maxX: number; minZ: number; maxZ: number } }).meta;
const t0 = Date.now();

const minX = Math.floor(meta.minX / FAR_CELL) * FAR_CELL;
const minZ = Math.floor(meta.minZ / FAR_CELL) * FAR_CELL;
const w = Math.ceil((meta.maxX - minX) / FAR_CELL) + 1;
const h = Math.ceil((meta.maxZ - minZ) / FAR_CELL) + 1;
const height = new Float32Array(w * h).fill(Number.NaN);
const cover = new Uint8Array(w * h);
/** the buildings of each cell: how many points of their walls and roofs above 2 m, and their heights summed */
const bN = new Uint32Array(w * h);
const bSum = new Float32Array(w * h);

const files = readdirSync(resolve(mapDir, 'tiles')).filter((f) => f.endsWith('.fsb'));
let done = 0;
for (const f of files) {
  const raw = readFileSync(resolve(mapDir, 'tiles', f));
  const buf = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const t = unpackSections<TileHeader>(ab);
  const hd = t.header;
  const hgt = t.get('hgt') as Uint16Array | null;
  const cov = t.get('cov') as Uint8Array | null;
  if (!hgt) continue;
  const x0 = hd.cx - hd.size / 2;
  const z0 = hd.cz - hd.size / 2;
  // the grid points inside this tile (a point on its edge belongs to the tile it begins)
  const i0 = Math.ceil((x0 - minX) / FAR_CELL);
  const i1 = Math.floor((x0 + hd.size - minX - 1e-6) / FAR_CELL);
  const j0 = Math.ceil((z0 - minZ) / FAR_CELL);
  const j1 = Math.floor((z0 + hd.size - minZ - 1e-6) / FAR_CELL);
  for (let j = Math.max(0, j0); j <= Math.min(h - 1, j1); j++) {
    for (let i = Math.max(0, i0); i <= Math.min(w - 1, i1); i++) {
      const x = minX + i * FAR_CELL;
      const z = minZ + j * FAR_CELL;
      height[j * w + i] = tileGround(hd, hgt, x, z);
      if (cov && hd.coverN > 0) {
        const cn = hd.coverN;
        const ci = Math.min(cn - 1, Math.max(0, Math.floor(((x - x0) / hd.size) * cn)));
        const cj = Math.min(cn - 1, Math.max(0, Math.floor(((z - z0) / hd.size) * cn)));
        cover[j * w + i] = cov[cj * cn + ci];
      }
    }
  }
  // the buildings: every point of their meshes, how high above the ground it is – the upper ones say how tall they are
  const bp = t.get('bldg_pos') as Int16Array | null;
  if (bp) {
    for (let k = 0; k + 2 < bp.length; k += 3) {
      const x = hd.cx + bp[k] * POS_XZ_SCALE;
      const y = hd.yBase + bp[k + 1] * POS_Y_SCALE;
      const z = hd.cz + bp[k + 2] * POS_XZ_SCALE;
      const above = y - tileGround(hd, hgt, x, z);
      if (above < 2) continue;
      const i = Math.round((x - minX) / FAR_CELL);
      const j = Math.round((z - minZ) / FAR_CELL);
      if (i < 0 || j < 0 || i >= w || j >= h) continue;
      bN[j * w + i]++;
      bSum[j * w + i] += above;
    }
  }
  if (++done % 1000 === 0) process.stdout.write(`\r[far] ${done} of ${files.length} tiles  `);
}
process.stdout.write('\n');

// Where no tile is (beyond the region, in its bays): the ground of the nearest that is known, a few
// centimetres lower at each step – a plausible land round the region rather than a hole.
let known = 0;
for (let k = 0; k < w * h; k++) if (!Number.isNaN(height[k])) known++;
{
  let front: number[] = [];
  for (let k = 0; k < w * h; k++) if (!Number.isNaN(height[k])) front.push(k);
  const filled = new Uint8Array(w * h);
  for (const k of front) filled[k] = 1;
  let ring = 0;
  while (front.length > 0 && ring < 400) {
    const next: number[] = [];
    for (const k of front) {
      const i = k % w;
      const j = (k - i) / w;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const nk = nj * w + ni;
        if (filled[nk]) continue;
        filled[nk] = 2;
        height[nk] = height[k] - 0.05;
        cover[nk] = cover[k] === 3 ? 3 : 0;
        next.push(nk);
      }
    }
    front = next;
    ring++;
  }
}

let lo = Infinity;
let hi = -Infinity;
for (const v of height) {
  if (Number.isNaN(v)) continue;
  lo = Math.min(lo, v);
  hi = Math.max(hi, v);
}
const base = Math.floor(lo) - 1;
const step = Math.max(0.05, Math.ceil(((hi - base) / 65000) * 100) / 100);
const out = Buffer.alloc(4 + 5 * 4 + 2 * 4 + w * h * 2 + w * h * 2);
out.write('FAR2', 0, 'latin1');
let o = 4;
for (const v of [minX, minZ, FAR_CELL, w, h]) {
  out.writeInt32LE(v, o);
  o += 4;
}
out.writeFloatLE(base, o);
out.writeFloatLE(step, o + 4);
o += 8;
for (let k = 0; k < w * h; k++) {
  const v = height[k];
  out.writeUInt16LE(Number.isNaN(v) ? FAR_NONE : Math.max(0, Math.min(FAR_NONE - 1, Math.round((v - base) / step))), o);
  o += 2;
}
out.set(cover, o);
o += w * h;
let built = 0;
for (let k = 0; k < w * h; k++) {
  // (a few points – a shed, a bus shelter – are no houses)
  const v = bN[k] >= 12 ? Math.min(255, Math.round((bSum[k] / bN[k]) * 2)) : 0;
  out[o + k] = v;
  if (v > 0) built++;
}
const gz = gzipSync(out, { level: 9 });
writeFileSync(resolve(mapDir, 'far.bin.gz'), gz);
console.log(`far.bin.gz: ${w} × ${h} points every ${FAR_CELL} m (${((known / (w * h)) * 100).toFixed(0)} % from tiles, ${built} with buildings), heights ${lo.toFixed(0)}…${hi.toFixed(0)} m, ${(gz.length / 1048576).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
