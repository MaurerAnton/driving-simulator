// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Start or jump to an address: search in the house numbers of the map
 * (OpenStreetMap `addr:*`, see tools/build-addresses.ts) and find the spot on
 * the road in front of the house.
 */
import { newPolySample, projectOnPolyline } from '../core/geom.ts';
import { LaneGraph, lanePoint } from '../world/lanes.ts';
import type { Lane } from '../world/lanes.ts';
import { CLS, EF } from '../world/types.ts';
import type { SpawnJson } from '../world/types.ts';
import type { Edge, World } from '../world/world.ts';

/** What `public/map/addresses.json` holds: world coordinates in whole metres. */
export interface AddressJson {
  version: number;
  streets: Array<{
    /** street */
    n: string;
    /** town, with the district where known */
    c: string;
    /** a point of the street (for "anywhere in this street") */
    x: number;
    z: number;
    /** house numbers: number, x, z, number, x, z, … */
    h: Array<string | number>;
  }>;
}

export interface AddressHit {
  /** "Am Stadtpark 5, Baunatal" */
  label: string;
  street: string;
  /** position of the house (or of the street) in world coordinates */
  x: number;
  z: number;
  /** the house number asked for was found */
  exact: boolean;
}

/**
 * Lower case, no accents, "straße" = "strasse" = "str.", "ue" = "ü" = "u":
 * whatever the keyboard at hand makes of a German street name.
 */
export function normaliseAddress(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ae/g, 'a')
    .replace(/oe/g, 'o')
    .replace(/ue/g, 'u')
    .replace(/strasse/g, 'str')
    .replace(/str\./g, 'str')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface Street {
  name: string;
  town: string;
  /** normalised, with and without spaces */
  key: string;
  flat: string;
  townKey: string;
  x: number;
  z: number;
  houses: Array<{ no: string; key: string; x: number; z: number }>;
}

const houseKey = (no: string): string => no.toLowerCase().replace(/[^a-z0-9]/g, '');

/** "12", "12a", "12-14" … in house-number order */
function compareHouse(a: string, b: string): number {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b, 'de');
}

export class AddressIndex {
  private readonly streets: Street[] = [];

  constructor(json: AddressJson) {
    for (const s of json.streets) {
      const houses: Street['houses'] = [];
      for (let i = 0; i + 2 < s.h.length; i += 3) houses.push({ no: String(s.h[i]), key: houseKey(String(s.h[i])), x: Number(s.h[i + 1]), z: Number(s.h[i + 2]) });
      houses.sort((a, b) => compareHouse(a.no, b.no));
      const key = normaliseAddress(s.n);
      this.streets.push({ name: s.n, town: s.c, key, flat: key.replace(/ /g, ''), townKey: normaliseAddress(s.c), x: s.x, z: s.z, houses });
    }
  }

  get size(): number {
    return this.streets.reduce((n, s) => n + s.houses.length, 0);
  }

  get streetCount(): number {
    return this.streets.length;
  }

  /**
   * "am stadtpark 5", "hauptstr grossenritte", "5 Marktplatz" …
   * Best matches first; with a house number the houses of the matching
   * streets, without one the streets themselves.
   */
  search(query: string, limit = 8): AddressHit[] {
    const full = normaliseAddress(query);
    const place = (s: Street): string => (s.town ? `, ${s.town}` : '');
    // a road known by its number ("A 49", "L 3219"): that is no house number
    if (/\d/.test(full)) {
      const flat = full.replace(/ /g, '');
      const roads = this.streets.filter((s) => /\d/.test(s.key) && (s.key.startsWith(full) || s.flat.startsWith(flat)));
      if (roads.length > 0) {
        roads.sort((a, b) => a.flat.length - b.flat.length || a.name.localeCompare(b.name, 'de') || a.town.localeCompare(b.town, 'de'));
        return roads.slice(0, limit).map((s) => ({ label: `${s.name}${place(s)}`, street: s.name, x: s.x, z: s.z, exact: false }));
      }
    }
    const tokens = full.split(' ').filter(Boolean);
    // the house number: the first token that starts with a digit ("5", "5a", or "5" + "a")
    let house = '';
    const words: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!house && /^\d+[a-z]?$/.test(t)) {
        house = t;
        if (/^\d+$/.test(t) && i + 1 < tokens.length && /^[a-z]$/.test(tokens[i + 1])) house += tokens[++i];
      } else words.push(t);
    }
    if (words.length === 0) return [];
    const scored: Array<{ s: Street; score: number }> = [];
    for (const s of this.streets) {
      let score = 0;
      let ok = true;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (s.key.startsWith(w) || s.flat.startsWith(w)) score += i === 0 ? 6 : 4;
        else if (s.key.split(' ').some((p) => p.startsWith(w))) score += 4;
        else if (w.length >= 3 && s.flat.includes(w)) score += 2;
        else if (s.townKey.split(' ').some((p) => p.startsWith(w))) score += 1;
        else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      // the whole query is the whole name: that is the one meant
      if (s.key === words.join(' ') || s.flat === words.join('')) score += 5;
      if (house && s.houses.some((h) => h.key === house)) score += 3;
      scored.push({ s, score: score - s.flat.length * 0.01 });
    }
    scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name, 'de') || a.s.town.localeCompare(b.s.town, 'de'));
    const out: AddressHit[] = [];
    for (const { s } of scored) {
      if (out.length >= limit) break;
      if (!house) {
        out.push({ label: `${s.name}${place(s)}`, street: s.name, x: s.x, z: s.z, exact: false });
        continue;
      }
      const exact = s.houses.filter((h) => h.key === house);
      // "5" also offers 5a, 5b – and, further down, 50 … 59
      const digits = /^\d+$/.test(house);
      const same = digits ? s.houses.filter((h) => h.key !== house && parseInt(h.key, 10) === Number(house)) : [];
      const longer = digits ? s.houses.filter((h) => h.key.startsWith(house) && parseInt(h.key, 10) !== Number(house)) : [];
      const list = [...exact, ...same, ...longer].slice(0, Math.max(1, Math.min(4, limit - out.length)));
      for (const h of list) out.push({ label: `${s.name} ${h.no}${place(s)}`, street: s.name, x: h.x, z: h.z, exact: h.key === house });
      if (list.length === 0) out.push({ label: `${s.name}${place(s)}`, street: s.name, x: s.x, z: s.z, exact: false });
    }
    return out.slice(0, limit);
  }
}

// ------------------------------------------------------------------ road spot
const proj = { s: 0, off: 0, d2: 0, seg: 0 };
const smp = newPolySample();

/**
 * The lanes of the connected road network: those one can reach from the town
 * centre and get back from.  At the rim of the map there are fragments of
 * streets whose connections lie outside it – nobody should be put there.
 */
export function mainNetwork(world: World, graph: LaneGraph): Set<number> {
  // start from the lanes of the road nearest to the first starting point
  const sp = world.json.spawns[0] ?? { x: 0, z: 0 };
  let seed: Edge | null = null;
  let bd = Infinity;
  for (const e of world.edges) {
    if (!LaneGraph.drivable(e, true)) continue;
    const mid = (e.pl.pts.length / 3) >> 1;
    const d = Math.hypot(e.pl.pts[mid * 3] - sp.x, e.pl.pts[mid * 3 + 2] - sp.z);
    if (d < bd) {
      bd = d;
      seed = e;
    }
  }
  const walk = (forward: boolean): Set<number> => {
    const seen = new Set<number>();
    const stack: Lane[] = seed ? [...graph.edgeLanes[seed.id].fwd, ...graph.edgeLanes[seed.id].back] : [];
    for (const l of stack) seen.add(l.id);
    while (stack.length > 0) {
      const l = stack.pop() as Lane;
      for (const c of forward ? l.out : l.in) {
        const n = forward ? c.to : c.from;
        // only by roads one may use: a village joined to the rest by a farm track is not connected
        if (!seen.has(n.id) && LaneGraph.drivable(n.edge, false)) {
          seen.add(n.id);
          stack.push(n);
        }
      }
    }
    return seen;
  };
  const there = walk(true);
  const back = walk(false);
  const out = new Set<number>();
  for (const id of there) if (back.has(id)) out.add(id);
  return out;
}

/**
 * Where to put the car for a house at (x, z): on the nearest road one may
 * drive on – preferably the street of that name –, in the right-hand lane,
 * with the house on the right, clear of the junctions.
 */
export function findRoadSpot(world: World, graph: LaneGraph, x: number, z: number, street = '', maxDist = 220, main?: Set<number>, accept?: (e: Edge) => boolean, room = 2): SpawnJson | null {
  const want = normaliseAddress(street);
  let best: { edge: Edge; s: number; off: number; score: number } | null = null;
  const usable = (l: Lane): boolean => !main || main.has(l.id);
  for (const roomy of [true, false]) {
    world.edgesInBox(x - maxDist, z - maxDist, x + maxDist, z + maxDist, (e) => {
      if (!LaneGraph.drivable(e, false) || (accept && !accept(e))) return;
      const lanes = graph.edgeLanes[e.id];
      if (!lanes.fwd.some(usable) && !lanes.back.some(usable)) return;
      // keep out of the junction areas at both ends
      const margin = roomy ? 6 : 1;
      const lo = e.cutA + margin;
      const hi = e.len - e.cutB - margin;
      if (hi - lo < (roomy ? 8 : 0.5)) return;
      projectOnPolyline(e.pl, x, z, proj);
      const s = Math.max(lo, Math.min(hi, proj.s));
      const d = Math.sqrt(proj.d2) + Math.abs(s - proj.s);
      if (d > maxDist) return;
      let score = d;
      const named = want !== '' && (normaliseAddress(e.name) === want || normaliseAddress(e.ref) === want);
      if (want && !named) score += 70;
      if (e.cls <= CLS.TRUNK_LINK && !named) score += 400; // nobody lives on the motorway
      if (e.flags & (EF.TUNNEL | EF.BRIDGE)) score += 60;
      // a proper street rather than the yard or car park next to the house
      if (!LaneGraph.drivable(e, true)) score += 150;
      if (!best || score < best.score) best = { edge: e, s, off: proj.off, score };
    });
    if (best) break;
  }
  const b = best as { edge: Edge; s: number; off: number; score: number } | null;
  if (!b) return null;
  const lanes = graph.edgeLanes[b.edge.id];
  // the house on the right: it lies left of a→b, so drive b→a (if that way is open)
  const side = (b.off > 0 ? [lanes.back, lanes.fwd] : [lanes.fwd, lanes.back]).map((l) => l.filter(usable));
  const dir = side[0].length > 0 ? side[0] : side[1];
  const lane: Lane = dir.find((l) => l.idx === 0) ?? dir[0];
  const d = lane.dir > 0 ? b.s - lane.s0 : lane.s0 - b.s;
  // (`room`: metres of lane wanted behind the spot – a trailer must not hang back into the junction)
  lanePoint(lane, Math.max(Math.min(room, lane.len / 2), Math.min(lane.len - Math.min(2, lane.len / 2), d)), smp);
  // (named after its street, for whoever shows the spot on a map)
  return { name: b.edge.name || b.edge.ref || '', x: smp.x, z: smp.z, yaw: Math.atan2(-smp.tx, -smp.tz), kind: 'street' };
}
