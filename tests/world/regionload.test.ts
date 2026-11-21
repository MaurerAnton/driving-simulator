// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Loading a region end to end (world/regionfiles.ts + world/loader.ts): the
 * loader reads a region's map.json / net.bin.gz / w/… from map-assets/regions/,
 * the first map.json sets the world frame to the region's own origin, and the
 * world builds with its extent.
 *
 *   node --test tests/world/regionload.test.ts
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { resetWorldOrigin, worldFrame } from '../../src/geo/utm.ts';
import { MapLoader } from '../../src/world/loader.ts';
import { regionFiles, type RegionSource } from '../../src/world/regionfiles.ts';

afterEach(() => resetWorldOrigin());

const encoder = new TextEncoder();

/** A source answering from a table (paths are inside map-assets/regions/<id>/). */
function table(files: Record<string, Uint8Array>): RegionSource {
  return async (file) => files[file] ?? null;
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

test('a region’s map.json builds its world, and its origin sets the frame', async () => {
  const mapJson = {
    version: 'r1',
    meta: { name: 'Bremen', minX: 100000, maxX: 130000, minZ: 200000, maxZ: 230000, tileSize: 500, originE: 400000, originN: 5400000 },
    places: [],
    spawns: [],
    tiles: { bits: 'AA==', x0: 0, z0: 0, w: 1, h: 1 },
    chunks: { bits: 'AA==', x0: 0, z0: 0, w: 1, h: 1 },
    nodes: 0,
    edges: 0,
  };
  const files = regionFiles('bremen', table({ 'regions/bremen/map.json': jsonBytes(mapJson) }), 33);
  const map = await MapLoader.open(files);
  // the world is the region's: its extent, its name
  assert.equal(map.world.json.meta.name, 'Bremen');
  assert.equal(map.world.json.meta.minX, 100000);
  assert.equal(map.pieces, true);
  // the frame is the region's origin, in its zone
  const f = worldFrame();
  assert.equal(f.originE, 400000);
  assert.equal(f.originN, 5400000);
  assert.equal(f.zone, 33);
});

test('a region with a one-piece map (no chunks) still builds', async () => {
  const worldJson = {
    version: 'r1',
    meta: { name: 'Small', minX: 0, maxX: 1000, minZ: 0, maxZ: 1000, tileSize: 500, originE: 10, originN: 20 },
    nodes: [],
    edges: [],
    banned: [],
    signals: [],
    crossings: [],
    places: [],
    spawns: [],
    tiles: [],
  };
  const files = regionFiles('small', table({ 'regions/small/world.json': jsonBytes(worldJson) }), 32);
  const map = await MapLoader.open(files);
  assert.equal(map.pieces, false);
  assert.equal(map.world.json.meta.name, 'Small');
  // (a one-piece map's origin is in its world.json meta: regionFiles sets the frame from it too)
  const f = worldFrame();
  assert.equal(f.originE, 10);
  assert.equal(f.originN, 20);
  assert.equal(f.zone, 32);
});

test('a region with no map.json and no world.json fails the way the site’s map does', async () => {
  const files = regionFiles('ghost', table({}), 32);
  await assert.rejects(() => MapLoader.open(files), /map is missing/i);
});
