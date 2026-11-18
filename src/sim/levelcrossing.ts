// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Level crossings (Bahnübergänge): where a road of the map crosses a track
 * (CrossingJson of kind XING.RAIL or XING.TRAM) and what happens there.
 *
 * The crossings of one road that lie close together – one for each track
 * of a double track – are one installation.  What it is equipped with
 * comes from src/world/levelxing.ts: half or full barriers, the yellow and
 * red lights (or the red flashing light of older ones), a bell – or only
 * the St Andrew's cross (Zeichen 201).
 *
 * The trains and trams of src/sim/rail.ts drive it: one that will be at the
 * crossing within `LX.WARN` seconds switches it on – yellow for 3 s, then
 * red; 6 s later (9 s after the lights came on) the barriers come down,
 * which takes 6 s, and they are down before the train is there.  A train
 * that comes to a crossing that is not secured yet brakes before it (as it
 * would at its "Überwachungssignal").  Once the last car of the train has
 * left the crossing, the barriers rise and the lights go out.
 *
 * The cars of the traffic (src/sim/traffic.ts) and the autopilot
 * (src/sim/autodriver.ts) ask `gate`: wait before the cross while the lights
 * are on and the barriers move or are down, at a crossing without them
 * while a train comes, and – wherever it is – when there is no room behind
 * the tracks for the whole car: nobody stops on the rails (§ 19 Abs. 3
 * StVO).  The rule monitor (src/sim/rules.ts) asks `judge` about the
 * player: past the cross on red, at lowered barriers or in front of a
 * train, too fast, stopped on the tracks, overtaking before the crossing.
 * The renderer (src/render/levelcrossings.ts) draws the lights, barriers
 * and signs from the same state, and rings the bell.
 */
import { newPolySample, projectOnPolyline, samplePolyline } from '../core/geom.ts';
import type { PolyProjection } from '../core/geom.ts';
import { equipmentFor } from '../world/levelxing.ts';
import type { Equipment } from '../world/levelxing.ts';
import type { Connector, Lane, LaneGraph } from '../world/lanes.ts';
import type { SignPost } from '../world/tilefmt.ts';
import { EF, XING } from '../world/types.ts';
import type { CrossingJson } from '../world/types.ts';
import type { Edge, World } from '../world/world.ts';
import { carLayout } from './rail.ts';
import type { RailTraffic, RailVehicle } from './rail.ts';
import type { PlayerSnapshot, RuleMonitor } from './rules.ts';
import type { PlayerState, TrafficCar } from './traffic.ts';

/** The times and distances of a level crossing. */
export const LX = {
  /** seconds of yellow before the red (where the lights have a yellow lamp) */
  YELLOW: 3,
  /** seconds of red before the barriers begin to come down: the lights are on 9 s before they move */
  RED_BEFORE: 6,
  /** seconds the barriers take to come down, and to rise */
  LOWER: 6,
  RAISE: 6,
  /** a train this many seconds from the crossing switches it on */
  WARN: 22,
  /** seconds after the train has left before the barriers rise (or the lights go out) */
  CLEAR: 2,
  /** the St Andrew's cross stands this far before the first track (m, along the road) – as the map's signs do */
  CROSS: 4.5,
  /** where a vehicle's front stops: this far before the first track (just before the cross) */
  STOP: 5,
  /** half the width of the danger area round a track along the road (m): a train's width and some */
  ZONE: 2.6,
  /** at a crossing with only the cross: a train within this many seconds is waited for (a tram: TRAM_WAIT – it is slower, and in town) */
  PASSIVE_WAIT: 12,
  TRAM_WAIT: 6,
  /** … and one within this many seconds makes it a fault to drive over */
  PASSIVE_FAULT: 8,
  TRAM_FAULT: 4,
  /** the "moderate speed" of § 19 Abs. 1 StVO where there are no barriers (m/s: 50 km/h) */
  MODERATE: 50 / 3.6,
  /** the beacons outside built-up areas (Zeichen 156, 159, 162): metres before the cross */
  BEACONS: [240, 160, 80] as const,
  /** the warning sign alone (Zeichen 151) in town: metres before the crossing, as the map puts it */
  WARNING: 140,
  /** installations further than this from the player are left alone (m) */
  ACTIVE: 1500,
  /** crossings of one road closer together than this are one installation (m) */
  GROUP: 14,
} as const;

export type Phase = 'open' | 'yellow' | 'red' | 'lowering' | 'closed' | 'raising';

/** Where a track crosses the road: its piece and metres (sim/rail.ts), and the point. */
export interface TrackHit {
  path: number;
  s: number;
  x: number;
  z: number;
}

/** One level crossing: one road, one or more tracks. */
export interface LevelCrossing {
  id: number;
  edge: Edge;
  /** the map's crossings it is made of */
  xings: CrossingJson[];
  /** the stations along the road of the first and the last track */
  s0: number;
  s1: number;
  /** its middle */
  x: number;
  z: number;
  eq: Equipment;
  hits: TrackHit[];
  phase: Phase;
  /** seconds in the phase */
  t: number;
  /** the barriers: 0 up … 1 down */
  lower: number;
  /** seconds until the nearest train is at the crossing (Infinity: none coming) */
  eta: number;
  /** a train is on the crossing */
  occupied: boolean;
  /** seconds no train has needed it */
  quiet: number;
  /** the beacons (outside built-up areas, on bigger roads): drawn by us in place of the map's warning sign */
  beacons: boolean;
  /** the overtaking ban begins this far before the cross (m; 0: no sign announces the crossing) */
  zone: number;
}

/** What `gate` asks of a vehicle: where to stop (m ahead of its front; Infinity: nowhere) and how fast at most. */
export interface LxGate {
  stop: number;
  cap: number;
  why: '' | 'light' | 'barrier' | 'train' | 'queue';
}

/** What the module needs of the traffic. */
export interface LxRoad {
  readonly graph: LaneGraph;
  carsOn(lane: Lane): readonly TrafficCar[] | undefined;
  carsOnConn(c: Connector): readonly TrafficCar[] | undefined;
}

const smp = newPolySample();
const proj: PolyProjection = { s: 0, off: 0, d2: 0, seg: 0 };

/** Distance along a lane of an edge station. */
const along = (lane: Lane, s: number): number => (s - lane.s0) * lane.dir;

/** Is the crossing passive: only the cross, nothing that switches? */
export function passive(c: LevelCrossing): boolean {
  return c.eq.light === 'none' && c.eq.barrier === 'none';
}

/** The station of the cross for traffic going `dir` along the road (+1 a→b), and the one of the far side of the danger area. */
export function entryOf(c: LevelCrossing, dir: number): number {
  return dir > 0 ? c.s0 - LX.CROSS : c.s1 + LX.CROSS;
}
export function exitOf(c: LevelCrossing, dir: number): number {
  return dir > 0 ? c.s1 + LX.ZONE : c.s0 - LX.ZONE;
}

/** Are the lights showing red (steady or flashing) now – the barriers moving or down included? */
export function redOn(c: LevelCrossing): boolean {
  return c.phase === 'red' || c.phase === 'lowering' || c.phase === 'closed';
}

/** Does the bell ring now?  While the lights are on and the barriers come down – without barriers, the first seconds of red. */
export function ringing(c: LevelCrossing): boolean {
  if (!c.eq.bell) return false;
  if (c.phase === 'yellow' || c.phase === 'lowering') return true;
  if (c.phase === 'red') return c.eq.barrier !== 'none' || c.t < 8;
  return false;
}

/**
 * Is the crossing safe for a train: barriers down, or the lights red long
 * enough for whoever was about to go over to have stopped – a crossing with
 * only the cross is always (the road traffic waits for the train there).
 */
export function secured(c: LevelCrossing): boolean {
  if (passive(c)) return true;
  if (c.eq.barrier !== 'none') return c.phase === 'closed';
  return c.phase === 'red' && c.t >= 4;
}

/**
 * Must a vehicle `d` metres before the stop point going `v` m/s wait at the
 * crossing for what it shows (or a train it sees)?  Amber as at a light:
 * stop if that is comfortably possible.
 */
export function mustWait(c: LevelCrossing, v: number, d: number): LxGate['why'] {
  if (c.occupied) return 'train';
  if (passive(c)) return c.eta < (c.eq.rail ? LX.PASSIVE_WAIT : LX.TRAM_WAIT) ? 'train' : '';
  if (c.eq.barrier !== 'none' && (c.phase === 'lowering' || c.phase === 'closed' || c.phase === 'raising')) return 'barrier';
  if (c.phase === 'red' || c.phase === 'lowering' || c.phase === 'closed' || c.phase === 'raising') return 'light';
  if (c.phase === 'yellow' && d > 0 && (v * v) / (2 * Math.max(d, 0.5)) < 3.2) return 'light';
  return '';
}

export class LevelCrossings {
  readonly world: World;
  readonly road: LxRoad;
  readonly list: LevelCrossing[] = [];
  /** installations by the edge they are on */
  private readonly byEdge = new Map<number, LevelCrossing[]>();
  private readonly ofXing = new WeakMap<CrossingJson, LevelCrossing>();
  private rail: RailTraffic | null = null;
  /** the crossings of each piece of track: installation and metres */
  private byPath = new Map<number, Array<{ c: LevelCrossing; s: number }>>();
  private known = -1;
  private refreshT = 0;
  private nextId = 1;
  /** for each rail vehicle: how far ahead the nearest crossing is that is not secured (sim/rail.ts brakes for it) */
  private readonly holds = new Map<number, number>();
  /** the installations near the player this step */
  private readonly active: LevelCrossing[] = [];
  /** the player (set by the traffic each step): it may stand in the queue behind a crossing */
  player: PlayerState | null = null;
  /** the game's time (s): the flashing lights blink by it */
  time = 0;
  /** what the rule monitor saw last of the player: per road and direction where the front was, and since when it stands on the tracks */
  private prevFront: { edge: Edge; dir: number; s: number; t: number } | null = null;
  private standT = 0;
  private readonly sides = new Map<TrafficCar, number>();

  constructor(world: World, road: LxRoad) {
    this.world = world;
    this.road = road;
  }

  /** The trains that drive the crossings (none: they stay open). */
  setRail(rail: RailTraffic | null): void {
    this.rail = rail;
    for (const c of this.list) this.findTracks(c);
    this.indexTracks();
    if (rail) rail.hold = (v) => this.holds.get(v.id) ?? Infinity;
  }

  /** The installations on a road. */
  on(edge: Edge): readonly LevelCrossing[] | undefined {
    return this.byEdge.get(edge.id);
  }

  /** The installation a crossing of the map belongs to. */
  of(x: CrossingJson): LevelCrossing | undefined {
    return this.ofXing.get(x);
  }

  // ------------------------------------------------------------------ the installations
  /** Follow the network as it comes and goes in pieces: new crossings become installations, those of roads gone go. */
  refresh(): void {
    const all = this.world.crossings;
    let changed = false;
    // (roads that went: their installations go)
    for (let i = this.list.length - 1; i >= 0; i--) {
      const c = this.list[i];
      if (this.world.edges[c.edge.id] === c.edge && this.world.allEdges.has(c.edge)) continue;
      this.list.splice(i, 1);
      const on = this.byEdge.get(c.edge.id);
      if (on) {
        on.splice(on.indexOf(c), 1);
        if (on.length === 0) this.byEdge.delete(c.edge.id);
      }
      changed = true;
    }
    for (const x of all) {
      if (x.k !== XING.RAIL && x.k !== XING.TRAM) continue;
      if (this.ofXing.has(x)) continue;
      const edge = this.world.edges[x.e];
      if (!edge) continue;
      let on = this.byEdge.get(edge.id);
      let c = on?.find((o) => x.s >= o.s0 - LX.GROUP && x.s <= o.s1 + LX.GROUP);
      if (c) {
        c.xings.push(x);
        c.s0 = Math.min(c.s0, x.s);
        c.s1 = Math.max(c.s1, x.s);
      } else {
        c = { id: this.nextId++, edge, xings: [x], s0: x.s, s1: x.s, x: 0, z: 0, eq: { barrier: 'none', light: 'none', bell: false, rail: false, mapped: false }, hits: [], phase: 'open', t: 0, lower: 0, eta: Infinity, occupied: false, quiet: 0, beacons: false, zone: 0 };
        this.list.push(c);
        if (!on) this.byEdge.set(edge.id, (on = []));
        on.push(c);
      }
      this.ofXing.set(x, c);
      this.equip(c);
      this.findTracks(c);
      changed = true;
    }
    this.known = all.length;
    if (changed) this.indexTracks();
  }

  /** What an installation has, where its middle is, whether it gets beacons and from where overtaking is banned. */
  private equip(c: LevelCrossing): void {
    const e = c.edge;
    samplePolyline(e.pl, (c.s0 + c.s1) / 2, smp);
    c.x = smp.x;
    c.z = smp.z;
    const rail = c.xings.some((x) => x.k === XING.RAIL);
    // (the map's tags are at the node of one of its tracks: the nearest of them)
    let best = equipmentFor(c.x, c.z, rail, e.tier);
    for (const x of c.xings) {
      samplePolyline(e.pl, x.s, smp);
      const eq = equipmentFor(smp.x, smp.z, rail, e.tier);
      if (eq.mapped && !best.mapped) best = eq;
    }
    c.eq = best;
    // the map announces a railway's crossing on the bigger roads (Zeichen 151 at 140 m); outside built-up areas we put the beacons there
    const announced = rail && e.tier >= 2;
    c.beacons = announced && (e.flags & EF.URBAN) === 0;
    c.zone = announced ? (c.beacons ? LX.BEACONS[0] : LX.WARNING) : 0;
  }

  /** The tracks that cross the road at the installation (pieces of sim/rail.ts within a few metres of its crossings). */
  private findTracks(c: LevelCrossing): void {
    c.hits.length = 0;
    const net = this.rail?.net;
    if (!net) return;
    for (const x of c.xings) {
      samplePolyline(c.edge.pl, x.s, smp);
      const px = smp.x;
      const pz = smp.z;
      const seen = new Set<number>();
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const near = net.near(px + i * 200, pz + j * 200);
          for (let k = 0; k < near.length; k += 2) {
            const pi = near[k];
            if (seen.has(pi)) continue;
            seen.add(pi);
            const p = net.paths[pi];
            let bd = 6;
            let bs = -1;
            for (let q = 1; q < p.cum.length; q++) {
              const ax = p.pts[q * 3 - 3];
              const az = p.pts[q * 3 - 1];
              const dx = p.pts[q * 3] - ax;
              const dz = p.pts[q * 3 + 2] - az;
              const l2 = dx * dx + dz * dz;
              if (l2 < 1e-9) continue;
              const u = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
              const d = Math.hypot(ax + dx * u - px, az + dz * u - pz);
              if (d < bd) {
                bd = d;
                bs = p.cum[q - 1] + Math.sqrt(l2) * u;
              }
            }
            if (bs >= 0 && !c.hits.some((h) => h.path === pi && Math.abs(h.s - bs) < 8)) c.hits.push({ path: pi, s: bs, x: px, z: pz });
          }
        }
      }
    }
  }

  private indexTracks(): void {
    this.byPath = new Map();
    for (const c of this.list) {
      for (const h of c.hits) {
        let l = this.byPath.get(h.path);
        if (!l) this.byPath.set(h.path, (l = []));
        l.push({ c, s: h.s });
      }
    }
  }

  // ------------------------------------------------------------------ each step
  /** Each step, before the traffic and the trains: where the trains are, and what each crossing near (x, z) shows. */
  update(dt: number, x: number, z: number): void {
    this.time += dt;
    this.refreshT -= dt;
    if (this.known !== this.world.crossings.length || this.refreshT <= 0) {
      this.refreshT = 3;
      this.refresh();
    }
    // (those near the player: the others stay open, and no train is near them)
    const active = this.active;
    active.length = 0;
    for (const c of this.list) {
      c.eta = Infinity;
      c.occupied = false;
      if (Math.abs(c.x - x) > LX.ACTIVE || Math.abs(c.z - z) > LX.ACTIVE) {
        c.phase = 'open';
        c.t = 0;
        c.lower = 0;
      } else active.push(c);
    }
    this.holds.clear();
    const rail = this.rail;
    if (rail && this.byPath.size > 0 && active.length > 0) for (const v of rail.vehicles) this.trainAhead(rail, v);
    for (const c of active) this.step(c, dt);
    // the trains brake for a crossing ahead that is not secured yet (the installation switched on above)
    if (rail) for (const v of rail.vehicles) this.trainHold(rail, v);
  }

  /** The crossings on the way ahead of a train: when it is at each; which it stands on. */
  private trainAhead(rail: RailTraffic, v: RailVehicle): void {
    // (the cars of the train on a crossing: by their boxes)
    const layout = carLayout(v.consist);
    v.cars.forEach((car, i) => {
      const len = layout[i]?.len ?? v.consist.carLen;
      const fx = -Math.sin(car.yaw);
      const fz = -Math.cos(car.yaw);
      for (const c of this.active) {
        if (Math.abs(c.x - car.x) > 60 || Math.abs(c.z - car.z) > 60) continue;
        for (const h of c.hits) {
          const dx = h.x - car.x;
          const dz = h.z - car.z;
          const a = dx * fx + dz * fz;
          const l = dx * fz - dz * fx;
          if (Math.abs(a) <= len / 2 + 1.5 && Math.abs(l) <= 3.5) c.occupied = true;
        }
      }
    });
    const speed = Math.max(v.speed, Math.min(v.consist.vmax, 8));
    const reach = Math.max(300, v.consist.vmax * LX.WARN + 120);
    this.walk(rail, v, reach, (c, d) => {
      const eta = Math.max(0, v.dwell) + d / speed;
      if (eta < c.eta) c.eta = eta;
    });
  }

  /** How far ahead of a train is the nearest crossing that is not secured – for it to brake for. */
  private trainHold(rail: RailTraffic, v: RailVehicle): void {
    if (v.player) return;
    let hold = Infinity;
    const reach = Math.max(250, (v.speed * v.speed) / (v.consist.brake * 1.2) + 80);
    this.walk(rail, v, reach, (c, d) => {
      if (!secured(c) && d < hold && d > 1) hold = d;
    });
    if (hold < Infinity) this.holds.set(v.id, hold);
  }

  /** Along the way a train will take (its plan, then its line or the straightest way): each crossing within `reach` of its front. */
  private walk(rail: RailTraffic, v: RailVehicle, reach: number, see: (c: LevelCrossing, d: number) => void): void {
    const net = rail.net;
    let cp = v.path;
    let cs = v.s;
    let cd = v.dir;
    let dist = 0;
    let planned = 0;
    for (let guard = 0; guard < 60 && dist <= reach; guard++) {
      const p = net.paths[cp];
      if (!p) return;
      for (const h of this.byPath.get(cp) ?? []) {
        const ahead = (h.s - cs) * cd;
        if (ahead >= 0 && dist + ahead <= reach) see(h.c, dist + ahead);
      }
      dist += cd > 0 ? p.len - cs : cs;
      const next = v.plan[planned++] ?? rail.routeNext(v, cp, cd) ?? rail.lineNext(v, cp, cd) ?? net.waysOn(cp, cd, v.consist.tracks)[0];
      if (!next) return;
      cp = next.path;
      cd = next.dir;
      cs = cd > 0 ? 0 : (net.paths[cp]?.len ?? 0);
    }
  }

  /** The lights and barriers of one installation, one step on. */
  step(c: LevelCrossing, dt: number): void {
    if (passive(c)) {
      c.phase = 'open';
      return;
    }
    const need = c.occupied || c.eta <= LX.WARN;
    c.quiet = need ? 0 : c.quiet + dt;
    c.t += dt;
    const barrier = c.eq.barrier !== 'none';
    const go = (p: Phase): void => {
      c.phase = p;
      c.t = 0;
    };
    switch (c.phase) {
      case 'open':
        if (need) go(c.eq.light === 'yellowRed' ? 'yellow' : c.eq.light === 'blink' ? 'red' : 'lowering');
        break;
      case 'yellow':
        if (c.t >= LX.YELLOW) go('red');
        break;
      case 'red':
        if (barrier && c.t >= LX.RED_BEFORE) go('lowering');
        else if (!barrier && c.quiet >= LX.CLEAR && c.t >= 3) go('open');
        break;
      case 'lowering':
        c.lower = Math.min(1, c.lower + dt / LX.LOWER);
        if (c.lower >= 1) go('closed');
        break;
      case 'closed':
        c.lower = 1;
        if (c.quiet >= LX.CLEAR) go('raising');
        break;
      case 'raising':
        c.lower = Math.max(0, c.lower - dt / LX.RAISE);
        // (another train: down again at once – the lights come on with it)
        if (need) go('lowering');
        else if (c.lower <= 0) go('open');
        break;
    }
  }

  // ------------------------------------------------------------------ the road traffic
  /**
   * For a vehicle on `lane` with its front `front` metres along it, going
   * `v` m/s, `length` long, taking `next` at the end of the lane: where to
   * stop for a crossing ahead and how fast to come to it.  `self`: the car
   * of the traffic it is (or 'player': the player's own, driven by the
   * autopilot) – not counted in the queue.
   */
  gate(lane: Lane, front: number, v: number, length: number, next: Connector | null, self: TrafficCar | 'player' | null): LxGate {
    const out: LxGate = { stop: Infinity, cap: Infinity, why: '' };
    if (this.list.length === 0) return out;
    this.gateOn(lane, -front, v, length, self, out);
    if (next && lane.len - front < 150) this.gateOn(next.to, lane.len - front + next.len, v, length, self, out);
    return out;
  }

  /** The crossings of lane `l`, whose start is `base` metres ahead of the front. */
  private gateOn(l: Lane, base: number, v: number, length: number, self: TrafficCar | 'player' | null, out: LxGate): void {
    const list = this.byEdge.get(l.edge.id);
    if (!list) return;
    for (const c of list) {
      const stopAt = base + along(l, entryOf(c, l.dir)) - (LX.STOP - LX.CROSS);
      if (stopAt < -0.6 || stopAt > 150) continue;
      // (§ 19 Abs. 1 StVO: a moderate speed where no barriers are – to be able to stop for a train)
      if (c.eq.barrier === 'none' && stopAt < 80) out.cap = Math.min(out.cap, Math.max(LX.MODERATE, Math.sqrt(LX.MODERATE * LX.MODERATE + 2 * 1.5 * Math.max(0, stopAt - 10))));
      let why = mustWait(c, v, stopAt);
      // (and no further than there is room for the whole car behind the tracks)
      if (!why && stopAt < 45 && this.blockedBeyond(l, base, base + along(l, exitOf(c, l.dir)), length, self)) why = 'queue';
      if (why && Math.max(0, stopAt) < out.stop) {
        out.stop = Math.max(0, stopAt);
        out.why = why;
      }
    }
  }

  /**
   * Is the room behind the danger area too short for a vehicle `length`
   * long: something standing (or nearly) whose rear is less than the car's
   * length and a metre beyond the end of the area?  `exitAt`: that end, in
   * metres ahead of the front; `base`: where lane `l` begins.
   */
  blockedBeyond(l: Lane, base: number, exitAt: number, length: number, self: TrafficCar | 'player' | null): boolean {
    const need = exitAt + length + 1;
    const slow = (rear: number, v: number): boolean => rear > 0.2 && rear < need && v < 2.5;
    for (const car of this.road.carsOn(l) ?? []) {
      if (car === self) continue;
      if (slow(base + car.s - car.length / 2, car.v)) return true;
    }
    const p = this.player;
    if (p && self !== 'player' && p.lane === l && p.s !== undefined && !p.onFoot && slow(base + p.s - p.length / 2, Math.abs(p.speed))) return true;
    // (beyond the end of the lane: in the junction, and on the lanes after it)
    const end = base + l.len;
    if (need > end) {
      for (const k of l.out) {
        for (const car of this.road.carsOnConn(k) ?? []) if (car !== self && slow(end + car.s - car.length / 2, car.v)) return true;
        if (need > end + k.len) {
          for (const car of this.road.carsOn(k.to) ?? []) if (car !== self && slow(end + k.len + car.s - car.length / 2, car.v)) return true;
          if (p && self !== 'player' && p.lane === k.to && p.s !== undefined && slow(end + k.len + p.s - p.length / 2, Math.abs(p.speed))) return true;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ the player
  /**
   * The player's faults (called by the rule monitor with where the vehicle
   * is: its road, station and direction): over the cross on red, at
   * lowered barriers or in front of a train (§ 19 Abs. 2 StVO), too fast
   * where there are no barriers (Abs. 1), stopped on the tracks (Abs. 3),
   * overtaking from the warning sign on (Abs. 1).
   */
  judge(rules: RuleMonitor, p: PlayerSnapshot, edge: Edge, s: number, dir: number, dt: number): void {
    const list = this.byEdge.get(edge.id);
    if (!list) {
      this.prevFront = null;
      this.standT = 0;
      this.sides.clear();
      return;
    }
    const front = s + dir * (p.front ?? p.length / 2);
    const rear = front - dir * p.length;
    const prev = this.prevFront;
    const kmh = Math.abs(p.speed) * 3.6;
    let onTracks = false;
    for (const c of list) {
      const line = entryOf(c, dir) + dir * 0.5;
      if (prev && prev.edge === edge && prev.dir === dir && rules.time - prev.t < 0.6 && p.speed > 0.3 && (prev.s - line) * dir < 0 && (front - line) * dir >= 0) {
        // over the cross: what did it show?
        if (c.occupied || (passive(c) && c.eta < (c.eq.rail ? LX.PASSIVE_FAULT : LX.TRAM_FAULT))) rules.noteAt('levelCrossingTrain', 'major', p.x, p.z, {}, 10);
        else if (c.eq.barrier !== 'none' && (c.phase === 'lowering' || c.phase === 'closed' || (c.phase === 'raising' && c.lower > 0.3))) rules.noteAt('levelCrossingBarrier', 'major', p.x, p.z, {}, 10);
        else if (c.phase === 'red' || c.phase === 'lowering' || c.phase === 'closed') rules.noteAt('levelCrossingRed', 'major', p.x, p.z, {}, 10);
        // (yellow: a fault where the car could have stopped comfortably when it came on – at its speed it was v · t away)
        else if (c.phase === 'yellow' && p.speed / (2 * Math.max(c.t, 0.1)) < 3.5) rules.noteAt('levelCrossingYellow', 'minor', p.x, p.z, {}, 10);
        if (c.eq.barrier === 'none' && kmh > LX.MODERATE * 3.6 + 5) rules.noteAt('levelCrossingSpeed', 'minor', p.x, p.z, { limit: Math.round(LX.MODERATE * 3.6), speed: Math.round(kmh) }, 10);
      }
      // on the tracks: the car's body over the danger area
      const lo = Math.min(front, rear);
      const hi = Math.max(front, rear);
      if (hi > c.s0 - LX.ZONE && lo < c.s1 + LX.ZONE) onTracks = true;
      // overtaking from the sign that announces it to the tracks (§ 19 Abs. 1 Satz 3 StVO)
      if (c.zone > 0) this.overtaking(rules, p, edge, s, dir, c);
    }
    if (onTracks && Math.abs(p.speed) < 0.3) {
      this.standT += dt;
      if (this.standT > 1.5) rules.noteAt('levelCrossingStop', 'major', p.x, p.z, {}, 30);
    } else this.standT = 0;
    this.prevFront = { edge, dir, s: front, t: rules.time };
  }

  /** Did the player pass a car of the traffic going the same way between the warning sign and the tracks? */
  private overtaking(rules: RuleMonitor, p: PlayerSnapshot, edge: Edge, s: number, dir: number, c: LevelCrossing): void {
    const entry = entryOf(c, dir);
    const from = entry - dir * c.zone;
    const exit = exitOf(c, dir);
    const inZone = (s - from) * dir >= 0 && (s - exit) * dir <= 0;
    if (!inZone) {
      this.sides.clear();
      return;
    }
    const el = this.road.graph.edgeLanes[edge.id];
    if (!el) return;
    const seen = new Set<TrafficCar>();
    for (const lane of dir > 0 ? el.fwd : el.back) {
      for (const car of this.road.carsOn(lane) ?? []) {
        const st = lane.s0 + lane.dir * car.s;
        if (Math.abs(st - s) > 40) continue;
        seen.add(car);
        const side = (st - s) * dir;
        const was = this.sides.get(car);
        if (was !== undefined && was > 1 && side < -1 && p.speed > car.v + 0.5) rules.noteAt('levelCrossingOvertake', 'major', p.x, p.z, {}, 20);
        if (Math.abs(side) > 1) this.sides.set(car, side);
      }
    }
    for (const k of [...this.sides.keys()]) if (!seen.has(k)) this.sides.delete(k);
  }

  // ------------------------------------------------------------------ the signs
  /**
   * The signs we put up for an installation: the St Andrew's cross on the
   * mast of the lights (in place of the map's own), and outside built-up
   * areas the beacons with the warning sign (Zeichen 156, 159, 162) in place
   * of the map's warning sign.  `y` gives the ground at a point of the road.
   */
  signsFor(c: LevelCrossing, y: (s: number, x: number, z: number) => number): SignPost[] {
    const e = c.edge;
    const out: SignPost[] = [];
    const lit = !passive(c);
    for (const dir of [1, -1]) {
      if ((dir > 0 ? e.lanesF : e.lanesB) === 0) continue;
      const entry = entryOf(c, dir);
      if (lit) {
        const sp = this.postAt(e, entry, dir, ['201-50'], y);
        // (above the lights)
        sp.h = 2.45;
        out.push(sp);
      }
      if (c.beacons) {
        LX.BEACONS.forEach((d, i) => {
          const at = entry - dir * d;
          if (at < 1 || at > e.len - 1) return;
          const sp = this.postAt(e, at, dir, [['156-10', '159-10', '162-10'][i]], y);
          sp.h = 0.6;
          out.push(sp);
        });
      }
    }
    return out;
  }

  /** A post on the right of traffic going `dir`, at station `s`, as the map's posts stand (tools/mapgen/signs.ts postBeside). */
  postAt(e: Edge, s: number, dir: number, codes: string[], y: (s: number, x: number, z: number) => number): SignPost {
    const st = Math.max(0.5, Math.min(e.len - 0.5, s));
    samplePolyline(e.pl, st, smp);
    const lat = -dir;
    const sw = lat > 0 ? e.swL : e.swR;
    const outward = e.width / 2 + (sw > 0 ? Math.min(0.55, sw * 0.4) : 1.0);
    const x = smp.x + smp.tz * outward * lat;
    const z = smp.z - smp.tx * outward * lat;
    const fx = -smp.tx * dir;
    const fz = -smp.tz * dir;
    return { x, y: y(st, x, z) + (sw > 0 ? 0.15 : -0.15), z, yaw: Math.atan2(-fx, -fz), s: codes, h: (e.flags & EF.URBAN) !== 0 ? 2.1 : 1.7 };
  }

  /**
   * A sign post of the map's tiles: as it is, without the codes we put up
   * ourselves at an installation (its St Andrew's crosses where we draw the
   * lights, its warning signs where we draw the beacons) – null when
   * nothing is left of it.
   */
  editPost(p: SignPost): SignPost | null {
    const cross = p.s.includes('201-50');
    const warn = p.s.includes('151');
    if (!cross && !warn) return p;
    // (a tile may come before the first step: the installations of the roads loaded so far)
    if (this.known !== this.world.crossings.length) this.refresh();
    const drop: string[] = [];
    for (const c of this.list) {
      if (Math.abs(c.x - p.x) > 200 || Math.abs(c.z - p.z) > 200) continue;
      projectOnPolyline(c.edge.pl, p.x, p.z, proj);
      if (Math.abs(proj.off) > c.edge.width / 2 + 4) continue;
      if (cross && !passive(c) && proj.s > c.s0 - 8 && proj.s < c.s1 + 8) drop.push('201-50');
      if (warn && c.beacons && (Math.abs(proj.s - (c.s0 - LX.WARNING)) < 8 || Math.abs(proj.s - (c.s1 + LX.WARNING)) < 8)) drop.push('151');
    }
    if (drop.length === 0) return p;
    const left = p.s.filter((code) => !drop.includes(code));
    return left.length > 0 ? { ...p, s: left } : null;
  }
}
