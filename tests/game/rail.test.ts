// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trams and trains on the tracks of the map: they follow the track through
 * switches, keep right on a double track, call at stops, brake for what is
 * on the track, turn back at the end of the line.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CONSISTS, RailNetwork, RailTraffic, boxOverlap } from '../../src/sim/rail.ts';
import type { RailPlayer, RailVehicle } from '../../src/sim/rail.ts';
import { RAIL } from '../../src/world/types.ts';
import type { RailJson } from '../../src/world/types.ts';

/** A straight piece of track from (x0, z0) to (x1, z1), a point every 5 m. */
function piece(x0: number, z0: number, x1: number, z1: number, more: Partial<RailJson> = {}): RailJson {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / 5));
  const p: number[] = [];
  for (let i = 0; i <= n; i++) p.push(x0 + ((x1 - x0) * i) / n, 100, z0 + ((z1 - z0) * i) / n);
  return { k: RAIL.TRAM, p, a: [], b: [], ...more };
}

const far: RailPlayer = { x: 5000, y: 100, z: 5000, yaw: 0, length: 4.3, width: 1.8 };
const seeded = (): (() => number) => {
  let s = 12345;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
};
/** run the traffic for some seconds (no spawning: the test puts the vehicles) */
function run(t: RailTraffic, seconds: number, player = far, each?: () => void): void {
  t.target = 0;
  t.far = 1e9;
  for (let i = 0; i < seconds * 50; i++) {
    t.update(0.02, player);
    each?.();
  }
}
const frontOf = (v: RailVehicle): { x: number; z: number } => {
  const c = v.cars[0];
  const half = v.consist.carLen / 2;
  return { x: c.x - Math.sin(c.yaw) * half, z: c.z - Math.cos(c.yaw) * half };
};

test('a tram runs along the track, its cars in a row behind the front end', () => {
  // 600 m northwards (z falls)
  const t = new RailTraffic([piece(0, 0, 0, -600)], seeded());
  const v = t.spawnAt(0, 100, 1)!;
  assert.ok(v, 'the tram fits on the track');
  assert.equal(v.cars.length, 3);
  const c = CONSISTS[RAIL.TRAM];
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(v.cars[i].x) < 0.01, 'on the track');
    assert.ok(Math.abs(v.cars[i].yaw) < 0.01, 'facing north');
    assert.ok(Math.abs(v.cars[i].z - (-100 + c.carLen / 2 + i * (c.carLen + c.gap))) < 0.3, `car ${i} at ${v.cars[i].z}`);
  }
  run(t, 30);
  assert.ok(v.speed > 12 && v.speed <= c.vmax + 1e-6, `at speed: ${v.speed}`);
  assert.ok(frontOf(v).z < -300, `moved on: ${frontOf(v).z}`);
  const gap = v.cars[1].z - v.cars[0].z;
  assert.ok(Math.abs(gap - (c.carLen + c.gap)) < 0.2, `cars stay coupled while moving: ${gap}`);
  assert.equal(t.spawnAt(0, 5, 1), null, 'no room behind the front end: no tram');
});

test('it calls at a stop once and goes on', () => {
  const t = new RailTraffic([piece(0, 0, 0, -800, { st: [300, 310] })], seeded());
  const v = t.spawnAt(0, 100, 1)!;
  let stood = 0;
  let stoppedAt = 0;
  let stops = 0;
  let was = false;
  run(t, 90, far, () => {
    const standing = v.dwell > 0;
    if (standing) {
      stood += 0.02;
      stoppedAt = v.s;
    }
    if (standing && !was) stops++;
    was = standing;
  });
  assert.equal(stops, 1, 'two marks of the same stop are served once');
  assert.ok(Math.abs(stoppedAt - 300) < 2, `stood at the stop: ${stoppedAt}`);
  assert.ok(stood > 11 && stood < 21, `for a while: ${stood}`);
  assert.ok(v.s > 450, `and went on: ${v.s}`);
});

test('it slows down for a curve', () => {
  // straight on, then a bend of 90° with a radius of 25 m, then straight on
  const p: number[] = [];
  for (let z = 0; z >= -200; z -= 5) p.push(0, 100, z);
  for (let a = 5; a <= 90; a += 5) p.push(25 - 25 * Math.cos((a * Math.PI) / 180), 100, -200 - 25 * Math.sin((a * Math.PI) / 180));
  for (let x = 30; x <= 300; x += 5) p.push(x, 100, -225);
  const t = new RailTraffic([{ k: RAIL.TRAM, p, a: [], b: [] }], seeded());
  const v = t.spawnAt(0, 60, 1)!;
  let inBend = Infinity;
  let top = 0;
  run(t, 40, far, () => {
    top = Math.max(top, v.speed);
    if (v.s > 205 && v.s < 235) inBend = Math.min(inBend, v.speed);
  });
  assert.ok(top > 10, `fast on the straight: ${top}`);
  assert.ok(inBend < 6.5, `slow in the bend: ${inBend}`);
  assert.ok(v.s > 300, 'through the bend');
  const last = v.cars[2];
  assert.ok(Math.abs(last.z + 225) < 0.6, `the last car follows round the bend: ${last.z}`);
});

test('switches: straight on or the gentle branch, never across a crossing track', () => {
  const rails: RailJson[] = [
    piece(0, 0, 0, -200, { b: [2, 4, 6] }), // 0: comes to a node
    piece(0, -200, 0, -500, { a: [1, 4, 6] }), // 1: straight on
    piece(0, -200, 60, -400, { a: [1, 2, 6] }), // 2: branches off at about 17°
    piece(0, -200, 200, -200, { a: [1, 2, 4] }), // 3: crosses at 90°
  ];
  const net = new RailNetwork(rails);
  const ways = net.waysOn(0, 1, [RAIL.TRAM]);
  assert.deepEqual(ways.map((w) => w.path), [1, 2], 'straight first, then the branch; the crossing track is no way on');
  assert.deepEqual(net.waysOn(1, -1, [RAIL.TRAM]).map((w) => [w.path, w.dir]), [[0, -1]], 'coming back, the only way on is the stem, run against its direction');
  assert.deepEqual(net.waysOn(0, 1, [RAIL.TRAIN]), [], 'a train does not take tram tracks');
  const taken = new Set<number>();
  for (let k = 0; k < 12; k++) {
    const t = new RailTraffic(rails, () => (k % 4 === 0 ? 0.1 : 0.9));
    const v = t.spawnAt(0, 80, 1)!;
    run(t, 22);
    taken.add(v.path);
  }
  assert.deepEqual([...taken].sort(), [1, 2], 'both ways on are used, the crossing track never');
});

test('double track: keep right', () => {
  // two tracks 3 m apart, both drawn northwards: only the eastern one is run that way
  const net = new RailNetwork([piece(0, 0, 0, -300), piece(3, 0, 3, -300), piece(500, 0, 500, -300)]);
  assert.equal(net.paths[1].way, 1, 'the right-hand track of the pair is run as drawn');
  assert.equal(net.paths[0].way, -1, 'the left-hand one against the way it was drawn');
  assert.equal(net.paths[2].way, 0, 'a single track is run both ways');
});

test('it brakes for a car on the track and goes on when the track is clear', () => {
  const t = new RailTraffic([piece(0, 0, 0, -600)], seeded());
  const v = t.spawnAt(0, 100, 1)!;
  // the player's car stands across the track 150 m ahead
  const player: RailPlayer = { x: 0.3, y: 100, z: -250, yaw: Math.PI / 2, length: 4.3, width: 1.8 };
  run(t, 40, player);
  assert.equal(v.speed, 0, 'stopped');
  assert.equal(v.blocked, true);
  const gap = frontOf(v).z - player.z;
  assert.ok(gap > 2 && gap < 9, `a few metres before the car: ${gap}`);
  assert.equal(t.touching(player), null, 'without touching it');
  run(t, 15, far);
  assert.ok(v.speed > 5 && frontOf(v).z < -260, 'on its way again');
});

test('the end of the line: wait, then back the way it came', () => {
  const t = new RailTraffic([piece(0, 0, 0, -300)], seeded());
  const v = t.spawnAt(0, 200, 1)!;
  run(t, 30);
  assert.equal(v.dir, -1, 'at the end the rear end became the front end');
  assert.ok(v.dwell > 0 && v.speed === 0, 'and it waits there');
  for (const c of v.cars) assert.ok(c.z > -300.5, 'not beyond the end of the track');
  // the wait is over after half a minute at most; then some seconds of running back
  run(t, 40);
  assert.equal(v.dir, -1);
  assert.ok(v.speed > 3, `running back: ${v.speed}`);
  assert.ok(v.s < 250, `away from the end: ${v.s}`);
  assert.ok(Math.abs(v.cars[0].yaw - Math.PI) < 0.05 || Math.abs(v.cars[0].yaw + Math.PI) < 0.05, `facing south now: ${v.cars[0].yaw}`);
  for (const c of v.cars) assert.ok(Math.abs(c.x) < 0.01 && c.z < 0.5 && c.z > -300.5, 'still on the track');
});

test('touching a tram: pushed clear sideways', () => {
  const t = new RailTraffic([piece(0, 0, 0, -600)], seeded());
  const v = t.spawnAt(0, 100, 1)!;
  const c = v.cars[1];
  const hit = t.touching({ x: c.x + 1.6, y: 100, z: c.z, yaw: 0, length: 4.3, width: 1.8 });
  assert.ok(hit, 'overlapping');
  assert.ok(hit.nx > 0.99 && Math.abs(hit.nz) < 0.01, 'pushed away from the tram, to the east');
  assert.ok(hit.depth > 0.3 && hit.depth < 1, `by the overlap: ${hit.depth}`);
  assert.equal(t.touching({ x: c.x + 2.6, y: 100, z: c.z, yaw: 0, length: 4.3, width: 1.8 }), null, 'a car beside the tram is clear');
  assert.equal(t.touching({ x: c.x + 1.6, y: 110, z: c.z, yaw: 0, length: 4.3, width: 1.8 }), null, 'on a bridge above it, too');
  assert.equal(boxOverlap(0, 0, 0, 2, 1, 10, 0, 0.3, 2, 1), null);
  const cross = boxOverlap(0, 0, 0, 2, 1, 0, -2.5, Math.PI / 2, 2, 1);
  assert.ok(cross && cross.nz > 0.99 && Math.abs(cross.depth - 0.5) < 1e-9, 'a rectangle across the nose of another');
});

test('vehicles appear on tracks around the player and leave with the distance', () => {
  const rails: RailJson[] = [];
  for (let i = 0; i < 6; i++) rails.push(piece(-900 + i * 300, 0, -600 + i * 300, 0, { a: i > 0 ? [(i - 1) * 2 + 1] : [], b: i < 5 ? [(i + 1) * 2] : [] }));
  const t = new RailTraffic(rails, seeded());
  t.target = 2;
  const player: RailPlayer = { x: 0, y: 100, z: 30, yaw: 0, length: 4.3, width: 1.8 };
  for (let i = 0; i < 50 * 40; i++) t.update(0.02, player);
  assert.ok(t.vehicles.length >= 1 && t.vehicles.length <= 2, `${t.vehicles.length} vehicles`);
  for (const v of t.vehicles) for (const c of v.cars) assert.ok(Math.abs(c.z) < 0.01 && Math.abs(c.y - 100) < 0.01, 'on the rails');
  const none = new RailTraffic([], seeded());
  for (let i = 0; i < 200; i++) none.update(0.02, player);
  assert.equal(none.vehicles.length, 0, 'no tracks: nothing appears, nothing breaks');
  t.update(0.02, { ...player, x: 9000 });
  assert.equal(t.vehicles.length, 0, 'far away from the player they are taken off');
});
