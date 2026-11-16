// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The vehicles one can learn with, one for each licence class: what each is
 * (its physics, its picture, its trailer), how big it is, and what the
 * rules ask of it beyond the signs –
 *
 *  - outside built-up areas and on the motorway it may be slower than the
 *    signs allow: § 3 Abs. 3 StVO (trucks over 7.5 t and every vehicle with
 *    a trailer but a car's: 60 km/h, buses and cars with a trailer: 80),
 *    § 18 Abs. 5 StVO (trucks, cars with a trailer: 80, coaches: 100);
 *  - over 3.5 t it turns right in town at walking pace (§ 9 Abs. 6 StVO);
 *  - a tractor built for 40 km/h may not use the motorway (§ 18 Abs. 1 StVO).
 */
import type { TrailerSpec } from '../sim/trailer.ts';
import { CAR_TRAILER, TANDEM_TRAILER, trailerOutline } from '../sim/trailer.ts';
import { BUS, MOTORCYCLE, MOTORCYCLE_AUTOCLUTCH, MOTORCYCLE_AUTOMATIC, TRACTOR } from '../sim/vehicle/fleet.ts';
import { COMPACT_CAR, COMPACT_CAR_AUTOCLUTCH, COMPACT_CAR_AUTOMATIC, TRUCK, withPower } from '../sim/vehicle/index.ts';
import type { VehicleSpec } from '../sim/vehicle/index.ts';
import { COMPACT_DIMS } from '../render/carBody.ts';

export type VehicleKind = 'car' | 'carTrailer' | 'motorcycle' | 'truckSolo' | 'truck' | 'bus' | 'tractor';
export const VEHICLE_KINDS: readonly VehicleKind[] = ['car', 'carTrailer', 'motorcycle', 'truckSolo', 'truck', 'bus', 'tractor'];

export type ModelKind = 'car' | 'truck' | 'bus' | 'tractor' | 'motorcycle';

export interface VehicleDef {
  kind: VehicleKind;
  /** the licence class it is learnt for */
  licence: string;
  /** i18n key of its name */
  name: string;
  model: ModelKind;
  /** its physics, for the gearbox the player chose (and the engine power, for the car) */
  spec(transmission: 'manual' | 'assist' | 'automatic', power: number): VehicleSpec;
  trailer: TrailerSpec | null;
  /** its outline in the plan from the model origin (the ground point below the middle of the wheelbase) */
  outline: { front: number; rear: number; hw: number };
  /** for walking round it: the axles (+ ahead) and half the track over the tyres; the driver's door, ahead of the origin, and its side (−1 left, 1 right; 0: none – a motorcycle) */
  axles: readonly number[];
  track: number;
  door: number;
  doorSide: number;
  /** circles along its axis that stand for it against walls and posts (metres from the origin, − = ahead), and their radius */
  circles: readonly number[];
  radius: number;
  /** how far behind it the camera stands (and at most) */
  zoom: number;
  zoomMax: number;
  /** at most this outside built-up areas and on the motorway (km/h), whatever the signs say – null: the signs alone */
  caps: { rural: number; motorway: number } | null;
  /** the fault when it is faster than that */
  capFault: string;
  /** its top speed by construction or governor (km/h; 0: none) */
  governed: number;
  /** over 3.5 t: walking pace when turning right in town */
  heavy: boolean;
  /** not allowed on the motorway */
  noMotorway: boolean;
  /** long: ways avoid turns that double back, the camera looks from higher up */
  long: boolean;
  /** the instruments are small or missing in its cockpit: the dashboard strip stays on */
  dash: boolean;
}

const carFront = COMPACT_DIMS.wheelbase / 2 + COMPACT_DIMS.frontOverhang;
const car: Omit<VehicleDef, 'kind' | 'licence' | 'name' | 'trailer' | 'caps' | 'capFault'> = {
  model: 'car',
  spec: (t, power) => withPower(t === 'automatic' ? COMPACT_CAR_AUTOMATIC : t === 'assist' ? COMPACT_CAR_AUTOCLUTCH : COMPACT_CAR, power),
  outline: { front: carFront, rear: COMPACT_DIMS.length - carFront, hw: COMPACT_DIMS.width / 2 },
  axles: [COMPACT_DIMS.wheelbase / 2, -COMPACT_DIMS.wheelbase / 2],
  track: COMPACT_DIMS.track / 2,
  door: 0.1,
  doorSide: -1,
  circles: [-1.28, -0.05, 1.18],
  radius: 0.93,
  zoom: 7,
  zoomMax: 18,
  governed: 0,
  heavy: false,
  noMotorway: false,
  long: false,
  dash: false,
};
const truck: Omit<VehicleDef, 'kind' | 'licence' | 'name' | 'trailer' | 'caps' | 'capFault' | 'zoom' | 'zoomMax'> = {
  model: 'truck',
  spec: () => TRUCK,
  outline: { front: 3.75, rear: 4.45, hw: 1.25 },
  axles: [2.35, -2.35],
  track: 1.1,
  door: 2.45,
  doorSide: -1,
  circles: [-2.5, -0.6, 1.3, 3.2],
  radius: 1.25,
  governed: 90,
  heavy: true,
  noMotorway: false,
  long: true,
  dash: true,
};

export const VEHICLES: Record<VehicleKind, VehicleDef> = {
  car: { ...car, kind: 'car', licence: 'B', name: 'vehCar', trailer: null, caps: null, capFault: 'speed' },
  carTrailer: {
    ...car,
    kind: 'carTrailer',
    licence: 'BE',
    name: 'vehCarTrailer',
    trailer: CAR_TRAILER,
    caps: { rural: 80, motorway: 80 },
    capFault: 'classSpeed',
    zoom: 10,
    zoomMax: 26,
    long: true,
  },
  motorcycle: {
    ...car,
    kind: 'motorcycle',
    licence: 'A',
    name: 'vehMotorcycle',
    model: 'motorcycle',
    spec: (t) => (t === 'automatic' ? MOTORCYCLE_AUTOMATIC : t === 'assist' ? MOTORCYCLE_AUTOCLUTCH : MOTORCYCLE),
    trailer: null,
    caps: null,
    capFault: 'speed',
    outline: { front: 1.07, rear: 1.08, hw: 0.42 },
    axles: [0.725, -0.725],
    track: 0.05,
    door: 0,
    doorSide: 0,
    circles: [-0.55, 0.55],
    radius: 0.45,
    zoom: 5,
    zoomMax: 14,
    dash: true,
  },
  truckSolo: { ...truck, kind: 'truckSolo', licence: 'C', name: 'vehTruckSolo', trailer: null, caps: { rural: 60, motorway: 80 }, capFault: 'classSpeed', zoom: 14, zoomMax: 32 },
  truck: { ...truck, kind: 'truck', licence: 'CE', name: 'vehTruck', trailer: TANDEM_TRAILER, caps: { rural: 60, motorway: 80 }, capFault: 'truckSpeed', zoom: 21, zoomMax: 45 },
  bus: {
    ...truck,
    kind: 'bus',
    licence: 'D',
    name: 'vehBus',
    model: 'bus',
    spec: () => BUS,
    trailer: null,
    caps: { rural: 80, motorway: 100 },
    capFault: 'classSpeed',
    outline: { front: 5.65, rear: 6.35, hw: 1.28 },
    axles: [2.95, -2.95],
    track: 1.05,
    // (the driver of a city bus gets in by the front door, on the right)
    door: 4.85,
    doorSide: 1,
    circles: [-4.6, -2.3, 0, 2.3, 4.6],
    radius: 1.3,
    zoom: 18,
    zoomMax: 40,
    governed: 100,
  },
  tractor: {
    ...car,
    kind: 'tractor',
    licence: 'T',
    name: 'vehTractor',
    model: 'tractor',
    spec: () => TRACTOR,
    trailer: null,
    caps: null,
    capFault: 'speed',
    outline: { front: 2.4, rear: 2.1, hw: 1.15 },
    axles: [1.325, -1.325],
    track: 0.95,
    door: -0.2,
    circles: [-1.4, 0, 1.3],
    radius: 1.15,
    zoom: 8,
    zoomMax: 20,
    governed: 40,
    heavy: true,
    noMotorway: true,
    dash: true,
  },
};

/** The outline of the trailer of a vehicle (null: it has none). */
export function trailerOf(def: VehicleDef): ReturnType<typeof trailerOutline> | null {
  return def.trailer ? trailerOutline(def.trailer) : null;
}

/** A vehicle kind from a setting or a link, or null. */
export function vehicleKind(v: unknown): VehicleKind | null {
  return typeof v === 'string' && (VEHICLE_KINDS as readonly string[]).includes(v) ? (v as VehicleKind) : null;
}
