// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the reviewers missed beside the lanes: the paved gutter along the
 * kerbs, edge lines by tag, paths mapped on their own, traffic islands with
 * their keep-right signs, tree bulbs in the parking strips, hedges and
 * fences behind the pavement, paved verges and medians
 * (tools/mapgen/xsection.ts, roadmesh.ts, paths.ts, islands.ts, roadside.ts,
 * median.ts; src/world/xsection.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pointInRing, projectOnPolyline } from '../../src/core/geom.ts';
import { LaneGraph } from '../../src/world/lanes.ts';
import { parkedOutline } from '../../src/world/parked.ts';
import { GM } from '../../src/world/tilefmt.ts';
import type { WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts } from '../../src/world/world.ts';
import { FRONT, GUTTER_DEFAULT, MEDIAN, PARK, edgeLineOn, gutterWidth } from '../../src/world/xsection.ts';
import { CoverMap } from '../../tools/mapgen/cover.ts';
import { ISLAND_CLEAR, addIslands, clearOfLanes, islandMaterial, pointIslandRing, selfCrossing } from '../../tools/mapgen/islands.ts';
import { TileSet } from '../../tools/mapgen/meshacc.ts';
import type { TileData } from '../../tools/mapgen/meshacc.ts';
import { addMedians } from '../../tools/mapgen/median.ts';
import { OsmData } from '../../tools/mapgen/osm.ts';
import type { Tags } from '../../tools/mapgen/osm.ts';
import { addParkedCars, sideParking } from '../../tools/mapgen/parking.ts';
import { addPaths, isDrawnPath, pathMaterial, pathWidth } from '../../tools/mapgen/paths.ts';
import { RoadMesher } from '../../tools/mapgen/roadmesh.ts';
import { buildRoadGraph } from '../../tools/mapgen/roads.ts';
import type { EdgeFeature } from '../../tools/mapgen/roads.ts';
import { addFrontage, addTreeBulbs, barrierHeight, fenceDrawn, findStripTrees } from '../../tools/mapgen/roadside.ts';
import { TerrainGrid } from '../../tools/mapgen/terrain.ts';
import { taggedSides } from '../../tools/mapgen/xsection.ts';

interface Town {
  world: World;
  lanes: LaneGraph;
  osm: OsmData;
  features: EdgeFeature[][];
  edgeOf(way: number): number;
}

function town(ways: Array<{ id: number; nodes: Array<[number, number, number]>; tags: Tags }>, nodeTags: Record<number, Tags> = {}, extra: Array<{ id: number; nodes: Array<[number, number, number]>; tags: Tags }> = []): Town {
  const osm = new OsmData();
  for (const w of [...ways, ...extra]) {
    for (const [id, x, z] of w.nodes) osm.nodes.set(id, { id, x, z, tags: nodeTags[id] ?? null });
    const way = { id: w.id, refs: w.nodes.map((n) => n[0]), tags: w.tags };
    osm.ways.push(way);
    osm.wayById.set(way.id, way);
  }
  for (const [id, t] of Object.entries(nodeTags)) {
    const n = osm.nodes.get(Number(id));
    if (n) n.tags = t;
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
  const world = new World(json);
  return { world, lanes: new LaneGraph(world), osm, features: g.edgeFeatures, edgeOf: (way) => g.wayEdges.get(way)![0] };
}

const tiles = (): TileSet => new TileSet(-250, -250, 250, 250, 250);
const flat = (): TerrainGrid => new TerrainGrid(-250, -250, 250, 250, 5);
const all = (ts: TileSet): TileData[] => [...ts.tiles.values()];
/** the vertices of a mesh layer with material `m`: [x, y, z] */
function withMat(ts: TileSet, layer: 'ground' | 'mark', m: number): number[][] {
  const out: number[][] = [];
  for (const t of all(ts)) {
    const acc = t[layer];
    for (let i = 0; i < acc.a8.length; i++) if (acc.a8[i] === m) out.push([acc.pos[i * 3], acc.pos[i * 3 + 1], acc.pos[i * 3 + 2]]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the tags

test('tags: gutter, edge lines, paved verge with trees, frontage, tree bulbs, paved median', () => {
  const s = taggedSides(
    {
      highway: 'residential',
      gutter: 'no',
      'gutter:left': '0.5',
      'lane_markings:edge': 'right',
      'verge:right': 'paving_stones;trees',
      'verge:right:width': '2',
      'frontage:left': 'hedge',
      'frontage:left:height': '1.6',
      'frontage:right': 'fence',
      'parking:right': 'lane',
      'parking:right:trees': '15',
      'parking:left': 'lane',
      'parking:left:trees': 'yes',
    },
    false,
    false,
  );
  assert.equal(s.left.side.g, 0.5);
  assert.equal(s.right.side.g, 0);
  assert.equal(s.right.side.el, 1);
  assert.equal(s.left.side.el, 0);
  assert.deepEqual([s.right.side.v, s.right.side.vp, s.right.side.vt], [2, 1, 1]);
  assert.deepEqual([s.left.side.ft, s.left.side.fh], [FRONT.HEDGE, 1.6]);
  assert.deepEqual([s.right.side.ft, s.right.side.fh], [FRONT.FENCE, undefined]);
  assert.equal(s.right.side.pt, 15);
  assert.equal(s.left.side.pt, 20);
  assert.equal(taggedSides({ highway: 'secondary', oneway: 'yes', 'median:contents': 'paving_stones;trees' }, true, false).median, MEDIAN.PAVED | MEDIAN.TREES);
  // a plain verge stays as it was
  assert.deepEqual([taggedSides({ 'verge:left': 'grass' }, false, false).left.side.v, taggedSides({ 'verge:left': 'grass' }, false, false).left.side.vp], [1.5, undefined]);
  assert.equal(taggedSides({ 'verge:left': 'no' }, false, false).left.side.v, undefined);
});

test('gutter: in towns beside a raised kerb, not outside them, not beside bays, as tagged', () => {
  assert.equal(gutterWidth({}, true, 0.12), GUTTER_DEFAULT);
  assert.equal(gutterWidth(undefined, false, 0.12), 0);
  assert.equal(gutterWidth({}, true, 0), 0, 'no kerb: no gutter');
  assert.equal(gutterWidth({ k: 1 }, true, 0.03), 0, 'lowered kerb');
  assert.equal(gutterWidth({ g: 0 }, true, 0.12), 0);
  assert.equal(gutterWidth({ g: 0.5 }, false, 0.12), 0.5);
  assert.equal(gutterWidth({ p: PARK.STREET_SIDE }, true, 0.12), 0);
  assert.equal(edgeLineOn(undefined, true), true);
  assert.equal(edgeLineOn({ el: 0 }, true), false);
  assert.equal(edgeLineOn({ el: 1 }, false), true);
});

test('gutter: drawn along the kerbs of a town street and its junction corners, between asphalt and kerb', () => {
  const t = town([
    { id: 1, nodes: [[1, 0, 0], [2, 100, 0]], tags: { highway: 'residential', sidewalk: 'both' } },
    { id: 2, nodes: [[2, 100, 0], [3, 200, 0]], tags: { highway: 'residential', sidewalk: 'both' } },
    { id: 3, nodes: [[2, 100, 0], [4, 100, 80]], tags: { highway: 'residential', sidewalk: 'both' } },
  ]);
  const ts = tiles();
  new RoadMesher(t.world, ts, { ground: () => 0 }).build();
  const e = t.world.edges[t.edgeOf(1)];
  const g = withMat(ts, 'ground', GM.SETT);
  assert.ok(g.length > 10, 'gutter on the ribbons');
  const proj = { s: 0, off: 0, d2: 0, seg: 0 };
  for (const [x, , z] of g) {
    if (x > 90) continue;
    projectOnPolyline(e.pl, x, z, proj);
    const a = Math.abs(proj.off);
    assert.ok(Math.abs(a - e.width / 2) < 1e-6 || Math.abs(a - (e.width / 2 - GUTTER_DEFAULT)) < 1e-6, `gutter vertex ${a.toFixed(2)} from the middle`);
  }
  assert.ok(withMat(ts, 'mark', GM.SETT).length > 4, 'gutter round the junction corners');
  // gutter=no: none
  const n = town([{ id: 1, nodes: [[1, 0, 0], [2, 100, 0]], tags: { highway: 'residential', sidewalk: 'both', gutter: 'no' } }]);
  const ts2 = tiles();
  new RoadMesher(n.world, ts2, { ground: () => 0 }).build();
  assert.equal(withMat(ts2, 'ground', GM.SETT).length, 0);
});

test('edge lines: lane_markings:edge turns them on and off per side', () => {
  const marks = (tags: Tags): number => {
    const t = town([{ id: 1, nodes: [[1, -150, 0], [2, 150, 0]], tags }]);
    const ts = tiles();
    new RoadMesher(t.world, ts, { ground: () => 0 }).build();
    return all(ts).reduce((n, tile) => n + tile.mark.pos.length, 0);
  };
  const base: Tags = { highway: 'secondary', 'source:maxspeed': 'DE:rural' };
  const both = marks(base);
  const none = marks({ ...base, 'lane_markings:edge': 'no' });
  const right = marks({ ...base, 'lane_markings:edge': 'right' });
  assert.ok(none < right && right < both, `${none} < ${right} < ${both}`);
  const town0 = marks({ highway: 'secondary', 'source:maxspeed': 'DE:urban' });
  const townOn = marks({ highway: 'secondary', 'source:maxspeed': 'DE:urban', 'lane_markings:edge': 'yes' });
  assert.ok(townOn > town0, 'in town only when tagged');
});

// ---------------------------------------------------------------------------
// paths

test('paths: which are drawn, their widths and surfaces', () => {
  assert.equal(isDrawnPath({ highway: 'footway' }), true);
  assert.equal(isDrawnPath({ highway: 'footway', bridge: 'yes' }), false);
  assert.equal(isDrawnPath({ highway: 'path', surface: 'grass' }), false);
  assert.equal(isDrawnPath({ highway: 'steps' }), false);
  assert.equal(isDrawnPath({ highway: 'pedestrian', area: 'yes' }), false);
  assert.equal(pathWidth({ highway: 'footway' }), 2.0);
  assert.equal(pathWidth({ highway: 'cycleway' }), 2.5);
  assert.equal(pathWidth({ highway: 'path', bicycle: 'designated', foot: 'designated' }), 2.5);
  assert.equal(pathWidth({ highway: 'footway', width: '3,5' }), 3.5);
  assert.equal(pathMaterial({ highway: 'footway', surface: 'asphalt' }, true), GM.ASPHALT_OLD);
  assert.equal(pathMaterial({ highway: 'footway', surface: 'paving_stones' }, false), GM.PAVING);
  assert.equal(pathMaterial({ highway: 'path', surface: 'compacted' }, false), GM.PATH);
  assert.equal(pathMaterial({ highway: 'footway', surface: 'sett' }, false), GM.SETT);
  assert.equal(pathMaterial({ highway: 'footway' }, true), GM.PAVING);
  assert.equal(pathMaterial({ highway: 'cycleway' }, false), GM.ASPHALT_OLD);
});

test('paths: drawn on the ground in their width, not across the road they cross, no tree on them', () => {
  const t = town(
    [{ id: 1, nodes: [[1, -150, 0], [2, 150, 0]], tags: { highway: 'residential', sidewalk: 'both' } }],
    {},
    [
      { id: 50, nodes: [[50, 20, -60], [51, 20, 60]], tags: { highway: 'footway', surface: 'asphalt' } },
      { id: 51, nodes: [[52, -100, 40], [53, -40, 40]], tags: { highway: 'cycleway' } },
    ],
  );
  const ts = tiles();
  const cover = new CoverMap(-250, -250, 250, 250);
  const mask = new Uint8Array(cover.w * cover.h);
  const stats = addPaths(t.osm, t.world, cover, flat(), ts, () => true, mask);
  assert.equal(stats.ways, 2);
  const e = t.world.edges[t.edgeOf(1)];
  const walk = e.width / 2 + Math.max(e.swL, e.swR);
  const foot = withMat(ts, 'ground', GM.ASPHALT_OLD);
  assert.ok(foot.length > 8);
  for (const [x, y, z] of foot) {
    assert.ok(Math.abs(y - 0.05) < 1e-6, 'on the ground, a little above it');
    if (Math.abs(x - 20) < 2) assert.ok(Math.abs(z) > walk - 2.6, `a path vertex on the road at z ${z.toFixed(2)}`);
  }
  // 2 m wide
  const xs = foot.filter(([, , z]) => z < -20).map(([x]) => x);
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 2) < 1e-6);
  assert.ok(stats.km > 0.15 && stats.km < 0.2, `${stats.km} km`);
  // the cells under it are taken
  const cell = (x: number, z: number): number => mask[Math.floor((z - cover.minZ) / cover.cell) * cover.w + Math.floor((x - cover.minX) / cover.cell)];
  assert.equal(cell(20, -40), 1);
  assert.equal(cell(-70, 40), 1);
  assert.equal(cell(100, 100), 0);
});

// ---------------------------------------------------------------------------
// traffic islands

test('islands: surfaces, rings that cross themselves, pushed back from the lanes', () => {
  assert.equal(islandMaterial(null), GM.PAVING);
  assert.equal(islandMaterial({ 'island:surface': 'grass' }), GM.VERGE);
  assert.equal(islandMaterial({ 'island:surface': 'plants' }), GM.VERGE);
  assert.equal(islandMaterial({ 'island:surface': 'cobblestone' }), GM.SETT);
  assert.equal(islandMaterial({ surface: 'asphalt' }), GM.ASPHALT_OLD);
  assert.equal(selfCrossing([0, 0, 4, 0, 0, 4, 4, 4]), true);
  assert.equal(selfCrossing([0, 0, 4, 0, 4, 4, 0, 4]), false);
  // a lane centre line along z = 0: an island from z = 0.5 to 3 keeps 1.1 m from it
  const dist = (x: number, z: number, out: { x: number; z: number }): number => {
    out.x = x;
    out.z = 0;
    return Math.abs(z);
  };
  const ring = clearOfLanes([0, 0.5, 6, 0.5, 6, 3, 0, 3], dist)!;
  assert.ok(ring);
  for (let i = 1; i < ring.length; i += 2) assert.ok(ring[i] >= ISLAND_CLEAR - 1e-9);
  // one that the lane runs through, one that lies in it: left out
  assert.equal(clearOfLanes([0, -0.5, 6, -0.5, 6, 3, 0, 3], dist), null);
  assert.equal(clearOfLanes([0, 0.2, 6, 0.2, 6, 0.6, 0, 0.6], dist), null);
});

test('islands: at a crossing with an island, between the directions, a keep-right sign at each tip facing the traffic', () => {
  const t = town([{ id: 1, nodes: [[1, -150, 0], [2, 0, 0], [3, 150, 0]], tags: { highway: 'secondary', lanes: '2', width: '9' } }], {
    2: { highway: 'crossing', crossing: 'unmarked', 'crossing:island': 'yes' },
  });
  const ts = tiles();
  const stats = addIslands(t.osm, t.world, ts, flat(), t.lanes, t.features, () => true);
  assert.equal(stats.points, 1, JSON.stringify(stats));
  const signs = all(ts).flatMap((tile) => tile.signs);
  assert.equal(signs.length, 2);
  for (const s of signs) {
    assert.deepEqual(s.s, ['222']);
    // the plate faces the traffic coming to it: at the west tip the eastbound traffic (facing west: yaw π/2)
    const facingX = -Math.sin(s.yaw);
    if (s.x < 0) assert.ok(facingX < -0.99, `west sign faces ${facingX}`);
    else assert.ok(facingX > 0.99, `east sign faces ${facingX}`);
    assert.ok(Math.abs(s.x) < 3 && Math.abs(s.z) < 0.5);
  }
  // the top a kerb above the road, clear of the lanes
  const top = withMat(ts, 'ground', GM.PAVING);
  assert.ok(top.length >= 6);
  for (const [, y, z] of top) {
    assert.ok(Math.abs(y - 0.12) < 0.01);
    assert.ok(Math.abs(z) < 2.25 - ISLAND_CLEAR + 1e-6, `island reaches z ${z}`);
  }
});

test('islands: a mapped island area, and the island where a road splits into two one-way branches', () => {
  // a two-way street from the west splits at x = 0 into two one-way branches that run to a cross street at x = 60
  const t = town(
    [
      { id: 1, nodes: [[1, -120, 0], [2, 0, 0]], tags: { highway: 'tertiary' } },
      { id: 2, nodes: [[2, 0, 0], [3, 20, 5], [4, 60, 5]], tags: { highway: 'tertiary', oneway: 'yes' } },
      { id: 3, nodes: [[5, 60, -5], [6, 20, -5], [2, 0, 0]], tags: { highway: 'tertiary', oneway: 'yes' } },
      { id: 4, nodes: [[7, 60, -80], [5, 60, -5], [4, 60, 5], [8, 60, 80]], tags: { highway: 'tertiary' } },
    ],
    {},
    [{ id: 90, nodes: [[90, -60, -1], [91, -50, -1], [92, -50, 1], [93, -60, 1], [90, -60, -1]], tags: { 'area:highway': 'traffic_island', 'island:surface': 'grass' } }],
  );
  const ts = tiles();
  const stats = addIslands(t.osm, t.world, ts, flat(), t.lanes, t.features, () => true);
  assert.equal(stats.splits, 1, JSON.stringify(stats));
  assert.ok(withMat(ts, 'ground', GM.PAVING).length > 6, 'the split island, paved');
  // the mapped one lies in the street – it is pushed back from the lanes or left out, never in them
  const grass = withMat(ts, 'ground', GM.VERGE);
  for (const [, , z] of grass) assert.ok(Math.abs(z) < 1.01);
  // the sign at the split's tip faces the traffic coming from the west
  const signs = all(ts).flatMap((tile) => tile.signs).filter((s) => s.x > 0);
  assert.ok(signs.length >= 1);
  assert.ok(-Math.sin(signs[0].yaw) < -0.9, 'it faces west');
  for (const s of signs) assert.ok(pointInRing(s.x, s.z, [0, 0, 60, 6, 60, -6]) || s.x < 60);
});

// ---------------------------------------------------------------------------
// tree bulbs, frontage

test('tree bulbs: every n m by tag and where a mapped tree stands in the strip; no car there', () => {
  const t = town(
    [{ id: 1, nodes: [[1, -150, 0], [2, 150, 0]], tags: { highway: 'residential', sidewalk: 'both', 'parking:right': 'lane', 'parking:right:trees': '30', 'parking:left': 'lane' } }],
    { 60: { natural: 'tree' } },
    [{ id: 60, nodes: [[60, 33, 0]], tags: {} }],
  );
  const e = t.world.edges[t.edgeOf(1)];
  // the mapped tree in the left strip (north: z < 0)
  const tree = t.osm.nodes.get(60)!;
  tree.z = -(e.width / 2 - 1);
  const found = findStripTrees(t.world, t.osm, t.features);
  assert.deepEqual([...found.used], [60]);
  const right = sideParking(t.world, e, -1, [], found.byEdge[e.id])!;
  const bulbs = right.bays.filter((b) => b.tree !== undefined);
  assert.ok(bulbs.length >= 8 && bulbs.length <= 10, `${bulbs.length} bulbs`);
  for (let i = 1; i < bulbs.length; i++) assert.ok(bulbs[i].s0 - bulbs[i - 1].s0 >= 29, 'about 30 m apart');
  const left = sideParking(t.world, e, 1, [], found.byEdge[e.id])!;
  const leftBulbs = left.bays.filter((b) => b.tree !== undefined);
  assert.equal(leftBulbs.length, 1);
  assert.equal(leftBulbs[0].tree, 60);
  const ts = tiles();
  const stats = addTreeBulbs(t.world, ts, t.features, found.byEdge);
  assert.equal(stats.bulbs, bulbs.length + 1);
  assert.ok(withMat(ts, 'ground', GM.VERGE).length > 0);
  addParkedCars(t.world, ts, t.features, found.byEdge);
  const proj = { s: 0, off: 0, d2: 0, seg: 0 };
  for (const tile of all(ts)) {
    for (const c of tile.parked) {
      const pts = parkedOutline(c);
      for (let i = 0; i < pts.length; i += 2) {
        projectOnPolyline(e.pl, pts[i], pts[i + 1], proj);
        const strip = proj.off < 0 ? bulbs : leftBulbs;
        for (const b of strip) assert.ok(proj.s < b.s0 + 0.2 || proj.s > b.s1 - 0.2, `a car in the bulb at ${b.s0.toFixed(1)}`);
      }
    }
  }
});

test('frontage: a hedge behind the pavement, gaps at side streets; a lawn; young trees in a verge', () => {
  const t = town([
    { id: 1, nodes: [[1, -150, 0], [2, 0, 0]], tags: { highway: 'residential', sidewalk: 'both', 'frontage:right': 'hedge', 'frontage:left': 'lawn', 'verge:left': 'grass;trees' } },
    { id: 2, nodes: [[2, 0, 0], [3, 150, 0]], tags: { highway: 'residential', sidewalk: 'both', 'frontage:both': 'fence', 'frontage:both:height': '1.8' } },
    { id: 3, nodes: [[2, 0, 0], [4, 0, 100]], tags: { highway: 'residential', sidewalk: 'both' } },
  ]);
  const ts = tiles();
  const stats = addFrontage(t.world, ts, (x1, z1, x2, z2, y) => t.lanes.wallInLane(x1, z1, x2, z2, y, 1.3), () => false);
  // (round 3: an untagged hedge frontage is plot by plot – hedges, fences, walls, open lawn, driveways: mapgen/fences.ts)
  assert.ok(stats.hedgeKm > 0.03 && stats.hedgeKm < 0.15, `${stats.hedgeKm} km of hedge`);
  assert.ok(stats.hedgeKm + stats.fenceKm + stats.wallKm + stats.openKm > 0.35);
  assert.ok(stats.fenceKm > 0.2, `${stats.fenceKm} km of fence`);
  assert.ok(stats.lawnKm > 0.12);
  assert.ok(stats.vergeTrees >= 10);
  const e = t.world.edges[t.edgeOf(1)];
  const back = e.width / 2 + e.swR;
  const walls = all(ts).flatMap((tile) => {
    const out: number[][] = [];
    for (let i = 0; i < tile.collSeg.length; i += 5) out.push(tile.collSeg.slice(i, i + 5));
    return out;
  });
  assert.ok(walls.length > 20);
  for (const [x1, z1] of walls) {
    // behind the pavement, not across the side street (x = 0, running south)
    assert.ok(Math.abs(Math.abs(z1) - back - 0.45) < 0.5 || Math.abs(Math.abs(z1) - back - 0.08) < 0.5, `wall at z ${z1}`);
    if (z1 > 0) assert.ok(Math.abs(x1) > 3, `wall across the side street at x ${x1}`);
  }
  // (the fences of way 2, east of x = 0 – the hedges of way 1 vary in height)
  const fenceTop = all(ts).flatMap((tile) => Array.from({ length: tile.struct.pos.length / 3 }, (_, i) => (tile.struct.pos[i * 3] > 3 ? tile.struct.pos[i * 3 + 1] : 0)));
  assert.ok(Math.max(...fenceTop) > 1.8 && Math.max(...fenceTop) < 2.0, 'the fence as high as tagged, on the pavement');
});

test('barriers: mapped height, which fences are drawn', () => {
  assert.equal(barrierHeight({ height: '1.8' }), 1.8);
  assert.equal(barrierHeight({ height: '80 cm' }), 0.8);
  assert.equal(barrierHeight({ height: 'tall' }), undefined);
  assert.equal(fenceDrawn({ fence_type: 'wire' }, () => 5, [0, 0, 1, 1]), false);
  assert.equal(fenceDrawn({ fence_type: 'wood' }, () => 0, [0, 0, 1, 1]), true);
  assert.equal(fenceDrawn({}, () => 5, [0, 0, 1, 1]), true, 'in a garden');
  assert.equal(fenceDrawn({}, () => 0, [0, 0, 1, 1]), false, 'round a meadow');
});

test('median: paving stones with young trees', () => {
  const t = town([
    { id: 1, nodes: [[1, 0, 9], [2, 200, 9]], tags: { highway: 'secondary', oneway: 'yes', 'median:contents': 'paving_stones;trees' } },
    { id: 2, nodes: [[3, 200, -9], [4, 0, -9]], tags: { highway: 'secondary', oneway: 'yes' } },
  ]);
  const ts = tiles();
  const stats = addMedians(t.world, ts);
  assert.ok(withMat(ts, 'ground', GM.PAVING).length > 10);
  assert.ok(stats.trees >= 15, `${stats.trees} trees`);
  for (const tile of all(ts)) for (let i = 0; i < tile.trees.length; i += 5) assert.ok(tile.trees[i + 3] <= 7 && tile.trees[i + 4] === 0, 'young trees (broadleaf, drawn slim at this height)');
});
