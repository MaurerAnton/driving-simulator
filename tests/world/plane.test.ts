// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { fitJunctionPlane } from '../../tools/mapgen/elevation.ts';
import type { PlaneArm } from '../../tools/mapgen/elevation.ts';

/** an arm leaving the node in the compass direction `deg` (0 = east, 90 = south) with the slope `m` that way */
const arm = (deg: number, m: number, w = 5): PlaneArm => ({ ux: Math.cos((deg * Math.PI) / 180), uz: Math.sin((deg * Math.PI) / 180), m, w });
/** the slope of the plane in a compass direction */
const slope = (g: [number, number], deg: number): number => g[0] * Math.cos((deg * Math.PI) / 180) + g[1] * Math.sin((deg * Math.PI) / 180);

test('the plane of a joint in a road follows the road and is level across it', () => {
  // a straight road climbing 2 % to the east
  let g = fitJunctionPlane([arm(0, 0.02), arm(180, -0.02)]);
  assert.ok(Math.abs(slope(g, 0) - 0.02) < 1e-3 && Math.abs(slope(g, 90)) < 1e-6, `straight: ${g}`);
  // a slight bend (5°) where the grade changes from 1 % to 2 %: fitted freely this tilted the road sideways by a tenth
  g = fitJunctionPlane([arm(180, -0.01), arm(5, 0.02)]);
  const along = 2.5;
  assert.ok(Math.abs(slope(g, along) - 0.015) < 2e-3, `along the road the mean grade: ${slope(g, along)}`);
  assert.ok(Math.abs(slope(g, along + 90)) < 1e-6, `level across: ${slope(g, along + 90)}`);
  // a track that leaves a road says nothing about the road's slope across either
  g = fitJunctionPlane([arm(0, 0), arm(180, 0), arm(90, -0.09, 1)]);
  assert.ok(Math.hypot(g[0], g[1]) < 1e-6, `a road with a track: ${g}`);
});

test('a lesser road tilts the greater one a little, roads of equal standing share the plane', () => {
  // a level main road, a side street falling by 8 % to the south
  let g = fitJunctionPlane([arm(0, 0), arm(180, 0), arm(90, -0.08, 3)]);
  assert.ok(Math.abs(slope(g, 0)) < 1e-6, 'the main road stays level along');
  assert.ok(Math.abs(slope(g, 90) + 0.04) < 1e-6, `tilted by 4 % at most: ${slope(g, 90)}`);
  // two roads of equal standing crossing: 3 % up to the east, 5 % down to the south
  g = fitJunctionPlane([arm(0, 0.03), arm(180, -0.03), arm(90, -0.05), arm(270, 0.05)]);
  assert.ok(Math.abs(slope(g, 0) - 0.03) < 1e-3 && Math.abs(slope(g, 90) + 0.05) < 1e-3, `a crossing: ${g}`);
  // never steeper than 14 %, and nothing at all without arms
  g = fitJunctionPlane([arm(0, 0.3), arm(180, -0.3)]);
  assert.ok(Math.abs(Math.hypot(g[0], g[1]) - 0.14) < 1e-9);
  assert.deepEqual(fitJunctionPlane([]), [0, 0]);
});
