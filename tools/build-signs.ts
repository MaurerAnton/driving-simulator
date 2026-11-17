// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The signs a built map lacks (signs.json.gz): what tools/mapgen/signs.ts
 * puts up now that the map build did not when the map was made, and the
 * rules of the signs that hold only at certain times.
 *
 *   node --max-old-space-size=1536 tools/build-signs.ts [path/to/hessen-latest.osm.pbf]
 *
 * Needs the map built (MAP_OUT, default public/map): map.json, the chunks of
 * the road network (w/*.json.gz, where every road names the way of
 * OpenStreetMap it was made of) and the tiles (tiles/*.fsb – the posts they
 * carry already).  Reads OpenStreetMap from the PBF in three passes: the
 * nodes with a traffic sign and the boundaries of the municipalities, then
 * the ways (the roads of the map, what holds on them at times, which signs
 * stand on them; the ways of the boundaries), then the nodes of the
 * boundaries.  Writes signs.json.gz there (ExtraSignsJson,
 * src/world/extrasigns.ts) – a file of its own beside the map, as the
 * timetables are (tools/fetch-map.ts EXTRA); the game works without it.
 *
 * What it adds, each post placed beside its road as the map build places
 * them (tools/mapgen/signs.ts postBeside):
 *  - the signs mapped as nodes of their own beside the road (the map build
 *    takes only those on the road), and on the road those it dropped or cut
 *    short – each sign once: where the tile has a post with the same plates
 *    there already nothing is added, where it has fewer (no plate with the
 *    time) the tile's post gets the full set;
 *  - for every condition of a road with a time on it – maxspeed:conditional
 *    "30 @ (22:00-06:00)", a road shut at night, a night-time limit or ban
 *    for lorries – the sign with its time panel where the condition begins,
 *    and the rule itself for the game (TimedRuleJson);
 *  - the town signs (Zeichen 310/311) that are missing: those mapped beside
 *    the road, and wherever the road changes between inside and outside a
 *    built-up area – at junctions and on small roads too (townsigns.ts) –,
 *    unless the tile has one for the same traffic near by.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { makePolyline, newPolySample, pointInRing, projectOnPolyline, samplePolyline } from '../src/core/geom.ts';
import type { PolyProjection, Polyline3 } from '../src/core/geom.ts';
import { latLonToWorld, worldToLatLon } from '../src/geo/utm.ts';
import { windowSpec } from '../src/sim/signtime.ts';
import type { ExtraPost, ExtraSignsJson, TimedRuleJson } from '../src/world/extrasigns.ts';
import { TILE, gridIndex } from '../src/world/grid.ts';
import type { SignPost } from '../src/world/tilefmt.ts';
import { CLASS_TIER, CLS, EF } from '../src/world/types.ts';
import type { MapIndexJson, PlaceJson, WorldChunkJson } from '../src/world/types.ts';
import { edgePoints } from '../src/world/world.ts';
import { OsmData } from './mapgen/osm.ts';
import type { ORelation } from './mapgen/osm.ts';
import { CONDITIONAL, mappedSignPosts, postBeside, timedSigns } from './mapgen/signs.ts';
import type { TimedSign } from './mapgen/signs.ts';
import { townSignNear, townSignsAt } from './mapgen/townsigns.ts';
import type { TownArm, TownSignSpot } from './mapgen/townsigns.ts';
import { readPbf } from './osm/pbf.ts';
import type { Tags } from './osm/pbf.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------ the road network of the map

/** A road of the map, as much of it as the signs need. */
interface Road {
  id: number;
  a: number;
  b: number;
  cls: number;
  flags: number;
  zone: number;
  lanesF: number;
  lanesB: number;
  width: number;
  swL: number;
  swR: number;
  cutA: number;
  cutB: number;
  osm: number;
  pl: Polyline3;
  len: number;
}

interface Junction {
  id: number;
  x: number;
  z: number;
  /** its roads, in the order of its arms */
  roads: number[];
}

/** An arm: a road at one of its ends. */
interface ArmRef {
  road: Road;
  /** the road leaves the junction (the junction is its end a) */
  out: boolean;
}

const tmp = newPolySample();
const proj: PolyProjection = { s: 0, off: 0, d2: 0, seg: 0 };

/** Station and travel direction for traffic leaving the junction on this arm, `d` metres from it. */
const depart = (arm: ArmRef, d: number): [number, number] => (arm.out ? [d, 1] : [arm.road.len - d, -1]);
/** … and for traffic coming to the junction on it. */
const approach = (arm: ArmRef, d: number): [number, number] => (arm.out ? [d, -1] : [arm.road.len - d, 1]);
const cutOf = (arm: ArmRef): number => (arm.out ? arm.road.cutA : arm.road.cutB);
const isApproach = (arm: ArmRef): boolean => (arm.out ? arm.road.lanesB > 0 : arm.road.lanesF > 0);
const isExit = (arm: ArmRef): boolean => (arm.out ? arm.road.lanesF > 0 : arm.road.lanesB > 0);

/** The height of a road's centre line at station `s`. */
function roadY(road: Road, s: number): number {
  samplePolyline(road.pl, s, tmp);
  return tmp.y;
}

class Network {
  readonly roads = new Map<number, Road>();
  readonly junctions = new Map<number, Junction>();
  /** OpenStreetMap way → the roads made of it */
  readonly byWay = new Map<number, number[]>();
  private readonly grid = new Map<number, number[]>();
  private static readonly CELL = 100;

  constructor(mapDir: string) {
    for (const f of readdirSync(resolve(mapDir, 'w'))) {
      if (!f.endsWith('.json.gz')) continue;
      const chunk = JSON.parse(gunzipSync(readFileSync(resolve(mapDir, 'w', f))).toString('utf8')) as WorldChunkJson;
      for (const [id, n] of chunk.nodes) {
        if (!this.junctions.has(id)) this.junctions.set(id, { id, x: n.x, z: n.z, roads: n.arms.map((a) => a.e) });
      }
      for (const [id, e] of chunk.edges) {
        if (this.roads.has(id)) continue;
        const p = e.q ? edgePoints(e.q) : e.p;
        const pl = makePolyline(Float32Array.from(p));
        this.roads.set(id, {
          id,
          a: e.a,
          b: e.b,
          cls: e.c,
          flags: e.f,
          zone: e.z ?? 0,
          lanesF: e.lf,
          lanesB: e.lb,
          width: e.w,
          swL: e.sl ?? 0,
          swR: e.sr ?? 0,
          cutA: e.ca,
          cutB: e.cb,
          osm: e.o ?? 0,
          pl,
          len: pl.len,
        });
      }
    }
    for (const r of this.roads.values()) {
      if (r.osm > 0) {
        const list = this.byWay.get(r.osm);
        if (list) list.push(r.id);
        else this.byWay.set(r.osm, [r.id]);
      }
      // the squares its course passes through
      const pts = r.pl.pts;
      const cells = new Set<number>();
      for (let i = 0; i < pts.length; i += 3) cells.add(this.key(pts[i], pts[i + 2]));
      for (let i = 3; i < pts.length; i += 3) cells.add(this.key((pts[i] + pts[i - 3]) / 2, (pts[i + 2] + pts[i - 1]) / 2));
      for (const c of cells) {
        const list = this.grid.get(c);
        if (list) list.push(r.id);
        else this.grid.set(c, [r.id]);
      }
    }
  }

  private key(x: number, z: number): number {
    return (Math.floor(x / Network.CELL) + 20000) * 40000 + Math.floor(z / Network.CELL) + 20000;
  }

  /** The arms of a junction (roads both of whose ends lie there count twice). */
  arms(j: Junction): ArmRef[] {
    const out: ArmRef[] = [];
    const seen = new Map<number, number>();
    for (const id of j.roads) {
      const road = this.roads.get(id);
      if (!road) continue;
      const k = seen.get(id) ?? 0;
      seen.set(id, k + 1);
      out.push({ road, out: road.a === j.id && (road.b !== j.id || k === 0) });
    }
    return out;
  }

  /** The road nearest to (x, z) within `reach` metres – one of the network proper preferred over a yard or a track three metres nearer – and where on it. */
  nearest(x: number, z: number, reach: number, only?: readonly number[]): { road: Road; s: number; off: number; d: number } | null {
    let best: { road: Road; s: number; off: number; d: number } | null = null;
    let bestScore = Infinity;
    const ids = only ?? this.around(x, z);
    for (const id of ids) {
      const road = this.roads.get(id);
      if (!road) continue;
      projectOnPolyline(road.pl, x, z, proj);
      const d = Math.sqrt(proj.d2);
      if (d > reach) continue;
      const score = d - (CLASS_TIER[road.cls] >= 2 ? 3 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = { road, s: proj.s, off: proj.off, d };
      }
    }
    return best;
  }

  private around(x: number, z: number): number[] {
    const out = new Set<number>();
    const ix = Math.floor(x / Network.CELL);
    const iz = Math.floor(z / Network.CELL);
    for (let i = ix - 1; i <= ix + 1; i++) {
      for (let j = iz - 1; j <= iz + 1; j++) for (const id of this.grid.get((i + 20000) * 40000 + j + 20000) ?? []) out.add(id);
    }
    return [...out];
  }

  /**
   * How built-up the way ahead is from station `s` of `road` in direction
   * `dir`: of three points 30, 70 and 120 m on (along the road and straight
   * on through the junctions after it), how many lie on roads inside a
   * built-up area.
   */
  urbanAhead(road: Road, s: number, dir: number): number {
    let votes = 0;
    for (const want of [30, 70, 120]) {
      let r = road;
      let pos = s;
      let d = dir;
      let left = want;
      for (let hop = 0; hop < 8; hop++) {
        const room = d > 0 ? r.len - pos : pos;
        if (left <= room) {
          if (r.flags & EF.URBAN) votes++;
          break;
        }
        left -= room;
        const j = this.junctions.get(d > 0 ? r.b : r.a);
        if (!j) break;
        // on along the straightest of the other roads
        samplePolyline(r.pl, d > 0 ? r.len : 0, tmp);
        const tx = tmp.tx * d;
        const tz = tmp.tz * d;
        let next: ArmRef | null = null;
        let bestAlign = 0.3;
        for (const arm of this.arms(j)) {
          if (arm.road === r) continue;
          samplePolyline(arm.road.pl, arm.out ? 0 : arm.road.len, tmp);
          const ax = arm.out ? tmp.tx : -tmp.tx;
          const az = arm.out ? tmp.tz : -tmp.tz;
          const align = ax * tx + az * tz;
          if (align > bestAlign) {
            bestAlign = align;
            next = arm;
          }
        }
        if (!next) break;
        r = next.road;
        pos = next.out ? 0 : r.len;
        d = next.out ? 1 : -1;
      }
    }
    return votes;
  }
}

// ------------------------------------------------------------------ the posts there are, and those added

/** A post of the map's tiles, or one added here. */
interface Post {
  sp: SignPost;
  key: string;
  /** one of the tile's own posts (else one added here) */
  own: boolean;
  /** a post of the tile whose plates are to be replaced */
  changed: boolean;
}

const tileKeyOf = (x: number, z: number): string => `${gridIndex(x, TILE)}_${gridIndex(z, TILE)}`;
const baseOf = (code: string): string => {
  const i = code.indexOf(':');
  return i < 0 ? code : code.slice(0, i);
};
const turnBetween = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

class Posts {
  readonly list: Post[] = [];
  private readonly grid = new Map<number, number[]>();
  private readonly town = new Map<number, TownSignSpot[]>();
  readonly count = { added: 0, completed: 0, already: 0, merged: 0 };

  private key(x: number, z: number, cell: number): number {
    return (Math.floor(x / cell) + 200000) * 400000 + Math.floor(z / cell) + 200000;
  }

  private index(i: number): void {
    const p = this.list[i].sp;
    const k = this.key(p.x, p.z, 10);
    const l = this.grid.get(k);
    if (l) l.push(i);
    else this.grid.set(k, [i]);
    this.townSpots(p, p.s);
  }

  /** the town signs among `codes`, standing where `p` stands */
  private townSpots(p: SignPost, codes: readonly string[]): void {
    for (const c of codes) {
      const b = baseOf(c);
      if (b !== '310' && b !== '311') continue;
      const tk = this.key(p.x, p.z, 200);
      const spot: TownSignSpot = { kind: b === '310' ? 'enter' : 'leave', x: p.x, z: p.z, yaw: p.yaw };
      const tl = this.town.get(tk);
      if (tl) tl.push(spot);
      else this.town.set(tk, [spot]);
    }
  }

  /** a post the tile has */
  own(sp: SignPost, key: string): void {
    this.list.push({ sp, key, own: true, changed: false });
    this.index(this.list.length - 1);
  }

  /** the posts within `r` metres of (x, z) */
  private near(x: number, z: number, r: number): number[] {
    const out: number[] = [];
    for (let i = Math.floor((x - r) / 10); i <= Math.floor((x + r) / 10); i++) {
      for (let j = Math.floor((z - r) / 10); j <= Math.floor((z + r) / 10); j++) {
        for (const k of this.grid.get((i + 200000) * 400000 + j + 200000) ?? []) {
          const p = this.list[k].sp;
          if (Math.hypot(p.x - x, p.z - z) <= r) out.push(k);
        }
      }
    }
    return out;
  }

  /** Is there a town sign for the same traffic near by (townsigns.ts)? */
  townNear(spot: TownSignSpot): boolean {
    const out: TownSignSpot[] = [];
    for (let i = Math.floor(spot.x / 200) - 1; i <= Math.floor(spot.x / 200) + 1; i++) {
      for (let j = Math.floor(spot.z / 200) - 1; j <= Math.floor(spot.z / 200) + 1; j++) out.push(...(this.town.get((i + 200000) * 400000 + j + 200000) ?? []));
    }
    return townSignNear(out, spot);
  }

  /** Is there a post within `r` metres of where `sp` would stand, facing the same way? */
  occupied(sp: SignPost, r = 3): boolean {
    return this.near(sp.x, sp.z, r).some((k) => turnBetween(this.list[k].sp.yaw, sp.yaw) <= 0.9);
  }

  /**
   * A post to stand at `sp`: nothing where a post there (within 6 m, facing
   * the same way) has its plates already; that post's plates completed where
   * it has some of them (the plate with the time, a value); merged into a
   * post within 2.5 m that has room; else a post of its own.  A town sign
   * (`alone`) is never put onto another post, nor another plate onto it.
   */
  add(sp: SignPost, alone = false): void {
    let closest = -1;
    let closestD = Infinity;
    for (const k of this.near(sp.x, sp.z, 6)) {
      const p = this.list[k].sp;
      if (turnBetween(p.yaw, sp.yaw) > 0.9) continue;
      const d = Math.hypot(p.x - sp.x, p.z - sp.z);
      if (sp.s.every((c) => p.s.includes(c))) {
        this.count.already++;
        return;
      }
      if (alone || p.s.some((c) => /^31[01]:/.test(c))) continue;
      const shared = sp.s.some((c) => p.s.some((o) => baseOf(o) === baseOf(c)));
      if (shared) {
        // the post there shows some of these plates: it gets the full set (the richer code of a plate in its place)
        const merged = p.s.map((o) => sp.s.find((c) => baseOf(c) === baseOf(o)) ?? o);
        for (const c of sp.s) if (!merged.some((o) => baseOf(o) === baseOf(c)) && merged.length < 4) merged.push(c);
        if (merged.join(';') === p.s.join(';')) {
          this.count.already++;
          return;
        }
        p.s = merged;
        this.mark(k);
        this.townSpots(p, sp.s);
        this.count.completed++;
        return;
      }
      if (d < closestD) {
        closestD = d;
        closest = k;
      }
    }
    if (!alone && closest >= 0 && closestD < 2.5 && this.list[closest].sp.s.length + sp.s.length <= 4) {
      const p = this.list[closest].sp;
      p.s.push(...sp.s);
      this.mark(closest);
      this.townSpots(p, sp.s);
      this.count.merged++;
      return;
    }
    this.list.push({ sp, key: tileKeyOf(sp.x, sp.z), own: false, changed: false });
    this.index(this.list.length - 1);
    this.count.added++;
  }

  private mark(k: number): void {
    if (this.list[k].own) this.list[k].changed = true;
  }

  /** The posts added and changed, by tile. */
  out(): Record<string, ExtraPost[]> {
    const tiles: Record<string, ExtraPost[]> = {};
    for (const p of this.list) {
      if (p.own && !p.changed) continue;
      const e: ExtraPost = { ...p.sp, s: p.sp.s.slice() };
      if (p.own) e.r = 1;
      (tiles[p.key] ??= []).push(e);
    }
    return tiles;
  }
}

/** The posts the map's tiles carry. */
function readTilePosts(mapDir: string, posts: Posts): number {
  let n = 0;
  for (const f of readdirSync(resolve(mapDir, 'tiles'))) {
    if (!f.endsWith('.fsb')) continue;
    let b = readFileSync(resolve(mapDir, 'tiles', f));
    if (b[0] === 0x1f && b[1] === 0x8b) b = gunzipSync(b);
    const len = b.readUInt32LE(4);
    const h = JSON.parse(b.subarray(8, 8 + len).toString('utf8')) as { signs?: SignPost[] };
    const key = f.slice(0, -4);
    for (const sp of h.signs ?? []) {
      posts.own(sp, key);
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------ OpenStreetMap

interface SignNode {
  id: number;
  x: number;
  z: number;
  tags: Tags;
  /** the map's ways it is a node of */
  ways: number[];
}

interface OsmRead {
  signs: Map<number, SignNode>;
  /** the map's ways that carry something here: their tags, and whether the map's roads run against them (oneway=-1) */
  ways: Map<number, { tags: Tags; reversed: boolean }>;
  boundaries: OsmData;
}

function readOsm(input: string, net: Network, bounds: { minX: number; maxX: number; minZ: number; maxZ: number }, lap: (m: string) => void): OsmRead {
  const corners = [
    worldToLatLon(bounds.minX, bounds.minZ),
    worldToLatLon(bounds.maxX, bounds.minZ),
    worldToLatLon(bounds.minX, bounds.maxZ),
    worldToLatLon(bounds.maxX, bounds.maxZ),
  ];
  const minLat = Math.min(...corners.map((c) => c[0]));
  const maxLat = Math.max(...corners.map((c) => c[0]));
  const minLon = Math.min(...corners.map((c) => c[1]));
  const maxLon = Math.max(...corners.map((c) => c[1]));
  const signs = new Map<number, SignNode>();
  const boundaries = new OsmData();
  readPbf(input, {
    node(id, lat, lon, tags) {
      if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) return;
      const t = tags();
      if (!t || !(t.traffic_sign || t['traffic_sign:forward'] || t['traffic_sign:backward'])) return;
      const [x, z] = latLonToWorld(lat, lon);
      signs.set(id, { id, x, z, tags: t, ways: [] });
    },
    relation(id, members, tags) {
      const t = tags();
      if (t.boundary !== 'administrative' || !t.name || (t.admin_level !== '6' && t.admin_level !== '8')) return;
      boundaries.relations.push({ id, members: members(), tags: t } as ORelation);
    },
  });
  lap(`${signs.size} nodes with a traffic sign in the region of the map, ${boundaries.relations.length} boundaries of municipalities and districts`);

  const wantWays = new Set<number>();
  for (const r of boundaries.relations) for (const m of r.members) if (m.type === 'w') wantWays.add(m.ref);
  const ways = new Map<number, { tags: Tags; reversed: boolean }>();
  let vertices = 0;
  readPbf(input, {
    way(id, refs, tags) {
      if (wantWays.has(id)) boundaries.wayById.set(id, { id, refs, tags: {} });
      if (!net.byWay.has(id)) return;
      let onIt = false;
      for (const r of refs) {
        const s = signs.get(r);
        if (s) {
          s.ways.push(id);
          onIt = true;
          vertices++;
        }
      }
      const t = tags();
      let conditional = false;
      for (const k in t) if (CONDITIONAL.test(k)) conditional = true;
      if (onIt || conditional) ways.set(id, { tags: t, reversed: t.oneway === '-1' || t.oneway === 'reverse' });
    },
  });
  lap(`${ways.size} ways of the map with a sign on them or a condition with a time; ${vertices} sign nodes on them; ${boundaries.wayById.size} ways of the boundaries`);

  const wantNodes = new Set<number>();
  for (const w of boundaries.wayById.values()) for (const r of w.refs) wantNodes.add(r);
  readPbf(input, {
    node(id, lat, lon) {
      if (!wantNodes.has(id)) return;
      const [x, z] = latLonToWorld(lat, lon);
      boundaries.nodes.set(id, { id, x, z, tags: null });
    },
  });
  lap(`${boundaries.nodes.size} nodes of the boundaries`);
  return { signs, ways, boundaries };
}

// ------------------------------------------------------------------ town names

interface Area {
  name: string;
  sign: string;
  rings: number[][];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The municipalities (and the district each lies in, for the second line of its signs), as tools/build-graph.ts finds them. */
function municipalities(osm: OsmData): Area[] {
  const area = (name: string, rings: number[][]): Area => {
    const a: Area = { name, sign: '', rings, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 2) {
        a.minX = Math.min(a.minX, ring[i]);
        a.maxX = Math.max(a.maxX, ring[i]);
        a.minZ = Math.min(a.minZ, ring[i + 1]);
        a.maxZ = Math.max(a.maxZ, ring[i + 1]);
      }
    }
    return a;
  };
  const districts: Area[] = [];
  const towns: Area[] = [];
  for (const rel of osm.relations) {
    const rings = osm.multipolygonRings(rel).outer;
    if (rings.length === 0) continue;
    const level = rel.tags.admin_level;
    if (level === '6' && /kreis/i.test(rel.tags.name)) districts.push(area(rel.tags.name, rings));
    else {
      const t = area(rel.tags.name, rings);
      t.sign = level === '6' ? (rel.tags.name === 'Kassel' ? 'documenta-Stadt' : '') : '';
      towns.push(t);
    }
  }
  for (const m of towns) {
    if (m.sign) continue;
    const x = m.rings[0][0];
    const z = m.rings[0][1];
    const d = districts.find((k) => x >= k.minX - 50 && x <= k.maxX + 50 && z >= k.minZ - 50 && z <= k.maxZ + 50 && (inside(k, x, z) || inside(k, (m.minX + m.maxX) / 2, (m.minZ + m.maxZ) / 2)));
    m.sign = d ? d.name.replace(/^Landkreis /, 'Kreis ') : '';
  }
  return towns;
}

function inside(a: Area, x: number, z: number): boolean {
  if (x < a.minX || x > a.maxX || z < a.minZ || z > a.maxZ) return false;
  let inn = false;
  for (const ring of a.rings) if (pointInRing(x, z, ring)) inn = !inn;
  return inn;
}

/** The two lines of the town signs at (x, z), as tools/mapgen/signs.ts writes them. */
function townName(towns: Area[], places: PlaceJson[], x: number, z: number, name: string): { enter: string; leave: string } {
  const m = towns.find((t) => inside(t, x, z)) ?? null;
  let label = name;
  if (!label) {
    let bd = 2600;
    for (const p of places) {
      if (!['suburb', 'village', 'town', 'hamlet', 'neighbourhood'].includes(p.kind)) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) {
        bd = d;
        label = p.name;
      }
    }
  }
  label ||= m?.name ?? 'Baunatal';
  const town = !m ? `${label}|Kreis Kassel` : label === m.name ? `${m.name}|${m.sign}` : `${label}|Stadt ${m.name}`;
  return { enter: `310:${town}`, leave: `311:${label}` };
}

// ------------------------------------------------------------------ the build

/** The post for traffic going `dir` along `road` at station `s` (on the driver's right, or left with `side` −1). */
function postOn(road: Road, s: number, dir: number, codes: string[], side = 1): SignPost {
  return postBeside(road, s, dir, codes, (at) => roadY(road, at), side);
}

export function buildSigns(mapDir: string, input: string, lap: (msg: string) => void): void {
  const index = JSON.parse(readFileSync(resolve(mapDir, 'map.json'), 'utf8')) as MapIndexJson;
  const net = new Network(mapDir);
  lap(`road network: ${net.roads.size} roads, ${net.junctions.size} junctions`);
  const posts = new Posts();
  const own = readTilePosts(mapDir, posts);
  lap(`${own} posts in the tiles`);
  const osm = readOsm(input, net, index.meta, lap);
  const towns = municipalities(osm.boundaries);
  lap(`${towns.length} municipalities`);
  const rules: TimedRuleJson[] = [];
  const stats = { mapped: 0, mappedOff: 0, townMapped: 0, townDerived: 0, timed: 0, timedPosts: 0 };

  // ---- the town signs mapped in OpenStreetMap
  /** A town sign at station `s` for traffic going `dir` – on a post of its own: where one stands there, moved on `away` (+1 with the traffic, −1 against it), away from the junction. */
  const townSign = (road: Road, s: number, dir: number, kind: 'enter' | 'leave', name: string, away = 1): boolean => {
    let probe = postOn(road, s, dir, []);
    const spot: TownSignSpot = { kind, x: probe.x, z: probe.z, yaw: probe.yaw };
    if (posts.townNear(spot)) return false;
    for (const ds of [6, 12, 18]) {
      if (!posts.occupied(probe)) break;
      const at = s + away * dir * ds;
      if (at < 1 || at > road.len - 1) break;
      probe = postOn(road, at, dir, []);
    }
    const n = townName(towns, index.places, probe.x, probe.z, name);
    probe.s = [kind === 'enter' ? n.enter : n.leave];
    posts.add(probe, true);
    return true;
  };
  for (const node of osm.signs.values()) {
    if (node.tags.traffic_sign !== 'city_limit') continue;
    const hit = net.nearest(node.x, node.z, node.ways.length > 0 ? 6 : 25, node.ways.length > 0 ? node.ways.flatMap((w) => net.byWay.get(w) ?? []) : undefined);
    if (!hit) continue;
    const enter = net.urbanAhead(hit.road, hit.s, 1) >= net.urbanAhead(hit.road, hit.s, -1) ? 1 : -1;
    const name = (node.tags.name ?? '').trim();
    if (townSign(hit.road, hit.s, enter, 'enter', name)) stats.townMapped++;
    if (hit.road.lanesF > 0 && hit.road.lanesB > 0 && townSign(hit.road, hit.s, -enter, 'leave', name)) stats.townMapped++;
  }
  lap(`${stats.townMapped} town signs mapped in OpenStreetMap that the tiles lack`);

  // ---- the other signs mapped in OpenStreetMap
  for (const node of osm.signs.values()) {
    const t = node.tags;
    if (t.traffic_sign === 'city_limit') continue;
    const onWay = node.ways.length > 0;
    const hit = net.nearest(node.x, node.z, onWay ? 6 : 15, onWay ? node.ways.flatMap((w) => net.byWay.get(w) ?? []) : undefined);
    if (!hit) {
      stats.mappedOff++;
      continue;
    }
    const road = hit.road;
    samplePolyline(road.pl, hit.s, tmp);
    const at = {
      onWay,
      wayDir: osm.ways.get(road.osm)?.reversed ? -1 : 1,
      s: hit.s,
      tx: tmp.tx,
      tz: tmp.tz,
      off: hit.off,
      road,
      junctionA: (net.junctions.get(road.a)?.roads.length ?? 0) > 2,
      junctionB: (net.junctions.get(road.b)?.roads.length ?? 0) > 2,
    };
    for (const p of mappedSignPosts(t, at)) {
      posts.add(postOn(road, hit.s, p.dir, p.codes, p.side));
      stats.mapped++;
    }
  }
  lap(`${stats.mapped} mapped signs placed (${stats.mappedOff} lie further than 15 m from any road of the map)`);

  // ---- what holds on a road at times: the rules, and their signs where they begin
  interface Timed {
    road: Road;
    dir: number;
    sign: TimedSign;
  }
  const timed: Timed[] = [];
  const timedAt = new Map<string, Timed[]>();
  for (const [wayId, w] of osm.ways) {
    const roads = net.byWay.get(wayId) ?? [];
    for (const sign of timedSigns(w.tags)) {
      const wayDir = w.reversed ? -1 : 1;
      for (const id of roads) {
        const road = net.roads.get(id)!;
        for (const dir of sign.along !== 0 ? [sign.along * wayDir] : [1, -1]) {
          if ((dir > 0 ? road.lanesF : road.lanesB) === 0) continue;
          const t: Timed = { road, dir, sign };
          timed.push(t);
          const key = `${road.id}|${dir}`;
          const l = timedAt.get(key);
          if (l) l.push(t);
          else timedAt.set(key, [t]);
        }
        const k = sign.kind;
        if (k !== 'overtake') rules.push({ e: road.id, d: sign.along * wayDir, k, ...(sign.value > 0 ? { v: sign.value } : {}), w: sign.when === 'wet' ? 'wet' : windowSpec(sign.when) });
      }
    }
  }
  // (the same rule twice for one road – two tags saying the same – once)
  const seenRule = new Set<string>();
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    const key = `${r.e}|${r.d}|${r.k}|${r.v ?? ''}|${r.w}`;
    if (seenRule.has(key)) rules.splice(i, 1);
    else seenRule.add(key);
  }
  stats.timed = rules.length;
  for (const t of timed) {
    // where it begins: the road it comes from (at a joint of two sections) has the same – then no sign; after a junction it is repeated
    const from = net.junctions.get(t.dir > 0 ? t.road.a : t.road.b);
    if (!from) continue;
    const arms = net.arms(from);
    if (arms.length <= 2) {
      const prev = arms.find((a) => a.road !== t.road);
      if (prev) {
        const prevDir = prev.out ? -1 : 1;
        if ((timedAt.get(`${prev.road.id}|${prevDir}`) ?? []).some((o) => o.sign.same === t.sign.same)) continue;
      }
    } else if (t.road.len < 40) continue;
    const arm: ArmRef = { road: t.road, out: t.dir > 0 };
    const [s, dir] = depart(arm, Math.min(t.road.len * 0.5, cutOf(arm) + (t.road.flags & EF.URBAN ? 12 : 30)));
    posts.add(postOn(t.road, s, dir, t.sign.codes));
    stats.timedPosts++;
  }
  lap(`${stats.timed} rules of signs with a time (${new Set(rules.map((r) => r.e)).size} roads), ${stats.timedPosts} signs where they begin`);

  // ---- the town signs wherever the road changes between inside and outside a built-up area
  for (const j of net.junctions.values()) {
    if (j.roads.length < 2) continue;
    const arms = net.arms(j);
    if (arms.length < 2 || arms.some((a) => a.road.a === a.road.b)) continue;
    const townArms: TownArm[] = arms.map((a) => ({
      urban: (a.road.flags & EF.URBAN) !== 0,
      counts: CLASS_TIER[a.road.cls] >= 2 && a.road.cls > CLS.TRUNK_LINK && a.road.zone !== 7,
      signable: !(a.road.flags & (EF.ROUNDABOUT | EF.LINK)) && a.road.len > 8,
      approach: isApproach(a),
      exit: isExit(a),
    }));
    for (const t of townSignsAt(townArms)) {
      const arm = arms[t.arm];
      const d = arms.length > 2 ? Math.min(cutOf(arm) + 4, arm.road.len * 0.5) : Math.min(4, arm.road.len * 0.3);
      const [s, dir] = t.side === 'away' ? depart(arm, d) : approach(arm, d);
      // (beyond the junction moved on with the traffic, before it against the traffic: away from it)
      if (townSign(arm.road, s, dir, t.kind, '', t.side === 'away' ? 1 : -1)) stats.townDerived++;
    }
  }
  lap(`${stats.townDerived} town signs where the road changes between inside and outside a built-up area`);

  const tiles = posts.out();
  const out: ExtraSignsJson = { v: 1, map: index.meta.generated, tiles, rules };
  const bytes = gzipSync(JSON.stringify(out), { level: 9 });
  writeFileSync(resolve(mapDir, 'signs.json.gz'), bytes);
  const n = Object.values(tiles).reduce((a, l) => a + l.length, 0);
  lap(
    `signs.json.gz: ${n} posts in ${Object.keys(tiles).length} tiles (${posts.count.added} new, ${posts.count.completed} of the tiles' completed, ${posts.count.merged} plates put onto a post near by, ` +
      `${posts.count.already} there already), ${rules.length} rules – ${(bytes.length / 1024).toFixed(0)} KB`,
  );
}

if (import.meta.main) {
  const input = resolve(root, process.argv[2] ?? 'data/raw/osm/hessen-latest.osm.pbf');
  const mapDir = resolve(root, process.env.MAP_OUT ?? 'public/map');
  const t0 = Date.now();
  const lap = (msg: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);
  buildSigns(mapDir, input, lap);
}
