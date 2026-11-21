// SPDX-License-Identifier: AGPL-3.0-only
/**
 * How the steering devices that are not a real steering wheel – the keys,
 * the steering bar on the screen and a gamepad's stick – move the vehicle's
 * steering wheel (input/input.ts).  A key is all or nothing and a finger on
 * the bar moves much faster than hands on a wheel, so the input layer winds
 * the lock on for the driver: no more than the vehicle can sensibly take at
 * this speed (a lateral acceleration, v²/r with r = wheelbase / angle), and
 * no faster than a driver's hands turn its steering wheel.
 *
 * A car is light, sits low and has a quick, light steering: a little over
 * a turn and a half from the middle to the stop, turned as fast as one
 * likes.  A heavy vehicle is different on both counts:
 *
 *  - its steering is slow (ratio ~20:1, two and a quarter turns from the
 *    middle to the stop on a tractor unit) and, even with power steering,
 *    is turned hand over hand at about one and a half turns a second;
 *  - its centre of mass is high – a lorry tips over at 3.5…4 m/s² of lateral
 *    acceleration, an articulated lorry's trailer sooner – so lorry drivers
 *    keep well under half of what a car driver uses: through a junction at
 *    15 km/h on a circle of 10…12 m, round a motorway bend at 1…1.5 m/s².
 *
 * Both are scaled with the vehicle's mass from a car's (unchanged: nothing
 * changes up to 3 t) to a lorry's (from 7.5 t on).  A real steering wheel
 * (a gamepad of kind 'wheel') is not shaped at all: the driver's hands are.
 */

/** What the shaping needs of a vehicle. */
export interface SteerSpec {
  mass: number;
  wheelbase: number;
  maxWheelAngle: number;
  steeringRatio: number;
}

/** The steering geometry and its shaping, as the input layer keeps it. */
export interface SteerFeel {
  wheelbase: number;
  maxWheelAngle: number;
  /** what of a car's lateral acceleration the shaping allows (1 a car … LORRY_LATERAL a lorry) */
  lateral: number;
  /** the fastest the steering input may move (share of the lock per second; Infinity: no limit) */
  rate: number;
  /**
   * how sharply the keys turn for a given speed (settings: steerSensitivity):
   * 1 the feel as built, 2 twice the lock at the same speed (sharper), 0.5 half
   * (gentler).  Scales the lock the keys ask for; the vehicle's own limits and
   * the lateral shaping still hold.
   */
  sens: number;
}

/** below this mass (kg) a vehicle steers like a car … */
const LIGHT = 3000;
/** … from this one on like a lorry */
const HEAVY = 7500;
/** what of a car's lateral acceleration a lorry is given */
export const LORRY_LATERAL = 0.42;
/** how fast the driver of a lorry turns its steering wheel (rad/s: about 1.4 turns a second) … */
export const LORRY_WHEEL_SPEED = (500 * Math.PI) / 180;
/** … and the driver of a vehicle just above LIGHT (rad/s) */
const LIGHT_WHEEL_SPEED = (1400 * Math.PI) / 180;

/** Lateral acceleration (m/s²) the steering keys of a car may ask for: brisk in town, gentle on the motorway. */
export const keyLateral = (v: number): number => 2.4 + 3.4 / (1 + (v / 15) * (v / 15));
/** … and what full deflection of a stick or of the steering bar asks for: close to what the tyres hold. */
export const ANALOG_LATERAL = 7;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const approach = (cur: number, target: number, maxStep: number): number => (Math.abs(target - cur) <= maxStep ? target : cur + Math.sign(target - cur) * maxStep);

/** 0 for a car, 1 for a lorry, smoothly between. */
export function heaviness(mass: number): number {
  const x = clamp((mass - LIGHT) / (HEAVY - LIGHT), 0, 1);
  return x * x * (3 - 2 * x);
}

/** The shaping for a vehicle (without one: the compact car's geometry, a car's feel). */
export function steerFeel(spec?: SteerSpec | null, wheelbase = 2.63, maxWheelAngle = 0.576, sens = 1): SteerFeel {
  if (!spec) return { wheelbase, maxWheelAngle, lateral: 1, rate: Infinity, sens };
  const h = heaviness(spec.mass);
  if (h <= 0)
    return {
      wheelbase: spec.wheelbase,
      maxWheelAngle: spec.maxWheelAngle,
      lateral: 1,
      rate: Infinity,
      sens,
    };
  // the steering wheel's angle from the middle to the stop (rad)
  const lock = Math.max(0.1, spec.maxWheelAngle * spec.steeringRatio);
  const wheelSpeed = LIGHT_WHEEL_SPEED + (LORRY_WHEEL_SPEED - LIGHT_WHEEL_SPEED) * h;
  return {
    wheelbase: spec.wheelbase,
    maxWheelAngle: spec.maxWheelAngle,
    lateral: 1 + (LORRY_LATERAL - 1) * h,
    rate: wheelSpeed / lock,
    sens,
  };
}

/**
 * How much of the steering lock an input may ask for at this speed so that
 * the vehicle turns with at most `lateral` m/s² (scaled by the feel).  Full
 * lock up to walking pace.
 */
export function lockFor(f: SteerFeel, lateral: number, speed: number): number {
  return clamp((lateral * f.lateral * f.wheelbase) / (Math.max(speed * speed, 1) * f.maxWheelAngle), 0.003, 1);
}

/** The steering bar or a stick: `want` −1 … +1 (already shaped), `quick` how many times the allowed lock per second it moves. */
export function analogSteer(f: SteerFeel, cur: number, want: number, speed: number, dt: number, quick: number): number {
  const limit = lockFor(f, ANALOG_LATERAL, Math.abs(speed));
  return approach(cur, want * limit, dt * Math.min(Math.max(quick * limit, 0.05), f.rate));
}

/**
 * The keys: `target` −1, 0, +1.  They ask for the lock that turns the vehicle
 * with a comfortable lateral acceleration at this speed – full lock at walking
 * pace, a fraction of a degree on the motorway – and wind it on within about
 * half a second (a lorry's slow steering takes longer).  Let go, the wheel
 * centres itself when the vehicle rolls and stays put when it stands.
 * `selfAlign` (−1 … 1) is the tyres' pull back to the middle.
 */
export function keySteer(f: SteerFeel, cur: number, target: number, speed: number, selfAlign: number, dt: number): number {
  const absSpeed = Math.abs(speed);
  // (the sensitivity scales how much lock the keys ask for at this speed; the
  //  lock itself is still capped at 1 – a sharper feel never asks past full lock)
  const limit = clamp(lockFor(f, keyLateral(absSpeed), absSpeed) * f.sens, 0.003, 1);
  if (target !== 0) {
    const rate = Math.min(limit * (1.2 + 1.3 * (1 - limit)), f.rate);
    // counter-steering is quicker than winding on more lock
    if (Math.sign(cur) === -target) cur = approach(cur, 0, dt * Math.min(Math.max(1.6 * limit, Math.abs(cur) * 4), f.rate * 1.3));
    return approach(cur, target * limit, dt * rate);
  }
  const centring = clamp(absSpeed / 6, 0, 1) * Math.max((1.4 + Math.abs(selfAlign) * 2.5) * Math.max(limit, 0.15), Math.abs(cur) * 3);
  return approach(cur, 0, dt * Math.min(centring, f.rate * 1.5));
}
