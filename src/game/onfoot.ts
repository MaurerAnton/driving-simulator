// SPDX-License-Identifier: AGPL-3.0-only
/**
 * On foot, beside the vehicle: before the drive (with the start "beside the
 * vehicle") or after getting out – or without any vehicle, as a pedestrian
 * in the town (then nothing holds one near anything).
 *
 * Whoever drives off has looked at the vehicle first – the check before the
 * drive (Abfahrtkontrolle: part of the test for the classes C and CE, and
 * what every driver is responsible for, § 23 Abs. 1 StVO): the tyres, the
 * lights at the front and at the back, with a trailer the coupling.  Here
 * that is done by walking round the vehicle and looking at each of them for
 * a moment; rings on the ground show where.  Then to the driver's door: open
 * it, sit in, close it – and drive.
 *
 * Walking: forwards and back, turning, looking about – with the keys, the
 * pedals and the steering bar on the screen, a gamepad, the mouse or a
 * finger.  Never through the vehicle, a wall or a post, and not further
 * than a few dozen metres from the vehicle.
 */
import * as THREE from 'three';

export type CheckId = 'tyres' | 'front' | 'rear' | 'coupling';
export const CHECK_ORDER: readonly CheckId[] = ['tyres', 'front', 'rear', 'coupling'];

/** One thing to look at: a point on the vehicle, and from how near it is seen. */
export interface CheckSpot {
  id: CheckId;
  x: number;
  y: number;
  z: number;
  /** where its ring lies on the ground: beside the vehicle, where one stands to look */
  rx: number;
  rz: number;
  reach: number;
  /** seconds it has been looked at; done once that was long enough */
  seen: number;
  done: boolean;
}

/** A part of the vehicle in the plan: its model origin, heading and outline. */
export interface WalkUnit {
  x: number;
  z: number;
  yaw: number;
  /** metres ahead of the origin to the front, behind it to the rear, half the width */
  front: number;
  rear: number;
  hw: number;
  /** the axles: metres ahead (+) of or behind (−) the origin, and half the track over the tyres */
  axles: readonly number[];
  track: number;
}

/** The vehicle as somebody on foot meets it. */
export interface WalkVehicle {
  /** the vehicle itself and, if there is one, the trailer behind it */
  units: WalkUnit[];
  y: number;
  /** how far ahead of the origin of the first unit the driver's door is, and on which side (−1 left, the default; 1 right: a bus) */
  door: number;
  doorSide?: number;
  /** the coupling (world), with a trailer */
  hitch: { x: number; y: number; z: number } | null;
}

/** eye height (m) */
export const EYE = 1.62;
const RADIUS = 0.28;
/** walking pace (m/s) */
export const WALK = 1.45;
/** running, unless the settings say otherwise (m/s: 12 km/h) */
export const RUN = 3.3;
/** from this far away the vehicle is behind one (m): the world loads round the person, the hint says how far it is */
export const TETHER = 60;
/** how long something has to be looked at (s) */
const LOOK = 0.45;

/** A point `ahead` metres ahead of and `right` metres to the right of a unit's origin. */
function at(u: { x: number; z: number; yaw: number }, ahead: number, right: number): { x: number; z: number } {
  const s = Math.sin(u.yaw);
  const c = Math.cos(u.yaw);
  return { x: u.x - s * ahead + c * right, z: u.z - c * ahead - s * right };
}

/** What there is to check on a vehicle: every tyre, the lights at the front and at the very back, the coupling. */
export function checkSpots(v: WalkVehicle): CheckSpot[] {
  const out: CheckSpot[] = [];
  const add = (id: CheckId, u: WalkUnit, ahead: number, right: number, y: number, reach: number, ringAhead: number, ringRight: number): void => {
    const p = at(u, ahead, right);
    const r = at(u, ringAhead, ringRight);
    out.push({ id, x: p.x, y: v.y + y, z: p.z, rx: r.x, rz: r.z, reach, seen: 0, done: false });
  };
  v.units.forEach((u, i) => {
    // (a tandem axle is looked at as one: the tyres stand close together)
    const axles: number[] = [];
    for (const a of u.axles) if (!axles.some((b) => Math.abs(b - a) < 1.6)) axles.push(a);
    for (const a of axles) {
      const mid = u.axles.filter((b) => Math.abs(b - a) < 1.6).reduce((s, b, _, all) => s + b / all.length, 0);
      for (const side of [-1, 1]) add('tyres', u, mid, side * u.track, 0.35, 2.3, mid, side * (u.hw + 0.75));
    }
    if (i === 0) add('front', u, u.front, 0, 0.7, 2.8, u.front + 0.9, 0);
    if (i === v.units.length - 1) add('rear', u, -u.rear, 0, 0.85, 2.8, -u.rear - 0.9, 0);
  });
  if (v.hitch && v.units.length > 1) {
    // the coupling is between the two: seen from beside it
    const u = v.units[0];
    const rel = { x: v.hitch.x, z: v.hitch.z, yaw: u.yaw };
    const ring = at(rel, 0, -(u.hw + 0.7));
    out.push({ id: 'coupling', x: v.hitch.x, y: v.hitch.y, z: v.hitch.z, rx: ring.x, rz: ring.z, reach: 3.4, seen: 0, done: false });
  }
  return out;
}

/** Inside a unit's outline (grown by `margin`)? */
function inside(u: WalkUnit, x: number, z: number, margin: number): boolean {
  const s = Math.sin(u.yaw);
  const c = Math.cos(u.yaw);
  const dx = x - u.x;
  const dz = z - u.z;
  const ahead = -dx * s - dz * c;
  const right = dx * c - dz * s;
  return ahead < u.front + margin && ahead > -u.rear - margin && Math.abs(right) < u.hw + margin;
}

export interface WalkMove {
  fwd: number;
  turn: number;
  run: boolean;
  /** a step to the right (+) or left, −1 … 1 (game/walkmodes.ts: the classic way of walking) */
  side?: number;
}

export interface WalkLook {
  yaw: number;
  pitch: number;
  /** moving sideways and forwards by dragging with two fingers (in "views": about four metres each) */
  right: number;
  fwd: number;
}

export class OnFoot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch = -0.12;
  readonly spots: CheckSpot[];
  private readonly vehicle: WalkVehicle | null;
  private walked = 0;
  /** too far from the vehicle a moment ago */
  tooFar = false;
  /** how fast running is (m/s) – the settings say */
  runSpeed = RUN;
  /** the speed of the last step (m/s), and whether it was run */
  speed = 0;
  running = false;
  /** metres walked in all (for the gait of the figure) */
  distance = 0;

  /**
   * Beside the driver's door of `vehicle`, looking along it – or, without a
   * vehicle, at `start`.
   */
  constructor(vehicle: WalkVehicle | null, start?: { x: number; y: number; z: number; yaw: number }) {
    this.vehicle = vehicle;
    this.spots = vehicle ? checkSpots(vehicle) : [];
    if (vehicle) {
      const p = this.doorSpot();
      this.x = p.x;
      this.z = p.z;
      this.y = vehicle.y;
      this.yaw = vehicle.units[0].yaw + 0.35;
    } else {
      this.x = start?.x ?? 0;
      this.y = start?.y ?? 0;
      this.z = start?.z ?? 0;
      this.yaw = start?.yaw ?? 0;
    }
  }

  /** Where one stands to get in: beside the driver's door (where one stands, without a vehicle). */
  doorSpot(): { x: number; z: number } {
    const v = this.vehicle;
    if (!v) return { x: this.x, z: this.z };
    const u = v.units[0];
    return at(u, v.door, (v.doorSide ?? -1) * (u.hw + 0.6));
  }

  /** Close enough to the door to open it. */
  get atDoor(): boolean {
    if (!this.vehicle) return false;
    const p = this.doorSpot();
    return Math.hypot(this.x - p.x, this.z - p.z) < 1.3;
  }

  /** How many of each kind of thing there is to check, and how many are done. */
  progress(): Array<{ id: CheckId; done: number; of: number }> {
    const out: Array<{ id: CheckId; done: number; of: number }> = [];
    for (const id of CHECK_ORDER) {
      const list = this.spots.filter((s) => s.id === id);
      if (list.length) out.push({ id, done: list.filter((s) => s.done).length, of: list.length });
    }
    return out;
  }

  get allChecked(): boolean {
    return this.spots.every((s) => s.done);
  }

  /** The kinds of things not checked yet. */
  missing(): CheckId[] {
    return this.progress().filter((p) => p.done < p.of).map((p) => p.id);
  }

  /**
   * One step.  `ground(x, z, yRef)`: the height to stand on there,
   * `blocked(x, y, z, r)`: whether something stands there (a wall, a post).
   * Returns what changed: a step was taken (for its sound), something was
   * checked.
   */
  update(dt: number, move: WalkMove, look: WalkLook, ground: (x: number, z: number, yRef: number) => number, blocked: (x: number, y: number, z: number, r: number) => boolean): { step: boolean; checked: CheckSpot | null } {
    this.yaw += look.yaw + move.turn * 1.9 * dt;
    this.pitch = Math.max(-1.3, Math.min(1.1, this.pitch + look.pitch));
    const speed = move.run ? this.runSpeed : WALK;
    const x0 = this.x;
    const z0 = this.z;
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    // forwards = (−sin, −cos), to the right = (cos, −sin)
    // (forwards and sideways at once: no quicker than straight on)
    const side = move.side ?? 0;
    const norm = Math.max(1, Math.hypot(move.fwd, side));
    const ahead = (move.fwd / norm) * speed * dt + look.fwd * 4;
    const right = (side / norm) * speed * dt + look.right * 4;
    const dx = -s * ahead + c * right;
    const dz = -c * ahead - s * right;
    let step = false;
    if (dx !== 0 || dz !== 0) {
      // whole step, else along whatever is in the way (one axis at a time)
      const tries: Array<[number, number]> = [
        [dx, dz],
        [dx, 0],
        [0, dz],
      ];
      for (const [mx, mz] of tries) {
        if (mx === 0 && mz === 0) continue;
        const nx = this.x + mx;
        const nz = this.z + mz;
        const v = this.vehicle;
        if (v?.units.some((u) => inside(u, nx, nz, RADIUS))) continue;
        const ny = ground(nx, nz, this.y + 0.6);
        // (a step up of a kerb, not up a wall)
        if (!Number.isFinite(ny) || ny > this.y + 0.45 || blocked(nx, ny, nz, RADIUS)) continue;
        // (as far from the vehicle as one likes – the hint only says how far it is now)
        const u = v?.units[0];
        this.tooFar = !!u && Math.hypot(nx - u.x, nz - u.z) > TETHER;
        this.walked += Math.hypot(mx, mz);
        this.x = nx;
        this.z = nz;
        this.y = ny;
        break;
      }
      if (this.walked > (move.run ? 1.1 : 0.72)) {
        this.walked = 0;
        step = true;
      }
    }
    const moved = Math.hypot(this.x - x0, this.z - z0);
    this.distance += moved;
    this.speed = dt > 0 ? moved / dt : 0;
    this.running = move.run && this.speed > WALK * 1.2;
    // --- what is looked at ---
    let checked: CheckSpot | null = null;
    const cp = Math.cos(this.pitch);
    const fx = -s * cp;
    const fy = Math.sin(this.pitch);
    const fz = -c * cp;
    const ey = this.y + EYE;
    for (const sp of this.spots) {
      if (sp.done) continue;
      const hx = sp.x - this.x;
      const hz = sp.z - this.z;
      const hd = Math.hypot(hx, hz);
      const vy = sp.y - ey;
      const d = Math.hypot(hd, vy);
      const facing = (hx * fx + vy * fy + hz * fz) / Math.max(d, 1e-6);
      if (hd < sp.reach && facing > 0.82) {
        sp.seen += dt;
        if (sp.seen >= LOOK) {
          sp.done = true;
          checked = sp;
        }
      } else sp.seen = Math.max(0, sp.seen - dt);
    }
    return { step, checked };
  }
}

/** The rings on the ground that show what there is to look at: amber until it is checked, then green. */
export class CheckMarkers {
  readonly group = new THREE.Group();
  private readonly open = new THREE.MeshBasicMaterial({ color: 0xffb000, transparent: true, opacity: 0.9, depthWrite: false });
  private readonly done = new THREE.MeshBasicMaterial({ color: 0x2fd06a, transparent: true, opacity: 0.9, depthWrite: false });
  private readonly ring = new THREE.RingGeometry(0.2, 0.3, 28).rotateX(-Math.PI / 2);
  private meshes: THREE.Mesh[] = [];

  constructor() {
    this.group.name = 'check markers';
    this.group.visible = false;
  }

  /** Lay the rings for these spots; `ground(x, z)` is the height there. */
  show(spots: readonly CheckSpot[], ground: (x: number, z: number) => number): void {
    this.hide();
    for (const s of spots) {
      const m = new THREE.Mesh(this.ring, s.done ? this.done : this.open);
      const g = ground(s.rx, s.rz);
      m.position.set(s.rx, (Number.isFinite(g) ? g : s.y) + 0.035, s.rz);
      m.renderOrder = 2;
      this.meshes.push(m);
      this.group.add(m);
    }
    this.group.visible = true;
  }

  update(spots: readonly CheckSpot[]): void {
    spots.forEach((s, i) => {
      const m = this.meshes[i];
      if (m) m.material = s.done ? this.done : this.open;
    });
  }

  hide(): void {
    for (const m of this.meshes) this.group.remove(m);
    this.meshes = [];
    this.group.visible = false;
  }
}
