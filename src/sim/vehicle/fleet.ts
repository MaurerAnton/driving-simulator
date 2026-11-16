// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The vehicles of the other licence classes: a city bus (D), a tractor (T)
 * and a motorcycle (A) – generic vehicles of their kind, no real model is
 * reproduced.  (Car B and truck C/CE: spec.ts; the trailers: trailer.ts.)
 *
 * The motorcycle runs on the same four-wheel model as everything else: two
 * narrow pairs of wheels, its weight low, so that it neither tips over nor
 * needs balancing.  That it leans into a bend is drawn (render/fleet.ts),
 * not simulated.
 */
import { COMPACT_CAR, TRUCK } from './spec.ts';
import type { VehicleSpec } from './types.ts';

/** a box for the body's contact points: from y0 to y1, front to rear (z), half the width */
function corners(hw: number, y0: number, y1: number, front: number, rear: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const y of [y0, y1]) for (const z of [front, rear]) for (const x of [-hw, hw]) out.push([x, y, z]);
  return out;
}

/** A low-floor city bus, 12 m, 13.5 t as driven, engine at the back, automatic. */
export const BUS: VehicleSpec = {
  ...TRUCK,
  name: 'Linienbus 12 m, 220 kW, Automatik',
  mass: 13500,
  inertia: [175000, 170000, 18000],
  wheelbase: 5.9,
  track: 2.1,
  cgHeight: 1.15,
  cgToFront: 3.4, // 42 % of the weight on the front axle
  wheelRadius: 0.5,
  wheelInertia: 18,
  springRate: [219000, 348000],
  damperBump: [12500, 18500],
  damperRebound: [21800, 32000],
  antiRoll: [160000, 130000],
  torqueCurve: TRUCK.torqueCurve.map(([rpm, t]): [number, number] => [rpm, Math.round(t * 1.25)]),
  brakeTorque: 52000,
  handbrakeTorque: 50000,
  maxWheelAngle: 0.82,
  dragArea: 7.2,
  length: 12.0,
  width: 2.55,
  bodyPoints: corners(1.27, 0.35, 3.05, -5.65, 6.35),
};

/** A tractor of 110 kW with a powershift gearbox, built for 40 km/h. */
export const TRACTOR: VehicleSpec = {
  ...TRUCK,
  name: 'Traktor 110 kW, Lastschaltgetriebe, 40 km/h',
  mass: 5600,
  inertia: [8500, 9000, 4200],
  wheelbase: 2.65,
  track: 1.85,
  cgHeight: 0.95,
  cgToFront: 1.59, // 40 % on the front axle
  wheelRadius: 0.72,
  wheelInertia: 26,
  springRate: [113000, 170000],
  damperBump: [5500, 8000],
  damperRebound: [9500, 14000],
  antiRoll: [30000, 25000],
  travel: 0.12,
  muPeak: 0.85,
  torqueCurve: [
    [0, 200],
    [600, 380],
    [1000, 560],
    [1400, 620],
    [1800, 560],
    [2100, 470],
    [2300, 300],
    [2400, 0],
  ],
  idleRpm: 800,
  limiterRpm: 2200,
  stallRpm: 400,
  engineInertia: 0.9,
  engineFriction: [40, 0.05],
  transmission: 'automatic',
  gearRatios: [6.2, 4.2, 2.9, 2.05, 1.45],
  reverseRatio: 6,
  finalDrive: 10.6,
  clutchTorque: 2000,
  brakeTorque: 32000,
  brakeBiasFront: 0.4,
  handbrakeTorque: 30000,
  steeringRatio: 18,
  maxWheelAngle: 0.9,
  dragArea: 3.6,
  rearDrive: true,
  length: 4.5,
  width: 2.3,
  bodyPoints: corners(1.0, 0.45, 2.95, -2.4, 2.1),
  // (the coupling takes about a third of the idle torque at a standstill: the tractor creeps, the brakes hold it)
  auto: { up: [1300, 2000], down: [900, 1300], kickdownRpm: 1800, lockOmega: 90, converter: 0.017 },
};

/** A mid-size motorcycle, 650 cm³, with its rider: 300 kg. */
export const MOTORCYCLE: VehicleSpec = {
  ...COMPACT_CAR,
  name: 'Motorrad 650 cm³, 6-Gang',
  mass: 300,
  inertia: [150, 130, 40],
  wheelbase: 1.45,
  // (wide and low enough that the "motorcycle" slides before it would tip – it is not balanced)
  track: 0.9,
  cgHeight: 0.25,
  cgToFront: 0.72,
  wheelRadius: 0.31,
  wheelInertia: 0.5,
  springRate: [9600, 9600],
  damperBump: [600, 600],
  damperRebound: [1000, 1000],
  antiRoll: [6000, 6000],
  travel: 0.14,
  muPeak: 1.1,
  torqueCurve: [
    [0, 20],
    [1000, 40],
    [3000, 55],
    [5000, 62],
    [6500, 64],
    [8000, 60],
    [9000, 52],
    [9500, 30],
    [10000, 0],
  ],
  idleRpm: 1300,
  limiterRpm: 9500,
  stallRpm: 700,
  engineInertia: 0.05,
  engineFriction: [3, 0.002],
  gearRatios: [2.6, 1.9, 1.5, 1.27, 1.11, 1.0],
  // (a motorcycle has no reverse gear: it is pushed back – here a crawl backwards)
  reverseRatio: 2.6,
  finalDrive: 5.6,
  clutchTorque: 140,
  drivelineEfficiency: 0.9,
  brakeTorque: 1200,
  brakeBiasFront: 0.7,
  handbrakeTorque: 600,
  steeringRatio: 1,
  maxWheelAngle: 0.6,
  dragArea: 0.45,
  length: 2.15,
  width: 0.85,
  bodyPoints: corners(0.3, 0.3, 1.2, -1.07, 1.08),
};

/** The same with a clutch that works itself (gears by hand), and with an automatic gearbox. */
export const MOTORCYCLE_AUTOCLUTCH: VehicleSpec = { ...MOTORCYCLE, name: 'Motorrad, Kupplungshilfe', autoClutch: true };
export const MOTORCYCLE_AUTOMATIC: VehicleSpec = {
  ...MOTORCYCLE,
  name: 'Motorrad, Automatik',
  transmission: 'automatic',
  // (a coupling sized for the small engine: at idle it takes less than half of what the engine makes, or it would stall)
  auto: { up: [4200, 8800], down: [2600, 4500], kickdownRpm: 7500, lockOmega: 160, converter: 0.001 },
};

/** A light truck of 7.5 t with a box body (class C1). */
export const LIGHT_TRUCK: VehicleSpec = {
  ...TRUCK,
  name: 'Lkw 7,5 t mit Kofferaufbau, 130 kW, automatisiertes Getriebe',
  mass: 5800,
  inertia: [26000, 25000, 6500],
  wheelbase: 3.9,
  track: 1.9,
  cgHeight: 1.1,
  cgToFront: 2.15,
  wheelRadius: 0.42,
  wheelInertia: 9,
  springRate: [105000, 170000],
  damperBump: [6200, 9500],
  damperRebound: [11000, 16500],
  antiRoll: [80000, 60000],
  torqueCurve: TRUCK.torqueCurve.map(([rpm, t]): [number, number] => [rpm, Math.round(t * 0.66)]),
  brakeTorque: 26000,
  handbrakeTorque: 24000,
  maxWheelAngle: 0.74,
  dragArea: 5.0,
  length: 7.4,
  width: 2.4,
  bodyPoints: corners(1.2, 0.55, 3.3, -3.35, 4.05),
};

/** A minibus for up to 16 passengers (class D1): 5 t, 7.4 m. */
export const MINIBUS: VehicleSpec = {
  ...BUS,
  name: 'Kleinbus 7,4 m, 120 kW, Automatik',
  mass: 4800,
  inertia: [21000, 20000, 4500],
  wheelbase: 4.3,
  track: 1.75,
  cgHeight: 1.0,
  cgToFront: 2.4,
  wheelRadius: 0.38,
  wheelInertia: 6,
  springRate: [80000, 120000],
  damperBump: [4800, 7000],
  damperRebound: [8400, 12200],
  antiRoll: [45000, 35000],
  torqueCurve: TRUCK.torqueCurve.map(([rpm, t]): [number, number] => [rpm, Math.round(t * 0.5)]),
  brakeTorque: 17000,
  handbrakeTorque: 16000,
  maxWheelAngle: 0.7,
  dragArea: 4.6,
  length: 7.4,
  width: 2.2,
  bodyPoints: corners(1.08, 0.35, 2.75, -3.35, 4.05),
};

/** A tractor built for 60 km/h (class T; the 40 km/h tractor is class L). */
export const TRACTOR_FAST: VehicleSpec = { ...TRACTOR, name: 'Traktor 150 kW, 60 km/h', finalDrive: TRACTOR.finalDrive * (40 / 60), torqueCurve: TRACTOR.torqueCurve.map(([rpm, t]): [number, number] => [rpm, Math.round(t * 1.3)]) };

/** The smaller motorcycles: a moped built for 45 km/h (AM), a 125 (A1), one of 35 kW (A2). */
function smaller(name: string, k: number, finalDrive: number): VehicleSpec {
  // (a smaller engine: less torque – and less friction and inertia inside it, or that would eat its torque)
  const [f0, f1] = MOTORCYCLE.engineFriction;
  return {
    ...MOTORCYCLE,
    name,
    torqueCurve: MOTORCYCLE.torqueCurve.map(([rpm, t]): [number, number] => [rpm, Math.round(t * k * 10) / 10]),
    engineFriction: [f0 * k, f1 * k],
    engineInertia: MOTORCYCLE.engineInertia * Math.max(0.3, k),
    clutchTorque: MOTORCYCLE.clutchTorque * Math.max(0.3, k),
    mass: MOTORCYCLE.mass - (1 - k) * 120,
    finalDrive,
  };
}
/** … each with a manual gearbox and an automatic one whose coupling is sized for its engine (or it would hold it down) */
function variants(name: string, k: number, finalDrive: number): { manual: VehicleSpec; auto: VehicleSpec } {
  const manual = smaller(name, k, finalDrive);
  const base = MOTORCYCLE_AUTOMATIC.auto as NonNullable<VehicleSpec['auto']>;
  return { manual, auto: { ...manual, name: `${name}, Automatik`, transmission: 'automatic', auto: { ...base, converter: base.converter * k } } };
}
// (geared for its 45 km/h: at the rev limit in top gear it runs 46)
export const MOPED = variants('Moped 50 cm³, 45 km/h', 0.12, 24);
export const MOTORCYCLE_125 = variants('Leichtkraftrad 125 cm³, 11 kW', 0.3, 7.2);
export const MOTORCYCLE_35KW = variants('Motorrad 35 kW', 0.75, 5.8);
