// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The cross-section of streets beyond their lanes – parking, pavements,
 * verges, kerbs, cycle lanes, medians – from OpenStreetMap's tags to the
 * road network and the parked cars (tools/mapgen/xsection.ts, roads.ts,
 * parking.ts, src/world/xsection.ts), and the corrections of what was seen on
 * site (tools/mapgen/observedroads.ts).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectOnPolyline } from '../../src/core/geom.ts';
import { LaneGraph } from '../../src/world/lanes.ts';
import { packParked, parkedOutline, unpackParked } from '../../src/world/parked.ts';
import type { WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts } from '../../src/world/world.ts';
import { CYCLE, KERB, MEDIAN, ORIENT, PARK, sideInner, sideLayout, sideOuter } from '../../src/world/xsection.ts';
import { correctTags, loadRoadCorrections } from '../../tools/mapgen/observedroads.ts';
import { OsmData } from '../../tools/mapgen/osm.ts';
import type { Tags } from '../../tools/mapgen/osm.ts';
import { DIAGONAL_ANGLE, carMisplaced, carsOf, sideParking } from '../../tools/mapgen/parking.ts';
import { buildRoadGraph, roadAttrs } from '../../tools/mapgen/roads.ts';
import { taggedSides } from '../../tools/mapgen/xsection.ts';
import { TileSet } from '../../tools/mapgen/meshacc.ts';
import { addMedians, lookAcross } from '../../tools/mapgen/median.ts';

// (the corrections of the lists apply in the detail region only – tools/mapgen/detailregion.ts: here everywhere)
process.env.DETAIL_REGION ??= 'all';

// ---------------------------------------------------------------------------
// the corrections

test('corrections: tags replaced and deleted, other ways untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xsec-'));
  try {
    const file = join(dir, 'roads.json');
    writeFileSync(file, JSON.stringify({ about: 't', ways: { '7': { tags: { 'parking:right': 'lane', sidewalk: null } }, bad: { tags: { x: 'y' } } } }));
    const fixes = loadRoadCorrections(file);
    assert.equal(fixes.size, 1);
    assert.deepEqual(correctTags({ highway: 'residential', sidewalk: 'both' }, fixes.get(7)), { highway: 'residential', 'parking:right': 'lane' });
    assert.deepEqual(correctTags({ highway: 'service' }, fixes.get(8)), { highway: 'service' });
    // … applied where an extract is read
    const extract = join(dir, 'b.json');
    writeFileSync(
      extract,
      JSON.stringify({
        meta: { extractedAt: 'x', world: true },
        nodes: [[1, 0, 0], [2, 50, 0]],
        ways: [{ id: 7, refs: [1, 2], tags: { highway: 'residential', sidewalk: 'both' } }, { id: 9, refs: [1, 2], tags: { highway: 'service' } }],
        relations: [],
      }),
    );
    const before = process.env.OBSERVED_ROADS;
    process.env.OBSERVED_ROADS = file;
    try {
      const d = OsmData.load(extract);
      assert.deepEqual(d.wayById.get(7)?.tags, { highway: 'residential', 'parking:right': 'lane' });
      assert.deepEqual(d.wayById.get(9)?.tags, { highway: 'service' });
    } finally {
      if (before === undefined) delete process.env.OBSERVED_ROADS;
      else process.env.OBSERVED_ROADS = before;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// the tags

test('tags: parking kinds, orientation, markings, the older scheme', () => {
  const s = taggedSides({ 'parking:both': 'lane', 'parking:right:orientation': 'diagonal', 'parking:left': 'street_side' }, false, false);
  assert.equal(s.left.side.p, PARK.STREET_SIDE);
  assert.equal(s.left.side.pm, 1, 'bays beside the road are marked unless said otherwise');
  assert.equal(s.right.side.p, PARK.LANE);
  assert.equal(s.right.side.po, ORIENT.DIAGONAL);
  assert.equal(s.right.side.pm, undefined, 'a parking lane is not marked unless said so');
  const m = taggedSides({ 'parking:right': 'lane', 'parking:right:markings': 'yes', 'parking:left': 'half_on_kerb', 'parking:left:orientation': 'perpendicular' }, false, false);
  assert.equal(m.right.side.pm, 1);
  assert.equal(m.left.side.p, PARK.HALF_ON_KERB);
  assert.equal(m.left.side.po, ORIENT.PERPENDICULAR);
  assert.equal(taggedSides({ 'parking:both': 'no' }, false, false).left.side.p, undefined);
  assert.equal(taggedSides({ 'parking:both': 'separate' }, false, false).right.side.p, undefined);
  const old = taggedSides({ 'parking:lane:both': 'parallel', 'parking:lane:both:parallel': 'on_kerb' }, false, false);
  assert.equal(old.left.side.p, PARK.ON_KERB);
  assert.equal(old.right.side.p, PARK.ON_KERB);
});

test('tags: cycle lanes and tracks, kerbs, verges, medians', () => {
  // the key without a side: both sides of a two-way road, the right of a one-way one
  const two = taggedSides({ cycleway: 'lane' }, false, false);
  assert.equal(two.left.side.c, CYCLE.LANE);
  assert.equal(two.right.side.c, CYCLE.LANE);
  const one = taggedSides({ cycleway: 'lane', oneway: 'yes' }, true, false);
  assert.equal(one.left.side.c, undefined);
  assert.equal(one.right.side.c, CYCLE.LANE);
  const opp = taggedSides({ cycleway: 'opposite_lane', oneway: 'yes' }, true, false);
  assert.equal(opp.left.side.c, CYCLE.LANE);
  assert.equal(opp.right.side.c, undefined);
  const red = taggedSides({ 'cycleway:right': 'lane', 'cycleway:right:lane': 'exclusive', 'cycleway:right:surface:colour': 'red', 'cycleway:left': 'track', 'cycleway:left:width': '2' }, false, false);
  assert.equal(red.right.side.cr, 1);
  assert.equal(red.right.side.ca, undefined, 'exclusive: a solid line');
  assert.equal(red.left.side.c, CYCLE.TRACK);
  assert.equal(red.left.side.cw, 2);
  assert.equal(taggedSides({ 'cycleway:right': 'lane' }, false, false).right.side.ca, 1, 'advisory unless said otherwise');
  const k = taggedSides({ 'kerb:left': 'lowered', kerb: 'flush', 'verge:right': 'grass', 'verge:left': '3.5' }, false, false);
  assert.equal(k.left.side.k, KERB.LOWERED);
  assert.equal(k.right.side.k, KERB.FLUSH);
  assert.equal(k.right.side.v, 1.5);
  assert.equal(k.left.side.v, 3.5);
  assert.equal(taggedSides({ 'median:contents': 'grass;trees;hedge' }, true, false).median, MEDIAN.GRASS | MEDIAN.TREES | MEDIAN.HEDGE);
});

test('tags: a way stored against its drawing has its sides swapped', () => {
  const s = taggedSides({ 'parking:left': 'lane', 'sidewalk:right': 'yes', 'sidewalk:left': 'no' }, true, true);
  assert.equal(s.right.side.p, PARK.LANE);
  assert.equal(s.left.side.p, undefined);
  assert.equal(s.left.walk.has, true);
  assert.equal(s.right.walk.has, false);
});

test('widths: lanes, parking and cycle lanes add up to the carriageway, the rest to the pavements', () => {
  const tags: Tags = {
    highway: 'residential',
    'parking:right': 'lane',
    'parking:left': 'street_side',
    'parking:left:orientation': 'perpendicular',
    'cycleway:right': 'lane',
    sidewalk: 'both',
    'sidewalk:left:width': '2.5',
    'verge:left': 'grass',
  };
  const a = roadAttrs(tags, true)!;
  assert.equal(a.lf + a.lb, 2);
  assert.ok(Math.abs(a.w - (2 * a.lw + 2.0 + 5.0 + 1.5)) < 1e-9, `w ${a.w}`);
  assert.equal(sideInner(a.xr), 3.5);
  assert.equal(sideInner(a.xl), 5.0);
  assert.ok(Math.abs(a.swL - (2.5 + 1.5)) < 1e-9, 'pavement and verge beyond the left kerb');
  // a width tag that holds the parking
  const b = roadAttrs({ highway: 'residential', width: '10', 'parking:both': 'lane' }, true)!;
  assert.equal(b.w, 10);
  assert.equal(b.lw, 3);
  // … or one of the lanes alone
  const c = roadAttrs({ highway: 'residential', width: '6', 'parking:both': 'lane' }, true)!;
  assert.equal(c.w, 10);
  // cars on the pavement widen it
  const d = roadAttrs({ highway: 'residential', sidewalk: 'both', 'parking:right': 'on_kerb' }, true)!;
  assert.ok(Math.abs(d.swR - d.swL - 2.0) < 1e-9);
  assert.ok(Math.abs(d.w - 2 * d.lw) < 1e-9, 'not on the carriageway');
  // the layout of a side: from the lanes outwards, ending at the pavement's far edge
  const lay = sideLayout(a.w / 2, a.swR, a.xr);
  assert.ok(Math.abs(lay.laneEdge - (a.w / 2 - 3.5)) < 1e-9);
  assert.deepEqual(lay.cycleLane, [a.w / 2 - 3.5, a.w / 2 - 2]);
  assert.deepEqual(lay.park, [a.w / 2 - 2, a.w / 2]);
  assert.equal(sideOuter(a.xr), 0);
  const left = sideLayout(a.w / 2, a.swL, a.xl);
  assert.deepEqual(left.verge, [a.w / 2, a.w / 2 + 1.5]);
  assert.deepEqual(left.walk, [a.w / 2 + 1.5, a.w / 2 + 4]);
});

// ---------------------------------------------------------------------------
// the network and the cars, built from a little town of OpenStreetMap

interface Town {
  world: World;
  lanes: LaneGraph;
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
  const world = new World(json);
  return { world, lanes: new LaneGraph(world), edgeOf: (way) => g.wayEdges.get(way)![0] };
}

const MAIN: Tags = {
  highway: 'residential',
  name: 'Hauptstraße',
  sidewalk: 'both',
  'parking:right': 'lane',
  'parking:right:markings': 'yes',
  'parking:left': 'street_side',
  'parking:left:orientation': 'diagonal',
  'cycleway:right': 'lane',
};

function mainTown(): Town {
  return town([
    // the main street from west to east, a junction at x = 100, a driveway at x = 40
    { id: 1, nodes: [[1, 0, 0], [2, 40, 0], [3, 100, 0]], tags: MAIN },
    { id: 2, nodes: [[3, 100, 0], [4, 220, 0]], tags: MAIN },
    { id: 3, nodes: [[3, 100, 0], [5, 100, 80]], tags: { highway: 'residential' } },
    { id: 4, nodes: [[3, 100, 0], [6, 100, -80]], tags: { highway: 'residential' } },
    { id: 5, nodes: [[2, 40, 0], [7, 40, 25]], tags: { highway: 'service', service: 'driveway' } },
  ]);
}

test('network: the lanes keep clear of the parking and cycle lanes', () => {
  const t = mainTown();
  const e = t.world.edges[t.edgeOf(2)];
  assert.ok(Math.abs(e.marginR - 3.5) < 1e-9, `right: ${e.marginR}`);
  assert.ok(Math.abs(e.marginL - 5.3) < 1e-9, `left: ${e.marginL}`);
  const el = t.lanes.edgeLanes[e.id];
  const fwd = el.fwd[0];
  const back = el.back[0];
  // (+ = left of a→b; the street runs east, so its right is the south)
  assert.ok(Math.abs(fwd.off - (-e.width / 2 + 3.5 + fwd.width / 2)) < 1e-9);
  assert.ok(Math.abs(back.off - (e.width / 2 - 5.3 - back.width / 2)) < 1e-9);
  assert.ok(fwd.off + fwd.width / 2 <= back.off - back.width / 2 + 1e-9, 'the lanes do not overlap');
  // where parked cars stand, nothing drives
  const right = sideParking(t.world, e, -1)!;
  assert.ok(-fwd.off + fwd.width / 2 <= right.inner + 1e-9);
});

test('cars: inside their bays, on the right side, none at junctions, driveways or crossings', () => {
  const t = mainTown();
  for (const way of [1, 2]) {
    const e = t.world.edges[t.edgeOf(way)];
    for (const side of [1, -1] as const) {
      const p = sideParking(t.world, e, side);
      assert.ok(p, `side ${side} of way ${way} has parking`);
      assert.ok(p.bays.length > 0);
      const cars = carsOf(t.world, e, p);
      assert.ok(cars.length >= p.bays.length * 0.4 && cars.length <= p.bays.length, `${cars.length} of ${p.bays.length}`);
      const slant = p.orient === ORIENT.DIAGONAL ? (p.outer - p.inner) / Math.tan(DIAGONAL_ANGLE) : 0;
      const proj = { s: 0, off: 0, d2: 0, seg: 0 };
      for (const c of cars) {
        const pts = parkedOutline(c);
        for (let i = 0; i < pts.length; i += 2) {
          projectOnPolyline(e.pl, pts[i], pts[i + 1], proj);
          const off = proj.off * side;
          assert.ok(off >= p.inner - 0.05 && off <= p.outer + 0.05, `corner across the road at ${off.toFixed(2)}, strip ${p.inner}–${p.outer}`);
          // within the stretch of bays (a diagonal one reaching on by its slant)
          assert.ok(proj.s >= p.bays[0].s0 - slant - 0.05 && proj.s <= p.bays[p.bays.length - 1].s1 + slant + 0.05, `along at ${proj.s}`);
        }
        projectOnPolyline(e.pl, c.x, c.z, proj);
        // 5 m from the junction (§ 12), clear of the driveway's mouth
        const junctionS = way === 1 ? e.len : 0;
        const cut = way === 1 ? e.cutB : e.cutA;
        assert.ok(Math.abs(proj.s - junctionS) >= cut + 5 - 2.5, `car ${proj.s.toFixed(1)} m along, junction at ${junctionS}`);
        assert.equal(carMisplaced(t.world, e, c), false);
      }
    }
  }
  // the driveway at x = 40 splits the street: nothing stands on its mouth
  const e1 = t.world.edges[t.edgeOf(1)];
  const cars = [1, -1].flatMap((side) => carsOf(t.world, e1, sideParking(t.world, e1, side as 1 | -1)!));
  for (const c of cars) assert.ok(Math.abs(c.x - 40) > 3.5, `a car at x ${c.x.toFixed(1)} by the driveway`);
});

test('cars: parallel ones face the traffic beside them, the same every build', () => {
  const t = mainTown();
  const e = t.world.edges[t.edgeOf(2)];
  const right = carsOf(t.world, e, sideParking(t.world, e, -1)!);
  // the street runs east: forward = (−sin yaw, −cos yaw) = east
  for (const c of right) assert.ok(-Math.sin(c.yaw) > 0.99, `yaw ${c.yaw}`);
  assert.deepEqual(carsOf(t.world, e, sideParking(t.world, e, -1)!), right);
});

test('cars: none before a zebra crossing or around a bus stop', () => {
  const t = mainTown();
  const e = t.world.edges[t.edgeOf(2)];
  const xing = { e: e.id, s: 60, k: 1, w: 4 };
  e.xings.push(xing);
  const p = sideParking(t.world, e, -1, [{ kind: 'bus_stop', s: 100, dir: 1, tags: {}, osm: 1 }])!;
  for (const b of p.bays) {
    assert.ok(b.s1 <= 60 - 2 - 5 + 1e-6 || b.s0 >= 60 + 2 + 5 - 1e-6, `bay ${b.s0}–${b.s1} by the zebra`);
    assert.ok(b.s1 <= 85 + 1e-6 || b.s0 >= 115 - 1e-6, `bay ${b.s0}–${b.s1} at the bus stop`);
  }
});

test('one-way street drawn against its direction: parking on the side the tags mean', () => {
  // oneway=-1, drawn from west to east: driven from east to west; its mapped left (north) is the driver's right
  const t = town([{ id: 1, nodes: [[1, 0, 0], [2, 120, 0]], tags: { highway: 'residential', oneway: '-1', 'parking:left': 'lane' } }]);
  const e = t.world.edges[t.edgeOf(1)];
  assert.ok(e.xr?.p === PARK.LANE && !e.xl?.p);
  const p = sideParking(t.world, e, -1)!;
  for (const c of carsOf(t.world, e, p)) assert.ok(c.z < 0, 'the cars stand to the north');
});

test("separate pavement: the road's pavement reaches to it, a verge between", () => {
  const t = town([
    { id: 1, nodes: [[1, 0, 0], [2, 120, 0]], tags: { highway: 'residential', 'sidewalk:left': 'separate', 'sidewalk:right': 'no' } },
    // the footway 6 m north of the street's middle (its left), 2 m wide
    { id: 2, nodes: [[11, 0, -6], [12, 120, -6]], tags: { highway: 'footway', footway: 'sidewalk', width: '2' } },
  ]);
  const e = t.world.edges[t.edgeOf(1)];
  const half = e.width / 2;
  assert.ok(Math.abs(e.swL - (6 + 1 - half)) < 0.05, `beyond the kerb ${e.swL}`);
  assert.ok(Math.abs((e.xl?.v ?? 0) - (6 - 1 - half)) < 0.05, `verge ${e.xl?.v}`);
  assert.equal(e.swR, 0);
});

test('parked cars: packed into a tile and back', () => {
  const cars = [
    { x: 105.37, y: 182.41, z: -47.02, yaw: 2.5, model: 3, colour: 11 },
    { x: -80, y: 170, z: 60.5, yaw: -3.1, model: 0, colour: 0 },
  ];
  const p = packParked(cars, 100, -50, 175);
  const back = unpackParked(p.parked, p.parkedK, 100, -50, 175);
  assert.equal(back.length, 2);
  back.forEach((c, i) => {
    assert.ok(Math.abs(c.x - cars[i].x) < 0.011 && Math.abs(c.z - cars[i].z) < 0.011 && Math.abs(c.y - cars[i].y) < 0.006);
    assert.ok(Math.abs(c.yaw - cars[i].yaw) < 1e-3);
    assert.equal(c.model, cars[i].model);
    assert.equal(c.colour, cars[i].colour);
  });
});

test('median: what lies between the carriageways, inside the gap', () => {
  // a dual road running east: the eastbound carriageway in the south (z = 9), the westbound one in the north
  const t = town([
    { id: 1, nodes: [[1, 0, 9], [2, 200, 9]], tags: { highway: 'secondary', oneway: 'yes', 'median:contents': 'grass;trees;parking' } },
    { id: 2, nodes: [[3, 200, -9], [4, 0, -9]], tags: { highway: 'secondary', oneway: 'yes' } },
  ]);
  const e = t.world.edges[t.edgeOf(1)];
  assert.equal(e.median, MEDIAN.GRASS | MEDIAN.TREES | MEDIAN.PARKING);
  const cut = lookAcross(t.world, e, 100)!;
  assert.ok(cut, 'the other carriageway is found');
  const other = t.world.edges[t.edgeOf(2)];
  assert.equal(cut.partner, other);
  assert.ok(Math.abs(cut.g0 - e.width / 2) < 1e-6 && Math.abs(cut.g1 - (18 - other.width / 2)) < 1e-6, `gap ${cut.g0}–${cut.g1}`);
  const ts = new TileSet(-250, -250, 250, 250, 250);
  const stats = addMedians(t.world, ts);
  assert.ok(stats.trees > 5 && stats.cars > 5, `${stats.trees} trees, ${stats.cars} cars`);
  const south = 9 - e.width / 2;
  const north = -9 + other.width / 2;
  for (const tile of ts.tiles.values()) {
    for (let i = 0; i < tile.trees.length; i += 5) assert.ok(tile.trees[i + 2] < south && tile.trees[i + 2] > north);
    for (const c of tile.parked) {
      const pts = parkedOutline(c);
      for (let i = 1; i < pts.length; i += 2) assert.ok(pts[i] < south && pts[i] > north, `car corner at z ${pts[i].toFixed(2)}`);
    }
  }
});
