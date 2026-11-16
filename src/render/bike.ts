// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The player's motorcycle and its rider, built in four sizes – one for each
 * motorcycle class: a 50 cm³ moped (AM), a slim 125 (A1), a naked twin of
 * 35 kW (A2) and a larger four-cylinder (A).  Generic machines of their kind:
 * no real make or model is reproduced.
 *
 * Built like the other vehicles around the point the physics use – the
 * ground below the middle of the wheelbase –, x to the right, y up, the front
 * towards −z; wheelbase and wheel size are those of the class's physics
 * (sim/vehicle/fleet.ts).  Everything but the root leans into the bend about
 * the line where the tyres touch the road.  The front – fork, wheel,
 * handlebar with instruments, lamp and mirrors – turns about the raked
 * steering axis, the rider's arms follow the grips, and fork and swing arm
 * follow the heights of the wheels in the physics.
 *
 * Seen through the rider's own eyes his helmet is not drawn: it leaves itself
 * out of any picture taken from inside it (its shadow stays, and the mirrors,
 * whose cameras stand elsewhere, still show it).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MOPED, MOTORCYCLE, MOTORCYCLE_125, MOTORCYCLE_35KW } from '../sim/vehicle/fleet.ts';
import type { VehicleSpec } from '../sim/vehicle/index.ts';
import type { CarVisualState } from './car.ts';
import { Lamps } from './fleet.ts';
import type { VehicleModel } from './fleet.ts';
import { InstrumentPanel } from './instruments.ts';
import { Mirror } from './mirrors.ts';
import { LAMP, TAIL } from './truck.ts';

/** The four builds: moped (AM), light 125 (A1), mid 35 kW (A2), big (A). */
export type BikeVariant = 'moped' | 'light' | 'mid' | 'big';

const DEG = Math.PI / 180;
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const V = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------------------- geometry
// Every part is made as position + normal without an index, so that the parts of one
// material can be merged into one mesh.

function bare(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(n.attributes)) if (name !== 'position' && name !== 'normal') n.deleteAttribute(name);
  return n;
}

/** A closed outline: an ellipse (p = 1) or, with smaller p, a rounder rectangle; [u, v] pairs counter-clockwise. */
function oval(a: number, b: number, n = 16, p = 1): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push([a * Math.sign(c) * Math.abs(c) ** p, b * Math.sign(s) * Math.abs(s) ** p]);
  }
  return out;
}

const circle = (r: number, n = 12): number[][] => oval(r, r, n);

/** An outline whose upper half (v > 0) reaches `up`, its lower half `down`: a tank or a seat in section. */
function section(hw: number, up: number, down: number, n = 20, p = 0.72): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push([hw * Math.sign(c) * Math.abs(c) ** p, (s >= 0 ? up : down) * Math.sign(s) * Math.abs(s) ** p]);
  }
  return out;
}

/** A thin strip in section, half width hw, its edges bent by `curl` towards +v, `thick` thick: a mudguard, a screen. */
function strip(hw: number, curl: number, thick: number, n = 8): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const u = -1 + (2 * i) / n;
    pts.push([u * hw, curl * u * u - thick / 2]);
  }
  for (let i = n; i >= 0; i--) {
    const u = -1 + (2 * i) / n;
    pts.push([u * hw, curl * u * u + thick / 2]);
  }
  return pts;
}

/** A rectangle w × h with corners of radius r. */
function rounded(w: number, h: number, r: number, seg = 2): number[][] {
  const q = Math.max(0.0004, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4));
  const pts: number[][] = [];
  const corners = [
    [w / 2 - q, -h / 2 + q, -90],
    [w / 2 - q, h / 2 - q, 0],
    [-w / 2 + q, h / 2 - q, 90],
    [-w / 2 + q, -h / 2 + q, 180],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = (a0 + (90 * i) / seg) * DEG;
      pts.push([cx + Math.cos(a) * q, cy + Math.sin(a) * q]);
    }
  }
  return pts;
}

/** A flat outline put into space: centre + u·[0] + v·[1]. */
function ring(c: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, outline: number[][]): THREE.Vector3[] {
  return outline.map(([a, b]) => c.clone().addScaledVector(u, a).addScaledVector(v, b));
}

/** Two directions square to `d` and to each other. */
function across(d: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const u = (Math.abs(d.x) < 0.9 ? X : Y).clone();
  u.addScaledVector(d, -u.dot(d)).normalize();
  return [u, new THREE.Vector3().crossVectors(d, u)];
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

function centroid(r: THREE.Vector3[]): THREE.Vector3 {
  const c = V();
  for (const p of r) c.add(p);
  return c.multiplyScalar(1 / r.length);
}

/** Whether a skin over these rings, in the order given, would look inwards (and must be turned round). */
function inwards(rings: THREE.Vector3[][]): boolean {
  const n = rings[0].length;
  let out = 0;
  for (let i = 0; i + 1 < rings.length; i++) {
    const m = centroid(rings[i]);
    for (let j = 0; j < n; j++) {
      const a = rings[i][j];
      _a.subVectors(rings[i][(j + 1) % n], a).cross(_b.subVectors(rings[i + 1][(j + 1) % n], a));
      out += _a.dot(_c.subVectors(a, m));
    }
  }
  return out < 0;
}

/**
 * A skin over rings of points (all of the same length), shaded smooth all
 * round; the sides look away from the middle of the rings.  The ends are
 * closed by flat caps (unless `caps` is false, or a ring has shrunk to a point).
 */
function loft(rings: THREE.Vector3[][], caps = true, flip = inwards(rings)): THREE.BufferGeometry {
  const n = rings[0].length;
  const pos: number[] = [];
  for (const r of rings) for (const p of r) pos.push(p.x, p.y, p.z);
  const mids = rings.map(centroid);
  const idx: number[] = [];
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      const a = i * n + j;
      const b = i * n + k;
      const c = (i + 1) * n + k;
      const d = (i + 1) * n + j;
      if (flip) idx.push(a, c, b, a, d, c);
      else idx.push(a, b, c, a, c, d);
    }
  }
  if (caps) {
    for (const [i, next] of [
      [0, 1],
      [rings.length - 1, rings.length - 2],
    ]) {
      const r = rings[i];
      const m = mids[i];
      if (r.every((p) => p.distanceToSquared(m) < 1e-10)) continue;
      // (its own corners, so that the edge stays sharp)
      const base = pos.length / 3;
      pos.push(m.x, m.y, m.z);
      for (const p of r) pos.push(p.x, p.y, p.z);
      const nrm = V();
      for (let j = 0; j < n; j++) nrm.add(_a.subVectors(r[j], m).cross(_b.subVectors(r[(j + 1) % n], m)));
      const away = nrm.dot(_c.subVectors(m, mids[next])) >= 0;
      for (let j = 0; j < n; j++) {
        const k = (j + 1) % n;
        if (away) idx.push(base, base + 1 + j, base + 1 + k);
        else idx.push(base, base + 1 + k, base + 1 + j);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return bare(g);
}

/**
 * A bar along a smooth path through `points`, in cross-section `shape(t)`
 * (t = 0 … 1 along the path), its first coordinate towards `side`.
 */
function sweep(points: THREE.Vector3[], shape: (t: number) => number[][], steps: number, side = X, caps = true): THREE.BufferGeometry {
  const curve = points.length > 2 ? new THREE.CatmullRomCurve3(points, false, 'centripetal') : new THREE.LineCurve3(points[0], points[1]);
  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const c = curve.getPointAt(t);
    const tan = curve.getTangentAt(t).normalize();
    let u = side.clone().addScaledVector(tan, -side.dot(tan));
    if (u.lengthSq() < 1e-6) u = across(tan)[0];
    u.normalize();
    rings.push(ring(c, u, new THREE.Vector3().crossVectors(tan, u), shape(t)));
  }
  return loft(rings, caps);
}

/** A round pipe through `points`. */
function pipe(points: THREE.Vector3[], r: number, steps = 16, n = 10): THREE.BufferGeometry {
  return sweep(points, () => circle(r, n), steps);
}

/** A straight rod from a to b (radius r at a, r2 at b). */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, n = 8, r2 = r): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r2, r, d.length(), n);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y, d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return bare(g);
}

/**
 * A solid of revolution about `axis` through `centre`: a profile of [radius,
 * position along the axis]; `hard` keeps every corner of the profile sharp
 * (discs, rims, covers) instead of shading over it.
 */
function turned(profile: number[][], centre: THREE.Vector3, axis: THREE.Vector3, n = 24, hard = false): THREE.BufferGeometry {
  const ax = axis.clone().normalize();
  const [u, v] = across(ax);
  const rings = profile.map(([r, a]) => ring(centre.clone().addScaledVector(ax, a), u, v, circle(r, n)));
  if (!hard) return loft(rings, false);
  // each step of the profile a skin of its own, all turned the same way round
  const flip = inwards(rings);
  const steps: THREE.BufferGeometry[] = [];
  for (let i = 0; i + 1 < rings.length; i++) steps.push(loft([rings[i], rings[i + 1]], false, flip));
  return mergeGeometries(steps, false)!;
}

/** An ellipsoid, turned (YXZ) and moved into place. */
function blob(c: THREE.Vector3, rx: number, ry: number, rz: number, rot?: THREE.Euler, w = 16, h = 10): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, w, h);
  g.scale(rx, ry, rz);
  if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rot));
  g.translate(c.x, c.y, c.z);
  return bare(g);
}

/** A box w × h × d with rounded edges (`r`), turned (YXZ) about its middle and moved to `c`. */
function soap(c: THREE.Vector3, w: number, h: number, d: number, r = Math.min(w, h, d) * 0.25, rot?: THREE.Euler): THREE.BufferGeometry {
  const e = Math.min(r * 0.8, w * 0.3);
  const rings = [
    [-w / 2, e],
    [-w / 2 + e, 0],
    [w / 2 - e, 0],
    [w / 2, e],
  ].map(([x, s]) => ring(V(x, 0, 0), Z, Y, rounded(d - 2 * s, h - 2 * s, r - s)));
  const g = loft(rings);
  if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rot));
  return g.translate(c.x, c.y, c.z);
}

/** A limb or a pin: rounded at both ends, its radius from ra at a to rb at b. */
function limb(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, n = 14): THREE.BufferGeometry {
  const ax = b.clone().sub(a).normalize();
  const [u, v] = across(ax);
  const rings: THREE.Vector3[][] = [];
  const cap = 4;
  for (let i = 0; i <= cap; i++) {
    const t = (Math.PI / 2) * (1 - i / cap);
    rings.push(ring(a.clone().addScaledVector(ax, -ra * Math.sin(t)), u, v, circle(ra * Math.cos(t), n)));
  }
  for (let i = 0; i <= cap; i++) {
    const t = (Math.PI / 2) * (i / cap);
    rings.push(ring(b.clone().addScaledVector(ax, rb * Math.sin(t)), u, v, circle(rb * Math.cos(t), n)));
  }
  return loft(rings, false);
}

/** Cross-sections along z ([z, half width, top, bottom], front to rear): a tank, a seat, a tail. */
function stations(list: Station[], n = 22, p = 0.72): THREE.BufferGeometry {
  return loft(list.map(([z, hw, top, bottom]) => ring(V(0, (top + bottom) / 2, z), X, Y, section(hw, (top - bottom) / 2, (top - bottom) / 2, n, p))));
}

/** One measure (index i of [z, half width, top, bottom]) of a shape at z, between its cross-sections. */
function between(list: Station[], z: number, i: number): number {
  if (z <= list[0][0]) return list[0][i];
  for (let k = 0; k + 1 < list.length; k++) {
    const [z0, z1] = [list[k][0], list[k + 1][0]];
    if (z <= z1) return list[k][i] + ((list[k + 1][i] - list[k][i]) * (z - z0)) / (z1 - z0);
  }
  return list[list.length - 1][i];
}

/** The point where a limb of two parts (l1 from `a`, l2 to `b`) bends, towards `pole`; a straight limb when it cannot reach. */
function bend(a: THREE.Vector3, b: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const d = _a.subVectors(b, a);
  const dist = d.length();
  d.normalize();
  if (dist >= l1 + l2 - 1e-4) return out.copy(a).addScaledVector(d, (dist * l1) / (l1 + l2));
  const k = Math.max(dist, Math.abs(l1 - l2) + 1e-4);
  const x = (l1 * l1 - l2 * l2 + k * k) / (2 * k);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const p = _b.copy(pole).addScaledVector(d, -pole.dot(d)).normalize();
  return out.copy(a).addScaledVector(d, x).addScaledVector(p, h);
}

/** Geometry collected per material, merged into one mesh each. */
class Parts {
  private readonly lists = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(m: THREE.Material, ...g: THREE.BufferGeometry[]): void {
    const l = this.lists.get(m);
    if (l) l.push(...g);
    else this.lists.set(m, [...g]);
  }

  /** The meshes, in `group` whose origin lies at `origin` (in the frame the parts were made in). */
  into(group: THREE.Object3D, origin?: THREE.Vector3, shadow = true): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [m, list] of this.lists) {
      const g = mergeGeometries(list, false)!;
      if (origin) g.translate(-origin.x, -origin.y, -origin.z);
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = shadow;
      group.add(mesh);
      out.push(mesh);
    }
    return out;
  }
}

// ------------------------------------------------------------------------------ materials
const lambert = (color: number): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color });
const TYRE = lambert(0x18191b);
const BLACK = lambert(0x1e2023);
const ENGINE = lambert(0x3a3d42);
const ALU = lambert(0x969ba1);
const SEAT = lambert(0x212226);
const RADIATOR = lambert(0x141619);
/** the few parts that should glint: chrome and polished steel, the gold of a fork, the visor */
const CHROME = new THREE.MeshPhongMaterial({ color: 0xc4c8cc, shininess: 90, specular: 0x8c8c8c });
const STEEL = new THREE.MeshPhongMaterial({ color: 0x8e9398, shininess: 50, specular: 0x555555 });
const GOLD = new THREE.MeshPhongMaterial({ color: 0xb98d34, shininess: 60, specular: 0x6a5a30 });
const VISOR = new THREE.MeshPhongMaterial({ color: 0x0e1215, shininess: 110, specular: 0x9aa4ac });
const SMOKE = new THREE.MeshPhongMaterial({ color: 0x3a4652, shininess: 100, specular: 0x8a96a0, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
/** the indicators while dark (the lamps switch them, see fleet.ts Lamps) */
const DIM = lambert(0x3a2d2a);
// the rider: a grey textile suit, boots and gloves of black leather, a white helmet
const JACKET = lambert(0x59606a);
const TROUSERS = lambert(0x363b44);
const BOOTS = lambert(0x151619);
const GLOVES = lambert(0x1b1c1f);
const HELMET = lambert(0xe9ebec);

type Station = [number, number, number, number];

/** How one class's motorcycle is built. */
interface Build {
  /** its physics: wheelbase and wheel radius */
  spec: VehicleSpec;
  /** the steering axis: its angle from the vertical (rad), how far its foot lies ahead of the tyre's contact (m) */
  rake: number;
  trail: number;
  /** tyre widths front and rear, radius of the rims */
  tyres: [number, number];
  rim: number;
  /** wire spokes, else cast wheels of `spokes` spokes (each split in two towards the rim) */
  wire: boolean;
  spokes: number;
  split: boolean;
  /** brake discs at the front (one or two) and their radius; the rear one's (0: a drum) */
  discs: number;
  disc: number;
  rearDisc: number;
  /** the fork: half the distance between its legs, radius of its thin tubes, upside down (the thick tubes on top) */
  forkGap: number;
  forkR: number;
  usd: boolean;
  /** height of the top of the steering axis (the upper triple clamp) */
  clampY: number;
  /** the grips: half the width of the handlebar, their height, how far behind the top of the axis */
  grip: [number, number, number];
  /** headlamp: height of its middle, its radius; a cowl round it that carries the instruments (and a screen) */
  lampY: number;
  lampR: number;
  cowl: boolean;
  screen: boolean;
  /** the rider: height of the seat under him, where his hips are (z), the footpegs [x, y, z], his back's lean forward (rad) */
  seatY: number;
  hipZ: number;
  peg: [number, number, number];
  lean: number;
  /** cross-sections [z, half width, top, bottom] of tank, seat and tail, front to rear */
  tank: Station[];
  seat: Station[];
  tail: Station[];
  /** crankcase: middle (y, z), half width, height, length; cylinders: number, lean forward (rad), length, radius; fins (air-cooled) */
  crank: [number, number, number, number, number];
  cylinders: [number, number, number, number];
  fins: boolean;
  /** the exhaust: where the silencer begins and ends, its radius */
  silencer: [THREE.Vector3, THREE.Vector3, number];
  /** two shock absorbers at the back, else one under the seat */
  twinShock: boolean;
  /** the frame: steel tubes round the engine, a lattice of thin tubes, or two beams of aluminium */
  frameKind: 'tube' | 'lattice' | 'beam';
  /** colours: paint, frame and swing arm, wheels, springs */
  paint: number;
  frame: number;
  wheels: number;
  spring: number;
}

const BUILDS: Record<BikeVariant, Build> = {
  moped: {
    spec: MOPED.manual,
    rake: 27 * DEG,
    trail: 0.085,
    tyres: [0.08, 0.095],
    rim: 0.238,
    wire: true,
    spokes: 32,
    split: false,
    discs: 1,
    disc: 0.13,
    rearDisc: 0,
    forkGap: 0.085,
    forkR: 0.017,
    usd: false,
    clampY: 0.95,
    grip: [0.33, 1.06, 0.0],
    lampY: 0.9,
    lampR: 0.072,
    cowl: false,
    screen: false,
    seatY: 0.8,
    hipZ: 0.17,
    peg: [0.15, 0.32, 0.13],
    lean: 10 * DEG,
    tank: [
      [-0.42, 0.05, 0.92, 0.86],
      [-0.39, 0.105, 0.955, 0.81],
      [-0.3, 0.13, 0.985, 0.79],
      [-0.18, 0.128, 0.99, 0.8],
      [-0.08, 0.11, 0.975, 0.82],
      [-0.02, 0.08, 0.945, 0.84],
      [0.0, 0.04, 0.92, 0.86],
    ],
    seat: [
      [-0.03, 0.05, 0.86, 0.82],
      [0.0, 0.09, 0.85, 0.79],
      [0.08, 0.12, 0.818, 0.76],
      [0.2, 0.13, 0.802, 0.75],
      [0.36, 0.125, 0.806, 0.755],
      [0.52, 0.11, 0.815, 0.765],
      [0.62, 0.085, 0.815, 0.775],
      [0.66, 0.045, 0.805, 0.785],
    ],
    tail: [
      [0.3, 0.12, 0.775, 0.66],
      [0.45, 0.12, 0.785, 0.68],
      [0.6, 0.1, 0.795, 0.71],
      [0.7, 0.07, 0.795, 0.74],
      [0.74, 0.04, 0.79, 0.76],
    ],
    crank: [0.35, 0.03, 0.095, 0.19, 0.25],
    cylinders: [1, 1.12, 0.17, 0.042],
    fins: true,
    silencer: [V(0.13, 0.42, 0.38), V(0.14, 0.53, 0.7), 0.034],
    twinShock: true,
    frameKind: 'tube',
    paint: 0xbf242b,
    frame: 0x26282c,
    wheels: 0xc4c8cc,
    spring: 0xb9bdc2,
  },
  light: {
    spec: MOTORCYCLE_125.manual,
    rake: 26 * DEG,
    trail: 0.092,
    tyres: [0.1, 0.13],
    rim: 0.216,
    wire: false,
    spokes: 5,
    split: false,
    discs: 1,
    disc: 0.14,
    rearDisc: 0.1,
    forkGap: 0.092,
    forkR: 0.019,
    usd: false,
    clampY: 0.97,
    grip: [0.345, 1.075, 0.015],
    lampY: 0.9,
    lampR: 0.078,
    cowl: false,
    screen: false,
    seatY: 0.815,
    hipZ: 0.18,
    peg: [0.16, 0.335, 0.15],
    lean: 12 * DEG,
    tank: [
      [-0.43, 0.055, 0.93, 0.86],
      [-0.4, 0.12, 0.965, 0.8],
      [-0.31, 0.15, 1.0, 0.78],
      [-0.19, 0.148, 1.015, 0.785],
      [-0.08, 0.125, 0.995, 0.81],
      [-0.01, 0.09, 0.96, 0.84],
      [0.015, 0.045, 0.93, 0.86],
    ],
    seat: [
      [-0.02, 0.05, 0.87, 0.83],
      [0.01, 0.1, 0.86, 0.8],
      [0.09, 0.135, 0.83, 0.77],
      [0.2, 0.145, 0.815, 0.76],
      [0.32, 0.14, 0.825, 0.765],
      [0.4, 0.125, 0.85, 0.78],
      [0.44, 0.115, 0.87, 0.8],
      [0.58, 0.105, 0.88, 0.815],
      [0.66, 0.08, 0.875, 0.825],
      [0.7, 0.04, 0.865, 0.835],
    ],
    tail: [
      [0.3, 0.13, 0.8, 0.67],
      [0.45, 0.13, 0.84, 0.7],
      [0.6, 0.11, 0.86, 0.74],
      [0.74, 0.08, 0.865, 0.78],
      [0.82, 0.05, 0.86, 0.81],
      [0.845, 0.03, 0.85, 0.825],
    ],
    crank: [0.36, 0.0, 0.115, 0.22, 0.3],
    cylinders: [1, 0.3, 0.22, 0.05],
    fins: true,
    silencer: [V(0.155, 0.35, 0.3), V(0.17, 0.5, 0.66), 0.05],
    twinShock: true,
    frameKind: 'tube',
    paint: 0xeceeef,
    frame: 0x1f5fa8,
    wheels: 0x24262a,
    spring: 0x1f5fa8,
  },
  mid: {
    spec: MOTORCYCLE_35KW.manual,
    rake: 25 * DEG,
    trail: 0.098,
    tyres: [0.11, 0.16],
    rim: 0.216,
    wire: false,
    spokes: 6,
    split: false,
    discs: 2,
    disc: 0.148,
    rearDisc: 0.11,
    forkGap: 0.1,
    forkR: 0.021,
    usd: false,
    clampY: 0.985,
    grip: [0.35, 1.09, 0.035],
    lampY: 0.93,
    lampR: 0.08,
    cowl: true,
    screen: false,
    seatY: 0.826,
    hipZ: 0.19,
    peg: [0.165, 0.355, 0.16],
    lean: 14 * DEG,
    tank: [
      [-0.445, 0.06, 0.935, 0.865],
      [-0.42, 0.125, 0.97, 0.805],
      [-0.34, 0.165, 1.01, 0.775],
      [-0.23, 0.17, 1.04, 0.775],
      [-0.12, 0.155, 1.04, 0.795],
      [-0.03, 0.125, 1.01, 0.825],
      [0.02, 0.085, 0.97, 0.855],
      [0.035, 0.045, 0.94, 0.875],
    ],
    seat: [
      [-0.035, 0.055, 0.875, 0.835],
      [-0.005, 0.1, 0.865, 0.8],
      [0.07, 0.14, 0.84, 0.775],
      [0.18, 0.155, 0.826, 0.765],
      [0.29, 0.155, 0.83, 0.77],
      [0.37, 0.14, 0.85, 0.78],
      [0.41, 0.12, 0.88, 0.8],
      [0.46, 0.115, 0.895, 0.825],
      [0.58, 0.105, 0.902, 0.84],
      [0.67, 0.08, 0.895, 0.845],
      [0.71, 0.04, 0.882, 0.85],
    ],
    tail: [
      [0.3, 0.13, 0.8, 0.665],
      [0.43, 0.14, 0.85, 0.695],
      [0.57, 0.125, 0.87, 0.735],
      [0.71, 0.09, 0.88, 0.78],
      [0.82, 0.06, 0.88, 0.815],
      [0.865, 0.035, 0.872, 0.835],
    ],
    crank: [0.375, -0.02, 0.15, 0.27, 0.36],
    cylinders: [2, 0.45, 0.25, 0.062],
    fins: false,
    silencer: [V(0.17, 0.28, 0.2), V(0.19, 0.35, 0.46), 0.06],
    twinShock: false,
    frameKind: 'lattice',
    paint: 0xe3a51a,
    frame: 0x2a2c30,
    wheels: 0x2a2c30,
    spring: 0xc0392b,
  },
  big: {
    spec: MOTORCYCLE,
    rake: 24.5 * DEG,
    trail: 0.1,
    tyres: [0.12, 0.18],
    rim: 0.216,
    wire: false,
    spokes: 3,
    split: true,
    discs: 2,
    disc: 0.155,
    rearDisc: 0.11,
    forkGap: 0.105,
    forkR: 0.022,
    usd: true,
    clampY: 1.0,
    grip: [0.355, 1.1, 0.03],
    lampY: 0.95,
    lampR: 0.085,
    cowl: true,
    screen: true,
    seatY: 0.835,
    hipZ: 0.2,
    peg: [0.17, 0.37, 0.17],
    lean: 15 * DEG,
    tank: [
      [-0.455, 0.06, 0.93, 0.87],
      [-0.43, 0.13, 0.975, 0.81],
      [-0.36, 0.172, 1.02, 0.775],
      [-0.25, 0.178, 1.055, 0.77],
      [-0.14, 0.165, 1.06, 0.79],
      [-0.05, 0.135, 1.035, 0.82],
      [0.01, 0.1, 0.99, 0.85],
      [0.03, 0.05, 0.95, 0.88],
    ],
    seat: [
      [-0.04, 0.06, 0.875, 0.83],
      [-0.01, 0.1, 0.87, 0.8],
      [0.06, 0.135, 0.85, 0.78],
      [0.16, 0.155, 0.835, 0.77],
      [0.28, 0.16, 0.838, 0.775],
      [0.36, 0.15, 0.855, 0.785],
      [0.41, 0.13, 0.885, 0.8],
      [0.45, 0.125, 0.905, 0.83],
      [0.58, 0.115, 0.912, 0.845],
      [0.68, 0.09, 0.905, 0.85],
      [0.72, 0.05, 0.89, 0.855],
    ],
    tail: [
      [0.3, 0.13, 0.8, 0.66],
      [0.42, 0.14, 0.86, 0.69],
      [0.56, 0.125, 0.875, 0.73],
      [0.7, 0.095, 0.885, 0.775],
      [0.82, 0.06, 0.885, 0.815],
      [0.875, 0.035, 0.875, 0.835],
    ],
    crank: [0.385, -0.03, 0.17, 0.3, 0.4],
    cylinders: [4, 0.5, 0.27, 0.06],
    fins: false,
    silencer: [V(0.2, 0.3, 0.3), V(0.225, 0.44, 0.6), 0.065],
    twinShock: false,
    frameKind: 'beam',
    paint: 0x1d5fb0,
    frame: 0xa4a9af,
    wheels: 0x26282c,
    spring: 0xd9a21b,
  },
};

/** The number plate: the usual two lines, but no real registration. */
function plateTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 192;
  const x = c.getContext('2d')!;
  x.fillStyle = '#f2f2ee';
  x.fillRect(0, 0, 256, 192);
  x.strokeStyle = '#151515';
  x.lineWidth = 6;
  x.strokeRect(3, 3, 250, 186);
  x.fillStyle = '#1b3fa0';
  x.fillRect(6, 6, 34, 180);
  x.fillStyle = '#151515';
  x.font = '700 72px "DIN Alternate", "Bahnschrift", "Arial Narrow", Arial, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('FS', 148, 56, 200);
  x.fillText('2026', 148, 138, 200);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Keep a part of the rider's head out of any picture taken from inside the
 * head – the rider's own eyes –, while it still throws its shadow (the shadow
 * pass does not call onBeforeRender) and still shows in the mirrors.
 */
function ownHead(mesh: THREE.Mesh, centre: THREE.Vector3, reach: number): void {
  const m = mesh.material as THREE.Material;
  const at = new THREE.Vector3();
  const cam = new THREE.Vector3();
  let hidden = false;
  mesh.onBeforeRender = (_r, _s, camera): void => {
    at.copy(centre).applyMatrix4(mesh.matrixWorld);
    hidden = cam.setFromMatrixPosition(camera.matrixWorld).distanceToSquared(at) < reach * reach;
    if (hidden) {
      m.colorWrite = false;
      m.depthWrite = false;
    }
  };
  mesh.onAfterRender = (): void => {
    if (!hidden) return;
    m.colorWrite = true;
    m.depthWrite = true;
    hidden = false;
  };
}

interface Arm {
  /** the shoulder in the torso's frame, the wrist in the front's; which way the elbow bends */
  shoulder: THREE.Vector3;
  wrist: THREE.Vector3;
  pole: THREE.Vector3;
  upper: THREE.Mesh;
  fore: THREE.Group;
}

interface Shock {
  mesh: THREE.Group;
  /** lower eye in the swing arm's frame, upper eye in the body's */
  low: THREE.Vector3;
  high: THREE.Vector3;
  length: number;
}

const UPPER_ARM = 0.29;
const FOREARM = 0.26;
const THIGH = 0.45;
const SHIN = 0.44;

/**
 * A motorcycle with its rider.  It leans into the bend (`setLean`) – the
 * camera of the rider's eyes leans with it.
 */
export class PlayerBike implements VehicleModel {
  readonly root = new THREE.Group();
  /**
   * The camera of the rider's view: a little below and behind his eyes (at the
   * chin of the helmet), from where instruments, bar and hands are in sight
   * when he looks down at them – `gaze` below the horizon.
   */
  readonly eye = new THREE.Vector3();
  /** how far below the horizon the rider looks when he looks ahead (rad): the road, and below it instruments, bar and gloves */
  readonly gaze = 0.28;
  readonly mirrors: Mirror[] = [];
  readonly variant: BikeVariant;
  /** everything that leans: the root stays upright, so that the game can place it */
  private readonly body = new THREE.Group();
  /** the front, turning about the steering axis; in it what moves along the fork with the wheel, and the wheel */
  private readonly front = new THREE.Group();
  private readonly slider = new THREE.Group();
  private readonly frontWheel = new THREE.Group();
  /** the swing arm about its pivot, and the rear wheel in it */
  private readonly swing = new THREE.Group();
  private readonly rearWheel = new THREE.Group();
  /** the rider's upper body: it turns a little with the handlebar */
  private readonly torso = new THREE.Group();
  private readonly rider: THREE.Object3D[] = [];
  private readonly arms: Arm[] = [];
  private readonly shocks: Shock[] = [];
  private readonly lamps = new Lamps();
  private readonly panel = new InstrumentPanel();
  private readonly axis: THREE.Vector3;
  private readonly rake: number;
  private readonly radius: number;
  /** the swing arm: length, and its height difference from the pivot to the axle at rest */
  private readonly armLength: number;
  private readonly armDrop: number;
  /** the eye in the frame of the upper body: it moves with the shoulders (the game reads `eye` every frame) */
  private readonly eyeRest: THREE.Vector3;
  private lean = 0;
  private readonly tmp = { a: V(), b: V(), c: V(), d: V() };

  /** `variant`: the class's build – 'moped' (AM), 'light' (A1), 'mid' (A2), 'big' (A). */
  constructor(variant: BikeVariant = 'big') {
    const b = BUILDS[variant];
    this.variant = variant;
    const root = this.root;
    root.name = 'motorcycle';
    const R = (this.radius = b.spec.wheelRadius);
    const zF = -b.spec.wheelbase / 2;
    const zR = b.spec.wheelbase / 2;
    const rake = (this.rake = b.rake);
    const tanRake = Math.tan(rake);
    const axis = (this.axis = V(0, Math.cos(rake), Math.sin(rake)));
    /** square to the axis, forwards and up */
    const ahead = V(0, Math.sin(rake), -Math.cos(rake));
    const zFoot = zF - b.trail;
    const onAxis = (y: number, x = 0): THREE.Vector3 => V(x, y, zFoot + y * tanRake);
    // the fork legs run parallel to the axis, through the axle
    const onFork = (y: number, x = 0): THREE.Vector3 => V(x, y, zF + (y - R) * tanRake);
    const P = onAxis(b.clampY);
    const axle = V(0, R, zF);
    const forkTop = P.clone().sub(axle).dot(axis);
    const along = (s: number, x = 0): THREE.Vector3 => axle.clone().addScaledVector(axis, s).setX(x);
    const [tf, tr] = b.tyres;
    const paint = new THREE.MeshLambertMaterial({ color: b.paint });
    const frameMat = lambert(b.frame);
    const wheelMat = b.wire ? CHROME : lambert(b.wheels);
    const springMat = lambert(b.spring);

    // ---------------------------------------------------------------- the rider's posture
    const lean = b.lean;
    const up = V(0, Math.cos(lean), -Math.sin(lean));
    const fwd = V(0, -Math.sin(lean), -Math.cos(lean));
    const hip = V(0, b.seatY + 0.095, b.hipZ);
    const shoulders = hip.clone().addScaledVector(up, 0.5);
    const head = shoulders.clone().add(V(0, 0.205, -0.045));
    this.eye.copy(shoulders).add(V(0, 0.07, -0.04));

    const body = new Parts();
    const front = new Parts();
    const slider = new Parts();
    const wheelF = new Parts();
    const wheelR = new Parts();
    const swing = new Parts();

    // ---------------------------------------------------------------- wheels
    const tyre = (w: number): THREE.BufferGeometry => {
      // a round crown over ±72°, sidewalls down to the beads on the rim
      const th = 1.25;
      const cr = w / (2 * Math.sin(th));
      const prof: number[][] = [[b.rim - 0.006, -w * 0.4]];
      prof.push([b.rim + 0.012, -w * 0.47]);
      prof.push([(b.rim + R - cr * (1 - Math.cos(th))) / 2 + 0.004, -w * 0.505]);
      for (let i = 0; i <= 10; i++) {
        const t = -th + (2 * th * i) / 10;
        prof.push([R - cr + cr * Math.cos(t), cr * Math.sin(t)]);
      }
      prof.push([(b.rim + R - cr * (1 - Math.cos(th))) / 2 + 0.004, w * 0.505]);
      prof.push([b.rim + 0.012, w * 0.47]);
      prof.push([b.rim - 0.006, w * 0.4]);
      return turned(prof, V(), X, 40);
    };
    const rimHoop = (w: number): THREE.BufferGeometry => {
      const a = w * 0.42;
      const r = b.rim;
      return turned([[r - 0.016, -a], [r + 0.006, -a], [r + 0.006, -a + 0.007], [r - 0.003, -a + 0.012], [r - 0.003, a - 0.012], [r + 0.006, a - 0.007], [r + 0.006, a], [r - 0.016, a], [r - 0.016, -a]], V(), X, 40, true);
    };
    const hub = (half: number, flange: number): THREE.BufferGeometry =>
      turned([[0, -half], [0.03, -half], [0.034, -half + 0.008], [flange, -half + 0.012], [flange, -half + 0.022], [0.04, -half + 0.03], [0.04, half - 0.03], [flange, half - 0.022], [flange, half - 0.012], [0.034, half - 0.008], [0.03, half], [0, half]], V(), X, 20);
    const disc = (at: number, r: number, carrier: number): THREE.BufferGeometry[] => [
      turned([[r - 0.042, at - 0.0028], [r, at - 0.0028], [r, at + 0.0028], [r - 0.042, at + 0.0028], [r - 0.042, at - 0.0028]], V(), X, 40, true),
      turned([[0.04, at - 0.002], [carrier, at - 0.002], [carrier, at + 0.002], [0.04, at + 0.002], [0.04, at - 0.002]], V(), X, 20, true),
    ];
    const castSpokes = (n: number, split: boolean, width: number): THREE.BufferGeometry[] => {
      const out: THREE.BufferGeometry[] = [];
      const r0 = 0.036;
      const r1 = b.rim - 0.012;
      const radial = (r: number, a: number): THREE.Vector3 => V(0, Math.cos(a) * r, Math.sin(a) * r);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        // (the first measure of a section is across the wheel, the second round it)
        if (!split) {
          out.push(sweep([radial(r0, a), radial(r1, a)], (t) => rounded(width, 0.03 - 0.01 * t, 0.007), 2, X));
          continue;
        }
        const rm = r0 + (r1 - r0) * 0.42;
        out.push(sweep([radial(r0, a), radial(rm, a)], () => rounded(width, 0.034, 0.008), 1, X));
        for (const da of [-0.17, 0.17]) out.push(sweep([radial(rm - 0.01, a), radial(r1, a + da)], (t) => rounded(width * 0.85, 0.022 - 0.006 * t, 0.006), 2, X));
      }
      return out;
    };
    const wireSpokes = (n: number, half: number): THREE.BufferGeometry[] => {
      const out: THREE.BufferGeometry[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const s = i % 2 ? 1 : -1;
        const h = a + (i % 4 < 2 ? 0.42 : -0.42);
        out.push(rod(V(s * (half - 0.018), Math.cos(h) * 0.045, Math.sin(h) * 0.045), V(s * 0.004, Math.cos(a) * (b.rim - 0.008), Math.sin(a) * (b.rim - 0.008)), 0.0018, 3));
      }
      return out;
    };
    // the front wheel: discs on one or both sides, inside the fork legs
    wheelF.add(TYRE, tyre(tf));
    wheelF.add(wheelMat, rimHoop(tf));
    const halfF = b.forkGap - 0.035;
    wheelF.add(b.wire ? ALU : wheelMat, hub(halfF, b.wire ? 0.05 : 0.044));
    wheelF.add(wheelMat, ...(b.wire ? wireSpokes(b.spokes, halfF) : castSpokes(b.spokes, b.split, 0.026)));
    const discSides = b.discs > 1 ? [-1, 1] : [-1];
    for (const s of discSides) {
      const [ring_, carrier] = disc(s * (halfF - 0.006), b.disc, b.disc - 0.034);
      wheelF.add(STEEL, ring_);
      wheelF.add(b.wire ? ALU : BLACK, carrier);
    }
    // the rear wheel: the disc on the right, the sprocket on the left (or a drum brake)
    const halfR = tr / 2 + 0.03;
    wheelR.add(TYRE, tyre(tr));
    wheelR.add(wheelMat, rimHoop(tr));
    wheelR.add(b.wire ? ALU : wheelMat, hub(halfR, b.wire ? 0.05 : 0.046));
    wheelR.add(wheelMat, ...(b.wire ? wireSpokes(b.spokes, halfR) : castSpokes(b.spokes, b.split, 0.03)));
    if (b.rearDisc > 0) {
      const [ring_, carrier] = disc(halfR - 0.004, b.rearDisc, b.rearDisc - 0.03);
      wheelR.add(STEEL, ring_);
      wheelR.add(BLACK, carrier);
    } else {
      wheelR.add(ALU, turned([[0.03, halfR - 0.01], [0.085, halfR - 0.01], [0.085, halfR + 0.012], [0.03, halfR + 0.012], [0.03, halfR - 0.01]], V(), X, 24, true));
    }
    const sprocketR = 0.085 + 0.02 * (tr / 0.18);
    const teeth = 40;
    const toothed: number[][] = [];
    for (let i = 0; i < teeth * 2; i++) {
      const a = (i / (teeth * 2)) * Math.PI * 2;
      const r = i % 2 ? sprocketR : sprocketR - 0.008;
      toothed.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const chainX = -(tr / 2 + 0.022);
    wheelR.add(STEEL, loft([ring(V(chainX - 0.003, 0, 0), Y, Z, toothed), ring(V(chainX + 0.003, 0, 0), Y, Z, toothed)]));
    wheelR.add(BLACK, turned([[0.03, chainX + 0.003], [0.055, chainX + 0.004], [0.055, -halfR + 0.004], [0.03, -halfR + 0.002]], V(), X, 16));

    // ---------------------------------------------------------------- the front: fork, clamps, bar, lamp, instruments
    const fr = b.forkR;
    for (const s of [-1, 1]) {
      const x = s * b.forkGap;
      if (b.usd) {
        // thick tubes in the clamps, thin gold ones sliding in them, the axle clamp at their foot
        front.add(BLACK, limb(along(0.3, x), along(forkTop + 0.012, x), fr + 0.009, fr + 0.009));
        front.add(ALU, limb(along(forkTop - 0.005, x), along(forkTop + 0.02, x), fr + 0.006, fr + 0.004));
        slider.add(GOLD, rod(along(0.03, x), along(0.36, x), fr - 0.001, 14));
        slider.add(BLACK, limb(along(-0.035, x), along(0.07, x), fr + 0.006, fr + 0.004));
      } else {
        front.add(CHROME, rod(along(0.27, x), along(forkTop + 0.008, x), fr, 14));
        front.add(BLACK, limb(along(forkTop - 0.004, x), along(forkTop + 0.016, x), fr - 0.002, fr - 0.004));
        slider.add(b.wire ? ALU : BLACK, limb(along(-0.03, x), along(0.33, x), fr + 0.009, fr + 0.008));
      }
    }
    // the axle and the brake callipers behind the discs
    slider.add(STEEL, rod(V(-b.forkGap - 0.012, R, zF), V(b.forkGap + 0.012, R, zF), 0.011, 10));
    for (const s of discSides) {
      const a = 0.42;
      const r = b.disc - 0.024;
      slider.add(b.usd ? GOLD : ALU, soap(V(s * (halfF - 0.006), R + Math.sin(a) * r, zF + Math.cos(a) * r), 0.045, 0.085, 0.04, 0.012, new THREE.Euler(-a, 0, 0)));
    }
    // the mudguard over the front tyre: a strip curved across, its edges drawn down round the tyre
    {
      const g = R + 0.028;
      const arc: THREE.Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = -0.55 + (1.7 * i) / 8;
        arc.push(V(0, R + Math.cos(t) * g, zF - Math.sin(t) * g));
      }
      slider.add(paint, sweep(arc, () => strip(tf / 2 + 0.016, 0.014, 0.004), 12, X));
    }
    // the triple clamps
    const clamp_ = (s: number, thick: number): THREE.BufferGeometry => {
      const c = along(s).addScaledVector(ahead, -0.012);
      const outline = rounded(2 * (b.forkGap + fr + 0.016), 0.032 + fr * 2 + 0.03, 0.03);
      return loft([ring(c, X, ahead, outline), ring(c.clone().addScaledVector(axis, -thick), X, ahead, outline)]);
    };
    front.add(b.usd ? ALU : BLACK, clamp_(forkTop, 0.03));
    front.add(BLACK, clamp_(forkTop - 0.2, 0.04));
    // the handlebar on its clamps, the grips, levers and switches
    const [gx, gy, gb] = b.grip;
    const gz = P.z + gb;
    const cy = b.clampY + 0.055;
    for (const s of [-1, 1]) front.add(BLACK, soap(V(s * 0.04, b.clampY + 0.028, P.z), 0.032, 0.05, 0.05, 0.01));
    const barPath = [-1, 1].flatMap((s) => {
      const pts = [V(s * (gx + 0.062), gy + 0.005, gz + 0.01), V(s * (gx - 0.07), gy - 0.003, gz - 0.006), V(s * 0.17, cy + 0.006, P.z - 0.002)];
      return s < 0 ? pts : pts.reverse();
    });
    barPath.splice(3, 0, V(0, cy, P.z - 0.004));
    front.add(b.usd ? BLACK : CHROME, sweep(barPath, () => circle(0.011, 10), 40));
    for (const s of [-1, 1]) {
      front.add(BLACK, limb(V(s * (gx - 0.066), gy - 0.002, gz - 0.005), V(s * (gx + 0.056), gy + 0.005, gz + 0.009), 0.017, 0.018));
      front.add(ALU, limb(V(s * (gx + 0.057), gy + 0.005, gz + 0.01), V(s * (gx + 0.07), gy + 0.006, gz + 0.012), 0.016, 0.016));
      // the switch block inside each grip, the lever on its perch in front of it
      front.add(BLACK, soap(V(s * (gx - 0.09), gy - 0.002, gz - 0.006), 0.034, 0.042, 0.048, 0.012));
      front.add(BLACK, soap(V(s * (gx - 0.125), gy + 0.004, gz - 0.012), 0.04, 0.03, 0.036, 0.01));
      const lever = [V(s * (gx - 0.115), gy - 0.004, gz - 0.03), V(s * (gx - 0.07), gy - 0.012, gz - 0.066), V(s * (gx + 0.04), gy - 0.016, gz - 0.078)];
      front.add(ALU, sweep(lever, () => rounded(0.012, 0.007, 0.003), 10, Y));
    }
    // the reservoir of the front brake on the right
    front.add(BLACK, soap(V(gx - 0.145, gy + 0.032, gz - 0.01), 0.04, 0.026, 0.032, 0.008));

    // headlamp, its brackets or cowl, the instruments, the front indicators
    const lampAt = onFork(b.lampY).add(V(0, 0, -0.135));
    const lr = b.lampR;
    const facing = V(0, 0, -1);
    if (b.cowl) {
      // a cowl round the lamp that rises to carry the instruments
      const z0 = lampAt.z + 0.004;
      const st: Station[] = [
        [z0, lr + 0.018, lampAt.y + lr + 0.03, lampAt.y - lr - 0.018],
        [z0 + 0.04, lr + 0.035, lampAt.y + lr + 0.085, lampAt.y - lr - 0.03],
        [z0 + 0.1, lr + 0.04, lampAt.y + lr + 0.105, lampAt.y - lr - 0.02],
        [z0 + 0.15, lr + 0.025, lampAt.y + lr + 0.09, lampAt.y - lr + 0.01],
      ];
      front.add(paint, stations(st, 22, 0.6));
      front.add(BLACK, turned([[lr + 0.004, -0.004], [lr + 0.012, -0.004], [lr + 0.012, 0.012], [lr + 0.004, 0.012], [lr + 0.004, -0.004]], lampAt, facing, 32, true));
      // the lens: a lit ring round a dark reflector with a lit projector in its middle
      front.add(BLACK, turned([[0, 0.006], [lr * 0.95, 0.004], [lr + 0.004, -0.002]], lampAt, facing, 32));
      front.add(LAMP, turned([[lr * 0.72, 0.009], [lr * 0.8, 0.011], [lr * 0.88, 0.009], [lr * 0.8, 0.006], [lr * 0.72, 0.009]], lampAt, facing, 32));
      front.add(LAMP, turned([[0, 0.016], [lr * 0.3, 0.013], [lr * 0.34, 0.006]], lampAt, facing, 20));
      if (b.screen) {
        // a small tinted screen above it
        const path = [V(0, lampAt.y + lr + 0.06, z0 + 0.02), V(0, lampAt.y + lr + 0.15, z0 + 0.045), V(0, lampAt.y + lr + 0.21, z0 + 0.075)];
        front.add(SMOKE, sweep(path, (t) => strip(0.1 + 0.025 * t, 0.03, 0.004), 8, X));
      }
    } else {
      // a round lamp in a chrome bucket on two brackets from the fork
      front.add(CHROME, turned([[0, -0.115], [0.03, -0.11], [lr * 0.7, -0.09], [lr * 0.97, -0.04], [lr + 0.006, 0.0], [lr + 0.008, 0.012], [lr - 0.004, 0.016]], lampAt, facing, 32));
      front.add(LAMP, turned([[0, 0.03], [lr * 0.5, 0.026], [lr * 0.85, 0.018], [lr - 0.002, 0.012]], lampAt, facing, 32));
      for (const s of [-1, 1]) front.add(BLACK, pipe([onFork(b.lampY + 0.05, s * (b.forkGap + fr * 0.6)), V(s * (lr + 0.022), lampAt.y + 0.01, lampAt.z + 0.08), V(s * (lr + 0.004), lampAt.y, lampAt.z + 0.05)], 0.008, 8, 8));
    }
    for (const s of [-1, 1]) {
      const base = V(s * (lr + 0.03), lampAt.y - 0.01, lampAt.z + 0.07);
      const tip = V(s * (lr + 0.09), lampAt.y - 0.012, lampAt.z + 0.055);
      front.add(BLACK, rod(base, tip, 0.006, 6));
      const ind = new THREE.Mesh(blob(tip.clone().add(V(0, 0, -0.012)).sub(P), 0.017, 0.016, 0.03), DIM);
      this.lamps.indicators.push({ mesh: ind, side: s });
      this.front.add(ind);
    }
    // the instruments: the game's picture in a housing that faces the rider's eyes
    const dashW = b.cowl ? 0.22 : 0.18;
    const dashAt = b.cowl ? V(0, lampAt.y + lr + 0.115, lampAt.z + 0.1) : V(0, gy + 0.05, P.z - 0.1);
    const toEye = this.eye.clone().sub(dashAt).normalize();
    const tilt = Math.atan2(toEye.y, toEye.z);
    const tiltRot = new THREE.Euler(-tilt, 0, 0, 'YXZ');
    front.add(BLACK, soap(dashAt.clone().addScaledVector(toEye, -0.022), dashW + 0.026, dashW / 3 + 0.028, 0.04, 0.012, tiltRot));
    if (!b.cowl) {
      // its bracket from the top clamp
      front.add(BLACK, pipe([P.clone().add(V(0, 0.01, -0.02)), V(0, (P.y + dashAt.y) / 2, (P.z + dashAt.z) / 2 - 0.01), dashAt.clone().addScaledVector(toEye, -0.04)], 0.009, 6, 8));
    }
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(dashW, dashW / 3), new THREE.MeshBasicMaterial({ map: this.panel.texture, toneMapped: false }));
    dash.name = 'instruments';
    dash.position.copy(dashAt).addScaledVector(toEye, 0.001).sub(P);
    dash.rotation.x = -tilt;
    this.front.add(dash);

    // the mirrors on stalks from the perches near the bar ends
    for (const s of [-1, 1]) {
      const c = V(s * (gx + 0.01), this.eye.y - 0.14, P.z - 0.115);
      const toE = this.eye.clone().sub(c).normalize();
      const look = V(s * 0.1, -0.03, 1).normalize();
      const normal = toE.add(look).normalize();
      const w = 0.12;
      const h = 0.07;
      const mirror = new Mirror({ name: s < 0 ? 'left' : 'right', centre: c.clone().sub(P), width: w, height: h, normal, convex: 1.6, resolution: [192, 112] });
      this.mirrors.push(mirror);
      this.front.add(mirror.mesh);
      // the housing behind the glass: rounded, aligned with it
      const mUp = V(0, 1, 0).addScaledVector(normal, -normal.y).normalize();
      const mRight = new THREE.Vector3().crossVectors(mUp, normal).normalize();
      const shell = (depth: number, grow: number): THREE.Vector3[] => ring(c.clone().addScaledVector(normal, -depth), mRight, mUp, rounded(w + grow, h + grow, 0.03, 3));
      front.add(BLACK, loft([shell(0.001, 0.016), shell(0.012, 0.02), shell(0.03, 0.012), shell(0.045, -0.03)]));
      const mount = c.clone().addScaledVector(normal, -0.03).addScaledVector(mRight, -s * 0.035).addScaledVector(mUp, -0.03);
      const perch = V(s * (gx - 0.125), gy + 0.018, gz - 0.012);
      front.add(BLACK, pipe([perch, perch.clone().add(V(s * 0.015, 0.07, -0.025)), mount], 0.0065, 10, 8));
    }

    // ---------------------------------------------------------------- frame, tank, seat, tail
    const pivot = V(0, 0.41, 0.115);
    const head0 = onAxis(b.clampY - 0.045);
    const head1 = onAxis(b.clampY - 0.185);
    body.add(frameMat, limb(head1, head0, 0.034, 0.034));
    if (b.frameKind === 'beam') {
      for (const s of [-1, 1]) {
        const beam = [head0.clone().add(V(s * 0.045, -0.01, 0.025)), V(s * 0.17, 0.8, -0.26), V(s * 0.19, 0.76, -0.1), V(s * 0.17, 0.67, 0.05), V(s * 0.14, 0.52, 0.11)];
        body.add(frameMat, sweep(beam, () => rounded(0.036, 0.095, 0.014), 20));
        body.add(frameMat, soap(V(s * 0.14, 0.45, 0.115), 0.04, 0.2, 0.11, 0.02));
        body.add(frameMat, pipe([head1.clone().add(V(s * 0.03, 0, 0.01)), V(s * 0.13, 0.66, -0.3)], 0.015, 4, 8));
      }
    } else if (b.frameKind === 'lattice') {
      for (const s of [-1, 1]) {
        const A = head0.clone().add(V(s * 0.04, 0, 0.015));
        const B = head1.clone().add(V(s * 0.04, 0, 0.005));
        const C = V(s * 0.155, 0.81, -0.2);
        const D = V(s * 0.15, 0.62, -0.25);
        const E = V(s * 0.15, 0.79, 0.0);
        const F = V(s * 0.145, 0.58, -0.03);
        const G = V(s * 0.135, 0.52, 0.11);
        for (const [p, q] of [
          [A, C],
          [B, D],
          [B, C],
          [C, D],
          [C, E],
          [D, F],
          [C, F],
          [E, F],
          [E, G],
          [F, G],
        ]) body.add(frameMat, limb(p, q, 0.012, 0.012, 8));
        body.add(frameMat, soap(V(s * 0.135, 0.45, 0.115), 0.035, 0.16, 0.1, 0.02));
      }
    } else {
      // a backbone under the tank, a down tube and a cradle under the engine
      body.add(frameMat, pipe([head0.clone().add(V(0, 0, 0.02)), V(0, 0.86, -0.18), V(0, 0.8, 0.0), V(0, 0.74, 0.06)], 0.024, 16, 10));
      body.add(frameMat, pipe([head1.clone().add(V(0, 0, 0.01)), V(0, 0.55, -0.37), V(0, 0.25, -0.27)], 0.02, 12, 10));
      for (const s of [-1, 1]) {
        body.add(frameMat, pipe([V(0, 0.75, 0.05), V(s * 0.08, 0.63, 0.1), V(s * 0.09, 0.44, 0.115)], 0.018, 10, 8));
        body.add(frameMat, pipe([V(0, 0.25, -0.27), V(s * 0.06, 0.17, -0.18), V(s * 0.07, 0.155, 0.02), V(s * 0.085, 0.31, 0.115)], 0.016, 14, 8));
      }
    }
    // the subframe: under the seat, then inside the tail
    const tailEnd = b.tail[b.tail.length - 1][0];
    const inTail = (z: number): number => {
      const [top, bottom] = [2, 3].map((i) => between(b.tail, z, i));
      return (top + bottom) / 2;
    };
    for (const s of [-1, 1]) {
      body.add(frameMat, pipe([V(s * 0.095, between(b.seat, 0.02, 3) - 0.012, 0.02), V(s * 0.085, inTail(0.4), 0.4), V(s * 0.065, inTail(tailEnd - 0.06), tailEnd - 0.06)], 0.012, 10, 8));
      body.add(frameMat, pipe([V(s * 0.11, 0.5, 0.15), V(s * 0.088, inTail(0.42), 0.42)], 0.011, 4, 8));
    }
    // tank, seat, tail with its lamp, the side panels under the seat
    body.add(paint, stations(b.tank, 24, 0.7));
    body.add(SEAT, stations(b.seat, 22, 0.6));
    body.add(paint, stations(b.tail, 20, 0.75));
    body.add(BLACK, soap(V(0, 0.7, 0.19), 0.2, 0.16, 0.3, 0.04));
    for (const s of [-1, 1]) body.add(b.cowl ? BLACK : paint, soap(V(s * 0.1, 0.735, 0.22), 0.03, 0.12, 0.24, 0.012, new THREE.Euler(0.12, 0, 0)));
    const [tz, , ttop, tbot] = b.tail[b.tail.length - 1];
    const tailLamp = new THREE.Mesh(variant === 'moped' ? blob(V(0, (ttop + tbot) / 2, tz + 0.012), 0.035, 0.03, 0.02) : soap(V(0, (ttop + tbot) / 2, tz + 0.006), 0.1, 0.034, 0.02, 0.008), TAIL);
    this.lamps.brake.push(tailLamp);
    this.body.add(tailLamp);
    // the number plate on its hanger, the rear indicators beside it
    const plateZ = zR + 0.255;
    const plateY = 0.665;
    body.add(BLACK, sweep([V(0, tbot + 0.01, tz - 0.12), V(0, tbot - 0.04, tz - 0.02), V(0, plateY + 0.075, plateZ - 0.02)], () => rounded(0.1, 0.012, 0.005), 10, X));
    body.add(BLACK, soap(V(0, plateY, plateZ - 0.006), 0.19, 0.145, 0.008, 0.004, new THREE.Euler(-0.25, 0, 0)));
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.135), new THREE.MeshLambertMaterial({ map: plateTexture() }));
    plate.position.set(0, plateY, plateZ - 0.0005);
    plate.rotation.x = -0.25;
    this.body.add(plate);
    for (const s of [-1, 1]) {
      const base = V(s * 0.04, plateY + 0.07, plateZ - 0.04);
      const tip = V(s * 0.12, plateY + 0.075, plateZ - 0.045);
      body.add(BLACK, rod(base, tip, 0.006, 6));
      const ind = new THREE.Mesh(blob(tip.clone().add(V(0, 0, 0.012)), 0.016, 0.015, 0.028), DIM);
      this.lamps.indicators.push({ mesh: ind, side: s });
      this.body.add(ind);
    }

    // ---------------------------------------------------------------- the engine
    const [ey, ez, eh, eH, eD] = b.crank;
    const k = eH / 0.3;
    body.add(ENGINE, soap(V(0, ey, ez), 2 * eh, eH, eD, 0.05 * k));
    body.add(ENGINE, soap(V(0, ey - eH / 2 + 0.02, ez + 0.02), 2 * eh * 0.75, 0.08 * k, eD * 0.7, 0.025));
    // clutch cover on the right, the generator's on the left, the sprocket's behind it
    body.add(ALU, turned([[0, 0.0], [0.085 * k + 0.01, 0.0], [0.085 * k + 0.01, 0.022], [0.07 * k, 0.034], [0, 0.034]], V(eh - 0.01, ey + 0.015, ez + eD * 0.12), X, 28, true));
    body.add(ALU, turned([[0, 0.0], [0.065 * k + 0.008, 0.0], [0.065 * k + 0.008, 0.02], [0.05 * k, 0.03], [0, 0.03]], V(-eh + 0.01, ey + 0.03, ez - eD * 0.2), V(-1, 0, 0), 24, true));
    body.add(BLACK, soap(V(-eh - 0.004, ey - 0.005, ez + eD / 2 - 0.05), 0.024, 0.11 * k + 0.02, 0.1, 0.02));
    // the cylinders, leaning forwards from the top of the crankcase
    const [nCyl, cTilt, cLen, cR] = b.cylinders;
    const cDir = V(0, Math.cos(cTilt), -Math.sin(cTilt));
    const cFwd = V(0, -Math.sin(cTilt), -Math.cos(cTilt));
    const cBase = V(0, ey + eH / 2 - 0.03 - 0.05 * Math.sin(cTilt), ez - eD / 2 + 0.115 - 0.05 * Math.sin(cTilt));
    const cRot = new THREE.Euler(-cTilt, 0, 0, 'YXZ');
    const cyl = (s: number): THREE.Vector3 => cBase.clone().addScaledVector(cDir, s);
    const ports: THREE.Vector3[] = [];
    if (b.fins) {
      // one air-cooled cylinder: a barrel of fins, a finned head
      const fin = cR + 0.032 * k + 0.012;
      body.add(ENGINE, rod(cyl(0), cyl(cLen), cR, 18));
      for (let i = 0; i < 9; i++) {
        const s = 0.025 + (i * (cLen - 0.04)) / 8;
        body.add(i > 5 ? ENGINE : ALU, turned([[cR, s - 0.003], [fin - 0.004 * (i % 2), s - 0.003], [fin - 0.004 * (i % 2), s + 0.003], [cR, s + 0.003]], cBase, cDir, 22, true));
      }
      body.add(ALU, soap(cyl(cLen + 0.012), fin * 1.6, 0.03, fin * 1.7, 0.012, cRot));
      ports.push(cyl(cLen - 0.06).addScaledVector(cFwd, fin - 0.005));
    } else {
      // a block of cylinders, its head and cam cover
      const w = nCyl * 0.072 + 0.06;
      body.add(ENGINE, soap(cyl(cLen * 0.36), w, cLen * 0.72, 2 * cR + 0.05, 0.02, cRot));
      body.add(ENGINE, soap(cyl(cLen * 0.8), w + 0.01, cLen * 0.22, 2 * cR + 0.07, 0.025, cRot));
      body.add(b.frameKind === 'beam' ? ALU : BLACK, soap(cyl(cLen + 0.012), w - 0.02, 0.04, 2 * cR + 0.03, 0.018, cRot));
      for (let i = 0; i < nCyl; i++) {
        const x = (i - (nCyl - 1) / 2) * (w - 0.06) / Math.max(1, nCyl - 1);
        ports.push(cyl(cLen * 0.82).addScaledVector(cFwd, cR + 0.03).setX(nCyl === 1 ? 0 : x));
      }
      // the radiator in front of the cylinders
      const rc = cyl(cLen * 0.62).addScaledVector(cFwd, cR + 0.13);
      body.add(RADIATOR, soap(rc, w + 0.03, 0.24, 0.045, 0.012, new THREE.Euler(-0.18, 0, 0)));
      body.add(BLACK, soap(rc.clone().add(V(0, 0, 0.004)), w + 0.05, 0.26, 0.03, 0.01, new THREE.Euler(-0.18, 0, 0)));
      for (const s of [-1, 1]) {
        // the tank's wings beside the radiator
        const wing: Station[] = [
          [rc.z - 0.07, 0.03, rc.y + 0.12, rc.y + 0.02],
          [rc.z - 0.02, 0.05, rc.y + 0.16, rc.y - 0.06],
          [rc.z + 0.08, 0.05, rc.y + 0.17, rc.y - 0.02],
          [rc.z + 0.14, 0.03, rc.y + 0.16, rc.y + 0.08],
        ];
        const g = stations(wing, 14, 0.7);
        g.translate(s * ((w + 0.05) / 2 + 0.01), 0, 0);
        body.add(paint, g);
      }
    }
    // the exhaust: down in front of the engine, under it and back to the silencer on the right
    const [s0, s1, sr] = b.silencer;
    const under = V(0.04, Math.max(0.14, ey - eH / 2 - 0.04), ez + 0.02);
    for (const p of ports) {
      const drop = V(p.x * 0.9, Math.max(under.y + 0.06, p.y - 0.18), Math.min(p.z - 0.02, ez - eD / 2 - 0.03));
      body.add(STEEL, pipe([p, p.clone().addScaledVector(cFwd, 0.04).add(V(0, -0.02, 0)), drop, V(p.x * 0.5 + 0.02, under.y + 0.01, ez - eD / 2 + 0.04), under], 0.019 * Math.min(1, 0.6 + 0.4 * k), 18, 10));
    }
    const chamber = variant === 'moped';
    body.add(STEEL, sweep([under, V(0.07, under.y - 0.005, ez + eD * 0.35), V(s0.x - 0.03, s0.y - 0.06, s0.z - 0.12), s0.clone().addScaledVector(s1.clone().sub(s0).normalize(), 0.02)], (t) => circle(chamber ? 0.022 + 0.03 * Math.sin(Math.PI * Math.min(1, t * 1.3)) : 0.024 * Math.min(1, 0.7 + 0.3 * k), 12), 16));
    // (the silencer swells a little behind its inlet)
    const can = (t: number): number => sr * (0.82 + 0.18 * Math.sin(Math.PI * Math.min(1, t * 1.6 + 0.1)));
    body.add(chamber ? CHROME : ALU, sweep([s0, s1], (t) => oval(can(t), can(t), 16, 0.8), 6, Y));
    body.add(BLACK, turned([[sr * 0.84, 0], [sr * 0.84, 0.025], [sr * 0.45, 0.03], [sr * 0.45, 0.01], [0, 0.01]], s1.clone(), s1.clone().sub(s0).normalize(), 18, true));
    // footpegs, with the gear lever on the left and the brake pedal on the right; the pillion's pegs
    const [px, py, pz] = b.peg;
    for (const s of [-1, 1]) {
      body.add(ALU, soap(V(s * (px - 0.05), py + 0.03, pz + 0.04), 0.012, 0.09, 0.07, 0.006, new THREE.Euler(0.4, 0, 0)));
      body.add(BLACK, limb(V(s * (px - 0.045), py, pz), V(s * (px + 0.05), py, pz), 0.012, 0.012, 8));
      const lever = [V(s * (px - 0.03), py - 0.01, pz + 0.035), V(s * (px - 0.015), py + 0.01, pz - 0.06), V(s * (px - 0.005), py + 0.03, pz - 0.15)];
      body.add(ALU, sweep(lever, () => rounded(0.008, 0.016, 0.003), 6, X));
      body.add(BLACK, limb(V(s * (px - 0.015), py + 0.03, pz - 0.15), V(s * (px + 0.03), py + 0.03, pz - 0.15), 0.009, 0.009, 8));
      // (on a hanger from the subframe)
      const hp = V(s * (px - 0.02), py + 0.13, pz + 0.34);
      body.add(ALU, sweep([V(s * 0.09, 0.79, hp.z - 0.12), V(s * (px - 0.05), hp.y + 0.1, hp.z - 0.05), V(s * (px - 0.045), hp.y, hp.z)], () => rounded(0.012, 0.035, 0.005), 8, X));
      body.add(BLACK, limb(V(s * (px - 0.05), hp.y, hp.z), V(s * (px + 0.03), hp.y, hp.z), 0.011, 0.011, 8));
    }

    // ---------------------------------------------------------------- the swing arm, chain and shocks
    const armX = tr / 2 + 0.042;
    const axleR = V(0, R, zR);
    for (const s of [-1, 1]) {
      body.add(frameMat, rod(V(s * (armX + 0.022), pivot.y, pivot.z), V(s * (armX + 0.01), pivot.y, pivot.z), 0.024, 12));
      const tube = b.frameKind === 'tube';
      swing.add(frameMat, sweep([V(s * armX, pivot.y, pivot.z), V(s * armX, (pivot.y + R) / 2 + 0.01, (pivot.z + zR) / 2), V(s * armX, R, zR + 0.025)], (t) => (tube ? oval(0.016, 0.022 - 0.004 * t, 12) : rounded(0.034, 0.075 - 0.025 * t, 0.012)), 12, X));
      swing.add(BLACK, soap(V(s * (armX + 0.004), R, zR + 0.03), 0.03, 0.03, 0.05, 0.008));
    }
    swing.add(frameMat, rod(V(-armX, pivot.y, pivot.z), V(armX, pivot.y, pivot.z), 0.022, 12));
    swing.add(frameMat, rod(V(-armX, pivot.y + 0.005, pivot.z + 0.15), V(armX, pivot.y + 0.005, pivot.z + 0.15), b.frameKind === 'tube' ? 0.016 : 0.022, 10));
    swing.add(STEEL, rod(V(-armX - 0.018, R, zR), V(armX + 0.018, R, zR), 0.011, 10));
    // the chain from the engine's sprocket to the wheel's
    {
      const f = V(chainX, ey - 0.005, ez + eD / 2 - 0.05);
      const fr_ = 0.04;
      const d = axleR.clone().setX(chainX).sub(f);
      const L = d.length();
      d.normalize();
      const sa = (sprocketR - fr_) / L;
      for (const side of [1, -1]) {
        const perp = V(0, d.z, -d.y).multiplyScalar(side); // square to the run in the side plane
        if (perp.y * side < 0) perp.negate();
        const n = perp.multiplyScalar(Math.sqrt(1 - sa * sa)).addScaledVector(d, -sa);
        const a = f.clone().addScaledVector(n, fr_);
        const e = axleR.clone().setX(chainX).addScaledVector(n, sprocketR);
        swing.add(STEEL, sweep([a, e], () => rounded(0.012, 0.008, 0.003), 1, X));
      }
      body.add(STEEL, turned([[0, -0.004], [fr_ + 0.004, -0.004], [fr_ + 0.004, 0.004], [0, 0.004]], f, X, 16, true));
    }
    // the rear calliper below the disc, the hugger over the tyre
    if (b.rearDisc > 0) swing.add(BLACK, soap(V(halfR - 0.004 + 0.006, R - 0.06, zR - 0.06), 0.04, 0.06, 0.07, 0.012, new THREE.Euler(0.7, 0, 0)));
    {
      const g = R + 0.026;
      const arc: THREE.Vector3[] = [];
      for (let i = 0; i <= 6; i++) {
        const t = 0.08 + (0.95 * i) / 6;
        arc.push(V(0, R + Math.cos(t) * g, zR - Math.sin(t) * g));
      }
      swing.add(BLACK, sweep(arc, () => rounded(tr + 0.02, 0.006, 0.003), 8, X));
    }
    // the shocks: one in the middle under the seat, or two outside the swing arm
    const shockPairs: Array<[THREE.Vector3, THREE.Vector3]> = b.twinShock
      ? [-1, 1].map((s): [THREE.Vector3, THREE.Vector3] => {
          const low = pivot.clone().lerp(axleR, 0.84).add(V(s * (armX + 0.03), 0.03, 0));
          return [low, V(low.x, inTail(low.z - 0.13) + 0.02, low.z - 0.13)];
        })
      : [[pivot.clone().lerp(axleR, 0.22).add(V(0, 0.055, 0)), V(0, 0.73, 0.15)]];
    for (const [low, high] of shockPairs) {
      const len = low.distanceTo(high);
      const g = new THREE.Group();
      const sp = new Parts();
      sp.add(BLACK, limb(V(0, 0, 0), V(0, 0.03, 0), 0.016, 0.016, 10));
      sp.add(CHROME, rod(V(0, 0.02, 0), V(0, len * 0.6, 0), 0.008, 10));
      sp.add(variant === 'moped' ? CHROME : BLACK, limb(V(0, len * 0.45, 0), V(0, len, 0), 0.021, 0.019, 12));
      const coils = 8;
      const coilR = b.twinShock ? 0.027 : 0.034;
      for (let i = 0; i < coils; i++) {
        const y = len * 0.12 + (i * len * 0.66) / (coils - 1);
        sp.add(springMat, new THREE.TorusGeometry(coilR, 0.0055, 6, 16).rotateX(Math.PI / 2).rotateZ(0.08).translate(0, y, 0).toNonIndexed().deleteAttribute('uv'));
      }
      sp.into(g);
      this.shocks.push({ mesh: g, low: low.clone().sub(pivot), high, length: len });
      this.body.add(g);
    }

    // ---------------------------------------------------------------- the rider
    const rider = new Parts();
    const upperBody = new Parts();
    const helmet = new Parts();
    const waist = hip.clone().addScaledVector(up, 0.14);
    const hipFrame = (s: number, a: number, d: number, shift: number): THREE.Vector3[] => ring(hip.clone().addScaledVector(up, s).addScaledVector(fwd, shift), X, fwd, oval(a, d, 18, 0.82));
    // the seat of the trousers and the hips, sitting on the seat
    rider.add(TROUSERS, loft([hipFrame(-0.105, 0.06, 0.04, -0.01), hipFrame(-0.09, 0.14, 0.1, -0.005), hipFrame(-0.04, 0.17, 0.125, 0.0), hipFrame(0.06, 0.172, 0.12, 0.005), hipFrame(0.13, 0.16, 0.112, 0.01)]));
    // the jacket from the waist to the shoulders
    upperBody.add(JACKET, loft([hipFrame(0.06, 0.168, 0.118, 0.008), hipFrame(0.18, 0.163, 0.112, 0.014), hipFrame(0.3, 0.178, 0.122, 0.028), hipFrame(0.4, 0.195, 0.124, 0.03), hipFrame(0.46, 0.2, 0.11, 0.022), hipFrame(0.51, 0.175, 0.088, 0.008), hipFrame(0.545, 0.1, 0.062, -0.004)]));
    // a band of the bike's colour across chest and back, and the shoulders
    upperBody.add(paint, loft([hipFrame(0.31, 0.181, 0.125, 0.028), hipFrame(0.355, 0.189, 0.127, 0.03)], false));
    const shoulderAt = (s: number): THREE.Vector3 => hip.clone().addScaledVector(up, 0.475).add(V(s * 0.175, 0, 0));
    for (const s of [-1, 1]) upperBody.add(JACKET, blob(shoulderAt(s).add(V(-s * 0.01, 0.004, 0.005)), 0.058, 0.056, 0.064));
    // neck, collar and helmet: the parts the rider's own eyes are inside of
    helmet.add(JACKET, limb(shoulders.clone().addScaledVector(up, -0.03), head.clone().add(V(0, -0.07, 0.015)), 0.058, 0.052, 12));
    helmet.add(JACKET, turned([[0.07, 0.0], [0.085, 0.012], [0.082, 0.05], [0.07, 0.056]], shoulders.clone().addScaledVector(up, -0.035), up, 18));
    helmet.add(HELMET, blob(head, 0.128, 0.142, 0.158, undefined, 24, 16));
    // the chin bar of a full-face helmet
    helmet.add(HELMET, blob(head.clone().add(V(0, -0.07, -0.06)), 0.105, 0.072, 0.1, new THREE.Euler(0.25, 0, 0), 18, 10));
    // the visor over the eyes, a stripe of the bike's colour over the top
    const visorGeo = new THREE.SphereGeometry(1, 20, 8, Math.PI * 1.5 - 1.1, 2.2, 1.12, 0.62);
    visorGeo.scale(0.135, 0.149, 0.166).translate(head.x, head.y, head.z);
    helmet.add(VISOR, bare(visorGeo));
    for (const [p0, pl] of [
      [Math.PI * 0.5 - 0.16, 0.32],
      [Math.PI * 1.5 - 0.16, 0.32],
    ]) {
      const st = new THREE.SphereGeometry(1, 6, 10, p0, pl, 0.02, p0 > Math.PI ? 1.05 : 1.75);
      st.scale(0.131, 0.145, 0.161).translate(head.x, head.y, head.z);
      helmet.add(paint, bare(st));
    }
    // legs: thighs along the tank, knees bent, boots on the pegs
    for (const s of [-1, 1]) {
      const hj = hip.clone().add(V(s * 0.095, 0, 0));
      const ankle = V(s * px, py + 0.085, pz + 0.085);
      const knee = bend(hj, ankle, THIGH, SHIN, V(s * 0.45, 0.15, -1).normalize(), V());
      rider.add(TROUSERS, limb(hj, knee, 0.08, 0.062));
      rider.add(TROUSERS, limb(knee, ankle, 0.058, 0.046));
      const shinDir = knee.clone().sub(ankle).normalize();
      rider.add(BOOTS, limb(ankle.clone().addScaledVector(shinDir, 0.2), ankle, 0.056, 0.05));
      const heel = ankle.clone().add(V(0, -0.04, 0.06));
      const toe = V(s * (px + 0.01), py + 0.045, pz - 0.13);
      const fd = toe.clone().sub(heel);
      const fl = fd.length();
      fd.normalize();
      const fu = Y.clone().addScaledVector(fd, -fd.y).normalize();
      const foot: THREE.Vector3[][] = [];
      for (const [t, w, h] of [
        [-0.04, 0.0, 0.0],
        [0.0, 0.035, 0.035],
        [0.25, 0.045, 0.048],
        [0.6, 0.048, 0.04],
        [0.85, 0.042, 0.03],
        [1.0, 0.03, 0.02],
        [1.03, 0.0, 0.0],
      ]) foot.push(ring(heel.clone().addScaledVector(fd, t * fl), X, fu, oval(w, h, 14, 0.8)));
      rider.add(BOOTS, loft(foot, false));
    }
    // the hands round the grips (they turn with the bar)
    const gloves = new Parts();
    for (const s of [-1, 1]) {
      const G = V(s * gx, gy, gz);
      const wrist = G.clone().add(V(-s * 0.012, 0.03, 0.062));
      gloves.add(GLOVES, blob(G.clone().add(V(-s * 0.005, 0.004, -0.004)), 0.05, 0.036, 0.04));
      gloves.add(GLOVES, limb(wrist, G.clone().add(V(s * 0.004, 0.014, -0.012)), 0.033, 0.03));
      gloves.add(GLOVES, limb(wrist.clone().add(V(-s * 0.026, -0.016, -0.012)), G.clone().add(V(-s * 0.045, -0.006, -0.022)), 0.014, 0.012, 8));
      // the forearm and upper arm, posed in update()
      const upper = new THREE.Mesh(limb(V(), V(0, UPPER_ARM, 0), 0.056, 0.046), JACKET);
      const fore = new THREE.Group();
      fore.add(new THREE.Mesh(limb(V(), V(0, FOREARM * 0.8, 0), 0.045, 0.039), JACKET), new THREE.Mesh(limb(V(0, FOREARM * 0.68, 0), V(0, FOREARM, 0), 0.043, 0.035), GLOVES));
      for (const m of [upper, ...fore.children]) m.castShadow = true;
      this.body.add(upper, fore);
      this.rider.push(upper, fore);
      // (the elbows out and down)
      this.arms.push({ shoulder: shoulderAt(s).sub(waist), wrist: wrist.sub(P), pole: V(s * 0.55, -1, 0.2).normalize(), upper, fore });
    }

    // ---------------------------------------------------------------- assemble
    const group = this.body;
    root.add(group);
    body.into(group);
    this.rider.push(...rider.into(group));
    // the front about the steering axis, the sliding part of the fork with the wheel in it
    this.front.position.copy(P);
    group.add(this.front);
    front.into(this.front, P);
    this.front.add(this.slider);
    slider.into(this.slider, P);
    this.frontWheel.position.copy(axle).sub(P);
    this.slider.add(this.frontWheel);
    wheelF.into(this.frontWheel);
    this.rider.push(...gloves.into(this.front, P));
    // the swing arm about its pivot, the rear wheel at its end
    this.swing.position.copy(pivot);
    group.add(this.swing);
    swing.into(this.swing, pivot);
    this.rearWheel.position.copy(axleR).sub(pivot);
    this.swing.add(this.rearWheel);
    wheelR.into(this.rearWheel);
    const rel = axleR.clone().sub(pivot);
    this.armLength = rel.length();
    this.armDrop = rel.y;
    // the upper body about the waist, with neck and helmet
    this.torso.position.copy(waist);
    group.add(this.torso);
    this.eyeRest = this.eye.clone().sub(waist);
    this.rider.push(...upperBody.into(this.torso, waist));
    const heads = helmet.into(this.torso, waist);
    this.rider.push(...heads);
    const headLocal = head.clone().sub(waist);
    for (const m of heads) ownHead(m, headLocal, 0.3);
    for (const m of [...this.lamps.indicators.map((i) => i.mesh), ...this.lamps.brake]) m.castShadow = false;
    this.update(standingState(R), 1, 0);
  }

  setCabinOpacity(): void {
    /* nothing hides the road on a motorcycle */
  }

  /** How far it leans into the bend (rad, + = to the right). */
  setLean(angle: number): void {
    this.lean = angle;
  }

  /** Whether the rider sits on it (not while he walks round it). */
  setRider(on: boolean): void {
    for (const o of this.rider) o.visible = on;
    this.torso.visible = on;
  }

  update(s: CarVisualState, dt: number, now: number): void {
    const t = this.tmp;
    // the lean follows the bend smoothly
    const z = -this.lean;
    this.body.rotation.z += (z - this.body.rotation.z) * Math.min(1, dt * 6);
    // the handlebar turns about the raked axis: for the wheel's angle on the road a little more
    const steer = ((s.wheelSteer[0] ?? 0) + (s.wheelSteer[1] ?? 0)) / 2;
    const bar = clamp(steer / Math.cos(this.rake), -0.7, 0.7);
    this.front.quaternion.setFromAxisAngle(this.axis, -bar);
    // the suspension: the fork slides along the axis, the swing arm swings about its pivot
    const R = this.radius;
    const dive = clamp(((s.wheelY[0] ?? R) + (s.wheelY[1] ?? R)) / 2 - R, -0.06, 0.12);
    this.slider.position.copy(this.axis).multiplyScalar(dive / this.axis.y);
    const squat = clamp(((s.wheelY[2] ?? R) + (s.wheelY[3] ?? R)) / 2 - R, -0.06, 0.12);
    const rest = Math.asin(clamp(this.armDrop / this.armLength, -1, 1));
    this.swing.rotation.x = rest - Math.asin(clamp((this.armDrop + squat) / this.armLength, -1, 1));
    this.frontWheel.rotation.x = -((s.wheelSpin[0] ?? 0) + (s.wheelSpin[1] ?? 0)) / 2;
    this.rearWheel.rotation.x = -((s.wheelSpin[2] ?? 0) + (s.wheelSpin[3] ?? 0)) / 2;
    this.swing.updateMatrix();
    for (const k of this.shocks) {
      const low = t.a.copy(k.low).applyMatrix4(this.swing.matrix);
      const d = t.b.subVectors(k.high, low);
      const len = d.length();
      k.mesh.position.copy(low);
      k.mesh.quaternion.setFromUnitVectors(Y, d.normalize());
      k.mesh.scale.set(1, len / k.length, 1);
    }
    // the rider turns his shoulders a little with the bar; his arms reach for the grips
    this.torso.rotation.set(-0.22 * Math.abs(bar), -0.42 * bar, 0, 'YXZ');
    this.torso.updateMatrix();
    this.eye.copy(this.eyeRest).applyMatrix4(this.torso.matrix);
    this.front.updateMatrix();
    for (const a of this.arms) {
      const sh = t.a.copy(a.shoulder).applyMatrix4(this.torso.matrix);
      const wr = t.b.copy(a.wrist).applyMatrix4(this.front.matrix);
      const el = bend(sh, wr, UPPER_ARM, FOREARM, a.pole, t.c);
      const d = t.d.subVectors(el, sh);
      a.upper.position.copy(sh);
      a.upper.scale.set(1, d.length() / UPPER_ARM, 1);
      a.upper.quaternion.setFromUnitVectors(Y, d.normalize());
      d.subVectors(wr, el);
      a.fore.position.copy(el);
      a.fore.scale.set(1, d.length() / FOREARM, 1);
      a.fore.quaternion.setFromUnitVectors(Y, d.normalize());
    }
    this.lamps.update(s);
    this.panel.update(s, now);
    // (the mirrors are drawn in the frame of the front before the scene updates its matrices)
    if (this.body.parent) this.body.updateMatrixWorld(true);
  }

  /** The lean as drawn right now (for the camera of the rider's eyes). */
  get leaning(): number {
    return -this.body.rotation.z;
  }
}

/** Standing upright, nothing turned: the pose the model is built in. */
function standingState(r: number): CarVisualState {
  return {
    speedKmh: 0,
    rpm: 0,
    gear: 0,
    indicator: 0,
    hazard: false,
    blinkOn: false,
    lowBeam: true,
    highBeam: false,
    handbrake: false,
    ignition: false,
    engineRunning: false,
    abs: false,
    seatbelt: true,
    fuel: 1,
    automatic: false,
    showGear: false,
    odometerKm: 0,
    steerWheel: 0,
    wheelSteer: [0, 0, 0, 0],
    wheelSpin: [0, 0, 0, 0],
    wheelY: [r, r, r, r],
    clutch: 0,
    brake: 0,
    throttle: 0,
    handbrakeLever: 0,
    braking: false,
    reversing: false,
  };
}
