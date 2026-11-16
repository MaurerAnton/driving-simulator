// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The vehicles of the other licence classes in the physics: they pull away,
 * stop at a line and pull away again without stalling (with the automatic
 * gearbox the demonstration driver uses), the tractor stays at its 40 km/h,
 * and nothing tips over in a tight bend – not even the "motorcycle", which
 * runs on the four-wheel model.
 *
 *   node --test "tests/vehicle/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { VEHICLES, VEHICLE_KINDS } from '../../src/game/vehicles.ts';
import { DT, PlaneGround, input, makeCar } from './harness.ts';

for (const kind of VEHICLE_KINDS) {
  const def = VEHICLES[kind];
  test(`${kind}: pulls away, stops, pulls away again – and keeps to its top speed`, () => {
    const spec = def.spec('automatic', 150);
    assert.equal(spec.transmission, 'automatic');
    const v = makeCar(new PlaneGround(), spec);
    const go = (secs: number, throttle: number, brake: number): void => {
      for (let i = 0; i < secs / DT; i++) v.step(DT, input({ throttle, brake, gear: 1 }));
    };
    go(6, 0.6, 0);
    assert.ok(v.speed * 3.6 > 20, `under way (${(v.speed * 3.6).toFixed(0)} km/h)`);
    go(6, 0, 0.6);
    assert.ok(Math.abs(v.speed) < 0.1, `stopped (${v.speed.toFixed(2)} m/s)`);
    go(3, 0, 0.3);
    assert.ok(Math.abs(v.speed) < 0.1, 'held by the brake, not crept away');
    assert.equal(v.engineRunning, true, 'the engine still runs after the stop');
    go(4, 0.5, 0);
    assert.ok(v.speed * 3.6 > 10, `and pulls away again (${(v.speed * 3.6).toFixed(0)} km/h)`);
    if (def.governed > 0 && def.governed < 60) {
      go(40, 1, 0);
      assert.ok(v.speed * 3.6 < def.governed + 2, `not faster than it is built for (${(v.speed * 3.6).toFixed(1)} km/h)`);
    }
  });

  test(`${kind}: does not tip over in a tight bend`, () => {
    const v = makeCar(new PlaneGround(), def.spec('automatic', 150));
    for (let i = 0; i < 25 / DT && v.speed * 3.6 < 28; i++) v.step(DT, input({ throttle: 0.6, gear: 1 }));
    let upright = 1;
    for (let i = 0; i < 6 / DT; i++) {
      v.step(DT, input({ throttle: v.speed * 3.6 < 28 ? 0.4 : 0, steer: 0.6, gear: 1 }));
      upright = Math.min(upright, v.upright);
      assert.ok(Number.isFinite(v.speed));
    }
    assert.ok(upright > 0.9, `upright (${upright.toFixed(2)})`);
  });
}
