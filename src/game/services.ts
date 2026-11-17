// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What happens at a fuel station, in a car wash and at the depot – the
 * rules of it, without anything drawn (game/serviceworld.ts puts it into
 * the game, render/services.ts and render/loading.ts draw it):
 *
 *  - filling up: the nozzle goes into the filler, the fuel runs and the
 *    litres and the price count up until the tank is full or the driver
 *    stops it, the nozzle goes back.  It stops at once if the engine is
 *    started or the vehicle moves.
 *  - washing: the gantry's program – foam, brushes, rinsing, drying, each a
 *    pass over the car – takes the dirt off; it stops if the car moves.
 *  - roadside help: with the tank empty, a can of fuel is brought.
 *  - the dirt: it grows with the distance driven – faster on a wet road, on
 *    snow and slush, and much faster off the road.
 *  - the load of a truck: how many pallets and how heavy, and where in the
 *    box (for the physics: sim/payload.ts).
 *  - the depot: a place beside the road where a warehouse with a dock fits
 *    behind the truck.
 */
import { FillUp } from '../sim/fuel.ts';
import type { FuelTank } from '../sim/fuel.ts';
import type { Payload } from '../sim/payload.ts';

/** The vehicle as the services see it from one frame to the next. */
export interface StandState {
  /** standing: below 0.25 m/s */
  standing: boolean;
  engineOn: boolean;
}

// ------------------------------------------------------------------ filling up

/** How long the nozzle takes from its holster into the filler (and back), s. */
export const NOZZLE_TIME = 1.4;

/**
 * A fill-up as it goes: 'out' (the nozzle on its way into the filler),
 * 'run' (the fuel running), 'back' (the nozzle on its way back), 'done'.
 * `reason` says why the fuel stopped: 'full', 'stopped' (by the driver),
 * 'moved' or 'engine' (both: at once, the nozzle is pulled out).
 */
export class Refuelling {
  phase: 'out' | 'run' | 'back' | 'done' = 'out';
  /** seconds in the phase */
  t = 0;
  reason = '';
  readonly fill: FillUp;
  readonly fuel: string;

  constructor(fuel: string, price: number, flow: number) {
    this.fuel = fuel;
    this.fill = new FillUp(price, flow);
  }

  /** Where the nozzle is: 0 in its holster … 1 in the filler. */
  get nozzle(): number {
    if (this.phase === 'out') return Math.min(1, this.t / NOZZLE_TIME);
    if (this.phase === 'run') return 1;
    if (this.phase === 'back') return Math.max(0, 1 - this.t / NOZZLE_TIME);
    return 0;
  }

  /** The driver stops the pump (or something else does: `reason`). */
  stop(reason = 'stopped'): void {
    if (this.phase === 'out' || this.phase === 'run') {
      this.reason = reason;
      // (moved or started: the nozzle is out at once – in the game, it goes back as always)
      this.t = this.phase === 'out' ? NOZZLE_TIME - this.t : 0;
      this.phase = 'back';
    }
  }

  step(dt: number, tank: FuelTank, s: StandState): void {
    if (this.phase === 'done') return;
    if (this.phase === 'out' || this.phase === 'run') {
      if (s.engineOn) this.stop('engine');
      else if (!s.standing) this.stop('moved');
    }
    this.t += dt;
    if (this.phase === 'out' && this.t >= NOZZLE_TIME) {
      this.phase = 'run';
      this.t = 0;
    } else if (this.phase === 'run') {
      this.fill.step(dt, tank);
      if (this.fill.done) this.stop('full');
    } else if (this.phase === 'back' && this.t >= NOZZLE_TIME) {
      this.phase = 'done';
    }
  }

  get done(): boolean {
    return this.phase === 'done';
  }
}

// ------------------------------------------------------------------ washing

/** The program of the gantry: each step a pass from one end of the car to the other (−1 … 1; 1 is where it waits). */
export const WASH_STEPS: ReadonlyArray<{ id: 'foam' | 'brush' | 'rinse' | 'dry'; time: number; from: number; to: number; clean: number }> = [
  { id: 'foam', time: 9, from: 1, to: -1, clean: 0.15 },
  { id: 'brush', time: 13, from: -1, to: 1, clean: 0.65 },
  { id: 'rinse', time: 8, from: 1, to: -1, clean: 0.2 },
  { id: 'dry', time: 8, from: -1, to: 1, clean: 0 },
];

/** A wash as it goes, step by step; `aborted`: the car moved (the program stops where it is). */
export class Washing {
  step = 0;
  t = 0;
  aborted = false;
  /** the dirt when it began */
  readonly dirt0: number;

  constructor(dirt: number) {
    this.dirt0 = Math.max(0, Math.min(1, dirt));
  }

  get done(): boolean {
    return this.aborted || this.step >= WASH_STEPS.length;
  }

  /** The step under way ('' when done). */
  get stepId(): string {
    return WASH_STEPS[this.step]?.id ?? '';
  }

  /** Where the gantry is: −1 … 1 along the car (1 where it waits). */
  get at(): number {
    const s = WASH_STEPS[this.step];
    if (!s) return 1;
    const u = Math.min(1, this.t / s.time);
    const e = u * u * (3 - 2 * u);
    return s.from + (s.to - s.from) * e;
  }

  /** How far the whole program is (0 … 1). */
  get share(): number {
    let all = 0;
    let done = 0;
    WASH_STEPS.forEach((s, i) => {
      all += s.time;
      if (i < this.step) done += s.time;
      else if (i === this.step) done += Math.min(this.t, s.time);
    });
    return done / all;
  }

  /** The dirt left on the car now. */
  get dirt(): number {
    let left = 1;
    WASH_STEPS.forEach((s, i) => {
      const u = i < this.step ? 1 : i === this.step ? Math.min(1, this.t / s.time) : 0;
      left -= s.clean * u;
    });
    return this.dirt0 * Math.max(0, left);
  }

  update(dt: number, s: StandState): void {
    if (this.done) return;
    if (!s.standing) {
      this.aborted = true;
      return;
    }
    this.t += dt;
    const cur = WASH_STEPS[this.step];
    if (this.t >= cur.time) {
      this.t -= cur.time;
      this.step++;
      if (this.step >= WASH_STEPS.length) this.t = 0;
    }
  }
}

// ------------------------------------------------------------------ roadside help

/** How long the help takes to come with its can (s), and how much it brings (l). */
export const HELP = { time: 8, litres: 10 };

// ------------------------------------------------------------------ dirt

/**
 * How much dirtier a vehicle gets over `metres` (the level runs from 0 clean
 * to 1 filthy): a little on a dry road (some 40 km to half dirty), much
 * more on a wet one (`wet` 0 … 1: spray), on snow and slush (`snow` 0 … 1),
 * and most off the road (`offRoad`: the share of the wheels on grass or
 * earth – a couple of hundred metres across a field do it).
 */
export function dirtGrowth(metres: number, wet: number, offRoad: number, snow: number): number {
  const km = Math.max(0, metres) / 1000;
  return km * (0.012 + 0.09 * clamp01(wet) + 0.06 * clamp01(snow) + 1.6 * clamp01(offRoad));
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ------------------------------------------------------------------ where something is, seen from the driver's seat

/**
 * Which way a place lies from a vehicle, in eight parts of the circle: 0
 * ahead, 1 ahead on the right, 2 to the right, 3 behind on the right, 4
 * behind, 5 behind on the left, 6 to the left, 7 ahead on the left.
 */
export function bearingSector(x: number, z: number, yaw: number, tx: number, tz: number): number {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const dx = tx - x;
  const dz = tz - z;
  const ahead = dx * fx + dz * fz;
  // (right of the heading: the heading turned a quarter clockwise seen from above)
  const right = dx * -fz + dz * fx;
  const a = Math.atan2(right, ahead);
  return (Math.round(a / (Math.PI / 4)) + 8) % 8;
}

// ------------------------------------------------------------------ the load of a truck

/**
 * The kinds of truck that are loaded at the start of a drive: the 7.5-tonner
 * (C1) and the 12-tonner (C) on their own.  (With a trailer – C1E, CE – the
 * trailer is coupled right behind the box's doors: no forklift or dock gets
 * at them.)
 */
export const LOADED_KINDS: readonly string[] = ['lightTruck', 'truckSolo'];

/** A pallet to be loaded: how tall its goods stand, what they are (0 cartons, 1 sacks, 2 drums, 3 crates), its weight. */
export interface PalletPlan {
  height: number;
  kind: number;
  mass: number;
}

/** The inside of a truck's box as render/truck.ts builds it (truck frame: z back from the middle of the wheelbase). */
export function boxInside(wheelbase: number, width: number): { x0: number; x1: number; floor: number; front: number; rear: number } {
  const axle = wheelbase / 2;
  const hw = width / 2;
  const front = -(axle + 1.4) + 2.0;
  const rear = axle + 2.1;
  // (render/boxbody.ts: walls 5 cm, the frame round the door 8 cm, the floor 3 cm over the box's bottom)
  return { x0: -hw + 0.05, x1: hw - 0.05, floor: 1.15, front: front + 0.05, rear: rear - 0.08 };
}

/**
 * What a truck is loaded with: 4 to 6 pallets of 120 to 400 kg, within
 * what it may carry (`maxLoad` kg) – and the load for the physics: its
 * weight, and where it stands (the pallets fill the box from the front, two
 * side by side).  `rand`: numbers 0 … 1.
 */
export function planLoad(wheelbase: number, width: number, maxLoad: number, rand: () => number): { pallets: PalletPlan[]; payload: Payload } {
  const n = 4 + Math.min(2, Math.floor(rand() * 3));
  const pallets: PalletPlan[] = [];
  let mass = 0;
  for (let i = 0; i < n; i++) {
    const m = Math.min(Math.floor(maxLoad / n), Math.round(120 + rand() * 280));
    const kind = Math.floor(rand() * 4);
    pallets.push({ height: 0.8 + rand() * 0.55, kind, mass: m });
    mass += m;
  }
  const inside = boxInside(wheelbase, width);
  const rows = Math.ceil(n / 2);
  const len = rows * 1.25;
  const height = pallets.reduce((s, p) => s + p.height, 0) / n + 0.144;
  const payload: Payload = { mass, z: inside.front + 0.1 + len / 2, y: inside.floor + height / 2, len, wid: 1.7, hgt: height };
  return { pallets, payload };
}

// ------------------------------------------------------------------ the depot

/** What the depot search asks of the world. */
export interface DepotProbe {
  /** is a point on a road or a pavement? */
  road(x: number, z: number): boolean;
  /** would the truck, standing at (x, z) turned to yaw, touch anything (a building, a tree, a post)? */
  blocked(x: number, z: number, yaw: number): boolean;
  /** the ground at a point (NaN where nothing is loaded) */
  ground(x: number, z: number): number;
}

/** Where the truck stands at the depot: its model origin and heading – its rear to the warehouse, its front to the road. */
export interface DepotSpot {
  x: number;
  z: number;
  yaw: number;
}

/** The warehouse behind the truck: how far its wall stands behind the truck's rear (render/loading.ts DOCK_GAP), its width and depth. */
export const DEPOT = { gap: 1.7, wid: 14, dep: 11 };

/**
 * A place for the depot near where a truck stands in its lane (x, z, yaw;
 * `front`/`rear`: its length ahead of and behind its origin): beside the
 * road – on the right first, a little further along the road if need be –
 * the truck standing off the road with its nose 2 m from the road's edge,
 * the warehouse behind it.  The truck's place and the warehouse's must be
 * off the road, free of buildings, trees and posts, and the ground under
 * them no more than 1.1 m above or below the truck's – below the dock's
 * floor – (and not steep under the truck).  Null where there is no such place.
 */
export function findDepot(x: number, z: number, yaw: number, front: number, rear: number, probe: DepotProbe): DepotSpot | null {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = -fz;
  const rz = fx;
  for (const s of [0, 15, -15, 30, -30, 45, -45, 60]) {
    for (const side of [1, -1]) {
      const bx = x + fx * s;
      const bz = z + fz * s;
      // the road's edge on that side: the first of three metres off the road
      let edge = -1;
      for (let t = 2; t <= 22; t++) {
        let off = true;
        for (let k = 0; k < 3 && off; k++) if (probe.road(bx + rx * side * (t + k), bz + rz * side * (t + k))) off = false;
        if (off) {
          edge = t;
          break;
        }
      }
      if (edge < 0) continue;
      // the truck, facing the road: its front 2 m beyond the edge
      const nose = edge + 2;
      const ox = bx + rx * side * (nose + front);
      const oz = bz + rz * side * (nose + front);
      const tyaw = Math.atan2(rx * side, rz * side);
      // (along the truck, away from the road; across it)
      const ax = rx * side;
      const az = rz * side;
      const wall = nose + front + rear + DEPOT.gap;
      const y0 = probe.ground(ox, oz);
      if (Number.isNaN(y0)) continue;
      let ok = true;
      // off the road, and the ground not too far above or below
      for (let d = nose; d <= wall + DEPOT.dep && ok; d += 2) {
        const half = d < wall ? 2 : DEPOT.wid / 2;
        for (let w = -half; w <= half && ok; w += 2) {
          const px = bx + ax * d - az * w;
          const pz = bz + az * d + ax * w;
          if (probe.road(px, pz)) ok = false;
          const g = probe.ground(px, pz);
          if (Number.isNaN(g) || Math.abs(g - y0) > 1.1) ok = false;
        }
      }
      if (!ok) continue;
      // not steep under the truck
      const gf = probe.ground(bx + ax * nose, bz + az * nose);
      const gr = probe.ground(bx + ax * (wall - DEPOT.gap), bz + az * (wall - DEPOT.gap));
      if (Math.abs(gf - gr) > 0.07 * (front + rear)) continue;
      // nothing in the way: the truck itself, the way out to the road, and the warehouse (covered by trucks standing across it)
      if (probe.blocked(ox, oz, tyaw) || probe.blocked(ox + ax * -2, oz + az * -2, tyaw)) continue;
      for (const dd of [1.5, 4, 6.5, 9]) {
        for (const w of [-3.5, 3.5]) {
          const d = wall + dd;
          if (probe.blocked(bx + ax * d - az * w, bz + az * d + ax * w, tyaw + Math.PI / 2)) ok = false;
        }
      }
      if (ok) return { x: ox, z: oz, yaw: tyaw };
    }
  }
  return null;
}
