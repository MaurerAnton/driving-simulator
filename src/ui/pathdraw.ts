// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Drawing the way on the big map: the player draws with a finger or the
 * mouse how the car is to drive, and the line is laid onto the roads – the
 * car then drives exactly that way by itself (or the player drives it and is
 * shown the way), as along a planned tour (game.ts startTrip).
 *
 * Laying the line onto the roads (`matchStroke`) is what navigation devices
 * call map matching.  The line is sampled every few metres; for each sample
 * the roads near it are the candidates – each in the direction it may be
 * driven and that agrees with the direction of drawing; then, from the first
 * sample to the last, the chain of candidates is chosen whose way along the
 * roads is closest to the line drawn (a Viterbi search): each candidate costs
 * its distance from the line and its angle to it, each step from one sample
 * to the next costs how much longer the way by the road is than the line
 * between them.  Two samples on different roads are joined by the shortest
 * legal way between them – along the turns the junctions allow, from the
 * route planner's network (src/world/routegraph.ts), U-turns only where
 * nothing else leads there.
 */
import { MinHeap, RG } from '../world/routegraph.ts';
import type { RouteGraph } from '../world/routegraph.ts';
import { TURN } from '../world/lanes.ts';
import { netPolyline } from '../world/netfile.ts';
import type { NetIndex } from '../world/netindex.ts';
import type { World } from '../world/world.ts';
import type { TourPreview } from './bigmap.ts';
import { formatUnit, tr } from '../i18n/index.ts';

/** The roads as the matching sees them. */
export interface RoadSource {
  /** the route planner's network: ways, their lengths and the turns between them */
  g: RouteGraph;
  /** visit the roads (their numbers: way = road * 2 + direction) that come near a rectangle */
  roadsIn(minX: number, minZ: number, maxX: number, maxZ: number, visit: (road: number) => void): void;
  /** the course of a road from its junction a to b: x, z, x, z, … (null: not known) */
  course(road: number): ArrayLike<number> | null;
  /** may this way be used (part of the network one can drive around in)? – missing: every way that can be driven */
  usable?(way: number): boolean;
}

/** The roads of the whole map (a map in pieces: NetIndex), else the roads loaded (a map in one piece). */
export function roadSource(g: RouteGraph, net: NetIndex | null, world: World): RoadSource {
  if (net) {
    return {
      g,
      roadsIn: (a, b, c, d, visit) => net.edgesInBox(a, b, c, d, visit),
      course: (e) => netPolyline(net.net, e),
      usable: (w) => net.main[w] === 1,
    };
  }
  return {
    g,
    roadsIn: (a, b, c, d, visit) => world.edgesInBox(a, b, c, d, (e) => visit(e.id)),
    course: (e) => {
      const p = world.edges[e]?.pl.pts;
      if (!p) return null;
      const out: number[] = [];
      for (let i = 0; i + 2 < p.length; i += 3) out.push(p[i], p[i + 2]);
      return out;
    },
  };
}

/** A drawn line laid onto the roads. */
export interface MatchedPath {
  /** the ways to drive, in order – the first is the one the drawing begins on */
  ways: number[];
  /** its line along the roads, x, z, … from where the drawing begins to where it ends */
  line: Float32Array;
  metres: number;
  /** where it begins and ends, and which way the road runs there (yaw: 0 north, positive to the left) */
  start: { x: number; z: number; yaw: number };
  end: { x: number; z: number; yaw: number };
}

export interface MatchOptions {
  /** metres between the samples of the line (default: 15, more on a long line) */
  step?: number;
  /** how far from the line a road may be to count (m, default 35) */
  radius?: number;
}

/** a road's course with the metres along it */
interface Course {
  pts: ArrayLike<number>;
  cum: Float64Array;
  len: number;
}

/** A candidate: a way near a sample, where on it (metres along it, in its direction) and what it costs. */
interface Cand {
  w: number;
  s: number;
  len: number;
  x: number;
  z: number;
  cost: number;
}

/** the most candidates kept per sample */
const MAX_CANDS = 6;
/** what a U-turn on the way between two samples costs (m), and a way "for access only" used to get through */
const UTURN_M = 150;
const ACCESS_M = 60;

function courseOf(pts: ArrayLike<number>): Course {
  const n = pts.length >> 1;
  const cum = new Float64Array(Math.max(1, n));
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  return { pts, cum, len: n > 0 ? cum[n - 1] : 0 };
}

/** The point of a course nearest to (x, z): how far, how far along, and the direction of the course there (a to b). */
function project(c: Course, x: number, z: number): { d: number; s: number; px: number; pz: number; tx: number; tz: number } {
  const p = c.pts;
  const n = p.length >> 1;
  let best = { d: Infinity, s: 0, px: p[0], pz: p[1], tx: 0, tz: -1 };
  for (let i = 0; i + 1 < n; i++) {
    const ax = p[i * 2];
    const az = p[i * 2 + 1];
    const dx = p[i * 2 + 2] - ax;
    const dz = p[i * 2 + 3] - az;
    const l2 = dx * dx + dz * dz;
    if (l2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.d) {
      const l = Math.sqrt(l2);
      best = { d, s: c.cum[i] + l * t, px, pz, tx: dx / l, tz: dz / l };
    }
  }
  return best;
}

/** A way's course in the direction it is driven: the road's, turned round for direction 1. */
function wayPoints(c: Course, w: number): number[] {
  const p = c.pts;
  const out: number[] = [];
  if ((w & 1) === 0) for (let i = 0; i + 1 < p.length; i += 2) out.push(p[i], p[i + 1]);
  else for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
  return out;
}

/** The piece of a way's course (in its direction) from `a` to `b` metres along it, appended to `out` (x, z, …). */
function appendPiece(pts: number[], a: number, b: number, out: number[]): void {
  const n = pts.length >> 1;
  let at = 0;
  const push = (x: number, z: number): void => {
    const k = out.length;
    if (k >= 2 && Math.abs(out[k - 2] - x) < 0.01 && Math.abs(out[k - 1] - z) < 0.01) return;
    out.push(x, z);
  };
  for (let i = 0; i + 1 < n; i++) {
    const ax = pts[i * 2];
    const az = pts[i * 2 + 1];
    const dx = pts[i * 2 + 2] - ax;
    const dz = pts[i * 2 + 3] - az;
    const l = Math.hypot(dx, dz);
    const from = at;
    const to = at + l;
    at = to;
    if (l < 1e-9 || to < a || from > b) continue;
    const t0 = Math.max(0, (a - from) / l);
    const t1 = Math.min(1, (b - from) / l);
    push(ax + dx * t0, az + dz * t0);
    push(ax + dx * t1, az + dz * t1);
  }
}

/** Samples of a line every `step` metres (its first and last point among them). */
function resample(points: ArrayLike<number>, step: number): number[] {
  const n = points.length >> 1;
  const out: number[] = [];
  if (n === 0) return out;
  out.push(points[0], points[1]);
  let carry = 0;
  for (let i = 1; i < n; i++) {
    const ax = points[i * 2 - 2];
    const az = points[i * 2 - 1];
    const dx = points[i * 2] - ax;
    const dz = points[i * 2 + 1] - az;
    const l = Math.hypot(dx, dz);
    if (l < 1e-9) continue;
    let at = step - carry;
    while (at <= l) {
      out.push(ax + (dx * at) / l, az + (dz * at) / l);
      at += step;
    }
    carry = l - (at - step);
  }
  const k = out.length;
  const lx = points[n * 2 - 2];
  const lz = points[n * 2 - 1];
  if (Math.hypot(out[k - 2] - lx, out[k - 1] - lz) > step * 0.3) out.push(lx, lz);
  else if (k > 2) {
    out[k - 2] = lx;
    out[k - 1] = lz;
  }
  return out;
}

/**
 * The shortest legal ways from the end of way `from` to the start of each
 * way in `goals`, within `limit` metres: for each way reached, the metres to
 * its start and the way before it.  (Dijkstra on the turns the junctions
 * allow; a way may be reached again through a loop, also `from` itself.)
 */
function search(g: RouteGraph, from: number, goals: ReadonlySet<number>, limit: number, usable?: (w: number) => boolean): { dist: Map<number, number>; prev: Map<number, number>; uturns: Map<number, number> } {
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const uturns = new Map<number, number>();
  const heap = new MinHeap(64);
  // (the start is the end of `from`: its own entry is −1 so that a way back round to it counts)
  const relax = (w: number, end: number, u: number): void => {
    for (let k = g.first[w]; k < g.first[w + 1]; k++) {
      const t = g.to[k];
      const goal = goals.has(t);
      if (!(g.len[t] > 0) || (!goal && ((g.kind[t] & RG.NO_ENTRY) !== 0 || (usable && !usable(t))))) continue;
      const turn = g.turn[k] === TURN.UTURN;
      const nd = end + g.across[k] + (turn ? UTURN_M : 0) + (!goal && (g.kind[t] & RG.ACCESS_ONLY) !== 0 ? ACCESS_M : 0);
      if (nd > limit) continue;
      const old = dist.get(t);
      if (old === undefined || nd < old) {
        dist.set(t, nd);
        prev.set(t, w);
        uturns.set(t, u + (turn ? 1 : 0));
        heap.push(t, nd);
      }
    }
  };
  relax(from, 0, 0);
  let found = 0;
  while (heap.size > 0) {
    const key = heap.topKey;
    const w = heap.pop();
    const d = dist.get(w) ?? Infinity;
    if (key > d + 1e-6) continue;
    if (goals.has(w) && ++found >= goals.size) break;
    relax(w, d + g.len[w], uturns.get(w) ?? 0);
  }
  return { dist, prev, uturns };
}

/** The ways after `from` up to `goal` (the goal last), from a search's `prev`. */
function pathTo(prev: Map<number, number>, from: number, goal: number): number[] {
  const out: number[] = [];
  let w = goal;
  for (let guard = 0; guard < 100000; guard++) {
    out.push(w);
    const p = prev.get(w);
    if (p === undefined) return [];
    if (p === from) break;
    w = p;
  }
  return out.reverse();
}

/**
 * Lay a line drawn on the map (x, z, x, z, … in the order it was drawn) onto
 * the roads: the ways to drive, and the line along them.  Null when no road
 * is near enough to it.
 */
export function matchStroke(points: ArrayLike<number>, roads: RoadSource, opt: MatchOptions = {}): MatchedPath | null {
  const g = roads.g;
  let drawn = 0;
  for (let i = 2; i + 1 < points.length; i += 2) drawn += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
  if (points.length < 2) return null;
  const step = opt.step ?? Math.max(15, Math.min(60, drawn / 300));
  const R = opt.radius ?? 35;
  const smp = resample(points, step);
  const n = smp.length >> 1;
  const courses = new Map<number, Course | null>();
  const course = (e: number): Course | null => {
    let c = courses.get(e);
    if (c === undefined) {
      const pts = roads.course(e);
      c = pts && pts.length >= 4 ? courseOf(pts) : null;
      courses.set(e, c);
    }
    return c;
  };

  // --- the candidates of each sample
  const layers: Array<{ i: number; cands: Cand[] }> = [];
  for (let i = 0; i < n; i++) {
    const x = smp[i * 2];
    const z = smp[i * 2 + 1];
    // the direction of drawing here: from the sample before to the one after
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let dx = smp[b * 2] - smp[a * 2];
    let dz = smp[b * 2 + 1] - smp[a * 2 + 1];
    const dl = Math.hypot(dx, dz);
    if (dl > 1e-6) {
      dx /= dl;
      dz /= dl;
    } else dx = dz = 0;
    const cands: Cand[] = [];
    roads.roadsIn(x - R, z - R, x + R, z + R, (e) => {
      const c = course(e);
      if (!c) return;
      const pr = project(c, x, z);
      if (pr.d > R) return;
      for (let dir = 0; dir < 2; dir++) {
        const w = e * 2 + dir;
        if (!(g.len[w] > 0) || (g.kind[w] & RG.NO_ENTRY) !== 0 || (roads.usable && !roads.usable(w))) continue;
        const tx = dir === 0 ? pr.tx : -pr.tx;
        const tz = dir === 0 ? pr.tz : -pr.tz;
        const cos = dx || dz ? tx * dx + tz * dz : 1;
        // (against the direction of drawing: not this way – a one-way street drawn the wrong way round is driven round)
        if (cos < -0.25) continue;
        cands.push({ w, s: dir === 0 ? pr.s : c.len - pr.s, len: c.len, x: pr.px, z: pr.pz, cost: (pr.d / R) ** 2 * 3 + (1 - cos) * 2 });
      }
    });
    if (cands.length === 0) continue;
    cands.sort((p, q) => p.cost - q.cost);
    // (the same way twice – a road whose course comes near twice – once, the better)
    const seen = new Set<number>();
    const keep: Cand[] = [];
    for (const c of cands) {
      if (seen.has(c.w)) continue;
      seen.add(c.w);
      keep.push(c);
      if (keep.length >= MAX_CANDS) break;
    }
    layers.push({ i, cands: keep });
  }
  if (layers.length === 0) return null;

  // --- the best chain of candidates (Viterbi): each step costs the detour of the way by the road over the line
  interface Step {
    cost: number;
    back: number;
    path: number[];
  }
  const nodes: Step[][] = [layers[0].cands.map((c) => ({ cost: c.cost, back: -1, path: [] }))];
  const kept: Array<{ i: number; cands: Cand[] }> = [layers[0]];
  for (let li = 1; li < layers.length; li++) {
    const prevLayer = kept[kept.length - 1];
    const prevNodes = nodes[nodes.length - 1];
    const layer = layers[li];
    const D = Math.hypot(smp[layer.i * 2] - smp[prevLayer.i * 2], smp[layer.i * 2 + 1] - smp[prevLayer.i * 2 + 1]);
    const goals = new Set(layer.cands.map((c) => c.w));
    const advance = (limit: number): Step[] => {
      const out: Step[] = layer.cands.map(() => ({ cost: Infinity, back: -1, path: [] }));
      prevLayer.cands.forEach((ca, ai) => {
        const base = prevNodes[ai].cost;
        if (!Number.isFinite(base)) return;
        let found: ReturnType<typeof search> | null = null;
        layer.cands.forEach((cb, bi) => {
          let L: number;
          let path: number[];
          let u = 0;
          if (cb.w === ca.w && cb.s >= ca.s - 3) {
            // on along the same way
            L = Math.max(0, cb.s - ca.s);
            path = [];
          } else {
            found ??= search(g, ca.w, goals, limit, roads.usable);
            const d = found.dist.get(cb.w);
            if (d === undefined) return;
            L = ca.len - ca.s + d + cb.s;
            path = pathTo(found.prev, ca.w, cb.w);
            if (path.length === 0) return;
            u = found.uturns.get(cb.w) ?? 0;
          }
          const cost = base + cb.cost + Math.abs(L - D) / 10 + u * 5;
          if (cost < out[bi].cost) out[bi] = { cost, back: ai, path };
        });
      });
      return out;
    };
    let next = advance(Math.max(250, 3 * D + 120));
    // nothing leads there within reach: once more, further – else the sample is left out
    if (!next.some((q) => Number.isFinite(q.cost))) next = advance(Math.max(4000, 6 * D));
    if (!next.some((q) => Number.isFinite(q.cost))) continue;
    nodes.push(next);
    kept.push(layer);
  }

  // --- back from the best end: the chain, then the ways and the line along them
  const last = nodes[nodes.length - 1];
  let bi = 0;
  for (let k = 1; k < last.length; k++) if (last[k].cost < last[bi].cost) bi = k;
  const chain: Array<{ c: Cand; path: number[] }> = [];
  for (let li = nodes.length - 1; li >= 0; li--) {
    const node = nodes[li][bi];
    chain.push({ c: kept[li].cands[bi], path: node.path });
    bi = node.back;
  }
  chain.reverse();
  const first = chain[0].c;
  const ways = [first.w];
  // the pieces driven: way, from, to (metres along it)
  const pieces: Array<{ w: number; a: number; b: number }> = [{ w: first.w, a: first.s, b: first.len }];
  for (let k = 1; k < chain.length; k++) {
    const { c, path } = chain[k];
    if (path.length === 0) continue;
    for (const w of path) {
      const len = course(w >> 1)?.len ?? 0;
      ways.push(w);
      pieces.push({ w, a: 0, b: len });
    }
  }
  const end = chain[chain.length - 1].c;
  pieces[pieces.length - 1].b = end.s;
  const line: number[] = [];
  let metres = 0;
  for (const p of pieces) {
    const c = course(p.w >> 1);
    if (!c || p.b <= p.a) continue;
    appendPiece(wayPoints(c, p.w), p.a, p.b, line);
    metres += p.b - p.a;
  }
  if (metres < 5 || line.length < 4) return null;
  const yawAt = (i: number, j: number): number => Math.atan2(-(line[j] - line[i]), -(line[j + 1] - line[i + 1]));
  const L = line.length;
  return {
    ways,
    line: Float32Array.from(line),
    metres,
    start: { x: line[0], z: line[1], yaw: yawAt(0, 2) },
    end: { x: line[L - 2], z: line[L - 1], yaw: yawAt(L - 4, L - 2) },
  };
}

/** A matched way as the game drives a planned tour along it (startTrip): from its first way on. */
export function previewOf(m: MatchedPath): TourPreview {
  return {
    plan: { ways: m.ways.slice(1), metres: m.metres, fresh: m.metres, again: 0, valued: m.metres },
    line: m.line,
    from: m.ways[0],
    end: { name: '', x: m.end.x, z: m.end.z, yaw: m.end.yaw, kind: 'street' },
  };
}

// ---------------------------------------------------------------- drawing on the map

export interface PathDrawHost {
  lang(): string;
  /** the roads (null: those of the whole map are not read yet) */
  roads(): RoadSource | null;
  /** a point of the screen (client px) on the map */
  toWorld(clientX: number, clientY: number): [number, number];
  /** move the map by screen pixels, zoom it round a point of the screen */
  pan(dx: number, dy: number): void;
  zoom(factor: number, clientX: number, clientY: number): void;
  redraw(): void;
  /** drawing begins or ends: the panel for planning makes room, and comes back */
  mode(on: boolean): void;
  /** drive the way: by itself, or the player drives and is shown the way */
  drive(way: TourPreview, self: boolean): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** The drawing mode of the big map: the strokes, the way they make, and the buttons for it. */
export class PathDrawer {
  private readonly host: PathDrawHost;
  /** the strokes drawn (world x, z, …), in their order – kept while the map is closed */
  private strokes: number[][] = [];
  private cur: number[] | null = null;
  private match: MatchedPath | null = null;
  private note = '';
  private active = false;
  private canvas: HTMLCanvasElement | null = null;
  private root: HTMLElement | null = null;
  private banner: HTMLElement | null = null;
  private readonly fingers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private lastPx = { x: 0, y: 0 };

  constructor(host: PathDrawHost) {
    this.host = host;
  }

  private t(key: string, p?: Record<string, string | number>): string {
    return tr(key, this.host.lang(), p);
  }

  get drawing(): boolean {
    return this.active;
  }

  /** The map opened: its window (`root`, whose canvas is drawn on) and the column of its controls (`ui`, the banner goes after `after`). */
  attach(root: HTMLElement, canvas: HTMLCanvasElement, ui: HTMLElement, after: Element): void {
    this.root = root;
    this.canvas = canvas;
    this.banner = el('div', 'bm-drawbar');
    this.banner.hidden = true;
    after.after(this.banner);
    // (in the capturing phase: while drawing, the map's own dragging does not see the finger)
    root.addEventListener('pointerdown', this.down, true);
    root.addEventListener('pointermove', this.move, true);
    root.addEventListener('pointerup', this.up, true);
    root.addEventListener('pointercancel', this.up, true);
    this.active = false;
  }

  detach(): void {
    const r = this.root;
    if (r) {
      r.removeEventListener('pointerdown', this.down, true);
      r.removeEventListener('pointermove', this.move, true);
      r.removeEventListener('pointerup', this.up, true);
      r.removeEventListener('pointercancel', this.up, true);
    }
    this.banner?.remove();
    this.banner = null;
    this.root = null;
    this.canvas = null;
    this.active = false;
    this.cur = null;
    this.fingers.clear();
  }

  private readonly down = (e: PointerEvent): void => {
    const canvas = this.canvas;
    if (!this.active || !canvas || e.target !== canvas) return;
    e.stopPropagation();
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.fingers.size === 1) {
      this.cur = [...this.host.toWorld(e.clientX, e.clientY)];
      this.lastPx = { x: e.clientX, y: e.clientY };
    } else {
      // a second finger: the map is moved, not drawn on (a stroke hardly begun is dropped)
      if (this.cur && this.cur.length >= 16) this.finish();
      this.cur = null;
      this.pinch = 0;
    }
  };

  private readonly move = (e: PointerEvent): void => {
    const f = this.fingers.get(e.pointerId);
    if (!this.active || !f) return;
    e.stopPropagation();
    const dx = e.clientX - f.x;
    const dy = e.clientY - f.y;
    f.x = e.clientX;
    f.y = e.clientY;
    if (this.fingers.size === 1 && this.cur) {
      if (Math.hypot(e.clientX - this.lastPx.x, e.clientY - this.lastPx.y) < 4) return;
      this.lastPx = { x: e.clientX, y: e.clientY };
      this.cur.push(...this.host.toWorld(e.clientX, e.clientY));
      this.host.redraw();
    } else if (this.fingers.size === 2) {
      const [a, b] = [...this.fingers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.host.pan(dx / 2, dy / 2);
      if (this.pinch > 0 && d > 0) this.host.zoom(d / this.pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
      this.pinch = d;
    }
  };

  private readonly up = (e: PointerEvent): void => {
    if (!this.fingers.delete(e.pointerId)) return;
    e.stopPropagation();
    if (this.fingers.size === 0 && this.cur) this.finish();
    this.pinch = 0;
  };

  /** A stroke is done: it is added to the drawing, and the whole drawing laid onto the roads anew. */
  private finish(): void {
    const s = this.cur;
    this.cur = null;
    if (!s || s.length < 4) return;
    this.strokes.push(s);
    this.rematch();
  }

  private rematch(): void {
    this.match = null;
    this.note = '';
    if (this.strokes.length === 0) {
      this.showBanner();
      this.host.redraw();
      return;
    }
    const roads = this.host.roads();
    if (!roads) this.note = this.t('realityLoading');
    else {
      this.match = matchStroke(this.strokes.flat(), roads);
      if (!this.match) this.note = this.t('drawNone');
    }
    this.showBanner();
    this.host.redraw();
  }

  /** Drawing on or off. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.cur = null;
    this.fingers.clear();
    // (the roads of the whole map may have been read meanwhile)
    if (!on && this.strokes.length > 0 && !this.match) this.rematch();
    this.showBanner();
    this.host.mode(on);
    this.host.redraw();
  }

  clear(): void {
    this.strokes = [];
    this.match = null;
    this.note = '';
    this.cur = null;
    this.showBanner();
    this.host.redraw();
  }

  /** The bar over the map while drawing: what to do, how long the way is, undo and done. */
  private showBanner(): void {
    const b = this.banner;
    if (!b) return;
    b.hidden = !this.active;
    if (!this.active) return;
    b.replaceChildren();
    const text = el('div');
    text.append(el('b', '', this.t('drawActive')));
    const sub = this.match ? this.t('drawResult', { km: formatUnit(this.match.metres / 1000, 'kilometer', this.host.lang(), 1) }) : this.note;
    if (sub) text.append(el('small', '', sub));
    const undo = el('button', 'btn ghost', this.t('drawUndo'));
    undo.type = 'button';
    undo.disabled = this.strokes.length === 0;
    undo.onclick = () => {
      this.strokes.pop();
      this.rematch();
    };
    const done = el('button', 'btn', this.t('drawDone'));
    done.type = 'button';
    done.onclick = () => this.setActive(false);
    b.append(text, undo, done);
  }

  /** The part of the panel for planning: draw, and drive what was drawn. */
  section(): HTMLElement {
    const box = el('div', 'bm-tour bm-draw');
    box.append(el('b', '', this.t('drawTitle')), el('small', '', this.t('drawHint')));
    const row = el('div', 'bm-row');
    const draw = el('button', 'btn ghost', this.t(this.strokes.length > 0 ? 'drawMore' : 'drawStart'));
    draw.type = 'button';
    draw.onclick = () => this.setActive(true);
    row.append(draw);
    if (this.strokes.length > 0) {
      const clear = el('button', 'btn ghost', this.t('drawClear'));
      clear.type = 'button';
      clear.onclick = () => {
        this.clear();
        box.replaceWith(this.section());
      };
      row.append(clear);
    }
    box.append(row);
    if (this.strokes.length > 0 && !this.match && this.host.roads()) this.rematch();
    const m = this.match;
    if (m) {
      box.append(el('small', 'bm-result', this.t('drawResult', { km: formatUnit(m.metres / 1000, 'kilometer', this.host.lang(), 1) })));
      const go = el('div', 'bm-row');
      const auto = el('button', 'btn', this.t('drawGo'));
      auto.type = 'button';
      auto.onclick = () => this.drive(false);
      const self = el('button', 'btn ghost', this.t('tripSelf'));
      self.type = 'button';
      self.onclick = () => this.drive(true);
      go.append(auto, self);
      box.append(go);
    } else if (this.note) box.append(el('small', 'bm-result', this.note));
    return box;
  }

  private drive(self: boolean): void {
    const m = this.match;
    if (!m) return;
    this.strokes = [];
    this.match = null;
    this.host.drive(previewOf(m), self);
  }

  /** Draw the strokes and the way they make (in screen pixels). */
  draw(g: CanvasRenderingContext2D, W: number, H: number, s: number, cx: number, cz: number): void {
    if (this.strokes.length === 0 && !this.cur && !this.match) return;
    const sx = (x: number): number => W / 2 + (x - cx) * s;
    const sy = (z: number): number => H / 2 + (z - cz) * s;
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // the way along the roads
    const m = this.match;
    if (m) {
      const p = m.line;
      g.strokeStyle = '#0c1218';
      g.lineWidth = 8;
      g.globalAlpha = 0.5;
      g.beginPath();
      g.moveTo(sx(p[0]), sy(p[1]));
      for (let i = 2; i < p.length; i += 2) g.lineTo(sx(p[i]), sy(p[i + 1]));
      g.stroke();
      g.globalAlpha = 1;
      g.strokeStyle = '#2ee66b';
      g.lineWidth = 5;
      g.stroke();
      // arrows along it, the way it is driven
      g.fillStyle = '#0c1218';
      let gap = 0;
      for (let i = 2; i < p.length; i += 2) {
        const ax = sx(p[i - 2]);
        const ay = sy(p[i - 1]);
        const bx = sx(p[i]);
        const by = sy(p[i + 1]);
        const l = Math.hypot(bx - ax, by - ay);
        gap += l;
        if (gap < 90 || l < 1) continue;
        gap = 0;
        const ux = (bx - ax) / l;
        const uy = (by - ay) / l;
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        g.beginPath();
        g.moveTo(mx + ux * 5, my + uy * 5);
        g.lineTo(mx - ux * 3 - uy * 4, my - uy * 3 + ux * 4);
        g.lineTo(mx - ux * 3 + uy * 4, my - uy * 3 - ux * 4);
        g.closePath();
        g.fill();
      }
      for (const [pt, colour] of [[m.start, '#2ee66b'], [m.end, '#ff5252']] as const) {
        g.fillStyle = colour;
        g.strokeStyle = '#ffffff';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(sx(pt.x), sy(pt.z), 7, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    }
    // what was drawn by hand
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2.5;
    g.globalAlpha = 0.85;
    g.setLineDash([6, 5]);
    for (const st of [...this.strokes, ...(this.cur ? [this.cur] : [])]) {
      if (st.length < 4) continue;
      g.beginPath();
      g.moveTo(sx(st[0]), sy(st[1]));
      for (let i = 2; i < st.length; i += 2) g.lineTo(sx(st[i]), sy(st[i + 1]));
      g.stroke();
    }
    g.setLineDash([]);
    g.restore();
  }
}
