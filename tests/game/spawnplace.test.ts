// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where a vehicle may be put down (src/game/spawnplace.ts): only on the
 * loaded tiles, the line round them, never inside a building, the nearest
 * free place round one that is not free, a place beside somebody on foot –
 * and where a tap on the picture meets the ground or a vehicle standing.
 *
 *   node --test tests/game/spawnplace.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Footprints, LoadedArea, besidePlace, freeNear, inBuilding, inRing, outlinePoints, rayBox, rayGround, tileOutline } from '../../src/game/spawnplace.ts';

const CAR = { front: 1.9, rear: 2.2, hw: 0.9 };

test('the loaded area: on a tile, a margin inside its edge, gone with the tile', () => {
  const a = new LoadedArea();
  a.set('0_0', { cx: 0, cz: 0, size: 100 }, true);
  a.set('1_0', { cx: 100, cz: 0, size: 100 }, true);
  assert.ok(a.has(0, 0));
  assert.ok(a.has(120, 10));
  assert.ok(!a.has(0, 80));
  // (across the shared side the margin is no matter; at the outer edge it is)
  assert.ok(a.has(50, 0, 10));
  assert.ok(!a.has(-45, 0, 10));
  a.set('1_0', { cx: 100, cz: 0, size: 100 }, false);
  assert.ok(!a.has(120, 10));
  assert.equal(a.size, 1);
});

test('the line round the loaded tiles: only the sides no other tile shares', () => {
  // two tiles side by side: 6 outer sides (the shared one left out)
  const two = tileOutline([
    { cx: 0, cz: 0, size: 10 },
    { cx: 10, cz: 0, size: 10 },
  ]);
  assert.equal(two.length, 6 * 4);
  for (let i = 0; i < two.length; i += 4) assert.ok(!(two[i] === 5 && two[i + 2] === 5), 'the shared side x = 5 is no part of the line');
  // a block of 3 × 3: 12 outer sides
  const nine = [];
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) nine.push({ cx: x * 10, cz: z * 10, size: 10 });
  assert.equal(tileOutline(nine).length, 12 * 4);
  // the area's own outline is the same, and follows a tile going
  const a = new LoadedArea();
  for (const [i, t] of nine.entries()) a.set(String(i), t, true);
  assert.equal(a.outline().length, 12 * 4);
  a.set('4', nine[4], false);
  // (the middle gone: a hole – 4 more sides)
  assert.equal(a.outline().length, 16 * 4);
});

test('a point inside a ring, and the footprints of buildings', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.ok(inRing(5, 5, square, 0, 4));
  assert.ok(!inRing(15, 5, square, 0, 4));
  // an L-shaped building: its notch is outside
  const l = [0, 0, 20, 0, 20, 10, 10, 10, 10, 20, 0, 20];
  assert.ok(inRing(5, 15, l, 0, 6));
  assert.ok(!inRing(15, 15, l, 0, 6));
  const f = new Footprints();
  f.set('t', Float32Array.from([...square, ...l.map((v, i) => v + (i % 2 === 0 ? 100 : 0))]), Uint16Array.of(4, 6));
  assert.ok(f.inside(5, 5));
  assert.ok(f.inside(105, 15));
  assert.ok(!f.inside(115, 15));
  assert.ok(!f.inside(50, 5));
  f.remove('t');
  assert.ok(!f.inside(5, 5));
});

test('a car reaching into a building is in it; beside it, it is not', () => {
  const f = new Footprints();
  f.set('t', Float32Array.of(0, 0, 10, 0, 10, 10, 0, 10), Uint16Array.of(4));
  const inside = (x: number, z: number): boolean => f.inside(x, z);
  // facing north (yaw 0), its middle 1.5 m south of the wall: the bonnet reaches in
  assert.ok(inBuilding(5, 11.5, 0, CAR, inside));
  assert.ok(!inBuilding(5, 15, 0, CAR, inside));
  // facing east (yaw −π/2), beside the wall
  assert.ok(!inBuilding(-2, 5, -Math.PI / 2, CAR, inside));
  // the points: middle, front, rear, four corners; the front lies ahead (yaw 0: north = −z)
  const p = outlinePoints(0, 0, 0, CAR);
  assert.equal(p.length, 14);
  assert.ok(Math.abs(p[3] - -1.9) < 1e-9);
});

test('the nearest free place: the place itself if free, else the nearest round it', () => {
  const free = (x: number, z: number): boolean => x >= 10;
  const here = freeNear(20, 0, 0, free);
  assert.deepEqual(here, { x: 20, z: 0, yaw: 0 });
  const near = freeNear(5, 0, 0, free, 40, 1.5);
  assert.ok(near);
  assert.ok(near.x >= 10 && Math.hypot(near.x - 5, near.z) < 7, `found ${near.x}, ${near.z}`);
  assert.equal(freeNear(0, 0, 0, () => false, 10), null);
  // only the other way round fits: then facing that way
  const turned = freeNear(0, 0, 0, (_x, _z, yaw) => Math.cos(yaw) < 0, 5);
  assert.ok(turned && Math.cos(turned.yaw) < 0);
});

test('a place beside somebody on foot: to the right first, never on them', () => {
  const all = besidePlace(0, 0, 0, () => true);
  assert.ok(all);
  // facing north, the right is east (+x)
  assert.ok(all.x > 3 && Math.abs(all.z) < 1e-9);
  const leftOnly = besidePlace(0, 0, 0, (x) => x < -1);
  assert.ok(leftOnly && leftOnly.x < -3);
  const far = besidePlace(0, 0, 0, (x, z) => Math.hypot(x, z) > 8);
  assert.ok(far && Math.hypot(far.x, far.z) > 8);
  assert.equal(besidePlace(0, 0, 0, () => false, 5), null);
});

test('a tap on the picture: where the ray meets the ground (also on a slope; never where the ground is not known)', () => {
  const flat = (): number => 0;
  const g = rayGround(0, 10, 0, 1, -1, 0, flat);
  assert.ok(g && Math.abs(g.x - 10) < 0.05 && Math.abs(g.z) < 1e-9);
  // ground rising eastwards (y = x / 10): meets it sooner
  const slope = (x: number): number => x / 10;
  const s = rayGround(0, 10, 0, 1, -1, 0, slope);
  assert.ok(s && Math.abs(s.x - 100 / 11) < 0.05);
  // up into the sky, or over ground not loaded
  assert.equal(rayGround(0, 10, 0, 1, 0.2, 0, flat), null);
  assert.equal(rayGround(0, 10, 0, 1, -1, 0, () => NaN), null);
});

test('a tap on a vehicle standing: the ray meets its box, or passes it', () => {
  const box = { x: 0, y: 0, z: 0, yaw: 0, height: 1.6, ...CAR };
  // from the south-east, down onto the car
  const t = rayBox(10, 5, 0, -10, -4, 0, box);
  assert.ok(t > 0);
  // over it, and beside it
  assert.equal(rayBox(10, 5, 0, -10, 0, 0, box), -1);
  assert.equal(rayBox(10, 1, 5, -10, 0, 0, box), -1);
  // facing north it is long along z: a ray along x at z = 1.5 meets it – turned by 90°, it is narrow there, and passes
  assert.ok(rayBox(10, 1, 1.5, -1, 0, 0, box) > 0);
  assert.equal(rayBox(10, 1, 1.5, -1, 0, 0, { ...box, yaw: Math.PI / 2 }), -1);
});
