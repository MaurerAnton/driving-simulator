// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Theory lessons: difficult situations of German road traffic shown as short
 * scenes in 3D, the way a theory book draws them – a crossroads without
 * signs, a priority road that bends, turning left with oncoming traffic, a
 * zebra crossing, a tram, an ambulance in a jam, a school bus at its stop,
 * a cyclist to overtake, the blind spot, a lane that ends, joining the
 * motorway, a roundabout, the green arrow.
 *
 * Each lesson is a script: a place (game/theorystage.ts) and the vehicles,
 * cyclists and people on it, each moving along a path of the place by
 * timed key positions.  At the key moments the scene stops and asks a
 * question – who goes first, what do you do – which is answered by tapping
 * a vehicle or an answer; then it tells why (with the paragraph of the
 * StVO) and plays on the right way.  "You" are always the white
 * driving-school car coming from the south.
 *
 * All of this is plain data and arithmetic: render/theory.ts draws it on
 * the practice yard, game/theorymode.ts runs it, ui/theory.ts shows the
 * texts – and tests/game/theory.test.ts checks the scripts without a browser.
 */
import { RAIL } from '../world/types.ts';
import { consistLength, consistOf } from '../sim/rail.ts';
import { LIFT, along, bar, crossroads, dashes, finish, lanePath, laneArrow, newPathPoint, pathPoint, polyPath, roundabout, straight, yawOf } from './theorystage.ts';
import type { Bound, Path, Stage, Surface } from './theorystage.ts';

// ------------------------------------------------------------------- actors
/** the learner's car; another car; an ambulance or police van; a bus; a lorry; a tram; a cyclist; a person; a child */
export type ActorKind = 'me' | 'car' | 'van' | 'bus' | 'truck' | 'tram' | 'bike' | 'person' | 'child';

/**
 * How big each kind is: length and width, how far its nose lies ahead of
 * the middle between its axles (the point the models are placed by), its
 * wheelbase.  The scripts move the NOSE along a path: a car waits "at the
 * line" with its nose there.
 */
export interface Footprint {
  length: number;
  width: number;
  front: number;
  wheelbase: number;
}

const TRAM = consistOf(RAIL.TRAM, 'single');

export const FOOT: Record<ActorKind, Footprint> = {
  me: { length: 4.28, width: 1.79, front: 2.195, wheelbase: 2.63 },
  car: { length: 4.28, width: 1.79, front: 2.195, wheelbase: 2.63 },
  van: { length: 5.9, width: 2.02, front: 2.83, wheelbase: 3.66 },
  bus: { length: 12, width: 2.55, front: 5.65, wheelbase: 5.9 },
  truck: { length: 8.2, width: 2.5, front: 3.75, wheelbase: 4.7 },
  // (a tram is placed car by car from its nose: render/theory.ts)
  tram: { length: consistLength(TRAM), width: TRAM.width, front: 0, wheelbase: 0 },
  bike: { length: 1.75, width: 0.62, front: 0.88, wheelbase: 1.06 },
  person: { length: 0.45, width: 0.5, front: 0.2, wheelbase: 0 },
  child: { length: 0.35, width: 0.4, front: 0.15, wheelbase: 0 },
};

/** A key position: at time `t` (s) the nose is `at` along the path – metres, or a mark of the path ± metres ('line-12') – going `v` m/s. */
export type Key = [t: number, at: number | string, v: number];

export interface ActorDef {
  id: string;
  kind: ActorKind;
  /** the name of its path in the stage */
  path: string;
  keys: Key[];
  /** its paint (cars), the shirt of a cyclist */
  colour?: number;
  /** a person's look (render/people.ts) */
  look?: number;
  /** moving sideways from its path: from `t` on, to `off` metres (+ to the left), taking `dur` seconds */
  side?: Array<[t: number, off: number, dur: number]>;
  /** the indicators from `t` on: −1 left, 0 off, 1 right, 2 hazard lights */
  blink?: Array<[t: number, state: number]>;
  /** blue lights (an ambulance, the police) */
  blue?: boolean;
  /** what it is called in the answers (a text key) */
  name?: string;
  /** the destination display of a bus */
  display?: string;
  /** the vehicle it gets out of (it starts inside it: the two do not count as touching) */
  leaves?: string;
}

/** A traffic light's lamps: R red, Y red and amber, G green, A amber, O off. */
export type LightState = 'R' | 'Y' | 'G' | 'A' | 'O';

export interface StepDef {
  /** when the scene stops for the question (s) */
  at: number;
  /** the answers: ids of actors (tapped in the picture, or in the list) or of answers of their own (their text: theory.<lesson>.<step>.<id>; '!yes' and '!no': theory.a.yes / no) */
  answers: string[];
  right: string;
  /** the rule (the same in every language) */
  ref: string;
  /** the question, when it is a common one (else theory.<lesson>.<step>.ask) */
  ask?: string;
  /** the blind spot of this actor is shown while the question is open */
  blind?: string;
}

export interface LessonDef {
  id: string;
  stage: () => Stage;
  actors: ActorDef[];
  steps: StepDef[];
  /** when it is over (s) */
  end: number;
  lights?: Record<string, Array<[t: number, state: LightState]>>;
  /**
   * The camera at the start: what it looks at (a point of the stage, or an
   * actor it follows – then `ahead` metres in front of it), from which side
   * (yaw: 0 from the south, + from the east), how steeply and from how far.
   */
  view: { at: [number, number] | string; ahead?: number; yaw: number; pitch: number; dist: number };
  /** the side gap between two actors shown while one passes the other */
  gap?: { a: string; b: string; t0: number; t1: number };
}

// ------------------------------------------------------------- the lessons
const BLUE = 0x2f5f8a;
const RED = 0xa8231b;
const WHITE = 0xe2e2dc;
const GREEN = 0x2f7a46;
const SILVER = 0x9aa1a8;
const YELLOW = 0xd8a417;
const DARK = 0x2c3036;

/** A street in town north–south: one lane each way, pavements – the lines at x of the kerbs and the pavements' outer edges. */
function townStreet(z0: number, z1: number, laneW: number, walk: number): Stage {
  const st = straight({ z0, z1, bounds: [{ x: -laneW - walk }, { x: -laneW }, { x: laneW }, { x: laneW + walk }], strips: ['walk', 'asphalt', 'walk'], kerbs: [1, 2] });
  return st;
}

/** 1 · Right before left: three cars at a crossroads without signs. */
const RBL: LessonDef = {
  id: 'rbl',
  stage: () => {
    const road = { lanes: 1, laneW: 2.75, walk: 2.2, centre: 'none' as const };
    const c = crossroads({
      ns: road,
      ew: road,
      r: 5,
      arms: {
        N: { len: 32, signs: [{ at: 24, codes: ['274.1'] }] },
        S: { len: 64, signs: [{ at: 50, codes: ['274.1'] }] },
        E: { len: 30, signs: [{ at: 24, codes: ['274.1'] }] },
        W: { len: 30, signs: [{ at: 24, codes: ['274.1'] }] },
      },
    });
    c.stage.paths.me = c.move('S', 'N');
    c.stage.paths.blue = c.move('E', 'W');
    c.stage.paths.white = c.move('W', 'E');
    return c.stage;
  },
  actors: [
    { id: 'me', kind: 'me', path: 'me', keys: [[0, 'line-24', 7], [1.5, 'line-13.5', 7], [5, 'line', 0], [7.7, 'line', 0], [10.9, 'line+12.8', 8], [12.6, 'line+26.4', 8]] },
    { id: 'blue', kind: 'car', colour: BLUE, name: 'theory.who.blue', path: 'blue', keys: [[0, 'line-30', 7], [5, 'line-3.75', 3.5], [7.3, 'line+7.5', 5.5], [10.5, 'line+29', 8]] },
    { id: 'white', kind: 'car', colour: WHITE, name: 'theory.who.white', path: 'white', keys: [[0, 'line-17', 6], [1, 'line-11', 6], [4.6, 'line', 0], [9.4, 'line', 0], [12.6, 'line+12.8', 8], [14.5, 'line+28', 8]] },
  ],
  steps: [
    { at: 5, answers: ['blue', 'me', 'white'], right: 'blue', ref: '§ 8 Abs. 1 StVO', ask: 'theory.ask.first' },
    { at: 7.3, answers: ['me', 'white'], right: 'me', ref: '§ 8 Abs. 1 StVO' },
  ],
  end: 14.5,
  view: { at: [0, 4], yaw: 0.45, pitch: -0.7, dist: 34 },
};

/** 2 · The priority road bends: you follow it to the left. */
const BEND: LessonDef = {
  id: 'bend',
  stage: () => {
    const road = { lanes: 1, laneW: 3, walk: 2, centre: 'dash' as const };
    const c = crossroads({
      ns: road,
      ew: road,
      r: 6,
      arms: {
        S: { len: 62, signs: [{ at: 30, codes: ['306', '1002-10'] }] },
        W: { len: 30, signs: [{ at: 22, codes: ['306', '1002-20'] }] },
        N: { len: 30, line: 'give', signs: [{ at: 14, codes: ['205', '1002-21'] }] },
        E: { len: 30, line: 'give', signs: [{ at: 14, codes: ['205', '1002-11'] }] },
      },
    });
    c.stage.paths.me = c.move('S', 'W');
    c.stage.paths.red = c.move('N', 'S');
    return c.stage;
  },
  actors: [
    { id: 'me', kind: 'me', path: 'me', keys: [[0, 'in-34', 9], [3, 'in-12', 6.5], [5.5, 'in+1', 4], [7.2, 'in+8', 4.6], [10, 'in+24', 7.5]], blink: [[3.05, -1], [9.2, 0]] },
    { id: 'red', kind: 'car', colour: RED, name: 'theory.who.red', path: 'red', keys: [[0, 'line-12', 6], [4, 'line', 0], [8.6, 'line', 0], [11.4, 'line+9.8', 7], [13.5, 'line+24.5', 7]] },
  ],
  steps: [
    { at: 3, answers: ['left', 'none'], right: 'left', ref: 'Anlage 3 StVO, Zeichen 306' },
    { at: 5.5, answers: ['me', 'red'], right: 'me', ref: '§ 8 Abs. 1 StVO, Zeichen 205', ask: 'theory.ask.first' },
  ],
  end: 13.5,
  view: { at: [0, 3], yaw: 0.55, pitch: -0.72, dist: 34 },
};

/** 3 · Turning left on green: the oncoming car, then the people crossing. */
const LEFT_TURN: LessonDef = {
  id: 'leftTurn',
  stage: () => {
    const road = { lanes: 1, laneW: 3.25, walk: 2.5, centre: 'dash' as const };
    const c = crossroads({
      ns: road,
      ew: road,
      r: 6,
      arms: {
        S: { len: 60, line: 'stop', light: { id: 'ns' } },
        N: { len: 32, line: 'stop', light: { id: 'ns' } },
        E: { len: 30, line: 'stop', light: { id: 'ew' } },
        W: { len: 30, line: 'stop', light: { id: 'ew' }, xing: { at: 2.6, w: 4, kind: 'furt' }, pedLight: 'pw' },
      },
    });
    const st = c.stage;
    st.paths.me = c.move('S', 'W');
    st.paths.red = c.move('N', 'S');
    // somebody on the pavement of the west arm, across it with the lights, and on
    const x = -c.xingAt('W');
    st.paths.walker = polyPath([-14, -4.55, x - 0.8, -4.55, x, -3.9, x, 3.9, x - 0.8, 4.55, -14, 4.55]);
    return st;
  },
  actors: [
    { id: 'me', kind: 'me', path: 'me', keys: [[0, 'in-24', 8], [1, 'in-16', 8], [5.5, 'in+2', 0], [9.4, 'in+2', 0], [12.6, 'in+11.6', 6], [15, 'in+27.2', 7]], blink: [[0, -1], [13, 0]] },
    { id: 'red', kind: 'car', colour: RED, name: 'theory.who.red', path: 'red', keys: [[0, 'in-48', 9], [9, 'in+33', 9]] },
    { id: 'walker', kind: 'person', look: 7, name: 'theory.who.walker', path: 'walker', keys: [[0, 1.08, 1.3], [18, 24.48, 1.3]] },
  ],
  lights: { ns: [[0, 'G']], ew: [[0, 'R']], pw: [[0, 'G']] },
  steps: [
    { at: 4.4, answers: ['me', 'red'], right: 'red', ref: '§ 9 Abs. 3 StVO', ask: 'theory.ask.first' },
    { at: 7.4, answers: ['me', 'walker'], right: 'walker', ref: '§ 9 Abs. 3 StVO', ask: 'theory.ask.first' },
  ],
  end: 15,
  view: { at: [0, 2], yaw: 0.6, pitch: -0.72, dist: 34 },
};

/** 4 · A zebra crossing: somebody wants to cross, then somebody else. */
const ZEBRA: LessonDef = {
  id: 'zebra',
  stage: () => {
    const st = townStreet(70, -60, 3.25, 2.5);
    // the middle line, broken off at the crossing
    st.surfaces.push(...dashes(0, 70, 0, 6, 0.12, 3, 6), ...dashes(0, -6, 0, -60, 0.12, 3, 6), bar(0, 6, 0, 2.6, 0.12), bar(0, -2.6, 0, -6, 0.12));
    // the zebra (Zeichen 293): stripes along the road, half a metre wide
    for (let x = -2.5; x < 2.6; x += 1) st.surfaces.push(bar(x, 2, x, -2, 0.5));
    // Zeichen 350 on both sides, for both directions
    st.signs.push({ x: 4.1, z: 2.6, yaw: yawOf(0, 1), codes: ['350'] }, { x: -4.1, z: -2.6, yaw: yawOf(0, -1), codes: ['350'] });
    st.paths.me = lanePath(1.625, 70, -60, { zebra: 70 - 3.0 });
    st.paths.white = lanePath(-1.625, -60, 70, { zebra: 60 - 3.0 });
    st.paths.walker = polyPath([4.5, 22, 4.5, 2.4, 3.6, 0.9, -3.6, 0.9, -4.5, -1.2, -4.5, -24]);
    st.paths.walker2 = polyPath([-4.6, -26, -4.6, -2.4, -3.6, -0.9, 3.6, -0.9, 4.6, 1.2, 4.6, 24]);
    return finish(st);
  },
  actors: [
    { id: 'me', kind: 'me', path: 'me', keys: [[0, 'zebra-34', 8.3], [3, 'zebra-12', 7], [6, 'zebra', 0], [14.2, 'zebra', 0], [17.4, 'zebra+12.8', 8], [18.5, 'zebra+21.6', 8]] },
    { id: 'white', kind: 'car', colour: WHITE, name: 'theory.who.white', path: 'white', keys: [[0, 'zebra-30', 8.3], [1, 'zebra-21.7', 8.3], [6.2, 'zebra', 0], [12.4, 'zebra', 0], [15.6, 'zebra+12.8', 8], [18.5, 'zebra+36', 8]] },
    { id: 'walker', kind: 'person', look: 11, name: 'theory.who.walker', path: 'walker', keys: [[0, 13.2, 1.4], [26, 49.6, 1.4]] },
    { id: 'walker2', kind: 'person', look: 23, name: 'theory.who.walker', path: 'walker2', keys: [[0, 14.4, 1.35], [26, 49.5, 1.35]] },
  ],
  steps: [
    { at: 3, answers: ['brake', 'go', 'horn'], right: 'brake', ref: '§ 26 Abs. 1 StVO' },
    { at: 8.4, answers: ['wait', 'go'], right: 'wait', ref: '§ 26 Abs. 1 StVO' },
  ],
  end: 18.5,
  view: { at: [0, 6], yaw: 0.5, pitch: -0.62, dist: 30 },
};

/** 5 · Turning left over the tracks: the tram from behind. */
const TRAM_LESSON: LessonDef = {
  id: 'tram',
  stage: () => {
    const ns = { lanes: 1, laneW: 3.25, median: 6, walk: 2.5, centre: 'none' as const, tracks: true };
    const ew = { lanes: 1, laneW: 3.25, walk: 2.5, centre: 'dash' as const };
    const c = crossroads({
      ns,
      ew,
      r: 6,
      arms: {
        S: { len: 70, signs: [{ at: 40, codes: ['306'] }] },
        N: { len: 32, signs: [{ at: 24, codes: ['306'] }] },
        E: { len: 28, line: 'give', signs: [{ at: 14, codes: ['205'] }] },
        W: { len: 28, line: 'give', signs: [{ at: 14, codes: ['205'] }] },
      },
    });
    c.stage.paths.me = c.move('S', 'W');
    c.stage.paths.tram = c.move('S', 'N', 'tram');
    return c.stage;
  },
  actors: [
    { id: 'me', kind: 'me', path: 'me', keys: [[0, 'in-24.5', 8], [0.5, 'in-20.5', 8], [5.5, 'in-0.5', 0], [11.5, 'in-0.5', 0], [14.7, 'in+9.1', 6], [16.5, 'in+20.8', 6.5]], blink: [[0, -1], [15.5, 0]] },
    { id: 'tram', kind: 'tram', name: 'theory.who.tram', path: 'tram', keys: [[0, 30, 5], [5.5, 56, 5], [8.5, 77, 9], [16.5, 149, 9]] },
  ],
  steps: [{ at: 5.5, answers: ['me', 'tram'], right: 'tram', ref: '§ 9 Abs. 1, Abs. 3 StVO', ask: 'theory.ask.first' }],
  end: 16.5,
  view: { at: [1, 8], yaw: 0.5, pitch: -0.62, dist: 40 },
};

/** The dual carriageway of the corridor: two lanes each way, a hard shoulder, a crash barrier in the middle. */
function dualStage(): Stage {
  const st = straight({
    z0: 72,
    z1: -72,
    bounds: [{ x: -11.75 }, { x: -1.5 }, { x: 1.5 }, { x: 11.75 }],
    strips: ['asphalt', 'grass', 'asphalt'],
    guards: [0],
  });
  for (const s of [1, -1]) {
    st.surfaces.push(...along({ x: s * 2.25 }, 72, -72, 0.15), ...along({ x: s * 5.75 }, 72, -72, 0.15, [6, 12]), ...along({ x: s * 9.25 }, 72, -72, 0.25));
  }
  st.paths.left = lanePath(4, 72, -72);
  st.paths.right = lanePath(7.5, 72, -72);
  st.paths.gap = lanePath(5.9, 72, -72);
  return finish(st);
}

/**
 * A car in a jam: rolling at 5 m/s until it slows to walking pace (at 3 s),
 * then – from `shift` on – creeping on while it moves `off` to the side,
 * and standing.
 */
function jam(id: string, kind: ActorKind, colour: number, path: string, s0: number, shift: number, off: number): ActorDef {
  const s1 = s0 + 9.75;
  return { id, kind, colour: kind === 'me' ? undefined : colour, path, keys: [[0, s0, 5], [3, s1, 1.5], [6.4, s1 + 5.1, 1.5], [8.4, s1 + 6.6, 0]], side: [[shift, off, 2.6]] };
}

/** 6 · An ambulance in the jam: the emergency corridor. */
const CORRIDOR: LessonDef = {
  id: 'corridor',
  stage: dualStage,
  actors: [
    // the left lane moves to the left, everybody else to the right (noses: z = 72 − s), creeping on while they do
    jam('me', 'me', 0, 'left', 64, 3.3, 1.15),
    jam('a1', 'car', BLUE, 'left', 77, 3.2, 1.15),
    jam('a2', 'car', GREEN, 'left', 51, 3.5, 1.15),
    jam('a3', 'car', SILVER, 'left', 38.5, 3.7, 1.15),
    jam('b1', 'car', YELLOW, 'right', 80, 3.3, -1.45),
    jam('b2', 'car', RED, 'right', 64.5, 3.4, -1.45),
    jam('b3', 'car', WHITE, 'right', 52, 3.6, -1.45),
    jam('b4', 'car', DARK, 'right', 39, 3.8, -1.45),
    // through the corridor: the ambulance, then the police
    { id: 'amb', kind: 'van', colour: 0xf2f2ee, blue: true, name: 'theory.who.van', path: 'gap', keys: [[4.4, 0, 11], [10.4, 76, 13]] },
    { id: 'police', kind: 'van', colour: 0x2d5d9a, blue: true, path: 'gap', keys: [[12, 0, 11], [17.4, 74, 14]] },
  ],
  steps: [
    { at: 3, answers: ['left', 'right', 'stay'], right: 'left', ref: '§ 11 Abs. 2 StVO' },
    { at: 11.6, answers: ['follow', 'keep'], right: 'keep', ref: '§ 11 Abs. 2 StVO' },
  ],
  end: 18.6,
  view: { at: [6, 12], yaw: 0.5, pitch: -0.95, dist: 60 },
};

/** The street of the school bus: a stop on the right, with its sign and the zigzag line (Zeichen 299). */
function busStage(): Stage {
  const st = townStreet(70, -65, 3.25, 2.5);
  st.surfaces.push(...dashes(0, 70, 0, -65, 0.12, 3, 6));
  st.signs.push({ x: 4.1, z: -9.5, yaw: yawOf(0, 1), codes: ['224'] });
  // the zigzag along the kerb of the stop
  const zig: number[] = [];
  for (let z = 6, k = 0; z >= -9; z -= 1.5, k++) zig.push(k % 2 ? 2.35 : 3.05, z);
  for (let i = 0; i + 3 < zig.length; i += 2) st.surfaces.push(bar(zig[i], zig[i + 1], zig[i + 2], zig[i + 3], 0.12));
  st.paths.lane = lanePath(1.625, 70, -65);
  // children getting off by the front door (the pavement on the right), and one round the front of the bus
  st.paths.kid1 = polyPath([3.0, -7.0, 4.3, -7.5, 4.4, -12, 4.6, -40]);
  st.paths.kid2 = polyPath([3.0, -7.0, 4.4, -6.4, 4.5, 6, 4.6, 30]);
  st.paths.kid3 = polyPath([3.0, -7.0, 3.9, -8.4, 2.4, -9.6, -4.5, -9.6, -4.7, -16, -4.8, -40]);
  return finish(st);
}

/** 7 · A school bus with its hazard lights on at the stop. */
const SCHOOL_BUS: LessonDef = {
  id: 'schoolBus',
  stage: busStage,
  actors: [
    { id: 'bus', kind: 'bus', name: 'theory.who.bus', display: 'Schulbus', path: 'lane', keys: [[0, 52, 7], [6.5, 78, 0], [30, 78, 0]], side: [[3, -0.15, 2.4]], blink: [[0, 2]] },
    { id: 'me', kind: 'me', path: 'lane', keys: [[0, 28, 7], [3, 45, 4.5], [7.4, 60, 0], [9.6, 60, 0], [12.6, 62.85, 1.9], [15.4, 68.17, 1.9], [16.4, 69.12, 0], [18.4, 69.12, 0], [19.4, 70.07, 1.9], [26, 82.61, 1.9], [28.4, 94.37, 7.9], [29.5, 103.06, 7.9]], side: [[9.6, 3.0, 3.6], [26.1, 0, 2.6]] },
    { id: 'kid1', kind: 'child', leaves: 'bus', look: 3, name: 'theory.who.child', path: 'kid1', keys: [[7.6, 0, 1.1], [30, 33, 1.3]] },
    { id: 'kid2', kind: 'child', leaves: 'bus', look: 18, name: 'theory.who.child', path: 'kid2', keys: [[9, 0, 1.1], [30, 33, 1.3]] },
    { id: 'kid3', kind: 'child', leaves: 'bus', look: 29, name: 'theory.who.child', path: 'kid3', keys: [[11, 0, 1.0], [13, 2.4, 1.2], [19.2, 9.84, 1.2], [26, 18, 1.2]] },
  ],
  steps: [
    { at: 2.8, answers: ['!no', '!yes'], right: '!no', ref: '§ 20 Abs. 3 StVO' },
    { at: 9.2, answers: ['walk', 'normal', 'never'], right: 'walk', ref: '§ 20 Abs. 4 StVO' },
  ],
  end: 29.5,
  view: { at: 'me', ahead: 8, yaw: -0.55, pitch: -0.6, dist: 28 },
};

/** 8 · Overtaking a cyclist in town. */
const OVERTAKE: LessonDef = {
  id: 'overtake',
  stage: () => {
    const st = townStreet(72, -72, 3.25, 2.5);
    st.surfaces.push(...dashes(0, 72, 0, -72, 0.12, 3, 6));
    st.signs.push({ x: 4.1, z: 66, yaw: yawOf(0, 1), codes: ['274-50'] });
    st.paths.lane = lanePath(1.625, 72, -72);
    st.paths.bike = lanePath(2.4, 72, -72);
    st.paths.white = lanePath(-1.625, -72, 72);
    return finish(st);
  },
  actors: [
    { id: 'bike', kind: 'bike', colour: 0x2f8a4a, name: 'theory.who.bike', path: 'bike', keys: [[0, 16, 4.5], [20, 106, 4.5]] },
    { id: 'me', kind: 'me', path: 'lane', keys: [[0, 0, 9], [3, 19.5, 4.6], [9.4, 48.3, 4.5], [12.4, 71.6, 11], [17, 122, 11]], side: [[9.6, 2.05, 2.2], [14.3, 0, 2.2]] },
    { id: 'white', kind: 'car', colour: WHITE, name: 'theory.who.white', path: 'white', keys: [[0, 20, 9], [16, 164, 9]] },
  ],
  steps: [
    { at: 3, answers: ['wait', 'go'], right: 'wait', ref: '§ 5 Abs. 2, Abs. 4 StVO' },
    { at: 9.4, answers: ['m1', 'm15', 'm2'], right: 'm15', ref: '§ 5 Abs. 4 StVO' },
  ],
  end: 16.5,
  view: { at: 'me', ahead: 10, yaw: 0.6, pitch: -0.55, dist: 26 },
  gap: { a: 'me', b: 'bike', t0: 11.9, t1: 13.1 },
};

/** 9 · Turning right: the cyclist in the blind spot. */
const BLIND_SPOT: LessonDef = {
  id: 'blindSpot',
  stage: () => {
    const ns = { lanes: 1, laneW: 3.25, bike: 1.85, walk: 2.5, centre: 'dash' as const };
    const ew = { lanes: 1, laneW: 3.25, walk: 2.5, centre: 'dash' as const };
    const c = crossroads({
      ns,
      ew,
      r: 6,
      arms: {
        S: { len: 66, line: 'stop', light: { id: 'ns' } },
        N: { len: 32, line: 'stop', light: { id: 'ns' } },
        E: { len: 28, line: 'stop', light: { id: 'ew' } },
        W: { len: 28, line: 'stop', light: { id: 'ew' } },
      },
    });
    const st = c.stage;
    st.paths.me = c.move('S', 'E');
    st.paths.bike = c.move('S', 'N', 'bike');
    // the arrow for turning right in the lane, and a bicycle on the cycle lane (drawn simply: an arrow straight on)
    st.surfaces.push(laneArrow(1.625, 16, 0, 'right'), laneArrow(4.175, 18, 0, 'straight'));
    return st;
  },
  actors: [
    { id: 'me', kind: 'me', path: 'me', keys: [[0, 'line-21', 8], [3.6, 'line-2.6', 2.2], [5.6, 'line', 0], [7.2, 'line', 0], [10.4, 'line+10.4', 6.5], [12, 'line+21', 6.8]], blink: [[0, 1], [10.5, 0]] },
    { id: 'bike', kind: 'bike', colour: 0xd35a1f, name: 'theory.who.bike', path: 'bike', keys: [[0, 34, 5.2], [12, 96.4, 5.2]] },
  ],
  lights: { ns: [[0, 'G']], ew: [[0, 'R']] },
  steps: [{ at: 3.6, answers: ['me', 'bike'], right: 'bike', ref: '§ 9 Abs. 1, Abs. 3 StVO', ask: 'theory.ask.first', blind: 'me' }],
  end: 12,
  view: { at: [2, 8], yaw: 0.55, pitch: -0.7, dist: 26 },
};

/** The street where the right lane ends: two lanes north, one south. */
function zipStage(): Stage {
  const taper = { z0: -20, z1: -34, to: 3.25 };
  const st = straight({
    z0: 72,
    z1: -72,
    bounds: [{ x: -5.75 }, { x: -3.25 }, { x: 6.5, taper }, { x: 9 }],
    strips: ['walk', 'asphalt', 'walk'],
    kerbs: [1, 2],
  });
  st.surfaces.push(...dashes(0, 72, 0, -72, 0.12, 3, 6), ...along({ x: 3.25 }, 72, -20, 0.12, [3, 6]));
  st.signs.push({ x: 7.3, z: 40, yaw: yawOf(0, 1), codes: ['121-10'] });
  st.surfaces.push(laneArrow(4.6, 6, 0, 'left'), laneArrow(4.6, -12, 0, 'left'));
  st.paths.left = lanePath(1.625, 72, -72);
  st.paths.right = lanePath(4.875, 72, -72);
  return finish(st);
}

/** 10 · Where a lane ends: taking turns (the zip). */
const ZIP: LessonDef = {
  id: 'zip',
  stage: zipStage,
  actors: [
    { id: 'l1', kind: 'car', colour: SILVER, path: 'left', keys: [[0, 84, 4], [16, 148, 4]] },
    { id: 'l2', kind: 'car', colour: BLUE, name: 'theory.who.blue', path: 'left', keys: [[0, 68, 4], [16, 132, 4]] },
    { id: 'l3', kind: 'car', colour: GREEN, path: 'left', keys: [[0, 52, 4], [16, 116, 4]] },
    { id: 'l4', kind: 'car', colour: DARK, path: 'left', keys: [[0, 36, 4], [16, 100, 4]] },
    { id: 'r1', kind: 'car', colour: RED, path: 'right', keys: [[0, 72, 6], [3.8, 92, 4], [16, 140.8, 4]], side: [[3.1, 3.25, 2.4]], blink: [[1.2, -1], [5.6, 0]] },
    { id: 'me', kind: 'me', path: 'right', keys: [[0, 32, 9], [7.8, 92, 4], [16, 124.8, 4]], side: [[7.1, 3.25, 2.4]], blink: [[5.2, -1], [9.6, 0]] },
  ],
  steps: [{ at: 2, answers: ['end', 'early', 'stop'], right: 'end', ref: '§ 7 Abs. 4 StVO' }],
  end: 12.5,
  view: { at: [3, -4], yaw: 0.5, pitch: -0.75, dist: 46 },
};

/** The motorway with the lane to join it: two lanes each way, the acceleration lane on the right. */
function motorwayStage(): Stage {
  const st = straight({
    z0: 72,
    z1: -72,
    bounds: [{ x: -12 }, { x: -1 }, { x: 1 }, { x: 13, taper: { z0: -30, z1: -55, to: 9.25 } }, { x: 15.5, taper: { z0: -30, z1: -55, to: 11.75 } }],
    strips: ['asphalt', 'grass', 'asphalt', 'asphalt'],
    guards: [0],
  });
  st.surfaces.push(
    ...along({ x: -1.75 }, 72, -72, 0.15),
    ...along({ x: -5.5 }, 72, -72, 0.15, [6, 12]),
    ...along({ x: -9.25 }, 72, -72, 0.25),
    ...along({ x: 1.75 }, 72, -72, 0.15),
    ...along({ x: 5.5 }, 72, -72, 0.15, [6, 12]),
    // the broad broken line between the motorway and the lane joining it, then the edge line again
    ...along({ x: 9.25 }, 72, -30, 0.3, [6, 6]),
    ...along({ x: 9.25 }, -55, -72, 0.25),
    ...along({ x: 13, taper: { z0: -30, z1: -55, to: 9.25 } }, 72, -55, 0.25),
  );
  st.paths.left = lanePath(3.625, 72, -72);
  st.paths.right = lanePath(7.375, 72, -72);
  st.paths.ramp = lanePath(11.125, 72, -72);
  return finish(st);
}

/** 11 · Joining the motorway: who goes first? */
const MOTORWAY: LessonDef = {
  id: 'motorway',
  stage: motorwayStage,
  actors: [
    { id: 'me', kind: 'me', path: 'ramp', keys: [[0, 4, 12], [2, 30, 13.5], [4.9, 69, 13.5], [7.5, 107, 16.5], [10, 148, 16.5]], side: [[4.8, 3.75, 2.2]], blink: [[0.4, -1], [7.2, 0]] },
    { id: 'truck', kind: 'truck', name: 'theory.who.truck', path: 'right', keys: [[0, 4, 16.5], [10, 169, 16.5]] },
    { id: 'fast', kind: 'car', colour: DARK, path: 'left', keys: [[0, -22, 21], [10, 188, 21]] },
  ],
  steps: [{ at: 2, answers: ['me', 'truck'], right: 'truck', ref: '§ 18 Abs. 3 StVO', ask: 'theory.ask.first' }],
  end: 9.6,
  view: { at: 'me', ahead: 6, yaw: 0.55, pitch: -0.55, dist: 34 },
};

/** 12 · A roundabout: who goes first, and when to indicate. */
const ROUNDABOUT: LessonDef = {
  id: 'roundabout',
  stage: () => {
    const r = roundabout({ island: 8, apron: 9.5, outer: 15.5, laneW: 3.25, len: { N: 30, E: 30, S: 66, W: 30 }, r: 8 });
    r.stage.paths.me = r.move('S', 'N');
    r.stage.paths.red = r.move('W', 'E');
    return r.stage;
  },
  actors: [
    { id: 'me', kind: 'me', path: 'me', keys: [[0, 'line-26', 8.3], [1, 'line-17.7', 8.3], [5.3, 'line', 0], [6.8, 'line', 0], [10.4, 'ring+2', 5.5], [12.5, 'pass:E+2', 6], [14.55, 'exit+2', 6], [17, 'out+6', 8]], blink: [[12.55, 1], [16.2, 0]] },
    { id: 'red', kind: 'car', colour: RED, name: 'theory.who.red', path: 'red', keys: [[0, 'pass:S-33', 7], [12, 'pass:S+51', 7]], blink: [[5, 1], [8.2, 0]] },
  ],
  steps: [
    { at: 3.4, answers: ['me', 'red'], right: 'red', ref: '§ 8 Abs. 1a StVO', ask: 'theory.ask.first' },
    { at: 6.6, answers: ['none', 'right', 'left'], right: 'none', ref: '§ 8 Abs. 1a StVO' },
    { at: 12.5, answers: ['right', 'none'], right: 'right', ref: '§ 8 Abs. 1a, § 9 Abs. 1 StVO' },
  ],
  end: 17.4,
  view: { at: [0, 6], yaw: 0.4, pitch: -0.85, dist: 46 },
};

/** 13 · The green arrow beside a red light. */
const GREEN_ARROW: LessonDef = {
  id: 'greenArrow',
  stage: () => {
    const road = { lanes: 1, laneW: 3.25, walk: 2.5, centre: 'dash' as const };
    const furt = { at: 2, w: 4, kind: 'furt' as const };
    const c = crossroads({
      ns: road,
      ew: road,
      r: 6,
      arms: {
        S: { len: 66, line: 'stop', light: { id: 'ns', arrow: true }, xing: furt, pedLight: 'pns' },
        N: { len: 30, line: 'stop', light: { id: 'ns' }, xing: furt, pedLight: 'pns' },
        E: { len: 30, line: 'stop', light: { id: 'ew' }, xing: furt, pedLight: 'pew' },
        W: { len: 30, line: 'stop', light: { id: 'ew' }, xing: furt, pedLight: 'pew' },
      },
    });
    const st = c.stage;
    st.paths.me = c.move('S', 'E');
    st.paths.white = c.move('W', 'E');
    // somebody crossing the south arm from east to west, on their green
    const z = c.xingAt('S');
    st.paths.walker = polyPath([4.6, 16, 4.6, z + 4.15, 5.4, z, -5.4, z, -4.6, z + 4.15, -4.6, z + 14.75]);
    st.surfaces.push(laneArrow(1.625, 20, 0, 'right'));
    return st;
  },
  actors: [
    { id: 'me', kind: 'me', path: 'me', keys: [[0, 'line-30', 8.3], [3, 'line-11', 6], [6.7, 'line', 0], [9, 'line', 0], [12.4, 'line+11', 6.5], [14, 'line+21.6', 6.8]], blink: [[0, 1], [12.6, 0]] },
    { id: 'white', kind: 'car', colour: WHITE, name: 'theory.who.white', path: 'white', keys: [[0, 0, 9], [10, 90, 9]] },
    { id: 'walker', kind: 'person', look: 41, name: 'theory.who.walker', path: 'walker', keys: [[0, 5.45, 1.25], [24, 35.45, 1.25]] },
  ],
  // the lights of the junction: red for you (with the arrow), green across; the people crossing your road walk with the green across
  lights: { ns: [[0, 'R']], ew: [[0, 'G']], pns: [[0, 'G']], pew: [[0, 'R']] },
  steps: [
    { at: 3, answers: ['stop', 'roll', 'nothing'], right: 'stop', ref: '§ 37 Abs. 2 StVO, Zeichen 720' },
    { at: 7, answers: ['me', 'walker'], right: 'walker', ref: '§ 37 Abs. 2 StVO', ask: 'theory.ask.first' },
  ],
  end: 14,
  view: { at: [1, 8], yaw: 0.5, pitch: -0.68, dist: 30 },
};

/** Every lesson, in the order of the list. */
export const THEORY: readonly LessonDef[] = [RBL, BEND, LEFT_TURN, ZEBRA, TRAM_LESSON, CORRIDOR, SCHOOL_BUS, OVERTAKE, BLIND_SPOT, ZIP, MOTORWAY, ROUNDABOUT, GREEN_ARROW];

/** The mode of the main menu that opens the theory lessons. */
export const THEORY_MODE = 'theory';

// ------------------------------------------------------------------- texts
/** The text keys of a lesson and its steps (n: the step's number, from 1). */
export const theoryKeys = {
  title: (id: string): string => `theory.${id}.title`,
  intro: (id: string): string => `theory.${id}.intro`,
  text: (id: string, n: number): string => `theory.${id}.${n}.text`,
  ask: (id: string, n: number, step: StepDef): string => step.ask ?? `theory.${id}.${n}.ask`,
  why: (id: string, n: number): string => `theory.${id}.${n}.why`,
};

/** The text key of an answer: an actor's name, a common answer ('!yes'), or one of the step's own. */
export function answerKey(lesson: LessonDef, n: number, answer: string): string {
  if (answer.startsWith('!')) return `theory.a.${answer.slice(1)}`;
  const a = lesson.actors.find((x) => x.id === answer);
  if (a) return actorName(a);
  return `theory.${lesson.id}.${n}.${answer}`;
}

/** What an actor is called (a text key). */
export function actorName(a: ActorDef): string {
  return a.name ?? (a.kind === 'me' ? 'theory.who.me' : `theory.who.${a.kind}`);
}

/** Every text key the lessons use (for the tests). */
export function allTheoryKeys(): string[] {
  const keys = new Set<string>();
  for (const l of THEORY) {
    keys.add(theoryKeys.title(l.id)).add(theoryKeys.intro(l.id));
    l.steps.forEach((s, i) => {
      const n = i + 1;
      keys.add(theoryKeys.text(l.id, n)).add(theoryKeys.ask(l.id, n, s)).add(theoryKeys.why(l.id, n));
      for (const a of s.answers) keys.add(answerKey(l, n, a));
    });
    for (const a of l.actors) keys.add(actorName(a));
  }
  return [...keys];
}

// ------------------------------------------------------------------ motion
/** An actor of a lesson with its path and its keys as numbers. */
export interface ActorRun {
  def: ActorDef;
  path: Path;
  foot: Footprint;
  keys: Array<{ t: number; s: number; v: number }>;
}

/** A lesson made ready to play: its place and its actors. */
export interface Scene {
  lesson: LessonDef;
  stage: Stage;
  actors: ActorRun[];
}

/** A place on a path by its mark, ± metres ('line-12', 'pass:S+4'), or metres. */
export function markAt(path: Path, at: number | string): number {
  if (typeof at === 'number') return at;
  const m = /^(.+?)([+-]\d+(?:\.\d+)?)?$/.exec(at.trim());
  const name = m ? m[1] : at;
  const base = path.marks[name];
  if (base === undefined) throw new Error(`no mark "${name}" on the path`);
  return base + (m?.[2] ? Number(m[2]) : 0);
}

/** Build a lesson's place and resolve its actors' keys. */
export function prepare(lesson: LessonDef): Scene {
  const stage = lesson.stage();
  const actors = lesson.actors.map((def): ActorRun => {
    const path = stage.paths[def.path];
    if (!path) throw new Error(`${lesson.id}: no path "${def.path}" for ${def.id}`);
    const keys = def.keys.map(([t, at, v]) => ({ t, s: markAt(path, at), v }));
    return { def, path, foot: FOOT[def.kind], keys };
  });
  return { lesson, stage, actors };
}

/** Where along its path an actor's nose is at time t, how fast it goes and how it speeds up. */
export interface Progress {
  s: number;
  v: number;
  a: number;
  /** before its first key: not there yet */
  started: boolean;
}

/**
 * The nose along the path at time t: between two keys a smooth curve
 * (cubic Hermite) through both positions with both speeds; before the first
 * key it waits there, after the last it goes on at the last speed.
 */
export function progressAt(keys: ActorRun['keys'], t: number, out: Progress): Progress {
  const n = keys.length;
  const first = keys[0];
  out.started = t >= first.t;
  if (t <= first.t) {
    out.s = first.s;
    out.v = first.v;
    out.a = 0;
    return out;
  }
  const last = keys[n - 1];
  if (t >= last.t) {
    out.s = last.s + last.v * (t - last.t);
    out.v = last.v;
    out.a = 0;
    return out;
  }
  let i = 0;
  while (i < n - 2 && keys[i + 1].t <= t) i++;
  const k0 = keys[i];
  const k1 = keys[i + 1];
  const h = k1.t - k0.t;
  const u = (t - k0.t) / h;
  const u2 = u * u;
  const u3 = u2 * u;
  const m0 = k0.v * h;
  const m1 = k1.v * h;
  out.s = (2 * u3 - 3 * u2 + 1) * k0.s + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * k1.s + (u3 - u2) * m1;
  out.v = ((6 * u2 - 6 * u) * k0.s + (3 * u2 - 4 * u + 1) * m0 + (-6 * u2 + 6 * u) * k1.s + (3 * u2 - 2 * u) * m1) / h;
  out.a = ((12 * u - 6) * k0.s + (6 * u - 4) * m0 + (-12 * u + 6) * k1.s + (6 * u - 2) * m1) / (h * h);
  return out;
}

function smooth(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

/** How far an actor is moved sideways from its path at time t (+ to the left), and how fast that changes. */
export function sideAt(def: ActorDef, t: number): { off: number; rate: number } {
  let from = 0;
  let off = 0;
  let rate = 0;
  for (const [t0, to, dur] of def.side ?? []) {
    if (t <= t0) break;
    const x = (t - t0) / dur;
    const c = Math.max(0, Math.min(1, x));
    off = from + (to - from) * smooth(x);
    rate = x < 1 ? ((to - from) * 6 * c * (1 - c)) / dur : 0;
    from = to;
  }
  return { off, rate };
}

/** An actor's indicators at time t: −1 left, 0 off, 1 right, 2 hazard lights. */
export function blinkAt(def: ActorDef, t: number): number {
  let b = 0;
  for (const [t0, state] of def.blink ?? []) if (t >= t0) b = state;
  return b;
}

/** Where an actor is and how it stands at a moment. */
export interface Pose {
  visible: boolean;
  /** the point the model is placed by (the middle between the axles; a person's feet) */
  x: number;
  z: number;
  yaw: number;
  /** the nose along the path */
  s: number;
  v: number;
  a: number;
  /** the front wheels' angle (+ to the right, like the cars' models) */
  steer: number;
  blink: number;
}

export function newPose(): Pose {
  return { visible: false, x: 0, z: 0, yaw: 0, s: 0, v: 0, a: 0, steer: 0, blink: 0 };
}

const pp = newPathPoint();
const pq = newPathPoint();
const prog: Progress = { s: 0, v: 0, a: 0, started: false };

/** A point `s` along the path, moved `off` to the left of it. */
function offPoint(path: Path, s: number, off: number): [number, number] {
  pathPoint(path, s, pp);
  return [pp.x + pp.dz * off, pp.z - pp.dx * off];
}

const back: Progress = { s: 0, v: 0, a: 0, started: false };

/**
 * When the nose was at `s` (a moment no later than `t`; the scripts never
 * go backwards) – found by halving the interval.  Before the first key: then.
 */
export function timeAt(keys: ActorRun['keys'], s: number, t: number): number {
  let lo = keys[0].t;
  if (progressAt(keys, lo, back).s >= s) return lo;
  let hi = t;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (progressAt(keys, mid, back).s < s) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function wrapPi(a: number): number {
  let d = a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** An actor at time t. */
export function poseAt(r: ActorRun, t: number, out: Pose): Pose {
  const p = progressAt(r.keys, t, prog);
  const f = r.foot;
  const { off, rate } = sideAt(r.def, t);
  out.s = p.s;
  out.v = p.v;
  out.a = p.a;
  out.blink = blinkAt(r.def, t);
  // there from its first key until all of it has gone past the end of its path
  out.visible = p.started && p.s - f.length <= r.path.len + 0.5;
  const mid = p.s - f.front;
  // (the way it is heading drawn sideways as much as it moves sideways at that speed)
  const lean = Math.atan2(rate, Math.max(Math.abs(p.v), 1));
  if (f.wheelbase > 0) {
    // the front axle where the script has it; the rear axle on the track the front one took – sideways
    // where the front was when it passed the place the rear is at now
    const sf = mid + f.wheelbase / 2;
    const sr = mid - f.wheelbase / 2;
    const offR = sideAt(r.def, timeAt(r.keys, p.s - f.wheelbase, t)).off;
    const [fx, fz] = offPoint(r.path, sf, off);
    const [bx, bz] = offPoint(r.path, sr, offR);
    out.x = (fx + bx) / 2;
    out.z = (fz + bz) / 2;
    const body = yawOf(fx - bx, fz - bz);
    out.yaw = body;
    // the front wheels point where the front axle goes: along the path there, drawn sideways with it
    pathPoint(r.path, sf + 0.3, pq);
    const ahead = yawOf(pq.dx, pq.dz) + lean;
    out.steer = -Math.max(-0.6, Math.min(0.6, wrapPi(ahead - body) * 1.6));
  } else {
    // a person (its feet), or a tram (its nose – the drawing places it car by car from there)
    const [x, z] = offPoint(r.path, mid, off);
    out.x = x;
    out.z = z;
    const [ax, az] = offPoint(r.path, mid + 0.35, off);
    const [bx, bz] = offPoint(r.path, mid - 0.35, off);
    out.yaw = yawOf(ax - bx, az - bz) + lean;
    out.steer = 0;
  }
  return out;
}

/**
 * The four corners of an actor's outline at a pose (x, z, …), made `grow`
 * metres larger all round: a vehicle from its nose to its tail, a tram back
 * from its nose, a person round its feet.
 */
export function corners(r: ActorRun, p: Pose, grow = 0): number[] {
  const f = r.foot;
  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  // (to the left of the heading)
  const lx = fz;
  const lz = -fx;
  const hw = f.width / 2 + grow;
  const ahead = (r.def.kind === 'tram' ? 0 : f.wheelbase > 0 ? f.front : f.length / 2) + grow;
  const behind = (r.def.kind === 'tram' ? f.length : f.wheelbase > 0 ? f.length - f.front : f.length / 2) + grow;
  return [
    p.x + fx * ahead + lx * hw, p.z + fz * ahead + lz * hw,
    p.x + fx * ahead - lx * hw, p.z + fz * ahead - lz * hw,
    p.x - fx * behind - lx * hw, p.z - fz * behind - lz * hw,
    p.x - fx * behind + lx * hw, p.z - fz * behind + lz * hw,
  ];
}

/** Do two convex outlines (x, z, …) overlap? (separating axes) */
export function outlinesTouch(a: readonly number[], b: readonly number[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i += 2) {
      const j = (i + 2) % poly.length;
      const nx = poly[i + 1] - poly[j + 1];
      const nz = poly[j] - poly[i];
      let amin = Infinity;
      let amax = -Infinity;
      let bmin = Infinity;
      let bmax = -Infinity;
      for (let k = 0; k < a.length; k += 2) {
        const d = a[k] * nx + a[k + 1] * nz;
        amin = Math.min(amin, d);
        amax = Math.max(amax, d);
      }
      for (let k = 0; k < b.length; k += 2) {
        const d = b[k] * nx + b[k + 1] * nz;
        bmin = Math.min(bmin, d);
        bmax = Math.max(bmax, d);
      }
      if (amax < bmin || bmax < amin) return false;
    }
  }
  return true;
}

/** A traffic light's state at time t. */
export function lightAt(scene: Scene, id: string, t: number): LightState {
  let s: LightState = 'O';
  for (const [t0, state] of scene.lesson.lights?.[id] ?? []) if (t >= t0) s = state;
  return s;
}

/** The height of an actor's ground above the map's: on the road, or on a pavement or island it walks over. */
export function actorLift(scene: Scene, r: ActorRun, x: number, z: number): number {
  if (r.def.kind === 'person' || r.def.kind === 'child') {
    let best = LIFT.asphalt;
    for (const s of scene.stage.surfaces) {
      if (s.kind !== 'walk' && s.kind !== 'island') continue;
      if (LIFT[s.kind] > best && inSurface(s, x, z)) best = LIFT[s.kind];
    }
    return best;
  }
  return LIFT.asphalt;
}

function inSurface(s: Surface, x: number, z: number): boolean {
  // (as theorystage.covers – kept here so the hot path needs no allocation)
  const ring = s.ring;
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const zi = ring[i + 1];
    const zj = ring[j + 1];
    if (zi > z !== zj > z && x < ((ring[j] - ring[i]) * (z - zi)) / (zj - zi) + ring[i]) inside = !inside;
  }
  if (!inside) return false;
  for (const h of s.holes ?? []) if (inSurface({ kind: s.kind, ring: h }, x, z)) return false;
  return true;
}

// -------------------------------------------------------------------- a run
/** playing; stopped at a question; told whether the answer was right; over */
export type Phase = 'play' | 'ask' | 'told' | 'end';

/**
 * One go at a lesson: its clock, the step it is at, the answers given.  The
 * clock stands still while a question is open and while the answer is
 * explained; `goOn` lets the scene play on – the right way – to the next
 * question or the end.
 */
export class TheoryRun {
  readonly scene: Scene;
  t = 0;
  /** the step that is asked next (or now) */
  step = 0;
  phase: Phase = 'play';
  /** the answer given to the open step */
  picked: string | null = null;
  /** how many were answered right the first time */
  right = 0;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  get current(): StepDef | null {
    return this.scene.lesson.steps[this.step] ?? null;
  }

  /** On by dt seconds while playing: true when it stopped (a question, or the end). */
  advance(dt: number): boolean {
    if (this.phase !== 'play') return false;
    const next = this.current;
    const t = this.t + dt;
    if (next && t >= next.at) {
      this.t = next.at;
      this.phase = 'ask';
      this.picked = null;
      return true;
    }
    const end = this.scene.lesson.end;
    if (!next && t >= end) {
      this.t = end;
      this.phase = 'end';
      return true;
    }
    this.t = t;
    return false;
  }

  /** The answer to the open question: right or not (null: no question is open). */
  answer(id: string): boolean | null {
    const s = this.current;
    if (this.phase !== 'ask' || !s || !s.answers.includes(id)) return null;
    this.picked = id;
    this.phase = 'told';
    const ok = id === s.right;
    if (ok) this.right++;
    return ok;
  }

  /** Play on after the explanation. */
  goOn(): void {
    if (this.phase !== 'told') return;
    this.step++;
    this.phase = 'play';
    this.picked = null;
  }

  restart(): void {
    this.t = 0;
    this.step = 0;
    this.phase = 'play';
    this.picked = null;
    this.right = 0;
  }

  /** On to time t at once (for pictures of a moment): the questions before it count as answered right; one asked exactly then is open. */
  skipTo(t: number): void {
    this.restart();
    while (this.current && this.current.at < t) {
      this.right++;
      this.step++;
    }
    this.t = Math.max(0, Math.min(t, this.scene.lesson.end));
    const next = this.current;
    if (next && next.at <= this.t + 1e-9) {
      this.t = next.at;
      this.phase = 'ask';
    } else if (!next && this.t >= this.scene.lesson.end) this.phase = 'end';
  }
}
