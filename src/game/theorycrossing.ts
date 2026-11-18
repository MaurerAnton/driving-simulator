// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Two theory lessons (game/theory.ts) at a level crossing (Bahnübergang):
 * a road crossed by a railway line with the St Andrew's cross (Zeichen
 * 201), its yellow and red lights, the warning sign (Zeichen 151) before
 * it and a stop line; the regional tram of the line comes from the east.
 *
 *   - levelCrossing: the lights come on as you come to it – you stop at the
 *     line before the cross (§ 19 Abs. 2 StVO), and wait until they are
 *     out again, not only until the train has gone.
 *   - levelCrossingQueue: the traffic behind the tracks stands still – you
 *     wait before the cross until there is room for the whole car behind
 *     the tracks, and never stop on them (§ 19 Abs. 3 StVO).
 *
 * The same kind of script as the others: plain data, checked by
 * tests/game/theory.test.ts like every lesson.
 */
import type { LessonDef } from './theory.ts';
import { bar, dashes, finish, lanePath, polyPath, straight, yawOf } from './theorystage.ts';
import type { Stage } from './theorystage.ts';

const LANE_W = 3.25;
/** where a car coming from the south has its nose when it waits: half a metre before the cross, at the stop line */
const LINE = 65;

/**
 * A straight road north–south (one lane each way), the railway across it
 * at z = 0 on its paved bed, the cross, the lights and the stop line on
 * both sides, the warning sign 45 m before.
 */
function crossingStage(): Stage {
  const st = straight({ z0: 70, z1: -60, bounds: [{ x: -LANE_W }, { x: LANE_W }], strips: ['asphalt'] });
  // the middle line: broken – solid over the tracks and a little before them
  st.surfaces.push(...dashes(0, 70, 0, 14, 0.12, 3, 6), bar(0, 14, 0, -14, 0.12), ...dashes(0, -14, 0, -60, 0.12, 3, 6));
  // the bed of the track beside the road, and the rails across all of it
  st.surfaces.push(bar(-32, 0, -LANE_W, 0, 3.2, 'apron'), bar(LANE_W, 0, 32, 0, 3.2, 'apron'));
  for (const z of [-0.72, 0.72]) st.surfaces.push(bar(-32, z, 32, z, 0.07, 'steel'));
  // the stop lines (Zeichen 294) before the crosses
  st.surfaces.push(bar(0.1, 4.75, LANE_W - 0.1, 4.75, 0.3), bar(-LANE_W + 0.1, -4.75, -0.1, -4.75, 0.3));
  // the St Andrew's cross and the lights beneath it on each side; the warning sign before them
  st.signs.push({ x: 4.4, z: 4.5, yaw: yawOf(0, 1), codes: ['201-50'] }, { x: -4.4, z: -4.5, yaw: yawOf(0, -1), codes: ['201-50'] });
  st.signs.push({ x: 4.4, z: 50, yaw: yawOf(0, 1), codes: ['151'] }, { x: -4.4, z: -50, yaw: yawOf(0, -1), codes: ['151'] });
  st.lights.push({ id: 'lx', x: 4.1, z: 3.7, yaw: yawOf(0, 1) }, { id: 'lx', x: -4.1, z: -3.7, yaw: yawOf(0, -1) });
  // your lane north (its nose waits at the line), and the track westwards
  st.paths.me = lanePath(LANE_W / 2, 70, -60, { line: LINE });
  st.paths.track = polyPath([150, 0, -150, 0]);
  return finish(st);
}

const BLUE = 0x2f5f8a;
const RED = 0xa8231b;

/** At the level crossing the lights come on: you stop before the cross, and wait until they are out. */
export const LEVEL_CROSSING: LessonDef = {
  id: 'levelCrossing',
  stage: crossingStage,
  actors: [
    { id: 'me', kind: 'me', path: 'me', keys: [[0, 'line-50', 12], [2.6, 'line-22', 9.6], [7.4, 'line', 0], [14.2, 'line', 0], [18.2, 'line+18', 9], [19, 'line+25.2', 9]] },
    // (its nose is at the road at 7 s; its last car has left it before 11 s)
    { id: 'train', kind: 'tram', name: 'theory.who.train', path: 'track', keys: [[3, 106, 10], [19, 266, 10]] },
  ],
  lights: { lx: [[0, 'O'], [2, 'A'], [5, 'R'], [13.6, 'O']] },
  steps: [
    { at: 2.6, answers: ['stop', 'go', 'slow'], right: 'stop', ref: '§ 19 Abs. 2 Nr. 2 StVO' },
    { at: 11.5, answers: ['wait', 'go'], right: 'wait', ref: '§ 19 Abs. 2 Nr. 2 StVO' },
  ],
  end: 19,
  view: { at: [0, 8], yaw: 0.55, pitch: -0.6, dist: 38 },
};

/** The traffic behind the tracks stands still: you wait before the cross, never on the rails. */
export const LEVEL_CROSSING_QUEUE: LessonDef = {
  id: 'levelCrossingQueue',
  stage: crossingStage,
  actors: [
    { id: 'me', kind: 'me', path: 'me', keys: [[0, 'line-55', 12], [3, 'line-22', 9.6], [7.6, 'line', 0], [23, 'line', 0], [27, 'line+18', 9], [28, 'line+27', 9]] },
    // the queue beyond the tracks: the red car stands; the blue one crossed just before you and stops behind it
    { id: 'red', kind: 'car', colour: RED, name: 'theory.who.red', path: 'me', keys: [[0, 'line+19', 0], [19, 'line+19', 0], [24, 'line+44', 10], [28, 'line+84', 10]] },
    { id: 'blue', kind: 'car', colour: BLUE, name: 'theory.who.blue', path: 'me', keys: [[0, 'line-25', 8], [3, 'line-2', 6], [7.5, 'line+13.2', 0], [19.8, 'line+13.2', 0], [24.8, 'line+38.2', 10], [28, 'line+70.2', 10]] },
    // (its nose is at the road at 13.5 s; its last car has left it before 17.5 s)
    { id: 'train', kind: 'tram', name: 'theory.who.train', path: 'track', keys: [[9, 101, 10], [28, 291, 10]] },
  ],
  lights: { lx: [[0, 'O'], [7, 'A'], [10, 'R'], [21, 'O']] },
  steps: [
    { at: 3, answers: ['wait', 'close', 'tracks'], right: 'wait', ref: '§ 19 Abs. 3 StVO' },
    { at: 21.6, answers: ['room', 'now'], right: 'room', ref: '§ 19 Abs. 3 StVO' },
  ],
  end: 28,
  view: { at: [0, 4], yaw: 0.55, pitch: -0.62, dist: 36 },
};
