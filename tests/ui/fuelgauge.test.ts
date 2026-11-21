// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The fuel amount as a percentage (src/ui/fuelgauge.ts): three decimals,
 * clipped to 0 … 100 % – what the gauge's tooltip shows.
 *
 *   node --test tests/ui/fuelgauge.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fuelPercent } from '../../src/ui/fuelgauge.ts';

test('the tank’s share is a percentage to three decimals', () => {
  assert.equal(fuelPercent(0.09536), '9.536');
  assert.equal(fuelPercent(1), '100.000');
  assert.equal(fuelPercent(0.5), '50.000');
  assert.equal(fuelPercent(0), '0.000');
  assert.equal(fuelPercent(0.3333333), '33.333');
});

test('a share outside 0 … 1 is clipped, never a negative or over 100 %', () => {
  assert.equal(fuelPercent(-1), '0.000');
  assert.equal(fuelPercent(2), '100.000');
  assert.equal(fuelPercent(NaN), '0.000');
});
