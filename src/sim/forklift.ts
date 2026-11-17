// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A counterbalance forklift (Gabelstapler) of 2.5 t – what it does, without
 * the drawing (render/forklift.ts) or the game round it (game/forkliftplay.ts):
 *
 *  - it is driven on its front wheels and steered with its rear wheels: it
 *    turns about a point on the line of its front axle, very tightly (78° of
 *    lock), and its rear swings out.  About 20 km/h at the most, a little
 *    less with a load; in tight turns the speed is held down, as modern
 *    forklifts do (curve speed control).  The model is kinematic – no tyre
 *    slip –, stopped dead by whatever it runs into;
 *  - the mast: the forks lifted (0 … 3.3 m), the mast tilted forwards (6°)
 *    or back (10°), the forks shifted sideways (± 10 cm);
 *  - the pallets: the forks slide into a pallet's openings when they are
 *    square to it, central and at the height of its openings; lifted, it
 *    goes up on them; lowered, it is set down on what is under it – the
 *    ground, the beams of a rack, the floor of a truck;
 *  - the load moment: the forklift stands on its front axle like a see-saw,
 *    the counterweight behind against the load ahead.  Too heavy, too far
 *    out, or braked hard with the load high – the rear wheels lift and it
 *    tips forwards.  Sideways it stands on three points (the front wheels
 *    and the pivot of the rear axle): turned hard, with the load high above,
 *    it tips onto its side.  Both are worked out as rotations about the
 *    tipping line, from the moments of the masses about it, so a short
 *    excess lifts a wheel and lets it fall back, a long one throws it over.
 *
 * World frame as everywhere: x east, y up, z south; yaw 0 faces north,
 * positive turns left; forward = (−sin yaw, −cos yaw).  The forklift's point
 * of reference is the ground below the middle of its wheelbase (as for every
 * vehicle of the game).  A pallet's long side runs along its own z.
 */
import { TRACTOR } from './vehicle/fleet.ts';
import type { VehicleSpec } from './vehicle/index.ts';

export const G = 9.81;
const DEG = Math.PI / 180;

/** The forklift's measures and masses (a generic diesel or electric counterbalance forklift of 2.5 t). */
export const FORKLIFT = {
  /** its own mass with the operator (kg) */
  mass: 3900,
  wheelbase: 1.65,
  /** half the front track (to the middle of the tyres) */
  halfTrack: 0.49,
  /** its centre of mass: behind the front axle, above the ground */
  cgBehind: 0.95,
  cgHeight: 0.8,
  /** what it may lift (kg) at the rated load centre (m from the forks' heel) */
  capacity: 2500,
  ratedCentre: 0.5,
  /** the forks' heel (the face of the carriage) ahead of the front axle, the mast upright */
  heelAhead: 0.47,
  forkLength: 1.15,
  /** the tines: half the distance between their middles, their width and thickness */
  forkHalfGap: 0.3,
  forkWidth: 0.12,
  forkThick: 0.045,
  /** the forks' top above the ground: lowered onto it, and at the most */
  liftMin: 0.045,
  liftMax: 3.3,
  /** lifting and lowering (m/s), tilting (rad/s), the side-shift (m/s, and its stroke) */
  liftSpeed: 0.5,
  lowerSpeed: 0.55,
  tiltForward: 6 * DEG,
  tiltBack: 10 * DEG,
  tiltRate: 4 * DEG,
  sideMax: 0.1,
  sideRate: 0.12,
  /** top speed empty and with a load (m/s), backwards */
  vmax: 5.6,
  vmaxLaden: 5.0,
  vReverse: 5.0,
  /** drive, service brake, rolling off with the pedal up (hydrostatic braking), m/s² */
  accel: 1.6,
  brake: 2.0,
  coast: 0.9,
  /** the rear wheels' lock (rad) and how fast it is wound on (rad/s) */
  maxSteer: 78 * DEG,
  steerRate: 1.4,
  /** the curve speed control: the lateral acceleration it holds the speed to in turns (m/s²) */
  curveLateral: 3.0,
  /** the relief valve: the hydraulics lift no more than this many times the capacity */
  relief: 1.6,
  /** the rear axle swings on its pivot until its stops: how much wider that makes the base sideways (m) */
  axleStops: 0.1,
  /** the body against walls and posts: circles along its axis (z, + = back) and their radius; its height */
  circles: [-0.7, 0.02, 0.7] as readonly number[],
  radius: 0.58,
  height: 2.2,
  /** pitch and roll at which it is past saving (rad) */
  tipForward: 0.6,
  tipSide: 0.5,
};
export type ForkliftSpec = typeof FORKLIFT;

/** Its vehicle spec for the rest of the game (the sound, the steering keys' lock, its measures) – it is not driven by sim/vehicle. */
export const FORKLIFT_SPEC: VehicleSpec = {
  ...TRACTOR,
  name: 'Gabelstapler 2,5 t',
  mass: FORKLIFT.mass,
  inertia: [3200, 3600, 2600],
  wheelbase: FORKLIFT.wheelbase,
  track: FORKLIFT.halfTrack * 2,
  cgHeight: FORKLIFT.cgHeight,
  cgToFront: FORKLIFT.cgBehind,
  wheelRadius: 0.33,
  wheelInertia: 4,
  // (what the steering keys and the touch bar go by – input/input.ts asks for less lock at speed the larger it is:
  // set so that, held down at full speed, they turn no harder than the curve speed control's lateral acceleration)
  maxWheelAngle: 2.6,
  steeringRatio: 6,
  length: 3.75,
  width: 1.16,
  rearDrive: false,
  bodyPoints: undefined,
};

// ---------------------------------------------------------------------------- the world

/** A box standing upright, turned about y: its middle, half its sides along its own x and z, its yaw, from y0 to y1. */
export interface OBox {
  x: number;
  z: number;
  hx: number;
  hz: number;
  yaw: number;
  y0: number;
  y1: number;
}

/** Something a pallet can be set down on: its top (an OBox's y1 is ignored), e.g. a rack's beams, a truck's floor. */
export interface Shelf extends OBox {
  id: string;
  /** the top a pallet stands on */
  y: number;
}

/** What a pallet is: its sides (len along its z, wid along its x), the pallet's height, the goods on it. */
export interface PalletDef {
  len: number;
  wid: number;
  base: number;
  goods: number;
  /** pallet and goods (kg) */
  mass: number;
  /** how the goods look (0 cartons, 1 sacks, 2 drums, 3 a crate) */
  kind: number;
}

/** A Euro pallet with goods of this height and mass. */
export function euroPallet(goods: number, mass: number, kind = 0): PalletDef {
  return { len: 1.2, wid: 0.8, base: 0.144, goods, mass, kind };
}

/** A pallet in the world: where its bottom's middle is, its yaw; on the forks: where on them. */
export interface Pallet {
  id: string;
  def: PalletDef;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** on the forks: its middle this far ahead of the heel and to the right of the forks' middle, turned so much against the forklift */
  fork: { d: number; s: number; yaw: number } | null;
  /** what it stands on (a shelf's id, 'ground') */
  on: string;
}

/** The mast leans about its foot this high above the ground (just ahead of the front axle). */
export const MAST_PIVOT = 0.35;

/** The deck's underside above the pallet's bottom: where the forks lift it. */
export const DECK = 0.1;

export interface ForkWorld {
  /** the ground's height */
  ground(x: number, z: number): number;
  obstacles: readonly OBox[];
  shelves: readonly Shelf[];
  pallets: Pallet[];
}

/** What the operator does: the pedals, the direction (1 forwards, −1 backwards, 0 none), the parking brake, the wheel, the mast's levers (−1 … 1). */
export interface ForkCommand {
  throttle: number;
  brake: number;
  dir: number;
  hold: boolean;
  steer: number;
  lift: number;
  tilt: number;
  shift: number;
}

/** What happened in a step. */
export interface ForkEvents {
  /** ran into something at this speed (m/s; 0: nothing) */
  hit: number;
  /** a pallet taken onto the forks (and how far the forks were in, 0 … 1), one set down */
  picked: Pallet | null;
  pickedDepth: number;
  placed: Pallet | null;
  /** the relief valve opened: too heavy to lift */
  relief: boolean;
  /** the rear wheels came off the ground / a front wheel lifted sideways */
  rearLift: boolean;
  sideLift: boolean;
  /** it went over now */
  tipped: boolean;
}

const newEvents = (): ForkEvents => ({ hit: 0, picked: null, pickedDepth: 0, placed: null, relief: false, rearLift: false, sideLift: false, tipped: false });

// ---------------------------------------------------------------------------- geometry

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const approach = (cur: number, target: number, step: number): number => (Math.abs(target - cur) <= step ? target : cur + Math.sign(target - cur) * step);

/** Is the point inside the box (in the plan)? */
export function inBox(b: OBox, x: number, z: number, margin = 0): boolean {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const dx = x - b.x;
  const dz = z - b.z;
  // (the world → the box's own frame: the inverse of x' = x cos + z sin, z' = −x sin + z cos)
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= b.hx + margin && Math.abs(lz) <= b.hz + margin;
}

/** Does a circle touch the box (in the plan)? */
export function circleBox(b: OBox, x: number, z: number, r: number): boolean {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const dx = x - b.x;
  const dz = z - b.z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const qx = clamp(lx, -b.hx, b.hx);
  const qz = clamp(lz, -b.hz, b.hz);
  return (lx - qx) ** 2 + (lz - qz) ** 2 < r * r;
}

/** Do two boxes overlap in the plan (separating axes)? */
export function boxBox(a: OBox, b: OBox): boolean {
  const axes = (o: OBox): Array<[number, number]> => {
    const c = Math.cos(o.yaw);
    const s = Math.sin(o.yaw);
    // (the box's x axis and z axis in the world)
    return [
      [c, -s],
      [s, c],
    ];
  };
  const project = (o: OBox, ax: [number, number]): [number, number] => {
    const [ox, oz] = axes(o);
    const mid = o.x * ax[0] + o.z * ax[1];
    const r = o.hx * Math.abs(ox[0] * ax[0] + ox[1] * ax[1]) + o.hz * Math.abs(oz[0] * ax[0] + oz[1] * ax[1]);
    return [mid - r, mid + r];
  };
  for (const ax of [...axes(a), ...axes(b)]) {
    const [a0, a1] = project(a, ax);
    const [b0, b1] = project(b, ax);
    if (a1 <= b0 + 1e-6 || b1 <= a0 + 1e-6) return false;
  }
  return true;
}

/** A pallet as a box (with its goods). */
export function palletBox(p: Pallet): OBox {
  return { x: p.x, z: p.z, hx: p.def.wid / 2, hz: p.def.len / 2, yaw: p.yaw, y0: p.y, y1: p.y + p.def.base + p.def.goods };
}

/** The forks' frame: the heel's middle (on the forks' top), forwards and to the right. */
export interface ForkFrame {
  hx: number;
  hz: number;
  top: number;
  fx: number;
  fz: number;
  rx: number;
  rz: number;
  tilt: number;
}

/** How a pallet lies on the forks: square to them, central, at the height of its openings – and how far they are in. */
export interface Engagement {
  /** the forks fit into its openings (they may be slid in or out, it may be lifted) */
  fits: boolean;
  /** how far the forks are in, of the pallet's depth along them (0 … 1) */
  depth: number;
  /** its middle ahead of the heel, and to the right */
  along: number;
  lateral: number;
  /** how far it is turned against the forks (rad, the nearer of its two axes) */
  misalign: number;
}

/** The forks against a pallet (standing on something, not on the forks). */
export function engagement(f: ForkFrame, p: Pallet, spec: ForkliftSpec = FORKLIFT): Engagement {
  const dx = p.x - f.hx;
  const dz = p.z - f.hz;
  const along = dx * f.fx + dz * f.fz;
  const lateral = dx * f.rx + dz * f.rz;
  // the pallet's own axes: z (its long side), x
  const zx = -Math.sin(p.yaw);
  const zz = -Math.cos(p.yaw);
  const dotZ = Math.abs(zx * f.fx + zz * f.fz);
  const dotX = Math.abs(zz * f.fx - zx * f.fz);
  const alongZ = dotZ >= dotX;
  const misalign = Math.acos(clamp(Math.max(dotZ, dotX), 0, 1));
  const D = alongZ ? p.def.len : p.def.wid;
  const pen = clamp(spec.forkLength - (along - D / 2), 0, D);
  const depth = along - D / 2 > spec.forkLength ? 0 : pen / D;
  // (from the bottom boards up to the deck: lowered further, the tines go down between the runners)
  const height = f.top <= p.y + DECK + 0.03;
  const fits = misalign < 8 * DEG && Math.abs(lateral) < 0.12 && Math.abs(f.tilt) < 3.5 * DEG && height && along > D / 2 - 0.15;
  return { fits, depth, along, lateral, misalign };
}

/** The load chart: what may be lifted with its middle this far from the heel (kg). */
export function capacityAt(centre: number, spec: ForkliftSpec = FORKLIFT): number {
  return (spec.capacity * (spec.heelAhead + spec.ratedCentre)) / (spec.heelAhead + Math.max(spec.ratedCentre, centre));
}

/** What tips the forklift: the load's mass, its middle ahead of the front axle and its height (m), the deceleration (m/s², + = slowing down when going forwards) and the lateral acceleration (+ = outwards to the right). */
export interface Loading {
  mass: number;
  ahead: number;
  height: number;
  decel: number;
  lateral: number;
}

/**
 * How near it is to tipping, standing level: forwards (the moment about the
 * front axle that lifts the rear against the one that holds it down) and
 * sideways (over the line from a front wheel to the rear axle's pivot).
 * 1: the wheels lift.
 */
export function stability(l: Loading, spec: ForkliftSpec = FORKLIFT): { forward: number; side: number } {
  return { forward: pitchMoments(l, 0, spec).ratio, side: rollMoments(l, 0, spec).ratio };
}

function pitchMoments(l: Loading, p: number, spec: ForkliftSpec): { net: number; inertia: number; ratio: number } {
  const mt = spec.mass;
  const c = Math.cos(p);
  const s = Math.sin(p);
  const over = l.mass * G * (l.ahead * c + l.height * s) + l.decel * (l.mass * l.height + mt * spec.cgHeight) * c;
  const hold = mt * G * (spec.cgBehind * c - spec.cgHeight * s);
  const inertia = mt * (spec.cgBehind ** 2 + spec.cgHeight ** 2) + l.mass * (l.ahead ** 2 + l.height ** 2) + 1800;
  return { net: over - hold, inertia, ratio: hold > 0 ? over / hold : 9 };
}

function rollMoments(l: Loading, r: number, spec: ForkliftSpec): { net: number; inertia: number; ratio: number } {
  const mt = spec.mass;
  const M = mt + l.mass;
  const xc = (mt * spec.cgBehind - l.mass * l.ahead) / M;
  const yc = (mt * spec.cgHeight + l.mass * l.height) / M;
  const b = spec.halfTrack * (1 - clamp(xc / spec.wheelbase, 0, 1)) + spec.axleStops;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const over = M * Math.abs(l.lateral) * yc * c;
  const hold = M * G * (b * c - yc * s);
  return { net: over - hold, inertia: M * (b * b + yc * yc) + 1500, ratio: hold > 0 ? over / hold : 9 };
}

// ---------------------------------------------------------------------------- the forklift

export class Forklift {
  readonly spec: ForkliftSpec;
  /** the ground below the middle of the wheelbase, the heading */
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  /** speed (m/s, + forwards), the rear wheels' angle (rad, + = turning right) */
  v = 0;
  steer = 0;
  /** the forks' top above the ground, the mast's tilt (+ back), the side-shift (+ right) */
  lift: number;
  tilt = 0;
  side = 0;
  /** tipping: forwards (rad, the rear up) and sideways (rad, to the side `rollSide`: 1 right, −1 left) */
  pitch = 0;
  pitchV = 0;
  roll = 0;
  rollV = 0;
  rollSide = 1;
  tipped: 'forward' | 'side' | null = null;
  /** the accelerations of the last step: along (m/s²) and outwards (+ right) */
  aLong = 0;
  aLat = 0;
  /** the yaw rate (rad/s) */
  omega = 0;
  /** the pallet on the forks */
  load: Pallet | null = null;
  /** how far the wheels have rolled (m: front, rear) */
  rolled = [0, 0];
  readonly ev: ForkEvents = newEvents();

  constructor(spec: ForkliftSpec = FORKLIFT) {
    this.spec = spec;
    this.lift = spec.liftMin;
  }

  place(x: number, y: number, z: number, yaw: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.yaw = yaw;
    this.v = 0;
  }

  /** The forks' frame now (or for another pose). */
  forks(out: ForkFrame = { hx: 0, hz: 0, top: 0, fx: 0, fz: 0, rx: 0, rz: 0, tilt: 0 }, x = this.x, z = this.z, yaw = this.yaw, lift = this.lift, tilt = this.tilt, side = this.side): ForkFrame {
    const s = this.spec;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    // the mast leans about its foot near the front axle: tilted back, the carriage comes back with its height
    const heel = s.wheelbase / 2 + s.heelAhead - (lift - MAST_PIVOT) * Math.sin(tilt);
    out.hx = x + fx * heel + rx * side;
    out.hz = z + fz * heel + rz * side;
    out.top = this.y + lift;
    out.fx = fx;
    out.fz = fz;
    out.rx = rx;
    out.rz = rz;
    out.tilt = tilt;
    return out;
  }

  /** The load: its mass, its middle ahead of the front axle and above the ground. */
  loading(): Loading {
    const l = this.load;
    if (!l) return { mass: 0, ahead: 0, height: 0, decel: -this.aLong, lateral: this.aLat };
    const s = this.spec;
    const ahead = s.heelAhead - (this.lift - MAST_PIVOT + l.def.goods / 2) * Math.sin(this.tilt) + (l.fork?.d ?? 0.6);
    const height = this.lift - DECK + l.def.base + l.def.goods / 2;
    return { mass: l.def.mass, ahead, height, decel: -this.aLong, lateral: this.aLat };
  }

  /** The load's middle ahead of the heel (the load centre of the load chart); 0 without a load. */
  loadCentre(): number {
    return this.load?.fork?.d ?? 0;
  }

  /** How near to tipping it is now (1: the wheels lift). */
  stability(): { forward: number; side: number } {
    return stability(this.loading(), this.spec);
  }

  // ---------------------------------------------------------------------------- what it runs into

  private readonly ff: ForkFrame = { hx: 0, hz: 0, top: 0, fx: 0, fz: 0, rx: 0, rz: 0, tilt: 0 };

  /** Where the pallet on the forks is with the forks so. */
  private carry(p: Pallet, f: ForkFrame): void {
    const k = p.fork;
    if (!k) return;
    p.x = f.hx + f.fx * k.d + f.rx * k.s;
    p.z = f.hz + f.fz * k.d + f.rz * k.s;
    p.y = f.top - DECK;
    p.yaw = this.yaw + k.yaw;
  }

  /**
   * Everything the forklift touches now, by name: its body (circles), its
   * forks (points along the tines, not in the openings of a pallet they fit)
   * and the load on them – against the world's solids and the pallets.
   */
  touching(w: ForkWorld): Set<string> {
    const out = new Set<string>();
    const s = this.spec;
    const f = this.forks(this.ff);
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const yb0 = this.y + 0.05;
    const yb1 = this.y + s.height;
    const bodyHits = (b: OBox): boolean => {
      if (b.y1 <= yb0 || b.y0 >= yb1) return false;
      for (const c of s.circles) if (circleBox(b, this.x - fx * c, this.z - fz * c, s.radius)) return true;
      return false;
    };
    const forkHits = (b: OBox): boolean => {
      for (const side of [-s.forkHalfGap, s.forkHalfGap]) {
        for (const a of [0.12, 0.6, s.forkLength - 0.02]) {
          const top = f.top + a * Math.sin(this.tilt);
          if (b.y1 <= top - s.forkThick || b.y0 >= top) continue;
          if (inBox(b, f.hx + f.fx * a + f.rx * side, f.hz + f.fz * a + f.rz * side)) return true;
        }
      }
      return false;
    };
    const load = this.load ? palletBox(this.load) : null;
    const loadHits = (b: OBox): boolean => !!load && b.y1 > load.y0 + 0.01 && b.y0 < load.y1 && boxBox(load, b);
    w.obstacles.forEach((b, i) => {
      if (bodyHits(b) || forkHits(b) || loadHits(b)) out.add(`o${i}`);
    });
    for (const p of w.pallets) {
      if (p === this.load) continue;
      const b = palletBox(p);
      if (bodyHits(b) || loadHits(b) || (forkHits(b) && !engagement(f, p, s).fits)) out.add(p.id);
    }
    return out;
  }

  /** Something touched now that was not before. */
  private newContact(w: ForkWorld, before: Set<string>): boolean {
    for (const k of this.touching(w)) if (!before.has(k)) return true;
    return false;
  }

  /** What a pallet would be set down on where it is now: the highest top under its middle not above its bottom. */
  supportOf(p: Pallet, w: ForkWorld): { y: number; on: string } {
    let best = w.ground(p.x, p.z);
    let on = 'ground';
    for (const sh of w.shelves) {
      if (sh.y > p.y + 0.005 || sh.y <= best || !inBox(sh, p.x, p.z)) continue;
      best = sh.y;
      on = sh.id;
    }
    return { y: best, on };
  }

  // ---------------------------------------------------------------------------- a step

  step(dt: number, cmd: ForkCommand, w: ForkWorld): ForkEvents {
    const ev = this.ev;
    Object.assign(ev, newEvents());
    const s = this.spec;
    if (this.tipped) {
      // over it goes, until it lies
      this.v = approach(this.v, 0, dt * 6);
      const end = this.tipped === 'forward' ? 1.05 : Math.PI / 2 - 0.05;
      if (this.tipped === 'forward') {
        this.pitchV += dt * 6;
        this.pitch = Math.min(end, this.pitch + this.pitchV * dt);
      } else {
        this.rollV += dt * 6;
        this.roll = Math.min(end, this.roll + this.rollV * dt);
      }
      this.aLong = 0;
      this.aLat = 0;
      return ev;
    }
    const laden = this.load;
    // ---- the mast
    const before = this.touching(w);
    const lm = laden ? laden.def.mass : 0;
    let lift = cmd.lift;
    if (lift > 0 && laden && lm > s.relief * s.capacity) {
      lift = 0;
      ev.relief = true;
    }
    const liftRate = lift > 0 ? s.liftSpeed * (1 - 0.3 * Math.min(1, lm / s.capacity)) : s.lowerSpeed;
    const nl = clamp(this.lift + lift * liftRate * dt, s.liftMin, s.liftMax);
    const nt = clamp(this.tilt + cmd.tilt * s.tiltRate * dt, -s.tiltForward, s.tiltBack);
    const ns = clamp(this.side + cmd.shift * s.sideRate * dt, -s.sideMax, s.sideMax);
    const was = [this.lift, this.tilt, this.side];
    if (nl !== this.lift || nt !== this.tilt || ns !== this.side) {
      this.lift = nl;
      this.tilt = nt;
      this.side = ns;
      if (laden) this.carry(laden, this.forks(this.ff));
      // set down: lowered onto what is under it
      const held = laden?.fork ?? null;
      if (laden && nl < was[0]) {
        const sup = this.supportOf(laden, w);
        if (laden.y <= sup.y) {
          laden.y = sup.y;
          laden.on = sup.on;
          laden.fork = null;
          this.load = null;
          ev.placed = laden;
        }
      }
      if (this.newContact(w, before)) {
        // (blocked: the mast stays where it was, and the pallet, if one was just set down, is on the forks again)
        if (ev.placed) {
          this.load = ev.placed;
          this.load.fork = held;
          this.load.on = 'forks';
          ev.placed = null;
        }
        [this.lift, this.tilt, this.side] = was;
        if (this.load) this.carry(this.load, this.forks(this.ff));
      }
    }
    // ---- driving
    const v0 = this.v;
    const wheelsDown = this.pitch < 0.02;
    const want = clamp(cmd.steer, -1, 1) * s.maxSteer;
    this.steer = approach(this.steer, want, s.steerRate * dt);
    const tan = Math.tan(this.steer);
    const vmax = cmd.dir < 0 ? s.vReverse : this.load ? s.vmaxLaden : s.vmax;
    const vCurve = Math.sqrt((s.curveLateral * s.wheelbase) / Math.max(Math.abs(tan), 1e-3));
    const limit = Math.min(vmax, vCurve);
    let a = 0;
    const sv = Math.sign(this.v);
    if (cmd.hold) a = -sv * 2.5;
    else {
      if (cmd.dir !== 0 && cmd.throttle > 0.01 && wheelsDown) {
        if (Math.sign(cmd.dir) === sv || sv === 0) a += cmd.dir * cmd.throttle * s.accel * (Math.abs(this.v) < limit ? 1 : 0);
        else a += cmd.dir * cmd.throttle * s.brake;
      } else if (cmd.brake < 0.05) a -= sv * s.coast * (Math.abs(this.v) > 0.05 ? 1 : 0);
      a -= sv * cmd.brake * s.brake;
      // (held to the curve speed: the drive brakes)
      if (Math.abs(this.v) > limit + 0.05) a -= sv * 2;
    }
    let v = this.v + a * dt;
    // (braking stops it, it does not drive it backwards)
    if (sv !== 0 && Math.sign(v) !== sv && (cmd.dir === 0 || Math.sign(cmd.dir) === sv || cmd.hold || cmd.throttle <= 0.01)) v = 0;
    if (cmd.hold && Math.abs(v) < 0.3) v = 0;
    this.aLong = (v - v0) / dt;
    this.v = v;
    // about the front axle's middle: it goes straight on, the rear swings round it
    const omega = wheelsDown ? (-v * tan) / s.wheelbase : 0;
    const yaw1 = this.yaw + omega * dt;
    const mid = this.yaw + (omega * dt) / 2;
    const half = s.wheelbase / 2;
    const fxa = this.x - Math.sin(this.yaw) * half - Math.sin(mid) * v * dt;
    const fza = this.z - Math.cos(this.yaw) * half - Math.cos(mid) * v * dt;
    const nx = fxa + Math.sin(yaw1) * half;
    const nz = fza + Math.cos(yaw1) * half;
    const old = [this.x, this.z, this.yaw, this.y];
    if (Math.abs(v) > 1e-5 || Math.abs(omega) > 1e-5) {
      const before2 = this.touching(w);
      this.x = nx;
      this.z = nz;
      this.yaw = yaw1;
      const g = w.ground(nx, nz);
      if (Number.isFinite(g)) this.y = g;
      if (this.load) this.carry(this.load, this.forks(this.ff));
      if (this.newContact(w, before2)) {
        [this.x, this.z, this.yaw, this.y] = old;
        if (this.load) this.carry(this.load, this.forks(this.ff));
        ev.hit = Math.abs(v);
        this.v = 0;
      } else {
        this.rolled[0] += v * dt;
        this.rolled[1] += (v * dt) / Math.max(0.2, Math.cos(this.steer));
      }
    }
    this.omega = omega;
    // the lateral acceleration (outwards, + to the right): the turn's centre lies on the front axle's line,
    // so across the forklift it is the front axle's speed times the yaw rate (the rest pulls along it)
    this.aLat = omega * v;
    // ---- pallets taken onto the forks
    if (!this.load) {
      const f = this.forks(this.ff);
      for (const p of w.pallets) {
        const e = engagement(f, p, s);
        if (!e.fits || e.depth < 0.5 || f.top < p.y + DECK - 1e-4) continue;
        p.fork = { d: e.along, s: e.lateral, yaw: p.yaw - this.yaw };
        p.on = 'forks';
        this.load = p;
        this.carry(p, f);
        ev.picked = p;
        ev.pickedDepth = e.depth;
        break;
      }
    }
    // ---- tipping
    this.tip(dt, ev);
    return ev;
  }

  /** The rotations about the tipping lines: forwards about the front axle, sideways about the stability triangle's side. */
  private tip(dt: number, ev: ForkEvents): void {
    const s = this.spec;
    const l = this.loading();
    // a jolt (it was stopped by something) is short: what tips is the drive's and the brakes' deceleration
    l.decel = clamp(l.decel, -4, 4);
    const pm = pitchMoments(l, this.pitch, s);
    const wasUp = this.pitch > 0.01;
    if (this.pitch <= 0 && pm.net <= 0) {
      this.pitch = 0;
      this.pitchV = 0;
    } else {
      this.pitchV += (pm.net / pm.inertia) * dt;
      this.pitchV *= 1 - Math.min(0.5, dt * 0.8);
      this.pitch += this.pitchV * dt;
      if (this.pitch < 0) {
        this.pitch = 0;
        this.pitchV = 0;
      }
    }
    if (!wasUp && this.pitch > 0.01) ev.rearLift = true;
    // sideways: towards where it is thrown
    const want = Math.sign(this.aLat) || this.rollSide;
    if (this.roll <= 0) this.rollSide = want;
    const lat = { ...l, lateral: Math.sign(this.aLat) === this.rollSide ? this.aLat : 0 };
    const rm = rollMoments(lat, this.roll, s);
    const wasSide = this.roll > 0.01;
    if (this.roll <= 0 && rm.net <= 0) {
      this.roll = 0;
      this.rollV = 0;
    } else {
      this.rollV += (rm.net / rm.inertia) * dt;
      this.rollV *= 1 - Math.min(0.5, dt * 0.8);
      this.roll += this.rollV * dt;
      if (this.roll < 0) {
        this.roll = 0;
        this.rollV = 0;
      }
    }
    if (!wasSide && this.roll > 0.01) ev.sideLift = true;
    if (this.pitch > s.tipForward) {
      this.tipped = 'forward';
      ev.tipped = true;
    } else if (this.roll > s.tipSide) {
      this.tipped = 'side';
      ev.tipped = true;
    }
    if (ev.tipped && this.load) {
      // the load falls off
      const p = this.load;
      p.fork = null;
      p.on = 'ground';
      p.y = this.y;
      this.load = null;
    }
  }
}
