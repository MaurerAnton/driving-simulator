// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The wipers and the windscreen: the stalk's places, the motor that parks
 * before it stops, intermittent sweeps and the washer's sweeps after it is
 * let go; rain, snow and dirt building up on the glass, and the blades
 * clearing what they pass over (wet: clean; dry: smeared).
 *
 *   node --test tests/game/wipers.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { INTERVAL_PAUSE, SWEEP_SECONDS, WIPER_MODES, Windscreen, Wipers, nextWiperMode, sweepAt, tandemArms } from '../../src/game/wipers.ts';
import type { ScreenWeather } from '../../src/game/wipers.ts';

const DRY: ScreenWeather = { rain: 0, snow: 0, temperature: 10, roadWet: 0, speed: 0, crossWind: 0, heater: false };
const RAIN: ScreenWeather = { ...DRY, rain: 1, roadWet: 1 };
const SNOW: ScreenWeather = { ...DRY, snow: 1, temperature: -3 };

function run(fn: (dt: number) => void, seconds: number, dt = 1 / 30): void {
  for (let t = 0; t < seconds; t += dt) fn(dt);
}

test('the stalk goes round its four places', () => {
  assert.deepEqual(WIPER_MODES, ['off', 'intermittent', 'normal', 'fast']);
  assert.equal(nextWiperMode('off'), 'intermittent');
  assert.equal(nextWiperMode('fast'), 'off');
  const w = new Wipers();
  assert.equal(w.cycle(), 'intermittent');
  assert.equal(w.cycle(), 'normal');
  assert.equal(w.cycle(), 'fast');
  assert.equal(w.cycle(), 'off');
});

test('a sweep goes up to the far end and back', () => {
  assert.equal(sweepAt(0), 0);
  assert.ok(Math.abs(sweepAt(0.5) - 1) < 1e-9);
  assert.ok(sweepAt(0.99) < 0.01);
});

test('off: the blades stay parked; switched off mid-sweep they finish it first', () => {
  const w = new Wipers();
  run((dt) => w.step(dt, false), 3);
  assert.equal(w.phase, 0);
  assert.equal(w.swept.any, false);
  w.set('normal');
  run((dt) => w.step(dt, false), SWEEP_SECONDS.normal * 0.3);
  assert.ok(w.running);
  w.set('off');
  w.step(0.01, false);
  assert.ok(w.running, 'still on its way back');
  run((dt) => w.step(dt, false), SWEEP_SECONDS.normal);
  assert.equal(w.phase, 0);
  assert.equal(w.running, false);
});

test('fast sweeps more often than normal; the far end is reached on each sweep', () => {
  const count = (mode: 'normal' | 'fast'): number => {
    const w = new Wipers();
    w.set(mode);
    let sweeps = 0;
    let top = 0;
    run((dt) => {
      const before = w.phase;
      w.step(dt, false);
      top = Math.max(top, w.swept.hi);
      if (w.phase < before) {
        // a sweep is done: it went all the way up
        assert.equal(top, 1);
        top = 0;
        sweeps++;
      }
    }, 10);
    return sweeps;
  };
  const n = count('normal');
  const f = count('fast');
  assert.ok(n >= 7 && n <= 9, `normal ${n}`);
  assert.ok(f > n + 3, `fast ${f}`);
});

test('intermittent: one sweep, then a pause', () => {
  const w = new Wipers();
  w.set('intermittent');
  let starts = 0;
  let was = false;
  run((dt) => {
    w.step(dt, false);
    if (w.running && !was) starts++;
    was = w.running;
  }, 2 * (SWEEP_SECONDS.normal + INTERVAL_PAUSE) + 0.5);
  assert.equal(starts, 3);
});

test('the washer runs the wipers while held and for two sweeps after', () => {
  const w = new Wipers();
  run((dt) => w.step(dt, true), 0.5);
  assert.ok(w.running);
  let parkedAt = -1;
  let t = 0;
  run((dt) => {
    t += dt;
    w.step(dt, false);
    if (parkedAt < 0 && !w.running) parkedAt = t;
  }, 6);
  assert.ok(parkedAt > SWEEP_SECONDS.normal * 1.5 && parkedAt < SWEEP_SECONDS.normal * 3.2, `parked after ${parkedAt}`);
});

test('the blades reach the driver\'s view but not the top corners', () => {
  const s = new Windscreen(1.3, 0.85);
  assert.equal(tandemArms(1.3, 0.85).length, 2);
  assert.ok(s.wiped(s.cellAt(0.4, 0.45)), 'in front of the driver');
  assert.ok(s.wiped(s.cellAt(0.95, 0.35)), 'the right side');
  assert.ok(!s.wiped(s.cellAt(1.29, 0.84)), 'the top right corner');
});

test('rain builds up into a sheet of water that blurs the view; the wipers keep it clear', () => {
  const s = new Windscreen(1.3, 0.85);
  run((dt) => s.step(dt, RAIN), 30);
  const k = s.cellAt(0.4, 0.45);
  assert.ok(s.drops[k] > 0.9, `drops ${s.drops[k]}`);
  assert.ok(s.film[k] > 0.6, `film ${s.film[k]}`);
  assert.ok(s.obscured() > 0.5, `obscured ${s.obscured()}`);
  s.wipers.set('normal');
  run((dt) => s.step(dt, RAIN), 5);
  // (between two sweeps a little rain lies again)
  assert.ok(s.obscured() < 0.25, `obscured with wipers ${s.obscured()}`);
  assert.ok(s.film[k] < 0.2);
});

test('driving fast catches more rain and makes the drops run', () => {
  const a = new Windscreen(1.3, 0.85);
  const b = new Windscreen(1.3, 0.85);
  run((dt) => a.step(dt, { ...RAIN, rain: 0.3 }), 5);
  run((dt) => b.step(dt, { ...RAIN, rain: 0.3, speed: 30, crossWind: 4 }), 5);
  assert.ok(b.drops[0] > a.drops[0]);
  assert.equal(a.running, 0);
  assert.ok(b.running > 0.9);
  assert.ok(b.flow.y > 1, `ran up ${b.flow.y} m`);
  assert.ok(b.flow.x > 0);
});

test('snow builds up white unless wiped; it melts above freezing', () => {
  const s = new Windscreen(1.3, 0.85);
  run((dt) => s.step(dt, SNOW), 90);
  assert.ok(s.obscured() > 0.85, `snow cover ${s.obscured()}`);
  const k = s.cellAt(0.4, 0.45);
  s.wipers.set('fast');
  run((dt) => s.step(dt, SNOW), 2);
  assert.ok(s.snow[k] < 0.15, `wiped ${s.snow[k]}`);
  // the corner the blades miss stays white
  const c = s.cellAt(1.29, 0.84);
  assert.ok(s.snow[c] > 0.85);
  s.wipers.set('off');
  run((dt) => s.step(dt, { ...DRY, temperature: 8 }), 60);
  assert.ok(s.snow[c] < 0.2, `melted ${s.snow[c]}`);
});

test('dirt: wiped dry it smears, washed it goes', () => {
  const s = new Windscreen(1.3, 0.85);
  const k = s.cellAt(0.4, 0.45);
  s.dirt.fill(0.5);
  s.wipe(0, 1);
  assert.ok(s.smear[k] > 0.1, 'smeared');
  assert.equal(s.dirt[k], 0.5);
  // the washer held for a second, then its sweeps
  run((dt) => s.step(dt, DRY, true), 1);
  run((dt) => s.step(dt, DRY), 4);
  assert.ok(s.dirt[k] < 0.1, `dirt ${s.dirt[k]}`);
  assert.ok(s.smear[k] < 0.05, `smear ${s.smear[k]}`);
  assert.ok(s.film[k] < 0.2, 'and the washer\'s water wiped off');
});

test('the spray of a wet road dirties the glass slowly', () => {
  const s = new Windscreen(1.3, 0.85);
  run((dt) => s.step(dt, { ...DRY, roadWet: 1, speed: 20 }), 120);
  assert.ok(s.dirt[0] > 0.1 && s.dirt[0] < 0.4, `dirt ${s.dirt[0]}`);
});
