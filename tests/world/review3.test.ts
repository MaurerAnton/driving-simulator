// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the third round of comparing street photos with the game found wrong
 * in the map build, and how it is now: frontages plot by plot (hedges of a
 * few heights, fences, low walls, open lawn, driveway gaps), pavers as the
 * default pavement, a separate footway lending its surface only when it is
 * the street's pavement, narrow medians and islands paved, lane lines on
 * tagged multi-lane approaches and no edge lines at 50 km/h, trees in pits
 * not on asphalt, slim young street trees, undergrowth in tree stands,
 * build-outs with a young tree and a Leitbake.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { treeWidth } from '../../src/render/props.ts';
import { LaneGraph } from '../../src/world/lanes.ts';
import { GM } from '../../src/world/tilefmt.ts';
import { EF } from '../../src/world/types.ts';
import type { WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts } from '../../src/world/world.ts';
import { BARRIER_STYLES, fenceStyle, frontagePlan, isHedge, plotStyle, wallStyle } from '../../tools/mapgen/fences.ts';
import { NARROW_ISLAND, narrowIslandMaterial } from '../../tools/mapgen/islands.ts';
import { TileSet } from '../../tools/mapgen/meshacc.ts';
import type { TileData } from '../../tools/mapgen/meshacc.ts';
import { addMedians, NARROW_MEDIAN } from '../../tools/mapgen/median.ts';
import { treePit } from '../../tools/mapgen/objects.ts';
import { OsmData } from '../../tools/mapgen/osm.ts';
import type { Tags } from '../../tools/mapgen/osm.ts';
import { RoadMesher } from '../../tools/mapgen/roadmesh.ts';
import { buildRoadGraph, roadAttrs } from '../../tools/mapgen/roads.ts';
import type { EdgeFeature } from '../../tools/mapgen/roads.ts';
import { addFrontage } from '../../tools/mapgen/roadside.ts';
import { WALK_DEFAULT } from '../../tools/mapgen/xsection.ts';

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

function town(ways: WaySpec[], nodeTags: Record<number, Tags> = {}): Town {
  const osm = osmOf(ways, nodeTags);
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
const all = (ts: TileSet): TileData[] => [...ts.tiles.values()];
const trees = (ts: TileSet): number[][] =>
  all(ts).flatMap((t) => {
    const out: number[][] = [];
    for (let i = 0; i < t.trees.length; i += 5) out.push(t.trees.slice(i, i + 5));
    return out;
  });
const groundMat = (ts: TileSet, mat: number): number => all(ts).reduce((n, t) => n + [...t.ground.a8].filter((v) => v === mat).length, 0);

// ---------------------------------------------------------------------------
// 1. frontages

test('a frontage is cut into plots: mostly hedges of two heights, some fences and walls, open lawn, driveway gaps – the same on every build', () => {
  const plan = frontagePlan(1, 0, 2000, 4711, 1);
  assert.deepEqual(plan, frontagePlan(1, 0, 2000, 4711, 1), 'deterministic');
  const len = (f: (p: (typeof plan)[number]) => boolean): number => plan.filter(f).reduce((n, p) => n + p.s1 - p.s0, 0);
  const total = len(() => true);
  const hedge = len((p) => p.style !== null && isHedge(p.style));
  const fence = len((p) => p.style !== null && BARRIER_STYLES[p.style].halfW < 0.05);
  const open = len((p) => p.style === null);
  assert.ok(hedge / total > 0.35 && hedge / total < 0.75, `hedge ${hedge / total}`);
  assert.ok(fence / total > 0.1, `fence ${fence / total}`);
  assert.ok(open / total > 0.05, `open ${open / total}`);
  // driveways: gaps between plots
  let gaps = 0;
  for (let i = 1; i < plan.length; i++) if (plan[i].s0 - plan[i - 1].s1 > 2) gaps++;
  assert.ok(gaps > plan.length * 0.4, `${gaps} gaps of ${plan.length}`);
  // low and tall hedges
  const hs = plan.filter((p) => p.style === 'hedge').map((p) => p.h);
  assert.ok(hs.some((h) => h <= 1.2) && hs.some((h) => h >= 1.5));
  assert.ok(Math.max(...hs) <= 2.3);
  for (const p of plan) assert.ok(p.s1 - p.s0 >= 4 && p.s1 - p.s0 <= 26);
  // a tagged height: that kind on every plot
  assert.ok(frontagePlan(1, 0, 300, 1, -1, 1.6).every((p) => p.style === 'hedge' && p.h === 1.6));
  // a frontage of fences is mostly fences, of walls mostly walls
  assert.ok(plotStyle(2, 0.1, 0.5).style !== null && !isHedge(plotStyle(2, 0.1, 0.5).style!));
  assert.match(String(plotStyle(3, 0.1, 0.5).style), /^wall_/);
});

test('frontage along a street: right behind the pavement, varied, nothing over 2.3 m, a gap at each driveway', () => {
  const t = town([{ id: 7, nodes: [[1, -200, 0], [2, 200, 0]], tags: { highway: 'residential', width: '6', sidewalk: 'both', 'sidewalk:both:width': '1.8', 'frontage:right': 'hedge' } }]);
  const e = t.world.edges[t.edgeOf(7)];
  const ts = tiles();
  const st = addFrontage(t.world, ts, (x1, z1, x2, z2, y) => t.lanes.wallInLane(x1, z1, x2, z2, y, 1.3), () => false);
  assert.ok(st.hedgeKm > 0.05 && st.hedgeKm < 0.35, `hedge ${st.hedgeKm}`);
  assert.ok(st.hedgeKm + st.fenceKm + st.wallKm < 0.39, 'driveways and open lawns between');
  const top = Math.max(...all(ts).flatMap((tile) => Array.from({ length: tile.struct.pos.length / 3 }, (_, i) => tile.struct.pos[i * 3 + 1])));
  assert.ok(top <= 2.3 + KERB + 0.05, `top ${top}`);
  // (right: z > 0 for a road running east) – every wall line right behind the pavement
  const walk = e.width / 2 + e.swR;
  for (const tile of all(ts)) for (let i = 0; i < tile.collSeg.length; i += 5) assert.ok(tile.collSeg[i + 1] > walk && tile.collSeg[i + 1] < walk + 0.45, `at z ${tile.collSeg[i + 1]}`);
});
const KERB = 0.12;

test('mapped fences and walls: their kind from fence_type, material, colour', () => {
  assert.equal(fenceStyle({ fence_type: 'chain_link' }, 1), 'mesh');
  assert.equal(fenceStyle({ fence_type: 'railing', colour: 'white' }, 1), 'railing_white');
  assert.equal(fenceStyle({ fence_type: 'metal' }, 1), 'railing_dark');
  assert.equal(fenceStyle({ fence_type: 'split_rail' }, 1), 'post_rail');
  assert.equal(fenceStyle({ fence_type: 'wood' }, 1), 'picket');
  assert.equal(fenceStyle({ fence_type: 'panel' }, 1), 'panel');
  assert.equal(fenceStyle({}, 5), fenceStyle({}, 5), 'one without a kind: picked by its id');
  assert.equal(wallStyle({ material: 'brick' }), 'wall_brick');
  assert.equal(wallStyle({}), 'wall_block');
});

// ---------------------------------------------------------------------------
// 2./3. pavements

test('the pavements of the detail region are pavers where nothing is said', () => {
  assert.equal(WALK_DEFAULT, GM.PAVING);
  const t = town([{ id: 1, nodes: [[1, -100, 0], [2, 100, 0]], tags: { highway: 'residential', sidewalk: 'both' } }]);
  const ts = tiles();
  new RoadMesher(t.world, ts, { ground: () => 0, features: t.features }).build();
  assert.ok(groundMat(ts, GM.PAVING) > 0);
  assert.equal(groundMat(ts, GM.SIDEWALK), 0, 'no light slabs');
});

test('a separate footway lends its surface only when it runs right beside the kerb; a gap under a metre is paved', () => {
  // a road 5.5 m wide: kerb at 2.75; footways 2 m wide whose inner edge lies 0.5 m (left) and 3 m (right) beyond it
  const t = town([
    { id: 1, nodes: [[1, -100, 0], [2, 100, 0]], tags: { highway: 'residential', width: '5.5' } },
    { id: 50, nodes: [[50, -100, -4.25], [51, 100, -4.25]], tags: { highway: 'footway', footway: 'sidewalk', surface: 'asphalt' } },
    { id: 52, nodes: [[52, -100, 6.75], [53, 100, 6.75]], tags: { highway: 'footway', footway: 'sidewalk', surface: 'paving_stones', colour: 'red' } },
  ]);
  const e = t.world.edges[t.edgeOf(1)];
  assert.equal(e.xl?.wm, GM.ASPHALT_OLD, 'left: the footway beside the kerb lends its asphalt');
  assert.equal(e.xl?.v, undefined, 'and no hairline of grass before it');
  assert.equal(e.xr?.wm, undefined, 'right: a red path 3 m out is a path of its own – the pavement stays grey');
  assert.ok((e.xr?.v ?? 0) >= 2.5, 'a verge before it');
});

// ---------------------------------------------------------------------------
// 4. medians and islands

test('an untagged narrow median between two carriageways is kerbed pavers – in the detail region only; a wide one is left', () => {
  const pair = (d: number): Town =>
    town([
      { id: 1, nodes: [[1, -150, d], [2, 150, d]], tags: { highway: 'secondary', oneway: 'yes', lanes: '1', sidewalk: 'no' } },
      { id: 2, nodes: [[3, 150, -d], [4, -150, -d]], tags: { highway: 'secondary', oneway: 'yes', lanes: '1', sidewalk: 'no' } },
    ]);
  const narrow = pair(3.4);
  const w = narrow.world.edges[0].width;
  assert.ok(6.8 - w < NARROW_MEDIAN && 6.8 - w > 0.8, `gap ${6.8 - w}`);
  const ts = tiles();
  const st = addMedians(narrow.world, ts, () => true);
  assert.ok(st.pavedKm > 0.2, `${st.pavedKm}`);
  assert.ok(groundMat(ts, GM.PAVING) > 0 && groundMat(ts, GM.KERB) > 0);
  assert.equal(groundMat(ts, GM.VERGE), 0);
  // outside the region (no `fresh`): nothing, as the published map
  const ts0 = tiles();
  assert.equal(addMedians(narrow.world, ts0).pavedKm, 0);
  assert.equal(all(ts0).reduce((n, t) => n + t.ground.pos.length, 0), 0);
  // a wide one: left to the ground cover
  const wide = pair(12);
  assert.equal(addMedians(wide.world, tiles(), () => true).pavedKm, 0);
});

test('a narrow island that only OpenStreetMap calls grass is paved; our own island:surface is taken as it is', () => {
  const strip = [0, 0, 20, 0, 20, 2, 0, 2];
  assert.equal(narrowIslandMaterial(strip, { surface: 'grass' }), GM.PAVING);
  assert.equal(narrowIslandMaterial(strip, { 'island:surface': 'grass' }), GM.VERGE);
  const big = [0, 0, 30, 0, 30, 2 * NARROW_ISLAND + 4, 0, 2 * NARROW_ISLAND + 4];
  assert.equal(narrowIslandMaterial(big, { surface: 'grass' }), GM.VERGE);
});

test('a tree pit: kerbed, a kerb high, grass on top', () => {
  const ts = tiles();
  treePit(ts, 10, 100, 10);
  assert.ok(groundMat(ts, GM.VERGE) === 4 && groundMat(ts, GM.KERB) === 16);
  const ys = all(ts).flatMap((t) => Array.from({ length: t.ground.pos.length / 3 }, (_, i) => t.ground.pos[i * 3 + 1]));
  assert.ok(Math.abs(Math.max(...ys) - 100.12) < 1e-6);
});

// ---------------------------------------------------------------------------
// 5. markings

test('lane lines on tagged multi-lane approaches; no edge lines by class at 50 km/h; none on a one-lane street', () => {
  const two = roadAttrs({ highway: 'residential', oneway: 'yes', lanes: '2' }, true)!;
  assert.ok((two.flags & EF.MARKED) !== 0, 'two lanes one way: lane line');
  const turn = roadAttrs({ highway: 'unclassified', 'turn:lanes:forward': 'left|through', 'lanes:forward': '2', 'lanes:backward': '1' }, true)!;
  assert.ok((turn.flags & EF.MARKED) !== 0, 'turn lanes: lines');
  const one = roadAttrs({ highway: 'residential', lanes: '1' }, true)!;
  assert.equal(one.flags & EF.MARKED, 0);
  const no = roadAttrs({ highway: 'residential', oneway: 'yes', lanes: '2', lane_markings: 'no' }, true)!;
  assert.equal(no.flags & EF.MARKED, 0, 'lane_markings=no wins');
  const zone = roadAttrs({ highway: 'residential', oneway: 'yes', lanes: '2', 'zone:maxspeed': 'DE:30' }, true)!;
  assert.equal(zone.flags & EF.MARKED, 0, 'not in a 30 zone');
  // a marked road outside the built-up area: edge lines at 70, not at 50
  assert.ok((roadAttrs({ highway: 'tertiary', maxspeed: '70' }, false)!.flags & EF.EDGE_LINES) !== 0);
  assert.equal(roadAttrs({ highway: 'tertiary', maxspeed: '50' }, false)!.flags & EF.EDGE_LINES, 0);
  assert.ok((roadAttrs({ highway: 'tertiary', maxspeed: '50' }, false)!.flags & EF.MARKED) !== 0, 'the centre line stays');
  // overtaking=no: a solid centre line
  assert.ok((roadAttrs({ highway: 'tertiary', overtaking: 'no' }, true)!.flags & EF.SOLID_CENTER) !== 0);
});

// ---------------------------------------------------------------------------
// 7./8. trees and build-outs

test('young street trees are slim, old ones keep their width; trunks thin', () => {
  const crown = (h: number): number => treeWidth(0, h, 0.5) * 0.6;
  assert.ok(crown(4.5) < 3.2, `${crown(4.5)}`);
  assert.ok(crown(7) > 4.5 && crown(7) < 6, `${crown(7)}`);
  assert.ok(crown(15) > 10 && crown(15) < 13);
});

test('a build-out: a young broadleaf tree where its trunk keeps clear of the lane, a Leitbake of red and white bands', () => {
  const t = town(
    [{ id: 1, nodes: [[1, -100, 0], [2, 0, 0], [3, 100, 0]], tags: { highway: 'residential', sidewalk: 'both', 'parking:both': 'lane' } }],
    { 2: { traffic_calming: 'choker', side: 'left', beacon: 'yes' } },
  );
  const ts = tiles();
  new RoadMesher(t.world, ts, { ground: () => 0, features: t.features }).build();
  const tr = trees(ts);
  assert.equal(tr.length, 1);
  assert.equal(tr[0][4], 0);
  assert.ok(tr[0][3] >= 4 && tr[0][3] <= 5.5);
  const col = (r: number): number => all(ts).reduce((n, tile) => n + [...tile.struct.a8].filter((v, i) => i % 3 === 0 && v === r).length, 0);
  assert.ok(col(196) > 0 && col(236) > 0, 'red and white');
  // the board: about 1.25 m high in all (post and five bands), 0.25 m wide
  const ys = all(ts).flatMap((tile) => Array.from({ length: tile.struct.pos.length / 3 }, (_, i) => tile.struct.pos[i * 3 + 1]));
  assert.ok(Math.max(...ys) > 1.0 && Math.max(...ys) < 1.5, `${Math.max(...ys)}`);
});

// ---------------------------------------------------------------------------
// buildings (lead of the building-colour review)

test('a tall house of the detail region does not get the palette brick tone; a low one may', async () => {
  const { addLod2Buildings } = await import('../../tools/mapgen/buildings.ts');
  const brickUnits = (h: number): number => {
    let n = 0;
    for (let k = 0; k < 80; k++) {
      const x0 = -200 + (k % 10) * 40;
      const z0 = -200 + Math.floor(k / 10) * 40;
      const ring: Array<[number, number]> = [
        [x0, z0],
        [x0 + 10, z0],
        [x0 + 10, z0 + 8],
        [x0, z0 + 8],
      ];
      const polys: number[][] = [[2, ...ring.flatMap(([x, z]) => [x, 0, z])], [1, ...ring.flatMap(([x, z]) => [x, h, z])]];
      for (let i = 0; i < 4; i++) {
        const [ax, az] = ring[i];
        const [bx, bz] = ring[(i + 1) % 4];
        polys.push([0, ax, 0, az, bx, 0, bz, bx, h, bz, ax, h, az]);
      }
      const ts = new TileSet(-250, -250, 250, 250, 500);
      addLod2Buildings([{ id: `T${k}`, fn: '31001_1000', roof: '1000', polys }], ts, { lod2Units: 0, osmFallback: 0, triangles: 0, footprints: 0 }, new Map(), new Set());
      const a = all(ts).flatMap((t) => [...t.bldg.a8]);
      let found = false;
      // (the walls are shaded by their facing: 0.94–1.02 of the colour)
      const tone = (f: number): number[] => [201, 143, 107].map((c) => Math.min(255, Math.round(c * f)));
      const tones = [tone(0.94), tone(1.02)];
      for (let i = 0; i + 2 < a.length && !found; i++) found = tones.some((t) => a[i] === t[0] && a[i + 1] === t[1] && a[i + 2] === t[2]);
      if (found) n++;
    }
    return n;
  };
  assert.ok(brickUnits(6) > 0, 'low houses: now and then the brick tone');
  assert.equal(brickUnits(14), 0, 'tall houses: rendered colours');
});
