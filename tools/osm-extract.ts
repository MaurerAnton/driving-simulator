// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cut the region of the map out of a Geofabrik .osm.pbf extract – in pieces,
 * so that any part of it can be built without the rest.
 *
 *   node --max-old-space-size=6144 tools/osm-extract.ts [path/to/hessen-latest.osm.pbf]
 *
 * The region is what the terrain model was fetched for (tools/fetch-geodata.py).
 *
 * Output (data/work/osm):
 *   b_<bx>_<bz>.json.gz   everything in one block of 8 km and a ring of 560 m around it
 *   roads.json.gz         the roads, tracks and railways of the whole region, with what
 *                         belongs to them: tagged nodes on them, turn restrictions, the
 *                         boundaries of the municipalities, the names of places
 *   built.bin             where the region is built up, on a grid of 10 m
 *
 * The files have the shape tools/mapgen/osm.ts reads: nodes [id, x, z, tags?]
 * in world coordinates, ways { id, refs, tags }, relations { id, members, tags }.
 *
 * Kept per block:
 *   - every way with at least one node inside the block's rectangle
 *   - every tagged node inside it
 *   - multipolygons, municipal boundaries and turn restrictions that touch
 *     it; multipolygons and boundaries are completed (all member ways and
 *     their nodes), so that area fills stay correct even when a forest spans 20 km
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { pointInRing } from '../src/core/geom.ts';
import { latLonToWorld, worldToLatLon } from '../src/geo/utm.ts';
import { BLOCK, Coverage, HALO, gridIndex, gridRect, grow } from './mapgen/store.ts';
import type { Rect } from './mapgen/store.ts';
import { readPbf } from './osm/pbf.ts';
import type { OsmMember, Tags } from './osm/pbf.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = resolve(root, process.argv[2] ?? 'data/raw/osm/hessen-latest.osm.pbf');
const outDir = resolve(root, 'data/work/osm');

if (!existsSync(input)) {
  console.error(`Missing ${input}\nDownload it first:\n  curl -L -o data/raw/osm/hessen-latest.osm.pbf https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf`);
  process.exit(1);
}
const coverage = new Coverage(root);
if (coverage.count === 0) {
  console.error('No terrain in data/work/dgm2 – fetch it first (tools/fetch-geodata.py): the map is built where there is terrain.');
  process.exit(1);
}

const t0 = Date.now();
const elapsed = (): string => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

/** what a block's extract holds beyond the block: the ring its build looks at, and a little */
const PAD = HALO + 60;
const blocks = coverage.squares(BLOCK);
const blockIndex = new Map<number, number>();
blocks.forEach(([bx, bz], i) => blockIndex.set(bx * 4096 + bz, i));
const region = grow(coverage.bbox, 2500);
console.log(`[extract] region: ${coverage.count} km² of terrain in ${blocks.length} blocks of ${BLOCK / 1000} km`);

/** The blocks whose rectangle (with its ring) holds a point: indices into `blocks`. */
function blocksAt(x: number, z: number, out: number[]): number[] {
  out.length = 0;
  const x0 = gridIndex(x - PAD, BLOCK);
  const x1 = gridIndex(x + PAD, BLOCK);
  const z0 = gridIndex(z - PAD, BLOCK);
  const z1 = gridIndex(z + PAD, BLOCK);
  for (let bx = x0; bx <= x1; bx++) {
    for (let bz = z0; bz <= z1; bz++) {
      const i = blockIndex.get(bx * 4096 + bz);
      if (i !== undefined) out.push(i);
    }
  }
  return out;
}

// lat/lon box around the region
const corners = [
  worldToLatLon(region.minX, region.minZ),
  worldToLatLon(region.maxX, region.minZ),
  worldToLatLon(region.minX, region.maxZ),
  worldToLatLon(region.maxX, region.maxZ),
];
const box = {
  minLat: Math.min(...corners.map((c) => c[0])),
  maxLat: Math.max(...corners.map((c) => c[0])),
  minLon: Math.min(...corners.map((c) => c[1])),
  maxLon: Math.max(...corners.map((c) => c[1])),
};

// ---- the nodes of the region: ids in ascending order, positions in world metres ----
let cap = 1 << 23;
let nodeIds = new Float64Array(cap);
let nodeX = new Float32Array(cap);
let nodeZ = new Float32Array(cap);
let nodeN = 0;
let sorted = true;
const nodeTags = new Map<number, Tags>();
/** tags nobody draws or drives by: not worth the memory */
const DULL = new Set(['created_by', 'fixme', 'FIXME', 'wikidata', 'wikipedia', 'website', 'phone', 'email', 'fax', 'opening_hours', 'image', 'mapillary', 'url', 'description', 'old_name', 'alt_name', 'start_date', 'ele', 'smoking', 'cuisine', 'wheelchair', 'internet_access', 'survey:date']);
const DULL_PREFIX = /^(source|note|check_date|contact|name|is_in|payment|diet|toilets|brand|ref|tiger|gnis|operator|opening_hours|wikipedia|website|internet_access|seamark|communication|fuel|socket|recycling|species|genus|taxon|heritage|lda|denkmal):/;
function slim(tags: Tags): Tags {
  const out: Tags = {};
  for (const k in tags) if (!DULL.has(k) && !DULL_PREFIX.test(k) && k !== 'source' && k !== 'note' && k !== 'addr:country') out[k] = tags[k];
  return out;
}

function nodeAt(id: number): number {
  let lo = 0;
  let hi = nodeN - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = nodeIds[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

interface WayRec {
  id: number;
  refs: number[];
  tags: Tags;
}
const ways: WayRec[] = [];
const wayIndex = new Map<number, number>();
/** per block: indices into `ways` */
const blockWays: number[][] = blocks.map(() => []);
interface RelRec {
  id: number;
  members: OsmMember[];
  tags: Tags;
  blocks: Set<number>;
}
const relations: RelRec[] = [];
const wantWays = new Set<number>();

console.log(`[extract] pass 1/3: scanning ${(statSync(input).size / 1048576).toFixed(0)} MB …`);
const hit: number[] = [];
const touched = new Set<number>();
let nodeCount = 0;
let wayCount = 0;
let waysSorted = false;
readPbf(input, {
  node(id, lat, lon, tags) {
    nodeCount++;
    if (lat < box.minLat || lat > box.maxLat || lon < box.minLon || lon > box.maxLon) return;
    if (nodeN === cap) {
      cap *= 2;
      const ids = new Float64Array(cap);
      ids.set(nodeIds);
      nodeIds = ids;
      const xs = new Float32Array(cap);
      xs.set(nodeX);
      nodeX = xs;
      const zs = new Float32Array(cap);
      zs.set(nodeZ);
      nodeZ = zs;
    }
    if (nodeN > 0 && id < nodeIds[nodeN - 1]) sorted = false;
    const [x, z] = latLonToWorld(lat, lon);
    nodeIds[nodeN] = id;
    nodeX[nodeN] = x;
    nodeZ[nodeN] = z;
    nodeN++;
    const t = tags();
    if (t) {
      const s = slim(t);
      for (const _ in s) {
        nodeTags.set(id, s);
        break;
      }
    }
  },
  way(id, refs, tags) {
    wayCount++;
    if (!waysSorted) {
      waysSorted = true;
      if (!sorted) {
        // (the nodes of a planet extract come in ascending order; if not, put them in order once)
        const order = Array.from({ length: nodeN }, (_, i) => i).sort((a, b) => nodeIds[a] - nodeIds[b]);
        nodeIds = Float64Array.from(order, (i) => nodeIds[i]);
        nodeX = Float32Array.from(order, (i) => nodeX[i]);
        nodeZ = Float32Array.from(order, (i) => nodeZ[i]);
      }
      console.log(`\n[extract]   ${nodeN} of ${nodeCount} nodes lie in the region (${nodeTags.size} of them tagged)  ${elapsed()}`);
    }
    touched.clear();
    for (let i = 0; i < refs.length; i++) {
      const n = nodeAt(refs[i]);
      if (n < 0) continue;
      for (const b of blocksAt(nodeX[n], nodeZ[n], hit)) touched.add(b);
    }
    if (touched.size === 0) return;
    const w = ways.length;
    ways.push({ id, refs, tags: slim(tags()) });
    wayIndex.set(id, w);
    for (const b of touched) blockWays[b].push(w);
  },
  relation(id, getMembers, getTags) {
    const tags = getTags();
    const type = tags.type;
    const boundary = type === 'boundary' && tags.boundary === 'administrative' && (tags.admin_level === '8' || tags.admin_level === '6');
    if (type !== 'multipolygon' && type !== 'restriction' && !boundary) return;
    const members = getMembers();
    const inBlocks = new Set<number>();
    for (const m of members) {
      if (m.type === 'w') {
        const w = wayIndex.get(m.ref);
        if (w === undefined) continue;
        // (the blocks of a kept way: those its nodes lie in)
        for (const r of ways[w].refs) {
          const n = nodeAt(r);
          if (n >= 0) for (const b of blocksAt(nodeX[n], nodeZ[n], hit)) inBlocks.add(b);
        }
      } else if (m.type === 'n' && type === 'restriction') {
        const n = nodeAt(m.ref);
        if (n >= 0) for (const b of blocksAt(nodeX[n], nodeZ[n], hit)) inBlocks.add(b);
      }
    }
    if (inBlocks.size === 0) return;
    if (type !== 'restriction') for (const m of members) if (m.type === 'w' && !wayIndex.has(m.ref)) wantWays.add(m.ref);
    relations.push({ id, members, tags: slim(tags), blocks: inBlocks });
  },
  progress(done, total) {
    process.stdout.write(`\r[extract]   ${((done / total) * 100).toFixed(0)}%  ${elapsed()}   `);
  },
});
console.log(`\n[extract] scanned ${nodeCount} nodes, ${wayCount} ways: kept ${ways.length} ways, ${relations.length} relations; completing ${wantWays.size} outlying member ways  ${elapsed()}`);

// Ways that begin inside the region may end far outside it (a river bank, a forest edge, a long
// road), and so may the outlines of areas.  Their outer nodes are needed too: an area whose
// outline has gaps cannot be drawn – the remaining corners would be joined across the map.
const extraWays = new Map<number, WayRec>();
const extraNodes = new Map<number, [number, number]>();
const wantNodes = new Set<number>();
if (wantWays.size > 0) {
  console.log('[extract] pass 2/3: outlying multipolygon ways …');
  readPbf(input, {
    way(id, refs, tags) {
      if (!wantWays.has(id)) return;
      extraWays.set(id, { id, refs, tags: slim(tags()) });
      for (const r of refs) if (nodeAt(r) < 0) wantNodes.add(r);
    },
  });
  console.log(`[extract]   done ${elapsed()}; need ${wantNodes.size} more nodes`);
}
if (wantNodes.size > 0) {
  console.log('[extract] pass 3/3: outlying nodes …');
  readPbf(input, {
    node(id, lat, lon) {
      if (wantNodes.has(id)) extraNodes.set(id, latLonToWorld(lat, lon));
    },
  });
  console.log(`[extract]   done ${elapsed()}`);
}

// ---- writing ----
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const r2 = (v: number): number => Math.round(v * 100) / 100;
const extractedAt = new Date().toISOString();

/** tagged nodes by block */
const blockNodes: number[][] = blocks.map(() => []);
for (const id of nodeTags.keys()) {
  const n = nodeAt(id);
  if (n < 0) continue;
  for (const b of blocksAt(nodeX[n], nodeZ[n], hit)) blockNodes[b].push(id);
}

function nodeLine(id: number, withTags: boolean): string | null {
  const n = nodeAt(id);
  const tags = withTags ? nodeTags.get(id) : undefined;
  if (n >= 0) return tags ? JSON.stringify([id, r2(nodeX[n]), r2(nodeZ[n]), tags]) : `[${id},${r2(nodeX[n])},${r2(nodeZ[n])}]`;
  const e = extraNodes.get(id);
  return e ? `[${id},${r2(e[0])},${r2(e[1])}]` : null;
}

/** Write one extract: these ways (indices), relations and tagged nodes, with every node they refer to. */
function write(file: string, wayList: Iterable<number>, rels: RelRec[], tagged: Iterable<number>, rect: Rect | null): number {
  const outWays: string[] = [];
  const seenWay = new Set<number>();
  const seenNode = new Set<number>();
  const outNodes: string[] = [];
  const addNode = (id: number, withTags: boolean): void => {
    if (seenNode.has(id)) return;
    seenNode.add(id);
    const line = nodeLine(id, withTags);
    if (line) outNodes.push(line);
  };
  const addWay = (w: WayRec): void => {
    if (seenWay.has(w.id)) return;
    seenWay.add(w.id);
    outWays.push(JSON.stringify({ id: w.id, refs: w.refs, tags: w.tags }));
    // (tags of a node count only inside the rectangle of the extract – as for the nodes on their own)
    for (const r of w.refs) {
      let inside = true;
      if (rect) {
        const n = nodeAt(r);
        inside = n >= 0 && nodeX[n] >= rect.minX && nodeX[n] <= rect.maxX && nodeZ[n] >= rect.minZ && nodeZ[n] <= rect.maxZ;
      }
      addNode(r, inside);
    }
  };
  for (const i of wayList) addWay(ways[i]);
  const outRels: string[] = [];
  for (const rel of rels) {
    outRels.push(JSON.stringify({ id: rel.id, members: rel.members, tags: rel.tags }));
    if (rel.tags.type === 'restriction') continue;
    for (const m of rel.members) {
      if (m.type !== 'w') continue;
      const i = wayIndex.get(m.ref);
      const w = i !== undefined ? ways[i] : extraWays.get(m.ref);
      if (w) addWay(w);
    }
  }
  for (const id of tagged) addNode(id, true);
  const text = `{"meta":${JSON.stringify({
    source: 'OpenStreetMap contributors (ODbL 1.0), via download.geofabrik.de',
    extractedAt,
    world: true,
    rect,
  })},\n"nodes":[\n${outNodes.join(',\n')}\n],\n"ways":[\n${outWays.join(',\n')}\n],\n"relations":[\n${outRels.join(',\n')}\n]}\n`;
  const gz = gzipSync(text, { level: 6 });
  writeFileSync(resolve(outDir, file), gz);
  return gz.length;
}

let bytes = 0;
blocks.forEach(([bx, bz], b) => {
  const rect = grow(gridRect(bx, bz, BLOCK), PAD);
  bytes += write(`b_${bx}_${bz}.json.gz`, blockWays[b], relations.filter((r) => r.blocks.has(b)), blockNodes[b], rect);
  process.stdout.write(`\r[extract] writing blocks: ${b + 1} of ${blocks.length}  ${elapsed()}   `);
});
console.log(`\n[extract] ${blocks.length} blocks, ${(bytes / 1048576).toFixed(0)} MB`);

// the road and rail network of the whole region, and what belongs to it
const roadWays: number[] = [];
ways.forEach((w, i) => {
  // (and the public car parks: the start points of the game lie on them)
  if (w.tags.highway || w.tags.railway || w.tags.amenity === 'parking') roadWays.push(i);
});
const roadRels = relations.filter((r) => r.tags.type === 'restriction' || r.tags.type === 'boundary');
const places: number[] = [];
for (const [id, t] of nodeTags) if (t.place || t.highway || t.railway || t.crossing || t.traffic_sign || t.barrier || t.public_transport) places.push(id);
const roadBytes = write('roads.json.gz', roadWays, roadRels, places, null);
console.log(`[extract] roads.json.gz: ${roadWays.length} roads and tracks, ${roadRels.length} relations (${(roadBytes / 1048576).toFixed(0)} MB)  ${elapsed()}`);

// where the region is built up: the areas mapped as residential, commercial or industrial, on a grid of 10 m
const CELL = 10;
const bw = Math.ceil((region.maxX - region.minX) / CELL);
const bh = Math.ceil((region.maxZ - region.minZ) / CELL);
const built = new Uint8Array(Math.ceil((bw * bh) / 8));
const isBuilt = (t: Tags): boolean => ['residential', 'commercial', 'retail', 'industrial', 'garages'].includes(t.landuse ?? '');
const ringOf = (refs: number[]): number[] | null => {
  const ring: number[] = [];
  for (const r of refs) {
    const n = nodeAt(r);
    if (n >= 0) ring.push(nodeX[n], nodeZ[n]);
    else {
      const e = extraNodes.get(r);
      if (!e) return null;
      ring.push(e[0], e[1]);
    }
  }
  return ring;
};
let painted = 0;
const paint = (ring: number[]): void => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]);
    maxX = Math.max(maxX, ring[i]);
    minZ = Math.min(minZ, ring[i + 1]);
    maxZ = Math.max(maxZ, ring[i + 1]);
  }
  const i0 = Math.max(0, Math.floor((minX - region.minX) / CELL));
  const i1 = Math.min(bw - 1, Math.floor((maxX - region.minX) / CELL));
  const j0 = Math.max(0, Math.floor((minZ - region.minZ) / CELL));
  const j1 = Math.min(bh - 1, Math.floor((maxZ - region.minZ) / CELL));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (!pointInRing(region.minX + (i + 0.5) * CELL, region.minZ + (j + 0.5) * CELL, ring)) continue;
      const k = j * bw + i;
      built[k >> 3] |= 1 << (k & 7);
      painted++;
    }
  }
};
for (const w of ways) {
  if (!isBuilt(w.tags) || w.refs.length < 4 || w.refs[0] !== w.refs[w.refs.length - 1]) continue;
  const ring = ringOf(w.refs.slice(0, -1));
  if (ring) paint(ring);
}
for (const rel of relations) {
  if (rel.tags.type !== 'multipolygon' || !isBuilt(rel.tags)) continue;
  // (outer rings that are single closed ways – the common case; the rest is left to the roads' own tags)
  for (const m of rel.members) {
    if (m.type !== 'w' || m.role === 'inner') continue;
    const i = wayIndex.get(m.ref);
    const w = i !== undefined ? ways[i] : extraWays.get(m.ref);
    if (!w || w.refs.length < 4 || w.refs[0] !== w.refs[w.refs.length - 1]) continue;
    const ring = ringOf(w.refs.slice(0, -1));
    if (ring) paint(ring);
  }
}
const head = Buffer.alloc(32);
head.write('BLT1', 0, 'latin1');
head.writeInt32LE(region.minX, 4);
head.writeInt32LE(region.minZ, 8);
head.writeInt32LE(bw, 12);
head.writeInt32LE(bh, 16);
head.writeInt32LE(CELL, 20);
writeFileSync(resolve(outDir, 'built.bin'), Buffer.concat([head, Buffer.from(built.buffer, built.byteOffset, built.byteLength)]));
console.log(`[extract] built.bin: ${(painted * CELL * CELL / 1e6).toFixed(0)} km² built up`);
// the region this extract was cut for: the steps after it build exactly that
writeFileSync(resolve(outDir, 'region.json'), JSON.stringify({ tiles: coverage.list() }));
console.log(`[extract] done in ${elapsed()}: ${readdirSync(outDir).length} files in ${outDir}`);
