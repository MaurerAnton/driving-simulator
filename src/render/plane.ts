// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The light aeroplane: a generic two-seat high-wing trainer of the kind
 * flying schools use – no real type, maker or registration is reproduced –
 * in white with a blue cheat line and "Fahrsim" on the fin.
 *
 * Built on the measures of sim/flightspec.ts (TRAINER) in the flight model's
 * body frame: x to the right, y up, the nose towards −z, the origin at the
 * centre of mass.  The wheels stand where the physics has them (each strut
 * shortens by its compression), the propeller turns about its hub and every
 * control surface about its own hinge line.
 *
 * Outside: a lofted fuselage whose windows are cut out of its skin, the wing
 * on struts with ailerons and flaps, the tail with elevator, trim tab and
 * rudder, a tricycle gear on telescopic spring struts with wheel fairings,
 * the propeller (a faint disc once it runs fast), the lights.  Inside – left
 * out for an aeroplane parked as scenery – what the pilot sees from the left
 * seat: the panel (render/flightpanel.ts), two yokes, pedals, the throttle,
 * the seats, the frames of windscreen and doors, the wing through the side
 * windows.
 *
 * Everything that does not move is merged per material, and the geometry is
 * built once and shared by every aeroplane.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TRAINER } from '../sim/flightspec.ts';
import type { GearLeg } from '../sim/flightspec.ts';
import { Sculpt } from './carBody.ts';
import type { Vec3 } from './carBody.ts';
import { FlightPanel, PANEL_AREA, PANEL_PAINT } from './flightpanel.ts';
import type { Mirror } from './mirrors.ts';

/** What the game hands the model every frame. */
export interface PlaneVisualState {
  /** deflections (rad): + aileron = roll to the right (right aileron up, left down), + elevator = trailing edge up, + rudder = trailing edge to the right */
  aileron: number;
  elevator: number;
  rudder: number;
  flapsDeg: number;
  /** 0 … 1 */
  throttle: number;
  rpm: number;
  /** the propeller's angle (rad), growing as it turns */
  propAngle: number;
  /** nose, left main, right main (the order of TRAINER.gear): strut compression (m), wheel angle (rad), steering (rad, + = right) */
  wheels: Array<{ compression: number; spin: number; steer: number }>;
  /** −1 … 1 (pitch + = pulled) */
  yoke: { pitch: number; roll: number };
  /** −1 … 1, + = right pedal pushed */
  pedals: number;
  lights: { nav: boolean; beacon: boolean; strobe: boolean; landing: boolean; taxi: boolean };
  iasKt: number;
  altitudeFt: number;
  vsFpm: number;
  headingDeg: number;
  pitchDeg: number;
  bankDeg: number;
  /** the ball of the turn coordinator, −1 … 1 (+ = to the right) */
  slip: number;
  turnRateDegS: number;
  rpmGauge: number;
  /** 0 … 1 */
  fuel: number;
  /** degrees */
  flapsGauge: number;
  stallWarning: boolean;
  parkingBrake: boolean;
  engineOn: boolean;
}

export interface PlaneModelOptions {
  /** the cockpit (panel, yokes, seats …); false for an aeroplane parked as scenery */
  interior?: boolean;
}

const T = TRAINER;
const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------- materials
function lambert(hex: number): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color: hex });
  // (the skin is not everywhere a closed solid – the windows are holes in it)
  m.shadowSide = THREE.DoubleSide;
  return m;
}
const PAINT = lambert(0xf1f2ef);
// (white paint in the shade still looks light: the sky and the ground light it – more than the scene's
// hemisphere light alone gives the wing's underside, which is in view from the cockpit all the time)
PAINT.emissive.setHex(0x4c4e50);
const STRIPE = lambert(0x1b57a3);
const ACCENT = lambert(0xe0a21c);
const SEAM = lambert(0x9aa0a6);
const RUBBER = lambert(0x1c1e21);
const DARK = lambert(0x2b2e32);
const METAL = lambert(0xa9afb5);
const CHROME = new THREE.MeshPhongMaterial({ color: 0xbcc1c6, shininess: 80, specular: 0xd8d8d8 });
const TYRE = lambert(0x161718);
const HUB = lambert(0xc3c8cd);

/**
 * The inside gets little direct light and the scene has no bounce light: a
 * self-lit share keeps it readable (as in render/car.ts).  One set per
 * aeroplane – the cabin can be made see-through.
 */
function cabinMaterial(hex: number, side: THREE.Side = THREE.FrontSide): THREE.MeshLambertMaterial {
  const c = new THREE.Color(hex);
  return new THREE.MeshLambertMaterial({ color: c.clone().multiplyScalar(0.6), emissive: c.clone().multiplyScalar(0.42), side });
}

// -------------------------------------------------------------------------- geometry helpers
type P2 = [number, number];

/** Position and normal only, un-indexed: the form in which parts are merged. */
function bare(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(n.attributes)) if (name !== 'position' && name !== 'normal') n.deleteAttribute(name);
  return n;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(parts.map(bare), false)!;
}

/** A box from x0…x1, y0…y1, z0…z1. */
function block(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): THREE.BufferGeometry {
  return bare(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function unit3(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** A round tube along a path, its radius per point (or one for all). */
function pipe(path: Vec3[], radius: number | number[], seg = 8, caps = true): THREE.BufferGeometry {
  const rings: Vec3[][] = [];
  let n1: THREE.Vector3 | null = null;
  for (let i = 0; i < path.length; i++) {
    const a = new THREE.Vector3(...path[Math.max(0, i - 1)]);
    const t = new THREE.Vector3(...path[Math.min(path.length - 1, i + 1)]).sub(a).normalize();
    if (!n1) n1 = new THREE.Vector3(Math.abs(t.y) < 0.9 ? 0 : 1, Math.abs(t.y) < 0.9 ? 1 : 0, 0).cross(t).normalize();
    else n1.addScaledVector(t, -n1.dot(t)).normalize();
    const n2 = new THREE.Vector3().crossVectors(t, n1);
    const r = Array.isArray(radius) ? radius[i] : radius;
    const ring: Vec3[] = [];
    for (let k = 0; k < seg; k++) {
      const an = (k / seg) * Math.PI * 2;
      const c = Math.cos(an) * r;
      const s = Math.sin(an) * r;
      ring.push([path[i][0] + n1.x * c + n2.x * s, path[i][1] + n1.y * c + n2.y * s, path[i][2] + n1.z * c + n2.z * s]);
    }
    rings.push(ring);
  }
  return new Sculpt().tube(rings, caps, caps).build(60);
}

/** Outline of a rectangle with rounded corners, counter-clockwise. */
function outline(w: number, h: number, r: number, seg = 3): P2[] {
  const pts: P2[] = [];
  const corners: Array<[number, number, number]> = [
    [w / 2 - r, -h / 2 + r, -90],
    [w / 2 - r, h / 2 - r, 0],
    [-w / 2 + r, h / 2 - r, 90],
    [-w / 2 + r, -h / 2 + r, 180],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = (a0 + (90 * i) / seg) * DEG;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
}

/** A block with rounded edges: w across (x), h high (y), d deep (z); turned by rx (pitch) and ry (yaw), moved to `at`. */
function slab(w: number, h: number, d: number, r: number, at: Vec3, rx = 0, ry = 0): THREE.BufferGeometry {
  const b = Math.min(r, d / 2) * 0.7;
  const rings = (
    [
      [-d / 2, b],
      [-d / 2 + b, 0],
      [d / 2 - b, 0],
      [d / 2, b],
    ] as P2[]
  ).map(([z, s]) => outline(w - 2 * s, h - 2 * s, Math.max(0.002, Math.min(r, w / 2 - s, h / 2 - s) - s * 0.5)).map(([x, y]): Vec3 => [x, y, z]));
  const g = new Sculpt().tube(rings, true, true).build(50);
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, 0, 'YXZ')));
  g.translate(at[0], at[1], at[2]);
  return g;
}

/** A flat oval facing `facing` (a lamp's lens, an air inlet). */
function oval(centre: Vec3, right: Vec3, up: Vec3, rx: number, ry: number, facing: Vec3, seg = 14): THREE.BufferGeometry {
  const ring: Vec3[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const c = Math.cos(a) * rx;
    const s = Math.sin(a) * ry;
    ring.push([centre[0] + right[0] * c + up[0] * s, centre[1] + right[1] * c + up[1] * s, centre[2] + right[2] * c + up[2] * s]);
  }
  return new Sculpt().fan(ring, facing).build();
}

/** Monotone cubic interpolation (no overshoot between the stations). */
function pchip(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m: number[] = new Array<number>(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i + 1 < n; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x: number): number => {
    const xx = Math.min(xs[n - 1], Math.max(xs[0], x));
    let i = 0;
    while (i < n - 2 && xx > xs[i + 1]) i++;
    const t = (xx - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

// ------------------------------------------------------------------------------- airfoils
interface Profile {
  /** thickness, camber, place of the camber (NACA four-digit) */
  t: number;
  m: number;
  p: number;
}
const WING: Profile = { t: 0.12, m: 0.02, p: 0.4 };
const TAIL: Profile = { t: 0.1, m: 0, p: 0.4 };

function camber(x: number, f: Profile): number {
  if (f.m === 0) return 0;
  return x < f.p ? (f.m / (f.p * f.p)) * (2 * f.p * x - x * x) : (f.m / ((1 - f.p) * (1 - f.p))) * (1 - 2 * f.p + 2 * f.p * x - x * x);
}

function halfThick(x: number, t: number): number {
  const s = Math.min(1, Math.max(0, x));
  return 5 * t * (0.2969 * Math.sqrt(s) - 0.126 * s - 0.3516 * s * s + 0.2843 * s * s * s - 0.1036 * s * s * s * s);
}

/** The front of a section, from the leading edge to `to` (parts of the chord), closed by a flat face there: [chordwise, up]. */
function foil(to: number, n: number, f: Profile): P2[] {
  const xs: number[] = [];
  for (let i = 0; i <= n; i++) xs.push(to * (1 - Math.cos(((i / n) * Math.PI) / 2)));
  const pts: P2[] = [];
  for (let i = n; i >= 0; i--) pts.push([xs[i], camber(xs[i], f) + halfThick(xs[i], f.t)]);
  for (let i = 1; i <= n; i++) pts.push([xs[i], camber(xs[i], f) - halfThick(xs[i], f.t)]);
  return pts;
}

/**
 * A control surface's section from `from` to `to` (parts of the chord): a
 * round nose that sits in the cove of the surface in front, the hinge in the
 * middle of the nose.
 */
function aft(from: number, to: number, n: number, f: Profile): { ring: P2[]; hinge: P2 } {
  const xn = from + 0.012;
  const r = halfThick(xn, f.t);
  const yn = camber(xn, f);
  const pts: P2[] = [];
  for (let i = n; i >= 0; i--) {
    const x = xn + ((to - xn) * i) / n;
    pts.push([x, camber(x, f) + halfThick(x, f.t)]);
  }
  for (let k = 1; k < 6; k++) {
    const a = Math.PI / 2 + (Math.PI * k) / 6;
    pts.push([xn + r * Math.cos(a), yn + r * Math.sin(a)]);
  }
  for (let i = 0; i <= n; i++) {
    const x = xn + ((to - xn) * i) / n;
    pts.push([x, camber(x, f) - halfThick(x, f.t)]);
  }
  return { ring: pts, hinge: [xn, yn] };
}

/** A thin strip of a section between `from` and `to`, flat at both ends (a trim tab). */
function strip(from: number, to: number, n: number, f: Profile): P2[] {
  const pts: P2[] = [];
  for (let i = n; i >= 0; i--) {
    const x = from + ((to - from) * i) / n;
    pts.push([x, camber(x, f) + halfThick(x, f.t)]);
  }
  for (let i = 0; i <= n; i++) {
    const x = from + ((to - from) * i) / n;
    pts.push([x, camber(x, f) - halfThick(x, f.t)]);
  }
  return pts;
}

/** A section scaled about its thickest point – for the rounded tips. */
function shrink(sec: P2[], kc: number, kt: number, f: Profile): P2[] {
  const yc = camber(0.35, f);
  return sec.map(([c, y]): P2 => [0.35 + (c - 0.35) * kc, yc + (y - yc) * kt]);
}

// ------------------------------------------------------------------------------- the fuselage
/**
 * Cross-sections along the fuselage: z, the top, the bottom, the height of
 * its widest line, its half width there, how square it is above and below
 * (2 = an ellipse), and how much narrower it gets towards the top.
 */
const STATIONS: number[][] = [
  [-2.36, 0.3, -0.29, 0.02, 0.3, 2.4, 2.4, 0],
  [-2.22, 0.33, -0.36, 0.03, 0.4, 2.6, 2.6, 0],
  [-2.0, 0.36, -0.42, 0.04, 0.47, 2.9, 2.8, 0],
  [-1.75, 0.385, -0.46, 0.06, 0.51, 3.2, 3.0, 0],
  [-1.55, 0.4, -0.48, 0.08, 0.53, 3.4, 3.2, 0.01],
  [-1.28, 0.43, -0.5, 0.11, 0.55, 3.0, 3.4, 0.03],
  [-1.1, 0.62, -0.51, 0.13, 0.56, 3.0, 3.5, 0.04],
  [-0.9, 0.79, -0.52, 0.15, 0.565, 3.4, 3.5, 0.05],
  [-0.7, 0.93, -0.52, 0.15, 0.565, 4.0, 3.5, 0.06],
  [-0.58, 0.985, -0.52, 0.15, 0.565, 4.6, 3.5, 0.06],
  [-0.4, 1.0, -0.52, 0.15, 0.565, 5.0, 3.5, 0.06],
  [0.6, 1.0, -0.51, 0.16, 0.565, 5.0, 3.5, 0.06],
  [0.95, 1.0, -0.48, 0.17, 0.55, 4.6, 3.4, 0.06],
  [1.2, 0.97, -0.44, 0.19, 0.52, 3.8, 3.2, 0.05],
  [1.6, 0.88, -0.36, 0.22, 0.47, 3.0, 3.0, 0.03],
  [2.2, 0.72, -0.24, 0.24, 0.39, 2.6, 2.7, 0.02],
  [3.0, 0.57, -0.1, 0.25, 0.29, 2.4, 2.5, 0],
  [3.8, 0.48, 0.01, 0.26, 0.2, 2.3, 2.4, 0],
  [4.5, 0.43, 0.08, 0.27, 0.13, 2.2, 2.3, 0],
  [5.12, 0.4, 0.16, 0.28, 0.05, 2.2, 2.2, 0],
];

interface Section {
  top: number;
  bot: number;
  wide: number;
  w: number;
  nt: number;
  nb: number;
  k: number;
}

/** STEPS points along each half of a quarter of a cross-section */
const STEPS = 14;

/**
 * A quarter of a superellipse a^n + b^n = 1, from (0, 1) to (1, 0) – sampled
 * along a where the curve runs across and along b where it runs up, so that
 * the points stay evenly spread even where it turns sharply (n > 2).
 */
function quadrant(n: number): P2[] {
  const k = 2 ** (-1 / n);
  const pts: P2[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const a = (k * i) / STEPS;
    pts.push([a, (1 - a ** n) ** (1 / n)]);
  }
  for (let i = STEPS - 1; i >= 0; i--) {
    const b = (k * i) / STEPS;
    pts.push([(1 - b ** n) ** (1 / n), b]);
  }
  return pts;
}

/** A cross-section as a closed outline: x, y pairs from the bottom middle round by the right side, and how far round each is (0 … 1). */
interface Ring {
  pts: Float64Array;
  at: Float64Array;
  length: number;
}

/**
 * The fuselage as a surface over (u, z): u runs once round a cross-section,
 * by its length – 0 at the bottom, 0.5 at the top, the right side first.
 */
class Fuselage {
  readonly z0: number;
  readonly z1: number;
  private readonly curves: Array<(z: number) => number>;
  private readonly rings = new Map<number, Ring>();

  constructor(rows: number[][]) {
    const zs = rows.map((r) => r[0]);
    this.curves = [1, 2, 3, 4, 5, 6, 7].map((i) => pchip(zs, rows.map((r) => r[i])));
    this.z0 = zs[0];
    this.z1 = zs[zs.length - 1];
  }

  section(z: number): Section {
    const c = this.curves;
    return { top: c[0](z), bot: c[1](z), wide: c[2](z), w: c[3](z), nt: c[4](z), nb: c[5](z), k: c[6](z) };
  }

  /** The cross-section at z: bottom right, top right, top left, bottom left quarter. */
  ring(z: number): Ring {
    const key = Math.round(z * 1e5);
    const have = this.rings.get(key);
    if (have) return have;
    const s = this.section(z);
    const below = quadrant(s.nb).map(([a, b]): P2 => [s.w * a, s.wide - (s.wide - s.bot) * b]);
    const above = quadrant(s.nt).map(([a, b]): P2 => [s.w * a * (1 - s.k * b ** (s.nt / 2)), s.wide + (s.top - s.wide) * b]);
    const right = [...below, ...above.reverse().slice(1)];
    const all = [...right, ...right.slice(0, -1).reverse().map(([x, y]): P2 => [-x, y])];
    const pts = new Float64Array(all.length * 2);
    const at = new Float64Array(all.length);
    all.forEach(([x, y], i) => {
      pts[i * 2] = x;
      pts[i * 2 + 1] = y;
      if (i) at[i] = at[i - 1] + Math.hypot(x - all[i - 1][0], y - all[i - 1][1]);
    });
    const length = at[all.length - 1];
    for (let i = 0; i < at.length; i++) at[i] /= length;
    const r = { pts, at, length };
    this.rings.set(key, r);
    return r;
  }

  point(u: number, z: number): Vec3 {
    const { pts, at } = this.ring(z);
    const v = Math.min(1, Math.max(0, u));
    let lo = 0;
    let hi = at.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (at[m] <= v) lo = m;
      else hi = m;
    }
    const t = (v - at[lo]) / Math.max(1e-12, at[hi] - at[lo]);
    return [pts[lo * 2] + (pts[hi * 2] - pts[lo * 2]) * t, pts[lo * 2 + 1] + (pts[hi * 2 + 1] - pts[lo * 2 + 1]) * t, z];
  }

  perimeter(z: number): number {
    return this.ring(z).length;
  }

  /** u where the outline from `from` to `to` (indices, one way round) first reaches value v of coordinate c (it runs monotonously there). */
  private find(z: number, from: number, to: number, c: number, v: number): number {
    const { pts, at } = this.ring(z);
    const sign = pts[to * 2 + c] > pts[from * 2 + c] ? 1 : -1;
    if (sign * (v - pts[from * 2 + c]) <= 0) return at[from];
    if (sign * (v - pts[to * 2 + c]) >= 0) return at[to];
    let lo = from;
    let hi = to;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (sign * (pts[m * 2 + c] - v) <= 0) lo = m;
      else hi = m;
    }
    const t = (v - pts[lo * 2 + c]) / (pts[hi * 2 + c] - pts[lo * 2 + c]);
    return at[lo] + (at[hi] - at[lo]) * t;
  }

  /** u of the point at height y on the right side. */
  uAtY(z: number, y: number): number {
    return this.find(z, 0, 4 * STEPS, 1, y);
  }

  /** u of the point at x on the upper half. */
  uAtX(z: number, x: number): number {
    return this.find(z, 2 * STEPS, 6 * STEPS, 0, x);
  }

  /** Half the width at height y (the inner side of the skin, for the cabin). */
  wallX(z: number, y: number): number {
    return this.point(this.uAtY(z, y), z)[0];
  }

  /** Height of the skin's upper half above x. */
  roofY(z: number, x: number): number {
    return this.point(this.uAtX(z, x), z)[1];
  }
}

// ------------------------------------------------------------- the skin and its windows
type Skin = 'paint' | 'stripe' | 'accent' | 'seam' | 'seal' | 'glass';
const SKINS: Skin[] = ['paint', 'stripe', 'accent', 'seam', 'seal', 'glass'];

/** A part of the skin – a window, a stripe – as a convex polygon over (u, z), counter-clockwise. */
interface Region {
  skin: Skin;
  poly: P2[];
  u0: number;
  u1: number;
  z0: number;
  z1: number;
}

function area2(p: P2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function side2(a: P2, b: P2, p: P2): number {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

/** Convex hull, counter-clockwise (monotone chain). */
function hull(points: P2[]): P2[] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: P2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && side2(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: P2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && side2(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function region(skin: Skin, pts: P2[]): Region {
  let poly = pts.slice();
  if (area2(poly) < 0) poly.reverse();
  // (a polygon that came out slightly hollow after mapping into (u, z): its hull)
  for (let i = 0; i < poly.length; i++) {
    if (side2(poly[i], poly[(i + 1) % poly.length], poly[(i + 2) % poly.length]) < -1e-12) {
      poly = hull(poly);
      break;
    }
  }
  const us = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  return { skin, poly, u0: Math.min(...us), u1: Math.max(...us), z0: Math.min(...zs), z1: Math.max(...zs) };
}

/** The part of `poly` on the left of a→b (sign 1) or on its right (sign −1): Sutherland–Hodgman. */
function clipHalf(poly: P2[], a: P2, b: P2, sign: number): P2[] {
  const out: P2[] = [];
  const n = poly.length;
  let prev = poly[n - 1];
  let sp = sign * side2(a, b, prev);
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const sc = sign * side2(a, b, cur);
    if ((sc >= 0 && sp < 0) || (sc < 0 && sp > 0)) {
      const t = sp / (sp - sc);
      out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
    }
    if (sc >= 0) out.push(cur);
    prev = cur;
    sp = sc;
  }
  return out;
}

/** A convex polygon over (u, z) grown by d metres all round (u measured along the skin). */
function grow(poly: P2[], d: number, perimeter: number): P2[] {
  const q = poly.map(([u, z]): P2 => [u * perimeter, z]);
  const n = q.length;
  const lines = q.map((a, i) => {
    const b = q[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = (b[1] - a[1]) / l;
    const ny = -(b[0] - a[0]) / l;
    return { a: [a[0] + nx * d, a[1] + ny * d] as P2, dir: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] as P2 };
  });
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const L0 = lines[(i + n - 1) % n];
    const L1 = lines[i];
    const den = L0.dir[0] * L1.dir[1] - L0.dir[1] * L1.dir[0];
    if (Math.abs(den) < 1e-9) {
      out.push(L1.a);
      continue;
    }
    const t = ((L1.a[0] - L0.a[0]) * L1.dir[1] - (L1.a[1] - L0.a[1]) * L1.dir[0]) / den;
    out.push([L0.a[0] + L0.dir[0] * t, L0.a[1] + L0.dir[1] * t]);
  }
  return out.map(([u, z]): P2 => [u / perimeter, z]);
}

/** A narrow band along the segment a→b over (u, z), `width` metres wide on the skin. */
function line(a: P2, b: P2, width: number, perimeter: number): P2[] {
  const ax = a[0] * perimeter;
  const bx = b[0] * perimeter;
  const l = Math.hypot(bx - ax, b[1] - a[1]) || 1;
  const dx = (bx - ax) / l;
  const dz = (b[1] - a[1]) / l;
  const h = width / 2;
  const pts: P2[] = [
    [ax - dx * h - dz * h, a[1] - dz * h + dx * h],
    [bx + dx * h - dz * h, b[1] + dz * h + dx * h],
    [bx + dx * h + dz * h, b[1] + dz * h - dx * h],
    [ax - dx * h + dz * h, a[1] - dz * h - dx * h],
  ];
  return pts.map(([u, z]): P2 => [u / perimeter, z]);
}

/** The heights of the cheat line (and the thin line below it) along the fuselage: z, lower edge, upper edge. */
const CHEAT_LINE: Array<[number, number, number]> = [
  [-2.36, -0.03, 0.05],
  [-2.15, 0.0, 0.09],
  [-1.85, 0.04, 0.14],
  [-1.55, 0.07, 0.18],
  [-1.2, 0.1, 0.21],
  [-0.2, 0.12, 0.23],
  [0.8, 0.14, 0.25],
  [1.6, 0.18, 0.28],
  [2.4, 0.22, 0.31],
  [3.3, 0.25, 0.33],
  [4.2, 0.28, 0.35],
  [4.62, 0.322, 0.334],
];

/** Where the windows, seals, door joints and stripes lie on the skin. */
function skinRegions(f: Fuselage): { regions: Region[]; windows: Region[] } {
  const regions: Region[] = [];
  const windows: Region[] = [];
  const mirror = (pts: P2[]): P2[] => pts.map(([u, z]): P2 => [1 - u, z]);
  const add = (skin: Skin, pts: P2[], both: boolean): void => {
    for (const p of both ? [pts, mirror(pts)] : [pts]) {
      const r = region(skin, p);
      regions.push(r);
      if (skin === 'glass') windows.push(r);
    }
  };
  const side = (z: number, y: number): P2 => [f.uAtY(z, y), z];
  const top = (z: number, x: number): P2 => [f.uAtX(z, x), z];
  const P = f.perimeter(-0.4);

  // the windscreen, from the cowling up to the wing's leading edge
  const zb = -1.28;
  const zt = -0.62;
  // (its upper corners lie at the cabin's shoulders, its lower ones on the cowling)
  const shoulder = side(zt, 0.93);
  const screen: P2[] = [top(zb, 0.46), shoulder, [1 - shoulder[0], zt], top(zb, -0.46)];
  // the doors' windows: the front edge runs along the windscreen's post, then straight down to the sill
  const a0 = screen[0];
  const a1 = screen[1];
  const postAt = (z: number, off: number): number => a0[0] + off + ((a1[0] - a0[0]) * (z - a0[1])) / (a1[1] - a0[1]);
  /** where the line along the post (offset `off` in u) reaches the height y (or, should it not, the post's top) */
  const meet = (y: number, off: number): P2 => {
    let lo = -1.3;
    let hi = -0.2;
    if (postAt(hi, off) - f.uAtY(hi, y) < 0) return [postAt(zt, off), zt];
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      if (postAt(m, off) - f.uAtY(m, y) < 0) lo = m;
      else hi = m;
    }
    return [postAt(hi, off), hi];
  };
  const sill = 0.33;
  const head = 0.88;
  const pillar = -0.013;
  const doorFront = -1.1;
  const doorRear = -0.06;
  // (the sill in short pieces: the cross-section changes fast along the door's front half)
  const sillLine: P2[] = [];
  for (let k = 0; k <= 10; k++) sillLine.push(side(doorFront + ((doorRear - doorFront) * k) / 10, sill));
  const door: P2[] = [...sillLine, side(doorRear, head), meet(head, pillar), [postAt(doorFront, pillar), doorFront]];
  // behind the door, a window that runs out under the wing's trailing edge
  const rear: P2[] = [side(0.04, sill), side(0.92, sill), side(1.3, 0.6), side(1.2, 0.82), side(0.04, head)];
  // and the window in the roof behind the wing
  const back: P2[] = [top(1.0, 0.36), top(1.52, 0.25), top(1.52, -0.25), top(1.0, -0.36)];
  add('glass', screen, false);
  add('glass', door, true);
  add('glass', rear, true);
  add('glass', back, false);
  // a dark rubber seal round each window
  for (const w of windows.slice()) regions.push(region('seal', grow(w.poly, 0.014, f.perimeter((w.z0 + w.z1) / 2))));

  // the joints round the doors and the one between cowling and cabin
  const doorEdge: P2[] = [meet(0.935, pillar + 0.006), [postAt(-1.14, pillar + 0.006), -1.14], side(-1.14, -0.36), side(0.0, -0.36), side(0.0, 0.935)];
  for (let i = 0; i < doorEdge.length; i++) add('seam', line(doorEdge[i], doorEdge[(i + 1) % doorEdge.length], 0.007, P), true);
  add('seam', [[0, -1.554], [1, -1.554], [1, -1.547], [0, -1.547]], false);

  // the cheat line with a thin gold line under it – in short pieces, so that it keeps its height where the
  // cross-section changes fast (round the windscreen)
  const band = (z: number): [number, number] => {
    let i = 0;
    while (i < CHEAT_LINE.length - 2 && z > CHEAT_LINE[i + 1][0]) i++;
    const [za, la, ha] = CHEAT_LINE[i];
    const [zc, lc, hc] = CHEAT_LINE[i + 1];
    const t = (z - za) / (zc - za);
    return [la + (lc - la) * t, ha + (hc - ha) * t];
  };
  const knots: number[] = [];
  for (let z = CHEAT_LINE[0][0]; z < CHEAT_LINE[CHEAT_LINE.length - 1][0] - 1e-6; z += z > -1.7 && z < -0.3 ? 0.09 : 0.3) knots.push(z);
  knots.push(CHEAT_LINE[CHEAT_LINE.length - 1][0]);
  for (let i = 0; i + 1 < knots.length; i++) {
    const za = knots[i];
    const zc = knots[i + 1];
    const [la, ha] = band(za);
    const [lc, hc] = band(zc);
    add('accent', [side(za, la - 0.035), side(zc, lc - 0.035), side(zc, lc - 0.02), side(za, la - 0.02)], true);
    add('stripe', [side(za, la), side(zc, lc), side(zc, hc), side(za, ha)], true);
  }
  return { regions, windows };
}

/** The cabin, where the skin is lined inside. */
const LINING_Z0 = -1.57;
const LINING_Z1 = 1.62;

interface SkinGeometry {
  parts: Record<Skin, THREE.BufferGeometry>;
  lining: THREE.BufferGeometry;
  reveals: THREE.BufferGeometry;
}

/**
 * The fuselage's skin: a grid over (u, z) whose cells are cut by the
 * regions.  The surface is evaluated exactly at the grid's corners; inside a
 * cell the corners of the pieces lie between them (bilinear) – so the pieces
 * of a cell and of its neighbours meet without cracks, and the windows' edges
 * run exactly where they are drawn, however coarse the grid.
 */
function buildSkin(f: Fuselage): SkinGeometry {
  const { regions, windows } = skinRegions(f);
  type V = { p: Vec3; n: Vec3 };
  // the grid: fine over the cabin, coarser on the tail cone
  const NU = 64;
  const raw: number[] = [];
  for (let z = f.z0; z < f.z1 - 1e-6; z += z < -1.6 ? 0.09 : z < 1.7 ? 0.075 : 0.16) raw.push(z);
  raw.push(f.z1, LINING_Z0, LINING_Z1);
  raw.sort((a, b) => a - b);
  const zs = raw.filter((z, i) => i === 0 || z - raw[i - 1] > 1e-4);
  const points = zs.map((z) => {
    const row: Vec3[] = [];
    for (let j = 0; j <= NU; j++) row.push(f.point(j / NU, z));
    return row;
  });
  // normals from the neighbours round and along
  const lattice: V[][] = points.map((row, i) =>
    row.map((p, j): V => {
      const k = j % NU;
      const tu = sub3(row[(k + 1) % NU], row[(k + NU - 1) % NU]);
      const tz = sub3(points[Math.min(points.length - 1, i + 1)][j], points[Math.max(0, i - 1)][j]);
      let n = unit3(cross3(tu, tz));
      const wide = f.section(p[2]).wide;
      if (n[0] * p[0] + n[1] * (p[1] - wide) < 0) n = [-n[0], -n[1], -n[2]];
      return { p, n };
    }),
  );
  const cache = new Map<number, V>();
  const vertex = (u: number, z: number, i: number, j: number): V => {
    const key = Math.round(u * 1e6) * 4e6 + Math.round((z + 10) * 1e5);
    const have = cache.get(key);
    if (have) return have;
    const s = Math.min(1, Math.max(0, u * NU - j));
    const t = Math.min(1, Math.max(0, (z - zs[i]) / (zs[i + 1] - zs[i])));
    const a = lattice[i][j];
    const b = lattice[i][j + 1];
    const c = lattice[i + 1][j];
    const d = lattice[i + 1][j + 1];
    const mix = (k: 'p' | 'n', m: number): number => (a[k][m] * (1 - s) + b[k][m] * s) * (1 - t) + (c[k][m] * (1 - s) + d[k][m] * s) * t;
    const v: V = { p: [mix('p', 0), mix('p', 1), mix('p', 2)], n: unit3([mix('n', 0), mix('n', 1), mix('n', 2)]) };
    cache.set(key, v);
    return v;
  };
  /** the cell a point of the skin lies in */
  const cell = (u: number, z: number): [number, number] => {
    let lo = 0;
    let hi = zs.length - 2;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (zs[m] <= z) lo = m;
      else hi = m - 1;
    }
    return [lo, Math.min(NU - 1, Math.max(0, Math.floor(u * NU)))];
  };

  const out = {} as Record<Skin, { pos: number[]; nor: number[] }>;
  for (const k of SKINS) out[k] = { pos: [], nor: [] };
  const lining = { pos: [] as number[], nor: [] as number[] };
  const push = (o: { pos: number[]; nor: number[] }, a: V, b: V, c: V): void => {
    o.pos.push(a.p[0], a.p[1], a.p[2], b.p[0], b.p[1], b.p[2], c.p[0], c.p[1], c.p[2]);
    o.nor.push(a.n[0], a.n[1], a.n[2], b.n[0], b.n[1], b.n[2], c.n[0], c.n[1], c.n[2]);
  };
  const triangle = (skin: Skin, a: V, b: V, c: V, lined: boolean): void => {
    const n = cross3(sub3(b.p, a.p), sub3(c.p, a.p));
    if (dot3(n, n) < 1e-18) return;
    // wound so that the face looks outwards
    if (dot3(n, [a.n[0] + b.n[0] + c.n[0], a.n[1] + b.n[1] + c.n[1], a.n[2] + b.n[2] + c.n[2]]) < 0) [b, c] = [c, b];
    push(out[skin], a, b, c);
    if (lined) push(lining, a, b, c);
  };
  const emit = (skin: Skin, poly: P2[], i: number, j: number): void => {
    if (poly.length < 3 || Math.abs(area2(poly)) < 1e-11) return;
    const vs = poly.map(([u, z]) => vertex(u, z, i, j));
    const zc = poly.reduce((sum, p) => sum + p[1], 0) / poly.length;
    const lined = skin !== 'glass' && zc > LINING_Z0 && zc < LINING_Z1;
    for (let k = 1; k + 1 < vs.length; k++) triangle(skin, vs[0], vs[k], vs[k + 1], lined);
  };
  for (let i = 0; i + 1 < zs.length; i++) {
    const lined = (zs[i] + zs[i + 1]) / 2 > LINING_Z0 && (zs[i] + zs[i + 1]) / 2 < LINING_Z1;
    const row = regions.filter((r) => r.z1 > zs[i] && r.z0 < zs[i + 1]);
    for (let j = 0; j < NU; j++) {
      const u0 = j / NU;
      const u1 = (j + 1) / NU;
      // most cells are plain paint: straight from the lattice
      if (!row.some((r) => r.u1 > u0 && r.u0 < u1)) {
        const a = lattice[i][j];
        const c = lattice[i + 1][j + 1];
        triangle('paint', a, lattice[i][j + 1], c, lined);
        triangle('paint', a, c, lattice[i + 1][j], lined);
        continue;
      }
      let pieces: P2[][] = [
        [
          [u0, zs[i]],
          [u1, zs[i]],
          [u1, zs[i + 1]],
          [u0, zs[i + 1]],
        ],
      ];
      for (const r of row) {
        if (r.u1 <= u0 || r.u0 >= u1) continue;
        const next: P2[][] = [];
        const n = r.poly.length;
        for (const piece of pieces) {
          let inside = piece;
          for (let k = 0; k < n && inside.length >= 3; k++) inside = clipHalf(inside, r.poly[k], r.poly[(k + 1) % n], 1);
          if (inside.length >= 3) emit(r.skin, inside, i, j);
          // what is left, in convex pieces: outside the first edge, then inside it and outside the next …
          let rest = piece;
          for (let k = 0; k < n && rest.length >= 3; k++) {
            const outside = clipHalf(rest, r.poly[k], r.poly[(k + 1) % n], -1);
            if (outside.length >= 3 && Math.abs(area2(outside)) > 1e-11) next.push(outside);
            rest = clipHalf(rest, r.poly[k], r.poly[(k + 1) % n], 1);
          }
        }
        pieces = next;
        if (!pieces.length) break;
      }
      for (const piece of pieces) emit('paint', piece, i, j);
    }
  }
  const geometry = (o: { pos: number[]; nor: number[] }): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(o.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(o.nor, 3));
    return g;
  };
  const parts = {} as Record<Skin, THREE.BufferGeometry>;
  for (const k of SKINS) parts[k] = geometry(out[k]);

  // the window openings' edges, seen from inside: the skin's thickness and the frame (flat faces)
  const reveal = { pos: [] as number[], nor: [] as number[] };
  const face = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): void => {
    const n = unit3(cross3(sub3(b, a), sub3(d, a)));
    const v = (p: Vec3): V => ({ p, n });
    push(reveal, v(a), v(b), v(c));
    push(reveal, v(a), v(c), v(d));
  };
  for (const w of windows) {
    const P = f.perimeter((w.z0 + w.z1) / 2);
    const ring: V[] = [];
    for (let i = 0; i < w.poly.length; i++) {
      const a = w.poly[i];
      const b = w.poly[(i + 1) % w.poly.length];
      const k = Math.max(1, Math.ceil(Math.hypot((b[0] - a[0]) * P, b[1] - a[1]) / 0.05));
      for (let s = 0; s < k; s++) {
        const u = a[0] + ((b[0] - a[0]) * s) / k;
        const z = a[1] + ((b[1] - a[1]) * s) / k;
        ring.push(vertex(u, z, ...cell(u, z)));
      }
    }
    const centre: Vec3 = [0, 0, 0];
    for (const v of ring) for (let k = 0; k < 3; k++) centre[k] += v.p[k] / ring.length;
    const depth = 0.03;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const qa: Vec3 = [a.p[0] - a.n[0] * depth, a.p[1] - a.n[1] * depth, a.p[2] - a.n[2] * depth];
      const qb: Vec3 = [b.p[0] - b.n[0] * depth, b.p[1] - b.n[1] * depth, b.p[2] - b.n[2] * depth];
      const n = cross3(sub3(b.p, a.p), sub3(qa, a.p));
      if (dot3(n, sub3(centre, a.p)) >= 0) face(a.p, b.p, qb, qa);
      else face(a.p, qa, qb, b.p);
    }
  }
  return { parts, lining: geometry(lining), reveals: geometry(reveal) };
}

// --------------------------------------------------------------------------------- the wing
const CHORD = T.chord;
const LE = T.wingLE;
const DIH = T.dihedral * DEG;
/** the wing's halves begin, and with them the dihedral, inside the cabin's sides */
const ROOT = 0.5;
/** where the flaps and ailerons begin (parts of the chord) */
const HINGE = 0.72;
/** the height of the chord line: the lowest point of the lower surface at the root is at TRAINER.wingY */
const Y0 = ((): number => {
  let low = 0;
  for (let i = 0; i <= 400; i++) low = Math.min(low, camber(i / 400, WING) - halfThick(i / 400, WING.t));
  return T.wingY - low * CHORD;
})();
/** span (along the half wing) of its tip, of the flaps and of the ailerons */
const S_END = (T.span / 2 - ROOT) / Math.cos(DIH);
const S_TIP = S_END - 0.5;
const FLAP_SPAN: P2 = [0.08, 2.38];
const AILERON_SPAN: P2 = [2.44, S_TIP - 0.01];

/** The frame of one half wing: at the root, tilted by the dihedral. */
function panelMatrix(side: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(side * ROOT, Y0, 0).multiply(new THREE.Matrix4().makeRotationZ(side * DIH));
}

/** A section of the wing at span s (half-wing frame), [chordwise, up] in parts of the chord. */
function wingRing(side: number, s: number, sec: P2[]): Vec3[] {
  return sec.map(([c, y]): Vec3 => [side * s, y * CHORD, LE + c * CHORD]);
}

interface HalfWing {
  fixed: THREE.BufferGeometry;
  flap: THREE.BufferGeometry;
  flapPivot: Vec3;
  aileron: THREE.BufferGeometry;
  aileronHinge: Vec3;
  /** points in the half wing's frame: the strut's upper end, lamps */
  strut: Vec3;
}

function halfWing(side: number): HalfWing {
  const main = foil(HINGE, 14, WING);
  const full = foil(1, 18, WING);
  const tail = aft(HINGE, 1, 7, WING);
  const fixed: THREE.BufferGeometry[] = [];
  const tube = (rings: Vec3[][], a: boolean, b: boolean): THREE.BufferGeometry => new Sculpt().tube(rings, a, b).build(35);
  fixed.push(tube([wingRing(side, 0, main), wingRing(side, S_TIP, main)], false, false));
  // the trailing edge between the cabin and the flap
  fixed.push(tube([wingRing(side, 0, tail.ring), wingRing(side, FLAP_SPAN[0] - 0.005, tail.ring)], false, true));
  // the tip: the whole section, rounded off
  const tip: Array<[number, number, number]> = [
    [S_TIP, 1, 1],
    [S_END - 0.16, 1, 1],
    [S_END - 0.09, 0.97, 0.86],
    [S_END - 0.05, 0.9, 0.64],
    [S_END - 0.02, 0.76, 0.38],
    [S_END, 0.52, 0.1],
  ];
  fixed.push(tube(tip.map(([s, kc, kt]) => wingRing(side, s, shrink(full, kc, kt, WING))), true, true));
  // filler caps on the top of the wing
  const capAt = (s: number, c: number): Vec3 => [side * s, (camber(c, WING) + halfThick(c, WING.t)) * CHORD, LE + c * CHORD];
  for (const s of [0.55]) {
    const p = capAt(s, 0.28);
    fixed.push(bare(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 12).translate(p[0], p[1] + 0.004, p[2])));
  }
  const flapRing = tail.ring;
  const flap = tube([wingRing(side, FLAP_SPAN[0], flapRing), wingRing(side, FLAP_SPAN[1], flapRing)], true, true);
  // the flap turns about a pivot below and ahead of it, and so moves aft as it goes down (a slotted flap)
  const pc = 0.66;
  const flapPivot: Vec3 = [0, (camber(pc, WING) - halfThick(pc, WING.t) - 0.05) * CHORD, LE + pc * CHORD];
  flap.translate(-flapPivot[0], -flapPivot[1], -flapPivot[2]);
  const aileron = tube([wingRing(side, AILERON_SPAN[0], tail.ring), wingRing(side, AILERON_SPAN[1], tail.ring)], true, true);
  const aileronHinge: Vec3 = [0, tail.hinge[1] * CHORD, LE + tail.hinge[0] * CHORD];
  aileron.translate(-aileronHinge[0], -aileronHinge[1], -aileronHinge[2]);
  const sc = 0.27;
  const strut: Vec3 = [side * 2.06, (camber(sc, WING) - halfThick(sc, WING.t)) * CHORD + 0.01, LE + sc * CHORD];
  return { fixed: merge(fixed), flap, flapPivot, aileron, aileronHinge, strut };
}

/** The wing's middle, over the cabin: the whole section, straight. */
function centreWing(): THREE.BufferGeometry {
  const full = foil(1, 18, WING);
  const ring = (x: number): Vec3[] => full.map(([c, y]): Vec3 => [x, Y0 + y * CHORD, LE + c * CHORD]);
  return new Sculpt().tube([ring(-ROOT - 0.002), ring(ROOT + 0.002)], false, false).build(35);
}

/** A streamlined strut from a to b (its long axis along the flight). */
function strutGeometry(a: Vec3, b: Vec3, chord: number, thick: number): THREE.BufferGeometry {
  const d = unit3(sub3(b, a));
  const e1 = unit3(sub3([0, 0, 1], [d[0] * d[2], d[1] * d[2], d[2] * d[2]]));
  const e2 = cross3(d, e1);
  const ring = (p: Vec3, k: number): Vec3[] => {
    const pts: Vec3[] = [];
    for (let i = 0; i < 12; i++) {
      const an = (i / 12) * Math.PI * 2;
      // a teardrop: rounder in front, pointed behind
      const c = Math.cos(an);
      const s = Math.sin(an) * (c < 0 ? 1 : 1 - 0.55 * c);
      pts.push([p[0] + (e1[0] * c * chord + e2[0] * s * thick) * k, p[1] + (e1[1] * c * chord + e2[1] * s * thick) * k, p[2] + (e1[2] * c * chord + e2[2] * s * thick) * k]);
    }
    return pts;
  };
  const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return new Sculpt().tube([ring(a, 1), ring(mid, 1), ring(b, 1)], true, true).build(70);
}

// --------------------------------------------------------------------------------- the tail
const CS = T.stabChord;
const STAB_LE = T.stabZ - 0.25 * CS;
const STAB_HINGE = 0.62;
/** the rudder's hinge line (vertical) and the fin's outline */
const RUDDER_Z = 5.09;
function finLE(y: number): number {
  const main = 4.12 + ((y - 0.42) * (4.8 - 4.12)) / (T.finTop - 0.42);
  // the dorsal fin sweeps forwards along the top of the tail cone
  const d = Math.max(0, 1 - (y - 0.36) / 0.34);
  return main - 0.8 * d * d;
}
function finTE(y: number): number {
  return y < 1.6 ? 5.46 + (y - 0.2) * 0.025 : 5.495 - ((y - 1.6) / 0.18) ** 2 * 0.14;
}
/** the fin's thickness: 10 % of its chord, but no fatter than 8.4 cm (the long dorsal part stays thin) */
function finScale(chord: number): number {
  return Math.min(1, 0.042 / (0.05 * chord));
}
function finHalf(y: number, z: number): number {
  const le = finLE(y);
  const chord = finTE(y) - le;
  return halfThick((z - le) / chord, TAIL.t) * chord * finScale(chord);
}

function stabRing(x: number, sec: P2[]): Vec3[] {
  return sec.map(([c, y]): Vec3 => [x, T.stabY + y * CS, STAB_LE + c * CS]);
}

/** The horizontal tail: the fixed stabiliser, and the elevator (both halves and the trim tab) about its hinge. */
function stabiliser(): { fixed: THREE.BufferGeometry; elevator: THREE.BufferGeometry; hinge: Vec3 } {
  const tube = (rings: Vec3[][], a: boolean, b: boolean): THREE.BufferGeometry => new Sculpt().tube(rings, a, b).build(35);
  const half = T.stabSpan / 2;
  const tipFrom = half - 0.12;
  const fixed = [tube([stabRing(-tipFrom, foil(STAB_HINGE, 12, TAIL)), stabRing(tipFrom, foil(STAB_HINGE, 12, TAIL))], false, false)];
  const full = foil(1, 14, TAIL);
  for (const side of [-1, 1]) {
    const tip: Array<[number, number, number]> = [
      [tipFrom, 1, 1],
      [half - 0.06, 0.95, 0.8],
      [half - 0.025, 0.85, 0.55],
      [half, 0.62, 0.15],
    ];
    fixed.push(tube(tip.map(([x, kc, kt]) => stabRing(side * x, shrink(full, kc, kt, TAIL))), true, true));
  }
  const el = aft(STAB_HINGE, 1, 6, TAIL);
  const cut = aft(STAB_HINGE, 0.9, 5, TAIL);
  const parts: THREE.BufferGeometry[] = [];
  const inner = 0.2;
  const outer = tipFrom - 0.005;
  parts.push(tube([stabRing(-outer, el.ring), stabRing(-inner, el.ring)], true, true));
  // the right half carries the trim tab in a notch of its trailing edge
  parts.push(tube([stabRing(inner, el.ring), stabRing(0.32, el.ring)], true, true));
  parts.push(tube([stabRing(0.32, cut.ring), stabRing(0.78, cut.ring)], true, true));
  parts.push(tube([stabRing(0.78, el.ring), stabRing(outer, el.ring)], true, true));
  const tab = strip(0.906, 1, 2, TAIL);
  parts.push(tube([stabRing(0.326, tab), stabRing(0.774, tab)], true, true));
  const hinge: Vec3 = [0, T.stabY + el.hinge[1] * CS, STAB_LE + el.hinge[0] * CS];
  const elevator = merge(parts).translate(-hinge[0], -hinge[1], -hinge[2]);
  return { fixed: merge(fixed), elevator, hinge };
}

/** The fin (fixed) and the rudder about its hinge line. */
function finAndRudder(): { fin: THREE.BufferGeometry; rudder: THREE.BufferGeometry; hinge: Vec3 } {
  const finRing = (y: number, kt = 1): Vec3[] => {
    const le = finLE(y);
    const chord = finTE(Math.min(y, 1.78)) - le;
    const h = (RUDDER_Z - le) / chord;
    const k = finScale(chord) * kt;
    const n = 12;
    const pts: Vec3[] = [];
    const cs: number[] = [];
    for (let i = 0; i <= n; i++) cs.push(h * (1 - Math.cos(((i / n) * Math.PI) / 2)));
    for (let i = n; i >= 0; i--) pts.push([halfThick(cs[i], TAIL.t) * chord * k, y, le + cs[i] * chord]);
    for (let i = 1; i <= n; i++) pts.push([-halfThick(cs[i], TAIL.t) * chord * k, y, le + cs[i] * chord]);
    return pts;
  };
  const heights: Array<[number, number]> = [
    [0.34, 1],
    [0.4, 1],
    [0.47, 1],
    [0.55, 1],
    [0.65, 1],
    [0.8, 1],
    [1.05, 1],
    [1.35, 1],
    [1.62, 1],
    [1.74, 1],
    [1.785, 0.85],
    [T.finTop, 0.45],
  ];
  const fin = new Sculpt().tube(heights.map(([y, k]) => finRing(y, k)), false, true).build(35);
  const hingeZ = RUDDER_Z + 0.018;
  const rudderRing = (y: number, kt = 1): Vec3[] => {
    const le = Math.max(finLE(y), 4.25);
    const te = finTE(y);
    const chord = te - le;
    const k = finScale(chord) * kt;
    const xn = (hingeZ - le) / chord;
    const r = halfThick(xn, TAIL.t) * chord * k;
    const n = 7;
    const pts: Vec3[] = [];
    for (let i = n; i >= 0; i--) {
      const c = xn + ((1 - xn) * i) / n;
      pts.push([halfThick(c, TAIL.t) * chord * k, y, le + c * chord]);
    }
    for (let j = 1; j < 6; j++) {
      const a = (j / 6) * Math.PI;
      pts.push([r * Math.cos(a), y, hingeZ - r * Math.sin(a)]);
    }
    for (let i = 0; i <= n; i++) {
      const c = xn + ((1 - xn) * i) / n;
      pts.push([-halfThick(c, TAIL.t) * chord * k, y, le + c * chord]);
    }
    return pts;
  };
  const rh: Array<[number, number]> = [
    [0.2, 0.7],
    [0.23, 1],
    [0.4, 1],
    [0.7, 1],
    [1.0, 1],
    [1.3, 1],
    [1.55, 1],
    [1.66, 1],
    [1.73, 0.95],
    [1.765, 0.8],
    [1.78, 0.45],
  ];
  const hinge: Vec3 = [0, 0, hingeZ];
  const rudder = new Sculpt().tube(rh.map(([y, k]) => rudderRing(y, k)), true, true).build(35).translate(0, 0, -hingeZ);
  return { fin, rudder, hinge };
}

// -------------------------------------------------------------------------- gear and propeller
/** A wheel fairing round the wheel's centre: a teardrop seen from above, the wheel showing below it. */
function spat(front: number, back: number, hw: number, top: number, bottom: number): THREE.BufferGeometry {
  const rings: Vec3[][] = [];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const z = -front + (front + back) * s;
    const k = s < 0.34 ? Math.sqrt(Math.max(0, 1 - ((0.34 - s) / 0.34) ** 2)) : Math.max(0, 1 - ((s - 0.34) / 0.66) ** 2) ** 0.75;
    const kk = Math.max(0.06, k);
    const yTop = bottom + (top - bottom) * (0.25 + 0.75 * kk);
    const yBot = bottom + (1 - kk) * 0.05;
    const yc = (yTop + yBot) / 2;
    const hh = (yTop - yBot) / 2;
    const ring: Vec3[] = [];
    for (let j = 0; j < 16; j++) {
      const a = (j / 16) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      ring.push([hw * kk * Math.sign(c) * Math.abs(c) ** 0.8, yc + hh * Math.sign(sn) * Math.abs(sn) ** 0.8, z]);
    }
    rings.push(ring);
  }
  return new Sculpt().tube(rings, true, true).build(50);
}

/** Tyre and hub of a wheel lying on the x axis, its centre at the origin. */
function wheelGeometry(radius: number, width: number): { tyre: THREE.BufferGeometry; hub: THREE.BufferGeometry } {
  const hub = radius * 0.52;
  const w = width / 2;
  const profile = [
    [hub, -w * 0.9],
    [radius * 0.8, -w],
    [radius * 0.95, -w * 0.85],
    [radius, -w * 0.45],
    [radius, w * 0.45],
    [radius * 0.95, w * 0.85],
    [radius * 0.8, w],
    [hub, w * 0.9],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const tyre = bare(new THREE.LatheGeometry(profile, 22).rotateZ(-Math.PI / 2));
  // a hub with six bolts, so that its turning shows
  const parts = [bare(new THREE.CylinderGeometry(hub, hub, width * 0.86, 12).rotateZ(Math.PI / 2))];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    for (const s of [-1, 1]) parts.push(block(s * width * 0.43 - 0.006, s * width * 0.43 + 0.006, Math.cos(a) * hub * 0.6 - 0.01, Math.cos(a) * hub * 0.6 + 0.01, Math.sin(a) * hub * 0.6 - 0.01, Math.sin(a) * hub * 0.6 + 0.01));
  }
  return { tyre, hub: merge(parts) };
}

/** Where a leg's strut is fixed (its upper end) and where its lower end is with the strut extended. */
interface LegShape {
  root: Vec3;
  foot: Vec3;
  outer: [number, number, number];
  inner: [number, number];
}

function legShape(leg: GearLeg): LegShape {
  if (leg.steers) return { root: [leg.x, -0.38, leg.z - 0.03], foot: [leg.x, leg.y + 0.21, leg.z], outer: [0.26, 0.036, 0.04], inner: [0.34, 0.024] };
  const s = Math.sign(leg.x);
  return { root: [s * 0.36, -0.4, leg.z - 0.01], foot: [leg.x - s * 0.11, leg.y + 0.06, leg.z], outer: [0.66, 0.036, 0.044], inner: [0.36, 0.027] };
}

/** One propeller blade along +y, its leading edge towards +x (it turns clockwise as the pilot sees it). */
function blade(r0: number, r1: number): THREE.BufferGeometry {
  const table: Array<[number, number, number, number]> = [
    // radius, chord, thickness, pitch angle
    [0.1, 0.06, 0.045, 52],
    [0.2, 0.1, 0.03, 40],
    [0.35, 0.135, 0.02, 29],
    [0.55, 0.14, 0.015, 21],
    [0.75, 0.125, 0.011, 16],
    [0.89, 0.1, 0.009, 13.5],
    [0.93, 0.085, 0.008, 13],
    [0.95, 0.04, 0.006, 12],
  ];
  const at = (r: number): [number, number, number] => {
    let i = 0;
    while (i < table.length - 2 && r > table[i + 1][0]) i++;
    const a = table[i];
    const b = table[i + 1];
    const t = Math.min(1, Math.max(0, (r - a[0]) / (b[0] - a[0])));
    return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, (a[3] + (b[3] - a[3]) * t) * DEG];
  };
  const rings: Vec3[][] = [];
  const radii = table.map((r) => r[0]).filter((r) => r > r0 + 1e-6 && r < r1 - 1e-6);
  for (const r of [r0, ...radii, r1]) {
    const [chord, thick, beta] = at(r);
    // the chord runs from the trailing edge back and to −x, to the leading edge forward and to +x
    const cd: Vec3 = [Math.cos(beta), 0, -Math.sin(beta)];
    const td: Vec3 = [Math.sin(beta), 0, Math.cos(beta)];
    const ring: Vec3[] = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const c = (Math.cos(a) * chord) / 2;
      const s = (Math.sin(a) * thick) / 2 * (Math.sin(a) > 0 ? 1.3 : 0.5);
      ring.push([cd[0] * c + td[0] * s, r, cd[2] * c + td[2] * s]);
    }
    rings.push(ring);
  }
  const one = new Sculpt().tube(rings, true, true).build(60);
  const two = one.clone().rotateZ(Math.PI);
  return merge([one, two]);
}

function spinnerGeometry(): THREE.BufferGeometry {
  const p = [
    [0.19, -0.085],
    [0.197, -0.06],
    [0.198, -0.01],
    [0.188, 0.05],
    [0.165, 0.11],
    [0.128, 0.17],
    [0.08, 0.225],
    [0.032, 0.265],
    [0.0, 0.28],
  ].map(([r, a]) => new THREE.Vector2(r, a));
  // (the lathe's axis is y: turned so that its tip points forward, to −z)
  return bare(new THREE.LatheGeometry(p, 24).rotateX(-Math.PI / 2));
}

// -------------------------------------------------------------------------------- textures
let glowTexture: THREE.Texture | null = null;
function glow(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}

let discTexture: THREE.Texture | null = null;
/** The turning propeller as the eye sees it: a faint grey disc, the painted tips a brighter ring. */
function disc(): THREE.Texture {
  if (discTexture) return discTexture;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(40,42,46,0)');
  g.addColorStop(0.2, 'rgba(40,42,46,0.3)');
  g.addColorStop(0.5, 'rgba(40,42,46,0.2)');
  g.addColorStop(0.9, 'rgba(40,42,46,0.12)');
  g.addColorStop(0.93, 'rgba(240,200,40,0.2)');
  g.addColorStop(0.98, 'rgba(240,200,40,0.17)');
  g.addColorStop(1, 'rgba(240,200,40,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 256);
  discTexture = new THREE.CanvasTexture(c);
  discTexture.colorSpace = THREE.SRGBColorSpace;
  return discTexture;
}

let letteringTexture: THREE.Texture | null = null;
function lettering(): THREE.Texture {
  if (letteringTexture) return letteringTexture;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const x = c.getContext('2d')!;
  x.font = 'italic 800 104px system-ui, "Segoe UI", Roboto, "Noto Sans", "DejaVu Sans", sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  const w = x.measureText('Fahrsim').width;
  if (w > 488) x.font = `italic 800 ${Math.floor((104 * 488) / w)}px system-ui, "Segoe UI", Roboto, "Noto Sans", "DejaVu Sans", sans-serif`;
  x.fillStyle = '#1b57a3';
  x.fillText('Fahrsim', 256, 68);
  letteringTexture = new THREE.CanvasTexture(c);
  letteringTexture.colorSpace = THREE.SRGBColorSpace;
  letteringTexture.anisotropy = 8;
  return letteringTexture;
}

/** The lettering, lying on the fin's surface on both sides (each reads from nose to tail as seen from its side… or back). */
function letteringGeometry(side: number): THREE.BufferGeometry {
  const y0 = 0.94;
  const y1 = 1.1;
  const z0 = 4.5;
  const z1 = 5.04;
  const nz = 14;
  const ny = 3;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= ny; j++) {
    const y = y0 + ((y1 - y0) * j) / ny;
    for (let i = 0; i <= nz; i++) {
      const z = z0 + ((z1 - z0) * i) / nz;
      pos.push(side * (finHalf(y, z) + 0.003), y, z);
      nor.push(side, 0, 0);
      // seen from the right the text runs from the tail to the nose, from the left from the nose to the tail
      uv.push(side > 0 ? 1 - i / nz : i / nz, j / ny);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nz; i++) {
      const a = j * (nz + 1) + i;
      const b = a + 1;
      const c = a + nz + 1;
      const d = c + 1;
      if (side > 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------------- the shared geometry
interface Lamp {
  at: Vec3;
  colour: number;
}

interface Exterior {
  fuselage: Fuselage;
  paint: THREE.BufferGeometry;
  stripe: THREE.BufferGeometry;
  accent: THREE.BufferGeometry;
  seam: THREE.BufferGeometry;
  rubber: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  metal: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  lining: THREE.BufferGeometry;
  reveals: THREE.BufferGeometry;
  letters: THREE.BufferGeometry[];
  panels: THREE.Matrix4[];
  wings: HalfWing[];
  elevator: THREE.BufferGeometry;
  elevatorHinge: Vec3;
  rudder: THREE.BufferGeometry;
  rudderHinge: Vec3;
  blades: THREE.BufferGeometry;
  tips: THREE.BufferGeometry;
  spinner: THREE.BufferGeometry;
  legs: LegShape[];
  outer: THREE.BufferGeometry[];
  inner: THREE.BufferGeometry[];
  spats: THREE.BufferGeometry[];
  tyres: THREE.BufferGeometry[];
  hubs: THREE.BufferGeometry[];
  fork: THREE.BufferGeometry;
  /** navigation lights (with their colours), strobes, beacon, landing and taxi light */
  nav: Lamp[];
  strobes: Vec3[];
  beacon: Vec3;
  landing: Vec3;
  taxi: Vec3;
  tailLight: Vec3;
}

let EXTERIOR: Exterior | null = null;

/** Builds the outside once; every aeroplane shares it. */
function exterior(): Exterior {
  if (EXTERIOR) return EXTERIOR;
  const f = new Fuselage(STATIONS);
  const skin = buildSkin(f);
  const paint = [skin.parts.paint];
  const dark: THREE.BufferGeometry[] = [];
  const metal: THREE.BufferGeometry[] = [];

  // the cowling's front round the spinner, its air inlets
  const hubY = T.propHub[1];
  const outer: Vec3[] = [];
  const inner: Vec3[] = [];
  for (let j = 0; j <= 64; j++) {
    const p = f.point(j / 64, f.z0);
    const dx = p[0];
    const dy = p[1] - hubY;
    const l = Math.hypot(dx, dy) || 1;
    outer.push(p);
    inner.push([(dx / l) * 0.206, hubY + (dy / l) * 0.206, f.z0 + 0.014]);
  }
  paint.push(new Sculpt().sheet([outer, inner], [0, 0, -1]).build(80));
  const front: Vec3 = [0, 0, -1];
  for (const s of [-1, 1]) dark.push(oval([s * 0.252, 0.085, f.z0 - 0.002], [1, 0, 0], [0, 1, 0], 0.036, 0.05, front));
  dark.push(oval([0, -0.212, f.z0 - 0.002], [1, 0, 0], [0, 1, 0], 0.075, 0.03, front));
  // the end of the tail cone
  const end: Vec3[] = [];
  for (let j = 0; j < 64; j++) end.push(f.point(j / 64, f.z1));
  paint.push(new Sculpt().fan(end, [0, 0, 1]).build());

  // the wing: its middle over the cabin, the halves with their struts
  paint.push(centreWing());
  const panels = [panelMatrix(-1), panelMatrix(1)];
  const wings = [halfWing(-1), halfWing(1)];
  const strutFoot = (s: number): Vec3 => [s * 0.47, -0.27, 0.02];
  wings.forEach((w, i) => {
    paint.push(w.fixed.clone().applyMatrix4(panels[i]));
    const top = new THREE.Vector3(...w.strut).applyMatrix4(panels[i]);
    paint.push(strutGeometry(strutFoot(i ? 1 : -1), [top.x, top.y + 0.03, top.z], 0.05, 0.02));
  });

  // the tail
  const stab = stabiliser();
  const fin = finAndRudder();
  paint.push(stab.fixed, fin.fin);

  // gear: struts fixed to the fuselage, the parts that move with the wheels built round their own origin
  const legs = T.gear.map(legShape);
  const outerTubes = legs.map((l) => bare(new THREE.CylinderGeometry(l.outer[1], l.outer[2], l.outer[0], 12).translate(0, -l.outer[0] / 2, 0)));
  const innerTubes = legs.map((l) => bare(new THREE.CylinderGeometry(l.inner[1], l.inner[1], l.inner[0], 10).translate(0, l.inner[0] / 2, 0)));
  const spats = T.gear.map((g) => (g.steers ? spat(0.27, 0.33, 0.085, 0.2, -0.1) : spat(0.36, 0.44, 0.105, 0.23, -0.12)));
  const wheels = T.gear.map((g) => wheelGeometry(g.radius, g.steers ? 0.11 : 0.13));
  // the nose wheel's fork crown on top of its fairing, and a torque link behind the strut
  const fork = merge([block(-0.075, 0.075, -0.025, 0.02, -0.045, 0.045), block(-0.012, 0.012, 0.0, 0.12, 0.03, 0.05)]);

  // the propeller: blades with painted tips, the spinner
  const blades = blade(0.1, 0.89);
  const tips = blade(0.89, 0.95);
  const spinner = spinnerGeometry();

  // small things: exhaust, antennas, pitot tube, door handles
  dark.push(pipe([[0.17, -0.36, -1.88], [0.18, -0.47, -1.84], [0.19, -0.53, -1.76]], 0.024, 10));
  dark.push(
    new Sculpt()
      .tube(
        [
          [
            [0.004, 0.8, 1.86],
            [0.004, 0.8, 2.02],
            [-0.004, 0.8, 2.02],
            [-0.004, 0.8, 1.86],
          ],
          [
            [0.002, 1.04, 2.0],
            [0.002, 1.04, 2.06],
            [-0.002, 1.04, 2.06],
            [-0.002, 1.04, 2.0],
          ],
        ],
        true,
        true,
      )
      .build(30),
  );
  dark.push(pipe([[0, -0.45, 1.2], [0, -0.62, 1.42], [0, -0.7, 1.58]], [0.006, 0.004, 0.003], 6));
  const pitotBase = new THREE.Vector3(-1.45, (camber(0.2, WING) - halfThick(0.2, WING.t)) * CHORD + 0.01, LE + 0.2 * CHORD).applyMatrix4(panels[0]);
  metal.push(pipe([[pitotBase.x, pitotBase.y, pitotBase.z], [pitotBase.x, pitotBase.y - 0.09, pitotBase.z - 0.02], [pitotBase.x, pitotBase.y - 0.1, pitotBase.z - 0.08], [pitotBase.x, pitotBase.y - 0.1, LE - 0.22]], [0.012, 0.01, 0.008, 0.007], 8));
  for (const s of [-1, 1]) {
    const x = f.wallX(-0.16, 0.26);
    dark.push(block(s * x - 0.012, s * x + 0.012, 0.25, 0.27, -0.24, -0.12));
  }

  // lamps: navigation lights and strobes in the wing tips, the beacon on the fin, landing and taxi light in the left wing
  const inPanel = (i: number, p: Vec3): Vec3 => new THREE.Vector3(...p).applyMatrix4(panels[i]).toArray() as Vec3;
  const nav: Lamp[] = [
    { at: inPanel(0, [-(S_END - 0.03), 0.01, LE + 0.2]), colour: 0xff2a1a },
    { at: inPanel(1, [S_END - 0.03, 0.01, LE + 0.2]), colour: 0x2aff5a },
  ];
  const strobes = [inPanel(0, [-(S_END - 0.01), 0.02, LE + 0.5]), inPanel(1, [S_END - 0.01, 0.02, LE + 0.5])];
  const beacon: Vec3 = [0, T.finTop + 0.03, finLE(T.finTop) + 0.14];
  const landing = inPanel(0, [-1.75, 0.0, LE - 0.004]);
  const taxi = inPanel(0, [-1.95, 0.0, LE - 0.004]);
  const tailLight: Vec3 = [0, 0.3, finTE(0.3) + 0.012];

  EXTERIOR = {
    fuselage: f,
    paint: merge(paint),
    stripe: skin.parts.stripe,
    accent: skin.parts.accent,
    seam: skin.parts.seam,
    rubber: skin.parts.seal,
    dark: merge(dark),
    metal: merge(metal),
    glass: skin.parts.glass,
    lining: skin.lining,
    reveals: skin.reveals,
    letters: [letteringGeometry(-1), letteringGeometry(1)],
    panels,
    wings,
    elevator: stab.elevator,
    elevatorHinge: stab.hinge,
    rudder: fin.rudder,
    rudderHinge: fin.hinge,
    blades,
    tips,
    spinner,
    legs,
    outer: outerTubes,
    inner: innerTubes,
    spats,
    tyres: wheels.map((w) => w.tyre),
    hubs: wheels.map((w) => w.hub),
    fork,
    nav,
    strobes,
    beacon,
    landing,
    taxi,
    tailLight,
  };
  return EXTERIOR;
}

// ------------------------------------------------------------------------------- the cockpit
/** The panel's plane: its lower edge, and how far it leans back. */
const PANEL_Y = 0.08;
const PANEL_Z = -0.99;
const PANEL_TILT = 12 * DEG;
/** the panel's plate reaches below and above the pictures */
const PLATE_V: P2 = [-0.1, PANEL_AREA.height + 0.022];

function onPanel(x: number, v: number, w = 0): Vec3 {
  return [x, PANEL_Y + v * Math.cos(PANEL_TILT) + w * Math.sin(PANEL_TILT), PANEL_Z - v * Math.sin(PANEL_TILT) + w * Math.cos(PANEL_TILT)];
}

interface Interior {
  shield: THREE.BufferGeometry;
  plate: THREE.BufferGeometry;
  wall: THREE.BufferGeometry;
  pale: THREE.BufferGeometry;
  fabric: THREE.BufferGeometry;
  carpet: THREE.BufferGeometry;
  black: THREE.BufferGeometry;
  chrome: THREE.BufferGeometry;
  red: THREE.BufferGeometry;
  yoke: THREE.BufferGeometry;
  yokeShaft: THREE.BufferGeometry;
  pedal: THREE.BufferGeometry;
  knob: THREE.BufferGeometry;
}

let INTERIOR: Interior | null = null;

function interior(f: Fuselage): Interior {
  if (INTERIOR) return INTERIOR;
  const shield: THREE.BufferGeometry[] = [];
  const wall: THREE.BufferGeometry[] = [];
  const black: THREE.BufferGeometry[] = [];
  const chrome: THREE.BufferGeometry[] = [];
  const fabric: THREE.BufferGeometry[] = [];

  // the panel's plate, as wide as the cabin
  const rows: Vec3[][] = [];
  for (let i = 0; i <= 8; i++) {
    const v = PLATE_V[0] + ((PLATE_V[1] - PLATE_V[0]) * i) / 8;
    const p = onPanel(0, v);
    const hw = f.wallX(p[2], p[1]) - 0.012;
    rows.push([onPanel(-hw, v), onPanel(hw, v)]);
  }
  const plate = new Sculpt().sheet(rows, [0, Math.sin(PANEL_TILT), Math.cos(PANEL_TILT)]).build();

  // the glare shield over it, running forward to the foot of the windscreen
  const topEdge = onPanel(0, PLATE_V[1]);
  const profile: P2[] = [
    [-0.012, 0.012],
    [0.0, 0.042],
    [0.019, 0.046],
    [0.028, 0.022],
    [0.026, -0.08],
    [0.012, -0.2],
    [0.004, -0.27],
  ];
  const across = 14;
  const shelf: Vec3[][] = profile.map(([dy, dz]) => {
    const z = topEdge[2] + dz;
    const y = topEdge[1] + dy;
    const hw = f.wallX(z, Math.min(y, f.section(z).top - 0.05)) - 0.012;
    const row: Vec3[] = [];
    for (let i = 0; i <= across; i++) {
      const x = -hw + (2 * hw * i) / across;
      row.push([x, Math.min(y, f.roofY(z, x) - 0.012), z]);
    }
    return row;
  });
  const glare = new Sculpt().sheet(shelf, [0, 1, 0.35]);
  glare.fan(shelf.map((r) => r[0]), [-1, 0, 0]);
  glare.fan(shelf.map((r) => r[r.length - 1]), [1, 0, 0]);
  shield.push(glare.build(50));
  // under the panel: its lower side, and the firewall behind the pedals
  const low = onPanel(0, PLATE_V[0]);
  const under: Vec3[][] = [low[2], low[2] - 0.12, low[2] - 0.3].map((z, i) => {
    const y = low[1] + i * 0.01;
    const hw = f.wallX(z, y) - 0.012;
    return [
      [-hw, y, z],
      [hw, y, z],
    ];
  });
  shield.push(new Sculpt().sheet(under, [0, -1, 0]).build());
  const firewall: Vec3[] = [];
  for (let j = 0; j < 48; j++) firewall.push(f.point(j / 48, -1.555));
  shield.push(new Sculpt().fan(firewall, [0, 0, 1]).build());

  // floor, headliner under the wing, the wall behind the seats
  const floorY = -0.42;
  const floor: Vec3[][] = [];
  for (let z = -1.54; z <= 1.55; z += 0.31) {
    const hw = f.wallX(z, floorY) - 0.006;
    floor.push([
      [-hw, floorY, z],
      [hw, floorY, z],
    ]);
  }
  const rug = [new Sculpt().sheet(floor, [0, 1, 0]).build()];
  // the carpet runs up the walls of the footwells
  for (const s of [-1, 1]) {
    const rows: Vec3[][] = [];
    for (let z = -1.54; z <= 0.7; z += 0.28) rows.push([floorY, -0.3, -0.2, -0.1].map((y): Vec3 => [s * (f.wallX(z, y) - 0.008), y, z]));
    rug.push(new Sculpt().sheet(rows, [-s, 0, 0]).build());
  }
  const carpet = merge(rug);
  const ceilY = 0.915;
  const ceil: Vec3[][] = [];
  for (let z = -0.6; z <= 0.98; z += 0.158) {
    const hw = f.wallX(z, ceilY) - 0.004;
    ceil.push([
      [-hw, ceilY, z],
      [hw, ceilY, z],
    ]);
  }
  const pale = new Sculpt().sheet(ceil, [0, -1, 0]).build();
  const bulkhead: Vec3[] = [];
  for (let j = 0; j < 48; j++) bulkhead.push(f.point(j / 48, 1.56));
  wall.push(new Sculpt().fan(bulkhead, [0, 0, -1]).build());
  // the baggage shelf behind the seats
  wall.push(slab(0.86, 0.03, 0.5, 0.01, [0, -0.2, 1.28]));

  // the seats
  const ex = T.eye[0];
  for (const x of [ex, -ex]) {
    fabric.push(slab(0.46, 0.11, 0.47, 0.045, [x, -0.245, -0.5], -0.06));
    fabric.push(slab(0.44, 0.68, 0.1, 0.045, [x, 0.13, -0.19], 15 * DEG));
    fabric.push(slab(0.26, 0.15, 0.08, 0.035, [x, 0.56, -0.08], 15 * DEG));
    black.push(block(x - 0.135, x - 0.105, floorY, -0.3, -0.7, -0.25), block(x + 0.105, x + 0.135, floorY, -0.3, -0.7, -0.25));
  }
  // armrests and handles on the doors
  for (const s of [-1, 1]) {
    const x = f.wallX(-0.55, 0.17) - 0.03;
    wall.push(slab(0.045, 0.035, 0.52, 0.012, [s * x, 0.17, -0.55]));
    black.push(block(s * (x + 0.005) - 0.01, s * (x + 0.005) + 0.01, 0.24, 0.26, -0.33, -0.22));
  }
  // the mixture knob (red) beside the throttle, the magnetic compass on the glare shield
  const red = bare(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 12).rotateX(Math.PI / 2).translate(0.07, 0.0, PANEL_Z + 0.03));
  chrome.push(bare(new THREE.CylinderGeometry(0.0045, 0.0045, 0.03, 8).rotateX(Math.PI / 2).translate(0.07, 0.0, PANEL_Z + 0.008)));
  const compass = onPanel(0, PLATE_V[1], 0);
  black.push(slab(0.055, 0.042, 0.05, 0.01, [compass[0] + 0.05, compass[1] + 0.052, compass[2] - 0.05]));

  // the moving parts: a yoke (ram's horns on a hub, a shaft into the panel), a pedal, the throttle knob
  const yoke = merge([
    pipe(
      [
        [-0.15, 0.085, 0],
        [-0.152, 0.035, 0],
        [-0.141, -0.008, 0],
        [-0.102, -0.032, 0],
        [-0.04, -0.04, 0],
        [0.04, -0.04, 0],
        [0.102, -0.032, 0],
        [0.141, -0.008, 0],
        [0.152, 0.035, 0],
        [0.15, 0.085, 0],
      ],
      0.0135,
      10,
    ),
    slab(0.09, 0.065, 0.05, 0.018, [0, -0.03, -0.012]),
  ]);
  const yokeShaft = bare(new THREE.CylinderGeometry(0.011, 0.011, 0.42, 10).rotateX(Math.PI / 2).translate(0, -0.03, -0.24));
  const pedal = merge([slab(0.075, 0.13, 0.014, 0.012, [0, 0.07, 0], -0.4), block(-0.008, 0.008, 0.0, 0.2, 0.0, 0.02)]);
  const knob = merge([bare(new THREE.CylinderGeometry(0.017, 0.017, 0.032, 14).rotateX(Math.PI / 2).translate(0, 0, 0.016)), bare(new THREE.CylinderGeometry(0.0045, 0.0045, 0.12, 8).rotateX(Math.PI / 2).translate(0, 0, -0.06))]);

  INTERIOR = {
    shield: merge(shield),
    plate,
    wall: merge(wall),
    pale,
    fabric: merge(fabric),
    carpet,
    black: merge(black),
    chrome: merge(chrome),
    red: merge([red]),
    yoke,
    yokeShaft,
    pedal,
    knob,
  };
  return INTERIOR;
}

// ---------------------------------------------------------------------------------- the model
interface LegParts {
  spec: GearLeg;
  root: THREE.Vector3;
  foot: THREE.Vector3;
  outer: THREE.Object3D;
  inner: THREE.Object3D;
  /** the wheel with its fairing (and the nose wheel's fork), moving with the strut */
  carriage: THREE.Object3D;
  spin: THREE.Object3D;
}

const DOWN = new THREE.Vector3(0, -1, 0);

export class PlaneModel {
  readonly root = new THREE.Group();
  /** the pilot's eyes (TRAINER.eye) */
  readonly eye = new THREE.Vector3(T.eye[0], T.eye[1], T.eye[2]);
  /** an aeroplane has no mirrors to draw */
  readonly mirrors: Mirror[] = [];
  private readonly ailerons: THREE.Object3D[] = [];
  private readonly flaps: THREE.Object3D[] = [];
  private readonly elevator = new THREE.Group();
  private readonly rudder = new THREE.Group();
  private readonly prop = new THREE.Group();
  private readonly legs: LegParts[] = [];
  // materials of this aeroplane alone: what fades, what lights up, what turns see-through
  private readonly bladeMat = new THREE.MeshLambertMaterial({ color: 0x26282b, transparent: true });
  private readonly tipMat = new THREE.MeshLambertMaterial({ color: 0xe8b81e, transparent: true });
  private readonly discMat = new THREE.MeshBasicMaterial({ map: disc(), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  private readonly disc: THREE.Mesh;
  private readonly glass = new THREE.MeshPhongMaterial({ color: 0x18242e, specular: 0x9fb4c4, shininess: 120, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false });
  private readonly lining: THREE.MeshLambertMaterial;
  private readonly frames: THREE.MeshLambertMaterial;
  private readonly navMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  private readonly strobeMat = new THREE.MeshBasicMaterial({ color: 0xc8ccd0, toneMapped: false });
  private readonly beaconMat = new THREE.MeshBasicMaterial({ color: 0x5a1210, toneMapped: false });
  private readonly landingMat = new THREE.MeshBasicMaterial({ color: 0xb8bec4, toneMapped: false });
  private readonly taxiMat = new THREE.MeshBasicMaterial({ color: 0xb8bec4, toneMapped: false });
  private readonly navGlows: THREE.Sprite[] = [];
  private readonly strobeGlows: THREE.Sprite[] = [];
  private readonly beaconGlow: THREE.Sprite;
  private readonly landingGlow: THREE.Mesh;
  private readonly taxiGlow: THREE.Mesh;
  /** what this aeroplane alone owns (the shared geometry stays) */
  private readonly owned: Array<{ dispose(): void }> = [];
  // the cockpit
  private readonly panel: FlightPanel | null = null;
  private panelSeen = true;
  private readonly yokes: Array<{ slide: THREE.Object3D; wheel: THREE.Object3D }> = [];
  private readonly pedals: THREE.Object3D[] = [];
  private readonly throttle = new THREE.Group();
  private readonly seeThrough: THREE.Material[] = [];
  private cabinOpacity = 1;
  private readonly tmp = new THREE.Vector3();
  private lastFrame = -1;
  private lastCamera: THREE.Camera | null = null;
  private lastInside = false;

  constructor(options: PlaneModelOptions = {}) {
    const withInterior = options.interior ?? true;
    const x = exterior();
    const root = this.root;
    root.name = 'aeroplane';
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = root, shadow = true): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadow;
      parent.add(m);
      return m;
    };

    // ---- the outside, fixed
    mesh(x.paint, PAINT);
    mesh(x.stripe, STRIPE);
    mesh(x.accent, ACCENT, root, false);
    mesh(x.seam, SEAM, root, false);
    mesh(x.rubber, RUBBER, root, false);
    mesh(x.dark, DARK);
    mesh(x.metal, METAL);
    const letters = new THREE.MeshLambertMaterial({ map: lettering(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.owned.push(letters);
    for (const g of x.letters) mesh(g, letters, root, false);
    // the cabin's inside: lining and window frames (see-through on request), then the glass
    this.lining = cabinMaterial(0x8f918d, THREE.BackSide);
    this.frames = cabinMaterial(0x3b3f45);
    mesh(x.lining, this.lining, root, false);
    mesh(x.reveals, this.frames, root, false);
    const glass = mesh(x.glass, this.glass, root, false);
    glass.renderOrder = 5;
    // (seen from inside, the glass is clear; from outside it is darker – and quite dark on an aeroplane without a cockpit)
    this.glass.onBeforeRender = (renderer, _scene, camera) => {
      this.glass.opacity = this.inside(renderer, camera) ? 0.1 : withInterior ? 0.42 : 0.7;
    };
    this.owned.push(this.glass, this.lining, this.frames, this.bladeMat, this.tipMat, this.discMat, this.navMat, this.strobeMat, this.beaconMat, this.landingMat, this.taxiMat);
    this.seeThrough.push(this.lining, this.frames);

    // ---- control surfaces on their hinges
    x.wings.forEach((w, i) => {
      const frame = new THREE.Group();
      frame.matrixAutoUpdate = false;
      frame.matrix.copy(x.panels[i]);
      root.add(frame);
      const aileron = new THREE.Group();
      aileron.position.set(...w.aileronHinge);
      mesh(w.aileron, PAINT, aileron);
      const flap = new THREE.Group();
      flap.position.set(...w.flapPivot);
      mesh(w.flap, PAINT, flap);
      frame.add(aileron, flap);
      this.ailerons.push(aileron);
      this.flaps.push(flap);
    });
    this.elevator.position.set(...x.elevatorHinge);
    mesh(x.elevator, PAINT, this.elevator);
    this.rudder.position.set(...x.rudderHinge);
    mesh(x.rudder, PAINT, this.rudder);
    root.add(this.elevator, this.rudder);

    // ---- the propeller
    this.prop.position.set(...T.propHub);
    mesh(x.blades, this.bladeMat, this.prop, false);
    mesh(x.tips, this.tipMat, this.prop, false);
    mesh(x.spinner, STRIPE, this.prop);
    this.disc = new THREE.Mesh(new THREE.RingGeometry(0.2, T.propDiameter / 2, 48, 1), this.discMat);
    this.owned.push(this.disc.geometry);
    this.disc.visible = false;
    this.prop.add(this.disc);
    root.add(this.prop);

    // ---- the gear
    x.legs.forEach((shape, i) => {
      const spec = T.gear[i];
      const outer = new THREE.Group();
      outer.position.set(...shape.root);
      mesh(x.outer[i], PAINT, outer);
      const inner = new THREE.Group();
      mesh(x.inner[i], CHROME, inner);
      const carriage = new THREE.Group();
      const spin = new THREE.Group();
      mesh(x.tyres[i], TYRE, spin);
      mesh(x.hubs[i], HUB, spin);
      if (spec.steers) {
        // turning about the strut: the fork, the fairing and the wheel below it
        mesh(x.fork, DARK, carriage);
        const s = mesh(x.spats[i], PAINT, carriage);
        s.position.set(0, spec.y - shape.foot[1], 0);
        spin.position.set(0, spec.y - shape.foot[1], 0);
      } else {
        mesh(x.spats[i], PAINT, carriage);
      }
      carriage.add(spin);
      root.add(outer, inner, carriage);
      this.legs.push({ spec, root: new THREE.Vector3(...shape.root), foot: new THREE.Vector3(...shape.foot), outer, inner, carriage, spin });
    });

    // ---- lights
    /** a round lamp; the navigation lights carry their colour in the geometry and share one material */
    const lens = (at: Vec3, r: number, colour?: number): THREE.BufferGeometry => {
      const g = bare(new THREE.SphereGeometry(r, 10, 8).translate(...at));
      if (colour !== undefined) {
        const c = new THREE.Color(colour);
        const n = g.getAttribute('position').count;
        const col = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) col.set([c.r, c.g, c.b], k * 3);
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      }
      return g;
    };
    const own = <G extends { dispose(): void }>(g: G): G => {
      this.owned.push(g);
      return g;
    };
    const sprite = (at: Vec3, colour: number, size: number, parent: THREE.Object3D = root): THREE.Sprite => {
      const m = new THREE.SpriteMaterial({ map: glow(), color: colour, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
      this.owned.push(m);
      const s = new THREE.Sprite(m);
      s.position.set(...at);
      s.scale.setScalar(size);
      s.visible = false;
      parent.add(s);
      return s;
    };
    mesh(own(mergeGeometries(x.nav.map((l) => lens(l.at, 0.032, l.colour)), false)!), this.navMat, root, false);
    for (const l of x.nav) this.navGlows.push(sprite(l.at, l.colour, 0.32));
    const tail = new THREE.Vector3(...x.tailLight).sub(new THREE.Vector3(...x.rudderHinge));
    mesh(own(lens(tail.toArray() as Vec3, 0.022, 0xffffff)), this.navMat, this.rudder, false);
    this.navGlows.push(sprite(tail.toArray() as Vec3, 0xffffff, 0.26, this.rudder));
    mesh(own(mergeGeometries(x.strobes.map((p) => lens(p, 0.026)), false)!), this.strobeMat, root, false);
    for (const p of x.strobes) this.strobeGlows.push(sprite(p, 0xffffff, 1.3));
    mesh(own(bare(new THREE.SphereGeometry(0.032, 12, 8).scale(1, 1.3, 1).translate(...x.beacon))), this.beaconMat, root, false);
    this.beaconGlow = sprite(x.beacon, 0xff2a1a, 0.75);
    const forward: Vec3 = [0, 0, -1];
    mesh(own(oval(x.landing, [1, 0, 0], [0, 1, 0], 0.05, 0.035, forward)), this.landingMat, root, false);
    mesh(own(oval(x.taxi, [1, 0, 0], [0, 1, 0], 0.04, 0.03, forward)), this.taxiMat, root, false);
    const beam = (at: Vec3, size: number): THREE.Mesh => {
      const m = new THREE.MeshBasicMaterial({ map: glow(), color: 0xfff6dc, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
      this.owned.push(m);
      const g = new THREE.Mesh(own(new THREE.PlaneGeometry(size, size).rotateY(Math.PI)), m);
      g.position.set(at[0], at[1], at[2] - 0.01);
      g.visible = false;
      root.add(g);
      return g;
    };
    this.landingGlow = beam(x.landing, 0.7);
    this.taxiGlow = beam(x.taxi, 0.5);

    if (withInterior) {
      this.panel = new FlightPanel();
      this.buildCockpit(x.fuselage, mesh);
    }
  }

  /** The cockpit: panel, glare shield, yokes, pedals, throttle, seats, floor and headliner. */
  private buildCockpit(f: Fuselage, mesh: (geo: THREE.BufferGeometry, mat: THREE.Material, parent?: THREE.Object3D, shadow?: boolean) => THREE.Mesh): void {
    const g = interior(f);
    const cockpit = new THREE.Group();
    cockpit.name = 'cockpit';
    this.root.add(cockpit);
    const m = {
      shield: cabinMaterial(0x202226),
      plate: cabinMaterial(PANEL_PAINT),
      wall: cabinMaterial(0x8f918d),
      pale: cabinMaterial(0xc4c5c1),
      fabric: cabinMaterial(0x4a5466),
      carpet: cabinMaterial(0x2c2e32),
      black: cabinMaterial(0x18191c),
      chrome: cabinMaterial(0xb9bec4),
      red: cabinMaterial(0xb3261e),
    };
    for (const k of Object.keys(m) as Array<keyof typeof m>) {
      this.seeThrough.push(m[k]);
      this.owned.push(m[k]);
    }
    for (const k of ['shield', 'plate', 'wall', 'pale', 'fabric', 'carpet', 'black', 'chrome', 'red'] as const) mesh(g[k], m[k], cockpit, false);
    // the pictures on the panel: lit like the panel round them, and a little by themselves
    const panel = this.panel!;
    const face = (tex: THREE.Texture, x0: number, x1: number): THREE.Mesh => {
      const mat = new THREE.MeshLambertMaterial({ map: tex, emissiveMap: tex, color: new THREE.Color(0.6, 0.6, 0.6), emissive: new THREE.Color(0.42, 0.42, 0.42) });
      this.owned.push(mat);
      const p = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, PANEL_AREA.height), mat);
      this.owned.push(p.geometry);
      const c = onPanel((x0 + x1) / 2, PANEL_AREA.height / 2, 0.0015);
      p.position.set(...c);
      p.rotation.x = -PANEL_TILT;
      cockpit.add(p);
      return p;
    };
    const live = face(panel.texture, PANEL_AREA.left, PANEL_AREA.split);
    // (redrawn only while somebody looks at it)
    live.onBeforeRender = () => {
      this.panelSeen = true;
    };
    face(panel.radios, PANEL_AREA.split, PANEL_AREA.right);

    // yokes and their shafts, out of the panel below the instruments
    for (const x of [T.eye[0], -T.eye[0]]) {
      const slide = new THREE.Group();
      slide.position.set(x, 0.035, -0.8);
      const wheel = new THREE.Group();
      mesh(g.yoke, m.black, wheel, false);
      slide.add(wheel);
      mesh(g.yokeShaft, m.chrome, slide, false);
      cockpit.add(slide);
      this.yokes.push({ slide, wheel });
    }
    // rudder pedals: left and right for each seat
    for (const x of [T.eye[0], -T.eye[0]]) {
      for (const s of [-1, 1]) {
        const p = new THREE.Group();
        p.position.set(x + s * 0.09, -0.37, -1.3);
        mesh(g.pedal, m.black, p, false);
        cockpit.add(p);
        this.pedals.push(p);
      }
    }
    // the throttle: a black knob on a plunger in the middle of the panel's lower edge
    this.throttle.position.set(-0.01, 0.0, PANEL_Z + 0.02);
    mesh(g.knob, m.black, this.throttle, false);
    cockpit.add(this.throttle);
    // the decision what is see-through is made per picture
    for (const mat of this.seeThrough) {
      mat.onBeforeRender = (renderer, _scene, camera) => {
        mat.opacity = this.cabinOpacity < 1 && this.inside(renderer, camera) ? this.cabinOpacity : 1;
      };
    }
  }

  /** Whether a camera is inside the cabin (computed once per picture). */
  private inside(renderer: THREE.WebGLRenderer, camera: THREE.Camera): boolean {
    const frame = renderer.info.render.frame;
    if (frame === this.lastFrame && camera === this.lastCamera) return this.lastInside;
    this.lastFrame = frame;
    this.lastCamera = camera;
    const p = this.root.worldToLocal(this.tmp.setFromMatrixPosition(camera.matrixWorld));
    this.lastInside = Math.abs(p.x) < 0.58 && p.y > -0.5 && p.y < 1.0 && p.z > -1.3 && p.z < 1.6;
    return this.lastInside;
  }

  /**
   * How solid the cabin looks from the pilot's seat: 1 = solid, less = the
   * world shows through walls, panel frame, seats and yokes (the
   * instruments stay solid).  From outside the cabin is always solid.
   */
  setCabinOpacity(opacity: number): void {
    const o = Number.isFinite(opacity) ? Math.min(1, Math.max(0.05, opacity)) : 1;
    const on = o < 0.995;
    const was = this.cabinOpacity < 1;
    this.cabinOpacity = on ? o : 1;
    if (on === was) return;
    for (const m of this.seeThrough) {
      m.transparent = on;
      m.depthWrite = !on;
      m.opacity = 1;
      m.needsUpdate = true;
    }
  }

  /** Moves the control surfaces, propeller, wheels, cockpit controls, lights and instruments. */
  update(s: PlaneVisualState, _dt: number, now: number): void {
    const num = (v: number | undefined, d = 0): number => (v !== undefined && Number.isFinite(v) ? v : d);
    // control surfaces (left aileron down for a roll to the right, right one up)
    this.ailerons[0].rotation.x = num(s.aileron);
    this.ailerons[1].rotation.x = -num(s.aileron);
    const flap = Math.max(0, num(s.flapsDeg)) * DEG;
    for (const f of this.flaps) f.rotation.x = flap;
    this.elevator.rotation.x = -num(s.elevator);
    this.rudder.rotation.y = num(s.rudder);

    // the propeller turns clockwise as the pilot sees it; fast, it becomes a faint disc
    this.prop.rotation.z = -num(s.propAngle);
    const rpm = num(s.rpm);
    const k = Math.min(1, Math.max(0, (rpm - 380) / 420));
    const blur = k * k * (3 - 2 * k);
    this.bladeMat.opacity = 1 - 0.94 * blur;
    this.tipMat.opacity = 1 - 0.9 * blur;
    this.discMat.opacity = blur * 0.6;
    this.disc.visible = blur > 0.01;

    // the gear: each strut shortens by its compression, the wheel turns (and the nose wheel steers)
    const dir = this.tmp;
    this.legs.forEach((leg, i) => {
      const w = s.wheels?.[i];
      const c = num(w?.compression);
      leg.carriage.position.set(leg.spec.steers ? leg.foot.x : leg.spec.x, (leg.spec.steers ? leg.foot.y : leg.spec.y) + c, leg.spec.z);
      leg.carriage.rotation.y = leg.spec.steers ? -num(w?.steer) : 0;
      leg.spin.rotation.x = -num(w?.spin);
      leg.inner.position.set(leg.foot.x, leg.foot.y + c, leg.foot.z);
      dir.subVectors(leg.inner.position, leg.root).normalize();
      leg.outer.quaternion.setFromUnitVectors(DOWN, dir);
      leg.inner.quaternion.copy(leg.outer.quaternion);
    });

    // lights: navigation steady, strobes a double flash, the beacon a red flash
    const L = s.lights ?? { nav: false, beacon: false, strobe: false, landing: false, taxi: false };
    this.navMat.color.setScalar(L.nav ? 1 : 0.32);
    for (const g of this.navGlows) g.visible = L.nav;
    const t = num(now);
    const sp = ((t % 1.2) + 1.2) % 1.2;
    const flash = L.strobe && (sp < 0.05 || (sp > 0.14 && sp < 0.19));
    this.strobeMat.color.setHex(flash ? 0xffffff : 0xc8ccd0);
    for (const g of this.strobeGlows) g.visible = flash;
    const bp = ((t % 1.1) + 1.1) % 1.1;
    const beacon = L.beacon && bp < 0.16;
    this.beaconMat.color.setHex(beacon ? 0xff2a1a : 0x5a1210);
    this.beaconGlow.visible = beacon;
    this.landingMat.color.setHex(L.landing ? 0xffffff : 0xb8bec4);
    this.landingGlow.visible = L.landing;
    this.taxiMat.color.setHex(L.taxi ? 0xffffff : 0xb8bec4);
    this.taxiGlow.visible = L.taxi;

    // the cockpit's controls
    if (this.panel) {
      for (const y of this.yokes) {
        y.slide.position.z = -0.8 + Math.max(-1, Math.min(1, num(s.yoke?.pitch))) * 0.07;
        y.wheel.rotation.z = -Math.max(-1, Math.min(1, num(s.yoke?.roll))) * 1.2;
      }
      const p = Math.max(-1, Math.min(1, num(s.pedals))) * 0.05;
      this.pedals.forEach((pedal, i) => {
        pedal.position.z = -1.3 + (i % 2 ? -p : p);
      });
      this.throttle.position.z = PANEL_Z + 0.02 + (1 - Math.max(0, Math.min(1, num(s.throttle)))) * 0.06;
      if (this.panelSeen && this.panel.update(s, t)) this.panelSeen = false;
    }
  }

  dispose(): void {
    this.panel?.dispose();
    for (const o of this.owned) o.dispose();
  }
}
