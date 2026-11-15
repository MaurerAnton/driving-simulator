// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cut the Baunatal world rectangle out of a Geofabrik .osm.pbf extract.
 *
 *   node tools/osm-extract.ts [path/to/hessen-latest.osm.pbf]
 *
 * Output: data/work/osm-extract.json  (nodes, ways, relations as plain JSON)
 *
 * Kept:
 *   - every way with at least one node inside the world rectangle
 *   - every tagged node inside the rectangle
 *   - relations that reference kept elements; multipolygons and local
 *     administrative boundaries are completed (all member ways + nodes) so
 *     that area fills stay correct even when a forest spans 20 km.
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPbf } from './osm/pbf.ts';
import type { OsmMember, Tags } from './osm/pbf.ts';
import {
  utm32ToLatLon,
  WORLD_MAX_E,
  WORLD_MAX_N,
  WORLD_MIN_E,
  WORLD_MIN_N,
} from '../src/geo/utm.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = resolve(root, process.argv[2] ?? 'data/raw/osm/hessen-latest.osm.pbf');
const output = resolve(root, 'data/work/osm-extract.json');

if (!existsSync(input)) {
  console.error(`Missing ${input}\nDownload it first:\n  curl -L -o data/raw/osm/hessen-latest.osm.pbf https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf`);
  process.exit(1);
}

/** lat/lon box around the UTM rectangle grown by `pad` metres. */
function geoBox(pad: number): { minLat: number; maxLat: number; minLon: number; maxLon: number } {
  const corners = [
    utm32ToLatLon(WORLD_MIN_E - pad, WORLD_MIN_N - pad),
    utm32ToLatLon(WORLD_MAX_E + pad, WORLD_MIN_N - pad),
    utm32ToLatLon(WORLD_MIN_E - pad, WORLD_MAX_N + pad),
    utm32ToLatLon(WORLD_MAX_E + pad, WORLD_MAX_N + pad),
  ];
  return {
    minLat: Math.min(...corners.map((c) => c[0])),
    maxLat: Math.max(...corners.map((c) => c[0])),
    minLon: Math.min(...corners.map((c) => c[1])),
    maxLon: Math.max(...corners.map((c) => c[1])),
  };
}

const core = geoBox(60);
const padded = geoBox(2500);

interface NodeRec {
  lat: number;
  lon: number;
  tags: Tags | null;
  core: boolean;
}
interface WayRec {
  id: number;
  refs: number[];
  tags: Tags;
}
interface RelRec {
  id: number;
  members: OsmMember[];
  tags: Tags;
}

const nodes = new Map<number, NodeRec>();
const ways = new Map<number, WayRec>();
const relations: RelRec[] = [];
const wantWays = new Set<number>();

const t0 = Date.now();
const elapsed = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const sizeMb = (statSync(input).size / 1048576).toFixed(0);
console.log(`[extract] pass 1/3: scanning ${sizeMb} MB …`);

let nodeCount = 0;
let wayCount = 0;
readPbf(input, {
  node(id, lat, lon, tags) {
    nodeCount++;
    if (lat < padded.minLat || lat > padded.maxLat || lon < padded.minLon || lon > padded.maxLon) return;
    const inCore = lat >= core.minLat && lat <= core.maxLat && lon >= core.minLon && lon <= core.maxLon;
    nodes.set(id, { lat, lon, tags: inCore ? tags() : null, core: inCore });
  },
  way(id, refs, tags) {
    wayCount++;
    let hit = false;
    for (let i = 0; i < refs.length; i++) {
      const n = nodes.get(refs[i]);
      if (n !== undefined && n.core) {
        hit = true;
        break;
      }
    }
    if (hit) ways.set(id, { id, refs, tags: tags() });
  },
  relation(id, getMembers, getTags) {
    const members = getMembers();
    let hit = false;
    for (const m of members) {
      if (m.type === 'w' ? ways.has(m.ref) : m.type === 'n' ? nodes.get(m.ref)?.core === true : false) {
        hit = true;
        break;
      }
    }
    if (!hit) return;
    const tags = getTags();
    const type = tags.type;
    const adminLevel = Number(tags.admin_level ?? '0');
    const complete =
      type === 'multipolygon' || (type === 'boundary' && tags.boundary === 'administrative' && adminLevel >= 8);
    if (complete) {
      for (const m of members) if (m.type === 'w' && !ways.has(m.ref)) wantWays.add(m.ref);
    }
    relations.push({ id, members, tags });
  },
  progress(done, total) {
    process.stdout.write(`\r[extract]   ${((done / total) * 100).toFixed(0)}%  ${elapsed()}   `);
  },
});
console.log(`\n[extract] scanned ${nodeCount} nodes, ${wayCount} ways in ${elapsed()}`);
console.log(`[extract] kept ${ways.size} ways, ${relations.length} relations; completing ${wantWays.size} outlying member ways`);

const wantNodes = new Set<number>();
if (wantWays.size > 0) {
  console.log('[extract] pass 2/3: outlying multipolygon ways …');
  readPbf(input, {
    way(id, refs, tags) {
      if (!wantWays.has(id)) return;
      ways.set(id, { id, refs, tags: tags() });
      for (const r of refs) if (!nodes.has(r)) wantNodes.add(r);
    },
  });
  console.log(`[extract]   done ${elapsed()}; need ${wantNodes.size} more nodes`);
}
if (wantNodes.size > 0) {
  console.log('[extract] pass 3/3: outlying nodes …');
  readPbf(input, {
    node(id, lat, lon) {
      if (wantNodes.has(id)) nodes.set(id, { lat, lon, tags: null, core: false });
    },
  });
  console.log(`[extract]   done ${elapsed()}`);
}

// Emit only nodes that are referenced or carry tags inside the rectangle.
const used = new Set<number>();
for (const w of ways.values()) for (const r of w.refs) used.add(r);
for (const rel of relations) for (const m of rel.members) if (m.type === 'n') used.add(m.ref);

const round7 = (v: number): number => Math.round(v * 1e7) / 1e7;
const outNodes: Array<[number, number, number] | [number, number, number, Tags]> = [];
for (const [id, n] of nodes) {
  const tagged = n.tags !== null && Object.keys(n.tags).length > 0;
  if (!used.has(id) && !(tagged && n.core)) continue;
  outNodes.push(tagged ? [id, round7(n.lat), round7(n.lon), n.tags!] : [id, round7(n.lat), round7(n.lon)]);
}

mkdirSync(dirname(output), { recursive: true });
const parts: string[] = [];
parts.push(
  `{"meta":${JSON.stringify({
    source: 'OpenStreetMap contributors (ODbL 1.0), via download.geofabrik.de',
    extractedAt: new Date().toISOString(),
    utmRect: { minE: WORLD_MIN_E, maxE: WORLD_MAX_E, minN: WORLD_MIN_N, maxN: WORLD_MAX_N },
  })},\n"nodes":[\n`,
);
parts.push(outNodes.map((n) => JSON.stringify(n)).join(',\n'));
parts.push('\n],\n"ways":[\n');
parts.push([...ways.values()].map((w) => JSON.stringify(w)).join(',\n'));
parts.push('\n],\n"relations":[\n');
parts.push(relations.map((r) => JSON.stringify(r)).join(',\n'));
parts.push('\n]}\n');
writeFileSync(output, parts.join(''));
console.log(
  `[extract] wrote ${output}: ${outNodes.length} nodes, ${ways.size} ways, ${relations.length} relations (${(statSync(output).size / 1048576).toFixed(1)} MB) in ${elapsed()}`,
);
