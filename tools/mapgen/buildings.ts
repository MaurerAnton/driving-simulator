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
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import earcut from 'earcut';
import { hash01, pointInRing, ringArea } from '../../src/core/geom.ts';
import { SINK } from '../../src/world/facade.ts';
import { BS } from '../../src/world/tilefmt.ts';
import type { TileData, TileSet } from './meshacc.ts';
import type { OsmData, Tags } from './osm.ts';
import { isClosedWay } from './osm.ts';
import { LOD2_BIN, gridIndex } from './store.ts';
import { loadObserved, loadObservedEdits } from './observed.ts';
import type { ObservedAdd } from './observed.ts';
import { emitWallDetail, loadObservedFacades, matchWall } from './facadedetail.ts';
import type { ObservedWall } from './facadedetail.ts';
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
/** the house colours without the brick tone (the last one): for tall houses of the detail region */
const WALLS_RENDER = WALLS_HOUSE.slice(0, -1);
/** a house this high (ground to ridge, m) or higher gets no brick tone from the palette (the detail region) */
export const TALL_HOUSE_M = 10;
const WALLS_COMMERCIAL = [0xd6d9db, 0xc3c7c9, 0xe0e0dc, 0xb9bdc1, 0xd0cdc4, 0xaeb4b8].map(hex);
const WALLS_GARAGE = [0xddd8cc, 0xcbc6ba, 0xe8e4da, 0xc0bcb2, 0xd6d0c4].map(hex);
const WALLS_PUBLIC = [0xe4ddcc, 0xd8cdb6, 0xcfc3ae, 0xbfa88c, 0xdcd6c8].map(hex);
const ROOFS_TILE = [0x8c4a36, 0x7a3f30, 0x9a5540, 0x70493f, 0x5c4b46, 0x4b4b4e, 0x6b3a2c, 0x844837, 0x57504c].map(hex);
const ROOFS_FLAT = [0x8a8a88, 0x777774, 0x9a9892, 0x6f706f].map(hex);
const ROOFS_METAL = [0x9aa0a4, 0x858b90, 0xb0b4b6, 0x767c80].map(hex);
/** roofs pitched too low for tiles: bitumen, sheet metal, gravel */
const ROOFS_LOW = [0x5d5e60, 0x6a6b6c, 0x55575a, 0x77706a, 0x6f706f].map(hex);
/** a roof whose steepest plane is flatter than this (the up-component of its normal above cos 15°) has no tiles */
const LOW_PITCH_NY = 0.966;

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

export function addLod2Buildings(
  units: Iterable<Lod2Unit>,
  ts: TileSet,
  stats: BuildingStats,
  /** the measured details of walls (tools/mapgen/facadedetail.ts): building id → its walls */
  facades: Map<string, ObservedWall[]> = loadObservedFacades(),
  /** the models that are no longer there (tools/mapgen/observed-buildings.json "remove") */
  remove: ReadonlySet<string> = loadObservedEdits().remove,
  /**
   * Is the model at (x, z) – the middle of its box – built as the map build does it now (the detail region,
   * mapgen/detailregion.ts), or as the published map had it: the colours of the list it was built with
   * (observed-buildings.published.json), no roof made flat, no low roof without tiles, none left out?
   */
  freshAt: (x: number, z: number) => boolean = () => true,
): Lod2Foot[] {
  // (what was seen on site replaces the palettes' guesses: tools/mapgen/observed-buildings.json)
  const observed = loadObserved();
  const published = loadObserved(PUBLISHED_LIST);
  // (the footprints of all models read, also those built by the neighbouring area: where no OSM footprint is needed)
  const boxes: Lod2Foot[] = [];
  let seed = 1;
  const endX = ts.minX + ts.nx * ts.size;
  const endZ = ts.minZ + ts.nz * ts.size;
  for (const u of units) {
    if (u.fn.startsWith('53001')) continue; // bridges: generated from the road network instead
    if (remove.has(u.id) && freshAt(...unitMiddle(u))) continue;
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
    const rings: number[][] = [];
    for (const poly of u.polys) {
      if (poly[0] !== 2) continue;
      const ring: number[] = [];
      for (let i = 1; i < poly.length; i += 3) ring.push(poly[i], poly[i + 2]);
      rings.push(ring);
    }
    boxes.push({ minX, maxX, minZ, maxZ, rings });
    if (area === 0) area = (maxX - minX) * (maxZ - minZ) * 0.7;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // (a building belongs to the tile its middle lies in – only those of the area that is being built)
    if (cx < ts.minX || cx >= endX || cz < ts.minZ || cz >= endZ) continue;
    const tile = ts.at(cx, cz);
    seed = (Math.round(cx * 13.7) * 73856093) ^ (Math.round(cz * 17.3) * 19349663);
    const fresh = freshAt(cx, cz);
    const seen = fresh ? observed.get(u.id) : published.get(u.id);
    // (a roof seen flat where the model has it sloped: cut off at the eaves)
    if (fresh && seen?.flat) flattenRoof(u.polys, seen.flatAt ?? 0);
    const style = seen?.style ?? styleFor(u.fn, area, top - base);
    const guessed =
      style === BS.WALL_HOUSE || style === BS.WALL_BRICK
        ? pick(WALLS_HOUSE, seed)
        : style === BS.WALL_GARAGE || style === BS.WALL_PLAIN
          ? pick(WALLS_GARAGE, seed)
          : style === BS.WALL_COMMERCIAL
            ? pick(WALLS_COMMERCIAL, seed)
            : pick(WALLS_PUBLIC, seed);
    // (in the detail region a tall house – about three storeys and more – is not given the palette's brick tone:
    // the blocks of flats of the town are rendered, white to beige; brick is what observed-buildings.json says)
    const tallRender = fresh && style === BS.WALL_HOUSE && guessed === WALLS_HOUSE[WALLS_HOUSE.length - 1] && top - base >= TALL_HOUSE_M;
    const wallCol = seen?.wall ?? (tallRender ? pick(WALLS_RENDER, seed + 3) : guessed);
    const flatRoof = u.roof === '1000' || (fresh && seen?.flat === true);
    const industrial = style === BS.WALL_COMMERCIAL;
    // (a roof of low pitch – under 15° – is not tiled: bitumen, metal or gravel, grey to dark, as on a flat roof)
    const lowPitch = fresh && !flatRoof && !industrial && steepestRoofNy(u.polys) > LOW_PITCH_NY;
    const roofStyle = seen?.roofStyle ?? (flatRoof || lowPitch ? BS.ROOF_FLAT : industrial ? BS.ROOF_METAL : BS.ROOF_TILES);
    const roofCol = seen?.roof ?? (flatRoof ? pick(ROOFS_FLAT, seed + 7) : lowPitch ? pick(ROOFS_LOW, seed + 7) : industrial ? pick(ROOFS_METAL, seed + 7) : pick(ROOFS_TILE, seed + 7));
    stats.lod2Units++;

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
        // (a wall measured on site: its real windows, doors … as geometry, and no window grid of the shader's)
        const measured = kind === 0 ? facades.get(u.id) : undefined;
        const hit = measured ? matchWall(poly, 1, n, ua[0], ua[2], measured) : null;
        const first = tile.bldg.count;
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
        if (hit && tile.bldg.count > first) {
          tile.bldgObs.push(first, tile.bldg.count - first);
          const foot = Number.isFinite(hit.wall.base) ? (hit.wall.base as number) : lo;
          stats.triangles += emitWallDetail(tile.fdet, hit.wall, hit.A, hit.B, nx / hl, nz / hl, foot, hi, wallCol);
        }
      }
    }
  }
  return boxes;
}

/** the list of what was seen on site that the published map was built with (outside the detail region) */
const PUBLISHED_LIST = fileURLToPath(new URL('./observed-buildings.published.json', import.meta.url));

/** The middle of a model's box (as addLod2Buildings finds it). */
function unitMiddle(u: Lod2Unit): [number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const poly of u.polys) {
    for (let i = 1; i < poly.length; i += 3) {
      minX = Math.min(minX, poly[i]);
      maxX = Math.max(maxX, poly[i]);
      minZ = Math.min(minZ, poly[i + 2]);
      maxZ = Math.max(maxZ, poly[i + 2]);
    }
  }
  return [(minX + maxX) / 2, (minZ + maxZ) / 2];
}

/** The up-component of the normal of a model's steepest roof plane (1: all flat). */
function steepestRoofNy(polys: number[][]): number {
  let min = 1;
  for (const poly of polys) {
    if (poly[0] !== 1) continue;
    const n = (poly.length - 1) / 3;
    if (n < 3) continue;
    const nrm = newell(poly, 1, n);
    const l = Math.hypot(nrm[0], nrm[1], nrm[2]);
    if (l < 1e-6) continue;
    const ny = nrm[1] / l;
    if (ny > 0.3) min = Math.min(min, ny);
  }
  return min;
}

/**
 * Make a model's roof flat: every point from its eaves (the lowest point of
 * its roof planes) up is put at one height – `at` of the way from the eaves
 * (0) to the ridge (1).  The roof planes become one flat roof, the walls end
 * there (gables shrink to nothing).
 */
export function flattenRoof(polys: number[][], at = 0): void {
  let eave = Infinity;
  let ridge = -Infinity;
  for (const poly of polys) {
    if (poly[0] !== 1) continue;
    for (let i = 2; i < poly.length; i += 3) {
      eave = Math.min(eave, poly[i]);
      ridge = Math.max(ridge, poly[i]);
    }
  }
  if (!Number.isFinite(eave)) return;
  const level = eave + (ridge - eave) * at;
  for (const poly of polys) {
    if (poly[0] === 2) continue;
    for (let i = 2; i < poly.length; i += 3) if (poly[i] >= eave - 0.05) poly[i] = level;
  }
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

/** A building model's footprints and box (addLod2Buildings): where an OpenStreetMap footprint is not needed. */
export interface Lod2Foot {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  rings: number[][];
}

/** How a footprint is raised (extrude). */
interface Extrusion {
  base: number;
  /** to the eaves (m) */
  wall: number;
  /** ridge above the eaves (m; 0: flat) */
  ridge: number;
  roof: 'flat' | 'gable' | 'hip';
  style: number;
  wallCol: RGB;
  /** the roof's colour and face style (undefined: by the roof and the style) */
  roofCol?: RGB;
  roofStyle?: number;
  seed: number;
}

/**
 * Raise a footprint (counter-clockwise seen from above, flat [x,z,…]) to a
 * building: walls, and a gable or hip roof on a rectangle, else a flat lid;
 * its footprint as a collision ring.
 */
function extrude(ts: TileSet, ring: number[], o: Extrusion, stats: BuildingStats): void {
  const n = ring.length / 2;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i * 2];
    cz += ring[i * 2 + 1];
  }
  cx /= n;
  cz /= n;
  const { base, wall, style, wallCol, seed } = o;
  const tile = ts.at(cx, cz);
  const m = tile.bldg;
  const yTop = base + wall;

  // gable or hip roof only for plain rectangles; everything else gets a flat lid
  let ridgeAxis = -1;
  if (o.roof !== 'flat' && o.ridge > 0 && n === 4) {
    const l0 = Math.hypot(ring[2] - ring[0], ring[3] - ring[1]);
    const l1 = Math.hypot(ring[4] - ring[2], ring[5] - ring[3]);
    ridgeAxis = l0 >= l1 ? 0 : 1; // ridge runs parallel to the longer pair of sides
  }
  const short = n === 4 ? Math.min(Math.hypot(ring[2] - ring[0], ring[3] - ring[1]), Math.hypot(ring[4] - ring[2], ring[5] - ring[3])) : 0;
  const ridgeH = ridgeAxis >= 0 ? Math.min(o.ridge, 0.5 * short * 0.78) : 0;
  const gable = ridgeAxis >= 0 && o.roof === 'gable';

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
    if (gable && i % 2 !== ridgeAxis) {
      // gable end
      const g = m.vert((ax + bx) / 2, yTop + ridgeH, (az + bz) / 2, ...at(L / 2, wall + ridgeH));
      m.tri(v3, v2, g, nx, 0, nz);
      stats.triangles++;
    }
  }
  const roofCol = o.roofCol ?? (ridgeAxis >= 0 ? pick(ROOFS_TILE, seed + 7) : style === BS.WALL_COMMERCIAL ? pick(ROOFS_METAL, seed + 7) : pick(ROOFS_FLAT, seed + 7));
  if (ridgeAxis >= 0) {
    // the ridge between the middles of the gable ends – on a hip roof shortened by half the width at each end
    const mid = (i: number): [number, number] => [(ring[i * 2] + ring[((i + 1) % 4) * 2]) / 2, (ring[i * 2 + 1] + ring[((i + 1) % 4) * 2 + 1]) / 2];
    const gA = mid(ridgeAxis === 0 ? 1 : 0);
    const gB = mid(ridgeAxis === 0 ? 3 : 2);
    let rA = gA;
    let rB = gB;
    if (o.roof === 'hip') {
      const len = Math.hypot(gB[0] - gA[0], gB[1] - gA[1]);
      const t = len > 1e-6 ? Math.min(short / 2, len / 2) / len : 0;
      rA = [gA[0] + (gB[0] - gA[0]) * t, gA[1] + (gB[1] - gA[1]) * t];
      rB = [gB[0] + (gA[0] - gB[0]) * t, gB[1] + (gA[1] - gB[1]) * t];
    }
    // ridge end nearest to a corner
    const near = (px: number, pz: number): [number, number] => (Math.hypot(px - gA[0], pz - gA[1]) < Math.hypot(px - gB[0], pz - gB[1]) ? rA : rB);
    const rs = o.roofStyle ?? BS.ROOF_TILES;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const ax = ring[i * 2];
      const az = ring[i * 2 + 1];
      const bx = ring[j * 2];
      const bz = ring[j * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const ra = near(ax, az);
      const rb = near(bx, bz);
      const slope = Math.hypot((ra[0] + rb[0]) / 2 - (ax + bx) / 2, (ra[1] + rb[1]) / 2 - (az + bz) / 2, ridgeH);
      const at = (u: number, v: number): number[] => [rs, roofCol[0], roofCol[1], roofCol[2], u, v, 0, 0];
      if (i % 2 === ridgeAxis) {
        // two roof planes between the eaves (sides parallel to the ridge) and the ridge line
        const v0 = m.vert(ax, yTop, az, ...at(0, 0));
        const v1 = m.vert(bx, yTop, bz, ...at(L, 0));
        const v2 = m.vert(rb[0], yTop + ridgeH, rb[1], ...at(L, slope));
        const v3 = m.vert(ra[0], yTop + ridgeH, ra[1], ...at(0, slope));
        m.quad(v0, v1, v2, v3, 0, 1, 0);
        stats.triangles += 2;
      } else if (o.roof === 'hip') {
        // the hipped end
        const v0 = m.vert(ax, yTop, az, ...at(0, 0));
        const v1 = m.vert(bx, yTop, bz, ...at(L, 0));
        const v2 = m.vert(ra[0], yTop + ridgeH, ra[1], ...at(L / 2, slope));
        m.tri(v0, v1, v2, 0, 1, 0);
        stats.triangles++;
      }
    }
  } else {
    const tris = earcut(ring, undefined, 2);
    const idx: number[] = [];
    const rs = o.roofStyle ?? (style === BS.WALL_COMMERCIAL ? BS.ROOF_METAL : BS.ROOF_FLAT);
    for (let i = 0; i < n; i++) idx.push(m.vert(ring[i * 2], yTop, ring[i * 2 + 1], rs, roofCol[0], roofCol[1], roofCol[2], ring[i * 2] - cx, ring[i * 2 + 1] - cz, 0, 0));
    for (let t = 0; t < tris.length; t += 3) m.tri(idx[tris[t]], idx[tris[t + 1]], idx[tris[t + 2]], 0, 1, 0);
    stats.triangles += tris.length / 3;
  }
  tile.collCnt.push(n);
  for (let i = 0; i < n; i++) tile.collPts.push(ring[i * 2], ring[i * 2 + 1]);
  stats.footprints++;
}

/** The mean of a ring's corners. */
function ringMiddle(ring: number[]): [number, number] {
  const n = ring.length / 2;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i * 2];
    cz += ring[i * 2 + 1];
  }
  return [cx / n, cz / n];
}

/** A footprint turned counter-clockwise (seen from above); its area (m², ≥ 0). */
function ccw(ring: number[]): number {
  const n = ring.length / 2;
  const area = ringArea(ring);
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
  return Math.abs(area);
}

/** The places in a footprint that tell whether another footprint covers it: its middle and its corners pulled a third towards it. */
function probes(ring: number[]): number[] {
  const n = ring.length / 2;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i * 2];
    cz += ring[i * 2 + 1];
  }
  cx /= n;
  cz /= n;
  const out = pointInRing(cx, cz, ring) ? [cx, cz] : [];
  for (let i = 0; i < n; i++) out.push(ring[i * 2] + (cx - ring[i * 2]) / 3, ring[i * 2 + 1] + (cz - ring[i * 2 + 1]) / 3);
  return out;
}

/** A grid of footprints: does any of them cover a part of a footprint? */
class FootIndex {
  private readonly cells = new Map<string, number[][]>();
  private static readonly CELL = 64;

  add(ring: number[]): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]);
      maxX = Math.max(maxX, ring[i]);
      minZ = Math.min(minZ, ring[i + 1]);
      maxZ = Math.max(maxZ, ring[i + 1]);
    }
    const C = FootIndex.CELL;
    for (let a = Math.floor(minX / C); a <= Math.floor(maxX / C); a++) {
      for (let b = Math.floor(minZ / C); b <= Math.floor(maxZ / C); b++) {
        const k = `${a},${b}`;
        const list = this.cells.get(k);
        if (list) list.push(ring);
        else this.cells.set(k, [ring]);
      }
    }
  }

  /** Does a footprint of the index cover any of the probe points of `ring`? */
  covers(ring: number[]): boolean {
    const p = probes(ring);
    const C = FootIndex.CELL;
    for (let i = 0; i < p.length; i += 2) {
      const list = this.cells.get(`${Math.floor(p[i] / C)},${Math.floor(p[i + 1] / C)}`);
      if (list) for (const r of list) if (pointInRing(p[i], p[i + 1], r)) return true;
    }
    return false;
  }
}

/**
 * OpenStreetMap footprints where there is no building model: outside the
 * municipalities with LoD2 models, and – given their footprints (`lod2`,
 * from addLod2Buildings) – inside them where no model covers the footprint
 * (what was built after the models were made, sheds, garden huts).  Then the
 * buildings seen on the aerial photographs that neither has
 * (tools/mapgen/observed-buildings.json "add"); "remove" leaves out models
 * and footprints ("w<OSM id>") that are not there.
 */
export function addOsmBuildings(
  osm: OsmData,
  ts: TileSet,
  terrain: TerrainGrid,
  inWorld: (x: number, z: number) => boolean,
  municipality: number[][],
  stats: BuildingStats,
  lod2?: Lod2Foot[],
  edits: { add: ObservedAdd[]; remove: Set<string> } = loadObservedEdits(),
  /** only the footprints and added buildings whose middle this says yes to (the detail region – mapgen/detailregion.ts) */
  keep?: (x: number, z: number) => boolean,
): void {
  const insideMunicipality = (x: number, z: number): boolean => {
    let inside = false;
    for (const ring of municipality) if (pointInRing(x, z, ring)) inside = !inside;
    return inside;
  };
  const models = new FootIndex();
  if (lod2) for (const f of lod2) for (const r of f.rings) models.add(r);
  // (the buildings to add go first: an OSM footprint where one is added is the same building)
  const added = new FootIndex();
  const adds: Array<{ a: ObservedAdd; ring: number[]; area: number }> = [];
  for (const a of edits.add) {
    const ring = a.pts.flatMap((p) => [p[0], p[1]]);
    const area = ccw(ring);
    if (area < 1) continue;
    if (keep && !keep(...ringMiddle(ring))) continue;
    added.add(ring);
    adds.push({ a, ring, area });
  }
  for (const w of osm.ways) {
    if (!w.tags.building || !isClosedWay(w)) continue;
    if (w.tags.building === 'no' || w.tags.location === 'underground') continue;
    if (edits.remove.has(`w${w.id}`)) continue;
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
    if (!inWorld(cx, cz)) continue;
    if (keep && !keep(cx, cz)) continue;
    // counter-clockwise ring (seen from above) so that edge normals point outwards
    const area = ccw(ring);
    if (area < 4) continue;
    if (insideMunicipality(cx, cz) && (!lod2 || models.covers(ring))) continue;
    if (added.covers(ring)) continue;
    const { wall, ridge, style } = fallbackHeights(w.tags, area);
    let base = Infinity;
    for (let i = 0; i < n; i++) base = Math.min(base, terrain.at(ring[i * 2], ring[i * 2 + 1]));
    if (!Number.isFinite(base)) continue;
    const seed = (Math.round(cx * 13.7) * 73856093) ^ (Math.round(cz * 17.3) * 19349663);
    const wallCol =
      style === BS.WALL_HOUSE ? pick(WALLS_HOUSE, seed) : style === BS.WALL_COMMERCIAL ? pick(WALLS_COMMERCIAL, seed) : style === BS.WALL_PUBLIC || style === BS.WALL_CHURCH ? pick(WALLS_PUBLIC, seed) : pick(WALLS_GARAGE, seed);
    extrude(ts, ring, { base, wall, ridge, roof: ridge > 0 ? 'gable' : 'flat', style, wallCol, seed }, stats);
    stats.osmFallback++;
  }
  for (const { a, ring, area } of adds) {
    const n = ring.length / 2;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cx += ring[i * 2];
      cz += ring[i * 2 + 1];
    }
    cx /= n;
    cz /= n;
    if (!inWorld(cx, cz)) continue;
    let base = Infinity;
    for (let i = 0; i < n; i++) base = Math.min(base, terrain.at(ring[i * 2], ring[i * 2 + 1]));
    if (!Number.isFinite(base)) continue;
    const seed = (Math.round(cx * 13.7) * 73856093) ^ (Math.round(cz * 17.3) * 19349663);
    const style = a.height < 3.6 ? (area < 14 ? BS.WALL_PLAIN : BS.WALL_GARAGE) : a.roof === 'flat' && area > 150 ? BS.WALL_COMMERCIAL : BS.WALL_HOUSE;
    const wallCol = a.wall ?? (style === BS.WALL_HOUSE ? pick(WALLS_HOUSE, seed) : style === BS.WALL_COMMERCIAL ? pick(WALLS_COMMERCIAL, seed) : pick(WALLS_GARAGE, seed));
    const ridge = a.roof === 'flat' ? 0 : (a.ridge ?? 3.5);
    extrude(ts, ring, { base, wall: a.height, ridge, roof: a.roof, style, wallCol, roofCol: a.roofColour, roofStyle: a.roofStyle ?? (a.roof === 'flat' ? BS.ROOF_FLAT : undefined), seed }, stats);
    stats.osmFallback++;
  }
}
