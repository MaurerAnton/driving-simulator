// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The main beam and the rules (§ 17 StVO): dipped in time for a vehicle
 * coming towards one (the tip far off, the fault once it is dazzled), when
 * following closely, for cyclists, not at all on lit streets in town; the
 * lights on in the dark.  And the traffic's own main beam: dipped for the
 * player, flashed back at a player who dazzles.
 *
 *   node --test tests/sim/beams.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BEAM, BeamWatch, TrafficBeams, darkness, relate } from '../../src/sim/beams.ts';
import type { BeamFault, BeamScene, BeamUser } from '../../src/sim/beams.ts';

/** The player at the origin facing north (−z) at 25 m/s with the main beam on, at night on a country road. */
function scene(over: Partial<BeamScene> = {}): BeamScene {
  return { x: 0, z: 0, yaw: 0, speed: 25, low: true, high: true, dark: true, lit: false, cars: [], riders: [], ...over };
}
/** a car `d` m ahead on the oncoming lane (3.5 m to the left), facing south */
const oncomingAt = (d: number, id = 1): BeamUser => ({ id, x: -3.5, z: -d, yaw: Math.PI });
/** a car `d` m ahead in our lane, going our way */
const aheadAt = (d: number, id = 2): BeamUser => ({ id, x: 0, z: -d, yaw: 0 });

/** runs the watch for `seconds` in steps of 0.1 s; every fault found */
function run(w: BeamWatch, s: BeamScene, seconds: number): BeamFault[] {
  const all: BeamFault[] = [];
  for (let t = 0; t < seconds - 1e-9; t += 0.1) all.push(...w.update(0.1, s));
  return all;
}

test('relate: ahead, to the left, coming towards one', () => {
  const r = relate(0, 0, 0, oncomingAt(100));
  assert.ok(Math.abs(r.along - 100) < 1e-9);
  assert.ok(Math.abs(r.side - 3.5) < 1e-9, 'the oncoming lane lies to the left');
  assert.ok(r.facing < -0.99);
  // the same, the player facing east (yaw −π/2): a car 50 m east
  const e = relate(0, 0, -Math.PI / 2, { x: 50, z: 0, yaw: Math.PI / 2 });
  assert.ok(Math.abs(e.along - 50) < 1e-9 && Math.abs(e.side) < 1e-9 && e.facing < -0.99);
});

test('darkness: none by day, full at night', () => {
  assert.equal(darkness(30), 0);
  assert.equal(darkness(-10), 1);
  assert.ok(darkness(1) > 0 && darkness(1) < 1);
});

test('oncoming far off: the tip only, no fault', () => {
  const w = new BeamWatch();
  const f = run(w, scene({ cars: [oncomingAt(350)] }), 5);
  assert.deepEqual(f, []);
  assert.equal(w.tip, 'beam.tipOncoming');
  assert.equal(w.dazzling, -1, 'not dazzled yet: no flash back');
});

test('oncoming within 200 m with the main beam on: dazzled – a fault after the reaction time', () => {
  const w = new BeamWatch();
  assert.deepEqual(run(w, scene({ cars: [oncomingAt(180)] }), 0.5), [], 'not at once');
  const f = run(w, scene({ cars: [oncomingAt(180)] }), 1);
  assert.ok(f.some((x) => x.id === 'dazzleOncoming'));
  assert.equal(w.dazzling, 1);
});

test('oncoming within 200 m, dipped: nothing', () => {
  const w = new BeamWatch();
  assert.deepEqual(run(w, scene({ high: false, cars: [oncomingAt(150)] }), 3), []);
  assert.equal(w.tip, null);
});

test('oncoming behind a hill crest (out of sight): not dazzled', () => {
  const w = new BeamWatch();
  assert.deepEqual(run(w, scene({ cars: [oncomingAt(150)], sees: () => false }), 3), []);
});

test('a car going away, or one far to the side: not oncoming', () => {
  const w = new BeamWatch();
  const away = { id: 3, x: -3.5, z: -150, yaw: 0 };
  const aside = { id: 4, x: -120, z: -150, yaw: Math.PI };
  const behind = { id: 5, x: -3.5, z: 150, yaw: Math.PI };
  assert.deepEqual(run(w, scene({ cars: [away, aside, behind] }), 3).filter((f) => f.id === 'dazzleOncoming'), []);
});

test('following closely with the main beam: tip at 150 m, fault after a while within 80 m', () => {
  const w = new BeamWatch();
  assert.deepEqual(run(w, scene({ cars: [aheadAt(120)] }), 5), []);
  assert.equal(w.tip, 'beam.tipAhead');
  const w2 = new BeamWatch();
  assert.deepEqual(run(w2, scene({ cars: [aheadAt(60)] }), 2), [], 'not at once');
  assert.ok(run(w2, scene({ cars: [aheadAt(60)] }), 2).some((x) => x.id === 'dazzleAhead'));
});

test('a cyclist coming towards one: dip for him too', () => {
  const w = new BeamWatch();
  const f = run(w, scene({ riders: [{ id: 9, x: -1.5, z: -80, yaw: Math.PI }] }), 2);
  assert.ok(f.some((x) => x.id === 'dazzleRider'));
});

test('main beam on a lit street in town: a hint after a few seconds', () => {
  const w = new BeamWatch();
  assert.deepEqual(run(w, scene({ lit: true, speed: 13 }), 3), []);
  assert.equal(w.tip, 'beam.tipLit');
  const f = run(w, scene({ lit: true, speed: 13 }), 3);
  assert.ok(f.some((x) => x.id === 'beamLit' && x.severity === 'hint'));
});

test('by day the main beam counts for nothing', () => {
  const w = new BeamWatch();
  assert.deepEqual(run(w, scene({ dark: false, lit: true, cars: [oncomingAt(100), aheadAt(40)] }), 5), []);
  assert.equal(w.tip, null);
});

test('no lights in the dark: tip at once, fault while driving on', () => {
  const w = new BeamWatch();
  assert.deepEqual(run(w, scene({ low: false, high: false }), 2), []);
  assert.equal(w.tip, 'beam.tipLightsOn');
  assert.ok(run(w, scene({ low: false, high: false }), 3).some((x) => x.id === 'noLights' && x.severity === 'major'));
  // standing still (parked) is not driving; in fog by day the lights are required too
  assert.deepEqual(run(new BeamWatch(), scene({ low: false, high: false, speed: 0 }), 6), []);
  assert.ok(run(new BeamWatch(), scene({ low: false, high: false, dark: false, poorSight: true }), 6).some((x) => x.id === 'noLights'));
});

test('the assist: main beam on the empty country road, off for oncoming traffic and in town', () => {
  const w = new BeamWatch();
  w.update(0.1, scene({ high: false }));
  assert.equal(w.assistHigh, true);
  w.update(0.1, scene({ high: false, cars: [oncomingAt(380)] }));
  assert.equal(w.assistHigh, false);
  w.update(0.1, scene({ high: false, lit: true }));
  assert.equal(w.assistHigh, false);
  w.update(0.1, scene({ high: false, speed: 5 }));
  assert.equal(w.assistHigh, false, 'slow: no main beam');
});

test('the traffic: main beam on the empty road, dipped in time for the player, flashed back when dazzled', () => {
  const tb = new TrafficBeams();
  const id = 10; // a driver who dips in good time (not one of the late ones)
  assert.ok(TrafficBeams.dipDistance(id) >= BEAM.ONCOMING_FAULT + 100);
  const car = { id, x: 0, z: -1000, yaw: Math.PI, v: 25, rural: true };
  const step = (player: { id: number; x: number; z: number; yaw: number; high: boolean } | null, dazzling = -1, secs = 3): void => {
    for (let t = 0; t < secs; t += 0.1) tb.update(0.1, [car], player, dazzling, true);
  };
  step(null);
  assert.equal(tb.high(id), true, 'nobody near: main beam');
  // the player 300 m off, coming towards it: it dips
  step({ id: -1, x: -3.5, z: -700, yaw: 0, high: false });
  assert.equal(tb.high(id), false);
  assert.equal(tb.glare, 0);
  // the player dazzles it: it flashes back after a second
  const p = { id: -1, x: -3.5, z: -850, yaw: 0, high: true };
  step(p, id, 0.5);
  assert.equal(tb.flashing(id), false);
  step(p, id, 0.7);
  assert.equal(tb.flashing(id), true);
  assert.equal(tb.high(id), true, 'the flash lights the main beam');
  assert.ok(tb.glare > 0, 'the player sees the flash');
  // in town, or by day: never
  const town = new TrafficBeams();
  for (let t = 0; t < 3; t += 0.1) town.update(0.1, [{ ...car, rural: false }], null, -1, true);
  assert.equal(town.high(id), false);
  const day = new TrafficBeams();
  for (let t = 0; t < 3; t += 0.1) day.update(0.1, [car], null, -1, false);
  assert.equal(day.high(id), false);
});
