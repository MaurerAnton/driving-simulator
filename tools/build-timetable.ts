// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The timetables of the trams: when the trips of each line of the map
 * (lines.json.gz) leave and how long they take from stop to stop – from a
 * GTFS feed, the form in which public transport publishes its timetables –
 * so that the trams of the game keep to their real times and the departure
 * boards at the stops show them.
 *
 *   node --max-old-space-size=1536 tools/build-timetable.ts [feed.zip …]
 *
 * Without a feed it fetches the current ones of gtfs.de into data/raw/gtfs/,
 * each into a folder of its own: local transport, which has the trams of
 * the KVG, and regional rail, which has the RegioTrams (the two come from
 * the national timetable data of DELFI, under CC BY 4.0).  Nothing is
 * unpacked – stop_times.txt is two gigabytes for the whole of Germany: it
 * is streamed out of the zip (`unzip -p`) and only the rows of the trips
 * wanted are kept.  A folder holding a feed's .txt files works as well.
 *
 * Reads lines.json.gz, rails.json.gz and stops.json.gz of the map (MAP_OUT,
 * default public/map) and writes timetable.json.gz there (TimetableJson in
 * src/world/types.ts).  Settings by environment: GTFS_AGENCY (the operators
 * to take, a regular expression – by default the KVG, the RegioTram and the
 * NVV), GTFS_WEEK (the Monday of the week to take, YYYY-MM-DD) and
 * GTFS_ATTRIBUTION (the credit, for a feed this tool does not know).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DAY, dayTypeOf } from '../src/sim/timetable.ts';
import type { LinesJson, RailJson, StopsJson, TimetableJson, TimetableLineJson, TimetablePatternJson } from '../src/world/types.ts';

// ---------------------------------------------------------------------------
// Reading a feed: CSV, and where its files come from
// ---------------------------------------------------------------------------

/** One line of a CSV file split into its fields (quotes around a field, "" for a quote inside one). */
export function splitCsv(line: string): string[] {
  if (line.indexOf('"') < 0) return line.split(',');
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c !== '"') cur += c;
      else if (line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** "25:10:00" → seconds after midnight of the service day (past 86 400 after midnight); NaN where empty. */
export function parseTime(s: string): number {
  const m = /^\s*(\d+):(\d\d)(?::(\d\d))?\s*$/.exec(s);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + (m[3] ? Number(m[3]) : 0) : NaN;
}

/** Where the files of a feed come from: a zip, a folder, or text in memory (the tests). */
export interface FeedSource {
  label: string;
  has(file: string): boolean;
  /** the bytes of one of its files, as they come */
  bytes(file: string): AsyncIterable<Uint8Array>;
}

/** A zip, read with `unzip` – listed, and each file streamed out of it, never unpacked onto the disk. */
export function zipSource(path: string): FeedSource {
  const names = execFileSync('unzip', ['-Z1', path], { maxBuffer: 1 << 24 }).toString('utf8').split('\n');
  // (some feeds keep their files in a folder inside the zip)
  const entry = new Map<string, string>();
  for (const n of names.map((s) => s.trim()).filter((s) => s && !s.endsWith('/'))) {
    const base = n.split('/').pop() ?? n;
    if (!entry.has(base) || !n.includes('/')) entry.set(base, n);
  }
  return {
    label: basename(path),
    has: (file) => entry.has(file),
    bytes: (file) => spawn('unzip', ['-p', path, entry.get(file) ?? file], { stdio: ['ignore', 'pipe', 'inherit'] }).stdout as Readable,
  };
}

/** A folder holding the .txt files of a feed. */
export function dirSource(path: string): FeedSource {
  const files = new Set(readdirSync(path));
  return { label: basename(path), has: (file) => files.has(file), bytes: (file) => createReadStream(resolve(path, file)) };
}

/** A feed given as text (for the tests). */
export function memorySource(label: string, files: Record<string, string>): FeedSource {
  return {
    label,
    has: (file) => file in files,
    async *bytes(file) {
      yield Buffer.from(files[file] ?? '', 'utf8');
    },
  };
}

async function* textLines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const rl = createInterface({ input: Readable.from(chunks), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

/** The rows of a table of a feed, by column name, fields trimmed – those `keep` accepts; none where the feed lacks the file. */
export async function readTable(src: FeedSource, file: string, keep?: (row: Record<string, string>) => boolean): Promise<Array<Record<string, string>>> {
  const rows: Array<Record<string, string>> = [];
  if (!src.has(file)) return rows;
  let head: string[] | null = null;
  for await (const line of textLines(src.bytes(file))) {
    if (!head) {
      head = splitCsv(line.replace(/^\uFEFF/, '')).map((h) => h.trim());
      continue;
    }
    if (line.trim() === '') continue;
    const v = splitCsv(line);
    const row: Record<string, string> = {};
    for (let i = 0; i < head.length; i++) row[head[i]] = (v[i] ?? '').trim();
    if (!keep || keep(row)) rows.push(row);
  }
  return rows;
}

/**
 * The rows of a big table whose `column` holds one of the wanted keys.  It
 * is read as bytes, and a line only becomes a string when the hash of its
 * key is one of the wanted ones: stop_times.txt of all of Germany has some
 * 35 million lines, of which a few thousand are wanted.
 */
export async function scanTable(src: FeedSource, file: string, column: string, wanted: Set<string>, row: (fields: string[], head: string[]) => void): Promise<number> {
  if (!src.has(file)) return 0;
  const hash = (b: Uint8Array, s: number, e: number): number => {
    let h = 0x811c9dc5;
    for (let i = s; i < e; i++) h = Math.imul(h ^ b[i], 0x01000193);
    return h >>> 0;
  };
  const hashes = new Set<number>();
  for (const k of wanted) {
    const b = Buffer.from(k, 'utf8');
    hashes.add(hash(b, 0, b.length));
  }
  const decoder = new TextDecoder('utf-8');
  let head: string[] | null = null;
  let col = -1;
  let lines = 0;
  let rest: Uint8Array | null = null;
  const take = (b: Uint8Array, s: number, e: number): void => {
    if (e > s && b[e - 1] === 13) e--;
    if (e <= s) return;
    if (!head) {
      head = splitCsv(decoder.decode(b.subarray(s, e)).replace(/^\uFEFF/, '')).map((h) => h.trim());
      col = head.indexOf(column);
      if (col < 0) throw new Error(`${file} has no column ${column}`);
      return;
    }
    lines++;
    // the key: the col-th field (a quote before it, or around it: read the line properly)
    let fs = s;
    for (let c = 0; c < col; c++) {
      while (fs < e && b[fs] !== 44 && b[fs] !== 34) fs++;
      if (fs >= e || b[fs] === 34) {
        fs = -1;
        break;
      }
      fs++;
    }
    if (fs >= 0 && b[fs] !== 34) {
      let fe = fs;
      while (fe < e && b[fe] !== 44) fe++;
      let ks = fs;
      let ke = fe;
      while (ks < ke && b[ks] === 32) ks++;
      while (ke > ks && b[ke - 1] === 32) ke--;
      if (!hashes.has(hash(b, ks, ke))) return;
    }
    const fields = splitCsv(decoder.decode(b.subarray(s, e)));
    if (wanted.has((fields[col] ?? '').trim())) row(fields, head);
  };
  const join = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const j = new Uint8Array(a.length + b.length);
    j.set(a);
    j.set(b, a.length);
    return j;
  };
  for await (const chunk of src.bytes(file)) {
    let s = 0;
    if (rest) {
      // (the line the last chunk ended in)
      const nl = chunk.indexOf(10);
      if (nl < 0) {
        rest = join(rest, chunk);
        continue;
      }
      const line = join(rest, chunk.subarray(0, nl));
      rest = null;
      take(line, 0, line.length);
      s = nl + 1;
    }
    for (let i = chunk.indexOf(10, s); i >= 0; i = chunk.indexOf(10, s)) {
      take(chunk, s, i);
      s = i + 1;
    }
    if (s < chunk.length) rest = chunk.slice(s);
  }
  if (rest) take(rest, 0, rest.length);
  return lines;
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** A date as a number, 20261118; these turn it into days since 1970 and back, and name its weekday (0 Sunday … 6 Saturday). */
const dayMs = (d: number): number => Date.UTC(Math.floor(d / 10000), (Math.floor(d / 100) % 100) - 1, d % 100);
const fromMs = (ms: number): number => {
  const t = new Date(ms);
  return t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
};
export const addDays = (d: number, n: number): number => fromMs(dayMs(d) + n * 86400000);
export const weekdayOf = (d: number): number => new Date(dayMs(d)).getUTCDay();
export const isoDate = (d: number): string => (d > 0 ? `${Math.floor(d / 10000)}-${String(Math.floor(d / 100) % 100).padStart(2, '0')}-${String(d % 100).padStart(2, '0')}` : '');
export const dateOf = (iso: string): number => Number(iso.replace(/-/g, ''));
const typeOf = (d: number): number => dayTypeOf(Math.floor(d / 10000), Math.floor(d / 100) % 100, d % 100);

/** When a service runs: weekdays (bit 0 Monday … 6 Sunday) between two dates, and the dates added and taken away. */
export interface Service {
  days: number;
  start: number;
  end: number;
  add: Set<number>;
  remove: Set<number>;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** The services of a feed, from calendar.txt and calendar_dates.txt. */
export function readServices(calendar: Array<Record<string, string>>, dates: Array<Record<string, string>>): Map<string, Service> {
  const services = new Map<string, Service>();
  for (const c of calendar) {
    let days = 0;
    WEEKDAYS.forEach((w, i) => (days |= c[w] === '1' ? 1 << i : 0));
    services.set(c.service_id, { days, start: Number(c.start_date), end: Number(c.end_date), add: new Set(), remove: new Set() });
  }
  for (const d of dates) {
    let s = services.get(d.service_id);
    if (!s) services.set(d.service_id, (s = { days: 0, start: 0, end: 0, add: new Set(), remove: new Set() }));
    (d.exception_type === '2' ? s.remove : s.add).add(Number(d.date));
  }
  return services;
}

/** Whether a service runs on a date. */
export function serviceRuns(s: Service | undefined, date: number): boolean {
  if (!s || s.remove.has(date)) return false;
  if (s.add.has(date)) return true;
  if (date < s.start || date > s.end) return false;
  const w = weekdayOf(date);
  return ((s.days >> (w === 0 ? 6 : w - 1)) & 1) === 1;
}

/**
 * The week to take the timetable from, and its days for the three day
 * types (its Wednesday, Saturday and Sunday): a whole week from Monday to
 * Sunday inside the days the feed is valid for, without a public holiday –
 * and of those the most ordinary one: the one whose days look like those of
 * the most other weeks (`describe` tells what a day looks like: how many
 * trips of each line run, and on how many lines).  Not the busiest: a
 * building site that splits a line doubles its trips for weeks, and the
 * school holidays drop a line.  Where that does not decide, the week with
 * the most lines on its Wednesday, then the earliest.
 */
export function chooseWeek(valid: [number, number], describe: (date: number) => { sig: string; lines: number }, monday?: number): { week: [number, number]; days: [number, number, number]; note: string } {
  const pick = (mon: number, note: string): { week: [number, number]; days: [number, number, number]; note: string } => ({ week: [mon, addDays(mon, 6)], days: [addDays(mon, 2), addDays(mon, 5), addDays(mon, 6)], note });
  if (monday !== undefined) {
    while (weekdayOf(monday) !== 1) monday = addDays(monday, -1);
    return pick(monday, monday < valid[0] || addDays(monday, 6) > valid[1] ? 'as asked (GTFS_WEEK) – NOT inside the days the feed is valid for' : 'as asked (GTFS_WEEK)');
  }
  if (!(valid[0] > 0 && valid[0] <= valid[1])) return { week: [0, 0], days: [0, 0, 0], note: 'the feeds are not valid for any day in common' };
  let first = valid[0];
  while (weekdayOf(first) !== 1) first = addDays(first, 1);
  const weeks: number[] = [];
  for (let mon = first; addDays(mon, 6) <= valid[1]; mon = addDays(mon, 7)) weeks.push(mon);
  const ordinary = (mon: number): boolean => [0, 1, 2, 3, 4, 5, 6].every((k) => typeOf(addDays(mon, k)) === (k < 5 ? DAY.WEEKDAY : k === 5 ? DAY.SATURDAY : DAY.SUNDAY));
  const best = (list: number[]): number => {
    const sig = new Map(list.map((mon) => [mon, [2, 5, 6].map((k) => describe(addDays(mon, k)).sig).join('|')]));
    const alike = new Map<string, number>();
    for (const s of sig.values()) alike.set(s, (alike.get(s) ?? 0) + 1);
    let b = list[0];
    let score = -1;
    for (const mon of list) {
      const s = (alike.get(sig.get(mon) ?? '') ?? 0) * 1000 + describe(addDays(mon, 2)).lines;
      if (s > score) {
        score = s;
        b = mon;
      }
    }
    return b;
  };
  const plain = weeks.filter(ordinary);
  if (plain.length > 0) return pick(best(plain), '');
  if (weeks.length > 0) return pick(best(weeks), 'every whole week of the feed has a holiday');
  // (a feed shorter than a week: each day type from the first day of its kind)
  const find = (type: number, prefer: number): number => {
    let found = 0;
    for (let d = valid[0]; d <= valid[1]; d = addDays(d, 1)) {
      if (typeOf(d) !== type) continue;
      if (weekdayOf(d) === prefer) return d;
      if (!found) found = d;
    }
    return found;
  };
  const days: [number, number, number] = [find(DAY.WEEKDAY, 3), find(DAY.SATURDAY, 6), find(DAY.SUNDAY, 0)];
  const used = days.filter((d) => d > 0);
  return { week: [Math.min(...used, valid[0]), Math.max(...used, valid[0])], days, note: 'the feed holds no whole week' };
}

// ---------------------------------------------------------------------------
// Names of stops: the feed's and the map's differ in detail
// ---------------------------------------------------------------------------

/**
 * A stop name reduced to what tells it apart: lower case, umlauts and ß
 * spelt out, the usual abbreviations written in full, punctuation gone
 * (a slash, which joins two names of one stop, is kept).
 */
export function normName(s: string): string {
  let t = s
    .normalize('NFC')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  const end = '(?=$|[\\s/,.()-])';
  t = t
    .replace(new RegExp(`([a-z])str\\.?${end}`, 'g'), '$1strasse')
    .replace(new RegExp(`\\bstr\\.?${end}`, 'g'), 'strasse')
    .replace(new RegExp(`([a-z])pl\\.${end}`, 'g'), '$1platz')
    .replace(new RegExp(`\\bpl\\.${end}`, 'g'), 'platz')
    .replace(new RegExp(`\\bhbf\\.?${end}`, 'g'), 'hauptbahnhof')
    .replace(new RegExp(`\\b(bf|bhf)\\.?${end}`, 'g'), 'bahnhof')
    .replace(/\bst\.\s/g, 'sankt ');
  return t
    .replace(/[^\p{L}\p{N}/]+/gu, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .trim();
}

/** Words that alone do not tell two stops apart. */
const GENERIC = new Set(['bahnhof', 'mitte', 'stadtmitte', 'zentrum', 'kirche', 'schule', 'rathaus', 'markt', 'marktplatz', 'friedhof', 'post', 'nord', 'sued', 'ost', 'west', 'platz', 'strasse', 'center']);

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length];
}

/**
 * How alike a stop name of the feed and one of the map are, 0 … 1.  The
 * feed puts the town (and the part of it) in front – "Kassel Königsplatz",
 * "Baunatal-Großenritte Bahnhof" – where the map mostly has the bare name;
 * one of them may give a second name after a slash ("Halitplatz/Philipp-
 * Scheidemann-Haus"), or spell it a little differently ("Mattenbergsiedlung"
 * and "Mattenberg Siedlung").  1: the same name; 0.99: the same once the
 * town in front of one of them is taken away; 0.95: one of the names of a
 * stop with two; 0.9: the same name behind a part of the town; 0.85: all
 * words of the shorter in the longer; 0.8: nearly the same letters; 0.75:
 * the same name of a stop in another part of the same town.
 *
 * The town is only ever taken from one of the two: "Vellmar Stadtmitte"
 * and "Hessisch Lichtenau Stadtmitte" are not the same stop.
 */
export function nameMatcher(towns: string[]): (a: string, b: string) => number {
  const townForms = [...new Set(towns.map(normName).filter((t) => t.length > 0))].sort((x, y) => y.length - x.length);
  const cache = new Map<string, number>();
  // a name in its forms: as it is, and without the town in front (where it has one)
  const forms = (s: string): string[] => {
    const n = normName(s);
    for (const t of townForms) if (n.startsWith(`${t} `) && n.length > t.length + 1) return [n, n.slice(t.length + 1)];
    return [n];
  };
  const compact = (s: string): string => s.replace(/[\s/]/g, '');
  const words = (s: string): string[] => s.split(/[\s/]+/).filter((w) => w.length > 0);
  const score = (a: string, b: string): number => {
    const A = forms(a);
    const B = forms(b);
    // (a stop without a name is like no other)
    if (!A[0] || !B[0]) return 0;
    if (compact(A[0]) === compact(B[0])) return 1;
    let best = 0;
    for (let i = 0; i < A.length; i++) {
      for (let j = 0; j < B.length; j++) {
        if (i > 0 && j > 0) continue;
        const x = A[i];
        const y = B[j];
        const cx = compact(x);
        const cy = compact(y);
        if (cx === cy) return 0.99;
        const xs = x.split('/').map(compact);
        const ys = y.split('/').map(compact);
        if ((xs.length > 1 && xs.includes(cy)) || (ys.length > 1 && ys.includes(cx))) best = Math.max(best, 0.95);
        else if (xs.length > 1 && ys.length > 1 && xs.some((p) => p.length >= 5 && ys.includes(p))) best = Math.max(best, 0.9);
        if (Math.min(cx.length, cy.length) >= 6 && editDistance(cx, cy) <= Math.max(1, Math.floor(Math.max(cx.length, cy.length) * 0.12))) best = Math.max(best, 0.8);
      }
    }
    // the words of the whole names (with their towns: "Vellmar Stadtmitte" ends as "Stadtmitte" does, and is still not the one in Hessisch Lichtenau)
    const aw = words(A[0]);
    const bw = words(B[0]);
    const [short, long] = aw.length <= bw.length ? [aw, bw] : [bw, aw];
    const tail = long.slice(long.length - short.length);
    // (behind a part of the town: "Triftstraße", "VW-Werk" – but every town has its "Stadtmitte")
    if (short.length > 0 && long.length - short.length <= 2 && short.join('').length >= 5 && !(short.length === 1 && GENERIC.has(short[0])) && short.every((w, k) => w === tail[k])) best = Math.max(best, 0.9);
    else if (short.length >= 2 && short.every((w) => long.includes(w))) best = Math.max(best, 0.85);
    // "Kaufungen-Papierfabrik Industriestraße" and "Kaufungen-Niederkaufungen Industriestraße": the town and the name the same, the part of the town not
    const last = aw[aw.length - 1];
    if (best < 0.75 && A.length > 1 && B.length > 1 && aw[0] === bw[0] && aw.length >= 3 && bw.length >= 3 && last === bw[bw.length - 1] && last.length >= 8 && !GENERIC.has(last)) best = 0.75;
    return best;
  };
  return (a: string, b: string): number => {
    const key = `${a}\u0000${b}`;
    let v = cache.get(key);
    if (v === undefined) cache.set(key, (v = score(a, b)));
    return v;
  };
}

/**
 * The best pairing of two lists of names that keeps both in order (the
 * longest common subsequence, weighted by how alike the paired names are,
 * pairs below `min` not counted): the pairs [i, j, likeness] and their sum.
 */
export function align(a: string[], b: string[], sim: (x: string, y: string) => number, min = 0.75): { score: number; pairs: Array<[number, number, number]> } {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const S = new Float64Array((n + 1) * w);
  const L = new Float64Array(n * m);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = sim(a[i - 1], b[j - 1]);
      L[(i - 1) * m + j - 1] = s;
      let v = Math.max(S[(i - 1) * w + j], S[i * w + j - 1]);
      if (s >= min) v = Math.max(v, S[(i - 1) * w + j - 1] + s);
      S[i * w + j] = v;
    }
  }
  const pairs: Array<[number, number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const s = L[(i - 1) * m + j - 1];
    if (s >= min && S[i * w + j] === S[(i - 1) * w + j - 1] + s) {
      pairs.push([i - 1, j - 1, s]);
      i--;
      j--;
    } else if (S[i * w + j] === S[(i - 1) * w + j]) i--;
    else j--;
  }
  pairs.reverse();
  return { score: S[n * w + m], pairs };
}

// ---------------------------------------------------------------------------
// The trips of a feed
// ---------------------------------------------------------------------------

/** A line of the map: its place in lines.json.gz, its number, its ends (as OpenStreetMap names them) and the names of its stops. */
export interface MapLine {
  index: number;
  ref: string;
  from: string;
  to: string;
  stops: string[];
}

/** A trip of the feed, as far as the timetables need it. */
export interface FeedTrip {
  /** its line's number, written as the map writes it ("RT1") */
  ref: string;
  service: Service | undefined;
  /** its stops by name (the station's where the feed has one) and the times there, seconds after midnight */
  names: string[];
  arr: number[];
  dep: number[];
  /** repeated every so often, where frequencies.txt says so: [from, to, every] in seconds */
  every?: Array<[number, number, number]>;
}

export interface FeedData {
  label: string;
  name: string;
  version: string;
  url: string;
  /** the days it is valid for */
  start: number;
  end: number;
  /** who made it (attributions.txt) */
  orgs: string[];
  trips: FeedTrip[];
  /** lines of the operators asked for that run on rails but are not on the map */
  otherRefs: string[];
}

/** A line's number as the map writes it: "RT 1" → "RT1", "Tram 4" → "4". */
export function refOf(shortName: string): string {
  return shortName.toUpperCase().replace(/\s+/g, '').replace(/^(TRAM|STR)(?=\d)/, '');
}

/** Route types that run on rails: tram, metro, rail, cable tram, monorail, and the extended railway, urban rail and tram types. */
export function onRails(type: number): boolean {
  return type === 0 || type === 1 || type === 2 || type === 5 || type === 12 || (type >= 100 && type < 200) || (type >= 400 && type < 500) || (type >= 900 && type < 1000);
}

export const DEFAULT_AGENCY = '^KVG\\b|Kassel|RegioTram|^NVV\\b|Nordhessischer';

/** Reads what the timetables need out of one feed: the trips of the operators asked for on the lines the map has (by their number). */
export async function readFeed(src: FeedSource, refs: Set<string>, agency: RegExp, log: (msg: string) => void = () => {}, url = ''): Promise<FeedData> {
  const info = (await readTable(src, 'feed_info.txt'))[0] ?? {};
  const agencies = await readTable(src, 'agency.txt');
  const agencyName = new Map(agencies.map((a) => [a.agency_id ?? '', a.agency_name ?? '']));
  const onlyAgency = agencies.length === 1 ? (agencies[0].agency_name ?? '') : '';
  const otherRefs = new Set<string>();
  const used = new Set<string>();
  const routes = new Map<string, string>();
  for (const r of await readTable(src, 'routes.txt')) {
    const name = agencyName.get(r.agency_id ?? '') ?? onlyAgency;
    if (!agency.test(name) || !onRails(Number(r.route_type))) continue;
    const ref = refOf(r.route_short_name || r.route_long_name || '');
    if (refs.has(ref)) {
      routes.set(r.route_id, ref);
      used.add(name);
    } else if (ref) otherRefs.add(ref);
  }
  const services = readServices(await readTable(src, 'calendar.txt'), await readTable(src, 'calendar_dates.txt'));
  const trips = new Map<string, { ref: string; service: string }>();
  await scanTable(src, 'trips.txt', 'route_id', new Set(routes.keys()), (f, head) => {
    const at = (c: string): string => (f[head.indexOf(c)] ?? '').trim();
    trips.set(at('trip_id'), { ref: routes.get(at('route_id')) ?? '', service: at('service_id') });
  });
  log(`${src.label}: ${routes.size} routes of ${[...new Set(routes.values())].sort().join(', ') || 'none'} – ${trips.size} trips`);
  const every = new Map<string, Array<[number, number, number]>>();
  for (const f of await readTable(src, 'frequencies.txt', (f) => trips.has(f.trip_id))) {
    const list = every.get(f.trip_id) ?? [];
    list.push([parseTime(f.start_time), parseTime(f.end_time), Number(f.headway_secs)]);
    every.set(f.trip_id, list);
  }
  // their stops and times, out of the big file
  const rows = new Map<string, Array<[number, string, number, number]>>();
  let iTrip = -1;
  let iStop = -1;
  let iSeq = -1;
  let iArr = -1;
  let iDep = -1;
  const lines = await scanTable(src, 'stop_times.txt', 'trip_id', new Set(trips.keys()), (f, head) => {
    if (iTrip < 0) [iTrip, iStop, iSeq, iArr, iDep] = ['trip_id', 'stop_id', 'stop_sequence', 'arrival_time', 'departure_time'].map((c) => head.indexOf(c));
    const id = f[iTrip].trim();
    const list = rows.get(id) ?? [];
    list.push([Number(f[iSeq]), (f[iStop] ?? '').trim(), parseTime(f[iArr] ?? ''), parseTime(f[iDep] ?? '')]);
    rows.set(id, list);
  });
  log(`${src.label}: ${lines} rows of stop_times.txt read, ${rows.size} trips found in them`);
  // the names of their stops: the station's name where a stop is one platform of a station
  const want = new Set<string>();
  for (const list of rows.values()) for (const r of list) want.add(r[1]);
  const stops = new Map<string, { name: string; parent: string }>();
  const readStops = (ids: Set<string>): Promise<number> =>
    scanTable(src, 'stops.txt', 'stop_id', ids, (f, head) => {
      const at = (c: string): string => (f[head.indexOf(c)] ?? '').trim();
      stops.set(at('stop_id'), { name: at('stop_name'), parent: at('parent_station') });
    });
  await readStops(want);
  const parents = new Set([...stops.values()].map((s) => s.parent).filter((p) => p && !stops.has(p)));
  if (parents.size > 0) await readStops(parents);
  const nameOf = (id: string): string => {
    const s = stops.get(id);
    if (!s) return id;
    return (s.parent && stops.get(s.parent)?.name) || s.name;
  };
  const out: FeedTrip[] = [];
  for (const [id, list] of rows) {
    const t = trips.get(id);
    if (!t || list.length < 2) continue;
    list.sort((a, b) => a[0] - b[0]);
    const arr = list.map((r) => (Number.isNaN(r[2]) ? r[3] : r[2]));
    const dep = list.map((r) => (Number.isNaN(r[3]) ? r[2] : r[3]));
    if (!fillTimes(arr, dep)) continue;
    out.push({ ref: t.ref, service: services.get(t.service), names: list.map((r) => nameOf(r[1])), arr, dep, every: every.get(id) });
  }
  // the days it is valid for: as feed_info.txt says, else as far as its services reach
  let start = Number(info.feed_start_date) || 0;
  let end = Number(info.feed_end_date) || 0;
  if (!start || !end) {
    start = Infinity;
    end = 0;
    for (const s of services.values()) {
      for (const d of [s.days ? s.start : 0, ...s.add]) if (d) start = Math.min(start, d);
      for (const d of [s.days ? s.end : 0, ...s.add]) if (d) end = Math.max(end, d);
    }
    if (!Number.isFinite(start)) start = 0;
  }
  const orgs = (await readTable(src, 'attributions.txt')).map((a) => a.organization_name ?? '').filter((o) => o.length > 0);
  return { label: src.label, name: info.feed_publisher_name || [...used].join(', ') || src.label, version: info.feed_version ?? '', url: url || info.feed_publisher_url || '', start, end, orgs, trips: out, otherRefs: [...otherRefs].sort() };
}

/** Times missing at some stops (GTFS allows that between timed stops): spread evenly between those either side.  False where none is known. */
export function fillTimes(arr: number[], dep: number[]): boolean {
  const timed: number[] = [];
  for (let i = 0; i < arr.length; i++) if (!Number.isNaN(arr[i]) && !Number.isNaN(dep[i])) timed.push(i);
  if (timed.length === 0) return false;
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isNaN(arr[i]) && !Number.isNaN(dep[i])) continue;
    const before = timed.filter((k) => k < i).pop();
    const after = timed.find((k) => k > i);
    if (before === undefined) arr[i] = dep[i] = arr[after as number];
    else if (after === undefined) arr[i] = dep[i] = dep[before];
    else arr[i] = dep[i] = Math.round(dep[before] + ((arr[after] - dep[before]) * (i - before)) / (after - before));
  }
  return true;
}

// ---------------------------------------------------------------------------
// The timetable
// ---------------------------------------------------------------------------

export interface BuildReport {
  week: [string, string];
  days: [string, string, string];
  weekNote: string;
  valid: [string, string];
  /** per line of the map that got a timetable: patterns, and trips by day type */
  lines: Array<{ index: number; ref: string; to: string; patterns: number; trips: [number, number, number]; unserved: string[]; beyond: string[] }>;
  /** lines of the map without a timetable, and why */
  missing: Array<{ index: number; ref: string; to: string; why: string }>;
  /** trips of the feed that fit no line of the map: their number, first and last stop, how many */
  unplaced: Array<{ ref: string; first: string; last: string; count: number }>;
  /** stops the trips call at between stops of the map's line that the line does not have – and the map's name of it where another line has it */
  unmatched: Array<{ name: string; refs: string[]; count: number; known: string }>;
  /** names paired although they are not quite the same: feed, map, likeness */
  loose: Array<{ feed: string; map: string; sim: number }>;
  /** lines of the operators on rails the map does not have */
  otherRefs: string[];
}

export interface BuildOptions {
  towns?: string[];
  /** the Monday of the week to take */
  week?: number;
  attribution?: string;
  generated?: string;
}

/**
 * The credit to give for the feeds: gtfs.de with its licence (CC BY 4.0, and
 * whoever else its attributions.txt names – it lists the OpenStreetMap
 * contributors besides DELFI), the others as they name themselves.
 */
export function attributionFor(feeds: Array<{ name: string; url: string; orgs: string[] }>, given?: string): string {
  if (given) return given;
  const parts = new Set<string>();
  for (const f of feeds) {
    if (/gtfs\.de/i.test(`${f.name} ${f.url}`)) {
      const others = f.orgs.filter((o) => !/delfi|gtfs\.de/i.test(o));
      parts.add(`Fahrplandaten: gtfs.de – GTFS für Deutschland (https://gtfs.de), Daten bereitgestellt von DELFI e.V. (https://www.delfi.de)${others.length > 0 ? `, mit Beiträgen von: ${others.join(', ')}` : ''}, Lizenz CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)`);
    } else parts.add(`Fahrplandaten: ${[f.name, ...f.orgs.filter((o) => !f.name.includes(o))].join(', ')}${f.url ? ` (${f.url})` : ''}`);
  }
  return `${[...parts].join('; ')} – für das Spiel auf die Straßenbahnen und RegioTrams in Kassel gekürzt und umgerechnet`;
}

interface PatternAcc {
  line: MapLine;
  json: TimetablePatternJson;
  starts: [Set<number>, Set<number>, Set<number>];
}

/** Makes timetable.json from the trips of the feeds and the lines of the map, and says what fitted and what did not. */
export function buildTimetable(feeds: FeedData[], lines: MapLine[], opts: BuildOptions = {}): { json: TimetableJson; report: BuildReport } {
  const sim = nameMatcher(opts.towns ?? []);
  const known = feeds.filter((f) => f.start > 0 && f.end > 0);
  const valid: [number, number] = known.length > 0 ? [Math.max(...known.map((f) => f.start)), Math.min(...known.map((f) => f.end))] : [0, 0];
  const trips = feeds.flatMap((f) => f.trips);
  // what a day looks like: how many trips of each line run on it
  const describe = (d: number): { sig: string; lines: number } => {
    const per = new Map<string, number>();
    for (const t of trips) if (serviceRuns(t.service, d)) per.set(t.ref, (per.get(t.ref) ?? 0) + 1);
    return { sig: [...per].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([r, n]) => `${r}:${n}`).join(' '), lines: per.size };
  };
  const choice = chooseWeek(valid, describe, opts.week);
  const ourNames = [...new Set(lines.flatMap((l) => l.stops))].filter((n) => n.length > 0);
  // the map's names that tell a stop apart without a line around it: not a bare "Stadtmitte", which might be any town's
  const plainNames = ourNames.filter((n) => !GENERIC.has(normName(n)));
  const towns = [...(opts.towns ?? [])].sort((x, y) => y.length - x.length);
  // a stop of the feed that has its very name on the map pairs with that one only: "Rathaus/Fünffensterstraße" is not "Rathaus"
  const nearest = new Map<string, number>();
  const pairSim = (g: string, o: string): number => {
    const s = sim(g, o);
    let top = nearest.get(g);
    if (top === undefined) nearest.set(g, (top = Math.max(0, ...ourNames.map((n) => sim(g, n)))));
    return s >= top || top < 0.99 ? s : 0;
  };

  // ---- which line of the map a trip runs: the one whose stops it calls at most of, in their order ----
  const fits = new Map<string, { line: MapLine; pairs: Array<[number, number, number]> } | null>();
  const fit = (t: FeedTrip): { line: MapLine; pairs: Array<[number, number, number]> } | null => {
    const key = `${t.ref}|${t.names.join('>')}`;
    let f = fits.get(key);
    if (f !== undefined) return f;
    f = null;
    let best = 0;
    const first = t.names[0];
    const last = t.names[t.names.length - 1];
    for (const line of lines) {
      if (line.ref !== t.ref || line.stops.length === 0) continue;
      const al = align(t.names, line.stops, pairSim);
      if (al.pairs.length < 2) continue;
      // (where it begins and ends as the line does, the more so: "Wolfsanger → Königsplatz" is not "Wolfsanger → Mattenberg")
      let score = al.score - 0.01 * (line.stops.length - al.pairs.length);
      if (Math.max(sim(first, line.from), sim(first, line.stops[0])) >= 0.8) score += 1.5;
      if (Math.max(sim(last, line.to), sim(last, line.stops[line.stops.length - 1])) >= 0.8) score += 1.5;
      if (score > best) {
        best = score;
        f = { line, pairs: al.pairs };
      }
    }
    fits.set(key, f);
    return f;
  };
  // where its trams go: one of the map's stops, else as the departure boards name it – without the town in front, a station by its town or part of town ("Kassel Rolandstraße" → "Rolandstraße", "Hofgeismar-Hümme Bahnhof" → "Hümme", "Melsungen Bahnhof" → "Melsungen")
  const dests = new Map<string, string>();
  const destination = (name: string): string => {
    let d = dests.get(name);
    if (d !== undefined) return d;
    let bs = 0;
    let best = '';
    for (const n of plainNames) {
      const s = sim(name, n);
      // (of names alike, the longer says more)
      if (s > bs || (s === bs && s > 0 && n.length > best.length)) {
        bs = s;
        best = n;
      }
    }
    d = bs >= 0.9 ? best : name;
    if (bs < 0.9) {
      const bare = name.replace(/[\s,]+(bahnhof|bf|bhf)\.?$/i, '').trim();
      const town = towns.find((t) => bare.startsWith(t) && (bare.length === t.length || /^[\s,-]/.test(bare.slice(t.length))));
      const rest = town ? bare.slice(town.length).replace(/^[\s,-]+/, '') : '';
      // ("Kaufungen Mitte" stays as it is: "Mitte" alone says nothing)
      d = !town ? name : rest && !GENERIC.has(normName(rest)) ? rest : bare;
    }
    dests.set(name, d);
    return d;
  };

  // ---- the trips of each day type, as patterns ----
  const acc = new Map<string, PatternAcc>();
  const unplaced = new Map<string, { ref: string; first: string; last: string; count: number }>();
  const unmatched = new Map<string, { name: string; refs: Set<string>; count: number }>();
  const loose = new Map<string, { feed: string; map: string; sim: number }>();
  const beyond = new Map<number, Set<string>>();
  const stopIndex = new Map<string, number>();
  const stopNames: string[] = [];
  const indexOf = (n: string): number => {
    let i = stopIndex.get(n);
    if (i === undefined) {
      stopIndex.set(n, (i = stopNames.length));
      stopNames.push(n);
    }
    return i;
  };
  choice.days.forEach((date, type) => {
    if (!date) return;
    for (const t of trips) {
      if (!serviceRuns(t.service, date)) continue;
      const f = fit(t);
      const reps = t.every ? t.every.flatMap(([a, b, h]) => (h > 0 ? Array.from({ length: Math.max(0, Math.ceil((b - a) / h)) }, (_, k) => a + k * h - t.dep[0]) : [])) : [0];
      if (!f) {
        const k = `${t.ref}|${t.names[0]}|${t.names[t.names.length - 1]}`;
        const u = unplaced.get(k) ?? { ref: t.ref, first: t.names[0], last: t.names[t.names.length - 1], count: 0 };
        u.count += reps.length;
        unplaced.set(k, u);
        continue;
      }
      const { line, pairs } = f;
      const g0 = pairs[0][0];
      const g1 = pairs[pairs.length - 1][0];
      // what the feed calls at between the line's stops that the line has not got, and names paired loosely
      const paired = new Set(pairs.map((p) => p[0]));
      for (let g = g0 + 1; g < g1; g++) {
        if (paired.has(g)) continue;
        const u = unmatched.get(t.names[g]) ?? { name: t.names[g], refs: new Set<string>(), count: 0 };
        u.refs.add(line.ref);
        u.count++;
        unmatched.set(t.names[g], u);
      }
      for (const [g, j, s] of pairs) if (s < 0.99) loose.set(`${t.names[g]}|${line.stops[j]}`, { feed: t.names[g], map: line.stops[j], sim: s });
      if (g0 > 0 || g1 < t.names.length - 1) {
        const set = beyond.get(line.index) ?? new Set<string>();
        if (g1 < t.names.length - 1) set.add(`→ ${t.names[t.names.length - 1]}`);
        if (g0 > 0) set.add(`${t.names[0]} →`);
        beyond.set(line.index, set);
      }
      const t0 = t.dep[g0];
      const d: number[] = [];
      const a: number[] = [];
      for (const [g] of pairs) {
        let ak = t.arr[g] - t0;
        let dk = t.dep[g] - t0;
        // (times never run backwards along a trip)
        if (d.length > 0) ak = Math.max(ak, d[d.length - 1]);
        else ak = Math.min(ak, 0);
        dk = d.length === 0 ? 0 : Math.max(dk, ak);
        a.push(ak);
        d.push(dk);
      }
      // (where it ends at a stop of the line, the line's name of it)
      const to = g1 === t.names.length - 1 ? line.stops[pairs[pairs.length - 1][1]] : destination(t.names[t.names.length - 1]);
      const json: TimetablePatternJson = { s: pairs.map(([, j]) => indexOf(line.stops[j])), j: pairs.map(([, j]) => j), d, to, t: [[], [], []] };
      if (a.some((v, k) => v !== d[k])) json.a = a;
      if (g0 > 0) json.pre = 1;
      if (g1 < t.names.length - 1) json.post = 1;
      const key = `${line.index}|${JSON.stringify(json)}`;
      let p = acc.get(key);
      if (!p) acc.set(key, (p = { line, json, starts: [new Set(), new Set(), new Set()] }));
      for (const r of reps) p.starts[type].add(t0 + r);
    }
  });

  // ---- the file ----
  const byLine = new Map<number, PatternAcc[]>();
  for (const p of acc.values()) {
    p.json.t = [0, 1, 2].map((k) => [...p.starts[k]].sort((x, y) => x - y)) as [number[], number[], number[]];
    const list = byLine.get(p.line.index) ?? [];
    list.push(p);
    byLine.set(p.line.index, list);
  }
  const outLines: TimetableLineJson[] = [];
  const reportLines: BuildReport['lines'] = [];
  const missing: BuildReport['missing'] = [];
  const feedRefs = new Set(trips.map((t) => t.ref));
  const dayRefs = new Set(trips.filter((t) => choice.days.some((d) => d > 0 && serviceRuns(t.service, d))).map((t) => t.ref));
  for (const line of lines) {
    const list = byLine.get(line.index);
    if (!list) {
      const why = !feedRefs.has(line.ref)
        ? `the feed has no trips of line ${line.ref} (of the operators asked for)`
        : !dayRefs.has(line.ref)
          ? `line ${line.ref} does not run on the days taken`
          : line.stops.length < 2
            ? 'the map knows fewer than two of its stops'
            : `none of the trips of line ${line.ref} fits its stops (other variants of the line took them)`;
      missing.push({ index: line.index, ref: line.ref, to: line.to, why });
      continue;
    }
    list.sort((x, y) => y.json.t.reduce((n, t) => n + t.length, 0) - x.json.t.reduce((n, t) => n + t.length, 0));
    outLines.push({ line: line.index, ref: line.ref, patterns: list.map((p) => p.json) });
    const served = new Set(list.flatMap((p) => p.json.s.map((i) => stopNames[i])));
    const trips = [0, 1, 2].map((k) => list.reduce((n, p) => n + p.json.t[k].length, 0)) as [number, number, number];
    reportLines.push({ index: line.index, ref: line.ref, to: line.to, patterns: list.length, trips, unserved: line.stops.filter((n) => !served.has(n)), beyond: [...(beyond.get(line.index) ?? [])] });
  }
  const json: TimetableJson = {
    version: 1,
    generated: opts.generated ?? new Date().toISOString(),
    feeds: feeds.map((f) => ({ name: f.name, version: f.version, url: f.url, start: isoDate(f.start), end: isoDate(f.end) })),
    valid: [isoDate(valid[0]), isoDate(valid[1])],
    week: [isoDate(choice.week[0]), isoDate(choice.week[1])],
    days: choice.days.map(isoDate) as [string, string, string],
    attribution: attributionFor(feeds, opts.attribution),
    stops: stopNames,
    lines: outLines,
  };
  const report: BuildReport = {
    week: json.week,
    days: json.days,
    weekNote: choice.note,
    valid: json.valid,
    lines: reportLines,
    missing,
    unplaced: [...unplaced.values()].sort((x, y) => y.count - x.count),
    unmatched: [...unmatched.values()]
      .map((u) => {
        const known = plainNames.reduce((b, n) => (pairSim(u.name, n) > Math.max(0.89, pairSim(u.name, b)) ? n : b), '');
        return { name: u.name, refs: [...u.refs].sort(), count: u.count, known };
      })
      .sort((x, y) => y.count - x.count),
    loose: [...loose.values()].sort((x, y) => x.sim - y.sim || x.feed.localeCompare(y.feed)),
    otherRefs: [...new Set(feeds.flatMap((f) => f.otherRefs))].sort(),
  };
  return { json, report };
}

/** The lines of the map with the names of their stops (lines.json.gz, and the stop names of rails.json.gz). */
export function mapLines(doc: LinesJson, rails: RailJson[]): MapLine[] {
  return doc.lines.map((l, index) => ({
    index,
    ref: l.ref,
    from: l.from,
    to: l.to,
    stops: l.stops.map(([p, mark]) => {
      const r = rails[p];
      const k = r?.st?.indexOf(mark) ?? -1;
      return k >= 0 ? (r.sn?.[k] ?? '') : '';
    }),
  }));
}

// ---------------------------------------------------------------------------
// Fetching the feeds, and the whole run
// ---------------------------------------------------------------------------

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = 'timetable-fetch/0.1';
/** Feeds bigger than this are deleted after the build (fetching them again is quicker than keeping them on a small disk). */
const KEEP_BYTES = 300e6;
const DEFAULT_FEEDS = [
  { url: 'https://download.gtfs.de/germany/nv_free/latest.zip', dir: 'gtfs.de-nv_free' },
  { url: 'https://download.gtfs.de/germany/rv_free/latest.zip', dir: 'gtfs.de-rv_free' },
];

function curl(args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('close', (code) => (code === 0 ? ok(out) : fail(new Error(`curl ${code}: ${err.trim()}`))));
  });
}

/**
 * Fetches a feed into a folder of its own, named after the feed's date on
 * the server: a feed fetched before is used again, and once a newer one is
 * there the older copies go (the disk is small).  Where the server cannot
 * be reached, the newest copy at hand is taken.
 */
async function fetchFeed(url: string, name: string, log: (msg: string) => void): Promise<{ path: string; fresh: boolean; bytes: number }> {
  const base = resolve(root, 'data/raw/gtfs');
  const fileName = basename(new URL(url).pathname) || 'feed.zip';
  const copies = (): string[] => (existsSync(base) ? readdirSync(base).filter((d) => new RegExp(`^${name.replace(/[.]/g, '\\.')}-\\d{8}$`).test(d)).sort() : []);
  let head: string;
  try {
    head = await curl(['-fsSIL', '--max-time', '60', '-A', AGENT, url]);
  } catch (e) {
    const last = copies().filter((d) => existsSync(resolve(base, d, fileName))).pop();
    if (!last) throw e;
    const path = resolve(base, last, fileName);
    log(`${url}: not to be reached (${e instanceof Error ? e.message : String(e)}) – taking the copy in ${last}`);
    return { path, fresh: false, bytes: statSync(path).size };
  }
  const modified = [...head.matchAll(/^last-modified:\s*(.+?)\s*$/gim)].pop()?.[1];
  const length = Number([...head.matchAll(/^content-length:\s*(\d+)/gim)].pop()?.[1] ?? 0);
  const day = (modified ? new Date(modified) : new Date()).toISOString().slice(0, 10).replace(/-/g, '');
  const dir = resolve(base, `${name}-${day}`);
  const file = resolve(dir, fileName);
  if (existsSync(file) && length > 0 && statSync(file).size === length) {
    log(`${url}: the copy of ${day} is there already (${(length / 1e6).toFixed(0)} MB)`);
    return { path: file, fresh: false, bytes: length };
  }
  mkdirSync(dir, { recursive: true });
  log(`${url}: fetching ${(length / 1e6).toFixed(0)} MB into ${dir}`);
  await curl(['-fSL', '--retry', '5', '--retry-all-errors', '--retry-delay', '5', '-C', '-', '-A', AGENT, '-o', file, url]);
  for (const old of copies()) {
    if (old === `${name}-${day}`) continue;
    rmSync(resolve(base, old), { recursive: true, force: true });
    log(`removed the older copy ${old}`);
  }
  return { path: file, fresh: true, bytes: statSync(file).size };
}

function readGz<T>(path: string): T {
  return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as T;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const lap = (msg: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);
  const mapDir = resolve(root, process.env.MAP_OUT ?? 'public/map');
  const lines = mapLines(readGz<LinesJson>(resolve(mapDir, 'lines.json.gz')), readGz<{ rails: RailJson[] }>(resolve(mapDir, 'rails.json.gz')).rails);
  const stopsPath = resolve(mapDir, 'stops.json.gz');
  const towns = existsSync(stopsPath) ? readGz<StopsJson>(stopsPath).towns.filter((t) => t.length > 0) : [];
  lap(`${lines.length} lines on the map (${[...new Set(lines.map((l) => l.ref))].join(', ')}), ${towns.length} towns`);

  const sources: Array<{ src: FeedSource; url: string; drop: string }> = [];
  const args = process.argv.slice(2);
  if (args.length > 0) {
    for (const a of args) sources.push({ src: statSync(a).isDirectory() ? dirSource(resolve(a)) : zipSource(resolve(a)), url: '', drop: '' });
  } else {
    for (const f of DEFAULT_FEEDS) {
      const got = await fetchFeed(f.url, f.dir, lap);
      sources.push({ src: zipSource(got.path), url: f.url, drop: got.fresh && got.bytes > KEEP_BYTES ? got.path : '' });
    }
  }
  const agency = new RegExp(process.env.GTFS_AGENCY ?? DEFAULT_AGENCY, 'i');
  const refs = new Set(lines.map((l) => l.ref));
  const feeds: FeedData[] = [];
  for (const s of sources) feeds.push(await readFeed(s.src, refs, agency, lap, s.url));

  const week = process.env.GTFS_WEEK ? dateOf(process.env.GTFS_WEEK) : undefined;
  const { json, report } = buildTimetable(feeds, lines, { towns, week, attribution: process.env.GTFS_ATTRIBUTION });
  const bytes = gzipSync(JSON.stringify(json), { level: 9 });
  writeFileSync(resolve(mapDir, 'timetable.json.gz'), bytes);

  for (const f of feeds) lap(`feed ${f.label}: ${f.name}${f.version ? ` (${f.version})` : ''}, valid ${isoDate(f.start)} … ${isoDate(f.end)}, ${f.trips.length} trips of the map's lines`);
  lap(`the week of ${report.week[0]} … ${report.week[1]}${report.weekNote ? ` (${report.weekNote})` : ''}: Monday–Friday from ${report.days[0]}, Saturday from ${report.days[1]}, Sunday from ${report.days[2]}`);
  for (const l of report.lines) {
    console.log(`  #${l.index} ${l.ref} → ${l.to}: ${l.patterns} patterns, trips ${l.trips.join(' / ')} (Mon–Fri / Sat / Sun)`);
    if (l.unserved.length > 0) console.log(`      stops of the map no trip calls at: ${l.unserved.join(', ')}`);
    if (l.beyond.length > 0) console.log(`      trips beyond the line's stops on the map: ${l.beyond.join('; ')}`);
  }
  for (const m of report.missing) console.log(`  #${m.index} ${m.ref} → ${m.to}: NO timetable – ${m.why}`);
  if (report.unplaced.length > 0) console.log(`trips that fit no line of the map:\n${report.unplaced.map((u) => `  ${u.count}× ${u.ref}: ${u.first} → ${u.last}`).join('\n')}`);
  if (report.unmatched.length > 0) console.log(`stops of the feed between the stops of a line that the map's line has not got:\n${report.unmatched.map((u) => `  ${u.name} (line ${u.refs.join(', ')}; ${u.count}×) – ${u.known ? `other lines of the map have it, as "${u.known}"` : 'no line of the map has it'}`).join('\n')}`);
  if (report.loose.length > 0) console.log(`names paired that are not quite the same:\n${report.loose.map((p) => `  ${p.feed} = ${p.map} (${p.sim})`).join('\n')}`);
  if (report.otherRefs.length > 0) console.log(`lines of the operators on rails that the map has not got: ${report.otherRefs.join(', ')}`);
  lap(`timetable.json.gz: ${json.lines.length} of ${lines.length} lines, ${json.lines.reduce((n, l) => n + l.patterns.length, 0)} patterns, ${json.stops.length} stops, ${(bytes.length / 1024).toFixed(0)} KB`);
  for (const s of sources) {
    if (!s.drop) continue;
    rmSync(dirname(s.drop), { recursive: true, force: true });
    lap(`deleted ${s.drop} (more than ${KEEP_BYTES / 1e6} MB; fetched again next time)`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
