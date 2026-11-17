// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The forklift the player drives (sim/forklift.ts has its measures), drawn
 * part by part: the chassis with its steps and mudguards, the counterweight
 * at the back, the bonnet with the seat on it, the cowl with the steering
 * column and wheel, the overhead guard on its four posts, the work lamps,
 * the rear lamps and the beacon; the front wheels (driven) and the rear
 * wheels on their swinging axle (steered); the mast – the outer channels
 * on their tilt cylinders, the inner channels that rise at half the speed
 * of the forks, the chains over the sheaves –, the carriage with its load
 * backrest, the side-shift and the two forks; and the operator on the seat.
 *
 * Built like the other vehicles around the point the physics use – the
 * ground below the middle of the wheelbase –, x right, y up, the forks
 * towards −z.  The parts that do not move against each other are merged
 * into one mesh per material; the low graphics preset leaves out the small
 * ones.  A generic forklift: no real make is reproduced.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FORKLIFT, MAST_PIVOT } from '../sim/forklift.ts';
import type { Forklift } from '../sim/forklift.ts';
import type { CarVisualState } from './car.ts';
import type { VehicleModel } from './fleet.ts';
import type { Mirror } from './mirrors.ts';
import { PeopleRenderer, SEAT_HEIGHT, workerLook } from './people.ts';

const lam = (c: number): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color: c });
const M = {
  paint: lam(0xe8a311),
  weight: lam(0x3b3f45),
  steel: lam(0x2c2f33),
  mast: lam(0x34383d),
  fork: lam(0x24272a),
  chain: lam(0x5b5f63),
  rubber: lam(0x1b1c1e),
  rim: lam(0xc9c3b5),
  seat: lam(0x202224),
  chrome: new THREE.MeshPhongMaterial({ color: 0xc9d0d6, shininess: 90, specular: 0x9aa4ad }),
  lamp: new THREE.MeshBasicMaterial({ color: 0xfff4d6 }),
  tail: lam(0x7a1712),
  beacon: new THREE.MeshBasicMaterial({ color: 0xff9a1a }),
  beaconOff: lam(0x8a4a10),
  stripe: lam(0x161616),
};

/** Parts collected by material and merged into one mesh each. */
class Parts {
  private readonly lists = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(m: THREE.Material, g: THREE.BufferGeometry): void {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) if (name !== 'position' && name !== 'normal') n.deleteAttribute(name);
    const l = this.lists.get(m);
    if (l) l.push(n);
    else this.lists.set(m, [n]);
  }

  /** A box from corner to corner. */
  box(m: THREE.Material, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.add(m, g);
  }

  /** A round bar from a to b. */
  rod(m: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 8): void {
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    this.add(m, g);
  }

  /** A cylinder lying along x. */
  drum(m: THREE.Material, x0: number, x1: number, y: number, z: number, r: number, seg = 16): void {
    const g = new THREE.CylinderGeometry(r, r, Math.abs(x1 - x0), seg);
    g.rotateZ(Math.PI / 2);
    g.translate((x0 + x1) / 2, y, z);
    this.add(m, g);
  }

  build(into: THREE.Object3D, shadows = true): void {
    for (const [m, list] of this.lists) {
      const mesh = new THREE.Mesh(mergeGeometries(list, false)!, m);
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      into.add(mesh);
    }
    this.lists.clear();
  }
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** A wheel: tyre and rim, its axis along x, its middle at the origin. */
function wheel(r: number, w: number, low: boolean): THREE.Group {
  const g = new THREE.Group();
  const p = new Parts();
  p.drum(M.rubber, -w / 2, w / 2, 0, 0, r, low ? 12 : 20);
  p.drum(M.rim, -w / 2 - 0.004, w / 2 + 0.004, 0, 0, r * 0.58, low ? 10 : 16);
  if (!low) for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    p.box(M.steel, -w / 2 - 0.01, Math.sin(a) * r * 0.42 - 0.02, Math.cos(a) * r * 0.42 - 0.02, w / 2 + 0.01, Math.sin(a) * r * 0.42 + 0.02, Math.cos(a) * r * 0.42 + 0.02);
  }
  p.build(g);
  return g;
}

/** The forklift's model: posed each frame from its simulation. */
export class ForkliftModel implements VehicleModel {
  readonly root = new THREE.Group();
  /** the operator's eyes on the seat */
  readonly eye = new THREE.Vector3(0, 1.86, 0.2);
  readonly mirrors: Mirror[] = [];
  /** tipping: forwards about the front axle, sideways about the line of a front wheel */
  private readonly tipF = new THREE.Group();
  private readonly tipS = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly mast = new THREE.Group();
  private readonly inner = new THREE.Group();
  private readonly carriage = new THREE.Group();
  private readonly shifter = new THREE.Group();
  private readonly wheelsF: THREE.Group[] = [];
  private readonly wheelsR: THREE.Group[] = [];
  private readonly steerR: THREE.Group[] = [];
  private readonly steeringWheel = new THREE.Group();
  private readonly chains: THREE.Mesh[] = [];
  private readonly cylinders: THREE.Mesh[] = [];
  private readonly beacon: THREE.Mesh;
  private readonly people = new PeopleRenderer(1);
  private readonly operator = { x: 0, y: 1.13 - SEAT_HEIGHT, z: 0.36, yaw: 0, walk: -1, look: 9211, sit: true };
  private operatorShown = true;
  private readonly low: boolean;

  constructor(detail: 'full' | 'low' = 'full') {
    const low = detail === 'low';
    this.low = low;
    const S = FORKLIFT;
    const zf = -S.wheelbase / 2;
    const zr = S.wheelbase / 2;
    this.root.name = 'forklift';
    this.root.add(this.tipF);
    this.tipF.position.set(0, 0, zf);
    this.tipF.add(this.tipS);
    this.tipS.add(this.body);
    this.body.position.set(0, 0, -zf);

    // ---- the chassis, the counterweight, the bonnet and the seat, the cowl, the guard
    const p = new Parts();
    p.box(M.paint, -0.55, 0.2, -1.02, 0.55, 0.62, 0.6);
    // (the steps and the mudguards over the front wheels)
    for (const s of [-1, 1]) {
      p.box(M.paint, s * 0.36, 0.62, -1.02, s * 0.6, 0.98, -0.55);
      p.box(M.steel, s * 0.38, 0.3, -0.5, s * 0.58, 0.36, 0.05);
      p.box(M.paint, s * 0.4, 0.62, -0.05, s * 0.58, 1.0, 0.6);
    }
    // the bonnet (the engine or the battery under it) and the seat on it
    p.box(M.paint, -0.4, 0.62, -0.05, 0.4, 1.02, 0.62);
    p.box(M.seat, -0.25, 1.02, 0.12, 0.25, 1.13, 0.58);
    p.box(M.seat, -0.24, 1.13, 0.52, 0.24, 1.62, 0.62);
    p.box(M.seat, -0.3, 1.05, 0.25, -0.26, 1.28, 0.55);
    p.box(M.seat, 0.26, 1.05, 0.25, 0.3, 1.28, 0.55);
    // the counterweight, rounded at the back, its towing pin
    p.box(M.weight, -0.58, 0.22, 0.6, 0.58, 1.18, 1.05);
    p.drum(M.weight, -0.58, 0.58, 0.7, 1.05, 0.48, low ? 10 : 20);
    p.box(M.stripe, -0.58, 0.22, 1.05, 0.58, 0.36, 1.27);
    if (!low) p.drum(M.chrome, -0.05, 0.05, 0.62, 1.42, 0.035, 8);
    // the cowl ahead of the operator with its dashboard, the steering column
    p.box(M.paint, -0.36, 0.62, -0.98, 0.36, 1.3, -0.6);
    p.box(M.steel, -0.3, 1.3, -0.9, 0.3, 1.36, -0.62);
    p.rod(M.steel, v3(0, 1.25, -0.66), v3(0, 1.5, -0.36), 0.035);
    // the levers of the mast beside the seat
    if (!low) for (let i = 0; i < 3; i++) {
      p.rod(M.steel, v3(0.36, 1.0, -0.2 + i * 0.07), v3(0.36, 1.22, -0.24 + i * 0.07), 0.01, 5);
      p.box(M.seat, 0.34, 1.21, -0.26 + i * 0.07, 0.38, 1.26, -0.21 + i * 0.07);
    }
    // the overhead guard: four posts, the frame, the slats
    const top = 2.18;
    for (const s of [-1, 1]) {
      p.rod(M.steel, v3(s * 0.5, 0.95, -0.82), v3(s * 0.5, top, -0.7), 0.04);
      p.rod(M.steel, v3(s * 0.48, 1.0, 0.82), v3(s * 0.48, top, 0.66), 0.04);
      p.box(M.steel, s * 0.46, top - 0.04, -0.75, s * 0.54, top + 0.03, 0.72);
    }
    p.box(M.steel, -0.54, top - 0.04, -0.78, 0.54, top + 0.03, -0.68);
    p.box(M.steel, -0.54, top - 0.04, 0.64, 0.54, top + 0.03, 0.72);
    if (!low) for (let i = 1; i < 7; i++) p.box(M.steel, -0.03 + (i - 3.5) * 0.14, top - 0.02, -0.68, 0.03 + (i - 3.5) * 0.14, top + 0.01, 0.64);
    // the lamps: work lamps on the front posts, tail lamps in the counterweight
    for (const s of [-1, 1]) {
      p.box(M.steel, s * 0.5 - 0.06, 1.85, -0.86, s * 0.5 + 0.06, 1.95, -0.76);
      p.box(M.lamp, s * 0.5 - 0.05, 1.86, -0.865, s * 0.5 + 0.05, 1.94, -0.855);
      p.box(M.tail, s * 0.45 - 0.07, 0.95, 1.03, s * 0.45 + 0.07, 1.06, 1.08);
    }
    p.box(M.steel, -0.08, top + 0.03, 0.55, 0.08, top + 0.07, 0.68);
    p.build(this.body);
    this.beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.11, 12), M.beaconOff);
    this.beacon.position.set(0, top + 0.13, 0.61);
    this.body.add(this.beacon);

    // the steering wheel, towards the operator
    const sw = new Parts();
    const ring = new THREE.TorusGeometry(0.17, 0.018, 6, low ? 14 : 24);
    sw.add(M.seat, ring);
    sw.box(M.seat, -0.17, -0.012, -0.012, 0.17, 0.012, 0.012);
    if (!low) sw.add(M.seat, new THREE.SphereGeometry(0.03, 8, 6).translate(0.12, 0.08, 0.03));
    sw.build(this.steeringWheel, false);
    this.steeringWheel.position.set(0, 1.5, -0.36);
    this.steeringWheel.rotation.x = -0.75;
    const swHolder = new THREE.Group();
    swHolder.add(this.steeringWheel);
    this.body.add(swHolder);

    // ---- the wheels: the front ones on the drive axle, the rear ones steered on the swinging axle
    for (const s of [-1, 1]) {
      const w = wheel(0.33, 0.22, low);
      w.position.set(s * S.halfTrack, 0.33, zf);
      this.body.add(w);
      this.wheelsF.push(w);
      const holder = new THREE.Group();
      holder.position.set(s * 0.42, 0.27, zr);
      const r = wheel(0.27, 0.18, low);
      holder.add(r);
      this.body.add(holder);
      this.steerR.push(holder);
      this.wheelsR.push(r);
    }

    // ---- the mast on its foot: the outer channels, the tilt cylinders
    this.mast.position.set(0, MAST_PIVOT, zf - S.heelAhead + 0.17);
    this.body.add(this.mast);
    const heelZ = -0.17;
    const m = new Parts();
    for (const s of [-1, 1]) {
      // a channel: web and flanges
      m.box(M.mast, s * 0.4, -0.25, 0.0, s * 0.33, 2.0, 0.03);
      m.box(M.mast, s * 0.4, -0.25, -0.12, s * 0.385, 2.0, 0.03);
      m.box(M.mast, s * 0.345, -0.25, -0.12, s * 0.33, 2.0, 0.03);
      // the chain anchors on the outer mast
      m.box(M.steel, s * 0.15, 0.62, 0.02, s * 0.1, 0.7, 0.08);
    }
    m.box(M.mast, -0.4, 1.9, 0.0, 0.4, 2.0, 0.06);
    m.box(M.mast, -0.4, -0.25, 0.0, 0.4, -0.1, 0.06);
    if (!low) m.box(M.mast, -0.4, 0.95, 0.03, 0.4, 1.03, 0.07);
    m.build(this.mast);
    // the inner channels and their crosshead with the chain sheaves
    this.mast.add(this.inner);
    const n = new Parts();
    for (const s of [-1, 1]) {
      n.box(M.mast, s * 0.32, -0.15, -0.1, s * 0.27, 2.05, -0.02);
      if (!low) n.drum(M.steel, s * 0.17, s * 0.09, 2.05, -0.06, 0.07, 12);
    }
    n.box(M.mast, -0.32, 1.97, -0.1, 0.32, 2.07, -0.02);
    n.box(M.mast, -0.32, -0.15, -0.1, 0.32, -0.07, -0.02);
    n.build(this.inner);
    // the carriage on the inner channels, the side-shift on it, the backrest, the forks
    this.mast.add(this.carriage);
    const c = new Parts();
    c.box(M.steel, -0.5, 0.0, heelZ + 0.05, 0.5, 0.12, heelZ + 0.11);
    c.box(M.steel, -0.5, 0.36, heelZ + 0.05, 0.5, 0.48, heelZ + 0.11);
    c.box(M.mast, -0.22, 0.0, heelZ + 0.11, 0.22, 0.48, heelZ + 0.17);
    c.build(this.carriage);
    this.carriage.add(this.shifter);
    const f = new Parts();
    // the backrest: a frame with bars
    f.box(M.steel, -0.52, 0.48, heelZ + 0.02, 0.52, 0.53, heelZ + 0.06);
    f.box(M.steel, -0.52, 1.18, heelZ + 0.02, 0.52, 1.23, heelZ + 0.06);
    for (const s of [-1, 1]) f.box(M.steel, s * 0.52 - 0.025, 0.48, heelZ + 0.02, s * 0.52 + 0.025, 1.23, heelZ + 0.06);
    if (!low) for (let i = -3; i <= 3; i++) f.box(M.steel, i * 0.13 - 0.012, 0.53, heelZ + 0.03, i * 0.13 + 0.012, 1.18, heelZ + 0.05);
    for (const s of [-1, 1]) {
      const x = s * S.forkHalfGap;
      const hw = S.forkWidth / 2;
      // the shank up the carriage and the blade, its tip tapered
      f.box(M.fork, x - hw, -S.forkThick, heelZ - S.forkThick, x + hw, 0.55, heelZ);
      f.box(M.fork, x - hw, -S.forkThick, heelZ - S.forkLength + 0.12, x + hw, 0, heelZ);
      f.box(M.fork, x - hw, -S.forkThick * 0.6, heelZ - S.forkLength, x + hw, -0.005, heelZ - S.forkLength + 0.12);
      f.box(M.steel, x - hw - 0.01, 0.4, heelZ - 0.01, x + hw + 0.01, 0.47, heelZ + 0.05);
    }
    f.build(this.shifter);
    // the chains (scaled to their length each frame) and the tilt cylinders
    const chainGeo = new THREE.BoxGeometry(0.035, 1, 0.025);
    chainGeo.translate(0, 0.5, 0);
    const cylGeo = new THREE.CylinderGeometry(0.045, 0.045, 1, 10);
    cylGeo.translate(0, 0.5, 0);
    cylGeo.rotateX(Math.PI / 2);
    for (const s of [-1, 1]) {
      if (!low) {
        for (let k = 0; k < 2; k++) {
          const ch = new THREE.Mesh(chainGeo, M.chain);
          ch.position.x = s * 0.13;
          this.mast.add(ch);
          this.chains.push(ch);
        }
      }
      const cyl = new THREE.Mesh(cylGeo, M.chrome);
      cyl.castShadow = true;
      cyl.position.set(s * 0.42, 1.0, -0.62);
      this.body.add(cyl);
      this.cylinders.push(cyl);
    }

    // ---- the operator, in work clothes
    this.people.wear(workerLook(9211, 'yellow'));
    this.body.add(this.people.group);
    this.people.update([this.operator], 0);
    this.poseParts(S.liftMin, 0, 0, 0, 0, [0, 0]);
  }

  setCabinOpacity(_opacity: number): void {
    /* an open cab: nothing to see through */
  }

  update(_s: CarVisualState, _dt: number, _now: number): void {
    /* posed by `pose` from the forklift's simulation */
  }

  /** The operator shown on the seat (not from the operator's own eyes). */
  setOperator(on: boolean): void {
    if (on === this.operatorShown) return;
    this.operatorShown = on;
    this.people.group.visible = on;
  }

  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  private poseParts(lift: number, tilt: number, side: number, steer: number, wheel: number, rolled: [number, number]): void {
    const S = FORKLIFT;
    this.mast.rotation.x = tilt;
    // the carriage: the forks' top `lift` above the ground; the inner channels rise at half its speed past the free lift
    const cy = lift - MAST_PIVOT;
    this.carriage.position.y = cy;
    this.inner.position.y = (lift - S.liftMin) / 2;
    this.shifter.position.x = side;
    // the chains: from the carriage up over the sheave, and down to the anchor on the outer mast
    if (this.chains.length) {
      const sheave = this.inner.position.y + 2.05;
      for (let i = 0; i < this.chains.length; i += 2) {
        const a = this.chains[i];
        a.position.set(a.position.x, cy + 0.45, -0.13);
        a.scale.y = Math.max(0.02, sheave - (cy + 0.45));
        const b = this.chains[i + 1];
        b.position.set(b.position.x, 0.7, -0.05);
        b.scale.y = Math.max(0.02, sheave - 0.7);
      }
    }
    // the tilt cylinders: from the frame to the mast
    for (const [i, cyl] of this.cylinders.entries()) {
      const s = i === 0 ? -1 : 1;
      this.tmpA.set(s * 0.42, 0.85, -0.66);
      this.tmpB.set(s * 0.4, 1.0, 0.03);
      this.mast.updateMatrix();
      this.tmpB.applyMatrix4(this.mast.matrix);
      cyl.position.copy(this.tmpA);
      const len = this.tmpA.distanceTo(this.tmpB);
      cyl.quaternion.setFromUnitVectors(Z_AXIS, this.tmpB.sub(this.tmpA).divideScalar(len));
      cyl.scale.z = len;
    }
    // (the rear wheels point the other way: turning right, the rear swings out to the left)
    for (const r of this.steerR) r.rotation.y = steer;
    for (const w of this.wheelsF) w.rotation.x = -rolled[0] / 0.33;
    for (const w of this.wheelsR) w.rotation.x = -rolled[1] / 0.27;
    this.steeringWheel.rotation.z = -wheel;
  }

  /** Pose the model from the forklift: its mast, wheels, steering, its tipping; `now` blinks the beacon. */
  pose(f: Forklift, now: number): void {
    this.root.updateMatrixWorld(true);
    this.poseParts(f.lift, f.tilt, f.side, f.steer, f.steer * 6, [f.rolled[0], f.rolled[1]]);
    // tipping: the rear up about the front axle; sideways about the outer front wheel
    this.tipF.rotation.x = -f.pitch;
    const side = f.rollSide;
    this.tipS.position.x = side * FORKLIFT.halfTrack;
    this.body.position.x = -side * FORKLIFT.halfTrack;
    this.tipS.rotation.z = -side * f.roll;
    this.beacon.material = Math.floor(now * 2.5) % 2 === 0 ? M.beacon : M.beaconOff;
    if (this.operatorShown) this.people.update([this.operator], now);
  }
}
