// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The signs a map was built without, and the rules of the signs that hold
 * only at certain times (signs.json.gz, made by tools/build-signs.ts from
 * OpenStreetMap and the map).
 *
 * The posts are the town signs that were missing (where a road leads into a
 * town at a junction, on the small roads into a town), the signs that are
 * mapped in OpenStreetMap beside the road, the plates with a time ("22–6
 * h") – each in the tile it stands in, in the shape the tiles carry their
 * own posts (src/world/tilefmt.ts SignPost).  A post marked `r` takes the
 * place of the plates of the tile's own post that stands there.  The game
 * adds them to each tile as it is loaded.
 *
 * The rules: a speed limit, a road shut to motor vehicles or to lorries –
 * each on one road of the map, in one direction or both, at the times the
 * plate says (src/sim/signtime.ts).  `TimedRules` tells the rule monitor
 * what holds now, by the game's clock.
 *
 * The file belongs to one build of the map (the roads are numbered in it):
 * made for another one, it is left alone.  The game works without it.
 */
import { holds, parseTimeWindow, signTimeOf, windowText } from '../sim/signtime.ts';
import type { SignTime, TimeWindow } from '../sim/signtime.ts';
import type { SignPost } from './tilefmt.ts';

/** A post of signs.json.gz: `r` – it takes the place of the plates of the tile's post that stands where it stands. */
export interface ExtraPost extends SignPost {
  r?: 1;
}

/** A rule set by a sign with a time on it, on one road. */
export interface TimedRuleJson {
  /** the road: its number in the map */
  e: number;
  /** for which traffic: 1 along the road's course (a → b), −1 against it, 0 both */
  d: number;
  /** 'max': the speed limit – 'hgvMax': the speed limit for vehicles over 3.5 t – 'shut': no motor vehicles – 'hgvShut': none over 3.5 t */
  k: 'max' | 'hgvMax' | 'shut' | 'hgvShut';
  /** the limit (km/h) of 'max' and 'hgvMax' */
  v?: number;
  /** when: a time as OpenStreetMap writes it ("Mo-Fr 07:00-17:00"), or 'wet' */
  w: string;
}

export interface ExtraSignsJson {
  v: 1;
  /** the build of the map it was made for (map.json meta.generated) */
  map: string;
  /** the posts, by the tile they stand in ("ix_iz", src/world/grid.ts) */
  tiles: Record<string, ExtraPost[]>;
  rules: TimedRuleJson[];
}

/** The extra signs of a map. */
export class ExtraSigns {
  readonly rules: readonly TimedRuleJson[];
  private readonly tiles: Map<string, ExtraPost[]>;

  constructor(json: ExtraSignsJson) {
    this.rules = Array.isArray(json.rules) ? json.rules : [];
    this.tiles = new Map(Object.entries(json.tiles ?? {}));
  }

  /** How many posts there are in all. */
  get posts(): number {
    let n = 0;
    for (const list of this.tiles.values()) n += list.length;
    return n;
  }

  /**
   * Put the posts of tile `key` into its list of posts `signs`: where one is
   * to take the place of a post of the tile, that post gets its plates;
   * the others are added (as copies – a tile loaded again gets them again),
   * standing on `ground(x, z, yRef)` where it says (the road, the pavement
   * or the terrain there; the file's heights are those of the road's middle).
   */
  mergeInto(key: string, signs: SignPost[], ground?: (x: number, z: number, yRef: number) => number): void {
    const extra = this.tiles.get(key);
    if (!extra) return;
    for (const p of extra) {
      if (p.r) {
        const own = signs.find((q) => Math.abs(q.x - p.x) < 0.6 && Math.abs(q.z - p.z) < 0.6);
        if (own) {
          own.s = p.s.slice();
          continue;
        }
      }
      const copy: SignPost = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, s: p.s.slice(), h: p.h };
      if (p.big) copy.big = p.big;
      const y = ground ? ground(p.x, p.z, p.y + 1.5) : Number.NaN;
      if (Number.isFinite(y) && Math.abs(y - p.y) < 6) copy.y = y;
      signs.push(copy);
    }
  }
}

/**
 * The extra signs of a map (anything with the map loader's `json` and its
 * world, src/world/loader.ts) – null where the map has none, or they were
 * made for another build of it.
 */
export async function loadExtraSigns(map: { json<T>(path: string): Promise<T | null>; world: { meta: { generated: string } } }): Promise<ExtraSigns | null> {
  try {
    const json = await map.json<ExtraSignsJson>('signs.json.gz');
    if (!json || json.v !== 1 || json.map !== map.world.meta.generated) return null;
    return new ExtraSigns(json);
  } catch {
    return null;
  }
}

interface Rule {
  d: number;
  k: TimedRuleJson['k'];
  v: number;
  when: TimeWindow | 'wet';
  /** what the plate says, for the speed-limit display: "22–6 h", "bei Nässe" */
  text: string;
}

/**
 * What the signs with a time on them say now, road by road – by the game's
 * clock (`clock`, the moment of the world: src/game/clock.ts gameNow), and
 * the weather for those that hold "bei Nässe" (`wet`; dry where the game
 * does not say).
 */
export class TimedRules {
  private readonly byEdge = new Map<number, Rule[]>();
  private readonly clock: () => Date;
  /** is the road wet now (rain)? */
  wet: () => boolean = () => false;
  private at: SignTime | null = null;
  private atMs = Number.NaN;

  constructor(rules: readonly TimedRuleJson[], clock: () => Date) {
    this.clock = clock;
    for (const r of rules) {
      const when = r.w === 'wet' ? 'wet' : parseTimeWindow(r.w);
      if (!when) continue;
      const rule: Rule = { d: r.d, k: r.k, v: r.v ?? 0, when, text: when === 'wet' ? 'bei Nässe' : windowText(when) };
      const list = this.byEdge.get(r.e);
      if (list) list.push(rule);
      else this.byEdge.set(r.e, [rule]);
    }
  }

  /** How many roads have a rule. */
  get roads(): number {
    return this.byEdge.size;
  }

  /** The moment as the signs see it (worked out again once a second of the game's clock has passed, or when it jumped). */
  private now(): SignTime {
    const ms = this.clock().getTime();
    if (!this.at || !(Math.abs(ms - this.atMs) < 1000)) {
      this.at = signTimeOf(new Date(ms));
      this.atMs = ms;
    }
    return this.at;
  }

  private holdsNow(r: Rule): boolean {
    return r.when === 'wet' ? this.wet() : holds(r.when, this.now());
  }

  /**
   * The speed limit a sign with a time on it sets now on road `edge` for
   * traffic going `dir` (+1 along its course) – and what its plate says –,
   * null where none holds now.  It takes the place of the road's own limit
   * (a night-time 30 on a 50 road, a 100 at night where 70 holds by day);
   * `heavy` (over 3.5 t): the limits for lorries count too, the lowest wins.
   */
  limit(edge: number, dir: number, heavy: boolean): { v: number; when: string } | null {
    const list = this.byEdge.get(edge);
    if (!list) return null;
    let best: { v: number; when: string } | null = null;
    for (const r of list) {
      if (r.k !== 'max' && !(heavy && r.k === 'hgvMax')) continue;
      if (r.d !== 0 && r.d !== dir) continue;
      if (!this.holdsNow(r)) continue;
      if (!best || r.v < best.v) best = { v: r.v, when: r.text };
    }
    return best;
  }

  /** Is road `edge` shut now to this vehicle going `dir`, by a sign with a time on it?  What its plate says ("22–6 h") – '' where it is open. */
  shut(edge: number, dir: number, heavy: boolean): string {
    const list = this.byEdge.get(edge);
    if (!list) return '';
    for (const r of list) {
      if (r.k !== 'shut' && !(heavy && r.k === 'hgvShut')) continue;
      if (r.d !== 0 && r.d !== dir) continue;
      if (this.holdsNow(r)) return r.text;
    }
    return '';
  }
}
