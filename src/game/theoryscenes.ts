// SPDX-License-Identifier: AGPL-3.0-only
/**
 * More theory lessons (game/theory.ts runs them like the first thirteen):
 * where you may stop and where you may park, the distance to the car ahead,
 * an obstacle and a cyclist on a country road, a bus leaving its stop, the
 * headlights at night, a wall of fog, an accident ahead, the lorry turning
 * right, a lane that ends, a tunnel, an old lady with a rollator, a deer at
 * dusk, a police officer directing the traffic and a flagman at roadworks.
 *
 * The texts are written from the StVO itself (and § 323c of the criminal
 * code for first aid); the rules of thumb – half the speedometer, the
 * stopping distance, the warning triangle's 100 m – are the ones every
 * driving school teaches.  Every scene keeps to what the tests of
 * tests/game/theory.test.ts ask of all of them: nobody touches anybody,
 * vehicles stay on the asphalt, nobody brakes like a wall.
 *
 * Besides the scripts: what the people at work and the animals of these
 * scenes do – which way somebody faces, a police officer's arms, a
 * flagman's sign, the headlights – as plain functions of the script's time,
 * for render/theory.ts and the tests.  Only types come from game/theory.ts
 * (which lists these lessons after its own).
 */
import { along, bar, crossroads, dashes, finish, lanePath, polyPath, straight, Trace, yawOf } from './theorystage.ts';
import type { PropPlace, Stage } from './theorystage.ts';
import type { ActorDef, Gesture, Key, LessonDef } from './theory.ts';

// ------------------------------------------------------------------ timing
/** One leg of a script: on for `dt` seconds to the speed `v` (evenly faster or slower), on to `to` metres arriving at `v`, or standing for `wait` seconds. */
type Leg = { dt: number; v: number } | { to: number; v: number } | { wait: number };

/**
 * The keys of a script from where it starts (time, metres, speed) and its
 * legs: each leg speeds up or slows down evenly, so that the curve through
 * the keys (theory.ts progressAt) brakes and pulls away as smoothly as a
 * driver does.
 */
export function plan(t: number, s: number, v: number, ...legs: Leg[]): Key[] {
  const keys: Key[] = [[t, s, v]];
  for (const l of legs) {
    if ('wait' in l) t += l.wait;
    else if ('to' in l) {
      t += (2 * (l.to - s)) / (v + l.v);
      s = l.to;
      v = l.v;
    } else {
      s += (l.dt * (v + l.v)) / 2;
      t += l.dt;
      v = l.v;
    }
    keys.push([t, s, v]);
  }
  return keys;
}

/** Standing still at `s` (a parked lorry, a police officer). */
const stand = (s: number | string): Key[] => [[0, s, 0]];

// ------------------------------------------------------------- what people do
function smooth(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

function wrap(a: number): number {
  let d = a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Which way a person faces at time t (a yaw of the stage): as `base` (its path) until the first turn, then turning smoothly. */
export function faceAt(def: ActorDef, t: number, base: number): number {
  let from = base;
  let yaw = base;
  for (const [t0, to, dur] of def.face ?? []) {
    if (t <= t0) break;
    yaw = from + wrap(to - from) * smooth((t - t0) / Math.max(1e-3, dur));
    from = to;
  }
  return wrap(yaw);
}

/** A person's sign at time t, and since when it is shown (null: none). */
export function gestureAt(def: ActorDef, t: number): { sign: Gesture; since: number; was: Gesture } | null {
  let sign: Gesture | null = null;
  let was: Gesture | null = null;
  let since = 0;
  for (const [t0, g] of def.gesture ?? []) {
    if (t < t0) break;
    was = sign ?? g;
    sign = g;
    since = t0;
  }
  return sign && was ? { sign, since, was } : null;
}

/** how long a police officer takes to move his arms from one sign to the next, and a flagman to turn his sign (s) */
const MOVE = 0.6;

/** The arms of each sign: the right arm swung forward and out to the side, the left arm the same (rad – render/people.ts PersonPose.arms). */
const ARMS: Record<Gesture, [number, number, number, number]> = {
  // the basic position: the arms hanging
  down: [0.03, 0.07, 0.03, 0.07],
  // both arms out to the sides, level with the shoulders
  arms: [0, 1.52, 0, 1.52],
  // the right arm straight up
  raise: [3.0, 0.08, 0.03, 0.07],
  // the flagman holds his sign up in front of him with the right hand
  stop: [1.15, 0.22, 0.03, 0.07],
  go: [1.15, 0.22, 0.03, 0.07],
};

/** hands on the handles of a rollator */
const ROLLATOR_ARMS: [number, number, number, number] = [0.62, 0.1, 0.62, 0.1];

/** How a person holds the arms at time t (null: as anybody walking or standing). */
export function armsAt(def: ActorDef, t: number): [number, number, number, number] | null {
  if (def.role === 'senior') return ROLLATOR_ARMS;
  const g = gestureAt(def, t);
  if (!g) return null;
  const a = ARMS[g.was];
  const b = ARMS[g.sign];
  const k = smooth((t - g.since) / MOVE);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
}

/** How far a flagman's sign is turned at time t: 0 its red side to the one he faces, 1 its green side. */
export function paddleAt(def: ActorDef, t: number): number {
  const g = gestureAt(def, t);
  if (!g) return 0;
  const a = g.was === 'go' ? 1 : 0;
  const b = g.sign === 'go' ? 1 : 0;
  return a + (b - a) * smooth((t - g.since) / MOVE);
}

/** An actor's headlights at time t: 0 off, 1 dipped, 2 full beam. */
export function beamAt(def: ActorDef, t: number): number {
  let b = 0;
  for (const [t0, state] of def.beam ?? []) if (t >= t0) b = state;
  return b;
}

// ------------------------------------------------------------------ places
const BLUE = 0x2f5f8a;
const RED = 0xa8231b;
const WHITE = 0xe2e2dc;
const GREEN = 0x2f7a46;
const SILVER = 0x9aa1a8;
/** facing south (towards you coming up from the south), east */
const SOUTH = Math.PI;
const EAST = -Math.PI / 2;

/** A street in town north–south: one lane each way (laneW), pavements (walk), the broken middle line. */
function townRoad(z0: number, z1: number, laneW: number, walk: number): Stage {
  const st = straight({ z0, z1, bounds: [{ x: -laneW - walk }, { x: -laneW }, { x: laneW }, { x: laneW + walk }], strips: ['walk', 'asphalt', 'walk'], kerbs: [1, 2] });
  st.surfaces.push(...dashes(0, z0, 0, z1, 0.12, 3, 6));
  return st;
}

/**
 * A country road north–south from z = 72 to −72: one lane each way, the
 * broken middle line and the edge lines; the guide posts (Leitpfosten) on
 * both sides every 50 m – as on every country road, a measure of how far
 * one sees.
 */
function countryRoad(laneW = 3.25, walkway = 0): Stage {
  const bounds = walkway > 0 ? [{ x: -laneW - walkway }, { x: -laneW }, { x: laneW }, { x: laneW + walkway }] : [{ x: -laneW }, { x: laneW }];
  const st = straight({ z0: 72, z1: -72, bounds, strips: walkway > 0 ? ['walk', 'asphalt', 'walk'] : ['asphalt'], kerbs: walkway > 0 ? [1, 2] : [] });
  st.surfaces.push(...along({ x: 0 }, 72, -72, 0.12, [6, 12]), ...along({ x: laneW - 0.3 }, 72, -72, 0.15), ...along({ x: -laneW + 0.3 }, 72, -72, 0.15));
  const props: PropPlace[] = [];
  if (walkway === 0) {
    for (const z of [60, 10, -40]) {
      props.push({ kind: 'post', x: laneW + 0.9, z, yaw: yawOf(0, 1) }, { kind: 'post', x: -laneW - 0.9, z, yaw: yawOf(0, -1) });
    }
  }
  st.props = props;
  return st;
}

/** Trees along both sides of a country road (a forest): rows from the road out, a little out of line. */
function forest(st: Stage, near: number, from: number, to: number): void {
  const props = (st.props ??= []);
  let k = 0;
  for (let z = from; z > to; z -= 5.5) {
    for (const side of [1, -1]) {
      for (let row = 0; row < 3; row++) {
        k++;
        const jitter = ((k * 7919) % 13) / 13 - 0.5;
        props.push({ kind: 'tree', x: side * (near + row * 4.2 + jitter * 1.6), z: z + jitter * 2.4 + row * 1.7, size: 0.85 + (((k * 31) % 7) / 7) * 0.4 });
      }
    }
  }
}

// ------------------------------------------------------------- 1 · parking
function parkingStage(): Stage {
  const ns = { lanes: 1, laneW: 3.5, walk: 2.5, centre: 'dash' as const };
  const ew = { lanes: 1, laneW: 3.25, walk: 2.5, centre: 'dash' as const };
  const c = crossroads({
    ns,
    ew,
    r: 5,
    arms: {
      S: { len: 68, signs: [{ at: 56, codes: ['283'] }, { at: 34, codes: ['286'] }] },
      N: { len: 36 },
      E: { len: 22 },
      W: { len: 22 },
    },
  });
  c.stage.paths.me = c.move('S', 'N');
  // your passenger: out by the door on the right, onto the pavement and away south
  c.stage.paths.walker = polyPath([2.9, 19.7, 4.3, 20.2, 4.75, 21.5, 4.75, 62]);
  return c.stage;
}
const PARK = parkingStage().paths.me;
const parkLine = PARK.marks.line;

/** 1 · Stopping and parking: Zeichen 283, Zeichen 286, how far from a junction. */
const PARKING: LessonDef = {
  id: 'parkingSigns',
  stage: parkingStage,
  actors: [
    {
      id: 'me',
      kind: 'me',
      path: 'me',
      // through the zone of 283, a stop at the kerb under 286, on over the junction and parked beyond it
      keys: plan(0, parkLine - 60, 10, { dt: 1.5, v: 10 }, { to: parkLine - 13.9, v: 0 }, { wait: 3.6 }, { dt: 2.5, v: 8 }, { to: parkLine + 27, v: 0 }, { wait: 1 }),
      side: [[5.2, -0.62, 2.2], [11.4, 0, 1.8], [17.4, -0.62, 2.4]],
      blink: [[4.8, 1], [7.8, 0], [11.0, -1], [13.2, 0], [16.8, 1], [21, 0]],
    },
    { id: 'walker', kind: 'person', look: 13, leaves: 'me', name: 'theory.who.passenger', path: 'walker', keys: plan(8.3, 0, 0.8, { dt: 1, v: 1.3 }, { dt: 12, v: 1.3 }) },
  ],
  steps: [
    { at: 1.5, answers: ['!no', '!yes'], right: '!no', ref: 'Anlage 2 StVO, Zeichen 283' },
    { at: 7.9, answers: ['out', 'never', 'park'], right: 'out', ref: '§ 12 Abs. 2 StVO, Anlage 2 StVO, Zeichen 286' },
    { at: 15.2, answers: ['m3', 'm5', 'm10'], right: 'm5', ref: '§ 12 Abs. 3 Nr. 1 StVO' },
  ],
  end: 22.5,
  view: { at: 'me', ahead: 6, yaw: 0.6, pitch: -0.62, dist: 28 },
};

// ---------------------------------------------------- 2 · following distance
/** 2 · The distance to the car ahead: half the speedometer, the second you need to react, the stopping distance. */
const FOLLOW: LessonDef = {
  id: 'followingDistance',
  stage: () => {
    const st = countryRoad();
    st.signs.push({ x: 4.15, z: 66, yaw: yawOf(0, 1), codes: ['274-60'] });
    st.paths.lane = lanePath(1.625, 72, -72);
    st.paths.other = lanePath(-1.625, -72, 72);
    return finish(st);
  },
  actors: [
    // 60 km/h, 30 m behind the red car; it brakes at 3.2 s, you a second later – and stop with room to spare
    { id: 'me', kind: 'me', path: 'lane', keys: plan(0, 0, 16.67, { dt: 4.2, v: 16.67 }, { dt: 4.76, v: 0 }, { wait: 1.2 }) },
    { id: 'red', kind: 'car', colour: RED, name: 'theory.who.red', path: 'lane', keys: plan(0, 34.3, 16.67, { dt: 3.2, v: 16.67 }, { dt: 4.76, v: 0 }, { wait: 2.2 }) },
    { id: 'white', kind: 'car', colour: WHITE, name: 'theory.who.white', path: 'other', keys: plan(0, 18, 15, { dt: 10, v: 15 }) },
  ],
  steps: [
    { at: 1.5, answers: ['m15', 'm30', 'm60'], right: 'm30', ref: '§ 4 Abs. 1 StVO' },
    { at: 3.3, answers: ['m5', 'm17', 'm30'], right: 'm17', ref: '§ 3 Abs. 1, § 4 Abs. 1 StVO' },
    { at: 5.6, answers: ['m35', 'm54', 'm100'], right: 'm54', ref: '§ 3 Abs. 1, § 4 Abs. 1 StVO' },
  ],
  end: 10.2,
  view: { at: 'me', ahead: 16, yaw: 0.55, pitch: -0.42, dist: 30 },
};

// ------------------------------------------------- 3 · obstacle and cyclist
/** 3 · A country road: passing a cyclist (2 m), then a broken-down lorry in your lane with a car coming. */
const NARROW: LessonDef = {
  id: 'narrowPass',
  stage: () => {
    const st = countryRoad();
    st.paths.lane = lanePath(1.625, 72, -72);
    st.paths.truck = lanePath(1.9, 72, -72);
    st.paths.bike = lanePath(2.4, 72, -72);
    st.paths.other = lanePath(-1.625, -72, 72);
    // the warning triangle behind the lorry
    st.props?.push({ kind: 'triangle', x: 2.6, z: 8, yaw: yawOf(0, 1) });
    return finish(st);
  },
  actors: [
    {
      id: 'me',
      kind: 'me',
      path: 'lane',
      keys: plan(0, -16, 15, { dt: 4.6, v: 15 }, { to: 87, v: 0 }, { wait: 1.13 }, { dt: 3, v: 8 }, { dt: 2, v: 13 }, { dt: 2.5, v: 13 }),
      side: [[1.2, 2.5, 2.0], [4.4, 0, 2.0], [10, 2.5, 2.4], [14.3, 0, 2.0]],
      blink: [[0.6, -1], [3.4, 0], [3.9, 1], [5.6, 0], [9.4, -1], [12, 0], [13.9, 1], [15.6, 0]],
    },
    { id: 'bike', kind: 'bike', colour: 0x2f8a4a, name: 'theory.who.bike', path: 'bike', keys: plan(0, 22, 4.5, { dt: 9.5, v: 4.5 }, { to: 77.7, v: 0 }, { wait: 2 }) },
    { id: 'truck', kind: 'truck', name: 'theory.who.truck', path: 'truck', keys: stand(102.2), blink: [[0, 2]] },
    { id: 'white', kind: 'car', colour: WHITE, name: 'theory.who.white', path: 'other', keys: plan(0, -75, 13, { dt: 17.5, v: 13 }) },
  ],
  steps: [
    { at: 1.0, answers: ['m1', 'm15', 'm2'], right: 'm2', ref: '§ 5 Abs. 4 StVO' },
    { at: 7.4, answers: ['me', 'white'], right: 'white', ref: '§ 6 StVO', ask: 'theory.ask.first' },
  ],
  end: 16.5,
  view: { at: 'me', ahead: 10, yaw: 0.6, pitch: -0.55, dist: 30 },
  gap: { a: 'me', b: 'bike', t0: 3.4, t1: 4.4 },
};

// ------------------------------------------------------ 4 · bus at the stop
function stopStage(): Stage {
  const st = townRoad(70, -65, 3.25, 2.5);
  st.signs.push({ x: 4.1, z: -12, yaw: yawOf(0, 1), codes: ['224'] });
  // the zigzag along the kerb of the stop (Zeichen 299)
  const zig: number[] = [];
  for (let z = 4, k = 0; z >= -12; z -= 1.5, k++) zig.push(k % 2 ? 2.35 : 3.05, z);
  for (let i = 0; i + 3 < zig.length; i += 2) st.surfaces.push(bar(zig[i], zig[i + 1], zig[i + 2], zig[i + 3], 0.12));
  st.paths.lane = lanePath(1.625, 70, -65);
  // two people get off by the front door and walk away along the pavement
  st.paths.p1 = polyPath([2.95, -8.4, 4.3, -8.0, 4.6, -6, 4.6, 40]);
  st.paths.p2 = polyPath([2.95, -8.4, 4.3, -8.8, 4.9, -11, 4.9, -50]);
  return finish(st);
}

/** 4 · A bus at its stop: hazard lights on, then it indicates to pull out. */
const BUS_STOP: LessonDef = {
  id: 'busStopPullOut',
  stage: stopStage,
  actors: [
    { id: 'bus', kind: 'bus', name: 'theory.who.lineBus', display: '52 Baunatal', path: 'lane', keys: plan(0, 80, 0, { wait: 9.6 }, { dt: 4, v: 5 }, { dt: 2, v: 7 }, { dt: 6, v: 7 }), blink: [[0, 2], [7.6, -1], [14.5, 0]] },
    { id: 'me', kind: 'me', path: 'lane', keys: plan(0, 0, 9, { to: 46, v: 2 }, { to: 52.5, v: 0 }, { wait: 1.2 }, { dt: 3, v: 6 }, { dt: 4, v: 7 }) },
    { id: 'p1', kind: 'person', look: 37, leaves: 'bus', name: 'theory.who.walker', path: 'p1', keys: plan(0.4, 0, 0.8, { dt: 1, v: 1.3 }, { dt: 20, v: 1.3 }) },
    { id: 'p2', kind: 'person', look: 52, leaves: 'bus', name: 'theory.who.walker', path: 'p2', keys: plan(2.2, 0, 0.8, { dt: 1, v: 1.2 }, { dt: 20, v: 1.2 }) },
  ],
  steps: [
    { at: 2.4, answers: ['walk', 'slow30', 'normal'], right: 'walk', ref: '§ 20 Abs. 4 StVO' },
    { at: 8.4, answers: ['me', 'bus'], right: 'bus', ref: '§ 20 Abs. 5 StVO', ask: 'theory.ask.first' },
  ],
  end: 21,
  view: { at: 'me', ahead: 10, yaw: -0.6, pitch: -0.58, dist: 30 },
};

// ------------------------------------------------------------- 5 · at night
/** 5 · At night on a country road: dipping for the oncoming car, and only as fast as you can see. */
const NIGHT: LessonDef = {
  id: 'nightDrive',
  stage: () => {
    const st = countryRoad();
    st.paths.lane = lanePath(1.625, 72, -72);
    st.paths.other = lanePath(-1.625, -72, 72);
    // somebody in dark clothes walking along the edge of the road (no pavement): on the left side, facing the traffic
    st.paths.walker = polyPath([-2.9, -51, -2.9, -72]);
    return finish(st);
  },
  actors: [
    {
      id: 'me',
      kind: 'me',
      path: 'lane',
      keys: plan(0, 0, 15, { dt: 3, v: 15 }, { dt: 3, v: 12 }, { dt: 4, v: 12 }),
      beam: [[0, 2], [2.7, 1], [5.6, 2]],
    },
    { id: 'white', kind: 'car', colour: WHITE, name: 'theory.who.white', path: 'other', keys: plan(0, 28, 14, { dt: 10, v: 14 }), beam: [[0, 1]] },
    { id: 'walker', kind: 'person', look: 64, name: 'theory.who.walker', path: 'walker', keys: plan(0, 0, 1.2, { dt: 10, v: 1.2 }) },
  ],
  steps: [
    { at: 2.6, answers: ['dip', 'keep', 'flash'], right: 'dip', ref: '§ 17 Abs. 2 StVO' },
    { at: 5.4, answers: ['sight', 'limit', 'high'], right: 'sight', ref: '§ 3 Abs. 1 StVO' },
  ],
  end: 10,
  view: { at: 'me', ahead: 14, yaw: 0.5, pitch: -0.42, dist: 26 },
  sky: { sun: -6 },
};

// -------------------------------------------------------------- 6 · in fog
/** 6 · Fog: under 50 m to see – at most 50 km/h, and the rear fog light. */
const FOG: LessonDef = {
  id: 'fogWall',
  stage: () => {
    const st = countryRoad();
    st.paths.lane = lanePath(1.625, 72, -72);
    return finish(st);
  },
  actors: [
    { id: 'me', kind: 'me', path: 'lane', keys: plan(0, 0, 16.5, { dt: 2.4, v: 13.8 }, { dt: 6.6, v: 13.2 }), beam: [[0, 1]] },
    { id: 'red', kind: 'car', colour: RED, name: 'theory.who.red', path: 'lane', keys: plan(0, 52, 12.5, { dt: 9, v: 12.5 }), beam: [[0, 1]] },
  ],
  steps: [
    { at: 1.4, answers: ['k50', 'k80', 'k100'], right: 'k50', ref: '§ 3 Abs. 1 StVO' },
    { at: 4.2, answers: ['fog', 'high', 'none'], right: 'fog', ref: '§ 17 Abs. 3 StVO' },
  ],
  end: 9,
  view: { at: 'me', ahead: 6, yaw: 0.5, pitch: -0.36, dist: 16 },
  sky: { fog: 45 },
};

// ----------------------------------------------------------- 7 · an accident
/** 7 · An accident ahead: securing the place, the warning triangle, first aid. */
const ACCIDENT: LessonDef = {
  id: 'accidentScene',
  stage: () => {
    const st = countryRoad();
    st.paths.lane = lanePath(1.625, 72, -72);
    st.paths.a = lanePath(1.4, 72, -72);
    // the second car, turned across the road by the crash
    st.paths.b = polyPath([-1.5, -57.6, 2.5, -61.6]);
    // you, out of the car on the side away from the traffic and on to the cars
    st.paths.you = polyPath([1.9, -32.3, 2.95, -32.6, 2.95, -43.4]);
    st.paths.hurt = polyPath([2.85, -53.6, 2.85, -54.1]);
    // the warning triangle: about 100 m back from the end of the queue
    st.props?.push({ kind: 'triangle', x: 2.7, z: 69.5, yaw: yawOf(0, 1), from: 9.9 });
    return finish(st);
  },
  actors: [
    { id: 'me', kind: 'me', path: 'lane', keys: plan(0, 0, 16, { dt: 3, v: 16 }, { to: 106, v: 0 }, { wait: 9 }), blink: [[4.4, 2]] },
    { id: 'a', kind: 'car', colour: BLUE, name: 'theory.who.blue', path: 'a', keys: stand(122), blink: [[0, 2]] },
    { id: 'b', kind: 'car', colour: SILVER, path: 'b', keys: stand(5) },
    { id: 'hurt', kind: 'person', look: 71, name: 'theory.who.walker', path: 'hurt', keys: stand(0.25) },
    { id: 'you', kind: 'person', look: 9, leaves: 'me', name: 'theory.who.me', path: 'you', keys: plan(11, 0, 0.8, { dt: 1, v: 1.5 }, { dt: 5.5, v: 1.6 }, { to: 11.6, v: 0 }, { wait: 1 }) },
  ],
  steps: [
    { at: 3.8, answers: ['hazard', 'help', 'drive'], right: 'hazard', ref: '§ 16 Abs. 2 StVO' },
    { at: 9.8, answers: ['m10', 'm50', 'm100'], right: 'm100', ref: '§ 15 Satz 2 StVO' },
    { at: 13.2, answers: ['all', 'involved', 'pros'], right: 'all', ref: '§ 323c StGB, § 34 Abs. 1 StVO' },
  ],
  end: 20,
  view: { at: [1, -38], yaw: 0.6, pitch: -0.6, dist: 34 },
};

// -------------------------------------------------- 8 · the lorry turns right
function truckStage(): Stage {
  const ns = { lanes: 1, laneW: 3.5, bike: 1.85, walk: 2.5, centre: 'dash' as const };
  const ew = { lanes: 1, laneW: 3.5, walk: 2.5, centre: 'dash' as const };
  const c = crossroads({
    ns,
    ew,
    r: 9,
    arms: {
      S: { len: 66, line: 'stop', light: { id: 'ns' } },
      N: { len: 32, line: 'stop', light: { id: 'ns' } },
      E: { len: 30, line: 'stop', light: { id: 'ew' } },
      W: { len: 28, line: 'stop', light: { id: 'ew' } },
    },
  });
  const st = c.stage;
  st.paths.me = c.move('S', 'N');
  st.paths.bike = c.move('S', 'N', 'bike');
  // the lorry's way round the corner: wider than a car's (radius 7 m)
  const R = 7;
  st.paths.truck = new Trace().to(1.75, 66).to(1.75, 1.75 + R).curve(1.75, 1.75 + R * 0.4477, 1.75 + R * 0.4477, 1.75, 1.75 + R, 1.75).to(30, 1.75).path();
  return st;
}
const TRUCK_LINE = truckStage().paths.bike.marks.line;

/** 8 · The lorry turns right: the cyclist beside it is in its blind spot. */
const TRUCK_BLIND: LessonDef = {
  id: 'truckBlindSpot',
  stage: truckStage,
  actors: [
    { id: 'truck', kind: 'truck', name: 'theory.who.truck', path: 'truck', keys: plan(0, TRUCK_LINE, 0, { wait: 10.8 }, { dt: 2, v: 1.8 }, { dt: 7, v: 1.8 }, { dt: 3, v: 6 }, { dt: 3, v: 6 }), blink: [[0, 1], [21, 0]] },
    { id: 'bike', kind: 'bike', colour: 0xd35a1f, name: 'theory.who.bike', path: 'bike', keys: plan(0, TRUCK_LINE - 20, 6, { to: TRUCK_LINE, v: 0 }, { wait: 0.8 }, { dt: 2.5, v: 5 }, { dt: 16, v: 5 }) },
    { id: 'me', kind: 'me', path: 'me', keys: plan(0, TRUCK_LINE - 36, 7, { to: TRUCK_LINE - 10.7, v: 0 }, { wait: 13.8 }, { dt: 3, v: 6 }, { dt: 2, v: 7 }) },
  ],
  lights: { ns: [[0, 'R'], [6, 'Y'], [7, 'G']], ew: [[0, 'G'], [3.5, 'A'], [4.6, 'R']] },
  steps: [
    { at: 5.2, answers: ['truck', 'bike'], right: 'bike', ref: '§ 9 Abs. 3 StVO', ask: 'theory.ask.first', blind: 'truck' },
    { at: 11.2, answers: ['walk', 'k20', 'k30'], right: 'walk', ref: '§ 9 Abs. 6 StVO' },
  ],
  end: 25,
  view: { at: [3, 6], yaw: 0.65, pitch: -0.72, dist: 30 },
};

// ------------------------------------------------------- 9 · two lanes, one ends
function lanesStage(): Stage {
  const taper = { z0: -20, z1: -34, to: 3.25 };
  const st = straight({
    z0: 72,
    z1: -72,
    bounds: [{ x: -5.75 }, { x: -3.25 }, { x: 6.5, taper }, { x: 9 }],
    strips: ['walk', 'asphalt', 'walk'],
    kerbs: [1, 2],
  });
  st.surfaces.push(...dashes(0, 72, 0, -72, 0.12, 3, 6), ...along({ x: 3.25 }, 72, -20, 0.12, [3, 6]));
  st.signs.push({ x: 7.3, z: 44, yaw: yawOf(0, 1), codes: ['121-10'] });
  st.paths.left = lanePath(1.625, 72, -72);
  st.paths.right = lanePath(4.875, 72, -72);
  return finish(st);
}

/** 9 · Two lanes your way: a car wants into yours too early, and where its lane ends you let it in. */
const MULTI_LANE: LessonDef = {
  id: 'multiLane',
  stage: lanesStage,
  actors: [
    { id: 'l1', kind: 'car', colour: SILVER, path: 'left', keys: plan(0, 62, 4.2, { dt: 16, v: 4.2 }) },
    { id: 'me', kind: 'me', path: 'left', keys: plan(0, 37, 4.2, { dt: 9.2, v: 4.2 }, { dt: 2.4, v: 3 }, { dt: 2.4, v: 4.2 }, { dt: 2, v: 4.2 }) },
    {
      id: 'blue',
      kind: 'car',
      colour: BLUE,
      name: 'theory.who.blue',
      path: 'right',
      keys: plan(0, 40.5, 4.6, { dt: 9.2, v: 4.6 }, { dt: 2, v: 4.2 }, { dt: 4.8, v: 4.2 }),
      side: [[9.6, 3.25, 2.6]],
      blink: [[0.2, -1], [3.4, 0], [8.4, -1], [12.4, 0]],
    },
    { id: 'l3', kind: 'car', colour: GREEN, path: 'left', keys: plan(0, 22, 4.2, { dt: 9.2, v: 4.2 }, { dt: 2.4, v: 3 }, { dt: 2.4, v: 4.2 }, { dt: 2, v: 4.2 }) },
  ],
  steps: [
    { at: 1.0, answers: ['keep', 'brake'], right: 'keep', ref: '§ 7 Abs. 5 StVO' },
    { at: 9.3, answers: ['me', 'blue'], right: 'blue', ref: '§ 7 Abs. 4 StVO', ask: 'theory.ask.first' },
  ],
  end: 16,
  view: { at: [3, 2], yaw: 0.5, pitch: -0.72, dist: 44 },
};

// --------------------------------------------------------------- 10 · tunnel
/** 10 · A tunnel: the headlights on, and what to do when the car breaks down in it. */
const TUNNEL: LessonDef = {
  id: 'tunnel',
  stage: () => {
    const st = countryRoad(3.75, 1.1);
    st.signs.push({ x: 4.3, z: 42, yaw: yawOf(0, 1), codes: ['327'] });
    st.props?.push({ kind: 'tunnel', x: -4.85, z: 22, x1: 4.85, z1: -72, h: 5.2 });
    st.paths.lane = lanePath(1.875, 72, -72);
    st.paths.other = lanePath(-1.875, -72, 72);
    // you, out by the door on the right onto the raised walkway, and along it to the emergency exit
    st.paths.you = polyPath([2.9, -13.6, 4.4, -14.0, 4.4, -60]);
    return finish(st);
  },
  actors: [
    { id: 'me', kind: 'me', path: 'lane', keys: plan(0, 0, 15, { dt: 2, v: 15 }, { dt: 5, v: 4 }, { to: 88, v: 0 }, { wait: 8 }), side: [[8.4, -0.8, 2.6]], blink: [[6.4, 2]], beam: [[0, 0], [2.0, 1]] },
    { id: 'white', kind: 'car', colour: WHITE, name: 'theory.who.white', path: 'other', keys: plan(0, 30, 13, { dt: 20, v: 13 }), beam: [[0, 1]] },
    { id: 'you', kind: 'person', look: 9, leaves: 'me', name: 'theory.who.me', path: 'you', keys: plan(13.4, 0, 0.8, { dt: 1, v: 1.5 }, { dt: 6, v: 1.5 }) },
  ],
  steps: [
    { at: 1.8, answers: ['low', 'none', 'fog'], right: 'low', ref: 'Anlage 3 StVO, Zeichen 327' },
    { at: 12.6, answers: ['out', 'stay', 'turn'], right: 'out', ref: '§ 15 StVO, Anlage 3 StVO, Zeichen 327' },
  ],
  end: 20.4,
  view: { at: 'me', ahead: 4, yaw: 0.65, pitch: -0.62, dist: 24 },
};

// --------------------------------------------------------- 11 · the old lady
/** 11 · An old lady with a rollator crosses the road slowly, away from any crossing. */
const SENIOR: LessonDef = {
  id: 'seniorCrossing',
  stage: () => {
    const st = townRoad(70, -60, 3.25, 2.5);
    st.paths.me = lanePath(1.625, 70, -60);
    st.paths.white = lanePath(-1.625, -60, 70);
    st.paths.senior = polyPath([5.0, 6, 4.6, 2.0, 3.0, 0.5, -3.0, 0.5, -4.6, -1.0, -4.8, -20]);
    return finish(st);
  },
  actors: [
    { id: 'me', kind: 'me', path: 'me', keys: plan(0, 0, 11, { dt: 1, v: 11 }, { to: 63, v: 0 }, { wait: 6.6 }, { dt: 3, v: 6 }, { dt: 2, v: 8 }) },
    { id: 'white', kind: 'car', colour: WHITE, name: 'theory.who.white', path: 'white', keys: plan(0, 0, 9, { to: 53.6, v: 0 }, { wait: 3.6 }, { dt: 3, v: 6 }, { dt: 2, v: 8 }) },
    { id: 'senior', kind: 'person', role: 'senior', look: 5, name: 'theory.who.senior', path: 'senior', keys: plan(0, 4.8, 0.55, { dt: 26, v: 0.55 }) },
  ],
  steps: [
    { at: 2.4, answers: ['brake', 'horn', 'around'], right: 'brake', ref: '§ 3 Abs. 2a StVO' },
    { at: 9.4, answers: ['after', 'now', 'horn'], right: 'after', ref: '§ 3 Abs. 2a StVO' },
  ],
  end: 21.5,
  view: { at: [0, 4], yaw: 0.55, pitch: -0.6, dist: 24 },
};

// ------------------------------------------------------------ 12 · wildlife
/** 12 · A deer at dusk where the forest meets the road – and the second one that follows. */
const WILDLIFE: LessonDef = {
  id: 'wildlife',
  stage: () => {
    const st = countryRoad();
    st.signs.push({ x: 4.15, z: 62, yaw: yawOf(0, 1), codes: ['142-10'] });
    forest(st, 7.5, 44, -72);
    st.paths.lane = lanePath(1.625, 72, -72);
    // out of the forest on the right, a moment at its edge, across the road and into the forest on the left
    st.paths.deer = polyPath([11, -12.6, 5.2, -10.6, -5, -9.4, -16, -8]);
    st.paths.deer2 = polyPath([13, -15.4, 5.4, -13.4, -5, -12.4, -16, -11]);
    st.paths.boar = polyPath([-5.6, -47, -4.8, -47.4]);
    return finish(st);
  },
  actors: [
    { id: 'me', kind: 'me', path: 'lane', keys: plan(0, 0, 15, { dt: 1.6, v: 15 }, { to: 73, v: 0 }, { wait: 1.4 }, { dt: 3, v: 6 }, { dt: 2, v: 8 }), beam: [[0, 2], [1.6, 1]] },
    { id: 'deer', kind: 'deer', name: 'theory.who.deer', path: 'deer', keys: plan(0, 5.6, 0, { wait: 3.3 }, { dt: 1.4, v: 8 }, { dt: 2.4, v: 8 }) },
    { id: 'deer2', kind: 'deer', name: 'theory.who.deer', path: 'deer2', keys: plan(0, 4.6, 0, { wait: 5.4 }, { dt: 1.4, v: 8 }, { dt: 2.4, v: 8 }) },
    { id: 'boar', kind: 'boar', name: 'theory.who.boar', path: 'boar', keys: stand(0.8) },
  ],
  steps: [
    { at: 1.5, answers: ['brake', 'swerve', 'flash'], right: 'brake', ref: 'Anlage 1 StVO, Zeichen 142' },
    { at: 5.6, answers: ['more', 'go'], right: 'more', ref: '§ 3 Abs. 1 StVO' },
  ],
  end: 15,
  view: { at: 'me', ahead: 18, yaw: 0.45, pitch: -0.45, dist: 30 },
  sky: { sun: -3 },
};

// -------------------------------------------------------- 13 · the police
function policeStage(): Stage {
  const road = { lanes: 1, laneW: 3.5, walk: 2.5, centre: 'dash' as const };
  const c = crossroads({
    ns: road,
    ew: road,
    r: 6,
    arms: {
      S: { len: 66, line: 'stop', light: { id: 'ns' } },
      N: { len: 32, line: 'stop', light: { id: 'ns' } },
      E: { len: 30, line: 'stop', light: { id: 'ew' } },
      W: { len: 30, line: 'stop', light: { id: 'ew' } },
    },
  });
  const st = c.stage;
  st.paths.me = c.move('S', 'N');
  st.paths.white = c.move('E', 'W');
  st.paths.blue = c.move('W', 'E');
  // the officer in the middle of the crossroads (a path of his own to stand on)
  st.paths.police = polyPath([0, 0.2, 0, -0.2]);
  return st;
}
const POLICE = policeStage().paths;

/** 13 · A police officer directs the traffic: his signs come before the lights. */
const POLICE_SIGNALS: LessonDef = {
  id: 'policeSignals',
  stage: policeStage,
  actors: [
    { id: 'me', kind: 'me', path: 'me', keys: plan(0, POLICE.me.marks.line - 30, 9, { to: POLICE.me.marks.line, v: 0 }, { wait: 6.4 }, { dt: 3, v: 6 }, { dt: 3, v: 7 }) },
    { id: 'white', kind: 'car', colour: WHITE, name: 'theory.who.white', path: 'white', keys: plan(0, 0, 8, { dt: 9, v: 8 }) },
    { id: 'blue', kind: 'car', colour: BLUE, name: 'theory.who.blue', path: 'blue', keys: plan(1.5, 0, 8, { dt: 7, v: 8 }) },
    {
      id: 'police',
      kind: 'person',
      role: 'police',
      look: 21,
      name: 'theory.who.police',
      path: 'police',
      keys: stand(0.2),
      // facing you, arms out; one arm up; side-on to you, arms out
      face: [[0, SOUTH, 0.01], [10.4, EAST, 1.0]],
      gesture: [[0, 'arms'], [8.2, 'raise'], [10.4, 'down'], [11.2, 'arms']],
    },
  ],
  // (the lights say the opposite of the officer: green for you, red across)
  lights: { ns: [[0, 'G']], ew: [[0, 'R']] },
  steps: [
    { at: 3.6, answers: ['stop', 'go'], right: 'stop', ref: '§ 36 Abs. 1, Abs. 2 StVO' },
    { at: 9.0, answers: ['wait', 'go', 'turn'], right: 'wait', ref: '§ 36 Abs. 2 Nr. 2 StVO' },
    { at: 12.0, answers: ['go', 'wait'], right: 'go', ref: '§ 36 Abs. 2 Nr. 1 StVO' },
  ],
  end: 18.5,
  view: { at: [0, 6], yaw: 0.5, pitch: -0.62, dist: 30 },
};

// ------------------------------------------------------------- 14 · flagman
/** 14 · Roadworks with one lane: a flagman with his stop/go sign. */
const FLAGMAN: LessonDef = {
  id: 'flagman',
  stage: () => {
    const st = countryRoad();
    st.signs.push({ x: 4.15, z: 58, yaw: yawOf(0, 1), codes: ['123'] }, { x: 4.15, z: 40, yaw: yawOf(0, 1), codes: ['274-50'] });
    const props = (st.props ??= []);
    // the barrier across your lane, the cones along the middle, a heap of earth
    props.push({ kind: 'barrier', x: 1.65, z: 1.5, yaw: yawOf(0, 1) });
    for (let z = 0; z >= -42; z -= 6) props.push({ kind: 'cone', x: 0.25, z });
    props.push({ kind: 'heap', x: 2.2, z: -30 }, { kind: 'barrier', x: 1.65, z: -43, yaw: yawOf(0, -1) });
    st.paths.lane = lanePath(1.625, 72, -72);
    st.paths.other = lanePath(-1.625, -72, 72);
    st.paths.flagman = polyPath([2.5, 3.4, 2.5, 3.8]);
    st.paths.worker = polyPath([1.9, -14, 1.9, -20]);
    return finish(st);
  },
  actors: [
    { id: 'me', kind: 'me', path: 'lane', keys: plan(0, 0, 13, { dt: 1.5, v: 13 }, { to: 62, v: 0 }, { wait: 3.5 }, { dt: 3, v: 8 }, { dt: 6, v: 8 }, { dt: 2, v: 10 }), side: [[11.6, 3.25, 2.3], [20.4, 0, 2.2]], blink: [[10.8, -1], [13.8, 0], [19.9, 1], [22, 0]] },
    { id: 'white', kind: 'car', colour: WHITE, name: 'theory.who.white', path: 'other', keys: plan(0, 10, 11, { dt: 12, v: 11 }) },
    { id: 'blue', kind: 'car', colour: BLUE, name: 'theory.who.blue', path: 'other', keys: plan(0, -14, 11, { dt: 12, v: 11 }) },
    { id: 'flagman', kind: 'person', role: 'flagman', look: 33, name: 'theory.who.flagman', path: 'flagman', keys: stand(0.2), face: [[0, SOUTH, 0.01]], gesture: [[0, 'stop'], [10.4, 'go']] },
    { id: 'worker', kind: 'person', role: 'worker', look: 48, name: 'theory.who.worker', path: 'worker', keys: plan(0, 0, 0.5, { dt: 4, v: 0.5 }, { dt: 2, v: 0 }, { wait: 30 }) },
  ],
  steps: [
    { at: 3.0, answers: ['stop', 'slow', 'horn'], right: 'stop', ref: '§ 45 Abs. 6, § 1 Abs. 2 StVO' },
    { at: 10.8, answers: ['slow', 'fast', 'wait'], right: 'slow', ref: '§ 1 Abs. 2, § 3 Abs. 1 StVO' },
  ],
  end: 22.5,
  view: { at: 'me', ahead: 10, yaw: 0.6, pitch: -0.58, dist: 28 },
};

/** The lessons of this file, in the order of the list (after the first thirteen). */
export const MORE_THEORY: readonly LessonDef[] = [PARKING, FOLLOW, NARROW, BUS_STOP, NIGHT, FOG, ACCIDENT, TRUCK_BLIND, MULTI_LANE, TUNNEL, SENIOR, WILDLIFE, POLICE_SIGNALS, FLAGMAN];

/** For the tests: the ids of the lessons of this file. */
export const MORE_THEORY_IDS: readonly string[] = MORE_THEORY.map((l) => l.id);
