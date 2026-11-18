// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What stands along a street beyond its kerb and in its parking strips:
 *
 * - kerbed tree bulbs (Baumscheiben) in place of a parking bay – every n
 *   metres where a side says parking:<side>:trees=<n> (our own key), and
 *   wherever OpenStreetMap has a natural=tree standing in a parking strip;
 * - the hedge, fence or wall right behind the pavement, or a lawn there
 *   (frontage:<side>=hedge|fence|wall|lawn, our own key) where OpenStreetMap
 *   has none mapped;
 * - young trees in a verge that says so (verge:<side>=…;trees);
 * - which mapped fences are drawn at all, and at what height the mapped
 *   barriers stand (objects.ts).
 *
 * The keys are read in tools/mapgen/xsection.ts and stored with each side of
 * a road (src/world/xsection.ts: RoadSideJson pt, ft, fh, vt).
 */
import { newPolySample, projectOnPolyline, samplePolyline } from '../../src/core/geom.ts';
import type { PolyProjection } from '../../src/core/geom.ts';
import { COVER } from '../../src/world/cover.ts';
import { GM } from '../../src/world/tilefmt.ts';
import { KERB_H } from '../../src/world/types.ts';
import { newSurfaceHit } from '../../src/world/world.ts';
import type { Edge, World } from '../../src/world/world.ts';
import { FRONT, FRONT_OFFSETS, PARK, sideLayout } from '../../src/world/xsection.ts';
import type { RoadSideJson } from '../../src/world/xsection.ts';
import { BARRIER_LOOK } from './facadedetail.ts';
import { BARRIER_STYLES, drawBarrier, frontagePlan, isHedge, isWall } from './fences.ts';
import { addBand, addQuad } from './meshacc.ts';
import type { TileSet } from './meshacc.ts';
import type { OsmData, Tags } from './osm.ts';
import { mix01, sideParking } from './parking.ts';
import type { StripTree } from './parking.ts';
import type { EdgeFeature } from './roads.ts';

type RGB = [number, number, number];
const tmp = newPolySample();
const proj: PolyProjection = { s: 0, off: 0, d2: 0, seg: 0 };

// ---------------------------------------------------------------------------
// mapped barriers

/** The mapped height of a barrier (height=*, m), or undefined. */
export function barrierHeight(t: Tags): number | undefined {
  const v = t.height;
  if (v === undefined) return undefined;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(m|cm)?\s*$/.exec(v);
  if (!m) return undefined;
  const h = Number(m[1].replace(',', '.')) / (m[2] === 'cm' ? 100 : 1);
  return h >= 0.3 && h <= 6 ? h : undefined;
}

const BUILT = new Set<number>([COVER.RESIDENTIAL, COVER.COMMERCIAL, COVER.INDUSTRIAL, COVER.ALLOTMENT, COVER.CEMETERY, COVER.FARMYARD]);
const SEE_THROUGH = new Set(['wire', 'barbed_wire', 'electric', 'pole', 'rope', 'field']);

/**
 * Is a mapped fence drawn?  A fence of wire round a pasture would stand as a
 * brown wall, so: not the wire ones, and one without a kind only in built-up
 * land (gardens, yards) – where most of a town's fences stand.
 */
export function fenceDrawn(t: Tags, coverAt: (x: number, z: number) => number, coords: number[]): boolean {
  const kind = t.fence_type;
  if (kind !== undefined) return !SEE_THROUGH.has(kind);
  let built = 0;
  let n = 0;
  for (let i = 0; i + 1 < coords.length; i += Math.max(2, Math.floor(coords.length / 16) * 2)) {
    n++;
    if (BUILT.has(coverAt(coords[i], coords[i + 1]))) built++;
  }
  return n > 0 && built * 2 >= n;
}

/** A fence's colour by its kind: metal ones grey-green, the rest wood. */
export function fenceColour(t: Tags): RGB {
  const k = `${t.fence_type ?? ''}|${t.material ?? ''}`;
  if (/chain_link|metal|railing|steel|bars|mesh/.test(k)) return [96, 108, 100];
  if (/concrete|stone|brick/.test(k)) return [168, 164, 156];
  return BARRIER_LOOK.fence.rgb as RGB;
}

// ---------------------------------------------------------------------------
// trees in the parking strips

/** Point at station `s` and lateral offset `off` (+ left) of a road, on its surface (+ `lift`). */
function at(world: World, e: Edge, s: number, off: number, lift = 0): [number, number, number] {
  samplePolyline(e.pl, s, tmp);
  const x = tmp.x + tmp.tz * off;
  const z = tmp.z - tmp.tx * off;
  return [x, world.edgeY(e, s, x, z) + lift, z];
}

/**
 * The mapped trees (natural=tree) that stand in a road's parking strip: per
 * road (by its number) their side and station, and the trees taken (their
 * bays become tree bulbs, objects.ts leaves them out).
 */
export function findStripTrees(world: World, osm: OsmData, features: ReadonlyArray<readonly EdgeFeature[] | undefined>): { byEdge: StripTree[][]; used: Set<number> } {
  const byEdge: StripTree[][] = [];
  for (const n of osm.nodes.values()) {
    if (n.tags?.natural !== 'tree') continue;
    let best: { e: Edge; t: StripTree; d: number } | null = null;
    world.segmentsInBox(n.x - 14, n.z - 14, n.x + 14, n.z + 14, (e, seg) => {
      if (!e.xl?.p && !e.xr?.p) return;
      projectOnPolyline(e.pl, n.x, n.z, proj, seg, seg);
      if (proj.s < e.cutA + 1 || proj.s > e.len - e.cutB - 1) return;
      const side: 1 | -1 = proj.off > 0 ? 1 : -1;
      const xs = side > 0 ? e.xl : e.xr;
      if (!xs?.p || xs.p === PARK.NONE) return;
      const lay = sideLayout(e.width / 2, side > 0 ? e.swL : e.swR, xs);
      if (!lay.park) return;
      const a = Math.abs(proj.off);
      if (a < lay.park[0] - 0.4 || a > lay.park[1] + 0.4) return;
      const d = Math.abs(a - (lay.park[0] + lay.park[1]) / 2);
      if (!best || d < best.d) best = { e, t: { side, s: proj.s, osm: n.id }, d };
    });
    if (!best) continue;
    const b = best as { e: Edge; t: StripTree };
    (byEdge[b.e.id] ??= []).push(b.t);
  }
  // only those that found a bay
  const used = new Set<number>();
  byEdge.forEach((list, id) => {
    const e = world.edges[id];
    if (!e || !list) return;
    const kept: StripTree[] = [];
    for (const side of [1, -1] as const) {
      const p = sideParking(world, e, side, features[id] ?? [], list);
      if (!p) continue;
      for (const b of p.bays) {
        if (b.tree === undefined || b.tree < 0) continue;
        used.add(b.tree);
        const t = list.find((q) => q.osm === b.tree);
        if (t) kept.push(t);
      }
    }
    byEdge[id] = kept;
  });
  return { byEdge, used };
}

export interface BulbStats {
  bulbs: number;
}

/** A box on the road: stations s0..s1, offsets o0..o1 (o0 the lanes' side), `h` high, its sides kerb stones. */
export function kerbedBox(world: World, ts: TileSet, e: Edge, side: 1 | -1, s0: number, s1: number, o0: number, o1: number, h: number, top: number): void {
  const k = Math.max(1, Math.ceil((s1 - s0) / 3));
  const inner: number[] = [];
  const innerTop: number[] = [];
  const outerTop: number[] = [];
  for (let i = 0; i <= k; i++) {
    const s = s0 + ((s1 - s0) * i) / k;
    inner.push(...at(world, e, s, side * o0, 0));
    innerTop.push(...at(world, e, s, side * o0, h));
    outerTop.push(...at(world, e, s, side * o1, h));
  }
  // (the kerb faces the lanes; the top lies level with the kerb)
  samplePolyline(e.pl, (s0 + s1) / 2, tmp);
  const nx = -tmp.tz * side;
  const nz = tmp.tx * side;
  addBand(ts, 'ground', inner, innerTop, [GM.KERB], nx, 0, nz);
  addBand(ts, 'ground', innerTop, outerTop, [top]);
  for (const [s, dir] of [
    [s0, -1],
    [s1, 1],
  ] as const) {
    const a = at(world, e, s, side * o0, 0);
    const b = at(world, e, s, side * o1, 0);
    const c = at(world, e, s, side * o1, h);
    const d = at(world, e, s, side * o0, h);
    addQuad(ts, 'ground', [...a, ...b, ...c, ...d], [GM.KERB], tmp.tx * dir, 0, tmp.tz * dir);
  }
}

/** The tree bulbs of every parking strip: a kerbed bed with a tree in place of a bay. */
export function addTreeBulbs(
  world: World,
  ts: TileSet,
  features: ReadonlyArray<readonly EdgeFeature[] | undefined>,
  stripTrees: ReadonlyArray<readonly StripTree[] | undefined>,
): BulbStats {
  const stats: BulbStats = { bulbs: 0 };
  for (const e of world.edges) {
    if (!e || (!e.xl?.p && !e.xr?.p)) continue;
    const trees = stripTrees[e.id] ?? [];
    if (!e.xl?.pt && !e.xr?.pt && trees.length === 0) continue;
    for (const side of [1, -1] as const) {
      const p = sideParking(world, e, side, features[e.id] ?? [], trees);
      if (!p) continue;
      const half = e.width / 2;
      const kh = p.lay.kerbH > 0.05 ? p.lay.kerbH : KERB_H;
      for (const b of p.bays) {
        if (b.tree === undefined) continue;
        const sm = (b.s0 + b.s1) / 2;
        // (the bed reaches from just beside the lanes to the kerb; on the pavement only the tree)
        const o0 = p.inner + 0.15;
        const o1 = Math.min(p.outer, half);
        const len = Math.min(b.s1 - b.s0 - 0.3, 4.5);
        if (o1 - o0 > 0.6 && p.xs.p !== PARK.ON_KERB) kerbedBox(world, ts, e, side, sm - len / 2, sm + len / 2, o0, o1, kh, GM.VERGE);
        else if (p.xs.p === PARK.ON_KERB) {
          // (on the pavement: a tree pit of 1.6 m square, level with the pavers – the tree does not stand on them)
          const mid = (p.inner + p.outer) / 2;
          const half2 = Math.min(0.8, (p.outer - p.inner) / 2);
          const ring = [
            ...at(world, e, sm - 0.8, side * (mid - half2), kh + 0.015),
            ...at(world, e, sm + 0.8, side * (mid - half2), kh + 0.015),
            ...at(world, e, sm + 0.8, side * (mid + half2), kh + 0.015),
            ...at(world, e, sm - 0.8, side * (mid + half2), kh + 0.015),
          ];
          addQuad(ts, 'ground', ring, [GM.VERGE]);
        }
        const [x, y, z] = at(world, e, sm, side * ((p.inner + p.outer) / 2), kh);
        // (street trees in bulbs are mostly young: 6–9 m – the renderer gives their crowns a street tree's width)
        const h = 6 + 3 * mix01(e.osm, side, Math.round(sm), 31);
        ts.at(x, z).trees.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(z * 10) / 10, Math.round(h * 10) / 10, 0);
        stats.bulbs++;
      }
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// frontage and verge trees

export interface FrontageStats {
  hedgeKm: number;
  fenceKm: number;
  wallKm: number;
  lawnKm: number;
  /** plots left open (a lawn, no barrier) */
  openKm: number;
  vergeTrees: number;
}

/**
 * What stands along one side of a road behind its pavement
 * (frontage:<side>; frontage:<side>:offset how far behind, else
 * FRONT_OFFSETS – right behind the pavement, or behind the gutter where
 * there is none): plot by plot (12–22 m, a driveway gap between most of
 * them) a garden hedge of 0.7–1.2 m or 1.5–2.3 m, a fence, a low wall or
 * open lawn – mostly hedges for frontage=hedge, fences for fence, walls for
 * wall (mapgen/fences.ts; a tagged height: that kind at that height on
 * every plot); or a lawn (frontage=lawn); young trees in its verge
 * (verge:<side>=…;trees).  Only roads of the detail region carry these
 * keys (mapgen/detailregion.ts).  Gaps where
 * another road or a junction lies, where a building stands (`occupied`), on
 * paved ground (`paved`: driveways and forecourts mapped as areas), and
 * wherever it would stand in a lane.
 */
export function addFrontage(
  world: World,
  ts: TileSet,
  inLane: (x1: number, z1: number, x2: number, z2: number, y: number) => boolean,
  occupied: (x: number, z: number) => boolean,
  paved: (x: number, z: number) => boolean = () => false,
): FrontageStats {
  const stats: FrontageStats = { hedgeKm: 0, fenceKm: 0, wallKm: 0, lawnKm: 0, openKm: 0, vergeTrees: 0 };
  const hit = newSurfaceHit();
  /** is the point free of other roads, junctions and buildings? */
  const free = (e: Edge, x: number, z: number, y: number): boolean => {
    if (occupied(x, z) || paved(x, z)) return false;
    if (world.surfaceAt(x, z, y + 0.5, hit) && (hit.node || (hit.edge && hit.edge !== e))) return false;
    return true;
  };
  let side: 1 | -1 = 1;
  /** runs of stations every 2 m (s0…s1) at offset `off` where something may stand: free, and (`walls`) not in a lane */
  const freeRuns = (e: Edge, s0: number, s1: number, off: number, lift: number, walls: boolean): number[][] => {
    const n = Math.max(1, Math.ceil((s1 - s0) / 2));
    const runs: number[][] = [];
    let cur: number[] = [];
    let prev: [number, number, number] | null = null;
    for (let i = 0; i <= n; i++) {
      const s = s0 + ((s1 - s0) * i) / n;
      const p = at(world, e, s, side * off, lift);
      const ok = free(e, p[0], p[2], p[1]) && (!prev || !walls || !inLane(prev[0], prev[2], p[0], p[2], Math.min(prev[1], p[1])));
      if (ok) cur.push(s);
      else {
        if (cur.length >= 2) runs.push(cur);
        cur = ok ? [s] : [];
      }
      prev = p;
    }
    if (cur.length >= 2) runs.push(cur);
    return runs;
  };
  for (const e of world.edges) {
    if (!e) continue;
    for (side of [1, -1] as const) {
      const xs: RoadSideJson | undefined = side > 0 ? e.xl : e.xr;
      if (!xs || (!xs.ft && !xs.vt)) continue;
      const sw = side > 0 ? e.swL : e.swR;
      const half = e.width / 2;
      const kh = side > 0 ? e.kerbL : e.kerbR;
      const lift = sw > 0 ? kh : 0;
      const s0 = e.cutA + 1;
      const s1 = e.len - e.cutB - 1;
      if (s1 - s0 < 3) continue;
      if (xs.vt) {
        const lay = sideLayout(half, sw, xs);
        if (lay.verge && lay.verge[1] - lay.verge[0] >= 0.8) {
          const mid = (lay.verge[0] + lay.verge[1]) / 2;
          for (let s = s0 + 4; s < s1 - 3; s += 10) {
            const [x, y, z] = at(world, e, s, side * mid, lift);
            if (!free(e, x, z, y)) continue;
            const h = 5 + 2 * mix01(e.osm, side, Math.round(s), 41);
            // (a young street tree: broadleaf, whose crown the renderer draws slim at this height)
            ts.at(x, z).trees.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(z * 10) / 10, Math.round(h * 10) / 10, 0);
            stats.vergeTrees++;
          }
        }
      }
      if (!xs.ft) continue;
      const kind = xs.ft;
      if (kind === FRONT.LAWN) {
        const off = half + Math.max(0, sw);
        for (const run of freeRuns(e, s0, s1, off, lift, false)) {
          // a strip of lawn 2.5 m deep at the pavement's height, then down to the ground
          const a = run.flatMap((s) => at(world, e, s, side * off, lift + 0.01));
          const b = run.flatMap((s) => at(world, e, s, side * (off + 2.5), lift + 0.01));
          const c = run.flatMap((s) => at(world, e, s, side * (off + 3.0), lift - 0.5));
          addBand(ts, 'ground', a, b, [GM.VERGE]);
          addBand(ts, 'ground', b, c, [GM.VERGE]);
          stats.lawnKm += (run[run.length - 1] - run[0]) / 1000;
        }
        continue;
      }
      // plot by plot: a garden hedge, a fence, a low wall or open lawn, a driveway between most of them
      // (mapgen/fences.ts) – right behind the pavement, or a little behind the kerb where there is none
      const back = xs.fo ?? (sw > 0 ? FRONT_OFFSETS.behindWalk : FRONT_OFFSETS.noWalk);
      for (const plot of frontagePlan(kind, s0, s1, e.osm, side, xs.fh)) {
        if (!plot.style) {
          stats.openKm += (plot.s1 - plot.s0) / 1000;
          continue;
        }
        const look = BARRIER_STYLES[plot.style];
        const off = half + Math.max(0, sw) + back + look.halfW + 0.02;
        for (const run of freeRuns(e, plot.s0, plot.s1, off, lift, true)) {
          const km = (run[run.length - 1] - run[0]) / 1000;
          const line = run.flatMap((s) => at(world, e, s, side * off, lift));
          drawBarrier(ts, line, plot.style, plot.h);
          // (it stops whoever walks or drives into it)
          for (let i = 3; i < line.length; i += 3) ts.at(line[i], line[i + 2]).collSeg.push(line[i - 3], line[i - 1], line[i], line[i + 2], Math.min(line[i - 2], line[i + 1]) - 0.2);
          if (isHedge(plot.style)) stats.hedgeKm += km;
          else if (isWall(plot.style)) stats.wallKm += km;
          else stats.fenceKm += km;
        }
      }
    }
  }
  return stats;
}
