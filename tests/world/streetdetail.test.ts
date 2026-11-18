// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the 1.7.0 review found the map build could not express: raised tables
 * and humps the wheels feel, build-outs, mouths over a continuous pavement,
 * give-way lines, zigzags, road text, cycle crossings, the material of
 * pavements, the surface of car parks and yards, woodland up to the verge
 * (src/world/roadfeatures.ts, tools/mapgen/roadextras.ts, streetpaint.ts,
 * xsection.ts, cover.ts, woodedge.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COVER } from '../../src/world/cover.ts';
import { CALM, TABLE_RAMP, calmBreaks, calmKind, calmLift, flushMouth } from '../../src/world/roadfeatures.ts';
import { GM } from '../../src/world/tilefmt.ts';
import type { WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts, newSurfaceHit } from '../../src/world/world.ts';
import { CoverMap, smallGreen, surfaceCover } from '../../tools/mapgen/cover.ts';
import { TileSet } from '../../tools/mapgen/meshacc.ts';
import type { TileData } from '../../tools/mapgen/meshacc.ts';
import { OsmData } from '../../tools/mapgen/osm.ts';
import type { Tags } from '../../tools/mapgen/osm.ts';
import { calmingOf, mouthOf } from '../../tools/mapgen/roadextras.ts';
import { RoadMesher } from '../../tools/mapgen/roadmesh.ts';
import { buildRoadGraph } from '../../tools/mapgen/roads.ts';
import type { EdgeFeature, RoadGraph } from '../../tools/mapgen/roads.ts';
import { redCrossing, textStrokes } from '../../tools/mapgen/streetpaint.ts';
import { TerrainGrid } from '../../tools/mapgen/terrain.ts';
import { addWoodEdges } from '../../tools/mapgen/woodedge.ts';
import { taggedSides, walkMaterial } from '../../tools/mapgen/xsection.ts';

interface Town {
  world: World;
  graph: RoadGraph;
  features: EdgeFeature[][];
  edgeOf(way: number): number;
}

function town(ways: Array<{ id: number; nodes: Array<[number, number, number]>; tags: Tags }>, nodeTags: Record<number, Tags> = {}): Town {
  const osm = new OsmData();
  for (const w of ways) {
    for (const [id, x, z] of w.nodes) osm.nodes.set(id, { id, x, z, tags: nodeTags[id] ?? null });
    const way = { id: w.id, refs: w.nodes.map((n) => n[0]), tags: w.tags };
    osm.ways.push(way);
    osm.wayById.set(way.id, way);
  }
  const g = buildRoadGraph(osm, { inWorld: () => true, builtUp: () => true });
  const json: WorldJson = {
    version: 2,
    meta: { name: 't', generated: '', minX: -500, maxX: 500, minZ: -500, maxZ: 500, tileSize: 500, originE: 0, originN: 0, attribution: [] },
    nodes: g.nodes,
    edges: g.edges,
    banned: [],
    signals: [],
    crossings: [],
    places: [],
    spawns: [],
    tiles: [],
  };
  computeAllCuts(json);
  return { world: new World(json), graph: g, features: g.edgeFeatures, edgeOf: (way) => g.wayEdges.get(way)![0] };
}

const tiles = (): TileSet => new TileSet(-250, -250, 250, 250, 250);
const all = (ts: TileSet): TileData[] => [...ts.tiles.values()];
function withMat(ts: TileSet, layer: 'ground' | 'mark', m: number): number[][] {
  const out: number[][] = [];
  for (const t of all(ts)) {
    const acc = t[layer];
    for (let i = 0; i < acc.a8.length; i++) if (acc.a8[i] === m) out.push([acc.pos[i * 3], acc.pos[i * 3 + 1], acc.pos[i * 3 + 2]]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// traffic calming

test('calming: kinds, defaults from tags, the lift of a table and a hump', () => {
  assert.equal(calmKind('table'), CALM.TABLE);
  assert.equal(calmKind('choker'), 0);
  const feats: EdgeFeature[] = [
    { kind: 'bump', s: 30, dir: 0, tags: { traffic_calming: 'table', length: '6' }, osm: 1 },
    { kind: 'bump', s: 70, dir: 0, tags: { traffic_calming: 'hump', height: '10 cm' }, osm: 2 },
    { kind: 'bump', s: 80, dir: 0, tags: { traffic_calming: 'choker' }, osm: 3 },
  ];
  const cm = calmingOf({ highway: 'residential' }, feats, 100);
  assert.deepEqual(cm, [30, CALM.TABLE, 6, 0.08, 70, CALM.HUMP, 3.7, 0.1]);
  const road = { calm: cm, len: 100, cutA: 5, cutB: 5 };
  assert.equal(calmLift(road, 30), 0.08);
  assert.equal(calmLift(road, 33), 0.08, 'the flat top');
  assert.ok(Math.abs(calmLift(road, 33 + TABLE_RAMP / 2) - 0.04) < 1e-9, 'half-way up the ramp');
  assert.equal(calmLift(road, 33 + TABLE_RAMP + 0.01), 0);
  assert.ok(Math.abs(calmLift(road, 70) - 0.1) < 1e-9);
  assert.equal(calmLift(road, 50), 0);
  // a table on the junction's area moves off it
  const near = { calm: [2, CALM.TABLE, 4, 0.08], len: 100, cutA: 5, cutB: 5 };
  assert.equal(calmLift(near, 2), 0);
  assert.equal(calmLift(near, 5 + 0.3 + 2 + TABLE_RAMP), 0.08);
  assert.ok(calmBreaks(road).length > 8);
  // a short way that is the table itself
  const own = calmingOf({ highway: 'residential', traffic_calming: 'table' }, [], 9);
  assert.equal(own[1], CALM.TABLE);
  assert.ok(own[2] > 5 && own[2] < 7);
});

test('a raised table lifts the carriageway – the physics and the mesh – not the pavement; shark teeth on its ramps', () => {
  const t = town([{ id: 1, nodes: [[1, -100, 0], [2, 0, 0], [3, 100, 0]], tags: { highway: 'residential', sidewalk: 'both' } }], { 2: { traffic_calming: 'table' } });
  const e = t.world.edges[0];
  assert.ok(e.calm, 'the road carries its table');
  const hit = newSurfaceHit();
  assert.ok(t.world.surfaceAt(0, 0.5, 10, hit));
  const top = hit.y;
  assert.ok(t.world.surfaceAt(-40, 0.5, 10, hit));
  assert.ok(Math.abs(top - hit.y - 0.08) < 0.01, `lift ${top - hit.y}`);
  // the pavement stays where it was
  const walkOff = e.width / 2 + 1;
  t.world.surfaceAt(0, -walkOff, 10, hit);
  const walkAt = hit.y;
  t.world.surfaceAt(-40, -walkOff, 10, hit);
  assert.ok(Math.abs(walkAt - hit.y) < 0.01);
  const ts = tiles();
  const m = new RoadMesher(t.world, ts, { ground: () => 0, features: t.features });
  m.build();
  assert.equal(m.detail?.tables, 1);
  const raised = withMat(ts, 'ground', GM.ASPHALT).filter((p) => Math.abs(p[0]) < 1.5);
  assert.ok(raised.some((p) => p[1] > 0.07), 'the ribbon rises over the table');
});

test('build-outs of a choker stand beside the lanes, with a beacon where tagged; no car parks there', () => {
  const t = town(
    [{ id: 1, nodes: [[1, -100, 0], [2, 0, 0], [3, 100, 0]], tags: { highway: 'residential', sidewalk: 'both', 'parking:both': 'lane' } }],
    { 2: { traffic_calming: 'choker', beacon: 'yes' } },
  );
  const ts = tiles();
  const m = new RoadMesher(t.world, ts, { ground: () => 0, features: t.features });
  m.build();
  assert.equal(m.detail?.buildOuts, 2);
  const struct = all(ts).reduce((n, tile) => n + tile.struct.pos.length, 0);
  assert.ok(struct > 0, 'shrubs and the beacon');
});

// ---------------------------------------------------------------------------
// mouths, give-way lines, zigzags, text

test('a paved living street meets the road over a lowered kerb, without corner radii', () => {
  assert.ok(mouthOf({ highway: 'living_street' }, { c: 12, s: 2 } as never));
  assert.ok(!mouthOf({ highway: 'living_street', 'mouth:kerb': 'raised' }, { c: 12, s: 2 } as never));
  assert.ok(mouthOf({ highway: 'service', service: 'parking_aisle', 'mouth:kerb': 'lowered' }, { c: 13, s: 0 } as never));
  const mk = (living: boolean): Town =>
    town([
      { id: 1, nodes: [[1, -100, 0], [2, 0, 0], [3, 100, 0]], tags: { highway: 'residential', sidewalk: 'both' } },
      { id: 2, nodes: [[2, 0, 0], [4, 0, 60]], tags: living ? { highway: 'living_street' } : { highway: 'residential', sidewalk: 'both' } },
    ]);
  const flush = mk(true);
  const kerbed = mk(false);
  const node = (t: Town): (typeof t.world.nodes)[number] => t.world.nodes[t.graph.nodeIndex.get(2)!];
  const arm = node(flush).arms.find((a) => a.edge.osm === 2)!;
  assert.ok(flushMouth(arm));
  assert.ok(Math.max(...node(flush).fr) < 1, 'no kerbed corner radii');
  assert.ok(Math.max(...node(kerbed).fr) > 3);
  const ts = tiles();
  const m = new RoadMesher(flush.world, ts, { ground: () => 0 });
  m.build();
  assert.equal(m.detail?.mouths, 1);
});

test('give-way lines, zigzags and text from the tags', () => {
  const t = town(
    [
      { id: 1, nodes: [[1, -100, 0], [2, 0, 0], [3, 100, 0]], tags: { highway: 'secondary', 'markings:zigzag': 'right' } },
      { id: 2, nodes: [[4, 0, 80], [5, 0, 10], [2, 0, 0]], tags: { highway: 'residential', road_text: '30', 'road_text:position': '20' } },
    ],
    { 5: { highway: 'give_way' } },
  );
  const side = t.graph.edges[t.edgeOf(2)];
  assert.equal(side.gl, 1, 'a give-way sign mapped on it');
  assert.deepEqual(side.rt, [['30', 20, 1]]);
  const main = t.graph.edges.filter((e) => e.o === 1);
  assert.ok(main.every((e) => e.zz === 2));
  const ts = tiles();
  const m = new RoadMesher(t.world, ts, { ground: () => 0 });
  m.build();
  assert.equal(m.detail?.texts, 1);
  assert.equal(m.detail?.zigzags, 2);
  const glyphs = textStrokes('30');
  assert.equal(glyphs.strokes.length, 3);
  assert.ok(Math.abs(glyphs.width - 1.8) < 1e-9);
});

test('cycle crossings over a side road where the cycle lanes go on; red where they are red', () => {
  const t = town([
    { id: 1, nodes: [[1, -100, 0], [2, 0, 0], [3, 100, 0]], tags: { highway: 'secondary', 'cycleway:both': 'lane', 'cycleway:both:surface:colour': 'red' } },
    { id: 2, nodes: [[2, 0, 0], [4, 0, 60]], tags: { highway: 'residential' } },
  ]);
  const ts = tiles();
  const m = new RoadMesher(t.world, ts, { ground: () => 0 });
  m.build();
  assert.equal(m.detail?.cycleCrossings, 1);
  assert.ok(redCrossing({ highway: 'cycleway', cycleway: 'crossing', 'surface:colour': 'red' }));
  assert.ok(!redCrossing({ highway: 'cycleway', cycleway: 'crossing' }));
});

// ---------------------------------------------------------------------------
// materials and surfaces

test('pavement material per side; area surfaces; small greens over paved areas', () => {
  assert.equal(walkMaterial('asphalt', undefined), GM.ASPHALT_OLD, 'asphalt pavements as asphalt paths, not as the carriageway');
  assert.equal(walkMaterial('paving_stones', 'red'), GM.CYCLE);
  assert.equal(walkMaterial(undefined, 'anthracite'), GM.SETT);
  assert.equal(walkMaterial('concrete', undefined), GM.CONCRETE);
  const s = taggedSides({ highway: 'residential', 'sidewalk:left:surface': 'asphalt', 'sidewalk:right:colour': 'red' }, false, false);
  assert.equal(s.left.side.wm, GM.ASPHALT_OLD);
  assert.equal(s.right.side.wm, GM.CYCLE);
  assert.equal(surfaceCover('paving_stones'), COVER.PAVED);
  assert.equal(surfaceCover('asphalt'), COVER.ASPHALT);
  assert.equal(surfaceCover('gravel'), COVER.BARE);
  assert.equal(surfaceCover('grass_paver'), COVER.GRASS);
  assert.equal(smallGreen({ landuse: 'grass' }, [[0, 0, 10, 0, 10, 10, 0, 10]]), COVER.GRASS);
  assert.equal(smallGreen({ landuse: 'grass' }, [[0, 0, 100, 0, 100, 100, 0, 100]]), undefined);
});

test('woodland reaches the verge', () => {
  const t = town([{ id: 1, nodes: [[1, -100, 0], [3, 100, 0]], tags: { highway: 'unclassified' } }]);
  const cover = new CoverMap(-250, -250, 250, 250, 2);
  cover.data.fill(COVER.FOREST);
  const ts = tiles();
  const st = addWoodEdges(t.world, cover, new TerrainGrid(-250, -250, 250, 250, 5), ts, () => false, { minX: -250, maxX: 250, minZ: -250, maxZ: 250 });
  assert.ok(st.trees > 20, `${st.trees}`);
  for (const tile of all(ts)) for (let i = 0; i < tile.trees.length; i += 5) assert.ok(Math.abs(tile.trees[i + 2]) > t.world.edges[0].width / 2 + 1.2);
});

test('greenery seen on the aerial photographs: areas filled by density, rows, hedges; none on the road; broadleaf crowns as wide as real ones', async () => {
  const { addGreenery, loadGreenery } = await import('../../tools/mapgen/greenery.ts');
  const { treeWidth } = await import('../../src/render/props.ts');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'green-')), 'g.json');
  writeFileSync(
    file,
    JSON.stringify({
      trees: [
        { kind: 'wood', pts: [[-60, -60], [60, -60], [60, 60], [-60, 60]], density: 'dense', height: 'large' },
        { kind: 'row', pts: [[-90, 100], [90, 100]], density: 'medium', height: 'medium' },
        { kind: 'bush', pts: [[0, 0], [1, 1]] },
      ],
      hedges: [{ pts: [[0, 120], [20, 120]], height_m: 1.8 }],
    }),
  );
  const g = loadGreenery(file);
  assert.equal(g.trees.length, 2);
  assert.deepEqual(g.hedges[0].h, 1.8);
  const t = town([{ id: 1, nodes: [[1, -100, 0], [3, 100, 0]], tags: { highway: 'unclassified' } }]);
  const cover = new CoverMap(-250, -250, 250, 250, 2);
  const ts = tiles();
  const st = addGreenery(t.world, cover, new TerrainGrid(-250, -250, 250, 250, 5), ts, () => false, { minX: -250, maxX: 250, minZ: -250, maxZ: 250 }, g);
  // 120 × 120 m every 6.5 m: about 340, less the road; the row: 20
  assert.ok(st.trees > 280 && st.trees < 400, `${st.trees}`);
  for (const tile of all(ts)) {
    for (let i = 0; i < tile.trees.length; i += 5) {
      assert.ok(Math.abs(tile.trees[i + 2]) > 3, 'not on the road');
      // (round 3: the undergrowth – shrub masses 2–4 m – between the trees of a dense stand)
      if (tile.trees[i + 4] === 2) assert.ok(tile.trees[i + 3] >= 2 && tile.trees[i + 3] <= 4);
      else assert.ok(tile.trees[i + 3] >= 10 && tile.trees[i + 3] <= 25);
    }
  }
  assert.ok(st.shrubs > 200, `${st.shrubs} shrubs`);
  const crown = (h: number, r: number): number => treeWidth(0, h, r) * 0.6;
  assert.ok(crown(15, 0.5) > 10 && crown(15, 0.5) < 13);
  assert.ok(crown(25, 1) <= 14 * 1.1);
  assert.ok(crown(7, 0.5) > 5);
});

test('greenery from the aerial photographs is broadleaf unless the entry says conifer or mixed', async () => {
  const { addGreenery, loadGreenery } = await import('../../tools/mapgen/greenery.ts');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const kinds = (leaf: string | undefined, kind = 'wood'): number[] => {
    const file = join(mkdtempSync(join(tmpdir(), 'leaf-')), 'g.json');
    const pts = kind === 'row' ? [[-90, 100], [90, 100]] : [[-60, -60], [60, -60], [60, 60], [-60, 60]];
    writeFileSync(file, JSON.stringify({ trees: [{ kind, pts, density: 'dense', height: 'large', ...(leaf ? { leaf } : {}) }] }));
    const t = town([{ id: 1, nodes: [[1, -100, 0], [3, 100, 0]], tags: { highway: 'unclassified' } }]);
    const ts = tiles();
    addGreenery(t.world, new CoverMap(-250, -250, 250, 250, 2), new TerrainGrid(-250, -250, 250, 250, 5), ts, () => false, { minX: -250, maxX: 250, minZ: -250, maxZ: 250 }, loadGreenery(file));
    const out: number[] = [];
    // (the undergrowth's shrubs aside)
    for (const tile of all(ts)) for (let i = 0; i < tile.trees.length; i += 5) if (tile.trees[i + 4] !== 2) out.push(tile.trees[i + 4]);
    return out;
  };
  const plain = kinds(undefined);
  assert.ok(plain.length > 200 && plain.every((k) => k === 0), 'a wood without `leaf`: all broadleaf');
  assert.ok(kinds('broadleaf', 'row').every((k) => k === 0));
  const conifer = kinds('conifer');
  assert.ok(conifer.length > 200 && conifer.every((k) => k === 1), 'all conifers');
  assert.ok(kinds('conifer', 'row').every((k) => k === 1));
  const mixed = kinds('mixed');
  const share = mixed.filter((k) => k === 1).length / mixed.length;
  assert.ok(share > 0.12 && share < 0.4, `mixed: ${share}`);
  assert.ok(kinds('palm').every((k) => k === 0), 'an unknown value: broadleaf');
});
