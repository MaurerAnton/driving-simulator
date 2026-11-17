// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The fuel stations and car washes of the map (services.json.gz, made by
 * tools/build-services.ts from OpenStreetMap and the official building
 * models) – and how each is laid out in the game.
 *
 * A fuel station of the file is a place with a name and a brand, the fuels
 * it sells, its area as drawn in OpenStreetMap, the roofs over its pumps
 * and the place of its price sign.  The roofs are those of the building
 * models where there are any: a canopy there is a solid block from the
 * ground to its roof, so the game takes that block away (the walls, the
 * roof, its outline in the collisions) and builds an open canopy of the same
 * outline and height in its place, with pump islands under it.  A car wash
 * has its hall (or none: then it stands in the open) with a gantry that
 * travels over the car.
 *
 * Everything here is plain geometry, without three.js: the build tool, the
 * game, the renderer (render/services.ts) and the tests share it.  The
 * frame is the world's (x east, z south, metres); along a site's roof the
 * long side is u and the short side v.
 */

import { fuelPrices } from './fuelprices.ts';

/** The newest version of services.json.gz this reads. */
export const SERVICES_VERSION = 1;

/** A roof that is taken over by the game: the canopy over the pumps, or a car wash's hall. */
export interface RoofJson {
  /** its outline: x, z pairs (the ring is closed implicitly) */
  ring: number[];
  /** the ground under it and its top, metres above sea level – null where not known (a roof drawn in OpenStreetMap only, or made up by the build) */
  y0: number | null;
  y1: number | null;
  /** where it comes from: the building models ('lod2'), OpenStreetMap ('osm'), or laid out by the build where neither has one ('gen') */
  src: 'lod2' | 'osm' | 'gen';
  /** its height over the ground where OpenStreetMap tags it (and the models have none) */
  h?: number;
  /** a roof without walls (a car wash under a canopy): no walls are built under it */
  open?: 1;
}

/** A fuel station or a car wash of the file. */
export interface ServiceSiteJson {
  k: 'fuel' | 'wash';
  /** its object in OpenStreetMap: n123, w123 or r123 */
  osm: string;
  name: string;
  brand: string;
  /** its middle (world x, z) */
  x: number;
  z: number;
  /** its area as OpenStreetMap draws it (x, z pairs), where it is drawn as one */
  area?: number[];
  /** the fuels it sells (FUELS); none: what nearly every station sells */
  fuels?: string[];
  /** the canopies over the pumps (a fuel station), the hall (a car wash) */
  roofs?: RoofJson[];
  /** the price sign: x, z and the way it faces (yaw: 0 north, + to the left) */
  sign?: [number, number, number];
  /** a car wash: it washes by itself (a gantry), or one washes oneself */
  auto?: 1;
  self?: 1;
  /** a fuel station with pumps for lorries */
  hgv?: 1;
}

export interface ServicesJson {
  v: number;
  /** the build of the map it was made for (map.json meta.generated) */
  map: string;
  attribution: string[];
  sites: ServiceSiteJson[];
}

// ------------------------------------------------------------------ fuels

/**
 * The fuels: their code in the file, what the pump calls them (the German
 * names, as on every pump in the country) and whether a diesel engine takes
 * it.  `price`: what a litre (CNG: a kilogram) costs, generic.
 */
export const FUELS: Record<string, { label: string; diesel: boolean; price: number }> = {
  e10: { label: 'Super E10', diesel: false, price: 1.739 },
  e5: { label: 'Super', diesel: false, price: 1.799 },
  plus: { label: 'Super Plus', diesel: false, price: 1.929 },
  diesel: { label: 'Diesel', diesel: true, price: 1.659 },
  hgv: { label: 'Lkw-Diesel', diesel: true, price: 1.629 },
  lpg: { label: 'Autogas', diesel: false, price: 0.999 },
  cng: { label: 'CNG', diesel: false, price: 1.459 },
  adblue: { label: 'AdBlue', diesel: true, price: 0.899 },
};

/** What a station sells where the file does not say. */
export const DEFAULT_FUELS = ['e10', 'e5', 'diesel'];

/** The fuels of a station from the tags of OpenStreetMap (fuel:diesel=yes …), in the order of FUELS. */
export function fuelsOf(tags: Record<string, string | undefined>): string[] {
  const yes = (k: string): boolean => {
    const v = tags[k];
    return v === 'yes' || v === 'true' || v === '1';
  };
  const out = new Set<string>();
  if (yes('fuel:e10')) out.add('e10');
  if (yes('fuel:octane_95') || yes('fuel:e5')) out.add('e5');
  if (yes('fuel:octane_98') || yes('fuel:octane_100') || yes('fuel:octane_102')) out.add('plus');
  if (yes('fuel:diesel') || yes('fuel:GTL_diesel') || yes('fuel:biodiesel')) out.add('diesel');
  if (yes('fuel:HGV_diesel')) out.add('hgv');
  if (yes('fuel:lpg')) out.add('lpg');
  if (yes('fuel:cng')) out.add('cng');
  if (yes('fuel:adblue')) out.add('adblue');
  return Object.keys(FUELS).filter((k) => out.has(k));
}

/** A station's price of a fuel: the generic price, a few cents up or down from station to station (the same every visit). */
export function priceAt(site: { osm: string; x?: number; z?: number }, fuel: string): number {
  // (today's real price, where the player has a key of Tankerkönig: world/fuelprices.ts)
  if (site.x !== undefined && site.z !== undefined) {
    const live = fuelPrices.priceAt(site.x, site.z, fuel);
    if (live !== null) return live;
  }
  const base = FUELS[fuel]?.price ?? 1.8;
  let h = 2166136261;
  for (let i = 0; i < site.osm.length; i++) h = Math.imul(h ^ site.osm.charCodeAt(i), 16777619);
  const k = ((h >>> 0) % 1000) / 1000;
  return Math.round((base - 0.04 + k * 0.08) * 1000) / 1000;
}

/** What a wash costs (generic). */
export const WASH_PRICE = 9.9;

// ------------------------------------------------------------------ geometry

/** A rectangle turned in the plane: its middle, the unit vector along its long side (u), its length (along u) and width. */
export interface Rect {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  len: number;
  wid: number;
}

/** A point of the plane in a rectangle's frame: along it (u) and across (v; v = u turned a quarter towards +z from +x). */
export function toRect(r: Rect, x: number, z: number): [number, number] {
  const dx = x - r.cx;
  const dz = z - r.cz;
  return [dx * r.ux + dz * r.uz, -dx * r.uz + dz * r.ux];
}

/** … and back. */
export function fromRect(r: Rect, u: number, v: number): [number, number] {
  return [r.cx + u * r.ux - v * r.uz, r.cz + u * r.uz + v * r.ux];
}

/** The convex hull of a flat x, z list (counter-clockwise in x, z), as x, z pairs. */
export function convexHull(pts: ArrayLike<number>): number[] {
  const p: Array<[number, number]> = [];
  for (let i = 0; i + 1 < pts.length; i += 2) p.push([pts[i], pts[i + 1]]);
  p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p.flat();
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Array<[number, number]> = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return [...lower, ...upper].flat();
}

/** The smallest rectangle round a ring (x, z pairs), its long side along u. */
export function minRect(ring: ArrayLike<number>): Rect {
  const h = convexHull(ring);
  const n = h.length / 2;
  if (n === 0) return { cx: 0, cz: 0, ux: 1, uz: 0, len: 0, wid: 0 };
  if (n < 3) {
    const dx = h[h.length - 2] - h[0];
    const dz = h[h.length - 1] - h[1];
    const l = Math.hypot(dx, dz);
    return { cx: (h[0] + h[h.length - 2]) / 2, cz: (h[1] + h[h.length - 1]) / 2, ux: l > 0 ? dx / l : 1, uz: l > 0 ? dz / l : 0, len: l, wid: 0 };
  }
  let best: Rect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = h[j * 2] - h[i * 2];
    const dz = h[j * 2 + 1] - h[i * 2 + 1];
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) continue;
    const r: Rect = { cx: 0, cz: 0, ux: dx / l, uz: dz / l, len: 0, wid: 0 };
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const [u, v] = toRect(r, h[k * 2], h[k * 2 + 1]);
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      const [cx, cz] = fromRect(r, (u0 + u1) / 2, (v0 + v1) / 2);
      best = { cx, cz, ux: r.ux, uz: r.uz, len: u1 - u0, wid: v1 - v0 };
    }
  }
  const b = best as Rect;
  // (the long side along u)
  if (b.wid > b.len) return { cx: b.cx, cz: b.cz, ux: -b.uz, uz: b.ux, len: b.wid, wid: b.len };
  return b;
}

/** The corners of a rectangle grown by `pad` on every side, as a ring of x, z pairs. */
export function rectRing(r: Rect, pad = 0): number[] {
  const out: number[] = [];
  for (const [su, sv] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) out.push(...fromRect(r, su * (r.len / 2 + pad), sv * (r.wid / 2 + pad)));
  return out;
}

/** Even-odd point-in-ring test for a flat x, z ring. */
export function inRing(x: number, z: number, ring: ArrayLike<number>): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i];
    const zi = ring[i + 1];
    const xj = ring[j];
    const zj = ring[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** How far a point is from a ring's outline (0 on it). */
export function ringDistance(x: number, z: number, ring: ArrayLike<number>): number {
  let best = Infinity;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const ax = ring[j];
    const az = ring[j + 1];
    const dx = ring[i] - ax;
    const dz = ring[i + 1] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}

/** The area of a flat x, z ring (always positive). */
export function ringAreaAbs(ring: ArrayLike<number>): number {
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    a += ring[i] * ring[j + 1] - ring[j] * ring[i + 1];
  }
  return Math.abs(a / 2);
}

// ------------------------------------------------------------------ the layout of a site

/** A pump island: a raised kerb along u with a pump in its middle. */
export interface Island {
  x: number;
  z: number;
  ux: number;
  uz: number;
  len: number;
  wid: number;
}

/** A canopy over pumps as the game builds it. */
export interface CanopyPlan {
  ring: number[];
  rect: Rect;
  /** its ground and its top (m above sea level; NaN where the game has to take the ground under it) */
  y0: number;
  y1: number;
  /** its height over the ground where only that is known (OpenStreetMap's height tag; NaN: none) */
  h: number;
  islands: Island[];
  /** where the pumps stand (one in the middle of each island), x, z pairs */
  pumps: number[];
  /** where the columns that carry the roof stand, x, z pairs (on the ends of the islands) */
  columns: number[];
}

/** How high over the ground a canopy's top is where nothing says so (m). */
export const CANOPY_HEIGHT = 5.2;
/** Island and pump measures (m). */
export const ISLAND_WIDTH = 1.3;
const ROW_PITCH = 7;
const COLUMN_PITCH = 10;

/**
 * The islands, pumps and columns under a canopy.  The cars drive through
 * along its long side: the islands run that way, in rows across it (one
 * row for every 7 m of width, a lane on both sides of each) and one after
 * the other along it (one for every 10 m of length).  An island that does
 * not lie under the roof (a canopy shaped like an L) is left out.
 */
export function planCanopy(ring: number[], y0: number, y1: number, h = NaN): CanopyPlan {
  const rect = minRect(ring);
  const rows = Math.max(1, Math.floor((rect.wid + 1.5) / ROW_PITCH));
  const pitchV = Math.min(7.4, rect.wid / rows);
  const cols = Math.max(1, Math.floor((rect.len + 2) / COLUMN_PITCH));
  const pitchU = rect.len / cols;
  const len = Math.max(3, Math.min(5.5, pitchU - 4));
  const islands: Island[] = [];
  const pumps: number[] = [];
  const columns: number[] = [];
  for (let i = 0; i < rows; i++) {
    const v = (i - (rows - 1) / 2) * pitchV;
    for (let j = 0; j < cols; j++) {
      const u = (j - (cols - 1) / 2) * pitchU;
      const isl: Rect = { cx: 0, cz: 0, ux: rect.ux, uz: rect.uz, len, wid: ISLAND_WIDTH };
      [isl.cx, isl.cz] = fromRect(rect, u, v);
      // (every corner under the roof)
      const corners = rectRing(isl, 0.3);
      let under = true;
      for (let k = 0; k < corners.length; k += 2) if (!inRing(corners[k], corners[k + 1], ring)) under = false;
      if (!under && !(rows === 1 && cols === 1)) continue;
      islands.push({ x: isl.cx, z: isl.cz, ux: rect.ux, uz: rect.uz, len, wid: ISLAND_WIDTH });
      pumps.push(isl.cx, isl.cz);
      // a column at the outer end of the island (at both ends of a lone island), standing on it
      const ends = cols === 1 ? [-1, 1] : [u < 0 ? -1 : 1];
      for (const e of ends) columns.push(...fromRect(rect, u + e * (len / 2 - 0.35), v));
    }
  }
  return { ring, rect, y0, y1, h, islands, pumps, columns };
}

/** A car wash as the game builds it: the bay along u, the gantry travelling along it. */
export interface WashPlan {
  ring: number[];
  rect: Rect;
  y0: number;
  y1: number;
  /** a hall (walls along both long sides, open at the ends) or a bay in the open */
  hall: boolean;
}

/** The narrowest and shortest hall a gantry fits in (m). */
export const WASH_MIN = { wid: 3.6, len: 7.5 };
/** What the gantry takes (m): the width and height of its opening. */
export const GANTRY = { width: 2.5, height: 2.3 };

/** The bay of a car wash: its hall, its roof, or the bay the build laid out in the open – null where there is none, or none a gantry fits in. */
export function planWash(site: ServiceSiteJson): WashPlan | null {
  const roof = site.roofs?.[0];
  if (roof) {
    const rect = minRect(roof.ring);
    if (rect.wid < WASH_MIN.wid || rect.len < WASH_MIN.len) return null;
    return { ring: roof.ring, rect, y0: roof.y0 ?? NaN, y1: roof.y1 ?? NaN, hall: roof.src !== 'gen' };
  }
  return null;
}

// ------------------------------------------------------------------ a vehicle at a pump, in a bay

/** Where a vehicle stands: the middle of its length on the ground, its heading, length and width. */
export interface Pose {
  x: number;
  z: number;
  yaw: number;
  length: number;
  width: number;
}

/** The pump a vehicle stands beside, the side of the vehicle it is on (−1 left, 1 right), and where along the vehicle it is (m from the middle, + towards the rear). */
export interface AtPump {
  pump: number;
  side: number;
  along: number;
  gap: number;
}

/** How far a hose reaches from the pump to the side of a vehicle (m). */
export const HOSE_REACH = 2.6;

/**
 * The pump a vehicle stands beside, if any: one alongside it (its heading
 * along the island, either way, within 35°), not further than a hose
 * reaches from its side, and not beyond its ends.
 */
export function pumpBeside(plan: CanopyPlan, p: Pose): AtPump | null {
  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  let best: AtPump | null = null;
  for (let i = 0; i < plan.islands.length; i++) {
    const isl = plan.islands[i];
    // parallel to the island, one way or the other
    if (Math.abs(fx * isl.ux + fz * isl.uz) < Math.cos((35 * Math.PI) / 180)) continue;
    const dx = plan.pumps[i * 2] - p.x;
    const dz = plan.pumps[i * 2 + 1] - p.z;
    // along the vehicle (+ towards its rear) and across it (+ to its right)
    const along = -(dx * fx + dz * fz);
    const across = dx * -fz + dz * fx;
    const gap = Math.abs(across) - p.width / 2 - ISLAND_WIDTH / 2;
    if (gap < -0.2 || gap > HOSE_REACH) continue;
    if (Math.abs(along) > p.length / 2 + 0.8) continue;
    if (!best || gap < best.gap) best = { pump: i, side: across >= 0 ? 1 : -1, along, gap };
  }
  return best;
}

/** How a vehicle stands in a car wash's bay: how far from the stop mark along the bay (+ too far in), how far off its middle, and whether it is straight. */
export interface InBay {
  along: number;
  across: number;
  straight: boolean;
  /** inside the bay at all (between its ends, not beside it) */
  inside: boolean;
}

/** Where a vehicle stands in a bay (the stop mark is its middle). `dir`: which way it drove in (1: along u, −1: against it). */
export function inBay(plan: WashPlan, p: Pose): InBay & { dir: number } {
  const [u, v] = toRect(plan.rect, p.x, p.z);
  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  const c = fx * plan.rect.ux + fz * plan.rect.uz;
  const dir = c >= 0 ? 1 : -1;
  return {
    along: u * dir,
    across: v,
    straight: Math.abs(c) > Math.cos((14 * Math.PI) / 180),
    inside: Math.abs(u) < plan.rect.len / 2 + 0.5 && Math.abs(v) < plan.rect.wid / 2,
    dir,
  };
}

// ------------------------------------------------------------------ the sites, to be found by place

/** A site of the file, with its layout once it is first asked for. */
export interface ServiceSite extends ServiceSiteJson {
  index: number;
  /** what it sells (the file's list, or DEFAULT_FUELS) */
  sells: string[];
  canopies: CanopyPlan[];
  wash: WashPlan | null;
}

/**
 * Reads services.json.gz: each site with its layout.  Throws on a file it
 * cannot read; a site it cannot lay out keeps no canopy (no wash).
 */
export function parseServices(json: ServicesJson): ServiceSite[] {
  if (!json || json.v !== SERVICES_VERSION || !Array.isArray(json.sites)) throw new Error('not a services file of version 1');
  const out: ServiceSite[] = [];
  for (const s of json.sites) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.z) || (s.k !== 'fuel' && s.k !== 'wash')) continue;
    const site: ServiceSite = { ...s, index: out.length, sells: s.k === 'fuel' ? (s.fuels?.length ? s.fuels.filter((f) => f in FUELS) : DEFAULT_FUELS) : [], canopies: [], wash: null };
    if (s.k === 'fuel') {
      for (const r of s.roofs ?? []) {
        if (r.ring.length < 6) continue;
        const plan = planCanopy(r.ring, r.y0 ?? NaN, r.y1 ?? NaN, r.h ?? NaN);
        if (plan.islands.length > 0) site.canopies.push(plan);
      }
    } else site.wash = planWash(s);
    out.push(site);
  }
  return out;
}

/** The sites by the squares of 250 m they reach into. */
export class ServiceIndex {
  readonly sites: readonly ServiceSite[];
  private readonly grid = new Map<number, ServiceSite[]>();
  private static readonly CELL = 250;

  constructor(sites: readonly ServiceSite[]) {
    this.sites = sites;
    for (const s of sites) {
      const [x0, z0, x1, z1] = siteBox(s, 20);
      for (let i = Math.floor(x0 / ServiceIndex.CELL); i <= Math.floor(x1 / ServiceIndex.CELL); i++) {
        for (let j = Math.floor(z0 / ServiceIndex.CELL); j <= Math.floor(z1 / ServiceIndex.CELL); j++) {
          const k = ServiceIndex.key(i, j);
          const list = this.grid.get(k);
          if (list) list.push(s);
          else this.grid.set(k, [s]);
        }
      }
    }
  }

  private static key(i: number, j: number): number {
    return (i + 32768) * 65536 + (j + 32768);
  }

  /** The sites that reach within `r` of a point. */
  near(x: number, z: number, r: number): ServiceSite[] {
    const out = new Set<ServiceSite>();
    const C = ServiceIndex.CELL;
    for (let i = Math.floor((x - r) / C); i <= Math.floor((x + r) / C); i++) {
      for (let j = Math.floor((z - r) / C); j <= Math.floor((z + r) / C); j++) {
        for (const s of this.grid.get(ServiceIndex.key(i, j)) ?? []) out.add(s);
      }
    }
    return [...out];
  }

  /** The nearest site of a kind that can be used (a station with pumps, a wash with a bay) – and how far it is. */
  nearest(x: number, z: number, kind: 'fuel' | 'wash', accept: (s: ServiceSite) => boolean = () => true): { site: ServiceSite; dist: number } | null {
    let best: { site: ServiceSite; dist: number } | null = null;
    for (const s of this.sites) {
      if (s.k !== kind || (kind === 'fuel' ? s.canopies.length === 0 : !s.wash) || !accept(s)) continue;
      const d = Math.hypot(s.x - x, s.z - z);
      if (!best || d < best.dist) best = { site: s, dist: d };
    }
    return best;
  }
}

/** The box round everything of a site (its area, roofs and sign), grown by `pad`: minX, minZ, maxX, maxZ. */
export function siteBox(s: ServiceSiteJson, pad = 0): [number, number, number, number] {
  let x0 = s.x;
  let z0 = s.z;
  let x1 = s.x;
  let z1 = s.z;
  const take = (r: ArrayLike<number>): void => {
    for (let i = 0; i + 1 < r.length; i += 2) {
      x0 = Math.min(x0, r[i]);
      x1 = Math.max(x1, r[i]);
      z0 = Math.min(z0, r[i + 1]);
      z1 = Math.max(z1, r[i + 1]);
    }
  };
  if (s.area) take(s.area);
  for (const r of s.roofs ?? []) take(r.ring);
  if (s.sign) take(s.sign);
  return [x0 - pad, z0 - pad, x1 + pad, z1 + pad];
}

/** Is a point on a site (in its area or under one of its roofs, `margin` metres round them – or that near its middle, if it has neither)? */
export function onSite(s: ServiceSiteJson, x: number, z: number, margin: number): boolean {
  if (s.area && (inRing(x, z, s.area) || ringDistance(x, z, s.area) < margin)) return true;
  for (const r of s.roofs ?? []) if (inRing(x, z, r.ring) || ringDistance(x, z, r.ring) < margin) return true;
  return !s.area && !s.roofs?.length && Math.hypot(x - s.x, z - s.z) < margin + 15;
}
