// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The lines of the city buses: the roads each runs along and the stops it
 * calls at, in their order – from the route relations of OpenStreetMap
 * (route=bus and route=trolleybus) – so that the buses of the traffic run
 * their real lines, with the line and its destination on the front.
 *
 *   node --max-old-space-size=1536 tools/build-buslines.ts [path/to/hessen-latest.osm.pbf]
 *
 * Needs the map built (MAP_OUT, default public/map): the road network – its
 * chunks (w/*.json.gz, where every road names the way of OpenStreetMap it
 * was made of) and net.bin.gz (which road leads into which) – and the stops
 * (stops.json.gz, tools/build-stops.ts).  Reads what it needs from the PBF
 * itself in three passes, as tools/build-lines.ts does: the route relations
 * that touch the map, then their ways, then the few nodes it needs of those.
 * Writes buslines.json.gz there (BusLinesJson in src/world/types.ts).
 *
 * A route is a list of OpenStreetMap ways; a road of the game is a piece of
 * one such way between two junctions.  The ways are chained node by node (a
 * roundabout, or a way that was not split where the bus turns off, is left
 * where the next way goes on), and between each two junctions on the chain
 * the road of that way is looked up – by the numbers OpenStreetMap gave the
 * way and the junctions, not by where they lie.  Where the network has no
 * road for a piece (a road for buses only, a bus lane against a one-way
 * street, a way the relation lacks) a short search over the turns the
 * junctions allow mends the gap; what it cannot mend is counted.  At the end
 * of each route the search looks for where the line back begins.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { latLonToWorld } from '../src/geo/utm.ts';
import { encodeWays } from '../src/world/buslines.ts';
import { TURN } from '../src/world/lanes.ts';
import { POLY_UNIT, unpackNet } from '../src/world/netfile.ts';
import { MinHeap, RG } from '../src/world/routegraph.ts';
import { STOP_FLAG } from '../src/world/types.ts';
import type { BusLineJson, BusLinesJson, MapIndexJson, StopsJson, WorldChunkJson } from '../src/world/types.ts';
import { readPbf } from './osm/pbf.ts';
import type { OsmMember, Tags } from './osm/pbf.ts';

// ------------------------------------------------------------------ what the matching works on

/**
 * What the matching needs of the road network: net.bin.gz has it all
 * (NetData in src/world/netfile.ts); a test makes it from a small town.
 */
export interface RoadNet {
  nodeX: ArrayLike<number>;
  nodeZ: ArrayLike<number>;
  edgeA: ArrayLike<number>;
  edgeB: ArrayLike<number>;
  edgeLen: ArrayLike<number>;
  /** per way (road * 2 + direction): RG bits, and the speed allowed (0: not to be driven this way) */
  wayKind: ArrayLike<number>;
  waySpeed: ArrayLike<number>;
  /** the turns at the end of each way (routegraph.ts) */
  first: ArrayLike<number>;
  to: ArrayLike<number>;
  turn: ArrayLike<number>;
  /** the course of each road (netfile.ts): steps in quarter metres from junction a */
  polyFirst: ArrayLike<number>;
  poly: ArrayLike<number>;
}

/** A way of OpenStreetMap as the chaining needs it: its nodes, and which way a bus may drive it (1 as drawn, -1 against it, 0 both). */
export interface OsmWay {
  refs: number[];
  oneway: number;
}

/** A step along a route: the node it comes to and the way it came by (-1: it begins there – at the start, or after a gap). */
export interface Step {
  node: number;
  way: number;
}

/**
 * The route relation's ways (in its order, `way` undefined where the file
 * does not have it) as the nodes a bus passes, one after the other.  A way
 * is run from where the one before left off to where the next one goes on:
 * round a roundabout to its exit, along a way that was not split only as far
 * as the street the bus turns into.  Where a way does not join the one
 * before, the chain begins anew (a step with way -1).  `pos` (where a node
 * is) only helps to turn the first way of such a new beginning.
 */
export function chainRoute(members: ReadonlyArray<{ id: number; way: OsmWay | undefined }>, pos?: (node: number) => { x: number; z: number } | undefined): Step[] {
  const out: Step[] = [];
  let at = -1;
  for (let i = 0; i < members.length; i++) {
    const { id, way } = members[i];
    if (!way || way.refs.length < 2) {
      at = -1;
      continue;
    }
    const R = way.refs;
    const n = R.length;
    const closed = n > 3 && R[0] === R[n - 1];
    const next = members[i + 1]?.way;
    const nextRefs = next && next.refs.length >= 2 ? next.refs : null;
    const isEnd = (node: number): boolean => nextRefs !== null && (node === nextRefs[0] || node === nextRefs[nextRefs.length - 1]);
    const nextAll = nextRefs ? new Set(nextRefs) : null;
    const isOn = (node: number): boolean => nextAll !== null && nextAll.has(node);
    let ia = at >= 0 ? R.indexOf(at) : -1;
    if (closed && ia === n - 1) ia = 0;
    if (ia < 0) {
      // a beginning: the way is entered at the end away from the next way
      let fwd: boolean;
      const a = R[0];
      const b = R[n - 1];
      if (isEnd(b) && !isEnd(a)) fwd = true;
      else if (isEnd(a) && !isEnd(b)) fwd = false;
      else if (isOn(b) && !isOn(a)) fwd = true;
      else if (isOn(a) && !isOn(b)) fwd = false;
      else {
        const pa = pos?.(a);
        const pb = pos?.(b);
        const pn0 = nextRefs ? pos?.(nextRefs[0]) : undefined;
        const pn1 = nextRefs ? pos?.(nextRefs[nextRefs.length - 1]) : undefined;
        if (pa && pb && pn0 && pn1) {
          const da = Math.min(Math.hypot(pa.x - pn0.x, pa.z - pn0.z), Math.hypot(pa.x - pn1.x, pa.z - pn1.z));
          const db = Math.min(Math.hypot(pb.x - pn0.x, pb.z - pn0.z), Math.hypot(pb.x - pn1.x, pb.z - pn1.z));
          fwd = db <= da;
        } else fwd = way.oneway !== -1;
      }
      ia = fwd ? 0 : n - 1;
      out.push({ node: R[ia], way: -1 });
      if (closed) {
        // (a ring at a beginning: once round it)
        for (let s = 1; s < n; s++) out.push({ node: R[fwd ? s : n - 1 - s], way: id });
        at = R[ia];
        continue;
      }
    }
    if (closed) {
      // round the ring – the way it is drawn if it is one-way (a roundabout) – to where the next way leaves it
      const m = n - 1;
      const ring = (k: number): number => R[((k % m) + m) % m];
      const find = (dir: number): number => {
        let onIt = -1;
        for (let s = 1; s <= m; s++) {
          const node = ring(ia + dir * s);
          if (isEnd(node)) return s;
          if (onIt < 0 && isOn(node)) onIt = s;
        }
        return onIt;
      };
      let dir = way.oneway === -1 ? -1 : 1;
      let steps = find(dir);
      if (way.oneway === 0) {
        const back = find(-dir);
        if (back > 0 && (steps < 0 || back < steps)) {
          dir = -dir;
          steps = back;
        }
      }
      // (no way on from the ring: once round it – a turning loop at the end of the line)
      if (steps < 0) steps = m;
      for (let s = 1; s <= steps; s++) out.push({ node: ring(ia + dir * s), way: id });
      at = ring(ia + dir * steps);
      continue;
    }
    // along the way, to its other end – or to where the next way goes on, if that comes first
    const stopAt = (dir: number): number => {
      let onIt = -1;
      for (let k = ia + dir; k >= 0 && k < n; k += dir) {
        if (isEnd(R[k])) return k;
        if (onIt < 0 && isOn(R[k])) onIt = k;
      }
      return onIt;
    };
    let dir: number;
    if (ia === 0) dir = 1;
    else if (ia === n - 1) dir = -1;
    else {
      // come onto it in its middle: towards the next way (the way it may be driven, if it is one-way)
      const f = stopAt(1);
      const b = stopAt(-1);
      if (way.oneway !== 0) dir = way.oneway;
      else if (f >= 0 && (b < 0 || f - ia <= ia - b)) dir = 1;
      else if (b >= 0) dir = -1;
      else dir = n - 1 - ia >= ia ? 1 : -1;
    }
    let stop = nextRefs ? stopAt(dir) : -1;
    if (stop < 0) stop = dir > 0 ? n - 1 : 0;
    for (let k = ia + dir; dir > 0 ? k <= stop : k >= stop; k += dir) out.push({ node: R[k], way: id });
    at = R[stop];
  }
  return out;
}

/** What became of a route on the road network. */
export interface Mended {
  /** the ways (road * 2 + direction) in their order */
  ways: number[];
  /** gaps closed by a search */
  mended: number;
  /** gaps left: the next way cannot be reached from the one before within the search's reach */
  gaps: number;
  /** pieces that cannot be driven the way the route goes (a bus lane against a one-way street): left out, the search went round */
  against: number;
}

/** A point along a route: on its k-th way, m metres from where that way begins; d: how far from the point asked about. */
export interface RoutePlace {
  k: number;
  m: number;
  d: number;
}

/**
 * The road network seen from OpenStreetMap: which roads were made of a
 * way, which junction a node became – and the searches over the turns the
 * junctions allow.
 */
export class RouteMatcher {
  readonly net: RoadNet;
  private readonly edgeOsm: ArrayLike<number>;
  /** OpenStreetMap node → junction of the network */
  private readonly junction = new Map<number, number>();
  /** OpenStreetMap way → the roads made of it */
  private readonly roads = new Map<number, number[]>();
  /** the roads at each junction: nodeEdge[nodeFirst[n] … nodeFirst[n + 1] - 1] */
  private readonly nodeFirst: Uint32Array;
  private readonly nodeEdge: Uint32Array;

  constructor(net: RoadNet, edgeOsm: ArrayLike<number>, nodeOsm: ArrayLike<number>) {
    this.net = net;
    this.edgeOsm = edgeOsm;
    const N = net.nodeX.length;
    const E = net.edgeA.length;
    for (let i = 0; i < N; i++) if (nodeOsm[i] > 0) this.junction.set(nodeOsm[i], i);
    for (let e = 0; e < E; e++) {
      const o = edgeOsm[e];
      if (!(o > 0)) continue;
      const list = this.roads.get(o);
      if (list) list.push(e);
      else this.roads.set(o, [e]);
    }
    this.nodeFirst = new Uint32Array(N + 1);
    for (let e = 0; e < E; e++) {
      this.nodeFirst[net.edgeA[e] + 1]++;
      this.nodeFirst[net.edgeB[e] + 1]++;
    }
    for (let i = 0; i < N; i++) this.nodeFirst[i + 1] += this.nodeFirst[i];
    this.nodeEdge = new Uint32Array(E * 2);
    const fill = this.nodeFirst.slice(0, N);
    for (let e = 0; e < E; e++) {
      this.nodeEdge[fill[net.edgeA[e]]++] = e;
      this.nodeEdge[fill[net.edgeB[e]]++] = e;
    }
  }

  /** The roads made of a way of OpenStreetMap (none: the map has no road for it). */
  roadsOf(way: number): readonly number[] | undefined {
    return this.roads.get(way);
  }

  /** May way `w` be driven (in its direction) at all? */
  drivable(w: number): boolean {
    return this.net.waySpeed[w] > 0;
  }

  /** Does a junction let one turn from way `w` into way `t`? */
  joins(w: number, t: number): boolean {
    const g = this.net;
    for (let k = g.first[w]; k < g.first[w + 1]; k++) if (g.to[k] === t) return true;
    return false;
  }

  /** The way along a road between two junctions – of the given OpenStreetMap way if there is one, and one that may be driven – or -1. */
  private between(g0: number, g1: number, osmWay: number): number {
    const net = this.net;
    let best = -1;
    let score = -1;
    for (let k = this.nodeFirst[g0]; k < this.nodeFirst[g0 + 1]; k++) {
      const e = this.nodeEdge[k];
      const a = net.edgeA[e];
      const b = net.edgeB[e];
      if (!((a === g0 && b === g1) || (b === g0 && a === g1))) continue;
      const w = e * 2 + (a === g0 ? 0 : 1);
      const s = (this.edgeOsm[e] === osmWay ? 2 : 0) + (net.waySpeed[w] > 0 ? 1 : 0);
      if (s > score) {
        score = s;
        best = w;
      }
    }
    return best;
  }

  /**
   * The roads along a chain of steps, each in the direction the route
   * drives it (road * 2 + direction).  Where the network has no road
   * between two junctions of the chain, the list simply goes on with the
   * next one it has: `mend` finds the gaps.
   */
  follow(steps: readonly Step[]): number[] {
    const out: number[] = [];
    let g0 = -1;
    for (const st of steps) {
      const g = this.junction.get(st.node) ?? -1;
      if (st.way < 0) {
        g0 = g;
        continue;
      }
      if (g < 0) continue;
      if (g0 >= 0 && g !== g0) {
        const w = this.between(g0, g, st.way);
        if (w >= 0 && w !== out[out.length - 1]) out.push(w);
      }
      g0 = g;
    }
    return out;
  }

  /** where way `w` begins and ends */
  private ends(w: number): [number, number, number, number] {
    const net = this.net;
    const e = w >> 1;
    const a = (w & 1) === 0 ? net.edgeA[e] : net.edgeB[e];
    const b = (w & 1) === 0 ? net.edgeB[e] : net.edgeA[e];
    return [net.nodeX[a], net.nodeZ[a], net.nodeX[b], net.nodeZ[b]];
  }

  /**
   * The shortest drive from the end of way `from` into one of `targets`:
   * the ways after `from`, the target last – within `limit` metres (turns
   * count a little, roads that are not the route's own `members` count half
   * again).  Roads that may not be driven (private – among them the roads
   * for buses only, which the map does not tell apart) are used if they are
   * among `members`, others only where `closed` says what a metre of them
   * costs.  Null if there is none.
   */
  search(from: number, targets: readonly number[], limit: number, members: ReadonlySet<number> | null, closed = 0): { ways: number[]; cost: number } | null {
    const net = this.net;
    const dist = new Map<number, number>([[from, 0]]);
    const prev = new Map<number, number>();
    const heap = new MinHeap(64);
    heap.push(from, 0);
    let found = -1;
    let pops = 0;
    while (heap.size > 0 && pops++ < 30000) {
      const d = heap.topKey;
      const w = heap.pop();
      if (d > (dist.get(w) ?? Infinity)) continue;
      if (w !== from && targets.includes(w)) {
        found = w;
        break;
      }
      for (let k = net.first[w]; k < net.first[w + 1]; k++) {
        const t = net.to[k];
        if (net.waySpeed[t] === 0) continue;
        const e = t >> 1;
        const own = members?.has(e) ?? false;
        const shut = (net.wayKind[t] & RG.NO_ENTRY) !== 0 && !own && !targets.includes(t);
        if (shut && closed <= 0) continue;
        const tn = net.turn[k];
        const turnCost = tn === TURN.UTURN ? 250 : tn === TURN.LEFT ? 12 : tn === TURN.RIGHT ? 6 : 0;
        const len = Math.max(1, net.edgeLen[e]);
        const nd = d + len * (shut ? closed : members && !own ? 1.5 : 1) + turnCost;
        if (nd > limit || nd >= (dist.get(t) ?? Infinity)) continue;
        dist.set(t, nd);
        prev.set(t, w);
        heap.push(t, nd);
      }
    }
    if (found < 0) return null;
    const ways: number[] = [];
    for (let w = found; w !== from; w = prev.get(w) as number) ways.push(w);
    return { ways: ways.reverse(), cost: dist.get(found) as number };
  }

  /**
   * Make a list of ways drivable from end to end: each next way must be one
   * a junction lets the bus turn into.  Where it is not, the shortest drive
   * to it – or to one of the few after it, leaving out a piece that cannot
   * be driven – takes its place; where there is none within reach, the gap
   * stays.  `members`: the roads of the route's own ways (a road for buses
   * only may be used if it is one of them).
   */
  mend(seq: readonly number[], members: ReadonlySet<number>): Mended {
    const out: number[] = [];
    let mended = 0;
    let gaps = 0;
    let against = 0;
    for (let i = 0; i < seq.length; ) {
      const w = seq[i];
      if (!this.drivable(w)) {
        against++;
        i++;
        continue;
      }
      const prev = out[out.length - 1];
      if (prev === undefined || prev === w || this.joins(prev, w)) {
        if (prev !== w) out.push(w);
        i++;
        continue;
      }
      const targets: number[] = [];
      for (let j = i; j < seq.length && targets.length < 4; j++) if (this.drivable(seq[j])) targets.push(seq[j]);
      const [, , x1, z1] = this.ends(prev);
      const [x0, z0] = this.ends(w);
      const gap = Math.hypot(x1 - x0, z1 - z0);
      // (also where the two meet at a junction that does not allow the turn – a ban that is meant for
      // cars only, turning round in the road – the way round a block or two is looked for)
      const found = this.search(prev, targets, Math.min(3000, 1500 + gap * 3), members);
      if (found) {
        out.push(...found.ways);
        const last = found.ways[found.ways.length - 1];
        let j = i;
        while (seq[j] !== last) j++;
        i = j + 1;
        mended++;
      } else {
        out.push(w);
        gaps++;
        i++;
      }
    }
    return { ways: out, mended, gaps, against };
  }

  /** The point of way `w` nearest to (x, z): metres from where the way begins (in its direction), and how far off. */
  project(w: number, x: number, z: number): { m: number; d: number } {
    const net = this.net;
    const e = w >> 1;
    let ax = net.nodeX[net.edgeA[e]];
    let az = net.nodeZ[net.edgeA[e]];
    const k0 = net.polyFirst[e];
    const k1 = net.polyFirst[e + 1];
    let s = 0;
    let best = Infinity;
    let bestS = 0;
    for (let k = k0; k <= k1; k++) {
      const bx = k < k1 ? ax + net.poly[k * 2] * POLY_UNIT : net.nodeX[net.edgeB[e]];
      const bz = k < k1 ? az + net.poly[k * 2 + 1] * POLY_UNIT : net.nodeZ[net.edgeB[e]];
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz;
      const l = Math.sqrt(l2);
      const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (d < best) {
        best = d;
        bestS = s + l * t;
      }
      s += l;
      ax = bx;
      az = bz;
    }
    // (the course in the file is simplified: its length is scaled to the road's own)
    const len = net.edgeLen[e];
    const along = s > 1e-6 ? (bestS * len) / s : 0;
    return { m: (w & 1) === 0 ? along : len - along, d: best };
  }

  /**
   * Where along `ways`, from index `k0` on, the point (x, z) lies: the first
   * way that comes within `reach` of it – or a nearer one within 150 m after
   * that.  Null if none does.
   */
  locate(ways: readonly number[], k0: number, x: number, z: number, reach: number): RoutePlace | null {
    let best: RoutePlace | null = null;
    let past = 0;
    for (let k = Math.max(0, k0); k < ways.length; k++) {
      if (best) {
        past += this.net.edgeLen[ways[k - 1] >> 1];
        if (past > 150) break;
      }
      const p = this.project(ways[k], x, z);
      if (p.d <= reach && (!best || p.d < best.d)) {
        best = { k, m: p.m, d: p.d };
        past = 0;
      }
    }
    return best;
  }
}

// ------------------------------------------------------------------ the stops of a route

/** A stop as a route relation lists it: its stop position and/or its platform, under one name. */
export interface StopEvent {
  name: string;
  /** the platform (where people wait) if the relation has one, else the stop position */
  x: number;
  z: number;
  stop: boolean;
  platform: boolean;
}

const STOP_ROLE = /^(stop|stop_entry_only|stop_exit_only|forward_stop|backward_stop|stop_position)$/;
const PLATFORM_ROLE = /^platform/;

/**
 * The stops of a route in their order: a stop position and the platform
 * after it (or before it) under one name are one stop.  `where` gives the
 * place and name of a member (a node, or a platform drawn as a way).
 */
export function stopEvents(members: readonly OsmMember[], where: (m: OsmMember) => { x: number; z: number; name: string } | undefined): StopEvent[] {
  const out: StopEvent[] = [];
  for (const m of members) {
    const platform = PLATFORM_ROLE.test(m.role);
    if (!platform && !STOP_ROLE.test(m.role)) continue;
    if (m.type === 'r') continue;
    const at = where(m);
    if (!at) continue;
    const last = out[out.length - 1];
    if (last && (platform ? !last.platform : !last.stop) && sameStop(last.name, at.name) && Math.hypot(last.x - at.x, last.z - at.z) < 80) {
      // the other half of the stop before
      if (platform) {
        last.x = at.x;
        last.z = at.z;
        last.platform = true;
      } else last.stop = true;
      if (!last.name) last.name = at.name;
      continue;
    }
    out.push({ name: at.name, x: at.x, z: at.z, stop: !platform, platform });
  }
  return out;
}

/** A stop's name without what tells its platforms apart: "Weserspitze (Steig C)", "ZOB, Bussteig 3" → "weserspitze", "zob". */
function plainName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[,\s]+(bus)?(steig|bstg\.?|bahnsteig|gleis|platform)\b.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** May two names be those of one stop – the same but for a platform's letter, or one of them missing? */
function sameStop(a: string, b: string): boolean {
  if (!a || !b || a === b) return true;
  const pa = plainName(a);
  const pb = plainName(b);
  return pa.length >= 4 && pb.length >= 4 && (pa.startsWith(pb) || pb.startsWith(pa));
}

/** The stop places of stops.json.gz, to be found by name and place. */
export class StopPlaces {
  private readonly json: StopsJson;
  private readonly grid = new Map<number, number[]>();
  /** every point of each place: its middle and its poles */
  private readonly points: number[][] = [];

  constructor(json: StopsJson) {
    this.json = json;
    json.places.forEach(([, , , x, z]) => this.points.push([x, z]));
    for (const [p, x, z] of json.poles) this.points[p]?.push(x, z);
    this.points.forEach((pts, p) => {
      const cells = new Set<number>();
      for (let i = 0; i < pts.length; i += 2) cells.add(this.key(pts[i], pts[i + 1]));
      for (const c of cells) {
        const list = this.grid.get(c);
        if (list) list.push(p);
        else this.grid.set(c, [p]);
      }
    });
  }

  private key(x: number, z: number): number {
    return (Math.floor(x / 200) + 32768) * 65536 + Math.floor(z / 200) + 32768;
  }

  /** How far the nearest point of place `p` is from (x, z). */
  private dist(p: number, x: number, z: number): number {
    const pts = this.points[p];
    let d = Infinity;
    for (let i = 0; i < pts.length; i += 2) d = Math.min(d, Math.hypot(pts[i] - x, pts[i + 1] - z));
    return d;
  }

  /**
   * The place a stop of a route belongs to: one of its name within 300 m
   * (a platform's own name may add its letter: "Weserspitze (Steig C)" is a
   * platform of "Weserspitze") – or, where the names do not agree, a place
   * of buses with a pole within 30 m.  -1 if there is none.
   */
  find(name: string, x: number, z: number): number {
    const want = plainName(name);
    let best = -1;
    let bestD = Infinity;
    let alike = -1;
    let alikeD = Infinity;
    let near = -1;
    let nearD = 30;
    const i0 = Math.floor((x - 300) / 200);
    const i1 = Math.floor((x + 300) / 200);
    const j0 = Math.floor((z - 300) / 200);
    const j1 = Math.floor((z + 300) / 200);
    const seen = new Set<number>();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const p of this.grid.get((i + 32768) * 65536 + j + 32768) ?? []) {
          if (seen.has(p)) continue;
          seen.add(p);
          const d = this.dist(p, x, z);
          const [pname, , kind] = this.json.places[p];
          if (d >= 300) continue;
          if (name && pname === name.trim() && d < bestD) {
            bestD = d;
            best = p;
          }
          const plain = plainName(pname);
          if (want.length >= 4 && plain.length >= 4 && (plain.startsWith(want) || want.startsWith(plain)) && d < alikeD) {
            alikeD = d;
            alike = p;
          }
          if ((kind & STOP_FLAG.BUS) !== 0 && d < nearD) {
            nearD = d;
            near = p;
          }
        }
      }
    }
    return best >= 0 ? best : alike >= 0 ? alike : near;
  }

  name(p: number): string {
    return this.json.places[p]?.[0] ?? '';
  }
}

// ------------------------------------------------------------------ the build

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A route relation as the build keeps it. */
export interface RouteRel {
  id: number;
  tags: Tags;
  members: OsmMember[];
}

/** A way of the routes, with what the build needs of its tags. */
export interface RouteWay extends OsmWay {
  /** highway=… ('' if none) */
  hw: string;
  name: string;
}

/** What the three passes over the PBF found. */
export interface OsmRoutes {
  /** route relations of buses in the file, how many of them touch no road of the map, and how many are coaches over long distances (left out) */
  total: number;
  outside: number;
  coaches: number;
  routes: RouteRel[];
  /** route relation → its route_master */
  master: Map<number, number>;
  ways: Map<number, RouteWay>;
  nodes: Map<number, { x: number; z: number; name: string }>;
}

const yes = (v: string | undefined): boolean => v === 'yes' || v === 'true' || v === '1';

/** Which way a bus may drive along a way: 1 as drawn, -1 against it, 0 both. */
function onewayOf(t: Tags): number {
  if (t['oneway:bus'] === 'no' || t['oneway:psv'] === 'no') return 0;
  const o = t['oneway:bus'] ?? t['oneway:psv'] ?? t.oneway;
  if (o === '-1' || o === 'reverse') return -1;
  if (yes(o)) return 1;
  if (o === 'no') return 0;
  return t.junction === 'roundabout' || t.junction === 'circular' || t.highway === 'motorway' ? 1 : 0;
}

/**
 * Read what the routes need from the PBF, in three passes: the route
 * relations of buses that have a way among the map's roads (`inMap`), then
 * their ways, then the nodes it needs – the stops and platforms with their
 * names, the ends of the ways (to turn a way that does not join the one
 * before) and the points of platforms drawn as ways.
 */
export function readRoutes(input: string, inMap: (way: number) => boolean, lap: (msg: string) => void = () => {}): OsmRoutes {
  const routes: RouteRel[] = [];
  const masters: Array<{ id: number; routes: number[] }> = [];
  let total = 0;
  let outside = 0;
  let coaches = 0;
  readPbf(input, {
    relation(id, members, tags) {
      const t = tags();
      if (t.type === 'route_master' && (t.route_master === 'bus' || t.route_master === 'trolleybus')) {
        masters.push({ id, routes: members().filter((m) => m.type === 'r').map((m) => m.ref) });
        return;
      }
      if (t.type !== 'route' || (t.route !== 'bus' && t.route !== 'trolleybus')) return;
      total++;
      const m = members();
      if (!m.some((x) => x.type === 'w' && inMap(x.ref))) {
        outside++;
        return;
      }
      // (coaches between far cities pass along the motorways, with stops of their own: not the city buses the traffic has)
      if (t.service === 'long_distance' || /flixbus|blablabus|eurolines|regiojet/i.test(`${t.network ?? ''} ${t.operator ?? ''} ${t.brand ?? ''} ${t.name ?? ''}`)) {
        coaches++;
        return;
      }
      routes.push({ id, tags: t, members: m });
    },
  });
  const master = new Map<number, number>();
  for (const ms of masters) for (const r of ms.routes) master.set(r, ms.id);
  lap(`${total} route relations of buses in the file: ${outside} touch no road of the map, ${coaches} are coaches over long distances (left out), ${routes.length} to match`);

  const wantWays = new Set<number>();
  const wantNodes = new Set<number>();
  for (const r of routes) {
    for (const m of r.members) {
      if (m.type === 'w') wantWays.add(m.ref);
      else if (m.type === 'n' && (PLATFORM_ROLE.test(m.role) || STOP_ROLE.test(m.role))) wantNodes.add(m.ref);
    }
  }
  const ways = new Map<number, RouteWay>();
  readPbf(input, {
    way(id, refs, tags) {
      if (!wantWays.has(id)) return;
      const t = tags();
      ways.set(id, { refs, oneway: onewayOf(t), hw: t.highway ?? '', name: (t.name ?? t.ref_name ?? '').trim() });
    },
  });
  // (of a platform drawn as a way all its points – its middle is where people wait –, of the others the ends)
  const platformWays = new Set<number>();
  for (const r of routes) for (const m of r.members) if (m.type === 'w' && PLATFORM_ROLE.test(m.role)) platformWays.add(m.ref);
  for (const [id, w] of ways) {
    if (platformWays.has(id)) for (const n of w.refs) wantNodes.add(n);
    else {
      wantNodes.add(w.refs[0]);
      wantNodes.add(w.refs[w.refs.length - 1]);
    }
  }
  const nodes = new Map<number, { x: number; z: number; name: string }>();
  readPbf(input, {
    node(id, lat, lon, tags) {
      if (!wantNodes.has(id)) return;
      const [x, z] = latLonToWorld(lat, lon);
      const t = tags();
      nodes.set(id, { x, z, name: (t?.name ?? t?.ref_name ?? '').trim() });
    },
  });
  lap(`${ways.size} ways (${wantWays.size - ways.size} not in the file: beyond the border of Hesse), ${nodes.size} nodes of the routes`);
  return { total, outside, coaches, routes, master, ways, nodes };
}

/** A line as the build makes it, before it is written. */
interface Built {
  rel: RouteRel;
  ref: string;
  from: string;
  to: string;
  ways: number[];
  /** place, index into ways, metres – three each */
  stops: number[];
  link: number[];
  back: Built | null;
  group: string;
}

/** Why member ways of a route are not among the map's roads, counted per route. */
interface Missing {
  /** the file does not have it: beyond the border of Hesse */
  notInFile: number;
  /** a road for buses only (highway=busway), which the map has no lanes for */
  busway: number;
  /** beyond the region of the map */
  beyond: number;
  /** in the region, but the map has no road for it (a way that is no road for vehicles, a car park it leaves out, …) */
  other: number;
}

/** "Bus 52: Kassel Hauptbahnhof => Baunatal Stadtmitte": where from, where to. */
function endsOfName(name: string): [string, string] {
  const m = /(?::\s*)?([^:]+?)\s*(?:=>|⇒|→|->|–>)\s*(.+)$/.exec(name);
  return m ? [m[1].trim(), m[2].trim()] : ['', ''];
}

/**
 * Build buslines.json.gz in `mapDir` from the map there and what `read`
 * finds in OpenStreetMap (readRoutes; it is told which ways the map has).
 */
export function buildBusLines(mapDir: string, read: (inMap: (way: number) => boolean) => OsmRoutes, lap: (msg: string) => void): void {
  // ---- the road network: which way of OpenStreetMap each road was made of, which node each junction is
  const netBuf = gunzipSync(readFileSync(resolve(mapDir, 'net.bin.gz')));
  const net = unpackNet(netBuf.buffer.slice(netBuf.byteOffset, netBuf.byteOffset + netBuf.byteLength));
  const E = net.edgeA.length;
  const edgeOsm = new Float64Array(E);
  const nodeOsm = new Float64Array(net.nodeX.length);
  for (const f of readdirSync(resolve(mapDir, 'w'))) {
    if (!f.endsWith('.json.gz')) continue;
    const chunk = JSON.parse(gunzipSync(readFileSync(resolve(mapDir, 'w', f))).toString('utf8')) as WorldChunkJson;
    for (const [id, e] of chunk.edges) edgeOsm[id] = e.o ?? 0;
    for (const [id, n] of chunk.nodes) nodeOsm[id] = n.o ?? 0;
  }
  const generated = (JSON.parse(readFileSync(resolve(mapDir, 'map.json'), 'utf8')) as MapIndexJson).meta.generated;
  const matcher = new RouteMatcher(net, edgeOsm, nodeOsm);
  const stopsJson = JSON.parse(gunzipSync(readFileSync(resolve(mapDir, 'stops.json.gz'))).toString('utf8')) as StopsJson;
  const places = new StopPlaces(stopsJson);
  // the region of the map, in squares of a kilometre: those with a junction
  const covered = new Set<number>();
  const square = (x: number, z: number): number => (Math.floor(x / 1000) + 1000) * 4000 + Math.floor(z / 1000) + 1000;
  for (let i = 0; i < net.nodeX.length; i++) covered.add(square(net.nodeX[i], net.nodeZ[i]));
  lap(`road network: ${E} roads, ${net.nodeX.length} junctions; ${stopsJson.places.length} stop places`);

  const osm = read((w) => matcher.roadsOf(w) !== undefined);
  const { ways, nodes } = osm;
  const inRegion = (node: number): boolean => {
    const p = nodes.get(node);
    return p !== undefined && covered.has(square(p.x, p.z));
  };

  // ---- each route on the network
  const built: Built[] = [];
  const count = { complete: 0, partly: 0, none: 0, tooShort: 0, noWays: 0, mended: 0, gaps: 0, against: 0, stops: 0, stopsMissed: 0, stopsBeyond: 0, ptv1: 0 };
  const why = { leaves: 0, busway: 0, gaps: 0, against: 0, stops: 0, other: 0 };
  for (const rel of osm.routes) {
    const t = rel.tags;
    const routeWays = rel.members.filter((m) => m.type === 'w' && !/platform|stop|alternate/.test(m.role));
    const missing: Missing = { notInFile: 0, busway: 0, beyond: 0, other: 0 };
    const members = new Set<number>();
    for (const m of routeWays) {
      const roads = matcher.roadsOf(m.ref);
      if (roads) {
        for (const e of roads) members.add(e);
        continue;
      }
      const w = ways.get(m.ref);
      if (!w) missing.notInFile++;
      else if (!inRegion(w.refs[0]) && !inRegion(w.refs[w.refs.length - 1])) missing.beyond++;
      else if (w.hw === 'busway' || w.hw === 'bus_guideway') missing.busway++;
      else missing.other++;
    }
    const steps = chainRoute(
      routeWays.map((m) => ({ id: m.ref, way: ways.get(m.ref) })),
      (n) => nodes.get(n),
    );
    const seq = matcher.follow(steps);
    const res = matcher.mend(seq, members);
    let len = 0;
    for (const w of res.ways) len += net.edgeLen[w >> 1];
    if (res.ways.length < 2 || len < 300) {
      if (res.ways.length < 2) count.noWays++;
      else count.tooShort++;
      count.none++;
      continue;
    }
    // the stops, in their order along the route
    const events = stopEvents(rel.members, (m) => {
      if (m.type === 'n') return nodes.get(m.ref);
      const w = ways.get(m.ref);
      if (!w) return undefined;
      let x = 0;
      let z = 0;
      let n = 0;
      for (const r of w.refs) {
        const p = nodes.get(r);
        if (!p) continue;
        x += p.x;
        z += p.z;
        n++;
      }
      return n > 0 ? { x: x / n, z: z / n, name: w.name } : undefined;
    });
    const stops: number[] = [];
    let k0 = 0;
    let missed = 0;
    for (const ev of events) {
      const place = places.find(ev.name, ev.x, ev.z);
      // (the platforms of a bus station can lie 50 m from the middle of the road)
      const at = place >= 0 ? matcher.locate(res.ways, k0, ev.x, ev.z, 60) : null;
      if (!at) {
        // a stop beyond the map has no place in stops.json.gz, and no road of the route comes near it
        if (place < 0 && !matcher.locate(res.ways, 0, ev.x, ev.z, 60)) count.stopsBeyond++;
        else missed++;
        continue;
      }
      // (the same place twice in a row: its stop position and its platform under names that differ)
      if (stops.length >= 3 && stops[stops.length - 3] === place) continue;
      stops.push(place, at.k, Math.round(at.m));
      k0 = at.k;
    }
    count.stops += stops.length / 3;
    count.stopsMissed += missed;
    count.mended += res.mended;
    count.gaps += res.gaps;
    count.against += res.against;
    if (t['public_transport:version'] !== '2') count.ptv1++;
    const lacks = missing.notInFile + missing.beyond + missing.busway + missing.other;
    if (res.gaps === 0 && res.against === 0 && lacks === 0 && missed === 0) count.complete++;
    else {
      // (the first reason that applies)
      count.partly++;
      if (missing.notInFile + missing.beyond > 0) why.leaves++;
      else if (missing.busway > 0) why.busway++;
      else if (res.gaps > 0) why.gaps++;
      else if (res.against > 0) why.against++;
      else if (missing.other > 0) why.other++;
      else why.stops++;
    }
    const [nameFrom, nameTo] = endsOfName(t.name ?? '');
    const first = stops.length ? places.name(stops[0]) : '';
    const last = stops.length ? places.name(stops[stops.length - 3]) : '';
    built.push({
      rel,
      ref: (t.ref ?? '').trim(),
      from: (t.from ?? '').trim() || nameFrom || first,
      to: (t.to ?? '').trim() || nameTo || last,
      ways: res.ways,
      stops,
      link: [],
      back: null,
      group: osm.master.has(rel.id) ? `m${osm.master.get(rel.id)}` : `r${(t.ref ?? '').trim()}|${t.operator ?? t.network ?? ''}`,
    });
  }
  lap(
    `${built.length} lines on the network: ${count.complete} complete, ${count.partly} in part (${why.leaves} leave the map, ${why.busway} use a road for buses only, ` +
      `${why.gaps} with gaps the search could not close, ${why.against} drive against a one-way street, ${why.other} use ways the map has no road for, ${why.stops} with stops not found along them), ` +
      `${count.none} not at all (${count.noWays} without two roads of the map that join, ${count.tooShort} shorter than 300 m on it); ` +
      `${count.mended} gaps mended, ${count.gaps} left, ${count.against} pieces against a one-way street left out; ` +
      `${count.stops} stops, ${count.stopsMissed} in the region not found along the route, ${count.stopsBeyond} beyond the map; ` +
      `${count.ptv1} relations of the old scheme (both directions in one)`,
  );

  // ---- at the end of each route: where the line back (or the same line, round again) begins
  const groups = new Map<string, Built[]>();
  for (const b of built) {
    const list = groups.get(b.group);
    if (list) list.push(b);
    else groups.set(b.group, [b]);
  }
  let backs = 0;
  for (const list of groups.values()) {
    for (const L of list) {
      const end = L.ways[L.ways.length - 1];
      let best: { line: Built; link: number[]; cost: number } | null = null;
      for (const B of list) {
        const start = B.ways[0];
        if (start === end || matcher.joins(end, start)) {
          best = { line: B, link: [], cost: 0 };
          if (B !== L) break;
          continue;
        }
        // (a line often turns in a loop for buses only, which the map has as a private road: those count double)
        const found = matcher.search(end, [start], 2000, null, 2);
        if (found && (!best || found.cost < best.cost)) best = { line: B, link: found.ways.slice(0, -1), cost: found.cost };
      }
      if (!best) continue;
      L.back = best.line;
      L.link = best.link;
      backs++;
    }
  }
  lap(`${backs} lines go on as the line back at their end`);

  // ---- written: in the order of their numbers, the ways as steps from the one before
  built.sort((a, b) => a.ref.localeCompare(b.ref, 'de', { numeric: true }) || a.to.localeCompare(b.to, 'de') || a.rel.id - b.rel.id);
  const index = new Map(built.map((b, i) => [b, i]));
  const lines: BusLineJson[] = built.map((b) => {
    const w = encodeWays([...b.ways, ...b.link]);
    const t = b.rel.tags;
    const line: BusLineJson = { ref: b.ref, name: (t.name ?? '').trim(), from: b.from, to: b.to, operator: (t.operator ?? '').trim(), colour: (t.colour ?? '').trim(), kind: t.route === 'trolleybus' ? 1 : 0, osm: b.rel.id, w, st: b.stops };
    if (b.link.length > 0) line.end = b.ways.length;
    if (b.back) line.back = index.get(b.back);
    return line;
  });
  const out: BusLinesJson = { v: 1, map: generated, places: stopsJson.places.length, lines };
  const bytes = gzipSync(JSON.stringify(out), { level: 9 });
  writeFileSync(resolve(mapDir, 'buslines.json.gz'), bytes);
  const roads = lines.reduce((s, l) => s + l.w.length, 0);
  lap(`buslines.json.gz: ${lines.length} lines, ${roads} roads along them, ${count.stops} stops – ${(bytes.length / 1024).toFixed(0)} KB`);
}

if (import.meta.main) {
  const input = resolve(root, process.argv[2] ?? 'data/raw/osm/hessen-latest.osm.pbf');
  const mapDir = resolve(root, process.env.MAP_OUT ?? 'public/map');
  const t0 = Date.now();
  const lap = (msg: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);
  buildBusLines(mapDir, (inMap) => readRoutes(input, inMap, lap), lap);
}
