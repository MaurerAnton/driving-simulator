// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Driving through the narrowings kerb build-outs make (src/world/narrowing.ts).
 *
 * A build-out stands in the carriageway: whoever comes to it moves over into
 * the gap it leaves – no further than the car needs to clear its kerb with a
 * hand's breadth to spare – and back into the lane behind it.  Where the gap
 * lets only one vehicle through at a time (a narrow street without lane
 * markings), everybody slows down to about 20 km/h, and whoever has the
 * build-out on their side waits before it while somebody comes the other
 * way (§ 6 StVO).  A choker on both sides gives neither direction the right
 * of way: whoever is there first goes first.  Nobody drives in while
 * somebody coming the other way is in it.
 *
 * The traffic (src/sim/traffic.ts) and the autopilot (src/sim/autodriver.ts)
 * ask `gate` where to stop and how fast to go, and `shift` how far to move
 * across; the rule monitor (src/sim/rules.ts) asks `judge` about the player,
 * who drives in on the side of the build-out while somebody coming the other
 * way is in the gap.  The player's car runs into the beds' kerbs and beacons
 * (`narrowColliders`, for the scenery collider).
 */
import { clamp, newPolySample, projectOnPolyline, samplePolyline, smoothstep } from '../core/geom.ts';
import type { PolySample } from '../core/geom.ts';
import { BO } from '../world/narrowing.ts';
import type { Narrowing } from '../world/narrowing.ts';
import type { Lane, LaneGraph } from '../world/lanes.ts';
import type { Edge } from '../world/world.ts';
import type { PlayerSnapshot, RuleMonitor } from './rules.ts';
import type { PlayerState, TrafficCar } from './traffic.ts';

/** how fast through a single-lane narrowing (m/s: 20 km/h) */
export const NARROW_SPEED = 20 / 3.6;
/** over how many metres a vehicle moves across into the gap, and back */
export const NARROW_RAMP = 5;
/** how far before the bed the front of a vehicle that waits stands (m) – before it has moved across */
export const NARROW_WAIT = 6;
/** what a vehicle keeps from the kerb of the bed (m) */
const MARGIN = 0.25;
/** how comfortably a vehicle eases off for it (m/s²) */
const EASE = 1.5;

/** What `gate` asks of a vehicle: where to stop (m ahead of its front; Infinity: nowhere), how fast at most. */
export interface NarrowGate {
  stop: number;
  cap: number;
  why: '' | 'oncoming';
}

/** Somebody coming the other way through a narrowing: its front's distance to its wait line (negative: past it) and to the end. */
interface Other {
  wait: number;
  rear: number;
  exit: number;
  v: number;
  id: number;
}

/** What the module needs of the traffic. */
export interface NarrowRoad {
  readonly graph: LaneGraph;
  carsOn(lane: Lane): readonly TrafficCar[] | undefined;
}

/** Distance along a lane of an edge station. */
function along(lane: Lane, s: number): number {
  return (s - lane.s0) * lane.dir;
}

/** Where the bed begins and ends for traffic on `lane` (distances along it). */
function spanOn(lane: Lane, n: Narrowing): [number, number] {
  return lane.dir > 0 ? [along(lane, n.s0), along(lane, n.s1)] : [along(lane, n.s1), along(lane, n.s0)];
}

/** Is the build-out on the right of a vehicle going `dir` along its road (1), on its left (−1) – or on both sides, nobody first (0)? */
export function sideFor(n: Narrowing, dir: number): number {
  if (n.flags & BO.PAIRED) return 0;
  return n.side * dir < 0 ? 1 : -1;
}

/** How far across (m, + left of the middle of `lane`) a vehicle of half width `hw` keeps in the gap of `n`. */
export function gapShift(lane: Lane, n: Narrowing, hw: number): number {
  const lo = n.lo + hw + MARGIN;
  const hi = n.hi - hw - MARGIN;
  const t = lo <= hi ? clamp(lane.off, lo, hi) : (n.lo + n.hi) / 2;
  return (t - lane.off) * lane.dir;
}

export class Narrowings {
  readonly road: NarrowRoad;
  /** the player's vehicle (set each step by the traffic): the cars wait for it, too */
  player: PlayerState | null = null;
  private readonly g: NarrowGate = { stop: Infinity, cap: Infinity, why: '' };
  private readonly others: Other[] = [];
  private readonly proj = { s: 0, off: 0, d2: 0, seg: 0 };
  private prevFront: { edge: Edge; dir: number; s: number; t: number } | null = null;

  constructor(road: NarrowRoad) {
    this.road = road;
  }

  /**
   * How far a vehicle (half width `hw`, half length `hl`) whose middle is
   * `mid` metres along `lane` is drawn to the left of the middle of its lane
   * to pass a build-out (m; 0 elsewhere).
   */
  shift(lane: Lane, mid: number, hw = 0.95, hl = 2.3): number {
    const list = lane.edge.narrow;
    if (!list) return 0;
    let out = 0;
    for (const n of list) {
      const full = gapShift(lane, n, hw);
      if (Math.abs(full) < 0.01) continue;
      const [a, b] = spanOn(lane, n);
      const inA = a - hl - 0.5;
      const outB = b + hl + 0.3;
      if (mid <= inA - NARROW_RAMP || mid >= outB + NARROW_RAMP) continue;
      const w = mid < inA ? smoothstep(inA - NARROW_RAMP, inA, mid) : mid > outB ? 1 - smoothstep(outB, outB + NARROW_RAMP, mid) : 1;
      const s = full * w;
      if (Math.abs(s) > Math.abs(out)) out = s;
    }
    return out;
  }

  /** Moves a point `d` metres along `lane` (sampled into `p`, the direction of travel tx, tz) to where a vehicle passes the build-outs. */
  offset(lane: Lane, d: number, p: PolySample, hw = 0.95, hl = 2.3): void {
    const s = this.shift(lane, d, hw, hl);
    if (s === 0) return;
    p.x += p.tz * s;
    p.z -= p.tx * s;
  }

  /** Is a vehicle going `dir` at station `s` of `edge` moved across for a build-out there (no fault to be left of the middle)? */
  passing(edge: Edge, s: number, dir: number): boolean {
    const list = edge.narrow;
    if (!list) return false;
    for (const n of list) if (s > n.s0 - NARROW_RAMP - 4 && s < n.s1 + NARROW_RAMP + 4 && sideFor(n, dir) === 1) return true;
    return false;
  }

  /**
   * What the narrowings ask of a vehicle on `lane` whose front is `front`
   * metres along it, `length` long, going at `v` (`self`: a car of the
   * traffic, or null for the player's own): how fast, and where to wait for
   * the oncoming traffic.  (The answer is overwritten by the next call.)
   */
  gate(lane: Lane, front: number, v: number, length: number, self: TrafficCar | null): NarrowGate {
    const out = this.g;
    out.stop = Infinity;
    out.cap = Infinity;
    out.why = '';
    const list = lane.edge.narrow;
    if (!list) return out;
    for (const n of list) {
      if (!n.single) continue;
      const [a, b] = spanOn(lane, n);
      if (front - length > b + 0.5 || a - front > 150) continue;
      // slowly through it: down to 20 km/h by the line where one waits
      const wait = a - NARROW_WAIT;
      if (front < b) out.cap = Math.min(out.cap, Math.sqrt(NARROW_SPEED * NARROW_SPEED + 2 * EASE * Math.max(0, wait - front)));
      // once past the line it is in it: on through
      if (front > wait + 0.3) continue;
      const mine = sideFor(n, lane.dir);
      const myWait = wait - front;
      const myId = self ? self.id : -1;
      /** how long it would take to be through and out (s) */
      const myClear = (b + length - front) / NARROW_SPEED;
      /** how long until it is at its line (s) */
      const myLine = Math.max(0, myWait) / Math.max(v, 1);
      let hold = false;
      for (const o of this.oncoming(lane, n, self)) {
        if (o.rear >= o.exit) continue;
        // somebody coming the other way is in it (past its own line, not yet out): nobody drives in
        if (o.wait < -0.3) hold = true;
        else if (o.wait + NARROW_WAIT < 80 && (o.v > 1 || o.wait < 2)) {
          // the build-out on our side: whoever comes the other way and would be at the gap before we are through goes first (§ 6 StVO)
          if (mine === 1) hold = (o.wait + NARROW_WAIT) / Math.max(o.v, 1) < myClear + 1.5;
          else if (mine === 0) {
            // on both sides: whoever is there first
            const oLine = Math.max(0, o.wait) / Math.max(o.v, 1);
            hold = oLine < myLine - 0.3 || (Math.abs(oLine - myLine) <= 0.3 && o.id < myId);
          }
        }
        if (hold) break;
      }
      if (hold && myWait < out.stop) {
        out.stop = Math.max(0, myWait);
        out.why = 'oncoming';
      }
    }
    return out;
  }

  /** Those coming the other way through `n` (from the lane of `lane`'s road going the other way): the traffic, and the player's vehicle. */
  private oncoming(lane: Lane, n: Narrowing, self: TrafficCar | null): Other[] {
    const out = this.others;
    out.length = 0;
    const el = this.road.graph.edgeLanes[lane.edge.id];
    if (!el) return out;
    for (const l2 of lane.dir > 0 ? el.back : el.fwd) {
      const cars = this.road.carsOn(l2);
      if (!cars) continue;
      const [a, b] = spanOn(l2, n);
      for (const c of cars) {
        if (c === self) continue;
        const f = c.s + c.length / 2;
        out.push({
          wait: a - NARROW_WAIT - f,
          rear: f - c.length,
          exit: b,
          v: c.v,
          id: c.id,
        });
      }
    }
    const p = this.player;
    if (self && p && !p.onFoot) {
      const e = lane.edge;
      const mid = (n.s0 + n.s1) / 2;
      samplePolyline(e.pl, mid, tmp);
      if (Math.abs(p.x - tmp.x) < 80 && Math.abs(p.z - tmp.z) < 80 && Math.abs(p.y - tmp.y) < 4) {
        projectOnPolyline(e.pl, p.x, p.z, this.proj);
        if (Math.abs(this.proj.off) < e.width / 2 + 0.5) {
          // (which way it goes along the road)
          samplePolyline(e.pl, this.proj.s, tmp);
          const fwd = -Math.sin(p.yaw) * tmp.tx - Math.cos(p.yaw) * tmp.tz;
          const dir = p.speed >= 0 ? Math.sign(fwd) : -Math.sign(fwd);
          if (dir === -lane.dir) {
            // (its front along the way it goes, the entry and the end of the bed for it)
            const f = this.proj.s * dir + p.length / 2;
            const entry = dir > 0 ? n.s0 : -n.s1;
            const exit = dir > 0 ? n.s1 : -n.s0;
            out.push({
              wait: entry - NARROW_WAIT - f,
              rear: f - p.length,
              exit,
              v: Math.abs(p.speed),
              id: -1,
            });
          }
        }
      }
    }
    return out;
  }

  /**
   * The player's fault (called by the rule monitor with where the vehicle
   * is: its road, station and direction): into a narrowing on the side of
   * its build-out while somebody coming the other way is in it, or about to
   * be (§ 6 StVO).
   */
  judge(rules: RuleMonitor, p: PlayerSnapshot, edge: Edge, s: number, dir: number): void {
    const list = edge.narrow;
    if (!list) {
      this.prevFront = null;
      return;
    }
    const front = s + dir * (p.front ?? p.length / 2);
    const prev = this.prevFront;
    if (prev && prev.edge === edge && prev.dir === dir && rules.time - prev.t < 0.6 && p.speed > 0.3) {
      for (const n of list) {
        if (!n.single || sideFor(n, dir) !== 1) continue;
        const entry = dir > 0 ? n.s0 : n.s1;
        if (!((prev.s - entry) * dir < 0 && (front - entry) * dir >= 0)) continue;
        const lanes = this.road.graph.edgeLanes[edge.id];
        const l = lanes ? (dir > 0 ? lanes.fwd[0] : lanes.back[0]) : undefined;
        if (!l) continue;
        // somebody coming the other way past its line (in the gap, or moving into it)
        for (const o of this.oncoming(l, n, null)) {
          if (o.wait < 0 && o.rear < o.exit) {
            rules.noteAt('narrowYield', 'minor', p.x, p.z, {}, 10);
            break;
          }
        }
      }
    }
    this.prevFront = { edge, dir, s: front, t: rules.time };
  }
}

const tmp = newPolySample();

/**
 * The beds and beacons of the build-outs of these roads, for the scenery
 * collider: x1, z1, x2, z2, y per kerb segment (the side towards the lanes
 * and both ends), and x, y, z, radius per beacon post.
 */
export function narrowColliders(edges: Iterable<Edge>, segs: number[], discs: number[]): void {
  const p = newPolySample();
  for (const e of edges) {
    const list = e.narrow;
    if (!list) continue;
    const half = e.width / 2;
    for (const n of list) {
      const o0 = n.side * (half - n.depth);
      const o1 = n.side * half;
      const k = Math.max(1, Math.ceil((n.s1 - n.s0) / 3));
      let px = 0;
      let pz = 0;
      for (let i = 0; i <= k; i++) {
        samplePolyline(e.pl, n.s0 + ((n.s1 - n.s0) * i) / k, p);
        const x = p.x + p.tz * o0;
        const z = p.z - p.tx * o0;
        if (i > 0) segs.push(px, pz, x, z, p.y);
        if (i === 0 || i === k) segs.push(x, z, p.x + p.tz * o1, p.z - p.tx * o1, p.y);
        px = x;
        pz = z;
      }
      if (n.flags & BO.BEACON) {
        samplePolyline(e.pl, (n.s0 + n.s1) / 2, p);
        const o = n.side * (half - n.depth + 0.25);
        discs.push(p.x + p.tz * o, p.y, p.z - p.tx * o, 0.08);
      }
    }
  }
}

/** What `narrowCollide` needs of the scenery collider (src/sim/collision.ts). */
interface ColliderLike {
  add(src: { key: string; rings: null; ringCounts: null; segments: Float32Array | null; discs: number[] }): void;
  remove(key: string): void;
}

/** Puts the build-outs of these roads into the collider (`on`), or takes them out again – one source per road. */
export function narrowCollide(collider: ColliderLike, edges: Iterable<Edge>, on: boolean): void {
  for (const e of edges) {
    if (!e.narrow?.length) continue;
    const key = `narrow:${e.id}`;
    collider.remove(key);
    if (!on) continue;
    const segs: number[] = [];
    const discs: number[] = [];
    narrowColliders([e], segs, discs);
    collider.add({
      key,
      rings: null,
      ringCounts: null,
      segments: new Float32Array(segs),
      discs,
    });
  }
}
