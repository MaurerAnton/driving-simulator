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
import { BUS, LIGHT_TRUCK, MINIBUS, MOTORCYCLE, TRACTOR, TRACTOR_FAST, variants } from '../sim/vehicle/fleet.ts';
import { COMPACT_CAR, COMPACT_CAR_AUTOCLUTCH, COMPACT_CAR_AUTOMATIC, TRUCK, atPower, peakPowerPs, withPower } from '../sim/vehicle/index.ts';
import type { VehicleSpec } from '../sim/vehicle/index.ts';
import { COMPACT_DIMS } from '../render/carBody.ts';
import { TRAINER } from '../sim/flightspec.ts';
import { LOADER_TRUCK_SPEC, MOBILE_CRANE_SPEC } from '../sim/crane.ts';
import type { CraneType } from '../sim/crane.ts';
import { FORKLIFT_SPEC } from '../sim/forklift.ts';
import { HEAVY_RIGID, SEMI_TRAILER, TRACTOR_OUTLINE, TRACTOR_UNIT } from '../sim/semitrailer.ts';

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
  | 'semi'
  | 'minibus'
  | 'minibusTrailer'
  | 'bus'
  | 'busTrailer'
  | 'tractorSlow'
  | 'tractor'
  | 'tram'
  | 'plane'
  | 'mobileCrane'
  | 'loaderCrane'
  | 'towerCrane'
  | 'forklift'
  | 'pedestrian';
/** in the order of the licence classes: B, BE, AM, A1, A2, A, C1, C1E, C, CE (drawbar, articulated), D1, D1E, D, DE, L, T – the tram, the aeroplane, the cranes, and on foot */
export const VEHICLE_KINDS: readonly VehicleKind[] = ['car', 'carTrailer', 'moped', 'motorcycle125', 'motorcycle35', 'motorcycle', 'lightTruck', 'lightTruckTrailer', 'truckSolo', 'truck', 'semi', 'minibus', 'minibusTrailer', 'bus', 'busTrailer', 'tractorSlow', 'tractor', 'tram', 'plane', 'mobileCrane', 'loaderCrane', 'towerCrane', 'forklift', 'pedestrian'];

/** the kinds of vehicle that are driven on the road (not the tram on its tracks, not the aeroplane, not the tower crane on its base, not on foot) */
export const ROAD_VEHICLE_KINDS: readonly VehicleKind[] = VEHICLE_KINDS.filter((k) => k !== 'tram' && k !== 'pedestrian' && k !== 'plane' && k !== 'towerCrane' && k !== 'forklift');

export type ModelKind = 'car' | 'truck' | 'truckLight' | 'truckHeavy' | 'semi' | 'bus' | 'minibus' | 'tractor' | 'motorcycle' | 'tram' | 'walker' | 'plane' | 'towerCrane' | 'mobileCrane' | 'loaderCrane' | 'forklift';

export interface VehicleDef {
  kind: VehicleKind;
  /** the licence class it is learnt for */
  licence: string;
  /** i18n key of its name */
  name: string;
  model: ModelKind;
  /** its physics, for the gearbox and the engine power (PS) the player chose */
  spec(transmission: 'manual' | 'assist' | 'automatic', power: number): VehicleSpec;
  /** the engine powers one may choose for it (PS) – within what its licence class allows – and the one it comes with */
  powers: readonly number[];
  power: number;
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
  /** a crane (game/craneplay.ts): its free drive is the work on the construction site */
  crane?: CraneType;
}

const carFront = COMPACT_DIMS.wheelbase / 2 + COMPACT_DIMS.frontOverhang;
const car: Omit<VehicleDef, 'kind' | 'licence' | 'name' | 'trailer' | 'caps' | 'capFault'> = {
  model: 'car',
  spec: (t, power) => withPower(t === 'automatic' ? COMPACT_CAR_AUTOMATIC : t === 'assist' ? COMPACT_CAR_AUTOCLUTCH : COMPACT_CAR, power),
  powers: [60, 75, 95, 115, 150, 200],
  power: 75,
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
  spec: (_t, power) => atPower(TRUCK, power),
  powers: [218, 257, 300, 354],
  power: 257,
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

/**
 * A motorcycle of a class: the big one with an engine of the power chosen,
 * `size` saying how much smaller the machine is, geared with `finalDrive`.
 */
const BIG_BIKE_PS = peakPowerPs(MOTORCYCLE);
function bike(name: string, size: number, finalDrive: number): VehicleDef['spec'] {
  return (t, power) => {
    const v = variants(name, power / BIG_BIKE_PS, finalDrive, size);
    return t === 'automatic' ? v.auto : t === 'assist' ? { ...v.manual, autoClutch: true } : v.manual;
  };
}

/** what the motorcycles of every class have in common */
const MOTO_DEF: Omit<VehicleDef, 'spec'> & { spec: VehicleDef['spec'] } = {
  ...car,
  kind: 'motorcycle',
  licence: 'A',
  name: 'vehMotorcycle',
  model: 'motorcycle',
  spec: bike('Motorrad', 1, MOTORCYCLE.finalDrive),
  powers: [48, 68, 95, 120, 150],
  power: 95,
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
  spec: (_t, power) => atPower(LIGHT_TRUCK, power),
  powers: [136, 170, 190, 218],
  power: 170,
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
  spec: (_t, power) => atPower(MINIBUS, power),
  powers: [116, 129, 150, 177],
  power: 150,
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
  spec: (_t, power) => atPower(BUS, power),
  powers: [279, 321, 354, 394],
  power: 321,
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
    // (a car that pulls a trailer comes with a stronger engine)
    power: 115,
  },
  motorcycle: { ...MOTO_DEF },
  // class C: the three-axle rigid truck (render/semitruck.ts) – bigger than the 7.5-tonner of C1 and unlike it
  truckSolo: {
    ...truck,
    kind: 'truckSolo',
    licence: 'C',
    name: 'vehTruckSolo',
    model: 'truckHeavy',
    spec: (_t, power) => atPower(HEAVY_RIGID, power),
    powers: [320, 360, 400],
    power: 360,
    trailer: null,
    caps: { rural: 60, motorway: 80 },
    capFault: 'classSpeed',
    outline: { front: 4.0, rear: 4.7, hw: 1.25 },
    axles: [2.6, -1.92, -3.28],
    track: 1.1,
    door: 3.0,
    circles: [-2.8, -0.9, 1.0, 2.9, 3.45],
    radius: 1.25,
    zoom: 15,
    zoomMax: 34,
  },
  truck: { ...truck, kind: 'truck', licence: 'CE', name: 'vehTruck', trailer: TANDEM_TRAILER, caps: { rural: 60, motorway: 80 }, capFault: 'truckSpeed', zoom: 21, zoomMax: 45, powers: [257, 300, 354, 408, 449], power: 354 },
  // class CE as well: the articulated lorry – tractor unit and semi-trailer (sim/semitrailer.ts)
  semi: {
    ...truck,
    kind: 'semi',
    licence: 'CE',
    name: 'vehSemi',
    model: 'semi',
    spec: (_t, power) => atPower(TRACTOR_UNIT, power),
    powers: [400, 450, 510],
    power: 450,
    trailer: SEMI_TRAILER,
    caps: { rural: 60, motorway: 80 },
    capFault: 'truckSpeed',
    outline: { front: TRACTOR_OUTLINE.front, rear: TRACTOR_OUTLINE.rear, hw: TRACTOR_OUTLINE.hw },
    axles: [TRACTOR_UNIT.wheelbase / 2, -TRACTOR_UNIT.wheelbase / 2],
    track: 1.1,
    door: 2.0,
    circles: [-2.0, -0.6, 0.8, 2.0],
    radius: 1.25,
    zoom: 22,
    zoomMax: 48,
  },
  bus: BUS_DEF,
  tractor: {
    ...car,
    kind: 'tractor',
    licence: 'T',
    name: 'vehTractor',
    model: 'tractor',
    spec: (_t, power) => atPower(TRACTOR_FAST, power),
    powers: [143, 187, 231, 272],
    power: 187,
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
    spec: (_t, power) => atPower(TRACTOR, power),
    powers: [50, 75, 102, 143],
    power: 102,
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
    // (geared for its 45 km/h: at the rev limit in top gear it runs 46; class AM: at most 4 kW)
    spec: bike('Moped 50 cm³, 45 km/h', 0.12, 24),
    powers: [3, 4, 5],
    power: 4,
    governed: 45,
    noMotorway: true,
  },
  motorcycle125: {
    ...MOTO_DEF,
    kind: 'motorcycle125',
    licence: 'A1',
    name: 'vehMotorcycle125',
    // (class A1: at most 11 kW)
    spec: bike('Leichtkraftrad 125 cm³', 0.3, 7.2),
    powers: [11, 13, 15],
    power: 15,
  },
  motorcycle35: {
    ...MOTO_DEF,
    kind: 'motorcycle35',
    licence: 'A2',
    name: 'vehMotorcycle35',
    // (class A2: at most 35 kW)
    spec: bike('Motorrad bis 35 kW', 0.75, 5.8),
    powers: [27, 35, 47],
    power: 47,
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
    power: 190,
  },
  minibus: { ...MINIBUS_DEF },
  minibusTrailer: { ...MINIBUS_DEF, kind: 'minibusTrailer', licence: 'D1E', name: 'vehMinibusTrailer', trailer: MINIBUS_TRAILER, caps: { rural: 80, motorway: 80 }, zoom: 15, zoomMax: 34, power: 177 },
  busTrailer: { ...BUS_DEF, kind: 'busTrailer', licence: 'DE', name: 'vehBusTrailer', trailer: BUS_TRAILER, caps: { rural: 80, motorway: 80 }, zoom: 22, zoomMax: 48, power: 354 },
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
    // (electric: its traction is sim/tramdrive.ts's, nothing to choose)
    powers: [],
    power: 0,
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
  // The light aeroplane flies (sim/flight.ts), it is not driven on the road physics: what is given here is what
  // the rest of the game needs of a vehicle – the camera, its size. Its engine powers are those of TRAINER.
  plane: {
    ...car,
    kind: 'plane',
    licence: 'PPL',
    name: 'vehPlane',
    model: 'plane',
    spec: () => COMPACT_CAR,
    powers: TRAINER.powers,
    power: TRAINER.power,
    trailer: null,
    caps: null,
    capFault: 'speed',
    outline: { front: 2.6, rear: 5.6, hw: TRAINER.span / 2 },
    axles: [1.5, -0.35],
    track: 1.15,
    door: -0.4,
    doorSide: -1,
    circles: [-1.5, 0.5, 2.5, 4.5],
    radius: 1.1,
    zoom: 15,
    zoomMax: 80,
    governed: 0,
    heavy: false,
    noMotorway: true,
    long: false,
    dash: true,
  },
  // The cranes (sim/crane.ts, game/craneplay.ts): the mobile crane and the loader crane are trucks of class C,
  // driven like any to their stand on the construction site and worked there; the tower crane stands on its
  // base – nothing to drive (what is given for it is what the rest of the game needs: the camera, its size).
  mobileCrane: {
    ...truck,
    kind: 'mobileCrane',
    licence: 'C',
    name: 'vehMobileCrane',
    model: 'mobileCrane',
    spec: () => MOBILE_CRANE_SPEC,
    powers: [503],
    power: 503,
    trailer: null,
    caps: { rural: 60, motorway: 80 },
    capFault: 'classSpeed',
    // (the boom's head reaches over the front)
    outline: { front: 6.6, rear: 4.6, hw: 1.28 },
    axles: [1.75, -0.95, -2.55],
    track: 1.04,
    door: 3.1,
    doorSide: -1,
    circles: [-5.4, -3.4, -1.3, 0.8, 2.9, 3.35],
    radius: 1.28,
    zoom: 16,
    zoomMax: 40,
    governed: 80,
    crane: 'mobile',
  },
  loaderCrane: {
    ...truck,
    kind: 'loaderCrane',
    licence: 'C',
    name: 'vehLoaderCrane',
    model: 'loaderCrane',
    spec: () => LOADER_TRUCK_SPEC,
    powers: [286],
    power: 286,
    trailer: null,
    caps: { rural: 60, motorway: 80 },
    capFault: 'classSpeed',
    outline: { front: 3.9, rear: 5.25, hw: 1.28 },
    axles: [2.4, -2.4],
    track: 1.1,
    door: 3.0,
    doorSide: -1,
    circles: [-2.9, -1.0, 1.0, 2.9, 3.97],
    radius: 1.28,
    zoom: 14,
    zoomMax: 34,
    crane: 'loader',
  },
  towerCrane: {
    ...car,
    kind: 'towerCrane',
    licence: '',
    name: 'vehTowerCrane',
    model: 'towerCrane',
    spec: () => TRUCK,
    powers: [],
    power: 0,
    trailer: null,
    caps: null,
    capFault: 'speed',
    // (its jib and counter-jib, and its base)
    outline: { front: 50, rear: 15, hw: 2.5 },
    axles: [0, 0],
    track: 2.5,
    door: 0,
    doorSide: 0,
    circles: [0],
    radius: 2.6,
    zoom: 30,
    zoomMax: 90,
    governed: 0,
    heavy: true,
    noMotorway: true,
    long: false,
    dash: true,
    crane: 'tower',
  },
  // The forklift (sim/forklift.ts, game/forkliftplay.ts): no licence class – the operator's certificate
  // (DGUV Grundsatz 308-001) –, driven on the practice yard by its own simulation; what is given here is what
  // the rest of the game needs of it (its size, the camera, the sound's engine).
  forklift: {
    ...car,
    kind: 'forklift',
    licence: '',
    name: 'vehForklift',
    model: 'forklift',
    spec: () => FORKLIFT_SPEC,
    powers: [],
    power: 0,
    trailer: null,
    caps: null,
    capFault: 'speed',
    // (the forks reach ahead of the mast)
    outline: { front: 2.45, rear: 1.3, hw: 0.6 },
    axles: [0.825, -0.825],
    track: 0.55,
    door: 0.2,
    doorSide: -1,
    circles: [-0.7, 0.02, 0.7],
    radius: 0.58,
    zoom: 6,
    zoomMax: 16,
    governed: 20,
    heavy: false,
    noMotorway: true,
    long: false,
    dash: true,
  },
  // On foot there is no vehicle at all (game.ts walks with OnFoot, game/onfoot.ts): what is given here is
  // what the rest of the game needs of "the vehicle" – the camera keeps to the person, the motorway is not
  // for them (§ 18 Abs. 9 StVO).
  pedestrian: {
    ...car,
    kind: 'pedestrian',
    licence: '',
    name: 'vehOnFoot',
    model: 'walker',
    spec: () => COMPACT_CAR,
    powers: [],
    power: 0,
    trailer: null,
    caps: null,
    capFault: 'speed',
    outline: { front: 0.25, rear: 0.25, hw: 0.3 },
    axles: [0, 0],
    track: 0.2,
    door: 0,
    doorSide: 0,
    circles: [0],
    radius: 0.3,
    zoom: 3.4,
    zoomMax: 12,
    governed: 0,
    heavy: false,
    noMotorway: true,
    long: false,
    dash: true,
  },
};

/** The outline of the trailer of a vehicle (null: it has none). */
export function trailerOf(def: VehicleDef): ReturnType<typeof trailerOutline> | null {
  return def.trailer ? trailerOutline(def.trailer) : null;
}

/** The engine power (PS) to drive a vehicle with: the one chosen for it, if it may have it, else the one it comes with. */
export function powerOf(def: VehicleDef, chosen: Partial<Record<string, number>>): number {
  const p = chosen[def.kind];
  return p !== undefined && def.powers.includes(p) ? p : def.power;
}

/** A vehicle kind from a setting or a link, or null. */
export function vehicleKind(v: unknown): VehicleKind | null {
  return typeof v === 'string' && (VEHICLE_KINDS as readonly string[]).includes(v) ? (v as VehicleKind) : null;
}
