// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Level crossings (src/world/levelxing.ts, src/sim/levelcrossing.ts): what
 * a crossing is equipped with (the map's tags, else a guess from the road);
 * a train switches it on – the lights 9 s before the barriers move, the
 * barriers down before it is there, up again after it has passed – and a
 * train that comes to one not yet secured waits before it; the cars of the
 * traffic wait before the cross while it is closed, and never stop on the
 * tracks when there is no room behind them (§ 19 Abs. 3 StVO); the
 * autopilot stops before it too; the player's faults; the two theory
 * lessons.
 *
 *   node --test tests/sim/levelcrossing.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { angleOf } from '../../src/core/geom.ts';
import { THEORY, corners, lightAt, newPose, poseAt, prepare } from '../../src/game/theory.ts';
import { AutoDriver } from '../../src/sim/autodriver.ts';
import { WorldGround } from '../../src/sim/ground.ts';
import { LX, LevelCrossings, entryOf, exitOf } from '../../src/sim/levelcrossing.ts';
import type { LevelCrossing, Phase } from '../../src/sim/levelcrossing.ts';
import { RailTraffic } from '../../src/sim/rail.ts';
import { RuleMonitor } from '../../src/sim/rules.ts';
import type { PlayerSnapshot } from '../../src/sim/rules.ts';
import { SignalSystem } from '../../src/sim/signals.ts';
import { Traffic } from '../../src/sim/traffic.ts';
import type { PlayerState } from '../../src/sim/traffic.ts';
import { COMPACT_CAR_AUTOMATIC, Vehicle } from '../../src/sim/vehicle/index.ts';
import { LaneGraph } from '../../src/world/lanes.ts';
import type { Lane } from '../../src/world/lanes.ts';
import { equipmentFor, taggedAt } from '../../src/world/levelxing.ts';
import { CLS, CTRL, EF, RAIL, ROLE, XING } from '../../src/world/types.ts';
import type { EdgeJson, NodeJson, WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts } from '../../src/world/world.ts';

const DT = 1 / 20;
/** the track crosses the first road 300 m along it */
const AT = 300;

interface Net {
  world: World;
  lanes: LaneGraph;
}

/** Four roads round a block of 600 × 150 m (the first: z = 0, x 0 → 600), a railway crossing the first at x = 300. */
function loop(cls: number): Net {
  const pts: Array<[number, number]> = [
    [0, 0],
    [600, 0],
    [600, 150],
    [0, 150],
  ];
  const nodes: NodeJson[] = pts.map(([x, z]) => ({ x, y: 100, z, t: CTRL.NONE, arms: [] }));
  const edges: EdgeJson[] = [0, 1, 2, 3].map((i) => {
    const A = nodes[i];
    const B = nodes[(i + 1) % 4];
    const p: number[] = [];
    const n = Math.max(1, Math.round(Math.hypot(B.x - A.x, B.z - A.z) / 20));
    for (let k = 0; k <= n; k++) p.push(A.x + ((B.x - A.x) * k) / n, 100, A.z + ((B.z - A.z) * k) / n);
    return { a: i, b: (i + 1) % 4, c: i === 0 ? cls : CLS.RESIDENTIAL, n: `Road ${i}`, p, lf: 1, lb: 1, lw: 2.75, w: 5.5, mf: 50, mb: 50, f: EF.URBAN, ca: 0, cb: 0 };
  });
  nodes.forEach((node, ni) => {
    node.arms = edges
      .map((e, ei) => ({ e: ei, ok: e.a === ni || e.b === ni, other: nodes[e.a === ni ? e.b : e.a] }))
      .filter((a) => a.ok)
      .map((a) => ({ e: a.e, ang: angleOf(a.other.x - node.x, a.other.z - node.z) }))
      .sort((p, q) => p.ang - q.ang)
      .map((a) => ({ e: a.e, r: ROLE.NONE }));
  });
  const json: WorldJson = {
    version: 1,
    meta: { name: 'Test roads', generated: '', minX: -3000, maxX: 3000, minZ: -3000, maxZ: 3000, tileSize: 500, originE: 0, originN: 0, attribution: [] },
    nodes,
    edges,
    banned: [],
    signals: [],
    crossings: [{ e: 0, s: AT, k: XING.RAIL, w: 6 }],
    places: [],
    spawns: [],
    tiles: [],
  };
  computeAllCuts(json);
  const world = new World(json);
  return { world, lanes: new LaneGraph(world) };
}

/** A straight railway north–south through x = 300 (z −1500 … 1500): a train on it in direction +1 runs south. */
function track(): RailTraffic {
  const p: number[] = [];
  for (let z = -1500; z <= 1500; z += 5) p.push(AT, 100, z);
  const rail = new RailTraffic([{ k: RAIL.TRAIN, p, a: [], b: [] }], () => 0.5);
  rail.target = 0;
  return rail;
}

/** where the player stands while it only watches: beside the road, off the tracks */
const watcher: PlayerState = { x: 250, y: 100, z: 40, yaw: 0, speed: 0, length: 4.3, width: 1.8 };

const along = (lane: Lane, s: number): number => (s - lane.s0) * lane.dir;

function setUp(cls: number = CLS.TERTIARY): { net: Net; traffic: Traffic; signals: SignalSystem; lx: LevelCrossings; c: LevelCrossing } {
  const net = loop(cls);
  const signals = new SignalSystem(net.world.signals);
  const traffic = new Traffic(net.world, net.lanes, signals);
  traffic.targetCount = 0;
  traffic.spawnRadius = 5000;
  const lx = new LevelCrossings(net.world, traffic);
  traffic.levelCrossings = lx;
  lx.refresh();
  return { net, traffic, signals, lx, c: lx.list[0] };
}

/** Hold an installation in one phase (the trains do not count). */
function hold(lx: LevelCrossings, phase: Phase): void {
  lx.step = (c) => {
    c.phase = phase;
    c.t = 10;
    c.lower = phase === 'closed' ? 1 : 0;
  };
}

test('what a crossing has: the map\'s tags where it has them, else a guess from the road', () => {
  // (no tags where the test's crossing lies)
  assert.equal(taggedAt(AT, 0), null);
  // the crossings of the line through Baunatal: half barriers with lights; one with full barriers
  const half = equipmentFor(-230, 97, true, 3);
  assert.deepEqual([half.barrier, half.light, half.mapped], ['half', 'yellowRed', true]);
  assert.equal(equipmentFor(983, -28, true, 2).barrier, 'full');
  // the guesses: barriers and lights on the main roads, the flashing light on the small ones, the cross only on tracks; the trams' nothing
  assert.deepEqual([equipmentFor(AT, 0, true, 3).barrier, equipmentFor(AT, 0, true, 3).light], ['half', 'yellowRed']);
  assert.deepEqual([equipmentFor(AT, 0, true, 2).barrier, equipmentFor(AT, 0, true, 2).light], ['none', 'blink']);
  assert.equal(equipmentFor(AT, 0, true, 0).light, 'none');
  assert.equal(equipmentFor(AT, 0, false, 4).light, 'none');
});

test('one installation per road and tracks; the track found; the cross, stop point and danger area where they belong', () => {
  const { lx, c } = setUp();
  lx.setRail(track());
  assert.equal(lx.list.length, 1);
  assert.equal(c.hits.length, 1);
  assert.ok(Math.abs(c.hits[0].s - 1500) < 0.5, `the track at the road (${c.hits[0].s.toFixed(1)})`);
  assert.equal(entryOf(c, 1), AT - LX.CROSS);
  assert.equal(exitOf(c, 1), AT + LX.ZONE);
  assert.equal(entryOf(c, -1), AT + LX.CROSS);
});

test('a train switches it on: lights 9 s before the barriers move, down before it comes, up after it has gone', () => {
  const { lx, c } = setUp();
  const rail = track();
  lx.setRail(rail);
  // 700 m before the crossing at 22 m/s
  const v = rail.spawnAt(0, 800, 1, 22)!;
  assert.ok(v);
  const at: Record<string, number> = {};
  let t = 0;
  let wasOpen = false;
  for (; t < 90; t += DT) {
    lx.update(DT, watcher.x, watcher.z);
    rail.update(DT, watcher);
    if (!(c.phase in at)) at[c.phase] = t;
    if (c.occupied && at.occupied === undefined) at.occupied = t;
    if (at.raising !== undefined && c.phase === 'open') {
      wasOpen = true;
      break;
    }
  }
  assert.ok(at.yellow !== undefined && at.red !== undefined && at.lowering !== undefined && at.closed !== undefined, JSON.stringify(at));
  const lead = at.lowering - at.yellow;
  assert.ok(lead >= 8 && lead <= 10, `the lights ${lead.toFixed(1)} s before the barriers move`);
  assert.ok(at.closed < at.occupied - 1, `down (${at.closed.toFixed(1)} s) before the train is there (${at.occupied.toFixed(1)} s)`);
  assert.ok(at.raising > at.occupied, 'up only after it came');
  assert.ok(wasOpen, 'open again');
  assert.ok(!c.occupied, 'the train has left the crossing');
});

test('a train that comes to a crossing not yet secured slows down before it until the barriers are down, then goes over', () => {
  const { lx, c } = setUp();
  const rail = track();
  lx.setRail(rail);
  // 120 m before it at 10 m/s: there before the barriers are down (they take 15 s), but able to stop
  const v = rail.spawnAt(0, 1380, 1, 10)!;
  let overOpen = false;
  let slowest = Infinity;
  for (let t = 0; t < 80; t += DT) {
    lx.update(DT, watcher.x, watcher.z);
    rail.update(DT, watcher);
    if (c.occupied && c.phase !== 'closed') overOpen = true;
    const front = v.s;
    if (front < 1500 - 5 && front > 1420) slowest = Math.min(slowest, v.speed);
    if (front > 1650) break;
  }
  assert.ok(slowest < 2, `it all but stopped before the crossing (${slowest.toFixed(1)} m/s)`);
  assert.ok(!overOpen, 'never on the crossing with the barriers up');
  assert.ok(v.s > 1600, `then went on (front at ${v.s.toFixed(0)})`);
});

test('a car of the traffic waits before the cross while the barriers are down, then goes over', () => {
  const { net, traffic, lx } = setUp();
  hold(lx, 'closed');
  const fwd = net.lanes.edgeLanes[0].fwd[0];
  const car = traffic.addCar(fwd, along(fwd, 200));
  car.v = 12;
  const stop = along(fwd, AT - LX.STOP);
  let furthest = 0;
  for (let t = 0; t < 30; t += DT) {
    traffic.update(DT, watcher);
    if (car.lane === fwd) furthest = Math.max(furthest, car.s + car.length / 2);
  }
  assert.ok(furthest <= stop + 0.6 && furthest > stop - 3, `front stopped at ${furthest.toFixed(1)} (stop point ${stop})`);
  assert.ok(car.v < 0.2, 'standing');
  hold(lx, 'open');
  for (let t = 0; t < 30 && car.lane === fwd; t += DT) traffic.update(DT, watcher);
  assert.ok(car.lane !== fwd || car.s > along(fwd, AT + 20), 'then over');
});

test('§ 19 Abs. 3 StVO: with no room behind the tracks a car waits before the cross, not on the rails', () => {
  const { net, traffic, lx } = setUp();
  hold(lx, 'open');
  const fwd = net.lanes.edgeLanes[0].fwd[0];
  // the player stands in the queue beyond the tracks: its rear 2 m past the danger area – too little room for a car
  const rearAt = AT + LX.ZONE + 2;
  const player: PlayerState = { x: rearAt + 2.15, y: 100, z: 1.375, yaw: -Math.PI / 2, speed: 0, length: 4.3, width: 1.8, lane: fwd, s: along(fwd, rearAt + 2.15) };
  const car = traffic.addCar(fwd, along(fwd, 220));
  car.v = 11;
  let deepest = 0;
  for (let t = 0; t < 30; t += DT) {
    traffic.update(DT, player);
    if (car.lane === fwd) deepest = Math.max(deepest, car.s + car.length / 2);
  }
  const stop = along(fwd, AT - LX.STOP);
  assert.ok(deepest <= stop + 0.6, `never onto the tracks (front at most ${deepest.toFixed(1)}, stop point ${stop})`);
  assert.ok(car.v < 0.2, 'waiting');
  // the queue moves off: room again
  const gone: PlayerState = { ...watcher };
  for (let t = 0; t < 20 && car.lane === fwd && car.s < along(fwd, AT + 20); t += DT) traffic.update(DT, gone);
  assert.ok(car.lane !== fwd || car.s > along(fwd, AT + 10), 'then over');
});

test('the autopilot stops before the cross while the lights are red, and makes no fault', () => {
  const { net, traffic, signals, lx } = setUp();
  hold(lx, 'red');
  const rules = new RuleMonitor(net.world, net.lanes, signals, traffic);
  const v = new Vehicle(COMPACT_CAR_AUTOMATIC, new WorldGround(net.world, { heightAt: () => 100, coverAt: () => 0 }));
  v.teleport(220, 100.02, 1.375, -Math.PI / 2);
  v.resetDrivetrain(true);
  const FRONT = 2.2;
  const driver = new AutoDriver(net.world, signals, rules, traffic, { spec: COMPACT_CAR_AUTOMATIC, front: FRONT });
  const mpos = new Float64Array(3);
  const H = 1 / 60;
  let furthest = 0;
  const drive = (secs: number): void => {
    for (let t = 0; t < secs; t += H) {
      v.getModelPosition(mpos);
      const cmd = driver.step(H, v, mpos, []);
      v.step(H, { steer: cmd.steer, throttle: cmd.throttle, brake: cmd.brake, clutch: 0, handbrake: 0, gear: 1, ignition: true, starter: false });
      v.getModelPosition(mpos);
      furthest = Math.max(furthest, mpos[0] + FRONT);
      const lane = rules.laneNow;
      traffic.update(H, { x: mpos[0], y: mpos[1], z: mpos[2], yaw: v.yaw, speed: v.speed, length: 4.28, width: 1.79, lane, s: lane ? rules.laneFront - 2.14 : 0 });
      rules.update(H, { x: mpos[0], y: mpos[1], z: mpos[2], yaw: v.yaw, speed: v.speed, indicator: cmd.indicator, hazard: false, lookYaw: cmd.look, seatbelt: true, handbrake: 0, stalled: false, hitScenery: 0, length: 4.28, front: FRONT }, traffic.events);
    }
  };
  drive(25);
  assert.ok(furthest < AT - LX.CROSS + 0.5, `stopped before the cross (front at most ${furthest.toFixed(1)})`);
  assert.ok(Math.abs(v.speed) < 0.2, 'standing');
  hold(lx, 'open');
  drive(15);
  assert.ok(mpos[0] > AT + 10, `then over (x ${mpos[0].toFixed(0)})`);
  assert.deepEqual(
    rules.log.map((x) => x.id).filter((id) => id.startsWith('levelCrossing')),
    [],
  );
});

/** The player's car moved along the first road (z: its lane; + x is east), the rule monitor watching. */
function drivePlayer(net: Net, traffic: Traffic, rules: RuleMonitor, x0: number, x1: number, speed: number, z = 1.375, secs = 0): void {
  const step = (x: number, v: number): void => {
    const p: PlayerSnapshot = { x, y: 100, z, yaw: -Math.PI / 2, speed: v, indicator: 0, hazard: false, lookYaw: 0, seatbelt: true, handbrake: 0, stalled: false, hitScenery: 0, length: 4.3 };
    const lane = rules.laneNow;
    traffic.update(DT, { x, y: 100, z, yaw: p.yaw, speed: v, length: 4.3, width: 1.8, lane, s: lane ? rules.laneFront - 2.15 : 0 });
    rules.update(DT, p, traffic.events);
  };
  if (speed > 0) for (let x = x0; x < x1; x += speed * DT) step(x, speed);
  else for (let t = 0; t < secs; t += DT) step(x0, 0);
  void net;
}

test('the player\'s faults: over on red, at closed barriers, stopped on the tracks, overtaking before it, too fast where there are no barriers', () => {
  const faults = (phase: Phase, run: (s: ReturnType<typeof setUp>, rules: RuleMonitor) => void, cls: number = CLS.TERTIARY): string[] => {
    const s = setUp(cls);
    hold(s.lx, phase);
    const rules = new RuleMonitor(s.net.world, s.net.lanes, s.signals, s.traffic);
    run(s, rules);
    return rules.log.map((v) => `${v.id}:${v.severity}`).filter((id) => id.startsWith('levelCrossing'));
  };
  assert.deepEqual(faults('red', (s, r) => drivePlayer(s.net, s.traffic, r, 270, 330, 8)), ['levelCrossingRed:major']);
  assert.deepEqual(faults('closed', (s, r) => drivePlayer(s.net, s.traffic, r, 270, 330, 8)), ['levelCrossingBarrier:major']);
  assert.deepEqual(faults('open', (s, r) => drivePlayer(s.net, s.traffic, r, 270, 330, 8)), []);
  assert.deepEqual(faults('open', (s, r) => drivePlayer(s.net, s.traffic, r, AT, AT, 0, 1.375, 4)), ['levelCrossingStop:major']);
  // a car of the traffic ahead in the zone of the warning sign, passed on the other side of the road
  assert.deepEqual(
    faults('open', (s, r) => {
      const fwd = s.net.lanes.edgeLanes[0].fwd[0];
      const car = s.traffic.addCar(fwd, along(fwd, 240));
      car.v = 4;
      car.temper = 4 / 13.9;
      drivePlayer(s.net, s.traffic, r, 215, 290, 13, -1.375);
    }),
    ['levelCrossingOvertake:major'],
  );
  // a residential road: the flashing light, no barriers – 80 km/h over it is too fast
  assert.deepEqual(faults('open', (s, r) => drivePlayer(s.net, s.traffic, r, 240, 330, 22), CLS.RESIDENTIAL), ['levelCrossingSpeed:minor']);
});

test('the two theory lessons: you wait at the line while the lights are on, and never stand on the rails', () => {
  for (const id of ['levelCrossing', 'levelCrossingQueue']) {
    const lesson = THEORY.find((l) => l.id === id);
    assert.ok(lesson, id);
    const scene = prepare(lesson);
    const me = scene.actors.find((a) => a.def.id === 'me')!;
    const others = scene.actors.filter((a) => a.def.kind === 'car');
    const p = newPose();
    const q = newPose();
    for (let t = 0; t <= lesson.end; t += 0.05) {
      poseAt(me, t, p);
      const c = corners(me, p);
      const front = Math.min(c[1], c[3], c[5], c[7]);
      const back = Math.max(c[1], c[3], c[5], c[7]);
      const lit = lightAt(scene, 'lx', t) !== 'O';
      // (with the lights on: the nose stays at the stop line, 4.75 m before the track)
      if (lit) assert.ok(front >= 4.7 || back < -LX.ZONE, `${id} at ${t.toFixed(2)}: past the line on ${lightAt(scene, 'lx', t)}`);
      // over the danger area only with room for the whole car beyond it
      if (front < LX.ZONE && back > -LX.ZONE) {
        for (const o of others) {
          poseAt(o, t, q);
          if (!q.visible) continue;
          const oc = corners(o, q);
          const rear = Math.max(oc[1], oc[3], oc[5], oc[7]);
          if (rear < 0) assert.ok(rear < -LX.ZONE - 4.28 - 1, `${id} at ${t.toFixed(2)}: onto the tracks with ${o.def.id} only ${(-rear - LX.ZONE).toFixed(1)} m beyond them`);
        }
      }
    }
    assert.ok(lesson.steps.every((s) => s.ref.includes('§ 19')), `${id}: the rule is § 19 StVO`);
  }
});
