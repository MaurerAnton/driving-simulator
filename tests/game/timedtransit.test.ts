// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The trams of the traffic keep to the timetables: a tram is at a stop when
 * the departure board there says – it arrives a little before the minute the
 * board counts down to and leaves at it (src/game/timedtransit.ts with
 * src/sim/rail.ts).  First on a made-up line, then – where the map is there
 * (tests/realmap.ts) – on the real tracks and timetables of Kassel.
 *
 *   node --test tests/game/timedtransit.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARRIVE_EARLY, paceFor, tramSchedule } from '../../src/game/timedtransit.ts';
import { RailTraffic } from '../../src/sim/rail.ts';
import type { RailVehicle } from '../../src/sim/rail.ts';
import { boardRows } from '../../src/sim/stopboards.ts';
import { departures, parseTimetable, serviceTime } from '../../src/sim/timetable.ts';
import type { Timetable } from '../../src/sim/timetable.ts';
import { tripName } from '../../src/ui/transitmap.ts';
import { RAIL } from '../../src/world/types.ts';
import type { LinesJson, RailJson, TimetableJson } from '../../src/world/types.ts';
import { haveMap, mapDir } from '../realmap.ts';

/** A Wednesday morning in Kassel, 08:00 (07:00 UTC in winter time). */
const START = Date.UTC(2026, 10, 18, 7, 0, 0);

interface Stand {
  trip: string;
  /** when it came to stand and when it left again (s after START) */
  from: number;
  to: number;
  path: number;
  mark: number;
}

/** Run the trams for `seconds`, the clock with them; note every stand of a tram of the timetable at a stop. */
function simulate(rail: RailTraffic, clock: { ms: number }, player: { x: number; y: number; z: number; yaw: number; length: number; width: number }, seconds: number, dt = 0.2): Stand[] {
  const stands: Stand[] = [];
  const open = new Map<RailVehicle, Stand>();
  for (let t = 0; t < seconds; t += dt) {
    rail.update(dt, player);
    clock.ms += dt * 1000;
    const now = (clock.ms - START) / 1000;
    for (const v of rail.vehicles) {
      const standing = v.speed === 0 && v.dwell > 0 && v.trip !== undefined;
      const st = open.get(v);
      if (standing && !st) {
        const p = rail.net.paths[v.path];
        const mark = p.stops.find((m) => Math.abs(m - v.s) < 4);
        if (mark !== undefined) open.set(v, { trip: v.trip!, from: now, to: Infinity, path: v.path, mark });
      } else if (!standing && st) {
        st.to = now;
        stands.push(st);
        open.delete(v);
      }
    }
    for (const [v, st] of open) {
      if (!rail.vehicles.includes(v)) {
        st.to = now;
        stands.push(st);
        open.delete(v);
      }
    }
  }
  for (const st of open.values()) stands.push(st);
  return stands;
}

test('the speed to keep: the distance in the time, starting and stopping included', () => {
  assert.equal(paceFor(500, 0), Infinity, 'no time left: as fast as it may');
  assert.equal(paceFor(5000, 60), Infinity, 'too far to make it');
  const v = paceFor(600, 120);
  assert.ok(v > 5 && v < 7, `600 m in two minutes: a little faster than 5 m/s (${v.toFixed(2)})`);
  assert.ok(Math.abs(600 / v + v * (0.5 + 0.5 / 1.04) - 120) < 1e-6);
});

test('a made-up line: the tram stands at each stop of its trip when the board there says, passes the one it does not call at', () => {
  // a straight track east, 3 km; stops at 300 (A), 900 (X: not called at), 1500 (B), 2400 (C)
  const pts: number[] = [];
  for (let x = 0; x <= 3000; x += 10) pts.push(x, 100, 0);
  const rails: RailJson[] = [{ k: RAIL.TRAM, p: pts, a: [], b: [], st: [300, 900, 1500, 2400], sn: ['A', 'X', 'B', 'C'] } as RailJson];
  const lines: LinesJson = { v: 1, lines: [{ ref: '1', name: '1', from: 'A', to: 'C', colour: '', kind: 0, paths: [[0, 1]], stops: [[0, 300], [0, 900], [0, 1500], [0, 2400]] }] };
  // trips every 10 minutes from 08:02 on: A → B in 4 minutes (fast for 1.2 km: the tram has to get going), B → C in 2 (900 m: it must hurry)
  const starts = Array.from({ length: 6 }, (_, i) => 8 * 3600 + 120 + i * 600);
  const json: TimetableJson = {
    version: 2, generated: '', feeds: [], valid: ['2026-01-01', '2026-12-31'], week: ['2026-11-16', '2026-11-22'], days: ['2026-11-18', '2026-11-21', '2026-11-22'], attribution: '',
    stops: ['A', 'X', 'B', 'C'],
    lines: [{ line: 0, ref: '1', patterns: [{ s: [0, 2, 3], j: [0, 2, 3], d: [0, 240, 360], to: 'C', t: [starts, [], []] }] }],
  };
  const tt = parseTimetable(json, lines);
  const rail = new RailTraffic(rails, () => 0.5);
  rail.setLines([{ ref: '1', from: 'A', to: 'C', colour: '', kind: 0, seq: [{ path: 0, dir: 1 }] }]);
  const clock = { ms: START };
  rail.schedule = tramSchedule({ timetable: () => tt, lines: () => lines, rail: () => rail, nowMs: () => clock.ms });
  const player = { x: 1500, y: 100, z: 40, yaw: 0, length: 4, width: 2 };
  const stands = simulate(rail, clock, player, 1500);
  // every trip of the hour: at B, from a little before its departure on the board until it
  for (const t0 of starts.slice(0, 2)) {
    const dep = t0 + 240 - 8 * 3600;
    const at = stands.find((s) => s.mark === 1500 && s.from > dep - 120 && s.from < dep + 60);
    assert.ok(at, `a tram at B for the departure at ${dep} s (${JSON.stringify(stands.filter((s) => s.mark === 1500))})`);
    assert.ok(at.from <= dep && at.from >= dep - ARRIVE_EARLY - 45, `in a little before its time: ${(dep - at.from).toFixed(0)} s`);
    assert.ok(Math.abs(at.to - dep) < 3, `leaves on time: ${(at.to - dep).toFixed(1)} s`);
  }
  assert.equal(stands.filter((s) => s.mark === 900).length, 0, 'X is passed');
  // the board at B, two minutes before a departure: it counts down to the tram that comes
  // (the clock jumped, as when the player sets another time: the trams are put anew – game.ts clockJumped)
  clock.ms = START + (starts[3] + 240 - 8 * 3600 - 120) * 1000;
  rail.resync();
  const rows = boardRows(tt, { id: -1, name: 'B' }, serviceTime(new Date(clock.ms)));
  assert.ok(rows && rows[0].minutes === 2, `the board says 2 min (${JSON.stringify(rows)})`);
  const more = simulate(rail, clock, player, 150);
  const dep = starts[3] + 240 - 8 * 3600;
  const at = more.find((s) => s.mark === 1500 && s.trip === `0:0:${starts[3]}`);
  assert.ok(at && at.from <= dep && at.from > dep - 75 && Math.abs(at.to - dep) < 3, `the tram it counted down to: ${JSON.stringify(at)} for ${dep}`);
});

test('the real tracks and timetables: at a busy stop every tram the board announces comes, within a minute of its time', { skip: !haveMap && 'no map' }, async () => {
  const { MapLoader } = await import('../../src/world/loader.ts');
  const { diskFiles } = await import('../../tools/mapgen/mapfiles.ts');
  const map = await MapLoader.open(diskFiles(mapDir));
  const lines = await map.lines();
  const tj = await map.timetable();
  if (!lines || !tj) return;
  const tt: Timetable = parseTimetable(tj, lines);
  const rail = new RailTraffic(await map.rails(), () => 0.5);
  const paths = rail.net.paths;
  rail.setLines(lines.lines.map((l) => ({ ref: l.ref, from: l.from, to: l.to, colour: l.colour, kind: l.kind, seq: l.paths.every(([p]) => p < paths.length) ? l.paths.map(([p, d]) => ({ path: p, dir: d > 0 ? 1 : -1 })) : [] })));
  const clock = { ms: START };
  rail.schedule = tramSchedule({ timetable: () => tt, lines: () => lines, rail: () => rail, nowMs: () => clock.ms });
  // the stop with the most departures between 08:05 and 08:20
  const at0 = serviceTime(new Date(START));
  let best = '';
  let most = 0;
  for (const name of tt.calls.keys()) {
    const n = departures(tt, name, at0, 60, 1200).filter((d) => d.kind === 'tram' && d.wait > 300).length;
    if (n > most) {
      most = n;
      best = name;
    }
  }
  assert.ok(best && most >= 4, 'a busy tram stop');
  // where it is: the mark of one of its calls
  const call = tt.calls.get(best)!.find((c) => c.pattern.line.kind === 'tram' && lines.lines[c.pattern.line.index]?.stops[c.pattern.lineStops[c.k]]);
  assert.ok(call);
  const [path, mark] = lines.lines[call.pattern.line.index].stops[call.pattern.lineStops[call.k]];
  const smp = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };
  rail.net.sample(path, mark, smp);
  // (the player a few metres beside the platform, out of the trams' way)
  const player = { x: smp.x - smp.tz * 12, y: smp.y, z: smp.z + smp.tx * 12, yaw: 0, length: 4, width: 2 };
  const stands = simulate(rail, clock, player, 1300, 0.25);
  // the marks of that stop (one per direction, perhaps more)
  const marks = new Set<string>();
  for (const c of tt.calls.get(best)!) {
    const st = lines.lines[c.pattern.line.index]?.stops[c.pattern.lineStops[c.k]];
    if (st) marks.add(`${st[0]}:${st[1]}`);
  }
  const here = stands.filter((s) => [...marks].some((m) => m === `${s.path}:${s.mark}`) || [...marks].some((m) => { const [p, k] = m.split(':').map(Number); return p === s.path && Math.abs(k - s.mark) < 1.5; }));
  const board = departures(tt, best, at0, 60, 1200).filter((d) => d.kind === 'tram' && d.wait > 300 && d.k < d.trip.pattern.stops.length - 1);
  const missing: string[] = [];
  let late = 0;
  const off: number[] = [];
  for (const d of board) {
    const dep = d.time - at0.s;
    // its tram: standing there from a little before until the departure
    const trip = tripName('tram', d.line, d.trip.pattern, d.trip.t0);
    const st = here.find((s) => s.trip === trip && s.from <= dep + 60 && s.to >= dep - 60);
    if (!st) {
      missing.push(`${d.ref} → ${d.to} ${Math.round(dep)} s`);
      continue;
    }
    off.push(Math.round(st.to - dep));
    if (Math.abs(st.to - dep) > 60) late++;
  }
  console.log(`${best} (${path}:${mark}, marks ${[...marks].join(' ')}): ${board.length} departures on the board, ${here.length} stands there of ${stands.length}, trams about ${rail.vehicles.length}; left at (s after the board's time) ${off.join(' ')}; missing ${missing.length}: ${missing.join('; ')}`);
  assert.ok(missing.length <= Math.floor(board.length / 6), `the trams the board announces come (${missing.length} of ${board.length} missing: ${missing.join('; ')})`);
  assert.ok(late <= Math.floor(board.length / 6), `within a minute of their time (${late} not)`);
});

test('a bus of the timetable: put where its trip is, it stands at each stop of its trip until the time the board says', async () => {
  const { makeTown } = await import('./town.ts');
  const { SignalSystem } = await import('../../src/sim/signals.ts');
  const { Traffic, stopPlaceOf } = await import('../../src/sim/traffic.ts');
  const { BusLines, encodeWays } = await import('../../src/world/buslines.ts');
  const { busSchedule } = await import('../../src/game/timedtransit.ts');
  // a town of 4 × 3 junctions, 120 m apart; line 5 east along the middle row, south at the third column, east along the bottom row
  const town = makeTown({ cols: 4, rows: 3, block: 120 });
  const way = (i0: number, j0: number, i1: number, j1: number): number => {
    const e = town.street(i0, j0, i1, j1);
    return e * 2 + (town.json.edges[e].a === town.node(i0, j0) ? 0 : 1);
  };
  const ways = [way(0, 1, 1, 1), way(1, 1, 2, 1), way(2, 1, 2, 2), way(2, 2, 3, 2)];
  const lines = new BusLines({ v: 1, map: '', places: 30, lines: [{ ref: '5', name: 'Bus 5', from: '', to: 'Ostfriedhof', operator: '', colour: '', kind: 0, osm: 0, w: encodeWays(ways), st: [10, 1, 60, 11, 2, 60, 12, 3, 70] }] });
  const traffic = new Traffic(town.world, town.lanes, new SignalSystem(town.world.signals));
  traffic.setBusLines(lines);
  traffic.busStops = () => [];
  traffic.busShare = 0;
  traffic.targetCount = 1;
  // trips at 08:02 and 08:12: a minute from stop to stop
  const json: TimetableJson = {
    version: 2, generated: '', feeds: [], valid: ['2026-01-01', '2026-12-31'], week: ['2026-11-16', '2026-11-22'], days: ['2026-11-18', '2026-11-21', '2026-11-22'], attribution: '', stops: [], lines: [],
    bus: { map: '', places: 30, stops: [[10, 'Mitte'], [11, 'Ecke'], [12, 'Süd']], dests: ['Ostfriedhof'], lines: [{ line: 0, ref: '5', osm: 0, s: [10, 11, 12], patterns: [{ j: [0, 1, 1], d: [0, 60, 60], to: [0, 0], t: [[8 * 3600 + 120, 600], [], []] }] }] },
  };
  const tt = parseTimetable(json);
  const course = (w: number): Float32Array | null => {
    const p = town.world.edges[w >> 1]?.pl.pts;
    if (!p) return null;
    const pts: number[] = [];
    for (let i = 0; i + 2 < p.length; i += 3) pts.push(p[i], p[i + 2]);
    const out = new Float32Array(pts.length);
    if ((w & 1) === 0) out.set(pts);
    else for (let i = 0; i < pts.length; i += 2) [out[i], out[i + 1]] = [pts[pts.length - 2 - i], pts[pts.length - 1 - i]];
    return out;
  };
  const src = { timetable: () => tt, now: () => serviceTime(new Date(clock.ms)), tramLine: () => null, tramSpot: () => null, tramCourse: () => null, busLines: () => lines, wayCourse: course, stops: () => null };
  const clock = { ms: START };
  traffic.busSchedule = busSchedule({ timetable: () => tt, source: () => src, traffic: () => traffic, nowMs: () => clock.ms });
  const player = { x: 180, y: 160, z: 120, yaw: 0, speed: 0, length: 0.5, width: 0.5 };
  // where each bus of a trip stood, and from when to when (s after 08:00)
  const stood: Array<{ trip: string; place: number; from: number; to: number }> = [];
  const open = new Map<number, { trip: string; place: number; from: number; to: number }>();
  for (let t = 0; t < 900; t += 1 / 15) {
    traffic.update(1 / 15, player);
    clock.ms += 1000 / 15;
    const now = (clock.ms - START) / 1000;
    for (const c of traffic.cars) {
      const b = c.bus;
      if (!b?.trip && !b?.retired) continue;
      const st = open.get(c.id);
      if (b.dwell > 0 && !st) open.set(c.id, { trip: b.trip ?? '', place: stopPlaceOf(b.served), from: now, to: Infinity });
      else if (b.dwell <= 0 && st) {
        st.to = now;
        stood.push(st);
        open.delete(c.id);
      }
    }
  }
  const at = (place: number, dep: number) => stood.find((s) => s.place === place && s.from <= dep && s.to >= dep - 5);
  for (const [place, dep] of [[10, 120], [11, 180], [10, 720], [11, 780]]) {
    const st = at(place, dep);
    assert.ok(st, `a bus at stop ${place} for ${dep} s (${JSON.stringify(stood)})`);
    assert.ok(Math.abs(st.to - dep) < 3, `leaves on time: ${(st.to - dep).toFixed(1)} s`);
  }
  // the board at stop 10 counted down to that bus
  const rows = departures(tt, 10, serviceTime(new Date(START + 60_000)), 2);
  assert.equal(rows[0].time - 8 * 3600, 120);
  assert.equal(traffic.cars.filter((c) => c.bus?.trip).length <= 2, true, 'one bus per trip');
});
