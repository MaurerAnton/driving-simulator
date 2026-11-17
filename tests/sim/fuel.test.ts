// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The fuel model: what the engines burn, driven with the real vehicle
 * dynamics at a steady speed on level ground (a speed controller on the
 * throttle) – realistic figures per 100 km for a car, a truck (empty and
 * loaded), a bus, a tractor, motorcycles; idling, coasting with the fuel
 * cut off; the tank, the pump, the load in a truck's box.
 *
 *   node --test tests/sim/fuel.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ENERGY_PER_LITRE, FillUp, FuelTank, fuelFlow, fullTorque, startShare, tankFor } from '../../src/sim/fuel.ts';
import type { TankSpec } from '../../src/sim/fuel.ts';
import { withPayload } from '../../src/sim/payload.ts';
import { BUS, LIGHT_TRUCK, MOPED, MOTORCYCLE, TRACTOR } from '../../src/sim/vehicle/fleet.ts';
import { COMPACT_CAR_AUTOCLUTCH, TRUCK, withPower } from '../../src/sim/vehicle/index.ts';
import type { VehicleSpec } from '../../src/sim/vehicle/index.ts';
import { DT, PlaneGround, input, makeCar } from '../vehicle/harness.ts';

/**
 * Drive at `kmh` on level ground and measure the consumption (l/100 km)
 * over the last 30 s, after 50 s to settle.  `gearFor`: the gear for a
 * speed (km/h) – a manual gearbox with the clutch working itself; for an
 * automatic: D.
 */
function cruise(spec: VehicleSpec, tank: TankSpec, kmh: number, gearFor: (kmh: number) => number = () => 1): { per100: number; perHour: number } {
  const v = makeCar(new PlaneGround(), spec);
  const target = kmh / 3.6;
  let integral = 0;
  let litres = 0;
  let metres = 0;
  const settle = 50;
  const measure = 30;
  const steps = Math.round((settle + measure) / DT);
  for (let i = 0; i < steps; i++) {
    const err = target - v.speed;
    integral = Math.max(-0.2, Math.min(1, integral + err * DT * 0.08));
    const throttle = Math.max(0, Math.min(1, err * 0.6 + integral));
    v.step(DT, input({ throttle, gear: gearFor(v.speed * 3.6) }));
    if (i * DT >= settle) {
      litres += fuelFlow(v.spec, tank, v.rpm, v.engineLoad, v.engineRunning) * DT;
      metres += Math.abs(v.speed) * DT;
    }
  }
  assert.ok(Math.abs(v.speed * 3.6 - kmh) < 3, `the controller holds ${kmh} km/h (${(v.speed * 3.6).toFixed(1)})`);
  return { per100: (litres / metres) * 100000, perHour: (litres / measure) * 3600 };
}

/**
 * A driver's gear for the speed (km/h): up a gear above each of `ups`, down
 * again only 7 km/h below it (or a shift that costs a little speed would
 * hunt between two gears).
 */
function shifter(ups: readonly number[]): (kmh: number) => number {
  let gear = 1;
  return (kmh) => {
    while (gear <= ups.length && kmh > ups[gear - 1]) gear++;
    while (gear > 1 && kmh < ups[gear - 2] - 7) gear--;
    return gear;
  };
}

/** a car's gears: up early, as one drives to save fuel */
const carGear = (): ((kmh: number) => number) => shifter([18, 32, 45, 62, 80]);

const tank = (kind: string): TankSpec => {
  const t = tankFor(kind);
  assert.ok(t, kind);
  return t;
};

test('the full-load torque follows the torque curve', () => {
  assert.equal(fullTorque(TRUCK, 1300), 1050);
  assert.equal(fullTorque(TRUCK, 2700), 0);
  assert.ok(Math.abs(fullTorque(TRUCK, 750) - 860) < 1);
});

test('a compact car burns 5 to 8 l/100 km at 100 km/h, 3.5 to 6.5 at a steady 50', (ctx) => {
  const t = tank('car');
  const fast = cruise(COMPACT_CAR_AUTOCLUTCH, t, 100, carGear());
  const town = cruise(COMPACT_CAR_AUTOCLUTCH, t, 50, carGear());
  assert.ok(fast.per100 > 5 && fast.per100 < 8, `100 km/h: ${fast.per100.toFixed(2)} l/100 km`);
  assert.ok(town.per100 > 3.5 && town.per100 < 6.5, `50 km/h: ${town.per100.toFixed(2)} l/100 km`);
  // the weaker engine of the driving school's car is no thirstier
  const small = cruise(withPower(COMPACT_CAR_AUTOCLUTCH, 75), t, 100, carGear());
  assert.ok(small.per100 > 4.5 && small.per100 < 8, `75 PS at 100 km/h: ${small.per100.toFixed(2)} l/100 km`);
  ctx.diagnostic(`car: ${fast.per100.toFixed(1)} l/100 km at 100 km/h, ${town.per100.toFixed(1)} at 50; with 75 PS ${small.per100.toFixed(1)} at 100`);
});

test('a 12-t truck burns 18 to 32 l/100 km at 80 km/h – more with 2.4 t of goods', (ctx) => {
  const t = tank('truck');
  const empty = cruise(TRUCK, t, 80);
  assert.ok(empty.per100 > 18 && empty.per100 < 32, `empty: ${empty.per100.toFixed(1)} l/100 km`);
  const loaded = cruise(withPayload(TRUCK, { mass: 2400, z: 0.2, y: 1.8, len: 3.7, wid: 1.7, hgt: 1.2 }), t, 80);
  assert.ok(loaded.per100 > empty.per100 * 1.02, `loaded: ${loaded.per100.toFixed(1)} l/100 km (empty ${empty.per100.toFixed(1)})`);
  const light = cruise(LIGHT_TRUCK, tank('lightTruck'), 80);
  assert.ok(light.per100 > 12 && light.per100 < 26, `7.5 t: ${light.per100.toFixed(1)} l/100 km`);
  ctx.diagnostic(`12-t truck at 80 km/h: ${empty.per100.toFixed(1)} l/100 km empty, ${loaded.per100.toFixed(1)} with 2.4 t; 7.5-t truck ${light.per100.toFixed(1)}`);
});

test('a city bus burns 18 to 40 l/100 km at a steady 50 km/h', (ctx) => {
  const r = cruise(BUS, tank('bus'), 50);
  assert.ok(r.per100 > 18 && r.per100 < 40, `${r.per100.toFixed(1)} l/100 km`);
  ctx.diagnostic(`bus at 50 km/h: ${r.per100.toFixed(1)} l/100 km`);
});

test('a tractor burns 15 to 40 l/100 km on the road at 35 km/h (some 6 to 14 l an hour)', (ctx) => {
  const r = cruise(TRACTOR, tank('tractorSlow'), 35);
  assert.ok(r.per100 > 15 && r.per100 < 40, `${r.per100.toFixed(1)} l/100 km`);
  assert.ok(r.perHour > 5 && r.perHour < 14, `${r.perHour.toFixed(1)} l/h`);
  ctx.diagnostic(`tractor at 35 km/h: ${r.per100.toFixed(1)} l/100 km, ${r.perHour.toFixed(1)} l/h`);
});

test('a motorcycle burns 3 to 7 l/100 km at 100 km/h, a moped 1.5 to 4 at 40', (ctx) => {
  const big = cruise({ ...MOTORCYCLE, autoClutch: true }, tank('motorcycle'), 100, shifter([20, 40, 60, 80, 95]));
  assert.ok(big.per100 > 3 && big.per100 < 7, `motorcycle: ${big.per100.toFixed(2)} l/100 km`);
  const moped = cruise(MOPED.auto, tank('moped'), 40);
  assert.ok(moped.per100 > 1.5 && moped.per100 < 4, `moped: ${moped.per100.toFixed(2)} l/100 km`);
  ctx.diagnostic(`motorcycle at 100 km/h: ${big.per100.toFixed(1)} l/100 km; moped at 40: ${moped.per100.toFixed(1)}`);
});

test('idling costs a little, rolling in gear with the foot off nothing, a stopped engine nothing', (ctx) => {
  const t = tank('car');
  const car = makeCar(new PlaneGround(), COMPACT_CAR_AUTOCLUTCH);
  for (let i = 0; i < 5 / DT; i++) car.step(DT, input({ gear: 0 }));
  const idle = fuelFlow(car.spec, t, car.rpm, car.engineLoad, car.engineRunning) * 3600;
  assert.ok(idle > 0.3 && idle < 1.4, `car idling: ${idle.toFixed(2)} l/h`);
  const truck = makeCar(new PlaneGround(), TRUCK);
  for (let i = 0; i < 5 / DT; i++) truck.step(DT, input({ gear: 0 }));
  const idleTruck = fuelFlow(truck.spec, tank('truck'), truck.rpm, truck.engineLoad, truck.engineRunning) * 3600;
  assert.ok(idleTruck > 0.8 && idleTruck < 4, `truck idling: ${idleTruck.toFixed(2)} l/h`);
  ctx.diagnostic(`idling: car ${idle.toFixed(2)} l/h, truck ${idleTruck.toFixed(2)} l/h`);
  // coasting in 4th at 70 km/h, the foot off: the engine is driven by the wheels, the injection cut off
  car.vel[2] = -70 / 3.6;
  for (let i = 0; i < 2 / DT; i++) car.step(DT, input({ gear: 4 }));
  assert.ok(car.rpm > 1500, `turning: ${car.rpm.toFixed(0)} rpm`);
  assert.equal(fuelFlow(car.spec, t, car.rpm, car.engineLoad, car.engineRunning), 0);
  assert.equal(fuelFlow(car.spec, t, 2000, 0.5, false), 0);
});

test('the tank: burning, the reserve, empty, filling up; the litres per 100 km', () => {
  const t = new FuelTank(tank('car'), 0.5);
  assert.equal(t.litres, 25);
  assert.ok(!t.low && !t.empty);
  t.burn(0.001, 20000, 400000);
  assert.ok(Math.abs(t.litres - 5) < 1e-9);
  assert.ok(t.low && !t.empty);
  assert.ok(Math.abs(t.average - 5) < 1e-9, `${t.average}`);
  t.burn(1, 10);
  assert.ok(t.empty);
  assert.equal(t.litres, 0);
  assert.equal(t.fill(80), 50);
  assert.equal(t.share, 1);
  // every road vehicle has a tank of its size; the tram, the aeroplane and on foot none
  assert.equal(tankFor('truck')?.fuel, 'diesel');
  assert.equal(tankFor('car')?.fuel, 'petrol');
  assert.equal(tankFor('tram'), null);
  assert.equal(tankFor('pedestrian'), null);
  assert.ok((tankFor('truck')?.capacity ?? 0) > (tankFor('lightTruck')?.capacity ?? 0));
  assert.ok(ENERGY_PER_LITRE.diesel > ENERGY_PER_LITRE.petrol);
});

test('the pump: the litres and the price count up until the tank is full, slowly at first', () => {
  const t = new FuelTank(tank('car'), 0.2);
  const f = new FillUp(1.799, 1.6);
  f.step(0.25, t);
  const first = f.litres;
  assert.ok(first > 0 && first < 0.4 * 0.25 * 1.6 + 1e-9, `the first quarter second: ${first}`);
  let time = 0.25;
  while (!f.done && time < 200) {
    f.step(0.1, t);
    time += 0.1;
  }
  assert.ok(f.done);
  assert.equal(t.share, 1);
  assert.ok(Math.abs(f.litres - 40) < 0.05, `${f.litres} l`);
  assert.equal(f.cost, Math.round(f.litres * 1.799 * 100) / 100);
  assert.ok(time > 25 && time < 40, `${time.toFixed(1)} s for 40 l`);
});

test('a drive begins with some fuel: mostly a good part of the tank, now and then the reserve', () => {
  assert.ok(startShare(0.1, 0.5) < 0.2);
  assert.ok(startShare(0.5, 0) >= 0.3);
  assert.ok(startShare(0.99, 1) <= 0.95);
});

test('a load makes the truck heavier, its centre of mass higher and further back, and slower to pull away', () => {
  const load = { mass: 2000, z: 0.5, y: 1.85, len: 3.75, wid: 1.7, hgt: 1.3 };
  const s = withPayload(TRUCK, load);
  assert.equal(s.mass, TRUCK.mass + 2000);
  assert.ok(s.cgHeight > TRUCK.cgHeight);
  assert.ok(s.cgToFront > TRUCK.cgToFront);
  for (let i = 0; i < 3; i++) assert.ok(s.inertia[i] > TRUCK.inertia[i]);
  assert.equal(withPayload(TRUCK, null), TRUCK);
  // 0 to 40 km/h at full throttle
  const time = (spec: VehicleSpec): number => {
    const v = makeCar(new PlaneGround(), spec);
    let t = 0;
    while (v.speed < 40 / 3.6 && t < 60) {
      v.step(DT, input({ throttle: 1, gear: 1 }));
      t += DT;
    }
    return t;
  };
  const empty = time(TRUCK);
  const loaded = time(s);
  assert.ok(loaded > empty * 1.1, `0–40 km/h: empty ${empty.toFixed(1)} s, loaded ${loaded.toFixed(1)} s`);
});
