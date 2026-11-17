// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Police cars, ambulances, fire engines and the emergency doctor's car – and
 * how everybody makes way for them.
 *
 * Now and then – every few minutes in town, more rarely outside – one of them
 * is called out near the player: it turns up some way off and drives through
 * with blue lights and siren to where it is called.  It goes faster than the
 * limit, crosses red lights and the others' right of way slowly and only once
 * it sees the way is clear, and passes whoever is in front of it.  The others
 * make way (§ 38 Abs. 1 StVO): the cars ahead pull over to the right and slow
 * down or stop, those coming towards it keep right and slow down, and at the
 * junctions it crosses everybody waits before the line.  On a road with two
 * or more lanes in its direction they leave the emergency corridor
 * (Rettungsgasse, § 11 Abs. 2 StVO): the left-most lane moves to the left, all
 * the others to the right, and it drives through the gap between them.
 * Police cars also go about on patrol among the traffic, without lights.
 *
 * An emergency vehicle is an ordinary car of the traffic with `em` set.  Its
 * style (EM_STYLE …) says what it is and whether its blue lights are on, so
 * that the drawing – and the replay of a drive – need nothing else.  A car's
 * place across its lane is `TrafficCar.side`.
 *
 * The traffic (src/sim/traffic.ts) asks this module at a few points of every
 * car's step: how fast it may go (desired), where it has to stop (stopFor),
 * what is in front of an emergency vehicle (lead), and whether one may go on
 * into a junction (through).  The rule monitor asks how the player behaved
 * (judge), the game what the instructor says about it (tip).
 */
import { clamp, newPolySample, rng } from '../core/geom.ts';
import { LaneGraph, TURN, lanePoint } from '../world/lanes.ts';
import type { Connector, Lane } from '../world/lanes.ts';
import { CLS, CTRL, EF, ROLE } from '../world/types.ts';
import type { Node } from '../world/world.ts';
import type { PlayerSnapshot, Severity } from './rules.ts';
import { SIG } from './signals.ts';
import type { PlayerState, Traffic, TrafficCar } from './traffic.ts';

/** The kinds of emergency vehicle. */
export const EM = { POLICE: 0, AMBULANCE: 1, FIRE: 2, DOCTOR: 3 } as const;

/**
 * The style numbers (TrafficCar.style) of the emergency vehicles: EM_STYLE +
 * kind · 2, and one more while the blue lights are on.  (0 … 2 are the
 * ordinary cars, 3 the city bus.)
 */
export const EM_STYLE = 8;

/** The style of an emergency vehicle of this kind, its blue lights on or off. */
export function emStyle(kind: number, lit: boolean): number {
  return EM_STYLE + kind * 2 + (lit ? 1 : 0);
}

/** The kind (EM) of a car of the traffic by its style; −1 for any other car. */
export function emKind(style: number): number {
  return style >= EM_STYLE && style < EM_STYLE + 8 ? (style - EM_STYLE) >> 1 : -1;
}

/** Are the blue lights of a car of this style on? */
export function emLit(style: number): boolean {
  return emKind(style) >= 0 && ((style - EM_STYLE) & 1) === 1;
}

/** Length and width of each kind (m): the patrol car (an estate), the ambulance (a van with a box body), the fire engine, the doctor's car. */
export const EM_SIZE: ReadonlyArray<{ readonly length: number; readonly width: number }> = [
  { length: 4.75, width: 1.84 },
  { length: 6.95, width: 2.3 },
  { length: 8.6, width: 2.5 },
  { length: 4.85, width: 1.9 },
];

/** The paint of each kind (what the record of a drive keeps of it: the models carry their own livery). */
const EM_PAINT = [0xc9ced3, 0xf3f3ef, 0xb3201c, 0xf3f3ef];

/** What makes a car of the traffic an emergency vehicle. */
export interface EmergencyCar {
  /** EM */
  kind: number;
  /** on a call: blue lights and siren on (false: a police car on patrol) */
  call: boolean;
  /** the connectors of its way after the one it takes next, in order (Traffic.nextFor hands them out) */
  route: Connector[];
  /** the last connector of its way: a little beyond it, it has arrived */
  last: Connector | null;
  /** seconds since the call began */
  t: number;
  /** the pitch of its horn (about 1) and where it is in the rhythm of its lights and horn (s) */
  pitch: number;
  phase: number;
  /**
   * Worked out at the start of every step: the nearest vehicle ahead it
   * cannot pass – the gap to it (m, Infinity: none) and its speed along the
   * way –, how fast it may squeeze past the others (m/s), where across its
   * lane it wants to be (m, + left), and how fast it wanted to go last.
   */
  gap: number;
  gapV: number;
  passV: number;
  target: number;
  want: number;
  /** what the instructor has said about it, and which of the player's faults it has seen (bits) */
  told: number;
  faults: number;
  /** the car it has been held up behind (its id, −1: none) and for how long (s) */
  stuckOn: number;
  stuckT: number;
}

/** How a car makes way in this step: at most this fast (m/s), stopping this far ahead of its front (m), this far across its lane (m, + left). */
interface Way {
  cap: number;
  stop: number;
  side: number;
}

/** A piece of an emergency vehicle's way – a lane, or a path through a junction – and how far ahead of its middle the piece begins (m). */
interface Piece {
  lane: Lane | null;
  conn: Connector | null;
  at: number;
}

/** An emergency vehicle on its call, in this step: its way ahead and the junctions on it. */
interface Run {
  car: TrafficCar;
  pieces: Piece[];
  /** the junctions on its way: how far ahead the path through each begins (m; below 0 it is in it), and in how many seconds it is there */
  nodes: Array<{ node: Node; d: number; eta: number }>;
}

/** Where something is as an emergency vehicle sees it: how far ahead of its middle (m), how far left of the middle of its way (m), and whether it goes the same way. */
interface Seen {
  along: number;
  lat: number;
  same: boolean;
  /** on which piece of its way (0: the one it is on) */
  piece: number;
}

/** A fault of the player's for the rule monitor. */
export interface EmergencyFault {
  id: string;
  severity: Severity;
}

/** how far ahead an emergency vehicle looks along its way (m) */
const REACH = 260;
/** the others wait at a junction it crosses from this many seconds before it gets there */
const HOLD_T = 9;

const tmp = newPolySample();

/** Where the middle of a lane is across its road, seen in its own direction of travel (m, + left of the road's middle). */
function latOf(lane: Lane): number {
  return lane.off * lane.dir;
}

export class Emergencies {
  readonly traffic: Traffic;
  /** calls come by themselves now and then (false: only those sent with dispatch) */
  auto = true;
  /** the seconds between two calls, when given (0: every few minutes, by where the player is) */
  readonly every: number;
  /** the share of the traffic's new cars that are police cars on patrol */
  patrolShare = 0.015;
  /** whether the player's driving is judged (not on a demonstration drive: the automatic driver does not make way) */
  judging = true;
  private readonly rand = rng(20261116);
  private time = 0;
  /** seconds until the next call */
  private wait: number;
  /** the highest number of a car seen so far (those above it are new) */
  private seenId = 0;
  private readonly runs: Run[] = [];
  private readonly ways = new Map<TrafficCar, Way>();
  private readonly wayPool: Way[] = [];
  /** where a car that stops to make way comes to rest: its lane or path, and the place of its front there */
  private readonly holds = new WeakMap<TrafficCar, { on: Lane | Connector; s: number }>();
  private player: PlayerState | null = null;
  private readonly seen: Seen = { along: 0, lat: 0, same: true, piece: 0 };
  private readonly seen2: Seen = { along: 0, lat: 0, same: true, piece: 0 };
  private readonly leadOut = { gap: Infinity, v: 0 };
  /** the player and the nearest emergency vehicle in this step (judged in judge) */
  private readonly pj: { blocking: boolean; corridor: boolean; junction: boolean; car: TrafficCar | null } = { blocking: false, corridor: false, junction: false, car: null };
  private blockT = 0;
  private corridorT = 0;
  private lastLane: Lane | null = null;
  private lastFront = 0;
  private pendingTip: string | null = null;
  private tipAt = 0;
  private readonly faults: EmergencyFault[] = [];

  /** `every`: a call every so many seconds (for trying it out: ?emergency=<seconds>), 0 for every few minutes. */
  constructor(traffic: Traffic, every = 0) {
    this.traffic = traffic;
    this.every = every > 0 ? every : 0;
    this.wait = this.every > 0 ? this.every : 70 + this.rand() * 80;
  }

  // --- every step, before the cars move ------------------------------------------------

  /** Called by the traffic at the start of its step: calls begin and end, and everybody works out how to make way. */
  update(dt: number, player: PlayerState): void {
    this.time += dt;
    this.player = player;
    const cars = this.traffic.cars;
    // the end of a call; police cars on patrol among the new cars
    let calls = 0;
    let maxId = this.seenId;
    for (const car of cars) {
      if (car.id > this.seenId) {
        this.patrol(car);
        maxId = Math.max(maxId, car.id);
      }
      const em = car.em;
      if (!em?.call) continue;
      em.t += dt;
      if (this.arrived(car)) this.endCall(car);
      else calls++;
    }
    this.seenId = maxId;
    // a new call now and then (not while one is still under way)
    if (this.auto && this.traffic.targetCount > 0) {
      this.wait -= dt;
      if (this.wait <= 0) {
        if (calls === 0 && this.call(player)) this.wait = this.every || this.interval(player);
        else this.wait = this.every ? Math.min(this.every, 15) : 15;
      }
    }
    // the way ahead of each one on its call, what is in it – and how each of the others makes way
    this.runs.length = 0;
    for (const car of cars) if (car.em?.call) this.runs.push(this.runOf(car));
    for (const w of this.ways.values()) this.wayPool.push(w);
    this.ways.clear();
    for (const run of this.runs) this.clearWay(run, dt);
    for (const car of cars) {
      if (car.em?.call) continue;
      const w = this.runs.length > 0 ? this.makeWay(car) : null;
      if (!w || w.stop === Infinity) this.holds.delete(car);
    }
    // everybody moves across the lane to where it wants to be
    for (const car of cars) this.slideAcross(car, dt);
    this.watchPlayer(player);
  }

  /** The way of an emergency vehicle ahead of it: the lanes and paths through junctions it will drive along. */
  private runOf(car: TrafficCar): Run {
    const em = car.em as EmergencyCar;
    const pieces: Piece[] = [];
    const nodes: Run['nodes'] = [];
    let at = -car.s;
    let lane = car.lane;
    let conn = car.conn;
    // (the connectors to come: on a lane the next one, then those of its way)
    let k = car.lane ? -1 : 0;
    const v = Math.max(car.v, 4);
    for (let hop = 0; hop < 16 && at < REACH; hop++) {
      if (conn) {
        pieces.push({ lane: null, conn, at });
        nodes.push({ node: conn.node, d: at, eta: Math.max(0, at - car.length / 2) / v });
        at += conn.len;
        lane = conn.to;
        conn = null;
      } else if (lane) {
        pieces.push({ lane, conn: null, at });
        at += lane.len;
        const c: Connector | null | undefined = k < 0 ? car.next : em.route[k];
        k++;
        if (!c || c.from !== lane) break;
        conn = c;
        lane = null;
      } else break;
    }
    return { car, pieces, nodes };
  }

  /**
   * Where something on the road is as the emergency vehicle of `run` sees it
   * – on a lane of a road on its way (either direction) or on a path of its
   * way through a junction; false if it is elsewhere.  `s`: its middle along
   * the lane or path; `side`: how far left of the middle of its lane it is.
   */
  private see(run: Run, lane: Lane | null, conn: Connector | null, s: number, side: number, out: Seen): boolean {
    const pieces = run.pieces;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (lane && p.lane && p.lane.edge === lane.edge) {
        // (the lanes of a road are measured alike: by the stations of the road)
        const same = lane.dir === p.lane.dir;
        out.along = p.at + (lane.s0 + lane.dir * s - p.lane.s0) * p.lane.dir;
        out.lat = (lane.off - p.lane.off) * p.lane.dir + (same ? side : -side);
        out.same = same;
        out.piece = i;
        return true;
      }
      if (conn && p.conn === conn) {
        out.along = p.at + s;
        out.lat = side;
        out.same = true;
        out.piece = i;
        return true;
      }
    }
    return false;
  }

  /**
   * What lies ahead of an emergency vehicle: the nearest vehicle in its way
   * that it cannot pass (beside it there is not room enough), how fast it
   * may squeeze past those it can, and where across its lane it wants to be –
   * in the corridor on a road with several lanes, else as far to the left as
   * the cars at the right need and the road and the oncoming traffic allow.
   */
  private clearWay(run: Run, dt: number): void {
    const car = run.car;
    const em = car.em as EmergencyCar;
    const half = car.width / 2;
    const side = car.side ?? 0;
    const seen = this.seen;
    let gap = Infinity;
    let gapV = 0;
    let passV = Infinity;
    let blocker: TrafficCar | null = null;
    const lane = car.lane;
    const lanes = lane ? this.carriageway(lane) : null;
    // (where it wants to be across a road with one lane in its direction: past the cars at the right, as far as there is
    // room – going by those on the piece of road it is on; in a junction by those on its path there and just beyond)
    let need = lane ? 0.35 : 0;
    let room = lane ? lane.edge.width / 2 - 0.2 - half - latOf(lane) : 1.6;
    const near = lane ? 0 : 1;
    const look = (len: number, width: number, v: number, other: TrafficCar | null): void => {
      const reach = (car.length + len) / 2;
      const g = seen.along - reach;
      if (seen.along < -reach || g > 150) return;
      const clear = Math.abs(seen.lat - side) - half - width / 2;
      if (clear < 0.25) {
        // in its way: it stays behind (the player is seen by the traffic itself)
        if (other && seen.along > 0 && g < gap) {
          gap = Math.max(0, g);
          gapV = seen.same ? v : 0;
          blocker = other;
        }
      } else if (clear < 1.3 && g < 12 + car.v * 1.5) {
        // squeezing past: slowly – a little faster than the one it passes, if that is moving
        passV = Math.min(passV, Math.max(7 + 6 * clear, (seen.same ? v : 0) + 4 + 4 * clear));
      }
      // (from a little before it until its tail is past: beside it the room is needed most)
      if (seen.along < -reach - 2 || seen.piece > near) return;
      // (in a junction it does not swerve round anybody: it only keeps clear of whoever it is beside already)
      if (seen.same) {
        if (g < (lane ? 60 : 1)) need = Math.max(need, seen.lat + width / 2 + 0.3 + half);
      } else if (g < 70) room = Math.min(room, seen.lat - width / 2 - 0.3 - half);
    };
    for (const o of this.traffic.cars) {
      if (o === car || !this.see(run, o.lane, o.conn, o.s, o.side ?? 0, seen)) continue;
      look(o.length, o.width, o.v, o);
    }
    const p = this.player;
    if (p && !p.onFoot && p.lane && this.see(run, p.lane, null, p.s ?? 0, this.across(p), seen)) look(p.length, p.width, Math.abs(p.speed), null);
    // where across its lane
    let target = 0;
    if (lane && lanes) {
      if (lanes.length >= 2) {
        // the corridor: between the left-most lane and the one beside it
        const left = lanes[lanes.length - 1];
        target = latOf(left) - left.width / 2 - latOf(lane);
      } else target = Math.max(0, Math.min(need, room));
      // (coming up to a junction where it turns: back to the middle of its lane – unless it is passing somebody)
      if (car.next && car.next.turn !== TURN.STRAIGHT && lane.len - car.s < 14 + car.v && need <= 0.35) target = 0;
    } else {
      // through a junction: back to the middle of its path – but not into somebody beside it
      target = Math.max(0, Math.min(need, room));
    }
    // never across into anybody beside it – whatever lane or path they are on, the player too: how far there is
    // room to either side, from where they are now
    let lo = -Infinity;
    let hi = Infinity;
    const fx = -Math.sin(car.yaw);
    const fz = -Math.cos(car.yaw);
    const beside = (x: number, z: number, len: number, width: number): void => {
      const dx = x - car.x;
      const dz = z - car.z;
      if (Math.abs(dx) > 16 || Math.abs(dz) > 16) return;
      if (Math.abs(dx * fx + dz * fz) > (car.length + len) / 2 + 0.5) return;
      // (left of the way it faces, (fx, fz), is (fz, −fx))
      const left = dx * fz - dz * fx;
      const free = Math.max(0, Math.abs(left) - width / 2 - half - 0.2);
      if (left > 0) hi = Math.min(hi, side + free);
      else lo = Math.max(lo, side - free);
    };
    for (const o of this.traffic.cars) if (o !== car && Math.abs(o.y - car.y) < 3) beside(o.x, o.z, o.length, o.width);
    if (p && !p.onFoot && Math.abs(p.y - car.y) < 3) beside(p.x, p.z, p.length, p.width);
    target = lo > hi ? side : Math.min(hi, Math.max(lo, target));
    // held up behind somebody who cannot make room: after a while that one drives on, slowly, to clear the way
    const b = blocker as TrafficCar | null;
    if (b && gap < 20) {
      if (em.stuckOn !== b.id) {
        em.stuckOn = b.id;
        em.stuckT = 0;
      } else if (car.v < 3) em.stuckT += dt;
    } else {
      em.stuckOn = -1;
      em.stuckT = 0;
    }
    em.gap = gap;
    em.gapV = gapV;
    em.passV = passV;
    em.target = target;
  }

  /** How a car makes way for the emergency vehicles on their calls (null: it need not). */
  private makeWay(car: TrafficCar): Way | null {
    let way: Way | null = null;
    for (const run of this.runs) {
      const w = this.wayFor(run, car);
      if (!w) continue;
      if (!way) {
        way = this.wayPool.pop() ?? { cap: Infinity, stop: Infinity, side: 0 };
        way.cap = w.cap;
        way.stop = w.stop;
        way.side = w.side;
        continue;
      }
      way.cap = Math.min(way.cap, w.cap);
      way.stop = Math.min(way.stop, w.stop);
      if (Math.abs(w.side) > Math.abs(way.side)) way.side = w.side;
    }
    if (way) this.ways.set(car, way);
    return way;
  }

  private readonly w: Way = { cap: Infinity, stop: Infinity, side: 0 };

  /** How a car makes way for one emergency vehicle (null: not at all) – the answer is only good until the next call. */
  private wayFor(run: Run, car: TrafficCar): Way | null {
    const e = run.car;
    const em = e.em as EmergencyCar;
    const w = this.w;
    w.cap = Infinity;
    w.stop = Infinity;
    w.side = 0;
    const seen = this.seen2;
    // waiting at the junction it is about to cross (unless over the line already, or too close to stop)
    const hold = (): Way | null => {
      const lane = car.lane;
      if (!lane || !car.next) return null;
      for (const n of run.nodes) {
        if (n.node !== lane.to) continue;
        // (on the motorway nobody stops where it merges: they make way as they go – nor in a roundabout, nor inside
        // a junction made of several: they would block it)
        if (n.eta > HOLD_T || n.d > 160 || n.node.ctrl === CTRL.MERGE || n.node.ctrl === CTRL.ROUNDABOUT || lane.len < 25 || lane.edge.flags & EF.ROUNDABOUT) return null;
        const d = lane.stopAt - car.s - car.length / 2;
        if (d < -1 || d < (car.v * car.v) / 9 - 1) return null;
        w.stop = Math.max(0, d);
        w.side = 0;
        return w;
      }
      return null;
    };
    if (this.see(run, car.lane, car.conn, car.s, car.side ?? 0, seen)) {
      const reach = (e.length + car.length) / 2;
      const g = seen.along - reach;
      const lane = car.lane ?? (car.conn as Connector).to;
      const limit = Number.isFinite(lane.limit) ? lane.limit : 36;
      if (seen.same) {
        // ahead of it on its way: aside – and slower, near it to a stop
        if (seen.along < -reach - 10 || g > REACH) return null;
        w.side = car.conn ? (car.side ?? 0) : this.aside(lane, car, false);
        // (in a junction – in a roundabout, between the nodes of a junction made of several – out of it first)
        if (car.conn || lane.len < 25 || lane.edge.flags & EF.ROUNDABOUT) return w;
        // it cannot pass, and has waited: the queue in front of it drives on, slowly, to clear the way
        if (em.stuckOn >= 0 && em.stuckT > 2.5 && seen.along > 0 && g < 120) {
          w.cap = Math.max(6, limit * 0.6);
          return w;
        }
        // (on a motorway in flowing traffic: aside, but on)
        if (lane.edge.cls <= CLS.TRUNK_LINK && car.v > 12) {
          w.cap = limit * 0.7;
          return w;
        }
        if (g < 70 || seen.along <= 0 || car.v < 5) w.stop = this.stopHere(car);
        else w.cap = Math.max(5, limit * 0.5);
        return w;
      }
      // coming towards it: keep right and slow down – at a crawl where the road is narrow (or wait at the junction it crosses)
      if (seen.along < -reach || g > 180) return null;
      if (hold()) return w;
      w.side = car.conn ? (car.side ?? 0) : this.aside(lane, car, true);
      const narrow = this.carriageway(lane).length === 1 && lane.edge.width < 7.6;
      w.cap = narrow && g < 50 ? 2.5 : Math.max(5, limit * 0.5);
      return w;
    }
    return hold();
  }

  /**
   * How far a car on `lane` moves across to make way (m, + left): from the
   * left-most lane of a road with several to the left, from every other one
   * to the right (`right`: to the right in any case) – as far as there is room.
   */
  private aside(lane: Lane, car: TrafficCar, right: boolean): number {
    const lanes = this.carriageway(lane);
    const toLeft = !right && lanes.length >= 2 && lane.idx === lanes.length - 1;
    const e = lane.edge;
    // (at the edge of the road the strip beside the lanes – and the kerb, half onto which it may go;
    // towards the middle of a road with traffic both ways only a little over the line)
    const outer = toLeft ? (e.lanesF > 0 && e.lanesB > 0 ? 0.1 : e.margin + 0.2) : lane.idx === 0 ? e.margin + 0.45 : 0.15;
    const pull = clamp((lane.width - car.width) / 2 + outer, 0.3, 1.4);
    return toLeft ? pull : -pull;
  }

  /**
   * How far ahead of its front a car that stops to make way comes to rest
   * (m): braking gently, before the line if it is coming up to a junction –
   * or, too close to the line for that, not at all (it drives through first).
   */
  private stopHere(car: TrafficCar): number {
    const on: Lane | Connector | null = car.lane ?? car.conn;
    if (!on) return Infinity;
    const front = car.s + car.length / 2;
    let h = this.holds.get(car);
    if (!h || h.on !== on) {
      let s = front + Math.max(2, (car.v * car.v) / (2 * 2.2));
      if (car.lane && s > car.lane.stopAt - 0.5) {
        const line = car.lane.stopAt - 0.5;
        if (line - front < (car.v * car.v) / (2 * 4.5) - 0.5) return Infinity;
        s = Math.max(front, line);
      }
      h = { on, s };
      this.holds.set(car, h);
    }
    return Math.max(0, h.s - front);
  }

  /** Move a car across its lane towards where it wants to be – slowly, a little faster when it drives. */
  private slideAcross(car: TrafficCar, dt: number): void {
    const em = car.em;
    const target = em?.call ? em.target : (this.ways.get(car)?.side ?? 0);
    const now = car.side ?? 0;
    if (now === 0 && target === 0) return;
    const rate = em?.call ? 0.9 + car.v * 0.05 : 0.35 + Math.min(car.v, 12) * 0.08;
    const next = now + clamp(target - now, -rate * dt, rate * dt);
    car.side = target === 0 && Math.abs(next) < 0.01 ? 0 : next;
  }

  // --- what the traffic asks while a car takes its step ------------------------------

  /**
   * The speed a car wants (m/s), given what it would want otherwise (`v0`)
   * and the limit: an emergency vehicle on its call goes faster – about
   * 20 km/h over the limit in town, up to 30 outside, slower where it squeezes
   * past the others –; a car that makes way slows down.
   */
  desired(car: TrafficCar, v0: number, limit: number): number {
    const em = car.em;
    if (em?.call) {
      // (in a bend, a roundabout or a junction it keeps the speed the others would take there)
      const free = v0 >= limit * car.temper - 1e-6;
      const want = Math.min(free ? limit + clamp(limit * 0.4, 4, 9) : v0, em.passV);
      em.want = want;
      return want;
    }
    const w = this.ways.get(car);
    return w ? Math.min(v0, w.cap) : v0;
  }

  /** How far ahead of its front a car has to stop to make way (m; Infinity: it need not). */
  stopFor(car: TrafficCar): number {
    return this.ways.get(car)?.stop ?? Infinity;
  }

  /** For an emergency vehicle on its call: the nearest vehicle ahead it cannot pass – the gap (m) and its speed along the way. */
  lead(car: TrafficCar): { gap: number; v: number } {
    const em = car.em;
    this.leadOut.gap = em ? em.gap : Infinity;
    this.leadOut.v = em ? em.gapV : 0;
    return this.leadOut;
  }

  /**
   * An emergency vehicle on its call `distToLine` metres before a junction
   * it crosses by `next`: where the way is the others' – a red light, a sign,
   * right before left – it may go all the same (§ 35 Abs. 1, § 38 Abs. 1 StVO),
   * but with care: up to the line no faster than it could still stop there,
   * and on only when nobody is in the junction or too close to stop before it.
   * Returns the speed it may have now (m/s; Infinity: no limit), or −1: wait
   * at the line.  `mustStop`: what would hold an ordinary car there.
   */
  through(car: TrafficCar, next: Connector, distToLine: number, mustStop: boolean): number {
    const lane = car.lane;
    if (!lane || distToLine < -1.5) return Infinity;
    const node = next.node;
    const arm = lane.armTo;
    const signals = this.traffic.signals;
    let care: boolean;
    if (arm.sg >= 0 && node.sc >= 0) {
      const st = signals.get(node.sc, arm.sg);
      care = st !== SIG.GREEN && !(next.turn === TURN.RIGHT && signals.arrow(arm) === SIG.GREEN);
    } else if (node.ctrl === CTRL.MERGE) {
      // (onto the motorway it merges like everybody else: into a gap – nobody stops for it there)
      return mustStop ? -1 : Infinity;
    } else care = (arm.role !== ROLE.PRIORITY && arm.role !== ROLE.NONE) || node.ctrl === CTRL.RBL || next.conflicts.some((k) => k.yield);
    // its own way is free: on as it is (what would hold an ordinary car there – the oncoming traffic when it turns
    // left on green, somebody in the junction – it takes with the same care: the others are waiting for it)
    if (!care && !mustStop) return Infinity;
    if (distToLine < 30 && !this.clear(car, next)) return -1;
    return Math.sqrt(4.5 * 4.5 + 2 * 2.5 * Math.max(0, distToLine));
  }

  /** Is the junction an emergency vehicle is about to cross by `next` free – nobody in it, nobody coming who could not stop any more? */
  private clear(car: TrafficCar, next: Connector): boolean {
    const traffic = this.traffic;
    if (!traffic.clearOf(next)) return false;
    const node = next.node;
    for (const k of next.conflicts) {
      const other = k.other;
      for (const o of traffic.cars) {
        if (o === car || o.lane !== other.from || (o.next !== null && o.next !== other)) continue;
        const d = other.from.stopAt - o.s - o.length / 2;
        if (d > -1.5 && o.v > 1.5 && d < (o.v * o.v) / 7 + 4) return false;
      }
    }
    for (const ped of traffic.peds) if (ped.state === 'cross' && Math.hypot(ped.x - node.x, ped.z - node.z) < 24) return false;
    const p = this.player;
    if (!p) return true;
    const dp = Math.hypot(p.x - node.x, p.z - node.z);
    if (p.onFoot) return !(dp < 14 && p.speed > 0.3);
    // the player coming into the junction from another side, too fast or too close to stop – or in it
    if (dp < 70 && p.lane && p.lane.to === node && p.lane.armTo !== car.lane?.armTo) {
      const d = p.lane.stopAt - ((p.s ?? 0) + p.length / 2);
      const v = Math.abs(p.speed);
      if (d > -30 && v > 1 && d < (v * v) / 6 + 5) return false;
    }
    return true;
  }

  // --- calls ---------------------------------------------------------------------

  /**
   * Send an emergency vehicle of `kind` (EM) out on a call: from `lane`, its
   * middle `s` metres along it, along `route` – the connectors to take one
   * after the other, the first at the end of `lane`.  Returns its car.
   */
  dispatch(kind: number, lane: Lane, s: number, route: readonly Connector[]): TrafficCar {
    const car = this.traffic.addCar(lane, s);
    const way = route.slice();
    this.equip(car, kind, true, way);
    if (way.length > 0 && way[0].from === lane) car.next = way.shift() as Connector;
    car.v = Math.min(Number.isFinite(lane.limit) ? lane.limit : 30, 14) * 0.9;
    return car;
  }

  /** Make a car of the traffic an emergency vehicle: its size, its paint, on a call or on patrol. */
  private equip(car: TrafficCar, kind: number, call: boolean, route: Connector[]): void {
    const size = EM_SIZE[kind];
    car.style = emStyle(kind, call);
    car.length = size.length;
    car.width = size.width;
    car.color = EM_PAINT[kind];
    car.temper = call ? 1 : 0.95;
    car.em = {
      kind,
      call,
      route,
      last: route[route.length - 1] ?? null,
      t: 0,
      pitch: 0.97 + this.rand() * 0.06,
      phase: this.rand() * 3,
      gap: Infinity,
      gapV: 0,
      passV: Infinity,
      target: 0,
      want: 0,
      told: 0,
      faults: 0,
      stuckOn: -1,
      stuckT: 0,
    };
  }

  /** Now and then a police car on patrol among the new cars of the traffic (one at a time). */
  private patrol(car: TrafficCar): void {
    if (car.em || car.bus || this.patrolShare <= 0 || this.rand() >= this.patrolShare) return;
    for (const o of this.traffic.cars) if (o.em && !o.em.call) return;
    this.equip(car, EM.POLICE, false, []);
  }

  /** Has it got where it was called – a little beyond the end of its way (or lost its way, or been out too long)? */
  private arrived(car: TrafficCar): boolean {
    const em = car.em as EmergencyCar;
    if (em.t > 300) return true;
    const last = em.last;
    if (!last) return em.t > 25;
    // (off its way: the next connector does not lead to the next of its way)
    if (car.lane && car.next && em.route.length > 0 && em.route[0].from !== car.next.to) return true;
    return car.lane === last.to && car.s > Math.min(40, car.lane.len * 0.6);
  }

  /** The call is over: lights and siren off, and on with the traffic (a police car on patrol). */
  private endCall(car: TrafficCar): void {
    const em = car.em as EmergencyCar;
    em.call = false;
    em.route.length = 0;
    em.target = 0;
    car.style = emStyle(em.kind, false);
    car.temper = 0.92 + this.rand() * 0.06;
  }

  /** Seconds until the next call: every few minutes in town, more rarely outside. */
  private interval(p: PlayerState): number {
    const urban = p.lane ? (p.lane.edge.flags & EF.URBAN) !== 0 : false;
    return urban ? 150 + this.rand() * 120 : 300 + this.rand() * 240;
  }

  /** Police, ambulance, fire engine, the doctor's car – about as often as they are out. */
  private pickKind(): number {
    const r = this.rand();
    return r < 0.35 ? EM.POLICE : r < 0.7 ? EM.AMBULANCE : r < 0.87 ? EM.FIRE : EM.DOCTOR;
  }

  /**
   * A call near the player: one coming up from behind on the player's road,
   * one crossing the junction ahead, one coming towards the player – or a
   * police car on patrol near by gets the call; where none of that can be
   * (the player is not on a road), one somewhere near.  False if none could
   * be sent.
   */
  private call(p: PlayerState): boolean {
    const kind = this.pickKind();
    const lane = p.onFoot ? null : (p.lane ?? null);
    if (this.rand() < 0.3 && this.patrolCall(p)) return true;
    if (lane) {
      const r = this.rand();
      const order = r < 0.5 ? [0, 1, 2] : r < 0.75 ? [1, 0, 2] : [2, 0, 1];
      for (const k of order) if (k === 0 ? this.fromBehind(p, lane, kind) : k === 1 ? this.fromSide(p, lane, kind) : this.fromAhead(p, lane, kind)) return true;
    }
    return this.somewhere(p, kind);
  }

  /** The lanes of `lane`'s road in its direction, right to left. */
  private carriageway(lane: Lane): Lane[] {
    const el = this.traffic.graph.edgeLanes[lane.edge.id];
    return el ? (lane.dir > 0 ? el.fwd : el.back) : [lane];
  }

  /** The lanes of `lane`'s road in the other direction, right to left. */
  private opposite(lane: Lane): Lane[] {
    const el = this.traffic.graph.edgeLanes[lane.edge.id];
    return el ? (lane.dir > 0 ? el.back : el.fwd) : [];
  }

  /** How the way goes on at the end of `lane` most likely: straight on, along the bigger road – never a U-turn, never onto a road an emergency vehicle should not take. */
  private onward(lane: Lane): Connector | null {
    let best: Connector | null = null;
    let bestScore = -Infinity;
    for (const c of lane.out) {
      if (c.turn === TURN.UTURN || !LaneGraph.drivable(c.to.edge, true)) continue;
      const score = (c.turn === TURN.STRAIGHT ? 3 : 0) + c.to.edge.tier * 0.5 + this.rand() * 1.5 - (c.to.edge.flags & EF.ROUNDABOUT ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  /** The same backwards: how one most likely came to `lane`. */
  private inward(lane: Lane): Connector | null {
    let best: Connector | null = null;
    let bestScore = -Infinity;
    for (const c of lane.in) {
      if (c.turn === TURN.UTURN || !LaneGraph.drivable(c.from.edge, true)) continue;
      const score = (c.turn === TURN.STRAIGHT ? 3 : 0) + c.from.edge.tier * 0.5 + this.rand() * 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  /** The way on from the end of `lane` for about `metres`, as connectors. */
  private wayOn(lane: Lane, metres: number, out: Connector[] = []): Connector[] {
    let d = 0;
    let l = lane;
    for (let i = 0; i < 40 && d < metres; i++) {
      const c = this.onward(l);
      if (!c) break;
      out.push(c);
      d += c.len + c.to.len;
      l = c.to;
    }
    return out;
  }

  /** Walk back from the end of `end` (its start lies `back` metres before the place aimed at) until `d` metres: the lane reached, how far along it, and the connectors from there. */
  private walkBack(end: Lane, back: number, d: number): { lane: Lane; s: number; path: Connector[] } | null {
    const path: Connector[] = [];
    let at = end;
    for (let i = 0; i < 24 && back < d; i++) {
      const c = this.inward(at);
      if (!c) return null;
      path.unshift(c);
      at = c.from;
      back += c.len + at.len;
    }
    if (back < d) return null;
    return { lane: at, s: back - d, path };
  }

  /** Is there room for an emergency vehicle to appear `s` metres along `lane` – nobody near on the road, and out of the player's sight? */
  private freeAt(lane: Lane, s: number, p: PlayerState): boolean {
    if (s < 6 || s > lane.len - 6) return false;
    for (const o of this.traffic.cars) if (o.lane && o.lane.edge === lane.edge && Math.abs(o.s - (lane.dir === o.lane.dir ? s : lane.len - s)) < 16) return false;
    lanePoint(lane, s, tmp);
    return Math.hypot(tmp.x - p.x, tmp.z - p.z) > 120 && Math.abs(tmp.y - p.y) < 40;
  }

  /** One coming up from behind along the player's road – it passes the player, who has to make way. */
  private fromBehind(p: PlayerState, lane: Lane, kind: number): boolean {
    const found = this.walkBack(lane, p.s ?? lane.len / 2, 170 + this.rand() * 110);
    if (!found || !this.freeAt(found.lane, found.s, p)) return false;
    this.dispatch(kind, found.lane, found.s, [...found.path, ...this.wayOn(lane, 250 + this.rand() * 150)]);
    return true;
  }

  /** One crossing the junction ahead of the player about when the player gets there – who has to wait before it. */
  private fromSide(p: PlayerState, lane: Lane, kind: number): boolean {
    const node = lane.to;
    const dist = lane.stopAt - ((p.s ?? 0) + p.length / 2);
    if (dist < 25 || dist > 260 || node.arms.length < 3 || node.ctrl === CTRL.MAP_END || node.stub) return false;
    const mine = lane.armTo;
    const from: Lane[] = [];
    for (const arm of node.arms) {
      // (from the side: about at right angles to the player's way)
      if (arm === mine || Math.abs(arm.dx * mine.dx + arm.dz * mine.dz) > 0.7) continue;
      for (const l of this.traffic.graph.lanesInto(arm)) if (l.idx === 0 && LaneGraph.drivable(l.edge, true)) from.push(l);
    }
    if (from.length === 0) return false;
    const into = from[Math.floor(this.rand() * from.length)];
    const across = this.onward(into);
    if (!across) return false;
    // (it gets there a little before the player)
    const d = clamp((dist / Math.max(Math.abs(p.speed), 7)) * 14, 110, 230);
    const found = this.walkBack(into, into.len, d);
    if (!found || !this.freeAt(found.lane, found.s, p)) return false;
    this.dispatch(kind, found.lane, found.s, [...found.path, across, ...this.wayOn(across.to, 250)]);
    return true;
  }

  /** One coming towards the player along the player's road. */
  private fromAhead(p: PlayerState, lane: Lane, kind: number): boolean {
    const d = 220 + this.rand() * 100;
    const fwd: Connector[] = [];
    let at = lane;
    let ahead = lane.len - (p.s ?? 0);
    for (let i = 0; i < 24 && ahead < d; i++) {
      const c = this.onward(at);
      if (!c) return false;
      fwd.push(c);
      at = c.to;
      ahead += c.len + at.len;
    }
    if (ahead < d) return false;
    // on that road the right-most lane the other way, at the same place
    const back = this.opposite(at)[0];
    if (!back) return false;
    const s = ahead - d;
    // its way back towards the player: at each junction into the road the player's way came along
    const route: Connector[] = [];
    let cur = back;
    for (let i = fwd.length - 1; i >= 0; i--) {
      const edge = fwd[i].from.edge;
      const c = cur.out.find((k) => k.to.edge === edge && k.turn !== TURN.UTURN);
      if (!c) return false;
      route.push(c);
      cur = c.to;
    }
    if (!this.freeAt(back, s, p)) return false;
    this.dispatch(kind, back, s, this.wayOn(cur, 250, route));
    return true;
  }

  /** A police car on patrol near the player gets a call: blue lights and siren on, and off it goes. */
  private patrolCall(p: PlayerState): boolean {
    for (const car of this.traffic.cars) {
      const em = car.em;
      if (!em || em.call || em.kind !== EM.POLICE || !car.lane || !car.next) continue;
      if (Math.hypot(car.x - p.x, car.z - p.z) > 350) continue;
      const route = this.wayOn(car.next.to, 450);
      if (route.length === 0) continue;
      em.call = true;
      em.route = route;
      em.last = route[route.length - 1];
      em.t = 0;
      em.told = 0;
      em.faults = 0;
      car.style = emStyle(EM.POLICE, true);
      car.temper = 1;
      return true;
    }
    return false;
  }

  /** One on a road somewhere near – heard more than seen. */
  private somewhere(p: PlayerState, kind: number): boolean {
    const near: Lane[] = [];
    const graph = this.traffic.graph;
    for (const e of this.traffic.world.allEdges) {
      const x = (e.minX + e.maxX) / 2;
      const z = (e.minZ + e.maxZ) / 2;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < 200 || d > 360 || !LaneGraph.drivable(e, true) || e.len < 40 || e.flags & EF.ROUNDABOUT) continue;
      const el = graph.edgeLanes[e.id];
      if (!el) continue;
      // (a lane that leads towards the player: it is heard coming, and passes near by)
      for (const l of [...el.fwd, ...el.back]) {
        if (l.idx !== 0) continue;
        lanePoint(l, l.len / 2, tmp);
        if ((p.x - tmp.x) * tmp.tx + (p.z - tmp.z) * tmp.tz > 0.3 * Math.hypot(p.x - tmp.x, p.z - tmp.z)) near.push(l);
      }
    }
    for (let tries = 0; tries < 6 && near.length > 0; tries++) {
      const lane = near[Math.floor(this.rand() * near.length)];
      const s = lane.len / 2;
      if (!this.freeAt(lane, s, p)) continue;
      this.dispatch(kind, lane, s, this.wayOn(lane, 400));
      return true;
    }
    return false;
  }

  // --- the player ------------------------------------------------------------------

  /** How far left of the middle of its lane the player is (m). */
  private across(p: PlayerState): number {
    if (!p.lane) return 0;
    lanePoint(p.lane, p.s ?? 0, tmp);
    // (left of the direction of travel (tx, tz) is (tz, -tx))
    return (p.x - tmp.x) * tmp.tz - (p.z - tmp.z) * tmp.tx;
  }

  /**
   * What the player does about the emergency vehicles near by: in front of
   * one, holding it up without having pulled over; in slow traffic on a road
   * with several lanes outside the corridor; into the junction it is about to
   * cross.  The instructor says what to do when one first comes near.
   */
  private watchPlayer(p: PlayerState): void {
    const pj = this.pj;
    pj.blocking = false;
    pj.corridor = false;
    if (!pj.junction) pj.car = null;
    const lane = p.lane ?? null;
    if (p.onFoot || !lane) {
      this.lastLane = null;
      return;
    }
    const s = p.s ?? 0;
    const front = s + p.length / 2;
    const across = this.across(p);
    const lanes = this.carriageway(lane);
    const crossed = this.lastLane === lane && this.lastFront < lane.stopAt && front >= lane.stopAt;
    this.lastLane = lane;
    this.lastFront = front;
    const seen = this.seen;
    // (aside: the left-most lane of several to the left, any other to the right)
    const leftmost = lanes.length >= 2 && lane.idx === lanes.length - 1;
    const aside = leftmost ? across > 0.4 : across < -0.4;
    for (const run of this.runs) {
      const car = run.car;
      const em = car.em as EmergencyCar;
      if (this.see(run, lane, null, s, across, seen)) {
        const g = seen.along - (car.length + p.length) / 2;
        if (seen.along <= 0 || g > 300) continue;
        if (!seen.same) {
          if (g < 200) this.say(em, 2, 'emTipOncoming');
          continue;
        }
        // coming up from behind
        if (g < 230) this.say(em, 1, lanes.length >= 2 ? 'emTipCorridor' : 'emTipBehind');
        // close behind the player, who has not made way: not moved over to the right on a road with one lane
        // this way – on one with several, still in the way it takes through the corridor
        const clear = Math.abs(seen.lat - em.target) - car.width / 2 - p.width / 2;
        if (g < 50 && (lanes.length >= 2 ? clear < 0.25 : !aside)) {
          pj.blocking = true;
          pj.car = car;
        }
        if (lanes.length >= 2 && Math.abs(p.speed) < 8.5 && g < 200 && !aside) {
          pj.corridor = true;
          pj.car = car;
        }
        continue;
      }
      // the junction ahead of the player, which it is about to cross
      for (const n of run.nodes) {
        if (n.node !== lane.to) continue;
        if (n.d < 180 && front < lane.stopAt + 1) this.say(em, 4, 'emTipJunction');
        if (crossed && (n.d < 80 || n.eta < 6)) {
          pj.junction = true;
          pj.car = car;
        }
      }
    }
  }

  /** The instructor's word about an emergency vehicle (each thing once). */
  private say(em: EmergencyCar, bit: number, key: string): void {
    if (em.told & bit) return;
    em.told |= bit;
    this.pendingTip = key;
    this.tipAt = this.time;
  }

  /** What the instructor says about the emergency vehicle that has just come near: a text key, once – or null. */
  tip(): string | null {
    const t = this.pendingTip;
    this.pendingTip = null;
    return t !== null && this.time - this.tipAt < 2 ? t : null;
  }

  /**
   * The player's faults (for the rule monitor, every step): holding up an
   * emergency vehicle for more than a few seconds without making way, no
   * corridor in slow traffic on a road with several lanes, into the junction
   * it is about to cross.  Each once for each emergency vehicle.
   */
  judge(dt: number, _p: PlayerSnapshot): readonly EmergencyFault[] {
    const out = this.faults;
    out.length = 0;
    const pj = this.pj;
    if (!this.judging) {
      this.blockT = this.corridorT = 0;
      pj.junction = false;
      return out;
    }
    this.blockT = pj.blocking ? this.blockT + dt : Math.max(0, this.blockT - dt);
    this.corridorT = pj.corridor ? this.corridorT + dt : Math.max(0, this.corridorT - dt * 2);
    const em = pj.car?.em;
    if (em) {
      if (this.corridorT > 5 && !(em.faults & 2)) {
        em.faults |= 2;
        out.push({ id: 'emergencyCorridor', severity: 'major' });
      } else if (this.blockT > 4 && !(em.faults & 3)) {
        em.faults |= 1;
        out.push({ id: 'emergencyBlock', severity: 'major' });
      }
      if (pj.junction && !(em.faults & 4)) {
        em.faults |= 4;
        out.push({ id: 'emergencyJunction', severity: 'major' });
      }
    }
    pj.junction = false;
    return out;
  }
}
