// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Driving through water: the depth from the shore, the wash, the wet
 * brakes, the stalled engine and the spray (game/wading.ts).
 *
 *   node --test tests/game/water.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEEP_WATER, Wading, WaterDepth, bedDepth, brakeFactor, dryRate, intakeHeight, sprayRate, washRate, wetsBrakes } from '../../src/game/wading.ts';
import type { WadingVehicle } from '../../src/game/wading.ts';
import { WATER_DROP } from '../../src/render/water.ts';
import { COVER } from '../../src/world/cover.ts';

/** a river 30 m wide along x, from z = 0 to z = 30 */
const river = { coverAt: (_x: number, z: number) => (z >= 0 && z < 30 ? COVER.WATER : COVER.MEADOW) };

test('the bed: the drop at the edge, sloping down, no deeper than DEEP_WATER', () => {
  assert.equal(bedDepth(0), WATER_DROP);
  assert.ok(bedDepth(2) > bedDepth(1));
  assert.equal(bedDepth(1000), DEEP_WATER);
  assert.equal(bedDepth(-5), WATER_DROP);
});

test('the depth of a river: 0 on land, shallow at the edge, deep in the middle, without steps', () => {
  const d = new WaterDepth(river);
  assert.equal(d.at(5, -1), 0);
  const edge = d.at(5, 0.5);
  const mid = d.at(5, 15);
  assert.ok(edge >= WATER_DROP && edge < 0.5, `edge ${edge}`);
  assert.equal(mid, DEEP_WATER);
  // deeper going in, and no jump from one 10 cm to the next
  let last = d.at(5, 0.05);
  for (let z = 0.15; z < 15; z += 0.1) {
    const y = d.at(5, z);
    assert.ok(y >= last - 1e-9, `deeper at ${z}`);
    assert.ok(y - last < 0.06, `a step at ${z}: ${last} → ${y}`);
    last = y;
  }
  // the same from the other bank
  assert.ok(Math.abs(d.at(5, 29.5) - edge) < 0.2);
});

test('the wash: more with speed and with depth, none out of the water', () => {
  assert.equal(washRate(10, 0), 0);
  assert.ok(washRate(0, 0.3) > 0);
  assert.ok(washRate(10, 0.3) > washRate(3, 0.3));
  assert.ok(washRate(5, 0.4) > washRate(5, 0.1));
  // a very dirty car through a ford at 30 km/h: clean within a few seconds
  assert.ok(1 / washRate(8.3, 0.3) < 6);
});

test('wet brakes: weaker, dried by braking', () => {
  assert.equal(brakeFactor(0), 1);
  assert.ok(brakeFactor(1) < 0.7 && brakeFactor(1) > 0.5);
  assert.ok(dryRate(15, 1) > 10 * dryRate(15, 0));
  assert.ok(wetsBrakes(0.1, 5));
  assert.ok(!wetsBrakes(0.1, 0.5));
  assert.ok(wetsBrakes(0.4, 0));
});

test('the air intake: a car before a truck, a tractor high', () => {
  assert.ok(intakeHeight('car') < intakeHeight('truck'));
  assert.ok(intakeHeight('motorcycle') <= intakeHeight('car'));
  assert.ok(intakeHeight('tractor') > intakeHeight('car'));
  assert.ok(intakeHeight('something new') > 0);
});

test('the spray: none standing still, more with speed', () => {
  assert.equal(sprayRate(0, 0.3), 0);
  assert.equal(sprayRate(10, 0), 0);
  assert.ok(sprayRate(10, 0.3) > sprayRate(2, 0.3));
});

/** a car standing (or moving) at z with its wheels 1.4 m apart across and 2.6 m along */
function carAt(z: number, speed: number): WadingVehicle & { stalled: number } {
  const v = {
    pos: [5, 0, z],
    speed,
    yaw: 0,
    engineRunning: true,
    stalled: 0,
    spec: { wheelRadius: 0.3 },
    wheels: [
      { hx: 4.3, hy: 0.3, hz: z - 1.3, contact: true },
      { hx: 5.7, hy: 0.3, hz: z - 1.3, contact: true },
      { hx: 4.3, hy: 0.3, hz: z + 1.3, contact: true },
      { hx: 5.7, hy: 0.3, hz: z + 1.3, contact: true },
    ],
    resetDrivetrain(on: boolean) {
      v.engineRunning = on;
      if (!on) v.stalled++;
    },
  };
  return v;
}

test('wading: washed in the shallows, the engine stalls in deep water, the brakes stay wet a while', () => {
  const w = new Wading(river);
  const dirt = { dirt: 1 };
  // the rear wheels in the shallow edge, at speed: washed, wet brakes, spray – the engine runs on
  const shallow = carAt(-0.8, 6);
  for (let i = 0; i < 30; i++) assert.equal(w.step(0.05, shallow, 'car', dirt, 0, true), null);
  assert.ok(dirt.dirt < 0.9, `dirt ${dirt.dirt}`);
  assert.equal(shallow.engineRunning, true);
  assert.equal(w.wet, 1);
  assert.ok(w.brakeFactor < 1);
  assert.ok(w.spray.count > 0);
  // out of the water, braking: told once, then dried
  const dry = carAt(-10, 10);
  let told = 0;
  for (let i = 0; i < 200; i++) if (w.step(0.05, dry, 'car', dirt, 1, true) === 'wetBrakes') told++;
  assert.equal(told, 1);
  assert.ok(w.wet < 0.2, `wet ${w.wet}`);
  // into the middle: the engine stalls, a tip says why
  const deep = carAt(15, 2);
  assert.equal(w.step(0.05, deep, 'car', dirt, 0, true), 'waterStalled');
  assert.equal(deep.engineRunning, false);
  // without effects (the low preset): no spray, but the wash all the same
  const w2 = new Wading(river);
  const d2 = { dirt: 1 };
  w2.step(0.5, carAt(-0.8, 6), 'car', d2, 0, false);
  assert.equal(w2.spray.count, 0);
  assert.ok(d2.dirt < 1);
});
