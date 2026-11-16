// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A tour of the streets: a way of about a given length, from a road back to
 * it or on to another one, that leads through as many different streets as
 * it can and along as few of them twice.
 *
 * Finding the best such way is hard (it is a cousin of the Chinese postman's
 * and the orienteering problem), so it is looked for: the tour is walked
 * street by street, at each junction turning into a street not driven yet –
 * the one from which the walk can best go on through new streets –, and when
 * there is none, driving to the nearest new street the remaining length
 * still allows.  It always keeps enough length to get to the end.  This is
 * done many times with different inclinations (and some chance), and the
 * tour with the most new street is kept.
 *
 * It works on the route graph (world/routegraph.ts): no turning round, no
 * private roads, no yards and car parks, no walking-pace streets.  Motorways
 * are used to get somewhere, but are not what the tour is after.
 */
import { CLS } from '../world/types.ts';
import { TURN } from '../world/lanes.ts';
import { MinHeap, RG } from '../world/routegraph.ts';
import type { RouteGraph } from '../world/routegraph.ts';

export interface TourPlan {
  /** the ways to drive along, one after the other, after the one the tour starts on */
  ways: number[];
  /** its length in metres, */
  metres: number;
  /** of which along streets for the first time, */
  fresh: number;
  /** and along streets driven before (on this tour, or known already) */
  again: number;
  /** the new metres weighed by how welcome each street was (the wishes, see TourOptions.like) */
  valued: number;
}

export interface TourOptions {
  /** roads (by edge) that are known already: driving them is nothing new */
  known?: (edge: number) => boolean;
  /** how long to look for a better tour, in milliseconds */
  budgetMs?: number;
  /** for the chance in it: the same seed gives the same tour */
  seed?: number;
  /** ways the tour must not use (a motorway, a main road – as the driver wishes) */
  avoid?: (way: number) => boolean;
  /** how welcome a road (by edge) is as a new street of the tour: 1 as any, 0 not looked for, 2 twice as welcome */
  like?: (edge: number) => number;
}

/** small deterministic generator of numbers in 0 … 1 */
function chance(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** May a tour lead along this way? */
function tourable(g: RouteGraph, w: number): boolean {
  return g.len[w] > 0 && (g.kind[w] & (RG.NO_ENTRY | RG.ACCESS_ONLY | RG.MINOR)) === 0;
}

/**
 * Plan a tour of about `metres` that starts at the end of way `start` and
 * ends with way `goal` (the same way: a round trip).  Null when the end
 * cannot be reached from the start without turning round.
 */
export function planTour(g: RouteGraph, start: number, goal: number, metres: number, opt: TourOptions = {}): TourPlan | null {
  const it = planner(g, start, goal, metres, opt);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/**
 * The same, a slice at a time: a long tour takes the phone a while to work
 * out, and the page stays alive meanwhile – `progress` is told how far it is
 * (0 … 1) between the slices.
 */
export async function planTourInSlices(g: RouteGraph, start: number, goal: number, metres: number, opt: TourOptions & { progress?: (share: number) => void; sliceMs?: number } = {}): Promise<TourPlan | null> {
  const it = planner(g, start, goal, metres, opt);
  const slice = opt.sliceMs ?? 30;
  let t0 = performance.now();
  let r = it.next();
  while (!r.done) {
    if (performance.now() - t0 > slice) {
      opt.progress?.(r.value);
      await new Promise((ok) => setTimeout(ok, 0));
      t0 = performance.now();
    }
    r = it.next();
  }
  opt.progress?.(1);
  return r.value;
}

/** The planning itself: it stops now and then to say how far it is (a share of 0 … 1). */
function* planner(g: RouteGraph, start: number, goal: number, metres: number, opt: TourOptions): Generator<number, TourPlan | null> {
  const n = g.n;
  const ok = new Uint8Array(n);
  for (let w = 0; w < n; w++) ok[w] = tourable(g, w) && !opt.avoid?.(w) ? 1 : 0;
  // A tour may begin and end where a tour does not otherwise lead – on a car park, in a yard, on a
  // private road, in a traffic-calmed street: the ways from the start out to the streets, and from
  // the streets in to the end, may be driven (they are not what the tour is after).
  const open = (first: number, forward: boolean): void => {
    const stack = [first];
    const seen = new Set<number>([first]);
    while (stack.length > 0) {
      const w = stack.pop() as number;
      if (w !== first && tourable(g, w)) continue;
      if (g.len[w] > 0) ok[w] = 1;
      if (forward) {
        for (let k = g.first[w]; k < g.first[w + 1]; k++) {
          const v = g.to[k];
          if (g.turn[k] !== TURN.UTURN && !seen.has(v) && g.len[v] > 0 && seen.size < 400) {
            seen.add(v);
            stack.push(v);
          }
        }
      } else {
        for (let p = g.firstIn[w]; p < g.firstIn[w + 1]; p++) {
          const v = g.from[p];
          if (g.turn[g.inTurn[p]] !== TURN.UTURN && !seen.has(v) && g.len[v] > 0 && seen.size < 400) {
            seen.add(v);
            stack.push(v);
          }
        }
      }
    }
  };
  open(start, true);
  open(goal, false);
  ok[goal] = g.len[goal] > 0 ? 1 : 0;

  // --- how far it is from the end of each way to the end of the tour (metres, without turning round) ---
  const home = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap(4096);
  home[goal] = 0;
  heap.push(goal, 0);
  let settled = 0;
  while (heap.size > 0) {
    const key = heap.topKey;
    const w = heap.pop();
    if (key > home[w]) continue;
    if ((++settled & 1023) === 0) yield Math.min(0.1, (settled / n) * 0.1);
    for (let p = g.firstIn[w]; p < g.firstIn[w + 1]; p++) {
      const v = g.from[p];
      const k = g.inTurn[p];
      if (g.turn[k] === TURN.UTURN || (!ok[v] && v !== start)) continue;
      const nd = home[w] + g.across[k] + g.len[w];
      if (nd < home[v]) {
        home[v] = nd;
        heap.push(v, nd);
      }
    }
  }
  if (!Number.isFinite(home[start])) return null;

  // --- what is new: every road once, whichever way it is driven; motorways are not what a tour is for ---
  const edges = n >> 1;
  const fresh0 = new Uint8Array(edges);
  /** how welcome each road is as a new street (the wishes of the driver) */
  const worth = new Float32Array(edges).fill(1);
  for (let e = 0; e < edges; e++) {
    const w = tourable(g, e * 2) ? e * 2 : tourable(g, e * 2 + 1) ? e * 2 + 1 : -1;
    if (w < 0 || g.cls[w] <= CLS.TRUNK_LINK) continue;
    if (opt.known?.(e)) continue;
    if (opt.like) worth[e] = Math.max(0, opt.like(e));
    if (worth[e] < 0.05) continue;
    fresh0[e] = 1;
  }
  fresh0[start >> 1] = 0;
  const sx = g.x1[start];
  const sz = g.z1[start];

  // --- searching for the nearest new street from a way (metres) ---
  const dist = new Float64Array(n);
  const stamp = new Uint32Array(n);
  const prev = new Int32Array(n);
  let round = 0;
  const toNearestFresh = (from: number, left: number, fresh: Uint8Array): number[] | null => {
    round++;
    heap.clear();
    dist[from] = 0;
    stamp[from] = round;
    prev[from] = -1;
    heap.push(from, 0);
    while (heap.size > 0) {
      const key = heap.topKey;
      const w = heap.pop();
      if (key > dist[w]) continue;
      if (w !== from && fresh[w >> 1]) {
        const path: number[] = [];
        for (let v = w; v !== from; v = prev[v]) path.push(v);
        return path.reverse();
      }
      for (let k = g.first[w]; k < g.first[w + 1]; k++) {
        const v = g.to[k];
        if (!ok[v] || g.turn[k] === TURN.UTURN) continue;
        const nd = dist[w] + g.across[k] + g.len[v];
        // (only what leaves enough to get to the end from there)
        if (nd + home[v] > left) continue;
        if (stamp[v] !== round || nd < dist[v]) {
          stamp[v] = round;
          dist[v] = nd;
          prev[v] = w;
          heap.push(v, nd);
        }
      }
    }
    return null;
  };

  /** how far the planning is: the first walk is most of it, the further ones fill the time it may take */
  let share = 0.1;
  let first = true;
  const t0 = Date.now();
  /** One walk.  `lean`: how much it is drawn to streets with few ways on, to staying near the start, to turning right; `depth`: how far it looks ahead. */
  const walk = function* (rand: () => number, lean: { few: number; near: number; right: number; noise: number; depth: number }): Generator<number, TourPlan> {
    const fresh = fresh0.slice();
    const ways: number[] = [];
    let used = 0;
    let gain = 0;
    let w = start;
    const touched: number[] = [];
    /** new metres a simple walk on from way v gathers within `depth` streets (v itself not counted) */
    const onward = (v: number, left: number, depth: number): number => {
      let got = 0;
      let cur = v;
      for (let step = 0; step < depth; step++) {
        let best = -1;
        let bl = 0;
        let bk = 0;
        for (let k = g.first[cur]; k < g.first[cur + 1]; k++) {
          const u = g.to[k];
          if (!ok[u] || !fresh[u >> 1] || g.turn[k] === TURN.UTURN) continue;
          const cost = g.across[k] + g.len[u];
          if (cost + home[u] > left) continue;
          if (g.len[u] * worth[u >> 1] > bl) {
            bl = g.len[u] * worth[u >> 1];
            best = u;
            bk = k;
          }
        }
        if (best < 0) break;
        got += bl;
        left -= g.across[bk] + g.len[best];
        fresh[best >> 1] = 0;
        touched.push(best >> 1);
        cur = best;
      }
      for (const e of touched) fresh[e] = 1;
      touched.length = 0;
      return got;
    };
    let valued = 0;
    const take = (v: number, cost: number): void => {
      ways.push(v);
      used += cost;
      if (fresh[v >> 1]) {
        gain += g.len[v];
        valued += g.len[v] * worth[v >> 1];
        fresh[v >> 1] = 0;
      }
      w = v;
    };
    for (let guard = 0; guard < 400000; guard++) {
      if ((guard & 15) === 0) yield first ? 0.1 + 0.75 * Math.min(1, used / Math.max(metres, 1)) : share;
      const left = metres - used;
      let best = -1;
      let bestCost = 0;
      let bestScore = -Infinity;
      for (let k = g.first[w]; k < g.first[w + 1]; k++) {
        const v = g.to[k];
        if (!ok[v] || !fresh[v >> 1] || g.turn[k] === TURN.UTURN) continue;
        const cost = g.across[k] + g.len[v];
        if (cost + home[v] > left) continue;
        // how many new streets lead on from it: one that is nearly closed in is taken while we are here
        let exits = 0;
        for (let k2 = g.first[v]; k2 < g.first[v + 1]; k2++) if (ok[g.to[k2]] && fresh[g.to[k2] >> 1] && g.turn[k2] !== TURN.UTURN && g.to[k2] >> 1 !== v >> 1) exits++;
        fresh[v >> 1] = 0;
        const ahead = onward(v, left - cost, lean.depth);
        fresh[v >> 1] = 1;
        const far = Math.hypot(g.x1[v] - sx, g.z1[v] - sz);
        const score =
          (g.len[v] * worth[v >> 1] + ahead) / (cost + ahead + 1) +
          lean.few / (1 + exits) -
          (lean.near * far) / Math.max(400, metres * 0.25) +
          (g.turn[k] === TURN.RIGHT ? lean.right : 0) +
          rand() * lean.noise;
        if (score > bestScore) {
          bestScore = score;
          best = v;
          bestCost = cost;
        }
      }
      if (best >= 0) {
        take(best, bestCost);
        continue;
      }
      const path = toNearestFresh(w, left, fresh);
      if (path) {
        for (const v of path) {
          let cost = g.len[v];
          for (let k = g.first[w]; k < g.first[w + 1]; k++) if (g.to[k] === v) cost += g.across[k];
          take(v, cost);
        }
        continue;
      }
      break;
    }
    // --- to the end: always downhill in the distance still to go ---
    for (let guard = 0; guard < 100000 && !(w === goal && ways.length > 0 && home[w] === 0 && used > 0); guard++) {
      if (w === goal && ways.length > 0) break;
      let best = -1;
      let bestCost = 0;
      let bd = Infinity;
      for (let k = g.first[w]; k < g.first[w + 1]; k++) {
        const v = g.to[k];
        if (!ok[v] || g.turn[k] === TURN.UTURN) continue;
        const cost = g.across[k] + g.len[v];
        if (cost + home[v] < bd) {
          bd = cost + home[v];
          best = v;
          bestCost = cost;
        }
      }
      if (best < 0) break;
      take(best, bestCost);
    }
    return { ways, metres: used, fresh: gain, again: used - gain, valued };
  };

  const rand = chance(opt.seed ?? 1);
  const until = Date.now() + (opt.budgetMs ?? 350);
  let bestPlan: TourPlan | null = null;
  for (let i = 0; i < 400; i++) {
    const lean =
      i === 0
        ? { few: 0.5, near: 0.35, right: 0.05, noise: 0.02, depth: 6 }
        : { few: rand() * 1.2, near: rand() * 0.9, right: rand() * 0.2 - 0.05, noise: 0.02 + rand() * 0.25, depth: 2 + Math.floor(rand() * 9) };
    const plan = yield* walk(rand, lean);
    first = false;
    share = Math.max(share, 0.85 + 0.15 * Math.min(1, (Date.now() - t0) / Math.max(opt.budgetMs ?? 350, 1)));
    // must end where it is meant to
    if (plan.ways.length > 0 && plan.ways[plan.ways.length - 1] !== goal) continue;
    // (the best: the most of what was wished for – new streets, and of the kind asked for)
    if (!bestPlan || plan.valued > bestPlan.valued + 1 || (Math.abs(plan.valued - bestPlan.valued) <= 1 && plan.metres < bestPlan.metres)) bestPlan = plan;
    if (Date.now() > until) break;
  }
  // (nowhere to go from the start but by turning round: no tour)
  return bestPlan && bestPlan.ways.length > 0 ? bestPlan : null;
}
