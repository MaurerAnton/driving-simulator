// SPDX-License-Identifier: AGPL-3.0-only
/**
 * On foot in the town: the pedestrian light that waits for its button, the
 * poles it stands on, the cars that stop at a zebra crossing for somebody
 * who wants to cross, and walking (and running) without a vehicle.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { OnFoot, WALK } from '../../src/game/onfoot.ts';
import { SIG, SignalSystem } from '../../src/sim/signals.ts';
import { Traffic } from '../../src/sim/traffic.ts';
import type { PlayerState } from '../../src/sim/traffic.ts';
import { pedPoles, poleInReach } from '../../src/world/pedlights.ts';
import { XING } from '../../src/world/types.ts';
import { makeTown } from './town.ts';

const DT = 1 / 30;

test('a pedestrian light rests on green for the vehicles until its button is pressed – then the people get green', () => {
  const town = makeTown({ cols: 2, rows: 1, block: 300, pavement: 2, crossings: [{ street: [0, 0, 1, 0], at: 0.5, k: XING.SIGNAL }] });
  const signals = new SignalSystem(town.world.signals);
  const sc = town.world.crossings[0].sc!;
  for (let t = 0; t < 200; t += 0.1) signals.update(0.1);
  assert.equal(signals.get(sc, 0), SIG.GREEN, 'nobody pressed: the vehicles keep green');
  assert.equal(signals.pedestrian(sc, 0), 'red');
  assert.equal(signals.request(sc), true);
  assert.equal(signals.request(sc), false, 'pressed twice is pressed once');
  assert.equal(signals.requested(sc), true, '"Signal kommt"');
  let waited = 0;
  while (signals.pedestrian(sc, 0) !== 'green' && waited < 30) {
    signals.update(0.1);
    waited += 0.1;
  }
  assert.ok(waited > 3 && waited < 8, `green for the people ${waited.toFixed(1)} s after the press (amber, then red for the vehicles)`);
  assert.equal(signals.requested(sc), false, 'the lamp goes out when the people get green');
  let green = 0;
  while (signals.pedestrian(sc, 0) === 'green') {
    signals.update(0.1);
    green += 0.1;
  }
  assert.ok(green > 9 && green < 14, `${green.toFixed(1)} s to cross`);
  for (let t = 0; t < 5; t += 0.1) signals.update(0.1);
  assert.equal(signals.get(sc, 0), SIG.GREEN, 'back to rest');
  assert.equal(signals.requested(sc), false);
  for (let t = 0; t < 60; t += 0.1) signals.update(0.1);
  assert.equal(signals.pedestrian(sc, 0), 'red', 'nobody pressed again: no green for nobody');
});

test('pressed again just after the green: the request waits, and the people get green once the vehicles have had theirs', () => {
  const town = makeTown({ cols: 2, rows: 1, block: 300, pavement: 2, crossings: [{ street: [0, 0, 1, 0], at: 0.5, k: XING.SIGNAL }] });
  const signals = new SignalSystem(town.world.signals);
  const sc = town.world.crossings[0].sc!;
  for (let t = 0; t < 30; t += 0.1) signals.update(0.1);
  signals.request(sc);
  while (signals.pedestrian(sc, 0) !== 'green') signals.update(0.1);
  while (signals.pedestrian(sc, 0) === 'green') signals.update(0.1);
  // (the people's red, the vehicles not yet green: somebody comes too late and presses)
  assert.notEqual(signals.get(sc, 0), SIG.GREEN);
  assert.equal(signals.request(sc), true);
  let vehiclesGreen = 0;
  let waited = 0;
  while (signals.pedestrian(sc, 0) !== 'green' && waited < 60) {
    signals.update(0.1);
    waited += 0.1;
    if (signals.get(sc, 0) === SIG.GREEN) vehiclesGreen += 0.1;
  }
  assert.equal(signals.pedestrian(sc, 0), 'green', 'the request was kept');
  assert.ok(vehiclesGreen >= 7.9, `the vehicles had their green first (${vehiclesGreen.toFixed(1)} s)`);
});

test('the poles of a pedestrian light: one on each kerb, the head looking across the road, the button within reach', () => {
  const town = makeTown({ cols: 2, rows: 1, block: 300, pavement: 2, crossings: [{ street: [0, 0, 1, 0], at: 0.5, k: XING.SIGNAL }] });
  const poles = pedPoles(town.world);
  assert.equal(poles.length, 2);
  // the street runs east–west at z = 0: the poles stand north and south of it, beside the stripes at x = 150
  const [a, b] = poles;
  assert.ok(Math.sign(a.z) !== Math.sign(b.z) && Math.abs(a.z) > 2.5 && Math.abs(a.z) < 4, `on the kerbs (${a.z.toFixed(1)}, ${b.z.toFixed(1)})`);
  assert.ok(Math.abs(a.x - 150) < 4 && Math.abs(b.x - 150) < 4);
  for (const p of poles) {
    // facing across: towards the other kerb
    const fz = -Math.cos(p.yaw);
    assert.ok(fz * -Math.sign(p.z) > 0.9, 'the head faces the other side');
  }
  assert.equal(poleInReach(poles, a.x + 0.8, a.z), a);
  assert.equal(poleInReach(poles, 150, 0), null, 'not from the middle of the road');
});

/** The traffic on a long street with a zebra crossing in the middle, and somebody on foot at a place. */
function zebraRun(where: { x: number; z: number; yaw: number } | null): { passed: number; seen: number } {
  const town = makeTown({ cols: 2, rows: 1, block: 500, pavement: 2, crossings: [{ street: [0, 0, 1, 0], at: 0.5, k: XING.ZEBRA }] });
  const signals = new SignalSystem(town.world.signals);
  const traffic = new Traffic(town.world, town.lanes, signals);
  traffic.targetCount = 6;
  const zx = 250;
  const player: PlayerState = { x: where?.x ?? zx, y: 100, z: where?.z ?? 40, yaw: where?.yaw ?? 0, speed: 0, length: 0.6, width: 0.6, onFoot: true };
  let passed = 0;
  let seen = 0;
  const last = new Map<number, number>();
  for (let t = 0; t < 120; t += DT) {
    traffic.update(DT, player);
    for (const c of traffic.cars) {
      if (Math.abs(c.x - zx) < 60) seen++;
      const before = last.get(c.id);
      // over the stripes: from one side of x = 250 to the other
      if (before !== undefined && Math.sign(before - zx) !== Math.sign(c.x - zx) && Math.abs(c.x - zx) < 5) passed++;
      last.set(c.id, c.x);
    }
  }
  return { passed, seen };
}

test('the cars stop at a zebra crossing for somebody standing on it, and for somebody at its kerb looking across', () => {
  const on = zebraRun({ x: 250, z: 0.5, yaw: 0 });
  assert.ok(on.seen > 0, 'cars came by');
  assert.equal(on.passed, 0, 'nobody drove over the person on the stripes');
  // at the kerb (north side, z = -3.6), looking south across the road (yaw π)
  const kerb = zebraRun({ x: 250, z: -3.6, yaw: Math.PI });
  assert.equal(kerb.passed, 0, 'about to cross: the cars wait');
  // on the pavement a few metres off, looking along the road: nobody to wait for
  const away = zebraRun({ x: 262, z: -3.6, yaw: Math.PI / 2 });
  assert.ok(away.passed > 0, `the cars go on (${away.passed} over the stripes)`);
});

test('on foot without a vehicle: anywhere, at walking pace or at the running speed the settings give', () => {
  const ground = (): number => 100;
  const free = (): boolean => false;
  const w = new OnFoot(null, { x: 0, y: 100, z: 0, yaw: 0 });
  w.runSpeed = 15 / 3.6;
  for (let t = 0; t < 60; t += DT) w.update(DT, { fwd: 1, turn: 0, run: false }, { yaw: 0, pitch: 0, right: 0, fwd: 0 }, ground, free);
  assert.ok(Math.abs(-w.z - WALK * 60) < 1, `walked north ${(-w.z).toFixed(1)} m in a minute`);
  assert.ok(!w.tooFar, 'nothing to stay near');
  const z0 = w.z;
  for (let t = 0; t < 10; t += DT) w.update(DT, { fwd: 1, turn: 0, run: true }, { yaw: 0, pitch: 0, right: 0, fwd: 0 }, ground, free);
  assert.ok(Math.abs(z0 - w.z - (15 / 3.6) * 10) < 0.5, `ran ${(z0 - w.z).toFixed(1)} m in ten seconds at 15 km/h`);
  assert.ok(w.running && Math.abs(w.speed * 3.6 - 15) < 0.2);
});
