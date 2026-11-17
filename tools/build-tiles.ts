// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Map pipeline, step 3 of 3: the tiles of one block of 8 km – terrain, road
 * meshes, buildings, signs, vegetation.
 *
 *   node --max-old-space-size=3072 tools/build-tiles.ts <bx>_<bz> [<bx>_<bz> …]
 *
 * (tools/build-map.ts runs it for every block of the region, several at a time.)
 *
 * Inputs:
 *   data/work/graph/b_<bx>_<bz>.json.gz   the road network of the block (tools/build-graph.ts)
 *   data/work/osm/b_<bx>_<bz>.json.gz     everything else of OpenStreetMap there (tools/osm-extract.ts)
 *   data/work/dgm2, data/work/lod2        terrain and building models (tools/fetch-geodata.py)
 * Output:
 *   public/map/tiles/<ix>_<iz>.fsb        the tiles of the block that have terrain
 *   data/work/graph/r_<bx>_<bz>.json      which tiles, how big, the practice yard if it lies here
 *
 * A block is built with a ring of one tile around it, so that what reaches
 * over its border – a road, a house, the shaping of the ground along a road –
 * comes out the same from both sides.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gunzipSync, gzipSync } from 'node:zlib';
import { POST_CLEAR, WALL_CLEAR, clearObjects, clearSigns, postInLane, ringSidesInLanes } from '../src/sim/clearlanes.ts';
import { LaneGraph } from '../src/world/lanes.ts';
import type { PathFoot } from '../src/world/lanes.ts';
import { packFaces } from '../src/world/facade.ts';
import { CODING, RING_SCALE, TREE_HEIGHT_SCALE, TREE_SCALE, encodeSection, packTile, tileKey } from '../src/world/tilefmt.ts';
import type { CodedSection, SectionArray } from '../src/world/tilefmt.ts';
import type { WorldJson, YardJson } from '../src/world/types.ts';
import { World } from '../src/world/world.ts';
import { addLod2Buildings, addOsmBuildings, lod2Units } from './mapgen/buildings.ts';
import type { BuildingStats } from './mapgen/buildings.ts';
import { buildCover } from './mapgen/cover.ts';
import { Dgm } from './mapgen/dgm.ts';
import { TileSet, meshSections } from './mapgen/meshacc.ts';
import { addBarriersAndRails, addLamps, addVegetation, buildingMask } from './mapgen/objects.ts';
import { OsmData } from './mapgen/osm.ts';
import type { ONode } from './mapgen/osm.ts';
import { RoadMesher } from './mapgen/roadmesh.ts';
import type { EdgeFeature } from './mapgen/roads.ts';
import { SignPlacer } from './mapgen/signs.ts';
import { BLOCK, Coverage, HALO, TILE, gridIndex, gridRect, grow } from './mapgen/store.ts';
import { buildTerrain } from './mapgen/terrain.ts';
import { findYard } from './mapgen/yard.ts';
import { pointInRing } from '../src/core/geom.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, process.env.MAP_OUT ?? 'public/map');
const workDir = resolve(root, 'data/work/graph');
const TERRAIN_CELL = 5;

interface BlockFile {
  block: [number, number];
  world: WorldJson;
  nodes: number[];
  edges: number[];
  nodeOsm: Array<ONode | null>;
  edgeFeatures: EdgeFeature[][];
  municipalities: Array<{ name: string; sign: string; lod2: boolean; rings: number[][] }>;
  yardNear: { x: number; z: number } | null;
}

export interface BlockResult {
  block: [number, number];
  tiles: Array<[number, number]>;
  bytes: number;
  triangles: number;
  seconds: number;
  yard: YardJson | null;
  /** what was taken out of the lanes: signs moved, signs dropped, lamps, trunks, sides of buildings */
  cleared: number[];
  stats: string;
}

/** The smallest of the ways to store a section of whole numbers (by what it comes to deflated). */
function smallest(a: Exclude<SectionArray, Float32Array>, stride: number, codings: number[]): CodedSection {
  let best: CodedSection | null = null;
  let size = Infinity;
  for (const c of codings) {
    const coded = encodeSection(a, c, stride);
    const n = deflateRawSync(coded.bytes, { level: 6 }).length;
    if (n < size) {
      size = n;
      best = coded;
    }
  }
  return best as CodedSection;
}

function buildBlock(bx: number, bz: number, coverage: Coverage, dgm: Dgm): BlockResult {
  const t0 = Date.now();
  const name = `${bx}_${bz}`;
  const info = JSON.parse(gunzipSync(readFileSync(resolve(workDir, `b_${name}.json.gz`))).toString('utf8')) as BlockFile;
  const osm = OsmData.load(resolve(root, 'data/work/osm', `b_${name}.json.gz`));
  const block = gridRect(bx, bz, BLOCK);
  // Only the part of the block that has terrain is built (with a ring of one tile around it):
  // at the rim of the region that is often a corner of it.
  const core = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (let x = block.minX; x < block.maxX; x += TILE) {
    for (let z = block.minZ; z < block.maxZ; z += TILE) {
      if (!coverage.touches({ minX: x, minZ: z, maxX: x + TILE, maxZ: z + TILE })) continue;
      core.minX = Math.min(core.minX, x);
      core.maxX = Math.max(core.maxX, x + TILE);
      core.minZ = Math.min(core.minZ, z);
      core.maxZ = Math.max(core.maxZ, z + TILE);
    }
  }
  if (core.minX > core.maxX) {
    const none: BlockResult = { block: [bx, bz], tiles: [], bytes: 0, triangles: 0, seconds: 0, yard: null, cleared: [0, 0, 0, 0, 0], stats: 'no terrain here' };
    writeFileSync(resolve(workDir, `r_${name}.json`), JSON.stringify(none));
    return none;
  }
  const window = grow(core, HALO);
  const inWindow = (x: number, z: number): boolean => x >= window.minX && x <= window.maxX && z >= window.minZ && z <= window.maxZ;
  const inWorld = (x: number, z: number): boolean => inWindow(x, z) && coverage.covered(x, z);

  const cover = buildCover(osm, window.minX, window.minZ, window.maxX, window.maxZ);
  const world = new World(info.world);
  const lanes = new LaneGraph(world);
  const inLane = (x1: number, z1: number, x2: number, z2: number, y: number): boolean => lanes.wallInLane(x1, z1, x2, z2, y, WALL_CLEAR);
  const terrain = buildTerrain(dgm, world, window, TERRAIN_CELL);
  const tiles = new TileSet(window.minX, window.minZ, window.maxX, window.maxZ, TILE);
  const mesher = new RoadMesher(world, tiles, { ground: (x, z) => terrain.at(x, z), inLane });
  mesher.build();

  // ---- buildings: the official models where they were fetched, footprints of OpenStreetMap elsewhere ----
  const bstats: BuildingStats = { lod2Units: 0, osmFallback: 0, triangles: 0, footprints: 0 };
  addLod2Buildings(lod2Units(resolve(root, 'data/work/lod2'), grow(window, 150)), tiles, bstats);
  addOsmBuildings(osm, tiles, terrain, inWorld, info.municipalities.filter((m) => m.lod2).flatMap((m) => m.rings), bstats);

  // ---- signs, walls, vegetation, street furniture ----
  const signs = new SignPlacer(world, tiles, info.world.places);
  signs.municipalityAt = (x, z) => {
    for (const m of info.municipalities) {
      let inside = false;
      for (const ring of m.rings) if (pointInRing(x, z, ring)) inside = !inside;
      if (inside) return m;
    }
    return null;
  };
  // (the ways the roads were made of – the times on their signs – and the signs mapped beside the roads)
  signs.osm = osm;
  signs.build({ edgeFeatures: info.edgeFeatures, nodeOsm: info.nodeOsm }, cover);
  const bmask = buildingMask(tiles, cover);
  const extra = addBarriersAndRails(osm, world, cover, terrain, tiles, inWorld, inLane);
  const veg = addVegetation(osm, world, cover, terrain, tiles, bmask, window);
  const lamps = addLamps(osm, world, terrain, tiles);
  const yard = info.yardNear ? findYard(cover, terrain, world, osm, bmask, inWorld, info.yardNear) : null;

  // ---- the tiles of the block ----
  mkdirSync(resolve(outDir, 'tiles'), { recursive: true });
  const perTile = TILE / TERRAIN_CELL;
  const terrainN = perTile + 1;
  const coverN = TILE / cover.cell;
  const result: BlockResult = { block: [bx, bz], tiles: [], bytes: 0, triangles: 0, seconds: 0, yard, cleared: [0, 0, 0, 0, 0], stats: '' };
  const foot: PathFoot = { x: 0, z: 0, d: 0 };
  // corners of building faces, and how many of them need no stored facade coordinates
  let corners = 0;
  let ruled = 0;
  for (let lz = 1; lz < tiles.nz - 1; lz++) {
    for (let lx = 1; lx < tiles.nx - 1; lx++) {
      const cx = window.minX + (lx + 0.5) * TILE;
      const cz = window.minZ + (lz + 0.5) * TILE;
      // (no terrain, no tile)
      if (!coverage.touches({ minX: cx - TILE / 2, minZ: cz - TILE / 2, maxX: cx + TILE / 2, maxZ: cz + TILE / 2 })) continue;
      const t = tiles.at(cx, cz);
      const ix = gridIndex(cx, TILE);
      const iz = gridIndex(cz, TILE);
      // terrain window
      let tMin = Infinity;
      let tMax = -Infinity;
      const hRaw = new Float32Array(terrainN * terrainN);
      for (let j = 0; j < terrainN; j++) {
        for (let i = 0; i < terrainN; i++) {
          const v = terrain.data[(lz * perTile + j) * terrain.w + lx * perTile + i];
          hRaw[j * terrainN + i] = v;
          if (v < tMin) tMin = v;
          if (v > tMax) tMax = v;
        }
      }
      // The ground in steps of 4 cm (finer than anyone sees on a meadow, and a third smaller than
      // centimetres) – in whole steps from sea level, so that a point has the same height in the
      // tile beside it.  Roads do not take their heights from here.
      const terrainScale = 0.04;
      const minSteps = Math.floor(tMin / terrainScale);
      const terrainMin = Math.round(minSteps * terrainScale * 100) / 100;
      const hgt = new Uint16Array(terrainN * terrainN);
      for (let k = 0; k < hgt.length; k++) hgt[k] = Math.max(0, Math.min(65535, Math.round(hRaw[k] / terrainScale) - minSteps));
      const cov = new Uint8Array(coverN * coverN);
      for (let j = 0; j < coverN; j++) {
        const row = (lz * coverN + j) * cover.w + lx * coverN;
        cov.set(cover.data.subarray(row, row + coverN), j * coverN);
      }
      const yBase = Math.round((tMin + tMax) / 2);

      // Nothing of the scenery stands in a lane (src/sim/clearlanes.ts): posts beside it, lamps
      // and trunks dropped; the sides of footprints that reach in are marked, the game leaves them out.
      const [moved, dropped] = clearSigns(lanes, t.signs);
      const lampsOut = clearObjects(lanes, t.objects);
      const trees: number[] = [];
      let trunks = 0;
      for (let i = 0; i < t.trees.length; i += 5) {
        if (t.trees[i + 4] !== 2 && lanes.nearestPath(t.trees[i], t.trees[i + 2], t.trees[i + 1], POST_CLEAR, foot) < POST_CLEAR) trunks++;
        else trees.push(t.trees[i], t.trees[i + 1], t.trees[i + 2], t.trees[i + 3], t.trees[i + 4]);
      }
      const skip = ringSidesInLanes(lanes, t.collPts, t.collCnt);
      let sides = 0;
      if (skip) for (const b of skip) for (let v = b; v; v &= v - 1) sides++;
      [moved, dropped, lampsOut, trunks, sides].forEach((v, i) => (result.cleared[i] += v));

      const plain: Record<string, SectionArray> = {};
      meshSections('ground', t.ground, cx, cz, yBase, plain);
      meshSections('mark', t.mark, cx, cz, yBase, plain);
      meshSections('struct', t.struct, cx, cz, yBase, plain);
      meshSections('bldg', t.bldg, cx, cz, yBase, plain);
      const sections: Record<string, SectionArray | CodedSection> = { hgt: smallest(hgt, terrainN, [CODING.GRID]), cov };
      // what the faces of the buildings need for their facades: stored only where it does not follow from their corners
      if (plain.bldg_a16 && plain.bldg_pos && plain.bldg_idx) {
        const f = packFaces(plain.bldg_pos as Int16Array, plain.bldg_idx as Uint16Array | Uint32Array, plain.bldg_a16 as Int16Array);
        corners += plain.bldg_pos.length / 3;
        ruled += f.ruled;
        delete plain.bldg_a16;
        sections.bldg_run = smallest(f.run, 1, [CODING.RAW, CODING.PLANES, CODING.DELTA]);
        if (f.uvx.length) sections.bldg_uvx = smallest(f.uvx, 4, [CODING.RAW, CODING.PLANES, CODING.DELTA]);
      }
      for (const [key, arr] of Object.entries(plain)) {
        if (arr instanceof Float32Array) sections[key] = arr;
        else if (key.endsWith('_pos') || key.endsWith('_idx')) sections[key] = smallest(arr, 3, [CODING.RAW, CODING.PLANES, CODING.DELTA]);
        else if (key.endsWith('_a16')) sections[key] = smallest(arr, 4, [CODING.RAW, CODING.PLANES, CODING.DELTA]);
        else sections[key] = arr;
      }
      if (trees.length) {
        // sorted in strips from north to south and from west to east within a strip: neighbours stand near each other
        const n = trees.length / 5;
        const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => Math.floor(trees[p * 5 + 2] / 16) - Math.floor(trees[q * 5 + 2] / 16) || trees[p * 5] - trees[q * 5]);
        // (where it stands; its foot is on the tile's ground, which the game has from the grid of heights)
        const q = new Int16Array(n * 2);
        const hk = new Uint8Array(n * 2);
        order.forEach((src, i) => {
          q[i * 2] = Math.round((trees[src * 5] - cx) / TREE_SCALE);
          q[i * 2 + 1] = Math.round((trees[src * 5 + 2] - cz) / TREE_SCALE);
          hk[i] = Math.max(1, Math.min(255, Math.round(trees[src * 5 + 3] / TREE_HEIGHT_SCALE)));
          hk[n + i] = trees[src * 5 + 4];
        });
        sections.treeXZ = smallest(q, 2, [CODING.PLANES, CODING.DELTA]);
        sections.treeHK = hk;
      }
      if (t.collPts.length) {
        const q = new Int16Array(t.collPts.length);
        for (let i = 0; i < q.length; i += 2) {
          q[i] = Math.max(-32767, Math.min(32767, Math.round((t.collPts[i] - cx) / RING_SCALE)));
          q[i + 1] = Math.max(-32767, Math.min(32767, Math.round((t.collPts[i + 1] - cz) / RING_SCALE)));
        }
        sections.collQ = smallest(q, 2, [CODING.PLANES, CODING.DELTA]);
        sections.collCnt = Uint16Array.from(t.collCnt);
        if (skip) sections.collSkip = skip;
      }
      if (t.collSeg.length) sections.collSeg = Float32Array.from(t.collSeg);
      const bin = packTile(
        { v: 2, ix, iz, cx, cz, yBase, size: TILE, terrainN, terrainMin, terrainScale, coverN, signs: t.signs, objects: t.objects, clr: 1 },
        sections,
      );
      // gzip here: static hosts do not compress binary files on their own
      const gz = gzipSync(bin, { level: 9 });
      writeFileSync(resolve(outDir, 'tiles', `${tileKey(ix, iz)}.fsb`), gz);
      result.tiles.push([ix, iz]);
      result.bytes += gz.length;
      result.triangles += (t.ground.idx.length + t.mark.idx.length + t.struct.idx.length + t.bldg.idx.length) / 3;
    }
  }
  result.seconds = Math.round((Date.now() - t0) / 1000);
  result.stats =
    `${mesher.stats.edges} ribbons, ${mesher.stats.junctions} junction areas, ${mesher.stats.bridges} bridges; ` +
    `${bstats.lod2Units} building models, ${bstats.osmFallback} footprints` +
    `${corners ? ` (facades of ${((ruled / corners) * 100).toFixed(1)} % of the corners by rule)` : ''}; ${signs.stats.posts} sign posts, ${lamps} lamps, ` +
    `${veg.mapped + veg.rows + veg.forest + veg.garden} trees, ${extra.barriers} walls and hedges, ${extra.guardKm.toFixed(1)} km of guard rail`;
  writeFileSync(resolve(workDir, `r_${name}.json`), JSON.stringify(result));
  return result;
}

const names = process.argv.slice(2).filter((a) => /^\d+_\d+$/.test(a));
if (names.length === 0) {
  console.error('usage: node tools/build-tiles.ts <bx>_<bz> [<bx>_<bz> …]   (the blocks are listed in data/work/graph/plan.json)');
  process.exit(2);
}
const coverage = new Coverage(root, true);
const dgm = new Dgm(resolve(root, 'data/work/dgm2'), 160);
for (const name of names) {
  if (!existsSync(resolve(workDir, `b_${name}.json.gz`))) {
    console.error(`[tiles] no block ${name} – run tools/build-graph.ts first`);
    process.exit(1);
  }
  const [bx, bz] = name.split('_').map(Number);
  const r = buildBlock(bx, bz, coverage, dgm);
  console.log(
    `[tiles] block ${name}: ${r.tiles.length} tiles, ${(r.bytes / 1048576).toFixed(1)} MB, ${Math.round(r.triangles / 1000)}k triangles in ${r.seconds} s – ${r.stats}` +
      `; out of the lanes: ${r.cleared[0]} signs moved, ${r.cleared[1]} dropped, ${r.cleared[2]} lamps, ${r.cleared[3]} trunks, ${r.cleared[4]} sides of buildings`,
  );
}
