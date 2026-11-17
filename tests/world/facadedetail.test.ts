// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { addLod2Buildings } from '../../tools/mapgen/buildings.ts';
import type { BuildingStats } from '../../tools/mapgen/buildings.ts';
import { detailSections, loadObservedBarriers, loadObservedFacades, matchWall } from '../../tools/mapgen/facadedetail.ts';
import { TileSet, meshSections } from '../../tools/mapgen/meshacc.ts';
import type { TileData } from '../../tools/mapgen/meshacc.ts';
import { OBSERVED, buildFacadeDetail, flagObservedWalls, makeDetailMaterial } from '../../src/render/facadedetail.ts';
import { packTile, unpackTile } from '../../src/world/tilefmt.ts';
import type { SectionArray } from '../../src/world/tilefmt.ts';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** A flat-roofed box of 10 × 8 m, 6 m high, on the ground at 200 m – the way the LoD2 models come (kind, x, y, z …). */
function boxUnit(id: string) {
  const y0 = 200;
  const y1 = 206;
  const ring: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [10, -8],
    [0, -8],
  ];
  const polys: number[][] = [];
  polys.push([2, ...ring.flatMap(([x, z]) => [x, y0, z])]);
  polys.push([1, ...ring.flatMap(([x, z]) => [x, y1, z])]);
  for (let i = 0; i < 4; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % 4];
    polys.push([0, ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az]);
  }
  return { id, fn: '31001_1000', roof: '1000', polys };
}

function build(facades = loadObservedFacades(fixture('observed-facades.sample.json'))): TileData {
  const ts = new TileSet(-250, -250, 250, 250, 500);
  const stats: BuildingStats = { lod2Units: 0, osmFallback: 0, triangles: 0, footprints: 0 };
  addLod2Buildings([boxUnit('DEHE_TEST_0001')], ts, stats, facades);
  return [...ts.tiles.values()][0];
}

/** The tile's sections as the map build writes them (only those that matter here). */
function pack(t: TileData): ArrayBuffer {
  const out: Record<string, SectionArray> = {};
  meshSections('bldg', t.bldg, 0, 0, 200, out);
  detailSections(t, 0, 0, 200, out);
  out.hgt = new Uint16Array(4);
  out.cov = new Uint8Array(1);
  const bin = packTile({ v: 2, ix: 0, iz: 0, cx: 0, cz: 0, yBase: 200, size: 500, terrainN: 2, terrainMin: 200, terrainScale: 0.04, coverN: 1, signs: [], objects: [] }, out);
  return bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
}

test('the measured walls are read; walls without ends are left out', () => {
  const f = loadObservedFacades(fixture('observed-facades.sample.json'));
  assert.equal(f.get('DEHE_TEST_0001')?.length, 2);
  assert.equal(loadObservedFacades(fixture('none.json')).size, 0);
});

test('a wall of the model is matched by its ends, either way round, within half a metre', () => {
  const walls = [{ a: [0.2, 0.1] as [number, number], b: [9.9, -0.2] as [number, number] }];
  const poly = [0, 200, 0, 10, 200, 0, 10, 206, 0, 0, 206, 0];
  const m = matchWall(poly, 0, 4, 1, 0, walls);
  assert.ok(m);
  assert.deepEqual(m.A, [0, 0]);
  assert.deepEqual(m.B, [10, 0]);
  // the other way round: A is still the end at the measured a
  const back = matchWall(poly, 0, 4, -1, 0, walls);
  assert.deepEqual(back?.A, [0, 0]);
  // a wall a metre off is not that wall
  assert.equal(matchWall(poly.map((v, i) => (i % 3 === 2 ? v + 1 : v)), 0, 4, 1, 0, walls), null);
});

test('a measured wall gets its details as geometry and is listed for the shader', () => {
  const t = build();
  // the one wall at z = 0: its four corners in the building mesh
  assert.equal(t.bldgObs.length, 2);
  const [first, n] = t.bldgObs;
  assert.equal(n, 4);
  for (let i = first; i < first + n; i++) assert.ok(Math.abs(t.bldg.pos[i * 3 + 2]) < 1e-9, 'a corner of the south wall');
  // plinth 2 + 3 windows × 14 + door 8 + shop front 10 + balcony 16 triangles
  const tris = t.fdet.idx.length / 3;
  assert.equal(tris, 2 + 3 * 14 + 8 + 10 + 16);
  // everything lies in front of the wall (south of it, z ≥ 0) and on it (0 ≤ x ≤ 10), up to the roof
  for (let i = 0; i < t.fdet.pos.length; i += 3) {
    assert.ok(t.fdet.pos[i + 2] >= -1e-9 && t.fdet.pos[i + 2] <= 1.41, `z ${t.fdet.pos[i + 2]}`);
    assert.ok(t.fdet.pos[i] >= -0.2 && t.fdet.pos[i] <= 10.2, `x ${t.fdet.pos[i]}`);
    assert.ok(t.fdet.pos[i + 1] >= 199.4 && t.fdet.pos[i + 1] <= 206.01, `y ${t.fdet.pos[i + 1]}`);
  }
  // the plinth in its measured colour
  assert.deepEqual(t.fdet.a8.slice(0, 3), [0x8e, 0x3a, 0x2e]);
});

test('without measured walls nothing changes', () => {
  const t = build(new Map());
  assert.equal(t.fdet.idx.length, 0);
  assert.equal(t.bldgObs.length, 0);
  const out: Record<string, SectionArray> = {};
  detailSections(t, 0, 0, 200, out);
  assert.deepEqual(Object.keys(out), []);
});

test('the game marks the walls once and builds the details – only when asked to (not on the low level)', () => {
  const data = unpackTile(pack(build()));
  const a8 = data.get('bldg_a8') as Uint8Array;
  const runs = data.get('bldg_obs') as Uint32Array;
  assert.deepEqual([...runs], [...build().bldgObs]);
  const before = Uint8Array.from(a8);
  assert.equal(flagObservedWalls(a8, runs), 4);
  assert.equal(flagObservedWalls(a8, runs), 0, 'a second time changes nothing');
  for (let i = 0; i < a8.length / 4; i++) {
    const marked = i >= runs[0] && i < runs[0] + runs[1];
    assert.equal(a8[i * 4], before[i * 4] + (marked ? OBSERVED : 0));
    assert.ok(a8[i * 4] < 32);
  }
  // the details: one level of detail per square that has any, all triangles there
  const disposables: Array<{ dispose(): void }> = [];
  const g = buildFacadeDetail(data, data.header, makeDetailMaterial(), disposables);
  assert.ok(g);
  let tris = 0;
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) tris += ((o as THREE.Mesh).geometry.index?.count ?? 0) / 3;
  });
  assert.equal(tris, 2 + 3 * 14 + 8 + 10 + 16);
  assert.ok(g.children.every((c) => (c as THREE.LOD).isLOD));
  assert.equal(disposables.length, g.children.length);
  // a tile without details (as on the low level the game does not even ask): nothing
  const plain = unpackTile(pack(build(new Map())));
  assert.equal(buildFacadeDetail(plain, plain.header, makeDetailMaterial(), []), null);
  assert.equal(flagObservedWalls(plain.get('bldg_a8') as Uint8Array, plain.get('bldg_obs')), 0);
});

test('the hedges, fences and walls seen on site are read; unknown kinds and single points are left out', () => {
  const b = loadObservedBarriers(fixture('observed-barriers.sample.json'));
  assert.deepEqual(
    b.map((x) => [x.kind, x.h, x.pts.length]),
    [
      ['hedge', 1.2, 6],
      ['fence', 1.2, 4],
      ['wall', 1.2, 4],
    ],
  );
});

test('the tile manager: details with facades (medium and up), none on plain buildings (low) – and built when facades come on', async () => {
  const { TileManager } = await import('../../src/render/tiles.ts');
  type LoadedTile = import('../../src/render/tiles.ts').LoadedTile;
  /** (build is private: what the test uses of the manager) */
  type Mgr = { build(key: string, data: ReturnType<typeof unpackTile>): LoadedTile; setFacades(on: boolean): void; tiles: Map<string, LoadedTile> };
  const count = (o: THREE.Object3D): number => {
    let n = 0;
    o.traverse((c) => {
      if (c.name === 'fdet' && (c as THREE.Mesh).isMesh) n++;
    });
    return n;
  };
  const low = new TileManager({ x0: -250, z0: -250, size: 500, has: () => true } as never, '') as unknown as Mgr;
  low.setFacades(false);
  const tile = low.build('0_0', unpackTile(pack(build())));
  assert.equal(tile.detail, undefined);
  assert.equal(count(tile.group), 0);
  // (the walls are marked all the same: the plain material does not look at the style)
  assert.equal((tile.data.get('bldg_a8') as Uint8Array)[tile.data.get('bldg_obs')![0] * 4] >= OBSERVED, true);
  low.tiles.set(tile.key, tile);
  low.setFacades(true);
  // (read anew: the call above set it)
  const detail = (tile as { detail?: THREE.Group | null }).detail;
  assert.ok(detail && detail.visible);
  assert.equal(count(tile.group), 1);
  low.setFacades(false);
  assert.equal(detail.visible, false);

  const medium = new TileManager({ x0: -250, z0: -250, size: 500, has: () => true } as never, '') as unknown as Mgr;
  const t2 = medium.build('0_0', unpackTile(pack(build())));
  assert.equal(count(t2.group), 1);
});
