// SPDX-License-Identifier: AGPL-3.0-only
import type { VehicleSpec } from './types.ts';

/**
 * A typical driving-school compact hatchback: front-wheel drive, 1.5 l turbo
 * petrol (~110 kW, 250 N·m), 6-speed manual, ~1.3 t.  Generic on purpose –
 * no real model is reproduced.
 */
export const COMPACT_CAR: VehicleSpec = {
  name: 'Kompaktwagen 1.5 Benzin, 6-Gang',
  mass: 1375,
  inertia: [1900, 2000, 500],
  wheelbase: 2.63,
  track: 1.54,
  cgHeight: 0.54,
  cgToFront: 1.052, // 60 % of the weight on the front axle
  wheelRadius: 0.316,
  wheelInertia: 1.1,

  // ride frequencies ≈ 1.35 Hz front / 1.5 Hz rear, damping ratio ≈ 0.33
  springRate: [29600, 24400],
  damperBump: [1700, 1250],
  damperRebound: [3000, 2250],
  antiRoll: [14000, 7000],
  travel: 0.24,

  muPeak: 1.05,
  slipRatioPeak: 0.11,
  slipAnglePeak: 0.13,
  loadSensitivity: 0.1,
  relaxLong: 0.15,
  relaxLat: 0.32,
  rollingResistance: 0.011,

  torqueCurve: [
    [0, 60],
    [500, 110],
    [800, 145],
    [1000, 172],
    [1300, 216],
    [1500, 250],
    [3500, 250],
    [4500, 236],
    [5000, 216],
    [5500, 195],
    [6000, 176],
    [6500, 150],
    [7000, 90],
    [7500, 0],
  ],
  idleRpm: 800,
  limiterRpm: 6500,
  stallRpm: 400,
  engineInertia: 0.16,
  engineFriction: [14, 0.0085],

  transmission: 'manual',
  gearRatios: [3.77, 2.09, 1.32, 0.98, 0.78, 0.64],
  reverseRatio: 3.6,
  finalDrive: 3.65,
  clutchTorque: 420,
  drivelineEfficiency: 0.92,
  autoClutch: false,

  brakeTorque: 5200,
  brakeBiasFront: 0.68,
  handbrakeTorque: 2800,
  abs: true,

  steeringRatio: 14.5,
  maxWheelAngle: 0.576,

  dragArea: 0.65,
};

/** Same car with the clutch operated automatically (keyboard-friendly). */
export const COMPACT_CAR_AUTOCLUTCH: VehicleSpec = { ...COMPACT_CAR, name: 'Kompaktwagen, Kupplungshilfe', autoClutch: true };

/** Same car with an automatic gearbox (licence code B197 / automatic training). */
export const COMPACT_CAR_AUTOMATIC: VehicleSpec = {
  ...COMPACT_CAR,
  name: 'Kompaktwagen 1.5 Benzin, Automatik',
  transmission: 'automatic',
  gearRatios: [3.9, 2.3, 1.45, 1.05, 0.82, 0.66],
  // torque converter, pump and planetary sets cost a little more
  drivelineEfficiency: 0.87,
};
