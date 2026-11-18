// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Parking along the streets: the bays of each side of a road that has
 * parking (src/world/xsection.ts), and the cars standing in them.
 *
 * The bays run from junction to junction, keeping the distances the
 * StVO asks for (§ 12: 5 m from a junction and before a zebra crossing,
 * 15 m around a bus stop), a little room beside a driveway, and none on a
 * piece of road that lies in another road or a junction area.  The cars are
 * put into them deterministically – each street its own share between 60
 * and 80 % – with a few kinds and colours; they stand still and go into the
 * tile's collision walls.  Lane markings use the same bays (roadmesh.ts),
 * so a car always stands inside its marked bay.
 */
import { newPolySample, samplePolyline } from '../../src/core/geom.ts';
import { PARKED_MODELS, parkedOutline } from '../../src/world/parked.ts';
import type { ParkedCar } from '../../src/world/parked.ts';
import { CTRL, EF, XING } from '../../src/world/types.ts';
import type { Arm, Edge, World } from '../../src/world/world.ts';
import { newSurfaceHit } from '../../src/world/world.ts';
import { ORIENT, PARK, parkWidth, sideLayout } from '../../src/world/xsection.ts';
import type { RoadSideJson, SideLayout } from '../../src/world/xsection.ts';
import type { TileSet } from './meshacc.ts';
import type { EdgeFeature } from './roads.ts';

/** The angle of a diagonal bay against the road (rad). */
export const DIAGONAL_ANGLE = (60 * Math.PI) / 180;

/** How far apart the bays are along the road, by ORIENT. */
export function bayPitch(orient: number): number {
  return orient === ORIENT.PERPENDICULAR ? 2.5 : orient === ORIENT.DIAGONAL ? 2.5 / Math.sin(DIAGONAL_ANGLE) : 5.8;
}

/** One bay: from s0 to s1 along the road (for a diagonal bay: its edge on the side of the lanes; its kerb side lies further on in the direction of travel). */
export interface Bay {
  s0: number;
  s1: number;
  /** a kerbed tree bulb stands here instead of a car (parking:<side>:trees, or a mapped tree in the strip): the OSM node, or -1 */
  tree?: number;
}

/** A mapped tree standing in a parking strip: the side of the road and its station. */
export interface StripTree {
  side: 1 | -1;
  s: number;
  osm: number;
}

/** The parking of one side of a road: its layout and its bays. */
export interface SideParking {
  side: 1 | -1;
  xs: RoadSideJson;
  lay: SideLayout;
  orient: number;
  /** distances from the centreline to the inner and outer edge of the strip */
  inner: number;
  outer: number;
  /** which way the traffic beside the bays goes: +1 along a→b, −1 against */
  along: 1 | -1;
  bays: Bay[];
}

/** The minor roads that make a junction a mere driveway. */
function minorArm(a: Arm): boolean {
  return (a.edge.flags & EF.MINOR_SERVICE) !== 0 || a.edge.tier === 0;
}

/** How far from its node parking keeps at one end of a road. */
function endClearance(arm: Arm): number {
  const node = arm.node;
  if (node.ctrl === CTRL.MAP_END || node.arms.length <= 1) return arm.cut + 0.5;
  const others = node.arms.filter((a) => a !== arm);
  const real = others.filter((a) => !minorArm(a));
  // a plain joint, or the continuing road and driveways off it
  if (others.length === 1 && real.length === 1) return arm.cut;
  if (real.length <= 1) return arm.cut + 1.5;
  return Math.max(arm.cut + 5, arm.stopS + 3);
}

/**
 * The stretches along a road (stations) where parking is allowed: between the
 * ends' clearances, without the stretches around crossings, bus stops and barriers.
 */
export function parkingRuns(world: World, e: Edge, features: readonly EdgeFeature[] = []): Array<[number, number]> {
  const a = endClearance(e.armA);
  const b = e.len - endClearance(e.armB);
  if (b - a < 2) return [];
  const cut: Array<[number, number]> = [];
  for (const x of e.xings) {
    const around = x.k === XING.ZEBRA ? 5 : 2;
    cut.push([x.s - x.w / 2 - around, x.s + x.w / 2 + around]);
  }
  for (const f of features) {
    if (f.kind === 'bus_stop') cut.push([f.s - 15, f.s + 15]);
    else if (f.kind === 'crossing') cut.push([f.s - 5, f.s + 5]);
    else if (f.kind === 'barrier' || f.kind === 'level_crossing' || f.kind === 'signal') cut.push([f.s - 5, f.s + 5]);
    // (no car on a raised table, a build-out or beside an island: mapgen/streetpaint.ts)
    else if (f.kind === 'bump' && /^(table|choker|chicane|island)$/.test(f.tags.traffic_calming ?? '')) cut.push([f.s - 6, f.s + 6]);
  }
  cut.sort((p, q) => p[0] - q[0]);
  const runs: Array<[number, number]> = [];
  let from = a;
  for (const [c0, c1] of cut) {
    if (c1 <= from) continue;
    if (c0 >= b) break;
    if (c0 > from) runs.push([from, c0]);
    from = Math.max(from, c1);
  }
  if (b > from) runs.push([from, b]);
  return runs.filter(([p, q]) => q - p >= 1);
}

/** The bays of one side (null: no parking there). `side` +1: left of a→b, −1: right.  `trees`: the mapped trees in the road's strips. */
export function sideParking(world: World, e: Edge, side: 1 | -1, features: readonly EdgeFeature[] = [], trees: readonly StripTree[] = []): SideParking | null {
  const xs = side > 0 ? e.xl : e.xr;
  if (!xs || !xs.p || xs.p === PARK.NONE) return null;
  const lay = sideLayout(e.width / 2, side > 0 ? e.swL : e.swR, xs);
  if (!lay.park) return null;
  const orient = xs.po ?? ORIENT.PARALLEL;
  const pitch = bayPitch(orient);
  // diagonal bays reach further along the road at their far end: they start that much later
  const slant = orient === ORIENT.DIAGONAL ? parkWidth(xs) / Math.tan(DIAGONAL_ANGLE) : 0;
  // (the traffic beside the bays goes along a→b on the right, and on the left of a one-way road)
  const oneway = e.lanesF === 0 || e.lanesB === 0;
  const along: 1 | -1 = side < 0 || oneway ? (e.lanesF > 0 ? 1 : -1) : -1;
  const bays: Bay[] = [];
  const every = xs.pt ?? 0;
  for (const [r0, r1] of parkingRuns(world, e, features)) {
    const room = r1 - r0 - slant;
    const n = Math.floor(room / pitch + 1e-6);
    if (n < 1) continue;
    const start = r0 + (along < 0 ? slant : 0) + (room - n * pitch) / 2;
    // a tree bulb every `every` metres, the first half of that from the start of the run
    let next = every > 0 ? r0 + Math.min(every / 2, Math.max(0, room / 2 - pitch / 2)) : Infinity;
    for (let i = 0; i < n; i++) {
      const bay: Bay = { s0: start + i * pitch, s1: start + (i + 1) * pitch };
      const mid = (bay.s0 + bay.s1) / 2;
      if (mid >= next) {
        bay.tree = -1;
        next = mid + every;
      }
      bays.push(bay);
    }
  }
  // the mapped trees: in the bay they stand in (or the nearest within 3 m)
  for (const t of trees) {
    if (t.side !== side) continue;
    let best: Bay | null = null;
    let bd = 3;
    for (const b of bays) {
      const d = (t.s < b.s0 ? b.s0 - t.s : t.s > b.s1 ? t.s - b.s1 : 0) + 0.001 * Math.abs(t.s - (b.s0 + b.s1) / 2);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    if (best && (best.tree === undefined || best.tree < 0)) best.tree = t.osm;
  }
  return { side, xs, lay, orient, inner: lay.park[0], outer: lay.park[1], along, bays };
}

/** A number in [0, 1) from a few integers, the same on every build. */
export function mix01(...v: number[]): number {
  let h = 0x811c9dc5;
  for (const x of v) {
    h = Math.imul(h ^ (Math.floor(x) | 0), 0x01000193);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x297a2d39);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Which kind and colour of car (white, black, grey and silver the most). */
function pickCar(r: number, q: number): { model: number; colour: number } {
  const model = r < 0.3 ? 0 : r < 0.62 ? 1 : r < 0.88 ? 2 : 3;
  const colour = Math.floor(q * 12);
  return { model, colour };
}

const tmp = newPolySample();

/**
 * The cars standing in the bays of one side: each bay is taken or not by the
 * street's share, the car in the middle of it.  `y` gives the height of the
 * road at a place on it.
 */
export function carsOf(world: World, e: Edge, p: SideParking): ParkedCar[] {
  const cars: ParkedCar[] = [];
  const share = p.xs.pq ?? 0.6 + 0.2 * mix01(e.osm, p.side, 17);
  const along = p.along;
  const mid = (p.inner + p.outer) / 2;
  const kerbH = p.lay.kerbH;
  const lift = p.xs.p === PARK.ON_KERB ? kerbH : p.xs.p === PARK.HALF_ON_KERB ? kerbH / 2 : 0;
  const depth = p.outer - p.inner;
  for (let i = 0; i < p.bays.length; i++) {
    const bay = p.bays[i];
    if (bay.tree !== undefined) continue;
    if (mix01(e.osm, p.side, i, 3) >= share) continue;
    const { model, colour } = pickCar(mix01(e.osm, p.side, i, 5), mix01(e.osm, p.side, i, 7));
    const m = PARKED_MODELS[model];
    let s = (bay.s0 + bay.s1) / 2;
    let off = mid;
    samplePolyline(e.pl, s, tmp);
    let dx = tmp.tx * along;
    let dz = tmp.tz * along;
    if (p.orient !== ORIENT.PARALLEL) {
      // nose towards the kerb (most), turned by the bay's angle in the direction of travel
      const ang = p.orient === ORIENT.DIAGONAL ? DIAGONAL_ANGLE : Math.PI / 2;
      // outward normal of this side
      const ox = tmp.tz * p.side;
      const oz = -tmp.tx * p.side;
      const nose = p.orient === ORIENT.PERPENDICULAR && mix01(e.osm, p.side, i, 11) < 0.2 ? -1 : 1;
      dx = (Math.cos(ang) * tmp.tx * along + Math.sin(ang) * ox) * nose;
      dz = (Math.cos(ang) * tmp.tz * along + Math.sin(ang) * oz) * nose;
      if (p.orient === ORIENT.DIAGONAL) {
        // the middle of a slanted bay lies half its slant further along
        s += (depth / Math.tan(DIAGONAL_ANGLE) / 2) * along;
      }
      // the car's length across the strip: keep it in, from the outer edge
      const across = m.len * Math.sin(ang) + m.wid * Math.cos(ang);
      if (across > depth + 0.02) continue;
      off = Math.max(p.inner + across / 2, p.outer - across / 2 - 0.15);
    }
    samplePolyline(e.pl, s, tmp);
    const x = tmp.x + tmp.tz * off * p.side;
    const z = tmp.z - tmp.tx * off * p.side;
    const y = world.edgeY(e, s, x, z) + lift;
    cars.push({ x, y, z, yaw: Math.atan2(-dx, -dz), model, colour });
  }
  return cars;
}

const hit = newSurfaceHit();

/** Does a parked car stand where it should not – in another road, in a junction area, off this road? */
export function carMisplaced(world: World, e: Edge, c: ParkedCar): boolean {
  const pts = parkedOutline(c, 0.15);
  pts.push(c.x, c.z);
  for (let i = 0; i < pts.length; i += 2) {
    if (!world.surfaceAt(pts[i], pts[i + 1], c.y + 2, hit)) continue;
    if (hit.node) return true;
    if (hit.edge && hit.edge !== e && hit.zone === 0) return true;
  }
  return false;
}

/** Does a car stand on a sign post, a lamp or a tree trunk already in the tiles? */
export function carOnPost(ts: TileSet, c: ParkedCar): boolean {
  const ring = parkedOutline(c, -0.3);
  const inside = (x: number, z: number): boolean => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const cr = (ring[j * 2] - ring[i * 2]) * (z - ring[i * 2 + 1]) - (ring[j * 2 + 1] - ring[i * 2 + 1]) * (x - ring[i * 2]);
      const sg = cr > 0 ? 1 : -1;
      if (sign === 0) sign = sg;
      else if (sg !== sign) return false;
    }
    return true;
  };
  const tiles = new Set([ts.at(ring[0], ring[1]), ts.at(ring[2], ring[3]), ts.at(ring[4], ring[5]), ts.at(ring[6], ring[7])]);
  for (const t of tiles) {
    for (const s of t.signs) if (inside(s.x, s.z)) return true;
    for (const o of t.objects) if (inside(o.x, o.z)) return true;
    for (let i = 0; i < t.trees.length; i += 5) if (t.trees[i + 4] !== 2 && inside(t.trees[i], t.trees[i + 2])) return true;
  }
  return false;
}

export interface ParkingStats {
  sides: number;
  bays: number;
  cars: number;
  dropped: number;
}

/** Collision walls of a car's outline: x1, z1, x2, z2, base height per side. */
export function carWalls(c: ParkedCar): number[] {
  const p = parkedOutline(c, 0.05);
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    out.push(p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1], c.y);
  }
  return out;
}

/**
 * The cars of every road in the world into their tiles (TileData.parked, and
 * their outlines into the collision walls). `features[i]`: the mapped things
 * on road i (bus stops …).
 */
export function addParkedCars(
  world: World,
  ts: TileSet,
  features: ReadonlyArray<readonly EdgeFeature[] | undefined>,
  trees: ReadonlyArray<readonly StripTree[] | undefined> = [],
): ParkingStats {
  const stats: ParkingStats = { sides: 0, bays: 0, cars: 0, dropped: 0 };
  for (const e of world.edges) {
    if (!e || (!e.xl?.p && !e.xr?.p)) continue;
    for (const side of [1, -1] as const) {
      const p = sideParking(world, e, side, features[e.id] ?? [], trees[e.id] ?? []);
      if (!p) continue;
      stats.sides++;
      stats.bays += p.bays.length;
      for (const c of carsOf(world, e, p)) {
        if (carMisplaced(world, e, c) || carOnPost(ts, c)) {
          stats.dropped++;
          continue;
        }
        const t = ts.at(c.x, c.z);
        t.parked.push(c);
        t.collSeg.push(...carWalls(c));
        stats.cars++;
      }
    }
  }
  return stats;
}
