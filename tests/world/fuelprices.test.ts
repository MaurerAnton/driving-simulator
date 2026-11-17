// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Today's fuel prices: the service's fields to the game's fuels, a station
 * of the map matched to the nearest one of the list, and typical prices
 * where there is none (no key, too far).
 *
 *   node --test tests/world/fuelprices.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FuelPrices, pricesOf } from '../../src/world/fuelprices.ts';

test("the service's prices by the game's fuels (closed or unknown ones left out)", () => {
  assert.deepEqual(pricesOf({ lat: 51, lng: 9, e5: 1.799, e10: 1.739, diesel: 1.659 }), { e5: 1.799, e10: 1.739, diesel: 1.659, hgv: 1.659 });
  assert.deepEqual(pricesOf({ lat: 51, lng: 9, e5: false, e10: null, diesel: 0 }), {});
});

test('a station of the map gets the price of the nearest station of the list – within 150 m only', () => {
  const p = new FuelPrices();
  p.setLive([{ x: 100, z: 100, prices: { e10: 1.699 } }, { x: 1000, z: 0, prices: { e10: 1.759 } }]);
  assert.equal(p.priceAt(130, 90, 'e10'), 1.699);
  assert.equal(p.priceAt(1040, 20, 'e10'), 1.759);
  assert.equal(p.priceAt(500, 500, 'e10'), null, 'none near');
  assert.equal(p.priceAt(100, 100, 'lpg'), null, 'a fuel it does not report');
});

test('without a key nothing is asked', () => {
  let asked = 0;
  const p = new FuelPrices((async () => {
    asked++;
    return new Response('{}');
  }) as typeof fetch);
  p.refresh(0, 0, 1e9);
  assert.equal(asked, 0);
  p.key = 'k';
  p.refresh(0, 0, 1e9);
  p.refresh(10, 0, 1e9 + 1000);
  assert.equal(asked, 1, 'once – not again a second later');
});
