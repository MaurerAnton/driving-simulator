// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The tours driven, kept in the browser: when, how long the tour was meant
 * to be and how much of it was driven, whether it was driven to its end, and
 * its line for the map – also of a tour given up half-way.
 */

/** What a tour is to lead along: which roads it may not use, and which kind of street it is to look for. */
export interface TourPrefs {
  noMotorway: boolean;
  noExpress: boolean;
  noMain: boolean;
  /** mostly along: any streets, small houses, blocks and town centres, the open country */
  mostly: 'any' | 'small' | 'town' | 'country';
}

export const DEFAULT_TOUR_PREFS: TourPrefs = { noMotorway: false, noExpress: false, noMain: false, mostly: 'any' };

export interface TourRecord {
  /** when it was driven (ISO time) */
  date: string;
  /** metres planned, driven, and of them along streets new to the tour */
  planned: number;
  driven: number;
  fresh: number;
  /** driven to its end */
  done: boolean;
  /** its line (x, z, … whole metres) */
  line: number[];
  prefs: TourPrefs;
}

const KEY = 'fahrsim.tours';
/** how many are kept (the newest) */
const KEEP = 40;

export function loadTours(): TourRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as TourRecord[]) : [];
    return Array.isArray(list) ? list.filter((t) => t && typeof t.date === 'string' && Array.isArray(t.line)) : [];
  } catch {
    return [];
  }
}

export function saveTour(t: TourRecord): void {
  try {
    const list = [t, ...loadTours()].slice(0, KEEP);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* (private browsing, a full storage: the tour is not kept) */
  }
}

/** A line of at most `max` points (every n-th, the last always), in whole metres – small enough to keep many. */
export function thinLine(line: ArrayLike<number>, max = 500): number[] {
  const n = Math.floor(line.length / 2);
  const step = Math.max(1, Math.ceil(n / max));
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(Math.round(line[i * 2]), Math.round(line[i * 2 + 1]));
  if (n > 0 && (n - 1) % step !== 0) out.push(Math.round(line[(n - 1) * 2]), Math.round(line[(n - 1) * 2 + 1]));
  return out;
}
