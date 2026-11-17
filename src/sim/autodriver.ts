// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A driver who keeps to the rules: follows a route along the lanes with the
 * real vehicle model, at the speed the signs allow and the bends permit,
 * stops at red lights and stop lines, indicates, looks over the shoulder,
 * keeps a distance, gives way and lets pedestrians cross.
 *
 * It drives the car of the demonstration drives in the game, and it is the
 * "virtual learner driver" of tests/drive.sim.ts – what is shown to a
 * learner is what is checked against the rule monitor there.
 *
 * The driver only decides; whoever uses it steps the vehicle and the rule
 * monitor (whose idea of the lane the car is on the driver shares).
 */
import { newPolySample, projectOnPolyline, samplePolyline } from '../core/geom.ts';
import { TURN, lanePoint } from '../world/lanes.ts';
import type { Connector, Lane } from '../world/lanes.ts';
import { CLS, CTRL, EF, ROLE, XING } from '../world/types.ts';
import type { CrossingJson } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { Edge, World } from '../world/world.ts';
import { offsetAt } from './pastblock.ts';
import type { PastState } from './pastblock.ts';
import type { RuleMonitor } from './rules.ts';
import { SIG } from './signals.ts';
import type { SignalSystem } from './signals.ts';
import type { SelfDriving, Traffic } from './traffic.ts';
import type { Vehicle, VehicleSpec } from './vehicle/index.ts';

export interface AutoDriverOptions {
  spec: VehicleSpec;
  /** from the point the vehicle is measured at (Vehicle.getModelPosition) to its front bumper (m) */
  front: number;
  /** a truck with a trailer: slower in turns, earlier on the brakes, 60 km/h outside town and 80 on the motorway */
  truck?: boolean;
  /** false: lights and stop signs are ignored (to check that the rule monitor notices) */
  obey?: boolean;
  /** at most this outside built-up areas and on the motorway (km/h) – by default a truck's 60 and 80 */
  caps?: { rural: number; motorway: number } | null;
}

/** Why the driver does what it is doing – for telling a learner who watches. */
export type AutoRemark = '' | 'red' | 'stop' | 'yield' | 'zebra' | 'follow' | 'turn' | 'lane' | 'rbl' | 'roundabout' | 'ringExit' | 'halt' | 'deadEnd' | 'cyclist' | 'arrow' | 'lightsOut' | 'closed';

export interface AutoCommand {
  /** -1 … 1, positive = to the right */
  steer: number;
  throttle: number;
  brake: number;
  /** -1 left, 0 off, 1 right */
  indicator: number;
  /** the head: rad, positive = looking left */
  look: number;
  remark: AutoRemark;
  /** standing or stopping because it has to (a light, a line, traffic, the destination) – not stuck */
  waiting: boolean;
  /** standing at the place it was told to halt at */
  arrived: boolean;
  /**
   * Standing at the end of a street the way leads back out of: the path to
   * turn round by.  Turning in the road takes going back and forth, which
   * this driver does not do – whoever runs it puts the car onto `to`.
   */
  turnRound: Connector | null;
}

const smp = newPolySample();

export class AutoDriver {
  readonly world: World;
  readonly signals: SignalSystem;
  readonly rules: RuleMonitor;
  /** the other road users, if the driver is to mind them */
  traffic: Traffic | null;
  readonly opts: Required<AutoDriverOptions>;
  /** where to come to a halt (a place on a road of the route's last piece), or null: drive on */
  halt: { x: number; z: number } | null = null;
  readonly cmd: AutoCommand = { steer: 0, throttle: 0, brake: 0, indicator: 0, look: 0, remark: '', waiting: false, arrived: false, turnRound: null };
  /** what the last step saw – for tracing */
  readonly seen = { next: null as Connector | null, tx: 0, tz: 0, limit: 0, distToLine: Infinity, mustStop: false, crossStop: false, turn: 0, gap: Infinity };
  private readonly turnSpeed: number;
  private readonly decel: number;
  private stoppedFor = 0;
  private yieldWait = 0;
  private changeT = 0;
  private netWait = 0;
  private lastTurn = 0;
  private lastNext: Connector | null = null;
  private haltLane: Lane | null = null;
  /** going round something that stands in the way (src/sim/pastblock.ts) */
  private past: PastState | null = null;
  private readonly proj = { s: 0, off: 0, d2: 0, seg: 0 };
  /** the way ahead as bendCap samples it: which way it runs, every few metres */
  private readonly bendDir = new Float32Array(2 * 48);
  private readonly bendSmp = newPolySample();
  private bendTick = 0;
  private bendLimit = Infinity;
  private readonly hit = newSurfaceHit();
  private readonly me: SelfDriving = { lane: null, conn: null, s: 0, v: 0, next: null, length: 4.3, width: 1.8, x: 0, y: 0, z: 0, yaw: 0 };

  constructor(world: World, signals: SignalSystem, rules: RuleMonitor, traffic: Traffic | null, opts: AutoDriverOptions) {
    this.world = world;
    this.signals = signals;
    this.rules = rules;
    this.traffic = traffic;
    this.opts = { truck: false, obey: true, ...opts, caps: opts.caps !== undefined ? opts.caps : opts.truck ? { rural: 60, motorway: 80 } : null };
    // speed in a turn at a junction (a truck turns right at walking pace in town, § 9 Abs. 6 StVO)
    this.turnSpeed = this.opts.truck ? 2.7 : 4.5;
    // the deceleration the driver plans with when stopping at a line (15 t take longer)
    this.decel = this.opts.truck ? 1.3 : 2.2;
    this.me.length = opts.spec.length ?? 4.28;
    this.me.width = opts.spec.width ?? 1.79;
  }

  /**
   * The speed the bends ahead allow right now: each is to be reached at the
   * speed it can be driven at (with the sideways pull the steering keeps to),
   * by braking gently from here.  The steering alone sees a bend a second
   * ahead – enough in town, far too late for a hairpin behind a straight on a
   * country road.  `from`: how far along the lane (or, in a junction, along
   * the path through it) the car is.
   */
  private bendCap(lane: Lane | null, from: number, next: Connector | null, route: readonly Connector[], speed: number): number {
    const STEP = 6;
    /** the turn is measured over 2 × SPAN steps: a kink in the line of a road is a gentle bend, a hairpin is not */
    const SPAN = 2;
    const pull = this.opts.truck ? 1.5 : 2.2;
    const ease = this.opts.truck ? 1.1 : 1.7;
    const reach = Math.min(240, (speed * speed) / (2 * ease) + 45);
    const n = Math.min(48, Math.ceil(reach / STEP) + 2 * SPAN + 1);
    const dir = this.bendDir;
    const smp = this.bendSmp;
    // along the lane the car is on, the path through the junction behind it, the lane after that, …
    let piece: Lane | Connector | null = lane ?? next;
    let onLane = lane !== null;
    let after: Connector | null = lane ? next : null;
    let s = Math.max(0, from);
    let count = 0;
    while (count < n && piece) {
      const len: number = piece.len;
      if (s > len) {
        s -= len;
        if (onLane) {
          const l = piece as Lane;
          piece = after ?? route.find((r) => r.from === l) ?? (l.out.length === 1 ? l.out[0] : null);
          after = null;
        } else piece = (piece as Connector).to;
        onLane = !onLane;
        continue;
      }
      if (onLane) lanePoint(piece as Lane, s, smp);
      else samplePolyline((piece as Connector).pl, s, smp);
      dir[count * 2] = smp.tx;
      dir[count * 2 + 1] = smp.tz;
      count++;
      s += STEP;
    }
    let cap = Infinity;
    for (let i = SPAN; i + SPAN < count; i++) {
      const a = (i - SPAN) * 2;
      const b = (i + SPAN) * 2;
      const turn = Math.acos(Math.max(-1, Math.min(1, dir[a] * dir[b] + dir[a + 1] * dir[b + 1])));
      if (turn < 0.05) continue;
      const bend = Math.sqrt((pull * 2 * SPAN * STEP) / turn);
      // (the bend begins where the stretch it was measured over begins)
      const d = Math.max(0, (i - SPAN) * STEP - 4);
      cap = Math.min(cap, Math.sqrt(bend * bend + 2 * ease * d));
    }
    return cap;
  }

  /** Forget what was under way (after the car was put somewhere else). */
  reset(): void {
    this.bendTick = 0;
    this.bendLimit = Infinity;
    this.stoppedFor = 0;
    this.yieldWait = 0;
    this.changeT = 0;
    this.netWait = 0;
    this.lastTurn = 0;
    this.lastNext = null;
    this.haltLane = null;
    this.past = null;
    this.cmd.arrived = false;
    this.cmd.turnRound = null;
  }

  /**
   * One step.  `mpos`: where the vehicle is (Vehicle.getModelPosition),
   * `route`: the connectors of the way to go (from the navigation), in order.
   */
  step(dt: number, v: Vehicle, mpos: ArrayLike<number>, route: readonly Connector[]): AutoCommand {
    const { world, signals, rules, traffic } = this;
    const { spec, front: FRONT, truck: TRUCK, obey } = this.opts;
    const caps = this.opts.caps;
    const TURN_SPEED = this.turnSpeed;
    const DECEL = this.decel;
    const hit = this.hit;
    const proj = this.proj;
    const lane = rules.laneNow;
    const laneS = rules.laneFront;
    let remark: AutoRemark = '';

    // --- path: current lane, then the route's connectors ---
    let next: Connector | null = null;
    /** the lane the route goes on from is taken: wait for a gap before moving over */
    let laneBlocked = false;
    /** moving over to another lane of the carriageway: -1 to the left, 1 to the right */
    let change = 0;
    // the lane to follow: the one the monitor has us in – or its neighbour, if the route goes on from that one
    let path: Lane | null = lane;
    if (lane) {
      next = route.find((c) => c.from === lane) ?? null;
      if (!next) {
        const rc = route.find((c) => c.from.edge === lane.edge && c.from.dir === lane.dir);
        if (rc) {
          next = rc;
          path = rc.from; // get in lane
          // to which side: indicated, and looked over the shoulder, before the car moves over
          change = (rc.from.off - lane.off) * lane.dir > 0 ? -1 : 1;
          // … and only where there is room: nobody beside, nobody coming up from behind
          if (traffic && !traffic.roomOn(rc.from, laneS - FRONT, Math.max(0, v.speed), this.me.length)) {
            path = lane;
            laneBlocked = true;
          } else if (traffic && this.changeT < 1) path = lane;
        } else next = lane.out.length === 1 ? lane.out[0] : null;
      }
    }
    // roadworks (src/sim/roadevents.ts): a lane closed ahead – over to the open one in good time, and not back before its end
    const works = traffic?.roadEvents ?? null;
    if (works && lane) {
      if (path && path !== lane && !works.laneOpen(path, laneS)) {
        path = lane;
        change = 0;
        laneBlocked = false;
      }
      const open = works.laneOpen(lane, laneS) ? null : works.openLane(lane);
      if (open) {
        change = (open.off - lane.off) * lane.dir > 0 ? -1 : 1;
        path = traffic && (!traffic.roomOn(open, laneS - FRONT, Math.max(0, v.speed), this.me.length) || this.changeT < 1) ? lane : open;
      }
    }
    if (next) this.lastNext = next;
    else if (!lane) next = this.lastNext;
    // pure pursuit target point: lookahead along lane → connector → next lane
    const speed = Math.max(0, v.speed);
    // look less far ahead in tight turns so the corner is not cut
    const tight = next !== null && next.turn !== TURN.STRAIGHT && next.len < 25;
    // (and in a very tight one – the way out of a car park into a narrow street – hardly at all:
    // the car's middle would otherwise run over the corner of the pavement)
    const la = tight ? Math.min(2.6 + speed * 0.45, 1.5 + next!.len * 0.22) : 5 + speed * 0.9;
    let tx = mpos[0] - Math.sin(v.yaw) * 5;
    let tz = mpos[2] - Math.cos(v.yaw) * 5;
    let limit = 8;
    let distToLine = Infinity;
    let mustStop = false;
    let crossStop = false;
    let turn = 0;
    /** distance to a junction behind joints of the road, where the turn to announce is */
    let ahead = Infinity;
    // A learner looks further than the next junction: every turn within braking
    // distance along the route limits the speed (short links between junctions
    // would otherwise hide a sharp turn until it is too late).
    // `first` begins `dist` metres ahead of the front bumper (negative: we are on it).
    /**
     * How fast the car may still be `d` metres before a turn at a junction:
     * one steady easing off from far away down to the speed of the turn – no
     * step in it anywhere, or whoever follows would have to brake hard.
     */
    const turnCap = (d: number): number => {
      const near = Math.min(45, Math.max(0, d));
      return TURN_SPEED + near * (TRUCK ? 0.08 : 0.12) + Math.max(0, d - 45) * (TRUCK ? 0.045 : 0.065);
    };
    /** how fast a lane may be driven: its limit, walking pace in a traffic-calmed area, slowly on yards and car parks */
    const allowed = (l: Lane): number => {
      let a = Number.isFinite(l.limit) ? l.limit : 36;
      if (caps) a = Math.min(a, l.edge.cls <= CLS.MOTORWAY_LINK ? caps.motorway / 3.6 : (l.edge.flags & EF.URBAN) !== 0 ? a : caps.rural / 3.6);
      if (l.edge.zone === 7) a = 1.7;
      if (l.edge.cls >= 13) a = Math.min(a, 6);
      return a;
    };
    /** a stop on the way ahead (a light, a stop sign) is what holds the speed down: braked for firmly */
    let stopAhead = false;
    const preview = (first: Connector | null, dist: number, cap: number): number => {
      let c = first;
      let d = dist;
      let out = cap;
      for (let hop = 0; c && hop < 10 && d < 360; hop++) {
        if (c.turn !== TURN.STRAIGHT) out = Math.min(out, turnCap(d - 2));
        const l2: Lane = c.to;
        // a lower limit on the road ahead (a sign, a zone, a car park) is reached at that speed,
        // not braked down to behind it – whoever follows would have to brake hard, too
        const v2 = allowed(l2);
        if (v2 < out) out = Math.min(out, Math.sqrt(v2 * v2 + 2 * (TRUCK ? 1.0 : 1.4) * Math.max(0, d + c.len - 2)));
        // a red light or a stop sign at the end of the lane behind it
        const a2 = l2.armTo;
        const dStop = d + c.len + l2.stopAt;
        // (amber: stop if that is still possible with normal braking – otherwise on, without dithering)
        // (the green arrow beside it lets the car go on if it turns right there)
        const on2 = route.find((r) => r.from === l2);
        const sg2 = a2.sg < 0 || l2.to.sc < 0 || (on2 && on2.turn === TURN.RIGHT && signals.arrow(a2) === SIG.GREEN) ? SIG.GREEN : signals.get(l2.to.sc, a2.sg);
        const red = sg2 === SIG.RED || sg2 === SIG.RED_AMBER || (sg2 === SIG.AMBER && (speed * speed) / (2 * Math.max(dStop - 2.5, 0.5)) < 3);
        // (a line the front of the car has only just reached still counts: the car is not in the junction yet)
        if (obey && dStop > -0.6 && l2.to.arms.length > 2 && (red || a2.role === ROLE.STOP)) {
          const room = dStop - 2.5;
          // (A light right behind a junction: wait before it, do not creep up to the line – by the
          // time the car counts as being on that short lane, its front is at the line or past it.
          // A stop sign there is crept up to: the car has to get to its line to stop at it.)
          const cap = red && room < 0.3 ? 0 : Math.sqrt(2 * (DECEL - 0.2) * Math.max(room, 0.3));
          if (cap < out) {
            out = cap;
            stopAhead = true;
          }
          if (red && room < 25 && remark === '') remark = 'red';
        }
        d += c.len + l2.len;
        const from = l2;
        c = route.find((r) => r.from === from) ?? (l2.out.length === 1 ? l2.out[0] : null);
      }
      return out;
    };
    // inside a junction the monitor's lane position is frozen: measure along the connector instead
    const inJunction = world.surfaceAt(mpos[0], mpos[2], mpos[1] + 0.6, hit) && hit.node !== null && hit.node.arms.length > 1;
    // the monitor may already count us on the lane we are heading for (wide junction areas):
    // then that lane is the path, not the connector at its far end
    const onExitLane = lane !== null && laneS < Math.min(lane.stopAt, lane.len) - 0.5;
    /** crossings of lane `l`, whose start is `offset` metres ahead of the front bumper */
    const scanCrossings = (l: Lane, offset: number): void => {
      const xs = l.edge.xings;
      if (xs.length === 0) return;
      for (const c of xs) {
        const pos = l.dir > 0 ? c.s - l.s0 : l.s0 - c.s;
        const d = offset + pos - c.w / 2;
        if (d < -0.5 || d > 70) continue;
        let stop = false;
        if (c.sc !== undefined) {
          const st = signals.get(c.sc, c.g ?? 0);
          stop = st === SIG.RED || st === SIG.RED_AMBER || (st === SIG.AMBER && (speed * speed) / (2 * Math.max(d, 0.5)) < 3);
          if (stop) remark = 'red';
        }
        // people: whoever is on a crossing is let across, whatever the light says by now – and at
        // a zebra crossing whoever stands at it as well
        const walker = !stop && traffic ? traffic.pedestrianAt(c) : null;
        if (walker && (walker.state === 'cross' || c.k === XING.ZEBRA)) {
          stop = true;
          remark = 'zebra';
        }
        if (stop) {
          const dd = Math.max(0, d - 1.5);
          limit = Math.min(limit, Math.sqrt(2 * DECEL * dd));
          if (dd < 0.6) crossStop = true;
        }
      }
    };
    /**
     * The point to steer at: `la` metres ahead along the way (`sample(d)` puts
     * the point `d` metres ahead into smp) – nearer in a bend, so that the
     * chord to it does not cut the bend, and with it the kerb on the inside or
     * the side of the road where others come the other way.
     */
    const aim = (sample: (d: number) => void): void => {
      sample(la);
      if (tight) return;
      const bx = smp.tx;
      const bz = smp.tz;
      // … and a little further on: a bend is steered into where it begins, not where it comes into view
      // (steering at a point 10 m ahead, the car turned in 10 m early and cut a sharp bend by a metre)
      sample(Math.min(la * 1.6, la + 14));
      const fx2 = smp.tx;
      const fz2 = smp.tz;
      sample(0);
      const t0x = smp.tx;
      const t0z = smp.tz;
      const bend = Math.acos(Math.max(-1, Math.min(1, bx * t0x + bz * t0z)));
      const far = Math.acos(Math.max(-1, Math.min(1, fx2 * t0x + fz2 * t0z)));
      const turnAhead = Math.max(bend, far);
      const d = turnAhead > 0.06 ? Math.max(3.5, speed * 0.55, Math.min(la, Math.sqrt((2.4 * la) / turnAhead))) : la;
      sample(d);
      // What is left of the cut – about d times the turn up to the point, by 8 – is made up for by
      // putting the point that far to the outside: in a bend to the left the inside is where the
      // others come the other way.
      const turned = Math.acos(Math.max(-1, Math.min(1, smp.tx * t0x + smp.tz * t0z)));
      const out = Math.min(TRUCK ? 0.25 : 0.4, (d * turned) / 8);
      if (out > 0.03) {
        const side = t0x * smp.tz - t0z * smp.tx < 0 ? 1 : -1;
        smp.x += -smp.tz * out * side;
        smp.z += smp.tx * out * side;
      }
    };
    const me = this.me;
    me.v = speed;
    me.x = mpos[0];
    me.y = mpos[1];
    me.z = mpos[2];
    me.yaw = v.yaw;
    me.lane = null;
    me.conn = null;
    me.next = null;
    me.route = route;
    me.past = this.past;
    let halting = false;
    /** at the place to halt at (not merely standing near it, behind somebody) */
    let atHalt = false;
    let turnRound: Connector | null = null;
    /** how far along the path through the junction the car is (when it is not on a lane) */
    let connS = 0;
    if (((inJunction && !onExitLane) || !lane) && next) {
      projectOnPolyline(next.pl, mpos[0], mpos[2], proj);
      const on = next;
      const at = proj.s;
      connS = at;
      aim((d) => {
        const sj = at + d;
        if (sj <= on.len) samplePolyline(on.pl, sj, smp);
        else {
          lanePoint(on.to, Math.min(on.to.len, sj - on.len), smp);
          works?.offset(on.to, Math.min(on.to.len, sj - on.len), smp);
        }
      });
      tx = smp.x;
      tz = smp.z;
      limit = next.turn === TURN.STRAIGHT ? Math.min(Number.isFinite(next.to.limit) ? next.to.limit : 36, 14) : TURN_SPEED;
      // (measured as for the car, whose front is 2.14 m ahead of its middle)
      limit = preview(next, -proj.s - (FRONT - 2.14), limit);
      turn = this.lastTurn;
      me.conn = next;
      me.s = proj.s;
      if (obey) scanCrossings(next.to, next.len - proj.s - FRONT);
    } else if (lane) {
      const centre = laneS - FRONT;
      me.lane = lane;
      me.s = centre;
      me.next = next;
      // (a truck with a trailer: 80 km/h on the motorway, 60 km/h on other roads outside built-up areas)
      limit = allowed(lane);
      const here = path ?? lane;
      const onward = next;
      aim((d) => {
        const sl = centre + d;
        // (where a side closed for roadworks is passed on the oncoming lane: over there)
        if (sl <= lane.len || !onward) {
          lanePoint(here, Math.min(lane.len, sl), smp);
          works?.offset(here, Math.min(lane.len, sl), smp);
        } else if (sl - lane.len <= onward.len) samplePolyline(onward.pl, sl - lane.len, smp);
        else {
          lanePoint(onward.to, Math.min(onward.to.len, sl - lane.len - onward.len), smp);
          works?.offset(onward.to, Math.min(onward.to.len, sl - lane.len - onward.len), smp);
        }
      });
      if (centre + la <= lane.len || next) {
        tx = smp.x;
        tz = smp.z;
      }
      limit = preview(next, Math.max(0, lane.len - laneS), limit);
      // roadworks and closures (src/sim/roadevents.ts): their limit; the site light, the oncoming traffic at a narrowing, the end of a closed lane, a closed road
      if (works) {
        const g = works.gate(lane, laneS, speed, next);
        if (g.cap < limit) limit = g.cap;
        // (the end of a closed lane does not hold up a car that is moving over already)
        if (obey && g.stop < Infinity && !(g.why === 'lane' && path !== lane)) {
          const dd = Math.max(0, g.stop - 1.2);
          limit = Math.min(limit, Math.sqrt(2 * DECEL * dd));
          if (dd < 0.6) crossStop = true;
          remark = g.why === 'light' ? 'red' : g.why === 'oncoming' ? 'yield' : g.why === 'closed' ? 'closed' : 'lane';
        }
      }
      distToLine = lane.stopAt - laneS;
      const node = lane.to;
      const arm = lane.armTo;
      // A light or a stop sign at the end of the lane counts whether the way goes on behind it or not:
      // the last road of a way may end at a red light, and the place to halt at may lie behind its line.
      if (node.arms.length > 2 && !next) {
        if (obey && arm.sg >= 0 && node.sc >= 0) {
          const st = signals.get(node.sc, arm.sg);
          if (st === SIG.RED || st === SIG.RED_AMBER) mustStop = true;
          if (st === SIG.AMBER && (speed * speed) / (2 * Math.max(distToLine, 0.5)) < 3) mustStop = distToLine > 0;
          if (mustStop) remark = 'red';
        } else if (obey && arm.role === ROLE.STOP && this.stoppedFor < 1) {
          mustStop = true;
          remark = 'stop';
        }
      }
      if (next && node.arms.length > 2) {
        turn = next.turn === TURN.LEFT ? -1 : next.turn === TURN.RIGHT ? 1 : 0;
        // roundabout: indicate right only when leaving
        const ring = (lane.edge.flags & EF.ROUNDABOUT) !== 0;
        if (node.ctrl === CTRL.ROUNDABOUT) {
          turn = ring && !(next.to.edge.flags & EF.ROUNDABOUT) ? 1 : 0;
          if (distToLine < 40) remark = ring ? (turn ? 'ringExit' : remark) : 'roundabout';
        } else if (node.ctrl === CTRL.RBL && distToLine < 40) remark = 'rbl';
        // the lights are out of order: the signs decide (said here; "stop" and "give way" follow where they apply)
        if (node.dark && distToLine < 50) remark = 'lightsOut';
        if (obey && arm.sg >= 0 && node.sc >= 0) {
          const st = signals.get(node.sc, arm.sg);
          // the green arrow beside the light: turning right is allowed while it is lit, whatever the main light shows
          const arrow = next.turn === TURN.RIGHT ? signals.arrow(arm) : -1;
          if (arrow === SIG.GREEN) {
            if (st !== SIG.GREEN && distToLine < 40) remark = 'arrow';
          } else {
            if (st === SIG.RED || st === SIG.RED_AMBER) mustStop = true;
            if ((st === SIG.AMBER || arrow === SIG.AMBER) && (speed * speed) / (2 * Math.max(distToLine, 0.5)) < 3) mustStop = distToLine > 0;
            else if (arrow === SIG.AMBER) mustStop = false;
            if (mustStop) remark = 'red';
          }
        } else if (obey && arm.role === ROLE.STOP && this.stoppedFor < 1) {
          mustStop = true;
          remark = 'stop';
        }
        // slow down for the turn – and towards a junction where others may have the right of way
        if (next.turn !== TURN.STRAIGHT) limit = Math.min(limit, turnCap(distToLine));
        else if (arm.role !== ROLE.PRIORITY) limit = Math.min(limit, 7 + Math.max(0, distToLine - 30) * 0.1);
        // A red light a few metres behind this junction – the two belong together, as where a
        // road crosses a dual carriageway: wait here, in between there is no room to stand.
        const l2 = next.to;
        const a2 = l2.armTo;
        if (obey && !mustStop && l2.len < 9 && a2.sg >= 0 && l2.to.sc >= 0) {
          const st2 = signals.get(l2.to.sc, a2.sg);
          if (st2 === SIG.RED || st2 === SIG.RED_AMBER || (st2 === SIG.AMBER && distToLine > 2)) {
            mustStop = true;
            remark = 'red';
          }
        }
      } else if (next) {
        // A mere joint in the road (the way was mapped in pieces): the junction behind it decides
        // what to indicate and where to look – a learner sees it coming, however short the pieces are.
        let l2: Lane = next.to;
        let c2: Connector | null = route.find((r) => r.from === l2) ?? (l2.out.length === 1 ? l2.out[0] : null);
        let d = Math.max(0, lane.len - laneS) + next.len + l2.len;
        for (let hop = 0; c2 && hop < 6 && d < 45 && l2.to.arms.length <= 2; hop++) {
          l2 = c2.to;
          d += c2.len + l2.len;
          const from = l2;
          c2 = route.find((r) => r.from === from) ?? (l2.out.length === 1 ? l2.out[0] : null);
        }
        if (c2 && d < 45 && l2.to.arms.length > 2 && l2.to.ctrl !== CTRL.ROUNDABOUT) {
          turn = c2.turn === TURN.LEFT ? -1 : c2.turn === TURN.RIGHT ? 1 : 0;
          ahead = d;
        }
      }
      // --- the others at the junction: give way, and never drive into a car that is crossing ---
      let yielding = false;
      if (traffic && obey && next && !mustStop && (node.arms.length > 2 || next.conflicts.length > 0) && distToLine > -1.5 && distToLine < 28) {
        let ok = traffic.mayPass(me, next, Math.max(distToLine, 0));
        // everybody waits for somebody: after a while, with the junction empty, take a tighter gap
        if (!ok && this.yieldWait > 12 && traffic.clearOf(next) && traffic.mayPass(me, next, Math.max(distToLine, 0), true)) ok = true;
        if (!ok) {
          mustStop = true;
          yielding = true;
          remark = 'yield';
        } else if (node.arms.length > 2 && !traffic.roomBehind(next.to, this.me.length + 2.5)) {
          // The junction is kept clear: where the traffic stands behind it, nobody drives into it –
          // not with the right of way and not on green (§ 11 Abs. 1 StVO).  Whoever waits in the
          // junction is in the way of those who cross.
          mustStop = true;
          yielding = true;
          remark = 'follow';
        } else if (next.turn === TURN.RIGHT && traffic.cyclists.blocksRightTurn(lane, laneS - FRONT, this.me.length / 2 + 0.5)) {
          // Turning right: the cyclists who ride straight on – beside the car, coming up behind it –
          // go first (§ 9 Abs. 3 StVO).  Seen by the look over the shoulder, waited for at the line.
          mustStop = true;
          remark = 'cyclist';
        }
      }
      if (yielding && speed < 0.5) this.yieldWait += dt;
      else if (!yielding) this.yieldWait = 0;
      // --- crossings on the way: a red pedestrian light, people at a zebra crossing ---
      // (on this lane and on the ones the way goes on to: a crossing may lie right behind a turn)
      if (obey) {
        scanCrossings(lane, -laneS);
        let off = lane.len - laneS;
        let c: Connector | null = next;
        for (let hop = 0; c && hop < 4 && off < 60; hop++) {
          const l2: Lane = c.to;
          off += c.len;
          scanCrossings(l2, off);
          off += l2.len;
          c = route.find((r) => r.from === l2) ?? (l2.out.length === 1 ? l2.out[0] : null);
        }
      }
      // the lane to get into is taken: hold back, and wait before the junction rather than push in
      if (laneBlocked) {
        limit = Math.min(limit, Math.max(3, speed - 1));
        if (distToLine < 14) {
          mustStop = true;
          remark = 'yield';
        }
      }
      // --- the place to halt at: on this lane, or passed already ---
      if (this.halt) {
        const h = this.halt;
        const e: Edge = lane.edge;
        if (this.haltLane !== lane && h.x > e.minX - 8 && h.x < e.maxX + 8 && h.z > e.minZ - 8 && h.z < e.maxZ + 8) {
          projectOnPolyline(e.pl, h.x, h.z, proj);
          if (proj.d2 < (e.width / 2 + 6) * (e.width / 2 + 6)) {
            this.haltLane = lane;
            this.haltS = lane.dir > 0 ? proj.s - lane.s0 : lane.s0 - proj.s;
          }
        }
        if (this.haltLane === lane) {
          // the middle of the car at the place; if it lies behind already, stop where it is safe: here
          const dd = Math.max(0, Math.min(this.haltS, lane.len - 3) - centre);
          limit = Math.min(limit, Math.sqrt(2 * (DECEL * 0.7) * dd));
          halting = dd < 45;
          if (halting) remark = 'halt';
          if (dd < 0.6) {
            crossStop = true;
            atHalt = true;
          }
        }
      }
      // --- the end of the street, and the way leads back out of it: stop short of the end ---
      if (next && next.from === lane && next.turn === TURN.UTURN && lane.to.arms.length === 1) {
        const dd = Math.max(0, lane.len - 3.5 - centre);
        limit = Math.min(limit, Math.sqrt(2 * (DECEL * 0.7) * dd));
        if (dd < 45) {
          halting = true;
          remark = 'deadEnd';
        }
        if (dd < 0.6) {
          crossStop = true;
          turnRound = next;
        }
      }
      if ((distToLine > 45 && ahead > 45) || distToLine < -3) turn = 0;
      this.lastTurn = turn;
    } else {
      // inside a junction or off the lane: keep following the last planned connector
      limit = 5;
    }
    // --- crossing the way of others: turning left, or through a junction made of several nodes ---
    // (where the two carriageways of a wide road are crossed one after the other, the lights
    // and the right of way of the map end at each of them – the driver looks for himself)
    if (traffic && obey && next && (me.lane || me.conn)) {
      const left = next.turn === TURN.LEFT || next.turn === TURN.UTURN;
      const cluster = (lane !== null && lane.len < 9) || next.to.len < 9;
      if ((left || cluster) && (me.conn === next || distToLine < 18)) {
        const xd = traffic.crossingAhead(me, 26);
        // (a car's length into their way already: on, and out of it)
        if (xd < Infinity && xd > FRONT + 0.8) {
          if (me.lane && distToLine > 0.5) {
            // still before the junction: wait at the line, not somewhere inside in somebody's way
            mustStop = true;
          } else {
            const room = xd - FRONT - 3.2;
            limit = Math.min(limit, Math.sqrt(2 * DECEL * Math.max(0, room)));
            if (room < 0.6) crossStop = true;
          }
          remark = 'yield';
        }
      }
    }
    // --- whoever is ahead on the way: two seconds behind, and never faster than could be stopped ---
    /** it stands for a reason of the road (a line, a light, a crossing, the place to halt at) – not for what is in its way */
    const held = mustStop || crossStop || halting;
    let gap = Infinity;
    if (traffic && (me.lane || me.conn)) {
      const lead = traffic.aheadOf(me, Math.min(110, 18 + speed * 4));
      // somebody standing half in the way who does not move either (he waits for us, we for him):
      // after a while, past him at a crawl
      if (lead.loose && lead.v < 0.3 && speed < 0.3 && lead.gap < 6) this.netWait += dt;
      else if (speed > 2 || !lead.loose) this.netWait = 0;
      if (lead.loose && this.netWait > 6) {
        // … with what room there is: at half a metre it is a standstill again
        limit = Math.min(limit, 1.2);
        lead.gap = lead.gap < 0.6 ? lead.gap : Infinity;
      }
      gap = lead.gap;
      if (lead.gap < Infinity) {
        const room = lead.gap - 3;
        const follow = lead.v + 0.45 * (room - 1.9 * speed);
        const stoppable = Math.sqrt(lead.v * lead.v + 2 * (DECEL * 0.85) * Math.max(room, 0));
        const cap = Math.max(0, Math.min(follow, stoppable));
        if (cap < limit) {
          if (cap < limit - 0.6 && remark === '') remark = 'follow';
          limit = cap;
        }
        if (lead.gap < 2.2) crossStop = true;
      }
    }
    // --- something standing in the way that does not move: after a while round it, as the traffic does (src/sim/pastblock.ts) ---
    if (traffic && obey && (me.lane || me.conn)) {
      traffic.passBy(me, dt, gap, held);
      const p = (this.past = me.past ?? null);
      if (p && p.phase !== 'wait') {
        limit = Math.min(limit, p.cap);
        // (the point steered at: as far off the middle of the lane as the car will be there)
        const o = offsetAt(p, la);
        tx += -Math.cos(v.yaw) * o;
        tz += Math.sin(v.yaw) * o;
        if (turn === 0) turn = p.phase === 'back' ? (p.off > 0 ? 1 : -1) : p.to > 0 ? -1 : 1;
      }
    } else this.past = null;
    // changing lanes is announced like a turn: indicator on, a look over the shoulder, then over
    this.changeT = change !== 0 ? this.changeT + dt : 0;
    let look = turn !== 0 && Math.min(distToLine, ahead) < 25 ? (turn < 0 ? 1.6 : -1.6) : 0;
    if (turn !== 0 && remark === '') remark = 'turn';
    if (traffic && change !== 0 && turn === 0) {
      turn = change;
      if (this.changeT < 1.6) look = change < 0 ? 1.6 : -1.6;
      if (remark === '') remark = 'lane';
    }
    // --- controls ---
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    const dx = tx - mpos[0];
    const dz = tz - mpos[2];
    const lat = dx * Math.cos(v.yaw) - dz * Math.sin(v.yaw); // + = target to the right
    const fwd = dx * fx + dz * fz;
    const curv = (2 * lat) / Math.max(dx * dx + dz * dz, 1);
    const steer = Math.max(-1, Math.min(1, (Math.atan(spec.wheelbase * curv) / spec.maxWheelAngle) * (fwd > 0 ? 1 : 3)));
    // keep the lateral acceleration comfortable
    const vCurve = Math.sqrt((TRUCK ? 1.5 : 2.2) / Math.max(Math.abs(curv), 0.002));
    // … and the bends further ahead are come up to at the speed they can be driven at (looked at a few times a second)
    if (this.bendTick++ % 6 === 0) this.bendLimit = lane || next ? this.bendCap(lane, lane ? laneS - FRONT : connS, next, route, speed) : Infinity;
    const vBend = this.bendLimit;
    let target = Math.min(limit * 0.94, vCurve, vBend);
    let brake = 0;
    if (mustStop && distToLine > -1) {
      const d = Math.max(0, distToLine - (TRUCK ? 1.8 : 1.2));
      target = Math.min(target, Math.sqrt(2 * DECEL * d));
      if (d < 0.6) {
        target = 0;
        brake = 0.5;
      }
    }
    if (crossStop) {
      target = 0;
      brake = 0.5;
    }
    if (v.speed < 0.15 && mustStop && distToLine < 4) this.stoppedFor += dt;
    else if (!mustStop && distToLine > 12) this.stoppedFor = 0;
    let throttle = 0;
    const err = target - v.speed;
    if (err > 0) throttle = Math.min(TRUCK ? 0.85 : 0.6, err * 0.35);
    else {
      // Braking for a line, for somebody in the way or at the destination is as firm as it takes;
      // easing off for a limit, a bend or a junction ahead stays gentle – whoever follows is not
      // made to brake hard, and a learner sees how early one lifts off.
      // (A bend that asks for less speed than the car has is braked for as firmly as it takes, too:
      // the way off a motorway does not wait.)
      const firm = mustStop || crossStop || halting || stopAhead || gap < 40 || vCurve < limit * 0.94 || vBend < v.speed - 3 || err < -4;
      const most = firm ? 0.8 : (TRUCK ? 1.6 : 2.1) / (TRUCK ? 6.5 : 9.5);
      brake = Math.max(brake, Math.min(most, -err * 0.3));
    }

    // Standing where the way is not free – a red light behind the next joint in the road, somebody
    // crossing: held on the brake.  (Left to itself, the car creeps on at walking pace, over the line.)
    if (target < 0.05 && v.speed < 1.2) brake = Math.max(brake, 0.4);

    const cmd = this.cmd;
    cmd.steer = steer;
    cmd.throttle = brake > 0 ? 0 : throttle;
    cmd.brake = brake;
    cmd.indicator = turn;
    cmd.look = look;
    cmd.remark = remark;
    cmd.waiting = mustStop || crossStop || (gap < 12 && target < 0.3);
    cmd.arrived = atHalt && Math.abs(v.speed) < 0.1;
    cmd.turnRound = turnRound && Math.abs(v.speed) < 0.1 ? turnRound : null;
    const seen = this.seen;
    seen.next = next;
    seen.tx = tx;
    seen.tz = tz;
    seen.limit = limit;
    seen.distToLine = distToLine;
    seen.mustStop = mustStop;
    seen.crossStop = crossStop;
    seen.turn = turn;
    seen.gap = gap;
    return cmd;
  }

  private haltS = 0;
}
