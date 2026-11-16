// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A person on a bicycle, from a few simple shapes: the wheels turn, the legs
 * pedal, and after a fall bicycle and rider lie on their side.
 *
 * Local frame as for the cars: −z is forwards, y is up, the origin lies on
 * the ground under the middle of the bicycle.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const WHEEL_R = 0.34;
const AXLE = 0.53;
/** the bottom bracket, the hips and the lengths of the legs (m) */
const BB_Y = 0.3;
const BB_Z = 0.06;
const HIP_Y = 0.94;
const HIP_Z = 0.24;
const THIGH = 0.45;
const SHIN = 0.47;
const CRANK = 0.17;

function tint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

const UP = new THREE.Vector3(0, 1, 0);
/** A round bar from one point to another. */
function tube(a: [number, number, number], b: [number, number, number], r: number, hex: number): THREE.BufferGeometry {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const g = new THREE.CylinderGeometry(r, r, len, 6);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return tint(g, hex);
}

function box(w: number, h: number, l: number, x: number, y: number, z: number, hex: number, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, l);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return tint(g, hex);
}

interface Shared {
  frame: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  cranks: THREE.BufferGeometry;
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  painted: THREE.MeshLambertMaterial;
  cloth: THREE.MeshLambertMaterial;
  lamps: THREE.MeshBasicMaterial;
  lampGeo: THREE.BufferGeometry;
  shirts: Map<number, THREE.MeshLambertMaterial>;
}
let shared: Shared | null = null;

function build(): Shared {
  const FRAME = 0x3a4046;
  const DARK = 0x16181b;
  const head: [number, number, number] = [0, 0.86, -0.4];
  const seat: [number, number, number] = [0, 0.82, 0.22];
  const bb: [number, number, number] = [0, BB_Y, BB_Z];
  const rear: [number, number, number] = [0, WHEEL_R, AXLE];
  const front: [number, number, number] = [0, WHEEL_R, -AXLE];
  const frame = mergeGeometries([
    tube(seat, head, 0.02, FRAME),
    tube(head, bb, 0.022, FRAME),
    tube(bb, [0, 0.9, 0.25], 0.02, FRAME),
    tube(bb, rear, 0.014, FRAME),
    tube(seat, rear, 0.012, FRAME),
    tube([0, 0.98, -0.37], front, 0.016, FRAME),
    // handlebar, saddle, mudguard stay, luggage rack
    tube([-0.26, 1.0, -0.36], [0.26, 1.0, -0.36], 0.014, DARK),
    box(0.15, 0.05, 0.26, 0, 0.92, 0.27, DARK),
    box(0.14, 0.02, 0.36, 0, 0.72, 0.55, DARK),
    tube([0, 0.72, 0.7], rear, 0.008, DARK),
  ]);
  // a wheel: the tyre, and spokes that show that it turns (the axle along x, the wheel around the origin)
  const tyre = tint(new THREE.TorusGeometry(WHEEL_R - 0.025, 0.025, 6, 18).rotateY(Math.PI / 2), DARK);
  const spokes: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) spokes.push(box(0.008, (WHEEL_R - 0.03) * 2, 0.008, 0, 0, 0, 0x9aa0a6, (i * Math.PI) / 4));
  const wheel = mergeGeometries([tyre, ...spokes]);
  // the cranks with their pedals, around the bottom bracket
  const cranks = mergeGeometries([
    tube([-0.09, 0, 0], [-0.09, -CRANK, 0], 0.012, DARK),
    tube([0.09, 0, 0], [0.09, CRANK, 0], 0.012, DARK),
    box(0.1, 0.02, 0.08, -0.15, -CRANK, 0, DARK),
    box(0.1, 0.02, 0.08, 0.15, CRANK, 0, DARK),
    tube([-0.1, 0, 0], [0.1, 0, 0], 0.014, DARK),
  ]);
  // the rider's upper body leans forward on to the handlebar (white: takes the colour of the shirt)
  const lean = 0.5;
  const torso = mergeGeometries([
    box(0.38, 0.56, 0.22, 0, HIP_Y + Math.cos(lean) * 0.27, HIP_Z - Math.sin(lean) * 0.27, 0xffffff, -lean),
    tube([-0.21, 1.4, 0.02], [-0.25, 1.02, -0.34], 0.045, 0xffffff),
    tube([0.21, 1.4, 0.02], [0.25, 1.02, -0.34], 0.045, 0xffffff),
  ]);
  const skull = tint(new THREE.SphereGeometry(0.115, 10, 8).translate(0, 1.58, -0.08), 0xd9a989);
  const helmet = tint(new THREE.SphereGeometry(0.135, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0, 1.6, -0.075), 0xe8e8e8);
  const hands = [box(0.07, 0.07, 0.09, -0.25, 1.01, -0.36, 0xd9a989), box(0.07, 0.07, 0.09, 0.25, 1.01, -0.36, 0xd9a989)];
  const headGeo = mergeGeometries([skull, helmet, ...hands]);
  const thigh = new THREE.BoxGeometry(0.14, THIGH, 0.15).translate(0, -THIGH / 2, 0);
  const shin = new THREE.BoxGeometry(0.11, SHIN, 0.12).translate(0, -SHIN / 2, 0);
  // a white lamp at the front and a red one at the back
  const lampGeo = mergeGeometries([box(0.05, 0.05, 0.03, 0, 0.9, -0.44, 0xfff6d8), box(0.05, 0.04, 0.02, 0, 0.7, 0.74, 0xff2a1a)]);
  return {
    frame,
    wheel,
    cranks,
    torso,
    head: headGeo,
    thigh,
    shin,
    painted: new THREE.MeshLambertMaterial({ vertexColors: true }),
    cloth: new THREE.MeshLambertMaterial({ color: 0x2a2d33 }),
    lamps: new THREE.MeshBasicMaterial({ vertexColors: true }),
    lampGeo,
    shirts: new Map(),
  };
}

export class CyclistModel {
  readonly group = new THREE.Group();
  /** everything that falls over together */
  private readonly body = new THREE.Group();
  private readonly wheels: THREE.Mesh[] = [];
  private readonly cranks: THREE.Mesh;
  private readonly shirt: THREE.Mesh;
  private readonly thighs: THREE.Mesh[] = [];
  private readonly shins: THREE.Mesh[] = [];

  constructor(colour: number) {
    const s = (shared ??= build());
    this.body.add(new THREE.Mesh(s.frame, s.painted), new THREE.Mesh(s.lampGeo, s.lamps), new THREE.Mesh(s.head, s.painted));
    for (const z of [-AXLE, AXLE]) {
      const w = new THREE.Mesh(s.wheel, s.painted);
      w.position.set(0, WHEEL_R, z);
      this.wheels.push(w);
      this.body.add(w);
    }
    this.cranks = new THREE.Mesh(s.cranks, s.painted);
    this.cranks.position.set(0, BB_Y, BB_Z);
    this.shirt = new THREE.Mesh(s.torso, s.cloth);
    this.body.add(this.cranks, this.shirt);
    for (const side of [-1, 1]) {
      const thigh = new THREE.Mesh(s.thigh, s.cloth);
      thigh.position.set(side * 0.12, HIP_Y, HIP_Z);
      const shin = new THREE.Mesh(s.shin, s.cloth);
      this.thighs.push(thigh);
      this.shins.push(shin);
      this.body.add(thigh, shin);
    }
    this.group.add(this.body);
    this.setColour(colour);
  }

  setColour(colour: number): void {
    const s = shared as Shared;
    let m = s.shirts.get(colour);
    if (!m) s.shirts.set(colour, (m = new THREE.MeshLambertMaterial({ color: colour, vertexColors: true })));
    this.shirt.material = m;
  }

  /**
   * `phase`: how far the pedals have turned (rad), `roll`: how far the wheels
   * (rad), `down`: lies on the ground.
   */
  pose(phase: number, roll: number, down: boolean): void {
    this.body.rotation.z = down ? -1.42 : 0;
    this.body.position.y = down ? 0.12 : 0;
    for (const w of this.wheels) w.rotation.x = -roll;
    this.cranks.rotation.x = -phase;
    for (let i = 0; i < 2; i++) {
      // the foot on its pedal (the left one half a turn behind the right one)
      const a = phase + (i === 0 ? Math.PI : 0);
      const fy = BB_Y + Math.cos(a) * CRANK + 0.06;
      const fz = BB_Z - Math.sin(a) * CRANK;
      let dy = fy - HIP_Y;
      let dz = fz - HIP_Z;
      const d = Math.min(Math.hypot(dy, dz), THIGH + SHIN - 0.004);
      const l = Math.hypot(dy, dz) || 1;
      dy /= l;
      dz /= l;
      // the knee: where the two parts of the leg meet, on the forward side
      const k = Math.acos(Math.max(-1, Math.min(1, (THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d))));
      const ky = dy * Math.cos(k) - dz * Math.sin(k);
      const kz = dy * Math.sin(k) + dz * Math.cos(k);
      const thigh = this.thighs[i];
      thigh.rotation.x = Math.atan2(-kz, -ky);
      const shin = this.shins[i];
      const knY = HIP_Y + ky * THIGH;
      const knZ = HIP_Z + kz * THIGH;
      shin.position.set(thigh.position.x, knY, knZ);
      shin.rotation.x = Math.atan2(-(fz - knZ), -(fy - knY));
    }
  }
}
