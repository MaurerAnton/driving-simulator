// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { FACE, SINK, packFaces, unpackFaces } from '../../src/world/facade.ts';
import { POS_XZ_SCALE, POS_Y_SCALE, UV_SCALE } from '../../src/world/tilefmt.ts';

type P = [number, number, number];

/** A mesh the way the map build makes the faces of buildings (tools/mapgen/buildings.ts), to compare with. */
class Faces {
  pos: number[] = [];
  a16: number[] = [];
  idx: number[] = [];

  private add(ring: P[], uAxis: P, vAxis: P, attr: (u: number, v: number, y: number) => number[], lowerBelow: number): void {
    const first = this.pos.length / 3;
    const us = ring.map((p) => p[0] * uAxis[0] + p[1] * uAxis[1] + p[2] * uAxis[2]);
    const vs = ring.map((p) => p[0] * vAxis[0] + p[1] * vAxis[1] + p[2] * vAxis[2]);
    const uMin = Math.min(...us);
    const vMin = Math.min(...vs);
    ring.forEach((p, i) => {
      this.a16.push(...attr(us[i] - uMin, vs[i] - vMin, p[1]));
      this.pos.push(p[0], p[1] <= lowerBelow ? p[1] - SINK : p[1], p[2]);
    });
    for (let i = 1; i + 1 < ring.length; i++) this.idx.push(first, first + i, first + i + 1);
  }

  private static normal(ring: P[]): P {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    });
    const l = Math.hypot(nx, ny, nz);
    return [nx / l, ny / l, nz / l];
  }

  wall(ring: P[], onGround: boolean): void {
    const [nx, , nz] = Faces.normal(ring);
    const hl = Math.hypot(nx, nz);
    const ua: P = [nz / hl, 0, -nx / hl];
    const ys = ring.map((p) => p[1]);
    const lo = Math.min(...ys);
    let eave = Math.max(...ys);
    for (const y of ys) if (y > lo + 0.6 && y < eave) eave = y;
    const us = ring.map((p) => p[0] * ua[0] + p[2] * ua[2]);
    const L = Math.max(...us) - Math.min(...us);
    this.add(ring, ua, [0, 1, 0], (u, _v, y) => [u, y - lo, L, eave - lo], onGround ? lo + 0.02 : -Infinity);
  }

  roof(ring: P[]): void {
    const [nx, ny, nz] = Faces.normal(ring);
    if (ny >= 0.985) {
      this.add(ring, [1, 0, 0], [0, 0, 1], (u, v) => [u, v, 0, 0], -Infinity);
      return;
    }
    const hl = Math.hypot(nx, nz);
    const ua: P = [nz / hl, 0, -nx / hl];
    let va: P = [ny * ua[2] - nz * ua[1], nz * ua[0] - nx * ua[2], nx * ua[1] - ny * ua[0]];
    if (va[1] < 0) va = [-va[0], -va[1], -va[2]];
    this.add(ring, ua, va, (u, v) => [u, v, 0, 0], -Infinity);
  }

  /** a face with numbers no rule gives */
  odd(ring: P[], values: number[]): void {
    const first = this.pos.length / 3;
    ring.forEach((p) => this.pos.push(...p));
    this.a16.push(...values);
    for (let i = 1; i + 1 < ring.length; i++) this.idx.push(first, first + i, first + i + 1);
  }

  /** as the tile holds it: whole numbers around the middle of the tile */
  sections(cx: number, cz: number, yBase: number): { pos: Int16Array; idx: Uint16Array; a16: Int16Array } {
    const pos = new Int16Array(this.pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = Math.round((this.pos[i] - cx) / POS_XZ_SCALE);
      pos[i + 1] = Math.round((this.pos[i + 1] - yBase) / POS_Y_SCALE);
      pos[i + 2] = Math.round((this.pos[i + 2] - cz) / POS_XZ_SCALE);
    }
    return { pos, idx: Uint16Array.from(this.idx), a16: Int16Array.from(this.a16, (v) => Math.round(v / UV_SCALE)) };
  }
}

test('what the faces of a building need for their facades follows from their corners', () => {
  const f = new Faces();
  // a house: 8.47 m × 6.2 m, skew to the grid, eaves 5.53 m above the ground at 187.31 m, ridge at 8.2 m
  const g = 187.31;
  const a: P = [1010.013, g, -705.031];
  const dir: P = [0.8829, 0, 0.4695];
  const across: P = [-0.4695, 0, 0.8829];
  const at = (along: number, over: number, up: number): P => [a[0] + dir[0] * along + across[0] * over, g + up, a[2] + dir[2] * along + across[2] * over];
  // the long walls (on the ground), the gable walls (five corners), two roof planes
  f.wall([at(0, 0, 0), at(8.47, 0, 0), at(8.47, 0, 5.53), at(0, 0, 5.53)], true);
  f.wall([at(8.47, 6.2, 0), at(0, 6.2, 0), at(0, 6.2, 5.53), at(8.47, 6.2, 5.53)], true);
  f.wall([at(8.47, 0, 0), at(8.47, 6.2, 0), at(8.47, 6.2, 5.53), at(8.47, 3.1, 8.2), at(8.47, 0, 5.53)], true);
  f.wall([at(0, 6.2, 0), at(0, 0, 0), at(0, 0, 5.53), at(0, 3.1, 8.2), at(0, 6.2, 5.53)], true);
  f.roof([at(0, 0, 5.53), at(8.47, 0, 5.53), at(8.47, 3.1, 8.2), at(0, 3.1, 8.2)]);
  f.roof([at(8.47, 6.2, 5.53), at(0, 6.2, 5.53), at(0, 3.1, 8.2), at(8.47, 3.1, 8.2)]);
  // a wall above the roof of a lower part of the building (its foot is not sunk), a level roof with six corners
  f.wall([at(10, 0, 3.07), at(14, 0, 3.07), at(14, 0, 6.9), at(10, 0, 6.9)], false);
  f.roof([at(10, 6, 6.9), at(12, 6, 6.9), at(12, 4, 6.9), at(14, 4, 6.9), at(14, 0, 6.9), at(10, 0, 6.9)]);
  // and a face whose numbers no rule gives
  const oddValues = [3, -7, 11, 2, 400, 5, 11, 2, 400, 900, 11, 2];
  f.odd([at(20, 0, 0), at(22, 0, 0), at(22, 0, 3)], oddValues.map((v) => v * UV_SCALE));

  const s = f.sections(1250, -750, 180);
  const packed = packFaces(s.pos, s.idx, s.a16);
  const rules = Array.from(packed.run, (r) => r & 7);
  const sizes = Array.from(packed.run, (r) => r >> 3);
  assert.deepEqual(rules, [FACE.WALL_SUNK, FACE.WALL_SUNK, FACE.WALL_SUNK, FACE.WALL_SUNK, FACE.ROOF_SLOPED, FACE.ROOF_SLOPED, FACE.WALL, FACE.ROOF_FLAT, FACE.EXPLICIT]);
  assert.deepEqual(sizes, [4, 4, 5, 5, 4, 4, 4, 6, 3]);
  assert.equal(packed.uvx.length, 12, 'only the odd face keeps its numbers');
  assert.equal(packed.ruled, s.pos.length / 3 - 3);

  const back = unpackFaces(s.pos, packed.run, packed.uvx);
  assert.equal(back.length, s.a16.length);
  let worst = 0;
  for (let i = 0; i < back.length; i++) worst = Math.max(worst, Math.abs(back[i] - s.a16[i]));
  assert.ok(worst <= 2, `to 4 cm what the map build wanted (${worst} steps of ${UV_SCALE} m)`);
  assert.deepEqual(Array.from(back.subarray(back.length - 12)), oddValues, 'the odd face has its numbers back as they were');
  // the gable wall: its height is that of the eaves, not of the ridge; its length the depth of the house
  const gable = (4 + 4) * 4;
  assert.ok(Math.abs(back[gable + 3] * UV_SCALE - 5.53) < 0.05 && Math.abs(back[gable + 2] * UV_SCALE - 6.2) < 0.05, 'gable wall');
  // the foot of a wall on the ground counts as height 0 although it is sunk into the ground
  assert.equal(back[1], 0);
  assert.ok(Math.abs(s.pos[1] * POS_Y_SCALE - (g - SINK - 180)) < 0.01);
});

test('a mesh without faces that follow a rule is stored as it is', () => {
  const pos = Int16Array.from([0, 0, 0, 100, 0, 0, 100, 0, 100, 0, 0, 100, 7, 7, 7]);
  const idx = Uint16Array.from([0, 1, 2, 0, 2, 3]);
  const a16 = Int16Array.from([9, 9, 9, 9, 8, 8, 8, 8, 7, 7, 7, 7, 6, 6, 6, 6, 5, 5, 5, 5]);
  const packed = packFaces(pos, idx, a16);
  // (the last corner belongs to no triangle: runs without a rule that follow each other are one run)
  assert.deepEqual(Array.from(packed.run), [(5 << 3) | FACE.EXPLICIT]);
  assert.deepEqual(Array.from(unpackFaces(pos, packed.run, packed.uvx)), Array.from(a16));
});
