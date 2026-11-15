// SPDX-License-Identifier: AGPL-3.0-only
/** Shared helpers for the vehicle dynamics tests. */
import { COMPACT_CAR, Vehicle } from '../../src/sim/vehicle/index.ts';
import type { DriverInput, Ground, GroundSample, VehicleSpec } from '../../src/sim/vehicle/index.ts';

export const DT = 1 / 240;

/** Inclined plane rising towards north (-Z) with the given grade (0.15 = 15 %). */
export class PlaneGround implements Ground {
  grade: number;
  grip: number;
  rolling: number;
  /** optional step: ground is `stepHeight` higher for z < stepZ */
  stepZ = -Infinity;
  stepHeight = 0;

  constructor(grade = 0, grip = 1, rolling = 1) {
    this.grade = grade;
    this.grip = grip;
    this.rolling = rolling;
  }

  sample(_x: number, z: number, _yRef: number, out: GroundSample): void {
    const l = Math.hypot(1, this.grade);
    out.y = -z * this.grade + (z < this.stepZ ? this.stepHeight : 0);
    out.nx = 0;
    out.ny = 1 / l;
    out.nz = this.grade / l;
    out.grip = this.grip;
    out.rolling = this.rolling;
  }
}

export function input(over: Partial<DriverInput> = {}): DriverInput {
  return { steer: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 0, gear: 0, ignition: true, starter: false, ...over };
}

export function makeCar(ground: Ground = new PlaneGround(), spec: VehicleSpec = COMPACT_CAR, running = true): Vehicle {
  const v = new Vehicle(spec, ground);
  const g = ground as PlaneGround;
  v.teleport(0, typeof g.grade === 'number' ? 0 : 0, 0, 0);
  v.resetDrivetrain(running);
  return v;
}

/** Run for `seconds`, calling `drive` before every step to obtain the inputs. */
export function run(v: Vehicle, seconds: number, drive: (t: number, v: Vehicle) => DriverInput, each?: (t: number, v: Vehicle) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    v.step(DT, drive(t, v));
    each?.(t + DT, v);
  }
}

export const kmh = (v: Vehicle): number => v.speed * 3.6;

/** Idealised test driver: launch, full throttle, shift at the given rpm. */
export function sprintDriver(shiftRpm = 6200): (t: number, v: Vehicle) => DriverInput {
  let gear = 1;
  let shiftT = -1;
  return (t, v) => {
    if (t < 0.25) return input({ gear: 1, clutch: 1, throttle: 0.55 });
    if (shiftT >= 0) {
      if (t - shiftT < 0.25) return input({ gear, clutch: 1, throttle: 0 });
      shiftT = -1;
    }
    if (v.rpm > shiftRpm && gear < 6) {
      gear++;
      shiftT = t;
      return input({ gear, clutch: 1, throttle: 0 });
    }
    // slip the clutch off the line, then full power
    const launch = t < 1.6 ? Math.max(0, 0.62 - (t - 0.25) * 0.5) : 0;
    return input({ gear, clutch: launch, throttle: 1 });
  };
}
