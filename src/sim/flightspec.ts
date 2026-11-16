// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The light aeroplane of the game: a generic two-seat high-wing trainer of
 * the kind flying schools use – no real type is reproduced.  These are the
 * measures both the flight model (sim/flight.ts) and the 3D model
 * (render/plane.ts) are built from, so that the wheels the physics stands on
 * are the wheels that are drawn.
 *
 * Body frame as for every vehicle of the game: x to the right, y up, z to
 * the back (the nose looks towards -z); the origin is the centre of mass.
 * Metres, kilograms, seconds.
 */

export interface GearLeg {
  /** wheel centre with the strut fully extended (no load) */
  x: number;
  y: number;
  z: number;
  radius: number;
  /** how far the strut can be pushed in (m) */
  travel: number;
  /** the nose wheel, steered with the rudder pedals */
  steers: boolean;
}

export interface AircraftGeometry {
  /** as flown: two people, half the fuel */
  mass: number;
  length: number;
  height: number;
  span: number;
  wingArea: number;
  /** mean chord */
  chord: number;
  /** height of the wing's lower surface at the root, and where its leading and trailing edges are */
  wingY: number;
  wingLE: number;
  wingTE: number;
  /** degrees */
  dihedral: number;
  /** propeller hub and diameter */
  propHub: [number, number, number];
  propDiameter: number;
  /** horizontal tail: quarter-chord position, span, chord; fin: position and top */
  stabZ: number;
  stabY: number;
  stabSpan: number;
  stabChord: number;
  finZ: number;
  finTop: number;
  /** nose wheel first, then the main wheels left and right */
  gear: GearLeg[];
  /** the pilot's eyes in the left seat */
  eye: [number, number, number];
  /** speeds (m/s): stall with full flaps / clean, rotation, best climb, cruise, never exceed */
  vs0: number;
  vs1: number;
  vr: number;
  vy: number;
  vcruise: number;
  vne: number;
  /** maximum flap deflection (degrees); the lever has the detents 0, 10, 20 and 30 */
  flapsMax: number;
  /** engine (PS) – the power the game offers to choose from, and its default */
  powers: readonly number[];
  power: number;
  /** usable fuel (litres) */
  fuel: number;
}

export const TRAINER: AircraftGeometry = {
  mass: 1000,
  length: 8.2,
  height: 2.7,
  span: 10.9,
  wingArea: 16.2,
  chord: 1.5,
  wingY: 0.95,
  wingLE: -0.55,
  wingTE: 0.95,
  dihedral: 1.5,
  propHub: [0, 0.05, -2.45],
  propDiameter: 1.9,
  stabZ: 4.6,
  stabY: 0.15,
  stabSpan: 3.4,
  stabChord: 0.9,
  finZ: 4.7,
  finTop: 1.8,
  gear: [
    { x: 0, y: -1.05, z: -1.5, radius: 0.17, travel: 0.15, steers: true },
    { x: -1.15, y: -1.05, z: 0.35, radius: 0.19, travel: 0.1, steers: false },
    { x: 1.15, y: -1.05, z: 0.35, radius: 0.19, travel: 0.1, steers: false },
  ],
  eye: [-0.3, 0.55, -0.45],
  vs0: 23,
  vs1: 26,
  vr: 28,
  vy: 38,
  vcruise: 56,
  vne: 82,
  flapsMax: 30,
  powers: [100, 116, 160, 180],
  power: 160,
  fuel: 150,
};
