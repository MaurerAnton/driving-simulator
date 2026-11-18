// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cars parked along the streets: where they stand, as the map build places
 * them (tools/mapgen/parking.ts) and the tiles carry them (sections
 * `parked` and `parkedK`), for the game to draw (render/parked.ts).  They do
 * not move; their outlines are in the tile's collision walls.
 */
import { POS_XZ_SCALE, POS_Y_SCALE } from './tilefmt.ts';

/** The kinds of parked car: length, width, height (m). */
export const PARKED_MODELS = [
  { name: 'small', len: 3.9, wid: 1.72, hgt: 1.48 },
  { name: 'saloon', len: 4.55, wid: 1.8, hgt: 1.45 },
  { name: 'estate', len: 4.75, wid: 1.82, hgt: 1.5 },
  { name: 'van', len: 4.95, wid: 1.95, hgt: 1.95 },
] as const;

/** Their colours (sRGB), white, black and silver the most. */
export const PARKED_COLOURS = [0xe9e9e6, 0xeeeeea, 0x1c1d20, 0x26272b, 0x9ea2a6, 0xb6b9bc, 0x6c7075, 0x24375e, 0x7a1d1d, 0x2f4b37, 0x8c7b62, 0x3b5f8a] as const;

/** One parked car. `yaw` as everywhere: 0 facing north, positive turning left. */
export interface ParkedCar {
  x: number;
  y: number;
  z: number;
  yaw: number;
  model: number;
  colour: number;
}

const YAW_SCALE = 1e-4;

/** The cars of a tile as its two sections (positions relative to the tile centre and height base). */
export function packParked(cars: readonly ParkedCar[], cx: number, cz: number, yBase: number): { parked: Int16Array; parkedK: Uint8Array } {
  const parked = new Int16Array(cars.length * 4);
  const parkedK = new Uint8Array(cars.length);
  const q = (v: number): number => Math.max(-32767, Math.min(32767, Math.round(v)));
  cars.forEach((c, i) => {
    let yaw = c.yaw % (Math.PI * 2);
    if (yaw > Math.PI) yaw -= Math.PI * 2;
    if (yaw < -Math.PI) yaw += Math.PI * 2;
    parked[i * 4] = q((c.x - cx) / POS_XZ_SCALE);
    parked[i * 4 + 1] = q((c.z - cz) / POS_XZ_SCALE);
    parked[i * 4 + 2] = q((c.y - yBase) / POS_Y_SCALE);
    parked[i * 4 + 3] = q(yaw / YAW_SCALE);
    parkedK[i] = (c.model & 15) * 16 + (c.colour & 15);
  });
  return { parked, parkedK };
}

/** The cars back from a tile's sections (none: an empty list). */
export function unpackParked(parked: Int16Array | null, parkedK: Uint8Array | null, cx: number, cz: number, yBase: number): ParkedCar[] {
  if (!parked || !parkedK) return [];
  const n = Math.min(parked.length >> 2, parkedK.length);
  const out: ParkedCar[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      x: cx + parked[i * 4] * POS_XZ_SCALE,
      z: cz + parked[i * 4 + 1] * POS_XZ_SCALE,
      y: yBase + parked[i * 4 + 2] * POS_Y_SCALE,
      yaw: parked[i * 4 + 3] * YAW_SCALE,
      model: Math.min(PARKED_MODELS.length - 1, parkedK[i] >> 4),
      colour: Math.min(PARKED_COLOURS.length - 1, parkedK[i] & 15),
    });
  }
  return out;
}

/** The four corners of a car's outline on the ground (flat x, z), shrunk by `inset` all round. */
export function parkedOutline(c: ParkedCar, inset = 0): number[] {
  const m = PARKED_MODELS[c.model] ?? PARKED_MODELS[1];
  const fx = -Math.sin(c.yaw);
  const fz = -Math.cos(c.yaw);
  // right of forward
  const rx = -fz;
  const rz = fx;
  const hl = m.len / 2 - inset;
  const hw = m.wid / 2 - inset;
  return [
    c.x + fx * hl + rx * hw, c.z + fz * hl + rz * hw,
    c.x + fx * hl - rx * hw, c.z + fz * hl - rz * hw,
    c.x - fx * hl - rx * hw, c.z - fz * hl - rz * hw,
    c.x - fx * hl + rx * hw, c.z - fz * hl + rz * hw,
  ];
}
