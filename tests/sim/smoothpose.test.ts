// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The cars of the traffic turn and move smoothly (src/sim/smoothpose.ts):
 * through a corner of their way drawn as a few straight pieces they turn a
 * little on each picture – not 15° on one and 30° on the next –, they keep
 * to their lane, and their front wheels are steered into the turn.  (What
 * the simulation reckons with stays where their way puts them.)
 *
 *   node --test tests/sim/smoothpose.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { angleOf, makePolyline, newPolySample, samplePolyline } from '../../src/core/geom.ts';
import { chordYawOn, easePose, wrapAngle } from '../../src/sim/smoothpose.ts';
import type { EasedPose } from '../../src/sim/smoothpose.ts';
import { SignalSystem } from '../../src/sim/signals.ts';
import { Traffic } from '../../src/sim/traffic.ts';
import type { PlayerState } from '../../src/sim/traffic.ts';
import { LaneGraph, lanePoint } from '../../src/world/lanes.ts';
import { CLS, CTRL, EF, ROLE } from '../../src/world/types.ts';
import type { EdgeJson, NodeJson, WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts } from '../../src/world/world.ts';

const DEG = 180 / Math.PI;

/** a quarter circle of radius r turning right from heading north, drawn as `n` straight pieces – as a path through a junction is */
function coarseArc(r: number, n: number): ReturnType<typeof makePolyline> {
  const pts: number[] = [];
  // (going north = −z, turning right towards east = +x round the centre (r, 0))
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI / 2) * (i / n);
    pts.push(r - r * Math.cos(a), 0, -r * Math.sin(a));
  }
  // straight on east for a while
  pts.push(r + 20, 0, -r);
  return makePolyline(Float64Array.from(pts));
}

test('through a coarse corner the heading turns a little each picture, the wheels steered right', () => {
  const pl = coarseArc(8, 5);
  const dt = 1 / 60;
  const v = 8;
  const s0 = newPolySample();
  samplePolyline(pl, 0, s0);
  const p: EasedPose = { x: s0.x, z: s0.z, yaw: Math.atan2(-s0.tx, -s0.tz) };
  let rawMax = 0;
  let maxStep = 0;
  let maxOff = 0;
  let minSteer = 0;
  let rawPrev = p.yaw;
  for (let s = v * dt; s < pl.len - 2; s += v * dt) {
    samplePolyline(pl, s, s0);
    const raw = Math.atan2(-s0.tx, -s0.tz);
    rawMax = Math.max(rawMax, Math.abs(wrapAngle(raw - rawPrev)));
    rawPrev = raw;
    const before = p.yaw;
    easePose(p, s0.x, s0.z, chordYawOn(pl, s, 1.2), 0, v * dt, dt, 2.6);
    maxStep = Math.max(maxStep, Math.abs(wrapAngle(p.yaw - before)));
    maxOff = Math.max(maxOff, Math.hypot(p.x - s0.x, p.z - s0.z));
    minSteer = Math.min(minSteer, -(p.steer ?? 0));
  }
  // the line itself turns by 18° at each corner of it: drawn, by a few degrees a picture at most
  assert.ok(rawMax * DEG > 15, `the line turns ${rawMax * DEG}° at a corner`);
  assert.ok(maxStep * DEG < 3.5, `turned by ${maxStep * DEG}° in one picture`);
  // it stays on its way (within a few centimetres), turned towards the end
  assert.ok(maxOff < 0.25, `${maxOff} m off its way`);
  assert.ok(Math.abs(wrapAngle(p.yaw + Math.PI / 2)) < 0.05, `facing ${p.yaw * DEG}° at the end`);
  // the front wheels were turned to the right (+ right): about atan(2.6 / 8) ≈ 18°
  assert.ok(-minSteer * DEG > 10 && -minSteer * DEG < 30, `steered ${-minSteer * DEG}°`);
});

test('a sideways jump of its way becomes a drift; a jump of many metres is taken at once', () => {
  const p: EasedPose = { x: 0, z: 0, yaw: 0 };
  const dt = 1 / 60;
  // (driving north at 10 m/s, the way suddenly 0.5 m to the right)
  let z = 0;
  let maxMove = 0;
  for (let i = 0; i < 60; i++) {
    z -= 10 * dt;
    const x0 = p.x;
    easePose(p, 0.5, z, 0, 0, 10 * dt, dt, 2.6);
    maxMove = Math.max(maxMove, Math.abs(p.x - x0));
  }
  assert.ok(maxMove < 0.12, `moved sideways by ${maxMove} m in one picture`);
  assert.ok(Math.abs(p.x - 0.5) < 0.01, `not there after a second: ${p.x}`);
  easePose(p, 30, z, 0, 0, 0, dt, 2.6);
  assert.equal(p.x, 30);
});

test('standing still it neither turns nor moves its wheels', () => {
  const p: EasedPose = { x: 0, z: 0, yaw: 0.3, steer: 0.2 };
  for (let i = 0; i < 30; i++) easePose(p, 0, 0, 0.3, 0, 0, 1 / 60, 2.6);
  assert.equal(p.steer, 0.2);
  assert.ok(Math.abs(p.yaw - 0.3) < 1e-9);
});

// ------------------------------------------------------------- a car of the traffic round a corner

/** Straight roads between points (y = 100) – as tests/sim/queues.test.ts makes them. */
function makeNet(points: Array<[number, number]>, roads: Array<[number, number]>): { world: World; lanes: LaneGraph } {
  const nodes: NodeJson[] = points.map(([x, z]) => ({ x, y: 100, z, t: CTRL.NONE, arms: [] }));
  const edges: EdgeJson[] = roads.map(([a, b], i) => {
    const A = nodes[a];
    const B = nodes[b];
    const p: number[] = [];
    const n = Math.max(1, Math.round(Math.hypot(B.x - A.x, B.z - A.z) / 20));
    for (let k = 0; k <= n; k++) p.push(A.x + ((B.x - A.x) * k) / n, 100, A.z + ((B.z - A.z) * k) / n);
    return { a, b, c: CLS.SECONDARY, n: `Road ${i}`, p, lf: 1, lb: 1, lw: 3.2, w: 6.4, mf: 50, mb: 50, f: EF.URBAN, ca: 0, cb: 0 };
  });
  nodes.forEach((node, ni) => {
    const arms: Array<{ e: number; ang: number }> = [];
    edges.forEach((e, ei) => {
      if (e.a !== ni && e.b !== ni) return;
      const other = nodes[e.a === ni ? e.b : e.a];
      arms.push({ e: ei, ang: angleOf(other.x - node.x, other.z - node.z) });
    });
    arms.sort((p, q) => p.ang - q.ang);
    node.arms = arms.map((a) => ({ e: a.e, r: ROLE.NONE }));
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

test('a car of the traffic drives round the corners of a square smoothly, in its lane', () => {
  const net = makeNet(
    [
      [0, 0],
      [300, 0],
      [300, 200],
      [0, 200],
    ],
    [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ],
  );
  const traffic = new Traffic(net.world, net.lanes, new SignalSystem([]));
  traffic.targetCount = 0;
  const lane = net.lanes.edgeLanes[0].fwd[0];
  const car = traffic.addCar(lane, 200);
  const away: PlayerState = { x: 150, y: 160, z: 100, yaw: 0, speed: 0, length: 4.3, width: 1.8 };
  const dt = 1 / 60;
  const raw = newPolySample();
  let maxStep = 0;
  let maxOff = 0;
  let turned = 0;
  let steered = 0;
  for (let i = 0; i < 60 * 90; i++) {
    const before = car.drawn?.yaw ?? car.yaw;
    traffic.update(dt, away);
    if (traffic.cars[0] !== car) break;
    const p = car.drawn;
    assert.ok(p, 'it is drawn eased');
    const d = wrapAngle(p.yaw - before);
    maxStep = Math.max(maxStep, Math.abs(d));
    turned += Math.abs(d);
    steered = Math.max(steered, Math.abs(p.steer ?? 0));
    // where its way puts it: the lane or the path through the junction
    if (car.conn) samplePolyline(car.conn.pl, car.s, raw);
    else if (car.lane) lanePoint(car.lane, car.s, raw);
    maxOff = Math.max(maxOff, Math.hypot(p.x - raw.x, p.z - raw.z));
    // (the simulation itself reckons with where its way puts it)
    assert.ok(Math.hypot(car.x - raw.x, car.z - raw.z) < 1e-6 || car.slide || car.side);
  }
  assert.ok(turned * DEG > 170, `it went round at least two corners (turned ${turned * DEG}°)`);
  assert.ok(maxStep * DEG < 4, `turned by ${maxStep * DEG}° in one picture`);
  assert.ok(maxOff < 0.4, `${maxOff} m off its way`);
  assert.ok(steered > 0.1, `its wheels were steered (${steered} rad)`);
});
