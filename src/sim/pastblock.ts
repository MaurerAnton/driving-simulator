// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Getting past what blocks the way.
 *
 * A car of the traffic that stands behind something that does not move – a
 * broken-down or crashed car, a bus at its stop, a parked vehicle, the
 * player's car standing in the lane – for more than a few seconds looks for
 * a way past it, as a driver would:
 *
 *  - squeezing by within its own lane, where the thing stands far enough to
 *    the side;
 *  - over into a free lane beside it that goes the same way (the traffic's
 *    own moving over, `TrafficCar.merge`, once there is a gap there);
 *  - on a road with one lane each way, over the oncoming lane – only where
 *    that is clear for long enough to get by and back, never over a solid
 *    centre line unless the thing stands there for good (a parked vehicle);
 *  - or half onto the verge beside the road, slowly, where there is one to
 *    drive on (outside town, no pavement, no other road there).
 *
 * Never through people, cyclists or other cars; never in a junction or just
 * before one (whoever stands near a junction is waiting for it); not in the
 * reach of roadworks, which have ways of their own (src/sim/roadevents.ts).
 * Whatever does not count as a block – a car of the traffic that waits in a
 * queue, somebody on foot – is simply waited behind.
 *
 * A car going round something is drawn off the middle of its lane by
 * `past.off` (m, + to the left) and moves across at most RATE metres for each
 * metre it drives; while it is off its lane it looks for what is in its way
 * by where things are rather than by the order of the cars on the lanes, and
 * the others see it as an obstacle (its `box`).  The player's autopilot
 * (src/sim/autodriver.ts) goes round in the same way.
 */
import { clamp, newPolySample } from '../core/geom.ts';
import { lanePoint } from '../world/lanes.ts';
import type { Lane, LaneGraph } from '../world/lanes.ts';
import { CLS, EF } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { World } from '../world/world.ts';
import type { RoadEvents } from './roadevents.ts';
import type { PlayerState, TrafficCar } from './traffic.ts';

/** how it gets by: within its lane, over into the lane beside, over the oncoming lane, half onto the verge */
export type PastKind = '' | 'squeeze' | 'lane' | 'oncoming' | 'verge';
/** standing behind it (counting the seconds), moving out, beside it, back into its lane */
export type PastPhase = 'wait' | 'out' | 'by' | 'back';

/** A car's going round something in its way. */
export interface PastState {
  phase: PastPhase;
  /** seconds in this phase (standing still, for 'wait') */
  t: number;
  /** seconds until it looks for a way past again */
  look: number;
  /** how far left (+) or right (−) of the middle of its lane it is now, and where it is going (m) */
  off: number;
  to: number;
  /** the sideways movement of the last step per metre driven (for turning the car a little) */
  turn: number;
  /** where along its lane the middle of the car is once it is past (its rear clear of the thing's front) */
  end: number;
  /** at most this fast while it goes round (m/s) */
  cap: number;
  kind: PastKind;
  /** the lane it goes round on */
  lane: Lane | null;
  /** it waits, half out, for something coming the other way to pass */
  hold: boolean;
  /** how the others see it while it is off its lane */
  readonly box: PlayerState;
}

/** most metres sideways for each metre forward */
export const RATE = 0.6;
/** seconds standing behind something before looking for a way past */
export const PATIENCE = 4;
/** a thing nearer than this ahead of the front (m) is what holds the car up */
export const NEAR = 9;
/** below this (m/s) a thing counts as standing */
const STILL = 0.3;
/** how far a stop line, a light ahead has to be for the car to go round (m) */
const LINE_CLEAR = 8;
const LIGHT_CLEAR = 60;

export function newPast(): PastState {
  return { phase: 'wait', t: 0, look: 0, off: 0, to: 0, turn: 0, end: 0, cap: Infinity, kind: '', lane: null, hold: false, box: { x: 0, y: 0, z: 0, yaw: 0, speed: 0, length: 0, width: 0 } };
}

/** How far off the middle of its lane the car's way runs `dist` metres ahead of it (it moves across at RATE per metre). */
export function offsetAt(p: PastState, dist: number): number {
  const most = RATE * Math.max(0, dist);
  return p.off + clamp(p.to - p.off, -most, most);
}

/** What the module needs of the traffic (src/sim/traffic.ts implements it). */
export interface PastRoad {
  readonly world: World;
  readonly graph: LaneGraph;
  readonly cars: readonly TrafficCar[];
  /** what the game puts in the cars' way (a parked vehicle has `parked`) */
  readonly obstacles: readonly PlayerState[];
  /** everything besides the cars that is in their way this step: obstacles, cyclists, people, fences */
  readonly blockList: readonly PlayerState[];
  roadEvents: RoadEvents | null;
  carsOn(lane: Lane): readonly TrafficCar[] | undefined;
  /** distance along the car's way until it would touch `box` (Infinity: it does not) */
  gapTo(car: TrafficCar, box: PlayerState, horizon: number): number;
  roomOn(lane: Lane, s: number, v: number, length: number): boolean;
}

/** One thing near a car, in the frame of its lane: along (a, + ahead of its middle), left (l), half extents, speed along the lane. */
interface Thing {
  who: object;
  a: number;
  l: number;
  hl: number;
  hw: number;
  v: number;
  /** may be gone round (it stands, and is a block) */
  block: boolean;
  /** stands there for good */
  permanent: boolean;
  /** somebody on foot or on a bicycle: kept further from */
  person: boolean;
  /** part of what is being gone round */
  part: boolean;
}

/** What `plan` decides. */
export interface PastPlan {
  kind: PastKind;
  /** where to go (m left of the middle of the lane; for 'lane' the lane) */
  to: number;
  lane: Lane | null;
  end: number;
  cap: number;
}

const smp = newPolySample();
const hit = newSurfaceHit();

export class PastBlocks {
  readonly road: PastRoad;
  private readonly things: Thing[] = [];
  private readonly pool: Thing[] = [];
  private readonly ahead = { gap: Infinity, v: 0 };
  private readonly box: PlayerState = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, length: 0, width: 0 };

  constructor(road: PastRoad) {
    this.road = road;
  }

  /** The cars that are off their lanes now, as obstacles for the others (added to `out`). */
  boxes(cars: readonly TrafficCar[], out: PlayerState[]): void {
    for (const c of cars) {
      const p = c.past;
      if (!p || Math.abs(p.off) < 0.3) continue;
      const b = p.box;
      b.x = c.x;
      b.y = c.y;
      b.z = c.z;
      b.yaw = c.yaw;
      b.speed = c.v;
      b.length = c.length;
      b.width = c.width;
      out.push(b);
    }
  }

  /**
   * The nearest car of the traffic in the way of a car that goes round
   * something – found by where the cars are, not by the order on the lanes
   * (gap = Infinity: none within `horizon`).  While it holds for oncoming
   * traffic it has a gap of nothing.
   */
  lead(car: TrafficCar, horizon: number): { gap: number; v: number } {
    const out = this.ahead;
    out.gap = car.past?.hold ? 0.3 : Infinity;
    out.v = 0;
    const box = this.box;
    for (const o of this.road.cars) {
      if (o === car || Math.abs(o.x - car.x) > horizon + 10 || Math.abs(o.z - car.z) > horizon + 10 || Math.abs(o.y - car.y) > 4) continue;
      box.x = o.x;
      box.y = o.y;
      box.z = o.z;
      box.yaw = o.yaw;
      box.speed = o.v;
      box.length = o.length;
      box.width = o.width;
      const gap = this.road.gapTo(car, box, horizon);
      if (gap >= out.gap) continue;
      out.gap = gap;
      out.v = Math.max(0, o.v * (Math.sin(o.yaw) * Math.sin(car.yaw) + Math.cos(o.yaw) * Math.cos(car.yaw)));
    }
    return out;
  }

  /**
   * One step of a car's going round (called after it has decided how hard
   * to brake): counting how long it has stood behind something, looking for
   * a way past, the phases of the manoeuvre and the indicator.  `gap`: to
   * what is ahead of it; `held`: it stands for a reason of the road (a line,
   * a light, roadworks) – not because something is in the way.  `self`: the
   * player's autopilot (it moves over to the lane beside by going round, too).
   */
  look(car: TrafficCar, dt: number, gap: number, held: boolean, player: PlayerState | null, self = false): void {
    let p = car.past;
    if (!p) {
      if (car.v > STILL || gap > NEAR || held || !car.lane || car.side || car.em || car.merge) return;
      p = car.past = newPast();
    }
    p.t += dt;
    switch (p.phase) {
      case 'wait': {
        if (car.v > 0.6 || held || !car.lane || gap > NEAR + 2 || car.merge) {
          car.past = undefined;
          return;
        }
        if (p.t < PATIENCE) return;
        p.look -= dt;
        if (p.look > 0) return;
        p.look = 0.5 + (car.id % 5) * 0.07;
        const plan = this.plan(car, player, self);
        if (!plan) return;
        if (plan.kind === 'lane' && !self) {
          // (the traffic's own moving over: src/sim/traffic.ts moveOver)
          car.merge = plan.lane;
          car.past = undefined;
          return;
        }
        p.phase = 'out';
        p.t = 0;
        p.kind = plan.kind;
        p.to = plan.to;
        p.end = plan.end;
        p.cap = plan.cap;
        p.lane = car.lane;
        p.hold = false;
        break;
      }
      case 'out':
        if (car.lane !== p.lane) return this.drop(car);
        // something came along on the way it goes round on: wait for it, half out – or, just begun, back
        if (p.kind === 'oncoming' && (p.look -= dt) <= 0) {
          p.look = 0.4;
          p.hold = !this.clearFor(car, p.to, p.end, player, self);
          if (p.hold && Math.abs(p.off) < 0.3) p.to = 0;
        }
        if (p.to === 0) {
          p.phase = 'back';
          p.hold = false;
          p.t = 0;
        } else if (Math.abs(p.off - p.to) < 0.05) {
          p.phase = 'by';
          p.t = 0;
          p.hold = false;
        } else if (p.t > 25) this.giveUp(p);
        break;
      case 'by':
        if (car.lane !== p.lane) return this.drop(car);
        if (car.s >= p.end) {
          p.phase = 'back';
          p.to = 0;
          p.t = 0;
        } else if (p.t > 30 && car.v < STILL) this.giveUp(p);
        break;
      case 'back':
        if (car.lane !== p.lane) return this.drop(car);
        if (p.off === 0) {
          car.past = undefined;
          return;
        }
        break;
    }
    // the indicator: out to the side it goes, back the other way
    if (!self) {
      const side = p.phase === 'back' ? -Math.sign(p.off) : Math.sign(p.to);
      car.blinker = side > 0 ? -1 : side < 0 ? 1 : 0;
    }
  }

  /** It has stood half out for too long (whoever is in the way waits for it, too): back, and try again later. */
  private giveUp(p: PastState): void {
    p.phase = 'back';
    p.to = 0;
    p.t = 0;
    p.hold = false;
  }

  /** It left the lane it went round on (it should not): straight back to the middle of its way. */
  private drop(car: TrafficCar): void {
    car.past = undefined;
  }

  /**
   * Move the car across towards where it is going, `ds` metres driven this
   * step.  Going back it may also creep across standing (a driver who has
   * stopped half out turns the wheel and rolls back in).
   */
  slide(car: TrafficCar, ds: number, dt: number): void {
    const p = car.past;
    if (!p) return;
    const before = p.off;
    let most = RATE * ds;
    if (p.phase === 'back' && car.v < STILL) most = Math.max(most, 0.35 * dt);
    p.off += clamp(p.to - p.off, -most, most);
    if (Math.abs(p.off - p.to) < 0.01) p.off = p.to;
    p.turn = ds > 0.001 ? (p.off - before) / ds : 0;
  }

  // --- deciding ----------------------------------------------------------------------

  /** The things near a car, in the frame of its lane at its middle (null: it is not on a lane). */
  private gather(car: TrafficCar, player: PlayerState | null, self: boolean): Thing[] | null {
    const lane = car.lane;
    if (!lane) return null;
    lanePoint(lane, car.s, smp);
    const ox = smp.x;
    const oz = smp.z;
    const tx = smp.tx;
    const tz = smp.tz;
    const things = this.things;
    for (const t of things) this.pool.push(t);
    things.length = 0;
    const R = 260;
    const add = (who: object, x: number, y: number, z: number, yaw: number, length: number, width: number, speed: number, block: boolean, permanent: boolean, person: boolean): void => {
      const dx = x - ox;
      const dz = z - oz;
      if (Math.abs(dx) > R || Math.abs(dz) > R || Math.abs(y - car.y) > 4) return;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const cos = fx * tx + fz * tz;
      const sin = fx * tz - fz * tx;
      const t = this.pool.pop() ?? ({} as Thing);
      t.who = who;
      t.a = dx * tx + dz * tz;
      t.l = dx * tz - dz * tx;
      t.hl = (Math.abs(cos) * length + Math.abs(sin) * width) / 2;
      t.hw = (Math.abs(sin) * length + Math.abs(cos) * width) / 2;
      t.v = speed * cos;
      t.block = block && Math.abs(speed) < STILL;
      t.permanent = permanent;
      t.person = person;
      t.part = false;
      things.push(t);
    };
    for (const o of this.road.cars) {
      if (o === car) continue;
      // a car of the traffic is gone round when it has broken down or crashed, or is a bus at its stop – not when it waits in a queue
      const broken = o.crashed > 0;
      add(o, o.x, o.y, o.z, o.yaw, o.length, o.width, o.v, broken || (o.bus?.dwell ?? 0) > 0, o.crashed > 30, false);
    }
    // (the player's car standing in the lane – not for the autopilot, which is the player's car)
    if (player && !self && Math.abs(player.y - car.y) < 4) add(player, player.x, player.y, player.z, player.yaw, player.length, player.width, player.speed, !player.onFoot, false, player.onFoot === true);
    const obstacles = this.road.obstacles;
    for (const o of this.road.blockList) {
      if (o === car.past?.box) continue;
      const game = obstacles.includes(o);
      // a parked vehicle, the player's trailer: gone round; people, bicycles, fences and barriers: not
      const vehicle = game && (o.parked === true || (o.own === true && !self));
      add(o, o.x, o.y, o.z, o.yaw, o.length, o.width, o.speed, vehicle, o.parked === true, !vehicle && o.length < 2.2);
    }
    return things;
  }

  /**
   * The way past what stands in front of a car, if there is one now – or
   * null (nothing to go round, or no way to: wait).
   */
  plan(car: TrafficCar, player: PlayerState | null, self = false): PastPlan | null {
    const lane = car.lane;
    if (!lane || car.side || car.em) return null;
    const things = this.gather(car, player, self);
    if (!things) return null;
    const half = lane.width / 2;
    const front = car.length / 2;
    // what holds it up: the nearest thing ahead in its lane
    let first: Thing | null = null;
    for (const t of things) {
      if (t.a - t.hl < front - 0.5 || t.a - t.hl > front + NEAR) continue;
      if (Math.abs(t.l) > half + t.hw - 0.3) continue;
      if (!first || t.a - t.hl < first.a - first.hl) first = t;
    }
    if (!first || !first.block) return null;
    // … together with whatever stands right in front of it and may be gone round as well (a truck and its trailer)
    let rear = first.a - first.hl;
    let fore = first.a + first.hl;
    let lo = first.l - first.hw;
    let hi = first.l + first.hw;
    let permanent = first.permanent;
    first.part = true;
    for (let grown = true, n = 0; grown && n < 4; n++) {
      grown = false;
      for (const t of things) {
        if (t.part || !t.block || Math.abs(t.l) > half + t.hw - 0.3) continue;
        if (t.a - t.hl > fore + 3 || t.a + t.hl < rear) continue;
        t.part = true;
        fore = Math.max(fore, t.a + t.hl);
        lo = Math.min(lo, t.l - t.hw);
        hi = Math.max(hi, t.l + t.hw);
        permanent &&= t.permanent;
        grown = true;
      }
    }
    if (fore - rear > 40) return null;
    // where it is past: its rear 1.5 m beyond the thing's front – and room in its lane there to come back into
    const end = car.s + fore + 1.5 + front;
    const room = fore + car.length + 6;
    // not in a junction, nor coming back just before one; not where a light ahead holds the traffic
    if (car.s + room + LINE_CLEAR > lane.stopAt) return null;
    if (lane.armTo.sg >= 0 && lane.to.sc >= 0 && lane.stopAt - (car.s + fore) < LIGHT_CLEAR) return null;
    for (const t of things) {
      if (t.part || Math.abs(t.l) > half + t.hw - 0.2) continue;
      if (t.a + t.hl > fore && t.a - t.hl < room && !(t.v > car.v + 3)) return null;
    }
    // not where roadworks are, nor over a crossing
    const re = this.road.roadEvents;
    for (let d = -front; d <= room; d += 4) {
      const s = car.s + d;
      if (re && (re.blocked(lane, s) || re.shift(lane, s) !== 0)) return null;
    }
    for (const x of lane.edge.xings) {
      const pos = lane.dir > 0 ? x.s - lane.s0 : lane.s0 - x.s;
      if (pos > car.s - front - 3 && pos < car.s + room + 3) return null;
    }
    const w = car.width / 2;
    const left = hi + w + 0.4;
    const right = lo - w - 0.4;
    const e = lane.edge;
    // 1) within its own lane, where the thing stands far enough to the side
    for (const to of [left, right]) {
      if (Math.abs(to) + w > half + 0.15) continue;
      if (this.free(car, to, room, 3)) return { kind: 'squeeze', to, lane: null, end, cap: 3 };
    }
    // 2) a lane beside going the same way
    const el = this.road.graph.edgeLanes[e.id];
    const mine = el ? (lane.dir > 0 ? el.fwd : el.back) : [];
    for (const k of [lane.idx + 1, lane.idx - 1]) {
      const other = mine[k];
      if (!other) continue;
      const at = (other.off - lane.off) * lane.dir;
      if (at + other.width / 2 > lo && at - other.width / 2 < hi) continue;
      if (re && !re.laneOpen(other, car.s + front)) continue;
      if (!this.road.roomOn(other, car.s, car.v, car.length)) continue;
      if (self && !this.free(car, at, room, 5)) continue;
      return { kind: 'lane', to: at, lane: other, end, cap: 5 };
    }
    // 3) over the oncoming lane of a road with one lane each way
    const theirs = el ? (lane.dir > 0 ? el.back : el.fwd) : [];
    const twoWay = mine.length === 1 && theirs.length === 1;
    const solid = (e.flags & EF.SOLID_CENTER) !== 0;
    if (twoWay && (!solid || permanent) && !(e.flags & (EF.ROUNDABOUT | EF.DUAL)) && e.cls > CLS.MOTORWAY_LINK && left - w < half + theirs[0].width - 0.3) {
      if (this.free(car, left, room, self ? 2.7 : 5)) return { kind: 'oncoming', to: left, lane: null, end, cap: self ? 2.7 : 5 };
    }
    // 4) half onto the verge: outside town, no pavement there, not on a bridge, nothing else there
    const pavement = lane.dir > 0 ? e.swR : e.swL;
    if (lane.idx === 0 && pavement <= 0 && !(e.flags & (EF.URBAN | EF.BRIDGE | EF.TUNNEL)) && -right < half + e.margin + 0.9 && this.verge(car, right, room)) {
      if (this.free(car, right, room, 2)) return { kind: 'verge', to: right, lane: null, end, cap: 2 };
    }
    return null;
  }

  /**
   * Is the way `to` metres left of the middle of the lane free from the car
   * to `until` metres ahead – nobody in it, nothing coming along it that
   * would get there before the car is through (at about `cap`)?
   */
  private free(car: TrafficCar, to: number, until: number, cap: number): boolean {
    const w = car.width / 2;
    const v = Math.max(car.v, cap * 0.6);
    const T = (until + car.length / 2) / v + 2;
    for (const t of this.things) {
      if (t.part) continue;
      const room = t.hw + w + (t.person ? 1.0 : 0.35);
      // (from the middle of the lane out to `to`: the whole way across)
      const lo = Math.min(0, to) - room;
      const hi = Math.max(0, to) + room;
      if (t.l < lo || t.l > hi) continue;
      // beside or behind the car in its own lane: not in the way out
      if (t.a + t.hl < -car.length / 2 + 0.5) continue;
      if (t.a - t.hl < until + 3) {
        // in the stretch: only one going away fast does not matter
        if (t.v > car.v + 3 && t.a > car.length) continue;
        return false;
      }
      // further on and coming towards it: it must not get there before the car is back
      if (Math.abs(t.l - to) < room && t.v < -0.5 && (t.a - t.hl - until) / -t.v < T + 2.5) return false;
    }
    return true;
  }

  /** Re-check the way out while moving out (things move). */
  private clearFor(car: TrafficCar, to: number, end: number, player: PlayerState | null, self: boolean): boolean {
    if (!this.gather(car, player, self)) return false;
    // (the thing it goes round is not in the way: everything beside the middle of its lane counts only by the way out)
    for (const t of this.things) if (t.block && Math.abs(t.l) < (car.lane?.width ?? 3) / 2) t.part = true;
    return this.free(car, to, end - car.s + car.length + 4, 4);
  }

  /** Is the verge beside the lane drivable where the car's outer wheels would run (no other road, no pavement, no junction)? */
  private verge(car: TrafficCar, to: number, until: number): boolean {
    const lane = car.lane;
    if (!lane) return false;
    const out = to - car.width / 2;
    for (let d = -car.length / 2; d <= until; d += 3) {
      lanePoint(lane, Math.min(lane.len, car.s + d), smp);
      const x = smp.x + smp.tz * out;
      const z = smp.z - smp.tx * out;
      if (this.road.world.surfaceAt(x, z, car.y + 0.5, hit) && (hit.node !== null || hit.zone === 1 || hit.edge !== lane.edge)) return false;
    }
    return true;
  }
}
