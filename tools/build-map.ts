// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Map pipeline: OSM extract + Hessen DGM1 + Hessen LoD2  →  public/map/
 *
 *   node --max-old-space-size=3072 tools/build-map.ts [--debug]
 *
 * Inputs (see docs/MAP_DATA.md for download commands):
 *   data/work/osm-extract.json        (tools/osm-extract.ts)
 *   data/raw/dgm1/tiles/*.tif         (Hessen DGM1, unzipped)
 *   data/raw/lod2/Baunatal-LoD2.gml   (Hessen LoD2, unzipped)
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  WORLD_MAX_E,
  WORLD_MAX_N,
  WORLD_MIN_E,
  WORLD_MIN_N,
  WORLD_ORIGIN_E,
  WORLD_ORIGIN_N,
} from '../src/geo/utm.ts';
import { buildCover } from './mapgen/cover.ts';
import { Dgm } from './mapgen/dgm.ts';
import { solveElevation } from './mapgen/elevation.ts';
import { OsmData } from './mapgen/osm.ts';
import { buildRoadGraph, roadStats } from './mapgen/roads.ts';
import { DebugSvg } from './mapgen/debug.ts';
import { deriveControl } from './mapgen/control.ts';
import { World, computeAllCuts } from '../src/world/world.ts';
import { CTRL, ROLE, XING } from '../src/world/types.ts';
import type { WorldJson } from '../src/world/types.ts';
import { newPolySample, samplePolyline, offsetPolyline, slicePolyline } from '../src/core/geom.ts';
import { packTile, tileKey } from '../src/world/tilefmt.ts';
import type { SectionArray } from '../src/world/tilefmt.ts';
import { TileSet, meshSections } from './mapgen/meshacc.ts';
import { RoadMesher } from './mapgen/roadmesh.ts';
import { buildTerrain } from './mapgen/terrain.ts';
import { addLod2Buildings, addOsmBuildings } from './mapgen/buildings.ts';
import type { BuildingStats } from './mapgen/buildings.ts';
import { SignPlacer } from './mapgen/signs.ts';
import { addBarriersAndRails, addLamps, addVegetation, buildingMask, collectPlaces, collectSpawns } from './mapgen/objects.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const DEBUG = args.has('--debug');
const t0 = Date.now();
const lap = (msg: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);

const bounds = {
  minX: WORLD_MIN_E - WORLD_ORIGIN_E,
  maxX: WORLD_MAX_E - WORLD_ORIGIN_E,
  minZ: -(WORLD_MAX_N - WORLD_ORIGIN_N),
  maxZ: -(WORLD_MIN_N - WORLD_ORIGIN_N),
};

const osm = OsmData.load(resolve(root, 'data/work/osm-extract.json'));
lap(`OSM extract: ${osm.nodes.size} nodes, ${osm.ways.length} ways, ${osm.relations.length} relations`);
const dgm = await Dgm.load(resolve(root, 'data/raw/dgm1/tiles'), resolve(root, 'data/work/dgm'));
lap('terrain model loaded');

const cover = buildCover(osm, bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ);
lap(`ground cover raster ${cover.w}x${cover.h}`);

const graph = buildRoadGraph(osm, dgm, cover, bounds);
lap(`road graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges — km: ${roadStats(graph)}`);

const elev = solveElevation(graph, dgm);
lap(
  `elevation solved: max grade ${(elev.maxGrade * 100).toFixed(1)} %, ${elev.steepEdges} edges > 20 %, ` +
    `${elev.lowClearances} low bridge clearances (${elev.fixedClearances} decks raised)`,
);

const control = deriveControl(graph, osm);
lap(`right-of-way: ${Object.entries(control.report).map(([k, v]) => `${v} ${k}`).join(', ')}`);

const worldJson: WorldJson = {
  version: 1,
  meta: {
    name: 'Baunatal',
    generated: new Date().toISOString(),
    ...bounds,
    tileSize: 500,
    originE: WORLD_ORIGIN_E,
    originN: WORLD_ORIGIN_N,
    attribution: [
      'Straßennetz, Verkehrsregelung, Flächennutzung: © OpenStreetMap-Mitwirkende (ODbL 1.0)',
      'Gelände (DGM1) und Gebäude (LoD2): Hessische Verwaltung für Bodenmanagement und Geoinformation (offene Geobasisdaten)',
    ],
  },
  nodes: graph.nodes,
  edges: graph.edges,
  banned: control.banned,
  signals: control.signals,
  crossings: control.crossings,
  places: [],
  spawns: [],
  tiles: [],
};
computeAllCuts(worldJson);
// stop / give-way lines never lie inside the junction area
worldJson.nodes.forEach((n, ni) => {
  for (const arm of n.arms) {
    const e = worldJson.edges[arm.e];
    const cut = e.a === ni ? e.ca : e.cb;
    const controlled = arm.r === ROLE.YIELD || arm.r === ROLE.STOP || arm.g !== undefined;
    if (controlled) arm.sl = Math.round(Math.max(arm.sl ?? 0, cut + 0.4) * 100) / 100;
    else delete arm.sl;
  }
});
const world = new World(worldJson);
lap(`junction geometry: ${world.nodes.filter((n) => n.shape).length} junction areas`);

// ---- terrain, meshes, tiles -------------------------------------------------
const TILE = worldJson.meta.tileSize;
const TERRAIN_CELL = 5;
const terrain = buildTerrain(dgm, world, bounds, TERRAIN_CELL, resolve(root, `data/work/terrain-natural-${TERRAIN_CELL}m.f32`));
lap('terrain grid ready');

const tiles = new TileSet(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ, TILE);
const mesher = new RoadMesher(world, tiles, { ground: (x, z) => terrain.at(x, z) });
mesher.build();
lap(`road meshes: ${mesher.stats.edges} ribbons, ${mesher.stats.junctions} junction areas, ${mesher.stats.bridges} bridges, ${mesher.stats.paintQuads} paint quads`);

const inRect = (x: number, z: number): boolean => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
const inWorld = (x: number, z: number): boolean => inRect(x, z) && dgm.covered(x, z);

// ---- buildings ----------------------------------------------------------------
const bstats: BuildingStats = { lod2Units: 0, osmFallback: 0, triangles: 0, footprints: 0 };
const lod2Path = resolve(root, 'data/work/lod2-buildings.json');
if (existsSync(lod2Path)) addLod2Buildings(lod2Path, tiles, bstats);
else console.warn('[buildings] data/work/lod2-buildings.json missing – run `node tools/lod2-extract.ts` (falling back to OSM footprints only)');
const boundary = osm.relations.find((r) => r.tags.boundary === 'administrative' && r.tags.name === 'Baunatal' && r.tags.admin_level === '8');
const municipality = boundary && existsSync(lod2Path) ? osm.multipolygonRings(boundary).outer : [];
addOsmBuildings(osm, tiles, terrain, inWorld, municipality, bstats);
lap(`buildings: ${bstats.lod2Units} LoD2 units, ${bstats.osmFallback} from OSM footprints, ${Math.round(bstats.triangles / 1000)}k triangles, ${bstats.footprints} collision footprints`);

// ---- signs, vegetation, street furniture ---------------------------------------
worldJson.places = collectPlaces(osm, inRect);
const signs = new SignPlacer(world, tiles, worldJson.places);
signs.build(graph, cover);
lap(`signs: ${signs.stats.posts} posts — ${[...signs.stats.byCode.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' ')}`);
const bmask = buildingMask(tiles, cover);
const extra = addBarriersAndRails(osm, world, cover, terrain, tiles, inWorld);
const veg = addVegetation(osm, world, cover, terrain, tiles, bmask, bounds);
const lamps = addLamps(osm, world, terrain, tiles);
lap(`vegetation: ${veg.mapped} mapped trees, ${veg.rows} in rows, ${veg.forest} woodland, ${veg.garden} garden; ${lamps} street lamps; ${extra.barriers} walls/hedges, ${extra.railKm.toFixed(1)} km rail, ${extra.guardKm.toFixed(1)} km guard rail`);
worldJson.spawns = collectSpawns(osm, world, terrain, worldJson.places, inWorld);
lap(`start points: ${worldJson.spawns.map((s) => s.name).join('; ')}`);

const outDir = resolve(root, 'public/map');
rmSync(resolve(outDir, 'tiles'), { recursive: true, force: true });
mkdirSync(resolve(outDir, 'tiles'), { recursive: true });
const perTile = TILE / TERRAIN_CELL;
const terrainN = perTile + 1;
const coverN = TILE / cover.cell;
let bytes = 0;
let tris = 0;
for (let iz = 0; iz < tiles.nz; iz++) {
  for (let ix = 0; ix < tiles.nx; ix++) {
    const t = tiles.at(bounds.minX + (ix + 0.5) * TILE, bounds.minZ + (iz + 0.5) * TILE);
    const cx = bounds.minX + (ix + 0.5) * TILE;
    const cz = bounds.minZ + (iz + 0.5) * TILE;
    // terrain window
    let tMin = Infinity;
    let tMax = -Infinity;
    const hRaw = new Float32Array(terrainN * terrainN);
    for (let j = 0; j < terrainN; j++) {
      for (let i = 0; i < terrainN; i++) {
        const v = terrain.data[(iz * perTile + j) * terrain.w + ix * perTile + i];
        hRaw[j * terrainN + i] = v;
        if (v < tMin) tMin = v;
        if (v > tMax) tMax = v;
      }
    }
    const terrainScale = 0.01;
    const hgt = new Uint16Array(terrainN * terrainN);
    for (let k = 0; k < hgt.length; k++) hgt[k] = Math.min(65535, Math.round((hRaw[k] - tMin) / terrainScale));
    const cov = new Uint8Array(coverN * coverN);
    for (let j = 0; j < coverN; j++) {
      const row = (iz * coverN + j) * cover.w + ix * coverN;
      cov.set(cover.data.subarray(row, row + coverN), j * coverN);
    }
    const yBase = Math.round((tMin + tMax) / 2);
    const sections: Record<string, SectionArray> = { hgt, cov };
    meshSections('ground', t.ground, cx, cz, yBase, sections);
    meshSections('mark', t.mark, cx, cz, yBase, sections);
    meshSections('struct', t.struct, cx, cz, yBase, sections);
    meshSections('bldg', t.bldg, cx, cz, yBase, sections);
    if (t.trees.length) sections.trees = Float32Array.from(t.trees);
    if (t.collPts.length) {
      sections.collPts = Float32Array.from(t.collPts);
      sections.collCnt = Uint16Array.from(t.collCnt);
    }
    if (t.collSeg.length) sections.collSeg = Float32Array.from(t.collSeg);
    const bin = packTile(
      {
        v: 1,
        ix,
        iz,
        cx,
        cz,
        yBase,
        size: TILE,
        terrainN,
        terrainMin: Math.round(tMin * 100) / 100,
        terrainScale,
        coverN,
        signs: t.signs,
        objects: t.objects,
      },
      sections,
    );
    // gzip here: static hosts do not compress binary files on their own
    const gz = gzipSync(bin, { level: 9 });
    writeFileSync(resolve(outDir, 'tiles', `${tileKey(ix, iz)}.fsb`), gz);
    worldJson.tiles.push(tileKey(ix, iz));
    bytes += gz.length;
    tris += (t.ground.idx.length + t.mark.idx.length + t.struct.idx.length + t.bldg.idx.length) / 3;
  }
}
const worldText = JSON.stringify(worldJson);
writeFileSync(resolve(outDir, 'world.json'), worldText);
lap(
  `wrote ${worldJson.tiles.length} tiles (${(bytes / 1048576).toFixed(1)} MB gzipped, ${Math.round(tris / 1000)}k triangles) and world.json (${(worldText.length / 1048576).toFixed(1)} MB)`,
);

if (DEBUG) {
  const out = resolve(root, 'data/work/debug');
  mkdirSync(out, { recursive: true });
  const colors = ['#d33', '#e77', '#d60', '#e94', '#c50', '#da6', '#e8a400', '#f0c060', '#333', '#666', '#777', '#888', '#59c', '#bbb', '#b96'];
  const whole = new DebugSvg(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ, 0.25);
  for (const e of graph.edges) whole.line(e.p, 3, colors[e.c], Math.max(e.w, 6));
  whole.save(resolve(out, 'graph-all.svg'));

  const views: Array<[string, number, number, number, number]> = [
    ['centre', 150, -800, 850, -300],
    ['west', -3100, -400, -2500, 50],
    ['a49', 900, 2500, 1900, 3200],
  ];
  const roleColor = ['#1a9a1a', '#e0b000', '#d01010', '#2060e0', '#909090', '#00000000'];
  const sample = newPolySample();
  for (const [name, x0, z0, x1, z1] of views) {
    const svg = new DebugSvg(x0, z0, x1, z1, 2.4);
    for (const e of world.edges) {
      if (e.maxX < x0 || e.minX > x1 || e.maxZ < z0 || e.minZ > z1) continue;
      const s0 = e.cutA;
      const s1 = e.len - e.cutB;
      if (s1 - s0 < 0.05) continue;
      const mid = slicePolyline(e.pl, s0, s1);
      const L = offsetPolyline(mid, e.width / 2);
      const R = offsetPolyline(mid, -e.width / 2);
      const ring: number[] = [];
      for (let i = 0; i < L.length; i += 3) ring.push(L[i], L[i + 2]);
      for (let i = R.length - 3; i >= 0; i -= 3) ring.push(R[i], R[i + 2]);
      svg.polygon(ring, e.surf === 0 ? '#5d5f63' : e.surf <= 3 ? '#8a8378' : '#a89a78', 1);
      for (const [sw, sign] of [[e.swL, 1], [e.swR, -1]] as Array<[number, number]>) {
        if (sw <= 0) continue;
        const a = offsetPolyline(mid, sign * e.width / 2);
        const b = offsetPolyline(mid, sign * (e.width / 2 + sw));
        const r2: number[] = [];
        for (let i = 0; i < a.length; i += 3) r2.push(a[i], a[i + 2]);
        for (let i = b.length - 3; i >= 0; i -= 3) r2.push(b[i], b[i + 2]);
        svg.polygon(r2, '#c9c2b4', 1);
      }
      if (e.lanesF > 0 && e.lanesB > 0 && (e.flags & 64)) svg.line(mid, 3, '#fff', 0.15, 1, '7 14');
    }
    for (const n of world.nodes) {
      if (!svg.inView(n.x, n.z, 40)) continue;
      if (n.shape) {
        svg.polygon(n.shape.ring, n.ctrl === CTRL.SIGNALS ? '#4c4f66' : n.ctrl === CTRL.RBL ? '#4f5f6f' : '#55575b', 1, '#222', 0.05);
        for (const c of n.shape.corners) {
          const k3: number[] = [];
          for (let i = 0; i < c.kerb.length; i += 2) k3.push(c.kerb[i], c.kerb[i + 1]);
          svg.line(k3, 2, c.swA > 0 || c.swB > 0 ? '#eee' : '#999', 0.18);
        }
      }
      for (const arm of n.arms) {
        if (!arm.isApproach || n.arms.length < 3) continue;
        samplePolyline(arm.edge.pl, arm.out ? arm.stopS : arm.edge.len - arm.stopS, sample);
        svg.circle(sample.x, sample.z, 1.3, arm.sg >= 0 ? '#ff40ff' : roleColor[arm.role]);
      }
    }
    for (const c of world.crossings) {
      const e = world.edges[c.e];
      samplePolyline(e.pl, c.s, sample);
      svg.circle(sample.x, sample.z, 2.2, c.k === XING.ZEBRA ? '#ffffff' : c.k === XING.SIGNAL ? '#ff80ff' : c.k >= XING.RAIL ? '#000' : '#80e0ff', 0.8);
    }
    svg.save(resolve(out, `detail-${name}.svg`), '#7d9a4e');
  }
  lap('debug SVGs written');
}
