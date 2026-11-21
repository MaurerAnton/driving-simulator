// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The big map's search field: towns, stops and addresses in one list –
 * towns first, the name begun with before the one only containing it.
 *
 *   node --test tests/ui/placesearch.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { searchPlaces } from '../../src/ui/placesearch.ts';

const towns = [
  { name: 'Baunatal', kind: 'town', x: 0, z: 0 },
  { name: 'Kassel', kind: 'city', x: 6700, z: -7000 },
  { name: 'Großenritte', kind: 'suburb', x: -2000, z: 300 },
  { name: 'Altenbauna', kind: 'suburb', x: 500, z: -400 },
];
const stops = [
  { name: 'Rathaus', town: 'Baunatal', x: 100, z: 50 },
  { name: 'Rathaus', town: 'Kassel', x: 6600, z: -7100 },
  { name: 'Großenritte Bahnhof', town: 'Baunatal', x: -2100, z: 200 },
];

test('a town by the beginning of its name, whatever the keyboard makes of the umlaut', () => {
  const hits = searchPlaces('grossenr', towns, stops, null);
  assert.equal(hits[0].label, 'Großenritte');
  assert.equal(hits[0].what, 'town');
  assert.ok(hits.some((h) => h.what === 'stop' && h.label.startsWith('Großenritte Bahnhof')));
});

test('stops by their name, the nearer first, with their town', () => {
  const hits = searchPlaces('rathaus', towns, stops, null, 8, { x: 6000, z: -7000 });
  assert.deepEqual(hits.map((h) => h.label), ['Rathaus, Kassel', 'Rathaus, Baunatal']);
  assert.ok(hits.every((h) => h.what === 'stop'));
  // by town and name
  assert.equal(searchPlaces('baunatal rathaus', towns, stops, null)[0].label, 'Rathaus, Baunatal');
});

test('the addresses come after the towns and the stops, each place once, and at most as many as asked', () => {
  const addresses = (q: string): Array<{ label: string; street: string; x: number; z: number; exact: boolean }> =>
    q.toLowerCase().startsWith('kass') ? [{ label: 'Kasseler Straße, Baunatal', street: 'Kasseler Straße', x: 10, z: 10, exact: false }] : [];
  const hits = searchPlaces('kass', towns, stops, addresses);
  // (Kassel the town, the stop "Rathaus" of Kassel, then the street)
  assert.deepEqual(hits.map((h) => h.what), ['town', 'stop', 'address']);
  assert.equal(searchPlaces('', towns, stops, addresses).length, 0);
  assert.ok(searchPlaces('a', towns, stops, addresses, 2).length <= 2);
});

test('a line number finds the line of public transport', () => {
  const lines = [
    { ref: '5', kind: 'tram' as const, x: 100, z: 50, index: 0 },
    { ref: '52', kind: 'bus' as const, x: 6600, z: -7100, index: 3 },
    { ref: 'N3', kind: 'bus' as const, x: 6700, z: -7000, index: 7 },
  ];
  const hits = searchPlaces('5', towns, stops, null, 8, null, lines);
  const line = hits.find((h) => h.what === 'line');
  assert.ok(line, 'the line 5 is found');
  assert.equal(line.line?.ref, '5');
  assert.equal(line.line?.kind, 'tram');
  assert.equal(line.x, 100); // (where its first stop is)
  // a line number wins over a town that begins with it
  assert.equal(hits[0].what, 'line');
});

test('a line number with letters, and one that matches nothing', () => {
  const lines = [
    { ref: 'N3', kind: 'bus' as const, x: 1, z: 2, index: 0 },
    { ref: '52', kind: 'bus' as const, x: 3, z: 4, index: 1 },
  ];
  const n3 = searchPlaces('n3', towns, stops, null, 8, null, lines).find((h) => h.what === 'line');
  assert.equal(n3?.line?.ref, 'N3');
  // a number no line has: no line hit (but the towns/stops as before)
  const none = searchPlaces('99', towns, stops, null, 8, null, lines);
  assert.ok(!none.some((h) => h.what === 'line'));
});
