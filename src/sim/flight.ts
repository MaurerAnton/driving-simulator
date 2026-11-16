// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Flight dynamics of the light aeroplane (sim/flightspec.ts): a 6-DOF rigid
 * body under aerodynamic, propeller, gravity and landing-gear forces.
 *
 *  - Aerodynamics: whole-aircraft coefficients in the classic stability-
 *    derivative form (lift, drag and side force; pitching, rolling and yawing
 *    moments), of the size published for two-seat high-wing trainers.  The
 *    lift curve rounds off below the critical angle and falls gently past it
 *    towards that of a flat plate, so the aeroplane is defined at any angle
 *    of attack and sideslip – tumbling, flying backwards – not only in normal
 *    flight.  Near the ground the induced drag drops (ground effect).
 *  - Atmosphere: ISA density with height; an optional wind.
 *  - Engine and fixed-pitch propeller: the rpm follows the balance of engine
 *    torque and propeller load, thrust falls with airspeed (thrust and power
 *    coefficients over the advance ratio); with the engine off the propeller
 *    windmills, or stops when the air is too slow to turn it.
 *  - Landing gear: three sprung and damped legs.  The tyres are bristle models
 *    as in the car (vehicle/vehicle.ts) – real static friction, so the parked
 *    aeroplane neither creeps nor trembles – with brakes on the main wheels
 *    and a nose wheel steered by the rudder pedals.
 *  - Crashes: too hard a touchdown, a wing tip or the propeller on the
 *    ground, the nose wheel folding, the airframe overstressed.
 *
 * Integrated in substeps of at most 1/240 s, allocation-free in step(), and
 * without three.js like the rest of the simulation.
 *
 * Frames as everywhere in the game: world x east, y up, z south; body x to
 * the right, y up, z to the back (the nose looks towards -z), origin at the
 * centre of mass.  The aerodynamic coefficients are the textbook ones
 * (stability axes: x forward, y right, z down; p roll right, q pitch up,
 * r yaw right); `substep` turns them into the body frame of the game.
 */
import type { AircraftGeometry } from './flightspec.ts';
import { TRAINER } from './flightspec.ts';
import type { Ground, GroundSample } from './vehicle/types.ts';

export interface FlightControls {
  /** 0…1 */
  throttle: number;
  /** -1…1, + = pull (nose up) */
  elevator: number;
  /** -1…1, + = roll right */
  aileron: number;
  /** -1…1, + = yaw right (also steers the nose wheel) */
  rudder: number;
  /** 0…1 of TRAINER.flapsMax; the flaps follow at about 5°/s */
  flaps: number;
  /** -1…1 elevator trim, + = nose up */
  trim: number;
  /** 0…1, both main wheels */
  brake: number;
  /** optional, added to `brake` on that side */
  brakeLeft?: number;
  brakeRight?: number;
  parkingBrake: boolean;
  engineOn: boolean;
}

export type CrashKind = 'impact' | 'wing' | 'noseOver' | 'overspeed';

export interface WheelView {
  /** strut compression (m) */
  compression: number;
  /** accumulated rotation (rad) */
  spin: number;
  contact: boolean;
  /** steering angle (rad, + = right) */
  steer: number;
}

const G = 9.81;
const RHO0 = 1.225;
const DEG = Math.PI / 180;
const RPM = 30 / Math.PI;
const TWO_PI = 2 * Math.PI;
/** longest internal integration step (s) */
const H_MAX = 1 / 240;

/**
 * Aerodynamic coefficients of the whole aeroplane, per radian where they are
 * derivatives; reference area, span and chord come from the geometry.  The
 * values are of the size published for two-seat high-wing trainers, then
 * tuned so that the aeroplane flies its figures in flightspec.ts.
 */
export const AERO = {
  /** lift at zero angle of attack (the wing's incidence), slope, from pitch rate (per qc/2V) and per rad elevator (trailing edge up) */
  CL0: 0.307,
  CLa: 4.41,
  CLq: 3.9,
  CLde: -0.3,
  /** angle of attack (rad) at the top of the lift curve, clean; the curve starts to round off this far below it */
  alphaCrit: 0.29,
  round: 0.052,
  /** top of the lift curve at negative angles (rad) */
  alphaCritNeg: -0.21,
  /** full flaps: lift added, shift of the critical angle (rad) */
  flapCL: 0.6,
  flapAlpha: -0.016,
  /** past the critical angle the lift falls to this share of its maximum within `stallDrop` rad, then joins the flat plate */
  postStall: 0.72,
  stallDrop: 0.105,
  /** flat plate: lift = flatCL·sin 2α, drag = CD0 + CDgear + flatCD·sin²α */
  flatCL: 1.1,
  flatCD: 1.25,
  /** drag: airframe, fixed gear, Oswald factor, full flaps, separated flow at the stall, sideslip */
  CD0: 0.026,
  CDgear: 0.008,
  oswald: 0.72,
  flapCD: 0.055,
  stallCD: 0.08,
  CDbeta: 0.25,
  /** side force: sideslip, rudder (trailing edge right), yaw rate */
  CYb: -0.39,
  CYdr: -0.19,
  CYr: 0.2,
  /** pitch: at zero angle of attack, static stability (per sin α), damping incl. downwash lag, elevator, full flaps, the nose dropping at the stall, ground effect (per unit of 1 − φ, see sampleGround) */
  Cm0: 0.042,
  Cma: -0.6,
  Cmq: -18,
  Cmde: 1.1,
  Cmflap: -0.03,
  CmStall: -0.08,
  CmGround: -0.25,
  /** roll: dihedral effect, damping, from yaw rate (Clr0 + ClrCL·CL), aileron, rudder */
  Clb: -0.065,
  Clp: -0.48,
  Clr0: 0.02,
  ClrCL: 0.2,
  Clda: 0.115,
  Cldr: -0.012,
  /** yaw: weathercock stability, from roll rate (·CL, adverse), damping, adverse yaw of the ailerons, rudder */
  Cnb: 0.065,
  CnpCL: -0.06,
  Cnr: -0.095,
  Cnda: -0.008,
  Cndr: 0.065,
  /**
   * Rigging (a fin set a little off the centreline, a tab on an aileron):
   * rolling and yawing moment to the right that cancel the engine's torque
   * and the slipstream's swirl in cruise at 75 % power.  Climbing at full
   * power the propeller wins (a little right rudder), gliding at idle the
   * rigging does.  Scaled with the engine's power.
   */
  rigRoll: 0.00047,
  rigYaw: 0.0003,
  /** control surface travel (rad): elevator up and down, ailerons, rudder, and the trim range (elevator equivalent, nose down / up) */
  elevUp: 25 * DEG,
  elevDown: 20 * DEG,
  aileron: 20 * DEG,
  rudder: 16 * DEG,
  trimDown: 3.5 * DEG,
  trimUp: 3.8 * DEG,
  /** stall warning this far below the critical angle (rad) */
  warn: 2 * DEG,
  /** flap travel (degrees per second) */
  flapRate: 5,
};

/**
 * Fixed-pitch propeller and engine.  Thrust and power coefficients over the
 * advance ratio J = V/(nD): CT = CT0·(1 − (J/J0)^1.5), CP = CP0·(1 − (J/Jp)²),
 * both negative where the air drives the propeller (windmilling).  They are
 * the values of a cruise propeller matched to the 160 PS engine (2300 rpm
 * static, about 2600 rpm in cruise) and scaled with the power for the
 * others, as if each engine had its own propeller.
 */
export const PROP = {
  CT0: 0.092,
  J0: 1.05,
  CP0: 0.0587,
  Jp: 1.089,
  /** beyond this advance ratio the curves are not extended (a slow or stopped propeller) */
  Jmax: 1.6,
  /** share of the propeller's slipstream that reaches the tail surfaces */
  slipstream: 0.35,
  /** yawing moment of the slipstream's swirl on the fin and of the P-factor (m, m per rad of α), both to the left */
  swirl: 0.08,
  pFactor: 0.25,
  /** engine and propeller (kg·m²) */
  inertia: 2.2,
};

export const ENGINE = {
  /** rpm at which the rated power is given */
  ratedRpm: 2700,
  /** friction and pumping: a + b·ω (N·m, ω in rad/s) */
  friction: [10, 0.08] as const,
  /** throttle opening at the idle stop */
  idleOpen: 0.12,
  /** the dead engine: breakaway torque (compression), and friction and pumping once it turns (N·m) */
  breakaway: 40,
  deadFriction: 28,
  starter: 150,
  /** rpm at which a cranked engine fires */
  catchRpm: 350,
  /** below this a running engine dies (rpm) */
  stallRpm: 180,
  /** fuel: specific consumption (kg/kWh of indicated power), density (kg/l), and what the idling engine burns anyway (l/h) */
  bsfc: 0.24,
  fuelDensity: 0.72,
  idleFlow: 2.5,
};

export const GEAR = {
  /** share of the travel the legs are pushed in when standing, and their damping ratio */
  staticShare: 0.4,
  damping: 0.4,
  /** beyond the travel: the tyre and the bottomed strut, stiffness as a multiple of the spring */
  bump: 8,
  /** tyres: friction coefficient on dry asphalt, cornering stiffness per unit of static load (1/rad), relaxation length (m) */
  mu: 0.8,
  cornering: 8,
  relax: 0.25,
  /** rolling resistance on asphalt (the ground's `rolling` multiplies it) */
  rolling: 0.02,
  /** braking force per main wheel at full pedal (about 0.4 g in all), and of the parking brake (N per 1000 kg of aeroplane) */
  brake: 1900,
  parking: 3000,
  /** nose wheel: steering angle at full rudder (rad), halved at this ground speed (m/s) */
  steer: 12 * DEG,
  steerFade: 10,
};

/** What breaks the aeroplane. */
export const LIMITS = {
  /** sink rate of a wheel at touchdown (m/s) */
  touchdown: 3.5,
  /**
   * Load on a leg as a multiple of its static load at which it folds: the
   * nose leg when the aeroplane is put down on it, a main leg only in a slam
   * that the touchdown rule did not catch (bouncing without leaving the ground).
   */
  noseLeg: 7,
  mainLeg: 15,
  /** airspeed as a multiple of vne */
  overspeed: 1.2,
  /** load factor (g) at which the airframe fails */
  gMax: 7,
  gMin: -4,
  /** sink rate (m/s) at which the airframe hitting the ground is a crash whatever part touches */
  hull: 1.5,
};

/** ISA air density (kg/m³) at a height above sea level (m). */
export function airDensity(h: number): number {
  const hh = h > -1000 ? (h < 11000 ? h : 11000) : -1000;
  return RHO0 * Math.pow(1 - 2.25577e-5 * hh, 4.2559);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp a control input; anything that is not a number counts as 0. */
function input(v: number | undefined, lo: number, hi: number): number {
  return v !== undefined && v > lo ? (v < hi ? v : hi) : v !== undefined && v <= lo ? lo : 0;
}

function smooth(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** Lift of the flaps (0…1 of their travel): most of it comes with the first half. */
function flapLift(f: number): number {
  return f * (1.35 - 0.35 * f);
}

/** Result of `liftCurve` (one shared object, nothing is allocated). */
const curve = { cl: 0, stall: 0, sep: 0 };

/**
 * Lift coefficient over the angle of attack (rad, any angle) with the flaps
 * at `f` (0…1).  Straight up to `round` below the critical angle, a rounded
 * top, then down to `postStall` of the maximum and on to the flat plate.
 * Also leaves `stall` (0…1: how far the stall has progressed) and `sep`
 * (0…1: how far the flow has become that of a flat plate) in `curve`.
 */
export function liftCurve(alpha: number, f: number): typeof curve {
  const A = AERO;
  const a = A.CLa;
  const r = A.round;
  const cl0 = A.CL0 + A.flapCL * flapLift(f);
  const ac = A.alphaCrit + A.flapAlpha * f;
  const acn = A.alphaCritNeg;
  let cl: number;
  let stall = 0;
  let sep = 0;
  if (alpha > ac) {
    const top = cl0 + a * (ac - r / 2);
    const x = alpha - ac;
    stall = smooth(x / A.stallDrop);
    sep = smooth((x - 0.07) / 0.2);
    const held = top * (1 - (1 - A.postStall) * stall);
    cl = held + (A.flatCL * Math.sin(2 * alpha) - held) * sep;
  } else if (alpha < acn) {
    const bottom = cl0 + a * (acn + r / 2);
    const x = acn - alpha;
    stall = smooth(x / A.stallDrop);
    sep = smooth((x - 0.07) / 0.2);
    const held = bottom * (1 - (1 - A.postStall) * stall);
    cl = held + (A.flatCL * Math.sin(2 * alpha) - held) * sep;
  } else if (alpha > ac - r) {
    const x = alpha - ac;
    cl = cl0 + a * (ac - r / 2) - (a * x * x) / (2 * r);
  } else if (alpha < acn + r) {
    const x = alpha - acn;
    cl = cl0 + a * (acn + r / 2) + (a * x * x) / (2 * r);
  } else cl = cl0 + a * alpha;
  curve.cl = cl;
  curve.stall = stall;
  curve.sep = sep;
  return curve;
}

/** Highest lift coefficient with the flaps at `f` (0…1), and the angle where it is reached. */
export function maxLift(f: number): { cl: number; alpha: number } {
  const ac = AERO.alphaCrit + AERO.flapAlpha * f;
  return { cl: AERO.CL0 + AERO.flapCL * flapLift(f) + AERO.CLa * (ac - AERO.round / 2), alpha: ac };
}

/** Drag coefficient for a lift coefficient at an angle of attack (flaps 0…1, `phi` the ground effect on the induced drag). */
function dragCoefficient(cl: number, alpha: number, f: number, kInd: number, phi: number, stall: number, sep: number): number {
  const A = AERO;
  const base = A.CD0 + A.CDgear;
  const attached = base + A.flapCD * f * Math.sqrt(f) + kInd * phi * cl * cl + A.stallCD * stall;
  const s = Math.sin(alpha);
  return attached + (base + A.flatCD * s * s - attached) * sep;
}

interface Leg {
  /** wheel centre with the strut extended (body) */
  x: number;
  y: number;
  z: number;
  radius: number;
  travel: number;
  steers: boolean;
  /** -1 left main wheel, +1 right, 0 nose */
  side: number;
  /** static load (N), spring (N/m), damper (N·s/m), tyre stiffness (N/m) and bristle damping (N·s/m) */
  load: number;
  k: number;
  c: number;
  kTyre: number;
  cTyre: number;
}

/**
 * Points of the airframe that can touch the ground, and what it means when
 * they do: a wing tip, a stabiliser tip or the propeller ('wing'); the tail
 * (a scrape, or an 'impact' when hard); belly and cowling (an 'impact' when
 * moving); fin and cabin roof (turned over: 'noseOver').
 */
const HULL_WING = 0;
const HULL_TAIL = 1;
const HULL_BELLY = 2;
const HULL_TOP = 3;

const smp: GroundSample = { y: 0, nx: 0, ny: 1, nz: 0, grip: 1, rolling: 1 };

export class Aircraft {
  readonly spec: AircraftGeometry;
  /** PS as built */
  power: number;
  /** centre of mass (world) */
  readonly pos = { x: 0, y: 0, z: 0 };
  /** world m/s */
  readonly vel = { x: 0, y: 0, z: 0 };
  /** body → world [x, y, z, w] */
  readonly q: [number, number, number, number] = [0, 0, 0, 1];
  /** body rates (rad/s) about the body axes x (right: pitch, + nose up), y (up: yaw, + left), z (back: roll, + left wing down) */
  readonly omega = { x: 0, y: 0, z: 0 };
  readonly wheels: WheelView[];
  crashed: null | CrashKind = null;
  /** litres */
  fuel: number;
  /** wind (world, m/s, the direction it blows towards) – or a field, sampled at the centre of mass once per step */
  readonly wind = { x: 0, y: 0, z: 0 };
  windField: ((x: number, y: number, z: number, out: { x: number; y: number; z: number }) => void) | null = null;
  /** the tail touched the ground since the last placement (not a crash when gentle) */
  tailStrike = false;

  readonly mass: number;
  /** principal moments of inertia about the body x (pitch), y (yaw) and z (roll) axes (kg·m²) */
  readonly inertia: [number, number, number];

  private readonly legs: Leg[];
  private readonly hull: Float64Array;
  private readonly hullKind: Uint8Array;
  /** farthest point of the airframe or the wheels from the centre of mass (m) */
  private readonly reach: number;
  private readonly R = new Float64Array(9);
  private readonly kInd: number;
  private readonly qInd: number;
  private readonly propScale: number;
  private readonly diskArea: number;
  // engine and propeller
  private omegaE = 0;
  private running = false;
  private propAng = 0;
  private qEngine = 0;
  private thrust = 0;
  /** torque of the air on the propeller (N·m, negative when the air drives it) */
  private qAir = 0;
  private fuelFlowLh = 0;
  // controls as they are (surfaces lag a little, flaps run at their rate)
  private flapDeg = 0;
  private dE = 0;
  private dA = 0;
  private dR = 0;
  private steerAng = 0;
  private readonly surf = { elevator: 0, aileron: 0, rudder: 0 };
  // inputs of the current step, cleaned
  private cThr = 0;
  private cElev = 0;
  private cAil = 0;
  private cRud = 0;
  private cFlap = 0;
  private cTrim = 0;
  private cBrakeL = 0;
  private cBrakeR = 0;
  private cPark = false;
  private cEngine = false;
  // air data
  private rho = RHO0;
  private tasV = 0;
  private alphaV = 0;
  private betaV = 0;
  private stallV = 0;
  private warnV = false;
  // ground under the aeroplane, sampled once per step: a plane through (gx, gy, gz) with normal gn
  private gx = 0;
  private gy = 0;
  private gz = 0;
  private gnx = 0;
  private gny = 1;
  private gnz = 0;
  private aglV = 0;
  private phi = 1;
  // gear and tyres
  private readonly zLong: Float64Array;
  private readonly zLat: Float64Array;
  private readonly wasDown: Uint8Array;
  private readonly wheelW: Float64Array;
  private contactAny = false;
  // specific force (body, N) for the load factor and the ball
  private fsx = 0;
  private fsy = 0;
  private ball = 0;
  private nzV = 1;
  private gTime = 0;

  constructor(spec: AircraftGeometry = TRAINER, powerPs?: number) {
    this.spec = spec;
    this.power = powerPs ?? spec.power;
    this.mass = spec.mass;
    this.fuel = spec.fuel;
    // moments of inertia of a trainer of this size, scaled with mass and dimensions
    const m = spec.mass / 1000;
    const lr = spec.length / 8.2;
    const br = spec.span / 10.9;
    this.inertia = [1800 * m * lr * lr, (2600 * m * (67.24 * lr * lr + 118.81 * br * br)) / 186.05, 1300 * m * br * br];
    this.kInd = 1 / (Math.PI * AERO.oswald * ((spec.span * spec.span) / spec.wingArea));
    // engine: indicated torque so that the rated power is left at the rated rpm
    const wr = ENGINE.ratedRpm / RPM;
    this.qInd = (this.power * 735.5) / wr + ENGINE.friction[0] + ENGINE.friction[1] * wr;
    this.propScale = this.power / 160;
    this.diskArea = (Math.PI * spec.propDiameter * spec.propDiameter) / 4;

    // legs: static loads from the lever arms, springs that carry them at `staticShare` of the travel
    const gear = spec.gear;
    const W = spec.mass * G;
    const nose = gear.findIndex((g) => g.steers);
    let zm = 0;
    let mains = 0;
    for (let i = 0; i < gear.length; i++) {
      if (i !== nose) {
        zm += gear[i].z;
        mains++;
      }
    }
    zm /= Math.max(1, mains);
    const zn = nose >= 0 ? gear[nose].z : zm - 1;
    const noseLoad = nose >= 0 ? (W * zm) / (zm - zn) : 0;
    this.legs = gear.map((g, i) => {
      const load = i === nose ? noseLoad : (W - noseLoad) / Math.max(1, mains);
      const k = load / (GEAR.staticShare * g.travel);
      const mEff = load / G;
      const kTyre = (GEAR.cornering * load) / GEAR.relax;
      return {
        x: g.x,
        y: g.y,
        z: g.z,
        radius: g.radius,
        travel: g.travel,
        steers: g.steers,
        side: i === nose ? 0 : g.x < 0 ? -1 : 1,
        load,
        k,
        c: GEAR.damping * 2 * Math.sqrt(k * mEff),
        kTyre,
        cTyre: 1.4 * Math.sqrt(kTyre * mEff),
      };
    });
    const n = gear.length;
    this.zLong = new Float64Array(n);
    this.zLat = new Float64Array(n);
    this.wasDown = new Uint8Array(n);
    this.wheelW = new Float64Array(n);
    this.wheels = gear.map(() => ({ compression: 0, spin: 0, contact: false, steer: 0 }));

    // the airframe: wing tips, stabiliser tips, tail, belly and cowling, fin top and cabin roof
    const tipY = spec.wingY + (spec.span / 2) * Math.tan(spec.dihedral * DEG);
    const hs = spec.span / 2;
    // belly: a little above the highest wheel centre
    const bellyY = Math.max(...gear.map((g) => g.y)) + 0.3;
    const pts: Array<[number, number, number, number]> = [
      [-hs, tipY, spec.wingLE, HULL_WING],
      [-hs, tipY, spec.wingTE, HULL_WING],
      [hs, tipY, spec.wingLE, HULL_WING],
      [hs, tipY, spec.wingTE, HULL_WING],
      [-spec.stabSpan / 2, spec.stabY, spec.stabZ, HULL_WING],
      [spec.stabSpan / 2, spec.stabY, spec.stabZ, HULL_WING],
      [0, spec.stabY - 0.4, spec.stabZ - 0.4, HULL_TAIL],
      [0, bellyY, 0, HULL_BELLY],
      [0, spec.propHub[1] - 0.6, spec.propHub[2] + 0.4, HULL_BELLY],
      [0, spec.finTop, spec.finZ + 0.3, HULL_TOP],
      [-0.6, spec.wingY + 0.25, 0, HULL_TOP],
      [0.6, spec.wingY + 0.25, 0, HULL_TOP],
    ];
    this.hull = new Float64Array(pts.length * 3);
    this.hullKind = new Uint8Array(pts.length);
    pts.forEach((p, i) => {
      this.hull[i * 3] = p[0];
      this.hull[i * 3 + 1] = p[1];
      this.hull[i * 3 + 2] = p[2];
      this.hullKind[i] = p[3];
    });
    let reach = Math.hypot(spec.propHub[0], spec.propHub[1], spec.propHub[2]) + spec.propDiameter / 2;
    for (const p of pts) reach = Math.max(reach, Math.hypot(p[0], p[1], p[2]));
    for (const g of gear) reach = Math.max(reach, Math.hypot(g.x, g.y - g.radius, g.z));
    this.reach = reach;
    this.updateRot();
  }

  // ---------------------------------------------------------------------------
  // placing

  /**
   * At rest on its wheels at (x, z), facing `yaw` (game convention: 0 north,
   * + left), the legs pushed in by their static loads so that nothing moves
   * when the simulation starts.
   */
  placeOnGround(x: number, z: number, yaw: number, ground: Ground, engineRunning = false): void {
    this.reset(engineRunning);
    ground.sample(x, z, 1e4, smp);
    ground.sample(x, z, smp.y + 1, smp);
    // pitch at rest: the line through the loaded nose and main tyres lies on the ground
    const legs = this.legs;
    let nose = legs[0];
    let main = legs[legs.length - 1];
    for (const l of legs) {
      if (l.steers) nose = l;
      else main = l;
    }
    const sn = GEAR.staticShare * nose.travel;
    const sm = GEAR.staticShare * main.travel;
    const yn = nose.y - nose.radius + sn;
    const ym = main.y - main.radius + sm;
    const theta = Math.atan2(ym - yn, main.z - nose.z);
    // orientation: tilt onto the ground's normal · yaw · static pitch
    const nx = smp.nx;
    const ny = smp.ny;
    const nz = smp.nz;
    const ax = nz;
    const az = -nx;
    const al = Math.hypot(ax, az);
    const tilt = Math.acos(clamp(ny, -1, 1));
    const ts = al > 1e-9 ? Math.sin(tilt / 2) / al : 0;
    const tq: [number, number, number, number] = [ax * ts, 0, az * ts, Math.cos(tilt / 2)];
    const yq: [number, number, number, number] = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
    const pq: [number, number, number, number] = [Math.sin(theta / 2), 0, 0, Math.cos(theta / 2)];
    quatMul(tq, yq, this.q);
    quatMul(this.q, pq, this.q);
    this.updateRot();
    const R = this.R;
    // height: every leg at its static compression; take the mean over the legs
    let ySum = 0;
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      const s = GEAR.staticShare * l.travel;
      const lx = R[0] * l.x + R[1] * l.y + R[2] * l.z;
      const ly = R[3] * l.x + R[4] * l.y + R[5] * l.z;
      const lz = R[6] * l.x + R[7] * l.y + R[8] * l.z;
      ground.sample(x + lx, z + lz, smp.y + 1, smp);
      const un = R[1] * smp.nx + R[4] * smp.ny + R[7] * smp.nz;
      // distance of the extended wheel centre from the surface that leaves compression s
      const d0 = l.radius - s * un;
      ySum += smp.y + d0 / smp.ny - ly;
      this.wheels[i].compression = s;
      this.wheels[i].contact = true;
      this.wasDown[i] = 1;
    }
    this.pos.x = x;
    this.pos.y = ySum / legs.length;
    this.pos.z = z;
    this.contactAny = true;
    this.rho = airDensity(this.pos.y);
    if (this.running) this.omegaE = this.steadyOmega(0, 0, this.rho);
    this.sampleGround(ground);
    this.derive(0);
  }

  /**
   * In level flight at (x, y, z) heading `yaw` with `speed` (true airspeed,
   * m/s): at the angle of attack that carries the weight, the propeller at
   * the rpm of level flight.  For hands-off flight the game sets throttle
   * and trim from levelFlight(speed).  With the ground given, `agl` is right
   * at once; otherwise it counts from sea level until the first step.
   */
  placeInAir(x: number, y: number, z: number, yaw: number, speed: number, ground?: Ground): void {
    this.reset(true);
    this.pos.x = x;
    this.pos.y = y;
    this.pos.z = z;
    const v = Math.max(0, Number.isFinite(speed) ? speed : 0);
    const lf = this.levelFlight(Math.max(v, 1));
    const theta = v > 1 ? lf.alpha : 0;
    const yq: [number, number, number, number] = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
    const pq: [number, number, number, number] = [Math.sin(theta / 2), 0, 0, Math.cos(theta / 2)];
    quatMul(yq, pq, this.q);
    this.updateRot();
    // flying straight ahead, level: the nose is above the flight path by α
    this.vel.x = -Math.sin(yaw) * v;
    this.vel.y = 0;
    this.vel.z = -Math.cos(yaw) * v;
    this.omegaE = lf.rpm / RPM;
    this.tasV = v;
    this.alphaV = theta;
    this.dE = this.elevatorFromTrim(lf.trim, 0);
    this.rho = airDensity(y);
    if (ground) this.sampleGround(ground);
    else {
      this.gx = x;
      this.gy = 0;
      this.gz = z;
      this.gnx = this.gnz = 0;
      this.gny = 1;
    }
    this.derive(0);
  }

  /**
   * What steady level flight at `tas` (m/s) needs at the present altitude and
   * flap setting: throttle and trim (as the controls take them, the elevator
   * left in the middle), the angle of attack (rad) and the rpm.
   */
  levelFlight(tas: number, flaps = this.flapDeg / this.spec.flapsMax, altitude = this.pos.y): { throttle: number; trim: number; alpha: number; rpm: number } {
    const s = this.spec;
    const A = AERO;
    const rho = airDensity(altitude);
    const V = Math.max(1, tas);
    const qbar = 0.5 * rho * V * V;
    const clReq = (this.mass * G) / (qbar * s.wingArea);
    // (the propeller helpers below work on the aeroplane's own fields: keep them)
    const thrustNow = this.thrust;
    const qAirNow = this.qAir;
    // angle of attack on the attached part of the lift curve
    let lo = A.alphaCritNeg;
    let hi = maxLift(flaps).alpha;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (liftCurve(mid, flaps).cl < clReq) lo = mid;
      else hi = mid;
    }
    const alpha = (lo + hi) / 2;
    const c = liftCurve(alpha, flaps);
    const drag = qbar * s.wingArea * dragCoefficient(c.cl, alpha, flaps, this.kInd, 1, c.stall, c.sep);
    // throttle whose steady thrust (along the nose, α above the path) balances the drag
    const va = V * Math.cos(alpha);
    let t0 = 0;
    let t1 = 1;
    let w = 0;
    for (let i = 0; i < 30; i++) {
      const t = (t0 + t1) / 2;
      w = this.steadyOmega(t, va, rho);
      this.propeller(w, va, rho);
      if (this.thrust * Math.cos(alpha) < drag) t0 = t;
      else t1 = t;
    }
    const throttle = (t0 + t1) / 2;
    w = this.steadyOmega(throttle, va, rho);
    this.propeller(w, va, rho);
    // trim: the pitching moments balance with the elevator in the middle
    const T = Math.max(0, this.thrust);
    const qs = qbar * s.wingArea * s.chord;
    const cm = A.Cm0 + A.Cma * Math.sin(alpha) + A.Cmflap * flaps - (s.propHub[1] * T) / qs;
    const tail = 1 + (PROP.slipstream * T) / (this.diskArea * qbar);
    const de = -cm / (A.Cmde * tail);
    const trim = clamp(de >= 0 ? de / A.trimUp : de / A.trimDown, -1, 1);
    this.thrust = thrustNow;
    this.qAir = qAirNow;
    return { throttle, trim, alpha, rpm: w * RPM };
  }

  // ---------------------------------------------------------------------------
  // simulation

  step(dt: number, c: FlightControls, ground: Ground): void {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    this.readControls(c);
    if (this.crashed) {
      this.derive(dt);
      return;
    }
    // what changes slowly enough for once per step: the air, the wind, the ground below
    this.rho = airDensity(this.pos.y);
    if (this.windField) this.windField(this.pos.x, this.pos.y, this.pos.z, this.wind);
    this.sampleGround(ground);
    const sx = this.pos.x;
    const sy = this.pos.y;
    const sz = this.pos.z;
    const q0 = this.q[0];
    const q1 = this.q[1];
    const q2 = this.q[2];
    const q3 = this.q[3];
    const n = Math.ceil(dt / H_MAX - 1e-9);
    const h = dt / n;
    // can anything of the airframe reach the ground within this step?
    const above = sy - this.gy - this.reach - Math.abs(this.vel.y) * dt - 0.5;
    const near = !(above > 0);
    if (!near && this.contactAny) for (let i = 0; i < this.legs.length; i++) this.liftOff(i);
    for (let i = 0; i < n && !this.crashed; i++) this.substep(h, ground, near);
    if (!this.finite()) {
      // should never happen; if it does, the aeroplane stops where it was rather than vanishing
      this.pos.x = sx;
      this.pos.y = sy;
      this.pos.z = sz;
      this.q[0] = q0;
      this.q[1] = q1;
      this.q[2] = q2;
      this.q[3] = q3;
      this.crash('impact');
    }
    this.derive(dt);
  }

  private readControls(c: FlightControls): void {
    this.cThr = input(c.throttle, 0, 1);
    this.cElev = input(c.elevator, -1, 1);
    this.cAil = input(c.aileron, -1, 1);
    this.cRud = input(c.rudder, -1, 1);
    this.cFlap = input(c.flaps, 0, 1);
    this.cTrim = input(c.trim, -1, 1);
    const b = input(c.brake, 0, 1);
    this.cBrakeL = Math.min(1, b + input(c.brakeLeft, 0, 1));
    this.cBrakeR = Math.min(1, b + input(c.brakeRight, 0, 1));
    this.cPark = c.parkingBrake === true;
    this.cEngine = c.engineOn === true;
  }

  private reset(engineRunning: boolean): void {
    this.crashed = null;
    this.tailStrike = false;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.omega.x = this.omega.y = this.omega.z = 0;
    this.running = engineRunning && this.fuel > 0;
    this.omegaE = this.running ? this.steadyOmega(0, 0, RHO0) : 0;
    this.thrust = 0;
    this.qEngine = 0;
    this.zLong.fill(0);
    this.zLat.fill(0);
    this.wasDown.fill(0);
    this.wheelW.fill(0);
    for (const w of this.wheels) {
      w.contact = false;
      w.compression = 0;
      w.steer = 0;
    }
    this.contactAny = false;
    this.steerAng = 0;
    this.dE = this.dA = this.dR = 0;
    this.fsx = 0;
    this.fsy = this.mass * G;
    this.ball = 0;
    this.nzV = 1;
    this.gTime = 0;
    this.tasV = this.alphaV = this.betaV = this.stallV = 0;
    this.warnV = false;
  }

  private crash(kind: CrashKind): void {
    if (this.crashed) return;
    this.crashed = kind;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.omega.x = this.omega.y = this.omega.z = 0;
    this.running = false;
    this.omegaE = 0;
    this.thrust = 0;
    this.qEngine = 0;
    this.wheelW.fill(0);
  }

  private finite(): boolean {
    const p = this.pos;
    const v = this.vel;
    const q = this.q;
    const o = this.omega;
    return Number.isFinite(p.x + p.y + p.z + v.x + v.y + v.z + q[0] + q[1] + q[2] + q[3] + o.x + o.y + o.z + this.omegaE);
  }

  private liftOff(i: number): void {
    this.wasDown[i] = 0;
    this.zLong[i] = 0;
    this.zLat[i] = 0;
    const w = this.wheels[i];
    w.contact = false;
    w.compression = 0;
  }

  private updateRot(): void {
    const q = this.q;
    const x = q[0];
    const y = q[1];
    const z = q[2];
    const w = q[3];
    const r = this.R;
    r[0] = 1 - 2 * (y * y + z * z);
    r[1] = 2 * (x * y - z * w);
    r[2] = 2 * (x * z + y * w);
    r[3] = 2 * (x * y + z * w);
    r[4] = 1 - 2 * (x * x + z * z);
    r[5] = 2 * (y * z - x * w);
    r[6] = 2 * (x * z - y * w);
    r[7] = 2 * (y * z + x * w);
    r[8] = 1 - 2 * (x * x + y * y);
  }

  /** The ground below the centre of mass, taken as a plane for the step (wheels near it sample their own). */
  private sampleGround(ground: Ground): void {
    ground.sample(this.pos.x, this.pos.z, this.pos.y, smp);
    this.gx = this.pos.x;
    this.gy = smp.y;
    this.gz = this.pos.z;
    const ok = smp.ny > 0.2 && Number.isFinite(smp.y);
    this.gnx = ok ? smp.nx : 0;
    this.gny = ok ? smp.ny : 1;
    this.gnz = ok ? smp.nz : 0;
    if (!Number.isFinite(this.gy)) this.gy = -1e4;
    // ground effect: induced drag falls within about half a span of the ground (McCormick)
    const hw = Math.max(0.3, this.pos.y + this.spec.wingY - this.gy);
    const k = (16 * hw) / this.spec.span;
    this.phi = (k * k) / (1 + k * k);
  }

  private planeY(x: number, z: number): number {
    return this.gy - (this.gnx * (x - this.gx) + this.gnz * (z - this.gz)) / this.gny;
  }

  /** Elevator deflection (rad, + = trailing edge up) from stick and trim. */
  private elevatorFromTrim(trim: number, elevator: number): number {
    const A = AERO;
    const d = (elevator > 0 ? elevator * A.elevUp : elevator * A.elevDown) + (trim > 0 ? trim * A.trimUp : trim * A.trimDown);
    return clamp(d, -A.elevDown, A.elevUp);
  }

  /** Torque of the running engine at a throttle and crankshaft speed (rad/s), after its own friction. */
  private engineTorque(t: number, w: number): number {
    const E = ENGINE;
    return (E.idleOpen + (1 - E.idleOpen) * t) * this.qInd - E.friction[0] - E.friction[1] * w;
  }

  /** Thrust (N) and the torque the air puts on the propeller (N·m) at a speed (rad/s) and axial airspeed. */
  private propeller(w: number, va: number, rho: number): void {
    const P = PROP;
    const D = this.spec.propDiameter;
    const v = va > 0 ? va : 0;
    const n = w / TWO_PI;
    // a slow or stopped propeller is taken at the highest advance ratio of the curves
    const nEff = Math.max(n, v / (P.Jmax * D));
    if (!(nEff > 1e-6)) {
      this.thrust = 0;
      this.qAir = 0;
      return;
    }
    const J = v / (nEff * D);
    const jt = J / P.J0;
    const jp = J / P.Jp;
    const ct = this.propScale * P.CT0 * (1 - jt * Math.sqrt(jt));
    const cp = this.propScale * P.CP0 * (1 - jp * jp);
    const nn = rho * nEff * nEff * D * D * D * D;
    this.thrust = ct * nn;
    this.qAir = (cp * nn * D) / TWO_PI;
  }

  /** Crankshaft speed (rad/s) at which the running engine and the propeller balance. */
  private steadyOmega(t: number, va: number, rho: number): number {
    let lo = 5;
    let hi = 500;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      this.propeller(mid, va, rho);
      if (this.engineTorque(t, mid) > this.qAir) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** Engine and propeller over one substep; `va` is the airspeed along the propeller axis. */
  private engine(h: number, va: number): void {
    const E = ENGINE;
    const I = PROP.inertia;
    let w = this.omegaE;
    if (!this.cEngine || this.fuel <= 0) this.running = false;
    this.propeller(w, va, this.rho);
    let q: number;
    if (this.running) {
      q = this.engineTorque(this.cThr, w);
      w += ((q - this.qAir) / I) * h;
      if (w * RPM < E.stallRpm) this.running = false;
      const open = E.idleOpen + (1 - E.idleOpen) * this.cThr;
      this.fuelFlowLh = E.idleFlow + (E.bsfc * open * this.qInd * Math.max(w, 0)) / 1000 / E.fuelDensity;
      this.fuel = Math.max(0, this.fuel - (this.fuelFlowLh * h) / 3600);
    } else {
      this.fuelFlowLh = 0;
      // the starter turns the engine until it fires
      const starter = this.cEngine && this.fuel > 0 ? E.starter * Math.max(0, 1 - w / 60) : 0;
      w += ((starter - this.qAir) / I) * h;
      // compression and friction of the dead engine: high breakaway torque, less once it turns
      const fr = E.deadFriction + E.friction[1] * Math.abs(w) + (E.breakaway - E.deadFriction) / (1 + (w / 8) * (w / 8));
      const dw = (fr * h) / I;
      w = w > dw ? w - dw : w < -dw ? w + dw : 0;
      q = starter - (w !== 0 ? fr * Math.sign(w) : 0);
      if (this.cEngine && this.fuel > 0 && w * RPM > E.catchRpm) this.running = true;
    }
    if (w < 0) w = 0;
    if (w > 600) w = 600;
    this.omegaE = w;
    this.qEngine = q;
    this.propAng += w * h;
  }

  private substep(h: number, ground: Ground, near: boolean): void {
    const s = this.spec;
    const A = AERO;
    this.updateRot();
    const R = this.R;
    const m = this.mass;
    const px = this.pos.x;
    const py = this.pos.y;
    const pz = this.pos.z;
    const vx = this.vel.x;
    const vy = this.vel.y;
    const vz = this.vel.z;
    const ox = this.omega.x;
    const oy = this.omega.y;
    const oz = this.omega.z;

    // ---- controls: the surfaces follow the stick within some 0.05 s, the flaps run at their rate
    const lag = h / (0.05 + h);
    this.dE += (this.elevatorFromTrim(this.cTrim, this.cElev) - this.dE) * lag;
    this.dA += (this.cAil * A.aileron - this.dA) * lag;
    this.dR += (this.cRud * A.rudder - this.dR) * lag;
    const fStep = A.flapRate * h;
    this.flapDeg += clamp(this.cFlap * s.flapsMax - this.flapDeg, -fStep, fStep);
    const flap = s.flapsMax > 0 ? clamp(this.flapDeg / s.flapsMax, 0, 1) : 0;

    // ---- the air as the aeroplane meets it (body axes)
    const ax = vx - this.wind.x;
    const ay = vy - this.wind.y;
    const az = vz - this.wind.z;
    const bx = R[0] * ax + R[3] * ay + R[6] * az;
    const by = R[1] * ax + R[4] * ay + R[7] * az;
    const bz = R[2] * ax + R[5] * ay + R[8] * az;
    const u = -bz;
    const w = -by;
    const V2 = bx * bx + by * by + bz * bz;
    const V = Math.sqrt(V2);
    this.tasV = V;
    let Fx = 0;
    let Fy = 0;
    let Fz = 0;
    let Tx = 0;
    let Ty = 0;
    let Tz = 0;

    // ---- engine and propeller: thrust along the nose at the hub; the engine's torque rolls the aeroplane the other way
    this.engine(h, u);
    const T = this.thrust;
    const Tp = T > 0 ? T : 0;
    const hub = s.propHub;
    Fz -= T;
    Tx -= hub[1] * T;
    Ty += hub[0] * T;
    // (the slipstream's swirl gives about half of the torque back on the wing roots)
    Tz += 0.5 * this.qEngine;

    // ---- aerodynamics: coefficients in stability axes, forces and moments turned into the body frame
    // (side force +x; rolling moment L → −z, pitching moment M → +x, yawing moment N → −y)
    const S = s.wingArea;
    const b = s.span;
    const cbar = s.chord;
    const qbar = 0.5 * this.rho * V2;
    let alpha = 0;
    let beta = 0;
    let stall = 0;
    if (V > 1e-3) {
      alpha = Math.atan2(w, u);
      beta = Math.asin(clamp(bx / V, -1, 1));
      const iv = 1 / (2 * V);
      const ph = clamp(-oz * b * iv, -1, 1);
      const qh = clamp(ox * cbar * iv, -1, 1);
      const rh = clamp(-oy * b * iv, -1, 1);
      const cv = liftCurve(alpha, flap);
      stall = cv.stall;
      const ge = 1 - this.phi;
      const cl = cv.cl * (1 + 0.35 * ge * (1 - cv.sep)) + A.CLq * qh;
      const sb = Math.sin(beta);
      const cd = dragCoefficient(cl, alpha, flap, this.kInd, this.phi, stall, cv.sep) + A.CDbeta * sb * sb;
      const cy = A.CYb * sb + A.CYr * rh;
      const cm = A.Cm0 + A.Cma * Math.sin(alpha) + A.Cmq * qh + A.Cmflap * flap + A.CmStall * stall * (alpha > 0 ? 1 : -1) + A.CmGround * ge;
      const clc = clamp(cl, -1, 1.6);
      const rig = this.propScale;
      // a stalled wing no longer damps the roll: it begins to autorotate
      const cRoll = A.Clb * sb + A.Clp * (1 - 1.25 * stall) * ph + (A.Clr0 + A.ClrCL * clc) * rh + A.Clda * this.dA + A.rigRoll * rig;
      const cYaw = A.Cnb * sb + A.CnpCL * clc * ph + A.Cnr * rh + A.Cnda * this.dA + A.rigYaw * rig;
      // lift lies across the flow in the plane of symmetry and comes from the flow in that plane
      const uw2 = u * u + w * w;
      if (uw2 > 1e-8) {
        const uw = Math.sqrt(uw2);
        const L = 0.5 * this.rho * uw2 * S * cl;
        Fy += (L * u) / uw;
        Fz -= (L * w) / uw;
      }
      const D = (qbar * S * cd) / V;
      Fx -= D * bx;
      Fy -= D * by;
      Fz -= D * bz;
      Fx += qbar * S * cy;
      Tx += qbar * S * cbar * cm;
      Ty -= qbar * S * b * cYaw;
      Tz -= qbar * S * b * cRoll;
      // the slipstream's swirl on the fin and the P-factor yaw to the left
      Ty += Tp * (PROP.swirl + PROP.pFactor * clamp(alpha, -0.3, 0.3));
    }
    // elevator and rudder sit in part of the slipstream
    const qTail = qbar + (PROP.slipstream * Tp) / this.diskArea;
    Tx += qTail * S * cbar * A.Cmde * this.dE;
    Fy += qTail * S * A.CLde * this.dE;
    Fx += qTail * S * A.CYdr * this.dR;
    Ty -= qTail * S * b * A.Cndr * this.dR;
    Tz -= qTail * S * b * A.Cldr * this.dR;
    this.alphaV = alpha;
    this.betaV = beta;
    this.stallV = stall;

    // ---- landing gear and airframe on the ground (world frame)
    let GX = 0;
    let GY = 0;
    let GZ = 0;
    let GTx = 0;
    let GTy = 0;
    let GTz = 0;
    let any = false;
    const legs = this.legs;
    const gs = Math.sqrt(vx * vx + vz * vz);
    const steerMax = GEAR.steer / (1 + (gs / GEAR.steerFade) * (gs / GEAR.steerFade));
    this.steerAng += (this.cRud * steerMax - this.steerAng) * (h / (0.1 + h));
    if (near) {
      // angular velocity in the world
      const wx = R[0] * ox + R[1] * oy + R[2] * oz;
      const wy = R[3] * ox + R[4] * oy + R[5] * oz;
      const wz = R[6] * ox + R[7] * oy + R[8] * oz;
      const upX = R[1];
      const upY = R[4];
      const upZ = R[7];
      const fwX = -R[2];
      const fwY = -R[5];
      const fwZ = -R[8];
      const cs = Math.cos(this.steerAng);
      const sn = Math.sin(this.steerAng);
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        const lx = R[0] * l.x + R[1] * l.y + R[2] * l.z;
        const ly = R[3] * l.x + R[4] * l.y + R[5] * l.z;
        const lz = R[6] * l.x + R[7] * l.y + R[8] * l.z;
        const Ax = px + lx;
        const Ay = py + ly;
        const Az = pz + lz;
        if (Ay - this.planeY(Ax, Az) > l.radius + 0.5) {
          if (this.wasDown[i]) this.liftOff(i);
          this.spinFree(i, h);
          continue;
        }
        ground.sample(Ax, Az, Ay, smp);
        const nx = smp.nx;
        const ny = smp.ny;
        const nz = smp.nz;
        const un = upX * nx + upY * ny + upZ * nz;
        // how far the strut is pushed in to put the tyre on the surface
        let sc = un > 0.3 ? (l.radius - (Ay - smp.y) * ny) / un : -1;
        if (!(sc > 0)) {
          if (this.wasDown[i]) this.liftOff(i);
          this.spinFree(i, h);
          continue;
        }
        if (sc > l.travel + 0.3) sc = l.travel + 0.3;
        // contact patch: lever and velocity
        const rx = lx + upX * sc - nx * l.radius;
        const ry = ly + upY * sc - ny * l.radius;
        const rz = lz + upZ * sc - nz * l.radius;
        const cvx = vx + wy * rz - wz * ry;
        const cvy = vy + wz * rx - wx * rz;
        const cvz = vz + wx * ry - wy * rx;
        const vn = cvx * nx + cvy * ny + cvz * nz;
        if (!this.wasDown[i] && -vn > LIMITS.touchdown) {
          this.crash('impact');
          return;
        }
        let N = l.k * sc - (l.c * vn) / un;
        if (sc > l.travel) N += GEAR.bump * l.k * (sc - l.travel);
        if (N < 0) N = 0;
        if (N > (l.steers ? LIMITS.noseLeg : LIMITS.mainLeg) * l.load) {
          this.crash(l.steers ? 'noseOver' : 'impact');
          return;
        }
        this.wasDown[i] = 1;
        const wv = this.wheels[i];
        wv.compression = sc < l.travel ? sc : l.travel;
        wv.contact = N > 0;
        if (N > 0) any = true;
        // rolling direction (the nose wheel steered) and the tyre's side, both in the ground plane
        let dx = fwX;
        let dy = fwY;
        let dz = fwZ;
        if (l.steers) {
          dx = fwX * cs + R[0] * sn;
          dy = fwY * cs + R[3] * sn;
          dz = fwZ * cs + R[6] * sn;
        }
        const dn = dx * nx + dy * ny + dz * nz;
        dx -= nx * dn;
        dy -= ny * dn;
        dz -= nz * dn;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        dx /= dl;
        dy /= dl;
        dz /= dl;
        const tx = dy * nz - dz * ny;
        const ty = dz * nx - dx * nz;
        const tz = dx * ny - dy * nx;
        const vl = cvx * dx + cvy * dy + cvz * dz;
        const vt = cvx * tx + cvy * ty + cvz * tz;
        const av = Math.abs(vl);
        // Bristle tyre: sideways always (relaxing as the tyre rolls on), lengthways
        // only while a brake holds the wheel.  A spring at standstill, the usual
        // cornering stiffness when rolling.  The damping is needed (and acts) only
        // near standstill.
        let zt = this.zLat[i];
        if (av > 1e-3) {
          const e = Math.exp((-av * h) / GEAR.relax);
          zt = zt * e + ((vt * GEAR.relax) / av) * (1 - e);
        } else zt += vt * h;
        const low = 1 / (1 + (av * av) / 2.25);
        let ft = -(l.kTyre * zt + l.cTyre * low * vt);
        const brake = l.side < 0 ? this.cBrakeL : l.side > 0 ? this.cBrakeR : 0;
        const cap = l.side !== 0 ? (Math.max(brake * GEAR.brake, this.cPark ? GEAR.parking : 0) * m) / 1000 : 0;
        let zl = 0;
        let fl = 0;
        if (cap > 0) {
          zl = this.zLong[i] + vl * h;
          fl = -(l.kTyre * zl + l.cTyre * low * vl);
          if (fl > cap || fl < -cap) {
            const k = cap / Math.abs(fl);
            fl *= k;
            zl *= k;
          }
        }
        const fMax = GEAR.mu * smp.grip * N;
        const fTot = Math.sqrt(fl * fl + ft * ft);
        let locked = false;
        if (fTot > fMax) {
          const k = fMax / fTot;
          fl *= k;
          ft *= k;
          zl *= k;
          zt *= k;
          locked = cap >= fMax && av > 0.5;
        }
        this.zLat[i] = zt;
        this.zLong[i] = zl;
        const fL = fl - GEAR.rolling * smp.rolling * N * Math.tanh(vl / 0.3);
        const gfx = dx * fL + tx * ft + nx * N;
        const gfy = dy * fL + ty * ft + ny * N;
        const gfz = dz * fL + tz * ft + nz * N;
        GX += gfx;
        GY += gfy;
        GZ += gfz;
        GTx += ry * gfz - rz * gfy;
        GTy += rz * gfx - rx * gfz;
        GTz += rx * gfy - ry * gfx;
        this.wheelW[i] = locked ? 0 : vl / l.radius;
        wv.spin += this.wheelW[i] * h;
      }

      // the airframe: points of the hull, and the lowest point of the propeller disc
      const hull = this.hull;
      const nh = this.hullKind.length;
      const nx = this.gnx;
      const ny = this.gny;
      const nz = this.gnz;
      // highest the ground plane gets within reach of the airframe: points above it are skipped early
      const top = this.gy + (this.reach * Math.sqrt(nx * nx + nz * nz)) / ny - py;
      for (let j = 0; j <= nh; j++) {
        let hx: number;
        let hy: number;
        let hz: number;
        let kind: number;
        if (j < nh) {
          hx = hull[j * 3];
          hy = hull[j * 3 + 1];
          hz = hull[j * 3 + 2];
          kind = this.hullKind[j];
        } else {
          // world down in the plane of the disc
          const ex = -R[3];
          const ey = -R[4];
          const el = Math.sqrt(ex * ex + ey * ey);
          const rad = s.propDiameter / 2;
          hx = hub[0] + (el > 1e-6 ? (rad * ex) / el : 0);
          hy = hub[1] + (el > 1e-6 ? (rad * ey) / el : -rad);
          hz = hub[2];
          kind = HULL_WING;
        }
        const ry = R[3] * hx + R[4] * hy + R[5] * hz;
        if (ry > top) continue;
        const rx = R[0] * hx + R[1] * hy + R[2] * hz;
        const rz = R[6] * hx + R[7] * hy + R[8] * hz;
        const X = px + rx;
        const Z = pz + rz;
        const depth = (this.planeY(X, Z) - (py + ry)) * ny;
        if (!(depth > 0)) continue;
        const cvx = vx + wy * rz - wz * ry;
        const cvy = vy + wz * rx - wx * rz;
        const cvz = vz + wx * ry - wy * rx;
        const vn = cvx * nx + cvy * ny + cvz * nz;
        if (-vn > LIMITS.hull) {
          this.crash('impact');
          return;
        }
        if (kind === HULL_WING) {
          this.crash('wing');
          return;
        }
        if (kind === HULL_TOP) {
          this.crash('noseOver');
          return;
        }
        if (kind === HULL_BELLY && gs > 3) {
          this.crash('impact');
          return;
        }
        if (kind === HULL_TAIL) {
          if (depth > 0.15) {
            this.crash('impact');
            return;
          }
          this.tailStrike = true;
        }
        // scraping over the ground
        const N = Math.max(0, 2e5 * depth - 8000 * vn);
        const tvx = cvx - vn * nx;
        const tvy = cvy - vn * ny;
        const tvz = cvz - vn * nz;
        const fr = (-0.4 * N) / Math.max(Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz), 0.3);
        const gfx = nx * N + fr * tvx;
        const gfy = ny * N + fr * tvy;
        const gfz = nz * N + fr * tvz;
        GX += gfx;
        GY += gfy;
        GZ += gfz;
        GTx += ry * gfz - rz * gfy;
        GTy += rz * gfx - rx * gfz;
        GTz += rx * gfy - ry * gfx;
        any = true;
      }
    } else for (let i = 0; i < legs.length; i++) this.spinFree(i, h);
    this.contactAny = any;

    // ---- sum up: body forces into the world, the gear's torques into the body
    const FWx = R[0] * Fx + R[1] * Fy + R[2] * Fz + GX;
    const FWy = R[3] * Fx + R[4] * Fy + R[5] * Fz + GY;
    const FWz = R[6] * Fx + R[7] * Fy + R[8] * Fz + GZ;
    const TBx = Tx + R[0] * GTx + R[3] * GTy + R[6] * GTz;
    const TBy = Ty + R[1] * GTx + R[4] * GTy + R[7] * GTz;
    const TBz = Tz + R[2] * GTx + R[5] * GTy + R[8] * GTz;
    // what the pilot feels (everything but gravity), in the body: load factor and ball
    this.fsx = R[0] * FWx + R[3] * FWy + R[6] * FWz;
    this.fsy = R[1] * FWx + R[4] * FWy + R[7] * FWz;

    // ---- integrate (semi-implicit Euler)
    // Euler's equations with the propeller's angular momentum: it turns clockwise
    // seen from the cockpit, i.e. about the nose (−z), which gives the gyroscopic
    // moments (pitching up yaws to the right).
    const I = this.inertia;
    const Lx = I[0] * ox;
    const Ly = I[1] * oy;
    const Lz = I[2] * oz - PROP.inertia * this.omegaE;
    let nox = ox + ((TBx - (oy * Lz - oz * Ly)) / I[0]) * h;
    let noy = oy + ((TBy - (oz * Lx - ox * Lz)) / I[1]) * h;
    let noz = oz + ((TBz - (ox * Ly - oy * Lx)) / I[2]) * h;
    const ol = Math.sqrt(nox * nox + noy * noy + noz * noz);
    if (ol > 12) {
      const k = 12 / ol;
      nox *= k;
      noy *= k;
      noz *= k;
    }
    this.omega.x = nox;
    this.omega.y = noy;
    this.omega.z = noz;
    let nvx = vx + (FWx / m) * h;
    let nvy = vy + (FWy / m - G) * h;
    let nvz = vz + (FWz / m) * h;
    const vl = Math.sqrt(nvx * nvx + nvy * nvy + nvz * nvz);
    if (vl > 250) {
      const k = 250 / vl;
      nvx *= k;
      nvy *= k;
      nvz *= k;
    }
    this.vel.x = nvx;
    this.vel.y = nvy;
    this.vel.z = nvz;
    this.pos.x = px + nvx * h;
    this.pos.y = py + nvy * h;
    this.pos.z = pz + nvz * h;
    // dq/dt = ½ q ⊗ (ω, 0) with body rates
    const q = this.q;
    const qx = q[0];
    const qy = q[1];
    const qz = q[2];
    const qw = q[3];
    q[0] = qx + 0.5 * h * (qw * nox + qy * noz - qz * noy);
    q[1] = qy + 0.5 * h * (qw * noy + qz * nox - qx * noz);
    q[2] = qz + 0.5 * h * (qw * noz + qx * noy - qy * nox);
    q[3] = qw - 0.5 * h * (qx * nox + qy * noy + qz * noz);
    const ql = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1;
    q[0] /= ql;
    q[1] /= ql;
    q[2] /= ql;
    q[3] /= ql;
  }

  /** A wheel off the ground runs down slowly, or stops at once when braked. */
  private spinFree(i: number, h: number): void {
    const l = this.legs[i];
    const brake = l.side < 0 ? this.cBrakeL : l.side > 0 ? this.cBrakeR : 0;
    const held = l.side !== 0 && (brake > 0.05 || this.cPark);
    const w = held ? 0 : this.wheelW[i] * (1 - Math.min(1, 0.3 * h));
    this.wheelW[i] = w;
    this.wheels[i].spin += w * h;
  }

  /** Values for the instruments and the limits, once per step. */
  private derive(dt: number): void {
    this.updateRot();
    const R = this.R;
    // the lowest wheel above the ground below it
    let agl = Infinity;
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i];
      const y = l.y + this.wheels[i].compression;
      const wx = this.pos.x + R[0] * l.x + R[1] * y + R[2] * l.z;
      const wy = this.pos.y + R[3] * l.x + R[4] * y + R[5] * l.z - l.radius;
      const wz = this.pos.z + R[6] * l.x + R[7] * y + R[8] * l.z;
      const d = wy - this.planeY(wx, wz);
      if (d < agl) agl = d;
      this.wheels[i].steer = l.steers ? this.steerAng : 0;
    }
    this.aglV = agl > 0 ? agl : 0;
    if (this.crashed) {
      this.warnV = false;
      return;
    }
    // stall warning: the vane at the leading edge, some 2° before the critical angle
    const flap = this.spec.flapsMax > 0 ? this.flapDeg / this.spec.flapsMax : 0;
    this.warnV = this.tasV > 12 && this.alphaV > AERO.alphaCrit + AERO.flapAlpha * flap - AERO.warn;
    // load factor, and the ball: it hangs in the direction of everything the pilot feels but gravity
    const mg = this.mass * G;
    this.nzV = this.fsy / mg;
    const lean = Math.atan2(-this.fsx, Math.abs(this.fsy) + 1e-3 * mg);
    this.ball += (clamp(lean / 0.26, -1, 1) - this.ball) * Math.min(1, dt / 0.3);
    // what the airframe does not survive
    if (this.ias > LIMITS.overspeed * this.spec.vne) this.crash('overspeed');
    else if (!this.contactAny && (this.nzV > LIMITS.gMax || this.nzV < LIMITS.gMin)) {
      this.gTime += dt;
      if (this.gTime > 0.15) this.crash('overspeed');
    } else this.gTime = 0;
  }

  // ---------------------------------------------------------------------------
  // what the game reads

  /** indicated airspeed (m/s) */
  get ias(): number {
    return this.tasV * Math.sqrt(this.rho / RHO0);
  }
  /** true airspeed (m/s) */
  get tas(): number {
    return this.tasV;
  }
  get groundSpeed(): number {
    return Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
  }
  /** m above sea level */
  get altitude(): number {
    return this.pos.y;
  }
  /** from the lowest wheel to the ground below (m) */
  get agl(): number {
    return this.aglV;
  }
  get verticalSpeed(): number {
    return this.vel.y;
  }
  /** compass degrees 0…360 (0 north, 90 east) */
  get heading(): number {
    const q = this.q;
    const fx = -2 * (q[0] * q[2] + q[1] * q[3]);
    const fz = -(1 - 2 * (q[0] * q[0] + q[1] * q[1]));
    const d = Math.atan2(fx, -fz) / DEG;
    return d < 0 ? d + 360 : d;
  }
  /** game convention: 0 north, + left (rad) */
  get yaw(): number {
    const q = this.q;
    const fx = -2 * (q[0] * q[2] + q[1] * q[3]);
    const fz = -(1 - 2 * (q[0] * q[0] + q[1] * q[1]));
    return Math.atan2(-fx, -fz);
  }
  /** rad, + nose up */
  get pitch(): number {
    const q = this.q;
    return Math.asin(clamp(-2 * (q[1] * q[2] - q[0] * q[3]), -1, 1));
  }
  /** rad, + right wing down */
  get bank(): number {
    const q = this.q;
    const rightY = 2 * (q[0] * q[1] + q[2] * q[3]);
    const upY = 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
    return Math.atan2(-rightY, upY);
  }
  /** inclinometer ball, -1…1, + = ball to the right */
  get slip(): number {
    return this.ball;
  }
  /** angle of attack (rad) */
  get aoa(): number {
    return this.alphaV;
  }
  /** sideslip (rad, + = the air comes from the right) */
  get sideslip(): number {
    return this.betaV;
  }
  /** rad/s, + = turning right */
  get turnRate(): number {
    const q = this.q;
    const o = this.omega;
    const r3 = 2 * (q[0] * q[1] + q[2] * q[3]);
    const r4 = 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
    const r5 = 2 * (q[1] * q[2] - q[0] * q[3]);
    return -(r3 * o.x + r4 * o.y + r5 * o.z);
  }
  get rpm(): number {
    return this.omegaE * RPM;
  }
  get engineRunning(): boolean {
    return this.running;
  }
  /** power at the propeller shaft (W) */
  get enginePower(): number {
    return this.running ? this.qEngine * this.omegaE : 0;
  }
  /** thrust of the propeller (N, negative when it windmills) */
  get propThrust(): number {
    return this.thrust;
  }
  /** litres per hour */
  get fuelFlow(): number {
    return this.fuelFlowLh;
  }
  get onGround(): boolean {
    return this.contactAny;
  }
  get stallWarning(): boolean {
    return this.warnV;
  }
  /** the wing is past its critical angle */
  get stalled(): boolean {
    return this.tasV > 10 && this.stallV > 0;
  }
  /** g, 1 in level flight and standing */
  get loadFactor(): number {
    return this.nzV;
  }
  /** accumulated rad */
  get propAngle(): number {
    return this.propAng;
  }
  get flapsDeg(): number {
    return this.flapDeg;
  }
  /**
   * Deflections as they are (rad): elevator + = trailing edge up (nose up),
   * trim included; aileron + = right aileron up, left down (rolling right);
   * rudder + = trailing edge to the right (yawing right).
   */
  get surfaces(): { elevator: number; aileron: number; rudder: number } {
    const s = this.surf;
    s.elevator = this.dE;
    s.aileron = this.dA;
    s.rudder = this.dR;
    return s;
  }
}

/** out = a · b (quaternions [x, y, z, w]); out may be a or b. */
function quatMul(a: readonly number[], b: readonly number[], out: number[]): void {
  const x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1];
  const y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0];
  const z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3];
  const w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
}
