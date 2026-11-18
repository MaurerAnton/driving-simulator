// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The later theory lessons (game/theoryscenes.ts): the rule each scene is
 * about, played out as it should be – nobody stops under Zeichen 283, the
 * distance is half the speedometer, 2 m beside the cyclist, the bus is let
 * out, the full beam dipped for the oncoming car, at most 50 km/h in the
 * fog, the warning triangle 100 m back, the lorry turns at walking pace
 * after the cyclist, the zip at the end of the lane, the lights on in the
 * tunnel, the old lady across before anybody moves, the car standing while
 * the deer cross, the police officer's signs and the flagman's obeyed –,
 * the people's arms, signs and headlights, and how a run of these lessons
 * stops at each question.  (The checks every lesson must pass – nobody
 * touches anybody, … – are those of tests/game/theory.test.ts.)
 *
 *   node --test tests/game/theoryscenes.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import en from '../../src/i18n/en.ts';
import { THEORY, TheoryRun, allTheoryKeys, blinkAt, markAt, newPose, poseAt, prepare } from '../../src/game/theory.ts';
import type { ActorDef, ActorRun, Pose, Scene } from '../../src/game/theory.ts';
import { MORE_THEORY, MORE_THEORY_IDS, armsAt, beamAt, faceAt, gestureAt, paddleAt, plan } from '../../src/game/theoryscenes.ts';
import { citationParts } from '../../src/i18n/violations.ts';

const DT = 0.05;
const scenes = new Map<string, Scene>(MORE_THEORY.map((l) => [l.id, prepare(l)]));
const sceneOf = (id: string): Scene => scenes.get(id) as Scene;
const actor = (s: Scene, id: string): ActorRun => s.actors.find((a) => a.def.id === id) as ActorRun;
const pose = (r: ActorRun, t: number): Pose => poseAt(r, t, newPose());
function times(s: Scene): number[] {
  const out: number[] = [];
  for (let t = 0; t <= s.lesson.end + 1e-9; t += DT) out.push(t);
  return out;
}

test('fourteen more lessons, after the first thirteen, each with all its texts', () => {
  assert.equal(MORE_THEORY.length, 14);
  for (const id of MORE_THEORY_IDS) assert.ok(THEORY.some((l) => l.id === id), `${id} is in the list`);
  assert.equal(THEORY.indexOf(MORE_THEORY[0]), 13, 'after the first thirteen');
  for (const key of allTheoryKeys()) assert.ok(en[key], `missing text ${key}`);
  for (const l of MORE_THEORY) {
    for (const s of l.steps) {
      // every paragraph named links to its law (the StVO – or the criminal code for first aid)
      for (const p of citationParts(s.ref)) if (p.url) assert.match(p.url, /gesetze-im-internet\.de\/(stvo_2013|stgb)\//, `${l.id}: ${s.ref}`);
    }
  }
  const first = citationParts('§ 34 Abs. 1 StVO, § 323c StGB').filter((p) => p.url);
  assert.equal(first[1].url, 'https://www.gesetze-im-internet.de/stgb/__323c.html');
});

test('a plan: even legs, each key where the speeds before it bring it', () => {
  const k = plan(0, 10, 10, { dt: 2, v: 6 }, { to: 30, v: 0 }, { wait: 1.5 });
  assert.deepEqual(k[1], [2, 26, 6]);
  assert.equal(k[2][1], 30);
  assert.ok(Math.abs(k[2][0] - (2 + (2 * 4) / 6)) < 1e-9);
  assert.equal(k[3][0], k[2][0] + 1.5);
  assert.equal(k[3][1], 30);
});

test('a person turns, signs and holds: the officer\'s arms, the flagman\'s sign, the rollator', () => {
  const s = sceneOf('policeSignals');
  const p = actor(s, 'police').def;
  assert.ok(Math.abs(faceAt(p, 1, 0) - Math.PI) < 1e-6, 'facing you');
  assert.ok(Math.abs(faceAt(p, 12, 0) + Math.PI / 2) < 1e-6, 'side-on to you, facing east');
  assert.equal(gestureAt(p, 3)?.sign, 'arms');
  assert.equal(gestureAt(p, 9)?.sign, 'raise');
  const out = armsAt(p, 3) as number[];
  assert.ok(out[1] > 1.4 && out[3] > 1.4, 'both arms out');
  const up = armsAt(p, 9.5) as number[];
  assert.ok(up[0] > 2.8, 'one arm raised');
  // (moving from one sign to the next takes a moment)
  const mid = armsAt(p, 8.5) as number[];
  assert.ok(mid[0] > 0.2 && mid[0] < 2.8);
  const f = actor(sceneOf('flagman'), 'flagman').def;
  assert.equal(paddleAt(f, 2), 0, 'the red side');
  assert.equal(paddleAt(f, 12), 1, 'the green side');
  const senior = actor(sceneOf('seniorCrossing'), 'senior').def;
  assert.ok((armsAt(senior, 3) as number[])[0] > 0.4, 'hands on the rollator');
  const nobody: ActorDef = { id: 'x', kind: 'person', path: 'p', keys: [[0, 0, 0]] };
  assert.equal(armsAt(nobody, 1), null);
  assert.equal(faceAt(nobody, 1, 0.3), 0.3);
  assert.equal(beamAt(nobody, 1), 0);
});

test('stopping and parking: never under Zeichen 283, the passenger out under 286, parked 5 m and more beyond the crossroads', () => {
  const s = sceneOf('parkingSigns');
  const me = actor(s, 'me');
  // (the signs stand on the south arm: 283 at z = 56, 286 at z = 34; the cross road's edge at z = −3.25)
  let stood283 = 0;
  for (const t of times(s)) {
    const p = pose(me, t);
    const nose = p.z - Math.cos(p.yaw) * 2.195;
    if (p.v < 0.05 && nose < 56 && nose > 34) stood283 += DT;
  }
  assert.equal(stood283, 0, 'stopped in the zone of Zeichen 283');
  const out = actor(s, 'walker');
  const t0 = out.keys[0].t;
  const m = pose(me, t0);
  assert.ok(m.v < 0.05 && m.z < 34 && m.z > 8, 'standing under 286 while the passenger gets out');
  const end = pose(me, s.lesson.end);
  assert.ok(end.v < 0.05, 'parked at the end');
  const tail = end.z + 2.085;
  assert.ok(tail < -3.25 - 5, `the tail ${(-3.25 - tail).toFixed(1)} m from the crossroads`);
});

test('the distance: half the speedometer, a second to react, stopped behind the red car', () => {
  const s = sceneOf('followingDistance');
  const me = actor(s, 'me');
  const red = actor(s, 'red');
  const tRed = red.keys[1].t;
  const tMe = me.keys[1].t;
  assert.ok(Math.abs(tMe - tRed - 1) < 1e-9, 'you brake a second after it');
  for (const t of times(s)) {
    const a = pose(me, t);
    const b = pose(red, t);
    const gap = b.s - 4.28 - a.s;
    if (t < tRed) assert.ok(gap >= (a.v * 3.6) / 2 - 0.5, `at ${t.toFixed(2)} only ${gap.toFixed(1)} m at ${(a.v * 3.6).toFixed(0)} km/h`);
    assert.ok(gap > 5, `at ${t.toFixed(2)} ${gap.toFixed(1)} m`);
  }
  // reaction 1 s at 60 km/h ≈ 17 m, braking to a stop at about 3.5 m/s²
  assert.ok(Math.abs(me.keys[2].s - me.keys[1].s - 39.7) < 0.5);
});

test('the cyclist and the lorry: 2 m beside the cyclist; the oncoming car first past the lorry', () => {
  const s = sceneOf('narrowPass');
  const me = actor(s, 'me');
  const bike = actor(s, 'bike');
  const white = actor(s, 'white');
  const truck = actor(s, 'truck');
  let beside = 0;
  for (const t of times(s)) {
    const m = pose(me, t);
    const b = pose(bike, t);
    if (m.s > b.s - 1.75 && m.s - 4.28 < b.s) {
      beside++;
      const gap = Math.abs(m.x - b.x) - 1.79 / 2 - 0.62 / 2;
      assert.ok(gap >= 2, `at ${t.toFixed(2)} only ${gap.toFixed(2)} m beside the cyclist`);
    }
    // in the oncoming lane (your left side over the middle) only once the oncoming car is past you – or far away
    const w = pose(white, t);
    if (m.x - 0.895 < -0.05) assert.ok(w.z - 4.28 > m.z || m.z - w.z > 80, `at ${t.toFixed(2)} you are in the oncoming lane with the car ${(m.z - w.z).toFixed(0)} m ahead`);
  }
  assert.ok(beside > 0);
  assert.equal(blinkAt(truck.def, 1), 2, 'the lorry has its hazard lights on');
  assert.ok(pose(me, s.lesson.steps[1].at + 2).v < 0.05, 'you wait behind the lorry');
});

test('the bus at its stop: passed at walking pace at most, let out when it indicates', () => {
  const s = sceneOf('busStopPullOut');
  const me = actor(s, 'me');
  const bus = actor(s, 'bus');
  for (const t of times(s)) {
    const m = pose(me, t);
    const b = pose(bus, t);
    assert.ok(m.s < b.s - 12 - 4, `at ${t.toFixed(2)} you come too close to the bus`);
    if (b.v < 0.05 && m.s > b.s - 12 - 15) assert.ok(m.v <= 7 / 3.6 + 0.05, `at ${t.toFixed(2)} ${(m.v * 3.6).toFixed(1)} km/h near the bus`);
  }
  assert.equal(blinkAt(bus.def, 2), 2);
  const go = bus.keys[1].t;
  assert.equal(blinkAt(bus.def, go), -1, 'it indicates before it pulls out');
});

test('at night: dipped while the oncoming car comes; in the fog: at most 50 km/h after the question, dipped lights', () => {
  const night = sceneOf('nightDrive');
  const me = actor(night, 'me');
  const white = actor(night, 'white');
  assert.ok((night.lesson.sky?.sun ?? 99) < 0, 'dark');
  for (const t of times(night)) {
    const m = pose(me, t);
    const w = pose(white, t);
    const ahead = m.z - w.z;
    if (w.visible && t > night.lesson.steps[0].at + 0.2 && ahead > 0 && ahead < 150) assert.equal(beamAt(me.def, t), 1, `at ${t.toFixed(2)} full beam with the car ${ahead.toFixed(0)} m ahead`);
  }
  assert.equal(beamAt(me.def, 0), 2);
  const fog = sceneOf('fogWall');
  assert.ok((fog.lesson.sky?.fog ?? 99) < 50, 'less than 50 m to see');
  const fm = actor(fog, 'me');
  for (const t of times(fog)) if (t >= fog.lesson.steps[0].at + 1) assert.ok(pose(fm, t).v <= 50 / 3.6 + 1e-6, `at ${t.toFixed(2)} faster than 50`);
  assert.equal(beamAt(fm.def, 1), 1);
});

test('the accident: hazard lights before you stop, the triangle some 100 m back', () => {
  const s = sceneOf('accidentScene');
  const me = actor(s, 'me');
  const stop = me.keys[2].t;
  assert.equal(blinkAt(me.def, stop - 1), 2);
  const tail = pose(me, stop).z + 2.085;
  const tri = s.stage.props?.find((p) => p.kind === 'triangle');
  assert.ok(tri && tri.z - tail > 95, `the triangle ${(tri ? tri.z - tail : 0).toFixed(0)} m back`);
  assert.ok(tri && (tri.from ?? 0) <= s.lesson.steps[1].at + 0.2, 'put up once the question is answered');
});

test('the lorry: it waits for the cyclist and turns at walking pace; you wait behind', () => {
  const s = sceneOf('truckBlindSpot');
  const truck = actor(s, 'truck');
  const bike = actor(s, 'bike');
  const turnIn = 66 - 8.75;
  for (const t of times(s)) {
    const p = pose(truck, t);
    const b = pose(bike, t);
    // (while its nose goes round the corner: no faster than walking)
    if (p.s > turnIn + 2 && p.s < turnIn + 11) assert.ok(p.v <= 7 / 3.6 + 1e-6, `at ${t.toFixed(2)} turning at ${(p.v * 3.6).toFixed(1)} km/h`);
    if (p.v > 0.05) assert.ok(b.z < -2, `at ${t.toFixed(2)} the lorry moves before the cyclist is through`);
  }
  assert.equal(s.lesson.steps[0].blind, 'truck');
  assert.equal(blinkAt(truck.def, 1), 1, 'indicating right');
});

test('two lanes into one: the blue car merges only where its lane ends, in front of you', () => {
  const s = sceneOf('multiLane');
  const me = actor(s, 'me');
  const blue = actor(s, 'blue');
  const [t0] = blue.def.side?.[0] ?? [0];
  assert.ok(pose(blue, t0).z < -10, 'not before the end of its lane');
  for (const t of times(s)) {
    const b = pose(blue, t);
    const m = pose(me, t);
    if (b.x < 3.25) assert.ok(b.s - 4.28 > m.s + 1, `at ${t.toFixed(2)} it cuts in too close`);
  }
});

test('the tunnel: the lights on before it, hazard lights when you break down, out on the walkway', () => {
  const s = sceneOf('tunnel');
  const me = actor(s, 'me');
  const tunnel = s.stage.props?.find((p) => p.kind === 'tunnel');
  assert.ok(tunnel);
  for (const t of times(s)) {
    const p = pose(me, t);
    if (p.z - 2.195 < (tunnel?.z ?? 0) + 5) assert.ok(beamAt(me.def, t) >= 1, `at ${t.toFixed(2)} in the tunnel without lights`);
  }
  const stop = me.keys[3].t;
  assert.equal(blinkAt(me.def, stop), 2);
  assert.ok(pose(actor(s, 'you'), stop + 3).x > 3.75, 'on the walkway');
});

test('the old lady: both cars keep well away from her way and stand until she is on the pavement', () => {
  const s = sceneOf('seniorCrossing');
  const senior = actor(s, 'senior');
  const stood = { me: false, white: false };
  for (const t of times(s)) {
    const p = pose(senior, t);
    const onRoad = Math.abs(p.x) < 3.3 && p.visible;
    for (const id of ['me', 'white'] as const) {
      const c = pose(actor(s, id), t);
      const nose = id === 'me' ? c.z - 2.195 : c.z + 2.195;
      if (!onRoad) continue;
      // (a car ahead of her way: its nose 6 m and more from it; once it stands it stays)
      assert.ok(Math.abs(nose - 0.5) >= 6, `at ${t.toFixed(2)} ${id} ${Math.abs(nose - 0.5).toFixed(1)} m from her way`);
      if (c.v < 0.05) stood[id] = true;
      else assert.ok(!stood[id], `at ${t.toFixed(2)} ${id} drives on while she is on the road`);
    }
  }
  assert.ok(stood.me && stood.white, 'both stop for her');
  assert.ok(pose(senior, 5).v < 0.6, 'slowly');
});

test('the deer: you stand before their way while they cross, the second one too', () => {
  const s = sceneOf('wildlife');
  const me = actor(s, 'me');
  assert.ok((s.lesson.sky?.sun ?? 99) < 0, 'dusk');
  for (const id of ['deer', 'deer2']) {
    const d = actor(s, id);
    for (const t of times(s)) {
      const p = pose(d, t);
      if (!p.visible || Math.abs(p.x) > 3.5) continue;
      const m = pose(me, t);
      assert.ok(m.z - 2.195 - p.z > 6, `at ${t.toFixed(2)} ${id} on the road just ${(m.z - 2.195 - p.z).toFixed(1)} m ahead`);
    }
  }
  assert.ok(s.stage.signs.some((g) => g.codes.includes('142-10')), 'the sign warns of deer');
});

test('the police officer and the flagman: you stand while their signs say stop', () => {
  const s = sceneOf('policeSignals');
  const me = actor(s, 'me');
  const police = actor(s, 'police').def;
  const line = markAt(me.path, 'line');
  for (const t of times(s)) {
    const p = pose(me, t);
    const g = gestureAt(police, t);
    const sideOn = Math.abs(Math.abs(faceAt(police, t, 0)) - Math.PI / 2) < 0.05;
    if (!(sideOn && g?.sign === 'arms')) assert.ok(p.s <= line + 0.05, `at ${t.toFixed(2)} over the line without his sign`);
  }
  const f = sceneOf('flagman');
  const fm = actor(f, 'me');
  const flag = actor(f, 'flagman').def;
  for (const t of times(f)) {
    const p = pose(fm, t);
    if (paddleAt(flag, t) < 1) assert.ok(p.z - 2.195 > 3.4 + 4 - 0.05 || p.v < 0.05 || p.z > 20, `at ${t.toFixed(2)} you drive on at the red side`);
    if (p.z - 2.195 < 3.4) assert.equal(paddleAt(flag, t), 1, `at ${t.toFixed(2)} past him without green`);
  }
});

test('a run of these lessons stops at each question and ends', () => {
  for (const l of MORE_THEORY) {
    const run = new TheoryRun(sceneOf(l.id));
    let asked = 0;
    for (let i = 0; i < 5000 && run.phase !== 'end'; i++) {
      if (run.advance(0.1) && run.phase === 'ask') {
        assert.equal(run.t, l.steps[asked].at, `${l.id}: stopped at question ${asked + 1}`);
        assert.equal(run.answer(run.current?.right ?? ''), true);
        run.goOn();
        asked++;
      }
    }
    assert.equal(asked, l.steps.length, l.id);
    assert.equal(run.right, l.steps.length);
    assert.equal(run.t, l.end);
  }
});
