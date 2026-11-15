// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Ground-cover raster: what the terrain between the roads is made of.
 *
 * OSM land-use/natural polygons are painted into a 2 m grid covering the
 * whole world rectangle.  The game uses it to colour the terrain and scatter
 * vegetation; the pipeline also derives the "built-up area" mask from it
 * (needed for implicit 50/100 km/h limits and sidewalk defaults).
 */
import { COVER } from '../../src/world/cover.ts';
import type { OsmData, Tags } from './osm.ts';
import { isClosedWay } from './osm.ts';

export class CoverMap {
  readonly cell: number;
  readonly minX: number;
  readonly minZ: number;
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
  /** coarse built-up mask (10 m cells) */
  readonly bCell = 10;
  readonly bw: number;
  readonly bh: number;
  readonly built: Uint8Array;

  constructor(minX: number, minZ: number, maxX: number, maxZ: number, cell = 2) {
    this.cell = cell;
    this.minX = minX;
    this.minZ = minZ;
    this.w = Math.round((maxX - minX) / cell);
    this.h = Math.round((maxZ - minZ) / cell);
    this.data = new Uint8Array(this.w * this.h);
    this.bw = Math.ceil((maxX - minX) / this.bCell);
    this.bh = Math.ceil((maxZ - minZ) / this.bCell);
    this.built = new Uint8Array(this.bw * this.bh);
  }

  at(x: number, z: number): number {
    const ix = Math.floor((x - this.minX) / this.cell);
    const iz = Math.floor((z - this.minZ) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.h) return COVER.MEADOW;
    return this.data[iz * this.w + ix];
  }

  builtUp(x: number, z: number): boolean {
    const ix = Math.floor((x - this.minX) / this.bCell);
    const iz = Math.floor((z - this.minZ) / this.bCell);
    if (ix < 0 || iz < 0 || ix >= this.bw || iz >= this.bh) return false;
    return this.built[iz * this.bw + ix] !== 0;
  }

  /** Even-odd scanline fill of a set of rings (flat [x,z,…]) into a grid. */
  static fillGrid(
    rings: number[][],
    grid: Uint8Array,
    gw: number,
    gh: number,
    minX: number,
    minZ: number,
    cell: number,
    value: number,
  ): void {
    let zLo = Infinity;
    let zHi = -Infinity;
    for (const r of rings) {
      for (let i = 1; i < r.length; i += 2) {
        if (r[i] < zLo) zLo = r[i];
        if (r[i] > zHi) zHi = r[i];
      }
    }
    const row0 = Math.max(0, Math.floor((zLo - minZ) / cell));
    const row1 = Math.min(gh - 1, Math.floor((zHi - minZ) / cell));
    const xs: number[] = [];
    for (let row = row0; row <= row1; row++) {
      const zc = minZ + (row + 0.5) * cell;
      xs.length = 0;
      for (const r of rings) {
        const n = r.length;
        for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
          const zi = r[i + 1];
          const zj = r[j + 1];
          if (zi > zc !== zj > zc) xs.push(r[j] + ((zc - zj) / (zi - zj)) * (r[i] - r[j]));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - minX) / cell - 0.5));
        const c1 = Math.min(gw - 1, Math.floor((xs[k + 1] - minX) / cell - 0.5));
        if (c1 >= c0) grid.fill(value, row * gw + c0, row * gw + c1 + 1);
      }
    }
  }

  paint(rings: number[][], value: number): void {
    CoverMap.fillGrid(rings, this.data, this.w, this.h, this.minX, this.minZ, this.cell, value);
  }

  paintBuilt(rings: number[][]): void {
    CoverMap.fillGrid(rings, this.built, this.bw, this.bh, this.minX, this.minZ, this.bCell, 1);
  }

  /** Paint a thick polyline (flat [x,z,…]). */
  paintLine(pts: number[], width: number, value: number): void {
    const r = Math.max(width / 2, this.cell * 0.5);
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i];
      const az = pts[i + 1];
      const bx = pts[i + 2];
      const bz = pts[i + 3];
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(len / (this.cell * 0.5)));
      for (let s = 0; s <= steps; s++) {
        const x = ax + ((bx - ax) * s) / steps;
        const z = az + ((bz - az) * s) / steps;
        const c0 = Math.max(0, Math.floor((x - r - this.minX) / this.cell));
        const c1 = Math.min(this.w - 1, Math.floor((x + r - this.minX) / this.cell));
        const r0 = Math.max(0, Math.floor((z - r - this.minZ) / this.cell));
        const r1 = Math.min(this.h - 1, Math.floor((z + r - this.minZ) / this.cell));
        // (a point beside the raster has no columns: without this check a negative end index would count
        // from the end of the array and flood the map)
        if (c1 < c0) continue;
        for (let row = r0; row <= r1; row++) this.data.fill(value, row * this.w + c0, row * this.w + c1 + 1);
      }
    }
  }

  /** Grow the built-up mask by `cells` (box dilation). */
  dilateBuilt(cells: number): void {
    const { bw, bh } = this;
    for (let pass = 0; pass < cells; pass++) {
      const src = this.built.slice();
      for (let z = 0; z < bh; z++) {
        for (let x = 0; x < bw; x++) {
          if (src[z * bw + x]) continue;
          if (
            (x > 0 && src[z * bw + x - 1]) ||
            (x < bw - 1 && src[z * bw + x + 1]) ||
            (z > 0 && src[(z - 1) * bw + x]) ||
            (z < bh - 1 && src[(z + 1) * bw + x])
          ) {
            this.built[z * bw + x] = 1;
          }
        }
      }
    }
  }
}

/** Painting order: later entries overwrite earlier ones. */
const LAYERS: Array<{ match: (t: Tags) => boolean; cover: number; built?: boolean }> = [
  { match: (t) => t.landuse === 'farmland', cover: COVER.FARMLAND },
  { match: (t) => t.landuse === 'meadow' || t.natural === 'grassland' || t.landuse === 'greenfield', cover: COVER.MEADOW },
  { match: (t) => t.landuse === 'orchard' || t.landuse === 'plant_nursery', cover: COVER.ORCHARD },
  { match: (t) => t.landuse === 'residential', cover: COVER.RESIDENTIAL, built: true },
  { match: (t) => t.landuse === 'commercial' || t.landuse === 'retail', cover: COVER.COMMERCIAL, built: true },
  { match: (t) => t.landuse === 'industrial' || t.landuse === 'garages', cover: COVER.INDUSTRIAL, built: true },
  { match: (t) => t.landuse === 'farmyard', cover: COVER.FARMYARD },
  { match: (t) => t.landuse === 'allotments', cover: COVER.ALLOTMENT },
  { match: (t) => t.landuse === 'cemetery' || t.amenity === 'grave_yard', cover: COVER.CEMETERY },
  { match: (t) => t.landuse === 'religious' || t.amenity === 'school' || t.amenity === 'kindergarten', cover: COVER.RESIDENTIAL },
  { match: (t) => t.landuse === 'railway', cover: COVER.RAILWAY },
  {
    match: (t) =>
      t.landuse === 'quarry' || t.landuse === 'construction' || t.landuse === 'brownfield' || t.landuse === 'landfill',
    cover: COVER.BARE,
  },
  { match: (t) => t.natural === 'scrub' || t.natural === 'heath', cover: COVER.SCRUB },
  { match: (t) => t.landuse === 'forest' || t.natural === 'wood', cover: COVER.FOREST },
  {
    match: (t) =>
      t.landuse === 'grass' ||
      t.landuse === 'village_green' ||
      t.landuse === 'recreation_ground' ||
      t.leisure === 'park' ||
      t.leisure === 'garden' ||
      t.leisure === 'playground' ||
      t.leisure === 'common' ||
      t.landuse === 'flowerbed',
    cover: COVER.GRASS,
  },
  { match: (t) => t.leisure === 'pitch' || t.leisure === 'track', cover: COVER.PITCH },
  {
    match: (t) =>
      (t.amenity === 'parking' && t.parking !== 'underground' && t.parking !== 'multi-storey') ||
      t.amenity === 'parking_space' ||
      t.amenity === 'fuel' ||
      t.highway === 'rest_area' ||
      t.highway === 'services',
    cover: COVER.ASPHALT,
  },
  {
    match: (t) =>
      (t.highway === 'pedestrian' || t.highway === 'footway' || t.highway === 'service') && t.area === 'yes',
    cover: COVER.PAVED,
  },
  { match: (t) => t.railway === 'platform' || t.public_transport === 'platform', cover: COVER.PAVED },
  {
    match: (t) =>
      t.natural === 'water' || t.landuse === 'basin' || t.landuse === 'reservoir' || t.waterway === 'riverbank',
    cover: COVER.WATER,
  },
];

export function buildCover(
  osm: OsmData,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): CoverMap {
  const cover = new CoverMap(minX, minZ, maxX, maxZ, 2);
  cover.data.fill(COVER.MEADOW);

  // Collect polygons once: closed ways and multipolygon relations.
  const polys: Array<{ tags: Tags; rings: number[][] }> = [];
  for (const w of osm.ways) {
    if (!isClosedWay(w)) continue;
    const t = w.tags;
    if (!t || Object.keys(t).length === 0) continue;
    if (t.building || t['building:part']) continue;
    const ring = osm.wayCoords(w);
    ring.length -= 2; // drop repeated closing point
    if (ring.length >= 6) polys.push({ tags: t, rings: [ring] });
  }
  for (const r of osm.relations) {
    if (r.tags.type !== 'multipolygon' || r.tags.building) continue;
    const { outer, inner } = osm.multipolygonRings(r);
    if (outer.length) polys.push({ tags: r.tags, rings: [...outer, ...inner] });
  }

  for (const layer of LAYERS) {
    for (const p of polys) {
      if (!layer.match(p.tags)) continue;
      cover.paint(p.rings, layer.cover);
      if (layer.built) cover.paintBuilt(p.rings);
    }
  }

  // Linear water features
  for (const w of osm.ways) {
    const ww = w.tags.waterway;
    if (!ww || w.tags.tunnel) continue;
    const width = ww === 'river' ? 9 : ww === 'stream' ? 2.2 : ww === 'canal' ? 6 : 0;
    if (width > 0) cover.paintLine(osm.wayCoords(w), width, COVER.WATER);
  }

  cover.dilateBuilt(3);
  return cover;
}
