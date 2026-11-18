// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mopeds and motorcycles over uneven ground.  A player found the moped
 * jumping and flipping "like a spring" on anything but a flat road: the
 * bump stop at the end of the suspension's travel was a car's (260 kN/m,
 * undamped), which off a kerb handed a 200 kg machine its blow straight
 * back and threw it a metre into the air.  Here each machine is ridden at a
 * steady speed over kerbs, a ramp with its crest, a cross slope, steps in
 * the ground and potholes: it must stay on its wheels, never rise more than
 * a few centimetres off the ground and keep going.
 *
 *   node --test tests/vehicle/bikeride.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { bikeLean, MOPED, MOTORCYCLE_125, MOTORCYCLE_AUTOMATIC } from '../../src/sim/vehicle/fleet.ts';
import { Vehicle } from '../../src/sim/vehicle/index.ts';
import type { Ground, GroundSample, VehicleSpec } from '../../src/sim/vehicle/index.ts';
import { DT, input } from './harness.ts';

type Height = (x: number, z: number) => number;

/** A ground given by its height; the normal from small differences. */
class Profile implements Ground {
  readonly f: Height;
  constructor(f: Height) {
    this.f = f;
  }
  sample(x: number, z: number, _y: number, out: GroundSample): void {
    const e = 0.02;
    const y = this.f(x, z);
    const nx = -(this.f(x + e, z) - y) / e;
    const nz = -(this.f(x, z + e) - y) / e;
    const l = Math.hypot(nx, 1, nz);
    out.y = y;
    out.nx = nx / l;
    out.ny = 1 / l;
    out.nz = nz / l;
    out.grip = 1;
    out.rolling = 1;
  }
}

/** distance along the way (it rides north, towards −z) into the uneven part, which begins 25 m ahead */
const into = (z: number): number => -z - 25;
const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export const PROFILES: Record<string, Height> = {
  'a kerb up (12 cm)': (_x, z) => (into(z) > 0 ? 0.12 : 0),
  'a kerb down (12 cm)': (_x, z) => (into(z) > 0 ? -0.12 : 0),
  // 10 % up over 12 m, a crest rounded over 14 m (gentle enough to stay on at 70 km/h), 10 % down
  'a ramp and its crest': (_x, z) => {
    const d = into(z);
    if (d <= 0) return 0;
    if (d < 12) return d * 0.1;
    if (d < 26) return 1.2 + 0.1 * (d - 12) - (0.2 / 28) * (d - 12) ** 2;
    return Math.max(0, 1.2 - 0.1 * (d - 26));
  },
  // the road falls 10 % to the side, and a 10 cm step across it
  'a cross slope with a step': (x, z) => 0.1 * x * smooth(into(z) / 5) + (into(z) > 15 ? 0.1 : 0),
  // terrain tiles: steps of 6 cm along and 4 cm across every 2 m
  'steps in the ground': (x, z) => (into(z) <= 0 ? 0 : Math.floor(into(z) / 2) * 0.06 + Math.floor((x + 1) / 2) * 0.04),
  // 8 cm deep, 1.5 m long, every 4.5 m
  potholes: (_x, z) => (into(z) > 0 && Math.floor(into(z) / 1.5) % 3 === 1 ? -0.08 : 0),
  // rolling field: waves of 5 cm, 12 m long, short ripples of 2 cm and a tilt to the side
  'a bumpy field': (x, z) => smooth(into(z) / 4) * (0.05 * Math.sin(into(z) * 0.52) + 0.02 * Math.sin(into(z) * 4.1 + x) + 0.04 * x),
};

interface Ride {
  minUpright: number;
  /** highest the body rose above the ground under its wheels (m) */
  rise: number;
  /** longest time with no wheel on the ground (s) */
  airborne: number;
  kmh: number;
}

/** Ride `spec` north at `kmh` over `f` for 9 s; a simple rider holds the speed. */
export function ride(spec: VehicleSpec, f: Height, kmh: number): Ride {
  const g = new Profile(f);
  const v = new Vehicle(spec, g);
  v.teleport(0, 0, 0, 0);
  v.resetDrivetrain(true);
  // start rolling at the speed already, so that every machine reaches the uneven part as fast as asked
  v.vel[2] = -kmh / 3.6;
  for (const w of v.wheels) w.omega = kmh / 3.6 / spec.wheelRadius;
  const p = [0, 0, 0];
  const wf = [0, 0, 0];
  const wr = [0, 0, 0];
  let minUpright = 1;
  let rise = 0;
  let air = 0;
  let airborne = 0;
  // the ground it could be above without having jumped: off a drop a body falls freely, the reference with it
  let ref = 0;
  let refV = 0;
  const n = Math.round(9 / DT);
  for (let i = 0; i < n; i++) {
    const err = kmh - v.speed * 3.6;
    v.step(DT, input({ gear: 1, throttle: Math.max(0, Math.min(1, err * 0.3)), brake: Math.max(0, Math.min(1, -err * 0.1)) }));
    minUpright = Math.min(minUpright, v.upright);
    // the ground under the middle of each axle: the body's height is measured above the higher of the two
    v.getModelPosition(p);
    v.toWorld(0, -spec.cgHeight, -spec.cgToFront, wf);
    v.toWorld(0, -spec.cgHeight, spec.wheelbase - spec.cgToFront, wr);
    const under = Math.max(f(wf[0], wf[2]), f(wr[0], wr[2]), f(p[0], p[2]));
    refV -= 9.81 * DT;
    ref = Math.max(under, ref + refV * DT);
    if (ref === under) refV = Math.max(0, refV);
    if (i * DT > 0.5) rise = Math.max(rise, p[1] - ref);
    if (v.wheels.some((w) => w.contact)) air = 0;
    else airborne = Math.max(airborne, (air += DT));
  }
  return { minUpright, rise, airborne, kmh: v.speed * 3.6 };
}

const MACHINES: Array<[string, VehicleSpec, number[]]> = [
  ['the moped', MOPED.auto, [20, 44]],
  ['the 125', MOTORCYCLE_125.manual, [30, 60]],
  ['the big motorcycle', MOTORCYCLE_AUTOMATIC, [30, 70]],
];

for (const [who, spec, speeds] of MACHINES) {
  test(`${who} rides over kerbs, crests, slopes and holes without jumping or tipping`, () => {
    for (const [what, f] of Object.entries(PROFILES)) {
      for (const kmh of speeds) {
        const r = ride(spec, f, kmh);
        const at = `${who}, ${what}, ${kmh} km/h`;
        assert.ok(r.minUpright > 0.9, `${at}: tipped to upright ${r.minUpright.toFixed(3)}`);
        assert.ok(r.rise < 0.08, `${at}: rose ${r.rise.toFixed(3)} m off the ground`);
        assert.ok(r.airborne < 0.15, `${at}: ${r.airborne.toFixed(2)} s with no wheel on the ground`);
        // (it keeps going: over the steps the moped's 3 kW lose some speed, as they would)
        assert.ok(r.kmh > kmh * 0.4 && r.kmh < kmh + 8, `${at}: came out at ${r.kmh.toFixed(1)} km/h`);
      }
    }
  });
}

test('the drawn lean follows the bend, not the bumps', () => {
  // 50 km/h round a bend of 50 m: v²/r = 3.86 m/s², about 21°
  const v = 50 / 3.6;
  assert.ok(Math.abs(bikeLean(v, -v / 50) - Math.atan(v ** 2 / 50 / 9.81)) < 1e-9);
  assert.ok(bikeLean(v, v / 50) < 0, 'a left bend leans to the left');
  assert.ok(bikeLean(v, 0) === 0);
  assert.equal(bikeLean(Number.NaN, 1), 0);
  assert.ok(bikeLean(40, 10) > -0.7, 'at most 39°');
});
