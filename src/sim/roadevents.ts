// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What happens on the roads today: roadworks, and now and then a
 * demonstration in a town centre.
 *
 * Roadworks.  Every road decides each day by itself – by a hash of its
 * number in the map and of the date – whether it has a work zone today: the
 * longer and the busier it is, the likelier.  So there are a few around the
 * player wherever that is, in town and outside, the same ones whichever part
 * of the map is loaded – and other ones tomorrow.  A zone fences off a
 * stretch of one side of the road:
 *
 *  - where that direction has more lanes than one, one of them ('lane'):
 *    the traffic moves over in good time; signs 121 and 222 say to which side;
 *  - on a road with one lane each way, that lane: both directions pass on
 *    the other one in turns – by a temporary traffic light whose red lasts
 *    until the last vehicle is through ('light'), or, where the stretch is
 *    short and can be seen, by the signs 208 and 308: the side of the work
 *    lets the oncoming traffic go first ('signs').
 *
 * Before it stand sign 123 (some 50 m in town, 100–200 m outside), the
 * limit (274) and the narrowing (120/121), at it the barrier (600), along it
 * the beacons (605), behind it the end of the limit (278).  The traffic keeps
 * out of the closed lane and waits at the light or for the oncoming cars;
 * the rule monitor knows the limit, the light and the closed lane; the way
 * planners go through (a little slower).
 *
 * Demonstrations.  On Saturdays around midday – and now and then on other
 * days – people march through the centre of Kassel or of Baunatal: a crowd
 * walks slowly along a street which the police close.  The traffic and the
 * planned ways go round it, and whoever drives up stops at the barrier.
 *
 * Both follow the game's clock (game/clock.ts): whoever sets another day in
 * the arcade mode sees that day's events.
 *
 * Words used below: a station is how far along a road from its junction a
 * (m); an offset how far to the left of the direction a → b; a lane's
 * distance how far along the lane from its start.
 */
import { clamp, hash01, newPolySample, projectOnPolyline, samplePolyline, smoothstep } from '../core/geom.ts';
import type { PolySample } from '../core/geom.ts';
import { gameClock } from '../game/clock.ts';
import { latLonToWorld } from '../geo/utm.ts';
import { LaneGraph } from '../world/lanes.ts';
import type { Connector, Lane } from '../world/lanes.ts';
import { wayOf } from '../world/routegraph.ts';
import type { SignPost } from '../world/tilefmt.ts';
import { CLS, EF } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { Edge, Node, World, WorldChange } from '../world/world.ts';
import type { RailNetwork, RailObstacle } from './rail.ts';
import type { PlayerSnapshot, RuleMonitor } from './rules.ts';
import { SIG } from './signals.ts';
import type { SignalSystem } from './signals.ts';
import { berlinClock, berlinOffset, isHoliday } from './timetable.ts';
import type { PlayerState, TrafficCar } from './traffic.ts';

// ------------------------------------------------------------------------------------ roadworks

/** How the traffic passes a work zone: one lane of several closed – one side closed, a temporary light – one side closed, signs 208/308. */
export type WorksControl = 'lane' | 'light' | 'signs';

/** The parts of a work zone the player meets and the renderer draws (worked out once it is near). */
export interface WorksLayout {
  /** sign posts like those of the map, on mobile feet */
  signs: SignPost[];
  /** barriers (Zeichen 600) across the fenced strip: from (x1, z1) to (x2, z2) on the ground at y, facing `yaw`, with lamps on top */
  barriers: Array<{ x1: number; z1: number; x2: number; z2: number; y: number; yaw: number; lamps: number }>;
  /** beacons (Zeichen 605): facing `yaw`, the stripes falling towards the side the traffic passes (`pass` 1: its left, -1: its right), some with a lamp */
  beacons: Array<{ x: number; y: number; z: number; yaw: number; pass: number; lamp: boolean }>;
  /** traffic cones round the pit */
  cones: Array<{ x: number; y: number; z: number }>;
  /** the fence round the pit: its corners (x, z, …, a closed ring) on the ground at y – empty when there is none */
  fence: number[];
  fenceY: number;
  /** the pit: its middle, which way it runs, how long and wide */
  pit: { x: number; y: number; z: number; yaw: number; len: number; wid: number } | null;
  /** a mini excavator, a heap of gravel, a site trailer */
  machines: Array<{ kind: 'excavator' | 'heap' | 'trailer'; x: number; y: number; z: number; yaw: number }>;
  /** the temporary lights: where they stand, facing the traffic of their group (0: the side of the work) */
  lights: Array<{ x: number; y: number; z: number; yaw: number; group: 0 | 1 }>;
  /** the workers: each walks to and fro between two points (the same point: stands), facing `yaw` when standing */
  workers: Array<{ x1: number; z1: number; x2: number; z2: number; y: number; yaw: number; look: number }>;
  /** what the player's vehicle runs into: discs (x, y, z, r, …) and pieces of wall (x1, z1, x2, z2, y, …) */
  discs: number[];
  segments: number[];
  /** what the traffic stops for (the fenced strip, in pieces) */
  boxes: PlayerState[];
}

/** A work zone of today on a road that is loaded. */
export interface WorkZone {
  readonly kind: 'works';
  /** the road's number in the map */
  readonly id: number;
  /** the road (a new object whenever it is loaded again: the zone is made anew with it) */
  readonly edge: Edge;
  /** the fenced stretch, stations z0 < z1 */
  readonly z0: number;
  readonly z1: number;
  /** the side closed: 1 the lanes running a → b, -1 those running b → a */
  readonly side: 1 | -1;
  readonly control: WorksControl;
  /** the closed lane: its index among the lanes of that side (0: the right-most) */
  readonly lane: number;
  /** the limit through the zone (km/h; 0: none of its own) */
  readonly limit: number;
  /** how far before the zone sign 123 stands, how long the taper of beacons is (m) */
  readonly warn: number;
  readonly taper: number;
  readonly urban: boolean;
  readonly street: string;
  /** the middle of the zone */
  readonly x: number;
  readonly z: number;
  /** across the road (offsets): where the fenced strip begins at the edge of the road, and the line of its beacons */
  readonly outer: number;
  readonly line: number;
  /** how far the vehicles of the side of the work move over to pass it (m; 'lane': 0) */
  readonly pass: number;
  /** the light: green for the side of the work and for the other side, all-red to clear the stretch (s), where its cycle begins */
  readonly green: readonly [number, number];
  readonly clear: number;
  readonly offset: number;
  /** settles everything else (where the machines stand, the people) */
  readonly seed: number;
  /** vehicles in the stretch now, and coming up to it, per direction (0: a → b, 1: b → a) – counted each step */
  readonly inside: [number, number];
  readonly coming: [number, number];
  /** how far the nearest of those coming is from its line (m), per direction */
  readonly comingNear: [number, number];
  /** cars standing at the end of a closed lane to move over: their fronts and lengths, pairwise */
  readonly mergers: number[];
  /** worked out when first needed */
  layout: WorksLayout | null;
}

/**
 * zones per kilometre of road and day: outside towns on the main roads, outside on the others, in town on
 * main roads, in town on the others – on the map of northern Hesse some three or four within 2 km of
 * wherever one is (a road shorter than a zone with its signs has none: in the centre of Kassel most are)
 */
export const WORKS_RATE = { ruralMain: 0.6, ruralMinor: 0.25, urbanMain: 0.4, urbanMinor: 0.13 } as const;

/** Where the shared stretch (the taper included) begins for a vehicle going `dir` (station). */
export function entryOf(z: WorkZone, dir: number): number {
  return dir > 0 ? z.z0 - z.taper : z.z1 + z.taper;
}

/** … and where it ends. */
export function exitOf(z: WorkZone, dir: number): number {
  return dir > 0 ? z.z1 + z.taper : z.z0 - z.taper;
}

/** Where a vehicle going `dir` waits before the stretch (its front, station). */
export function waitOf(z: WorkZone, dir: number): number {
  return entryOf(z, dir) - dir * 3;
}

/** A lane's distance of a station. */
function along(lane: Lane, s: number): number {
  return (s - lane.s0) * lane.dir;
}

/** The yaw of something facing the traffic that goes `dir` along a road whose direction a → b is (tx, tz). */
function faceYaw(dir: number, tx: number, tz: number): number {
  return Math.atan2(dir * tx, dir * tz);
}

/** May a road have roadworks: a road of the network (no motorway, slip road or roundabout, no bridge or tunnel)? */
export function worksSite(e: Edge): boolean {
  const c = e.cls;
  if (c < CLS.TRUNK || c > CLS.RESIDENTIAL || c === CLS.TRUNK_LINK || c === CLS.PRIMARY_LINK || c === CLS.SECONDARY_LINK || c === CLS.TERTIARY_LINK) return false;
  if ((e.flags & (EF.ROUNDABOUT | EF.BRIDGE | EF.TUNNEL | EF.MINOR_SERVICE | EF.LINK)) !== 0 || e.layer !== 0 || e.zone === 7) return false;
  return LaneGraph.drivable(e, true);
}

/** A number that stands for a day (as the lights that are out of order count them). */
export function dayKey(y: number, m: number, d: number): number {
  return y * 372 + (m - 1) * 31 + d;
}

/**
 * The work zone a road has on a day (`day`: dayKey), or null.  The same
 * road gives the same zone all day – whenever it is loaded.
 */
export function worksOn(e: Edge, day: number, lanes: LaneGraph): WorkZone | null {
  if (!worksSite(e)) return null;
  const el = lanes.edgeLanes[e.id];
  if (!el) return null;
  const nf = el.fwd.length;
  const nb = el.back.length;
  const urban = (e.flags & EF.URBAN) !== 0;
  const main = e.tier >= 3;
  const r = (k: number): number => hash01(Math.imul(e.id + 1, 0x2c1b3c6d) ^ Math.imul(day + 7, 0x297a2d39) ^ Math.imul(k + 1, 0x632be5ab));
  const usable = e.len - e.cutA - e.cutB;
  const rate = urban ? (main ? WORKS_RATE.urbanMain : WORKS_RATE.urbanMinor) : main ? WORKS_RATE.ruralMain : WORKS_RATE.ruralMinor;
  // (no road has works on more than two days in five)
  if (usable < 60 || r(0) >= Math.min(0.4, (rate * usable) / 1000)) return null;
  // which side, and how the traffic passes
  let side: 1 | -1;
  let control: WorksControl;
  let laneIdx = 0;
  let len: number;
  if (nf === 1 && nb === 1) {
    side = r(1) < 0.5 ? 1 : -1;
    len = urban ? 16 + r(3) * (main ? 70 : 45) : 60 + r(3) * 190;
    control = urban && len < 36 && (!main || r(4) < 0.35) ? 'signs' : 'light';
  } else if (nf >= 2 || nb >= 2) {
    side = nf >= 2 && (nb < 2 || r(1) < 0.5) ? 1 : -1;
    control = 'lane';
    const n = side > 0 ? nf : nb;
    // (the left-most lane only where nobody comes the other way beside it: a carriageway of its own)
    laneIdx = (nf === 0 || nb === 0) && r(2) < 0.35 ? n - 1 : 0;
    len = urban ? 40 + r(3) * 100 : 120 + r(3) * 260;
  } else return null;
  const taper = control === 'lane' ? (urban ? 18 : 45) : urban ? 10 : 30;
  // room before it for the signs and to stop: the line to wait at at least this far from the junction
  const approach = urban ? 30 : 110;
  const room = usable - 2 * (taper + approach);
  if (room < 14) return null;
  len = Math.max(14, Math.min(len, room));
  if (control === 'signs' && len > 40) control = 'light';
  const z0 = e.cutA + approach + taper + r(6) * (room - len);
  const z1 = z0 + len;
  // not over a crossing for people on foot
  for (const x of e.xings) if (x.s + x.w / 2 > z0 - taper - 10 && x.s - x.w / 2 < z1 + taper + 10) return null;
  // the limit through it (if the road's own is higher)
  const road = Math.max(e.maxF, e.maxB);
  const over = (v: number): boolean => road <= 0 || road > v;
  let limit = 0;
  if (urban) limit = over(30) ? 30 : 0;
  else if (control === 'lane') limit = over(70) ? 70 : over(50) ? 50 : 0;
  else limit = over(50) ? 50 : over(30) ? 30 : 0;
  const warn = urban ? 30 + r(5) * 25 : 120 + r(5) * 80;
  // the light: a green each way, and all red long enough for the last one to get through
  const green: [number, number] = urban ? [14 + Math.round(r(7) * 8), 14 + Math.round(r(8) * 8)] : [24 + Math.round(r(7) * 12), 24 + Math.round(r(8) * 12)];
  return makeZone(e, lanes, { side, control, lane: laneIdx, z0, z1, taper, limit, warn, green, phase: r(9), seed: Math.floor(r(10) * 1e6) });
}

/** What settles a work zone (worksOn chooses it by the day; tests give it). */
export interface ZoneSpec {
  side: 1 | -1;
  control: WorksControl;
  lane: number;
  z0: number;
  z1: number;
  taper: number;
  limit: number;
  warn: number;
  green: [number, number];
  /** where the light's cycle begins, 0 … 1 */
  phase: number;
  seed: number;
}

/** A work zone of these measures on a road whose lanes are known. */
export function makeZone(e: Edge, lanes: LaneGraph, spec: ZoneSpec): WorkZone {
  const el = lanes.edgeLanes[e.id];
  const { side, control, z0, z1, taper, limit, warn, green, seed } = spec;
  const laneIdx = spec.lane;
  const len = z1 - z0;
  const urban = (e.flags & EF.URBAN) !== 0;
  // across: the closed lane, the edge of the road beyond it, the line of the beacons
  const lanesOf = side > 0 ? el.fwd : el.back;
  const L = lanesOf[laneIdx];
  const W = e.width;
  let outer: number;
  let inner: number;
  if (laneIdx === 0) {
    outer = -side * (W / 2);
    inner = L.off + (side * L.width) / 2;
  } else {
    outer = side * (W / 2);
    inner = L.off - (side * L.width) / 2;
  }
  const line = inner + Math.sign(outer - inner) * 0.3;
  let pass = 0;
  if (control !== 'lane') {
    const O = (side > 0 ? el.back : el.fwd)[0];
    pass = Math.abs(L.off - O.off);
  }
  const clear = Math.ceil((len + 2 * taper + 6) / 8) + 2;
  const cycle = green[0] + green[1] + 2 * (3 + clear + 1);
  const p = newPolySample();
  samplePolyline(e.pl, (z0 + z1) / 2, p);
  return {
    kind: 'works',
    id: e.id,
    edge: e,
    z0,
    z1,
    side,
    control,
    lane: laneIdx,
    limit,
    warn,
    taper,
    urban,
    street: e.name || e.ref,
    x: p.x,
    z: p.z,
    outer,
    line,
    pass,
    green,
    clear,
    offset: spec.phase * cycle,
    seed,
    inside: [0, 0],
    coming: [0, 0],
    comingNear: [Infinity, Infinity],
    mergers: [],
    layout: null,
  };
}

/** What the light of a zone shows to a group (0: the side of the work, 1: the other) at a time (s, the signals' clock) – and since when (s). */
export function lightAt(z: WorkZone, group: 0 | 1, t: number): { state: number; age: number } {
  const [g0, g1] = z.green;
  const c = z.clear;
  // green for the side of the work, amber, all red, red-amber for the others, their green, amber, all red, red-amber
  const states0 = [SIG.GREEN, SIG.AMBER, SIG.RED, SIG.RED, SIG.RED, SIG.RED, SIG.RED, SIG.RED_AMBER];
  const states1 = [SIG.RED, SIG.RED, SIG.RED, SIG.RED_AMBER, SIG.GREEN, SIG.AMBER, SIG.RED, SIG.RED];
  const lens = [g0, 3, c, 1, g1, 3, c, 1];
  let cycle = 0;
  for (const l of lens) cycle += l;
  let u = (t + z.offset) % cycle;
  if (u < 0) u += cycle;
  const states = group === 0 ? states0 : states1;
  let k = 0;
  while (u >= lens[k]) {
    u -= lens[k];
    k++;
  }
  // (how long it has shown this: back through the phases before that showed the same)
  let age = u;
  for (let j = 1; j < lens.length; j++) {
    const i = (k - j + lens.length) % lens.length;
    if (states[i] !== states[k]) break;
    age += lens[i];
  }
  return { state: states[k], age };
}

// ------------------------------------------------------------------------------------ demonstrations

/** A place where people gather for a demonstration. */
export interface DemoPlace {
  name: string;
  town: string;
  lat: number;
  lon: number;
  /** how often it is chosen against the others */
  weight: number;
}

/** The centres of Kassel and Baunatal. */
export const DEMO_PLACES: readonly DemoPlace[] = [
  { name: 'Königsplatz', town: 'Kassel', lat: 51.3164, lon: 9.4939, weight: 4 },
  { name: 'Friedrichsplatz', town: 'Kassel', lat: 51.3128, lon: 9.4975, weight: 4 },
  { name: 'Obere Königsstraße', town: 'Kassel', lat: 51.3147, lon: 9.496, weight: 2 },
  { name: 'Stadtmitte', town: 'Baunatal', lat: 51.2557, lon: 9.4104, weight: 2 },
];

/** A demonstration of the day. */
export interface Demonstration {
  readonly kind: 'demo';
  readonly id: number;
  readonly place: string;
  readonly town: string;
  /** where it gathers (world) */
  readonly x: number;
  readonly z: number;
  /** when it begins and ends (ms since 1970, by the game's clock) */
  readonly from: number;
  readonly until: number;
  /** how many people walk */
  readonly size: number;
  readonly seed: number;
  /** the march (null: not known yet – the roads there are not loaded) */
  route: DemoRoute | null;
  /** the barriers, the officers – worked out when first needed */
  layout: ClosureLayout | null;
}

/** The way of a march along the roads, and what is closed for it. */
export interface DemoRoute {
  /** the roads (their numbers in the map) in the order walked, which way each is walked (1: a → b), their lengths, where each begins along the way */
  edges: number[];
  dirs: number[];
  lens: number[];
  cum: number[];
  length: number;
  /** the street most of it follows */
  street: string;
  /** the junctions along it, from where it begins to where it ends */
  nodes: number[];
  /** the roads it follows; the ways closed – both ways of those roads, and the side roads where they lead into it */
  roads: Set<number>;
  ways: Set<number>;
}

/** What stands at the closure of a march. */
export interface ClosureLayout {
  signs: SignPost[];
  barriers: Array<{ x1: number; z1: number; x2: number; z2: number; y: number; yaw: number; lamps: number }>;
  /** the tape behind the barriers: from (x1, z1) to (x2, z2), y on the ground */
  tape: Array<{ x1: number; z1: number; x2: number; z2: number; y: number }>;
  /** police officers standing at the barriers */
  officers: Array<{ x: number; y: number; z: number; yaw: number }>;
  /** where a police car stands (behind the barriers at the ends) */
  cars: Array<{ x: number; y: number; z: number; yaw: number }>;
  discs: number[];
  segments: number[];
  boxes: PlayerState[];
}

/** a demonstration planned for a day, before its way is known */
export interface DemoPlan {
  id: number;
  place: DemoPlace;
  from: number;
  until: number;
  size: number;
  seed: number;
}

/** The moment of a time of day in Kassel (minutes after midnight) on a date: ms since 1970. */
function berlinMs(y: number, m: number, d: number, minutes: number): number {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  return guess - berlinOffset(guess - 3600_000) * 1000;
}

/**
 * The demonstrations of a day in Kassel and Baunatal: on Saturdays mostly
 * one around midday (sometimes a second in the afternoon), on weekdays now
 * and then one after work, on Sundays seldom; on the 1st of May always one.
 * The same date gives the same ones.
 */
export function demosOn(y: number, m: number, d: number): DemoPlan[] {
  const day = dayKey(y, m, d);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const holiday = isHoliday(y, m, d);
  const r = (k: number): number => hash01(Math.imul(day + 13, 0x7feb352d) ^ Math.imul(k + 1, 0x846ca68b) ^ 0x5bd1e995);
  // [when it begins (minutes after midnight), how likely]
  const slots: Array<[number, number]> = [];
  if (m === 5 && d === 1) slots.push([10 * 60 + 30, 1]);
  else if (weekday === 6) slots.push([11 * 60 + 30, 0.65], [14 * 60 + 30, 0.25]);
  else if (weekday === 0 || holiday) slots.push([13 * 60, 0.15]);
  else slots.push([12 * 60, 0.06], [17 * 60, 0.13]);
  const out: DemoPlan[] = [];
  let total = 0;
  for (const p of DEMO_PLACES) total += p.weight;
  slots.forEach(([start, p], k) => {
    if (r(k * 8) >= p) return;
    const begin = start + (Math.floor(r(k * 8 + 1) * 7) - 3) * 15;
    const minutes = 60 + Math.floor(r(k * 8 + 2) * 6) * 15;
    let pick = r(k * 8 + 3) * total;
    let place = DEMO_PLACES[0];
    for (const pl of DEMO_PLACES) {
      pick -= pl.weight;
      if (pick < 0) {
        place = pl;
        break;
      }
    }
    // (not twice at the same place at once)
    if (out.some((o) => o.place === place && o.until > berlinMs(y, m, d, begin))) place = DEMO_PLACES[(DEMO_PLACES.indexOf(place) + 1) % DEMO_PLACES.length];
    const big = weekday === 6 || (m === 5 && d === 1);
    const size = Math.round((big ? 60 : 30) + r(k * 8 + 4) * (big ? 160 : 90));
    out.push({ id: day * 8 + k, place, from: berlinMs(y, m, d, begin), until: berlinMs(y, m, d, begin + minutes), size, seed: Math.floor(r(k * 8 + 5) * 1e6) });
  });
  return out;
}

/** May a march walk along this road (and its closure make sense)? */
function marchable(e: Edge): boolean {
  if (e.cls < CLS.PRIMARY || e.cls > CLS.LIVING_STREET || e.cls === CLS.PRIMARY_LINK || e.cls === CLS.SECONDARY_LINK || e.cls === CLS.TERTIARY_LINK) return false;
  if ((e.flags & (EF.ROUNDABOUT | EF.BRIDGE | EF.TUNNEL)) !== 0 || e.layer !== 0) return false;
  return e.lanesF + e.lanesB > 0;
}

/** The road to march on from a junction reached along `from`: on along the same street, or the straightest (no turn round a corner) – null at the end. */
function onward(node: Node, from: Edge, used: Set<number>): Edge | null {
  if (node.stub || node.arms.length < 2) return null;
  const inArm = node.arms.find((a) => a.edge === from);
  if (!inArm) return null;
  let best: Edge | null = null;
  let bestScore = -Infinity;
  for (const a of node.arms) {
    const e = a.edge;
    if (e === from || used.has(e.id) || !marchable(e) || (a.out ? e.b : e.a).stub) continue;
    // (1: straight on – the arm leaves the junction the way the march arrived; a bend of up to some 80° is
    // followed, a turn round a corner is not)
    const straight = -(inArm.dx * a.dx + inArm.dz * a.dz);
    if (straight < 0.15) continue;
    const score = straight + (from.name !== '' && e.name === from.name ? 1 : 0) + (e.tier >= from.tier ? 0.2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

/**
 * The way of a march that gathers near (x, z): from the street nearest to
 * the place on in both directions, along the same street where it goes on
 * (else the straightest road), until it is about `want` metres long.  Null
 * when no street is near.  The same roads give the same way.
 */
export function demoRoute(world: World, x: number, z: number, want: number): DemoRoute | null {
  let start: Edge | null = null;
  let bestD = Infinity;
  const proj = { s: 0, off: 0, d2: 0, seg: 0 };
  world.edgesInBox(x - 260, z - 260, x + 260, z + 260, (e) => {
    if (!e || !marchable(e) || e.a.stub || e.b.stub) return;
    projectOnPolyline(e.pl, x, z, proj);
    if (proj.d2 > 260 * 260) return;
    // (a bigger street is worth a little more distance; ties go to the lower number)
    const d = proj.d2 / (e.tier >= 3 ? 2 : 1);
    if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && start !== null && e.id < start.id)) {
      bestD = d;
      start = e;
    }
  });
  if (!start) return null;
  const first: Edge = start;
  const edges = [first.id];
  const dirs = [1];
  const used = new Set<number>([first.id]);
  let total = first.len;
  let head = { node: first.b, edge: first };
  let tail = { node: first.a, edge: first };
  let canF = true;
  let canB = true;
  for (let k = 0; total < want && (canF || canB) && k < 400; k++) {
    const forward = canF && (!canB || k % 2 === 0);
    const end = forward ? head : tail;
    const next = onward(end.node, end.edge, used);
    if (!next) {
      if (forward) canF = false;
      else canB = false;
      continue;
    }
    used.add(next.id);
    total += next.len;
    const other = next.a === end.node ? next.b : next.a;
    if (forward) {
      edges.push(next.id);
      dirs.push(next.a === end.node ? 1 : -1);
      head = { node: other, edge: next };
    } else {
      edges.unshift(next.id);
      dirs.unshift(next.b === end.node ? 1 : -1);
      tail = { node: other, edge: next };
    }
  }
  const lens: number[] = [];
  const cum: number[] = [];
  const names = new Map<string, number>();
  let length = 0;
  const nodes: number[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = world.edges[edges[i]];
    cum.push(length);
    lens.push(e.len);
    length += e.len;
    if (e.name) names.set(e.name, (names.get(e.name) ?? 0) + e.len);
    nodes.push((dirs[i] > 0 ? e.a : e.b).id);
    if (i === edges.length - 1) nodes.push((dirs[i] > 0 ? e.b : e.a).id);
  }
  let street = '';
  let most = 0;
  for (const [n, l] of names) {
    if (l > most) {
      most = l;
      street = n;
    }
  }
  const roads = new Set(edges);
  const ways = new Set<number>();
  for (const id of edges) ways.add(id * 2).add(id * 2 + 1);
  // the side roads of the junctions it passes: closed where they lead into it
  for (let i = 1; i < nodes.length - 1; i++) {
    const node = world.nodes[nodes[i]];
    if (!node) continue;
    for (const a of node.arms) {
      if (roads.has(a.edge.id)) continue;
      ways.add(a.edge.id * 2 + (a.out ? 1 : 0));
    }
  }
  return { edges, dirs, lens, cum, length, street, nodes, roads, ways };
}

/** How many walk side by side, how far apart the rows are, how long the crowd is (m). */
export function crowdShape(d: Demonstration): { cols: number; rows: number; gap: number; length: number } {
  const cols = 4 + (d.seed % 3);
  const rows = Math.ceil(d.size / cols);
  const gap = 1.15;
  return { cols, rows, gap, length: rows * gap + 1 };
}

/**
 * Where the march is at a moment: how far along its way the front of the
 * crowd is (m), which way it walks (1: as the way runs, -1: back) – the
 * crowd lies behind its front – and whether it is walking.  It gathers at
 * the beginning of its way, then walks along it at a slow pace and back
 * again, with a short rally at each end, until it is over.
 */
export function marchAt(d: Demonstration, ms: number): { head: number; dir: 1 | -1; walking: boolean; speed: number } {
  const route = d.route;
  const shape = crowdShape(d);
  const L = route ? route.length : 0;
  const speed = 0.55;
  // (the front, walking on: from just behind the gathering to the end of the way; back: from there to the beginning)
  const lo = shape.length + 3;
  const span = Math.max(0, L - lo - 3);
  const dur = Math.max(1, (d.until - d.from) / 1000);
  const gather = Math.min(600, dur * 0.12);
  const t = (ms - d.from) / 1000;
  if (t < gather || span <= 0) return { head: Math.min(lo, L), dir: 1, walking: false, speed };
  const leg = span / speed;
  const rest = 240;
  const u = (t - gather) % (2 * (leg + rest));
  if (u < leg) return { head: lo + u * speed, dir: 1, walking: true, speed };
  if (u < leg + rest) return { head: lo + span, dir: 1, walking: false, speed };
  // (turned round: the last rows lead now)
  if (u < 2 * leg + rest) return { head: lo + span - shape.length - (u - leg - rest) * speed, dir: -1, walking: true, speed };
  return { head: 3, dir: -1, walking: false, speed };
}

const routeSmp = newPolySample();

/**
 * A point of the way of a march, `u` metres along it and `side` metres to
 * the left of the walking direction: into `out` (x, z, the walking direction
 * tx, tz) – and the road there with its station, or null without a way.
 */
export function routeAt(world: World, route: DemoRoute, u: number, side: number, out: PolySample): { edge: Edge; s: number } | null {
  const n = route.edges.length;
  let i = 0;
  const v = clamp(u, 0, route.length);
  while (i < n - 1 && route.cum[i + 1] <= v) i++;
  const e = world.edges[route.edges[i]];
  if (!e) return null;
  const local = clamp(v - route.cum[i], 0, e.len);
  const dir = route.dirs[i];
  const s = dir > 0 ? local : e.len - local;
  samplePolyline(e.pl, s, routeSmp);
  const tx = routeSmp.tx * dir;
  const tz = routeSmp.tz * dir;
  out.x = routeSmp.x + tz * side;
  out.z = routeSmp.z - tx * side;
  out.y = routeSmp.y;
  out.tx = tx;
  out.tz = tz;
  return { edge: e, s };
}

// ------------------------------------------------------------------------------------ for the map

/** An event of the day, for the map. */
export interface RoadEventInfo {
  kind: 'works' | 'demo';
  /** where it is (world) */
  x: number;
  z: number;
  /** the street it is in */
  street: string;
  /** when it holds: from and until (ms since 1970, by the game's clock) */
  from: number;
  until: number;
  /** happening now (a demonstration of the day may still lie ahead, or be over) */
  active: boolean;
  /** roadworks: how the traffic passes ('lane', 'light', 'signs'); a demonstration: the place it gathers at */
  detail: string;
  /** a demonstration: the course of its march (x, z, …; empty while its roads are not loaded) */
  line: number[];
}

/** What a vehicle on a lane is asked by the roadworks and closures (RoadEvents.gate). */
export interface Gate {
  /** stop this far ahead of the front (m; Infinity: no need) */
  stop: number;
  /** at most this fast (m/s; Infinity: as the road allows) */
  cap: number;
  /** the lane ends ahead (closed): the one to move over to */
  move: Lane | null;
  /** the road the vehicle meant to turn into next is closed: choose another way */
  reroute: boolean;
  /** why it stops: red at the site light, the oncoming traffic at the narrowing, the end of a closed lane, a closed road */
  why: '' | 'light' | 'oncoming' | 'lane' | 'closed';
}

/** The part of the game's collider the events use (sim/collision.ts). */
export interface EventCollider {
  add(src: { key: string; rings: null; ringCounts: null; segments: Float32Array | null; discs: number[] }): void;
  remove(key: string): void;
}

/** what is fenced off and stands about is put into the collider within this distance of the player (m), taken out beyond the other */
const NEAR = 450;
const FAR = 650;

/**
 * The events of the day around the player: the work zones of the loaded
 * roads, today's demonstrations; what they ask of the traffic, the rule
 * monitor and the way planners.
 */
export class RoadEvents {
  readonly world: World;
  readonly lanes: LaneGraph;
  readonly signals: SignalSystem;
  /** the moment of the world (ms since 1970): the game's clock */
  now: () => number = () => gameClock.ms();
  /** is the road network within r metres of a place loaded (a map in pieces)? – a march's way is looked for once it is */
  ready: (x: number, z: number, r: number) => boolean = () => true;
  /** what the player's vehicle runs into (the game's SceneryCollider) */
  collider: EventCollider | null = null;
  /** the work zones of the loaded roads, by the road's number */
  readonly zones = new Map<number, WorkZone>();
  /** today's demonstrations */
  demos: Demonstration[] = [];
  /** grows whenever the zones or the closures change (for whoever draws them or plans ways) */
  version = 0;
  /** the day the zones are of (dayKey; -1: none yet) */
  private day = -1;
  /** the ways closed now (for the traffic), and those closed or about to be (for the way planners) */
  private readonly shut = new Set<number>();
  private readonly shutSoon = new Set<number>();
  /** the roads a march walks along now */
  private readonly shutRoads = new Set<number>();
  /** the junctions where a closure begins (no car to appear just beside them) */
  private readonly shutNodes = new Set<number>();
  private tick = 0;
  private readonly hit = newSurfaceHit();
  private readonly smp = newPolySample();
  private readonly g: Gate = { stop: Infinity, cap: Infinity, move: null, reroute: false, why: '' };
  private readonly g2: Gate = { stop: Infinity, cap: Infinity, move: null, reroute: false, why: '' };
  /** what is in the collider now: by key */
  private readonly inCollider = new Set<string>();
  /** the obstacles the traffic gets: the game's and these */
  private readonly blockList: PlayerState[] = [];
  /** the player: where it was last (for the tips, the collider), its front's station on a zone's road last step */
  private px = NaN;
  private pz = NaN;
  private prevFront: { zone: WorkZone; dir: number; s: number; t: number } | null = null;
  private inStrip = 0;
  /** the player was last on a road that is open (a road closed for a march is entered from there), and where */
  private wasOpen = false;
  private jx = NaN;
  private jz = NaN;
  /** what was said to the player (zone id * 2 + direction, or -1 - demo id), and the tip waiting to be shown */
  private readonly told = new Set<number>();
  private tipKey = '';
  /** the tracks of the trams and trains (sim/rail.ts): no work zone where one runs along the road */
  private tracks: RailNetwork | null = null;

  constructor(world: World, lanes: LaneGraph, signals: SignalSystem) {
    this.world = world;
    this.lanes = lanes;
    this.signals = signals;
  }

  /** For the map loader (MapLoader.listen): zones come and go with their roads. */
  readonly listener = {
    added: (c: WorldChange): void => this.addRoads(c.edges),
    removed: (c: WorldChange): void => this.dropRoads(c.edges),
  };

  /** Roads that are loaded now: their zones of the day. */
  addRoads(edges: Iterable<Edge>): void {
    if (this.day < 0) return;
    let any = false;
    for (const e of edges) {
      const z = worksOn(e, this.day, this.lanes);
      if (z && !this.overTrack(z)) {
        this.zones.set(e.id, z);
        any = true;
      }
    }
    if (any) this.version++;
  }

  /**
   * The tracks of the trams and trains, once they are read: the zones that
   * lie where a track runs along the road go (the trams cannot pass them).
   */
  setTracks(net: RailNetwork): void {
    this.tracks = net;
    let any = false;
    for (const [id, z] of this.zones) {
      if (!this.overTrack(z)) continue;
      this.zones.delete(id);
      this.uncollide(`works:${id}`);
      any = true;
    }
    if (any) this.version++;
  }

  /** Does a track run along the road of a zone, within its carriageway, anywhere on the stretch shared by both directions? */
  private overTrack(z: WorkZone): boolean {
    const net = this.tracks;
    if (!net || net.paths.length === 0) return false;
    const e = z.edge;
    const reach = e.width / 2 + 1;
    const p = this.smp;
    // the middle line of the stretch, every 6 m, and the box round it
    const line: number[] = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let s = z.z0 - z.taper; s <= z.z1 + z.taper + 1e-6; s += 6) {
      samplePolyline(e.pl, clamp(s, 0, e.len), p);
      line.push(p.x, p.z);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    // the tracks that pass the cells over the box (200 m each)
    const near = new Set<number>();
    for (let x = minX - 200; x <= maxX + 200; x += 200) {
      for (let zz = minZ - 200; zz <= maxZ + 200; zz += 200) {
        const list = net.near(x, zz);
        for (let k = 0; k < list.length; k += 2) near.add(list[k]);
      }
    }
    for (const pi of near) {
      const q = net.paths[pi].pts;
      for (let j = 3; j + 2 < q.length; j += 3) {
        const ax = q[j - 3];
        const az = q[j - 1];
        const bx = q[j];
        const bz = q[j + 2];
        // (most pieces of track are nowhere near)
        if (Math.max(ax, bx) < minX - reach || Math.min(ax, bx) > maxX + reach || Math.max(az, bz) < minZ - reach || Math.min(az, bz) > maxZ + reach) continue;
        const dx = bx - ax;
        const dz = bz - az;
        const l2 = dx * dx + dz * dz;
        for (let i = 0; i < line.length; i += 2) {
          const u = l2 > 1e-9 ? clamp(((line[i] - ax) * dx + (line[i + 1] - az) * dz) / l2, 0, 1) : 0;
          if (Math.hypot(ax + dx * u - line[i], az + dz * u - line[i + 1]) < reach) return true;
        }
      }
    }
    return false;
  }

  /** What the trams stop for (sim/rail.ts): the crowds of the marches under way near the player – added to `out`. */
  railBlocks(out: RailObstacle[]): void {
    const ms = this.now();
    for (const d of this.demos) {
      const route = d.route;
      if (!route || ms < d.from || ms >= d.until || Math.abs(d.x - this.px) > 2000 || Math.abs(d.z - this.pz) > 2000) continue;
      const { head, dir } = marchAt(d, ms);
      const shape = crowdShape(d);
      for (let k = -2; k < shape.length + 2; k += 5) {
        const at = routeAt(this.world, route, head - dir * k, 0, this.smp);
        if (at) out.push({ x: this.smp.x, z: this.smp.z, r: Math.max(3, at.edge.width / 2 + 0.5) });
      }
    }
  }

  /** Roads that are taken away: their zones go. */
  dropRoads(edges: Iterable<Edge>): void {
    let any = false;
    for (const e of edges) {
      const z = this.zones.get(e.id);
      if (!z || z.edge !== e) continue;
      this.zones.delete(e.id);
      this.uncollide(`works:${e.id}`);
      any = true;
    }
    if (any) this.version++;
  }

  /** The zone on the road of a lane, if it is the one of that very road. */
  private zoneOn(e: Edge): WorkZone | null {
    const z = this.zones.get(e.id);
    return z && z.edge === e ? z : null;
  }

  // ---------------------------------------------------------------------------- each step

  /**
   * Called by the traffic at the beginning of each of its steps: the day
   * and the demonstrations now and then; who is in or before each zone.
   */
  step(dt: number, cars: readonly TrafficCar[], player: PlayerState): void {
    this.tick -= dt;
    if (this.tick <= 0 || this.day < 0) {
      this.tick = 0.5;
      this.refresh(player);
    }
    for (const z of this.zones.values()) {
      z.inside[0] = z.inside[1] = 0;
      z.coming[0] = z.coming[1] = 0;
      z.comingNear[0] = z.comingNear[1] = Infinity;
      z.mergers.length = 0;
    }
    if (this.zones.size > 0) {
      for (const car of cars) if (car.lane) this.count(car.lane, car.s, car.length, car.v);
      if (player.lane && !player.onFoot) this.count(player.lane, player.s ?? 0, player.length, Math.abs(player.speed));
    }
    if (!player.onFoot) this.tips(player);
  }

  /** One vehicle in or before a zone: counted. */
  private count(lane: Lane, mid: number, length: number, v: number): void {
    const z = this.zoneOn(lane.edge);
    if (!z) return;
    const front = mid + length / 2;
    if (z.control === 'lane') {
      if (lane.dir !== z.side || lane.idx !== z.lane) return;
      const close = along(lane, entryOf(z, z.side));
      if (front > close - 9 && front < close + 0.5 && v < 1) z.mergers.push(front, length);
      return;
    }
    const k = lane.dir > 0 ? 0 : 1;
    const wait = along(lane, waitOf(z, lane.dir));
    const out = along(lane, exitOf(z, lane.dir));
    if (front > wait + 0.3 && mid - length / 2 < out) z.inside[k]++;
    else if (front <= wait + 0.3 && front > wait - 70 && (v > 0.5 || front > wait - 12)) {
      z.coming[k]++;
      if (v > 1.5) z.comingNear[k] = Math.min(z.comingNear[k], wait - front);
    }
  }

  /** The day, the demonstrations, what is closed, what stands in the player's way – twice a second. */
  private refresh(player: PlayerState): void {
    const ms = this.now();
    const c = berlinClock(new Date(ms));
    const day = dayKey(c.y, c.m, c.d);
    if (day !== this.day) {
      this.day = day;
      for (const z of this.zones.values()) this.uncollide(`works:${z.id}`);
      this.zones.clear();
      this.addRoads(this.world.allEdges);
      for (const d of this.demos) this.uncollide(`demo:${d.id}`);
      this.told.clear();
      this.demos = demosOn(c.y, c.m, c.d).map((p) => {
        const [x, z] = latLonToWorld(p.place.lat, p.place.lon);
        return { kind: 'demo', id: p.id, place: p.place.name, town: p.place.town, x, z, from: p.from, until: p.until, size: p.size, seed: p.seed, route: null, layout: null };
      });
      this.version++;
    }
    // (put somewhere else – a start, a jump on the map – rather than driven there)
    const jumped = !(Math.hypot(player.x - this.px, player.z - this.pz) < 80);
    if (Number.isFinite(player.x)) {
      this.px = player.x;
      this.pz = player.z;
    }
    if (this.told.size > 0) this.forget();
    // where the vehicle is: put down inside a fenced strip, that work is done for today; inside a closed road, its barriers let it out
    const hit = this.hit;
    const on = !player.onFoot && Number.isFinite(player.x) && this.world.surfaceAt(player.x, player.z, player.y + 1.5, hit) && hit.edge ? hit.edge : null;
    if (on && jumped) {
      const z = this.zoneOn(on);
      if (z && hit.s > z.z0 - 1 && hit.s < z.z1 + 1 && (hit.off - z.outer) * (hit.off - z.line) < 0) {
        this.zones.delete(z.id);
        this.uncollide(`works:${z.id}`);
        this.version++;
      }
    }
    // the marches: their ways once the roads there are loaded; what is closed now, and soon
    const shut = new Set<number>();
    const soon = new Set<number>();
    const roads = new Set<number>();
    const nodes = new Set<number>();
    for (const d of this.demos) {
      const near = Math.hypot(d.x - this.px, d.z - this.pz) < 3500;
      if (!d.route && near && ms < d.until && ms > d.from - 3 * 3600_000 && this.ready(d.x, d.z, 1200)) {
        d.route = demoRoute(this.world, d.x, d.z, 450 + (d.seed % 7) * 70);
        d.layout = null;
      }
      const route = d.route;
      if (!route) continue;
      const live = ms >= d.from && ms < d.until;
      if (live || (ms < d.until && d.from - ms < 2 * 3600_000)) for (const w of route.ways) soon.add(w);
      if (live) {
        for (const w of route.ways) shut.add(w);
        for (const r of route.roads) roads.add(r);
        nodes.add(route.nodes[0]).add(route.nodes[route.nodes.length - 1]);
        for (let i = 1; i < route.nodes.length - 1; i++) nodes.add(route.nodes[i]);
      }
      // (barriers stand while it is on, near the player – but let out a vehicle that is inside)
      const key = `demo:${d.id}`;
      const dist = Math.hypot(d.x - this.px, d.z - this.pz);
      const inside = on !== null && route.roads.has(on.id);
      if (live && dist < 1800 && !inside) this.collide(key, this.closureLayout(d));
      else if (!live || dist > 2200 || inside) this.uncollide(key);
    }
    if (!sameSet(shut, this.shut) || !sameSet(soon, this.shutSoon)) {
      replace(this.shut, shut);
      replace(this.shutSoon, soon);
      replace(this.shutRoads, roads);
      replace(this.shutNodes, nodes);
      this.version++;
    }
    // the zones: in the collider near the player
    for (const z of this.zones.values()) {
      const d = Math.hypot(z.x - this.px, z.z - this.pz);
      if (d < NEAR) this.collide(`works:${z.id}`, this.worksLayout(z));
      else if (d > FAR) this.uncollide(`works:${z.id}`);
    }
  }

  private collide(key: string, l: { discs: number[]; segments: number[] }): void {
    if (this.inCollider.has(key) || !this.collider) return;
    this.collider.add({ key, rings: null, ringCounts: null, segments: l.segments.length > 0 ? Float32Array.from(l.segments) : null, discs: l.discs });
    this.inCollider.add(key);
  }

  private uncollide(key: string): void {
    if (!this.inCollider.delete(key)) return;
    this.collider?.remove(key);
  }

  /** What is said to the player once as a zone or a closure comes up ahead: a text key waits in `tipKey` (takeTip). */
  private tips(p: PlayerState): void {
    const lane = p.lane;
    if (lane) {
      const z = this.zoneOn(lane.edge);
      if (z) {
        const front = (p.s ?? 0) + p.length / 2;
        const d = along(lane, entryOf(z, lane.dir)) - front;
        const key = z.id * 2 + (lane.dir > 0 ? 0 : 1);
        if (d > 0 && d < (z.urban ? 90 : 220) && !this.told.has(key)) {
          this.told.add(key);
          const mine = lane.dir === z.side;
          this.tipKey =
            z.control === 'lane' ? (mine && lane.idx === z.lane ? 'tipWorksLane' : 'tipWorks') : z.control === 'light' ? 'tipWorksLight' : mine ? 'tipWorks208' : 'tipWorks308';
        }
      }
    }
    // a closure ahead
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    for (const d of this.demos) {
      if (!d.layout || this.told.has(-1 - d.id) || this.now() < d.from || this.now() >= d.until) continue;
      for (const b of d.layout.barriers) {
        const bx = (b.x1 + b.x2) / 2 - p.x;
        const bz = (b.z1 + b.z2) / 2 - p.z;
        const dist = Math.hypot(bx, bz);
        if (dist < 90 && (bx * fx + bz * fz) > dist * 0.8) {
          this.told.add(-1 - d.id);
          this.tipKey = 'tipDemoClosed';
          break;
        }
      }
    }
  }

  /** What was said is said again when the player comes back another time: forgotten once far away (or the march is over). */
  private forget(): void {
    const ms = this.now();
    for (const k of [...this.told]) {
      if (k >= 0) {
        const z = this.zones.get(k >> 1);
        if (!z || Math.hypot(z.x - this.px, z.z - this.pz) > 500) this.told.delete(k);
      } else {
        const d = this.demos.find((o) => o.id === -1 - k);
        if (!d || ms >= d.until || Math.hypot(d.x - this.px, d.z - this.pz) > 1500) this.told.delete(k);
      }
    }
  }

  /** The tip waiting to be shown (a text key) – taken once. */
  takeTip(): string {
    const k = this.tipKey;
    this.tipKey = '';
    return k;
  }

  // ---------------------------------------------------------------------------- for the traffic and the driver

  /**
   * What the zones and closures ask of a vehicle on `lane` whose front is
   * `front` metres along it, going at `v`, turning into `next` at its end:
   * where to stop, how fast at most, whether to move over or to choose
   * another way.  (The answer is overwritten by the next call.)
   */
  gate(lane: Lane, front: number, v: number, next: Connector | null, out: Gate = this.g): Gate {
    out.stop = Infinity;
    out.cap = Infinity;
    out.move = null;
    out.reroute = false;
    out.why = '';
    if (this.zones.size === 0 && this.shut.size === 0) return out;
    const z = this.zoneOn(lane.edge);
    if (z) this.zoneGate(z, lane, front, v, out);
    // just behind the junction ahead: a zone, a closed road
    if (next && lane.len - front < 75) {
      const l2 = next.to;
      const ahead = lane.len - front + next.len;
      if (this.shut.has(wayOf(l2)) && !this.shut.has(wayOf(lane))) {
        out.reroute = true;
        const d = lane.stopAt - front;
        if (d > -1.5 && Math.max(0, d) < out.stop) {
          out.stop = Math.max(0, d);
          out.why = 'closed';
        }
      }
      const z2 = this.zoneOn(l2.edge);
      if (z2) {
        const g2 = this.zoneGate(z2, l2, -ahead, v, this.resetGate(this.g2));
        if (g2.stop < out.stop) {
          out.stop = g2.stop;
          out.why = g2.why;
        }
        out.cap = Math.min(out.cap, g2.cap);
      }
    }
    return out;
  }

  private resetGate(g: Gate): Gate {
    g.stop = Infinity;
    g.cap = Infinity;
    g.move = null;
    g.reroute = false;
    g.why = '';
    return g;
  }

  /** The same for a car of the traffic (null: nothing asked of it). */
  gateCar(car: TrafficCar): Gate | null {
    const lane = car.lane;
    if (!lane) return null;
    const g = this.gate(lane, car.s + car.length / 2, car.v, car.next);
    return g.stop === Infinity && g.cap === Infinity && !g.move && !g.reroute ? null : g;
  }

  private zoneGate(z: WorkZone, lane: Lane, front: number, v: number, out: Gate): Gate {
    const dir = lane.dir;
    // the limit, from its sign on (come up to at an easy deceleration)
    if (z.limit > 0) {
      const from = along(lane, entryOf(z, dir) - dir * this.limitLead(z));
      const to = along(lane, exitOf(z, dir) + dir * 8);
      if (front < to) {
        const vz = z.limit / 3.6;
        out.cap = Math.min(out.cap, Math.sqrt(vz * vz + 2 * 1.5 * Math.max(0, from - front)));
      }
    }
    if (z.control === 'lane') {
      if (dir !== z.side) return out;
      const close = along(lane, entryOf(z, dir));
      if (lane.idx === z.lane) {
        // the lane ends: over to the one beside in good time, else wait at its end for a gap
        if (front < close + 0.5 && close - front < 260) {
          out.move = this.openLane(lane);
          if (close - 2 - front < out.stop) {
            out.stop = Math.max(0, close - 2 - front);
            out.why = 'lane';
          }
        }
      } else if (Math.abs(lane.idx - z.lane) === 1 && front < close + 2) {
        // beside it: one of those waiting at its end is let in (one after the other, § 7 Abs. 4 StVO)
        const m = z.mergers;
        for (let i = 0; i < m.length; i += 2) {
          const ahead = m[i] - front;
          if (ahead > 1.5 && ahead < 26) {
            const d = ahead - m[i + 1] - 3;
            if (d < out.stop) {
              out.stop = Math.max(0, d);
              out.why = 'lane';
            }
          }
        }
      }
      return out;
    }
    // one side closed: in turns
    const wait = along(lane, waitOf(z, dir));
    if (front > wait + 0.3) return out;
    const dist = wait - front;
    if (dist > 130) return out;
    const mine = dir === z.side ? 0 : 1;
    const other = dir > 0 ? 1 : 0;
    let go: boolean;
    let why: Gate['why'] = 'oncoming';
    if (z.control === 'light') {
      const st = lightAt(z, mine, this.signals.time);
      go = st.state === SIG.GREEN || (st.state === SIG.AMBER && (v * v) / (2 * Math.max(dist, 0.5)) > 3.2);
      if (!go) why = 'light';
      go &&= z.inside[other] === 0;
    } else if (mine === 0) {
      // the side of the work (Zeichen 208): the oncoming traffic goes first
      go = z.inside[other] === 0 && z.coming[other] === 0;
    } else go = z.inside[other] === 0;
    if (!go && dist < out.stop) {
      out.stop = dist;
      out.why = why;
    }
    return out;
  }

  /** How far before the zone the limit begins (m): with sign 123 in town, half-way outside. */
  private limitLead(z: WorkZone): number {
    return z.urban ? z.warn : z.warn * 0.5;
  }

  /** The lane beside a closed one (towards the open side), or null. */
  openLane(lane: Lane): Lane | null {
    const el = this.lanes.edgeLanes[lane.edge.id];
    if (!el) return null;
    const list = lane.dir > 0 ? el.fwd : el.back;
    return list[lane.idx === 0 ? 1 : lane.idx - 1] ?? null;
  }

  /** May a vehicle at `front` along `lane` be on it from here on (or move over onto it) – is it not closed ahead within reach? */
  laneOpen(lane: Lane, front: number): boolean {
    const z = this.zoneOn(lane.edge);
    if (!z || z.control !== 'lane' || lane.dir !== z.side || lane.idx !== z.lane) return true;
    const close = along(lane, entryOf(z, lane.dir));
    const end = along(lane, lane.dir > 0 ? z.z1 : z.z0);
    return front < close - 260 || front > end + 4;
  }

  /**
   * How far a vehicle whose middle is `mid` metres along `lane` is drawn to
   * its left: where its side is closed it passes on the other lane (m; 0
   * elsewhere).
   */
  shift(lane: Lane, mid: number): number {
    if (this.zones.size === 0) return 0;
    const z = this.zoneOn(lane.edge);
    if (!z || z.control === 'lane' || lane.dir !== z.side) return 0;
    const a = along(lane, entryOf(z, lane.dir));
    const d = along(lane, exitOf(z, lane.dir));
    if (mid <= a || mid >= d) return 0;
    const b = along(lane, lane.dir > 0 ? z.z0 : z.z1);
    const c = along(lane, lane.dir > 0 ? z.z1 : z.z0);
    if (mid < b) return z.pass * smoothstep(a, b, mid);
    if (mid > c) return z.pass * (1 - smoothstep(c, d, mid));
    return z.pass;
  }

  /** Moves a point `d` metres along `lane` (sampled into `p`, the direction of travel tx, tz) to where the vehicles pass a closed side. */
  offset(lane: Lane, d: number, p: PolySample): void {
    const s = this.shift(lane, d);
    if (s === 0) return;
    p.x += p.tz * s;
    p.z -= p.tx * s;
  }

  /** Is a lane closed now (a demonstration)? */
  closed(lane: Lane): boolean {
    return this.shut.size > 0 && this.shut.has(wayOf(lane));
  }

  /** May no car of the traffic appear here: a closed road, beside a closure, in a zone's stretch? */
  blocked(lane: Lane, s: number): boolean {
    if (this.shut.size > 0) {
      if (this.shut.has(wayOf(lane))) return true;
      if ((this.shutNodes.has(lane.from.id) && s < 30) || (this.shutNodes.has(lane.to.id) && lane.len - s < 30)) return true;
    }
    const z = this.zoneOn(lane.edge);
    if (!z) return false;
    const a = along(lane, entryOf(z, lane.dir)) - 40;
    const b = along(lane, exitOf(z, lane.dir)) + 10;
    return s > a && s < b;
  }

  /** What the way planners add for a way (s): Infinity where it is closed, a little where a zone slows it. */
  wayCost(way: number): number {
    if (this.shutSoon.size > 0 && this.shutSoon.has(way)) return Infinity;
    const z = this.zones.get(way >> 1);
    if (!z) return 0;
    return z.control === 'light' ? 30 : z.control === 'signs' ? 12 : 8;
  }

  /** The obstacles for the traffic: the game's, and the fenced strips, the barriers and the crowd near the player. */
  withBlocks(obstacles: readonly PlayerState[], player: PlayerState): readonly PlayerState[] {
    const out = this.blockList;
    out.length = 0;
    for (const o of obstacles) out.push(o);
    for (const z of this.zones.values()) {
      if (Math.abs(z.x - player.x) > 400 || Math.abs(z.z - player.z) > 400) continue;
      for (const b of this.worksLayout(z).boxes) out.push(b);
    }
    const ms = this.now();
    for (const d of this.demos) {
      if (!d.route || ms < d.from || ms >= d.until || Math.abs(d.x - player.x) > 1500 || Math.abs(d.z - player.z) > 1500) continue;
      for (const b of this.closureLayout(d).boxes) out.push(b);
      this.crowdBoxes(d, ms, out);
    }
    return out;
  }

  /** The crowd of a march as boxes along its way. */
  private crowdBoxes(d: Demonstration, ms: number, out: PlayerState[]): void {
    const route = d.route;
    if (!route) return;
    const { head, dir } = marchAt(d, ms);
    const shape = crowdShape(d);
    const p = this.smp;
    for (let k = 0; k < shape.length; k += 8) {
      const at = routeAt(this.world, route, head - dir * (k + 4), 0, p);
      if (!at) continue;
      out.push({ x: p.x, y: p.y, z: p.z, yaw: Math.atan2(-p.tx, -p.tz), speed: 0, length: 8.5, width: at.edge.width });
    }
  }

  // ---------------------------------------------------------------------------- for the rule monitor

  /** The limit at a place of a road for a vehicle going `dir`: the zone's where its signs say so, else `limit` (km/h; 0: none). */
  limitAt(edge: Edge, s: number, dir: number, limit: number): number {
    const z = this.zoneOn(edge);
    if (!z || z.limit <= 0) return limit;
    const from = entryOf(z, dir) - dir * this.limitLead(z);
    const to = exitOf(z, dir) + dir * 8;
    if ((s - from) * dir < 0 || (s - to) * dir > 0) return limit;
    return limit <= 0 ? z.limit : Math.min(limit, z.limit);
  }

  /** Is the oncoming lane the way here – the stretch of a closed side, for a vehicle going `dir` (no fault to keep left there)? */
  passing(edge: Edge, s: number, dir: number): boolean {
    const z = this.zoneOn(edge);
    if (!z || z.control === 'lane' || dir !== z.side) return false;
    return (s - entryOf(z, dir)) * dir > -2 && (s - exitOf(z, dir)) * dir < 2;
  }

  /**
   * The player's faults at the zones and closures (called by the rule
   * monitor with where the vehicle is: its road, station, offset and
   * direction): over the line on red at the site light, into the stretch
   * without letting the oncoming traffic go first (Zeichen 208), into the
   * fenced strip, into a road closed for a march.
   */
  judge(rules: RuleMonitor, p: PlayerSnapshot, edge: Edge, s: number, off: number, dir: number, dt: number): void {
    const z = this.zoneOn(edge);
    if (z) {
      // the fenced strip
      const lo = Math.min(z.outer, z.line);
      const hi = Math.max(z.outer, z.line);
      if (s > z.z0 + 0.5 && s < z.z1 - 0.5 && off > lo + 0.25 && off < hi - 0.25 && Math.abs(p.speed) > 0.3) {
        this.inStrip += dt;
        if (this.inStrip > 0.5) rules.noteAt('worksLane', 'major', p.x, p.z, {}, 20);
      } else this.inStrip = 0;
      // the line where the stretch is waited for
      if (z.control !== 'lane') {
        const front = s + dir * (p.front ?? p.length / 2);
        const w = waitOf(z, dir);
        const prev = this.prevFront;
        // (from where it was a moment ago: not from where it was before it was put somewhere else)
        if (prev && prev.zone === z && prev.dir === dir && rules.time - prev.t < 0.6 && (prev.s - w) * dir < 0 && (front - w) * dir >= 0 && p.speed > 0.3) {
          const group: 0 | 1 = dir === z.side ? 0 : 1;
          const other = dir > 0 ? 1 : 0;
          if (z.control === 'light') {
            const st = lightAt(z, group, this.signals.time);
            if (st.state === SIG.RED || st.state === SIG.RED_AMBER) rules.noteAt('redLight', st.state === SIG.RED && st.age < 0.6 ? 'major' : 'fail', p.x, p.z, {}, 8);
            else if (st.state === SIG.AMBER && st.age > 1 + p.speed / 7) rules.noteAt('amberLight', 'minor', p.x, p.z, {}, 8);
          } else if (group === 0) {
            if (z.inside[other] > 0) rules.noteAt('worksYield', 'major', p.x, p.z, {}, 10);
            else if (z.comingNear[other] < 35) rules.noteAt('worksYield', 'minor', p.x, p.z, {}, 10);
          }
        }
        this.prevFront = { zone: z, dir, s: front, t: rules.time };
      }
    } else {
      this.inStrip = 0;
      this.prevFront = null;
    }
    // into a road closed for a march (a few metres in: not merely its mouth) – from an open one: whoever was in it
    // when it was closed, or was put there, drives out of it
    if (!(Math.hypot(p.x - this.jx, p.z - this.jz) < 25)) this.wasOpen = false;
    this.jx = p.x;
    this.jz = p.z;
    if (!this.shutRoads.has(edge.id)) this.wasOpen = true;
    else if (s > edge.cutA + 6 && s < edge.len - edge.cutB - 6) {
      if (this.wasOpen && Math.abs(p.speed) > 0.5) rules.noteAt('closedRoad', 'major', p.x, p.z, {}, 30);
      this.wasOpen = false;
    }
  }

  // ---------------------------------------------------------------------------- for the map

  /** The events of the day: the zones of the loaded roads and today's demonstrations (for the map). */
  list(): RoadEventInfo[] {
    const out: RoadEventInfo[] = [];
    const ms = this.now();
    const c = berlinClock(new Date(ms));
    const dayFrom = berlinMs(c.y, c.m, c.d, 0);
    const dayUntil = berlinMs(c.y, c.m, c.d, 24 * 60);
    for (const z of this.zones.values()) out.push({ kind: 'works', x: z.x, z: z.z, street: z.street, from: dayFrom, until: dayUntil, active: true, detail: z.control, line: [] });
    for (const d of this.demos) {
      const line: number[] = [];
      const route = d.route;
      if (route) {
        for (let u = 0; u <= route.length; u += Math.max(10, route.length / 40)) {
          if (routeAt(this.world, route, u, 0, this.smp)) line.push(Math.round(this.smp.x), Math.round(this.smp.z));
        }
      }
      out.push({ kind: 'demo', x: d.x, z: d.z, street: route?.street ?? d.place, from: d.from, until: d.until, active: ms >= d.from && ms < d.until, detail: d.place, line });
    }
    return out;
  }

  /** Is a demonstration under way now – with its way known? */
  marching(d: Demonstration): boolean {
    const ms = this.now();
    return d.route !== null && ms >= d.from && ms < d.until;
  }

  // ---------------------------------------------------------------------------- what stands there

  /** A point of road `e`: station `s`, `o` metres left of a → b, on the ground there (into `out`; returns it). */
  private put(e: Edge, s: number, o: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const p = this.smp;
    samplePolyline(e.pl, clamp(s, 0, e.len), p);
    out.x = p.x + p.tz * o;
    out.z = p.z - p.tx * o;
    const yRef = this.world.edgeY(e, clamp(s, 0, e.len), out.x, out.z);
    out.y = this.world.surfaceAt(out.x, out.z, yRef + 1.5, this.hit) && Math.abs(this.hit.y - yRef) < 1.5 ? this.hit.y : yRef;
    return out;
  }

  /** Everything of a work zone: signs, barriers, beacons, the pit, the machines, the light, the workers (worked out once). */
  worksLayout(z: WorkZone): WorksLayout {
    if (z.layout) return z.layout;
    const e = z.edge;
    const L: WorksLayout = { signs: [], barriers: [], beacons: [], cones: [], fence: [], fenceY: 0, pit: null, machines: [], lights: [], workers: [], discs: [], segments: [], boxes: [] };
    const side = z.side;
    const W = e.width;
    const q = { x: 0, y: 0, z: 0 };
    const q2 = { x: 0, y: 0, z: 0 };
    const p = this.smp;
    const r = (k: number): number => hash01(z.seed * 31 + k * 7919);
    const tangent = (s: number): void => void samplePolyline(e.pl, clamp(s, 0, e.len), p);
    const yawAt = (s: number, dir: number): number => {
      tangent(s);
      return faceYaw(dir, p.tx, p.tz);
    };
    const roadYaw = (s: number): number => {
      tangent(s);
      return Math.atan2(-p.tx, -p.tz);
    };
    // --- signs, for each direction that has lanes
    for (const dir of [1, -1] as const) {
      if ((dir > 0 ? e.lanesF : e.lanesB) === 0) continue;
      const mine = dir === side;
      const entry = entryOf(z, dir);
      const exit = exitOf(z, dir);
      // (on this road: not beyond its lanes)
      const lo = dir > 0 ? e.cutA + 2 : e.len - e.cutB - 2;
      const hi = dir > 0 ? e.len - e.cutB - 2 : e.cutA + 2;
      const within = (s: number): number => (dir > 0 ? clamp(s, lo, hi) : clamp(s, hi, lo));
      const sw = dir > 0 ? e.swR : e.swL;
      const o = -dir * (W / 2 + (sw > 0 ? Math.min(0.6, sw * 0.4) : 0.9));
      const post = (s: number, codes: string[]): void => {
        if (codes.length === 0) return;
        const at = within(s);
        this.put(e, at, o, q);
        L.signs.push({ x: q.x, y: q.y, z: q.z, yaw: yawAt(at, dir), s: codes, h: 1.4 });
        L.discs.push(q.x, q.y, q.z, 0.09);
      };
      const lim = z.limit > 0 ? [`274-${z.limit}`] : [];
      const narrow = z.control === 'lane' ? (mine ? [z.lane === 0 ? '121-10' : '121-20'] : []) : ['120'];
      if (z.urban) {
        post(entry - dir * z.warn, ['123', ...lim]);
        if (z.warn > 24) post(entry - dir * z.warn * 0.45, narrow);
      } else {
        post(entry - dir * z.warn, ['123']);
        post(entry - dir * z.warn * 0.5, [...lim, ...narrow]);
      }
      if (z.control === 'signs') post(entry - dir * 4, [mine ? '208' : '308']);
      if (z.limit > 0) {
        const road = dir > 0 ? e.maxF : e.maxB;
        const usual = z.urban ? 50 : 100;
        post(exit + dir * 8, [road > 0 && road < 200 && road !== usual ? `274-${road}` : road === usual ? `278-${z.limit}` : '282']);
      }
      // the temporary light at the line, on the right
      if (z.control === 'light') {
        const at = waitOf(z, dir) + dir * 0.8;
        this.put(e, at, -dir * (W / 2 + (sw > 0 ? 0.45 : 0.75)), q);
        L.lights.push({ x: q.x, y: q.y, z: q.z, yaw: yawAt(at, dir), group: mine ? 0 : 1 });
        L.discs.push(q.x, q.y, q.z, 0.3);
      }
    }
    // --- the strip: the barrier where it begins for the side of the work, the beacons along it
    const entryC = side > 0 ? z.z0 : z.z1;
    const exitC = side > 0 ? z.z1 : z.z0;
    const inward = Math.sign(z.line - z.outer);
    const outerIn = z.outer + inward * 0.35;
    const passLeft = z.lane === 0;
    this.put(e, entryC, outerIn - inward * 0.2, q);
    this.put(e, entryC, z.line, q2);
    const by = (q.y + q2.y) / 2;
    L.barriers.push({ x1: q.x, z1: q.z, x2: q2.x, z2: q2.z, y: by, yaw: yawAt(entryC, side), lamps: Math.max(2, Math.round(Math.hypot(q2.x - q.x, q2.z - q.z) / 1.1)) });
    L.segments.push(q.x, q.z, q2.x, q2.z, by);
    // (Zeichen 222 above it: pass on the open side)
    this.put(e, entryC - side * 0.5, (z.outer + z.line) / 2, q);
    L.signs.push({ x: q.x, y: q.y, z: q.z, yaw: yawAt(entryC, side), s: [passLeft ? '222-10' : '222'], h: 1.45 });
    const beacon = (s: number, o: number, lamp: boolean): void => {
      this.put(e, s, o, q);
      L.beacons.push({ x: q.x, y: q.y, z: q.z, yaw: yawAt(s, side), pass: passLeft ? 1 : -1, lamp });
      L.discs.push(q.x, q.y, q.z, 0.2);
    };
    const nT = Math.max(2, Math.round(z.taper / (z.urban ? 3 : 7)));
    for (let i = 0; i < nT; i++) {
      const f = i / nT;
      beacon(entryC - side * z.taper * (1 - f), outerIn + (z.line - outerIn) * f, true);
    }
    const len = z.z1 - z.z0;
    const nL = Math.max(1, Math.round(len / (z.urban ? 6 : 12)));
    for (let i = 1; i <= nL; i++) beacon(entryC + side * ((len * i) / nL), z.line, i % 2 === 0 || i === nL);
    // (closing the strip behind: a short slant back towards the edge – out of the way of those who move back into their lane)
    for (let i = 1; i <= 2; i++) beacon(exitC + side * z.taper * 0.3 * i, z.line + (outerIn - z.line) * (i / 3), false);
    // --- the work: a pit with a fence round it, a mini excavator, gravel, a site trailer – and the people
    const mid = (z.z0 + z.z1) / 2;
    const across = (z.outer + z.line) / 2;
    const band = Math.abs(z.line - z.outer);
    const pitLen = Math.min(9, len * 0.38);
    const pitW = Math.max(0.8, band - 1.3);
    this.put(e, mid, across, q);
    L.pit = { x: q.x, y: q.y, z: q.z, yaw: roadYaw(mid), len: pitLen, wid: pitW };
    const fa = pitLen / 2 + 0.6;
    const fb = Math.min(pitW / 2 + 0.3, band / 2 - 0.12);
    for (const [ds, dof] of [[-fa, -fb], [fa, -fb], [fa, fb], [-fa, fb]] as const) {
      this.put(e, mid + ds, across + dof, q);
      L.fence.push(q.x, q.z);
    }
    L.fenceY = L.pit.y;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      L.segments.push(L.fence[i * 2], L.fence[i * 2 + 1], L.fence[j * 2], L.fence[j * 2 + 1], L.fenceY);
    }
    const toward = side;
    if (len >= 18) {
      const s = mid + toward * (fa + 2.6);
      this.put(e, s, across, q);
      // (facing the pit)
      L.machines.push({ kind: 'excavator', x: q.x, y: q.y, z: q.z, yaw: yawAt(s, toward) });
      L.discs.push(q.x, q.y, q.z, 1.2);
    }
    let heapS = NaN;
    if (len >= 26) {
      heapS = mid - toward * (fa + 2.4);
      this.put(e, heapS, across, q);
      L.machines.push({ kind: 'heap', x: q.x, y: q.y, z: q.z, yaw: roadYaw(heapS) + r(1) * 3 });
      L.discs.push(q.x, q.y, q.z, 1.1);
    }
    if (len >= 42) {
      const s = exitC - side * 3.2;
      this.put(e, s, across, q);
      L.machines.push({ kind: 'trailer', x: q.x, y: q.y, z: q.z, yaw: roadYaw(s) });
      L.discs.push(q.x, q.y, q.z, 1.5);
    }
    // cones at the corners of the fence
    for (let i = 0; i < 4; i++) {
      const x = L.fence[i * 2];
      const zz = L.fence[i * 2 + 1];
      L.cones.push({ x, y: L.fenceY, z: zz });
    }
    // the workers: one at the pit, one between the heap and the pit, one more on a long site
    const look = (k: number): number => (z.seed + k * 977) % 0xfffff;
    this.put(e, mid - toward * (fa + 0.5), across + (r(2) - 0.5) * band * 0.3, q);
    L.workers.push({ x1: q.x, z1: q.z, x2: q.x, z2: q.z, y: q.y, yaw: yawAt(mid, -toward), look: look(1) });
    if (Number.isFinite(heapS)) {
      this.put(e, heapS + toward * 1.3, across + band * 0.2, q);
      this.put(e, mid - toward * (fa + 0.2), across + band * 0.25, q2);
      L.workers.push({ x1: q.x, z1: q.z, x2: q2.x, z2: q2.z, y: q.y, yaw: 0, look: look(2) });
    }
    if (len >= 42 || r(3) < 0.4) {
      const s = len >= 42 ? exitC - side * 6 : mid + toward * (fa + 0.4);
      this.put(e, s, across - band * 0.2, q);
      L.workers.push({ x1: q.x, z1: q.z, x2: q.x, z2: q.z, y: q.y, yaw: yawAt(s, toward), look: look(3) });
    }
    // --- what the traffic stops for: the strip in pieces of 15 m at most
    const nb = Math.max(1, Math.ceil(len / 15));
    for (let i = 0; i < nb; i++) {
      const s = z.z0 + (len * (i + 0.5)) / nb;
      this.put(e, s, across, q);
      L.boxes.push({ x: q.x, y: q.y, z: q.z, yaw: roadYaw(s), speed: 0, length: len / nb + 0.6, width: band });
    }
    z.layout = L;
    return L;
  }

  /** Everything of the closure of a march: barriers where it begins and ends and across the side roads, signs, officers. */
  closureLayout(d: Demonstration): ClosureLayout {
    if (d.layout) return d.layout;
    const L: ClosureLayout = { signs: [], barriers: [], tape: [], officers: [], cars: [], discs: [], segments: [], boxes: [] };
    const route = d.route;
    if (!route) return L;
    const q = { x: 0, y: 0, z: 0 };
    const q2 = { x: 0, y: 0, z: 0 };
    const p = this.smp;
    /** a barrier across road `e` at its end at `node` (`end`: the march's own road at its end – else a side road) */
    const barrier = (e: Edge, atA: boolean, end: boolean): void => {
      const cut = atA ? e.cutA : e.cutB;
      if (e.len < 8) return;
      const s = atA ? Math.min(e.len * 0.5, cut + 3) : Math.max(e.len * 0.5, e.len - cut - 3);
      // the traffic comes from outside the closure: into the march's road from the junction, along a side road towards the junction
      const dir = end === atA ? 1 : -1;
      samplePolyline(e.pl, s, p);
      const yaw = faceYaw(dir, p.tx, p.tz);
      const half = e.width / 2 + 0.15;
      this.put(e, s, -half, q);
      this.put(e, s, half, q2);
      const y = (q.y + q2.y) / 2;
      L.barriers.push({ x1: q.x, z1: q.z, x2: q2.x, z2: q2.z, y, yaw, lamps: Math.max(2, Math.round(e.width / 1.5)) });
      L.segments.push(q.x, q.z, q2.x, q2.z, y);
      // on the pavements, short fences that leave room to walk past
      for (const sgn of [-1, 1]) {
        const sw = sgn > 0 ? e.swL : e.swR;
        if (sw < 1.6) continue;
        this.put(e, s, sgn * (half + 0.1), q);
        this.put(e, s, sgn * (half + sw - 1.3), q2);
        L.segments.push(q.x, q.z, q2.x, q2.z, q.y);
        L.tape.push({ x1: q.x, z1: q.z, x2: q2.x, z2: q2.z, y: q.y });
      }
      // the tape behind it, over the whole street
      const back = s + dir * 0.6;
      this.put(e, back, -half - (e.swR > 0 ? e.swR : 0), q);
      this.put(e, back, half + (e.swL > 0 ? e.swL : 0), q2);
      L.tape.push({ x1: q.x, z1: q.z, x2: q2.x, z2: q2.z, y: (q.y + q2.y) / 2 });
      // the signs: closed (Zeichen 250), a diversion (457.1) – on the right for those who come
      const sw = dir > 0 ? e.swR : e.swL;
      this.put(e, s - dir * 2, -dir * (e.width / 2 + (sw > 0 ? Math.min(0.6, sw * 0.4) : 0.8)), q);
      L.signs.push({ x: q.x, y: q.y, z: q.z, yaw, s: ['250', '457.1'], h: 1.3 });
      L.discs.push(q.x, q.y, q.z, 0.09);
      // an officer (two where the march itself is closed off), and a police car behind
      for (let k = 0; k < (end ? 2 : 1); k++) {
        this.put(e, s + dir * (1.2 + k * 0.8), (k === 0 ? -dir : dir) * (e.width / 2 - 0.7), q);
        L.officers.push({ x: q.x, y: q.y, z: q.z, yaw });
      }
      if (end && e.len > 22) {
        const cs = s + dir * 7;
        this.put(e, cs, -dir * Math.max(0, e.width / 2 - 1.3), q);
        samplePolyline(e.pl, cs, p);
        L.cars.push({ x: q.x, y: q.y, z: q.z, yaw: faceYaw(dir, p.tx, p.tz) });
      }
      // what the traffic stops for
      const bar = L.barriers[L.barriers.length - 1];
      L.boxes.push({ x: (bar.x1 + bar.x2) / 2, y, z: (bar.z1 + bar.z2) / 2, yaw: yaw + Math.PI, speed: 0, length: 1.2, width: e.width + 0.3 });
    };
    const n = route.edges.length;
    // where it begins and where it ends: across its own road
    const first = this.world.edges[route.edges[0]];
    const last = this.world.edges[route.edges[n - 1]];
    if (first) barrier(first, route.dirs[0] > 0, true);
    if (last) barrier(last, route.dirs[n - 1] < 0, true);
    // the side roads of the junctions on its way
    for (let i = 1; i < route.nodes.length - 1; i++) {
      const node = this.world.nodes[route.nodes[i]];
      if (!node || node.stub) continue;
      for (const a of node.arms) {
        if (route.roads.has(a.edge.id) || !a.isApproach) continue;
        barrier(a.edge, a.out, false);
      }
    }
    d.layout = L;
    return L;
  }
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function replace(to: Set<number>, from: Set<number>): void {
  to.clear();
  for (const v of from) to.add(v);
}
