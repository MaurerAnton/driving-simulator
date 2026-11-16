// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The bus on a line: serving a stop – front door at the pole, doors open,
 * people through, doors closed, indicator on to pull out – and what the
 * instructor says when one of it goes wrong.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BusService } from '../../src/game/busline.ts';
import type { BusEvent } from '../../src/game/busline.ts';

const DT = 1 / 30;
const STOPS = [{ id: 7, s: 120, name: 'Rathaus' }];

/** drive the bus's front from `from` to `to` (m along the lane) at `v` m/s with the indicator as given */
function drive(bs: BusService, from: number, to: number, v: number, indicator: number, ev: BusEvent[]): number {
  let front = from;
  while (front < to) {
    front = Math.min(to, front + v * DT);
    bs.step(DT, front, STOPS, v, indicator, ev);
  }
  return front;
}

test('a stop served: stand at the pole, open, everybody through, close, indicate, pull out – nothing to say', () => {
  const bs = new BusService(() => 0.6);
  const ev: BusEvent[] = [];
  let front = drive(bs, 0, 119, 8, 0, ev);
  assert.equal(bs.next(front, STOPS)?.name, 'Rathaus');
  assert.ok(bs.atStop(front, STOPS, 0), 'standing at the stop');
  bs.toggleDoors(front, STOPS, 0, ev);
  assert.ok(bs.doorsOpen && bs.passengers > 0, 'people get off and on');
  for (let t = 0; t < 30; t += DT) bs.step(DT, front, STOPS, 0, 0, ev);
  assert.equal(bs.passengers, 0);
  bs.toggleDoors(front, STOPS, 0, ev);
  assert.equal(bs.served, 1);
  for (let t = 0; t < 2; t += DT) bs.step(DT, front, STOPS, 0, -1, ev);
  front = drive(bs, front, 200, 5, -1, ev);
  assert.deepEqual(ev.map((e) => e.fault), []);
  assert.equal(bs.next(front, STOPS), null, 'no stop ahead any more');
});

test('driving past, the doors away from the stop or open while moving, pulling out without indicating: faults', () => {
  const past = new BusService(() => 0.6);
  const ev1: BusEvent[] = [];
  drive(past, 0, 200, 10, 0, ev1);
  assert.deepEqual(ev1.map((e) => e.fault), ['busStopMissed']);

  const away = new BusService(() => 0.6);
  const ev2: BusEvent[] = [];
  const front = drive(away, 0, 60, 8, 0, ev2);
  away.toggleDoors(front, STOPS, 0, ev2);
  drive(away, front, 70, 3, 0, ev2);
  assert.deepEqual(ev2.map((e) => e.fault), ['busStopPlace', 'busDoorsMoving']);

  const blind = new BusService(() => 0);
  const ev3: BusEvent[] = [];
  const at = drive(blind, 0, 120, 8, 0, ev3);
  blind.toggleDoors(at, STOPS, 0, ev3);
  blind.toggleDoors(at, STOPS, 0, ev3);
  drive(blind, at, 150, 4, 0, ev3);
  assert.deepEqual(ev3.map((e) => e.fault), ['busPullOut']);
});
