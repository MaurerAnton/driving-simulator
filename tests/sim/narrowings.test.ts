// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Kerb build-outs narrowing a road (src/world/narrowing.ts,
 * src/sim/narrowings.ts): on a straight two-way street without lane
 * markings, a car of the traffic passes one without touching its bed and
 * slows down; where it is on its side it waits for an oncoming car (§ 6
 * StVO), the other direction does not; the autopilot passes it without a
 * fault; the player who drives in while somebody comes the other way makes
 * one; the beds are solid for the player's car.
 *
 *   node --test tests/sim/narrowings.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { angleOf } from '../../src/core/geom.ts';
import { AutoDriver } from '../../src/sim/autodriver.ts';
import { SceneryCollider } from '../../src/sim/collision.ts';
import { WorldGround } from '../../src/sim/ground.ts';
import { NARROW_WAIT, narrowCollide } from '../../src/sim/narrowings.ts';
import { RuleMonitor } from '../../src/sim/rules.ts';
import type { PlayerSnapshot } from '../../src/sim/rules.ts';
import { SignalSystem } from '../../src/sim/signals.ts';
import { Traffic, boxesOverlap } from '../../src/sim/traffic.ts';
import type { PlayerState, TrafficCar } from '../../src/sim/traffic.ts';
import { COMPACT_CAR_AUTOMATIC, Vehicle } from '../../src/sim/vehicle/index.ts';
import { LaneGraph } from '../../src/world/lanes.ts';
import type { Lane } from '../../src/world/lanes.ts';
import { buildOutEntries } from '../../src/world/narrowing.ts';
import { CLS, CTRL, EF, ROLE } from '../../src/world/types.ts';
import type { EdgeJson, NodeJson, WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts } from '../../src/world/world.ts';

const DT = 1 / 20;
/** the bed: 6 m long, its middle 300 m along the first road */
const AT = 300;
const LEN = 6;

interface Net {
  world: World;
  lanes: LaneGraph;
}

/**
 * Four unmarked residential streets 5.5 m wide round a block of 600 × 150 m;
 * on the first (z = 0, x 0 → 600) a choker on one side (`side` as the map
 * says it: left | right of the way's direction).
 */
function loop(side: 'left' | 'right'): Net {
  const pts: Array<[number, number]> = [
    [0, 0],
    [600, 0],
    [600, 150],
    [0, 150],
  ];
  const nodes: NodeJson[] = pts.map(([x, z]) => ({
    x,
    y: 100,
    z,
    t: CTRL.NONE,
    arms: [],
  }));
  const edges: EdgeJson[] = [0, 1, 2, 3].map((i) => {
    const A = nodes[i];
    const B = nodes[(i + 1) % 4];
    const p: number[] = [];
    const n = Math.max(1, Math.round(Math.hypot(B.x - A.x, B.z - A.z) / 20));
    for (let k = 0; k <= n; k++) p.push(A.x + ((B.x - A.x) * k) / n, 100, A.z + ((B.z - A.z) * k) / n);
    const e: EdgeJson = {
      a: i,
      b: (i + 1) % 4,
      c: CLS.RESIDENTIAL,
      n: `Road ${i}`,
      p,
      lf: 1,
      lb: 1,
      lw: 2.75,
      w: 5.5,
      mf: 50,
      mb: 50,
      f: EF.URBAN,
      ca: 0,
      cb: 0,
    };
    if (i === 0)
      e.bo = buildOutEntries([
        {
          kind: 'bump',
          s: AT,
          tags: {
            traffic_calming: 'choker',
            side,
            length: String(LEN),
            beacon: 'yes',
          },
        },
      ]);
    return e;
  });
  nodes.forEach((node, ni) => {
    const arms = edges
      .map((e, ei) => ({
        e: ei,
        ok: e.a === ni || e.b === ni,
        other: nodes[e.a === ni ? e.b : e.a],
      }))
      .filter((a) => a.ok)
      .map((a) => ({
        e: a.e,
        ang: angleOf(a.other.x - node.x, a.other.z - node.z),
      }))
      .sort((p, q) => p.ang - q.ang);
    node.arms = arms.map((a) => ({ e: a.e, r: ROLE.NONE }));
  });
  const json: WorldJson = {
    version: 1,
    meta: {
      name: 'Test roads',
      generated: '',
      minX: -3000,
      maxX: 14000,
      minZ: -3000,
      maxZ: 14000,
      tileSize: 500,
      originE: 0,
      originN: 0,
      attribution: [],
    },
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

function setUp(net: Net): {
  traffic: Traffic;
  signals: SignalSystem;
  player: PlayerState;
} {
  const signals = new SignalSystem(net.world.signals);
  const traffic = new Traffic(net.world, net.lanes, signals);
  traffic.targetCount = 0;
  traffic.spawnRadius = 5000;
  // (the player stands off the roads, watching)
  const player: PlayerState = {
    x: 300,
    y: 100,
    z: 420,
    yaw: 0,
    speed: 0,
    length: 4.3,
    width: 1.8,
  };
  return { traffic, signals, player };
}

/** A lane's distance of a station. */
const along = (lane: Lane, s: number): number => (s - lane.s0) * lane.dir;

/** The bed as a box (a → b is +x; left of it is −z): `side` +1 left, −1 right. */
function bedTouched(net: Net, x: number, z: number, yaw: number, hl: number, hw: number): boolean {
  const n = net.world.edges[0].narrow![0];
  const half = net.world.edges[0].width / 2;
  const mid = n.side * (half - n.depth / 2);
  return boxesOverlap(x, z, yaw, hl, hw, (n.s0 + n.s1) / 2, -mid, -Math.PI / 2, (n.s1 - n.s0) / 2, n.depth / 2);
}

/** Step the traffic until `done` (at most `secs`); `each` sees every step. */
function run(traffic: Traffic, player: PlayerState, secs: number, done: () => boolean, each: () => void): void {
  for (let t = 0; t < secs && !done(); t += DT) {
    traffic.update(DT, player);
    each();
  }
}

test('a build-out on a narrow street: one lane left, on the side mapped, as deep as it may be', () => {
  const net = loop('right');
  const list = net.world.edges[0].narrow!;
  assert.equal(list.length, 1);
  const n = list[0];
  assert.equal(n.side, -1);
  assert.ok(Math.abs(n.depth - 1.6) < 1e-9);
  assert.ok(Math.abs(n.s0 - (AT - LEN / 2)) < 1e-9 && Math.abs(n.s1 - (AT + LEN / 2)) < 1e-9);
  assert.ok(n.single, 'one vehicle at a time');
  assert.ok(Math.abs(n.lo - (-2.75 + 1.6)) < 1e-9 && n.hi === 2.75);
});

test('a car with the build-out on its side: slows down, passes it in the gap without touching the bed', () => {
  const net = loop('right');
  const { traffic, player } = setUp(net);
  const fwd = net.lanes.edgeLanes[0].fwd[0];
  const car = traffic.addCar(fwd, 200);
  car.v = 12;
  let touched = false;
  let slowest = Infinity;
  run(
    traffic,
    player,
    60,
    () => car.lane !== fwd || car.s > 340,
    () => {
      if (bedTouched(net, car.x, car.z, car.yaw, car.length / 2, car.width / 2)) touched = true;
      if (car.x > AT - LEN / 2 - 3 && car.x < AT + LEN / 2) slowest = Math.min(slowest, car.v);
    },
  );
  assert.ok(car.x > 330, `got past (x ${car.x.toFixed(1)})`);
  assert.ok(!touched, 'never in the bed');
  assert.ok(slowest < 6.5 && slowest > 3, `about 20 km/h through it (${(slowest * 3.6).toFixed(0)} km/h)`);
});

test('§ 6 StVO: the car on the side of the build-out waits for the oncoming one; the oncoming one does not wait', () => {
  const net = loop('right');
  const { traffic, player } = setUp(net);
  const fwd = net.lanes.edgeLanes[0].fwd[0];
  const back = net.lanes.edgeLanes[0].back[0];
  const mine = traffic.addCar(fwd, 230);
  mine.v = 10;
  // (it comes to the gap just after this one has come to its line)
  const other: TrafficCar = traffic.addCar(back, along(back, 430));
  other.v = 10;
  const wait = along(fwd, AT - LEN / 2) - NARROW_WAIT;
  let stood = 0;
  let otherSlowest = Infinity;
  let both = false;
  let touched = false;
  run(
    traffic,
    player,
    90,
    () => mine.x > 330,
    () => {
      const front = mine.s + mine.length / 2;
      if (mine.lane === fwd && mine.v < 0.1 && front < wait + 0.5 && front > wait - 4) stood += DT;
      if (other.lane === back && other.x > AT - LEN / 2 - 4 && other.x < AT + 40) otherSlowest = Math.min(otherSlowest, other.v);
      // never both in the stretch of the bed at once
      const inMine = mine.x + mine.length / 2 > AT - LEN / 2 - 1 && mine.x - mine.length / 2 < AT + LEN / 2 + 1;
      const inOther = other.lane === back && other.x - other.length / 2 < AT + LEN / 2 + 1 && other.x + other.length / 2 > AT - LEN / 2 - 1;
      if (inMine && inOther) both = true;
      if (bedTouched(net, mine.x, mine.z, mine.yaw, mine.length / 2, mine.width / 2)) touched = true;
    },
  );
  assert.ok(stood > 0.5, `waited before the build-out (${stood.toFixed(1)} s)`);
  assert.ok(!both, 'one after the other through the gap');
  assert.ok(!touched, 'never in the bed');
  assert.ok(otherSlowest > 3, `the oncoming car went on (slowest ${(otherSlowest * 3.6).toFixed(0)} km/h)`);
  assert.ok(mine.x > 330, 'then through');
});

test('the build-out on the other side: the car goes on, the oncoming one waits', () => {
  const net = loop('left');
  const { traffic, player } = setUp(net);
  const fwd = net.lanes.edgeLanes[0].fwd[0];
  const back = net.lanes.edgeLanes[0].back[0];
  const mine = traffic.addCar(fwd, 250);
  mine.v = 10;
  const other = traffic.addCar(back, along(back, 340));
  other.v = 10;
  const otherWait = along(back, AT + LEN / 2) - NARROW_WAIT;
  let slowest = Infinity;
  let otherSlowest = Infinity;
  let both = false;
  run(
    traffic,
    player,
    60,
    () => mine.x > 330 && other.x < 270,
    () => {
      if (mine.x > AT - 40 && mine.x < AT + LEN / 2) slowest = Math.min(slowest, mine.v);
      // (before its line, while this one goes through)
      if (other.lane === back && other.s + other.length / 2 < otherWait + 0.5) otherSlowest = Math.min(otherSlowest, other.v);
      const inMine = mine.x + mine.length / 2 > AT - LEN / 2 - 1 && mine.x - mine.length / 2 < AT + LEN / 2 + 1;
      const inOther = other.lane === back && other.x - other.length / 2 < AT + LEN / 2 + 1 && other.x + other.length / 2 > AT - LEN / 2 - 1;
      if (inMine && inOther) both = true;
    },
  );
  assert.ok(slowest > 3, `did not wait (slowest ${(slowest * 3.6).toFixed(0)} km/h)`);
  assert.ok(otherSlowest < 1.5, `the oncoming car held back before its line (slowest ${(otherSlowest * 3.6).toFixed(0)} km/h)`);
  assert.ok(!both, 'one after the other through the gap');
  assert.ok(other.x < 270, 'then it went on');
});

test('the autopilot passes the build-out in the gap without a fault; the beds are solid for the player', () => {
  const net = loop('right');
  const { traffic, signals } = setUp(net);
  const rules = new RuleMonitor(net.world, net.lanes, signals, traffic);
  const v = new Vehicle(COMPACT_CAR_AUTOMATIC, new WorldGround(net.world, { heightAt: () => 100, coverAt: () => 0 }));
  // (on the right half of the road going +x: z > 0)
  v.teleport(200, 100.02, 1.375, -Math.PI / 2);
  v.resetDrivetrain(true);
  const FRONT = 2.2;
  const driver = new AutoDriver(net.world, signals, rules, traffic, {
    spec: COMPACT_CAR_AUTOMATIC,
    front: FRONT,
  });
  const mpos = new Float64Array(3);
  const H = 1 / 120;
  let touched = false;
  let slowest = Infinity;
  for (let t = 0; t < 120 && mpos[0] < 360; t += H) {
    v.getModelPosition(mpos);
    const cmd = driver.step(H, v, mpos, []);
    v.step(H, {
      steer: cmd.steer,
      throttle: cmd.throttle,
      brake: cmd.brake,
      clutch: 0,
      handbrake: 0,
      gear: 1,
      ignition: true,
      starter: false,
    });
    v.getModelPosition(mpos);
    const lane = rules.laneNow;
    traffic.update(H, {
      x: mpos[0],
      y: mpos[1],
      z: mpos[2],
      yaw: v.yaw,
      speed: v.speed,
      length: 4.28,
      width: 1.79,
      lane,
      s: lane ? rules.laneFront - 2.14 : 0,
    });
    rules.update(
      H,
      {
        x: mpos[0],
        y: mpos[1],
        z: mpos[2],
        yaw: v.yaw,
        speed: v.speed,
        indicator: cmd.indicator,
        hazard: false,
        lookYaw: cmd.look,
        seatbelt: true,
        handbrake: 0,
        stalled: false,
        hitScenery: 0,
        length: 4.28,
        front: FRONT,
      },
      traffic.events,
    );
    if (bedTouched(net, mpos[0], mpos[2], v.yaw, 2.14, 0.9)) touched = true;
    if (mpos[0] > AT - LEN / 2 - 2 && mpos[0] < AT + LEN / 2) slowest = Math.min(slowest, v.speed);
  }
  assert.ok(mpos[0] >= 360, `got through (x ${mpos[0].toFixed(0)})`);
  assert.ok(!touched, 'never in the bed');
  assert.ok(slowest < 7, `slowly through it (${(slowest * 3.6).toFixed(0)} km/h)`);
  assert.deepEqual(
    rules.log.map((x) => x.id),
    [],
  );
  // the collider: the bed's kerb and its beacon, not the gap
  const col = new SceneryCollider();
  narrowCollide(col, net.world.allEdges, true);
  assert.ok(col.blocked(AT, 100, 1.9, -Math.PI / 2, 0), 'on the bed');
  assert.ok(!col.blocked(AT, 100, -0.6, -Math.PI / 2, 0), 'in the gap');
  narrowCollide(col, net.world.allEdges, false);
  assert.ok(!col.blocked(AT, 100, 1.9, -Math.PI / 2, 0), 'taken out again');
});

test('§ 6 StVO for the player: into the narrowing on the side of the build-out while an oncoming car is in it is a minor fault', () => {
  const net = loop('right');
  const { traffic, signals } = setUp(net);
  const rules = new RuleMonitor(net.world, net.lanes, signals, traffic);
  const back = net.lanes.edgeLanes[0].back[0];
  // an oncoming car in the gap (it stays there)
  const other = traffic.addCar(back, along(back, AT + 1));
  other.crashed = 1000;
  other.v = 0;
  for (let s = 240; s < 300; s += 6 * DT) {
    const p: PlayerSnapshot = {
      x: s,
      y: 100,
      z: 1.375,
      yaw: -Math.PI / 2,
      speed: 6,
      indicator: 0,
      hazard: false,
      lookYaw: 0,
      seatbelt: true,
      handbrake: 0,
      stalled: false,
      hitScenery: 0,
      length: 4.3,
    };
    const lane = rules.laneNow;
    traffic.update(DT, {
      x: p.x,
      y: 100,
      z: p.z,
      yaw: p.yaw,
      speed: 6,
      length: 4.3,
      width: 1.8,
      lane,
      s: lane ? rules.laneFront - 2.15 : 0,
    });
    rules.update(DT, p, []);
  }
  const f = rules.log.find((v) => v.id === 'narrowYield');
  assert.ok(f, `(${rules.log.map((v) => v.id).join(', ')})`);
  assert.equal(f.severity, 'minor');
});
