// SPDX-License-Identifier: AGPL-3.0-only
/** Route guidance ("in 150 m turn left") and the lesson / exam definitions. */
import { projectOnPolyline } from '../core/geom.ts';
import { LaneGraph, TURN } from '../world/lanes.ts';
import type { Connector, Lane } from '../world/lanes.ts';
import { CLS, CTRL, EF, ROLE } from '../world/types.ts';
import type { Edge, Node, World } from '../world/world.ts';
import { quickest, quickestToEdge, wayOf } from '../world/routegraph.ts';
import type { RouteGraph } from '../world/routegraph.ts';
import type { DrillId } from './drills.ts';
import type { VehicleKind } from './vehicles.ts';

export interface NavHint {
  /** i18n key of the manoeuvre: navLeft, navRight, navStraight, navUturn, navRoundabout, navFollow, navMotorway, routeDone */
  what: string;
  /** metres to the manoeuvre (-1 = none) */
  dist: number;
  /** roundabout exit number */
  n: number;
  /** -1 left, 0 straight/none, 1 right – for the arrow */
  arrow: number;
  /** get in lane: -1 = move one lane to the left, 1 = to the right, 0 = this lane is fine */
  lane: number;
  done: boolean;
}

/**
 * The paths through the junctions for a list of ways (world/routegraph.ts)
 * that begins behind the lane `from` – choosing, where a road has several
 * lanes, the ones from which the way goes on with the fewest changes of
 * lane.  Null when two ways that follow each other are not connected.
 */
export function connectorsAlong(graph: LaneGraph, ways: readonly number[], from: Lane): Connector[] | null {
  const lanesOf = (w: number): Lane[] => ((w & 1) === 0 ? graph.edgeLanes[w >> 1].fwd : graph.edgeLanes[w >> 1].back);
  const layers: Lane[][] = [lanesOf(wayOf(from)), ...ways.map(lanesOf)];
  const n = layers.length;
  if (layers.some((l) => l.length === 0)) return null;
  /** what it costs from each lane of a road to the end (changes of lane, mostly) */
  let onward: number[] = layers[n - 1].map(() => 0);
  const through: Array<Array<{ c: Connector; cost: number } | null>> = new Array(Math.max(0, n - 1));
  // (changing lanes on a short piece between two junctions is hard: better be in the right one before)
  const change = (i: number): number => (layers[i][0].len < 30 ? 3 : 1);
  for (let i = n - 2; i >= 0; i--) {
    const cur = layers[i];
    const tgt = layers[i + 1];
    const next = onward;
    through[i] = cur.map((l) => {
      let best: Connector | null = null;
      let bc = Infinity;
      for (const c of l.out) {
        const j = tgt.indexOf(c.to);
        if (j < 0) continue;
        if (next[j] < bc) {
          bc = next[j];
          best = c;
        }
      }
      return best ? { c: best, cost: bc } : null;
    });
    if (through[i].every((t) => t === null)) return null;
    onward = cur.map((_, a) => {
      let m = Infinity;
      through[i].forEach((t, b) => {
        if (t) m = Math.min(m, t.cost + Math.abs(a - b) * change(i));
      });
      return m;
    });
  }
  const out: Connector[] = [];
  let at = Math.max(0, layers[0].indexOf(from));
  for (let i = 0; i < n - 1; i++) {
    let best = -1;
    let bc = Infinity;
    through[i].forEach((t, b) => {
      if (!t) return;
      const cost = t.cost + Math.abs(at - b) * change(i);
      if (cost < bc) {
        bc = cost;
        best = b;
      }
    });
    const c = (through[i][best] as { c: Connector }).c;
    out.push(c);
    at = layers[i + 1].indexOf(c.to);
  }
  return out;
}

export class Navigator {
  private readonly graph: LaneGraph;
  route: Connector[] | null = null;
  goal: Edge | null = null;
  /** the route was laid out beforehand (a tour): it is followed as it is, and rejoined when it was left */
  private fixed = false;
  /**
   * The road network of the whole map (world/routegraph.ts) – for ways that
   * lead beyond the part of the map that is loaded.  Set by whoever has it.
   */
  net: RouteGraph | null = null;
  /**
   * A way given as a list of ways of that network: of the part that is
   * loaded, `route` holds the paths through the junctions; the rest follows
   * as the car gets there.  `expanded`: how many of the ways `route` covers.
   */
  private ways: number[] | null = null;
  private expanded = 0;
  private tour = false;
  private from: Lane | null = null;
  private idx = 0;
  private offRoute = 0;
  private readonly proj = { s: 0, off: 0, d2: 0, seg: 0 };
  readonly hint: NavHint = { what: 'navFollow', dist: -1, n: 0, arrow: 0, lane: 0, done: false };
  /** lanes of the route, for drawing it on the map */
  routeLanes: Lane[] = [];

  constructor(graph: LaneGraph) {
    this.graph = graph;
  }

  /** Is there a way to follow (to a destination, or laid out beforehand)? */
  get busy(): boolean {
    return this.goal !== null || this.ways !== null;
  }

  clear(): void {
    this.route = null;
    this.goal = null;
    this.fixed = false;
    this.ways = null;
    this.from = null;
    this.expanded = 0;
    this.routeLanes = [];
    this.hint.what = 'navFollow';
    this.hint.dist = -1;
    this.hint.lane = 0;
    this.hint.done = false;
  }

  /** how many junctions of the route are still ahead */
  get left(): number {
    if (!this.route) return 0;
    // (of a way given as ways, more may follow than is known as lanes yet)
    return this.route.length - this.idx + (this.ways && this.expanded < this.ways.length ? 1000 : 0);
  }

  /**
   * Follow a way that was laid out beforehand – a tour: its paths through the
   * junctions, in order, from the lane `from` on.  Unlike a route to a
   * destination it may lead along the same road more than once, and it is
   * not shortened: whoever leaves it is led back onto it.
   */
  setPath(path: Connector[], from: Lane): void {
    this.fixed = true;
    this.route = path.slice();
    this.goal = path.length > 0 ? path[path.length - 1].to.edge : from.edge;
    this.idx = 0;
    this.offRoute = 0;
    this.hint.done = false;
    this.routeLanes = [from, ...path.map((c) => c.to)];
  }

  /** how long the car must be off the way before a new one is looked for (s): longer after each search that found none */
  private retry = 1.5;

  /**
   * Follow a list of ways of the whole map's network (`net` must be set),
   * from the lane `from` on.  `tour`: it was laid out to be driven as it is –
   * whoever leaves it is led back onto it; otherwise it is the quickest way
   * to its last road, and is found anew from wherever the car gets to.
   * The ways may lead through parts of the map that are not loaded yet.
   */
  setWays(ways: number[], from: Lane, tour: boolean): void {
    this.ways = ways.slice();
    this.tour = tour;
    this.from = from;
    this.fixed = false;
    this.goal = null;
    this.route = [];
    this.routeLanes = [from];
    this.expanded = 0;
    this.idx = 0;
    this.offRoute = 0;
    this.hint.done = false;
    this.extend();
  }

  /** Turn more of the ways into lanes and paths through junctions: as far as the map is loaded. */
  private extend(): void {
    const ways = this.ways;
    const route = this.route;
    if (!ways || !route || !this.from || this.expanded >= ways.length) return;
    const last = route.length ? route[route.length - 1].to : this.from;
    let n = 0;
    while (this.expanded + n < ways.length && n < 80) {
      const el = this.graph.edgeLanes[ways[this.expanded + n] >> 1];
      if (!el || ((ways[this.expanded + n] & 1) === 0 ? el.fwd : el.back).length === 0) break;
      n++;
    }
    // (the junctions at the rim of what is loaded are not whole yet: then a little less far)
    for (let step = 1; n > 0; n -= step, step *= 2) {
      const part = connectorsAlong(this.graph, ways.slice(this.expanded, this.expanded + n), last);
      if (!part) continue;
      for (const c of part) {
        route.push(c);
        this.routeLanes.push(c.to);
      }
      this.expanded += n;
      // (a new list: whoever draws the route sees that it changed)
      this.routeLanes = this.routeLanes.slice();
      return;
    }
  }

  /** Off the way that was given as ways: back onto the tour, or the quickest way to the destination from here. */
  private rejoinWays(lane: Lane): void {
    const ways = this.ways as number[];
    const net = this.net;
    if (!net || ways.length === 0) return;
    const here = wayOf(lane);
    let next: number[] | null = null;
    if (this.tour) {
      let bestCost = Infinity;
      for (let j = Math.min(ways.length - 1, this.idx + 1), n = 0; j < ways.length && n < 10; j++, n++) {
        if (ways[j] === here) {
          next = ways.slice(j + 1);
          break;
        }
        const lead = quickest(net, here, ways[j]);
        if (!lead) continue;
        let cost = n * 150;
        for (const w of lead) cost += net.len[w];
        if (cost < bestCost) {
          bestCost = cost;
          next = [...lead, ...ways.slice(j + 1)];
        }
      }
    }
    // (no way back onto the tour, or no tour at all: the quickest way to where it ends)
    next ??= quickestToEdge(net, here, ways[ways.length - 1] >> 1);
    if (!next) return;
    this.setWays(next, lane, this.tour);
  }

  /** Back onto the tour: by the shortest way to one of its next roads. */
  private rejoin(lane: Lane): void {
    const r = this.route as Connector[];
    let best: Connector[] | null = null;
    let bestAt = -1;
    let bestCost = Infinity;
    for (let i = Math.min(r.length - 1, this.idx + 1), n = 0; i >= 0 && i < r.length && n < 10; i++, n++) {
      const target = r[i].from;
      if (target.edge === lane.edge && target.dir === lane.dir) {
        best = [];
        bestAt = i;
        break;
      }
      const p = this.graph.route(lane, target.edge, false, target.dir);
      if (!p) continue;
      let cost = n * 150;
      for (const c of p) cost += c.len + c.to.len + (c.turn === TURN.UTURN ? 2000 : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = p;
        bestAt = i;
      }
    }
    if (!best) {
      // no way back onto it: straight to where it ends
      this.fixed = false;
      this.plan(lane);
      return;
    }
    this.route = [...best, ...r.slice(bestAt)];
    this.idx = 0;
    this.routeLanes = [lane, ...this.route.map((c) => c.to)];
  }

  setGoal(goal: Edge, from: Lane | null): boolean {
    this.goal = goal;
    this.fixed = false;
    this.hint.done = false;
    if (!from) {
      this.route = null;
      return false;
    }
    return this.plan(from);
  }

  private plan(from: Lane): boolean {
    if (!this.goal) return false;
    if (from.edge === this.goal) {
      this.route = [];
      this.routeLanes = [from];
      this.idx = 0;
      return true;
    }
    const r = this.graph.route(from, this.goal, false);
    if (!r) return false;
    this.route = r;
    this.idx = 0;
    this.routeLanes = [from, ...r.map((c) => c.to)];
    return true;
  }

  /** `lane` and `s` = where the player is (distance of the front bumper along the lane); x,z = position. */
  update(dt: number, lane: Lane | null, s: number, x = NaN, z = NaN): NavHint {
    const h = this.hint;
    if (!this.busy) return h;
    if (!lane) return h;
    // more of a way that was given as ways, as the car gets on and the map is loaded ahead
    if (this.ways && this.route && this.expanded < this.ways.length && this.route.length - this.idx < 12) this.extend();
    let arrived = lane.edge === this.goal;
    if (this.ways) {
      const r = this.route ?? [];
      const all = this.expanded >= this.ways.length;
      const tail = r.length > 0 ? r[r.length - 1].to : null;
      arrived = all && (tail === null ? this.ways.length === 0 : this.idx >= r.length - 1 && lane.edge === tail.edge && lane.dir === tail.dir);
    } else if (this.fixed) {
      // a tour is over when its last road is reached by its last junction – it may have led along that road before
      const r = this.route ?? [];
      const tail = r.length > 0 ? r[r.length - 1].to : null;
      arrived = tail === null || (this.idx >= r.length - 1 && lane.edge === tail.edge && lane.dir === tail.dir);
    } else if (!arrived && !Number.isNaN(x)) {
      // Being on the destination road counts as well, whichever lane the monitor
      // has us on – but only beyond its junctions: the road's centre line starts
      // in the middle of the junction, where the turn into it is still under way.
      const g = this.goal as Edge;
      if (x > g.minX - 6 && x < g.maxX + 6 && z > g.minZ - 6 && z < g.maxZ + 6) {
        projectOnPolyline(g.pl, x, z, this.proj);
        const reach = g.width / 2 + 1.5;
        arrived = this.proj.d2 < reach * reach && this.proj.s > g.cutA + 4 && this.proj.s < g.len - g.cutB - 4;
      }
    }
    if (arrived) {
      h.done = true;
      h.what = 'routeDone';
      h.dist = -1;
      h.arrow = 0;
      h.lane = 0;
      return h;
    }
    if (!this.route) {
      this.plan(lane);
      return h;
    }
    const r = this.route;
    // where are we on the route?
    let found = -1;
    for (let i = Math.max(0, this.idx - 1); i < r.length; i++) {
      if (r[i].from === lane || r[i].from.edge === lane.edge && r[i].from.dir === lane.dir) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      // (on the last road of what is known so far – or nothing is known yet: the map ahead is still being loaded)
      const end = r.length > 0 ? r[r.length - 1].to : this.from;
      const waiting = this.ways !== null && this.expanded < this.ways.length && end !== null && lane.edge === end.edge && lane.dir === end.dir;
      if (!waiting) this.offRoute += dt;
      if (this.offRoute > this.retry) {
        this.offRoute = 0;
        const before = this.route;
        if (this.ways) this.rejoinWays(lane);
        else if (this.fixed) this.rejoin(lane);
        else this.plan(lane);
        // (No way from here: asked again, but not every second – the search runs through the
        // roads of the whole map, and whoever is off the way stays so for a while.)
        this.retry = this.route === before ? Math.min(20, this.retry * 2.5) : 1.5;
      }
      return h;
    }
    this.offRoute = 0;
    this.retry = 1.5;
    this.idx = found;
    // Einordnen: the route continues from a particular lane of this carriageway
    const want = r[found].from;
    h.lane = want !== lane && want.edge === lane.edge ? ((want.off - lane.off) * lane.dir > 0 ? -1 : 1) : 0;
    // next real manoeuvre
    let dist = Math.max(0, lane.len - s);
    h.what = 'navFollow';
    h.dist = -1;
    h.arrow = 0;
    h.n = 0;
    for (let i = found; i < r.length; i++) {
      const c = r[i];
      const node = c.node;
      const entersRing = node.ctrl === CTRL.ROUNDABOUT && (c.to.edge.flags & EF.ROUNDABOUT) !== 0 && !(c.from.edge.flags & EF.ROUNDABOUT);
      if (entersRing) {
        // count the exits we pass until the route leaves the ring
        let n = 0;
        for (let j = i + 1; j < r.length; j++) {
          const cj = r[j];
          if (!(cj.from.edge.flags & EF.ROUNDABOUT)) break;
          const hasExit = cj.node.arms.some((a) => a.isExit && !(a.edge.flags & EF.ROUNDABOUT));
          if (hasExit) n++;
          if (!(cj.to.edge.flags & EF.ROUNDABOUT)) break;
        }
        h.what = 'navRoundabout';
        h.n = Math.max(1, n);
        h.dist = dist;
        h.arrow = 1;
        return h;
      }
      const real = node.arms.length >= 3 && !(c.from.edge.flags & EF.ROUNDABOUT);
      if (real && c.turn !== TURN.STRAIGHT) {
        h.what = c.turn === TURN.LEFT ? 'navLeft' : c.turn === TURN.RIGHT ? 'navRight' : 'navUturn';
        h.arrow = c.turn === TURN.RIGHT ? 1 : -1;
        h.dist = dist;
        return h;
      }
      if (real && c.to.edge.cls === CLS.MOTORWAY_LINK && c.from.edge.cls > CLS.TRUNK_LINK) {
        h.what = 'navMotorway';
        h.dist = dist;
        h.arrow = c.turn === TURN.LEFT ? -1 : 1;
        return h;
      }
      dist += c.len + c.to.len;
      if (dist > 1500) break;
    }
    return h;
  }
}

export type TargetType = 'rbl' | 'signals' | 'roundabout' | 'rural' | 'motorway' | 'priority' | 'home';

export interface LessonDef {
  /** title and introduction are texts: "lesson.<id>.title", "lesson.<id>.intro" */
  id: string;
  /** 'yard': tasks on the practice yard only (class CE) */
  kind: 'free' | 'basics' | 'route' | 'exam' | 'yard' | 'tram' | 'bus';
  targets: TargetType[];
  /** only for this vehicle (default: all but those in `notFor`) – or for these */
  vehicle?: VehicleKind;
  vehicles?: VehicleKind[];
  notFor?: VehicleKind[];
  /** tasks on the practice yard, done one after the other before the drive (see game/ce.ts) */
  tasks?: Array<'couple' | 'corner' | 'ramp'>;
  /** the basic tasks of class B on the practice yard, one after the other (see game/drills.ts; 'exam': three tasks as in the test – one of group a, two of group b, Anlage 7 FeV Nr. 2.1.4.2) */
  drills?: Array<DrillId | 'exam'>;
}

export const LESSONS: LessonDef[] = [
  { id: 'basics', kind: 'basics', targets: [], vehicle: 'car' },
  { id: 'rbl', kind: 'route', targets: ['rbl', 'rbl', 'home'] },
  { id: 'priority', kind: 'route', targets: ['priority', 'priority', 'home'] },
  { id: 'signals', kind: 'route', targets: ['signals', 'signals', 'home'] },
  { id: 'roundabout', kind: 'route', targets: ['roundabout', 'roundabout', 'home'] },
  { id: 'rural', kind: 'route', targets: ['rural', 'home'] },
  { id: 'motorway', kind: 'route', targets: ['motorway', 'home'], notFor: ['tractor'] },
  // (the test drive on the road, for every class but CE – that one has its own, with the yard tasks)
  { id: 'exam', kind: 'exam', targets: ['rbl', 'signals', 'roundabout', 'priority', 'rural', 'home'], notFor: ['truck', 'semi'] },
  // class CE: truck with trailer (Anlage 7 FeV: coupling, two basic manoeuvres, the drive)
  { id: 'ceCouple', kind: 'yard', targets: [], vehicles: ['truck', 'semi'], tasks: ['couple'] },
  { id: 'ceCorner', kind: 'yard', targets: [], vehicles: ['truck', 'semi'], tasks: ['corner'] },
  { id: 'ceRamp', kind: 'yard', targets: [], vehicles: ['truck', 'semi'], tasks: ['ramp'] },
  // class B: the basic tasks of the practical test on the practice yard (game/drills.ts) – the hill start and the emergency stop with the vans and the car with a trailer too
  { id: 'bParallel', kind: 'yard', targets: [], vehicle: 'car', drills: ['parallel'] },
  { id: 'bBay', kind: 'yard', targets: [], vehicle: 'car', drills: ['bayFwd', 'bayBack'] },
  { id: 'bReverse', kind: 'yard', targets: [], vehicle: 'car', drills: ['backStraight', 'backCorner'] },
  { id: 'bTurn', kind: 'yard', targets: [], vehicle: 'car', drills: ['turn'] },
  { id: 'bHill', kind: 'yard', targets: [], vehicles: ['car', 'carTrailer', 'lightTruck', 'minibus'], drills: ['hill'] },
  { id: 'bBrake', kind: 'yard', targets: [], vehicles: ['car', 'carTrailer', 'lightTruck', 'minibus'], drills: ['brake'] },
  { id: 'bDrills', kind: 'yard', targets: [], vehicle: 'car', drills: ['exam'] },
  // the tram: a line with its stops (sim/tramdrive.ts)
  { id: 'tramLine', kind: 'tram', targets: [], vehicle: 'tram' },
  // the bus on a line: five stops on the way, with their doors and passengers
  { id: 'busLine', kind: 'bus', targets: [], vehicles: ['bus', 'busTrailer', 'minibus', 'minibusTrailer'] },
  { id: 'ceExam', kind: 'exam', targets: ['signals', 'roundabout', 'priority', 'rural', 'home'], vehicles: ['truck', 'semi'], tasks: ['couple', 'corner', 'ramp'] },
];

/** Pick a destination edge of the wanted kind at a sensible distance from (x, z). */
/**
 * Is `e` part of a spur without a way out – a road that only leads to the
 * edge of the map or into a dead end, in either direction of travel?
 * Whoever is sent there has to turn round (or cannot get back at all).
 */
export function deadEndSpur(graph: LaneGraph, e: Edge): boolean {
  const el = graph.edgeLanes[e.id];
  for (const first of [el.fwd[0], el.back[0]]) {
    if (!first) continue;
    let lane: Lane = first;
    let dist = 0;
    for (let hop = 0; hop < 60 && dist < 5000; hop++) {
      // the roads one can carry on to from this carriageway (not counting turning round)
      const lanes = graph.edgeLanes[lane.edge.id];
      const onward = new Map<Edge, Lane>();
      for (const l of lane.dir > 0 ? lanes.fwd : lanes.back) {
        for (const c of l.out) {
          if (c.turn !== TURN.UTURN && c.to.edge !== lane.edge && LaneGraph.drivable(c.to.edge, true)) onward.set(c.to.edge, c.to);
        }
      }
      if (onward.size === 0) return true;
      if (onward.size > 1) break;
      lane = onward.values().next().value as Lane;
      dist += lane.len;
    }
  }
  return false;
}

/** Is node `n` a junction of this kind (right before left, lights, a roundabout, signs that give priority)? */
export function junctionOfType(n: Node, type: TargetType): boolean {
  if (n.stub || n.arms.length < 3) return false;
  if (type === 'rbl') return n.ctrl === CTRL.RBL && n.arms.every((a) => a.edge.tier === 2);
  if (type === 'signals') return n.ctrl === CTRL.SIGNALS;
  if (type === 'roundabout') return n.ctrl === CTRL.ROUNDABOUT;
  if (type === 'priority') return n.ctrl === CTRL.SIGNS && n.arms.some((a) => a.isApproach && (a.role === ROLE.YIELD || a.role === ROLE.STOP) && a.edge.tier >= 2);
  return false;
}

export function findTarget(world: World, graph: LaneGraph, type: TargetType, x: number, z: number, from: Lane, home: Edge | null, avoid: Set<Edge>): Edge | null {
  if (type === 'home') return home;
  const cands: Array<{ e: Edge; d: number }> = [];
  const push = (e: Edge, px: number, pz: number): void => {
    if (avoid.has(e) || !LaneGraph.drivable(e, true)) return;
    // the destination must be a stretch of road one can actually be "on"
    if (e.len - e.cutA - e.cutB < 25) return;
    const d = Math.hypot(px - x, pz - z);
    if (d > 350 && d < 2600) cands.push({ e, d });
  };
  if (type === 'rural') {
    for (const e of world.allEdges) if (!(e.flags & EF.URBAN) && e.tier >= 3 && e.cls > CLS.TRUNK_LINK && e.len > 180) push(e, e.a.x, e.a.z);
  } else if (type === 'motorway') {
    for (const e of world.allEdges) if (e.cls === CLS.MOTORWAY && e.len > 250) cands.push({ e, d: Math.hypot(e.a.x - x, e.a.z - z) });
  } else {
    for (const n of world.allNodes) {
      if (!junctionOfType(n, type)) continue;
      // drive through the junction: aim at an arm leading away from it
      for (const a of n.arms) {
        if (!a.isExit) continue;
        if (type === 'roundabout' && a.edge.flags & EF.ROUNDABOUT) continue;
        push(a.edge, n.x, n.z);
      }
    }
  }
  cands.sort((p, q) => p.d - q.d);
  // prefer something a few hundred metres away, and make sure it can be reached
  const start = Math.min(cands.length - 1, Math.floor(cands.length * 0.15));
  const order = [...cands.slice(start), ...cands.slice(0, start)];
  // Destinations that can only be reached or left by turning round are a last resort.
  let tries = 0;
  let fallback: Edge | null = null;
  for (const c of order) {
    if (deadEndSpur(graph, c.e)) continue;
    if (++tries > 16) break;
    const r = graph.route(from, c.e, false);
    if (!r) continue;
    if (!r.some((k) => k.turn === TURN.UTURN)) return c.e;
    fallback ??= c.e;
  }
  return fallback;
}
