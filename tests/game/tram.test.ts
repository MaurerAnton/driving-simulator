// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Driving a tram: power and brake, the stop with its doors and passengers,
 * the way at a switch as the indicator asks, and what the instructor says.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { RailTraffic } from '../../src/sim/rail.ts';
import { SignalSystem } from '../../src/sim/signals.ts';
import { TRAM, TramDriver, tramStart } from '../../src/sim/tramdrive.ts';
import type { TramEvent } from '../../src/sim/tramdrive.ts';
import { RAIL } from '../../src/world/types.ts';
import type { RailJson, WorldJson } from '../../src/world/types.ts';
import { World } from '../../src/world/world.ts';

const DT = 1 / 30;

/** A straight track east for 2 km (a stop at 300 m), forking at its end: one branch to the north-east, one to the south-east. */
const END = 2000;
function network(): RailJson[] {
  const line = (pts: Array<[number, number]>): number[] => pts.flatMap(([x, z]) => [x, 100, z]);
  const main: number[] = [];
  for (let x = 0; x <= END; x += 10) main.push(x, 100, 0);
  return [
    { k: RAIL.TRAM, p: main, a: [], b: [1 * 2, 2 * 2], st: [300] },
    // (z grows to the south: the north-east branch bends to the left of a tram running east)
    { k: RAIL.TRAM, p: line([[END, 0], [END + 30, -3], [END + 60, -12], [END + 100, -30]]), a: [0 * 2 + 1, 2 * 2], b: [] },
    { k: RAIL.TRAM, p: line([[END, 0], [END + 30, 3], [END + 60, 12], [END + 100, 30]]), a: [0 * 2 + 1, 1 * 2], b: [] },
  ];
}

function setup(): { rail: RailTraffic; tram: TramDriver } {
  const json: WorldJson = { version: 1, meta: { name: 'Test', generated: '', minX: -100, maxX: 800, minZ: -100, maxZ: 100, tileSize: 500, originE: 0, originN: 0, attribution: [] }, nodes: [], edges: [], banned: [], signals: [], crossings: [], places: [], spawns: [], tiles: [] };
  const world = new World(json);
  const rail = new RailTraffic(network(), () => 0.5);
  rail.target = 0;
  const start = tramStart(rail, 0, 0, [RAIL.TRAM]);
  assert.ok(start, 'a stop to start at');
  const v = rail.spawnAt(0, 60, 1, 0)!;
  assert.ok(v);
  const tram = new TramDriver(rail, v, world, new SignalSystem([]), () => 0.5);
  return { rail, tram };
}

function run(tram: TramDriver, seconds: number, events: TramEvent[] = [], each?: () => void): TramEvent[] {
  for (let t = 0; t < seconds; t += DT) {
    each?.();
    tram.step(DT, events);
  }
  return events;
}

test('the controller: full power pulls away, the speed stays under 70 km/h, the brake stops it', () => {
  const { tram } = setup();
  tram.lever = 1;
  run(tram, 5);
  assert.ok(tram.speed > 4 && tram.speed < 6.5, `about 1.2 m/s² (${tram.speed.toFixed(2)} m/s after 5 s)`);
  run(tram, 40);
  assert.ok(tram.speed <= TRAM.vmax + 0.01, `not faster than 70 km/h (${(tram.speed * 3.6).toFixed(1)})`);
  tram.lever = -1;
  const v0 = tram.speed;
  run(tram, 2);
  assert.ok(v0 - tram.speed > 2.8, 'the service brake');
  tram.lever = 0;
  tram.emergency = true;
  const v1 = tram.speed;
  run(tram, 1);
  assert.ok(v1 - tram.speed > 2.5, 'the emergency brake is stronger');
});

test('at the stop: stand at the mark, open the doors, passengers get off and on, close the doors – a stop served', () => {
  const { tram } = setup();
  const events: TramEvent[] = [];
  // drive up to the stop at 300 m and stop with the front at its mark
  let done = false;
  run(tram, 90, events, () => {
    // aim at a speed that comes down to nothing at the mark
    const d = tram.ahead.stop;
    if (done || d < 0.6) {
      done = true;
      tram.lever = -1;
      return;
    }
    const want = Math.min(10, Math.sqrt(2 * 0.9 * Math.max(d - 0.5, 0)));
    tram.lever = Math.max(-1, Math.min(1, (want - tram.speed) * 1.5));
  });
  assert.ok(tram.speed < 0.05, 'standing');
  assert.ok(Math.abs(tram.v.s - 300) < 5, `at the mark (front at ${tram.v.s.toFixed(1)} m)`);
  tram.lever = 0;
  tram.toggleDoors(events);
  assert.equal(tram.doorsOpen, true);
  assert.equal(tram.standingAtStop, true);
  assert.ok(tram.passengers > 0, 'people get off and on');
  // power with the doors open: held
  tram.lever = 1;
  run(tram, 1, events);
  assert.ok(tram.speed < 0.01, 'the doors hold the tram');
  tram.lever = 0;
  run(tram, 30, events);
  assert.equal(tram.passengers, 0, 'everybody through');
  tram.toggleDoors(events);
  assert.equal(tram.served, 1);
  assert.deepEqual(events.map((e) => e.fault), [], 'nothing to say');
  // and on to the next: the stop is not "missed" afterwards
  tram.lever = 1;
  run(tram, 15, events);
  assert.deepEqual(events.map((e) => e.fault), []);
});

test('closing the doors while passengers still get on, and driving past a stop, are faults', () => {
  const a = setup();
  const ev: TramEvent[] = [];
  a.tram.v.s = 297;
  a.tram.rail.place(a.tram.v);
  a.tram.toggleDoors(ev);
  run(a.tram, 1, ev);
  a.tram.toggleDoors(ev);
  assert.deepEqual(ev.map((e) => e.fault), ['tramDoorsEarly']);

  const b = setup();
  const ev2: TramEvent[] = [];
  b.tram.lever = 1;
  run(b.tram, 40, ev2);
  assert.ok(b.tram.v.s > 330 || b.tram.v.path !== 0, 'past the stop');
  assert.ok(ev2.some((e) => e.fault === 'tramStopMissed'), ev2.map((e) => e.fault).join(', '));
});

test('at the switch the tram takes the way the indicator asks for', () => {
  for (const [wish, side] of [
    [1, -1],
    [-1, 1],
  ] as const) {
    const { tram } = setup();
    tram.v.s = END - 40;
    tram.rail.place(tram.v);
    tram.wish = wish;
    tram.lever = 0.5;
    run(tram, 25);
    const car = tram.v.cars[0];
    assert.ok(car.x > END + 10, 'over the switch');
    assert.equal(Math.sign(car.z), side, `${wish > 0 ? 'left' : 'right'}: ${car.z.toFixed(1)}`);
  }
});

test('by itself (a demonstration drive): it comes to stand at the stop, lets the people through and drives on – without a fault', () => {
  const { tram } = setup();
  const events: TramEvent[] = [];
  let stood = false;
  run(tram, 150, events, () => {
    tram.drive(events);
    if (tram.doorsOpen) stood = true;
  });
  assert.ok(stood, 'the doors were opened at the stop');
  assert.equal(tram.served, 1, 'the stop was served');
  assert.deepEqual(events.map((e) => e.fault), [], 'nothing to say');
  assert.ok(tram.v.s > 600 || tram.v.path !== 0, `and on its way again (${tram.v.s.toFixed(0)} m)`);
});

test('a tram of the traffic runs its line: at the switch the branch its line takes, whichever that is', () => {
  for (const [branch, side] of [
    [1, -1],
    [2, 1],
  ] as const) {
    const rail = new RailTraffic(network(), () => 0.5);
    rail.target = 0;
    rail.setLines([{ ref: '5', from: 'A', to: 'B', colour: '', kind: 0, seq: [{ path: 0, dir: 1 }, { path: branch, dir: 1 }] }]);
    const v = rail.spawnAt(0, END - 80, 1, 8)!;
    assert.ok(rail.assignLine(v, '5'), 'it runs line 5');
    // (somebody standing a little way off: near enough that the tram is kept, not in its way)
    const player = { x: END, y: 100, z: 120, yaw: 0, length: 4, width: 2 };
    for (let t = 0; t < 30; t += DT) rail.update(DT, player);
    assert.equal(v.path, branch, `onto the line's branch (${branch})`);
    assert.equal(Math.sign(v.cars[0].z), side);
  }
});
