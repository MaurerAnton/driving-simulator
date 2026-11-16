// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The timetables of the trams (tools/build-timetable.ts, src/sim/timetable.ts):
 * a small GTFS feed made up here – read, its stop names paired with those of
 * the map, its trips sorted onto the map's lines and day types – and every
 * question the game asks of the result, after midnight included.
 *
 *   node --test tests/world/timetable.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DAY, berlinClock, berlinOffset, dayTypeOf, departures, easter, isHoliday, parseTimetable, scheduledAt, serviceTime, tripsAt, weekTime } from '../../src/sim/timetable.ts';
import type { TimetableJson } from '../../src/world/types.ts';
import { align, attributionFor, buildTimetable, chooseWeek, dirSource, fillTimes, memorySource, nameMatcher, normName, parseTime, readFeed, refOf, serviceRuns, splitCsv } from '../../tools/build-timetable.ts';
import type { FeedData, FeedSource, MapLine } from '../../tools/build-timetable.ts';

const TOWNS = ['Kassel', 'Vellmar', 'Baunatal', 'Kaufungen', 'Hessisch Lichtenau', 'Wolfhagen', 'Zierenberg'];

/**
 * A feed of four weeks (Monday 2 to Sunday 29 November 2026): line 1 of the
 * KVG out to Vellmar Nord (two trips in the morning, a short one, one after
 * midnight, one on Saturday and one on Sunday) and back every 20 minutes
 * (frequencies.txt), RegioTram 4 in from Wolfhagen and out again; a bus 1,
 * a tram 1 of another town and a tram 9 the map has not got, which must all
 * be left out.  The working days of the first week lose their Wednesday.
 * stop_times.txt has its trip_id in the second column, a quoted id and
 * Windows line ends; a time is missing at one stop.
 */
const FEED: Record<string, string> = {
  'agency.txt': ['agency_id,agency_name,agency_url,agency_timezone', '1,KVG M,https://example.org,Europe/Berlin', '2,"Stadtwerke Anderswo, Verkehr",https://example.org,Europe/Berlin'].join('\n'),
  // (a byte order mark in front of the header, here and in trips.txt)
  'routes.txt': ['\uFEFFroute_long_name,route_short_name,agency_id,route_type,route_id', ',1,1,0,T1', ',1,1,3,B1', ',1,2,0,X1', ',RT 4,1,2,R4', ',9,1,900,T9'].join('\n'),
  'stops.txt': [
    'stop_id,stop_name,parent_station,location_type',
    'P_KOE,Kassel Königsplatz,,1',
    'KOE_A,"Königsplatz, Ri. Am Stern",P_KOE,',
    'KOE_B,"Königsplatz, von Am Stern",P_KOE,',
    'P_STE,Kassel Am Stern,,1',
    'STE_A,Am Stern von Königsplatz,P_STE,',
    'STE_B,Am Stern Ri. Königsplatz,P_STE,',
    'HOL,Kassel Holländischer Platz/Universität,,',
    'HAL,Kassel Halitplatz/Philipp-Scheidemann-Haus,,',
    'VST,Vellmar Stadtmitte,,',
    'VNO,Vellmar Nord,,',
    'HBF,Kassel Hauptbahnhof,,',
    'HST,Kassel Holländische Straße,,',
    'WOL,Wolfhagen Bahnhof,,',
    'ZIE,Zierenberg Bahnhof,,',
    'ELS,Anderswo Mitte,,',
  ].join('\n'),
  'calendar.txt': ['service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date', 'WK,1,1,1,1,1,0,0,20261102,20261129', 'SA,0,0,0,0,0,1,0,20261102,20261129', 'SU,0,0,0,0,0,0,1,20261102,20261129'].join('\n'),
  'calendar_dates.txt': ['service_id,date,exception_type', 'WK,20261104,2'].join('\n'),
  'trips.txt': ['\uFEFFroute_id,service_id,trip_id', 'T1,WK,w1', 'T1,WK,w2', 'T1,WK,w3', 'T1,WK,wn', 'T1,SA,s1', 'T1,SU,u1', 'T1,WK,f1', 'B1,WK,bus1', 'X1,WK,other1', 'R4,WK,r1', 'R4,WK,r2', 'T9,WK,n9'].join('\n'),
  'frequencies.txt': ['trip_id,start_time,end_time,headway_secs', 'f1,06:00:00,07:00:00,1200'].join('\n'),
  'stop_times.txt': [
    'stop_sequence,trip_id,arrival_time,departure_time,stop_id',
    // out to Vellmar Nord at 08:00 (a minute's stop at Holländischer Platz, no time at Vellmar Stadtmitte)
    ...trip('w1', ['KOE_A', 'STE_A', 'HOL', 'HAL', 'VST', 'VNO'], ['08:00', '08:02', '08:05/08:06', '08:08', '', '08:20']),
    ...trip('"w2"', ['KOE_A', 'STE_A', 'HOL', 'HAL', 'VST', 'VNO'], ['08:10', '08:12', '08:15/08:16', '08:18', '', '08:30']),
    ...trip('w3', ['KOE_A', 'STE_A', 'HOL'], ['09:00', '09:02', '09:05']),
    ...trip('wn', ['KOE_A', 'STE_A', 'HOL', 'HAL', 'VST', 'VNO'], ['24:30', '24:32', '24:35', '24:37', '24:42', '24:47']),
    ...trip('s1', ['KOE_A', 'STE_A', 'HOL', 'HAL', 'VST', 'VNO'], ['10:00', '10:02', '10:05/10:06', '10:08', '10:14', '10:20']),
    ...trip('u1', ['KOE_A', 'STE_A', 'HOL', 'HAL', 'VST', 'VNO'], ['11:00', '11:02', '11:05/11:06', '11:08', '11:14', '11:20']),
    ...trip('f1', ['VNO', 'VST', 'HOL', 'STE_B', 'KOE_B'], ['06:00', '06:05', '06:12', '06:15', '06:17']),
    ...trip('bus1', ['KOE_A', 'STE_A'], ['07:00', '07:03']),
    ...trip('other1', ['ELS', 'KOE_A'], ['07:00', '07:30']),
    ...trip('r1', ['WOL', 'ZIE', 'HBF', 'STE_A', 'HST'], ['06:00', '06:15', '06:40', '06:45', '06:52']),
    ...trip('r2', ['HST', 'STE_B', 'HBF', 'ZIE', 'WOL'], ['07:00', '07:07', '07:12', '07:37', '07:52']),
    ...trip('n9', ['KOE_A', 'STE_A'], ['07:00', '07:02']),
  ].join('\r\n'),
};

/** stop_times.txt rows of one trip: a time per stop, "arrival/departure" where it waits. */
function trip(id: string, stops: string[], times: string[]): string[] {
  return stops.map((s, i) => {
    const [a, d] = times[i].includes('/') ? times[i].split('/') : [times[i], times[i]];
    return `${i + 1},${id},${a ? `${a}:00` : ''},${d ? `${d}:00` : ''},${s}`;
  });
}

/** The map's lines: 1 out and back, a short variant of it, RegioTram 4 in and out, and a line 5 the feed has not got. */
const LINES: MapLine[] = [
  { index: 0, ref: '1', from: 'Königsplatz', to: 'Vellmar Nord, Vellmar', stops: ['Königsplatz', 'Am Stern', 'Holländischer Platz/Universität', 'Stadtmitte', 'Vellmar Nord'] },
  { index: 1, ref: '1', from: 'Vellmar Nord', to: 'Königsplatz', stops: ['Vellmar Nord', 'Stadtmitte', 'Holländischer Platz/Universität', 'Am Stern', 'Königsplatz'] },
  { index: 2, ref: '1', from: 'Königsplatz', to: 'Holländischer Platz', stops: ['Königsplatz', 'Am Stern', 'Holländischer Platz/Universität'] },
  { index: 3, ref: 'RT4', from: 'Wolfhagen', to: 'Kassel Holländische Straße', stops: ['Hauptbahnhof', 'Am Stern', 'Holländische Straße'] },
  { index: 4, ref: 'RT4', from: 'Kassel Holländische Straße', to: 'Wolfhagen', stops: ['Holländische Straße', 'Am Stern', 'Hauptbahnhof'] },
  { index: 5, ref: '5', from: 'A', to: 'B', stops: ['Königsplatz', 'Am Stern'] },
];

const REFS = new Set(LINES.map((l) => l.ref));
const AGENCY = /^KVG\b|Kassel|RegioTram|^NVV\b/i;
const hms = (h: number, m: number, s = 0): number => h * 3600 + m * 60 + s;

let feedCache: FeedData | null = null;
async function feed(): Promise<FeedData> {
  feedCache ??= await readFeed(memorySource('test', FEED), REFS, AGENCY);
  return feedCache;
}

let builtCache: ReturnType<typeof buildTimetable> | null = null;
async function built(): Promise<ReturnType<typeof buildTimetable>> {
  builtCache ??= buildTimetable([await feed()], LINES, { towns: TOWNS, generated: '2026-11-16T00:00:00.000Z' });
  return builtCache;
}

// ---------------------------------------------------------------------------
// reading GTFS
// ---------------------------------------------------------------------------

test('CSV fields: quotes, commas and quotes inside them; GTFS times past midnight', () => {
  assert.deepEqual(splitCsv('a,b,,c'), ['a', 'b', '', 'c']);
  assert.deepEqual(splitCsv('1,"Königsplatz, Ri. Am Stern",x'), ['1', 'Königsplatz, Ri. Am Stern', 'x']);
  assert.deepEqual(splitCsv('"say ""hello""",2'), ['say "hello"', '2']);
  assert.equal(parseTime('08:05:30'), hms(8, 5, 30));
  assert.equal(parseTime('25:10:00'), hms(25, 10));
  assert.equal(parseTime(' 7:05:00'), hms(7, 5));
  assert.ok(Number.isNaN(parseTime('')));
  assert.equal(refOf('RT 4'), 'RT4');
  assert.equal(refOf('Tram 3'), '3');
});

test('missing times are spread between the timed stops either side', () => {
  const arr = [0, NaN, NaN, 300, NaN];
  const dep = [0, NaN, NaN, 330, NaN];
  assert.ok(fillTimes(arr, dep));
  assert.deepEqual(arr, [0, 100, 200, 300, 330]);
  assert.deepEqual(dep, [0, 100, 200, 330, 330]);
  assert.equal(fillTimes([NaN], [NaN]), false);
});

test('a feed: only the trams of the operator on the map’s lines, stations by name, frequencies, validity from the calendar', async () => {
  const f = await feed();
  assert.equal(f.start, 20261102);
  assert.equal(f.end, 20261129);
  assert.deepEqual(f.otherRefs, ['9']);
  // w1 w2 w3 wn s1 u1 f1 r1 r2 – not the bus, not the other town's tram, not line 9
  assert.equal(f.trips.length, 9);
  const w1 = f.trips.find((t) => t.names.length === 6 && t.dep[0] === hms(8, 0));
  assert.ok(w1);
  assert.deepEqual(w1.names, ['Kassel Königsplatz', 'Kassel Am Stern', 'Kassel Holländischer Platz/Universität', 'Kassel Halitplatz/Philipp-Scheidemann-Haus', 'Vellmar Stadtmitte', 'Vellmar Nord']);
  assert.deepEqual(w1.arr, [hms(8, 0), hms(8, 2), hms(8, 5), hms(8, 8), hms(8, 14), hms(8, 20)]);
  assert.deepEqual(w1.dep, [hms(8, 0), hms(8, 2), hms(8, 6), hms(8, 8), hms(8, 14), hms(8, 20)]);
  // the quoted trip id is found as well
  assert.ok(f.trips.some((t) => t.dep[0] === hms(8, 10)));
  const f1 = f.trips.find((t) => t.every);
  assert.deepEqual(f1?.every, [[hms(6, 0), hms(7, 0), 1200]]);
  // the calendar: Monday to Friday, but not on the Wednesday taken away
  assert.ok(serviceRuns(w1.service, 20261103));
  assert.ok(!serviceRuns(w1.service, 20261104));
  assert.ok(!serviceRuns(w1.service, 20261107));
  assert.ok(!serviceRuns(w1.service, 20261201));
});

test('a feed that comes in small pieces (lines cut anywhere) reads the same', async () => {
  const pieces: FeedSource = {
    label: 'pieces',
    has: (file) => file in FEED,
    async *bytes(file) {
      const all = Buffer.from(FEED[file] ?? '', 'utf8');
      for (let i = 0; i < all.length; i += 7) yield all.subarray(i, i + 7);
    },
  };
  const f = await readFeed(pieces, REFS, AGENCY);
  const m = await feed();
  assert.deepEqual(
    f.trips.map((t) => [t.ref, t.names, t.arr, t.dep, t.every]),
    m.trips.map((t) => [t.ref, t.names, t.arr, t.dep, t.every]),
  );
});

test('a feed in a folder reads the same as one in memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timetable-test-'));
  try {
    for (const [name, text] of Object.entries(FEED)) writeFileSync(join(dir, name), text);
    const f = await readFeed(dirSource(dir), REFS, AGENCY);
    const m = await feed();
    assert.deepEqual(
      f.trips.map((t) => [t.ref, t.names, t.arr, t.dep]),
      m.trips.map((t) => [t.ref, t.names, t.arr, t.dep]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

test('stop names: spelt out and stripped of punctuation', () => {
  assert.equal(normName('Kassel Altenbaunaer Str./Europaschule'), 'kassel altenbaunaer strasse/europaschule');
  assert.equal(normName('Kassel Katzensprung/ Universität'), 'kassel katzensprung/universitaet');
  assert.equal(normName('Kongress-Palais/Stadthalle'), 'kongress palais/stadthalle');
  assert.equal(normName('Kassel Hbf'), 'kassel hauptbahnhof');
  assert.equal(normName('Wilhelmshöhe (Park)'), 'wilhelmshoehe park');
});

test('stop names of the feed paired with those of the map', () => {
  const sim = nameMatcher(TOWNS);
  assert.equal(sim('Kassel Königsplatz', 'Königsplatz'), 0.99);
  assert.equal(sim('Vellmar Nord', 'Vellmar Nord'), 1);
  assert.equal(sim('Baunatal-Großenritte Bahnhof', 'Großenritte Bahnhof'), 0.99);
  assert.equal(sim('Kassel Mattenbergsiedlung', 'Mattenberg Siedlung'), 0.99);
  assert.equal(sim('Kassel Kongress Palais/Stadthalle', 'Kongress-Palais/Stadthalle'), 0.99);
  assert.equal(sim('Kassel Halitplatz/Philipp-Scheidemann-Haus', 'Halitplatz'), 0.95);
  assert.equal(sim('Kassel Altenbaunaer Str./Europaschule', 'Altenbaunaer Straße'), 0.95);
  assert.equal(sim('Vellmar-Niedervellmar Triftstraße', 'Triftstraße'), 0.9);
  assert.equal(sim('Baunatal-Altenbauna VW-Werk', 'VW-Werk'), 0.9);
  assert.equal(sim('Kassel Bahnhof Wilhelmshöhe', 'Wilhelmshöhe Bahnhof'), 0.85);
  assert.equal(sim('Kassel Wilhelmsstraße/Stadtmuseum', 'Wilhelmstraße/Stadtmuseum'), 0.9);
  assert.equal(sim('Kassel Wilhelmsstraße', 'Wilhelmstraße'), 0.8);
  assert.equal(sim('Kaufungen-Papierfabrik Industriestraße', 'Kaufungen-Niederkaufungen Industriestraße'), 0.75);
  // different stops: the town is taken from one name only, and a word alone is not a name
  assert.equal(sim('Vellmar Stadtmitte', 'Hessisch Lichtenau Stadtmitte'), 0);
  assert.equal(sim('Kassel Rathaus', 'Kassel Königsplatz'), 0);
  assert.equal(sim('Kaufungen-Oberkaufungen Bahnhof', 'Kaufungen-Niederkaufungen Bahnhof'), 0);
});

test('the pairing keeps the order: the right Rathaus, nothing backwards', () => {
  const sim = nameMatcher(TOWNS);
  const feedNames = ['Kassel Friedrichsplatz', 'Kassel Rathaus', 'Kassel Rathaus/Fünffensterstraße', 'Kassel Ständeplatz'];
  const ours = ['Friedrichsplatz', 'Rathaus', 'Rathaus/Fünffensterstraße', 'Ständeplatz'];
  assert.deepEqual(
    align(feedNames, ours, sim).pairs.map(([i, j]) => [i, j]),
    [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  );
  // a stop the map's line has not got is left out, the rest still pair
  assert.deepEqual(
    align(['Kassel Am Stern', 'Kassel Lutherplatz', 'Kassel Scheidemannplatz'], ['Am Stern', 'Scheidemannplatz'], sim).pairs.map(([i, j]) => [i, j]),
    [
      [0, 0],
      [2, 1],
    ],
  );
  const way = ['Kassel Am Stern', 'Kassel Königsplatz', 'Kassel Friedrichsplatz', 'Kassel Ständeplatz'];
  assert.equal(align(way, ['Am Stern', 'Königsplatz', 'Friedrichsplatz', 'Ständeplatz'], sim).pairs.length, 4);
  assert.equal(align(way, ['Ständeplatz', 'Friedrichsplatz', 'Königsplatz', 'Am Stern'], sim).pairs.length, 1);
});

// ---------------------------------------------------------------------------
// the week, the day types, the patterns
// ---------------------------------------------------------------------------

test('the week: whole, without a holiday, the most ordinary one, the earliest of equals', () => {
  const same = (): { sig: string; lines: number } => ({ sig: '1:50 2:20', lines: 2 });
  // the first week is busier on its Wednesday (a line split by a building site): not the ordinary one
  const busyOn4th = (d: number): { sig: string; lines: number } => (d === 20261104 ? { sig: '1:100 2:20', lines: 2 } : same());
  assert.deepEqual(chooseWeek([20261102, 20261129], busyOn4th), { week: [20261109, 20261115], days: [20261111, 20261114, 20261115], note: '' });
  // two weeks of holidays (line 2 does not run) and two of school: as many alike – the one with more lines
  const holidays = (d: number): { sig: string; lines: number } => (d < 20261116 ? { sig: '1:50', lines: 1 } : same());
  assert.equal(chooseWeek([20261102, 20261129], holidays).week[0], 20261116);
  // 3 October 2026 is a Saturday: that week is not an ordinary one
  assert.deepEqual(chooseWeek([20260928, 20261011], same).week, [20261005, 20261011]);
  // Easter week 2026: Good Friday and Easter Monday – the week after
  assert.deepEqual(chooseWeek([20260330, 20260419], same).week, [20260413, 20260419]);
  // asked for (by any day of it)
  assert.equal(chooseWeek([20261102, 20261129], same, 20261123).week[0], 20261123);
  assert.deepEqual(chooseWeek([20261102, 20261129], same, 20261126).days, [20261125, 20261128, 20261129]);
  // shorter than a week: each day type from its first day
  const short = chooseWeek([20261110, 20261115], same);
  assert.deepEqual(short.days, [20261111, 20261114, 20261115]);
  assert.match(short.note, /no whole week/);
  // feeds with no day in common
  assert.deepEqual(chooseWeek([20261201, 20261130], same).days, [0, 0, 0]);
});

test('the trips become patterns of the map’s lines, by day type', async () => {
  const { json, report } = await built();
  assert.deepEqual(json.week, ['2026-11-09', '2026-11-15']);
  assert.deepEqual(json.days, ['2026-11-11', '2026-11-14', '2026-11-15']);
  assert.deepEqual(json.valid, ['2026-11-02', '2026-11-29']);
  assert.equal(json.version, 1);
  const name = (i: number): string => json.stops[i];
  const line = (i: number): TimetableJson['lines'][number] | undefined => json.lines.find((l) => l.line === i);

  // line 1 out: the two morning trips, and Saturday's and Sunday's, run alike – the night one runs faster
  const out = line(0);
  assert.ok(out);
  assert.equal(out.ref, '1');
  const day = out.patterns.find((p) => p.t[0].includes(hms(8, 0)));
  assert.ok(day);
  assert.deepEqual(day.s.map(name), LINES[0].stops);
  assert.deepEqual(day.j, [0, 1, 2, 3, 4]);
  assert.deepEqual(day.d, [0, 120, 360, 840, 1200]);
  assert.deepEqual(day.a, [0, 120, 300, 840, 1200]);
  assert.deepEqual(day.t, [[hms(8, 0), hms(8, 10)], [hms(10, 0)], [hms(11, 0)]]);
  assert.equal(day.to, 'Vellmar Nord');
  assert.equal(day.pre, undefined);
  assert.equal(day.post, undefined);
  const night = out.patterns.find((p) => p !== day);
  assert.ok(night);
  assert.deepEqual(night.t, [[hms(24, 30)], [], []]);
  assert.deepEqual(night.d, [0, 120, 300, 720, 1020]);
  assert.equal(night.a, undefined);

  // back every 20 minutes from six to seven
  const back = line(1);
  assert.deepEqual(back?.patterns.map((p) => [p.t, p.d, p.to]), [[[[hms(6, 0), hms(6, 20), hms(6, 40)], [], []], [0, 300, 720, 900, 1020], 'Königsplatz']]);

  // the short trip goes to the short variant of the line, not the long one
  assert.deepEqual(line(2)?.patterns.map((p) => [p.s.map(name), p.t[0], p.to]), [[['Königsplatz', 'Am Stern', 'Holländischer Platz/Universität'], [hms(9, 0)], 'Holländischer Platz/Universität']]);

  // the RegioTram: in from beyond the map's stops, and out beyond them – its destination the town's station
  const inward = line(3)?.patterns[0];
  assert.deepEqual([inward?.s.map(name), inward?.j, inward?.d, inward?.t[0], inward?.pre, inward?.post, inward?.to], [['Hauptbahnhof', 'Am Stern', 'Holländische Straße'], [0, 1, 2], [0, 300, 720], [hms(6, 40)], 1, undefined, 'Holländische Straße']);
  const outward = line(4)?.patterns[0];
  assert.deepEqual([outward?.t[0], outward?.pre, outward?.post, outward?.to], [[hms(7, 0)], undefined, 1, 'Wolfhagen']);

  // what did not fit, and what the map has not got
  assert.equal(line(5), undefined);
  assert.deepEqual(
    report.missing.map((m) => m.index),
    [5],
  );
  assert.deepEqual(report.unmatched, [{ name: 'Kassel Halitplatz/Philipp-Scheidemann-Haus', refs: ['1'], count: 5, known: '' }]);
  assert.deepEqual(report.otherRefs, ['9']);
  assert.deepEqual(report.unplaced, []);
  // (a feed without feed_info.txt: named after the operators taken from it)
  assert.match(json.attribution, /^Fahrplandaten: KVG M – /);
});

test('a stop of the feed with its very name on the map pairs with that one only', () => {
  const service = { days: 0b1111111, start: 20261102, end: 20261129, add: new Set<number>(), remove: new Set<number>() };
  const f: FeedData = {
    label: 'x',
    name: 'x',
    version: '',
    url: '',
    start: 20261102,
    end: 20261129,
    orgs: [],
    otherRefs: [],
    trips: [{ ref: '5', service, names: ['Kassel Auestadion', 'Kassel Am Weinberg', 'Kassel Rathaus/Fünffensterstraße'], arr: [hms(7, 0), hms(7, 3), hms(7, 6)], dep: [hms(7, 0), hms(7, 3), hms(7, 6)] }],
  };
  const lines: MapLine[] = [
    { index: 0, ref: '5', from: 'Auestadion', to: 'Holländische Straße', stops: ['Auestadion', 'Am Weinberg', 'Rathaus', 'Friedrichsplatz'] },
    { index: 1, ref: '8', from: 'Hessenschanze', to: 'Kaufungen', stops: ['Querallee', 'Rathaus/Fünffensterstraße', 'Rathaus'] },
  ];
  const { json } = buildTimetable([f], lines, { towns: TOWNS });
  const p = json.lines[0].patterns[0];
  assert.deepEqual([p.s.map((i) => json.stops[i]), p.j, p.post, p.to], [['Auestadion', 'Am Weinberg'], [0, 1], 1, 'Rathaus/Fünffensterstraße']);
});

test('the credit: gtfs.de with its licence and everyone its feed names, once for two of its feeds', () => {
  const gtfsDe = { name: 'gtfs.de - GTFS für Deutschland, Daten bereitgestellt von DELFI e.V.', url: 'https://download.gtfs.de/germany/nv_free/latest.zip', orgs: ['DELFI e.V', 'GTFS.de', 'OpenStreetMap contributors'] };
  const text = attributionFor([gtfsDe, { ...gtfsDe, url: 'https://download.gtfs.de/germany/rv_free/latest.zip' }]);
  assert.equal(
    text,
    'Fahrplandaten: gtfs.de – GTFS für Deutschland (https://gtfs.de), Daten bereitgestellt von DELFI e.V. (https://www.delfi.de), mit Beiträgen von: OpenStreetMap contributors, Lizenz CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) – für das Spiel auf die Straßenbahnen und RegioTrams in Kassel gekürzt und umgerechnet',
  );
  assert.equal(attributionFor([gtfsDe], 'as given'), 'as given');
  assert.match(attributionFor([{ name: 'NVV', url: 'https://www.nvv.de', orgs: [] }]), /^Fahrplandaten: NVV \(https:\/\/www\.nvv\.de\) – /);
});

test('the same trips from two feeds are not doubled', async () => {
  const f = await feed();
  const twice = buildTimetable([f, f], LINES, { towns: TOWNS });
  assert.deepEqual(twice.json.lines, (await built()).json.lines);
});

// ---------------------------------------------------------------------------
// the questions of the game
// ---------------------------------------------------------------------------

async function timetable(): Promise<ReturnType<typeof parseTimetable>> {
  return parseTimetable((await built()).json);
}

test('departures from a stop: all lines, soonest first, not where trips end', async () => {
  const tt = await timetable();
  const wed8 = weekTime(3, hms(8, 0));
  assert.deepEqual(
    departures(tt, 'Am Stern', wed8, 10).map((d) => [d.ref, d.to, d.wait, d.line]),
    [
      ['1', 'Vellmar Nord', 120, 0],
      ['1', 'Vellmar Nord', 720, 0],
      ['1', 'Holländischer Platz/Universität', 3720, 2],
    ],
  );
  assert.equal(departures(tt, 'Am Stern', wed8, 1).length, 1);
  // Vellmar Nord: the trips out end there, the trips back begin there
  assert.deepEqual(
    departures(tt, 'Vellmar Nord', weekTime(3, hms(5, 50))).map((d) => [d.line, d.wait]),
    [
      [1, 600],
      [1, 1800],
      [1, 3000],
    ],
  );
  // the RegioTram leaves the last stop the map has of it: it goes on beyond
  assert.deepEqual(
    departures(tt, 'Hauptbahnhof', weekTime(2, hms(7, 0))).map((d) => [d.ref, d.to, d.wait]),
    [['RT4', 'Wolfhagen', 720]],
  );
  // Saturday has its own trips
  assert.deepEqual(
    departures(tt, 'Königsplatz', weekTime(6, hms(9, 0))).map((d) => d.wait),
    [hms(1, 0)],
  );
  assert.deepEqual(departures(tt, 'Nowhere', wed8), []);
});

test('departures after midnight: the trips of the day before, past 24:00', async () => {
  const tt = await timetable();
  // Thursday 00:30 – Wednesday's trip of 24:30 leaves Königsplatz now and Am Stern in two minutes
  const thu = weekTime(4, hms(0, 30));
  assert.deepEqual(
    departures(tt, 'Königsplatz', thu).map((d) => [d.wait, d.time]),
    [[0, hms(0, 30)]],
  );
  assert.deepEqual(
    departures(tt, 'Am Stern', thu).map((d) => [d.wait, d.trip.t0]),
    [[120, hms(0, 30)]],
  );
  // Saturday 00:30: Friday's trip of 24:30, a working day's
  assert.equal(departures(tt, 'Königsplatz', weekTime(6, hms(0, 30))).length, 1);
  // Monday 00:30: Sunday's trips are not the working days'
  assert.equal(departures(tt, 'Königsplatz', weekTime(1, hms(0, 30))).length, 0);
  // Tuesday 23:00, looking eight hours ahead: tonight's 24:30, and Wednesday's first trips back
  const late = departures(tt, 'Vellmar Nord', weekTime(2, hms(23, 0)), 2, 8 * 3600);
  assert.deepEqual(
    late.map((d) => [d.wait, d.time]),
    [
      [hms(7, 0), hms(30, 0)],
      [hms(7, 20), hms(30, 20)],
    ],
  );
  assert.deepEqual(
    departures(tt, 'Königsplatz', weekTime(2, hms(23, 0)), 1, 8 * 3600).map((d) => d.wait),
    [hms(1, 30)],
  );
});

test('trips under way: standing, between two stops, after midnight, about to leave', async () => {
  const tt = await timetable();
  // 08:05:30: the 08:00 stands at Holländischer Platz until 08:06; the 08:10 has not left yet
  const at = tripsAt(tt, 0, weekTime(3, hms(8, 5, 30)));
  assert.equal(at.length, 1);
  assert.deepEqual([at[0].t0, at[0].from, at[0].to, at[0].standing, at[0].frac, at[0].until], [hms(8, 0), 2, 3, true, 0, hms(8, 6)]);
  assert.equal(at[0].pattern.stops[at[0].from], 'Holländischer Platz/Universität');
  // (where that is on the line: its third stop)
  assert.equal(at[0].pattern.lineStops[at[0].from], 2);
  // asked with a lead of five minutes, the 08:10 waits at its first stop
  const lead = tripsAt(tt, 0, weekTime(3, hms(8, 5, 30)), 300);
  assert.deepEqual(
    lead.map((t) => [t.t0, t.from, t.standing, t.until]).sort((a, b) => Number(a[0]) - Number(b[0])),
    [
      [hms(8, 0), 2, true, hms(8, 6)],
      [hms(8, 10), 0, true, hms(8, 10)],
    ],
  );
  // 08:10: the 08:00 half way from Holländischer Platz (08:06) to Stadtmitte (08:14); the 08:10 just leaving
  const ten = tripsAt(tt, 0, weekTime(3, hms(8, 10))).sort((a, b) => a.t0 - b.t0);
  assert.deepEqual([ten[0].from, ten[0].to, ten[0].standing, ten[0].frac, ten[0].until], [2, 3, false, 0.5, hms(8, 14)]);
  assert.deepEqual([ten[1].from, ten[1].to, ten[1].standing, ten[1].frac], [0, 1, false, 0]);
  // Thursday 00:31: Wednesday's 24:30 between Königsplatz and Am Stern
  const night = tripsAt(tt, 0, weekTime(4, hms(0, 31)));
  assert.deepEqual(
    night.map((t) => [t.t0, t.from, t.to, t.frac]),
    [[hms(0, 30), 0, 1, 0.5]],
  );
  // at its last stop it is there until the minute it arrives, then gone
  assert.deepEqual(
    tripsAt(tt, 0, weekTime(3, hms(8, 20))).filter((t) => t.t0 === hms(8, 0)).map((t) => [t.from, t.to, t.standing]),
    [[4, 4, true]],
  );
  assert.equal(tripsAt(tt, 0, weekTime(3, hms(8, 20, 1))).filter((t) => t.t0 === hms(8, 0)).length, 0);
  assert.deepEqual(tripsAt(tt, 5, weekTime(3, hms(8, 0))), []);
});

test('the trip a tram standing at a stop belongs to, and how late it is', async () => {
  const tt = await timetable();
  const hol = 'Holländischer Platz/Universität';
  // due away 08:06 and 08:16
  const late = scheduledAt(tt, 0, hol, weekTime(3, hms(8, 8)));
  assert.deepEqual([late?.t0, late?.k, late?.time, late?.late], [hms(8, 0), 2, hms(8, 6), 120]);
  const early = scheduledAt(tt, 0, hol, weekTime(3, hms(8, 15)));
  assert.deepEqual([early?.t0, early?.late], [hms(8, 10), -60]);
  // half way between the two: late is likelier than early
  assert.equal(scheduledAt(tt, 0, hol, weekTime(3, hms(8, 11)))?.t0, hms(8, 0));
  // nothing due within the window
  assert.equal(scheduledAt(tt, 0, hol, weekTime(3, hms(12, 0))), null);
  assert.equal(scheduledAt(tt, 0, hol, weekTime(3, hms(8, 30)), 120), null);
  // at the end of its way the arrival counts
  assert.deepEqual([scheduledAt(tt, 0, 'Vellmar Nord', weekTime(3, hms(8, 21)))?.late], [60]);
  // after midnight
  assert.equal(scheduledAt(tt, 0, 'Am Stern', weekTime(4, hms(0, 33)))?.late, 60);
});

test('parsing: a timetable of another build of the lines loses the lines that do not match', async () => {
  const { json } = await built();
  const lines = { v: 1, lines: LINES.map((l) => ({ ref: l.ref, name: '', from: l.from, to: l.to, colour: '', kind: 0, paths: [], stops: [] })) };
  assert.equal(parseTimetable(json, lines).lines.filter(Boolean).length, 5);
  lines.lines[3].ref = '9';
  const tt = parseTimetable(json, lines);
  assert.equal(tt.lines[3], undefined);
  assert.equal(tt.lines.filter(Boolean).length, 4);
  assert.throws(() => parseTimetable({ ...json, version: 2 }));
});

// ---------------------------------------------------------------------------
// the clock in Kassel
// ---------------------------------------------------------------------------

test('the clock in Kassel: summer time and its changes', () => {
  assert.equal(berlinOffset(Date.UTC(2026, 0, 15, 12)), 3600);
  assert.equal(berlinOffset(Date.UTC(2026, 6, 1, 12)), 7200);
  // the clocks go forward on 29 March 2026 at 01:00 UTC, back on 25 October at 01:00 UTC
  assert.deepEqual(berlinClock(new Date(Date.UTC(2026, 2, 29, 0, 59, 59))), { y: 2026, m: 3, d: 29, weekday: 0, s: hms(1, 59, 59) });
  assert.equal(berlinClock(new Date(Date.UTC(2026, 2, 29, 1))).s, hms(3, 0));
  assert.equal(berlinClock(new Date(Date.UTC(2026, 9, 25, 0, 59, 59))).s, hms(2, 59, 59));
  assert.equal(berlinClock(new Date(Date.UTC(2026, 9, 25, 1))).s, hms(2, 0));
  // late evening in UTC is already the next day in Kassel
  assert.deepEqual(berlinClock(new Date(Date.UTC(2026, 10, 17, 23, 30))), { y: 2026, m: 11, d: 18, weekday: 3, s: hms(0, 30) });
});

test('day types: weekends, the holidays of Hesse, Christmas Eve', () => {
  assert.deepEqual(easter(2026), [4, 5]);
  assert.deepEqual(easter(2027), [3, 28]);
  assert.deepEqual(easter(2024), [3, 31]);
  assert.equal(dayTypeOf(2026, 11, 18), DAY.WEEKDAY);
  assert.equal(dayTypeOf(2026, 11, 21), DAY.SATURDAY);
  assert.equal(dayTypeOf(2026, 11, 22), DAY.SUNDAY);
  for (const [m, d] of [
    [1, 1],
    [4, 3],
    [4, 6],
    [5, 1],
    [5, 14],
    [5, 25],
    [6, 4],
    [10, 3],
    [12, 25],
    [12, 26],
  ]) {
    assert.ok(isHoliday(2026, m, d), `${d}.${m}.2026`);
    assert.equal(dayTypeOf(2026, m, d), DAY.SUNDAY, `${d}.${m}.2026`);
  }
  // Repentance Day is a holiday in Saxony only
  assert.equal(dayTypeOf(2026, 11, 18), DAY.WEEKDAY);
  assert.equal(dayTypeOf(2026, 12, 24), DAY.SATURDAY);
  assert.equal(dayTypeOf(2026, 12, 31), DAY.SATURDAY);
});

test('a moment as the timetable sees it: the day types around it', () => {
  // Wednesday 18 November 2026, 08:00 in Kassel
  assert.deepEqual(serviceTime(new Date(Date.UTC(2026, 10, 18, 7))), { s: hms(8, 0), day: DAY.WEEKDAY, prev: DAY.WEEKDAY, next: DAY.WEEKDAY });
  // New Year's Day 2027, half past midnight: a holiday after New Year's Eve, before a Saturday
  assert.deepEqual(serviceTime(new Date(Date.UTC(2026, 11, 31, 23, 30))), { s: hms(0, 30), day: DAY.SUNDAY, prev: DAY.SATURDAY, next: DAY.SATURDAY });
  // Monday after Easter 2026, in summer time
  assert.deepEqual(serviceTime(new Date(Date.UTC(2026, 3, 6, 10))), { s: hms(12, 0), day: DAY.SUNDAY, prev: DAY.SUNDAY, next: DAY.WEEKDAY });
  assert.deepEqual(weekTime(1, 3600), { s: 3600, day: DAY.WEEKDAY, prev: DAY.SUNDAY, next: DAY.WEEKDAY });
  assert.deepEqual(weekTime(0, 0), { s: 0, day: DAY.SUNDAY, prev: DAY.SATURDAY, next: DAY.WEEKDAY });
});
