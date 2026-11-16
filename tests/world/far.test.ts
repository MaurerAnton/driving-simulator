// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The far view's grid (far.bin, tools/build-far.ts): read back, the height
 * between its points, and what kind of place a point lies in by the
 * buildings around it.
 *
 *   node --test "tests/world/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FAR_NONE, farBuilt, farHeight, parseFar } from '../../src/world/far.ts';

/** A grid of 4 × 3 points, 100 m apart, rising 1 m to the east; buildings of a given height in its middle. */
function grid(tall: number): ArrayBuffer {
  const w = 4;
  const h = 3;
  const buf = new ArrayBuffer(32 + w * h * 4);
  const b = new Uint8Array(buf);
  b.set([0x46, 0x41, 0x52, 0x32]);
  const dv = new DataView(buf);
  for (const [o, v] of [
    [4, 0],
    [8, 0],
    [12, 100],
    [16, w],
    [20, h],
  ])
    dv.setInt32(o, v, true);
  dv.setFloat32(24, 200, true);
  dv.setFloat32(28, 0.5, true);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) dv.setUint16(32 + (j * w + i) * 2, i * 2, true);
  // a point with no ground known
  dv.setUint16(32 + (2 * w + 3) * 2, FAR_NONE, true);
  for (let k = 0; k < w * h; k++) b[32 + w * h * 2 + k] = 3;
  for (let k = 0; k < w * h; k++) b[32 + w * h * 3 + k] = tall * 2;
  return buf;
}

test('the far grid: read back, heights between the points, nothing where none is known', () => {
  const f = parseFar(grid(4));
  assert.ok(f);
  assert.equal(f.w, 4);
  assert.equal(f.h, 3);
  assert.equal(f.cover[5], 3);
  assert.ok(Math.abs(farHeight(f, 0, 0) - 200) < 1e-6);
  assert.ok(Math.abs(farHeight(f, 150, 50) - 201.5) < 1e-6, 'between the points');
  assert.ok(Number.isNaN(farHeight(f, 250, 150)), 'beside a point without ground');
  assert.ok(Number.isNaN(farHeight(f, -10, 0)), 'outside the grid');
});

test('the kind of place by its buildings: small houses, rows and blocks, tall ones', () => {
  assert.equal(farBuilt(parseFar(grid(4))!, 100, 100), 1);
  assert.equal(farBuilt(parseFar(grid(7))!, 100, 100), 2);
  assert.equal(farBuilt(parseFar(grid(14))!, 100, 100), 3);
  assert.equal(farBuilt(parseFar(grid(0))!, 100, 100), 0, 'no buildings: the open country');
});
