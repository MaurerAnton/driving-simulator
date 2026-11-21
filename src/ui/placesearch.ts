// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Looking for a place on the big map: one field for towns and villages,
 * stops of trams and buses, streets and house numbers.  The towns of the
 * map (world.json places) and the stops (stops.json.gz) come first, then
 * what the address search finds (game/address.ts) – the map goes to the
 * place picked.
 */

import { normaliseAddress } from '../game/address.ts';
import type { AddressHit } from '../game/address.ts';

/** A town, a village or a part of one (world.json `places`). */
export interface TownSource {
  name: string;
  kind: string;
  x: number;
  z: number;
}

/** A stop of trams or buses (world/stops.ts StopPlace). */
export interface StopSource {
  name: string;
  town: string;
  x: number;
  z: number;
}

/**
 * A line of public transport as the search may find it: its number ("5", "52",
 * "N3"), whether it is a tram or a bus, and where it runs (for putting the map
 * there).  The lines come from lines.json.gz (trams) and buslines.json.gz
 * (world/buslines.ts); `ref` is what the player types.
 */
export interface LineSource {
  /** the line's number as it is shown ("5", "52") */
  ref: string;
  /** 'tram' or 'bus' (the timetable's kinds) */
  kind: 'tram' | 'bus';
  /** where it runs: its first stop (for putting the map there) */
  x: number;
  z: number;
  /** the line's index in its own list (to show its whole way) */
  index: number;
}

/** What the map's search field finds: an address hit, with what kind of place it is. */
export interface PlaceHit extends AddressHit {
  /** 'town' (also a village or a part of a town), 'stop', 'line' (public transport), or 'address' (a street or a house) */
  what: 'town' | 'stop' | 'line' | 'address';
  /** for a 'line': the line itself (transitmap.ts shows its way) */
  line?: LineSource;
}

/** how big a kind of town is (a city first) */
const RANK: Record<string, number> = { city: 0, town: 1, village: 2, suburb: 3, quarter: 4, neighbourhood: 5, hamlet: 6, isolated_dwelling: 7 };

/** Does the name match the words asked for: each word starts one of the name's words? */
function matches(name: string, words: readonly string[]): { ok: boolean; whole: boolean } {
  const n = normaliseAddress(name);
  const parts = n.split(' ');
  const ok = words.every((w) => parts.some((p) => p.startsWith(w)));
  return { ok, whole: ok && n.startsWith(words.join(' ')) };
}

/**
 * The places that fit `query`: towns, then stops, then the addresses of
 * `addresses` (a street, a house) – each once, at most `limit`; what lies
 * near `near` first within a kind.
 */
export function searchPlaces(
  query: string,
  towns: readonly TownSource[],
  stops: readonly StopSource[],
  addresses: ((q: string, limit: number, near: { x: number; z: number } | null) => AddressHit[]) | null,
  limit = 8,
  near: { x: number; z: number } | null = null,
  lines: readonly LineSource[] = [],
): PlaceHit[] {
  const words = normaliseAddress(query).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const dist = (p: { x: number; z: number }): number => (near ? Math.hypot(p.x - near.x, p.z - near.z) : 0);
  const out: PlaceHit[] = [];
  const seen = new Set<string>();
  const add = (h: PlaceHit): void => {
    const key = `${normaliseAddress(h.label)}|${Math.round(h.x / 50)}|${Math.round(h.z / 50)}`;
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push(h);
  };
  // a line number asked for: the line comes first ("5" finds the tram 5)
  const q = normaliseAddress(query).trim();
  if (q) {
    const lm = lines.filter((l) => normaliseAddress(l.ref) === q);
    for (const l of lm.slice(0, 2)) add({ label: `${l.ref} · ${l.kind === 'tram' ? 'tram' : 'bus'}`, street: '', x: l.x, z: l.z, exact: true, what: 'line', line: l });
  }
  // towns and villages: the name begun with first, the bigger the earlier
  const t = towns
    .map((p) => ({ p, m: matches(p.name, words) }))
    .filter((q) => q.m.ok)
    .sort((a, b) => Number(b.m.whole) - Number(a.m.whole) || (RANK[a.p.kind] ?? 9) - (RANK[b.p.kind] ?? 9) || dist(a.p) - dist(b.p) || a.p.name.localeCompare(b.p.name, 'de'));
  for (const { p } of t.slice(0, Math.max(3, Math.ceil(limit / 2)))) add({ label: p.name, street: '', x: p.x, z: p.z, exact: false, what: 'town' });
  // stops: by their name, or by town and name ("Baunatal Rathaus")
  const s = stops
    .map((p) => ({ p, m: matches(`${p.town} ${p.name}`, words), n: matches(p.name, words) }))
    .filter((q) => q.m.ok || q.n.ok)
    .sort((a, b) => Number(b.n.whole) - Number(a.n.whole) || dist(a.p) - dist(b.p));
  for (const { p } of s.slice(0, 3)) add({ label: p.town && !p.name.includes(p.town) ? `${p.name}, ${p.town}` : p.name, street: '', x: p.x, z: p.z, exact: false, what: 'stop' });
  // streets and houses
  if (addresses) for (const h of addresses(query, limit, near)) add({ ...h, what: 'address' });
  return out;
}
