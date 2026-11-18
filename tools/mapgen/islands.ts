// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Traffic islands: kerbed, raised a kerb's height above the road, paved (or
 * grass, grass with shrubs, setts, asphalt), with a keep-right sign (Zeichen 222) at
 * the tip that faces traffic which passes the island on both sides.
 *
 * Where they come from:
 *
 * - areas mapped as islands: area:highway=traffic_island, or a closed way of
 *   traffic_calming=island;
 * - points on a two-way road: a crossing with crossing:island=yes (a
 *   Querungshilfe, 5 m long), traffic_calming=island (8 m) – laid along the
 *   middle of the road;
 * - where a road splits into two one-way branches that meet at the same
 *   node (the small splits ahead of a junction): the space between the
 *   branches, up to 80 m from where they meet, unless an area of the map
 *   already lies there or the branches say what lies between them
 *   (median:contents, mapgen/median.ts); only where they part by at least
 *   ISLAND_MIN_GAP (MERGE_NOSE_GAP where they leave a road merged from
 *   them: observed-roads.json "merge", mapgen/waysplit.ts – its nose).
 *
 *   island:surface   grass | plants | paving_stones | cobblestone | asphalt   (OUR OWN key; default
 *                    paving_stones; on the area, the node, or the branch with the smaller way id;
 *                    surface=* of an area is read too)
 *
 * The road model does not widen a road around an island: an island is drawn
 * no closer to a lane's centre line than a vehicle is wide (its corners are
 * pushed back; an island that does not fit is left out).  It is a thing to
 * see, not a wall: the sign posts are what one can hit.
 */
import earcut from 'earcut';
import { newPolySample, pointInRing, ringArea, samplePolyline } from '../../src/core/geom.ts';
import type { LaneGraph, PathFoot } from '../../src/world/lanes.ts';
import { GM } from '../../src/world/tilefmt.ts';
import type { SignPost } from '../../src/world/tilefmt.ts';
import { KERB_H } from '../../src/world/types.ts';
import { newSurfaceHit } from '../../src/world/world.ts';
import type { Edge, World } from '../../src/world/world.ts';
import { addQuad, addTriangles } from './meshacc.ts';
import type { TileSet } from './meshacc.ts';
import { lookAcross } from './median.ts';
import { MERGED_KEY } from './waysplit.ts';
import type { MedianCut } from './median.ts';
import type { OsmData, Tags } from './osm.ts';
import { isClosedWay } from './osm.ts';
import { mix01 } from './parking.ts';
import type { EdgeFeature } from './roads.ts';
import type { TerrainGrid } from './terrain.ts';

/** how far an island keeps from a lane's centre line (m): half a vehicle and a little */
export const ISLAND_CLEAR = 1.1;
/** how far apart (kerb to kerb, m) the branches of a split must get somewhere for an island between them */
export const ISLAND_MIN_GAP = 2.0;
/** … and where they leave a merged road (m) */
export const MERGE_NOSE_GAP = 3.0;

const tmp = newPolySample();

/** The ground material of an island from its tags (island:surface, else surface, else paving stones). */
export function islandMaterial(t: Tags | null | undefined): number {
  const v = t?.['island:surface'] ?? t?.surface ?? '';
  if (/grass/.test(v)) return GM.VERGE;
  if (islandPlanted(t)) return GM.VERGE;
  if (/cobble|sett|unhewn/.test(v)) return GM.SETT;
  if (/asphalt/.test(v)) return GM.ASPHALT_OLD;
  if (/concrete/.test(v)) return GM.CONCRETE;
  return GM.PAVING;
}

/** Is an island planted (island:surface=plants …: low shrubs on grass)? */
export function islandPlanted(t: Tags | null | undefined): boolean {
  return /plant|shrub|flower|bush/.test(t?.['island:surface'] ?? '');
}

/** A ring (flat x, z) with points no further apart than `step` metres. */
export function densifyRing(ring: number[], step: number): number[] {
  const out: number[] = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2];
    const az = ring[i * 2 + 1];
    const k = Math.max(1, Math.ceil(Math.hypot(ring[j * 2] - ax, ring[j * 2 + 1] - az) / step));
    for (let q = 0; q < k; q++) out.push(ax + ((ring[j * 2] - ax) * q) / k, az + ((ring[j * 2 + 1] - az) * q) / k);
  }
  return out;
}

/** Do two sides of the ring cross? */
export function selfCrossing(ring: number[]): boolean {
  const n = ring.length / 2;
  const cross = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  for (let i = 0; i < n; i++) {
    const a = i;
    const b = (i + 1) % n;
    for (let j = i + 2; j < n; j++) {
      const c = j;
      const d = (j + 1) % n;
      if (d === a) continue;
      const [ax, az, bx, bz] = [ring[a * 2], ring[a * 2 + 1], ring[b * 2], ring[b * 2 + 1]];
      const [cx, cz, dx, dz] = [ring[c * 2], ring[c * 2 + 1], ring[d * 2], ring[d * 2 + 1]];
      const d1 = cross(ax, az, bx, bz, cx, cz);
      const d2 = cross(ax, az, bx, bz, dx, dz);
      const d3 = cross(cx, cz, dx, dz, ax, az);
      const d4 = cross(cx, cz, dx, dz, bx, bz);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

/**
 * Push the corners of a ring back from the lanes' centre lines (`dist`: the
 * distance of a point to the nearest one and its foot there, NaN-free) until
 * every corner keeps `clear`.  Null when that cannot be done or leaves too
 * little of it (under 0.8 m²) or a ring that crosses itself.
 */
export function clearOfLanes(ring: number[], dist: (x: number, z: number, foot: PathFoot) => number, clear = ISLAND_CLEAR): number[] | null {
  const out = ring.slice();
  const area0 = ringArea(ring);
  const foot: PathFoot = { x: 0, z: 0, d: 0 };
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let i = 0; i < out.length; i += 2) {
      const d = dist(out[i], out[i + 1], foot);
      if (d >= clear - 1e-3) continue;
      const dx = out[i] - foot.x;
      const dz = out[i + 1] - foot.z;
      const l = Math.hypot(dx, dz);
      if (l < 0.05) return null;
      out[i] = foot.x + (dx / l) * clear;
      out[i + 1] = foot.z + (dz / l) * clear;
      moved = true;
    }
    if (!moved) break;
  }
  // (every corner clear, and no lane running through the middle of it)
  const foot2: PathFoot = { x: 0, z: 0, d: 0 };
  for (let i = 0; i < out.length; i += 2) {
    const d = dist(out[i], out[i + 1], foot2);
    if (d < clear - 0.05) return null;
    if (Number.isFinite(d) && pointInRing(foot2.x, foot2.z, out)) return null;
  }
  const area = ringArea(out);
  if (Math.abs(area) < 0.8 || Math.sign(area) !== Math.sign(area0) || selfCrossing(out)) return null;
  return out;
}

export interface IslandStats {
  mapped: number;
  points: number;
  splits: number;
  dropped: number;
  signs: number;
}

/** The place of a keep-right sign: where traffic meets the island's tip, facing that traffic. */
export interface IslandTip {
  x: number;
  z: number;
  /** the direction of travel there (unit) */
  tx: number;
  tz: number;
}

/**
 * Where traffic of two-way roads meets the island head on: along the line
 * between the two directions of each road near it (and on, 25 m beyond its
 * end, into the junction), the first point inside the island, each way.
 */
export function islandTips(world: World, ring: number[]): IslandTip[] {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]);
    maxX = Math.max(maxX, ring[i]);
    minZ = Math.min(minZ, ring[i + 1]);
    maxZ = Math.max(maxZ, ring[i + 1]);
  }
  const edges = new Set<Edge>();
  world.segmentsInBox(minX - 30, minZ - 30, maxX + 30, maxZ + 30, (e) => {
    if (e.lanesF > 0 && e.lanesB > 0) edges.add(e);
  });
  const tips: IslandTip[] = [];
  const BEYOND = 25;
  for (const e of edges) {
    const oD = -e.width / 2 + e.marginR + e.lanesF * e.laneW;
    const point = (s: number): [number, number, number, number] => {
      const sc = Math.max(0, Math.min(e.len, s));
      samplePolyline(e.pl, sc, tmp);
      const ex = s - sc;
      return [tmp.x + tmp.tz * oD + tmp.tx * ex, tmp.z - tmp.tx * oD + tmp.tz * ex, tmp.tx, tmp.tz];
    };
    for (const dir of [1, -1]) {
      const from = dir > 0 ? e.cutA : e.len - e.cutB;
      const to = dir > 0 ? e.len + BEYOND : -BEYOND;
      let prev = point(from);
      if (pointInRing(prev[0], prev[1], ring)) continue;
      for (let s = from + dir; dir > 0 ? s <= to : s >= to; s += dir) {
        const p = point(s);
        if (pointInRing(p[0], p[1], ring)) {
          tips.push({ x: (p[0] + prev[0]) / 2, z: (p[1] + prev[1]) / 2, tx: p[2] * dir, tz: p[3] * dir });
          break;
        }
        prev = p;
      }
    }
  }
  return tips;
}

interface Ctx {
  world: World;
  ts: TileSet;
  terrain: TerrainGrid;
  lanes: LaneGraph;
  stats: IslandStats;
}

/** Draw one island (its ring already clear of the lanes) and its keep-right signs. */
function drawIsland(c: Ctx, ring: number[], mat: number, planted: boolean): void {
  const { world, ts, terrain } = c;
  const hit = newSurfaceHit();
  const n = ring.length / 2;
  const base = new Float64Array(n * 3);
  const top = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = ring[i * 2];
    const z = ring[i * 2 + 1];
    const g = terrain.at(x, z);
    let yb: number;
    let yt: number;
    if (world.surfaceAt(x, z, g + 2, hit)) {
      // on the carriageway a kerb's height above it; on a pavement level with it
      yb = hit.y;
      yt = hit.zone === 0 ? hit.y + KERB_H : hit.y + 0.005;
    } else if (world.nearestRoad(x, z, 12, 0, hit)) {
      yb = hit.y - 0.3;
      yt = hit.y + KERB_H;
    } else {
      yb = g - 0.3;
      yt = g + KERB_H;
    }
    base.set([x, yb, z], i * 3);
    top.set([x, yt, z], i * 3);
  }
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i * 2] / n;
    cz += ring[i * 2 + 1] / n;
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (top[i * 3 + 1] - base[i * 3 + 1] < 0.01 && top[j * 3 + 1] - base[j * 3 + 1] < 0.01) continue;
    const mx = (ring[i * 2] + ring[j * 2]) / 2 - cx;
    const mz = (ring[i * 2 + 1] + ring[j * 2 + 1]) / 2 - cz;
    addQuad(ts, 'ground', [base[i * 3], base[i * 3 + 1], base[i * 3 + 2], base[j * 3], base[j * 3 + 1], base[j * 3 + 2], top[j * 3], top[j * 3 + 1], top[j * 3 + 2], top[i * 3], top[i * 3 + 1], top[i * 3 + 2]], [GM.KERB], mx, 0, mz);
  }
  addTriangles(ts, 'ground', top, earcut(ring, undefined, 2), [mat]);
  // shrubs on a planted island: one every 6 m² or so, inside it
  if (planted) {
    const area = Math.abs(ringArea(ring));
    const want = Math.max(1, Math.min(12, Math.round(area / 6)));
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]);
      maxX = Math.max(maxX, ring[i]);
      minZ = Math.min(minZ, ring[i + 1]);
      maxZ = Math.max(maxZ, ring[i + 1]);
    }
    let put = 0;
    for (let k = 0; k < want * 6 && put < want; k++) {
      const x = minX + (maxX - minX) * mix01(Math.round(cx * 10), Math.round(cz * 10), k, 1);
      const z = minZ + (maxZ - minZ) * mix01(Math.round(cx * 10), Math.round(cz * 10), k, 2);
      if (!pointInRing(x, z, ring)) continue;
      ts.at(x, z).trees.push(Math.round(x * 10) / 10, Math.round(terrain.at(x, z) * 10) / 10, Math.round(z * 10) / 10, 0.8 + 0.4 * mix01(k, 3), 2);
      put++;
    }
  }
  // the keep-right signs at the tips, 0.5 m into the island
  const posts: SignPost[] = [];
  for (const tip of islandTips(world, ring)) {
    const x = tip.x + tip.tx * 0.5;
    const z = tip.z + tip.tz * 0.5;
    if (!pointInRing(x, z, ring)) continue;
    const yaw = Math.round(Math.atan2(tip.tx, tip.tz) * 1000) / 1000;
    if (posts.some((p) => Math.hypot(p.x - x, p.z - z) < 1.5 && Math.abs(Math.atan2(Math.sin(p.yaw - yaw), Math.cos(p.yaw - yaw))) < 0.6)) continue;
    const g = terrain.at(x, z);
    const y = world.surfaceAt(x, z, g + 2, hit) ? hit.y + (hit.zone === 0 ? KERB_H : 0) : g;
    posts.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100, yaw, s: ['222'], h: 0.6 });
  }
  for (const p of posts) ts.at(p.x, p.z).signs.push(p);
  c.stats.signs += posts.length;
}

/** Make a ring clear of the lanes and draw it; false when it was left out. */
function place(c: Ctx, ring: number[], tags: Tags | null | undefined): boolean {
  const foot: PathFoot = { x: 0, z: 0, d: 0 };
  const hit = newSurfaceHit();
  const dist = (x: number, z: number, out: PathFoot): number => {
    const g = c.terrain.at(x, z);
    const y = c.world.surfaceAt(x, z, g + 2, hit) ? hit.y : g;
    const d = c.lanes.nearestPath(x, z, y, ISLAND_CLEAR + 0.5, foot);
    out.x = foot.x;
    out.z = foot.z;
    return d;
  };
  const clear = clearOfLanes(densifyRing(ring, 2), dist);
  if (!clear) {
    c.stats.dropped++;
    return false;
  }
  drawIsland(c, clear, narrowIslandMaterial(clear, tags), islandPlanted(tags));
  return true;
}

/** the widest island (its mean width, m) that is paved although OpenStreetMap's surface says grass */
export const NARROW_ISLAND = 3.0;

/**
 * The material of an island as drawn: islandMaterial – but a narrow one
 * (mean width under NARROW_ISLAND) that only OpenStreetMap's surface=* calls
 * grass is paved: a strip that narrow beside the lanes is pavers nearly
 * always (our own island:surface, seen on site, is taken as it is).
 */
export function narrowIslandMaterial(ring: number[], tags: Tags | null | undefined): number {
  const m = islandMaterial(tags);
  if (m !== GM.VERGE || tags?.['island:surface'] !== undefined) return m;
  let per = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    per += Math.hypot(ring[j * 2] - ring[i * 2], ring[j * 2 + 1] - ring[i * 2 + 1]);
  }
  const width = per > 0 ? (2 * Math.abs(ringArea(ring))) / per : 0;
  return width < NARROW_ISLAND ? GM.PAVING : m;
}

/** An island in the middle of a two-way road at station `s`: `len` long, pointed at both ends. */
export function pointIslandRing(e: Edge, s: number, len: number, halfW = 1.0): number[] {
  const oD = -e.width / 2 + e.marginR + e.lanesF * e.laneW;
  const taper = Math.min(1.5, len / 3);
  const uv: Array<[number, number]> = [
    [-len / 2, 0],
    [-len / 2 + taper, -halfW],
    [len / 2 - taper, -halfW],
    [len / 2, 0],
    [len / 2 - taper, halfW],
    [-len / 2 + taper, halfW],
  ];
  const ring: number[] = [];
  for (const [ds, o] of uv) {
    samplePolyline(e.pl, s + ds, tmp);
    ring.push(tmp.x + tmp.tz * (oD + o), tmp.z - tmp.tx * (oD + o));
  }
  return ring;
}

/**
 * The ring of a split island between carriageway `e` and the other branch,
 * from the cuts looking across (median.ts): along this one's kerb (or
 * pavement) and back along the other's.
 */
export function splitIslandRing(run: MedianCut[]): number[] {
  const ring: number[] = [];
  for (const c of run) ring.push(c.x + c.nx * c.g0, c.z + c.nz * c.g0);
  for (let i = run.length - 1; i >= 0; i--) {
    const c = run[i];
    ring.push(c.x + c.nx * c.g1, c.z + c.nz * c.g1);
  }
  return ring;
}

/** Do two roads meet at one of their nodes? Returns the station of `e` there (0 or len), or NaN. */
function meetAt(e: Edge, o: Edge): number {
  if (e.a === o.a || e.a === o.b) return 0;
  if (e.b === o.a || e.b === o.b) return e.len;
  return NaN;
}

/** All islands of the block into the tiles. */
export function addIslands(
  osm: OsmData,
  world: World,
  ts: TileSet,
  terrain: TerrainGrid,
  lanes: LaneGraph,
  features: ReadonlyArray<readonly EdgeFeature[] | undefined>,
  inWorld: (x: number, z: number) => boolean,
  /** only the mapped areas (flat x, z) and the roads this says yes to (the detail region – mapgen/detailregion.ts) */
  only?: { area(ring: number[]): boolean; edge(e: Edge): boolean },
): IslandStats {
  const stats: IslandStats = { mapped: 0, points: 0, splits: 0, dropped: 0, signs: 0 };
  const c: Ctx = { world, ts, terrain, lanes, stats };
  // 1. the mapped areas
  const mapped: number[][] = [];
  for (const w of osm.ways) {
    const t = w.tags;
    if (!isClosedWay(w) || !(t['area:highway'] === 'traffic_island' || t.traffic_calming === 'island')) continue;
    const ring = osm.wayCoords(w);
    ring.length -= 2;
    if (ring.length < 6 || !inWorld(ring[0], ring[1])) continue;
    if (only && !only.area(ring)) continue;
    mapped.push(ring);
    if (place(c, ring, t)) stats.mapped++;
  }
  const inMapped = (x: number, z: number): boolean => mapped.some((r) => pointInRing(x, z, r));
  // 2. points on two-way roads
  for (const e of world.edges) {
    if (!e || e.lanesF === 0 || e.lanesB === 0) continue;
    if (only && !only.edge(e)) continue;
    for (const f of features[e.id] ?? []) {
      const crossing = f.kind === 'crossing' && f.tags['crossing:island'] === 'yes';
      const calming = f.tags.traffic_calming === 'island';
      if (!crossing && !calming) continue;
      const len = calming ? 8 : 5;
      if (f.s < e.cutA + len / 2 + 1 || f.s > e.len - e.cutB - len / 2 - 1) continue;
      samplePolyline(e.pl, f.s, tmp);
      if (!inWorld(tmp.x, tmp.z) || inMapped(tmp.x, tmp.z)) continue;
      if (place(c, pointIslandRing(e, f.s, len), f.tags)) stats.points++;
    }
  }
  // 3. between the branches of a road that splits in two one-way ones
  for (const e of world.edges) {
    if (!e || e.median || (e.lanesF > 0 && e.lanesB > 0)) continue;
    if (only && !only.edge(e)) continue;
    const s0 = e.cutA + 0.5;
    const s1 = e.len - e.cutB - 0.5;
    if (s1 - s0 < 4) continue;
    const cuts: Array<MedianCut | null> = [];
    for (let s = s0; s <= s1 + 1e-6; s += 2) cuts.push(lookAcross(world, e, Math.min(s, s1), 14));
    // the stretch next to the node where both branches meet, from there on while the other branch is in sight
    const partners = new Set<Edge>();
    for (const q of cuts) if (q) partners.add(q.partner);
    for (const o of partners) {
      if (o.median || o.osm < e.osm || (o.osm === e.osm && o.id < e.id)) continue;
      const meet = meetAt(e, o);
      if (Number.isNaN(meet)) continue;
      const order = meet === 0 ? cuts : cuts.slice().reverse();
      const run: MedianCut[] = [];
      // (a run that goes on beyond 80 m is the median of a dual road, not an island)
      let long = false;
      for (const q of order) {
        if (!q || q.partner !== o || q.g1 - q.g0 > 14) {
          if (run.length) break;
          continue;
        }
        if (Math.abs(q.s - meet) > 80) {
          long = true;
          break;
        }
        run.push(q);
      }
      if (run.length < 2 || long) continue;
      // (a real split: the branches part by at least ISLAND_MIN_GAP somewhere – not two lines drawn side by side –
      // and not where two carriageways merged into one by observed-roads.json leave it: they lie side by side there)
      // (where carriageways leave a road merged from them (observed-roads.json "merge", mapgen/waysplit.ts) there is
      // a nose too – as where any road splits –, but only where they part clearly: drawn side by side just apart
      // they are one road with a line between them)
      const node = meet === 0 ? e.a : e.b;
      const leavesMerge = node.arms.some((arm) => osm.wayById.get(arm.edge.osm)?.tags[MERGED_KEY] !== undefined);
      if (Math.max(...run.map((q) => q.g1 - q.g0)) < (leavesMerge ? MERGE_NOSE_GAP : ISLAND_MIN_GAP)) continue;
      // nothing else lies between them
      const hit = newSurfaceHit();
      const between = run.some((q) => {
        const d = (q.g0 + q.g1) / 2;
        const x = q.x + q.nx * d;
        const z = q.z + q.nz * d;
        // (the merged road the branches leave reaches in between them at its end: not something else lying there)
        if (inMapped(x, z)) return true;
        if (!world.surfaceAt(x, z, q.y0 + 2, hit) || hit.node) return false;
        return !(hit.edge === e || hit.edge === o || (leavesMerge && node.arms.some((a) => a.edge === hit.edge)));
      });
      if (between) continue;
      const ring = splitIslandRing(run);
      if (!inWorld(ring[0], ring[1])) continue;
      const way = osm.wayById.get(e.osm) ?? osm.wayById.get(o.osm);
      if (place(c, ring, way ? { 'island:surface': way.tags['island:surface'] ?? 'paving_stones' } : null)) stats.splits++;
    }
  }
  return stats;
}
