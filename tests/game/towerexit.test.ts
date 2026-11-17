// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Getting out of the tower crane (src/game/craneplay.ts): the operator climbs
 * down and stands beside its cross base – on the left first, else the next
 * free place round it –, and climbs up again from its foot only.
 *
 *   node --test tests/game/towerexit.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { atTowerFoot, towerExit } from '../../src/game/craneplay.ts';

/** the cross base is 5 × 5 m round the axis: nobody stands on it */
const offBase = (bx: number, bz: number, yaw: number, x: number, z: number): boolean => {
  const dx = x - bx;
  const dz = z - bz;
  const u = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  const w = dx * Math.sin(yaw) + dz * Math.cos(yaw);
  return Math.abs(u) > 2.5 || Math.abs(w) > 2.5;
};

test('down from the tower crane: beside the base on its left, facing it, off the base, at its foot', () => {
  for (const yaw of [0, 0.5, -1.9, Math.PI]) {
    const p = towerExit(300, -80, yaw, () => true);
    assert.ok(offBase(300, -80, yaw, p.x, p.z), 'not on the base');
    // left of the crane's heading: to the right is (cos, −sin)
    const right = (p.x - 300) * Math.cos(yaw) - (p.z + 80) * Math.sin(yaw);
    assert.ok(right < -4, `on the left (${right.toFixed(2)})`);
    // facing the tower: forwards (−sin, −cos) points at the axis
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    const d = Math.hypot(300 - p.x, -80 - p.z);
    assert.ok(Math.abs(fx * (300 - p.x) + fz * (-80 - p.z) - d) < 1e-6);
    assert.ok(atTowerFoot(300, -80, p.x, p.z), 'and can climb up again from there');
  }
});

test('where the left side is blocked: the next free place round the base; none free: the left after all', () => {
  const blockedLeft = (x: number): boolean => x > -2;
  const p = towerExit(0, 0, 0, (x) => blockedLeft(x));
  assert.ok(p.x > -2);
  assert.ok(offBase(0, 0, 0, p.x, p.z));
  const q = towerExit(0, 0, 0, () => false);
  assert.ok(q.x < -4 && Math.abs(q.z) < 1e-9);
});

test('climbing up only from the foot of the crane', () => {
  assert.equal(atTowerFoot(0, 0, 4.3, 0), true);
  assert.equal(atTowerFoot(0, 0, 0, 6.4), true);
  assert.equal(atTowerFoot(0, 0, 9, 0), false);
});
