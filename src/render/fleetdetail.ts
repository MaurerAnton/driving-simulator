// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The truck, the bus and the tractor in finer detail – for the "very high"
 * graphics only (Graphics.vehicleDetail), like the car's (render/cardetail.ts):
 * built the first time it is switched on, hidden again when it is off.
 *
 * Outside only (their cabs are seen from the driver's seat little more than
 * the instruments already show): the wheels with tread and sidewalls, steel
 * rims with their nuts and hubs (twin tyres at the back of the truck and the
 * bus, the lugs of a tractor's), grille slats, headlamps with reflectors,
 * wipers and the rubber round the windscreen, number plates, marker lamps,
 * mudflaps; for the truck also door seams and handles, steps, mudguards, the
 * fuel tank and the contour marking of the box body and the trailer; for the
 * bus the seals of its doors, roof hatches and the engine's grille; for the
 * tractor louvres on the bonnet, the exhaust's rain cap, a beacon, work
 * lights and the three-point linkage at the back.
 *
 * Each is placed by the measures the plain model is built with (render/truck.ts,
 * render/fleet.ts) – those formulas are repeated here, kept next to each part.
 */
import * as THREE from 'three';
import type { VehicleSpec } from '../sim/vehicle/index.ts';
import { TANDEM_TRAILER } from '../sim/trailer.ts';
import { Frame, Parts, WheelSet, plateTexture } from './detailkit.ts';
import type { WheelSpec } from './detailkit.ts';

/** The finer model of one vehicle: shown or not, and moved with it each frame. */
export interface FleetDetail {
  show(on: boolean): void;
  update(): void;
}

const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
/** a frame looking along an axis: +x right, +y up, the face towards `facing` */
const facingF = (o: THREE.Vector3, facing: 'z-' | 'z+' | 'x-' | 'x+'): Frame =>
  facing === 'z-' ? new Frame(o, v3(-1, 0, 0), v3(0, 1, 0), v3(0, 0, -1)) : facing === 'z+' ? new Frame(o, v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)) : facing === 'x+' ? new Frame(o, v3(0, 0, -1), v3(0, 1, 0), v3(1, 0, 0)) : new Frame(o, v3(0, 0, 1), v3(0, 1, 0), v3(-1, 0, 0));

const TYRE = new THREE.MeshLambertMaterial({ color: 0x1b1c1e });
const STEEL = new THREE.MeshPhongMaterial({ color: 0xb8bcc0, vertexColors: true, shininess: 50, specular: 0x555555 });
const FARM_RIM = new THREE.MeshPhongMaterial({ color: 0xd8d8cc, vertexColors: true, shininess: 30, specular: 0x444444 });
const CALIPER = new THREE.MeshLambertMaterial({ color: 0x2a2c30 });
const RUBBER = new THREE.MeshLambertMaterial({ color: 0x131416 });
const BLACK = new THREE.MeshLambertMaterial({ color: 0x1a1c1f });
const GREY = new THREE.MeshLambertMaterial({ color: 0x4a4f56 });
const CHROME = new THREE.MeshPhongMaterial({ color: 0xd6dbe0, shininess: 110, specular: 0xffffff });
const ALU = new THREE.MeshPhongMaterial({ color: 0xc9ced3, shininess: 80, specular: 0x888888 });
const AMBER = new THREE.MeshLambertMaterial({ color: 0xe08a12, emissive: 0x4a2a04 });
const RED = new THREE.MeshLambertMaterial({ color: 0xb3151a, emissive: 0x300406 });
const WHITE_LAMP = new THREE.MeshLambertMaterial({ color: 0xf2f2ea, emissive: 0x3a3a36 });
/** the contour marking: retro-reflective tape, yellow along the sides, red at the back */
const TAPE_SIDE = new THREE.MeshLambertMaterial({ color: 0xe0b419, emissive: 0x2a2004 });
const TAPE_BACK = new THREE.MeshLambertMaterial({ color: 0xc0181c, emissive: 0x2a0406 });
const MUDGUARD = new THREE.MeshLambertMaterial({ color: 0x1b1d20, side: THREE.DoubleSide });
const BEACON = new THREE.MeshLambertMaterial({ color: 0xff9a10, emissive: 0x6a3a04, transparent: true, opacity: 0.88 });

/** A finer model: what it adds, what of the plain one it hides, and the wheels it moves. */
class Detail implements FleetDetail {
  readonly added: THREE.Object3D[] = [];
  readonly plain: THREE.Object3D[] = [];
  private readonly wheelSets: Array<{ set: WheelSet; groups: THREE.Group[]; radius: number[] }> = [];
  private readonly pos = new THREE.Vector3();

  /** Detailed wheels in place of the plain ones (`groups`, as render/truck.ts `wheel` makes them), each wheel's side by its x. */
  wheels(parent: THREE.Object3D, groups: THREE.Group[], spec: WheelSpec, materials: { metal: THREE.Material } = { metal: STEEL }): void {
    const set = new WheelSet(spec, groups.map((g) => (g.position.x < 0 ? -1 : 1)), { tyre: TYRE, metal: materials.metal, caliper: CALIPER });
    parent.add(set.group);
    this.added.push(set.group);
    for (const g of groups) this.plain.push(...g.children);
    this.wheelSets.push({ set, groups, radius: groups.map(() => spec.radius) });
    // (where the plain ones stand now, before the first update)
    this.update();
  }

  /** Parts merged per material into `parent`. */
  keep(parts: Parts, parent: THREE.Object3D, name: string, shadow = false): void {
    this.added.push(...parts.build(parent, name, shadow));
  }

  /** A number plate in its holder. */
  plate(parent: THREE.Object3D, f: Frame, text: string, rear: boolean): void {
    const p = new Parts();
    p.add(BLACK, f.box(0.548, 0.136, 0.008, 0, 0, -0.002));
    this.keep(p, parent, 'plate holder');
    const m = new THREE.Mesh(f.put(new THREE.PlaneGeometry(0.52, 0.11).translate(0, 0, 0.0035)), new THREE.MeshBasicMaterial({ map: plateTexture(text, rear) }));
    m.name = 'number plate';
    parent.add(m);
    this.added.push(m);
  }

  show(on: boolean): void {
    for (const o of this.added) o.visible = on;
    for (const o of this.plain) o.visible = !on;
  }

  update(): void {
    for (const { set, groups } of this.wheelSets) {
      groups.forEach((g, i) => set.place(i, this.pos.copy(g.position), -g.rotation.y, -g.rotation.x));
    }
  }
}

/** Two wipers parked at the foot of a flat, upright windscreen facing −z at `z` (x0 … x1 its width, y its foot). */
function wipers(p: Parts, x0: number, x1: number, y: number, z: number, scale = 1): void {
  const w = x1 - x0;
  for (const [a, b, px] of [
    [x0 + w * 0.04, x0 + w * 0.47, x0 + w * 0.28],
    [x0 + w * 0.52, x0 + w * 0.95, x0 + w * 0.75],
  ]) {
    const f = facingF(v3((a + b) / 2, y + 0.07 * scale, z - 0.02), 'z-');
    p.add(RUBBER, f.box(b - a, 0.02 * scale, 0.02), f.box((b - a) * 0.92, 0.012 * scale, 0.016, 0, 0, 0.016));
    // the arm, from its pivot below the glass to the middle of the blade
    const foot = v3(px, y - 0.06 * scale, z - 0.03);
    const tip = v3((a + b) / 2, y + 0.07 * scale, z - 0.045);
    const d = tip.clone().sub(foot);
    const fa = new Frame(foot.clone().add(tip).multiplyScalar(0.5), d.clone().normalize(), v3(0, 0, -1));
    p.add(RUBBER, fa.box(d.length(), 0.018 * scale, 0.014 * scale));
    p.add(BLACK, facingF(foot, 'z-').cyl(0.03 * scale, 0.04, 0, 0, 0.005, 12));
  }
}

/** A rubber seal round a flat window facing −z at `z`: x0 … x1, y0 … y1. */
function seal(p: Parts, x0: number, x1: number, y0: number, y1: number, z: number, t = 0.035): void {
  const f = facingF(v3(0, 0, z - 0.004), 'z-');
  p.add(RUBBER, f.box(x1 - x0 + t, t, 0.012, -(x0 + x1) / 2, y0, 0), f.box(x1 - x0 + t, t, 0.012, -(x0 + x1) / 2, y1, 0));
  p.add(RUBBER, f.box(t, y1 - y0, 0.012, -x0, (y0 + y1) / 2, 0), f.box(t, y1 - y0, 0.012, -x1, (y0 + y1) / 2, 0));
}

/** A headlamp unit on a lamp facing `facing` at (x, y, z): a dark frame, two chrome reflectors. */
function headlamp(p: Parts, x: number, y: number, z: number, w: number, h: number, facing: 'z-' | 'z+'): void {
  const f = facingF(v3(x, y, z), facing);
  const t = 0.02;
  p.add(BLACK, f.box(w + 2 * t, t, 0.02, 0, (h + t) / 2, 0.006), f.box(w + 2 * t, t, 0.02, 0, -(h + t) / 2, 0.006), f.box(t, h, 0.02, (w + t) / 2, 0, 0.006), f.box(t, h, 0.02, -(w + t) / 2, 0, 0.006));
  const r = Math.min(h * 0.38, w * 0.2);
  for (const u of [-w * 0.24, w * 0.24]) p.add(CHROME, f.ring(r, r * 0.16, u, 0, 0.008, 18), f.ring(r * 0.45, r * 0.12, u, 0, 0.01, 14));
}

/** Contour marking: dashes of tape along a line from a to b (on a face looking along `n`). */
function tape(p: Parts, mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, n: THREE.Vector3, dash = 0.42, gap = 0.28, width = 0.05): void {
  const d = b.clone().sub(a);
  const len = d.length();
  d.normalize();
  const up = n.clone().cross(d).normalize();
  for (let s = 0.05; s + dash <= len; s += dash + gap) {
    const f = new Frame(a.clone().addScaledVector(d, s + dash / 2).addScaledVector(n, 0.004), d, up, n);
    p.add(mat, f.box(dash, width, 0.004));
  }
}

// ======================================================================================= the truck
export interface TruckParts {
  root: THREE.Group;
  trailer: THREE.Group;
  spec: VehicleSpec;
  wheels: THREE.Group[];
  trailerWheels: THREE.Group[];
}

/** The truck of classes C and C1 with its cab and box body (render/truck.ts), and its trailer. */
export function truckDetail(t: TruckParts): FleetDetail {
  const d = new Detail();
  const s = t.spec;
  // (the measures render/truck.ts builds with)
  const axle = s.wheelbase / 2;
  const hw = (s.width ?? 2.5) / 2;
  const front = -(axle + 1.4);
  const rear = axle + 2.1;
  const cx = hw - 0.05;
  const cz0 = front + 0.02;
  const cz1 = front + 1.85;
  const wy0 = 1.88;
  const wy1 = 2.86;
  const sz0 = front + 0.12;
  const sz1 = front + 1.3;
  const pillar = 0.07;
  const bodyFront = front + 2.0;
  const r = s.wheelRadius;
  const tr = s.track / 2;
  const root = t.root;

  d.wheels(root, [t.wheels[0], t.wheels[1]], { radius: r, width: 0.3, rim: r * 0.6, spokes: 0, nuts: 10, disc: false });
  d.wheels(root, [t.wheels[2], t.wheels[3]], { radius: r, width: 0.6, rim: r * 0.6, spokes: 0, nuts: 10, disc: false, twin: true });
  const tt = TANDEM_TRAILER;
  if (t.trailerWheels.length) d.wheels(t.trailer, t.trailerWheels, { radius: tt.wheelRadius, width: 0.36, rim: tt.wheelRadius * 0.6, spokes: 0, nuts: 10, disc: false });

  const p = new Parts();
  // ---- the cab's front: grille slats, headlamps, the rubber round the windscreen, wipers, a sun visor, marker lamps
  const g = facingF(v3(0, 0, cz0 - 0.014), 'z-');
  for (let i = 0; i < 6; i++) p.add(GREY, g.box(1.62, 0.035, 0.02, 0, 1.12 + i * 0.085, 0.008));
  p.add(CHROME, g.box(1.7, 0.03, 0.02, 0, 1.6, 0.012), g.box(1.7, 0.02, 0.02, 0, 1.06, 0.012));
  for (const side of [-1, 1]) headlamp(p, side * (hw - 0.42), 0.73, front - 0.022, 0.32, 0.22, 'z-');
  seal(p, -cx + pillar, cx - pillar, wy0, wy1, cz0);
  wipers(p, -cx + pillar, cx - pillar, wy0, cz0, 1.2);
  // (the sun visor over the windscreen: from the roof's front edge forwards, a little down)
  p.add(BLACK, new Frame(v3(0, wy1 + 0.1, cz0 - 0.12), v3(1, 0, 0), v3(0, -0.3, -0.95)).box(2 * cx - 0.06, 0.28, 0.025));
  for (const x of [-0.45, 0, 0.45]) p.add(AMBER, facingF(v3(x, 3.0 + 0.03, cz0 + 0.06), 'z-').box(0.14, 0.05, 0.06));
  // ---- the cab's sides: door seams, handles, steps, mudguards over the front wheels
  for (const side of [-1, 1]) {
    const f: 'x-' | 'x+' = side > 0 ? 'x+' : 'x-';
    const o = (y: number, z: number): THREE.Vector3 => v3(side * (cx + 0.003), y, z);
    const zDoor0 = sz0 - 0.07;
    const zDoor1 = sz1 + 0.08;
    p.add(BLACK, facingF(o(1.92, zDoor0), f).box(0.008, 1.9, 0.004), facingF(o(1.92, zDoor1), f).box(0.008, 1.9, 0.004));
    p.add(BLACK, facingF(o(0.98, (zDoor0 + zDoor1) / 2), f).box(zDoor1 - zDoor0, 0.008, 0.004));
    const hf = facingF(o(1.78, zDoor1 - 0.16), f);
    p.add(BLACK, hf.box(0.2, 0.06, 0.004), hf.box(0.16, 0.025, 0.03, 0, 0, 0.012));
    // steps under the door: two treads with ribs
    for (const [y, k] of [
      [0.56, 1],
      [0.88, 0.9],
    ]) {
      const sf = new Frame(v3(side * (cx - 0.08), y, sz0 + 0.55), v3(0, 0, 1), v3(0, 1, 0));
      p.add(GREY, sf.box(0.46 * k, 0.035, 0.22));
      for (const dz of [-0.06, 0, 0.06]) p.add(BLACK, sf.box(0.44 * k, 0.012, 0.02, 0, 0.022, dz));
    }
    // a mudguard over the front wheel (half a ring of sheet round it)
    const mg = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.08, r + 0.08, 0.36, 18, 1, true, Math.PI / 2 - 1.15, 2.3).rotateZ(Math.PI / 2).translate(side * tr, r, -axle), MUDGUARD);
    root.add(mg);
    d.added.push(mg);
    // mudflaps behind the rear wheels, side marker lamps along the box body
    p.add(RUBBER, new Frame(v3(side * (tr - 0.08), 0.42, axle + r + 0.18), v3(1, 0, 0), v3(0, 1, 0)).box(0.55, 0.45, 0.012));
    for (let z = bodyFront + 0.4; z < rear - 0.3; z += 1.6) p.add(AMBER, facingF(v3(side * (hw + 0.012), 1.32, z), f).box(0.1, 0.045, 0.02));
    // contour marking along the box body's lower edge
    tape(p, TAPE_SIDE, v3(side * hw, 1.17, bodyFront + 0.1), v3(side * hw, 1.17, rear - 0.05), v3(side, 0, 0));
  }
  // the fuel tank on the left, between the front wheel and the side guard
  {
    const tf = new Frame(v3(-(hw - 0.33), 0.78, -axle + r + 0.85), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1));
    p.add(ALU, tf.cyl(0.27, 1.0, 0, 0, 0, 24));
    p.add(BLACK, tf.ring(0.274, 0.012, 0, 0, -0.32, 24), tf.ring(0.274, 0.012, 0, 0, 0.32, 24));
    p.add(BLACK, new Frame(v3(-(hw - 0.33), 1.06, -axle + r + 0.7), v3(1, 0, 0), v3(0, 0, -1), v3(0, 1, 0)).cyl(0.05, 0.03, 0, 0, 0, 12));
  }
  // (the back of the box is its doors, which open – render/boxbody.ts: no marking fixed there)
  const bk = v3(0, 0, 1);
  d.keep(p, root, 'truck detail', true);
  d.plate(root, facingF(v3(0, 0.6, front - 0.012), 'z-'), 'KS FS 712', false);
  d.plate(root, facingF(v3(0, 0.72, rear + 0.025), 'z+'), 'KS FS 712', true);

  // ---- the trailer: contour marking, side markers, mudflaps, its plate
  if (t.trailerWheels.length) {
    const thw = tt.width / 2;
    const tFront = -(tt.hitchToAxle - tt.bodyFront);
    const tRear = tt.length - tt.hitchToAxle;
    const q = new Parts();
    for (const side of [-1, 1]) {
      tape(q, TAPE_SIDE, v3(side * thw, 1.17, tFront + 0.1), v3(side * thw, 1.17, tRear - 0.05), v3(side, 0, 0));
      for (let z = tFront + 0.4; z < tRear - 0.3; z += 1.6) q.add(AMBER, facingF(v3(side * (thw + 0.012), 1.32, z), side > 0 ? 'x+' : 'x-').box(0.1, 0.045, 0.02));
      q.add(RUBBER, new Frame(v3(side * (tt.track / 2), 0.38, tt.axleSpread / 2 + tt.wheelRadius + 0.15), v3(1, 0, 0), v3(0, 1, 0)).box(0.45, 0.4, 0.012));
      tape(q, TAPE_BACK, v3(side * (thw - 0.04), 1.3, tRear), v3(side * (thw - 0.04), tt.height - 0.1, tRear), bk, 0.3, 0.2);
    }
    tape(q, TAPE_BACK, v3(-thw + 0.04, 1.18, tRear), v3(thw - 0.04, 1.18, tRear), bk, 0.3, 0.2);
    d.keep(q, t.trailer, 'trailer detail', true);
    d.plate(t.trailer, facingF(v3(0, 0.72, tRear + 0.025), 'z+'), 'KS FS 713', true);
  }
  return d;
}

// ========================================================================================= the bus
export interface BusParts {
  root: THREE.Group;
  spec: VehicleSpec;
  wheels: THREE.Group[];
}

/** The city bus and the minibus (render/fleet.ts PlayerBus). */
export function busDetail(b: BusParts): FleetDetail {
  const d = new Detail();
  const s = b.spec;
  // (the measures render/fleet.ts builds the bus with)
  const hw = (s.width ?? 2.55) / 2 - 0.01;
  const axle = s.wheelbase / 2;
  const long = (s.length ?? 12) > 9;
  const zf = -(axle + (long ? 2.7 : 1.2));
  const zr = zf + (s.length ?? 12);
  const top = long ? 2.62 : 2.32;
  const y1 = long ? 3.0 : 2.7;
  const r = s.wheelRadius;
  const root = b.root;
  d.wheels(root, [b.wheels[0], b.wheels[1]], { radius: r, width: 0.3, rim: r * 0.62, spokes: 0, nuts: 10, disc: false });
  d.wheels(root, [b.wheels[2], b.wheels[3]], { radius: r, width: 0.6, rim: r * 0.62, spokes: 0, nuts: 10, disc: false, twin: true });

  const p = new Parts();
  // ---- the front: the rubber round the windscreen, big wipers, headlamps, marker lamps
  seal(p, -hw + 0.09, hw - 0.09, 1.0, 2.86, zf, 0.04);
  wipers(p, -hw + 0.09, hw - 0.09, 1.04, zf, 1.4);
  for (const side of [-1, 1]) headlamp(p, side * (hw - 0.35), 0.69, zf - 0.032, 0.4, 0.18, 'z-');
  for (const side of [-1, 1]) {
    p.add(AMBER, facingF(v3(side * (hw - 0.08), y1 - 0.05, zf - 0.006), 'z-').box(0.1, 0.05, 0.02));
    p.add(RED, facingF(v3(side * (hw - 0.08), y1 - 0.05, zr + 0.006), 'z+').box(0.1, 0.05, 0.02));
  }
  // ---- the doors (on the right): seals round them and down the middle, between the two leaves
  const doors = long ? [[zf + 0.25, zf + 1.45], [-0.65, 0.65]] : [[zf + 1.6, zf + 2.6]];
  for (const [a, c] of doors) {
    const f = facingF(v3(hw + 0.008, 0, 0), 'x+');
    for (const z of [a + 0.04, (a + c) / 2, c - 0.04]) p.add(RUBBER, f.box(0.035, top - 0.42, 0.016, -z, (0.42 + top) / 2, 0.004));
    p.add(RUBBER, f.box(c - a, 0.035, 0.016, -(a + c) / 2, top - 0.03, 0.004));
  }
  // ---- the roof: hatches; the back: the engine's grille; mudflaps
  for (const z of long ? [zf + 3.2, zr - 3.4] : [zf + 2.4]) p.add(GREY, new Frame(v3(0, y1 + 0.03, z), v3(1, 0, 0), v3(0, 0, -1), v3(0, 1, 0)).box(0.8, 0.7, 0.06));
  const back = facingF(v3(0, 0, zr + 0.008), 'z+');
  for (let i = 0; i < 9; i++) p.add(BLACK, back.box(2 * hw - 1.05, 0.035, 0.02, 0, 0.75 + i * 0.1, 0.006));
  for (const side of [-1, 1]) p.add(RUBBER, new Frame(v3(side * (s.track / 2 - 0.08), 0.42, axle + r + 0.2), v3(1, 0, 0), v3(0, 1, 0)).box(0.5, 0.42, 0.012));
  d.keep(p, root, 'bus detail', true);
  d.plate(root, facingF(v3(0, 0.42, zf - 0.06), 'z-'), 'KS FS 2026', false);
  d.plate(root, facingF(v3(0, 0.42, zr + 0.06), 'z+'), 'KS FS 2026', true);
  return d;
}

// ===================================================================================== the tractor
export interface TractorParts {
  root: THREE.Group;
  wheels: THREE.Group[];
  /** the radii of the wheels as drawn (front, front, rear, rear) */
  radii: number[];
}

/** The tractor (render/fleet.ts PlayerTractor). */
export function tractorDetail(t: TractorParts): FleetDetail {
  const d = new Detail();
  const root = t.root;
  // (the measures render/fleet.ts builds the tractor with)
  const z0 = -0.38;
  const cx = 0.68;
  const roof = 2.95;
  const axle = 2.65 / 2;
  d.wheels(root, [t.wheels[0], t.wheels[1]], { radius: t.radii[0], width: 0.38, rim: t.radii[0] * 0.6, spokes: 0, nuts: 8, disc: false, lugs: true }, { metal: FARM_RIM });
  d.wheels(root, [t.wheels[2], t.wheels[3]], { radius: t.radii[2], width: 0.55, rim: t.radii[2] * 0.62, spokes: 0, nuts: 10, disc: false, lugs: true }, { metal: FARM_RIM });

  const p = new Parts();
  // ---- the bonnet: grille slats, louvres on its sides, bolts in the front weights
  const g = facingF(v3(0, 0, -2.272), 'z-');
  for (let i = 0; i < 7; i++) p.add(GREY, g.box(0.84, 0.03, 0.02, 0, 0.95 + i * 0.075, 0.006));
  p.add(CHROME, g.box(0.03, 0.58, 0.024, 0, 1.2, 0.01));
  for (const side of [-1, 1]) {
    const f = facingF(v3(side * 0.462, 0, 0), side > 0 ? 'x+' : 'x-');
    for (let i = 0; i < 5; i++) p.add(BLACK, f.box(0.45, 0.022, 0.012, side * 1.85, 1.22 + i * 0.06, 0.004));
  }
  const w = facingF(v3(0, 0, -2.425), 'z-');
  for (const x of [-0.35, -0.12, 0.12, 0.35]) p.add(CHROME, w.cyl(0.03, 0.02, x, 0.7, 0.008, 6));
  // ---- the exhaust's rain cap, a beacon and work lights on the roof, a grab handle at the door
  p.add(BLACK, new Frame(v3(0.4, 3.07, -0.38), v3(1, 0, 0), v3(0, 0, -1), v3(0, 1, 0)).cyl(0.06, 0.04, 0, 0, 0, 12));
  p.add(BLACK, new Frame(v3(0.4, 3.11, -0.38), v3(0, 0, 1), v3(0, 0.5, 0.87)).box(0.11, 0.008, 0.11));
  p.add(BLACK, new Frame(v3(-0.5, roof + 0.03, 0.95), v3(1, 0, 0), v3(0, 0, -1), v3(0, 1, 0)).cyl(0.07, 0.05, 0, 0, 0, 14));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.065, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(-0.5, roof + 0.055, 0.95), BEACON);
  root.add(dome);
  d.added.push(dome);
  for (const side of [-1, 1]) {
    const lf = facingF(v3(side * 0.55, roof + 0.05, z0 - 0.1), 'z-');
    p.add(BLACK, lf.box(0.16, 0.11, 0.08));
    p.add(WHITE_LAMP, lf.box(0.13, 0.08, 0.01, 0, 0, 0.042));
  }
  const grab = new Frame(v3(-cx - 0.05, 2.0, z0 + 0.2), v3(0, 0, 1), v3(0, 1, 0));
  p.add(GREY, grab.box(0.03, 0.9, 0.03), grab.box(0.03, 0.03, 0.06, 0, -0.35, -0.03), grab.box(0.03, 0.03, 0.06, 0, 0.35, -0.03));
  p.add(GREY, new Frame(v3(-0.82, 1.0, 0.02), v3(0, 0, 1), v3(0, 1, 0)).box(0.5, 0.035, 0.22));
  // ---- the back: the rear axle's housing, the three-point linkage on it and the drawbar, the PTO's stub
  p.add(GREY, new Frame(v3(0, 0.92, axle - 0.05), v3(1, 0, 0), v3(0, 1, 0)).box(1.2, 0.64, 1.1));
  const az = axle + 0.5;
  const link = (a: THREE.Vector3, b: THREE.Vector3, th: number): void => {
    const dd = b.clone().sub(a);
    p.add(GREY, new Frame(a.clone().add(b).multiplyScalar(0.5), dd.clone().normalize(), v3(0, 1, 0).cross(dd).normalize().cross(dd).normalize().negate()).box(dd.length(), th, th));
  };
  for (const side of [-1, 1]) {
    link(v3(side * 0.3, 0.62, az), v3(side * 0.42, 0.48, az + 0.75), 0.06);
    link(v3(side * 0.42, 1.15, az), v3(side * 0.38, 0.62, az + 0.45), 0.035);
  }
  link(v3(0, 1.2, az), v3(0, 1.0, az + 0.7), 0.05);
  p.add(GREY, new Frame(v3(0, 0.55, az + 0.3), v3(1, 0, 0), v3(0, 1, 0)).box(0.16, 0.06, 0.6));
  p.add(CHROME, new Frame(v3(0, 0.78, az + 0.05), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)).cyl(0.035, 0.12, 0, 0, 0.06, 10));
  d.keep(p, root, 'tractor detail', true);
  d.plate(root, facingF(v3(-0.3, 1.4, 1.135), 'z+'), 'KS FS 315', true);
  return d;
}
