// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Roadworks and demonstrations (src/sim/roadevents.ts): which roads have a
 * work zone on a day and where on them; the temporary light and the signs
 * 208/308 that let both directions through a narrowing in turns; a lane
 * that ends; what the rule monitor makes of the player there – and the
 * marches: when they are, which way they walk, what is closed for them,
 * and that the traffic and the planned ways keep out.
 *
 *   node --test tests/sim/roadevents.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { angleOf, projectOnPolyline } from '../../src/core/geom.ts';
import { AutoDriver } from '../../src/sim/autodriver.ts';
import { WorldGround } from '../../src/sim/ground.ts';
import { COMPACT_CAR_AUTOMATIC, Vehicle } from '../../src/sim/vehicle/index.ts';
import { RoadEvents, crowdShape, demoRoute, demosOn, entryOf, exitOf, lightAt, makeZone, marchAt, waitOf, worksOn, worksSite } from '../../src/sim/roadevents.ts';
import type { Demonstration, WorkZone, ZoneSpec } from '../../src/sim/roadevents.ts';
import { RuleMonitor } from '../../src/sim/rules.ts';
import type { PlayerSnapshot } from '../../src/sim/rules.ts';
import { RailNetwork } from '../../src/sim/rail.ts';
import type { RailObstacle } from '../../src/sim/rail.ts';
import { SIG, SignalSystem } from '../../src/sim/signals.ts';
import { berlinClock } from '../../src/sim/timetable.ts';
import { Traffic } from '../../src/sim/traffic.ts';
import type { PlayerState, TrafficCar } from '../../src/sim/traffic.ts';
import { LaneGraph } from '../../src/world/lanes.ts';
import type { Lane } from '../../src/world/lanes.ts';
import { quickest, routeFor, routeGraphOf, wayOf } from '../../src/world/routegraph.ts';
import { CLS, CTRL, EF, RAIL, ROLE, XING } from '../../src/world/types.ts';
import type { CrossingJson, EdgeJson, NodeJson, WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts } from '../../src/world/world.ts';
import type { Edge } from '../../src/world/world.ts';
import { makeTown } from '../game/town.ts';

const DT = 1 / 20;
/** a Wednesday morning, and a Saturday at noon (ms since 1970) */
const WEDNESDAY = Date.UTC(2026, 10, 18, 9);
const SATURDAY = Date.UTC(2026, 10, 21, 11);

interface Road {
  a: number;
  b: number;
  cls?: number;
  lf?: number;
  lb?: number;
  lw?: number;
  urban?: boolean;
  max?: number;
  flags?: number;
  name?: string;
}

interface Net {
  json: WorldJson;
  world: World;
  lanes: LaneGraph;
}

/** Straight roads between junctions at these points (y = 100), built as the map build hands them to the game. */
function makeNet(points: Array<[number, number]>, roads: Road[], crossings: CrossingJson[] = []): Net {
  const nodes: NodeJson[] = points.map(([x, z]) => ({ x, y: 100, z, t: CTRL.NONE, arms: [] }));
  const edges: EdgeJson[] = roads.map((r, i) => {
    const A = nodes[r.a];
    const B = nodes[r.b];
    const p: number[] = [];
    const n = Math.max(1, Math.round(Math.hypot(B.x - A.x, B.z - A.z) / 20));
    for (let k = 0; k <= n; k++) p.push(A.x + ((B.x - A.x) * k) / n, 100, A.z + ((B.z - A.z) * k) / n);
    const lf = r.lf ?? 1;
    const lb = r.lb ?? 1;
    const lw = r.lw ?? 3;
    return { a: r.a, b: r.b, c: r.cls ?? CLS.RESIDENTIAL, n: r.name ?? `Road ${i}`, p, lf, lb, lw, w: (lf + lb) * lw, mf: r.max ?? 50, mb: r.max ?? 50, f: (r.urban === false ? 0 : EF.URBAN) | (r.flags ?? 0), ca: 0, cb: 0 };
  });
  nodes.forEach((node, ni) => {
    const arms: Array<{ e: number; ang: number }> = [];
    edges.forEach((e, ei) => {
      if (e.a !== ni && e.b !== ni) return;
      const other = nodes[e.a === ni ? e.b : e.a];
      arms.push({ e: ei, ang: angleOf(other.x - node.x, other.z - node.z) });
    });
    arms.sort((p, q) => p.ang - q.ang);
    node.arms = arms.map((a) => ({ e: a.e, r: arms.length > 2 ? ROLE.RBL : ROLE.NONE }));
    node.t = arms.length > 2 ? CTRL.RBL : CTRL.NONE;
  });
  const json: WorldJson = {
    version: 1,
    meta: { name: 'Test roads', generated: '', minX: -3000, maxX: 14000, minZ: -3000, maxZ: 14000, tileSize: 500, originE: 0, originN: 0, attribution: [] },
    nodes,
    edges,
    banned: [],
    signals: [],
    crossings,
    places: [],
    spawns: [],
    tiles: [],
  };
  computeAllCuts(json);
  const world = new World(json);
  return { json, world, lanes: new LaneGraph(world) };
}

/** Four roads round a block of 600 × 150 m: the traffic goes round and round, both ways.  The first road (z = 0, x 0 → 600) is the one with the work. */
function loop(road: Omit<Road, 'a' | 'b'> = {}): Net {
  return makeNet(
    [
      [0, 0],
      [600, 0],
      [600, 150],
      [0, 150],
    ],
    [
      { a: 0, b: 1, ...road },
      { a: 1, b: 2, ...road },
      { a: 2, b: 3, ...road },
      { a: 3, b: 0, ...road },
    ],
  );
}

/** The traffic of a network with road events of the day (a weekday morning: no march) – and the zone to test in place of the day's own. */
function setUp(net: Net, zone: ZoneSpec | null, now = WEDNESDAY): { traffic: Traffic; signals: SignalSystem; ev: RoadEvents; player: PlayerState; zone: WorkZone | null } {
  const signals = new SignalSystem(net.world.signals);
  const traffic = new Traffic(net.world, net.lanes, signals);
  traffic.targetCount = 0;
  traffic.spawnRadius = 5000;
  const ev = new RoadEvents(net.world, net.lanes, signals);
  ev.now = () => now;
  traffic.roadEvents = ev;
  // (the player stands off the roads, watching)
  const player: PlayerState = { x: 300, y: 100, z: 420, yaw: 0, speed: 0, length: 4.3, width: 1.8 };
  ev.step(0, [], player);
  ev.zones.clear();
  ev.demos = [];
  let z: WorkZone | null = null;
  if (zone) {
    const e = net.world.edges[0];
    z = makeZone(e, net.lanes, zone);
    ev.zones.set(e.id, z);
  }
  return { traffic, signals, ev, player, zone: z };
}

/** Cars on every lane of the roads but the first (they come round to it). */
function fill(net: Net, traffic: Traffic, every = 50): void {
  for (const e of net.world.allEdges) {
    if (e.id === 0) continue;
    const el = net.lanes.edgeLanes[e.id];
    for (const lane of [...el.fwd, ...el.back]) for (let s = 15; s < lane.len - 8; s += every) traffic.addCar(lane, s);
  }
}

/** A lane's distance of a station. */
const along = (lane: Lane, s: number): number => (s - lane.s0) * lane.dir;

/** Across the road: how far left of a → b the car is drawn, and its station. */
function where(e: Edge, car: TrafficCar): { s: number; off: number } {
  const proj = { s: 0, off: 0, d2: 0, seg: 0 };
  projectOnPolyline(e.pl, car.x, car.z, proj);
  return { s: proj.s, off: proj.off };
}

// ------------------------------------------------------------------------------------ the choice

test('roadworks: each road decides by the day – the same zones all day, others on other days, more on the main roads outside towns', () => {
  // a town of streets, and the country roads between villages
  const town = makeTown({ cols: 10, rows: 10, block: 180 });
  const country: Array<[number, number]> = [];
  const roads: Road[] = [];
  for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) country.push([i * 1000, j * 1000]);
  for (let j = 0; j < 6; j++) {
    for (let i = 0; i < 6; i++) {
      if (i < 5) roads.push({ a: j * 6 + i, b: j * 6 + i + 1, cls: CLS.SECONDARY, urban: false, max: 100 });
      if (j < 5) roads.push({ a: j * 6 + i, b: (j + 1) * 6 + i, cls: CLS.SECONDARY, urban: false, max: 100 });
    }
  }
  const land = makeNet(country, roads);
  const day = 2026 * 372 + 10 * 31 + 18;
  const zonesOf = (net: { world: World; lanes: LaneGraph }, d: number): WorkZone[] => [...net.world.allEdges].map((e) => worksOn(e, d, net.lanes)).filter((z): z is WorkZone => z !== null);
  // the same day: the very same zones
  const a = zonesOf(land, day);
  const b = zonesOf(land, day);
  assert.deepEqual(
    a.map((z) => [z.id, z.z0, z.z1, z.side, z.control]),
    b.map((z) => [z.id, z.z0, z.z1, z.side, z.control]),
  );
  // over a month: a few each day, other ones each day, more per kilometre outside on the main roads than on the streets in town
  let landCount = 0;
  let townCount = 0;
  let again = 0;
  let prev = new Set<number>();
  const landKm = [...land.world.allEdges].reduce((s, e) => s + (e.len - e.cutA - e.cutB) / 1000, 0);
  const townKm = [...town.world.allEdges].reduce((s, e) => s + (e.len - e.cutA - e.cutB) / 1000, 0);
  for (let d = day; d < day + 30; d++) {
    const zl = zonesOf(land, d);
    landCount += zl.length;
    townCount += zonesOf(town, d).length;
    for (const z of zl) if (prev.has(z.id)) again++;
    prev = new Set(zl.map((z) => z.id));
  }
  const landRate = landCount / 30 / landKm;
  const townRate = townCount / 30 / townKm;
  assert.ok(landCount / 30 > 5, `several zones a day on 60 km of country roads (${(landCount / 30).toFixed(1)})`);
  assert.ok(townCount > 3, `now and then one in the streets of a small town (${townCount} in 30 days)`);
  assert.ok(landRate > townRate * 2, `outside on the main roads more often (${landRate.toFixed(3)} against ${townRate.toFixed(3)} per km)`);
  // (each day by itself: a road has a zone again the next day no more often than any road has one at all)
  assert.ok(again < landCount * 0.6, `other roads the next day (${again} of ${landCount} again)`);
});

test('roadworks: where they are – between the junctions with room for the signs, never on a motorway, a roundabout or over a crossing; the kind fits the lanes', () => {
  const pts: Array<[number, number]> = [];
  const roads: Road[] = [];
  const add = (r: Omit<Road, 'a' | 'b'>, len: number, row: number, crossing = false): void => {
    const a = pts.length;
    pts.push([0, row * 300], [len, row * 300]);
    roads.push({ a, b: a + 1, ...r });
    if (crossing) xings.push({ e: roads.length - 1, s: len / 2, k: XING.ZEBRA, w: 4 });
  };
  const xings: CrossingJson[] = [];
  add({ cls: CLS.RESIDENTIAL }, 1000, 0);
  add({ cls: CLS.SECONDARY, urban: false, max: 100 }, 1500, 1);
  add({ cls: CLS.PRIMARY, lf: 2, lb: 2, lw: 3.25 }, 600, 2);
  add({ cls: CLS.TRUNK, lf: 2, lb: 0, lw: 3.5, urban: false, max: 0 }, 1500, 3);
  add({ cls: CLS.MOTORWAY, lf: 2, lb: 0, lw: 3.75, urban: false, max: 0 }, 2000, 4);
  add({ cls: CLS.SECONDARY, urban: false, max: 100, flags: EF.ROUNDABOUT }, 800, 5);
  add({ cls: CLS.RESIDENTIAL, lf: 1, lb: 0, lw: 3.5 }, 400, 6);
  add({ cls: CLS.SERVICE }, 400, 7);
  add({ cls: CLS.RESIDENTIAL }, 400, 8, true);
  const net = makeNet(pts, roads, xings);
  const seen = new Map<number, Set<string>>();
  const day0 = 2026 * 372 + 10 * 31 + 1;
  for (let d = day0; d < day0 + 600; d++) {
    for (const e of net.world.allEdges) {
      const z = worksOn(e, d, net.lanes);
      if (!z) continue;
      const kinds = seen.get(e.id) ?? new Set<string>();
      kinds.add(z.control);
      seen.set(e.id, kinds);
      const urban = (e.flags & EF.URBAN) !== 0;
      const approach = urban ? 30 : 110;
      // room before and after for the signs and to stop
      assert.ok(z.z0 - z.taper >= e.cutA + approach - 1e-6 && z.z1 + z.taper <= e.len - e.cutB - approach + 1e-6, `room round the zone on road ${e.id}`);
      assert.ok(z.z1 - z.z0 >= 14);
      // the line to wait at lies on the road, before the zone, for both directions
      for (const dir of [1, -1]) {
        const w = waitOf(z, dir);
        assert.ok(w > e.cutA && w < e.len - e.cutB);
        assert.ok((entryOf(z, dir) - w) * dir > 0 && (exitOf(z, dir) - entryOf(z, dir)) * dir > 0);
      }
      // the limit: below the road's own, 30 in town
      if (z.limit > 0) assert.ok(z.limit < Math.max(e.maxF, e.maxB) || Math.max(e.maxF, e.maxB) === 0);
      if (urban) assert.equal(z.limit, 30);
      assert.ok(z.warn >= (urban ? 30 : 120) && z.warn <= (urban ? 55 : 200));
      // clear of the zebra crossing (at 200 m of road 8)
      if (e.id === 8) assert.ok(z.z1 + z.taper + 10 < 198 || z.z0 - z.taper - 10 > 202, `zone ${z.z0.toFixed(0)}–${z.z1.toFixed(0)} over the crossing`);
    }
  }
  assert.ok(worksSite(net.world.edges[0]) && !worksSite(net.world.edges[4]) && !worksSite(net.world.edges[5]) && !worksSite(net.world.edges[7]));
  assert.equal(seen.has(4), false, 'never on the motorway');
  assert.equal(seen.has(5), false, 'never in a roundabout');
  assert.equal(seen.has(6), false, 'not where a one-way street has but one lane');
  assert.equal(seen.has(7), false, 'not on a service road');
  // one lane each way: in turns (a light, or signs on a short one in town); more lanes: one of them closed
  for (const id of [0, 1]) for (const k of seen.get(id) ?? []) assert.ok(k === 'light' || k === 'signs', `road ${id}: ${k}`);
  for (const id of [2, 3]) for (const k of seen.get(id) ?? []) assert.equal(k, 'lane', `road ${id}`);
  assert.ok(seen.get(0)?.has('signs'), 'a short one in a side street goes by the signs 208/308');
  assert.ok(seen.get(1)?.has('light') && !seen.get(1)?.has('signs'), 'outside towns: the temporary light');
  assert.ok(seen.has(2) && seen.has(3));
});

test('the temporary light: the two directions never have green or amber at once, the all-red lasts until the stretch is clear, red-amber before green', () => {
  const net = loop();
  const z = makeZone(net.world.edges[0], net.lanes, { side: 1, control: 'light', lane: 0, z0: 250, z1: 330, taper: 10, limit: 30, warn: 40, green: [15, 18], phase: 0.3, seed: 1 });
  const cycle = z.green[0] + z.green[1] + 2 * (3 + z.clear + 1);
  assert.ok(z.clear >= (80 + 20) / 8, `time to clear 100 m at a walking pace of a car (${z.clear} s)`);
  let greens = [0, 0];
  let lastGo = [-Infinity, -Infinity];
  let lastState = [-1, -1];
  for (let t = 0; t < cycle * 3; t += 0.1) {
    const s0 = lightAt(z, 0, t);
    const s1 = lightAt(z, 1, t);
    const go = (s: number): boolean => s === SIG.GREEN || s === SIG.AMBER;
    assert.ok(!(go(s0.state) || s0.state === SIG.RED_AMBER) || !(go(s1.state) || s1.state === SIG.RED_AMBER), `t ${t.toFixed(1)}: one at a time`);
    for (const [g, s] of [s0, s1].entries()) {
      if (s.state === SIG.GREEN) greens[g] += 0.1;
      // green comes only after red-amber, and the other side's last moment of amber lies at least the clearing time back
      if (s.state === SIG.GREEN && lastState[g] !== SIG.GREEN && lastState[g] >= 0) {
        assert.equal(lastState[g], SIG.RED_AMBER);
        assert.ok(t - lastGo[1 - g] >= z.clear - 0.25, `cleared before green (${(t - lastGo[1 - g]).toFixed(1)} s)`);
      }
      if (go(s.state)) lastGo[g] = t;
      lastState[g] = s.state;
      assert.ok(s.age >= 0 && s.age <= Math.max(...z.green) + 2 * (3 + z.clear + 1));
    }
  }
  assert.ok(Math.abs(greens[0] - 3 * z.green[0]) < 0.6 && Math.abs(greens[1] - 3 * z.green[1]) < 0.6);
  greens = [0, 0];
  void greens;
});

test('no work zone where a tram runs along the road: the zones there go once the tracks are known, and none comes there again', () => {
  const net = loop();
  const { ev } = setUp(net, null);
  const along0 = (z: number): number[] => {
    const p: number[] = [];
    for (let x = 0; x <= 600; x += 5) p.push(x, 100, z);
    return p;
  };
  for (const e of net.world.allEdges) ev.zones.set(e.id, makeZone(e, net.lanes, { side: 1, control: 'light', lane: 0, z0: 40, z1: 70, taper: 10, limit: 30, warn: 30, green: [15, 15], phase: 0, seed: e.id }));
  // a track in the middle of the first road, another one well beside the third (z = 150 + 20)
  ev.setTracks(new RailNetwork([{ k: RAIL.TRAM, p: along0(0.8), a: [], b: [] }, { k: RAIL.TRAM, p: along0(170), a: [], b: [] }]));
  assert.equal(ev.zones.has(0), false, 'over the track: gone');
  assert.equal(ev.zones.has(2), true, 'twenty metres beside it: stays');
  ev.zones.clear();
  ev.addRoads(net.world.allEdges);
  for (const z of ev.zones.values()) assert.notEqual(z.id, 0);
});

test('a vehicle put down inside a fenced strip (a start, a jump on the map): that work is done for today – it is not boxed in', () => {
  const net = loop();
  const { ev, player } = setUp(net, { side: 1, control: 'light', lane: 0, z0: 250, z1: 330, taper: 10, limit: 30, warn: 40, green: [15, 15], phase: 0, seed: 1 });
  // driven up to it: it stays
  ev.step(1, [], { ...player, x: 100, z: 1.5 });
  ev.step(1, [], { ...player, x: 130, z: 1.5 });
  assert.ok(ev.zones.has(0));
  // put down in the strip (the lane a → b is 1.5 m right of the middle: z = 1.5)
  ev.step(1, [], { ...player, x: 290, z: 1.5 });
  assert.equal(ev.zones.has(0), false);
});

// ------------------------------------------------------------------------------------ the traffic at a zone

/** Runs the traffic of a loop round a zone; checks each step; returns how many went through each way. */
function through(net: Net, spec: ZoneSpec, seconds: number, each: (z: WorkZone, traffic: Traffic, signals: SignalSystem) => void, every = 50): { passed: [number, number]; traffic: Traffic } {
  const { traffic, signals, player, zone } = setUp(net, spec);
  const z = zone as WorkZone;
  const e = net.world.edges[0];
  fill(net, traffic, every);
  const passed: [number, number] = [0, 0];
  const last = new Map<number, { lane: Lane; front: number }>();
  for (let t = 0; t < seconds; t += DT) {
    signals.update(DT);
    traffic.update(DT, player);
    for (const car of traffic.cars) {
      const lane = car.lane;
      if (!lane || lane.edge !== e) continue;
      const front = car.s + car.length / 2;
      const out = along(lane, exitOf(z, lane.dir));
      const prev = last.get(car.id);
      if (prev && prev.lane === lane && prev.front < out && front >= out) passed[lane.dir > 0 ? 0 : 1]++;
      last.set(car.id, { lane, front });
    }
    each(z, traffic, signals);
  }
  return { passed, traffic };
}

test('one side closed, a temporary light: both directions through in turns – never meeting in the narrowing, nobody over the line on red, the side of the work over on the other lane', () => {
  const net = loop();
  const e = net.world.edges[0];
  const last = new Map<number, number>();
  let shifted = 0;
  const { passed, traffic } = through(net, { side: 1, control: 'light', lane: 0, z0: 250, z1: 330, taper: 10, limit: 30, warn: 40, green: [15, 15], phase: 0, seed: 1 }, 420, (z, tr, signals) => {
    const inside = [0, 0];
    for (const car of tr.cars) {
      const lane = car.lane;
      if (!lane || lane.edge !== e) continue;
      const k = lane.dir > 0 ? 0 : 1;
      const front = car.s + car.length / 2;
      const wait = along(lane, waitOf(z, lane.dir));
      const out = along(lane, exitOf(z, lane.dir));
      if (front > wait + 0.3 && car.s - car.length / 2 < out) inside[k]++;
      // over the line: only on green (or on amber, too close to stop)
      const prev = last.get(car.id * 2 + k);
      if (prev !== undefined && prev <= wait && front > wait) {
        const st = lightAt(z, lane.dir === z.side ? 0 : 1, signals.time).state;
        assert.ok(st === SIG.GREEN || st === SIG.AMBER, `car ${car.id} over the line on ${st}`);
      }
      last.set(car.id * 2 + k, front);
      // the fenced strip: nobody drawn in it; the side of the work passes on the other lane
      const at = where(e, car);
      if (at.s > z.z0 + 0.5 && at.s < z.z1 - 0.5) {
        assert.ok(at.off > z.line + 0.5, `car ${car.id} in the strip (${at.off.toFixed(2)})`);
        if (lane.dir === z.side && at.s > z.z0 + 8 && at.s < z.z1 - 8) {
          assert.ok(Math.abs(at.off - 1.5) < 0.3, `over on the oncoming lane (${at.off.toFixed(2)})`);
          shifted++;
        }
      }
    }
    assert.ok(inside[0] === 0 || inside[1] === 0, `both directions in the narrowing (${inside[0]}, ${inside[1]})`);
  });
  assert.ok(passed[0] >= 5 && passed[1] >= 5, `through each way (${passed[0]}, ${passed[1]})`);
  assert.ok(shifted > 50);
  assert.ok(traffic.cars.length >= 14, `nobody given up on (${traffic.cars.length} cars left)`);
});

test('one side closed, signs 208 and 308: the oncoming traffic goes first, the narrowing is never shared, both get through', () => {
  const net = loop();
  const e = net.world.edges[0];
  const { passed, traffic } = through(
    net,
    { side: -1, control: 'signs', lane: 0, z0: 280, z1: 310, taper: 10, limit: 30, warn: 40, green: [15, 15], phase: 0, seed: 2 },
    360,
    (z, tr) => {
      const inside = [0, 0];
      for (const car of tr.cars) {
        const lane = car.lane;
        if (!lane || lane.edge !== e) continue;
        const front = car.s + car.length / 2;
        if (front > along(lane, waitOf(z, lane.dir)) + 0.3 && car.s - car.length / 2 < along(lane, exitOf(z, lane.dir))) inside[lane.dir > 0 ? 0 : 1]++;
        const at = where(e, car);
        // (the side of the work is b → a here: the strip lies left of a → b, the cars pass right of its beacons)
        if (at.s > z.z0 + 0.5 && at.s < z.z1 - 0.5) assert.ok(at.off < z.line - 0.5, `car ${car.id} in the strip (${at.off.toFixed(2)})`);
      }
      assert.ok(inside[0] === 0 || inside[1] === 0, `both directions in the narrowing (${inside[0]}, ${inside[1]})`);
    },
    60,
  );
  assert.ok(passed[0] >= 5 && passed[1] >= 5, `through each way (${passed[0]}, ${passed[1]})`);
  assert.ok(traffic.cars.length >= 10);
});

test('a lane closed on a road of two lanes each way: the cars move over in good time, one after the other – nobody drives into the strip', () => {
  const net = loop({ lf: 2, lb: 2, lw: 3.25, cls: CLS.PRIMARY });
  const e = net.world.edges[0];
  let waited = 0;
  const { passed, traffic } = through(net, { side: 1, control: 'lane', lane: 0, z0: 280, z1: 400, taper: 18, limit: 30, warn: 40, green: [15, 15], phase: 0, seed: 3 }, 300, (z, tr) => {
    for (const car of tr.cars) {
      const lane = car.lane;
      if (!lane || lane.edge !== e) continue;
      if (lane.dir === z.side && lane.idx === z.lane) {
        const front = car.s + car.length / 2;
        assert.ok(front < along(lane, entryOf(z, z.side)) + 0.5 || car.s - car.length / 2 > along(lane, z.z1), `car ${car.id} on the closed lane at ${front.toFixed(1)}`);
        if (car.v < 0.1) waited++;
      }
      const at = where(e, car);
      if (at.s > z.z0 + 0.5 && at.s < z.z1 - 0.5) assert.ok(at.off > z.line + 0.3, `car ${car.id} in the strip`);
    }
  }, 35);
  assert.ok(passed[0] >= 8, `through on the open lane (${passed[0]})`);
  assert.ok(passed[1] >= 8, `the other way untouched (${passed[1]})`);
  assert.ok(traffic.cars.length >= 12, `(${traffic.cars.length} cars left)`);
  void waited;
});

// ------------------------------------------------------------------------------------ the player

/**
 * A player's car driven along the first road of the loop, a → b (along x), its middle `off(s)` metres
 * left of the road's middle line at station s, at `v`; `each` looks at every step.
 */
function drive(ev: RoadEvents, signals: SignalSystem, rules: RuleMonitor, from: number, to: number, v: number, off: (s: number) => number, each: (s: number) => void = () => {}): void {
  for (let s = from; s < to; s += v * DT) {
    // (left of a → b, the direction +x, is −z)
    const z = -off(s);
    const p: PlayerSnapshot = { x: s, y: 100, z, yaw: -Math.PI / 2, speed: v, indicator: 0, hazard: false, lookYaw: 0, seatbelt: true, handbrake: 0, stalled: false, hitScenery: 0, length: 4.3 };
    signals.update(DT);
    const lane = rules.laneNow;
    ev.step(DT, [], { x: s, y: 100, z, yaw: p.yaw, speed: v, length: 4.3, width: 1.8, lane, s: lane ? rules.laneFront - 2.15 : 0 });
    rules.update(DT, p, []);
    each(s);
  }
}

test('the player at a zone: the limit from its sign on, a fault on red at the site light and in the closed lane – none passing it right on the other lane on green', () => {
  const spec: ZoneSpec = { side: 1, control: 'light', lane: 0, z0: 250, z1: 330, taper: 10, limit: 30, warn: 40, green: [15, 15], phase: 0, seed: 1 };
  // straight through on red, in its own lane, at 50
  {
    const net = loop();
    const { traffic, signals, ev, zone } = setUp(net, spec);
    const z = zone as WorkZone;
    const rules = new RuleMonitor(net.world, net.lanes, signals, traffic);
    // (the light of the side of the work turns red 6 s after the start: the car is at its line some 12 s on)
    let t = 0;
    while (!(lightAt(z, 0, t).state === SIG.RED && lightAt(z, 0, t).age < 0.2)) t += 0.1;
    signals.time = t - 6;
    const limits = new Map<number, number>();
    drive(ev, signals, rules, 60, 420, 14, () => -1.5, (s) => {
      if (rules.context.limit >= 0) limits.set(Math.round(s), rules.context.limit);
    });
    const ids = rules.log.map((v) => v.id);
    assert.ok(ids.includes('redLight'), `red at the site light (${ids.join(', ')})`);
    assert.equal(rules.log.find((v) => v.id === 'redLight')?.severity, 'fail');
    assert.ok(ids.includes('worksLane'), 'into the fenced strip');
    assert.ok(ids.includes('speed'), '50 where 30 is the limit');
    // the limit: 30 from its sign (with sign 123, 40 m before the stretch) to just behind the zone, 50 before and after
    for (const [s, lim] of limits) {
      const inZone = s > entryOf(z, 1) - z.warn + 3 && s < exitOf(z, 1) + 6;
      const outside = s < entryOf(z, 1) - z.warn - 3 || s > exitOf(z, 1) + 10;
      if (inZone) assert.equal(lim, 30, `at ${s}`);
      if (outside) assert.equal(lim, 50, `at ${s}`);
    }
  }
  // on green, over on the other lane through the narrowing, at 30
  {
    const net = loop();
    const { traffic, signals, ev, zone } = setUp(net, spec);
    const z = zone as WorkZone;
    const rules = new RuleMonitor(net.world, net.lanes, signals, traffic);
    let t = 0;
    while (!(lightAt(z, 0, t).state === SIG.GREEN && lightAt(z, 0, t).age < 0.2)) t += 0.1;
    // (at 8 m/s the line, 180 m on, is reached in some 22 s: green began 10 s before)
    signals.time = t - 12;
    const fwd = net.lanes.edgeLanes[0].fwd[0];
    drive(ev, signals, rules, 60, 420, 8, (s) => -1.5 + ev.shift(fwd, along(fwd, s)));
    const ids = rules.log.map((x) => x.id);
    assert.deepEqual(ids, [], `no fault (${ids.join(', ')})`);
  }
});

test('the player on the side of the work (Zeichen 208): into the narrowing while an oncoming car is in it is a fault', () => {
  const net = loop();
  const { traffic, signals, ev, zone } = setUp(net, { side: 1, control: 'signs', lane: 0, z0: 280, z1: 310, taper: 10, limit: 30, warn: 40, green: [15, 15], phase: 0, seed: 2 });
  const z = zone as WorkZone;
  const rules = new RuleMonitor(net.world, net.lanes, signals, traffic);
  const back = net.lanes.edgeLanes[0].back[0];
  // an oncoming car in the narrowing (it stays there: counted as inside)
  traffic.addCar(back, along(back, (z.z0 + z.z1) / 2));
  const shiftOf = (s: number): number => ev.shift(net.lanes.edgeLanes[0].fwd[0], along(net.lanes.edgeLanes[0].fwd[0], s));
  for (let s = 150; s < 268; s += 8 * DT) {
    const p: PlayerSnapshot = { x: s, y: 100, z: 1.5 - shiftOf(s), yaw: -Math.PI / 2, speed: 8, indicator: 0, hazard: false, lookYaw: 0, seatbelt: true, handbrake: 0, stalled: false, hitScenery: 0, length: 4.3 };
    signals.update(DT);
    const lane = rules.laneNow;
    ev.step(DT, traffic.cars, { x: p.x, y: 100, z: p.z, yaw: p.yaw, speed: 8, length: 4.3, width: 1.8, lane, s: lane ? rules.laneFront - 2.15 : 0 });
    rules.update(DT, p, []);
  }
  assert.ok(rules.log.some((v) => v.id === 'worksYield' && v.severity === 'major'), `(${rules.log.map((v) => v.id).join(', ')})`);
});

/**
 * The car of a demonstration drive (the real vehicle model, driven by sim/autodriver.ts) along the first
 * road of the loop from x = 40, `off` metres left of its middle line; `each` looks at every step (the
 * model's position, the front bumper's x).  Returns the faults the monitor found.
 */
function demoDrive(net: Net, setup: ReturnType<typeof setUp>, off: number, until: number, each: (m: Float64Array, v: Vehicle) => void): string[] {
  const { traffic, signals } = setup;
  const rules = new RuleMonitor(net.world, net.lanes, signals, traffic);
  const v = new Vehicle(COMPACT_CAR_AUTOMATIC, new WorldGround(net.world, { heightAt: () => 100, coverAt: () => 0 }));
  v.teleport(40, 100.02, -off, -Math.PI / 2);
  v.resetDrivetrain(true);
  // (from the middle of the wheelbase to the front bumper)
  const FRONT = 2.2;
  const driver = new AutoDriver(net.world, signals, rules, traffic, { spec: COMPACT_CAR_AUTOMATIC, front: FRONT });
  const mpos = new Float64Array(3);
  const H = 1 / 120;
  for (let t = 0; t < 240 && mpos[0] < until; t += H) {
    v.getModelPosition(mpos);
    const cmd = driver.step(H, v, mpos, []);
    v.step(H, { steer: cmd.steer, throttle: cmd.throttle, brake: cmd.brake, clutch: 0, handbrake: 0, gear: 1, ignition: true, starter: false });
    signals.update(H);
    v.getModelPosition(mpos);
    const lane = rules.laneNow;
    traffic.update(H, { x: mpos[0], y: mpos[1], z: mpos[2], yaw: v.yaw, speed: v.speed, length: 4.28, width: 1.79, lane, s: lane ? rules.laneFront - 2.14 : 0 });
    rules.update(H, { x: mpos[0], y: mpos[1], z: mpos[2], yaw: v.yaw, speed: v.speed, indicator: cmd.indicator, hazard: false, lookYaw: cmd.look, seatbelt: true, handbrake: 0, stalled: false, hitScenery: 0, length: 4.28, front: FRONT }, traffic.events);
    each(mpos, v);
  }
  assert.ok(mpos[0] >= until, `got through (to x ${mpos[0].toFixed(0)})`);
  return rules.log.map((x) => `${x.id} (${x.severity})`);
}

test('the demonstration drive at a site light: stops at the line on red, then through the narrowing over on the other lane – without a fault', () => {
  const net = loop();
  const setup = setUp(net, { side: 1, control: 'light', lane: 0, z0: 250, z1: 330, taper: 10, limit: 30, warn: 40, green: [15, 15], phase: 0, seed: 1 });
  const z = setup.zone as WorkZone;
  // (red for the side of the work a few seconds after the start: the car comes to the line on red)
  let t0 = 0;
  while (!(lightAt(z, 0, t0).state === SIG.RED && lightAt(z, 0, t0).age < 0.1)) t0 += 0.05;
  setup.signals.time = t0 - 4;
  const wait = waitOf(z, 1);
  let stood = 0;
  let over = 0;
  const faults = demoDrive(net, setup, -1.5, 420, (m, v) => {
    const front = m[0] + 2.2;
    if (Math.abs(v.speed) < 0.1 && front < wait + 0.5 && front > wait - 6) stood += 1 / 120;
    // (left of a → b, the direction +x, is −z: in the narrowing the car keeps left of the beacons)
    if (m[0] > z.z0 && m[0] < z.z1) {
      assert.ok(-m[2] > z.line + 0.9, `in the strip at x ${m[0].toFixed(1)} (${(-m[2]).toFixed(2)})`);
      if (m[0] > z.z0 + 10 && m[0] < z.z1 - 10) over++;
    }
  });
  assert.ok(stood > 3, `waited at the line (${stood.toFixed(1)} s)`);
  assert.ok(over > 100);
  assert.deepEqual(faults, []);
});

test('the demonstration drive on a road of two lanes each way: out of the lane that ends before the barrier, past the strip – without a fault', () => {
  const net = loop({ lf: 2, lb: 2, lw: 3.25, cls: CLS.PRIMARY });
  const setup = setUp(net, { side: 1, control: 'lane', lane: 0, z0: 280, z1: 400, taper: 18, limit: 30, warn: 40, green: [15, 15], phase: 0, seed: 3 });
  const z = setup.zone as WorkZone;
  let moved = false;
  const faults = demoDrive(net, setup, -4.875, 450, (m) => {
    if (m[0] > entryOf(z, 1) && m[0] < z.z1) assert.ok(-m[2] > z.line + 0.9, `in the strip at x ${m[0].toFixed(1)} (${(-m[2]).toFixed(2)})`);
    if (m[0] < entryOf(z, 1) && -m[2] > -2.2) moved = true;
  });
  assert.ok(moved, 'over to the open lane before the taper');
  assert.deepEqual(faults, []);
});

// ------------------------------------------------------------------------------------ demonstrations

test('demonstrations: the same date gives the same ones – on most Saturdays around midday, seldom on weekdays, always on the 1st of May', () => {
  assert.deepEqual(demosOn(2026, 11, 21), demosOn(2026, 11, 21));
  let saturdays = 0;
  let saturdayDemos = 0;
  let weekdays = 0;
  let weekdayDemos = 0;
  for (let t = Date.UTC(2027, 0, 1); t < Date.UTC(2028, 0, 1); t += 86400_000) {
    const d = new Date(t);
    const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    const list = demosOn(y, m, day);
    const wd = d.getUTCDay();
    for (const p of list) {
      const minutes = (p.until - p.from) / 60000;
      assert.ok(minutes >= 60 && minutes <= 135, `${minutes} min`);
      assert.ok(p.size >= 30 && p.size <= 220);
      // between the morning and the evening, by the clocks in Kassel
      const h = berlinClock(new Date(p.from)).s / 3600;
      assert.ok(h >= 9.7 && h <= 17.8, `begins at ${h.toFixed(2)} h`);
    }
    if (m === 5 && day === 1) {
      assert.ok(list.length >= 1, 'the 1st of May');
      continue;
    }
    if (wd === 6) {
      saturdays++;
      if (list.length > 0) saturdayDemos++;
      // around midday, or in the afternoon
      for (const p of list) {
        const h = berlinClock(new Date(p.from)).s / 3600;
        assert.ok((h >= 10.7 && h <= 12.3) || (h >= 13.7 && h <= 15.3), `on a Saturday at ${h.toFixed(2)} h`);
      }
    } else if (wd >= 1 && wd <= 5) {
      weekdays++;
      if (list.length > 0) weekdayDemos++;
    }
  }
  assert.ok(saturdayDemos / saturdays > 0.5 && saturdayDemos / saturdays < 0.9, `${saturdayDemos} of ${saturdays} Saturdays`);
  assert.ok(weekdayDemos / weekdays > 0.08 && weekdayDemos / weekdays < 0.3, `${weekdayDemos} of ${weekdays} weekdays`);
});

/** A town with a main street through it, and a march planned near its middle. */
function marchTown(): { town: ReturnType<typeof makeTown>; centre: [number, number] } {
  const town = makeTown({ cols: 9, rows: 7, block: 120 });
  // (just south of the street along z = 240: the march takes that one)
  return { town, centre: [370, 245] };
}

test('the way of a march: along the streets from the place it gathers at, all in one line – its roads and the side roads into it closed', () => {
  const { town, centre } = marchTown();
  const route = demoRoute(town.world, centre[0], centre[1], 500);
  assert.ok(route, 'a way');
  const r = route!;
  assert.ok(r.length >= 450, `about as long as wanted (${r.length.toFixed(0)} m)`);
  // one after the other: each road begins where the one before ends
  for (let i = 0; i < r.edges.length; i++) {
    const e = town.world.edges[r.edges[i]];
    const from = r.dirs[i] > 0 ? e.a : e.b;
    const to = r.dirs[i] > 0 ? e.b : e.a;
    assert.equal(from.id, r.nodes[i]);
    assert.equal(to.id, r.nodes[i + 1]);
  }
  assert.equal(new Set(r.edges).size, r.edges.length, 'no road twice');
  // the same roads: the same way
  assert.deepEqual(demoRoute(town.world, centre[0], centre[1], 500)?.edges, r.edges);
  // closed: its roads both ways, and the side roads where they lead into it
  for (const id of r.edges) assert.ok(r.ways.has(id * 2) && r.ways.has(id * 2 + 1));
  for (let i = 1; i < r.nodes.length - 1; i++) {
    const node = town.world.nodes[r.nodes[i]];
    for (const a of node.arms) {
      if (r.roads.has(a.edge.id)) continue;
      assert.ok(r.ways.has(a.edge.id * 2 + (a.out ? 1 : 0)), 'the side road into it');
      assert.ok(!r.ways.has(a.edge.id * 2 + (a.out ? 0 : 1)), 'not the way out of it');
    }
  }
});

test('a march: it gathers, then walks its street there and back at a slow pace – the crowd always on its way, never jumping', () => {
  const { town, centre } = marchTown();
  const route = demoRoute(town.world, centre[0], centre[1], 700)!;
  const d: Demonstration = { kind: 'demo', id: 2, place: 'Marktplatz', town: 'Test', x: centre[0], z: centre[1], from: SATURDAY, until: SATURDAY + 7200_000, size: 120, seed: 4, route, layout: null };
  const len = crowdShape(d).length;
  let walking = 0;
  let turns = 0;
  let last: { lo: number; hi: number; dir: number } | null = null;
  for (let ms = d.from; ms < d.until; ms += 1000) {
    const m = marchAt(d, ms);
    // the stretch the crowd covers: from its front back over its length
    const lo = Math.min(m.head, m.head - m.dir * len);
    const hi = Math.max(m.head, m.head - m.dir * len);
    assert.ok(lo >= -0.01 && hi <= route.length + 0.01, `on its way (${lo.toFixed(1)}–${hi.toFixed(1)} of ${route.length.toFixed(0)})`);
    if (m.walking) walking++;
    if (last) {
      assert.ok(Math.abs(lo - last.lo) < 0.6 && Math.abs(hi - last.hi) < 0.6, `a jump at ${(ms - d.from) / 1000} s`);
      if (m.dir !== last.dir) turns++;
    }
    last = { lo, hi, dir: m.dir };
  }
  assert.ok(walking > 0.6 * 7200, `mostly walking (${walking} of 7200 s)`);
  assert.ok(turns >= 2, 'there and back');
});

test('a march under way: the traffic keeps out of the closed roads, the planned ways go round them, whoever drives in is at fault', () => {
  const { town, centre } = marchTown();
  const signals = new SignalSystem(town.world.signals);
  const traffic = new Traffic(town.world, town.lanes, signals);
  traffic.targetCount = 26;
  const ev = new RoadEvents(town.world, town.lanes, signals);
  let now = SATURDAY;
  ev.now = () => now;
  traffic.roadEvents = ev;
  const player: PlayerState = { x: centre[0], y: 100, z: centre[1] + 60, yaw: 0, speed: 0, length: 4.3, width: 1.8 };
  ev.step(0, [], player);
  ev.zones.clear();
  const demo: Demonstration = { kind: 'demo', id: 1, place: 'Marktplatz', town: 'Test', x: centre[0], z: centre[1], from: SATURDAY - 600_000, until: SATURDAY + 3600_000, size: 80, seed: 5, route: null, layout: null };
  ev.demos = [demo];
  // (the next look at the day finds the march: its way, what is closed)
  ev.step(1, [], player);
  assert.ok(demo.route, 'its way is known');
  const r = demo.route!;
  for (const id of r.edges) {
    const el = town.lanes.edgeLanes[id];
    for (const lane of [...el.fwd, ...el.back]) assert.ok(ev.closed(lane));
  }
  // the traffic: never on a closed road
  let cars = 0;
  for (let t = 0; t < 150; t += DT) {
    signals.update(DT);
    traffic.update(DT, player);
    for (const car of traffic.cars) {
      cars = Math.max(cars, traffic.cars.length);
      if (car.lane) assert.ok(!ev.closed(car.lane), `car ${car.id} on a closed road ${car.lane.edge.id}`);
      if (car.conn) assert.ok(!ev.closed(car.conn.to), `car ${car.id} turning into a closed road ${car.conn.to.edge.id}`);
    }
  }
  assert.ok(cars > 10, 'there was traffic');
  // the barriers: at both ends of the march and across the side roads; what the traffic stops for
  const L = ev.closureLayout(demo);
  assert.ok(L.barriers.length >= 2 && L.officers.length >= 4 && L.signs.length === L.barriers.length);
  assert.ok(L.signs.every((s) => s.s.includes('250')));
  // the planned ways: round it – through the town from one side of the march to the other
  town.lanes.wayCost = routeFor.wayCost = (w) => ev.wayCost(w);
  try {
    assert.ok(r.edges.every((id) => Math.abs(town.world.edges[id].a.z - 240) < 1 && Math.abs(town.world.edges[id].b.z - 240) < 1), 'along the street at z = 240');
    const start = town.world.edges[town.street(3, 0, 4, 0)];
    const goal = town.world.edges[town.street(3, 4, 4, 4)];
    const from = town.lanes.edgeLanes[start.id].fwd[0];
    const way = town.lanes.route(from, goal);
    assert.ok(way, 'a way round');
    for (const c of way!) assert.ok(!ev.closed(c.to), `not through the march (road ${c.to.edge.id})`);
    const g = routeGraphOf(town.lanes);
    const ways = quickest(g, wayOf(from), wayOf(town.lanes.edgeLanes[goal.id].fwd[0]));
    assert.ok(ways, 'a way round for the planner of the whole map');
    for (const w of ways!) assert.ok(ev.wayCost(w) !== Infinity, 'the whole-map planner goes round, too');
  } finally {
    town.lanes.wayCost = routeFor.wayCost = null;
  }
  // the player: inside when it was closed, out of it – no fault; from an open road into it past the barrier – a fault
  const rules = new RuleMonitor(town.world, town.lanes, signals, traffic);
  const east = Math.max(...r.nodes.map((id) => town.world.nodes[id].x));
  const westward = (x0: number, x1: number): void => {
    // (westward, in the lane on the right: north of the middle line)
    for (let x = x0; x > x1; x -= 0.4) rules.update(DT, { x, y: 100, z: 240 - 1.375, yaw: Math.PI / 2, speed: 8, indicator: 0, hazard: false, lookYaw: 0, seatbelt: true, handbrake: 0, stalled: false, hitScenery: 0, length: 4.3 }, []);
  };
  westward(east - 30, east - 100);
  assert.ok(!rules.log.some((v) => v.id === 'closedRoad'), 'already inside: no fault');
  westward(east + 70, east - 60);
  assert.ok(rules.log.some((v) => v.id === 'closedRoad'), `(${rules.log.map((v) => v.id).join(', ')})`);
  // the trams stop for the crowd on its street
  const forTrams: RailObstacle[] = [];
  ev.railBlocks(forTrams);
  assert.ok(forTrams.length >= 5, `the crowd is in the trams' way (${forTrams.length})`);
  // over: nothing closed any more
  now = demo.until + 1000;
  ev.step(1, [], player);
  assert.ok(!r.edges.some((id) => ev.closed(town.lanes.edgeLanes[id].fwd[0])));
});

test('the events of the day for the map: the zones with their street, the marches with their times and their way', () => {
  const { town, centre } = marchTown();
  const signals = new SignalSystem(town.world.signals);
  const ev = new RoadEvents(town.world, town.lanes, signals);
  ev.now = () => SATURDAY;
  const player: PlayerState = { x: centre[0], y: 100, z: centre[1], yaw: 0, speed: 0, length: 4.3, width: 1.8 };
  ev.step(0, [], player);
  ev.zones.clear();
  const e = town.world.edges[0];
  ev.zones.set(e.id, makeZone(e, town.lanes, { side: 1, control: 'signs', lane: 0, z0: 40, z1: 70, taper: 8, limit: 30, warn: 30, green: [15, 15], phase: 0, seed: 9 }));
  ev.demos = [{ kind: 'demo', id: 7, place: 'Marktplatz', town: 'Test', x: centre[0], z: centre[1], from: SATURDAY - 60_000, until: SATURDAY + 5400_000, size: 60, seed: 2, route: null, layout: null }];
  ev.step(1, [], player);
  const list = ev.list();
  const works = list.find((i) => i.kind === 'works');
  const demo = list.find((i) => i.kind === 'demo');
  assert.ok(works && demo);
  assert.equal(works!.street, e.name);
  assert.equal(works!.detail, 'signs');
  assert.ok(works!.from <= SATURDAY && works!.until > SATURDAY);
  assert.equal(demo!.active, true);
  assert.equal(demo!.until, SATURDAY + 5400_000);
  assert.ok(demo!.line.length >= 8, 'the course of the march');
  assert.ok(demo!.street.length > 0);
});
