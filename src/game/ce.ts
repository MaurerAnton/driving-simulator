// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Class CE: what the practical test asks of a truck with trailer besides the
 * drive in traffic (Anlage 7 FeV, 2.1.3 and 2.1.4.5.2 – combinations with a
 * rigid-drawbar trailer):
 *
 *   – coupling and uncoupling ("Verbinden und Trennen"),
 *   – reversing round a corner to the left,
 *   – reversing with an offset to the right up to a loading ramp.
 *
 * This file holds the practice yard's layouts and the judging of the three
 * tasks – pure logic, no drawing.  The yard is laid over an open field of
 * the map while such a lesson runs (see tools/mapgen/yard.ts).
 */
import type { YardJson } from '../world/types.ts';

/** A place and a heading (0 = "north" of the frame, positive = to the left). */
export interface Pose {
  x: number;
  z: number;
  yaw: number;
}

/** A rectangle on the ground: middle, heading, half length, half width. */
export interface Box extends Pose {
  hl: number;
  hw: number;
}

/**
 * The yard's own coordinates: u along its long side, w across, the middle
 * at (0, 0).  A heading in the yard is counted like one on the map with u in
 * the place of east and w in the place of south.
 */
export class YardFrame {
  readonly yard: YardJson;
  private readonly cos: number;
  private readonly sin: number;
  private readonly turn: number;

  constructor(yard: YardJson) {
    this.yard = yard;
    // rot 1: the long side runs north–south (u points north)
    const phi = (-Math.PI / 2) * yard.rot;
    this.cos = Math.cos(phi);
    this.sin = Math.sin(phi);
    this.turn = -phi;
  }

  toWorld(u: number, w: number): [number, number] {
    return [this.yard.x + u * this.cos - w * this.sin, this.yard.z + u * this.sin + w * this.cos];
  }

  toLocal(x: number, z: number): [number, number] {
    const dx = x - this.yard.x;
    const dz = z - this.yard.z;
    return [dx * this.cos + dz * this.sin, -dx * this.sin + dz * this.cos];
  }

  yawToWorld(yaw: number): number {
    return yaw + this.turn;
  }

  yawToLocal(yaw: number): number {
    return yaw - this.turn;
  }

  poseToWorld(p: Pose): Pose {
    const [x, z] = this.toWorld(p.x, p.z);
    return { x, z, yaw: this.yawToWorld(p.yaw) };
  }

  poseToLocal(p: Pose): Pose {
    const [x, z] = this.toLocal(p.x, p.z);
    return { x, z, yaw: this.yawToLocal(p.yaw) };
  }
}

// ---- the vehicles' outlines ---------------------------------------------------

/** The truck's outline from its model origin (the ground point below the middle of the wheelbase). */
export const TRUCK_OUTLINE = { front: 3.75, rear: 4.45, hw: 1.25, hitch: 4.05 };
/** The trailer's outline from the middle of its axle group. */
export const TRAILER_OUTLINE = { front: 3.9, rear: 2.5, hw: 1.25, hitch: 5.4 };

/**
 * Where the tyres stand, seen from the same points: metres ahead (+) or
 * behind, and half the width over the outer tyres.  A kerb is driven over
 * with a wheel – the body may swing over it.
 */
export const TRUCK_AXLES = { at: [2.35, -2.35], hw: 1.25 };
export const TRAILER_AXLES = { at: [0.65, -0.65], hw: 1.25 };

const wrap = (a: number): number => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

/** The outer ends of the axles of a vehicle standing at a pose: x, z pairs. */
export function wheelPoints(p: Pose, axles: { at: readonly number[]; hw: number }, out: number[] = []): number[] {
  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  const rx = Math.cos(p.yaw);
  const rz = -Math.sin(p.yaw);
  for (const a of axles.at) {
    out.push(p.x + fx * a - rx * axles.hw, p.z + fz * a - rz * axles.hw, p.x + fx * a + rx * axles.hw, p.z + fz * a + rz * axles.hw);
  }
  return out;
}

/** The four corners of an outline standing at a pose: x, z pairs (front left, front right, rear right, rear left). */
export function corners(p: Pose, front: number, rear: number, hw: number): number[] {
  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  // right of the heading
  const rx = Math.cos(p.yaw);
  const rz = -Math.sin(p.yaw);
  return [
    p.x + fx * front - rx * hw,
    p.z + fz * front - rz * hw,
    p.x + fx * front + rx * hw,
    p.z + fz * front + rz * hw,
    p.x - fx * rear + rx * hw,
    p.z - fz * rear + rz * hw,
    p.x - fx * rear - rx * hw,
    p.z - fz * rear - rz * hw,
  ];
}

/** Where the trailer's axle group is when it hangs in line behind a truck standing at `truck`. */
export function trailerBehind(truck: Pose): Pose {
  const d = TRUCK_OUTLINE.hitch + TRAILER_OUTLINE.hitch;
  return { x: truck.x + Math.sin(truck.yaw) * d, z: truck.z + Math.cos(truck.yaw) * d, yaw: truck.yaw };
}

// ---- layouts --------------------------------------------------------------------

export type TaskId = 'corner' | 'ramp' | 'couple';

export interface Rect {
  u0: number;
  u1: number;
  w0: number;
  w1: number;
}

export interface Chamfer {
  u: number;
  w: number;
  du: number;
  dw: number;
}

export interface TaskLayout {
  /** where the truck stands at the start (yard coordinates), the trailer in line behind it */
  start: Pose;
  /** the paved areas the vehicles must stay on: together they are the "road" */
  allowed: Rect[];
  /**
   * Cut-off corners of a junction (a kerb is rounded, not square): right
   * triangles with the right angle at (u, w) and legs of du along u and dw
   * along w (signed).  They belong to the paved area.
   */
  chamfers: Chamfer[];
  /** boundary lines to paint: u0, w0, u1, w1 */
  lines: Array<[number, number, number, number]>;
  /** cones: u, w */
  cones: Array<[number, number]>;
  /** the loading ramp, if the task has one */
  ramp?: Rect & { h: number };
  /** where the combination has to stand in the end */
  goal: Rect;
  /** the goal is marked on the ground (not for coupling, which is done anywhere on the pad) */
  goalMarked: boolean;
}

/** facing along +u ("east" of the yard) */
const EAST = -Math.PI / 2;
/** facing along +w ("south" of the yard) */
const SOUTH = Math.PI;

const outline = (r: Rect): Array<[number, number, number, number]> => [
  [r.u0, r.w0, r.u1, r.w0],
  [r.u1, r.w0, r.u1, r.w1],
  [r.u1, r.w1, r.u0, r.w1],
  [r.u0, r.w1, r.u0, r.w0],
];

/** A road of 7 m along the yard and a side road of 7 m leaving it to the north. */
const MAIN: Rect = { u0: -70, u1: 70, w0: 6, w1: 13 };
const SIDE: Rect = { u0: -24, u1: -17, w0: -30, w1: 6 };
/** how much of each corner of the junction is cut off – about what a kerb radius of 7 m leaves free */
const CORNER = 4;
/** The ramp at the west end, its bay 3.6 m wide, and the apron in front of it. */
const RAMP: Rect & { h: number } = { u0: -72, u1: -68, w0: -22, w1: -2, h: 1.1 };
const BAY = { w: -12, half: 1.8 };
const APRON: Rect = { u0: -68, u1: 40, w0: -24, w1: 0 };

export function taskLayout(id: TaskId): TaskLayout {
  if (id === 'corner') {
    const cones: Array<[number, number]> = [];
    // both ends of the cut-off corners, along the side road, and its end
    for (const [u, out] of [[SIDE.u0, -1], [SIDE.u1, 1]]) cones.push([u + out * CORNER, MAIN.w0], [u, MAIN.w0 - CORNER], [u, MAIN.w0 - 12], [u, MAIN.w0 - 21], [u, SIDE.w0]);
    return {
      start: { x: 24, z: (MAIN.w0 + MAIN.w1) / 2, yaw: EAST },
      allowed: [MAIN, SIDE],
      chamfers: [
        { u: SIDE.u0, w: MAIN.w0, du: -CORNER, dw: -CORNER },
        { u: SIDE.u1, w: MAIN.w0, du: CORNER, dw: -CORNER },
      ],
      lines: [
        [MAIN.u0, MAIN.w1, MAIN.u1, MAIN.w1],
        [MAIN.u0, MAIN.w0, SIDE.u0 - CORNER, MAIN.w0],
        [SIDE.u1 + CORNER, MAIN.w0, MAIN.u1, MAIN.w0],
        [SIDE.u0 - CORNER, MAIN.w0, SIDE.u0, MAIN.w0 - CORNER],
        [SIDE.u1 + CORNER, MAIN.w0, SIDE.u1, MAIN.w0 - CORNER],
        [SIDE.u0, MAIN.w0 - CORNER, SIDE.u0, SIDE.w0],
        [SIDE.u1, MAIN.w0 - CORNER, SIDE.u1, SIDE.w0],
        [SIDE.u0, SIDE.w0, SIDE.u1, SIDE.w0],
      ],
      cones,
      // the whole combination in the side road, clear of the main road
      goal: { u0: SIDE.u0, u1: SIDE.u1, w0: SIDE.w0, w1: MAIN.w0 - 0.5 },
      goalMarked: true,
    };
  }
  if (id === 'ramp') {
    const cones: Array<[number, number]> = [];
    for (let u = -60; u <= 40; u += 20) cones.push([u, APRON.w0], [u, APRON.w1]);
    return {
      // 3.6 m to the left of the bay: the offset to make good while reversing
      start: { x: -10, z: BAY.w - 3.6, yaw: EAST },
      allowed: [APRON],
      chamfers: [],
      lines: [
        ...outline(APRON),
        [RAMP.u1, BAY.w - BAY.half, RAMP.u1 + 18, BAY.w - BAY.half],
        [RAMP.u1, BAY.w + BAY.half, RAMP.u1 + 18, BAY.w + BAY.half],
      ],
      cones,
      ramp: RAMP,
      // the rear end at most a metre from the ramp, in the bay
      goal: { u0: RAMP.u1, u1: RAMP.u1 + 1, w0: BAY.w - BAY.half, w1: BAY.w + BAY.half },
      goalMarked: true,
    };
  }
  const pad: Rect = { u0: -60, u1: 60, w0: 14, w1: 28 };
  return {
    start: { x: -18, z: 21, yaw: EAST },
    allowed: [pad],
    chamfers: [],
    lines: outline(pad),
    cones: [
      [pad.u0, pad.w0],
      [pad.u1, pad.w0],
      [pad.u0, pad.w1],
      [pad.u1, pad.w1],
    ],
    goal: pad,
    goalMarked: false,
  };
}

// ---- judging the two manoeuvres --------------------------------------------------

/** What the judge needs to know each moment (poses in yard coordinates). */
export interface RigState {
  truck: Pose;
  trailer: Pose;
  /** speed of the truck along its heading (m/s; negative: reversing) */
  speed: number;
  handbrake: boolean;
}

export type ManoeuvreFault = 'ceLine' | 'ceCorrections' | 'ceRamp';

export interface ManoeuvreStatus {
  state: 'run' | 'done' | 'failed';
  /** times the driver pulled forward again to correct (two are allowed) */
  corrections: number;
  /** times a vehicle left the paved area */
  excursions: number;
  /** faults that occurred in this step */
  faults: ManoeuvreFault[];
  /** how far the rear end is from the ramp (ramp task; NaN otherwise) */
  gap: number;
}

export const MAX_CORRECTIONS = 2;

/**
 * How far a point lies off the paved area of a task (m); 0 on it.  `pad`
 * widens the area (the asphalt reaches a little beyond the lines).
 */
export function offArea(lay: TaskLayout, u: number, w: number, pad = 0): number {
  let d = Infinity;
  for (const r of lay.allowed) {
    const du = Math.max(r.u0 - pad - u, 0, u - r.u1 - pad);
    const dw = Math.max(r.w0 - pad - w, 0, w - r.w1 - pad);
    d = Math.min(d, Math.hypot(du, dw));
    if (d === 0) return 0;
  }
  for (const c of lay.chamfers) {
    // in the frame of the triangle: a, b ≥ 0 along the legs, inside where a/|du| + b/|dw| ≤ 1
    const a = (u - c.u) * Math.sign(c.du);
    const b = (w - c.w) * Math.sign(c.dw);
    const la = Math.abs(c.du);
    const lb = Math.abs(c.dw);
    // distance to the cut (the legs border the roads, which are measured above)
    const over = (a / la + b / lb - 1) / Math.hypot(1 / la, 1 / lb) - pad;
    if (a >= -pad && b >= -pad) {
      if (over <= 0) return 0;
      d = Math.min(d, over);
    }
  }
  return d;
}

const inRect = (u: number, w: number, r: Rect, pad: number): boolean => u >= r.u0 - pad && u <= r.u1 + pad && w >= r.w0 - pad && w <= r.w1 + pad;

export class ManoeuvreJudge {
  readonly id: 'corner' | 'ramp';
  readonly layout: TaskLayout;
  readonly status: ManoeuvreStatus = { state: 'run', corrections: 0, excursions: 0, faults: [], gap: NaN };
  private outside = false;
  /** metres driven backwards / forwards since the last change of direction */
  private back = 0;
  private fwd = 0;
  private reversed = false;
  private held = 0;

  constructor(id: 'corner' | 'ramp') {
    this.id = id;
    this.layout = taskLayout(id);
  }

  update(rig: RigState, dt: number): ManoeuvreStatus {
    const st = this.status;
    st.faults.length = 0;
    if (st.state !== 'run') return st;
    const lay = this.layout;
    const tc = corners(rig.truck, TRUCK_OUTLINE.front, TRUCK_OUTLINE.rear, TRUCK_OUTLINE.hw);
    const rc = corners(rig.trailer, TRAILER_OUTLINE.front, TRAILER_OUTLINE.rear, TRAILER_OUTLINE.hw);
    // ---- staying on the paved area: the lines are kerbs, and a kerb is driven over with a wheel
    // (a hand's width over the line is not yet off it; the body may swing over it)
    const wheels = wheelPoints(rig.trailer, TRAILER_AXLES, wheelPoints(rig.truck, TRUCK_AXLES));
    let off = 0;
    for (let i = 0; i < wheels.length; i += 2) off = Math.max(off, offArea(lay, wheels[i], wheels[i + 1]));
    if (off > 0.15 && !this.outside) {
      this.outside = true;
      st.excursions++;
      st.faults.push('ceLine');
    } else if (off < 0.05) this.outside = false;
    // far off the area, or again and again: the task is over
    if (off > 2.5 || st.excursions > 2) st.state = 'failed';

    // ---- the ramp must not be touched
    if (lay.ramp) {
      const rearU = Math.min(rc[4], rc[6]);
      st.gap = rearU - lay.ramp.u1;
      if (st.gap < 0.02 && Math.min(rc[5], rc[7]) < lay.ramp.w1 && Math.max(rc[5], rc[7]) > lay.ramp.w0) {
        st.faults.push('ceRamp');
        st.state = 'failed';
      }
    }

    // ---- corrections: pulling forward again after having reversed
    const step = rig.speed * dt;
    if (step < 0) {
      this.back -= step;
      if (this.back > 1) {
        this.reversed = true;
        this.fwd = 0;
      }
    } else if (step > 0 && this.reversed) {
      this.fwd += step;
      if (this.fwd > 0.6) {
        st.corrections++;
        this.reversed = false;
        this.back = 0;
        if (st.corrections > MAX_CORRECTIONS) {
          st.faults.push('ceCorrections');
          st.state = 'failed';
        }
      }
    }
    if (st.state !== 'run') return st;

    // ---- arrived: standing in the goal, straight, secured
    const standing = Math.abs(rig.speed) < 0.08 && rig.handbrake;
    this.held = standing && this.arrived(rig, tc, rc) ? this.held + dt : 0;
    if (this.held > 0.8) st.state = 'done';
    return st;
  }

  /** Does the combination stand where and how the task wants it? */
  arrived(rig: RigState, tc = corners(rig.truck, TRUCK_OUTLINE.front, TRUCK_OUTLINE.rear, TRUCK_OUTLINE.hw), rc = corners(rig.trailer, TRAILER_OUTLINE.front, TRAILER_OUTLINE.rear, TRAILER_OUTLINE.hw)): boolean {
    const g = this.layout.goal;
    if (this.id === 'corner') {
      // everything in the side road, both vehicles along it (front towards the main road)
      for (const c of [tc, rc]) for (let i = 0; i < 8; i += 2) if (!inRect(c[i], c[i + 1], g, 0.05)) return false;
      return Math.abs(wrap(rig.truck.yaw - SOUTH)) < 0.14 && Math.abs(wrap(rig.trailer.yaw - SOUTH)) < 0.14;
    }
    // the ramp: the trailer's rear end close to it, the trailer in the bay and square to the ramp
    const rearU = Math.min(rc[4], rc[6]);
    if (rearU < g.u0 + 0.1 || rearU > g.u1) return false;
    for (const i of [4, 6]) if (rc[i + 1] < g.w0 || rc[i + 1] > g.w1) return false;
    if (Math.abs(wrap(rig.trailer.yaw - EAST)) > 0.07) return false;
    return Math.abs(wrap(rig.truck.yaw - rig.trailer.yaw)) < 0.2;
  }
}

// ---- coupling and uncoupling -------------------------------------------------------

/**
 * The steps of uncoupling and coupling.  'do' steps are things done with the
 * truck (the judge sees them happen); the others are things done on foot
 * around the vehicles – the driver picks them from a list, and the order
 * counts.
 */
export const COUPLING_STEPS = [
  // ---- uncoupling
  { id: 'uPark', kind: 'do', needs: [] },
  { id: 'uBrake', kind: 'act', needs: ['uPark'] },
  { id: 'uChocks', kind: 'act', needs: ['uPark'] },
  { id: 'uLeg', kind: 'act', needs: ['uPark'] },
  { id: 'uRed', kind: 'act', needs: ['uBrake', 'uChocks', 'uLeg'], why: 'ceSecure' },
  { id: 'uYellow', kind: 'act', needs: ['uRed'], why: 'ceAir' },
  { id: 'uCable', kind: 'act', needs: ['uBrake', 'uChocks', 'uLeg'], why: 'ceSecure' },
  { id: 'uOpen', kind: 'act', needs: ['uRed', 'uYellow', 'uCable'], why: 'ceOpen' },
  { id: 'uPull', kind: 'do', needs: ['uOpen'] },
  // ---- coupling
  { id: 'cCheck', kind: 'act', needs: ['uPull'] },
  { id: 'cApproach', kind: 'do', needs: ['cCheck'] },
  { id: 'cHeight', kind: 'act', needs: ['cApproach'] },
  { id: 'cLatch', kind: 'do', needs: ['cHeight'] },
  { id: 'cLocked', kind: 'act', needs: ['cLatch'] },
  { id: 'cYellow', kind: 'act', needs: ['cLocked'], why: 'ceLocked' },
  { id: 'cRed', kind: 'act', needs: ['cYellow'], why: 'ceAir' },
  { id: 'cCable', kind: 'act', needs: ['cLocked'], why: 'ceLocked' },
  { id: 'cLeg', kind: 'act', needs: ['cLocked'], why: 'ceLocked' },
  { id: 'cChocks', kind: 'act', needs: ['cRed', 'cYellow'], why: 'ceRelease' },
  { id: 'cBrake', kind: 'act', needs: ['cRed', 'cYellow'], why: 'ceRelease' },
  { id: 'cLights', kind: 'act', needs: ['cCable'], why: 'ceLights' },
  { id: 'cTest', kind: 'do', needs: ['cLeg', 'cChocks', 'cBrake', 'cLights'] },
] as const;

export type CouplingStepId = (typeof COUPLING_STEPS)[number]['id'];
export type CouplingFault = 'ceSecure' | 'ceAir' | 'ceOpen' | 'ceLocked' | 'ceRelease' | 'ceLights' | 'ceHeight' | 'ceFast';

/** What the procedure needs to know each moment. */
export interface CouplingState {
  /** speed of the truck along its heading (m/s) */
  speed: number;
  handbrake: boolean;
  /** the trailer hangs on the truck */
  coupled: boolean;
  /** distance from the truck's coupling to the trailer's eye (m) and how far out of line they are (rad) */
  dist: number;
  angle: number;
}

export interface CouplingStatus {
  state: 'run' | 'done';
  /** the 'do' step the driver is to carry out now, or null while there are things to do on foot */
  todo: CouplingStepId | null;
  /** the trailer is to be let go / to be taken on in this step */
  uncouple: boolean;
  couple: boolean;
  faults: CouplingFault[];
}

export class CouplingProcedure {
  readonly done = new Set<CouplingStepId>();
  readonly status: CouplingStatus = { state: 'run', todo: 'uPark', uncouple: false, couple: false, faults: [] };
  /** metres driven since a mark, for the 'do' steps that are distances */
  private run = 0;
  private braked = false;

  private ready(id: CouplingStepId): boolean {
    const step = COUPLING_STEPS.find((s) => s.id === id)!;
    return step.needs.every((n) => this.done.has(n));
  }

  /** May the driver get out and do things on foot? (The truck stands, secured.) */
  onFoot(s: CouplingState): boolean {
    return Math.abs(s.speed) < 0.08 && s.handbrake;
  }

  /** Has everything that is done with the truck before step `id` been done? */
  private reached(id: CouplingStepId): boolean {
    const step = COUPLING_STEPS.find((s) => s.id === id)!;
    for (const n of step.needs) {
      const need = COUPLING_STEPS.find((s) => s.id === n)!;
      if (need.kind === 'do' ? !this.done.has(n) : !this.reached(n)) return false;
    }
    return true;
  }

  /**
   * The things on foot that can be done now and are not done yet, in the
   * order of the catalogue.  Which of them comes first is for the driver to
   * know.
   */
  choices(): CouplingStepId[] {
    return COUPLING_STEPS.filter((s) => s.kind === 'act' && !this.done.has(s.id) && this.reached(s.id)).map((s) => s.id);
  }

  /**
   * The driver chose a thing to do on foot.  Returns the fault if it is not
   * its turn yet (it is then not done), or null.
   */
  act(id: CouplingStepId, s: CouplingState): CouplingFault | null {
    const step = COUPLING_STEPS.find((x) => x.id === id);
    if (!step || step.kind !== 'act' || this.done.has(id) || !this.onFoot(s)) return null;
    if (!this.ready(id)) return ('why' in step ? step.why : undefined) ?? 'ceSecure';
    this.done.add(id);
    return null;
  }

  update(s: CouplingState, dt: number): CouplingStatus {
    const st = this.status;
    st.faults.length = 0;
    st.uncouple = false;
    st.couple = false;
    if (st.state === 'done') return st;
    const standing = Math.abs(s.speed) < 0.08;
    const has = (id: CouplingStepId): boolean => this.done.has(id);
    const finish = (id: CouplingStepId): void => {
      this.done.add(id);
      this.run = 0;
    };

    if (!has('uPark')) {
      if (standing && s.handbrake) finish('uPark');
    } else if (!has('uPull')) {
      if (has('uOpen')) {
        // the coupling is open: the truck drives out from under the eye
        if (s.coupled) st.uncouple = true;
        if (s.dist > 2) finish('uPull');
      }
    } else if (!has('cLatch')) {
      // first back up to about a metre before the eye, in line, and secure the truck …
      if (!has('cApproach') && has('cCheck') && standing && s.handbrake && s.dist > 0.25 && s.dist < 1.6 && Math.abs(s.angle) < 0.17) finish('cApproach');
      // … then, the heights compared, on until the coupling takes the eye
      if (s.dist < 0.2 && Math.abs(s.angle) < 0.26 && s.speed < 0.05) {
        if (!has('cHeight')) {
          // straight on to the trailer without stopping and looking: it couples, but that is a fault
          st.faults.push('ceHeight');
          for (const id of ['cCheck', 'cApproach', 'cHeight'] as const) this.done.add(id);
        }
        if (s.speed < -0.9) st.faults.push('ceFast');
        st.couple = true;
        finish('cLatch');
      }
    } else if (!has('cTest')) {
      if (this.ready('cTest')) {
        // the brake test: pull away, then brake to a stop
        this.run += Math.max(0, s.speed) * dt;
        // (a few metres at walking pace are enough: it is about whether the trailer brakes with the truck)
        if (this.run > 1.5 && s.speed > 1) this.braked = true;
        if (this.braked && standing) finish('cTest');
      }
    }
    if (has('cTest')) st.state = 'done';

    // what the driver is to do with the truck now
    st.todo = null;
    for (const step of COUPLING_STEPS) {
      if (step.kind !== 'do' || has(step.id)) continue;
      if (this.ready(step.id)) st.todo = step.id;
      break;
    }
    return st;
  }
}
