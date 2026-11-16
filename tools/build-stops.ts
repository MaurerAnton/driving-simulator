// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stops and airfields for the game, from the OpenStreetMap extract:
 *
 *   node --max-old-space-size=3072 tools/build-stops.ts
 *
 * - names the stops along the tracks of rails.json.gz (tools/build-graph.ts
 *   wrote it), and says on which side of the track their platform lies and
 *   whether the track has an overhead wire;
 * - writes stops.json.gz: every tram and bus stop of the region with its name
 *   and town, where its poles stand (with shelter, bench, …) and the outlines
 *   of its platforms – what the game draws, lists as start points for the
 *   tram, and drives the bus to;
 * - writes air.json.gz: the airfields with their runways, taxiways and aprons.
 *
 * Needs the extracts (tools/osm-extract.ts) and the map built from them;
 * MAP_OUT names the map folder (default public/map).  The stops and towns
 * come from data/work/osm/roads.json.gz, the airfields from the block extracts.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { pointInRing } from '../src/core/geom.ts';
import type { AirJson, AirfieldJson, StopsJson } from '../src/world/types.ts';
import { STOP_FLAG } from '../src/world/types.ts';
import type { RailJson } from '../src/world/types.ts';
import { RAIL } from '../src/world/types.ts';
import { OsmData } from './mapgen/osm.ts';
import type { ONode, Tags } from './mapgen/osm.ts';
import { Coverage } from './mapgen/store.ts';
import type { Rect } from './mapgen/store.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mapDir = resolve(root, process.env.MAP_OUT ?? 'public/map');
const osmDir = resolve(root, 'data/work/osm');
const t0 = Date.now();
const lap = (msg: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);
const round1 = (v: number): number => Math.round(v * 10) / 10;

const coverage = new Coverage(root, true);
const inWorld = (x: number, z: number): boolean => coverage.covered(x, z);
const osm = OsmData.load(resolve(osmDir, 'roads.json.gz'));
lap(`roads of the region: ${osm.nodes.size} nodes, ${osm.ways.length} ways, ${osm.relations.length} relations`);

// ---------------------------------------------------------------- towns
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
// the municipalities, as the start points are grouped (tools/build-graph.ts): towns and the city of Kassel, not the districts
const towns: Array<{ name: string; rings: number[][]; box: Rect }> = [];
for (const rel of osm.relations) {
  if (rel.tags.boundary !== 'administrative' || !rel.tags.name) continue;
  const level = rel.tags.admin_level;
  if (level !== '6' && level !== '8') continue;
  if (level === '6' && /kreis/i.test(rel.tags.name)) continue;
  const rings = osm.multipolygonRings(rel).outer;
  if (rings.length > 0) towns.push({ name: rel.tags.name, rings, box: boxOf(rings) });
}
const townAt = (x: number, z: number): string => towns.find((k) => x >= k.box.minX && x <= k.box.maxX && z >= k.box.minZ && z <= k.box.maxZ && inRings(k.rings, x, z))?.name ?? '';
lap(`${towns.length} towns`);

// ---------------------------------------------------------------- what makes a stop
const yes = (v: string | undefined): boolean => v === 'yes' || v === 'designated';
const tramPosition = (t: Tags): boolean => t.railway === 'tram_stop' || (t.public_transport === 'stop_position' && (yes(t.tram) || yes(t.light_rail)));
const railPosition = (t: Tags): boolean => t.railway === 'halt' || t.railway === 'station' || t.railway === 'stop' || (t.public_transport === 'stop_position' && yes(t.train));
const busPosition = (t: Tags): boolean => t.public_transport === 'stop_position' && (yes(t.bus) || yes(t.trolleybus));
const isPole = (t: Tags): boolean => t.highway === 'bus_stop' || t.public_transport === 'platform' || t.railway === 'platform';
const flagsOf = (t: Tags): number =>
  (yes(t.shelter) ? STOP_FLAG.SHELTER : 0) |
  (yes(t.bench) ? STOP_FLAG.BENCH : 0) |
  (yes(t.bin) ? STOP_FLAG.BIN : 0) |
  ((t.departures_board && t.departures_board !== 'no') || yes(t.passenger_information_display) ? STOP_FLAG.BOARD : 0) |
  (yes(t.tactile_paving) ? STOP_FLAG.TACTILE : 0) |
  (yes(t.lit) ? STOP_FLAG.LIT : 0);

// nodes that lie on a road the tile build draws a stop sign on (tools/mapgen/signs.ts: bus_stop nodes on the way get Zeichen 224 there)
const FOOT = new Set(['footway', 'path', 'cycleway', 'pedestrian', 'steps', 'platform', 'bridleway', 'corridor', 'elevator', 'proposed', 'construction']);
const onRoad = new Set<number>();
for (const w of osm.ways) if (w.tags.highway && !FOOT.has(w.tags.highway)) for (const r of w.refs) onRoad.add(r);

interface Feature {
  name: string;
  x: number;
  z: number;
  /** a pole or platform node (where people wait), or a stop position on the track or road */
  pole: boolean;
  tram: boolean;
  bus: boolean;
  rail: boolean;
  flags: number;
}
const features: Feature[] = [];
const named = (t: Tags): string => (t.name ?? t['ref_name'] ?? '').trim();
for (const n of osm.nodes.values()) {
  const t = n.tags;
  if (!t || !inWorld(n.x, n.z)) continue;
  const pole = isPole(t);
  const tram = tramPosition(t) || (pole && (yes(t.tram) || yes(t.light_rail)));
  const bus = busPosition(t) || t.highway === 'bus_stop' || (pole && (yes(t.bus) || yes(t.trolleybus)));
  const rail = railPosition(t) || (pole && yes(t.train));
  if (!pole && !tram && !bus && !rail) continue;
  features.push({ name: named(t), x: n.x, z: n.z, pole, tram, bus, rail, flags: flagsOf(t) | (pole && onRoad.has(n.id) && t.highway === 'bus_stop' ? STOP_FLAG.ON_ROAD : 0) });
}
// platforms drawn as ways: lines along the edge, or areas
interface Platform {
  name: string;
  pts: number[];
  closed: boolean;
  flags: number;
  tram: boolean;
  bus: boolean;
  rail: boolean;
  width: number;
}
const platforms: Platform[] = [];
for (const w of osm.ways) {
  const t = w.tags;
  if (!(t.public_transport === 'platform' || t.railway === 'platform' || t.highway === 'platform')) continue;
  const pts = osm.wayCoords(w);
  if (pts.length < 4 || !inWorld(pts[0], pts[1])) continue;
  const closed = w.refs.length > 3 && w.refs[0] === w.refs[w.refs.length - 1];
  platforms.push({ name: named(t), pts, closed, flags: flagsOf(t), tram: yes(t.tram) || yes(t.light_rail), bus: yes(t.bus), rail: yes(t.train) || t.railway === 'platform', width: Number.parseFloat(t.width ?? '') || 0 });
}
lap(`${features.length} stop nodes (${features.filter((f) => f.pole).length} poles and platform points), ${platforms.length} platforms drawn as ways`);

// ---------------------------------------------------------------- a grid to find things nearby
class Grid<T> {
  private readonly cells = new Map<number, T[]>();
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  private key(i: number, j: number): number {
    return (i + 32768) * 65536 + (j + 32768);
  }
  add(x: number, z: number, v: T): void {
    const k = this.key(Math.floor(x / this.size), Math.floor(z / this.size));
    const list = this.cells.get(k);
    if (list) list.push(v);
    else this.cells.set(k, [v]);
  }
  near(x: number, z: number, r: number, out: T[] = []): T[] {
    out.length = 0;
    const i0 = Math.floor((x - r) / this.size);
    const i1 = Math.floor((x + r) / this.size);
    const j0 = Math.floor((z - r) / this.size);
    const j1 = Math.floor((z + r) / this.size);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const v of this.cells.get(this.key(i, j)) ?? []) out.push(v);
    return out;
  }
}

// ---------------------------------------------------------------- stop places: the features of one name close together
interface Place {
  name: string;
  town: string;
  x: number;
  z: number;
  kind: number;
  members: Feature[];
  platforms: Platform[];
}
const places: Place[] = [];
{
  const byName = new Map<string, Feature[]>();
  for (const f of features) {
    if (!f.name) continue;
    const list = byName.get(f.name);
    if (list) list.push(f);
    else byName.set(f.name, [f]);
  }
  // (one name is given to stops in several villages: clusters of features less than 400 m apart)
  for (const [name, list] of byName) {
    const group = new Int32Array(list.length).fill(-1);
    let groups = 0;
    for (let i = 0; i < list.length; i++) {
      if (group[i] >= 0) continue;
      group[i] = groups;
      const todo = [i];
      while (todo.length) {
        const a = list[todo.pop()!];
        for (let j = 0; j < list.length; j++) {
          if (group[j] >= 0) continue;
          if (Math.hypot(list[j].x - a.x, list[j].z - a.z) < 400) {
            group[j] = groups;
            todo.push(j);
          }
        }
      }
      groups++;
    }
    for (let g = 0; g < groups; g++) {
      const members = list.filter((_, i) => group[i] === g);
      const x = members.reduce((s, f) => s + f.x, 0) / members.length;
      const z = members.reduce((s, f) => s + f.z, 0) / members.length;
      const kind = (members.some((f) => f.tram) ? STOP_FLAG.TRAM : 0) | (members.some((f) => f.bus) ? STOP_FLAG.BUS : 0) | (members.some((f) => f.rail) ? STOP_FLAG.RAIL : 0);
      places.push({ name, town: '', x, z, kind, members, platforms: [] });
    }
  }
  // a platform way belongs to the place of its name nearby – or, without a name, to the nearest place
  const placeGrid = new Grid<Place>(400);
  for (const p of places) placeGrid.add(p.x, p.z, p);
  const tmp: Place[] = [];
  for (const pf of platforms) {
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < pf.pts.length; i += 2) {
      cx += pf.pts[i];
      cz += pf.pts[i + 1];
    }
    cx /= pf.pts.length / 2;
    cz /= pf.pts.length / 2;
    let best: Place | null = null;
    let bestD = Infinity;
    for (const p of placeGrid.near(cx, cz, 400, tmp)) {
      const d = Math.hypot(p.x - cx, p.z - cz) + (pf.name && pf.name !== p.name ? 1e6 : 0);
      if (d < bestD && d < (pf.name ? 400 : 120)) {
        best = p;
        bestD = d;
      }
    }
    if (best) {
      best.platforms.push(pf);
      if (pf.tram) best.kind |= STOP_FLAG.TRAM;
      if (pf.bus) best.kind |= STOP_FLAG.BUS;
    }
  }
  for (const p of places) p.town = townAt(p.x, p.z);
  places.sort((a, b) => a.town.localeCompare(b.town, 'de') || a.name.localeCompare(b.name, 'de'));
}
lap(`${places.length} stop places: ${places.filter((p) => p.kind & STOP_FLAG.TRAM).length} with trams, ${places.filter((p) => p.kind & STOP_FLAG.BUS).length} with buses, ${places.filter((p) => p.kind & STOP_FLAG.RAIL).length} with trains`);

// ---------------------------------------------------------------- the tracks: names and sides of their stops, overhead wire
const railFile = resolve(mapDir, 'rails.json.gz');
const railDoc = JSON.parse(gunzipSync(readFileSync(railFile)).toString('utf8')) as { v: number; rails: RailJson[] };
const rails = railDoc.rails;
{
  const featureGrid = new Grid<Feature>(50);
  for (const f of features) featureGrid.add(f.x, f.z, f);
  const platformGrid = new Grid<{ pf: Platform; i: number }>(50);
  for (const pf of platforms) for (let i = 0; i + 3 < pf.pts.length; i += 2) platformGrid.add(pf.pts[i], pf.pts[i + 1], { pf, i });
  // the railway ways with their tags, a segment at a time
  const kindOf = (t: Tags): number => (t.railway === 'tram' ? RAIL.TRAM : t.railway === 'light_rail' ? RAIL.LIGHT : t.railway === 'rail' ? RAIL.TRAIN : -1);
  const segGrid = new Grid<{ x0: number; z0: number; x1: number; z1: number; kind: number; wire: number }>(40);
  for (const w of osm.ways) {
    const kind = kindOf(w.tags);
    if (kind < 0) continue;
    const e = w.tags.electrified;
    const wire = e === 'contact_line' ? 1 : e === 'no' ? 0 : e ? 2 : -1;
    const c = osm.wayCoords(w);
    for (let i = 0; i + 3 < c.length; i += 2) segGrid.add((c[i] + c[i + 2]) / 2, (c[i + 1] + c[i + 3]) / 2, { x0: c[i], z0: c[i + 1], x1: c[i + 2], z1: c[i + 3], kind, wire });
  }
  const segDist = (s: { x0: number; z0: number; x1: number; z1: number }, x: number, z: number): number => {
    const dx = s.x1 - s.x0;
    const dz = s.z1 - s.z0;
    const l2 = dx * dx + dz * dz;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - s.x0) * dx + (z - s.z0) * dz) / l2)) : 0;
    return Math.hypot(s.x0 + dx * u - x, s.z0 + dz * u - z);
  };
  let named = 0;
  let unnamed = 0;
  let sides = 0;
  let wired = 0;
  let bare = 0;
  const near: Feature[] = [];
  const nearP: Array<{ pf: Platform; i: number }> = [];
  const nearS: Array<{ x0: number; z0: number; x1: number; z1: number; kind: number; wire: number }> = [];
  for (const r of rails) {
    const p = r.p;
    const n = p.length / 3;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 2] - p[i * 3 - 1]);
    /** point and direction at s metres from the start */
    const at = (s: number): { x: number; z: number; tx: number; tz: number } => {
      let i = 1;
      while (i < n - 1 && cum[i] < s) i++;
      const l = cum[i] - cum[i - 1] || 1;
      const u = Math.max(0, Math.min(1, (s - cum[i - 1]) / l));
      const ax = p[i * 3 - 3];
      const az = p[i * 3 - 1];
      const bx = p[i * 3];
      const bz = p[i * 3 + 2];
      return { x: ax + (bx - ax) * u, z: az + (bz - az) * u, tx: (bx - ax) / l, tz: (bz - az) / l };
    };
    // the overhead wire: what the railway ways under the piece say, by majority
    let yesWire = 0;
    let noWire = 0;
    for (const f of [0.2, 0.5, 0.8]) {
      const q = at(cum[n - 1] * f);
      let best: { wire: number } | null = null;
      let bestD = 3;
      for (const s of segGrid.near(q.x, q.z, 40, nearS)) {
        if (s.kind !== r.k) continue;
        const d = segDist(s, q.x, q.z);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (best?.wire === 1) yesWire++;
      else if (best?.wire === 0) noWire++;
    }
    if (yesWire > noWire) {
      r.e = 1;
      wired++;
    } else if (noWire > yesWire) {
      r.e = 0;
      bare++;
    } else delete r.e;
    if (!r.st || r.st.length === 0) continue;
    const names: string[] = [];
    const side: number[] = [];
    for (const s of r.st) {
      const q = at(s);
      // the name: the stop position itself (it is a node of the track), else the nearest stop of trams or trains
      let name = '';
      let bestD = Infinity;
      for (const f of featureGrid.near(q.x, q.z, 60, near)) {
        if (!f.name) continue;
        const d = Math.hypot(f.x - q.x, f.z - q.z) + (f.pole ? 3 : 0) + (f.tram || f.rail ? 0 : 20);
        if (d < bestD && d < 60) {
          bestD = d;
          name = f.name;
        }
      }
      if (name) named++;
      else unnamed++;
      names.push(name);
      // the side of the platform: the nearest platform way or pole of that name, left or right of the direction the track was drawn in
      let lateral = 0;
      let bestP = 30;
      for (const { pf, i } of platformGrid.near(q.x, q.z, 50, nearP)) {
        if (name && pf.name && pf.name !== name) continue;
        const d = segDist({ x0: pf.pts[i], z0: pf.pts[i + 1], x1: pf.pts[i + 2], z1: pf.pts[i + 3] }, q.x, q.z);
        if (d < bestP) {
          bestP = d;
          const mx = (pf.pts[i] + pf.pts[i + 2]) / 2;
          const mz = (pf.pts[i + 1] + pf.pts[i + 3]) / 2;
          lateral = (mx - q.x) * -q.tz + (mz - q.z) * q.tx;
        }
      }
      if (bestP >= 30) {
        for (const f of featureGrid.near(q.x, q.z, 40, near)) {
          if (!f.pole || (name && f.name && f.name !== name)) continue;
          const d = Math.hypot(f.x - q.x, f.z - q.z);
          if (d < bestP) {
            bestP = d;
            lateral = (f.x - q.x) * -q.tz + (f.z - q.z) * q.tx;
          }
        }
      }
      const sd = Math.abs(lateral) > 1 ? Math.sign(lateral) : 0;
      if (sd !== 0) sides++;
      side.push(sd);
    }
    r.sn = names;
    r.ss = side;
  }
  writeFileSync(railFile, gzipSync(JSON.stringify(railDoc), { level: 9 }));
  lap(`tracks: ${named} stops named, ${unnamed} without a name, ${sides} with the side of the platform; ${wired} pieces under an overhead wire, ${bare} without, ${rails.length - wired - bare} unknown`);
}

// ---------------------------------------------------------------- stops.json.gz
{
  const townList = [...new Set(places.map((p) => p.town))];
  const townIx = new Map(townList.map((t, i) => [t, i]));
  const out: StopsJson = { v: 1, towns: townList, places: [], poles: [], platforms: [] };
  places.forEach((p, pi) => {
    out.places.push([p.name, townIx.get(p.town) ?? 0, p.kind, round1(p.x), round1(p.z)]);
    for (const f of p.members) if (f.pole) out.poles.push([pi, round1(f.x), round1(f.z), f.flags | (f.tram ? STOP_FLAG.TRAM : 0) | (f.bus ? STOP_FLAG.BUS : 0) | (f.rail ? STOP_FLAG.RAIL : 0)]);
    for (const pf of p.platforms) out.platforms.push([pi, pf.flags | (pf.closed ? STOP_FLAG.AREA : 0) | (pf.tram ? STOP_FLAG.TRAM : 0) | (pf.bus ? STOP_FLAG.BUS : 0) | (pf.rail ? STOP_FLAG.RAIL : 0), round1(pf.width), pf.pts.map(round1)]);
  });
  const bytes = gzipSync(JSON.stringify(out), { level: 9 });
  writeFileSync(resolve(mapDir, 'stops.json.gz'), bytes);
  lap(`stops.json.gz: ${out.places.length} places, ${out.poles.length} poles, ${out.platforms.length} platforms, ${(bytes.length / 1024).toFixed(0)} KB`);
}

// ---------------------------------------------------------------- air.json.gz: the airfields, from the block extracts
{
  interface Way {
    id: number;
    tags: Tags;
    pts: number[];
    closed: boolean;
  }
  const ways = new Map<number, Way>();
  const fields: Array<{ name: string; icao: string; kind: string; x: number; z: number; ring: number[] | null }> = [];
  const seenField = new Set<string>();
  const blocks = readdirSync(osmDir).filter((f) => /^b_-?\d+_-?\d+\.json\.gz$/.test(f));
  const centre = (pts: number[]): [number, number] => {
    let x = 0;
    let z = 0;
    for (let i = 0; i < pts.length; i += 2) {
      x += pts[i];
      z += pts[i + 1];
    }
    return [x / (pts.length / 2), z / (pts.length / 2)];
  };
  const field = (t: Tags, x: number, z: number, ring: number[] | null): void => {
    const key = `${t.name ?? ''}|${Math.round(x / 500)}|${Math.round(z / 500)}`;
    if (seenField.has(key) || !inWorld(x, z)) return;
    seenField.add(key);
    const type = t['aerodrome:type'] ?? t.aerodrome ?? '';
    fields.push({ name: t.name ?? '', icao: t.icao ?? '', kind: /glid/.test(type) || t.sport === 'gliding' ? 'gliding' : /airport|international|regional|public/.test(type) || t.icao ? 'airport' : 'airfield', x, z, ring });
  };
  blocks.forEach((f, bi) => {
    process.stdout.write(`\r[air] block ${bi + 1} of ${blocks.length}  `);
    const d = OsmData.load(resolve(osmDir, f));
    for (const w of d.ways) {
      const a = w.tags.aeroway;
      if (!a) continue;
      const pts = d.wayCoords(w);
      if (pts.length < 4) continue;
      const closed = w.refs.length > 3 && w.refs[0] === w.refs[w.refs.length - 1];
      if (a === 'aerodrome') {
        const [x, z] = centre(pts);
        field(w.tags, x, z, closed ? pts : null);
        continue;
      }
      if (a !== 'runway' && a !== 'taxiway' && a !== 'apron') continue;
      const old = ways.get(w.id);
      if (!old || old.pts.length < pts.length) ways.set(w.id, { id: w.id, tags: w.tags, pts, closed });
    }
    for (const n of d.nodes.values() as Iterable<ONode>) if (n.tags?.aeroway === 'aerodrome') field(n.tags, n.x, n.z, null);
    for (const r of d.relations) {
      if (r.tags.aeroway !== 'aerodrome') continue;
      const rings = d.multipolygonRings(r).outer;
      if (rings.length === 0) continue;
      const [x, z] = centre(rings[0]);
      field(r.tags, x, z, rings[0]);
    }
  });
  process.stdout.write('\n');
  const out: AirJson = { v: 1, airfields: [] };
  const byField = new Map<number, AirfieldJson>();
  const fieldOf = (x: number, z: number): AirfieldJson | null => {
    let best = -1;
    let bestD = 3000;
    fields.forEach((f, i) => {
      const inside = f.ring ? pointInRing(x, z, f.ring) : false;
      const d = inside ? 0 : Math.hypot(f.x - x, f.z - z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0) return null;
    let a = byField.get(best);
    if (!a) {
      const f = fields[best];
      a = { name: f.name, icao: f.icao, kind: f.kind, x: round1(f.x), z: round1(f.z), runways: [], taxiways: [], aprons: [] };
      byField.set(best, a);
      out.airfields.push(a);
    }
    return a;
  };
  for (const w of ways.values()) {
    const [cx, cz] = centre(w.pts);
    if (!inWorld(cx, cz)) continue;
    const a = fieldOf(cx, cz);
    if (!a) continue;
    const t = w.tags;
    const width = Number.parseFloat(t.width ?? '');
    const surface = t.surface ?? '';
    if (t.aeroway === 'runway') {
      // a line along the middle, or an area: the long axis of its points
      let x1: number;
      let z1: number;
      let x2: number;
      let z2: number;
      let wdt = width;
      if (w.closed) {
        let sxx = 0;
        let szz = 0;
        let sxz = 0;
        const m = w.pts.length / 2;
        for (let i = 0; i < w.pts.length; i += 2) {
          const dx = w.pts[i] - cx;
          const dz = w.pts[i + 1] - cz;
          sxx += dx * dx;
          szz += dz * dz;
          sxz += dx * dz;
        }
        const ang = 0.5 * Math.atan2(2 * sxz / m, (sxx - szz) / m);
        const ux = Math.cos(ang);
        const uz = Math.sin(ang);
        let lo = Infinity;
        let hi = -Infinity;
        let wlo = Infinity;
        let whi = -Infinity;
        for (let i = 0; i < w.pts.length; i += 2) {
          const dx = w.pts[i] - cx;
          const dz = w.pts[i + 1] - cz;
          const along = dx * ux + dz * uz;
          const across = -dx * uz + dz * ux;
          lo = Math.min(lo, along);
          hi = Math.max(hi, along);
          wlo = Math.min(wlo, across);
          whi = Math.max(whi, across);
        }
        x1 = cx + ux * lo;
        z1 = cz + uz * lo;
        x2 = cx + ux * hi;
        z2 = cz + uz * hi;
        if (!(wdt > 0)) wdt = whi - wlo;
      } else {
        x1 = w.pts[0];
        z1 = w.pts[1];
        x2 = w.pts[w.pts.length - 2];
        z2 = w.pts[w.pts.length - 1];
      }
      if (!(wdt > 0)) wdt = /grass|ground|dirt/.test(surface) ? 30 : 23;
      a.runways.push({ ref: t.ref ?? '', x1: round1(x1), z1: round1(z1), x2: round1(x2), z2: round1(z2), w: round1(wdt), s: surface });
    } else if (t.aeroway === 'taxiway' && !w.closed) {
      a.taxiways.push({ w: width > 0 ? round1(width) : /grass|ground/.test(surface) ? 12 : 10, s: surface, p: w.pts.map(round1) });
    } else if (t.aeroway === 'apron' && w.closed) {
      a.aprons.push({ s: surface, p: w.pts.map(round1) });
    }
  }
  // only fields one can take off from: with a runway
  out.airfields = out.airfields.filter((a) => a.runways.length > 0);
  out.airfields.sort((a, b) => Number(b.kind === 'airport') - Number(a.kind === 'airport') || a.name.localeCompare(b.name, 'de'));
  const bytes = gzipSync(JSON.stringify(out), { level: 9 });
  writeFileSync(resolve(mapDir, 'air.json.gz'), bytes);
  lap(`air.json.gz: ${out.airfields.length} airfields – ${out.airfields.map((a) => `${a.name || '?'}${a.icao ? ` (${a.icao})` : ''}: ${a.runways.map((r) => `${r.ref || '?'} ${Math.round(Math.hypot(r.x2 - r.x1, r.z2 - r.z1))}×${r.w} m ${r.s}`).join(', ')}`).join('; ')}`);
}
