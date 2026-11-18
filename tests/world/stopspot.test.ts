// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where a bus stop's furniture stands (src/render/stopspot.ts).  A player
 * found stops "in the middle of the road": poles mapped on the road's centre
 * line, between the carriageways of a dual road, among cars parked on the
 * pavement.  Here sample stops stand against a handful of streets with the
 * cross-sections of the map (pavements per side, parking strips on the road
 * and on the pavement, verges, cycle tracks, one-way streets, a dual road),
 * and nothing of their furniture – the sign, the shelter, the bench, the
 * board, the people waiting – may stand on a carriageway or a parking strip.
 *
 *   node --test tests/world/stopspot.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectOnPolyline } from '../../src/core/geom.ts';
import type { PolyProjection } from '../../src/core/geom.ts';
import { clearOf, inTheWay, KERB_GAP, stopSpot } from '../../src/render/stopspot.ts';
import { CLS, CTRL, EF, ROLE, STOP_FLAG } from '../../src/world/types.ts';
import type { EdgeJson, NodeJson, WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts } from '../../src/world/world.ts';
import { CYCLE, MEDIAN, ORIENT, PARK } from '../../src/world/xsection.ts';

const Y = 100;

/** Streets running north (a in the south, b in the north; `south`: the other way), each on its own, 200 m long, at x = `at`. */
function streets(list: Array<{ at: number; south?: boolean } & Partial<Omit<EdgeJson, 'x'>>>): World {
  const nodes: NodeJson[] = [];
  const edges: EdgeJson[] = [];
  for (const s of list) {
    const { at: x, south, ...rest } = s;
    const a = nodes.length;
    const z0 = south ? -100 : 100;
    nodes.push({ x, y: Y, z: z0, t: CTRL.NONE, arms: [{ e: edges.length, r: ROLE.NONE }] });
    nodes.push({ x, y: Y, z: -z0, t: CTRL.NONE, arms: [{ e: edges.length, r: ROLE.NONE }] });
    const p: number[] = [];
    for (let k = 0; k <= 10; k++) p.push(x, Y, z0 - (z0 / 5) * k);
    edges.push({ a, b: a + 1, c: CLS.SECONDARY, p, lf: 1, lb: 1, lw: 3.25, w: 6.5, mf: 50, mb: 50, f: EF.URBAN, ca: 0, cb: 0, sl: 2.5, sr: 2.5, ...rest });
  }
  const json: WorldJson = {
    version: 2,
    meta: { name: 't', generated: '', minX: -2000, maxX: 2000, minZ: -500, maxZ: 500, tileSize: 500, originE: 0, originN: 0, attribution: [] },
    nodes,
    edges,
    banned: [],
    signals: [],
    crossings: [],
    places: [],
    spawns: [],
    tiles: [],
  };
  computeAllCuts(json);
  return new World(json);
}

// (a street running north: left of a→b is west, −x; right is east, +x)
const world = streets([
  // 0: two-way, pavements of 2.5 m
  { at: 0 },
  // 100: two-way, a parking lane on the road on the right, cars on the pavement on the left
  { at: 100, w: 8.5, sl: 4.5, xr: { p: PARK.LANE, po: ORIENT.PARALLEL }, xl: { p: PARK.ON_KERB, po: ORIENT.PARALLEL } },
  // 200: one-way north
  { at: 200, lf: 1, lb: 0, w: 4, lw: 3.5 },
  // 300: one-way south
  { at: 300, lf: 0, lb: 1, w: 4, lw: 3.5 },
  // 400 and 412: a dual road, the northbound carriageway in the east, the southbound one in the west (each drawn
  // the way it is driven), grass between – on the left of each
  { at: 412, lf: 2, lb: 0, w: 7, lw: 3.5, f: EF.URBAN | EF.DUAL, md: MEDIAN.GRASS, sl: 0 },
  { at: 400, south: true, lf: 2, lb: 0, w: 7, lw: 3.5, f: EF.URBAN | EF.DUAL, md: MEDIAN.GRASS, sl: 0 },
  // 500: a verge and a cycle track on the right before the pavement, half-on-kerb parking on the left
  { at: 500, sr: 5, xr: { v: 1, c: CYCLE.TRACK, cw: 1.6 }, w: 7.5, sl: 3, xl: { p: PARK.HALF_ON_KERB, po: ORIENT.PARALLEL } },
  // 600: diagonal parking on the road on both sides, a wide road
  { at: 600, w: 17.1, xl: { p: PARK.LANE, po: ORIENT.DIAGONAL }, xr: { p: PARK.LANE, po: ORIENT.DIAGONAL } },
]);

const BUS = STOP_FLAG.BUS;
const proj: PolyProjection = { s: 0, off: 0, d2: 0, seg: 0 };

interface Case {
  what: string;
  x: number;
  flags: number;
  /** the side it must end up on: +x east or −x west; and whether it may stay where it was mapped */
  east: boolean;
  stays?: boolean;
}

const CASES: Case[] = [
  { what: 'on the centre line of a two-way street (a bus_stop node on the way)', x: 0, flags: BUS | STOP_FLAG.ON_ROAD, east: true },
  { what: 'a stop position on the centre line', x: 0.4, flags: BUS, east: true },
  { what: 'on the carriageway near the western kerb', x: -2.6, flags: BUS | STOP_FLAG.SHELTER, east: false },
  { what: 'at the eastern kerb, on the road', x: 3.2, flags: BUS | STOP_FLAG.SHELTER | STOP_FLAG.BENCH, east: true },
  { what: 'on the eastern pavement', x: 4.5, flags: BUS | STOP_FLAG.SHELTER, east: true, stays: true },
  { what: 'on the parking lane of the road', x: 104, flags: BUS | STOP_FLAG.SHELTER, east: true },
  { what: 'among the cars parked on the western pavement', x: 95, flags: BUS | STOP_FLAG.SHELTER, east: false },
  { what: 'on the centre line of a one-way street north', x: 200, flags: BUS | STOP_FLAG.ON_ROAD, east: true },
  { what: 'on the centre line of a one-way street south', x: 300, flags: BUS | STOP_FLAG.ON_ROAD, east: false },
  { what: 'on the grass between the carriageways of a dual road', x: 406.5, flags: BUS | STOP_FLAG.SHELTER, east: true },
  { what: 'at the median kerb of the southbound carriageway', x: 403.4, flags: BUS | STOP_FLAG.SHELTER, east: false },
  { what: 'on the centre line of the southbound carriageway', x: 400, flags: BUS | STOP_FLAG.ON_ROAD, east: false },
  { what: 'at the kerb before a verge and a cycle track', x: 504, flags: BUS | STOP_FLAG.SHELTER, east: true },
  { what: 'among cars parked half on the kerb', x: 496, flags: BUS | STOP_FLAG.BENCH, east: false },
  { what: 'in the diagonal parking on a wide road', x: 607, flags: BUS | STOP_FLAG.SHELTER, east: true },
];

/** the footprint of the furniture as TransitScene lays it out from the spot: sign, shelter, bench, board, bin, people */
const FOOTPRINT: Array<[number, number]> = [];
for (const along of [-2.6, -1.8, -0.9, 0, 0.9, 2.6, 4.4]) for (const back of [0, 0.4, 0.6, 1.2, 1.6, 2.3]) FOOTPRINT.push([along, back]);

for (const c of CASES) {
  test(`a stop ${c.what}: its furniture beside the carriageway`, () => {
    const z = 13;
    const s = stopSpot(world, c.x, z, Y, c.flags);
    assert.ok(s.edge, 'it finds its road');
    if (c.stays) assert.ok(!s.moved && s.x === c.x && s.z === z, 'a pole on the pavement stays where it was mapped');
    // facing the road: forward = (−sin yaw, −cos yaw) points west from the east side, east from the west side
    const fx = -Math.sin(s.yaw);
    const fz = -Math.cos(s.yaw);
    assert.ok(Math.abs(fz) < 1e-6, 'it faces across the road');
    assert.equal(fx < 0, c.east, `it stands on the ${c.east ? 'east' : 'west'} side, facing the road`);
    const ax = Math.cos(s.yaw);
    const az = -Math.sin(s.yaw);
    const e = s.edge!;
    for (const [along, back] of FOOTPRINT) {
      const px = s.x + ax * along - fx * back;
      const pz = s.z + az * along - fz * back;
      assert.ok(!inTheWay(world, px, pz, Y + 2), `(${along}, ${back}) at x ${px.toFixed(2)} stands on the road or among the parked cars`);
      projectOnPolyline(e.pl, px, pz, proj);
      const side = proj.off >= 0 ? 1 : -1;
      assert.ok(Math.abs(proj.off) >= clearOf(e, side) + KERB_GAP - 1e-6, `(${along}, ${back}) is ${Math.abs(proj.off).toFixed(2)} m from the centre line, the way is clear from ${clearOf(e, side).toFixed(2)}`);
      // … and not on the other carriageway of a dual road either
      for (const other of world.edges) {
        projectOnPolyline(other.pl, px, pz, proj);
        assert.ok(Math.abs(proj.off) > other.width / 2, `(${along}, ${back}) stands on the carriageway of the road at x ${other.pl.pts[0]}`);
      }
    }
  });
}

test('the clear line: kerb, parked cars on the pavement, a cycle track with a pavement beyond', () => {
  const [plain, parked, , , , , track] = world.edges;
  assert.equal(clearOf(plain, 1), 3.25);
  assert.equal(clearOf(parked, 1), 4.25 + 2, 'cars on the pavement: behind them');
  assert.equal(clearOf(parked, -1), 4.25, 'a parking lane is part of the carriageway');
  assert.equal(clearOf(track, -1), 3.75 + 1 + 1.6, 'behind verge and cycle track');
  assert.equal(clearOf(track, 1), 3.75 + 1, 'half on the kerb: behind the cars');
});

test('a pole far from any road keeps its place', () => {
  const s = stopSpot(world, 50, 0, Y, BUS);
  assert.equal(s.edge, null);
  assert.equal(s.moved, false);
});
