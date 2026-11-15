// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Address list for "start at / jump to an address":
 *
 *   node tools/build-addresses.ts
 *
 * Reads the house numbers of the OpenStreetMap extract (`addr:street`,
 * `addr:housenumber` on buildings and address points), keeps those that lie
 * on the map next to a road one may drive on, adds the named roads that have
 * no house numbers at all, and writes  public/map/addresses.json  (loaded by
 * the game only when somebody searches for an address).
 *
 * Needs data/work/osm-extract.json (npm run map:extract) and the built map.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findRoadSpot, mainNetwork, normaliseAddress } from '../src/game/address.ts';
import type { AddressJson } from '../src/game/address.ts';
import { latLonToWorld } from '../src/geo/utm.ts';
import { LaneGraph } from '../src/world/lanes.ts';
import type { WorldJson } from '../src/world/types.ts';
import { World } from '../src/world/world.ts';

type Tags = Record<string, string>;
interface Extract {
  nodes: Array<[number, number, number, Tags?]>;
  ways: Array<{ id: number; refs: number[]; tags: Tags }>;
}

const root = new URL('../', import.meta.url);
// (MAP_OUT: the folder the map was built into, see tools/build-map.ts)
const mapDir = `${(process.env.MAP_OUT ?? 'public/map').replace(/\/$/, '')}/`;
const json = JSON.parse(readFileSync(new URL(`${mapDir}world.json`, root), 'utf8')) as WorldJson;
const world = new World(json);
const graph = new LaneGraph(world);
// only where the road is part of the connected network (not a fragment at the rim of the map)
const main = mainNetwork(world, graph);
const osm = JSON.parse(readFileSync(new URL('data/work/osm-extract.json', root), 'utf8')) as Extract;
const { minX, maxX, minZ, maxZ } = json.meta;

const nodePos = new Map<number, [number, number]>();
for (const n of osm.nodes) nodePos.set(n[0], [n[1], n[2]]);

/** Districts and villages, to name the place of a street that has no house numbers. */
const places = json.places.filter((p) => ['town', 'suburb', 'village'].includes(p.kind));
function placeAt(x: number, z: number): string {
  let best = '';
  let bd = 3000;
  for (const p of places) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bd) {
      bd = d;
      best = p.name;
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
let seen = 0;
let offMap = 0;
let noRoad = 0;

function add(tags: Tags, lat: number, lon: number): void {
  const no = (tags['addr:housenumber'] ?? '').trim();
  const street = (tags['addr:street'] ?? tags['addr:place'] ?? '').trim();
  if (!no || !street || no.length > 12) return;
  seen++;
  const [x, z] = latLonToWorld(lat, lon);
  if (x < minX || x > maxX || z < minZ || z > maxZ) {
    offMap++;
    return;
  }
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
}

for (const n of osm.nodes) if (n[3]?.['addr:housenumber']) add(n[3], n[1], n[2]);
for (const w of osm.ways) {
  if (!w.tags?.['addr:housenumber']) continue;
  let lat = 0;
  let lon = 0;
  let k = 0;
  for (const r of w.refs) {
    const p = nodePos.get(r);
    if (p) {
      lat += p[0];
      lon += p[1];
      k++;
    }
  }
  if (k > 0) add(w.tags, lat / k, lon / k);
}

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

// named roads without any house number (country roads, the motorway by its number)
const roads = new Map<string, { name: string; x: number; z: number; len: number; town: string }>();
for (const e of world.edges) {
  const name = e.name || (e.tier >= 3 ? e.ref : '');
  if (!name || !LaneGraph.drivable(e, false) || e.len - e.cutA - e.cutB < 20) continue;
  const el = graph.edgeLanes[e.id];
  if (![...el.fwd, ...el.back].some((l) => main.has(l.id))) continue;
  const mid = e.pl.pts.length / 3 >> 1;
  const x = e.pl.pts[mid * 3];
  const z = e.pl.pts[mid * 3 + 2];
  // already covered by houses of that street nearby?
  const k = normaliseAddress(name);
  if ((byName.get(k) ?? []).some((g) => g.houses.some((h) => Math.hypot(h.x - x, h.z - z) < 600))) continue;
  const town = placeAt(x, z);
  const key = `${k}|${normaliseAddress(town)}`;
  const r = roads.get(key);
  if (!r || e.len > r.len) roads.set(key, { name, x: Math.round(x), z: Math.round(z), len: e.len, town });
}
for (const r of roads.values()) out.streets.push({ n: r.name, c: r.town, x: r.x, z: r.z, h: [] });

out.streets.sort((a, b) => a.n.localeCompare(b.n, 'de') || a.c.localeCompare(b.c, 'de'));
const text = `{"version":1,"streets":[\n${out.streets.map((s) => JSON.stringify(s)).join(',\n')}\n]}\n`;
const target = new URL(`${mapDir}addresses.json`, root);
writeFileSync(target, text);
const houses = out.streets.reduce((n, s) => n + s.h.length / 3, 0);
console.log(`connected road network: ${main.size} of ${graph.lanes.length} lanes`);
console.log(`${seen} addresses in the extract: ${offMap} outside the map, ${noRoad} without a road of the connected network nearby`);
console.log(`wrote ${fileURLToPath(target)}: ${out.streets.length} streets (${roads.size} of them without house numbers), ${houses} house numbers, ${(text.length / 1024).toFixed(0)} kB`);
