// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The people on foot in the town: they walk along the pavements with
 * somewhere to go – a shop, home, a stop of the trams and buses – cross the
 * streets the way people do, and keep out of the way of the traffic.
 *
 *  - Where: along the pavements of the streets (Edge.swL, swR), round the
 *    corners of the junctions along their kerbs, on the right-hand half of
 *    the pavement, each at a pace of their own – the old more slowly,
 *    children quicker and less steadily, some in a hurry –, now and then two
 *    or three together.  They step aside for each other, for cyclists, posts
 *    and walls.
 *  - Crossing: at a pedestrian light they press the button and wait for the
 *    green, and hurry when it turns red while they are on the road; at a
 *    zebra crossing they wait at the kerb, look left and right and step out
 *    once the vehicles stop; anywhere else – over a side street at a
 *    junction, across to where they are going – only in a gap of the
 *    traffic, after looking.  A car that turns in is let by at the kerb.  A
 *    few do not wait for the green when the road is empty, or cross on a
 *    slant.
 *  - Vehicles: they step back when one comes too close or too fast, and
 *    start at a horn; on the road they hurry, or go back to the kerb.
 *  - Pauses: at a shop window, for a chat, at a stop (where the people of the
 *    stop take them over: render/transit.ts – and whoever gets off there
 *    becomes one of the town's people), and at the end of their way – into
 *    a house.  Fewer of them at night (the game's clock); in the rain (the
 *    game's weather) they hurry, under umbrellas.
 *  - Some have errands just across a street with a zebra crossing or a light
 *    near them: a learner driver meets people at the crossings, as before.
 *
 * The traffic (sim/traffic.ts) sees them as it saw the people at the
 * crossings before: whoever waits at a crossing or walks over it (`state`,
 * `crossing`, `waited`), and whoever is on the carriageway as something in
 * the way.  So the cars stop for them at zebra crossings and when they turn,
 * and the instructor (sim/rules.ts) judges the player by them.
 *
 * Cheap enough for a phone: a person walks along a few straight pieces of
 * way worked out ahead – a few multiplications a frame; what is around them
 * is looked at four times a second, staggered, through a grid of the people.
 */
import { clamp, hash01, newPolySample, projectOnPolyline, rng, samplePolyline, wrapAngle } from '../core/geom.ts';
import type { PolyProjection } from '../core/geom.ts';
import { gameNow } from '../game/clock.ts';
import { weatherNow } from '../game/weather.ts';
import type { Lane } from '../world/lanes.ts';
import type { Stops } from '../world/stops.ts';
import { CLS, CTRL, EF, KERB_H, XING } from '../world/types.ts';
import type { CrossingJson } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { Arm, Edge, Node, World } from '../world/world.ts';
import type { Cyclist } from './cyclists.ts';
import type { SignalSystem } from './signals.ts';
import { berlinClock } from './timetable.ts';
import type { PlayerState, TrafficCar } from './traffic.ts';

/** What the traffic sees of somebody: walking along, waiting at a kerb to cross, on the carriageway – or gone. */
export type WalkerState = 'walk' | 'wait' | 'cross' | 'gone';

/** One of the people on foot, as the traffic, the instructor, the replay and the picture see them. */
export interface Walker {
  id: number;
  /** what they look like: the look number of render/people.ts (a replay records it as the "colour") */
  colour: number;
  x: number;
  y: number;
  z: number;
  /** the way they face (0 = north, + = to the left) */
  yaw: number;
  /** metres walked (the gait follows it) – −1 while they stand */
  phase: number;
  state: WalkerState;
  /** the crossing they wait at or walk over – null: none (also where they cross without one) */
  crossing: CrossingJson | null;
  /** how long they have been waiting at its kerb (s) */
  waited: number;
  /** how fast they walk now (m/s) */
  speed: number;
  /** for the picture: the head turned (rad, + to the left), a start (0 … 1), leaning into the walk (rad), an umbrella up */
  head: number;
  startle: number;
  lean: number;
  umbrella: boolean;
}

/** How old somebody is – as they look (render/people.ts). */
export const AGE = { CHILD: 0, ADULT: 1, OLD: 2 } as const;

/** how many kinds of people render/people.ts knows (its KINDS) */
const LOOK_KINDS = 17;

/**
 * How old somebody looks, from their look number: the kind render/people.ts
 * (lookOf) picks for it – the older people are its fourth and fifth kinds,
 * the children its seventh and twelfth.  (tests/sim/pedestrians.test.ts holds
 * the two together.)
 */
export function ageOfLook(look: number): number {
  const r = hash01(Math.imul(look | 0, 0x2c1b3c6d) ^ Math.imul(1, 0x297a2d39));
  const kind = Math.min(LOOK_KINDS - 1, Math.floor(r * LOOK_KINDS));
  return kind === 3 || kind === 4 ? AGE.OLD : kind === 6 || kind === 11 ? AGE.CHILD : AGE.ADULT;
}

/** A look number of somebody of that age. */
export function lookOfAge(age: number, rand: () => number): number {
  for (let i = 0; i < 80; i++) {
    const look = Math.floor(rand() * 100000);
    if (ageOfLook(look) === age) return look;
  }
  return Math.floor(rand() * 100000);
}

/** How hard it rains for the people (0 … 1), from the weather of src/game/weather.ts (or anything with a kind and an intensity). */
export function rainOf(w: { kind: string; intensity: number } | null | undefined): number {
  if (!w) return 0;
  if (w.kind === 'rain' || w.kind === 'storm') return clamp(0.35 + 0.65 * w.intensity, 0, 1);
  if (w.kind === 'drizzle') return clamp(0.15 + 0.4 * w.intensity, 0, 1);
  if (w.kind === 'snow') return clamp(0.25 + 0.4 * w.intensity, 0, 1);
  return 0;
}

/**
 * How many people there are around the player at most, for the settings:
 * the traffic's density (0 … 1, as the cars) and the graphics preset – a
 * phone on the low preset draws a few dozen, a fast computer up to CROWD_MAX.
 */
export function crowdTarget(traffic: number, quality: string): number {
  const base = quality === 'low' ? 40 : quality === 'medium' ? 80 : quality === 'ultra' ? 160 : 120;
  return Math.round(Math.min(CROWD_MAX, base * clamp(traffic / 0.6, 0, 1.4)));
}

/** How many of the people are out at an hour of the day (0 … 24), as a share of the busiest hours. */
export function outAt(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  const t = h - i;
  return OUT[i] + (OUT[(i + 1) % 24] - OUT[i]) * t;
}
const OUT = [0.12, 0.08, 0.06, 0.05, 0.06, 0.12, 0.3, 0.6, 0.78, 0.82, 0.9, 0.95, 1, 1, 0.95, 0.95, 1, 1, 0.95, 0.82, 0.62, 0.45, 0.3, 0.18];

// ------------------------------------------------------------------------------------------------
/** the narrowest pavement people walk along (m) */
const MIN_PAVEMENT = 0.9;
/** points of the way ahead a person keeps at most */
const MAXP = 24;
/** how often a person looks round (s) */
const THINK = 0.25;
/** where people come up round the player (m): from here … */
const NEAR = 40;
/** … to here; and from where on they are let go */
const FAR = 190;
const GONE = 245;
/** what people expect of a vehicle: that it can stop with this braking (m/s²) after this long to react (s) */
const COMFORT = 3;
const REACT = 0.8;
/** the buckets of the grid of the people (a power of two) */
const CELLS = 512;
/** from this far from the player (m) people take a step every third frame only – too small to see the difference */
const LOD = 90;
/** the most people there are (the picture has room for so many) */
export const CROWD_MAX = 180;

/** what somebody is doing */
const MODE = { WALK: 0, KERB: 1, CROSS: 2, PAUSE: 3, FOLLOW: 4 } as const;
/** what comes when the way ahead has been walked */
const NEXT = { PLAN: 0, JUNCTION: 1, MOVE: 2, KERB: 3, CROSSED: 4, BACK: 5, GOAL: 6, WINDOW: 7, INTO: 8, ENTER: 9, LANDED: 10 } as const;
/** the moves at a junction: round a corner, over the street of an arm, away along an arm */
const CORNER = 1;
const CROSS = 2;
const LEAVE = 3;
/** what rules a crossing for them: a gap in the traffic, a zebra crossing, a light */
const RULE = { GAP: 0, ZEBRA: 1, LIGHT: 2 } as const;
/** where they are going */
const GOAL = { ERRAND: 0, HOME: 1, STOP: 2, STROLL: 3 } as const;
/** why they stand */
const PAUSE = { NONE: 0, WINDOW: 1, CHAT: 2, REST: 3, START: 4, STOP: 5 } as const;

const tmp = newPolySample();
const proj: PolyProjection = { s: 0, off: 0, d2: 0, seg: 0 };
const hit = newSurfaceHit();
/** how far aside somebody tries to step round a post (m), and where ahead they look for one */
const ASIDE = [0.45, -0.45, 0.85, -0.85, 1.2, -1.2];
const PROBE = [0.9, 1.8];

class Person implements Walker {
  id = 0;
  colour = 0;
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  phase = -1;
  state: WalkerState = 'walk';
  crossing: CrossingJson | null = null;
  waited = 0;
  speed = 0;
  head = 0;
  startle = 0;
  lean = 0;
  umbrella = false;

  // ---- who they are
  age: number = AGE.ADULT;
  /** the pace they like (m/s), and the time they want in hand when they cross in a gap (s) */
  v0 = 1.35;
  margin = 1.8;
  /** takes small gaps, crosses on red when the road is empty, on a slant */
  bold = false;
  hurry = false;
  /** how readily they stop for a chat or a shop window (0 … 1) */
  idle = 0.5;
  /** has an umbrella with them */
  brolly = false;
  /** seconds left before they go home */
  life = 400;
  /** a way to drift when they have nowhere in particular to go */
  roamX = 1;
  roamZ = 0;

  // ---- on the pavement of `edge` on `side` (+1 left of a→b), walking `dir` (+1 towards b); the way is planned up to station `s`
  edge: Edge | null = null;
  side = 1;
  dir = 1;
  s = 0;
  /** where across the pavement they walk (0 at the kerb … 1 at the houses) */
  frac = 0.5;
  // ---- the way ahead: points x, y, z; the one walked to next
  readonly path = new Float64Array(MAXP * 3);
  np = 0;
  pi = 0;
  next: number = NEXT.PLAN;
  /** the point on the way (they are drawn `dodge` metres to the right of it), and the way's direction there */
  bx = 0;
  by = 0;
  bz = 0;
  wx = 0;
  wz = -1;
  walked = 0;
  mode: number = MODE.WALK;
  modeT = 0;
  until = 0;
  pause: number = PAUSE.NONE;
  /** the way to face while standing, and where the head is to turn */
  face = 0;
  headTo = 0;
  // ---- at a junction: the moves decided on, the next of them, where they stand (arm, its side looking away from the junction)
  jnode: Node | null = null;
  jarms = 0;
  readonly moves: number[] = [];
  mi = 0;
  mArm = 0;
  mSide = 1;
  // ---- a crossing: the street, the station, the side they start from, what rules it
  xEdge: Edge | null = null;
  xS = 0;
  xS2 = 0;
  /** where they wait for it (the line itself, or – at a junction – the end of the pavement beside its mouth) */
  xW = 0;
  xSide = 1;
  xRule: number = RULE.GAP;
  xSc = -1;
  xG = 0;
  xCross: CrossingJson | null = null;
  xNode: Node | null = null;
  /** after it: on with the moves at the junction (walking back to its mouth first?) – or on along the street, which way */
  xMoves = false;
  xBack = false;
  xAfter = 1;
  /** the line across, from this kerb to the other, and its direction */
  kx = 0;
  kz = 0;
  fx = 0;
  fz = 0;
  ax = 1;
  az = 0;
  /** where they wait, and how far they have stepped back from it */
  sx = 0;
  sy = 0;
  sz = 0;
  kback = 0;
  kcur = 0;
  registered = false;
  pressed = false;
  /** the place to wait has been moved clear of others already waiting there */
  spread = false;
  lookT = 0;
  redRun = false;
  hurryX = 1;
  // ---- where they are going
  goal: number = GOAL.ERRAND;
  gEdge: Edge | null = null;
  gSide = 1;
  gS = 0;
  gx = 0;
  gz = 0;
  goals = 1;
  /** after a pause at a window: into the house */
  enter = false;
  // ---- among the others
  dodge = 0;
  dodgeTo = 0;
  dmin = -0.3;
  dmax = 0.3;
  slow = 1;
  think = 0;
  stuck = 0;
  ghost = 0;
  // ---- together with others: whom they walk with, and where beside them
  leader: Person | null = null;
  lat = 0;
  fwd = 0;
  partner: Person | null = null;
  told = -100;
  /** put there on purpose (add): they stay when nobody else is to come */
  placed = false;
  /** how many walk with them */
  group = 0;
  /** the time not yet stepped (far off, people step every third frame) */
  lag = 0;
}

/** A vehicle as the people see it. */
interface Veh {
  x: number;
  y: number;
  z: number;
  /** its nose (unit), its speed along it (m/s, < 0 backwards), how it speeds up */
  fx: number;
  fz: number;
  v: number;
  a: number;
  len: number;
  wid: number;
  /** the road it turns into at the junction ahead of it or under it (null: none, or not known) */
  into: Edge | null;
}

/** what is in the way of the cars: somebody on the carriageway (the shape of PlayerState) */
type Block = PlayerState;

/** where what happens to the people is noted (the traffic's events) */
export interface WalkerSink {
  push(e: { type: 'pedestrianEndangered'; ped: Walker }): unknown;
}

// ------------------------------------------------------------------------------------------------
/** The pavement of `e` on `side` (+1 left of a→b): its width, 0 where there is none to walk on. */
function pavement(e: Edge, side: number): number {
  if (e.cls <= CLS.MOTORWAY_LINK || (e.flags & EF.TUNNEL) !== 0) return 0;
  const w = side > 0 ? e.swL : e.swR;
  return w >= MIN_PAVEMENT ? w : 0;
}

/** Where a pavement begins and ends along its street (stations): at the junctions' kerbs. */
function startOf(e: Edge): number {
  return Math.min(e.cutA, e.len / 2);
}
function endOf(e: Edge): number {
  return Math.max(e.len - e.cutB, e.len / 2);
}

/** The side of the street (+1 left of a→b) that is the arm's side `sg` (+1 left, looking away from its junction). */
function edgeSide(arm: Arm, sg: number): number {
  return arm.out ? sg : -sg;
}

/** The station where an arm's pavement meets the corner of its junction. */
function mouthS(arm: Arm): number {
  return arm.out ? startOf(arm.edge) : endOf(arm.edge);
}

/** How many people a street draws (0 … 1): the main streets of a town most. */
function busyness(e: Edge): number {
  if ((e.flags & EF.TUNNEL) !== 0 || e.cls <= CLS.MOTORWAY_LINK) return 0;
  let w: number;
  if (e.cls <= CLS.TERTIARY_LINK) w = e.cls % 2 === 1 ? 0.35 : 1;
  else if (e.cls === CLS.UNCLASSIFIED) w = 0.6;
  else if (e.cls === CLS.RESIDENTIAL) w = 0.5;
  else if (e.cls === CLS.LIVING_STREET) w = 0.8;
  else w = 0.2;
  return (e.flags & EF.URBAN) !== 0 ? w : w * 0.3;
}

/** A street of shops: a main street in town. */
function shopping(e: Edge): boolean {
  return (e.flags & EF.URBAN) !== 0 && e.cls >= CLS.PRIMARY && e.cls <= CLS.TERTIARY && e.cls % 2 === 0;
}

/** Options for a person put somewhere on purpose (the tests, people getting off a bus). */
export interface WalkerOptions {
  look?: number;
  /** AGE (default: as the look says) */
  age?: number;
  /** the pace they like (m/s) */
  pace?: number;
  /** the time they want in hand when they cross in a gap (s) */
  margin?: number;
  bold?: boolean;
  hurry?: boolean;
  /** where they are going: a point on a pavement (default: a place of their own) */
  goal?: { edge: Edge; side: number; s: number; kind?: 'errand' | 'home' | 'stop' | 'stroll' };
  /** how readily they stop for a chat or a shop window (0 … 1; the tests set 0) */
  idle?: number;
}

/**
 * The people on foot around the player.  Owned by the traffic, which updates
 * it every step; `target` says how many there are at most (0: none).
 */
export class Crowd {
  /** how many people there are around the player at most – by day, in the dry, in the middle of a town */
  target = 0;
  /** the weather (src/game/weather.ts): in the rain they hurry, under umbrellas – and fewer are out */
  weather: () => { kind: string; intensity: number } | null = weatherNow;
  /** the hour of the day (0 … 24): by default the game's clock (src/game/clock.ts) as the clocks in Kassel show it, like the timetables and the sun */
  clock: () => number = () => berlinClock(gameNow()).s / 3600;
  /** how hard it rains now (0 … 1: rainOf the weather) */
  rain = 0;
  /** the stops of the map: some people go to them */
  stops: Stops | null = null;
  /** is there something standing at (x, z) – a post, a wall – for somebody of radius r on the ground at height y?  (null: nothing is) */
  blocked: ((x: number, y: number, z: number, r: number) => boolean) | null = null;
  /** somebody has come to a stop: the stop's people take them over (true) – or not (false: they wait by the pole themselves) */
  toStop: ((w: Walker) => boolean) | null = null;
  /** others standing about that the people walk round: those waiting at the stops (render/transit.ts) – null: none */
  standing: (() => ReadonlyArray<{ x: number; z: number }>) | null = null;
  private readonly world: World;
  private readonly signals: SignalSystem;
  private readonly all: Person[] = [];
  private readonly rand: () => number;
  private nextId = 1;
  private time = 0;
  private frame = 0;
  private hour = 12;
  private hourAt = -100;
  private spawnT = 0;
  /** how often a place round the player had a pavement to put somebody on (a running share): how much of a town it is */
  private urban = 0.5;
  /** just begun (or cleared): the first people come up anywhere around the player, not only out of sight */
  private fresh = true;
  private freshAt = 0;
  /** the vehicles around, as the people see them (made anew each step) */
  private readonly vehs: Veh[] = [];
  private nVeh = 0;
  private playerVeh: Veh | null = null;
  private pv = 0;
  private pa = 0;
  private hornOn = false;
  private hornAt = -100;
  /** somebody on foot who is the player, and the cyclists: the people step aside for them */
  private player: PlayerState | null = null;
  private cyclists: readonly Cyclist[] = [];
  private obstacles: readonly PlayerState[] = [];
  /** those on the carriageway, and their boxes for the cars */
  private readonly onRoad: Person[] = [];
  private readonly boxes: Block[] = [];
  // ---- a grid of the people (4 m cells, hashed): who is near whom – and of the others standing about
  private readonly cellHead = new Int32Array(CELLS);
  private cellNext = new Int32Array(256);
  private readonly otherHead = new Int32Array(CELLS);
  private otherNext = new Int32Array(64);
  private others: ReadonlyArray<{ x: number; z: number }> = [];

  constructor(world: World, signals: SignalSystem, seed = 31337) {
    this.world = world;
    this.signals = signals;
    this.rand = rng(seed);
  }

  /** Everybody (for the traffic, the picture, the replay). */
  get people(): Walker[] {
    return this.all;
  }

  /** Nobody any more (a new drive, a jump elsewhere). */
  clear(): void {
    this.all.length = 0;
    this.onRoad.length = 0;
    this.fresh = true;
    this.freshAt = this.time;
  }

  /** Roads taken out of the network: whoever is on them (or going there) goes too. */
  removeRoads(gone: ReadonlySet<Edge>): void {
    for (const p of this.all) {
      if ((p.edge && gone.has(p.edge)) || (p.xEdge && gone.has(p.xEdge)) || (p.gEdge && gone.has(p.gEdge))) p.state = 'gone';
    }
    this.sweep();
  }

  /** Those within r metres of (x, z) – e.g. for a replay, which keeps the people near the player (the list is reused: use it at once). */
  near(x: number, z: number, r: number): Walker[] {
    const out = this.nearList;
    out.length = 0;
    for (const p of this.all) if (Math.abs(p.x - x) < r && Math.abs(p.z - z) < r && (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < r * r) out.push(p);
    return out;
  }
  private readonly nearList: Walker[] = [];

  /** What doing somebody is (for the tests): walking, at a kerb, crossing, standing, with others. */
  modeOf(w: Walker): 'walk' | 'kerb' | 'cross' | 'pause' | 'follow' {
    const m = (w as Person).mode;
    return m === MODE.KERB ? 'kerb' : m === MODE.CROSS ? 'cross' : m === MODE.PAUSE ? 'pause' : m === MODE.FOLLOW ? 'follow' : 'walk';
  }

  // ------------------------------------------------------------------------------------ for the cars
  /** Those on the carriageway, as boxes in the way of the cars (added to `out`). */
  addBlocks(out: PlayerState[]): void {
    let n = 0;
    for (const p of this.onRoad) {
      if (p.state !== 'cross') continue;
      const b = (this.boxes[n++] ??= { x: 0, y: 0, z: 0, yaw: 0, speed: 0, length: 0.5, width: 0.5 });
      b.x = p.x;
      b.y = p.y;
      b.z = p.z;
      b.yaw = p.yaw;
      b.speed = p.speed;
      out.push(b);
    }
  }

  /**
   * Is somebody walking over the road `lane` leads along, near where it
   * begins (from a few metres inside its junction to 20 m out) – where a
   * vehicle that turns into it has to let them cross first?
   */
  crossingLane(lane: Lane): boolean {
    for (const p of this.onRoad) {
      if (p.state !== 'cross' || p.xEdge !== lane.edge) continue;
      const pos = (p.xS - lane.s0) * lane.dir;
      if (pos > -4 && pos < 20) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------ people put somewhere
  /** Put somebody on the pavement of `edge` on `side`, `s` metres along it, walking `dir` (+1 towards its end b). */
  add(edge: Edge, side: number, s: number, dir: number, opts: WalkerOptions = {}): Walker {
    const p = this.make(opts.look ?? Math.floor(this.rand() * 100000), opts.age);
    p.placed = true;
    if (opts.pace !== undefined) p.v0 = opts.pace;
    if (opts.margin !== undefined) p.margin = opts.margin;
    if (opts.bold !== undefined) p.bold = opts.bold;
    if (opts.hurry !== undefined) p.hurry = opts.hurry;
    if (opts.idle !== undefined) p.idle = opts.idle;
    this.onPavement(p, edge, side, s, dir);
    const g = opts.goal;
    if (g) this.setGoal(p, g.kind === 'home' ? GOAL.HOME : g.kind === 'stop' ? GOAL.STOP : g.kind === 'stroll' ? GOAL.STROLL : GOAL.ERRAND, g.edge, g.side, g.s);
    else this.newGoal(p);
    this.all.push(p);
    this.planAlong(p);
    return p;
  }

  /**
   * Somebody who has just got off a tram or a bus at (x, y, z): from here on
   * one of the people of the town – if there is a pavement within a few
   * metres.  Returns whether they were taken.
   */
  adopt(x: number, y: number, z: number, look: number): boolean {
    if (this.target <= 0 || this.all.length >= CROWD_MAX) return false;
    const at = this.nearestPavement(x, z, 8);
    if (!at) return false;
    const p = this.make(look);
    p.x = p.bx = x;
    p.y = p.by = y;
    p.z = p.bz = z;
    this.onPavement(p, at.edge, at.side, at.s, this.rand() < 0.5 ? 1 : -1, false);
    this.newGoal(p);
    // first onto the pavement – over a bit of the road, if the door opened onto it
    p.np = 0;
    p.pi = 0;
    const e = at.edge;
    this.put(p, e, p.side, p.s, e.width / 2 + p.frac * pavement(e, p.side), true);
    p.next = NEXT.LANDED;
    p.state = at.road ? 'cross' : 'walk';
    this.all.push(p);
    return true;
  }

  // ------------------------------------------------------------------------------------ the step
  /**
   * One step: people come and go round the player, walk on, cross, wait,
   * look round.  `cars`: the traffic's cars; `cyclists`; `obstacles`: what
   * else stands or moves on the roads (the trams, the player's trailer or
   * parked vehicle) – what happens to the people because of the player is
   * added to `events`.
   */
  update(dt: number, player: PlayerState, cars: readonly TrafficCar[], cyclists: readonly Cyclist[], obstacles: readonly PlayerState[], events: WalkerSink): void {
    if (!(dt > 0)) return;
    this.time += dt;
    if (this.time - this.hourAt > 2) {
      // the hour and the weather (now and then: they change slowly)
      this.hourAt = this.time;
      const h = this.clock();
      this.hour = Number.isFinite(h) ? h : 12;
      this.rain = rainOf(this.weather());
    }
    this.player = player.onFoot ? player : null;
    this.cyclists = cyclists;
    this.obstacles = obstacles;
    this.see(dt, player, cars, obstacles);
    this.spawning(dt, player);
    this.grid();
    // the horn: those near it start (once a press, and again while it is held)
    const horn = player.horn === true && !player.onFoot;
    if (horn && (!this.hornOn || this.time - this.hornAt > 1.5)) {
      this.hornAt = this.time;
      this.honk(player);
    }
    this.hornOn = horn;
    const all = this.all;
    this.frame++;
    for (let i = 0; i < all.length; i++) {
      const p = all[i];
      if (p.state === 'gone') continue;
      // (far off: a look round twice a second, a step every third frame for the time of three)
      const dx = p.x - player.x;
      const dz = p.z - player.z;
      const far = dx * dx + dz * dz > LOD * LOD;
      if (this.time >= p.think) {
        p.think = this.time + THINK * (far ? 2 : 1) * (0.8 + 0.4 * this.rand());
        this.look(p);
      }
      p.lag += dt;
      if (far && (this.frame + (p.leader ?? p).id) % 3 !== 0 && p.lag < 0.2) continue;
      const step = p.lag;
      p.lag = 0;
      if (p.leader) this.follow(p, step);
      else this.step(p, step);
      if (!player.onFoot) this.endanger(p, player, events);
    }
    // gone: into a house, to a stop, far away
    for (const p of all) {
      if (p.state === 'gone') continue;
      if (p.leader && p.leader.state === 'gone') p.state = 'gone';
      else if (!p.leader && !p.placed && Math.abs(p.x - player.x) + Math.abs(p.z - player.z) > GONE && len(p.x - player.x, p.z - player.z) > GONE) p.state = 'gone';
    }
    for (const p of all) if (p.leader && p.leader.state === 'gone') p.state = 'gone';
    this.sweep();
    this.onRoad.length = 0;
    for (const p of all) if (p.state === 'cross') this.onRoad.push(p);
  }

  private sweep(): void {
    const all = this.all;
    let k = 0;
    for (let i = 0; i < all.length; i++) {
      const p = all[i];
      if (p.state === 'gone') {
        if (p.partner) p.partner.partner = null;
        continue;
      }
      all[k++] = p;
    }
    all.length = k;
  }

  // ------------------------------------------------------------------------------------ who comes
  /** How many there are to be now: by the hour, the weather and how much of a town it is round the player. */
  private wanted(): number {
    const t = Math.min(CROWD_MAX, Math.max(0, this.target));
    if (t <= 0) return 0;
    return Math.round(t * outAt(this.hour) * (1 - 0.45 * clamp(this.rain, 0, 1)) * clamp(this.urban * 1.5, 0.12, 1));
  }

  private spawning(dt: number, player: PlayerState): void {
    if (this.target <= 0) {
      // (people switched off: those who came by themselves go)
      this.fresh = true;
      this.freshAt = this.time;
      for (const p of this.all) if (!p.placed && !p.leader?.placed) p.state = 'gone';
      return;
    }
    this.spawnT -= dt;
    if (this.spawnT > 0) return;
    this.spawnT = 0.3;
    const want = this.wanted();
    let n = this.all.length;
    // at the beginning many at once, round the player; then one now and then, further off
    const tries = this.fresh ? 24 : n < want * 0.5 ? 4 : 2;
    for (let k = 0; k < tries && n < want; k++) {
      const made = this.spawn(player, this.fresh);
      if (made > 0) n += made;
    }
    if (this.fresh && (n >= want * 0.8 || this.urban < 0.05)) this.fresh = false;
    if (this.fresh && this.time - this.freshAt > 4) this.fresh = false;
  }

  /** Somebody (or a few together) somewhere round the player: the number of people that came. */
  private spawn(player: PlayerState, anywhere: boolean): number {
    const a = this.rand() * Math.PI * 2;
    const r0 = anywhere ? 6 : NEAR;
    const r = r0 + Math.sqrt(this.rand()) * (FAR - r0);
    const x = player.x + Math.cos(a) * r;
    const z = player.z + Math.sin(a) * r;
    const at = this.samplePavement(x, z, 24);
    this.urban += ((at ? 1 : 0) - this.urban) * 0.04;
    if (!at) return 0;
    const pl = this.pointOn(at.edge, at.side, at.s, at.edge.width / 2 + 0.5 * at.sw);
    const d = len(pl.x - player.x, pl.z - player.z);
    if (d < r0 * 0.8 || d > FAR + 10) return 0;
    // in a group: a couple, a parent with a child, friends
    const night = this.hour < 6 || this.hour >= 22;
    const size = this.rand() < (night ? 0.08 : 0.2) ? (this.rand() < 0.25 ? 3 : 2) : 1;
    const childWith = size > 1 && !night && this.rand() < 0.35;
    const lead = this.make(Math.floor(this.rand() * 100000), childWith ? (this.rand() < 0.85 ? AGE.ADULT : AGE.OLD) : undefined);
    if (size === 1 && lead.age === AGE.CHILD && night) return 0;
    lead.group = size - 1;
    const dir = this.rand() < 0.5 ? 1 : -1;
    this.onPavement(lead, at.edge, at.side, at.s, dir);
    if (!anywhere) {
      // out of a door: from the houses' side of the pavement on to the way
      const out = this.pointOn(at.edge, at.side, at.s, at.edge.width / 2 + at.sw * 0.97);
      lead.x = lead.bx = out.x;
      lead.y = lead.by = out.y;
      lead.z = lead.bz = out.z;
    }
    this.newGoal(lead);
    this.all.push(lead);
    let made = 1;
    for (let k = 1; k < size; k++) {
      const age = childWith && k === 1 ? AGE.CHILD : lead.age === AGE.OLD ? AGE.OLD : AGE.ADULT;
      const f = this.make(lookOfAge(age, this.rand), age);
      f.leader = lead;
      f.mode = MODE.FOLLOW;
      f.lat = k === 1 ? 0.56 : -0.56;
      f.fwd = k === 1 ? -0.1 : -0.25;
      // (right of the nose (−sin yaw, −cos yaw) is (cos yaw, −sin yaw))
      f.x = f.bx = lead.x + f.lat * Math.cos(lead.yaw);
      f.y = f.by = lead.y;
      f.z = f.bz = lead.z - f.lat * Math.sin(lead.yaw);
      f.yaw = lead.yaw;
      lead.v0 = Math.min(lead.v0, f.v0 + 0.05);
      lead.margin = Math.max(lead.margin, f.margin);
      lead.bold = lead.bold && f.age !== AGE.CHILD;
      this.all.push(f);
      made++;
    }
    this.planAlong(lead);
    return made;
  }

  /** A new person with a look (and the age it shows), and the ways of their age. */
  private make(look: number, age?: number): Person {
    const p = new Person();
    p.id = this.nextId++;
    if (age !== undefined && ageOfLook(look) !== age) look = lookOfAge(age, this.rand);
    p.colour = look;
    p.age = ageOfLook(look);
    const r = this.rand();
    if (p.age === AGE.CHILD) {
      p.v0 = 1.35 + 0.35 * r;
      p.margin = 1.2;
      p.bold = this.rand() < 0.1;
      p.idle = 0.3;
      p.brolly = this.rand() < 0.4;
    } else if (p.age === AGE.OLD) {
      p.v0 = 0.8 + 0.3 * r;
      p.margin = 3 + this.rand();
      p.idle = 0.7;
      p.brolly = this.rand() < 0.85;
    } else {
      p.hurry = this.rand() < 0.15;
      p.v0 = p.hurry ? 1.7 + 0.25 * r : 1.2 + 0.35 * r;
      p.margin = 1.6 + this.rand() * 1.2;
      p.bold = this.rand() < 0.06;
      p.idle = p.hurry ? 0.1 : 0.3 + 0.6 * this.rand();
      p.brolly = this.rand() < 0.75;
    }
    if (p.bold) p.margin *= 0.55;
    p.life = 240 + this.rand() * 420;
    const a = this.rand() * Math.PI * 2;
    p.roamX = Math.cos(a);
    p.roamZ = Math.sin(a);
    p.think = this.time + this.rand() * THINK;
    return p;
  }

  /** Put somebody on a pavement, on their way along it (the point of the way drawn there). */
  private onPavement(p: Person, e: Edge, side: number, s: number, dir: number, place = true): void {
    p.edge = e;
    p.side = side;
    p.dir = dir;
    p.s = clamp(s, startOf(e), endOf(e));
    p.frac = this.keepRight(e, side, dir, p);
    if (place) {
      const at = this.pointOn(e, side, p.s, e.width / 2 + p.frac * pavement(e, side));
      p.x = p.bx = at.x;
      p.y = p.by = at.y;
      p.z = p.bz = at.z;
    }
    samplePolyline(e.pl, p.s, tmp);
    p.wx = tmp.tx * dir;
    p.wz = tmp.tz * dir;
    p.yaw = Math.atan2(-p.wx, -p.wz);
  }

  /** Where across the pavement somebody walks: on the right-hand half of it (in the middle of a narrow one – or with others beside them). */
  private keepRight(e: Edge, side: number, dir: number, p?: Person): number {
    const w = pavement(e, side);
    const j = (this.rand() - 0.5) * 0.14;
    if (w < 1.5 || (p && p.group > 0)) return 0.5 + j * 0.5;
    // (walking along a→b, the left pavement has its kerb on the walker's right)
    return 0.5 - 0.2 * side * dir + j;
  }

  // ------------------------------------------------------------------------------------ places
  private readonly at = { x: 0, y: 0, z: 0 };

  /** A point beside the middle of `e` at station s, `lat` metres out on `side`, on the pavement. */
  private pointOn(e: Edge, side: number, s: number, lat: number): { x: number; y: number; z: number } {
    samplePolyline(e.pl, s, tmp);
    const u = side * lat;
    const at = this.at;
    at.x = tmp.x + tmp.tz * u;
    at.z = tmp.z - tmp.tx * u;
    at.y = this.world.edgeY(e, s, at.x, at.z) + KERB_H;
    return at;
  }

  /** The next point of somebody's way: beside the middle of `e` (on the pavement – `kerb` – or on the road). */
  private put(p: Person, e: Edge, side: number, s: number, lat: number, kerb: boolean): void {
    if (p.np >= MAXP) return;
    samplePolyline(e.pl, s, tmp);
    const u = side * lat;
    const x = tmp.x + tmp.tz * u;
    const z = tmp.z - tmp.tx * u;
    const k = p.np * 3;
    p.path[k] = x;
    p.path[k + 1] = this.world.edgeY(e, s, x, z) + (kerb ? KERB_H : 0);
    p.path[k + 2] = z;
    p.np++;
  }

  private putXYZ(p: Person, x: number, y: number, z: number): void {
    if (p.np >= MAXP) return;
    const k = p.np * 3;
    p.path[k] = x;
    p.path[k + 1] = y;
    p.path[k + 2] = z;
    p.np++;
  }

  /** A pavement near (x, z), picked by how many people a street draws: the street, the side, the station. */
  private samplePavement(x: number, z: number, r: number): { edge: Edge; side: number; s: number; sw: number } | null {
    let pick: Edge | null = null;
    let total = 0;
    this.world.edgesInBox(x - r, z - r, x + r, z + r, (e) => {
      const sides = (pavement(e, 1) > 0 ? 1 : 0) + (pavement(e, -1) > 0 ? 1 : 0);
      if (sides === 0 || endOf(e) - startOf(e) < 4) return;
      const w = busyness(e) * (sides === 2 ? 1 : 0.6);
      if (w <= 0) return;
      total += w;
      if (this.rand() * total < w) pick = e;
    });
    const e = pick as Edge | null;
    if (!e) return null;
    // (now and then nobody: a quiet street keeps quiet)
    if (this.rand() > 0.35 + 0.65 * busyness(e)) return null;
    let side = pavement(e, 1) > 0 ? 1 : -1;
    if (pavement(e, -side) > 0 && this.rand() < 0.5) side = -side;
    projectOnPolyline(e.pl, x, z, proj);
    const lo = startOf(e) + 1;
    const hi = endOf(e) - 1;
    const s = clamp(proj.s + (this.rand() - 0.5) * 2 * r, lo, hi);
    return { edge: e, side, s, sw: pavement(e, side) };
  }

  /** The pavement nearest to (x, z) within r metres: the street, the side, the station – and whether (x, z) is on the carriageway. */
  private nearestPavement(x: number, z: number, r: number): { edge: Edge; side: number; s: number; road: boolean } | null {
    let best: Edge | null = null;
    let bd = r;
    let bs = 0;
    let bside = 1;
    let road = false;
    this.world.edgesInBox(x - r, z - r, x + r, z + r, (e) => {
      projectOnPolyline(e.pl, x, z, proj);
      const side = proj.off >= 0 ? 1 : -1;
      const w = pavement(e, side);
      if (w <= 0) return;
      const half = e.width / 2;
      const off = Math.abs(proj.off);
      const d = off < half ? half - off + 0.3 : off > half + w ? off - half - w : 0;
      if (d < bd && proj.s > startOf(e) - 0.5 && proj.s < endOf(e) + 0.5) {
        bd = d;
        best = e;
        bs = proj.s;
        bside = side;
        road = off < half;
      }
    });
    const e = best as Edge | null;
    return e ? { edge: e, side: bside, s: clamp(bs, startOf(e), endOf(e)), road } : null;
  }

  // ------------------------------------------------------------------------------------ where to
  private setGoal(p: Person, kind: number, e: Edge, side: number, s: number): void {
    p.goal = kind;
    p.gEdge = e;
    p.gSide = side;
    p.gS = clamp(s, startOf(e), endOf(e));
    const at = this.pointOn(e, side, p.gS, e.width / 2 + 0.5 * pavement(e, side));
    p.gx = at.x;
    p.gz = at.z;
  }

  /** Somewhere to go: a shop or a house further on, home, a stop. */
  private newGoal(p: Person): void {
    p.goals--;
    const x = p.bx;
    const z = p.bz;
    const r = this.rand();
    // a stop of the trams and buses
    if (r < 0.22 && this.stops && p.life > 60) {
      const places = this.stops.near(x, z, 280);
      let tries = 0;
      for (const place of places) {
        if (++tries > 6) break;
        const pole = place.poles[Math.floor(this.rand() * place.poles.length)];
        if (!pole) continue;
        const d = len(pole.x - x, pole.z - z);
        if (d < 30 || d > 280) continue;
        const at = this.nearestPavement(pole.x, pole.z, 12);
        if (!at) continue;
        this.setGoal(p, GOAL.STOP, at.edge, at.side, at.s);
        return;
      }
    }
    // across a street with a zebra crossing or a light near them: over it there (a learner meets them there)
    if (r < 0.45 && this.crossingGoal(p)) return;
    // somewhere further on: a shop, a house – or on and on (strolling)
    for (let k = 0; k < 3; k++) {
      const a = Math.atan2(p.roamZ, p.roamX) + (this.rand() - 0.5) * 2.4;
      const d = 60 + this.rand() * 200;
      const at = this.samplePavement(x + Math.cos(a) * d, z + Math.sin(a) * d, 30);
      if (!at) continue;
      const kind = this.rand() < 0.25 ? GOAL.STROLL : this.rand() < 0.45 ? GOAL.HOME : GOAL.ERRAND;
      this.setGoal(p, kind, at.edge, at.side, at.s);
      if (kind === GOAL.STROLL) p.goals = 1 + Math.floor(this.rand() * 2);
      return;
    }
    // nowhere found: home, on this street
    if (p.edge) this.setGoal(p, GOAL.HOME, p.edge, p.side, p.s + p.dir * (10 + this.rand() * 40));
  }

  /** A shop or a house just across a street that has a zebra crossing or a light near them – they will use it.  False if there is none. */
  private crossingGoal(p: Person): boolean {
    const x = p.bx;
    const z = p.bz;
    let pick: Edge | null = null;
    let at: CrossingJson | null = null;
    let n = 0;
    this.world.edgesInBox(x - 90, z - 90, x + 90, z + 90, (e) => {
      if (pavement(e, 1) <= 0 || pavement(e, -1) <= 0) return;
      for (const c of e.xings) {
        if (c.k !== XING.ZEBRA && c.k !== XING.SIGNAL) continue;
        n++;
        if (this.rand() * n < 1) {
          pick = e;
          at = c;
        }
      }
    });
    const e = pick as Edge | null;
    const c = at as CrossingJson | null;
    if (!e || !c) return false;
    // (the far side of it, seen from where they are)
    projectOnPolyline(e.pl, x, z, proj);
    const side = proj.off >= 0 ? -1 : 1;
    this.setGoal(p, this.rand() < 0.5 ? GOAL.HOME : GOAL.ERRAND, e, side, c.s + (this.rand() < 0.5 ? -1 : 1) * (4 + this.rand() * 18));
    return true;
  }

  // ------------------------------------------------------------------------------------ the way: along a pavement
  /** On along the pavement, from where the way stands to the next thing on it: the junction, a crossing, the goal, a shop window. */
  private planAlong(p: Person, turned = false): void {
    const e = p.edge;
    if (!e) {
      p.state = 'gone';
      return;
    }
    p.mode = MODE.WALK;
    p.modeT = 0;
    p.state = 'walk';
    p.crossing = null;
    p.waited = 0;
    p.hurryX = 1;
    const lo = startOf(e);
    const hi = endOf(e);
    const s0 = clamp(p.s, lo, hi);
    let stop = p.dir > 0 ? hi : lo;
    let next: number = NEXT.JUNCTION;
    const ahead = (s: number): boolean => (s - s0) * p.dir > 0.4 && (stop - s) * p.dir > -0.01;
    // tired of it: home, a little further on
    if (p.life <= 0 && p.goal !== GOAL.HOME && p.goal !== GOAL.STOP) this.setGoal(p, GOAL.HOME, e, p.side, s0 + p.dir * (6 + this.rand() * 20));
    if (p.gEdge === e) {
      if (p.gSide === p.side) {
        if (ahead(p.gS) || Math.abs(p.gS - s0) <= 0.4) {
          stop = p.gS;
          next = NEXT.GOAL;
        } else if (!turned) {
          // it lies behind: the other way along the pavement
          p.dir = -p.dir;
          p.frac = this.keepRight(e, p.side, p.dir, p);
          this.planAlong(p, true);
          return;
        }
      } else if (pavement(e, -p.side) > 0) {
        // over the street to it: at a crossing near it, else straight over where it is
        const near = this.crossingNear(e, p.gS, 35);
        const c = near && (ahead(near.s) || Math.abs(near.s - s0) < 1) ? near : null;
        // (at the crossing – somewhere along its stripes –, else where the goal is, or right here when it lies behind)
        const xs = c ? clamp(c.s + (this.rand() - 0.5) * Math.max(0, c.w - 1.4), lo, hi) : ahead(p.gS) ? p.gS : clamp(s0 + p.dir * 1.5, lo, hi);
        if ((xs - s0) * p.dir >= -0.01) {
          stop = xs;
          next = NEXT.KERB;
          p.np = 0;
          p.pi = 0;
          this.along(p, e, p.side, s0, xs, e.width / 2 + p.frac * pavement(e, p.side));
          this.wait(p, e, p.side, xs, xs, c, null, null, false, p.gS >= xs ? 1 : -1);
          p.s = xs;
          p.next = next;
          this.bounds(p);
          return;
        }
      }
    }
    // a shop window on the way
    const wet = this.rain > 0.2;
    if (next === NEXT.JUNCTION && shopping(e) && !p.hurry && !wet && this.hour > 8 && this.hour < 20 && this.rand() < 0.3 * p.idle) {
      const ws = s0 + p.dir * (6 + this.rand() * 40);
      if (ahead(ws)) {
        stop = ws;
        next = NEXT.WINDOW;
      }
    }
    p.np = 0;
    p.pi = 0;
    const reached = this.along(p, e, p.side, s0, stop, e.width / 2 + p.frac * pavement(e, p.side));
    if (reached !== stop) next = NEXT.PLAN;
    p.s = reached;
    p.next = next;
    this.bounds(p);
  }

  /** How far they may step aside on the pavement they walk along (the kerb and the houses keep their distance). */
  private bounds(p: Person): void {
    const e = p.edge;
    if (!e) return;
    const w = pavement(e, p.side);
    // (stepping to the right moves them outwards where the kerb is on their left)
    const out = p.side * p.dir > 0 ? -1 : 1;
    const a = (0.28 - p.frac * w) * out;
    const b = (w - 0.28 - p.frac * w) * out;
    p.dmin = Math.min(a, b, 0);
    p.dmax = Math.max(a, b, 0);
  }

  /** The points along a pavement from station s0 to s1, `lat` metres from the middle of the street; the station reached (the way may be cut short). */
  private along(p: Person, e: Edge, side: number, s0: number, s1: number, lat: number): number {
    const cum = e.pl.cum;
    const n = cum.length;
    const dir = s1 >= s0 ? 1 : -1;
    // the bends between, then the end
    let k = 0;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < s0) lo = mid + 1;
      else hi = mid;
    }
    k = lo;
    if (dir < 0) k = Math.min(n - 1, k) - (cum[Math.min(n - 1, k)] >= s0 ? 1 : 0);
    for (; k >= 0 && k < n; k += dir) {
      const s = cum[k];
      if ((s - s0) * dir <= 0.3) continue;
      if ((s1 - s) * dir <= 0.3) break;
      if (p.np >= MAXP - 1) {
        // (more bends than room: on from here later)
        return s;
      }
      this.put(p, e, side, s, lat, true);
    }
    this.put(p, e, side, s1, lat, true);
    return s1;
  }

  /** A crossing of the map on `e` within `range` metres of station s (zebra, light, lowered kerb) – null if there is none. */
  private crossingNear(e: Edge, s: number, range: number): CrossingJson | null {
    let best: CrossingJson | null = null;
    let bd = range;
    for (const c of e.xings) {
      if (c.k !== XING.ZEBRA && c.k !== XING.SIGNAL && c.k !== XING.UNMARKED) continue;
      const d = Math.abs(c.s - s);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------------------------ the way: at a junction
  /** At the end of the pavement, at a junction: which way now – round the corner, over a street, back. */
  private decide(p: Person): void {
    const e = p.edge as Edge;
    const N = p.dir > 0 ? e.b : e.a;
    const A = p.dir > 0 ? e.armB : e.armA;
    const n = N.arms.length;
    if (N.stub || !A || N.arms[A.idx] !== A) {
      this.turnRound(p);
      return;
    }
    const i = A.idx;
    const sg = edgeSide(A, p.side);
    const arms = N.arms;
    // where they want to go, seen from the junction
    let gx = p.roamX;
    let gz = p.roamZ;
    if (p.gEdge) {
      const dx = p.gx - N.x;
      const dz = p.gz - N.z;
      const d = len(dx, dz);
      if (d > 2) {
        gx = dx / d;
        gz = dz / d;
      }
    }
    const cost = p.bold ? 0.15 : p.age === AGE.OLD ? 0.5 : 0.3;
    const ok = (k: number, s: number): boolean => pavement(arms[k].edge, edgeSide(arms[k], s)) > 0;
    const score = (k: number, s: number, crossings: number, back: boolean): number => {
      const L = arms[k];
      let v = L.dx * gx + L.dz * gz;
      if (p.gEdge === L.edge) v += edgeSide(L, s) === p.gSide ? 1.6 : 0.7;
      v -= crossings * cost;
      if (back && n > 1) v -= 1.4;
      return v + (this.rand() - 0.5) * 0.45;
    };
    // (round a corner from (k, s): the arm and side one comes to)
    const cornerK = (k: number, s: number): number => (s > 0 ? (k + 1) % n : (k - 1 + n) % n);
    let best: number[] = [LEAVE, i, sg];
    let bestV = score(i, sg, 0, true);
    const offer = (v: number, moves: number[]): void => {
      if (v > bestV) {
        bestV = v;
        best = moves;
      }
    };
    if (ok(i, -sg)) offer(score(i, -sg, 1, true), [CROSS, i, sg, LEAVE, i, -sg]);
    if (n >= 2) {
      const j = cornerK(i, sg);
      const sj = -sg;
      if (j !== i && ok(j, sj)) {
        offer(score(j, sj, 0, false), [CORNER, i, sg, LEAVE, j, sj]);
        if (ok(j, -sj)) {
          offer(score(j, -sj, 1, false), [CORNER, i, sg, CROSS, j, sj, LEAVE, j, -sj]);
          const k2 = cornerK(j, -sj);
          if (k2 !== i && k2 !== j && ok(k2, sj)) offer(score(k2, sj, 1, false), [CORNER, i, sg, CROSS, j, sj, CORNER, j, -sj, LEAVE, k2, sj]);
        }
      }
      if (ok(i, -sg)) {
        const k3 = cornerK(i, -sg);
        if (k3 !== i && ok(k3, sg)) offer(score(k3, sg, 1, false), [CROSS, i, sg, CORNER, i, -sg, LEAVE, k3, sg]);
      }
    }
    p.jnode = N;
    p.jarms = n;
    p.moves.length = 0;
    for (const m of best) p.moves.push(m);
    p.mi = 0;
    p.mArm = i;
    p.mSide = sg;
    p.s = mouthS(A);
    this.nextMove(p);
  }

  /** The next of the moves decided on at the junction. */
  private nextMove(p: Person): void {
    const N = p.jnode;
    if (!N || N.arms.length !== p.jarms || p.mi + 2 >= p.moves.length) {
      // (the junction changed under them – a piece of the map came: on from where they are)
      this.turnRound(p);
      return;
    }
    const code = p.moves[p.mi];
    const k = p.moves[p.mi + 1];
    const sg = p.moves[p.mi + 2];
    p.mi += 3;
    const arm = N.arms[k];
    if (code === CORNER) this.corner(p, N, k, sg);
    else if (code === CROSS) this.crossArm(p, N, arm, sg);
    else {
      p.edge = arm.edge;
      p.side = edgeSide(arm, sg);
      p.dir = arm.out ? 1 : -1;
      p.frac = this.keepRight(arm.edge, p.side, p.dir, p);
      p.jnode = null;
      p.moves.length = 0;
      p.mi = 0;
      this.planAlong(p);
    }
  }

  /** Round the corner of the junction from the mouth of arm k (its side sg) to the next arm's: along the kerb, on the pavement behind it. */
  private corner(p: Person, N: Node, k: number, sg: number): void {
    const n = N.arms.length;
    const ci = sg > 0 ? k : (k - 1 + n) % n;
    const j = sg > 0 ? (k + 1) % n : (k - 1 + n) % n;
    const to = N.arms[j];
    const sj = -sg;
    p.np = 0;
    p.pi = 0;
    // on to the pavement line of the next arm, where its pavement begins
    const side = edgeSide(to, sj);
    const dir = to.out ? 1 : -1;
    const frac = this.keepRight(to.edge, side, dir, p);
    const s = mouthS(to);
    const lat = to.edge.width / 2 + frac * pavement(to.edge, side);
    const c = N.shape?.corners[ci];
    if (c && c.kerb.length >= 4) {
      // along the kerb of the corner, on the pavement behind it: the kerb runs from arm ci's left mouth to
      // the next arm's right mouth, the pavement lies to the right of it – only the points on the way from
      // here to the next arm's pavement (at a bend the straight kerb's ends may lie behind or beyond)
      samplePolyline(to.edge.pl, s, tmp);
      const ex = tmp.x + tmp.tz * side * lat;
      const ez = tmp.z - tmp.tx * side * lat;
      const dl = len(ex - p.bx, ez - p.bz);
      const ux = dl > 1e-6 ? (ex - p.bx) / dl : 0;
      const uz = dl > 1e-6 ? (ez - p.bz) / dl : 0;
      const K = c.kerb;
      const m = K.length / 2;
      const forward = sg > 0;
      const stepK = Math.max(1, Math.ceil(m / (MAXP - 2)));
      let done = 0.3;
      if (m === 2) {
        // (a straight kerb between the mouths – a bend: round the outside of its two roads, where the lines
        // of their pavements meet – unless they run on in one line, the side of a junction without a corner)
        const arm = N.arms[k];
        // here + u·t1 = there + v·t2, both lines running in towards the junction
        const ux = -arm.dx;
        const uz = -arm.dz;
        const vx = -to.dx;
        const vz = -to.dz;
        const det = vx * uz - ux * vz;
        if (Math.abs(det) > 0.25) {
          const qx = ex - p.bx;
          const qz = ez - p.bz;
          const t1 = (vx * qz - qx * vz) / det;
          const t2 = (ux * qz - uz * qx) / det;
          if (t1 > -0.3 && t2 > -0.3 && t1 < 25 && t2 < 25) {
            const x = p.bx + ux * t1;
            const z = p.bz + uz * t1;
            this.putXYZ(p, x, this.world.planeY(N, x, z) + KERB_H, z);
            done = dl;
          }
        }
      }
      for (let t = 0; t < m; t += stepK) {
        const idx = forward ? t : m - 1 - t;
        const i0 = Math.max(0, idx - 1);
        const i1 = Math.min(m - 1, idx + 1);
        const tx = K[i1 * 2] - K[i0 * 2];
        const tz = K[i1 * 2 + 1] - K[i0 * 2 + 1];
        const tl = len(tx, tz) || 1;
        const w = c.swA + (c.swB - c.swA) * (idx / Math.max(1, m - 1));
        const off = Math.max(0.4, w * 0.5);
        const x = K[idx * 2] + (-tz / tl) * off;
        const z = K[idx * 2 + 1] + (tx / tl) * off;
        const along = (x - p.bx) * ux + (z - p.bz) * uz;
        if (along <= done || along >= dl - 0.3) continue;
        done = along;
        this.putXYZ(p, x, this.world.planeY(N, x, z) + KERB_H, z);
      }
    }
    this.put(p, to.edge, side, s, lat, true);
    p.frac = frac;
    p.mArm = j;
    p.mSide = sj;
    p.s = s;
    p.next = NEXT.MOVE;
    p.mode = MODE.WALK;
    p.dmin = -0.3;
    p.dmax = 0.3;
  }

  /** Over the street of an arm of the junction, from its side sg: at a crossing of the map near the junction, else at its mouth. */
  private crossArm(p: Person, N: Node, arm: Arm, sg: number): void {
    const e = arm.edge;
    const side = edgeSide(arm, sg);
    const half = e.width / 2;
    let c: CrossingJson | null = null;
    let cd = 25;
    for (const x of e.xings) {
      if (x.k !== XING.ZEBRA && x.k !== XING.SIGNAL && x.k !== XING.UNMARKED) continue;
      const d = arm.out ? x.s : e.len - x.s;
      if (d > -1 && d < cd) {
        cd = d;
        c = x;
      }
    }
    // the move after it: away along this same street on the other side – then there is no walking back to the mouth
    const after = p.mi + 2 < p.moves.length && p.moves[p.mi] === LEAVE && N.arms[p.moves[p.mi + 1]] === arm;
    p.np = 0;
    p.pi = 0;
    let xs: number;
    let ws: number;
    if (c) {
      xs = ws = clamp(c.s + (this.rand() - 0.5) * Math.max(0, c.w - 1.4), startOf(e), endOf(e));
      this.along(p, e, side, p.s, xs, half + p.frac * pavement(e, side));
    } else if (N.arms.length >= 3) {
      // at a junction: over just inside its mouth – clear of a car that waits at its line, and of one that
      // turns in and stops for them – waiting where the pavement ends
      ws = mouthS(arm);
      const d = Math.max(arm.cut - 0.6, Math.min(arm.cut, 0.5));
      xs = arm.out ? d : e.len - d;
    } else {
      // at a bend or the end of a road: a little way along it
      const d = Math.min(arm.cut + 1, e.len / 2);
      xs = ws = arm.out ? d : e.len - d;
      this.along(p, e, side, p.s, ws, half + p.frac * pavement(e, side));
    }
    this.wait(p, e, side, xs, ws, c, N, arm, true, arm.out ? 1 : -1);
    p.xBack = !after;
    p.mArm = arm.idx;
    p.mSide = sg;
    p.next = NEXT.KERB;
    p.mode = MODE.WALK;
    p.dmin = -0.3;
    p.dmax = 0.3;
  }

  /**
   * Make ready to cross `e` at station xs from `side`: the place at the kerb
   * to wait at (the last point of the way), the line across, what rules it.
   * `after`: which way along the street they go on afterwards (not at a junction).
   */
  private wait(p: Person, e: Edge, side: number, xs: number, ws: number, c: CrossingJson | null, node: Node | null, arm: Arm | null, moves: boolean, after: number): void {
    const half = e.width / 2;
    p.xEdge = e;
    p.xS = xs;
    p.xS2 = xs;
    p.xW = ws;
    p.xSide = side;
    p.xCross = c;
    p.xNode = node;
    p.xMoves = moves;
    p.spread = false;
    p.xAfter = after;
    p.xSc = -1;
    p.xG = 0;
    if (c && c.k === XING.ZEBRA) p.xRule = RULE.ZEBRA;
    else if (c && c.k === XING.SIGNAL && c.sc !== undefined && !this.signals.isDark(c.sc)) {
      p.xRule = RULE.LIGHT;
      p.xSc = c.sc;
      p.xG = c.g ?? 0;
    } else if (!c && node && arm && node.ctrl === CTRL.SIGNALS && !node.dark && node.sc >= 0 && arm.sg >= 0 && !this.signals.isDark(node.sc)) {
      // a junction with lights and no crossing on the map: they go with the traffic beside them (while this arm has red)
      p.xRule = RULE.LIGHT;
      p.xSc = node.sc;
      p.xG = arm.sg;
    } else p.xRule = RULE.GAP;
    // the line across, kerb to kerb
    samplePolyline(e.pl, xs, tmp);
    p.kx = tmp.x + tmp.tz * side * half;
    p.kz = tmp.z - tmp.tx * side * half;
    p.fx = tmp.x - tmp.tz * side * half;
    p.fz = tmp.z + tmp.tx * side * half;
    const l = len(p.fx - p.kx, p.fz - p.kz) || 1;
    p.ax = (p.fx - p.kx) / l;
    p.az = (p.fz - p.kz) / l;
    // the place to wait, a little back from the kerb (beside the others there)
    this.put(p, e, side, ws, half + 0.3 + this.rand() * 0.35, true);
  }

  /** Back the way they came (a dead end, the end of the loaded map, a junction that changed). */
  private turnRound(p: Person): void {
    const e = p.edge;
    p.jnode = null;
    p.moves.length = 0;
    p.mi = 0;
    if (!e) {
      p.state = 'gone';
      return;
    }
    p.dir = -p.dir;
    p.frac = this.keepRight(e, p.side, p.dir, p);
    this.planAlong(p, true);
  }

  // ------------------------------------------------------------------------------------ the way walked
  /** The end of the way ahead: what comes next. */
  private arrive(p: Person): void {
    const next = p.next;
    p.next = NEXT.PLAN;
    switch (next) {
      case NEXT.JUNCTION:
        this.decide(p);
        break;
      case NEXT.MOVE:
        this.nextMove(p);
        break;
      case NEXT.KERB:
        this.atKerb(p);
        break;
      case NEXT.CROSSED:
        this.crossed(p);
        break;
      case NEXT.BACK:
        this.atKerb(p, true);
        break;
      case NEXT.GOAL:
        this.atGoal(p);
        break;
      case NEXT.WINDOW:
        this.atWindow(p);
        break;
      case NEXT.INTO: {
        // through the door: to the houses' side and in
        const e = p.edge as Edge;
        p.np = 0;
        p.pi = 0;
        this.put(p, e, p.side, p.s, e.width / 2 + pavement(e, p.side) + 0.6, true);
        p.next = NEXT.ENTER;
        p.mode = MODE.WALK;
        p.dmin = p.dmax = 0;
        break;
      }
      case NEXT.ENTER:
        p.state = 'gone';
        break;
      case NEXT.LANDED:
        p.state = 'walk';
        this.planAlong(p);
        break;
      default:
        this.planAlong(p);
    }
  }

  private atGoal(p: Person): void {
    const e = p.edge as Edge;
    if (p.goal === GOAL.STOP) {
      // at the stop: its people take them over – or they wait by it themselves
      if (this.toStop?.(p)) {
        p.state = 'gone';
        for (const q of this.all) {
          if (q.leader !== p) continue;
          this.toStop(q);
          q.state = 'gone';
        }
        return;
      }
      p.goal = GOAL.ERRAND;
      p.gEdge = null;
      this.stand(p, PAUSE.STOP, 30 + this.rand() * 90, this.faceRoad(p));
      p.next = NEXT.PLAN;
      this.newGoal(p);
      return;
    }
    if (p.goal === GOAL.STROLL && p.goals > 0 && p.life > 0) {
      this.newGoal(p);
      this.planAlong(p);
      return;
    }
    // a shop or a house: to its door – a look into the window first, perhaps
    p.np = 0;
    p.pi = 0;
    this.put(p, e, p.side, p.s, e.width / 2 + Math.max(0.5, pavement(e, p.side) - 0.35), true);
    p.enter = p.goal === GOAL.HOME || this.rand() < 0.6 || p.life <= 0;
    p.next = p.goal === GOAL.HOME ? NEXT.INTO : NEXT.WINDOW;
    p.dmin = p.dmax = 0;
  }

  /** At a shop window (on the way, or where they were going): a look, then on – or in. */
  private atWindow(p: Person): void {
    const e = p.edge as Edge;
    const w = pavement(e, p.side);
    const at = this.pointOn(e, p.side, p.s, e.width / 2 + Math.max(0.5, w - 0.35));
    if (len(at.x - p.bx, at.z - p.bz) > 0.6) {
      p.np = 0;
      p.pi = 0;
      this.putXYZ(p, at.x, at.y, at.z);
      p.next = NEXT.WINDOW;
      p.dmin = p.dmax = 0;
      return;
    }
    const enter = p.enter;
    p.enter = false;
    this.stand(p, PAUSE.WINDOW, 3 + this.rand() * 9 * (0.5 + p.idle), this.faceRoad(p) + Math.PI);
    if (enter) p.next = NEXT.INTO;
    else {
      if (p.gEdge === e && p.gSide === p.side && Math.abs(p.gS - p.s) < 1) this.newGoal(p);
      p.next = NEXT.PLAN;
    }
  }

  /** The way from the pavement out over the road (yaw). */
  private faceRoad(p: Person): number {
    const e = p.edge as Edge;
    samplePolyline(e.pl, p.s, tmp);
    // (towards the middle of the street: against the side's outward direction)
    const ox = -tmp.tz * p.side;
    const oz = tmp.tx * p.side;
    return Math.atan2(-ox, -oz);
  }

  /** Stand still for a while, facing that way. */
  private stand(p: Person, why: number, seconds: number, face: number): void {
    p.mode = MODE.PAUSE;
    p.modeT = 0;
    p.pause = why;
    p.until = this.time + seconds;
    p.face = face;
    p.np = 0;
    p.pi = 0;
    p.speed = 0;
  }

  // ------------------------------------------------------------------------------------ crossing
  private atKerb(p: Person, back = false): void {
    p.mode = MODE.KERB;
    p.modeT = back ? 1 : 0;
    p.lookT = 0;
    p.speed = 0;
    p.kback = 0;
    p.kcur = 0;
    p.hurryX = 1;
    p.sx = p.bx;
    p.sy = p.by;
    p.sz = p.bz;
    p.face = Math.atan2(-p.ax, -p.az);
    p.wx = p.ax;
    p.wz = p.az;
    p.dodge = p.dodgeTo = 0;
    p.slow = 1;
    if (!back) {
      p.registered = false;
      p.pressed = false;
      p.redRun = p.bold && this.rand() < 0.45;
      p.state = 'walk';
      p.crossing = null;
      p.waited = 0;
    }
    // at a light or in a gap they are someone waiting to cross from the start; at a zebra crossing once it is fair to the vehicles
    if (back || p.xRule !== RULE.ZEBRA) this.register(p);
  }

  private register(p: Person): void {
    p.registered = true;
    p.crossing = p.xCross;
    p.state = 'wait';
  }

  /** Off the kerb and over. */
  private go(p: Person): void {
    const e = p.xEdge as Edge;
    const half = e.width / 2;
    let s2 = p.xS;
    // (a few cross on a slant towards where they are going, where there is no crossing)
    if (p.bold && p.xRule === RULE.GAP && !p.xCross && !p.xMoves) s2 = clamp(p.xS + p.xAfter * (2 + this.rand() * 5), startOf(e), endOf(e));
    p.xS2 = s2 === p.xS ? p.xW : s2;
    // from where they stand (stepped back perhaps)
    p.bx = p.x;
    p.bz = p.z;
    p.np = 0;
    p.pi = 0;
    this.put(p, e, p.xSide, p.xS, half + 0.05, true);
    this.put(p, e, p.xSide, p.xS, half - 0.25, false);
    this.put(p, e, -p.xSide, s2, half - 0.25, false);
    this.put(p, e, -p.xSide, s2, half + 0.05, true);
    this.put(p, e, -p.xSide, p.xS2, half + 0.5, true);
    p.mode = MODE.CROSS;
    p.modeT = 0;
    p.slow = 1;
    p.state = 'cross';
    p.crossing = p.xCross;
    p.registered = true;
    p.next = NEXT.CROSSED;
    p.dmin = -0.35;
    p.dmax = 0.35;
    p.dodgeTo = 0;
  }

  /** Over: on the other pavement. */
  private crossed(p: Person): void {
    p.crossing = null;
    p.state = 'walk';
    p.waited = 0;
    p.registered = false;
    p.hurryX = 1;
    p.lookT = 0;
    const e = p.xEdge as Edge;
    if (p.xMoves && p.jnode) {
      p.mSide = -p.mSide;
      const arm = p.jnode.arms[p.mArm];
      if (p.xBack && arm && arm.edge === e) {
        // back along the other pavement to the corner of the junction
        const side = -p.xSide;
        const dir = arm.out ? -1 : 1;
        p.frac = this.keepRight(e, side, dir, p);
        p.np = 0;
        p.pi = 0;
        const s = mouthS(arm);
        this.along(p, e, side, p.xS2, s, e.width / 2 + p.frac * pavement(e, side));
        p.s = s;
        p.next = NEXT.MOVE;
        p.mode = MODE.WALK;
        p.dmin = -0.3;
        p.dmax = 0.3;
      } else {
        p.s = p.xS2;
        this.nextMove(p);
      }
      return;
    }
    p.edge = e;
    p.side = -p.xSide;
    p.s = p.xS2;
    p.dir = p.xAfter;
    p.frac = this.keepRight(e, p.side, p.dir, p);
    this.planAlong(p);
  }

  // ------------------------------------------------------------------------------------ a step
  /** How fast they want to go now (m/s). */
  private pace(p: Person): number {
    let v = p.v0 * (1 + 0.25 * this.rain);
    if (this.hour < 6 || this.hour >= 22) v *= 1.06;
    if (p.mode === MODE.CROSS) v *= 1.12 * p.hurryX;
    // children: now a few quick steps, now slower
    if (p.age === AGE.CHILD) v *= 1 + 0.35 * Math.max(0, Math.sin(this.time * 0.9 + p.id * 1.7));
    return Math.min(2.6, v) * p.slow;
  }

  private step(p: Person, dt: number): void {
    p.modeT += dt;
    p.life -= dt;
    p.startle = Math.max(0, p.startle - dt * 1.4);
    p.head += (p.headTo - p.head) * Math.min(1, dt * 7);
    p.umbrella = p.brolly && this.rain > 0.12;
    switch (p.mode) {
      case MODE.KERB:
        this.atKerbStep(p, dt);
        break;
      case MODE.PAUSE:
        p.phase = -1;
        p.lean = 0;
        p.speed = 0;
        this.turnTo(p, p.face, dt, 4);
        if (p.pause === PAUSE.WINDOW) p.headTo = 0.35 * Math.sin(p.modeT * 0.6 + p.id);
        else if (p.pause === PAUSE.CHAT) p.headTo = 0.12 * Math.sin(p.modeT * 0.8 + p.id);
        else if (p.pause !== PAUSE.START) p.headTo = 0.5 * Math.sin(p.modeT * 0.23 + p.id) * Math.sin(p.modeT * 0.07 + p.id * 3);
        if (this.time >= p.until) {
          p.mode = MODE.WALK;
          if (p.partner) {
            p.partner.partner = null;
            p.partner = null;
          }
          if (p.pi >= p.np) this.arrive(p);
        }
        break;
      default:
        this.walk(p, dt);
    }
  }

  /** Coming up to the place to wait at the kerb: somebody already stands just there – beside them, along the kerb (not out on the road). */
  private spread(p: Person): void {
    p.spread = true;
    const k = (p.np - 1) * 3;
    const y = p.path[k + 1];
    let x = p.path[k];
    let z = p.path[k + 2];
    for (let pass = 0; pass < 2; pass++) {
      for (const q of this.all) {
        if (q === p || q.mode !== MODE.KERB) continue;
        const dx = x - q.sx;
        const dz = z - q.sz;
        const d = len(dx, dz);
        if (d >= 0.6) continue;
        // (along the kerb is across the way over: (−az, ax)) – beside them that way, or the other, where it is pavement still
        const along = dx * -p.az + dz * p.ax;
        const sgn = along >= 0 ? 1 : -1;
        for (const s of [sgn * 0.62 - along, -sgn * 0.62 - along]) {
          const nx = x - p.az * s;
          const nz = z + p.ax * s;
          if (this.world.surfaceAt(nx, nz, y + 1, hit) && hit.zone === 0) continue;
          x = nx;
          z = nz;
          break;
        }
      }
    }
    p.path[k] = x;
    p.path[k + 2] = z;
  }

  private walk(p: Person, dt: number): void {
    if (p.next === NEXT.KERB && !p.spread && p.pi === p.np - 1) {
      const k = p.pi * 3;
      if (Math.abs(p.path[k] - p.bx) + Math.abs(p.path[k + 2] - p.bz) < 4) this.spread(p);
    }
    const want = this.pace(p);
    p.speed += clamp(want - p.speed, -3 * dt, 1.5 * dt);
    if (p.speed < 0) p.speed = 0;
    let step = p.speed * dt;
    let moved = 0;
    while (step > 1e-6 && p.pi < p.np) {
      const k = p.pi * 3;
      const tx = p.path[k];
      const ty = p.path[k + 1];
      const tz = p.path[k + 2];
      const dx = tx - p.bx;
      const dz = tz - p.bz;
      const d = len(dx, dz);
      if (d > 1e-4) {
        p.wx = dx / d;
        p.wz = dz / d;
      }
      if (d <= step) {
        p.bx = tx;
        p.by = ty;
        p.bz = tz;
        step -= d;
        moved += d;
        p.pi++;
      } else {
        const f = step / d;
        p.bx += dx * f;
        p.by += (ty - p.by) * f;
        p.bz += dz * f;
        moved += step;
        step = 0;
      }
    }
    // (stepping aside: towards where they want to be – within what the way allows, quickly back inside it when the way changed)
    const to = clamp(p.dodgeTo, p.dmin, p.dmax);
    const rate = p.dodge < p.dmin - 0.02 || p.dodge > p.dmax + 0.02 ? 2.5 : 0.9;
    p.dodge += clamp(to - p.dodge, -rate * dt, rate * dt);
    p.x = p.bx - p.wz * p.dodge;
    p.y = p.by;
    p.z = p.bz + p.wx * p.dodge;
    if (moved > 1e-5) {
      p.walked += moved;
      p.phase = p.walked;
      this.turnTo(p, Math.atan2(-p.wx, -p.wz), dt, 5);
    } else p.phase = -1;
    p.lean = p.phase >= 0 ? (p.hurry || p.hurryX > 1.2 ? 0.07 : 0) + 0.05 * this.rain : 0;
    // the head: looking out for the traffic on the road – the near half from the left, the far half from the right
    if (p.mode === MODE.CROSS) {
      const e = p.xEdge;
      const across = e ? (p.x - p.kx) * p.ax + (p.z - p.kz) * p.az : 0;
      p.headTo = e && across < e.width / 2 ? 0.45 : -0.45;
    } else p.headTo = p.next === NEXT.KERB && p.np - p.pi <= 1 ? 0.5 : 0;
    if (p.pi >= p.np) this.arrive(p);
  }

  private atKerbStep(p: Person, dt: number): void {
    p.lookT += dt;
    if (p.registered) p.waited += dt;
    // stepping back from the kerb (and forward again)
    const to = p.kback;
    const dk = clamp(to - p.kcur, -1.2 * dt, 1.6 * dt);
    p.kcur += dk;
    p.x = p.sx - p.ax * p.kcur;
    p.y = p.sy;
    p.z = p.sz - p.az * p.kcur;
    if (Math.abs(dk) > 1e-5) {
      p.walked += Math.abs(dk);
      p.phase = p.walked;
    } else p.phase = -1;
    if (p.kback > 0 && p.modeT > 1.5 && p.startle < 0.1) p.kback = 0;
    p.lean = 0;
    p.speed = 0;
    this.turnTo(p, p.face, dt, 5);
    // the head: at a light towards the light (with a glance at the traffic); elsewhere left, right, left – then now and then
    const t = p.lookT;
    if (p.xRule === RULE.LIGHT) p.headTo = t < 0.6 ? 0.6 : 0.12 * Math.sin(t * 0.7 + p.id) + (Math.sin(t * 0.31 + p.id) > 0.85 ? 0.6 : 0);
    else p.headTo = t < 0.7 ? 0.85 : t < 1.5 ? -0.85 : t < 2.1 ? 0.75 : 0.55 * Math.sin((t - 2.1) * 1.1 + p.id);
  }

  private turnTo(p: Person, yaw: number, dt: number, rate: number): void {
    p.yaw += clamp(wrapAngle(yaw - p.yaw), -rate * dt, rate * dt);
  }

  /** Walking with somebody: beside them (behind on a narrow pavement), at their pace. */
  private follow(f: Person, dt: number): void {
    const L = f.leader as Person;
    f.modeT += dt;
    f.startle = Math.max(0, f.startle - dt * 1.4);
    f.umbrella = f.brolly && this.rain > 0.12;
    const fx = -Math.sin(L.yaw);
    const fz = -Math.cos(L.yaw);
    const narrow = L.edge ? pavement(L.edge, L.side) < 2.1 : false;
    const moving = L.phase >= 0;
    let lat = f.lat;
    let fwd = f.fwd;
    if (narrow && moving && L.mode === MODE.WALK) {
      lat = 0;
      fwd = f.lat > 0 ? -0.95 : -1.9;
    }
    if (f.age === AGE.CHILD) lat += 0.2 * Math.sin(this.time * 0.7 + f.id);
    // (right of the leader's nose (fx, fz) is (−fz, fx))
    const tx = L.x - fz * lat + fx * fwd;
    const tz = L.z + fx * lat + fz * fwd;
    const dx = tx - f.x;
    const dz = tz - f.z;
    const d = len(dx, dz);
    const vmax = Math.max(L.speed, 0.4) * (d > 1.5 ? 1.5 : 1.15) + 0.2;
    const step = Math.min(d, vmax * dt);
    if (d > 0.03 && step > 1e-4) {
      f.x += (dx / d) * step;
      f.z += (dz / d) * step;
      f.walked += step;
      f.phase = f.walked;
      f.speed = step / dt;
      this.turnTo(f, d > 0.15 ? Math.atan2(-dx, -dz) : L.yaw, dt, 5);
    } else {
      f.phase = -1;
      f.speed = 0;
      this.turnTo(f, L.yaw, dt, 4);
    }
    f.y += (L.y - f.y) * Math.min(1, dt * 6);
    f.state = L.state;
    f.crossing = L.crossing;
    f.waited = L.waited;
    f.mode = MODE.FOLLOW;
    f.headTo = L.headTo * 0.8;
    f.head += (f.headTo - f.head) * Math.min(1, dt * 6);
    f.lean = L.lean;
  }

  // ------------------------------------------------------------------------------------ looking round
  private look(p: Person): void {
    if (p.leader) {
      // (with somebody: they look at the cars all the same)
      if (Math.abs(p.x - p.leader.x) + Math.abs(p.z - p.leader.z) > 8) p.leader = null;
      else {
        this.flinch(p);
        return;
      }
      if (!p.leader) {
        // lost their companion: on by themselves, from the nearest pavement
        const at = this.nearestPavement(p.x, p.z, 10);
        if (!at) {
          p.state = 'gone';
          return;
        }
        p.mode = MODE.WALK;
        this.onPavement(p, at.edge, at.side, at.s, this.rand() < 0.5 ? 1 : -1, false);
        p.bx = p.x;
        p.by = p.y;
        p.bz = p.z;
        this.newGoal(p);
        this.planAlong(p);
        return;
      }
    }
    switch (p.mode) {
      case MODE.WALK:
        if (!this.flinch(p) && p.mode === MODE.WALK) this.avoid(p);
        break;
      case MODE.KERB:
        this.flinch(p);
        this.kerbLook(p);
        break;
      case MODE.CROSS:
        this.crossLook(p);
        break;
      default:
        if (p.pause === PAUSE.STOP || p.pause === PAUSE.WINDOW) this.flinch(p);
    }
  }

  /** Walking: out of the way of the others, of cyclists, posts and walls. */
  private avoid(p: Person): void {
    const wx = p.wx;
    const wz = p.wz;
    // (right of the way (wx, wz) is (−wz, wx))
    const rx = -wz;
    const rz = wx;
    const v = Math.max(p.speed, 0.7);
    let nearest = 4.2;
    let want = 0;
    let slow = 1;
    let found = false;
    const consider = (qx: number, qz: number, qvx: number, qvz: number, clear: number, range: number): void => {
      const dx = qx - p.x;
      const dz = qz - p.z;
      const ahead = dx * wx + dz * wz;
      const fast = qvx * qvx + qvz * qvz > 9;
      // (a cyclist comes up from behind as well)
      if (ahead < (fast ? -6 : -0.3) || ahead > range) return;
      const lat = dx * rx + dz * rz;
      const qv = qvx * wx + qvz * wz;
      const closing = ahead >= 0 ? v - qv : qv - v;
      if (ahead > 0.25 && closing < 0.08 && Math.abs(lat) > 0.3) return;
      if (Math.abs(lat) >= clear) return;
      const dist = Math.abs(ahead);
      if (dist >= nearest) return;
      nearest = dist;
      found = true;
      // where they will be, from the middle of my way: pass them on the right if they come towards me, on the left if I overtake
      const q = lat + p.dodge;
      const toRight = q + clear;
      const toLeft = q - clear;
      const oncoming = qv < -0.2;
      const first = oncoming || ahead < 0 ? toRight : qv > 0.2 ? toLeft : Math.abs(toRight - p.dodge) < Math.abs(toLeft - p.dodge) ? toRight : toLeft;
      const second = first === toRight ? toLeft : toRight;
      if (first >= p.dmin && first <= p.dmax) want = first;
      else if (second >= p.dmin && second <= p.dmax) want = second;
      else {
        // no room to pass: behind them, at their pace – or wait
        want = clamp(p.dodge, p.dmin, p.dmax);
        slow = ahead > 0 && qv > 0.3 ? clamp(qv / v, 0.2, 1) : ahead > 0 ? 0 : 1;
      }
    };
    // the people near
    const head = this.cellHead;
    const nxt = this.cellNext;
    const ix = Math.floor(p.x / 4);
    const iz = Math.floor(p.z / 4);
    for (let cx = ix - 1; cx <= ix + 1; cx++) {
      for (let cz = iz - 1; cz <= iz + 1; cz++) {
        for (let k = head[cellKey(cx, cz)]; k >= 0; k = nxt[k]) {
          const q = this.all[k];
          if (!q || q === p || q.leader === p || p.leader === q || q.state === 'gone') continue;
          const moving = q.phase >= 0;
          const qvx = moving ? -Math.sin(q.yaw) * q.speed : 0;
          const qvz = moving ? -Math.cos(q.yaw) * q.speed : 0;
          consider(q.x, q.z, qvx, qvz, 0.68, 3.6);
          // two who know each other: a chat
          if (!moving || p.partner || q.partner || q.mode !== MODE.WALK || q.leader) continue;
          const d2 = (q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z);
          if (d2 < 4 && (-Math.sin(q.yaw) * wx - Math.cos(q.yaw) * wz) < -0.5 && this.chatty(p, q)) {
            const face = Math.atan2(-(q.x - p.x), -(q.z - p.z));
            const t = 8 + 22 * hash01(p.id * 131 + q.id);
            p.partner = q;
            q.partner = p;
            this.pauseHere(p, PAUSE.CHAT, t, face);
            this.pauseHere(q, PAUSE.CHAT, t, face + Math.PI);
            return;
          }
        }
      }
    }
    // those waiting at the stops
    const oh = this.otherHead;
    const on = this.otherNext;
    for (let cx = ix - 1; cx <= ix + 1; cx++) {
      for (let cz = iz - 1; cz <= iz + 1; cz++) {
        for (let k = oh[cellKey(cx, cz)]; k >= 0; k = on[k]) {
          const o = this.others[k];
          if (o) consider(o.x, o.z, 0, 0, 0.62, 3.6);
        }
      }
    }
    // the player on foot
    const pl = this.player;
    if (pl) consider(pl.x, pl.z, -Math.sin(pl.yaw) * pl.speed, -Math.cos(pl.yaw) * pl.speed, 0.75, 3.6);
    // cyclists on the pavement's cycle strip
    for (const c of this.cyclists) {
      if (Math.abs(c.x - p.x) > 9 || Math.abs(c.z - p.z) > 9) continue;
      consider(c.x, c.z, -Math.sin(c.yaw) * c.v, -Math.cos(c.yaw) * c.v, 1.0, 8);
    }
    if (!found) {
      want = 0;
      // children wander from side to side; the old stop for a breath now and then
      if (p.age === AGE.CHILD) want = clamp(0.35 * Math.sin(this.time * 0.8 + p.id), p.dmin, p.dmax);
      else if (p.age === AGE.OLD && this.rand() < 0.004) {
        this.pauseHere(p, PAUSE.REST, 3 + this.rand() * 5, p.yaw);
        return;
      }
    }
    // posts, walls, a vehicle standing on the pavement: a little aside, where it is free
    if (this.time > p.ghost && this.inWay(p, want)) {
      let free = Number.NaN;
      for (const d of ASIDE) {
        const c = want + d;
        if (c < p.dmin || c > p.dmax) continue;
        if (!this.inWay(p, c)) {
          free = c;
          break;
        }
      }
      if (Number.isNaN(free)) {
        slow = Math.min(slow, 0.25);
        p.stuck += THINK;
        // (stuck: through it after all, rather than stand there for ever)
        if (p.stuck > 2.5) {
          p.ghost = this.time + 4;
          p.stuck = 0;
        }
      } else {
        want = free;
        p.stuck = 0;
      }
    } else if (slow > 0.5) p.stuck = 0;
    else {
      p.stuck += THINK;
      if (p.stuck > 6) {
        // waited behind somebody long enough: past them, however close
        p.ghost = this.time + 3;
        slow = 1;
        p.stuck = 0;
      }
    }
    p.dodgeTo = want;
    p.slow = slow;
  }

  /** Two who meet stop for a chat: now and then, not in the rain, at night or in a hurry. */
  private chatty(p: Person, q: Person): boolean {
    if (p.hurry || q.hurry || this.rain > 0.15 || this.hour < 7 || this.hour >= 21) return false;
    if (p.age === AGE.CHILD || q.age === AGE.CHILD) return false;
    return hash01(Math.min(p.id, q.id) * 7919 + Math.max(p.id, q.id)) < 0.1 * (p.idle + q.idle);
  }

  private pauseHere(p: Person, why: number, seconds: number, face: number): void {
    p.mode = MODE.PAUSE;
    p.modeT = 0;
    p.pause = why;
    p.until = this.time + seconds;
    p.face = face;
    p.speed = 0;
    p.phase = -1;
  }

  /** Is something standing in the way 1 and 2 m ahead, `d` metres to the right of the way? */
  private inWay(p: Person, d: number): boolean {
    const rx = -p.wz;
    const rz = p.wx;
    for (const ahead of PROBE) {
      const x = p.bx + p.wx * ahead + rx * d;
      const z = p.bz + p.wz * ahead + rz * d;
      if (this.blocked?.(x, p.y, z, 0.24)) return true;
      for (const o of this.obstacles) {
        if (Math.abs(o.x - x) > 12 || Math.abs(o.z - z) > 12) continue;
        if (Math.abs(o.speed) > 0.5) continue;
        const fx = -Math.sin(o.yaw);
        const fz = -Math.cos(o.yaw);
        const lf = (x - o.x) * fx + (z - o.z) * fz;
        const lr = (x - o.x) * -fz + (z - o.z) * fx;
        if (Math.abs(lf) < o.length / 2 + 0.3 && Math.abs(lr) < o.width / 2 + 0.3) return true;
      }
    }
    return false;
  }

  /** A vehicle too close or too fast near them: a start, and back from the kerb (true: so it was). */
  private flinch(p: Person): boolean {
    if (p.mode === MODE.WALK && p.next === NEXT.ENTER) return false;
    for (let i = 0; i < this.nVeh; i++) {
      const V = this.vehs[i];
      if (Math.abs(V.x - p.x) > 14 || Math.abs(V.z - p.z) > 14) continue;
      const sp = Math.abs(V.v);
      if (sp < 1.5) continue;
      const dx = p.x - V.x;
      const dz = p.z - V.z;
      const lf = dx * V.fx + dz * V.fz;
      const lr = dx * -V.fz + dz * V.fx;
      const d = len(Math.max(0, Math.abs(lf) - V.len / 2), Math.max(0, Math.abs(lr) - V.wid / 2));
      const toward = V.v > 0 ? lf > -V.len / 2 : lf < V.len / 2;
      // (a car passing the kerb at an ordinary distance is nothing to start at – close, or close and fast, is)
      if (!(d < 0.6 || (toward && ((d < 1.0 && sp > 12) || (d < 0.8 && sp > 7))))) continue;
      const hard = d < 0.6;
      p.startle = Math.max(p.startle, hard ? 1 : 0.6);
      p.headTo = clamp(wrapAngle(Math.atan2(-(V.x - p.x), -(V.z - p.z)) - p.yaw), -1.3, 1.3);
      if (p.mode === MODE.KERB) {
        p.kback = Math.min(1.1, p.kback + (hard ? 0.6 : 0.4));
        p.modeT = 0;
        p.lookT = 0;
      } else if (p.mode === MODE.WALK) {
        // away from the road
        const e = p.edge;
        if (e) {
          const out = p.side * p.dir > 0 ? -1 : 1;
          p.dodgeTo = clamp(p.dodge + out * 0.6, p.dmin, p.dmax);
        }
        if (hard) this.pauseHere(p, PAUSE.START, 0.6 + this.rand() * 0.6, p.yaw);
      }
      return true;
    }
    return false;
  }

  /** At the kerb: is it time to go? */
  private kerbLook(p: Person): void {
    if (p.kback > 0.05) return;
    const need = p.age === AGE.OLD ? 2.4 : p.age === AGE.CHILD ? (p.bold ? 0.5 : 0.9) : p.bold ? 0.8 : 1.9;
    let rule = p.xRule;
    if (rule === RULE.LIGHT) {
      const st = this.signals.pedestrian(p.xSc, p.xG);
      if (st === 'dark') {
        p.xRule = rule = RULE.GAP;
      } else {
        // the button (lights of the map's crossings have one)
        if (!p.pressed && p.xCross && st === 'red') {
          this.signals.request(p.xSc);
          p.pressed = true;
        }
        if (st === 'green') {
          if (p.lookT > 0.5 && this.noneRunning(p) && !this.turningIn(p, 9) && !this.closeIn(p, 7)) this.go(p);
        } else if (p.redRun && p.modeT > 4 && this.clearToGo(p, p.margin + 4, 70)) this.go(p);
        return;
      }
    }
    if (rule === RULE.ZEBRA) {
      if (!p.registered) {
        // they come up to the kerb once every vehicle could still stop for them
        if (this.allCanStop(p)) this.register(p);
        else {
          p.lookT = Math.min(p.lookT, 0.7);
          return;
        }
      }
      if (p.lookT > need && this.zebraClear(p) && !this.closeIn(p, 6)) this.go(p);
      return;
    }
    // a gap: the longer they wait, the smaller one they take
    const margin = p.margin * Math.max(0.45, 1 - p.modeT / 70);
    if (p.lookT > need && this.clearToGo(p, margin, 0) && !this.turningIn(p, 20) && !this.closeIn(p, 10)) this.go(p);
  }

  /** Crossing: a vehicle coming at them that will not stop – back to the kerb, or hurry over; the light turned red – hurry. */
  private crossLook(p: Person): void {
    if (p.xRule === RULE.LIGHT && this.signals.pedestrian(p.xSc, p.xG) === 'red') p.hurryX = Math.max(p.hurryX, 1.45);
    const e = p.xEdge;
    if (!e || p.next !== NEXT.CROSSED) return;
    const across = (p.x - p.kx) * p.ax + (p.z - p.kz) * p.az;
    let danger = Infinity;
    for (let i = 0; i < this.nVeh; i++) {
      const V = this.vehs[i];
      if (Math.abs(V.x - p.x) > 50 || Math.abs(V.z - p.z) > 50) continue;
      const sp = Math.abs(V.v);
      if (sp < 2) continue;
      const hx = V.v > 0 ? V.fx : -V.fx;
      const hz = V.v > 0 ? V.fz : -V.fz;
      const dx = p.x - V.x;
      const dz = p.z - V.z;
      const lf = dx * hx + dz * hz;
      const lr = dx * -hz + dz * hx;
      if (lf < 0 || Math.abs(lr) > V.wid / 2 + 1) continue;
      const room = lf - V.len / 2 - 1;
      // (braking hard enough to stop short of them: no danger)
      if (V.a < -0.8 && room > (sp * sp) / (2 * -V.a)) continue;
      danger = Math.min(danger, room / sp);
    }
    if (danger > 2.2) return;
    p.startle = Math.max(p.startle, 0.8);
    if (across < e.width * 0.3) {
      // just stepped out: back on to the kerb
      p.np = 0;
      p.pi = 0;
      this.putXYZ(p, p.sx, p.sy, p.sz);
      p.next = NEXT.BACK;
      p.hurryX = 1.5;
    } else p.hurryX = 1.6;
  }

  /** Could every vehicle coming up still stop before the crossing – comfortably?  (Then somebody may come up to a zebra crossing.) */
  private allCanStop(p: Person): boolean {
    for (let i = 0; i < this.nVeh; i++) {
      const V = this.vehs[i];
      const sp = Math.abs(V.v);
      if (sp < 1) continue;
      const front = this.toLine(V, p, 2.5);
      if (front === Infinity || front < -V.len) continue;
      if (front < sp * REACT + (sp * sp) / (2 * COMFORT) + 2) return false;
    }
    return true;
  }

  /** At a zebra crossing: every vehicle coming up stands, or is clearly stopping – or is so far off that it does not matter. */
  private zebraClear(p: Person): boolean {
    const vw = p.v0 * 1.12;
    for (let i = 0; i < this.nVeh; i++) {
      const V = this.vehs[i];
      const front = this.toLine(V, p, 2.5);
      if (front === Infinity || front < -(V.len + 1)) continue;
      const sp = Math.abs(V.v);
      if (front < 0.5 && !(sp < 0.3 && front > 0)) return false;
      if (sp < 0.6) continue;
      // near the crossing: once it has stopped (or all but); further off: once it is clearly stopping – or so far off that it does not matter
      if (front < 25) return false;
      const stopping = V.a < -0.5 && front > (sp * sp) / (2 * Math.max(0.5, -V.a)) + 3;
      if (stopping) continue;
      if (front / sp > (this.lineLen(p) + 2) / vw + 2.5) continue;
      return false;
    }
    return true;
  }

  /** At a green light: nobody still coming who could not stop (running the red, or turning in). */
  private noneRunning(p: Person): boolean {
    for (let i = 0; i < this.nVeh; i++) {
      const V = this.vehs[i];
      const front = this.toLine(V, p, 2.5);
      if (front === Infinity || front < -(V.len + 1)) continue;
      const sp = Math.abs(V.v);
      if (front < 0.5 && sp > 0.3) return false;
      if (sp < 1) continue;
      if (front < sp * 0.4 + (sp * sp) / (2 * 6) + 1) return false;
    }
    return true;
  }

  /**
   * A gap in the traffic: every vehicle that comes over the line comes after
   * they have crossed its way with `margin` seconds in hand – and could stop
   * all the same; one that is there already they let pass.  `empty`:
   * besides, none within so many metres (crossing against the red).
   */
  private clearToGo(p: Person, margin: number, empty: number): boolean {
    const vw = p.v0 * 1.12;
    for (let i = 0; i < this.nVeh; i++) {
      const V = this.vehs[i];
      const front = this.toLine(V, p, 2.5);
      if (front === Infinity || front < -(V.len + 1.5)) continue;
      const sp = Math.abs(V.v);
      if (empty > 0 && front < empty) return false;
      // (one standing just short of the way over – at its line – they pass in front of: it waits for them then)
      if (front < 0.6 && !(sp < 0.3 && front > 0)) return false;
      if (sp < 0.5) continue;
      // where it meets the line: when they are past its way – it is to come after that
      const leave = (this.lineAt + 1.3) / vw;
      if (front / sp > leave + margin && front > sp * REACT + (sp * sp) / (2 * COMFORT) + 2) continue;
      return false;
    }
    return true;
  }

  /** A car turning into the street they are to cross, within `range` metres of where they cross – they let it by. */
  private turningIn(p: Person, range: number): boolean {
    const e = p.xEdge;
    if (!e) return false;
    const mx = (p.kx + p.fx) / 2;
    const mz = (p.kz + p.fz) / 2;
    for (let i = 0; i < this.nVeh; i++) {
      const V = this.vehs[i];
      if (V.into !== e || Math.abs(V.v) < 1) continue;
      if (len(V.x - mx, V.z - mz) < range + V.len / 2) return true;
    }
    return false;
  }

  /**
   * A vehicle coming nearer to the way over, within `range` metres of it –
   * the player's car turning in, say, whose way the people cannot know: they
   * let it come by (or stop) first.
   */
  private closeIn(p: Person, range: number): boolean {
    const L = this.lineLen(p);
    for (let i = 0; i < this.nVeh; i++) {
      const V = this.vehs[i];
      const sp = Math.abs(V.v);
      if (sp < 1.5 || Math.abs(V.x - p.kx) > range + 20 || Math.abs(V.z - p.kz) > range + 20) continue;
      const t = clamp((V.x - p.kx) * p.ax + (V.z - p.kz) * p.az, 0, L);
      const dx = p.kx + p.ax * t - V.x;
      const dz = p.kz + p.az * t - V.z;
      const d = len(dx, dz);
      if (d - V.len / 2 > range) continue;
      const hx = V.v > 0 ? V.fx : -V.fx;
      const hz = V.v > 0 ? V.fz : -V.fz;
      if (((dx * hx + dz * hz) / Math.max(d, 0.1)) * sp > 1) return true;
    }
    return false;
  }

  /** where on the line (m from the near kerb) the vehicle last asked about meets it */
  private lineAt = 0;

  private lineLen(p: Person): number {
    return len(p.fx - p.kx, p.fz - p.kz);
  }

  /**
   * How far the front of a vehicle still has to go to the line across the
   * road that `p` crosses on (m; negative once it is on or past it) –
   * Infinity if its way does not cross the line (it runs along it, or passes
   * beside its ends by more than `reach`).  Sets `lineAt`.
   */
  private toLine(V: Veh, p: Person, reach: number): number {
    if (Math.abs(V.x - p.kx) > 140 || Math.abs(V.z - p.kz) > 140) return Infinity;
    const ux = p.ax;
    const uz = p.az;
    // (the line's normal: along the road)
    const nx = -uz;
    const nz = ux;
    const hx = V.v >= 0 ? V.fx : -V.fx;
    const hz = V.v >= 0 ? V.fz : -V.fz;
    const dn = hx * nx + hz * nz;
    const rel = (V.x - p.kx) * nx + (V.z - p.kz) * nz;
    const L = this.lineLen(p);
    if (Math.abs(dn) < 0.25) {
      // along the line: in the way only if it stands on it
      const q = (V.x - p.kx) * ux + (V.z - p.kz) * uz;
      if (Math.abs(rel) < V.wid / 2 + 1 && q > -V.len / 2 - 1 && q < L + V.len / 2 + 1) {
        this.lineAt = clamp(q, 0, L);
        return -0.1;
      }
      return Infinity;
    }
    const t = -rel / dn;
    const qx = V.x + hx * t;
    const qz = V.z + hz * t;
    const q = (qx - p.kx) * ux + (qz - p.kz) * uz;
    if (q < -reach - V.wid / 2 || q > L + reach + V.wid / 2) return Infinity;
    this.lineAt = clamp(q, 0, L);
    return t - V.len / 2 - 0.8;
  }

  /** The player's vehicle comes too close to somebody on the road – or runs into somebody anywhere. */
  private endanger(p: Person, player: PlayerState, events: WalkerSink): void {
    const sp = Math.abs(player.speed);
    if (sp < 1.2) return;
    const dx = p.x - player.x;
    const dz = p.z - player.z;
    const r = player.length / 2 + 3;
    if (dx * dx + dz * dz > r * r) return;
    const fx = -Math.sin(player.yaw);
    const fz = -Math.cos(player.yaw);
    const lf = dx * fx + dz * fz;
    const lr = dx * -fz + dz * fx;
    const d = len(Math.max(0, Math.abs(lf) - player.length / 2), Math.max(0, Math.abs(lr) - player.width / 2));
    const onRoad = p.state === 'cross';
    if (!((onRoad && d < 1.0) || d < 0.2)) return;
    if (this.time - p.told > 4) {
      p.told = this.time;
      events.push({ type: 'pedestrianEndangered', ped: p });
    }
    p.startle = 1;
    if (d < 0.3) {
      // out of its way, to the side they are on
      const push = player.width / 2 + 0.4 - Math.abs(lr);
      if (push > 0) {
        const sgn = lr >= 0 ? 1 : -1;
        p.x += -fz * push * sgn;
        p.z += fx * push * sgn;
        if (!p.leader && p.mode !== MODE.KERB) {
          p.bx += -fz * push * sgn;
          p.bz += fx * push * sgn;
        }
      }
    }
  }

  /** The horn: who is near it starts, looks at it – and hurries off the road. */
  private honk(player: PlayerState): void {
    const fx = -Math.sin(player.yaw);
    const fz = -Math.cos(player.yaw);
    for (const p of this.all) {
      const dx = p.x - player.x;
      const dz = p.z - player.z;
      const d = len(dx, dz);
      if (d > 38) continue;
      const ahead = dx * fx + dz * fz;
      if (d > 12 && ahead < 0) continue;
      p.startle = Math.max(p.startle, d < 22 ? 1 : 0.65);
      p.headTo = clamp(wrapAngle(Math.atan2(dx, dz) - p.yaw), -1.3, 1.3);
      if (p.leader) continue;
      if (p.mode === MODE.CROSS) p.hurryX = 1.5;
      else if (p.mode === MODE.KERB) {
        p.kback = Math.max(p.kback, 0.5);
        p.modeT = 0;
        p.lookT = 0;
      } else if (p.mode === MODE.WALK) this.pauseHere(p, PAUSE.START, 0.5 + this.rand() * 0.6, p.yaw);
    }
  }

  // ------------------------------------------------------------------------------------ what is around
  /** The vehicles round the player, as the people see them. */
  private see(dt: number, player: PlayerState, cars: readonly TrafficCar[], obstacles: readonly PlayerState[]): void {
    let n = 0;
    const get = (): Veh => (this.vehs[n++] ??= { x: 0, y: 0, z: 0, fx: 0, fz: -1, v: 0, a: 0, len: 4, wid: 1.8, into: null });
    for (const c of cars) {
      const V = get();
      V.x = c.x;
      V.y = c.y;
      V.z = c.z;
      V.fx = -Math.sin(c.yaw);
      V.fz = -Math.cos(c.yaw);
      V.v = c.v;
      V.a = c.braking ? Math.min(c.a, -1) : c.a;
      V.len = c.length;
      V.wid = c.width;
      // (the road it turns into: in the junction now, or close before it)
      const conn = c.conn;
      if (conn && conn.turn !== 0) V.into = conn.to.edge;
      else if (c.next && c.next.turn !== 0 && c.lane && c.lane.len - c.s < 25) V.into = c.next.to.edge;
      else V.into = null;
    }
    // the player's vehicle
    this.playerVeh = null;
    if (!player.onFoot) {
      const raw = (player.speed - this.pv) / dt;
      this.pa += (clamp(raw, -12, 8) - this.pa) * Math.min(1, dt * 5);
      const V = get();
      V.x = player.x;
      V.y = player.y;
      V.z = player.z;
      V.fx = -Math.sin(player.yaw);
      V.fz = -Math.cos(player.yaw);
      V.v = player.speed;
      // (backwards: braking is speeding up the other way)
      V.a = player.speed >= 0 ? this.pa : -this.pa;
      V.len = player.length;
      V.wid = player.width;
      V.into = null;
      this.playerVeh = V;
    } else this.pa = 0;
    this.pv = player.speed;
    for (const o of obstacles) {
      const V = get();
      V.x = o.x;
      V.y = o.y;
      V.z = o.z;
      V.fx = -Math.sin(o.yaw);
      V.fz = -Math.cos(o.yaw);
      V.v = o.speed;
      V.a = 0;
      V.len = o.length;
      V.wid = o.width;
      V.into = null;
    }
    this.nVeh = n;
  }

  /** The grid of the people: who is in which 4 m cell (and the others standing about). */
  private grid(): void {
    const all = this.all;
    if (this.cellNext.length < all.length) this.cellNext = new Int32Array(all.length * 2);
    this.cellHead.fill(-1);
    for (let i = 0; i < all.length; i++) {
      const p = all[i];
      const k = cellKey(Math.floor(p.x / 4), Math.floor(p.z / 4));
      this.cellNext[i] = this.cellHead[k];
      this.cellHead[k] = i;
    }
    const others = (this.others = this.standing?.() ?? []);
    if (this.otherNext.length < others.length) this.otherNext = new Int32Array(others.length * 2);
    this.otherHead.fill(-1);
    for (let i = 0; i < others.length; i++) {
      const k = cellKey(Math.floor(others[i].x / 4), Math.floor(others[i].z / 4));
      this.otherNext[i] = this.otherHead[k];
      this.otherHead[k] = i;
    }
  }
}

function cellKey(ix: number, iz: number): number {
  return (Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663)) & (CELLS - 1);
}

/** the length of (x, z) (Math.hypot is slow) */
function len(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}
