// SPDX-License-Identifier: AGPL-3.0-only
/** Route guidance ("in 150 m turn left") and the lesson / exam definitions. */
import { projectOnPolyline } from '../core/geom.ts';
import { LaneGraph, TURN } from '../world/lanes.ts';
import type { Connector, Lane } from '../world/lanes.ts';
import { CLS, CTRL, EF, ROLE } from '../world/types.ts';
import type { Edge, World } from '../world/world.ts';

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

export class Navigator {
  private readonly graph: LaneGraph;
  route: Connector[] | null = null;
  goal: Edge | null = null;
  private idx = 0;
  private offRoute = 0;
  private readonly proj = { s: 0, off: 0, d2: 0, seg: 0 };
  readonly hint: NavHint = { what: 'navFollow', dist: -1, n: 0, arrow: 0, lane: 0, done: false };
  /** lanes of the route, for drawing it on the map */
  routeLanes: Lane[] = [];

  constructor(graph: LaneGraph) {
    this.graph = graph;
  }

  clear(): void {
    this.route = null;
    this.goal = null;
    this.routeLanes = [];
    this.hint.what = 'navFollow';
    this.hint.dist = -1;
    this.hint.lane = 0;
    this.hint.done = false;
  }

  setGoal(goal: Edge, from: Lane | null): boolean {
    this.goal = goal;
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
    if (!this.goal) return h;
    if (!lane) return h;
    let arrived = lane.edge === this.goal;
    if (!arrived && !Number.isNaN(x)) {
      // Being on the destination road counts as well, whichever lane the monitor
      // has us on – but only beyond its junctions: the road's centre line starts
      // in the middle of the junction, where the turn into it is still under way.
      const g = this.goal;
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
      this.offRoute += dt;
      if (this.offRoute > 1.5) {
        this.offRoute = 0;
        this.plan(lane);
      }
      return h;
    }
    this.offRoute = 0;
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
  kind: 'free' | 'basics' | 'route' | 'exam';
  targets: TargetType[];
}

export const LESSONS: LessonDef[] = [
  { id: 'basics', kind: 'basics', targets: [] },
  { id: 'rbl', kind: 'route', targets: ['rbl', 'rbl', 'home'] },
  { id: 'priority', kind: 'route', targets: ['priority', 'priority', 'home'] },
  { id: 'signals', kind: 'route', targets: ['signals', 'signals', 'home'] },
  { id: 'roundabout', kind: 'route', targets: ['roundabout', 'roundabout', 'home'] },
  { id: 'rural', kind: 'route', targets: ['rural', 'home'] },
  { id: 'motorway', kind: 'route', targets: ['motorway', 'home'] },
  { id: 'exam', kind: 'exam', targets: ['rbl', 'signals', 'roundabout', 'priority', 'rural', 'home'] },
];

/** Pick a destination edge of the wanted kind at a sensible distance from (x, z). */
/**
 * Is `e` part of a spur without a way out – a road that only leads to the
 * edge of the map or into a dead end, in either direction of travel?
 * Whoever is sent there has to turn round (or cannot get back at all).
 */
function deadEndSpur(graph: LaneGraph, e: Edge): boolean {
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
    for (const e of world.edges) if (!(e.flags & EF.URBAN) && e.tier >= 3 && e.cls > CLS.TRUNK_LINK && e.len > 180) push(e, e.a.x, e.a.z);
  } else if (type === 'motorway') {
    for (const e of world.edges) if (e.cls === CLS.MOTORWAY && e.len > 250) cands.push({ e, d: Math.hypot(e.a.x - x, e.a.z - z) });
  } else {
    for (const n of world.nodes) {
      if (n.arms.length < 3) continue;
      let ok = false;
      if (type === 'rbl') ok = n.ctrl === CTRL.RBL && n.arms.every((a) => a.edge.tier === 2);
      else if (type === 'signals') ok = n.ctrl === CTRL.SIGNALS;
      else if (type === 'roundabout') ok = n.ctrl === CTRL.ROUNDABOUT;
      else if (type === 'priority') ok = n.ctrl === CTRL.SIGNS && n.arms.some((a) => a.isApproach && (a.role === ROLE.YIELD || a.role === ROLE.STOP) && a.edge.tier >= 2);
      if (!ok) continue;
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
