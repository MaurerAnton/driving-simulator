// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where the furniture of a bus stop stands: the sign, the shelter, the bench,
 * the departure board and the people waiting – on the pavement beside the
 * carriageway, never on it.
 *
 * The map puts a stop's pole wherever its mapper did: at the kerb, on the
 * pavement, on the road's centre line (a highway=bus_stop node on the way
 * itself, or a stop position), between the two carriageways of a dual road.
 * From the road the pole belongs to and that road's cross-section
 * (src/world/xsection.ts) this works out the line along which the furniture
 * begins: behind the kerb, behind cars parked on the pavement and behind a
 * cycle track where a pavement lies beyond it – on the side the bus stops at.
 *
 *  - A pole beside the road keeps its side; it is moved out only as far as
 *    it stands in the way.
 *  - A pole on the carriageway goes to its nearer kerb – or, mapped on the
 *    road itself or near its middle, to the right of the way the buses run.
 *  - A bus stop on a carriageway of a dual road, or mapped between the two,
 *    goes to the right-hand kerb of the nearer one (a bus opens its doors on
 *    the right).
 *
 * TransitScene (transit.ts) then still checks every piece against the road
 * surface and steps it back where a junction's corner reaches it.
 */
import { newPolySample, projectOnPolyline, samplePolyline } from '../core/geom.ts';
import type { PolyProjection } from '../core/geom.ts';
import { CLS, EF, STOP_FLAG } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { Edge, World } from '../world/world.ts';
import { sideLayout } from '../world/xsection.ts';

/** what the placement needs of the road network (World has it) */
export interface StopRoads {
  segmentsInBox(minX: number, minZ: number, maxX: number, maxZ: number, visit: (e: Edge, seg: number) => void): void;
}

export interface StopSpot {
  /** the foot of the pole: the front line of the furniture */
  x: number;
  z: number;
  /** facing the road (yaw: 0 = north, + = turned left) */
  yaw: number;
  /** the road it belongs to (null: none near – the spot is the pole's own) */
  edge: Edge | null;
  /** on which side of the road (+1 left, −1 right of its direction a→b) */
  side: number;
  /** the distance of the spot from the road's centre line, and how far from it the way is clear */
  dist: number;
  clear: number;
  /** whether the spot is not where the pole was mapped */
  moved: boolean;
}

/** how far behind the clear line the pole stands (m) */
export const KERB_GAP = 0.35;
/** how far a stop's road may be from its pole (m) */
const REACH = 25;

const proj: PolyProjection = { s: 0, off: 0, d2: 0, seg: 0 };
const smp = newPolySample();

/** Is this a road a bus stops at (not a parking aisle, a field track, a tunnel or bridge below or above)? */
function busRoad(e: Edge): boolean {
  return e.cls !== CLS.TRACK && (e.flags & (EF.MINOR_SERVICE | EF.TUNNEL)) === 0;
}

/**
 * How far from the centre line of `e` nothing of the stop may stand on `side`: the kerb, cars parked on
 * the pavement, and a cycle track with a pavement beyond it.
 */
export function clearOf(e: Edge, side: number): number {
  const half = e.width / 2;
  const lay = sideLayout(half, side > 0 ? e.swL : e.swR, side > 0 ? e.xl : e.xr);
  let clear = lay.kerb;
  if (lay.park) clear = Math.max(clear, lay.park[1]);
  // (on a cycle track only where there is a pavement to stand on beyond it)
  if (lay.track && lay.walk) clear = Math.max(clear, lay.track[1]);
  return clear;
}

/**
 * The spot for the furniture of the pole at (x, z) with its STOP_FLAG `flags`; `y` picks the road at the
 * pole's level where roads cross.
 */
export function stopSpot(roads: StopRoads, x: number, z: number, y: number, flags: number): StopSpot {
  // the road: the one whose carriageway is nearest, at the pole's level
  let best: Edge | null = null;
  let bestD = Infinity;
  let bestS = 0;
  let bestOff = 0;
  roads.segmentsInBox(x - REACH, z - REACH, x + REACH, z + REACH, (e, seg) => {
    if (!busRoad(e)) return;
    projectOnPolyline(e.pl, x, z, proj, seg, seg);
    const d = Math.max(0, Math.sqrt(proj.d2) - e.width / 2);
    if (d > REACH) return;
    samplePolyline(e.pl, proj.s, smp, seg);
    if (Math.abs(smp.y - y) > 4) return;
    // (at the same distance – the pole on two carriageways at once – the one it is nearer the middle of)
    const score = d + Math.sqrt(proj.d2) * 1e-3;
    if (score < bestD) {
      bestD = score;
      best = e;
      bestS = proj.s;
      bestOff = proj.off;
    }
  });
  const e = best as Edge | null;
  if (!e) return { x, z, yaw: 0, edge: null, side: 0, dist: 0, clear: 0, moved: false };
  samplePolyline(e.pl, bestS, smp);
  // left of a→b in the world (x east, z south): the tangent turned a quarter to the left
  const lx = smp.tz;
  const lz = -smp.tx;
  const half = e.width / 2;
  const abs = Math.abs(bestOff);
  // the way the buses run: +1 along a→b, −1 against it, 0 both ways
  const way = e.lanesF > 0 && e.lanesB === 0 ? 1 : e.lanesB > 0 && e.lanesF === 0 ? -1 : 0;
  // the right of the way they run, as a side of a→b (right of a→b is −1)
  const right = way === 0 ? -1 : -way;
  let side = bestOff >= 0 ? 1 : -1;
  const bus = (flags & STOP_FLAG.TRAM) === 0;
  // (mapped on the road itself, or near the middle of the carriageway: to the right of the way the buses run)
  if (flags & STOP_FLAG.ON_ROAD || abs < half * 0.35) side = right;
  // on a carriageway of a dual road, or between the two: to its right-hand kerb (a bus opens its doors on the right)
  else if (bus && way !== 0 && e.flags & EF.DUAL && side !== right && abs - half < 15) side = right;
  const clear = clearOf(e, side);
  const sameSide = (bestOff >= 0 ? 1 : -1) === side;
  const want = clear + KERB_GAP;
  const dist = sameSide && abs > want ? abs : want;
  const moved = !sameSide || abs < want;
  const px = moved ? smp.x + lx * side * dist : x;
  const pz = moved ? smp.z + lz * side * dist : z;
  // facing the road: towards the centre line
  const fx = -lx * side;
  const fz = -lz * side;
  return { x: px, z: pz, yaw: Math.atan2(-fx, -fz), edge: e, side, dist, clear, moved };
}

const hit = newSurfaceHit();

/**
 * Does (x, z) lie where nothing of a stop may stand: on a carriageway (parking lanes and cycle lanes are part
 * of it), or on the pavement among the cars parked on it or on a cycle track (`clearOf`)?
 */
export function inTheWay(world: Pick<World, 'surfaceAt'>, x: number, z: number, y: number): boolean {
  if (!world.surfaceAt(x, z, y, hit)) return false;
  if (hit.zone === 0) return true;
  const e = hit.edge;
  if (hit.zone !== 1 || !e) return false;
  return Math.abs(hit.off) < clearOf(e, hit.off >= 0 ? 1 : -1) - 0.05;
}
