// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The grid of road segments `World` looks things up in: like `Grid2` (a
 * uniform spatial hash over the ground plane, src/core/geom.ts) for numbers –
 * the segment codes, edgeId * 4096 + segment index – but with the bounding
 * box of each segment kept beside its code in the cell.  `surfaceAt` tests
 * that box before it fetches the edge at all: most of the ~20 segments of a
 * 40 m cell lie far from the point asked about, and the edges are kept by
 * their number in the whole map (a sparse array, slow to look into).
 *
 * The codes of a cell keep the order `Grid2` would give them (appended;
 * taken out by moving the last one into the gap), so whoever walks a cell
 * meets the segments in the same order as before.
 */

/** One cell: its codes, and four numbers per code – minX, minZ, maxX, maxZ of that segment's box. */
export interface SegCell {
  codes: number[];
  boxes: number[];
}

const EMPTY_CODES: readonly number[] = [];

export class SegGrid {
  readonly cell: number;
  private readonly map = new Map<number, SegCell>();

  constructor(cell: number) {
    this.cell = cell;
  }

  private key(ix: number, iz: number): number {
    return (ix + 32768) * 65536 + (iz + 32768);
  }

  /** Put a code into the cells the box (x0..x1, z0..z1) covers, with the box (bx0, bz0, bx1, bz1) to test it by. */
  insertBox(x0: number, z0: number, x1: number, z1: number, code: number, bx0: number, bz0: number, bx1: number, bz1: number): void {
    const c = this.cell;
    const ix0 = Math.floor(x0 / c);
    const ix1 = Math.floor(x1 / c);
    const iz0 = Math.floor(z0 / c);
    const iz1 = Math.floor(z1 / c);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const k = this.key(ix, iz);
        let cell = this.map.get(k);
        if (!cell) this.map.set(k, (cell = { codes: [], boxes: [] }));
        cell.codes.push(code);
        cell.boxes.push(bx0, bz0, bx1, bz1);
      }
    }
  }

  /** Take a code out again – with the box it was put in with. */
  removeBox(x0: number, z0: number, x1: number, z1: number, code: number): void {
    const c = this.cell;
    const ix0 = Math.floor(x0 / c);
    const ix1 = Math.floor(x1 / c);
    const iz0 = Math.floor(z0 / c);
    const iz1 = Math.floor(z1 / c);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const k = this.key(ix, iz);
        const cell = this.map.get(k);
        if (!cell) continue;
        const { codes, boxes } = cell;
        const i = codes.indexOf(code);
        if (i < 0) continue;
        const last = codes.length - 1;
        codes[i] = codes[last];
        codes.pop();
        for (let j = 0; j < 4; j++) boxes[i * 4 + j] = boxes[last * 4 + j];
        boxes.length = last * 4;
        if (last === 0) this.map.delete(k);
      }
    }
  }

  /** The cell containing (x,z), or undefined when nothing is in it. */
  cellAt(x: number, z: number): SegCell | undefined {
    const c = this.cell;
    return this.map.get(this.key(Math.floor(x / c), Math.floor(z / c)));
  }

  /** Codes whose cells overlap the cell containing (x,z). */
  at(x: number, z: number): readonly number[] {
    return this.cellAt(x, z)?.codes ?? EMPTY_CODES;
  }

  /** Visit every code in cells overlapping the box (codes may repeat). */
  queryBox(minX: number, minZ: number, maxX: number, maxZ: number, visit: (code: number) => void): void {
    const c = this.cell;
    const x0 = Math.floor(minX / c);
    const x1 = Math.floor(maxX / c);
    const z0 = Math.floor(minZ / c);
    const z1 = Math.floor(maxZ / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const cell = this.map.get(this.key(ix, iz));
        if (cell) for (let i = 0; i < cell.codes.length; i++) visit(cell.codes[i]);
      }
    }
  }
}
