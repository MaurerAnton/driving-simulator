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
import { LaneGraph, TURN, lanePoint } from '../world/lanes.ts';
import type { Connector, Lane } from '../world/lanes.ts';
import { CLS, CTRL, EF, ROLE, XING } from '../world/types.ts';
import type { CrossingJson } from '../world/types.ts';
import type { Edge, World } from '../world/world.ts';
import { SIG } from './signals.ts';
import type { SignalSystem } from './signals.ts';

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
  crashed: number;
  wheelSpin: number;
}

export interface Pedestrian {
  id: number;
  crossing: CrossingJson;
  /** position across the road: -1 kerb A … +1 kerb B */
  t: number;
  dir: number;
  state: 'wait' | 'cross' | 'gone';
  waited: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  phase: number;
  speed: number;
  /** half length of the walk (m): road half width + sidewalk */
  half: number;
  colour: number;
}

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
}

export type TrafficEvent =
  /**
   * `cutIn`: the player's car appeared in this car's way at short notice –
   * moved over or pulled out in front of it – rather than having been seen
   * ahead from far away (whoever comes up from behind keeps his own distance, § 4 StVO)
   */
  | { type: 'forcedBrake'; car: TrafficCar; decel: number; cutIn: boolean }
  | { type: 'collision'; car: TrafficCar; speed: number }
  | { type: 'pedestrianEndangered'; ped: Pedestrian };

const COLORS = [0xd9dadc, 0x1c1d20, 0x8d9197, 0x3a3f46, 0xa01c1c, 0x1f3f7a, 0xf0efe8, 0x55606a, 0x7a2f2a, 0x2c5a3a, 0xb8b08c, 0x394a66, 0xc4c7ca, 0x101113];

const tmp = newPolySample();
const tmp2 = newPolySample();

export class Traffic {
  readonly world: World;
  readonly graph: LaneGraph;
  readonly signals: SignalSystem;
  readonly cars: TrafficCar[] = [];
  readonly peds: Pedestrian[] = [];
  /** cars currently on each lane / connector, unsorted */
  private readonly onLane = new Map<number, TrafficCar[]>();
  private readonly onConn = new Map<number, TrafficCar[]>();
  /** lanes cars may appear on, bucketed by 120 m cells for spawning near the player */
  private readonly spawnGrid = new Map<number, Lane[]>();
  private readonly rand = rng(20261114);
  private nextId = 1;
  private spawnTimer = 0;
  private pedTimer = 0;
  targetCount = 24;
  spawnRadius = 330;
  events: TrafficEvent[] = [];

  constructor(world: World, graph: LaneGraph, signals: SignalSystem) {
    this.world = world;
    this.graph = graph;
    this.signals = signals;
    this.addRoads(world.allEdges);
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
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const e = this.world.edges[this.peds[i].crossing.e];
      if (!e || gone.has(e)) this.peds.splice(i, 1);
    }
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
      if (LaneGraph.drivable(c.to.edge, true)) {
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
      // not right in front of the player's nose
      const fx = -Math.sin(player.yaw);
      const fz = -Math.cos(player.yaw);
      const ahead = ((tmp.x - player.x) * fx + (tmp.z - player.z) * fz) / d;
      if (ahead > 0.82 && d < 260) continue;
      // free space on the lane
      const others = this.onLane.get(lane.id);
      if (others && others.some((o) => Math.abs(o.s - s) < 14)) continue;
      const style = Math.floor(this.rand() * 3);
      const car: TrafficCar = {
        id: this.nextId++,
        lane,
        conn: null,
        s,
        v: Math.min(lane.limit, 13) * 0.8,
        a: 0,
        next: this.chooseNext(lane),
        length: style === 1 ? 4.55 : 4.25,
        width: 1.8,
        color: COLORS[Math.floor(this.rand() * COLORS.length)],
        style,
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
      this.cars.push(car);
      this.attach(car);
      return;
    }
  }

  private remove(car: TrafficCar): void {
    this.detach(car);
    const i = this.cars.indexOf(car);
    if (i >= 0) this.cars.splice(i, 1);
  }

  clear(): void {
    this.cars.length = 0;
    this.peds.length = 0;
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
    return p;
  }

  /**
   * The nearest vehicle ahead on the path of `me` – a car of the traffic, or
   * a tram or train in its way: the gap to it (m) and its speed along the
   * path; gap = Infinity if there is none within `horizon`.
   */
  aheadOf(me: SelfDriving, horizon: number): { gap: number; v: number; loose: boolean } {
    const p = this.aim(me);
    const lead = this.leader(p, horizon) as { gap: number; v: number; loose: boolean };
    lead.loose = false;
    for (const o of this.obstacles) {
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
      else if (lane) lanePoint(lane, at, tmp2);
      else return Infinity;
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
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.cars.length < this.targetCount) {
      this.spawn(player);
      this.spawnTimer = 0.12;
    }
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const car = this.cars[i];
      const d = Math.hypot(car.x - player.x, car.z - player.z);
      if (d > this.spawnRadius + 110 || car.stuck > 45 || (car.crashed > 0 && (car.crashed -= dt) <= 0 && d > 60)) {
        this.remove(car);
        continue;
      }
      this.drive(car, dt, player);
    }
    this.updatePedestrians(dt, player);
  }

  private drive(car: TrafficCar, dt: number, player: PlayerState): void {
    const lane = car.lane;
    const conn = car.conn;
    // --- desired speed ---
    let limit = lane ? lane.limit : conn!.to.limit;
    if (!Number.isFinite(limit)) limit = 36; // Richtgeschwindigkeit 130 km/h
    let v0 = limit * car.temper;
    if (lane && lane.edge.zone === 7) v0 = Math.min(v0, 2.2);
    if ((lane && lane.edge.flags & EF.ROUNDABOUT) || (conn && conn.node.ctrl === CTRL.ROUNDABOUT)) v0 = Math.min(v0, 7.2);
    if (conn) {
      // junction speed from the tightness of the turn
      const turnV = conn.turn === TURN.STRAIGHT ? 14 : conn.turn === TURN.UTURN ? 2.5 : clamp(Math.sqrt(1.9 * Math.max(conn.len, 4) * 0.7), 3, 9);
      v0 = Math.min(v0, turnV);
    }
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
    const lead = this.leader(car, 90);
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
    for (const o of this.obstacles) {
      if (Math.abs(o.x - car.x) > 110 || Math.abs(o.z - car.z) > 110) continue;
      const gap = this.playerAhead(car, o, clamp(car.v * 3.5 + 12, 14, 80));
      if (gap === Infinity) continue;
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
          if (st === SIG.RED || st === SIG.RED_AMBER) mustStop = true;
          else if (st === SIG.AMBER) {
            // stop if that is comfortably possible
            const need = (car.v * car.v) / (2 * Math.max(distToLine, 0.5));
            mustStop = distToLine > 0 && need < 3.2;
          }
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
          }
          if (stop) stopDist = Math.min(stopDist, Math.max(0, d));
        }
      }
    }
    if (conn) {
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
    if (stopDist < Infinity) {
      brakeFor(stopDist + 0.4, 0, 0.6);
      if (stopDist < 1.2 && car.v < 0.4) {
        car.waited += dt;
        if (car.waited > 0.9) car.stoppedAtLine = true;
      }
    } else if (car.v > 1) car.waited = 0;

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

    // --- advance along the path ---
    this.detach(car);
    car.s += ds;
    for (let guard = 0; guard < 4; guard++) {
      if (car.conn) {
        if (car.s < car.conn.len) break;
        car.s -= car.conn.len;
        car.lane = car.conn.to;
        car.conn = null;
        car.next = this.chooseNext(car.lane);
        car.stoppedAtLine = false;
        car.waited = 0;
        car.yieldWait = 0;
      } else if (car.lane) {
        if (car.s < car.lane.len) break;
        const next = car.next ?? this.chooseNext(car.lane);
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
    const yaw = Math.atan2(-tmp.tx, -tmp.tz);
    // slope from the height change since the last frame
    if (ds > 0.01) car.pitch += (Math.atan2(tmp.y - car.y, ds) - car.pitch) * Math.min(1, dt * 6);
    car.x = tmp.x;
    car.y = tmp.y;
    car.z = tmp.z;
    car.yaw = yaw;

    // --- contact with the player ---
    const dx = player.x - car.x;
    const dz = player.z - car.z;
    if (dx * dx + dz * dz < 9 && Math.abs(player.y - car.y) < 2.5) {
      if (boxesOverlap(car.x, car.z, car.yaw, car.length / 2, car.width / 2, player.x, player.z, player.yaw, player.length / 2, player.width / 2)) {
        if (car.crashed <= 0) this.events.push({ type: 'collision', car, speed: Math.abs(player.speed) + car.v });
        car.crashed = 6;
        car.v = 0;
      }
    }
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

  // --- pedestrians ---------------------------------------------------------------
  private updatePedestrians(dt: number, player: PlayerState): void {
    this.pedTimer -= dt;
    if (this.pedTimer <= 0) {
      this.pedTimer = 1.2;
      // someone turns up at a crossing near the player now and then
      for (const c of this.world.crossings) {
        if (c.k !== XING.ZEBRA && c.k !== XING.SIGNAL) continue;
        if (this.peds.some((p) => p.crossing === c)) continue;
        const e = this.world.edges[c.e];
        samplePolyline(e.pl, c.s, tmp);
        const d = Math.hypot(tmp.x - player.x, tmp.z - player.z);
        if (d > 130 || d < 22) continue;
        if (hash01(Math.floor(this.signals.time / 1.2) * 31 + c.e * 7 + Math.round(c.s)) > 0.16) continue;
        const dir = this.rand() < 0.5 ? 1 : -1;
        const half = e.width / 2 + 1.4;
        const ped: Pedestrian = {
          id: this.nextId++,
          crossing: c,
          t: -dir,
          dir,
          state: 'wait',
          waited: 0,
          x: 0,
          y: 0,
          z: 0,
          yaw: 0,
          phase: this.rand() * 6,
          speed: 1.15 + this.rand() * 0.4,
          half,
          colour: [0x2f4f7f, 0x7a2f2f, 0x2f6a45, 0x444444, 0x8a6a2f, 0x5a3a7a][Math.floor(this.rand() * 6)],
        };
        this.placePed(ped);
        this.peds.push(ped);
      }
    }
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      const c = p.crossing;
      if (p.state === 'wait') {
        p.waited += dt;
        let go = p.waited > 0.8;
        if (c.k === XING.SIGNAL && c.sc !== undefined) {
          // walk while the vehicles have red
          const st = this.signals.get(c.sc, c.g ?? 0);
          go = st === SIG.RED && this.signals.age(c.sc, c.g ?? 0) > 1.5;
        } else {
          // zebra: step out when approaching traffic can still stop comfortably (or has stopped)
          const dp = Math.hypot(player.x - p.x, player.z - p.z);
          const closing = player.speed > 1.5 && dp < player.speed * 2.2 + 4 && this.playerFacing(player, p);
          if (closing) go = false;
          for (const car of this.cars) {
            const dc = Math.hypot(car.x - p.x, car.z - p.z);
            if (car.v > 1.5 && dc < car.v * 2 + 4 && Math.abs(car.y - p.y) < 3) go = false;
          }
        }
        if (go) p.state = 'cross';
      } else if (p.state === 'cross') {
        p.t += (p.dir * p.speed * dt) / p.half;
        p.phase += dt * 7.5;
        // nearly run over?
        const dx = player.x - p.x;
        const dz = player.z - p.z;
        if (Math.hypot(dx, dz) < 2.4 && player.speed > 1.2) {
          this.events.push({ type: 'pedestrianEndangered', ped: p });
        }
        if (p.t * p.dir >= 1) p.state = 'gone';
      }
      this.placePed(p);
      if (p.state === 'gone' || Math.hypot(p.x - player.x, p.z - player.z) > 220) this.peds.splice(i, 1);
    }
  }

  private playerFacing(player: PlayerState, p: Pedestrian): boolean {
    const fx = -Math.sin(player.yaw);
    const fz = -Math.cos(player.yaw);
    return (p.x - player.x) * fx + (p.z - player.z) * fz > 0;
  }

  private placePed(p: Pedestrian): void {
    const e = this.world.edges[p.crossing.e];
    samplePolyline(e.pl, p.crossing.s, tmp);
    const off = p.t * p.half;
    // left of the edge direction is (tz, -tx)
    p.x = tmp.x + tmp.tz * off;
    p.z = tmp.z - tmp.tx * off;
    const onWalk = Math.abs(off) > e.width / 2;
    p.y = this.world.edgeY(e, p.crossing.s, p.x, p.z) + (onWalk && (off > 0 ? e.swL : e.swR) > 0 ? 0.12 : 0);
    // walking direction: towards +left when dir > 0
    const wx = tmp.tz * p.dir;
    const wz = -tmp.tx * p.dir;
    p.yaw = Math.atan2(-wx, -wz);
  }

  /** Is a pedestrian waiting at or walking on the given crossing? */
  pedestrianAt(c: CrossingJson): Pedestrian | null {
    for (const p of this.peds) if (p.crossing === c && p.state !== 'gone') return p;
    return null;
  }
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
