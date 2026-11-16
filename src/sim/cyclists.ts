// SPDX-License-Identifier: AGPL-3.0-only
/**
 * People on bicycles.
 *
 * They ride on the pavement side of the rightmost lane of a street in town
 * (the cycle track beside the carriageway), straight on through the
 * junctions, at 14 to 26 km/h.  That puts them exactly where the driver of a
 * vehicle that turns right has to look for them: beside and behind, where
 * the mirrors do not show them (§ 9 Abs. 3 StVO: whoever turns lets the
 * cyclists who ride straight on pass first).
 *
 * Some just ride around near the player.  Others are sent along on purpose,
 * out of sight, when the player's vehicle comes up to a junction where it
 * can turn right:
 *
 *  - one rides ahead on the cycle track; the vehicle passes them before the
 *    junction, and they arrive there a moment after it – beside its rear
 *    when it wants to turn;
 *  - one comes up from far behind while the vehicle waits at the line (a
 *    red light, a give-way sign), and stands or rides beside it when it
 *    sets off.
 *
 * Whoever looks over the shoulder sees them and lets them pass.  Whoever
 * does not is in their way: they brake hard (`cyclistEndangered`), or are
 * knocked over (`hit`).
 *
 * Towards everything else they ride defensively: they stop at red lights
 * and for whatever stands or drives on their line.  The cars of the traffic
 * wait for them before turning right (`blocksRightTurn`) and brake for them
 * like for anything else in their way.
 */
import { clamp, newPolySample, rng, samplePolyline } from '../core/geom.ts';
import { LaneGraph, TURN, lanePoint } from '../world/lanes.ts';
import type { Connector, Lane } from '../world/lanes.ts';
import { CLS, EF, ROLE } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { World } from '../world/world.ts';
import { SIG } from './signals.ts';
import type { SignalSystem } from './signals.ts';

export interface Cyclist {
  id: number;
  /** the lane they ride beside, or the path through a junction they are on */
  lane: Lane | null;
  conn: Connector | null;
  /** how far along it (m) */
  s: number;
  v: number;
  /** the speed they like to ride at (m/s) */
  cruise: number;
  /** the path they take at the end of the lane */
  next: Connector | null;
  /** how far to the right of the middle of the lane they ride (m) */
  out: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** how far the pedals and the wheels have turned (rad), and whether they brake hard (for the picture) */
  phase: number;
  roll: number;
  braking: boolean;
  colour: number;
  /**
   * Sent along for a turn of the player's: the last lane before the junction
   * they are to be at, and how long after the player's vehicle they mean to
   * be there (s) – they ride a little faster or slower for it.
   */
  staged: Lane | null;
  lag: number;
  /** knocked over: lies there for these seconds, then is gone */
  down: number;
  /** when the player was last blamed for being in the way of this one */
  told: number;
  /** the player's vehicle was on their line a moment ago: counts as seen for this many more seconds */
  seen: number;
  /** for how long they have been standing because something is in the way (s) */
  held: number;
  /** waiting at a red light */
  atLight: boolean;
}

/** A box in the plan that may be in a cyclist's way: a car of the traffic, a tram, the player's trailer. */
export interface CycleObstacle {
  x: number;
  z: number;
  yaw: number;
  length: number;
  width: number;
  /** speed along its own axis (m/s) */
  speed?: number;
  v?: number;
  /** part of the player's vehicle (its trailer): what happens because of it is the player's doing */
  own?: boolean;
}

/** What the cyclists need to know about the player's vehicle. */
export interface CyclePlayer {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  length: number;
  width: number;
  /** the lane it is on and how far along it its middle is – if it is on a lane */
  lane?: Lane | null;
  s?: number;
}

export type CycleEvent = { type: 'cyclistEndangered'; cyclist: Cyclist; hit: boolean };
/** where what happens to the cyclists is noted (the traffic's list of events) */
export interface CycleSink {
  push(e: CycleEvent): unknown;
}

const COLOURS = [0xc23b22, 0x1f6fb5, 0xe0b020, 0x2f8f4a, 0x7a3fa0, 0xd9d9d9, 0x30343a, 0xe56b1f];
const tmp = newPolySample();
const tmp2 = newPolySample();
/** a bicycle with its rider, in the plan (m) */
export const CYCLE_LENGTH = 1.8;
export const CYCLE_WIDTH = 0.64;
/** how far ahead on their line they look (m) */
const LOOK = [0.7, 1.9, 3.3, 5, 7, 9.5, 12, 14.5, 17, 19.5, 22];
/** the player's vehicle came on to their line less than this many seconds ahead of them: cut off */
const CUT_OFF = 2.2;

/**
 * How far to the right of the middle of `lane` a cyclist rides: on the
 * pavement beside it – clear of the sign posts at the kerb and of the lamps
 * at the back –, or on the verge.
 */
export function cycleStrip(lane: Lane): number {
  const e = lane.edge;
  const pavement = lane.dir > 0 ? e.swR : e.swL;
  const toEdge = e.width / 2 - Math.abs(lane.off);
  return toEdge + (pavement >= 1 ? Math.min(1.15, pavement * 0.58) : 0.45);
}

/** May cyclists turn up beside this lane?  The rightmost lane of a street in town with a pavement – not of a fast road. */
export function rideable(lane: Lane): boolean {
  const e = lane.edge;
  if (lane.idx !== 0 || (e.flags & EF.URBAN) === 0 || (e.flags & (EF.TUNNEL | EF.ROUNDABOUT | EF.LINK)) !== 0) return false;
  if (e.cls <= CLS.TRUNK_LINK || e.cls >= CLS.TRACK || !LaneGraph.drivable(e, true)) return false;
  return (lane.dir > 0 ? e.swR : e.swL) >= 1;
}

export class Cyclists {
  readonly list: Cyclist[] = [];
  /** how many ride around near the player by themselves (those sent along for a turn come on top) */
  target = 0;
  /** are cyclists sent along when the player comes up to a right turn?  And how often (0 … 1 of the approaches)? */
  staging = true;
  chance = 0.4;
  /** where cyclists may appear: the lanes around a place (given by the traffic, which keeps such a list) */
  lanesAt: (x: number, z: number) => readonly Lane[] | undefined = () => undefined;
  private readonly world: World;
  private readonly graph: LaneGraph;
  private readonly signals: SignalSystem;
  private readonly rand = rng(90210);
  private readonly hit = newSurfaceHit();
  private nextId = 1;
  private time = 0;
  private spawnT = 1;
  /** when a cyclist may next be sent along */
  private stageAt = 6;
  /** the approach for which it was last decided whether one rides ahead / comes up from behind */
  private decidedAhead: Lane | null = null;
  private decidedBehind: Lane | null = null;
  /** for how long the player's vehicle has been standing at the line (s) */
  private waiting = 0;

  constructor(world: World, graph: LaneGraph, signals: SignalSystem) {
    this.world = world;
    this.graph = graph;
    this.signals = signals;
  }

  clear(): void {
    this.list.length = 0;
    this.decidedAhead = null;
    this.decidedBehind = null;
    this.waiting = 0;
    this.stageAt = this.time + 6;
  }

  /** Put a cyclist beside `lane`, `s` metres along it (for the staging, and for tests). */
  add(lane: Lane, s: number, cruise: number, staged = false, lag = 1.5): Cyclist {
    const c: Cyclist = {
      id: this.nextId++,
      lane,
      conn: null,
      s,
      v: cruise,
      cruise,
      next: this.pick(lane),
      out: cycleStrip(lane),
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      phase: this.rand() * 6,
      roll: 0,
      braking: false,
      colour: COLOURS[Math.floor(this.rand() * COLOURS.length)],
      staged: staged ? lane : null,
      lag,
      down: 0,
      told: -100,
      seen: 0,
      held: 0,
      atLight: false,
    };
    this.place(c);
    this.list.push(c);
    return c;
  }

  /**
   * The way on at the end of a lane: straight on where that is possible,
   * else to the right – never across the oncoming traffic, on to a fast road
   * or into a yard.  Null: their ride ends here.
   */
  private pick(lane: Lane): Connector | null {
    let best: Connector | null = null;
    let score = 0;
    for (const c of lane.out) {
      if (c.turn !== TURN.STRAIGHT && c.turn !== TURN.RIGHT) continue;
      const e = c.to.edge;
      if (e.cls <= CLS.TRUNK_LINK || e.cls >= CLS.TRACK || !LaneGraph.drivable(e, true)) continue;
      let sc = c.turn === TURN.STRAIGHT ? 3 : 1;
      if (e.name !== '' && e.name === lane.edge.name) sc += 0.5;
      // (to the rightmost lane, beside which they ride)
      if (c.to.idx === 0) sc += 0.25;
      if (sc > score) {
        score = sc;
        best = c;
      }
    }
    return best;
  }

  /** The rightmost lane of the carriageway `lane` belongs to. */
  private rightmost(lane: Lane): Lane {
    if (lane.idx === 0) return lane;
    const el = this.graph.edgeLanes[lane.edge.id];
    if (el) for (const l of lane.dir > 0 ? el.fwd : el.back) if (l.idx === 0) return l;
    return lane;
  }

  /** The point `d` metres further along a cyclist's line (into `out`), and how far to the right of the middle of the lane they ride there. */
  private ahead(c: Cyclist, d: number, out: typeof tmp): number {
    let s = c.s + d;
    let conn = c.conn;
    if (c.lane) {
      if (s <= c.lane.len || !c.next) {
        lanePoint(c.lane, Math.min(s, c.lane.len), out);
        return c.out;
      }
      s -= c.lane.len;
      conn = c.next;
    }
    if (!conn) return c.out;
    if (s <= conn.len) {
      samplePolyline(conn.pl, s, out);
      return c.out;
    }
    const l2 = this.rightmost(conn.to);
    lanePoint(l2, Math.min(l2.len, s - conn.len), out);
    return cycleStrip(l2);
  }

  private place(c: Cyclist): void {
    const out = this.ahead(c, 0, tmp);
    c.x = tmp.x - tmp.tz * out;
    c.z = tmp.z + tmp.tx * out;
    c.yaw = Math.atan2(-tmp.tx, -tmp.tz);
    c.y = this.world.surfaceAt(c.x, c.z, tmp.y + 1.5, this.hit) ? this.hit.y : tmp.y;
  }

  /**
   * One step.  `obstacles`: what else is on the roads as boxes (a trailer of
   * the player's – marked `own` –, trams), `cars`: the traffic's cars; what
   * happens to the cyclists because of the player is added to `events`.
   */
  update(dt: number, player: CyclePlayer, obstacles: readonly CycleObstacle[], cars: readonly CycleObstacle[], events: CycleSink): void {
    this.time += dt;
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnT = 1.5;
      let own = 0;
      for (const c of this.list) if (!c.staged) own++;
      if (own < this.target) this.spawn(player);
    }
    if (this.staging && this.target > 0) this.stage(player, dt);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const c = this.list[i];
      const far = Math.hypot(c.x - player.x, c.z - player.z);
      // gone: far away, on a road that is not loaded any more, at the end of their ride – or picked up after a fall
      const on = c.lane ?? c.conn?.to ?? null;
      if (far > 320 || !on || this.graph.lanes[on.id] !== on || (c.down > 0 && (c.down -= dt) <= 0) || c.held > 30) {
        this.list.splice(i, 1);
        continue;
      }
      if (c.down > 0) continue;
      this.ride(c, dt, player, obstacles, cars, events);
    }
  }

  private ride(c: Cyclist, dt: number, player: CyclePlayer, obstacles: readonly CycleObstacle[], cars: readonly CycleObstacle[], events: CycleSink): void {
    const lane = c.lane;
    // --- sent along: to be at the junction a moment after the player's vehicle ---
    if (c.staged) {
      const pl = player.lane;
      const goal = c.staged;
      const me = lane ? this.untilJunction(lane, c.s) : null;
      const them = pl && player.s !== undefined ? this.untilJunction(this.rightmost(pl), player.s + player.length / 2) : null;
      if (!me || me.last !== goal) c.staged = null;
      else if (them && them.last === goal) {
        const mine = me.dist;
        if (mine > 12) {
          const theirs = Math.max(0, them.dist);
          const want = clamp(mine / (timeToLine(theirs, player.speed) + c.lag), 3.6, 7.3);
          c.cruise += clamp(want - c.cruise, -0.9 * dt, 0.9 * dt);
        }
      }
    }
    let v0 = c.cruise;
    /** how far they may still ride before they have to stand (m), and whether it is a light or the end of their ride that holds them */
    let room = Infinity;
    let ownStop = false;
    c.atLight = false;
    if (lane) {
      const node = lane.to;
      const arm = lane.armTo;
      const toLine = lane.stopAt - 1 - c.s;
      if (!c.next) c.next = this.pick(lane);
      if (!c.next) {
        room = Math.max(0, lane.len - 2.5 - c.s);
        ownStop = true;
      } else if (arm.sg >= 0 && node.sc >= 0) {
        // a light: theirs is that of the lane they ride beside
        const st = this.signals.get(node.sc, arm.sg);
        if (toLine > -1.5 && (st === SIG.RED || st === SIG.RED_AMBER || (st === SIG.AMBER && toLine > 6))) {
          room = Math.max(0, toLine);
          ownStop = true;
          c.atLight = true;
        }
      } else if (node.arms.length > 2 && (arm.role === ROLE.YIELD || arm.role === ROLE.STOP || arm.role === ROLE.MINOR) && toLine > -1) {
        // where they have to give way they come up slowly and look
        v0 = Math.min(v0, 2 + Math.max(0, toLine) * 0.35);
      }
    }
    // --- what stands or drives on their line: the cars, the trams, the player's vehicle ---
    let byPlayer = false;
    let seenAt = Infinity;
    for (const d of LOOK) {
      if (d - 1.5 > room) break;
      const out = this.ahead(c, d, tmp2);
      const px = tmp2.x - tmp2.tz * out;
      const pz = tmp2.z + tmp2.tx * out;
      let blocked = false;
      if (inBox(player, px, pz, 0.35, 0)) {
        blocked = true;
        byPlayer = true;
      }
      for (const o of obstacles) {
        if (Math.abs(o.x - px) > 40 || Math.abs(o.z - pz) > 40 || !inBox(o, px, pz, 0.35, 0)) continue;
        blocked = true;
        if (o.own) byPlayer = true;
      }
      if (!blocked) {
        for (const o of cars) {
          if (Math.abs(o.x - px) > 9 || Math.abs(o.z - pz) > 9) continue;
          // (where the car is, and – near them – where it will be in half a second)
          if (inBox(o, px, pz, 0.3, 0) || (d < 8 && inBox(o, px, pz, 0.3, 0.5))) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) {
        seenAt = Math.max(0, d - 1.5);
        if (seenAt < room) {
          room = seenAt;
          ownStop = false;
        } else byPlayer = false;
        break;
      }
    }
    // --- their speed ---
    let a = c.v < v0 ? 1.4 * (1 - c.v / Math.max(v0, 0.5)) : -1.2;
    if (room < Infinity) {
      const need = (c.v * c.v) / (2 * Math.max(room, 0.05));
      if (room < 0.4) a = -6.5;
      else if (need > 0.7) a = -Math.min(6.5, need * 1.15);
      else if (c.v > Math.sqrt(2 * 0.7 * room)) a = Math.min(a, 0);
    }
    c.braking = a < -2.6;
    // The player's vehicle came on to their line at short notice: they have to brake for it.
    // (Not: it has been standing or driving there for a while – then they just wait behind it.)
    // (Only whoever comes along the same street – beside or behind the vehicle that turns, or towards it:
    // a cyclist from a side street who has to give way, and stops, is nobody's victim.)
    const pl = player.lane;
    const mine = lane ?? c.conn?.from ?? null;
    const sameStreet = !!pl && !!mine && (mine.edge === pl.edge || this.untilJunction(mine, lane ? c.s : mine.len)?.last.edge === pl.edge);
    if (byPlayer && sameStreet && c.seen <= 0 && c.v > 1 && room / c.v < CUT_OFF && this.time - c.told > 8) {
      c.told = this.time;
      events.push({ type: 'cyclistEndangered', cyclist: c, hit: false });
    }
    c.seen = byPlayer ? 1.5 : Math.max(0, c.seen - dt);
    c.v = Math.max(0, c.v + a * dt);
    // (standing behind something that does not move – or at the end of their ride: after a while they get off and are gone)
    const ended = lane !== null && !c.next;
    c.held = c.v < 0.2 && room < 1.2 && (!ownStop || ended) ? c.held + dt * (ended ? 6 : 1) : 0;
    c.s += c.v * dt;
    c.roll += (c.v * dt) / 0.34;
    // (they pedal while they ride on or speed up, and let the bicycle roll while they slow down)
    if (a > -0.6) c.phase += c.v * dt * 2.4;
    // --- on to the path through the junction, and to the next street ---
    if (lane && c.s >= lane.len) {
      if (c.next) {
        c.s -= lane.len;
        c.conn = c.next;
        c.lane = null;
        c.next = null;
      } else c.s = lane.len;
    }
    if (c.conn && c.s >= c.conn.len) {
      const l2 = this.rightmost(c.conn.to);
      c.s = Math.min(c.s - c.conn.len, l2.len);
      // (riding in from a lane further left: the strip is found from the rightmost one)
      c.out += l2 === c.conn.to ? 0 : -Math.abs(c.conn.to.off - l2.off);
      c.lane = l2;
      c.conn = null;
      c.next = this.pick(l2);
    }
    // (their place beside the lane changes from street to street: they swing over, they do not jump)
    if (c.lane) c.out += clamp(cycleStrip(c.lane) - c.out, -1.2 * dt, 1.2 * dt);
    this.place(c);
    // --- run into by the player's vehicle: a fall ---
    let struck = inBox(player, c.x, c.z, 0.08, 0);
    for (const o of obstacles) if (o.own && inBox(o, c.x, c.z, 0.08, 0)) struck = true;
    if (struck) {
      c.down = 6;
      c.v = 0;
      c.braking = false;
      events.push({ type: 'cyclistEndangered', cyclist: c, hit: true });
      c.told = this.time;
    }
  }

  /** Somebody turns up on a bicycle on a street near the player – not right before their eyes. */
  private spawn(player: CyclePlayer): void {
    for (let attempt = 0; attempt < 8; attempt++) {
      const ang = this.rand() * Math.PI * 2;
      const rad = 90 + this.rand() * 130;
      const list = this.lanesAt(player.x + Math.cos(ang) * rad, player.z + Math.sin(ang) * rad);
      if (!list || list.length === 0) continue;
      const lane = list[Math.floor(this.rand() * list.length)];
      if (!rideable(lane) || lane.len < 30) continue;
      const s = 4 + this.rand() * (lane.len - 12);
      lanePoint(lane, s, tmp);
      const d = Math.hypot(tmp.x - player.x, tmp.z - player.z);
      if (d < 80 || d > 250) continue;
      const fx = -Math.sin(player.yaw);
      const fz = -Math.cos(player.yaw);
      // not where the player is looking
      if (((tmp.x - player.x) * fx + (tmp.z - player.z) * fz) / d > 0.75 && d < 170) continue;
      if (this.list.some((c) => c.lane === lane && Math.abs(c.s - s) < 25)) continue;
      this.add(lane, s, 4.2 + this.rand() * 2.6);
      return;
    }
  }

  /**
   * The situation every driving lesson has: the vehicle comes up to a
   * junction where it can turn right, and a cyclist rides straight on beside
   * it.  Decided once per approach – in a good third of them somebody comes.
   */
  private stage(player: CyclePlayer, dt: number): void {
    const own = player.lane;
    if (!own || player.s === undefined) {
      this.waiting = 0;
      return;
    }
    const front = player.s + player.length / 2;
    // the next real junction along the street (over the joints where it was mapped in pieces)
    const next = this.untilJunction(this.rightmost(own), front);
    if (!next) {
      this.waiting = 0;
      return;
    }
    const lane = next.last;
    const toLine = next.dist;
    this.waiting = Math.abs(player.speed) < 0.4 && toLine < 12 && toLine > -1 ? this.waiting + dt : 0;
    if (this.time < this.stageAt) return;
    const ahead = toLine >= 90 && toLine <= 280 && player.speed > 4 && lane !== this.decidedAhead;
    const behind = this.waiting > 1.2 && lane !== this.decidedBehind;
    if (!ahead && !behind) return;
    if (ahead) this.decidedAhead = lane;
    else this.decidedBehind = lane;
    if (!rideable(lane)) return;
    // a street to turn right into – and a way straight on for the cyclist
    if (!lane.out.some((c) => c.turn === TURN.RIGHT && LaneGraph.drivable(c.to.edge, false))) return;
    const on = this.pick(lane);
    if (!on || on.turn !== TURN.STRAIGHT) return;
    for (const c of this.list) {
      const l = c.lane ?? c.conn?.from;
      if (l && this.untilJunction(l, c.lane ? c.s : l.len)?.last === lane) return;
    }
    if (this.rand() > this.chance) return;
    const lag = 0.9 + this.rand() * 1.3;
    let back: number;
    let cruise: number;
    if (ahead) {
      // Riding unhurriedly, they are at the junction a moment after the vehicle: that says where they
      // are now.  Far ahead of it, that is – not turning up before the player's eyes –, and the
      // vehicle passes them on the way.
      cruise = 4.2;
      back = cruise * (timeToLine(toLine, player.speed) + lag);
      if (toLine - back < 55 || back < 25) return;
    } else {
      // far behind the vehicle that waits – small in its mirrors
      cruise = 5.5 + this.rand() * 1.5;
      back = toLine + player.length + 45 + this.rand() * 25;
    }
    // (counted back from the line, over the pieces of the street)
    const at = this.backFrom(lane, lane.stopAt, back);
    if (!at || !rideable(at.lane)) return;
    this.add(at.lane, at.s, cruise, true, lag);
    const c = this.list[this.list.length - 1];
    c.staged = lane;
    this.stageAt = this.time + 25 + this.rand() * 40;
  }

  /**
   * From `s` metres along `lane` on to the next junction with three arms or
   * more – through joints where a street goes on in one piece only: the last
   * lane before it and how far it is to its stop line.  Null beyond 320 m.
   */
  untilJunction(lane: Lane, s: number): { last: Lane; dist: number } | null {
    let l = lane;
    let dist = l.stopAt - s;
    for (let hop = 0; hop < 12 && dist < 320; hop++) {
      if (l.to.arms.length >= 3 || l.to.stub) return { last: l, dist };
      // (a joint: the one way on, to the lane at the kerb)
      const on = l.out.filter((c) => c.turn !== TURN.UTURN);
      if (on.length !== 1) return null;
      const nx = this.rightmost(on[0].to);
      dist += l.len - l.stopAt + on[0].len + nx.stopAt;
      l = nx;
    }
    return l.to.arms.length >= 3 && dist < 320 ? { last: l, dist } : null;
  }

  /** `back` metres before `s` on `lane`, over the joints behind it – null where the street began at a junction. */
  private backFrom(lane: Lane, s: number, back: number): { lane: Lane; s: number } | null {
    let l = lane;
    let at = s - back;
    for (let hop = 0; hop < 12; hop++) {
      if (at >= 2) return { lane: l, s: at };
      if (l.from.arms.length !== 2) return null;
      const into = l.in.filter((c) => c.turn !== TURN.UTURN);
      if (into.length !== 1) return null;
      const prev = this.rightmost(into[0].from);
      at += into[0].len + prev.len;
      l = prev;
    }
    return null;
  }

  /**
   * Must a vehicle that wants to turn right from `lane` wait for a cyclist?
   * `s`: where its middle is along the lane, `half`: half its length.  Yes,
   * while one comes up behind it, rides beside it, or has only just ridden
   * into the junction ahead of it.
   */
  blocksRightTurn(lane: Lane, s: number, half: number): boolean {
    for (const c of this.list) {
      // (not: one who has fallen, who stands behind something and waits – or who has red: the vehicle
      // that may turn on the green arrow has not)
      if (c.down > 0 || c.held > 3 || (c.atLight && c.v < 2)) continue;
      if (c.lane && c.lane.edge === lane.edge && c.lane.dir === lane.dir) {
        const rel = c.s - s;
        if (rel > -(half + 5 + c.v * 3) && rel < half + 4) return true;
      } else if (c.lane && c.lane.to.arms.length === 2) {
        // on a piece of the same street further back: how far behind the vehicle?
        const ahead = this.untilJunction(c.lane, c.s);
        const mine = this.untilJunction(this.rightmost(lane), s);
        if (ahead && mine && ahead.last === mine.last) {
          const rel = mine.dist - ahead.dist;
          if (rel > -(half + 5 + c.v * 3) && rel < half + 4) return true;
        }
      } else if (c.conn && c.conn.from.edge === lane.edge && c.conn.from.dir === lane.dir && c.s < Math.min(c.conn.len, 9)) return true;
    }
    return false;
  }

  /** The cyclist nearest to a place within `reach` metres, or null. */
  nearest(x: number, z: number, reach: number): Cyclist | null {
    let best: Cyclist | null = null;
    let bd = reach;
    for (const c of this.list) {
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bd && c.down <= 0) {
        bd = d;
        best = c;
      }
    }
    return best;
  }
}

/** How long a vehicle `d` metres before the line takes to get there if it slows down to turn (s). */
function timeToLine(d: number, v: number): number {
  const turn = 4;
  const brake = 1.5;
  if (v <= turn) return d / Math.max(v, 3);
  const braking = (v * v - turn * turn) / (2 * brake);
  return d > braking ? (d - braking) / v + (v - turn) / brake : (2 * d) / (v + turn);
}

/** Is the point within `margin` of the box – where the box is now, or where it will be in `t` seconds? */
function inBox(o: CycleObstacle, x: number, z: number, margin: number, t: number): boolean {
  const sin = Math.sin(o.yaw);
  const cos = Math.cos(o.yaw);
  const v = o.speed ?? o.v ?? 0;
  const dx = x - (o.x - sin * v * t);
  const dz = z - (o.z - cos * v * t);
  const lon = -dx * sin - dz * cos;
  const lat = dx * cos - dz * sin;
  return Math.abs(lon) < o.length / 2 + margin + CYCLE_LENGTH * 0.25 && Math.abs(lat) < o.width / 2 + margin + CYCLE_WIDTH / 2;
}
