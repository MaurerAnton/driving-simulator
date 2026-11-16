// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The timetables of the trams (timetable.json.gz, made by
 * tools/build-timetable.ts from a GTFS feed) and what the game asks of them:
 * what leaves a stop next (the departure boards), where the trips of a line
 * are at a time of day (so that the trams of the traffic run where and when
 * the timetable says), and which trip a tram standing at a stop belongs to
 * (to tell whether it is on time).
 *
 * Times are seconds after midnight of a service day, local time in Kassel
 * (Europe/Berlin).  As in GTFS, the trips of a day that run after midnight
 * go on counting – 25:10 is ten past one in the night after – so a moment
 * looks at three service days: yesterday's late trips, today's, and
 * tomorrow's first ones, each with its own day type (Monday–Friday,
 * Saturday, Sunday or holiday).
 */
import type { LinesJson, TimetableJson } from '../world/types.ts';

export const DAY = { WEEKDAY: 0, SATURDAY: 1, SUNDAY: 2 } as const;
export type DayType = (typeof DAY)[keyof typeof DAY];

export const DAY_SECONDS = 86400;

/** A moment as the timetable sees it. */
export interface ServiceTime {
  /** seconds after local midnight, 0 … 86 400 */
  s: number;
  /** the day types of today, yesterday and tomorrow */
  day: DayType;
  prev: DayType;
  next: DayType;
}

/** One way the trips of a line run: the same stops at the same intervals. */
export interface TimetablePattern {
  line: TimetableLine;
  /** the stops it calls at, in order, as the tracks name them */
  stops: string[];
  /** the same stops by their place in the line's `stops` in lines.json.gz – where their piece of track and mark are (−1: not known) */
  lineStops: number[];
  /** the departure from each and the arrival at each, seconds after the departure from the first */
  dep: number[];
  arr: number[];
  /** where its trams go (the last stop of the whole trip, which may lie beyond the map) */
  to: string;
  /** its trips come from further back than its first stop / go on beyond its last (off the map's tracks) */
  pre: boolean;
  post: boolean;
  /** when its trips leave the first stop, seconds after midnight of their service day, sorted – by day type */
  starts: [number[], number[], number[]];
}

export interface TimetableLine {
  /** its place in lines.json.gz `lines` */
  index: number;
  ref: string;
  patterns: TimetablePattern[];
}

export interface Timetable {
  /** by their place in lines.json.gz `lines` – undefined where a line has none */
  lines: Array<TimetableLine | undefined>;
  attribution: string;
  /** the days the feed was valid for, and the week the trips were taken from (YYYY-MM-DD) */
  valid: [string, string];
  week: [string, string];
  /** for each stop: the patterns that call there, and where in them */
  calls: Map<string, Array<{ pattern: TimetablePattern; k: number }>>;
}

/** One trip: its pattern, and when it leaves the pattern's first stop. */
export interface TripRef {
  pattern: TimetablePattern;
  /** seconds after midnight of the day asked about (negative for a trip of yesterday's service, past 86 400 for tomorrow's) */
  t0: number;
}

export interface Departure {
  /** the line: its place in lines.json.gz, and its number */
  line: number;
  ref: string;
  /** where it goes */
  to: string;
  /** seconds until it leaves */
  wait: number;
  /** when it leaves, seconds after midnight of the day asked about (past 86 400: after midnight) */
  time: number;
  trip: TripRef;
  /** the stop's place in the trip's pattern */
  k: number;
}

export interface TripState extends TripRef {
  /** the stop it stands at or last left (index into pattern.stops), and the one it runs to next (from + 1; the same at the last) */
  from: number;
  to: number;
  /** how far it is from `from` to `to` by the clock, 0 … 1 (0 while it stands) */
  frac: number;
  /** standing at `from` (between arrival and departure, or before its first departure) */
  standing: boolean;
  /** when it leaves `from` (standing) or arrives at `to` (running), seconds after midnight of the day asked about */
  until: number;
}

export interface ScheduledStop extends TripRef {
  /** the stop's place in the pattern */
  k: number;
  /** when the trip is due to leave there (its arrival, at the end of its way), seconds after midnight of the day asked about */
  time: number;
  /** how late a tram there now is by that: seconds, negative when it is early */
  late: number;
}

/** Reads timetable.json.gz; with the lines (lines.json.gz) given, drops the timetables of lines that do not match (files of different builds). */
export function parseTimetable(json: TimetableJson, lines?: LinesJson): Timetable {
  if (json.version !== 1) throw new Error(`timetable.json: version ${String(json.version)} is not known`);
  const tt: Timetable = { lines: [], attribution: json.attribution, valid: json.valid, week: json.week, calls: new Map() };
  for (const l of json.lines) {
    if (lines && lines.lines[l.line]?.ref !== l.ref) continue;
    const line: TimetableLine = { index: l.line, ref: l.ref, patterns: [] };
    for (const p of l.patterns) {
      const n = Math.min(p.s.length, p.d.length);
      if (n === 0) continue;
      const pattern: TimetablePattern = {
        line,
        stops: p.s.slice(0, n).map((i) => json.stops[i] ?? ''),
        lineStops: Array.from({ length: n }, (_, k) => p.j?.[k] ?? -1),
        dep: p.d.slice(0, n),
        arr: (p.a ?? p.d).slice(0, n),
        to: p.to,
        pre: p.pre === 1,
        post: p.post === 1,
        starts: [sorted(p.t[0]), sorted(p.t[1]), sorted(p.t[2])],
      };
      line.patterns.push(pattern);
      pattern.stops.forEach((name, k) => {
        const list = tt.calls.get(name);
        if (list) list.push({ pattern, k });
        else tt.calls.set(name, [{ pattern, k }]);
      });
    }
    if (line.patterns.length > 0) tt.lines[l.line] = line;
  }
  return tt;
}

function sorted(list: number[] | undefined): number[] {
  return (list ?? []).slice().sort((a, b) => a - b);
}

/** The first place in a sorted list whose value is not below v. */
function lowerBound(list: number[], v: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The three service days a moment touches: how far each one's midnight lies from today's, and its day type. */
function serviceDays(at: ServiceTime): Array<[number, DayType]> {
  return [
    [-DAY_SECONDS, at.prev],
    [0, at.day],
    [DAY_SECONDS, at.next],
  ];
}

/** The next departures from a stop (by its name on the map), all lines, soonest first: at most `n`, within `horizon` seconds. */
export function departures(tt: Timetable, stop: string, at: ServiceTime, n = 4, horizon = 2 * 3600): Departure[] {
  const out: Departure[] = [];
  for (const { pattern: p, k } of tt.calls.get(stop) ?? []) {
    // (where its trips end nobody gets on)
    if (k === p.stops.length - 1 && !p.post) continue;
    for (const [off, day] of serviceDays(at)) {
      const starts = p.starts[day];
      const lo = at.s - off - p.dep[k];
      let found = 0;
      for (let i = lowerBound(starts, lo); i < starts.length && starts[i] <= lo + horizon && found < n; i++, found++) {
        const t0 = starts[i] + off;
        const time = t0 + p.dep[k];
        out.push({ line: p.line.index, ref: p.line.ref, to: p.to, wait: time - at.s, time, trip: { pattern: p, t0 }, k });
      }
    }
  }
  out.sort((a, b) => a.time - b.time || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  if (out.length > n) out.length = n;
  return out;
}

/**
 * The trips of a line (by its place in lines.json.gz) under way at a moment:
 * from their first departure (or `lead` seconds before it, standing at the
 * first stop) until they arrive at their last stop – each with the stop it
 * stands at or last left, the next, and how far between the two it is by
 * the clock.
 */
export function tripsAt(tt: Timetable, line: number, at: ServiceTime, lead = 0): TripState[] {
  const out: TripState[] = [];
  const tl = tt.lines[line];
  if (!tl) return out;
  for (const p of tl.patterns) {
    const last = p.stops.length - 1;
    for (const [off, day] of serviceDays(at)) {
      const starts = p.starts[day];
      // under way: t0 + arr[0] − lead ≤ s ≤ t0 + arr[last]
      const lo = at.s - off - p.arr[last];
      const hi = at.s - off - p.arr[0] + lead;
      for (let i = lowerBound(starts, lo); i < starts.length && starts[i] <= hi; i++) {
        const t0 = starts[i] + off;
        out.push(position(p, t0, at.s - t0));
      }
    }
  }
  return out;
}

/** Where a trip is `e` seconds after it left its first stop. */
function position(p: TimetablePattern, t0: number, e: number): TripState {
  const last = p.stops.length - 1;
  if (e < p.arr[0] || last === 0) return { pattern: p, t0, from: 0, to: Math.min(1, last), frac: 0, standing: true, until: t0 + (e < p.dep[0] ? p.dep[0] : p.arr[last]) };
  // the last stop it has arrived at
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.arr[mid] <= e) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  if (i === last) return { pattern: p, t0, from: last, to: last, frac: 0, standing: true, until: t0 + p.arr[last] };
  if (e < p.dep[i]) return { pattern: p, t0, from: i, to: i + 1, frac: 0, standing: true, until: t0 + p.dep[i] };
  const run = p.arr[i + 1] - p.dep[i];
  const frac = run > 0 ? Math.min(1, Math.max(0, (e - p.dep[i]) / run)) : 1;
  return { pattern: p, t0, from: i, to: i + 1, frac, standing: false, until: t0 + p.arr[i + 1] };
}

/**
 * The trip a tram of a line standing at a stop now belongs to: the scheduled
 * call there nearest to the moment, within `window` seconds either way – an
 * early call counting one and a half times its distance, since trams run
 * late more often than early.  Null if none is that near.
 */
export function scheduledAt(tt: Timetable, line: number, stop: string, at: ServiceTime, window = 600): ScheduledStop | null {
  let best: ScheduledStop | null = null;
  let bestCost = Infinity;
  for (const p of tt.lines[line]?.patterns ?? []) {
    const last = p.stops.length - 1;
    for (let k = 0; k <= last; k++) {
      if (p.stops[k] !== stop) continue;
      // (at the end of its way it does not leave again: its arrival counts)
      const tk = k === last && !p.post ? p.arr[k] : p.dep[k];
      for (const [off, day] of serviceDays(at)) {
        const starts = p.starts[day];
        const lo = at.s - off - tk - window;
        for (let i = lowerBound(starts, lo); i < starts.length && starts[i] <= lo + 2 * window; i++) {
          const t0 = starts[i] + off;
          const late = at.s - (t0 + tk);
          const cost = late >= 0 ? late : -late * 1.5;
          if (cost < bestCost) {
            bestCost = cost;
            best = { pattern: p, t0, k, time: t0 + tk, late };
          }
        }
      }
    }
  }
  return best;
}

// ---- the clock in Kassel ----

/** The day of the month of the last Sunday of a month (0–11) in a year. */
function lastSunday(y: number, month: number): number {
  const end = new Date(Date.UTC(y, month + 1, 0));
  return end.getUTCDate() - end.getUTCDay();
}

/** How many seconds the clocks in Kassel are ahead of UTC at a moment (ms since 1970): 7200 in summer time (from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of October), else 3600. */
export function berlinOffset(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  const start = Date.UTC(y, 2, lastSunday(y, 2), 1);
  const end = Date.UTC(y, 9, lastSunday(y, 9), 1);
  return ms >= start && ms < end ? 7200 : 3600;
}

/** The date and time on the clocks in Kassel at a moment: year, month (1–12), day, weekday (0 Sunday … 6 Saturday), seconds after midnight. */
export function berlinClock(date: Date): { y: number; m: number; d: number; weekday: number; s: number } {
  const ms = date.getTime();
  const local = new Date(ms + berlinOffset(ms) * 1000);
  const s = local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds() + local.getUTCMilliseconds() / 1000;
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate(), weekday: local.getUTCDay(), s };
}

/** Easter Sunday of a year (Gregorian calendar, the anonymous algorithm in Meeus' form): [month 1–12, day]. */
export function easter(y: number): [number, number] {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return [Math.floor(n / 31), (n % 31) + 1];
}

const holidayCache = new Map<number, Set<number>>();

/** The public holidays of Hesse in a year, as month * 100 + day. */
function holidays(y: number): Set<number> {
  let set = holidayCache.get(y);
  if (set) return set;
  const [em, ed] = easter(y);
  const sunday = Date.UTC(y, em - 1, ed);
  const after = (days: number): number => {
    const t = new Date(sunday + days * DAY_SECONDS * 1000);
    return (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
  };
  // New Year, Good Friday, Easter Monday, Labour Day, Ascension, Whit Monday, Corpus Christi, German Unity, Christmas
  set = new Set([101, after(-2), after(1), 501, after(39), after(50), after(60), 1003, 1225, 1226]);
  holidayCache.set(y, set);
  return set;
}

/** Whether a date (month 1–12) is a public holiday in Hesse. */
export function isHoliday(y: number, m: number, d: number): boolean {
  return holidays(y).has(m * 100 + d);
}

/**
 * The day type of a date in Hesse: Sundays and public holidays run the
 * Sunday timetable, Saturdays the Saturday one – and so do Christmas Eve and
 * New Year's Eve when they fall on a working day, the common rule in Germany.
 */
export function dayTypeOf(y: number, m: number, d: number): DayType {
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (weekday === 0 || isHoliday(y, m, d)) return DAY.SUNDAY;
  if (weekday === 6 || (m === 12 && (d === 24 || d === 31))) return DAY.SATURDAY;
  return DAY.WEEKDAY;
}

/** A moment (a JS Date) as the timetable sees it: the time on the clocks in Kassel and the day types around it, holidays included. */
export function serviceTime(date: Date): ServiceTime {
  const c = berlinClock(date);
  const at = Date.UTC(c.y, c.m - 1, c.d);
  const typeAt = (days: number): DayType => {
    const t = new Date(at + days * DAY_SECONDS * 1000);
    return dayTypeOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  };
  return { s: c.s, day: typeAt(0), prev: typeAt(-1), next: typeAt(1) };
}

/** A moment by weekday (0 Sunday … 6 Saturday) and seconds after midnight alone, holidays aside – for a game clock without a date. */
export function weekTime(weekday: number, s: number): ServiceTime {
  const type = (w: number): DayType => {
    const k = ((w % 7) + 7) % 7;
    return k === 0 ? DAY.SUNDAY : k === 6 ? DAY.SATURDAY : DAY.WEEKDAY;
  };
  return { s, day: type(weekday), prev: type(weekday - 1), next: type(weekday + 1) };
}
