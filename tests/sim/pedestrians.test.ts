// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The people on foot in the town (src/sim/pedestrians.ts): they wait for the
 * green at a pedestrian light and hurry when it turns red, wait at a zebra
 * crossing until the cars stop, cross elsewhere only in a gap, keep out of
 * each other's way, step back from a car that comes too close – and keep to
 * the pavements while they walk.
 *
 *   node --test tests/sim/pedestrians.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AGE, ageOfLook, outAt, rainOf } from '../../src/sim/pedestrians.ts';
import { SignalSystem } from '../../src/sim/signals.ts';
import { Traffic } from '../../src/sim/traffic.ts';
import type { PlayerState } from '../../src/sim/traffic.ts';
import { XING } from '../../src/world/types.ts';
import { newSurfaceHit } from '../../src/world/world.ts';
import { makeTown } from '../game/town.ts';

const DT = 1 / 30;

/** Somebody on foot far away, out of everything: the player as the tests need no player. */
function nobody(): PlayerState {
  return { x: 5000, y: 100, z: 5000, yaw: 0, speed: 0, length: 0.6, width: 0.6, onFoot: true };
}

/** A street of `block` m east–west at z = 0 (from x = 0 to x = block), 5.5 m wide, with 2 m pavements; crossings as asked. */
function street(block: number, crossings: Array<{ at: number; k: number }> = []) {
  const town = makeTown({ cols: 2, rows: 1, block, pavement: 2, crossings: crossings.map((c) => ({ street: [0, 0, 1, 0] as [number, number, number, number], at: c.at, k: c.k })) });
  const signals = new SignalSystem(town.world.signals);
  const traffic = new Traffic(town.world, town.lanes, signals);
  traffic.targetCount = 0;
  traffic.crowd.clock = () => 12;
  const edge = town.world.edges[town.street(0, 0, 1, 0)];
  return { town, signals, traffic, edge };
}

// (the street runs a→b eastwards: its left side, +1, is the north pavement (z < 0), its right side the south one)
const NORTH = 1;
const SOUTH = -1;

test('at a pedestrian light: the button, the wait for the green – and hurrying when it turns red on the way', () => {
  const { signals, traffic, edge, town } = street(300, [{ at: 0.5, k: XING.SIGNAL }]);
  const c = town.world.crossings[0];
  const sc = c.sc as number;
  // (the light has rested on green for the vehicles a while)
  for (let t = 0; t < 30; t += 0.1) signals.update(0.1);
  const w = traffic.crowd.add(edge, NORTH, 138, 1, { look: 7, age: AGE.ADULT, bold: false, pace: 1.3, idle: 0, goal: { edge, side: SOUTH, s: 175 } });
  const player = nobody();
  let waited = 0;
  let pressed = false;
  let crossedOnGreen = false;
  let wrong = 0;
  let over = false;
  for (let t = 0; t < 60 && !over; t += DT) {
    signals.update(DT);
    const before = w.state;
    traffic.update(DT, player);
    if (w.state === 'wait') {
      waited += DT;
      assert.equal(w.crossing, c, 'waiting at the crossing of the map');
      if (signals.requested(sc)) pressed = true;
    }
    if (before !== 'cross' && w.state === 'cross') {
      if (signals.pedestrian(sc, c.g ?? 0) === 'green') crossedOnGreen = true;
      else wrong++;
    }
    if (w.z > 3.5 && w.state === 'walk') over = true;
  }
  assert.ok(pressed, 'the button was pressed ("Signal kommt")');
  assert.ok(waited > 2, `waited for the green (${waited.toFixed(1)} s)`);
  assert.equal(wrong, 0, 'never stepped out on red');
  assert.ok(crossedOnGreen, 'crossed on the green');
  assert.ok(over, 'and is on the other pavement');

  // somebody slow, caught by the red half way over: hurries
  const s2 = street(300, [{ at: 0.5, k: XING.SIGNAL }]);
  for (let t = 0; t < 30; t += 0.1) s2.signals.update(0.1);
  const slow = s2.traffic.crowd.add(s2.edge, NORTH, 146, 1, { look: 7, age: AGE.ADULT, bold: false, pace: 0.3, idle: 0, goal: { edge: s2.edge, side: SOUTH, s: 175 } });
  const c2 = s2.town.world.crossings[0];
  // (the pace on the road: just before the light changes, and once it has)
  let before = 0;
  let after = 0;
  for (let t = 0; t < 120; t += DT) {
    s2.signals.update(DT);
    s2.traffic.update(DT, player);
    if (slow.state !== 'cross') continue;
    const st = s2.signals.pedestrian(c2.sc as number, 0);
    if (st === 'green') before = slow.speed;
    else after = Math.max(after, slow.speed);
  }
  assert.ok(before > 0.2, `on the road on the green (${before.toFixed(2)} m/s)`);
  assert.ok(after > before * 1.3, `faster once it turned red (${before.toFixed(2)} → ${after.toFixed(2)} m/s)`);
});

test('at a zebra crossing: wait at the kerb, look left and right, step out once the cars stop – and they do', () => {
  const { signals, traffic, edge, town } = street(500, [{ at: 0.5, k: XING.ZEBRA }]);
  traffic.targetCount = 8;
  const zebra = town.world.crossings[0];
  const player = nobody();
  // the cars first
  for (let t = 0; t < 40; t += DT) {
    signals.update(DT);
    traffic.update(DT, player);
  }
  const w = traffic.crowd.add(edge, NORTH, 236, 1, { look: 7, age: AGE.ADULT, bold: false, pace: 1.3, idle: 0, goal: { edge, side: SOUTH, s: 270 } });
  let left = 0;
  let right = 0;
  let stepped = -1;
  let fastNear = 0;
  let overWhileOn = 0;
  const last = new Map<number, number>();
  let atKerb = 0;
  let over = false;
  for (let t = 0; t < 120 && !over; t += DT) {
    signals.update(DT);
    const was = w.state;
    traffic.update(DT, player);
    if (traffic.crowd.modeOf(w) === 'kerb') {
      atKerb += DT;
      if (stepped < 0) {
        left = Math.max(left, w.head);
        right = Math.min(right, w.head);
      }
      if (w.state === 'wait') assert.equal(traffic.pedestrianAt(zebra), w, 'the traffic sees somebody waiting at the zebra crossing');
    }
    if (was !== 'cross' && w.state === 'cross') {
      stepped = t;
      // nobody still coming fast and close
      for (const c of traffic.cars) {
        const dx = 250 - c.x;
        const towards = c.v > 0 && Math.sign(dx) === Math.sign(-Math.sin(c.yaw));
        if (towards && Math.abs(dx) < 25 && c.v > 3) fastNear++;
      }
    }
    for (const c of traffic.cars) {
      const b = last.get(c.id);
      if (b !== undefined && Math.sign(b - 250) !== Math.sign(c.x - 250) && Math.abs(c.x - 250) < 6 && w.state === 'cross') overWhileOn++;
      last.set(c.id, c.x);
    }
    if (w.z > 3.5 && w.state === 'walk') over = true;
  }
  assert.ok(atKerb > 0.8, `stood at the kerb (${atKerb.toFixed(1)} s)`);
  assert.ok(left > 0.5 && right < -0.5, `looked left (${left.toFixed(2)}) and right (${right.toFixed(2)})`);
  assert.ok(stepped > 0, 'stepped out');
  assert.equal(fastNear, 0, 'not in front of a car still coming fast');
  assert.equal(overWhileOn, 0, 'no car drove over the crossing while they were on it');
  assert.ok(over, 'and is on the other side');
});

test('a zebra crossing: whoever comes up to it while a car is too close to stop lets it pass first (the driver is not to blame)', () => {
  const { signals, traffic, edge, town } = street(500, [{ at: 0.5, k: XING.ZEBRA }]);
  const zebra = town.world.crossings[0];
  const w = traffic.crowd.add(edge, NORTH, 243, 1, { look: 7, age: AGE.ADULT, bold: false, pace: 1.3, idle: 0, goal: { edge, side: SOUTH, s: 270 } });
  // the player's car comes along the south lane eastwards at 50 km/h
  const car: PlayerState = { x: 160, y: 100, z: 1.4, yaw: -Math.PI / 2, speed: 13.9, length: 4.3, width: 1.8 };
  let registeredClose = 0;
  let registered = -1;
  for (let t = 0; t < 30; t += DT) {
    signals.update(DT);
    car.x += car.speed * DT;
    traffic.update(DT, car);
    const at = traffic.pedestrianAt(zebra);
    const front = 250 - 2 - (car.x + 2.15);
    if (at === w && w.waited > 0.3 && front > 0 && front < 30) registeredClose++;
    if (at === w && registered < 0) registered = car.x;
  }
  assert.equal(registeredClose, 0, 'never came up to the crossing just in front of the car');
  assert.ok(registered > 250, `came up once the car had passed (car at x = ${registered.toFixed(0)})`);
});

test('elsewhere only in a gap of the traffic: the car passes first, then over', () => {
  const { signals, traffic, edge } = street(400);
  const w = traffic.crowd.add(edge, NORTH, 196, 1, { look: 7, age: AGE.ADULT, bold: false, pace: 1.3, idle: 0, margin: 1.8, goal: { edge, side: SOUTH, s: 200 } });
  // the player's car in the south lane, eastwards at 50 km/h, 110 m off
  const car: PlayerState = { x: 90, y: 100, z: 1.4, yaw: -Math.PI / 2, speed: 13.9, length: 4.3, width: 1.8 };
  let stepped = -1;
  let carAt = 0;
  let over = false;
  let looked = false;
  for (let t = 0; t < 40 && !over; t += DT) {
    signals.update(DT);
    car.x += car.speed * DT;
    const was = w.state;
    traffic.update(DT, car);
    if (traffic.crowd.modeOf(w) === 'kerb' && Math.abs(w.head) > 0.5) looked = true;
    if (was !== 'cross' && w.state === 'cross' && stepped < 0) {
      stepped = t;
      carAt = car.x;
    }
    if (w.z > 3.5 && w.state === 'walk') over = true;
  }
  assert.ok(looked, 'looked before crossing');
  assert.ok(stepped > 0, 'crossed');
  const xw = w.x;
  assert.ok(carAt > xw + 2, `stepped out after the car had passed (car at x = ${carAt.toFixed(1)}, crossing at ${xw.toFixed(1)})`);
  assert.ok(over, 'on the other side');

  // nothing coming (or far away and slow): straight over after a look
  const s2 = street(400);
  const v = s2.traffic.crowd.add(s2.edge, NORTH, 196, 1, { look: 7, age: AGE.ADULT, bold: false, pace: 1.3, idle: 0, goal: { edge: s2.edge, side: SOUTH, s: 200 } });
  let t2 = -1;
  for (let t = 0; t < 20 && t2 < 0; t += DT) {
    s2.signals.update(DT);
    s2.traffic.update(DT, nobody());
    if (v.state === 'cross') t2 = t;
  }
  assert.ok(t2 > 0 && t2 < 9, `over the empty street at once (${t2.toFixed(1)} s)`);
});

test('two people meeting on a pavement pass each other, each on their right; a quicker one overtakes on the left', () => {
  const { signals, traffic, edge } = street(400);
  const a = traffic.crowd.add(edge, NORTH, 150, 1, { look: 7, age: AGE.ADULT, bold: false, pace: 1.3, idle: 0, goal: { edge, side: NORTH, s: 260 } });
  const b = traffic.crowd.add(edge, NORTH, 190, -1, { look: 9, age: AGE.ADULT, bold: false, pace: 1.3, idle: 0, goal: { edge, side: NORTH, s: 80 } });
  let min = Infinity;
  let passedA = 0;
  let passedB = 0;
  for (let t = 0; t < 40; t += DT) {
    signals.update(DT);
    traffic.update(DT, nobody());
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    min = Math.min(min, d);
    // as they pass: a walks east (its right is south, the kerb side here), b walks west (its right is north)
    if (Math.abs(a.x - b.x) < 0.5) {
      passedA = a.z;
      passedB = b.z;
    }
  }
  assert.ok(min > 0.5, `never bumped into each other (${min.toFixed(2)} m)`);
  assert.ok(passedA > passedB, `each kept to the right (${passedA.toFixed(2)} south of ${passedB.toFixed(2)})`);

  const s2 = street(400);
  const slow = s2.traffic.crowd.add(s2.edge, NORTH, 120, 1, { look: 7, age: AGE.OLD, pace: 0.7, idle: 0, goal: { edge: s2.edge, side: NORTH, s: 300 } });
  const quick = s2.traffic.crowd.add(s2.edge, NORTH, 108, 1, { look: 9, age: AGE.ADULT, pace: 1.8, hurry: true, idle: 0, goal: { edge: s2.edge, side: NORTH, s: 300 } });
  let gap = Infinity;
  let overtaken = false;
  for (let t = 0; t < 40; t += DT) {
    s2.signals.update(DT);
    s2.traffic.update(DT, nobody());
    gap = Math.min(gap, Math.hypot(slow.x - quick.x, slow.z - quick.z));
    if (quick.x > slow.x + 2) overtaken = true;
  }
  assert.ok(overtaken, 'the quicker one got past');
  assert.ok(gap > 0.5, `without bumping into the slower one (${gap.toFixed(2)} m)`);
});

test('a car passing too close to the kerb, fast: the one waiting there starts and steps back', () => {
  const { signals, traffic, edge } = street(400);
  const w = traffic.crowd.add(edge, NORTH, 196, 1, { look: 7, age: AGE.ADULT, bold: false, pace: 1.3, idle: 0, goal: { edge, side: SOUTH, s: 200 } });
  const player = nobody();
  // to the kerb
  for (let t = 0; t < 8 && traffic.crowd.modeOf(w) !== 'kerb'; t += DT) {
    signals.update(DT);
    traffic.update(DT, player);
  }
  assert.equal(traffic.crowd.modeOf(w), 'kerb', 'waits at the kerb');
  const kerbZ = w.z;
  // the player's car westwards in the north lane, its side a hand's breadth from the kerb, at 55 km/h
  const car: PlayerState = { x: 260, y: 100, z: -1.65, yaw: Math.PI / 2, speed: 15.3, length: 4.3, width: 1.8 };
  let startle = 0;
  let back = 0;
  for (let t = 0; t < 8; t += DT) {
    signals.update(DT);
    car.x -= car.speed * DT;
    traffic.update(DT, car);
    startle = Math.max(startle, w.startle);
    back = Math.max(back, kerbZ - w.z);
  }
  assert.ok(startle > 0.5, `started (${startle.toFixed(2)})`);
  assert.ok(back > 0.25, `stepped back from the kerb (${back.toFixed(2)} m)`);
});

test('the horn: those in front of the vehicle start and stop short', () => {
  const { signals, traffic, edge } = street(400);
  const w = traffic.crowd.add(edge, NORTH, 150, 1, { look: 7, age: AGE.ADULT, bold: false, pace: 1.3, idle: 0, goal: { edge, side: NORTH, s: 300 } });
  const car: PlayerState = { x: 140, y: 100, z: 1.4, yaw: -Math.PI / 2, speed: 0, length: 4.3, width: 1.8 };
  for (let t = 0; t < 2; t += DT) {
    signals.update(DT);
    traffic.update(DT, car);
  }
  assert.ok(w.speed > 1, 'walking');
  car.horn = true;
  let startle = 0;
  let stood = false;
  for (let t = 0; t < 0.5; t += DT) {
    traffic.update(DT, car);
    startle = Math.max(startle, w.startle);
    if (w.phase < 0) stood = true;
  }
  assert.ok(startle > 0.8, `started (${startle.toFixed(2)})`);
  assert.ok(stood, 'stopped short');
});

test('at night fewer are out; in the rain they hurry, under umbrellas', () => {
  assert.ok(outAt(3) < 0.1 && outAt(12) === 1 && outAt(17.5) > 0.9, 'the hours of the day');
  assert.equal(rainOf({ kind: 'clear', intensity: 0 }), 0);
  assert.ok(rainOf({ kind: 'rain', intensity: 0.6 }) > 0.6 && rainOf({ kind: 'drizzle', intensity: 0.5 }) > 0.2);
  const count = (hour: number): number => {
    const town = makeTown({ cols: 3, rows: 3, block: 120, pavement: 2.2 });
    const signals = new SignalSystem(town.world.signals);
    const traffic = new Traffic(town.world, town.lanes, signals);
    traffic.targetCount = 0;
    traffic.crowd.clock = () => hour;
    traffic.crowd.target = 80;
    const player: PlayerState = { x: 120, y: 100, z: 120, yaw: 0, speed: 0, length: 0.6, width: 0.6, onFoot: true };
    let sum = 0;
    for (let t = 0; t < 20; t += DT) {
      traffic.update(DT, player);
      if (t > 10) sum += traffic.crowd.people.length * DT;
    }
    return sum / 10;
  };
  const noon = count(12);
  const night = count(3);
  assert.ok(noon > 30, `people about at noon (${noon.toFixed(0)})`);
  assert.ok(night < noon * 0.2, `few at three in the morning (${night.toFixed(1)} against ${noon.toFixed(0)})`);

  // the same walk, dry and in the rain
  const walk = (wet: boolean): { t: number; umbrella: boolean } => {
    const { signals, traffic, edge } = street(400);
    traffic.crowd.weather = () => (wet ? { kind: 'rain', intensity: 0.8 } : { kind: 'clear', intensity: 0 });
    const w = traffic.crowd.add(edge, NORTH, 100, 1, { look: 7, age: AGE.ADULT, pace: 1.3, idle: 0, goal: { edge, side: NORTH, s: 300 } });
    let umbrella = false;
    for (let t = 0; t < 60; t += DT) {
      signals.update(DT);
      traffic.update(DT, nobody());
      if (w.umbrella) umbrella = true;
      if (w.x > 160) return { t, umbrella };
    }
    return { t: 60, umbrella };
  };
  const dry = walk(false);
  const wet = walk(true);
  assert.ok(wet.t < dry.t * 0.88, `quicker in the rain (${wet.t.toFixed(1)} s against ${dry.t.toFixed(1)} s for 60 m)`);
  assert.ok(!dry.umbrella, 'no umbrella in the dry');
});

test('who they are follows from how they look: the old walk slower, children quicker (render/people.ts decides the look)', async () => {
  const { lookOf } = await import('../../src/render/people.ts');
  for (let id = 0; id < 3000; id += 7) {
    const L = lookOf(id);
    const age = ageOfLook(id);
    assert.equal(age === AGE.CHILD, L.scale < 0.89, `child or not: look ${id}`);
    assert.equal(age === AGE.OLD, L.stoop >= 0.1, `old or not: look ${id}`);
  }
  const town = makeTown({ cols: 3, rows: 3, block: 120, pavement: 2.2 });
  const traffic = new Traffic(town.world, town.lanes, new SignalSystem(town.world.signals));
  traffic.targetCount = 0;
  traffic.crowd.clock = () => 12;
  traffic.crowd.target = 150;
  const player: PlayerState = { x: 120, y: 100, z: 120, yaw: 0, speed: 0, length: 0.6, width: 0.6, onFoot: true };
  const pace = new Map<number, number[]>();
  for (let t = 0; t < 40; t += DT) {
    traffic.update(DT, player);
    for (const w of traffic.crowd.people) {
      if (traffic.crowd.modeOf(w) !== 'walk' || w.phase < 0) continue;
      const age = ageOfLook(w.colour);
      const list = pace.get(age) ?? [];
      list.push(w.speed);
      pace.set(age, list);
    }
  }
  const mean = (a: number): number => {
    const l = pace.get(a) ?? [];
    return l.reduce((x, y) => x + y, 0) / Math.max(1, l.length);
  };
  assert.ok(mean(AGE.OLD) > 0 && mean(AGE.OLD) < mean(AGE.ADULT) * 0.85, `the old slower (${mean(AGE.OLD).toFixed(2)} against ${mean(AGE.ADULT).toFixed(2)} m/s)`);
  assert.ok(mean(AGE.CHILD) > mean(AGE.ADULT), `children quicker (${mean(AGE.CHILD).toFixed(2)} m/s)`);
});

test('crossing a side street at a junction: a car that turns into it lets them over first', () => {
  // a T: the main street east–west along the row, the side street south from the middle junction
  const town = makeTown({ cols: 3, rows: 2, block: 120, pavement: 2, missing: [[0, 1, 1, 1], [1, 1, 2, 1], [0, 0, 0, 1], [2, 0, 2, 1]] });
  const signals = new SignalSystem(town.world.signals);
  const traffic = new Traffic(town.world, town.lanes, signals);
  traffic.targetCount = 0;
  traffic.crowd.clock = () => 12;
  const main = town.world.edges[town.street(0, 0, 1, 0)];
  const side = town.world.edges[town.street(1, 0, 1, 1)];
  // somebody on the south pavement of the main street walking east, past the mouth of the side street
  const w = traffic.crowd.add(main, -1, 100, 1, { look: 7, age: AGE.ADULT, bold: false, pace: 1.3, idle: 0, goal: { edge: town.world.edges[town.street(1, 0, 2, 0)], side: -1, s: 40 } });
  // the lane of the side street that leaves the junction (southwards)
  const lane = town.lanes.edgeLanes[side.id]?.fwd[0] ?? null;
  assert.ok(lane, 'the side street has a lane leaving the junction');
  let crossing = 0;
  let seen = false;
  for (let t = 0; t < 60; t += DT) {
    signals.update(DT);
    traffic.update(DT, nobody());
    if (w.state === 'cross' && Math.abs(w.x - 120) < 6) {
      crossing += DT;
      if (traffic.crowd.crossingLane(lane as NonNullable<typeof lane>)) seen = true;
    }
  }
  assert.ok(crossing > 1, `crossed the mouth of the side street (${crossing.toFixed(1)} s on it)`);
  assert.ok(seen, 'a car turning into the side street sees somebody crossing it there');
});

test('a whole town: nobody walks on the carriageway but to cross it, and no car runs into anybody', () => {
  const town = makeTown({ cols: 3, rows: 3, block: 120, pavement: 2.2, lights: [[1, 1]], crossings: [{ street: [0, 0, 1, 0], at: 0.5, k: XING.ZEBRA }, { street: [0, 2, 1, 2], at: 0.5, k: XING.SIGNAL }] });
  const signals = new SignalSystem(town.world.signals);
  const traffic = new Traffic(town.world, town.lanes, signals);
  traffic.targetCount = 14;
  traffic.crowd.clock = () => 12;
  traffic.crowd.target = 70;
  const player: PlayerState = { x: 120, y: 100, z: 120, yaw: 0, speed: 0, length: 0.6, width: 0.6, onFoot: true };
  const hit = newSurfaceHit();
  let walking = 0;
  let onRoad = 0;
  let crossed = 0;
  let touched = 0;
  const crossers = new Set<number>();
  for (let t = 0; t < 150; t += DT) {
    signals.update(DT);
    traffic.update(DT, player);
    for (const w of traffic.crowd.people) {
      if (w.state === 'cross') crossers.add(w.id);
      if (w.state !== 'walk' || traffic.crowd.modeOf(w) === 'follow') continue;
      walking++;
      if (town.world.surfaceAt(w.x, w.z, w.y + 1, hit) && hit.zone === 0) onRoad++;
    }
    for (const c of traffic.cars) {
      const fx = -Math.sin(c.yaw);
      const fz = -Math.cos(c.yaw);
      for (const w of traffic.crowd.people) {
        const dx = w.x - c.x;
        const dz = w.z - c.z;
        if (Math.abs(dx) > 6 || Math.abs(dz) > 6) continue;
        const lf = dx * fx + dz * fz;
        const lr = dx * -fz + dz * fx;
        if (Math.abs(lf) < c.length / 2 + 0.1 && Math.abs(lr) < c.width / 2 + 0.1 && c.v > 0.5) touched++;
      }
    }
  }
  crossed = crossers.size;
  assert.ok(walking > 10000, `people walked (${walking} samples)`);
  assert.equal(onRoad, 0, 'nobody walking along on the carriageway');
  assert.ok(crossed > 15, `${crossed} crossed a street`);
  assert.equal(touched, 0, 'no car drove into anybody');
});
