// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The articulated lorry ("Sattelzug") of class CE: a two-axle tractor unit
 * and a tri-axle semi-trailer of 13.6 m – together 16.5 m, the longest the
 * rules allow (§ 32 Abs. 4 StVZO) – and the three-axle rigid truck that
 * class C is learnt with.  (A tractor unit alone would be class C as well, but
 * nobody learns with one: it has no load to carry and brakes badly empty.)
 * Generic on purpose: no real model is reproduced.
 *
 * The semi-trailer hangs on the fifth wheel by its kingpin.  The fifth wheel
 * sits *over* the tractor's rear axle (a little ahead of it), not behind it as
 * a drawbar coupling does: the joint hardly swings out when the tractor turns,
 * and the trailer's axle group, 7.75 m behind the kingpin, follows on a much
 * tighter circle – it cuts corners more than a drawbar trailer does.  The
 * kinematics are the same two lines as the drawbar trailer's (sim/trailer.ts:
 * the axle group rolls but does not slip sideways) – only the joint is
 * elsewhere.  What is the semi-trailer's own:
 *
 *  - its weight rests partly on the fifth wheel (the kingpin load), and so on
 *    the tractor's rear axle – that is what gives a tractor unit its grip;
 *  - the trailer cannot swing round further than the tractor's cab and frame
 *    let it: at JACKKNIFE_LIMIT it stands against them (jack-knifed);
 *  - its landing gear (the support legs at the front) is wound down to stand
 *    it alone and up to drive; its spring brakes hold it while its parking
 *    brake is set or the supply line (red) is not connected.
 */
import type { DriverInput, Ground, Vehicle, VehicleSpec } from './vehicle/index.ts';
import { TRUCK } from './vehicle/index.ts';
import { Trailer } from './trailer.ts';
import type { TrailerSpec } from './trailer.ts';

export interface SemiTrailerSpec extends TrailerSpec {
  /** the share of its weight that rests on the fifth wheel (the rest on its axles) */
  kingpinShare: number;
  /** how many axles its axle group has (axleSpread apart) */
  axles: number;
  /** the landing gear: metres behind the kingpin */
  legsBehind: number;
  hitch: { behindRearAxle: number; height: number };
}

/** The fifth wheel of the tractor unit: 0.45 m ahead of its rear axle (negative: ahead), 1.15 m above the ground. */
export const FIFTH_WHEEL = { behindRearAxle: -0.45, height: 1.15 };

/**
 * A curtain-sider semi-trailer: 13.6 m long, 2.55 m wide, 4 m high, the
 * kingpin 1.6 m behind its front wall, a tri-axle 7.75 m behind the kingpin;
 * 8 t as driven (empty, with some ballast – the combination then has the
 * 15 t a test vehicle of class CE must have, Anlage 7 FeV 2.2.7).
 */
export const SEMI_TRAILER: SemiTrailerSpec = {
  mass: 8000,
  hitchToAxle: 7.75,
  // (the front wall stands ahead of the kingpin: a negative distance behind it)
  bodyFront: -1.6,
  length: 12.0,
  width: 2.55,
  height: 4.0,
  axleSpread: 1.31,
  track: 2.04,
  wheelRadius: 0.48,
  brake: 6.0,
  rollingResistance: 0.007,
  hitch: FIFTH_WHEEL,
  kingpinShare: 0.4,
  axles: 3,
  legsBehind: 2.3,
};

/** How far the trailer can swing round against the tractor before it stands against its cab and frame (rad, about 83°). */
export const JACKKNIFE_LIMIT = 1.45;
/** how fast the landing gear is wound up or down (share of its travel per second – the driver cranks it in a few seconds) */
const LEG_RATE = 0.5;

/**
 * The tractor unit: a two-axle 18-tonner with a long-distance cab, 330 kW
 * (450 PS) six, automated gearbox, rear-wheel drive; 7.6 t as driven, most
 * of it on the front axle until a trailer rests on the fifth wheel.  Its air
 * springs at the rear are stiff enough to carry the kingpin load.
 */
export const TRACTOR_UNIT: VehicleSpec = {
  ...TRUCK,
  name: 'Sattelzugmaschine 18 t, 330 kW, automatisiertes Getriebe',
  mass: 7600,
  inertia: [30000, 28000, 9000],
  wheelbase: 3.7,
  track: 2.04,
  cgHeight: 1.15,
  // 62 % of the weight on the front axle without a trailer
  cgToFront: 1.4,
  wheelRadius: 0.5,
  wheelInertia: 18,
  springRate: [230000, 420000],
  damperBump: [10000, 16000],
  damperRebound: [17000, 26000],
  antiRoll: [130000, 110000],
  // a 13 l six: its torque from just above idle, held to 1400 rpm
  torqueCurve: [
    [0, 500],
    [500, 1100],
    [600, 1500],
    [900, 2200],
    [1000, 2300],
    [1300, 2300],
    [1600, 2000],
    [1900, 1650],
    [2100, 1300],
    [2300, 0],
  ],
  idleRpm: 550,
  limiterRpm: 2100,
  stallRpm: 280,
  engineInertia: 1.8,
  engineFriction: [90, 0.08],
  gearRatios: [12.3, 8.6, 6.1, 4.4, 3.2, 2.3, 1.62, 1.18, 1.0, 0.78],
  reverseRatio: 11.5,
  finalDrive: 2.85,
  clutchTorque: 4200,
  brakeTorque: 44000,
  brakeBiasFront: 0.6,
  handbrakeTorque: 36000,
  maxWheelAngle: 0.7,
  dragArea: 6.4,
  length: 6.0,
  width: 2.5,
  bodyPoints: [
    [-1.25, 0.6, -3.1],
    [1.25, 0.6, -3.1],
    [-1.25, 0.6, 2.8],
    [1.25, 0.6, 2.8],
    [-1.2, 3.0, -3.05],
    [1.2, 3.0, -3.05],
    [-1.25, 3.85, -2.4],
    [1.25, 3.85, -2.4],
    [-1.25, 3.85, -0.85],
    [1.25, 3.85, -0.85],
  ],
  auto: { up: [1150, 1800], down: [800, 1150], kickdownRpm: 1600, lockOmega: 75, converter: 0.05 },
};

/**
 * The three-axle rigid truck of class C (6x2, 26 t gross): 12 t as driven,
 * the tractor's six at less power, a box body.  The physics know two axles:
 * the front one and, behind, one in the middle between the driven axle and
 * the tag axle (the tandem turns about that point).
 */
export const HEAVY_RIGID: VehicleSpec = {
  ...TRACTOR_UNIT,
  name: 'Lkw 26 t, drei Achsen, mit Kofferaufbau, 265 kW, automatisiertes Getriebe',
  mass: 12000,
  inertia: [78000, 75000, 16000],
  wheelbase: 5.2,
  cgHeight: 1.4,
  cgToFront: 2.6,
  springRate: [260000, 520000],
  damperBump: [11000, 19000],
  damperRebound: [19000, 31000],
  antiRoll: [140000, 120000],
  maxWheelAngle: 0.62,
  finalDrive: 3.1,
  dragArea: 6.6,
  length: 8.7,
  width: 2.5,
  bodyPoints: [
    [-1.25, 0.6, -4.0],
    [1.25, 0.6, -4.0],
    [-1.25, 0.6, 4.7],
    [1.25, 0.6, 4.7],
    [-1.2, 3.3, -3.95],
    [1.2, 3.3, -3.95],
    [-1.25, 3.8, -2.0],
    [1.25, 3.8, -2.0],
    [-1.25, 3.8, 4.7],
    [1.25, 3.8, 4.7],
  ],
};

/**
 * The tractor unit's outline from its model origin (the ground point below
 * the middle of its wheelbase): ahead to the bumper, behind to the end of the
 * frame, half its width – and the back wall of its cab, ahead of the origin.
 */
export const TRACTOR_OUTLINE = { front: 3.1, rear: 2.8, hw: 1.25, cabBack: 0.8 };
/** the fifth wheel's middle behind the tractor's model origin (m) */
export const FIFTH_WHEEL_AT = TRACTOR_UNIT.wheelbase / 2 + FIFTH_WHEEL.behindRearAxle;

/** Is this the spec of a semi-trailer (rather than a drawbar trailer)? */
export function isSemiSpec(t: TrailerSpec | null | undefined): t is SemiTrailerSpec {
  return !!t && 'kingpinShare' in t;
}

/**
 * Where the trailer's axle group runs when the joint goes round a circle of
 * radius `hitchRadius` for long enough: on a circle of this radius (the
 * swept path's inner edge comes from it).  The trailer then stands at
 * asin(L / R) to the joint's path.
 */
export function steadyAxleRadius(hitchRadius: number, hitchToAxle: number): number {
  return Math.sqrt(Math.max(0, hitchRadius * hitchRadius - hitchToAxle * hitchToAxle));
}

const G = 9.81;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class SemiTrailer extends Trailer {
  readonly semi: SemiTrailerSpec;
  /** the landing gear: wound down (target) and where it is (0 up … 1 on the ground) */
  legsDown = false;
  legs = 0;
  /** the lines to the tractor: supply (red) and brake (yellow) air, and the electrical cables */
  supply = true;
  control = true;
  cables = true;
  /** its own parking brake (the red knob at its side) is set */
  parkBrake = false;
  /** it stands against the tractor's cab and frame */
  jackknifed = false;
  /** … and has just come to do so (for one step) */
  jackknifeEvent = false;
  private readonly held: DriverInput = { steer: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 0, gear: 0, ignition: false, starter: false };

  constructor(spec: SemiTrailerSpec, ground: Ground) {
    super(spec, ground);
    this.semi = spec;
  }

  /** its spring brakes hold: parking brake set, or no supply air */
  get braked(): boolean {
    return this.parkBrake || !this.supply;
  }

  /** the weight on the fifth wheel (N), while coupled */
  get kingpinLoad(): number {
    return this.coupled ? this.semi.mass * G * this.semi.kingpinShare : 0;
  }

  override place(x: number, z: number, yaw: number): void {
    super.place(x, z, yaw);
    this.legsDown = true;
    this.legs = 1;
    this.parkBrake = true;
    this.supply = this.control = this.cables = false;
    this.jackknifed = false;
  }

  override coupleBehind(truck: Vehicle): void {
    super.coupleBehind(truck);
    this.legsDown = false;
    this.legs = 0;
    this.parkBrake = false;
    this.supply = this.control = this.cables = true;
    this.jackknifed = false;
  }

  override step(dt: number, truck: Vehicle, input: DriverInput): void {
    this.legs += clamp((this.legsDown ? 1 : 0) - this.legs, -LEG_RATE * dt, LEG_RATE * dt);
    this.jackknifeEvent = false;
    if (!this.coupled) return;
    // (its spring brakes: as if the brake pedal were held down)
    let inp = input;
    if (this.braked) {
      Object.assign(this.held, input);
      this.held.brake = 1;
      inp = this.held;
    }
    super.step(dt, truck, inp);

    // ---- it cannot swing round further than the cab and the frame let it
    const a = this.articulation;
    if (Math.abs(a) > JACKKNIFE_LIMIT) {
      const lim = Math.sign(a) * JACKKNIFE_LIMIT;
      const L = this.spec.hitchToAxle;
      // the trailer is pushed round about the kingpin to the limit
      this.yaw = truck.yaw - lim;
      this.x = this.hit[0] + Math.sin(this.yaw) * L;
      this.z = this.hit[2] + Math.cos(this.yaw) * L;
      this.settle(this.hit[1]);
      this.articulation = lim;
      if (!this.jackknifed) this.jackknifeEvent = true;
      this.jackknifed = true;
    } else if (Math.abs(a) < JACKKNIFE_LIMIT - 0.15) this.jackknifed = false;

    // ---- its weight on the fifth wheel, and so on the tractor's rear axle
    const load = this.kingpinLoad * Math.cos(this.pitch);
    truck.applyImpulse(this.hit[0], this.hit[1], this.hit[2], 0, -load * dt, 0);
  }
}

/** A trailer for a spec: the semi-trailer for a semi-trailer's, else the drawbar or box trailer. */
export function makeTrailer(spec: TrailerSpec, ground: Ground): Trailer {
  return isSemiSpec(spec) ? new SemiTrailer(spec, ground) : new Trailer(spec, ground);
}
