// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The ground cover with smooth edges (tools/mapgen/cover.ts, src/render/coveredge.ts),
 * dry basins and streams by their width, the open ground of shopping areas,
 * and the buildings of the aerial-photo overlay (tools/mapgen/buildings.ts, observed.ts).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { COVER } from '../../src/world/cover.ts';
import { coverEdgeAlpha, coverEdgeMetres } from '../../src/render/coveredge.ts';
import { BS } from '../../src/world/tilefmt.ts';
import { CoverMap, EDGE_MAX, buildCover, dryBasin, edgeByte, edgeMetres, waterwayWidth } from '../../tools/mapgen/cover.ts';
import { addLod2Buildings, addOsmBuildings, flattenRoof } from '../../tools/mapgen/buildings.ts';
import type { BuildingStats } from '../../tools/mapgen/buildings.ts';
import { TileSet } from '../../tools/mapgen/meshacc.ts';
import { loadObserved, loadObservedEdits } from '../../tools/mapgen/observed.ts';
import { OsmData } from '../../tools/mapgen/osm.ts';
import type { Tags } from '../../tools/mapgen/osm.ts';
import { TerrainGrid } from '../../tools/mapgen/terrain.ts';

/** OSM data from closed or open ways given as world points. */
function osmOf(ways: Array<{ tags: Tags; pts: Array<[number, number]>; closed?: boolean }>): OsmData {
  const d = new OsmData();
  let nid = 1;
  ways.forEach((w, k) => {
    const refs: number[] = [];
    for (const [x, z] of w.pts) {
      d.nodes.set(nid, { id: nid, x, z, tags: null });
      refs.push(nid++);
    }
    if (w.closed) refs.push(refs[0]);
    const way = { id: 100 + k, refs, tags: w.tags };
    d.ways.push(way);
    d.wayById.set(way.id, way);
  });
  return d;
}

const rect = (x0: number, z0: number, x1: number, z1: number): Array<[number, number]> => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
];

test('cover edges: the distance of each centre to a slanted edge, as the renderer reads it', () => {
  const c = new CoverMap(0, 0, 40, 40, 2, 3);
  c.fillAll(COVER.MEADOW);
  // a field west of the line x = 10 + 0.3 z
  c.paint([[0, 0, 10, 0, 22, 40, 0, 40]], COVER.FARMLAND);
  c.finish();
  assert.equal(c.fine, null);
  assert.ok(c.edge);
  const edge = c.edge as Uint8Array;
  const n = Math.hypot(1, 0.3);
  let worst = 0;
  for (let j = 0; j < c.h; j++) {
    for (let i = 0; i < c.w; i++) {
      const x = i * 2 + 1;
      const z = j * 2 + 1;
      const inside = x < 10 + 0.3 * z;
      assert.equal(c.data[j * c.w + i], inside ? COVER.FARMLAND : COVER.MEADOW, `cell ${i},${j}`);
      const truth = Math.min(EDGE_MAX, Math.abs(x - 10 - 0.3 * z) / n);
      worst = Math.max(worst, Math.abs(edgeMetres(edge[j * c.w + i]) - truth));
    }
  }
  // (the fine raster has cells of 2/3 m: the distances are good to about half of that)
  assert.ok(worst < 0.45, `worst ${worst}`);
  // the byte → alpha → metres way of the shader gives the same metres
  for (let b = 1; b <= edgeByte(EDGE_MAX); b++) assert.ok(Math.abs(coverEdgeMetres(coverEdgeAlpha(b) / 255) - edgeMetres(b)) < 1e-9);
  assert.equal(coverEdgeAlpha(0), 0);
});

test('cover edges: a line painted after finish() keeps the distances up to date', () => {
  const c = new CoverMap(0, 0, 40, 40, 2, 3);
  c.fillAll(COVER.MEADOW);
  c.finish();
  c.paintLine([0, 20, 40, 20], 3, COVER.RAILWAY);
  const at = (x: number, z: number): number => Math.floor(z / 2) * c.w + Math.floor(x / 2);
  assert.equal(c.data[at(11, 21)], COVER.RAILWAY);
  assert.equal(c.data[at(11, 23)], COVER.MEADOW);
  assert.ok(Math.abs(edgeMetres((c.edge as Uint8Array)[at(11, 21)]) - 0.5) < 0.06);
  assert.ok(Math.abs(edgeMetres((c.edge as Uint8Array)[at(11, 23)]) - 1.5) < 0.06);
});

test('water: dry basins are not water, streams as wide as tagged (not narrower than the renderer can show)', () => {
  assert.equal(dryBasin({ natural: 'water', water: 'basin', basin: 'detention' }), true);
  assert.equal(dryBasin({ natural: 'water', water: 'pond' }), false);
  assert.equal(waterwayWidth({ waterway: 'stream' }), 2.4);
  assert.equal(waterwayWidth({ waterway: 'stream', width: '4' }), 4);
  assert.equal(waterwayWidth({ waterway: 'stream', width: '1' }), 2.4);
  assert.equal(waterwayWidth({ waterway: 'river' }), 9);
  assert.equal(waterwayWidth({ waterway: 'ditch' }), 0);
  const osm = osmOf([
    { tags: { natural: 'water', water: 'basin', basin: 'detention' }, pts: rect(10, 10, 60, 60), closed: true },
    { tags: { natural: 'water' }, pts: rect(100, 10, 150, 60), closed: true },
    { tags: { waterway: 'stream' }, pts: [[0, 120], [200, 120]] },
  ]);
  const c = buildCover(osm, 0, 0, 200, 200);
  assert.equal(c.at(35, 35), COVER.MEADOW);
  assert.equal(c.at(125, 35), COVER.WATER);
  // the stream: one row of cells at its middle (2.4 m), not the rows beside
  assert.equal(c.at(50, 120.5), COVER.WATER);
  assert.equal(c.at(50, 117.5), COVER.MEADOW);
  assert.equal(c.at(50, 123.5), COVER.MEADOW);
});

test('shopping areas: paved round their buildings and by their service roads, lawn elsewhere', () => {
  const osm = osmOf([
    { tags: { landuse: 'retail' }, pts: rect(0, 0, 200, 200), closed: true },
    { tags: { building: 'retail' }, pts: rect(20, 20, 60, 60), closed: true },
    { tags: { highway: 'service', service: 'parking_aisle' }, pts: [[100, 150], [190, 150]] },
  ]);
  const c = buildCover(osm, 0, 0, 200, 200);
  assert.equal(c.at(40, 40), COVER.COMMERCIAL); // under the building
  assert.equal(c.at(63, 40), COVER.COMMERCIAL); // its yard
  assert.equal(c.at(90, 40), COVER.GRASS); // open ground
  assert.equal(c.at(150, 155), COVER.COMMERCIAL); // beside the aisle
  assert.equal(c.at(150, 100), COVER.GRASS);
});

test('roofs: flattened at the eaves or higher; green and flat roofs from the list', () => {
  // a gable roof: eaves at 6, ridge at 10
  const polys = [
    [2, 0, 0, 0, 10, 0, 0, 10, 0, 8, 0, 0, 8],
    [1, 0, 6, 0, 10, 6, 0, 10, 10, 4, 0, 10, 4],
    [0, 0, 0, 0, 0, 6, 0, 0, 10, 4, 0, 6, 8, 0, 0, 8],
  ];
  flattenRoof(polys, 0.5);
  assert.deepEqual(
    polys[1].filter((_, i) => i % 3 === 2),
    [8, 8, 8, 8],
  );
  assert.deepEqual(
    polys[2].filter((_, i) => i % 3 === 2),
    [0, 8, 8, 8, 0],
  );
  assert.deepEqual(
    polys[0].filter((_, i) => i % 3 === 2),
    [0, 0, 0, 0],
  );

  const dir = mkdtempSync(join(tmpdir(), 'fs-obs-'));
  const file = join(dir, 'observed-buildings.json');
  writeFileSync(
    file,
    JSON.stringify({
      buildings: [{ id: 'G1', roofMaterial: 'green', flatAt: 0.5 }, { id: 'F1', roofShape: 'flat', roof: '#444444' }],
      add: [{ id: 'obs-1', pts: [[0, 0], [10, 0], [10, 8], [0, 8]], height: 5, roof: 'hip' }, { id: 'bad', pts: [[0, 0]], height: 3 }],
      remove: ['DEHE_GONE', { id: 'w42', note: 'gone' }],
    }),
  );
  const seen = loadObserved(file);
  assert.equal(seen.get('G1')?.flat, true);
  assert.equal(seen.get('G1')?.flatAt, 0.5);
  assert.equal(seen.get('G1')?.roofStyle, BS.ROOF_FLAT);
  assert.deepEqual(seen.get('G1')?.roof, [0x5f, 0x7a, 0x4a]);
  assert.equal(seen.get('F1')?.flat, true);
  const edits = loadObservedEdits(file);
  assert.deepEqual(
    edits.add.map((a) => a.id),
    ['obs-1'],
  );
  assert.ok(edits.remove.has('DEHE_GONE') && edits.remove.has('w42'));
});

test('buildings: a model removed, OSM footprints where no model is, and the buildings seen on the photographs', () => {
  const ts = new TileSet(-250, -250, 250, 250, 500);
  const stats: BuildingStats = { lod2Units: 0, osmFallback: 0, triangles: 0, footprints: 0 };
  const box = (id: string, x0: number, z0: number) => {
    const ring: Array<[number, number]> = rect(x0, z0, x0 + 10, z0 + 8);
    const polys: number[][] = [[2, ...ring.flatMap(([x, z]) => [x, 0, z])], [1, ...ring.flatMap(([x, z]) => [x, 6, z])]];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = ring[i];
      const [bx, bz] = ring[(i + 1) % 4];
      polys.push([0, ax, 0, az, bx, 0, bz, bx, 6, bz, ax, 6, az]);
    }
    return { id, fn: '31001_1000', roof: '1000', polys };
  };
  const foot = addLod2Buildings([box('KEEP', 0, 0), box('GONE', 50, 0)], ts, stats, new Map(), new Set(['GONE']));
  assert.equal(stats.lod2Units, 1);
  // (the removed model is no footprint either)
  assert.equal(foot.length, 1);
  const osm = osmOf([
    { tags: { building: 'house' }, pts: rect(1, 1, 9, 7), closed: true }, // under the model
    { tags: { building: 'hut' }, pts: rect(30, 30, 34, 33), closed: true }, // no model: a garden hut
    { tags: { building: 'yes' }, pts: rect(-100, -100, -90, -92), closed: true }, // where a building is added
    { tags: { building: 'yes' }, pts: rect(100, 100, 110, 110), closed: true }, // removed by its way id
  ]);
  const terrain = new TerrainGrid(-250, -250, 250, 250, 5);
  const municipality = [[-250, -250, 250, -250, 250, 250, -250, 250]];
  addOsmBuildings(osm, ts, terrain, () => true, municipality, stats, foot, {
    add: [{ id: 'obs-1', pts: rect(-101, -101, -89, -91), height: 5, roof: 'hip' }],
    remove: new Set(['w103']),
  });
  // the hut and the added building
  assert.equal(stats.osmFallback, 2);
  // without the models' footprints nothing inside the municipality comes from OSM (as before)
  const s2: BuildingStats = { lod2Units: 0, osmFallback: 0, triangles: 0, footprints: 0 };
  addOsmBuildings(osm, new TileSet(-250, -250, 250, 250, 500), terrain, () => true, municipality, s2, undefined, { add: [], remove: new Set() });
  assert.equal(s2.osmFallback, 0);
});
