// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What a level crossing (Bahnübergang) is equipped with: barriers (half or
 * full), lights (the yellow and red "Lichtzeichen", or the older red
 * flashing "Blinklicht"), a bell – or nothing but the St Andrew's cross
 * (Zeichen 201), where the trains have the right of way and the road
 * traffic looks out for them (§ 19 Abs. 1, 2 StVO).
 *
 * The map knows where a road crosses a track (CrossingJson of kind
 * XING.RAIL or XING.TRAM), not how the crossing is secured; that comes from
 * the tags of OpenStreetMap kept in levelcrossings.data.ts (written by
 * tools/build-levelcrossings.ts) and matched by position.  Where the map
 * does not say, it is guessed from the road: barriers and lights on the
 * main roads, lights on the smaller ones, only the cross on tracks and
 * service roads – and a crossing of the trams has nothing of its own
 * (unless the map says so): the junction's lights, or the tram's right of
 * way, rule it.
 */
import { LEVEL_CROSSING_DATA } from './levelcrossings.data.ts';

export type Barrier = 'none' | 'half' | 'full';
/** the yellow and then red lights of today, the red flashing light of older crossings, or none */
export type LightKind = 'none' | 'yellowRed' | 'blink';

export interface Equipment {
  barrier: Barrier;
  light: LightKind;
  bell: boolean;
  /** a crossing of a railway (else of a tramway) */
  rail: boolean;
  /** whether the tags of the map said what it has (else it is guessed from the road) */
  mapped: boolean;
}

/** One record of the list: where it is and what the map says (letters as in levelcrossings.data.ts). */
interface Tagged {
  x: number;
  z: number;
  rail: boolean;
  barrier: string;
  light: string;
  bell: string;
  control: string;
}

let index: Map<number, Tagged[]> | null = null;
const CELL = 100;
const key = (cx: number, cz: number): number => (cx + 4096) * 8192 + (cz + 4096);

/** The list of the map's tags, by cells of 100 m. */
function tagged(): Map<number, Tagged[]> {
  if (index) return index;
  index = new Map();
  for (const rec of LEVEL_CROSSING_DATA.split(';')) {
    const [xs, zs, code] = rec.split(' ');
    if (!code || code.length < 5) continue;
    const t: Tagged = { x: Number(xs), z: Number(zs), rail: code[0] === 'r', barrier: code[1], light: code[2], bell: code[3], control: code[4] };
    const k = key(Math.floor(t.x / CELL), Math.floor(t.z / CELL));
    let list = index.get(k);
    if (!list) index.set(k, (list = []));
    list.push(t);
  }
  return index;
}

/** The tags of the map for the crossing at (x, z): the nearest record within `reach` metres, or null. */
export function taggedAt(x: number, z: number, reach = 8): { barrier: string; light: string; bell: string; control: string } | null {
  const idx = tagged();
  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  let best: Tagged | null = null;
  let bd = reach;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (const t of idx.get(key(cx + i, cz + j)) ?? []) {
        const d = Math.hypot(t.x - x, t.z - z);
        if (d <= bd) {
          bd = d;
          best = t;
        }
      }
    }
  }
  return best;
}

/**
 * What the crossing at (x, z) is equipped with: a crossing of a railway
 * (`rail`) or of a tramway, on a road of priority tier `tier`
 * (CLASS_TIER) – the map's tags where it has them, else a guess.
 */
export function equipmentFor(x: number, z: number, rail: boolean, tier: number, tags = taggedAt(x, z)): Equipment {
  if (tags) {
    // (a road's traffic lights at a tram's crossing: those rule it; nothing of the railway's own)
    if (tags.control === 's' && !rail) return { barrier: 'none', light: 'none', bell: false, rail, mapped: true };
    const barrier: Barrier = tags.barrier === 'f' ? 'full' : tags.barrier === 'h' || tags.barrier === 'd' || tags.barrier === 'y' ? 'half' : tags.barrier === 'n' ? 'none' : guessBarrier(rail, tier);
    // (barriers always come with lights in Germany; without barriers the map's word, else the road's)
    const lit = tags.light === 'y' || (tags.light !== 'n' && (barrier !== 'none' || (tags.barrier !== 'n' && guessLit(rail, tier))));
    const light: LightKind = !lit ? 'none' : barrier !== 'none' || !rail ? 'yellowRed' : 'blink';
    const bell = tags.bell === 'y' || (tags.bell !== 'n' && lit && rail);
    return { barrier, light, bell, rail, mapped: true };
  }
  const barrier = guessBarrier(rail, tier);
  const lit = barrier !== 'none' || guessLit(rail, tier);
  return { barrier, light: !lit ? 'none' : barrier !== 'none' ? 'yellowRed' : 'blink', bell: lit && rail, rail, mapped: false };
}

/** half barriers on the main roads (tertiary and up) where a railway crosses them; the trams' crossings have none */
function guessBarrier(rail: boolean, tier: number): Barrier {
  return rail && tier >= 3 ? 'half' : 'none';
}

/** lights where a railway crosses a residential road or a bigger one */
function guessLit(rail: boolean, tier: number): boolean {
  return rail && tier >= 2;
}
