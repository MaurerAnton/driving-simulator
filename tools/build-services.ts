// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The fuel stations and car washes of the map: services.json.gz.
 *
 *   node --max-old-space-size=1536 tools/build-services.ts [path/to/hessen-latest.osm.pbf]
 *
 * From OpenStreetMap (© OpenStreetMap contributors, ODbL 1.0): every fuel
 * station (amenity=fuel) and car wash (amenity=car_wash) of the map's region
 * – as a point, an area or a multipolygon – with its name, brand and the
 * fuels it sells (fuel:*=yes), and the roofs drawn over pumps
 * (building=roof, man_made=canopy).  A station drawn twice – a point with
 * the name inside an area without one – is one station.
 *
 * From the official building models (LoD2, Hessische Verwaltung für
 * Bodenmanagement und Geoinformation – the squares of data/work/lod2 that
 * the map was built from, or LOD2_DIR): the canopy of each station (a
 * building of the function "Überdachung") and the hall of each car wash,
 * with their real outline and height.  The map draws such a canopy as a
 * solid block; the game takes the block away and builds an open canopy with
 * pumps in its place (src/world/services.ts).  Without building models the
 * roofs of OpenStreetMap serve, and where there are none either, a canopy
 * of 14 × 12.5 m is laid out on free ground of the station.
 *
 * Needs the map (MAP_OUT, default public/map): map.json for its region and
 * build, net.bin.gz for the roads (the price sign stands at the road).
 * Reads the PBF in two passes (three for stations drawn as multipolygons).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { latLonToWorld } from '../src/geo/utm.ts';
import { GRID_OFFSET, GridSet, TILE, gridIndex } from '../src/world/grid.ts';
import { POLY_UNIT, unpackNet } from '../src/world/netfile.ts';
import type { NetData } from '../src/world/netfile.ts';
import { SERVICES_VERSION, fuelsOf, inRing, minRect, rectRing, ringAreaAbs, ringDistance } from '../src/world/services.ts';
import type { Rect, RoofJson, ServiceSiteJson, ServicesJson } from '../src/world/services.ts';
import type { MapIndexJson } from '../src/world/types.ts';
import { readPbf } from './osm/pbf.ts';
import type { Tags } from './osm/pbf.ts';

// ------------------------------------------------------------------ what OpenStreetMap says

/** A fuel station or car wash as OpenStreetMap has it. */
export interface OsmSite {
  osm: string;
  kind: 'fuel' | 'wash';
  tags: Tags;
  /** a point: where it is; an area: its outline (x, z pairs) */
  x: number;
  z: number;
  area: number[] | null;
}

/** A roof of OpenStreetMap (building=roof …): its outline and, if tagged, its height. */
export interface OsmRoof {
  ring: number[];
  height: number | null;
}

/** What kind of site a thing of OpenStreetMap is – null if none the game uses (private, or fuel for aircraft and boats only). */
export function siteKind(t: Tags): 'fuel' | 'wash' | null {
  const a = t.amenity;
  if (a !== 'fuel' && a !== 'car_wash') return null;
  if (t.access === 'private' || t.access === 'no' || t.disused === 'yes') return null;
  if (a === 'fuel') {
    const yes = (k: string): boolean => t[k] === 'yes';
    // (an airfield's or a harbour's pump)
    if ((yes('fuel:avgas') || yes('fuel:jeta1') || yes('fuel:JetA1') || t.boat === 'yes' || t.aeroway) && fuelsOf(t).length === 0) return null;
    return 'fuel';
  }
  return 'wash';
}

/** Is this a roof of OpenStreetMap that may stand over pumps? */
export function isRoof(t: Tags): boolean {
  return t.building === 'roof' || t['building:part'] === 'roof' || t.man_made === 'canopy';
}

/** The name a site is shown with: its name, else its brand, else its operator. */
export function siteNames(t: Tags): { name: string; brand: string } {
  const brand = (t.brand ?? t.operator ?? '').trim();
  const name = (t.name ?? t['name:de'] ?? '').trim() || brand;
  return { name, brand };
}

/** A height tag in metres ("4.5", "4,5 m") – null if there is none to read. */
export function metres(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number.parseFloat(v.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Join ways into closed rings (x, z pairs): ways that share their ends are
 * put together, turned as needed.  What does not close is left out.
 */
export function joinRings(ways: number[][], pos: (node: number) => [number, number] | undefined): number[][] {
  const left = ways.filter((w) => w.length >= 2).map((w) => [...w]);
  const out: number[][] = [];
  while (left.length > 0) {
    let ring = left.shift() as number[];
    let grown = true;
    while (ring[0] !== ring[ring.length - 1] && grown) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const w = left[i];
        const end = ring[ring.length - 1];
        if (w[0] === end) ring = [...ring, ...w.slice(1)];
        else if (w[w.length - 1] === end) ring = [...ring, ...w.slice(0, -1).reverse()];
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length < 4 || ring[0] !== ring[ring.length - 1]) continue;
    const pts: number[] = [];
    let ok = true;
    for (let i = 0; i < ring.length - 1; i++) {
      const p = pos(ring[i]);
      if (!p) {
        ok = false;
        break;
      }
      pts.push(p[0], p[1]);
    }
    if (ok) out.push(pts);
  }
  return out;
}

/** What the passes over the PBF found. */
export interface OsmServices {
  sites: OsmSite[];
  roofs: OsmRoof[];
}

/**
 * Read the sites and roofs from the PBF.  Pass 1: the sites drawn as points
 * (with their places), the ways of sites and roofs, the multipolygons of
 * sites; pass 2: the places of the ways' nodes, and the ways of the
 * multipolygons; pass 3 (only for those): their nodes.
 */
export function readOsm(input: string, lap: (msg: string) => void = () => {}): OsmServices {
  const sites: OsmSite[] = [];
  const siteWays: Array<{ id: number; refs: number[]; tags: Tags; kind: 'fuel' | 'wash' }> = [];
  const roofWays: Array<{ refs: number[]; height: number | null }> = [];
  const rels: Array<{ id: number; outer: number[]; tags: Tags; kind: 'fuel' | 'wash' }> = [];
  readPbf(input, {
    node(id, lat, lon, tags) {
      const t = tags();
      if (!t) return;
      const kind = siteKind(t);
      if (!kind) return;
      const [x, z] = latLonToWorld(lat, lon);
      sites.push({ osm: `n${id}`, kind, tags: t, x, z, area: null });
    },
    way(id, refs, tags) {
      if (refs.length < 4 || refs[0] !== refs[refs.length - 1]) return;
      const t = tags();
      const kind = siteKind(t);
      if (kind) siteWays.push({ id, refs, tags: t, kind });
      else if (isRoof(t)) roofWays.push({ refs, height: metres(t.height) });
    },
    relation(id, members, tags) {
      const t = tags();
      if (t.type !== 'multipolygon') return;
      const kind = siteKind(t);
      if (!kind) return;
      rels.push({ id, outer: members().filter((m) => m.type === 'w' && m.role !== 'inner').map((m) => m.ref), tags: t, kind });
    },
  });
  lap(`pass 1: ${sites.length} sites drawn as points, ${siteWays.length} as areas, ${rels.length} as multipolygons; ${roofWays.length} roofs`);

  const wantNodes = new Set<number>();
  for (const w of siteWays) for (const r of w.refs) wantNodes.add(r);
  for (const w of roofWays) for (const r of w.refs) wantNodes.add(r);
  const wantWays = new Set<number>();
  for (const r of rels) for (const w of r.outer) wantWays.add(w);
  const pos = new Map<number, [number, number]>();
  const relWays = new Map<number, number[]>();
  readPbf(input, {
    node(id, lat, lon) {
      if (wantNodes.has(id)) pos.set(id, latLonToWorld(lat, lon));
    },
    way: wantWays.size
      ? (id, refs) => {
          if (wantWays.has(id)) relWays.set(id, refs);
        }
      : undefined,
  });
  if (relWays.size > 0) {
    const more = new Set<number>();
    for (const refs of relWays.values()) for (const r of refs) if (!pos.has(r)) more.add(r);
    readPbf(input, {
      node(id, lat, lon) {
        if (more.has(id)) pos.set(id, latLonToWorld(lat, lon));
      },
    });
  }
  const ring = (refs: number[]): number[] | null => {
    const out: number[] = [];
    for (let i = 0; i < refs.length - 1; i++) {
      const p = pos.get(refs[i]);
      if (!p) return null;
      out.push(p[0], p[1]);
    }
    return out;
  };
  for (const w of siteWays) {
    const r = ring(w.refs);
    if (!r) continue;
    const c = centroid(r);
    sites.push({ osm: `w${w.id}`, kind: w.kind, tags: w.tags, x: c[0], z: c[1], area: r });
  }
  for (const rel of rels) {
    const rings = joinRings(
      rel.outer.map((w) => relWays.get(w) ?? []),
      (n) => pos.get(n),
    );
    if (rings.length === 0) continue;
    // (the largest outer ring stands for the site)
    rings.sort((a, b) => ringAreaAbs(b) - ringAreaAbs(a));
    const c = centroid(rings[0]);
    sites.push({ osm: `r${rel.id}`, kind: rel.kind, tags: rel.tags, x: c[0], z: c[1], area: rings[0] });
  }
  const roofs: OsmRoof[] = [];
  for (const w of roofWays) {
    const r = ring(w.refs);
    if (r) roofs.push({ ring: r, height: w.height });
  }
  lap(`pass 2${relWays.size ? ' and 3' : ''}: ${sites.length} sites with their places, ${roofs.length} roofs`);
  return { sites, roofs };
}

/** The middle of a ring (the mean of its corners: good enough for the small, plain outlines here). */
export function centroid(ring: ArrayLike<number>): [number, number] {
  let x = 0;
  let z = 0;
  const n = ring.length / 2;
  for (let i = 0; i < ring.length; i += 2) {
    x += ring[i];
    z += ring[i + 1];
  }
  return n > 0 ? [x / n, z / n] : [0, 0];
}

/**
 * A station drawn twice is one: a point within (or 25 m of) an area of the
 * same kind gives it its tags where the area has none (its name, brand and
 * fuels) and goes.
 */
export function mergeTwins(sites: OsmSite[]): OsmSite[] {
  const areas = sites.filter((s) => s.area);
  const out: OsmSite[] = [];
  for (const s of sites) {
    if (s.area) continue;
    const host = areas.find((a) => a.kind === s.kind && (inRing(s.x, s.z, a.area!) || ringDistance(s.x, s.z, a.area!) < 25));
    if (!host) {
      out.push(s);
      continue;
    }
    for (const [k, v] of Object.entries(s.tags)) if (host.tags[k] === undefined) host.tags[k] = v;
  }
  return [...areas, ...out];
}

// ------------------------------------------------------------------ the building models

/** A building of the models, as far as the matching needs it: its outline, ground and top, and whether it is a canopy. */
export interface Lod2Building {
  ring: number[];
  y0: number;
  y1: number;
  canopy: boolean;
  area: number;
}

/** The building models within the boxes asked for (the squares of 2 km they were sorted into), each building once. */
function readLod2(dir: string, boxes: Array<[number, number, number, number]>): Lod2Building[] {
  if (!existsSync(dir)) return [];
  const BIN = 2000;
  const bins = new Set<string>();
  for (const [x0, z0, x1, z1] of boxes) {
    for (let bx = Math.floor((x0 + GRID_OFFSET) / BIN); bx <= Math.floor((x1 + GRID_OFFSET) / BIN); bx++) {
      for (let bz = Math.floor((z0 + GRID_OFFSET) / BIN); bz <= Math.floor((z1 + GRID_OFFSET) / BIN); bz++) bins.add(`${bx}_${bz}`);
    }
  }
  const dirs = readdirSync(dir).filter((d) => !d.startsWith('.'));
  const seen = new Set<string>();
  const out: Lod2Building[] = [];
  for (const bin of bins) {
    for (const d of dirs) {
      const file = join(dir, d, `${bin}.ndjson.gz`);
      if (!existsSync(file)) continue;
      for (const line of gunzipSync(readFileSync(file)).toString('utf8').split('\n')) {
        if (!line.startsWith('{')) continue;
        const u = JSON.parse(line) as { id: string; fn: string; polys: number[][] };
        if (seen.has(u.id) || u.fn.startsWith('53001')) continue;
        seen.add(u.id);
        let foot: number[] | null = null;
        let y0 = Infinity;
        let y1 = -Infinity;
        for (const p of u.polys) {
          for (let i = 2; i < p.length; i += 3) {
            y0 = Math.min(y0, p[i]);
            y1 = Math.max(y1, p[i]);
          }
          if (p[0] === 2) {
            const r: number[] = [];
            for (let i = 1; i + 2 < p.length; i += 3) r.push(p[i], p[i + 2]);
            if (!foot || ringAreaAbs(r) > ringAreaAbs(foot)) foot = r;
          }
        }
        if (!foot || foot.length < 6 || !Number.isFinite(y0)) continue;
        // (a closing corner that repeats the first)
        if (foot[0] === foot[foot.length - 2] && foot[1] === foot[foot.length - 1]) foot.length -= 2;
        out.push({ ring: foot, y0, y1, canopy: u.fn === '51009_1610', area: ringAreaAbs(foot) });
      }
    }
  }
  return out;
}

/** The buildings by squares of 50 m, to find those near a point quickly. */
export class BuildingGrid {
  private readonly cells = new Map<number, Lod2Building[]>();
  readonly all: readonly Lod2Building[];

  constructor(list: readonly Lod2Building[]) {
    this.all = list;
    for (const b of list) {
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (let i = 0; i < b.ring.length; i += 2) {
        x0 = Math.min(x0, b.ring[i]);
        x1 = Math.max(x1, b.ring[i]);
        z0 = Math.min(z0, b.ring[i + 1]);
        z1 = Math.max(z1, b.ring[i + 1]);
      }
      for (let i = Math.floor(x0 / 50); i <= Math.floor(x1 / 50); i++) {
        for (let j = Math.floor(z0 / 50); j <= Math.floor(z1 / 50); j++) {
          const k = (i + 32768) * 65536 + j + 32768;
          const cell = this.cells.get(k);
          if (cell) cell.push(b);
          else this.cells.set(k, [b]);
        }
      }
    }
  }

  /** The buildings that reach into the square of ±r round a point. */
  near(x: number, z: number, r: number): Lod2Building[] {
    const out = new Set<Lod2Building>();
    for (let i = Math.floor((x - r) / 50); i <= Math.floor((x + r) / 50); i++) {
      for (let j = Math.floor((z - r) / 50); j <= Math.floor((z + r) / 50); j++) for (const b of this.cells.get((i + 32768) * 65536 + j + 32768) ?? []) out.add(b);
    }
    return [...out];
  }
}

// ------------------------------------------------------------------ matching

/** Do two rings overlap (a corner of one in the other, or the middle of one in the other)? Good enough for buildings against a rectangle. */
export function ringsOverlap(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i += 2) if (inRing(a[i], a[i + 1], b)) return true;
  for (let i = 0; i < b.length; i += 2) if (inRing(b[i], b[i + 1], a)) return true;
  const ca = centroid(a);
  const cb = centroid(b);
  return inRing(ca[0], ca[1], b) || inRing(cb[0], cb[1], a);
}

/** Is the middle of a ring on a site: in its area grown by `pad`, or within `reach` of its point? */
function nearSite(s: OsmSite, ring: number[], pad: number, reach: number): boolean {
  const [cx, cz] = centroid(ring);
  if (s.area) return inRing(cx, cz, s.area) || ringDistance(cx, cz, s.area) < pad;
  return Math.hypot(cx - s.x, cz - s.z) < reach || inRing(s.x, s.z, ring);
}

/**
 * The canopies of a fuel station: of the building models the canopies on
 * it (at most two, the largest first, 40 m² at least) – else the roofs of
 * OpenStreetMap on it.  Empty if neither has one.
 */
export function stationRoofs(s: OsmSite, lod2: readonly Lod2Building[], osmRoofs: readonly OsmRoof[]): RoofJson[] {
  const plausible = (ring: number[]): boolean => {
    const r = minRect(ring);
    return r.wid >= 4 && r.len >= 6 && r.len <= 90 && ringAreaAbs(ring) >= 40;
  };
  const fromModels = lod2
    .filter((b) => b.canopy && plausible(b.ring) && nearSite(s, b.ring, 8, 40))
    .sort((a, b) => b.area - a.area)
    .slice(0, 2)
    .filter((b, i, all) => i === 0 || b.area > 0.3 * all[0].area);
  if (fromModels.length > 0) return fromModels.map((b) => ({ ring: round(b.ring), y0: r2(b.y0), y1: r2(b.y1), src: 'lod2' }));
  const fromOsm = osmRoofs
    .filter((r) => plausible(r.ring) && nearSite(s, r.ring, 8, 40))
    .sort((a, b) => ringAreaAbs(b.ring) - ringAreaAbs(a.ring))
    .slice(0, 2);
  return fromOsm.map((r) => {
    // the building models draw the canopy, too – as a building of another function: its block is the one to take away
    const block = modelOf(r.ring, lod2);
    if (block) return { ring: round(block.ring), y0: r2(block.y0), y1: r2(block.y1), src: 'lod2' };
    const out: RoofJson = { ring: round(r.ring), y0: null, y1: null, src: 'osm' };
    if (r.height) out.h = r2(r.height);
    return out;
  });
}

/**
 * The building of the models that stands for a roof of OpenStreetMap: the
 * one that overlaps it most (its middle in the roof, or the roof's middle
 * in it, sharing at least half the smaller area's box) and is no higher
 * than a canopy (10 m) – null if there is none.
 */
export function modelOf(ring: number[], lod2: readonly Lod2Building[]): Lod2Building | null {
  const box = (r: number[]): [number, number, number, number] => {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) {
      x0 = Math.min(x0, r[i]);
      x1 = Math.max(x1, r[i]);
      z0 = Math.min(z0, r[i + 1]);
      z1 = Math.max(z1, r[i + 1]);
    }
    return [x0, z0, x1, z1];
  };
  const a = box(ring);
  const [cx, cz] = centroid(ring);
  let best: Lod2Building | null = null;
  let bestShare = 0.5;
  for (const b of lod2) {
    if (b.y1 - b.y0 > 10 || b.y1 - b.y0 < 2.2) continue;
    const [bx, bz] = centroid(b.ring);
    if (!inRing(bx, bz, ring) && !inRing(cx, cz, b.ring)) continue;
    const c = box(b.ring);
    const w = Math.min(a[2], c[2]) - Math.max(a[0], c[0]);
    const h = Math.min(a[3], c[3]) - Math.max(a[1], c[1]);
    if (w <= 0 || h <= 0) continue;
    const share = (w * h) / Math.min((a[2] - a[0]) * (a[3] - a[1]), (c[2] - c[0]) * (c[3] - c[1]));
    if (share > bestShare) {
      bestShare = share;
      best = b;
    }
  }
  return best;
}

/**
 * The hall of a car wash: the building of the models the wash's point lies
 * in (or, for an area, that lies in the area), or the nearest within 12 m –
 * if it is shaped like a wash hall (3.6 to 12 m wide, 7.5 to 45 m long).
 */
export function washHall(s: OsmSite, lod2: readonly Lod2Building[]): RoofJson | null {
  let best: Lod2Building | null = null;
  let bestD = Infinity;
  for (const b of lod2) {
    let d: number;
    if (s.area) {
      const [cx, cz] = centroid(b.ring);
      d = inRing(cx, cz, s.area) ? 0 : inRing(s.x, s.z, b.ring) ? 0 : Infinity;
    } else d = inRing(s.x, s.z, b.ring) ? 0 : ringDistance(s.x, s.z, b.ring);
    if (d > 12 || d >= bestD) continue;
    const r = minRect(b.ring);
    if (r.wid < 3.6 || r.wid > 12 || r.len < 7.5 || r.len > 45) {
      // (the point lies in a building that is no wash hall: a garage, a dealer's workshop – nothing to build there)
      if (d === 0 && !s.area) return null;
      continue;
    }
    best = b;
    bestD = d;
  }
  if (!best) return null;
  return { ring: round(best.ring), y0: r2(best.y0), y1: r2(best.y1), src: 'lod2', ...(best.canopy ? { open: 1 as const } : {}) };
}

/**
 * Lay out a rectangle of `len` × `wid` on free ground of a site: in its area
 * (or round its point), not over a building of the models, turned along
 * `axis` – the spot nearest the site's middle that fits.  Null if none does.
 */
export function freeRect(s: OsmSite, len: number, wid: number, axis: [number, number], buildings: readonly Lod2Building[]): Rect | null {
  const cands: Array<[number, number]> = [];
  const [cx, cz] = s.area ? centroid(s.area) : [s.x, s.z];
  for (let r = 0; r <= 30; r += 3) {
    const steps = r === 0 ? 1 : Math.round((2 * Math.PI * r) / 3);
    for (let k = 0; k < steps; k++) cands.push([cx + r * Math.cos((k / steps) * 2 * Math.PI), cz + r * Math.sin((k / steps) * 2 * Math.PI)]);
  }
  const near = buildings.filter((b) => {
    const [bx, bz] = centroid(b.ring);
    return Math.hypot(bx - cx, bz - cz) < 120;
  });
  for (const [x, z] of cands) {
    const rect: Rect = { cx: x, cz: z, ux: axis[0], uz: axis[1], len, wid };
    const ring = rectRing(rect, 0.5);
    if (s.area) {
      // (inside the site's area, give or take a metre)
      let inside = true;
      for (let i = 0; i < ring.length; i += 2) if (!inRing(ring[i], ring[i + 1], s.area) && ringDistance(ring[i], ring[i + 1], s.area) > 1.5) inside = false;
      if (!inside) continue;
    }
    if (near.some((b) => ringsOverlap(ring, b.ring))) continue;
    return rect;
  }
  return null;
}

// ------------------------------------------------------------------ the roads: where the price sign stands

/** The roads of net.bin.gz as polylines in a coarse grid, to find the nearest. */
export class RoadFinder {
  private readonly grid = new Map<number, number[]>();
  private readonly lines: Float32Array[] = [];

  constructor(net: NetData) {
    const E = net.edgeA.length;
    for (let e = 0; e < E; e++) {
      const pts: number[] = [net.nodeX[net.edgeA[e]], net.nodeZ[net.edgeA[e]]];
      let x = pts[0];
      let z = pts[1];
      for (let k = net.polyFirst[e]; k < net.polyFirst[e + 1]; k++) {
        x += net.poly[k * 2] * POLY_UNIT;
        z += net.poly[k * 2 + 1] * POLY_UNIT;
        pts.push(x, z);
      }
      pts.push(net.nodeX[net.edgeB[e]], net.nodeZ[net.edgeB[e]]);
      const line = Float32Array.from(pts);
      const idx = this.lines.length;
      this.lines.push(line);
      const cells = new Set<number>();
      for (let i = 0; i < line.length; i += 2) cells.add(RoadFinder.key(line[i], line[i + 1]));
      for (const c of cells) {
        const list = this.grid.get(c);
        if (list) list.push(idx);
        else this.grid.set(c, [idx]);
      }
    }
  }

  private static key(x: number, z: number): number {
    return (Math.floor(x / 100) + 32768) * 65536 + Math.floor(z / 100) + 32768;
  }

  /** The point of a road nearest to (x, z) within `reach`, and the road's direction there – null if none is that near. */
  nearest(x: number, z: number, reach: number): { x: number; z: number; dx: number; dz: number; d: number } | null {
    let best: { x: number; z: number; dx: number; dz: number; d: number } | null = null;
    const seen = new Set<number>();
    for (let i = Math.floor((x - reach) / 100) - 1; i <= Math.floor((x + reach) / 100) + 1; i++) {
      for (let j = Math.floor((z - reach) / 100) - 1; j <= Math.floor((z + reach) / 100) + 1; j++) {
        for (const idx of this.grid.get((i + 32768) * 65536 + j + 32768) ?? []) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          const l = this.lines[idx];
          for (let k = 0; k + 3 < l.length; k += 2) {
            const ax = l[k];
            const az = l[k + 1];
            const dx = l[k + 2] - ax;
            const dz = l[k + 3] - az;
            const l2 = dx * dx + dz * dz;
            if (l2 < 1e-6) continue;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
            const px = ax + dx * t;
            const pz = az + dz * t;
            const d = Math.hypot(px - x, pz - z);
            if (d <= reach && (!best || d < best.d)) {
              const len = Math.sqrt(l2);
              best = { x: px, z: pz, dx: dx / len, dz: dz / len, d };
            }
          }
        }
      }
    }
    return best;
  }
}

/**
 * Where the price sign of a station stands: between the station and the
 * road nearest to it, 6.5 m from the road's middle, turned across the road
 * (its two faces look along it, to the drivers of both directions) – moved
 * along the road where that spot lies in a building or under a canopy.
 */
export function signSpot(s: OsmSite, roads: RoadFinder, blocked: (x: number, z: number) => boolean): [number, number, number] | null {
  const road = roads.nearest(s.x, s.z, 70);
  if (!road) return null;
  // (from the road towards the station)
  let nx = s.x - road.x;
  let nz = s.z - road.z;
  const nl = Math.hypot(nx, nz);
  if (nl < 1e-3) {
    nx = -road.dz;
    nz = road.dx;
  } else {
    nx /= nl;
    nz /= nl;
  }
  const off = Math.min(6.5, Math.max(4, nl * 0.8));
  for (const shift of [0, 4, -4, 8, -8, 12, -12]) {
    const x = road.x + nx * off + road.dx * shift;
    const z = road.z + nz * off + road.dz * shift;
    if (blocked(x, z)) continue;
    return [r1(x), r1(z), r2(Math.atan2(-road.dx, -road.dz))];
  }
  return null;
}

// ------------------------------------------------------------------ the build

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const round = (ring: number[]): number[] => ring.map(r1);

/** The canopy laid out where neither the models nor OpenStreetMap have one (m). */
const GEN_CANOPY = { len: 14, wid: 12.5 };
/** … and the bay of a car wash in the open. */
const GEN_BAY = { len: 11, wid: 5 };

/** Make the sites of the file from what OpenStreetMap and the models say. */
export function buildSites(osm: OsmServices, buildings: BuildingGrid, roads: RoadFinder | null, inMap: (x: number, z: number) => boolean, lap: (msg: string) => void = () => {}): ServiceSiteJson[] {
  const sites = mergeTwins(osm.sites.filter((s) => inMap(s.x, s.z)));
  const count = { fuel: 0, wash: 0, lod2: 0, osm: 0, gen: 0, none: 0, hall: 0, open: 0, bay: 0, noBay: 0, sign: 0 };
  const out: ServiceSiteJson[] = [];
  for (const s of sites) {
    // (the buildings round the site: its area and 120 m beyond)
    let reach = 0;
    for (let i = 0; s.area && i < s.area.length; i += 2) reach = Math.max(reach, Math.hypot(s.area[i] - s.x, s.area[i + 1] - s.z));
    const lod2 = buildings.near(s.x, s.z, reach + 120);
    const { name, brand } = siteNames(s.tags);
    const site: ServiceSiteJson = { k: s.kind, osm: s.osm, name, brand, x: r1(s.x), z: r1(s.z) };
    if (s.area) site.area = round(s.area);
    // (the axis to lay things out along: the road's, else the area's long side)
    const road = roads?.nearest(s.x, s.z, 70) ?? null;
    const areaRect = s.area ? minRect(s.area) : null;
    const axis: [number, number] = road ? [road.dx, road.dz] : areaRect ? [areaRect.ux, areaRect.uz] : [1, 0];
    if (s.kind === 'fuel') {
      count.fuel++;
      const fuels = fuelsOf(s.tags);
      if (fuels.length) site.fuels = fuels;
      if (s.tags.hgv === 'yes' || fuels.includes('hgv')) site.hgv = 1;
      let roofs = stationRoofs(s, lod2, osm.roofs);
      if (roofs.length === 0) {
        const rect = freeRect(s, GEN_CANOPY.len, GEN_CANOPY.wid, axis, lod2);
        if (rect) roofs = [{ ring: round(rectRing(rect)), y0: null, y1: null, src: 'gen' }];
      }
      if (roofs.length) {
        site.roofs = roofs;
        count[roofs[0].src]++;
      } else count.none++;
      if (roads) {
        const sign = signSpot(s, roads, (x, z) => buildings.near(x, z, 3).some((b) => inRing(x, z, b.ring) || ringDistance(x, z, b.ring) < 1.2) || roofs.some((r) => inRing(x, z, r.ring) || ringDistance(x, z, r.ring) < 1.5));
        if (sign) {
          site.sign = sign;
          count.sign++;
        }
      }
    } else {
      count.wash++;
      if (s.tags.automated === 'yes') site.auto = 1;
      if (s.tags.self_service === 'yes') site.self = 1;
      const hall = washHall(s, lod2);
      if (hall) {
        site.roofs = [hall];
        if (hall.open) count.open++;
        else count.hall++;
      } else {
        // a bay in the open: along the area's long side (or the road), on free ground
        const ax: [number, number] = areaRect && areaRect.len > areaRect.wid * 1.2 ? [areaRect.ux, areaRect.uz] : axis;
        const rect = freeRect(s, GEN_BAY.len, GEN_BAY.wid, ax, lod2);
        if (rect) {
          site.roofs = [{ ring: round(rectRing(rect)), y0: null, y1: null, src: 'gen' }];
          count.bay++;
        } else count.noBay++;
      }
    }
    out.push(site);
  }
  lap(
    `${count.fuel} fuel stations (canopies: ${count.lod2} from the building models, ${count.osm} from OpenStreetMap, ${count.gen} laid out, ${count.none} without room; ${count.sign} price signs), ` +
      `${count.wash} car washes (${count.hall} in a hall, ${count.open} under a roof, ${count.bay} in the open, ${count.noBay} without room)`,
  );
  return out;
}

/** The boxes round the sites (grown by 60 m), for reading the building models. */
function boxesOf(sites: readonly OsmSite[]): Array<[number, number, number, number]> {
  return sites.map((s) => {
    let x0 = s.x;
    let z0 = s.z;
    let x1 = s.x;
    let z1 = s.z;
    for (let i = 0; s.area && i < s.area.length; i += 2) {
      x0 = Math.min(x0, s.area[i]);
      x1 = Math.max(x1, s.area[i]);
      z0 = Math.min(z0, s.area[i + 1]);
      z1 = Math.max(z1, s.area[i + 1]);
    }
    return [x0 - 60, z0 - 60, x1 + 60, z1 + 60];
  });
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const input = resolve(root, process.argv[2] ?? 'data/raw/osm/hessen-latest.osm.pbf');
  const mapDir = resolve(root, process.env.MAP_OUT ?? 'public/map');
  const lod2Dir = resolve(root, process.env.LOD2_DIR ?? 'data/work/lod2');
  const t0 = Date.now();
  const lap = (msg: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);
  const index = JSON.parse(readFileSync(resolve(mapDir, 'map.json'), 'utf8')) as MapIndexJson;
  const tiles = GridSet.from(index.tiles);
  const inMap = (x: number, z: number): boolean => tiles.has(gridIndex(x, TILE), gridIndex(z, TILE));
  let roads: RoadFinder | null = null;
  if (existsSync(resolve(mapDir, 'net.bin.gz'))) {
    const buf = gunzipSync(readFileSync(resolve(mapDir, 'net.bin.gz')));
    roads = new RoadFinder(unpackNet(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
    lap('road network read');
  }
  const osm = readOsm(input, lap);
  const inside = osm.sites.filter((s) => inMap(s.x, s.z));
  const lod2 = readLod2(lod2Dir, boxesOf(inside));
  lap(`${inside.length} sites in the map's region; ${lod2.length} buildings of the models round them (${lod2.filter((b) => b.canopy).length} canopies)${existsSync(lod2Dir) ? '' : ' – no building models found'}`);
  const sites = buildSites(osm, new BuildingGrid(lod2), roads, inMap, lap);
  const attribution = ['Tankstellen und Waschanlagen: © OpenStreetMap-Mitwirkende (ODbL 1.0)'];
  if (lod2.length) attribution.push('Dächer der Tankstellen und Waschhallen: Hessische Verwaltung für Bodenmanagement und Geoinformation (LoD2, offene Geobasisdaten)');
  const out: ServicesJson = { v: SERVICES_VERSION, map: index.meta.generated, attribution, sites };
  const bytes = gzipSync(JSON.stringify(out), { level: 9 });
  writeFileSync(resolve(mapDir, 'services.json.gz'), bytes);
  lap(`services.json.gz: ${sites.length} sites – ${(bytes.length / 1024).toFixed(0)} KB in ${mapDir}`);
}
