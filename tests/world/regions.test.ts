// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The index of regions (src/world/regions.ts): what the game reads to know
 * which maps exist besides its own, which one is the default, and where each
 * one's files are.
 *
 *   node --test tests/world/regions.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REGIONS_DIR, boxContains, defaultRegion, parseRegions, regionAt, regionById, regionMapPath } from '../../src/world/regions.ts';

const HESSE = { id: 'hesse', name: 'Nordhessen', box: [-65000, -46000, 59000, 60000], map: 'regions/hesse/map.json', tiles: ['1.tar', '2.tar'] };
const BREMEN = { id: 'bremen', name: 'Bremen', box: [100000, 200000, 130000, 230000], map: 'regions/bremen/map.json', tiles: ['34.tar'] };

test('the index keeps the regions it can read, in order', () => {
  const index = parseRegions({ latest: 'bremen', regions: [HESSE, BREMEN] });
  assert.ok(index);
  assert.equal(index.latest, 'bremen');
  assert.deepEqual(
    index.regions.map((r) => r.id),
    ['hesse', 'bremen'],
  );
});

test('a region without a box or an id is left out, the rest still read', () => {
  const index = parseRegions({
    latest: 'hesse',
    regions: [HESSE, { id: 'broken', name: 'no box' }, { name: 'no id', box: [0, 0, 1, 1] }, null, 7],
  });
  assert.ok(index);
  assert.deepEqual(
    index.regions.map((r) => r.id),
    ['hesse'],
  );
  assert.equal(index.latest, 'hesse');
});

test('a duplicate id is kept once (the first wins)', () => {
  const index = parseRegions({ latest: 'a', regions: [{ ...HESSE, id: 'a' }, { ...HESSE, id: 'a', name: 'second' }] });
  assert.ok(index);
  assert.equal(index.regions.length, 1);
  assert.equal(index.regions[0].name, HESSE.name);
});

test('a missing name falls back to the id; a missing map path is derived from the id', () => {
  const index = parseRegions({ regions: [{ id: 'x', box: [0, 0, 1, 1] }] });
  assert.ok(index);
  assert.equal(index.regions[0].name, 'x');
  assert.equal(index.regions[0].map, regionMapPath('x'));
  assert.equal(regionMapPath('x'), `${REGIONS_DIR}/x/map.json`);
});

test('the tiles are the strings among them, anything else dropped', () => {
  const index = parseRegions({ regions: [{ id: 'x', box: [0, 0, 1, 1], tiles: ['1.tar', 3, null, '2.tar'] }] });
  assert.ok(index);
  assert.deepEqual(index.regions[0].tiles, ['1.tar', '2.tar']);
});

test('no index, an empty one, or a bad one is null – not a crash', () => {
  assert.equal(parseRegions(null), null);
  assert.equal(parseRegions(undefined), null);
  assert.equal(parseRegions('nope'), null);
  assert.equal(parseRegions({}), null);
  assert.equal(parseRegions({ regions: 'nope' }), null);
  assert.equal(parseRegions({ latest: 'x', regions: [] })?.regions.length, 0);
});

test('the default is the named region, else the first', () => {
  const index = parseRegions({ latest: 'bremen', regions: [HESSE, BREMEN] });
  assert.equal(defaultRegion(index)?.id, 'bremen');
  const noLatest = parseRegions({ regions: [HESSE, BREMEN] });
  assert.equal(defaultRegion(noLatest)?.id, HESSE.id);
  // a default naming a region that is not there falls back to the first
  const badLatest = parseRegions({ latest: 'ghost', regions: [HESSE, BREMEN] });
  assert.equal(defaultRegion(badLatest)?.id, HESSE.id);
  assert.equal(defaultRegion(null), null);
});

test('a region is found by its id, or null', () => {
  const index = parseRegions({ regions: [HESSE, BREMEN] });
  assert.equal(regionById(index, 'bremen')?.id, 'bremen');
  assert.equal(regionById(index, 'ghost'), null);
  assert.equal(regionById(null, 'bremen'), null);
});

test('a point is inside a region when it lies in its box', () => {
  const box: [number, number, number, number] = [0, 0, 100, 100];
  assert.ok(boxContains(box, 50, 50));
  assert.ok(boxContains(box, 0, 0)); // the corner is inside
  assert.ok(boxContains(box, 100, 100));
  assert.ok(!boxContains(box, -1, 50));
  assert.ok(!boxContains(box, 101, 50));
  assert.ok(!boxContains(box, 50, -1));
});

test('the region a point lies in is the one whose box holds it', () => {
  const index = parseRegions({ regions: [HESSE, BREMEN] });
  assert.equal(regionAt(index, 0, 0)?.id, HESSE.id); // in Hesse's box
  assert.equal(regionAt(index, 110000, 210000)?.id, BREMEN.id); // in Bremen's
  assert.equal(regionAt(index, 999999, 999999), null); // in neither
  assert.equal(regionAt(null, 0, 0), null);
});
