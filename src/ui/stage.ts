// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The main menu as a stage.  The 3D picture is the menu: the vehicle chosen
 * stands large in the middle of it, where the drive will begin, and the
 * camera slowly circles it (game.ts places the vehicle, `stageFrame` below
 * says from where it is seen).  A swipe – or the arrows at the edges, the
 * arrow keys, a gamepad – brings the next vehicle; a strip of round icons
 * jumps to a kind of vehicle (cars, motorcycles, trucks …); small badges
 * name its licence class; one big round button starts the drive.
 *
 * Everything else waits behind small round buttons and opens in a sheet over
 * the lower part of the screen: where to start (a pin), what to do (free
 * drive, lessons, the test, a demonstration drive …), the vehicle's options
 * (gearbox, engine, trailer), and at the top the language, the map, what is
 * new, the settings and the rest.  Text only where a picture cannot say it:
 * names – and labels on hover, on a long press and for screen readers.
 *
 * The two menus of before stay (carousel.ts, and the simple list in
 * hud.ts); the settings choose, and each menu can switch to another.
 *
 * What the menu decides – the order of the vehicles, what can be done with
 * one, where it starts, how the camera frames it – are pure functions at the
 * top of this file (tests/ui/stage.test.ts); the page is built below them.
 */
import type { AddressHit } from '../game/address.ts';
import { LESSONS } from '../game/nav.ts';
import type { LessonDef } from '../game/nav.ts';
import type { Settings } from '../game/settings.ts';
import { RUN_SPEEDS, saveSettings } from '../game/settings.ts';
import { ROAD_VEHICLE_KINDS, VEHICLES, VEHICLE_KINDS, powerOf } from '../game/vehicles.ts';
import type { VehicleDef, VehicleKind } from '../game/vehicles.ts';
import { lessonIntro, lessonTitle } from '../i18n/index.ts';
import type { Lang } from '../i18n/index.ts';
import type { SpawnJson } from '../world/types.ts';
import type { MenuPreview } from './carousel.ts';
import type { RunwayChoice, StartRequest, TramStopChoice } from './hud.ts';

// ===================================================================== what the menu decides

/** What the menu needs to know of a vehicle (a VehicleDef has all of it). */
type KindInfo = Pick<VehicleDef, 'kind' | 'model' | 'licence' | 'trailer'>;

/**
 * The kind of vehicle a vehicle belongs to in the strip of round icons: the
 * cars, the motorcycles, the trucks, the buses …  A model the menu does not
 * know is a kind of its own (a crane is recognised by its name).
 */
export function groupOf(d: Pick<VehicleDef, 'kind' | 'model'>): string {
  switch (d.model) {
    case 'car':
      return 'car';
    case 'motorcycle':
      return 'moto';
    case 'truck':
    case 'truckLight':
    case 'truckHeavy':
    case 'semi':
      return 'truck';
    case 'bus':
    case 'minibus':
      return 'bus';
    case 'tractor':
      return 'tractor';
    case 'tram':
      return 'tram';
    case 'plane':
      return 'plane';
    case 'walker':
      return 'foot';
  }
  return /crane/i.test(`${d.kind} ${String(d.model)}`) ? 'crane' : String(d.model || d.kind);
}

/** A kind of vehicle in the strip: its vehicles, in the order of the licence classes. */
export interface StageGroup {
  id: string;
  kinds: VehicleKind[];
}

/** The kinds of vehicle, in the order their first vehicle comes in `kinds` (the order of the licence classes). */
export function stageGroups(kinds: readonly VehicleKind[] = VEHICLE_KINDS, defs: Readonly<Record<string, KindInfo | undefined>> = VEHICLES): StageGroup[] {
  const groups: StageGroup[] = [];
  for (const k of kinds) {
    const d = defs[k];
    if (!d) continue;
    const id = groupOf(d);
    const g = groups.find((x) => x.id === id);
    if (g) g.kinds.push(k);
    else groups.push({ id, kinds: [k] });
  }
  return groups;
}

const wrap = (i: number, n: number): number => ((i % n) + n) % n;

/** The next (step 1) or the previous (−1) vehicle: kind after kind, and round again after the last. */
export function cycleVehicle(groups: readonly StageGroup[], current: VehicleKind, step: number): VehicleKind {
  const order = groups.flatMap((g) => g.kinds);
  if (order.length === 0) return current;
  return order[wrap(Math.max(0, order.indexOf(current)) + step, order.length)];
}

/** The vehicle of the next (or the previous) kind: the one last chosen of that kind, else its first. */
export function cycleGroup(groups: readonly StageGroup[], current: VehicleKind, step: number, last: ReadonlyMap<string, VehicleKind> = new Map()): VehicleKind {
  if (groups.length === 0) return current;
  const g = groups[wrap(Math.max(0, groups.findIndex((x) => x.kinds.includes(current))) + step, groups.length)];
  const was = last.get(g.id);
  return was !== undefined && g.kinds.includes(was) ? was : g.kinds[0];
}

/**
 * The same vehicle with a trailer, or without its trailer: its licence class
 * with an E (B → BE, C1 → C1E …) or without it.  Null: there is none.
 */
export function trailerPartner(kind: VehicleKind, defs: Readonly<Record<string, KindInfo | undefined>> = VEHICLES): VehicleKind | null {
  const d = defs[kind];
  if (!d?.licence) return null;
  const want = d.trailer ? (d.licence.endsWith('E') ? d.licence.slice(0, -1) : '') : `${d.licence}E`;
  if (!want) return null;
  for (const [k, o] of Object.entries(defs)) {
    if (o && k !== kind && o.licence === want && !!o.trailer !== !!d.trailer && groupOf(o) === groupOf(d)) return k as VehicleKind;
  }
  return null;
}

/**
 * A vehicle's name without the licence class in brackets at its end – the
 * badge beside it says that ("Car (class B)" → "Car", "小汽车（B 类）" → "小汽车").
 * A name whose brackets say something else stays as it is.
 */
export function shortName(name: string, licence: string): string {
  if (!licence) return name;
  const m = /^(.*?)\s*[(（]([^()（）]*)[)）]\s*$/.exec(name);
  if (!m || !m[1]) return name;
  const code = licence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${code}($|[^A-Za-z0-9])`).test(m[2]) ? m[1].replace(/[\s,،、]+$/, '') : name;
}

/** Something the player can do with a vehicle. */
export interface StageMode {
  /** what the drive is started with: 'free', 'demo', 'tour', 'show' or the id of a lesson */
  id: string;
  /** a drive of one's own, a lesson, a test */
  group: 'drive' | 'lesson' | 'exam';
  lesson?: LessonDef;
}

/**
 * What can be done with a kind of vehicle – what the other menus offer for
 * it, in their order: the drives of one's own, then its lessons (those on the
 * practice yard first, the test last).
 */
export function stageModes(kind: VehicleKind, hasYard: boolean, lessons: readonly LessonDef[] = LESSONS): StageMode[] {
  // (a vehicle of the road: not the tram on its tracks, not the aeroplane, not on foot)
  const road = ROAD_VEHICLE_KINDS.includes(kind);
  const out: StageMode[] = [{ id: 'free', group: 'drive' }];
  // (the drives the vehicle does by itself and the tours are on the roads – the tram's on its tracks)
  // (the aeroplane's is a demonstration flight: its autopilot takes off, flies round the field and lands)
  if (kind === 'tram' || kind === 'plane' || road) out.push({ id: 'demo', group: 'drive' });
  if (road) out.push({ id: 'tour', group: 'drive' });
  // the test place: every model of the game on the practice yard
  if (kind !== 'tram' && kind !== 'plane' && hasYard) out.push({ id: 'show', group: 'drive' });
  const rank = (k: string): number => (k === 'yard' ? 0 : k === 'exam' ? 2 : 1);
  const fits = lessons.filter((l) => (l.vehicles ? l.vehicles.includes(kind) : l.vehicle ? l.vehicle === kind : road && !(l.notFor ?? []).includes(kind)) && (l.kind !== 'yard' || hasYard));
  for (const l of [...fits].sort((a, b) => rank(a.kind) - rank(b.kind))) out.push({ id: l.id, group: l.kind === 'exam' ? 'exam' : 'lesson', lesson: l });
  return out;
}

/** The way to play that was chosen, if this vehicle has it – else the first (the free drive). */
export function pickMode(modes: readonly { id: string }[], wanted: string): string {
  return modes.some((m) => m.id === wanted) ? wanted : (modes[0]?.id ?? 'free');
}

/** Where the drive would begin, as the menu shows it and starts it. */
export interface StagePlace {
  /** what the drive is started with (but for its mode) */
  request: Omit<StartRequest, 'mode'>;
  /** the vehicle standing there, for the picture behind the menu (null: not known yet) */
  preview: MenuPreview | null;
  /** the town (for the aeroplane: the airfield; '' at an address) and the place in it */
  town: string;
  name: string;
  /** the aeroplane: the end of the runway (its number) */
  runway?: string;
  /** 'loading': the places of this vehicle are not read yet; 'none': the map has none */
  state: 'ok' | 'loading' | 'none';
}

export const tramKey = (t: TramStopChoice): string => `${t.name}|${t.town}`;
export const runwayKey = (r: RunwayChoice): string => `${r.field}|${r.end}`;

/**
 * Where the drive of this vehicle would begin: the start point or address of
 * the last drive – the tram at a stop (one in the middle of Kassel at
 * first), the aeroplane at the end of a runway.  As the other menus do it.
 */
export function stagePlace(kind: VehicleKind, last: Settings['lastStart'], spawns: readonly SpawnJson[], tramStops: readonly TramStopChoice[] | null, runways: readonly RunwayChoice[] | null): StagePlace {
  const spawn = Math.min(last.spawn, Math.max(0, spawns.length - 1));
  const missing = (list: readonly unknown[] | null): StagePlace => ({ request: { spawn }, preview: null, town: '', name: '', state: list ? 'none' : 'loading' });
  if (kind === 'plane') {
    if (!runways || runways.length === 0) return missing(runways);
    const r = runways[Math.max(0, runways.findIndex((x) => runwayKey(x) === last.runway))];
    return { request: { spawn, runway: r }, preview: { kind, x: r.x, z: r.z, yaw: r.yaw }, town: r.field, name: r.end, runway: r.end, state: 'ok' };
  }
  if (kind === 'tram') {
    if (!tramStops || tramStops.length === 0) return missing(tramStops);
    let at = tramStops.findIndex((x) => tramKey(x) === last.tramStop);
    if (at < 0) at = Math.max(0, tramStops.findIndex((x) => x.name === 'Königsplatz'));
    const t = tramStops[at];
    return { request: { spawn, stop: t }, preview: { kind, x: t.x, z: t.z, yaw: 0, stop: t }, town: t.town, name: t.name, state: 'ok' };
  }
  if (spawns.length === 0) return missing([]);
  const address = last.address ?? undefined;
  const sp = spawns[spawn];
  return {
    request: { spawn, address },
    preview: address ? { kind, x: address.x, z: address.z, yaw: sp.yaw } : { kind, x: sp.x, z: sp.z, yaw: sp.yaw },
    town: address ? '' : (sp.g ?? ''),
    name: address ? address.label : sp.name,
    state: 'ok',
  };
}

/**
 * A place tapped on the map (opened from this menu): the drive is to begin
 * there – for the tram at the stop nearest to it, for the aeroplane at the
 * nearest end of a runway, for everything else at that very place.  Changes
 * `last`; false: nothing fits (the stops or runways are not read yet).
 */
export function startFromSpot(kind: VehicleKind, last: Settings['lastStart'], spot: Pick<SpawnJson, 'name' | 'x' | 'z'>, tramStops: readonly TramStopChoice[] | null, runways: readonly RunwayChoice[] | null, unnamed = ''): boolean {
  const nearest = <T extends { x: number; z: number }>(list: readonly T[] | null): T | null => {
    let best: T | null = null;
    let d = Infinity;
    for (const p of list ?? []) {
      const e = Math.hypot(p.x - spot.x, p.z - spot.z);
      if (e < d) {
        d = e;
        best = p;
      }
    }
    return best;
  };
  if (kind === 'tram') {
    const t = nearest(tramStops);
    if (t) last.tramStop = tramKey(t);
    return t !== null;
  }
  if (kind === 'plane') {
    const r = nearest(runways);
    if (r) last.runway = runwayKey(r);
    return r !== null;
  }
  last.address = { label: spot.name || unnamed, street: spot.name, x: spot.x, z: spot.z, exact: false };
  return true;
}

/** Where the camera of the stage stands: at `angle` round the vehicle, `dist` from its middle and `rise` above it, aimed `aim` above (− below) its middle. */
export interface StageFrame {
  angle: number;
  dist: number;
  rise: number;
  aim: number;
  /** the vertical field of view (degrees) */
  fov: number;
}

/** How tall the models are (m). */
const HEIGHT: Partial<Record<string, number>> = { car: 1.5, motorcycle: 1.4, walker: 1.8, plane: 2.6, tractor: 3, minibus: 2.8, bus: 3.2, truckLight: 3.4, truck: 3.8, tram: 3.6 };

/**
 * How far a vehicle reaches from the middle the camera circles (m) – its
 * longer end, its half span, the trailer behind it – and how tall it is.
 * `radius`: the circle the menu of rows sees it from (game.ts placePreview).
 */
function sizeOf(kind: string, radius: number): { reach: number; height: number } {
  const d = (VEHICLES as Readonly<Record<string, VehicleDef | undefined>>)[kind];
  // (the tram's circle is made from the length of the whole set: 0.55 of it and 7 m)
  if (!d || d.model === 'tram') return { reach: d ? Math.max(6, (radius - 7) / 1.1) : radius * 0.4, height: HEIGHT[d?.model ?? ''] ?? 3 };
  const o = d.outline;
  return { reach: Math.max(o.front, o.rear, o.hw, d.trailer ? radius * 0.55 : 0), height: HEIGHT[d.model] ?? 3 };
}

/**
 * The camera of the stage at `time` (s): the vehicle large in the middle of
 * the picture – its length across about 60 % of a wide screen (all of an
 * upright one: a wider lens then), its height across 40 % – seen from a
 * little above, a little higher in the picture than its middle (the buttons
 * are below).  It circles slowly, breathes a little in and out, and comes
 * in from further away for a moment after the vehicle changed (`since`).
 */
export function frameOf(time: number, kind: string, radius: number, aspect: number, since = -1e9): StageFrame {
  const a = Math.min(3, Math.max(0.3, aspect || 1));
  const upright = a < 1;
  const fov = upright ? 62 : 46;
  const tv = Math.tan((fov * Math.PI) / 360);
  const { reach, height } = sizeOf(kind, radius);
  const fit = Math.max(reach + 1.5, reach / ((upright ? 0.95 : 0.62) * tv * a), (height * 0.5) / (0.4 * tv));
  const t = Math.min(1, Math.max(0, (time - since) / 1.4));
  const dist = fit * (1 + 0.35 * (1 - t) ** 3) * (1 + 0.04 * Math.sin(time * 0.23));
  return { angle: time * 0.09 + 0.6, dist, rise: dist * 0.22 + 0.4, aim: -dist * tv * 0.16, fov };
}

/** what the camera framed last, and since when (the time of the game) */
const framed = { key: '', since: -1e9 };

/** The camera of the stage for the vehicle behind the menu now (game.ts menuShow) – it comes in anew whenever that vehicle changes. */
export function stageFrame(time: number, kind: string, radius: number, aspect: number): StageFrame {
  const key = `${kind}|${radius.toFixed(1)}`;
  if (key !== framed.key) {
    framed.key = key;
    framed.since = time;
  }
  return frameOf(time, kind, radius, aspect, framed.since);
}

// ===================================================================== the pictures

/** Line drawings on a 24 × 24 grid (stroked in the colour of the text). */
const ICONS: Record<string, string> = {
  // the kinds of vehicle
  car: '<path d="M4.5 16.5H3v-3.4c0-.7.5-1.3 1.2-1.5L7 11l2.3-3.3c.3-.4.8-.7 1.3-.7h4.8c.5 0 .9.2 1.2.6L19.3 11l1.6.5c.7.2 1.1.8 1.1 1.5v3.5h-1.5M8.5 16.5h6.5M7 11h12.3M12.8 7v4"/><circle cx="6.5" cy="16.5" r="2"/><circle cx="17" cy="16.5" r="2"/>',
  moto: '<circle cx="5.5" cy="16" r="3.2"/><circle cx="18.5" cy="16" r="3.2"/><path d="M5.5 16l3.3-5h6.4l-2.7 5H9.2M8.8 11L7.5 9.3H5M15.2 11l1.6-4.5H19M16.8 6.5l1.7 9.5"/>',
  truck: '<path d="M3.5 16.5H2.5v-10h11v10M13.5 9h4.4l3.6 3.9v3.6h-1.5M8 16.5h7.5M15.5 9v4h6"/><circle cx="5.8" cy="16.5" r="2"/><circle cx="17.8" cy="16.5" r="2"/>',
  bus: '<path d="M4.8 17H3.5a1 1 0 0 1-1-1V6.5A1.5 1.5 0 0 1 4 5h16a1.5 1.5 0 0 1 1.5 1.5V16a1 1 0 0 1-1 1h-1.3M9.2 17h5.6M2.5 11.5h19M7.5 5v6.5M12.5 5v6.5M17.5 5v12"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
  tractor: '<circle cx="7" cy="15.5" r="4.5"/><circle cx="7" cy="15.5" r="1.3"/><circle cx="18.5" cy="17.5" r="2.5"/><path d="M4 10.5V4.5h6.5l1.2 6M11.7 10.5H19l1.5 2.6V15M11.5 17.5H16M17.5 10.5V7"/>',
  tram: '<path d="M7 2.5h10M12 2.5L9.5 5.5h5z"/><rect x="5.5" y="5.5" width="13" height="13.5" rx="3"/><path d="M5.5 12h13M8.5 16h.01M15.5 16h.01M8 21.5l1.8-2.5M16 21.5l-1.8-2.5"/>',
  plane: '<path d="M12 2.5c.8 0 1.3.8 1.3 1.8V9l7.2 4.2v2.1l-7.2-2.2v4.6l2.2 1.7v1.7L12 20.2l-3.5.9v-1.7l2.2-1.7v-4.6l-7.2 2.2v-2.1L10.7 9V4.3c0-1 .5-1.8 1.3-1.8z"/>',
  foot: '<circle cx="13.5" cy="4.3" r="2"/><path d="M9.5 21l2.6-6-1.6-3.5.9-4.5 3 2.6 3 1.2M11.4 7.5L8.2 9.3l-1 3.4M12.1 15l3 2.2.9 3.8"/>',
  forklift: '<path d="M3 17V12h12v5M6 12V6h8v6M17 3.5V19.5M17 19.5h5M17 15h4"/><circle cx="6" cy="18" r="1.8"/><circle cx="12.5" cy="18" r="1.8"/>',
  crane: '<path d="M2.5 17.5V13h12v4.5M14.5 13.5h3.8l2.7 2.4v1.6H2.5M4.5 13L16 4l1.5 1.3L7 13M17.2 5.2V10M16 10h2.4"/><circle cx="5" cy="18" r="1.6"/><circle cx="10" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/>',
  /** (any other vehicle: a steering wheel) */
  wheel: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M3.3 10.4l6.3 1M20.7 10.4l-6.3 1M12 14.5V21"/>',
  // the ways to play
  free: '<path d="M9 3L4 21M15 3l5 18M12 4v2.5M12 10v3M12 16.5V20"/>',
  demo: '<circle cx="11" cy="13" r="8"/><circle cx="11" cy="13" r="2.2"/><path d="M3.3 11.5l5.5.8M18.7 11.5l-5.5.8M11 15.2V21"/><path d="M19.5 1.8l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" fill="currentColor"/>',
  tour: '<circle cx="5" cy="18.5" r="2"/><circle cx="19" cy="5.5" r="2"/><path d="M7 18.5h8.5a3.5 3.5 0 0 0 0-7h-7a3.5 3.5 0 0 1 0-7H17"/>',
  show: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  lesson: '<path d="M2.5 9.5L12 5l9.5 4.5L12 14z"/><path d="M6.5 11.5V16c0 1.3 2.5 2.5 5.5 2.5s5.5-1.2 5.5-2.5v-4.5M21.5 9.5V15"/>',
  exam: '<rect x="5" y="4.5" width="14" height="17" rx="2"/><path d="M9 4.5V2.8h6v1.7M8.5 13.5l2.5 2.5 5-5"/>',
  theory: '<path d="M12 6.5C10 5 7 4.5 3 5v13c4-.5 7 0 9 1.5 2-1.5 5-2 9-1.5V5c-4-.5-7 0-9 1.5zM12 6.5v13"/>',
  /** the learning modes: a card with ticks */
  learn: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M7.5 8.5l1.5 1.5 3-3M7.5 15l1.5 1.5 3-3M14.5 9h2.5M14.5 15.5h2.5"/>',
  takeoff: '<path d="M2.5 20.5h19M4 14.5l2.8 1.2 12.4-5.6c1.2-.5 1.8-1.8 1.2-2.6-.5-.8-1.8-.9-3-.4l-4 1.8-6.6-3-1.8.8 4.6 4-3.4 1.6-2.4-1.3-1.4.6 1.6 2.9"/>',
  basics: '<circle cx="7.5" cy="12" r="4"/><circle cx="7.5" cy="12" r="1.3"/><path d="M11.5 12h10M18 12v3.2M21 12v2.2"/>',
  couple: '<path d="M2.5 15.5h6.5V8H2.5M9 12.5h4"/><circle cx="14.5" cy="12.5" r="1.6"/><path d="M16.1 12.5h5.4V7M21.5 16v-3.5"/><circle cx="5.5" cy="17.5" r="1.8"/>',
  corner: '<path d="M18 3.5V12a4.5 4.5 0 0 1-4.5 4.5H5M8.5 13l-3.5 3.5L8.5 20"/>',
  ramp: '<path d="M2.5 20.5h19M15.5 20.5v-7h6M3 12h8M6.5 8.5L3 12l3.5 3.5"/>',
  // round the menu
  pin: '<path d="M12 21.5s-6.8-6.2-6.8-11.3a6.8 6.8 0 0 1 13.6 0c0 5.1-6.8 11.3-6.8 11.3z"/><circle cx="12" cy="10.2" r="2.4"/>',
  town: '<path d="M2.5 21h19M4 21V10.5l5-3V21M9 21V4.5l7 3V21M16 21v-9l4.5 2V21M12 10h1M12 13.5h1M12 17h1M6.5 13h.01M6.5 16.5h.01M18.3 16h.01M18.3 18.8h.01"/>',
  house: '<path d="M3 11.5L12 4l9 7.5M5.5 9.5V20.5h13V9.5M10 20.5v-6h4v6"/>',
  gear: '<path d="M18.8 9.4L21.4 10L21.4 14L18.8 14.6L18.7 15L20.1 17.2L17.2 20.1L15 18.7L14.6 18.8L14 21.4L10 21.4L9.4 18.8L9 18.7L6.8 20.1L3.9 17.2L5.3 15L5.2 14.6L2.6 14L2.6 10L5.2 9.4L5.3 9L3.9 6.8L6.8 3.9L9 5.3L9.4 5.2L10 2.6L14 2.6L14.6 5.2L15 5.3L17.2 3.9L20.1 6.8L18.7 9z"/><circle cx="12" cy="12" r="3"/>',
  map: '<path d="M3 6.3l5.5-2.3 7 2.8L21 4.5v13.2L15.5 20l-7-2.8L3 19.5z"/><path d="M8.5 4v13.2M15.5 6.8V20"/>',
  news: '<path d="M11 3l1.9 5.6L18.5 10.5l-5.6 1.9L11 18l-1.9-5.6L3.5 10.5l5.6-1.9z"/><path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  more: '<circle cx="5.5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.6 3.7 5.6 3.7 9s-1.3 6.4-3.7 9c-2.4-2.6-3.7-5.6-3.7-9S9.6 5.6 12 3z"/>',
  pad: '<path d="M7 8h10a4.2 4.2 0 0 1 4.1 3.4l.8 4a2.3 2.3 0 0 1-4 2l-2.4-2.4H8.5L6.1 17.4a2.3 2.3 0 0 1-4-2l.8-4A4.2 4.2 0 0 1 7 8z"/><path d="M8 10.5v3.5M6.25 12.25h3.5M15.5 11h.01M17.5 13h.01"/>',
  log: '<rect x="4.5" y="3" width="15" height="18" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>',
  prev: '<path d="M15 4.5L7.5 12l7.5 7.5"/>',
  next: '<path d="M9 4.5l7.5 7.5L9 19.5"/>',
  play: '<path d="M8.5 5.2v13.6c0 .8.9 1.3 1.6.9l10.6-6.8c.6-.4.6-1.3 0-1.7L10.1 4.3c-.7-.4-1.6.1-1.6.9z" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  sliders: '<path d="M4 7h9.5M18.5 7H20M4 17h1.5M10.5 17H20"/><circle cx="16" cy="7" r="2.5"/><circle cx="8" cy="17" r="2.5"/>',
  gearbox: '<path d="M6 5v14M12 5v14M18 5v7H6"/><circle cx="6" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="18" cy="5" r="1.4" fill="currentColor"/><circle cx="6" cy="19" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/>',
  power: '<path d="M3.5 17a8.5 8.5 0 1 1 17 0"/><path d="M12 17l4.5-5.5M6.5 13.5l1 .6M12 7.8v1.2M17.5 13.5l-1 .6"/>',
  trailer: '<path d="M2 15.5h3M5 8h14v7.5H5zM19 15.5h2.5"/><circle cx="12" cy="17.5" r="2"/>',
  set1: '<rect x="5" y="6" width="14" height="10" rx="2"/><path d="M5 11h14"/><circle cx="8.5" cy="18" r="1.3"/><circle cx="15.5" cy="18" r="1.3"/>',
  set2: '<rect x="1.5" y="6" width="9.5" height="10" rx="2"/><rect x="13" y="6" width="9.5" height="10" rx="2"/><path d="M1.5 11H11M13 11h9.5M11 13.5h2"/><circle cx="6.2" cy="18" r="1.3"/><circle cx="17.8" cy="18" r="1.3"/>',
  set3: '<rect x="1.5" y="6" width="11" height="10" rx="2"/><rect x="15" y="8" width="7.5" height="8" rx="1.5"/><path d="M1.5 11h11M12.5 13.5H15"/><circle cx="7" cy="18" r="1.3"/><circle cx="18.7" cy="18" r="1.3"/>',
  run: '<circle cx="15" cy="4.3" r="2"/><path d="M5 11.5l3.3-3.3 4.2.5 2.5 3 3.5.8M12.5 8.7l-2.5 5 3.5 2.5-1.5 5M10 13.7L7 15H3.5"/>',
  stage: '<path d="M5.5 12.5H5v-2l2-.6 2-2.4h5l2.5 2.4 2.5.6v2h-.5M8 12.5h6"/><circle cx="7" cy="12.5" r="1.4"/><circle cx="16.5" cy="12.5" r="1.4"/><ellipse cx="12" cy="17.5" rx="9.5" ry="3"/>',
  rows: '<rect x="3" y="4" width="18" height="4.5" rx="1.5"/><rect x="3" y="10.5" width="18" height="4.5" rx="1.5"/><rect x="3" y="17" width="18" height="3.5" rx="1.5"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor"/>',
};

/** Traffic signs in their own colours, as the lessons are known by them. */
const SIGNS: Record<string, string> = {
  rbl: '<path d="M12 2.2l10.3 18.3H1.7z" fill="#d0141e"/><path d="M12 6.6l6.6 11.6H5.4z" fill="#fff"/><path d="M9.5 16.5l5-5.4M14.5 16.5l-5-5.4" stroke="#111" stroke-width="1.7"/>',
  priority: '<path d="M12 1.5L22.5 12 12 22.5 1.5 12z" fill="#fff" stroke="#333" stroke-width=".6"/><path d="M12 5.2L18.8 12 12 18.8 5.2 12z" fill="#f6c817"/>',
  signals: '<rect x="7" y="1.5" width="10" height="21" rx="3" fill="#20262d" stroke="#56606b" stroke-width=".8"/><circle cx="12" cy="6.3" r="2.3" fill="#e53935"/><circle cx="12" cy="12" r="2.3" fill="#ffb300"/><circle cx="12" cy="17.7" r="2.3" fill="#43a047"/>',
  roundabout: '<circle cx="12" cy="12" r="10.5" fill="#1b5fa8" stroke="#fff" stroke-width="1"/><path d="M12 5.6a6.4 6.4 0 1 1-5.8 3.7" fill="none" stroke="#fff" stroke-width="2"/><path d="M4.2 8.2l3.9-.2-.6 3.7z" fill="#fff"/>',
  rural: '<rect x="1.5" y="5" width="21" height="14" rx="1.5" fill="#f6c817" stroke="#111" stroke-width=".8"/><path d="M5 9h8M5 12.5h6M5 16h9" stroke="#111" stroke-width="1.2"/><path d="M3 18L21 6" stroke="#d0141e" stroke-width="2"/>',
  motorway: '<rect x="1.5" y="1.5" width="21" height="21" rx="3" fill="#1b5fa8" stroke="#fff" stroke-width="1"/><path d="M4.5 12.5h15" stroke="#fff" stroke-width="1.6"/><path d="M8.3 21l1.5-6.8M15.7 21l-1.5-6.8M8.8 10.7L10 4M15.2 10.7L14 4" stroke="#fff" stroke-width="1.6"/>',
  /** the stop of trams and buses (sign 224) */
  stop: '<circle cx="12" cy="12" r="10.5" fill="#f6c817" stroke="#0a7d3b" stroke-width="2"/><path d="M8.3 6.8v10.4M15.7 6.8v10.4M8.3 12h7.4" stroke="#0a7d3b" stroke-width="2.4"/>',
};

const LINE = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

/** A picture by its name: a sign in its colours, or a line drawing (an unknown name: the steering wheel). */
function icon(name: string): string {
  const sign = SIGNS[name];
  return sign ? `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${sign}</svg>` : `<svg ${LINE}>${ICONS[name] ?? ICONS.wheel}</svg>`;
}

/** The picture of a kind of vehicle in the strip. */
const GROUP_ICON: Record<string, string> = { car: 'car', moto: 'moto', truck: 'truck', bus: 'bus', tractor: 'tractor', tram: 'tram', plane: 'plane', foot: 'foot', crane: 'crane', forklift: 'forklift' };
/** The name of a kind with several vehicles (a kind with one is named by its vehicle). */
const GROUP_NAME: Record<string, string> = { car: 'stageCars', moto: 'stageMotorcycles', truck: 'stageTrucks', bus: 'stageBuses', tractor: 'stageTractors', crane: 'stageCranes' };
/** The picture of a lesson: the sign it is about, or what is done in it. */
const LESSON_ICON: Record<string, string> = { basics: 'basics', rbl: 'rbl', priority: 'priority', signals: 'signals', roundabout: 'roundabout', rural: 'rural', motorway: 'motorway', ceCouple: 'couple', ceCorner: 'corner', ceRamp: 'ramp', tramLine: 'stop', busLine: 'stop' };

// ===================================================================== the page

/**
 * Another way to play that a part of the game adds to the menu (the theory
 * lessons …): a tile among the others, started with the big button – like
 * the others (the drive is started with `id` as its mode), or by `run`.
 */
export interface StageExtraMode {
  id: string;
  /** its name */
  label: string;
  /** a line drawing on a 24 × 24 grid (the inside of the <svg>) – an open book if none */
  icon?: string;
  /** for these vehicles only (all if not given) */
  kinds?: readonly VehicleKind[];
  /** only where the map has a practice yard */
  yard?: boolean;
  run?: () => void;
  /** in the "Learn" group (a sheet of its own; a tap runs it at once) */
  learn?: boolean;
}

export interface StageContext {
  lang: Lang;
  t: (key: string, vars?: Record<string, string | number>) => string;
  settings: Settings;
  spawns: readonly SpawnJson[];
  tramStops: readonly TramStopChoice[] | null;
  runways: readonly RunwayChoice[] | null;
  /** whether the map has a practice yard (the lessons on it, the test place) */
  hasYard: boolean;
  /** the list of languages (a <select>) */
  language: HTMLElement;
  /** a field for an address (calls `pick` with the one chosen) */
  address: (pick: (hit: AddressHit) => void) => HTMLElement;
  /** the other pages – each comes back to this menu – and the full-screen map */
  pages: { settings(): void; news(): void; map(): void; controls(): void; log(): void; about(): void };
  /** where the player is now (the browser asks first): a start place there – or why not (a text) */
  here?(): Promise<{ hit: AddressHit } | { error: string }>;
  /** more ways to play, from other parts of the game */
  extraModes?: readonly StageExtraMode[];
  /** "Version 1.4.0" */
  version: string;
  start: (req: StartRequest) => void;
  /** the vehicle behind the menu (null: none – the view from above while its place is not known) */
  preview: (p: MenuPreview | null) => void;
  /** draw the menu anew (after a choice) */
  redraw: () => void;
}

type Sheet = 'place' | 'mode' | 'lessons' | 'learn' | 'options' | 'more';

/**
 * What the menu keeps while it is drawn anew after each choice: the sheet
 * that is open, the way to play chosen, the vehicle last chosen of each
 * kind, the side the last vehicle came from (its name slides in from there),
 * the control that had the focus – and whether keys or a gamepad are used
 * (then the focus is given back, and it moves into a sheet that opens).
 */
const st = {
  sheet: null as Sheet | null,
  wanted: 'free',
  last: new Map<string, VehicleKind>(),
  came: 0,
  focus: '',
  keys: false,
  root: null as HTMLElement | null,
  /** what the keys and the gamepad do on the menu shown now */
  act: null as Acts | null,
  listening: false,
  /** the gamepad: the frame it is looked at next (0: not while no menu of this kind is shown), its buttons a picture ago, those held since before the menu came (their letting go does not count), the way the stick or the cross is held and when that acts again */
  pad: 0,
  padFresh: false,
  padPrev: [] as boolean[],
  padHeld: [] as boolean[],
  padDir: '',
  padNext: 0,
  /** Enter went down on the menu itself (the drive starts when it comes up) */
  enter: false,
};

interface Acts {
  /** the next (1) or previous (−1) vehicle, in the reading direction */
  vehicle(step: number): void;
  group(step: number): void;
  go(): void;
  close(): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** A button with a picture only: its label is for hover, a long press and screen readers. */
function iconButton(cls: string, picture: string, label: string, key: string, act: () => void): HTMLButtonElement {
  const b = el('button', `st-ico ${cls}`.trim());
  b.type = 'button';
  b.innerHTML = picture;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.dataset.k = key;
  b.onclick = act;
  return b;
}

/** Is the page written from right to left (then "next" lies to the left)? */
const rtl = (n: Element): boolean => getComputedStyle(n).direction === 'rtl';

/** The main menu as a stage. */
export function stageMenu(c: StageContext): HTMLElement {
  const s = c.settings;
  const t = c.t;
  const def = VEHICLES[s.vehicle] ?? VEHICLES.car;
  const kind = def.kind;
  const groups = stageGroups();
  const group = groups.find((g) => g.kinds.includes(kind)) ?? groups[0];
  if (group) st.last.set(group.id, kind);
  const place = stagePlace(kind, s.lastStart, c.spawns, c.tramStops, c.runways);
  const modes = stageModes(kind, c.hasYard);
  const extras = (c.extraModes ?? []).filter((m) => (!m.kinds || m.kinds.includes(kind)) && (!m.yard || c.hasYard));
  const mode = pickMode([...modes, ...extras], st.wanted);
  const save = (): void => void saveSettings(s);
  const choose = (k: VehicleKind, came: number): void => {
    if (k === s.vehicle) return;
    st.came = came;
    s.vehicle = k;
    save();
    c.redraw();
  };
  const name = (d: VehicleDef): string => shortName(t(d.name), d.licence);
  const groupName = (g: StageGroup): string => {
    const key = GROUP_NAME[g.id];
    return key && g.kinds.length > 1 ? t(key) : name(VEHICLES[g.kinds[0]]);
  };

  const root = el('div', `st${st.keys ? ' keys' : ''}`);
  st.root = root;

  // ---- the picture itself: a swipe brings the next vehicle
  const swipe = el('div', 'st-swipe');
  swipe.setAttribute('aria-hidden', 'true');

  // ---- at the top: the name of the game, how far the place is loaded; the language, the map, what is new, the settings, the rest
  const top = el('div', 'st-top');
  const brand = el('div', 'st-brand');
  brand.innerHTML = 'Fahrsim <span>Baunatal</span>';
  brand.append(el('small', '', c.version));
  const tools = el('div', 'st-tools');
  const lang = el('label', 'st-ico st-lang');
  lang.title = t('language');
  lang.innerHTML = icon('globe');
  lang.append(el('b', '', s.lang.toUpperCase()), c.language);
  c.language.dataset.k = 'lang';
  tools.append(
    lang,
    iconButton('', icon('map'), t('mapTitle'), 'map', () => c.pages.map()),
    iconButton('', icon('news'), t('news'), 'news', () => c.pages.news()),
    iconButton('', icon('gear'), t('settings'), 'settings', () => c.pages.settings()),
    iconButton('', icon('more'), t('stageMore'), 'more', () => open('more')),
  );
  top.append(brand, tools);
  // (hud.ts setMenuLoading writes into it while the ground and the roads round the place come)
  const loading = el('small', 'cm-loading st-loading');

  // ---- at the edges: the previous and the next vehicle
  const prev = iconButton('st-arrow st-prev', icon('prev'), t('stagePrev'), 'prev', () => acts.vehicle(-1));
  const next = iconButton('st-arrow st-next', icon('next'), t('stageNext'), 'next', () => acts.vehicle(1));

  // ---- at the foot: the kinds of vehicle, the one chosen with its classes, where, what, and the big button
  const foot = el('div', 'st-foot');
  const kinds = el('div', 'st-kinds');
  kinds.setAttribute('role', 'group');
  kinds.setAttribute('aria-label', t('vehicle'));
  groups.forEach((g, i) => {
    const on = g === group;
    const b = iconButton(`st-kind${on ? ' on' : ''}`, icon(GROUP_ICON[g.id] ?? 'wheel'), groupName(g), `kind-${g.id}`, () => {
      if (!on) choose(st.last.get(g.id) ?? g.kinds[0], i > groups.indexOf(group) ? 1 : -1);
    });
    b.setAttribute('aria-pressed', String(on));
    kinds.append(b);
  });

  const title = el('div', `st-title${st.came > 0 ? ' in-next' : st.came < 0 ? ' in-prev' : ''}`);
  st.came = 0;
  const label = el('b', 'st-name', name(def));
  title.append(label);
  const classes = el('span', 'st-classes');
  for (const k of group?.kinds ?? [kind]) {
    const d = VEHICLES[k];
    if (!d.licence) continue;
    if ((group?.kinds.length ?? 1) === 1) {
      classes.append(el('span', 'st-cls on', d.licence));
      continue;
    }
    const b = el('button', `st-cls${k === kind ? ' on' : ''}`, d.licence);
    b.type = 'button';
    b.title = t(d.name);
    b.setAttribute('aria-label', t(d.name));
    b.setAttribute('aria-pressed', String(k === kind));
    b.dataset.k = `class-${k}`;
    b.onclick = () => choose(k, (group?.kinds.indexOf(k) ?? 0) > (group?.kinds.indexOf(kind) ?? 0) ? 1 : -1);
    classes.append(b);
  }
  if (classes.childElementCount > 0) title.append(classes);
  const hasOptions = def.model === 'car' || def.model === 'motorcycle' || def.powers.length > 1 || trailerPartner(kind) !== null || kind === 'tram' || kind === 'pedestrian';
  if (hasOptions) title.append(iconButton('st-opts', icon('sliders'), t('menuOptions'), 'options', () => open('options')));

  // where: the place of the drive's beginning
  const placeText = place.state === 'loading' ? t('realityLoading') : place.state === 'none' ? '–' : [place.town, place.runway !== undefined ? t('runwayEnd', { end: place.runway }) : place.name].filter((x, i, all) => x && (i === 0 || x !== all[0])).join(' · ');
  const placeBtn = pill('st-place', icon('pin'), placeText, t('startPoint'), 'place', () => open('place'));

  // what: the way to play chosen
  const modeOf = (id: string): { label: string; picture: string; hint: string } => {
    const extra = extras.find((m) => m.id === id);
    if (extra) return { label: extra.label, picture: extra.icon ? `<svg ${LINE}>${extra.icon}</svg>` : icon('theory'), hint: extra.label };
    if (id === 'free') {
      const hint = t(kind === 'tram' ? 'freeTramDesc' : kind === 'pedestrian' ? 'freeWalkDesc' : kind === 'plane' ? 'freeFlyDesc' : 'freeDesc');
      return { label: t(kind === 'plane' ? 'freeFly' : 'free'), picture: icon(kind === 'plane' ? 'takeoff' : kind === 'pedestrian' ? 'foot' : 'free'), hint };
    }
    if (id === 'demo') return { label: t(kind === 'plane' ? 'demoFly' : 'demo'), picture: icon(kind === 'plane' ? 'takeoff' : 'demo'), hint: t(kind === 'tram' ? 'demoTramDesc' : kind === 'plane' ? 'demoFlyDesc' : 'demoDesc') };
    if (id === 'tour') return { label: t('tourTitle'), picture: icon('tour'), hint: t('tourDesc') };
    if (id === 'show') return { label: t('showTitle'), picture: icon('show'), hint: t('showDesc') };
    const l = modes.find((m) => m.id === id)?.lesson;
    const picture = icon(l?.kind === 'exam' ? 'exam' : (LESSON_ICON[id] ?? (/theory/i.test(l?.kind ?? '') ? 'theory' : 'lesson')));
    return { label: lessonTitle(id, c.lang), picture, hint: id === 'exam' ? t('examDesc') : lessonIntro(id, c.lang) };
  };
  const chosen = modeOf(mode);
  const modeBtn = pill('st-mode', chosen.picture, chosen.label, t('stageMode'), 'mode', () => open('mode'));
  modeBtn.title = `${t('stageMode')}: ${chosen.label}`;

  // … and go
  const go = el('button', 'st-go');
  go.type = 'button';
  go.innerHTML = icon('play');
  go.title = `${t('start')} · ${chosen.label}`;
  go.setAttribute('aria-label', go.title);
  go.dataset.k = 'go';
  const start = (): void => {
    const extra = extras.find((m) => m.id === mode);
    if (extra?.run) extra.run();
    else c.start({ ...place.request, mode });
  };
  go.onclick = start;
  foot.append(kinds, title, placeBtn, go, modeBtn);

  // ---- the sheet over the lower part of the screen, when one is open
  const sheetHost = el('div', 'st-sheethost');
  const tip = el('div', 'st-tip');
  tip.hidden = true;
  root.append(swipe, top, loading, prev, next, foot, sheetHost, tip);

  /** A pill: a picture in a circle and a name beside it. */
  function pill(cls: string, picture: string, text: string, aria: string, key: string, act: () => void): HTMLButtonElement {
    const b = el('button', `st-pill ${cls}`);
    b.type = 'button';
    const i = el('span', 'st-pic');
    i.innerHTML = picture;
    b.append(i, el('span', 'st-text', text));
    b.title = `${aria}: ${text}`;
    b.setAttribute('aria-label', b.title);
    b.dataset.k = key;
    b.onclick = act;
    return b;
  }

  /** Open a sheet (null: close it) – without drawing the menu anew. */
  function open(k: Sheet | null): void {
    const was = st.sheet;
    st.sheet = k;
    sheetHost.replaceChildren(...(k ? buildSheet(k) : []));
    root.classList.toggle('sheeted', k !== null);
    if (!st.keys) return;
    // (keys or a gamepad: into the sheet – to what is chosen in it –, and back to the button that opened it)
    if (k) (sheetHost.querySelector<HTMLElement>('.on[data-k]') ?? sheetHost.querySelector<HTMLElement>('[data-k]'))?.focus();
    else if (was) root.querySelector<HTMLElement>(`[data-k="${was === 'lessons' || was === 'learn' ? 'mode' : was}"]`)?.focus();
  }

  /** A choice was made in a sheet: keep it, close the sheet (unless `stay`), draw the menu anew. */
  const chosenIn = (stay = false): void => {
    if (!stay && st.sheet) {
      st.focus = st.sheet === 'lessons' || st.sheet === 'learn' ? 'mode' : st.sheet;
      st.sheet = null;
    }
    save();
    c.redraw();
  };

  /** To another page from a sheet: when the menu comes back, the sheet is closed. */
  const away = (page: () => void): void => {
    st.sheet = null;
    page();
  };

  /** A sheet: its title, a close button, what is in it. */
  function buildSheet(k: Sheet): HTMLElement[] {
    const scrim = el('div', 'st-scrim');
    scrim.onclick = () => open(null);
    const box = el('div', 'st-sheet');
    box.setAttribute('role', 'dialog');
    const head = el('div', 'st-sheethead');
    const titles: Record<Sheet, [string, string]> = {
      place: [icon('pin'), t('startPoint')],
      mode: [icon('free'), t('stageMode')],
      lessons: [icon('lesson'), t('stageLessons')],
      learn: [icon('learn'), t('learn.title')],
      options: [icon('sliders'), t('menuOptions')],
      more: [icon('more'), t('stageMore')],
    };
    const [picture, heading] = titles[k];
    box.setAttribute('aria-label', heading);
    if (k === 'lessons' || k === 'learn') head.append(iconButton('st-small st-back', icon('prev'), t('back'), 'back', () => open('mode')));
    else {
      const p = el('span', 'st-headpic');
      p.innerHTML = picture;
      head.append(p);
    }
    head.append(el('b', '', heading), iconButton('st-small st-close', icon('close'), t('realityClose'), 'close', () => open(null)));
    box.append(head);
    if (k === 'place') fillPlace(box);
    else if (k === 'mode' || k === 'lessons') fillModes(box, k === 'lessons');
    else if (k === 'learn') fillLearn(box);
    else if (k === 'options') fillOptions(box);
    else fillMore(box);
    return [scrim, box];
  }

  /** A tile of a sheet: a picture in a circle and a name under it. */
  function tile(picture: string, text: string, on: boolean, key: string, act: () => void, hint = ''): HTMLButtonElement {
    const b = el('button', `st-tile${on ? ' on' : ''}`);
    b.type = 'button';
    const p = el('span', 'st-pic');
    p.innerHTML = picture;
    b.append(p, el('span', 'st-text', text));
    b.title = hint || text;
    b.setAttribute('aria-pressed', String(on));
    b.dataset.k = key;
    b.onclick = act;
    return b;
  }

  /** A choice among a few, in a row (a picture or a word on each). */
  function chips(row: HTMLElement, items: Array<{ text: string; picture?: string; on: boolean; key: string; label?: string; act: () => void }>): void {
    const seg = el('div', 'st-chips');
    for (const it of items) {
      const b = el('button', `st-chip${it.on ? ' on' : ''}`);
      b.type = 'button';
      if (it.picture) {
        const p = el('span', 'st-chippic');
        p.innerHTML = it.picture;
        b.append(p);
      }
      if (it.text) b.append(el('span', '', it.text));
      if (it.label) {
        b.title = it.label;
        b.setAttribute('aria-label', it.label);
      }
      b.setAttribute('aria-pressed', String(it.on));
      b.dataset.k = it.key;
      b.onclick = it.act;
      seg.append(b);
    }
    row.append(seg);
  }

  /** A line of a sheet: a small picture (with its name for hover and screen readers), then what is in it. */
  function line(box: HTMLElement, picture: string, text: string): HTMLElement {
    const row = el('div', 'st-line');
    const p = el('span', 'st-linepic');
    p.innerHTML = picture;
    p.title = text;
    p.setAttribute('role', 'img');
    p.setAttribute('aria-label', text);
    row.append(p);
    box.append(row);
    return row;
  }

  /** A list to choose from (a town, a stop): the phone's own picker – compact, and quick with many. */
  function select(row: HTMLElement, label: string, options: Array<[string, string]>, value: string, key: string, change: (v: string) => void): void {
    const sel = el('select', 'st-select');
    sel.setAttribute('aria-label', label);
    sel.title = label;
    for (const [v, text] of options) {
      const o = el('option', '', text);
      o.value = v;
      sel.append(o);
    }
    sel.value = value;
    sel.dataset.k = key;
    sel.onchange = () => change(sel.value);
    row.append(sel);
  }

  /** Where to start: the town (airfield), the place in it – or an address, or a place on the map. */
  function fillPlace(box: HTMLElement): void {
    const last = s.lastStart;
    if (place.state !== 'ok') box.append(el('p', 'st-note', place.state === 'loading' ? t('realityLoading') : '–'));
    // the places of a town: a few as buttons, many in a list
    const places = (row: HTMLElement, items: Array<{ text: string; on: boolean; key: string; act: () => void }>): void => {
      if (items.length <= 12) chips(row, items);
      else {
        const at = Math.max(0, items.findIndex((i) => i.on));
        select(row, t('startPoint'), items.map((it, i): [string, string] => [String(i), it.text]), String(at), 'place-list', (v) => items[Number(v)]?.act());
      }
    };
    if (kind === 'plane' && c.runways && c.runways.length > 0 && place.state === 'ok') {
      const list = c.runways;
      const fields = [...new Set(list.map((r) => r.field))];
      select(line(box, icon('plane'), t('startPoint')), t('startPoint'), fields.map((f): [string, string] => [f, f]), place.town, 'town', (f) => {
        const r = list.find((x) => x.field === f);
        if (r) last.runway = runwayKey(r);
        chosenIn(true);
      });
      places(
        line(box, icon('takeoff'), place.town),
        list.filter((r) => r.field === place.town).map((r) => ({ text: t('runwayEnd', { end: r.end }), on: r.end === place.runway, key: `end-${r.end}`, act: () => {
          last.runway = runwayKey(r);
          chosenIn();
        } })),
      );
    } else if (kind === 'tram' && c.tramStops && c.tramStops.length > 0 && place.state === 'ok') {
      const list = c.tramStops;
      const towns = [...new Set(list.map((x) => x.town))];
      select(line(box, icon('town'), t('startPoint')), t('startPoint'), towns.map((x): [string, string] => [x, x]), place.town, 'town', (town) => {
        const x = list.find((y) => y.town === town);
        if (x) last.tramStop = tramKey(x);
        chosenIn(true);
      });
      places(
        line(box, icon('stop'), place.town),
        list.filter((x) => x.town === place.town).map((x) => ({ text: x.name, on: x.name === place.name, key: `stop-${x.name}`, act: () => {
          last.tramStop = tramKey(x);
          chosenIn();
        } })),
      );
    } else if (kind !== 'plane' && kind !== 'tram' && c.spawns.length > 0) {
      // the start points of the map by town, in the order the map lists them
      const towns: string[] = [];
      for (const sp of c.spawns) if (!towns.includes(sp.g ?? '')) towns.push(sp.g ?? '');
      const spawn = place.request.spawn;
      const here = last.address ? '' : (c.spawns[spawn]?.g ?? '');
      const options = towns.map((g): [string, string] => [g, g || '–']);
      if (last.address) options.unshift(['@', last.address.label]);
      select(line(box, icon('town'), t('startPoint')), t('startPoint'), options, last.address ? '@' : here, 'town', (g) => {
        if (g === '@') return;
        last.spawn = Math.max(0, c.spawns.findIndex((sp) => (sp.g ?? '') === g));
        last.address = null;
        chosenIn(true);
      });
      if (!last.address) {
        const items: Array<{ text: string; on: boolean; key: string; act: () => void }> = [];
        c.spawns.forEach((sp, i) => {
          if ((sp.g ?? '') !== here) return;
          items.push({ text: sp.name, on: i === spawn, key: `spawn-${i}`, act: () => {
            last.spawn = i;
            last.address = null;
            chosenIn();
          } });
        });
        places(line(box, icon(GROUP_ICON[group?.id ?? ''] ?? 'pin'), here || t('startPoint')), items);
      }
      // … or anywhere: street and house number
      const field = c.address((hit) => {
        last.address = hit;
        chosenIn();
      });
      field.classList.add('st-address');
      line(box, icon('house'), t('startAddress')).append(field);
    }
    // … or a place on the map
    const map = el('button', 'st-wide');
    map.type = 'button';
    map.innerHTML = icon('map');
    map.append(el('span', '', t('stageOnMap')));
    map.dataset.k = 'onmap';
    map.onclick = () => away(() => c.pages.map());
    box.append(map);
    // … or where the player is now
    const here = c.here;
    if (here) {
      const me = el('button', 'st-wide');
      me.type = 'button';
      me.innerHTML = icon('pin');
      const label = el('span', '', t('myLocation'));
      me.append(label);
      me.dataset.k = 'here';
      me.onclick = async () => {
        me.disabled = true;
        const r = await here();
        me.disabled = false;
        if ('hit' in r) {
          last.address = r.hit;
          chosenIn();
        } else label.textContent = r.error;
      };
      box.append(me);
    }
  }

  /** What to do: the drives of one's own, the lessons (a sheet of their own when there are several), the test – and what other parts add. */
  function fillModes(box: HTMLElement, lessonsOnly: boolean): void {
    const grid = el('div', 'st-tiles');
    const pick = (id: string): void => {
      st.wanted = id;
      chosenIn();
    };
    const add = (id: string): void => {
      const m = modeOf(id);
      grid.append(tile(m.picture, m.label, id === mode, `mode-${id}`, () => pick(id), m.hint));
    };
    const lessons = modes.filter((m) => m.group === 'lesson');
    if (lessonsOnly) for (const m of lessons) add(m.id);
    else {
      for (const m of modes) if (m.group === 'drive') add(m.id);
      if (lessons.length === 1) add(lessons[0].id);
      else if (lessons.length > 1) {
        const on = lessons.some((m) => m.id === mode);
        const b = tile(icon('lesson'), t('stageLessons'), on, 'lessons', () => open('lessons'));
        b.querySelector('.st-pic')?.append(el('i', 'st-count', String(lessons.length)));
        grid.append(b);
      }
      for (const m of modes) if (m.group === 'exam') add(m.id);
      for (const m of extras) if (!m.learn) add(m.id);
      // the learning modes (ui/learn.ts): a sheet of their own
      if (extras.some((m) => m.learn)) grid.append(tile(icon('learn'), t('learn.title'), false, 'learn', () => open('learn'), t('learn.hint')));
    }
    box.append(grid);
  }

  /** The learning modes: the theory exam, the sign trainer, spotting dangers, the lesson log – each opens its page at once. */
  function fillLearn(box: HTMLElement): void {
    const grid = el('div', 'st-tiles');
    for (const m of extras) if (m.learn) grid.append(tile(m.icon ? `<svg ${LINE}>${m.icon}</svg>` : icon('learn'), m.label, false, `mode-${m.id}`, () => away(() => m.run?.())));
    box.append(grid);
  }

  /** The vehicle's options: its gearbox, its engine, its trailer – the make-up of the tram, how fast one runs on foot. */
  function fillOptions(box: HTMLElement): void {
    if (def.model === 'car' || def.model === 'motorcycle') {
      const items = (['assist', 'manual', 'automatic'] as const).map((v) => ({ text: t(v === 'assist' ? 'trAssist' : v === 'manual' ? 'trManual' : 'trAutomatic'), on: s.transmission === v, key: `tr-${v}`, act: () => {
        s.transmission = v;
        chosenIn(true);
      } }));
      chips(line(box, icon('gearbox'), t('transmission')), items);
    }
    if (def.powers.length > 1) {
      const now = powerOf(def, s.powers);
      chips(
        line(box, icon('power'), t('enginePower')),
        def.powers.map((ps) => ({ text: `${ps} PS`, label: `${ps} PS (${Math.round(ps * 0.7355)} kW)`, on: ps === now, key: `ps-${ps}`, act: () => {
          s.powers[def.kind] = ps;
          chosenIn(true);
        } })),
      );
    }
    const partner = trailerPartner(kind);
    if (partner) {
      const solo = def.trailer ? partner : kind;
      const pair = def.trailer ? kind : partner;
      const picture = icon(GROUP_ICON[group?.id ?? ''] ?? 'wheel');
      chips(line(box, icon('trailer'), t('stageTrailer')), [
        { text: '', picture, label: t(VEHICLES[solo].name), on: kind === solo, key: 'solo', act: () => choose(solo, -1) },
        { text: '', picture: `${picture}${icon('trailer')}`, label: t(VEHICLES[pair].name), on: kind === pair, key: 'pair', act: () => choose(pair, 1) },
      ]);
    }
    if (kind === 'tram') {
      chips(
        line(box, icon('tram'), t('tramSet')),
        (['single', 'double', 'trailer'] as const).map((v) => ({ text: '', picture: icon(v === 'single' ? 'set1' : v === 'double' ? 'set2' : 'set3'), label: t(v === 'single' ? 'tramSetSingle' : v === 'double' ? 'tramSetDouble' : 'tramSetTrailer'), on: s.tramSet === v, key: `set-${v}`, act: () => {
          s.tramSet = v;
          chosenIn(true);
        } })),
      );
    }
    if (kind === 'pedestrian') {
      chips(
        line(box, icon('run'), t('runSpeed')),
        RUN_SPEEDS.map((v) => ({ text: `${v}`, label: `${v} km/h`, on: s.runSpeed === v, key: `run-${v}`, act: () => {
          s.runSpeed = v;
          chosenIn(true);
        } })),
      );
    }
  }

  /** The rest: the controls, the log of faults, about the game – and the other two menus. */
  function fillMore(box: HTMLElement): void {
    const grid = el('div', 'st-tiles');
    grid.append(
      tile(icon('pad'), t('controls'), false, 'controls', () => away(() => c.pages.controls())),
      tile(icon('log'), t('logTitle'), false, 'log', () => away(() => c.pages.log())),
      tile(icon('info'), t('about'), false, 'about', () => away(() => c.pages.about())),
    );
    box.append(grid);
    const styles = el('div', 'st-tiles');
    for (const [v, picture, key] of [['stage', 'stage', 'menuStage'], ['carousel', 'rows', 'menuCarousel'], ['classic', 'list', 'menuClassic']] as const) {
      styles.append(
        tile(icon(picture), t(key), s.menuStyle === v, `style-${v}`, () => {
          if (s.menuStyle === v) return;
          s.menuStyle = v;
          chosenIn();
        }),
      );
    }
    line(box, icon('stage'), t('menuStyle')).append(el('b', 'st-linetext', t('menuStyle')));
    box.append(styles);
  }

  // ---- what the keys, the gamepad, the swipe and the long press do
  const acts: Acts = {
    vehicle: (step) => choose(cycleVehicle(groups, kind, step), step),
    group: (step) => choose(cycleGroup(groups, kind, step, st.last), step),
    go: start,
    close: () => {
      if (!st.sheet) return false;
      open(st.sheet === 'lessons' || st.sheet === 'learn' ? 'mode' : null);
      return true;
    },
  };
  st.act = acts;
  listen();
  if (!st.pad) {
    st.padFresh = true;
    st.pad = requestAnimationFrame(pollPad);
  }

  // a swipe over the picture: the next vehicle (the name follows the finger a little)
  let drag: { id: number; x: number; y: number } | null = null;
  const settle = (): void => {
    label.style.transform = '';
    label.style.opacity = '';
    drag = null;
  };
  swipe.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || drag) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      swipe.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is gone already */
    }
  });
  swipe.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    label.style.transform = `translateX(${(dx * 0.3).toFixed(1)}px)`;
    label.style.opacity = String(1 - Math.min(0.6, Math.abs(dx) / 360));
  });
  swipe.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    settle();
    if (Math.abs(dx) > 40 && Math.abs(dx) > 1.3 * Math.abs(dy)) acts.vehicle((dx < 0 ? 1 : -1) * (rtl(root) ? -1 : 1));
  });
  swipe.addEventListener('pointercancel', settle);
  swipe.addEventListener('lostpointercapture', settle);
  // (a swipe on a touchpad: sideways scrolling)
  let wheel = 0;
  let wheelAt = 0;
  swipe.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      const now = performance.now();
      if (now - wheelAt > 350) wheel = 0;
      wheelAt = now;
      wheel += e.deltaX;
      if (Math.abs(wheel) > 90) {
        const step = Math.sign(wheel) * (rtl(root) ? -1 : 1);
        wheel = -1e6 * Math.sign(wheel);
        acts.vehicle(step);
      }
    },
    { passive: false },
  );

  // a long press on a button with a picture only: its name, for a moment (and the press does not count)
  let press = 0;
  let swallow = false;
  const hideTip = (): void => {
    tip.hidden = true;
  };
  root.addEventListener('pointerdown', (e) => {
    if (st.keys) {
      st.keys = false;
      root.classList.remove('keys');
    }
    swallow = false;
    hideTip();
    clearTimeout(press);
    if (e.pointerType === 'mouse') return;
    const b = (e.target as Element).closest<HTMLElement>('.st-ico, .st-pill, .st-go, .st-chip, .st-cls');
    const text = b?.getAttribute('aria-label') ?? b?.title ?? '';
    if (!b || !text) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const away = (m: PointerEvent): void => {
      if (Math.hypot(m.clientX - x0, m.clientY - y0) > 12) clearTimeout(press);
    };
    root.addEventListener('pointermove', away);
    root.addEventListener('pointerup', () => root.removeEventListener('pointermove', away), { once: true });
    press = window.setTimeout(() => {
      swallow = true;
      tip.textContent = text;
      tip.hidden = false;
      const r = b.getBoundingClientRect();
      const w = window.innerWidth;
      const high = r.top < window.innerHeight / 2;
      tip.className = `st-tip${high ? ' below' : ''}${r.left < w * 0.25 ? ' start' : r.right > w * 0.75 ? ' end' : ''}`;
      // (placed as a share of the screen: right whatever the zoom of the interface)
      tip.style.setProperty('--x', `${(((r.left + r.right) / 2 / w) * 100).toFixed(2)}%`);
      tip.style.setProperty('--y', `${((high ? r.bottom : r.top) / window.innerHeight * 100).toFixed(2)}%`);
      setTimeout(hideTip, 1600);
    }, 480);
  });
  root.addEventListener('pointerup', () => clearTimeout(press));
  root.addEventListener('pointercancel', () => clearTimeout(press));
  root.addEventListener(
    'click',
    (e) => {
      if (!swallow) return;
      swallow = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  // the control that has the focus: given back to it when the menu is drawn anew
  root.addEventListener('focusin', (e) => {
    const k = (e.target as HTMLElement).dataset?.k;
    if (k) st.focus = k;
  });

  // the sheet that was open stays open; the chosen kind in view in its strip; the focus back where it was
  if (st.sheet) open(st.sheet);
  requestAnimationFrame(() => {
    if (!root.isConnected) return;
    const on = kinds.querySelector<HTMLElement>('.on');
    if (on && kinds.scrollWidth > kinds.clientWidth + 2) on.scrollIntoView({ block: 'nearest', inline: 'center' });
    if (st.keys && st.focus) (root.querySelector<HTMLElement>(`[data-k="${CSS.escape(st.focus)}"]`) ?? go).focus();
  });

  c.preview(place.preview);
  return root;
}

// ===================================================================== keys and gamepad

/** The keys: ← → the vehicle, ↑ ↓ the kind, Enter starts, Esc closes a sheet (one listener for every menu drawn). */
function listen(): void {
  if (st.listening) return;
  st.listening = true;
  window.addEventListener('keydown', (e) => {
    const root = st.root;
    const a = st.act;
    if (!root?.isConnected || !a || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
    if (!st.keys) {
      st.keys = true;
      root.classList.add('keys');
    }
    const inSheet = st.sheet !== null;
    const code = e.code;
    if (code === 'Escape') {
      if (a.close()) e.preventDefault();
      return;
    }
    if (code.startsWith('Arrow')) {
      e.preventDefault();
      const back = code === 'ArrowLeft' || code === 'ArrowUp';
      if (inSheet) moveFocus(root.querySelector('.st-sheet'), back ? -1 : 1);
      else if (code === 'ArrowLeft' || code === 'ArrowRight') a.vehicle((back ? -1 : 1) * (rtl(root) ? -1 : 1));
      else a.group(back ? -1 : 1);
      return;
    }
    // Enter on the menu itself (no button has the focus): the drive starts – when the key comes up again
    if ((code === 'Enter' || code === 'NumpadEnter') && !e.repeat && !inSheet && !(target instanceof HTMLElement && root.contains(target) && target.closest('button, label'))) {
      st.enter = true;
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && st.enter) {
      st.enter = false;
      if (st.root?.isConnected && !st.sheet) st.act?.go();
    }
  });
}

/** The focus to the next (1) or the previous (−1) control in `box` – round. */
function moveFocus(box: Element | null, step: number): void {
  if (!box) return;
  const list = [...box.querySelectorAll<HTMLElement>('[data-k]')].filter((e) => e.offsetParent !== null && !(e as HTMLButtonElement).disabled);
  if (list.length === 0) return;
  const i = list.indexOf(document.activeElement as HTMLElement);
  list[i < 0 ? (step > 0 ? 0 : list.length - 1) : wrap(i + step, list.length)].focus();
}

/**
 * The gamepad, looked at once a picture while a menu of this kind is shown:
 * the stick or the cross ← → the vehicle (in a sheet: the next button),
 * ↑ ↓ from button to button, LB / RB the kind, A presses the button that has
 * the focus (or starts), B closes the sheet, Start starts.  (A, B and Start
 * act when let go: the press must not reach the drive that begins.)
 */
function pollPad(): void {
  const root = st.root;
  const a = st.act;
  if (!root?.isConnected || !a || typeof navigator === 'undefined' || !navigator.getGamepads) {
    st.pad = 0;
    return;
  }
  st.pad = requestAnimationFrame(pollPad);
  let gp: Gamepad | null = null;
  for (const g of navigator.getGamepads()) {
    if (g?.connected && g.mapping === 'standard') {
      gp = g;
      break;
    }
  }
  if (!gp) return;
  const b = gp.buttons.map((x) => x.pressed);
  const x = (gp.axes[0] ?? 0) < -0.6 || b[14] ? -1 : (gp.axes[0] ?? 0) > 0.6 || b[15] ? 1 : 0;
  const y = (gp.axes[1] ?? 0) < -0.6 || b[12] ? -1 : (gp.axes[1] ?? 0) > 0.6 || b[13] ? 1 : 0;
  const dir = x !== 0 ? `x${x}` : y !== 0 ? `y${y}` : '';
  const now = performance.now();
  if (st.padFresh) {
    // (what is held as the menu comes – the handbrake of the drive before, the stick – does not act)
    st.padFresh = false;
    st.padPrev = b;
    st.padHeld = b.slice();
    st.padDir = dir;
    st.padNext = now + 420;
    return;
  }
  const prev = st.padPrev;
  const held = st.padHeld;
  st.padPrev = b;
  st.padHeld = held.map((h, i) => h && !!b[i]);
  const down = (i: number): boolean => !!b[i] && !prev[i];
  const up = (i: number): boolean => !b[i] && !!prev[i] && !held[i];
  if (b.some((p) => p) || dir) {
    if (!st.keys) {
      st.keys = true;
      root.classList.add('keys');
    }
  }
  // (held: again after a moment, then quicker.  One thing a picture: most of them draw the menu anew)
  const fresh = dir !== st.padDir;
  st.padDir = dir;
  if (dir && (fresh || now >= st.padNext)) {
    st.padNext = now + (fresh ? 420 : 170);
    const sheet = root.querySelector('.st-sheet');
    if (sheet) moveFocus(sheet, x !== 0 ? x : y);
    else if (x !== 0) a.vehicle(x * (rtl(root) ? -1 : 1));
    else moveFocus(root, y);
  } else if (down(4) || down(5)) a.group(down(4) ? -1 : 1);
  else if (up(1)) {
    if (!a.close()) (document.activeElement as HTMLElement | null)?.blur();
  } else if (up(0)) {
    const f = document.activeElement;
    if (f instanceof HTMLSelectElement && root.contains(f)) {
      try {
        f.showPicker();
      } catch {
        /* (not without a touch or a click on some browsers) */
      }
    } else if (f instanceof HTMLElement && root.contains(f) && f.dataset.k) f.click();
    else if (!st.sheet) a.go();
  } else if (up(9) && !st.sheet) a.go();
}
