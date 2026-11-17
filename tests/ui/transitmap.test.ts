// SPDX-License-Identifier: AGPL-3.0-only
// The trams and buses on the map (src/ui/transitmap.ts): the colours of the lines, where a bus is along its line, the departures at a stop.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KVG_TRAM_COLOURS, LINE_PALETTE, alongBusLine, courseLength, lineColour, paletteColour, parseColour, pointAlong, stopDepartures, textOn } from '../../src/ui/transitmap.ts';
import { parseTimetable } from '../../src/sim/timetable.ts';
import type { ServiceTime } from '../../src/sim/timetable.ts';
import type { StopPlace } from '../../src/world/stops.ts';
import { STOP_FLAG } from '../../src/world/types.ts';
import type { TimetableJson } from '../../src/world/types.ts';

test('colours as the data gives them: with or without #, short, or by name', () => {
  assert.equal(parseColour('#00954B'), '#00954b');
  // (GTFS route_color comes without the #)
  assert.equal(parseColour('00954B'), '#00954b');
  assert.equal(parseColour('#0a5'), '#00aa55');
  assert.equal(parseColour('red'), '#ff0000');
  assert.equal(parseColour(' LightGreen '), '#90ee90');
  assert.equal(parseColour('nonsense'), null);
  assert.equal(parseColour('#12345'), null);
  assert.equal(parseColour(''), null);
  assert.equal(parseColour(undefined), null);
});

test("a line's own colour first, then the KVG's tram colours, then the palette", () => {
  // the timetable's or the line file's colour wins – the first that is one
  assert.equal(lineColour('tram', '1', '', 'not a colour', '#123456'), '#123456');
  assert.equal(lineColour('bus', '52', 'blue'), '#0000ff');
  assert.equal(lineColour('bus', '52', '1F6E43'), '#1f6e43');
  // a Kassel tram line without one in the data: the KVG's colour
  assert.equal(lineColour('tram', '1'), KVG_TRAM_COLOURS['1']);
  assert.equal(lineColour('tram', '4', ''), '#f08100');
  // (a bus of the same number is not a tram line)
  assert.notEqual(lineColour('bus', '1'), KVG_TRAM_COLOURS['1']);
  // others: from the palette, always the same for a line, different for neighbouring numbers
  assert.ok(LINE_PALETTE.includes(lineColour('bus', '52')));
  assert.equal(lineColour('bus', '52'), lineColour('bus', '52', null, ''));
  for (let n = 10; n < 10 + LINE_PALETTE.length - 1; n++) assert.notEqual(paletteColour('bus', String(n)), paletteColour('bus', String(n + 1)));
  assert.equal(paletteColour('tram', 'RT4'), paletteColour('tram', 'RT4'));
  assert.ok(LINE_PALETTE.includes(lineColour('tram', 'RT4')));
  assert.notEqual(paletteColour('tram', 'RT1'), paletteColour('tram', 'RT4'));
});

test('writing on a colour: dark on light ones, white on dark ones', () => {
  assert.equal(textOn('#fbba00'), '#111111');
  assert.equal(textOn('#ffffff'), '#111111');
  assert.equal(textOn('#0069b4'), '#ffffff');
  assert.equal(textOn('#7f5ca3'), '#ffffff');
  assert.equal(textOn('red'), '#ffffff');
});

test('a point along a course, and its heading', () => {
  const c = [0, 0, 100, 0, 100, 50];
  assert.equal(courseLength(c), 150);
  const a = pointAlong(c, 30);
  assert.ok(a && Math.abs(a.x - 30) < 1e-9 && a.z === 0);
  // heading east: yaw −90°
  assert.ok(a && Math.abs(a.yaw + Math.PI / 2) < 1e-9);
  const b = pointAlong(c, 120);
  assert.ok(b && b.x === 100 && Math.abs(b.z - 20) < 1e-9);
  // heading south: yaw 180°
  assert.ok(b && Math.abs(Math.abs(b.yaw) - Math.PI) < 1e-9);
  // beyond its end: its end
  const e = pointAlong(c, 999);
  assert.ok(e && e.x === 100 && e.z === 50);
  assert.equal(pointAlong([5, 5], 1), null);
});

test('where a bus is between two stops of its line: along the ways of the line', () => {
  // three ways of 100 m each: east, east, south
  const courses = new Map<number, number[]>([
    [10, [0, 0, 100, 0]],
    [12, [100, 0, 200, 0]],
    [14, [200, 0, 200, 100]],
  ]);
  const line = { ways: [10, 12, 14], stops: [{ k: 0, m: 20 }, { k: 2, m: 30 }, { k: 2, m: 90 }] };
  const course = (w: number): number[] | null => courses.get(w) ?? null;
  // 80 + 100 + 30 = 210 m from the first stop to the second
  const at0 = alongBusLine(line, 0, 1, 0, course);
  assert.ok(at0 && Math.abs(at0.x - 20) < 1e-9 && at0.z === 0);
  const half = alongBusLine(line, 0, 1, 0.5, course);
  assert.ok(half && Math.abs(half.x - 125) < 1e-9 && half.z === 0, JSON.stringify(half));
  const there = alongBusLine(line, 0, 1, 1, course);
  assert.ok(there && there.x === 200 && Math.abs(there.z - 30) < 1e-9);
  // on one way: between its two stops
  const same = alongBusLine(line, 1, 2, 0.5, course);
  assert.ok(same && same.x === 200 && Math.abs(same.z - 60) < 1e-9);
  // a way whose course is not known: no place
  assert.equal(alongBusLine({ ways: [10, 99, 14], stops: line.stops }, 0, 1, 0.5, course), null);
  assert.equal(alongBusLine(line, 7, 8, 0.5, course), null);
});

test('departures at a tram stop of a timetable that knows the stops by name only', () => {
  const json: TimetableJson = {
    version: 1,
    generated: '2026-11-01T00:00:00Z',
    feeds: [],
    valid: ['2026-01-01', '2026-12-31'],
    week: ['2026-11-02', '2026-11-08'],
    days: ['2026-11-02', '2026-11-07', '2026-11-08'],
    attribution: 'test',
    stops: ['Hauptbahnhof', 'Rathaus', 'Wilhelmshöhe'],
    lines: [{ line: 0, ref: '1', patterns: [{ s: [0, 1, 2], j: [0, 1, 2], d: [0, 120, 300], to: 'Wilhelmshöhe', t: [[8 * 3600, 8 * 3600 + 600, 8 * 3600 + 1200], [], []] }] }],
  };
  const tt = parseTimetable(json);
  const at: ServiceTime = { s: 8 * 3600 + 100, day: 0, prev: 0, next: 0 };
  const place: StopPlace = { id: 41, name: 'Rathaus', town: 'Kassel', kind: STOP_FLAG.TRAM, x: 0, z: 0, poles: [], platforms: [] };
  const list = stopDepartures(tt, place, at, 3);
  assert.equal(list.length, 3);
  assert.equal(list[0].ref, '1');
  assert.equal(list[0].to, 'Wilhelmshöhe');
  // (the first leaves the Hauptbahnhof at 8:00 and the Rathaus two minutes later: 20 s from now)
  assert.equal(list[0].wait, 20);
  // a bus stop of the same name: no trams there
  assert.equal(stopDepartures(tt, { ...place, kind: STOP_FLAG.BUS }, at, 3).length, 0);
});
