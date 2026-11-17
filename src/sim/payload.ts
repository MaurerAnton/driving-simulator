// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A load in the box of a truck, and what it does to the vehicle's physics.
 *
 * The vehicle model (sim/vehicle/vehicle.ts) takes its mass, its moments of
 * inertia and where its centre of mass lies from the spec it is built with
 * – the springs settle under the weight when it is made, the tyres' grip
 * follows the load on each wheel, the brakes have more to stop.  A load is
 * therefore given as a spec of its own: the same truck, heavier by the
 * load, its centre of mass moved towards the load (back and up: the goods
 * stand on the floor of the box, higher than the chassis), and its moments
 * of inertia grown by the load's own and by how far it lies from the new
 * centre (the parallel-axis theorem).  Everything else – engine, brakes,
 * springs – stays as it is: a loaded truck pulls away more slowly, sits
 * lower, takes longer to stop and burns more.
 */
import type { VehicleSpec } from './vehicle/types.ts';

export interface Payload {
  /** kg */
  mass: number;
  /** where its middle lies: metres behind the middle of the wheelbase, and above the ground */
  z: number;
  y: number;
  /** its length (along the vehicle), width and height (m) */
  len: number;
  wid: number;
  hgt: number;
}

/** The spec of a vehicle with a load in it (the spec itself if there is none). */
export function withPayload(spec: VehicleSpec, load: Payload | null): VehicleSpec {
  if (!load || !(load.mass > 0)) return spec;
  const M = spec.mass;
  const m = load.mass;
  const total = M + m;
  // centre of mass, from the ground below the middle of the wheelbase (z: + back)
  const zc = spec.cgToFront - spec.wheelbase / 2;
  const yc = spec.cgHeight;
  const z2 = (M * zc + m * load.z) / total;
  const y2 = (M * yc + m * load.y) / total;
  const [ix, iy, iz] = spec.inertia;
  const dy = y2 - yc;
  const dz = z2 - zc;
  const ly = load.y - y2;
  const lz = load.z - z2;
  // pitch (about the cross axis), yaw (about the vertical), roll (about the length)
  const pitch = ix + M * (dy * dy + dz * dz) + m * (ly * ly + lz * lz) + (m * (load.hgt * load.hgt + load.len * load.len)) / 12;
  const yaw = iy + M * dz * dz + m * lz * lz + (m * (load.wid * load.wid + load.len * load.len)) / 12;
  const roll = iz + M * dy * dy + m * ly * ly + (m * (load.wid * load.wid + load.hgt * load.hgt)) / 12;
  // (the centre of mass stays between the axles: a load hung far out behind would need a model of its own)
  const cgToFront = Math.min(spec.wheelbase * 0.9, Math.max(spec.wheelbase * 0.1, z2 + spec.wheelbase / 2));
  return { ...spec, name: `${spec.name}, ${Math.round(m)} kg geladen`, mass: total, inertia: [pitch, yaw, roll], cgHeight: y2, cgToFront };
}
