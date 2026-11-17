// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The history of the map: the places picked in its search and the ways
 * started, kept on this device – newest first, each once, only so many.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PLACES_KEPT, WAYS_KEPT, loadPlaces, loadWays, savePlace, saveWay } from '../../src/game/history.ts';

// (a stand-in for the browser's storage)
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});

test('places looked for: the newest first, a place picked again moves up, only the last ones are kept', () => {
  store.clear();
  savePlace({ name: 'Marktplatz 1, Baunatal', x: 10, z: 20, yaw: 0 });
  savePlace({ name: 'Königsplatz, Kassel', x: 6700, z: -7056, yaw: 1 });
  savePlace({ name: 'Marktplatz 1, Baunatal', x: 11, z: 21, yaw: 0 });
  assert.deepEqual(loadPlaces().map((p) => p.name), ['Marktplatz 1, Baunatal', 'Königsplatz, Kassel']);
  for (let i = 0; i < 20; i++) savePlace({ name: `Place ${i}`, x: i * 100, z: 0, yaw: 0 });
  assert.equal(loadPlaces().length, PLACES_KEPT);
  assert.equal(loadPlaces()[0].name, 'Place 19');
});

test('ways driven: their places in order, the same way again moves up, broken entries are left out', () => {
  store.clear();
  const a = [{ name: 'A', x: 0, z: 0, yaw: 0 }, { name: 'B', x: 500, z: 0, yaw: 0 }];
  saveWay(a, false);
  saveWay([{ name: 'C', x: 9, z: 9, yaw: 0 }], true);
  saveWay(a, true);
  const ways = loadWays();
  assert.equal(ways.length, 2);
  assert.deepEqual(ways[0].stops.map((s) => s.name), ['A', 'B']);
  assert.equal(ways[0].self, true);
  store.set('fahrsim.ways', JSON.stringify([{ stops: [{ name: 'X', x: 'no', z: 0 }], self: false, date: '' }, ...ways]));
  assert.equal(loadWays().length, 2, 'the broken one is not offered');
  for (let i = 0; i < 15; i++) saveWay([{ name: `W${i}`, x: i, z: 0, yaw: 0 }], false);
  assert.equal(loadWays().length, WAYS_KEPT);
});
