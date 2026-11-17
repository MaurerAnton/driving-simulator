// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The timetables of the trams and buses (timetable.json.gz, made by
 * tools/build-timetable.ts from a GTFS feed) and what the game asks of them:
 * what leaves a stop next (the departure boards – trams and buses
 * together), where the trips of a line are at a time of day (so that the
 * trams and buses of the traffic run where and when the timetable says, and
 * the map can show every one under way), and which trip a vehicle standing
 * at a stop belongs to (to tell whether it is on time).
 *
 * A tram's line is named by its place in lines.json.gz, a bus's by its place
 * in buslines.json.gz; a stop by its name, or by its stop place (its number
 * in stops.json.gz) – names repeat from town to town ("Rathaus", "Bahnhof"),
 * places do not.
 *
 * Times are seconds after midnight of a service day, local time in Kassel
 * (Europe/Berlin).  As in GTFS, the trips of a day that run after midnight
 * go on counting – 25:10 is ten past one in the night after – so a moment
 * looks at three service days: yesterday's late trips, today's, and
 * tomorrow's first ones, each with its own day type (Monday–Friday,
 * Saturday, Sunday or holiday).
 */
import type { LinesJson, TimetableJson } from '../world/types.ts';

/** The newest version of timetable.json.gz this reads (1: the trams alone; 2: with the buses, the lines' colours and the stop places of the trams' stops). */
export const TIMETABLE_VERSION = 2;

export const DAY = { WEEKDAY: 0, SATURDAY: 1, SUNDAY: 2 } as const;
export type DayType = (typeof DAY)[keyof typeof DAY];

export const DAY_SECONDS = 86400;

/** What runs a line: 'tram' – a line of lines.json.gz (the trams and RegioTrams), 'bus' – a line of buslines.json.gz. */
export type TransitKind = 'tram' | 'bus';

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
  /** the stops it calls at, in order, by name: as the tracks name them (a tram), as its stop place is named (a bus) */
  stops: string[];
  /**
   * the same stops by their place in the line's stops – a tram's in
   * lines.json.gz `stops` (where their piece of track and mark are), a bus's
   * in BusLines `stops` (src/world/buslines.ts: where on the line's ways) –
   * −1: not known
   */
  lineStops: number[];
  /** the same stops as stop places: their number in stops.json.gz (−1 where not known – a tram's stop in a file without them) */
  places: number[];
  /** the departure from each and the arrival at each, seconds after the departure from the first */
  dep: number[];
  arr: number[];
  /** where its trips go, as shown at its first stop (a tram's: the last stop of the whole trip, which may lie beyond the map) */
  to: string;
  /** where they go as shown at each of its stops – a bus may change it on the way (a loop names its far end, then where it ends) */
  dests: string[];
  /** its trips come from further back than its first stop / go on beyond its last (beyond the line's stops on the map) */
  pre: boolean;
  post: boolean;
  /** when its trips leave the first stop, seconds after midnight of their service day, sorted – by day type */
  starts: [number[], number[], number[]];
}

export interface TimetableLine {
  kind: TransitKind;
  /** its place in lines.json.gz `lines` (a tram) or in buslines.json.gz `lines` (a bus) */
  index: number;
  ref: string;
  /** its colour ("#00954B", or a name OpenStreetMap uses: "red") – OpenStreetMap's, else the feed's; '' where neither has one */
  colour: string;
  patterns: TimetablePattern[];
}

/** A pattern calling at a stop, and where in it (index into its `stops`). */
export interface StopCall {
  pattern: TimetablePattern;
  k: number;
}

export interface Timetable {
  /** the trams' lines, by their place in lines.json.gz `lines` – undefined where a line has none */
  lines: Array<TimetableLine | undefined>;
  /** the buses' lines, by their place in buslines.json.gz `lines` – undefined where a line has none (every one, in a file without buses) */
  buses: Array<TimetableLine | undefined>;
  attribution: string;
  /** the days the feed was valid for, and the week the trips were taken from (YYYY-MM-DD) */
  valid: [string, string];
  week: [string, string];
  /**
   * for each stop name: the patterns that call there, and where in them –
   * the trams' stops of that name, and the buses' stop places of that name
   * (where trams call under the name, only the places that are their stop:
   * the buses at the Rathaus of another town are not here)
   */
  calls: Map<string, StopCall[]>;
  /** for each stop place (its number in stops.json.gz): the patterns of the buses and trams that call there */
  placeCalls: Map<number, StopCall[]>;
  /** the bus lines the buses' timetables belong to: their build (buslines.json.gz `map`) and how many stop places they count on – '' and 0 without buses */
  busMap: string;
  busPlaces: number;
}

/** One trip: its pattern, and when it leaves the pattern's first stop. */
export interface TripRef {
  pattern: TimetablePattern;
  /** seconds after midnight of the day asked about (negative for a trip of yesterday's service, past 86 400 for tomorrow's) */
  t0: number;
}

export interface Departure {
  /** a tram or a bus */
  kind: TransitKind;
  /** the line: its place in lines.json.gz (a tram) or buslines.json.gz (a bus), its number and colour ('' where it has none) */
  line: number;
  ref: string;
  colour: string;
  /** where it goes */
  to: string;
  /** seconds until it leaves */
  wait: number;
  /** when it leaves, seconds after midnight of the day asked about (past 86 400: after midnight) */
  time: number;
  trip: TripRef;
  /** the stop's place in the trip's pattern */
  k: number;
  /** the stop place it leaves from (its number in stops.json.gz; −1 where not known) */
  place: number;
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

/** A trip under way, with all a map needs to show it: what it is, where it goes, and where between which two stops it is. */
export interface Running extends TripState {
  kind: TransitKind;
  /** its line: the place in lines.json.gz (a tram) or buslines.json.gz (a bus), the number and the colour ('' where none) */
  line: number;
  ref: string;
  colour: string;
  /** where it goes, as its front says now */
  dest: string;
  /**
   * the stop it stands at or last left and the one it runs to next (its
   * `from` and `to`; `frac` is how far it is between them) by their place in
   * the line's stops: lines.json.gz `stops` of a tram (piece of track,
   * mark), BusLines `stops` of a bus (way, metres along it) – −1 where not
   * known – and by name and stop place (−1 where not known)
   */
  fromStop: number;
  toStop: number;
  fromName: string;
  toName: string;
  fromPlace: number;
  toPlace: number;
}

export interface ScheduledStop extends TripRef {
  /** the stop's place in the pattern */
  k: number;
  /** when the trip is due to leave there (its arrival, at the end of its way), seconds after midnight of the day asked about */
  time: number;
  /** how late a vehicle there now is by that: seconds, negative when it is early */
  late: number;
}

/** What parseTimetable needs of the bus lines (BusLinesJson, or BusLines of src/world/buslines.ts) to see that the timetables belong to them. */
export interface BusLinesRef {
  lines: ReadonlyArray<{ ref: string; osm?: number }>;
}

/**
 * Reads timetable.json.gz (version 1 or 2).  With the lines given
 * (lines.json.gz), drops the timetables of tram lines that do not match;
 * with the bus lines given (buslines.json.gz, or BusLines), those of bus
 * lines that do not match – files of different builds.
 */
export function parseTimetable(json: TimetableJson, lines?: LinesJson, buslines?: BusLinesRef): Timetable {
  if (!Number.isInteger(json.version) || json.version < 1 || json.version > TIMETABLE_VERSION) throw new Error(`timetable.json: version ${String(json.version)} is not known`);
  const tt: Timetable = { lines: [], buses: [], attribution: json.attribution, valid: json.valid, week: json.week, calls: new Map(), placeCalls: new Map(), busMap: '', busPlaces: 0 };
  const add = <K>(map: Map<K, StopCall[]>, key: K, call: StopCall): void => {
    const list = map.get(key);
    if (list) list.push(call);
    else map.set(key, [call]);
  };
  // the stop places of the trams' stops, by name (a file of version 1 has none)
  const tramPlaces = new Map<string, number[]>();
  json.stops.forEach((name, i) => {
    const places = json.stopPlaces?.[i];
    if (places && places.length > 0) tramPlaces.set(name, [...(tramPlaces.get(name) ?? []), ...places]);
  });

  for (const l of json.lines) {
    if (lines && lines.lines[l.line]?.ref !== l.ref) continue;
    const line: TimetableLine = { kind: 'tram', index: l.line, ref: l.ref, colour: l.colour ?? '', patterns: [] };
    for (const p of l.patterns) {
      const n = Math.min(p.s.length, p.d.length);
      if (n === 0) continue;
      const stops = p.s.slice(0, n).map((i) => json.stops[i] ?? '');
      const pattern: TimetablePattern = {
        line,
        stops,
        lineStops: Array.from({ length: n }, (_, k) => p.j?.[k] ?? -1),
        places: p.s.slice(0, n).map((i) => json.stopPlaces?.[i]?.[0] ?? -1),
        dep: p.d.slice(0, n),
        arr: (p.a ?? p.d).slice(0, n),
        to: p.to,
        dests: stops.map(() => p.to),
        pre: p.pre === 1,
        post: p.post === 1,
        starts: [sorted(p.t[0]), sorted(p.t[1]), sorted(p.t[2])],
      };
      line.patterns.push(pattern);
      stops.forEach((name, k) => {
        add(tt.calls, name, { pattern, k });
        for (const place of tramPlaces.get(name) ?? []) add(tt.placeCalls, place, { pattern, k });
      });
    }
    if (line.patterns.length > 0) tt.lines[l.line] = line;
  }

  const bus = json.version >= 2 ? json.bus : undefined;
  if (bus) {
    tt.busMap = bus.map ?? '';
    tt.busPlaces = bus.places ?? 0;
    const names = new Map<number, string>(bus.stops ?? []);
    for (const l of bus.lines ?? []) {
      const known = buslines?.lines[l.line];
      if (buslines && (!known || known.ref !== l.ref || (known.osm !== undefined && known.osm !== l.osm))) continue;
      const line: TimetableLine = { kind: 'bus', index: l.line, ref: l.ref, colour: l.colour ?? '', patterns: [] };
      for (const p of l.patterns) {
        const n = Math.min(p.j.length, p.d.length);
        if (n === 0) continue;
        const lineStops = counted(p.j, n);
        const places = lineStops.map((j) => l.s?.[j] ?? -1);
        const dep = counted(p.d, n);
        const dests = destinations(p.to, bus.dests ?? [], n);
        const pattern: TimetablePattern = {
          line,
          stops: places.map((place) => names.get(place) ?? ''),
          lineStops,
          places,
          dep,
          arr: dep.map((v, k) => v - (p.w?.[k] ?? 0)),
          to: dests[0],
          dests,
          pre: p.pre === 1,
          post: p.post === 1,
          starts: [sorted(counted(p.t[0])), sorted(counted(p.t[1])), sorted(counted(p.t[2]))],
        };
        line.patterns.push(pattern);
        pattern.places.forEach((place, k) => {
          if (place < 0) return;
          add(tt.placeCalls, place, { pattern, k });
          // (by its name only where that is the trams' stop of the name, or the name is no tram stop's)
          const name = pattern.stops[k];
          const own = tramPlaces.get(name);
          if (name && (!own || own.includes(place))) add(tt.calls, name, { pattern, k });
        });
      }
      if (line.patterns.length > 0) tt.buses[l.line] = line;
    }
  }
  return tt;
}

function sorted(list: number[] | undefined): number[] {
  return (list ?? []).slice().sort((a, b) => a - b);
}

/** A list kept as steps (the first as it is) counted up again – its first `n` (all, without n). */
function counted(steps: number[] | undefined, n = steps?.length ?? 0): number[] {
  const out: number[] = [];
  let v = 0;
  for (let k = 0; k < n; k++) {
    v = k === 0 ? (steps?.[0] ?? 0) : v + (steps?.[k] ?? 0);
    out.push(v);
  }
  return out;
}

/** Where a bus pattern goes as shown at each of its `n` stops, from the file's [k, index into dests] pairs. */
function destinations(to: number[] | undefined, dests: string[], n: number): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  for (let k = 0; k < n; k++) {
    while (to && i + 1 < to.length && to[i] <= k) {
      cur = dests[to[i + 1]] ?? cur;
      i += 2;
    }
    out.push(cur);
  }
  return out;
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

/**
 * The next departures from a stop, all lines – trams and buses – soonest
 * first: at most `n`, within `horizon` seconds.  The stop is a stop place
 * (its number in stops.json.gz: the buses that call there and the trams of
 * the tram stop it is) or a name (the trams' stop of that name, and the
 * buses' stop places of that name – where no tram stop has the name, those
 * of every town: ask by place to have one town's).
 */
export function departures(tt: Timetable, stop: string | number, at: ServiceTime, n = 4, horizon = 2 * 3600): Departure[] {
  const out: Departure[] = [];
  const calls = typeof stop === 'number' ? tt.placeCalls.get(stop) : tt.calls.get(stop);
  for (const { pattern: p, k } of calls ?? []) {
    // (where its trips end nobody gets on)
    if (k === p.stops.length - 1 && !p.post) continue;
    for (const [off, day] of serviceDays(at)) {
      const starts = p.starts[day];
      const lo = at.s - off - p.dep[k];
      let found = 0;
      for (let i = lowerBound(starts, lo); i < starts.length && starts[i] <= lo + horizon && found < n; i++, found++) {
        const t0 = starts[i] + off;
        const time = t0 + p.dep[k];
        const l = p.line;
        out.push({ kind: l.kind, line: l.index, ref: l.ref, colour: l.colour, to: p.dests[k] ?? p.to, wait: time - at.s, time, trip: { pattern: p, t0 }, k, place: p.places[k] ?? -1 });
      }
    }
  }
  out.sort((a, b) => a.time - b.time || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0) || (a.kind === b.kind ? 0 : a.kind === 'tram' ? -1 : 1));
  if (out.length > n) out.length = n;
  return out;
}

/** The trips of a line under way at a moment (see tripsAt). */
function lineTrips(tl: TimetableLine | undefined, at: ServiceTime, lead: number, out: TripState[] = []): TripState[] {
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

/**
 * The trips of a tram line (by its place in lines.json.gz) under way at a
 * moment: from their first departure (or `lead` seconds before it, standing
 * at the first stop) until they arrive at their last stop – each with the
 * stop it stands at or last left, the next, and how far between the two it
 * is by the clock.
 */
export function tripsAt(tt: Timetable, line: number, at: ServiceTime, lead = 0): TripState[] {
  return lineTrips(tt.lines[line], at, lead);
}

/** The same for a bus line (by its place in buslines.json.gz): its trips under way, where `pattern.lineStops` names the stops by their place in BusLines `stops`. */
export function busTripsAt(tt: Timetable, line: number, at: ServiceTime, lead = 0): TripState[] {
  return lineTrips(tt.buses[line], at, lead);
}

/**
 * Every trip under way at a moment, trams and buses – each with its line,
 * number, colour and destination, and where it is: between which two of
 * its line's stops, and how far from the one to the other (`frac`) – for a
 * map that shows them all.  `lead` as in tripsAt.
 */
export function runningAt(tt: Timetable, at: ServiceTime, lead = 0): Running[] {
  const out: Running[] = [];
  const trips: TripState[] = [];
  for (const list of [tt.lines, tt.buses]) {
    for (const tl of list) {
      if (!tl) continue;
      trips.length = 0;
      for (const t of lineTrips(tl, at, lead, trips)) {
        const p = t.pattern;
        out.push({
          ...t,
          kind: tl.kind,
          line: tl.index,
          ref: tl.ref,
          colour: tl.colour,
          dest: p.dests[t.from] ?? p.to,
          fromStop: p.lineStops[t.from] ?? -1,
          toStop: p.lineStops[t.to] ?? -1,
          fromName: p.stops[t.from] ?? '',
          toName: p.stops[t.to] ?? '',
          fromPlace: p.places[t.from] ?? -1,
          toPlace: p.places[t.to] ?? -1,
        });
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

/** The scheduled call of a line's trips at the stops `here` picks nearest to the moment (see scheduledAt). */
function scheduledOn(tl: TimetableLine | undefined, here: (p: TimetablePattern, k: number) => boolean, at: ServiceTime, window: number): ScheduledStop | null {
  let best: ScheduledStop | null = null;
  let bestCost = Infinity;
  for (const p of tl?.patterns ?? []) {
    const last = p.stops.length - 1;
    for (let k = 0; k <= last; k++) {
      if (!here(p, k)) continue;
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

/**
 * The trip a tram of a line standing at a stop now belongs to: the scheduled
 * call there nearest to the moment, within `window` seconds either way – an
 * early call counting one and a half times its distance, since trams run
 * late more often than early.  Null if none is that near.
 */
export function scheduledAt(tt: Timetable, line: number, stop: string, at: ServiceTime, window = 600): ScheduledStop | null {
  return scheduledOn(tt.lines[line], (p, k) => p.stops[k] === stop, at, window);
}

/** The same for a bus of a bus line (by its place in buslines.json.gz) standing at a stop place (its number in stops.json.gz). */
export function busScheduledAt(tt: Timetable, line: number, place: number, at: ServiceTime, window = 600): ScheduledStop | null {
  return scheduledOn(tt.buses[line], (p, k) => p.places[k] === place, at, window);
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
