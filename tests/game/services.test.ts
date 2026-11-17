// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fuel stations, car washes and the loading of a truck – what can be
 * checked without a browser: how the data build reads OpenStreetMap and
 * the building models (tools/build-services.ts), how a site is laid out
 * and when a vehicle stands at a pump or at the mark of a car wash
 * (world/services.ts), the fill-up, the wash and the roadside help as they
 * go (game/services.ts), the dirt, the load of a truck, the place of the
 * depot, and the script of the loading (render/loading.ts).
 *
 *   node --test tests/game/services.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BuildingGrid, RoadFinder, buildSites, isRoof, joinRings, mergeTwins, metres, modelOf, siteKind, siteNames, stationRoofs, washHall } from '../../tools/build-services.ts';
import type { Lod2Building, OsmServices, OsmSite } from '../../tools/build-services.ts';
import { DEPOT, HELP, NOZZLE_TIME, Refuelling, WASH_STEPS, Washing, bearingSector, boxInside, dirtGrowth, findDepot, planLoad } from '../../src/game/services.ts';
import { FuelTank, tankFor } from '../../src/sim/fuel.ts';
import type { NetData } from '../../src/world/netfile.ts';
import { DEFAULT_FUELS, ServiceIndex, fromRect, fuelsOf, inBay, minRect, onSite, parseServices, planCanopy, priceAt, pumpBeside, rectRing, toRect } from '../../src/world/services.ts';
import type { ServicesJson } from '../../src/world/services.ts';
import { DOCK_GAP, palletSlots, schedule } from '../../src/render/loading.ts';

/** a rectangle as a ring: middle, long side along (ux, uz) */
const box = (cx: number, cz: number, len: number, wid: number, ux = 1, uz = 0): number[] => rectRing({ cx, cz, ux, uz, len, wid });

const building = (ring: number[], h: number, canopy = false): Lod2Building => ({ ring, y0: 200, y1: 200 + h, canopy, area: Math.abs(minRect(ring).len * minRect(ring).wid) });

// ------------------------------------------------------------------ the data build

test('what OpenStreetMap calls a fuel station, a car wash, a roof – and what it sells', () => {
  assert.equal(siteKind({ amenity: 'fuel' }), 'fuel');
  assert.equal(siteKind({ amenity: 'car_wash' }), 'wash');
  assert.equal(siteKind({ amenity: 'fuel', access: 'private' }), null);
  assert.equal(siteKind({ amenity: 'fuel', 'fuel:avgas': 'yes', aeroway: 'fuel' }), null);
  assert.equal(siteKind({ amenity: 'parking' }), null);
  assert.ok(isRoof({ building: 'roof' }) && isRoof({ man_made: 'canopy' }) && !isRoof({ building: 'yes' }));
  assert.deepEqual(fuelsOf({ 'fuel:diesel': 'yes', 'fuel:e10': 'yes', 'fuel:octane_95': 'yes', 'fuel:octane_98': 'yes', 'fuel:lpg': 'no', 'fuel:HGV_diesel': 'yes' }), ['e10', 'e5', 'plus', 'diesel', 'hgv']);
  assert.deepEqual(siteNames({ brand: 'Aral', operator: 'X' }), { name: 'Aral', brand: 'Aral' });
  assert.deepEqual(siteNames({ name: 'Autohof Kassel', operator: 'Shell' }), { name: 'Autohof Kassel', brand: 'Shell' });
  assert.equal(metres('4,5 m'), 4.5);
  assert.equal(metres('x'), null);
});

test('ways are joined into rings; a point inside an area is the same station', () => {
  const pos = new Map<number, [number, number]>([
    [1, [0, 0]],
    [2, [10, 0]],
    [3, [10, 10]],
    [4, [0, 10]],
  ]);
  const rings = joinRings(
    [
      [1, 2, 3],
      [1, 4, 3],
    ],
    (n) => pos.get(n),
  );
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 8);
  const area: OsmSite = { osm: 'w1', kind: 'fuel', tags: { amenity: 'fuel' }, x: 5, z: 5, area: box(5, 5, 30, 20) };
  const point: OsmSite = { osm: 'n2', kind: 'fuel', tags: { amenity: 'fuel', name: 'Aral', 'fuel:diesel': 'yes' }, x: 6, z: 4, area: null };
  const far: OsmSite = { osm: 'n3', kind: 'fuel', tags: { amenity: 'fuel' }, x: 500, z: 4, area: null };
  const out = mergeTwins([area, point, far]);
  assert.equal(out.length, 2);
  assert.equal(out[0].tags.name, 'Aral');
  assert.equal(out[0].tags['fuel:diesel'], 'yes');
});

test('the canopy comes from the building models; a roof of OpenStreetMap takes the model\'s block that stands for it', () => {
  const st: OsmSite = { osm: 'w1', kind: 'fuel', tags: {}, x: 0, z: 0, area: box(0, 0, 50, 40) };
  const canopy = building(box(2, 0, 24, 13), 5.6, true);
  const shop = building(box(-18, 0, 12, 10), 4.2);
  assert.deepEqual(stationRoofs(st, [canopy, shop], []).map((r) => r.src), ['lod2']);
  // no canopy among the models: OpenStreetMap's roof, replaced by the model's block under it
  const block = building(box(2.4, 0.3, 23, 12.5), 5.8);
  const roofs = stationRoofs(st, [block, shop], [{ ring: box(2, 0, 24, 13), height: null }]);
  assert.equal(roofs.length, 1);
  assert.equal(roofs[0].src, 'lod2');
  assert.equal(roofs[0].y1, 205.8);
  assert.equal(modelOf(box(-18, 0, 12, 10), [building(box(-18, 0, 12, 10), 14)]), null, 'a tall building is no canopy');
  // neither: nothing (the build lays one out on free ground)
  assert.equal(stationRoofs(st, [shop], []).length, 0);
  // a car wash in its hall; a point in a big building is no wash hall
  const wash: OsmSite = { osm: 'n5', kind: 'wash', tags: {}, x: 30, z: 0, area: null };
  const hall = washHall(wash, [building(box(30, 0, 12, 5), 4.5)]);
  assert.ok(hall && hall.src === 'lod2' && hall.y0 === 200);
  assert.equal(washHall(wash, [building(box(30, 0, 40, 30), 8)]), null);
});

test('the build: sites in the map, canopies laid out on free ground, the price sign at the road', () => {
  // a road along x at z = 30, the station south of it… (z grows southwards: the road north of the station)
  const net: NetData = {
    nodeX: Float32Array.of(-200, 200),
    nodeZ: Float32Array.of(-30, -30),
    edgeA: Uint32Array.of(0),
    edgeB: Uint32Array.of(1),
    edgeLen: Float32Array.of(400),
    edgeCls: Uint8Array.of(0),
    wayKind: new Uint8Array(2),
    waySpeed: new Uint8Array(2),
    first: new Uint32Array(3),
    to: new Uint32Array(0),
    turn: new Uint8Array(0),
    across: new Uint16Array(0),
    polyFirst: new Uint32Array(2),
    poly: new Int16Array(0),
  };
  const roads = new RoadFinder(net);
  assert.ok(Math.abs((roads.nearest(5, 0, 70)?.d ?? 0) - 30) < 1e-6);
  const osm: OsmServices = {
    sites: [
      { osm: 'w1', kind: 'fuel', tags: { amenity: 'fuel', brand: 'Aral', 'fuel:diesel': 'yes' }, x: 0, z: 0, area: box(0, 0, 40, 30) },
      { osm: 'n2', kind: 'wash', tags: { amenity: 'car_wash', automated: 'yes' }, x: 60, z: 0, area: null },
      { osm: 'n3', kind: 'fuel', tags: { amenity: 'fuel' }, x: 9000, z: 0, area: null },
    ],
    roofs: [],
  };
  const sites = buildSites(osm, new BuildingGrid([building(box(60, 0, 12, 5), 4.5)]), roads, (x) => x < 1000);
  assert.equal(sites.length, 2);
  const fuel = sites.find((s) => s.k === 'fuel')!;
  assert.equal(fuel.brand, 'Aral');
  assert.deepEqual(fuel.fuels, ['diesel']);
  assert.equal(fuel.roofs?.[0].src, 'gen');
  assert.ok(fuel.sign, 'a price sign');
  const [sx, sz] = fuel.sign!;
  assert.ok(sz > -30 && sz < -20, `the sign stands between the road and the station: ${sz}`);
  assert.ok(Math.abs(sx) < 20);
  const wash = sites.find((s) => s.k === 'wash')!;
  assert.equal(wash.auto, 1);
  assert.equal(wash.roofs?.[0].src, 'lod2');
});

// ------------------------------------------------------------------ the layout of a site

test('the smallest rectangle round a turned outline, and its frame', () => {
  const a = 0.6;
  const ring = box(100, 50, 24, 10, Math.cos(a), Math.sin(a));
  const r = minRect(ring);
  assert.ok(Math.abs(r.len - 24) < 1e-6 && Math.abs(r.wid - 10) < 1e-6);
  assert.ok(Math.abs(Math.abs(r.ux * Math.cos(a) + r.uz * Math.sin(a)) - 1) < 1e-6);
  const [x, z] = fromRect(r, 3, -2);
  const [u, v] = toRect(r, x, z);
  assert.ok(Math.abs(u - 3) < 1e-9 && Math.abs(v + 2) < 1e-9);
});

test('under a canopy of 26 × 14 m: four islands, a pump on each, the columns on their ends', () => {
  const plan = planCanopy(box(0, 0, 26, 14), 200, 205.5);
  assert.equal(plan.islands.length, 4);
  assert.equal(plan.pumps.length, 8);
  assert.equal(plan.columns.length, 8);
  for (const isl of plan.islands) assert.ok(Math.abs(isl.ux) > 0.99, 'the islands run along the long side');
  // an L-shaped canopy: no island where there is no roof
  const L = [-13, -7, 13, -7, 13, 0, 0, 0, 0, 7, -13, 7];
  const lp = planCanopy(L, NaN, NaN);
  for (const isl of lp.islands) assert.ok(!(isl.x > 1 && isl.z > 1), `island at ${isl.x}, ${isl.z}`);
});

test('a vehicle stands at a pump: alongside it, within the hose\'s reach, either way round', () => {
  const plan = planCanopy(box(0, 0, 13, 12), NaN, NaN);
  assert.ok(plan.islands.length >= 1);
  const isl = plan.islands[0];
  const px = plan.pumps[0];
  const pz = plan.pumps[1];
  // the car to the island's south (+z), heading east (yaw −π/2): the pump on its left
  const car = { x: px + 0.6, z: pz + 0.65 + 0.9 + 0.5, yaw: -Math.PI / 2, length: 4.3, width: 1.8 };
  assert.ok(Math.abs(isl.uz) < 1e-9);
  const at = pumpBeside(plan, car);
  assert.ok(at, 'beside the pump');
  assert.equal(at.side, -1);
  // heading west: the pump on its right
  assert.equal(pumpBeside(plan, { ...car, yaw: Math.PI / 2 })?.side, 1);
  // across the island, too far, or beyond the pump
  assert.equal(pumpBeside(plan, { ...car, yaw: 0 }), null);
  assert.equal(pumpBeside(plan, { ...car, z: pz + 6 }), null);
  assert.equal(pumpBeside(plan, { ...car, x: px + 6 }), null);
});

test('in a car wash\'s bay: how far to the mark, straight or not', () => {
  const ring = box(0, 0, 12, 5);
  const plan = { ring, rect: minRect(ring), y0: NaN, y1: NaN, hall: true };
  // (heading east, 1.2 m short of the mark in the middle)
  const b = inBay(plan, { x: -1.2, z: 0.1, yaw: -Math.PI / 2, length: 4.3, width: 1.8 });
  assert.ok(b.inside && b.straight);
  assert.ok(Math.abs(b.along + 1.2) < 1e-9);
  // (heading west at the same place: 1.2 m beyond it)
  const back = inBay(plan, { x: -1.2, z: 0, yaw: Math.PI / 2, length: 4.3, width: 1.8 });
  assert.equal(back.dir, -b.dir);
  assert.ok(Math.abs(back.along - 1.2) < 1e-9);
  assert.ok(!inBay(plan, { x: 0, z: 0, yaw: 0.4 - Math.PI / 2, length: 4.3, width: 1.8 }).straight);
  assert.ok(!inBay(plan, { x: 0, z: 5, yaw: -Math.PI / 2, length: 4.3, width: 1.8 }).inside);
});

test('the file: read and laid out, found by place; prices stay put', () => {
  const json: ServicesJson = {
    v: 1,
    map: 'test',
    attribution: [],
    sites: [
      { k: 'fuel', osm: 'w1', name: 'Aral', brand: 'Aral', x: 0, z: 0, area: box(0, 0, 40, 30), roofs: [{ ring: box(0, 0, 26, 14), y0: 200, y1: 205.5, src: 'lod2' }] },
      { k: 'fuel', osm: 'n2', name: 'Bft', brand: 'bft', x: 3000, z: 0, fuels: ['diesel', 'hydrogen'], roofs: [{ ring: box(3000, 0, 14, 12.5), y0: null, y1: null, src: 'gen' }] },
      { k: 'wash', osm: 'n3', name: '', brand: '', x: 50, z: 0, roofs: [{ ring: box(50, 0, 12, 5), y0: 200, y1: 204, src: 'lod2' }] },
      { k: 'fuel', osm: 'n4', name: 'No room', brand: '', x: 100, z: 0 },
    ],
  };
  const sites = parseServices(json);
  assert.equal(sites.length, 4);
  assert.deepEqual(sites[0].sells, DEFAULT_FUELS);
  assert.deepEqual(sites[1].sells, ['diesel']);
  assert.equal(sites[0].canopies.length, 1);
  assert.ok(sites[2].wash);
  assert.throws(() => parseServices({ ...json, v: 2 }));
  const ix = new ServiceIndex(sites);
  const near = ix.near(10, 0, 30).map((s) => s.osm);
  assert.ok(near.includes('w1') && !near.includes('n2'));
  assert.equal(ix.nearest(2900, 0, 'fuel')?.site.osm, 'n2');
  // (a station without pumps is not where one is sent)
  assert.equal(ix.nearest(110, 0, 'fuel')?.site.osm, 'w1');
  assert.ok(onSite(sites[0], 19, 0, 4) && !onSite(sites[0], 40, 0, 4));
  const p = priceAt(sites[0], 'e10');
  assert.equal(p, priceAt(sites[0], 'e10'));
  assert.ok(Math.abs(p - 1.739) <= 0.04 + 1e-9);
});

// ------------------------------------------------------------------ what goes on

test('filling up: the nozzle goes in, the fuel runs until the tank is full, the nozzle goes back', () => {
  const tank = new FuelTank(tankFor('car')!, 0.5);
  const r = new Refuelling('e10', 1.739, tank.spec.flow);
  const still = { standing: true, engineOn: false };
  let t = 0;
  while (r.phase === 'out') {
    r.step(0.1, tank, still);
    t += 0.1;
  }
  assert.ok(Math.abs(t - NOZZLE_TIME) < 0.11);
  assert.equal(r.nozzle, 1);
  while (!r.done && t < 100) {
    r.step(0.1, tank, still);
    t += 0.1;
  }
  assert.ok(r.done);
  assert.equal(r.reason, 'full');
  assert.equal(tank.share, 1);
  assert.ok(Math.abs(r.fill.litres - 25) < 0.05);
  assert.equal(r.fill.cost, Math.round(r.fill.litres * 1.739 * 100) / 100);
});

test('filling up stops at once when the engine is started or the vehicle moves – or when the driver says so', () => {
  const tank = new FuelTank(tankFor('car')!, 0.2);
  const still = { standing: true, engineOn: false };
  const a = new Refuelling('e10', 1.7, 1.6);
  for (let i = 0; i < 40; i++) a.step(0.1, tank, still);
  const litres = a.fill.litres;
  assert.ok(litres > 0);
  a.step(0.1, tank, { standing: true, engineOn: true });
  assert.equal(a.phase, 'back');
  assert.equal(a.reason, 'engine');
  for (let i = 0; i < 20; i++) a.step(0.1, tank, { standing: false, engineOn: true });
  assert.ok(a.done);
  assert.equal(a.fill.litres, litres);
  const b = new Refuelling('e10', 1.7, 1.6);
  b.step(0.5, tank, { standing: false, engineOn: false });
  assert.equal(b.reason, 'moved');
  const c = new Refuelling('e10', 1.7, 1.6);
  for (let i = 0; i < 30; i++) c.step(0.1, tank, still);
  c.stop();
  assert.equal(c.reason, 'stopped');
  assert.equal(c.phase, 'back');
});

test('the wash: foam, brushes, rinsing, drying – the gantry to and fro, the dirt gone; it stops if the car moves', () => {
  const w = new Washing(0.8);
  const still = { standing: true, engineOn: false };
  assert.equal(w.stepId, 'foam');
  assert.equal(w.at, 1);
  const seen = new Set<string>();
  let lo = Infinity;
  let t = 0;
  const total = WASH_STEPS.reduce((s, x) => s + x.time, 0);
  while (!w.done && t < 100) {
    seen.add(w.stepId);
    lo = Math.min(lo, w.at);
    w.update(0.1, still);
    t += 0.1;
  }
  assert.deepEqual([...seen], ['foam', 'brush', 'rinse', 'dry']);
  assert.ok(Math.abs(t - total) < 0.2);
  assert.ok(lo < -0.99, 'the gantry goes all the way along the car');
  assert.equal(w.dirt, 0);
  assert.equal(w.share, 1);
  const x = new Washing(0.5);
  x.update(3, still);
  assert.ok(x.dirt < 0.5 && x.dirt > 0.3);
  x.update(0.1, { standing: false, engineOn: false });
  assert.ok(x.aborted && x.done);
});

test('the dirt grows with the distance – more on a wet road, most off the road', () => {
  const dry = dirtGrowth(10000, 0, 0, 0);
  assert.ok(dry > 0.05 && dry < 0.25, `${dry}`);
  assert.ok(dirtGrowth(10000, 1, 0, 0) > dry * 5);
  assert.ok(dirtGrowth(300, 0, 1, 0) > 0.4);
  assert.equal(dirtGrowth(0, 1, 1, 1), 0);
  assert.ok(HELP.litres > 0 && HELP.time > 0);
});

test('which way a place lies, seen from the driver\'s seat', () => {
  // heading north (yaw 0, forward −z): north is ahead, east to the right, south behind, west to the left
  assert.equal(bearingSector(0, 0, 0, 0, -100), 0);
  assert.equal(bearingSector(0, 0, 0, 100, -100), 1);
  assert.equal(bearingSector(0, 0, 0, 100, 0), 2);
  assert.equal(bearingSector(0, 0, 0, 0, 100), 4);
  assert.equal(bearingSector(0, 0, 0, -100, 0), 6);
  // heading east (yaw −π/2): south is to the right
  assert.equal(bearingSector(0, 0, -Math.PI / 2, 0, 100), 2);
});

// ------------------------------------------------------------------ the truck's load and its depot

test('a truck is loaded with 4 to 6 pallets, within what it may carry, in the front of its box', () => {
  let seed = 7;
  const rand = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 20; k++) {
    const { pallets, payload } = planLoad(3.9, 2.4, 1600, rand);
    assert.ok(pallets.length >= 4 && pallets.length <= 6);
    assert.ok(payload.mass <= 1600 && payload.mass >= 400, `${payload.mass}`);
    assert.equal(payload.mass, pallets.reduce((s, p) => s + p.mass, 0));
    const inside = boxInside(3.9, 2.4);
    assert.ok(payload.z > inside.front && payload.z < inside.rear);
    assert.ok(payload.y > inside.floor);
  }
  const inside = boxInside(4.7, 2.5);
  const slots = palletSlots(inside, 6);
  assert.equal(slots.length, 6);
  for (const [x, z] of slots) assert.ok(Math.abs(x) + 0.4 <= inside.x1 && z - 0.6 >= inside.front && z + 0.6 <= inside.rear);
});

test('the depot: beside the road, the truck facing it, off the road and free; none where there is no room', () => {
  // a road along z, 12 m wide round x = 0; the truck in it heading north
  const road = (x: number): boolean => Math.abs(x) < 6;
  const flat = (): number => 200;
  const free = findDepot(2, 0, 0, 3.75, 4.45, { road, blocked: () => false, ground: flat });
  assert.ok(free, 'a place');
  assert.ok(free.x > 6 + 2 + 3.7, `beside the road on the right: ${free.x}`);
  // facing west, to the road: forward (−sin yaw, −cos yaw) = (−1, 0)
  assert.ok(Math.abs(-Math.sin(free.yaw) + 1) < 1e-6 && Math.abs(Math.cos(free.yaw)) < 1e-6);
  // the right side built up: the left side then
  const left = findDepot(2, 0, 0, 3.75, 4.45, { road, blocked: (x) => x > 0, ground: flat });
  assert.ok(left && left.x < -6);
  // steep ground, or buildings everywhere: none
  assert.equal(findDepot(2, 0, 0, 3.75, 4.45, { road, blocked: () => false, ground: (x) => 200 + Math.abs(x) * 0.3 }), null);
  assert.equal(findDepot(2, 0, 0, 3.75, 4.45, { road, blocked: () => true, ground: flat }), null);
});

test('the script of the loading: every pallet fetched, set down, pushed into its place in turn, in 30 to 60 s', () => {
  // (the depot's search leaves the room the scene needs between the truck and the dock)
  assert.equal(DEPOT.gap, DOCK_GAP);
  const inside = boxInside(4.7, 2.5);
  for (const dock of [true, false]) {
    for (const n of [4, 6]) {
      const slots = palletSlots(inside, n);
      const s = schedule(n, slots, inside.rear + 0.08, inside.floor, dock, inside.rear + 0.08 + DOCK_GAP);
      assert.ok(s.end >= 30 - 1e-9 && s.end <= 60 + 1e-9, `${s.end}`);
      assert.ok(s.closing < s.end);
      let last = 0;
      for (const p of s.pallets) {
        assert.ok(p.pick < p.drop && p.drop < p.take && p.take < p.placed, JSON.stringify(p));
        assert.ok(p.drop >= last, 'one after the other at the door');
        last = p.take;
      }
      for (let i = 1; i < s.forklift.length; i++) assert.ok(s.forklift[i].t >= s.forklift[i - 1].t);
      for (let i = 1; i < s.jack.length; i++) assert.ok(s.jack[i].t >= s.jack[i - 1].t);
      assert.ok(s.pallets[n - 1].placed <= s.closing);
    }
  }
});
