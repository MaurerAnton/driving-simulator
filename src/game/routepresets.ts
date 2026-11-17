// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Set routes: a handful of drives through Baunatal and Kassel laid out like
 * the routes of a practical driving test – through the districts, over the
 * country roads, into Kassel's centre, onto the A 49 – that the player
 * starts from the menu or the map and then has to drive as laid out.
 *
 * A route is given as places to pass in order (world metres, the middle of a
 * district or a point on a road) and is a round trip: from the first place
 * through the others back to the first.  Each place is put onto the nearest
 * road of the kind it asks for, and the legs between them are the quickest
 * ways on the road network of the whole map (world/routegraph.ts) – so the
 * route follows the map as it is and needs no list of streets.
 *
 * While it runs, the game shows the way as on a tour (game/nav.ts) and a
 * RouteWatch looks at the road the vehicle is on: leaving the route (more
 * than a junction's length on a road that is not part of it) is a fault, and
 * driving along it the other way – having turned round – a bigger one.
 */
import { CLS } from '../world/types.ts';
import { RG, mainWays, quickest, routeFor } from '../world/routegraph.ts';
import type { RouteGraph } from '../world/routegraph.ts';

/** A place a set route passes: where, and what kind of road to put it on. */
export interface RoutePoint {
  x: number;
  z: number;
  /** 'street' (default): a road of a town or between villages; 'motorway': the motorway itself; 'rural': a road outside the towns */
  road?: 'street' | 'motorway' | 'rural';
}

/** A set route: its name and description are texts ("routes.<id>.name", "routes.<id>.desc"). */
export interface RoutePreset {
  id: string;
  /** the places in order; the route ends where it began */
  points: readonly RoutePoint[];
}

/**
 * The set routes.  (Places by the names of the map's districts; the
 * motorway points lie on the A 49 between Baunatal and Kassel.)
 */
export const ROUTE_PRESETS: readonly RoutePreset[] = [
  // Baunatal's districts: Stadtmitte, Altenbauna, Altenritte, Großenritte, Kirchbauna – the town's junctions, its roundabouts and lights
  {
    id: 'baunatal',
    points: [
      { x: 744, z: -272 },
      { x: 1046, z: -793 },
      { x: -95, z: -988 },
      { x: -1160, z: 554 },
      { x: 1717, z: 817 },
    ],
  },
  // out of town: Hertingshausen, Guntershausen, Dittershausen, Rengershausen – country roads between villages
  {
    id: 'country',
    points: [
      { x: 744, z: -272 },
      { x: 1279, z: 2512 },
      { x: 4387, z: 2117 },
      { x: 5123, z: 41 },
      { x: 3472, z: -418 },
    ],
  },
  // into Kassel's south: Rengershausen, Niederzwehren, Oberzwehren, Nordshausen, back through Altenritte
  {
    id: 'kasselSouth',
    points: [
      { x: 744, z: -272 },
      { x: 3472, z: -418 },
      { x: 4568, z: -3746 },
      { x: 3277, z: -2382 },
      { x: 2155, z: -3129 },
      { x: -95, z: -988 },
    ],
  },
  // Kassel's centre: Wehlheiden, Vorderer Westen, Mitte, Wesertor, Bettenhausen, Südstadt – lights, tram tracks, several lanes
  {
    id: 'kasselCentre',
    points: [
      { x: 4265, z: -5927 },
      { x: 4420, z: -7169 },
      { x: 6694, z: -7060 },
      { x: 7947, z: -7963 },
      { x: 8864, z: -6025 },
      { x: 5702, z: -5903 },
    ],
  },
  // the motorway: from Baunatal onto the A 49 towards Kassel, off into Niederzwehren, back over Rengershausen
  {
    id: 'motorway',
    points: [
      { x: 744, z: -272 },
      { x: 2514, z: -1598, road: 'motorway' },
      { x: 4568, z: -3746 },
      { x: 3472, z: -418 },
    ],
  },
  // into the hills west of Baunatal: Großenritte, Elgershausen, Hoof, Altenritte
  {
    id: 'hills',
    points: [
      { x: -1160, z: 554 },
      { x: -1787, z: -2501 },
      { x: -3558, z: -3453 },
      { x: -95, z: -988 },
    ],
  },
];

/** The mode a drive is started with to run a set route at once ("route:<id>"). */
export const routeMode = (id: string): string => `route:${id}`;

/** The set route a mode asks for (null: the mode is none). */
export function presetOfMode(mode: string): RoutePreset | null {
  if (!mode.startsWith('route:')) return null;
  const id = mode.slice(6);
  return ROUTE_PRESETS.find((p) => p.id === id) ?? null;
}

/** A set route planned on the road network. */
export interface PresetPlan {
  /** the ways to drive along, after the one it starts on (as a tour's) */
  ways: number[];
  /** its length (m) */
  metres: number;
  /** the way each place of the route was put on */
  at: number[];
}

/** May a set route pass along this way? (no private roads, no yards and car parks, no walking-pace streets) */
function passable(g: RouteGraph, w: number): boolean {
  return g.len[w] > 0 && (g.kind[w] & (RG.NO_ENTRY | RG.ACCESS_ONLY | RG.MINOR)) === 0;
}

/** Is way `w` a road of the kind a place asks for? */
function fits(g: RouteGraph, w: number, road: RoutePoint['road']): boolean {
  const c = g.cls[w];
  if (road === 'motorway') return c === CLS.MOTORWAY;
  if (c < CLS.PRIMARY || c > CLS.RESIDENTIAL) return false;
  if (road === 'rural') return (g.kind[w] & RG.URBAN) === 0;
  return true;
}

/** squared distance of (x, z) from the line of way w (its ends joined straight) */
function dist2(g: RouteGraph, w: number, x: number, z: number): number {
  const ax = g.x0[w];
  const az = g.z0[w];
  const dx = g.x1[w] - ax;
  const dz = g.z1[w] - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t - x;
  const pz = az + dz * t - z;
  return px * px + pz * pz;
}

/**
 * The roads a place may be put on: the nearest ones of its kind (both
 * directions of a road where it can be driven both ways), at most `maxDist`
 * from it.  Only ways of the network one can drive around in (`main`).
 */
export function snapPoint(g: RouteGraph, p: RoutePoint, main: Uint8Array, maxDist = 600): number[] {
  let best = -1;
  let bd = maxDist * maxDist;
  for (let w = 0; w < g.n; w++) {
    if (!main[w] || !passable(g, w) || !fits(g, w, p.road)) continue;
    // (a quick look at the box first: most of the map is far away)
    if (Math.min(g.x0[w], g.x1[w]) - maxDist > p.x || Math.max(g.x0[w], g.x1[w]) + maxDist < p.x) continue;
    if (Math.min(g.z0[w], g.z1[w]) - maxDist > p.z || Math.max(g.z0[w], g.z1[w]) + maxDist < p.z) continue;
    const d = dist2(g, w, p.x, p.z);
    if (d < bd) {
      bd = d;
      best = w;
    }
  }
  if (best < 0) return [];
  const other = best ^ 1;
  return main[other] && passable(g, other) && fits(g, other, p.road) ? [best, other] : [best];
}

/** what driving along a road of the route a second time costs a leg, in seconds */
const AGAIN_SECONDS = 25;

const metresOf = (g: RouteGraph, ways: readonly number[]): number => {
  let m = 0;
  for (const w of ways) m += g.len[w];
  return m;
};

/**
 * Plan a set route from the way `start` (the road the vehicle stands on):
 * to its first place, through the others, and back to the first.  Null if
 * a place lies off the roads or a leg cannot be driven.
 */
export function planPreset(g: RouteGraph, start: number, preset: RoutePreset, main: Uint8Array = mainWays(g)): PresetPlan | null {
  const n = preset.points.length;
  if (n < 2) return null;
  const options = preset.points.map((p) => snapPoint(g, p, main));
  if (options.some((o) => o.length === 0)) return null;
  const ways: number[] = [];
  const at: number[] = [];
  let here = start;
  // Roads already on the route cost more: the legs look for other streets rather than go back the
  // way they came.  (On top of what the road events make dearer or close today.)
  const used = new Set<number>([start >> 1]);
  const before = routeFor.wayCost;
  routeFor.wayCost = (w) => (before ? before(w) : 0) + (used.has(w >> 1) ? AGAIN_SECONDS : 0);
  try {
    if (!planLegs()) return null;
  } finally {
    routeFor.wayCost = before;
  }
  return { ways, metres: metresOf(g, ways), at };

  function planLegs(): boolean {
    // the first place again at the end: a round trip
    for (let i = 0; i <= n; i++) {
      const cand = options[i % n];
      const next = preset.points[(i + 1) % n];
      let best: number[] | null = null;
      let bestCost = Infinity;
      let bestWay = -1;
      for (const w of i === n && at.length > 0 ? [at[0], ...cand.filter((c) => c !== at[0])] : cand) {
        const lead = w === here ? [] : quickest(g, here, w);
        if (!lead) continue;
        // (the way onwards counts as well: which way along the road the place is passed)
        const onward = i < n ? Math.hypot(g.x1[w] - next.x, g.z1[w] - next.z) : 0;
        const cost = metresOf(g, lead) + onward + (i === n && w !== at[0] ? 400 : 0);
        if (cost < bestCost) {
          bestCost = cost;
          best = lead;
          bestWay = w;
        }
      }
      if (!best) return false;
      ways.push(...best);
      for (const w of best) used.add(w >> 1);
      at.push(bestWay);
      here = bestWay;
    }
    return true;
  }
}

/**
 * The line of a route for the map: x, z, x, z, … along the ways in order.
 * `course(e)`: the course of road e from its junction a to b (x, z, …) –
 * without it, each way's ends joined straight.
 */
export function routeLine(g: RouteGraph, start: number, ways: readonly number[], course?: (e: number) => number[]): Float32Array {
  const out: number[] = [];
  for (const w of [start, ...ways]) {
    const c = course?.(w >> 1);
    if (!c || c.length < 4) {
      out.push(g.x0[w], g.z0[w], g.x1[w], g.z1[w]);
      continue;
    }
    if ((w & 1) === 0) for (let i = 0; i < c.length; i += 2) out.push(c[i], c[i + 1]);
    else for (let i = c.length - 2; i >= 0; i -= 2) out.push(c[i], c[i + 1]);
  }
  return Float32Array.from(out);
}

/** A fault of the set route: off it, or along it the wrong way. */
export type RouteFault = 'routeLeft' | 'routeReverse';

/** metres on a road off the route before it counts as leaving it (a junction's length, a lane change into a slip road) */
const OFF_METRES = 40;
/** metres along the route the wrong way before it counts (turning round in a street takes a few) */
const BACK_METRES = 25;

/**
 * Watches whether the set route is kept.  Fed with the way the vehicle is
 * on and its odometer; says a fault once each time the route is left (or
 * driven against), and is ready again once the vehicle is back on it.
 */
export class RouteWatch {
  private readonly on = new Set<number>();
  private offSince = -1;
  private backSince = -1;
  private leftSaid = false;
  private backSaid = false;

  constructor(start: number, ways: readonly number[]) {
    this.on.add(start);
    for (const w of ways) this.on.add(w);
  }

  /** Is this way part of the route (in this direction)? */
  has(way: number): boolean {
    return this.on.has(way);
  }

  /** The way the vehicle is on now (-1: none – in a junction, off the roads) and how far it has driven in all (m). */
  update(way: number, odometer: number): RouteFault | null {
    if (way < 0) return null;
    if (this.on.has(way)) {
      this.offSince = this.backSince = -1;
      this.leftSaid = this.backSaid = false;
      return null;
    }
    if (this.on.has(way ^ 1)) {
      // on the route, but against its direction
      this.offSince = -1;
      if (this.backSince < 0) this.backSince = odometer;
      if (!this.backSaid && odometer - this.backSince > BACK_METRES) {
        this.backSaid = true;
        return 'routeReverse';
      }
      return null;
    }
    this.backSince = -1;
    if (this.offSince < 0) this.offSince = odometer;
    if (!this.leftSaid && odometer - this.offSince > OFF_METRES) {
      this.leftSaid = true;
      return 'routeLeft';
    }
    return null;
  }
}
