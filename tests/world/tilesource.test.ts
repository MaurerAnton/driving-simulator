// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The tiles of map-assets served from a map part instead of the site
 * (world/mappack.ts useTileSource + mapFetch) – the developer mode's delivery
 * of new tiles: a tile the parts hold comes from the part, and a tile they do
 * not falls through to the network, so the ordinary map is untouched.
 *
 * The network is replaced here by a stub, so the tests only exercise the part
 * path (which tile goes where), never a real fetch.
 *
 *   node --test tests/world/tilesource.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mapFetch, useTileSource } from '../../src/world/mappack.ts';

const BASE = 'https://example.org/map/';
const siteTile = new Uint8Array([7, 7, 7]);

/** What the site answers (the network the real game would reach). */
let site: Uint8Array | null = siteTile;
const realFetch = globalThis.fetch;
function stubSite(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (site && url.includes('/tiles/')) return new Response(new Blob([site as BlobPart]), { status: 200 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}
function restoreSite(): void {
  globalThis.fetch = realFetch;
}

test('without a tile source: a tile comes from the site (nothing changes)', async () => {
  stubSite();
  useTileSource(null);
  const res = await mapFetch(`${BASE}tiles/412_398.fsb?v=abc`);
  assert.equal(res.status, 200);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...siteTile]);
  restoreSite();
});

test('a tile the parts hold comes from them, not the site', async () => {
  stubSite();
  const partTile = new Uint8Array([1, 2, 3, 4, 5]);
  useTileSource(async (key) => (key === '412_398' ? partTile : null), BASE);
  const got = await mapFetch(`${BASE}tiles/412_398.fsb?v=abc`);
  assert.equal(got.status, 200);
  assert.deepEqual([...new Uint8Array(await got.arrayBuffer())], [...partTile], 'the part wins');
  // a tile no part holds: the site answers
  const other = await mapFetch(`${BASE}tiles/000_000.fsb?v=abc`);
  assert.deepEqual([...new Uint8Array(await other.arrayBuffer())], [...siteTile], 'falls back to the site');
  useTileSource(null);
  restoreSite();
});

test('every map path goes to the source, which decides; the tile key has its query stripped', async () => {
  stubSite();
  const seen: string[] = [];
  useTileSource(async (key) => {
    seen.push(key);
    return null; // (nothing held: the site answers for all of them)
  }, BASE);
  await mapFetch(`${BASE}map.json?v=abc`);
  await mapFetch(`${BASE}w/50_50.json.gz?v=abc`);
  await mapFetch(`${BASE}tiles/412_398.fsb?v=abc&x=1`);
  // the source is asked for each map path; a tile's key loses its query
  assert.deepEqual(seen, ['map.json', 'w/50_50.json.gz', '412_398']);
  useTileSource(null);
  restoreSite();
});

test('a part that does not have the tile: the site is asked (no false 404)', async () => {
  stubSite();
  useTileSource(async () => null, BASE);
  const res = await mapFetch(`${BASE}tiles/412_398.fsb`);
  assert.equal(res.status, 200, 'the site answered, the part did not claim it');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...siteTile]);
  useTileSource(null);
  restoreSite();
});

test('a network chunk and the net are served from a part too, by their path in the map', async () => {
  stubSite();
  const net = new Uint8Array([1, 2, 3]);
  const chunk = new Uint8Array([4, 5]);
  useTileSource(async (path) => {
    if (path === 'net.bin.gz') return net;
    if (path === 'w/50_49.json.gz') return chunk;
    return null;
  }, BASE);
  const n = await mapFetch(`${BASE}net.bin.gz?v=abc`);
  assert.deepEqual([...new Uint8Array(await n.arrayBuffer())], [...net], 'the net, query stripped');
  const c = await mapFetch(`${BASE}w/50_49.json.gz?v=abc`);
  assert.deepEqual([...new Uint8Array(await c.arrayBuffer())], [...chunk], 'a network chunk');
  // a file no part holds: the site
  const other = await mapFetch(`${BASE}w/99_99.json.gz`);
  assert.equal(other.status, 404, 'the site decides (404 here)');
  useTileSource(null);
  restoreSite();
});

test('a URL outside the map folder is not read for a path (the part is not asked)', async () => {
  stubSite();
  const seen: string[] = [];
  useTileSource(async (path) => {
    seen.push(path);
    return new Uint8Array([7]);
  }, BASE);
  const res = await mapFetch('https://other.org/elsewhere/net.bin.gz');
  assert.equal(res.status, 404, 'not intercepted: the stub answers 404');
  assert.deepEqual(seen, [], 'the source was never asked');
  useTileSource(null);
  restoreSite();
});
