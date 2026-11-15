// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The truck and its trailer.  Expectations from how a 12 t distribution
 * truck with a 6 t centre-axle trailer behaves: slow to get going, long to
 * stop, the trailer cuts the corner when pulled and breaks out when pushed.
 *
 *   node --test "tests/vehicle/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { TANDEM_TRAILER, Trailer } from '../../src/sim/trailer.ts';
import { TRUCK, TRUCK_HITCH } from '../../src/sim/vehicle/index.ts';
import type { DriverInput, Vehicle } from '../../src/sim/vehicle/index.ts';
import { DT, PlaneGround, input, kmh, makeCar } from './harness.ts';

const between = (v: number, lo: number, hi: number, what: string): void => {
  assert.ok(v >= lo && v <= hi, `${what}: ${v.toFixed(3)} not in [${lo}, ${hi}]`);
};

/** A truck, with its trailer coupled in line behind it if wanted. */
function rig(grade = 0, withTrailer = true): { truck: Vehicle; trailer: Trailer; ground: PlaneGround } {
  const ground = new PlaneGround(grade);
  const truck = makeCar(ground, TRUCK);
  const trailer = new Trailer(TANDEM_TRAILER, ground);
  if (withTrailer) trailer.coupleBehind(truck);
  return { truck, trailer, ground };
}

function drive(r: { truck: Vehicle; trailer: Trailer }, seconds: number, d: (t: number) => DriverInput, each?: (t: number) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const inp = d(i * DT);
    r.truck.step(DT, inp);
    r.trailer.step(DT, r.truck, inp);
    each?.((i + 1) * DT);
  }
}

test('the truck alone: stands, creeps, pulls, stops', () => {
  const r = rig(0, false);
  drive(r, 5, () => input({ handbrake: 1, gear: -2 }));
  assert.ok(Math.abs(r.truck.speed) < 0.001, 'stands');
  between(r.truck.rpm, 560, 640, 'idle');
  const loads = r.truck.wheels.map((w) => w.load);
  between((loads[0] + loads[1]) / (loads[0] + loads[1] + loads[2] + loads[3]), 0.38, 0.42, 'front axle share');
  drive(r, 10, () => input({ gear: 1 }));
  between(kmh(r.truck), 2, 5, 'creeps in D at idle');
  let t50 = -1;
  const shifts: number[] = [];
  drive(r, 40, () => input({ gear: 1, throttle: 1 }), (t) => {
    if (t50 < 0 && kmh(r.truck) >= 50) t50 = t;
    if (shifts[shifts.length - 1] !== r.truck.gear) shifts.push(r.truck.gear);
  });
  between(t50, 5, 12, 'seconds to 50 km/h without a trailer');
  for (let i = 1; i < shifts.length; i++) assert.ok(shifts[i] > shifts[i - 1], `the gearbox does not hunt: ${shifts.join(' ')}`);
  between(r.truck.rpm, 900, 2100, 'a diesel: never far above 2000 rpm');
  const v0 = r.truck.speed;
  const z0 = r.truck.pos[2];
  let stop = -1;
  drive(r, 10, () => input({ gear: 1, brake: 1 }), (t) => {
    if (stop < 0 && Math.abs(r.truck.speed) < 0.1) stop = t;
  });
  const decel = (v0 * v0) / (2 * Math.abs(r.truck.pos[2] - z0));
  between(decel, 5.5, 7.8, 'full braking (m/s²)');
});

test('with the trailer: slower to get going, the trailer follows in line', () => {
  const solo = rig(0, false);
  const combo = rig();
  let tSolo = -1;
  let tCombo = -1;
  drive(solo, 30, () => input({ gear: 1, throttle: 1 }), (t) => {
    if (tSolo < 0 && kmh(solo.truck) >= 50) tSolo = t;
  });
  drive(combo, 30, () => input({ gear: 1, throttle: 1 }), (t) => {
    if (tCombo < 0 && kmh(combo.truck) >= 50) tCombo = t;
  });
  assert.ok(tCombo > tSolo * 1.35 && tCombo < tSolo * 2, `the trailer's 6 t are felt: ${tSolo.toFixed(1)} s alone, ${tCombo.toFixed(1)} s with it`);
  const { truck, trailer } = combo;
  assert.ok(Math.abs(trailer.articulation) < 0.01, 'in line');
  between(trailer.speed / truck.speed, 0.99, 1.01, 'same speed');
  // the axle group is the drawbar's length behind the coupling
  const hitch: number[] = [0, 0, 0];
  Trailer.truckHitch(truck, hitch);
  between(Math.hypot(hitch[0] - trailer.x, hitch[2] - trailer.z), TANDEM_TRAILER.hitchToAxle - 0.01, TANDEM_TRAILER.hitchToAxle + 0.01, 'drawbar length');
  between(hitch[1] - trailer.y, TRUCK_HITCH.height - 0.15, TRUCK_HITCH.height + 0.15, 'coupling height');
  // braking: the trailer brakes itself and does not shove the truck
  const v0 = truck.speed;
  const z0 = truck.pos[2];
  drive(combo, 12, () => input({ gear: 1, brake: 1 }));
  assert.ok(Math.abs(truck.speed) < 0.05, 'stopped');
  const decel = (v0 * v0) / (2 * Math.abs(truck.pos[2] - z0));
  between(decel, 5, 7.6, 'full braking of the combination (m/s²)');
  assert.ok(Math.abs(trailer.articulation) < 0.02, 'still in line after braking');
});

test('on a slope: the handbrake holds truck and trailer, without it they roll back', () => {
  const r = rig(0.1);
  drive(r, 8, () => input({ handbrake: 1, gear: 0 }));
  assert.ok(Math.abs(r.truck.speed) < 0.01, `held: ${r.truck.speed}`);
  drive(r, 4, () => input({ gear: 0 }));
  assert.ok(r.truck.speed < -0.8, `rolls back: ${r.truck.speed}`);
});

test('pulled round a bend the trailer cuts the corner', () => {
  const r = rig();
  drive(r, 6, () => input({ gear: 1, throttle: 0.5 }));
  // a steady left turn at walking pace
  drive(r, 40, () => input({ gear: 1, throttle: kmh(r.truck) < 12 ? 0.35 : 0, steer: -0.6 }));
  // both turn about the same centre at the same rate: the radius of each path is its speed over that rate
  const yaw0 = r.truck.yaw;
  let turned = 0;
  let last = yaw0;
  let vTruck = 0;
  let vTrailer = 0;
  let n = 0;
  drive(r, 3, () => input({ gear: 1, throttle: kmh(r.truck) < 12 ? 0.35 : 0, steer: -0.6 }), () => {
    let d = r.truck.yaw - last;
    d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
    turned += d;
    last = r.truck.yaw;
    vTruck += r.truck.speed;
    vTrailer += r.trailer.speed;
    n++;
  });
  assert.ok(turned > 0.5, `turning left: ${turned.toFixed(2)} rad in 3 s`);
  const rate = turned / 3;
  const rTruck = vTruck / n / rate;
  const rTrailer = vTrailer / n / rate;
  between(rTruck, 6, 30, 'radius of the truck\'s circle (m)');
  assert.ok(rTrailer < rTruck - 1, `the trailer's axle runs well inside the truck's track: ${rTrailer.toFixed(2)} m against ${rTruck.toFixed(2)} m`);
  between(Math.abs(r.trailer.articulation), 0.15, 1.3, 'steady angle between truck and trailer');
  assert.ok(r.trailer.articulation > 0, 'turning left, the truck points left of the trailer');
});

test('pushed backwards the trailer breaks out – unless the driver steers against it', () => {
  // hands off the wheel: a small angle grows
  const r = rig();
  r.trailer.x += 0.15; // the axle group 15 cm out of line
  drive(r, 1, () => input({ gear: -1, handbrake: 1, brake: 1 }));
  const start = Math.abs(r.trailer.articulation);
  between(start, 0.02, 0.04, 'a small angle to begin with');
  drive(r, 14, () => input({ gear: -1, throttle: kmh(r.truck) > -5 ? 0.3 : 0 }));
  assert.ok(r.truck.speed < -0.5, 'reversing');
  assert.ok(Math.abs(r.trailer.articulation) > 0.3, `the angle grew from ${start.toFixed(3)} to ${Math.abs(r.trailer.articulation).toFixed(3)}`);

  // a driver who turns the wheel against the angle as soon as it shows keeps the trailer in line
  const k = rig();
  k.trailer.x += 0.15;
  let worst = 0;
  drive(k, 30, () => input({ gear: -1, throttle: kmh(k.truck) > -4 ? 0.3 : 0, steer: Math.max(-1, Math.min(1, -k.trailer.articulation * 6)) }), (t) => {
    if (t > 6) worst = Math.max(worst, Math.abs(k.trailer.articulation));
  });
  assert.ok(k.truck.pos[2] > 15, `reversed a good way: ${k.truck.pos[2].toFixed(1)} m`);
  assert.ok(worst < 0.1, `kept in line: ${worst.toFixed(3)}`);
});

test('coupling: the trailer stands by itself until the truck backs up to it', () => {
  const r = rig(0, false);
  // the trailer stands 12 m behind the truck's coupling, in line
  const hitch: number[] = [0, 0, 0];
  Trailer.truckHitch(r.truck, hitch);
  r.trailer.place(hitch[0], hitch[2] + 12 + TANDEM_TRAILER.hitchToAxle, 0);
  assert.equal(r.trailer.coupled, false);
  const before = r.trailer.offsetFrom(r.truck);
  between(before.dist, 11.9, 12.1, 'distance to the coupling eye');
  drive(r, 6, () => input({ gear: 1, throttle: 0.6 }));
  drive(r, 5, () => input({ gear: 1, brake: 1 }));
  assert.ok(Math.abs(r.trailer.x) < 1e-9 && r.trailer.speed === 0, 'an uncoupled trailer stays where it is');
  // back up to it
  let t = 0;
  while (r.trailer.offsetFrom(r.truck).dist > 0.2 && t < 60) {
    const far = r.trailer.offsetFrom(r.truck).dist;
    // quickly at first, at a crawl for the last metres
    const inp = input({ gear: -1, throttle: kmh(r.truck) > -(far > 3 ? 5 : 1.2) ? 0.25 : 0, brake: kmh(r.truck) < -(far > 3 ? 6 : 1.6) ? 0.3 : 0 });
    r.truck.step(DT, inp);
    r.trailer.step(DT, r.truck, inp);
    t += DT;
  }
  const at = r.trailer.offsetFrom(r.truck);
  assert.ok(at.dist <= 0.2 && Math.abs(at.angle) < 0.05, `backed up to the eye: ${at.dist.toFixed(2)} m, ${at.angle.toFixed(3)} rad`);
  r.trailer.couple();
  drive(r, 2, () => input({ gear: 1, brake: 1 }));
  drive(r, 12, () => input({ gear: 1, throttle: 0.7 }));
  assert.ok(r.trailer.coupled && r.trailer.speed > 3 && Math.abs(r.trailer.articulation) < 0.05, 'coupled, it comes along');
  r.trailer.uncouple();
  const x = r.trailer.x;
  const z = r.trailer.z;
  drive(r, 5, () => input({ gear: 1, throttle: 0.7 }));
  assert.ok(r.trailer.x === x && r.trailer.z === z && r.trailer.parked, 'uncoupled, it stays behind on its own brake');
});
