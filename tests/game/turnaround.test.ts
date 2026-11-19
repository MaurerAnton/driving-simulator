// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Turning a vehicle round (src/game/turnaround.ts): into the lane of the
 * other direction on a two-way road, where it stands on a one-way street.
 *
 *   node --test tests/game/turnaround.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { turnedSpot } from '../../src/game/turnaround.ts';

/** where the vehicle stands: on the road, facing north (yaw 0 = north) */
const here = { x: 100, y: 50, z: 200, yaw: 0 };

test('the lane of the other direction is taken', () => {
  // the lane beside it, facing south: the other direction of a two-way road
  const other = { x: 103, y: 50, z: 198, yaw: Math.PI };
  assert.equal(turnedSpot(here, other), other);
  // (also a lane that is turned a little: over 120° apart is the other way round)
  const skewed = { x: 104, y: 50, z: 203, yaw: Math.PI - 0.6 };
  assert.equal(turnedSpot(here, skewed), skewed);
});

test('a lane facing the same way, or too far away, means turning in place', () => {
  const inPlace = { x: 100, y: 50, z: 200, yaw: Math.PI };
  // a lane going the way the vehicle already goes: not the other direction
  assert.deepEqual(turnedSpot(here, { x: 103, y: 50, z: 200, yaw: 0 }), inPlace);
  // (a quarter turn away: neither this way nor the other way)
  assert.deepEqual(turnedSpot(here, { x: 103, y: 50, z: 200, yaw: Math.PI / 2 }), inPlace);
  // the lane of the other direction, but 30 m away (another road): where it stands
  assert.deepEqual(turnedSpot(here, { x: 103, y: 50, z: 230, yaw: Math.PI }), inPlace);
  // no lane found the other way round (a one-way street): where it stands
  assert.deepEqual(turnedSpot(here, null), inPlace);
});

test('turning in place keeps the place and turns the yaw by 180°', () => {
  const standing = { x: -40, y: 12, z: 7, yaw: 1.25 };
  const turned = turnedSpot(standing, null);
  assert.equal(turned.x, standing.x);
  assert.equal(turned.y, standing.y);
  assert.equal(turned.z, standing.z);
  assert.ok(Math.abs(turned.yaw - (standing.yaw + Math.PI)) < 1e-9);
  // and the same the other way round: two turn-rounds are back where they were
  const back = turnedSpot(turned, null);
  assert.ok(Math.abs(back.yaw - standing.yaw) < 1e-9 || Math.abs(Math.abs(back.yaw - standing.yaw) - 2 * Math.PI) < 1e-9);
});
