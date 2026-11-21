// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Loading a region end to end (world/regionfiles.ts + world/loader.ts): the
 * loader reads a region's map.json / net.bin.gz / w/… from map-assets/regions/,
 * and the world builds with its extent.  The world frame is the shared one
 * every region was built in – loading one does not move it.
 *
 *   node --test tests/world/regionload.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BAUNATAL_FRAME, worldFrame } from '../../src/geo/utm.ts';
import { MapLoader } from '../../src/world/loader.ts';
import { regionFiles, type RegionSource } from '../../src/world/regionfiles.ts';

const encoder = new TextEncoder();

/** A source answering from a table (paths are inside map-assets/regions/<id>/). */
function table(files: Record<string, Uint8Array>): RegionSource {
  return async (file) => files[file] ?? null;
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

test('a region’s map.json builds its world, and the shared frame stays', async () => {
  const mapJson = {
    version: 'r1',
    meta: { name: 'Bremen', minX: 100000, maxX: 130000, minZ: 200000, maxZ: 230000, tileSize: 500, originE: 528000, originN: 5678000 },
    places: [],
    spawns: [],
    tiles: { bits: 'AA==', x0: 0, z0: 0, w: 1, h: 1 },
    chunks: { bits: 'AA==', x0: 0, z0: 0, w: 1, h: 1 },
    nodes: 0,
    edges: 0,
  };
  const files = regionFiles('bremen', table({ 'regions/bremen/map.json': jsonBytes(mapJson) }));
  const map = await MapLoader.open(files);
  // the world is the region's: its extent, its name
  assert.equal(map.world.json.meta.name, 'Bremen');
  assert.equal(map.world.json.meta.minX, 100000);
  assert.equal(map.pieces, true);
  // the shared frame every region was built in is untouched
  assert.deepEqual(worldFrame(), BAUNATAL_FRAME);
});

test('a region with a one-piece map (no chunks) still builds', async () => {
  const worldJson = {
    version: 'r1',
    meta: { name: 'Small', minX: 0, maxX: 1000, minZ: 0, maxZ: 1000, tileSize: 500, originE: 528000, originN: 5678000 },
    nodes: [],
    edges: [],
    banned: [],
    signals: [],
    crossings: [],
    places: [],
    spawns: [],
    tiles: [],
  };
  const files = regionFiles('small', table({ 'regions/small/world.json': jsonBytes(worldJson) }));
  const map = await MapLoader.open(files);
  assert.equal(map.pieces, false);
  assert.equal(map.world.json.meta.name, 'Small');
  assert.deepEqual(worldFrame(), BAUNATAL_FRAME);
});

test('a region with no map.json and no world.json fails the way the site’s map does', async () => {
  const files = regionFiles('ghost', table({}));
  await assert.rejects(() => MapLoader.open(files), /map is missing/i);
});
