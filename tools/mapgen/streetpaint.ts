// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The smaller things on and beside the carriageway that the road mesh
 * (roadmesh.ts) does not draw by itself:
 *
 * - shark teeth on the ramps of raised tables (the tables themselves are
 *   the carriageway lifted: src/world/roadfeatures.ts);
 * - kerb build-outs (traffic_calming=choker | chicane on a node of the road):
 *   a kerbed, planted bed narrowing the carriageway – both sides for a
 *   choker, one after the other for a chicane, or as `side=left | right |
 *   both` says; `length` along the road (default 5 m); a red-white beacon
 *   post on its nose with `beacon=yes` (our own key);
 * - mouths over a continuous pavement (EdgeJson.mk): the pavement of the
 *   road they meet runs on across them, behind a lowered kerb;
 * - zigzag lines (Zeichen 299) along a kerb (EdgeJson.zz, zs);
 * - text painted in the lanes (EdgeJson.rt), in block letters;
 * - cycle crossings (Radfahrerfurt) where a road's cycle lanes go on across
 *   the mouth of a side road: dashed edges, red between them where the
 *   lanes are red; and where a crossing way is mapped red
 *   (addTaggedCrossings: a footway, cycleway or path with
 *   cycleway | footway | path = crossing and surface:colour | colour = red).
 *
 * All paint lies on the surface the physics uses (World.edgeY / planeY and
 * the lift of tables).
 */
import { newPolySample, samplePolyline, wrap2Pi } from '../../src/core/geom.ts';
import { CALM, CALM_STRIDE, TABLE_RAMP, calmCentre, calmLift, flushMouth } from '../../src/world/roadfeatures.ts';
import { BO, BUILD_OUT_DEPTH, BUILD_OUT_PASS, buildOutEntries, buildOutRoom, narrowingsOf } from '../../src/world/narrowing.ts';
import { GM } from '../../src/world/tilefmt.ts';
import { EF, KERB_H } from '../../src/world/types.ts';
import type { EdgeJson } from '../../src/world/types.ts';
import { newSurfaceHit } from '../../src/world/world.ts';
import type { Arm, Edge, Node, World } from '../../src/world/world.ts';
import { CYCLE, sideLayout } from '../../src/world/xsection.ts';
import { addBand, addQuad, addTriangles } from './meshacc.ts';
import type { TileSet } from './meshacc.ts';
import type { OsmData, Tags } from './osm.ts';
import type { EdgeFeature } from './roads.ts';
import { kerbedBox } from './roadside.ts';
import { POST_CLEAR } from '../../src/sim/clearlanes.ts';

const LIFT = 0.018;
const tmp = newPolySample();
type RGB = [number, number, number];
const RED: RGB = [196, 36, 32];
const WHITE: RGB = [236, 236, 230];
const SHRUB: RGB = [62, 96, 46];

export interface StreetDetailStats {
  tables: number;
  buildOuts: number;
  mouths: number;
  zigzags: number;
  texts: number;
  cycleCrossings: number;
}

/** A point on a road's surface at station s and offset (+ left of a→b), with the lift of tables on the carriageway. */
function onRoad(world: World, e: Edge, s: number, off: number, lift = LIFT): [number, number, number] {
  samplePolyline(e.pl, s, tmp);
  const x = tmp.x + tmp.tz * off;
  const z = tmp.z - tmp.tx * off;
  const up = e.calm && Math.abs(off) <= e.width / 2 + 0.01 ? calmLift(e, s) : 0;
  return [x, world.edgeY(e, s, x, z) + lift + up, z];
}

/** Paint in a road's own frame of station and offset. */
class Painter {
  quads = 0;
  readonly world: World;
  readonly ts: TileSet;
  constructor(world: World, ts: TileSet) {
    this.world = world;
    this.ts = ts;
  }

  /** A painted line from (sa, oa) to (sb, ob), `width` wide. */
  line(e: Edge, sa: number, oa: number, sb: number, ob: number, width: number, mat: number = GM.PAINT_WHITE): void {
    const ds = sb - sa;
    const dO = ob - oa;
    const l = Math.hypot(ds, dO);
    if (l < 0.01) return;
    const ns = (-dO / l) * (width / 2);
    const no = (ds / l) * (width / 2);
    // (long lines in pieces, so they follow the road and its tables)
    const n = Math.max(1, Math.ceil(l / (e.calm ? 0.5 : 2.5)));
    const a: number[] = [];
    const b: number[] = [];
    for (let k = 0; k <= n; k++) {
      const s = sa + (ds * k) / n;
      const o = oa + (dO * k) / n;
      a.push(...onRoad(this.world, e, s + ns, o + no));
      b.push(...onRoad(this.world, e, s - ns, o - no));
    }
    addBand(this.ts, 'mark', a, b, [mat]);
    this.quads += n;
  }

  /** A filled polygon (convex, in station/offset pairs). */
  poly(e: Edge, so: number[], mat: number = GM.PAINT_WHITE): void {
    const p: number[] = [];
    for (let i = 0; i < so.length; i += 2) p.push(...onRoad(this.world, e, so[i], so[i + 1]));
    const tris: number[] = [];
    for (let i = 1; i < so.length / 2 - 1; i++) tris.push(0, i, i + 1);
    addTriangles(this.ts, 'mark', p, tris, [mat]);
    this.quads++;
  }
}

// ---------------------------------------------------------------------------
// road text: block letters drawn as strokes on a cell 1 wide and 1 high

const BOX = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
const GLYPHS: Record<string, number[][][]> = {
  '0': [BOX],
  '1': [[[0.55, 0], [0.55, 1], [0.2, 0.75]]],
  '2': [[[0, 1], [1, 1], [1, 0.5], [0, 0.5], [0, 0], [1, 0]]],
  '3': [[[0, 1], [1, 1], [1, 0], [0, 0]], [[0.25, 0.5], [1, 0.5]]],
  '4': [[[0, 1], [0, 0.45], [1, 0.45]], [[0.75, 0], [0.75, 0.75]]],
  '5': [[[1, 1], [0, 1], [0, 0.55], [1, 0.55], [1, 0], [0, 0]]],
  '6': [[[1, 1], [0, 1], [0, 0], [1, 0], [1, 0.5], [0, 0.5]]],
  '7': [[[0, 1], [1, 1], [0.35, 0]]],
  '8': [BOX, [[0, 0.5], [1, 0.5]]],
  '9': [[[1, 0.5], [0, 0.5], [0, 1], [1, 1], [1, 0], [0, 0]]],
  A: [[[0, 0], [0.5, 1], [1, 0]], [[0.22, 0.42], [0.78, 0.42]]],
  B: [[[0, 0], [0, 1], [0.8, 1], [0.8, 0.55], [0, 0.55]], [[0, 0.55], [1, 0.55], [1, 0], [0, 0]]],
  C: [[[1, 1], [0, 1], [0, 0], [1, 0]]],
  D: [[[0, 0], [0, 1], [0.65, 1], [1, 0.7], [1, 0.3], [0.65, 0], [0, 0]]],
  E: [[[1, 1], [0, 1], [0, 0], [1, 0]], [[0, 0.5], [0.8, 0.5]]],
  F: [[[1, 1], [0, 1], [0, 0]], [[0, 0.5], [0.8, 0.5]]],
  G: [[[1, 1], [0, 1], [0, 0], [1, 0], [1, 0.45], [0.55, 0.45]]],
  H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]],
  I: [[[0.5, 0], [0.5, 1]]],
  J: [[[1, 1], [1, 0], [0, 0], [0, 0.3]]],
  K: [[[0, 0], [0, 1]], [[1, 1], [0, 0.45], [1, 0]]],
  L: [[[0, 1], [0, 0], [1, 0]]],
  M: [[[0, 0], [0, 1], [0.5, 0.45], [1, 1], [1, 0]]],
  N: [[[0, 0], [0, 1], [1, 0], [1, 1]]],
  O: [BOX],
  P: [[[0, 0], [0, 1], [1, 1], [1, 0.5], [0, 0.5]]],
  Q: [BOX, [[0.6, 0.3], [1.05, -0.05]]],
  R: [[[0, 0], [0, 1], [1, 1], [1, 0.5], [0, 0.5]], [[0.4, 0.5], [1, 0]]],
  S: [[[1, 1], [0, 1], [0, 0.55], [1, 0.55], [1, 0], [0, 0]]],
  T: [[[0, 1], [1, 1]], [[0.5, 1], [0.5, 0]]],
  U: [[[0, 1], [0, 0], [1, 0], [1, 1]]],
  V: [[[0, 1], [0.5, 0], [1, 1]]],
  W: [[[0, 1], [0.22, 0], [0.5, 0.6], [0.78, 0], [1, 1]]],
  X: [[[0, 0], [1, 1]], [[0, 1], [1, 0]]],
  Y: [[[0, 1], [0.5, 0.5], [1, 1]], [[0.5, 0.5], [0.5, 0]]],
  Z: [[[0, 1], [1, 1], [0, 0], [1, 0]]],
};

/** The strokes of a text laid out in a row: [x0, y0, x1, y1, …] per stroke, x across (0…width), y along (0…1). */
export function textStrokes(text: string, cell = 0.75, gap = 0.3): { strokes: number[][]; width: number } {
  const strokes: number[][] = [];
  let x = 0;
  const chars = [...text.toUpperCase()];
  chars.forEach((ch, i) => {
    const g = GLYPHS[ch];
    if (g) {
      for (const line of g) {
        const flat: number[] = [];
        for (const [u, v] of line) flat.push(x + u * cell, v);
        strokes.push(flat);
      }
    }
    x += cell + (i < chars.length - 1 ? gap : 0);
  });
  return { strokes, width: x };
}

// ---------------------------------------------------------------------------

function lanesOf(e: Edge): { oR: number; oD: number; oL: number } {
  const oR = -e.width / 2 + e.marginR;
  return { oR, oD: oR + e.lanesF * e.laneW, oL: e.width / 2 - e.marginL };
}

/** Shark teeth on the up-ramps of each raised table, in the lanes that climb it. */
function tableTeeth(p: Painter, e: Edge): number {
  if (!e.calm) return 0;
  let n = 0;
  const { oR, oD, oL } = lanesOf(e);
  for (let i = 0; i + CALM_STRIDE <= e.calm.length; i += CALM_STRIDE) {
    if (e.calm[i + 1] !== CALM.TABLE) continue;
    const mid = calmCentre(e, i);
    if (Number.isNaN(mid)) continue;
    const top = e.calm[i + 2] / 2;
    for (const dir of [1, -1]) {
      const lanes = dir > 0 ? e.lanesF : e.lanesB;
      if (lanes === 0) continue;
      // forward traffic climbs the ramp before the table, on the right; backward the one after it, on the left
      const [o0, o1] = dir > 0 ? [oR, oD] : [oD, oL];
      const foot = mid - dir * (top + TABLE_RAMP);
      const tip = mid - dir * (top + 0.15);
      for (let o = o0 + 0.2; o + 0.5 <= o1 - 0.1; o += 0.75) p.poly(e, [foot + dir * 0.1, o, foot + dir * 0.1, o + 0.5, tip, o + 0.25]);
    }
    n++;
  }
  return n;
}

// (the build-outs' geometry is shared with the game: src/world/narrowing.ts)
export { BUILD_OUT_DEPTH, BUILD_OUT_PASS, buildOutRoom };

/** Where traffic beside a side of a road runs: the offset of the middle of its outer lane (m from the centreline). */
function laneMiddle(e: Edge, side: 1 | -1): number {
  const margin = side > 0 ? e.marginL : e.marginR;
  return e.width / 2 - margin - e.laneW / 2;
}

/** A number in [0, 1) from two integers. */
function mix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Kerbed, planted build-outs of chokers and chicanes, with a small tree and their beacons. */
function buildOuts(world: World, ts: TileSet, e: Edge, feats: readonly EdgeFeature[]): number {
  let n = 0;
  const half = e.width / 2;
  // (the same beds the game finds again from EdgeJson.bo)
  for (const nb of narrowingsOf(e, buildOutEntries(feats))) {
    const { side, depth, at } = nb;
    const a = nb.s0;
    const b = nb.s1;
    const planted = (nb.flags & BO.BARE) === 0;
    const o0 = half - depth;
    kerbedBox(world, ts, e, side, a, b, o0, half, KERB_H, GM.VERGE);
    n++;
    // planting: a low shrub bed where there is room
    if (depth >= 0.9 && b - a >= 2.5 && planted) {
      const c0 = onRoad(world, e, a + 0.5, side * (o0 + 0.3), 0);
      const c1 = onRoad(world, e, b - 0.5, side * (o0 + 0.3), 0);
      const c2 = onRoad(world, e, b - 0.5, side * (half - 0.2), 0);
      const c3 = onRoad(world, e, a + 0.5, side * (half - 0.2), 0);
      box(ts, [c0, c1, c2, c3], KERB_H, KERB_H + 0.55, SHRUB);
    }
    // a small tree in the bed (a shrub where its trunk would stand in a lane – mapgen clears trunks there)
    if (depth >= 0.9 && b - a >= 2.5 && planted && (nb.flags & BO.NO_TREE) === 0) {
      const off = half - Math.min(0.6, depth / 2);
      const [x, y, z] = onRoad(world, e, (a + b) / 2 + (b - a) * 0.15, side * off, 0);
      const r = mix(e.id, Math.round(at));
      const tree = off - laneMiddle(e, side) >= POST_CLEAR + 0.1;
      ts.at(x, z).trees.push(Math.round(x * 10) / 10, Math.round((y + KERB_H) * 10) / 10, Math.round(z * 10) / 10, Math.round((tree ? 4.5 + 2 * r : 2.2 + 0.6 * r) * 10) / 10, tree ? 3 : 2);
    }
    // the beacon on the nose, towards the lanes
    if (nb.flags & BO.BEACON) {
      const [x, y, z] = onRoad(world, e, (a + b) / 2, side * (o0 + 0.25), 0);
      beacon(ts, x, y + KERB_H, z);
    }
  }
  return n;
}

/** A box standing on four corners (at their heights + y0, up to + y1). */
function box(ts: TileSet, c: Array<[number, number, number]>, y0: number, y1: number, rgb: RGB): void {
  const top: number[] = [];
  for (const p of c) top.push(p[0], p[1] + y1, p[2]);
  addQuad(ts, 'struct', top, rgb);
  for (let i = 0; i < 4; i++) {
    const p = c[i];
    const q = c[(i + 1) % 4];
    const mx = (p[0] + q[0]) / 2 - (c[0][0] + c[2][0]) / 2;
    const mz = (p[2] + q[2]) / 2 - (c[0][2] + c[2][2]) / 2;
    addQuad(ts, 'struct', [p[0], p[1] + y1, p[2], q[0], q[1] + y1, q[2], q[0], q[1] + y0, q[2], p[0], p[1] + y0, p[2]], rgb, mx, 0, mz);
  }
}

/** A red-white beacon post, 1 m high, standing at (x, y, z). */
function beacon(ts: TileSet, x: number, y: number, z: number): void {
  const r = 0.06;
  const foot: Array<[number, number, number]> = [
    [x - r, y, z - r],
    [x + r, y, z - r],
    [x + r, y, z + r],
    [x - r, y, z + r],
  ];
  for (let k = 0; k < 4; k++) box(ts, foot, k * 0.25, (k + 1) * 0.25, k % 2 === 0 ? RED : WHITE);
}

/** The pavement running on across the mouth of a road that meets a junction over a lowered kerb. */
function mouthBands(world: World, ts: TileSet, n: Node): number {
  let count = 0;
  const arms = n.arms;
  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    if (!flushMouth(arm)) continue;
    const prev = arms[(i + arms.length - 1) % arms.length];
    const next = arms[(i + 1) % arms.length];
    const d = Math.min(4, Math.max(prev.swL, next.swR));
    if (d < 0.5) continue;
    const e = arm.edge;
    const half = e.width / 2;
    const room = e.len - e.cutA - e.cutB;
    if (room < d + 0.6) continue;
    // stations from the junction outwards
    const at = (dist: number): number => (arm.out ? e.cutA + dist : e.len - e.cutB - dist);
    const wm = (prev.out ? prev.edge.xl : prev.edge.xr)?.wm ?? (next.out ? next.edge.xr : next.edge.xl)?.wm ?? GM.SIDEWALK;
    const LOW = 0.03;
    const steps = Math.max(2, Math.ceil(half));
    const row = (dist: number, dy: number): number[] => {
      const out: number[] = [];
      for (let k = 0; k <= steps; k++) out.push(...onRoad(world, e, at(dist), -half + (2 * half * k) / steps, dy));
      return out;
    };
    const kerbFoot = row(0, 0.005);
    const kerbTop = row(0, LOW);
    const walkEnd = row(d, LOW);
    const rampEnd = row(d + 0.4, 0.005);
    addBand(ts, 'ground', kerbFoot, kerbTop, [GM.KERB]);
    addBand(ts, 'ground', kerbTop, walkEnd, [wm]);
    addBand(ts, 'ground', walkEnd, rampEnd, [wm]);
    count++;
  }
  return count;
}

/** Zigzag lines along a kerb from station a to b; `side` +1 left of a→b. */
function zigzag(p: Painter, e: Edge, a: number, b: number, side: 1 | -1): void {
  const half = e.width / 2;
  const outer = half - 0.2;
  const inner = half - 0.95;
  const step = 1.5;
  const n = Math.floor((b - a) / step);
  if (n < 2) return;
  const start = a + (b - a - n * step) / 2;
  // (along the kerb at both ends, zigzag in between)
  p.line(e, start - 0.06, side * outer, start + step, side * outer, 0.12);
  for (let k = 1; k < n - 1; k++) {
    const s = start + k * step;
    const o0 = k % 2 ? outer : inner;
    const o1 = k % 2 ? inner : outer;
    p.line(e, s, side * o0, s + step, side * o1, 0.12);
  }
  p.line(e, start + (n - 1) * step, side * ((n - 2) % 2 ? inner : outer), start + n * step + 0.06, side * outer, 0.12);
}

function zigzags(p: Painter, e: Edge, j: EdgeJson | undefined): number {
  if (!j || (!j.zz && !j.zs)) return 0;
  const s0 = e.cutA + 0.5;
  const s1 = e.len - e.cutB - 0.5;
  let n = 0;
  const run = (a: number, b: number, bits: number): void => {
    a = Math.max(a, s0);
    b = Math.min(b, s1);
    if (b - a < 3) return;
    if (bits & 1) zigzag(p, e, a, b, 1);
    if (bits & 2) zigzag(p, e, a, b, -1);
    n++;
  };
  if (j.zz) run(s0, s1, j.zz);
  for (let i = 0; j.zs && i + 3 <= j.zs.length; i += 3) run(j.zs[i], j.zs[i + 1], j.zs[i + 2]);
  return n;
}

/** Text painted in the lanes of a road. */
function texts(p: Painter, e: Edge, j: EdgeJson | undefined): number {
  if (!j?.rt) return 0;
  const { oR, oD, oL } = lanesOf(e);
  let n = 0;
  for (const [text, s, dir] of j.rt) {
    const lanes = dir > 0 ? e.lanesF : e.lanesB;
    // (in the lanes of that direction; a road without them – a one-way road read against it – in the middle)
    const [o0, o1] = lanes > 0 ? (dir > 0 ? [oR, oD] : [oD, oL]) : [oR, oL];
    const room = Math.min(o1 - o0, 3.6) - 0.5;
    let { strokes, width } = textStrokes(text);
    if (width > room) ({ strokes, width } = textStrokes(text, (0.75 * room) / width, (0.3 * room) / width));
    if (!strokes.length) continue;
    const H = 2.6;
    const sc = Math.max(e.cutA + H / 2 + 0.5, Math.min(e.len - e.cutB - H / 2 - 0.5, s));
    const oc = (o0 + o1) / 2;
    // across: the reader's right is −dir in offset; along: the glyph's top lies ahead of the reader
    const S = (y: number): number => sc + dir * (y - 0.5) * H;
    const O = (x: number): number => oc - dir * (x - width / 2);
    for (const st of strokes) for (let k = 0; k + 3 < st.length; k += 2) p.line(e, S(st[k + 1]), O(st[k]), S(st[k + 3]), O(st[k + 2]), 0.16);
    n++;
  }
  return n;
}

/** Point at distance `d` along an arm from the node and `off` to its left (looking away from the node), on the junction plane. */
function armSidePoint(world: World, arm: Arm, off: number): [number, number, number] {
  const e = arm.edge;
  samplePolyline(e.pl, arm.out ? arm.cut : e.len - arm.cut, tmp);
  const tx = arm.out ? tmp.tx : -tmp.tx;
  const tz = arm.out ? tmp.tz : -tmp.tz;
  const x = tmp.x + tz * off;
  const z = tmp.z - tx * off;
  return [x, world.planeY(arm.node, x, z) + LIFT, z];
}

/** Cycle crossings over the mouths between the two arms of a road whose cycle lanes go on through a junction. */
function cycleCrossings(world: World, ts: TileSet, n: Node): number {
  const arms = n.arms;
  if (arms.length < 3) return 0;
  let count = 0;
  for (let i = 0; i < arms.length; i++) {
    for (let k = 2; k < arms.length; k++) {
      // p and q opposite each other, with the arms i+1 … i+k−1 between them on p's left
      const p = arms[i];
      const q = arms[(i + k) % arms.length];
      const turn = wrap2Pi(q.ang - p.ang);
      if (Math.abs(turn - Math.PI) > 0.5) continue;
      // (a side road between them, not only driveways and mouths over the pavement)
      let road = false;
      for (let m = 1; m < k; m++) {
        const a = arms[(i + m) % arms.length];
        if (!a.edge.mouth && !(a.edge.flags & EF.MINOR_SERVICE)) road = true;
      }
      if (!road) continue;
      const ps = p.out ? p.edge.xl : p.edge.xr;
      const qs = q.out ? q.edge.xr : q.edge.xl;
      if (ps?.c !== CYCLE.LANE || qs?.c !== CYCLE.LANE) continue;
      const pl = sideLayout(p.edge.width / 2, p.swL, ps).cycleLane;
      const ql = sideLayout(q.edge.width / 2, q.swR, qs).cycleLane;
      if (!pl || !ql) continue;
      const a0 = armSidePoint(world, p, pl[0]);
      const a1 = armSidePoint(world, p, pl[1]);
      const b0 = armSidePoint(world, q, -ql[0]);
      const b1 = armSidePoint(world, q, -ql[1]);
      const len = Math.hypot(b0[0] - a0[0], b0[2] - a0[2]);
      if (len < 2 || len > 40) continue;
      if (ps.cr || qs.cr) addQuad(ts, 'mark', [...a0, ...b0, ...b1, ...a1], [GM.CYCLE]);
      // the dashed edges (0.5 m of line, 0.2 m of gap), a little above the red
      for (const [u, v] of [
        [a0, b0],
        [a1, b1],
      ]) {
        const l = Math.hypot(v[0] - u[0], v[2] - u[2]);
        const nx = (-(v[2] - u[2]) / l) * 0.06;
        const nz = ((v[0] - u[0]) / l) * 0.06;
        for (let t = 0; t + 0.5 <= l; t += 0.7) {
          const f0 = t / l;
          const f1 = (t + 0.5) / l;
          const P = (f: number, sgn: number): number[] => {
            const x = u[0] + (v[0] - u[0]) * f + nx * sgn;
            const z = u[2] + (v[2] - u[2]) * f + nz * sgn;
            return [x, world.planeY(n, x, z) + LIFT + 0.004, z];
          };
          addQuad(ts, 'mark', [...P(f0, 1), ...P(f1, 1), ...P(f1, -1), ...P(f0, -1)], [GM.PAINT_WHITE]);
        }
      }
      count++;
    }
  }
  return count;
}

/** Everything of this module on the roads and junctions of a block (RoadMesher.build). */
export function addStreetDetail(
  world: World,
  ts: TileSet,
  features: ReadonlyArray<readonly EdgeFeature[] | undefined>,
  /** only these roads and junctions (the detail region – mapgen/detailregion.ts) */
  only?: { edge(e: Edge): boolean; node(n: Node): boolean },
): StreetDetailStats {
  const stats: StreetDetailStats = { tables: 0, buildOuts: 0, mouths: 0, zigzags: 0, texts: 0, cycleCrossings: 0 };
  const p = new Painter(world, ts);
  for (const e of world.edges) {
    if (!e || (only && !only.edge(e))) continue;
    const j = world.json.edges[e.id] as EdgeJson | undefined;
    stats.tables += tableTeeth(p, e);
    stats.buildOuts += buildOuts(world, ts, e, features[e.id] ?? []);
    stats.zigzags += zigzags(p, e, j);
    stats.texts += texts(p, e, j);
  }
  for (const n of world.nodes) {
    if (!n || (only && !only.node(n))) continue;
    stats.mouths += mouthBands(world, ts, n);
    stats.cycleCrossings += cycleCrossings(world, ts, n);
  }
  return stats;
}

// ---------------------------------------------------------------------------
// crossing ways mapped red

/** Is this a crossing way (footway, cycleway, path) mapped red? */
export function redCrossing(t: Tags): boolean {
  const hw = t.highway;
  if (hw !== 'footway' && hw !== 'cycleway' && hw !== 'path') return false;
  const crossing = t.cycleway === 'crossing' || t.footway === 'crossing' || t.path === 'crossing';
  if (!crossing) return false;
  const c = t['surface:colour'] ?? t.colour ?? t['crossing:colour'];
  return c === 'red' || c === 'red-brown';
}

/** Red crossing ways painted where they lie on a carriageway or junction. */
export function addTaggedCrossings(osm: OsmData, world: World, ts: TileSet, keep?: (pts: number[]) => boolean): number {
  const hit = newSurfaceHit();
  let n = 0;
  for (const w of osm.ways) {
    if (!redCrossing(w.tags)) continue;
    const c = osm.wayCoords(w);
    // (with a detail region: those in it only – mapgen/detailregion.ts)
    if (keep && !keep(c)) continue;
    let width = Number.parseFloat(w.tags.width ?? '');
    if (!(width >= 1 && width <= 5)) width = 2;
    for (let i = 0; i + 3 < c.length; i += 2) {
      const l = Math.hypot(c[i + 2] - c[i], c[i + 3] - c[i + 1]);
      if (l < 0.2) continue;
      const tx = (c[i + 2] - c[i]) / l;
      const tz = (c[i + 3] - c[i + 1]) / l;
      const steps = Math.ceil(l / 0.5);
      for (let k = 0; k < steps; k++) {
        const f0 = k / steps;
        const f1 = (k + 1) / steps;
        const corner = (f: number, side: number): number[] | null => {
          const x = c[i] + (c[i + 2] - c[i]) * f + tz * side * (width / 2);
          const z = c[i + 1] + (c[i + 3] - c[i + 1]) * f - tx * side * (width / 2);
          if (!world.surfaceAt(x, z, 1e4, hit) || hit.zone !== 0) return null;
          return [x, hit.y + LIFT, z];
        };
        const q = [corner(f0, 1), corner(f1, 1), corner(f1, -1), corner(f0, -1)];
        if (q.some((v) => v === null)) continue;
        addQuad(ts, 'mark', (q as number[][]).flat(), [GM.CYCLE]);
      }
      n++;
    }
  }
  return n;
}
