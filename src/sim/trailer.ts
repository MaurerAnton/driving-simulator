// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The trailer of the truck: a centre-axle trailer with a tandem axle on a
 * rigid drawbar ("Starrdeichselanhänger"), as it is used for training and
 * testing class CE.
 *
 * It has one joint – the coupling – and its wheels roll but do not slip
 * sideways: the axle group follows the coupling the way a real trailer does,
 * cutting corners when pulled and breaking out to one side when pushed.
 * That is the whole difficulty of reversing with it, and it comes out of two
 * lines of geometry (see step()).
 *
 * Its mass acts on the truck through the coupling: it has to be accelerated
 * and braked, it pulls downhill and its own brakes help.  The side force on
 * the coupling is left out (the truck does not feel the trailer in bends).
 */
import type { DriverInput, Ground, GroundSample, Vehicle } from './vehicle/index.ts';
import { TRUCK_HITCH } from './vehicle/index.ts';

export interface TrailerSpec {
  /** mass as driven (kg) */
  mass: number;
  /** from the coupling eye to the middle of the tandem axle (m) */
  hitchToAxle: number;
  /** from the coupling eye to the front wall of the body, and to the rear end (m) */
  bodyFront: number;
  length: number;
  width: number;
  height: number;
  /** distance between the two axles (m) */
  axleSpread: number;
  track: number;
  wheelRadius: number;
  /** deceleration its brakes give at full pedal (m/s²) */
  brake: number;
  rollingResistance: number;
  /** where the coupling sits on the towing vehicle: metres behind its rear axle, and above the ground (default: the truck's) */
  hitch?: { behindRearAxle: number; height: number };
}

/** 7.9 m from the coupling to the rear end, 2.5 m wide, 6 t as driven (10 t gross). */
export const TANDEM_TRAILER: TrailerSpec = {
  mass: 6000,
  hitchToAxle: 5.4,
  bodyFront: 1.5,
  length: 7.9,
  width: 2.5,
  height: 3.6,
  axleSpread: 1.3,
  track: 2.04,
  wheelRadius: 0.4,
  brake: 6.2,
  rollingResistance: 0.008,
};

/**
 * A tandem box trailer behind a car (class BE): 4.85 m from the coupling to
 * the rear end, 2.05 m wide, 1.4 t as driven, with an overrun brake.
 */
export const CAR_TRAILER: TrailerSpec = {
  mass: 1400,
  hitchToAxle: 3.1,
  bodyFront: 1.15,
  length: 4.85,
  width: 2.05,
  height: 2.1,
  axleSpread: 0.8,
  track: 1.75,
  wheelRadius: 0.3,
  brake: 5.5,
  rollingResistance: 0.012,
  hitch: { behindRearAxle: 0.95, height: 0.45 },
};

/** The outline of a trailer in the plan, from the middle of its axle group: ahead to its front, behind to its rear, half its width, ahead to the coupling. */
export function trailerOutline(t: TrailerSpec): { front: number; rear: number; hw: number; hitch: number } {
  return { front: t.hitchToAxle - t.bodyFront, rear: t.length - t.hitchToAxle, hw: t.width / 2, hitch: t.hitchToAxle };
}

const G = 9.81;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class Trailer {
  readonly spec: TrailerSpec;
  private readonly ground: Ground;
  /** the middle of the axle group on the ground */
  x = 0;
  y = 0;
  z = 0;
  /** heading (0 = north, positive = to the left) and slope (nose up positive) */
  yaw = 0;
  pitch = 0;
  /** the coupling eye at the tip of the drawbar */
  hitchX = 0;
  hitchY = 0;
  hitchZ = 0;
  /** speed along its own axis (m/s, forwards positive) */
  speed = 0;
  /** angle between truck and trailer (rad; 0 = in line, positive = the truck is turned to the left of the trailer) */
  articulation = 0;
  coupled = false;
  /** its own parking brake (spring brake): holds it when it stands alone */
  parked = true;
  /** how far the wheels have turned (rad), for the picture */
  wheelSpin = 0;
  private accel = 0;
  private readonly hit = [0, 0, 0];
  private readonly sample: GroundSample = { y: 0, nx: 0, ny: 1, nz: 0, grip: 1, rolling: 1 };

  constructor(spec: TrailerSpec, ground: Ground) {
    this.spec = spec;
    this.ground = ground;
  }

  /** how high the coupling is above the ground */
  get hitchHeight(): number {
    return (this.spec.hitch ?? TRUCK_HITCH).height;
  }

  /** Where the coupling of the towing vehicle is right now (world). */
  hitchPoint(v: Vehicle, out: number[]): void {
    const h = this.spec.hitch ?? TRUCK_HITCH;
    const mo = v.modelOrigin;
    v.toWorld(mo[0], mo[1] + h.height, mo[2] + v.spec.wheelbase / 2 + h.behindRearAxle, out);
  }

  /** Where the coupling of the truck is right now (world). */
  static truckHitch(truck: Vehicle, out: number[]): void {
    const mo = truck.modelOrigin;
    truck.toWorld(mo[0], mo[1] + TRUCK_HITCH.height, mo[2] + truck.spec.wheelbase / 2 + TRUCK_HITCH.behindRearAxle, out);
  }

  /** Stand the trailer somewhere by itself: axle group at (x, z), facing `yaw`. */
  place(x: number, z: number, yaw: number): void {
    this.coupled = false;
    this.parked = true;
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.speed = 0;
    this.accel = 0;
    this.settle();
  }

  /** Hang it on the truck, in line behind it. */
  coupleBehind(truck: Vehicle): void {
    this.hitchPoint(truck, this.hit);
    const L = this.spec.hitchToAxle;
    this.yaw = truck.yaw;
    this.x = this.hit[0] + Math.sin(truck.yaw) * L;
    this.z = this.hit[2] + Math.cos(truck.yaw) * L;
    this.coupled = true;
    this.parked = false;
    this.speed = truck.speed;
    this.accel = 0;
    this.articulation = 0;
    this.settle(this.hit[1]);
  }

  /** Couple where it stands (the truck has backed up to it). */
  couple(): void {
    this.coupled = true;
    this.accel = 0;
  }

  uncouple(): void {
    this.coupled = false;
    this.parked = true;
    this.speed = 0;
    this.settle();
  }

  /**
   * How far the truck's coupling is from the trailer's eye (m, on the
   * ground) and how far out of line the two stand (rad) – for backing up to
   * a trailer that stands alone.
   */
  offsetFrom(truck: Vehicle): { dist: number; angle: number } {
    this.hitchPoint(truck, this.hit);
    const d = Math.hypot(this.hit[0] - this.hitchX, this.hit[2] - this.hitchZ);
    let a = truck.yaw - this.yaw;
    a -= Math.PI * 2 * Math.round(a / (Math.PI * 2));
    return { dist: d, angle: a };
  }

  /** heights and the place of the coupling eye from where the axle group stands */
  private settle(hitchY?: number): void {
    const L = this.spec.hitchToAxle;
    this.ground.sample(this.x, this.z, this.y + 1, this.sample);
    this.y = this.sample.y;
    this.hitchX = this.x - Math.sin(this.yaw) * L;
    this.hitchZ = this.z - Math.cos(this.yaw) * L;
    if (hitchY === undefined) {
      // standing alone it rests on its support leg: level with the ground under the drawbar
      this.ground.sample(this.hitchX, this.hitchZ, this.y + 1, this.sample);
      hitchY = this.sample.y + this.hitchHeight;
    }
    this.hitchY = hitchY;
    this.pitch = Math.atan2(hitchY - this.hitchHeight - this.y, L);
  }

  /**
   * One step, after the truck has moved.  `input` is what the driver does
   * with the truck: the trailer brakes with the truck's brake pedal and
   * parking brake.
   */
  step(dt: number, truck: Vehicle, input: DriverInput): void {
    if (!this.coupled) return;
    const s = this.spec;
    const L = s.hitchToAxle;
    this.hitchPoint(truck, this.hit);
    const hx = this.hit[0];
    const hz = this.hit[2];
    // The axle group cannot move sideways.  So it moves along the line to the coupling: the
    // trailer points from where its axle group was to where the coupling is now, and the axle
    // group is the drawbar's length behind the coupling.
    let ux = hx - this.x;
    let uz = hz - this.z;
    const l = Math.hypot(ux, uz) || 1;
    ux /= l;
    uz /= l;
    const nx = hx - ux * L;
    const nz = hz - uz * L;
    const moved = (nx - this.x) * ux + (nz - this.z) * uz;
    this.x = nx;
    this.z = nz;
    this.yaw = Math.atan2(-ux, -uz);
    const v = moved / dt;
    // its inertia: what it takes to change its speed (smoothed – the truck feels it one step late)
    this.accel += (clamp((v - this.speed) / dt, -30, 30) - this.accel) * 0.25;
    this.speed = v;
    this.wheelSpin += moved / s.wheelRadius;
    this.settle(this.hit[1]);
    let a = truck.yaw - this.yaw;
    a -= Math.PI * 2 * Math.round(a / (Math.PI * 2));
    this.articulation = a;

    // ---- what the truck feels at the coupling, along the trailer's axis (forwards positive)
    this.ground.sample(this.x, this.z, this.y + 1, this.sample);
    // downhill force: the part of gravity along the axis (the ground normal leans the way it falls)
    const slope = this.sample.nx * ux + this.sample.nz * uz;
    let force = -s.mass * this.accel + s.mass * G * slope;
    const dirOfTravel = Math.abs(v) > 0.02 ? Math.sign(v) : 0;
    const braking = clamp(input.brake, 0, 1) * s.brake + (input.handbrake > 0.5 ? s.brake * 0.6 : 0);
    const resist = s.mass * (G * s.rollingResistance * this.sample.rolling + braking);
    if (dirOfTravel !== 0) force -= dirOfTravel * resist;
    else {
      // standing: brakes and rolling resistance hold against what pushes, up to what they can
      force -= clamp(force, -resist, resist);
    }
    truck.applyImpulse(hx, this.hit[1], hz, ux * force * dt, 0, uz * force * dt);
  }
}
