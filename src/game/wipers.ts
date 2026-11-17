// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The windscreen in rain and snow, and the wipers that keep it clear.
 *
 * The stalk has four places – off, intermittent, normal, fast – and the
 * washer, which sprays while it is held and lets the wipers run on for two
 * more sweeps after it is let go (as on a real car).  Each wiper is an arm
 * turning about a pivot at the foot of the glass; its blade clears what it
 * passes over.
 *
 * What lies on the glass is kept in a coarse grid over it (in metres along
 * the glass: x from its left edge as the driver sees it, y up from its foot):
 *   - drops: how thickly drops sit there, 0 … 1 – rain lays them down, faster
 *     when driving into it; the renderer draws the drops themselves;
 *   - film: the sheet of water once the drops run together – it blurs the view;
 *   - snow: flakes that settle and build up into a white cover;
 *   - dirt: the spray of a wet road; wiped wet it goes, wiped dry it smears;
 *   - smear: the streaks of dirt wiped over a dry screen, until it is washed.
 * Warm air melts the snow into water; a dry screen dries what is on it.
 *
 * Nothing here draws or knows three.js: render/windscreen.ts draws it, the
 * game feeds it the weather and the speed.  Kept apart so that it can be tested.
 */

export type WiperMode = 'off' | 'intermittent' | 'normal' | 'fast';
export const WIPER_MODES: readonly WiperMode[] = ['off', 'intermittent', 'normal', 'fast'];

/** The stalk one place on: off → intermittent → normal → fast → off. */
export function nextWiperMode(m: WiperMode): WiperMode {
  return WIPER_MODES[(WIPER_MODES.indexOf(m) + 1) % WIPER_MODES.length];
}

/** seconds for one sweep, up and back down (normal about 50 a minute, fast about 80) */
export const SWEEP_SECONDS = { normal: 1.2, fast: 0.75 } as const;
/** the pause between two sweeps on intermittent (s) */
export const INTERVAL_PAUSE = 4;
/** sweeps after the washer is let go */
export const WASH_AFTER = 2;

/** Where along its sweep a blade is, 0 parked … 1 at the far end, at a point of the cycle (0 … 1). */
export function sweepAt(phase: number): number {
  return (1 - Math.cos(2 * Math.PI * phase)) / 2;
}

/**
 * The stalk and the motor.  Off stops the wipers only once they are back
 * in their place at the foot of the glass, as a real motor does.
 */
export class Wipers {
  mode: WiperMode = 'off';
  /** point of the sweep cycle, 0 (parked) … 1 */
  phase = 0;
  /** seconds until the next sweep on intermittent */
  private pause = 0;
  /** sweeps still to come after the washer */
  private after = 0;
  /** what the blades passed over in the last step: from … to (0 parked, 1 far end) */
  readonly swept = { lo: 0, hi: 0, any: false };

  /** The stalk one place on (the key, the button); returns the new place. */
  cycle(): WiperMode {
    this.mode = nextWiperMode(this.mode);
    // (intermittent sweeps once at once, then waits)
    this.pause = 0;
    return this.mode;
  }

  set(mode: WiperMode): void {
    if (mode !== this.mode) this.pause = 0;
    this.mode = mode;
  }

  /** the blades' place now, 0 parked … 1 at the far end */
  get angle(): number {
    return sweepAt(this.phase);
  }

  /** Are the blades moving (or about to)? */
  get running(): boolean {
    return this.phase > 0;
  }

  /** Runs the motor for `dt` seconds, the washer held or not; fills `swept`. */
  step(dt: number, washer: boolean): void {
    const sw = this.swept;
    sw.any = false;
    if (washer) this.after = WASH_AFTER;
    const want = (): boolean => washer || this.after > 0 || this.mode === 'normal' || this.mode === 'fast' || (this.mode === 'intermittent' && this.pause <= 0);
    if (this.phase <= 0 && !want()) {
      if (this.mode === 'intermittent') this.pause -= dt;
      return;
    }
    const period = this.mode === 'fast' && !washer ? SWEEP_SECONDS.fast : SWEEP_SECONDS.normal;
    const p0 = this.phase;
    let p1 = p0 + Math.max(0, dt) / period;
    let lo = Math.min(sweepAt(p0), sweepAt(Math.min(p1, 1)));
    let hi = Math.max(sweepAt(p0), sweepAt(Math.min(p1, 1)));
    if (p0 < 0.5 && p1 >= 0.5) hi = 1;
    if (p1 >= 1) {
      // back in the parked place: one sweep done
      lo = 0;
      if (!washer && this.after > 0) this.after--;
      if (this.mode === 'intermittent') this.pause = INTERVAL_PAUSE;
      p1 = want() ? Math.min(p1 - 1, 0.49) : 0;
      if (p1 > 0) hi = Math.max(hi, sweepAt(p1));
    }
    this.phase = p1;
    sw.lo = lo;
    sw.hi = hi;
    sw.any = true;
  }
}

/** One wiper: its pivot (m, in the glass), the reach of its blade, where it lies parked and how far it turns. */
export interface WiperArm {
  px: number;
  py: number;
  /** the blade from rIn to rOut from the pivot */
  rIn: number;
  rOut: number;
  /** direction when parked (rad, 0 = to the right, counter-clockwise up) */
  park: number;
  /** how far it turns (rad, + = counter-clockwise) */
  sweep: number;
}

/**
 * Two wipers side by side as on most cars, both parked pointing to the
 * right and sweeping up and over to the left: the left one clears the
 * driver's side up to the pillar, the right one the middle and the right.
 */
export function tandemArms(width: number, height: number): WiperArm[] {
  const l1 = Math.min(0.92 * height, 0.62 * width);
  const l2 = Math.min(0.84 * height, 0.5 * width);
  return [
    { px: 0.2 * width, py: -0.03 * height, rIn: 0.28 * l1, rOut: l1, park: 0.05, sweep: 2.6 },
    { px: 0.62 * width, py: -0.03 * height, rIn: 0.28 * l2, rOut: l2, park: 0.05, sweep: 2.45 },
  ];
}

/** The weather at the glass and how the vehicle moves through it. */
export interface ScreenWeather {
  /** rain, 0 … 1 (rainIntensity) */
  rain: number;
  /** snowfall, 0 … 1 (snowIntensity) */
  snow: number;
  /** air temperature (°C) */
  temperature: number;
  /** how wet the road is, 0 … 1 – driving on it throws up dirty spray */
  roadWet: number;
  /** speed forwards (m/s; backwards counts as standing) */
  speed: number;
  /** the wind across the glass from left to right (m/s), the vehicle's own airflow not included */
  crossWind: number;
  /** the engine runs: warm air on the glass from inside */
  heater: boolean;
}

/** A small random number generator (mulberry32): the same drops for the same seed. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * What lies on one windscreen: the grid of drops, water, snow and dirt over
 * it, and its wipers.  `width` × `height` metres along the glass.
 */
export class Windscreen {
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  readonly drops: Float32Array;
  readonly film: Float32Array;
  readonly snow: Float32Array;
  readonly dirt: Float32Array;
  readonly smear: Float32Array;
  /** how often each cell has been wiped (counts round at 256): the renderer lays new drops in new places after each wipe */
  readonly gen: Uint8Array;
  readonly wipers = new Wipers();
  readonly arms: WiperArm[];
  /** where along each arm's sweep each cell lies (0 … 1), −1 where its blade never comes */
  private readonly reach: Float32Array[];
  /** how readily snow settles on each cell (patches: 0.6 … 1.4) */
  private readonly patch: Float32Array;
  /** where the running drops have got to (m): the renderer moves its running drops by it */
  readonly flow = { x: 0, y: 0 };
  /** share of the drops that run (driving fast), 0 … 1 */
  running = 0;

  constructor(width: number, height: number, cols = 48, rows = 24, arms?: WiperArm[], seed = 1) {
    this.width = width;
    this.height = height;
    this.cols = cols;
    this.rows = rows;
    const n = cols * rows;
    this.drops = new Float32Array(n);
    this.film = new Float32Array(n);
    this.snow = new Float32Array(n);
    this.dirt = new Float32Array(n);
    this.smear = new Float32Array(n);
    this.gen = new Uint8Array(n);
    this.patch = new Float32Array(n);
    const rnd = seeded(seed);
    for (let i = 0; i < n; i++) this.patch[i] = 0.6 + 0.8 * rnd();
    this.arms = arms ?? tandemArms(width, height);
    this.reach = this.arms.map((a) => {
      const r = new Float32Array(n);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x = ((i + 0.5) / cols) * width - a.px;
          const y = ((j + 0.5) / rows) * height - a.py;
          const d = Math.hypot(x, y);
          let ang = Math.atan2(y, x) - a.park;
          if (a.sweep < 0) ang = -ang;
          while (ang < -Math.PI) ang += 2 * Math.PI;
          // (half a blade's width beyond either end still gets wiped)
          const t = ang / Math.abs(a.sweep);
          r[j * cols + i] = d >= a.rIn && d <= a.rOut && t >= -0.02 && t <= 1.02 ? clamp01(t) : -1;
        }
      }
      return r;
    });
  }

  /** The cell at a point of the glass (m), or −1 off it. */
  cellAt(x: number, y: number): number {
    const i = Math.floor((x / this.width) * this.cols);
    const j = Math.floor((y / this.height) * this.rows);
    return i >= 0 && i < this.cols && j >= 0 && j < this.rows ? j * this.cols + i : -1;
  }

  /** Is the cell ever reached by a blade? */
  wiped(cell: number): boolean {
    return this.reach.some((r) => r[cell] >= 0);
  }

  /** Each blade's place along the glass now: its direction (rad) for the renderer. */
  armAngle(k: number): number {
    const a = this.arms[k];
    return a.park + a.sweep * this.wipers.angle;
  }

  /**
   * One step of `dt` seconds: what falls on the glass, runs off it, melts or
   * dries – then what the blades pass over, with the washer held or not.
   */
  step(dt: number, w: ScreenWeather, washer = false): void {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.25);
    const v = Math.max(0, w.speed);
    const rain = clamp01(w.rain);
    const snowing = clamp01(w.snow);
    // driving into the rain catches more of it
    const catchRain = 1 + v / 14;
    const dropRate = rain * 0.22 * catchRain;
    // the drops run together into a sheet of water once they lie thick
    const filmRate = rain * 0.045 * catchRain;
    const snowRate = snowing * 0.016 * (1 + v / 12);
    const melt = w.temperature > 0.5 ? Math.min(0.05, 0.006 * w.temperature) : 0;
    // (the heater thaws the glass from its foot, slowly)
    const thaw = w.heater ? 0.0035 : 0;
    // wind of driving fast: drops run up and to the sides, a sheet of water is blown thinner
    this.running = clamp01((v - 11) / 14);
    const up = 0.0009 * v * v - 0.04;
    this.flow.x += w.crossWind * 0.03 * dt;
    this.flow.y += Math.max(0, up) * this.running * dt;
    const blowOff = this.running * 0.05;
    const dry = rain === 0 && snowing === 0 ? 0.012 : 0;
    const spray = clamp01(w.roadWet) * 0.0016 * Math.min(1, v / 15);
    const n = this.cols * this.rows;
    for (let k = 0; k < n; k++) {
      let d = this.drops[k] + dropRate * dt;
      let f = this.film[k] + (d > 0.55 ? filmRate * dt : filmRate * 0.2 * dt) - (blowOff + dry) * this.film[k] * dt;
      if (dry) d -= dry * 1.5 * dt;
      let s = this.snow[k] + snowRate * this.patch[k] * dt;
      const j = Math.floor(k / this.cols);
      const m = (melt + thaw * Math.max(0, 1 - (j / this.rows) * 2.5)) * dt;
      if (m > 0 && s > 0) {
        const gone = Math.min(s, m);
        s -= gone;
        f += gone * 0.6;
        d += gone * 0.6;
      }
      // (snow lying on the glass takes the rain into itself)
      if (s > 0.6) d *= 1 - dt;
      this.drops[k] = clamp01(d);
      this.film[k] = clamp01(f);
      this.snow[k] = clamp01(s);
      this.dirt[k] = clamp01(this.dirt[k] + spray * dt);
    }
    if (washer) {
      for (let k = 0; k < n; k++) {
        this.film[k] = clamp01(this.film[k] + 1.2 * dt);
        this.drops[k] = clamp01(this.drops[k] + 1.5 * dt);
      }
    }
    this.wipers.step(dt, washer);
    if (this.wipers.swept.any) this.wipe(this.wipers.swept.lo, this.wipers.swept.hi);
  }

  /** The blades passed from `lo` to `hi` of their sweep: clear what lies there. */
  wipe(lo: number, hi: number): void {
    const n = this.cols * this.rows;
    for (const r of this.reach) {
      for (let k = 0; k < n; k++) {
        const t = r[k];
        if (t < 0 || t < lo - 0.01 || t > hi + 0.01) continue;
        const wet = this.film[k] > 0.15 || this.drops[k] > 0.5;
        if (wet) {
          // wiped wet: the dirt goes with the water, the streaks are washed away
          this.dirt[k] *= 0.35;
          this.smear[k] *= 0.5;
        } else if (this.dirt[k] > 0.03) {
          // wiped dry: the dirt is smeared about
          this.smear[k] = clamp01(this.smear[k] + 0.25 * this.dirt[k]);
        }
        if (this.drops[k] > 0) this.gen[k] = (this.gen[k] + 1) & 255;
        this.drops[k] = 0;
        this.film[k] *= 0.06;
        this.snow[k] *= 0.08;
      }
    }
  }

  /**
   * How much of the view through the glass is lost, 0 clear … 1 none left –
   * over the part the driver looks through (the left two thirds, from a
   * quarter up to near the top).
   */
  obscured(): number {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.floor(this.rows * 0.25); j < Math.ceil(this.rows * 0.8); j++) {
      for (let i = Math.floor(this.cols * 0.08); i < Math.ceil(this.cols * 0.66); i++) {
        const k = j * this.cols + i;
        sum += Math.max(this.snow[k], this.film[k] * 0.8, this.drops[k] * 0.45, Math.min(1, this.dirt[k] * 0.8 + this.smear[k] * 0.7));
        cnt++;
      }
    }
    return cnt ? sum / cnt : 0;
  }

  /** Everything off the glass (a new vehicle, a fresh start). */
  clear(): void {
    this.drops.fill(0);
    this.film.fill(0);
    this.snow.fill(0);
    this.dirt.fill(0);
    this.smear.fill(0);
  }
}
