// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the second round of comparing Street View with the game found wrong in
 * the map build, and how it is now: build-outs on narrow streets, merged
 * carriageways as wide as both, asphalt pavements that do not read as road,
 * the surface of separate pavements, hedges behind the kerb at a garden
 * hedge's height, occasional parking, walkways and railings on bridges with
 * footway bridges beside them, no split islands where merged carriageways
 * part.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LaneGraph } from '../../src/world/lanes.ts';
import { GM } from '../../src/world/tilefmt.ts';
import { EF } from '../../src/world/types.ts';
import type { WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts } from '../../src/world/world.ts';
import { FRONT_HEIGHTS, FRONT_OFFSETS } from '../../src/world/xsection.ts';
import { addIslands } from '../../tools/mapgen/islands.ts';
import { TileSet } from '../../tools/mapgen/meshacc.ts';
import type { TileData } from '../../tools/mapgen/meshacc.ts';
import { OsmData } from '../../tools/mapgen/osm.ts';
import type { Tags } from '../../tools/mapgen/osm.ts';
import { carsOf, sideParking } from '../../tools/mapgen/parking.ts';
import { RoadMesher } from '../../tools/mapgen/roadmesh.ts';
import { buildRoadGraph } from '../../tools/mapgen/roads.ts';
import type { EdgeFeature } from '../../tools/mapgen/roads.ts';
import { addFrontage } from '../../tools/mapgen/roadside.ts';
import { BUILD_OUT_PASS, buildOutRoom } from '../../tools/mapgen/streetpaint.ts';
import { TerrainGrid } from '../../tools/mapgen/terrain.ts';
import { MERGED_KEY, mergePair, mergedWidth } from '../../tools/mapgen/waysplit.ts';
import { taggedSides } from '../../tools/mapgen/xsection.ts';

process.env.DETAIL_REGION ??= 'all';

type WaySpec = { id: number; nodes: Array<[number, number, number]>; tags: Tags };

function osmOf(ways: WaySpec[], nodeTags: Record<number, Tags> = {}): OsmData {
  const osm = new OsmData();
  for (const w of ways) {
    for (const [id, x, z] of w.nodes) osm.nodes.set(id, { id, x, z, tags: nodeTags[id] ?? null });
    const way = { id: w.id, refs: w.nodes.map((n) => n[0]), tags: w.tags };
    osm.ways.push(way);
    osm.wayById.set(way.id, way);
  }
  return osm;
}

interface Town {
  world: World;
  lanes: LaneGraph;
  osm: OsmData;
  features: EdgeFeature[][];
  edgeOf(way: number): number;
}

function townOf(osm: OsmData, builtUp = true): Town {
  const g = buildRoadGraph(osm, { inWorld: () => true, builtUp: () => builtUp });
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
  const world = new World(json);
  return { world, lanes: new LaneGraph(world), osm, features: g.edgeFeatures, edgeOf: (way) => g.wayEdges.get(way)![0] };
}

const town = (ways: WaySpec[], nodeTags: Record<number, Tags> = {}, builtUp = true): Town => townOf(osmOf(ways, nodeTags), builtUp);
const tiles = (): TileSet => new TileSet(-250, -250, 250, 250, 250);
const all = (ts: TileSet): TileData[] => [...ts.tiles.values()];
const trees = (ts: TileSet): number[][] =>
  all(ts).flatMap((t) => {
    const out: number[][] = [];
    for (let i = 0; i < t.trees.length; i += 5) out.push(t.trees.slice(i, i + 5));
    return out;
  });

// ---------------------------------------------------------------------------
// 1. build-outs

test('a build-out narrows an unmarked residential street to one lane: kerbed bed, shrub or tree, beacon', () => {
  const narrow = town(
    [{ id: 1, nodes: [[1, -100, 0], [2, 0, 0], [3, 100, 0]], tags: { highway: 'residential', width: '5', 'sidewalk:left': 'yes', 'sidewalk:right': 'no' } }],
    { 2: { traffic_calming: 'choker', side: 'left', beacon: 'yes' } },
  );
  const e = narrow.world.edges[0];
  assert.equal(e.flags & EF.MARKED, 0);
  // (before: kept 1.1 m from the middle of the lane – 0.15 m deep on a 5 m street, and left out)
  assert.ok(Math.abs(buildOutRoom(e, 1, false) - (5 - BUILD_OUT_PASS)) < 1e-9);
  assert.ok(Math.abs(buildOutRoom(e, 1, true) - (5 - BUILD_OUT_PASS) / 2) < 1e-9, 'a choker on both sides shares the room');
  const ts = tiles();
  const m = new RoadMesher(narrow.world, ts, { ground: () => 0, features: narrow.features });
  m.build();
  assert.equal(m.detail?.buildOuts, 1);
  // its kerb stands on the left (north, z < 0) and reaches in to leave BUILD_OUT_PASS
  const kerb = all(ts).flatMap((t) => {
    const out: number[] = [];
    for (let i = 0; i < t.ground.a8.length; i++) if (t.ground.a8[i] === GM.KERB && Math.abs(t.ground.pos[i * 3]) < 4) out.push(t.ground.pos[i * 3 + 2]);
    return out;
  });
  assert.ok(kerb.length > 0 && Math.max(...kerb) < 0, 'on the left side');
  assert.ok(Math.max(...kerb) > -2.5 + 1.5 - 0.05, `reaches in to z ${Math.max(...kerb)}`);
  // a shrub (no trunk to hit in the lane) and the red-white beacon
  const t1 = trees(ts);
  assert.equal(t1.length, 1);
  assert.equal(t1[0][4], 2, 'a shrub where a trunk would stand in a lane');
  const reds = all(ts).reduce((n, t) => n + [...t.struct.a8].filter((v, i) => i % 3 === 0 && v === 196).length, 0);
  assert.ok(reds > 0, 'the beacon');

  // with parking strips beside the lanes (room enough): a small tree
  const wide = town(
    [{ id: 1, nodes: [[1, -100, 0], [2, 0, 0], [3, 100, 0]], tags: { highway: 'residential', sidewalk: 'both', 'parking:both': 'lane' } }],
    { 2: { traffic_calming: 'choker', side: 'left' } },
  );
  const ts2 = tiles();
  new RoadMesher(wide.world, ts2, { ground: () => 0, features: wide.features }).build();
  const t2 = trees(ts2);
  assert.equal(t2.length, 1);
  assert.equal(t2[0][4], 3, 'a young tree');
  assert.ok(t2[0][3] >= 4.5 && t2[0][3] <= 6.5);

  // a road with painted lanes keeps the old rule (clear of the lane's middle)
  const marked = town(
    [{ id: 1, nodes: [[1, -100, 0], [2, 0, 0], [3, 100, 0]], tags: { highway: 'tertiary', lanes: '2', width: '6.5', lane_markings: 'yes', sidewalk: 'both' } }],
    { 2: { traffic_calming: 'choker', side: 'left' } },
  );
  const me = marked.world.edges[0];
  assert.ok((me.flags & EF.MARKED) !== 0);
  assert.ok(Math.abs(buildOutRoom(me, 1, false) - (me.marginL + me.laneW / 2 - 1.1)) < 1e-9);
});

// ---------------------------------------------------------------------------
// 2./8. merged carriageways

function dual(): OsmData {
  // a two-way road from the west and one to the east; between them two one-way carriageways 9 m apart
  return osmOf([
    { id: 1, nodes: [[1, -200, 0], [2, -120, 0]], tags: { highway: 'residential' } },
    { id: 20, nodes: [[2, -120, 0], [3, -100, 4.5], [4, 0, 4.5], [5, 100, 4.5], [6, 120, 0]], tags: { highway: 'residential', oneway: 'yes', lanes: '1', 'sidewalk:right': 'yes', 'sidewalk:left': 'no' } },
    { id: 21, nodes: [[6, 120, 0], [7, 100, -4.5], [8, 0, -4.5], [9, -100, -4.5], [2, -120, 0]], tags: { highway: 'residential', oneway: 'yes', lanes: '1' } },
    { id: 22, nodes: [[6, 120, 0], [10, 200, 0]], tags: { highway: 'residential' } },
  ]);
}

test('a merged road is as wide as both carriageways were; the width beyond its lanes is asphalt', () => {
  assert.equal(mergedWidth([0, 0, 100, 0], [0, 9, 100, 9], { lanes: '1' }, { lanes: '2' }), 14, '9 m apart, half of 3.25 and of 6.5 m');
  assert.equal(mergedWidth([0, 0, 100, 0], [0, 1, 100, 1], {}, {}), 0, 'drawn on top of each other: nothing to add');
  const osm = dual();
  const r = mergePair(osm, { name: 'm', a: ['20'], b: ['21'], from: [-60, 0], to: [60, 0], tags: { lanes: '2' } });
  assert.ok(r.way, r.why ?? '');
  assert.equal(r.way!.tags.width, '12.5');
  assert.equal(r.way!.tags[MERGED_KEY], 'm');
  // a width said in the list wins (null: none)
  const osm2 = dual();
  const r2 = mergePair(osm2, { name: 'm', a: ['20'], b: ['21'], from: [-60, 0], to: [60, 0], tags: { lanes: '2', width: null } });
  assert.equal(r2.way!.tags.width, undefined);
  const t = townOf(osm);
  const e = t.world.edges[t.edgeOf(r.way!.id)];
  assert.equal(e.width, 12.5, 'the carriageway covers where both were');
  assert.ok(e.laneW >= 3.25 && e.laneW <= 3.5);
  assert.ok(Math.abs(e.margin - (12.5 - 2 * e.laneW) / 2) < 1e-6, 'the rest beside the lanes');
});

test('no split island where merged carriageways part; a real split still gets one, a hairline one not', () => {
  // (the carriageways alone, their outer ends open: they meet only where the merged road begins and ends)
  const osm = osmOf([
    { id: 20, nodes: [[3, -120, 4.5], [4, 0, 4.5], [5, 120, 4.5]], tags: { highway: 'residential', oneway: 'yes', lanes: '1' } },
    { id: 21, nodes: [[7, 120, -4.5], [8, 0, -4.5], [9, -120, -4.5]], tags: { highway: 'residential', oneway: 'yes', lanes: '1' } },
  ]);
  mergePair(osm, { name: 'm', a: ['20'], b: ['21'], from: [-60, 0], to: [60, 0], tags: { lanes: '2' } });
  const t = townOf(osm);
  const st = addIslands(t.osm, t.world, tiles(), new TerrainGrid(-250, -250, 250, 250, 5), t.lanes, t.features, () => true);
  assert.equal(st.splits, 0, JSON.stringify(st));
  // a road that really splits into two branches 12 m apart for 50 m: an island
  const split = (d: number): OsmData =>
    osmOf([
      { id: 1, nodes: [[1, -200, 0], [2, -120, 0]], tags: { highway: 'residential' } },
      { id: 20, nodes: [[2, -120, 0], [3, -100, d], [4, -50, d]], tags: { highway: 'residential', oneway: 'yes', lanes: '1' } },
      { id: 21, nodes: [[5, -50, -d], [6, -100, -d], [2, -120, 0]], tags: { highway: 'residential', oneway: 'yes', lanes: '1' } },
      { id: 22, nodes: [[4, -50, d], [7, -50, 50]], tags: { highway: 'residential' } },
      { id: 23, nodes: [[5, -50, -d], [8, -50, -50]], tags: { highway: 'residential' } },
    ]);
  const plain = townOf(split(6));
  const st2 = addIslands(plain.osm, plain.world, tiles(), new TerrainGrid(-250, -250, 250, 250, 5), plain.lanes, plain.features, () => true);
  assert.ok(st2.splits >= 1, JSON.stringify(st2));
  // two branches drawn side by side that hardly part: none
  const hair = split(3.4);
  const ht = townOf(hair);
  const st3 = addIslands(ht.osm, ht.world, tiles(), new TerrainGrid(-250, -250, 250, 250, 5), ht.lanes, ht.features, () => true);
  assert.equal(st3.splits, 0, JSON.stringify(st3));
});

// ---------------------------------------------------------------------------
// 3./11. pavements

test('an asphalt pavement is drawn as asphalt paths are; a separate pavement lends its surface', () => {
  const sides = taggedSides({ highway: 'residential', 'sidewalk:left:surface': 'asphalt' }, false, false);
  assert.equal(sides.left.side.wm, GM.ASPHALT_OLD, 'not the carriageway\'s asphalt');
  // a road whose pavement is mapped beside it as an asphalt footway=sidewalk 6 m from its middle
  const t = town([
    { id: 1, nodes: [[1, -100, 0], [2, 100, 0]], tags: { highway: 'residential' } },
    { id: 50, nodes: [[50, -100, -6], [51, 100, -6]], tags: { highway: 'footway', footway: 'sidewalk', surface: 'asphalt' } },
    { id: 52, nodes: [[52, -100, 6], [53, 100, 6]], tags: { highway: 'footway', footway: 'sidewalk' } },
  ]);
  const e = t.world.edges[t.edgeOf(1)];
  assert.equal(e.xl?.wm, GM.ASPHALT_OLD, 'left: asphalt as the footway');
  assert.equal(e.xr?.wm, undefined, 'right: the footway says nothing – the usual slabs');
  assert.ok(e.swL > 3);
});

// ---------------------------------------------------------------------------
// 4. hedges

test('a frontage hedge is a garden hedge (1.8 m) and stands back from a kerb without pavement; not on paved ground', () => {
  assert.equal(FRONT_HEIGHTS[1], 1.8);
  const t = town([{ id: 1, nodes: [[1, -150, 0], [2, 150, 0]], tags: { highway: 'residential', width: '5', 'sidewalk:left': 'yes', 'sidewalk:right': 'no', 'frontage:right': 'hedge' } }]);
  const e = t.world.edges[t.edgeOf(1)];
  const run = (paved: (x: number, z: number) => boolean): { ts: TileSet; km: number } => {
    const ts = tiles();
    const st = addFrontage(t.world, ts, (x1, z1, x2, z2, y) => t.lanes.wallInLane(x1, z1, x2, z2, y, 1.3), () => false, paved);
    return { ts, km: st.hedgeKm };
  };
  const { ts, km } = run(() => false);
  assert.ok(km > 0.25);
  const segs = all(ts).flatMap((tile) => {
    const out: number[][] = [];
    for (let i = 0; i < tile.collSeg.length; i += 5) out.push(tile.collSeg.slice(i, i + 5));
    return out;
  });
  for (const [, z] of segs) assert.ok(Math.abs(z - (e.width / 2 + FRONT_OFFSETS.noWalk + 0.45)) < 0.05, `hedge at z ${z}`);
  const top = Math.max(...all(ts).flatMap((tile) => Array.from({ length: tile.struct.pos.length / 3 }, (_, i) => tile.struct.pos[i * 3 + 1])));
  assert.ok(Math.abs(top - 1.8) < 0.05, `top ${top}`);
  // a forecourt mapped as a paved area between x = 0 and 20: a gap there
  const gap = run((x) => x > 0 && x < 20);
  assert.ok(gap.km < km - 0.015, `${gap.km} vs ${km}`);
  // and a height or an offset from the tags
  const tagged = taggedSides({ highway: 'residential', 'frontage:right': 'hedge', 'frontage:right:height': '3.5', 'frontage:right:offset': '3' }, false, false);
  assert.equal(tagged.right.side.fh, 3.5);
  assert.equal(tagged.right.side.fo, 3);
});

// ---------------------------------------------------------------------------
// 5. occasional parking

test('parking:<side>:occupancy=low: now and then a car, not a row', () => {
  assert.equal(taggedSides({ 'parking:left': 'lane', 'parking:left:occupancy': 'low' }, false, false).left.side.pq, 0.15);
  assert.equal(taggedSides({ 'parking:left': 'lane', 'parking:left:occupancy': '40%' }, false, false).left.side.pq, 0.4);
  assert.equal(taggedSides({ 'parking:left': 'lane', 'parking:left:occupancy': 'x' }, false, false).left.side.pq, undefined);
  const count = (extra: Tags): number => {
    const t = town([{ id: 1, nodes: [[1, -150, 0], [2, 150, 0]], tags: { highway: 'residential', width: '6', 'parking:left': 'lane', ...extra } }]);
    const e = t.world.edges[t.edgeOf(1)];
    return carsOf(t.world, e, sideParking(t.world, e, 1)!).length;
  };
  const usual = count({});
  const low = count({ 'parking:left:occupancy': 'low' });
  assert.ok(usual >= 25, `${usual} cars`);
  assert.ok(low < usual * 0.35, `${low} cars of ${usual}`);
});

// ---------------------------------------------------------------------------
// 6. bridges

test('a road bridge with footway bridges beside it: walkways on its deck behind open railings', () => {
  const t = town(
    [
      { id: 1, nodes: [[1, -150, 0], [2, -11, 0]], tags: { highway: 'tertiary', maxspeed: '100' } },
      { id: 2, nodes: [[2, -11, 0], [3, 11, 0]], tags: { highway: 'tertiary', maxspeed: '100', bridge: 'yes', layer: '1' } },
      { id: 4, nodes: [[3, 11, 0], [4, 150, 0]], tags: { highway: 'tertiary', maxspeed: '100' } },
      { id: 50, nodes: [[50, -11, -5], [51, 11, -5]], tags: { highway: 'footway', bridge: 'yes', layer: '1', surface: 'concrete' } },
      { id: 52, nodes: [[52, -11, 5], [53, 11, 5]], tags: { highway: 'footway', bridge: 'yes', layer: '1', surface: 'asphalt' } },
    ],
    {},
    false,
  );
  const e = t.world.edges[t.edgeOf(2)];
  assert.ok((e.flags & EF.BRIDGE) !== 0);
  assert.ok(e.swL > 2 && e.swL < 4 && e.swR > 2 && e.swR < 4, `walkways ${e.swL} ${e.swR}`);
  assert.equal(e.xl?.v, undefined, 'no verge on a deck');
  assert.equal(e.xr?.v, undefined);
  // the road beside it stays without pavements (out of town)
  assert.equal(t.world.edges[t.edgeOf(1)].swL, 0);
  const ts = tiles();
  new RoadMesher(t.world, ts, { ground: () => -6 }).build();
  const greys = all(ts).reduce((n, tile) => n + [...tile.struct.a8].filter((v, i) => i % 3 === 0 && v === 196).length, 0);
  assert.ok(greys > 50, 'railings');
  // nothing solid stands at the carriageway's edge: the collision lines lie at the outer edge of the walkways
  const segs = all(ts).flatMap((tile) => {
    const out: number[] = [];
    for (let i = 0; i < tile.collSeg.length; i += 5) if (Math.abs(tile.collSeg[i]) < 11) out.push(Math.abs(tile.collSeg[i + 1]));
    return out;
  });
  assert.ok(segs.length > 4);
  for (const z of segs) assert.ok(z > e.width / 2 + 1.5, `railing at ${z}`);
});
