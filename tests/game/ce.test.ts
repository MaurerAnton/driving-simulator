// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Class CE on the practice yard: the layouts of the two basic manoeuvres,
 * their judging, and the order of coupling and uncoupling.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { COUPLING_STEPS, CouplingProcedure, MAX_CORRECTIONS, ManoeuvreJudge, TRAILER_OUTLINE, TRUCK_OUTLINE, YardFrame, corners, offArea, taskLayout, trailerBehind } from '../../src/game/ce.ts';
import type { CouplingState, CouplingStepId, Pose, RigState } from '../../src/game/ce.ts';
import { LESSONS } from '../../src/game/nav.ts';
import de from '../../src/i18n/de.ts';
import en from '../../src/i18n/en.ts';
import { VIOLATION_REFS, citationParts } from '../../src/i18n/violations.ts';

const EAST = -Math.PI / 2;
const SOUTH = Math.PI;
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

test('the yard\'s frame: there and back, for a yard along and one across', () => {
  for (const rot of [0, 1]) {
    const f = new YardFrame({ x: 305, z: 1485, len: 150, wid: 66, rot });
    const [x, z] = f.toWorld(40, -10);
    const [u, w] = f.toLocal(x, z);
    assert.ok(near(u, 40, 1e-9) && near(w, -10, 1e-9), `rot ${rot}: ${u}, ${w}`);
    assert.ok(near(Math.hypot(x - 305, z - 1485), Math.hypot(40, 10), 1e-9), 'distances keep');
    // a vehicle heading along +u moves along +u
    const p = f.poseToWorld({ x: 0, z: 0, yaw: EAST });
    const ahead = f.toLocal(p.x - Math.sin(p.yaw) * 5, p.z - Math.cos(p.yaw) * 5);
    assert.ok(near(ahead[0], 5, 1e-9) && near(ahead[1], 0, 1e-9), `rot ${rot}: heading east of the yard leads along u`);
    assert.ok(near(f.yawToLocal(p.yaw), EAST, 1e-9));
  }
  const along = new YardFrame({ x: 0, z: 0, len: 150, wid: 66, rot: 0 });
  assert.deepEqual(along.toWorld(10, 0), [10, 0], 'a yard along east–west: u is east');
  const across = new YardFrame({ x: 0, z: 0, len: 150, wid: 66, rot: 1 });
  const north = across.toWorld(10, 0);
  assert.ok(near(north[0], 0, 1e-9) && near(north[1], -10, 1e-9), 'a yard along north–south: u is north');
});

test('the layouts fit the yard, and the combination starts on the paved area', () => {
  for (const id of ['corner', 'ramp', 'couple'] as const) {
    const lay = taskLayout(id);
    for (const r of [...lay.allowed, lay.goal, ...(lay.ramp ? [lay.ramp] : [])]) {
      assert.ok(r.u0 < r.u1 && r.w0 < r.w1 && r.u0 >= -75 && r.u1 <= 75 && r.w0 >= -33 && r.w1 <= 33, `${id}: within 150 m × 66 m`);
    }
    const trailer = trailerBehind(lay.start);
    const pts = [...corners(lay.start, TRUCK_OUTLINE.front, TRUCK_OUTLINE.rear, TRUCK_OUTLINE.hw), ...corners(trailer, TRAILER_OUTLINE.front, TRAILER_OUTLINE.rear, TRAILER_OUTLINE.hw)];
    for (let i = 0; i < pts.length; i += 2) {
      assert.ok(lay.allowed.some((r) => pts[i] >= r.u0 && pts[i] <= r.u1 && pts[i + 1] >= r.w0 && pts[i + 1] <= r.w1), `${id}: corner ${i / 2} of the standing combination is on the area`);
    }
    // 15.7 m from the front of the truck to the rear end of the trailer
    const len = TRUCK_OUTLINE.front + TRUCK_OUTLINE.hitch + TRAILER_OUTLINE.hitch + TRAILER_OUTLINE.rear;
    assert.ok(near(len, 15.7, 0.01), `length of the combination: ${len}`);
    assert.ok(near(Math.max(...pts.filter((_, i) => i % 2 === 0)) - Math.min(...pts.filter((_, i) => i % 2 === 0)), len, 0.01), 'standing in line');
  }
});

/** the combination standing straight at a pose */
const straight = (truck: Pose, speed = 0, handbrake = true): RigState => ({ truck, trailer: trailerBehind(truck), speed, handbrake });

test('round the corner: done when the whole combination stands in the side road, straight and secured', () => {
  const j = new ManoeuvreJudge('corner');
  const lay = j.layout;
  // at the start: on the main road, nothing achieved
  for (let i = 0; i < 100; i++) j.update(straight(lay.start), 0.02);
  assert.equal(j.status.state, 'run');
  assert.equal(j.status.excursions, 0);
  // standing in the side road, front towards the main road
  const inSide: Pose = { x: -20.5, z: -8, yaw: SOUTH };
  assert.equal(j.arrived(straight(inSide)), true);
  assert.equal(j.arrived(straight({ ...inSide, z: 2 })), false, 'the front still on the main road');
  assert.equal(j.arrived(straight({ ...inSide, yaw: SOUTH + 0.25 })), false, 'askew');
  assert.equal(j.arrived(straight({ ...inSide, x: -17.8 })), false, 'half a metre over the edge of the side road');
  // rolling it is not done, without the handbrake neither
  for (let i = 0; i < 100; i++) j.update(straight(inSide, -0.5, false), 0.02);
  assert.equal(j.status.state, 'run');
  for (let i = 0; i < 100; i++) j.update(straight(inSide, 0, false), 0.02);
  assert.equal(j.status.state, 'run');
  for (let i = 0; i < 100; i++) j.update(straight(inSide, 0, true), 0.02);
  assert.equal(j.status.state, 'done');
});

test('leaving the paved area is a fault each time, three times ends the task', () => {
  const j = new ManoeuvreJudge('corner');
  const on = straight(j.layout.start);
  const off = straight({ ...j.layout.start, z: j.layout.start.z + 3 }); // 0.75 m over the southern edge
  let faults = 0;
  for (const rig of [on, off, off, on, off, on]) {
    const st = j.update(rig, 0.02);
    faults += st.faults.filter((f) => f === 'ceLine').length;
  }
  assert.equal(faults, 2, 'one fault for each time the line is crossed, not one per moment');
  assert.equal(j.status.state, 'run');
  j.update(off, 0.02);
  j.update(on, 0.02);
  j.update(off, 0.02);
  assert.equal(j.status.state, 'failed');
  const far = new ManoeuvreJudge('corner');
  far.update(straight({ ...far.layout.start, z: far.layout.start.z + 8 }), 0.02);
  assert.equal(far.status.state, 'failed', 'far off the area: over at once');
});

test('corrections: pulling forward twice is allowed, a third time is not', () => {
  const j = new ManoeuvreJudge('ramp');
  const rig = straight(j.layout.start);
  const go = (speed: number, seconds: number): void => {
    for (let i = 0; i < seconds * 50; i++) j.update({ ...rig, speed, handbrake: false }, 0.02);
  };
  go(1, 3); // driving forward before ever reversing is no correction
  assert.equal(j.status.corrections, 0);
  for (let k = 1; k <= MAX_CORRECTIONS; k++) {
    go(-1, 3);
    go(1, 2);
    assert.equal(j.status.corrections, k);
    assert.equal(j.status.state, 'run');
  }
  go(-1, 3);
  go(0.2, 1); // rolling forward a hand's width is none
  assert.equal(j.status.corrections, MAX_CORRECTIONS);
  go(1, 2);
  assert.equal(j.status.state, 'failed');
});

test('the ramp: close to it, in the bay, square – and never touching it', () => {
  const j = new ManoeuvreJudge('ramp');
  const lay = j.layout;
  const ramp = lay.ramp!;
  // truck origin so that the trailer's rear end is `gap` in front of the ramp, in the bay
  const at = (gap: number, w = -12, yaw = EAST): RigState => {
    const reach = TRUCK_OUTLINE.hitch + TRAILER_OUTLINE.hitch + TRAILER_OUTLINE.rear;
    return straight({ x: ramp.u1 + gap + reach * Math.cos(yaw - EAST), z: w, yaw });
  };
  assert.equal(j.arrived(at(0.5)), true);
  assert.equal(j.arrived(at(1.6)), false, 'too far from the ramp');
  assert.equal(j.arrived(at(0.5, -13.2)), false, 'beside the bay');
  assert.equal(j.arrived(at(0.5, -12, EAST + 0.12)), false, 'askew');
  for (let i = 0; i < 60; i++) j.update(at(0.5), 0.02);
  assert.equal(j.status.state, 'done');
  assert.ok(near(j.status.gap, 0.5, 0.01), `gap ${j.status.gap}`);
  const hit = new ManoeuvreJudge('ramp');
  const st = hit.update(at(-0.05), 0.02);
  assert.equal(st.state, 'failed');
  assert.deepEqual(st.faults, ['ceRamp']);
});

/** a driver who knows the order */
const ORDER: CouplingStepId[] = ['uBrake', 'uChocks', 'uLeg', 'uRed', 'uYellow', 'uCable', 'uOpen', 'cCheck', 'cHeight', 'cLocked', 'cYellow', 'cRed', 'cCable', 'cLeg', 'cChocks', 'cBrake', 'cLights'];

test('coupling and uncoupling in the right order, from parking the combination to the brake test', () => {
  const p = new CouplingProcedure();
  const s: CouplingState = { speed: 0, handbrake: false, coupled: true, dist: 0, angle: 0 };
  const tick = (n = 5): ReturnType<CouplingProcedure['update']> => {
    let st = p.update(s, 0.02);
    for (let i = 1; i < n; i++) st = p.update(s, 0.02);
    return st;
  };
  const act = (...ids: CouplingStepId[]): void => {
    for (const id of ids) {
      assert.ok(p.choices().includes(id), `${id} is offered (offered: ${p.choices().join(' ')})`);
      assert.equal(p.act(id, s), null, `${id} in its turn`);
    }
  };
  assert.equal(tick().todo, 'uPark');
  assert.deepEqual(p.choices(), [], 'nothing to do on foot before the combination is parked');
  s.handbrake = true;
  assert.equal(tick().todo, null, 'parked: now on foot');
  assert.deepEqual(p.choices(), ['uBrake', 'uChocks', 'uLeg', 'uRed', 'uYellow', 'uCable', 'uOpen']);
  act('uChocks', 'uBrake', 'uLeg', 'uCable', 'uRed', 'uYellow', 'uOpen');
  let st = tick();
  assert.equal(st.todo, 'uPull');
  assert.equal(st.uncouple, true, 'the open coupling lets the trailer go');
  s.coupled = false;
  s.handbrake = false;
  s.speed = 1;
  s.dist = 3;
  assert.equal(tick().uncouple, false);
  assert.deepEqual(p.choices(), ['cCheck'], 'only what can be done before backing up is offered');
  s.speed = 0;
  s.handbrake = true;
  s.dist = 9;
  act('cCheck');
  assert.equal(tick().todo, 'cApproach');
  s.dist = 0.9;
  assert.equal(tick().todo, null, 'stopped a metre before the eye: out to compare the heights');
  act('cHeight');
  assert.equal(tick().todo, 'cLatch');
  s.handbrake = false;
  s.speed = -0.4;
  s.dist = 0.15;
  st = tick(1);
  assert.equal(st.couple, true);
  assert.deepEqual(st.faults, []);
  s.coupled = true;
  s.speed = 0;
  s.handbrake = true;
  s.dist = 0;
  tick();
  act('cLocked', 'cYellow', 'cRed', 'cCable', 'cLeg', 'cChocks', 'cBrake', 'cLights');
  assert.equal(tick().todo, 'cTest');
  s.handbrake = false;
  s.speed = 3;
  tick(120);
  assert.equal(p.status.state, 'run', 'driving is not yet the brake test');
  s.speed = 0;
  assert.equal(tick().state, 'done');
  assert.equal(p.done.size, COUPLING_STEPS.length);
  assert.deepEqual([...ORDER].sort(), COUPLING_STEPS.filter((x) => x.kind === 'act').map((x) => x.id).sort(), 'the test knows every step on foot');
});

test('the order counts: lines only when the trailer is secured, red and yellow each in their turn', () => {
  const s: CouplingState = { speed: 0, handbrake: true, coupled: true, dist: 0, angle: 0 };
  const p = new CouplingProcedure();
  p.update(s, 0.02);
  assert.equal(p.act('uRed', s), 'ceSecure', 'air lines off an unsecured trailer');
  assert.equal(p.act('uOpen', s), 'ceOpen', 'the coupling opened with the lines still on');
  assert.equal(p.done.has('uRed'), false, 'a step out of turn is not done');
  for (const id of ['uBrake', 'uChocks', 'uLeg'] as const) assert.equal(p.act(id, s), null);
  assert.equal(p.act('uYellow', s), 'ceAir', 'uncoupling: red first');
  assert.equal(p.act('uRed', s), null);
  assert.equal(p.act('uYellow', s), null);
  assert.equal(p.act('uRed', s), null, 'a step already done is neither done again nor a fault');
  // rolling or without the handbrake nobody gets out
  assert.equal(p.onFoot({ ...s, speed: 0.5 }), false);
  assert.equal(p.onFoot({ ...s, handbrake: false }), false);
  assert.equal(p.act('uCable', { ...s, handbrake: false }), null);
  assert.equal(p.done.has('uCable'), false);

  // coupling: straight on to the trailer without stopping to look is a fault, and so is bumping into it
  const q = new CouplingProcedure();
  for (const id of ['uPark', 'uBrake', 'uChocks', 'uLeg', 'uRed', 'uYellow', 'uCable', 'uOpen', 'uPull'] as const) q.done.add(id);
  const st = q.update({ speed: -1.5, handbrake: false, coupled: false, dist: 0.1, angle: 0.02 }, 0.02);
  assert.equal(st.couple, true);
  assert.deepEqual(st.faults, ['ceHeight', 'ceFast']);
  const t: CouplingState = { speed: 0, handbrake: true, coupled: true, dist: 0, angle: 0 };
  q.update(t, 0.02);
  assert.equal(q.act('cYellow', t), 'ceLocked', 'lines on before the coupling was checked');
  assert.equal(q.act('cLocked', t), null);
  assert.equal(q.act('cRed', t), 'ceAir', 'coupling: yellow first – red never alone');
  assert.equal(q.act('cChocks', t), 'ceRelease', 'chocks away before the brakes have air');
  assert.equal(q.act('cLights', t), 'ceLights', 'lights checked before the cable is in');
});

// ---- what the game shows around the tasks ---------------------------------------------

test('every step of the coupling catalogue, every task and every fault has its texts', () => {
  for (const dict of [en, de] as Array<Record<string, string>>) {
    for (const step of COUPLING_STEPS) {
      const key = step.kind === 'act' ? `ce.step.${step.id}` : `ce.do.${step.id}`;
      assert.ok(dict[key], key);
    }
    for (const task of ['corner', 'ramp']) assert.ok(dict[`ce.do.${task}`], task);
    const faults = ['ceLine', 'ceCorrections', 'ceRamp', 'ceSecure', 'ceAir', 'ceOpen', 'ceLocked', 'ceRelease', 'ceLights', 'ceHeight', 'ceFast', 'truckRightTurn', 'truckSpeed'];
    for (const id of faults) {
      assert.ok(dict[`v.${id}.title`], `${id} title`);
      assert.ok(dict[`v.${id}.why`], `${id} why`);
      assert.ok(VIOLATION_REFS[id], `${id} citation`);
    }
    // the faults the catalogue itself names
    for (const step of COUPLING_STEPS) if ('why' in step) assert.ok(faults.includes(step.why), step.why);
  }
});

test('the faults of the truck lessons cite the test regulations and the StVO, with links', () => {
  const fev = citationParts(VIOLATION_REFS.ceAir);
  assert.equal(fev[0].text, 'Anlage 7');
  assert.equal(fev[0].url, 'https://www.gesetze-im-internet.de/fev_2010/anlage_7.html');
  assert.equal(fev.map((p) => p.text).join(''), VIOLATION_REFS.ceAir);
  // an annex of the StVO still leads to the StVO
  assert.equal(citationParts('Anlage 3 StVO, Zeichen 325.1')[0].url, 'https://www.gesetze-im-internet.de/stvo_2013/anlage_3.html');
  const speed = citationParts(VIOLATION_REFS.truckSpeed).filter((p) => p.url);
  assert.deepEqual(speed.map((p) => p.url), ['https://www.gesetze-im-internet.de/stvo_2013/__3.html', 'https://www.gesetze-im-internet.de/stvo_2013/__18.html']);
  assert.equal(citationParts(VIOLATION_REFS.truckRightTurn)[0].url, 'https://www.gesetze-im-internet.de/stvo_2013/__9.html');
});

test('the lessons of the truck: three on the yard, then the test with all of them before the drive', () => {
  const truck = LESSONS.filter((l) => (l.vehicles ?? [l.vehicle]).includes('truck'));
  // (the articulated lorry has the same lessons: game/semice.ts)
  assert.deepEqual(LESSONS.filter((l) => l.vehicles?.includes('semi')), truck);
  assert.deepEqual(truck.map((l) => l.id), ['ceCouple', 'ceCorner', 'ceRamp', 'ceExam']);
  assert.deepEqual(truck.filter((l) => l.kind === 'yard').map((l) => l.tasks), [['couple'], ['corner'], ['ramp']]);
  const exam = truck[3];
  assert.equal(exam.kind, 'exam');
  assert.deepEqual(exam.tasks, ['couple', 'corner', 'ramp']);
  assert.ok(exam.targets.length >= 4, 'a drive in traffic follows the yard');
  for (const l of LESSONS) {
    for (const dict of [en, de] as Array<Record<string, string>>) {
      assert.ok(dict[`lesson.${l.id}.title`], l.id);
      assert.ok(dict[`lesson.${l.id}.intro`], l.id);
    }
    for (const t of l.tasks ?? []) assert.ok(taskLayout(t), t);
  }
  // the car keeps its first lesson; the routes are for all vehicles, the test drive on the road for all but the truck with
  // its trailer (it has its own, with the yard), the motorway for all but the tractor
  assert.ok(LESSONS.some((l) => l.vehicle === 'car' && l.kind === 'basics'));
  assert.ok(LESSONS.some((l) => l.kind === 'exam' && !l.vehicle && (l.notFor ?? []).includes('truck')));
  assert.ok(LESSONS.some((l) => l.id === 'motorway' && (l.notFor ?? []).includes('tractor')));
  assert.ok(LESSONS.some((l) => !l.vehicle && l.kind === 'route'));
});

test('a whole coupling run in the right order is without fault, whatever order the list is shown in', () => {
  const p = new CouplingProcedure();
  const s = { speed: 0, handbrake: true, coupled: true, dist: 0, angle: 0 };
  const faults: string[] = [];
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      const st = p.update(s, 0.05);
      faults.push(...st.faults);
      if (st.uncouple) s.coupled = false;
      if (st.couple) s.coupled = true;
    }
  };
  const act = (...ids: CouplingStepId[]): void => {
    for (const id of ids) {
      assert.ok(p.choices().includes(id), `${id} is offered`);
      const f = p.act(id, s);
      assert.equal(f, null, `${id}: ${f}`);
    }
  };
  tick();
  act('uChocks', 'uBrake', 'uLeg', 'uCable', 'uRed', 'uYellow', 'uOpen');
  // pull away from the trailer
  s.handbrake = false;
  s.speed = 1;
  tick();
  s.dist = 3;
  tick();
  s.speed = 0;
  s.handbrake = true;
  tick();
  act('cCheck');
  // back to a metre before the eye, stop, look
  s.dist = 1;
  tick();
  act('cHeight');
  // the last metre at a crawl
  s.handbrake = false;
  s.speed = -0.3;
  s.dist = 0.1;
  tick();
  assert.equal(s.coupled, true);
  s.speed = 0;
  s.handbrake = true;
  tick();
  act('cLocked', 'cLeg', 'cYellow', 'cRed', 'cCable', 'cLights', 'cChocks', 'cBrake');
  // the brake test
  s.handbrake = false;
  s.speed = 2;
  tick(60);
  s.speed = 0;
  tick();
  assert.deepEqual(faults, []);
  assert.equal(p.status.state, 'done');
  assert.equal(p.done.size, COUPLING_STEPS.length);
});

test('the junction of the corner task has cut-off corners: they are road, beyond the cut is not', () => {
  const lay = taskLayout('corner');
  assert.equal(lay.chamfers.length, 2);
  // a metre along each leg from the east corner of the junction (-17, 6)
  assert.equal(offArea(lay, -16, 5), 0);
  assert.equal(offArea(lay, -25, 5), 0, 'the west corner as well');
  // beyond the cut
  assert.ok(offArea(lay, -14, 3) > 1.3);
  // half a metre beyond the middle of the cut, at right angles to it
  const d = offArea(lay, -15 + 0.5 / Math.SQRT2, 4 - 0.5 / Math.SQRT2);
  assert.ok(near(d, 0.5, 1e-9), String(d));
  // the roads themselves, and the strip of asphalt beyond their lines
  assert.equal(offArea(lay, 0, 9.5), 0);
  assert.ok(near(offArea(lay, 0, 14), 1, 1e-9));
  assert.equal(offArea(lay, 0, 14, 1.2), 0);
  // the other tasks have no junction
  assert.equal(taskLayout('ramp').chamfers.length, 0);
  assert.equal(taskLayout('couple').goalMarked, false);
});

test('the lines are kerbs: a wheel over them is a fault, the body swinging over them is not', () => {
  // half way round the corner (a pose from a clean run): everything on the road
  const trailer: Pose = { x: -18.5, z: 5.5, yaw: EAST - 0.803 };
  const truck: Pose = { x: -10.8, z: 10.29, yaw: EAST - 0.227 };
  const clean = new ManoeuvreJudge('corner');
  assert.deepEqual(clean.update({ truck, trailer, speed: -0.5, handbrake: false }, 0.05).faults, []);
  // the truck turned across the road: its front corner hangs over the southern line, its wheels do not
  const across: Pose = { x: -4, z: 10.9, yaw: EAST - 0.5 };
  const nose = corners(across, TRUCK_OUTLINE.front, TRUCK_OUTLINE.rear, TRUCK_OUTLINE.hw);
  assert.ok(nose[3] > 13.4, `the front right corner is over the line at 13 (${nose[3].toFixed(2)})`);
  const swing = new ManoeuvreJudge('corner');
  assert.deepEqual(swing.update({ truck: across, trailer: { x: -13.2, z: 8.4, yaw: EAST - 0.05 }, speed: -0.5, handbrake: false }, 0.05).faults, []);
  // half a metre further and the front wheel is over the kerb
  const over = new ManoeuvreJudge('corner');
  assert.deepEqual(over.update({ truck: { ...across, z: 11.6 }, trailer: { x: -13.2, z: 8.4, yaw: EAST - 0.05 }, speed: -0.5, handbrake: false }, 0.05).faults, ['ceLine']);
});
