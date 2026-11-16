// SPDX-License-Identifier: AGPL-3.0-only
/**
 * On foot beside the vehicle: walking round it (never through it), the
 * check before the drive, the driver's door.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EYE, OnFoot, TETHER, checkSpots } from '../../src/game/onfoot.ts';
import type { WalkMove, WalkVehicle } from '../../src/game/onfoot.ts';

const DT = 1 / 30;
const STILL = { yaw: 0, pitch: 0, right: 0, fwd: 0 };
const flat = (): number => 0;
const open = (): boolean => false;

/** The car standing at the origin, facing north (−z). */
const car = (): WalkVehicle => ({ units: [{ x: 0, z: 0, yaw: 0, front: 2.195, rear: 2.085, hw: 0.895, axles: [1.315, -1.315], track: 0.77 }], y: 0, door: 0.1, hitch: null });

/** A truck with its trailer (tandem axles) behind it. */
const truck = (): WalkVehicle => ({
  units: [
    { x: 0, z: 0, yaw: 0, front: 3.75, rear: 4.45, hw: 1.25, axles: [2.35, -2.35], track: 1.1 },
    { x: 0, z: 9.95, yaw: 0, front: 3.9, rear: 2.5, hw: 1.25, axles: [0.65, -0.65], track: 1.1 },
  ],
  y: 0,
  door: 2.45,
  hitch: { x: 0, y: 0.9, z: 4.05 },
});

function walk(w: OnFoot, seconds: number, move: WalkMove, blocked: (x: number, y: number, z: number, r: number) => boolean = open): void {
  for (let t = 0; t < seconds; t += DT) w.update(DT, move, STILL, flat, blocked);
}

/** Turn the walker to look at a point. */
function aim(w: OnFoot, x: number, y: number, z: number): void {
  const dx = x - w.x;
  const dz = z - w.z;
  w.yaw = Math.atan2(-dx, -dz);
  w.pitch = Math.atan2(y - (w.y + EYE), Math.hypot(dx, dz));
}

test('what there is to check: every tyre, the lights at the front and at the back – with a trailer the coupling', () => {
  const c = checkSpots(car());
  assert.deepEqual(
    c.map((s) => s.id),
    ['tyres', 'tyres', 'tyres', 'tyres', 'front', 'rear'],
  );
  const t = checkSpots(truck());
  assert.equal(t.filter((s) => s.id === 'tyres').length, 6, 'the tandem axle of the trailer is looked at as one on each side');
  assert.equal(t.filter((s) => s.id === 'front').length, 1);
  assert.equal(t.filter((s) => s.id === 'rear').length, 1);
  const rear = t.find((s) => s.id === 'rear')!;
  assert.ok(rear.z > 12, 'the lights at the back are those of the trailer');
  assert.equal(t.filter((s) => s.id === 'coupling').length, 1);
  // each ring lies on the ground beside the vehicle, outside it
  for (const s of [...c, ...t]) assert.ok(Math.hypot(s.rx - s.x, s.rz - s.z) > 0.5);
});

test('one starts beside the driver\'s door – and can get in from there', () => {
  const w = new OnFoot(car());
  assert.ok(w.x < -0.895, 'on the left of the car');
  assert.equal(w.atDoor, true);
  walk(w, 2, { fwd: 1, turn: 0, run: false });
  assert.equal(w.atDoor, false, 'a few steps on, the door is behind');
});

test('nobody walks through the vehicle, a wall – or away from the vehicle for good', () => {
  const w = new OnFoot(car());
  // towards the car (east)
  w.yaw = -Math.PI / 2;
  walk(w, 4, { fwd: 1, turn: 0, run: false });
  assert.ok(w.x < -0.895 - 0.27, `stopped at the side of the car (x = ${w.x.toFixed(2)})`);
  // away from it (west) towards a wall at x = −6
  w.yaw = Math.PI / 2;
  walk(w, 6, { fwd: 1, turn: 0, run: true }, (x) => x < -6);
  assert.ok(w.x > -6 && w.x < -5, `stopped at the wall (x = ${w.x.toFixed(2)})`);
  // walking along a wall slides along it
  w.yaw = Math.PI / 2 + 0.6;
  const z0 = w.z;
  walk(w, 2, { fwd: 1, turn: 0, run: false }, (x) => x < -6);
  assert.ok(w.z - z0 > 1, 'along the wall');
  // the tether: not further than a few dozen metres from the vehicle
  const far = new OnFoot(car());
  far.yaw = Math.PI / 2;
  walk(far, 60, { fwd: 1, turn: 0, run: true });
  assert.ok(Math.hypot(far.x, far.z) <= TETHER + 0.01, 'held at the tether');
  assert.equal(far.tooFar, true, 'and told so');
});

test('turning and walking: the keys turn the walker, walking goes the way it looks', () => {
  const w = new OnFoot(car());
  const yaw0 = w.yaw;
  walk(w, 1, { fwd: 0, turn: 1, run: false });
  assert.ok(Math.abs(w.yaw - yaw0 - 1.9) < 0.1, 'about 110 degrees a second');
  w.yaw = Math.PI / 2; // west
  const x0 = w.x;
  walk(w, 2, { fwd: 1, turn: 0, run: false });
  assert.ok(Math.abs(x0 - w.x - 2 * 1.45) < 0.1, `walking pace (${(x0 - w.x).toFixed(2)} m in 2 s)`);
  const x1 = w.x;
  walk(w, 2, { fwd: 1, turn: 0, run: true });
  assert.ok(x1 - w.x > 5, 'running');
});

test('looked at for a moment from near enough, each thing counts as checked', () => {
  const w = new OnFoot(car());
  const tyre = w.spots[0];
  // from far away: no
  w.x = tyre.x - 6;
  w.z = tyre.z;
  aim(w, tyre.x, tyre.y, tyre.z);
  walk(w, 1, { fwd: 0, turn: 0, run: false });
  assert.equal(tyre.done, false, 'too far away');
  // near, but looking elsewhere: no
  w.x = tyre.rx;
  w.z = tyre.rz;
  aim(w, tyre.x, tyre.y + 5, tyre.z + 8);
  walk(w, 1, { fwd: 0, turn: 0, run: false });
  assert.equal(tyre.done, false, 'not looked at');
  // near and looking at it: yes, after a moment
  aim(w, tyre.x, tyre.y, tyre.z);
  w.update(DT, { fwd: 0, turn: 0, run: false }, STILL, flat, open);
  assert.equal(tyre.done, false, 'not at a glance');
  walk(w, 0.6, { fwd: 0, turn: 0, run: false });
  assert.equal(tyre.done, true);
  assert.deepEqual(w.progress()[0], { id: 'tyres', done: 1, of: 4 });
  // all of them
  for (const s of w.spots) {
    w.x = s.rx;
    w.z = s.rz;
    aim(w, s.x, s.y, s.z);
    walk(w, 0.6, { fwd: 0, turn: 0, run: false });
  }
  assert.equal(w.allChecked, true);
  assert.deepEqual(w.missing(), []);
});

test('what was not checked is named', () => {
  const w = new OnFoot(truck());
  for (const s of w.spots) if (s.id !== 'coupling' && s.id !== 'rear') s.done = true;
  assert.deepEqual(w.missing(), ['rear', 'coupling']);
});
