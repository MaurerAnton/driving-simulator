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
import { BUS_TRAILER, CAR_TRAILER, LIGHT_TRUCK_TRAILER, MINIBUS_TRAILER, TANDEM_TRAILER, trailerOutline } from '../sim/trailer.ts';
import { BUS, LIGHT_TRUCK, MINIBUS, MOPED, MOTORCYCLE, MOTORCYCLE_125, MOTORCYCLE_35KW, MOTORCYCLE_AUTOCLUTCH, MOTORCYCLE_AUTOMATIC, TRACTOR, TRACTOR_FAST } from '../sim/vehicle/fleet.ts';
import { COMPACT_CAR, COMPACT_CAR_AUTOCLUTCH, COMPACT_CAR_AUTOMATIC, TRUCK, withPower } from '../sim/vehicle/index.ts';
import type { VehicleSpec } from '../sim/vehicle/index.ts';
import { COMPACT_DIMS } from '../render/carBody.ts';

export type VehicleKind =
  | 'car'
  | 'carTrailer'
  | 'moped'
  | 'motorcycle125'
  | 'motorcycle35'
  | 'motorcycle'
  | 'lightTruck'
  | 'lightTruckTrailer'
  | 'truckSolo'
  | 'truck'
  | 'minibus'
  | 'minibusTrailer'
  | 'bus'
  | 'busTrailer'
  | 'tractorSlow'
  | 'tractor'
  | 'tram';
/** in the order of the licence classes: B, BE, AM, A1, A2, A, C1, C1E, C, CE, D1, D1E, D, DE, L, T – and the tram */
export const VEHICLE_KINDS: readonly VehicleKind[] = ['car', 'carTrailer', 'moped', 'motorcycle125', 'motorcycle35', 'motorcycle', 'lightTruck', 'lightTruckTrailer', 'truckSolo', 'truck', 'minibus', 'minibusTrailer', 'bus', 'busTrailer', 'tractorSlow', 'tractor', 'tram'];

export type ModelKind = 'car' | 'truck' | 'truckLight' | 'bus' | 'minibus' | 'tractor' | 'motorcycle' | 'tram';

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

/** what the motorcycles of every class have in common */
const MOTO_DEF: Omit<VehicleDef, 'spec'> & { spec: VehicleDef['spec'] } = {
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
};

/** a 7.5 t truck (class C1) */
const LIGHT_TRUCK_DEF: VehicleDef = {
  ...truck,
  kind: 'lightTruck',
  licence: 'C1',
  name: 'vehLightTruck',
  model: 'truckLight',
  spec: () => LIGHT_TRUCK,
  trailer: null,
  caps: { rural: 80, motorway: 80 },
  capFault: 'classSpeed',
  outline: { front: 3.35, rear: 4.05, hw: 1.2 },
  axles: [1.95, -1.95],
  track: 0.95,
  door: 2.05,
  circles: [-2.3, -0.6, 1.1, 2.8],
  radius: 1.2,
  zoom: 13,
  zoomMax: 30,
};

/** a minibus (class D1): its door is at the front on the right */
const MINIBUS_DEF: VehicleDef = {
  ...truck,
  kind: 'minibus',
  licence: 'D1',
  name: 'vehMinibus',
  model: 'minibus',
  spec: () => MINIBUS,
  trailer: null,
  caps: { rural: 80, motorway: 100 },
  capFault: 'classSpeed',
  outline: { front: 3.35, rear: 4.05, hw: 1.1 },
  axles: [2.15, -2.15],
  track: 0.875,
  door: 1.25,
  doorSide: 1,
  circles: [-2.3, -0.6, 1.1, 2.8],
  radius: 1.1,
  zoom: 12,
  zoomMax: 28,
  governed: 100,
};

const BUS_DEF: VehicleDef = {
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
  motorcycle: { ...MOTO_DEF },
  truckSolo: { ...truck, kind: 'truckSolo', licence: 'C', name: 'vehTruckSolo', trailer: null, caps: { rural: 60, motorway: 80 }, capFault: 'classSpeed', zoom: 14, zoomMax: 32 },
  truck: { ...truck, kind: 'truck', licence: 'CE', name: 'vehTruck', trailer: TANDEM_TRAILER, caps: { rural: 60, motorway: 80 }, capFault: 'truckSpeed', zoom: 21, zoomMax: 45 },
  bus: BUS_DEF,
  tractor: {
    ...car,
    kind: 'tractor',
    licence: 'T',
    name: 'vehTractor',
    model: 'tractor',
    spec: () => TRACTOR_FAST,
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
    governed: 60,
    heavy: true,
    noMotorway: true,
    dash: true,
  },
  tractorSlow: {
    ...car,
    kind: 'tractorSlow',
    licence: 'L',
    name: 'vehTractorSlow',
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
  moped: {
    ...MOTO_DEF,
    kind: 'moped',
    licence: 'AM',
    name: 'vehMoped',
    spec: (t) => (t === 'automatic' ? MOPED.auto : t === 'assist' ? { ...MOPED.manual, autoClutch: true } : MOPED.manual),
    governed: 45,
    noMotorway: true,
  },
  motorcycle125: {
    ...MOTO_DEF,
    kind: 'motorcycle125',
    licence: 'A1',
    name: 'vehMotorcycle125',
    spec: (t) => (t === 'automatic' ? MOTORCYCLE_125.auto : t === 'assist' ? { ...MOTORCYCLE_125.manual, autoClutch: true } : MOTORCYCLE_125.manual),
  },
  motorcycle35: {
    ...MOTO_DEF,
    kind: 'motorcycle35',
    licence: 'A2',
    name: 'vehMotorcycle35',
    spec: (t) => (t === 'automatic' ? MOTORCYCLE_35KW.auto : t === 'assist' ? { ...MOTORCYCLE_35KW.manual, autoClutch: true } : MOTORCYCLE_35KW.manual),
  },
  lightTruck: { ...LIGHT_TRUCK_DEF },
  lightTruckTrailer: {
    ...LIGHT_TRUCK_DEF,
    kind: 'lightTruckTrailer',
    licence: 'C1E',
    name: 'vehLightTruckTrailer',
    trailer: LIGHT_TRUCK_TRAILER,
    caps: { rural: 60, motorway: 80 },
    zoom: 16,
    zoomMax: 36,
  },
  minibus: { ...MINIBUS_DEF },
  minibusTrailer: { ...MINIBUS_DEF, kind: 'minibusTrailer', licence: 'D1E', name: 'vehMinibusTrailer', trailer: MINIBUS_TRAILER, caps: { rural: 80, motorway: 80 }, zoom: 15, zoomMax: 34 },
  busTrailer: { ...BUS_DEF, kind: 'busTrailer', licence: 'DE', name: 'vehBusTrailer', trailer: BUS_TRAILER, caps: { rural: 80, motorway: 80 }, zoom: 22, zoomMax: 48 },
  // The tram runs on the tracks (sim/tramdrive.ts), not on the road physics: what is given here is
  // what the rest of the game needs of a vehicle – where the driver sits, what the camera keeps to –
  // measured from the middle of its first car.
  tram: {
    ...BUS_DEF,
    kind: 'tram',
    licence: 'BOStrab',
    name: 'vehTram',
    model: 'tram',
    spec: () => BUS,
    caps: null,
    capFault: 'speed',
    outline: { front: 4.7, rear: 4.7, hw: 1.2 },
    door: 0,
    doorSide: 0,
    circles: [-3, 0, 3],
    radius: 1.25,
    zoom: 22,
    zoomMax: 50,
    governed: 70,
    heavy: true,
    noMotorway: true,
    long: true,
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
