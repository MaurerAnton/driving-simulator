// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The autopilot of the light aeroplane (sim/flight.ts): it flies the
 * aeroplane by itself, as the demonstration drives drive the car and the
 * tram – the take-off, climbing and holding a heading and a height, flying
 * to a place and circling it, the circuit, the approach, the landing and the
 * roll-out to a stop.  And, below it, the assist (FlightAssist): help for
 * the player's own hands – a softer stick, the rudder kept coordinated, the
 * wings brought level when the stick is let go, no stall and no overspeed.
 *
 * Both only decide.  Every step they read the aeroplane's instruments and
 * fill in the controls – the FlightControls the game builds from the
 * player's stick, the flaps on the lever's detents 0°, 10°, 20°, 30° – and
 * whoever uses them steps the aeroplane.  No DOM, no randomness: the same
 * flight gives the same controls.
 *
 * The autopilot flies the way an instructor describes it, as loops inside
 * each other:
 *
 *  - Sideways: the way over the ground (the track) gives a bank angle, the
 *    bank angle the ailerons; the rudder keeps the ball in the middle.  A leg
 *    from one point to the next is flown by aiming at the line some seconds
 *    ahead, and a turn onto the next leg begins early by the turn's radius,
 *    so that it rolls out on the new line rather than beyond it.
 *  - Up and down: the elevator sets the pitch attitude.  The attitude comes
 *    either from the airspeed – climbing at full power, the nose up when too
 *    fast – or from a vertical speed: to hold a height or to follow the
 *    glide path the nose sets the path and the throttle the speed.  The trim
 *    is what level flight at the target speed needs (Aircraft.levelFlight),
 *    so the elevator works near the middle.
 *  - On the runway: the rudder steers the nose wheel along the centre line,
 *    the ailerons keep the wings level, the brakes stop it.
 *
 * Its limits: 25° of bank, −10° … +15° of pitch, the angle of attack kept
 * 3° below the stall, the airspeed never far below 1.2 times the stall speed
 * of the flaps that are out nor above 85 % of vne.  En route (height hold,
 * circling, the sightseeing route) it keeps 150 m (500 ft, the legal minimum
 * over open country) above the highest ground in the next 3 km.
 *
 * The circuit it flies (and joins to land) is a flying school's: left-hand
 * unless it comes from the right, 1000 ft above the field, the downwind leg
 * 1 km beside the runway, a 2.6 km final on a 3° glide path; flaps 10° about
 * abeam the threshold, 20° on base, 30° on the final.  The approach is
 * checked at 100 ft (lined up, on the path, at the right speed) and a landing
 * that would end beyond the runway is not tried: both become a go-around and
 * another circuit; after three attempts it circles the field.
 */
import type { AirfieldJson, RunwayJson } from '../world/types.ts';
import { runwayEnd } from './airfield.ts';
import { AERO, PROP, airDensity, liftCurve, maxLift } from './flight.ts';
import type { Aircraft, FlightControls } from './flight.ts';
import { TRAINER } from './flightspec.ts';
import type { AircraftGeometry } from './flightspec.ts';
import type { Ground, GroundSample } from './vehicle/types.ts';

const DEG = Math.PI / 180;
const G = 9.81;
const FT = 0.3048;
const RHO0 = 1.225;

/** Limits, the measures of the circuit, and the gains of the loops. */
export const AUTOPILOT = {
  /** greatest bank (rad): in turns, below `low` m above the field, in the flare */
  bankMax: 25 * DEG,
  bankLow: 10 * DEG,
  low: 30,
  bankFlare: 4 * DEG,
  /** bank the turns from one leg to the next are planned with (rad): less than the greatest, to have some left to correct */
  bankPlan: 20 * DEG,
  /** pitch attitude it commands at most (rad), and how far below the critical angle of attack it stays */
  pitchMin: -10 * DEG,
  pitchMax: 15 * DEG,
  aoaMargin: 3 * DEG,
  /** fastest change of the bank (rad/s), of the commanded vertical speed (m/s²), of the throttle (1/s) and of the trim (1/s) */
  rollRate: 10 * DEG,
  vsRate: 1,
  throttleRate: 0.5,
  trimRate: 0.3,
  /** take-off: the attitude the nose is raised to at vr (rad) and how fast (rad/s); the climb right after lift-off (m/s) */
  rotatePitch: 8 * DEG,
  rotateRate: 4 * DEG,
  liftoffClimb: 1.5,
  /** heights above the field (m): the flaps come up after a take-off, the take-off is over, a plain take-off climbs to */
  flapsUp: 100,
  departed: 150,
  departHeight: 1500 * FT,
  /** the circuit: height above the field, the downwind leg's distance from the centre line, the length of the final, how far beyond the runway's end the crosswind leg is (m) */
  circuitHeight: 1000 * FT,
  downwind: 1000,
  final: 2600,
  upwind: 600,
  /** glide path (rad); the gate where the approach must be stable and the flare height (m) */
  glide: 3 * DEG,
  gate: 100 * FT,
  flare: 6,
  /** where along the runway it aims: this share of its length, within these bounds (m) */
  aimShare: 0.15,
  aimMin: 60,
  aimMax: 250,
  /** circling a place: radius (m) */
  orbit: 800,
  /** en route never below this much above the ground ahead (m), looked for this far ahead (m) */
  clearance: 150,
  lookAhead: 3000,
  /** landing attempts before it gives up and circles the field */
  attempts: 3,
  /** a height change bigger than this (m) is a climb at full power and climb speed, ended this close to the target */
  climbStart: 60,
  climbEnd: 20,
  /** greatest vertical speeds holding or changing height (m/s) */
  vsUp: 2.5,
  vsDown: 3.5,
};

/** The speeds it flies (indicated, m/s), from the aeroplane's figures. */
export interface AutopilotSpeeds {
  climb: number;
  cruise: number;
  /** clean in the circuit, with 10°, 20° and 30° of flap on the approach, over the threshold */
  circuit: number;
  flaps10: number;
  flaps20: number;
  final: number;
  ref: number;
  /** the flaps are put out only below this */
  flapsOut: number;
}

export function autopilotSpeeds(s: AircraftGeometry): AutopilotSpeeds {
  return {
    climb: s.vy,
    cruise: 0.9 * s.vcruise,
    circuit: 1.7 * s.vs1,
    flaps10: 1.55 * s.vs1,
    flaps20: 1.55 * s.vs0,
    final: 1.3 * s.vs0 + 3,
    ref: 1.3 * s.vs0,
    flapsOut: 2 * s.vs0,
  };
}

export type AutopilotMode = 'off' | 'takeoff' | 'hold' | 'goto' | 'land' | 'demo';

/**
 * What it is doing, for the HUD:
 *  - on the runway: 'lineup' (flaps set, brakes on), 'takeoffRoll', 'rotate', 'rejected' (stopping: the runway
 *    left would not have been enough), 'flare', 'rollout', 'stopped';
 *  - in the air: 'initialClimb' (after lift-off), 'climb' (to the height of a plain take-off), 'cruise' (heading
 *    and height hold), 'enroute' (to the place to circle), 'orbit', 'route' (the sightseeing waypoints), the legs of
 *    the circuit 'upwind', 'crosswind', 'downwind', 'base', 'final', and 'goAround';
 *  - 'crashed', 'off'.
 */
export type AutopilotPhase =
  | 'off'
  | 'lineup'
  | 'takeoffRoll'
  | 'rotate'
  | 'rejected'
  | 'initialClimb'
  | 'climb'
  | 'cruise'
  | 'enroute'
  | 'orbit'
  | 'route'
  | 'upwind'
  | 'crosswind'
  | 'downwind'
  | 'base'
  | 'final'
  | 'flare'
  | 'rollout'
  | 'stopped'
  | 'goAround'
  | 'crashed';

/** How it keeps the height: on the ground, climbing at full power, holding it, changing it, on the glide path, flaring. */
export type AutopilotVertical = 'ground' | 'climb' | 'hold' | 'descend' | 'glidePath' | 'flare';

export interface AutopilotWaypoint {
  x: number;
  z: number;
  /** m above sea level; left out: the height of the circuit */
  altitude?: number;
}

export interface AutopilotState {
  mode: AutopilotMode;
  phase: AutopilotPhase;
  vertical: AutopilotVertical;
  /** compass degrees it steers for: the track over the ground (the heading in heading hold and on the runway) */
  targetHeading: number;
  /** m above sea level (NaN on the ground) */
  targetAltitude: number;
  /** indicated airspeed it flies at (m/s; NaN on the ground) */
  targetSpeed: number;
  /** the flap lever it has set: 0…3 for 0°, 10°, 20°, 30° */
  flapNotch: number;
  /** where it flies to: the end of the leg, the place it circles, the aiming point on the runway (null: nowhere in particular; one object, updated in place) */
  waypoint: { x: number; z: number } | null;
  /** m to the waypoint – on an approach along the way to the aiming point (NaN: none) */
  distance: number;
  /** the waypoint of the sightseeing route flown to (0-based; = routeCount once they are done), and how many there are */
  routeIndex: number;
  routeCount: number;
  /** the runway of the take-off or landing as it is painted ("27"), '' if none */
  runway: string;
  /** landing attempt (1 on the first approach), go-arounds so far */
  attempt: number;
  goArounds: number;
  /** standing still at the end: landed, or a take-off stopped ('rejected' before) */
  done: boolean;
  /** the take-off was stopped on the runway: it would not have been long enough */
  rejected: boolean;
  /** it gave up landing after AUTOPILOT.attempts tries and circles the field */
  gaveUp: boolean;
}

type LegKind = 'route' | 'out' | 'upwind' | 'crosswind' | 'downwind' | 'base' | 'final';

interface Leg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** direction, length, compass course */
  ux: number;
  uz: number;
  len: number;
  course: number;
  kind: LegKind;
  /** m above sea level to fly it at (NaN: the plan's height) */
  alt: number;
}

/** A runway in the direction it is used: from its threshold (where the take-off begins, the landing aims) towards the far end. */
interface Rwy {
  name: string;
  tx: number;
  tz: number;
  ux: number;
  uz: number;
  len: number;
  course: number;
  /** aiming point: this far beyond the threshold (m) */
  aim: number;
  /** height of the touchdown zone (m), sampled from the ground */
  elev: number;
}

type LatMode = 'track' | 'heading' | 'ground' | 'wings';
type VertMode = 'ground' | 'pitch' | 'speed' | 'vs' | 'flare';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Compass degrees of a direction in the world (x east, z south). */
function compass(dx: number, dz: number): number {
  const d = Math.atan2(dx, -dz) / DEG;
  return d < 0 ? d + 360 : d;
}

function wrap180(d: number): number {
  d %= 360;
  return d > 180 ? d - 360 : d < -180 ? d + 360 : d;
}

function norm360(d: number): number {
  d %= 360;
  return d < 0 ? d + 360 : d;
}

function makeLeg(ax: number, az: number, bx: number, bz: number, kind: LegKind, alt = Number.NaN): Leg {
  const len = Math.hypot(bx - ax, bz - az);
  const ux = len > 1e-6 ? (bx - ax) / len : 0;
  const uz = len > 1e-6 ? (bz - az) / len : -1;
  return { ax, az, bx, bz, ux, uz, len, course: compass(ux, uz), kind, alt };
}

function frame(r: RunwayJson, second: boolean): Rwy {
  const [ax, az, bx, bz] = second ? [r.x2, r.z2, r.x1, r.z1] : [r.x1, r.z1, r.x2, r.z2];
  const len = Math.max(1, Math.hypot(bx - ax, bz - az));
  const ux = (bx - ax) / len;
  const uz = (bz - az) / len;
  const A = AUTOPILOT;
  return { name: runwayEnd(r, second), tx: ax, tz: az, ux, uz, len, course: compass(ux, uz), aim: clamp(A.aimShare * len, A.aimMin, A.aimMax), elev: Number.NaN };
}

/** A leg given in the runway's frame: `s` along it from the threshold, `v` to the right of the centre line. */
function runwayLeg(w: Rwy, s1: number, v1: number, s2: number, v2: number, kind: LegKind): Leg {
  return makeLeg(w.tx + w.ux * s1 - w.uz * v1, w.tz + w.uz * s1 + w.ux * v1, w.tx + w.ux * s2 - w.uz * v2, w.tz + w.uz * s2 + w.ux * v2, kind);
}

function along(w: Rwy, x: number, z: number): number {
  return (x - w.tx) * w.ux + (z - w.tz) * w.uz;
}

function across(w: Rwy, x: number, z: number): number {
  return -(x - w.tx) * w.uz + (z - w.tz) * w.ux;
}

const smp: GroundSample = { y: 0, nx: 0, ny: 1, nz: 0, grip: 1, rolling: 1 };

/** Height of the ground (the top surface) at (x, z). */
function groundY(ground: Ground, x: number, z: number): number {
  ground.sample(x, z, 1e4, smp);
  const y = smp.y;
  ground.sample(x, z, y + 1, smp);
  return Number.isFinite(smp.y) ? smp.y : y;
}

/** Angle of attack (rad) at which the wing gives the lift coefficient `cl` with the flaps at `f` (0…1); the critical angle if it cannot. */
function alphaFor(cl: number, f: number): number {
  let lo = AERO.alphaCritNeg;
  let hi = maxLift(f).alpha;
  if (liftCurve(hi, f).cl <= cl) return hi;
  if (liftCurve(lo, f).cl >= cl) return lo;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (liftCurve(m, f).cl < cl) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** Lift coefficient that carries the weight at `ias` (m/s) with `n` g. */
function liftNeeded(a: Aircraft, ias: number, n: number): number {
  return (n * a.mass * G) / (0.5 * RHO0 * Math.max(15, ias) ** 2 * a.spec.wingArea);
}

/**
 * The yaw rate (rad/s, body axes, + to the right) of a steady coordinated
 * turn at the present bank – not the measured one, which would also carry
 * the Dutch roll: what cancels the moments of the turn must not cancel the
 * aeroplane's own damping of that oscillation.
 */
function turnYawRate(a: Aircraft): number {
  return (G * Math.sin(a.bank) * Math.cos(a.pitch)) / Math.max(15, a.tas);
}

/**
 * Ailerons that hold a bank angle (rad): proportional, with the roll rate
 * damped – less the roll rate a steady turn has in the body axes, which is
 * not to be fought – and the rolling moment of the turn's yaw rate (the
 * outer wing is faster: the aeroplane tends to steepen its turns, more the
 * slower it flies) cancelled ahead with the flight model's own coefficients.
 * `integral` holds what is left: the engine's torque, which changes with the
 * power.
 */
function aileronFor(a: Aircraft, bank: number, integral: number): number {
  const s = a.spec;
  const rh = (turnYawRate(a) * s.span) / (2 * Math.max(15, a.tas));
  const cl = Math.min(1.6, liftNeeded(a, a.ias, Math.max(0.5, a.loadFactor)));
  const ff = (-(AERO.Clr0 + AERO.ClrCL * cl) * rh) / AERO.Clda / AERO.aileron;
  const p = -a.omega.z + a.turnRate * Math.sin(a.pitch);
  return clamp(3 * (bank - a.bank) - 0.6 * p + integral + ff, -1, 1);
}

/**
 * The rudder (−1…1) that keeps the ball in the middle: ahead, what cancels
 * the yawing moments the flight model knows of – the ailerons' adverse yaw
 * (`aileron` as commanded), the roll rate's, the damping of the turn's yaw
 * rate, the rigging, the propeller's swirl and P-factor –, and behind it the
 * sideslip that is left, fed back.
 */
function rudderFor(a: Aircraft, aileron: number): number {
  const s = a.spec;
  const V = Math.max(15, a.tas);
  const qbar = 0.5 * RHO0 * Math.max(15, a.ias) ** 2;
  const cl = Math.min(1.6, liftNeeded(a, a.ias, Math.max(0.5, a.loadFactor)));
  const ph = (-a.omega.z * s.span) / (2 * V);
  const rh = (turnYawRate(a) * s.span) / (2 * V);
  const cn = AERO.CnpCL * cl * ph + AERO.Cnr * rh + AERO.Cnda * aileron * AERO.aileron + AERO.rigYaw * (a.power / 160);
  const tp = Math.max(0, a.propThrust);
  const disk = (Math.PI * s.propDiameter * s.propDiameter) / 4;
  const tail = 1 + (PROP.slipstream * tp) / (disk * qbar);
  const yawLeft = tp * (PROP.swirl + PROP.pFactor * clamp(a.aoa, -0.3, 0.3));
  const dr = (yawLeft - qbar * s.wingArea * s.span * cn) / (tail * qbar * s.wingArea * s.span * AERO.Cndr);
  return clamp(dr / AERO.rudder + 3 * a.sideslip, -1, 1);
}

/** The pitch attitude (rad) to hold, from a command, within the limits; the angle of attack kept `margin` below the critical one. */
function protectPitch(a: Aircraft, cmd: number, lo: number, hi: number, margin: number): number {
  let lim = clamp(cmd, lo, hi);
  if (!a.onGround) {
    const flap = a.spec.flapsMax > 0 ? clamp(a.flapsDeg / a.spec.flapsMax, 0, 1) : 0;
    const top = AERO.alphaCrit + AERO.flapAlpha * flap - margin;
    if (a.aoa > top - 2 * DEG) lim = Math.min(lim, a.pitch - 1.5 * (a.aoa - (top - 2 * DEG)));
  }
  return lim;
}

/** Throttle and trim of level flight at an indicated speed, worked out now and then (Aircraft.levelFlight is not cheap). */
class LevelFlightCache {
  throttle = 0.5;
  trim = 0;
  private at = -1;
  private key = Number.NaN;

  get(a: Aircraft, ias: number, flap: number, t: number): void {
    const key = Math.round(ias * 2) * 1000 + Math.round(flap * 30);
    if (key === this.key && t < this.at) return;
    this.key = key;
    this.at = t + 2;
    const tas = ias * Math.sqrt(RHO0 / airDensity(a.altitude));
    const lf = a.levelFlight(tas, flap, a.altitude);
    this.throttle = lf.throttle;
    this.trim = lf.trim;
  }

  clear(): void {
    this.at = -1;
  }
}

export class FlightAutopilot {
  readonly spec: AircraftGeometry;
  readonly speeds: AutopilotSpeeds;
  /** the controls of the last step (one object, filled again every step) */
  readonly controls: FlightControls = { throttle: 0, elevator: 0, aileron: 0, rudder: 0, flaps: 1 / 3, trim: 0, brake: 0, parkingBrake: false, engineOn: true };
  /** what it is doing, for the HUD (one object, updated every step) */
  readonly state: AutopilotState = {
    mode: 'off',
    phase: 'off',
    vertical: 'ground',
    targetHeading: 0,
    targetAltitude: Number.NaN,
    targetSpeed: Number.NaN,
    flapNotch: 1,
    waypoint: null,
    distance: Number.NaN,
    routeIndex: 0,
    routeCount: 0,
    runway: '',
    attempt: 0,
    goArounds: 0,
    done: false,
    rejected: false,
    gaveUp: false,
  };

  // ---- what it was told
  private mode: AutopilotMode = 'off';
  private phase: AutopilotPhase = 'off';
  /** the next step begins the new task (the loops take over from where the aeroplane is) */
  private fresh = false;
  /** the pilot's throttle and trim to begin from (takeOver), else NaN */
  private handThrottle = Number.NaN;
  private handTrim = Number.NaN;
  /** the runway of the take-off and of the landing */
  private rwy: Rwy | null = null;
  /** the plan ends with a landing on `rwy` */
  private landing = false;
  private side = -1;
  private route: AutopilotWaypoint[] = [];
  private routeIdx = 0;
  private legs: Leg[] = [];
  private leg = 0;
  /** heading hold, the height to hold or climb to, the speed asked for (NaN: cruise) */
  private holdCourse = 0;
  private holdAlt = Number.NaN;
  private holdSpeed = Number.NaN;
  /** the place to circle, the radius, −1 left-hand, +1 right-hand */
  private cx = 0;
  private cz = 0;
  private orbitR = AUTOPILOT.orbit;
  private orbitDir = -1;
  private attempt = 0;
  private goArounds = 0;
  private gaveUp = false;
  private rejected = false;
  private gateDone = false;

  // ---- what it measures
  private readonly wheelDrop: number;
  private readonly noseWheel: number;
  private track = 0;
  /** where the aeroplane was at the last step (for the distances in the state), and the waypoint the state shows (one object, nothing allocated per step) */
  private posX = 0;
  private posZ = 0;
  private readonly wp = { x: 0, z: 0 };
  /** m left along the plan to the aiming point (landing), NaN otherwise */
  private dRem = Number.NaN;
  private elevAt = -1;
  private terrainAt = -1;
  private terrainFloor = -Infinity;

  // ---- the loops
  private t = 0;
  private phaseT = 0;
  private airT = 0;
  private flapT = 0;
  private vert: VertMode = 'ground';
  private vertical: AutopilotVertical = 'ground';
  private pitchCmd = 0;
  private pitchI = 0;
  private rotateFrom = 0;
  private flarePitch = 0;
  /** the ailerons' share that holds the bank against the engine's torque and the rigging */
  private ailI = 0;
  private vsCmd = 0;
  private bankCmd = 0;
  private turnDir = 0;
  private climbing = false;
  private climbSpeedReached = false;
  private thrI = 0;
  private thrFixed = true;
  private throttle = 0;
  private trim = 0;
  private notch = 1;
  private readonly lf = new LevelFlightCache();
  private ffClimb = 0.12;

  // ---- this step's targets (set by the guidance, flown by the loops)
  private readonly tg = {
    lat: 'wings' as LatMode,
    course: 0,
    bankMax: AUTOPILOT.bankMax,
    bankFF: 0,
    vert: 'ground' as VertMode,
    pitch: 0,
    vs: 0,
    speed: 0,
    /** a fixed throttle (0…1), or −1: the throttle holds `speed` */
    throttle: 0,
    brake: 0,
    park: false,
    altitude: Number.NaN,
  };

  constructor(spec: AircraftGeometry = TRAINER) {
    this.spec = spec;
    this.speeds = autopilotSpeeds(spec);
    let drop = 0;
    for (const g of spec.gear) drop = Math.max(drop, -g.y + g.radius - 0.4 * g.travel);
    this.wheelDrop = drop;
    this.noseWheel = spec.gear.findIndex((g) => g.steers);
  }

  // ---------------------------------------------------------------------------
  // what it is told

  /** Switched off: the controls are the pilot's again (`update` returns the last ones unchanged). */
  off(): void {
    this.mode = 'off';
    this.phase = 'off';
    this.publish();
  }

  /**
   * Take off from the runway's start (as runwayStart(runway, fromSecond)
   * places the aeroplane): flaps 10°, full power, along the centre line,
   * rotate at vr, climb at vy, flaps up – then climb on along the runway's
   * direction to `altitude` (m above sea level; by default 1500 ft above the
   * field) and hold it there: the mode becomes 'hold'.  Started in the air
   * it holds the runway's direction at the height it is at.
   */
  takeoff(runway: RunwayJson, fromSecond = false, altitude = Number.NaN): void {
    this.begin('takeoff');
    this.rwy = frame(runway, fromSecond);
    this.holdAlt = altitude;
  }

  /**
   * Hold a compass heading (degrees) and a height (m above sea level) at
   * `speed` (indicated m/s; by default cruise); turns the shorter way, climbs
   * at full power and climb speed when the height is far above.  Works from
   * wherever the aeroplane is – also right after Aircraft.placeInAir.
   */
  hold(heading: number, altitude: number, speed = Number.NaN): void {
    this.begin('hold');
    this.holdCourse = norm360(heading);
    this.holdAlt = altitude;
    this.holdSpeed = speed;
  }

  /** Fly to (x, z) at `altitude` (m above sea level) and circle it (left-hand unless `right`) at `radius` m. */
  goto(x: number, z: number, altitude: number, opts: { radius?: number; speed?: number; right?: boolean } = {}): void {
    this.begin('goto');
    this.cx = x;
    this.cz = z;
    this.holdAlt = altitude;
    this.holdSpeed = opts.speed ?? Number.NaN;
    this.orbitR = Math.max(300, opts.radius ?? AUTOPILOT.orbit);
    this.orbitDir = opts.right ? 1 : -1;
  }

  /**
   * Land on the runway in the direction runwayStart(runway, fromSecond)
   * would take off in: join the circuit (or come straight in from far out
   * on the extended centre line), approach on the 3° path with the flaps
   * out, flare, touch down on the main wheels, brake to a stop on the
   * centre line.  A go-around and another circuit when the approach is not
   * stable at 100 ft or the touchdown would come too late.
   */
  land(runway: RunwayJson, fromSecond = false): void {
    this.begin('land');
    this.rwy = frame(runway, fromSecond);
    this.landing = true;
  }

  /**
   * The demonstration flight: take off from the runway's start, fly the
   * circuit – or the sightseeing `route` first, then join the circuit – and
   * land again on the same runway in the same direction.  Started in the air
   * it leaves out the take-off.
   */
  demo(runway: RunwayJson, fromSecond = false, route: readonly AutopilotWaypoint[] = []): void {
    this.begin('demo');
    this.rwy = frame(runway, fromSecond);
    this.landing = true;
    this.route = route.map((p) => ({ ...p }));
  }

  /**
   * Begin from the pilot's controls as they are – the throttle lever, the
   * trim – rather than from those of level flight.  Call it after choosing
   * the task and before its first update.
   */
  takeOver(c: { throttle: number; trim: number }): void {
    this.handThrottle = c.throttle;
    this.handTrim = c.trim;
  }

  get engaged(): boolean {
    return this.mode !== 'off';
  }

  /** The flap lever it has set (0…3: 0°, 10°, 20°, 30°) – for the game's lever. */
  get flapNotch(): number {
    return this.notch;
  }

  private begin(mode: AutopilotMode): void {
    this.mode = mode;
    this.fresh = true;
    this.handThrottle = this.handTrim = Number.NaN;
    this.rwy = null;
    this.landing = false;
    this.route = [];
    this.routeIdx = 0;
    this.legs = [];
    this.leg = 0;
    this.holdAlt = Number.NaN;
    this.holdSpeed = Number.NaN;
    this.attempt = 0;
    this.goArounds = 0;
    this.gaveUp = false;
    this.rejected = false;
    this.gateDone = false;
    this.elevAt = -1;
    this.terrainAt = -1;
    this.terrainFloor = -Infinity;
    this.dRem = Number.NaN;
  }

  // ---------------------------------------------------------------------------
  // every step

  /**
   * The controls for this step: read the aeroplane, decide, return the
   * controls to step it with: Aircraft.step(dt, controls, ground).  `ground`
   * is the one the aeroplane is stepped on (the field's height is taken from
   * it).  The returned object is the autopilot's own and is reused.
   */
  update(a: Aircraft, dt: number, ground: Ground): FlightControls {
    const c = this.controls;
    if (!(dt > 0) || this.mode === 'off') return c;
    if (dt > 0.1) dt = 0.1;
    this.t += dt;
    this.phaseT += dt;
    this.flapT += dt;
    if (a.crashed) {
      this.setPhase('crashed');
      this.throttle = 0;
      c.throttle = 0;
      c.elevator = c.aileron = c.rudder = 0;
      c.brake = 0;
      this.publish();
      return c;
    }
    this.airT = a.onGround ? 0 : this.airT + dt;
    this.track = a.groundSpeed > 1 ? compass(a.vel.x, a.vel.z) : a.heading;
    this.posX = a.pos.x;
    this.posZ = a.pos.z;
    if (this.fresh) this.start(a, ground);
    if (this.rwy && this.t >= this.elevAt) {
      // (far from the field its ground may not be known yet: look again now and then)
      const w = this.rwy;
      w.elev = groundY(ground, w.tx + w.ux * w.aim, w.tz + w.uz * w.aim);
      this.elevAt = this.t + 2;
    }
    this.guide(a, ground);
    this.loops(a, dt);
    this.publish();
    return c;
  }

  /**
   * update() and Aircraft.step() together, in pieces of at most 1/30 s: for
   * callers whose frames are long (a slow phone), so that the loops still
   * run often enough.
   */
  fly(a: Aircraft, dt: number, ground: Ground): void {
    if (!(dt > 0)) return;
    const n = Math.ceil(dt * 30 - 1e-9);
    const h = dt / n;
    for (let i = 0; i < n; i++) a.step(h, this.update(a, h, ground), ground);
  }

  /** The first step of a task: take over from where the aeroplane is. */
  private start(a: Aircraft, ground: Ground): void {
    this.fresh = false;
    const w = this.rwy;
    if (w) {
      w.elev = groundY(ground, w.tx + w.ux * w.aim, w.tz + w.uz * w.aim);
      this.elevAt = this.t + 2;
    }
    const flap = this.spec.flapsMax > 0 ? clamp(a.flapsDeg / this.spec.flapsMax, 0, 1) : 0;
    this.notch = clamp(Math.round(flap * 3), 0, 3);
    this.flapT = 0;
    this.bankCmd = a.bank;
    this.ailI = 0;
    this.pitchCmd = a.pitch;
    this.pitchI = a.pitch;
    this.vsCmd = a.verticalSpeed;
    // (as if from the ground: whatever the first mode in the air is, it begins from the attitude the aeroplane has)
    this.vert = 'ground';
    this.climbing = false;
    this.climbSpeedReached = false;
    this.thrFixed = true;
    this.thrI = 0;
    this.turnDir = 0;
    this.lf.clear();
    this.ffClimb = (a.mass * G) / (0.7 * a.power * 735.5);
    // the throttle and the trim: the pilot's, else those of level flight as it flies now (or of the take-off)
    if (!a.onGround) this.lf.get(a, Math.max(a.ias, 1.2 * this.spec.vs1), flap, this.t);
    else this.lf.get(a, this.spec.vy, 1 / 3, this.t);
    this.throttle = Number.isFinite(this.handThrottle) ? clamp(this.handThrottle, 0, 1) : a.onGround ? 0 : this.lf.throttle;
    this.trim = Number.isFinite(this.handTrim) ? clamp(this.handTrim, -1, 1) : this.lf.trim;
    switch (this.mode) {
      case 'takeoff':
        if (a.onGround && w) return this.lineupFrom(a, ground);
        // already flying: on along the runway's direction at the height it is at
        this.mode = 'hold';
        this.holdCourse = w ? w.course : a.heading;
        if (!Number.isFinite(this.holdAlt)) this.holdAlt = a.altitude;
        this.setPhase('cruise');
        return;
      case 'demo':
        if (a.onGround && w) return this.lineupFrom(a, ground);
        this.attempt = 1;
        if (this.route.length > 0) this.routeLegs(a);
        else this.joinCircuit(a);
        return;
      case 'land':
        if (a.onGround) this.setPhase('rollout');
        else this.joinCircuit(a);
        return;
      case 'hold':
        if (!Number.isFinite(this.holdAlt)) this.holdAlt = a.altitude;
        this.setPhase(a.onGround ? 'stopped' : 'cruise');
        return;
      case 'goto':
        this.setPhase(a.onGround ? 'stopped' : 'enroute');
        return;
      default:
        return;
    }
  }

  /** On the runway: the take-off begins here – the height to climb to counts from where the aeroplane stands. */
  private lineupFrom(a: Aircraft, ground: Ground): void {
    if (!Number.isFinite(this.holdAlt) && this.mode === 'takeoff') this.holdAlt = groundY(ground, a.pos.x, a.pos.z) + this.wheelDrop + AUTOPILOT.departHeight;
    this.setPhase('lineup');
  }

  private setPhase(p: AutopilotPhase): void {
    if (this.phase !== p) this.phaseT = 0;
    this.phase = p;
  }

  // ---------------------------------------------------------------------------
  // guidance: what to fly this step

  private guide(a: Aircraft, ground: Ground): void {
    const tg = this.tg;
    tg.lat = 'wings';
    tg.course = a.heading;
    tg.bankMax = AUTOPILOT.bankMax;
    tg.bankFF = 0;
    tg.vert = 'ground';
    tg.pitch = 0;
    tg.vs = 0;
    tg.speed = this.speeds.cruise;
    tg.throttle = 0;
    tg.brake = 0;
    tg.park = false;
    tg.altitude = Number.NaN;
    this.dRem = Number.NaN;
    switch (this.phase) {
      case 'lineup':
        return this.lineup(a);
      case 'takeoffRoll':
        return this.takeoffRoll(a);
      case 'rotate':
        return this.rotate(a);
      case 'rejected':
      case 'rollout':
        return this.rollout(a);
      case 'stopped':
        return this.stopped(a);
      case 'initialClimb':
      case 'goAround':
        return this.climbOut(a);
      case 'climb':
        return this.departureClimb(a, ground);
      case 'cruise':
        return this.cruise(a, ground);
      case 'enroute':
      case 'orbit':
        return this.circle(a, ground);
      case 'flare':
        return this.flare(a);
      case 'route':
      case 'upwind':
      case 'crosswind':
      case 'downwind':
      case 'base':
      case 'final':
        return this.followPlan(a, ground);
      default:
        return;
    }
  }

  /** Flaps to 10°, engine running, on the brakes – then off. */
  private lineup(a: Aircraft): void {
    const tg = this.tg;
    this.notch = 1;
    this.onRunway(a);
    tg.brake = 1;
    const set = Math.abs(a.flapsDeg - this.spec.flapsMax / 3) < 0.5;
    if (set && a.engineRunning && this.phaseT > 1) this.setPhase('takeoffRoll');
  }

  /** Full power along the centre line; rotate at vr – or stop while the runway left is still enough to. */
  private takeoffRoll(a: Aircraft): void {
    const tg = this.tg;
    const w = this.rwy as Rwy;
    this.onRunway(a);
    tg.throttle = 1;
    const left = w.len - along(w, a.pos.x, a.pos.z);
    const gs = a.groundSpeed;
    // stopping from here takes about v²/(2·0.3 g) on the brakes
    if (a.ias < this.spec.vr - 1 && left < (gs * gs) / (2 * 0.3 * G) + 40) {
      this.rejected = true;
      this.setPhase('rejected');
      return this.rollout(a);
    }
    if (a.ias >= this.spec.vr) {
      this.setPhase('rotate');
      this.rotateFrom = a.pitch;
    }
  }

  /** Raise the nose firmly to the take-off attitude and let it fly off. */
  private rotate(a: Aircraft): void {
    const tg = this.tg;
    if (a.onGround) this.onRunway(a);
    else this.alongRunway(a, AUTOPILOT.bankFlare);
    tg.throttle = 1;
    tg.vert = 'pitch';
    tg.pitch = Math.min(AUTOPILOT.rotatePitch, this.rotateFrom + AUTOPILOT.rotateRate * this.phaseT);
    if (this.airT > 0.5) {
      this.climbSpeedReached = false;
      this.setPhase('initialClimb');
    }
  }

  /**
   * After lift-off and in a go-around: full power, a gentle climb until the
   * climb speed is there, then the nose for the speed; the flaps come up a
   * step at a time; straight ahead along the runway.
   */
  private climbOut(a: Aircraft): void {
    const tg = this.tg;
    const A = AUTOPILOT;
    const w = this.rwy as Rwy;
    const h = this.heightAboveField(a);
    this.alongRunway(a, h < A.low ? A.bankLow : A.bankMax);
    tg.throttle = 1;
    const ga = this.phase === 'goAround';
    // flaps: in a go-around 20° at once and 10° once climbing away; none at the flaps-up height
    if (ga && this.notch > 2) this.setNotch(2);
    if (ga && this.notch > 1 && h > 50 && a.verticalSpeed > 0.5 && this.flapT > 2) this.setNotch(1);
    if (this.notch > 0 && h > A.flapsUp && a.ias > this.spec.vy - 4 && this.flapT > 2) this.setNotch(0);
    const sp = this.speeds;
    const v = this.notch >= 2 ? sp.flaps20 : this.notch === 1 ? sp.climb - 2 : sp.climb;
    if (!this.climbSpeedReached && a.ias >= v - 4) this.climbSpeedReached = true;
    this.vertical = 'climb';
    tg.speed = v;
    if (this.climbSpeedReached) tg.vert = 'speed';
    else {
      // climbing a little more the more speed there is to spare – a weak engine needs its power to accelerate first
      const flap = this.spec.flapsMax > 0 ? clamp(a.flapsDeg / this.spec.flapsMax, 0, 1) : 0;
      const vmin = 1.2 * (this.spec.vs1 + (this.spec.vs0 - this.spec.vs1) * flap);
      tg.vert = 'vs';
      tg.vs = clamp(0.15 * (a.ias - vmin), 0.2, A.liftoffClimb + (ga ? 1 : 0));
    }
    tg.altitude = w.elev + this.wheelDrop + (this.landing ? A.circuitHeight : A.departHeight);
    if (h > A.departed && this.notch === 0) {
      if (ga) this.circuitAgain(a);
      else this.afterDeparture(a);
    }
  }

  /** The take-off is over: what comes next. */
  private afterDeparture(a: Aircraft): void {
    const w = this.rwy as Rwy;
    if (this.mode === 'takeoff') {
      this.legs = [runwayLeg(w, 0, 0, w.len + 100000, 0, 'out')];
      this.leg = 0;
      this.setPhase('climb');
      return;
    }
    // the demonstration: the route, else the circuit
    this.attempt = 1;
    if (this.route.length > 0) return this.routeLegs(a);
    this.side = -1;
    this.legs = this.circuit(w, Math.max(0, along(w, a.pos.x, a.pos.z)), this.side);
    this.leg = 0;
    this.setPhase('upwind');
  }

  /** The legs of the sightseeing route from where the aeroplane is. */
  private routeLegs(a: Aircraft): void {
    const w = this.rwy as Rwy;
    const legs: Leg[] = [];
    let x = a.pos.x;
    let z = a.pos.z;
    const alt0 = w.elev + this.wheelDrop + AUTOPILOT.circuitHeight;
    for (let i = this.routeIdx; i < this.route.length; i++) {
      const p = this.route[i];
      legs.push(makeLeg(x, z, p.x, p.z, 'route', p.altitude !== undefined && Number.isFinite(p.altitude) ? p.altitude : alt0));
      x = p.x;
      z = p.z;
    }
    this.legs = legs;
    this.leg = 0;
    this.setPhase('route');
  }

  /** After a plain take-off: on along the runway's direction, climbing to the height asked for, then holding it. */
  private departureClimb(a: Aircraft, ground: Ground): void {
    const tg = this.tg;
    const leg = this.legs[0];
    tg.lat = 'track';
    tg.course = this.legCourse(leg, a);
    this.cleanUp(a);
    const alt = Math.max(this.holdAlt, this.floor(a, ground));
    this.holdHeight(a, alt, this.speeds.cruise);
    if (Math.abs(alt - a.altitude) < 15) {
      this.mode = 'hold';
      this.holdCourse = leg.course;
      this.holdAlt = alt;
      this.setPhase('cruise');
    }
  }

  /** Heading and height hold. */
  private cruise(a: Aircraft, ground: Ground): void {
    const tg = this.tg;
    tg.lat = 'heading';
    tg.course = this.holdCourse;
    this.cleanUp(a);
    this.holdHeight(a, Math.max(this.holdAlt, this.floor(a, ground)), Number.isFinite(this.holdSpeed) ? this.holdSpeed : this.speeds.cruise);
  }

  /** To the place, then round it. */
  private circle(a: Aircraft, ground: Ground): void {
    const tg = this.tg;
    const dx = a.pos.x - this.cx;
    const dz = a.pos.z - this.cz;
    const r = Math.hypot(dx, dz);
    const gs = Math.max(20, a.groundSpeed);
    const L = Math.max(200, gs * 10);
    const e = r - this.orbitR;
    // along the circle with the centre on the inside – and back onto it when off it
    tg.lat = 'track';
    tg.course = norm360(compass(dx, dz) + this.orbitDir * (90 + Math.atan2(e, L) / DEG));
    tg.bankFF = this.orbitDir * Math.atan((gs * gs) / (G * this.orbitR)) * Math.max(0, 1 - Math.abs(e) / L);
    if (this.phase === 'enroute' && r < this.orbitR + 150) this.setPhase('orbit');
    this.cleanUp(a);
    const alt = Math.max(this.holdAlt, this.floor(a, ground));
    this.holdHeight(a, alt, Number.isFinite(this.holdSpeed) ? this.holdSpeed : this.speeds.cruise);
    // come down to land: once at the circuit's height (or as low as the ground around allows) and heading about downwind, join it
    const w = this.rwy;
    if (this.landing && w && a.altitude < alt + 30 && Math.abs(wrap180(this.track - w.course - 180)) < 60) this.joinCircuit(a);
  }

  /** The legs of a route or of the circuit; on the final, the approach. */
  private followPlan(a: Aircraft, ground: Ground): void {
    const tg = this.tg;
    const A = AUTOPILOT;
    const w = this.rwy as Rwy;
    this.sequence(a);
    // (the route ended far above the field: it circles down first)
    if (this.phase === 'enroute' || this.phase === 'orbit') return this.circle(a, ground);
    const leg = this.legs[this.leg];
    if (!leg) return;
    this.setPhase(leg.kind as AutopilotPhase);
    tg.lat = 'track';
    const gs = Math.max(20, a.groundSpeed);
    const final = leg.kind === 'final';
    tg.course = this.legCourse(leg, a, final ? Math.max(150, gs * 9) : Math.max(250, gs * 12));
    if (leg.kind === 'route') {
      this.cleanUp(a);
      this.holdHeight(a, Math.max(leg.alt, this.floor(a, ground)), this.speeds.cruise);
      return;
    }
    // the circuit: its height, and the glide path to the aiming point along the legs that are left
    const d = this.remaining(a);
    this.dRem = d;
    const base = w.elev + this.wheelDrop;
    const top = base + A.circuitHeight;
    const path = base + Math.max(0, d) * Math.tan(A.glide);
    const sp = this.speeds;
    // flaps and speed by the way left: 10° about abeam the threshold, 20° on base, 30° on the final
    const want = d > 6000 ? 0 : d > 4000 ? 1 : d > 2800 ? 2 : 3;
    if (want > this.notch && a.ias < sp.flapsOut && this.flapT > 2 && !this.climbing) this.setNotch(this.notch + 1);
    else if (want < this.notch && this.flapT > 2 && a.ias > (this.notch === 1 ? this.spec.vy - 4 : sp.flaps10)) this.setNotch(this.notch - 1);
    const h = this.heightAboveField(a);
    let v = this.notch === 0 ? sp.circuit : this.notch === 1 ? sp.flaps10 : this.notch === 2 ? sp.flaps20 : sp.final;
    if (final && this.notch === 3) v = sp.ref + (sp.final - sp.ref) * clamp((h - 10) / 30, 0, 1);
    if (path < top) this.holdHeight(a, path, v, -a.groundSpeed * Math.tan(A.glide), 0.15);
    else this.holdHeight(a, top, v);
    if (final) this.approach(a, h, path);
  }

  /** On the final: the gate at 100 ft, then the flare. */
  private approach(a: Aircraft, h: number, path: number): void {
    const A = AUTOPILOT;
    const w = this.rwy as Rwy;
    const tg = this.tg;
    if (h < 60) tg.bankMax = A.bankLow + (A.bankMax - A.bankLow) * clamp((h - A.low) / 30, 0, 1);
    if (!this.gateDone && h < A.gate) {
      this.gateDone = true;
      const off = Math.abs(across(w, a.pos.x, a.pos.z));
      const err = Math.abs(wrap180(this.track - w.course));
      const sp = this.speeds;
      const stable = off < 20 && err < 15 && Math.abs(a.altitude - path) < 15 && a.ias > sp.ref - 4 && a.ias < sp.final + 8 && this.notch === 3;
      if (!stable) return this.goAround(a);
    }
    if (a.agl < A.flare && h < 2 * A.flare && along(w, a.pos.x, a.pos.z) > -400) {
      this.setPhase('flare');
      this.flare(a);
    }
  }

  /** Idle, the sink brought down with the height to some 0.3 m/s at the wheels; a go-around if it floats too far. */
  private flare(a: Aircraft): void {
    const tg = this.tg;
    const w = this.rwy as Rwy;
    this.alongRunway(a, AUTOPILOT.bankFlare);
    this.vertical = 'flare';
    tg.vert = 'flare';
    tg.throttle = 0;
    tg.speed = this.speeds.ref;
    tg.altitude = w.elev + this.wheelDrop;
    if (this.mainContact(a)) {
      this.setPhase('rollout');
      return this.rollout(a);
    }
    // what is left of the runway must still stop it: about v²/(2·0.25 g) beyond the touchdown, which is some seconds away
    const left = w.len - along(w, a.pos.x, a.pos.z);
    const gs = a.groundSpeed;
    if (left < (gs * gs) / (2 * 0.25 * G) + gs * 3 + 30 || this.phaseT > 20) this.goAround(a);
  }

  /** On the runway after the touchdown (or stopping a take-off): the nose wheel down, the brakes, the centre line. */
  private rollout(a: Aircraft): void {
    const tg = this.tg;
    const w = this.rwy;
    if (w && this.phase === 'rollout' && !a.onGround && this.airT > 1 && a.agl > 2) {
      // bounced high: go round rather than come down hard
      return this.goAround(a);
    }
    if (w) this.onRunway(a);
    tg.throttle = 0;
    // the nose comes down gently
    tg.vert = 'pitch';
    tg.pitch = Math.max(0, Math.min(this.pitchCmd, a.pitch) - 1 * DEG);
    this.vertical = 'ground';
    const nose = this.noseWheel >= 0 ? a.wheels[this.noseWheel].contact : a.onGround;
    if (nose || this.phase === 'rejected') {
      const gs = a.groundSpeed;
      const left = w ? w.len - along(w, a.pos.x, a.pos.z) - 30 : Infinity;
      // firmly when the runway gets short, else as a pilot does
      tg.brake = left < (gs * gs) / (2 * 0.25 * G) ? 1 : 0.6;
    }
    if (a.groundSpeed < 0.3 && a.onGround) {
      this.setPhase('stopped');
      this.stopped(a);
    }
  }

  private stopped(a: Aircraft): void {
    const tg = this.tg;
    tg.throttle = 0;
    tg.brake = 1;
    tg.park = true;
    this.notch = 0;
    this.vertical = 'ground';
    if (this.rwy) this.onRunway(a);
  }

  /** Full power, climb away along the runway, then the circuit again. */
  private goAround(a: Aircraft): void {
    this.goArounds++;
    this.attempt++;
    this.gateDone = false;
    this.climbSpeedReached = false;
    this.setPhase('goAround');
    this.climbOut(a);
  }

  /** Climbed away from a go-around: another circuit – or, after too many, circle the field. */
  private circuitAgain(a: Aircraft): void {
    const w = this.rwy as Rwy;
    if (this.attempt > AUTOPILOT.attempts) {
      this.gaveUp = true;
      this.landing = false;
      this.mode = 'goto';
      this.cx = w.tx + w.ux * w.len * 0.5;
      this.cz = w.tz + w.uz * w.len * 0.5;
      this.holdAlt = w.elev + this.wheelDrop + AUTOPILOT.circuitHeight;
      this.orbitR = AUTOPILOT.orbit;
      this.orbitDir = this.side;
      this.setPhase('enroute');
      return;
    }
    this.legs = this.circuit(w, Math.max(0, along(w, a.pos.x, a.pos.z)), this.side);
    this.leg = 0;
    this.setPhase('upwind');
  }

  /** Join the circuit from wherever the aeroplane is (land mode, the end of the route). */
  private joinCircuit(a: Aircraft): void {
    const w = this.rwy as Rwy;
    const A = AUTOPILOT;
    const s = along(w, a.pos.x, a.pos.z);
    const v = across(w, a.pos.x, a.pos.z);
    const F = A.final;
    if (this.attempt === 0) this.attempt = 1;
    this.side = v > 0 ? 1 : -1;
    const top = w.elev + this.wheelDrop + A.circuitHeight;
    if (a.altitude > top + 150) {
      // far too high for the circuit: first down to its height circling beside the field, on the downwind side
      this.cx = w.tx + w.ux * w.len * 0.5 - w.uz * this.side * A.downwind;
      this.cz = w.tz + w.uz * w.len * 0.5 + w.ux * this.side * A.downwind;
      this.orbitR = A.orbit;
      this.orbitDir = this.side;
      this.holdAlt = top;
      this.holdSpeed = Number.NaN;
      this.setPhase('enroute');
      return;
    }
    // straight in: well out on the approach side, near the extended centre line, low enough for the glide path
    if (s < -F - 1000 && Math.abs(v) < 0.4 * -s && this.heightAboveField(a) < (w.aim - s) * Math.tan(A.glide) + 150) {
      this.legs = [runwayLeg(w, s - 500, 0, w.aim, 0, 'final')];
      this.leg = 0;
      this.setPhase('final');
      return;
    }
    // else onto the downwind leg on its side, abeam where it is (within the leg's ends)
    const D = this.side * A.downwind;
    const sj = clamp(s, -F + 1500, w.len + A.upwind);
    this.legs = [runwayLeg(w, sj, D, -F, D, 'downwind'), runwayLeg(w, -F, D, -F, 0, 'base'), runwayLeg(w, -F, 0, w.aim, 0, 'final')];
    this.leg = 0;
    this.setPhase('downwind');
  }

  /** The circuit from a point `from` m along the runway: upwind, crosswind, downwind, base, final. */
  private circuit(w: Rwy, from: number, side: number): Leg[] {
    const A = AUTOPILOT;
    const sc = Math.max(w.len + A.upwind, from + 1000);
    const D = side * A.downwind;
    const F = A.final;
    return [
      runwayLeg(w, 0, 0, sc, 0, 'upwind'),
      runwayLeg(w, sc, 0, sc, D, 'crosswind'),
      runwayLeg(w, sc, D, -F, D, 'downwind'),
      runwayLeg(w, -F, D, -F, 0, 'base'),
      runwayLeg(w, -F, 0, w.aim, 0, 'final'),
    ];
  }

  /** On to the next leg once the turn onto it has to begin; at the end of the route, join the circuit. */
  private sequence(a: Aircraft): void {
    const gs = Math.max(20, a.groundSpeed);
    const r = (gs * gs) / (G * Math.tan(AUTOPILOT.bankPlan));
    for (let guard = 0; guard < 16; guard++) {
      const leg = this.legs[this.leg];
      if (!leg || leg.kind === 'final') return;
      const s = (a.pos.x - leg.ax) * leg.ux + (a.pos.z - leg.az) * leg.uz;
      const next = this.legs[this.leg + 1];
      let lead: number;
      // the sights of a route are flown over; the corners of the circuit are cut by the turn
      if (leg.kind === 'route') lead = 100;
      else if (next) {
        const turn = Math.abs(wrap180(next.course - leg.course)) * DEG;
        lead = Math.min(r * Math.tan(Math.min(turn, 2.4) / 2), 2 * r);
      } else lead = Math.min(r, 300);
      if (s < leg.len - lead) return;
      if (leg.kind === 'route') this.routeIdx++;
      if (next) {
        this.leg++;
        continue;
      }
      // the last waypoint of the route is behind: to the field
      this.joinCircuit(a);
      return;
    }
  }

  /** Metres left along the plan to the aiming point. */
  private remaining(a: Aircraft): number {
    const leg = this.legs[this.leg];
    if (!leg) return Number.NaN;
    const s = (a.pos.x - leg.ax) * leg.ux + (a.pos.z - leg.az) * leg.uz;
    let d = leg.len - (leg.kind === 'final' ? s : clamp(s, 0, leg.len));
    for (let i = this.leg + 1; i < this.legs.length; i++) d += this.legs[i].len;
    return d;
  }

  // ---- helpers of the guidance

  /** The course that flies the aeroplane onto the leg's line: towards a point on it `look` m ahead. */
  private legCourse(leg: Leg, a: Aircraft, look = Math.max(250, a.groundSpeed * 12)): number {
    const dx = a.pos.x - leg.ax;
    const dz = a.pos.z - leg.az;
    const d = -dx * leg.uz + dz * leg.ux;
    return norm360(leg.course - Math.atan2(d, look) / DEG);
  }

  /** Steering on the runway: the nose wheel along the centre line, wings level. */
  private onRunway(a: Aircraft): void {
    const tg = this.tg;
    const w = this.rwy as Rwy;
    tg.lat = 'ground';
    tg.course = norm360(w.course - Math.atan2(across(w, a.pos.x, a.pos.z), Math.max(20, 2 * a.groundSpeed)) / DEG);
    tg.vert = 'ground';
    tg.pitch = 0;
    this.vertical = 'ground';
  }

  /** In the air close to the runway: along its centre line (extended), with little bank. */
  private alongRunway(a: Aircraft, bankMax: number): void {
    const tg = this.tg;
    const w = this.rwy as Rwy;
    tg.lat = 'track';
    tg.course = norm360(w.course - Math.atan2(across(w, a.pos.x, a.pos.z), Math.max(100, a.groundSpeed * 8)) / DEG);
    tg.bankMax = bankMax;
  }

  private setNotch(n: number): void {
    this.notch = clamp(n, 0, 3);
    this.flapT = 0;
  }

  /** Flaps up a step at a time once fast enough (cruise, circling, the route). */
  private cleanUp(a: Aircraft): void {
    if (this.notch > 0 && a.ias > 1.35 * this.spec.vs1 && this.flapT > 2) this.setNotch(this.notch - 1);
  }

  /**
   * The height: a climb at full power and climb speed to a target far
   * above, else the nose for a vertical speed – `vsFF` (the glide path's) and
   * what brings it to the target – and the throttle for the speed.
   */
  private holdHeight(a: Aircraft, alt: number, speed: number, vsFF = 0, gain = 0.12): void {
    const tg = this.tg;
    const A = AUTOPILOT;
    const err = alt - a.altitude;
    if (this.climbing) {
      if (err < A.climbEnd) this.climbing = false;
    } else if (err > A.climbStart) this.climbing = true;
    tg.altitude = alt;
    if (this.climbing) {
      this.vertical = 'climb';
      tg.vert = 'speed';
      tg.speed = this.speeds.climb;
      tg.throttle = 1;
      return;
    }
    this.vertical = vsFF < 0 ? 'glidePath' : err < -A.climbEnd ? 'descend' : 'hold';
    tg.vert = 'vs';
    tg.vs = vsFF < 0 ? clamp(vsFF + clamp(gain * err, -2.5, 2), -5, 2) : clamp(gain * err, -A.vsDown, A.vsUp);
    tg.speed = speed;
    tg.throttle = -1;
  }

  /** The lowest height en route: some clearance above the highest ground under the way ahead (looked at twice a second). */
  private floor(a: Aircraft, ground: Ground): number {
    if (this.t >= this.terrainAt) {
      this.terrainAt = this.t + 0.5;
      const A = AUTOPILOT;
      const tx = Math.sin(this.track * DEG);
      const tz = -Math.cos(this.track * DEG);
      let top = -Infinity;
      for (let d = 0; d <= A.lookAhead; d += 500) top = Math.max(top, groundY(ground, a.pos.x + tx * d, a.pos.z + tz * d));
      this.terrainFloor = top + this.wheelDrop + A.clearance;
    }
    return this.terrainFloor;
  }

  private heightAboveField(a: Aircraft): number {
    const w = this.rwy;
    return w && Number.isFinite(w.elev) ? a.altitude - this.wheelDrop - w.elev : a.agl;
  }

  private mainContact(a: Aircraft): boolean {
    for (let i = 0; i < a.wheels.length; i++) if (i !== this.noseWheel && a.wheels[i].contact) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // the loops: targets → controls

  private loops(a: Aircraft, dt: number): void {
    const A = AUTOPILOT;
    const tg = this.tg;
    const c = this.controls;
    const flap = this.spec.flapsMax > 0 ? clamp(a.flapsDeg / this.spec.flapsMax, 0, 1) : 0;
    const ias = a.ias;
    const p = -a.omega.z;
    const q = a.omega.x;

    // ---- sideways
    if (tg.lat === 'ground') {
      // the rudder steers the nose wheel to the heading that leads back onto the centre line; the wings level
      const e = wrap180(tg.course - a.heading);
      c.rudder = clamp(0.25 * e - 2 * a.turnRate, -1, 1);
      this.bankCmd = 0;
      this.turnDir = 0;
      c.aileron = clamp(2 * (0 - a.bank) - 0.4 * p, -1, 1);
    } else if (tg.lat === 'wings') {
      this.bankCmd = 0;
      c.aileron = clamp(2 * (0 - a.bank) - 0.4 * p, -1, 1);
      c.rudder = rudderFor(a, c.aileron);
    } else {
      const now = tg.lat === 'heading' || a.groundSpeed < 15 ? a.heading : this.track;
      let e = wrap180(tg.course - now);
      // the shorter way round – but a turn of about half a circle, once begun, is kept
      if (Math.abs(e) > 150 && this.turnDir !== 0 && Math.sign(e) !== this.turnDir) e -= 360 * Math.sign(e);
      this.turnDir = Math.abs(e) > 10 ? Math.sign(e) : 0;
      // (a degree short of the limit, so that what the bank overshoots by stays within it; eased in at the end of a roll)
      const most = Math.max(0, tg.bankMax - 1 * DEG);
      const want = clamp(1.1 * e * DEG + tg.bankFF, -most, most);
      const step = A.rollRate * dt;
      this.bankCmd = clamp(this.bankCmd + clamp((want - this.bankCmd) * 1.5 * dt, -step, step), -most, most);
      // (the integral only once the bank has arrived – while it rolls in, it would wind up and overshoot)
      const be = this.bankCmd - a.bank;
      if (Math.abs(be) < 2 * DEG && Math.abs(want - this.bankCmd) < 2 * DEG) this.ailI = clamp(this.ailI + 2 * be * dt, -0.2, 0.2);
      c.aileron = aileronFor(a, this.bankCmd, this.ailI);
      // the ball in the middle
      c.rudder = rudderFor(a, c.aileron);
    }

    // ---- up and down: the pitch attitude
    const prev = this.vert;
    const mode = tg.vert;
    let cmd: number;
    if (mode === 'ground' || mode === 'pitch') {
      cmd = tg.pitch;
    } else if (mode === 'flare') {
      if (prev !== 'flare') this.flarePitch = this.pitchCmd;
      const e = -Math.max(0.3, 0.3 * a.agl) - a.verticalSpeed;
      this.flarePitch = clamp(this.flarePitch + 0.03 * e * dt, -5 * DEG, 12 * DEG);
      cmd = this.flarePitch + 0.04 * e;
    } else if (mode === 'speed') {
      // raise the nose when too fast
      const e = ias - tg.speed;
      const pTerm = 0.02 * clamp(e, -10, 10);
      if (prev !== 'speed') this.pitchI = this.pitchCmd - pTerm;
      this.pitchI += 0.003 * e * dt;
      cmd = this.pitchI + pTerm;
    } else {
      // the path: the vertical speed asked for, within what the airspeed allows
      const vmin = 1.2 * (this.spec.vs1 + (this.spec.vs0 - this.spec.vs1) * flap);
      let vs = Math.min(tg.vs, 0.5 * (ias - vmin));
      vs = Math.max(vs, -0.5 * (0.85 * this.spec.vne - ias));
      if (prev !== 'vs') this.vsCmd = a.verticalSpeed;
      const step = A.vsRate * dt;
      this.vsCmd += clamp(vs - this.vsCmd, -step, step);
      // the attitude for it: the path's angle plus the angle of attack that carries the weight (more in a bank)
      const n = 1 / Math.max(0.5, Math.cos(a.bank));
      const ff = alphaFor(liftNeeded(a, ias, n), flap) + Math.asin(clamp(this.vsCmd / Math.max(15, a.tas), -0.5, 0.5));
      const e = this.vsCmd - a.verticalSpeed;
      const pTerm = 0.012 * clamp(e, -5, 5);
      if (prev !== 'vs') this.pitchI = this.pitchCmd - pTerm - ff;
      this.pitchI = clamp(this.pitchI + 0.005 * e * dt, -10 * DEG, 10 * DEG);
      cmd = ff + pTerm + this.pitchI;
    }
    // limits: the attitude, and the angle of attack some degrees below the stall
    const lim = mode === 'ground' ? cmd : protectPitch(a, cmd, A.pitchMin, A.pitchMax, A.aoaMargin);
    if (lim !== cmd && (mode === 'speed' || mode === 'vs')) this.pitchI += lim - cmd;
    this.pitchCmd = lim;
    this.vert = mode;
    if (this.phase === 'rotate') c.elevator = clamp(4 * (lim - a.pitch) - 1.5 * q, -1, 1);
    else {
      // (the turn's own pitch rate is not to be damped)
      const qTurn = a.turnRate * Math.sin(a.bank);
      c.elevator = clamp(2.5 * (lim - a.pitch) - (q - qTurn), -1, 1);
    }

    // ---- power
    let thr: number;
    if (tg.throttle >= 0) {
      thr = tg.throttle;
      this.thrFixed = true;
    } else {
      this.lf.get(a, tg.speed, flap, this.t);
      const e = tg.speed - ias;
      const ff = this.lf.throttle + this.ffClimb * this.vsCmd;
      const pTerm = 0.06 * clamp(e, -10, 10);
      if (this.thrFixed) this.thrI = clamp(this.throttle - ff - pTerm, -0.5, 0.5);
      this.thrFixed = false;
      const raw = ff + pTerm + this.thrI;
      // (no winding up against the stops)
      if ((raw < 1 || e < 0) && (raw > 0 || e > 0)) this.thrI = clamp(this.thrI + 0.012 * e * dt, -0.5, 0.5);
      thr = clamp(raw, 0, 1);
    }
    const ts = A.throttleRate * dt;
    this.throttle += clamp(thr - this.throttle, -ts, ts);
    c.throttle = this.throttle;

    // ---- trim: what level flight at the target speed needs (kept on the runway and in the flare)
    if (!a.onGround && mode !== 'flare') {
      this.lf.get(a, mode === 'speed' || mode === 'vs' ? tg.speed : Math.max(ias, this.spec.vs1), flap, this.t);
      const rs = A.trimRate * dt;
      this.trim += clamp(this.lf.trim - this.trim, -rs, rs);
    }
    c.trim = this.trim;

    c.flaps = this.notch / 3;
    c.brake = tg.brake;
    c.brakeLeft = 0;
    c.brakeRight = 0;
    c.parkingBrake = tg.park;
    c.engineOn = true;
  }

  // ---------------------------------------------------------------------------
  // what it tells

  private publish(): void {
    const s = this.state;
    const tg = this.tg;
    s.mode = this.mode;
    s.phase = this.phase;
    s.vertical = this.vertical;
    s.targetHeading = norm360(tg.course);
    s.targetAltitude = tg.altitude;
    s.targetSpeed = tg.vert === 'ground' || tg.vert === 'pitch' ? Number.NaN : tg.speed;
    s.flapNotch = this.notch;
    s.runway = this.rwy ? this.rwy.name : '';
    s.attempt = this.attempt;
    s.goArounds = this.goArounds;
    s.done = this.phase === 'stopped' && this.rwy !== null;
    s.rejected = this.rejected;
    s.gaveUp = this.gaveUp;
    s.routeCount = this.route.length;
    s.routeIndex = Math.min(this.routeIdx, this.route.length);
    s.waypoint = null;
    s.distance = Number.NaN;
    const w = this.rwy;
    const wp = this.wp;
    if (this.phase === 'enroute' || this.phase === 'orbit') {
      wp.x = this.cx;
      wp.z = this.cz;
      s.waypoint = wp;
      s.distance = Math.hypot(this.cx - this.posX, this.cz - this.posZ);
    } else if (w && Number.isFinite(this.dRem)) {
      wp.x = w.tx + w.ux * w.aim;
      wp.z = w.tz + w.uz * w.aim;
      s.waypoint = wp;
      s.distance = this.dRem;
    } else if (this.phase === 'route') {
      const leg = this.legs[this.leg];
      if (leg) {
        wp.x = leg.bx;
        wp.z = leg.bz;
        s.waypoint = wp;
        s.distance = Math.hypot(leg.bx - this.posX, leg.bz - this.posZ);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// which runway

/**
 * The runway the aeroplane stands on and which way along it it faces – as
 * runwayStart's `fromSecond` – for a take-off from where it is; null when it
 * is on none.
 */
export function runwayAt(fields: readonly AirfieldJson[], x: number, z: number, yaw: number): { field: AirfieldJson; runway: RunwayJson; fromSecond: boolean } | null {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  let best: { field: AirfieldJson; runway: RunwayJson; fromSecond: boolean } | null = null;
  let score = Infinity;
  for (const f of fields) {
    for (const r of f.runways) {
      const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
      if (len < 1) continue;
      const ux = (r.x2 - r.x1) / len;
      const uz = (r.z2 - r.z1) / len;
      const dx = x - r.x1;
      const dz = z - r.z1;
      const s = dx * ux + dz * uz;
      const v = -dx * uz + dz * ux;
      if (s < -30 || s > len + 30 || Math.abs(v) > r.w / 2 + 10) continue;
      const dot = fx * ux + fz * uz;
      // the one it is lined up with
      const k = Math.abs(v) + 100 * (1 - Math.abs(dot));
      if (k < score) {
        score = k;
        best = { field: f, runway: r, fromSecond: dot < 0 };
      }
    }
  }
  return best;
}

/**
 * A runway to land on: at the nearest airfield with one at least
 * `minLength` m long, its longest; of its two directions the one whose
 * approach the aeroplane at (x, z) is on the side of.
 */
export function landingRunway(fields: readonly AirfieldJson[], x: number, z: number, minLength = 400): { field: AirfieldJson; runway: RunwayJson; fromSecond: boolean; distance: number } | null {
  let best: { field: AirfieldJson; runway: RunwayJson; fromSecond: boolean; distance: number } | null = null;
  for (const f of fields) {
    let rw: RunwayJson | null = null;
    let longest = 0;
    for (const r of f.runways) {
      const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
      if (len >= minLength && len > longest) {
        longest = len;
        rw = r;
      }
    }
    if (!rw) continue;
    const mx = (rw.x1 + rw.x2) / 2;
    const mz = (rw.z1 + rw.z2) / 2;
    const d = Math.hypot(x - mx, z - mz);
    if (best && d >= best.distance) continue;
    // nearer the first end: land from it (towards the second)
    const toFirst = (x - mx) * (rw.x1 - mx) + (z - mz) * (rw.z1 - mz);
    best = { field: f, runway: rw, fromSecond: toFirst < 0, distance: d };
  }
  return best;
}

// ---------------------------------------------------------------------------
// the assist: help for the player's own hands

/** The player's stick and pedals, as the game reads them (Input.flightInput). */
export interface StickInput {
  /** −1…1, + = pulled (nose up) */
  pitch: number;
  /** −1…1, + = to the right */
  roll: number;
  /** −1…1 pedals, + = right */
  yaw: number;
}

export interface AssistOptions {
  /**
   * 0…1: how much the stick is softened – less movement round the middle
   * (an expo curve) and keys that push it over some tenths of a second
   * instead of all at once.
   */
  soften: number;
  /** the rudder keeps the ball in the middle by itself (the pedals add to it) */
  coordinate: boolean;
  /**
   * The stick asks for a roll and a pitch rate instead of moving the
   * surfaces: let go, the wings come level and the nose stays where it was
   * put – within 45° of bank and ±15° of pitch.
   */
  stabilize: boolean;
  /**
   * No stall, no overspeed, no more than 60° of bank, 30° of pitch and 3.5 g –
   * also without `stabilize`; above manoeuvring speed the stick moves the
   * elevator less, so that a full stick asks for about the same g at any speed.
   */
  protect: boolean;
  /** the trim follows the speed flown, so the stick can be let go (with `stabilize` it always does) */
  autoTrim: boolean;
}

/** Everything on: for the first flights. */
export const ASSIST_BEGINNER: AssistOptions = { soften: 0.6, coordinate: true, stabilize: true, protect: true, autoTrim: true };
/** The aeroplane as it is, with a softer stick, the rudder coordinated and the edges of the envelope guarded. */
export const ASSIST_LIGHT: AssistOptions = { soften: 0.35, coordinate: true, stabilize: false, protect: true, autoTrim: true };

/** Rates and limits of the assist. */
export const ASSIST = {
  /** stabilised: roll and pitch rate at full stick (rad/s); greatest bank and pitch (rad); the wings come level at (rad/s) */
  rollRate: 30 * DEG,
  pitchRate: 8 * DEG,
  bank: 45 * DEG,
  pitchUp: 15 * DEG,
  pitchDown: -15 * DEG,
  levelRate: 8 * DEG,
  /** protection: angle of attack kept this far below the critical one (rad); pitch and bank (rad); load factor (g); airspeed as a share of vne */
  aoaMargin: 3 * DEG,
  pitchMax: 30 * DEG,
  bankMax: 60 * DEG,
  gMax: 3.5,
  gMin: -1.5,
  vMax: 0.85,
};

/** A stick deflection (−1…1, anything else counts as 0) through an expo curve: `k` of it cubed, less movement round the middle. */
function expo(x: number, k: number): number {
  const v = Number.isFinite(x) ? clamp(x, -1, 1) : 0;
  return (1 - k) * v + k * v * v * v;
}

/**
 * Help for the player flying by hand.  Each step `apply` turns the stick
 * into elevator, ailerons, rudder and trim (throttle, flaps and brakes stay
 * the game's).  On the ground only the softening and the nose wheel's
 * steering from the stick (as the game has it) apply.
 */
export class FlightAssist {
  options: AssistOptions;
  private readonly spec: AircraftGeometry;
  /** the stick after softening */
  private sPitch = 0;
  private sRoll = 0;
  private sYaw = 0;
  /** stabilised: the attitude held (NaN: take the present one), and the ailerons' integral */
  private pitchRef = Number.NaN;
  private bankRef = 0;
  private ailI = 0;
  private trim = Number.NaN;
  private t = 0;
  private lastIas = Number.NaN;
  private iasRate = 0;
  private readonly lf = new LevelFlightCache();

  constructor(options: AssistOptions = ASSIST_BEGINNER, spec: AircraftGeometry = TRAINER) {
    this.options = { ...options };
    this.spec = spec;
  }

  /** Begin afresh from the aeroplane as it is (after a placement, after the autopilot flew), with the trim the lever has. */
  reset(trim = Number.NaN): void {
    this.sPitch = this.sRoll = this.sYaw = 0;
    this.pitchRef = Number.NaN;
    this.bankRef = 0;
    this.ailI = 0;
    this.trim = trim;
    this.lastIas = Number.NaN;
    this.iasRate = 0;
    this.lf.clear();
  }

  /**
   * Fill `out.elevator`, `out.aileron`, `out.rudder` and `out.trim` for this
   * step from the stick; `out.trim` is read first as the lever's trim when
   * the assist does not trim by itself.
   */
  apply(a: Aircraft, stick: StickInput, dt: number, out: FlightControls): void {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    this.t += dt;
    const o = this.options;
    const S = ASSIST;
    // ---- a softer stick: an expo curve, and keys that move it over some tenths of a second
    const k = 0.6 * clamp(o.soften, 0, 1);
    const rate = (8 - 6 * clamp(o.soften, 0, 1)) * dt;
    this.sPitch += clamp(expo(stick.pitch, k) - this.sPitch, -rate, rate);
    this.sRoll += clamp(expo(stick.roll, k) - this.sRoll, -rate, rate);
    this.sYaw += clamp(expo(stick.yaw, k) - this.sYaw, -rate, rate);
    if (!Number.isFinite(this.trim)) this.trim = clamp(Number.isFinite(out.trim) ? out.trim : 0, -1, 1);
    const p = -a.omega.z;
    const q = a.omega.x;

    if (a.onGround || a.crashed) {
      // on the runway: the stick as the game maps it (the nose wheel follows it), nothing held
      out.elevator = this.sPitch;
      out.aileron = this.sRoll;
      out.rudder = clamp(this.sYaw + this.sRoll * 0.9, -1, 1);
      out.trim = this.trim;
      this.pitchRef = Number.NaN;
      this.bankRef = a.bank;
      return;
    }
    const flap = this.spec.flapsMax > 0 ? clamp(a.flapsDeg / this.spec.flapsMax, 0, 1) : 0;
    const ias = a.ias;
    // how fast the airspeed changes (m/s², smoothed over half a second)
    if (Number.isFinite(this.lastIas)) this.iasRate += ((ias - this.lastIas) / dt - this.iasRate) * Math.min(1, dt / 0.5);
    this.lastIas = ias;
    let elevator: number;
    let aileron: number;
    if (o.stabilize) {
      if (Number.isNaN(this.pitchRef)) {
        this.pitchRef = clamp(a.pitch, S.pitchDown, S.pitchUp);
        this.bankRef = clamp(a.bank, -S.bank, S.bank);
      }
      // roll: the stick rolls at up to 30°/s; let go, the wings come level
      const rolling = Math.abs(this.sRoll) > 0.02;
      if (rolling) this.bankRef = clamp(this.bankRef + this.sRoll * S.rollRate * dt, -S.bank, S.bank);
      else this.bankRef -= clamp(this.bankRef, -S.levelRate * dt, S.levelRate * dt);
      const be = this.bankRef - a.bank;
      if (!rolling && Math.abs(be) < 2 * DEG) this.ailI = clamp(this.ailI + 2 * be * dt, -0.2, 0.2);
      aileron = aileronFor(a, this.bankRef, this.ailI);
      // pitch: the stick moves the attitude; let go, it stays – a little more nose up in a bank, to keep the height
      if (Math.abs(this.sPitch) > 0.02) this.pitchRef = clamp(this.pitchRef + this.sPitch * S.pitchRate * dt, S.pitchDown, S.pitchUp);
      const n = 1 / Math.max(0.5, Math.cos(a.bank));
      const turn = n > 1.001 ? alphaFor(liftNeeded(a, ias, n), flap) - alphaFor(liftNeeded(a, ias, 1), flap) : 0;
      let cmd = this.pitchRef + turn;
      if (o.protect) {
        cmd = protectPitch(a, cmd, -90 * DEG, 90 * DEG, S.aoaMargin + 1 * DEG);
        // too fast: the nose comes up until the speed is back below the limit
        const over = ias - S.vMax * this.spec.vne;
        if (over > -3) cmd = Math.max(cmd, a.pitch + 0.02 * (over + 3));
        // what the protection does is held, not fought when it ends
        if (cmd < this.pitchRef + turn - 1e-9 || cmd > this.pitchRef + turn + 1e-9) this.pitchRef = clamp(cmd - turn, S.pitchDown, S.pitchUp);
      }
      const qTurn = a.turnRate * Math.sin(a.bank);
      elevator = 2.5 * (cmd - a.pitch) - (q - qTurn);
    } else {
      // the stick as it is – guarded: above manoeuvring speed with less travel, so that a full stick asks for the same g at any speed
      const va = this.spec.vs1 * Math.sqrt(S.gMax);
      elevator = this.sPitch * (o.protect ? Math.min(1, (va / Math.max(ias, 1)) ** 2) : 1);
      aileron = this.sRoll;
    }
    if (o.protect) {
      // the angle of attack: no more pull than holds it some degrees below the stall – less still while the nose comes
      // up fast –, a push beyond; the same the other way round
      const top = AERO.alphaCrit + AERO.flapAlpha * flap - S.aoaMargin;
      const bottom = AERO.alphaCritNeg + S.aoaMargin;
      elevator = Math.min(elevator, -20 * (a.aoa - top) - q);
      elevator = Math.max(elevator, -20 * (a.aoa - bottom) - q);
      // the attitude: not beyond 30° up or down – and the faster it flies, the shallower the dive it allows
      const vLim = S.vMax * this.spec.vne;
      const dive = -S.pitchMax + (S.pitchMax - 10 * DEG) * clamp((ias - (vLim - 15)) / 15, 0, 1);
      elevator = Math.min(elevator, 2.5 * (S.pitchMax - a.pitch) - q);
      elevator = Math.max(elevator, 2.5 * (dive - a.pitch) - q);
      // the airframe: the load factor and the speed
      if (a.loadFactor > S.gMax) elevator -= 0.5 * (a.loadFactor - S.gMax);
      if (a.loadFactor < S.gMin) elevator += 0.5 * (S.gMin - a.loadFactor);
      // nearing the speed limit (looked at 2 s ahead) the stick's push fades out over the last 10 m/s; beyond it the nose comes up
      const over = ias + 2 * Math.max(0, this.iasRate) - vLim;
      if (over > -10) elevator = Math.max(elevator, over < 0 ? over / 10 : 0.06 * over);
      // bank: pushed back beyond 60°
      const b = Math.abs(a.bank) - S.bankMax;
      if (b > 0) aileron -= Math.sign(a.bank) * (2 * b + 0.3 * Math.max(0, Math.sign(a.bank) * p));
    }
    out.elevator = clamp(elevator, -1, 1);
    out.aileron = clamp(aileron, -1, 1);
    // the rudder: the pedals, and the ball kept in the middle (else a little rudder with the ailerons, as the game does)
    out.rudder = clamp(this.sYaw + (o.coordinate ? rudderFor(a, out.aileron) : 0.25 * this.sRoll), -1, 1);
    // the trim: what level flight at the speed flown needs – but never for less than 1.3 times the stall speed, so that
    // a slow aeroplane still wants to lower its nose
    if (o.autoTrim || o.stabilize) {
      this.lf.get(a, Math.max(ias, 1.3 * (this.spec.vs1 + (this.spec.vs0 - this.spec.vs1) * flap)), flap, this.t);
      const rs = 0.3 * dt;
      this.trim += clamp(this.lf.trim - this.trim, -rs, rs);
    } else this.trim = clamp(Number.isFinite(out.trim) ? out.trim : this.trim, -1, 1);
    out.trim = this.trim;
  }
}
