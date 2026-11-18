// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The detail region: where the map build does what it learnt after the
 * published map (release karte-2026-11-16c, game version 1.6.0).
 *
 * Cross-sections with parking and parked cars, per-side pavements, verges,
 * cycle lanes, medians, gutters, paths, islands, tree bulbs, frontage,
 * fences, the finer ground cover with its smooth edges, flat and low roofs,
 * OSM buildings inside the municipalities with LoD2 models, calming and
 * markings, and the corrections of the observed-*.json lists – all of it
 * changes the bytes of the map.  A release that rebuilt the whole map for it
 * would have to ship the whole map again (close to a gigabyte, more than the
 * site may hold), so the new behaviour applies inside a few boxes only
 * (tools/mapgen/detail-region.json), and outside them the build writes the
 * same bytes as before: the chunks of the network, the tiles.  A release
 * then ships the files the region touches (tools/build-detail.ts).
 *
 * What is decided where:
 *   - a road (an edge of the network): by the point halfway along it, as a
 *     whole – the network build (mapgen/detailgraph.ts) marks the edges it
 *     made anew, and the tile build follows those marks;
 *   - a junction: new when one of its roads is;
 *   - a thing of OpenStreetMap (a path, a fence, an area, a building): by the
 *     point halfway along it, or the middle of its box;
 *   - the ground cover: tile by tile (a tile of 500 m that reaches into a box).
 *
 * DETAIL_REGION=<file> reads another list; "none": no region (the build is
 * that of the published map everywhere); "all": the whole map is one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** [minX, minZ, maxX, maxZ] in world metres */
export type DetailBox = [number, number, number, number];

const DEFAULT_FILE = fileURLToPath(new URL('./detail-region.json', import.meta.url));
const ALL: DetailBox = [-1e9, -1e9, 1e9, 1e9];

/** The boxes of `file` (default: the list next to this module, or DETAIL_REGION). */
export function loadDetailBoxes(file = process.env.DETAIL_REGION ?? DEFAULT_FILE): DetailBox[] {
  if (file === 'none') return [];
  if (file === 'all') return [ALL];
  const path = resolve(file);
  if (!existsSync(path)) return [];
  const j = JSON.parse(readFileSync(path, 'utf8')) as { boxes?: unknown[] };
  const out: DetailBox[] = [];
  for (const b of j.boxes ?? []) {
    const v = Array.isArray(b) ? b : (b as { box?: unknown })?.box;
    if (!Array.isArray(v) || v.length < 4) continue;
    const [a, c, d, e] = v.map(Number);
    if ([a, c, d, e].every(Number.isFinite) && d > a && e > c) out.push([a, c, d, e]);
  }
  return out;
}

let cached: DetailBox[] | null = null;
let cachedFrom = '';

/** The boxes as the map build uses them (read once per file). */
export function detailBoxes(): DetailBox[] {
  const file = process.env.DETAIL_REGION ?? DEFAULT_FILE;
  if (!cached || cachedFrom !== file) {
    cached = loadDetailBoxes(file);
    cachedFrom = file;
  }
  return cached;
}

/** Is there a region at all? */
export function hasDetail(): boolean {
  return detailBoxes().length > 0;
}

/** Does the point lie in the region? */
export function inDetail(x: number, z: number): boolean {
  for (const b of detailBoxes()) if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) return true;
  return false;
}

/** Does the rectangle reach into the region? */
export function rectInDetail(minX: number, minZ: number, maxX: number, maxZ: number): boolean {
  for (const b of detailBoxes()) if (maxX >= b[0] && minX <= b[2] && maxZ >= b[1] && minZ <= b[3]) return true;
  return false;
}

/** The point halfway along a line, flat [x, z, …] (`stride` 2) or [x, y, z, …] (`stride` 3). */
export function midpointOf(pts: ArrayLike<number>, stride = 2): [number, number] {
  const n = Math.floor(pts.length / stride);
  if (n === 0) return [NaN, NaN];
  const zo = stride === 3 ? 2 : 1;
  let total = 0;
  for (let i = 1; i < n; i++) total += Math.hypot(pts[i * stride] - pts[(i - 1) * stride], pts[i * stride + zo] - pts[(i - 1) * stride + zo]);
  let left = total / 2;
  for (let i = 1; i < n; i++) {
    const ax = pts[(i - 1) * stride];
    const az = pts[(i - 1) * stride + zo];
    const l = Math.hypot(pts[i * stride] - ax, pts[i * stride + zo] - az);
    if (l >= left && l > 0) {
      const t = left / l;
      return [ax + (pts[i * stride] - ax) * t, az + (pts[i * stride + zo] - az) * t];
    }
    left -= l;
  }
  return [pts[0], pts[zo]];
}

/** Does the line (as midpointOf) belong to the region – by the point halfway along it? */
export function lineInDetail(pts: ArrayLike<number>, stride = 2): boolean {
  if (!hasDetail()) return false;
  const [x, z] = midpointOf(pts, stride);
  return inDetail(x, z);
}

/** Does the area (flat [x, z, …]) belong to the region – by the middle of its box? */
export function areaInDetail(pts: ArrayLike<number>): boolean {
  if (!hasDetail() || pts.length < 2) return false;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minZ) minZ = pts[i + 1];
    if (pts[i + 1] > maxZ) maxZ = pts[i + 1];
  }
  return inDetail((minX + maxX) / 2, (minZ + maxZ) / 2);
}

/** The bounding box of all boxes, grown by `pad` (null: no region). */
export function detailBounds(pad = 0): { minX: number; minZ: number; maxX: number; maxZ: number } | null {
  const boxes = detailBoxes();
  if (!boxes.length) return null;
  const r = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const b of boxes) {
    r.minX = Math.min(r.minX, b[0] - pad);
    r.minZ = Math.min(r.minZ, b[1] - pad);
    r.maxX = Math.max(r.maxX, b[2] + pad);
    r.maxZ = Math.max(r.maxZ, b[3] + pad);
  }
  return r;
}
