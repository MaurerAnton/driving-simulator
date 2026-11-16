// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Address list for "start at / jump to an address":
 *
 *   node --max-old-space-size=3072 tools/build-addresses.ts
 *
 * Reads the house numbers of the OpenStreetMap extract (`addr:street`,
 * `addr:housenumber` on buildings and address points), keeps those that lie
 * on the map next to a road one may drive on, adds the named roads that have
 * no house numbers at all, and writes  public/map/addresses.json.gz  (loaded
 * by the game only when somebody searches for an address).
 *
 * Works block by block, like the tile build: needs the extracts
 * (tools/osm-extract.ts) and the road network (tools/build-graph.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { findRoadSpot, normaliseAddress } from '../src/game/address.ts';
import type { AddressJson } from '../src/game/address.ts';
import { LaneGraph } from '../src/world/lanes.ts';
import type { Lane } from '../src/world/lanes.ts';
import { unpackNet } from '../src/world/netfile.ts';
import { NetIndex } from '../src/world/netindex.ts';
import type { PlaceJson, WorldJson } from '../src/world/types.ts';
import { World } from '../src/world/world.ts';
import { OsmData } from './mapgen/osm.ts';
import type { Tags } from './mapgen/osm.ts';
import { BLOCK, gridRect } from './mapgen/store.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// (MAP_OUT: the folder the map was built into, see tools/build-map.ts)
const mapDir = resolve(root, process.env.MAP_OUT ?? 'public/map');
const workDir = resolve(root, 'data/work/graph');
const plan = JSON.parse(readFileSync(resolve(workDir, 'plan.json'), 'utf8')) as { blocks: Array<[number, number]>; places: PlaceJson[] };
// only where the road is part of the connected network (not a fragment at the rim of the map)
const netBytes = gunzipSync(readFileSync(resolve(mapDir, 'net.bin.gz')));
const index = new NetIndex(unpackNet(netBytes.buffer.slice(netBytes.byteOffset, netBytes.byteOffset + netBytes.byteLength) as ArrayBuffer));

/** Districts and villages, to name the place of a street that has no house numbers. */
const places = plan.places.filter((p) => ['town', 'suburb', 'village'].includes(p.kind));
const placeGrid = new Map<number, PlaceJson[]>();
for (const p of places) {
  const k = Math.floor(p.x / 3000) * 10007 + Math.floor(p.z / 3000);
  placeGrid.set(k, [...(placeGrid.get(k) ?? []), p]);
}
function placeAt(x: number, z: number): string {
  let best = '';
  let bd = 3000;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (const p of placeGrid.get((Math.floor(x / 3000) + i) * 10007 + Math.floor(z / 3000) + j) ?? []) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bd) {
          bd = d;
          best = p.name;
        }
      }
    }
  }
  return best;
}

interface House {
  no: string;
  x: number;
  z: number;
  suburb: string;
}
interface Group {
  street: string;
  city: string;
  houses: House[];
}
const groups = new Map<string, Group>();
const roads = new Map<string, { name: string; x: number; z: number; len: number; town: string }>();
let seen = 0;
let noRoad = 0;

plan.blocks.forEach(([bx, bz], bi) => {
  const name = `${bx}_${bz}`;
  const info = JSON.parse(gunzipSync(readFileSync(resolve(workDir, `b_${name}.json.gz`))).toString('utf8')) as { world: WorldJson; edges: number[] };
  const world = new World(info.world);
  const graph = new LaneGraph(world);
  const main = (l: Lane): boolean => index.main[info.edges[l.edge.id] * 2 + (l.dir > 0 ? 0 : 1)] === 1;
  const osm = OsmData.load(resolve(root, 'data/work/osm', `b_${name}.json.gz`));
  // (each address and each road belongs to the block it lies in: the extracts of neighbouring blocks overlap)
  const rect = gridRect(bx, bz, BLOCK);
  const mine = (x: number, z: number): boolean => x >= rect.minX && x < rect.maxX && z >= rect.minZ && z < rect.maxZ;

  const add = (tags: Tags, x: number, z: number): void => {
    const no = (tags['addr:housenumber'] ?? '').trim();
    const street = (tags['addr:street'] ?? tags['addr:place'] ?? '').trim();
    if (!no || !street || no.length > 12 || !mine(x, z)) return;
    seen++;
    // only houses one can actually drive up to in the simulation
    if (!findRoadSpot(world, graph, x, z, street, 160, main)) {
      noRoad++;
      return;
    }
    const suburb = (tags['addr:suburb'] ?? '').trim();
    const city = (tags['addr:city'] ?? '').trim() || placeAt(x, z);
    const key = `${normaliseAddress(street)}|${normaliseAddress(city)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { street, city, houses: [] }));
    // several entrances or units with the same number: one entry is enough
    if (!g.houses.some((h) => h.no === no && Math.hypot(h.x - x, h.z - z) < 40)) g.houses.push({ no, x: Math.round(x), z: Math.round(z), suburb });
  };
  for (const n of osm.nodes.values()) if (n.tags?.['addr:housenumber']) add(n.tags, n.x, n.z);
  for (const w of osm.ways) {
    if (!w.tags?.['addr:housenumber']) continue;
    const c = osm.wayCoords(w);
    let x = 0;
    let z = 0;
    for (let i = 0; i < c.length; i += 2) {
      x += c[i];
      z += c[i + 1];
    }
    if (c.length > 0) add(w.tags, x / (c.length / 2), z / (c.length / 2));
  }

  // named roads (country roads, the motorway by its number): the longest piece of each near each town
  for (const e of world.allEdges) {
    const road = e.name || (e.tier >= 3 ? e.ref : '');
    if (!road || !LaneGraph.drivable(e, false) || e.len - e.cutA - e.cutB < 20) continue;
    const mid = (e.pl.pts.length / 3) >> 1;
    const x = e.pl.pts[mid * 3];
    const z = e.pl.pts[mid * 3 + 2];
    if (!mine(x, z)) continue;
    const el = graph.edgeLanes[e.id];
    if (![...el.fwd, ...el.back].some(main)) continue;
    const town = placeAt(x, z);
    const key = `${normaliseAddress(road)}|${normaliseAddress(town)}`;
    const r = roads.get(key);
    if (!r || e.len > r.len) roads.set(key, { name: road, x: Math.round(x), z: Math.round(z), len: e.len, town });
  }
  process.stdout.write(`\r[addresses] block ${bi + 1} of ${plan.blocks.length}  `);
});
process.stdout.write('\n');

const out: AddressJson = { version: 1, streets: [] };
const byName = new Map<string, Group[]>();
for (const g of groups.values()) {
  // the district, if (nearly) the whole street lies in one: "Baunatal-Großenritte"
  const count = new Map<string, number>();
  for (const h of g.houses) if (h.suburb) count.set(h.suburb, (count.get(h.suburb) ?? 0) + 1);
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  const district = top && top[1] >= g.houses.length * 0.6 && normaliseAddress(top[0]) !== normaliseAddress(g.city) ? top[0] : '';
  // a house in the middle stands for the street
  const cx = g.houses.reduce((s, h) => s + h.x, 0) / g.houses.length;
  const cz = g.houses.reduce((s, h) => s + h.z, 0) / g.houses.length;
  const mid = g.houses.reduce((b, h) => (Math.hypot(h.x - cx, h.z - cz) < Math.hypot(b.x - cx, b.z - cz) ? h : b));
  const h: Array<string | number> = [];
  for (const x of g.houses) h.push(x.no, x.x, x.z);
  out.streets.push({ n: g.street, c: district && g.city ? `${g.city}-${district}` : g.city || district, x: mid.x, z: mid.z, h });
  const k = normaliseAddress(g.street);
  byName.set(k, [...(byName.get(k) ?? []), g]);
}
// the named roads that are not covered by houses of that street nearby
let bare = 0;
for (const r of roads.values()) {
  const k = normaliseAddress(r.name);
  if ((byName.get(k) ?? []).some((g) => g.houses.some((h) => Math.hypot(h.x - r.x, h.z - r.z) < 600))) continue;
  out.streets.push({ n: r.name, c: r.town, x: r.x, z: r.z, h: [] });
  bare++;
}

out.streets.sort((a, b) => a.n.localeCompare(b.n, 'de') || a.c.localeCompare(b.c, 'de'));
const text = `{"version":1,"streets":[\n${out.streets.map((s) => JSON.stringify(s)).join(',\n')}\n]}\n`;
const target = resolve(mapDir, 'addresses.json.gz');
const gz = gzipSync(text, { level: 9 });
writeFileSync(target, gz);
const houses = out.streets.reduce((n, s) => n + s.h.length / 3, 0);
console.log(`${seen} addresses in the extracts: ${noRoad} without a road of the connected network nearby`);
console.log(`wrote ${target}: ${out.streets.length} streets (${bare} of them without house numbers), ${houses} house numbers, ${(gz.length / 1024).toFixed(0)} kB (${(text.length / 1024).toFixed(0)} kB unpacked)`);
