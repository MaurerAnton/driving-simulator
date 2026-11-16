// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Replays: a drive recorded as it happens and shown again 1:1 – the player's
 * vehicle (or the person on foot, the tram, the aeroplane), the traffic round
 * it, the trams and trains, the traffic lights and the instructor's notes on
 * a timeline – so that one can look at a junction or a stop again from any
 * side, slowed down.
 *
 * What is recorded is what the renderers draw, not what the simulation
 * thinks: positions, turns, lamps, the dashboard.  The player's vehicle ten
 * times a second, the others five times (in between they are interpolated),
 * the lights twice (the controllers within 600 m).  The last half hour is
 * kept: some 10–20 MB.
 */
import { consistOf } from '../sim/rail.ts';
import type { Consist } from '../sim/rail.ts';
import type { SignalSnapshot } from '../sim/signals.ts';

/** How often the parts of a drive are written down (s), and how much of it is kept. */
export const REPLAY_STEP = 0.1;
export const REPLAY_OTHERS_STEP = 0.2;
export const REPLAY_SIGNALS_STEP = 0.5;
export const REPLAY_KEEP = 30 * 60;

/** The numbers per traffic car, person on foot, cyclist and rail car in a frame. */
export const CAR_FIELDS = 13;
export const PED_FIELDS = 8;
export const CYCLIST_FIELDS = 9;
export const RAIL_HEAD = 6;
export const RAIL_CAR_FIELDS = 5;

/** One moment of a drive. */
export interface ReplayFrame {
  t: number;
  /** the player's model: x, y, z and its turn as a quaternion */
  pose: Float32Array;
  /** its visual state (lamps, wheels, the dashboard), packed by a VisualPacker */
  look: Float32Array | null;
  /** a trailer: x, y, z, yaw, pitch, wheel turn, coupled */
  trailer: Float32Array | null;
  /** somebody on foot: x, y, z, yaw, metres walked, moving, riding (1) */
  walker: Float32Array | null;
  /** the traffic (CAR_FIELDS a car: id, style, x, y, z, yaw, pitch, wheel turn, indicator, braking, speed, colour, the bus line it runs or −1) – null: as in the last frame that has it */
  cars: Float32Array | null;
  /** people on foot (id, colour, x, y, z, yaw, crossing, step) */
  peds: Float32Array | null;
  /** cyclists (id, colour, x, y, z, yaw, pedal turn, lean, fallen) */
  cyclists: Float32Array | null;
  /** trams and trains: per vehicle id, kind, make-up (0 one unit, 1 two, 2 with trailer), line (−1 none), pantographs, cars – then x, y, z, yaw, pitch a car */
  rail: Float32Array | null;
  /** the lights around (null: as before) */
  signals: SignalSnapshot | null;
}

/** A note of the instructor, where on the timeline it fell. */
export interface ReplayNote {
  t: number;
  id: string;
  severity: 'hint' | 'minor' | 'major' | 'fail';
  data: Record<string, number | string>;
}

type Packed = number | boolean | string | readonly number[];

/**
 * Packs an object of numbers, flags, short texts and arrays of numbers (a
 * visual state) into a Float32Array and back – the fields in the order the
 * first object had them.  Texts go into a table of their own.
 */
export class VisualPacker {
  private keys: string[] | null = null;
  private sizes: number[] = [];
  private kinds: Array<'n' | 'b' | 's' | 'a'> = [];
  private size = 0;
  private readonly texts: string[] = [];

  pack(o: object): Float32Array {
    const rec = o as Record<string, Packed>;
    if (!this.keys) {
      this.keys = [];
      for (const [k, v] of Object.entries(rec)) {
        const kind = typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : typeof v === 'string' ? 's' : Array.isArray(v) && v.every((x) => typeof x === 'number') ? 'a' : null;
        if (!kind) continue;
        this.keys.push(k);
        this.kinds.push(kind);
        const n = kind === 'a' ? (v as number[]).length : 1;
        this.sizes.push(n);
        this.size += n;
      }
    }
    const out = new Float32Array(this.size);
    let at = 0;
    this.keys.forEach((k, i) => {
      const v = rec[k];
      const kind = this.kinds[i];
      if (kind === 'n') out[at] = v as number;
      else if (kind === 'b') out[at] = v ? 1 : 0;
      else if (kind === 's') {
        let n = this.texts.indexOf(v as string);
        if (n < 0) n = this.texts.push(v as string) - 1;
        out[at] = n;
      } else {
        const a = v as readonly number[];
        for (let j = 0; j < this.sizes[i]; j++) out[at + j] = a[j] ?? 0;
      }
      at += this.sizes[i];
    });
    return out;
  }

  /** Writes a packed state back into `o` (an object of the same kind). */
  unpack(p: Float32Array, o: object): void {
    if (!this.keys) return;
    const rec = o as Record<string, Packed>;
    let at = 0;
    this.keys.forEach((k, i) => {
      const kind = this.kinds[i];
      if (kind === 'n') rec[k] = p[at];
      else if (kind === 'b') rec[k] = p[at] === 1;
      else if (kind === 's') rec[k] = this.texts[p[at]] ?? '';
      else {
        const a = rec[k] as number[];
        for (let j = 0; j < this.sizes[i]; j++) a[j] = p[at + j];
      }
      at += this.sizes[i];
    });
  }
}

/** Writes a drive down as it goes. */
export class Recorder {
  readonly frames: ReplayFrame[] = [];
  readonly notes: ReplayNote[] = [];
  /** what the vehicle was (the game's vehicle kind) – a replay shows it with that model */
  vehicle = '';
  readonly look = new VisualPacker();
  readonly planeLook = new VisualPacker();
  private nextAt = 0;
  private nextOthers = 0;
  private nextSignals = 0;

  /** A new drive: nothing recorded yet. */
  clear(vehicle: string): void {
    this.frames.length = 0;
    this.notes.length = 0;
    this.vehicle = vehicle;
    this.nextAt = this.nextOthers = this.nextSignals = 0;
  }

  /** Whether a frame is due at time t; which of the parts that are written less often are due with it. */
  due(t: number): { others: boolean; signals: boolean } | null {
    if (t < this.nextAt) return null;
    this.nextAt = Math.max(this.nextAt + REPLAY_STEP, t - REPLAY_STEP);
    const others = t >= this.nextOthers;
    if (others) this.nextOthers = Math.max(this.nextOthers + REPLAY_OTHERS_STEP, t - REPLAY_OTHERS_STEP);
    const signals = t >= this.nextSignals;
    if (signals) this.nextSignals = Math.max(this.nextSignals + REPLAY_SIGNALS_STEP, t - REPLAY_SIGNALS_STEP);
    return { others, signals };
  }

  push(f: ReplayFrame): void {
    this.frames.push(f);
    // (only the last half hour: what is older goes – keeping the first frame of what stays complete)
    const from = f.t - REPLAY_KEEP;
    let drop = 0;
    while (drop < this.frames.length - 1 && this.frames[drop].t < from) drop++;
    if (drop > 50) {
      const keep = this.frames[drop];
      // (the traffic, the trains and the lights of the first frame that stays: from the newest that had them)
      for (let i = drop; i >= 0 && (!keep.cars || !keep.rail || !keep.signals); i--) {
        const g = this.frames[i];
        keep.cars ??= g.cars;
        keep.peds ??= g.peds;
        keep.cyclists ??= g.cyclists;
        keep.rail ??= g.rail;
        keep.signals ??= g.signals;
      }
      this.frames.splice(0, drop);
      while (this.notes.length > 0 && this.notes[0].t < this.frames[0].t) this.notes.shift();
    }
  }

  note(n: ReplayNote): void {
    this.notes.push(n);
  }

  get start(): number {
    return this.frames.length > 0 ? this.frames[0].t : 0;
  }

  get end(): number {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1].t : 0;
  }
}

/** Something drawn in a replay: the fields its renderer reads, kept per id from frame to frame. */
export interface ReplayCar {
  id: number;
  style: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  wheelSpin: number;
  blinker: number;
  braking: boolean;
  v: number;
  color: number;
  /** a bus: the line it runs (its place in the traffic's bus lines; −1 none) – and, set by the game, what its display shows */
  line: number;
  bus?: { line: { ref: string; to: string } | null };
}
export interface ReplayPed {
  id: number;
  colour: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: 'wait' | 'cross';
  phase: number;
}
export interface ReplayCyclist {
  id: number;
  colour: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  phase: number;
  roll: number;
  down: number;
}
export interface ReplayRailCar {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}
export interface ReplayRail {
  id: number;
  kind: number;
  set: 'single' | 'double' | 'trailer';
  /** what it is made of (for the renderer, which lays out its cars by it) */
  consist: Consist;
  line: { index: number; k: number } | null;
  panto: number;
  cars: ReplayRailCar[];
}

/** The angle a share u of the way from a to b (the short way round). */
function lerpAngle(a: number, b: number, u: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * u;
}

/**
 * Plays a recording: where the clock of the replay stands, and what is to be
 * drawn there – interpolated between the two frames round it.
 */
export class ReplayView {
  readonly rec: Recorder;
  t: number;
  speed = 1;
  playing = true;
  private readonly cars = new Map<number, ReplayCar>();
  private readonly peds = new Map<number, ReplayPed>();
  private readonly cyclists = new Map<number, ReplayCyclist>();
  private readonly rail = new Map<number, ReplayRail>();
  readonly carList: ReplayCar[] = [];
  readonly pedList: ReplayPed[] = [];
  readonly cyclistList: ReplayCyclist[] = [];
  readonly railList: ReplayRail[] = [];
  /** the player's model now: x, y, z, qx, qy, qz, qw */
  readonly pose = new Float32Array(7);

  constructor(rec: Recorder, from = rec.start) {
    this.rec = rec;
    this.t = Math.max(rec.start, Math.min(rec.end, from));
  }

  get start(): number {
    return this.rec.start;
  }

  get end(): number {
    return this.rec.end;
  }

  /** On by dt seconds of the drive's time (at the speed chosen); stops at the end. */
  advance(dt: number): void {
    if (!this.playing) return;
    this.t += dt * this.speed;
    if (this.t >= this.end) {
      this.t = this.end;
      this.playing = false;
    }
  }

  seek(t: number): void {
    this.t = Math.max(this.start, Math.min(this.end, t));
  }

  /** The index of the last frame at or before t. */
  private index(t: number): number {
    const f = this.rec.frames;
    let lo = 0;
    let hi = f.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (f[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The frame before the clock and the one after it, and how far between them it stands. */
  frame(): { a: ReplayFrame; b: ReplayFrame; u: number } | null {
    const f = this.rec.frames;
    if (f.length === 0) return null;
    const i = this.index(this.t);
    const a = f[i];
    const b = f[Math.min(f.length - 1, i + 1)];
    const u = b.t > a.t ? Math.max(0, Math.min(1, (this.t - a.t) / (b.t - a.t))) : 0;
    // the player's model between the two (the turn the short way)
    const p = this.pose;
    for (let k = 0; k < 3; k++) p[k] = a.pose[k] + (b.pose[k] - a.pose[k]) * u;
    let dot = 0;
    for (let k = 3; k < 7; k++) dot += a.pose[k] * b.pose[k];
    const sign = dot < 0 ? -1 : 1;
    let len = 0;
    for (let k = 3; k < 7; k++) {
      p[k] = a.pose[k] + (sign * b.pose[k] - a.pose[k]) * u;
      len += p[k] * p[k];
    }
    len = Math.sqrt(len) || 1;
    for (let k = 3; k < 7; k++) p[k] /= len;
    return { a, b, u };
  }

  /** The newest frame at or before the clock that has the part `key`. */
  private latest<K extends 'cars' | 'peds' | 'cyclists' | 'rail' | 'signals'>(key: K, before = this.t): { f: ReplayFrame; i: number } | null {
    const frames = this.rec.frames;
    for (let i = this.index(before); i >= 0; i--) if (frames[i][key]) return { f: frames[i], i };
    return null;
  }

  /** The one after frame i that has the part `key` (to move towards). */
  private following<K extends 'cars' | 'peds' | 'cyclists' | 'rail'>(key: K, i: number): ReplayFrame | null {
    const frames = this.rec.frames;
    for (let j = i + 1; j < frames.length; j++) if (frames[j][key]) return frames[j];
    return null;
  }

  /** The lights as they were at the clock. */
  signals(): SignalSnapshot | null {
    return this.latest('signals')?.f.signals ?? null;
  }

  /** The traffic at the clock, interpolated: fills carList, pedList, cyclistList. */
  traffic(): void {
    this.carList.length = 0;
    const c0 = this.latest('cars');
    if (c0) {
      const c1 = this.following('cars', c0.i);
      const u = c1 && c1.t > c0.f.t ? Math.max(0, Math.min(1, (this.t - c0.f.t) / (c1.t - c0.f.t))) : 0;
      const a = c0.f.cars as Float32Array;
      const next = new Map<number, number>();
      if (c1?.cars) for (let k = 0; k < c1.cars.length; k += CAR_FIELDS) next.set(c1.cars[k], k);
      for (let k = 0; k < a.length; k += CAR_FIELDS) {
        const id = a[k];
        let c = this.cars.get(id);
        if (!c) this.cars.set(id, (c = { id, style: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, wheelSpin: 0, blinker: 0, braking: false, v: 0, color: 0, line: -1 }));
        const j = next.get(id);
        const b = j !== undefined ? (c1?.cars as Float32Array) : null;
        const w = b ? u : 0;
        const at = (o: number): number => (b ? a[k + o] + (b[(j as number) + o] - a[k + o]) * w : a[k + o]);
        c.style = a[k + 1];
        c.x = at(2);
        c.y = at(3);
        c.z = at(4);
        c.yaw = b ? lerpAngle(a[k + 5], b[(j as number) + 5], w) : a[k + 5];
        c.pitch = at(6);
        c.wheelSpin = at(7);
        c.blinker = a[k + 8];
        c.braking = a[k + 9] === 1;
        c.v = at(10);
        c.color = a[k + 11];
        c.line = a[k + 12];
        this.carList.push(c);
      }
    }
    this.pedList.length = 0;
    const p0 = this.latest('peds');
    if (p0) {
      const p1 = this.following('peds', p0.i);
      const u = p1 && p1.t > p0.f.t ? Math.max(0, Math.min(1, (this.t - p0.f.t) / (p1.t - p0.f.t))) : 0;
      const a = p0.f.peds as Float32Array;
      const next = new Map<number, number>();
      if (p1?.peds) for (let k = 0; k < p1.peds.length; k += PED_FIELDS) next.set(p1.peds[k], k);
      for (let k = 0; k < a.length; k += PED_FIELDS) {
        const id = a[k];
        let p = this.peds.get(id);
        if (!p) this.peds.set(id, (p = { id, colour: 0, x: 0, y: 0, z: 0, yaw: 0, state: 'wait', phase: 0 }));
        const j = next.get(id);
        const b = j !== undefined ? (p1?.peds as Float32Array) : null;
        const at = (o: number): number => (b ? a[k + o] + (b[(j as number) + o] - a[k + o]) * u : a[k + o]);
        p.colour = a[k + 1];
        p.x = at(2);
        p.y = at(3);
        p.z = at(4);
        p.yaw = b ? lerpAngle(a[k + 5], b[(j as number) + 5], u) : a[k + 5];
        p.state = a[k + 6] === 1 ? 'cross' : 'wait';
        p.phase = at(7);
        this.pedList.push(p);
      }
    }
    this.cyclistList.length = 0;
    const y0 = this.latest('cyclists');
    if (y0) {
      const y1 = this.following('cyclists', y0.i);
      const u = y1 && y1.t > y0.f.t ? Math.max(0, Math.min(1, (this.t - y0.f.t) / (y1.t - y0.f.t))) : 0;
      const a = y0.f.cyclists as Float32Array;
      const next = new Map<number, number>();
      if (y1?.cyclists) for (let k = 0; k < y1.cyclists.length; k += CYCLIST_FIELDS) next.set(y1.cyclists[k], k);
      for (let k = 0; k < a.length; k += CYCLIST_FIELDS) {
        const id = a[k];
        let c = this.cyclists.get(id);
        if (!c) this.cyclists.set(id, (c = { id, colour: 0, x: 0, y: 0, z: 0, yaw: 0, phase: 0, roll: 0, down: 0 }));
        const j = next.get(id);
        const b = j !== undefined ? (y1?.cyclists as Float32Array) : null;
        const at = (o: number): number => (b ? a[k + o] + (b[(j as number) + o] - a[k + o]) * u : a[k + o]);
        c.colour = a[k + 1];
        c.x = at(2);
        c.y = at(3);
        c.z = at(4);
        c.yaw = b ? lerpAngle(a[k + 5], b[(j as number) + 5], u) : a[k + 5];
        c.phase = at(6);
        c.roll = at(7);
        c.down = a[k + 8];
        this.cyclistList.push(c);
      }
    }
  }

  /** The trams and trains at the clock, interpolated: fills railList. */
  trains(): void {
    this.railList.length = 0;
    const r0 = this.latest('rail');
    if (!r0) return;
    const r1 = this.following('rail', r0.i);
    const u = r1 && r1.t > r0.f.t ? Math.max(0, Math.min(1, (this.t - r0.f.t) / (r1.t - r0.f.t))) : 0;
    const read = (a: Float32Array): Map<number, number> => {
      const m = new Map<number, number>();
      for (let k = 0; k < a.length; k += RAIL_HEAD + a[k + 5] * RAIL_CAR_FIELDS) m.set(a[k], k);
      return m;
    };
    const a = r0.f.rail as Float32Array;
    const next = r1?.rail ? read(r1.rail) : new Map<number, number>();
    for (let k = 0; k < a.length; k += RAIL_HEAD + a[k + 5] * RAIL_CAR_FIELDS) {
      const id = a[k];
      const n = a[k + 5];
      let v = this.rail.get(id);
      if (!v || v.cars.length !== n) this.rail.set(id, (v = { id, kind: a[k + 1], set: 'single', consist: consistOf(a[k + 1]), line: null, panto: 1, cars: Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 })) }));
      v.kind = a[k + 1];
      v.set = a[k + 2] === 1 ? 'double' : a[k + 2] === 2 ? 'trailer' : 'single';
      v.consist = consistOf(v.kind, v.set);
      v.line = a[k + 3] >= 0 ? { index: a[k + 3], k: 0 } : null;
      v.panto = a[k + 4];
      const j = next.get(id);
      const b = j !== undefined && r1?.rail && r1.rail[(j as number) + 5] === n ? r1.rail : null;
      for (let c = 0; c < n; c++) {
        const o = k + RAIL_HEAD + c * RAIL_CAR_FIELDS;
        const q = (j as number) + RAIL_HEAD + c * RAIL_CAR_FIELDS;
        const car = v.cars[c];
        car.x = b ? a[o] + (b[q] - a[o]) * u : a[o];
        car.y = b ? a[o + 1] + (b[q + 1] - a[o + 1]) * u : a[o + 1];
        car.z = b ? a[o + 2] + (b[q + 2] - a[o + 2]) * u : a[o + 2];
        car.yaw = b ? lerpAngle(a[o + 3], b[q + 3], u) : a[o + 3];
        car.pitch = b ? a[o + 4] + (b[q + 4] - a[o + 4]) * u : a[o + 4];
      }
      this.railList.push(v);
    }
  }
}
