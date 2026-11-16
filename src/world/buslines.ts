// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The lines of the city buses (buslines.json.gz, made by
 * tools/build-buslines.ts from the route relations of OpenStreetMap): for
 * each direction of a line the roads it drives along and the stops it calls
 * at – what the buses of the traffic follow (src/sim/traffic.ts), with the
 * line and its destination on their fronts.
 *
 * The roads are named as the route planner names them (routegraph.ts): a
 * "way" is a road of the map driven in one direction, road * 2 + (0: from
 * its junction a to b, 1: from b to a).  A road keeps its number in every
 * piece of the network it comes with, so a lane knows at once whether a line
 * runs along it (`wayOf` in routegraph.ts) – wherever the network is loaded.
 */
import type { BusLinesJson } from './types.ts';

/** A stop of a line: the stop place (its number in stops.json.gz), the line's way it lies on (index into `ways`) and how far along that way (m, in the direction of travel). */
export interface BusLineStop {
  place: number;
  k: number;
  m: number;
}

/** One direction of a bus line. */
export interface BusLine {
  /** its number in BusLines.lines */
  index: number;
  /** "52", "N3" – '' where OpenStreetMap has none */
  ref: string;
  name: string;
  from: string;
  to: string;
  operator: string;
  /** "#e3000f" or '' */
  colour: string;
  /** 0 bus, 1 trolleybus */
  kind: number;
  /** the route relation in OpenStreetMap */
  osm: number;
  /** the ways it drives, in order: its route – and from `end` on the way round to where `back` begins */
  ways: Int32Array;
  end: number;
  /** its stops, in order */
  stops: BusLineStop[];
  /** the line it goes on as at the end of its route (the line back, or itself round again), or null */
  back: BusLine | null;
}

/** The ways of a line as the file keeps them: each as the difference to the one before (mostly ±2, which packs small). */
export function encodeWays(ways: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < ways.length; i++) out.push(i === 0 ? ways[0] : ways[i] - ways[i - 1]);
  return out;
}

export class BusLines {
  readonly lines: BusLine[] = [];
  /** the build of the road network the ways belong to (meta.generated of the map), and how many stop places the stops count on */
  readonly map: string;
  readonly places: number;
  /** for each way, which lines drive along it: refLine/refK[start[w] … start[w + 1] - 1] (ways beyond `start` have none) */
  private readonly start: Uint32Array;
  private readonly refLine: Uint32Array;
  private readonly refK: Uint32Array;

  constructor(json: BusLinesJson) {
    this.map = json.map ?? '';
    this.places = json.places ?? 0;
    let total = 0;
    let maxWay = -1;
    json.lines.forEach((l, index) => {
      const ways = new Int32Array(l.w.length);
      let w = 0;
      for (let i = 0; i < l.w.length; i++) {
        w = i === 0 ? l.w[0] : w + l.w[i];
        ways[i] = w;
        if (w > maxWay) maxWay = w;
      }
      const stops: BusLineStop[] = [];
      for (let i = 0; i + 2 < l.st.length; i += 3) if (l.st[i + 1] < ways.length) stops.push({ place: l.st[i], k: l.st[i + 1], m: l.st[i + 2] });
      stops.sort((a, b) => a.k - b.k || a.m - b.m);
      total += ways.length;
      this.lines.push({
        index,
        ref: l.ref ?? '',
        name: l.name ?? '',
        from: l.from ?? '',
        to: l.to ?? '',
        operator: l.operator ?? '',
        colour: l.colour ?? '',
        kind: l.kind ?? 0,
        osm: l.osm ?? 0,
        ways,
        end: Math.min(l.end ?? ways.length, ways.length),
        stops,
        back: null,
      });
    });
    json.lines.forEach((l, i) => {
      if (l.back !== undefined && l.back >= 0 && l.back < this.lines.length) this.lines[i].back = this.lines[l.back];
    });
    // which lines run along each way: counted, then filled in (one pass each)
    this.start = new Uint32Array(maxWay + 2);
    for (const line of this.lines) for (const w of line.ways) if (w >= 0) this.start[w + 1]++;
    for (let w = 0; w <= maxWay; w++) this.start[w + 1] += this.start[w];
    this.refLine = new Uint32Array(total);
    this.refK = new Uint32Array(total);
    const fill = this.start.slice(0, maxWay + 1);
    for (const line of this.lines) {
      for (let k = 0; k < line.ways.length; k++) {
        const w = line.ways[k];
        if (w < 0) continue;
        const at = fill[w]++;
        this.refLine[at] = line.index;
        this.refK[at] = k;
      }
    }
  }

  /** Do these lines belong to this build of the map – its road network (meta.generated) and, if given, the number of its stop places? */
  fits(generated: string, places?: number): boolean {
    return this.map === generated && (places === undefined || places === this.places);
  }

  /** Visit the lines that drive along way `w`, each with where on its ways that is (a line that drives it twice comes twice). */
  forEachAt(w: number, visit: (line: BusLine, k: number) => void): void {
    if (w < 0 || w + 1 >= this.start.length) return;
    for (let i = this.start[w]; i < this.start[w + 1]; i++) visit(this.lines[this.refLine[i]], this.refK[i]);
  }

  /** The lines along way `w`, with where on their ways it is. */
  at(w: number): Array<{ line: BusLine; k: number }> {
    const out: Array<{ line: BusLine; k: number }> = [];
    this.forEachAt(w, (line, k) => out.push({ line, k }));
    return out;
  }

  /** Does any line drive along way `w`? */
  has(w: number): boolean {
    return w >= 0 && w + 1 < this.start.length && this.start[w + 1] > this.start[w];
  }

  /** The stops of a line on its ways k0 … k1, in order. */
  stopsOn(line: BusLine, k0: number, k1: number, out: BusLineStop[] = []): BusLineStop[] {
    out.length = 0;
    const s = line.stops;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].k < k0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < s.length && s[i].k <= k1; i++) out.push(s[i]);
    return out;
  }
}

/**
 * The bus lines of a map (anything with the map loader's `json` and its
 * world: src/world/loader.ts) – null where the map has none, or where they
 * were made for another build of its road network (the numbers of the roads
 * would lead astray), or – given the number of its stop places – for other
 * stops.
 */
export async function loadBusLines(map: { json<T>(path: string): Promise<T | null>; world: { meta: { generated: string } } }, places?: number): Promise<BusLines | null> {
  try {
    const json = await map.json<BusLinesJson>('buslines.json.gz');
    if (!json || !Array.isArray(json.lines)) return null;
    const lines = new BusLines(json);
    return lines.fits(map.world.meta.generated, places) ? lines : null;
  } catch {
    return null;
  }
}
