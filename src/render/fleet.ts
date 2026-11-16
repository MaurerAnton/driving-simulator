// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The vehicles of the other licence classes, as seen from outside and from
 * the driver's place: a city bus (D), a tractor (T), a motorcycle (A) and
 * the box trailer behind a car (BE).  Simple shapes in a generic livery – no
 * real vehicle is reproduced.
 *
 * Built like the truck (render/truck.ts) around the point the physics use –
 * the ground below the middle of the wheelbase, the trailer around the
 * middle of its axles –, x to the right, y up, the front towards −z.
 */
import * as THREE from 'three';
import { BUS, TRACTOR } from '../sim/vehicle/fleet.ts';
import type { VehicleSpec } from '../sim/vehicle/index.ts';
import { CAR_TRAILER } from '../sim/trailer.ts';
import type { CarVisualState } from './car.ts';
import { InstrumentPanel } from './instruments.ts';
import { Mirror } from './mirrors.ts';
import { AMBER, BRAND, DARK, FRAME, GLASS, LAMP, LAMP_STOP, TAIL, box, lettering, panel, wheel } from './truck.ts';
import type { Facing } from './truck.ts';

/** What the game asks of the model of the vehicle the player drives. */
export interface VehicleModel {
  readonly root: THREE.Group;
  /** the driver's eyes (model coordinates) */
  readonly eye: THREE.Vector3;
  readonly mirrors: Mirror[];
  setCabinOpacity(opacity: number): void;
  update(s: CarVisualState, dt: number, now: number): void;
}

const OFF = new THREE.MeshLambertMaterial({ color: 0x3a2d2a });

/** The lamps every vehicle has: brake lamps, indicators (by side), and their switching. */
export class Lamps {
  readonly brake: THREE.Mesh[] = [];
  readonly indicators: Array<{ mesh: THREE.Mesh; side: number }> = [];

  update(s: CarVisualState): void {
    for (const l of this.brake) l.material = s.braking ? LAMP_STOP : TAIL;
    const on = s.blinkOn && s.ignition;
    for (const i of this.indicators) i.mesh.material = on && (s.hazard || s.indicator === i.side) ? AMBER : OFF;
  }
}

/** A cab of panels: paint outside, lining inside (seen only from within, and made see-through on request). */
class Shell {
  readonly group = new THREE.Group();
  readonly lining = new THREE.MeshLambertMaterial({ color: 0x5d636b, side: THREE.BackSide });
  readonly fittings = new THREE.MeshLambertMaterial({ color: 0x30343a });
  private readonly paint: THREE.Material;

  constructor(paint: THREE.Material) {
    this.paint = paint;
  }

  wall(facing: Facing, a0: number, a1: number, b0: number, b1: number, at: number, paint = this.paint): void {
    if (Math.abs(a1 - a0) < 1e-3 || Math.abs(b1 - b0) < 1e-3) return;
    const outer = panel(facing, a0, a1, b0, b1, at, paint);
    outer.castShadow = true;
    this.group.add(outer, panel(facing, a0, a1, b0, b1, at, this.lining));
  }

  glass(facing: Facing, a0: number, a1: number, b0: number, b1: number, at: number): void {
    this.group.add(panel(facing, a0, a1, b0, b1, at, GLASS));
  }

  setOpacity(opacity: number): void {
    const o = Number.isFinite(opacity) ? Math.min(1, Math.max(0.05, opacity)) : 1;
    const solid = o >= 0.995;
    for (const m of [this.lining, this.fittings]) {
      if (m.transparent === solid) m.needsUpdate = true;
      m.transparent = !solid;
      m.depthWrite = solid;
      m.opacity = solid ? 1 : o;
    }
  }
}

/** A mirror on an arm, turned to show the driver the side of the vehicle behind. */
function sideMirror(root: THREE.Group, eye: THREE.Vector3, centre: THREE.Vector3, side: number, size: [number, number], convex: number, resolution: [number, number]): Mirror {
  const toEye = eye.clone().sub(centre).normalize();
  const back = new THREE.Vector3(side * 0.06, -0.05, 1).normalize();
  const mirror = new Mirror({ name: side < 0 ? 'left' : 'right', centre, width: size[0], height: size[1], normal: toEye.add(back).normalize(), convex, resolution });
  root.add(mirror.mesh, mirror.makeHousing(0.05, DARK, 0.02));
  return mirror;
}

/** A steering wheel on its column: `tilt` from upright (rad), centre of the wheel at `at`. */
function steeringWheel(group: THREE.Group, at: THREE.Vector3, tilt: number, radius: number, material: THREE.Material): THREE.Group {
  const wheelGroup = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.02, 8, 28), material);
  const spoke = new THREE.Mesh(new THREE.BoxGeometry(radius * 1.9, 0.035, 0.02), material);
  const spoke2 = new THREE.Mesh(new THREE.BoxGeometry(0.035, radius, 0.02), material);
  spoke2.position.y = -radius / 2;
  wheelGroup.add(rim, spoke, spoke2);
  const column = new THREE.Group();
  column.position.copy(at);
  column.rotation.x = -tilt;
  column.add(wheelGroup);
  group.add(column);
  return wheelGroup;
}

/** The instruments, as a lit plate facing the driver. */
function dial(group: THREE.Group, panelTex: THREE.Texture, at: THREE.Vector3, w: number, tilt: number): void {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.3), new THREE.MeshBasicMaterial({ map: panelTex, toneMapped: false }));
  m.position.copy(at);
  // (a plane faces +z: the driver sits behind it, towards +z)
  m.rotation.x = -tilt;
  group.add(m);
}

// ------------------------------------------------------------------------------------ the bus
const BUS_PAINT = new THREE.MeshLambertMaterial({ color: 0xf0eee4 });
const BUS_STRIPE = new THREE.MeshLambertMaterial({ color: 0x1f5fa8 });

/** A low-floor city bus, 12 m, three doors on the right, the engine at the back. */
export class PlayerBus implements VehicleModel {
  readonly root = new THREE.Group();
  readonly eye = new THREE.Vector3(-0.72, 2.02, -4.75);
  readonly mirrors: Mirror[] = [];
  private readonly wheels: THREE.Group[] = [];
  private readonly steering: THREE.Group;
  private readonly lamps = new Lamps();
  private readonly shell = new Shell(BUS_PAINT);
  private readonly panelTex = new InstrumentPanel();
  private readonly spec: VehicleSpec;

  /** `spec`: the bus (12 m, class D) or the minibus (class D1) – its length, height and doors follow from it. */
  constructor(spec: VehicleSpec = BUS) {
    const s = spec;
    this.spec = spec;
    const root = this.root;
    root.name = 'bus';
    const hw = (s.width ?? 2.55) / 2 - 0.01;
    const axle = s.wheelbase / 2;
    const long = (s.length ?? 12) > 9;
    // overhangs: 2.7 m at the front of the big bus, 1.2 m of the minibus
    const zf = -(axle + (long ? 2.7 : 1.2));
    const zr = zf + (s.length ?? 12);
    const y0 = long ? 0.32 : 0.36;
    const sill = long ? 1.18 : 1.1;
    const top = long ? 2.62 : 2.32;
    const y1 = long ? 3.0 : 2.7;
    this.eye.set(-0.62, long ? 2.02 : 1.75, zf + (long ? 0.9 : 1.15));
    const sh = this.shell;
    // --- front: below and above the big windscreen, pillars at its sides
    sh.wall('z-', -hw, hw, y0, 1.0, zf);
    sh.wall('z-', -hw, hw, 2.86, y1, zf);
    for (const side of [-1, 1]) sh.wall('z-', side * hw, side * (hw - 0.09), 1.0, 2.86, zf);
    sh.glass('z-', -hw + 0.09, hw - 0.09, 1.0, 2.86, zf + 0.01);
    // --- the sides: below the windows (with arches over the wheels), the windows, above them
    const arches = [-axle, axle];
    for (const side of [-1, 1]) {
      const f: Facing = side > 0 ? 'x+' : 'x-';
      const x = side * hw;
      // below the windows, and the stripe on it
      let z = zf;
      for (const a of [...arches, zr + 1]) {
        const from = Math.min(a - 0.62, zr);
        sh.wall(f, z, from, y0, sill, x);
        this.root.add(panel(f, z, from, 0.62, 0.78, x + side * 0.004, BUS_STRIPE));
        if (a < zr) sh.wall(f, a - 0.62, a + 0.62, 1.08, sill, x);
        z = a + 0.62;
      }
      sh.wall(f, zf, zr, top, y1, x);
      // windows between pillars – on the right the doors take their place (front and middle)
      const doors = side > 0 ? (long ? [[zf + 0.25, zf + 1.45], [-0.65, 0.65]] : [[zf + 1.6, zf + 2.6]]) : [];
      let z0 = zf + 0.1;
      for (let i = 0; z0 < zr - 1.7; i++) {
        const z1 = Math.min(z0 + 1.55, zr - 1.7);
        sh.wall(f, z0, z0 + 0.1, sill, top, x);
        const door = doors.find(([a, b]) => z0 + 0.1 < b && z1 > a);
        if (!door) sh.glass(f, z0 + 0.1, z1, sill, top, x - side * 0.01);
        z0 = z1;
      }
      sh.wall(f, z0, zr, sill, top, x);
      for (const [a, b] of doors) {
        // a door: glass almost down to the floor, in a dark frame
        sh.wall(f, a, b, y0, sill, x, DARK);
        sh.glass(f, a + 0.05, b - 0.05, 0.42, top - 0.04, x + side * 0.006);
      }
    }
    // --- the back: the engine, no window below the roof edge but a narrow one
    sh.wall('z+', -hw, hw, y0, 2.1, zr);
    sh.wall('z+', -hw, hw, 2.7, y1, zr);
    for (const side of [-1, 1]) sh.wall('z+', side * hw, side * (hw - 0.12), 2.1, 2.7, zr);
    sh.glass('z+', -hw + 0.12, hw - 0.12, 2.1, 2.7, zr - 0.01);
    sh.wall('y+', -hw, hw, zf, zr, y1);
    sh.wall('y-', -hw, hw, zf, zr, y0);
    root.add(sh.group);
    // roof equipment, bumpers, the destination display
    if (long) root.add(box(-hw + 0.25, hw - 0.25, y1, y1 + 0.32, -1.2, 2.4, FRAME));
    root.add(box(-hw, hw, 0.28, 0.55, zf - 0.06, zf + 0.05, DARK));
    root.add(box(-hw, hw, 0.28, 0.55, zr - 0.05, zr + 0.06, DARK));
    const sign = lettering(BRAND, 1.9, 0.24);
    sign.position.set(0, top + 0.12, zf - 0.012);
    sign.rotation.y = Math.PI;
    root.add(sign);
    for (const side of [-1, 1]) {
      const plate = lettering(BRAND, long ? 4.2 : 2.6, long ? 0.42 : 0.3);
      plate.position.set(side * (hw + 0.008), 0.95, long ? 1.6 : zf + 4.4);
      plate.rotation.y = (side * Math.PI) / 2;
      root.add(plate);
    }
    // --- lamps
    for (const side of [-1, 1]) {
      root.add(box(side * (hw - 0.35) - 0.2, side * (hw - 0.35) + 0.2, 0.6, 0.78, zf - 0.03, zf, LAMP, false));
      const stop = box(side * (hw - 0.25) - 0.12, side * (hw - 0.25) + 0.12, 1.0, 1.45, zr, zr + 0.03, TAIL, false);
      this.lamps.brake.push(stop);
      root.add(stop);
      for (const [z, y] of [
        [zf - 0.03, 0.85],
        [zr + 0.03, 1.6],
      ]) {
        const ind = box(side * (hw - 0.2) - 0.08, side * (hw - 0.2) + 0.08, y, y + 0.14, z - 0.015, z + 0.015, OFF, false);
        this.lamps.indicators.push({ mesh: ind, side });
        root.add(ind);
      }
    }
    // --- wheels: single at the front, twin at the back
    const t = s.track / 2;
    for (const [x, z, w] of [
      [-t, -axle, 0.3],
      [t, -axle, 0.3],
      [-t + 0.08, axle, 0.6],
      [t - 0.08, axle, 0.6],
    ]) {
      const g = wheel(s.wheelRadius, w);
      g.position.set(x, s.wheelRadius, z);
      this.wheels.push(g);
      root.add(g);
    }
    // --- inside: the floor, rows of seats, the driver's place
    const inside = new THREE.Group();
    const fit = sh.fittings;
    for (let z = zf + 3.2; z < zr - 0.8; z += 0.85) {
      if (long && z > -1.1 && z < 1.1) continue; // the space at the middle door
      for (const side of [-1, 1]) {
        inside.add(box(side * 0.55 - 0.42, side * 0.55 + 0.42, 0.75, 0.88, z, z + 0.45, fit, false));
        inside.add(box(side * 0.55 - 0.42, side * 0.55 + 0.42, 0.88, 1.5, z + 0.4, z + 0.48, fit, false));
      }
    }
    const ex = this.eye.x;
    inside.add(box(-hw + 0.04, 0.3, 0.75, 1.32, zf + 0.04, zf + 0.55, fit, false)); // dashboard
    dial(inside, this.panelTex.texture, new THREE.Vector3(ex, 1.36, zf + 0.62), 0.5, 1.15);
    this.steering = steeringWheel(inside, new THREE.Vector3(ex, 1.38, zf + 0.82), 1.05, 0.26, fit);
    inside.add(box(ex - 0.28, ex + 0.28, 0.95, 1.12, zf + 1.1, zf + 1.65, fit, false)); // seat
    inside.add(box(ex - 0.28, ex + 0.28, 1.12, 2.0, zf + 1.55, zf + 1.69, fit, false));
    root.add(inside);
    // --- mirrors on arms in front of the windscreen
    for (const side of [-1, 1]) {
      const c = new THREE.Vector3(side * (hw + 0.32), 2.2, zf - 0.32);
      this.mirrors.push(sideMirror(root, this.eye, c, side, [0.24, 0.42], side < 0 ? 1.35 : 1.7, [256, 448]));
      root.add(box(side * hw - (side < 0 ? 0.34 : 0), side * hw + (side > 0 ? 0.34 : 0), 2.62, 2.66, zf - 0.34, zf + 0.02, DARK, false));
    }
  }

  setCabinOpacity(opacity: number): void {
    this.shell.setOpacity(opacity);
  }

  update(s: CarVisualState, _dt: number, now: number): void {
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      // (wheelY is the height of the wheel's centre above the ground under the bus)
      w.position.y = s.wheelY[i] ?? this.spec.wheelRadius;
      w.rotation.set(-(s.wheelSpin[i] ?? 0), i < 2 ? -(s.wheelSteer[i] ?? 0) : 0, 0, 'YXZ');
    }
    this.steering.rotation.z = -s.steerWheel;
    this.lamps.update(s);
    this.panelTex.update(s, now);
  }
}

// -------------------------------------------------------------------------------- the tractor
const TRACTOR_PAINT = new THREE.MeshLambertMaterial({ color: 0xc8442a });
const TRACTOR_RIM = new THREE.MeshLambertMaterial({ color: 0xd8d8d0 });

/** A tractor: big wheels at the back, small ones at the front, a glass cab with the seat in the middle. */
export class PlayerTractor implements VehicleModel {
  readonly root = new THREE.Group();
  readonly eye = new THREE.Vector3(0, 2.42, 0.62);
  readonly mirrors: Mirror[] = [];
  private readonly wheels: THREE.Group[] = [];
  /** the visible wheels are of two sizes (the physics use one): their centres stand at their own radius */
  private readonly radii = [0.56, 0.56, 0.8, 0.8];
  private readonly steering: THREE.Group;
  private readonly lamps = new Lamps();
  private readonly shell = new Shell(TRACTOR_PAINT);
  private readonly panelTex = new InstrumentPanel();

  constructor() {
    const s = TRACTOR;
    const root = this.root;
    root.name = 'tractor';
    const axle = s.wheelbase / 2;
    // --- bonnet with grille and lamps, the chassis under it, weights at the front
    root.add(box(-0.46, 0.46, 0.85, 1.62, -2.25, -0.35, TRACTOR_PAINT));
    root.add(box(-0.5, 0.5, 0.55, 0.9, -2.35, 0.9, FRAME));
    root.add(box(-0.44, 0.44, 0.9, 1.5, -2.27, -2.24, DARK)); // grille
    root.add(box(-0.55, 0.55, 0.45, 0.95, -2.42, -2.25, FRAME)); // front weights
    for (const side of [-1, 1]) root.add(box(side * 0.3 - 0.09, side * 0.3 + 0.09, 1.38, 1.52, -2.28, -2.25, LAMP, false));
    // exhaust pipe at the right front corner of the cab
    root.add(box(0.36, 0.44, 1.6, 3.05, -0.42, -0.34, DARK));
    // --- the cab: posts at the corners, glass all round, a roof
    const sh = this.shell;
    const cx = 0.68;
    const z0 = -0.38;
    const z1 = 1.12;
    const floor = 1.3;
    const roof = 2.95;
    sh.wall('y-', -cx, cx, z0, z1, floor);
    sh.wall('y+', -cx - 0.08, cx + 0.08, z0 - 0.08, z1 + 0.08, roof);
    for (const side of [-1, 1]) {
      const f: Facing = side > 0 ? 'x+' : 'x-';
      sh.wall(f, z0, z1, floor, 1.52, side * cx); // below the glass
      sh.glass(f, z0 + 0.06, z1 - 0.06, 1.52, roof - 0.05, side * cx);
      for (const z of [z0, z1 - 0.06]) root.add(box(side * cx - 0.035, side * cx + 0.035, floor, roof, z, z + 0.06, DARK, false));
    }
    sh.wall('z-', -cx, cx, floor, 1.6, z0);
    sh.glass('z-', -cx + 0.04, cx - 0.04, 1.6, roof - 0.05, z0);
    sh.wall('z+', -cx, cx, floor, 1.55, z1);
    sh.glass('z+', -cx + 0.04, cx - 0.04, 1.55, roof - 0.05, z1);
    root.add(sh.group);
    // --- mudguards over the rear wheels and a step to the door on the left
    for (const side of [-1, 1]) {
      root.add(box(side * 0.68, side * 0.68 + side * 0.62, 1.58, 1.64, axle - 0.85, axle + 0.75, TRACTOR_PAINT));
      root.add(box(side * 0.68 - 0.03, side * 0.68 + 0.03, 0.95, 1.6, axle - 0.85, axle - 0.15, TRACTOR_PAINT));
    }
    root.add(box(-0.95, -0.7, 0.62, 0.66, -0.25, 0.3, DARK));
    // --- lamps at the back (on the mudguards) and indicators on the cab corners
    for (const side of [-1, 1]) {
      const stop = box(side * 1.12 - 0.08, side * 1.12 + 0.08, 1.48, 1.58, axle + 0.74, axle + 0.77, TAIL, false);
      this.lamps.brake.push(stop);
      root.add(stop);
      for (const z of [z0 - 0.04, axle + 0.78]) {
        const ind = box(side * (z < 0 ? cx + 0.05 : 1.12) - 0.05, side * (z < 0 ? cx + 0.05 : 1.12) + 0.05, z < 0 ? 2.8 : 1.36, z < 0 ? 2.9 : 1.46, z - 0.02, z + 0.02, OFF, false);
        this.lamps.indicators.push({ mesh: ind, side });
        root.add(ind);
      }
    }
    // --- wheels: small and narrow at the front, big and wide at the back
    for (const [x, z, w, r] of [
      [-0.93, -axle, 0.38, this.radii[0]],
      [0.93, -axle, 0.38, this.radii[1]],
      [-0.92, axle, 0.55, this.radii[2]],
      [0.92, axle, 0.55, this.radii[3]],
    ]) {
      const g = wheel(r, w);
      // (light rims, and the lugs of a tractor tyre as a darker ring)
      (g.children[1] as THREE.Mesh).material = TRACTOR_RIM;
      g.position.set(x, r, z);
      this.wheels.push(g);
      root.add(g);
    }
    // --- inside: the seat in the middle, the wheel before it, the instruments on the column
    const inside = new THREE.Group();
    const fit = sh.fittings;
    inside.add(box(-0.27, 0.27, 1.62, 1.76, 0.42, 0.92, fit, false));
    inside.add(box(-0.27, 0.27, 1.76, 2.35, 0.86, 0.98, fit, false));
    inside.add(box(-0.18, 0.18, floor, 2.0, z0 + 0.02, z0 + 0.32, fit, false)); // the console before the wheel
    dial(inside, this.panelTex.texture, new THREE.Vector3(0, 2.02, z0 + 0.36), 0.36, 0.55);
    this.steering = steeringWheel(inside, new THREE.Vector3(0, 2.0, 0.02), 0.62, 0.21, fit);
    root.add(inside);
    // --- mirrors on arms at the front corners of the cab
    for (const side of [-1, 1]) {
      const c = new THREE.Vector3(side * (cx + 0.42), 2.35, z0 - 0.05);
      this.mirrors.push(sideMirror(root, this.eye, c, side, [0.2, 0.3], 1.4, [192, 288]));
      root.add(box(side * cx - (side < 0 ? 0.4 : 0), side * cx + (side > 0 ? 0.4 : 0), 2.5, 2.53, z0 - 0.07, z0 - 0.03, DARK, false));
    }
  }

  setCabinOpacity(opacity: number): void {
    this.shell.setOpacity(opacity);
  }

  update(s: CarVisualState, _dt: number, now: number): void {
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      // (the physics' wheels are all of one size, and wheelY is where their centres are: the drawn ones,
      // of two sizes, move up and down with them and keep touching the ground)
      w.position.y = (s.wheelY[i] ?? TRACTOR.wheelRadius) - TRACTOR.wheelRadius + this.radii[i];
      // the big wheels turn more slowly for the same speed
      const spin = (s.wheelSpin[i] ?? 0) * (TRACTOR.wheelRadius / this.radii[i]);
      w.rotation.set(-spin, i < 2 ? -(s.wheelSteer[i] ?? 0) : 0, 0, 'YXZ');
    }
    this.steering.rotation.z = -s.steerWheel;
    this.lamps.update(s);
    this.panelTex.update(s, now);
  }
}

// ----------------------------------------------------------------------------- the motorcycle
// (with its rider, in a build for each class: render/bike.ts)
export { PlayerBike } from './bike.ts';

// ------------------------------------------------------------------------- the car's trailer
const TRAILER_PAINT = new THREE.MeshLambertMaterial({ color: 0x8a9096 });
const TARP = new THREE.MeshLambertMaterial({ color: 0x2f5d3a });

/** A tandem box trailer with a tarpaulin behind a car (class BE), around the middle of its axles. */
export class CarTrailerModel {
  readonly group = new THREE.Group();
  private readonly wheels: THREE.Group[] = [];
  private readonly lamps = new Lamps();

  constructor() {
    const t = CAR_TRAILER;
    const g = this.group;
    g.name = 'car trailer';
    const hw = t.width / 2;
    const front = -(t.hitchToAxle - t.bodyFront);
    const rear = t.length - t.hitchToAxle;
    const hitchY = t.hitch?.height ?? 0.45;
    g.add(box(-hw, hw, 0.55, 0.95, front, rear, TRAILER_PAINT)); // the box
    g.add(box(-hw + 0.02, hw - 0.02, 0.95, t.height, front + 0.02, rear - 0.02, TARP)); // the tarpaulin
    g.add(box(-0.6, 0.6, 0.42, 0.55, front - 0.1, rear - 0.2, FRAME));
    // the drawbar (an A-frame) up to the coupling head
    for (const side of [-1, 1]) {
      const bar = box(-0.04, 0.04, hitchY - 0.05, hitchY + 0.05, -t.hitchToAxle + 0.15, front + 0.05, FRAME);
      bar.position.x = side * 0.32;
      bar.rotation.y = side * 0.27;
      g.add(bar);
    }
    g.add(box(-0.07, 0.07, hitchY - 0.06, hitchY + 0.08, -t.hitchToAxle - 0.05, -t.hitchToAxle + 0.3, DARK));
    // wheels with mudguards
    for (const side of [-1, 1]) {
      for (const z of [-t.axleSpread / 2, t.axleSpread / 2]) {
        const w = wheel(t.wheelRadius, 0.2);
        w.position.set(side * (t.track / 2), t.wheelRadius, z);
        this.wheels.push(w);
        g.add(w);
      }
      g.add(box(side * (hw - 0.02) - 0.11, side * (hw - 0.02) + 0.11, 0.66, 0.69, -0.85, 0.85, DARK));
      const stop = box(side * (hw - 0.22) - 0.1, side * (hw - 0.22) + 0.1, 0.62, 0.74, rear, rear + 0.03, TAIL, false);
      this.lamps.brake.push(stop);
      g.add(stop);
      const ind = box(side * (hw - 0.06) - 0.05, side * (hw - 0.06) + 0.05, 0.62, 0.74, rear, rear + 0.035, OFF, false);
      this.lamps.indicators.push({ mesh: ind, side });
      g.add(ind);
    }
  }

  /** Where it is (the middle of its axles on the ground), and its lamps as the car's. */
  place(x: number, y: number, z: number, yaw: number, pitch: number, wheelSpin: number, s: CarVisualState | null): void {
    this.group.position.set(x, y, z);
    this.group.rotation.set(pitch, yaw, 0, 'YXZ');
    for (const w of this.wheels) w.rotation.x = -wheelSpin;
    if (s) this.lamps.update(s);
  }
}

// --------------------------------------------------------------------------------- the tram's cab
/**
 * The driver's cab at the front of the player's tram – only its inside: the
 * tram itself is drawn with the others (render/trams.ts), and from within
 * its walls are not seen.  Around the middle of the first car (on the rails),
 * the front towards −z: the desk with the controller and the instruments, the
 * seat, the walls of the cab below and above the windows.
 */
export class TramCab implements VehicleModel {
  readonly root = new THREE.Group();
  readonly eye = new THREE.Vector3(0, 2.15, -3.35);
  readonly mirrors: Mirror[] = [];
  private readonly shell = new Shell(FRAME);
  private readonly panelTex = new InstrumentPanel();
  /** the controller's handle: forwards for power, back for the brake */
  private readonly handle = new THREE.Group();

  constructor() {
    const root = this.root;
    root.name = 'tram cab';
    const sh = this.shell;
    const hw = 1.17;
    const zf = -4.62;
    const zb = -2.1;
    const floor = 0.95;
    const sill = 1.35;
    const top = 2.7;
    const roof = 3.2;
    // (only the lining: the paint outside is the tram's own)
    const lining = (facing: Facing, a0: number, a1: number, b0: number, b1: number, at: number): void => {
      sh.group.add(panel(facing, a0, a1, b0, b1, at, sh.lining));
    };
    lining('z-', -hw, hw, floor, sill - 0.1, zf);
    lining('z-', -hw, hw, top + 0.1, roof, zf);
    for (const side of [-1, 1]) {
      const f: Facing = side > 0 ? 'x+' : 'x-';
      lining(f, zf, zb, floor, sill, side * hw);
      lining(f, zf, zb, top, roof, side * hw);
      // the pillars beside the windscreen
      lining('z-', side * hw, side * (hw - 0.12), sill - 0.1, top + 0.1, zf);
    }
    lining('y+', -hw, hw, zf, zb, roof);
    lining('y-', -hw, hw, zf, zb, floor);
    // the wall behind the driver, with the door to the passengers
    lining('z+', -hw, -0.4, floor, roof, zb);
    lining('z+', 0.4, hw, floor, roof, zb);
    lining('z+', -0.4, 0.4, 2.2, roof, zb);
    root.add(sh.group);
    const fit = sh.fittings;
    // the desk across the cab, the instruments on it, the controller on its left
    root.add(box(-0.95, 0.95, floor, 1.62, zf + 0.05, zf + 0.62, fit, false));
    dial(root, this.panelTex.texture, new THREE.Vector3(0.18, 1.7, zf + 0.5), 0.42, 0.7);
    this.handle.position.set(-0.55, 1.62, zf + 0.42);
    const stick = box(-0.025, 0.025, 0, 0.2, -0.025, 0.025, DARK, false);
    const knob = box(-0.05, 0.05, 0.2, 0.26, -0.04, 0.04, fit, false);
    this.handle.add(stick, knob);
    root.add(this.handle);
    // the seat
    root.add(box(-0.28, 0.28, floor + 0.55, floor + 0.68, zf + 1.05, zf + 1.6, fit, false));
    root.add(box(-0.28, 0.28, floor + 0.68, floor + 1.45, zf + 1.52, zf + 1.66, fit, false));
  }

  setCabinOpacity(opacity: number): void {
    this.shell.setOpacity(opacity);
  }

  /** The controller's position: −1 full brake … 1 full power. */
  setLever(lever: number): void {
    this.handle.rotation.x = -lever * 0.55;
  }

  update(s: CarVisualState, _dt: number, now: number): void {
    this.panelTex.update(s, now);
  }
}
