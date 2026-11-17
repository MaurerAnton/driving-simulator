// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Queues in the traffic and getting past what blocks the way, on made-up
 * roads: how a queue is measured (src/sim/queues.ts) – back over the
 * junction behind it, with the wait at a red light – and when a car of the
 * traffic goes round something standing in its lane (src/sim/pastblock.ts):
 * into the lane beside, over the oncoming lane when it is clear, half onto
 * the verge – never over a solid line for something that will move again,
 * never just before a junction, never round a queue.
 *
 *   node --test tests/sim/queues.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { angleOf } from '../../src/core/geom.ts';
import { QUEUE_MIN, QueueMeter } from '../../src/sim/queues.ts';
import { AutoDriver } from '../../src/sim/autodriver.ts';
import { WorldGround } from '../../src/sim/ground.ts';
import { RuleMonitor } from '../../src/sim/rules.ts';
import { COMPACT_CAR_AUTOMATIC, Vehicle } from '../../src/sim/vehicle/index.ts';
import { SIG, SignalSystem } from '../../src/sim/signals.ts';
import { Traffic, boxesOverlap } from '../../src/sim/traffic.ts';
import type { PlayerState, TrafficCar } from '../../src/sim/traffic.ts';
import { LaneGraph, lanePoint } from '../../src/world/lanes.ts';
import type { Lane } from '../../src/world/lanes.ts';
import { newPolySample } from '../../src/core/geom.ts';
import { CLS, CTRL, EF, ROLE } from '../../src/world/types.ts';
import type { EdgeJson, NodeJson, WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts } from '../../src/world/world.ts';

const DT = 1 / 20;

interface Road {
  a: number;
  b: number;
  lf?: number;
  lb?: number;
  urban?: boolean;
  flags?: number;
  cls?: number;
}

interface Net {
  world: World;
  lanes: LaneGraph;
}

/** Straight roads between junctions at these points (y = 100), as the map build hands them to the game (as in tests/sim/roadevents.test.ts). */
function makeNet(points: Array<[number, number]>, roads: Road[]): Net {
  const nodes: NodeJson[] = points.map(([x, z]) => ({ x, y: 100, z, t: CTRL.NONE, arms: [] }));
  const edges: EdgeJson[] = roads.map((r, i) => {
    const A = nodes[r.a];
    const B = nodes[r.b];
    const p: number[] = [];
    const n = Math.max(1, Math.round(Math.hypot(B.x - A.x, B.z - A.z) / 20));
    for (let k = 0; k <= n; k++) p.push(A.x + ((B.x - A.x) * k) / n, 100, A.z + ((B.z - A.z) * k) / n);
    const lf = r.lf ?? 1;
    const lb = r.lb ?? 1;
    return { a: r.a, b: r.b, c: r.cls ?? CLS.SECONDARY, n: `Road ${i}`, p, lf, lb, lw: 3.2, w: (lf + lb) * 3.2, mf: 50, mb: 50, f: (r.urban ? EF.URBAN : 0) | (r.flags ?? 0), ca: 0, cb: 0 };
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
    meta: { name: 'Test roads', generated: '', minX: -3000, maxX: 4000, minZ: -3000, maxZ: 4000, tileSize: 500, originE: 0, originN: 0, attribution: [] },
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
  const world = new World(json);
  return { world, lanes: new LaneGraph(world) };
}

/** One straight road of 700 m from west to east, joined on at both ends so that the cars drive on. */
function straight(road: Omit<Road, 'a' | 'b'> = {}): Net {
  return makeNet(
    [
      [0, 0],
      [700, 0],
      [700, 400],
      [0, 400],
    ],
    [
      { a: 0, b: 1, ...road },
      { a: 1, b: 2 },
      { a: 2, b: 3 },
      { a: 3, b: 0 },
    ],
  );
}

/** the player out of the way: high above the road, so that nobody brakes for it (but the cars stay around it) */
const AWAY: PlayerState = { x: 350, y: 160, z: 200, yaw: 0, speed: 0, length: 4.3, width: 1.8 };

function setUp(net: Net): { traffic: Traffic; signals: SignalSystem; east: Lane; west: Lane } {
  const signals = new SignalSystem([]);
  const traffic = new Traffic(net.world, net.lanes, signals);
  traffic.targetCount = 0;
  const el = net.lanes.edgeLanes[0];
  return { traffic, signals, east: el.fwd[0], west: el.back[0] };
}

/** A car of the traffic that has broken down where it stands (it stays: crashed for good). */
function brokenDown(traffic: Traffic, lane: Lane, s: number): TrafficCar {
  const c = traffic.addCar(lane, s);
  c.crashed = 1e6;
  c.v = 0;
  return c;
}

function overlap(a: { x: number; z: number; yaw: number; length: number; width: number }, b: { x: number; z: number; yaw: number; length: number; width: number }): boolean {
  return boxesOverlap(a.x, a.z, a.yaw, a.length / 2 - 0.1, a.width / 2 - 0.1, b.x, b.z, b.yaw, b.length / 2 - 0.1, b.width / 2 - 0.1);
}

/** Run the traffic; `each` is called after every step. */
function run(traffic: Traffic, seconds: number, player: PlayerState = AWAY, each?: () => void): void {
  for (let t = 0; t < seconds; t += DT) {
    traffic.update(DT, player);
    each?.();
  }
}

// ------------------------------------------------------------------------------------ queues

test('a queue: counted from its head back to its end, cars that drive are none', () => {
  const { traffic, east } = setUp(straight());
  const meter = new QueueMeter();
  // five cars standing 9 m apart (about 4.5 m between them), the first at 400 m – and two more 60 m further back
  const q: TrafficCar[] = [];
  for (let i = 0; i < 5; i++) q.push(traffic.addCar(east, 400 - i * 9));
  for (const c of q) c.v = 0;
  const loose = [traffic.addCar(east, 300), traffic.addCar(east, 292)];
  for (const c of loose) c.v = 0;
  let found = meter.measure(traffic.cars, null);
  assert.equal(found.length, 1, 'one queue (two cars are no queue)');
  assert.equal(found[0].cars, 5);
  assert.equal(found[0].head, q[0]);
  assert.equal(found[0].tail, q[4]);
  // from the front of the first to the back of the last: 4 × 9 m + half the first car and half the last
  assert.ok(Math.abs(found[0].length - (36 + q[0].length / 2 + q[4].length / 2)) < 0.01, `length ${found[0].length}`);
  assert.ok(Number.isNaN(found[0].wait), 'no light at its head: the wait cannot be told');
  // the third one drives off: two queues of two – none
  q[2].v = 8;
  found = meter.measure(traffic.cars, null);
  assert.equal(found.length, 0);
  assert.ok(QUEUE_MIN >= 3);
});

test('a queue reaches back over the junction behind it', () => {
  const net = straight();
  const { traffic } = setUp(net);
  // the road north from (700, 0) to (700, 400) is road 1 – its lane towards the south ends at (700, 0); the queue begins at the start of road 0's lane west?
  const into = net.lanes.edgeLanes[1].back[0]; // from (700, 400) to (700, 0)
  const out = net.lanes.edgeLanes[0].back[0]; // from (700, 0) west
  const c = into.out.find((k) => k.to === out);
  assert.ok(c, 'a path from the one into the other');
  // three cars at the start of the lane west, two on the lane before the junction
  const ahead = [traffic.addCar(out, 22), traffic.addCar(out, 14), traffic.addCar(out, 6)];
  const behind = [traffic.addCar(into, into.len - 4), traffic.addCar(into, into.len - 12)];
  for (const k of behind) k.next = c;
  for (const k of [...ahead, ...behind]) k.v = 0.5;
  const found = new QueueMeter().measure(traffic.cars, null);
  assert.equal(found.length, 1);
  assert.equal(found[0].cars, 5);
  assert.equal(found[0].tail, behind[1]);
});

test('the wait at a red light: until green, and a couple of seconds for each car ahead', () => {
  const { traffic, east } = setUp(straight());
  const fake = {
    get: () => SIG.RED,
    change: () => ({ left: 20, next: SIG.RED_AMBER }),
    isDark: () => false,
  } as unknown as SignalSystem;
  // (a lane that ends at a light)
  const lane = { ...east, armTo: { ...east.armTo, sg: 0 }, to: { ...east.to, sc: 0 } } as Lane;
  const cars: TrafficCar[] = [];
  for (let i = 0; i < 6; i++) {
    const c = traffic.addCar(east, east.stopAt - 3 - i * 7);
    c.v = 0;
    c.lane = lane;
    cars.push(c);
  }
  const found = new QueueMeter().measure(cars, fake);
  assert.equal(found.length, 1);
  assert.ok(found[0].wait > 20 + 5 * 1.5 && found[0].wait < 20 + 5 * 2.5 + 3, `wait ${found[0].wait}`);
});

// ------------------------------------------------------------------------------------ getting past

test('over the oncoming lane round a broken-down car, and back – nobody touched', () => {
  const { traffic, east } = setUp(straight());
  const broken = brokenDown(traffic, east, 300);
  const car = traffic.addCar(east, 240);
  let most = 0;
  let touched = false;
  run(traffic, 60, AWAY, () => {
    if (car.past) most = Math.max(most, car.past.off);
    if (overlap(car, broken)) touched = true;
  });
  assert.ok(most > 2, `it moved out to the left (${most.toFixed(2)} m)`);
  assert.ok(!touched, 'never into the broken-down car');
  assert.ok(traffic.cars.includes(car));
  assert.ok(car.lane !== east || car.s > 320, `past it (s ${car.s.toFixed(0)})`);
  assert.equal(car.past?.off ?? 0, 0, 'back in its lane');
});

test('it waits while somebody comes the other way, and goes once they are past', () => {
  const { traffic, east, west } = setUp(straight());
  const broken = brokenDown(traffic, east, 300);
  const car = traffic.addCar(east, 285);
  car.v = 0;
  // oncoming: one car after another
  const others = [traffic.addCar(west, west.len - 300 - 120), traffic.addCar(west, west.len - 300 - 260)];
  let touched = false;
  let outWhileComing = false;
  run(traffic, 70, AWAY, () => {
    for (const o of [broken, ...others]) if (traffic.cars.includes(o) && overlap(car, o)) touched = true;
    // (out over the middle while one of them is still within 60 m ahead, coming)
    if (car.past && car.past.off > 1.6) {
      for (const o of others) {
        if (!traffic.cars.includes(o) || o.lane !== west) continue;
        const ahead = (o.x - car.x) * 1;
        if (ahead > 0 && ahead < 60) outWhileComing = true;
      }
    }
  });
  assert.ok(!touched, 'nobody touched');
  assert.ok(!outWhileComing, 'not out while one was coming close');
  assert.ok(car.lane !== east || car.s > 320, `past in the end (s ${car.s.toFixed(0)})`);
});

test('a solid centre line: not over it for the player standing – onto the verge outside town instead', () => {
  for (const urban of [false, true]) {
    const { traffic, east } = setUp(straight({ flags: EF.SOLID_CENTER, urban }));
    const p = newPolySample();
    lanePoint(east, 300, p);
    // the player's car standing in the lane, facing east
    const player: PlayerState = { x: p.x, y: 100, z: p.z, yaw: Math.atan2(-p.tx, -p.tz), speed: 0, length: 4.3, width: 1.8 };
    const car = traffic.addCar(east, 250);
    let left = 0;
    let right = 0;
    let touched = false;
    run(traffic, 50, player, () => {
      if (car.past) {
        left = Math.max(left, car.past.off);
        right = Math.min(right, car.past.off);
      }
      if (overlap(car, player)) touched = true;
    });
    assert.ok(!touched);
    assert.ok(left < 0.5, `never over the solid line (${left.toFixed(2)} m)`);
    if (urban) assert.ok(right > -0.5 && car.s < 300, 'in town: it waits');
    else {
      assert.ok(right < -1.2, `half onto the verge (${right.toFixed(2)} m)`);
      assert.ok(car.lane !== east || car.s > 310, 'and past');
    }
  }
});

test('a solid centre line, but a parked vehicle stands there for good: over it', () => {
  const { traffic, east } = setUp(straight({ flags: EF.SOLID_CENTER, urban: true }));
  const p = newPolySample();
  lanePoint(east, 300, p);
  traffic.obstacles = [{ x: p.x, y: 100, z: p.z, yaw: Math.atan2(-p.tx, -p.tz), speed: 0, length: 4.4, width: 1.8, parked: true }];
  const car = traffic.addCar(east, 250);
  let most = 0;
  run(traffic, 50, AWAY, () => {
    if (car.past) most = Math.max(most, car.past.off);
  });
  assert.ok(most > 2, `out to the left (${most.toFixed(2)} m)`);
  assert.ok(car.lane !== east || car.s > 310);
});

test('two lanes each way: into the lane beside', () => {
  const { traffic } = setUp(straight({ lf: 2, lb: 2 }));
  const el = traffic.graph.edgeLanes[0];
  const right = el.fwd[0];
  brokenDown(traffic, right, 300);
  const car = traffic.addCar(right, 250);
  let moved = false;
  run(traffic, 40, AWAY, () => {
    if (car.lane === el.fwd[1]) moved = true;
  });
  assert.ok(moved, 'over into the left lane');
});

test('no going round a queue, nor just before a junction', () => {
  // a queue: the one in front of it waits behind another car (not broken down)
  const { traffic, east } = setUp(straight());
  const a = traffic.addCar(east, 300);
  const b = traffic.addCar(east, 292);
  const c = traffic.addCar(east, 284);
  for (const k of [a, b, c]) k.v = 0;
  assert.equal(traffic.pastBlocks.plan(c, AWAY), null, 'behind a car that waits: no way round');
  // a broken-down car right before the end of the road
  const net2 = straight();
  const s2 = setUp(net2);
  brokenDown(s2.traffic, s2.east, s2.east.stopAt - 6);
  const d = s2.traffic.addCar(s2.east, s2.east.stopAt - 15);
  d.v = 0;
  s2.traffic.update(DT, AWAY);
  assert.equal(s2.traffic.pastBlocks.plan(d, AWAY), null, 'not just before the junction');
});

test('never through people: a person standing in the way out', () => {
  // (in town: no verge to go onto instead)
  const { traffic, east } = setUp(straight({ urban: true }));
  brokenDown(traffic, east, 300);
  const car = traffic.addCar(east, 291);
  car.v = 0;
  const p = newPolySample();
  lanePoint(east, 300, p);
  // somebody on foot on the oncoming lane beside the broken-down car (an obstacle that is no vehicle)
  traffic.obstacles = [{ x: p.x + p.tz * 3.2, y: 100, z: p.z - p.tx * 3.2, yaw: 0, speed: 0, length: 0.6, width: 0.6 }];
  traffic.update(DT, AWAY);
  assert.equal(traffic.pastBlocks.plan(car, AWAY), null);
  traffic.obstacles = [];
  traffic.update(DT, AWAY);
  assert.equal(traffic.pastBlocks.plan(car, AWAY)?.kind, 'oncoming');
});

test('the autopilot goes round a broken-down car the same way – slowly, so without a fault', () => {
  const net = straight();
  const { traffic, signals, east } = setUp(net);
  const broken = brokenDown(traffic, east, 300);
  const rules = new RuleMonitor(net.world, net.lanes, signals, traffic);
  const v = new Vehicle(COMPACT_CAR_AUTOMATIC, new WorldGround(net.world, { heightAt: () => 100, coverAt: () => 0 }));
  // (east along the road, in its lane: right of the middle is +z)
  v.teleport(200, 100.02, 1.6, -Math.PI / 2);
  v.resetDrivetrain(true);
  const FRONT = 2.2;
  const driver = new AutoDriver(net.world, signals, rules, traffic, { spec: COMPACT_CAR_AUTOMATIC, front: FRONT });
  const mpos = new Float64Array(3);
  const H = 1 / 60;
  let touched = false;
  let left = 0;
  for (let t = 0; t < 120 && mpos[0] < 360; t += H) {
    v.getModelPosition(mpos);
    const cmd = driver.step(H, v, mpos, []);
    v.step(H, { steer: cmd.steer, throttle: cmd.throttle, brake: cmd.brake, clutch: 0, handbrake: 0, gear: 1, ignition: true, starter: false });
    signals.update(H);
    v.getModelPosition(mpos);
    const lane = rules.laneNow;
    const me = { x: mpos[0], y: mpos[1], z: mpos[2], yaw: v.yaw, speed: v.speed, length: 4.28, width: 1.79, lane, s: lane ? rules.laneFront - 2.14 : 0 };
    traffic.update(H, me);
    rules.update(H, { x: mpos[0], y: mpos[1], z: mpos[2], yaw: v.yaw, speed: v.speed, indicator: cmd.indicator, hazard: false, lookYaw: cmd.look, seatbelt: true, handbrake: 0, stalled: false, hitScenery: 0, length: 4.28, front: FRONT }, traffic.events);
    if (overlap(me, broken)) touched = true;
    left = Math.max(left, -mpos[2]);
  }
  assert.ok(mpos[0] >= 360, `got past (x ${mpos[0].toFixed(0)})`);
  assert.ok(!touched, 'never into the broken-down car');
  assert.ok(left > 0.3, `over the middle of the road (${left.toFixed(2)} m)`);
  const faults = rules.log.map((x) => `${x.id} (${x.severity})`);
  assert.deepEqual(faults, [], `no fault (${faults.join(', ')})`);
});
