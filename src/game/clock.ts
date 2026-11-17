// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The game's clock: the moment the world is at.
 *
 * Normally that is the real time – the trams and buses run by their
 * timetables as they do now, the sun stands where it stands now, the signs
 * with a time on them count now.  In the arcade mode the player may set the
 * world to another day and hour, to see a place as it will be then (its
 * timetables, its light, its season), and let the time run faster while the
 * autopilot drives.  Back at "now" the clock is the real one again, and what
 * follows real data catches up with it.
 *
 * Everything in the game that asks "what time is it in the world?" asks
 * `gameNow()` (not `new Date()`): one clock for all of it.
 */

/** A clock that is the real one, or one of its own that the game moves on. */
export class GameClock {
  /** the game's own time (ms since 1970) – null: the real time */
  private own: number | null = null;
  /** set by the player (another day or hour) – not only run faster */
  private chosen = false;
  /** how many times faster than real the time runs (1: as real) */
  private speed = 1;
  private readonly realNow: () => number;

  constructor(realNow: () => number = () => Date.now()) {
    this.realNow = realNow;
  }

  /** The moment of the world, in milliseconds since 1970. */
  ms(): number {
    return this.own ?? this.realNow();
  }

  /** The moment of the world. */
  now(): Date {
    return new Date(this.ms());
  }

  /** Is the world at the real time, at the real speed? */
  get real(): boolean {
    return this.own === null;
  }

  /** Has the player set another day or hour? */
  get travelled(): boolean {
    return this.chosen;
  }

  /** How many times faster than real the time runs. */
  get rate(): number {
    return this.speed;
  }

  /**
   * Time passes in the world: `dt` seconds of it (what the game simulated –
   * at a higher rate that many more; a paused game stands still, unless it
   * is at the real time).  The real clock needs nothing.
   */
  tick(dt: number): void {
    if (this.own !== null && dt > 0) this.own += dt * 1000;
  }

  /** Set the world to another moment (from where it runs on). */
  set(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.own = ms;
    this.chosen = true;
  }

  /**
   * Let the time run faster (`rate` > 1) or as real again (1).  Run faster,
   * the world has a time of its own from here on; back at 1 after only that,
   * it is at the real time again (the timetables catch up) – after the player
   * had set another moment, it stays at the world's own time.
   */
  setRate(rate: number): void {
    const r = Number.isFinite(rate) ? Math.max(1, Math.min(MAX_RATE, rate)) : 1;
    if (r > 1 && this.own === null) this.own = this.realNow();
    this.speed = r;
    if (r === 1 && !this.chosen) this.own = null;
  }

  /** Back to the real time, at the real speed. */
  reset(): void {
    this.own = null;
    this.chosen = false;
    this.speed = 1;
  }
}

/** the fastest the time may run (and the game still keep up) */
export const MAX_RATE = 8;
/** the speeds offered while the autopilot drives */
export const RATES: readonly number[] = [1, 2, 4, 8];

/** The game's one clock. */
export const gameClock = new GameClock();

/** The moment of the world (the real time, unless the arcade mode set another one). */
export const gameNow = (): Date => gameClock.now();

/**
 * Where the sun stands over the map (northern Hesse, 51.3° N 9.45° E) at a
 * moment: its elevation above the horizon and its compass azimuth (degrees,
 * 0 = north, 90 = east, 180 = south).  The usual approximation of the
 * astronomical almanac – a fraction of a degree, more than enough for light
 * and shadows.
 */
export function sunAt(ms: number, latDeg = 51.3, lonDeg = 9.45): { elevation: number; azimuth: number } {
  const rad = Math.PI / 180;
  // days since J2000.0
  const d = ms / 86400000 - 10957.5;
  // the sun's mean longitude and mean anomaly, its ecliptic longitude
  const L = (280.46 + 0.9856474 * d) % 360;
  const g = ((357.528 + 0.9856003 * d) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * d) * rad;
  // right ascension and declination
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  // the local sidereal time, the hour angle
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const lst = (gmst * 15 + lonDeg) * rad;
  const ha = lst - ra;
  const lat = latDeg * rad;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  // azimuth from north, clockwise
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha));
  return { elevation: el / rad, azimuth: ((az / rad) % 360 + 360) % 360 };
}

/** The season of a moment in the north (by the months: winter Dec–Feb, spring Mar–May, …). */
export type Season = 'winter' | 'spring' | 'summer' | 'autumn';
export function seasonOf(date: Date): Season {
  const m = date.getMonth();
  return m === 11 || m <= 1 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'autumn';
}
