// SPDX-License-Identifier: AGPL-3.0-only
/** Ways cut along their length and pairs of carriageways merged (tools/mapgen/waysplit.ts, observed-roads.json "split" / "merge"). */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { ONode, OWay } from '../../tools/mapgen/osm.ts';
import { OsmData } from '../../tools/mapgen/osm.ts';
import { buildRoadGraph } from '../../tools/mapgen/roads.ts';
import { applySplits, loadWayEdits, mergePair } from '../../tools/mapgen/waysplit.ts';
import type { WayStore } from '../../tools/mapgen/waysplit.ts';

// (the corrections of the lists apply in the detail region only – tools/mapgen/detailregion.ts: here everywhere)
process.env.DETAIL_REGION ??= 'all';

function store(nodes: Array<[number, number, number, Record<string, string>?]>, ways: OWay[]): WayStore {
  const s: WayStore = { nodes: new Map<number, ONode>(), ways: [], wayById: new Map() };
  for (const [id, x, z, tags] of nodes) s.nodes.set(id, { id, x, z, tags: tags ?? null });
  for (const w of ways) {
    s.ways.push(w);
    s.wayById.set(w.id, w);
  }
  return s;
}

const dir = mkdtempSync(join(tmpdir(), 'waysplit-'));
const list = join(dir, 'observed.json');
writeFileSync(
  list,
  JSON.stringify({
    ways: { '10': { tags: { 'parking:right': 'lane' } }, '10:2': { tags: { 'parking:right': null, 'parking:left': 'lane' } }, 'x:1': { tags: {} } },
    split: [{ osm: 10, at: [25, 1] }, { osm: 10, at: [40.5, -0.5] }, { osm: 'bad', at: [0, 0] }],
    remove: ['10:3', 11],
    merge: [{ id: 'm', a: [20], b: [21], from: [0, 100], to: [60, 100], tags: { lanes: '2' } }],
  }),
);

test('reads splits, part tags, part removals and merges', () => {
  const e = loadWayEdits(list);
  assert.deepEqual(e.splits, [
    { way: 10, x: 25, z: 1 },
    { way: 10, x: 40.5, z: -0.5 },
  ]);
  assert.deepEqual([...e.parts.keys()], ['10:2']);
  assert.deepEqual([...e.removeParts], ['10:3']);
  assert.equal(e.merges.length, 1);
  assert.deepEqual(e.merges[0].a, ['20']);
});

test('a way is cut at a node put in, or at its own node within 1 m; parts keep tags and know their way', () => {
  const s = store(
    [
      [1, 0, 0],
      [2, 40, 0],
      [3, 60, 0],
    ],
    [{ id: 10, refs: [1, 2, 3], tags: { highway: 'residential', 'parking:right': 'lane' } }],
  );
  const named = applySplits(s, loadWayEdits(list));
  assert.equal(s.ways.length, 2, 'the third part is removed');
  const [p1, p2] = [named.get('10:1')!, named.get('10:2')!];
  assert.equal(p1.refs.length, 2);
  assert.equal(p1.refs[0], 1);
  const cut = s.nodes.get(p1.refs[1])!;
  assert.deepEqual([cut.x, cut.z], [25, 0]);
  assert.deepEqual(p2.refs.slice(-1), [2], 'the second cut snaps to node 2');
  assert.equal(p1.of, 10);
  assert.equal(p1.tags['parking:right'], 'lane');
  assert.equal(p2.tags['parking:right'], undefined);
  assert.equal(p2.tags['parking:left'], 'lane');
  assert.equal(s.wayById.get(10)!.refs.length, 3, 'the uncut way stays known by its number');
});

test('two one-way carriageways become one two-way way over the stretch; side streets stay joined', () => {
  // a: eastbound along z = 96, b: westbound along z = 104, from x = -40 to 100; a side street joins b at x = 30
  const s = store(
    [
      [1, -40, 100],
      [2, -10, 96],
      [3, 30, 96],
      [4, 70, 96],
      [5, 100, 100],
      [6, 70, 104],
      [7, 30, 104],
      [8, -10, 104],
      [9, 30, 140],
    ],
    [
      { id: 20, refs: [1, 2, 3, 4, 5], tags: { highway: 'secondary', oneway: 'yes', name: 'Allee', 'median:contents': 'grass' } },
      { id: 21, refs: [5, 6, 7, 8, 1], tags: { highway: 'secondary', oneway: 'yes', name: 'Allee' } },
      { id: 30, refs: [7, 9], tags: { highway: 'residential' } },
    ],
  );
  const r = mergePair(s, loadWayEdits(list).merges[0]);
  assert.ok(r.way, r.why ?? '');
  const w = r.way!;
  assert.equal(w.tags.oneway, undefined);
  assert.equal(w.tags['median:contents'], undefined);
  assert.equal(w.tags.lanes, '2');
  assert.equal(w.tags.name, 'Allee');
  // the side street's node is now on the new way, in the middle
  assert.ok(w.refs.includes(7));
  assert.ok(Math.abs(s.nodes.get(7)!.z - 100) < 0.6, `z ${s.nodes.get(7)!.z}`);
  // the carriageways outside the stretch end in the new way's end nodes
  const a = s.ways.filter((x) => x.of === 20);
  const b = s.ways.filter((x) => x.of === 21);
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  const ends = new Set([w.refs[0], w.refs[w.refs.length - 1]]);
  for (const part of [...a, ...b]) assert.ok(ends.has(part.refs[0]) || ends.has(part.refs[part.refs.length - 1]));
  // the road network: one two-way road along the stretch, joined at both ends and to the side street
  const d = new OsmData();
  for (const [id, n] of s.nodes) d.nodes.set(id, n);
  for (const x of s.ways) {
    d.ways.push(x);
    d.wayById.set(x.id, x);
  }
  const g = buildRoadGraph(d, { inWorld: () => true, builtUp: () => true });
  const mid = g.edges.filter((e) => e.o === w.id);
  assert.ok(mid.length >= 2);
  for (const e of mid) assert.ok(e.lf === 1 && e.lb === 1);
  assert.ok(g.edges.some((e) => e.o === 20) && g.edges.some((e) => e.o === 21), 'the parts keep the OSM way number');
  assert.equal(g.nodes[g.nodeIndex.get(7)!].arms.length, 3);
});

test('OsmData.load applies the edits of the list', () => {
  const ext = join(dir, 'b.json.gz');
  const raw = {
    meta: { extractedAt: 'x', world: true },
    nodes: [
      [1, 0, 0],
      [2, 40, 0],
      [3, 60, 0],
    ],
    ways: [{ id: 10, refs: [1, 2, 3], tags: { highway: 'residential' } }],
    relations: [],
  };
  writeFileSync(ext, gzipSync(JSON.stringify(raw)));
  const before = process.env.OBSERVED_ROADS;
  process.env.OBSERVED_ROADS = list;
  try {
    const d = OsmData.load(ext);
    assert.equal(d.ways.length, 2);
    assert.ok(d.ways.every((w) => w.of === 10));
    assert.equal(d.ways[0].tags['parking:right'], 'lane', 'the tags of the whole way go to its parts');
    assert.equal(d.ways[1].tags['parking:left'], 'lane');
  } finally {
    if (before === undefined) delete process.env.OBSERVED_ROADS;
    else process.env.OBSERVED_ROADS = before;
  }
});

test('points: a tagged node put into the nearest road, or into the way named', async () => {
  const { applyPoints } = await import('../../tools/mapgen/waysplit.ts');
  const s = store(
    [
      [1, 0, 0],
      [2, 50, 0],
      [3, 0, 5],
      [4, 50, 5],
    ],
    [
      { id: 40, refs: [1, 2], tags: { highway: 'residential' } },
      { id: 41, refs: [3, 4], tags: { highway: 'footway' } },
    ],
  );
  const [a, b, c] = applyPoints(s, [
    { name: 'p', x: 20, z: 4, tags: { traffic_calming: 'table' } },
    { name: 'q', x: 30, z: 0, tags: { highway: 'give_way' }, way: '41' },
    { name: 'r', x: 20, z: 40, tags: { traffic_calming: 'table' } },
  ]);
  assert.ok(a !== null && b !== null);
  assert.equal(c, null, 'no road within 10 m');
  assert.deepEqual(s.wayById.get(40)!.refs, [1, a, 2], 'into the road, not the footway nearer by');
  assert.deepEqual([s.nodes.get(a!)!.x, s.nodes.get(a!)!.z, s.nodes.get(a!)!.tags], [20, 0, { traffic_calming: 'table' }]);
  assert.deepEqual(s.wayById.get(41)!.refs, [3, b, 4]);
});

test('a point put into a road becomes one of its features (a table the road carries)', async () => {
  const { applyPoints } = await import('../../tools/mapgen/waysplit.ts');
  const d = new OsmData();
  for (const [id, x] of [[1, 0], [2, 100]] as const) d.nodes.set(id, { id, x, z: 0, tags: null });
  const w = { id: 50, refs: [1, 2], tags: { highway: 'residential' } };
  d.ways.push(w);
  d.wayById.set(50, w);
  applyPoints(d, [{ name: 't', x: 50, z: 1, tags: { traffic_calming: 'table' } }]);
  const g = buildRoadGraph(d, { inWorld: () => true, builtUp: () => true });
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0].cm, [50, 1, 4, 0.08]);
});
