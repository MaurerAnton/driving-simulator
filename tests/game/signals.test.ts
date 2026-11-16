// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Traffic lights beyond the three lamps: lights that are out of order
 * (flashing amber – the signs count) and the green arrow for turning right.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { newPolySample, samplePolyline } from '../../src/core/geom.ts';
import { findArrow, markArrows } from '../../src/sim/arrows.ts';
import { RuleMonitor } from '../../src/sim/rules.ts';
import { SIG, SignalSystem, lightsOutBy } from '../../src/sim/signals.ts';
import { Traffic, boxesOverlap } from '../../src/sim/traffic.ts';
import { TURN, lanePoint } from '../../src/world/lanes.ts';
import type { Connector, Lane } from '../../src/world/lanes.ts';
import { CTRL, ROLE } from '../../src/world/types.ts';
import { makeTown } from './town.ts';
import type { Town, TownOptions } from './town.ts';

const DT = 1 / 30;
const BLOCK = 160;

/** The lane of a street that arrives at the junction (i, j), coming from (i0, j0). */
function laneTo(town: Town, i0: number, j0: number, i: number, j: number): Lane {
  const el = town.lanes.edgeLanes[town.street(i0, j0, i, j)];
  return [...el.fwd, ...el.back].find((l) => l.to === town.world.nodes[town.node(i, j)])!;
}

/**
 * A town whose middle junction has lights.  `tee`: without the street to the
 * north of it – the main road (west–east) with a side road joining from the
 * south.
 */
function litTown(opt: TownOptions & { tee?: boolean } = {}): { town: Town; signals: SignalSystem } {
  const town = makeTown({ cols: 3, rows: 3, block: BLOCK, pavement: 2, lights: [[1, 1]], missing: opt.tee ? [[1, 0, 1, 1]] : [], ...opt });
  const signals = new SignalSystem(town.world.signals, town.world.lightsOut);
  return { town, signals };
}

test('which lights are out of order: a share of them, the same all day, others the next', () => {
  const today = lightsOutBy(20261116, 0.06);
  const again = lightsOutBy(20261116, 0.06);
  const tomorrow = lightsOutBy(20261117, 0.06);
  let n = 0;
  let same = 0;
  let both = 0;
  for (let i = 0; i < 4000; i++) {
    if (today(i)) n++;
    if (today(i) === again(i)) same++;
    if (today(i) && tomorrow(i)) both++;
  }
  assert.equal(same, 4000);
  assert.ok(n > 4000 * 0.04 && n < 4000 * 0.08, `about six in a hundred (${n} of 4000)`);
  assert.ok(both < n * 0.25, `mostly others the next day (${both} of ${n} again)`);
  assert.equal([...Array(500).keys()].filter(lightsOutBy(1, 0)).length, 0);
  assert.equal([...Array(500).keys()].filter(lightsOutBy(1, 1)).length, 500);
});

test('a junction whose lights are out is ruled by its signs: the heads stand and flash, the side road gives way', () => {
  const { town, signals } = litTown({ lightsOut: () => true });
  const node = town.world.nodes[town.node(1, 1)];
  assert.equal(node.dark, true);
  assert.equal(node.ctrl, CTRL.SIGNS);
  for (const arm of node.arms) {
    assert.equal(arm.sg, -1, 'no light rules the approach');
    assert.ok(arm.lamp >= 0, 'but its head still stands there');
  }
  assert.equal(signals.isDark(node.sc), true);
  for (let t = 0; t < 70; t += 0.5) {
    signals.update(0.5);
    assert.equal(signals.get(node.sc, 0), SIG.FLASH);
    assert.equal(signals.get(node.sc, 1), SIG.FLASH);
  }
  // who gives way to whom, as at any junction with signs
  town.lanes.resolveNode(node.id);
  const side = laneTo(town, 1, 0, 1, 1).out.find((c) => c.turn === TURN.STRAIGHT)!;
  const main = laneTo(town, 0, 1, 1, 1).out.find((c) => c.turn === TURN.STRAIGHT)!;
  assert.equal(side.conflicts.find((k) => k.other === main)?.yield, true, 'from the side road: wait');
  assert.equal(main.conflicts.find((k) => k.other === side)?.yield, false, 'on the main road: go');

  // the same junction with its lights working: the lights keep the two apart, nobody gives way
  const ok = litTown();
  const n2 = ok.town.world.nodes[ok.town.node(1, 1)];
  assert.equal(n2.dark, false);
  assert.equal(n2.ctrl, CTRL.SIGNALS);
  ok.town.lanes.resolveNode(n2.id);
  const side2 = laneTo(ok.town, 1, 0, 1, 1).out.find((c) => c.turn === TURN.STRAIGHT)!;
  const main2 = laneTo(ok.town, 0, 1, 1, 1).out.find((c) => c.turn === TURN.STRAIGHT)!;
  assert.equal(side2.conflicts.find((k) => k.other === main2)?.yield, false);
  assert.equal(n2.arms.every((a) => a.sg === a.lamp && a.sg >= 0), true);
});

test('lights out and no signs under them: right before left', () => {
  const { town } = litTown({ lightsOut: () => true, lightsUnsigned: true });
  const node = town.world.nodes[town.node(1, 1)];
  assert.equal(node.ctrl, CTRL.RBL);
  assert.ok(node.arms.every((a) => a.role === ROLE.RBL));
});

test('the traffic gets through a junction whose lights are out – the side road waits, nobody collides', () => {
  const { town, signals } = litTown({ lightsOut: () => true });
  const traffic = new Traffic(town.world, town.lanes, signals);
  traffic.targetCount = 16;
  const node = town.world.nodes[town.node(1, 1)];
  const player = { x: node.x, y: node.y + 40, z: node.z, yaw: 0, speed: 0, length: 4.3, width: 1.8 };
  const through = { main: 0, side: 0 };
  const inside = new Set<number>();
  let overlaps = 0;
  for (let step = 0; step < 30 * 360; step++) {
    signals.update(DT);
    traffic.update(DT, player);
    for (const car of traffic.cars) {
      if (car.conn && car.conn.node === node && !inside.has(car.id)) {
        inside.add(car.id);
        if (car.conn.from.armTo.role === ROLE.PRIORITY) through.main++;
        else through.side++;
      } else if (!car.conn) inside.delete(car.id);
    }
    if (step % 5 !== 0) continue;
    const cars = traffic.cars;
    for (let i = 0; i < cars.length; i++) {
      for (let k = i + 1; k < cars.length; k++) {
        const a = cars[i];
        const b = cars[k];
        if (Math.abs(a.x - b.x) > 6 || Math.abs(a.z - b.z) > 6) continue;
        if (boxesOverlap(a.x, a.z, a.yaw, a.length / 2 - 0.3, a.width / 2 - 0.25, b.x, b.z, b.yaw, b.length / 2 - 0.3, b.width / 2 - 0.25)) overlaps++;
      }
    }
  }
  assert.ok(through.main >= 5 && through.side >= 3, `both streets get through (${through.main} from the main road, ${through.side} from the side road)`);
  assert.equal(overlaps, 0, 'no car in another');
});

test('a green arrow hangs where turning right is in nobody\'s way: on the main road of a T-junction, towards the side road', () => {
  const { town, signals } = litTown({ tee: true });
  const node = town.world.nodes[town.node(1, 1)];
  assert.equal(node.arms.length, 3);
  assert.equal(markArrows(town.world, town.lanes, signals, town.world.allNodes), 1);
  const east = laneTo(town, 0, 1, 1, 1);
  const arrow = signals.arrows.get(east.armTo);
  assert.ok(arrow, 'from the west, the side road is on the right');
  // the only ones in the way: those who come the other way and turn left into the side road – the same light
  assert.deepEqual(arrow.foes, [0]);
  assert.equal(arrow.own, 0);
  assert.deepEqual(arrow.friends, []);
  // not from the east (nothing to the right there), not from the side road (its right turn joins the main road's traffic)
  assert.equal(findArrow(town.world, town.lanes, signals, node, laneTo(town, 2, 1, 1, 1).armTo), null);
  assert.equal(findArrow(town.world, town.lanes, signals, node, laneTo(town, 1, 2, 1, 1).armTo), null);
  // (asked again, nothing is put up twice)
  assert.equal(markArrows(town.world, town.lanes, signals, town.world.allNodes), 0);

  // at a crossing of two streets the right turn is never free: no arrow anywhere
  const cross = litTown();
  assert.equal(markArrows(cross.town.world, cross.town.lanes, cross.signals, cross.town.world.allNodes), 0);
  // … nor where the lights are out
  const out = litTown({ tee: true, lightsOut: () => true });
  assert.equal(markArrows(out.town.world, out.town.lanes, out.signals, out.town.world.allNodes), 0);
});

test('the arrow is lit while the main light is red and the side road has its turn – never with the full green', () => {
  const { town, signals } = litTown({ tee: true });
  markArrows(town.world, town.lanes, signals, town.world.allNodes);
  const arm = laneTo(town, 0, 1, 1, 1).armTo;
  const sc = town.world.nodes[town.node(1, 1)].sc;
  let lit = 0;
  let amber = 0;
  let first = -1;
  for (let t = 0; t < 56; t += 0.1) {
    signals.update(0.1);
    const a = signals.arrow(arm);
    const main = signals.get(sc, 0);
    if (a === SIG.GREEN) {
      lit += 0.1;
      if (first < 0) first = signals.time;
      assert.ok(main === SIG.RED || main === SIG.RED_AMBER, 'only while the main light is red');
      assert.ok(main === SIG.RED_AMBER || signals.age(sc, 0) >= 1.5 - 1e-6, 'and has been for a moment: the junction is clear');
    } else if (a === SIG.AMBER) amber += 0.1;
  }
  assert.ok(Math.abs(lit - 23.5) < 0.3, `for the rest of the red (${lit.toFixed(1)} s of a cycle of 56 s)`);
  assert.ok(Math.abs(first - (28 + 3 + 1.5)) < 0.25, `from a moment after the main light turned red (at ${first.toFixed(1)} s)`);
  assert.ok(amber < 0.05, 'the full green follows: no amber arrow before it');
});

test('an arrow that ends while the main light stays red shows amber first', () => {
  const { town, signals } = litTown({ tee: true });
  const arm = laneTo(town, 0, 1, 1, 1).armTo;
  const sc = town.world.nodes[town.node(1, 1)].sc;
  // (as where people cross the road the turn leads into: lit only while the vehicles there have green)
  signals.arrows.set(arm, { controller: sc, own: 0, foes: [], friends: [1], state: -1, since: 0 });
  const seen: number[] = [];
  let green = 0;
  let amber = 0;
  for (let t = 0; t < 56; t += 0.1) {
    signals.update(0.1);
    const a = signals.arrow(arm);
    if (seen[seen.length - 1] !== a) seen.push(a);
    if (a === SIG.GREEN) {
      green += 0.1;
      assert.equal(signals.get(sc, 1), SIG.GREEN);
    } else if (a === SIG.AMBER) amber += 0.1;
  }
  assert.deepEqual(seen, [-1, SIG.GREEN, SIG.AMBER, -1], 'dark, green, amber, dark');
  assert.ok(Math.abs(green - 18) < 0.3 && Math.abs(amber - 3) < 0.3, `${green.toFixed(1)} s green, ${amber.toFixed(1)} s amber`);
  assert.ok(Math.abs(signals.arrowTime(sc, 0, [], [1]) - 18) < 0.6);
});

/** Drive a car along `parts` (a lane, a path through the junction, a lane) under the eyes of the instructor. */
function drive(town: Town, signals: SignalSystem, parts: Array<Lane | Connector>, from: number, indicator: number): string[] {
  const traffic = new Traffic(town.world, town.lanes, signals);
  traffic.targetCount = 0;
  const rules = new RuleMonitor(town.world, town.lanes, signals, traffic);
  const smp = newPolySample();
  const total = parts.reduce((a, p) => a + p.len, 0);
  const speed = 6;
  for (let d = from; d < total - 4; d += speed * DT) {
    let rest = d;
    let part = parts[0];
    for (const p of parts) {
      part = p;
      if (rest <= p.len) break;
      rest -= p.len;
    }
    if ('pl' in part) samplePolyline(part.pl, Math.min(rest, part.len), smp);
    else lanePoint(part, Math.min(rest, part.len), smp);
    // (indicator set and the look over the shoulder done in good time: only the light is in question here)
    rules.update(DT, { x: smp.x, y: smp.y, z: smp.z, yaw: Math.atan2(-smp.tx, -smp.tz), speed, indicator, hazard: false, lookYaw: indicator > 0 && d - from > 8 && d - from < 20 ? -1.3 : 0, seatbelt: true, handbrake: 0, stalled: false, hitScenery: 0, length: 4.3 }, []);
  }
  return rules.log.map((v) => `${v.severity}:${v.id}`);
}

test('over the line on red with the green arrow lit: fine for whoever turns right – a red-light offence for whoever drives straight on', () => {
  const { town, signals } = litTown({ tee: true });
  markArrows(town.world, town.lanes, signals, town.world.allNodes);
  const east = laneTo(town, 0, 1, 1, 1);
  const right = east.out.find((c) => c.turn === TURN.RIGHT)!;
  const straight = east.out.find((c) => c.turn === TURN.STRAIGHT)!;
  const sc = east.to.sc;
  const reach = (when: number): void => {
    while (signals.time % 56 < when || signals.time % 56 > when + 0.2) signals.update(0.05);
  };
  // the side road's green has just begun: the main light is red, the arrow is lit for a good while
  reach(35);
  assert.equal(signals.get(sc, 0), SIG.RED);
  assert.equal(signals.arrow(east.armTo), SIG.GREEN);
  const from = east.stopAt - 30;
  const turned = drive(town, signals, [east, right, right.to], from, 1);
  assert.ok(!turned.some((f) => /redLight|stopLine|amberLight/.test(f)), `turning right on the arrow: the light is no matter (${turned.join(', ')})`);
  reach(35);
  const faults = drive(town, signals, [east, straight, straight.to], from, 0);
  assert.ok(faults.includes('fail:redLight'), `straight on, the arrow is not for this car (${faults.join(', ') || 'no fault'})`);
  // without an arrow the same right turn on red is what it always was
  const plain = litTown({ tee: true });
  const e2 = laneTo(plain.town, 0, 1, 1, 1);
  while (plain.signals.time < 35) plain.signals.update(0.05);
  const r2 = e2.out.find((c) => c.turn === TURN.RIGHT)!;
  assert.ok(drive(plain.town, plain.signals, [e2, r2, r2.to], e2.stopAt - 30, 1).includes('fail:redLight'));
});

test('the traffic turns right on the green arrow – and only then goes on red', () => {
  const { town, signals } = litTown({ tee: true });
  markArrows(town.world, town.lanes, signals, town.world.allNodes);
  const traffic = new Traffic(town.world, town.lanes, signals);
  traffic.targetCount = 18;
  const node = town.world.nodes[town.node(1, 1)];
  const player = { x: node.x, y: node.y + 40, z: node.z, yaw: 0, speed: 0, length: 4.3, width: 1.8 };
  const inside = new Set<number>();
  let onArrow = 0;
  let onRed = 0;
  for (let step = 0; step < 30 * 1200; step++) {
    signals.update(DT);
    traffic.update(DT, player);
    for (const car of traffic.cars) {
      const c = car.conn;
      if (!c || c.node !== node) {
        inside.delete(car.id);
        continue;
      }
      if (inside.has(car.id)) continue;
      inside.add(car.id);
      const arm = c.from.armTo;
      const st = signals.get(node.sc, arm.sg);
      if (st !== SIG.RED) continue;
      // (into the junction on red: only with the arrow – lit, or amber for whoever was too near to stop)
      if (c.turn === TURN.RIGHT && signals.arrow(arm) >= 0) onArrow++;
      else if (signals.age(node.sc, arm.sg) > 1) onRed++;
    }
  }
  assert.equal(onRed, 0, 'nobody runs the red light');
  assert.ok(onArrow >= 2, `cars turned right on the arrow (${onArrow} in twenty minutes)`);
});
