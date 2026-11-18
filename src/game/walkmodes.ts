// SPDX-License-Identifier: AGPL-3.0-only
/**
 * How somebody on foot is moved – three ways to choose from in the settings
 * (Settings.walkControls):
 *
 *  - "classic": as in most games of the kind.  W S (or ↑ ↓) forwards and
 *    back, A D a step to the side, ← → turn; the mouse (held) or a finger
 *    dragged over the picture looks round – and the walker turns with the
 *    look.  On a touch screen a stick on the left moves (forwards, back,
 *    sideways) and the right half of the picture looks.  The default on a
 *    touch screen.
 *  - "tank": as before 1.7.0 – W S forwards and back, A D turn; on a touch
 *    screen the pedals and the steering bar.  The default with keys.
 *  - "tap": a tap (or a click) on the ground and the walker goes there by
 *    themselves – along the pavement, over the road at a crossing near the
 *    way if there is one, else straight across where the place lies.  The
 *    keys and the stick still work, and take over.
 *
 * Turning by keys or the steering bar is eased in and out (no jerk), and
 * running is a key held (Shift) or switched on and off (Caps Lock, or the
 * runner's button beside the stick).
 *
 * Kept free of three.js and the DOM: what is decided here is tested in
 * tests/game/walkmodes.test.ts; the game (game.ts) feeds it the input and
 * the roads round the walker.
 */
import { newPolySample, projectOnPolyline, samplePolyline } from '../core/geom.ts';
import type { PolyProjection, Polyline3 } from '../core/geom.ts';

export type WalkMode = 'classic' | 'tank' | 'tap';
export type WalkSetting = 'auto' | WalkMode;
export const WALK_SETTINGS: readonly WalkSetting[] = ['auto', 'classic', 'tank', 'tap'];

/** The way of walking in use: the setting – or, set to "auto", classic on a touch screen and as before with keys. */
export function walkModeOf(setting: WalkSetting, touch: boolean): WalkMode {
  return setting === 'auto' ? (touch ? 'classic' : 'tank') : setting;
}

/** What the input asks of the walker (see Input.walkInput): forwards (+) and back, a step to the right (+), turning (+ left), running. */
export interface WalkIntent {
  fwd: number;
  side: number;
  turn: number;
  run: boolean;
}

/** What the walker is told to do in one step (onfoot.ts WalkMove). */
export interface WalkStep {
  fwd: number;
  side: number;
  turn: number;
  run: boolean;
}

/** A road near the walker as the way on foot sees it: its middle line, half its paved width, where its crossings are (metres along it). */
export interface FootRoad {
  pl: Polyline3;
  /** from the middle to the kerb (m) */
  half: number;
  /** width of the pavement on the left / right of the line's direction (0: none) */
  swL: number;
  swR: number;
  /** marked crossings and lights (metres along the line) */
  xings: number[];
}

export interface FootPoint {
  x: number;
  z: number;
}

/** a marked crossing is taken when the way round it is at most this much longer (m) */
const DETOUR = 70;
/** points along a pavement every this many metres */
const STEP = 12;

/** The place `off` metres to the left (+) of the line at `s` metres along it. */
function besideLine(pl: Polyline3, s: number, off: number): FootPoint {
  const p = samplePolyline(pl, s, newPolySample());
  // (left of the direction (tx, tz) is (tz, −tx))
  return { x: p.x + p.tz * off, z: p.z - p.tx * off };
}

/** The middle of the pavement on one side (−1 right, 1 left) – or, without one, a metre beyond the kerb. */
function walkOff(r: FootRoad, side: number): number {
  const sw = side > 0 ? r.swL : r.swR;
  return side * (r.half + (sw > 0.5 ? Math.min(sw, 4) / 2 : 1));
}

/** Points along the pavement on `side` from s0 to s1 (s0 itself left out, s1 included). */
function along(r: FootRoad, s0: number, s1: number, side: number, out: FootPoint[]): void {
  const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / STEP));
  for (let i = 1; i <= n; i++) out.push(besideLine(r.pl, s0 + ((s1 - s0) * i) / n, walkOff(r, side)));
}

/**
 * The way from (fx, fz) to (tx, tz) on foot: a list of points to walk to,
 * the last one the place itself.  With a road between the two: along the
 * pavement to a crossing (or to where the place lies opposite), over the
 * road there, along the other pavement.  Along a road on the same side:
 * keeping to the pavement round its bends.  Else straight there.
 */
export function planFootPath(fx: number, fz: number, tx: number, tz: number, roads: readonly FootRoad[]): FootPoint[] {
  const pa: PolyProjection = { s: 0, off: 0, d2: 0, seg: 0 };
  const pb: PolyProjection = { s: 0, off: 0, d2: 0, seg: 0 };
  const direct = Math.hypot(tx - fx, tz - fz);
  // the road to be crossed: the one the straight way crosses, nearest to the start
  let cross: { r: FootRoad; s0: number; s1: number; side0: number; side1: number } | null = null;
  let crossCost = Infinity;
  // a road to go along on the same side
  let follow: { r: FootRoad; s0: number; s1: number; side: number } | null = null;
  let followCost = Infinity;
  for (const r of roads) {
    if (r.pl.len < 2) continue;
    projectOnPolyline(r.pl, fx, fz, pa);
    projectOnPolyline(r.pl, tx, tz, pb);
    // (beyond either end of the road: not this road's business)
    const inside = (p: PolyProjection): boolean => p.s > 0.5 && p.s < r.pl.len - 0.5;
    if (!inside(pa) && !inside(pb)) continue;
    const reach = r.half + 25;
    if (Math.abs(pa.off) > reach || Math.abs(pb.off) > reach) continue;
    const side0 = Math.sign(pa.off) || 1;
    const side1 = Math.sign(pb.off) || 1;
    // (standing on the road itself: just go – off it, the way one wants)
    const onRoad = Math.abs(pa.off) < r.half * 0.8;
    if (side0 !== side1 && !onRoad && Math.abs(pb.off) > r.half * 0.8) {
      if (Math.abs(pa.off) < crossCost) {
        crossCost = Math.abs(pa.off);
        cross = { r, s0: pa.s, s1: pb.s, side0, side1 };
      }
    } else if (side0 === side1 && !onRoad && Math.abs(pb.s - pa.s) > STEP && Math.abs(pa.off) < r.half + 8 && Math.abs(pb.off) < r.half + 15) {
      if (Math.abs(pa.off) < followCost) {
        followCost = Math.abs(pa.off);
        follow = { r, s0: pa.s, s1: pb.s, side: side0 };
      }
    }
  }
  const out: FootPoint[] = [];
  if (cross) {
    const { r, s0, s1, side0, side1 } = cross;
    // a crossing near the way (the detour over it not much longer), else straight over where the place lies
    let sx = Math.max(1, Math.min(r.pl.len - 1, s1));
    let best = Infinity;
    for (const c of r.xings) {
      const extra = Math.abs(c - s0) + Math.abs(s1 - c) - Math.abs(s1 - s0);
      if (extra <= DETOUR && extra < best) {
        best = extra;
        sx = c;
      }
    }
    if (Math.abs(sx - s0) > 2) along(r, s0, sx, side0, out);
    else out.push(besideLine(r.pl, sx, walkOff(r, side0)));
    out.push(besideLine(r.pl, sx, walkOff(r, side1)));
    if (Math.abs(s1 - sx) > STEP) along(r, sx, s1, side1, out);
  } else if (follow) {
    const { r, s0, s1, side } = follow;
    // (the last point beside the place: then to it)
    along(r, s0, s1, side, out);
  }
  // (no point that leads further away than the place itself, and none right on top of the next)
  const pts = out.filter((p) => Math.hypot(p.x - fx, p.z - fz) < direct + DETOUR + 30);
  pts.push({ x: tx, z: tz });
  const clean: FootPoint[] = [];
  for (const p of pts) {
    const last = clean[clean.length - 1] ?? { x: fx, z: fz };
    if (Math.hypot(p.x - last.x, p.z - last.z) > 0.8 || p === pts[pts.length - 1]) clean.push(p);
  }
  return clean;
}

/** the shortest way between two headings (radians, −π … π) */
function angleTo(from: number, to: number): number {
  let d = to - from;
  d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
  return d;
}

/**
 * The walking of one person: eases the turning, and walks a way chosen by
 * a tap.
 */
export class WalkControl {
  /** the way being walked by itself (tap to walk): the points still to reach */
  path: FootPoint[] = [];
  private turnNow = 0;
  /** seconds since the view was last turned by hand (the walker then turns along the way again) */
  private sinceLook = 9;
  /** how far the walker was from the next point a moment ago, and for how long it has not come nearer */
  private lastGap = Infinity;
  private stuckT = 0;
  /** the way could not be walked on: the game says so once */
  blocked = false;

  get walking(): boolean {
    return this.path.length > 0;
  }

  /** Go to these points (planFootPath) by oneself. */
  goTo(path: FootPoint[]): void {
    this.path = path.slice();
    this.lastGap = Infinity;
    this.stuckT = 0;
    this.blocked = false;
    this.sinceLook = 9;
  }

  cancel(): void {
    this.path.length = 0;
  }

  /**
   * One step: what the walker is to do, from what the input asks (`want`),
   * where the walker is and faces, and whether the view was turned by hand
   * (`looked`).  Keys or the stick take over from a way being walked.
   */
  step(dt: number, want: WalkIntent, at: { x: number; z: number; yaw: number }, looked: boolean): WalkStep {
    // (running: Shift held – or switched on by Caps Lock or the runner's button: Input.runToggle)
    const run = want.run;
    // turning by keys or the bar: eased in and out
    this.turnNow += (want.turn - this.turnNow) * (1 - Math.exp(-dt * (Math.abs(want.turn) > Math.abs(this.turnNow) ? 7 : 10)));
    if (Math.abs(this.turnNow) < 1e-3) this.turnNow = 0;
    const manual = Math.abs(want.fwd) > 0.05 || Math.abs(want.side) > 0.05;
    if (manual) this.cancel();
    if (looked) this.sinceLook = 0;
    else this.sinceLook += dt;
    if (!this.path.length) return { fwd: want.fwd, side: want.side, turn: this.turnNow, run };
    // by oneself, along the way: to the next point
    let p = this.path[0];
    let gap = Math.hypot(p.x - at.x, p.z - at.z);
    while (gap < (this.path.length > 1 ? 1.2 : 0.35)) {
      this.path.shift();
      this.lastGap = Infinity;
      this.stuckT = 0;
      if (!this.path.length) return { fwd: 0, side: 0, turn: this.turnNow, run };
      p = this.path[0];
      gap = Math.hypot(p.x - at.x, p.z - at.z);
    }
    // not coming any nearer (a wall, a fence): give up after a while
    if (gap < this.lastGap - 0.05) {
      this.lastGap = gap;
      this.stuckT = 0;
    } else {
      this.stuckT += dt;
      if (this.stuckT > 1.6) {
        this.cancel();
        this.blocked = true;
        return { fwd: 0, side: 0, turn: this.turnNow, run };
      }
    }
    // the way to go, in the walker's own frame: forwards (−sin, −cos), to the right (cos, −sin)
    const dx = (p.x - at.x) / gap;
    const dz = (p.z - at.z) / gap;
    const s = Math.sin(at.yaw);
    const c = Math.cos(at.yaw);
    let fwd = -dx * s - dz * c;
    let side = dx * c - dz * s;
    // slowing down for the last steps
    const k = this.path.length === 1 ? Math.min(1, gap / 0.8 + 0.25) : 1;
    fwd *= k;
    side *= k;
    // the walker turns towards the way (unless the view was just turned by hand) – no faster than a person turns
    let turn = this.turnNow;
    if (this.sinceLook > 1.2) {
      const head = Math.atan2(-dx, -dz);
      const d = angleTo(at.yaw, head);
      // (turn is in units of 1.9 rad/s: at most about 3 rad/s)
      turn = Math.max(-1.6, Math.min(1.6, d * 3));
    }
    return { fwd, side, turn, run };
  }
}
