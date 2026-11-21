// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Steering by tilt (src/ui/tiltsteer.ts): the phone's left/right tilt as the
 * steer −1 … +1, calibrated at the moment it was switched on.
 *
 *   node --test tests/ui/tiltsteer.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TILT_DEG, steerFromTilt } from '../../src/ui/tiltsteer.ts';

test('the calibrated angle is straight ahead: no steer', () => {
  assert.equal(steerFromTilt(12, 12), 0);
  assert.equal(steerFromTilt(0, 0), 0);
});

test('tilted right turns right, tilted left turns left', () => {
  assert.ok(steerFromTilt(TILT_DEG, 0) > 0); // 30° right = full lock right
  assert.ok(steerFromTilt(-TILT_DEG, 0) < 0); // 30° left = full lock left
  assert.ok(steerFromTilt(10, 0) > 0);
  assert.ok(steerFromTilt(-10, 0) < 0);
});

test('TILT_DEG of tilt is full lock, and more is clipped', () => {
  assert.equal(steerFromTilt(TILT_DEG, 0), 1);
  assert.equal(steerFromTilt(-TILT_DEG, 0), -1);
  assert.equal(steerFromTilt(TILT_DEG * 3, 0), 1);
  assert.equal(steerFromTilt(-TILT_DEG * 3, 0), -1);
  // half the tilt is half the lock
  assert.ok(Math.abs(steerFromTilt(TILT_DEG / 2, 0) - 0.5) < 1e-9);
});

test('calibration shifts with the held angle', () => {
  // held at 15° when switched on: 15° is straight, 30° is 15° of turn
  assert.equal(steerFromTilt(15, 15), 0);
  assert.ok(steerFromTilt(30, 15) > 0);
  assert.ok(steerFromTilt(0, 15) < 0);
});

test('a device that reports nothing (null gamma) does not steer', () => {
  assert.equal(steerFromTilt(Number.NaN, 0), 0);
});
