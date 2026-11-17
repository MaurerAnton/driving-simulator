// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lessons in real places.  The driving lessons begin, as they always did,
 * where the player chose to start – or, if the player wishes so (a setting,
 * asked the first time a lesson starts), right before a place of the real
 * town that fits the lesson: a junction of the kind it is about, a quiet
 * straight street to learn pulling away and braking in, the edge of town
 * where a country road begins, a road with a slip road onto the motorway.
 * That place is looked for at random in Baunatal and Kassel, or in or near
 * a district the player chose.
 *
 *   'start'  as before: from the start place chosen in the menu
 *   'town'   at a random district of the home region (Baunatal, Kassel and round)
 *   'area'   in or near the district chosen in the settings
 *
 * The search runs on the roads that are loaded (world.ts, lanes.ts) once
 * the start district's roads are there, so it sees what the drive will see:
 * the kind of junction, its signs and lights, its lanes.  The vehicle is put
 * into the rightmost lane of the road leading to the place, about a hundred
 * metres before it, and the lesson's first destination is the road leading
 * away from it (game/nav.ts) – the rest of the lesson goes on as before.
 * Where nothing fits, the lesson begins at the start place chosen.
 *
 * Not affected: the tasks on the practice yard (class CE, the cranes, the
 * forklift) and the theory lessons, which are scenes of their own on the
 * practice yard (game/theorystage.ts).
 */
import { newPolySample } from '../core/geom.ts';
import { EF, ACCESS, CLS, CTRL, ROLE } from '../world/types.ts';
import type { SpawnJson } from '../world/types.ts';
import { LaneGraph, TURN, lanePoint } from '../world/lanes.ts';
import type { Lane } from '../world/lanes.ts';
import type { Arm, Edge, Node, World } from '../world/world.ts';
import { deadEndSpur, junctionOfType } from './nav.ts';
import type { LessonDef } from './nav.ts';

/** Where the lessons take place (the setting). */
export type LessonPlaceMode = 'start' | 'town' | 'area';
export const LESSON_PLACE_MODES: readonly LessonPlaceMode[] = ['start', 'town', 'area'];

/** A district to hold the lessons in: its name and middle. */
export interface LessonArea {
  name: string;
  x: number;
  z: number;
}

/** What place a lesson looks for – 'area': no place of its own, only the district (the test drive). */
export type PlaceKind = 'quiet' | 'rbl' | 'priority' | 'signals' | 'roundabout' | 'rural' | 'motorway' | 'area';

/** The place a lesson looks for, or null: the lesson has none (the yard, the tram, the bus). */
export function placeKindOf(l: Pick<LessonDef, 'kind' | 'targets'>): PlaceKind | null {
  if (l.kind === 'basics') return 'quiet';
  if (l.kind === 'exam') return 'area';
  if (l.kind === 'route') {
    const t = l.targets[0];
    if (t && t !== 'home') return t;
  }
  return null;
}

/** how far from the first start place (the home town) the districts of the home region lie (m) */
const HOME_REGION = 12000;
/** how far round the district's middle a place is looked for (m) – inside what is loaded once the start is ready (1.5 km) */
export const SEARCH_RADIUS = 1300;
/** … for the motorway lesson: a slip road is further to look for */
const MOTORWAY_RADIUS = 3000;

/** How far round the start place the roads must be loaded before the place is looked for (m). */
export const searchRadius = (kind: PlaceKind): number => (kind === 'motorway' ? MOTORWAY_RADIUS : SEARCH_RADIUS);

/** how far before the place the vehicle is put (m) */
const LEAD_IN = 110;

/** The name of a start place's district: "Altenbauna – Parkplatz" → "Altenbauna". */
const districtOf = (name: string): string => name.split(' – ')[0].trim();

/**
 * The districts the player may choose: those of the map's start places
 * (car parks, one in each district) near the home town, nearest first, each
 * name once.
 */
export function areaChoices(spawns: readonly SpawnJson[], max = 60, within = 25000): LessonArea[] {
  const home = spawns[0];
  if (!home) return [];
  const seen = new Set<string>();
  const out: Array<LessonArea & { d: number }> = [];
  for (const s of spawns) {
    const name = districtOf(s.name);
    const d = Math.hypot(s.x - home.x, s.z - home.z);
    if (!name || seen.has(name) || d > within) continue;
    seen.add(name);
    out.push({ name, x: s.x, z: s.z, d });
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, max).map(({ name, x, z }) => ({ name, x, z }));
}

/** Where a lesson is to begin: the start place to load, what to look for there, and where to go if nothing is found. */
export interface LessonStart {
  spawn: SpawnJson;
  kind: PlaceKind;
  fallback: SpawnJson;
}

/**
 * The start of a lesson in a real place – null where the lesson begins where
 * it always did (the setting says so, or the lesson has no real place).
 */
export function lessonStart(lesson: Pick<LessonDef, 'kind' | 'targets'>, mode: LessonPlaceMode, area: LessonArea | null, spawns: readonly SpawnJson[], current: SpawnJson, rnd: () => number = Math.random): LessonStart | null {
  const kind = placeKindOf(lesson);
  if (!kind || mode === 'start') return null;
  let centre: LessonArea | null;
  if (mode === 'area') centre = area ?? areaChoices(spawns, 1)[0] ?? null;
  else {
    const region = areaChoices(spawns, 200, HOME_REGION);
    centre = region.length > 0 ? region[Math.min(region.length - 1, Math.floor(rnd() * region.length))] : null;
  }
  if (!centre) return null;
  // (the district's car park if it has one near its middle: a proper place to begin – else a road near the middle, once loaded)
  let best: SpawnJson | null = null;
  let bd = 1500;
  for (const s of spawns) {
    const d = Math.hypot(s.x - centre.x, s.z - centre.z);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  const spawn: SpawnJson = best ? { ...best } : { name: centre.name, x: centre.x, z: centre.z, yaw: 0, kind: 'street', rough: true };
  return { spawn, kind, fallback: current };
}

/** A place found for a lesson: where the vehicle stands, and the lesson's first destination (null: the lesson finds its own). */
export interface LessonSpot {
  x: number;
  z: number;
  yaw: number;
  /** the street it stands in */
  name: string;
  goal: Edge | null;
  /** the junction the place is about (null: a street) */
  node: Node | null;
}

export interface PlaceOptions {
  radius?: number;
  rnd?: () => number;
  /** lanes of the network one can drive around in (the start must be one) */
  usable?: (lane: Lane) => boolean;
}

const smp = newPolySample();

/** The rightmost lane arriving at the junction on this arm (null: none, or not usable). */
function arriving(graph: LaneGraph, a: Arm, usable: (l: Lane) => boolean): Lane | null {
  const el = graph.edgeLanes[a.edge.id];
  if (!el) return null;
  // (the arm leaves the junction: traffic towards it drives from b to a)
  const lanes = (a.out ? el.back : el.fwd).filter((l) => l.to === a.node && usable(l));
  return lanes.find((l) => l.idx === 0) ?? lanes[0] ?? null;
}

/** A spot `before` metres before the end of a lane (but not off its start). */
function spotOn(lane: Lane, before: number): { x: number; z: number; yaw: number } {
  const d = Math.max(Math.min(lane.len - 30, lane.len - before), Math.min(20, lane.len * 0.4));
  lanePoint(lane, d, smp);
  return { x: smp.x, z: smp.z, yaw: Math.atan2(-smp.tx, -smp.tz) };
}

/** A public street, not a yard or a car park (narrow village streets are fine for the learner, if not for the traffic). */
const street = (e: Edge): boolean => LaneGraph.drivable(e, false) && e.access === ACCESS.YES && e.tier >= 2 && !(e.flags & EF.MINOR_SERVICE);

/** May a lesson begin on this road (a proper public street, not the motorway)? */
function startRoad(e: Edge): boolean {
  return street(e) && e.cls > CLS.TRUNK_LINK && e.cls <= CLS.RESIDENTIAL;
}

/** May the destination be this road (somewhere one can be "on", with a way out)? */
function goalRoad(graph: LaneGraph, e: Edge): boolean {
  return street(e) && e.len - e.cutA - e.cutB >= 25 && !deadEndSpur(graph, e);
}

/** The junctions of a roundabout's ring, from one of them. */
function ringOf(n: Node): Node[] {
  const out = [n];
  const seen = new Set<Node>(out);
  for (let i = 0; i < out.length && out.length < 24; i++) {
    for (const a of out[i].arms) {
      if (!(a.edge.flags & EF.ROUNDABOUT)) continue;
      const m = a.edge.a === out[i] ? a.edge.b : a.edge.a;
      if (!seen.has(m) && m.ctrl === CTRL.ROUNDABOUT) {
        seen.add(m);
        out.push(m);
      }
    }
  }
  return out;
}

/** The way from the lane to the road: through the junction only (or round the ring), without turning round. */
function shortWay(graph: LaneGraph, lane: Lane, goal: Edge, most: number): boolean {
  const r = graph.route(lane, goal, false);
  return !!r && r.length > 0 && r.length <= most && !r.some((c) => c.turn === TURN.UTURN);
}

interface Candidate {
  lane: Lane;
  node: Node | null;
  goal: Edge | null;
  score: number;
  before: number;
}

/**
 * Look for a place for a lesson round (x, z) in the roads that are loaded:
 * null if there is none.  `kind` 'area' needs no place (null).
 */
export function findLessonPlace(world: World, graph: LaneGraph, kind: PlaceKind, x: number, z: number, opt: PlaceOptions = {}): LessonSpot | null {
  const radius = opt.radius ?? searchRadius(kind);
  const rnd = opt.rnd ?? Math.random;
  const usable = opt.usable ?? ((): boolean => true);
  const near = (px: number, pz: number): number => Math.hypot(px - x, pz - z);
  const cands: Candidate[] = [];
  // (each candidate a little shuffled: not always the same place nearest the middle)
  const score = (d: number, room: number): number => d + rnd() * 500 - Math.min(room, LEAD_IN) * 2;

  if (kind === 'quiet') {
    // a quiet, straight, level street of a built-up area, long enough to get to 30 km/h and stop again
    for (const e of world.allEdges) {
      if (e.cls !== CLS.RESIDENTIAL && e.cls !== CLS.UNCLASSIFIED) continue;
      if (!(e.flags & EF.URBAN) || e.flags & (EF.MINOR_SERVICE | EF.BRIDGE | EF.TUNNEL) || !startRoad(e)) continue;
      const len = e.len - e.cutA - e.cutB;
      if (len < 180) continue;
      const p = e.pl.pts;
      const k = p.length - 3;
      const d = near((p[0] + p[k]) / 2, (p[2] + p[k + 2]) / 2);
      if (d > radius) continue;
      if (Math.hypot(p[k] - p[0], p[k + 2] - p[2]) < 0.97 * e.len) continue;
      if (Math.abs(p[k + 1] - p[1]) > 0.04 * e.len) continue;
      const el = graph.edgeLanes[e.id];
      const lane = el ? ([...el.fwd, ...el.back].filter(usable).find((l) => l.idx === 0) ?? null) : null;
      if (!lane) continue;
      cands.push({ lane, node: null, goal: null, score: d + rnd() * 500, before: lane.len - 20 });
    }
  } else if (kind !== 'area') {
    for (const n of world.allNodes) {
      if (n.stub || n.arms.length < 2) continue;
      const d = near(n.x, n.z);
      if (d > radius) continue;
      if (kind === 'rural' || kind === 'motorway') {
        if (n.arms.length < 2) continue;
      } else if (!junctionOfType(n, kind)) continue;
      for (const a of n.arms) {
        if (!a.isApproach || !startRoad(a.edge)) continue;
        if (kind === 'roundabout' && a.edge.flags & EF.ROUNDABOUT) continue;
        // the priority lesson is about giving way: from the road with the sign
        if (kind === 'priority' && a.role !== ROLE.YIELD && a.role !== ROLE.STOP) continue;
        if (kind === 'signals' && a.sg < 0 && a.lamp < 0) continue;
        const lane = arriving(graph, a, usable);
        if (!lane || lane.len < 45) continue;
        const goal = pickGoal(world, graph, kind, n, a, lane, rnd);
        if (goal === undefined) continue;
        // (towards the country road from the town, if there is such a place: out of town is the lesson)
        cands.push({ lane, node: n, goal, score: score(d, lane.len) + (kind === 'rural' && !(a.edge.flags & EF.URBAN) ? 600 : 0), before: LEAD_IN });
      }
    }
  }
  if (cands.length === 0) return null;
  cands.sort((p, q) => p.score - q.score);
  const c = cands[0];
  const at = spotOn(c.lane, c.before);
  return { ...at, name: c.lane.edge.name || c.lane.edge.ref || '', goal: c.goal, node: c.node };
}

/**
 * The destination behind the place: a road leading away from the junction
 * (a turn rather than straight on where there is one), the country road at
 * the edge of town, the motorway behind the slip road.  undefined: this
 * approach does not lead to what the lesson is about.
 */
function pickGoal(world: World, graph: LaneGraph, kind: PlaceKind, n: Node, from: Arm, lane: Lane, rnd: () => number): Edge | null | undefined {
  if (kind === 'rural') {
    // a road of the open country leading away from here
    for (const b of n.arms) {
      const e = b.edge;
      if (b === from || !b.isExit || e.flags & EF.URBAN || e.tier < 3 || e.cls <= CLS.TRUNK_LINK || e.len < 180) continue;
      if (goalRoad(graph, e) && shortWay(graph, lane, e, 1)) return e;
    }
    return undefined;
  }
  if (kind === 'motorway') {
    // a slip road onto the motorway from here – and the motorway it leads to
    const link = n.arms.find((b) => b !== from && b.isExit && b.edge.cls === CLS.MOTORWAY_LINK);
    if (!link || !shortWay(graph, lane, link.edge, 1)) return undefined;
    const ways: Array<{ e: Edge; d: number }> = [];
    for (const e of world.allEdges) {
      if (e.cls !== CLS.MOTORWAY || e.len < 250) continue;
      const d = Math.hypot(e.a.x - n.x, e.a.z - n.z);
      if (d < 2500) ways.push({ e, d });
    }
    ways.sort((p, q) => p.d - q.d);
    for (const { e } of ways.slice(0, 8)) {
      const r = graph.route(lane, e, false);
      if (r && r.length <= 8 && r[0].to.edge === link.edge && !r.some((c) => c.turn === TURN.UTURN)) return e;
    }
    return undefined;
  }
  // a junction: through it to one of its other roads – round the ring to an exit of the roundabout
  const nodes = kind === 'roundabout' ? ringOf(n) : [n];
  const exits: Edge[] = [];
  for (const m of nodes) {
    for (const b of m.arms) {
      const e = b.edge;
      if (b === from || e === from.edge || !b.isExit || e.flags & EF.ROUNDABOUT || e.cls <= CLS.TRUNK_LINK) continue;
      if (goalRoad(graph, e)) exits.push(e);
    }
  }
  // (shuffled, turns first: the lesson is about the junction, and turning shows more of it)
  const order = exits.map((e) => ({ e, k: rnd() + (kind !== 'roundabout' && turnOf(graph, lane, e) === TURN.STRAIGHT ? 1 : 0) })).sort((p, q) => p.k - q.k);
  for (const { e } of order) if (shortWay(graph, lane, e, kind === 'roundabout' ? nodes.length + 2 : 1)) return e;
  return undefined;
}

/** How the lane's way turns into road `e` at its end (TURN; -1 if it does not lead there directly). */
function turnOf(graph: LaneGraph, lane: Lane, e: Edge): number {
  const el = graph.edgeLanes[lane.edge.id];
  for (const l of el ? (lane.dir > 0 ? el.fwd : el.back) : [lane]) for (const c of l.out) if (c.to.edge === e) return c.turn;
  return -1;
}
