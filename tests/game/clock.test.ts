// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The game's clock: the real time unless the arcade mode sets another
 * moment or lets it run faster – and where the sun stands at a moment.
 *
 *   node --test tests/game/clock.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GameClock, MAX_RATE, seasonOf, sunAt } from '../../src/game/clock.ts';

test('the clock is the real one until the arcade mode changes it', () => {
  let real = Date.UTC(2026, 10, 16, 12, 0, 0);
  const c = new GameClock(() => real);
  assert.equal(c.real, true);
  assert.equal(c.ms(), real);
  c.tick(10);
  assert.equal(c.ms(), real, 'the real clock is not moved by the frames');
  real += 5000;
  assert.equal(c.ms(), real);
});

test('run faster: the time goes on rate times as fast, and back at 1× it is the real time again', () => {
  let real = Date.UTC(2026, 10, 16, 12, 0, 0);
  const c = new GameClock(() => real);
  c.setRate(4);
  assert.equal(c.real, false);
  assert.equal(c.rate, 4);
  c.tick(40);
  assert.equal(c.ms() - real, 40000, 'the world went on by what was simulated (10 s of frames at 4×)');
  real += 10000;
  c.setRate(1);
  assert.equal(c.real, true, 'only sped up: back to the real time (the timetables catch up)');
  assert.equal(c.ms(), real);
  c.setRate(100);
  assert.equal(c.rate, MAX_RATE);
});

test('another moment chosen: it runs on from there, also after running faster', () => {
  const real = Date.UTC(2026, 10, 16, 12, 0, 0);
  const c = new GameClock(() => real);
  const evening = Date.UTC(2026, 10, 20, 17, 30, 0);
  c.set(evening);
  assert.equal(c.travelled, true);
  c.tick(60);
  assert.equal(c.ms(), evening + 60000);
  c.setRate(2);
  c.tick(60);
  c.setRate(1);
  assert.equal(c.real, false, 'a chosen moment stays');
  assert.equal(c.ms(), evening + 120000);
  c.reset();
  assert.equal(c.real, true);
  assert.equal(c.travelled, false);
  assert.equal(c.ms(), real);
});

test('the sun over northern Hesse: high at midsummer noon, low at midwinter noon, below the horizon at midnight', () => {
  // solar noon there is about 11:22 UTC
  const summer = sunAt(Date.UTC(2026, 5, 21, 11, 22));
  assert.ok(Math.abs(summer.elevation - 62.1) < 1, `midsummer noon ${summer.elevation.toFixed(1)}°`);
  assert.ok(Math.abs(summer.azimuth - 180) < 5, `due south ${summer.azimuth.toFixed(1)}°`);
  const winter = sunAt(Date.UTC(2026, 11, 21, 11, 30));
  assert.ok(Math.abs(winter.elevation - 15.3) < 1, `midwinter noon ${winter.elevation.toFixed(1)}°`);
  const night = sunAt(Date.UTC(2026, 10, 16, 23, 0));
  assert.ok(night.elevation < -30, `midnight ${night.elevation.toFixed(1)}°`);
  const morning = sunAt(Date.UTC(2026, 5, 21, 4, 0));
  assert.ok(morning.azimuth > 45 && morning.azimuth < 90, `the morning sun stands in the north-east (${morning.azimuth.toFixed(1)}°)`);
});

test('the seasons by the months', () => {
  assert.equal(seasonOf(new Date(2026, 0, 15)), 'winter');
  assert.equal(seasonOf(new Date(2026, 3, 15)), 'spring');
  assert.equal(seasonOf(new Date(2026, 6, 15)), 'summer');
  assert.equal(seasonOf(new Date(2026, 9, 15)), 'autumn');
  assert.equal(seasonOf(new Date(2026, 11, 1)), 'winter');
});
