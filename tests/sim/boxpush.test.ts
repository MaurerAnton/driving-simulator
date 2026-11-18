// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxPush, boxesOverlap } from '../../src/sim/traffic.ts';

// (yaw 0 faces −z: the front of a box at yaw 0 is towards −z)
const BUS = { hl: 6, hw: 1.25 };
const CAR = { hl: 2.2, hw: 0.9 };

test('a car nosing into the rear of a 12 m bus is pushed back out of it (1.7.1: not only near the cabin)', () => {
  // bus at the origin facing −z; its rear end at z = +6; the car behind it, facing −z, its front 0.5 m inside the bus
  const carZ = 6 + CAR.hl - 0.5;
  assert.equal(boxesOverlap(0, 0, 0, BUS.hl, BUS.hw, 0, carZ, 0, CAR.hl, CAR.hw), true);
  const p = boxPush(0, 0, 0, BUS.hl, BUS.hw, 0, carZ, 0, CAR.hl, CAR.hw);
  assert.ok(p);
  assert.ok(Math.abs(p.nx) < 1e-9 && Math.abs(p.nz - 1) < 1e-9, `out backwards (+z), got ${p.nx}, ${p.nz}`);
  assert.ok(Math.abs(p.depth - 0.5) < 1e-9);
});

test('a car hitting the side of a bus near its rear is pushed out sideways, not along the bus', () => {
  // car at the bus's right-hand side, 4 m from its middle, turned across it, 0.3 m in
  const carX = BUS.hw + CAR.hl - 0.3;
  const p = boxPush(0, 0, 0, BUS.hl, BUS.hw, carX, 4, Math.PI / 2, CAR.hl, CAR.hw);
  assert.ok(p);
  assert.ok(Math.abs(Math.abs(p.nx) - 1) < 1e-9 && Math.abs(p.nz) < 1e-9);
  assert.ok(p.nx > 0, 'towards the car');
  assert.ok(Math.abs(p.depth - 0.3) < 1e-9);
});

test('boxes apart: nothing to push', () => {
  assert.equal(boxPush(0, 0, 0, BUS.hl, BUS.hw, 0, 6 + CAR.hl + 0.1, 0, CAR.hl, CAR.hw), null);
});
