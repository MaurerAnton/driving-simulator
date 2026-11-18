// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The space between the two carriageways of a dual road, filled with what
 * lies there (median:contents on a carriageway – our own key, see
 * tools/mapgen/xsection.ts): grass, parking bays with cars, a hedge, trees.
 *
 * The other carriageway is found by looking across, every 4 m, to the left
 * of the direction of travel: the nearest road running the other way.  The
 * gap between the two kerbs (or pavements) is the median.  Where both
 * carriageways say what is in it, each fills its half and the one with the
 * smaller way id puts the hedge, trees and cars; where only one says it, it
 * fills the whole gap.
 */
import { newPolySample, projectOnPolyline, samplePolyline } from '../../src/core/geom.ts';
import type { PolyProjection } from '../../src/core/geom.ts';
import { PARKED_MODELS } from '../../src/world/parked.ts';
import type { ParkedCar } from '../../src/world/parked.ts';
import { GM } from '../../src/world/tilefmt.ts';
import { KERB_H } from '../../src/world/types.ts';
import type { Edge, World } from '../../src/world/world.ts';
import { MEDIAN } from '../../src/world/xsection.ts';
import { addBand, addQuad } from './meshacc.ts';
import type { TileSet } from './meshacc.ts';
import { carMisplaced, carOnPost, carWalls, mix01 } from './parking.ts';

/** One look across: where the median lies at a station of the carriageway (distances from its centreline). */
export interface MedianCut {
  s: number;
  /** point on the centreline and the unit normal towards the median */
  x: number;
  z: number;
  nx: number;
  nz: number;
  /** from the own kerb / pavement edge to the other's */
  g0: number;
  g1: number;
  /** road heights at both sides */
  y0: number;
  y1: number;
  partner: Edge;
}

const tmp = newPolySample();
const proj: PolyProjection = { s: 0, off: 0, d2: 0, seg: 0 };

/** The side (+1 left of a→b, −1 right) towards the median: the left of the direction of travel. */
export function medianSide(e: Edge): 1 | -1 {
  return e.lanesF > 0 ? 1 : -1;
}

/** Look across from station `s` of `e` for the other carriageway, up to `reach` metres. */
export function lookAcross(world: World, e: Edge, s: number, reach = 60): MedianCut | null {
  samplePolyline(e.pl, s, tmp);
  const side = medianSide(e);
  const x = tmp.x;
  const z = tmp.z;
  const y = tmp.y;
  // travel direction and the normal towards the median
  const dir = e.lanesF > 0 ? 1 : -1;
  const tx = tmp.tx * dir;
  const tz = tmp.tz * dir;
  const nx = tmp.tz * side;
  const nz = -tmp.tx * side;
  const ex = x + nx * reach;
  const ez = z + nz * reach;
  let best = Infinity;
  let partner: Edge | null = null;
  let bestSeg = 0;
  world.segmentsInBox(Math.min(x, ex) - 1, Math.min(z, ez) - 1, Math.max(x, ex) + 1, Math.max(z, ez) + 1, (o, seg) => {
    if (o === e || o.layer !== e.layer) return;
    const p = o.pl.pts;
    const ax = p[seg * 3];
    const az = p[seg * 3 + 2];
    const dx = p[seg * 3 + 3] - ax;
    const dz = p[seg * 3 + 5] - az;
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) return;
    // a road running the other way only (one-way, or with lanes in our opposite direction)
    const odir = o.lanesB === 0 ? 1 : o.lanesF === 0 ? -1 : 0;
    if (odir === 0) return;
    if (((dx * odir) / l) * tx + ((dz * odir) / l) * tz > -0.7) return;
    const den = nx * dz - nz * dx;
    if (Math.abs(den) < 1e-9) return;
    const t = ((ax - x) * dz - (az - z) * dx) / den;
    const u = ((ax - x) * nz - (az - z) * nx) / den;
    if (t <= 0.5 || t > reach || u < 0 || u > 1) return;
    if (t < best) {
      best = t;
      partner = o;
      bestSeg = seg;
    }
  });
  if (!partner) return null;
  const o = partner as Edge;
  const own = medianSide(e) > 0 ? e.swL : e.swR;
  const px = x + nx * best;
  const pz = z + nz * best;
  projectOnPolyline(o.pl, px, pz, proj, bestSeg, bestSeg);
  // which side of the other carriageway faces this one: the side our centreline lies on
  const theirs = medianSide(o) > 0 ? o.swL : o.swR;
  const g0 = e.width / 2 + own;
  const g1 = best - o.width / 2 - theirs;
  if (g1 - g0 < 0.8) return null;
  return { s, x, z, nx, nz, g0, g1, y0: world.edgeY(e, s, x, z) + (own > 0 ? KERB_H : 0), y1: world.edgeY(o, proj.s, px, pz) + (theirs > 0 ? KERB_H : 0), partner: o };
}

export interface MedianStats {
  km: number;
  cars: number;
  trees: number;
  hedgeKm: number;
  /** untagged narrow medians paved (the detail region) */
  pavedKm: number;
}

const HEDGE: [number, number, number] = [58, 84, 44];

/** the widest median (kerb to kerb, m) that is paved where nothing is tagged (the detail region): a narrow strip between two carriageways is pavers, not lawn */
export const NARROW_MEDIAN = 3.5;
/** how far from the node where two branches meet a narrow median is left to the split island there (mapgen/islands.ts) */
const ISLAND_REACH = 82;

/**
 * Fill the medians of every carriageway that says what is in it; and – for
 * the roads `fresh` says yes to (the detail region) – where neither
 * carriageway says anything, the stretches where they lie no more than
 * NARROW_MEDIAN apart with kerbed pavers (away from where they meet: the
 * split islands are there).
 */
export function addMedians(world: World, ts: TileSet, fresh?: (e: Edge) => boolean): MedianStats {
  const stats: MedianStats = { km: 0, cars: 0, trees: 0, hedgeKm: 0, pavedKm: 0 };
  for (const e of world.edges) {
    if (!e || (e.lanesF > 0 && e.lanesB > 0)) continue;
    const untagged = !e.median;
    if (untagged && !fresh?.(e)) continue;
    const s0 = e.cutA + 1;
    const s1 = e.len - e.cutB - 1;
    if (s1 - s0 < 4) continue;
    const n = Math.max(1, Math.ceil((s1 - s0) / 4));
    const cuts: Array<MedianCut | null> = [];
    for (let i = 0; i <= n; i++) {
      let c = lookAcross(world, e, s0 + ((s1 - s0) * i) / n);
      if (c && untagged && !narrowCut(e, c)) c = null;
      cuts.push(c);
    }
    // runs of stations with the other carriageway in sight
    let run: MedianCut[] = [];
    const flush = (): void => {
      if (run.length >= 2) {
        if (untagged) {
          fillRun(world, ts, e, run, stats, MEDIAN.PAVED);
          stats.pavedKm += (run[run.length - 1].s - run[0].s) / 1000;
        } else fillRun(world, ts, e, run, stats, e.median);
      }
      run = [];
    };
    for (const c of cuts) {
      if (c && run.length && (Math.abs(c.g1 - run[run.length - 1].g1) > 6 || c.partner !== run[run.length - 1].partner)) flush();
      if (c) run.push(c);
      else flush();
    }
    flush();
  }
  return stats;
}

/** Is a look across from an untagged carriageway a narrow median it paves: neither says anything, it has the smaller id, not near where they meet? */
function narrowCut(e: Edge, c: MedianCut): boolean {
  const o = c.partner;
  if (o.median || c.g1 - c.g0 > NARROW_MEDIAN) return false;
  if (o.osm < e.osm || (o.osm === e.osm && o.id < e.id)) return false;
  for (const [node, s] of [
    [e.a, c.s],
    [e.b, e.len - c.s],
  ] as const) {
    if (s < ISLAND_REACH && (o.a === node || o.b === node)) return false;
  }
  return true;
}

function fillRun(world: World, ts: TileSet, e: Edge, run: MedianCut[], stats: MedianStats, bits: number): void {
  // half of the gap if the other carriageway fills its own half too (an untagged narrow median: this one fills all of it)
  const shared = bits === e.median && run.every((c) => c.partner.median !== 0);
  const leads = !shared || run.every((c) => e.osm <= c.partner.osm);
  const at = (c: MedianCut, d: number, lift: number): [number, number, number] => {
    const g = (d - c.g0) / Math.max(0.01, c.g1 - c.g0);
    return [c.x + c.nx * d, c.y0 + (c.y1 - c.y0) * Math.max(0, Math.min(1, g)) + lift, c.z + c.nz * d];
  };
  const mid = (c: MedianCut): number => (c.g0 + c.g1) / 2;
  const far = (c: MedianCut): number => (shared ? mid(c) : c.g1);
  const line = (d: (c: MedianCut) => number, lift: number): number[] => run.flatMap((c) => at(c, d(c), lift));
  stats.km += (run[run.length - 1].s - run[0].s) / 1000;

  // the surface: grass (or paving where cars park), raised behind a kerb where the carriageway has no pavement there
  const own = medianSide(e) > 0 ? e.swL : e.swR;
  const parking = (bits & MEDIAN.PARKING) !== 0;
  const depthOf = (c: MedianCut): number => (c.g1 - c.g0 >= 5.6 ? 5.0 : c.g1 - c.g0 >= 2.4 ? 2.0 : 0);
  const kerbLift = own > 0 ? 0 : KERB_H;
  if (own <= 0) {
    addBand(ts, 'ground', line((c) => c.g0, 0), line((c) => c.g0, KERB_H), [GM.KERB], 0, 0, 0);
  }
  // (an untagged narrow median: the other carriageway's kerb too, where it has no pavement there)
  if (bits !== e.median && run.every((c) => (medianSide(c.partner) > 0 ? c.partner.swL : c.partner.swR) <= 0)) {
    addBand(ts, 'ground', line((c) => c.g1, kerbLift - KERB_H), line((c) => c.g1, kerbLift), [GM.KERB], 0, 0, 0);
  }
  // (paving_stones: a paved strip – with young trees when trees are said too)
  const paved = (bits & MEDIAN.PAVED) !== 0 && (bits & MEDIAN.GRASS) === 0;
  const ground = paved ? GM.PAVING : (bits & MEDIAN.GRASS) !== 0 || !parking ? GM.VERGE : GM.PAVING;
  if (parking) {
    // the paved strip in the middle, grass (or paving) either side of it
    const pin = (c: MedianCut): number => Math.max(c.g0, mid(c) - depthOf(c) / 2);
    const pout = (c: MedianCut): number => Math.min(far(c), mid(c) + depthOf(c) / 2);
    addBand(ts, 'ground', line((c) => c.g0, kerbLift), line(pin, kerbLift), [ground]);
    addBand(ts, 'ground', line(pin, kerbLift), line(pout, kerbLift), [GM.PAVING]);
    if (!shared) addBand(ts, 'ground', line(pout, kerbLift), line(far, kerbLift), [ground]);
  } else {
    addBand(ts, 'ground', line((c) => c.g0, kerbLift), line(far, kerbLift), [ground]);
  }
  if (!leads) return;

  // a hedge along the middle
  if (bits & MEDIAN.HEDGE) {
    const w = 0.45;
    const h = 1.2;
    const a = line((c) => mid(c) - w, kerbLift);
    const b = line((c) => mid(c) + w, kerbLift);
    const aTop = line((c) => mid(c) - w, kerbLift + h);
    const bTop = line((c) => mid(c) + w, kerbLift + h);
    addBand(ts, 'struct', aTop, bTop, HEDGE);
    addBand(ts, 'struct', a, aTop, HEDGE, 0, 0, 0);
    addBand(ts, 'struct', b, bTop, HEDGE, 0, 0, 0);
    for (let i = 0; i + 1 < run.length; i++) {
      const p = at(run[i], mid(run[i]), 0);
      const q = at(run[i + 1], mid(run[i + 1]), 0);
      ts.at(p[0], p[2]).collSeg.push(p[0], p[2], q[0], q[2], Math.min(p[1], q[1]) - 0.2);
      stats.hedgeKm += Math.hypot(q[0] - p[0], q[2] - p[2]) / 1000;
    }
    // the hedge's ends
    for (const k of [0, run.length - 1]) {
      const c = run[k];
      const p = [...at(c, mid(c) - w, kerbLift), ...at(c, mid(c) + w, kerbLift), ...at(c, mid(c) + w, kerbLift + h), ...at(c, mid(c) - w, kerbLift + h)];
      addQuad(ts, 'struct', p, HEDGE, 0, 0, 0);
    }
  }

  // trees along the middle, every 12 m (beside the hedge if there is one)
  if (bits & MEDIAN.TREES) {
    const shift = bits & MEDIAN.HEDGE ? 1.2 : 0;
    let next = run[0].s + 4;
    for (const c of run) {
      if (c.s < next) continue;
      if (c.g1 - c.g0 < 1.6 + shift) continue;
      const p = at(c, mid(c) + shift, 0);
      const h = paved ? 5 + 2 * mix01(e.osm, Math.round(c.s), 23) : 9 + 5 * mix01(e.osm, Math.round(c.s), 23);
      ts.at(p[0], p[2]).trees.push(p[0], p[1], p[2], h, 0);
      stats.trees++;
      next = c.s + (paved ? 10 : 12);
    }
  }

  // parked cars in a row along the middle
  if (parking) {
    const share = 0.6 + 0.2 * mix01(e.osm, 99, 17);
    let next = run[0].s + 3;
    let i = 0;
    for (const c of run) {
      i++;
      if (c.s < next) continue;
      const depth = depthOf(c);
      if (depth === 0) continue;
      const perpendicular = depth >= 5;
      next = c.s + (perpendicular ? 2.5 : 5.8);
      if (mix01(e.osm, 99, i, 3) >= share) continue;
      const r = mix01(e.osm, 99, i, 5);
      const model = r < 0.3 ? 0 : r < 0.62 ? 1 : r < 0.88 ? 2 : 3;
      if (perpendicular && PARKED_MODELS[model].len > depth + 0.3) continue;
      const p = at(c, mid(c), kerbLift);
      samplePolyline(e.pl, c.s, tmp);
      const dir = e.lanesF > 0 ? 1 : -1;
      const fx = perpendicular ? c.nx : tmp.tx * dir;
      const fz = perpendicular ? c.nz : tmp.tz * dir;
      const car: ParkedCar = { x: p[0], y: p[1], z: p[2], yaw: Math.atan2(-fx, -fz), model, colour: Math.floor(mix01(e.osm, 99, i, 7) * 12) };
      if (carMisplaced(world, e, car) || carOnPost(ts, car)) continue;
      const t = ts.at(car.x, car.z);
      t.parked.push(car);
      t.collSeg.push(...carWalls(car));
      stats.cars++;
    }
  }
}
