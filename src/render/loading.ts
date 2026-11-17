// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A truck being loaded at a depot: the scene a free drive with a truck of
 * class C1 or C begins with (game/serviceworld.ts).
 *
 * The truck stands with its rear doors at the loading dock of a warehouse
 * (or, where there is no room for a depot, at the roadside: then the goods
 * come off a stack on the ground).  A forklift takes the pallets one by one
 * from the stack and sets them down at the door – on the dock, or lifted
 * onto the floor of the box –, a worker with a pallet truck pushes each into
 * the box, to the front first, row by row; a third stands by with the
 * papers.  The doors open at the start and close at the end; the camera
 * circles slowly at the side of the truck's rear.  Everything here is
 * scripted: the moves of each actor follow from the places of the pallets
 * (`schedule`), and `update` shows the moment of the script.
 *
 * The frame of the scene is the truck's (x to the right, y up from the
 * ground under the truck, z to the back); its group is placed where the
 * truck stands.  The people are those of render/people.ts in work clothes.
 */
import * as THREE from 'three';
import type { BoxBody } from './boxbody.ts';
import { PeopleRenderer, SEAT_HEIGHT, workerLook } from './people.ts';
import type { PersonPose } from './people.ts';

/** A pallet to be loaded: how tall its goods stand, and what they are (0 cartons, 1 sacks, 2 drums, 3 crates). */
export interface PalletLoad {
  height: number;
  kind: number;
  mass: number;
}

/** Euro pallet: 1.2 m along the truck, 0.8 m across, 0.144 m high. */
export const PALLET = { len: 1.2, wid: 0.8, base: 0.144 };

/**
 * Where the pallets go in a box (truck frame: x across, z along): two side
 * by side, row after row from the front.  `inside`: the box's inside
 * (render/boxbody.ts).
 */
export function palletSlots(inside: { x0: number; x1: number; front: number; rear: number }, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const rows = Math.floor((inside.rear - inside.front - 0.2) / (PALLET.len + 0.05));
  const half = Math.min(0.45, (inside.x1 - inside.x0) / 4);
  for (let r = 0; r < rows && out.length < n; r++) {
    const z = inside.front + 0.1 + PALLET.len / 2 + r * (PALLET.len + 0.05);
    for (const x of [-half, half]) if (out.length < n) out.push([x, z]);
  }
  return out;
}

// ------------------------------------------------------------------ the script

/** A moment of an actor's way: where it is (truck frame), which way it faces (yaw), its forks' height, what it carries (−1 nothing). */
export interface Key {
  t: number;
  x: number;
  z: number;
  yaw: number;
  h: number;
  carry: number;
}

/** What the script says about the whole scene. */
export interface Script {
  forklift: Key[];
  jack: Key[];
  /** for each pallet: when the forklift takes it, when it puts it down at the door, when the pallet truck takes it, when it is in its place */
  pallets: Array<{ pick: number; drop: number; take: number; placed: number }>;
  /** where the pallets wait (truck frame), where they are set down, and their places in the box */
  stack: Array<[number, number, number]>;
  staging: [number, number, number];
  slots: Array<[number, number]>;
  /** when the doors begin to close, and when it is all over */
  closing: number;
  end: number;
}

const FORK_REACH = 1.2;
/** how far the dock's wall stands behind the truck's rear: room for its doors to swing round (a long leveller bridges it) */
export const DOCK_GAP = 1.7;
const SPEED = { fork: 1.7, back: 1.1, jack: 1.3, turn: 1.6 };

/** The yaw of a heading along (dx, dz). */
const headingOf = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

/** An actor's way, built move by move. */
class Way {
  readonly keys: Key[] = [];
  constructor(t: number, x: number, z: number, yaw: number) {
    this.keys.push({ t, x, z, yaw, h: 0.08, carry: -1 });
  }

  get last(): Key {
    return this.keys[this.keys.length - 1];
  }

  /** Wait until t (or for a moment). */
  wait(until: number): this {
    const k = this.last;
    if (until > k.t) this.keys.push({ ...k, t: until });
    return this;
  }

  /** Go straight to (x, z), facing `yaw` at the end (turning on the way), at `speed`. */
  go(x: number, z: number, yaw: number, speed: number): this {
    const k = this.last;
    const d = Math.hypot(x - k.x, z - k.z);
    let dy = yaw - k.yaw;
    dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
    const t = Math.max(d / speed, Math.abs(dy) / SPEED.turn, 0.2);
    this.keys.push({ ...k, t: k.t + t, x, z, yaw: k.yaw + dy });
    return this;
  }

  /** Lift or lower the forks to h. */
  lift(h: number, carry = this.last.carry): this {
    const k = this.last;
    this.keys.push({ ...k, t: k.t + Math.max(0.3, Math.abs(h - k.h) / 0.6), h, carry });
    return this;
  }

  /** Take or leave a pallet (no time). */
  hold(carry: number): this {
    const k = this.last;
    this.keys[this.keys.length - 1] = { ...k, carry };
    return this;
  }
}

/** The actor's state at time t (keys sorted by time). */
export function at(keys: readonly Key[], t: number, out: Key): Key {
  if (t <= keys[0].t) return Object.assign(out, keys[0]);
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (t <= b.t) {
      const a = keys[i - 1];
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      const e = u * u * (3 - 2 * u);
      out.t = t;
      out.x = a.x + (b.x - a.x) * e;
      out.z = a.z + (b.z - a.z) * e;
      out.yaw = a.yaw + (b.yaw - a.yaw) * e;
      out.h = a.h + (b.h - a.h) * e;
      out.carry = a.carry;
      return out;
    }
  }
  return Object.assign(out, keys[keys.length - 1]);
}

/**
 * The script of the loading: `rear` the end of the truck's box (z), `floor`
 * its floor, `dock` whether a dock stands behind it (its wall at `wallZ`,
 * its floor at the height of the truck's) – else the stack is on the ground
 * beside the truck's rear and the forklift lifts each pallet onto the floor
 * of the box at its end.  The pallet truck takes each pallet from there: on
 * the dock from behind, pushing it into the box; on the ground from inside
 * the box, pulling it to the front.  The forklift sets the next pallet down
 * only once the pallet truck is out of its way.  The times are stretched or
 * squeezed so that it all lasts 30 to 60 seconds.
 */
export function schedule(n: number, slots: Array<[number, number]>, rear: number, floor: number, dock: boolean, wallZ: number): Script {
  const stack: Array<[number, number, number]> = [];
  const staging: [number, number, number] = dock ? [0, floor, wallZ + 1.0] : [0, floor, rear - 0.62];
  for (let i = 0; i < n; i++) {
    if (dock) stack.push([-4.2 + (i % 6) * 1.25 + (i >= 6 ? 0.6 : 0), 0, wallZ + 7.2 + (i >= 6 ? 1.4 : 0)]);
    else stack.push([4.6, 0, rear + 2.2 + i * 1.0]);
  }
  // the height the forklift sets down at, over the ground it drives on (the dock's floor, or the ground)
  const dropH = dock ? 0 : floor;
  const forkHome: [number, number, number] = dock ? [3.5, wallZ + 4.5, Math.PI] : [3.2, rear + 7, Math.PI];
  // the pallet truck works from behind the door (on the dock: facing into the box) or from inside the box (facing out)
  const dir = dock ? 0 : Math.PI;
  const side = dock ? 1 : -1;
  const jackHome: [number, number] = dock ? [1.5, staging[2] + 1.7] : [0, staging[2] - 1.7];
  const fork = new Way(0, forkHome[0], forkHome[1], forkHome[2]);
  const jack = new Way(0, jackHome[0], jackHome[1], dir);
  const pallets: Script['pallets'] = [];
  let forkFree = 2.2;
  let clear = 0;
  for (let i = 0; i < n; i++) {
    const [px, , pz] = stack[i];
    // (in the depot the stack is approached from the door's side, facing +z; on the ground from the truck's side, facing +x)
    const yawPick = dock ? Math.PI : -Math.PI / 2;
    const ax = dock ? px : px - 3.2;
    const az = dock ? pz - 3.2 : pz;
    const nx = dock ? px : px - FORK_REACH;
    const nz = dock ? pz - FORK_REACH : pz;
    fork.wait(forkFree).go(ax, az, yawPick, SPEED.fork).go(nx, nz, yawPick, SPEED.fork * 0.5).lift(0.08);
    const pick = fork.last.t;
    fork.hold(i).lift(0.3).go(ax, az, yawPick, SPEED.back);
    // to the door, the forks up on the way, then in and down – once the pallet truck is out of the way
    const sz = staging[2] + FORK_REACH;
    fork.go(staging[0], sz + 2.4, 0, SPEED.fork).lift(dropH + 0.12).wait(clear).go(staging[0], sz, 0, SPEED.fork * 0.45).lift(dropH + 0.01).hold(-1);
    const drop = fork.last.t;
    fork.go(staging[0], sz + 2.6, 0, SPEED.back).lift(0.08);
    forkFree = fork.last.t;
    // the pallet truck: under the pallet, up, to its place in the box, down, back out of the way
    const [slx, slz] = slots[i];
    jack.wait(drop + 0.3).go(staging[0], staging[2] + side * 1.0, dir, SPEED.jack).go(staging[0], staging[2], dir, SPEED.jack * 0.6).lift(0.1);
    const take = jack.last.t;
    jack.hold(i).go(slx, slz, dir, SPEED.jack).lift(0.08).hold(-1);
    const placed = jack.last.t;
    jack.go(staging[0] * 0.5, staging[2] + side * 1.0, dir, SPEED.back).go(jackHome[0], jackHome[1], dir, SPEED.jack);
    clear = jack.last.t;
    pallets.push({ pick, drop, take, placed });
  }
  // the forklift parks
  fork.go(forkHome[0], forkHome[1], forkHome[2], SPEED.fork);
  let closing = Math.max(jack.last.t, fork.last.t) + 0.6;
  let end = closing + 2.4;
  // 30 to 60 seconds in all
  const k = end < 30 ? 30 / end : end > 60 ? 60 / end : 1;
  if (k !== 1) {
    for (const key of [...fork.keys, ...jack.keys]) key.t *= k;
    for (const p of pallets) {
      p.pick *= k;
      p.drop *= k;
      p.take *= k;
      p.placed *= k;
    }
    closing *= k;
    end *= k;
  }
  return { forklift: fork.keys, jack: jack.keys, pallets, stack, staging, slots, closing, end };
}

// ------------------------------------------------------------------ the models

const lam = (c: number): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color: c });
const MAT = {
  wall: lam(0xa9b7c4),
  plinth: lam(0x8e8b84),
  floor: lam(0x8f8d88),
  roof: lam(0x6f7378),
  black: lam(0x1d1f22),
  steel: lam(0x8d949b),
  yellow: lam(0xf2b705),
  orange: lam(0xe0661a),
  wood: lam(0xb08a5a),
  dark: lam(0x2a2d31),
  light: new THREE.MeshBasicMaterial({ color: 0xfff6dc }),
  stripe: lam(0x202020),
};
const GOODS = [lam(0xb98c5a), lam(0xe8e4d8), lam(0x2f62c4), lam(0x9a7b4f)];

function boxMesh(w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A pallet with its goods (its middle on the ground at the origin, the long side along z). */
function palletModel(p: PalletLoad): THREE.Group {
  const g = new THREE.Group();
  // the pallet: three runners and the deck
  for (const x of [-0.34, 0, 0.34]) g.add(boxMesh(0.1, 0.1, PALLET.len, x, 0, 0, MAT.wood));
  g.add(boxMesh(PALLET.wid, 0.044, PALLET.len, 0, 0.1, 0, MAT.wood));
  const h = p.height;
  const m = GOODS[p.kind % GOODS.length];
  if (p.kind === 2) {
    // drums
    for (const [x, z] of [
      [-0.2, -0.3],
      [0.2, -0.3],
      [-0.2, 0.3],
      [0.2, 0.3],
    ]) {
      const d = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, h, 12), m);
      d.position.set(x, PALLET.base + h / 2, z);
      d.castShadow = true;
      g.add(d);
    }
  } else g.add(boxMesh(PALLET.wid - 0.04, h, PALLET.len - 0.04, 0, PALLET.base, 0, m));
  return g;
}

/** A forklift: its forks along −z, the origin on the ground below its front axle; `forks` moves up and down. */
function forkliftModel(): { group: THREE.Group; carriage: THREE.Group } {
  const g = new THREE.Group();
  g.add(boxMesh(1.05, 0.75, 1.9, 0, 0.25, 0.75, MAT.yellow));
  g.add(boxMesh(1.05, 0.6, 0.5, 0, 0.6, 1.55, MAT.dark)); // the counterweight
  for (const [x, z] of [
    [-0.45, 0.05],
    [0.45, 0.05],
    [-0.45, 1.45],
    [0.45, 1.45],
  ])
    g.add(boxMesh(0.06, 1.25, 0.06, x, 1.0, z, MAT.dark)); // the guard's posts
  g.add(boxMesh(1.0, 0.06, 1.5, 0, 2.22, 0.75, MAT.dark));
  g.add(boxMesh(0.5, 0.12, 0.5, 0, 1.0, 0.95, MAT.black)); // the seat
  for (const [x, z, r] of [
    [-0.5, 0, 0.32],
    [0.5, 0, 0.32],
    [-0.48, 1.35, 0.26],
    [0.48, 1.35, 0.26],
  ]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.22, 14), MAT.black);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, r, z);
    g.add(w);
  }
  // the mast at the front
  for (const x of [-0.3, 0.3]) g.add(boxMesh(0.08, 2.3, 0.12, x, 0.05, -0.45, MAT.dark));
  const carriage = new THREE.Group();
  carriage.add(boxMesh(0.8, 0.5, 0.06, 0, 0, -0.55, MAT.dark));
  for (const x of [-0.2, 0.2]) carriage.add(boxMesh(0.1, 0.045, 1.15, x, 0, -0.55 - 0.575, MAT.steel));
  g.add(carriage);
  return { group: g, carriage };
}

/** A pallet truck: its forks along −z, its handle at the back (+z), the origin at the middle of the forks. */
function jackModel(): { group: THREE.Group; forks: THREE.Group } {
  const g = new THREE.Group();
  const forks = new THREE.Group();
  for (const x of [-0.18, 0.18]) forks.add(boxMesh(0.16, 0.07, 1.15, x, 0.0, 0, MAT.orange));
  forks.add(boxMesh(0.55, 0.32, 0.18, 0, 0.0, 0.66, MAT.orange));
  g.add(forks);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.1, 6), MAT.dark);
  handle.position.set(0, 0.75, 0.95);
  handle.rotation.x = -0.45;
  g.add(handle);
  const grip = boxMesh(0.32, 0.04, 0.04, 0, 1.24, 1.18, MAT.black);
  g.add(grip);
  return { group: g, forks };
}

/** The warehouse with its dock behind the truck: its wall at `wallZ`, 14 m wide, 11 m deep, its floor `floor` above the ground. */
function depotModel(wallZ: number, floor: number): THREE.Group {
  const g = new THREE.Group();
  const W = 14;
  const D = 11;
  const H = 7.2;
  const doorW = 2.9;
  const doorH = 3.0;
  const t = 0.25;
  // the front wall round the dock door, its plinth up to the floor
  const z = wallZ + t / 2;
  g.add(boxMesh(W, floor + 2.2, t, 0, -2.2, z, MAT.plinth));
  const side = (W - doorW) / 2;
  for (const s of [-1, 1]) g.add(boxMesh(side, H - floor, t, s * (doorW / 2 + side / 2), floor, z, MAT.wall));
  g.add(boxMesh(doorW, H - floor - doorH, t, 0, floor + doorH, z, MAT.wall));
  // the other walls, the roof and the floor inside
  for (const s of [-1, 1]) g.add(boxMesh(t, H + 2.2, D, s * (W / 2 - t / 2), -2.2, wallZ + D / 2, MAT.wall));
  g.add(boxMesh(W, H + 2.2, t, 0, -2.2, wallZ + D - t / 2, MAT.wall));
  g.add(boxMesh(W + 0.4, 0.35, D + 0.4, 0, H, wallZ + D / 2, MAT.roof));
  g.add(boxMesh(W - 2 * t, floor + 2.2, D - 2 * t, 0, -2.2, wallZ + D / 2, MAT.floor));
  // the dock: the leveller bridging the gap to the truck's floor, the shelter round the door, the bumpers
  g.add(boxMesh(2.0, 0.05, DOCK_GAP + 0.1, 0, floor - 0.05, wallZ - DOCK_GAP / 2 + 0.05, MAT.steel));
  for (const s of [-1, 1]) {
    g.add(boxMesh(0.25, floor - 0.1, DOCK_GAP - 0.15, s * 1.0, 0, wallZ - DOCK_GAP / 2, MAT.plinth));
    g.add(boxMesh(0.35, doorH + 0.4, 0.4, s * (doorW / 2 + 0.17), floor - 0.2, wallZ - 0.2, MAT.black));
    g.add(boxMesh(0.25, 0.3, 0.2, s * 1.35, floor - 0.45, wallZ - 0.1, MAT.black));
    // yellow and black at the dock's edge
    g.add(boxMesh(0.5, 0.1, 0.05, s * 0.7, floor - 0.12, wallZ - 0.01, MAT.yellow));
  }
  g.add(boxMesh(doorW + 0.7, 0.35, 0.4, 0, floor + doorH, wallZ - 0.2, MAT.black));
  // inside: racks along the side walls, lights under the roof
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const rz = wallZ + 2.5 + k * 2.8;
      for (const dz of [-1.2, 1.2]) g.add(boxMesh(0.08, 4.2, 0.08, s * 5.6, floor, rz + dz, MAT.orange));
      for (const y of [1.4, 2.8]) g.add(boxMesh(0.06, 0.1, 2.5, s * 5.6, floor + y, rz, MAT.orange));
      for (const y of [1.5, 2.9]) g.add(boxMesh(0.9, 0.9, 2.2, s * 5.6, floor + y, rz, GOODS[(k + (s > 0 ? 1 : 0)) % GOODS.length]));
    }
  }
  for (const lx of [-3.5, 3.5]) for (const lz of [2.5, 6.5]) g.add(boxMesh(1.2, 0.06, 0.3, lx, H - 0.08, wallZ + lz, MAT.light));
  // a sign over the door
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#1f5fa8';
  c.fillRect(0, 0, 256, 96);
  c.fillStyle = '#ffffff';
  c.font = '700 60px "Roboto Condensed", Arial, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('3', 128, 50);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.34), new THREE.MeshBasicMaterial({ map: tex }));
  sign.position.set(0, floor + doorH + 0.75, wallZ - 0.02);
  sign.rotation.y = Math.PI;
  g.add(sign);
  return g;
}

// ------------------------------------------------------------------ the scene

export interface ScenePose {
  /** the truck: its model origin (the ground below the middle of its wheelbase) and heading */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** a warehouse with a dock stands behind it (else the stack is on the ground) */
  dock: boolean;
}

export class LoadingScene {
  readonly group = new THREE.Group();
  readonly script: Script;
  readonly pose: ScenePose;
  readonly loads: readonly PalletLoad[];
  /** seconds into the scene */
  t = 0;
  private readonly body: BoxBody;
  private readonly people = new PeopleRenderer(4);
  private readonly poses: PersonPose[];
  private readonly pallets: THREE.Group[] = [];
  private readonly fork: { group: THREE.Group; carriage: THREE.Group };
  private readonly jack: { group: THREE.Group; forks: THREE.Group };
  private readonly k = { t: 0, x: 0, z: 0, yaw: 0, h: 0, carry: -1 };
  private readonly k2 = { t: 0, x: 0, z: 0, yaw: 0, h: 0, carry: -1 };
  /** where the dock's wall stands (truck frame), and the floor the forklift drives on */
  readonly wallZ: number;
  private readonly base: number;
  private walked = [0, 0];
  private readonly lastPos: Array<[number, number]> = [
    [0, 0],
    [0, 0],
  ];

  constructor(pose: ScenePose, body: BoxBody, loads: readonly PalletLoad[]) {
    this.pose = pose;
    this.body = body;
    this.loads = loads;
    const g = this.group;
    g.name = 'loading the truck';
    g.position.set(pose.x, pose.y, pose.z);
    g.rotation.y = pose.yaw;
    const inside = body.inside;
    const rear = inside.rear + 0.08;
    this.wallZ = rear + DOCK_GAP;
    const slots = palletSlots(inside, loads.length);
    this.script = schedule(slots.length, slots, rear, inside.floor, pose.dock, this.wallZ);
    this.base = pose.dock ? inside.floor : 0;
    if (pose.dock) g.add(depotModel(this.wallZ, inside.floor));
    for (let i = 0; i < slots.length; i++) {
      const p = palletModel(loads[i]);
      this.pallets.push(p);
      g.add(p);
    }
    this.fork = forkliftModel();
    this.jack = jackModel();
    g.add(this.fork.group, this.jack.group, this.people.group);
    // the forklift's driver, the worker with the pallet truck, the one with the papers
    const looks = [workerLook(9101, 'yellow'), workerLook(9102, 'orange'), workerLook(9103, 'yellow')];
    for (const L of looks) this.people.wear(L);
    this.poses = looks.map((L) => ({ x: 0, y: 0, z: 0, yaw: 0, walk: -1, look: L.id }));
    this.update(0);
  }

  /** How many pallets are in the box at the moment, of how many, and their weight. */
  get progress(): { loaded: number; total: number; mass: number } {
    let loaded = 0;
    let mass = 0;
    this.script.pallets.forEach((p, i) => {
      if (this.t >= p.placed) {
        loaded++;
        mass += this.loads[i].mass;
      }
    });
    return { loaded, total: this.script.pallets.length, mass };
  }

  get done(): boolean {
    return this.t >= this.script.end;
  }

  /** Jump to the doors closing. */
  skip(): void {
    this.t = Math.max(this.t, this.script.closing);
  }

  /** Show the moment `t` seconds further on. */
  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    const S = this.script;
    // the doors: open at the start, shut at the end
    const open = t < S.closing ? Math.min(1, t / 2) : Math.max(0, 1 - (t - S.closing) / 2);
    this.body.setDoors(open);
    // the forklift
    const f = at(S.forklift, t, this.k);
    this.fork.group.position.set(f.x, this.base, f.z);
    this.fork.group.rotation.y = f.yaw;
    this.fork.carriage.position.y = f.h;
    // the pallet truck
    const j = at(S.jack, t, this.k2);
    const jackBase = this.groundUnder(j.z);
    this.jack.group.position.set(j.x, jackBase, j.z);
    this.jack.group.rotation.y = j.yaw;
    this.jack.forks.position.y = j.carry >= 0 || j.h > 0.09 ? 0.1 : 0.03;
    // the pallets: in the stack, on the forks, at the door, on the pallet truck, in their place
    S.pallets.forEach((p, i) => {
      const m = this.pallets[i];
      if (t >= p.placed) {
        const [x, z] = S.slots[i];
        m.position.set(x, S.staging[1], z);
        m.rotation.y = 0;
      } else if (t >= p.take) {
        this.onJack(m);
      } else if (t >= p.drop) {
        m.position.set(S.staging[0], S.staging[1], S.staging[2]);
        m.rotation.y = 0;
      } else if (t >= p.pick) {
        this.onForks(m, f);
      } else {
        const [x, y, z] = S.stack[i];
        m.position.set(x, this.base + y, z);
        m.rotation.y = this.pose.dock ? 0 : Math.PI / 2;
      }
      m.visible = true;
    });
    // the people: the driver on the forklift's seat, the worker behind the pallet truck's handle, the one with the papers by the truck
    const [driver, worker, clerk] = this.poses;
    // (the seat lies 0.95 m behind the forklift's front axle: along its +z)
    driver.x = f.x + Math.sin(f.yaw) * 0.95;
    driver.z = f.z + Math.cos(f.yaw) * 0.95;
    driver.y = this.base + 1.12 - SEAT_HEIGHT;
    driver.yaw = f.yaw;
    driver.sit = true;
    driver.walk = -1;
    const js = Math.sin(j.yaw);
    const jc = Math.cos(j.yaw);
    worker.x = j.x + js * 1.45;
    worker.z = j.z + jc * 1.45;
    worker.y = this.groundUnder(worker.z);
    worker.yaw = j.yaw;
    worker.walk = this.walkOf(1, worker.x, worker.z);
    clerk.x = this.pose.dock ? -2.3 : 2.3;
    clerk.z = this.pose.dock ? this.wallZ + 1.3 : this.wallZ - DOCK_GAP + 1.0;
    clerk.y = this.pose.dock ? S.staging[1] : 0;
    clerk.yaw = headingOf(j.x - clerk.x, j.z - clerk.z);
    clerk.walk = -1;
    this.people.update(this.poses, t);
  }

  /** The floor the pallet truck and its worker are on: the box's – and the dock's, which has its height. */
  private groundUnder(_z: number): number {
    return this.script.staging[1];
  }

  /** How far a person has walked (for the gait), or −1 standing. */
  private walkOf(i: number, x: number, z: number): number {
    const [px, pz] = this.lastPos[i];
    const d = Math.hypot(x - px, z - pz);
    this.lastPos[i] = [x, z];
    if (d < 1e-3) return -1;
    this.walked[i] += d;
    return this.walked[i];
  }

  private onForks(m: THREE.Group, f: Key): void {
    const s = Math.sin(f.yaw);
    const c = Math.cos(f.yaw);
    m.position.set(f.x - s * FORK_REACH, this.base + f.h, f.z - c * FORK_REACH);
    m.rotation.y = f.yaw;
  }

  private onJack(m: THREE.Group): void {
    const j = this.k2;
    m.position.set(j.x, this.groundUnder(j.z) + 0.05, j.z);
    m.rotation.y = j.yaw;
  }

  /**
   * The camera: from the side while the doors open and close; while the
   * goods go in, from inside the warehouse looking out through the dock door
   * into the box (at the roadside: from behind the truck).  It drifts a
   * little all the while.
   */
  camera(cam: THREE.PerspectiveCamera, ground: (x: number, z: number) => number): void {
    const p = this.pose;
    const S = this.script;
    const t = this.t;
    const drift = Math.sin(t * 0.11) * 0.8;
    const rear = this.wallZ - DOCK_GAP;
    let eye: [number, number, number];
    let look: [number, number, number];
    if (t < 3.5 || t > S.closing) {
      eye = [-8.5, 3.2, rear - 1.5 + drift];
      look = [0, 1.6, rear + 0.3];
    } else if (p.dock) {
      eye = [-4.2 + drift, S.staging[1] + 2.7, this.wallZ + 5.8];
      look = [0.3, S.staging[1] + 0.8, this.wallZ - 1.6];
    } else {
      eye = [-4.8 + drift, 3.6, rear + 8.5];
      look = [0.6, 1.5, rear - 0.8];
    }
    const s = Math.sin(p.yaw);
    const c = Math.cos(p.yaw);
    // the truck's frame → the world
    const wx = p.x + eye[0] * c + eye[2] * s;
    const wz = p.z - eye[0] * s + eye[2] * c;
    const g = ground(wx, wz);
    cam.position.set(wx, Math.max(Number.isFinite(g) ? g + 1.2 : -Infinity, p.y + eye[1]), wz);
    cam.lookAt(p.x + look[0] * c + look[2] * s, p.y + look[1], p.z - look[0] * s + look[2] * c);
    cam.fov = 58;
    cam.near = 0.15;
  }

  dispose(): void {
    this.people.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mat = m.material as THREE.MeshBasicMaterial;
        if (mat.map) {
          mat.map.dispose();
          mat.dispose();
        }
      }
    });
    this.group.removeFromParent();
  }
}
