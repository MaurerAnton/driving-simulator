// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The driving examiner: watches the player and records violations of the
 * German traffic rules (StVO).  It judges by the same right-of-way data the
 * traffic simulation uses, so "who had to wait" is never ambiguous.
 */
import { LaneGraph, TURN } from '../world/lanes.ts';
import type { Lane } from '../world/lanes.ts';
import { ACCESS, CLS, CTRL, EF, ROLE, XING } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { Arm, Edge, Node, World } from '../world/world.ts';
import { SIG } from './signals.ts';
import type { SignalSystem } from './signals.ts';
import type { Traffic, TrafficCar, TrafficEvent } from './traffic.ts';

export type Severity = 'hint' | 'minor' | 'major' | 'fail';

export interface Violation {
  /** catalogue key, see ui/i18n */
  id: string;
  severity: Severity;
  time: number;
  x: number;
  z: number;
  /** values for the message, e.g. { limit: 30, speed: 47 } */
  data: Record<string, number | string>;
}

export interface PlayerSnapshot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** signed forward speed, m/s */
  speed: number;
  indicator: number;
  hazard: boolean;
  /** head turn, rad, + = left */
  lookYaw: number;
  seatbelt: boolean;
  handbrake: number;
  stalled: boolean;
  /** impact speed of a collision with scenery in this step (0 = none) */
  hitScenery: number;
  length: number;
  /**
   * From the point given by x, z to the front bumper (m).  Half the length
   * unless said otherwise – a truck is measured from the middle of its
   * wheelbase, which is not the middle of its length.
   */
  front?: number;
}

/** What the driver should know right now – shown by the optional HUD assistance. */
export interface RuleContext {
  /** speed limit in km/h, 0 = none (Autobahn), -1 = unknown/off-road */
  limit: number;
  zone: number;
  urban: boolean;
  roadName: string;
  /** upcoming junction */
  junction: null | {
    dist: number;
    /** ROLE of our approach */
    role: number;
    ctrl: number;
    /** signal state (SIG) or -1 */
    signal: number;
  };
  onRoad: boolean;
  wrongWay: boolean;
}

const SEVERITY_POINTS: Record<Severity, number> = { hint: 0, minor: 1, major: 3, fail: 10 };

export class RuleMonitor {
  readonly world: World;
  readonly graph: LaneGraph;
  readonly signals: SignalSystem;
  readonly traffic: Traffic;
  readonly log: Violation[] = [];
  readonly context: RuleContext = { limit: -1, zone: 0, urban: false, roadName: '', junction: null, onRoad: false, wrongWay: false };
  onViolation: ((v: Violation) => void) | null = null;
  /** exam mode judges more strictly (hints become faults) */
  strict = false;
  /** roads the navigation sends us through: "residents only" does not count against the driver there */
  allowed: Set<Edge> | null = null;
  time = 0;

  private readonly hit = newSurfaceHit();
  private readonly frontHit = newSurfaceHit();
  private readonly cooldown = new Map<string, number>();
  private lane: Lane | null = null;
  private laneS = 0;
  private prevLaneS = 0;
  private stoppedNearLine = false;
  private entry: { node: Node; arm: Arm; lane: Lane; time: number; indicatorL: number; indicatorR: number; lookedL: boolean; lookedR: boolean; yaw: number; signalRed: boolean; nowL: boolean; nowR: boolean; vMax: number } | null = null;
  /**
   * The vehicle is a truck with a trailer: 60 km/h outside built-up areas
   * and 80 km/h on motorways (§ 3 Abs. 3 StVO), walking pace when turning
   * right in town (§ 9 Abs. 6 StVO).
   */
  truck = false;
  /** On the practice yard there are no roads and no traffic: nothing here is judged. */
  yard = false;
  private lastX = 0;
  private lastZ = 0;
  private indL = 0;
  private indR = 0;
  private lookL = 0;
  private lookR = 0;
  private speedOver = 0;
  private wrongSide = 0;
  private wrongWayT = 0;
  private sidewalkT = 0;
  private offRoadT = 0;
  private tailgateT = 0;
  private handbrakeT = 0;
  private lostT = 0;
  /**
   * The stop line was crossed on red.  That alone is "only" a stop-line
   * offence (Zeichen 294); the red-light offence needs the protected area
   * behind it (junction, crossing) – so we wait and see how far the car goes.
   */
  private redLine: { lane: Lane; x: number; z: number; tol: number; severity: Severity; lineReported: boolean } | null = null;
  private indicatorOnT = 0;
  /** an oncoming car braked hard for us at this junction (judged once it is known which way we went) */
  private oncoming: { node: Node; time: number } | null = null;
  private lastEdge: Edge | null = null;
  private readonly crossingState = new Map<object, number>();

  constructor(world: World, graph: LaneGraph, signals: SignalSystem, traffic: Traffic) {
    this.world = world;
    this.graph = graph;
    this.signals = signals;
    this.traffic = traffic;
  }

  reset(): void {
    this.log.length = 0;
    this.cooldown.clear();
    this.lane = null;
    this.entry = null;
    this.redLine = null;
    this.oncoming = null;
    this.lastEdge = null;
    this.time = 0;
    this.speedOver = this.wrongSide = this.wrongWayT = this.sidewalkT = this.offRoadT = this.tailgateT = 0;
  }

  /** The lane the monitor has the car on (kept while it crosses a junction), or null off the road. */
  get laneNow(): Lane | null {
    return this.lane;
  }

  /** How far the front bumper is along that lane (m). */
  get laneFront(): number {
    return this.laneS;
  }

  get points(): number {
    return this.log.reduce((a, v) => a + SEVERITY_POINTS[v.severity], 0);
  }

  get failed(): boolean {
    return this.log.some((v) => v.severity === 'fail');
  }

  /** A fault found by somebody else (the judge of a manoeuvre): into the log like the others. */
  note(id: string, severity: Severity, data: Record<string, number | string> = {}, cooldown = 3): void {
    const until = this.cooldown.get(id) ?? -1;
    if (this.time < until) return;
    this.cooldown.set(id, this.time + cooldown);
    const v: Violation = { id, severity, time: this.time, x: this.lastX, z: this.lastZ, data };
    this.log.push(v);
    this.onViolation?.(v);
  }

  private report(id: string, severity: Severity, p: PlayerSnapshot, data: Record<string, number | string> = {}, cooldown = 12): void {
    const until = this.cooldown.get(id) ?? -1;
    if (this.time < until) return;
    this.cooldown.set(id, this.time + cooldown);
    if (this.strict && severity === 'hint') severity = 'minor';
    const v: Violation = { id, severity, time: this.time, x: p.x, z: p.z, data };
    this.log.push(v);
    this.onViolation?.(v);
  }

  /** Lane of `edge` the offset/direction corresponds to, or null (wrong side / none). */
  private laneFor(edge: Edge, s: number, off: number, dir: number): Lane | null {
    const el = this.graph.edgeLanes[edge.id];
    const list = dir > 0 ? el.fwd : el.back;
    if (list.length === 0) return null;
    let best: Lane | null = null;
    let bd = Infinity;
    for (const l of list) {
      const d = Math.abs(l.off - off);
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    void s;
    return best;
  }

  update(dt: number, p: PlayerSnapshot, events: TrafficEvent[]): void {
    this.time += dt;
    this.lastX = p.x;
    this.lastZ = p.z;
    const world = this.world;
    const ctx = this.context;
    if (this.yard) {
      ctx.limit = -1;
      ctx.zone = 0;
      ctx.urban = false;
      ctx.roadName = '';
      ctx.junction = null;
      ctx.onRoad = true;
      ctx.wrongWay = false;
      return;
    }
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    const kmh = Math.abs(p.speed) * 3.6;
    const moving = Math.abs(p.speed) > 0.6;

    // indicator / look history (seconds within a sliding window)
    const decay = (v: number, on: boolean): number => (on ? Math.min(6, v + dt) : Math.max(0, v - dt * 1.5));
    this.indL = decay(this.indL, p.indicator < 0 && !p.hazard);
    this.indR = decay(this.indR, p.indicator > 0 && !p.hazard);
    this.lookL = decay(this.lookL, p.lookYaw > 0.9);
    this.lookR = decay(this.lookR, p.lookYaw < -0.9);

    // --- where are we? ---
    const onSurface = world.surfaceAt(p.x, p.z, p.y + 0.6, this.hit);
    const hit = this.hit;
    ctx.onRoad = onSurface && hit.zone === 0;
    ctx.wrongWay = false;
    let edge: Edge | null = onSurface ? hit.edge : null;
    // A wheel over the edge line or a clipped corner must not make us lose
    // track of the road we are on: fall back to the nearest carriageway.
    let near = false;
    if (!onSurface || (hit.zone !== 0 && !hit.edge)) {
      if (world.locate(p.x, p.z, p.y, 2.2, this.frontHit) && this.frontHit.edge) {
        near = true;
        edge = this.frontHit.edge;
        hit.edge = edge;
        hit.s = this.frontHit.s;
        hit.off = this.frontHit.off;
      }
    }
    let dir = 0;
    let headingCos = 0;
    if (edge) {
      // travel direction relative to the edge
      const pl = edge.pl;
      const i = Math.min(pl.cum.length - 2, Math.max(0, this.segIndex(edge, hit.s)));
      const tx = pl.pts[i * 3 + 3] - pl.pts[i * 3];
      const tz = pl.pts[i * 3 + 5] - pl.pts[i * 3 + 2];
      const tl = Math.hypot(tx, tz) || 1;
      // Which way the car faces, not which way it creeps: at a standstill the
      // speed is ±0, and a car that rolls back a hand's breadth at the stop
      // line has not changed to the oncoming lane.
      headingCos = (fx * tx + fz * tz) / tl;
      dir = headingCos >= 0 ? 1 : -1;
    }

    if (edge && (hit.zone === 0 || near)) {
      const limit = dir > 0 ? edge.maxF : edge.maxB;
      // car parks, driveways and tracks have no signed limit: nothing to show
      const unsigned = edge.cls >= CLS.SERVICE && edge.zone === 0;
      ctx.limit = edge.zone === 7 ? 7 : unsigned ? -1 : limit;
      // what the signs allow, but never more than a truck with trailer may drive there
      let capped = false;
      if (this.truck && edge.zone !== 7 && !unsigned) {
        const cap = edge.cls <= CLS.MOTORWAY_LINK ? 80 : (edge.flags & EF.URBAN) !== 0 ? 0 : 60;
        if (cap > 0 && (ctx.limit === 0 || ctx.limit > cap)) {
          ctx.limit = cap;
          capped = true;
        }
      }
      ctx.zone = edge.zone;
      ctx.urban = (edge.flags & EF.URBAN) !== 0;
      ctx.roadName = edge.name || edge.ref;
      const lane = this.laneFor(edge, hit.s, hit.off, dir);
      const oneWayAgainst = (dir > 0 ? edge.lanesF : edge.lanesB) === 0;

      // --- wrong way in a one-way street ---
      // crossing a one-way carriageway at a junction is not driving against it
      const inJunctionZone = hit.s < edge.cutA + 2 || hit.s > edge.len - edge.cutB - 2;
      if (oneWayAgainst && moving && p.speed > 0 && Math.abs(headingCos) > 0.7 && !inJunctionZone && !(edge.flags & EF.MINOR_SERVICE)) {
        this.wrongWayT += dt;
        ctx.wrongWay = true;
        if (this.wrongWayT > 1.2) this.report('wrongWay', edge.cls <= CLS.TRUNK_LINK ? 'fail' : 'major', p, {}, 20);
      } else this.wrongWayT = 0;

      // --- keep right ---
      if (lane && !oneWayAgainst && !inJunctionZone && Math.abs(headingCos) > 0.8 && edge.lanesF > 0 && edge.lanesB > 0 && edge.laneW >= 2.5 && moving && p.speed > 3) {
        const myOff = hit.off * dir; // + = left of our direction
        const centre = (dir > 0 ? -edge.width / 2 + edge.margin + edge.lanesF * edge.laneW : edge.width / 2 - edge.margin - edge.lanesB * edge.laneW) * dir;
        // car centre beyond the middle of the road
        if (myOff > centre + 0.45) {
          this.wrongSide += dt;
          if (this.wrongSide > 3.5) this.report('keepRight', (edge.flags & EF.MARKED) !== 0 ? 'major' : 'minor', p, {}, 25);
        } else this.wrongSide = Math.max(0, this.wrongSide - dt * 2);
      }

      // --- speed ---
      const lim = unsigned ? 35 : ctx.limit;
      if (lim > 0) {
        const tolerance = lim <= 10 ? 5 : 6;
        const over = kmh - lim;
        if (over > tolerance) {
          this.speedOver += dt;
          if (this.speedOver > 1.6) {
            const sev: Severity = over > 25 ? 'fail' : over > 14 ? 'major' : 'minor';
            this.report(edge.zone === 7 ? 'speedWalk' : capped ? 'truckSpeed' : 'speed', sev, p, { limit: lim, speed: Math.round(kmh) }, sev === 'minor' ? 18 : 10);
          }
        } else this.speedOver = Math.max(0, this.speedOver - dt * 2);
      }

      // --- restricted roads ---
      if (edge !== this.lastEdge) {
        if (edge.access === ACCESS.PRIVATE && edge.tier >= 1) this.report('accessPrivate', 'minor', p, {}, 30);
        else if (edge.access === ACCESS.AGRICULTURAL) this.report('accessAgricultural', 'minor', p, {}, 30);
        else if (edge.access === ACCESS.DESTINATION && !this.allowed?.has(edge)) this.report('accessDestination', 'hint', p, {}, 60);
        this.lastEdge = edge;
      }

      // --- lane tracking: stop lines, signals, entering the junction ---
      if (lane && p.speed >= -0.5) this.trackLane(lane, hit.s, dt, p, fx, fz);
      else if (!lane) this.lane = null;
    } else {
      ctx.limit = -1;
      this.wrongWayT = 0;
      this.wrongSide = 0;
      // inside a junction area we keep the lane we came from; far from any road we forget it
      if (!onSurface || hit.node === null) {
        this.lostT += dt;
        if (this.lostT > 1.5) this.lane = null;
      } else this.lostT = 0;
    }
    if (edge) this.lostT = 0;

    // --- sidewalk and off-road ---
    if (onSurface && hit.zone === 1 && moving) {
      this.sidewalkT += dt;
      if (this.sidewalkT > 0.7) this.report('sidewalk', 'major', p, {}, 15);
    } else this.sidewalkT = 0;
    if (!onSurface && moving) {
      this.offRoadT += dt;
      if (this.offRoadT > 2.5) this.report('offRoad', 'minor', p, {}, 20);
    } else this.offRoadT = 0;

    this.judgeRedLine(p);

    if (this.entry) this.entry.vMax = Math.max(this.entry.vMax, Math.abs(p.speed));
    // --- leaving the junction: was the turn signalled? ---
    if (this.entry && edge && (hit.zone === 0 || near)) {
      const e = this.entry;
      // (on the road itself, not on the part of it that lies in a junction: where several roads meet
      // within a few metres, the ground of the junction belongs to more than one of them, and the car
      // is not turning into each road whose ground it crosses)
      const onRoad = hit.s > edge.cutA + 0.5 && hit.s < edge.len - edge.cutB - 0.5;
      if ((edge !== e.arm.edge && onRoad) || this.time - e.time > 25) {
        this.judgeTurn(edge, p);
        this.entry = null;
      }
    }

    // --- crossings (zebra, pedestrian lights) ---
    if (edge && moving && p.speed > 0) this.checkCrossings(edge, hit.s, dir, p);

    // --- events from the traffic ---
    for (const ev of events) {
      if (ev.type === 'collision') this.report('crash', 'fail', p, { speed: Math.round(ev.speed * 3.6) }, 6);
      else if (ev.type === 'pedestrianEndangered') this.report('pedestrian', 'fail', p, {}, 8);
      else if (ev.type === 'forcedBrake') this.judgePriority(ev.car, p, ev.cutIn);
    }
    if (p.hitScenery > 1.2) this.report('crashObject', p.hitScenery > 4 ? 'fail' : 'major', p, { speed: Math.round(p.hitScenery * 3.6) }, 5);

    // --- small things ---
    if (p.stalled) this.report('stall', 'hint', p, {}, 3);
    if (!p.seatbelt && kmh > 8) this.report('seatbelt', 'minor', p, {}, 120);
    if (p.handbrake > 0.5 && kmh > 12) {
      this.handbrakeT += dt;
      if (this.handbrakeT > 2) this.report('handbrakeOn', 'hint', p, {}, 30);
    } else this.handbrakeT = 0;
    if (p.indicator !== 0 && !p.hazard && kmh > 20) {
      this.indicatorOnT += dt;
      if (this.indicatorOnT > 25) this.report('indicatorLeftOn', 'hint', p, {}, 40);
    } else this.indicatorOnT = 0;

    // --- following distance ---
    if (kmh > 30) {
      let gap = Infinity;
      for (const c of this.traffic.cars) {
        const dx = c.x - p.x;
        const dz = c.z - p.z;
        const lf = dx * fx + dz * fz;
        if (lf < 2 || lf > 60) continue;
        const lr = Math.abs(dx * fz - dz * fx);
        if (lr > 1.3 || Math.abs(c.y - p.y) > 2) continue;
        gap = Math.min(gap, lf - 4.3);
      }
      // "halber Tacho" outside towns, about one second in town
      const need = Math.abs(p.speed) * (ctx.urban ? 0.75 : 1.2);
      if (gap < need * 0.6) {
        this.tailgateT += dt;
        if (this.tailgateT > 3) this.report('distance', gap < need * 0.35 ? 'major' : 'minor', p, { gap: Math.round(gap) }, 25);
      } else this.tailgateT = Math.max(0, this.tailgateT - dt);
    } else this.tailgateT = 0;
  }

  private segIndex(edge: Edge, s: number): number {
    const cum = edge.pl.cum;
    let lo = 0;
    let hi = cum.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private trackLane(lane: Lane, s: number, dt: number, p: PlayerSnapshot, fx: number, fz: number): void {
    const ctx = this.context;
    // position of the front bumper along the lane
    const centre = lane.dir > 0 ? s - lane.s0 : lane.s0 - s;
    const front = centre + (p.front ?? p.length / 2);
    if (lane !== this.lane) {
      this.lane = lane;
      this.prevLaneS = front;
      this.stoppedNearLine = false;
    }
    this.laneS = front;
    const node = lane.to;
    const arm = lane.armTo;
    const dist = lane.stopAt - front;
    const controlled = node.arms.length > 2;
    if (controlled && dist < 150 && dist > -2) {
      ctx.junction = {
        dist: Math.max(0, dist),
        role: arm.role,
        ctrl: node.ctrl,
        signal: arm.sg >= 0 && node.sc >= 0 ? this.signals.get(node.sc, arm.sg) : -1,
      };
    } else ctx.junction = null;
    if (!controlled) {
      this.prevLaneS = front;
      return;
    }
    if (dist < 9 && dist > -1 && Math.abs(p.speed) < 0.25) this.stoppedNearLine = true;

    // crossing the stop / give-way line
    if (this.prevLaneS < lane.stopAt && front >= lane.stopAt && p.speed > 0.3) {
      if (arm.sg >= 0 && node.sc >= 0) {
        const st = this.signals.get(node.sc, arm.sg);
        const age = this.signals.age(node.sc, arm.sg);
        if (st === SIG.RED || st === SIG.RED_AMBER) {
          // judged in judgeRedLine(); a moment of grace right after the change to red
          this.redLine = {
            lane,
            x: p.x,
            z: p.z,
            tol: Math.max(1, Math.min(lane.len - lane.stopAt, 2)),
            severity: st === SIG.RED && age < 0.6 ? 'major' : 'fail',
            lineReported: false,
          };
        } else if (st === SIG.AMBER && age > 1 + p.speed / 7) {
          // Amber: stop if that is possible with normal braking.  Whoever was
          // closer than reaction distance plus a 3.5 m/s² stop when it came on
          // may carry on – the amber phase is timed for exactly that.
          this.report('amberLight', 'minor', p, {}, 8);
        }
      } else if (arm.role === ROLE.STOP && !this.stoppedNearLine) {
        this.report('stopSign', 'major', p, {}, 8);
      }
      this.entry = {
        node,
        arm,
        lane,
        time: this.time,
        // seconds of signalling before the line; a signal that is on right now always counts
        indicatorL: Math.max(this.indL, p.indicator < 0 && !p.hazard ? 1 : 0),
        indicatorR: Math.max(this.indR, p.indicator > 0 && !p.hazard ? 1 : 0),
        nowL: p.indicator < 0 && !p.hazard,
        nowR: p.indicator > 0 && !p.hazard,
        lookedL: this.lookL > 0.2,
        lookedR: this.lookR > 0.2,
        yaw: p.yaw,
        signalRed: false,
        vMax: Math.abs(p.speed),
      };
      // roundabout: no indicator when entering (§ 8 (1a) StVO)
      if (node.ctrl === CTRL.ROUNDABOUT && !(lane.edge.flags & EF.ROUNDABOUT) && p.indicator !== 0 && !p.hazard) {
        this.report('roundaboutEntryIndicator', 'hint', p, {}, 20);
      }
    }
    this.prevLaneS = front;
    void dt;
    void fx;
    void fz;
  }

  /** Over the stop line on red: stopped just behind it, or driven on into the junction? */
  private judgeRedLine(p: PlayerSnapshot): void {
    const rl = this.redLine;
    if (!rl) return;
    const node = rl.lane.to;
    const st = this.signals.get(node.sc, rl.lane.armTo.sg);
    if (st !== SIG.RED && st !== SIG.RED_AMBER) {
      // green (or amber again) before the car got any further: a rolling start
      if (!rl.lineReported) this.report('stopLine', 'minor', p, {}, 8);
      this.redLine = null;
      return;
    }
    // backed off behind the line again
    if (this.lane === rl.lane && this.laneS < rl.lane.stopAt - 0.2) {
      this.redLine = null;
      return;
    }
    const beyond = Math.hypot(p.x - rl.x, p.z - rl.z);
    if (beyond > rl.tol) {
      this.report('redLight', rl.severity, p, {}, 8);
      if (this.entry && this.entry.lane === rl.lane) this.entry.signalRed = true;
      this.redLine = null;
    } else if (!rl.lineReported && Math.abs(p.speed) < 0.25) {
      this.report('stopLine', 'minor', p, {}, 8);
      rl.lineReported = true;
    }
  }

  /** After a junction: which way did we go, and was it announced? */
  private judgeTurn(exitEdge: Edge, p: PlayerSnapshot): void {
    const e = this.entry!;
    const node = e.node;
    const exitArm = node.arms.find((a) => a.edge === exitEdge);
    if (!exitArm) return;
    if (node.arms.length < 3) return;
    // turn angle from entry direction to exit direction (+ = left)
    const inAng = Math.atan2(e.arm.dz, -e.arm.dx); // direction of travel into the node = -(dx,dz); angleOf = atan2(-dz, dx)
    const outAng = Math.atan2(-exitArm.dz, exitArm.dx);
    let d = outAng - inAng;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const ad = Math.abs(d);
    let turn: number = ad <= 0.62 ? TURN.STRAIGHT : d > 0 ? TURN.LEFT : TURN.RIGHT;
    // same classification as the lane graph (and therefore as the navigation hints)
    const conn = e.lane.out.find((c) => c.to.edge === exitEdge);
    if (conn) turn = conn.turn === TURN.UTURN ? TURN.LEFT : conn.turn;
    // an oncoming car had to brake while we crossed: that is on us if we were the one turning left
    if (this.oncoming) {
      if (this.oncoming.node === node && this.time - this.oncoming.time < 25 && turn === TURN.LEFT) this.report('leftTurnOncoming', 'major', p, {}, 10);
      this.oncoming = null;
    }
    this.indL = 0;
    this.indR = 0;
    const ringIn = (e.arm.edge.flags & EF.ROUNDABOUT) !== 0;
    const ringOut = (exitEdge.flags & EF.ROUNDABOUT) !== 0;
    if (node.ctrl === CTRL.ROUNDABOUT) {
      // leaving the roundabout must be indicated to the right
      if (ringIn && !ringOut && e.indicatorR < 0.6) this.report('roundaboutExitIndicator', 'minor', p, {}, 10);
      return;
    }
    // following a priority road round a bend counts as turning, too – keep it simple: by geometry
    if (turn === TURN.LEFT) {
      if (e.indicatorL < 0.8) this.report(e.indicatorR > 0.8 ? 'wrongIndicator' : 'noIndicator', 'minor', p, { dir: 'left' }, 6);
      if (!e.lookedL && this.strict) this.report('noShoulderCheck', 'hint', p, { dir: 'left' }, 6);
    } else if (turn === TURN.RIGHT) {
      if (e.indicatorR < 0.8) this.report(e.indicatorL > 0.8 ? 'wrongIndicator' : 'noIndicator', 'minor', p, { dir: 'right' }, 6);
      if (!e.lookedR) this.report('noShoulderCheck', 'hint', p, { dir: 'right' }, 6);
      // a truck turns right at walking pace in town: cyclists and pedestrians beside it are hard to see
      if (this.truck && this.context.urban && e.vMax * 3.6 > 12) this.report('truckRightTurn', 'minor', p, { speed: Math.round(e.vMax * 3.6) }, 6);
    } else if ((e.nowL && e.indicatorL > 2.5) || (e.nowR && e.indicatorR > 2.5)) {
      this.report('wrongIndicator', 'hint', p, { dir: 'none' }, 10);
    }
    // entering forbidden directions
    if (this.world.isBanned(e.arm.edge, node, exitEdge)) this.report('turnBan', 'major', p, {}, 6);
  }

  /** An AI car had to brake hard because of us: were we the one who had to wait? */
  private judgePriority(car: TrafficCar, p: PlayerSnapshot, cutIn = true): void {
    const lane = this.lane;
    const entry = this.entry;
    const node = entry ? entry.node : lane && lane.stopAt - this.laneS < 12 ? lane.to : null;
    const myArm = entry ? entry.arm : lane ? lane.armTo : null;
    const carArm = car.conn ? car.conn.from.armTo : car.lane ? car.lane.armTo : null;
    if (!node || !myArm || !carArm || carArm.node !== node || carArm === myArm) {
      // Not a matter of this junction: pulled out or cut in right in front of someone who travels
      // the same way.  (A car coming from the side at a junction made of several nodes – a dual
      // carriageway, a roundabout – brakes for whoever is in its way, whoever has the right of
      // way there: that cannot be judged from here, and is not held against the driver.)
      // (And a car that saw the driver ahead from far away was not cut up: its distance is its own business.)
      const along = Math.sin(car.yaw) * Math.sin(p.yaw) + Math.cos(car.yaw) * Math.cos(p.yaw);
      if (cutIn && Math.abs(p.speed) > 1 && along > 0.6) this.report('cutOff', 'minor', p, {}, 15);
      return;
    }
    if (entry?.signalRed) return; // already recorded as a red-light offence
    const rank = (a: Arm): number => (a.role === ROLE.PRIORITY ? 3 : a.role === ROLE.RBL ? 2 : a.role === ROLE.YIELD || a.role === ROLE.STOP ? 1 : 0);
    // § 9 (3), (4): whoever turns left lets oncoming traffic through – also those turning right.
    // A car that turns left across our way and has to brake for us was the one to wait.
    const theirTurn = (car.conn ?? car.next)?.turn;
    const theyTurnLeft = theirTurn === TURN.LEFT || theirTurn === TURN.UTURN;
    // Whether the driver is the one turning left is known when the car leaves the junction
    // (judgeTurn): going straight on or turning right, it had the right of way over that car.
    if (node.ctrl === CTRL.SIGNALS && myArm.sg >= 0 && carArm.sg >= 0) {
      if (myArm.sg === carArm.sg && !theyTurnLeft) this.oncoming = { node, time: this.time };
      return;
    }
    const mine = rank(myArm);
    const theirs = rank(carArm);
    if (mine < theirs) {
      const id = myArm.role === ROLE.MINOR ? 'priorityDriveway' : node.ctrl === CTRL.ROUNDABOUT ? 'priorityRoundabout' : 'prioritySign';
      this.report(id, 'fail', p, {}, 10);
    } else if (mine === theirs) {
      const opposite = myArm.dx * carArm.dx + myArm.dz * carArm.dz < -0.64;
      if (opposite || myArm.role === ROLE.PRIORITY) {
        if (!theyTurnLeft) this.oncoming = { node, time: this.time };
      } else {
        // is the other one coming from our right?
        const rx = myArm.dz;
        const rz = -myArm.dx;
        if (carArm.dx * rx + carArm.dz * rz > 0.25) this.report('rightBeforeLeft', 'fail', p, {}, 10);
      }
    }
  }

  private checkCrossings(edge: Edge, s: number, dir: number, p: PlayerSnapshot): void {
    for (const c of edge.xings) {
      if (c.k !== XING.ZEBRA && c.k !== XING.SIGNAL) continue;
      // signed distance of the front bumper to the near edge of the crossing
      const d = (c.s - s) * dir - c.w / 2 - (p.front ?? p.length / 2);
      const prev = this.crossingState.get(c);
      this.crossingState.set(c, d);
      if (prev === undefined) continue;
      if (c.k === XING.SIGNAL && c.sc !== undefined) {
        // the crossing is the protected area; the bumper a hand's breadth into it is not yet "over"
        if (!(prev > -0.3 && d <= -0.3)) continue;
        const st = this.signals.get(c.sc, c.g ?? 0);
        if (st === SIG.RED || st === SIG.RED_AMBER) this.report('redLight', 'fail', p, {}, 8);
      } else if (c.k === XING.ZEBRA) {
        if (!(prev > 0 && d <= 0)) continue;
        const ped = this.traffic.pedestrianAt(c);
        if (ped && (ped.state === 'cross' || ped.waited > 0.6)) this.report('zebra', 'fail', p, {}, 8);
        else if (Math.abs(p.speed) * 3.6 > 35 && ped) this.report('zebraSpeed', 'minor', p, {}, 8);
      }
    }
  }
}

export { SEVERITY_POINTS };
