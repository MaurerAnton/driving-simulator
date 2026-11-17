// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fuel: the tank of the player's vehicle, what its engine burns, and the
 * pump that fills it.
 *
 * What an engine burns follows from the work its cylinders do.  The vehicle
 * model (sim/vehicle) gives the engine's speed and how far the throttle is
 * open – the share of the torque curve the cylinders give at that speed –
 * and its friction: the cylinders give `load × (full-load torque + friction)`
 * of which the friction eats its part, the rest drives the car.  That work,
 * divided by how much of the fuel's energy the cylinders turn into work
 * (about a third for a petrol engine, more for a diesel), is the fuel
 * burnt.  So the consumption comes out of the same physics as the driving:
 * idling costs a little (the idle control holds the throttle a crack open),
 * rolling in gear with the foot off costs nothing (the fuel is cut off), a
 * heavy load, a hill or a high speed cost more – realistic figures follow
 * (tests/sim/fuel.test.ts: a compact car 5–7 l/100 km at 100 km/h, a 12-t
 * truck 20–30 l at 80 km/h …).
 */
import type { VehicleSpec } from './vehicle/types.ts';

export type FuelKind = 'petrol' | 'diesel';

/** What a kind of vehicle carries and how its engine uses the fuel. */
export interface TankSpec {
  /** litres */
  capacity: number;
  fuel: FuelKind;
  /** the share of the fuel's energy the cylinders turn into work (indicated efficiency) */
  efficiency: number;
  /** below this share of the tank the fuel lamp lights */
  reserve: number;
  /** how fast the pump fills it (l/s; faster than a real pump's 0.6 – nobody wants to wait a minute) */
  flow: number;
}

/** The energy in a litre of fuel (J): petrol about 32 MJ, diesel about 36 MJ. */
export const ENERGY_PER_LITRE: Record<FuelKind, number> = { petrol: 31.8e6, diesel: 35.9e6 };

const CAR: TankSpec = { capacity: 50, fuel: 'petrol', efficiency: 0.34, reserve: 0.12, flow: 1.6 };
const TANKS: Record<string, TankSpec> = {
  car: CAR,
  carTrailer: CAR,
  moped: { capacity: 6.5, fuel: 'petrol', efficiency: 0.26, reserve: 0.2, flow: 0.5 },
  motorcycle125: { capacity: 11, fuel: 'petrol', efficiency: 0.3, reserve: 0.18, flow: 0.8 },
  motorcycle35: { capacity: 14, fuel: 'petrol', efficiency: 0.31, reserve: 0.18, flow: 0.8 },
  motorcycle: { capacity: 16, fuel: 'petrol', efficiency: 0.31, reserve: 0.18, flow: 0.8 },
  lightTruck: { capacity: 150, fuel: 'diesel', efficiency: 0.42, reserve: 0.1, flow: 3.5 },
  lightTruckTrailer: { capacity: 150, fuel: 'diesel', efficiency: 0.42, reserve: 0.1, flow: 3.5 },
  truckSolo: { capacity: 300, fuel: 'diesel', efficiency: 0.43, reserve: 0.08, flow: 5 },
  truck: { capacity: 300, fuel: 'diesel', efficiency: 0.43, reserve: 0.08, flow: 5 },
  semi: { capacity: 600, fuel: 'diesel', efficiency: 0.44, reserve: 0.07, flow: 6 },
  minibus: { capacity: 90, fuel: 'diesel', efficiency: 0.41, reserve: 0.1, flow: 3 },
  minibusTrailer: { capacity: 90, fuel: 'diesel', efficiency: 0.41, reserve: 0.1, flow: 3 },
  bus: { capacity: 280, fuel: 'diesel', efficiency: 0.42, reserve: 0.08, flow: 5 },
  busTrailer: { capacity: 280, fuel: 'diesel', efficiency: 0.42, reserve: 0.08, flow: 5 },
  tractorSlow: { capacity: 160, fuel: 'diesel', efficiency: 0.4, reserve: 0.1, flow: 3.5 },
  tractor: { capacity: 280, fuel: 'diesel', efficiency: 0.41, reserve: 0.1, flow: 5 },
};

/** The tank of a kind of vehicle (src/game/vehicles.ts VehicleKind) – null for those without one (the tram runs on the wire, the aeroplane has its own, on foot). */
export function tankFor(kind: string): TankSpec | null {
  return TANKS[kind] ?? null;
}

/** The full-load torque of an engine at an engine speed (N·m), from its torque curve. */
export function fullTorque(spec: VehicleSpec, rpm: number): number {
  const c = spec.torqueCurve;
  if (rpm <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (rpm <= c[i][0]) {
      const t = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
      return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t;
    }
  }
  return 0;
}

/**
 * What a running engine burns (litres a second) at an engine speed (rpm)
 * and throttle (`load` 0 … 1, as the vehicle model applies it: idle control
 * and limiter included): the work of its cylinders over the energy of the fuel.
 */
export function fuelFlow(spec: VehicleSpec, tank: TankSpec, rpm: number, load: number, running: boolean): number {
  if (!running || load <= 0 || rpm <= 0) return 0;
  const omega = (rpm * Math.PI) / 30;
  const friction = spec.engineFriction[0] + spec.engineFriction[1] * rpm;
  const work = Math.min(1, load) * (fullTorque(spec, rpm) + friction) * omega;
  return work / (tank.efficiency * ENERGY_PER_LITRE[tank.fuel]);
}

/** The fuel in the tank of the vehicle being driven. */
export class FuelTank {
  readonly spec: TankSpec;
  litres: number;
  /** burnt since the drive began (l), and over what distance (m) – for the consumption shown */
  used = 0;
  distance = 0;

  constructor(spec: TankSpec, share: number) {
    this.spec = spec;
    this.litres = Math.max(0, Math.min(1, share)) * spec.capacity;
  }

  /** How full it is (0 … 1). */
  get share(): number {
    return this.litres / this.spec.capacity;
  }

  /** The fuel lamp: in the reserve. */
  get low(): boolean {
    return this.share < this.spec.reserve;
  }

  get empty(): boolean {
    return this.litres <= 1e-6;
  }

  /** Burn for `dt` seconds at `flow` l/s while `metres` are driven. */
  burn(flow: number, dt: number, metres = 0): void {
    const l = Math.max(0, flow * dt);
    this.litres = Math.max(0, this.litres - l);
    this.used += l;
    this.distance += Math.max(0, metres);
  }

  /** Pour in up to `litres`: what fitted. */
  fill(litres: number): number {
    const add = Math.max(0, Math.min(litres, this.spec.capacity - this.litres));
    this.litres += add;
    return add;
  }

  /** Litres per 100 km since the drive began (NaN before the first kilometre). */
  get average(): number {
    return this.distance > 1000 ? (this.used / this.distance) * 100000 : NaN;
  }
}

/**
 * A fill-up at a pump: the litres and the price count up while the fuel
 * runs – slowly for the first second, at the pump's flow then, slowly again
 * over the last litres, until the nozzle shuts off by itself at a full tank
 * (or the driver stops it).
 */
export class FillUp {
  readonly price: number;
  litres = 0;
  t = 0;
  done = false;
  private readonly flow: number;

  /** `price`: per litre; `flow`: the pump's (l/s) */
  constructor(price: number, flow: number) {
    this.price = price;
    this.flow = flow;
  }

  get cost(): number {
    return Math.round(this.litres * this.price * 100) / 100;
  }

  /** Run the pump for `dt`: fills the tank. */
  step(dt: number, tank: FuelTank): void {
    if (this.done) return;
    this.t += dt;
    const room = tank.spec.capacity - tank.litres;
    const start = Math.min(1, this.t / 1.2);
    const end = Math.max(0.2, Math.min(1, room / (this.flow * 1.5)));
    const got = tank.fill(this.flow * start * end * dt);
    this.litres += got;
    if (room - got < 0.02) {
      this.done = true;
      tank.litres = tank.spec.capacity;
    }
  }
}

/**
 * How full the tank is when a drive begins: mostly between a third and
 * nearly full, but now and then nearly empty, so that the fuel lamp and the
 * way to a station come into play.  `rand`: 0 … 1.
 */
export function startShare(rand: number, rand2: number): number {
  if (rand < 0.18) return 0.07 + rand2 * 0.12;
  return 0.3 + rand2 * 0.65;
}
