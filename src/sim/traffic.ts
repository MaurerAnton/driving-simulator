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
import type { World } from '../world/world.ts';
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
  | { type: 'forcedBrake'; car: TrafficCar; decel: number }
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
  /** crossings by edge for quick lookup */
  private readonly crossingsByEdge = new Map<number, CrossingJson[]>();
  targetCount = 24;
  spawnRadius = 330;
  events: TrafficEvent[] = [];

  constructor(world: World, graph: LaneGraph, signals: SignalSystem) {
    this.world = world;
    this.graph = graph;
    this.signals = signals;
    for (const lane of graph.lanes) {
      if (!LaneGraph.drivable(lane.edge, true) || lane.len < 25) continue;
      if (lane.edge.flags & EF.ROUNDABOUT) continue;
      // register the lane in every cell it passes through
      const seen = new Set<number>();
      for (let d = 0; d <= lane.len; d += 40) {
        lanePoint(lane, d, tmp);
        const key = Traffic.cellKey(tmp.x, tmp.z);
        if (seen.has(key)) continue;
        seen.add(key);
        let list = this.spawnGrid.get(key);
        if (!list) this.spawnGrid.set(key, (list = []));
        // main roads carry more traffic: list them more than once
        const copies = lane.edge.tier >= 4 ? 4 : lane.edge.tier >= 3 ? 3 : 1;
        for (let k = 0; k < copies; k++) list.push(lane);
      }
    }
    for (const c of world.crossings) {
      let list = this.crossingsByEdge.get(c.e);
      if (!list) this.crossingsByEdge.set(c.e, (list = []));
      list.push(c);
    }
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
  private playerAhead(car: TrafficCar, player: PlayerState, horizon: number): number {
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
        // undecided beyond this lane: assume straight on
        const nx = next ?? lane.out.find((q) => q.turn === TURN.STRAIGHT) ?? lane.out[0];
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
      if (Math.abs(lf) < hl && Math.abs(lr) < hw) return Math.max(0, dist - car.length / 2);
    }
    return Infinity;
  }

  /** Is the way through connector `c` free of traffic it has to give way to? */
  private mayEnter(car: TrafficCar, c: Connector, distToLine: number, player: PlayerState, impatient = false): boolean {
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
      const myTime = tEnter + (k.sSelf + car.length) / Math.max(car.v, 3.5) + 1.2;
      // traffic approaching the conflicting movement – also from further upstream,
      // because the lane feeding it can be just a few metres long (roundabouts)
      const from = k.other.from;
      const zipper = from.armTo === c.from.armTo;
      const threat = (o: TrafficCar, d: number): boolean => {
        // lanes of one carriageway running together: only whoever is level or ahead goes first
        if (zipper) return d - k.sOther < distToLine + car.length + 1.5;
        const t = d / Math.max(o.v, 2.5);
        // after a long wait accept a tighter (but still safe) gap
        return impatient ? t < 2.6 && d < 60 : t < myTime + 1.5 && d < 110;
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
    if (pGap < Infinity) {
      const before = acc;
      // the component of the player's speed along our direction
      const along = -Math.sin(player.yaw) * -Math.sin(car.yaw) + -Math.cos(player.yaw) * -Math.cos(car.yaw);
      brakeFor(pGap, Math.max(0, player.speed * along), 2.6);
      playerBrake = acc < before - 0.3;
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
      const xs = this.crossingsByEdge.get(lane.edge.id);
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
    // report hard braking caused by the player (the rule monitor decides who was at fault)
    if (playerBrake && acc < -2.6 && car.v > 2) {
      car.blockedByPlayer += dt;
      if (car.blockedByPlayer > 0.12) {
        this.events.push({ type: 'forcedBrake', car, decel: -acc });
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
