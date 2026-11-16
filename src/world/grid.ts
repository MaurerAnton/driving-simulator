// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The grids the map is cut into – shared by the map build (tools/) and the
 * game.  Squares are numbered from a point far north-west of the world
 * origin, so that their indices are positive all over Hesse and stay the
 * same however far the map grows:
 *
 *   tiles   500 m   terrain, meshes and scenery, streamed around the car
 *   chunks  4 km    the road network, loaded around the car
 */
export const GRID_OFFSET = 200_000;
export const TILE = 500;
export const CHUNK = 4000;

/** Index of the grid square of side `size` a coordinate (x or z, world metres) lies in. */
export function gridIndex(v: number, size: number): number {
  return Math.floor((v + GRID_OFFSET) / size);
}

/** The lower corner (west, or north) of grid square `i`. */
export function gridStart(i: number, size: number): number {
  return i * size - GRID_OFFSET;
}

/**
 * Which squares of a grid exist: one bit per square of the rectangle
 * (x0, z0) … (x0 + w - 1, z0 + h - 1), row by row.
 */
export interface GridBits {
  x0: number;
  z0: number;
  w: number;
  h: number;
  /** base64 of the bits, least significant bit first */
  bits: string;
}

export class GridSet {
  readonly x0: number;
  readonly z0: number;
  readonly w: number;
  readonly h: number;
  private readonly bytes: Uint8Array;

  constructor(x0: number, z0: number, w: number, h: number, bytes?: Uint8Array) {
    this.x0 = x0;
    this.z0 = z0;
    this.w = w;
    this.h = h;
    this.bytes = bytes ?? new Uint8Array(Math.ceil((w * h) / 8));
  }

  static from(json: GridBits): GridSet {
    const bin = atob(json.bits);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new GridSet(json.x0, json.z0, json.w, json.h, bytes);
  }

  /** The smallest set that holds these squares. */
  static of(squares: ReadonlyArray<readonly [number, number]>): GridSet {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const [x, z] of squares) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    const set = squares.length ? new GridSet(x0, z0, x1 - x0 + 1, z1 - z0 + 1) : new GridSet(0, 0, 0, 0);
    for (const [x, z] of squares) set.add(x, z);
    return set;
  }

  add(ix: number, iz: number): void {
    const k = (iz - this.z0) * this.w + (ix - this.x0);
    this.bytes[k >> 3] |= 1 << (k & 7);
  }

  has(ix: number, iz: number): boolean {
    if (ix < this.x0 || iz < this.z0 || ix >= this.x0 + this.w || iz >= this.z0 + this.h) return false;
    const k = (iz - this.z0) * this.w + (ix - this.x0);
    return (this.bytes[k >> 3] & (1 << (k & 7))) !== 0;
  }

  get count(): number {
    let n = 0;
    for (const b of this.bytes) for (let v = b; v; v &= v - 1) n++;
    return n;
  }

  toJSON(): GridBits {
    let bin = '';
    for (const b of this.bytes) bin += String.fromCharCode(b);
    return { x0: this.x0, z0: this.z0, w: this.w, h: this.h, bits: btoa(bin) };
  }
}
