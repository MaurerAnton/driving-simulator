// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Arcade driving and the road physics switched off: D and R by the pedals,
 * the vehicle held at a standstill (on a hill too), the engine started by
 * itself – every surface gripping as dry asphalt – and "Reset settings"
 * keeping the language.
 *
 *   node --test tests/game/arcadedrive.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCADE_STILL, ARCADE_SWITCH, ArcadeDrive, arcadeTransmission } from '../../src/game/arcadedrive.ts';
import { COMPACT_CAR_AUTOMATIC } from '../../src/sim/vehicle/index.ts';
import type { DriverInput } from '../../src/sim/vehicle/index.ts';
import { DT, PlaneGround, input, makeCar } from '../vehicle/harness.ts';
import { WorldGround } from '../../src/sim/ground.ts';
import type { World } from '../../src/world/world.ts';
import { COVER } from '../../src/world/cover.ts';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, loadSettings, resetSettings } from '../../src/game/settings.ts';

test('the right pedal drives forwards, the left one brakes', () => {
  const a = new ArcadeDrive();
  const d = input();
  a.step(0.8, 0, 5, 0.1, d);
  assert.deepEqual([d.throttle, d.brake, d.gear, d.handbrake, d.clutch, d.ignition], [0.8, 0, 1, 0, 0, true]);
  a.step(0, 0.6, 5, 0.1, d);
  assert.deepEqual([d.throttle, d.brake, d.gear], [0, 0.6, 1]);
  // (the limiter's cap on the right pedal)
  a.step(1, 0, 5, 0.1, d, 0.3);
  assert.equal(d.throttle, 0.3);
});

test('standing, the left pedal held a moment puts it in reverse – and the right one back into D', () => {
  const a = new ArcadeDrive();
  const d = input();
  // moving: the left pedal only brakes, however long
  for (let t = 0; t < 2; t += 0.05) a.step(0, 1, 3, 0.05, d);
  assert.equal(a.dir, 1);
  // standing: held for less than the moment – still D, held where it is
  a.step(0, 1, 0, ARCADE_SWITCH / 2, d);
  assert.equal(a.dir, 1);
  assert.deepEqual([d.handbrake, d.brake], [1, 1]);
  a.step(0, 1, 0, ARCADE_SWITCH / 2 + 0.01, d);
  assert.equal(a.dir, -1);
  // reverse: the left pedal drives (backwards), the right one brakes
  assert.deepEqual([d.gear, d.throttle, d.brake, d.handbrake], [-1, 1, 0, 0]);
  a.step(0.7, 0, -2, 0.1, d);
  assert.deepEqual([d.gear, d.throttle, d.brake], [-1, 0, 0.7]);
  // standing again, the right pedal held: forwards
  a.step(1, 0, -ARCADE_STILL / 2, ARCADE_SWITCH + 0.01, d);
  assert.equal(a.dir, 1);
  assert.deepEqual([d.gear, d.throttle], [1, 1]);
  a.reset();
  assert.equal(a.dir, 1);
});

test('no pedal at a standstill: held; the engine is started when it stands still', () => {
  const a = new ArcadeDrive();
  const d = input();
  a.step(0, 0, 0, 0.1, d, 1, false);
  assert.equal(d.handbrake, 1);
  assert.equal(d.starter, true);
  a.step(0.5, 0, 0, 0.1, d, 1, true);
  assert.equal(d.handbrake, 0);
  assert.equal(d.starter, false);
  assert.equal(arcadeTransmission(true, 'manual'), 'automatic');
  assert.equal(arcadeTransmission(false, 'manual'), 'manual');
});

/** A car with the automatic gearbox driven the arcade way for `seconds`, by the pedals `pedals(t)`. */
function arcadeRun(ground: PlaneGround, seconds: number, pedals: (t: number) => [number, number]): { v: ReturnType<typeof makeCar>; a: ArcadeDrive; z0: number } {
  const v = makeCar(ground, COMPACT_CAR_AUTOMATIC, false);
  const z0 = v.pos[2];
  const a = new ArcadeDrive();
  const d: DriverInput = input({ ignition: false });
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const [thr, brk] = pedals(i * DT);
    a.step(thr, brk, v.speed, DT, d, 1, v.engineRunning);
    v.step(DT, d);
  }
  return { v, a, z0 };
}

test('the car on a 12 % hill stays where it is with no pedal, and starts its engine by itself', () => {
  const { v, z0 } = arcadeRun(new PlaneGround(0.12), 6, () => [0, 0]);
  assert.equal(v.engineRunning, true);
  assert.ok(Math.abs(v.pos[2] - z0) < 0.15, `rolled ${(v.pos[2] - z0).toFixed(2)} m`);
  assert.ok(Math.abs(v.speed) < 0.05);
});

test('the car drives off forwards, stops, and backs away with the left pedal held', () => {
  // 0–4 s right pedal, 4–8 s left pedal (brakes, then reverses)
  const { v, a } = arcadeRun(new PlaneGround(0), 9, (t) => (t < 4 ? [0.6, 0] : [0, 0.7]));
  assert.equal(a.dir, -1);
  assert.ok(v.speed < -1, `speed ${v.speed.toFixed(2)} m/s`);
});

test('the road physics switched off: every surface, in any weather, grips as dry asphalt', () => {
  const world = { surfaceAt: () => false } as unknown as World;
  const g = new WorldGround(world, { heightAt: () => 0, coverAt: () => COVER.FARMLAND });
  g.weatherGrip = 0.4;
  const out = { y: 0, nx: 0, ny: 1, nz: 0, grip: 1, rolling: 1 };
  g.sample(0, 0, 0, out);
  assert.ok(out.grip < 0.3 && out.rolling > 1, 'a wet field: little grip, heavy rolling');
  g.even = true;
  g.sample(0, 0, 0, out);
  assert.deepEqual([out.grip, out.rolling], [1, 1]);
});

test('arcade driving is off by default, the even grip on (1.7.1); "Reset settings" keeps the language and the keys', () => {
  const m = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) },
  });
  assert.equal(DEFAULT_SETTINGS.arcadeDrive, false);
  assert.equal(DEFAULT_SETTINGS.evenRoads, true);
  m.set('fahrsim-baunatal.settings.v2', JSON.stringify({ version: SETTINGS_VERSION, arcadeDrive: 'yes', evenRoads: false }));
  const s = loadSettings();
  assert.equal(s.arcadeDrive, false, 'implausible: the default');
  assert.equal(s.evenRoads, false, 'chosen since 1.7.1: kept');
  s.lang = 'de';
  s.fuelKey = 'key';
  s.limiter = false;
  s.traffic = 0.1;
  s.graphics.water = !DEFAULT_SETTINGS.graphics.water;
  const r = resetSettings(s);
  assert.equal(r.lang, 'de');
  assert.equal(r.fuelKey, 'key');
  assert.equal(r.limiter, DEFAULT_SETTINGS.limiter);
  assert.equal(r.traffic, DEFAULT_SETTINGS.traffic);
  assert.equal(r.evenRoads, DEFAULT_SETTINGS.evenRoads);
  assert.equal(r.graphics.water, DEFAULT_SETTINGS.graphics.water);
  // (the defaults themselves are not touched)
  r.graphics.water = !r.graphics.water;
  assert.notEqual(r.graphics.water, DEFAULT_SETTINGS.graphics.water);
});
