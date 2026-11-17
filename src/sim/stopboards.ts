// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the departure displays at the stops show, and where there is one.
 *
 * A display at a stop place shows the next trams and buses that leave there
 * by the timetables (src/sim/timetable.ts): rows of line, destination and
 * minutes, and the time of day – at the moment the game says, since its
 * clock need not be the real one.  It is asked by the stop place (its number
 * in stops.json.gz), not by the name: there is a "Rathaus" in every town.
 *
 * Which pole gets which display: a big board (three rows and the clock) where
 * OpenStreetMap says there is one, at a stop with a shelter and at the trams'
 * stops; a small one (two rows) at a simple pole – and none where no tram or
 * bus of the timetables calls.  The drawing is in src/render/stopmodels.ts
 * (DepartureBoard) and src/render/transit.ts; this part is kept apart so that
 * it can be tested without a browser.
 */
import { STOP_FLAG } from '../world/types.ts';
import { departures } from './timetable.ts';
import type { ServiceTime, Timetable, TransitKind } from './timetable.ts';

/** One row of a display: the line, where it goes, and in how many minutes it leaves (0: now) – or, an hour and more ahead, at what time ("14:35"). */
export interface BoardRow {
  line: string;
  destination: string;
  minutes: number | string;
  kind: TransitKind;
  /** the line's colour ('' where it has none) */
  colour: string;
}

/** A stop place as the displays need it: its number in stops.json.gz and its name. */
export interface BoardPlace {
  id: number;
  name: string;
}

/** The sizes of display: the big board on a post of its own, and the small one beside a simple pole. */
export type DisplaySize = 'board' | 'small';

/** Does the timetable know trams or buses that call at this stop place?  (A file of version 1 knows the trams' stops by name only.) */
export function servedAt(tt: Timetable, place: BoardPlace): boolean {
  return tt.placeCalls.size > 0 ? tt.placeCalls.has(place.id) : tt.calls.has(place.name);
}

/**
 * The rows a display at a stop place shows at a moment: the next `n`
 * departures of its trams and buses within `horizon` seconds, soonest first
 * – null where the timetable knows nothing of the place (its display shows
 * what it can without).
 */
export function boardRows(tt: Timetable, place: BoardPlace, at: ServiceTime, n = 3, horizon = 2 * 3600): BoardRow[] | null {
  if (!servedAt(tt, place)) return null;
  const list = tt.placeCalls.size > 0 ? departures(tt, place.id, at, n, horizon) : departures(tt, place.name, at, n, horizon);
  return list.map((d) => {
    const m = Math.floor(d.wait / 60);
    return { line: d.ref, destination: d.to, minutes: m < 60 ? Math.max(0, m) : clockText(d.time), kind: d.kind, colour: d.colour };
  });
}

/** A time of day as a display shows it, seconds after midnight → "07:05" (past midnight too: 25:10 is "01:10"). */
export function clockText(s: number): string {
  const m = Math.floor(s / 60);
  const h = (((Math.floor(m / 60) % 24) + 24) % 24).toString().padStart(2, '0');
  return `${h}:${(((m % 60) + 60) % 60).toString().padStart(2, '0')}`;
}

/**
 * The display a pole of a stop gets (by its STOP_FLAG bits and its place's
 * kind), where trams or buses of the timetables call (`served`): the big
 * board where OpenStreetMap maps one (with or without a timetable: it shows
 * the clock at least), at a pole with a shelter and at a stop of the trams;
 * the small one at any other pole; none where nothing calls.
 */
export function displayAt(poleFlags: number, placeKind: number, served: boolean): DisplaySize | null {
  if (poleFlags & STOP_FLAG.BOARD) return 'board';
  if (!served) return null;
  if (poleFlags & STOP_FLAG.SHELTER || placeKind & (STOP_FLAG.TRAM | STOP_FLAG.RAIL)) return 'board';
  return 'small';
}
