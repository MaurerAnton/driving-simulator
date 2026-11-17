// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The timers over the traffic lights: how long a light still shows what it
 * shows, and a tap that puts its programme forward – through amber and
 * red-amber as always, never two crossing streams on green at once, never a
 * green cut to less than a few seconds.
 *
 *   node --test tests/sim/signals-timer.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SIG, SKIP_LEAST, SignalSystem } from '../../src/sim/signals.ts';
import type { Arm } from '../../src/world/world.ts';
import type { SignalControllerJson } from '../../src/world/types.ts';

/** A junction of two streams, as the map build makes it (tools/mapgen/control.ts), its programme starting at 0. */
function junction(off = 0): SignalControllerJson {
  return {
    x: 0,
    z: 0,
    groups: 2,
    off,
    phases: [
      { d: 28, s: 'GR' },
      { d: 3, s: 'AR' },
      { d: 1, s: 'RR' },
      { d: 1, s: 'RY' },
      { d: 18, s: 'RG' },
      { d: 3, s: 'RA' },
      { d: 1, s: 'RR' },
      { d: 1, s: 'YR' },
    ],
  };
}

/** A pedestrian crossing's light: green for the vehicles until somebody presses. */
function crossing(): SignalControllerJson {
  return {
    x: 0,
    z: 0,
    groups: 1,
    off: 0,
    ped: true,
    phases: [
      { d: 48, s: 'G' },
      { d: 3, s: 'A' },
      { d: 13, s: 'R' },
      { d: 1, s: 'Y' },
    ],
  };
}

const DT = 0.05;
const near = (a: number, b: number, eps = 0.06): boolean => Math.abs(a - b) <= eps;

test('the time a group still shows its light, and what comes next', () => {
  const s = new SignalSystem([junction()]);
  assert.equal(s.get(0, 0), SIG.GREEN);
  let c = s.change(0, 0)!;
  assert.ok(near(c.left, 28), `${c.left}`);
  assert.equal(c.next, SIG.AMBER);
  c = s.change(0, 1)!;
  // the cross stream: red through the green, the amber and the moment of red for all of the main one
  assert.ok(near(c.left, 32), `${c.left}`);
  assert.equal(c.next, SIG.RED_AMBER);
  for (let t = 0; t < 10; t += DT) s.update(DT);
  assert.ok(near(s.change(0, 0)!.left, 18, 0.1));
  // through the amber: red next, in 3 s
  for (let t = 0; t < 19; t += DT) s.update(DT);
  assert.equal(s.get(0, 0), SIG.AMBER);
  c = s.change(0, 0)!;
  assert.equal(c.next, SIG.RED);
  assert.ok(c.left > 0 && c.left <= 3);
  // a controller that is out of order, or not there, has no timer
  const dark = new SignalSystem([junction()], () => true);
  assert.equal(dark.change(0, 0), null);
  assert.equal(s.change(7, 0), null);
});

test('a tap ends the green at once – then amber, red for all, red-amber, green for the others, as programmed', () => {
  const s = new SignalSystem([junction()]);
  for (let t = 0; t < 10; t += DT) s.update(DT);
  assert.equal(s.skip(0), true);
  s.update(0);
  assert.equal(s.get(0, 0), SIG.AMBER, 'the main stream gets amber at once');
  assert.equal(s.get(0, 1), SIG.RED);
  const seen: Array<[number, number, number]> = [];
  for (let t = 0; t < 8; t += DT) {
    s.update(DT);
    const last = seen[seen.length - 1];
    if (!last || last[1] !== s.get(0, 0) || last[2] !== s.get(0, 1)) seen.push([t, s.get(0, 0), s.get(0, 1)]);
  }
  assert.deepEqual(
    seen.map(([, a, b]) => [a, b]),
    [
      [SIG.AMBER, SIG.RED],
      [SIG.RED, SIG.RED],
      [SIG.RED, SIG.RED_AMBER],
      [SIG.RED, SIG.GREEN],
    ],
  );
  // the amber had its full three seconds
  assert.ok(near(seen[1][0], 3, 0.1), `amber for ${seen[1][0]} s`);
});

test('a green that has only just begun runs its least time first; amber and clearance are never cut', () => {
  const s = new SignalSystem([junction()]);
  for (let t = 0; t < 2; t += DT) s.update(DT);
  assert.equal(s.skip(0), true);
  const c = s.change(0, 0)!;
  assert.ok(near(c.left, SKIP_LEAST - 2, 0.1), `still ${c.left} s of green`);
  // a second tap changes nothing more
  assert.equal(s.skip(0), false);
  for (let t = 0; t < SKIP_LEAST - 2 + 0.2; t += DT) s.update(DT);
  assert.equal(s.get(0, 0), SIG.AMBER);
  // during the amber a tap does nothing
  const before = s.change(0, 0)!.left;
  assert.equal(s.skip(0), false);
  assert.ok(near(s.change(0, 0)!.left, before));
});

test('tapped at random for ten minutes: never two streams moving at once, every change in the German order', () => {
  const s = new SignalSystem([junction(17)]);
  const order = new Map<number, number>([
    [SIG.GREEN, SIG.AMBER],
    [SIG.AMBER, SIG.RED],
    [SIG.RED, SIG.RED_AMBER],
    [SIG.RED_AMBER, SIG.GREEN],
  ]);
  let prev = [s.get(0, 0), s.get(0, 1)];
  const began = [0, 0];
  let rnd = 12345;
  const random = (): number => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let skips = 0;
  for (let t = 0; t < 600; t += DT) {
    if (random() < 0.01 && s.skip(0)) skips++;
    s.update(DT);
    const now = [s.get(0, 0), s.get(0, 1)];
    const moving = now.filter((st) => st !== SIG.RED).length;
    assert.ok(moving <= 1, `at ${t.toFixed(2)} s both streams may move: ${now}`);
    for (let g = 0; g < 2; g++) {
      if (now[g] === prev[g]) continue;
      assert.equal(now[g], order.get(prev[g]), `group ${g}: ${prev[g]} → ${now[g]} at ${t.toFixed(2)} s`);
      // green and amber run their least time
      if (prev[g] === SIG.GREEN) assert.ok(t - began[g] >= SKIP_LEAST - 0.1, `green for only ${(t - began[g]).toFixed(2)} s`);
      if (prev[g] === SIG.AMBER) assert.ok(t - began[g] >= 3 - 0.1, `amber for only ${(t - began[g]).toFixed(2)} s`);
      began[g] = t;
    }
    prev = now;
  }
  assert.ok(skips > 20, `${skips} taps went through`);
});

test('the time left agrees with what the lights then do', () => {
  const s = new SignalSystem([junction(5)]);
  for (let k = 0; k < 12; k++) {
    const c = s.change(0, 1)!;
    const was = s.get(0, 1);
    let t = 0;
    while (s.get(0, 1) === was && t < 120) {
      s.update(DT);
      t += DT;
    }
    assert.ok(near(t, c.left, 0.1), `said ${c.left.toFixed(2)} s, took ${t.toFixed(2)} s`);
    assert.equal(s.get(0, 1), c.next);
    if (k % 3 === 1) s.skip(0);
  }
});

test('a pedestrian crossing at rest has no time; a tap asks for the pedestrians as the button does', () => {
  const s = new SignalSystem([crossing()]);
  for (let t = 0; t < 20; t += DT) s.update(DT);
  assert.equal(s.get(0, 0), SIG.GREEN);
  assert.equal(s.change(0, 0)!.left, Infinity);
  assert.equal(s.change(0, 0)!.next, SIG.AMBER);
  // the pedestrians wait for the button too
  assert.equal(s.pedestrianChange(0, 0)!.left, Infinity);
  assert.equal(s.skip(0), true);
  assert.equal(s.requested(0), true);
  s.update(DT);
  assert.equal(s.get(0, 0), SIG.AMBER, 'after a long green the request is served at once');
  // red for the vehicles: the pedestrians' green comes a moment later, and lasts until the vehicles' red-amber
  for (let t = 0; t < 3.2; t += DT) s.update(DT);
  assert.equal(s.get(0, 0), SIG.RED);
  let p = s.pedestrianChange(0, 0)!;
  assert.equal(p.next, SIG.GREEN);
  assert.ok(p.left <= 1.5);
  for (let t = 0; t < 2; t += DT) s.update(DT);
  assert.equal(s.pedestrian(0, 0), 'green');
  p = s.pedestrianChange(0, 0)!;
  assert.equal(p.next, SIG.RED);
  assert.ok(near(p.left, s.change(0, 0)!.left));
});

test('a tap on a crossing that has just turned green for the vehicles waits for their least green', () => {
  const s = new SignalSystem([crossing()]);
  s.update(DT);
  s.request(0);
  // round once: amber, red, red-amber, green again
  let t = 0;
  while (!(s.get(0, 0) === SIG.GREEN && s.age(0, 0) > 0 && t > 5) && t < 60) {
    s.update(DT);
    s.pedestrian(0, 0);
    t += DT;
  }
  assert.equal(s.get(0, 0), SIG.GREEN);
  for (let k = 0; k < 20; k++) s.update(DT);
  assert.equal(s.skip(0), true);
  const c = s.change(0, 0)!;
  assert.ok(c.left > 5 && c.left <= 8, `served after the least green: ${c.left}`);
});

test('the green arrow: when it comes on and goes out, also after a tap', () => {
  const s = new SignalSystem([junction()]);
  // an arrow beside the light of the main stream: lit while the main stream has red and the cross stream green
  const arm = {} as Arm;
  s.arrows.set(arm, { controller: 0, own: 0, foes: [], friends: [1], state: -1, since: 0 });
  s.update(0);
  let c = s.arrowChange(arm)!;
  assert.equal(c.next, SIG.GREEN);
  // it comes on once the main stream has had red for a moment (and the cross stream has green)
  let t = 0;
  while (s.arrow(arm) !== SIG.GREEN && t < 120) {
    s.update(DT);
    t += DT;
  }
  assert.ok(near(t, c.left, 0.35), `said ${c.left.toFixed(2)} s, came on after ${t.toFixed(2)} s`);
  c = s.arrowChange(arm)!;
  assert.equal(c.next, SIG.AMBER);
  // a tap ends the cross stream's green: the arrow goes out sooner, through its amber
  assert.ok(s.skip(0));
  const sooner = s.arrowChange(arm)!;
  assert.ok(sooner.left < c.left, `${sooner.left} < ${c.left}`);
  t = 0;
  while (s.arrow(arm) === SIG.GREEN && t < 60) {
    s.update(DT);
    t += DT;
  }
  assert.equal(s.arrow(arm), SIG.AMBER);
  assert.ok(near(t, sooner.left, 0.35), `said ${sooner.left.toFixed(2)} s, went out after ${t.toFixed(2)} s`);
  const amber = s.arrowChange(arm)!;
  assert.equal(amber.next, -1);
  assert.ok(amber.left <= 3);
  assert.equal(s.arrowChange({} as Arm), null, 'no arrow, no timer');
});

test('a replay puts a tapped programme back as it was', () => {
  const s = new SignalSystem([junction()]);
  for (let t = 0; t < 10; t += DT) s.update(DT);
  const before = s.snapshot(0, 0, 100);
  s.skip(0);
  for (let t = 0; t < 1; t += DT) s.update(DT);
  const after = s.snapshot(0, 0, 100);
  assert.equal(s.get(0, 0), SIG.AMBER);
  s.restore(before);
  s.update(DT);
  assert.equal(s.get(0, 0), SIG.GREEN, 'back before the tap');
  s.restore(after);
  s.update(DT);
  assert.equal(s.get(0, 0), SIG.AMBER, 'and after it again');
});
