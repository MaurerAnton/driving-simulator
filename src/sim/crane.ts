// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cranes as the player works them: a tower crane on its cross base, a
 * mobile crane with a telescopic boom on a three-axle carrier, and a loader
 * crane (knuckle boom) behind the cab of a flatbed truck.  This file holds
 * what makes each of them stand and move – pure arithmetic, no drawing
 * (render/crane.ts draws them, game/craneplay.ts runs them):
 *
 *  - their masses and where they sit: carrier, base ballast, mast,
 *    superstructure, counterweight, boom, hook block;
 *  - what they stand on: the four foundation blocks of the tower crane's
 *    cross base, the pads under the outrigger jacks – or the tyres;
 *  - the tipping check: for every line between two neighbouring supports
 *    (a tipping line) the moments that tip the crane over it – the load,
 *    the boom reaching out, the wind and the swing pulling on the rope –
 *    against those that hold it back – carrier, ballast, counterweight;
 *  - the load chart: what may hang on the hook at a radius, a boom length
 *    and an outrigger setting.  For the mobile and the loader crane it is
 *    worked out from that very tipping check, with the classic margins for
 *    mobile cranes (three quarters of the tipping load on outriggers, two
 *    thirds on tyres – and on tyres half of that again, for the give of the
 *    tyres), and capped by what the boom itself may carry; the tower crane's
 *    is that of its jib (its base ballast leaves it far from tipping);
 *  - the load moment limiter (LMI): the load measured on the rope against
 *    the chart – a warning at 90 %, and at 100 % every movement that would
 *    raise the load moment is cut off (hoisting, luffing down, telescoping
 *    or running the trolley out); lowering and coming in always work;
 *  - the drives: each moves at most so fast, gets there with a ramp, stops
 *    at its end stops; outriggers, jacks and the automatic levelling;
 *  - the hook block (with the load slung under it) on its rope: a damped
 *    pendulum on an elastic rope, pushed by the wind, set down on what is
 *    under it, stopped by what it runs into.
 *
 * Frames.  The carrier frame is the vehicle's (render/truck.ts): origin on
 * the ground below the middle of the wheelbase (the tower crane: the middle
 * of its base), x right, y up, z back.  The boom's direction turns with the
 * slewing angle like a yaw: 0 straight ahead (−z), positive to the left.  A
 * part of the superstructure is given along the boom's direction (a, from
 * the slewing axis), to its right (s) and in height (y).  The world: x east,
 * y up, z south; the carrier stands there at `base` turned by `base.yaw`,
 * raised by the jacks (`lift`) and tilted as the ground and the levelling
 * leave it (`tilt`: the rise per metre along its x and z).
 *
 * Units: tonnes (t), metres, seconds; forces in kN, moments in kN·m.
 * Generic cranes of their kinds – no real model is reproduced.
 */
import { TRUCK } from './vehicle/spec.ts';
import type { VehicleSpec } from './vehicle/types.ts';

export type CraneType = 'tower' | 'mobile' | 'loader';
/** what the crane stands on, as the load chart knows it: the outrigger beams fully out, half out, in (on the jacks) – or on its tyres; the tower crane on its base */
export type Setting = 'full' | 'half' | 'zero' | 'tyres' | 'fixed';

export const G = 9.81;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a: number): number => a - TAU * Math.round(a / TAU);

// ------------------------------------------------------------------------------------ stability

/** A weight (t) and where it acts (any frame with y up). */
export interface Weight {
  t: number;
  x: number;
  y: number;
  z: number;
}

/** A sideways force (kN) – the wind, the rope pulled aside by a swinging load – and the height it acts at above the supports. */
export interface SideForce {
  fx: number;
  fz: number;
  y: number;
}

/** The outcome of a tipping check. */
export interface Stability {
  /**
   * the moments that tip the crane over its worst tipping line against
   * those that hold it there: 1 – it tips; Infinity – it stands on fewer
   * than three supports
   */
  u: number;
  /** that line: from support `edge` to the next one of `hull` */
  edge: number;
  /** where the weights and forces press on the ground (the crane stands while this lies inside the supports) */
  copX: number;
  copZ: number;
  /** the supports that bound it, in order round it (x, z) */
  hull: Array<[number, number]>;
}

/** The convex hull of points in the plan (x, z), in order round it; points on its edges dropped. */
export function convexHull(points: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const p = points.map((q): [number, number] => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-9) lower.pop();
    lower.push(q);
  }
  const upper: Array<[number, number]> = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-9) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** The tipping lines of a support polygon: a point on each and its outward normal (x, z). */
function tippingLines(hull: ReadonlyArray<[number, number]>): Array<{ px: number; pz: number; nx: number; nz: number }> {
  let cx = 0;
  let cz = 0;
  for (const [x, z] of hull) {
    cx += x;
    cz += z;
  }
  cx /= hull.length;
  cz /= hull.length;
  const out: Array<{ px: number; pz: number; nx: number; nz: number }> = [];
  for (let i = 0; i < hull.length; i++) {
    const [ax, az] = hull[i];
    const [bx, bz] = hull[(i + 1) % hull.length];
    const l = Math.hypot(bx - ax, bz - az) || 1;
    let nx = (bz - az) / l;
    let nz = -(bx - ax) / l;
    // (outwards: away from the middle)
    if ((ax - cx) * nx + (az - cz) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    out.push({ px: ax, pz: az, nx, nz });
  }
  return out;
}

/**
 * The tipping check: every weight presses down where it is, every sideways
 * force acts at its height; about each tipping line (between neighbouring
 * supports) what lies or pushes beyond it tips the crane over it, what lies
 * inside holds it back.  `supports`: where the crane stands (x, z), at the
 * height the forces' heights are measured from.
 */
export function stability(weights: readonly Weight[], sides: readonly SideForce[], supports: ReadonlyArray<readonly [number, number]>): Stability {
  const hull = convexHull(supports);
  let W = 0;
  let mx = 0;
  let mz = 0;
  for (const w of weights) {
    W += w.t * G;
    mx += w.t * G * w.x;
    mz += w.t * G * w.z;
  }
  // (a sideways force at a height shifts where the whole presses on the ground)
  for (const f of sides) {
    mx += f.fx * f.y;
    mz += f.fz * f.y;
  }
  const copX = W > 0 ? mx / W : 0;
  const copZ = W > 0 ? mz / W : 0;
  if (hull.length < 3) return { u: Infinity, edge: -1, copX, copZ, hull };
  let u = 0;
  let edge = 0;
  const lines = tippingLines(hull);
  lines.forEach((ln, i) => {
    let over = 0;
    let hold = 0;
    for (const w of weights) {
      const m = w.t * G * ((w.x - ln.px) * ln.nx + (w.z - ln.pz) * ln.nz);
      if (m > 0) over += m;
      else hold -= m;
    }
    for (const f of sides) {
      const m = f.y * (f.fx * ln.nx + f.fz * ln.nz);
      if (m > 0) over += m;
      else hold -= m;
    }
    const ui = hold > 1e-9 ? over / hold : over > 0 ? Infinity : 0;
    if (ui > u) {
      u = ui;
      edge = i;
    }
  });
  return { u, edge, copX, copZ, hull };
}

/**
 * The load (t) at (x, z) that just tips the crane over: the least of what
 * each tipping line the load lies beyond can take, the other weights holding
 * the crane back.  0 when it would tip over without a load; Infinity when
 * the load lies within all of them.
 */
export function tippingLoad(weights: readonly Weight[], x: number, z: number, supports: ReadonlyArray<readonly [number, number]>): number {
  const hull = convexHull(supports);
  if (hull.length < 3) return 0;
  let best = Infinity;
  for (const ln of tippingLines(hull)) {
    const arm = (x - ln.px) * ln.nx + (z - ln.pz) * ln.nz;
    let m = 0;
    for (const w of weights) m += w.t * ((w.x - ln.px) * ln.nx + (w.z - ln.pz) * ln.nz);
    if (m >= 0) return 0;
    if (arm <= 1e-6) continue;
    best = Math.min(best, -m / arm);
  }
  return best;
}

// ------------------------------------------------------------------------------------ the cranes

/** A mass of the superstructure: t, along the boom's direction from the slewing axis (a), to its right (s), height (y). */
export interface SlewMass {
  t: number;
  a: number;
  s: number;
  y: number;
}

/** A drive: its range, how fast and how briskly it moves. */
export interface DriveSpec {
  min: number;
  max: number;
  /** full speed (per s) */
  speed: number;
  /** how quickly it gets there or stops (per s²) */
  accel: number;
  /** goes round without end (slewing) */
  endless?: boolean;
}

/** The outriggers: a beam each (its place along the carrier and its side), how far out its pad is, the jacks. */
export interface OutriggerSpec {
  beams: ReadonlyArray<{ z: number; side: -1 | 1 }>;
  /** the pad's distance from the carrier's axis with the beam in and fully out (m) */
  padIn: number;
  padOut: number;
  /** height of the pad's sole above the ground with the jack drawn up (the carrier on its wheels) */
  clearance: number;
  /** the jacks' stroke (m) */
  stroke: number;
  /** the beams move out in this many seconds, the jacks at this speed (m/s) */
  beamTime: number;
  jackSpeed: number;
  /** what the jacks lift the carrier by until its wheels are free (0: the loader crane – its wheels stay on the ground) */
  freeLift: number;
}

/** What is the same for every crane: masses, supports, drives, limits. */
export interface CraneSpec {
  type: CraneType;
  name: string;
  /** the slewing axis in the carrier frame */
  slewX: number;
  slewZ: number;
  /** masses that stay with the carrier or the base: t, x, y, z */
  fixed: readonly Weight[];
  /** masses that turn with the superstructure (the boom's are worked out from its joints) */
  slewing: readonly SlewMass[];
  /** the hook block (t): part of every load the chart allows */
  hook: number;
  /** where the hook hangs, from the rope: the bottom of the hook block below its middle (m) */
  hookDrop: number;
  /** what it stands on without outriggers (the foundation blocks, or the tyres: x, z) */
  feet: ReadonlyArray<readonly [number, number]>;
  outriggers: OutriggerSpec | null;
  /** the strongest wind it may work in (m/s, gusts at the boom head) */
  windLimit: number;
  /** the steepest its carrier may stand at work before the limiter cuts off, and what the levelling brings it within (deg) */
  levelLimit: number;
  levelGood: number;
  /** the slewing drive */
  slew: DriveSpec;
  /** the hoist: rope paid out (m) – null: the hook hangs on a fixed link (the loader crane) */
  hoist: DriveSpec | null;
  /** the rope when there is no hoist (m) */
  link: number;
  /** what the hoist lifts at full speed and at its slowest (t: the speed falls linearly between) */
  hoistLight: number;
  hoistHeavy: number;
}

/** The joints of a crane – each crane uses those it has. */
export interface Joints {
  /** turned to the left of straight ahead (rad) */
  slew: number;
  /** the tower crane: the trolley's distance from the tower's axis (m) */
  trolley: number;
  /** the mobile crane: the boom's angle above the horizontal (rad), its telescopes out (0 … 1) */
  luff: number;
  tele: number;
  /** the loader crane: the inner boom's angle above the horizontal, the outer boom's against the inner one (rad), the extensions out (0 … 1) */
  inner: number;
  outer: number;
  ext: number;
  /** rope paid out below the boom head or the trolley (m) */
  rope: number;
}

export type JointKey = keyof Joints;

// ---- the tower crane

/** The tower crane's jib: where it is and what it may lift (its chart: 6 t up to 16 m, 1.6 t at the tip). */
export interface TowerGeometry {
  /** height of the trolley's sheaves the rope hangs from (m) */
  sheave: number;
  /** the trolley: its range (m from the axis) */
  trolleyMin: number;
  trolleyMax: number;
  jibLength: number;
  counterJib: number;
  /** the slewing ring's height (the top of the mast) */
  mastTop: number;
  /** the mast's width (m) */
  mastWidth: number;
  /** the chart: at most maxLoad (t); beyond that moment / r − loss */
  maxLoad: number;
  moment: number;
  loss: number;
  trolleyMass: number;
}

export const TOWER_GEOMETRY: TowerGeometry = {
  sheave: 31.0,
  trolleyMin: 2.5,
  trolleyMax: 48.5,
  jibLength: 50,
  counterJib: 15,
  mastTop: 30.0,
  mastWidth: 1.7,
  maxLoad: 6,
  // 6 t at 16 m, 1.6 t at 48.5 m
  moment: 105.06,
  loss: 0.566,
  trolleyMass: 0.4,
};

/**
 * A top-slewing tower crane, 50 m jib, 6 t: on a cross base of 5 × 5 m on
 * four foundation blocks, 40 t of ballast blocks on it; the mast of lattice
 * sections 30 m high; on top the slewing platform with the cab, the tower
 * head with the pendant ties, the jib, the counter-jib with its 15 t of
 * ballast blocks and the hoist winch.
 */
export const TOWER_CRANE: CraneSpec = {
  type: 'tower',
  name: 'Turmdrehkran 50 m, 6 t',
  slewX: 0,
  slewZ: 0,
  fixed: [
    { t: 6, x: 0, y: 0.5, z: 0 }, // the cross base
    { t: 40, x: 0, y: 1.4, z: 0 }, // the central ballast
    { t: 18, x: 0, y: 15, z: 0 }, // the mast
  ],
  slewing: [
    { t: 5, a: 0, s: 0, y: 30.6 }, // slewing ring, platform, cab
    { t: 3, a: 0, s: 0, y: 34.5 }, // the tower head
    { t: 11, a: 22, s: 0, y: 31.6 }, // the jib
    { t: 3.5, a: -7, s: 0, y: 31.2 }, // the counter-jib
    { t: 15, a: -13.5, s: 0, y: 31.0 }, // its ballast blocks
    { t: 2.5, a: -9, s: 0, y: 31.8 }, // the hoist winch
  ],
  hook: 0.35,
  hookDrop: 1.05,
  feet: [
    [-2.5, -2.5],
    [2.5, -2.5],
    [2.5, 2.5],
    [-2.5, 2.5],
  ],
  outriggers: null,
  windLimit: 20,
  levelLimit: 90,
  levelGood: 90,
  // 0.8 rpm
  slew: { min: -Infinity, max: Infinity, speed: 0.084, accel: 0.035, endless: true },
  hoist: { min: 1.6, max: 36, speed: 1.0, accel: 0.8 },
  link: 0,
  hoistLight: 1,
  hoistHeavy: 6,
};

// ---- the mobile crane

/** The mobile crane's boom: where its foot is, how long it gets, how steep, what it may carry by its length. */
export interface MobileGeometry {
  /** the boom's foot pin: behind the slewing axis (a) and its height above the ground with the carrier on its wheels */
  footA: number;
  footY: number;
  /** the boom fully in and fully out (m), and how far the head's sheaves reach beyond its end */
  length0: number;
  length1: number;
  head: number;
  /** the steepest it may be raised (rad) */
  luffMax: number;
  /** the luffing cylinder: where it sits on the turntable (a, y) and on the boom (m from the foot) */
  cylA: number;
  cylY: number;
  cylOnBoom: number;
  /** the boom's weight (t) and its centre (share of its length from the foot, plus metres) */
  boomMass: number;
  boomCg: number;
  boomCgPlus: number;
  /** what the boom itself may carry at each length of the chart (t), and the moment its pin and cylinder take (t·m) */
  lengths: readonly number[];
  strength: readonly number[];
  moment: number;
}

export const MOBILE_GEOMETRY: MobileGeometry = {
  footA: -0.9,
  footY: 2.85,
  length0: 9.6,
  length1: 34,
  head: 0.45,
  luffMax: 82 * DEG,
  cylA: 1.05,
  cylY: 1.95,
  cylOnBoom: 3.9,
  boomMass: 5.6,
  boomCg: 0.4,
  boomCgPlus: 0.3,
  lengths: [9.6, 14.48, 19.36, 24.24, 29.12, 34],
  strength: [40, 32, 25, 18, 13, 9.5],
  moment: 130,
};

/** The three axles of the mobile crane (z) and half its track over the tyres' outer flanks. */
export const MOBILE_AXLES = [-1.75, 0.95, 2.55];
export const MOBILE_TYRE_EDGE = 1.24;

/**
 * A mobile crane of 40 t on a three-axle carrier, 37 t as it drives: the
 * carrier (19.5 t), the superstructure with the crane cab and the hoist
 * (4.5 t), 7 t of counterweight, a boom of four sections from 9.6 to 34 m
 * (5.6 t), a hook block of 0.4 t.  Four outrigger beams – just behind the
 * driver's cab and at the rear – put its pads 6 m apart across, 6.9 m along.
 */
export const MOBILE_CRANE: CraneSpec = {
  type: 'mobile',
  name: 'Mobilkran 40 t, 3 Achsen',
  slewX: 0,
  slewZ: 1.75,
  fixed: [{ t: 19.5, x: 0, y: 1.25, z: -0.3 }],
  slewing: [
    { t: 4.5, a: -0.6, s: 0, y: 2.4 }, // turntable, superstructure, cab, winch
    { t: 7, a: -3.3, s: 0, y: 2.3 }, // the counterweight
  ],
  hook: 0.4,
  hookDrop: 1.15,
  feet: MOBILE_AXLES.flatMap((z): Array<[number, number]> => [
    [-MOBILE_TYRE_EDGE, z],
    [MOBILE_TYRE_EDGE, z],
  ]),
  outriggers: {
    beams: [
      { z: -2.75, side: -1 },
      { z: -2.75, side: 1 },
      { z: 4.15, side: -1 },
      { z: 4.15, side: 1 },
    ],
    padIn: 1.2,
    padOut: 3.0,
    clearance: 0.55,
    stroke: 0.9,
    beamTime: 14,
    jackSpeed: 0.07,
    freeLift: 0.16,
  },
  windLimit: 13,
  levelLimit: 1,
  levelGood: 0.3,
  // 2 rpm
  slew: { min: -Infinity, max: Infinity, speed: 0.21, accel: 0.12, endless: true },
  hoist: { min: 1.6, max: 42, speed: 0.7, accel: 0.8 },
  link: 0,
  hoistLight: 1,
  hoistHeavy: 20,
};

// ---- the loader crane

/** The loader crane's booms: the column's pin, the inner boom, the outer boom with its extensions, the hook's link, what it may lift. */
export interface LoaderGeometry {
  /** the inner boom's pin on the column: ahead of the slewing axis (a) and its height */
  pinA: number;
  pinY: number;
  inner: number;
  /** the outer boom in and fully extended (m) */
  outer0: number;
  outer1: number;
  innerMin: number;
  innerMax: number;
  outerMin: number;
  outerMax: number;
  /** the folded position it travels in */
  stowInner: number;
  stowOuter: number;
  /** the lifting moment (t·m) and the most it lifts close in (t) */
  moment: number;
  maxLoad: number;
  innerMass: number;
  outerMass: number;
}

export const LOADER_GEOMETRY: LoaderGeometry = {
  pinA: 0.15,
  pinY: 1.95,
  inner: 2.15,
  outer0: 2.7,
  outer1: 7.95,
  innerMin: -10 * DEG,
  innerMax: 80 * DEG,
  outerMin: -170 * DEG,
  outerMax: 15 * DEG,
  stowInner: 78 * DEG,
  stowOuter: -166 * DEG,
  moment: 14,
  maxLoad: 4.5,
  innerMass: 0.45,
  outerMass: 0.65,
};

/** The loader truck's axles (z) and half its track over the tyres' outer flanks, front and rear (twin tyres). */
export const LOADER_AXLES = [-2.4, 2.4];
export const LOADER_TYRE_EDGE = [1.18, 1.25];
/** where the flatbed lies on the loader truck: from z0 to z1, half its width, its floor's height */
export const LOADER_BED = { z0: -0.85, z1: 5.2, hw: 1.22, y: 1.28 };

/**
 * A loader crane of 14 t·m behind the cab of a two-axle flatbed truck: on
 * its base the outrigger beams left and right, the column turning on it,
 * the inner boom on the lift cylinder, the outer boom on the folding
 * cylinder with three hydraulic extensions, the hook on a short link.
 */
export const LOADER_CRANE: CraneSpec = {
  type: 'loader',
  name: 'Lkw-Ladekran 14 tm',
  slewX: 0,
  slewZ: -1.45,
  fixed: [
    { t: 9.6, x: 0, y: 1.1, z: 0.7 }, // the truck with its flatbed
    { t: 0.9, x: 0, y: 1.3, z: -1.45 }, // the crane's base with its outriggers
  ],
  slewing: [{ t: 0.35, a: 0, s: 0, y: 1.7 }],
  hook: 0.05,
  hookDrop: 0.62,
  feet: [
    [-LOADER_TYRE_EDGE[0], LOADER_AXLES[0]],
    [LOADER_TYRE_EDGE[0], LOADER_AXLES[0]],
    [-LOADER_TYRE_EDGE[1], LOADER_AXLES[1]],
    [LOADER_TYRE_EDGE[1], LOADER_AXLES[1]],
  ],
  outriggers: {
    beams: [
      { z: -1.45, side: -1 },
      { z: -1.45, side: 1 },
    ],
    padIn: 1.2,
    padOut: 2.6,
    clearance: 0.5,
    stroke: 0.7,
    beamTime: 6,
    jackSpeed: 0.09,
    freeLift: 0,
  },
  windLimit: 12.5,
  levelLimit: 3,
  levelGood: 1,
  slew: { min: -200 * DEG, max: 200 * DEG, speed: 0.25, accel: 0.25 },
  hoist: null,
  link: 0.9,
  hoistLight: 1,
  hoistHeavy: 1,
};

export function specOf(type: CraneType): CraneSpec {
  return type === 'tower' ? TOWER_CRANE : type === 'mobile' ? MOBILE_CRANE : LOADER_CRANE;
}

// ---- driving them

/**
 * The mobile crane as it drives: 37 t on three axles (the physics knows two:
 * the first, and one in the middle of the other two), a diesel of 370 kW,
 * an automated gearbox, governed at 80 km/h.
 */
export const MOBILE_CRANE_SPEC: VehicleSpec = {
  ...TRUCK,
  name: 'Mobilkran 40 t, 3 Achsen, 370 kW',
  mass: 37000,
  inertia: [235000, 225000, 52000],
  wheelbase: 3.5,
  track: 2.08,
  cgHeight: 1.45,
  // a third of the weight on the front axle
  cgToFront: 2.33,
  wheelRadius: 0.69,
  wheelInertia: 40,
  springRate: [640000, 1280000],
  damperBump: [34000, 52000],
  damperRebound: [60000, 90000],
  antiRoll: [420000, 420000],
  torqueCurve: TRUCK.torqueCurve.map(([rpm, t]): [number, number] => [rpm, Math.round(t * 2.1)]),
  finalDrive: 5.6,
  clutchTorque: 6000,
  brakeTorque: 165000,
  handbrakeTorque: 150000,
  maxWheelAngle: 0.62,
  dragArea: 7.5,
  length: 11.6,
  width: 2.55,
  bodyPoints: [
    [-1.27, 0.55, -3.95],
    [1.27, 0.55, -3.95],
    [-1.27, 0.55, 4.6],
    [1.27, 0.55, 4.6],
    [-1.27, 3.3, -3.95],
    [1.27, 3.3, -3.95],
    [-1.27, 3.4, 4.6],
    [1.27, 3.4, 4.6],
  ],
};

/** The flatbed truck with its loader crane: 13 t, two axles, 210 kW. */
export const LOADER_TRUCK_SPEC: VehicleSpec = {
  ...TRUCK,
  name: 'Lkw mit Ladekran 18 t, 2 Achsen, 210 kW',
  mass: 13000,
  inertia: [82000, 79000, 17000],
  wheelbase: 4.8,
  track: 2.04,
  cgHeight: 1.3,
  cgToFront: 2.2,
  wheelRadius: 0.5,
  springRate: [240000, 300000],
  damperBump: [12500, 16000],
  damperRebound: [22000, 28000],
  antiRoll: [150000, 110000],
  torqueCurve: TRUCK.torqueCurve.map(([rpm, t]): [number, number] => [rpm, Math.round(t * 1.18)]),
  brakeTorque: 56000,
  handbrakeTorque: 50000,
  length: 9.15,
  width: 2.55,
  bodyPoints: [
    [-1.25, 0.6, -3.9],
    [1.25, 0.6, -3.9],
    [-1.25, 0.6, 5.25],
    [1.25, 0.6, 5.25],
    [-1.2, 3.1, -3.9],
    [1.2, 3.1, -3.9],
    [-1.25, 1.9, 5.25],
    [1.25, 1.9, 5.25],
  ],
};

// ------------------------------------------------------------------------------------ kinematics

/** The direction the boom points in the carrier frame (x, z) for a slewing angle. */
export function boomDir(slew: number): [number, number] {
  return [-Math.sin(slew), -Math.cos(slew)];
}

/** The mobile crane's boom length for how far its telescopes are out. */
export function boomLength(tele: number): number {
  const g = MOBILE_GEOMETRY;
  return g.length0 + clamp(tele, 0, 1) * (g.length1 - g.length0);
}

/** The loader crane's outer boom length for how far its extensions are out. */
export function outerLength(ext: number): number {
  const g = LOADER_GEOMETRY;
  return g.outer0 + clamp(ext, 0, 1) * (g.outer1 - g.outer0);
}

/**
 * Where the rope hangs from – the trolley's sheaves, the boom head, the end
 * of the loader crane's outer boom: along the boom's direction from the
 * slewing axis (a, the radius) and above the ground (y), the carrier on its
 * wheels.
 */
export function headOf(type: CraneType, q: Joints): { a: number; y: number } {
  if (type === 'tower') return { a: q.trolley, y: TOWER_GEOMETRY.sheave };
  if (type === 'mobile') {
    const g = MOBILE_GEOMETRY;
    const l = boomLength(q.tele) + g.head;
    return { a: g.footA + l * Math.cos(q.luff), y: g.footY + l * Math.sin(q.luff) };
  }
  const g = LOADER_GEOMETRY;
  const o = q.inner + q.outer;
  const l2 = outerLength(q.ext);
  return { a: g.pinA + g.inner * Math.cos(q.inner) + l2 * Math.cos(o), y: g.pinY + g.inner * Math.sin(q.inner) + l2 * Math.sin(o) };
}

/** The boom's own masses for these joints (the trolley, the boom, the inner and outer boom): t, a, y. */
export function boomMasses(type: CraneType, q: Joints): SlewMass[] {
  if (type === 'tower') return [{ t: TOWER_GEOMETRY.trolleyMass, a: q.trolley, s: 0, y: TOWER_GEOMETRY.sheave + 0.3 }];
  if (type === 'mobile') {
    const g = MOBILE_GEOMETRY;
    const d = g.boomCg * boomLength(q.tele) + g.boomCgPlus;
    return [{ t: g.boomMass, a: g.footA + d * Math.cos(q.luff), s: 0, y: g.footY + d * Math.sin(q.luff) }];
  }
  const g = LOADER_GEOMETRY;
  const kx = g.pinA + g.inner * Math.cos(q.inner);
  const ky = g.pinY + g.inner * Math.sin(q.inner);
  const o = q.inner + q.outer;
  const half = outerLength(q.ext) * 0.45;
  return [
    { t: g.innerMass, a: g.pinA + (g.inner / 2) * Math.cos(q.inner), s: 0, y: g.pinY + (g.inner / 2) * Math.sin(q.inner) },
    { t: g.outerMass, a: kx + half * Math.cos(o), s: 0, y: ky + half * Math.sin(o) },
  ];
}

// ------------------------------------------------------------------------------------ the load charts

/** A load chart: the rated capacity (t, the hook block included) by setting, boom length (columns) and radius (rows). */
export interface LoadChart {
  /** the boom lengths of its columns (one column: it does not depend on a length) */
  lengths: readonly number[];
  radii: readonly number[];
  t: Partial<Record<Setting, number[][]>>;
}

/** the margin below the tipping load on outriggers and on tyres – and on tyres half of that again (the tyres give) */
export const MARGIN_OUTRIGGERS = 0.75;
export const MARGIN_TYRES = 0.667;
export const TYRES_DERATE = 0.5;

/** What the crane stands on in a setting: the pads with the beams that far out, or its feet (tyres, foundation blocks). */
export function supportsFor(spec: CraneSpec, setting: Setting): Array<[number, number]> {
  const o = spec.outriggers;
  if (!o || setting === 'tyres' || setting === 'fixed') return spec.feet.map((f): [number, number] => [f[0], f[1]]);
  const e = setting === 'full' ? 1 : setting === 'half' ? 0.5 : 0;
  const pads = o.beams.map((b): [number, number] => [b.side * (o.padIn + e * (o.padOut - o.padIn)), b.z]);
  // (the loader crane's wheels stay on the ground beside its two pads)
  return spec.type === 'loader' ? [...pads, ...spec.feet.map((f): [number, number] => [f[0], f[1]])] : pads;
}

/** The weights of a crane for its joints, in the carrier frame (without the hook and the load). */
export function craneWeights(spec: CraneSpec, q: Joints, extra: readonly Weight[] = []): Weight[] {
  const out: Weight[] = spec.fixed.map((w) => ({ ...w }));
  const [dx, dz] = boomDir(q.slew);
  const add = (m: SlewMass): void => {
    // (right of the boom's direction (dx, dz) is (−dz, dx))
    out.push({ t: m.t, x: spec.slewX + m.a * dx - m.s * dz, y: m.y, z: spec.slewZ + m.a * dz + m.s * dx });
  };
  for (const m of spec.slewing) add(m);
  for (const m of boomMasses(spec.type, q)) add(m);
  out.push(...extra);
  return out;
}

function joints(over: Partial<Joints> = {}): Joints {
  return { slew: 0, trolley: TOWER_GEOMETRY.trolleyMin, luff: 0, tele: 0, inner: LOADER_GEOMETRY.stowInner, outer: LOADER_GEOMETRY.stowOuter, ext: 0, rope: 2, ...over };
}

/** The tower crane's chart: 6 t up to 16 m, then what its jib may carry at the radius. */
export function towerCapacity(r: number): number {
  const g = TOWER_GEOMETRY;
  return clamp(Math.min(g.maxLoad, g.moment / Math.max(r, 1) - g.loss), 0, g.maxLoad);
}

const MOBILE_RADII = [3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32];
const LOADER_RADII = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5];
/** slewing directions the 360° charts are checked in */
const DIRECTIONS = 72;

/**
 * The mobile crane's chart for a setting: at each boom length and radius
 * the tipping load in the worst slewing direction, times the margin, at
 * most what the boom may carry at that length and radius.  Radii it cannot reach at a
 * length (too far, or closer in than its steepest) are 0.
 */
function mobileChart(setting: Setting): number[][] {
  const g = MOBILE_GEOMETRY;
  const sp = MOBILE_CRANE;
  const sup = supportsFor(sp, setting);
  const margin = setting === 'tyres' ? MARGIN_TYRES * TYRES_DERATE : MARGIN_OUTRIGGERS;
  return g.lengths.map((L, li) =>
    MOBILE_RADII.map((R) => {
      const l = L + g.head;
      const c = (R - g.footA) / l;
      if (c > 1 || c < Math.cos(g.luffMax)) return 0;
      const luff = Math.acos(c);
      const tele = (L - g.length0) / (g.length1 - g.length0);
      let tip = Infinity;
      for (let k = 0; k < DIRECTIONS; k++) {
        const q = joints({ slew: (k / DIRECTIONS) * TAU, luff, tele });
        const [dx, dz] = boomDir(q.slew);
        tip = Math.min(tip, tippingLoad(craneWeights(sp, q), sp.slewX + R * dx, sp.slewZ + R * dz, sup));
      }
      return Math.max(0, Math.floor(Math.min(g.strength[li], g.moment / R, margin * tip) * 20) / 20);
    }),
  );
}

/**
 * The loader crane's chart for a setting: its lifting moment (at most its
 * greatest load close in), and – in the worst slewing direction, the outer
 * boom out level at the radius – the tipping load times the margin.
 */
function loaderChart(setting: Setting): number[][] {
  const g = LOADER_GEOMETRY;
  const sp = LOADER_CRANE;
  const sup = supportsFor(sp, setting);
  const margin = setting === 'tyres' ? MARGIN_TYRES * TYRES_DERATE : MARGIN_OUTRIGGERS;
  return [
    LOADER_RADII.map((R) => {
      // the booms reaching out level at that radius: the inner boom a little up, the outer boom level, out as far as needed
      const inner = 20 * DEG;
      const reach = R - g.pinA - g.inner * Math.cos(inner);
      const ext = clamp((reach - g.outer0) / (g.outer1 - g.outer0), 0, 1);
      const q = joints({ inner, outer: -inner, ext });
      let tip = Infinity;
      for (let k = 0; k < DIRECTIONS; k++) {
        const qq = { ...q, slew: (k / DIRECTIONS) * TAU };
        const [dx, dz] = boomDir(qq.slew);
        tip = Math.min(tip, tippingLoad(craneWeights(sp, qq), sp.slewX + R * dx, sp.slewZ + R * dz, sup));
      }
      const structural = Math.min(g.maxLoad, g.moment / R);
      return Math.max(0, Math.floor(Math.min(structural, margin * tip) * 20) / 20);
    }),
  ];
}

let charts: Partial<Record<CraneType, LoadChart>> = {};

/** The load chart of a crane (worked out the first time it is asked for). */
export function chartOf(type: CraneType): LoadChart {
  const known = charts[type];
  if (known) return known;
  let c: LoadChart;
  if (type === 'tower') {
    const radii: number[] = [];
    for (let r = 2.5; r <= 50; r += 2.5) radii.push(r);
    c = { lengths: [0], radii, t: { fixed: [radii.map(towerCapacity)] } };
  } else if (type === 'mobile') {
    c = { lengths: MOBILE_GEOMETRY.lengths, radii: MOBILE_RADII, t: { full: mobileChart('full'), half: mobileChart('half'), zero: mobileChart('zero'), tyres: mobileChart('tyres') } };
  } else {
    c = { lengths: [0], radii: LOADER_RADII, t: { full: loaderChart('full'), half: loaderChart('half'), zero: loaderChart('zero'), tyres: loaderChart('tyres') } };
  }
  charts = { ...charts, [type]: c };
  return c;
}

/**
 * What the chart allows (t) at a radius and boom length in a setting:
 * between its rows and columns straight between the neighbours; closer in
 * than its first radius as at that radius, beyond its last – nothing.
 */
export function capacity(type: CraneType, setting: Setting, radius: number, length = 0): number {
  if (type === 'tower') return towerCapacity(radius);
  const c = chartOf(type);
  const table = c.t[setting];
  if (!table) return 0;
  const rs = c.radii;
  const atLength = (col: number[]): number => {
    if (radius <= rs[0]) {
      // (closer in than the first radius: as at the first one it may reach)
      for (const v of col) if (v > 0) return v;
      return 0;
    }
    if (radius > rs[rs.length - 1]) return 0;
    let i = 1;
    while (rs[i] < radius) i++;
    const a = col[i - 1];
    const b = col[i];
    // (a radius closer in than it can reach at this length: as at the first it reaches)
    if (a === 0 && b > 0) return b;
    const k = (radius - rs[i - 1]) / (rs[i] - rs[i - 1]);
    return a + (b - a) * k;
  };
  const ls = c.lengths;
  if (ls.length === 1) return atLength(table[0]);
  if (length <= ls[0]) return atLength(table[0]);
  if (length >= ls[ls.length - 1]) return atLength(table[ls.length - 1]);
  let j = 1;
  while (ls[j] < length) j++;
  const k = (length - ls[j - 1]) / (ls[j] - ls[j - 1]);
  const a = atLength(table[j - 1]);
  const b = atLength(table[j]);
  // (a radius one length can reach and the next not: what the one allows, nearing nothing)
  return a + (b - a) * k;
}

// ------------------------------------------------------------------------------------ wind

/** The wind at a height above the ground from the mean wind 10 m up (m/s): it grows with the height (open country). */
export function windAtHeight(wind10: number, height: number): number {
  return Math.max(0, wind10) * Math.pow(Math.max(2, height) / 10, 0.16);
}

/**
 * The wind just now against its mean: between the mean (1) and the
 * strongest gusts (`peak`, their ratio to the mean), wandering slowly.
 */
export function gust(t: number, peak = 1.4): number {
  const g = 0.5 + 0.3 * Math.sin(t * 0.37) + 0.15 * Math.sin(t * 1.13 + 1) + 0.05 * Math.sin(t * 2.9 + 2);
  return 1 + (Math.max(1, peak) - 1) * Math.max(0, Math.min(1, g));
}

// ------------------------------------------------------------------------------------ the world round the hook

/** A solid box in the world (axis-aligned): what the hook and the load must not pass through. */
export interface Box3 {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

/** What the crane needs to know of its surroundings. */
export interface CraneWorld {
  /**
   * The highest surface a body of half-size (hx, hz) at (x, z) can rest on,
   * at most a little above `y` (the ground, a floor slab, a truck's bed,
   * another load) – the world's height.
   */
  floor(x: number, z: number, hx: number, hz: number, y: number): number;
  /** solid boxes the hook and the load stop at */
  boxes(): readonly Box3[];
  /** the ground's height (for the outriggers' pads) */
  ground(x: number, z: number): number;
  /** the mean wind 10 m above the ground (m/s, the direction it blows to: x, z), and its strongest gusts against it (≥ 1) */
  wind(): { x: number; z: number; gust: number };
}

/** A load as the crane takes it on the hook: how heavy, how big (half-sizes), the slings' length, how it is turned. */
export interface HookLoad {
  id: string;
  t: number;
  hx: number;
  hy: number;
  hz: number;
  sling: number;
  yaw: number;
  /** its area facing the wind (m²) */
  area: number;
}

/** The commands from the controls: the four axes of the two master switches (−1 … 1), and what is held of the set-up. */
export interface CraneCommand {
  /** slewing: + to the left */
  slew: number;
  /** the left switch's other axis: hoist (+ up) – on the loader crane its inner boom (+ up) */
  hoist: number;
  /** the right switch, forward: luffing (+ up), the tower crane's trolley (+ out), the loader crane's outer boom (+ up) */
  boom: number;
  /** the right switch, sideways: telescoping (+ out), the loader crane's extensions (+ out) */
  tele: number;
  /** creep speed for every drive */
  fine: boolean;
  /** held: outrigger beams out (+1) or in (−1); jacks down (+1) or up (−1); levelling */
  beams: number;
  jacks: number;
  level: boolean;
}

export function noCommand(): CraneCommand {
  return { slew: 0, hoist: 0, boom: 0, tele: 0, fine: false, beams: 0, jacks: 0, level: false };
}

/** What the load moment limiter shows and decides. */
export interface Lmi {
  /** the load on the rope, measured (t: hook block and load) */
  load: number;
  /** what the chart allows here and now (t) */
  capacity: number;
  /** load / capacity (0 … ) */
  ratio: number;
  /** from the slewing axis to the hook (m) */
  radius: number;
  /** the boom: its length (m), its angle (deg) – the loader crane's inner boom's */
  length: number;
  angle: number;
  /** the hook's height above the ground below it (m) */
  hookHeight: number;
  setting: Setting;
  /** the wind at the boom head (m/s, with its gusts) and what the crane may work in */
  wind: number;
  windLimit: number;
  /** the carrier's slope (deg) */
  incline: number;
  /** the tipping check: 1 – it tips */
  tipping: number;
  /** ≥ 90 %: the warning; ≥ 100 %: what raises the load moment is cut off */
  warn: boolean;
  stop: boolean;
  /** the carrier is not level enough to work (steeper than its crane's levelLimit), and what the levelling should bring it within (deg) */
  notLevel: boolean;
  levelGood: number;
}


interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** what happened in a step, for the game to judge and show */
export interface CraneEvents {
  /** the hook or the load ran into something this fast (m/s; 0: nothing) */
  hit: number;
  /** the load came down on something this fast (m/s; 0: it did not) */
  landed: number;
  /** the load came off what it stood on (it hangs now) */
  liftedOff: boolean;
  /** the limiter cut off a movement */
  cut: boolean;
}

/** The rope's give: how far it stretches under the weight it holds (m), and how much of its spring is damped. */
const STRETCH = 0.08;
const ROPE_DAMPING = 0.45;
/** the air's damping of the swing (per s) and the drag on a load (ρ·Cd/2) */
const AIR = 0.05;
const DRAG = 0.72;

/**
 * A crane at work.  It stands where it was put (`place`), the controls
 * move its drives (`command`, then `step`), and the hook block swings on
 * the rope below them – with a load slung under it once one is attached.
 */
export class Crane {
  readonly spec: CraneSpec;
  readonly type: CraneType;
  readonly q: Joints;
  /** the drives' speeds just now (per s) */
  readonly v: Record<JointKey, number> = { slew: 0, trolley: 0, luff: 0, tele: 0, inner: 0, outer: 0, ext: 0, rope: 0 };
  /** where it stands: its origin in the world, turned by yaw */
  readonly base = { x: 0, y: 0, z: 0, yaw: 0 };
  /** the ground's slope under the carrier on its wheels (rise per metre along its x and z) */
  readonly terrain = { gx: 0, gz: 0 };
  /** the outrigger beams out (0 … 1) and the jacks' strokes (m), beam by beam */
  readonly beams: number[];
  readonly jacks: number[];
  /** the levelling: what the jacks put right of the slope (rise per metre along x and z) */
  readonly levelFix = { gx: 0, gz: 0 };
  /** the ground under each pad: its height against the carrier's ground plane on its wheels (m) */
  readonly padGround: number[];
  /** the carrier lifted off its wheels by the jacks (m) – the middle of the support */
  lift = 0;
  /** the hook block (with the load) */
  readonly hook: Body = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  /** the load on the hook (null: none) */
  load: HookLoad | null = null;
  /** the load (or the hook block) stands on something */
  resting = false;
  /** the rope's pull just now (kN), and as the limiter measures it: smoothed – and quickly while the load still stands, so that an overload is cut off before it leaves the ground */
  tension = 0;
  private measured = 0;
  private quick = 0;
  readonly lmi: Lmi;
  /** what the drives are told */
  readonly cmd: CraneCommand = noCommand();
  readonly events: CraneEvents = { hit: 0, landed: 0, liftedOff: false, cut: false };
  /** it has tipped over (and lies there): the line it went over in the carrier frame and how far it has turned (rad) */
  tipped: { px: number; pz: number; nx: number; nz: number; angle: number; rate: number } | null = null;
  /** how long it has been beyond tipping */
  private overT = 0;
  /** the swing just now: how far the hook is off the plumb line below its head (m) */
  swing = 0;
  /** the clearance below the hook or its load (m) */
  clearance = 0;
  /** how much longer the rope is than the way from the head to the hook (m; < 0: it is stretched) */
  slack = 0;
  time = 0;
  /** the head (where the rope hangs) in the world, and how fast it moves */
  readonly head = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  /** the limiter's cut-off is on (it lets go again a little below 100 %) */
  private cutting = false;

  constructor(type: CraneType) {
    this.type = type;
    this.spec = specOf(type);
    const o = this.spec.outriggers;
    this.beams = o ? o.beams.map(() => 0) : [];
    this.jacks = o ? o.beams.map(() => 0) : [];
    this.padGround = o ? o.beams.map(() => 0) : [];
    this.q = joints({ rope: type === 'loader' ? this.spec.link : type === 'tower' ? 12 : (this.spec.hoist as DriveSpec).min });
    if (type === 'tower') this.q.trolley = 14;
    this.lmi = { load: 0, capacity: 0, ratio: 0, radius: 0, length: 0, angle: 0, hookHeight: 0, setting: type === 'tower' ? 'fixed' : 'tyres', wind: 0, windLimit: this.spec.windLimit, incline: 0, tipping: 0, warn: false, stop: false, notLevel: false, levelGood: this.spec.levelGood };
  }

  // ---------------------------------------------------------------------------- where it stands

  /**
   * Put the crane where its carrier stands (the vehicle's model origin,
   * heading, and the slope it stands on) and the hook block hanging at rest
   * below the head.
   */
  place(x: number, y: number, z: number, yaw: number, gx = 0, gz = 0): void {
    this.base.x = x;
    this.base.y = y;
    this.base.z = z;
    this.base.yaw = yaw;
    this.terrain.gx = gx;
    this.terrain.gz = gz;
    this.headWorld(this.head);
    this.head.vx = this.head.vy = this.head.vz = 0;
    const h = this.hook;
    h.x = this.head.x;
    h.z = this.head.z;
    h.y = this.head.y - this.q.rope;
    h.vx = h.vy = h.vz = 0;
  }

  /** A point of the carrier frame in the world. */
  toWorld(x: number, y: number, z: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const b = this.base;
    const c = Math.cos(b.yaw);
    const s = Math.sin(b.yaw);
    const t = this.tilt();
    out.x = b.x + x * c + z * s;
    out.z = b.z - x * s + z * c;
    out.y = b.y + this.lift + y + t.gx * x + t.gz * z;
    return out;
  }

  /** A place of the world in the carrier's plan (x, z). */
  toCarrier(x: number, z: number): [number, number] {
    const b = this.base;
    const c = Math.cos(b.yaw);
    const s = Math.sin(b.yaw);
    const dx = x - b.x;
    const dz = z - b.z;
    return [dx * c - dz * s, dx * s + dz * c];
  }

  /** The carrier's slope as it stands now: the ground's, put right by the levelling (rise per metre). */
  tilt(): { gx: number; gz: number } {
    return { gx: this.terrain.gx + this.levelFix.gx, gz: this.terrain.gz + this.levelFix.gz };
  }

  /** The carrier's slope in degrees. */
  incline(): number {
    const t = this.tilt();
    return Math.atan(Math.hypot(t.gx, t.gz)) / DEG;
  }

  /** The head the rope hangs from, in the world. */
  headWorld(out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const h = headOf(this.type, this.q);
    const [dx, dz] = boomDir(this.q.slew);
    return this.toWorld(this.spec.slewX + h.a * dx, h.y, this.spec.slewZ + h.a * dz, out);
  }

  /** The radius: from the slewing axis to the hook (m). */
  radius(): number {
    const [x, z] = this.toCarrier(this.hook.x, this.hook.z);
    return Math.hypot(x - this.spec.slewX, z - this.spec.slewZ);
  }

  // ---------------------------------------------------------------------------- the outriggers

  /** Every jack's pad stands on the ground. */
  padsDown(world: CraneWorld): boolean {
    const o = this.spec.outriggers;
    if (!o) return true;
    return this.jacks.every((j, i) => j >= this.gap(i, world) - 0.005);
  }

  /** How far jack `i` must go down until its pad stands on the ground (m), the carrier on its wheels. */
  gap(i: number, world: CraneWorld): number {
    const o = this.spec.outriggers as OutriggerSpec;
    const b = o.beams[i];
    const x = b.side * (o.padIn + this.beams[i] * (o.padOut - o.padIn));
    const p = this.toWorldFlat(x, b.z);
    const ground = world.ground(p.x, p.z);
    const carrier = this.base.y + this.terrain.gx * x + this.terrain.gz * b.z;
    const under = Number.isFinite(ground) ? clamp(ground - carrier, -o.stroke, o.clearance) : 0;
    this.padGround[i] = under;
    return clamp(o.clearance - under, 0, o.stroke);
  }

  private readonly flat = { x: 0, y: 0, z: 0 };
  private toWorldFlat(x: number, z: number): { x: number; y: number; z: number } {
    const b = this.base;
    const c = Math.cos(b.yaw);
    const s = Math.sin(b.yaw);
    this.flat.x = b.x + x * c + z * s;
    this.flat.z = b.z - x * s + z * c;
    this.flat.y = b.y;
    return this.flat;
  }

  /** The beams' least extension: what the chart goes by. */
  beamSetting(): number {
    return this.beams.length ? Math.min(...this.beams) : 0;
  }

  /** The carrier stands on its pads (and, on the mobile crane, its wheels are free of the ground). */
  onOutriggers(world: CraneWorld): boolean {
    const o = this.spec.outriggers;
    if (!o) return false;
    if (!this.padsDown(world)) return false;
    return o.freeLift <= 0 || this.lift >= o.freeLift - 0.01;
  }

  /** The setting the chart is read in: by how far the beams are out – or the tyres. */
  setting(world: CraneWorld): Setting {
    if (this.type === 'tower') return 'fixed';
    if (!this.onOutriggers(world)) return 'tyres';
    const e = this.beamSetting();
    return e >= 0.98 ? 'full' : e >= 0.48 ? 'half' : 'zero';
  }

  /** The boom is down in its rest – folded, for the loader crane – and the crane may drive. */
  stowed(): boolean {
    const q = this.q;
    if (this.type === 'tower') return false;
    if (this.type === 'mobile') return q.luff < 1.5 * DEG && q.tele < 0.01 && Math.abs(wrap(q.slew)) < 1.5 * DEG;
    const g = LOADER_GEOMETRY;
    return Math.abs(q.inner - g.stowInner) < 3 * DEG && Math.abs(q.outer - g.stowOuter) < 4 * DEG && q.ext < 0.01 && Math.abs(q.slew) < 3 * DEG;
  }

  /** Outriggers in and jacks up: ready to drive (with the boom stowed). */
  outriggersIn(): boolean {
    return this.beams.every((b) => b < 0.01) && this.jacks.every((j) => j < 0.01);
  }

  /** Beams, jacks and levelling, while their buttons are held. */
  private stepOutriggers(dt: number, world: CraneWorld): void {
    const o = this.spec.outriggers;
    if (!o) return;
    const c = this.cmd;
    // (the beams move only while the jacks are up, and in only with the boom in its rest: nothing is taken from under a working crane)
    const jacksUp = this.jacks.every((j) => j < 0.01);
    if (c.beams !== 0 && jacksUp && (c.beams > 0 || this.stowed())) {
      for (let i = 0; i < this.beams.length; i++) this.beams[i] = clamp(this.beams[i] + (c.beams * dt) / o.beamTime, 0, 1);
    }
    const n = this.jacks.length;
    const gaps = this.jacks.map((_, i) => this.gap(i, world));
    if (c.jacks > 0) {
      // down: each to the ground, then all together until the wheels are free (the loader crane's: until they bear)
      const down = this.jacks.every((j, i) => j >= gaps[i] - 0.002);
      const want = o.freeLift > 0 ? o.freeLift + 0.02 : 0.02;
      for (let i = 0; i < n; i++) {
        const target = Math.min(o.stroke, gaps[i] + want + this.levelOffset(i));
        const step = o.jackSpeed * dt;
        if (!down) this.jacks[i] = Math.min(gaps[i], this.jacks[i] + step);
        else this.jacks[i] = Math.min(target, this.jacks[i] + step);
      }
    } else if (c.jacks < 0 && this.stowed()) {
      for (let i = 0; i < n; i++) this.jacks[i] = Math.max(0, this.jacks[i] - o.jackSpeed * dt);
      // (down on its wheels again: the levelling is undone with it)
      if (this.jacks.every((j, i) => j <= gaps[i])) {
        this.levelFix.gx = 0;
        this.levelFix.gz = 0;
      }
    }
    if (c.level && this.padsDown(world)) {
      // the automatic levelling: the jacks bring the carrier level, a little at a time
      const rate = 0.006 * dt;
      const t = this.tilt();
      const fx = clamp(-t.gx, -rate, rate);
      const fz = this.type === 'loader' ? 0 : clamp(-t.gz, -rate, rate);
      this.levelFix.gx += fx;
      this.levelFix.gz += fz;
      for (let i = 0; i < n; i++) this.jacks[i] = clamp(this.jacks[i] + this.padX(i) * fx + o.beams[i].z * fz, gaps[i], o.stroke);
    }
    this.updateLift(world);
  }

  /** what levelling asks of jack i beyond the others (m) */
  private levelOffset(i: number): number {
    const o = this.spec.outriggers as OutriggerSpec;
    return this.padX(i) * this.levelFix.gx + o.beams[i].z * this.levelFix.gz;
  }

  private padX(i: number): number {
    const o = this.spec.outriggers as OutriggerSpec;
    const b = o.beams[i];
    return b.side * (o.padIn + this.beams[i] * (o.padOut - o.padIn));
  }

  /** How far the jacks hold the carrier up: in the middle of the support, the levelling taken out. */
  private updateLift(world: CraneWorld): void {
    const o = this.spec.outriggers;
    if (!o) return;
    let sum = 0;
    let bearing = 0;
    for (let i = 0; i < this.jacks.length; i++) {
      const up = this.jacks[i] - this.gap(i, world) - this.levelOffset(i);
      if (up > -0.001) {
        sum += Math.max(0, up);
        bearing++;
      }
    }
    // (lifted only once every pad bears: until then it stands on its wheels)
    this.lift = bearing === this.jacks.length && o.freeLift > 0 ? sum / bearing : 0;
    if (bearing < this.jacks.length && this.levelFix.gx !== 0 && this.jacks.every((j) => j < 0.001)) {
      this.levelFix.gx = 0;
      this.levelFix.gz = 0;
    }
  }

  // ---------------------------------------------------------------------------- the drives

  /** the drives of this crane: which joint each command moves, and its range */
  private drives(): Array<{ key: JointKey; cmd: number; spec: DriveSpec }> {
    const c = this.cmd;
    const sp = this.spec;
    const out: Array<{ key: JointKey; cmd: number; spec: DriveSpec }> = [{ key: 'slew', cmd: c.slew, spec: sp.slew }];
    if (this.type === 'tower') {
      const g = TOWER_GEOMETRY;
      out.push({ key: 'trolley', cmd: c.boom, spec: { min: g.trolleyMin, max: g.trolleyMax, speed: 1.0, accel: 0.45 } });
    } else if (this.type === 'mobile') {
      const g = MOBILE_GEOMETRY;
      out.push({ key: 'luff', cmd: c.boom, spec: { min: 0, max: g.luffMax, speed: 0.035, accel: 0.05 } });
      // (24.4 m of telescopes in 70 s)
      out.push({ key: 'tele', cmd: c.tele, spec: { min: 0, max: 1, speed: 0.0143, accel: 0.03 } });
    } else {
      const g = LOADER_GEOMETRY;
      out.push({ key: 'inner', cmd: c.hoist, spec: { min: g.innerMin, max: g.innerMax, speed: 0.12, accel: 0.25 } });
      out.push({ key: 'outer', cmd: c.boom, spec: { min: g.outerMin, max: g.outerMax, speed: 0.15, accel: 0.3 } });
      out.push({ key: 'ext', cmd: c.tele, spec: { min: 0, max: 1, speed: 0.06, accel: 0.15 } });
    }
    if (sp.hoist) out.push({ key: 'rope', cmd: -c.hoist, spec: sp.hoist });
    return out;
  }

  /** How a joint moves the head: along the radius and up (per unit of the joint), from the joints as they are. */
  private headRate(key: JointKey): { da: number; dy: number } {
    if (key === 'rope') return { da: 0, dy: -1 };
    if (key === 'slew') return { da: 0, dy: 0 };
    const e = key === 'trolley' ? 0.01 : key === 'tele' || key === 'ext' ? 0.001 : 0.0005;
    const q = this.q;
    const h0 = headOf(this.type, q);
    const was = q[key];
    q[key] = was + e;
    const h1 = headOf(this.type, q);
    q[key] = was;
    return { da: (h1.a - h0.a) / e, dy: (h1.y - h0.y) / e };
  }

  /** Does moving `key` this way (sign) raise the load moment?  Hoisting a load up does; so does anything that takes the hook further out. */
  momentUp(key: JointKey, dir: number): boolean {
    if (dir === 0 || key === 'slew') return false;
    if (key === 'rope') return dir < 0;
    const r = this.headRate(key);
    // (the mobile crane's telescopes out: its boom weighs further out even where the head comes no further)
    if (key === 'tele') return dir > 0;
    return r.da * dir > 1e-4;
  }

  private stepDrives(dt: number, world: CraneWorld): void {
    const q = this.q;
    const c = this.cmd;
    const lmi = this.lmi;
    const fine = c.fine ? 0.22 : 1;
    // the hoist slows with the load on it
    const sp = this.spec;
    const heavy = clamp((lmi.load - sp.hoistLight) / Math.max(0.1, sp.hoistHeavy - sp.hoistLight), 0, 1);
    this.events.cut = false;
    const working = this.mayWork(world);
    for (const d of this.drives()) {
      const s = d.spec;
      let want = clamp(d.cmd, -1, 1) * s.speed * fine;
      let accel = s.accel;
      // (a heavy load is hoisted slower, and started and stopped more gently)
      if (d.key === 'rope') {
        want *= 1 - 0.5 * heavy;
        accel *= 1 - 0.6 * heavy;
      }
      const dir = Math.sign(want);
      // the limiter: past 90 % what raises the moment slows down, at 100 % it stops at once; so does everything but coming in when the carrier is not level
      let cut = false;
      if (dir !== 0 && this.momentUp(d.key, dir)) {
        if (lmi.stop || !working) {
          want = 0;
          cut = true;
          this.events.cut = true;
        } else if (lmi.warn) want *= 0.5;
      }
      if (want !== 0) {
        const r = this.headRate(d.key);
        // creeping near what the hook or the load comes down on …
        if (r.dy * want < 0 && this.clearance < 2.5) want *= Math.max(0.2, this.clearance / 2.5);
        // … and while a load still stands, it is taken up slowly once the rope is nearly tight
        if (r.dy * want > 0 && this.load && this.resting && this.slack < 0.8) {
          // (the slack taken in briskly, slower and slower as the rope tightens)
          const creep = d.key === 'rope' ? Math.max(0.1, this.slack * 1.2) : s.speed * 0.3;
          want = Math.sign(want) * Math.min(Math.abs(want), creep);
          this.v[d.key] = clamp(this.v[d.key], -creep, creep);
        }
      }
      // the mobile crane's boom may come down into its rest only straight ahead
      if (d.key === 'luff' && want < 0 && q.luff < 4 * DEG && Math.abs(wrap(q.slew)) > 1.5 * DEG) want = 0;
      if (d.key === 'slew' && this.type === 'mobile' && q.luff < 3 * DEG) want = 0;
      const k = d.key;
      const v = this.v[k];
      const step = accel * dt;
      this.v[k] = cut && Math.sign(v) === dir ? 0 : Math.abs(want - v) <= step ? want : v + Math.sign(want - v) * step;
      let next = q[k] + this.v[k] * dt;
      if (next < s.min || next > s.max) {
        next = clamp(next, s.min, s.max);
        this.v[k] = 0;
      }
      q[k] = s.endless ? wrap(next) : next;
    }
    if (!sp.hoist) q.rope = sp.link;
  }

  /** Whether the crane may work at all: level enough on what it stands on. */
  mayWork(world: CraneWorld): boolean {
    void world;
    return this.type === 'tower' || this.incline() <= this.spec.levelLimit;
  }

  // ---------------------------------------------------------------------------- the load

  /** what hangs on the rope: the hook block and the load */
  mass(): number {
    return this.spec.hook + (this.load ? this.load.t : 0);
  }

  /** How far below the hook's middle the bottom of what hangs there is: the hook block's, or the load's under its slings (they hang from the hook's bowl). */
  drop(): number {
    return this.spec.hookDrop + (this.load ? this.load.sling + 2 * this.load.hy : 0);
  }

  /** The half-size of what hangs there, in the plan (x, z of the world), turned with the load. */
  footprint(): [number, number] {
    const l = this.load;
    if (!l) return [0.3, 0.3];
    const c = Math.abs(Math.cos(l.yaw));
    const s = Math.abs(Math.sin(l.yaw));
    return [l.hx * c + l.hz * s, l.hx * s + l.hz * c];
  }

  /**
   * Take a load on the hook: the slinger hooks the slings in, the hook block
   * comes to stand over the load's middle at the slings' length.
   */
  attach(load: HookLoad, x: number, top: number, z: number): void {
    this.load = load;
    const h = this.hook;
    h.x = x;
    h.z = z;
    h.y = top + load.sling + this.spec.hookDrop;
    h.vx = h.vy = h.vz = 0;
    this.resting = true;
    // (the rope as long as it now hangs – no jerk on hooking in)
    const d = Math.hypot(this.head.x - h.x, this.head.y - h.y, this.head.z - h.z);
    if (this.spec.hoist && d > this.q.rope) this.q.rope = Math.min(this.spec.hoist.max, d);
  }

  /** Let the load go (it stands where it is): the hook block hangs alone again. */
  release(): HookLoad | null {
    const l = this.load;
    this.load = null;
    return l;
  }

  // ---------------------------------------------------------------------------- a step

  /** One step of everything: the drives, the head, the hook on its rope, the limiter, the tipping check. */
  step(dt: number, world: CraneWorld): void {
    this.time += dt;
    const ev = this.events;
    ev.hit = 0;
    ev.landed = 0;
    ev.liftedOff = false;
    if (this.tipped) {
      // over it goes, about its tipping line, faster and faster until it lies
      const t = this.tipped;
      t.rate += 1.8 * dt;
      t.angle = Math.min(1.35, t.angle + t.rate * dt);
      return;
    }
    this.stepOutriggers(dt, world);
    const px = this.head.x;
    const py = this.head.y;
    const pz = this.head.z;
    this.stepDrives(dt, world);
    this.headWorld(this.head);
    this.head.vx = (this.head.x - px) / dt;
    this.head.vy = (this.head.y - py) / dt;
    this.head.vz = (this.head.z - pz) / dt;
    this.stepHook(dt, world);
    this.updateLmi(dt, world);
  }

  private stepHook(dt: number, world: CraneWorld): void {
    const h = this.hook;
    const hd = this.head;
    const m = this.mass();
    const kg = m * 1000;
    // the rope: an elastic line, pulling only
    const dx = hd.x - h.x;
    const dy = hd.y - h.y;
    const dz = hd.z - h.z;
    const d = Math.hypot(dx, dy, dz) || 1e-6;
    const nx = dx / d;
    const ny = dy / d;
    const nz = dz / d;
    const k = (kg * G) / STRETCH;
    const c = 2 * ROPE_DAMPING * Math.sqrt(k * kg);
    const stretch = d - this.q.rope;
    this.slack = -stretch;
    // (the damping works on how fast the rope stretches – not on rope paid out or hauled in by the winch)
    const rate = nx * (hd.vx - h.vx) + ny * (hd.vy - h.vy) + nz * (hd.vz - h.vz) - this.v.rope;
    const T = stretch > 0 ? Math.max(0, k * stretch + c * rate) : 0;
    this.tension = T / 1000;
    let fx = T * nx;
    let fy = T * ny - kg * G;
    let fz = T * nz;
    // the air: it damps the swing, and the wind pushes on the load
    const w = world.wind();
    const at = windAtHeight(1, h.y - this.base.y) * gust(this.time * 0.9 + 3, w.gust);
    const wx = w.x * at - h.vx;
    const wz = w.z * at - h.vz;
    const area = this.load ? this.load.area : 0.5;
    const wv = Math.hypot(wx, wz);
    fx += DRAG * area * wv * wx - AIR * kg * h.vx;
    fz += DRAG * area * wv * wz - AIR * kg * h.vz;
    fy -= AIR * kg * h.vy;
    h.vx += (fx / kg) * dt;
    h.vy += (fy / kg) * dt;
    h.vz += (fz / kg) * dt;
    h.x += h.vx * dt;
    h.y += h.vy * dt;
    h.z += h.vz * dt;
    // what it comes down on
    const [fx2, fz2] = this.footprint();
    const below = this.drop();
    const bottom = h.y - below;
    const floor = world.floor(h.x, h.z, fx2, fz2, bottom + 0.35);
    const wasResting = this.resting;
    if (Number.isFinite(floor) && bottom < floor) {
      h.y = floor + below;
      if (h.vy < 0) {
        if (!wasResting && this.load) this.events.landed = -h.vy;
        h.vy = 0;
      }
      this.resting = true;
    } else this.resting = Number.isFinite(floor) && bottom < floor + 0.004 && Math.abs(h.vy) <= 0.02;
    if (this.resting) {
      // standing: it does not slide (what pulls it aside drags it only slowly)
      const keep = Math.max(0, 1 - 14 * dt);
      h.vx *= keep;
      h.vz *= keep;
    }
    if (wasResting && !this.resting && this.load) this.events.liftedOff = true;
    this.clearance = Number.isFinite(floor) ? Math.max(0, h.y - below - floor) : 99;
    // what it runs into
    const top = h.y + 0.5;
    for (const b of world.boxes()) {
      if (h.x + fx2 <= b.x0 || h.x - fx2 >= b.x1 || h.z + fz2 <= b.z0 || h.z - fz2 >= b.z1 || top <= b.y0 || h.y - below >= b.y1) continue;
      // out the shortest way
      const pushes: Array<[number, number, number, number]> = [
        [b.x0 - (h.x + fx2), 0, 0, 0],
        [b.x1 - (h.x - fx2), 0, 0, 1],
        [b.z0 - (h.z + fz2), 0, 0, 2],
        [b.z1 - (h.z - fz2), 0, 0, 3],
        [b.y1 - (h.y - below), 0, 0, 4],
      ];
      let best = pushes[0];
      for (const p of pushes) if (Math.abs(p[0]) < Math.abs(best[0])) best = p;
      const axis = best[3];
      let speed = 0;
      if (axis <= 1) {
        h.x += best[0];
        speed = Math.abs(h.vx);
        h.vx *= -0.15;
      } else if (axis <= 3) {
        h.z += best[0];
        speed = Math.abs(h.vz);
        h.vz *= -0.15;
      } else {
        h.y += best[0];
        speed = Math.max(0, -h.vy);
        h.vy = 0;
      }
      this.events.hit = Math.max(this.events.hit, speed);
    }
    this.swing = Math.hypot(h.x - hd.x, h.z - hd.z);
  }

  // ---------------------------------------------------------------------------- the limiter and the tipping check

  /** The weights and sideways forces on the crane now (carrier frame), and what it stands on – for the tipping check. */
  loads(world: CraneWorld, extra: readonly Weight[] = []): { weights: Weight[]; sides: SideForce[]; supports: Array<[number, number]> } {
    const weights = craneWeights(this.spec, this.q, extra);
    // the rope pulls on the head: down by what it holds, aside by how the load hangs off the plumb line
    const T = this.tension;
    const hd = headOf(this.type, this.q);
    const [dx, dz] = boomDir(this.q.slew);
    const hx = this.spec.slewX + hd.a * dx;
    const hz = this.spec.slewZ + hd.a * dz;
    const h = this.hook;
    const [cx, cz] = this.toCarrier(h.x, h.z);
    const d = Math.hypot(this.head.x - h.x, this.head.y - h.y, this.head.z - h.z) || 1;
    const vy = (T * (this.head.y - h.y)) / d;
    weights.push({ t: vy / G, x: hx, y: hd.y, z: hz });
    const sides: SideForce[] = [{ fx: (T * (cx - hx)) / d, fz: (T * (cz - hz)) / d, y: hd.y + this.lift }];
    // the wind on the boom or the jib, at its middle
    const wind = world.wind();
    const [wx, wz] = this.windInCarrier(wind.x, wind.z);
    const area = this.type === 'tower' ? 28 : this.type === 'mobile' ? 6 + boomLength(this.q.tele) * 0.45 : 3;
    const mid = hd.y * 0.6;
    const ww = windAtHeight(1, mid) * gust(this.time * 0.9 + 3, wind.gust);
    const ws = Math.hypot(wx * ww, wz * ww);
    sides.push({ fx: (0.61 * area * ws * wx * ww) / 1000, fz: (0.61 * area * ws * wz * ww) / 1000, y: mid });
    const setting = this.setting(world);
    const supports = this.type === 'tower' || !this.spec.outriggers ? supportsFor(this.spec, 'fixed') : setting === 'tyres' ? supportsFor(this.spec, 'tyres') : this.padSupports();
    return { weights, sides, supports };
  }

  /** the pads where they are (and the loader crane's wheels) */
  private padSupports(): Array<[number, number]> {
    const o = this.spec.outriggers as OutriggerSpec;
    const pads = o.beams.map((b, i): [number, number] => [this.padX(i), b.z]);
    return this.type === 'loader' ? [...pads, ...this.spec.feet.map((f): [number, number] => [f[0], f[1]])] : pads;
  }

  private windInCarrier(x: number, z: number): [number, number] {
    const c = Math.cos(this.base.yaw);
    const s = Math.sin(this.base.yaw);
    return [x * c - z * s, x * s + z * c];
  }

  /** Masses that rest on the carrier and hold it down (the loader crane's cargo), set by the game. */
  extra: Weight[] = [];

  private updateLmi(dt: number, world: CraneWorld): void {
    const l = this.lmi;
    // the measured load: the rope's pull, smoothed for the display – and taken quickly for the cut-off
    this.measured += (this.tension / G - this.measured) * (1 - Math.exp(-dt / 0.3));
    this.quick += (this.tension / G - this.quick) * (1 - Math.exp(-dt / 0.02));
    l.load = Math.max(0, this.measured);
    l.setting = this.setting(world);
    // (the radius the chart is read at: the head's, where the hook hangs at rest)
    const hd = headOf(this.type, this.q);
    l.radius = Math.max(0, hd.a);
    l.length = this.type === 'mobile' ? boomLength(this.q.tele) : this.type === 'loader' ? LOADER_GEOMETRY.inner + outerLength(this.q.ext) : TOWER_GEOMETRY.jibLength;
    l.angle = (this.type === 'mobile' ? this.q.luff : this.type === 'loader' ? this.q.inner : 0) / DEG;
    l.capacity = capacity(this.type, l.setting, l.radius, l.length);
    const ratio = (t: number): number => (l.capacity > 0.01 ? t / l.capacity : t > 0.05 ? 9.99 : 0);
    l.ratio = ratio(l.load);
    const quick = ratio(Math.max(0, this.quick));
    l.incline = this.incline();
    l.notLevel = this.type !== 'tower' && l.incline > this.spec.levelLimit;
    // the wind at the boom head, with its gusts
    const w = world.wind();
    l.wind = windAtHeight(Math.hypot(w.x, w.z), this.head.y - this.base.y) * gust(this.time * 0.9 + 3, w.gust);
    l.windLimit = this.spec.windLimit;
    const g = this.hook.y - this.drop() - world.floor(this.hook.x, this.hook.z, 0.2, 0.2, this.hook.y);
    l.hookHeight = Number.isFinite(g) ? Math.max(0, g) : 0;
    l.warn = l.ratio >= 0.9;
    // (cut off at 100 % – the quick reading while the load stands: before an overload leaves the ground –, let go again below 98 %)
    const standing = this.resting && this.load !== null;
    this.cutting = this.cutting ? l.ratio >= 0.98 || quick >= 0.98 : l.ratio >= 1 || (standing && quick >= 1);
    l.stop = this.cutting;
    // the tipping check
    const t = this.loads(world, this.extra);
    const st = stability(t.weights, t.sides, t.supports);
    l.tipping = st.u;
    this.overT = st.u >= 1 ? this.overT + dt : 0;
    if (this.overT > 0.25 && st.edge >= 0) {
      const lines = tippingLines(st.hull);
      const ln = lines[st.edge];
      this.tipped = { px: ln.px, pz: ln.pz, nx: ln.nx, nz: ln.nz, angle: 0, rate: 0.05 };
    }
  }
}

/** The tipping lines of the supports (for drawing which way a crane went over). */
export function linesOf(supports: ReadonlyArray<readonly [number, number]>): Array<{ px: number; pz: number; nx: number; nz: number }> {
  return tippingLines(convexHull(supports));
}
