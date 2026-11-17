// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Emergency vehicles and the giving way to them: who pulls over and how,
 * the corridor on a road with two lanes in each direction, the junction an
 * emergency vehicle crosses on red, the player's faults, and the calls that
 * come by themselves.
 *
 *   node --test tests/sim/emergency.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SIREN_HIGH, SIREN_LOW, SIREN_TONE, doppler, sirenLevel, sirenTone } from '../../src/audio/siren.ts';
import { EM, EM_STYLE, Emergencies, emKind, emLit, emStyle } from '../../src/sim/emergency.ts';
import { RuleMonitor } from '../../src/sim/rules.ts';
import type { PlayerSnapshot } from '../../src/sim/rules.ts';
import { SIG, SignalSystem } from '../../src/sim/signals.ts';
import { Traffic, boxesOverlap } from '../../src/sim/traffic.ts';
import type { PlayerState, TrafficCar } from '../../src/sim/traffic.ts';
import { TURN, lanePoint } from '../../src/world/lanes.ts';
import type { Connector, Lane } from '../../src/world/lanes.ts';
import { newPolySample } from '../../src/core/geom.ts';
import { makeTown } from '../game/town.ts';
import type { Town, TownOptions } from '../game/town.ts';

const DT = 1 / 30;

/** The lane of the street from grid point (i0, j0) to (i1, j1) that runs that way. */
function laneOf(town: Town, i0: number, j0: number, i1: number, j1: number): Lane {
  const el = town.lanes.edgeLanes[town.street(i0, j0, i1, j1)];
  return [...el.fwd, ...el.back].find((l) => l.to === town.world.nodes[town.node(i1, j1)] && l.idx === 0)!;
}

/** The connectors from lane to lane along the grid points given (the first lane's end onwards). */
function wayAlong(town: Town, pts: Array<[number, number]>): { start: Lane; route: Connector[] } {
  const lanes: Lane[] = [];
  for (let k = 0; k + 1 < pts.length; k++) lanes.push(laneOf(town, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]));
  const route: Connector[] = [];
  for (let k = 0; k + 1 < lanes.length; k++) {
    const c = lanes[k].out.find((q) => q.to.edge === lanes[k + 1].edge);
    assert.ok(c, `a way from lane ${k} on`);
    route.push(c);
  }
  return { start: lanes[0], route };
}

/** A town with traffic but no cars appearing by themselves, and emergency vehicles only when sent. */
function setUp(opt: TownOptions): { town: Town; signals: SignalSystem; traffic: Traffic; em: Emergencies } {
  const town = makeTown(opt);
  const signals = new SignalSystem(town.world.signals, town.world.lightsOut);
  const traffic = new Traffic(town.world, town.lanes, signals);
  traffic.targetCount = 0;
  const em = new Emergencies(traffic);
  em.auto = false;
  em.patrolShare = 0;
  traffic.emergency = em;
  return { town, signals, traffic, em };
}

/** Somewhere above the town: the traffic keeps clear of nobody, nothing is spawned or removed for being far. */
function anchor(x: number, z: number): PlayerState {
  return { x, y: 130, z, yaw: 0, speed: 0, length: 4.3, width: 1.8 };
}

const overlap = (a: TrafficCar, b: TrafficCar): boolean =>
  Math.abs(a.y - b.y) < 2.5 && boxesOverlap(a.x, a.z, a.yaw, a.length / 2 - 0.2, a.width / 2 - 0.1, b.x, b.z, b.yaw, b.length / 2 - 0.2, b.width / 2 - 0.1);

/** How far `b` is ahead of `a` along the street running east (m). */
const eastOf = (a: TrafficCar, b: TrafficCar): number => b.x - a.x;

test('styles: what an emergency vehicle is, and whether its lights are on, by its style alone', () => {
  for (const kind of [EM.POLICE, EM.AMBULANCE, EM.FIRE, EM.DOCTOR]) {
    for (const lit of [false, true]) {
      const s = emStyle(kind, lit);
      assert.ok(s >= EM_STYLE);
      assert.equal(emKind(s), kind);
      assert.equal(emLit(s), lit);
    }
  }
  for (const s of [0, 1, 2, 3]) {
    assert.equal(emKind(s), -1, 'the ordinary cars and the bus are none');
    assert.equal(emLit(s), false);
  }
});

test('the car ahead pulls over to the right and stops, the ambulance passes it – then it drives on', () => {
  const { town, traffic, em } = setUp({ cols: 6, rows: 1, block: 150 });
  const { start, route } = wayAlong(town, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
  const car = traffic.addCar(route[1].to, 50);
  // (and one coming the other way)
  const oncoming = traffic.addCar(laneOf(town, 4, 0, 3, 0), 60);
  const amb = em.dispatch(EM.AMBULANCE, start, 40, route);
  assert.equal(amb.em?.call, true);
  assert.equal(emLit(amb.style), true);
  const player = anchor(375, 0);
  let minSide = 0;
  let oncomingSide = 0;
  let stoppedNear = false;
  let passed = false;
  let maxSpeed = 0;
  for (let t = 0; t < 70 && !(passed && eastOf(car, amb) > 60); t += DT) {
    traffic.update(DT, player);
    assert.ok(traffic.cars.includes(amb), 'the ambulance stays');
    assert.ok(!overlap(amb, car), `no touching the car (t=${t.toFixed(1)})`);
    assert.ok(!overlap(amb, oncoming), `no touching the oncoming car (t=${t.toFixed(1)})`);
    minSide = Math.min(minSide, car.side ?? 0);
    oncomingSide = Math.min(oncomingSide, oncoming.side ?? 0);
    const behind = eastOf(amb, car);
    if (behind > 0 && behind < 25 && car.v < 0.3) stoppedNear = true;
    if (behind < -6) passed = true;
    maxSpeed = Math.max(maxSpeed, amb.v);
  }
  assert.ok(passed, 'the ambulance got past');
  assert.ok(minSide < -0.6, `the car pulled over to the right (${minSide.toFixed(2)} m)`);
  assert.ok(stoppedNear, 'the car stood while the ambulance came up behind it');
  assert.ok(oncomingSide < -0.5, `the oncoming car kept right (${oncomingSide.toFixed(2)} m)`);
  assert.ok(maxSpeed > 50 / 3.6 + 2, `faster than the limit (${(maxSpeed * 3.6).toFixed(0)} km/h)`);
  // once it is well past, the car goes back to the middle of its lane and drives on
  for (let t = 0; t < 12; t += DT) traffic.update(DT, player);
  assert.ok(Math.abs(car.side ?? 0) < 0.05, `back in its lane (${(car.side ?? 0).toFixed(2)} m)`);
  assert.ok(car.v > 3, 'and drives on');
});

test('in a one-way street too narrow to pass, the car ahead drives on to clear the way – nobody gets stuck', () => {
  const streets: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 5; i++) streets.push([i, 0, i + 1, 0]);
  const { town, traffic, em } = setUp({ cols: 6, rows: 1, block: 150, oneWay: streets });
  const { start, route } = wayAlong(town, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
  assert.ok(start.edge.width < 4, 'a narrow street');
  const car = traffic.addCar(route[0].to, 30);
  const fire = em.dispatch(EM.FIRE, start, 40, route.slice(0, 3));
  const player = anchor(375, 0);
  const x0 = fire.x;
  let waited = 0;
  for (let t = 0; t < 45; t += DT) {
    traffic.update(DT, player);
    assert.ok(!overlap(fire, car), `no touching (t=${t.toFixed(1)})`);
    if (fire.v < 0.3) waited += DT;
  }
  assert.ok(fire.x - x0 > 250, `it got on (${(fire.x - x0).toFixed(0)} m)`);
  assert.ok(waited < 15, `not stuck for long (${waited.toFixed(1)} s standing)`);
});

test('the horn: two tones a fourth apart in turn, higher as it comes nearer, quieter far away', () => {
  assert.equal(sirenTone(0.1), SIREN_HIGH);
  assert.equal(sirenTone(0.1 + SIREN_TONE), SIREN_LOW);
  assert.equal(sirenTone(0.1 + 2 * SIREN_TONE), SIREN_HIGH, 'round and round');
  assert.ok(Math.abs(SIREN_HIGH / SIREN_LOW - 4 / 3) < 0.002, 'a pure fourth');
  assert.ok(doppler(20, 0) > 1.05 && doppler(-20, 0) < 0.95, 'higher coming, lower going');
  assert.ok(Math.abs(doppler(0, 0) - 1) < 1e-9);
  assert.ok(doppler(0, 15) > 1, 'driving towards it, too');
  assert.equal(sirenLevel(5), 1);
  assert.ok(Math.abs(sirenLevel(48) - 0.25) < 1e-9, 'a quarter at four times the distance');
});

test('on a road with two lanes in each direction the cars leave the corridor: the left lane moves left, the right one right', () => {
  const all: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 5; i++) all.push([i, 0, i + 1, 0]);
  const { town, traffic, em } = setUp({ cols: 6, rows: 1, block: 150, wide: all });
  const { start, route } = wayAlong(town, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
  const el = town.lanes.edgeLanes[route[1].to.edge.id];
  const lanes = route[1].to.dir > 0 ? el.fwd : el.back;
  assert.equal(lanes.length, 2);
  // slow traffic side by side
  const right = traffic.addCar(lanes[0], 60);
  const left = traffic.addCar(lanes[1], 62);
  for (const c of [right, left]) {
    c.v = 2;
    c.temper = 0.3;
  }
  const fire = em.dispatch(EM.FIRE, start, 40, route);
  const player = anchor(375, 0);
  let leftMost = 0;
  let rightMost = 0;
  let passed = false;
  for (let t = 0; t < 60 && !passed; t += DT) {
    traffic.update(DT, player);
    for (const c of [right, left]) assert.ok(!overlap(fire, c), `no touching (t=${t.toFixed(1)})`);
    leftMost = Math.max(leftMost, left.side ?? 0);
    rightMost = Math.min(rightMost, right.side ?? 0);
    if (eastOf(fire, right) < -8 && eastOf(fire, left) < -8) passed = true;
  }
  assert.ok(passed, 'the fire engine got through');
  assert.ok(leftMost > 0.5, `the left lane moved to the left (${leftMost.toFixed(2)} m)`);
  assert.ok(rightMost < -0.5, `the right lane moved to the right (${rightMost.toFixed(2)} m)`);
});

test('at a junction it crosses on red – slowly, after a look – while the traffic with green waits for it', () => {
  const { town, signals, traffic, em } = setUp({ cols: 3, rows: 3, block: 160, lights: [[1, 1]] });
  const node = town.world.nodes[town.node(1, 1)];
  // from the north, through the junction to the south: red for it (the street across has green)
  const { start, route } = wayAlong(town, [[1, 0], [1, 1], [1, 2]]);
  const across = laneOf(town, 0, 1, 1, 1);
  const car = traffic.addCar(across, across.len - 75);
  car.next = across.out.find((c) => c.turn === TURN.STRAIGHT) ?? car.next;
  const police = em.dispatch(EM.POLICE, start, 30, route);
  const player = anchor(160, 160);
  let atLine = Infinity;
  let carOver = false;
  let crossed = false;
  for (let t = 0; t < 40 && !crossed; t += DT) {
    signals.update(DT);
    traffic.update(DT, player);
    assert.equal(signals.get(node.sc, start.armTo.sg), SIG.RED, 'red for the police car all the while');
    assert.ok(!overlap(police, car), `no touching (t=${t.toFixed(1)})`);
    if (police.lane === start) {
      const d = start.stopAt - police.s - police.length / 2;
      if (d < 3 && d > -1) atLine = Math.min(atLine, police.v);
      // the car on green has not gone into the junction meanwhile
      if (car.lane === across && car.s + car.length / 2 > across.stopAt + 0.5) carOver = true;
    }
    if (police.lane === route[0].to) crossed = true;
  }
  assert.ok(crossed, 'the police car got through the junction on red');
  assert.ok(atLine < 6.5, `slowly at the line (${(atLine * 3.6).toFixed(0)} km/h)`);
  assert.ok(!carOver, 'the car with green waited before its line');
  // and goes on once it has passed
  let moved = false;
  for (let t = 0; t < 20 && !moved; t += DT) {
    signals.update(DT);
    traffic.update(DT, player);
    if (car.conn || car.lane !== across) moved = true;
  }
  assert.ok(moved, 'the car went on once the police car had passed');
});

/** The player's car along the street running east, driven by hand: where it is, how fast, how far left of the middle of its lane. */
interface Driver {
  x: number;
  z: number;
  v: number;
  off: number;
}

/**
 * Drive the player (east along row 0) for `secs` seconds, with the traffic
 * and the rule monitor, `steer` deciding speed and place across the lane
 * each step.  Returns the faults found.
 */
function drivePlayer(town: Town, traffic: Traffic, signals: SignalSystem, me: Driver, secs: number, steer: (t: number) => void, until?: () => boolean): string[] {
  const rules = new RuleMonitor(town.world, town.lanes, signals, traffic);
  const tmp = newPolySample();
  const y = town.world.nodes[0].y;
  const p: PlayerState = { x: me.x, y, z: me.z, yaw: -Math.PI / 2, speed: me.v, length: 4.3, width: 1.8 };
  for (let t = 0; t < secs; t += DT) {
    steer(t);
    me.x += me.v * DT;
    p.x = me.x;
    p.speed = me.v;
    // (its place across: off the middle of the lane it is on)
    const lane = rules.laneNow;
    p.lane = lane;
    p.s = lane ? rules.laneFront - p.length / 2 : 0;
    if (lane) {
      lanePoint(lane, p.s ?? 0, tmp);
      p.z = tmp.z - tmp.tx * me.off;
    } else p.z = me.z;
    signals.update(DT);
    traffic.update(DT, p);
    const snap: PlayerSnapshot = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, speed: me.v, indicator: 0, hazard: false, lookYaw: 0, seatbelt: true, handbrake: 0, stalled: false, hitScenery: 0, length: 4.3 };
    rules.update(DT, snap, traffic.events);
    if (until?.()) break;
  }
  return rules.log.map((v) => v.id);
}

test('the player who does not make way is told so – and the one who pulls over and stops is not', () => {
  for (const [pullOver, demo] of [[false, false], [true, false], [false, true]]) {
    const { town, signals, traffic, em } = setUp({ cols: 6, rows: 1, block: 150 });
    const { start, route } = wayAlong(town, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
    const amb = em.dispatch(EM.AMBULANCE, start, 30, route);
    // (on a demonstration drive the automatic driver is not judged)
    em.judging = !demo;
    const me: Driver = { x: 190, z: 0, v: 7, off: 0 };
    let tip: string | null = null;
    const faults = drivePlayer(town, traffic, signals, me, 45, () => {
      tip ??= em.tip();
      if (!pullOver || me.x - amb.x > 80) return;
      // to the right, and stop
      me.off = Math.max(-1, me.off - 0.6 * DT);
      me.v = Math.max(0, me.v - 3 * DT);
    }, () => amb.x > me.x + 40);
    assert.equal(tip, 'emTipBehind', 'the instructor says what to do');
    assert.ok(!faults.includes('crash'), 'it never runs into the player');
    if (pullOver || demo) {
      assert.ok(!faults.includes('emergencyBlock'), `no fault when making way – or on a demonstration drive (${faults.join(', ')})`);
      assert.ok(amb.x > me.x + 40, 'and the ambulance got past');
    } else assert.ok(faults.includes('emergencyBlock'), `held up the ambulance (${faults.join(', ')})`);
  }
});

test('in slow traffic on a road with two lanes each way: no corridor is a fault, the corridor lets it through', () => {
  for (const corridor of [false, true]) {
    const all: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 5; i++) all.push([i, 0, i + 1, 0]);
    const { town, signals, traffic, em } = setUp({ cols: 6, rows: 1, block: 150, wide: all });
    const { start, route } = wayAlong(town, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
    const police = em.dispatch(EM.POLICE, start, 30, route);
    // the player in the left lane, at walking pace
    const leftLane = town.lanes.edgeLanes[route[0].to.edge.id].fwd[1];
    lanePoint(leftLane, 10, newPolySample());
    const me: Driver = { x: 190, z: 0, v: 1.5, off: 0 };
    const tmp = newPolySample();
    lanePoint(leftLane, 40, tmp);
    me.z = tmp.z;
    let tip: string | null = null;
    const faults = drivePlayer(town, traffic, signals, me, 40, () => {
      tip ??= em.tip();
      if (corridor && me.x - police.x < 150) me.off = Math.min(0.85, me.off + 0.5 * DT);
    }, () => police.x > me.x + 30);
    assert.equal(tip, 'emTipCorridor');
    if (corridor) {
      assert.ok(!faults.includes('emergencyCorridor') && !faults.includes('emergencyBlock'), `no fault in the corridor (${faults.join(', ')})`);
      assert.ok(police.x > me.x + 30, 'the police car got through');
    } else assert.ok(faults.includes('emergencyCorridor'), `no corridor (${faults.join(', ')})`);
  }
});

test('into the junction in front of it – on green – is a fault; waiting before the line is not', () => {
  for (const wait of [false, true]) {
    const { town, signals, traffic, em } = setUp({ cols: 3, rows: 3, block: 160, lights: [[1, 1]] });
    // the fire engine from the north, on red; the player from the west on green, about the same time
    const { start, route } = wayAlong(town, [[1, 0], [1, 1], [1, 2]]);
    const fire = em.dispatch(EM.FIRE, start, 30, route);
    const across = laneOf(town, 0, 1, 1, 1);
    const tmp = newPolySample();
    lanePoint(across, across.len - 105, tmp);
    const me: Driver = { x: tmp.x, z: tmp.z, v: 11, off: 0 };
    lanePoint(across, across.stopAt, tmp);
    const line = tmp.x;
    let tip: string | null = null;
    const faults = drivePlayer(town, traffic, signals, me, 40, () => {
      tip ??= em.tip();
      if (!wait) return;
      // braking to stand before the line until the fire engine is through (the player's front is 2.15 m ahead of its middle)
      if (fire.lane === route[0].to && fire.s > 15) me.v = Math.min(11, me.v + 2 * DT);
      else me.v = Math.max(0, Math.min(me.v, Math.sqrt(2 * 3 * Math.max(0, line - 1 - (me.x + 2.15)))));
    }, () => me.x > 230);
    assert.equal(tip, 'emTipJunction');
    assert.ok(!faults.includes('crash'), 'nobody runs into anybody');
    if (wait) assert.ok(!faults.includes('emergencyJunction'), `no fault when waiting (${faults.join(', ')})`);
    else assert.ok(faults.includes('emergencyJunction'), `into the junction in front of the fire engine (${faults.join(', ')})`);
  }
});

test('calls come by themselves – every few minutes in town – and end; police cars go on patrol without lights', () => {
  const town = makeTown({ cols: 8, rows: 3, block: 150 });
  const signals = new SignalSystem(town.world.signals, town.world.lightsOut);
  const traffic = new Traffic(town.world, town.lanes, signals);
  traffic.targetCount = 10;
  const em = new Emergencies(traffic);
  em.patrolShare = 0.25;
  traffic.emergency = em;
  // the player stands in the street in the middle of the town (above it: nobody brakes for it)
  const lane = laneOf(town, 3, 1, 4, 1);
  const tmp = newPolySample();
  lanePoint(lane, 60, tmp);
  const player: PlayerState = { x: tmp.x, y: tmp.y + 30, z: tmp.z, yaw: Math.atan2(-tmp.tx, -tmp.tz), speed: 0, length: 4.3, width: 1.8, lane, s: 60 };
  const calls = new Set<number>();
  const ended = new Set<number>();
  const patrols = new Set<number>();
  let patrolMoving = false;
  let twoPatrols = false;
  const dt = 1 / 20;
  for (let t = 0; t < 12 * 60; t += dt) {
    signals.update(dt);
    traffic.update(dt, player);
    let onPatrol = 0;
    for (const c of traffic.cars) {
      if (!c.em) continue;
      assert.equal(emKind(c.style), c.em.kind);
      assert.equal(emLit(c.style), c.em.call);
      if (c.em.call) calls.add(c.id);
      else if (calls.has(c.id)) ended.add(c.id);
      else {
        patrols.add(c.id);
        onPatrol++;
        if (c.v > 5) patrolMoving = true;
      }
    }
    if (onPatrol > 1) twoPatrols = true;
  }
  assert.ok(calls.size >= 3, `a call every few minutes (${calls.size} in 12 minutes)`);
  assert.ok(ended.size >= 1, `calls end: lights off on arrival (${ended.size})`);
  assert.ok(patrols.size >= 1 && patrolMoving, 'police cars on patrol drive with the traffic');
  assert.ok(!twoPatrols, 'one on patrol at a time');
});
