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
import { ROAD_VEHICLE_KINDS, VEHICLES } from '../../src/game/vehicles.ts';
import { DT, PlaneGround, input, makeCar } from './harness.ts';

// (the tram runs on its tracks: tests/game/tram.test.ts; on foot there is no vehicle)
for (const kind of ROAD_VEHICLE_KINDS) {
  const def = VEHICLES[kind];
  test(`${kind}: its engine powers – the one it comes with among them, within its class`, () => {
    assert.ok(def.powers.includes(def.power), `${def.power} PS is one of ${def.powers.join(', ')}`);
    assert.deepEqual([...def.powers].sort((a, b) => a - b), [...def.powers], 'listed from the weakest');
    // AM at most 4 kW, A1 at most 11 kW, A2 at most 35 kW (Anlage 3 FeV / § 6 FeV)
    const limitKw = { moped: 4, motorcycle125: 11, motorcycle35: 35 }[kind as string];
    if (limitKw) for (const ps of def.powers) assert.ok(ps * 0.7355 <= limitKw + 0.05, `${ps} PS within ${limitKw} kW`);
  });

  // every engine one may choose: the weakest and the strongest as well as the usual one
  for (const power of [...new Set([def.powers[0], def.power, def.powers[def.powers.length - 1]])])
  test(`${kind} with ${power} PS: pulls away, stops, pulls away again – and keeps to its top speed`, () => {
    const spec = def.spec('automatic', power);
    assert.equal(spec.transmission, 'automatic');
    const v = makeCar(new PlaneGround(), spec);
    const go = (secs: number, throttle: number, brake: number): void => {
      for (let i = 0; i < secs / DT; i++) v.step(DT, input({ throttle, brake, gear: 1 }));
    };
    go(6, 0.6, 0);
    // (a moped built for 45 km/h takes its time, and so does a 125 with its weakest engine)
    const brisk = def.governed > 0 && def.governed < 50 ? 10 : power < 20 ? 15 : 20;
    assert.ok(v.speed * 3.6 > brisk, `under way (${(v.speed * 3.6).toFixed(0)} km/h)`);
    go(6, 0, 0.6);
    assert.ok(Math.abs(v.speed) < 0.1, `stopped (${v.speed.toFixed(2)} m/s)`);
    go(3, 0, 0.3);
    assert.ok(Math.abs(v.speed) < 0.1, 'held by the brake, not crept away');
    assert.equal(v.engineRunning, true, 'the engine still runs after the stop');
    go(4, 0.5, 0);
    assert.ok(v.speed * 3.6 > brisk / 2 - 2, `and pulls away again (${(v.speed * 3.6).toFixed(0)} km/h)`);
    if (def.governed > 0 && def.governed < 60) {
      go(40, 1, 0);
      assert.ok(v.speed * 3.6 < def.governed + 2, `not faster than it is built for (${(v.speed * 3.6).toFixed(1)} km/h)`);
    }
  });

  test(`${kind}: does not tip over in a tight bend`, () => {
    const v = makeCar(new PlaneGround(), def.spec('automatic', def.power));
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
