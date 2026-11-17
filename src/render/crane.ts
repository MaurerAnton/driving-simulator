// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The cranes the player works, drawn with every part that makes them stand
 * and move (sim/crane.ts has their masses and dimensions):
 *
 *  - the tower crane: four foundation blocks, the cross base with its
 *    ballast blocks, the lattice mast section by section (with its ladder
 *    and rest platforms), the slewing ring and platform, the cab, the tower
 *    head with the pendant ties, the lattice jib with its load plates, the
 *    trolley and the hook block on two falls of rope, the counter-jib with
 *    its walkway, the hoist winch and the counter-ballast blocks, the
 *    anemometer and the red obstruction lights;
 *  - the mobile crane: a three-axle carrier with the driver's cab, four
 *    outrigger beams with their jacks, pads and the mats under them, the
 *    turntable, the superstructure with the crane cab, the hoist winch and
 *    the counterweight, the boom of four telescopic sections on its
 *    luffing cylinder, the head sheaves and the hook block;
 *  - the loader crane: a flatbed truck, behind its cab the crane's base
 *    with its outriggers, the column, the inner boom on the lift cylinder,
 *    the outer boom on the folding cylinder with its extensions, the hook.
 *
 * Built like the vehicles (render/truck.ts) around the point the physics use
 * – the ground below the middle of the wheelbase; the tower crane: the
 * middle of its base –, x right, y up, the front (and the boom at slewing
 * angle 0) towards −z.  Parts that do not move against each other are
 * merged into one mesh per material; the low graphics preset leaves out the
 * small ones (ladder, railings, the finer lattice).  Generic cranes, no real
 * model is reproduced.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Crane, CraneType } from '../sim/crane.ts';
import { LOADER_AXLES, LOADER_BED, LOADER_CRANE, LOADER_GEOMETRY, MOBILE_AXLES, MOBILE_CRANE, MOBILE_GEOMETRY, TOWER_CRANE, TOWER_GEOMETRY, boomLength, headOf, outerLength } from '../sim/crane.ts';
import type { CarVisualState } from './car.ts';
import type { VehicleModel } from './fleet.ts';
import { Lamps } from './fleet.ts';
import type { Mirror } from './mirrors.ts';
import { AMBER, DARK, GLASS, LAMP, RIM, TAIL, TYRE, lettering } from './truck.ts';

// ------------------------------------------------------------------------------------ materials

const YELLOW = new THREE.MeshLambertMaterial({ color: 0xf0b40c });
const WHITE = new THREE.MeshLambertMaterial({ color: 0xedefed });
const STEEL = new THREE.MeshLambertMaterial({ color: 0x3a3e44 });
const GALV = new THREE.MeshLambertMaterial({ color: 0xa8adb2 });
const CONCRETE = new THREE.MeshLambertMaterial({ color: 0x9d9b95 });
const RED = new THREE.MeshLambertMaterial({ color: 0xb8231c });
const TIMBER = new THREE.MeshLambertMaterial({ color: 0x9a7448 });
const ROPE = new THREE.MeshLambertMaterial({ color: 0x232323 });
const CHROME = new THREE.MeshPhongMaterial({ color: 0xc9d0d6, shininess: 90, specular: 0x9aa4ad });
const HOOK = new THREE.MeshLambertMaterial({ color: 0xf2c200 });
const BEACON = new THREE.MeshBasicMaterial({ color: 0xff2a10 });
const BEACON_OFF = new THREE.MeshLambertMaterial({ color: 0x5a1a12 });
const PAD = new THREE.MeshLambertMaterial({ color: 0x2a2b2d });

/** what the cranes are drawn with: everything, or the plain parts only (the low graphics preset) */
export type CraneDetail = 'full' | 'low';

// ------------------------------------------------------------------------------------ building parts

const UP = new THREE.Vector3(0, 1, 0);

/** Position and normal only, un-indexed: the form in which parts are merged. */
function bare(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(n.attributes)) if (name !== 'position' && name !== 'normal') n.deleteAttribute(name);
  return n;
}

/**
 * Parts collected by material and merged into one mesh each: boxes from
 * corner to corner, bars and rods from point to point.
 */
class Parts {
  private readonly lists = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();

  private push(mat: THREE.Material, g: THREE.BufferGeometry): void {
    let l = this.lists.get(mat);
    if (!l) this.lists.set(mat, (l = []));
    l.push(bare(g));
  }

  box(mat: THREE.Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.push(mat, g);
  }

  /** a straight member of square section w (or w × h) from one point to another */
  bar(mat: THREE.Material, ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, h = w): void {
    this.a.set(ax, ay, az);
    this.b.set(bx, by, bz).sub(this.a);
    const len = this.b.length();
    if (len < 1e-4) return;
    const g = new THREE.BoxGeometry(w, len, h);
    this.q.setFromUnitVectors(UP, this.b.normalize());
    this.m.compose(this.a.addScaledVector(this.b, len / 2), this.q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(this.m);
    this.push(mat, g);
  }

  /** a round member (tube, rope, rod) from one point to another */
  rod(mat: THREE.Material, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, seg = 8): void {
    this.a.set(ax, ay, az);
    this.b.set(bx, by, bz).sub(this.a);
    const len = this.b.length();
    if (len < 1e-4) return;
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
    this.q.setFromUnitVectors(UP, this.b.normalize());
    this.m.compose(this.a.addScaledVector(this.b, len / 2), this.q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(this.m);
    this.push(mat, g);
  }

  /** a cylinder (a drum, a sheave, a wheel) with its axis along x, y or z */
  cyl(mat: THREE.Material, x: number, y: number, z: number, r: number, len: number, axis: 'x' | 'y' | 'z', seg = 14): void {
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.push(mat, g);
  }

  sphere(mat: THREE.Material, x: number, y: number, z: number, r: number): void {
    const g = new THREE.SphereGeometry(r, 10, 6);
    g.translate(x, y, z);
    this.push(mat, g);
  }

  /** Merge what was collected into meshes added to `group`. */
  build(group: THREE.Object3D, shadow = true): void {
    for (const [mat, list] of this.lists) {
      const g = mergeGeometries(list, false);
      if (!g) continue;
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = shadow && mat !== GLASS;
      mesh.receiveShadow = false;
      group.add(mesh);
    }
    this.lists.clear();
  }
}

/** A rope (or anything long and thin that moves): a unit cylinder stretched from one point to another each picture. */
class Line {
  readonly mesh: THREE.Mesh;
  private static geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1).translate(0, 0.5, 0);
  private readonly d = new THREE.Vector3();
  private readonly r: number;

  constructor(parent: THREE.Object3D, r: number, mat: THREE.Material = ROPE) {
    this.r = r;
    this.mesh = new THREE.Mesh(Line.geo, mat);
    this.mesh.castShadow = true;
    parent.add(this.mesh);
  }

  /** from a to b (in the parent's frame) */
  set(a: THREE.Vector3, b: THREE.Vector3): void {
    this.d.subVectors(b, a);
    const len = this.d.length();
    this.mesh.visible = len > 1e-3;
    if (!this.mesh.visible) return;
    this.mesh.position.copy(a);
    this.mesh.quaternion.setFromUnitVectors(UP, this.d.divideScalar(len));
    this.mesh.scale.set(this.r, len, this.r);
  }
}

/** A plate with lettering on both faces (a load plate on the jib, a name on the boom). */
function plate(text: string, w: number, h: number): THREE.Group {
  const g = new THREE.Group();
  const front = lettering(text, w, h);
  const back = lettering(text, w, h);
  back.rotation.y = Math.PI;
  back.position.z = -0.01;
  g.add(front, back);
  return g;
}

/** The hook block: sheaves between side plates, the crosshead, the hook – yellow, black stripes. */
function hookBlock(width: number, height: number, sheaves: number, detail: CraneDetail): THREE.Group {
  const g = new THREE.Group();
  const p = new Parts();
  const hw = width / 2;
  // side plates and the sheaves between them
  p.box(HOOK, -hw, -hw + 0.05, -height * 0.55, 0, -0.22, 0.22);
  p.box(HOOK, hw - 0.05, hw, -height * 0.55, 0, -0.22, 0.22);
  for (let i = 0; i < sheaves; i++) {
    const x = -hw + 0.1 + ((width - 0.2) * (i + 0.5)) / sheaves;
    p.cyl(STEEL, x, -height * 0.25, 0, Math.min(0.2, height * 0.3), Math.min(0.08, (width - 0.2) / sheaves - 0.02), 'x', 12);
  }
  // the crosshead, its nut, the hook's shank and the hook
  p.box(STEEL, -hw, hw, -height * 0.62, -height * 0.55, -0.18, 0.18);
  p.cyl(STEEL, 0, -height * 0.7, 0, 0.07, 0.16, 'y', 10);
  const hookR = Math.max(0.12, width * 0.28);
  const curve = new THREE.TorusGeometry(hookR, hookR * 0.28, 8, 16, Math.PI * 1.4);
  curve.rotateZ(-Math.PI * 0.2);
  curve.translate(0, -height * 0.78 - hookR, 0);
  const hookMesh = new THREE.Mesh(curve, HOOK);
  hookMesh.castShadow = true;
  g.add(hookMesh);
  if (detail === 'full') {
    // black stripes on the side plates
    for (let i = 0; i < 3; i++) {
      const y = -height * 0.1 - i * height * 0.15;
      p.box(DARK, -hw - 0.003, -hw + 0.053, y - 0.035, y, -0.221, 0.221);
      p.box(DARK, hw - 0.053, hw + 0.003, y - 0.035, y, -0.221, 0.221);
    }
  }
  p.build(g);
  return g;
}

/** A wheel lying on the x axis: tyre and rim. */
function wheelGroup(radius: number, width: number): THREE.Group {
  const g = new THREE.Group();
  const p = new Parts();
  p.cyl(TYRE, 0, 0, 0, radius, width, 'x', 20);
  p.cyl(RIM, 0, 0, 0, radius * 0.56, width + 0.02, 'x', 12);
  p.build(g);
  return g;
}

/** What every crane model can do beyond a vehicle's: be posed from its simulation, and say where its operator's eyes are. */
export interface CraneModel extends VehicleModel {
  readonly kind: CraneType;
  /** joints, outriggers, lift, levelling, hook and rope – as the crane is now */
  pose(c: Crane, now: number): void;
  /** the operator's eyes (world): in the crane's cab, or beside the truck with the radio control */
  operatorEye(out: THREE.Vector3): THREE.Vector3;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

/** The group the whole crane is in, turned over its tipping line when it goes over. */
function tipping(root: THREE.Group): { tip: THREE.Group; inner: THREE.Group } {
  const tip = new THREE.Group();
  const inner = new THREE.Group();
  tip.add(inner);
  root.add(tip);
  return { tip, inner };
}

function poseTip(tip: THREE.Group, inner: THREE.Group, c: Crane): void {
  const t = c.tipped;
  if (!t || t.angle <= 0) {
    tip.position.set(0, 0, 0);
    tip.quaternion.identity();
    inner.position.set(0, 0, 0);
    return;
  }
  tip.position.set(t.px, 0, t.pz);
  inner.position.set(-t.px, 0, -t.pz);
  tmp.set(t.nz, 0, -t.nx).normalize();
  tip.quaternion.setFromAxisAngle(tmp, t.angle);
}

// ------------------------------------------------------------------------------------ the tower crane

const TG = TOWER_GEOMETRY;
/** the jib's bottom chords (the trolley runs on them) and its top chord */
const JIB_Y = TG.sheave + 0.3;
const JIB_TOP = JIB_Y + 1.6;
const JIB_HALF = 0.6;
/** the tower head's apex (the pendant ties hang from it) */
const APEX = 39.2;

export class TowerCraneModel implements CraneModel {
  readonly kind = 'tower' as const;
  readonly root = new THREE.Group();
  /** (the driver's eyes of a vehicle: here the cab's, before it turns) */
  readonly eye = new THREE.Vector3(1.75, TG.mastTop + 1.3, -1.4);
  readonly mirrors: Mirror[] = [];
  private readonly tip: THREE.Group;
  private readonly inner: THREE.Group;
  /** what turns with the jib */
  private readonly slewing = new THREE.Group();
  private readonly trolley = new THREE.Group();
  private readonly hook: THREE.Group;
  private readonly falls: Line[] = [];
  private readonly jibRope: Line;
  /** the hoist rope from the jib's root sheave to the trolley */
  private readonly hoistRope: Line;
  private readonly rotor = new THREE.Group();
  private readonly lights: THREE.Mesh[] = [];
  private readonly cabEye = new THREE.Vector3(1.75, TG.mastTop + 1.3, -1.6);

  constructor(detail: CraneDetail = 'full') {
    this.root.name = 'tower crane';
    const { tip, inner } = tipping(this.root);
    this.tip = tip;
    this.inner = inner;
    const full = detail === 'full';
    // ---- the base: four foundation blocks, the cross base, the ballast blocks on it
    const base = new Parts();
    const s = TOWER_CRANE.feet[2][0];
    for (const [x, z] of TOWER_CRANE.feet) base.box(CONCRETE, x - 0.75, x + 0.75, -0.7, 0.3, z - 0.75, z + 0.75);
    // the cross: two girders from corner to corner, the middle piece the mast stands on
    base.bar(STEEL, -s, 0.55, -s, s, 0.55, s, 0.5);
    base.bar(STEEL, -s, 0.55, s, s, 0.55, -s, 0.5);
    base.box(STEEL, -1.1, 1.1, 0.3, 0.85, -1.1, 1.1);
    // the central ballast: two layers of four blocks round the mast's foot
    const bl = 2.45;
    for (const [y0, y1] of [
      [0.85, 1.72],
      [1.72, 2.6],
    ]) {
      base.box(CONCRETE, -bl, bl, y0, y1 - 0.02, -bl, -1.15);
      base.box(CONCRETE, -bl, bl, y0, y1 - 0.02, 1.15, bl);
      base.box(CONCRETE, -bl, -1.15, y0, y1 - 0.02, -1.13, 1.13);
      base.box(CONCRETE, 1.15, bl, y0, y1 - 0.02, -1.13, 1.13);
    }
    if (full) for (const [x, z] of TOWER_CRANE.feet) base.cyl(STEEL, x * 0.9, 0.95, z * 0.9, 0.06, 0.4, 'y', 6);
    // ---- the mast: a foot section, then lattice sections of 3 m
    const mw = TG.mastWidth / 2;
    const c = 0.075;
    base.box(YELLOW, -mw, mw, 0.85, 2.85, -mw, mw);
    const sections = 9;
    const top = TG.mastTop;
    const sh = (top - 2.85) / sections;
    for (let i = 0; i < sections; i++) {
      const y0 = 2.85 + i * sh;
      const y1 = y0 + sh;
      for (const [x, z] of [
        [-mw, -mw],
        [mw, -mw],
        [mw, mw],
        [-mw, mw],
      ]) base.box(YELLOW, x - c, x + c, y0, y1, z - c, z + c);
      // horizontals at the joint, and a diagonal on each face (alternating)
      const faces: Array<[number, number, number, number]> = [
        [-mw, -mw, mw, -mw],
        [mw, -mw, mw, mw],
        [mw, mw, -mw, mw],
        [-mw, mw, -mw, -mw],
      ];
      faces.forEach(([ax, az, bx, bz], k) => {
        base.bar(YELLOW, ax, y0 + 0.05, az, bx, y0 + 0.05, bz, 0.07);
        if (!full && k % 2 === 1) return;
        const flip = (i + k) % 2 === 0;
        base.bar(YELLOW, flip ? ax : bx, y0 + 0.08, flip ? az : bz, flip ? bx : ax, y1 - 0.05, flip ? bz : az, 0.06);
        if (full) base.bar(YELLOW, (ax + bx) / 2, y0 + 0.08, (az + bz) / 2, flip ? bx : ax, y0 + sh / 2, flip ? bz : az, 0.045);
      });
      // the bolted joints between the sections
      if (full) for (const [x, z] of [[-mw, -mw], [mw, -mw], [mw, mw], [-mw, mw]]) base.box(STEEL, x - 0.11, x + 0.11, y0 - 0.12, y0 + 0.12, z - 0.11, z + 0.11);
    }
    base.bar(YELLOW, -mw, top - 0.05, -mw, mw, top - 0.05, -mw, 0.08);
    base.bar(YELLOW, -mw, top - 0.05, mw, mw, top - 0.05, mw, 0.08);
    if (full) {
      // the ladder inside the mast, and a rest platform every third section
      const lx = 0.25;
      base.box(GALV, -lx - 0.03, -lx, 2.85, top, mw - 0.35, mw - 0.32);
      base.box(GALV, lx, lx + 0.03, 2.85, top, mw - 0.35, mw - 0.32);
      for (let y = 3.1; y < top; y += 0.3) base.box(GALV, -lx, lx, y, y + 0.025, mw - 0.35, mw - 0.32);
      for (let i = 3; i < sections; i += 3) base.box(GALV, -mw + 0.1, mw - 0.1, 2.85 + i * sh - 0.05, 2.85 + i * sh, -mw + 0.1, mw - 0.45);
    }
    // the slewing ring's lower half
    base.cyl(STEEL, 0, top + 0.1, 0, 1.1, 0.2, 'y', 24);
    base.build(inner);
    // ---- what turns: the slewing ring's upper half, the platform, the cab, the tower head, the jib, the counter-jib
    const sw = this.slewing;
    sw.position.y = 0;
    inner.add(sw);
    const p = new Parts();
    const plat = top + 0.25;
    p.cyl(STEEL, 0, top + 0.27, 0, 1.12, 0.14, 'y', 24);
    p.box(YELLOW, -1.2, 1.2, plat + 0.1, plat + 0.6, -1.2, 1.2);
    // the cab: at the jib's root on the right, glass all round and below
    const cx0 = 0.95;
    const cx1 = 2.45;
    const cy0 = top - 0.2;
    const cy1 = top + 2.15;
    const cz0 = -2.6;
    const cz1 = -0.3;
    p.box(WHITE, cx0, cx1, cy0, cy0 + 0.15, cz0, cz1);
    p.box(WHITE, cx0, cx1, cy1 - 0.12, cy1, cz0, cz1);
    p.box(WHITE, cx0, cx1, cy0, cy1, cz1 - 0.08, cz1);
    for (const [x, z] of [[cx0, cz0], [cx1, cz0], [cx0, cz1], [cx1, cz1]]) p.box(WHITE, x - 0.04, x + 0.04, cy0, cy1, z - 0.04, z + 0.04);
    p.box(WHITE, cx0, cx1, cy0 + 0.15, cy0 + 0.75, cz1 - 0.6, cz1 - 0.08);
    p.box(STEEL, cx0 + 0.3, cx1 - 0.3, cy0 + 0.15, cy0 + 0.55, cz0 + 0.7, cz0 + 1.2);
    const glass = new Parts();
    glass.box(GLASS, cx0, cx1, cy0 + 0.15, cy1 - 0.12, cz0 - 0.005, cz0 + 0.005);
    glass.box(GLASS, cx0 - 0.005, cx0 + 0.005, cy0 + 0.75, cy1 - 0.12, cz0, cz1 - 0.6);
    glass.box(GLASS, cx1 - 0.005, cx1 + 0.005, cy0 + 0.15, cy1 - 0.12, cz0, cz1 - 0.08);
    glass.box(GLASS, cx0 + 0.05, cx1 - 0.05, cy0 + 0.155, cy0 + 0.165, cz0 + 0.05, cz0 + 0.65);
    // the tower head: four legs to the apex, braced
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) p.bar(YELLOW, x, plat + 0.6, z, x * 0.18, APEX, z * 0.18, 0.14);
    for (let k = 0; k < (full ? 4 : 2); k++) {
      const y = plat + 0.6 + ((APEX - plat - 0.6) * (k + 1)) / 5;
      const w = 1 - (0.82 * (k + 1)) / 5;
      p.bar(YELLOW, -w, y, -w, w, y, -w, 0.06);
      p.bar(YELLOW, -w, y, w, w, y, w, 0.06);
      p.bar(YELLOW, -w, y, -w, -w, y, w, 0.06);
      p.bar(YELLOW, w, y, -w, w, y, w, 0.06);
    }
    p.box(STEEL, -0.3, 0.3, APEX - 0.2, APEX + 0.15, -0.3, 0.3);
    // the jib: two bottom chords (the trolley's rails) and a top chord, braced in zigzags, sections of 10 m
    const L = TG.jibLength;
    const step = full ? 2 : 4;
    const zj = (a: number): number => -a;
    p.box(YELLOW, -JIB_HALF - 0.08, -JIB_HALF + 0.08, JIB_Y, JIB_Y + 0.18, zj(L), zj(1.0));
    p.box(YELLOW, JIB_HALF - 0.08, JIB_HALF + 0.08, JIB_Y, JIB_Y + 0.18, zj(L), zj(1.0));
    p.box(YELLOW, -0.08, 0.08, JIB_TOP - 0.16, JIB_TOP, zj(L - 0.4), zj(1.2));
    for (let a = 1.0; a < L - 0.01; a += step) {
      const b = Math.min(L, a + step);
      const mid = (a + b) / 2;
      p.bar(YELLOW, -JIB_HALF, JIB_Y + 0.1, zj(a), 0, JIB_TOP - 0.08, zj(mid), 0.07);
      p.bar(YELLOW, 0, JIB_TOP - 0.08, zj(mid), -JIB_HALF, JIB_Y + 0.1, zj(b), 0.07);
      p.bar(YELLOW, JIB_HALF, JIB_Y + 0.1, zj(a), 0, JIB_TOP - 0.08, zj(mid), 0.07);
      p.bar(YELLOW, 0, JIB_TOP - 0.08, zj(mid), JIB_HALF, JIB_Y + 0.1, zj(b), 0.07);
      p.bar(YELLOW, -JIB_HALF, JIB_Y + 0.05, zj(a), JIB_HALF, JIB_Y + 0.05, zj(a), 0.06);
      if (full) p.bar(YELLOW, -JIB_HALF, JIB_Y + 0.05, zj(a), JIB_HALF, JIB_Y + 0.05, zj(b), 0.045);
    }
    // the joints of the jib's sections
    if (full) for (let a = 10; a < L; a += 10) p.box(STEEL, -JIB_HALF - 0.12, JIB_HALF + 0.12, JIB_Y - 0.05, JIB_Y + 0.25, zj(a) - 0.12, zj(a) + 0.12);
    p.box(YELLOW, -JIB_HALF - 0.1, JIB_HALF + 0.1, JIB_Y, JIB_TOP - 0.2, zj(L) - 0.1, zj(L) + 0.1);
    // the jib's root on the platform
    p.box(YELLOW, -1.0, 1.0, plat + 0.6, JIB_Y + 0.2, -1.2, -0.6);
    // the pendant ties: from the apex to the jib (two points) and to the counter-jib's end
    for (const a of [22, 38]) {
      p.rod(STEEL, -0.12, APEX, -0.1, -0.05, JIB_TOP, zj(a), 0.04, 6);
      p.rod(STEEL, 0.12, APEX, -0.1, 0.05, JIB_TOP, zj(a), 0.04, 6);
    }
    const CJ = TG.counterJib;
    for (const side of [-1, 1]) p.rod(STEEL, side * 0.15, APEX, 0.1, side * 0.85, JIB_Y + 0.45, CJ - 0.6, 0.045, 6);
    // the counter-jib: two side girders, cross members, the walkway and its railings
    for (const side of [-1, 1]) p.box(YELLOW, side * 0.9 - 0.13, side * 0.9 + 0.13, JIB_Y - 0.2, JIB_Y + 0.45, 0.6, CJ);
    for (let a = 1; a < CJ; a += full ? 1.5 : 3) p.box(YELLOW, -0.9, 0.9, JIB_Y - 0.15, JIB_Y - 0.02, a, a + 0.12);
    p.box(GALV, -0.85, 0.85, JIB_Y + 0.45, JIB_Y + 0.5, 0.6, CJ - 3);
    if (full) {
      for (const side of [-1, 1]) {
        for (let a = 0.8; a < CJ - 2.8; a += 1.6) p.box(GALV, side * 0.95 - 0.02, side * 0.95 + 0.02, JIB_Y + 0.5, JIB_Y + 1.6, a, a + 0.04);
        p.box(GALV, side * 0.95 - 0.025, side * 0.95 + 0.025, JIB_Y + 1.55, JIB_Y + 1.6, 0.8, CJ - 3);
        p.box(GALV, side * 0.95 - 0.02, side * 0.95 + 0.02, JIB_Y + 1.0, JIB_Y + 1.04, 0.8, CJ - 3);
      }
    }
    // the counter-ballast: four concrete blocks hung at the end
    for (let k = 0; k < 4; k++) {
      const a0 = CJ - 2.8 + k * 0.7;
      p.box(CONCRETE, -1.1, 1.1, JIB_Y - 2.3, JIB_Y + 0.3, a0, a0 + 0.66);
    }
    if (full) for (let k = 0; k < 4; k++) p.box(RED, -1.11, 1.11, JIB_Y - 1.1, JIB_Y - 0.9, CJ - 2.8 + k * 0.7, CJ - 2.8 + k * 0.7 + 0.66);
    // the hoist winch (drum, gearbox, motor) and the trolley's winch at the root
    p.cyl(STEEL, 0, JIB_Y + 0.95, 8.8, 0.45, 1.25, 'x', 18);
    p.box(STEEL, 0.7, 1.05, JIB_Y + 0.5, JIB_Y + 1.35, 8.3, 9.3);
    p.box(GALV, -1.1, -0.7, JIB_Y + 0.5, JIB_Y + 1.25, 8.4, 9.2);
    p.cyl(STEEL, 0, JIB_Y + 0.55, -2.2, 0.25, 0.8, 'x', 12);
    // the hoist rope: off the winch's drum up over the sheave at the apex, down to the sheave at the jib's root
    p.cyl(STEEL, 0, APEX - 0.45, 0.25, 0.28, 0.08, 'x', 12);
    p.cyl(STEEL, 0, JIB_Y + 0.05, -1.25, 0.22, 0.08, 'x', 12);
    p.rod(ROPE, 0, JIB_Y + 1.38, 8.8, 0, APEX - 0.2, 0.3, 0.02, 5);
    p.rod(ROPE, 0, APEX - 0.72, 0.2, 0, JIB_Y + 0.27, -1.2, 0.02, 5);
    // the anemometer's mast on the apex, the obstruction lights
    p.box(STEEL, -0.02, 0.02, APEX + 0.15, APEX + 1.35, -0.02, 0.02);
    p.build(sw);
    glass.build(sw, false);
    // the cup anemometer: three arms with their cups, turning with the wind
    const rotor = this.rotor;
    rotor.position.set(0, APEX + 1.4, 0);
    const rp = new Parts();
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      rp.bar(STEEL, 0, 0, 0, Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32, 0.015);
      rp.sphere(DARK, Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32, 0.06);
    }
    rp.build(rotor, false);
    sw.add(rotor);
    for (const [x, y, z] of [
      [0, APEX + 0.3, 0],
      [0, JIB_TOP + 0.15, zj(L - 0.2)],
      [0, JIB_Y + 0.6, CJ - 0.3],
    ]) {
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), BEACON);
      light.position.set(x, y, z);
      sw.add(light);
      this.lights.push(light);
    }
    // the load plates on the jib: what it lifts at 16 m and at its tip
    if (full) {
      for (const [a, text] of [
        [TG.moment / (TG.maxLoad + TG.loss), `${TG.maxLoad.toFixed(1)} t`],
        [TG.trolleyMax, `${(TG.moment / TG.trolleyMax - TG.loss).toFixed(1)} t`],
      ] as Array<[number, string]>) {
        const pl = plate(text, 1.6, 0.8);
        pl.rotation.y = Math.PI / 2;
        pl.position.set(JIB_HALF + 0.12, JIB_Y + 0.75, zj(a));
        sw.add(pl);
      }
    }
    // the trolley: a frame on the bottom chords, four wheels, two sheaves for the falls
    const tr = this.trolley;
    const tp = new Parts();
    tp.box(YELLOW, -JIB_HALF - 0.15, JIB_HALF + 0.15, TG.sheave - 0.25, TG.sheave - 0.1, -0.7, 0.7);
    for (const side of [-1, 1]) {
      tp.box(YELLOW, side * (JIB_HALF + 0.12) - 0.04, side * (JIB_HALF + 0.12) + 0.04, TG.sheave - 0.25, JIB_Y + 0.25, -0.65, 0.65);
      for (const z of [-0.45, 0.45]) tp.cyl(STEEL, side * (JIB_HALF - 0.02), JIB_Y + 0.22, z, 0.1, 0.06, 'x', 10);
      tp.cyl(STEEL, side * 0.15, TG.sheave, 0, 0.22, 0.07, 'x', 14);
    }
    tp.build(tr);
    sw.add(tr);
    // the hook block on its two falls, and the rope along the jib
    this.hook = hookBlock(0.55, 0.9, 2, detail);
    inner.add(this.hook);
    for (let i = 0; i < 2; i++) this.falls.push(new Line(inner, 0.022));
    this.jibRope = new Line(sw, 0.02);
    this.hoistRope = new Line(sw, 0.02);
  }

  setCabinOpacity(): void {}

  update(_s: CarVisualState, _dt: number, now: number): void {
    this.flash(now);
  }

  /** The obstruction lights flash. */
  flash(now: number): void {
    const on = Math.floor(now * 1.1) % 2 === 0;
    for (const l of this.lights) l.material = on ? BEACON : BEACON_OFF;
  }

  pose(c: Crane, now: number): void {
    poseTip(this.tip, this.inner, c);
    const q = c.q;
    this.slewing.rotation.y = q.slew;
    this.trolley.position.z = -q.trolley;
    // the anemometer turns with the wind at the top
    this.rotor.rotation.y = -now * (0.4 + c.lmi.wind * 0.9);
    // (the rope runs from the root's sheave to the trolley, down to the hook block and up again, and on to its end at the jib's tip)
    this.hoistRope.set(tmp.set(0, JIB_Y + 0.05, -1.25), tmp2.set(0.1, TG.sheave + 0.12, -(q.trolley - 0.25)));
    this.jibRope.set(tmp.set(-0.1, TG.sheave + 0.12, -(q.trolley + 0.25)), tmp2.set(0, JIB_Y + 0.1, -(TG.jibLength - 0.3)));
    // the hook block where the rope has it, hanging plumb under its sheaves
    this.inner.updateMatrixWorld(true);
    const local = this.inner.worldToLocal(tmp.set(c.hook.x, c.hook.y, c.hook.z));
    this.hook.position.copy(local);
    this.hook.rotation.set(0, q.slew, 0);
    const s = Math.sin(q.slew);
    const co = Math.cos(q.slew);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -0.15 : 0.15;
      // (the sheave on the trolley, turned with the jib)
      tmp2.set(-q.trolley * s + side * co, TG.sheave, -q.trolley * co - side * s);
      const b = tmp.set(local.x + side * co, local.y - 0.05, local.z - side * s);
      this.falls[i].set(tmp2, b);
    }
  }

  operatorEye(out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.cabEye);
    return this.slewing.localToWorld(out);
  }
}

// ------------------------------------------------------------------------------------ the mobile crane

const MG = MOBILE_GEOMETRY;
const MO = MOBILE_CRANE.outriggers!;

export class MobileCraneModel implements CraneModel {
  readonly kind = 'mobile' as const;
  readonly root = new THREE.Group();
  /** the driver's eyes in the carrier's cab */
  readonly eye = new THREE.Vector3(-0.88, 2.55, -3.25);
  readonly mirrors: Mirror[] = [];
  private readonly tip: THREE.Group;
  private readonly inner: THREE.Group;
  /** the carrier, lifted and levelled by the jacks */
  private readonly body = new THREE.Group();
  private readonly upper = new THREE.Group();
  private readonly boom = new THREE.Group();
  private readonly sections: THREE.Group[] = [];
  private readonly head = new THREE.Group();
  private readonly cylHousing: THREE.Mesh;
  private readonly cylRod: THREE.Mesh;
  /** the hoist rope from the winch's drum to the boom head */
  private readonly winchRope: Line;
  private readonly wheels: THREE.Group[] = [];
  private readonly beams: THREE.Group[] = [];
  private readonly rods: THREE.Mesh[] = [];
  private readonly pads: THREE.Group[] = [];
  private readonly mats: THREE.Mesh[] = [];
  private readonly hook: THREE.Group;
  private readonly falls: Line[] = [];
  private readonly lamps = new Lamps();
  private readonly beacons: THREE.Mesh[] = [];
  /** the wheels' heights as the physics has them (they hang lower once the jacks lift the carrier) */
  private readonly wheelY: number[] = [];
  private operating = false;

  constructor(detail: CraneDetail = 'full') {
    this.root.name = 'mobile crane';
    const { tip, inner } = tipping(this.root);
    this.tip = tip;
    this.inner = inner;
    inner.add(this.body);
    const full = detail === 'full';
    const body = this.body;
    const p = new Parts();
    const hw = 1.27;
    // ---- the carrier: the frame, the decks over the axles, the driver's cab on the left, the engine at the rear
    p.box(STEEL, -0.55, 0.55, 0.75, 1.2, -3.8, 4.6);
    p.box(WHITE, -hw, hw, 1.2, 1.32, -2.1, 4.6);
    for (const side of [-1, 1]) p.box(WHITE, side * hw - 0.02 * side, side * (hw - 0.4), 0.95, 1.32, -2.1, 4.6);
    // (the cab: white, glass to the front and the sides; the boom rests beside it on the right)
    const c0 = -hw;
    const c1 = -0.5;
    p.box(WHITE, c0, c1, 0.95, 1.85, -3.95, -2.25);
    p.box(WHITE, c0, c1, 2.95, 3.15, -3.95, -2.25);
    p.box(WHITE, c0, c1, 1.85, 2.95, -2.35, -2.25);
    for (const [x, z] of [[c0, -3.95], [c1, -3.95], [c0, -2.3], [c1, -2.3]]) p.box(WHITE, x - 0.04, x + 0.04, 1.85, 2.95, z - 0.04, z + 0.04);
    p.box(WHITE, c1, hw, 0.95, 1.45, -3.95, -2.25);
    p.box(DARK, -hw + 0.05, hw - 0.05, 0.55, 0.95, -3.98, -3.7);
    p.box(WHITE, -1.0, 1.0, 1.32, 1.75, 2.9, 4.5);
    p.box(DARK, -0.95, 0.95, 1.4, 1.65, 4.5, 4.52);
    // the boom's rest at the front right
    p.box(STEEL, -0.2, 0.2, 1.32, 2.36, -3.55, -3.35);
    // the turntable's lower ring
    p.cyl(STEEL, 0, 1.9, MOBILE_CRANE.slewZ, 1.05, 0.25, 'y', 24);
    // the outrigger boxes, front and rear
    for (const z of [MO.beams[0].z, MO.beams[2].z]) p.box(STEEL, -1.25, 1.25, 0.72, 1.18, z - 0.3, z + 0.3);
    // steps and tool boxes along the sides
    if (full) {
      for (const side of [-1, 1]) {
        p.box(STEEL, side * 1.0, side * 1.28, 0.62, 1.08, -1.25, -0.35);
        p.box(STEEL, side * 1.0, side * 1.28, 0.62, 1.08, 3.3, 3.7);
        p.box(GALV, side * 1.05, side * 1.29, 0.5, 0.54, -2.25, -2.0);
      }
      p.box(GALV, -1.25, -1.0, 0.65, 0.69, -2.85, -2.55);
    }
    const glass = new Parts();
    glass.box(GLASS, c0 + 0.04, c1 - 0.04, 1.85, 2.95, -3.955, -3.945);
    glass.box(GLASS, c0 - 0.005, c0 + 0.005, 1.85, 2.95, -3.9, -2.4);
    glass.box(GLASS, c1 - 0.005, c1 + 0.005, 1.85, 2.95, -3.9, -2.4);
    // lamps
    for (const side of [-1, 1]) {
      p.box(LAMP, side * 0.95 - 0.12, side * 0.95 + 0.12, 0.65, 0.8, -3.99, -3.97);
      const stop = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.03), TAIL);
      stop.position.set(side * 0.95, 0.9, 4.62);
      body.add(stop);
      this.lamps.brake.push(stop);
      for (const z of [-3.99, 4.62]) {
        const ind = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.03), AMBER);
        ind.position.set(side * 1.15, 0.9, z);
        body.add(ind);
        this.lamps.indicators.push({ mesh: ind, side });
      }
    }
    p.build(body);
    glass.build(body, false);
    // the amber beacons on the cab's roof
    for (const x of [-1.15, -0.62]) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.14, 10), AMBER);
      b.position.set(x, 3.23, -3.1);
      body.add(b);
      this.beacons.push(b);
    }
    // ---- the wheels: three axles of single tyres
    for (const z of MOBILE_AXLES) {
      for (const side of [-1, 1]) {
        const w = wheelGroup(0.69, 0.39);
        w.position.set(side * 1.04, 0.69, z);
        body.add(w);
        this.wheels.push(w);
      }
    }
    // ---- the outriggers: a beam each, its jack (housing and rod), its pad, the mat under it
    MO.beams.forEach((b) => {
      const g = new THREE.Group();
      g.position.set(0, 0, b.z);
      const bp = new Parts();
      // (the beam reaches from inside the box out to its jack; its outer end is at the group's origin, moved out)
      bp.box(YELLOW, -b.side * 1.9, 0, 0.78, 1.12, -0.2, 0.2);
      bp.cyl(YELLOW, 0, 0.85, 0, 0.13, 0.62, 'y', 12);
      bp.box(YELLOW, -0.16, 0.16, 1.1, 1.22, -0.16, 0.16);
      bp.build(g);
      body.add(g);
      this.beams.push(g);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1, 10).translate(0, -0.5, 0), CHROME);
      rod.castShadow = true;
      g.add(rod);
      this.rods.push(rod);
      const pad = new THREE.Group();
      const pp = new Parts();
      pp.cyl(PAD, 0, 0.04, 0, 0.3, 0.08, 'y', 16);
      pp.sphere(STEEL, 0, 0.1, 0, 0.1);
      pp.build(pad);
      g.add(pad);
      this.pads.push(pad);
      // (the mat lies on the ground, under the pad – it stays where it was put)
      const mat = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 1.0), TIMBER);
      mat.castShadow = true;
      mat.receiveShadow = true;
      body.add(mat);
      this.mats.push(mat);
    });
    // ---- the superstructure: it turns on the turntable
    const up = this.upper;
    up.position.set(MOBILE_CRANE.slewX, 0, MOBILE_CRANE.slewZ);
    body.add(up);
    const u = new Parts();
    // (along the boom: −z; to its right: +x)
    const a = (v: number): number => -v;
    u.cyl(STEEL, 0, 2.08, 0, 1.0, 0.12, 'y', 24);
    u.box(YELLOW, -0.95, 0.95, 2.15, 2.62, a(1.4), a(-2.3));
    // the crane cab on the left of the boom
    u.box(WHITE, -1.27, -0.55, 2.2, 2.35, a(2.15), a(0.2));
    u.box(WHITE, -1.27, -0.55, 3.95, 4.1, a(2.05), a(0.2));
    u.box(WHITE, -1.27, -0.55, 2.35, 3.95, a(0.3), a(0.2));
    for (const [x, z] of [[-1.27, 2.05], [-0.55, 2.05], [-1.27, 0.25], [-0.55, 0.25]]) u.box(WHITE, x - 0.035, x + 0.035, 2.35, 3.95, a(z) - 0.035, a(z) + 0.035);
    u.box(STEEL, -1.15, -0.65, 2.35, 2.75, a(1.4), a(0.6));
    const ug = new Parts();
    ug.box(GLASS, -1.24, -0.58, 2.4, 3.92, a(2.15) - 0.005, a(2.15) + 0.005);
    ug.box(GLASS, -1.275, -1.265, 2.4, 3.92, a(2.0), a(0.3));
    ug.box(GLASS, -0.555, -0.545, 2.9, 3.92, a(2.0), a(0.3));
    ug.box(GLASS, -1.22, -0.6, 4.095, 4.105, a(1.95), a(0.8));
    // the boom's foot bearings, the luffing cylinder's lower bearing
    for (const side of [-1, 1]) u.box(YELLOW, side * 0.5 - 0.06, side * 0.5 + 0.06, 2.55, MG.footY + 0.25, a(MG.footA) - 0.35, a(MG.footA) + 0.35);
    u.cyl(STEEL, 0, MG.footY, a(MG.footA), 0.12, 1.15, 'x', 12);
    u.box(YELLOW, -0.3, 0.3, 1.85, 2.2, a(MG.cylA) - 0.25, a(MG.cylA) + 0.25);
    // the hoist winch behind the boom's foot
    u.cyl(STEEL, 0, 2.95, a(-1.75), 0.36, 0.9, 'x', 16);
    u.box(STEEL, 0.47, 0.72, 2.6, 3.25, a(-1.45), a(-2.05));
    // the counterweight: a base plate and three slabs
    for (let k = 0; k < 4; k++) u.box(k === 0 ? STEEL : CONCRETE, -1.25, 1.25, 1.85 + k * 0.26, 2.09 + k * 0.26, a(-2.55), a(-4.05));
    if (full) u.box(RED, -1.26, 1.26, 2.55, 2.62, a(-2.55), a(-4.06));
    u.build(up);
    ug.build(up, false);
    // ---- the boom: four sections, the head with its sheaves – pivoting at its foot
    const bm = this.boom;
    bm.position.set(0, MG.footY, a(MG.footA));
    up.add(bm);
    const secs = [
      { w: 0.85, h: 0.95, len: 9.7, start: -0.5 },
      { w: 0.72, h: 0.8, len: 8.6, start: 0 },
      { w: 0.6, h: 0.66, len: 8.6, start: 0 },
      { w: 0.5, h: 0.54, len: 8.6, start: 0 },
    ];
    secs.forEach((sc, k) => {
      const g = new THREE.Group();
      const sp = new Parts();
      // (the boom points along −z in its own frame: the base section from behind its pin to 9.2 m; the others' ends are at their groups' origins, their length reaching back inside)
      if (k === 0) {
        sp.box(YELLOW, -sc.w / 2, sc.w / 2, -sc.h / 2, sc.h / 2, -9.2, -sc.start);
        sp.box(YELLOW, -0.2, 0.2, -sc.h / 2 - 0.3, -sc.h / 2, -MG.cylOnBoom - 0.35, -MG.cylOnBoom + 0.35);
      } else sp.box(YELLOW, -sc.w / 2, sc.w / 2, -sc.h / 2, sc.h / 2, 0, sc.len);
      sp.build(g);
      bm.add(g);
      this.sections.push(g);
    });
    if (full) {
      const name = plate('40 t', 2.2, 0.6);
      name.rotation.y = -Math.PI / 2;
      name.position.set(0.43, 0, -5.2);
      this.sections[0].add(name);
    }
    // the head: plates and sheaves at the end of the last section
    const hd = this.head;
    const hp = new Parts();
    hp.box(YELLOW, -0.3, 0.3, -0.45, 0.3, -0.1, 0.35);
    for (const x of [-0.18, -0.06, 0.06, 0.18]) hp.cyl(STEEL, x, -0.2, -0.45, 0.3, 0.07, 'x', 14);
    hp.box(YELLOW, -0.28, -0.24, -0.6, 0.2, -0.75, -0.1);
    hp.box(YELLOW, 0.24, 0.28, -0.6, 0.2, -0.75, -0.1);
    hp.build(hd);
    this.sections[3].add(hd);
    // the luffing cylinder: housing and rod, each placed between its pins every picture
    this.cylHousing = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1, 12).translate(0, 0.5, 0), YELLOW);
    this.cylRod = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1, 12).translate(0, 0.5, 0), CHROME);
    this.cylHousing.castShadow = this.cylRod.castShadow = true;
    up.add(this.cylHousing, this.cylRod);
    this.winchRope = new Line(up, 0.016);
    // the hook block on four falls
    this.hook = hookBlock(0.6, 1.0, 4, detail);
    inner.add(this.hook);
    for (let i = 0; i < 4; i++) this.falls.push(new Line(inner, 0.018));
  }

  setCabinOpacity(): void {}

  update(s: CarVisualState, _dt: number, now: number): void {
    this.lamps.update(s, this.root);
    for (let i = 0; i < this.wheels.length; i++) {
      // (the physics knows four wheels: the middle and the last axle follow the rear pair)
      const k = i < 2 ? i : 2 + (i % 2);
      const w = this.wheels[i];
      this.wheelY[i] = s.wheelY[k] ?? 0.69;
      w.position.y = this.wheelY[i];
      w.rotation.set(-(s.wheelSpin[k] ?? 0), i < 2 ? -(s.wheelSteer[k] ?? 0) : 0, 0, 'YXZ');
    }
    // the beacons flash while the crane works
    const on = this.operating && Math.floor(now * 2.5) % 2 === 0;
    for (const b of this.beacons) b.material = on ? AMBER : TAIL;
  }

  pose(c: Crane, now: number): void {
    void now;
    poseTip(this.tip, this.inner, c);
    this.operating = c.time > 0;
    // the carrier lifted by its jacks, levelled against the ground's slope
    const lift = c.lift;
    this.body.position.y = lift;
    this.body.rotation.set(-Math.atan(c.levelFix.gz), 0, Math.atan(c.levelFix.gx), 'XYZ');
    // (the wheels hang down out of their springs as it goes up, then leave the ground)
    const droop = Math.min(lift, 0.12);
    this.wheels.forEach((w, i) => (w.position.y = (this.wheelY[i] ?? 0.69) - droop));
    // outriggers: the beams out, the jacks down onto their pads, the mats under them
    MO.beams.forEach((b, i) => {
      const x = b.side * (MO.padIn + c.beams[i] * (MO.padOut - MO.padIn));
      const g = this.beams[i];
      g.position.x = x;
      // (the pad's sole is `clearance` above the ground with the jack drawn up; the rod reaches down to it)
      const stroke = c.jacks[i];
      const sole = MO.clearance - stroke;
      const rod = this.rods[i];
      rod.position.set(0, 0.7, 0);
      rod.scale.set(1, Math.max(0.01, 0.7 - sole - 0.12), 1);
      this.pads[i].position.set(0, sole, 0);
      // the mat is laid on the ground under the pad once the beam is out
      const mat = this.mats[i];
      mat.visible = c.beams[i] > 0.4;
      mat.position.set(x, c.padGround[i] - lift, b.z);
    });
    // the superstructure, the boom, its sections and the luffing cylinder
    const q = c.q;
    this.upper.rotation.y = q.slew;
    this.boom.rotation.x = q.luff;
    const L = boomLength(q.tele);
    const extra = (L - MG.length0) / 3;
    for (let k = 1; k < 4; k++) {
      // (each section's end: 13 cm beyond the one it comes out of, and out by its share of the telescoping)
      const end = 9.2 + 0.13 * k + extra * k;
      this.sections[k].position.z = -end;
    }
    this.head.position.z = 0;
    // the luffing cylinder from its bearing on the turntable to its point under the boom
    const ax = 0;
    const ay = 1.95;
    const az = -MG.cylA;
    const d = MG.cylOnBoom;
    const bx = 0;
    const by = MG.footY + d * Math.sin(q.luff) - 0.55 * Math.cos(q.luff);
    const bz = -MG.footA - d * Math.cos(q.luff) - 0.55 * Math.sin(q.luff);
    tmp.set(bx - ax, by - ay, bz - az);
    const len = tmp.length();
    tmp.divideScalar(len);
    tmpQ.setFromUnitVectors(UP, tmp);
    // (housing and rod 2.4 m each: the rod comes out of the housing as the boom goes up)
    const part = Math.min(len, 2.4);
    this.cylHousing.position.set(ax, ay, az);
    this.cylHousing.quaternion.copy(tmpQ);
    this.cylHousing.scale.set(1, part, 1);
    const out = Math.max(0, len - 2.4);
    this.cylRod.position.set(ax + tmp.x * out, ay + tmp.y * out, az + tmp.z * out);
    this.cylRod.quaternion.copy(tmpQ);
    this.cylRod.scale.set(1, part, 1);
    // the hoist rope along the boom, from the top of the winch's drum to the head's sheaves
    const lh = L + MG.head;
    this.winchRope.set(tmp.set(0, 3.31, 1.75), tmp2.set(0, MG.footY + lh * Math.sin(q.luff) + 0.12 * Math.cos(q.luff), -MG.footA - lh * Math.cos(q.luff) + 0.12 * Math.sin(q.luff)));
    // the hook block where the rope has it, the falls up to the head's sheaves
    this.inner.updateMatrixWorld(true);
    const local = this.inner.worldToLocal(tmp.set(c.hook.x, c.hook.y, c.hook.z));
    this.hook.position.copy(local);
    this.hook.rotation.set(0, q.slew, 0);
    const head = headOf('mobile', q);
    const sn = Math.sin(q.slew);
    const co = Math.cos(q.slew);
    for (let i = 0; i < 4; i++) {
      const side = -0.18 + i * 0.12;
      const hx = MOBILE_CRANE.slewX - head.a * sn + side * co;
      const hz = MOBILE_CRANE.slewZ - head.a * co - side * sn;
      tmp2.set(hx, head.y + lift - 0.2, hz);
      this.falls[i].set(tmp2, tmp.set(local.x + side * co * 0.8, local.y - 0.15, local.z - side * sn * 0.8));
    }
  }

  operatorEye(out: THREE.Vector3): THREE.Vector3 {
    // (the cab is on the left of the boom: the boom points along −z of the superstructure)
    out.set(-0.9, 3.55, -1.4);
    return this.upper.localToWorld(out);
  }
}

// ------------------------------------------------------------------------------------ the loader crane

const LG = LOADER_GEOMETRY;
const LO = LOADER_CRANE.outriggers!;

export class LoaderCraneModel implements CraneModel {
  readonly kind = 'loader' as const;
  readonly root = new THREE.Group();
  readonly eye = new THREE.Vector3(-0.62, 2.38, -3.3);
  readonly mirrors: Mirror[] = [];
  private readonly tip: THREE.Group;
  private readonly inner: THREE.Group;
  private readonly body = new THREE.Group();
  private readonly column = new THREE.Group();
  private readonly innerBoom = new THREE.Group();
  private readonly outerBoom = new THREE.Group();
  private readonly ext: THREE.Group[] = [];
  private readonly liftCyl: [THREE.Mesh, THREE.Mesh];
  private readonly foldCyl: [THREE.Mesh, THREE.Mesh];
  private readonly wheels: THREE.Group[] = [];
  private readonly beams: THREE.Group[] = [];
  private readonly rods: THREE.Mesh[] = [];
  private readonly pads: THREE.Group[] = [];
  private readonly hook: THREE.Group;
  private readonly link: Line;
  private readonly lamps = new Lamps();

  constructor(detail: CraneDetail = 'full') {
    this.root.name = 'loader crane';
    const { tip, inner } = tipping(this.root);
    this.tip = tip;
    this.inner = inner;
    inner.add(this.body);
    const full = detail === 'full';
    const body = this.body;
    const p = new Parts();
    const hw = 1.25;
    // ---- the truck: chassis, cab, flatbed with its boards
    p.box(STEEL, -0.5, 0.5, 0.72, 1.02, -3.7, LOADER_BED.z1);
    const cz0 = -3.9;
    const cz1 = -2.35;
    p.box(WHITE, -hw, hw, 1.0, 1.9, cz0, cz1);
    p.box(WHITE, -hw, hw, 2.85, 3.08, cz0, cz1 + 0.1);
    p.box(WHITE, -hw, hw, 1.9, 2.85, cz1 - 0.1, cz1);
    for (const [x, z] of [[-hw, cz0], [hw, cz0]]) p.box(WHITE, x - 0.05, x + 0.05, 1.9, 2.85, z, z + 0.08);
    p.box(DARK, -hw + 0.05, hw - 0.05, 0.5, 1.0, cz0 - 0.03, cz0 + 0.3);
    p.box(DARK, -0.75, 0.75, 1.1, 1.6, cz0 - 0.012, cz0 + 0.02);
    const glass = new Parts();
    glass.box(GLASS, -hw + 0.06, hw - 0.06, 1.9, 2.85, cz0 + 0.01, cz0 + 0.02);
    glass.box(GLASS, -hw - 0.005, -hw + 0.005, 1.9, 2.75, cz0 + 0.1, cz1 - 0.15);
    glass.box(GLASS, hw - 0.005, hw + 0.005, 1.9, 2.75, cz0 + 0.1, cz1 - 0.15);
    // the flatbed: its floor, the boards round it (the front one high, as a load guard)
    const B = LOADER_BED;
    p.box(TIMBER, -B.hw, B.hw, B.y - 0.08, B.y, B.z0, B.z1);
    p.box(STEEL, -B.hw, B.hw, B.y - 0.25, B.y - 0.08, B.z0, B.z1);
    p.box(GALV, -B.hw, B.hw, B.y, B.y + 1.1, B.z0 - 0.06, B.z0);
    for (const side of [-1, 1]) p.box(GALV, side * B.hw - 0.03, side * B.hw + 0.03, B.y, B.y + 0.4, B.z0, B.z1);
    p.box(GALV, -B.hw, B.hw, B.y, B.y + 0.4, B.z1 - 0.03, B.z1 + 0.03);
    // mudguards, the rear lamps' bar, the underrun bar
    for (const side of [-1, 1]) for (const z of LOADER_AXLES) p.box(DARK, side * 0.75, side * 1.28, 1.02, 1.08, z - 0.6, z + 0.6);
    p.box(STEEL, -1.15, 1.15, 0.5, 0.62, LOADER_BED.z1 - 0.05, LOADER_BED.z1 + 0.05);
    for (const side of [-1, 1]) {
      p.box(LAMP, side * 0.9 - 0.12, side * 0.9 + 0.12, 0.62, 0.78, cz0 - 0.02, cz0);
      const stop = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.03), TAIL);
      stop.position.set(side * 0.9, 0.78, LOADER_BED.z1 + 0.06);
      body.add(stop);
      this.lamps.brake.push(stop);
      for (const z of [cz0 - 0.02, LOADER_BED.z1 + 0.06]) {
        const ind = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.03), AMBER);
        ind.position.set(side * 1.1, 0.78, z);
        body.add(ind);
        this.lamps.indicators.push({ mesh: ind, side });
      }
    }
    // ---- the crane's base on the chassis, with the housing of the outrigger beams and the control levers
    const sz = LOADER_CRANE.slewZ;
    p.box(YELLOW, -0.62, 0.62, 1.02, 1.5, sz - 0.4, sz + 0.4);
    p.box(YELLOW, -1.2, 1.2, 0.68, 1.02, sz - 0.18, sz + 0.18);
    if (full) {
      for (const side of [-1, 1]) {
        p.box(STEEL, side * 1.2 - 0.06, side * 1.2 + 0.06, 1.05, 1.35, sz - 0.25, sz + 0.25);
        for (let k = 0; k < 4; k++) p.box(DARK, side * 1.28 - 0.015, side * 1.28 + 0.015, 1.3, 1.55, sz - 0.18 + k * 0.12, sz - 0.16 + k * 0.12);
      }
    }
    p.build(body);
    glass.build(body, false);
    // ---- wheels: single at the front, twin at the rear
    for (const z of LOADER_AXLES) {
      for (const side of [-1, 1]) {
        const w = wheelGroup(0.5, z < 0 ? 0.32 : 0.62);
        w.position.set(side * (z < 0 ? 0.95 : 0.9), 0.5, z);
        body.add(w);
        this.wheels.push(w);
      }
    }
    // ---- the outriggers: a beam each side, its jack and pad
    LO.beams.forEach((b) => {
      const g = new THREE.Group();
      g.position.set(0, 0, b.z);
      const bp = new Parts();
      bp.box(YELLOW, -b.side * 1.3, 0, 0.72, 0.98, -0.13, 0.13);
      bp.cyl(YELLOW, 0, 0.78, 0, 0.1, 0.45, 'y', 12);
      bp.build(g);
      body.add(g);
      this.beams.push(g);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 10).translate(0, -0.5, 0), CHROME);
      rod.castShadow = true;
      g.add(rod);
      this.rods.push(rod);
      const pad = new THREE.Group();
      const pp = new Parts();
      pp.box(PAD, -0.22, 0.22, 0, 0.06, -0.22, 0.22);
      pp.sphere(STEEL, 0, 0.08, 0, 0.07);
      pp.build(pad);
      g.add(pad);
      this.pads.push(pad);
    });
    // ---- the column, turning on the base
    const col = this.column;
    col.position.set(LOADER_CRANE.slewX, 0, sz);
    body.add(col);
    const cp = new Parts();
    cp.cyl(STEEL, 0, 1.56, 0, 0.42, 0.12, 'y', 18);
    cp.box(YELLOW, -0.28, 0.28, 1.6, LG.pinY + 0.22, -0.28, 0.22);
    cp.box(YELLOW, -0.32, 0.32, LG.pinY - 0.18, LG.pinY + 0.12, -LG.pinA - 0.15, -LG.pinA + 0.15);
    cp.box(YELLOW, -0.18, 0.18, 1.5, 1.75, -0.55, -0.25);
    cp.build(col);
    // the inner boom on its pin
    const ib = this.innerBoom;
    ib.position.set(0, LG.pinY, -LG.pinA);
    col.add(ib);
    const ip = new Parts();
    ip.box(YELLOW, -0.2, 0.2, -0.24, 0.24, -LG.inner, 0.18);
    ip.cyl(STEEL, 0, 0, -LG.inner, 0.1, 0.5, 'x', 10);
    ip.build(ib);
    // the outer boom at the inner one's end, its three extensions
    const ob = this.outerBoom;
    ob.position.set(0, 0, -LG.inner);
    ib.add(ob);
    const op = new Parts();
    op.box(YELLOW, -0.18, 0.18, -0.21, 0.21, -LG.outer0, 0.42);
    op.box(YELLOW, -0.14, 0.14, 0.15, 0.42, 0.2, 0.55);
    op.build(ob);
    const extLen = (LG.outer1 - LG.outer0) / 3;
    for (let k = 0; k < 3; k++) {
      const g = new THREE.Group();
      const ep = new Parts();
      const w = 0.15 - k * 0.025;
      const h = 0.18 - k * 0.025;
      // (each extension's end at its group's origin, its length back inside the boom)
      ep.box(YELLOW, -w, w, -h, h, 0, LG.outer0 - 0.35);
      if (k === 2) ep.box(STEEL, -0.08, 0.08, -0.25, -0.1, -0.12, 0.05);
      ep.build(g);
      ob.add(g);
      this.ext.push(g);
      g.userData.len = extLen;
    }
    // the cylinders: lift (column to inner boom), fold (inner boom to the outer boom's lever)
    const cyl = (r: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 10).translate(0, 0.5, 0), YELLOW);
      m.castShadow = true;
      return m;
    };
    const rodMesh = (r: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 10).translate(0, 0.5, 0), CHROME);
      m.castShadow = true;
      return m;
    };
    this.liftCyl = [cyl(0.12), rodMesh(0.075)];
    col.add(...this.liftCyl);
    this.foldCyl = [cyl(0.1), rodMesh(0.065)];
    ib.add(...this.foldCyl);
    // the hook on its link
    this.hook = hookBlock(0.28, 0.45, 1, detail);
    inner.add(this.hook);
    this.link = new Line(inner, 0.03, STEEL);
  }

  setCabinOpacity(): void {}

  update(s: CarVisualState): void {
    this.lamps.update(s, this.root);
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.position.y = s.wheelY[i] ?? 0.5;
      w.rotation.set(-(s.wheelSpin[i] ?? 0), i < 2 ? -(s.wheelSteer[i] ?? 0) : 0, 0, 'YXZ');
    }
  }

  /** Place a cylinder (housing and rod) between two points of its parent's frame. */
  private static ram(parts: [THREE.Mesh, THREE.Mesh], a: THREE.Vector3, b: THREE.Vector3, housing: number): void {
    tmp2.subVectors(b, a);
    const len = tmp2.length();
    tmp2.divideScalar(len || 1);
    tmpQ.setFromUnitVectors(UP, tmp2);
    const [h, r] = parts;
    h.position.copy(a);
    h.quaternion.copy(tmpQ);
    h.scale.set(1, Math.min(len, housing), 1);
    r.position.copy(a).addScaledVector(tmp2, Math.max(0, len - housing));
    r.quaternion.copy(tmpQ);
    r.scale.set(1, housing, 1);
  }

  pose(c: Crane): void {
    poseTip(this.tip, this.inner, c);
    this.body.position.y = c.lift;
    this.body.rotation.set(0, 0, Math.atan(c.levelFix.gx));
    LO.beams.forEach((b, i) => {
      const x = b.side * (LO.padIn + c.beams[i] * (LO.padOut - LO.padIn));
      this.beams[i].position.x = x;
      const len = 0.2 + c.jacks[i];
      this.rods[i].position.set(0, 0.56, 0);
      this.rods[i].scale.set(1, len, 1);
      this.pads[i].position.set(0, 0.56 - len - 0.06, 0);
    });
    const q = c.q;
    this.column.rotation.y = q.slew;
    // (the booms point along −z: a rotation about x by +angle raises them)
    this.innerBoom.rotation.x = q.inner;
    this.outerBoom.rotation.x = q.outer;
    const e = outerLength(q.ext) - LG.outer0;
    this.ext.forEach((g, k) => {
      // (the last one's end is the head the hook hangs from: the outer boom's length)
      g.position.z = -(LG.outer0 - 0.1 * (2 - k) + (e * (k + 1)) / 3);
    });
    // the lift cylinder: from the column's front low down to under the inner boom
    LoaderCraneModel.ram(this.liftCyl, tmp.set(0, 1.3, -0.5), new THREE.Vector3(0, LG.pinY + 1.05 * Math.sin(q.inner) - 0.24 * Math.cos(q.inner), -LG.pinA - 1.05 * Math.cos(q.inner) - 0.24 * Math.sin(q.inner)), 0.7);
    // the folding cylinder: on top of the inner boom to the outer boom's lever behind its pin
    const lev = new THREE.Vector3(0, 0.42, 0.45).applyAxisAngle(new THREE.Vector3(1, 0, 0), q.outer);
    lev.z -= LG.inner;
    LoaderCraneModel.ram(this.foldCyl, tmp.set(0, 0.32, -0.45), lev, 0.95);
    // the hook where its link has it
    this.inner.updateMatrixWorld(true);
    const local = this.inner.worldToLocal(tmp.set(c.hook.x, c.hook.y, c.hook.z));
    this.hook.position.copy(local);
    this.hook.rotation.set(0, q.slew, 0);
    const head = headOf('loader', q);
    const sn = Math.sin(q.slew);
    const co = Math.cos(q.slew);
    tmp2.set(LOADER_CRANE.slewX - head.a * sn, head.y + c.lift - 0.2, LOADER_CRANE.slewZ - head.a * co);
    this.link.set(tmp2, new THREE.Vector3(local.x, local.y + 0.05, local.z));
  }

  operatorEye(out: THREE.Vector3): THREE.Vector3 {
    // (with the radio control, beside the truck on the left, a little behind the crane)
    out.set(-3.3, 1.72, LOADER_CRANE.slewZ + 1.4);
    return this.inner.localToWorld(out);
  }
}

/** The model of a crane for its kind. */
export function makeCraneModel(type: CraneType, detail: CraneDetail): CraneModel {
  return type === 'tower' ? new TowerCraneModel(detail) : type === 'mobile' ? new MobileCraneModel(detail) : new LoaderCraneModel(detail);
}
