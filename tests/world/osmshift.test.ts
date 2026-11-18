// SPDX-License-Identifier: AGPL-3.0-only
/** Geometry corrections of tools/mapgen/observed-roads.json: ways and nodes moved where OSM lies off the road. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { latLonToWorld, worldToLatLon } from '../../src/geo/utm.ts';
import { loadGeometryCorrections, nodeShifts } from '../../tools/mapgen/observedroads.ts';
import { OsmData } from '../../tools/mapgen/osm.ts';

// (the corrections of the lists apply in the detail region only – tools/mapgen/detailregion.ts: here everywhere)
process.env.DETAIL_REGION ??= 'all';

const dir = mkdtempSync(join(tmpdir(), 'osmshift-'));
const list = join(dir, 'observed.json');
writeFileSync(
  list,
  JSON.stringify({
    ways: {
      '1': { shift: [2, 0], tags: { 'parking:right': 'lane' } },
      '2': { shift: [0, 4] },
      '9': { shift: ['x', 1] },
    },
    nodes: { '4': [1, 1] },
  }),
);

test('reads way shifts and node moves, skips bad ones', () => {
  const g = loadGeometryCorrections(list);
  assert.deepEqual([...g.ways.entries()], [[1, [2, 0]], [2, [0, 4]]]);
  assert.deepEqual(g.nodes.get(4), [1, 1]);
});

test('a node of two shifted ways moves by their mean; an explicit node move wins; a closed way counts once', () => {
  const g = loadGeometryCorrections(list);
  const m = nodeShifts(
    [
      { id: 1, refs: [1, 2, 3, 1] },
      { id: 2, refs: [3, 4] },
      { id: 7, refs: [4, 5] },
    ],
    g,
  );
  assert.deepEqual(m.get(1), [2, 0]);
  assert.deepEqual(m.get(3), [1, 2]);
  assert.deepEqual(m.get(4), [1, 1]);
  assert.equal(m.get(5), undefined);
});

test('OsmData.load moves the nodes (and still corrects the tags)', () => {
  const ext = join(dir, 'b.json.gz');
  const raw = {
    meta: { extractedAt: 'x', world: true },
    nodes: [
      [1, 0, 0],
      [2, 10, 0],
      [3, 20, 0],
      [4, 20, 10],
      [5, 30, 10],
    ],
    ways: [
      { id: 1, refs: [1, 2, 3], tags: { highway: 'residential' } },
      { id: 2, refs: [3, 4], tags: { highway: 'residential' } },
      { id: 7, refs: [4, 5], tags: { highway: 'service' } },
    ],
    relations: [],
  };
  writeFileSync(ext, gzipSync(JSON.stringify(raw)));
  const before = process.env.OBSERVED_ROADS;
  process.env.OBSERVED_ROADS = list;
  try {
    const d = OsmData.load(ext);
    const at = (id: number): [number, number] => [d.nodes.get(id)!.x, d.nodes.get(id)!.z];
    assert.deepEqual(at(1), [2, 0]);
    assert.deepEqual(at(2), [12, 0]);
    assert.deepEqual(at(3), [21, 2]);
    assert.deepEqual(at(4), [21, 11]);
    assert.deepEqual(at(5), [30, 10]);
    assert.equal(d.wayById.get(1)!.tags['parking:right'], 'lane');
  } finally {
    if (before === undefined) delete process.env.OBSERVED_ROADS;
    else process.env.OBSERVED_ROADS = before;
  }
});

test('the move through latitude and longitude (readPbf) comes out in metres', () => {
  const [x, z] = latLonToWorld(51.25, 9.42);
  const [la, lo] = worldToLatLon(x + 3, z - 2);
  const [x2, z2] = latLonToWorld(la, lo);
  assert.ok(Math.abs(x2 - x - 3) < 0.01 && Math.abs(z2 - z + 2) < 0.01);
});

test('readPbf finds the nodes of shifted ways from the list kept beside the PBF', async () => {
  const { statSync } = await import('node:fs');
  const { pbfNodeShifts } = await import('../../tools/osm/pbf.ts');
  const pbf = join(dir, 'x.osm.pbf');
  writeFileSync(pbf, 'not read: the refs are known');
  const st = statSync(pbf);
  writeFileSync(`${pbf}.shift-refs.json`, JSON.stringify({ size: st.size, mtime: st.mtimeMs, ways: { '1': [1, 2, 3], '2': [3, 4] } }));
  const before = process.env.OBSERVED_ROADS;
  process.env.OBSERVED_ROADS = list;
  try {
    const m = pbfNodeShifts(pbf)!;
    assert.deepEqual(m.get(2), [2, 0]);
    assert.deepEqual(m.get(3), [1, 2]);
    assert.deepEqual(m.get(4), [1, 1]);
  } finally {
    if (before === undefined) delete process.env.OBSERVED_ROADS;
    else process.env.OBSERVED_ROADS = before;
  }
});

// ---------------------------------------------------------------------------
// what the list adds and removes

test('added areas and ways get negative ids, join the network, removed ways are gone', async () => {
  const { buildRoadGraph } = await import('../../tools/mapgen/roads.ts');
  const { addedWayId, loadAdditions } = await import('../../tools/mapgen/observedroads.ts');
  const file = join(dir, 'adds.json');
  writeFileSync(
    file,
    JSON.stringify({
      areas: [{ id: 'obs-1', tags: { amenity: 'parking' }, pts: [[10, 10], [30, 10], [30, 25], [10, 25], [10, 10]] }],
      newWays: [
        { id: 'obs-w1', tags: { highway: 'service' }, pts: [[50, 30], [50, 1.2]], connect: true },
        { id: 'obs-w2', tags: { highway: 'service' }, pts: [[100.5, 40], [100.5, 1]], connect: true },
        { id: 'bad', tags: { highway: 'service' }, pts: [[1, 'x']] },
      ],
      remove: [7],
    }),
  );
  const a = loadAdditions(file);
  assert.equal(a.ways.length, 3);
  assert.ok(a.ways.every((w) => w.id < -1e8));
  assert.equal(a.ways[0].id, addedWayId('obs-1'), 'the same id on every build');
  assert.equal(a.ways[0].pts.length, 8, 'a closed area keeps its first point once');
  assert.deepEqual([...a.remove], [7]);

  const ext = join(dir, 'c.json.gz');
  writeFileSync(
    ext,
    gzipSync(
      JSON.stringify({
        meta: { extractedAt: 'x', world: true },
        nodes: [[1, 0, 0], [2, 100, 0], [3, 0, 50], [4, 100, 50]],
        ways: [
          { id: 1, refs: [1, 2], tags: { highway: 'residential' } },
          { id: 7, refs: [3, 4], tags: { highway: 'residential' } },
        ],
        relations: [],
      }),
    ),
  );
  const before = process.env.OBSERVED_ROADS;
  process.env.OBSERVED_ROADS = file;
  try {
    const d = OsmData.load(ext);
    assert.equal(d.wayById.get(7), undefined, 'removed');
    const area = d.wayById.get(addedWayId('obs-1'))!;
    assert.equal(area.tags.amenity, 'parking');
    assert.equal(area.refs[0], area.refs[area.refs.length - 1], 'closed');
    const w1 = d.wayById.get(addedWayId('obs-w1'))!;
    // its end met the street between its nodes: a node put into the street there
    const main = d.wayById.get(1)!;
    assert.equal(main.refs.length, 3);
    assert.equal(main.refs[1], w1.refs[1]);
    assert.deepEqual([d.nodes.get(w1.refs[1])!.x, d.nodes.get(w1.refs[1])!.z], [50, 0]);
    // the other one's end lies near the street's end node: joined there
    const w2 = d.wayById.get(addedWayId('obs-w2'))!;
    assert.equal(w2.refs[1], 2);
    // … and the road network has a junction there
    const g = buildRoadGraph(d, { inWorld: () => true, builtUp: () => true });
    const junction = g.nodes.find((n) => Math.abs(n.x - 50) < 0.01 && Math.abs(n.z) < 0.01);
    assert.ok(junction && junction.arms.length === 3, 'the added way joins the street');
    assert.ok(g.nodeOsm.every((n, i) => (n === null) === Boolean(g.nodeMapEnd[i])), 'added nodes are not map ends');
  } finally {
    if (before === undefined) delete process.env.OBSERVED_ROADS;
    else process.env.OBSERVED_ROADS = before;
  }
});
