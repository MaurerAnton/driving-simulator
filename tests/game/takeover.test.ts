// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Any vehicle can be watched and taken over (src/game/takeover.ts), and the
 * models of the test place got into (src/game/showdrive.ts): what each kind
 * of the traffic is driven as, which vehicle a tap along a ray meets, and
 * which model of the test place is hidden while it is driven.
 *
 *   node --test tests/game/takeover.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EM, emStyle } from '../../src/sim/emergency.ts';
import { BUS_STYLE } from '../../src/sim/traffic.ts';
import { pickAlong, takeKindOf } from '../../src/game/takeover.ts';
import type { PickBox } from '../../src/game/takeover.ts';
import { ShowSpots } from '../../src/game/showdrive.ts';
import { VEHICLES } from '../../src/game/vehicles.ts';

test('every kind of the traffic is taken over as one of the game\'s vehicles', () => {
  for (const s of [0, 1, 2]) assert.equal(takeKindOf(s), 'car');
  assert.equal(takeKindOf(BUS_STYLE), 'bus');
  for (const lit of [false, true]) {
    assert.equal(takeKindOf(emStyle(EM.POLICE, lit)), 'car');
    assert.equal(takeKindOf(emStyle(EM.DOCTOR, lit)), 'car');
    assert.equal(takeKindOf(emStyle(EM.AMBULANCE, lit)), 'lightTruck');
    assert.equal(takeKindOf(emStyle(EM.FIRE, lit)), 'truckSolo');
  }
  // (and each is a vehicle of the game, driven on the road)
  for (let s = 0; s < 16; s++) assert.ok(VEHICLES[takeKindOf(s)], `style ${s}`);
});

test('a tap meets the nearest vehicle along its ray', () => {
  const box = (x: number, z: number, id: number): PickBox => ({ x, y: 0, z, yaw: 0, height: 1.5, front: 2.2, rear: 2.2, hw: 0.9, what: { kind: 'car', id } });
  const boxes = [box(0, -40, 1), box(0, -20, 2), box(5, -10, 3)];
  // (from 1 m up at the origin, looking north)
  assert.deepEqual(pickAlong(0, 1, 0, 0, 0, -1, boxes), { kind: 'car', id: 2 });
  // (looking a little east of north: the third, 5 m east and 10 m north)
  assert.deepEqual(pickAlong(0, 1, 0, 0.5, 0, -1, boxes), { kind: 'car', id: 3 });
  // (over them all, or beyond reach: none)
  assert.equal(pickAlong(0, 1, 0, 0, 1, -1, boxes), null);
  assert.equal(pickAlong(0, 1, 0, 0, 0, -1, boxes, 10), null);
});

test('a model of the test place got into is hidden while driven; the others are shown', () => {
  const spots = new ShowSpots();
  const root = () => ({ visible: true }) as unknown as import('three').Object3D;
  const a = { kind: 'car' as const, x: 0, y: 0, z: 0, yaw: 0, outline: VEHICLES.car.outline, height: 1.6, roots: [root()] };
  const b = { kind: 'bus' as const, x: 20, y: 0, z: 0, yaw: 0, outline: VEHICLES.bus.outline, height: 3.4, roots: [root()] };
  spots.add(a);
  spots.add(b);
  assert.equal(spots.boxes().length, 2);
  // (a drive on the test place from the menu: from the usual place, all shown)
  assert.equal(spots.start(), null);
  assert.equal(spots.taken, -1);
  // into the bus: the drive begins where it stands, it is hidden
  assert.equal(spots.choose(1), b);
  assert.equal(spots.start(), b);
  assert.equal(b.roots[0].visible, false);
  assert.equal(a.roots[0].visible, true);
  assert.deepEqual(spots.boxes().map((q) => q.what), [{ kind: 'show', i: 0 }]);
  // on foot beside the car: it; beside where the bus stood: nothing (it is driven)
  assert.equal(spots.near(1.5, 0), 0);
  assert.equal(spots.near(21.5, 0), -1);
  // then into the car: the bus is shown again
  spots.choose(0);
  spots.start();
  assert.equal(b.roots[0].visible, true);
  assert.equal(a.roots[0].visible, false);
});
