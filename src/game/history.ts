// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What was looked for on the map before: the places picked in its search,
 * and the ways that were driven (to one place or several) – kept in the
 * browser, so that they are there at the next visit and a tap sets them
 * again.  Like the tours driven (tourlog.ts), only on this device.
 */

/** A place picked in the search of the map. */
export interface PlaceRecord {
  name: string;
  x: number;
  z: number;
  yaw: number;
  /** when (ISO) */
  date: string;
}

/** A way that was started: its places in order, whether the car drove it or the player. */
export interface WayRecord {
  stops: Array<{ name: string; x: number; z: number; yaw: number }>;
  self: boolean;
  date: string;
}

const PLACES_KEY = 'fahrsim.places';
const WAYS_KEY = 'fahrsim.ways';
/** how many of each are kept */
export const PLACES_KEPT = 12;
export const WAYS_KEPT = 10;

function read<T>(key: string): T[] {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as T[]) : [];
  } catch {
    return [];
  }
}

function write(key: string, list: readonly unknown[]): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(list));
  } catch {
    /* (storage full or not allowed: the history is a convenience) */
  }
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** The places picked before, the newest first. */
export function loadPlaces(): PlaceRecord[] {
  return read<PlaceRecord>(PLACES_KEY).filter((p) => p && typeof p.name === 'string' && finite(p.x) && finite(p.z));
}

/** A place picked: at the front of the list (once – a place picked again moves up). */
export function savePlace(p: Omit<PlaceRecord, 'date'>, now = new Date()): PlaceRecord[] {
  const list = loadPlaces().filter((q) => q.name !== p.name || Math.hypot(q.x - p.x, q.z - p.z) > 30);
  list.unshift({ name: p.name, x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10, yaw: Math.round((p.yaw || 0) * 1000) / 1000, date: now.toISOString() });
  list.length = Math.min(list.length, PLACES_KEPT);
  write(PLACES_KEY, list);
  return list;
}

/** The ways started before, the newest first. */
export function loadWays(): WayRecord[] {
  return read<WayRecord>(WAYS_KEY).filter((w) => w && Array.isArray(w.stops) && w.stops.length > 0 && w.stops.every((s) => s && finite(s.x) && finite(s.z)));
}

/** A way started: at the front of the list (the same places again move it up). */
export function saveWay(stops: WayRecord['stops'], self: boolean, now = new Date()): WayRecord[] {
  if (stops.length === 0) return loadWays();
  const key = (s: WayRecord['stops']): string => s.map((p) => `${p.name}|${Math.round(p.x)}|${Math.round(p.z)}`).join(';');
  const mine = key(stops);
  const list = loadWays().filter((w) => key(w.stops) !== mine);
  list.unshift({ stops: stops.map((s) => ({ name: s.name, x: Math.round(s.x * 10) / 10, z: Math.round(s.z * 10) / 10, yaw: Math.round((s.yaw || 0) * 1000) / 1000 })), self, date: now.toISOString() });
  list.length = Math.min(list.length, WAYS_KEPT);
  write(WAYS_KEY, list);
  return list;
}

// ------------------------------------------------------------------ favourite places

/** A place the player keeps: a name (given, or that of the road there) and where it is. */
export interface FavouriteRecord {
  name: string;
  x: number;
  z: number;
  yaw: number;
}

const FAVOURITES_KEY = 'fahrsim.favourites';
/** how many are kept at most */
export const FAVOURITES_KEPT = 50;

/** The favourite places, in the order they were added (the newest first). */
export function loadFavourites(): FavouriteRecord[] {
  return read<FavouriteRecord>(FAVOURITES_KEY).filter((p) => p && typeof p.name === 'string' && finite(p.x) && finite(p.z));
}

/** A place added to the favourites (a place within 20 m of one already there replaces it). */
export function saveFavourite(p: FavouriteRecord): FavouriteRecord[] {
  const list = loadFavourites().filter((q) => Math.hypot(q.x - p.x, q.z - p.z) > 20);
  list.unshift({ name: p.name, x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10, yaw: Math.round((p.yaw || 0) * 1000) / 1000 });
  list.length = Math.min(list.length, FAVOURITES_KEPT);
  write(FAVOURITES_KEY, list);
  return list;
}

/** A favourite taken out again (the one within 20 m of x, z). */
export function removeFavourite(x: number, z: number): FavouriteRecord[] {
  const list = loadFavourites().filter((q) => Math.hypot(q.x - x, q.z - z) > 20);
  write(FAVOURITES_KEY, list);
  return list;
}
