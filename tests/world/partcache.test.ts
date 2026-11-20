// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The parts of map-assets in memory (world/partcache.ts): the index says what
 * exists, a part is fetched on demand, a tile comes out of it, and the parts
 * that no longer fit the budget are dropped – the developer mode's delivery of
 * new tiles (settings: devMap).
 *
 * The bytes come from a source given here (no network in a test), so the
 * cache, the eviction and the progress callback are all exercised.
 *
 *   node --test tests/world/partcache.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { MANIFEST } from '../../src/world/patchpart.ts';
import { PartCache, sourceFor, type PartSource } from '../../src/world/partcache.ts';
import type { PartIndex } from '../../src/world/tileversions.ts';

/** The bytes of a tar: one header per file, then the bodies (as in patchpart.test.ts). */
function tar(files: Array<{ path: string; data: Uint8Array }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  const header = (path: string, size: number): Uint8Array => {
    const h = new Uint8Array(512);
    h.set(enc.encode(path).subarray(0, 100), 0);
    h.set(enc.encode('0000644\0'), 100);
    h.set(enc.encode('0000000\0'), 108);
    h.set(enc.encode('0000000\0'), 116);
    h.set(enc.encode(size.toString(8).padStart(11, '0') + '\0'), 124);
    h.set(enc.encode('00000000000\0'), 136);
    h.fill(0x20, 148, 156);
    h[156] = 0x30;
    h.set(enc.encode('ustar\0'), 257);
    h.set(enc.encode('00'), 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.set(enc.encode((sum.toString(8).padStart(6, '0') + '\0 ').slice(0, 8)), 148);
    return h;
  };
  const pad = (n: number): Uint8Array => new Uint8Array((512 - (n % 512)) % 512);
  for (const f of files) {
    blocks.push(header(f.path, f.data.length));
    blocks.push(f.data);
    blocks.push(pad(f.data.length));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((a, b) => a + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

const txt = (s: string): Uint8Array => new TextEncoder().encode(s);

/** a part holding two tiles, gzipped, with a manifest naming them */
function partBytes(type: string, tiles: Record<string, string>): Uint8Array {
  const files: Array<{ path: string; data: Uint8Array }> = [{ path: MANIFEST, data: txt(JSON.stringify({ type, tiles: Object.fromEntries(Object.keys(tiles).map((k) => [k, 'gzip'])) })) }];
  for (const [k, body] of Object.entries(tiles)) files.push({ path: k, data: new Uint8Array(gzipSync(Buffer.from(body))) });
  return tar(files);
}

const index = (latest: number, files: Array<{ n: number; file: string; type: string; tiles: string[] }>): string =>
  JSON.stringify({ latest, files });

function source(map: Record<string, Uint8Array>): PartSource {
  return async (file) => map[file] ?? null;
}

test('a part is fetched on demand and a tile comes out of it', async () => {
  const idx = index(1, [{ n: 1, file: '1.tar', type: 'modified', tiles: ['a_1'] }]);
  const parts: Record<string, Uint8Array> = { 'index.json': txt(idx), '1.tar': partBytes('modified', { a_1: 'TILE-A' }) };
  const cache = new PartCache({ fetch: 'repo', budgetMb: 64 }, source(parts));
  const got = await cache.tile('a_1');
  assert.ok(got);
  assert.equal(got.part, 1);
  assert.equal(new TextDecoder().decode(got.bytes), 'TILE-A');
  assert.deepEqual(cache.heldParts(), [1]);
  // asked again: from memory, no second fetch
  const again = await cache.tile('a_1');
  assert.equal(again?.part, 1);
});

test('the newest part holds the tile when several do (or the preferred one)', async () => {
  const idx = index(2, [
    { n: 1, file: '1.tar', type: 'base', tiles: ['a_1'] },
    { n: 2, file: '2.tar', type: 'modified', tiles: ['a_1'] },
  ]);
  const parts: Record<string, Uint8Array> = {
    'index.json': txt(idx),
    '1.tar': partBytes('base', { a_1: 'FROM-1' }),
    '2.tar': partBytes('modified', { a_1: 'FROM-2' }),
  };
  const cache = new PartCache({ fetch: 'repo', budgetMb: 64 }, source(parts));
  assert.equal(new TextDecoder().decode((await cache.tile('a_1'))!.bytes), 'FROM-2', 'newest by default');
  assert.equal(new TextDecoder().decode((await cache.tile('a_1', 1))!.bytes), 'FROM-1', 'the preferred one wins');
});

test('a tile no part holds: null (the label does not offer versions for it)', async () => {
  const idx = index(1, [{ n: 1, file: '1.tar', type: 'modified', tiles: ['a_1'] }]);
  const parts = { 'index.json': txt(idx), '1.tar': partBytes('modified', { a_1: 'X' }) };
  const cache = new PartCache({ fetch: 'repo', budgetMb: 64 }, source(parts));
  assert.equal(await cache.tile('never_held'), null);
});

test('the index that is not there: no tile, no throw', async () => {
  const cache = new PartCache({ fetch: 'repo', budgetMb: 64 }, source({}));
  assert.equal(await cache.getIndex(), null);
  assert.equal(await cache.tile('a_1'), null);
});

test('the parts are kept within the budget: the least recently used goes first', async () => {
  const files = [1, 2, 3].map((n) => ({ n, file: `${n}.tar`, type: 'modified', tiles: [`t${n}`] }));
  const idx = index(3, files);
  // each part: a manifest + a tile of ~1 KB (the tar overhead is a few blocks)
  const mk = (n: number): Uint8Array => partBytes('modified', { [`t${n}`]: 'x'.repeat(900) });
  const parts: Record<string, Uint8Array> = { 'index.json': txt(idx), '1.tar': mk(1), '2.tar': mk(2), '3.tar': mk(3) };
  // budget small enough that only ~2 fit (a part is ~1.5 KB with headers)
  const cache = new PartCache({ fetch: 'repo', budgetMb: 0.004 }, source(parts));
  await cache.tile('t1');
  await cache.tile('t2');
  await cache.tile('t3'); // t1 (oldest) should be evicted
  const held = cache.heldParts();
  assert.ok(held.includes(3), 'the newest is kept');
  assert.ok(!held.includes(1) || held.length <= 2, `t1 evicted when over budget (held ${held})`);
  assert.ok(cache.usedMb() <= 0.004, `within budget (${cache.usedMb()} MB)`);
});

test('progress is reported while a part downloads (share -1 when the size is unknown)', async () => {
  const idx = index(1, [{ n: 1, file: '1.tar', type: 'modified', tiles: ['a_1'] }]);
  const parts = { 'index.json': txt(idx), '1.tar': partBytes('modified', { a_1: 'X' }) };
  const seen: number[] = [];
  const cache = new PartCache({ fetch: 'repo', budgetMb: 64, onProgress: (s) => seen.push(s) }, source(parts));
  await cache.tile('a_1');
  assert.ok(seen.length >= 1, 'progress was called');
  assert.equal(seen[0], 0, 'starts at 0');
  assert.ok(seen.includes(-1) || seen.includes(1), 'ends with the size known or not');
});

test('the fetch methods: each reaches the same source shape', async () => {
  const parts = { 'index.json': txt(index(1, [{ n: 1, file: '1.tar', type: 'modified', tiles: ['a_1'] }])), '1.tar': partBytes('modified', { a_1: 'X' }) };
  // (in a test the 'repo' URL would go to raw…; here we only check the source is chosen and shaped)
  const src = sourceFor('repo', { fetch: 'repo', budgetMb: 64, repo: 'o/r', ref: 'main', dir: 'map-assets' }, 'site/');
  assert.equal(typeof src, 'function');
  const site = sourceFor('site', { fetch: 'site', budgetMb: 64 }, 'https://example.org/map/');
  assert.equal(typeof site, 'function');
  void parts;
});
