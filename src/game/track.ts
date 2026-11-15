// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The path the car has driven, for the map: a line of points a few metres
 * apart, kept in the browser so that it is still there in the next session.
 * A jump (teleport, new start) breaks the line.
 */
import type { KeyValueStore } from './faultlog.ts';

const KEY = 'fahrsim-baunatal.path.v1';
/** a new point when the car has moved this far (m) */
const STEP = 8;
/** the oldest points make room: 12 000 points are about 100 km */
export const PATH_MAX_POINTS = 12000;

export class DrivenPath {
  /** x, z, x, z …; a pair of NaN ends a stretch */
  readonly points: number[] = [];
  private readonly store: KeyValueStore | null;
  private dirty = 0;

  constructor(store: KeyValueStore | null = typeof localStorage === 'undefined' ? null : localStorage) {
    this.store = store;
    try {
      const raw = store?.getItem(KEY);
      if (raw) {
        const list: unknown = JSON.parse(raw);
        // stored as whole metres, null for a break
        if (Array.isArray(list) && list.length % 2 === 0) for (const v of list) this.points.push(typeof v === 'number' && Number.isFinite(v) ? v : NaN);
        this.breakLine();
      }
    } catch {
      /* nothing usable stored */
    }
  }

  /** The car is at (x, z) now. */
  add(x: number, z: number): void {
    const p = this.points;
    const n = p.length;
    if (n >= 2 && !Number.isNaN(p[n - 2])) {
      const d = Math.hypot(x - p[n - 2], z - p[n - 1]);
      if (d < STEP) return;
      // too far for one step of driving: the car was put somewhere else
      if (d > 60) this.breakLine();
    }
    p.push(Math.round(x * 10) / 10, Math.round(z * 10) / 10);
    if (p.length > PATH_MAX_POINTS * 2) p.splice(0, p.length - PATH_MAX_POINTS * 2);
    if (++this.dirty >= 40) this.save();
  }

  /** The next point does not continue the line (teleport, new drive). */
  breakLine(): void {
    const p = this.points;
    if (p.length >= 2 && !Number.isNaN(p[p.length - 2])) p.push(NaN, NaN);
  }

  /** Length of the path in metres. */
  length(): number {
    const p = this.points;
    let sum = 0;
    for (let i = 2; i < p.length; i += 2) {
      if (Number.isNaN(p[i]) || Number.isNaN(p[i - 2])) continue;
      sum += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    }
    return sum;
  }

  clear(): void {
    this.points.length = 0;
    this.dirty = 0;
    try {
      this.store?.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }

  save(): void {
    this.dirty = 0;
    try {
      this.store?.setItem(KEY, JSON.stringify(this.points.map((v) => (Number.isNaN(v) ? null : Math.round(v)))));
    } catch {
      /* private window or storage full: the path lives as long as the page */
    }
  }
}
