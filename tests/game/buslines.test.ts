// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The lines of the city buses: the file and its index (src/world/buslines.ts),
 * the buses of the traffic that run them – along the line's roads at the
 * junctions, calling at its stops in their order, over to another lane where
 * the line turns, onto the line back at the end – and the build's matching of
 * OpenStreetMap's ways to the roads of the map (tools/build-buslines.ts), on
 * a small town made for the purpose.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { RouteMatcher, StopPlaces, chainRoute, stopEvents } from '../../tools/build-buslines.ts';
import type { OsmWay, RoadNet } from '../../tools/build-buslines.ts';
import { SignalSystem } from '../../src/sim/signals.ts';
import { Traffic, stopPlaceOf } from '../../src/sim/traffic.ts';
import type { BusStopOnLane, PlayerState, TrafficCar } from '../../src/sim/traffic.ts';
import { BusLines, encodeWays, loadBusLines } from '../../src/world/buslines.ts';
import type { Lane } from '../../src/world/lanes.ts';
import { routeGraphOf, wayOf } from '../../src/world/routegraph.ts';
import type { BusLineJson, BusLinesJson, StopsJson } from '../../src/world/types.ts';
import { STOP_FLAG } from '../../src/world/types.ts';
import { makeTown } from './town.ts';
import type { Town } from './town.ts';

const DT = 1 / 30;

/** The way along the street from grid point (i0, j0) to (i1, j1): road * 2 + direction. */
function way(town: Town, i0: number, j0: number, i1: number, j1: number): number {
  const e = town.street(i0, j0, i1, j1);
  return e * 2 + (town.json.edges[e].a === town.node(i0, j0) ? 0 : 1);
}

/** A lane of a way (`idx` 0: the right-most). */
function laneOf(town: Town, w: number, idx = 0): Lane {
  const el = town.lanes.edgeLanes[w >> 1];
  return ((w & 1) === 0 ? el.fwd : el.back)[idx];
}

function lineJson(ref: string, to: string, ways: number[], stops: Array<[number, number, number]>, more: Partial<BusLineJson> = {}): BusLineJson {
  return { ref, name: `Bus ${ref}: … => ${to}`, from: '', to, operator: 'Test', colour: '', kind: 0, osm: 0, w: encodeWays(ways), st: stops.flat(), ...more };
}

// ---------------------------------------------------------------------------------- the file

test('the lines of the file: their ways decoded, the lines by way, the stops by way, the line back', async () => {
  const json: BusLinesJson = {
    v: 1,
    map: 'build-1',
    places: 3,
    lines: [
      lineJson('7', 'Bahnhof', [10, 12, 14, 31], [[0, 0, 20], [2, 2, 5], [1, 1, 40]], { back: 1 }),
      lineJson('7', 'Markt', [30, 13, 11], [], { end: 2 }),
    ],
  };
  assert.deepEqual(json.lines[0].w, [10, 2, 2, 17], 'stored as steps from the way before');
  const bl = new BusLines(json);
  const [a, b] = bl.lines;
  assert.deepEqual([...a.ways], [10, 12, 14, 31]);
  assert.deepEqual(a.stops.map((s) => s.place), [0, 1, 2], 'the stops in the order of their ways');
  assert.equal(a.back, b);
  assert.equal(b.back, null);
  assert.equal(b.end, 2, 'the last way leads round to the line back');
  assert.equal(a.end, 4);
  assert.deepEqual(bl.at(14).map((h) => [h.line.index, h.k]), [[0, 2]]);
  assert.deepEqual(bl.at(30).map((h) => [h.line.index, h.k]), [[1, 0]]);
  assert.ok(bl.has(13) && !bl.has(15) && !bl.has(-1) && !bl.has(1e7));
  assert.deepEqual(bl.stopsOn(a, 1, 2).map((s) => s.place), [1, 2]);
  assert.deepEqual(bl.stopsOn(a, 3, 3), []);
  assert.ok(bl.fits('build-1', 3) && bl.fits('build-1') && !bl.fits('build-2') && !bl.fits('build-1', 4));
  // read through the map loader: only for the build of the map they were made for
  const map = (generated: string, j: unknown) => ({ json: <T>() => Promise.resolve(j as T), world: { meta: { generated } } });
  assert.ok(await loadBusLines(map('build-1', json)));
  assert.equal(await loadBusLines(map('build-2', json)), null, 'another build of the road network: its numbers would lead astray');
  assert.equal(await loadBusLines(map('build-1', null)), null);
  assert.equal(await loadBusLines({ json: () => Promise.reject(new Error('no such file')), world: { meta: { generated: 'build-1' } } }), null);
});

// ---------------------------------------------------------------------------------- the traffic

/**
 * A town of 4 × 3 junctions, 120 m apart.  Line 5 runs east along the middle
 * row, south at the third column, east again along the bottom row – and from
 * its end round the corner north, where the line back begins: west along
 * the middle row.
 */
function busTown(): { town: Town; traffic: Traffic; json: BusLinesJson; player: PlayerState } {
  const town = makeTown({ cols: 4, rows: 3, block: 120 });
  const traffic = new Traffic(town.world, town.lanes, new SignalSystem(town.world.signals));
  traffic.targetCount = 0;
  const A = [way(town, 0, 1, 1, 1), way(town, 1, 1, 2, 1), way(town, 2, 1, 2, 2), way(town, 2, 2, 3, 2)];
  const link = [way(town, 3, 2, 3, 1)];
  const B = [way(town, 3, 1, 2, 1), way(town, 2, 1, 1, 1), way(town, 1, 1, 0, 1)];
  const json: BusLinesJson = {
    v: 1,
    map: '',
    places: 30,
    lines: [
      lineJson('5', 'Ostfriedhof', [...A, ...link], [[10, 1, 60], [11, 3, 70]], { end: A.length, back: 1 }),
      lineJson('5', 'Westbahnhof', B, [[12, 1, 50]]),
    ],
  };
  // (the anchor of the traffic floats high above the middle of the town: nobody brakes for it)
  const player: PlayerState = { x: 180, y: 160, z: 120, yaw: 0, speed: 0, length: 0.5, width: 0.5 };
  return { town, traffic, json, player };
}

/** Let the traffic run with one bus in it: the ways it drives, the stop places it calls at, what it shows, and where it stood at each stop. */
function ride(traffic: Traffic, bus: TrafficCar, player: PlayerState, seconds: number): { ways: number[]; served: number[]; shown: string[]; at: number[]; slid: boolean; lost: boolean } {
  const ways: number[] = [];
  const served: number[] = [];
  const shown: string[] = [];
  const at: number[] = [];
  let slid = false;
  let lost = false;
  let last = bus.bus!.served;
  for (let t = 0; t < seconds; t += DT) {
    traffic.update(DT, player);
    if (!traffic.cars.includes(bus)) break;
    if (bus.lane && wayOf(bus.lane) !== ways[ways.length - 1]) ways.push(wayOf(bus.lane));
    if (bus.bus!.served !== last) {
      last = bus.bus!.served;
      if (last >= 0) {
        served.push(stopPlaceOf(last));
        at.push(bus.s + bus.length / 2);
      }
    }
    const line = bus.bus!.line;
    const text = line ? `${line.ref} ${line.to}` : '–';
    if (text !== shown[shown.length - 1]) shown.push(text);
    if ((bus.slide ?? 0) !== 0) slid = true;
    if (line && line.off > 0) lost = true;
    if (!line && shown.length > 1) break;
  }
  return { ways, served, shown, at, slid, lost };
}

test('a bus on a line follows its roads at the junctions, calls at its stops in order and goes on as the line back at its end', () => {
  const { town, traffic, json, player } = busTown();
  traffic.setBusLines(new BusLines(json));
  const A = new BusLines(json).lines[0];
  // the map's poles: one of a stop the line does not call at, on its first road; the pole of its second stop, 40 m along that road
  const first = laneOf(town, A.ways[0]);
  const fourth = laneOf(town, A.ways[3]);
  traffic.busStops = (lane): readonly BusStopOnLane[] => (lane === first ? [{ s: 50, id: 20 * 64 }] : lane === fourth ? [{ s: 40, id: 11 * 64 + 1 }] : []);
  const bus = traffic.addCar(first, 10, true);
  assert.equal(bus.bus?.line?.ref, '5', 'it takes the line that runs here');
  assert.equal(bus.bus?.line?.to, 'Ostfriedhof');
  const r = ride(traffic, bus, player, 400);
  const B = json.lines[1];
  const expected = [...A.ways, ...new BusLines(json).lines[1].ways];
  assert.deepEqual(r.ways.slice(0, expected.length), expected, 'the line, the way round, the line back');
  assert.equal(B.to, 'Westbahnhof');
  assert.deepEqual(r.served, [10, 11, 12], 'its own stops, in their order – not the other one on its way');
  assert.ok(Math.abs(r.at[1] - 40) < 1.5, `at the pole the map has for its second stop (front at ${r.at[1].toFixed(1)} m)`);
  assert.deepEqual(r.shown, ['5 Ostfriedhof', '5 Westbahnhof', '–'], 'the display: the line, the line back, then (no line on from there) none');
  assert.equal(r.lost, false);
});

test('a bus without a line keeps calling at every pole on its way; where no line runs, a bus gets none', () => {
  const { town, traffic, json, player } = busTown();
  traffic.setBusLines(new BusLines(json));
  const first = laneOf(town, json.lines[0].w[0]);
  traffic.busStops = (lane): readonly BusStopOnLane[] => (lane === first ? [{ s: 50, id: 20 * 64 }] : []);
  const free = traffic.addCar(first, 10, true, null);
  assert.equal(free.bus?.line, null);
  const r = ride(traffic, free, player, 40);
  assert.equal(r.served[0], 20, 'the pole of a stop no line of its own calls at');
  // where no line runs: a bus as before
  const side = laneOf(town, way(town, 0, 0, 0, 1));
  const other = traffic.addCar(side, 10, true);
  assert.equal(other.bus?.line, null, 'no line runs down the first column');
});

test('buses appear with a line where one runs along their lane', () => {
  const { traffic, json, player } = busTown();
  const lines = new BusLines(json);
  traffic.setBusLines(lines);
  traffic.busStops = () => [];
  traffic.busShare = 1;
  traffic.targetCount = 8;
  let checked = 0;
  const seen = new Set<number>();
  for (let t = 0; t < 20; t += DT) {
    traffic.update(DT, player);
    for (const c of traffic.cars) {
      if (seen.has(c.id) || !c.bus || !c.lane) continue;
      seen.add(c.id);
      const here = lines.at(wayOf(c.lane)).filter((h) => h.k < h.line.end);
      assert.equal(c.bus.line !== null, here.length > 0, 'a line where one runs, none elsewhere');
      if (c.bus.line) assert.ok(here.some((h) => h.line.index === c.bus!.line!.index && h.k === c.bus!.line!.k));
      checked++;
    }
  }
  assert.ok(checked > 0, 'buses came');
});

test('where its line turns off and only the other lane leads there, the bus moves over to it in time', () => {
  // the middle row has two lanes each way; the line turns left (north) at the third column – from the left lane only
  const town = makeTown({ cols: 4, rows: 3, block: 120, wide: [[0, 1, 1, 1], [1, 1, 2, 1], [2, 1, 3, 1]] });
  const traffic = new Traffic(town.world, town.lanes, new SignalSystem(town.world.signals));
  traffic.targetCount = 0;
  const ways = [way(town, 0, 1, 1, 1), way(town, 1, 1, 2, 1), way(town, 2, 1, 2, 0), way(town, 2, 0, 3, 0)];
  assert.ok(!laneOf(town, ways[1], 0).out.some((c) => wayOf(c.to) === ways[2]), 'no left turn from the right lane');
  traffic.setBusLines(new BusLines({ v: 1, map: '', places: 0, lines: [lineJson('9', 'Nordpark', ways, [])] }));
  const bus = traffic.addCar(laneOf(town, ways[0], 0), 10, true);
  const player: PlayerState = { x: 180, y: 160, z: 120, yaw: 0, speed: 0, length: 0.5, width: 0.5 };
  const r = ride(traffic, bus, player, 120);
  assert.deepEqual(r.ways.slice(0, ways.length), ways);
  assert.ok(r.slid, 'it moved over (and slid across)');
  assert.equal(r.lost, false, 'it never lost its way');
});

test('where the map forbids the turn of its line, the bus finds the shortest way back onto it and calls at its stops on from there', () => {
  // the line turns right at (2, 1) – which the map forbids – then west along the bottom row
  const town = makeTown({ cols: 4, rows: 3, block: 120, bans: [[1, 1, 2, 1, 2, 2]] });
  const traffic = new Traffic(town.world, town.lanes, new SignalSystem(town.world.signals));
  traffic.targetCount = 0;
  const ways = [way(town, 0, 1, 1, 1), way(town, 1, 1, 2, 1), way(town, 2, 1, 2, 2), way(town, 2, 2, 1, 2), way(town, 1, 2, 0, 2)];
  assert.ok(!laneOf(town, ways[1]).out.some((c) => wayOf(c.to) === ways[2]), 'the turn is not there');
  traffic.setBusLines(new BusLines({ v: 1, map: '', places: 20, lines: [lineJson('3', 'Südring', ways, [[13, 3, 60]])] }));
  const bus = traffic.addCar(laneOf(town, ways[0]), 10, true);
  const player: PlayerState = { x: 180, y: 160, z: 120, yaw: 0, speed: 0, length: 0.5, width: 0.5 };
  const r = ride(traffic, bus, player, 200);
  assert.ok(r.lost, 'it lost its way at the forbidden turn');
  // round the block: on east, south at the last column, west along the bottom row – onto its line again
  assert.deepEqual(r.ways.slice(0, 6), [ways[0], ways[1], way(town, 2, 1, 3, 1), way(town, 3, 1, 3, 2), way(town, 3, 2, 2, 2), ways[3]]);
  assert.deepEqual(r.served, [13], 'its stop after the way round');
  assert.equal(r.shown[0], '3 Südring');
});

// ---------------------------------------------------------------------------------- the build

test('a route of OpenStreetMap as nodes: a ring left at the exit, a way that was not split left where the next one goes on', () => {
  const ways = (list: Array<[number, OsmWay]>) => list.map(([id, way]) => ({ id, way }));
  // into a roundabout drawn [2 3 4 5 6 2] at node 4, out at node 2
  const ring = chainRoute(ways([[1, { refs: [1, 4], oneway: 0 }], [2, { refs: [2, 3, 4, 5, 6, 2], oneway: 1 }], [3, { refs: [2, 7], oneway: 0 }]]));
  assert.deepEqual(ring.map((s) => s.node), [1, 4, 5, 6, 2, 7]);
  assert.deepEqual(ring.map((s) => s.way), [-1, 1, 2, 2, 2, 3]);
  // onto a long way in its middle (node 12), off it at its end 14 – and a first way drawn the other way round
  const mid = chainRoute(ways([[1, { refs: [12, 99], oneway: 0 }], [2, { refs: [10, 11, 12, 13, 14], oneway: 0 }], [3, { refs: [14, 15], oneway: 0 }]]));
  assert.deepEqual(mid.map((s) => s.node), [99, 12, 13, 14, 15]);
  // a way that does not join the one before: a new beginning
  const gap = chainRoute(ways([[1, { refs: [1, 2], oneway: 0 }], [2, { refs: [5, 6], oneway: 0 }]]));
  assert.deepEqual(gap.map((s) => s.way), [-1, 1, -1, 2]);
});

/** The town as net.bin.gz has a map: the turns from its lane network. */
function roadNet(town: Town): RoadNet {
  const g = routeGraphOf(town.lanes);
  const E = town.json.edges.length;
  return {
    nodeX: town.json.nodes.map((n) => n.x),
    nodeZ: town.json.nodes.map((n) => n.z),
    edgeA: town.json.edges.map((e) => e.a),
    edgeB: town.json.edges.map((e) => e.b),
    edgeLen: town.json.edges.map((_, i) => town.world.edges[i].len),
    wayKind: g.kind,
    waySpeed: Array.from(g.len, (l) => (l > 0 ? 50 : 0)),
    first: g.first,
    to: g.to,
    turn: g.turn,
    polyFirst: new Uint32Array(E + 1),
    poly: new Int16Array(0),
  };
}

test('the build finds the roads of a route by the ids of its ways and nodes, mends a missing way, and places its stops along it', () => {
  const town = makeTown({ cols: 4, rows: 3, block: 120 });
  const net = roadNet(town);
  const E = town.json.edges.length;
  // OpenStreetMap: a node for every junction, a way for every street – but one way for the first two streets of the middle row
  const osmNode = (i: number, j: number): number => 1000 + town.node(i, j);
  const edgeOsm = Array.from({ length: E }, (_, e) => 5000 + e);
  const merged = 7000;
  edgeOsm[town.street(0, 1, 1, 1)] = merged;
  edgeOsm[town.street(1, 1, 2, 1)] = merged;
  const nodeOsm = town.json.nodes.map((_, i) => 1000 + i);
  const matcher = new RouteMatcher(net, edgeOsm, nodeOsm);
  const osmWays = new Map<number, OsmWay>([
    // (the first street drawn from south to north, against the way the bus goes)
    [5000 + town.street(0, 0, 0, 1), { refs: [osmNode(0, 1), 90001, osmNode(0, 0)], oneway: 0 }],
    [merged, { refs: [osmNode(0, 1), 90002, osmNode(1, 1), 90003, osmNode(2, 1)], oneway: 0 }],
    [5000 + town.street(1, 1, 1, 2), { refs: [osmNode(1, 1), 90004, osmNode(1, 2)], oneway: 0 }],
    [5000 + town.street(2, 2, 3, 2), { refs: [osmNode(2, 2), 90005, osmNode(3, 2)], oneway: 0 }],
  ]);
  // the relation lacks the way between (1, 2) and (2, 2)
  const members = [5000 + town.street(0, 0, 0, 1), merged, 5000 + town.street(1, 1, 1, 2), 5000 + town.street(2, 2, 3, 2)];
  const steps = chainRoute(members.map((id) => ({ id, way: osmWays.get(id) })));
  const seq = matcher.follow(steps);
  assert.deepEqual(seq, [way(town, 0, 0, 0, 1), way(town, 0, 1, 1, 1), way(town, 1, 1, 1, 2), way(town, 2, 2, 3, 2)], 'the merged way only as far as the street the route turns into');
  const own = new Set(members.flatMap((m) => [...(matcher.roadsOf(m) ?? [])]));
  const res = matcher.mend(seq, own);
  const route = [way(town, 0, 0, 0, 1), way(town, 0, 1, 1, 1), way(town, 1, 1, 1, 2), way(town, 1, 2, 2, 2), way(town, 2, 2, 3, 2)];
  assert.deepEqual(res.ways, route, 'the missing way found by the search');
  assert.equal(res.mended, 1);
  assert.equal(res.gaps, 0);
  for (let i = 1; i < res.ways.length; i++) assert.ok(matcher.joins(res.ways[i - 1], res.ways[i]), 'drivable from end to end');
  // a stop beside the second street, 60 m along it, 5 m to the south
  const at = matcher.locate(res.ways, 0, 60, 125, 40);
  assert.equal(at?.k, 1);
  assert.ok(at && Math.abs(at.m - 60) < 1 && Math.abs(at.d - 5) < 0.5);
  // a road missing from the map altogether (a road for buses only): the search goes round it
  const busway = matcher.mend([way(town, 0, 1, 1, 1), way(town, 2, 1, 3, 1)], new Set());
  assert.deepEqual(busway.ways, [way(town, 0, 1, 1, 1), way(town, 1, 1, 2, 1), way(town, 2, 1, 3, 1)]);
});

test('the stops of a route: stop position and platform as one stop, found among the stop places by name – also by a platform\'s own name', () => {
  const nodes = new Map([
    [1, { x: 0, z: 0, name: 'Weserspitze' }],
    [2, { x: 4, z: 8, name: 'Weserspitze (Steig C)' }],
    [3, { x: 300, z: 0, name: 'Rathaus' }],
  ]);
  const events = stopEvents(
    [
      { type: 'w', ref: 50, role: '' },
      { type: 'n', ref: 1, role: 'stop' },
      { type: 'n', ref: 2, role: 'platform' },
      { type: 'n', ref: 3, role: 'stop_exit_only' },
    ],
    (m) => nodes.get(m.ref),
  );
  assert.equal(events.length, 2);
  assert.ok(events[0].stop && events[0].platform && events[0].x === 4, 'the platform is where the bus stops for its people');
  const json: StopsJson = {
    v: 1,
    towns: ['Kassel'],
    places: [
      ['Weserspitze', 0, STOP_FLAG.BUS, 10, 20],
      ['Rathaus', 0, STOP_FLAG.BUS, 305, 10],
      ['Gartenstraße', 0, STOP_FLAG.BUS, 300, 40],
    ],
    poles: [[0, 5, 12, STOP_FLAG.BUS], [1, 302, 6, STOP_FLAG.BUS], [2, 301, 25, STOP_FLAG.BUS]],
    platforms: [],
  };
  const places = new StopPlaces(json);
  assert.equal(places.find(events[0].name, events[0].x, events[0].z), 0);
  assert.equal(places.find('Weserspitze (Steig C)', 4, 8), 0);
  assert.equal(places.find('Rathaus', 300, 0), 1);
  assert.equal(places.find('', 300, 30), 2, 'without a name: the stop with a pole close by');
  assert.equal(places.find('Bahnhof', 2000, 2000), -1);
});
