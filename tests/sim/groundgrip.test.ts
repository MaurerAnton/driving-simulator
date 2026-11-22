// SPDX-License-Identifier: AGPL-3.0-only
/**
 * "No road physics" (settings evenRoads, WorldGround.even): every surface –
 * asphalt and grass alike – grips and rolls as dry asphalt.  The sample() that
 * the wheels read must give the same grip and rolling on a road as on a field
 * when the option is on, whatever the weather.
 *
 *   node --test tests/sim/groundgrip.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COVER } from '../../src/world/cover.ts';
import { WorldGround } from '../../src/sim/ground.ts';
import type { GroundSample } from '../../src/sim/vehicle/types.ts';
import { makeTown } from '../game/town.ts';

/** A terrain that is asphalt at one point and grass at another (no tiles needed). */
function fakeTerrain(coverAt: (x: number, z: number) => number) {
  return {
    heightAt: (x: number, z: number): number => 100 + Math.sin(x * 0.1) * 0.5, // (a little bump, like terrain)
    coverAt,
  };
}

const sample = (): GroundSample => ({ y: 0, nx: 0, ny: 1, nz: 0, grip: 1, rolling: 1 });

test('with even on: asphalt and grass give the same grip and rolling', () => {
  const town = makeTown({ cols: 3, rows: 3, block: 90 });
  const asphalt = new WorldGround(town.world, fakeTerrain(() => COVER.ASPHALT));
  const grass = new WorldGround(town.world, fakeTerrain(() => COVER.GRASS));
  asphalt.even = true;
  grass.even = true;
  const a = sample();
  const g = sample();
  // (a point off the town's streets: the terrain path; the cover says which)
  asphalt.sample(45, 45, 100, a);
  grass.sample(45, 45, 100, g);
  assert.equal(a.grip, g.grip, 'grip is the same on asphalt and grass');
  assert.equal(a.rolling, g.rolling, 'rolling is the same on asphalt and grass');
  assert.equal(a.grip, 1, 'even: grip is dry asphalt (1)');
  assert.equal(a.rolling, 1, 'even: rolling is dry asphalt (1)');
});

test('with even off: asphalt and grass differ (the option is doing something)', () => {
  const town = makeTown({ cols: 3, rows: 3, block: 90 });
  const asphalt = new WorldGround(town.world, fakeTerrain(() => COVER.ASPHALT));
  const grass = new WorldGround(town.world, fakeTerrain(() => COVER.GRASS));
  const a = sample();
  const g = sample();
  asphalt.sample(45, 45, 100, a);
  grass.sample(45, 45, 100, g);
  assert.ok(a.grip > g.grip, `asphalt grips more than grass (${a.grip} > ${g.grip})`);
  assert.ok(a.rolling < g.rolling, `asphalt rolls easier than grass (${a.rolling} < ${g.rolling})`);
});

test('evenTerrain: grass lies flat as a road (no bumps, no camber)', () => {
  const town = makeTown({ cols: 3, rows: 3, block: 90 });
  const g = new WorldGround(town.world, fakeTerrain(() => COVER.GRASS));
  g.evenTerrain = true;
  const s = sample();
  g.sample(45, 45, 100, s);
  assert.equal(s.nx, 0, 'no camber left/right');
  assert.equal(s.nz, 0, 'no slope forward/back');
  assert.equal(s.ny, 1, 'flat: the normal points straight up');
  // (the landscape's height is kept – a hill is still a hill)
  assert.ok(Number.isFinite(s.y));
});
