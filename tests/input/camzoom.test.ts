// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Zooming the view (input/camzoom.ts): the pinch holds while the fingers
 * are on, the wheel and the keys let go after the time the settings choose.
 *
 *   node --test tests/input/camzoom.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CamZoom, ZOOM_MAX } from '../../src/input/camzoom.ts';

const run = (z: CamZoom, seconds: number, release: Parameters<CamZoom['update']>[1] = 'auto', active = true): void => {
  for (let t = 0; t < seconds; t += 1 / 60) z.update(1 / 60, release, active);
};

test('a pinch zooms and holds while the fingers are on, and lets go when they lift (auto)', () => {
  const z = new CamZoom();
  z.pinch(2);
  run(z, 10);
  assert.ok(Math.abs(z.factor - 2) < 0.01);
  z.fingersOff();
  run(z, 2);
  assert.equal(z.factor, 1);
});

test('the wheel lets go after a few seconds (auto), never with "never"', () => {
  const z = new CamZoom();
  z.wheel(-0.2);
  run(z, 2);
  assert.ok(z.factor > 1.2);
  run(z, 4);
  assert.equal(z.factor, 1);
  z.wheel(-0.2);
  run(z, 30, 'never');
  assert.ok(z.factor > 1.2);
});

test('a key held keeps the zoom; the limits hold; inactive resets', () => {
  const z = new CamZoom();
  for (let i = 0; i < 20; i++) z.press(1, true);
  assert.equal(z.target, ZOOM_MAX);
  run(z, 10, 'release');
  assert.ok(Math.abs(z.factor - ZOOM_MAX) < 0.01);
  z.press(0, false);
  run(z, 2, 'release');
  assert.equal(z.factor, 1);
  z.press(-1, true);
  assert.equal(z.target, 1);
  z.pinch(3);
  run(z, 0.1, 'auto', false);
  assert.equal(z.factor, 1);
  assert.equal(z.held, false);
});

test('the angle of view narrows by the factor', () => {
  const z = new CamZoom();
  assert.equal(z.fov(60), 60);
  z.factor = 2;
  const half = Math.tan((z.fov(60) * Math.PI) / 360);
  assert.ok(Math.abs(half - Math.tan(Math.PI / 6) / 2) < 1e-9);
});
