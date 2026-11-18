// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The basic driving tasks of the class B practical test ("Grundfahraufgaben",
 * Anlage 7 FeV, Nr. 2.1.4.2) on the practice yard, with the car.  The test
 * asks three of them: one of group a – reversing round a corner to the right
 * ("Fahren nach rechts rückwärts unter Ausnutzung einer Einmündung, Kreuzung
 * oder Einfahrt") or parallel parking ("Rückwärtsfahren in eine Parklücke,
 * Längsaufstellung") – and two of group b – turning round ("Umkehren"), bay
 * parking ("Einfahren in eine Parklücke, Quer- oder Schrägaufstellung") or
 * the emergency stop ("Abbremsen mit höchstmöglicher Verzögerung"):
 *
 *   – parallel parking into a gap between two parked cars, at most 30 cm
 *     from the kerb,
 *   – bay parking forwards and backwards between lines,
 *   – reversing round a corner to the right close to the kerb – and, as
 *     practice only (no basic task of class B), reversing straight along a
 *     marked lane,
 *   – turning round in a narrow street without touching the kerbs,
 *   – the emergency stop from 30 km/h at the instructor's signal,
 *   – and, as practice for the test drive (Nr. 2.1.5) but no basic task of
 *     class B, the hill start on a ramp of 10 %, with the handbrake, without
 *     rolling back.
 *
 * This file holds the layouts – in the yard's own frame, like those of the
 * class CE tasks (game/ce.ts) – and the judge of each task: pure logic, no
 * drawing.  The judge is told where the car stands, how fast it goes and
 * what the driver does with the brakes each moment; it says which step of
 * the guided task is next, what the instructor remarks, the faults, and in
 * the end a score with up to three stars.  game/drillplay.ts runs it in the
 * game, render/drillyard.ts draws what the yard of the CE tasks does not
 * have (parked cars, kerb stones, the ramp's sides).
 */
import { corners, offArea, wheelPoints } from './ce.ts';
import type { Box, Pose, TaskLayout } from './ce.ts';

export type DrillId = 'parallel' | 'bayFwd' | 'bayBack' | 'backStraight' | 'backCorner' | 'turn' | 'hill' | 'brake';
export const DRILL_IDS: readonly DrillId[] = ['parallel', 'bayFwd', 'bayBack', 'backStraight', 'backCorner', 'turn', 'hill', 'brake'];

/** What the judge needs of the vehicle: its outline and its wheels from the model origin (as in game/vehicles.ts). */
export interface CarShape {
  front: number;
  rear: number;
  hw: number;
  /** the axles: metres ahead (+) of the origin or behind */
  axles: readonly number[];
  /** half the track (the middle of the tyres) */
  track: number;
}

/** the compact car of class B (render/carBody.ts COMPACT_DIMS) */
export const CAR_SHAPE: CarShape = { front: 2.195, rear: 2.085, hw: 0.895, axles: [1.315, -1.315], track: 0.77 };

/**
 * A ramp: up from u0 to u1, level to u2, down to u3, `h` high, level
 * across from w0 to w1 and falling away beside that over `side` metres.
 */
export interface Hill {
  u0: number;
  u1: number;
  u2: number;
  u3: number;
  w0: number;
  w1: number;
  h: number;
  side: number;
}

/** How much the ramp raises the ground at a place of the yard (m). */
export function hillRise(h: Hill, u: number, w: number): number {
  let a: number;
  if (u <= h.u0 || u >= h.u3) return 0;
  if (u < h.u1) a = (u - h.u0) / (h.u1 - h.u0);
  else if (u <= h.u2) a = 1;
  else a = (h.u3 - u) / (h.u3 - h.u2);
  const out = w < h.w0 ? h.w0 - w : w > h.w1 ? w - h.w1 : 0;
  const b = Math.max(0, 1 - out / h.side);
  return h.h * a * b;
}

export interface DrillLayout extends TaskLayout {
  id: DrillId;
  /** what bounds the area: kerbs (touching one is a fault, driving over it fails) or painted lines */
  boundary: 'kerb' | 'line';
  /** kerb stones to draw: u0, w0, u1, w1 */
  kerbs: Array<[number, number, number, number]>;
  /** the parked cars (yard coordinates; hl along their heading) – touching one fails the task */
  parked: Box[];
  /** the ramp of the hill start */
  hill?: Hill;
  /** the guided steps: texts "drill.step.<id>" */
  steps: readonly string[];
  /** moves (forwards or backwards) the task itself takes; more are corrections (-1: not counted) */
  moves: number;
  /** seconds an unhurried driver needs */
  par: number;
  /** the camera's distance (m; 0: the vehicle's own) */
  zoom: number;
}

/** facing along +u, −u, −w, +w of the yard */
export const EAST = -Math.PI / 2;
export const WEST = Math.PI / 2;
export const NORTH = 0;
export const SOUTH = Math.PI;

export const MAX_CORRECTIONS = 2;

const wrap = (a: number): number => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

/** A parked car (4.3 × 1.8 m) standing at u, w. */
const parkedCar = (u: number, w: number, yaw: number): Box => ({ x: u, z: w, yaw, hl: 2.15, hw: 0.9 });

// ---- the layouts ------------------------------------------------------------------

/** the parallel parking street: kerb on the right (w), the gap's length for a car */
export const PARALLEL = { kerb: 6, gap: 6.2, from: -40, to: 30 };
/** the bay parking: the aisle up to w = 7, the bays behind it, 2.75 m wide and 5.5 m deep, the one to park in round u = 0 */
export const BAYS = { aisle: 7, depth: 5.5, width: 2.75 };
/** reversing round the corner to the right: the side road between u = −6 and 0, going off at w = 0 */
export const CORNER = { u0: -6, u1: 0, r: 4, len: 24 };
/** the hill start's line on the ramp (u) */
export const HILL_LINE = -2;
const HILL: Hill = { u0: -10, u1: 2.5, u2: 10, u3: 22.5, w0: -3.2, w1: 3.2, h: 1.25, side: 2.5 };
/** the emergency stop: at about 30 km/h (m/s), signalled once it has been held a moment */
export const BRAKE_SPEED = 30 / 3.6;

export function drillLayout(id: DrillId, shape: CarShape = CAR_SHAPE): DrillLayout {
  const base = { id, kerbs: [] as Array<[number, number, number, number]>, parked: [] as Box[], chamfers: [], cones: [] as Array<[number, number]>, goalMarked: false };
  if (id === 'parallel') {
    const P = PARALLEL;
    const K = P.kerb;
    const G = Math.max(P.gap, (shape.front + shape.rear) * 1.45);
    const mid = K - 0.25 - 0.9;
    return {
      ...base,
      boundary: 'kerb',
      // beside the car parked in front of the gap, the driver's side a little more than half a metre from it
      start: { x: P.from + 18, z: mid - 0.9 - 0.7 - shape.hw, yaw: EAST },
      allowed: [{ u0: P.from, u1: P.to, w0: 0, w1: K }],
      kerbs: [
        [P.from, K, P.to, K],
        [P.from, 0, P.to, 0],
      ],
      lines: [
        // the gap's ends, painted from the kerb out
        [0, K - 2.1, 0, K],
        [G, K - 2.1, G, K],
      ],
      cones: [
        [-4.6, K - 2.2],
        [G + 4.6, K - 2.2],
      ],
      parked: [parkedCar(-2.15, mid, EAST), parkedCar(G + 2.15, mid, EAST), parkedCar(-9.5, mid, EAST)],
      goal: { u0: 0, u1: G, w0: K - 2.8, w1: K },
      steps: ['pAlign', 'pTurnIn', 'pBack', 'pCounter', 'pFinish'],
      moves: 2,
      par: 90,
      zoom: 11,
    };
  }
  if (id === 'bayFwd' || id === 'bayBack') {
    const B = BAYS;
    const half = B.width / 2;
    const back = B.aisle + B.depth;
    // the lines between the five bays (the one to park in is the middle one)
    const lines: Array<[number, number, number, number]> = [];
    for (let k = -2; k <= 3; k++) lines.push([half + (k - 1) * B.width, B.aisle, half + (k - 1) * B.width, back]);
    const row = { u0: -half - 2 * B.width, u1: half + 2 * B.width, w0: B.aisle, w1: back };
    const midW = B.aisle + B.depth / 2;
    return {
      ...base,
      boundary: 'kerb',
      start: id === 'bayFwd' ? { x: -18, z: 2.6, yaw: EAST } : { x: -18, z: 3.5, yaw: EAST },
      allowed: [{ u0: -30, u1: 22, w0: 0, w1: B.aisle }, row],
      kerbs: [
        [-30, 0, 22, 0],
        [row.u0, back, row.u1, back],
        [-30, B.aisle, row.u0, B.aisle],
        [row.u1, B.aisle, 22, B.aisle],
        [row.u0, B.aisle, row.u0, back],
        [row.u1, B.aisle, row.u1, back],
      ],
      lines,
      // (the cars in the neighbouring bays: one parked forwards, one backwards)
      parked: [parkedCar(-B.width, midW, SOUTH), parkedCar(B.width, midW, NORTH), parkedCar(-2 * B.width, midW, SOUTH)],
      goal: { u0: -half, u1: half, w0: B.aisle, w1: back },
      goalMarked: true,
      steps: id === 'bayFwd' ? ['bfApproach', 'bfTurn', 'bfIn', 'bfStop'] : ['bbPast', 'bbTurn', 'bbIn', 'bbStop'],
      moves: id === 'bayFwd' ? 1 : 2,
      par: 60,
      zoom: 11,
    };
  }
  if (id === 'backStraight') {
    const lane = { u0: -32, u1: 8, w0: -1.5, w1: 1.5 };
    return {
      ...base,
      boundary: 'line',
      start: { x: 8 - shape.front - 0.6, z: 0, yaw: EAST },
      allowed: [lane],
      lines: [
        [lane.u0, lane.w0, lane.u1, lane.w0],
        [lane.u0, lane.w1, lane.u1, lane.w1],
        [lane.u0, lane.w0, lane.u0, lane.w1],
      ],
      cones: [
        [lane.u1, lane.w0 - 0.4],
        [lane.u1, lane.w1 + 0.4],
        [lane.u0, lane.w0 - 0.4],
        [lane.u0, lane.w1 + 0.4],
      ],
      goal: { u0: -31.5, u1: -23, w0: lane.w0, w1: lane.w1 },
      goalMarked: true,
      steps: ['bsGear', 'bsBack', 'bsStop'],
      moves: 1,
      par: 60,
      zoom: 9,
    };
  }
  if (id === 'backCorner') {
    const C = CORNER;
    const main = { u0: -40, u1: 30, w0: -6, w1: 0 };
    const side = { u0: C.u0, u1: C.u1, w0: 0, w1: C.len };
    const r = C.r;
    return {
      ...base,
      boundary: 'kerb',
      start: { x: -24, z: -1.6, yaw: EAST },
      allowed: [main, side],
      chamfers: [
        { u: C.u0, w: 0, du: -r, dw: r },
        { u: C.u1, w: 0, du: r, dw: r },
      ],
      kerbs: [
        [main.u0, main.w0, main.u1, main.w0],
        [main.u0, 0, C.u0 - r, 0],
        [C.u0 - r, 0, C.u0, r],
        [C.u0, r, C.u0, C.len],
        [C.u1 + r, 0, main.u1, 0],
        [C.u1 + r, 0, C.u1, r],
        [C.u1, r, C.u1, C.len],
      ],
      // the middle of the main road, and the end of the side road
      lines: [
        [main.u0, -3, C.u0 - r - 2, -3],
        [C.u1 + r + 2, -3, main.u1, -3],
        [C.u0, C.len, C.u1, C.len],
      ],
      cones: [
        [C.u0, C.len + 0.3],
        [C.u1, C.len + 0.3],
      ],
      goal: { u0: C.u0, u1: C.u1, w0: 1, w1: C.len },
      steps: ['bcPast', 'bcBack', 'bcTurn', 'bcIn'],
      moves: 2,
      par: 75,
      zoom: 11,
    };
  }
  if (id === 'turn') {
    const road = { u0: -40, u1: 40, w0: 0, w1: 7 };
    return {
      ...base,
      boundary: 'kerb',
      start: { x: -16, z: 5.0, yaw: EAST },
      allowed: [road],
      kerbs: [
        [road.u0, road.w0, road.u1, road.w0],
        [road.u0, road.w1, road.u1, road.w1],
      ],
      lines: [
        [road.u0, 3.5, -12, 3.5],
        [12, 3.5, road.u1, 3.5],
      ],
      cones: [
        [-10, 0.35],
        [-10, 6.65],
        [10, 0.35],
        [10, 6.65],
      ],
      goal: { u0: -40, u1: 40, w0: 0, w1: 3.5 },
      steps: ['tFwd', 'tBack', 'tAway'],
      moves: 3,
      par: 60,
      zoom: 11,
    };
  }
  if (id === 'hill') {
    // (the drawn asphalt is a grid of 2.5 m from u = −40: the ramp's bends lie on it)
    const lane = { u0: -38.8, u1: 38.8, w0: -2, w1: 2 };
    const lines: Array<[number, number, number, number]> = [];
    const at = [lane.u0, HILL.u0, HILL.u1, HILL.u2, HILL.u3, lane.u1];
    for (let i = 0; i + 1 < at.length; i++) for (const w of [lane.w0, lane.w1]) lines.push([at[i], w, at[i + 1], w]);
    lines.push([HILL_LINE, lane.w0, HILL_LINE, lane.w1]);
    return {
      ...base,
      boundary: 'line',
      start: { x: -32, z: 0, yaw: EAST },
      allowed: [lane],
      lines,
      cones: [
        [HILL.u0 - 0.5, lane.w0 - 0.6],
        [HILL.u0 - 0.5, lane.w1 + 0.6],
      ],
      hill: HILL,
      goal: { u0: HILL_LINE, u1: HILL.u2, w0: lane.w0, w1: lane.w1 },
      steps: ['hUp', 'hSecure', 'hGo'],
      moves: -1,
      par: 60,
      zoom: 0,
    };
  }
  // the emergency stop: a long lane
  const lane = { u0: -72, u1: 72, w0: -2, w1: 2 };
  return {
    ...base,
    id: 'brake',
    boundary: 'line',
    start: { x: -68, z: 0, yaw: EAST },
    allowed: [lane],
    lines: [
      [lane.u0, lane.w0, lane.u1, lane.w0],
      [lane.u0, lane.w1, lane.u1, lane.w1],
    ],
    cones: [
      [lane.u1, lane.w0],
      [lane.u1, lane.w1],
      [lane.u1, 0],
    ],
    goal: lane,
    steps: ['brSpeed', 'brStop'],
    moves: -1,
    par: 45,
    zoom: 0,
  };
}

// ---- judging ----------------------------------------------------------------------

/** What the judge is told each moment (the pose in yard coordinates, of the model origin). */
export interface DrillInput {
  pose: Pose;
  /** along the heading (m/s; negative: reversing) */
  speed: number;
  handbrake: boolean;
  /** the brake pedal, 0 … 1 */
  brake: number;
  engine: boolean;
}

export type DrillSeverity = 'minor' | 'major' | 'fail';

export interface DrillFault {
  id: string;
  severity: DrillSeverity;
  data: Record<string, number | string>;
}

export interface DrillStatus {
  state: 'run' | 'done' | 'failed';
  /** the guided step now (index into the layout's steps) */
  step: number;
  /** corrections so far (moves beyond those the task takes) */
  corrections: number;
  faults: DrillFault[];
  /** what the instructor says now (a text key; '' for nothing) and its values */
  remark: string;
  remarkData: Record<string, number | string>;
  /** the emergency stop: the instructor gives the signal in this step */
  signal: boolean;
  /** the car ran into a parked one: hold it where it is */
  stop: boolean;
  /** the distance to the kerb that counts (m; NaN where none counts) */
  kerb: number;
  /** the hill start: how far it rolled back (m) */
  rollback: number;
}

export interface DrillResult {
  id: DrillId;
  /** its name, a text key */
  text: string;
  time: number;
  score: number;
  stars: number;
  minor: number;
  major: number;
  failed: boolean;
  /** what was measured: a text key and its values */
  measure: string;
  measureData: Record<string, number | string>;
}

/** Do two rectangles given by their corners (x, z pairs) overlap? */
export function rectsOverlap(a: readonly number[], b: readonly number[]): boolean {
  for (const r of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const ax = r[((i + 1) % 4) * 2] - r[i * 2];
      const az = r[((i + 1) % 4) * 2 + 1] - r[i * 2 + 1];
      // the axis: the edge's normal
      const nx = -az;
      const nz = ax;
      let a0 = Infinity;
      let a1 = -Infinity;
      let b0 = Infinity;
      let b1 = -Infinity;
      for (let k = 0; k < 8; k += 2) {
        const pa = a[k] * nx + a[k + 1] * nz;
        const pb = b[k] * nx + b[k + 1] * nz;
        a0 = Math.min(a0, pa);
        a1 = Math.max(a1, pa);
        b0 = Math.min(b0, pb);
        b1 = Math.max(b1, pb);
      }
      if (a1 < b0 || b1 < a0) return false;
    }
  }
  return true;
}

/** a tyre this close to a kerb (m) touches it */
const KERB_NEAR = 0.1;

/** How far a point is from the nearest kerb of a layout (m). */
export function kerbDistance(lay: DrillLayout, u: number, w: number): number {
  let d = Infinity;
  for (const [u0, w0, u1, w1] of lay.kerbs) {
    const du = u1 - u0;
    const dw = w1 - w0;
    const t = Math.max(0, Math.min(1, ((u - u0) * du + (w - w0) * dw) / (du * du + dw * dw)));
    d = Math.min(d, Math.hypot(u - u0 - du * t, w - w0 - dw * t));
  }
  return d;
}

const severityPoints = (s: DrillSeverity): 'minor' | 'major' => (s === 'minor' ? 'minor' : 'major');

export class DrillJudge {
  readonly id: DrillId;
  readonly layout: DrillLayout;
  readonly shape: CarShape;
  readonly status: DrillStatus = { state: 'run', step: 0, corrections: 0, faults: [], remark: '', remarkData: {}, signal: false, stop: false, kerb: NaN, rollback: 0 };
  time = 0;
  minor = 0;
  major = 0;
  private readonly rand: () => number;
  private readonly parkedCorners: number[][];
  // the moves: the direction now (1, −1, 0 before the first), how far against it since
  private dir = 0;
  private against = 0;
  private moves = 0;
  // the boundary
  private onKerb = false;
  private outside = false;
  // standing still with the handbrake on, and whether the instructor has said why it is not done yet
  private held = 0;
  private told = false;
  // the hill start
  private ref = NaN;
  private secured = 0;
  private rollTold = false;
  /** the engine ran in the last step (null: not known yet – it may be started on the yard) */
  private engineWas: boolean | null = null;
  private hbTold = false;
  private pastTold = false;
  // the emergency stop
  private atSpeed = 0;
  private readonly delay: number;
  private signalT = -1;
  private v0 = 0;
  private run = 0;
  private reaction = -1;
  private maxBrake = 0;
  private stopDist = NaN;
  private ideal = NaN;

  constructor(id: DrillId, shape: CarShape = CAR_SHAPE, rand: () => number = Math.random) {
    this.id = id;
    this.shape = shape;
    this.layout = drillLayout(id, shape);
    this.rand = rand;
    this.parkedCorners = this.layout.parked.map((b) => corners(b, b.hl, b.hl, b.hw));
    this.delay = 1 + 2 * this.rand();
  }

  private fault(id: string, severity: DrillSeverity, data: Record<string, number | string> = {}): void {
    this.status.faults.push({ id, severity, data });
    if (severityPoints(severity) === 'minor') this.minor++;
    else this.major++;
    if (severity === 'fail') this.status.state = 'failed';
  }

  private say(key: string, data: Record<string, number | string> = {}): void {
    this.status.remark = key;
    this.status.remarkData = data;
  }

  /** The car's corners now (front left, front right, rear right, rear left: x, z pairs). */
  carCorners(p: Pose): number[] {
    return corners(p, this.shape.front, this.shape.rear, this.shape.hw);
  }

  update(s: DrillInput, dt: number): DrillStatus {
    const st = this.status;
    st.faults.length = 0;
    st.remark = '';
    st.remarkData = {};
    st.signal = false;
    st.stop = false;
    if (st.state !== 'run') return st;
    this.time += dt;
    const lay = this.layout;
    const p = s.pose;
    const tc = this.carCorners(p);

    // ---- the kerbs or the lines: what the wheels do (a body may swing over a kerb)
    const wheels = wheelPoints(p, { at: this.shape.axles, hw: this.shape.track + 0.1 });
    let off = 0;
    let touch = -Infinity;
    for (let i = 0; i < wheels.length; i += 2) {
      off = Math.max(off, offArea(lay, wheels[i], wheels[i + 1]));
      if (lay.boundary === 'kerb') touch = Math.max(touch, KERB_NEAR - kerbDistance(lay, wheels[i], wheels[i + 1]));
    }
    if (lay.boundary === 'kerb') {
      if (off > 0) touch = Math.max(touch, KERB_NEAR);
      if (off > 0.3) {
        this.fault('drillKerbOver', 'fail');
        this.say('drill.r.kerbOver');
        return st;
      }
      if (touch > 0 && !this.onKerb) {
        this.onKerb = true;
        this.fault('drillKerbTouch', 'minor');
        this.say('drill.r.kerb');
      } else if (touch <= -0.05) this.onKerb = false;
    } else {
      if (off > 2) {
        this.fault('drillLine', 'fail');
        return st;
      }
      if (off > 0.15 && !this.outside) {
        this.outside = true;
        this.fault('drillLine', 'major');
        this.say('drill.r.line');
      } else if (off < 0.05) this.outside = false;
    }

    // ---- the parked cars must not be touched
    for (const b of this.parkedCorners) {
      if (rectsOverlap(tc, b)) {
        st.stop = true;
        this.fault('drillTouch', 'fail');
        this.say('drill.r.touch');
        return st;
      }
    }

    // ---- the moves, and the corrections beyond those the task takes
    const step = s.speed * dt;
    if (Math.abs(s.speed) > 0.03) {
      const d = Math.sign(step);
      if (d === this.dir) this.against = 0;
      else {
        this.against += Math.abs(step);
        if (this.against > 0.4) {
          this.dir = d;
          this.against = 0;
          this.moves++;
          if (lay.moves >= 0 && this.moves > lay.moves) {
            st.corrections = this.moves - lay.moves;
            if (st.corrections > MAX_CORRECTIONS) {
              this.fault('drillCorrections', 'fail');
              this.say('drill.r.tooMany');
              return st;
            }
            this.say('drill.r.correction', { n: st.corrections, max: MAX_CORRECTIONS });
          }
        }
      }
    }

    if (this.id === 'hill') this.hill(s, dt);
    else if (this.id === 'brake') this.brake(s, dt);
    else this.manoeuvre(s, dt, tc);
    return st;
  }

  /** How many moves have been made (forwards and backwards in turn). */
  get moveCount(): number {
    return this.moves;
  }

  // ---- the parking and reversing tasks, and turning round

  private manoeuvre(s: DrillInput, dt: number, tc: number[]): void {
    const st = this.status;
    const p = s.pose;
    const sh = this.shape;
    const id = this.id;
    const stopped = Math.abs(s.speed) < 0.08;
    const dev = (yaw: number): number => Math.abs(wrap(p.yaw - yaw));
    const us = [tc[0], tc[2], tc[4], tc[6]];
    const ws = [tc[1], tc[3], tc[5], tc[7]];
    // (the rear corners: 4, 5 and 6, 7)
    const advance = (to: number): void => {
      if (st.step < to) st.step = to;
    };
    if (id === 'parallel') {
      const K = PARALLEL.kerb;
      const G = this.layout.goal.u1;
      st.kerb = Math.max(0, K - Math.max(...ws));
      if (st.step === 0 && ((stopped && p.x > G + sh.rear - 1.2 && p.x < G + sh.rear + 2 && dev(EAST) < 0.2) || this.moves >= 2)) advance(1);
      else if (st.step === 1 && dev(EAST) > 0.5) advance(2);
      else if (st.step === 2 && Math.max(tc[5], tc[7]) > K - 0.9) advance(3);
      else if (st.step === 3 && dev(EAST) < 0.1 && Math.min(tc[1], tc[3]) > K - 2.4) advance(4);
    } else if (id === 'bayFwd') {
      if (st.step === 0 && (p.x > -BAYS.width / 2 - 5 || dev(EAST) > 0.3)) advance(1);
      else if (st.step === 1 && dev(SOUTH) < 0.35) advance(2);
      else if (st.step === 2 && Math.min(tc[1], tc[3]) > BAYS.aisle + 2) advance(3);
    } else if (id === 'bayBack') {
      if (st.step === 0 && ((stopped && p.x > BAYS.width / 2 + sh.rear + 0.3) || this.moves >= 2)) advance(1);
      else if (st.step === 1 && dev(NORTH) < 0.35) advance(2);
      else if (st.step === 2 && Math.min(tc[5], tc[7]) > BAYS.aisle + 2) advance(3);
    } else if (id === 'backStraight') {
      if (st.step === 0 && this.moves >= 1 && s.speed < 0) advance(1);
      else if (st.step === 1 && Math.max(tc[4], tc[6]) < this.layout.goal.u1) advance(2);
    } else if (id === 'backCorner') {
      const C = CORNER;
      st.kerb = Math.max(0, C.u1 - Math.max(...us));
      if (st.step === 0 && ((stopped && p.x - sh.rear > C.u1 + 2 && dev(EAST) < 0.3) || this.moves >= 2)) advance(1);
      else if (st.step === 1 && p.x + Math.sin(p.yaw) * -sh.axles[1] < C.u1 + C.r + 0.5) advance(2);
      else if (st.step === 2 && dev(NORTH) < 0.35) advance(3);
    } else if (id === 'turn') {
      st.step = Math.max(0, Math.min(2, this.moves - 1));
      // turned round, in the lane on the right for the other way, not reversing: done
      if (dev(WEST) < 0.15 && p.z < 3.6 && s.speed > -0.05 && this.moves >= 3) {
        this.held += dt;
        if (this.held > 0.3) this.finish();
      } else this.held = 0;
      return;
    }

    // ---- standing in the end, with the handbrake on
    if (stopped && s.handbrake) this.held += dt;
    else {
      this.held = 0;
      this.told = false;
    }
    if (this.held < 0.8) return;
    const why = this.whyNot(p, tc);
    if (!why) {
      if (id === 'parallel' && st.kerb > 0.3) this.fault('drillKerbFar', 'minor', { d: Math.round(st.kerb * 100) });
      if (id === 'backCorner' && st.kerb > 0.6) this.fault('drillKerbFar', 'minor', { d: Math.round(st.kerb * 100) });
      this.finish();
    } else if (!this.told && this.held > 1.5) {
      this.told = true;
      this.say(why.key, why.data);
    }
  }

  /** Why the car standing here is not done yet (null: it is). */
  whyNot(p: Pose, tc: number[] = this.carCorners(p)): { key: string; data: Record<string, number | string> } | null {
    const g = this.layout.goal;
    const dev = (yaw: number): number => Math.abs(wrap(p.yaw - yaw));
    const inGoal = (pad: number, w0pad = pad): boolean => {
      for (let i = 0; i < 8; i += 2) if (tc[i] < g.u0 - pad || tc[i] > g.u1 + pad || tc[i + 1] < g.w0 - w0pad || tc[i + 1] > g.w1 + pad) return false;
      return true;
    };
    const no = (key: string, data: Record<string, number | string> = {}): { key: string; data: Record<string, number | string> } => ({ key, data });
    const kerb = this.status.kerb;
    switch (this.id) {
      case 'parallel':
        if (!inGoal(0.02)) return no('drill.r.notInGap');
        if (dev(EAST) > 0.09) return no('drill.r.crooked');
        if (kerb > 0.5) return no('drill.r.kerbFar', { d: Math.round(kerb * 100) });
        return null;
      case 'bayFwd':
      case 'bayBack':
        if (dev(this.id === 'bayFwd' ? SOUTH : NORTH) > 1.2) return no(this.id === 'bayFwd' ? 'drill.r.noseIn' : 'drill.r.backIn');
        if (!inGoal(0.05, 0.25)) return no('drill.r.notInBay');
        if (dev(this.id === 'bayFwd' ? SOUTH : NORTH) > 0.1) return no('drill.r.crooked');
        return null;
      case 'backStraight':
        if (!inGoal(0.05)) return no('drill.r.notInBox');
        if (dev(EAST) > 0.1) return no('drill.r.crooked');
        return null;
      case 'backCorner':
        if (!inGoal(0.05)) return no('drill.r.notInSide');
        if (dev(NORTH) > 0.12) return no('drill.r.crooked');
        if (kerb > 1.2) return no('drill.r.kerbFar', { d: Math.round(kerb * 100) });
        return null;
      default:
        return null;
    }
  }

  // ---- the hill start

  private hill(s: DrillInput, dt: number): void {
    const st = this.status;
    const p = s.pose;
    const front = p.x + this.shape.front;
    const stopped = Math.abs(s.speed) < 0.05;
    if (this.engineWas === true && !s.engine) this.fault('drillStall', 'minor');
    this.engineWas = s.engine;
    if (st.step === 0) {
      if (stopped && front > HILL_LINE - 2 && front < HILL_LINE + 0.3) {
        st.step = 1;
        this.ref = p.x;
        this.say('drill.r.atLine');
      } else if (!this.pastTold && front > HILL_LINE + 1.2 && s.speed > 0) {
        this.pastTold = true;
        this.say('drill.r.pastLine');
      }
      return;
    }
    // rolling back, from where it stopped at the line
    st.rollback = Math.max(st.rollback, this.ref - p.x);
    if (st.rollback > 1) {
      this.fault('drillRollback', 'fail', { d: Math.round(st.rollback * 100) });
      this.say('drill.r.rolledFar');
      return;
    }
    if (st.rollback > 0.2 && !this.rollTold) {
      this.rollTold = true;
      this.fault('drillRollback', 'major', { d: Math.round(st.rollback * 100) });
      this.say('drill.r.rolled', { d: Math.round(st.rollback * 100) });
    }
    if (st.step === 1) {
      this.secured = stopped && s.handbrake ? this.secured + dt : 0;
      if (this.secured > 0.5) {
        st.step = 2;
        this.say('drill.r.secured');
      } else if (p.x - this.ref > 1) {
        // driven on without having secured the car with the handbrake
        this.fault('drillHillBrake', 'major');
        this.say('drill.r.noHandbrake');
        st.step = 2;
      }
      return;
    }
    if (s.handbrake && s.speed > 1 && !this.hbTold) {
      this.hbTold = true;
      this.fault('handbrakeOn', 'minor');
    }
    if (p.x - this.ref > 4) this.finish();
  }

  // ---- the emergency stop

  private brake(s: DrillInput, dt: number): void {
    const st = this.status;
    const p = s.pose;
    if (st.step === 0) {
      this.atSpeed = s.speed > BRAKE_SPEED - 0.8 ? this.atSpeed + dt : 0;
      if ((this.atSpeed > this.delay && p.x > -45) || (p.x > 25 && s.speed > 2)) {
        st.step = 1;
        st.signal = true;
        this.signalT = this.time;
        this.v0 = s.speed;
        const kmh = Math.round(s.speed * 3.6);
        if (kmh < 25 || kmh > 40) this.fault('drillBrakeSpeed', 'minor', { v: kmh });
      }
      return;
    }
    this.run += Math.max(0, s.speed) * dt;
    if (this.reaction < 0 && s.brake >= 0.3) this.reaction = this.time - this.signalT;
    this.maxBrake = Math.max(this.maxBrake, s.brake);
    if (Math.abs(s.speed) > 0.1) return;
    // stopped: how it went
    if (this.reaction < 0) this.reaction = this.time - this.signalT;
    this.stopDist = this.run;
    const v = this.v0;
    // a second for seeing and reacting at most, then the full brakes (about 7.5 m/s² with ABS on dry asphalt)
    this.ideal = v * 0.8 + (v * v) / (2 * 7.5);
    if (this.reaction > 1) this.fault('drillBrakeLate', 'major', { t: this.reaction.toFixed(1) });
    if (this.maxBrake < 0.8) this.fault('drillBrakeSoft', 'major');
    if (this.stopDist > this.ideal * 1.3) this.fault('drillBrakeLong', 'minor', { d: this.stopDist.toFixed(1) });
    this.say('drill.r.braked', { d: this.stopDist.toFixed(1), t: this.reaction.toFixed(1) });
    this.finish();
  }

  private finish(): void {
    if (this.status.state === 'run') this.status.state = 'done';
  }

  // ---- the result

  /** The task's score: 100, less for each fault, for a long time, for what was measured; failed: none. */
  result(): DrillResult {
    const st = this.status;
    const failed = st.state === 'failed';
    const slow = Math.min(25, Math.max(0, (this.time - this.layout.par) / 4));
    let quality = 6 * st.corrections;
    let measure = 'drillResult.moves';
    let data: Record<string, number | string> = { n: st.corrections, max: MAX_CORRECTIONS };
    const kerb = Number.isFinite(st.kerb) ? st.kerb : 0;
    if (this.id === 'parallel' || this.id === 'backCorner') {
      quality += Math.max(0, kerb - (this.id === 'parallel' ? 0.1 : 0.3)) * 40;
      measure = 'drillResult.kerb';
      data = { n: st.corrections, max: MAX_CORRECTIONS, d: Math.round(kerb * 100) };
    } else if (this.id === 'turn') {
      measure = 'drillResult.turn';
      data = { n: this.moves };
    } else if (this.id === 'hill') {
      quality = st.rollback * 50;
      measure = 'drillResult.hill';
      data = { d: Math.round(st.rollback * 100) };
    } else if (this.id === 'brake') {
      quality = Number.isFinite(this.stopDist) ? Math.max(0, this.stopDist / this.ideal - 1) * 60 + Math.max(0, this.reaction - 0.7) * 20 : 0;
      measure = 'drillResult.brake';
      data = { v: Math.round(this.v0 * 3.6), t: this.reaction >= 0 ? this.reaction.toFixed(1) : '–', d: Number.isFinite(this.stopDist) ? this.stopDist.toFixed(1) : '–', ideal: Number.isFinite(this.ideal) ? this.ideal.toFixed(1) : '–' };
    }
    const score = failed ? 0 : Math.max(0, Math.round(100 - 12 * this.minor - 30 * this.major - slow - quality));
    const stars = failed ? 0 : score >= 85 ? 3 : score >= 65 ? 2 : score >= 40 ? 1 : 0;
    return { id: this.id, text: `drill.${this.id}.name`, time: this.time, score, stars, minor: this.minor, major: this.major, failed, measure, measureData: data };
  }
}

/**
 * The tasks of an exam-like round, chosen at random as the examiner does
 * (Anlage 7 FeV, Nr. 2.1.4.2): one of group a (reversing round the corner
 * or parallel parking), then two different ones of group b (turning round,
 * bay parking forwards or backwards, the emergency stop) – the emergency
 * stop, if chosen, last.
 */
export function examDrills(rand: () => number = Math.random): DrillId[] {
  const one = <T>(list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
  const a = one<DrillId>(['backCorner', 'parallel']);
  const groupB = ['turn', 'bay', 'brake'];
  const first = one(groupB);
  const second = one(groupB.filter((g) => g !== first));
  const b = [first, second]
    .sort((x, y) => (x === 'brake' ? 1 : 0) - (y === 'brake' ? 1 : 0))
    .map((g): DrillId => (g === 'bay' ? one<DrillId>(['bayFwd', 'bayBack']) : (g as DrillId)));
  return [a, ...b];
}
