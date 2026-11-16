// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Buildings.
 *
 * Inside the municipality the official LoD2 models are used as they are:
 * every wall and roof polygon, so houses have their real height and roof
 * shape.  The margin of the map outside the municipality has no LoD2 data;
 * there OSM footprints are extruded with typical heights and simple roofs.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import earcut from 'earcut';
import { hash01, pointInRing, ringArea } from '../../src/core/geom.ts';
import { SINK } from '../../src/world/facade.ts';
import { BS } from '../../src/world/tilefmt.ts';
import type { TileData, TileSet } from './meshacc.ts';
import type { OsmData, Tags } from './osm.ts';
import { isClosedWay } from './osm.ts';
import { LOD2_BIN, gridIndex } from './store.ts';
import type { TerrainGrid } from './terrain.ts';

interface Lod2Unit {
  id: string;
  fn: string;
  roof: string;
  polys: number[][];
}

type RGB = [number, number, number];
const hex = (h: number): RGB => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const WALLS_HOUSE = [0xf1ede3, 0xe9e1cf, 0xe6d8b8, 0xdbd1c1, 0xf4f0e7, 0xd2cabb, 0xe8dcc6, 0xded5c5, 0xcdbb9f, 0xeee7d6, 0xd9c9a9, 0xc9bdac, 0xe3d2c0, 0xf0e2c8, 0xd6dbd3, 0xc98f6b].map(hex);
const WALLS_COMMERCIAL = [0xd6d9db, 0xc3c7c9, 0xe0e0dc, 0xb9bdc1, 0xd0cdc4, 0xaeb4b8].map(hex);
const WALLS_GARAGE = [0xddd8cc, 0xcbc6ba, 0xe8e4da, 0xc0bcb2, 0xd6d0c4].map(hex);
const WALLS_PUBLIC = [0xe4ddcc, 0xd8cdb6, 0xcfc3ae, 0xbfa88c, 0xdcd6c8].map(hex);
const ROOFS_TILE = [0x8c4a36, 0x7a3f30, 0x9a5540, 0x70493f, 0x5c4b46, 0x4b4b4e, 0x6b3a2c, 0x844837, 0x57504c].map(hex);
const ROOFS_FLAT = [0x8a8a88, 0x777774, 0x9a9892, 0x6f706f].map(hex);
const ROOFS_METAL = [0x9aa0a4, 0x858b90, 0xb0b4b6, 0x767c80].map(hex);

function pick<T>(list: T[], seed: number): T {
  return list[Math.floor(hash01(seed) * list.length) % list.length];
}

function shade(c: RGB, f: number): RGB {
  return [Math.min(255, Math.round(c[0] * f)), Math.min(255, Math.round(c[1] * f)), Math.min(255, Math.round(c[2] * f))];
}

/** Newell normal of a stride-3 polygon (not normalised). */
function newell(p: number[], off: number, n: number): [number, number, number] {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < n; i++) {
    const a = off + i * 3;
    const b = off + ((i + 1) % n) * 3;
    nx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
    ny += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
    nz += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
  }
  return [nx, ny, nz];
}

function emit(
  tile: TileData,
  pts: number[],
  off: number,
  n: number,
  normal: [number, number, number],
  uAxis: [number, number, number],
  vAxis: [number, number, number],
  attr: (u: number, v: number, y: number) => number[],
  lowerBelow: number,
): number {
  const flat: number[] = [];
  let uMin = Infinity;
  let vMin = Infinity;
  for (let i = 0; i < n; i++) {
    const a = off + i * 3;
    const u = pts[a] * uAxis[0] + pts[a + 1] * uAxis[1] + pts[a + 2] * uAxis[2];
    const v = pts[a] * vAxis[0] + pts[a + 1] * vAxis[1] + pts[a + 2] * vAxis[2];
    flat.push(u, v);
    if (u < uMin) uMin = u;
    if (v < vMin) vMin = v;
  }
  const tris = earcut(flat, undefined, 2);
  if (tris.length === 0) return 0;
  const m = tile.bldg;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = off + i * 3;
    let y = pts[a + 1];
    const at = attr(flat[i * 2] - uMin, flat[i * 2 + 1] - vMin, y);
    if (y <= lowerBelow) y -= SINK; // sink the foot of the wall into the ground
    idx.push(m.vert(pts[a], y, pts[a + 2], ...at));
  }
  for (let t = 0; t < tris.length; t += 3) m.tri(idx[tris[t]], idx[tris[t + 1]], idx[tris[t + 2]], normal[0], normal[1], normal[2]);
  return tris.length / 3;
}

export interface BuildingStats {
  lod2Units: number;
  osmFallback: number;
  triangles: number;
  footprints: number;
}

function styleFor(fn: string, area: number, height: number): number {
  const code = Number(fn.split('_')[1] ?? '0');
  if (fn.startsWith('51009')) return BS.WALL_PLAIN;
  if (code === 3041 || code === 3043) return BS.WALL_CHURCH;
  if (code === 2460 || code === 2463) return BS.WALL_GARAGE;
  if (code === 2523 || code === 2513 || code === 9998) return BS.WALL_PLAIN;
  if (code >= 3000 && code < 4000) return BS.WALL_PUBLIC;
  if (code >= 2000 && code < 3000) return BS.WALL_COMMERCIAL;
  // The cadastre files nearly everything under "residential"; tell sheds and
  // garages apart by size.
  if (area < 14) return BS.WALL_PLAIN;
  if (area < 52 && height < 3.9) return BS.WALL_GARAGE;
  return BS.WALL_HOUSE;
}

/**
 * The building models of an area, one after the other: from the squares of
 * 2 km they were sorted into when they were extracted
 * (data/work/lod2/<municipality>/<bx>_<bz>.ndjson.gz, one building per line).
 */
export function* lod2Units(lod2Dir: string, area: { minX: number; minZ: number; maxX: number; maxZ: number }): Generator<Lod2Unit> {
  if (!existsSync(lod2Dir)) return;
  const dirs = readdirSync(lod2Dir).filter((d) => !d.startsWith('.'));
  for (let bx = gridIndex(area.minX, LOD2_BIN); bx <= gridIndex(area.maxX, LOD2_BIN); bx++) {
    for (let bz = gridIndex(area.minZ, LOD2_BIN); bz <= gridIndex(area.maxZ, LOD2_BIN); bz++) {
      for (const d of dirs) {
        const file = join(lod2Dir, d, `${bx}_${bz}.ndjson.gz`);
        if (!existsSync(file)) continue;
        for (const line of gunzipSync(readFileSync(file)).toString('utf8').split('\n')) {
          if (line.startsWith('{')) yield JSON.parse(line) as Lod2Unit;
        }
      }
    }
  }
}

export function addLod2Buildings(units: Iterable<Lod2Unit>, ts: TileSet, stats: BuildingStats): Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> {
  const boxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = [];
  let seed = 1;
  const endX = ts.minX + ts.nx * ts.size;
  const endZ = ts.minZ + ts.nz * ts.size;
  for (const u of units) {
    if (u.fn.startsWith('53001')) continue; // bridges: generated from the road network instead
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let base = Infinity;
    let top = -Infinity;
    let area = 0;
    for (const poly of u.polys) {
      for (let i = 1; i < poly.length; i += 3) {
        minX = Math.min(minX, poly[i]);
        maxX = Math.max(maxX, poly[i]);
        minZ = Math.min(minZ, poly[i + 2]);
        maxZ = Math.max(maxZ, poly[i + 2]);
        base = Math.min(base, poly[i + 1]);
        top = Math.max(top, poly[i + 1]);
      }
      if (poly[0] === 2) {
        const ring: number[] = [];
        for (let i = 1; i < poly.length; i += 3) ring.push(poly[i], poly[i + 2]);
        area += Math.abs(ringArea(ring));
      }
    }
    if (!Number.isFinite(minX)) continue;
    if (area === 0) area = (maxX - minX) * (maxZ - minZ) * 0.7;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // (a building belongs to the tile its middle lies in – only those of the area that is being built)
    if (cx < ts.minX || cx >= endX || cz < ts.minZ || cz >= endZ) continue;
    const tile = ts.at(cx, cz);
    seed = (Math.round(cx * 13.7) * 73856093) ^ (Math.round(cz * 17.3) * 19349663);
    const style = styleFor(u.fn, area, top - base);
    const wallCol =
      style === BS.WALL_HOUSE
        ? pick(WALLS_HOUSE, seed)
        : style === BS.WALL_GARAGE || style === BS.WALL_PLAIN
          ? pick(WALLS_GARAGE, seed)
          : style === BS.WALL_COMMERCIAL
            ? pick(WALLS_COMMERCIAL, seed)
            : pick(WALLS_PUBLIC, seed);
    const flatRoof = u.roof === '1000';
    const industrial = style === BS.WALL_COMMERCIAL;
    const roofStyle = flatRoof ? BS.ROOF_FLAT : industrial ? BS.ROOF_METAL : BS.ROOF_TILES;
    const roofCol = flatRoof ? pick(ROOFS_FLAT, seed + 7) : industrial ? pick(ROOFS_METAL, seed + 7) : pick(ROOFS_TILE, seed + 7);
    stats.lod2Units++;
    boxes.push({ minX, maxX, minZ, maxZ });

    for (const poly of u.polys) {
      const kind = poly[0];
      const n = (poly.length - 1) / 3;
      if (n < 3) continue;
      if (kind === 2) {
        // footprint → collision ring
        tile.collCnt.push(n);
        for (let i = 0; i < n; i++) tile.collPts.push(poly[1 + i * 3], poly[3 + i * 3]);
        stats.footprints++;
        continue;
      }
      const nrm = newell(poly, 1, n);
      const nl = Math.hypot(nrm[0], nrm[1], nrm[2]);
      if (nl < 1e-6) continue;
      const nx = nrm[0] / nl;
      const ny = nrm[1] / nl;
      const nz = nrm[2] / nl;
      if (kind === 1 && ny > 0.3) {
        let ua: [number, number, number];
        let va: [number, number, number];
        const sloped = ny < 0.985;
        if (!sloped) {
          ua = [1, 0, 0];
          va = [0, 0, 1];
        } else {
          const hl = Math.hypot(nx, nz);
          ua = [nz / hl, 0, -nx / hl];
          va = [ny * ua[2] - nz * ua[1], nz * ua[0] - nx * ua[2], nx * ua[1] - ny * ua[0]];
          if (va[1] < 0) va = [-va[0], -va[1], -va[2]];
        }
        const rs = sloped ? roofStyle : roofStyle === BS.ROOF_TILES ? BS.ROOF_FLAT : roofStyle;
        const col = sloped ? roofCol : roofStyle === BS.ROOF_TILES ? pick(ROOFS_FLAT, seed + 7) : roofCol;
        stats.triangles += emit(tile, poly, 1, n, [nx, ny, nz], ua, va, (uu, vv) => [rs, col[0], col[1], col[2], uu, vv, 0, 0], -Infinity);
      } else {
        // wall (or closure surface)
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < n; i++) {
          const y = poly[2 + i * 3];
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        }
        let eave = hi;
        for (let i = 0; i < n; i++) {
          const y = poly[2 + i * 3];
          if (y > lo + 0.6 && y < eave) eave = y;
        }
        const hl = Math.hypot(nx, nz);
        if (hl < 1e-3) continue;
        const ua: [number, number, number] = [nz / hl, 0, -nx / hl];
        const va: [number, number, number] = [0, 1, 0];
        let uMin = Infinity;
        let uMax = -Infinity;
        for (let i = 0; i < n; i++) {
          const uu = poly[1 + i * 3] * ua[0] + poly[3 + i * 3] * ua[2];
          uMin = Math.min(uMin, uu);
          uMax = Math.max(uMax, uu);
        }
        const L = uMax - uMin;
        const H = eave - lo;
        // slightly different tone per facade direction keeps boxy houses readable
        const col = shade(wallCol, 0.94 + 0.08 * Math.abs(nx));
        const st = kind === 3 ? BS.WALL_PLAIN : style;
        stats.triangles += emit(
          tile,
          poly,
          1,
          n,
          [nx, ny, nz],
          ua,
          va,
          (uu, _vv, y) => [st, col[0], col[1], col[2], uu, y - lo, L, H],
          lo <= base + 0.4 ? lo + 0.02 : -Infinity,
        );
      }
    }
  }
  return boxes;
}

function fallbackHeights(tags: Tags, area: number): { wall: number; ridge: number; style: number } {
  const b = tags.building;
  const levels = Number(tags['building:levels']);
  const h = Number.parseFloat(tags.height ?? '');
  let style: number = BS.WALL_HOUSE;
  let wall = 5.8;
  let ridge = 3.2;
  if (['garage', 'garages', 'carport'].includes(b)) {
    style = BS.WALL_GARAGE;
    wall = 2.6;
    ridge = 0;
  } else if (['shed', 'hut', 'roof', 'greenhouse', 'kiosk', 'service', 'transformer_tower'].includes(b)) {
    style = BS.WALL_PLAIN;
    wall = 2.5;
    ridge = 0;
  } else if (['industrial', 'warehouse', 'commercial', 'retail', 'supermarket', 'office', 'hangar'].includes(b)) {
    style = BS.WALL_COMMERCIAL;
    wall = 7.5;
    ridge = 0;
  } else if (['church', 'chapel', 'cathedral'].includes(b)) {
    style = BS.WALL_CHURCH;
    wall = 10;
    ridge = 5;
  } else if (['school', 'kindergarten', 'hospital', 'public', 'civic', 'university', 'fire_station'].includes(b)) {
    style = BS.WALL_PUBLIC;
    wall = 7;
    ridge = 0;
  } else if (['barn', 'farm_auxiliary', 'stable', 'cowshed'].includes(b)) {
    style = BS.WALL_PLAIN;
    wall = 5;
    ridge = 3;
  } else if (b === 'apartments') {
    wall = 11;
    ridge = 2.5;
  } else if (b === 'yes' && area < 45) {
    style = area < 14 ? BS.WALL_PLAIN : BS.WALL_GARAGE;
    wall = 2.6;
    ridge = 0;
  }
  if (Number.isFinite(levels) && levels > 0) wall = levels * 2.9 + 0.4;
  if (Number.isFinite(h) && h > 1) wall = Math.max(2.2, h - ridge);
  if (tags['roof:shape'] === 'flat') ridge = 0;
  return { wall, ridge, style };
}

/** OSM footprints outside the area covered by LoD2. */
export function addOsmBuildings(
  osm: OsmData,
  ts: TileSet,
  terrain: TerrainGrid,
  inWorld: (x: number, z: number) => boolean,
  municipality: number[][],
  stats: BuildingStats,
): void {
  const insideMunicipality = (x: number, z: number): boolean => {
    let inside = false;
    for (const ring of municipality) if (pointInRing(x, z, ring)) inside = !inside;
    return inside;
  };
  for (const w of osm.ways) {
    if (!w.tags.building || !isClosedWay(w)) continue;
    if (w.tags.building === 'no' || w.tags.location === 'underground') continue;
    const ring = osm.wayCoords(w);
    ring.length -= 2;
    const n = ring.length / 2;
    if (n < 3) continue;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cx += ring[i * 2];
      cz += ring[i * 2 + 1];
    }
    cx /= n;
    cz /= n;
    if (!inWorld(cx, cz) || insideMunicipality(cx, cz)) continue;
    // counter-clockwise ring (seen from above) so that edge normals point outwards
    const area = ringArea(ring);
    if (Math.abs(area) < 4) continue;
    if (area < 0) {
      for (let i = 0, j = n - 1; i < j; i++, j--) {
        const tx = ring[i * 2];
        const tz = ring[i * 2 + 1];
        ring[i * 2] = ring[j * 2];
        ring[i * 2 + 1] = ring[j * 2 + 1];
        ring[j * 2] = tx;
        ring[j * 2 + 1] = tz;
      }
    }
    const { wall, ridge, style } = fallbackHeights(w.tags, Math.abs(area));
    let base = Infinity;
    for (let i = 0; i < n; i++) base = Math.min(base, terrain.at(ring[i * 2], ring[i * 2 + 1]));
    if (!Number.isFinite(base)) continue;
    const tile = ts.at(cx, cz);
    const m = tile.bldg;
    const seed = (Math.round(cx * 13.7) * 73856093) ^ (Math.round(cz * 17.3) * 19349663);
    const wallCol =
      style === BS.WALL_HOUSE ? pick(WALLS_HOUSE, seed) : style === BS.WALL_COMMERCIAL ? pick(WALLS_COMMERCIAL, seed) : style === BS.WALL_PUBLIC || style === BS.WALL_CHURCH ? pick(WALLS_PUBLIC, seed) : pick(WALLS_GARAGE, seed);
    const yTop = base + wall;

    // gable roof only for plain rectangles; everything else gets a flat lid
    let ridgeAxis = -1;
    if (ridge > 0 && n === 4) {
      const l0 = Math.hypot(ring[2] - ring[0], ring[3] - ring[1]);
      const l1 = Math.hypot(ring[4] - ring[2], ring[5] - ring[3]);
      ridgeAxis = l0 >= l1 ? 0 : 1; // ridge runs parallel to the longer pair of sides
    }
    const ridgeH = ridgeAxis >= 0 ? Math.min(ridge, 0.5 * Math.min(Math.hypot(ring[2] - ring[0], ring[3] - ring[1]), Math.hypot(ring[4] - ring[2], ring[5] - ring[3])) * 0.78) : 0;

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[i * 2];
      const az = ring[i * 2 + 1];
      const bx = ring[j * 2];
      const bz = ring[j * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      // outward normal of a CCW ring (north-up) is to the right of a→b
      const nx = -(bz - az) / L;
      const nz = (bx - ax) / L;
      const col = shade(wallCol, 0.94 + 0.08 * Math.abs(nx));
      const at = (u: number, v: number): number[] => [style, col[0], col[1], col[2], u, v, L, wall];
      const v0 = m.vert(ax, base - 1.6, az, ...at(0, 0));
      const v1 = m.vert(bx, base - 1.6, bz, ...at(L, 0));
      const v2 = m.vert(bx, yTop, bz, ...at(L, wall));
      const v3 = m.vert(ax, yTop, az, ...at(0, wall));
      m.quad(v0, v1, v2, v3, nx, 0, nz);
      stats.triangles += 2;
      if (ridgeAxis >= 0 && i % 2 !== ridgeAxis) {
        // gable end
        const g = m.vert((ax + bx) / 2, yTop + ridgeH, (az + bz) / 2, ...at(L / 2, wall + ridgeH));
        m.tri(v3, v2, g, nx, 0, nz);
        stats.triangles++;
      }
    }
    const roofCol = ridgeAxis >= 0 ? pick(ROOFS_TILE, seed + 7) : style === BS.WALL_COMMERCIAL ? pick(ROOFS_METAL, seed + 7) : pick(ROOFS_FLAT, seed + 7);
    if (ridgeAxis >= 0) {
      // two roof planes between the eaves (sides parallel to the ridge) and the ridge line
      const mid = (i: number): [number, number] => [(ring[i * 2] + ring[((i + 1) % 4) * 2]) / 2, (ring[i * 2 + 1] + ring[((i + 1) % 4) * 2 + 1]) / 2];
      const gA = mid(ridgeAxis === 0 ? 1 : 0);
      const gB = mid(ridgeAxis === 0 ? 3 : 2);
      for (const side of [0, 1]) {
        const i = ridgeAxis === 0 ? (side === 0 ? 0 : 2) : side === 0 ? 1 : 3;
        const j = (i + 1) % 4;
        const ax = ring[i * 2];
        const az = ring[i * 2 + 1];
        const bx = ring[j * 2];
        const bz = ring[j * 2 + 1];
        // ridge end nearest to each eave corner
        const near = (px: number, pz: number): [number, number] =>
          Math.hypot(px - gA[0], pz - gA[1]) < Math.hypot(px - gB[0], pz - gB[1]) ? gA : gB;
        const ra = near(ax, az);
        const rb = near(bx, bz);
        const L = Math.hypot(bx - ax, bz - az);
        const slope = Math.hypot(ra[0] - ax, ra[1] - az, ridgeH);
        const at = (u: number, v: number): number[] => [BS.ROOF_TILES, roofCol[0], roofCol[1], roofCol[2], u, v, 0, 0];
        const v0 = m.vert(ax, yTop, az, ...at(0, 0));
        const v1 = m.vert(bx, yTop, bz, ...at(L, 0));
        const v2 = m.vert(rb[0], yTop + ridgeH, rb[1], ...at(L, slope));
        const v3 = m.vert(ra[0], yTop + ridgeH, ra[1], ...at(0, slope));
        m.quad(v0, v1, v2, v3, 0, 1, 0);
        stats.triangles += 2;
      }
    } else {
      const tris = earcut(ring, undefined, 2);
      const idx: number[] = [];
      const rs = style === BS.WALL_COMMERCIAL ? BS.ROOF_METAL : BS.ROOF_FLAT;
      for (let i = 0; i < n; i++) idx.push(m.vert(ring[i * 2], yTop, ring[i * 2 + 1], rs, roofCol[0], roofCol[1], roofCol[2], ring[i * 2] - cx, ring[i * 2 + 1] - cz, 0, 0));
      for (let t = 0; t < tris.length; t += 3) m.tri(idx[tris[t]], idx[tris[t + 1]], idx[tris[t + 2]], 0, 1, 0);
      stats.triangles += tris.length / 3;
    }
    tile.collCnt.push(n);
    for (let i = 0; i < n; i++) tile.collPts.push(ring[i * 2], ring[i * 2 + 1]);
    stats.footprints++;
    stats.osmFallback++;
  }
}
