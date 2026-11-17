// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The trams and buses of the traffic as the timetables run them: so that the
 * tram or bus a departure board announces is at the stop when the board
 * says – it comes in a little before its time, its doors open, and it leaves
 * at the minute the board counted down to.
 *
 * The departure boards read the timetable (src/sim/timetable.ts); the
 * vehicles are simulated – a tram by src/sim/rail.ts, a bus among the cars by
 * src/sim/traffic.ts – and come and go round the player.  What ties the two
 * together is here:
 *
 * - Where a vehicle appears: the trips under way round the player are put
 *   where the clock has them on their line (a trip about to leave its first
 *   stop stands there a while before), the nearest first, each once.
 * - How fast a tram runs: no faster than it needs to arrive at its next stop
 *   of the trip ARRIVE_EARLY seconds before it leaves there – the trams of
 *   the simulation are quicker than the timetables' running times, which
 *   count the minutes at the stops in.  It passes the stops its trip does not
 *   call at.
 * - How long it stands: until its time (not before), and when it is late no
 *   longer than the doors take.
 * - At the end of its trip it goes (out of the player's sight).
 * - One that has fallen far behind its trip (the game stood still while the
 *   clock ran on, the player blocked it) is put where its trip is, when the
 *   player is near neither place.
 *
 * Times: the timetable counts seconds after midnight of a service day in
 * Kassel (Europe/Berlin); a trip remembers the moment (ms) of the midnight
 * its times count from, so that it keeps to them past midnight too.  The
 * world's moment is the game's clock (src/game/clock.ts), not the computer's.
 */
import type { RailSchedule, RailTraffic, RailVehicle } from '../sim/rail.ts';
import { busTripsAt, serviceTime, tripsAt } from '../sim/timetable.ts';
import type { Timetable, TimetablePattern, TripState } from '../sim/timetable.ts';
import { stopPlaceOf } from '../sim/traffic.ts';
import type { BusSchedule, Traffic, TrafficCar } from '../sim/traffic.ts';
import type { Lane } from '../world/lanes.ts';
import type { LinesJson } from '../world/types.ts';
import { projectOnPolyline } from '../core/geom.ts';
import { spotOf, tripName } from '../ui/transitmap.ts';
import type { TransitSource } from '../ui/transitmap.ts';

/** how long before its departure a vehicle of the timetable is to arrive at a stop (s): the doors open, people get off and on */
export const ARRIVE_EARLY = 15;
/** how long before it leaves its first stop a trip is put there, standing (s) */
export const LEAD = 120;
/** the world's clock ran on this much more than between two looks for trips (ms): the vehicles are put anew */
const JUMP_MS = 30000;
/** the time a tram of the simulation loses by starting and stopping, per m/s of its speed (s): half its speed over its acceleration and over its braking */
const RAMP = 0.5 / 1.0 + 0.5 / 1.04;

/** A trip as the vehicle running it knows it: its pattern, when it leaves its first stop, and the midnight that counts from. */
interface TripEntry {
  pattern: TimetablePattern;
  t0: number;
  /** ms since 1970 of the midnight (local time in Kassel) its times count from */
  day: number;
  /** the stop of the pattern it stood at last (−1: none yet) – until its vehicle is under way (`bound`), the one the clock had it leave last (`from`) */
  last: number;
  from: number;
  bound: boolean;
  /** its vehicle has come to the end of it: it is not put on again */
  done?: boolean;
  /** a tram's: where on the tracks its stops are (piece → [mark, place in the pattern]) – null where one of them is not known */
  marks: Map<number, Array<[number, number]>> | null;
}

/** Seconds after the midnight a trip counts from, at the moment `ms`. */
function since(e: TripEntry, ms: number): number {
  return (ms - e.day) / 1000;
}

/** The vehicle of a trip is under way: from here on the stops it stood at count, not the clock. */
function bind(e: TripEntry): void {
  if (e.bound) return;
  e.bound = true;
  e.last = e.from;
}

/**
 * Of the stops `ks` of a trip, the one it is at or runs to: the next after
 * the one it stood at last, if that is among them – else the one whose
 * departure lies nearest to the moment (a line that loops passes a place twice).
 */
function nearestCall(e: TripEntry, ks: readonly number[], now: number): number {
  if (e.bound && ks.includes(e.last + 1)) return e.last + 1;
  let best = -1;
  let bd = Infinity;
  for (const k of ks) {
    const d = Math.abs(e.t0 + e.pattern.dep[k] - now);
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}

/** When a vehicle is to be at stop k of its trip: at its arrival, ARRIVE_EARLY before it leaves at the latest – at the end of its trip, at its arrival. */
function arriveBy(e: TripEntry, k: number): number {
  const p = e.pattern;
  const end = k === p.stops.length - 1 && !p.post;
  return e.t0 + (end ? p.arr[k] : Math.min(p.arr[k], p.dep[k] - ARRIVE_EARLY));
}

/**
 * The speed to run at so as to cover `dist` metres in `time` seconds,
 * starting and stopping included (`ramp`: the seconds lost per m/s) –
 * Infinity where that cannot be done (or no time is left).
 */
export function paceFor(dist: number, time: number, ramp = RAMP): number {
  if (time <= 1 || dist <= 0) return Infinity;
  // dist / v + ramp · v = time
  const disc = time * time - 4 * ramp * dist;
  if (disc < 0) return Infinity;
  return (time - Math.sqrt(disc)) / (2 * ramp);
}

/** The trips the vehicles run, by their names (shared by the trams and the buses: the names differ). */
class TripBook {
  private readonly trips = new Map<string, TripEntry>();
  /** a trip by when it really leaves (line, pattern, ms): the name it was first given (past midnight its t0 is counted from another day) */
  private readonly names = new Map<string, string>();

  private readonly tt: () => Timetable | null;

  constructor(tt: () => Timetable | null) {
    this.tt = tt;
  }

  /** The name for a trip under way (the one it already has, if it has one), and its entry. */
  name(kind: 'tram' | 'bus', line: number, trip: TripState, day: number, marks: () => TripEntry['marks']): string {
    const p = trip.pattern;
    const abs = `${kind}:${line}:${p.line.patterns.indexOf(p)}:${Math.round(day / 1000 + trip.t0)}`;
    let name = this.names.get(abs);
    if (!name) {
      name = tripName(kind, line, p, trip.t0);
      this.names.set(abs, name);
    }
    const e = this.trips.get(name);
    if (!e) this.trips.set(name, { pattern: p, t0: trip.t0, day, last: -1, from: trip.from, bound: false, marks: marks() });
    else if (!e.bound) e.from = trip.from;
    return name;
  }

  /** The entry of a trip by its name – one named elsewhere (src/game/spectate.ts puts a vehicle there itself) is read from the name. */
  get(name: string | undefined, ms: number, marks: (p: TimetablePattern) => TripEntry['marks']): TripEntry | null {
    if (!name) return null;
    const have = this.trips.get(name);
    if (have) return have;
    const tt = this.tt();
    const m = /^(b:)?(\d+):(\d+):(-?\d+(?:\.\d+)?)$/.exec(name);
    if (!tt || !m) return null;
    const line = (m[1] ? tt.buses : tt.lines)[Number(m[2])];
    const p = line?.patterns[Number(m[3])];
    if (!p) return null;
    const now = serviceTime(new Date(ms));
    const t0 = Number(m[4]);
    // (the stop it left last by the clock)
    let from = 0;
    while (from + 1 < p.stops.length && t0 + p.dep[from + 1] <= now.s) from++;
    const e: TripEntry = { pattern: p, t0, day: ms - now.s * 1000, last: -1, from, bound: false, marks: marks(p) };
    this.trips.set(name, e);
    return e;
  }

  /** Has the vehicle of a trip come to its end? */
  done(name: string): boolean {
    return this.trips.get(name)?.done === true;
  }

  /** Forget the trips that ended more than an hour ago (now and then). */
  prune(ms: number): void {
    if (this.trips.size < 3000) return;
    for (const [name, e] of this.trips) if (e.t0 + e.pattern.arr[e.pattern.stops.length - 1] + 3600 < since(e, ms)) this.trips.delete(name);
    if (this.names.size > 6000) this.names.clear();
  }
}

// ---------------------------------------------------------------- the trams

export interface TramScheduleHost {
  timetable(): Timetable | null;
  /** the lines of the trams (lines.json.gz: their stops as piece of track and mark) */
  lines(): LinesJson | null;
  rail(): RailTraffic;
  /** the world's moment (the game's clock), ms since 1970 */
  nowMs(): number;
}

/** The timetable as the trams of the traffic keep to it (RailTraffic.schedule). */
export function tramSchedule(h: TramScheduleHost): RailSchedule {
  const book = new TripBook(() => h.timetable());
  const smp = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };
  const marksOf = (p: TimetablePattern): TripEntry['marks'] => {
    const stops = h.lines()?.lines[p.line.index]?.stops;
    if (!stops) return null;
    const out = new Map<number, Array<[number, number]>>();
    for (let k = 0; k < p.lineStops.length; k++) {
      const st = stops[p.lineStops[k]];
      if (!st) return null;
      const list = out.get(st[0]);
      if (list) list.push([st[1], k]);
      else out.set(st[0], [[st[1], k]]);
    }
    return out;
  };
  const entry = (v: RailVehicle): TripEntry | null => book.get(v.trip, h.nowMs(), marksOf);
  /** the world's moment at the last look for trips: when the clock ran on while the world stood still (a pause, the big map open), the trams are put anew */
  let lastMs = 0;
  /** the stops of the trip at the mark `mark` of piece `path` (null: not known where its stops are) */
  const callsAt = (e: TripEntry, path: number, mark: number): number[] | null => {
    if (!e.marks) return null;
    const out: number[] = [];
    for (const [m, k] of e.marks.get(path) ?? []) if (Math.abs(m - mark) < 1.5) out.push(k);
    return out;
  };
  return {
    due: (x, z, r0, r1, all) => {
      const tt = h.timetable();
      const lines = h.lines();
      const rail = h.rail();
      const out: ReturnType<RailSchedule['due']> = [];
      if (!tt || !lines) return out;
      const ms = h.nowMs();
      const jumped = lastMs > 0 && Math.abs(ms - lastMs) > JUMP_MS;
      lastMs = ms;
      if (jumped) {
        // (they come again at once where their trips are now)
        rail.resync();
        return out;
      }
      book.prune(ms);
      const now = serviceTime(new Date(ms));
      const day = ms - now.s * 1000;
      for (const line of tt.lines) {
        const stops = line ? lines.lines[line.index]?.stops : undefined;
        if (!line || !stops) continue;
        for (const trip of tripsAt(tt, line.index, now, LEAD)) {
          const p = trip.pattern;
          const a = stops[p.lineStops[trip.from]];
          const b = stops[p.lineStops[trip.to]];
          if (!a || !b) continue;
          const spot = rail.lineSpot(line.index, a, b, trip.standing ? 0 : trip.frac);
          if (!spot) continue;
          rail.net.sample(spot.path, spot.s, smp);
          const d = Math.hypot(smp.x - x, smp.z - z);
          // (one standing at its first stop until it leaves may appear close by: it has come in to start its trip there)
          const starting = trip.standing && trip.from === 0;
          if (d > r1 || (!all && !starting && d < r0)) continue;
          const name = book.name('tram', line.index, trip, day, () => marksOf(p));
          if (book.done(name)) continue;
          out.push({ trip: name, line: line.index, path: spot.path, s: spot.s, dir: spot.dir, k: spot.k, speed: trip.standing ? 0 : 9, ...(trip.standing ? { dwell: trip.until - now.s } : {}) });
        }
      }
      return out;
    },
    wait: (v, path, mark) => {
      const e = entry(v);
      if (!e) return 0;
      bind(e);
      const ks = callsAt(e, path, mark);
      const p = e.pattern;
      // (where its stops are not known: no more than the doors take)
      const now = since(e, h.nowMs());
      const k = ks ? nearestCall(e, ks, now) : -1;
      if (k < 0) return 0;
      e.last = k;
      if (k === p.stops.length - 1 && !p.post) return 0;
      return e.t0 + p.dep[k] - now;
    },
    calls: (v, path, mark) => {
      const e = entry(v);
      const ks = e ? callsAt(e, path, mark) : null;
      return !ks || ks.length > 0;
    },
    pace: (v, path, mark, dist) => {
      const e = entry(v);
      const ks = e ? callsAt(e, path, mark) : null;
      if (!e || !ks || ks.length === 0) return Infinity;
      const now = since(e, h.nowMs());
      const k = nearestCall(e, ks, now);
      return paceFor(dist, arriveBy(e, k) - now);
    },
    toward: (v) => {
      const e = entry(v);
      const stops = e ? h.lines()?.lines[e.pattern.line.index]?.stops : undefined;
      if (!e || !stops) return null;
      bind(e);
      for (let k = e.last + 1; k < e.pattern.stops.length; k++) {
        const st = stops[e.pattern.lineStops[k]];
        if (st) return { path: st[0], mark: st[1] };
      }
      return null;
    },
    ends: (v) => {
      const e = entry(v);
      if (!e || e.last !== e.pattern.stops.length - 1 || e.pattern.post) return false;
      e.done = true;
      return true;
    },
  };
}

// ---------------------------------------------------------------- the buses

/** The world's clock jumped: the buses of the timetables go, and come again at once where their trips are then. */
export function resyncBuses(traffic: Traffic): void {
  for (let i = traffic.cars.length - 1; i >= 0; i--) if (traffic.cars[i].bus?.trip) traffic.removeCar(traffic.cars[i]);
  traffic.busSchedule?.reset();
}

export interface BusScheduleHost {
  timetable(): Timetable | null;
  /** where the trips are on their lines' roads (spectate.ts transitSource) */
  source(): TransitSource | null;
  traffic(): Traffic;
  nowMs(): number;
}

/** how many buses of the timetables may be about the player at once */
const BUS_CAP = 10;
/** the least a bus of the timetable stands at a stop (s) */
const BUS_DWELL = 8;
/** a bus this far from where its trip is by the timetable (m) is put there anew, out of the player's sight */
const BUS_MISPLACED = 300;

/**
 * The timetable as the buses of the traffic keep to it (Traffic.busSchedule):
 * the buses of the lines that have timetables come where and when their
 * trips are, and stand at a stop until their time.
 */
export function busSchedule(h: BusScheduleHost): BusSchedule {
  const book = new TripBook(() => h.timetable());
  let timer = 0;
  let fresh = true;
  let lastMs = 0;
  const proj = { s: 0, off: 0, d2: 0, seg: 0 };
  const entryOf = (car: TrafficCar): TripEntry | null => book.get(car.bus?.trip, h.nowMs(), () => null);
  const sch: BusSchedule = {
    timed: (line) => !!h.timetable()?.buses[line],
    reset: () => {
      fresh = true;
      timer = 0;
    },
    step: (dt, player) => {
      timer -= dt;
      if (timer > 0) return;
      timer = 2;
      const tt = h.timetable();
      const src = h.source();
      const lines = src?.busLines();
      const traffic = h.traffic();
      if (!tt || !src || !lines || traffic.targetCount <= 0) return;
      const ms = h.nowMs();
      // (the clock ran on while the world stood still – a pause, the big map open: the buses are put anew where their trips are now)
      if (lastMs > 0 && Math.abs(ms - lastMs) > JUMP_MS) resyncBuses(traffic);
      lastMs = ms;
      const all = fresh;
      fresh = false;
      book.prune(ms);
      const now = serviceTime(new Date(ms));
      const day = ms - now.s * 1000;
      const r0 = 170;
      const r1 = traffic.spawnRadius;
      const stops = src.stops();
      const found: Array<{ name: string; d: number; line: number; trip: TripState; x: number; z: number; k: number }> = [];
      tt.buses.forEach((tl, li) => {
        const line = lines.lines[li];
        if (!tl || !line) return;
        for (const trip of busTripsAt(tt, li, now, LEAD)) {
          const p = trip.pattern;
          // (far off by its stops: not worked out further)
          const pa = stops?.places[p.places[trip.from]];
          if (pa && Math.hypot(pa.x - player.x, pa.z - player.z) > r1 + 1500) continue;
          const spot = spotOf(src, { kind: 'bus', line: li, fromStop: p.lineStops[trip.from] ?? -1, toStop: p.lineStops[trip.to] ?? -1, fromPlace: p.places[trip.from] ?? -1, toPlace: p.places[trip.to] ?? -1, standing: trip.standing, frac: trip.frac });
          if (!spot || spot.k === undefined) continue;
          const d = Math.hypot(spot.x - player.x, spot.z - player.z);
          // (one standing at its first stop until it leaves may appear close by: it has come in to start its trip there)
          if (d > r1 || (!all && d < r0 && !(trip.standing && trip.from === 0))) continue;
          const name = book.name('bus', li, trip, day, () => null);
          if (!book.done(name)) found.push({ name, d, line: li, trip, x: spot.x, z: spot.z, k: spot.k });
        }
      });
      found.sort((a, b) => a.d - b.d);
      let n = traffic.cars.filter((c) => c.bus?.trip).length;
      for (const f of found) {
        const had = traffic.cars.find((c) => c.bus?.trip === f.name);
        if (had) {
          // far from where its trip is, and the player close to neither: put there anew
          if (Math.hypot(had.x - f.x, had.z - f.z) < BUS_MISPLACED || Math.hypot(had.x - player.x, had.z - player.z) < r0 || f.d < r0) continue;
          traffic.removeCar(had);
          n--;
        }
        if (n >= BUS_CAP) break;
        const line = lines.lines[f.line];
        const w = line.ways[f.k];
        if (w === undefined || w < 0) continue;
        const el = traffic.graph.edgeLanes[w >> 1];
        const lanes = el ? ((w & 1) === 0 ? el.fwd : el.back) : [];
        const lane: Lane | undefined = lanes.find((l) => l.idx === 0) ?? lanes[0];
        if (!lane) continue;
        projectOnPolyline(lane.edge.pl, f.x, f.z, proj);
        // (its front a few metres short of where the timetable has it: one standing at its stop pulls up to the pole)
        const along = Math.max(6, Math.min(lane.len - 6, (lane.dir > 0 ? proj.s - lane.s0 : lane.s0 - proj.s) - 10));
        if (lane.len < 14) continue;
        // (room on the lane)
        if (traffic.carsOn(lane)?.some((o) => Math.abs(o.s - along) < 22)) continue;
        const p = f.trip.pattern;
        const car = traffic.addCar(lane, along, true, { ref: line.ref, to: p.dests[f.trip.from] || line.to, index: f.line, k: f.k, off: 0 });
        if (!car.bus) continue;
        car.bus.trip = f.name;
        if (f.trip.standing) car.v = 0;
        n++;
      }
    },
    dwell: (car, pole, least) => {
      const bus = car.bus;
      const e = entryOf(car);
      if (!bus || !e) return least;
      bind(e);
      const p = e.pattern;
      const place = stopPlaceOf(pole);
      const ks: number[] = [];
      for (let k = 0; k < p.places.length; k++) if (p.places[k] === place) ks.push(k);
      const now = since(e, h.nowMs());
      const k = nearestCall(e, ks, now);
      if (k < 0) return Math.min(least, BUS_DWELL * 1.5);
      e.last = k;
      if (k === p.stops.length - 1 && !p.post) {
        // the end of its trip: everybody gets off, and it goes
        bus.retired = true;
        e.done = true;
        return BUS_DWELL * 1.5;
      }
      return Math.max(BUS_DWELL, Math.min(600, e.t0 + p.dep[k] - now));
    },
  };
  return sch;
}

