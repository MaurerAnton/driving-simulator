// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The versions before 1.6.0 read the map of today (tools/old-versions.ts,
 * the version picker).  Their tile reader – src/world/tilefmt.ts and
 * facade.ts, the same from v1.0.0 to v1.5.0 – is kept as it was in
 * fixtures/tilefmt-1.0.0.  A tile with the sections that came in 1.6.0 (the
 * measured details of walls: fdet_*, bldg_obs) must give that reader
 * exactly what the same tile without them gives, for every section the old
 * game asks for (src/render/tiles.ts, the physics: hgt, cov, the meshes,
 * trees, collision rings and segments).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { addLod2Buildings } from '../../tools/mapgen/buildings.ts';
import type { BuildingStats } from '../../tools/mapgen/buildings.ts';
import { detailSections, loadObservedFacades } from '../../tools/mapgen/facadedetail.ts';
import { TileSet, addQuad, meshSections } from '../../tools/mapgen/meshacc.ts';
import { packFaces } from '../../src/world/facade.ts';
import { CODING, encodeSection, packTile, unpackTile } from '../../src/world/tilefmt.ts';
import type { CodedSection, SectionArray } from '../../src/world/tilefmt.ts';
import { unpackTile as oldUnpackTile } from './fixtures/tilefmt-1.0.0/tilefmt.ts';

/** what the old game asks a tile for */
const OLD_NAMES = [
  'hgt',
  'cov',
  ...['ground', 'mark', 'struct', 'bldg'].flatMap((m) => [`${m}_pos`, `${m}_idx`, `${m}_a8`]),
  'bldg_a16',
  'trees',
  'collPts',
  'collCnt',
  'collSkip',
  'collSeg',
];

/** A tile the way tools/build-tiles.ts writes it – with the measured details (`details`) or as before 1.6.0. */
function tile(details: boolean): ArrayBuffer {
  const ts = new TileSet(-250, -250, 250, 250, 500);
  const stats: BuildingStats = { lod2Units: 0, osmFallback: 0, triangles: 0, footprints: 0 };
  const facades = details ? loadObservedFacades(fileURLToPath(new URL('./fixtures/observed-facades.sample.json', import.meta.url))) : new Map();
  const y0 = 200;
  const ring: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [10, -8],
    [0, -8],
  ];
  const polys: number[][] = [[2, ...ring.flatMap(([x, z]) => [x, y0, z])], [1, ...ring.flatMap(([x, z]) => [x, y0 + 6, z])]];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % 4];
    polys.push([0, ax, y0, az, bx, y0, bz, bx, y0 + 6, bz, ax, y0 + 6, az]);
  }
  addLod2Buildings([{ id: 'DEHE_TEST_0001', fn: '31001_1000', roof: '1000', polys }], ts, stats, facades);
  const t = [...ts.tiles.values()][0];
  addQuad(ts, 'ground', [-5, 200, 5, 5, 200, 5, 5, 200, 10, -5, 200, 10], [0]);
  addQuad(ts, 'mark', [-1, 200.02, 6, 1, 200.02, 6, 1, 200.02, 7, -1, 200.02, 7], [20]);
  addQuad(ts, 'struct', [20, 200, 0, 30, 200, 0, 30, 201, 0, 20, 201, 0], [150, 150, 150], 0, 0, 1);
  t.collSeg.push(20, 0, 30, 0, 200);

  // (as in tools/build-tiles.ts: faces packed, numbers in their codings)
  const plain: Record<string, SectionArray> = {};
  for (const m of ['ground', 'mark', 'struct', 'bldg'] as const) meshSections(m, t[m], 0, 0, 200, plain);
  if (details) detailSections(t, 0, 0, 200, plain);
  const sections: Record<string, SectionArray | CodedSection> = { hgt: encodeSection(Uint16Array.from([0, 3, 5, 9]), CODING.GRID, 2), cov: new Uint8Array([4]) };
  const f = packFaces(plain.bldg_pos as Int16Array, plain.bldg_idx as Uint16Array, plain.bldg_a16 as Int16Array);
  delete plain.bldg_a16;
  sections.bldg_run = f.run;
  if (f.uvx.length) sections.bldg_uvx = f.uvx;
  for (const [key, arr] of Object.entries(plain)) {
    if (arr instanceof Float32Array) sections[key] = arr;
    else if (key.endsWith('_pos') || key.endsWith('_idx')) sections[key] = encodeSection(arr, CODING.DELTA, 3);
    else sections[key] = arr;
  }
  sections.treeXZ = encodeSection(Int16Array.from([10, 20, -30, 40]), CODING.PLANES, 2);
  sections.treeHK = Uint8Array.from([50, 60, 1, 2]);
  sections.collQ = encodeSection(Int16Array.from(t.collPts.map((v) => Math.round(v / 0.02))), CODING.DELTA, 2);
  sections.collCnt = Uint16Array.from(t.collCnt);
  sections.collSeg = Float32Array.from(t.collSeg);
  const bin = packTile(
    { v: 2, ix: 0, iz: 0, cx: 0, cz: 0, yBase: 200, size: 500, terrainN: 2, terrainMin: 199, terrainScale: 0.04, coverN: 1, signs: [], objects: [], clr: 1 },
    sections,
  );
  return bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
}

test('the tile has the new sections, and only beside the old ones', () => {
  const now = unpackTile(tile(true));
  const before = unpackTile(tile(false));
  for (const s of ['fdet_pos', 'fdet_idx', 'fdet_a8', 'bldg_obs']) {
    assert.ok(now.header.sections[s], s);
    assert.equal(before.header.sections[s], undefined);
  }
  assert.deepEqual(
    Object.keys(now.header.sections).filter((k) => !k.startsWith('fdet_') && k !== 'bldg_obs'),
    Object.keys(before.header.sections),
  );
});

test('the reader of versions 1.0.0 – 1.5.0 gets from a 1.6.0 tile exactly what it got before', () => {
  const now = oldUnpackTile(tile(true));
  const before = oldUnpackTile(tile(false));
  const { sections: s1, ...h1 } = now.header;
  const { sections: s0, ...h0 } = before.header;
  assert.deepEqual(h1, h0);
  for (const name of OLD_NAMES) {
    const a = now.get(name);
    const b = before.get(name);
    assert.deepEqual(a === null ? null : Array.from(a), b === null ? null : Array.from(b), name);
  }
  // and the building faces it works out (bldg_a16 from bldg_run) fit the corners
  assert.equal(now.get('bldg_a16')!.length, (now.get('bldg_pos')!.length / 3) * 4);
  void s0;
  void s1;
});

test('the old reader and the new one agree on every section of a 1.6.0 tile', () => {
  const buf = tile(true);
  const old = oldUnpackTile(buf);
  const now = unpackTile(buf);
  for (const name of [...OLD_NAMES, 'fdet_pos', 'fdet_idx', 'fdet_a8', 'bldg_obs']) {
    const a = old.get(name);
    const b = now.get(name);
    assert.deepEqual(a === null ? null : Array.from(a), b === null ? null : Array.from(b), name);
  }
});
