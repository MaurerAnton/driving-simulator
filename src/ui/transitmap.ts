// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Public transport on the big map: every tram and bus that runs now by the
 * timetables (src/sim/timetable.ts, at the game's clock) as a small round
 * sign in its line's colour with the line's number, moving along its line;
 * the stops, once the map is close enough, with their next departures at a
 * tap; and at a tap on a vehicle a small menu beside it – show its line's
 * whole way, or attach the camera to it (it goes with the vehicle while it
 * runs on, src/game/spectate.ts).  The menu follows the vehicle on the map.
 *
 * Where a vehicle is comes from the timetable alone: between which two stops
 * of its line it is and how far, laid onto the line's way – a tram's along
 * its tracks, a bus's along the roads its line takes (src/world/buslines.ts).
 *
 * A line's colour is its own where the data has one (OpenStreetMap's colour
 * of the route, or the GTFS feed's route_color), else the KVG's colour of a
 * Kassel tram line, else one of a fixed palette chosen by the line's number –
 * the same line always in the same colour, neighbouring numbers in different
 * ones.  The colour choice and the way along a bus line are plain functions
 * (tested in tests/ui/transitmap.test.ts); the rest is drawing and the DOM.
 */
import { departures, runningAt } from '../sim/timetable.ts';
import type { Departure, Running, ServiceTime, Timetable, TimetablePattern, TransitKind } from '../sim/timetable.ts';
import type { BusLines } from '../world/buslines.ts';
import type { StopPlace, Stops } from '../world/stops.ts';
import { STOP_FLAG } from '../world/types.ts';
import { formatUnit, tr } from '../i18n/index.ts';

// ---------------------------------------------------------------- colours

/** The colours of the KVG's tram lines in Kassel (its network map; OpenStreetMap tags the routes so) – for data without them. */
export const KVG_TRAM_COLOURS: Readonly<Record<string, string>> = {
  '1': '#00954b',
  '2': '#0069b4',
  '3': '#95c11f',
  '4': '#f08100',
  '5': '#7f5ca3',
  '6': '#8a4f38',
  '7': '#fbba00',
  '8': '#00a5df',
};

/** Colours for lines that have none: clearly different from each other, readable on the dark map and on photographs. */
export const LINE_PALETTE: readonly string[] = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45',
  '#469990', '#9a6324', '#800000', '#808000', '#000075', '#e6beff', '#ffd8b1', '#aaffc3',
];

/** The colour names OpenStreetMap's route relations use (CSS names), as #rrggbb. */
const NAMED: Readonly<Record<string, string>> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', darkred: '#8b0000', maroon: '#800000', crimson: '#dc143c',
  green: '#008000', darkgreen: '#006400', lightgreen: '#90ee90', lime: '#00ff00', limegreen: '#32cd32', olive: '#808000',
  blue: '#0000ff', darkblue: '#00008b', navy: '#000080', lightblue: '#add8e6', skyblue: '#87ceeb', royalblue: '#4169e1',
  steelblue: '#4682b4', cyan: '#00ffff', aqua: '#00ffff', teal: '#008080', turquoise: '#40e0d0', yellow: '#ffff00',
  gold: '#ffd700', orange: '#ffa500', darkorange: '#ff8c00', orangered: '#ff4500', purple: '#800080', violet: '#ee82ee',
  magenta: '#ff00ff', fuchsia: '#ff00ff', pink: '#ffc0cb', hotpink: '#ff69b4', brown: '#a52a2a', chocolate: '#d2691e',
  grey: '#808080', gray: '#808080', silver: '#c0c0c0', darkgrey: '#a9a9a9', darkgray: '#a9a9a9', lightgrey: '#d3d3d3',
  lightgray: '#d3d3d3', beige: '#f5f5dc', khaki: '#f0e68c', salmon: '#fa8072', coral: '#ff7f50', tomato: '#ff6347',
  indigo: '#4b0082', darkviolet: '#9400d3', plum: '#dda0dd', tan: '#d2b48c', sienna: '#a0522d',
};

/**
 * A colour as the data gives it – "#00954B", "00954B" (GTFS route_color has
 * no #), "#0a5", or a name ("red") – as #rrggbb; null where it is none.
 */
export function parseColour(c: string | null | undefined): string | null {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  if (!s) return null;
  const hex = s.startsWith('#') ? s.slice(1) : s;
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex)) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  return NAMED[s] ?? null;
}

/** The palette's colour of a line without one of its own: by its number (1, 2, 3 … one after the other), else by its name. */
export function paletteColour(kind: TransitKind, ref: string): string {
  const n = /^\d+$/.test(ref) ? Number(ref) : NaN;
  let k: number;
  if (Number.isFinite(n)) k = n;
  else {
    // (a small, stable hash of the name: the same line always gets the same colour)
    let h = kind === 'tram' ? 7 : 3;
    for (let i = 0; i < ref.length; i++) h = (h * 31 + ref.charCodeAt(i)) >>> 0;
    k = h;
  }
  return LINE_PALETTE[k % LINE_PALETTE.length];
}

/**
 * The colour a line is shown in: the first colour of its own that the data
 * gives (`given`, in order of preference – the timetable's, then the line
 * file's), else for a Kassel tram line the KVG's, else the palette's.
 */
export function lineColour(kind: TransitKind, ref: string, ...given: Array<string | null | undefined>): string {
  for (const g of given) {
    const c = parseColour(g);
    if (c) return c;
  }
  if (kind === 'tram' && KVG_TRAM_COLOURS[ref]) return KVG_TRAM_COLOURS[ref];
  return paletteColour(kind, ref);
}

/** Dark or white writing on a colour, whichever reads better (by its relative luminance). */
export function textOn(colour: string): string {
  const c = parseColour(colour) ?? '#808080';
  const lin = (i: number): number => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
  return l > 0.36 ? '#111111' : '#ffffff';
}

// ---------------------------------------------------------------- where the vehicles are

/** A point on a line and the way a vehicle there faces (yaw: 0 north, positive to the left). */
export interface Spot {
  x: number;
  z: number;
  yaw: number;
  /** a bus: the way of its line it is on (index into the line's ways) */
  k?: number;
}

/** What the map needs of the game to show the trams and buses (made in src/game/spectate.ts: transitSource). */
export interface TransitSource {
  timetable(): Timetable | null;
  /** the moment the world is at (the game's clock), as the timetable sees it */
  now(): ServiceTime;
  /** a tram line of lines.json.gz: its colour, and its stops as (piece of track, mark) */
  tramLine(index: number): { colour: string; stops: ReadonlyArray<readonly [number, number]> } | null;
  /** where a tram of line `index` is that left stop a for stop b and did the share `frac` of the way (null: not on its tracks) */
  tramSpot(index: number, a: readonly [number, number], b: readonly [number, number], frac: number): Spot | null;
  /** the course of a tram line along its tracks: x, z, … (null: not known) */
  tramCourse(index: number): ArrayLike<number> | null;
  busLines(): BusLines | null;
  /** the course of a way (a road in one direction, src/world/routegraph.ts) as it is driven: x, z, … (null: not known yet) */
  wayCourse(way: number): ArrayLike<number> | null;
  stops(): Stops | null;
}

/** A tram or bus under way, with where it is now. */
export interface MapVehicle {
  run: Running;
  /** the trip by name: for a tram as the trams of the traffic know it ("line:pattern:t0"), a bus's with "b:" before */
  trip: string;
  x: number;
  z: number;
  yaw: number;
  colour: string;
}

/** Metres along a course (x, z, …) to a point: the point and the heading there – null for a course without length. */
export function pointAlong(course: ArrayLike<number>, m: number): Spot | null {
  const n = course.length >> 1;
  if (n < 2) return null;
  let left = Math.max(0, m);
  let last: Spot | null = null;
  for (let i = 0; i + 1 < n; i++) {
    const ax = course[i * 2];
    const az = course[i * 2 + 1];
    const dx = course[i * 2 + 2] - ax;
    const dz = course[i * 2 + 3] - az;
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) continue;
    const yaw = Math.atan2(-dx, -dz);
    if (left <= l) return { x: ax + (dx * left) / l, z: az + (dz * left) / l, yaw };
    left -= l;
    last = { x: ax + dx, z: az + dz, yaw };
  }
  return last;
}

/** The length of a course (x, z, …). */
export function courseLength(course: ArrayLike<number>): number {
  let len = 0;
  for (let i = 2; i + 1 < course.length; i += 2) len += Math.hypot(course[i] - course[i - 2], course[i + 1] - course[i - 1]);
  return len;
}

/**
 * Where a bus is that left stop `a` of its line (index into `line.stops`)
 * for stop `b` and did the share `frac` of the way: along the line's ways,
 * whose courses `course` gives.  Null where a way's course is not known.
 */
export function alongBusLine(
  line: { ways: ArrayLike<number>; stops: ReadonlyArray<{ k: number; m: number }> },
  a: number,
  b: number,
  frac: number,
  course: (way: number) => ArrayLike<number> | null,
): Spot | null {
  const sa = line.stops[a];
  if (!sa) return null;
  let sb = line.stops[b] ?? sa;
  // (a stop that lies behind the first one: stand at the first)
  if (sb.k < sa.k || (sb.k === sa.k && sb.m < sa.m)) sb = sa;
  const lens: number[] = [];
  for (let k = sa.k; k <= sb.k; k++) {
    const w = line.ways[k];
    const c = w === undefined || w < 0 ? null : course(w);
    if (!c) return null;
    lens.push(courseLength(c));
  }
  const total = sa.k === sb.k ? sb.m - sa.m : lens[0] - sa.m + lens.slice(1, -1).reduce((s, l) => s + l, 0) + sb.m;
  let left = Math.max(0, Math.min(1, frac)) * Math.max(0, total);
  let k = sa.k;
  let at = Math.min(sa.m, lens[0]);
  while (k < sb.k && at + left > lens[k - sa.k]) {
    left -= lens[k - sa.k] - at;
    at = 0;
    k++;
  }
  const p = pointAlong(course(line.ways[k]) as ArrayLike<number>, at + left);
  return p ? { ...p, k } : null;
}

/** The name of a trip: a tram's as the trams of the traffic (game.ts railSchedule) know it. */
export function tripName(kind: TransitKind, line: number, pattern: TimetablePattern, t0: number): string {
  const p = pattern.line.patterns.indexOf(pattern);
  return kind === 'tram' ? `${line}:${p}:${t0}` : `b:${line}:${p}:${t0}`;
}

/** Between two stop places (their numbers in stops.json.gz), by the share of the way – a straight line where nothing better is known. */
function betweenPlaces(stops: Stops | null, a: number, b: number, frac: number): Spot | null {
  const pa = a >= 0 ? stops?.places[a] : undefined;
  if (!pa) return null;
  const pb = (b >= 0 ? stops?.places[b] : undefined) ?? pa;
  const f = Math.max(0, Math.min(1, frac));
  const dx = pb.x - pa.x;
  const dz = pb.z - pa.z;
  return { x: pa.x + dx * f, z: pa.z + dz * f, yaw: dx || dz ? Math.atan2(-dx, -dz) : 0 };
}

/** What spotOf needs of a trip under way (a Running has it all). */
export type TripSpot = Pick<Running, 'kind' | 'line' | 'fromStop' | 'toStop' | 'fromPlace' | 'toPlace' | 'standing' | 'frac'>;

/** Where a trip under way is now: along its line's way where that is known, else between its stops. */
export function spotOf(src: TransitSource, run: TripSpot): Spot | null {
  const frac = run.standing ? 0 : run.frac;
  if (run.kind === 'tram') {
    const line = src.tramLine(run.line);
    const a = run.fromStop >= 0 ? line?.stops[run.fromStop] : undefined;
    if (a) {
      const b = (run.toStop >= 0 ? line?.stops[run.toStop] : undefined) ?? a;
      const s = src.tramSpot(run.line, a, b, frac);
      if (s) return s;
    }
  } else {
    const line = src.busLines()?.lines[run.line];
    if (line && run.fromStop >= 0) {
      const s = alongBusLine(line, run.fromStop, run.toStop >= 0 ? run.toStop : run.fromStop, frac, (w) => src.wayCourse(w));
      if (s) return s;
    }
  }
  return betweenPlaces(src.stops(), run.fromPlace, run.toPlace, frac);
}

/** Every trip under way at a moment, where it is (those whose place is not known are left out). */
export function vehiclesAt(src: TransitSource, tt: Timetable, at: ServiceTime, colour: (kind: TransitKind, line: number, ref: string, own: string) => string): MapVehicle[] {
  const out: MapVehicle[] = [];
  for (const run of runningAt(tt, at)) {
    const s = spotOf(src, run);
    if (!s) continue;
    out.push({ run, trip: tripName(run.kind, run.line, run.pattern, run.t0), x: s.x, z: s.z, yaw: s.yaw, colour: colour(run.kind, run.line, run.ref, run.colour) });
  }
  return out;
}

/**
 * The next departures from a stop place: the buses and trams that call
 * there – and at a tram stop of a timetable that knows the trams' stops only
 * by their names, the trams of that name.
 */
export function stopDepartures(tt: Timetable, place: StopPlace, at: ServiceTime, n = 6): Departure[] {
  let list = departures(tt, place.id, at, n);
  if ((place.kind & STOP_FLAG.TRAM) !== 0 && !list.some((d) => d.kind === 'tram')) {
    const trams = departures(tt, place.name, at, n).filter((d) => d.kind === 'tram');
    if (trams.length > 0) list = [...list, ...trams].sort((x, y) => x.time - y.time).slice(0, n);
  }
  return list;
}

// ---------------------------------------------------------------- the layer on the big map

/** Watching a vehicle: what game/spectate.ts needs to find it and follow it. */
export interface WatchRequest {
  kind: TransitKind;
  line: number;
  ref: string;
  colour: string;
  dest: string;
  pattern: TimetablePattern;
  t0: number;
  trip: string;
}

export interface TransitMapHost {
  lang(): string;
  source(): TransitSource | null;
  /** may a vehicle be watched now (a free drive)? */
  canWatch(): boolean;
  watch(v: WatchRequest): void;
  /** draw the map again */
  redraw(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** from this zoom on (px per metre) the stops of the buses are drawn – the trams' the map draws itself from 0.05 on */
const BUS_STOPS_FROM = 0.45;
/** below this zoom the vehicles are dots without their numbers */
const SMALL_BELOW = 0.035;
/** how far from a vehicle's sign a tap still chooses it (px) – a fingertip's width */
const TAP_REACH = 28;

export class TransitLayer {
  private readonly host: TransitMapHost;
  /** the trams and buses are shown (the switch at the foot of the map) */
  shown = true;
  private list: MapVehicle[] = [];
  private listAt = -1e9;
  private readonly colours = new Map<string, string>();
  private view = { W: 0, H: 0, s: 1, cx: 0, cz: 0 };
  private pop: HTMLElement | null = null;
  private timer = 0;
  /** what the small window shows: a vehicle (by its trip) or a stop */
  private sel: { kind: 'vehicle'; trip: string } | { kind: 'stop'; place: StopPlace } | null = null;
  /** the line whose way is shown */
  private line: { kind: TransitKind; index: number; colour: string } | null = null;
  private popAt = 0;

  constructor(host: TransitMapHost) {
    this.host = host;
  }

  private t(key: string, p?: Record<string, string | number>): string {
    return tr(key, this.host.lang(), p);
  }

  /** The map opened: the small window goes into its column (`before`: in front of this element), and the vehicles move on. */
  attach(ui: HTMLElement, before: Element | null): void {
    this.pop = el('div', 'bm-pop');
    this.pop.hidden = true;
    ui.insertBefore(this.pop, before);
    this.sel = null;
    this.list = [];
    this.listAt = -1e9;
    // once a second: the vehicles a step further (the map drawn again only if one is in view), the minutes of the departures counted down
    this.timer = window.setInterval(() => {
      if (this.shown && this.anyInView()) this.host.redraw();
      if (this.sel && performance.now() - this.popAt > 10000) this.render();
    }, 1000);
  }

  detach(): void {
    clearInterval(this.timer);
    this.timer = 0;
    this.pop?.remove();
    this.pop = null;
    this.sel = null;
  }

  /** The switch at the foot of the map: trams and buses on or off. */
  toggle(): HTMLElement {
    const l = el('label', 'bm-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = this.shown;
    box.onchange = () => {
      this.shown = box.checked;
      if (!this.shown) this.closePopup();
      this.host.redraw();
    };
    l.append(box, el('span', '', this.t('transitShow')));
    return l;
  }

  closePopup(): void {
    this.sel = null;
    this.menuAt = null;
    if (this.pop) this.pop.hidden = true;
  }

  /** where the menu of a vehicle was put last (px of the map), so that it is moved only when its vehicle has */
  private menuAt: { x: number; y: number } | null = null;

  /**
   * The menu of the vehicle chosen, beside it: below its sign – above, where
   * there is no room below – and within the map, so that neither the
   * vehicle nor the menu is covered by the other.
   */
  private placeMenu(x: number, y: number): void {
    const pop = this.pop;
    if (!pop || pop.hidden || this.sel?.kind !== 'vehicle') return;
    if (this.menuAt && Math.abs(this.menuAt.x - x) < 0.5 && Math.abs(this.menuAt.y - y) < 0.5) return;
    this.menuAt = { x, y };
    const { W, H } = this.view;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const gap = 26;
    const left = Math.max(8, Math.min(W - w - 8, x - w / 2));
    const below = y + gap;
    const top = below + h <= H - 64 || y - gap - h < 8 ? Math.min(below, Math.max(8, H - h - 8)) : y - gap - h;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  /** The colour of a line (worked out once). */
  colourOf(kind: TransitKind, line: number, ref: string, own: string): string {
    const key = `${kind}:${line}:${ref}`;
    let c = this.colours.get(key);
    if (!c) {
      const src = this.host.source();
      const file = kind === 'tram' ? src?.tramLine(line) : src?.busLines()?.lines[line];
      c = lineColour(kind, ref, own, file?.colour);
      // (kept once the line's file is read: before, its own colour may not be known yet)
      if (file) this.colours.set(key, c);
    }
    return c;
  }

  /** Is a tram or bus (or the line shown) within the part of the map in view? */
  private anyInView(): boolean {
    const src = this.host.source();
    const tt = src?.timetable();
    if (!src || !tt) return false;
    if (this.line) return true;
    const { W, H, s, cx, cz } = this.view;
    const hw = W / 2 / s + 30;
    const hh = H / 2 / s + 30;
    return this.vehicles(src, tt).some((v) => Math.abs(v.x - cx) < hw && Math.abs(v.z - cz) < hh);
  }

  /** The vehicles now (worked out at most once a second). */
  private vehicles(src: TransitSource, tt: Timetable): MapVehicle[] {
    const now = performance.now();
    if (now - this.listAt > 900) {
      this.listAt = now;
      this.list = vehiclesAt(src, tt, src.now(), (k, l, r, o) => this.colourOf(k, l, r, o));
    }
    return this.list;
  }

  /** Draw the trams, the buses and the stops (in screen pixels: x east to the right, z south downwards). */
  draw(g: CanvasRenderingContext2D, W: number, H: number, s: number, cx: number, cz: number): void {
    this.view = { W, H, s, cx, cz };
    if (!this.shown) return;
    const src = this.host.source();
    if (!src) return;
    const sx = (x: number): number => W / 2 + (x - cx) * s;
    const sy = (z: number): number => H / 2 + (z - cz) * s;
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // the way of the line asked for
    if (this.line) {
      const courses = this.lineCourses(src, this.line.kind, this.line.index);
      g.strokeStyle = this.line.colour;
      g.globalAlpha = 0.75;
      g.lineWidth = Math.max(4, Math.min(9, 6 * s));
      g.beginPath();
      for (const c of courses) {
        for (let i = 0; i + 1 < c.length; i += 2) {
          if (i === 0) g.moveTo(sx(c[0]), sy(c[1]));
          else g.lineTo(sx(c[i]), sy(c[i + 1]));
        }
      }
      g.stroke();
      g.globalAlpha = 1;
    }
    // the stops of the buses, close up (the trams' are drawn by the map)
    const stops = src.stops();
    if (stops && s >= BUS_STOPS_FROM) {
      const big = s >= 1.1;
      for (const p of stops.near(cx, cz, Math.max(W, H) / 2 / s + 30)) {
        if ((p.kind & STOP_FLAG.BUS) === 0 || (p.kind & STOP_FLAG.TRAM) !== 0) continue;
        const x = sx(p.x);
        const y = sy(p.z);
        if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
        const r = big ? 7 : 4.5;
        g.fillStyle = '#f6d31b';
        g.strokeStyle = '#0b6b3a';
        g.lineWidth = 1.6;
        g.beginPath();
        g.rect(x - r, y - r, r * 2, r * 2);
        g.fill();
        g.stroke();
        if (big) {
          g.fillStyle = '#0b6b3a';
          g.font = '800 10px system-ui, sans-serif';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText('H', x, y + 0.5);
        }
      }
    }
    // the stop chosen
    if (this.sel?.kind === 'stop') {
      const p = this.sel.place;
      g.strokeStyle = '#ffffff';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(sx(p.x), sy(p.z), 12, 0, Math.PI * 2);
      g.stroke();
    }
    // the vehicles
    const tt = src.timetable();
    if (tt) {
      const list = this.vehicles(src, tt);
      const small = s < SMALL_BELOW;
      const chosen = this.sel?.kind === 'vehicle' ? this.sel.trip : '';
      let top: MapVehicle | null = null;
      for (const v of list) {
        if (v.trip === chosen) top = v;
        else this.drawVehicle(g, v, sx(v.x), sy(v.z), small, false);
      }
      if (top) this.drawVehicle(g, top, sx(top.x), sy(top.z), small, true);
      // (the menu of the vehicle chosen goes with it)
      if (top) this.placeMenu(sx(top.x), sy(top.z));
    }
    g.restore();
  }

  private drawVehicle(g: CanvasRenderingContext2D, v: MapVehicle, x: number, y: number, small: boolean, chosen: boolean): void {
    const { W, H } = this.view;
    if (x < -24 || y < -24 || x > W + 24 || y > H + 24) return;
    const dim = this.line !== null && (this.line.kind !== v.run.kind || this.line.index !== v.run.line);
    g.globalAlpha = dim ? 0.45 : 1;
    if (small && !chosen) {
      g.fillStyle = v.colour;
      g.strokeStyle = '#0c1218';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(x, y, 3.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.globalAlpha = 1;
      return;
    }
    const ref = v.run.ref || '?';
    const r = ref.length >= 3 ? 12 : 10;
    // a point towards where it goes
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    g.fillStyle = v.colour;
    g.strokeStyle = '#0c1218';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x + fx * (r + 6), y + fz * (r + 6));
    g.lineTo(x + fx * r * 0.4 - fz * r * 0.75, y + fz * r * 0.4 + fx * r * 0.75);
    g.lineTo(x + fx * r * 0.4 + fz * r * 0.75, y + fz * r * 0.4 - fx * r * 0.75);
    g.closePath();
    g.fill();
    g.stroke();
    // the round sign: a tram's with a white ring, a bus's with a dark one
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = chosen ? 3 : 1.6;
    g.strokeStyle = chosen ? '#ffffff' : v.run.kind === 'tram' ? '#f4f6f8' : '#0c1218';
    g.stroke();
    g.fillStyle = textOn(v.colour);
    g.font = `800 ${ref.length >= 3 ? 9 : 11}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(ref, x, y + 0.5);
    g.globalAlpha = 1;
  }

  /** The courses that make up a line's way (a tram's along its tracks, a bus's along the roads). */
  private lineCourses(src: TransitSource, kind: TransitKind, index: number): Array<ArrayLike<number>> {
    if (kind === 'tram') {
      const c = src.tramCourse(index);
      return c ? [c] : [];
    }
    const line = src.busLines()?.lines[index];
    const out: Array<ArrayLike<number>> = [];
    if (!line) return out;
    for (let k = 0; k < line.end; k++) {
      const w = line.ways[k];
      const c = w >= 0 ? src.wayCourse(w) : null;
      if (c) out.push(c);
    }
    return out;
  }

  /** A tap at a point of the map (px from its upper left corner): a vehicle or a stop there? Then its small window opens. */
  tap(px: number, py: number): boolean {
    if (!this.shown || !this.pop) return false;
    const src = this.host.source();
    if (!src) return false;
    const { W, H, s, cx, cz } = this.view;
    const sx = (x: number): number => W / 2 + (x - cx) * s;
    const sy = (z: number): number => H / 2 + (z - cz) * s;
    // a vehicle (the nearest within reach of a finger)
    // (a finger covers more than the sign: within TAP_REACH of its middle counts)
    let best: MapVehicle | null = null;
    let bd = s < SMALL_BELOW ? TAP_REACH * 0.7 : TAP_REACH;
    for (const v of this.list) {
      const d = Math.hypot(sx(v.x) - px, sy(v.z) - py);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    if (best) {
      this.sel = { kind: 'vehicle', trip: best.trip };
      this.render();
      this.placeMenu(sx(best.x), sy(best.z));
      this.host.redraw();
      return true;
    }
    // a stop: the trams' from far off (the map draws them), the buses' close up
    const stops = src.stops();
    if (stops && s >= 0.05) {
      let place: StopPlace | null = null;
      let pd = 15;
      for (const p of stops.near(cx + (px - W / 2) / s, cz + (py - H / 2) / s, 20 / s)) {
        const tram = (p.kind & STOP_FLAG.TRAM) !== 0;
        if (!tram && ((p.kind & STOP_FLAG.BUS) === 0 || s < BUS_STOPS_FROM)) continue;
        const d = Math.hypot(sx(p.x) - px, sy(p.z) - py);
        if (d < pd) {
          pd = d;
          place = p;
        }
      }
      if (place) {
        this.sel = { kind: 'stop', place };
        this.render();
        this.host.redraw();
        return true;
      }
    }
    return false;
  }

  /** Fill the small window for what is chosen. */
  private render(): void {
    const pop = this.pop;
    const sel = this.sel;
    if (!pop) return;
    if (!sel) {
      pop.hidden = true;
      return;
    }
    this.popAt = performance.now();
    const src = this.host.source();
    const tt = src?.timetable() ?? null;
    pop.replaceChildren();
    pop.hidden = false;
    const head = el('div', 'bm-head');
    const close = el('button', 'bm-x', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', this.t('realityClose'));
    close.onclick = () => {
      this.closePopup();
      this.host.redraw();
    };
    pop.classList.toggle('bm-ctx', sel.kind === 'vehicle');
    if (sel.kind !== 'vehicle') {
      pop.style.left = '';
      pop.style.top = '';
    }
    if (sel.kind === 'vehicle') {
      const v = this.list.find((q) => q.trip === sel.trip);
      if (!v || !src) {
        // (its trip is over)
        this.closePopup();
        return;
      }
      const run = v.run;
      const title = el('div', 'bm-pop-title');
      title.append(this.badge(run.kind, run.ref, v.colour), el('b', '', run.dest || run.toName));
      head.append(title, close);
      pop.append(head);
      const now = src.now().s;
      const mins = Math.max(0, Math.round((run.until - now) / 60));
      const line = run.standing ? this.t('transitAt', { stop: run.fromName || '?' }) : this.t('transitNext', { stop: run.toName || '?', min: mins });
      pop.append(el('small', '', `${this.t(run.kind === 'tram' ? 'transitTram' : 'transitBus')} ${run.ref} · ${line}`));
      // the two things to do with it, side by side: its line's whole way on the map, the camera on it
      const row = el('div', 'bm-row bm-ctx-row');
      const shown = this.line?.kind === run.kind && this.line.index === run.line;
      const lineBtn = el('button', shown ? 'btn' : 'btn ghost', this.t(shown ? 'transitLineHide' : 'transitLine'));
      lineBtn.type = 'button';
      lineBtn.setAttribute('aria-pressed', String(shown));
      lineBtn.onclick = () => {
        this.line = shown ? null : { kind: run.kind, index: run.line, colour: v.colour };
        this.render();
        this.host.redraw();
      };
      const watch = el('button', 'btn', this.t('transitAttach'));
      watch.type = 'button';
      // (not while a lesson or a tour runs: then it says why)
      if (!this.host.canWatch()) {
        watch.disabled = true;
        watch.title = this.t('transitAttachNot');
      }
      watch.onclick = () => {
        if (this.host.canWatch()) this.host.watch({ kind: run.kind, line: run.line, ref: run.ref, colour: v.colour, dest: run.dest, pattern: run.pattern, t0: run.t0, trip: v.trip });
      };
      row.append(lineBtn, watch);
      pop.append(row);
      if (!this.host.canWatch()) pop.append(el('small', '', this.t('transitAttachNot')));
      this.menuAt = null;
      return;
    }
    // a stop: its next departures
    const p = sel.place;
    const title = el('div', 'bm-pop-title');
    title.append(el('b', '', p.name || this.t('tramStop')));
    if (p.town) title.append(el('small', '', p.town));
    head.append(title, close);
    pop.append(head);
    if (!tt || !src) {
      pop.append(el('small', '', this.t('transitNoTimetable')));
      return;
    }
    const at = src.now();
    const list = stopDepartures(tt, p, at, 6);
    if (list.length === 0) {
      pop.append(el('small', '', this.t('transitNone')));
      return;
    }
    const ul = el('ul', 'bm-deps');
    for (const d of list) {
      const li = el('li');
      const colour = this.colourOf(d.kind, d.line, d.ref, d.colour);
      const when = d.wait < 60 ? this.t('transitNow') : d.wait < 3600 ? formatUnit(Math.floor(d.wait / 60), 'minute', this.host.lang()) : clock(d.time);
      li.append(this.badge(d.kind, d.ref, colour), el('span', '', d.to), el('i', '', when));
      ul.append(li);
    }
    pop.append(ul);
  }

  /** The line's number on its colour. */
  private badge(kind: TransitKind, ref: string, colour: string): HTMLElement {
    const b = el('span', `bm-line ${kind}`, ref || '?');
    b.style.background = colour;
    b.style.color = textOn(colour);
    return b;
  }
}

/** Seconds after midnight as the clock shows them ("7:05"; past midnight counted on). */
function clock(t: number): string {
  const s = ((Math.round(t) % 86400) + 86400) % 86400;
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}
