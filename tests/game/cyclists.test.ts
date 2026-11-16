// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The people on bicycles: where they ride, what they stop for, when the
 * player is to blame – and how one is sent along when the player's vehicle
 * comes up to a right turn.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Cyclists, cycleStrip, rideable } from '../../src/sim/cyclists.ts';
import type { CycleEvent, CycleObstacle, CyclePlayer } from '../../src/sim/cyclists.ts';
import { SignalSystem } from '../../src/sim/signals.ts';
import { Traffic } from '../../src/sim/traffic.ts';
import type { Lane } from '../../src/world/lanes.ts';
import { TURN } from '../../src/world/lanes.ts';
import { makeTown } from './town.ts';
import type { Town } from './town.ts';

const DT = 1 / 30;
const BLOCK = 220;
/** in the middle of a block: far from every street, near enough for the cyclists to stay */
const NOWHERE: CyclePlayer = { x: 110, z: 110, yaw: 0, speed: 0, length: 4.3, width: 1.8 };

function setup(lights: Array<[number, number]> = []): { town: Town; signals: SignalSystem; cyclists: Cyclists; east: Lane; south: Lane } {
  const town = makeTown({ cols: 3, rows: 3, block: BLOCK, pavement: 2, lights });
  const signals = new SignalSystem(town.world.signals);
  const cyclists = new Cyclists(town.world, town.lanes, signals);
  // the lane from the west towards the junction in the middle of the town, and the one from the north
  const lanesOf = (e: number): Lane[] => [...town.lanes.edgeLanes[e].fwd, ...town.lanes.edgeLanes[e].back];
  const mid = town.world.nodes[town.node(1, 1)];
  const east = lanesOf(town.street(0, 1, 1, 1)).find((l) => l.to === mid)!;
  const south = lanesOf(town.street(1, 0, 1, 1)).find((l) => l.to === mid)!;
  return { town, signals, cyclists, east, south };
}

function run(c: Cyclists, signals: SignalSystem, seconds: number, player: CyclePlayer = NOWHERE, obstacles: CycleObstacle[] = [], each?: (t: number) => void): CycleEvent[] {
  const events: CycleEvent[] = [];
  for (let t = 0; t < seconds; t += DT) {
    signals.update(DT);
    c.update(DT, player, obstacles, [], events);
    each?.(t);
  }
  return events;
}

test('a cyclist rides on the pavement beside the rightmost lane, straight on through the junction', () => {
  const { town, signals, cyclists, east } = setup();
  assert.ok(rideable(east), 'a street in town with a pavement');
  const c = cyclists.add(east, 20, 5.5);
  const kerb = BLOCK + east.edge.width / 2;
  let least = Infinity;
  let most = -Infinity;
  run(cyclists, signals, 30, NOWHERE, [], () => {
    if (c.lane !== east) return;
    least = Math.min(least, c.z - kerb);
    most = Math.max(most, c.z - kerb);
  });
  assert.ok(least > 0.9 && most < 1.4, `between the posts at the kerb and the lamps at the back of the pavement (${least.toFixed(2)} … ${most.toFixed(2)} m from the kerb)`);
  assert.ok(Math.abs(cycleStrip(east) - (east.edge.width / 2 - Math.abs(east.off) + 1.15)) < 1e-9);
  run(cyclists, signals, 30);
  assert.equal(c.lane?.edge.id, town.street(1, 1, 2, 1), 'straight on, on to the next piece of the street');
  assert.ok(c.v > 4.5, 'and still riding');
  assert.ok(Math.abs(c.y - 100) < 0.4, 'on the ground');
});

test('at a red light the cyclist waits at the line, and rides on at green', () => {
  const { signals, cyclists, south } = setup([[1, 1]]);
  // the side direction has red for the first 33 seconds
  const c = cyclists.add(south, south.stopAt - 60, 5.5);
  run(cyclists, signals, 25);
  assert.equal(c.lane, south, 'still before the junction');
  assert.ok(c.v < 0.05, 'standing');
  assert.ok(south.stopAt - c.s > 0.4 && south.stopAt - c.s < 3, `at the line (${(south.stopAt - c.s).toFixed(2)} m before it)`);
  assert.equal(cyclists.list.length, 1, 'whoever waits at a light is not taken away');
  run(cyclists, signals, 25);
  assert.notEqual(c.lane, south, 'gone on at green');
});

test('a vehicle that turns across the path of a cyclist at short notice is to blame – one that has been standing there is not', () => {
  const { signals, cyclists, east } = setup();
  const strip = BLOCK + east.edge.width / 2 + 1.15;
  // --- at short notice: the vehicle is on the cycle track nine metres ahead of somebody riding at 22 km/h ---
  const c = cyclists.add(east, 60, 6);
  // (turning right off the street the cyclist rides along: the instructor still has it on that lane)
  const across: CyclePlayer = { x: c.x + 9, z: strip, yaw: Math.PI, speed: 2, length: 4.3, width: 1.8, lane: east, s: c.s + 9 };
  const events = run(cyclists, signals, 6, across);
  assert.equal(events.filter((e) => !e.hit).length, 1, 'the cyclist had to brake for it: noted once');
  assert.equal(events.filter((e) => e.hit).length, 0, 'but could still stop');
  assert.ok(c.v < 0.05 && c.x < across.x - 0.9, 'stands before the vehicle');

  // --- standing there all along: the cyclist sees it from afar and waits behind it ---
  cyclists.clear();
  const d = cyclists.add(east, 60, 6);
  const parked: CyclePlayer = { x: d.x + 70, z: strip, yaw: Math.PI, speed: 0, length: 4.3, width: 1.8, lane: east, s: d.s + 70 };
  const none = run(cyclists, signals, 25, parked);
  assert.equal(none.length, 0, 'nobody is to blame');
  assert.ok(d.v < 0.05 && d.x < parked.x - 0.9 && d.x > parked.x - 6, `waits behind it (${(parked.x - d.x).toFixed(1)} m before its middle)`);
  // … and after a while gets off and pushes the bicycle round (is gone)
  run(cyclists, signals, 40, parked);
  assert.equal(cyclists.list.length, 0);
});

test('a trailer of the player\'s counts like the vehicle itself, a tram does not', () => {
  const { signals, cyclists, east } = setup();
  const strip = BLOCK + east.edge.width / 2 + 1.15;
  const c = cyclists.add(east, 60, 6);
  const box = { x: c.x + 9, z: strip, yaw: Math.PI, speed: 2, length: 7, width: 2.5 };
  const truck: CyclePlayer = { ...NOWHERE, lane: east, s: c.s + 20 };
  assert.equal(run(cyclists, signals, 5, truck, [{ ...box, own: true }]).length, 1);
  cyclists.clear();
  const d = cyclists.add(east, 60, 6);
  assert.equal(run(cyclists, signals, 5, truck, [{ ...box, x: d.x + 9 }]).length, 0, 'what is not the player\'s is not the player\'s fault');
  assert.ok(d.v < 0.05, 'they stop for it all the same');
});

test('a cyclist from another street who stops for the vehicle is not cut off by it', () => {
  const { signals, cyclists, east, south } = setup();
  const c = cyclists.add(south, south.stopAt - 30, 6);
  // the vehicle drives along the main street across the cyclist's way, close in front of them
  const passing: CyclePlayer = { x: c.x, z: c.z + 9, yaw: -Math.PI / 2, speed: 8, length: 4.3, width: 1.8, lane: east, s: 200 };
  assert.equal(run(cyclists, signals, 3, passing).length, 0);
  assert.ok(c.v < 1, 'they stopped for it all the same');
});

test('a vehicle that drives into a cyclist knocks them over', () => {
  const { signals, cyclists, east } = setup();
  const c = cyclists.add(east, 60, 5);
  const onTop: CyclePlayer = { x: c.x + 1.2, z: c.z, yaw: -Math.PI / 2, speed: 8, length: 4.3, width: 1.8 };
  const events = run(cyclists, signals, 0.2, onTop);
  assert.ok(events.some((e) => e.hit && e.cyclist === c));
  assert.ok(c.down > 0 && c.v === 0, 'lies on the ground');
  assert.equal(cyclists.blocksRightTurn(east, c.s, 2.2), false, 'nobody waits for somebody who lies there');
  run(cyclists, signals, 7);
  assert.equal(cyclists.list.length, 0, 'picked up after a while');
});

test('whoever wants to turn right waits for the cyclist beside, behind and just ahead', () => {
  const { signals, cyclists, east } = setup();
  const c = cyclists.add(east, 100, 6);
  const half = 2.15;
  assert.equal(cyclists.blocksRightTurn(east, 104, half), true, 'beside the rear of the car');
  assert.equal(cyclists.blocksRightTurn(east, 98, half), true, 'beside its front');
  assert.equal(cyclists.blocksRightTurn(east, 120, half), true, 'coming up behind: there in three seconds');
  assert.equal(cyclists.blocksRightTurn(east, 160, half), false, 'far behind: time enough to turn');
  assert.equal(cyclists.blocksRightTurn(east, 90, half), false, 'well ahead of the car: it turns behind them');
  // the cyclist on the other side of the street is nobody's business here
  const back = [...cyclists['graph'].edgeLanes[east.edge.id].fwd, ...cyclists['graph'].edgeLanes[east.edge.id].back].find((l) => l !== east)!;
  assert.equal(cyclists.blocksRightTurn(back, 100, half), false);
  // riding into the junction just ahead of the car: wait until they are across
  c.s = east.len - 0.5;
  let inJunction = 0;
  let cleared = 0;
  run(cyclists, signals, 6, NOWHERE, [], () => {
    if (!c.conn) return;
    if (cyclists.blocksRightTurn(east, east.stopAt - 2.5, half)) inJunction++;
    else cleared++;
  });
  assert.ok(inJunction > 20, 'waited for while they cross the mouth of the side street');
  assert.ok(cleared > 0 || c.lane !== null, 'and not for longer than that');
});

test('now and then a cyclist rides ahead of a vehicle that comes up to a right turn – and is at the junction a moment after it', () => {
  const { signals, cyclists, east } = setup();
  cyclists.target = 1;
  cyclists.chance = 1;
  assert.ok(east.out.some((c) => c.turn === TURN.RIGHT) && east.out.some((c) => c.turn === TURN.STRAIGHT));
  // the car: 36 km/h along the street, slowing down for the turn, at the line after about 24 seconds
  const car: CyclePlayer = { x: 0, z: BLOCK + 1.375, yaw: -Math.PI / 2, speed: 10, length: 4.3, width: 1.8, lane: east, s: 8 };
  let firstSeen = -1;
  let gapAtLine = NaN;
  const events = run(cyclists, signals, 40, car, [], () => {
    const toLine = east.stopAt - (car.s! + car.length / 2);
    if (toLine <= 0) {
      if (Number.isNaN(gapAtLine) && cyclists.list.length) gapAtLine = cyclists.list[0].lane === east ? east.stopAt - cyclists.list[0].s : -1;
      car.speed = 0;
      return;
    }
    car.speed = toLine > 35 ? 10 : Math.max(3.5, 10 - (35 - toLine) * 0.25);
    car.s! += car.speed * DT;
    car.x += car.speed * DT;
    if (firstSeen < 0 && cyclists.list.length) firstSeen = cyclists.list[0].s - (car.s! + car.length / 2);
  });
  assert.ok(firstSeen >= 54, `turned up far ahead of the car (${firstSeen.toFixed(0)} m), not before its bonnet`);
  assert.ok(gapAtLine > 1 && gapAtLine < 26, `beside or just behind the car when it is at the line (${gapAtLine.toFixed(1)} m before the line)`);
  assert.equal(events.length, 0, 'the car kept to its lane: nothing happened');
  assert.equal(cyclists.list.filter((c) => c.staged !== null || c.lane !== east).length, cyclists.list.length);
});

test('one comes up from far behind while the vehicle waits at the line', () => {
  const { signals, cyclists, east } = setup();
  cyclists.target = 1;
  cyclists.chance = 1;
  const s = east.stopAt - 2 - 2.15;
  const car: CyclePlayer = { x: s, z: BLOCK + 1.375, yaw: -Math.PI / 2, speed: 0, length: 4.3, width: 1.8, lane: east, s };
  let firstSeen = NaN;
  let passed = -1;
  run(cyclists, signals, 30, car, [], (t) => {
    const c = cyclists.list[0];
    if (!c) return;
    if (Number.isNaN(firstSeen)) firstSeen = car.s! - car.length / 2 - c.s;
    if (passed < 0 && c.lane !== east) passed = t;
  });
  assert.ok(firstSeen >= 44 && firstSeen <= 71, `far behind the car, small in its mirrors (${firstSeen.toFixed(0)} m)`);
  assert.ok(passed > 8 && passed < 24, `and past it a few seconds later (after ${passed.toFixed(1)} s)`);
});

test('no cyclist is sent along where the vehicle cannot turn right, on a fast road or without traffic', () => {
  const { town, signals, cyclists, east } = setup();
  cyclists.chance = 1;
  const car: CyclePlayer = { x: 0, z: BLOCK + 1.375, yaw: -Math.PI / 2, speed: 10, length: 4.3, width: 1.8, lane: east, s: 8 };
  // (no traffic asked for: nobody on a bicycle either)
  cyclists.target = 0;
  run(cyclists, signals, 12, car);
  assert.equal(cyclists.list.length, 0);
  // the lane towards the edge of the town along its southern side: no street to the right there
  cyclists.target = 1;
  const lanesOf = (e: number): Lane[] => [...town.lanes.edgeLanes[e].fwd, ...town.lanes.edgeLanes[e].back];
  const corner = town.world.nodes[town.node(1, 2)];
  const rim = lanesOf(town.street(0, 2, 1, 2)).find((l) => l.to === corner)!;
  assert.ok(!rim.out.some((c) => c.turn === TURN.RIGHT), 'the town ends there');
  run(cyclists, signals, 12, { ...car, lane: rim, s: 8 });
  assert.equal(cyclists.list.length, 0);
  // out of town
  east.edge.flags &= ~256;
  run(cyclists, signals, 12, car);
  assert.equal(cyclists.list.length, 0);
});

test('the traffic\'s cars wait for a cyclist before they turn right, and nobody drives through anybody', () => {
  const town = makeTown({ cols: 3, rows: 3, block: 120, pavement: 2 });
  const signals = new SignalSystem(town.world.signals);
  const traffic = new Traffic(town.world, town.lanes, signals);
  traffic.targetCount = 14;
  const player = { x: 120, y: 140, z: 120, yaw: 0, speed: 0, length: 4.3, width: 1.8 };
  let cyclistsSeen = 0;
  let overlaps = 0;
  for (let step = 0; step < 30 * 240; step++) {
    signals.update(DT);
    traffic.update(DT, player);
    cyclistsSeen = Math.max(cyclistsSeen, traffic.cyclists.list.length);
    if (step % 3 !== 0) continue;
    for (const c of traffic.cyclists.list) {
      for (const car of traffic.cars) {
        const dx = c.x - car.x;
        const dz = c.z - car.z;
        const lon = -dx * Math.sin(car.yaw) - dz * Math.cos(car.yaw);
        const lat = dx * Math.cos(car.yaw) - dz * Math.sin(car.yaw);
        if (Math.abs(lon) < car.length / 2 && Math.abs(lat) < car.width / 2) overlaps++;
      }
    }
  }
  assert.ok(cyclistsSeen >= 1, 'where there is traffic there are cyclists');
  assert.equal(overlaps, 0, 'no cyclist inside a car');
  assert.equal(traffic.events.filter((e) => e.type === 'cyclistEndangered').length, 0);
});
