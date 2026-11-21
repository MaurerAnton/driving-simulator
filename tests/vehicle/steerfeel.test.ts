// SPDX-License-Identifier: AGPL-3.0-only
/**
 * How the keys and the steering bar steer (input/steerfeel.ts): a car as
 * before; the articulated lorry, the truck and the bus with a slow steering
 * wheel and gentle turns at speed – driven with the real tractor and
 * semi-trailer, the turning rate measured at several speeds.
 *
 *   node --test tests/vehicle/steerfeel.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { LORRY_LATERAL, analogSteer, keySteer, lockFor, steerFeel } from '../../src/input/steerfeel.ts';
import type { SteerFeel } from '../../src/input/steerfeel.ts';
import { SEMI_TRAILER, SemiTrailer, TRACTOR_UNIT } from '../../src/sim/semitrailer.ts';
import { COMPACT_CAR_AUTOMATIC, TRUCK } from '../../src/sim/vehicle/index.ts';
import type { VehicleSpec } from '../../src/sim/vehicle/index.ts';
import { BUS } from '../../src/sim/vehicle/fleet.ts';
import { DT, PlaneGround, input, makeCar } from './harness.ts';

const DEG = 180 / Math.PI;

interface Turn {
  /** seconds from the first touch to the lock asked for */
  toLock: number;
  /** the fastest the steering wheel turned (°/s) */
  wheelSpeed: number;
  /** yaw rate after 6 s (°/s) and lateral acceleration (m/s²) */
  yawRate: number;
  lateral: number;
  /** the steering input at the end */
  steer: number;
}

/** Drive at `speed` (m/s), then hold the bar (or the key) fully left for 6 s. */
function turn(spec: VehicleSpec, semi: boolean, speed: number, how: 'touch' | 'keys'): Turn {
  const g = new PlaneGround();
  const v = makeCar(g, spec);
  v.vel[2] = -speed;
  const t = semi ? new SemiTrailer(SEMI_TRAILER, g) : null;
  t?.coupleBehind(v);
  const f: SteerFeel = steerFeel(spec);
  let steer = 0;
  let toLock = -1;
  let wheelSpeed = 0;
  const steps = Math.round(7 / DT);
  for (let i = 0; i < steps; i++) {
    const time = i * DT;
    const before = steer;
    if (time >= 1) {
      steer = how === 'touch' ? analogSteer(f, steer, -1, v.speed, DT, 4) : keySteer(f, steer, -1, v.speed, 0, DT);
      const want = -lockFor(f, how === 'touch' ? 7 : 2.4 + 3.4 / (1 + (v.speed / 15) ** 2), Math.abs(v.speed));
      if (toLock < 0 && Math.abs(steer - want) < 0.01) toLock = time - 1;
    }
    wheelSpeed = Math.max(wheelSpeed, (Math.abs(steer - before) / DT) * spec.maxWheelAngle * spec.steeringRatio * DEG);
    const inp = input({
      gear: 1,
      steer,
      throttle: Math.min(1, Math.max(0, (speed - v.speed) * 0.5)),
      brake: Math.min(1, Math.max(0, (v.speed - speed) * 0.3)),
    });
    v.step(DT, inp);
    t?.step(DT, v, inp);
  }
  return {
    toLock,
    wheelSpeed,
    yawRate: Math.abs(v.angVel[1]) * DEG,
    lateral: Math.abs(v.angVel[1] * v.speed),
    steer,
  };
}

test('a car steers as before: no limit on the steering speed, a car’s lateral acceleration', () => {
  const f = steerFeel(COMPACT_CAR_AUTOMATIC);
  assert.equal(f.lateral, 1);
  assert.equal(f.rate, Infinity);
  // the bar winds the lock on within a quarter of a second, as it always did
  const r = turn(COMPACT_CAR_AUTOMATIC, false, 3, 'touch');
  assert.ok(r.toLock > 0.2 && r.toLock < 0.3, `${r.toLock}`);
});

test('the lorries: a slow steering wheel, gentle turns at speed', () => {
  for (const spec of [TRACTOR_UNIT, TRUCK, BUS]) {
    const f = steerFeel(spec);
    assert.ok(Math.abs(f.lateral - LORRY_LATERAL) < 1e-9, spec.name);
    // the steering wheel at no more than about 1.4 turns a second
    assert.ok(f.rate * spec.maxWheelAngle * spec.steeringRatio * DEG <= 501, spec.name);
  }
});

test('the articulated lorry turns at a lorry’s rate, not a car’s', () => {
  const rows: string[] = [];
  for (const speed of [3, 6, 10, 15, 22]) {
    for (const how of ['touch', 'keys'] as const) {
      const r = turn(TRACTOR_UNIT, true, speed, how);
      const car = turn(COMPACT_CAR_AUTOMATIC, false, speed, how);
      rows.push(
        `${speed} m/s ${how}: lock in ${r.toLock.toFixed(2)} s, wheel ${r.wheelSpeed.toFixed(0)}°/s, yaw ${r.yawRate.toFixed(1)}°/s, ${r.lateral.toFixed(2)} m/s² (car: yaw ${car.yawRate.toFixed(1)}°/s, ${car.lateral.toFixed(2)} m/s²)`,
      );
      assert.ok(r.wheelSpeed < 510, `the steering wheel is turned by hands: ${rows.at(-1)}`);
      // a lorry keeps well below where it would tip over (3.5 m/s²)
      if (speed >= 6) assert.ok(r.lateral < 3.2, `gentle at speed: ${rows.at(-1)}`);
      if (speed >= 6) assert.ok(r.yawRate < car.yawRate * 0.75, `slower than a car: ${rows.at(-1)}`);
      // and still turns: something to steer with
      assert.ok(r.lateral > 0.8, `it still turns: ${rows.at(-1)}`);
    }
  }
  // at walking pace the full lock is there (round a tight corner), only it takes a moment to wind on
  const slow = turn(TRACTOR_UNIT, true, 3, 'touch');
  assert.ok(Math.abs(slow.steer) > 0.99, `full lock at walking pace: ${slow.steer}`);
  assert.ok(slow.toLock > 1.2 && slow.toLock < 2.2, `lock to lock is hand over hand: ${slow.toLock}`);
  console.log(rows.join('\n'));
});

test('the steering sensitivity: a sharper feel asks for more lock, never past full lock', () => {
  const speed = 8; // m/s – a town turn, where the keys wind on meaningful lock
  const gentle = keySteer(steerFeel(COMPACT_CAR_AUTOMATIC, undefined, undefined, 0.5), 0, 1, speed, 0, 0.5);
  const asBuilt = keySteer(steerFeel(COMPACT_CAR_AUTOMATIC, undefined, undefined, 1), 0, 1, speed, 0, 0.5);
  const sharp = keySteer(steerFeel(COMPACT_CAR_AUTOMATIC, undefined, undefined, 2), 0, 1, speed, 0, 0.5);
  // more sensitivity -> more lock for the same input at the same speed
  assert.ok(gentle < asBuilt, `${gentle} < ${asBuilt}`);
  assert.ok(asBuilt < sharp, `${asBuilt} < ${sharp}`);
  // but never more than full lock, however sharp
  const full = keySteer(steerFeel(COMPACT_CAR_AUTOMATIC, undefined, undefined, 8), 0, 1, speed, 0, 0.5);
  assert.ok(full <= 1, `never past full lock: ${full}`);
  // the default feel (sens 1) is unchanged by building one without a sens
  assert.equal(steerFeel(COMPACT_CAR_AUTOMATIC).sens, 1);
});
