// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The region index the settings read (src/ui/regions.ts): the list of regions
 * of map-assets, fetched from the repository (CORS ok) with the site as a
 * fallback, and a region found by its id.  A repository without regions, or one
 * offline, gives null – only the site's map is offered then.
 *
 *   node --test tests/ui/regions.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RegionIndex } from '../../src/world/regions.ts';
import { findRegion, loadRegionIndex } from '../../src/ui/regions.ts';

const INDEX: RegionIndex = {
  latest: 'hesse',
  regions: [
    { id: 'hesse', name: 'Nordhessen', box: [-65000, -46000, 59000, 60000], map: 'regions/hesse/map.json', tiles: ['1.tar'] },
    { id: 'bremen', name: 'Bremen', box: [-48000, -215000, -31000, -200000], map: 'regions/bremen/map.json', tiles: ['34.tar'] },
  ],
};

/** A fetch that answers the index at the URLs it knows, and 404 elsewhere. */
function fakeFetch(index: unknown | null): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (index !== null && url.endsWith('/regions.json')) {
      return { ok: true, status: 200, json: async () => index } as Response;
    }
    return { ok: false, status: 404, json: async () => null } as Response;
  }) as typeof fetch;
}

test('the index comes from the repository, the site as a fallback', async () => {
  const index = await loadRegionIndex(true, 'map-assets/', fakeFetch(INDEX));
  assert.ok(index);
  assert.equal(index.latest, 'hesse');
  assert.deepEqual(
    index.regions.map((r) => r.id),
    ['hesse', 'bremen'],
  );
});

test('the site alone is enough (no repository)', async () => {
  const index = await loadRegionIndex(false, 'map-assets/', fakeFetch(INDEX));
  assert.ok(index);
  assert.equal(index.regions.length, 2);
});

test('a repository without regions: the site is tried', async () => {
  // the repository 404s (url not ending in regions.json in the fake: raw.githubusercontent …/regions.json DOES end in it,
  // so simulate a repo that answers 404 by a fetch that fails the repo url first)
  const repoFirst: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://raw.githubusercontent.com')) return { ok: false, status: 404, json: async () => null } as Response;
    if (url.endsWith('/regions.json')) return { ok: true, status: 200, json: async () => INDEX } as Response;
    return { ok: false, status: 404, json: async () => null } as Response;
  }) as typeof fetch;
  const index = await loadRegionIndex(true, 'map-assets/', repoFirst);
  assert.ok(index);
  assert.equal(index.regions.length, 2);
});

test('no regions anywhere: null (only the site’s map is offered)', async () => {
  assert.equal(await loadRegionIndex(true, 'map-assets/', fakeFetch(null)), null);
});

test('an unreadable index (not parseable): null, not a crash', async () => {
  const bad: typeof fetch = (async () => ({ ok: true, status: 200, json: async () => 'nope' }) as Response) as typeof fetch;
  assert.equal(await loadRegionIndex(true, 'map-assets/', bad), null);
});

test('a region is found by its id, or null', () => {
  const index = { latest: 'hesse', regions: INDEX.regions };
  assert.equal(findRegion(index, 'bremen')?.name, 'Bremen');
  assert.equal(findRegion(index, 'ghost'), null);
  assert.equal(findRegion(null, 'bremen'), null);
  assert.equal(findRegion(index, ''), null);
});
