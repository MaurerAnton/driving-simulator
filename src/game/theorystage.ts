// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The places where the theory lessons happen (game/theory.ts): a crossroads,
 * a roundabout, a stretch of straight road – laid out on a plane of their
 * own and drawn on the practice yard by render/theory.ts.
 *
 * Everything here is in the stage's own metres: x to the east of its middle,
 * z to the south (as on the map), and headings are counted like a vehicle's
 * yaw on the map (0 = facing north, positive = turned to the left).  The
 * learner – "you" – always comes from the south and drives north, so that a
 * scene reads like the drawing of a theory book; the yard turns the whole
 * stage so that this long way lies along its long side.
 *
 * A stage is plain data: the areas of asphalt, pavement and paint as
 * outlines, the kerbs, the signs, the traffic lights, and the ways the
 * vehicles and people take – paths with named places on them (where the
 * line is that one waits at, where the junction begins, …).  Nothing here
 * draws, so that the lessons can be checked without a browser.
 */

/** The longest piece of a path (m): short enough for a smooth heading along curves. */
const STEP = 0.5;

/** A way through the stage: points about half a metre apart, and places on it by name. */
export interface Path {
  /** x, z, x, z, … */
  readonly pts: readonly number[];
  /** the distance from the start to each point */
  readonly acc: readonly number[];
  readonly len: number;
  /** places along it (metres from its start): 'line' where a vehicle's nose stops to wait, 'in' / 'out' where it enters and leaves the junction, … */
  readonly marks: Readonly<Record<string, number>>;
}

/** A point of a path and the direction of travel there (a unit vector). */
export interface PathPoint {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

export function newPathPoint(): PathPoint {
  return { x: 0, z: 0, dx: 0, dz: -1 };
}

/** The point `s` metres along a path – before its start and past its end it goes on in a straight line. */
export function pathPoint(p: Path, s: number, out: PathPoint): PathPoint {
  const pts = p.pts;
  const n = p.acc.length;
  if (n < 2) {
    out.x = pts[0] ?? 0;
    out.z = pts[1] ?? 0;
    return out;
  }
  let a: number;
  if (s <= 0) a = 0;
  else if (s >= p.len) a = n - 2;
  else {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p.acc[mid] <= s) lo = mid;
      else hi = mid;
    }
    a = lo;
  }
  const b = a + 1;
  const seg = p.acc[b] - p.acc[a] || 1e-9;
  const ax = pts[a * 2];
  const az = pts[a * 2 + 1];
  out.dx = (pts[b * 2] - ax) / seg;
  out.dz = (pts[b * 2 + 1] - az) / seg;
  const u = s - p.acc[a];
  out.x = ax + out.dx * u;
  out.z = az + out.dz * u;
  return out;
}

/** The heading (yaw) of a direction of travel. */
export function yawOf(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** Drawing a path: straight lines, bends and arcs, one after the other. */
export class Trace {
  readonly pts: number[] = [];
  /** how long it is so far */
  len = 0;
  private readonly lens: number[] = [];

  private push(x: number, z: number): void {
    const n = this.pts.length;
    if (n > 0) {
      const d = Math.hypot(x - this.pts[n - 2], z - this.pts[n - 1]);
      if (d < 1e-6) return;
      this.len += d;
    }
    this.pts.push(x, z);
    this.lens.push(this.len);
  }

  /** a straight line from the last point (the first call only sets the start) */
  to(x: number, z: number): this {
    const n = this.pts.length;
    if (n === 0) {
      this.push(x, z);
      return this;
    }
    const x0 = this.pts[n - 2];
    const z0 = this.pts[n - 1];
    const k = Math.max(1, Math.ceil(Math.hypot(x - x0, z - z0) / STEP));
    for (let i = 1; i <= k; i++) this.push(x0 + ((x - x0) * i) / k, z0 + ((z - z0) * i) / k);
    return this;
  }

  /** a cubic curve from the last point, with two control points */
  curve(c1x: number, c1z: number, c2x: number, c2z: number, x: number, z: number): this {
    const n = this.pts.length;
    const x0 = this.pts[n - 2];
    const z0 = this.pts[n - 1];
    const at = (t: number): [number, number] => {
      const u = 1 - t;
      return [u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x, u * u * u * z0 + 3 * u * u * t * c1z + 3 * u * t * t * c2z + t * t * t * z];
    };
    // (its length, roughly, settles how many points it gets)
    let rough = 0;
    let [px, pz] = [x0, z0];
    for (let i = 1; i <= 32; i++) {
      const [qx, qz] = at(i / 32);
      rough += Math.hypot(qx - px, qz - pz);
      px = qx;
      pz = qz;
    }
    const k = Math.max(2, Math.ceil(rough / (STEP * 0.8)));
    for (let i = 1; i <= k; i++) {
      const [qx, qz] = at(i / k);
      this.push(qx, qz);
    }
    return this;
  }

  /** an arc round (cx, cz) of radius r from the angle a0 to a1 (angles as atan2(z, x)) */
  arc(cx: number, cz: number, r: number, a0: number, a1: number): this {
    const k = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / STEP));
    for (let i = 0; i <= k; i++) {
      const a = a0 + ((a1 - a0) * i) / k;
      this.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
    }
    return this;
  }

  /**
   * On from the last point, heading (hx, hz), to (x, z) arriving heading
   * (ex, ez): straight when the two are in line, else a bend close to an arc.
   */
  join(hx: number, hz: number, x: number, z: number, ex: number, ez: number): this {
    const n = this.pts.length;
    const x0 = this.pts[n - 2];
    const z0 = this.pts[n - 1];
    const dx = x - x0;
    const dz = z - z0;
    const cross = hx * ez - hz * ex;
    const d = Math.hypot(dx, dz);
    if (Math.abs(cross) < 1e-3) {
      // in line – or side by side (a change of lane): an S
      if (Math.abs(dx * hz - dz * hx) < 0.05) return this.to(x, z);
      return this.curve(x0 + (hx * d) / 2.6, z0 + (hz * d) / 2.6, x - (ex * d) / 2.6, z - (ez * d) / 2.6, x, z);
    }
    // where the two lines meet: (x0, z0) + a·h = (x, z) − b·e
    const a = (dx * ez - ex * dz) / cross;
    const b = (hx * dz - dx * hz) / cross;
    if (a <= 0 || b <= 0) return this.curve(x0 + (hx * d) / 3, z0 + (hz * d) / 3, x - (ex * d) / 3, z - (ez * d) / 3, x, z);
    // (0.5523: the control points of a quarter circle drawn as a cubic curve)
    const k = 0.5523;
    return this.curve(x0 + hx * a * k, z0 + hz * a * k, x - ex * b * k, z - ez * b * k, x, z);
  }

  path(marks: Record<string, number> = {}): Path {
    return { pts: this.pts.slice(), acc: this.lens.slice(), len: this.len, marks: { end: this.len, ...marks } };
  }
}

/** A path through the given points (x, z, x, z, …), straight from one to the next. */
export function polyPath(points: readonly number[], marks: Record<string, number> = {}): Path {
  const t = new Trace();
  for (let i = 0; i < points.length; i += 2) t.to(points[i], points[i + 1]);
  return t.path(marks);
}

// ------------------------------------------------------------------ what is drawn
/** asphalt, pavement, the raised middle of a roundabout, its paved apron, paint, a red cycle crossing, steel of rails */
export type SurfaceKind = 'asphalt' | 'walk' | 'island' | 'apron' | 'paint' | 'red' | 'steel';

/** An area: its outline (x, z, …) and holes in it. */
export interface Surface {
  kind: SurfaceKind;
  ring: number[];
  holes?: number[][];
}

/** How high each kind of surface lies above the ground of the map (m). */
export const LIFT: Record<SurfaceKind, number> = {
  asphalt: 0.05,
  walk: 0.17,
  island: 0.19,
  apron: 0.09,
  paint: 0.065,
  red: 0.058,
  steel: 0.068,
};

/** A sign post: where it stands, which way its plates face (yaw), its plates from the top down. */
export interface SignPlace {
  x: number;
  z: number;
  yaw: number;
  codes: string[];
}

/** A traffic light: for vehicles (red, amber, green – with the green-arrow sign beside it) or for people on foot (red, green). */
export interface LightPlace {
  id: string;
  x: number;
  z: number;
  yaw: number;
  ped?: boolean;
  /** the sign with the green arrow (Zeichen 720) beside the red lamp */
  arrow?: boolean;
}

export interface Stage {
  surfaces: Surface[];
  /** kerbs: lines (x, z, …) along which the ground steps up from one surface to another */
  kerbs: Array<{ line: number[]; lo: SurfaceKind; hi: SurfaceKind }>;
  /** crash barriers (lines) */
  guards: number[][];
  signs: SignPlace[];
  lights: LightPlace[];
  paths: Record<string, Path>;
  /** a box round everything (min x, min z, max x, max z) */
  bounds: [number, number, number, number];
  /** things beside and on the road (render/theoryprops.ts): trees, posts, a warning triangle, barriers, a tunnel */
  props?: PropPlace[];
}

/**
 * A thing of a place: a tree, a guide post (Leitpfosten), a warning
 * triangle, a barrier across a lane, a traffic cone, a heap of earth – at
 * (x, z), turned by `yaw`, `size` times its usual size – or a tunnel over
 * the road from (x, z) to (x1, z1): its walls at those x, its ends at those
 * z, its roof `h` high.  `from` / `to`: only between these times of the script.
 */
export interface PropPlace {
  kind: 'tree' | 'post' | 'triangle' | 'barrier' | 'cone' | 'heap' | 'tunnel';
  x: number;
  z: number;
  yaw?: number;
  size?: number;
  x1?: number;
  z1?: number;
  h?: number;
  from?: number;
  to?: number;
}

export function emptyStage(): Stage {
  return { surfaces: [], kerbs: [], guards: [], signs: [], lights: [], paths: {}, bounds: [0, 0, 0, 0] };
}

/** The box round everything of a stage. */
export function finish(st: Stage): Stage {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const s of st.surfaces) {
    for (let i = 0; i < s.ring.length; i += 2) {
      minX = Math.min(minX, s.ring[i]);
      maxX = Math.max(maxX, s.ring[i]);
      minZ = Math.min(minZ, s.ring[i + 1]);
      maxZ = Math.max(maxZ, s.ring[i + 1]);
    }
  }
  st.bounds = [minX, minZ, maxX, maxZ];
  return st;
}

/** Is the point inside the outline (x, z, …)? */
export function inRing(ring: readonly number[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i];
    const zi = ring[i + 1];
    const xj = ring[j];
    const zj = ring[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Does this surface cover the point (inside its outline, not in a hole)? */
export function covers(s: Surface, x: number, z: number): boolean {
  if (!inRing(s.ring, x, z)) return false;
  return !(s.holes ?? []).some((h) => inRing(h, x, z));
}

/** How high the ground of the stage is at a point, above the map's (the highest surface there: a pavement, else the road). */
export function liftAt(st: Stage, x: number, z: number): number {
  let best = 0;
  for (const s of st.surfaces) {
    if (s.kind === 'paint' || s.kind === 'red' || s.kind === 'steel') continue;
    if (LIFT[s.kind] > best && covers(s, x, z)) best = LIFT[s.kind];
  }
  return best;
}

// ---------------------------------------------------------------------- paint
/** A painted bar from (x0, z0) to (x1, z1), `w` wide. */
export function bar(x0: number, z0: number, x1: number, z1: number, w: number, kind: SurfaceKind = 'paint'): Surface {
  const l = Math.hypot(x1 - x0, z1 - z0) || 1;
  const nx = (-(z1 - z0) / l) * (w / 2);
  const nz = ((x1 - x0) / l) * (w / 2);
  return { kind, ring: [x0 + nx, z0 + nz, x1 + nx, z1 + nz, x1 - nx, z1 - nz, x0 - nx, z0 - nz] };
}

/** A dashed line: dashes of `dash` metres with gaps of `gap` from (x0, z0) to (x1, z1). */
export function dashes(x0: number, z0: number, x1: number, z1: number, w: number, dash: number, gap: number): Surface[] {
  const l = Math.hypot(x1 - x0, z1 - z0);
  const out: Surface[] = [];
  if (l < 0.01) return out;
  const ux = (x1 - x0) / l;
  const uz = (z1 - z0) / l;
  for (let s = 0; s < l - 0.05; s += dash + gap) {
    const e = Math.min(l, s + dash);
    out.push(bar(x0 + ux * s, z0 + uz * s, x0 + ux * e, z0 + uz * e, w));
  }
  return out;
}

/**
 * An arrow painted in a lane (Zeichen 297), its tip at (x, z), pointing
 * along the heading `yaw`: straight on, or bending to the left or right.
 */
export function laneArrow(x: number, z: number, yaw: number, kind: 'straight' | 'left' | 'right'): Surface {
  // drawn pointing north (−z) with the tip at the origin, then turned
  const shape =
    kind === 'straight'
      ? [0, 0, 0.45, 1.4, 0.12, 1.4, 0.12, 5, -0.12, 5, -0.12, 1.4, -0.45, 1.4]
      : [-1.2, 1.2, -0.25, 0.55, -0.25, 1.0, 0.12, 1.4, 0.12, 5, -0.12, 5, -0.12, 1.6, -0.25, 1.45, -0.25, 1.85];
  const flip = kind === 'right' ? -1 : 1;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const ring: number[] = [];
  for (let i = 0; i < shape.length; i += 2) {
    const px = shape[i] * flip;
    const pz = shape[i + 1];
    // turned by yaw: north (0, −1) goes to (−sin yaw, −cos yaw)
    ring.push(x + px * c + pz * s, z - px * s + pz * c);
  }
  if (flip < 0) {
    // (mirrored: the outline runs the other way round – reverse it so that it stays a simple outline)
    const r: number[] = [];
    for (let i = ring.length - 2; i >= 0; i -= 2) r.push(ring[i], ring[i + 1]);
    return { kind: 'paint', ring: r };
  }
  return { kind: 'paint', ring };
}

// ------------------------------------------------------------- a crossroads
export type Dir = 'N' | 'E' | 'S' | 'W';
/** the direction of each arm, away from the middle */
const OUT: Record<Dir, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const DIRS: readonly Dir[] = ['N', 'E', 'S', 'W'];
/**
 * The arms in the order the outline of a crossroads runs round them: from
 * the right-hand side of the traffic coming in on one arm (the west side of
 * the north arm) to the arm on that side (the west arm), and so on.
 */
const AROUND: readonly Dir[] = ['N', 'W', 'S', 'E'];

/** One road through a crossroads: its lanes, what is in its middle, beside it. */
export interface Road {
  /** lanes in each direction */
  lanes: number;
  laneW: number;
  /** a strip in the middle (for tram tracks), its width */
  median?: number;
  /** a cycle lane on the right of each direction, its width */
  bike?: number;
  /** the pavement beside it (0: none) */
  walk: number;
  centre?: 'dash' | 'solid' | 'none';
  /** tram tracks in the middle strip, one each way */
  tracks?: boolean;
}

/** What one arm of a crossroads has. */
export interface ArmOpts {
  /** from the middle of the crossroads to its end (m) */
  len: number;
  /** a stop line or a give-way line where its traffic waits */
  line?: 'stop' | 'give';
  /** a crossing for people: its middle this far from the edge of the junction, its width, zebra or a crossing with lights */
  xing?: { at: number; w: number; kind: 'zebra' | 'furt' };
  /** signs on the right of the traffic coming in, this far from the middle */
  signs?: Array<{ at: number; codes: string[] }>;
  /** a traffic light for the traffic coming in (with the green-arrow sign) */
  light?: { id: string; arrow?: boolean };
  /** lights for the people on its crossing */
  pedLight?: string;
}

export interface CrossOpts {
  /** the road from north to south, and the one from east to west */
  ns: Road;
  ew: Road;
  /** the radius of the kerbs at the corners */
  r: number;
  arms: Record<Dir, ArmOpts>;
}

/** A crossroads with what was asked of it, and the ways through it. */
export interface Cross {
  stage: Stage;
  /**
   * The way from one arm to another (a car's lane, the cycle lane, the tram
   * track), with its marks: 'line' (where the nose waits), 'in' and 'out'
   * (where the bend through the junction begins and ends), 'xing' (where the
   * nose waits for people crossing the arm it goes into), 'end'.
   */
  move(from: Dir, to: Dir, lane?: 'car' | 'bike' | 'tram'): Path;
  /** half the width of the road on that arm (to the kerb) */
  half(d: Dir): number;
  /** the middle of the crossing of an arm, from the middle of the crossroads */
  xingAt(d: Dir): number;
  /** the place of a point on an arm: `along` from the middle, `side` to the right of the traffic coming in */
  at(d: Dir, along: number, side: number): [number, number];
}

function halfOf(r: Road): number {
  return (r.median ?? 0) / 2 + r.lanes * r.laneW + (r.bike ?? 0);
}

/** The heading's right-hand side: (−hz, hx). */
function rightOf(hx: number, hz: number): [number, number] {
  return [-hz, hx];
}

export function crossroads(o: CrossOpts): Cross {
  const st = emptyStage();
  const road = (d: Dir): Road => (d === 'N' || d === 'S' ? o.ns : o.ew);
  const half = (d: Dir): number => halfOf(road(d));
  /** where the box of the junction begins on an arm: half the width of the other road */
  const edge = (d: Dir): number => (d === 'N' || d === 'S' ? halfOf(o.ew) : halfOf(o.ns));
  /** a point on an arm: `along` from the middle, `side` to the right of the traffic coming in */
  const at = (d: Dir, along: number, side: number): [number, number] => {
    const [ox, oz] = OUT[d];
    const [rx, rz] = rightOf(-ox, -oz);
    return [ox * along + rx * side, oz * along + rz * side];
  };
  const xingAt = (d: Dir): number => {
    const x = o.arms[d].xing;
    return x ? edge(d) + x.at : 0;
  };
  /** where the stop or give-way line lies on an arm (from the middle) */
  const lineAt = (d: Dir): number => {
    const a = o.arms[d];
    const x = a.xing;
    if (a.line === 'stop') return x ? edge(d) + x.at + x.w / 2 + 1.2 : edge(d) + 2.6;
    return x && x.at < 1 ? edge(d) + x.at + x.w / 2 + 0.6 : edge(d) + 0.45;
  };
  const R = o.r;

  // ---- the asphalt: one outline round the four arms and the corners between them
  const ring: number[] = [];
  for (let i = 0; i < 4; i++) {
    const d = AROUND[i];
    const next = AROUND[(i + 1) % 4];
    const [ox, oz] = OUT[d];
    const hw = half(d);
    const nhw = half(next);
    const len = o.arms[d].len;
    // across the end of this arm: from the left of the traffic coming in to its right …
    const [lx, lz] = at(d, len, -hw);
    const [rx, rz] = at(d, len, hw);
    ring.push(lx, lz, rx, rz);
    // … back along that side to the corner, round the kerb's arc, out along the next arm
    const cornerA = at(d, edge(d) + R, hw);
    const cornerB = at(next, edge(next) + R, -nhw);
    // the corner where the two kerbs would meet, and the middle of the arc round it
    const [cx, cz] = at(d, edge(d), hw);
    const [nx, nz] = OUT[next];
    const mx = cx + ox * R + nx * R;
    const mz = cz + oz * R + nz * R;
    const a0 = Math.atan2(cornerA[1] - mz, cornerA[0] - mx);
    let a1 = Math.atan2(cornerB[1] - mz, cornerB[0] - mx);
    // (the short way round)
    while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    while (a0 - a1 > Math.PI) a1 += 2 * Math.PI;
    const arcOf = (r: number): number[] => {
      const out: number[] = [];
      for (let k = 1; k < 8; k++) {
        const a = a0 + ((a1 - a0) * k) / 8;
        out.push(mx + Math.cos(a) * r, mz + Math.sin(a) * r);
      }
      return out;
    };
    const arc = arcOf(R);
    ring.push(cornerA[0], cornerA[1], ...arc, cornerB[0], cornerB[1]);
    // the pavement of this corner: from the end of this arm round to the end of the next, as wide as `walk`
    const w = Math.min(road(d).walk, road(next).walk);
    if (w <= 0) continue;
    const nEnd = at(next, o.arms[next].len, -nhw);
    const kerb = [rx, rz, cornerA[0], cornerA[1], ...arc, cornerB[0], cornerB[1], nEnd[0], nEnd[1]];
    st.kerbs.push({ line: kerb, lo: 'asphalt', hi: 'walk' });
    const out: number[] = [...at(d, len, hw + w)];
    if (R - w > 0.3) out.push(...at(d, edge(d) + R, hw + w), ...arcOf(R - w), ...at(next, edge(next) + R, -nhw - w));
    // (a pavement wider than the kerb's radius: a sharp corner behind it)
    else out.push(...at(d, edge(d) + w, hw + w));
    out.push(...at(next, o.arms[next].len, -nhw - w));
    const walkRing = [...kerb];
    for (let k = out.length - 2; k >= 0; k -= 2) walkRing.push(out[k], out[k + 1]);
    st.surfaces.push({ kind: 'walk', ring: walkRing });
  }
  st.surfaces.unshift({ kind: 'asphalt', ring });

  // ---- the markings of each arm
  for (const d of DIRS) {
    const a = o.arms[d];
    const r = road(d);
    const hw = half(d);
    const e = edge(d);
    const line = lineAt(d);
    const med = (r.median ?? 0) / 2;
    const end = a.len;
    // the middle line: up to the line where traffic waits (or to the junction)
    const stopAt = a.line ? line : e;
    if (med === 0 && r.centre && r.centre !== 'none') {
      const [x0, z0] = at(d, end, 0);
      const [x1, z1] = at(d, stopAt + (a.line === 'stop' ? 0.25 : 0.4), 0);
      if (r.centre === 'solid') st.surfaces.push(bar(x0, z0, x1, z1, 0.12));
      else st.surfaces.push(...dashes(x1, z1, x0, z0, 0.12, 3, 6));
      // (a solid stretch just before the junction)
      if (r.centre === 'dash' && a.line === 'stop') {
        const [x2, z2] = at(d, stopAt + 12, 0);
        st.surfaces.push(bar(x1, z1, x2, z2, 0.12));
      }
    }
    // lines between the lanes of one direction, and of the cycle lane
    for (const side of [1, -1]) {
      for (let j = 1; j < r.lanes; j++) {
        const [x0, z0] = at(d, end, side * (med + j * r.laneW));
        const [x1, z1] = at(d, (side > 0 ? stopAt : e) + 0.3, side * (med + j * r.laneW));
        st.surfaces.push(...dashes(x1, z1, x0, z0, 0.12, 3, 6));
      }
      if (r.bike) {
        const off = side * (med + r.lanes * r.laneW);
        const [x0, z0] = at(d, end, off);
        const [x1, z1] = at(d, e + (side > 0 && a.line ? line - e : 0) + 0.3, off);
        st.surfaces.push(bar(x0, z0, x1, z1, 0.25));
      }
    }
    // where the traffic waits: a stop line (Zeichen 294) or a give-way line (Zeichen 341), across the lanes coming in
    if (a.line) {
      const [x0, z0] = at(d, line, med);
      const [x1, z1] = at(d, line, hw);
      if (a.line === 'stop') st.surfaces.push(bar(x0, z0, x1, z1, 0.5));
      else st.surfaces.push(...dashes(x0, z0, x1, z1, 0.5, 0.5, 0.25));
    }
    // a crossing for people: a zebra (Zeichen 293) or the dashed edges of a crossing with lights
    if (a.xing) {
      const mid = e + a.xing.at;
      const w = a.xing.w;
      if (a.xing.kind === 'zebra') {
        for (let s = -hw + 0.25; s < hw - 0.2; s += 1.0) {
          const [x0, z0] = at(d, mid - w / 2, s + 0.25);
          const [x1, z1] = at(d, mid + w / 2, s + 0.25);
          st.surfaces.push(bar(x0, z0, x1, z1, 0.5));
        }
      } else {
        for (const k of [-1, 1]) {
          const [x0, z0] = at(d, mid + (k * w) / 2, -hw);
          const [x1, z1] = at(d, mid + (k * w) / 2, hw);
          st.surfaces.push(...dashes(x0, z0, x1, z1, 0.4, 0.5, 0.5));
        }
      }
      if (a.pedLight) {
        for (const k of [-1, 1]) {
          const [x, z] = at(d, mid + 0.4 + w / 2, k * (hw + 0.6));
          // (facing across the road: the people waiting on the other side see it)
          const [ox, oz] = OUT[d];
          const [rx, rz] = rightOf(-ox, -oz);
          st.lights.push({ id: a.pedLight, x, z, yaw: yawOf(-rx * k, -rz * k), ped: true });
        }
      }
    }
    // tram tracks in the middle: a pair of rails each way (1.435 m apart), on to the far side of the junction
    // (drawn once for the whole road, from the end of the south or east arm to the end of the opposite one)
    if (r.tracks && (d === 'S' || d === 'E')) {
      const opp: Dir = d === 'S' ? 'N' : 'W';
      for (const side of [-1, 1]) {
        const c = side * (med / 2);
        for (const g of [-0.7175, 0.7175]) {
          const [x0, z0] = at(d, end, c + g);
          const [x1, z1] = at(opp, o.arms[opp].len, -(c + g));
          st.surfaces.push(bar(x0, z0, x1, z1, 0.09, 'steel'));
        }
      }
    }
    // signs on the right of the traffic coming in, on the pavement
    for (const sg of a.signs ?? []) {
      const [x, z] = at(d, sg.at, hw + 0.7);
      const [ox, oz] = OUT[d];
      st.signs.push({ x, z, yaw: yawOf(ox, oz), codes: sg.codes });
    }
    if (a.light) {
      const [x, z] = at(d, Math.max(e + 0.6, line - 2.4), hw + 0.6);
      const [ox, oz] = OUT[d];
      st.lights.push({ id: a.light.id, x, z, yaw: yawOf(ox, oz), arrow: a.light.arrow });
    }
  }
  // the cycle lanes across the mouths of the side roads: red, with dashed edges (a cyclist's crossing)
  for (const d of DIRS) {
    const r = road(d);
    if (!r.bike || (d !== 'N' && d !== 'S')) continue;
    const med = (r.median ?? 0) / 2;
    const inner = med + r.lanes * r.laneW;
    for (const side of [1, -1]) {
      const [x0, z0] = at(d, edge(d), side * inner);
      const [x1, z1] = at(d, edge(d), side * (inner + r.bike));
      const opp: Dir = d === 'S' ? 'N' : 'S';
      const [x2, z2] = at(opp, edge(opp), -side * (inner + r.bike));
      const [x3, z3] = at(opp, edge(opp), -side * inner);
      if (d === 'S') {
        st.surfaces.push({ kind: 'red', ring: [x0, z0, x1, z1, x2, z2, x3, z3] });
        st.surfaces.push(...dashes(x0, z0, x3, z3, 0.25, 0.5, 0.5), ...dashes(x1, z1, x2, z2, 0.25, 0.5, 0.5));
      }
    }
  }

  const move = (from: Dir, to: Dir, lane: 'car' | 'bike' | 'tram' = 'car'): Path => {
    const rin = road(from);
    const rout = road(to);
    const [fx, fz] = OUT[from];
    const [tx, tz] = OUT[to];
    // the lane: the right-most lane of each direction, the cycle lane, the track in the middle
    const offOf = (r: Road): number => (lane === 'bike' ? (r.median ?? 0) / 2 + r.lanes * r.laneW + (r.bike ?? 0) / 2 : lane === 'tram' ? (r.median ?? 0) / 4 : (r.median ?? 0) / 2 + (r.lanes - 0.5) * r.laneW);
    const offIn = offOf(rin);
    const offOut = offOf(rout);
    // turning: right (the next arm clockwise), straight on, left
    const turn = (DIRS.indexOf(to) - DIRS.indexOf(from) + 4) % 4;
    const t = new Trace();
    const [sx, sz] = at(from, o.arms[from].len, offIn);
    const [ex, ez] = at(to, o.arms[to].len, -offOut);
    const marks: Record<string, number> = {};
    t.to(sx, sz);
    if (turn === 2) {
      // straight on: through the box of the junction
      const [ix, iz] = at(from, edge(from), offIn);
      t.to(ix, iz);
      marks.in = t.len;
      const [ox, oz] = at(to, edge(to), -offOut);
      t.to(ox, oz);
      marks.out = t.len;
    } else {
      // a turn: an arc of a circle that touches both lanes – where the lane in and the lane out would meet,
      // `r` back along the one and `r` on along the other (6.5 m turning left, 5.5 m turning right)
      const r = turn === 3 ? 5.5 : 6.5;
      const [ax, az] = at(from, 0, offIn);
      const [bx, bz] = at(to, 0, -offOut);
      // the meeting point: on the lane in (a + λ·(−f)) and on the lane out (b + μ·t), the two at right angles
      const lambda = (bx - ax) * -fx + (bz - az) * -fz;
      const mx = ax - fx * lambda;
      const mz = az - fz * lambda;
      const [ix, iz] = [mx + fx * r, mz + fz * r];
      const [ox, oz] = [mx + tx * r, mz + tz * r];
      t.to(ix, iz);
      marks.in = t.len;
      t.curve(ix - fx * r * 0.5523, iz - fz * r * 0.5523, ox - tx * r * 0.5523, oz - tz * r * 0.5523, ox, oz);
      marks.out = t.len;
    }
    t.to(ex, ez);
    const path = t.path(marks);
    // where the nose waits: before the line – or, where there is none, at the edge of the junction
    const a = o.arms[from];
    const waitAt = a.line ? lineAt(from) + 0.25 + 0.3 : edge(from) + 0.6;
    // … and before the crossing of the arm it goes into, for the people on it
    const x = o.arms[to].xing;
    const xingNear = x ? edge(to) + x.at - x.w / 2 - 0.6 : 0;
    // (found along the way itself: the first of its points that far on – it may lie on the bend)
    const pts = path.pts;
    for (let i = 0; i < path.acc.length; i++) {
      const px = pts[i * 2];
      const pz = pts[i * 2 + 1];
      if (marks.line === undefined && px * fx + pz * fz <= waitAt) marks.line = path.acc[i];
      if (x && marks.xing === undefined && path.acc[i] > (marks.in ?? 0) && px * tx + pz * tz >= xingNear) marks.xing = path.acc[i];
    }
    marks.line ??= 0;
    return { ...path, marks: { ...path.marks, ...marks } };
  };
  finish(st);
  return { stage: st, move, half, xingAt, at };
}

// -------------------------------------------------------------- a roundabout
export interface RoundOpts {
  /** the raised middle, the paved ring round it (its outer radius), the outer edge of the carriageway */
  island: number;
  apron: number;
  outer: number;
  /** the roads coming in: their lanes (one each way) and how long each arm is (0: none) */
  laneW: number;
  len: Record<Dir, number>;
  /** the radius of the kerbs where an arm meets the ring */
  r: number;
}

export interface Round {
  stage: Stage;
  /** in on one arm, round, out on another; marks: 'line', 'ring' (on the ring), 'exit' (leaving it), 'pass:<D>' (passing that arm), 'end' */
  move(from: Dir, to: Dir): Path;
}

/** the angle (atan2(z, x)) of each arm */
const ANGLE: Record<Dir, number> = { E: 0, S: Math.PI / 2, W: Math.PI, N: -Math.PI / 2 };

export function roundabout(o: RoundOpts): Round {
  const st = emptyStage();
  const hw = o.laneW;
  const R = o.r;
  const arms = DIRS.filter((d) => o.len[d] > 0);
  // ---- the outline: round the ring clockwise as seen on the map (decreasing angle: E, N, W, S …), out and back along each arm
  // where an arm's kerb meets the ring: the middle of the kerb's arc lies hw + R beside the arm's line and outer + R from the middle
  const ring: number[] = [];
  const t = Math.sqrt((o.outer + R) ** 2 - (hw + R) ** 2);
  // the arms in the order of decreasing angle, starting with the one of the largest angle
  const order = [...arms].sort((a, b) => ANGLE[b] - ANGLE[a]);
  const fillet = (d: Dir, side: 1 | -1): { centre: [number, number]; onArm: [number, number]; onRing: [number, number] } => {
    const a = ANGLE[d];
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    // `side` +1: the side of larger angle
    const nx = -Math.sin(a) * side;
    const nz = Math.cos(a) * side;
    const cx = ux * t + nx * (hw + R);
    const cz = uz * t + nz * (hw + R);
    const k = o.outer / (o.outer + R);
    return { centre: [cx, cz], onArm: [ux * t + nx * hw, uz * t + nz * hw], onRing: [cx * k, cz * k] };
  };
  const arcPts = (cx: number, cz: number, r: number, from: [number, number], to: [number, number], n: number, short = true): number[] => {
    const a0 = Math.atan2(from[1] - cz, from[0] - cx);
    let a1 = Math.atan2(to[1] - cz, to[0] - cx);
    if (short) {
      while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
      while (a0 - a1 > Math.PI) a1 += 2 * Math.PI;
    }
    const out: number[] = [];
    for (let k = 0; k <= n; k++) {
      const a = a0 + ((a1 - a0) * k) / n;
      out.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
    }
    return out;
  };
  for (let i = 0; i < order.length; i++) {
    const d = order[i];
    const next = order[(i + 1) % order.length];
    const a = ANGLE[d];
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    const nx = -Math.sin(a);
    const nz = Math.cos(a);
    const len = o.len[d];
    // out along the side of larger angle, across the end, back along the side of smaller angle
    const f1 = fillet(d, 1);
    const f2 = fillet(d, -1);
    ring.push(...arcPts(f1.centre[0], f1.centre[1], R, f1.onRing, f1.onArm, 6));
    ring.push(ux * len + nx * hw, uz * len + nz * hw, ux * len - nx * hw, uz * len - nz * hw);
    ring.push(...arcPts(f2.centre[0], f2.centre[1], R, f2.onArm, f2.onRing, 6));
    // along the ring's outer edge to the next arm (decreasing angle)
    const g = fillet(next, 1);
    const b0 = Math.atan2(f2.onRing[1], f2.onRing[0]);
    let b1 = Math.atan2(g.onRing[1], g.onRing[0]);
    while (b1 >= b0) b1 -= 2 * Math.PI;
    const n = Math.max(2, Math.ceil(((b0 - b1) * o.outer) / 1.5));
    for (let k = 1; k < n; k++) {
      const b = b0 + ((b1 - b0) * k) / n;
      ring.push(Math.cos(b) * o.outer, Math.sin(b) * o.outer);
    }
  }
  const circle = (r: number, n = 48): number[] => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(Math.cos((k / n) * Math.PI * 2) * r, Math.sin((k / n) * Math.PI * 2) * r);
    return out;
  };
  st.surfaces.push({ kind: 'asphalt', ring, holes: [circle(o.apron)] });
  st.surfaces.push({ kind: 'apron', ring: circle(o.apron), holes: [circle(o.island)] });
  st.surfaces.push({ kind: 'island', ring: circle(o.island) });
  st.kerbs.push({ line: [...circle(o.island), o.island, 0], lo: 'apron', hi: 'island' }, { line: [...circle(o.apron), o.apron, 0], lo: 'asphalt', hi: 'apron' });
  // ---- markings of each arm: the middle line, the give-way line, the signs 215 over 205
  // (the give-way line just outside the ring, across the lane coming in)
  const line = o.outer + 0.9;
  for (const d of arms) {
    const a = ANGLE[d];
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    // the right of the traffic coming in (heading −u): (−(−uz), −ux) = (uz, −ux)
    const rx = uz;
    const rz = -ux;
    const len = o.len[d];
    st.surfaces.push(...dashes(ux * (t + 1), uz * (t + 1), ux * len, uz * len, 0.12, 3, 6));
    st.surfaces.push(...dashes(ux * line + rx * 0.15, uz * line + rz * 0.15, ux * line + rx * hw, uz * line + rz * hw, 0.5, 0.5, 0.25));
    st.signs.push({ x: ux * (t + 2) + rx * (hw + 1.1), z: uz * (t + 2) + rz * (hw + 1.1), yaw: yawOf(ux, uz), codes: ['215', '205'] });
  }
  const rc = (o.apron + o.outer) / 2;
  /** where the curves onto the ring and off it begin and end on an arm (from the middle), and how far round the ring they reach */
  const bendAt = o.outer + 6.5;
  const along = 0.6;
  const move = (from: Dir, to: Dir): Path => {
    const a = ANGLE[from];
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    const rx = uz;
    const rz = -ux;
    const off = hw / 2;
    const tr = new Trace();
    tr.to(ux * o.len[from] + rx * off, uz * o.len[from] + rz * off);
    tr.to(ux * bendAt + rx * off, uz * bendAt + rz * off);
    // onto the ring a little past the arm (the ring is driven with decreasing angle), in one wide curve to the right
    const aIn = a - along;
    tr.join(-ux, -uz, Math.cos(aIn) * rc, Math.sin(aIn) * rc, Math.sin(aIn), -Math.cos(aIn));
    const marks: Record<string, number> = { ring: tr.len };
    // round to a little before the arm to leave by
    const b = ANGLE[to];
    let aOut = b + along;
    while (aOut >= aIn) aOut -= 2 * Math.PI;
    // (each arm passed on the way: the place on the ring beside it)
    const passed = DIRS.filter((d) => d !== from && o.len[d] > 0).map((d) => {
      let x = ANGLE[d];
      while (x >= aIn) x -= 2 * Math.PI;
      return [d, x] as [Dir, number];
    });
    const startLen = tr.len;
    tr.arc(0, 0, rc, aIn, aOut);
    for (const [d, x] of passed) if (x > aOut - 0.7) marks[`pass:${d}`] = startLen + (aIn - x) * rc;
    marks.exit = tr.len;
    const bx = Math.cos(b);
    const bz = Math.sin(b);
    // out on the right of the traffic leaving (heading +u): (−bz, bx)
    const ox = -bz * off;
    const oz = bx * off;
    tr.join(Math.sin(aOut), -Math.cos(aOut), bx * bendAt + ox, bz * bendAt + oz, bx, bz);
    marks.out = tr.len;
    tr.to(bx * o.len[to] + ox, bz * o.len[to] + oz);
    const path = tr.path(marks);
    // where the nose waits: 0.3 m before the give-way line (the first point of the way that close to the middle)
    const wait = line + 0.25 + 0.3;
    const pts = path.pts;
    let s = 0;
    for (let i = 0; i < path.acc.length; i++) {
      if (pts[i * 2] * ux + pts[i * 2 + 1] * uz <= wait) {
        s = path.acc[i];
        break;
      }
    }
    return { ...path, marks: { ...path.marks, line: s } };
  };
  finish(st);
  return { stage: st, move };
}

// ----------------------------------------------------------- a straight road
/**
 * A line along a straight road (it runs north–south): at `x`, or moving to
 * `to` between z0 and z1 (driving north: z0 > z1) – where a lane ends.
 */
export interface Bound {
  x: number;
  taper?: { z0: number; z1: number; to: number };
}

/** The x of a line along the road at z. */
export function boundAt(b: Bound, z: number): number {
  const t = b.taper;
  if (!t) return b.x;
  if (z >= t.z0) return b.x;
  if (z <= t.z1) return t.to;
  return b.x + ((t.to - b.x) * (t.z0 - z)) / (t.z0 - t.z1);
}

export interface StraightOpts {
  /** from the south end to the north end (z0 > z1) */
  z0: number;
  z1: number;
  /** the lines along it, from west to east */
  bounds: Bound[];
  /** what lies between line i and line i + 1 */
  strips: Array<SurfaceKind | 'grass'>;
  /** kerbs along these lines */
  kerbs?: number[];
  /** crash barriers along these x */
  guards?: number[];
}

/** The road's areas and kerbs. */
export function straight(o: StraightOpts): Stage {
  const st = emptyStage();
  // the z where something changes along the road: its ends and the ends of the tapers
  const zs = new Set<number>([o.z0, o.z1]);
  for (const b of o.bounds) if (b.taper) zs.add(b.taper.z0).add(b.taper.z1);
  const cuts = [...zs].filter((z) => z <= o.z0 && z >= o.z1).sort((a, b) => b - a);
  for (let i = 0; i < o.strips.length; i++) {
    const kind = o.strips[i];
    if (kind === 'grass') continue;
    const a = o.bounds[i];
    const b = o.bounds[i + 1];
    const left: number[] = [];
    const right: number[] = [];
    for (const z of cuts) {
      left.push(boundAt(a, z), z);
      right.push(boundAt(b, z), z);
    }
    const ring = [...left];
    for (let k = right.length - 2; k >= 0; k -= 2) ring.push(right[k], right[k + 1]);
    // (a strip that narrows to nothing still makes a simple outline)
    st.surfaces.push({ kind, ring });
  }
  for (const k of o.kerbs ?? []) {
    const line: number[] = [];
    for (const z of cuts) line.push(boundAt(o.bounds[k], z), z);
    st.kerbs.push({ line, lo: 'asphalt', hi: 'walk' });
  }
  for (const x of o.guards ?? []) st.guards.push([x, o.z0, x, o.z1]);
  return st;
}

/** A painted line along the road at the line `b` from z0 to z1: dashed (the length of dash and gap), or solid. */
export function along(b: Bound, z0: number, z1: number, w: number, dash?: [number, number]): Surface[] {
  // (piece by piece: straight, then along the taper, then straight again)
  const lo = Math.min(z0, z1);
  const hi = Math.max(z0, z1);
  const cuts = [z0, ...(b.taper ? [b.taper.z0, b.taper.z1] : []).filter((z) => z > lo && z < hi), z1].sort((a, c) => (z0 > z1 ? c - a : a - c));
  const out: Surface[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const za = cuts[i];
    const zb = cuts[i + 1];
    if (Math.abs(zb - za) < 0.01) continue;
    const xa = boundAt(b, za);
    const xb = boundAt(b, zb);
    if (dash) out.push(...dashes(xa, za, xb, zb, w, dash[0], dash[1]));
    else out.push(bar(xa, za, xb, zb, w));
  }
  return out;
}

/** A straight way along the road at x from z0 to z1 (either way). */
export function lanePath(x: number, z0: number, z1: number, marks: Record<string, number> = {}): Path {
  return new Trace().to(x, z0).to(x, z1).path(marks);
}

/** Every direction the stage's arms point in (for the tests). */
export const ARMS = DIRS;
