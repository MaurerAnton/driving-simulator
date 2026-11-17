// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The construction site and the work done on it with a crane: where
 * everything stands, the loads lying about, the places they are to go –
 * and the work itself: a short guided start, then real tasks one after
 * another ("move this pallet of bricks onto the truck", "bring the steel
 * beam up to the roof", "set the container there"), each judged by how
 * precisely the load was set down, how much it swung, how gently it landed,
 * how long it took and whether anything was hit or overloaded.
 *
 * The site lies on the practice yard of the map (its frame: game/ce.ts,
 * YardFrame – u along the yard, w across it, heights above the site's base
 * height `y0`): a building of three storeys going up, with its scaffolding
 * and a loading platform, the tower crane beside it, storage areas, the
 * site road with a delivery truck, the depot the mobile and the loader
 * crane start from, and the stands marked out for them.
 *
 * Pure logic, no drawing: render/cranesite.ts draws the site, the crane's
 * physics is sim/crane.ts, game/craneplay.ts runs it all.
 */
import type { Box3, CraneEvents, CraneType, Lmi } from '../sim/crane.ts';
import { LOADER_BED, specOf } from '../sim/crane.ts';

// ------------------------------------------------------------------------------------ the loads

export type LoadKind = 'bricks' | 'beam' | 'container' | 'formwork' | 'mesh';

/** A kind of load: its weight, its half-sizes (x along its length, y up, z across), the slings it hangs on, its area in the wind. */
export interface LoadDef {
  kind: LoadKind;
  /** i18n key of its name */
  name: string;
  t: number;
  hx: number;
  hy: number;
  hz: number;
  sling: number;
  area: number;
}

export const LOAD_DEFS: Readonly<Record<LoadKind, LoadDef>> = {
  // a pallet of sand-lime bricks: 1.2 × 1.0 m, 1.15 m high, on a four-leg chain sling
  bricks: { kind: 'bricks', name: 'craneLoad.bricks', t: 1.25, hx: 0.6, hy: 0.575, hz: 0.5, sling: 1.6, area: 1.4 },
  // a steel beam HEB 300, 8 m: 117 kg per metre, on a two-leg sling
  beam: { kind: 'beam', name: 'craneLoad.beam', t: 0.94, hx: 4.0, hy: 0.15, hz: 0.15, sling: 2.6, area: 2.4 },
  // a 20-foot material container
  container: { kind: 'container', name: 'craneLoad.container', t: 2.4, hx: 3.03, hy: 1.295, hz: 1.22, sling: 3.8, area: 15.7 },
  // a stack of formwork panels, 2.7 × 2.4 m
  formwork: { kind: 'formwork', name: 'craneLoad.formwork', t: 1.4, hx: 1.35, hy: 0.35, hz: 1.2, sling: 2.4, area: 1.9 },
  // a bundle of reinforcing mesh, 5.0 × 2.15 m
  mesh: { kind: 'mesh', name: 'craneLoad.mesh', t: 1.05, hx: 2.5, hy: 0.2, hz: 1.075, sling: 2.8, area: 2.0 },
};

// ------------------------------------------------------------------------------------ the site

/** A rectangle of the site (u0 … u1, w0 … w1). */
export interface SiteRect {
  u0: number;
  u1: number;
  w0: number;
  w1: number;
}

/** A solid of the site: a rectangle in the plan from y0 to y1 above the base height. */
export interface SiteSolid extends SiteRect {
  y0: number;
  y1: number;
}

/** A surface something can be set down on: a rectangle at a height above the base height. */
export interface SitePlatform extends SiteRect {
  y: number;
}

/** A pose on the site (u, w; yaw: 0 facing −w, positive to the left, as on the map). */
export interface SitePose {
  u: number;
  w: number;
  yaw: number;
}

/** facing along +u (the site road runs that way) */
const EAST = -Math.PI / 2;

/** The building going up: three storeys and a roof, 16 × 12 m. */
export const BUILDING = {
  u0: 8,
  u1: 24,
  w0: -6,
  w1: 6,
  /** the slabs' tops (ground floor on its plinth, first, second floor, roof) */
  floors: [0.3, 3.3, 6.3, 9.3],
  slab: 0.25,
  /** the stair core at the north-west corner, a storey higher than the roof */
  core: { u0: 8, u1: 11.5, w0: -6, w1: -2.5, top: 12.3 },
  /** the loading platform sticking out at the second floor */
  platform: { u0: 14, u1: 17.2, w0: -8.6, w1: -6, y: 6.3 },
  /** the scaffolding along the south and the east face, and its top */
  scaffold: [
    { u0: 8, u1: 25.3, w0: 6.3, w1: 7.3 },
    { u0: 24.3, u1: 25.3, w0: -6, w1: 6.3 },
  ],
  scaffoldTop: 10.4,
  /** the guard rails round the roof (where there is no scaffolding), their top */
  rails: [
    { u0: 11.5, u1: 24, w0: -6, w1: -5.9 },
    { u0: 8, u1: 8.1, w0: -2.5, w1: 6 },
  ],
  railTop: 10.4,
};

/** The tower crane: the middle of its base, its cross base and ballast, its mast. */
export const TOWER_SITE = { u: -1, w: -1, yaw: 0, base: 2.5, ballastTop: 2.6, mast: 0.85, mastTop: 30 };

/** The delivery truck on the site road: its flatbed (a rectangle and its floor's height) and its cab. */
export const DELIVERY = { bed: { u0: 5, u1: 11.5, w0: -21.7, w1: -19.3, y: 1.25 }, cab: { u0: 11.8, u1: 14.2, w0: -21.75, w1: -19.25, y0: 0, y1: 3.1 }, chassis: { u0: 4.8, u1: 11.8, w0: -21.4, w1: -19.6, y0: 0.3, y1: 1.25 } };

/** The areas of the site laid out on the ground. */
export const AREAS = {
  depot: { u0: -74, u1: -50, w0: -27, w1: -8 },
  road: { u0: -74, u1: 46, w0: -24, w1: -17 },
  storage: { u0: -30, u1: -6, w0: 3, w1: 21 },
  west: { u0: -44, u1: -20, w0: -16.5, w1: -9 },
  site: { u0: -20, u1: 40, w0: -16.5, w1: 24 },
};

/** The stands marked out for the mobile and the loader crane, and where the vehicle is to stand in them. */
export const STANDS: Record<'mobile' | 'loader', { area: SiteRect; pose: SitePose; tol: { u: number; w: number; yaw: number } }> = {
  mobile: { area: { u0: -15, u1: 1, w0: -16.5, w1: -9.5 }, pose: { u: -7, w: -13, yaw: EAST }, tol: { u: 2.5, w: 1.5, yaw: 0.21 } },
  loader: { area: { u0: -39, u1: -29, w0: -22.3, w1: -18.7 }, pose: { u: -34, w: -20.5, yaw: EAST }, tol: { u: 2.5, w: 1.0, yaw: 0.21 } },
};

/** Where the mobile and the loader crane start: in the depot, on the site road, facing the site. */
export const DEPOT_START: SitePose = { u: -62, w: -20.5, yaw: EAST };

/** The site office and the store at the depot (containers). */
export const OFFICES: SiteSolid[] = [
  { u0: -69, u1: -63, w0: -13.3, w1: -10.9, y0: 0, y1: 2.6 },
  { u0: -61, u1: -55, w0: -13.3, w1: -10.9, y0: 0, y1: 2.6 },
];

/** A load lying on the site at the start: its kind, its place (on the ground, on timber bearers, or on the loader crane's own flatbed). */
export interface SiteLoad {
  id: string;
  kind: LoadKind;
  u: number;
  w: number;
  yaw: number;
  /** on timber bearers (12 cm up) */
  bearers?: boolean;
  /** on the loader crane's flatbed: its place there (carrier frame x, z) and its turn against the truck */
  bed?: { x: number; z: number; yaw: number };
}

/** A place a load is to go: on the ground, on a slab, on the truck's bed, on the loader crane's own bed. */
export interface SiteZone {
  id: string;
  /** its middle and how it is turned (the load must lie the same way) */
  u: number;
  w: number;
  yaw: number;
  /** half its size: the load's middle must come to lie within */
  hu: number;
  hw: number;
  /** the surface it lies on: the ground ('ground'), or a height above the base height */
  y: number | 'ground';
  /** on the loader crane's own flatbed (its middle in the carrier frame: x, z) */
  bed?: { x: number; z: number };
  /** timber bearers lie there for the load to go on */
  bearers?: boolean;
}

/** A task: which load goes where, what it is called, how long it should take. */
export interface SiteTask {
  load: string;
  zone: string;
  /** i18n key of the instruction */
  text: string;
  /** a good time for it (s) */
  par: number;
}

/** What a crane has to do on the site: its loads, the places they go, the tasks in order (the first one is the guided one). */
export interface CraneWorkPlan {
  type: CraneType;
  loads: SiteLoad[];
  zones: SiteZone[];
  tasks: SiteTask[];
}

/** loads lying about that nobody moves (they make the site, and are in the way) */
export const SITE_LOADS: SiteLoad[] = [
  { id: 'xB1', kind: 'bricks', u: -27, w: 5, yaw: 0 },
  { id: 'xB2', kind: 'bricks', u: -27, w: 6.4, yaw: 0 },
  { id: 'xB3', kind: 'bricks', u: -25.5, w: 5, yaw: 0 },
  { id: 'xF1', kind: 'formwork', u: 30, w: 12, yaw: 0 },
  { id: 'xF2', kind: 'formwork', u: 30, w: 15, yaw: 0 },
  { id: 'xM1', kind: 'mesh', u: 32, w: 20, yaw: 0, bearers: true },
];

export const PLANS: Readonly<Record<CraneType, CraneWorkPlan>> = {
  tower: {
    type: 'tower',
    loads: [
      { id: 'tB1', kind: 'bricks', u: -12, w: 8, yaw: 0 },
      { id: 'tB2', kind: 'bricks', u: -12, w: 10.5, yaw: 0 },
      { id: 'tS1', kind: 'beam', u: -16, w: 15, yaw: 0, bearers: true },
      { id: 'tC1', kind: 'container', u: -22, w: 16.5, yaw: 0 },
    ],
    zones: [
      { id: 'tG1', u: 2, w: 10, yaw: 0, hu: 0.75, hw: 0.65, y: 'ground' },
      { id: 'tPlat', u: 15.6, w: -7.3, yaw: 0, hu: 0.8, hw: 0.6, y: BUILDING.platform.y },
      { id: 'tRoof', u: 16, w: 2, yaw: 0, hu: 0.9, hw: 0.5, y: BUILDING.floors[3] },
      { id: 'tCont', u: 24, w: -12.5, yaw: 0, hu: 0.7, hw: 0.6, y: 'ground' },
    ],
    tasks: [
      { load: 'tB1', zone: 'tG1', text: 'craneTask.bricksHere', par: 120 },
      { load: 'tB2', zone: 'tPlat', text: 'craneTask.bricksPlatform', par: 110 },
      { load: 'tS1', zone: 'tRoof', text: 'craneTask.beamRoof', par: 130 },
      { load: 'tC1', zone: 'tCont', text: 'craneTask.containerThere', par: 150 },
    ],
  },
  mobile: {
    type: 'mobile',
    loads: [
      { id: 'mB1', kind: 'bricks', u: -2, w: -7, yaw: 0 },
      { id: 'mB2', kind: 'bricks', u: 0.2, w: -7, yaw: 0 },
      { id: 'mS1', kind: 'beam', u: -19, w: -7.5, yaw: 0, bearers: true },
      { id: 'mC1', kind: 'container', u: -24, w: -10.6, yaw: 0 },
    ],
    zones: [
      { id: 'mG1', u: -16, w: -4.5, yaw: 0, hu: 0.75, hw: 0.65, y: 'ground' },
      { id: 'mTruck', u: 8.2, w: -20.5, yaw: 0, hu: 0.9, hw: 0.4, y: DELIVERY.bed.y },
      { id: 'mRoof', u: 15, w: -2.2, yaw: 0, hu: 0.9, hw: 0.5, y: BUILDING.floors[3] },
      { id: 'mCont', u: -19, w: 6, yaw: 0, hu: 0.7, hw: 0.6, y: 'ground' },
    ],
    tasks: [
      { load: 'mB1', zone: 'mG1', text: 'craneTask.bricksHere', par: 120 },
      { load: 'mB2', zone: 'mTruck', text: 'craneTask.bricksTruck', par: 110 },
      { load: 'mS1', zone: 'mRoof', text: 'craneTask.beamRoof', par: 150 },
      { load: 'mC1', zone: 'mCont', text: 'craneTask.containerThere', par: 150 },
    ],
  },
  loader: {
    type: 'loader',
    loads: [
      { id: 'lP1', kind: 'bricks', u: 0, w: 0, yaw: 0, bed: { x: -0.62, z: -0.32, yaw: 0 } },
      { id: 'lP2', kind: 'bricks', u: 0, w: 0, yaw: 0, bed: { x: 0.62, z: -0.32, yaw: 0 } },
      { id: 'lM1', kind: 'mesh', u: 0, w: 0, yaw: 0, bed: { x: 0, z: 2.7, yaw: Math.PI / 2 } },
      { id: 'lF1', kind: 'formwork', u: -33.5, w: -13.2, yaw: 0 },
    ],
    zones: [
      { id: 'lG1', u: -30.5, w: -13, yaw: 0, hu: 0.75, hw: 0.65, y: 'ground' },
      { id: 'lG2', u: -27.7, w: -13, yaw: 0, hu: 0.6, hw: 0.5, y: 'ground' },
      { id: 'lG3', u: -38.5, w: -13, yaw: 0, hu: 0.7, hw: 0.45, y: 'ground', bearers: true },
      // (anywhere on the flatbed: its middle within)
      { id: 'lBed', u: 0, w: 0, yaw: 0, hu: 1.0, hw: 0.2, y: LOADER_BED.y, bed: { x: 0, z: (LOADER_BED.z0 + LOADER_BED.z1) / 2 } },
    ],
    tasks: [
      { load: 'lP1', zone: 'lG1', text: 'craneTask.unloadPallet', par: 100 },
      { load: 'lP2', zone: 'lG2', text: 'craneTask.unloadPallet2', par: 90 },
      { load: 'lM1', zone: 'lG3', text: 'craneTask.meshBearers', par: 110 },
      { load: 'lF1', zone: 'lBed', text: 'craneTask.formworkBed', par: 110 },
    ],
  },
};

/** The timber bearers the mesh is to go on (and the beams lie on): 12 cm. */
export const BEARERS = 0.12;

// ------------------------------------------------------------------------------------ in the world

/** How the site lies in the world: its frame (game/ce.ts YardFrame does this) and its base height. */
export interface SitePlacement {
  toWorld(u: number, w: number): [number, number];
  toLocal(x: number, z: number): [number, number];
  yawToWorld(yaw: number): number;
  yawToLocal(yaw: number): number;
}

/** A load in the world: where its bottom's middle is, how it is turned, whether it hangs on the hook or rides on the loader's bed. */
export interface WorldLoad {
  id: string;
  def: LoadDef;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** others' loads nobody moves */
  fixed: boolean;
  hooked: boolean;
  /** on the loader crane's own flatbed: its place there (carrier frame) and its turn against the truck – it goes where the truck goes */
  bed: { x: number; z: number; yaw: number } | null;
  /** on timber bearers (drawn under it) */
  bearers: boolean;
}

/** A place a load is to go, in the world: its middle, turn, half-sizes, the height of what it lies on. */
export interface WorldZone {
  id: string;
  x: number;
  z: number;
  yaw: number;
  hu: number;
  hw: number;
  /** the height of the surface (NaN: the ground, wherever it is) */
  y: number;
  bed: { x: number; z: number } | null;
  /** timber bearers lie there (see bearersOf) */
  bearers: boolean;
}

/**
 * The timber bearers lying at a place (two, across the load's length, as
 * under the loads on bearers), as solids of the world reaching from the
 * ground to their top: (x, z) and the ground's height there.
 */
export function bearersOf(zone: WorldZone, def: LoadDef, ground: number): Array<Box3 & { y: number }> {
  const along = def.hx > 1.5 ? def.hx - 0.8 : def.hx - 0.2;
  const c = Math.cos(zone.yaw);
  const s = Math.sin(zone.yaw);
  const out: Array<Box3 & { y: number }> = [];
  for (const k of [-along, along]) {
    // (each 12 cm square, as long as the load is wide and a little more)
    const pts: Array<[number, number]> = [];
    for (const [du, dw] of [
      [k - 0.06, -def.hz - 0.15],
      [k + 0.06, -def.hz - 0.15],
      [k - 0.06, def.hz + 0.15],
      [k + 0.06, def.hz + 0.15],
    ]) pts.push([zone.x + du * c + dw * s, zone.z - du * s + dw * c]);
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    out.push({ x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs), y0: ground - 0.5, y1: ground + BEARERS, y: ground + BEARERS });
  }
  return out;
}

/** A rectangle of the site as a world box (axis-aligned: the yard is turned by quarters). */
export function worldBox(p: SitePlacement, r: SiteRect, y0: number, y1: number): Box3 {
  const [ax, az] = p.toWorld(r.u0, r.w0);
  const [bx, bz] = p.toWorld(r.u1, r.w1);
  return { x0: Math.min(ax, bx), x1: Math.max(ax, bx), z0: Math.min(az, bz), z1: Math.max(az, bz), y0, y1 };
}

/** The half-size in the world's plan (x, z) of a load turned by yaw. */
export function loadFootprint(def: LoadDef, yaw: number): [number, number] {
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  return [def.hx * c + def.hz * s, def.hx * s + def.hz * c];
}

/** The fixed geometry of the site in the world: the surfaces loads can be set on and the solids they stop at. */
export interface SiteWorld {
  platforms: Array<Box3 & { y: number }>;
  solids: Box3[];
}

/**
 * The site's surfaces and solids in the world.  `tower`: the tower crane
 * stands there as part of the site (when it is not the player's own it is
 * in the way all the same – it is always there).
 */
export function siteWorld(p: SitePlacement, y0: number): SiteWorld {
  const b = BUILDING;
  const platforms: Array<Box3 & { y: number }> = [];
  const solids: Box3[] = [];
  const plat = (r: SiteRect, y: number): void => {
    platforms.push({ ...worldBox(p, r, y0 - 2, y0 + y), y: y0 + y });
  };
  // the building: solid up to its roof (nothing is put inside it from the crane), the roof to set things on
  solids.push(worldBox(p, b, y0 - 2, y0 + b.floors[3]));
  plat(b, b.floors[3]);
  solids.push(worldBox(p, b.core, y0 - 2, y0 + b.core.top));
  plat(b.core, b.core.top);
  // the loading platform at the second floor, its rails at the sides
  plat(b.platform, b.platform.y);
  solids.push(worldBox(p, { u0: b.platform.u0 - 0.06, u1: b.platform.u0, w0: b.platform.w0, w1: b.platform.w1 }, y0 + b.platform.y, y0 + b.platform.y + 1.1));
  solids.push(worldBox(p, { u0: b.platform.u1, u1: b.platform.u1 + 0.06, w0: b.platform.w0, w1: b.platform.w1 }, y0 + b.platform.y, y0 + b.platform.y + 1.1));
  for (const s of b.scaffold) {
    solids.push(worldBox(p, s, y0 - 2, y0 + b.scaffoldTop));
    plat(s, b.scaffoldTop);
  }
  for (const r of b.rails) solids.push(worldBox(p, r, y0 + b.floors[3], y0 + b.railTop));
  // the tower crane: its ballast and its mast
  const t = TOWER_SITE;
  solids.push(worldBox(p, { u0: t.u - t.base, u1: t.u + t.base, w0: t.w - t.base, w1: t.w + t.base }, y0 - 2, y0 + t.ballastTop));
  plat({ u0: t.u - t.base, u1: t.u + t.base, w0: t.w - t.base, w1: t.w + t.base }, t.ballastTop);
  solids.push(worldBox(p, { u0: t.u - t.mast, u1: t.u + t.mast, w0: t.w - t.mast, w1: t.w + t.mast }, y0, y0 + t.mastTop));
  // the delivery truck: its cab and chassis, its bed
  const d = DELIVERY;
  solids.push(worldBox(p, d.cab, y0 + d.cab.y0, y0 + d.cab.y1));
  solids.push(worldBox(p, d.chassis, y0 + d.chassis.y0, y0 + d.chassis.y1));
  plat(d.bed, d.bed.y);
  for (const o of OFFICES) {
    solids.push(worldBox(p, o, y0 - 2, y0 + o.y1));
    plat(o, o.y1);
  }
  return { platforms, solids };
}

/** The loads a crane finds on the site: its own (to be moved) and the others lying about (fixed). */
export function siteLoads(type: CraneType, p: SitePlacement, ground: (x: number, z: number) => number): WorldLoad[] {
  const out: WorldLoad[] = [];
  const add = (l: SiteLoad, fixed: boolean): void => {
    const def = LOAD_DEFS[l.kind];
    const [x, z] = p.toWorld(l.u, l.w);
    const yaw = p.yawToWorld(l.yaw);
    const [fx, fz] = loadFootprint(def, yaw);
    // (on the highest point of the ground under it)
    let y = -Infinity;
    for (const [dx, dz] of [[0, 0], [-fx, -fz], [fx, -fz], [-fx, fz], [fx, fz]]) {
      const g = ground(x + dx, z + dz);
      if (Number.isFinite(g)) y = Math.max(y, g);
    }
    if (!Number.isFinite(y)) y = 0;
    out.push({ id: l.id, def, x, y: y + (l.bearers ? BEARERS : 0), z, yaw, fixed, hooked: false, bed: l.bed ? { ...l.bed } : null, bearers: !!l.bearers });
  };
  for (const l of PLANS[type].loads) add(l, false);
  for (const l of SITE_LOADS) add(l, true);
  return out;
}

/** The places of a crane's tasks in the world. */
export function siteZones(type: CraneType, p: SitePlacement, y0: number): WorldZone[] {
  return PLANS[type].zones.map((zn) => {
    const [x, z] = p.toWorld(zn.u, zn.w);
    return { id: zn.id, x, z, yaw: p.yawToWorld(zn.yaw), hu: zn.hu, hw: zn.hw, y: zn.y === 'ground' ? Number.NaN : y0 + zn.y, bed: zn.bed ? { ...zn.bed } : null, bearers: !!zn.bearers };
  });
}

/** Where a point lies in a zone's own frame (along its u, across its w). */
export function inZone(zone: WorldZone, x: number, z: number): { du: number; dw: number } {
  // (the zone's axes: its yaw turns u (east at 0) and w (south at 0) like the yard's frame)
  const c = Math.cos(zone.yaw);
  const s = Math.sin(zone.yaw);
  const dx = x - zone.x;
  const dz = z - zone.z;
  return { du: dx * c - dz * s, dw: dx * s + dz * c };
}

/** The difference between two turns of a load, folded: a load turned round (180°) lies the same way. */
export function yawOff(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

// ------------------------------------------------------------------------------------ the work

/** The steps of the guided start, in order (the tower crane begins at 'over'). */
export type GuideStep = 'drive' | 'park' | 'operate' | 'beams' | 'jacks' | 'level' | 'raise' | 'over' | 'lower' | 'attach' | 'lift' | 'move' | 'setDown' | 'release';

export const GUIDE: Readonly<Record<CraneType, readonly GuideStep[]>> = {
  tower: ['over', 'lower', 'attach', 'lift', 'move', 'setDown', 'release'],
  mobile: ['drive', 'park', 'operate', 'beams', 'jacks', 'level', 'raise', 'over', 'lower', 'attach', 'lift', 'move', 'setDown', 'release'],
  loader: ['drive', 'park', 'operate', 'beams', 'jacks', 'level', 'raise', 'over', 'lower', 'attach', 'lift', 'move', 'setDown', 'release'],
};

/** What the work needs to know of the crane and its vehicle, each step. */
export interface CraneSnapshot {
  time: number;
  /** the vehicle's origin (world x, z), heading, speed (m/s); the parking brake; the crane being worked */
  vx: number;
  vz: number;
  yaw: number;
  speed: number;
  handbrake: boolean;
  operating: boolean;
  /** the outrigger beams' least extension (0 … 1), the pads all down, the carrier lifted off its wheels (the mobile crane) or the pads bearing (the loader crane), its slope (deg), the crane folded for the road */
  beams: number;
  padsDown: boolean;
  onOutriggers: boolean;
  incline: number;
  stowed: boolean;
  /** the mobile crane's boom angle (deg); the loader crane unfolded */
  luff: number;
  unfolded: boolean;
  /** the head the rope hangs from, the hook (world), the load on it */
  head: { x: number; y: number; z: number };
  hook: { x: number; y: number; z: number };
  hooked: string | null;
  /** the hook or the load stands on something; the clearance below it; how far it swings off the plumb line (m) */
  resting: boolean;
  clearance: number;
  swing: number;
  lmi: Lmi;
  events: CraneEvents;
  /** it tipped over */
  tipped: boolean;
}

/** How one task went. */
export interface TaskResult {
  /** i18n key of the task and the load's name */
  text: string;
  load: string;
  /** seconds, from its start to the load let go in place */
  time: number;
  par: number;
  /** how far from the mark the load came to stand (m), and how far turned (deg) */
  offset: number;
  /** the most it swung on the way (m), and how fast it came down at the end (m/s) */
  swing: number;
  landing: number;
  /** the highest the limiter showed while it hung (share of the chart), and whether it cut off */
  peak: number;
  overload: boolean;
  /** what the load ran into (times) */
  hits: number;
  /** 0 … 100, and 0 … 3 stars */
  score: number;
  stars: number;
}

/** A fault for the instructor (sim/rules.ts noteAt): its id, how grave, its numbers. */
export interface CraneFault {
  id: string;
  severity: 'hint' | 'minor' | 'major' | 'fail';
  data: Record<string, number | string>;
}

/** what the work says after a step */
export interface WorkEvents {
  faults: CraneFault[];
  /** a step of the guide is done (the next is in `step`) */
  stepDone: boolean;
  /** a task is done (its result is the last of `results`) */
  taskDone: boolean;
  /** everything is done */
  allDone: boolean;
}

/** The score of a task from how it went (see TaskResult). */
export function scoreTask(r: Pick<TaskResult, 'time' | 'par' | 'offset' | 'swing' | 'landing' | 'overload' | 'hits'>): { score: number; stars: number } {
  const lin = (v: number, good: number, bad: number): number => Math.max(0, Math.min(1, (bad - v) / (bad - good)));
  const score = Math.round(
    30 * lin(r.offset, 0.1, 0.6) +
      25 * lin(r.swing, 0.3, 1.8) +
      15 * lin(r.landing, 0.15, 0.75) +
      15 * lin(r.time, r.par, r.par * 3) +
      Math.max(0, 15 - 7.5 * r.hits - (r.overload ? 7.5 : 0)),
  );
  return { score, stars: score >= 85 ? 3 : score >= 60 ? 2 : score >= 35 ? 1 : 0 };
}

/** how close the hook has to be over a load to sling it (horizontally, m), and above its top (m) */
export const ATTACH_REACH = 1.0;
export const ATTACH_ABOVE = 0.9;

/**
 * The work with a crane on the site: the guided start, then the tasks one
 * by one, judged as they go.  The game tells it each step how the crane
 * and its vehicle are (`update`), asks which load the hook can take
 * (`reachable`) and tells it when a load is let go (`placed`).
 */
export class CraneTasks {
  readonly type: CraneType;
  readonly plan: CraneWorkPlan;
  readonly loads: WorldLoad[];
  readonly zones: WorldZone[];
  /** the guided start ('guide'), the tasks, all done */
  stage: 'guide' | 'tasks' | 'done' = 'guide';
  /** the guide's step now (null once it is done) */
  step: GuideStep | null;
  private stepIndex = 0;
  /** the task now (the guide is the first) */
  task = 0;
  readonly results: TaskResult[] = [];
  /** where the stand is (world) for the mobile and the loader crane, and how the vehicle is to stand there */
  readonly stand: { x: number; z: number; yaw: number; tol: { u: number; w: number; yaw: number } } | null;
  /** how the task now is going */
  private cur = { start: 0, swing: 0, landing: 0, peak: 0, overload: false, hits: 0, lifted: false };
  private readonly faultT = new Map<string, number>();

  constructor(type: CraneType, place: SitePlacement, ground: (x: number, z: number) => number, y0: number) {
    this.type = type;
    this.plan = PLANS[type];
    this.loads = siteLoads(type, place, ground);
    this.zones = siteZones(type, place, y0);
    this.step = GUIDE[type][0];
    if (type === 'tower') this.stand = null;
    else {
      const s = STANDS[type];
      const [x, z] = place.toWorld(s.pose.u, s.pose.w);
      this.stand = { x, z, yaw: place.yawToWorld(s.pose.yaw), tol: s.tol };
    }
  }

  /** The task now (null once all are done). */
  current(): SiteTask | null {
    return this.stage === 'done' ? null : (this.plan.tasks[this.task] ?? null);
  }

  /** The load of the task now, and the place it goes. */
  target(): { load: WorldLoad; zone: WorldZone } | null {
    const t = this.current();
    if (!t) return null;
    const load = this.loads.find((l) => l.id === t.load);
    const zone = this.zones.find((z) => z.id === t.zone);
    return load && zone ? { load, zone } : null;
  }

  /** The load the hook can take: one of this crane's (not fixed), the hook over its middle and a little above it. */
  reachable(hook: { x: number; y: number; z: number }, hookDrop: number): WorldLoad | null {
    let best: WorldLoad | null = null;
    let bestD = Infinity;
    for (const l of this.loads) {
      if (l.fixed || l.hooked) continue;
      const d = Math.hypot(hook.x - l.x, hook.z - l.z);
      const top = l.y + 2 * l.def.hy;
      const above = hook.y - hookDrop - top;
      if (d <= ATTACH_REACH && above >= -0.25 && above <= ATTACH_ABOVE && d < bestD) {
        best = l;
        bestD = d;
      }
    }
    return best;
  }

  /** The vehicle stands in its stand as it should (the mobile and the loader crane). */
  inStand(s: Pick<CraneSnapshot, 'vx' | 'vz' | 'yaw'>): boolean {
    const st = this.stand;
    if (!st) return true;
    // (in the stand's own frame: along the way the vehicle faces, and across)
    const fx = -Math.sin(st.yaw);
    const fz = -Math.cos(st.yaw);
    const dx = s.vx - st.x;
    const dz = s.vz - st.z;
    const along = dx * fx + dz * fz;
    const across = dx * -fz + dz * fx;
    let dy = Math.abs(s.yaw - st.yaw) % (Math.PI * 2);
    if (dy > Math.PI) dy = Math.PI * 2 - dy;
    return Math.abs(along) <= st.tol.u && Math.abs(across) <= st.tol.w && dy <= st.tol.yaw;
  }

  /** The load of the task now lies where it should, let go: its middle within the zone, turned its way. */
  inPlace(load: WorldLoad, zone: WorldZone): boolean {
    if (load.hooked) return false;
    if (zone.bed && !load.bed) return false;
    if (zone.bed && load.bed) return Math.abs(load.bed.x - zone.bed.x) <= zone.hw + 0.4 && Math.abs(load.bed.z - zone.bed.z) <= zone.hu + 1.0;
    const p = inZone(zone, load.x, load.z);
    if (Math.abs(p.du) > zone.hu || Math.abs(p.dw) > zone.hw) return false;
    if (yawOff(load.yaw, zone.yaw) > 0.35) return false;
    // (on the surface meant – not on the ground under the platform)
    return Number.isNaN(zone.y) || Math.abs(load.y - zone.y) < 0.3;
  }

  /** How far a load lies from its mark (m). */
  offset(load: WorldLoad, zone: WorldZone): number {
    if (zone.bed && load.bed) return Math.abs(load.bed.x - zone.bed.x);
    return Math.hypot(load.x - zone.x, load.z - zone.z);
  }

  private fault(out: CraneFault[], time: number, id: string, severity: CraneFault['severity'], data: CraneFault['data'] = {}, every = 6): void {
    const at = this.faultT.get(id) ?? -Infinity;
    if (time - at < every) return;
    this.faultT.set(id, time);
    out.push({ id, severity, data });
  }

  /** One step of the work: the guide moves on, the task is watched and judged, faults are told. */
  update(s: CraneSnapshot): WorkEvents {
    const ev: WorkEvents = { faults: [], stepDone: false, taskDone: false, allDone: false };
    if (this.stage === 'done') return ev;
    const cur = this.cur;
    if (cur.start === 0) cur.start = s.time;
    const tg = this.target();
    const hooked = s.hooked !== null && tg !== null && s.hooked === tg.load.id;
    // what is watched while a load hangs
    if (s.hooked) {
      if (!s.resting) {
        if (!cur.lifted) cur.lifted = true;
        cur.swing = Math.max(cur.swing, s.swing);
        cur.peak = Math.max(cur.peak, s.lmi.ratio);
        if (s.swing > 2) this.fault(ev.faults, s.time, 'craneSwing', 'minor', { m: Math.round(s.swing * 10) / 10 }, 10);
        if (s.lmi.wind > s.lmi.windLimit) this.fault(ev.faults, s.time, 'craneWind', 'major', { v: Math.round(s.lmi.wind), max: s.lmi.windLimit }, 15);
      }
      if (s.events.landed > 0 && hooked) cur.landing = s.events.landed;
      if (s.events.landed > 0.5) this.fault(ev.faults, s.time, 'craneHardLanding', 'minor', { v: Math.round(s.events.landed * 10) / 10 }, 4);
      if (s.events.liftedOff) {
        // lifted with the hook not over the load's middle: it is dragged and swings off (no diagonal pull)
        const off = Math.hypot(s.head.x - s.hook.x, s.head.z - s.hook.z);
        if (off > 0.6) this.fault(ev.faults, s.time, 'craneDiagonalPull', 'minor', { m: Math.round(off * 10) / 10 }, 4);
      }
    }
    if (s.events.cut && (s.lmi.stop || s.lmi.notLevel)) {
      if (s.lmi.stop) {
        if (hooked) cur.overload = true;
        this.fault(ev.faults, s.time, 'craneOverload', 'major', { p: Math.round(s.lmi.ratio * 100) }, 8);
      } else this.fault(ev.faults, s.time, 'craneNotLevel', 'minor', { d: Math.round(s.lmi.incline * 10) / 10 }, 10);
    }
    if (s.events.hit > 0.25) {
      if (s.hooked) {
        if (hooked) cur.hits++;
        this.fault(ev.faults, s.time, 'craneLoadHit', 'major', { v: Math.round(s.events.hit * 10) / 10 }, 3);
      } else if (s.events.hit > 0.6) this.fault(ev.faults, s.time, 'craneHookHit', 'minor', {}, 5);
    }
    if (s.tipped) this.fault(ev.faults, s.time, 'craneTipped', 'fail', {}, 1000);
    // the guide
    if (this.stage === 'guide' && this.step) {
      if (this.stepDone(this.step, s, tg)) {
        ev.stepDone = true;
        this.stepIndex++;
        const steps = GUIDE[this.type];
        this.step = this.stepIndex < steps.length ? steps[this.stepIndex] : null;
      }
    }
    // a task is done once its load lies where it should, let go
    if (tg && this.inPlace(tg.load, tg.zone)) {
      const { score, stars } = scoreTask({ time: s.time - cur.start, par: this.plan.tasks[this.task].par, offset: this.offset(tg.load, tg.zone), swing: cur.swing, landing: cur.landing, overload: cur.overload, hits: cur.hits });
      this.results.push({
        text: this.plan.tasks[this.task].text,
        load: tg.load.def.name,
        time: s.time - cur.start,
        par: this.plan.tasks[this.task].par,
        offset: this.offset(tg.load, tg.zone),
        swing: cur.swing,
        landing: cur.landing,
        peak: cur.peak,
        overload: cur.overload,
        hits: cur.hits,
        score,
        stars,
      });
      ev.taskDone = true;
      this.task++;
      this.stage = this.task >= this.plan.tasks.length ? 'done' : 'tasks';
      this.step = null;
      this.cur = { start: s.time, swing: 0, landing: 0, peak: 0, overload: false, hits: 0, lifted: false };
      if (this.stage === 'done') ev.allDone = true;
    }
    return ev;
  }

  /** Is a step of the guide done? */
  private stepDone(step: GuideStep, s: CraneSnapshot, tg: { load: WorldLoad; zone: WorldZone } | null): boolean {
    const st = this.stand;
    switch (step) {
      // (set up somewhere else all the same: the guide goes on from there)
      case 'drive':
        return s.operating || (!!st && Math.hypot(s.vx - st.x, s.vz - st.z) < 16);
      case 'park':
        return s.operating || (this.inStand(s) && Math.abs(s.speed) < 0.2 && s.handbrake);
      case 'operate':
        return s.operating;
      case 'beams':
        return s.beams >= 0.98;
      case 'jacks':
        return this.type === 'loader' ? s.padsDown : s.onOutriggers;
      case 'level':
        return s.onOutriggers && s.incline <= specOf(this.type).levelGood;
      case 'raise':
        return this.type === 'mobile' ? s.luff >= 30 : s.unfolded;
      case 'over':
        return !!tg && Math.hypot(s.head.x - tg.load.x, s.head.z - tg.load.z) < 1.2;
      case 'lower':
        return !!tg && (s.hooked === tg.load.id || Math.hypot(s.hook.x - tg.load.x, s.hook.z - tg.load.z) <= ATTACH_REACH && s.hook.y - (tg.load.y + 2 * tg.load.def.hy) < ATTACH_ABOVE + 1.0);
      case 'attach':
        return !!tg && s.hooked === tg.load.id;
      case 'lift':
        return !!tg && s.hooked === tg.load.id && !s.resting && s.clearance >= 1.5;
      case 'move':
        return !!tg && s.hooked === tg.load.id && Math.hypot(s.hook.x - tg.zone.x, s.hook.z - tg.zone.z) < 2;
      case 'setDown':
        return !!tg && s.hooked === tg.load.id && s.resting && this.over(tg.zone, s.hook.x, s.hook.z);
      case 'release':
        return !!tg && !tg.load.hooked && this.inPlace(tg.load, tg.zone);
    }
  }

  /** whether a point is over a zone (its middle within it) */
  private over(zone: WorldZone, x: number, z: number): boolean {
    if (zone.bed) return true;
    const p = inZone(zone, x, z);
    return Math.abs(p.du) <= zone.hu + 0.3 && Math.abs(p.dw) <= zone.hw + 0.3;
  }

  /**
   * What the player is to do now: the instruction (i18n key and its
   * values) and, under it, a hint for the task now as it stands.
   */
  instruction(s: CraneSnapshot): { key: string; data: Record<string, string | number>; hint: string } {
    const tg = this.target();
    if (this.stage === 'done' || !tg) return { key: 'craneDone', data: {}, hint: '' };
    const data: Record<string, string | number> = { n: this.task + 1, max: this.plan.tasks.length, load: tg.load.def.name, d: specOf(this.type).levelGood };
    if (this.stage === 'guide' && this.step) {
      const key = this.step === 'jacks' && this.type === 'loader' ? 'craneGuide.jacksLoader' : this.step === 'raise' && this.type === 'loader' ? 'craneGuide.unfold' : this.step === 'raise' ? 'craneGuide.raise' : `craneGuide.${this.step}`;
      return { key, data, hint: this.hint(s, tg) };
    }
    return { key: this.plan.tasks[this.task].text, data, hint: this.hint(s, tg) };
  }

  /** A hint for the task as it stands (i18n key; '' none). */
  private hint(s: CraneSnapshot, tg: { load: WorldLoad; zone: WorldZone }): string {
    if (s.tipped) return '';
    if (s.lmi.stop) return 'craneHint.overload';
    if (s.lmi.wind > s.lmi.windLimit) return 'craneHint.wind';
    if (!s.operating) return this.type === 'tower' ? '' : this.stage === 'guide' ? '' : 'craneHint.operate';
    if (s.lmi.notLevel) return 'craneHint.level';
    if (s.hooked && s.hooked !== tg.load.id) return 'craneHint.wrongLoad';
    if (s.hooked === tg.load.id) {
      if (s.resting && this.over(tg.zone, s.hook.x, s.hook.z)) return 'craneHint.release';
      if (s.resting) return 'craneHint.lift';
      if (s.swing > 0.8) return 'craneHint.swing';
      return Math.hypot(s.hook.x - tg.zone.x, s.hook.z - tg.zone.z) < 2 ? 'craneHint.setDown' : 'craneHint.toZone';
    }
    if (Math.hypot(s.hook.x - tg.load.x, s.hook.z - tg.load.z) <= ATTACH_REACH) return 'craneHint.attach';
    return 'craneHint.toLoad';
  }
}
