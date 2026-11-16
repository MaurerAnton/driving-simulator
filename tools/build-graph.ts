// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Map pipeline, step 2 of 3: the road network of the whole region.
 *
 *   node --max-old-space-size=6144 tools/build-graph.ts
 *
 * Inputs (see docs/MAP_DATA.md):
 *   data/work/osm/roads.json.gz, built.bin   (tools/osm-extract.ts)
 *   data/work/dgm2/*.dgm                     (tools/fetch-geodata.py)
 *
 * From OpenStreetMap's roads and the terrain it makes the network the game
 * drives on – junctions, roads with their heights, right of way, signals,
 * crossings, railway tracks – and writes it in the pieces it is used in:
 *
 *   public/map/w/<cx>_<cz>.json.gz   the network in chunks of 4 km, as the game loads it
 *   public/map/net.bin.gz            every road in a few numbers: for planning routes
 *                                    and drawing the map of the whole region
 *   public/map/rails.json.gz         the tracks trams and trains run on
 *   data/work/graph/b_<bx>_<bz>.json.gz   the network of each block of 8 km with what the
 *                                    tile build (tools/build-tiles.ts) needs besides
 *   data/work/graph/plan.json        the blocks, the places, the start points
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { makePolyline, pointInRing } from '../src/core/geom.ts';
import { WORLD_ORIGIN_E, WORLD_ORIGIN_N } from '../src/geo/utm.ts';
import { GridSet } from '../src/world/grid.ts';
import { LaneGraph, TURN } from '../src/world/lanes.ts';
import { POLY_UNIT, packNet } from '../src/world/netfile.ts';
import { RG } from '../src/world/routegraph.ts';
import { ACCESS, CLASS_TIER, CLS, CTRL, EF, ROLE } from '../src/world/types.ts';
import type { EdgeJson, PlaceJson, SpawnJson, WorldChunkJson, WorldJson } from '../src/world/types.ts';
import { World, computeAllCuts, newSurfaceHit, packEdgePoints } from '../src/world/world.ts';
import { deriveControl } from './mapgen/control.ts';
import { Dgm } from './mapgen/dgm.ts';
import { solveElevation } from './mapgen/elevation.ts';
import { collectPlaces, collectSpawns } from './mapgen/objects.ts';
import { OsmData } from './mapgen/osm.ts';
import { collectRails } from './mapgen/rails.ts';
import { buildRoadGraph, roadStats } from './mapgen/roads.ts';
import { BLOCK, CHUNK, Coverage, HALO, TILE, gridIndex, gridRect, grow } from './mapgen/store.ts';
import type { Rect } from './mapgen/store.ts';
import { GraphStore } from './mapgen/subworld.ts';
import { groundAt } from './mapgen/terrain.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, process.env.MAP_OUT ?? 'public/map');
const workDir = resolve(root, 'data/work/graph');
const t0 = Date.now();
// (with what is in memory after tidying up, if node was started with --expose-gc: the network of the
// whole region is held at once, and that is what limits how large a region can be built on a machine)
const tidy = (globalThis as { gc?: () => void }).gc;
const lap = (msg: string): void => {
  tidy?.();
  const held = tidy ? ` ${(process.memoryUsage().heapUsed / 1048576).toFixed(0).padStart(5)} MB` : '';
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s${held}] ${msg}`);
};
const gz = (v: unknown): Buffer => gzipSync(JSON.stringify(v), { level: 9 });

const coverage = new Coverage(root, true);
const osm = OsmData.load(resolve(root, 'data/work/osm/roads.json.gz'));
lap(`roads of the region: ${osm.nodes.size} nodes, ${osm.ways.length} ways, ${osm.relations.length} relations; terrain for ${coverage.count} km²`);

// ---- where the region is built up (a grid of 10 m, from the extract) ----
const builtFile = readFileSync(resolve(root, 'data/work/osm/built.bin'));
const built = {
  minX: builtFile.readInt32LE(4),
  minZ: builtFile.readInt32LE(8),
  w: builtFile.readInt32LE(12),
  h: builtFile.readInt32LE(16),
  cell: builtFile.readInt32LE(20),
  bits: builtFile.subarray(32),
};
const builtUp = (x: number, z: number): boolean => {
  const i = Math.floor((x - built.minX) / built.cell);
  const j = Math.floor((z - built.minZ) / built.cell);
  if (i < 0 || j < 0 || i >= built.w || j >= built.h) return false;
  const k = j * built.w + i;
  return (built.bits[k >> 3] & (1 << (k & 7))) !== 0;
};
const inWorld = (x: number, z: number): boolean => coverage.covered(x, z);

// ---- the network ----
const dgm = new Dgm(resolve(root, 'data/work/dgm2'), 500);
const graph = buildRoadGraph(osm, { inWorld, builtUp });
lap(`road graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges — km: ${roadStats(graph)}`);
const elev = solveElevation(graph, dgm);
lap(`elevation solved: max grade ${(elev.maxGrade * 100).toFixed(1)} %, ${elev.steepEdges} edges > 20 %, ${elev.lowClearances} low bridge clearances (${elev.fixedClearances} decks raised)`);
const control = deriveControl(graph, osm);
lap(`right-of-way: ${Object.entries(control.report).map(([k, v]) => `${v} ${k}`).join(', ')}`);

const bbox = coverage.bbox;
const worldJson: WorldJson = {
  version: 2,
  meta: {
    name: 'Nordhessen',
    generated: new Date().toISOString(),
    minX: bbox.minX,
    maxX: bbox.maxX,
    minZ: bbox.minZ,
    maxZ: bbox.maxZ,
    tileSize: TILE,
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
const store = new GraphStore(worldJson);
const ground = groundAt(dgm, world, 5);

// ---- places and municipalities ----
const places: PlaceJson[] = collectPlaces(osm, inWorld);
interface Municipality {
  name: string;
  /** the second line of the place-name signs: the district */
  sign: string;
  /** are its building models there (data/work/lod2)? */
  lod2: boolean;
  rings: number[][];
  box: Rect;
}
// (the land survey writes "Rotenburg a. d. Fulda", OpenStreetMap "Rotenburg an der Fulda": the little words do not count)
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w !== '' && !['a', 'am', 'an', 'd', 'der', 'i', 'im', 'in', 'v', 'vor', 'b', 'bei'].includes(w))
    .join('');
const lod2Dir = resolve(root, 'data/work/lod2');
const lod2Names = new Set((existsSync(lod2Dir) ? readdirSync(lod2Dir) : []).filter((d) => !d.startsWith('.')).map(norm));
const boxOf = (rings: number[][]): Rect => {
  const r: Rect = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      r.minX = Math.min(r.minX, ring[i]);
      r.maxX = Math.max(r.maxX, ring[i]);
      r.minZ = Math.min(r.minZ, ring[i + 1]);
      r.maxZ = Math.max(r.maxZ, ring[i + 1]);
    }
  }
  return r;
};
const inRings = (rings: number[][], x: number, z: number): boolean => {
  let inside = false;
  for (const ring of rings) if (pointInRing(x, z, ring)) inside = !inside;
  return inside;
};
const districts: Array<{ name: string; rings: number[][]; box: Rect }> = [];
const municipalities: Municipality[] = [];
for (const rel of osm.relations) {
  if (rel.tags.boundary !== 'administrative' || !rel.tags.name) continue;
  const level = rel.tags.admin_level;
  if (level !== '6' && level !== '8') continue;
  const rings = osm.multipolygonRings(rel).outer;
  if (rings.length === 0) continue;
  const isDistrict = level === '6' && /kreis/i.test(rel.tags.name);
  if (isDistrict) districts.push({ name: rel.tags.name, rings, box: boxOf(rings) });
  else municipalities.push({ name: rel.tags.name, sign: level === '6' ? (rel.tags.name === 'Kassel' ? 'documenta-Stadt' : '') : '', lod2: lod2Names.has(norm(rel.tags.name)), rings, box: boxOf(rings) });
}
for (const m of municipalities) {
  if (m.sign) continue;
  // the district it lies in, as the signs name it
  const x = m.rings[0][0];
  const z = m.rings[0][1];
  const d = districts.find((k) => x >= k.box.minX - 50 && x <= k.box.maxX + 50 && z >= k.box.minZ - 50 && z <= k.box.maxZ + 50 && (inRings(k.rings, x, z) || inRings(k.rings, (m.box.minX + m.box.maxX) / 2, (m.box.minZ + m.box.maxZ) / 2)));
  m.sign = d ? d.name.replace(/^Landkreis /, 'Kreis ') : '';
}
const unmatched = [...lod2Names].filter((n) => !municipalities.some((m) => norm(m.name) === n));
lap(`${places.length} places, ${municipalities.length} municipalities (${municipalities.filter((m) => m.lod2).length} with building models${unmatched.length ? `; no boundary found for: ${unmatched.join(', ')}` : ''})`);

// ---- tracks for trams and trains ----
const railNet = collectRails(osm, world, ground, inWorld);
lap(`tracks: ${railNet.rails.length} pieces – ${railNet.km[0].toFixed(1)} km tram, ${railNet.km[1].toFixed(1)} km light rail, ${railNet.km[2].toFixed(1)} km railway, ${railNet.stops} stops`);

// ---- every road in a few numbers: ways and the turns between them ----
// (The turns come from the lane network, which is made block by block: for the whole region at
// once it would not fit into memory – and a junction's paths depend on its own roads only.)
const E = worldJson.edges.length;
const N = worldJson.nodes.length;
const edgeLen = new Float32Array(E);
const edgeCls = new Uint8Array(E);
const wayKind = new Uint8Array(E * 2);
const waySpeed = new Uint8Array(E * 2);
worldJson.edges.forEach((e, i) => {
  edgeLen[i] = makePolyline(e.p).len;
  edgeCls[i] = e.c;
  let kind = 0;
  if (e.ac === ACCESS.PRIVATE || e.ac === ACCESS.AGRICULTURAL) kind |= RG.NO_ENTRY;
  if (e.ac === ACCESS.DESTINATION || (e.f & EF.MINOR_SERVICE) !== 0) kind |= RG.ACCESS_ONLY;
  if (CLASS_TIER[e.c] < 2) kind |= RG.MINOR;
  if (e.lw < 2.4) kind |= RG.NARROW;
  if (e.f & EF.URBAN) kind |= RG.URBAN;
  if (e.f & EF.ROUNDABOUT) kind |= RG.ROUNDABOUT;
  wayKind[i * 2] = kind | (worldJson.nodes[e.b].t === CTRL.MAP_END ? RG.TO_MAP_END : 0);
  wayKind[i * 2 + 1] = kind | (worldJson.nodes[e.a].t === CTRL.MAP_END ? RG.TO_MAP_END : 0);
  // (0: not to be driven this way; no limit counts as 130)
  waySpeed[i * 2] = e.lf > 0 ? Math.min(250, e.mf > 0 ? e.mf : 130) : 0;
  waySpeed[i * 2 + 1] = e.lb > 0 ? Math.min(250, e.mb > 0 ? e.mb : 130) : 0;
});
const turnsOf: Array<Array<[number, number, number]> | undefined> = new Array(E * 2);
const blocks = coverage.squares(BLOCK);
let lanesMade = 0;
let pathsMade = 0;
for (const [bx, bz] of blocks) {
  const own = store.nodesIn(gridRect(bx, bz, BLOCK));
  if (own.length === 0) continue;
  const sub = store.sub(store.edgesAt(own));
  const w = new World(sub.json);
  const lanes = new LaneGraph(w);
  lanesMade += lanes.lanes.length;
  for (const gid of own) {
    const node = w.nodes[sub.nodeAt.get(gid) as number];
    for (const c of lanes.pathsThrough(node)) {
      pathsMade++;
      const from = sub.edges[c.from.edge.id] * 2 + (c.from.dir > 0 ? 0 : 1);
      const to = sub.edges[c.to.edge.id] * 2 + (c.to.dir > 0 ? 0 : 1);
      const list = (turnsOf[from] ??= []);
      const have = list.find((t) => t[0] === to);
      if (!have) list.push([to, c.turn, c.len]);
      else if (c.turn === TURN.STRAIGHT && have[1] !== TURN.STRAIGHT) have[1] = c.turn;
    }
  }
}
const first = new Uint32Array(E * 2 + 1);
const toList: number[] = [];
const turnList: number[] = [];
const acrossList: number[] = [];
for (let w = 0; w < E * 2; w++) {
  first[w] = toList.length;
  for (const [to, turn, len] of turnsOf[w] ?? []) {
    toList.push(to);
    turnList.push(turn);
    acrossList.push(Math.min(65535, Math.round(len * 10)));
  }
}
first[E * 2] = toList.length;
lap(`lane network, block by block: ${lanesMade} lanes, ${pathsMade} paths through junctions, ${toList.length} turns between ways`);

// the course of each road in a few points (for the map of the whole region): what a line with 1.5 m of tolerance keeps
const polyFirst = new Uint32Array(E + 1);
const poly: number[] = [];
const keep = (p: number[], i0: number, i1: number, out: number[]): void => {
  let worst = -1;
  let wd = 1.5 * 1.5;
  const ax = p[i0 * 3];
  const az = p[i0 * 3 + 2];
  const dx = p[i1 * 3] - ax;
  const dz = p[i1 * 3 + 2] - az;
  const l2 = dx * dx + dz * dz;
  for (let i = i0 + 1; i < i1; i++) {
    let t = l2 > 1e-9 ? ((p[i * 3] - ax) * dx + (p[i * 3 + 2] - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = p[i * 3] - (ax + dx * t);
    const ez = p[i * 3 + 2] - (az + dz * t);
    const d = ex * ex + ez * ez;
    if (d > wd) {
      wd = d;
      worst = i;
    }
  }
  if (worst < 0) return;
  keep(p, i0, worst, out);
  out.push(worst);
  keep(p, worst, i1, out);
};
worldJson.edges.forEach((e, i) => {
  polyFirst[i] = poly.length / 2;
  const kept: number[] = [];
  keep(e.p, 0, e.p.length / 3 - 1, kept);
  let x = worldJson.nodes[e.a].x;
  let z = worldJson.nodes[e.a].z;
  for (const k of kept) {
    // (steps of a quarter metre; a step too long for 16 bits is taken in several)
    let sx = Math.round((e.p[k * 3] - x) / POLY_UNIT);
    let sz = Math.round((e.p[k * 3 + 2] - z) / POLY_UNIT);
    const parts = Math.max(1, Math.ceil(Math.max(Math.abs(sx), Math.abs(sz)) / 32000));
    for (let part = parts; part >= 1; part--) {
      const px = Math.round(sx / part);
      const pz = Math.round(sz / part);
      poly.push(px, pz);
      sx -= px;
      sz -= pz;
      x += px * POLY_UNIT;
      z += pz * POLY_UNIT;
    }
  }
});
polyFirst[E] = poly.length / 2;
const net = packNet({
  nodeX: Float32Array.from(worldJson.nodes, (n) => n.x),
  nodeZ: Float32Array.from(worldJson.nodes, (n) => n.z),
  edgeA: Uint32Array.from(worldJson.edges, (e) => e.a),
  edgeB: Uint32Array.from(worldJson.edges, (e) => e.b),
  edgeLen,
  edgeCls,
  wayKind,
  waySpeed,
  first,
  to: Uint32Array.from(toList),
  turn: Uint8Array.from(turnList),
  across: Uint16Array.from(acrossList),
  polyFirst,
  poly: Int16Array.from(poly),
});

// ---- which roads are part of the network one can drive around in: from them one gets everywhere and back ----
const reach = (forward: boolean, seed: number): Uint8Array => {
  const seen = new Uint8Array(E * 2);
  const stack = [seed];
  seen[seed] = 1;
  if (forward) {
    while (stack.length) {
      const w = stack.pop() as number;
      for (let k = first[w]; k < first[w + 1]; k++) {
        const v = toList[k];
        if (!seen[v] && (wayKind[v] & RG.NO_ENTRY) === 0) {
          seen[v] = 1;
          stack.push(v);
        }
      }
    }
  } else {
    // (the turns the other way round)
    const into: number[][] = new Array(E * 2);
    for (let w = 0; w < E * 2; w++) for (let k = first[w]; k < first[w + 1]; k++) (into[toList[k]] ??= []).push(w);
    while (stack.length) {
      const w = stack.pop() as number;
      for (const v of into[w] ?? []) {
        if (!seen[v] && (wayKind[v] & RG.NO_ENTRY) === 0) {
          seen[v] = 1;
          stack.push(v);
        }
      }
    }
  }
  return seen;
};
// (seeded with the longest road of the higher classes that can be driven both ways)
let seed = -1;
for (let e = 0; e < E; e++) {
  if (edgeCls[e] < CLS.PRIMARY || edgeCls[e] > CLS.TERTIARY || waySpeed[e * 2] === 0 || waySpeed[e * 2 + 1] === 0) continue;
  if (seed < 0 || edgeLen[e] > edgeLen[seed >> 1]) seed = e * 2;
}
const there = seed >= 0 ? reach(true, seed) : new Uint8Array(E * 2);
const back = seed >= 0 ? reach(false, seed) : new Uint8Array(E * 2);
const inNet = (e: number): boolean => (there[e * 2] && back[e * 2]) === 1 || (there[e * 2 + 1] && back[e * 2 + 1]) === 1;
let netKm = 0;
for (let e = 0; e < E; e++) if (inNet(e)) netKm += edgeLen[e] / 1000;
lap(`${netKm.toFixed(0)} km of road can be reached from each other`);

// ---- start points: a public car park per town, village and district – on the network ----
const hit = newSurfaceHit();
const spawns: SpawnJson[] = collectSpawns(osm, world, ground, places, inWorld).filter((s) => {
  const y = ground.at(s.x, s.z);
  return world.locate(s.x, s.z, Number.isNaN(y) ? 0 : y, 30, hit) && hit.edge !== null && inNet(hit.edge.id);
});
// which town or municipality each lies in: the list of start points is grouped by it
for (const s of spawns) {
  const m = municipalities.find((k) => s.x >= k.box.minX && s.x <= k.box.maxX && s.z >= k.box.minZ && s.z <= k.box.maxZ && inRings(k.rings, s.x, s.z));
  if (m) s.g = m.name;
}
// the town the simulator began in comes first, the others by municipality and name
const home = spawns.findIndex((s) => s.name.startsWith('Baunatal'));
const firstSpawn = home >= 0 ? spawns.splice(home, 1) : [];
const homeTown = firstSpawn[0]?.g ?? '';
spawns.sort((a, b) => Number(b.g === homeTown) - Number(a.g === homeTown) || (a.g ?? '').localeCompare(b.g ?? '', 'de') || a.name.localeCompare(b.name, 'de'));
spawns.unshift(...firstSpawn);
lap(`${spawns.length} start points`);

// ---- writing: the game's files ----
rmSync(resolve(outDir, 'w'), { recursive: true, force: true });
mkdirSync(resolve(outDir, 'w'), { recursive: true });
const chunkNodes = new Map<string, number[]>();
worldJson.nodes.forEach((n, i) => {
  const key = `${gridIndex(n.x, CHUNK)}_${gridIndex(n.z, CHUNK)}`;
  const list = chunkNodes.get(key);
  if (list) list.push(i);
  else chunkNodes.set(key, [i]);
});
let chunkBytes = 0;
const chunkList: Array<[number, number]> = [];
for (const [key, own] of chunkNodes) {
  const edges = store.edgesAt(own);
  const sc = new Set<number>();
  const chunk: WorldChunkJson = { v: 1, nodes: [], edges: [], signals: [] };
  for (const n of own) {
    const node = worldJson.nodes[n];
    if (node.sc !== undefined && node.sc >= 0) sc.add(node.sc);
    chunk.nodes.push([n, node]);
  }
  for (const e of edges) {
    // (the course of the road as steps in whole centimetres: half the size of the metres with their decimals)
    const edge: EdgeJson = { ...worldJson.edges[e], p: [], q: packEdgePoints(worldJson.edges[e].p) };
    const xs = store.crossingsOf.get(e);
    if (xs) {
      edge.x = xs.map(({ e: _e, ...rest }) => rest);
      for (const c of xs) if (c.sc !== undefined && c.sc >= 0) sc.add(c.sc);
    }
    const bn = store.bannedFrom.get(e);
    if (bn) edge.bn = bn;
    chunk.edges.push([e, edge]);
  }
  for (const id of [...sc].sort((a, b) => a - b)) chunk.signals.push([id, worldJson.signals[id]]);
  const bytes = gz(chunk);
  writeFileSync(resolve(outDir, 'w', `${key}.json.gz`), bytes);
  chunkBytes += bytes.length;
  const [cx, cz] = key.split('_').map(Number);
  chunkList.push([cx, cz]);
}
const netBytes = gzipSync(net, { level: 9 });
writeFileSync(resolve(outDir, 'net.bin.gz'), netBytes);
const railBytes = gz({ v: 1, rails: railNet.rails });
writeFileSync(resolve(outDir, 'rails.json.gz'), railBytes);
lap(`wrote ${chunkList.length} chunks of the network (${(chunkBytes / 1048576).toFixed(1)} MB), net.bin.gz (${(netBytes.length / 1048576).toFixed(1)} MB), rails.json.gz (${(railBytes.length / 1048576).toFixed(1)} MB)`);

// ---- writing: what the tile build needs, block by block ----
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
const yardBlock = spawns.length ? `${gridIndex(spawns[0].x, BLOCK)}_${gridIndex(spawns[0].z, BLOCK)}` : '';
let blockBytes = 0;
for (const [bx, bz] of blocks) {
  const window = grow(gridRect(bx, bz, BLOCK), HALO);
  const sub = store.sub(store.edgesIn(window, 40));
  const far = grow(window, 5000);
  const file = {
    block: [bx, bz],
    world: { ...sub.json, places: places.filter((p) => p.x > far.minX && p.x < far.maxX && p.z > far.minZ && p.z < far.maxZ) },
    nodes: sub.nodes,
    edges: sub.edges,
    nodeOsm: sub.nodes.map((n) => {
      const o = graph.nodeOsm[n];
      return o ? { id: o.id, x: o.x, z: o.z, tags: o.tags } : null;
    }),
    edgeFeatures: sub.edges.map((e) => graph.edgeFeatures[e]),
    municipalities: municipalities
      .filter((m) => m.box.maxX > window.minX && m.box.minX < window.maxX && m.box.maxZ > window.minZ && m.box.minZ < window.maxZ)
      .map((m) => ({ name: m.name, sign: m.sign, lod2: m.lod2, rings: m.rings.map((r) => r.map((v) => Math.round(v * 10) / 10)) })),
    yardNear: `${bx}_${bz}` === yardBlock ? { x: spawns[0].x, z: spawns[0].z } : null,
  };
  const bytes = gz(file);
  writeFileSync(resolve(workDir, `b_${bx}_${bz}.json.gz`), bytes);
  blockBytes += bytes.length;
}
writeFileSync(
  resolve(workDir, 'plan.json'),
  JSON.stringify({
    meta: worldJson.meta,
    nodes: N,
    edges: E,
    blocks,
    chunks: GridSet.of(chunkList).toJSON(),
    places,
    spawns,
  }),
);
lap(`wrote ${blocks.length} blocks for the tile build (${(blockBytes / 1048576).toFixed(1)} MB) and the plan`);
// (how much memory this took at most: the network of the whole region is in it at once)
lap(`memory: ${(process.resourceUsage().maxRSS / 1048576).toFixed(2)} GB at most`);
