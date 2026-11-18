// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Ambient traffic.
 *
 * Cars travel on the lane graph: they follow the car ahead (Intelligent
 * Driver Model), keep to speed limits, slow for bends, obey traffic lights
 * and stop signs and give way exactly according to the right-of-way relations
 * of the lane graph – the same relations the rule monitor judges the player by.
 */
import { clamp, hash01, newPolySample, rng, samplePolyline } from '../core/geom.ts';
import type { PolySample } from '../core/geom.ts';
import type { BusLine, BusLineStop, BusLines } from '../world/buslines.ts';
import { LaneGraph, TURN, lanePoint } from '../world/lanes.ts';
import type { Connector, Lane } from '../world/lanes.ts';
import { MinHeap, wayOf } from '../world/routegraph.ts';
import { CLS, CTRL, EF, ROLE, XING } from '../world/types.ts';
import type { CrossingJson } from '../world/types.ts';
import type { Edge, World } from '../world/world.ts';
import { CYCLE_LENGTH, CYCLE_WIDTH, Cyclists } from './cyclists.ts';
import type { CycleEvent } from './cyclists.ts';
import { Crowd } from './pedestrians.ts';
import type { Walker } from './pedestrians.ts';
import { SIG } from './signals.ts';
import type { SignalSystem } from './signals.ts';
import type { Emergencies, EmergencyCar } from './emergency.ts';
import type { RoadEvents } from './roadevents.ts';
import { PastBlocks, offsetAt } from './pastblock.ts';
import { Narrowings } from './narrowings.ts';
import type { LevelCrossings } from './levelcrossing.ts';
import type { Wildlife } from './wildlife.ts';
import type { PastState } from './pastblock.ts';
import { chordHalf, chordYaw, easePose } from './smoothpose.ts';
import type { EasedPose } from './smoothpose.ts';

export interface TrafficCar {
  id: number;
  lane: Lane | null;
  conn: Connector | null;
  /** distance of the car's centre along the current lane / connector */
  s: number;
  v: number;
  a: number;
  /** next connector to take at the end of the current lane */
  next: Connector | null;
  length: number;
  width: number;
  color: number;
  style: number;
  /** desired speed factor relative to the limit */
  temper: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** -1 left, 0 none, 1 right */
  blinker: number;
  braking: boolean;
  /** seconds spent waiting at the current stop/yield line */
  waited: number;
  /** seconds spent waiting for a gap (not counting red lights) */
  yieldWait: number;
  stoppedAtLine: boolean;
  stuck: number;
  /** set while the player's car is the reason for braking */
  blockedByPlayer: number;
  /**
   * How the player's car came to be in this one's way: the time gap (s) at
   * which it was first seen there (Infinity while it is not), and for how
   * long that is remembered once it is out of the way again.
   */
  playerFirstGap: number;
  playerSeen: number;
  /**
   * A city bus (style BUS_STYLE): the stop it stands at – seconds left with
   * its doors open –, the pole it served last, and how long it still
   * indicates to pull out again; the line it runs (null: none), and how many
   * roads it has driven since it last had one.
   */
  bus?: { dwell: number; served: number; doors: boolean; pullOut: number; line?: BusOnLine | null; free?: number; trip?: string; retired?: boolean };
  /**
   * The lane of the same road it is moving over to (a bus whose line turns
   * where its own lane does not lead) – and, once it has, how far it is
   * still drawn to the left of the middle of its new lane (m) while it
   * slides across.
   */
  merge?: Lane | null;
  slide?: number;
  /** a bus that has lost its line's way: the connectors back onto it, the next first ([]: none found) */
  detour?: Connector[] | null;
  /** an emergency vehicle – police, ambulance, fire engine, the emergency doctor – and its call (src/sim/emergency.ts) */
  em?: EmergencyCar;
  /** how far it keeps left (+) or right (−) of the middle of its lane (m): making way for one of those, or passing the others */
  side?: number;
  /** going round something that blocks its lane – waiting behind it, out, beside it, back (src/sim/pastblock.ts) */
  past?: PastState;
  crashed: number;
  wheelSpin: number;
  /**
   * Where it is drawn, and seen when watched (src/sim/smoothpose.ts): its
   * place and heading eased – turning gradually through the corners of its
   * way – and its front wheels' angle.  (x, z, yaw above are where its way
   * puts it: what the simulation reckons with.)  Unset until it first moved.
   */
  drawn?: EasedPose;
  /** the path through the junction it came by (its heading is taken over the end of that while it is near) */
  lastConn?: Connector | null;
}

/**
 * A bus running a line (src/world/buslines.ts): what its destination
 * display shows, and where on the line's ways it is.
 */
export interface BusOnLine {
  /** the line's number and where it goes – what the bus shows */
  ref: string;
  to: string;
  /** the line (its number in BusLines.lines) and the way of it the bus is on (index into its ways) */
  index: number;
  k: number;
  /**
   * 0 while it is on its line's way; once it has lost it (its lane did not
   * lead on there, or the map has no road for a piece) how many roads it has
   * driven since – it drives on as the others do and looks for its way again
   */
  off: number;
}

/**
 * The timetables of the buses as the traffic asks them (the game answers
 * from src/game/timedtransit.ts): the buses of the lines that have one are
 * put where and when their trips are, not by chance, and stand at a stop
 * until their time.
 */
export interface BusSchedule {
  /** does the line (its number in BusLines.lines) run by a timetable? */
  timed(line: number): boolean;
  /** a step: the buses of the trips under way round the player put on their roads (by addCar), each once */
  step(dt: number, player: PlayerState): void;
  /** the traffic was cleared: the trips are put where they are, also close to the player */
  reset(): void;
  /** how long a bus of a trip stands at the stop of pole `pole` it has come to (s; `least`: what it would stand without a timetable) */
  dwell(car: TrafficCar, pole: number, least: number): number;
}

/**
 * One of the people on foot in the town (src/sim/pedestrians.ts): whoever
 * waits at a crossing or walks over it (`state`, `crossing`, `waited`) is
 * what the cars and the instructor go by.
 */
export type Pedestrian = Walker;

/** A vehicle that drives itself: where it is on its path, for asking the traffic what is around it. */
export interface SelfDriving {
  /** the lane it is on, and the connector it is on while crossing a junction (or null) */
  lane: Lane | null;
  conn: Connector | null;
  /** distance of its middle along that lane or connector */
  s: number;
  v: number;
  /** the connector it will take at the end of its lane */
  next: Connector | null;
  /** the connectors of its way beyond that, if it knows where it is going */
  route?: readonly Connector[];
  length: number;
  width: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** going round something that blocks its lane (src/sim/pastblock.ts) */
  past?: PastState | null;
}

/** What the traffic needs to know about the player's car. */
export interface PlayerState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  length: number;
  width: number;
  /** the lane the vehicle is on and how far along it its middle is (if the caller knows: the cyclists are sent along by it) */
  lane?: Lane | null;
  s?: number;
  /** among the obstacles: a part of the player's vehicle (its trailer) */
  own?: boolean;
  /** the player is on foot (then x, z are where they stand and yaw where they look) */
  onFoot?: boolean;
  /** the horn sounds (the people near it start) */
  horn?: boolean;
  /** among the obstacles: a vehicle that stands there for good (parked, broken down) – the traffic goes round it, over a solid line if need be */
  parked?: boolean;
}

/** the style of a traffic car that is a city bus (12 m, it calls at the stops) */
export const BUS_STYLE = 3;

/**
 * A bus stop along a lane: where the front of a bus stands to serve it
 * (metres along the lane) and the pole's number – the stop place's number in
 * the map's stops times 64, plus which of its poles (63: the place as a line
 * of buses gives it, without a pole on this lane).
 */
export interface BusStopOnLane {
  s: number;
  id: number;
}

/** The stop place a pole's number (BusStopOnLane.id) belongs to. */
export function stopPlaceOf(pole: number): number {
  return Math.floor(pole / 64);
}

export type TrafficEvent =
  /**
   * `cutIn`: the player's car appeared in this car's way at short notice –
   * moved over or pulled out in front of it – rather than having been seen
   * ahead from far away (whoever comes up from behind keeps his own distance, § 4 StVO)
   */
  | { type: 'forcedBrake'; car: TrafficCar; decel: number; cutIn: boolean }
  | { type: 'collision'; car: TrafficCar; speed: number }
  /** every picture while the player's vehicle overlaps one of the traffic: the way out (unit, from it to the player) and how deep */
  | { type: 'contact'; car: TrafficCar; nx: number; nz: number; depth: number }
  | { type: 'pedestrianEndangered'; ped: Pedestrian }
  /** a cyclist had to brake hard because the player's vehicle came into their way – or was knocked over by it */
  | CycleEvent;

const COLORS = [0xd9dadc, 0x1c1d20, 0x8d9197, 0x3a3f46, 0xa01c1c, 0x1f3f7a, 0xf0efe8, 0x55606a, 0x7a2f2a, 0x2c5a3a, 0xb8b08c, 0x394a66, 0xc4c7ca, 0x101113];

const tmp = newPolySample();
const tmp2 = newPolySample();

export class Traffic {
  readonly world: World;
  readonly graph: LaneGraph;
  readonly signals: SignalSystem;
  readonly cars: TrafficCar[] = [];
  /** the people on foot in the town (src/sim/pedestrians.ts; `crowd.target` says how many) */
  readonly crowd: Crowd;
  /** people on bicycles (src/sim/cyclists.ts) */
  readonly cyclists: Cyclists;
  /** cars currently on each lane / connector, unsorted */
  private readonly onLane = new Map<number, TrafficCar[]>();
  private readonly onConn = new Map<number, TrafficCar[]>();
  /** lanes cars may appear on, bucketed by 120 m cells for spawning near the player */
  private readonly spawnGrid = new Map<number, Lane[]>();
  private readonly rand = rng(20261114);
  private nextId = 1;
  private spawnTimer = 0;
  /**
   * The bus stops along a lane (set by the game from the stops of the map) –
   * with them, now and then a city bus is among the traffic.
   */
  busStops: ((lane: Lane) => readonly BusStopOnLane[]) | null = null;
  /** the share of the traffic that are buses (where there are stops, or where a line runs) */
  busShare = 0.08;
  /** the timetables of the buses (src/game/timedtransit.ts – null: none): the buses of their lines come where and when their trips are */
  busSchedule: BusSchedule | null = null;
  /** the lines of the city buses (setBusLines) */
  private lines: BusLines | null = null;
  targetCount = 24;
  spawnRadius = 330;
  events: TrafficEvent[] = [];
  /** emergency vehicles on their calls, and how the others make way for them (src/sim/emergency.ts – null: none come) */
  emergency: Emergencies | null = null;
  /** the roadworks and closures of the day: where cars wait, move over and keep out (src/sim/roadevents.ts – null: none) */
  roadEvents: RoadEvents | null = null;
  /** getting past what blocks a lane: a car standing behind something that does not move goes round it (src/sim/pastblock.ts) */
  readonly pastBlocks: PastBlocks = new PastBlocks(this);
  /** the narrowings kerb build-outs make: through the gap, slowly, one direction after the other (src/sim/narrowings.ts) */
  readonly narrowings: Narrowings = new Narrowings(this);
  /** the level crossings: waiting while their lights are on or a train comes, never stopping on the tracks (src/sim/levelcrossing.ts – null: none) */
  levelCrossings: LevelCrossings | null = null;
  /** deer and wild boar crossing the country roads at dusk: the cars brake for them (src/sim/wildlife.ts – null: none) */
  wild: Wildlife | null = null;

  constructor(world: World, graph: LaneGraph, signals: SignalSystem) {
    this.world = world;
    this.graph = graph;
    this.signals = signals;
    this.cyclists = new Cyclists(world, graph, signals);
    this.cyclists.lanesAt = (x, z) => this.spawnGrid.get(Traffic.cellKey(x, z));
    this.crowd = new Crowd(world, signals);
    this.addRoads(world.allEdges);
  }

  /** The people on foot (src/sim/pedestrians.ts): those at a crossing are what the cars stop for. */
  get peds(): Pedestrian[] {
    return this.crowd.people;
  }

  /** Roads that are part of the network now (it comes in pieces): cars may appear on their lanes. */
  addRoads(edges: Iterable<Edge>): void {
    for (const e of edges) {
      const el = this.graph.edgeLanes[e.id];
      if (!el) continue;
      for (const lane of [...el.fwd, ...el.back]) {
        for (const key of this.spawnCells(lane)) {
          let list = this.spawnGrid.get(key);
          if (!list) this.spawnGrid.set(key, (list = []));
          // main roads carry more traffic: list them more than once
          const copies = lane.edge.tier >= 4 ? 4 : lane.edge.tier >= 3 ? 3 : 1;
          for (let k = 0; k < copies; k++) list.push(lane);
        }
      }
    }
  }

  /** Roads that are being taken out of the network: no car stays on them, none appears there. */
  removeRoads(edges: Iterable<Edge>): void {
    const gone = new Set<Edge>(edges);
    if (gone.size === 0) return;
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const car = this.cars[i];
      const on = car.lane ? gone.has(car.lane.edge) : car.conn ? gone.has(car.conn.from.edge) || gone.has(car.conn.to.edge) : false;
      if (on) {
        this.detach(car);
        this.cars.splice(i, 1);
      }
    }
    this.crowd.removeRoads(gone);
    for (const e of gone) {
      const el = this.graph.edgeLanes[e.id];
      if (!el) continue;
      for (const lane of [...el.fwd, ...el.back]) {
        for (const key of this.spawnCells(lane)) {
          const list = this.spawnGrid.get(key);
          if (!list) continue;
          const kept = list.filter((l) => l !== lane);
          if (kept.length) this.spawnGrid.set(key, kept);
          else this.spawnGrid.delete(key);
        }
      }
    }
  }

  /** The cells of the spawn grid a lane passes through – none if no car is to appear on it. */
  private spawnCells(lane: Lane): Set<number> {
    const seen = new Set<number>();
    if (!LaneGraph.drivable(lane.edge, true) || lane.len < 25) return seen;
    if (lane.edge.flags & EF.ROUNDABOUT) return seen;
    for (let d = 0; d <= lane.len; d += 40) {
      lanePoint(lane, d, tmp);
      seen.add(Traffic.cellKey(tmp.x, tmp.z));
    }
    return seen;
  }

  // --- bookkeeping -------------------------------------------------------------
  private attach(car: TrafficCar): void {
    const map = car.conn ? this.onConn : this.onLane;
    const key = car.conn ? car.conn.id : car.lane!.id;
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(car);
  }

  private detach(car: TrafficCar): void {
    const map = car.conn ? this.onConn : this.onLane;
    const key = car.conn ? car.conn.id : car.lane!.id;
    const list = map.get(key);
    if (!list) return;
    const i = list.indexOf(car);
    if (i >= 0) list.splice(i, 1);
  }

  private chooseNext(lane: Lane): Connector | null {
    const outs = lane.out;
    if (outs.length === 0) return null;
    let total = 0;
    const w: number[] = [];
    for (const c of outs) {
      let weight = 0;
      if (LaneGraph.drivable(c.to.edge, true) && !this.roadEvents?.closed(c.to)) {
        weight = c.turn === TURN.STRAIGHT ? 4 : c.turn === TURN.UTURN ? 0.02 : 1.4;
        weight *= 0.5 + c.to.edge.tier * 0.5;
        if (c.to.edge.cls <= CLS.MOTORWAY_LINK && lane.edge.cls > CLS.MOTORWAY_LINK) weight *= 0.35;
      }
      w.push(weight);
      total += weight;
    }
    if (total <= 0) return outs[Math.floor(this.rand() * outs.length)];
    let r = this.rand() * total;
    for (let i = 0; i < outs.length; i++) {
      r -= w[i];
      if (r <= 0) return outs[i];
    }
    return outs[outs.length - 1];
  }

  private static cellKey(x: number, z: number): number {
    return (Math.floor(x / 120) + 512) * 1024 + Math.floor(z / 120) + 512;
  }

  /**
   * Other things on the road the cars must not run into, described like the
   * player's car (set by the game every frame: the cars of trams and trains).
   */
  obstacles: readonly PlayerState[] = [];
  /** the obstacles and the cyclists, as the cars see them (made anew in every step) */
  private readonly blocks: PlayerState[] = [];
  private readonly cycleBoxes: PlayerState[] = [];
  /** everything besides the cars in their way this step (for src/sim/pastblock.ts) */
  get blockList(): readonly PlayerState[] {
    return this.blocks;
  }
  /** the cars on a lane now, unsorted */
  carsOn(lane: Lane): readonly TrafficCar[] | undefined {
    return this.onLane.get(lane.id);
  }
  /** the cars on a path through a junction now, unsorted */
  carsOnConn(c: Connector): readonly TrafficCar[] | undefined {
    return this.onConn.get(c.id);
  }
  /** distance along a car's way until it would touch `box` (Infinity: it does not within `horizon`) */
  gapTo(car: TrafficCar, box: PlayerState, horizon: number): number {
    return this.playerAhead(car, box, horizon);
  }

  private spawn(player: PlayerState): void {
    for (let attempt = 0; attempt < 10; attempt++) {
      // a random spot in the ring around the player
      const ang = this.rand() * Math.PI * 2;
      const rad = 160 + this.rand() * (this.spawnRadius - 160);
      const list = this.spawnGrid.get(Traffic.cellKey(player.x + Math.cos(ang) * rad, player.z + Math.sin(ang) * rad));
      if (!list || list.length === 0) continue;
      const lane = list[Math.floor(this.rand() * list.length)];
      const s = 6 + this.rand() * Math.max(0, lane.len - 14);
      lanePoint(lane, s, tmp);
      const d = Math.hypot(tmp.x - player.x, tmp.z - player.z);
      if (d < 150 || d > this.spawnRadius) continue;
      if (Math.abs(tmp.y - player.y) > 60) continue;
      // (not on a road closed today, nor in or just before a work zone)
      if (this.roadEvents?.blocked(lane, s)) continue;
      // not right in front of the player's nose
      const fx = -Math.sin(player.yaw);
      const fz = -Math.cos(player.yaw);
      const ahead = ((tmp.x - player.x) * fx + (tmp.z - player.z) * fz) / d;
      if (ahead > 0.82 && d < 260) continue;
      // free space on the lane
      const others = this.onLane.get(lane.id);
      if (others && others.some((o) => Math.abs(o.s - s) < 14)) continue;
      // now and then a city bus – on a street through the town, where stops are, or on the way of a line
      const lineHere = this.lines !== null && this.lines.has(wayOf(lane));
      const bus =
        (this.busStops !== null || lineHere) &&
        this.rand() < this.busShare &&
        (lineHere || (lane.edge.cls >= CLS.PRIMARY && lane.edge.cls <= CLS.RESIDENTIAL)) &&
        lane.len > 30 &&
        !this.cars.some((o) => o.bus && Math.hypot(o.x - tmp.x, o.z - tmp.z) < 250) &&
        !(others && others.some((o) => Math.abs(o.s - s) < 22));
      let at = lane;
      let line: BusOnLine | null = null;
      if (bus && lineHere) {
        // one of the lines that run here – on the lane of the road from which it can follow its way
        line = this.pickLine(lane);
        if (line) {
          at = this.laneFor(lane, line);
          const there = this.onLane.get(at.id);
          if (at !== lane && there && there.some((o) => Math.abs(o.s - s) < 22)) continue;
        }
      }
      // (where only lines of the timetables run, no bus by chance: a car)
      this.addCar(at, s, bus && (line !== null || !lineHere || !this.busSchedule), line);
      return;
    }
  }

  /**
   * Put a car of the traffic on a lane, its middle `s` metres along it – a
   * city bus if `bus`, running `line` (undefined: one of the lines that run
   * there, if any; null: none).  The traffic fills itself around the player;
   * this is for putting one at a certain place.
   */
  addCar(lane: Lane, s: number, bus = false, line?: BusOnLine | null): TrafficCar {
    const on = bus ? (line === undefined ? this.pickLine(lane) : line) : null;
    lanePoint(lane, s, tmp);
    const style = bus ? BUS_STYLE : Math.floor(this.rand() * 3);
    const car: TrafficCar = {
      id: this.nextId++,
      lane,
      conn: null,
      s,
      v: Math.min(lane.limit, 13) * 0.8,
      a: 0,
      // (a bus on a line chooses below, once it exists: it may have to move over to another lane first)
      next: on ? null : this.chooseNext(lane),
      length: bus ? 12 : style === 1 ? 4.55 : 4.25,
      width: bus ? 2.55 : 1.8,
      color: COLORS[Math.floor(this.rand() * COLORS.length)],
      style,
      ...(bus ? { bus: { dwell: 0, served: -1, doors: false, pullOut: 0, line: on, free: 0 } } : {}),
      temper: 0.88 + this.rand() * 0.14,
      x: tmp.x,
      y: tmp.y,
      z: tmp.z,
      yaw: Math.atan2(-tmp.tx, -tmp.tz),
      pitch: 0,
      blinker: 0,
      braking: false,
      waited: 0,
      yieldWait: 0,
      stoppedAtLine: false,
      stuck: 0,
      blockedByPlayer: 0,
      playerFirstGap: Infinity,
      playerSeen: 0,
      crashed: 0,
      wheelSpin: 0,
    };
    if (on) car.next = this.nextFor(on, lane, car);
    this.cars.push(car);
    this.attach(car);
    return car;
  }

  // --- the lines of the city buses ----------------------------------------------------

  /** The lines of the city buses, as setBusLines was given them. */
  get busLines(): BusLines | null {
    return this.lines;
  }

  /**
   * The lines of the city buses (src/world/buslines.ts – null: none).  A bus
   * that appears where lines run gets one of them: it follows the line's way
   * at the junctions, calls at the line's stops and, at the end of its
   * route, goes on as the line back where that begins there.  The buses
   * already under way are given lines anew.
   */
  setBusLines(lines: BusLines | null): void {
    this.lines = lines;
    for (const car of this.cars) {
      if (!car.bus) continue;
      car.bus.line = null;
      car.bus.free = 0;
      car.merge = null;
      car.detour = null;
      if (!car.lane) continue;
      car.bus.line = this.pickLine(car.lane);
      if (car.bus.line) car.next = this.nextFor(car.bus.line, car.lane, car);
    }
  }

  private static onLine(line: BusLine, k: number): BusOnLine {
    return { ref: line.ref, to: line.to, index: line.index, k, off: 0 };
  }

  /** A line for a bus on `lane`: one of those whose route runs along it, by chance (`prefer`: one of that number, if one runs here) – null if none does. */
  private pickLine(lane: Lane, prefer = ''): BusOnLine | null {
    if (!this.lines) return null;
    // (not on the way round from the end of a route to the line back: there it shows where it came from)
    // (nor on a line of the timetables: its buses come by them – busSchedule)
    const here = this.lines.at(wayOf(lane)).filter(({ line, k }) => k < line.end && !this.busSchedule?.timed(line.index));
    if (here.length === 0) return null;
    const pick = (prefer ? here.find((h) => h.line.ref === prefer) : undefined) ?? here[Math.floor(this.rand() * here.length)];
    return Traffic.onLine(pick.line, pick.k);
  }

  private readonly aheadWays: number[] = [];

  /** The next `n` ways of a bus's line after the one it is on – on into the line back at its end (fewer where its line ends). */
  private ahead(on: BusOnLine, n: number): readonly number[] {
    const out = this.aheadWays;
    out.length = 0;
    if (!this.lines) return out;
    let line = this.lines.lines[on.index];
    let k = on.k + 1;
    let last = line.ways[on.k];
    for (let hops = 0; out.length < n; ) {
      if (k < line.ways.length) {
        last = line.ways[k++];
        out.push(last);
        continue;
      }
      const back = line.back;
      if (!back || ++hops > 2) break;
      line = back;
      // (the line back may begin on the very road this one ends on)
      k = back.ways[0] === last ? 1 : 0;
    }
    return out;
  }

  /** Can a vehicle on `lane` follow the ways ws[i], ws[i + 1], … through the next `depth` junctions?  (Beyond what is loaded it is taken that it can.) */
  private reaches(lane: Lane, ws: readonly number[], i: number, depth: number): boolean {
    if (depth === 0 || i >= ws.length || lane.out.length === 0) return true;
    for (const c of lane.out) if (wayOf(c.to) === ws[i] && this.reaches(c.to, ws, i + 1, depth - 1)) return true;
    return false;
  }

  /** Of the lanes of `lane`'s road in its direction, the one from which a bus can follow its line on – the right-most such. */
  private laneFor(lane: Lane, on: BusOnLine): Lane {
    const el = this.graph.edgeLanes[lane.edge.id];
    const list = lane.dir > 0 ? el.fwd : el.back;
    if (list.length < 2) return lane;
    const ahead = [...this.ahead(on, 4)];
    for (const l of list) if (this.reaches(l, ahead, 0, 3)) return l;
    return list[0];
  }

  /**
   * The connector to take at the end of `lane`: for a bus on a line the one
   * into its line's next way – into the lane from which it can go on along
   * it, the right-most such –, for every other car one at random.  Where the
   * bus's lane does not lead there but another lane of the road does, it is
   * to move over (`car.merge`, no connector yet); where none does, it loses
   * its way (`off`).
   */
  private nextFor(on: BusOnLine | null | undefined, lane: Lane, car?: TrafficCar): Connector | null {
    // (an emergency vehicle on its call takes its own way: src/sim/emergency.ts)
    const way = car?.em?.route;
    if (way && way.length > 0 && way[0].from === lane) return way.shift() as Connector;
    if (!on || !this.lines || lane.out.length === 0) return this.chooseNext(lane);
    if (on.off === 0) {
      const ahead = this.ahead(on, 4);
      // (its line ends here, and none goes on from here)
      if (ahead.length === 0) return this.chooseNext(lane);
      let best: Connector | null = null;
      let bestScore = -Infinity;
      for (const c of lane.out) {
        if (wayOf(c.to) !== ahead[0]) continue;
        const score = (this.reaches(c.to, ahead, 1, 3) ? 100 : 0) - c.to.idx;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (best) return best;
      const other = car ? this.laneTowards(lane, ahead) : null;
      if (car && other) {
        car.merge = other;
        return null;
      }
      on.off = 1;
    }
    // lost: along the shortest way back onto its line, where there is one
    if (car) {
      if (car.detour && car.detour.length > 0 && car.detour[0].from !== lane) car.detour = null;
      car.detour ??= this.wayBack(lane, on) ?? [];
      const c = car.detour.shift();
      if (c) return c;
    }
    return this.chooseNext(lane);
  }

  /**
   * A bus that has lost its line's way (a turn the map forbids, a lane it
   * could not leave): the shortest drive back onto it – into one of its next
   * ways, over the roads that are loaded, within 2.5 km – as the connectors
   * to take, the first from `lane`.  Null if there is none.
   */
  private wayBack(lane: Lane, on: BusOnLine): Connector[] | null {
    const lines = this.lines;
    if (!lines) return null;
    const line = lines.lines[on.index];
    const goal = new Set<number>();
    for (let j = on.k + 1; j < Math.min(line.ways.length, on.k + 13); j++) goal.add(line.ways[j]);
    if (line.back && on.k >= line.ways.length - 3) for (let j = 0; j < Math.min(line.back.ways.length, 6); j++) goal.add(line.back.ways[j]);
    goal.delete(wayOf(lane));
    if (goal.size === 0) return null;
    const dist = new Map<number, number>([[lane.id, 0]]);
    const prev = new Map<number, Connector>();
    const heap = new MinHeap(64);
    heap.push(lane.id, 0);
    let found: Lane | null = null;
    for (let pops = 0; heap.size > 0 && pops < 6000; pops++) {
      const d = heap.topKey;
      const l = this.graph.lanes[heap.pop()];
      if (!l || d > (dist.get(l.id) ?? Infinity)) continue;
      if (l !== lane && goal.has(wayOf(l))) {
        found = l;
        break;
      }
      for (const c of l.out) {
        const t = c.to;
        // (not through private roads – unless they are its line's own, a turning loop for buses)
        if (!LaneGraph.drivable(t.edge, false) && !goal.has(wayOf(t))) continue;
        const nd = d + c.len + t.len + (c.turn === TURN.UTURN ? 80 : 0);
        if (nd > 2500 || nd >= (dist.get(t.id) ?? Infinity)) continue;
        dist.set(t.id, nd);
        prev.set(t.id, c);
        heap.push(t.id, nd);
      }
    }
    if (!found) return null;
    const path: Connector[] = [];
    for (let l = found; l !== lane; ) {
      const c = prev.get(l.id) as Connector;
      path.push(c);
      l = c.from;
    }
    return path.reverse();
  }

  /** Another lane of `lane`'s road in its direction from which the ways `ahead` can be followed – the nearest such (null: none). */
  private laneTowards(lane: Lane, ahead: readonly number[]): Lane | null {
    const el = this.graph.edgeLanes[lane.edge.id];
    const list = lane.dir > 0 ? el.fwd : el.back;
    let best: Lane | null = null;
    let bestScore = -Infinity;
    for (const l of list) {
      if (l === lane || !l.out.some((c) => wayOf(c.to) === ahead[0])) continue;
      const score = (this.reaches(l, ahead, 0, 3) ? 100 : 0) - Math.abs(l.idx - lane.idx);
      if (score > bestScore) {
        bestScore = score;
        best = l;
      }
    }
    return best;
  }

  /**
   * A car that is to move over to another lane of its road (`car.merge`)
   * does so when there is room there beside and behind it – it waits for
   * that before the stop line.  One that finds none for a long while gives
   * up: a bus then loses its line's way.  (`listed`: the car is in the lists
   * of the cars on each lane – not while it is being moved along.)
   */
  private moveOver(car: TrafficCar, listed = true): void {
    const to = car.merge;
    const lane = car.lane;
    if (!to || !lane || to.edge !== lane.edge || to.dir !== lane.dir) {
      car.merge = null;
      return;
    }
    if (car.s >= lane.len || !this.roomOn(to, car.s, car.v, car.length)) {
      if (car.stuck > 20) {
        car.merge = null;
        if (car.bus?.line) car.bus.line.off = 1;
        car.next = this.nextFor(car.bus?.line, lane, car);
      }
      return;
    }
    if (listed) this.detach(car);
    // (drawn where it was, it slides across: to the left of its new lane by the distance between the two)
    car.slide = (car.slide ?? 0) + (lane.off - to.off) * lane.dir;
    car.lane = to;
    car.merge = null;
    if (listed) this.attach(car);
    car.next = this.nextFor(car.bus?.line, to, car);
  }

  /**
   * A bus has come onto `lane`: where is that on its line?  Further along
   * its way – or, at the end of its route, at the beginning of the line
   * back, which it then runs; a bus whose line has ended, and one that never
   * had one, takes one that runs here after a few roads.
   */
  private busOnLane(car: TrafficCar, lane: Lane): void {
    const bus = car.bus;
    const lines = this.lines;
    if (!bus || !lines) return;
    const w = wayOf(lane);
    const on = bus.line;
    if (!on) {
      bus.free = (bus.free ?? 0) + 1;
      if (bus.free > 2 && !bus.retired) {
        bus.line = this.pickLine(lane);
        if (bus.line) bus.served = -1;
      }
      return;
    }
    const line = lines.lines[on.index];
    // (a few ways ahead: where the bus went round something; further once it has lost its way)
    const reach = on.off > 0 ? 60 : 6;
    for (let j = on.k + 1; j < Math.min(line.ways.length, on.k + 1 + reach); j++) {
      if (line.ways[j] !== w) continue;
      on.k = j;
      on.off = 0;
      car.detour = null;
      return;
    }
    const back = line.back;
    if (back && on.k >= line.ways.length - 2) {
      for (let j = 0; j < Math.min(back.ways.length, 6); j++) {
        if (back.ways[j] !== w) continue;
        // the line back: its own number and destination, and its stops anew (a bus of the timetables has ended its trip: it goes)
        if (bus.trip || bus.retired) {
          this.retireBus(car);
          return;
        }
        bus.line = Traffic.onLine(back, j);
        bus.served = -1;
        car.detour = null;
        return;
      }
    }
    if (on.off === 0 && on.k >= line.ways.length - 1) {
      // the end of its line, and none goes on from here: on without a line
      bus.line = null;
      bus.free = 0;
      if (bus.trip) this.retireBus(car);
      return;
    }
    // off its way: on along the way back if it has one (looked for anew now and then), else it gives up after a while
    on.off++;
    if (on.off % 4 === 0 && !car.detour?.length) car.detour = null;
    if (on.off > (car.detour?.length ? 40 : 12)) {
      bus.line = null;
      bus.free = 0;
      car.detour = null;
      if (bus.trip) this.retireBus(car);
    }
  }

  /** A bus of the timetables at the end of its trip (or off its way for good): it calls nowhere any more, and goes once the player is not close by. */
  private retireBus(car: TrafficCar): void {
    if (!car.bus) return;
    car.bus.retired = true;
    car.bus.line = null;
    car.detour = null;
  }

  private readonly stopList: BusStopOnLane[] = [];
  private readonly nearStops: BusLineStop[] = [];

  /**
   * The next stop a bus is to call at, within 70 m: on its lane (`here`) –
   * or just beyond the junction ahead, where it has to begin braking on this
   * side (a stop a few metres into a short road would come too late) – how
   * far its front is from where it is to stand, and the pole.
   */
  private stopAhead(car: TrafficCar, lane: Lane | null, conn: Connector | null): { d: number; id: number; here: boolean } | null {
    const bus = car.bus;
    if (!bus || bus.retired) return null;
    // (a bus on a line calls once at a stop place, at whichever of its poles)
    const skip = (id: number): boolean => (bus.line ? stopPlaceOf(id) === stopPlaceOf(bus.served) : id === bus.served);
    const front = car.s + car.length / 2;
    if (lane) {
      for (const st of this.stopsFor(lane, bus.line)) {
        if (skip(st.id)) continue;
        const d = st.s - front;
        if (d < -1.5 || d > 70) continue;
        return { d, id: st.id, here: true };
      }
    }
    const via = lane ? car.next : conn;
    if (!via) return null;
    const rest = lane ? lane.len - front + via.len : via.len - front;
    if (rest > 70) return null;
    for (const st of this.stopsFor(via.to, bus.line, bus.line ? bus.line.k + 1 : 0)) {
      if (skip(st.id)) continue;
      return rest + st.s <= 70 ? { d: rest + st.s, id: st.id, here: false } : null;
    }
    return null;
  }

  /**
   * The stops a bus calls at along `lane`: without a line every pole the map
   * has there; on a line only those of its stops – at their poles where the
   * map has them on this lane, else where the line says (`k`: the line's way
   * the lane belongs to).  A bus that has lost its way calls nowhere until it
   * has found it again.
   */
  private stopsFor(lane: Lane, on: BusOnLine | null | undefined, k = on?.k ?? 0): readonly BusStopOnLane[] {
    if (!on || !this.lines) return this.busStops?.(lane) ?? [];
    const out = this.stopList;
    out.length = 0;
    if (on.off > 0) return out;
    const line = this.lines.lines[on.index];
    // (the build puts each stop on one road; its pole may stand just beyond the junction, on the road before or after)
    const near = this.lines.stopsOn(line, k - 1, k + 1, this.nearStops);
    if (near.length === 0) return out;
    for (const p of this.busStops?.(lane) ?? []) if (near.some((st) => st.place === stopPlaceOf(p.id))) out.push(p);
    for (const st of near) {
      if (st.k !== k || out.some((p) => stopPlaceOf(p.id) === st.place)) continue;
      // the front door at the stop: the front of the bus a metre and a half beyond it, and the whole bus past the junction
      const e = lane.edge;
      const along = ((lane.dir > 0 ? st.m : e.len - st.m) - lane.s0) * lane.dir + 1.5;
      out.push({ s: clamp(along, Math.min(12, lane.len - 0.5), lane.len - 0.5), id: st.place * 64 + 63 });
    }
    out.sort((a, b) => a.s - b.s);
    return out;
  }

  /** Take a car out of the traffic (a bus of the timetables put where its trip is anew). */
  removeCar(car: TrafficCar): void {
    this.remove(car);
  }

  private remove(car: TrafficCar): void {
    this.detach(car);
    const i = this.cars.indexOf(car);
    if (i >= 0) this.cars.splice(i, 1);
  }

  clear(): void {
    this.cyclists.clear();
    this.wild?.clear();
    this.cars.length = 0;
    this.busSchedule?.reset();
    this.crowd.clear();
    this.onLane.clear();
    this.onConn.clear();
  }

  // --- for a vehicle that drives itself without being one of the traffic's cars ------
  // (the player's car on a demonstration drive: it sees what the others see)
  private readonly probe: TrafficCar = {
    id: Number.MAX_SAFE_INTEGER, lane: null, conn: null, s: 0, v: 0, a: 0, next: null, length: 4.3, width: 1.8, color: 0, style: 0, temper: 1,
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, blinker: 0, braking: false, waited: 0, yieldWait: 0, stoppedAtLine: false, stuck: 0, blockedByPlayer: 0, playerFirstGap: Infinity, playerSeen: 0, crashed: 0, wheelSpin: 0,
  };
  private static readonly NOBODY: PlayerState = { x: 1e9, y: 1e9, z: 1e9, yaw: 0, speed: 0, length: 0, width: 0 };

  private aim(me: SelfDriving): TrafficCar {
    const p = this.probe;
    p.lane = me.conn ? null : me.lane;
    p.conn = me.conn;
    p.s = me.s;
    p.v = me.v;
    p.next = me.next;
    p.length = me.length;
    p.width = me.width;
    p.x = me.x;
    p.y = me.y;
    p.z = me.z;
    p.yaw = me.yaw;
    p.past = me.past ?? undefined;
    return p;
  }

  /**
   * For a vehicle that drives itself (the player's autopilot): one step of
   * going round something that stands in its way – as the traffic's cars do
   * (src/sim/pastblock.ts).  `gap`: to what is ahead; `held`: it stands for
   * a reason of the road.  Leaves the state in `me.past`.
   */
  passBy(me: SelfDriving, dt: number, gap: number, held: boolean): void {
    const p = this.aim(me);
    this.pastBlocks.look(p, dt, gap, held, null, true);
    this.pastBlocks.slide(p, me.v * dt, dt);
    me.past = p.past ?? null;
  }

  /**
   * The nearest vehicle ahead on the path of `me` – a car of the traffic, or
   * a tram or train in its way: the gap to it (m) and its speed along the
   * path; gap = Infinity if there is none within `horizon`.
   */
  aheadOf(me: SelfDriving, horizon: number): { gap: number; v: number; loose: boolean } {
    const p = this.aim(me);
    // (going round something: what is in the way there, by where it is)
    const round = p.past && p.past.phase !== 'wait' ? this.pastBlocks.lead(p, horizon) : null;
    const lead = (round ? { gap: round.gap, v: round.v } : this.leader(p, horizon)) as { gap: number; v: number; loose: boolean };
    lead.loose = false;
    for (const o of this.blocks) {
      if (Math.abs(o.x - p.x) > horizon + 30 || Math.abs(o.z - p.z) > horizon + 30) continue;
      const gap = this.playerAhead(p, o, horizon);
      if (gap >= lead.gap) continue;
      const along = -Math.sin(o.yaw) * -Math.sin(p.yaw) + -Math.cos(o.yaw) * -Math.cos(p.yaw);
      lead.gap = gap;
      lead.v = Math.max(0, o.speed * along);
    }
    // Whoever stands or drives in the way without being "ahead on the lane": a car coming the
    // other way on the wrong side of a narrow street, one crossing, one standing half in the road.
    // (`loose`: found by where it is, not by the order of the cars on the lanes.)
    const near = Math.min(horizon, 8 + p.v * 2.2);
    const box = this.box;
    const route = me.route;
    const onward = route ? (l: Lane): Connector | undefined => route.find((c) => c.from === l) : undefined;
    for (const o of this.cars) {
      if (Math.abs(o.x - p.x) > near + 8 || Math.abs(o.z - p.z) > near + 8) continue;
      box.x = o.x;
      box.y = o.y;
      box.z = o.z;
      box.yaw = o.yaw;
      box.speed = o.v;
      box.length = o.length;
      box.width = o.width;
      const gap = this.playerAhead(p, box, near, onward);
      if (gap >= lead.gap - 0.5) continue;
      const along = -Math.sin(o.yaw) * -Math.sin(p.yaw) + -Math.cos(o.yaw) * -Math.cos(p.yaw);
      lead.gap = gap;
      lead.v = Math.max(0, o.v * along);
      lead.loose = true;
    }
    return lead;
  }

  private readonly box: PlayerState = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, length: 4.3, width: 1.8 };

  /**
   * Walk along the way of a vehicle – its lane or connector, then the next
   * connector, then on (as `onward` says, or straight) – and call `visit`
   * every `step` metres with the point, the direction of travel there and
   * the distance from the start.  Ends after `reach` metres, at the end of
   * the way, or when `visit` returns true.
   */
  private walk(
    lane0: Lane | null,
    conn0: Connector | null,
    s0: number,
    next0: Connector | null,
    onward: ((lane: Lane) => Connector | undefined) | undefined,
    step: number,
    reach: number,
    visit: (x: number, z: number, tx: number, tz: number, dist: number) => boolean,
  ): void {
    let lane = lane0;
    let conn = conn0;
    let next = next0;
    let at = s0;
    for (let dist = step; dist <= reach; dist += step) {
      at += step;
      if (conn) {
        if (at > conn.len) {
          at -= conn.len;
          lane = conn.to;
          conn = null;
          next = null;
        }
      } else if (lane && at > lane.len) {
        const nx: Connector | undefined = next ?? onward?.(lane) ?? lane.out.find((q) => q.turn === TURN.STRAIGHT) ?? lane.out[0];
        if (!nx) return;
        at -= lane.len;
        conn = nx;
        lane = null;
      }
      if (conn) samplePolyline(conn.pl, at, tmp2);
      else if (lane) lanePoint(lane, at, tmp2);
      else return;
      if (visit(tmp2.x, tmp2.z, tmp2.tx, tmp2.tz, dist)) return;
    }
  }

  private readonly way: number[] = [];

  /**
   * For a vehicle that is about to cross the way of others – turning left, or
   * on its way through a junction made of several: how far along its way (m,
   * from its middle) the nearest place lies where a car that is under way now
   * will cross at about the time it gets there itself, or Infinity.
   * Cars that stand, crawl or are braking to a stop do not count: those are
   * waiting for their turn.
   */
  crossingAhead(me: SelfDriving, reach: number): number {
    const p = this.aim(me);
    const route = me.route;
    const onward = route ? (l: Lane): Connector | undefined => route.find((c) => c.from === l) : undefined;
    const way = this.way;
    way.length = 0;
    this.walk(p.lane, p.conn, p.s, p.next, onward, 1.5, reach, (x, z, tx, tz, dist) => {
      way.push(x, z, tx, tz, dist);
      return false;
    });
    if (way.length === 0) return Infinity;
    const vMe = Math.max(p.v, 2.5);
    let best = Infinity;
    for (const o of this.cars) {
      if (o.v < 2.5 || o.a < -0.8) continue;
      const dx = o.x - p.x;
      const dz = o.z - p.z;
      if (dx * dx + dz * dz > 85 * 85) continue;
      this.walk(o.lane, o.conn, o.s, o.next, undefined, 2, Math.min(75, o.v * 4.5), (qx, qz, qtx, qtz, qd) => {
        const tq = qd / o.v;
        for (let i = 0; i < way.length; i += 5) {
          const d = way[i + 4];
          if (d >= best) break;
          const ex = way[i] - qx;
          const ez = way[i + 1] - qz;
          if (ex * ex + ez * ez > 2.3 * 2.3) continue;
          // going the same way (ahead of us, or beside us on its own lane) is no crossing
          if (way[i + 2] * qtx + way[i + 3] * qtz > 0.8) continue;
          if (Math.abs(tq - d / vMe) > 2.8) continue;
          best = d;
          return true;
        }
        return false;
      });
    }
    return best;
  }

  /**
   * May `me` drive into the junction through `c` – is the way free of
   * traffic it has to give way to, and of cars standing or crossing in it?
   * `impatient`: after a long wait a tighter (still safe) gap is taken.
   */
  mayPass(me: SelfDriving, c: Connector, distToLine: number, impatient = false): boolean {
    const p = this.aim(me);
    if (this.boxBlocked(c)) return false;
    // a learner's gap: two seconds more than the traffic's own cars take
    return this.mayEnter(p, c, distToLine, Traffic.NOBODY, impatient, 2);
  }

  /**
   * Is there room on `lane` beside and behind a vehicle whose middle is `s`
   * metres along it (the lanes of a carriageway are measured alike) and that
   * drives at `v` – may it move over without making anybody brake?
   */
  roomOn(lane: Lane, s: number, v: number, length: number): boolean {
    const list = this.onLane.get(lane.id);
    if (!list) return true;
    for (const o of list) {
      const d = o.s - s; // + = ahead of us
      if (d >= 0) {
        if (d < length + 4 + Math.max(0, v - o.v) * 1.5) return false;
      } else if (-d < length + 6 + Math.max(0, o.v - v) * 3.5) return false;
    }
    return true;
  }

  /**
   * Is there room at the beginning of `lane` for a vehicle that needs `need`
   * metres – or does the traffic stand there, so that whoever drove into the
   * junction before it would have to wait in it?  Cars that are moving make
   * room; those still in the junction on their way into the lane will need it.
   */
  roomBehind(lane: Lane, need: number): boolean {
    // (a lane shorter than the vehicle is no place to wait in anyway: it leads on)
    if (lane.len < need) return true;
    let free = lane.len;
    let standing = false;
    for (const o of this.onLane.get(lane.id) ?? []) {
      if (o.v > 2.5) continue;
      standing = true;
      free = Math.min(free, o.s - o.length / 2);
    }
    if (!standing) return true;
    for (const c of lane.in) for (const o of this.onConn.get(c.id) ?? []) free -= o.length + 2;
    return free >= need;
  }

  /** Is nobody inside the junction on a path that meets `c`? */
  clearOf(c: Connector): boolean {
    return this.junctionEmpty(c);
  }

  /** A pedestrian who is crossing at `c` or stands there waiting to. */
  crossingAt(c: CrossingJson): Pedestrian | null {
    for (const p of this.peds) if (p.crossing === c && p.state !== 'gone' && (p.state === 'cross' || p.waited > 0.3)) return p;
    return null;
  }

  // --- perception ----------------------------------------------------------------
  /** Gap (bumper to bumper) and speed of the nearest car ahead on the planned path. */
  private leader(car: TrafficCar, horizon: number): { gap: number; v: number } {
    let best = Infinity;
    let bestV = 0;
    const scan = (list: TrafficCar[] | undefined, offset: number): void => {
      if (!list) return;
      for (const o of list) {
        if (o === car) continue;
        const d = offset + o.s;
        if (d > 0 && d < best) {
          best = d - o.length / 2 - car.length / 2;
          bestV = o.v;
          if (best < 0) best = 0;
        }
      }
    };
    let offset = -car.s;
    let lane = car.lane;
    let conn = car.conn;
    let next = car.next;
    // cars that left our lane on another connector still share the first metres with us
    const siblings = (c: Connector, off: number, behindS: number): void => {
      for (const sib of c.siblings) {
        const l2 = this.onConn.get(sib.other.id);
        if (l2) for (const o of l2) if (o !== car && o.s - o.length / 2 < sib.untilOther && o.s > behindS) scan([o], off);
      }
    };
    // Cars on other connectors into the same lane: whoever is nearer to the
    // end of its connector is "ahead"; side by side, the one that has to give
    // way (or, failing that, the higher id) drops back.
    // `off` = distance from our car to the start of connector c (negative once we are on it)
    const merging = (c: Connector, off: number): void => {
      for (const k of c.conflicts) {
        if (!k.merge) continue;
        const other = k.other;
        const tie = (o: TrafficCar): void => {
          const iYield = k.yield || (!other.conflicts.find((q) => q.other === c)?.yield && car.id > o.id);
          if (iYield && best > 0.3) {
            best = 0.3;
            bestV = Math.min(o.v, car.v) * 0.5;
          }
        };
        // already on the other connector: compare progress relative to where the paths meet
        const l2 = this.onConn.get(other.id);
        if (l2) {
          for (const o of l2) {
            const d = off + k.sSelf + (o.s - k.sOther);
            if (d > 0.6) scan([o], off + k.sSelf - k.sOther);
            else if (d > -0.6) tie(o);
          }
        }
        // still on the neighbouring lane of the same carriageway (zip merging)
        if (other.from.armTo === c.from.armTo) {
          const l3 = this.onLane.get(other.from.id);
          if (l3) {
            for (const o of l3) {
              if (o.next !== other) continue;
              const ahead = off - (other.from.len - o.s);
              if (ahead > 0.8) {
                const gap = ahead - o.length / 2 - car.length / 2;
                if (gap < best) {
                  best = Math.max(0, gap);
                  bestV = o.v;
                }
              } else if (ahead > -0.8) tie(o);
            }
          }
        }
      }
    };
    for (let hop = 0; hop < 6 && offset < horizon; hop++) {
      if (conn) {
        scan(this.onConn.get(conn.id), offset);
        siblings(conn, offset, hop === 0 ? car.s : -1);
        merging(conn, offset);
        offset += conn.len;
        lane = conn.to;
        conn = null;
        next = null;
      } else if (lane) {
        scan(this.onLane.get(lane.id), offset);
        offset += lane.len;
        conn = next ?? (lane.out.length === 1 ? lane.out[0] : null);
        if (conn && hop === 0) merging(conn, offset);
        if (!conn) {
          // route beyond this lane not chosen yet: anything just past its end may be in our way
          for (const c of lane.out) {
            const l2 = this.onConn.get(c.id);
            if (l2) for (const o of l2) if (o.s < 14) scan([o], offset);
          }
          break;
        }
        lane = null;
      }
    }
    return { gap: best, v: bestV };
  }

  /** Distance along the car's path until it would touch the player's car, or Infinity. */
  private playerAhead(car: TrafficCar, player: PlayerState, horizon: number, onward?: (lane: Lane) => Connector | undefined): number {
    const dx = player.x - car.x;
    const dz = player.z - car.z;
    if (dx * dx + dz * dz > (horizon + 8) * (horizon + 8)) return Infinity;
    if (Math.abs(player.y - car.y) > 4) return Infinity;
    const c = Math.cos(player.yaw);
    const s = Math.sin(player.yaw);
    const hl = player.length / 2 + 0.3;
    const hw = player.width / 2 + car.width / 2 + 0.25;
    let dist = 0;
    let lane = car.lane;
    let conn = car.conn;
    let next = car.next;
    let at = car.s;
    const step = 1.5;
    // (a car off the middle of its lane – making way, or passing those that do: its way runs beside the lane's)
    const side0 = car.side ?? 0;
    // (… and one going round something: its way runs across to where it goes)
    const past = car.past && car.past.phase !== 'wait' ? car.past : null;
    for (let n = 0; n < 60 && dist < horizon; n++) {
      at += step;
      dist += step;
      if (conn) {
        if (at > conn.len) {
          at -= conn.len;
          lane = conn.to;
          conn = null;
          next = null;
        }
      } else if (lane && at > lane.len) {
        // undecided beyond this lane: assume straight on (unless the way is known: `onward`)
        const nx = next ?? onward?.(lane) ?? lane.out.find((q) => q.turn === TURN.STRAIGHT) ?? lane.out[0];
        if (!nx) return Infinity;
        at -= lane.len;
        conn = nx;
        lane = null;
      }
      if (conn) samplePolyline(conn.pl, at, tmp2);
      else if (lane) {
        lanePoint(lane, at, tmp2);
        // (where a side of the road is closed for roadworks, the way runs over the oncoming lane)
        this.roadEvents?.offset(lane, at, tmp2);
      } else return Infinity;
      const side = past ? side0 + offsetAt(past, dist) : side0;
      if (side !== 0) {
        tmp2.x += tmp2.tz * side;
        tmp2.z -= tmp2.tx * side;
      }
      // into the player's frame: forward = (-s, -c), right = (c, -s)
      const px = tmp2.x - player.x;
      const pz = tmp2.z - player.z;
      const lf = -px * s - pz * c;
      const lr = px * c - pz * s;
      // Passing the other's nose or tail crosswise takes half this car's width more than following
      // it does: `across` is how much the way runs across the other (0 = along it, 1 = at right angles).
      const along = -s * tmp2.tx - c * tmp2.tz;
      const across = Math.sqrt(Math.max(0, 1 - along * along));
      if (Math.abs(lf) < hl + across * (car.width / 2 + 0.2) && Math.abs(lr) < hw) return Math.max(0, dist - car.length / 2);
    }
    return Infinity;
  }

  /** Is the way through connector `c` free of traffic it has to give way to? */
  private mayEnter(car: TrafficCar, c: Connector, distToLine: number, player: PlayerState, impatient = false, caution = 0): boolean {
    // room behind the junction, so we never stop inside it
    const exit = this.onLane.get(c.to.id);
    if (exit) for (const o of exit) if (o.s < car.length + 3 && o.v < 1.5) return false;
    const tEnter = car.v > 1 ? distToLine / car.v : Math.sqrt((2 * Math.max(distToLine, 0.5)) / 1.5);
    for (const k of c.conflicts) {
      // vehicles already inside the junction on a crossing path: never drive into them
      const inside = this.onConn.get(k.other.id);
      if (inside) {
        for (const o of inside) {
          if (k.merge || o.s - o.length / 2 < k.sOther + 2.5) return false;
        }
      }
      if (!k.yield) continue;
      // (`caution`: seconds of gap on top – for a driver who is to make nobody brake)
      const myTime = tEnter + (k.sSelf + car.length) / Math.max(car.v, 3.5) + 1.2 + caution;
      // traffic approaching the conflicting movement – also from further upstream,
      // because the lane feeding it can be just a few metres long (roundabouts)
      const from = k.other.from;
      const zipper = from.armTo === c.from.armTo;
      const threat = (o: TrafficCar, d: number): boolean => {
        // lanes of one carriageway running together: only whoever is level or ahead goes first
        if (zipper) return d - k.sOther < distToLine + car.length + 1.5;
        const t = d / Math.max(o.v, 2.5);
        // after a long wait accept a tighter (but still safe) gap
        return impatient ? t < 2.6 + caution && d < 60 + caution * 12 : t < myTime + 1.5 && d < 110 + caution * 20;
      };
      const approaching = this.onLane.get(from.id);
      if (approaching) {
        for (const o of approaching) {
          if (o.next && o.next !== k.other) continue;
          if (threat(o, from.len - o.s + k.sOther)) return false;
        }
      }
      if (from.len < 70) {
        for (const cin of from.in) {
          const l1 = this.onConn.get(cin.id);
          if (l1) for (const o of l1) if (threat(o, cin.len - o.s + from.len + k.sOther)) return false;
          const up = cin.from;
          if (cin.len + from.len > 70) continue;
          const l2 = this.onLane.get(up.id);
          if (l2) for (const o of l2) if (o.next === cin && threat(o, up.len - o.s + cin.len + from.len + k.sOther)) return false;
        }
      }
      // the player on that lane or in the junction
      const pd = this.playerOnPath(player, k.other);
      if (pd !== null) {
        const d = pd;
        if (d < 0) continue; // already past the conflict point
        const t = d / Math.max(player.speed, 2);
        if (player.speed > 0.8 && t < myTime + 2 && d < 120) return false;
        if (d < 8) return false;
      }
    }
    return true;
  }

  /**
   * Distance of the player from the conflict region of connector `c`
   * (positive = still approaching), or null if the player is not on the lane
   * feeding it nor on the connector itself.
   */
  private playerOnPath(player: PlayerState, c: Connector): number | null {
    const from = c.from;
    const e = from.edge;
    const pad = 8;
    if (player.x < e.minX - pad || player.x > e.maxX + pad || player.z < e.minZ - pad || player.z > e.maxZ + pad) return null;
    if (Math.abs(player.y - c.node.y) > 8) return null;
    // on the connector?
    let best = Infinity;
    let bestS = 0;
    const n = c.pl.cum.length;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(c.pl.pts[i * 3] - player.x, c.pl.pts[i * 3 + 2] - player.z);
      if (d < best) {
        best = d;
        bestS = c.pl.cum[i];
      }
    }
    if (best < 2.2) return c.len * 0.5 - bestS;
    // on the feeding lane, heading for the junction?
    const steps = Math.min(40, Math.ceil(from.len / 3));
    for (let i = 0; i <= steps; i++) {
      const d = from.len - i * 3;
      if (d < 0) break;
      lanePoint(from, d, tmp2);
      if (Math.hypot(tmp2.x - player.x, tmp2.z - player.z) < 2.4) {
        const heading = -Math.sin(player.yaw) * tmp2.tx - Math.cos(player.yaw) * tmp2.tz;
        if (heading < 0.3) return null; // going the other way
        return i * 3 + c.len * 0.5;
      }
    }
    return null;
  }

  // --- main update -----------------------------------------------------------------
  update(dt: number, player: PlayerState): void {
    this.events.length = 0;
    this.narrowings.player = player;
    // the level crossings: what the trains near them make them show (src/sim/levelcrossing.ts)
    if (this.levelCrossings) {
      this.levelCrossings.player = player;
      this.levelCrossings.update(dt, player.x, player.z);
    }
    // the roadworks and closures of the day: who is in or before each zone – and their fences, barriers and crowds are in the way, too
    this.roadEvents?.step(dt, this.cars, player);
    const obstacles = this.roadEvents ? this.roadEvents.withBlocks(this.obstacles, player) : this.obstacles;
    // what is in the cars' way besides each other: what the game names, and the people on bicycles
    const blocks = this.blocks;
    blocks.length = 0;
    for (const o of obstacles) blocks.push(o);
    let n = 0;
    for (const c of this.cyclists.list) {
      const b = (this.cycleBoxes[n++] ??= { x: 0, y: 0, z: 0, yaw: 0, speed: 0, length: CYCLE_LENGTH, width: CYCLE_WIDTH });
      b.x = c.x;
      b.y = c.y;
      b.z = c.z;
      b.yaw = c.yaw;
      b.speed = c.v;
      blocks.push(b);
    }
    // … and the people on foot who are on the carriageway
    this.crowd.addBlocks(blocks);
    // … and the animals crossing the road
    if (this.wild) {
      this.wild.update(dt, player);
      for (const b of this.wild.boxes) blocks.push(b);
    }
    // … and the cars that go round something, off their lanes (src/sim/pastblock.ts)
    this.pastBlocks.boxes(this.cars, blocks);
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.cars.length < this.targetCount) {
      this.spawn(player);
      this.spawnTimer = 0.12;
    }
    // the buses of the timetables: where and when their trips are (src/game/timedtransit.ts)
    this.busSchedule?.step(dt, player);
    // emergency vehicles: their calls, and how the others make way for them (src/sim/emergency.ts)
    this.emergency?.update(dt, player);
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const car = this.cars[i];
      const d = Math.hypot(car.x - player.x, car.z - player.z);
      if (d > this.spawnRadius + 110 || car.stuck > 45 || (car.crashed > 0 && (car.crashed -= dt) <= 0 && d > 60) || (car.bus?.retired && car.bus.dwell <= 0 && d > 120)) {
        this.remove(car);
        continue;
      }
      this.drive(car, dt, player);
    }
    // the people on foot: along the pavements, over the streets (src/sim/pedestrians.ts)
    this.crowd.update(dt, player, this.cars, this.cyclists.list, obstacles, this.events);
    // people on bicycles: a few where there is traffic at all
    this.cyclists.target = this.targetCount > 0 ? Math.max(1, Math.min(4, Math.round(this.targetCount / 12))) : 0;
    this.cyclists.update(dt, player, obstacles, this.cars, this.events);
  }

  private drive(car: TrafficCar, dt: number, player: PlayerState): void {
    // over to another lane of its road, where there is room (a bus whose line turns where its lane does not lead)
    if (car.merge && !(car.bus && car.bus.dwell > 0)) this.moveOver(car);
    const lane = car.lane;
    const conn = car.conn;
    // a bus at its stop: the doors open, people get off and on – then the indicator, and off it goes
    const bus = car.bus;
    if (bus && bus.dwell > 0) {
      bus.dwell -= dt;
      car.v = 0;
      car.a = 0;
      car.braking = true;
      car.blinker = 0;
      if (bus.dwell <= 0) {
        bus.doors = false;
        bus.pullOut = 3.5;
      }
      return;
    }
    if (bus && bus.pullOut > 0) bus.pullOut -= dt;
    // roadworks and closures (src/sim/roadevents.ts): a site light, the oncoming traffic at a narrowing, a lane or a road closed ahead
    const works = this.roadEvents?.gateCar(car) ?? null;
    if (works?.move && !car.merge) car.merge = works.move;
    if (works?.reroute && lane) car.next = this.chooseNext(lane);
    // --- desired speed ---
    let limit = lane ? lane.limit : conn!.to.limit;
    if (!Number.isFinite(limit)) limit = 36; // Richtgeschwindigkeit 130 km/h
    let v0 = limit * car.temper;
    if (works && works.cap < v0) v0 = works.cap;
    // a kerb build-out narrowing the road: slowly through the gap, and the oncoming traffic first where it is on our side (src/sim/narrowings.ts)
    const narrow = lane ? this.narrowings.gate(lane, car.s + car.length / 2, car.v, car.length, car) : null;
    const narrowStop = narrow ? narrow.stop : Infinity;
    if (narrow && narrow.cap < v0) v0 = narrow.cap;
    // a level crossing ahead: its lights, its barriers, a train – and room behind the tracks (src/sim/levelcrossing.ts)
    const lx = lane && this.levelCrossings ? this.levelCrossings.gate(lane, car.s + car.length / 2, car.v, car.length, car.next, car) : null;
    if (lx && lx.cap < v0) v0 = lx.cap;
    if (lane && lane.edge.zone === 7) v0 = Math.min(v0, 2.2);
    if ((lane && lane.edge.flags & EF.ROUNDABOUT) || (conn && conn.node.ctrl === CTRL.ROUNDABOUT)) v0 = Math.min(v0, 7.2);
    if (conn) {
      // junction speed from the tightness of the turn
      const turnV = conn.turn === TURN.STRAIGHT ? 14 : conn.turn === TURN.UTURN ? 2.5 : clamp(Math.sqrt(1.9 * Math.max(conn.len, 4) * 0.7), 3, 9);
      v0 = Math.min(v0, turnV);
    }
    // an emergency vehicle on its call goes faster; whoever makes way for one slows down (src/sim/emergency.ts)
    if (this.emergency) v0 = this.emergency.desired(car, v0, limit);
    // going round something that blocks its lane: slowly (src/sim/pastblock.ts)
    const past = car.past && car.past.phase !== 'wait' ? car.past : null;
    if (past) v0 = Math.min(v0, past.cap);
    const A = 1.7;
    const B = 2.4;
    let acc = A * (1 - (car.v / Math.max(v0, 0.5)) ** 4);

    const brakeFor = (gap: number, vLead: number, s0: number): void => {
      const dv = car.v - vLead;
      const sStar = s0 + Math.max(0, car.v * 1.25 + (car.v * dv) / (2 * Math.sqrt(A * B)));
      const g = Math.max(gap, 0.1);
      acc = Math.min(acc, A * (1 - (car.v / Math.max(v0, 0.5)) ** 4 - (sStar / g) ** 2));
    };

    // --- car ahead ---
    // (an emergency vehicle on its call passes those that make way for it: it sees past them)
    // (one going round something sees what is in its way there by where it is)
    const lead = past ? this.pastBlocks.lead(car, 90) : car.em?.call && this.emergency ? this.emergency.lead(car) : this.leader(car, 90);
    if (lead.gap < Infinity) brakeFor(lead.gap, lead.v, 2.3);

    // --- the player's car ---
    const pGap = this.playerAhead(car, player, clamp(car.v * 3.5 + 12, 14, 80));
    let playerBrake = false;
    /** how hard the player's car alone makes this one brake (a light or a car ahead may ask for more) */
    let playerAcc = 0;
    if (pGap < Infinity) {
      const before = acc;
      // the component of the player's speed along our direction
      const along = -Math.sin(player.yaw) * -Math.sin(car.yaw) + -Math.cos(player.yaw) * -Math.cos(car.yaw);
      brakeFor(pGap, Math.max(0, player.speed * along), 2.6);
      playerBrake = acc < before - 0.3;
      playerAcc = acc;
      // how far away was it when it first got in the way?
      if (car.playerSeen <= 0) car.playerFirstGap = pGap / Math.max(car.v, 1);
      car.playerSeen = 1.5;
    } else if (car.playerSeen > 0) {
      car.playerSeen -= dt;
      if (car.playerSeen <= 0) car.playerFirstGap = Infinity;
    }

    // --- whatever else is on the road: trams and trains crossing or running in the street ---
    /** the nearest thing ahead that is not a car of the traffic */
    let thingGap = pGap;
    for (const o of this.blocks) {
      if (Math.abs(o.x - car.x) > 110 || Math.abs(o.z - car.z) > 110 || o === car.past?.box) continue;
      const gap = this.playerAhead(car, o, clamp(car.v * 3.5 + 12, 14, 80));
      if (gap === Infinity) continue;
      thingGap = Math.min(thingGap, gap);
      const along = -Math.sin(o.yaw) * -Math.sin(car.yaw) + -Math.cos(o.yaw) * -Math.cos(car.yaw);
      brakeFor(gap, Math.max(0, o.speed * along), 2.6);
    }

    // --- junction ahead ---
    let stopDist = Infinity;
    if (lane) {
      const next = car.next;
      const distToLine = lane.stopAt - car.s - car.length / 2;
      const node = lane.to;
      const arm = lane.armTo;
      // slow down for the turn before reaching it
      if (next && next.turn !== TURN.STRAIGHT) {
        const turnV = next.turn === TURN.UTURN ? 2.5 : clamp(Math.sqrt(1.9 * Math.max(next.len, 4) * 0.7), 3, 9);
        const d = Math.max(0, lane.len - car.s - car.length / 2);
        const need = (car.v * car.v - turnV * turnV) / (2 * Math.max(d, 1));
        if (need > 0.6) acc = Math.min(acc, -need);
        car.blinker = d < 45 ? (next.turn === TURN.RIGHT ? 1 : -1) : 0;
      } else if (next && node.ctrl === CTRL.ROUNDABOUT && lane.edge.flags & EF.ROUNDABOUT && !(next.to.edge.flags & EF.ROUNDABOUT)) {
        car.blinker = 1; // leaving the roundabout
      } else car.blinker = 0;

      let yieldingNow = false;
      if (next && (node.arms.length > 2 || next.conflicts.length > 0) && distToLine < 70) {
        let mustStop = false;
        let reason = 0;
        if (arm.sg >= 0 && node.sc >= 0) {
          const st = this.signals.get(node.sc, arm.sg);
          // the green arrow beside the light: whoever turns right may go while it is lit
          const arrow = next.turn === TURN.RIGHT ? this.signals.arrow(arm) : -1;
          if (arrow === SIG.GREEN) mustStop = false;
          else if (st === SIG.AMBER || arrow === SIG.AMBER) {
            // stop if that is comfortably possible
            const need = (car.v * car.v) / (2 * Math.max(distToLine, 0.5));
            mustStop = distToLine > 0 && need < 3.2;
          } else if (st === SIG.RED || st === SIG.RED_AMBER) mustStop = true;
          reason = 1;
        }
        if (!mustStop && distToLine > -1.5) {
          const role = arm.role;
          const needsStopSign = role === ROLE.STOP && !car.stoppedAtLine;
          const yielding = next.conflicts.some((k) => k.yield) || role === ROLE.MINOR || role === ROLE.YIELD || role === ROLE.STOP;
          if (needsStopSign) mustStop = true;
          else if (yielding || node.ctrl === CTRL.RBL) {
            // only decide close to the line; approach at a speed that still allows stopping
            if (distToLine < 28) {
              const ok = this.mayEnter(car, next, Math.max(distToLine, 0), player);
              if (!ok) {
                mustStop = true;
                yieldingNow = true;
                // stalemate (everybody waits for somebody): after a while creep through
                const patience = node.ctrl === CTRL.RBL ? 6 + (car.id % 5) : 10 + (car.id % 7);
                if (car.yieldWait > patience && this.junctionEmpty(next) && this.mayEnter(car, next, Math.max(distToLine, 0), player, true)) mustStop = false;
              }
            } else if (role !== ROLE.PRIORITY) {
              const vApproach = 7;
              if (car.v > vApproach) acc = Math.min(acc, -1.4);
            }
          }
        }
        // whoever has the right of way: never drive into a car that is crossing our path
        if (!mustStop && distToLine > -1.5 && distToLine < 32 && this.boxBlocked(next)) mustStop = true;
        // whoever turns right lets the cyclists beside and behind ride on first (§ 9 Abs. 3 StVO)
        if (!mustStop && next.turn === TURN.RIGHT && distToLine > -1.5 && distToLine < 20 && this.cyclists.blocksRightTurn(lane, car.s, car.length / 2)) mustStop = true;
        // … and lets the people on foot who cross the road it turns into go first (§ 9 Abs. 3 StVO)
        if (!mustStop && (next.turn === TURN.RIGHT || next.turn === TURN.LEFT) && distToLine > -1.5 && distToLine < 25 && this.peopleCrossing(next.to, player)) mustStop = true;
        // an emergency vehicle on its call: past red lights and the others' right of way – slowly, and only once the way is clear
        if (car.em?.call && this.emergency) {
          const care = this.emergency.through(car, next, distToLine, mustStop);
          mustStop = care < 0;
          if (care >= 0 && car.v > care) acc = Math.min(acc, (care - car.v) / 0.5);
        }
        if (mustStop && distToLine > -1.5) stopDist = Math.max(0, distToLine);
        void reason;
      }
      if (yieldingNow && car.v < 0.5) car.yieldWait += dt;
      else if (!yieldingNow) car.yieldWait = 0;
      // signalised or zebra crossings on this lane
      const xs = lane.edge.xings.length ? lane.edge.xings : undefined;
      if (xs) {
        for (const x of xs) {
          const pos = lane.dir > 0 ? x.s - lane.s0 : lane.s0 - x.s;
          const d = pos - x.w / 2 - 1.2 - car.s - car.length / 2;
          if (d < -2 || d > 60) continue;
          let stop = false;
          if (x.k === XING.SIGNAL && x.sc !== undefined) {
            const st = this.signals.get(x.sc, x.g ?? 0);
            stop = st === SIG.RED || st === SIG.RED_AMBER || (st === SIG.AMBER && (car.v * car.v) / (2 * Math.max(d, 0.5)) < 3.2 && d > 0);
          } else if (x.k === XING.ZEBRA) {
            for (const p of this.peds) if (p.crossing === x && p.state !== 'gone' && (p.state === 'cross' || p.waited > 0.3)) stop = true;
            // the player on foot: on the zebra, or at its kerb and about to step out (§ 26 Abs. 1 StVO)
            if (!stop && player.onFoot && this.atZebra(x, player)) stop = true;
          }
          if (stop) stopDist = Math.min(stopDist, Math.max(0, d));
        }
      }
      // not yet over on the lane it needs: it waits before the stop line for room there
      if (car.merge) stopDist = Math.min(stopDist, Math.max(0, lane.stopAt - car.s - car.length / 2 - 0.5));
    }
    if (conn) {
      // turning: wait in the junction while somebody crosses the road it turns into
      if ((conn.turn === TURN.RIGHT || conn.turn === TURN.LEFT) && this.peopleCrossing(conn.to, player)) stopDist = Math.min(stopDist, Math.max(0, conn.len - car.s - car.length / 2 - 1.8));
      for (const k of conn.conflicts) {
        const dSelf = k.sSelf - car.s - car.length / 2;
        if (dSelf < -1) continue; // already past the conflict point
        const inside = this.onConn.get(k.other.id);
        if (!inside) continue;
        for (const o of inside) {
          const dOther = k.sOther - o.s;
          if (dOther < -(o.length / 2 + 1.5)) continue; // it has cleared the point
          let wait: boolean;
          if (k.yield) wait = true;
          else {
            const back = k.other.conflicts.find((q) => q.other === conn);
            if (back && back.yield) wait = false;
            else {
              const tSelf = Math.max(dSelf, 0) / (car.v + 0.5);
              const tOther = Math.max(dOther - o.length / 2, 0) / (o.v + 0.5);
              wait = tSelf > tOther + 0.3 || (Math.abs(tSelf - tOther) <= 0.3 && car.id > o.id);
            }
          }
          if (wait) stopDist = Math.min(stopDist, Math.max(0, dSelf - (k.merge ? 1.0 : 3.0)));
        }
      }
    }
    // a bus: the next stop on its way – its front comes to stand at the pole (on a line: the next of the line's stops)
    if (bus && (this.busStops || bus.line)) {
      const st = this.stopAhead(car, lane, conn);
      // (its front at the pole – also where its middle is still in the junction before a short road)
      if (st && st.d < 1.2 && car.v < 0.4) {
        bus.served = st.id;
        bus.doors = true;
        bus.dwell = 10 + this.rand() * 10;
        // (a bus of the timetables: until its time – no longer than the doors take when it is late)
        if (bus.trip && this.busSchedule) bus.dwell = this.busSchedule.dwell(car, st.id, bus.dwell);
      } else if (st) {
        stopDist = Math.min(stopDist, Math.max(0, st.d));
        // (pulling in: the indicator to the right – once it is on the road of the stop, not while it turns into it)
        if (st.here && st.d < 45) car.blinker = 1;
      }
      if (bus.pullOut > 0) car.blinker = -1;
    }
    // making way for an emergency vehicle: stopping at the side, or before the junction it crosses (src/sim/emergency.ts)
    if (this.emergency) stopDist = Math.min(stopDist, this.emergency.stopFor(car));
    if (works && works.stop < stopDist) {
      stopDist = Math.max(0, works.stop);
      // (waiting at a site light or for the oncoming traffic is not being stuck: a red there may last a minute or two)
      if (works.why === 'light' || works.why === 'oncoming') car.stuck = 0;
    }
    if (narrowStop < stopDist) {
      stopDist = narrowStop;
      car.stuck = 0;
    }
    if (lx && lx.stop < stopDist) {
      stopDist = lx.stop;
      car.stuck = 0;
    }
    if (stopDist < Infinity) {
      brakeFor(stopDist + 0.4, 0, 0.6);
      if (stopDist < 1.2 && car.v < 0.4) {
        car.waited += dt;
        if (car.waited > 0.9) car.stoppedAtLine = true;
      }
    } else if (car.v > 1) car.waited = 0;

    // standing behind something that does not move: after a while, a way round it (src/sim/pastblock.ts)
    if (!car.bus?.dwell) this.pastBlocks.look(car, dt, Math.min(lead.gap, thingGap), stopDist < Math.min(lead.gap, thingGap) + 12 || works !== null || car.crashed > 0, player);
    if (car.crashed > 0) acc = -6;
    acc = clamp(acc, -7.5, A);
    // report hard braking caused by the player (the rule monitor decides who was at fault) –
    // not the braking for a red light of a car that happens to follow the player
    if (playerBrake && playerAcc < -2.6 && car.v > 2) {
      car.blockedByPlayer += dt;
      if (car.blockedByPlayer > 0.12) {
        this.events.push({ type: 'forcedBrake', car, decel: -acc, cutIn: car.playerFirstGap < 2.2 });
        car.blockedByPlayer = -3; // one report per incident
      }
    } else if (car.blockedByPlayer > 0) car.blockedByPlayer = 0;
    else if (car.blockedByPlayer < 0) car.blockedByPlayer = Math.min(0, car.blockedByPlayer + dt);

    car.a = acc;
    car.braking = acc < -0.5 || (car.v < 0.2 && stopDist < 3);
    car.v = Math.max(0, car.v + acc * dt);
    if (car.v < 0.05 && acc <= 0) car.v = 0;
    car.stuck = car.v < 0.1 ? car.stuck + dt : 0;
    const ds = car.v * dt;
    car.wheelSpin += ds / 0.31;
    if (car.past) this.pastBlocks.slide(car, ds, dt);

    // --- advance along the path ---
    this.detach(car);
    car.s += ds;
    for (let guard = 0; guard < 4; guard++) {
      if (car.conn) {
        if (car.s < car.conn.len) break;
        car.s -= car.conn.len;
        car.lane = car.conn.to;
        car.lastConn = car.conn;
        car.conn = null;
        if (car.bus) this.busOnLane(car, car.lane);
        car.next = this.nextFor(car.bus?.line, car.lane, car);
        // (over at once where it can: a lane between two junctions may be a metre long)
        if (car.merge) this.moveOver(car, false);
        car.stoppedAtLine = false;
        car.waited = 0;
        car.yieldWait = 0;
      } else if (car.lane) {
        if (car.s < car.lane.len) break;
        if (car.merge) {
          // (too late to move over: on where its lane leads – a bus loses its line's way, and looks for the way back)
          car.merge = null;
          if (car.bus?.line) car.bus.line.off = 1;
        }
        let next = car.next ?? this.nextFor(car.bus?.line, car.lane, car);
        if (!next && car.merge) {
          // (no moving over at the very end of the lane, either)
          car.merge = null;
          if (car.bus?.line) car.bus.line.off = 1;
          next = this.nextFor(car.bus?.line, car.lane, car);
        }
        if (!next) {
          // dead end of the map: leave the simulation
          car.s = car.lane.len;
          car.stuck = 100;
          break;
        }
        car.s -= car.lane.len;
        car.conn = next;
        car.lane = null;
      }
    }
    this.attach(car);

    // --- pose ---
    if (car.conn) {
      samplePolyline(car.conn.pl, car.s, tmp);
    } else {
      lanePoint(car.lane!, car.s, tmp);
      tmp.y = this.world.edgeY(car.lane!.edge, car.lane!.s0 + car.lane!.dir * car.s, tmp.x, tmp.z);
    }
    const tangent = Math.atan2(-tmp.tx, -tmp.tz);
    let yaw = tangent;
    if (car.slide) {
      // just moved over to another lane: it slides across from where it was, turned a little towards it
      car.slide -= Math.sign(car.slide) * Math.min(Math.abs(car.slide), 1.2 * dt);
      if (Math.abs(car.slide) < 0.02) car.slide = 0;
      // (left of the direction of travel (tx, tz) is (tz, -tx))
      tmp.x += tmp.tz * car.slide;
      tmp.z -= tmp.tx * car.slide;
      if (car.slide !== 0) yaw -= Math.sign(car.slide) * Math.atan2(1.2, Math.max(car.v, 3));
    }
    if (car.side) {
      // off the middle of its lane: making way for an emergency vehicle, or one passing the others (src/sim/emergency.ts)
      tmp.x += tmp.tz * car.side;
      tmp.z -= tmp.tx * car.side;
    }
    if (car.past && car.past.off !== 0) {
      // going round something that blocks its lane, turned a little while it moves across (src/sim/pastblock.ts)
      tmp.x += tmp.tz * car.past.off;
      tmp.z -= tmp.tx * car.past.off;
      yaw += Math.atan(car.past.turn);
    }
    // passing a side of the road closed for roadworks: over on the oncoming lane, turned a little while it moves across
    const re = this.roadEvents;
    const pl = car.lane;
    if (re && pl) {
      const pass = re.shift(pl, car.s);
      if (pass !== 0) {
        tmp.x += tmp.tz * pass;
        tmp.z -= tmp.tx * pass;
        yaw += Math.atan2(re.shift(pl, car.s + 0.5) - re.shift(pl, car.s - 0.5), 1);
      }
    }
    // past a kerb build-out: over in its gap, turned a little while it moves across (src/sim/narrowings.ts)
    if (pl && pl.edge.narrow) {
      const nw = this.narrowings;
      const hw = car.width / 2;
      const hl = car.length / 2;
      const ns = nw.shift(pl, car.s, hw, hl);
      if (ns !== 0) {
        tmp.x += tmp.tz * ns;
        tmp.z -= tmp.tx * ns;
        yaw += Math.atan2(nw.shift(pl, car.s + 0.5, hw, hl) - nw.shift(pl, car.s - 0.5, hw, hl), 1);
      }
    }
    // slope from the height change since the last frame
    if (ds > 0.01) car.pitch += (Math.atan2(tmp.y - car.y, ds) - car.pitch) * Math.min(1, dt * 6);
    // how it is drawn: turning gradually through the corners of its way, drifting rather than jumping sideways (src/sim/smoothpose.ts)
    let way = this.wayYaw(car, chordHalf(car.length));
    if (!Number.isFinite(way)) way = tangent;
    const drawn = (car.drawn ??= { x: car.x, z: car.z, yaw: car.yaw });
    easePose(drawn, tmp.x, tmp.z, way, yaw - tangent, ds, dt, car.bus ? 5.9 : car.length * 0.6);
    car.x = tmp.x;
    car.y = tmp.y;
    car.z = tmp.z;
    car.yaw = yaw;

    // --- contact with the player ---
    // (where it is drawn, as long as it is: a bus is 12 m – not only within 3 m of its middle, as before 1.7.1;
    // every picture of the contact pushes the player out of it, so that no one drives into a vehicle)
    const at = car.drawn ?? car;
    const dx = player.x - at.x;
    const dz = player.z - at.z;
    const reach = (car.length + player.length) / 2 + 1;
    if (dx * dx + dz * dz < reach * reach && Math.abs(player.y - car.y) < 2.5) {
      const push = boxPush(at.x, at.z, at.yaw, car.length / 2, car.width / 2, player.x, player.z, player.yaw, player.length / 2, player.width / 2);
      if (push) {
        if (car.crashed <= 0) this.events.push({ type: 'collision', car, speed: Math.abs(player.speed) + car.v });
        this.events.push({ type: 'contact', car, nx: push.nx, nz: push.nz, depth: push.depth });
        car.crashed = 6;
        car.v = 0;
      }
    }
  }

  /**
   * The heading of a car's way where it is: the chord from `h` metres behind
   * it to `h` ahead (as its axles would stand) – on a lane along the middle of
   * its road (whose bends do not shift it sideways); near the ends, over into
   * the path through the junction it came by or takes next.
   */
  private wayYaw(car: TrafficCar, h: number): number {
    const c = car.conn;
    if (c) {
      const a = car.s - h;
      const b = car.s + h;
      if (a >= 0) samplePolyline(c.pl, a, tmp2);
      else lanePoint(c.from, c.from.len + a, tmp2);
      const ax = tmp2.x;
      const az = tmp2.z;
      if (b <= c.len) samplePolyline(c.pl, b, tmp2);
      else lanePoint(c.to, b - c.len, tmp2);
      return chordYaw(ax, az, tmp2.x, tmp2.z);
    }
    const l = car.lane;
    if (!l) return NaN;
    const back = car.s - h < 0 && car.lastConn?.to === l ? car.lastConn : null;
    const on = car.s + h > l.len ? car.next : null;
    if (!back && !on) {
      // (along the middle of its road)
      samplePolyline(l.edge.pl, l.s0 + l.dir * clamp(car.s - h, 0, l.len), tmp2);
      const ax = tmp2.x;
      const az = tmp2.z;
      samplePolyline(l.edge.pl, l.s0 + l.dir * clamp(car.s + h, 0, l.len), tmp2);
      return chordYaw(ax, az, tmp2.x, tmp2.z);
    }
    if (back) samplePolyline(back.pl, back.len + car.s - h, tmp2);
    else lanePoint(l, car.s - h, tmp2);
    const ax = tmp2.x;
    const az = tmp2.z;
    if (on) samplePolyline(on.pl, car.s + h - l.len, tmp2);
    else lanePoint(l, car.s + h, tmp2);
    return chordYaw(ax, az, tmp2.x, tmp2.z);
  }

  /** Is a car inside the junction on a path that crosses or joins connector `c` ahead of its conflict point? */
  private boxBlocked(c: Connector): boolean {
    for (const k of c.conflicts) {
      const inside = this.onConn.get(k.other.id);
      if (!inside) continue;
      for (const o of inside) if (k.merge || o.s - o.length / 2 < k.sOther + 2.5) return true;
    }
    return false;
  }

  private junctionEmpty(c: Connector): boolean {
    for (const k of c.conflicts) {
      const list = this.onConn.get(k.other.id);
      if (list && list.length > 0) return false;
    }
    return true;
  }

  // --- pedestrians (src/sim/pedestrians.ts) ---------------------------------------
  /**
   * Somebody walking across the road `lane` leads into, on a crossing within
   * 20 m of the junction – one of the traffic's pedestrians, or the player on
   * foot on the road there.
   */
  private peopleCrossing(lane: Lane, player: PlayerState): boolean {
    for (const x of lane.edge.xings) {
      if (x.k !== XING.ZEBRA && x.k !== XING.SIGNAL && x.k !== XING.UNMARKED) continue;
      const pos = lane.dir > 0 ? x.s - lane.s0 : lane.s0 - x.s;
      if (pos < -2 || pos > 20) continue;
      for (const p of this.peds) if (p.crossing === x && p.state === 'cross') return true;
      if (player.onFoot && this.onCrossing(x, player)) return true;
    }
    // (people crossing it at the junction's mouth, where no crossing is drawn)
    return this.crowd.crossingLane(lane);
  }

  /** Is the player standing on the road at this crossing (between the kerbs, on its strip)? */
  private onCrossing(c: CrossingJson, player: PlayerState): boolean {
    const e = this.world.edges[c.e];
    if (!e) return false;
    samplePolyline(e.pl, c.s, tmp2);
    const dx = player.x - tmp2.x;
    const dz = player.z - tmp2.z;
    return Math.abs(dx * tmp2.tx + dz * tmp2.tz) <= c.w / 2 + 0.8 && Math.abs(dx * tmp2.tz - dz * tmp2.tx) <= e.width / 2 + 0.3;
  }

  /**
   * Is the player on foot at this zebra crossing: on its stripes, or standing
   * at its kerb facing the road (somebody who wants to cross, § 26 Abs. 1 StVO)?
   */
  atZebra(c: CrossingJson, player: PlayerState): boolean {
    const e = this.world.edges[c.e];
    if (!e) return false;
    samplePolyline(e.pl, c.s, tmp2);
    const dx = player.x - tmp2.x;
    const dz = player.z - tmp2.z;
    const along = dx * tmp2.tx + dz * tmp2.tz;
    // (left of the edge direction is (tz, -tx))
    const across = dx * tmp2.tz - dz * tmp2.tx;
    if (Math.abs(along) > c.w / 2 + 0.6) return false;
    const half = e.width / 2;
    if (Math.abs(across) <= half) return true;
    if (Math.abs(across) > half + 1.6) return false;
    // at the kerb: looking out over the road (towards the other side)
    const fx = -Math.sin(player.yaw);
    const fz = -Math.cos(player.yaw);
    const out = -Math.sign(across);
    return (fx * tmp2.tz - fz * tmp2.tx) * out > 0.5;
  }

  /** Is a pedestrian waiting at or walking on the given crossing? */
  pedestrianAt(c: CrossingJson): Pedestrian | null {
    for (const p of this.peds) if (p.crossing === c && p.state !== 'gone') return p;
    return null;
  }
}

/**
 * How to push rectangle b out of rectangle a (oriented, on the ground plane): the unit direction (from a towards b)
 * and the depth of the shortest way out – null when they do not overlap.  The separating-axis test, keeping the
 * axis of least overlap.
 */
export function boxPush(ax: number, az: number, ayaw: number, ahl: number, ahw: number, bx: number, bz: number, byaw: number, bhl: number, bhw: number): { nx: number; nz: number; depth: number } | null {
  const dx = bx - ax;
  const dz = bz - az;
  let best: { nx: number; nz: number; depth: number } | null = null;
  for (const ang of [ayaw, ayaw + Math.PI / 2, byaw, byaw + Math.PI / 2]) {
    const ux = -Math.sin(ang);
    const uz = -Math.cos(ang);
    const along = dx * ux + dz * uz;
    const ra = ahl * Math.abs(Math.cos(ang - ayaw)) + ahw * Math.abs(Math.sin(ang - ayaw));
    const rb = bhl * Math.abs(Math.cos(ang - byaw)) + bhw * Math.abs(Math.sin(ang - byaw));
    const depth = ra + rb - Math.abs(along);
    if (depth <= 0) return null;
    if (!best || depth < best.depth) best = along >= 0 ? { nx: ux, nz: uz, depth } : { nx: -ux, nz: -uz, depth };
  }
  return best;
}

/** Separating-axis test for two oriented rectangles on the ground plane. */
export function boxesOverlap(ax: number, az: number, ayaw: number, ahl: number, ahw: number, bx: number, bz: number, byaw: number, bhl: number, bhw: number): boolean {
  const axes = [ayaw, ayaw + Math.PI / 2, byaw, byaw + Math.PI / 2];
  const dx = bx - ax;
  const dz = bz - az;
  for (const ang of axes) {
    const ux = -Math.sin(ang);
    const uz = -Math.cos(ang);
    const dist = Math.abs(dx * ux + dz * uz);
    const ra = ahl * Math.abs(Math.cos(ang - ayaw)) + ahw * Math.abs(Math.sin(ang - ayaw));
    const rb = bhl * Math.abs(Math.cos(ang - byaw)) + bhw * Math.abs(Math.sin(ang - byaw));
    if (dist > ra + rb) return false;
  }
  return true;
}

void (null as unknown as PolySample);
