// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { CODING, RING_SCALE, TREE_HEIGHT_SCALE, TREE_SCALE, encodeSection, packSections, packTile, tileGround, unpackSections, unpackTile } from '../../src/world/tilefmt.ts';
import type { SectionInfo } from '../../src/world/tilefmt.ts';
import { GridSet } from '../../src/world/grid.ts';

/** numbers that look like a mesh: neighbours are close, now and then a jump, values on both sides of zero */
function wavy(n: number, range: number, seed: number): number[] {
  const out: number[] = [];
  let v = 0;
  let a = seed;
  for (let i = 0; i < n; i++) {
    a = (a * 1664525 + 1013904223) >>> 0;
    v += (a >>> 24) - 127;
    if (a % 97 === 0) v = (a >>> 8) % range;
    out.push(((v % range) + range) % range);
  }
  return out;
}

test('every coding of a section gives the numbers back as they were', () => {
  const cases: Array<[string, Int16Array | Uint16Array | Uint32Array | Uint8Array, number]> = [
    ['i16 × 3', Int16Array.from(wavy(3 * 400, 60000, 1), (v) => v - 30000), 3],
    ['u16 × 3', Uint16Array.from(wavy(3 * 333, 65536, 2)), 3],
    ['u32 × 3', Uint32Array.from(wavy(3 * 250, 200000, 3)), 3],
    ['i16 × 4', Int16Array.from(wavy(4 * 100, 65536, 4), (v) => v - 32768), 4],
    ['u8 × 1', Uint8Array.from(wavy(500, 256, 5)), 1],
    ['extremes', Int16Array.from([-32768, 32767, -32768, 0, 32767, -1, 1, 0, 0]), 3],
    ['u32 extremes', Uint32Array.from([0, 4294967295, 1, 4294967295, 0, 2147483648]), 3],
  ];
  for (const [what, arr, stride] of cases) {
    for (const coding of [CODING.RAW, CODING.PLANES, CODING.DELTA]) {
      const packed = packSections({ v: 1 }, { a: encodeSection(arr, coding, stride) });
      const back = unpackSections<{ sections: Record<string, SectionInfo> }>(packed.buffer as ArrayBuffer).get('a');
      assert.ok(back, `${what}, coding ${coding}`);
      assert.equal(back.constructor, arr.constructor, `${what}: the same kind of array`);
      assert.deepEqual(Array.from(back), Array.from(arr), `${what}, coding ${coding}`);
    }
  }
  // a grid of heights: rows of 7
  const grid = Uint16Array.from(wavy(7 * 9, 65536, 6));
  const packed = packSections({ v: 1 }, { hgt: encodeSection(grid, CODING.GRID, 7), other: Float32Array.from([1.5, -2.25]) });
  const u = unpackSections<{ sections: Record<string, SectionInfo> }>(packed.buffer as ArrayBuffer);
  assert.deepEqual(Array.from(u.get('hgt') as Uint16Array), Array.from(grid));
  assert.deepEqual(Array.from(u.get('other') as Float32Array), [1.5, -2.25]);
  assert.equal(u.get('nothing'), null);
});

test('trees and outlines stored as whole numbers come back as the game expects them', () => {
  // a tile whose ground rises by 10 m from west to east and by 5 m from north to south (heights in steps of 4 cm)
  const N = 3;
  const hgt = new Uint16Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) hgt[j * N + i] = Math.round((i * 5 + j * 2.5) / 0.04);
  const header = { v: 2, ix: 10, iz: 20, cx: 1250, cz: -750, yBase: 200, size: 500, terrainN: N, terrainMin: 190, terrainScale: 0.04, coverN: 1, signs: [], objects: [] };
  const ground = (x: number, z: number): number => 190 + ((x - 1000) / 250) * 5 + ((z + 1000) / 250) * 2.5;
  // x, z, height, kind
  const stand = [1250 + 12.3, -750 - 100, 14.2, 1, 1250 - 249.9, -750 + 249.9, 6, 3, 1000, -1000, 21.8, 0];
  const n = stand.length / 4;
  const xz = new Int16Array(n * 2);
  const hk = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    xz[i * 2] = Math.round((stand[i * 4] - header.cx) / TREE_SCALE);
    xz[i * 2 + 1] = Math.round((stand[i * 4 + 1] - header.cz) / TREE_SCALE);
    hk[i] = Math.round(stand[i * 4 + 2] / TREE_HEIGHT_SCALE);
    hk[n + i] = stand[i * 4 + 3];
  }
  const ring = [1250 + 300.5, -750 - 12.25, 1250 - 40, -750 + 8];
  const packed = packTile(header, {
    hgt: encodeSection(hgt, CODING.GRID, N),
    treeXZ: encodeSection(xz, CODING.DELTA, 2),
    treeHK: hk,
    collQ: encodeSection(Int16Array.from(ring, (v, i) => Math.round((v - (i % 2 ? header.cz : header.cx)) / RING_SCALE)), CODING.PLANES, 2),
    collCnt: Uint16Array.from([2]),
  });
  const tile = unpackTile(packed.buffer as ArrayBuffer);
  const back = tile.get('trees') as Float32Array;
  assert.equal(back.length, n * 5);
  for (let i = 0; i < n; i++) {
    const [x, z, tall, kind] = stand.slice(i * 4, i * 4 + 4);
    assert.ok(Math.abs(back[i * 5] - x) < 0.001 && Math.abs(back[i * 5 + 2] - z) < 0.001, `tree ${i} stands where it was put`);
    // (it stands on the tile's ground: a plane here, so the height is that of the plane to the step of the grid)
    assert.ok(Math.abs(back[i * 5 + 1] - ground(x, z)) < 0.03, `tree ${i} stands on the ground: ${back[i * 5 + 1]} for ${ground(x, z)}`);
    assert.ok(Math.abs(back[i * 5 + 3] - tall) <= 0.11);
    assert.equal(back[i * 5 + 4], kind);
  }
  assert.ok(Math.abs(tileGround(header, hgt, 1125, -875) - ground(1125, -875)) < 0.03, 'the ground between the points of the grid');
  const pts = tile.get('collPts') as Float32Array;
  for (let i = 0; i < ring.length; i++) assert.ok(Math.abs(pts[i] - ring[i]) <= 0.011);
  assert.equal(tile.get('trees'), back, 'made once');

  // the first tiles of this kind: x, y, z per tree in steps of 2 cm
  const old = [1250 + 12.34, 200 + 3.5, -750 - 100.02, 14.2, 1, 1250 - 249.98, 200 - 20, -750 + 249.9, 6, 3];
  const q = new Int16Array(6);
  const hk2 = new Uint8Array(4);
  for (let i = 0; i < 2; i++) {
    q[i * 3] = Math.round((old[i * 5] - header.cx) / 0.02);
    q[i * 3 + 1] = Math.round((old[i * 5 + 1] - header.yBase) / 0.02);
    q[i * 3 + 2] = Math.round((old[i * 5 + 2] - header.cz) / 0.02);
    hk2[i] = Math.round(old[i * 5 + 3] / TREE_HEIGHT_SCALE);
    hk2[2 + i] = old[i * 5 + 4];
  }
  const before = unpackTile(packTile(header, { treeQ: encodeSection(q, CODING.DELTA, 3), treeHK: hk2 }).buffer as ArrayBuffer).get('trees') as Float32Array;
  assert.equal(before.length, old.length);
  for (let i = 0; i < old.length; i++) assert.ok(Math.abs(before[i] - old[i]) <= (i % 5 === 3 ? 0.11 : 0.011), `tree value ${i}: ${before[i]} for ${old[i]}`);
});

test('the set of squares that exist survives being written down', () => {
  const squares: Array<[number, number]> = [[400, 380], [401, 380], [403, 395], [399, 381]];
  const set = GridSet.of(squares);
  assert.equal(set.count, 4);
  const again = GridSet.from(JSON.parse(JSON.stringify(set)) as ReturnType<GridSet['toJSON']>);
  for (const [x, z] of squares) assert.ok(again.has(x, z));
  assert.equal(again.has(402, 380), false);
  assert.equal(again.has(0, 0), false);
  assert.equal(again.count, 4);
});
