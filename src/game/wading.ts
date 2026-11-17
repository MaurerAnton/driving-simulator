// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Driving through water: rivers, lakes and ponds are cover WATER on the map
 * (world/cover.ts) – and here they get a depth, and what water does to a
 * vehicle driving in.
 *
 *  - The depth (WaterDepth): the farther in from the shore, the deeper –
 *    WATER_DROP at the very edge (the surface lies that far below the bank,
 *    render/water.ts), then a bank sloping down to DEEP_WATER.  How far a
 *    point is from the shore is found by looking round it on the cover map,
 *    on rings of growing radius; the answers are kept for the corners of a
 *    2 m grid and blended between them, so the bed has no steps.  WorldGround
 *    (sim/ground.ts) puts the wheels on that bed: the vehicle sinks into the
 *    water as far as it is deep.
 *  - The car gets washed: its dirt goes down while it drives through water,
 *    faster with speed and with depth (washRate).
 *  - The brakes get wet: for a while after, until braking has dried them,
 *    they brake less (brakeFactor) – a tip says so once.
 *  - Water up to the engine's air intake (intakeHeight): the engine stalls,
 *    and will not run while the water is that deep (a tip says why).
 *  - Splashes and spray from the wheels, more with speed, and the foam of a
 *    wake behind the vehicle (render/water.ts's WaterSpray) – not on the low
 *    graphics preset.
 * The pure parts (depth, rates, factors) are exported for the tests.
 */
import * as THREE from 'three';
import { COVER } from '../world/cover.ts';
import { WATER_DROP, WaterSpray } from '../render/water.ts';
import type { SprayParticle } from '../render/water.ts';

/** the deepest the water gets (m) – far enough from the shore */
export const DEEP_WATER = 1.8;
/** how the bed slopes down from the shore (m of depth per m from the shore) */
export const BANK_SLOPE = 0.22;
/** the rings looked at round a point for the shore (m) */
const RINGS = [1, 2, 3, 4.5, 6, 8] as const;
/** the grid the shore distances are kept for (m) */
const GRID = 2;

/** How deep the water is (m) at `shore` metres from the shore (0: at the very edge). */
export function bedDepth(shore: number): number {
  return Math.min(DEEP_WATER, WATER_DROP + BANK_SLOPE * Math.max(0, shore));
}

/**
 * How fast driving through water washes the dirt off (dirt 0 … 1 per
 * second) at `speed` m/s in water `depth` m deep: a little standing in it,
 * much more as the water rushes past – and the deeper, the more of the body
 * it reaches.
 */
export function washRate(speed: number, depth: number): number {
  if (!(depth > 0)) return 0;
  const v = Math.min(Math.abs(speed), 15);
  return (0.02 + 0.025 * v) * Math.min(1, 0.3 + depth / 0.4);
}

/** what is left of the brakes' force with wet discs (wet 0 … 1) */
export function brakeFactor(wet: number): number {
  return 1 - 0.35 * Math.min(1, Math.max(0, wet));
}

/** How fast the discs dry (wetness per second): slowly by themselves, quickly when braking while moving. */
export function dryRate(speed: number, brake: number): number {
  return 0.012 + 0.35 * Math.min(1, Math.max(0, brake)) * Math.min(1, Math.abs(speed) / 8);
}

/** Does water `depth` m deep wet the brakes, at `speed` m/s?  Up to the hubs – or less, splashing at speed. */
export function wetsBrakes(depth: number, speed: number): boolean {
  return depth > 0.28 || (depth > 0.05 && Math.abs(speed) > 2.5);
}

/** How high the engine draws its air (m above the ground): the water above it stalls the engine. */
export function intakeHeight(model: string): number {
  switch (model) {
    case 'motorcycle':
      return 0.45;
    case 'car':
      return 0.55;
    case 'minibus':
      return 0.65;
    case 'truckLight':
      return 0.75;
    case 'tractor':
      return 0.95;
    case 'truck':
    case 'truckHeavy':
    case 'semi':
    case 'bus':
    case 'mobileCrane':
    case 'loaderCrane':
      return 0.9;
    default:
      return 0.6;
  }
}

/** How many drops a wheel throws up per second at `speed` m/s in water `depth` m deep. */
export function sprayRate(speed: number, depth: number): number {
  const v = Math.abs(speed);
  if (!(depth > 0) || v < 0.4) return 0;
  return Math.min(90, (6 + 7 * v) * Math.min(1, 0.4 + depth / 0.25));
}

/** what of the terrain is needed: the cover class at a place (render/tiles.ts's TileManager fits) */
export interface CoverSource {
  coverAt(x: number, z: number): number;
}

/**
 * The water's depth at a place, from the cover map: 0 where it is not water.
 * Shore distances are kept for the corners of a 2 m grid (forgotten now and
 * then – tiles that were not loaded yet may have come since).
 */
export class WaterDepth {
  private readonly src: CoverSource;
  private readonly cache = new Map<number, number>();

  constructor(src: CoverSource) {
    this.src = src;
  }

  /** depth of the water (m) at x, z – 0 on land */
  at(x: number, z: number): number {
    if (this.src.coverAt(x, z) !== COVER.WATER) return 0;
    const gx = x / GRID;
    const gz = z / GRID;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const tx = gx - i;
    const tz = gz - j;
    const d00 = this.corner(i, j);
    const d10 = this.corner(i + 1, j);
    const d01 = this.corner(i, j + 1);
    const d11 = this.corner(i + 1, j + 1);
    const d = (d00 * (1 - tx) + d10 * tx) * (1 - tz) + (d01 * (1 - tx) + d11 * tx) * tz;
    return bedDepth(d);
  }

  /** Forget the shore distances (tiles were loaded or dropped). */
  clear(): void {
    this.cache.clear();
  }

  private corner(i: number, j: number): number {
    const key = (i + 1_000_000) * 2_000_003 + (j + 1_000_000);
    let d = this.cache.get(key);
    if (d === undefined) {
      if (this.cache.size > 20000) this.cache.clear();
      d = this.shore(i * GRID, j * GRID);
      this.cache.set(key, d);
    }
    return d;
  }

  /** how far (m) the shore is from x, z: the first ring that reaches land, less half a step; 0 on land */
  private shore(x: number, z: number): number {
    const src = this.src;
    if (src.coverAt(x, z) !== COVER.WATER) return 0;
    let prev = 0;
    for (const r of RINGS) {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        if (src.coverAt(x + Math.cos(a) * r, z + Math.sin(a) * r) !== COVER.WATER) return (prev + r) / 2;
      }
      prev = r;
    }
    return RINGS[RINGS.length - 1];
  }
}

/** what of the vehicle is needed (sim/vehicle's Vehicle fits) */
export interface WadingVehicle {
  readonly pos: ArrayLike<number>;
  readonly speed: number;
  readonly yaw: number;
  readonly engineRunning: boolean;
  readonly spec: { readonly wheelRadius: number };
  readonly wheels: ReadonlyArray<{ readonly hx: number; readonly hy: number; readonly hz: number; readonly contact: boolean }>;
  resetDrivetrain(engineRunning: boolean): void;
}

/** what happened in a step that the driver should be told: the i18n key of a tip */
export type WadingTip = 'waterStalled' | 'wetBrakes' | null;

/**
 * The player's vehicle in the water: once a frame, before the physics,
 * step() looks at the water under the wheels, washes, wets the brakes,
 * stalls the engine, throws up the spray.  `group` goes into the scene.
 */
export class Wading {
  readonly depth: WaterDepth;
  readonly spray = new WaterSpray(600);
  readonly group = new THREE.Group();
  /** the deepest water under a wheel now (m; 0: not in water) */
  depthNow = 0;
  /** how wet the brake discs are (0 … 1) */
  wet = 0;
  private wetTold = false;
  private clearT = 0;
  private wakeT = 0;
  private readonly carry = [0, 0, 0, 0];
  private readonly p: SprayParticle = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, size0: 0.1, size1: 0.3, floor: 0, foam: false };

  constructor(src: CoverSource) {
    this.depth = new WaterDepth(src);
    this.group.name = 'wading';
    this.group.add(this.spray.points);
  }

  /** what is left of the brakes now (multiply the brake pedal by it) */
  get brakeFactor(): number {
    return brakeFactor(this.wet);
  }

  /** A new drive, or the vehicle was put somewhere else: dry, no spray. */
  reset(): void {
    this.wet = 0;
    this.wetTold = false;
    this.depthNow = 0;
    this.spray.clear();
  }

  /**
   * One frame of `dt` seconds: `v` the vehicle (null: none in the water –
   * on foot, a tram, flying: the spray only settles), `model` its kind
   * (vehicles.ts's ModelKind), `car` what holds its dirt (serviceworld's
   * ServiceWorld), `brake` the brake pedal (0 … 1), `effects` the spray
   * drawn (not on the low preset), `light` how bright the day is (1: clear
   * noon).  Returns a tip to show, or null.
   */
  step(dt: number, v: WadingVehicle | null, model: string, car: { dirt: number }, brake: number, effects: boolean, light = 1): WadingTip {
    const h = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    this.clearT += h;
    if (this.clearT > 8) {
      this.clearT = 0;
      this.depth.clear();
    }
    let tip: WadingTip = null;
    let deepest = 0;
    let wetting = false;
    if (v) {
      const speed = v.speed;
      for (let i = 0; i < v.wheels.length && i < 4; i++) {
        const w = v.wheels[i];
        const d = this.depth.at(w.hx, w.hz);
        if (d > deepest) deepest = d;
        if (d > 0 && wetsBrakes(d, speed)) wetting = true;
        if (effects && d > 0 && w.contact) this.splash(i, v, w, d, h);
        else this.carry[i] = 0;
      }
      // washed – the more of the car in the water and the faster, the cleaner
      if (deepest > 0) car.dirt = Math.max(0, car.dirt - washRate(speed, deepest) * h);
      // the brakes: wet in the water, dried by braking
      if (wetting) {
        this.wet = 1;
        this.wetTold = false;
      } else if (this.wet > 0) {
        this.wet = Math.max(0, this.wet - dryRate(speed, brake) * h);
        if (!this.wetTold && deepest === 0 && this.wet > 0.6 && brake > 0.2 && Math.abs(speed) > 2) {
          this.wetTold = true;
          tip = 'wetBrakes';
        }
      }
      // water up to the air intake: the engine stalls (and stays dead while it is that deep)
      if (deepest > intakeHeight(model) && v.engineRunning) {
        v.resetDrivetrain(false);
        tip = 'waterStalled';
      }
      // the wake: foam spreading behind and beside the vehicle
      if (effects && deepest > 0.08 && Math.abs(speed) > 1) this.wake(v, deepest, h);
    }
    this.depthNow = deepest;
    this.spray.light = light;
    this.spray.update(h);
    return tip;
  }

  /** drops thrown up by wheel i (sideways and up, more and higher with speed) */
  private splash(i: number, v: WadingVehicle, w: WadingVehicle['wheels'][number], d: number, h: number): void {
    const speed = v.speed;
    this.carry[i] += sprayRate(speed, d) * h;
    if (this.carry[i] < 1) return;
    const sy = Math.sin(v.yaw);
    const cy = Math.cos(v.yaw);
    // forward (−sin yaw, −cos yaw); right (cos yaw, −sin yaw)
    const side = (w.hx - v.pos[0]) * cy - (w.hz - v.pos[2]) * sy >= 0 ? 1 : -1;
    const surface = w.hy - v.spec.wheelRadius + d;
    const sp = Math.min(Math.abs(speed), 25);
    const p = this.p;
    while (this.carry[i] >= 1) {
      this.carry[i] -= 1;
      const out = (0.6 + 0.12 * sp) * (0.4 + Math.random());
      const back = -Math.sign(speed) * sp * (0.15 + 0.25 * Math.random());
      p.x = w.hx + (Math.random() - 0.5) * 0.4;
      p.z = w.hz + (Math.random() - 0.5) * 0.4;
      p.y = surface + 0.02;
      // (the vehicle's own motion, a little of its speed backwards, outwards and up)
      p.vx = -sy * speed + cy * side * out - sy * back;
      p.vz = -cy * speed - sy * side * out - cy * back;
      p.vy = (1.2 + 0.18 * sp) * (0.5 + Math.random());
      p.age = 0;
      p.life = 0.7 + 0.6 * Math.random();
      p.size0 = 0.08 + 0.06 * Math.random();
      p.size1 = 0.25 + 0.02 * sp;
      p.floor = surface - 0.05;
      p.foam = false;
      this.spray.emit(p);
    }
  }

  /** foam lying on the water behind the vehicle, drifting outwards and spreading */
  private wake(v: WadingVehicle, d: number, h: number): void {
    const sp = Math.min(Math.abs(v.speed), 20);
    this.wakeT += h * (2 + 1.2 * sp);
    if (this.wakeT < 1) return;
    const sy = Math.sin(v.yaw);
    const cy = Math.cos(v.yaw);
    // the water's surface: the lowest wheel's ground plus the depth
    let bed = Infinity;
    for (let i = 0; i < v.wheels.length && i < 4; i++) bed = Math.min(bed, v.wheels[i].hy - v.spec.wheelRadius);
    if (!Number.isFinite(bed)) return;
    // (from behind the rear wheels – the front ones when reversing – at one side or the other)
    const ws = v.wheels;
    const a = ws.length >= 4 ? (v.speed >= 0 ? 2 : 0) : 0;
    const bx = ws.length >= 2 ? (ws[a].hx + ws[a + 1].hx) / 2 : v.pos[0];
    const bz = ws.length >= 2 ? (ws[a].hz + ws[a + 1].hz) / 2 : v.pos[2];
    const p = this.p;
    while (this.wakeT >= 1) {
      this.wakeT -= 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      const out = (0.3 + 0.08 * sp) * (0.6 + 0.8 * Math.random());
      const behind = -(0.4 + Math.random()) * Math.sign(v.speed || 1);
      p.x = bx - sy * behind + cy * side * 0.9;
      p.z = bz - cy * behind - sy * side * 0.9;
      p.y = bed + d + 0.03;
      p.vx = cy * side * out;
      p.vz = -sy * side * out;
      p.vy = 0;
      p.age = 0;
      p.life = 2 + Math.random();
      p.size0 = 0.5;
      p.size1 = 2.2 + 0.08 * sp;
      p.floor = -Infinity;
      p.foam = true;
      this.spray.emit(p);
    }
  }

  dispose(): void {
    this.spray.dispose();
  }
}
