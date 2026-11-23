// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where the player is, from the IP address (ui/geoip.ts): no permission asked,
 * the region whose box holds the place.  The service is mocked; the projection
 * and the box test are the game's own.
 *
 *   node --test tests/ui/geoip.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ipPlace, ipRegion } from '../../src/ui/geoip.ts';
import { latLonToWorld } from '../../src/geo/utm.ts';
import type { RegionIndex } from '../../src/world/regions.ts';

const fetchOf = (json: unknown, ok = true): typeof fetch => (async () => ({ ok, json: async () => json }) as Response) as typeof fetch;

test('the place of an IP address, from the service', async () => {
  const place = await ipPlace(fetchOf({ latitude: 50.11, longitude: 8.68, success: true }));
  assert.deepEqual(place, { lat: 50.11, lon: 8.68 });
});

test('no coordinates, a refusal or a failure: no place, no throwing', async () => {
  assert.equal(await ipPlace(fetchOf({ success: false })), null);
  assert.equal(await ipPlace(fetchOf({ latitude: 'x', longitude: 8 })), null);
  assert.equal(await ipPlace(fetchOf({}, false)), null);
  assert.equal(
    await ipPlace((async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch),
    null,
  );
});

test('the region whose box holds the place, and none for a place outside', () => {
  const [x, z] = latLonToWorld(50.11, 8.68); // (Hesse)
  const index: RegionIndex = {
    latest: 'suedost',
    regions: [
      { id: 'suedost', name: 'Südost-Hessen', box: [x - 1000, z - 1000, x + 1000, z + 1000], map: 'regions/suedost/map.json', tiles: [] },
    ],
  };
  assert.equal(ipRegion(index, { lat: 50.11, lon: 8.68 })?.id, 'suedost');
  const [farX, farZ] = latLonToWorld(48.0, 11.0); // (Bavaria, far away)
  assert.equal(ipRegion(index, { lat: 48.0, lon: 11.0 }) ? 'in' : 'none', 'none');
  assert.ok(!((farX >= x - 1000 && farX <= x + 1000) && (farZ >= z - 1000 && farZ <= z + 1000)));
  // (no index, no place: no region)
  assert.equal(ipRegion(null, { lat: 50, lon: 8 }), null);
  assert.equal(ipRegion(index, null), null);
});
