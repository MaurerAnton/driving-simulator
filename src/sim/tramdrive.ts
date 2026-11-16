// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Driving a tram: the player's tram runs on the tracks of the map (sim/rail.ts)
 * like the others, but by the player's hand –
 *
 *  - one controller for power and brake (the pedals: forwards = power,
 *    backwards = brake), the emergency brake with the magnetic track brake
 *    (the handbrake), the bell (the horn);
 *  - at a switch the way is asked for with the indicator (left, right, or
 *    none: straight on), as on real trams; the switch is set some metres
 *    before it and then stays;
 *  - at a stop the doors are opened (the door key), the passengers get off
 *    and on, the doors are closed, and only then the tram moves;
 *  - the power comes from the overhead wire: the pantograph is raised before
 *    the tram can pull (it takes a few seconds), and lowered – not while the
 *    motors draw current – before the wire ends, where a regional tram runs
 *    on its engine; a second unit coupled on pulls with it, a trailer car is
 *    only weight.
 *
 * What the instructor looks at (BOStrab, StVO where the track runs in the
 * street): the speed the curves and the road allow, stopping at every stop
 * at its mark, doors only open while standing at a stop – and closed only
 * when everybody is in –, red lights where the track crosses a junction.
 */
import type { SignalSystem } from './signals.ts';
import { SIG } from './signals.ts';
import { consistMass } from './rail.ts';
import type { RailTraffic, RailVehicle } from './rail.ts';
import { CTRL, RAIL } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { World } from '../world/world.ts';

/** a low-floor tram of 30 m: how it pulls and brakes */
export const TRAM = {
  /** full power: up to this, then what the motors' power gives (m/s², and m/s at which power takes over) */
  accel: 1.2,
  powerFrom: 12.5,
  vmax: 70 / 3.6,
  /** service brake at full lever, emergency brake with the track brake (m/s²) */
  brake: 1.6,
  emergency: 2.8,
  /** driving resistance: constant and with the square of the speed (m/s²) */
  roll: 0.02,
  air: 0.0005,
};

/** the front may stand this far before or past a stop's mark */
const STOP_BEFORE = 7;
const STOP_PAST = 4;

export type TramFault = 'speed' | 'tramCurve' | 'redLight' | 'tramStopMissed' | 'tramStopPlace' | 'tramDoorsMoving' | 'tramDoorsEarly' | 'tramPantoLoad' | 'tramPantoWireEnd';

/** how long the pantograph takes to rise to the wire, and to come down (s) */
export const PANTO_UP_TIME = 3;
export const PANTO_DOWN_TIME = 1.5;

export interface TramEvent {
  fault: TramFault;
  severity: 'hint' | 'minor' | 'major' | 'fail';
  data?: Record<string, number | string>;
}

const tmp = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };

export class TramDriver {
  readonly v: RailVehicle;
  readonly rail: RailTraffic;
  private readonly world: World;
  private readonly signals: SignalSystem;
  private readonly hit = newSurfaceHit();
  /** the controller: −1 full brake … 0 coasting … 1 full power */
  lever = 0;
  emergency = false;
  /** the way asked for at the next switch: 1 left, −1 right, 0 straight on (as the indicator) */
  wish = 0;
  doorsOpen = false;
  /** at a stop with the doors open: passengers still to get off and on, and the seconds until the next one is through */
  boarding = 0;
  alighting = 0;
  private nextPassenger = 0;
  /** what lies ahead (for the HUD and the instructor) */
  readonly ahead = {
    /** the next stop's mark (how far, on which piece, where on it) and the speed the curves allow from here (m, m/s) */
    stop: Infinity,
    stopPath: -1,
    stopMark: 0,
    curve: Infinity,
    /** the next switch, and which way the tram will take there (1 left, −1 right, 0 straight) */
    switchIn: Infinity,
    switchTurn: 0,
    /** a junction with lights the track crosses: how far, what the light for the tram shows */
    signalIn: Infinity,
    signal: -1,
    /** where the overhead wire ends ahead (m; Infinity: not within sight, or there is none here) */
    wireEndIn: Infinity,
  };
  /** the speed limit here (km/h): the road's where the track runs in the street, else 70 */
  limit = 70;
  /** stops served (stood at the mark with the doors open, everybody through) */
  served = 0;
  /** metres driven */
  odometer = 0;
  /** the stop (its piece and mark) the tram stands at, if it does */
  private atStop: { path: number; mark: number } | null = null;
  private servedHere = false;
  /** a stop the front has come within reach of: was it served? – and the stop last stood at with open doors */
  private pending: { path: number; mark: number; s: number } | null = null;
  private lastAt: { path: number; mark: number } | null = null;
  /** the pantograph: 0 down … 1 up against the wire, and which way the player has set it (up when a tram is taken over; the game begins a drive with it down) */
  panto = 1;
  pantoUp = true;
  /** whether the piece the front is on has a wire (to notice where it ends) */
  private wasWired = true;
  private overLimit = 0;
  private lastSignalNode = -1;
  private readonly random: () => number;

  constructor(rail: RailTraffic, v: RailVehicle, world: World, signals: SignalSystem, random: () => number = Math.random) {
    this.rail = rail;
    this.v = v;
    this.world = world;
    this.signals = signals;
    this.random = random;
    v.player = true;
  }

  get speed(): number {
    return this.v.speed;
  }

  /** a regional tram, with an engine for the lines without a wire */
  get hybrid(): boolean {
    return this.v.kind === RAIL.LIGHT;
  }

  /** whether there is a wire over the tram here */
  get wired(): boolean {
    return this.rail.wired(this.v.path);
  }

  /** whether the motors get power: from the wire with the pantograph up – or, on a regional tram where there is no wire, from its engine */
  get powered(): boolean {
    return this.wired ? this.panto >= 0.999 : this.hybrid;
  }

  /** Raise or lower the pantograph (its key); lowering it while the motors draw current is a fault (it draws an arc). */
  togglePanto(events: TramEvent[]): void {
    if (this.pantoUp && this.powered && this.wired && this.lever > 0.05 && this.v.speed > 0.5) events.push({ fault: 'tramPantoLoad', severity: 'minor' });
    this.pantoUp = !this.pantoUp;
  }

  /** passengers still getting off or on */
  get passengers(): number {
    return this.boarding + this.alighting;
  }

  /** Is the tram standing at a stop's mark (within the allowance)? */
  get standingAtStop(): boolean {
    return this.atStop !== null;
  }

  /** Standing at a stop that has not been served yet: time to open the doors. */
  get atUnservedStop(): boolean {
    if (this.v.speed > 0.1 || this.doorsOpen) return false;
    const here = this.findStop();
    return here !== null && !(this.lastAt && this.lastAt.path === here.path && this.lastAt.mark === here.mark);
  }

  /** Open or close the doors (the door key): only standing; closing while people still get on is a fault. */
  toggleDoors(events: TramEvent[]): void {
    if (this.v.speed > 0.1) return;
    if (!this.doorsOpen) {
      this.doorsOpen = true;
      const here = this.findStop();
      if (here) {
        this.atStop = here;
        this.lastAt = here;
        if (!this.servedHere) {
          // how many get off and on: a few, sometimes nobody
          this.alighting = Math.floor(this.random() * 6);
          this.boarding = Math.floor(this.random() * 7);
          this.nextPassenger = 1.5;
        }
      } else events.push({ fault: 'tramStopPlace', severity: 'minor' });
      return;
    }
    if (this.passengers > 0) events.push({ fault: 'tramDoorsEarly', severity: 'minor', data: { n: this.passengers } });
    this.doorsOpen = false;
    this.boarding = this.alighting = 0;
  }

  /** The stop whose mark the front stands at (within the allowance), or null. */
  private findStop(): { path: number; mark: number } | null {
    const p = this.rail.net.paths[this.v.path];
    for (const mark of p.stops) {
      // ahead of the front (+) or behind it (−), along the direction of travel
      const d = (mark - this.v.s) * this.v.dir;
      if (d <= STOP_BEFORE && d >= -STOP_PAST) return { path: this.v.path, mark };
    }
    return null;
  }

  /**
   * Driving by itself (a demonstration drive): the controller as a tram
   * driver works it – up to the speed the line allows here, the curves ahead
   * and what braking to the next stop or to a red light leaves – and at each
   * stop the doors: open once it stands at the mark, closed once everybody
   * is through.  Call it before step().
   */
  drive(events: TramEvent[]): void {
    const A = this.ahead;
    const v = this.v;
    this.emergency = false;
    // the pantograph: up under the wire, down before it ends (the regional tram goes on with its engine)
    if (this.wired && A.wireEndIn > 40 && !this.pantoUp) this.pantoUp = true;
    if (this.pantoUp && (A.wireEndIn < 40 || !this.wired) && this.hybrid) {
      if (this.lever > 0) this.lever = 0;
      this.pantoUp = false;
    }
    if (this.doorsOpen) {
      this.lever = -0.5;
      if (this.passengers === 0) this.toggleDoors(events);
      return;
    }
    if (this.atUnservedStop) {
      this.lever = -0.5;
      this.toggleDoors(events);
      return;
    }
    const b = TRAM.brake * 0.55;
    let target = Math.min(this.limit / 3.6 - 0.6, A.curve - 0.3);
    // the next stop (not the one just served): come to stand with the front at its mark
    const served = this.lastAt !== null && A.stopPath === this.lastAt.path && A.stopMark === this.lastAt.mark;
    if (A.stop < Infinity && !served) target = Math.min(target, Math.sqrt(2 * b * Math.max(0, A.stop - 0.8)));
    // a red light – or amber, if there is room to stop before it – where the track crosses a junction
    const canStop = v.speed * v.speed <= 2 * b * 0.6 * Math.max(A.signalIn - 2, 0.1);
    if (A.signalIn < 150 && (A.signal === SIG.RED || A.signal === SIG.RED_AMBER || (A.signal === SIG.AMBER && canStop))) {
      target = Math.min(target, Math.sqrt(2 * b * Math.max(0, A.signalIn - 2.5)));
    }
    // (no power yet – the pantograph still rising –: wait standing)
    if (!this.powered && v.speed < 0.3) target = 0;
    const err = target - v.speed;
    this.lever = Math.max(-1, Math.min(1, err * 0.8));
    if (target < 0.15 && v.speed < 0.3) this.lever = -0.5;
  }

  /** Which of the ways on from the end of the piece being run to take: the one asked for, else straight on. */
  private choose(path: number, dir: 1 | -1): { path: number; dir: 1 | -1 } | null {
    const net = this.rail.net;
    const ways = net.waysOn(path, dir, this.v.consist.tracks);
    if (ways.length === 0) return null;
    // without a wish: the way of its line (if it runs one), else straight on
    if (this.wish === 0) {
      const want = this.rail.lineNext(this.v, path, dir);
      return (want && ways.find((w) => w.path === want.path && w.dir === want.dir)) ?? ways[0];
    }
    if (ways.length === 1) return ways[0];
    // the direction of travel at the end, and of each way on: the angle (+ to the left)
    const p = net.paths[path];
    const n = p.cum.length;
    const e = dir > 0 ? n - 1 : 0;
    const f = dir > 0 ? n - 2 : 1;
    const hx = p.pts[e * 3] - p.pts[f * 3];
    const hz = p.pts[e * 3 + 2] - p.pts[f * 3 + 2];
    let best = ways[0];
    let bestTurn = 0;
    for (const w of ways) {
      const q = net.paths[w.path];
      const m = q.cum.length;
      const i0 = w.dir > 0 ? 0 : m - 1;
      const i1 = w.dir > 0 ? Math.min(m - 1, 3) : Math.max(0, m - 4);
      const dx = q.pts[i1 * 3] - q.pts[i0 * 3];
      const dz = q.pts[i1 * 3 + 2] - q.pts[i0 * 3 + 2];
      const turn = Math.atan2(-(hx * dz - hz * dx), hx * dx + hz * dz);
      if (turn * this.wish > bestTurn * this.wish) {
        best = w;
        bestTurn = turn;
      }
    }
    return best;
  }

  /**
   * One step: the controller moves the tram along its way; what happened
   * that the instructor has to say is added to `events`.
   */
  step(dt: number, events: TramEvent[]): void {
    const v = this.v;
    const net = this.rail.net;
    // --- the way on at the next switch: asked for until a few metres before it, then set
    const p = net.paths[v.path];
    const room = v.dir > 0 ? p.len - v.s : v.s;
    if (room > 8 || v.plan.length === 0) {
      const next = this.choose(v.path, v.dir);
      v.plan.length = 0;
      if (next) v.plan.push(next);
    }
    // --- the pantograph: rising or coming down; where the wire ends it must be down
    const want = this.pantoUp ? 1 : 0;
    if (this.panto !== want) this.panto = want > this.panto ? Math.min(1, this.panto + dt / PANTO_UP_TIME) : Math.max(0, this.panto - dt / PANTO_DOWN_TIME);
    v.panto = this.panto;
    const wired = this.wired;
    if (!wired && this.wasWired && this.panto > 0.5) {
      // (it would catch on the end of the wire: lowered at once, and the instructor says so)
      events.push({ fault: 'tramPantoWireEnd', severity: 'major' });
      this.pantoUp = false;
    }
    this.wasWired = wired;
    // --- forces (a second unit pulls as much as it weighs; a trailer car is only weight)
    const sp = v.speed;
    const { mass, driven } = consistMass(v.consist);
    let a = 0;
    if (this.emergency) a = -TRAM.emergency;
    else if (this.lever > 0.01 && this.powered) a = ((this.lever * driven) / mass) * Math.min(TRAM.accel, (TRAM.accel * TRAM.powerFrom) / Math.max(sp, 1));
    else if (this.lever < -0.01) a = this.lever * TRAM.brake;
    if (sp >= TRAM.vmax && a > 0) a = 0;
    // the doors are open: the tram is held (as by the door interlock)
    if (this.doorsOpen && a > 0) a = 0;
    // gradient: from the height of the track under the front and 10 m behind it
    net.sample(v.path, v.s, tmp);
    const yFront = tmp.y;
    const back = v.trail.at(Math.min(v.trail.count - 1, 20));
    const slope = (yFront - v.trail.y[back]) / 10;
    a -= 9.81 * Math.max(-0.1, Math.min(0.1, slope));
    a -= TRAM.roll + TRAM.air * sp * sp;
    let speed = sp + a * dt;
    if (speed < 0) speed = 0;
    if (sp === 0 && a <= 0) speed = 0;
    // moving with the doors open (they were opened while rolling, or it rolls away): a fault
    if (this.doorsOpen && speed > 0.3) events.push({ fault: 'tramDoorsMoving', severity: 'fail' });
    v.speed = speed;
    this.odometer += speed * dt;
    if (!this.rail.advance(v, speed * dt)) v.speed = 0;
    this.rail.place(v);

    // --- passengers at an open door
    if (this.doorsOpen && this.atStop && this.passengers > 0) {
      this.nextPassenger -= dt;
      if (this.nextPassenger <= 0) {
        if (this.alighting > 0) this.alighting--;
        else this.boarding--;
        this.nextPassenger = 1.1 + this.random() * 0.8;
        if (this.passengers === 0 && !this.servedHere) {
          this.servedHere = true;
          this.served++;
        }
      }
    }
    if (v.speed > 0.5 && this.atStop) {
      // off again: the stop is done with
      this.atStop = null;
      this.servedHere = false;
    }

    this.look(dt, events);
  }

  /** What lies ahead: stops, curves, switches, lights – and the rules about them. */
  private look(dt: number, events: TramEvent[]): void {
    const v = this.v;
    const net = this.rail.net;
    const A = this.ahead;
    A.stop = Infinity;
    A.curve = Infinity;
    A.switchIn = Infinity;
    A.signalIn = Infinity;
    A.signal = -1;
    A.wireEndIn = Infinity;
    const wiredHere = this.rail.wired(v.path);
    let cp = v.path;
    let cs = v.s;
    let cd = v.dir;
    let dist = 0;
    let planned = 0;
    let firstNode = -1;
    for (let guard = 0; guard < 200 && dist < 300; guard++) {
      const p = net.paths[cp];
      if (wiredHere && A.wireEndIn === Infinity && !this.rail.wired(cp)) A.wireEndIn = dist;
      net.sample(cp, cs, tmp);
      A.curve = Math.min(A.curve, Math.sqrt(tmp.cap * tmp.cap + 2 * TRAM.brake * 0.7 * dist));
      // a junction with lights the track runs through (within 80 m)
      if (dist < 80 && A.signalIn === Infinity && this.world.surfaceAt(tmp.x, tmp.z, tmp.y + 1, this.hit) && this.hit.node && this.hit.node.ctrl === CTRL.SIGNALS && this.hit.node.sc >= 0) {
        const node = this.hit.node;
        // the approach the tram comes in on: the arm pointing back the way it comes
        const hx = tmp.tx * cd;
        const hz = tmp.tz * cd;
        let best = -1;
        let bestDot = 0.3;
        for (let i = 0; i < node.arms.length; i++) {
          const arm = node.arms[i];
          const dot = -(arm.dx * hx + arm.dz * hz);
          if (dot > bestDot && arm.sg >= 0) {
            bestDot = dot;
            best = i;
          }
        }
        if (best >= 0) {
          A.signalIn = dist;
          A.signal = this.signals.get(node.sc, node.arms[best].sg);
          firstNode = node.id;
        }
      }
      const room = cd > 0 ? p.len - cs : cs;
      for (const st of p.stops) {
        const d = (st - cs) * cd;
        if (d > -STOP_PAST && d <= room + 0.01 && dist + d < A.stop) {
          A.stop = Math.max(-STOP_PAST, dist + d);
          A.stopPath = cp;
          A.stopMark = st;
        }
      }
      const step = 3;
      if (room > step) {
        cs += cd * step;
        dist += step;
        continue;
      }
      dist += room;
      const ways = net.waysOn(cp, cd, v.consist.tracks);
      const next = planned < v.plan.length ? v.plan[planned] : this.choose(cp, cd);
      if (ways.length > 1 && A.switchIn === Infinity) {
        A.switchIn = dist;
        A.switchTurn = next && next.path !== ways[0].path ? (this.wish !== 0 ? this.wish : 0) : 0;
      }
      if (!next) break;
      planned++;
      cp = next.path;
      cd = next.dir;
      cs = cd > 0 ? 0 : net.paths[cp].len;
    }

    // --- the speed limit here: the road's where the track runs in the street, else 70 km/h
    net.sample(v.path, v.s, tmp);
    let limit = 70;
    if (this.world.surfaceAt(tmp.x, tmp.z, tmp.y + 1, this.hit) && this.hit.edge && this.hit.zone === 0) {
      const e = this.hit.edge;
      const m = Math.max(e.maxF, e.maxB);
      if (m > 0) limit = Math.min(70, m);
    }
    this.limit = limit;
    const kmh = v.speed * 3.6;
    if (kmh > limit + 5) {
      this.overLimit += dt;
      if (this.overLimit > 2) {
        this.overLimit = -8;
        events.push({ fault: 'speed', severity: kmh > limit + 20 ? 'major' : 'minor', data: { limit, speed: Math.round(kmh) } });
      }
    } else if (this.overLimit > 0) this.overLimit = 0;
    else this.overLimit = Math.min(0, this.overLimit + dt);
    // too fast for the curve under the front: the tram could derail
    if (v.speed > tmp.cap + 2.5) events.push({ fault: 'tramCurve', severity: 'major', data: { speed: Math.round(kmh), limit: Math.round(tmp.cap * 3.6) } });

    // --- into a junction on red (the light was red for a moment already)
    if (A.signalIn < 1.5 && firstNode !== this.lastSignalNode) {
      this.lastSignalNode = firstNode;
      if ((A.signal === SIG.RED || A.signal === SIG.RED_AMBER) && v.speed > 0.5) events.push({ fault: 'redLight', severity: 'fail' });
    }
    if (A.signalIn > 40) this.lastSignalNode = -1;

    // --- a stop passed without stopping at it
    const here = this.findStop();
    const known = here && this.lastAt && here.path === this.lastAt.path && here.mark === this.lastAt.mark;
    if (here && !this.pending && !known) this.pending = { ...here, s: v.s };
    if (this.pending) {
      const pd = this.pending;
      const servedNow = this.atStop !== null && this.atStop.path === pd.path && this.atStop.mark === pd.mark;
      if (servedNow) this.pending = null;
      else if (v.path !== pd.path || (v.s - pd.mark) * v.dir > STOP_PAST + 4) {
        events.push({ fault: 'tramStopMissed', severity: 'major' });
        this.pending = null;
      }
    }
  }
}

/**
 * A place to start a tram: the stop mark nearest to (x, z) on a tram track,
 * with the direction the track is run in there (on a double track the
 * right-hand one).  Null when the map has no tram track.
 */
export function tramStart(rail: RailTraffic, x: number, z: number, kinds: readonly number[], name = ''): { path: number; s: number; dir: 1 | -1; x: number; z: number } | null {
  const net = rail.net;
  let best: { path: number; s: number; dir: 1 | -1; x: number; z: number } | null = null;
  let bd = Infinity;
  net.paths.forEach((p, i) => {
    if (!kinds.includes(p.kind)) return;
    p.stops.forEach((s, k) => {
      net.sample(i, s, tmp);
      // (a stop of the name asked for comes first: a platform of it may lie further away than another stop)
      const d = Math.hypot(tmp.x - x, tmp.z - z) + (name && p.stopNames[k] !== name ? 5000 : 0);
      if (d >= bd) return;
      bd = d;
      // the way the trams run there: as a line runs, else with the platform on the right (they keep to the right)
      const side = p.stopSides[k] ?? 0;
      const dir: 1 | -1 = p.way !== 0 ? p.way : rail.hasLine(i, 1) ? 1 : rail.hasLine(i, -1) ? -1 : side < 0 ? -1 : 1;
      best = { path: i, s, dir, x: tmp.x, z: tmp.z };
    });
  });
  return best;
}
