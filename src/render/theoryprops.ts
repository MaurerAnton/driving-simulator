// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The things of the later theory lessons (game/theoryscenes.ts) that are
 * neither road nor vehicle, drawn for render/theory.ts:
 *
 *  - the props of a place: trees (a forest), guide posts, a warning
 *    triangle, the barriers and cones of roadworks, a heap of earth, a
 *    tunnel over the road (its walls and roof see-through, so that the view
 *    from above still shows what happens inside);
 *  - what people hold: the rollator an old lady walks with, the stop/go
 *    sign of a flagman (red one side, green the other, turned to show);
 *  - the animals (render/animals.ts), from a pool;
 *  - the headlights in the dark: the light of a vehicle's dipped or full
 *    beam drawn on the road ahead of it – how far it reaches is what the
 *    night lesson is about.
 *
 * Everything is built for one lesson and taken down with it; the shared
 * shapes and materials stay.
 */
import * as THREE from 'three';
import type { ActorDef } from '../game/theory.ts';
import { beamAt, paddleAt } from '../game/theoryscenes.ts';
import { liftAt } from '../game/theorystage.ts';
import type { PropPlace, Stage } from '../game/theorystage.ts';
import { AnimalModel } from './animals.ts';
import type { AnimalKind } from './animals.ts';

/** Where the stage lies on the map (as render/theory.ts StageFrame). */
interface Frame {
  toWorld(x: number, z: number): [number, number];
  yawToWorld(yaw: number): number;
}

const lambert = (color: number, extra: THREE.MeshLambertMaterialParameters = {}): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color, ...extra });
const MAT = {
  trunk: lambert(0x5a4330),
  crown: lambert(0x2f4f2a),
  white: lambert(0xeeeeea),
  black: lambert(0x1c1c1e),
  amber: new THREE.MeshBasicMaterial({ color: 0xffa21a }),
  red: new THREE.MeshBasicMaterial({ color: 0xd8261c, side: THREE.DoubleSide }),
  green: new THREE.MeshBasicMaterial({ color: 0x1f9a4a, side: THREE.DoubleSide }),
  barRed: lambert(0xc8231b),
  orange: lambert(0xf26a12),
  earth: lambert(0x6b5338),
  frame: lambert(0x7d1f2b),
  tyre: lambert(0x18181a),
  wood: lambert(0x8a8f96),
  concrete: lambert(0xb4b3ab, { transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide }),
  portal: lambert(0x9c9b94),
  lamp: new THREE.MeshBasicMaterial({ color: 0xfff2c8 }),
  beam: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -18 }),
};

/** the shapes all lessons share (made when first needed) */
let shapes: {
  trunk: THREE.BufferGeometry;
  crown: THREE.BufferGeometry;
  post: THREE.BufferGeometry;
  band: THREE.BufferGeometry;
  reflector: THREE.BufferGeometry;
  triangle: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
  board: THREE.BufferGeometry;
  foot: THREE.BufferGeometry;
  cone: THREE.BufferGeometry;
  coneBand: THREE.BufferGeometry;
  heap: THREE.BufferGeometry;
  tube: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  seat: THREE.BufferGeometry;
  pole: THREE.BufferGeometry;
  disc: THREE.BufferGeometry;
  ring: THREE.BufferGeometry;
  low: THREE.BufferGeometry;
  high: THREE.BufferGeometry;
} | null = null;

/** The light of headlights on the road: from the nose `len` m ahead, widening, brightest near the car. */
function beamShape(len: number, wide: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const n = 8;
  const c = new THREE.Color(0xfff0c8);
  for (let i = 0; i < n; i++) {
    const a = i / n;
    const b = (i + 1) / n;
    const wa = 1.0 + (wide - 1.0) * a;
    const wb = 1.0 + (wide - 1.0) * b;
    const ka = 0.34 * (1 - a) ** 1.4;
    const kb = 0.34 * (1 - b) ** 1.4;
    // (a quad from a to b: two triangles, facing up)
    const pts = [[-wa / 2, -a * len, ka], [wa / 2, -a * len, ka], [wb / 2, -b * len, kb], [-wb / 2, -b * len, kb]];
    for (const k of [0, 2, 1, 0, 3, 2]) {
      const [x, z, f] = pts[k];
      pos.push(x, 0, z);
      col.push(c.r * f, c.g * f, c.b * f);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

function shapesOf(): NonNullable<typeof shapes> {
  if (shapes) return shapes;
  const tri = new THREE.Shape([new THREE.Vector2(-0.24, 0), new THREE.Vector2(0.24, 0), new THREE.Vector2(0, 0.42)]);
  tri.holes.push(new THREE.Path([new THREE.Vector2(-0.15, 0.05), new THREE.Vector2(0, 0.31), new THREE.Vector2(0.15, 0.05)]));
  const tube = new THREE.CylinderGeometry(0.014, 0.014, 1, 6);
  shapes = {
    trunk: new THREE.CylinderGeometry(0.12, 0.18, 2.4, 6).translate(0, 1.2, 0),
    crown: new THREE.ConeGeometry(1.7, 6.5, 7).translate(0, 5.2, 0),
    post: new THREE.BoxGeometry(0.12, 1.0, 0.1).translate(0, 0.5, 0),
    band: new THREE.BoxGeometry(0.124, 0.25, 0.104).translate(0, 0.82, 0),
    reflector: new THREE.BoxGeometry(0.04, 0.16, 0.012).translate(0.03, 0.72, -0.055),
    triangle: new THREE.ShapeGeometry(tri).translate(0, 0.1, 0),
    leg: new THREE.BoxGeometry(0.03, 0.03, 0.34).translate(0, 0.02, 0.1),
    board: new THREE.BoxGeometry(0.42, 0.22, 0.03),
    foot: new THREE.BoxGeometry(0.06, 1.0, 0.5).translate(0, 0.5, 0),
    cone: new THREE.ConeGeometry(0.17, 0.5, 10).translate(0, 0.25, 0),
    coneBand: new THREE.CylinderGeometry(0.095, 0.115, 0.08, 10).translate(0, 0.27, 0),
    heap: new THREE.ConeGeometry(1.7, 1.0, 8).translate(0, 0.5, 0),
    tube,
    wheel: new THREE.CylinderGeometry(0.09, 0.09, 0.04, 10).rotateZ(Math.PI / 2),
    seat: new THREE.BoxGeometry(0.42, 0.04, 0.3),
    pole: new THREE.CylinderGeometry(0.016, 0.016, 0.8, 6).translate(0, 0.4, 0),
    disc: new THREE.CircleGeometry(0.2, 20),
    ring: new THREE.RingGeometry(0.2, 0.235, 20),
    low: beamShape(55, 9),
    high: beamShape(105, 15),
  };
  return shapes;
}

/** A bar of the rollator's frame from a to b (local metres). */
function bar(g: THREE.Group, a: [number, number, number], b: [number, number, number], mat: THREE.Material): void {
  const s = shapesOf();
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const m = new THREE.Mesh(s.tube, mat);
  m.scale.set(1, d.length(), 1);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  g.add(m);
}

/** A rollator, its handles towards the person behind it (local: −z forwards, the handles at z = 0). */
function makeRollator(): THREE.Group {
  const s = shapesOf();
  const g = new THREE.Group();
  for (const x of [-0.25, 0.25]) {
    bar(g, [x, 0.9, 0.0], [x, 0.09, -0.08], MAT.frame);
    bar(g, [x, 0.9, 0.0], [x, 0.09, -0.6], MAT.frame);
    const back = new THREE.Mesh(s.wheel, MAT.tyre);
    back.position.set(x, 0.09, -0.08);
    const front = new THREE.Mesh(s.wheel, MAT.tyre);
    front.position.set(x, 0.09, -0.6);
    g.add(back, front);
  }
  bar(g, [-0.25, 0.55, -0.2], [0.25, 0.55, -0.2], MAT.frame);
  const seat = new THREE.Mesh(s.seat, MAT.black);
  seat.position.set(0, 0.57, -0.3);
  g.add(seat);
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });
  return g;
}

/** A flagman's sign on its pole: the red side faces −z (where he looks), the green one +z. */
function makePaddle(): { group: THREE.Group; turn: THREE.Group } {
  const s = shapesOf();
  const group = new THREE.Group();
  const turn = new THREE.Group();
  // (in his right hand, held up in front of him)
  turn.position.set(0.24, 1.12, -0.52);
  const pole = new THREE.Mesh(s.pole, MAT.black);
  const red = new THREE.Mesh(s.disc, MAT.red);
  red.position.set(0, 0.95, -0.006);
  red.rotation.y = Math.PI;
  const green = new THREE.Mesh(s.disc, MAT.green);
  green.position.set(0, 0.95, 0.006);
  for (const side of [-1, 1]) {
    const ring = new THREE.Mesh(s.ring, MAT.white);
    ring.position.set(0, 0.95, side * 0.008);
    if (side < 0) ring.rotation.y = Math.PI;
    turn.add(ring);
  }
  turn.add(pole, red, green);
  group.add(turn);
  return { group, turn };
}

export class TheoryExtras {
  readonly group = new THREE.Group();
  private readonly place = new THREE.Group();
  private readonly made: Array<{ dispose(): void }> = [];
  /** props shown only for a while of the script */
  private timed: Array<{ obj: THREE.Object3D; from: number; to: number }> = [];
  private readonly pool = { animals: new Map<AnimalKind, AnimalModel[]>(), rollators: [] as THREE.Group[], paddles: [] as Array<{ group: THREE.Group; turn: THREE.Group }> };
  private used: Array<() => void> = [];
  /** what each actor (by its index) holds, and its headlights */
  private readonly held = new Map<number, { group: THREE.Group; turn?: THREE.Group }>();
  private readonly beams = new Map<number, THREE.Mesh>();

  constructor() {
    this.group.name = 'theory: props';
    this.group.add(this.place);
  }

  // ------------------------------------------------------------------ props
  /** The props of a place, on the ground of the map. */
  build(st: Stage, f: Frame, height: (x: number, z: number) => number): void {
    const props = st.props ?? [];
    if (props.length === 0) return;
    const s = shapesOf();
    const groundAt = (x: number, z: number): [number, number, number] => {
      const [wx, wz] = f.toWorld(x, z);
      return [wx, height(wx, wz) + liftAt(st, x, z), wz];
    };
    // the trees: two instanced meshes for the lot
    const trees = props.filter((p) => p.kind === 'tree');
    if (trees.length > 0) {
      const trunks = new THREE.InstancedMesh(s.trunk, MAT.trunk, trees.length);
      const crowns = new THREE.InstancedMesh(s.crown, MAT.crown, trees.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      const at = new THREE.Vector3();
      trees.forEach((p, i) => {
        const [x, y, z] = groundAt(p.x, p.z);
        const k = p.size ?? 1;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (p.x * 7.3 + p.z * 3.1) % 6.28);
        m.compose(at.set(x, y, z), q, sc.set(k, k, k));
        trunks.setMatrixAt(i, m);
        crowns.setMatrixAt(i, m);
      });
      for (const im of [trunks, crowns]) {
        im.castShadow = true;
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        this.made.push(im);
        this.place.add(im);
      }
    }
    for (const p of props) {
      if (p.kind === 'tree') continue;
      const obj = p.kind === 'tunnel' ? this.tunnel(p, f, groundAt) : this.prop(p);
      if (!obj) continue;
      if (p.kind !== 'tunnel') {
        const [x, y, z] = groundAt(p.x, p.z);
        obj.position.set(x, y, z);
        obj.rotation.y = f.yawToWorld(p.yaw ?? 0);
        const k = p.size ?? 1;
        obj.scale.set(k, k, k);
      }
      this.place.add(obj);
      if (p.from !== undefined || p.to !== undefined) this.timed.push({ obj, from: p.from ?? -Infinity, to: p.to ?? Infinity });
    }
  }

  /** One small prop (local: −z the side it faces). */
  private prop(p: PropPlace): THREE.Object3D | null {
    const s = shapesOf();
    const g = new THREE.Group();
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, ry = 0): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.castShadow = true;
      g.add(m);
      return m;
    };
    switch (p.kind) {
      case 'post':
        add(s.post, MAT.white);
        add(s.band, MAT.black);
        add(s.reflector, MAT.amber);
        break;
      case 'triangle': {
        // the red frame facing the traffic, leaning back a little on its stand
        const t = add(s.triangle, MAT.red);
        t.rotation.set(-0.12, Math.PI, 0);
        add(s.leg, MAT.black, -0.14);
        add(s.leg, MAT.black, 0.14);
        break;
      }
      case 'barrier': {
        // a striped board across the lane on two feet, a warning lamp on top
        for (let i = 0; i < 6; i++) add(s.board, i % 2 ? MAT.white : MAT.barRed, -1.05 + i * 0.42, 1.0, 0);
        add(s.foot, MAT.wood, -1.3, 0, 0);
        add(s.foot, MAT.wood, 1.3, 0, 0);
        const lamp = add(s.coneBand, MAT.amber, -1.3, 0.85, 0);
        lamp.scale.set(0.8, 1.6, 0.8);
        break;
      }
      case 'cone':
        add(s.cone, MAT.orange);
        add(s.coneBand, MAT.white);
        break;
      case 'heap':
        add(s.heap, MAT.earth).scale.set(1, 1, 0.7);
        break;
      default:
        return null;
    }
    return g;
  }

  /** A tunnel over the road: see-through walls and roof, the portal at its south end, lamps along the walls. */
  private tunnel(p: PropPlace, f: Frame, groundAt: (x: number, z: number) => [number, number, number]): THREE.Object3D {
    const x0 = Math.min(p.x, p.x1 ?? p.x);
    const x1 = Math.max(p.x, p.x1 ?? p.x);
    const zS = Math.max(p.z, p.z1 ?? p.z);
    const zN = Math.min(p.z, p.z1 ?? p.z);
    const h = p.h ?? 5;
    const cx = (x0 + x1) / 2;
    const cz = (zS + zN) / 2;
    const len = zS - zN;
    const wide = x1 - x0;
    const g = new THREE.Group();
    // (the stage's frame turned onto the map: local −z its north, local x its east; level with the road at the portal)
    const wy = groundAt(cx, zS - 2)[1];
    const [gx, gz] = f.toWorld(cx, cz);
    g.position.set(gx, wy, gz);
    g.rotation.y = f.yawToWorld(0);
    const piece = (w: number, hh: number, l: number, x: number, y: number, z: number, mat: THREE.Material): void => {
      const geo = new THREE.BoxGeometry(w, hh, l).translate(x, y, z);
      this.made.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = mat === MAT.concrete ? 8 : 0;
      g.add(m);
    };
    // the walls and the vault (local z: south +)
    piece(0.6, h, len, x0 - cx - 0.3, h / 2, 0, MAT.concrete);
    piece(0.6, h, len, x1 - cx + 0.3, h / 2, 0, MAT.concrete);
    piece(wide + 1.2, 0.5, len, 0, h + 0.25, 0, MAT.concrete);
    // the portal: solid pillars and the lintel round the opening
    const south = len / 2;
    piece(1.4, h + 1.2, 0.8, x0 - cx - 0.7, (h + 1.2) / 2, south, MAT.portal);
    piece(1.4, h + 1.2, 0.8, x1 - cx + 0.7, (h + 1.2) / 2, south, MAT.portal);
    piece(wide, 1.2, 0.8, 0, h + 0.6, south, MAT.portal);
    // the lamps along both walls under the roof
    for (let z = south - 4; z > -south; z -= 7) {
      piece(0.12, 0.12, 1.2, x0 - cx + 0.1, h - 0.5, z, MAT.lamp);
      piece(0.12, 0.12, 1.2, x1 - cx - 0.1, h - 0.5, z, MAT.lamp);
    }
    return g;
  }

  // ---------------------------------------------------------------- animals
  /** A deer or a boar for the lesson (from the pool). */
  animal(kind: AnimalKind): AnimalModel {
    const list = this.pool.animals.get(kind) ?? [];
    this.pool.animals.set(kind, list);
    const a = list.pop() ?? new AnimalModel(kind);
    this.used.push(() => list.push(a));
    return a;
  }

  // -------------------------------------------------------- what people hold
  /**
   * Place what the person of actor `i` holds: a rollator ahead of somebody
   * old, a flagman's sign turned to its side of the moment (`t`: the
   * script's time).  At (x, y, z) facing `yaw` (on the map); null: hide it.
   */
  hold(i: number, def: ActorDef, t: number, x: number, y: number, z: number, yaw: number): void {
    const role = def.role;
    if (role !== 'senior' && role !== 'flagman') return;
    let h = this.held.get(i);
    if (!h) {
      if (role === 'senior') {
        const r = this.pool.rollators.pop() ?? makeRollator();
        this.used.push(() => this.pool.rollators.push(r));
        h = { group: r };
      } else {
        const p = this.pool.paddles.pop() ?? makePaddle();
        this.used.push(() => this.pool.paddles.push(p));
        h = p;
      }
      this.held.set(i, h);
      this.group.add(h.group);
    }
    h.group.visible = true;
    h.group.position.set(x, y, z);
    h.group.rotation.y = yaw;
    // (the rollator a step ahead of the feet)
    if (role === 'senior') h.group.position.add(new THREE.Vector3(-Math.sin(yaw) * 0.42, 0, -Math.cos(yaw) * 0.42));
    if (h.turn) h.turn.rotation.y = Math.PI * paddleAt(def, t);
  }

  /** Hide what actor `i` holds (not there at this moment). */
  drop(i: number): void {
    const h = this.held.get(i);
    if (h) h.group.visible = false;
  }

  // -------------------------------------------------------------- headlights
  /** The light of actor `i`'s headlights at time t, ahead of its nose (`front` m ahead of (x, y, z)), facing `yaw`. */
  light(i: number, def: ActorDef, t: number, x: number, y: number, z: number, yaw: number, front: number): void {
    const state = beamAt(def, t);
    let m = this.beams.get(i);
    if (state === 0) {
      if (m) m.visible = false;
      return;
    }
    const s = shapesOf();
    if (!m) {
      m = new THREE.Mesh(s.low, MAT.beam);
      m.renderOrder = 7;
      this.beams.set(i, m);
      this.group.add(m);
    }
    m.visible = true;
    m.geometry = state === 2 ? s.high : s.low;
    m.position.set(x - Math.sin(yaw) * front, y + 0.04, z - Math.cos(yaw) * front);
    m.rotation.set(0, yaw, 0);
  }

  /** Each frame: the props of the moment shown. */
  update(t: number): void {
    for (const p of this.timed) p.obj.visible = t >= p.from && t <= p.to;
  }

  /** Everything of the lesson gone (the pools kept). */
  clear(): void {
    for (const m of this.made) m.dispose();
    this.made.length = 0;
    this.place.clear();
    this.timed = [];
    for (const h of this.held.values()) this.group.remove(h.group);
    this.held.clear();
    for (const m of this.beams.values()) this.group.remove(m);
    this.beams.clear();
    for (const back of this.used) back();
    this.used = [];
  }
}
