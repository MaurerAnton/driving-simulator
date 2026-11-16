// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Driving a bus on a line: calling at the stops on the way.  At each one
 * the bus comes to stand with its front door at the pole, the doors are
 * opened, people get off and on, the doors are closed once everybody is
 * through – and the bus pulls out with the indicator on (§ 10 StVO; the
 * others have to let it, § 20 Abs. 5 StVO).
 *
 * What the instructor says: a stop driven past, the doors opened where there
 * is no stop, driving with the doors open, closing them on people still
 * getting on, pulling out without indicating.
 */

/** A stop on the lane the bus is in: where its front stands to serve it (metres along the lane), its number and name. */
export interface BusStopAhead {
  id: number;
  s: number;
  name: string;
}

export type BusFault = 'busStopMissed' | 'busStopPlace' | 'busDoorsMoving' | 'busDoorsEarly' | 'busPullOut';

export interface BusEvent {
  fault: BusFault;
  severity: 'hint' | 'minor' | 'major' | 'fail';
}

/** how far before or past the place where its front should stand the bus may stop (m) */
export const BUS_STOP_BEFORE = 4;
export const BUS_STOP_PAST = 3;

export class BusService {
  /** stops served (stood there with the doors open until everybody was through) */
  served = 0;
  doorsOpen = false;
  boarding = 0;
  alighting = 0;
  private nextPassenger = 0;
  /** the stop the doors were opened at (−1: none) */
  private at = -1;
  /** stops done with: served or driven past */
  private readonly done = new Set<number>();
  /** leaving a stop: how far it has gone since, and whether it indicated to pull out */
  private leaving: { from: number; indicated: boolean } | null = null;
  private movingOpen = false;
  private readonly random: () => number;

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  get passengers(): number {
    return this.boarding + this.alighting;
  }

  /** The next stop on the lane not done with yet (null: none ahead on it). */
  next(front: number, stops: readonly BusStopAhead[]): BusStopAhead | null {
    for (const st of stops) if (!this.done.has(st.id) && st.s > front - BUS_STOP_PAST) return st;
    return null;
  }

  /** Is the bus standing where it serves a stop that is not done with? */
  atStop(front: number, stops: readonly BusStopAhead[], speed: number): BusStopAhead | null {
    if (Math.abs(speed) > 0.2) return null;
    const st = this.next(front, stops);
    return st && front >= st.s - BUS_STOP_BEFORE && front <= st.s + BUS_STOP_PAST ? st : null;
  }

  /** Open or close the doors (the door key) – only standing. */
  toggleDoors(front: number, stops: readonly BusStopAhead[], speed: number, events: BusEvent[]): void {
    if (Math.abs(speed) > 0.2) return;
    if (!this.doorsOpen) {
      this.doorsOpen = true;
      this.movingOpen = false;
      const st = this.atStop(front, stops, speed);
      if (st) {
        this.at = st.id;
        this.alighting = Math.floor(this.random() * 5);
        this.boarding = Math.floor(this.random() * 6);
        this.nextPassenger = 1.4;
      } else {
        this.at = -1;
        events.push({ fault: 'busStopPlace', severity: 'minor' });
      }
      return;
    }
    if (this.passengers > 0) events.push({ fault: 'busDoorsEarly', severity: 'minor' });
    this.doorsOpen = false;
    if (this.at >= 0) {
      if (this.passengers === 0) this.served++;
      this.done.add(this.at);
      this.leaving = { from: front, indicated: false };
    }
    this.boarding = this.alighting = 0;
    this.at = -1;
  }

  /**
   * One step: `front` metres along the lane the bus is in (`stops` its stops),
   * its speed, the indicator (−1 left).  What the instructor has to say is
   * added to `events`.
   */
  step(dt: number, front: number, stops: readonly BusStopAhead[], speed: number, indicator: number, events: BusEvent[]): void {
    // people through the open doors
    if (this.doorsOpen && this.at >= 0 && this.passengers > 0) {
      this.nextPassenger -= dt;
      if (this.nextPassenger <= 0) {
        if (this.alighting > 0) this.alighting--;
        else this.boarding--;
        this.nextPassenger = 1.0 + this.random() * 0.8;
      }
    }
    // driving off with the doors open
    if (this.doorsOpen && Math.abs(speed) > 0.5 && !this.movingOpen) {
      this.movingOpen = true;
      events.push({ fault: 'busDoorsMoving', severity: 'major' });
    }
    // pulling out of the stop: the indicator to the left first
    const l = this.leaving;
    if (l) {
      if (indicator < 0) l.indicated = true;
      if (Math.abs(speed) > 1.5 && !l.indicated) {
        events.push({ fault: 'busPullOut', severity: 'minor' });
        this.leaving = null;
      } else if (front - l.from > 25 || front < l.from - 5) this.leaving = null;
    }
    // a stop driven past: its front well beyond the place, the doors never opened there
    for (const st of stops) {
      if (this.done.has(st.id) || this.at === st.id) continue;
      if (front > st.s + BUS_STOP_PAST + 3 && front < st.s + 40) {
        this.done.add(st.id);
        events.push({ fault: 'busStopMissed', severity: 'major' });
      }
    }
  }
}
