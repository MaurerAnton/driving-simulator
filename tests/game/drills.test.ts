// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The basic tasks of class B (src/game/drills.ts): each judge driven
 * through its task with scripted poses – done well, and done wrong in the
 * ways the test punishes – and the hill start and the emergency stop with
 * the real car's dynamics.
 *
 *   node --test tests/game/drills.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { YardFrame } from '../../src/game/ce.ts';
import type { Pose } from '../../src/game/ce.ts';
import { BAYS, CAR_SHAPE, DrillJudge, EAST, HILL_LINE, NORTH, PARALLEL, SOUTH, WEST, drillLayout, examDrills, hillRise, rectsOverlap } from '../../src/game/drills.ts';
import type { DrillId, DrillInput, DrillStatus } from '../../src/game/drills.ts';
import { LESSONS } from '../../src/game/nav.ts';
import { COMPACT_CAR_AUTOMATIC } from '../../src/sim/vehicle/index.ts';
import type { DriverInput, Vehicle } from '../../src/sim/vehicle/index.ts';
import { DT, PlaneGround, input, makeCar } from '../vehicle/harness.ts';

const STEP = 0.05;

interface Run {
  j: DrillJudge;
  pose: Pose;
  faults: string[];
  remarks: string[];
  stops: number;
  status: DrillStatus;
}

const start = (id: DrillId, rand = (): number => 0.5): Run => {
  const j = new DrillJudge(id, CAR_SHAPE, rand);
  return { j, pose: { ...j.layout.start }, faults: [], remarks: [], stops: 0, status: j.status };
};

function feed(r: Run, s: Partial<DrillInput>): void {
  const st = r.j.update({ pose: r.pose, speed: 0, handbrake: false, brake: 0, engine: true, ...s }, STEP);
  for (const f of st.faults) r.faults.push(`${f.id}:${f.severity}`);
  if (st.remark) r.remarks.push(st.remark);
  if (st.stop) r.stops++;
}

const lerpYaw = (a: number, b: number, t: number): number => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

/** Move to a pose, forwards (1) or backwards (−1), at about walking pace; then stand. */
function go(r: Run, to: [number, number, number], dir: 1 | -1, brake = 0): void {
  const from = r.pose;
  const dist = Math.hypot(to[0] - from.x, to[1] - from.z) + Math.abs(lerpYaw(from.yaw, to[2], 1) - from.yaw) * 1.5;
  const n = Math.max(4, Math.ceil(dist / (1.2 * STEP)));
  const speed = (dir * dist) / (n * STEP);
  const a = { ...from };
  for (let i = 1; i <= n && r.status.state === 'run'; i++) {
    const t = i / n;
    r.pose = { x: a.x + (to[0] - a.x) * t, z: a.z + (to[1] - a.z) * t, yaw: lerpYaw(a.yaw, to[2], t) };
    feed(r, { speed, brake });
  }
}

/** Stand where it is for a while (with the handbrake or without). */
function stand(r: Run, seconds: number, handbrake = true): void {
  for (let t = 0; t < seconds && r.status.state === 'run'; t += STEP) feed(r, { speed: 0, handbrake });
}

const has = (r: Run, f: string): boolean => r.faults.includes(f);

// ---- the layouts

test('the layouts: the car starts on the paved area, clear of the parked cars, and the gap and the bays are big enough', () => {
  const ids: DrillId[] = ['parallel', 'bayFwd', 'bayBack', 'backStraight', 'backCorner', 'turn', 'hill', 'brake'];
  for (const id of ids) {
    const r = start(id);
    stand(r, 0.3);
    assert.deepEqual(r.faults, [], `${id}: nothing wrong standing at the start`);
    assert.equal(r.status.state, 'run', id);
  }
  const p = drillLayout('parallel');
  assert.ok(p.goal.u1 - p.goal.u0 >= (CAR_SHAPE.front + CAR_SHAPE.rear) * 1.4, 'the gap: about one and a half car lengths');
  assert.equal(p.parked.length, 3);
  const b = drillLayout('bayFwd');
  assert.ok(BAYS.width - 2 * CAR_SHAPE.hw > 0.8, 'the bay: room beside the car');
  assert.ok(BAYS.depth > CAR_SHAPE.front + CAR_SHAPE.rear + 0.8);
  assert.ok(b.goalMarked);
});

test('the ramp of the hill start: 10 %, level on top, falling away at the sides', () => {
  const h = drillLayout('hill').hill!;
  assert.equal(hillRise(h, h.u0 - 1, 0), 0);
  const grade = (hillRise(h, h.u1 - 1, 0) - hillRise(h, h.u1 - 3, 0)) / 2;
  assert.ok(Math.abs(grade - 0.1) < 1e-9, `grade ${grade}`);
  assert.equal(hillRise(h, (h.u1 + h.u2) / 2, 0), h.h);
  assert.equal(hillRise(h, (h.u1 + h.u2) / 2, h.w1 + h.side), 0);
  assert.ok(hillRise(h, (h.u1 + h.u2) / 2, h.w1 + h.side / 2) > 0);
  assert.ok(hillRise(h, HILL_LINE, 0) > 0.5, 'the line is on the slope');
});

test('rectangles overlapping', () => {
  const a = [0, 0, 2, 0, 2, 1, 0, 1];
  assert.ok(rectsOverlap(a, [1, 0.5, 3, 0.5, 3, 2, 1, 2]));
  assert.ok(!rectsOverlap(a, [2.1, 0, 4, 0, 4, 1, 2.1, 1]));
  // (turned by 45°, its corner just short of the first)
  const d = 0.75;
  assert.ok(!rectsOverlap(a, [2 + d + 0.05, 0.5, 2 + 2 * d + 0.05, 0.5 - d, 2 + 3 * d + 0.05, 0.5, 2 + 2 * d + 0.05, 0.5 + d]));
});

// ---- parallel parking

const K = PARALLEL.kerb;
const gapEnd = (): number => drillLayout('parallel').goal.u1;

function parallelIn(r: Run, finalW = K - 0.15 - CAR_SHAPE.hw): void {
  const G = gapEnd();
  go(r, [G + CAR_SHAPE.rear, r.pose.z, EAST], 1);
  stand(r, 0.4, false);
  go(r, [5.0, 3.0, EAST + 0.7], -1);
  go(r, [3.6, 4.1, EAST + 0.6], -1);
  go(r, [3.1, finalW, EAST], -1);
}

test('parallel parking: into the gap, 15 cm from the kerb, three stars', () => {
  const r = start('parallel');
  parallelIn(r);
  assert.ok(r.status.step >= 4, `the guided steps followed (step ${r.status.step})`);
  stand(r, 1.2);
  assert.equal(r.status.state, 'done', r.remarks.join(' / '));
  assert.deepEqual(r.faults, []);
  assert.ok(Math.abs(r.status.kerb - 0.15) < 0.01);
  const res = r.j.result();
  assert.equal(res.stars, 3);
  assert.equal(r.status.corrections, 0);
});

test('parallel parking: too far from the kerb is not done yet – the instructor says why', () => {
  const r = start('parallel');
  parallelIn(r, K - 0.62 - CAR_SHAPE.hw);
  stand(r, 2.5);
  assert.equal(r.status.state, 'run');
  assert.ok(r.remarks.includes('drill.r.kerbFar'), r.remarks.join(' / '));
  // 40 cm: done, but noted
  const r2 = start('parallel');
  parallelIn(r2, K - 0.4 - CAR_SHAPE.hw);
  stand(r2, 1.2);
  assert.equal(r2.status.state, 'done');
  assert.ok(has(r2, 'drillKerbFar:minor'));
  assert.ok(r2.j.result().stars < 3);
});

test('parallel parking: touching the car in front ends the task', () => {
  const r = start('parallel');
  const G = gapEnd();
  go(r, [G + CAR_SHAPE.rear, r.pose.z, EAST], 1);
  // straight back towards the kerb: the rear runs into the parked car
  go(r, [G + 1, 4.8, EAST], -1);
  assert.equal(r.status.state, 'failed');
  assert.ok(has(r, 'drillTouch:fail'));
  assert.ok(r.stops > 0, 'the car is stopped');
  assert.equal(r.j.result().stars, 0);
});

test('parallel parking: a wheel over the kerb fails, more than two corrections fail', () => {
  const r = start('parallel');
  parallelIn(r, K + 0.5 - CAR_SHAPE.hw);
  assert.ok(has(r, 'drillKerbTouch:minor'));
  assert.ok(has(r, 'drillKerbOver:fail'));
  assert.equal(r.status.state, 'failed');

  const c = start('parallel');
  parallelIn(c);
  for (let k = 0; k < 3; k++) {
    go(c, [c.pose.x + 0.6, c.pose.z, EAST], 1);
    go(c, [c.pose.x - 0.6, c.pose.z, EAST], -1);
  }
  assert.ok(has(c, 'drillCorrections:fail'), c.faults.join(' '));
  assert.ok(c.remarks.includes('drill.r.correction'));
});

// ---- bay parking

test('bay parking forwards: into the bay between the cars', () => {
  const r = start('bayFwd');
  go(r, [-4.5, r.pose.z, EAST], 1);
  go(r, [-1.0, 5.5, EAST - Math.PI / 4], 1);
  go(r, [0, 9.9, SOUTH], 1);
  assert.equal(r.status.step, 3);
  stand(r, 1.2);
  assert.equal(r.status.state, 'done', `${r.faults.join(' ')} ${r.remarks.join(' / ')}`);
  assert.deepEqual(r.faults, []);
  assert.equal(r.j.result().stars, 3);
});

test('bay parking forwards: crooked and half out is not done; the wrong way round is said', () => {
  const r = start('bayFwd');
  go(r, [-4.5, r.pose.z, EAST], 1);
  go(r, [-1.0, 5.5, EAST - Math.PI / 4], 1);
  go(r, [0, 8.0, SOUTH], 1);
  stand(r, 2);
  assert.equal(r.status.state, 'run');
  assert.ok(r.remarks.includes('drill.r.notInBay'));
  // reversed in for the forwards task
  const w = start('bayFwd');
  w.pose = { x: 0, z: 9.9, yaw: NORTH };
  stand(w, 2);
  assert.ok(w.remarks.includes('drill.r.noseIn'));
});

test('bay parking backwards: past the bay, back in', () => {
  const r = start('bayBack');
  go(r, [5.0, r.pose.z, EAST], 1);
  stand(r, 0.3, false);
  go(r, [2.6, 4.4, -1.1], -1);
  go(r, [0.5, 6.4, -0.3], -1);
  go(r, [0, 9.9, NORTH], -1);
  stand(r, 1.2);
  assert.equal(r.status.state, 'done', `${r.faults.join(' ')} ${r.remarks.join(' / ')}`);
  assert.deepEqual(r.faults, []);
  assert.equal(r.status.corrections, 0);
});

test('bay parking backwards: into the neighbouring car fails', () => {
  const r = start('bayBack');
  go(r, [5.0, r.pose.z, EAST], 1);
  go(r, [BAYS.width, 9.9, NORTH], -1);
  assert.ok(has(r, 'drillTouch:fail'));
});

// ---- reversing

test('reversing straight: into the box; off the lane is a fault, far off fails', () => {
  const r = start('backStraight');
  go(r, [-27, 0, EAST], -1);
  stand(r, 1.2);
  assert.equal(r.status.state, 'done');
  assert.deepEqual(r.faults, []);

  const off = start('backStraight');
  go(off, [-10, 1.0, EAST], -1);
  assert.ok(has(off, 'drillLine:major'));
  go(off, [-20, 4.5, EAST], -1);
  assert.ok(has(off, 'drillLine:fail'));
});

function cornerPath(r: Run, end: [number, number, number]): void {
  go(r, [8, r.pose.z, EAST], 1);
  stand(r, 0.3, false);
  go(r, [5, r.pose.z, EAST], -1);
  go(r, [2.4, -0.8, -Math.PI / 3], -1);
  go(r, [0.6, 1.0, -Math.PI / 6], -1);
  go(r, [end[0], 3.0, -0.08], -1);
  go(r, end, -1);
}

test('reversing round a corner to the right: close to the kerb, straight in the side road', () => {
  const r = start('backCorner');
  cornerPath(r, [-0.895 - 0.3, 6.5, NORTH]);
  stand(r, 1.2);
  assert.equal(r.status.state, 'done', `${r.faults.join(' ')} ${r.remarks.join(' / ')}`);
  assert.deepEqual(r.faults, []);
  assert.ok(r.j.result().stars >= 2);
});

test('reversing round a corner: cutting the corner over the kerb fails, ending far from it is said', () => {
  const r = start('backCorner');
  go(r, [8, r.pose.z, EAST], 1);
  go(r, [3.5, 1.5, -Math.PI / 4], -1);
  assert.ok(has(r, 'drillKerbOver:fail'), r.faults.join(' '));

  const far = start('backCorner');
  cornerPath(far, [-0.895 - 1.6, 6.5, NORTH]);
  stand(far, 2);
  assert.equal(far.status.state, 'run');
  assert.ok(far.remarks.includes('drill.r.kerbFar'));
});

// ---- turning round

test('turning round in three moves without touching the kerbs', () => {
  const r = start('turn');
  go(r, [-12.2, 2.2, EAST + 1.1], 1);
  assert.equal(r.status.step, 0);
  go(r, [-13.8, 4.6, EAST + 2.1], -1);
  assert.equal(r.status.step, 1);
  go(r, [-17, 1.8, WEST], 1);
  stand(r, 0.5, false);
  assert.equal(r.status.state, 'done', `${r.faults.join(' ')} ${r.remarks.join(' / ')}`);
  assert.deepEqual(r.faults, []);
  assert.equal(r.j.moveCount, 3);
});

test('turning round: up on the kerb fails', () => {
  const r = start('turn');
  go(r, [-11, 0.6, EAST + 1.4], 1);
  assert.ok(has(r, 'drillKerbOver:fail'), r.faults.join(' '));
});

// ---- the hill start (scripted)

const atLine = HILL_LINE - CAR_SHAPE.front - 0.4;

test('hill start: stop at the line, handbrake, away with 10 cm of rolling back', () => {
  const r = start('hill');
  go(r, [atLine, 0, EAST], 1);
  stand(r, 0.2, false);
  assert.equal(r.status.step, 1);
  stand(r, 0.7, true);
  assert.equal(r.status.step, 2);
  go(r, [atLine - 0.1, 0, EAST], -1);
  go(r, [atLine + 4.5, 0, EAST], 1);
  assert.equal(r.status.state, 'done');
  assert.deepEqual(r.faults, []);
  assert.ok(Math.abs(r.status.rollback - 0.1) < 0.02);
  assert.equal(r.j.result().stars, 3);
});

test('hill start: rolling back 50 cm is a serious fault, more than a metre fails; no handbrake is a fault', () => {
  const r = start('hill');
  go(r, [atLine, 0, EAST], 1);
  stand(r, 0.2, false);
  stand(r, 0.7, true);
  go(r, [atLine - 0.5, 0, EAST], -1);
  assert.ok(has(r, 'drillRollback:major'));
  go(r, [atLine - 1.3, 0, EAST], -1);
  assert.ok(has(r, 'drillRollback:fail'));

  const n = start('hill');
  go(n, [atLine, 0, EAST], 1);
  stand(n, 0.2, false);
  go(n, [atLine + 4.5, 0, EAST], 1);
  assert.ok(has(n, 'drillHillBrake:major'));
  assert.equal(n.status.state, 'done');
  assert.ok(n.j.result().stars < 3);
});

test('hill start: a stalled engine is a minor fault – an engine not yet started is none', () => {
  const r = start('hill');
  feed(r, { engine: false });
  feed(r, { engine: true });
  assert.deepEqual(r.faults, []);
  feed(r, { engine: false });
  assert.ok(has(r, 'drillStall:minor'));
});

// ---- the emergency stop (scripted)

function brakeRun(react: number, pedal: number, speed = 30 / 3.6): Run {
  const r = start('brake', () => 0);
  // up to speed, held: the signal comes a second later
  while (!r.status.signal && r.pose.x < 60) {
    r.pose = { ...r.pose, x: r.pose.x + speed * STEP };
    feed(r, { speed });
    if (r.status.signal) break;
  }
  assert.ok(r.status.step === 1, 'the signal was given');
  let v = speed;
  let t = 0;
  while (v > 0.05 && t < 10) {
    t += STEP;
    const on = t >= react;
    if (on) v = Math.max(0, v - 9 * pedal * STEP);
    r.pose = { ...r.pose, x: r.pose.x + v * STEP };
    feed(r, { speed: v, brake: on ? pedal : 0 });
  }
  feed(r, { speed: 0, brake: pedal });
  return r;
}

test('emergency stop: at once and with full force – three stars', () => {
  const r = brakeRun(0.6, 1);
  assert.equal(r.status.state, 'done');
  assert.deepEqual(r.faults, []);
  assert.ok(r.remarks.includes('drill.r.braked'));
  const res = r.j.result();
  assert.equal(res.stars, 3, JSON.stringify(res));
  assert.equal(res.measureData.v, 30);
});

test('emergency stop: late and soft – faults, a long way', () => {
  const r = brakeRun(1.6, 0.4);
  assert.ok(has(r, 'drillBrakeLate:major'));
  assert.ok(has(r, 'drillBrakeSoft:major'));
  assert.ok(has(r, 'drillBrakeLong:minor'));
  assert.ok(r.j.result().stars <= 1);
  // too fast at the signal
  const f = brakeRun(0.6, 1, 50 / 3.6);
  assert.ok(has(f, 'drillBrakeSpeed:minor'));
});

// ---- with the real car's dynamics

/** A yard turned so that its u runs north – up the plane of the harness. */
const FRAME = new YardFrame({ x: 0, z: 0, len: 150, wid: 66, rot: 1 });

function drive(v: Vehicle, j: DrillJudge, seconds: number, at: number, d: (t: number) => DriverInput, until: () => boolean = () => false): string[] {
  const faults: string[] = [];
  const pos = [0, 0, 0];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const inp = d(i * DT);
    v.step(DT, inp);
    v.getModelPosition(pos);
    const pose = FRAME.poseToLocal({ x: pos[0], z: pos[2], yaw: v.yaw });
    const st = j.update({ pose: { ...pose, x: pose.x + at }, speed: v.speed, handbrake: inp.handbrake > 0.5, brake: inp.brake, engine: v.engineRunning }, DT);
    for (const f of st.faults) faults.push(`${f.id}:${f.severity}`);
    if (st.state !== 'run' || until()) break;
  }
  return faults;
}

test('hill start with the car on 10 %: let go without the handbrake technique it rolls back – with it, it does not', () => {
  for (const technique of [false, true]) {
    const v = makeCar(new PlaneGround(0.1), COMPACT_CAR_AUTOMATIC);
    const j = new DrillJudge('hill');
    // standing at the line, held by the foot brake, then the handbrake
    const faults = drive(v, j, 2, atLine, () => input({ gear: 1, brake: 1, handbrake: 0 }), () => j.status.step === 1);
    faults.push(...drive(v, j, 1.5, atLine, () => input({ gear: 1, brake: 0.5, handbrake: 1 }), () => j.status.step === 2));
    assert.equal(j.status.step, 2, 'secured');
    // in neutral, the handbrake released, no gas: it rolls back; with the technique: gas first, then the handbrake off
    faults.push(...drive(v, j, 12, atLine, (t) => (technique ? input({ gear: 1, throttle: 0.45, handbrake: t < 0.6 ? 1 : 0 }) : input({ gear: 0, handbrake: 0 }))));
    if (technique) {
      assert.equal(j.status.state, 'done', `${faults.join(' ')} rolled ${j.status.rollback.toFixed(2)}`);
      assert.ok(j.status.rollback < 0.2, `rolled back ${j.status.rollback}`);
    } else {
      assert.equal(j.status.state, 'failed');
      assert.ok(faults.includes('drillRollback:major') && faults.includes('drillRollback:fail'), faults.join(' '));
    }
  }
});

test('emergency stop with the car: full braking from 30 km/h stops within the distance judged good', () => {
  const v = makeCar(new PlaneGround(0), COMPACT_CAR_AUTOMATIC);
  const j = new DrillJudge('brake', CAR_SHAPE, () => 0);
  let signalAt = -1;
  let t = 0;
  const faults = drive(v, j, 40, -68, () => {
    t += DT;
    if (j.status.step === 1 && signalAt < 0) signalAt = t;
    if (signalAt >= 0) return input({ gear: 1, brake: t - signalAt > 0.5 ? 1 : 0 });
    return input({ gear: 1, throttle: v.speed < 30 / 3.6 ? 0.6 : 0.15 });
  });
  assert.ok(signalAt > 0, 'the signal was given');
  assert.equal(j.status.state, 'done', faults.join(' '));
  assert.deepEqual(faults, []);
  const res = j.result();
  assert.ok(Number(res.measureData.d) < Number(res.measureData.ideal) * 1.3, JSON.stringify(res.measureData));
});

// ---- the lessons

test('the lessons: on the yard, for the car (the hill start and the emergency stop for the vans too), the test-like round picks three basic tasks as Anlage 7 FeV does', () => {
  const b = LESSONS.filter((l) => l.drills);
  assert.deepEqual(
    b.map((l) => l.id),
    ['bParallel', 'bBay', 'bReverse', 'bTurn', 'bHill', 'bBrake', 'bDrills'],
  );
  for (const l of b) {
    assert.equal(l.kind, 'yard');
    assert.equal(l.targets.length, 0);
    assert.ok(l.vehicle === 'car' || l.vehicles?.includes('car'), l.id);
  }
  // Anlage 7 FeV, Nr. 2.1.4.2: one task of group a, two different ones of group b – never the hill start or straight reversing
  const seen = new Set<string>();
  for (const r of [0, 0.3, 0.6, 0.99]) {
    const d = examDrills(() => r);
    assert.equal(d.length, 3);
    assert.ok(d[0] === 'backCorner' || d[0] === 'parallel', d.join());
    const b = d.slice(1).map((id) => (id === 'bayFwd' || id === 'bayBack' ? 'bay' : id));
    assert.ok(b.every((id) => id === 'turn' || id === 'bay' || id === 'brake'), d.join());
    assert.notEqual(b[0], b[1]);
    if (b.includes('brake')) assert.equal(b[1], 'brake');
    for (const id of d) seen.add(id);
  }
  let x = 0;
  for (let i = 0; i < 200; i++) for (const id of examDrills(() => ((x = (x * 9301 + 49297) % 233280) / 233280))) seen.add(id);
  for (const id of ['backCorner', 'parallel', 'turn', 'brake']) assert.ok(seen.has(id), id);
  assert.ok(seen.has('bayFwd') || seen.has('bayBack'));
});
