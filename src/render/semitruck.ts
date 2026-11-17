// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The heavy trucks: the tractor unit of the articulated lorry (class CE),
 * its curtain-sider semi-trailer, and the three-axle rigid
 * truck with a box body of class C.  Simple shapes, generic liveries – no real
 * vehicle is reproduced.
 *
 * The tractor and the rigid truck share a cab (HeavyCab): a high cab over the
 * engine, its windows, the driver's place with the instruments, the steering
 * wheel and the screen with the map, and the two big mirrors – the parts of
 * the truck of class C1/CE (render/truck.ts) made bigger.  The tractor's is a
 * long-distance cab with a bunk and a high roof; the rigid's a shorter one
 * with a roof spoiler.  They differ in colour from the blue of the C1.
 *
 * Built around the points the physics use (sim/semitrailer.ts): the trucks
 * around the ground point below the middle of their wheelbase, the
 * semi-trailer around the middle of its tri-axle (x right, y up, z back, the
 * front towards −z).
 */
import * as THREE from 'three';
import type { Trailer, TrailerSpec } from '../sim/trailer.ts';
import { FIFTH_WHEEL, HEAVY_RIGID, SEMI_TRAILER, SemiTrailer, TRACTOR_OUTLINE, TRACTOR_UNIT, isSemiSpec } from '../sim/semitrailer.ts';
import type { VehicleSpec } from '../sim/vehicle/index.ts';
import type { CarVisualState } from './car.ts';
import { CarTrailerModel, Lamps } from './fleet.ts';
import type { VehicleModel } from './fleet.ts';
import { InstrumentPanel } from './instruments.ts';
import { Mirror } from './mirrors.ts';
import { NavScreen } from './navscreen.ts';
import { BoxBody } from './boxbody.ts';
import { BRAND, DARK, FRAME, GLASS, LAMP, TAIL, box, lettering, panel, wheel } from './truck.ts';
import type { Facing } from './truck.ts';

const TRACTOR_PAINT = new THREE.MeshLambertMaterial({ color: 0x8e1b22 });
const RIGID_PAINT = new THREE.MeshLambertMaterial({ color: 0x2c6b3f });
const SILVER = new THREE.MeshLambertMaterial({ color: 0xaab0b6 });
const LIGHT_GREY = new THREE.MeshLambertMaterial({ color: 0xdfe2e4 });
const CURTAIN = new THREE.MeshLambertMaterial({ color: 0x24426b });
const GREASE = new THREE.MeshLambertMaterial({ color: 0x2a2620 });
const RED_LINE = new THREE.MeshLambertMaterial({ color: 0xc0261e });
const YELLOW_LINE = new THREE.MeshLambertMaterial({ color: 0xe0b31c });
const MARKER = new THREE.MeshLambertMaterial({ color: 0xd98a1c, emissive: 0x3a2000 });

interface CabSpec {
  /** where the bumper is (z, negative) and how long the cab is */
  front: number;
  length: number;
  hw: number;
  /** the cab's floor and roof */
  floor: number;
  roof: number;
  paint: THREE.Material;
  /** a bunk behind the seats (a long-distance cab) */
  bunk: boolean;
  /** a spoiler on the roof up to this height (0: none) */
  spoiler: number;
}

/**
 * A truck's cab with what is in it: shell (paint outside, lining inside,
 * windows open), grille, lamps, steps; dashboard, instruments, steering
 * wheel, seats, the screen with the map; the mirrors.  Added to `root`.
 */
class HeavyCab {
  readonly eye: THREE.Vector3;
  readonly mirrors: Mirror[] = [];
  readonly navScreen: NavScreen;
  readonly steering = new THREE.Group();
  readonly panel = new InstrumentPanel();
  readonly lining = new THREE.MeshLambertMaterial({ color: 0x565b63, side: THREE.BackSide });
  readonly fittings = new THREE.MeshLambertMaterial({ color: 0x30343a });

  constructor(root: THREE.Group, lamps: Lamps, c: CabSpec) {
    const hw = c.hw;
    const cx = hw - 0.05;
    const cy0 = c.floor;
    const cy1 = c.roof;
    const cz0 = c.front + 0.02;
    const cz1 = c.front + c.length;
    const wy0 = c.floor + 0.95;
    const wy1 = Math.min(c.roof - 0.25, wy0 + 1.0);
    const sy1 = wy1 - 0.08;
    const sz0 = cz0 + 0.12;
    const sz1 = cz0 + 1.25;
    const pillar = 0.08;
    this.eye = new THREE.Vector3(-0.62, wy0 + 0.55, cz0 + 1.05);
    const cab = new THREE.Group();
    const wall = (facing: Facing, a0: number, a1: number, b0: number, b1: number, at: number): void => {
      const outer = panel(facing, a0, a1, b0, b1, at, c.paint);
      outer.castShadow = true;
      cab.add(outer, panel(facing, a0, a1, b0, b1, at, this.lining));
    };
    wall('z-', -cx, cx, cy0, wy0, cz0);
    wall('z-', -cx, cx, wy1, cy1, cz0);
    for (const side of [-1, 1]) wall('z-', side * cx, side * (cx - pillar), wy0, wy1, cz0);
    cab.add(panel('z-', -cx + pillar, cx - pillar, wy0, wy1, cz0 + 0.01, GLASS));
    // the grille: dark slats over the whole front below the windscreen
    for (let i = 0; i < 4; i++) {
      const y = cy0 + 0.12 + i * 0.19;
      cab.add(box(-0.9, 0.9, y, y + 0.11, cz0 - 0.03, cz0 - 0.005, DARK, false));
    }
    // a sun visor over the windscreen
    cab.add(box(-cx, cx, wy1 + 0.02, wy1 + 0.1, cz0 - 0.3, cz0, c.paint, false));
    for (const side of [-1, 1]) {
      const f: Facing = side > 0 ? 'x+' : 'x-';
      wall(f, cz0, cz1, cy0, wy0, side * cx);
      wall(f, cz0, cz1, sy1, cy1, side * cx);
      wall(f, cz0, sz0, wy0, sy1, side * cx);
      wall(f, sz1, cz1, wy0, sy1, side * cx);
      cab.add(panel(f, sz0, sz1, wy0, sy1, side * (cx - 0.01), GLASS));
      // steps up to the door, and a grab handle
      for (const y of [0.45, 0.8]) cab.add(box(side * (hw - 0.3), side * (hw - 0.02), y, y + 0.05, sz0, sz0 + 0.45, DARK, false));
      cab.add(box(side * (hw + 0.01), side * (hw + 0.04), wy0 - 0.6, wy0 + 0.2, sz1 + 0.05, sz1 + 0.09, SILVER, false));
    }
    wall('z+', -cx, cx, cy0, cy1, cz1);
    wall('y+', -cx, cx, cz0, cz1, cy1);
    wall('y-', -cx, cx, cz0, cz1, cy0);
    if (c.spoiler > cy1) {
      // the roof spoiler: a wedge rising from the front of the roof towards the box behind
      const s = box(-cx + 0.1, cx - 0.1, cy1, c.spoiler, cz0 + 0.5, cz1 - 0.05, c.paint);
      cab.add(s);
    }
    root.add(cab);
    // bumper with the headlamps (made of LAMP: lightLamps switches them) and indicators
    root.add(box(-hw + 0.02, hw - 0.02, 0.4, cy0 + 0.05, c.front - 0.05, c.front + 0.3, DARK));
    for (const side of [-1, 1]) {
      root.add(box(side * (hw - 0.45) - 0.2, side * (hw - 0.45) + 0.2, 0.62, 0.82, c.front - 0.07, c.front - 0.03, LAMP, false));
      const ind = box(side * (hw - 0.12) - 0.08, side * (hw - 0.12) + 0.08, 0.62, 0.82, c.front - 0.07, c.front - 0.03, DARK, false);
      lamps.indicators.push({ mesh: ind, side });
      root.add(ind);
    }

    // ---- inside: dashboard, instruments, steering wheel, seats (and a bunk)
    const cabin = new THREE.Group();
    const ex = this.eye.x;
    const fit = this.fittings;
    cabin.add(box(-cx + 0.02, cx - 0.02, wy0 - 0.45, wy0 - 0.02, cz0 + 0.02, cz0 + 0.55, fit, false));
    cabin.add(box(ex - 0.33, ex + 0.33, wy0 - 0.02, wy0 + 0.2, cz0 + 0.06, cz0 + 0.24, fit, false));
    const dial = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.17), new THREE.MeshBasicMaterial({ map: this.panel.texture, toneMapped: false }));
    dial.position.set(ex, wy0 + 0.095, cz0 + 0.245);
    cabin.add(dial);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.022, 8, 28), fit);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.035, 0.02), fit);
    const spoke2 = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.24, 0.02), fit);
    spoke2.position.y = -0.12;
    this.steering.add(rim, spoke, spoke2);
    const column = new THREE.Group();
    column.position.set(ex, wy0 + 0.05, cz0 + 0.72);
    column.rotation.x = -0.95;
    column.add(this.steering);
    cabin.add(column);
    const seatZ = cz0 + 1.45;
    for (const x of [ex, -ex]) {
      cabin.add(box(x - 0.27, x + 0.27, wy0 - 0.58, wy0 - 0.42, seatZ - 0.26, seatZ + 0.26, fit, false));
      cabin.add(box(x - 0.27, x + 0.27, wy0 - 0.42, wy0 + 0.45, seatZ + 0.22, seatZ + 0.36, fit, false));
    }
    if (c.bunk) cabin.add(box(-cx + 0.05, cx - 0.05, cy0 + 0.55, cy0 + 0.75, cz1 - 0.7, cz1 - 0.05, fit, false));
    this.navScreen = new NavScreen(0.27).place(cabin, new THREE.Vector3(ex + 0.62, wy0 + 0.13, cz0 + 0.3), this.eye, new THREE.Vector3(ex + 0.62, wy0 - 0.02, cz0 + 0.33));
    root.add(cabin);

    // ---- the mirrors on arms ahead of the doors
    const my = wy0 + 0.55;
    for (const side of [-1, 1]) {
      const centre = new THREE.Vector3(side * (hw + 0.28), my, cz0 + 0.08);
      const toEye = this.eye.clone().sub(centre).normalize();
      const back = new THREE.Vector3(side * 0.06, -0.05, 1).normalize();
      const normal = toEye.add(back).normalize();
      const mirror = new Mirror({ name: side < 0 ? 'left' : 'right', centre, width: 0.23, height: 0.42, normal, convex: side < 0 ? 1.35 : 1.7, resolution: [256, 448] });
      this.mirrors.push(mirror);
      root.add(mirror.mesh);
      for (const y of [my + 0.245, my - 0.285]) root.add(box(side * hw - (side < 0 ? 0.32 : 0), side * hw + (side > 0 ? 0.32 : 0), y, y + 0.04, cz0 + 0.02, cz0 + 0.06, DARK, false));
      root.add(mirror.makeHousing(0.05, DARK, 0.02));
    }
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

/** The road wheels of a truck: the wheel groups and which of the physics' four (FL, FR, RL, RR) each follows. */
interface Wheels {
  groups: THREE.Group[];
  of: number[];
}

function addWheel(root: THREE.Group, w: Wheels, radius: number, width: number, x: number, z: number, of: number): void {
  const g = wheel(radius, width);
  g.position.set(x, radius, z);
  w.groups.push(g);
  w.of.push(of);
  root.add(g);
}

function updateWheels(w: Wheels, s: CarVisualState, radius: number): void {
  for (let i = 0; i < w.groups.length; i++) {
    const j = w.of[i];
    const g = w.groups[i];
    g.position.y = s.wheelY[j] ?? radius;
    g.rotation.set(-(s.wheelSpin[j] ?? 0), j < 2 ? -(s.wheelSteer[j] ?? 0) : 0, 0, 'YXZ');
  }
}

/** Rear lamps of a truck or trailer at `z` (facing back): tail and brake lamps, indicators. */
function rearLamps(root: THREE.Group, lamps: Lamps, hw: number, y: number, z: number): void {
  for (const side of [-1, 1]) {
    const stop = box(side * (hw - 0.32) - 0.15, side * (hw - 0.32) + 0.15, y, y + 0.16, z - 0.02, z + 0.02, TAIL, false);
    lamps.brake.push(stop);
    root.add(stop);
    const ind = box(side * (hw - 0.09) - 0.07, side * (hw - 0.09) + 0.07, y, y + 0.16, z - 0.02, z + 0.025, DARK, false);
    lamps.indicators.push({ mesh: ind, side });
    root.add(ind);
  }
}

// ------------------------------------------------------------------------- the tractor unit

/**
 * The tractor unit: long-distance cab, frame with the fifth wheel over the
 * rear axle, fuel tank, the coiled lines (red, yellow, the cable) behind the
 * cab, mudguards and the rear lamps on a bar at the end of the frame.
 */
export class PlayerSemi implements VehicleModel {
  readonly root = new THREE.Group();
  readonly eye: THREE.Vector3;
  readonly mirrors: Mirror[];
  readonly navScreen: NavScreen;
  private readonly cab: HeavyCab;
  private readonly lamps = new Lamps();
  private readonly wheels: Wheels = { groups: [], of: [] };
  private readonly spec: VehicleSpec = TRACTOR_UNIT;

  constructor() {
    const s = this.spec;
    const root = this.root;
    root.name = 'tractor unit';
    const axle = s.wheelbase / 2;
    const hw = (s.width ?? 2.5) / 2;
    const front = -TRACTOR_OUTLINE.front;
    const rear = TRACTOR_OUTLINE.rear;
    this.cab = new HeavyCab(root, this.lamps, { front, length: TRACTOR_OUTLINE.front - TRACTOR_OUTLINE.cabBack, hw, floor: 1.1, roof: 3.85, paint: TRACTOR_PAINT, bunk: true, spoiler: 0 });
    this.eye = this.cab.eye;
    this.mirrors = this.cab.mirrors;
    this.navScreen = this.cab.navScreen;

    // ---- frame: two rails, the engine's block under the cab
    for (const side of [-1, 1]) root.add(box(side * 0.45 - 0.06, side * 0.45 + 0.06, 0.72, 1.0, front + 0.3, rear, FRAME));
    root.add(box(-0.5, 0.5, 0.55, 1.05, front + 0.4, -TRACTOR_OUTLINE.cabBack + 0.3, DARK));
    // the catwalk behind the cab, and the lines coiled on their bracket
    root.add(box(-0.7, 0.7, 1.0, 1.04, -TRACTOR_OUTLINE.cabBack + 0.02, -TRACTOR_OUTLINE.cabBack + 0.5, SILVER));
    const coil = (m: THREE.Material, x: number): void => {
      const t = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.02, 6, 16), m);
      t.position.set(x, 2.05, -TRACTOR_OUTLINE.cabBack + 0.08);
      root.add(t);
    };
    coil(RED_LINE, 0.15);
    coil(YELLOW_LINE, 0.45);
    coil(DARK, -0.15);
    root.add(box(-0.3, 0.6, 2.3, 2.38, -TRACTOR_OUTLINE.cabBack + 0.02, -TRACTOR_OUTLINE.cabBack + 0.1, FRAME, false));
    // fuel tank on the right, battery box and air tanks on the left, side guards
    root.add(box(hw - 0.62, hw - 0.04, 0.55, 1.05, -axle + 0.85, axle - 0.85, SILVER));
    root.add(box(-hw + 0.06, -hw + 0.55, 0.55, 0.95, -axle + 0.85, -axle + 1.55, DARK));
    for (const z of [0.2, 0.55]) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.9, 10), SILVER);
      tank.rotation.x = Math.PI / 2;
      tank.position.set(-0.75, 0.62, z);
      root.add(tank);
    }
    // ---- the fifth wheel: a greased plate with its slot, on a mounting plate, over the rear axle
    const fw = axle + FIFTH_WHEEL.behindRearAxle;
    root.add(box(-0.55, 0.55, 1.0, FIFTH_WHEEL.height - 0.12, fw - 0.5, fw + 0.5, FRAME));
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 20), GREASE);
    plate.position.set(0, FIFTH_WHEEL.height - 0.05, fw);
    plate.castShadow = true;
    root.add(plate);
    root.add(box(-0.08, 0.08, FIFTH_WHEEL.height - 0.01, FIFTH_WHEEL.height + 0.005, fw, fw + 0.43, DARK, false));
    for (const side of [-1, 1]) {
      const ramp = box(-0.08, 0.08, FIFTH_WHEEL.height - 0.1, FIFTH_WHEEL.height - 0.02, fw + 0.3, fw + 0.75, GREASE, false);
      ramp.position.x = side * 0.28;
      ramp.rotation.x = 0.22;
      root.add(ramp);
    }
    // the release handle, on the left
    root.add(box(-0.62, -0.42, FIFTH_WHEEL.height - 0.1, FIFTH_WHEEL.height - 0.06, fw - 0.04, fw, SILVER, false));
    // ---- mudguards over the rear wheels, the rear bar with the lamps
    for (const side of [-1, 1]) root.add(box(side * (s.track / 2) - 0.35, side * (s.track / 2) + 0.35, 1.08, 1.12, axle - 0.6, axle + 0.6, DARK));
    root.add(box(-hw + 0.05, hw - 0.05, 0.75, 0.95, rear - 0.12, rear, FRAME));
    rearLamps(root, this.lamps, hw, 0.78, rear + 0.01);
    // ---- wheels: front single, rear twin
    const t = s.track / 2;
    addWheel(root, this.wheels, s.wheelRadius, 0.32, -t, -axle, 0);
    addWheel(root, this.wheels, s.wheelRadius, 0.32, t, -axle, 1);
    addWheel(root, this.wheels, s.wheelRadius, 0.6, -t + 0.08, axle, 2);
    addWheel(root, this.wheels, s.wheelRadius, 0.6, t - 0.08, axle, 3);
  }

  setCabinOpacity(opacity: number): void {
    this.cab.setOpacity(opacity);
  }

  update(s: CarVisualState, _dt: number, now: number): void {
    updateWheels(this.wheels, s, this.spec.wheelRadius);
    this.cab.steering.rotation.z = -s.steerWheel;
    this.lamps.update(s, this.root);
    this.cab.panel.update(s, now);
  }

  dispose(): void {
    for (const m of this.mirrors) m.target.dispose();
  }
}

// ------------------------------------------------------------------------- the rigid truck of class C

/**
 * The three-axle rigid truck of class C: a shorter cab with a roof spoiler,
 * green, on a frame with the twin-tyred drive axle and a single-tyred tag
 * axle behind it, and a box body whose rear doors open for the loading
 * (render/boxbody.ts – where services.boxInside expects it).
 */
export class PlayerRigid implements VehicleModel {
  readonly root = new THREE.Group();
  readonly eye: THREE.Vector3;
  readonly mirrors: Mirror[];
  readonly navScreen: NavScreen;
  /** the box with its rear doors (render/loading.ts) */
  readonly body: BoxBody;
  private readonly cab: HeavyCab;
  private readonly lamps = new Lamps();
  private readonly wheels: Wheels = { groups: [], of: [] };
  private readonly spec: VehicleSpec = HEAVY_RIGID;

  constructor() {
    const s = this.spec;
    const root = this.root;
    root.name = 'rigid truck';
    const axle = s.wheelbase / 2;
    const hw = (s.width ?? 2.5) / 2;
    // (the same proportions as render/truck.ts – services.boxInside works the box out from them)
    const front = -(axle + 1.4);
    const rear = axle + 2.1;
    const bodyFront = front + 2.0;
    this.cab = new HeavyCab(root, this.lamps, { front, length: 1.9, hw, floor: 1.1, roof: 3.35, paint: RIGID_PAINT, bunk: false, spoiler: 3.75 });
    this.eye = this.cab.eye;
    this.mirrors = this.cab.mirrors;
    this.navScreen = this.cab.navScreen;
    for (const side of [-1, 1]) root.add(box(side * 0.45 - 0.06, side * 0.45 + 0.06, 0.72, 1.0, front + 0.3, rear - 0.1, FRAME));
    this.body = new BoxBody(hw, 1.12, 3.8, bodyFront, rear, LIGHT_GREY);
    root.add(this.body.group);
    // a green band along the box under the lettering
    for (const side of [-1, 1]) root.add(box(side * (hw + 0.004) - 0.004, side * (hw + 0.004) + 0.004, 1.2, 1.5, bodyFront + 0.1, rear - 0.1, RIGID_PAINT, false));
    for (const side of [-1, 1]) {
      const plate = lettering(BRAND, rear - bodyFront - 1.2, (rear - bodyFront - 1.2) * 0.14);
      plate.position.set(side * (hw + 0.012), 2.7, (bodyFront + rear) / 2);
      plate.rotation.y = (side * Math.PI) / 2;
      root.add(plate);
    }
    const doorPlate = lettering(BRAND, hw * 1.7, hw * 1.7 * 0.16);
    doorPlate.position.set(0, 2.7, rear + 0.07);
    root.add(doorPlate);
    this.body.rearPlate = doorPlate;
    root.add(box(-hw + 0.05, hw - 0.05, 0.5, 0.62, rear - 0.12, rear, FRAME));
    root.add(box(hw - 0.6, hw - 0.04, 0.55, 1.0, -axle + 0.3, -axle + 1.6, SILVER)); // fuel tank
    for (const side of [-1, 1]) root.add(box(side * hw - 0.3 * (side > 0 ? 1 : 0), side * hw + 0.3 * (side < 0 ? 1 : 0), 0.5, 0.9, -axle + 1.7, axle - 1.0, FRAME)); // side guard
    rearLamps(root, this.lamps, hw, 0.78, rear + 0.02);
    // ---- wheels: the front axle; behind, the twin-tyred drive axle and the tag axle (the physics' rear axle lies between them)
    const t = s.track / 2;
    addWheel(root, this.wheels, s.wheelRadius, 0.32, -t, -axle, 0);
    addWheel(root, this.wheels, s.wheelRadius, 0.32, t, -axle, 1);
    for (const [dz, w, inset] of [
      [-0.68, 0.6, 0.08],
      [0.68, 0.34, 0],
    ]) {
      addWheel(root, this.wheels, s.wheelRadius, w, -t + inset, axle + dz, 2);
      addWheel(root, this.wheels, s.wheelRadius, w, t - inset, axle + dz, 3);
    }
  }

  setCabinOpacity(opacity: number): void {
    this.cab.setOpacity(opacity);
  }

  update(s: CarVisualState, _dt: number, now: number): void {
    updateWheels(this.wheels, s, this.spec.wheelRadius);
    this.cab.steering.rotation.z = -s.steerWheel;
    this.lamps.update(s, this.root);
    this.cab.panel.update(s, now);
  }

  dispose(): void {
    for (const m of this.mirrors) m.target.dispose();
  }
}

// ------------------------------------------------------------------------- the semi-trailer

/** how far the landing gear's feet are drawn up when it is wound up (m) */
const LEG_LIFT = 0.38;

/**
 * The curtain-sider semi-trailer: a box with curtains along its sides, a
 * front wall with the sockets for the lines, the kingpin under its front,
 * the landing gear, side guards, the tri-axle with mudguards, rear doors,
 * lamps and the amber side markers.  Placed by the game like the box trailer
 * behind a car (render/fleet.ts CarTrailerModel), with its legs as the
 * semi-trailer it is the picture of has them (`sim`).
 */
export class SemiTrailerModel {
  readonly group = new THREE.Group();
  /** the semi-trailer it shows (its landing gear); none: wound up, as when coupled */
  sim: SemiTrailer | null = null;
  private readonly wheels: THREE.Group[] = [];
  private readonly feet = new THREE.Group();
  private readonly lamps = new Lamps();

  constructor() {
    const t = SEMI_TRAILER;
    const g = this.group;
    g.name = 'semi-trailer';
    const hw = t.width / 2;
    const kp = -t.hitchToAxle;
    const front = kp + t.bodyFront;
    const rear = t.length - t.hitchToAxle;
    const deck = 1.5;
    // ---- the chassis: the plate over the fifth wheel, the beams, the deck
    g.add(box(-0.9, 0.9, FIFTH_WHEEL.height + 0.02, 1.3, front + 0.05, kp + 1.4, FRAME));
    for (const side of [-1, 1]) g.add(box(side * 0.5 - 0.08, side * 0.5 + 0.08, 0.9, 1.3, kp + 1.0, rear - 0.1, FRAME));
    g.add(box(-hw, hw, 1.3, deck, front, rear, FRAME));
    // the kingpin
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.1, 10), SILVER);
    pin.position.set(0, FIFTH_WHEEL.height - 0.03, kp);
    g.add(pin);
    // ---- the body: front wall and roof light grey, curtains, rear frame with doors
    g.add(box(-hw, hw, deck, t.height, front, front + 0.06, LIGHT_GREY));
    g.add(box(-hw, hw, t.height - 0.12, t.height, front, rear, LIGHT_GREY));
    for (const side of [-1, 1]) {
      g.add(box(side * hw - 0.02, side * hw, deck, t.height - 0.12, front + 0.06, rear - 0.1, CURTAIN));
      const plate = lettering(BRAND, 7.5, 7.5 * 0.13);
      plate.position.set(side * (hw + 0.005), 2.9, (front + rear) / 2);
      plate.rotation.y = (side * Math.PI) / 2;
      g.add(plate);
      // the sockets for the lines on the front wall: red, yellow, the cable
      const sockets: Array<[THREE.Material, number]> = [
        [RED_LINE, 0.2],
        [YELLOW_LINE, 0.45],
        [DARK, -0.25],
      ];
      if (side < 0) for (const [m, x] of sockets) g.add(box(x - 0.06, x + 0.06, 1.65, 1.77, front - 0.05, front, m, false));
      // side guards between the landing gear and the axles
      g.add(box(side * (hw - 0.04) - 0.03, side * (hw - 0.04) + 0.03, 0.5, 0.95, kp + 3.0, -t.axleSpread * 1.5 - 0.7, FRAME));
      // amber side markers along the deck
      for (let z = front + 1; z < rear - 0.5; z += 3) g.add(box(side * (hw + 0.005) - 0.01, side * (hw + 0.005) + 0.01, 1.32, 1.4, z - 0.05, z + 0.05, MARKER, false));
    }
    g.add(box(-hw, hw, deck, t.height, rear - 0.1, rear, FRAME));
    g.add(box(-0.02, 0.02, deck + 0.05, t.height - 0.05, rear, rear + 0.02, DARK, false));
    g.add(box(-hw + 0.05, hw - 0.05, 0.5, 0.65, rear - 0.15, rear - 0.05, FRAME)); // underrun bar
    rearLamps(g, this.lamps, hw, 0.85, rear + 0.01);
    // ---- the landing gear: housings fixed to the frame, the legs and their feet moving
    const lz = kp + t.legsBehind;
    for (const side of [-1, 1]) g.add(box(side * 0.95 - 0.08, side * 0.95 + 0.08, 0.55, 1.3, lz - 0.08, lz + 0.08, FRAME));
    g.add(box(-0.95, 0.95, 0.85, 0.9, lz - 0.03, lz + 0.03, FRAME)); // the cross-brace
    g.add(box(hw - 0.3, hw - 0.05, 0.95, 1.0, lz - 0.02, lz + 0.02, SILVER, false)); // the crank
    for (const side of [-1, 1]) {
      this.feet.add(box(side * 0.95 - 0.05, side * 0.95 + 0.05, 0.08, 0.7, lz - 0.05, lz + 0.05, SILVER));
      this.feet.add(box(side * 0.95 - 0.15, side * 0.95 + 0.15, 0.0, 0.08, lz - 0.15, lz + 0.15, DARK));
    }
    g.add(this.feet);
    // ---- the tri-axle: wide single tyres, mudguards over them
    for (const side of [-1, 1]) {
      for (let i = 0; i < t.axles; i++) {
        const z = (i - (t.axles - 1) / 2) * t.axleSpread;
        const w = wheel(t.wheelRadius, 0.38);
        w.position.set(side * (t.track / 2), t.wheelRadius, z);
        this.wheels.push(w);
        g.add(w);
      }
      const half = (t.axles * t.axleSpread) / 2;
      g.add(box(side * (t.track / 2) - 0.3, side * (t.track / 2) + 0.3, 1.05, 1.1, -half, half, DARK));
    }
  }

  /** Where it is (the middle of its axles on the ground), its lamps as the tractor's – and its legs as the semi-trailer has them. */
  place(x: number, y: number, z: number, yaw: number, pitch: number, wheelSpin: number, s: CarVisualState | null): void {
    this.group.position.set(x, y, z);
    this.group.rotation.set(pitch, yaw, 0, 'YXZ');
    for (const w of this.wheels) w.rotation.x = -wheelSpin;
    const legs = this.sim ? (this.sim.coupled ? this.sim.legs : 1) : 0;
    this.feet.position.y = (1 - legs) * LEG_LIFT;
    if (s) this.lamps.update(s);
  }
}

// ------------------------------------------------------------------------- for the game

/** The model of a trailer pulled behind a vehicle (all but the drawbar trailer of the truck of class CE, which is part of its model). */
export type TowedModel = CarTrailerModel | SemiTrailerModel;

/** The model of the trailer for a vehicle's: `have` if it is of the right kind, else a new one. */
export function towedModel(trailer: TrailerSpec | null, have: TowedModel | null): TowedModel {
  const semi = isSemiSpec(trailer);
  if (have && (have instanceof SemiTrailerModel) === semi) return have;
  return semi ? new SemiTrailerModel() : new CarTrailerModel();
}

/** Show the semi-trailer `t` (its legs) with the model, if both are a semi-trailer's. */
export function linkTowed(model: TowedModel | null, t: Trailer | null): void {
  if (model instanceof SemiTrailerModel) model.sim = t instanceof SemiTrailer ? t : null;
}
