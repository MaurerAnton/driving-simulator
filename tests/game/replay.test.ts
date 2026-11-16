// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Replays: what is written down while driving, how much of it is kept, and
 * what a replay shows between two frames – the player's vehicle, the
 * traffic, the trams, the lights.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CAR_FIELDS, RAIL_CAR_FIELDS, RAIL_HEAD, REPLAY_KEEP, Recorder, ReplayView, VisualPacker } from '../../src/game/replay.ts';
import type { ReplayFrame } from '../../src/game/replay.ts';
import { SIG, SignalSystem } from '../../src/sim/signals.ts';
import { XING } from '../../src/world/types.ts';
import { makeTown } from './town.ts';

function frame(t: number, x: number, extra: Partial<ReplayFrame> = {}): ReplayFrame {
  return { t, pose: Float32Array.from([x, 0, 0, 0, 0, 0, 1]), look: null, trailer: null, walker: null, cars: null, peds: null, cyclists: null, rail: null, signals: null, ...extra };
}

test('a visual state packed and unpacked comes back the same: numbers, flags, texts, arrays', () => {
  const p = new VisualPacker();
  const s = { speedKmh: 48.5, gear: 'D', braking: true, wheelSpin: [1, 2, 3, 4], skip: { nested: 1 } };
  const a = p.pack(s);
  const b = p.pack({ ...s, speedKmh: 12, gear: 'R', braking: false, wheelSpin: [5, 6, 7, 8] });
  const out = { speedKmh: 0, gear: '', braking: false, wheelSpin: [0, 0, 0, 0], skip: { nested: 2 } };
  p.unpack(a, out);
  assert.deepEqual(out, { speedKmh: 48.5, gear: 'D', braking: true, wheelSpin: [1, 2, 3, 4], skip: { nested: 2 } });
  p.unpack(b, out);
  assert.equal(out.gear, 'R');
  assert.equal(out.braking, false);
  assert.deepEqual(out.wheelSpin, [5, 6, 7, 8]);
});

test('written ten times a second, the others five, the lights twice; only the last half hour is kept', () => {
  const r = new Recorder();
  r.clear('car');
  let frames = 0;
  let others = 0;
  let signals = 0;
  for (let t = 0; t < 10; t += 1 / 60) {
    const due = r.due(t);
    if (!due) continue;
    frames++;
    if (due.others) others++;
    if (due.signals) signals++;
    r.push(frame(t, t, due.others ? { cars: new Float32Array(0) } : {}));
  }
  assert.ok(Math.abs(frames - 100) <= 2, `${frames} frames in 10 s`);
  assert.ok(Math.abs(others - 50) <= 2, `${others} with the traffic`);
  assert.ok(Math.abs(signals - 20) <= 2, `${signals} with the lights`);
  // a long drive: what is older than half an hour goes, and the first frame kept still has the traffic
  for (let t = 10; t < REPLAY_KEEP + 200; t += 0.1) r.push(frame(t, t, Math.round(t * 10) % 50 === 0 ? { cars: new Float32Array(0) } : {}));
  assert.ok(r.end - r.start <= REPLAY_KEEP + 10, `${(r.end - r.start).toFixed(0)} s kept`);
  assert.ok(r.frames[0].cars, 'the traffic of the first frame kept');
});

test('between two frames the replay moves the player, the cars and the trams part of the way; it plays, stops at the end, and jumps', () => {
  const r = new Recorder();
  r.clear('car');
  const car = (id: number, x: number): number[] => [id, 0, x, 0, 0, Math.PI - 0.1, 0, 0, 0, 0, 10, 0xff0000, -1];
  r.push(frame(0, 0, { cars: Float32Array.from([...car(7, 10), ...car(8, 50)]), rail: Float32Array.from([3, 0, 0, 2, 1, 1, 100, 0, 0, 0.5, 0]) }));
  r.push(frame(0.2, 4, { cars: Float32Array.from(car(7, 12)), rail: Float32Array.from([3, 0, 0, 2, 1, 1, 104, 0, 0, 0.7, 0]) }));
  const v = new ReplayView(r);
  v.seek(0.1);
  v.frame();
  assert.ok(Math.abs(v.pose[0] - 2) < 1e-6, 'the player half way');
  v.traffic();
  assert.equal(v.carList.length, 2);
  const c7 = v.carList.find((c) => c.id === 7)!;
  assert.ok(Math.abs(c7.x - 11) < 1e-4, 'car 7 half way');
  assert.equal(v.carList.find((c) => c.id === 8)!.x, 50, 'car 8 stays where it was last seen');
  v.trains();
  assert.equal(v.railList.length, 1);
  assert.ok(Math.abs(v.railList[0].cars[0].x - 102) < 1e-4 && Math.abs(v.railList[0].cars[0].yaw - 0.6) < 1e-4, 'the tram half way, turning');
  assert.equal(v.railList[0].line?.index, 2);
  assert.equal(RAIL_HEAD + RAIL_CAR_FIELDS, 11);
  assert.equal(CAR_FIELDS, 13);
  v.seek(0);
  v.speed = 2;
  v.advance(1);
  assert.equal(v.t, 0.2, 'stops at the end');
  assert.equal(v.playing, false);
});

test('the lights: a snapshot of the controllers round a place, put back later, shows what they showed then', () => {
  const town = makeTown({ cols: 2, rows: 1, block: 300, pavement: 2, crossings: [{ street: [0, 0, 1, 0], at: 0.5, k: XING.SIGNAL }] });
  const signals = new SignalSystem(town.world.signals);
  const sc = town.world.crossings[0].sc!;
  for (let t = 0; t < 30; t += 0.1) signals.update(0.1);
  signals.request(sc);
  while (signals.pedestrian(sc, 0) !== 'green') signals.update(0.1);
  const c = town.world.signals[sc];
  const snap = signals.snapshot(c.x, c.z, 600);
  assert.ok(snap.ids.includes(sc));
  for (let t = 0; t < 40; t += 0.1) signals.update(0.1);
  assert.equal(signals.get(sc, 0), SIG.GREEN, 'back to rest');
  signals.restore(snap);
  assert.equal(signals.pedestrian(sc, 0), 'green', 'the people had green');
  assert.notEqual(signals.get(sc, 0), SIG.GREEN, 'the cars had red');
  assert.equal(signals.snapshot(c.x + 5000, c.z, 600).ids.length, 0, 'far away: none');
});
