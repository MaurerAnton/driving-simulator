// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The ways of walking (game/walkmodes.ts): which way is in use, the way on
 * foot over and along a road after a tap, and walking it – plus the sideways
 * step of somebody on foot (game/onfoot.ts).
 *
 *   node --test tests/game/walkmodes.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makePolyline } from '../../src/core/geom.ts';
import { OnFoot } from '../../src/game/onfoot.ts';
import { WalkControl, planFootPath, walkModeOf } from '../../src/game/walkmodes.ts';
import type { FootRoad } from '../../src/game/walkmodes.ts';

/** a straight road from west to east along z = 0, 200 m long, 7 m wide, pavements of 2.5 m, a zebra crossing at 120 m */
const road = (): FootRoad => ({ pl: makePolyline([0, 0, 0, 200, 0, 0]), half: 3.5, swL: 2.5, swR: 2.5, xings: [120] });

test('auto: the classic way on a touch screen, as before with keys', () => {
  assert.equal(walkModeOf('auto', true), 'classic');
  assert.equal(walkModeOf('auto', false), 'tank');
  assert.equal(walkModeOf('tap', false), 'tap');
  assert.equal(walkModeOf('tank', true), 'tank');
});

test('over the road: along the pavement to the crossing near the way, over it, to the place', () => {
  // from the north pavement (z −5) at x 100 to a place south of the road at x 130
  const path = planFootPath(100, -5, 130, 6, [road()]);
  const last = path[path.length - 1];
  assert.deepEqual(last, { x: 130, z: 6 });
  // somewhere it goes over the road at the crossing (x 120): a point on each kerb's side there
  const atXing = path.filter((p) => Math.abs(p.x - 120) < 0.01);
  assert.equal(atXing.length, 2, JSON.stringify(path));
  assert.ok(atXing.some((p) => p.z < -3.5) && atXing.some((p) => p.z > 3.5));
  // and nowhere else on the carriageway
  for (const p of path) if (Math.abs(p.x - 120) > 0.01 && p !== last) assert.ok(Math.abs(p.z) > 3.5, JSON.stringify(p));
});

test('over the road with no crossing near: straight over where the place lies', () => {
  const r = { ...road(), xings: [] };
  const path = planFootPath(30, -5, 60, 6, [r]);
  // over at x 60, kerb to kerb – before that along the north pavement
  const over = path.filter((p) => Math.abs(p.x - 60) < 0.01 && p.z !== 6);
  assert.deepEqual(
    over.map((p) => Math.sign(p.z)),
    [-1, 1],
    JSON.stringify(path),
  );
  for (const p of path.slice(0, path.indexOf(over[1]))) assert.ok(p.z < -3.5, JSON.stringify(p));
});

test('along the road on the same side: on the pavement; with no road: straight there', () => {
  const path = planFootPath(10, -5, 90, -6, [road()]);
  assert.ok(path.length > 3);
  for (const p of path) assert.ok(p.z < -3.5, JSON.stringify(p));
  assert.deepEqual(planFootPath(10, -50, 90, -60, [road()]), [{ x: 90, z: -60 }]);
  assert.deepEqual(planFootPath(0, 0, 5, 5, []), [{ x: 5, z: 5 }]);
});

test('walking a way: there, turning towards it, and the keys take over', () => {
  const walker = new OnFoot(null, { x: 0, y: 0, z: 0, yaw: 0 });
  const ctl = new WalkControl();
  ctl.goTo([{ x: 10, z: 0 }]);
  const none = { fwd: 0, side: 0, turn: 0, run: false };
  const flat = (): number => 0;
  const free = (): boolean => false;
  for (let i = 0; i < 600 && ctl.walking; i++) {
    const m = ctl.step(1 / 30, none, walker, false);
    walker.update(1 / 30, m, { yaw: 0, pitch: 0, right: 0, fwd: 0 }, flat, free);
  }
  assert.ok(!ctl.walking);
  assert.ok(Math.hypot(walker.x - 10, walker.z) < 0.5, `${walker.x} ${walker.z}`);
  // (it turned to face east: yaw −π/2)
  assert.ok(Math.abs(walker.yaw + Math.PI / 2) < 0.3, String(walker.yaw));
  ctl.goTo([{ x: 50, z: 0 }]);
  const m = ctl.step(1 / 30, { fwd: 1, side: 0, turn: 0, run: false }, walker, false);
  assert.ok(!ctl.walking);
  assert.equal(m.fwd, 1);
});

test('walking a way into a wall: gives up and says so', () => {
  const walker = new OnFoot(null, { x: 0, y: 0, z: 0, yaw: Math.PI / 2 });
  const ctl = new WalkControl();
  ctl.goTo([{ x: 10, z: 0 }]);
  const none = { fwd: 0, side: 0, turn: 0, run: false };
  for (let i = 0; i < 300 && ctl.walking; i++) {
    const m = ctl.step(1 / 30, none, walker, false);
    walker.update(1 / 30, m, { yaw: 0, pitch: 0, right: 0, fwd: 0 }, () => 0, (x) => x > 3);
  }
  assert.ok(!ctl.walking);
  assert.ok(ctl.blocked);
  assert.ok(walker.x < 3.2);
});

test('turning by keys is eased in', () => {
  const ctl = new WalkControl();
  const at = { x: 0, z: 0, yaw: 0 };
  const a = ctl.step(1 / 60, { fwd: 0, side: 0, turn: 1, run: false }, at, false);
  assert.ok(a.turn > 0 && a.turn < 0.3, String(a.turn));
  let t = a.turn;
  for (let i = 0; i < 60; i++) t = ctl.step(1 / 60, { fwd: 0, side: 0, turn: 1, run: false }, at, false).turn;
  assert.ok(t > 0.95);
});

test('on foot: a step to the side, and no quicker on a slant', () => {
  const w = new OnFoot(null, { x: 0, y: 0, z: 0, yaw: 0 });
  const look = { yaw: 0, pitch: 0, right: 0, fwd: 0 };
  // facing north (−z): to the right is east (+x)
  w.update(1, { fwd: 0, side: 1, turn: 0, run: false }, look, () => 0, () => false);
  assert.ok(w.x > 1.3 && Math.abs(w.z) < 1e-9, `${w.x} ${w.z}`);
  const v = new OnFoot(null, { x: 0, y: 0, z: 0, yaw: 0 });
  v.update(1, { fwd: 1, side: 1, turn: 0, run: false }, look, () => 0, () => false);
  assert.ok(Math.abs(Math.hypot(v.x, v.z) - w.x) < 1e-6);
});
