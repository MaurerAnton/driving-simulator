// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The road network as a route planner sees it: every road in each direction
 * it can be driven in is a "way", and from the end of each way lead the turns
 * the junction allows.  No lanes, no geometry – a few numbers per way, held
 * in plain arrays, so that the network of a whole region fits into memory
 * and can be searched quickly.
 *
 * It is derived from the lane network (`routeGraphOf`); the routes found on
 * it are lists of ways, which the navigation turns back into lanes and the
 * paths through the junctions (`connectorsAlong` in game/nav.ts).
 */
import { ACCESS, CTRL, EF } from './types.ts';
import { TURN } from './lanes.ts';
import type { LaneGraph, Lane } from './lanes.ts';

/** Properties of a way (bits of RouteGraph.kind). */
export const RG = {
  /** "Anlieger frei", a car park, a yard: to get somewhere, not to drive through */
  ACCESS_ONLY: 1,
  /** private, or for farm and forest traffic: not to be driven at all */
  NO_ENTRY: 2,
  /** a driveway, a track, a traffic-calmed street: walking pace, or not a street at all */
  MINOR: 4,
  /** it ends where the map ends */
  TO_MAP_END: 8,
  /** in a built-up area */
  URBAN: 16,
  /** part of a roundabout */
  ROUNDABOUT: 32,
  /** too narrow for two cars to pass each other */
  NARROW: 64,
} as const;

export interface RouteGraph {
  /** number of ways: one for each road and direction – way = edge * 2 + (0: from node a to b, 1: from b to a) */
  n: number;
  /** length in metres; 0: the road cannot be driven in this direction */
  len: Float32Array;
  /** seconds it takes at the speed allowed (at most 130 km/h) */
  secs: Float32Array;
  /** RG bits */
  kind: Uint8Array;
  /** road class (CLS) */
  cls: Uint8Array;
  /** where the way begins and ends (x, z) */
  x0: Float32Array;
  z0: Float32Array;
  x1: Float32Array;
  z1: Float32Array;
  /** the turns at the end of way w: entries first[w] … first[w + 1] - 1 of `to` (the way turned into), `turn` (TURN) and `across` (metres through the junction) */
  first: Uint32Array;
  to: Uint32Array;
  turn: Uint8Array;
  across: Float32Array;
  /** the same turns sorted by where they lead: the ways `from[k]` turn into way w for k = firstIn[w] … firstIn[w + 1] - 1 (`inTurn`: index into `to`) */
  firstIn: Uint32Array;
  from: Uint32Array;
  inTurn: Uint32Array;
}

/** The way a lane belongs to. */
export function wayOf(lane: Lane): number {
  return lane.edge.id * 2 + (lane.dir > 0 ? 0 : 1);
}

export function routeGraphOf(lanes: LaneGraph): RouteGraph {
  const edges = lanes.world.edges;
  const n = edges.length * 2;
  const g: RouteGraph = {
    n,
    len: new Float32Array(n),
    secs: new Float32Array(n),
    kind: new Uint8Array(n),
    cls: new Uint8Array(n),
    x0: new Float32Array(n),
    z0: new Float32Array(n),
    x1: new Float32Array(n),
    z1: new Float32Array(n),
    first: new Uint32Array(n + 1),
    to: new Uint32Array(0),
    turn: new Uint8Array(0),
    across: new Float32Array(0),
    firstIn: new Uint32Array(n + 1),
    from: new Uint32Array(0),
    inTurn: new Uint32Array(0),
  };
  const to: number[] = [];
  const turn: number[] = [];
  const across: number[] = [];
  for (const e of edges) {
    const el = lanes.edgeLanes[e.id];
    for (let d = 0; d < 2; d++) {
      const w = e.id * 2 + d;
      const list = d === 0 ? el.fwd : el.back;
      g.first[w] = to.length;
      g.cls[w] = e.cls;
      const a = d === 0 ? e.a : e.b;
      const b = d === 0 ? e.b : e.a;
      g.x0[w] = a.x;
      g.z0[w] = a.z;
      g.x1[w] = b.x;
      g.z1[w] = b.z;
      if (list.length === 0) continue;
      g.len[w] = Math.max(0.5, e.len);
      const limit = Math.min(Number.isFinite(list[0].limit) ? list[0].limit : 36, 36);
      g.secs[w] = g.len[w] / Math.max(limit, 2);
      let kind = 0;
      if (e.access === ACCESS.PRIVATE || e.access === ACCESS.AGRICULTURAL) kind |= RG.NO_ENTRY;
      if (e.access === ACCESS.DESTINATION || (e.flags & EF.MINOR_SERVICE) !== 0) kind |= RG.ACCESS_ONLY;
      if (e.tier < 2) kind |= RG.MINOR;
      if (e.laneW < 2.4) kind |= RG.NARROW;
      if (b.ctrl === CTRL.MAP_END) kind |= RG.TO_MAP_END;
      if (e.flags & EF.URBAN) kind |= RG.URBAN;
      if (e.flags & EF.ROUNDABOUT) kind |= RG.ROUNDABOUT;
      g.kind[w] = kind;
      // the turns of all its lanes: each way turned into once, by the gentlest of the paths there
      const seen = new Map<number, number>();
      for (const lane of list) {
        for (const c of lane.out) {
          const t = wayOf(c.to);
          const at = seen.get(t);
          if (at === undefined) {
            seen.set(t, to.length);
            to.push(t);
            turn.push(c.turn);
            across.push(c.len);
          } else if (c.turn === TURN.STRAIGHT && turn[at] !== TURN.STRAIGHT) turn[at] = c.turn;
        }
      }
    }
  }
  g.first[n] = to.length;
  g.to = Uint32Array.from(to);
  g.turn = Uint8Array.from(turn);
  g.across = Float32Array.from(across);
  // the turns by where they lead
  const count = new Uint32Array(n + 1);
  for (let k = 0; k < g.to.length; k++) count[g.to[k] + 1]++;
  for (let w = 0; w < n; w++) count[w + 1] += count[w];
  g.firstIn.set(count);
  g.from = new Uint32Array(g.to.length);
  g.inTurn = new Uint32Array(g.to.length);
  const fill = count.slice(0, n);
  for (let w = 0; w < n; w++) {
    for (let k = g.first[w]; k < g.first[w + 1]; k++) {
      const at = fill[g.to[k]]++;
      g.from[at] = w;
      g.inTurn[at] = k;
    }
  }
  return g;
}

/** A binary heap of (id, key) pairs, smallest key first. */
export class MinHeap {
  private ids: Uint32Array;
  private keys: Float64Array;
  size = 0;

  constructor(capacity = 1024) {
    this.ids = new Uint32Array(capacity);
    this.keys = new Float64Array(capacity);
  }

  clear(): void {
    this.size = 0;
  }

  push(id: number, key: number): void {
    if (this.size === this.ids.length) {
      const ids = new Uint32Array(this.size * 2);
      ids.set(this.ids);
      this.ids = ids;
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.keys = keys;
    }
    const ids = this.ids;
    const keys = this.keys;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }

  /** the key of the smallest pair (read before pop) */
  get topKey(): number {
    return this.keys[0];
  }

  /** Remove the smallest pair and return its id. */
  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0];
    const n = --this.size;
    if (n > 0) {
      const id = ids[n];
      const key = keys[n];
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}

/** What a turn costs on top of the time it takes: seconds. */
function turnSeconds(g: RouteGraph, w: number, k: number): number {
  const t = g.turn[k];
  if (t === TURN.LEFT) return 6;
  if (t === TURN.RIGHT) return 3;
  // turning round is for when there is no other way – least of all where the map ends
  if (t === TURN.UTURN) return g.kind[w] & RG.TO_MAP_END ? 900 : 150;
  return 0;
}

/**
 * The quickest route from the end of way `start` to way `goal`: the ways to
 * drive along after `start`, `goal` last – or null when there is none.
 * Private roads are not used (the goal itself may be one); "Anlieger frei"
 * and car parks are no short cuts.
 */
export function quickest(g: RouteGraph, start: number, goal: number): number[] | null {
  return quickestTimed(g, start, goal)?.ways ?? null;
}

/** The same to a road, whichever way it is then driven along: the quicker of the two. */
export function quickestToEdge(g: RouteGraph, start: number, edge: number): number[] | null {
  const a = g.len[edge * 2] > 0 ? quickestTimed(g, start, edge * 2) : null;
  const b = g.len[edge * 2 + 1] > 0 ? quickestTimed(g, start, edge * 2 + 1) : null;
  if (a && b) return a.secs <= b.secs ? a.ways : b.ways;
  return (a ?? b)?.ways ?? null;
}

function quickestTimed(g: RouteGraph, start: number, goal: number): { ways: number[]; secs: number } | null {
  if (start === goal) return { ways: [], secs: 0 };
  const dist = new Float64Array(g.n).fill(Infinity);
  const prev = new Int32Array(g.n).fill(-1);
  const heap = new MinHeap();
  // straight-line time at motorway speed never overestimates
  const gx = g.x1[goal];
  const gz = g.z1[goal];
  const rest = (w: number): number => Math.hypot(g.x1[w] - gx, g.z1[w] - gz) / 36;
  dist[start] = 0;
  heap.push(start, rest(start));
  while (heap.size > 0) {
    const key = heap.topKey;
    const w = heap.pop();
    if (w === goal) break;
    const d = dist[w];
    if (key > d + rest(w) + 1e-6) continue;
    for (let k = g.first[w]; k < g.first[w + 1]; k++) {
      const t = g.to[k];
      if (t !== goal && (g.kind[t] & RG.NO_ENTRY) !== 0) continue;
      const through = t !== goal && (g.kind[t] & RG.ACCESS_ONLY) !== 0 ? 240 : 0;
      const nd = d + g.across[k] / 6 + g.secs[t] + turnSeconds(g, w, k) + through;
      if (nd < dist[t]) {
        dist[t] = nd;
        prev[t] = w;
        heap.push(t, nd + rest(t));
      }
    }
  }
  if (!Number.isFinite(dist[goal])) return null;
  const path: number[] = [];
  for (let w = goal; w !== start; w = prev[w]) {
    if (w < 0) return null;
    path.push(w);
  }
  return { ways: path.reverse(), secs: dist[goal] };
}

/**
 * The ways of the network one can drive around in: from each of them every
 * other can be reached and it from them, by public roads.  (A village joined
 * to the rest by a farm track only, a yard behind a gate, are not part of it.)
 */
export function mainWays(g: RouteGraph): Uint8Array {
  // from the longest of the bigger roads that can be driven both ways
  let seed = -1;
  for (let w = 0; w < g.n; w += 2) {
    if (g.cls[w] < 4 || g.cls[w] > 8 || g.len[w] === 0 || g.len[w + 1] === 0) continue;
    if (seed < 0 || g.len[w] > g.len[seed]) seed = w;
  }
  const out = new Uint8Array(g.n);
  if (seed < 0) return out;
  const there = new Uint8Array(g.n);
  const back = new Uint8Array(g.n);
  const stack = [seed];
  there[seed] = 1;
  while (stack.length) {
    const w = stack.pop() as number;
    for (let k = g.first[w]; k < g.first[w + 1]; k++) {
      const v = g.to[k];
      if (!there[v] && (g.kind[v] & RG.NO_ENTRY) === 0) {
        there[v] = 1;
        stack.push(v);
      }
    }
  }
  stack.push(seed);
  back[seed] = 1;
  while (stack.length) {
    const w = stack.pop() as number;
    for (let p = g.firstIn[w]; p < g.firstIn[w + 1]; p++) {
      const v = g.from[p];
      if (!back[v] && (g.kind[v] & RG.NO_ENTRY) === 0) {
        back[v] = 1;
        stack.push(v);
      }
    }
  }
  for (let w = 0; w < g.n; w++) out[w] = there[w] & back[w];
  return out;
}
