// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The world frame and the projection (src/geo/utm.ts): a UTM zone for any
 * longitude, and an origin the active map sets – so a map anywhere in the world
 * (Italy, France, east Germany) projects correctly instead of being forced
 * through zone 32 and Baunatal's origin.
 *
 *   node --test tests/geo/utm.test.ts
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  BAUNATAL_FRAME,
  latLonToUtm,
  latLonToUtm32,
  latLonToWorld,
  lon0ForZone,
  resetWorldOrigin,
  setWorldOrigin,
  utmToLatLon,
  utm32ToLatLon,
  worldFrame,
  worldToLatLon,
  worldToUtm,
  zoneForLon,
} from '../../src/geo/utm.ts';

afterEach(() => resetWorldOrigin());

test('the zone of a longitude is the 6° band it lies in', () => {
  assert.equal(zoneForLon(9.5), 32); // Baunatal
  assert.equal(zoneForLon(6), 32); // 6°E is the start of zone 32 (bands are [start, start+6))
  assert.equal(zoneForLon(5.999), 31); // just west of it
  assert.equal(zoneForLon(11.999), 32); // just inside zone 32's east edge
  assert.equal(zoneForLon(13.4), 33); // Berlin
  assert.equal(zoneForLon(-9.5), 29); // Spain
  assert.equal(zoneForLon(-122), 10); // San Francisco
});

test('the central meridian of a zone is the middle of its 6° of longitude', () => {
  // zone 32 covers 6°E…12°E, central meridian 9°E
  assert.ok(Math.abs(lon0ForZone(32) - (9 * Math.PI) / 180) < 1e-12);
  // zone 33 covers 12°E…18°E, central meridian 15°E
  assert.ok(Math.abs(lon0ForZone(33) - (15 * Math.PI) / 180) < 1e-12);
  // zone 1 covers 180°W…174°W, central meridian 177°W
  assert.ok(Math.abs(lon0ForZone(1) - (-177 * Math.PI) / 180) < 1e-12);
});

test('a place projects and comes back, in its own zone', () => {
  // Baunatal (zone 32)
  const [e, n] = latLonToUtm(51.3125, 9.4994, 32);
  const [lat, lon] = utmToLatLon(e, n, 32);
  assert.ok(Math.abs(lat - 51.3125) < 1e-6);
  assert.ok(Math.abs(lon - 9.4994) < 1e-6);
  // Berlin (zone 33) – would be wrong through zone 32
  const [e33, n33] = latLonToUtm(52.52, 13.4, 33);
  const [la, lo] = utmToLatLon(e33, n33, 33);
  assert.ok(Math.abs(la - 52.52) < 1e-6);
  assert.ok(Math.abs(lo - 13.4) < 1e-6);
  // a place in France (Paris-ish longitude, its own zone)
  const zoneFR = zoneForLon(4.9);
  const [ef, nf] = latLonToUtm(48.86, 4.9, zoneFR);
  const [lf, lof] = utmToLatLon(ef, nf, zoneFR);
  assert.ok(Math.abs(lf - 48.86) < 1e-6);
  assert.ok(Math.abs(lof - 4.9) < 1e-6);
});

test('the zone-32 functions are the zone-32 case of the general ones', () => {
  const a = latLonToUtm32(51.3125, 9.4994);
  const b = latLonToUtm(51.3125, 9.4994, 32);
  assert.deepEqual(a, b);
  const c = utm32ToLatLon(a[0], a[1]);
  const d = utmToLatLon(b[0], b[1], 32);
  assert.deepEqual(c, d);
});

test('the world frame starts as Baunatal’s', () => {
  assert.deepEqual(worldFrame(), BAUNATAL_FRAME);
  // the frame's origin (E528000 N5678000) is world (0,0)
  const [olat,olon] = utm32ToLatLon(528000, 5678000);
  const [x, z] = latLonToWorld(olat, olon);
  assert.ok(Math.abs(x) < 1e-3 && Math.abs(z) < 1e-3, `the origin is world (0,0): ${x}, ${z}`);
});

test('setting the origin moves the frame – a world point is relative to it', () => {
  setWorldOrigin(400000, 5400000, 32);
  assert.equal(worldFrame().originE, 400000);
  assert.equal(worldFrame().zone, 32);
  // worldToUtm and utmToWorld are inverses about the new origin
  const [e, n] = worldToUtm(100, 200);
  assert.deepEqual([e, n], [400100, 5399800]);
  const [x, z] = latLonToWorld(...(() => {
    const [la, lo] = utmToLatLon(400100, 5399800, 32);
    return [la, lo] as [number, number];
  })());
  assert.ok(Math.abs(x - 100) < 1e-3 && Math.abs(z - 200) < 1e-3, `round trip: ${x}, ${z}`);
});

test('the frame’s zone is used for lat/lon conversion', () => {
  setWorldOrigin(400000, 5400000, 33); // a frame in zone 33 (east Germany)
  // a point 100 m east, 200 m south of the origin, converted to lat/lon in zone 33
  const [lat, lon] = worldToLatLon(100, 200);
  // its easting/northing in zone 33: 400100, 5399800
  const [lat2, lon2] = utmToLatLon(400100, 5399800, 33);
  assert.ok(Math.abs(lat - lat2) < 1e-9 && Math.abs(lon - lon2) < 1e-9);
});

test('reset puts the frame back to Baunatal’s', () => {
  setWorldOrigin(1, 2, 40);
  resetWorldOrigin();
  assert.deepEqual(worldFrame(), BAUNATAL_FRAME);
  const [e, n] = worldToUtm(0, 0);
  assert.deepEqual([e, n], [528000, 5678000]);
});

test('utmToWorld / worldToUtm stay inverses under any frame', () => {
  setWorldOrigin(123456, 6543210, 32);
  for (const [x, z] of [
    [0, 0],
    [123.5, -987.25],
    [-50000, 60000],
  ]) {
    const [e, n] = worldToUtm(x, z);
    const [x2, z2] = [e - 123456, 6543210 - n];
    assert.equal(x2, x);
    assert.equal(z2, z);
  }
});
