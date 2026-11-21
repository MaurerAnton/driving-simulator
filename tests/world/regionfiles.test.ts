// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The files of a region (src/world/regionfiles.ts): the loader reads a region's
 * map.json / net.bin.gz / w/… from map-assets/regions/<id>/, the first map.json
 * sets the world frame to the region's own origin, and gzipped bytes come back
 * inflated.
 *
 *   node --test tests/world/regionfiles.test.ts
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { resetWorldOrigin, worldFrame } from '../../src/geo/utm.ts';
import { regionDir, regionFiles, regionPath, type RegionSource } from '../../src/world/regionfiles.ts';

afterEach(() => resetWorldOrigin());

/** A source that answers from a table of path -> bytes (the paths are in map-assets). */
function table(files: Record<string, Uint8Array>): RegionSource {
  return async (file) => files[file] ?? null;
}

const encoder = new TextEncoder();

test('a file is read from the region’s folder', async () => {
  const map = encoder.encode('{"meta":{"originE":1,"originN":2},"tiles":[],"chunks":[]}');
  const files = regionFiles('bremen', table({ 'regions/bremen/map.json': map }));
  const buf = await files.bytes('map.json');
  assert.ok(buf);
  assert.equal(JSON.parse(new TextDecoder().decode(buf)).meta.originE, 1);
  // (a file that is not there is null, not an error)
  assert.equal(await files.bytes('net.bin.gz'), null);
});

test('the folder and the path of a file inside it', () => {
  assert.equal(regionDir('hesse'), 'regions/hesse');
  assert.equal(regionPath('hesse', 'net.bin.gz'), 'regions/hesse/net.bin.gz');
  assert.equal(regionPath('hesse', 'w/3_4.json.gz'), 'regions/hesse/w/3_4.json.gz');
});

test('the first map.json sets the world frame to the region’s origin', async () => {
  const map = encoder.encode('{"meta":{"originE":400000,"originN":5400000},"tiles":[],"chunks":[]}');
  const files = regionFiles('x', table({ 'regions/x/map.json': map }), 33);
  await files.bytes('map.json');
  const f = worldFrame();
  assert.equal(f.originE, 400000);
  assert.equal(f.originN, 5400000);
  assert.equal(f.zone, 33);
});

test('the frame is set once, even if map.json is read again', async () => {
  const map = encoder.encode('{"meta":{"originE":10,"originN":20},"tiles":[],"chunks":[]}');
  const files = regionFiles('x', table({ 'regions/x/map.json': map }), 32);
  await files.bytes('map.json');
  // (move the frame, read map.json again: it must not move it back)
  const { setWorldOrigin } = await import('../../src/geo/utm.ts');
  setWorldOrigin(999, 888, 40);
  await files.bytes('map.json');
  assert.equal(worldFrame().originE, 999);
});

test('a map.json with no origin leaves the frame as it was', async () => {
  const { setWorldOrigin } = await import('../../src/geo/utm.ts');
  setWorldOrigin(7, 8, 32);
  const map = encoder.encode('{"meta":{"name":"no origin"},"tiles":[],"chunks":[]}');
  const files = regionFiles('x', table({ 'regions/x/map.json': map }));
  await files.bytes('map.json');
  assert.equal(worldFrame().originE, 7);
});

test('an unreadable map.json leaves the frame as it was (the loader reports it)', async () => {
  const { setWorldOrigin } = await import('../../src/geo/utm.ts');
  setWorldOrigin(7, 8, 32);
  const files = regionFiles('x', table({ 'regions/x/map.json': new Uint8Array([1, 2, 3]) }));
  // (the bytes come back as they are; the frame is not set – the loader's readJson reports the bad index)
  const buf = await files.bytes('map.json');
  assert.ok(buf);
  assert.equal(worldFrame().originE, 7);
});

test('gzipped bytes come back inflated', async () => {
  const plain = encoder.encode('{"rails":[]}');
  const gz = new Uint8Array(
    await new Response(
      new Blob([plain as BlobPart]).stream().pipeThrough(
        new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
      ),
    ).arrayBuffer(),
  );
  const files = regionFiles('x', table({ 'regions/x/rails.json.gz': gz }));
  const buf = await files.bytes('rails.json.gz');
  assert.ok(buf);
  assert.equal(new TextDecoder().decode(buf), '{"rails":[]}');
});

test('bytes that are not gzipped are returned as they are', async () => {
  const raw = new Uint8Array([0x00, 0x11, 0x22, 0x33]);
  const files = regionFiles('x', table({ 'regions/x/far.bin.gz': raw }));
  const buf = await files.bytes('far.bin.gz');
  assert.ok(buf);
  assert.deepEqual([...new Uint8Array(buf)], [0x00, 0x11, 0x22, 0x33]);
});
