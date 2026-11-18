// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Public types of the vehicle dynamics model.
 *
 * Conventions
 *  - World: x = east, y = up, z = south (north is -Z), metres, right-handed.
 *  - Body:  +X = right, +Y = up, +Z = backward (forward is -Z); origin at the
 *    centre of mass.  The quaternion [x,y,z,w] maps body → world.
 *  - yaw: rotation about +Y; 0 faces north, positive turns LEFT.
 *  - steer input: +1 = steering wheel fully to the right.
 */

export interface GroundSample {
  /** surface height */
  y: number;
  /** unit surface normal */
  nx: number;
  ny: number;
  nz: number;
  /** friction multiplier: 1 dry asphalt … 0.4 wet grass */
  grip: number;
  /** rolling-resistance multiplier: 1 asphalt … 4 grass */
  rolling: number;
}

export interface Ground {
  /**
   * Surface under world (x, z).  `yRef` is the height of the querying wheel,
   * which lets the world choose between a bridge deck and the road below.
   */
  sample(x: number, z: number, yRef: number, out: GroundSample): void;
}

export interface DriverInput {
  /** -1 … +1, desired steering-wheel position (+ = right) */
  steer: number;
  throttle: number;
  brake: number;
  /** clutch pedal, 1 = fully pressed (disengaged) */
  clutch: number;
  handbrake: number;
  /** manual: -1 R, 0 N, 1…6.  automatic: -2 P, -1 R, 0 N, 1 D */
  gear: number;
  ignition: boolean;
  starter: boolean;
}

export interface WheelState {
  /** road-wheel steering angle (rad, + = right) */
  steer: number;
  /** accumulated rotation for rendering (rad) */
  spin: number;
  /** angular speed (rad/s, + = rolling forward) */
  omega: number;
  /** suspension compression from full droop (m) */
  compression: number;
  contact: boolean;
  /** normal load (N) */
  load: number;
  slipRatio: number;
  slipAngle: number;
  /** 0 … 1: how far the tyre is beyond its grip limit */
  skid: number;
  /** world position of the wheel centre */
  hx: number;
  hy: number;
  hz: number;
  /** grip multiplier of the surface under the wheel */
  grip: number;
}

export interface VehicleSpec {
  name: string;
  /** total mass incl. driver (kg) */
  mass: number;
  /** principal inertias about body X (pitch), Y (yaw), Z (roll) in kg·m² */
  inertia: [number, number, number];
  wheelbase: number;
  track: number;
  /** centre of mass: height above ground at rest, distance behind the front axle */
  cgHeight: number;
  cgToFront: number;
  wheelRadius: number;
  wheelInertia: number;

  // suspension, per wheel: [front, rear]
  springRate: [number, number];
  damperBump: [number, number];
  damperRebound: [number, number];
  antiRoll: [number, number];
  /** total wheel travel from full droop to the bump stop (m) */
  travel: number;

  // tyres
  muPeak: number;
  /** slip ratio and slip angle (rad) at peak grip on dry asphalt */
  slipRatioPeak: number;
  slipAnglePeak: number;
  loadSensitivity: number;
  relaxLong: number;
  relaxLat: number;
  rollingResistance: number;

  // engine
  /** [rpm, N·m] full-throttle torque curve */
  torqueCurve: Array<[number, number]>;
  idleRpm: number;
  limiterRpm: number;
  stallRpm: number;
  engineInertia: number;
  /** friction torque = a + b·rpm (N·m) */
  engineFriction: [number, number];

  // driveline
  transmission: 'manual' | 'automatic';
  /** forward ratios, index 0 = 1st gear */
  gearRatios: number[];
  reverseRatio: number;
  finalDrive: number;
  clutchTorque: number;
  /** share of the engine torque that reaches the wheels (gearbox + differential losses) */
  drivelineEfficiency: number;
  /** operate the clutch for the driver (manual gearbox) */
  autoClutch: boolean;

  // brakes
  /** total brake torque at full pedal (N·m, all four wheels) */
  brakeTorque: number;
  brakeBiasFront: number;
  handbrakeTorque: number;
  abs: boolean;

  // steering
  steeringRatio: number;
  maxWheelAngle: number;

  // aerodynamics: drag area Cd·A (m²)
  dragArea: number;

  // ---- what differs for a truck (a car leaves these out) ----
  /** the rear wheels are driven (default: the front wheels) */
  rearDrive?: boolean;
  /** outer length and width of the vehicle (m); default: a compact car */
  length?: number;
  width?: number;
  /**
   * Corners of the body shell relative to the point on the ground below the
   * middle of the wheelbase (x right, y up, z back) – what touches the ground
   * when the vehicle lies on its side or roof.  Default: a compact car.
   */
  bodyPoints?: ReadonlyArray<readonly [number, number, number]>;
  /**
   * The automatic gearbox: shift points as engine speed (rpm) at no and at
   * full throttle, up to which speed a kick-down shifts back, from which
   * speed of the gearbox input (rad/s) the converter locks up, and the
   * converter's capacity (N·m per (rad/s)²).  Default: a petrol car.
   */
  auto?: { up: [number, number]; down: [number, number]; kickdownRpm: number; lockOmega: number; converter: number };
  /**
   * The bump stop at the end of the travel, per wheel: its stiffness (N/m) and
   * its damping (N·s/m, acting both ways while it is pressed).  Default: a
   * car's – hard enough for 1.4 t, far too hard for a light machine, which it
   * would throw into the air off a kerb.
   */
  bumpStop?: { stiffness: number; damping: number };
}
