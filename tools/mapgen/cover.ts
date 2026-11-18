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
  /**
   * While the map is painted (`sub` > 1): the same raster `sub` times finer
   * (sub × sub small cells to a cell, the middle one on the cell's centre).
   * finish() takes the cells' classes from it (the class at the centre, as
   * before) and how far each centre lies from the edge of its class (`edge`),
   * and lets it go.
   */
  fine: Uint8Array | null = null;
  readonly sub: number;
  readonly fw: number;
  readonly fh: number;
  /**
   * After finish(): per cell how far its centre lies inside its class's area
   * (to the nearest point of another class), coded by edgeByte(): what the
   * renderer needs to draw the edges between the classes as smooth lines
   * instead of the steps of the raster (src/render/coveredge.ts).
   */
  edge: Uint8Array | null = null;
  /**
   * Cells that keep the cover of the published map (outside the detail
   * region, tile by tile: mergeLegacyCover); null: none.
   */
  legacyCells: Uint8Array | null = null;

  constructor(minX: number, minZ: number, maxX: number, maxZ: number, cell = 2, sub = 1) {
    this.cell = cell;
    this.minX = minX;
    this.minZ = minZ;
    this.w = Math.round((maxX - minX) / cell);
    this.h = Math.round((maxZ - minZ) / cell);
    this.data = new Uint8Array(this.w * this.h);
    this.bw = Math.ceil((maxX - minX) / this.bCell);
    this.bh = Math.ceil((maxZ - minZ) / this.bCell);
    this.built = new Uint8Array(this.bw * this.bh);
    this.sub = sub > 1 ? Math.round(sub) | 1 : 1; // odd: a small cell sits on each cell's centre
    this.fw = this.w * this.sub;
    this.fh = this.h * this.sub;
    if (this.sub > 1) this.fine = new Uint8Array(this.fw * this.fh);
  }

  /** Fill everything with one class. */
  fillAll(value: number): void {
    (this.fine ?? this.data).fill(value);
  }

  /**
   * The cells' classes from the fine raster, and how far each cell's centre
   * lies from the edge of its class (`edge`, up to EDGE_MAX m); then the fine
   * raster is let go.  Without a fine raster: nothing.
   */
  finish(): void {
    const f = this.fine;
    if (!f) return;
    const { w, h, sub, fw } = this;
    const mid = (sub - 1) / 2;
    for (let j = 0; j < h; j++) {
      const row = (j * sub + mid) * fw + mid;
      for (let i = 0; i < w; i++) this.data[j * w + i] = f[row + i * sub];
    }
    this.edge = coverEdges(f, this.data, w, h, sub, this.cell / sub);
    this.fine = null;
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
    fillSpans(rings, gh, minZ, cell, minX, gw, (row, c0, c1) => grid.fill(value, row * gw + c0, row * gw + c1 + 1));
  }

  paint(rings: number[][], value: number): void {
    if (this.fine) CoverMap.fillGrid(rings, this.fine, this.fw, this.fh, this.minX, this.minZ, this.cell / this.sub, value);
    else CoverMap.fillGrid(rings, this.data, this.w, this.h, this.minX, this.minZ, this.cell, value);
  }

  /** Paint a polygon into the fine raster only where it has class `over` (before finish()). */
  paintOver(rings: number[][], value: number, over: number): void {
    if (!this.fine) return;
    const { fine, fw } = this;
    const c = this.cell / this.sub;
    fillSpans(rings, this.fh, this.minZ, c, this.minX, fw, (row, c0, c1) => {
      for (let k = row * fw + c0, e = row * fw + c1; k <= e; k++) if (fine[k] === over) fine[k] = value;
    });
  }

  /** A band of half-width `r` round a polyline (flat [x,z,…]) into the fine raster where it has class `over` (before finish()). */
  paintBandOver(pts: number[], r: number, value: number, over: number): void {
    if (!this.fine) return;
    const { fine, fw } = this;
    capsuleSpans(pts, r, this.fh, this.fw, this.minX, this.minZ, this.cell / this.sub, (row, c0, c1) => {
      for (let k = row * fw + c0, e = row * fw + c1; k <= e; k++) if (fine[k] === over) fine[k] = value;
    });
  }

  paintBuilt(rings: number[][]): void {
    CoverMap.fillGrid(rings, this.built, this.bw, this.bh, this.minX, this.minZ, this.bCell, 1);
  }

  /**
   * Paint a thick polyline (flat [x,z,…]).  While there is a fine raster: a
   * band with round ends into it; after finish(): the cells whose centre the
   * band covers, their edges kept up to date (the band's edge is drawn
   * smooth as well); otherwise every cell the band touches.
   */
  paintLine(pts: number[], width: number, value: number): void {
    if (this.fine) {
      const { fine, fw } = this;
      capsuleSpans(pts, width / 2, this.fh, fw, this.minX, this.minZ, this.cell / this.sub, (row, c0, c1) => fine.fill(value, row * fw + c0, row * fw + c1 + 1));
      return;
    }
    if (this.edge) {
      // (cells as the published map has them – outside the detail region – painted as there: mergeLegacyCover)
      if (this.legacyCells) this.paintLineCells(pts, width, value, this.legacyCells);
      this.paintLineEdged(pts, width / 2, value);
      return;
    }
    this.paintLineCells(pts, width, value, null);
  }

  /** paintLine on a plain raster: every cell the band touches (with `only`: of those, the cells marked 1 there). */
  private paintLineCells(pts: number[], width: number, value: number, only: Uint8Array | null): void {
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
        if (only) {
          for (let row = r0; row <= r1; row++) for (let k = row * this.w + c0, e = row * this.w + c1; k <= e; k++) if (only[k]) this.data[k] = value;
        } else for (let row = r0; row <= r1; row++) this.data.fill(value, row * this.w + c0, row * this.w + c1 + 1);
      }
    }
  }

  /** paintLine after finish(): the cells whose centre lies in the band, and the distances to its edge. */
  private paintLineEdged(pts: number[], r: number, value: number): void {
    const edge = this.edge as Uint8Array;
    const { w, h, cell } = this;
    const reach = r + EDGE_MAX;
    // each cell near the line: its distance to the line
    const near = new Map<number, number>();
    for (let s = 0; s + 3 < pts.length; s += 2) {
      const ax = pts[s];
      const az = pts[s + 1];
      const bx = pts[s + 2];
      const bz = pts[s + 3];
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - this.minX) / cell));
      const i1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + reach - this.minX) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - this.minZ) / cell));
      const j1 = Math.min(h - 1, Math.floor((Math.max(az, bz) + reach - this.minZ) / cell));
      for (let j = j0; j <= j1; j++) {
        const z = this.minZ + (j + 0.5) * cell;
        for (let i = i0; i <= i1; i++) {
          const d = segDist(this.minX + (i + 0.5) * cell, z, ax, az, bx, bz);
          if (d > reach) continue;
          const k = j * w + i;
          const old = near.get(k);
          if (old === undefined || d < old) near.set(k, d);
        }
      }
    }
    for (const [k, d] of near) {
      if (this.legacyCells?.[k]) continue;
      const had = this.data[k];
      if (d <= r) {
        this.data[k] = value;
        edge[k] = edgeByte(had === value ? Math.max(edgeMetres(edge[k]), r - d) : r - d);
      } else if (had !== value) {
        edge[k] = edgeByte(Math.min(edgeMetres(edge[k]), d - r));
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

/** how far (m) the edge distances of the cover reach: farther is stored as this */
export const EDGE_MAX = 3;

/** A distance to the edge of a cell's class (m) as stored: 1 + tenths of a metre up to EDGE_MAX (0: not known). */
export function edgeByte(d: number): number {
  return 1 + Math.max(0, Math.min(EDGE_MAX * 10, Math.round(d * 10)));
}

/** The distance (m) a stored edge byte stands for (0 – not known – as far). */
export function edgeMetres(b: number): number {
  return b ? (b - 1) / 10 : EDGE_MAX;
}

/** Distance of a point from a segment. */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

/** The runs of cells (row, first column, last column) whose centres lie inside a set of rings (even-odd). */
function fillSpans(
  rings: number[][],
  gh: number,
  minZ: number,
  cell: number,
  minX: number,
  gw: number,
  span: (row: number, c0: number, c1: number) => void,
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
      if (c1 >= c0) span(row, c0, c1);
    }
  }
}

/**
 * The runs of cells whose centres lie within `r` of a polyline (flat
 * [x,z,…]) – a band with round ends and joints – segment by segment (runs
 * of neighbouring segments overlap).
 */
export function capsuleSpans(
  pts: number[],
  r: number,
  gh: number,
  gw: number,
  minX: number,
  minZ: number,
  cell: number,
  span: (row: number, c0: number, c1: number) => void,
): void {
  if (!(r > 0)) return;
  const segs = pts.length >= 4 ? pts.length - 2 : pts.length === 2 ? 2 : 0;
  for (let s = 0; s < segs; s += 2) {
    const ax = pts[s];
    const az = pts[s + 1];
    const bx = pts.length >= 4 ? pts[s + 2] : ax;
    const bz = pts.length >= 4 ? pts[s + 3] : az;
    const L = Math.hypot(bx - ax, bz - az);
    const nx = L > 1e-9 ? (-(bz - az) / L) * r : 0;
    const nz = L > 1e-9 ? ((bx - ax) / L) * r : 0;
    // the band's rectangle: A+n, B+n, B−n, A−n
    const qx = [ax + nx, bx + nx, bx - nx, ax - nx];
    const qz = [az + nz, bz + nz, bz - nz, az - nz];
    const row0 = Math.max(0, Math.floor((Math.min(az, bz) - r - minZ) / cell));
    const row1 = Math.min(gh - 1, Math.floor((Math.max(az, bz) + r - minZ) / cell));
    for (let row = row0; row <= row1; row++) {
      const zc = minZ + (row + 0.5) * cell;
      let lo = Infinity;
      let hi = -Infinity;
      for (const [px, pz] of [
        [ax, az],
        [bx, bz],
      ]) {
        const dz = zc - pz;
        if (Math.abs(dz) <= r) {
          const h = Math.sqrt(r * r - dz * dz);
          lo = Math.min(lo, px - h);
          hi = Math.max(hi, px + h);
        }
      }
      if (L > 1e-9) {
        for (let e = 0; e < 4; e++) {
          const f = (e + 1) % 4;
          const z0 = qz[e];
          const z1 = qz[f];
          if (z0 === z1 || (z0 - zc) * (z1 - zc) > 0) continue;
          const x = qx[e] + ((zc - z0) / (z1 - z0)) * (qx[f] - qx[e]);
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
      }
      if (lo > hi) continue;
      const c0 = Math.max(0, Math.ceil((lo - minX) / cell - 0.5));
      const c1 = Math.min(gw - 1, Math.floor((hi - minX) / cell - 0.5));
      if (c1 >= c0) span(row, c0, c1);
    }
  }
}

/**
 * For each cell (classes `data`, w × h) of a fine raster `fine` (sub × sub
 * small cells of size `fc` to a cell): how far its centre lies from the
 * nearest small cell of another class, as edgeByte().  Only cells with
 * another class within two cells are searched; the rest are far.
 */
export function coverEdges(fine: Uint8Array, data: Uint8Array, w: number, h: number, sub: number, fc: number): Uint8Array {
  const fw = w * sub;
  const fh = h * sub;
  const far = edgeByte(EDGE_MAX);
  const out = new Uint8Array(w * h).fill(far);
  // each cell: its class if all its small cells have it, else 255
  const u = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const c = data[j * w + i];
      let same = true;
      for (let b = 0; b < sub && same; b++) {
        const row = (j * sub + b) * fw + i * sub;
        for (let a = 0; a < sub; a++) {
          if (fine[row + a] !== c) {
            same = false;
            break;
          }
        }
      }
      u[j * w + i] = same ? c : 255;
    }
  }
  // all 5 × 5 cells round a cell uniform and of its class? (separable: rows first)
  const R = 2;
  const hOk = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const c = data[j * w + i];
      let ok = 1;
      for (let a = Math.max(0, i - R); a <= Math.min(w - 1, i + R) && ok; a++) if (u[j * w + a] !== c) ok = 0;
      hOk[j * w + i] = ok;
    }
  }
  // the small cells round a centre, nearest first
  const reach = Math.ceil(EDGE_MAX / fc + 0.5);
  const offs: Array<[number, number, number]> = [];
  for (let b = -reach; b <= reach; b++) for (let a = -reach; a <= reach; a++) if (a || b) offs.push([a, b, Math.hypot(a, b) * fc]);
  offs.sort((p, q) => p[2] - q[2]);
  const mid = (sub - 1) / 2;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const c = data[k];
      let ok = hOk[k] === 1;
      for (let b = Math.max(0, j - R); b <= Math.min(h - 1, j + R) && ok; b++) if (!hOk[b * w + i] || data[b * w + i] !== c) ok = false;
      if (ok) continue;
      const fx = i * sub + mid;
      const fz = j * sub + mid;
      let d = EDGE_MAX;
      for (const [a, b, dist] of offs) {
        if (dist - fc / 2 >= d) break;
        const x = fx + a;
        const z = fz + b;
        if (x < 0 || z < 0 || x >= fw || z >= fh) continue;
        if (fine[z * fw + x] !== c) {
          d = Math.max(0, dist - fc / 2);
          break;
        }
      }
      out[k] = edgeByte(d);
    }
  }
  return out;
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
      (t.natural === 'water' || t.landuse === 'basin' || t.landuse === 'reservoir' || t.waterway === 'riverbank') && !dryBasin(t),
    cover: COVER.WATER,
  },
];

/**
 * A basin that is dry nearly all the time – a flood detention basin, an
 * infiltration basin, a pond only after rain: mapped as water, it is a
 * meadow (what it is painted over keeps its cover).
 */
export function dryBasin(t: Tags): boolean {
  return /^(detention|infiltration|evaporation)$/.test(t.basin ?? '') || t.intermittent === 'yes' || t.seasonal === 'yes';
}

/** The width (m) a waterway is painted with: its width=…, at least STREAM_MIN (narrower would vanish between the cells); 0: not painted. */
export function waterwayWidth(t: Tags): number {
  const ww = t.waterway;
  const base = ww === 'river' ? 9 : ww === 'stream' ? STREAM_MIN : ww === 'canal' ? 6 : 0;
  if (!base) return 0;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(m)?\s*$/.exec(t.width ?? '');
  const tagged = m ? Number(m[1].replace(',', '.')) : NaN;
  return tagged > 0 && tagged < 80 ? Math.max(STREAM_MIN, tagged) : base;
}

/** the narrowest a stream is painted (m): the renderer draws the cover's edges between the cells' centres, 2 m apart */
const STREAM_MIN = 2.4;

/**
 * Shopping and business areas (landuse=retail | commercial) are often mapped
 * round whole quarters, lawns and planting included.  Of such an area only
 * what lies near its buildings (YARD m), its service roads and the aisles of
 * its car parks is drawn paved; the rest becomes lawn.  (On the fine raster,
 * before finish().)
 */
function greenOpenYards(cover: CoverMap, osm: OsmData): void {
  const fine = cover.fine;
  if (!fine) return;
  const OPEN = 254;
  let any = false;
  for (let k = 0; k < fine.length; k++) {
    if (fine[k] === COVER.COMMERCIAL) {
      fine[k] = OPEN;
      any = true;
    }
  }
  if (!any) return;
  const fc = cover.cell / cover.sub;
  const at = (x: number, z: number): number => {
    const i = Math.floor((x - cover.minX) / fc);
    const j = Math.floor((z - cover.minZ) / fc);
    return i < 0 || j < 0 || i >= cover.fw || j >= cover.fh ? 0 : fine[j * cover.fw + i];
  };
  for (const w of osm.ways) {
    const t = w.tags;
    const c = osm.wayCoords(w);
    if (c.length < 4) continue;
    let near = false;
    for (let i = 0; i < c.length && !near; i += 2) near = at(c[i], c[i + 1]) === OPEN || at(c[i] + YARD, c[i + 1]) === OPEN || at(c[i] - YARD, c[i + 1]) === OPEN || at(c[i], c[i + 1] + YARD) === OPEN || at(c[i], c[i + 1] - YARD) === OPEN;
    if (!near) continue;
    if (t.building && t.building !== 'no' && t.location !== 'underground' && isClosedWay(w)) {
      const ring = c.slice(0, -2);
      cover.paintOver([ring], COVER.COMMERCIAL, OPEN);
      cover.paintBandOver(c, YARD, COVER.COMMERCIAL, OPEN);
    } else if (t.highway === 'service') {
      cover.paintBandOver(c, t.service === 'parking_aisle' ? 8 : 5, COVER.COMMERCIAL, OPEN);
    }
  }
  for (let k = 0; k < fine.length; k++) if (fine[k] === OPEN) fine[k] = COVER.GRASS;
}

/** how far round a building in a shopping or business area the ground is paved (m) */
const YARD = 6;

/** The cover of a paved area by its surface=… (undefined: as its kind says). */
export function surfaceCover(surface: string | undefined): number | undefined {
  if (!surface) return undefined;
  if (/^(asphalt|chipseal)/.test(surface)) return COVER.ASPHALT;
  if (/paving_stones|sett|cobblestone|concrete|bricks?|^paved$|metal|wood/.test(surface)) return COVER.PAVED;
  if (/grass_paver|^grass/.test(surface)) return COVER.GRASS;
  if (/gravel|compacted|pebblestone|unpaved|dirt|ground|earth|sand|mud/.test(surface)) return COVER.BARE;
  return undefined;
}

/** Area of a ring (m²). */
function ringArea(r: number[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += (r[j] - r[i]) * (r[j + 1] + r[i + 1]);
  return Math.abs(a / 2);
}

/**
 * The cover of a small green area that is drawn over whatever paved area it
 * lies in (painted last): grass, beds, scrub and wood under 3000 m².
 */
export function smallGreen(t: Tags, rings: number[][]): number | undefined {
  let c: number | undefined;
  if (t.landuse === 'grass' || t.landuse === 'flowerbed' || t.leisure === 'garden' || t.landuse === 'village_green') c = COVER.GRASS;
  else if (t.natural === 'scrub') c = COVER.SCRUB;
  else if (t.natural === 'wood' || t.landuse === 'forest') c = COVER.FOREST;
  if (c === undefined || rings.length !== 1) return undefined;
  return ringArea(rings[0]) < 3000 ? c : undefined;
}

export function buildCover(
  osm: OsmData,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): CoverMap {
  // (painted three times finer than stored: the edges between the classes come out as smooth lines – finish())
  const cover = new CoverMap(minX, minZ, maxX, maxZ, 2, 3);
  cover.fillAll(COVER.MEADOW);

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
    // (car parks, yards and squares in the surface they are mapped with)
    const surfaced = layer.cover === COVER.ASPHALT || layer.cover === COVER.PAVED;
    for (const p of polys) {
      if (!layer.match(p.tags)) continue;
      cover.paint(p.rings, surfaced ? (surfaceCover(p.tags.surface) ?? layer.cover) : layer.cover);
      if (layer.built) cover.paintBuilt(p.rings);
    }
  }
  // (the open ground of shopping and business areas: lawn, not yard)
  greenOpenYards(cover, osm);
  // small green areas (an island in a car park, a bed in a yard) over the paved ones round them
  for (const p of polys) {
    const g = smallGreen(p.tags, p.rings);
    if (g !== undefined) cover.paint(p.rings, g);
  }

  // Linear water features
  for (const w of osm.ways) {
    if (!w.tags.waterway || (w.tags.tunnel && w.tags.tunnel !== 'no')) continue;
    const width = waterwayWidth(w.tags);
    if (width > 0) cover.paintLine(osm.wayCoords(w), width, COVER.WATER);
  }

  cover.finish();
  cover.dilateBuilt(3);
  return cover;
}

/**
 * The ground cover of a block with a detail region in it (mapgen/detailregion.ts):
 * `fresh` (buildCover) in the tiles `freshTile` says yes to, the published
 * map's (`legacy`: tools/mapgen/legacy/cover.ts, the same raster) everywhere
 * else – the cover, the built-up mask, and what is painted into it later.
 * Without a fresh tile: a plain raster with the published cover.
 */
export function mergeLegacyCover(
  legacy: { data: Uint8Array; built: Uint8Array; w: number; h: number; bw: number; bh: number },
  fresh: CoverMap | null,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  freshAt: (x: number, z: number) => boolean,
): CoverMap {
  if (!fresh) {
    const out = new CoverMap(minX, minZ, maxX, maxZ, 2, 1);
    if (out.w !== legacy.w || out.h !== legacy.h || out.bw !== legacy.bw || out.bh !== legacy.bh) throw new Error('cover rasters differ in size');
    out.data.set(legacy.data);
    out.built.set(legacy.built);
    return out;
  }
  if (fresh.w !== legacy.w || fresh.h !== legacy.h || fresh.bw !== legacy.bw || fresh.bh !== legacy.bh) throw new Error('cover rasters differ in size');
  const mask = new Uint8Array(fresh.w * fresh.h);
  for (let j = 0; j < fresh.h; j++) {
    const z = minZ + (j + 0.5) * fresh.cell;
    for (let i = 0; i < fresh.w; i++) {
      const k = j * fresh.w + i;
      if (freshAt(minX + (i + 0.5) * fresh.cell, z)) continue;
      mask[k] = 1;
      fresh.data[k] = legacy.data[k];
    }
  }
  for (let j = 0; j < fresh.bh; j++) {
    const z = minZ + (j + 0.5) * fresh.bCell;
    for (let i = 0; i < fresh.bw; i++) if (!freshAt(minX + (i + 0.5) * fresh.bCell, z)) fresh.built[j * fresh.bw + i] = legacy.built[j * fresh.bw + i];
  }
  fresh.legacyCells = mask;
  return fresh;
}
