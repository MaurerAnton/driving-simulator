// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The files of a region (src/world/regionfiles.ts): the loader reads a region's
 * map.json / net.bin.gz / w/… from map-assets/regions/<id>/, and gzipped bytes
 * come back inflated.  The world frame is NOT touched – every region was built
 * in the shared frame (geo/utm.ts), so the default serves them.
 *
 *   node --test tests/world/regionfiles.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BAUNATAL_FRAME, worldFrame } from '../../src/geo/utm.ts';
import { regionDir, regionFiles, regionPath, type RegionSource } from '../../src/world/regionfiles.ts';

/** A source that answers from a table of path -> bytes (the paths are in map-assets). */
function table(files: Record<string, Uint8Array>): RegionSource {
  return async (file) => files[file] ?? null;
}

const encoder = new TextEncoder();

test('a file is read from the region’s folder', async () => {
  const map = encoder.encode('{"meta":{"originE":528000,"originN":5678000},"tiles":[],"chunks":[]}');
  const files = regionFiles('bremen', table({ 'regions/bremen/map.json': map }));
  const buf = await files.bytes('map.json');
  assert.ok(buf);
  assert.equal(JSON.parse(new TextDecoder().decode(buf)).meta.originE, 528000);
  // (a file that is not there is null, not an error)
  assert.equal(await files.bytes('net.bin.gz'), null);
});

test('the folder and the path of a file inside it', () => {
  assert.equal(regionDir('hesse'), 'regions/hesse');
  assert.equal(regionPath('hesse', 'net.bin.gz'), 'regions/hesse/net.bin.gz');
  assert.equal(regionPath('hesse', 'w/3_4.json.gz'), 'regions/hesse/w/3_4.json.gz');
});

test('reading a region’s map.json does not move the world frame (regions share it)', async () => {
  const map = encoder.encode('{"meta":{"originE":400000,"originN":5400000},"tiles":[],"chunks":[]}');
  const files = regionFiles('x', table({ 'regions/x/map.json': map }));
  await files.bytes('map.json');
  await files.bytes('map.json'); // (read again: still nothing moves)
  assert.deepEqual(worldFrame(), BAUNATAL_FRAME);
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
