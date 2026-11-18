// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Kerb build-outs that narrow a road (OpenStreetMap traffic_calming=choker |
 * chicane on a node of the road): where they stand, how deep they reach in
 * and what they leave free of the carriageway.
 *
 * The map build reads them from the nodes (`buildOutEntries`) and stores them
 * with each road as EdgeJson.bo; it draws the kerbed, planted beds from them
 * (tools/mapgen/streetpaint.ts), and the game finds the same beds again with
 * `narrowingsOf` – the traffic and the autopilot drive through the gap they
 * leave, the player's car runs into their kerbs (src/sim/narrowings.ts).
 *
 * On a narrow two-way street without lane markings a build-out leaves one
 * lane (BUILD_OUT_PASS metres): the traffic of one direction waits for the
 * other – whoever has the build-out on their side lets the oncoming traffic
 * through first (§ 6 StVO).  On a road with painted lanes it keeps clear of
 * the lanes.
 */
import { EF } from './types.ts';

/** How deep a build-out reaches in from the kerb when nothing says (m). */
export const BUILD_OUT_DEPTH = 1.6;
/** What a build-out leaves of a narrow unmarked two-way street: one lane to pass at a time (m). */
export const BUILD_OUT_PASS = 3.2;
/** numbers per entry of EdgeJson.bo: station of the middle, side (+1 left of a→b, −1 right), length, depth wanted (0: as the road allows), BO flags */
export const BO_STRIDE = 5;
/** flags of an entry of EdgeJson.bo */
export const BO = {
  /** one of a pair (a choker on both sides): the free width is shared, neither side goes first */
  PAIRED: 1,
  /** a red-white beacon post on its nose */
  BEACON: 2,
  /** not planted */
  BARE: 4,
  /** no tree in it */
  NO_TREE: 8,
} as const;
/** below this free width (m) only one vehicle passes at a time */
export const SINGLE_LANE = 5.2;

/** What `buildOutEntries` needs of a node on a road (tools/mapgen/roads.ts EdgeFeature). */
export interface BuildOutFeature {
  kind: string;
  s: number;
  tags: Readonly<Record<string, string | undefined>>;
}

/** The build-outs of a road's nodes as EdgeJson.bo entries (stride BO_STRIDE). */
export function buildOutEntries(feats: readonly BuildOutFeature[]): number[] {
  const out: number[] = [];
  for (const f of feats) {
    if (f.kind !== 'bump') continue;
    const tc = f.tags.traffic_calming;
    if (tc !== 'choker' && tc !== 'chicane') continue;
    let len = Number.parseFloat(f.tags.length ?? '');
    if (!(len >= 1.5 && len <= 20)) len = 5;
    const sideTag = f.tags.side ?? f.tags['traffic_calming:side'];
    const sides: Array<[1 | -1, number]> =
      sideTag === 'left'
        ? [[1, f.s]]
        : sideTag === 'right'
          ? [[-1, f.s]]
          : tc === 'chicane'
            ? [
                [-1, f.s - len * 0.8],
                [1, f.s + len * 0.8],
              ]
            : [
                [-1, f.s],
                [1, f.s],
              ];
    const want = Number.parseFloat(f.tags['traffic_calming:depth'] ?? '');
    let flags = tc === 'choker' && sides.length > 1 ? BO.PAIRED : 0;
    if (f.tags.beacon === 'yes' || f.tags['traffic_calming:beacon'] === 'yes') flags |= BO.BEACON;
    if (f.tags.planted === 'no') flags |= BO.BARE;
    if (f.tags.tree === 'no') flags |= BO.NO_TREE;
    for (const [side, at] of sides) out.push(Math.round(at * 100) / 100, side, len, want > 0 ? Math.round(want * 100) / 100 : 0, flags);
  }
  return out;
}

/** What the geometry needs of a road (src/world/world.ts Edge). */
export interface NarrowRoad {
  width: number;
  marginL: number;
  marginR: number;
  laneW: number;
  lanesF: number;
  lanesB: number;
  flags: number;
  len: number;
  cutA: number;
  cutB: number;
}

/**
 * How deep a build-out may reach in from the kerb (m).  On a road with
 * painted lanes it stays 1.1 m clear of the middle of the outer lane (as
 * traffic islands do).  A narrow street without lane markings is one where
 * a build-out narrows the carriageway to a single lane – the traffic of one
 * direction waits for the other: there it leaves BUILD_OUT_PASS metres free,
 * shared by the build-outs on both sides (`both`: there is one opposite at
 * the same place).  `side` +1: left of a→b, −1: right.
 */
export function buildOutRoom(e: NarrowRoad, side: 1 | -1, both: boolean): number {
  const marked = (e.flags & EF.MARKED) !== 0;
  if (marked || e.lanesF === 0 || e.lanesB === 0 || e.lanesF + e.lanesB > 2) return (side > 0 ? e.marginL : e.marginR) + e.laneW / 2 - 1.1;
  return Math.max(0, (e.width - BUILD_OUT_PASS) / (both ? 2 : 1));
}

/** One build-out as it stands on its road. */
export interface Narrowing {
  /** the stretch of road it takes (stations from a, s0 < s1) */
  s0: number;
  s1: number;
  /** where it was mapped (station) */
  at: number;
  /** +1 on the left of a→b, −1 on the right */
  side: 1 | -1;
  /** how far it reaches in from the edge of the carriageway (m) */
  depth: number;
  /** the gap it leaves – with any build-out opposite – from `lo` to `hi` (m from the centreline, + left of a→b) */
  lo: number;
  hi: number;
  /** only one vehicle passes at a time */
  single: boolean;
  /** BO flags */
  flags: number;
}

/** The build-outs of a road from its EdgeJson.bo entries (those with no room left out), with the gap each leaves. */
export function narrowingsOf(e: NarrowRoad, bo: readonly number[] | null | undefined): Narrowing[] {
  const out: Narrowing[] = [];
  if (!bo) return out;
  const half = e.width / 2;
  const lo = e.cutA + 1;
  const hi = e.len - e.cutB - 1;
  for (let i = 0; i + BO_STRIDE <= bo.length; i += BO_STRIDE) {
    const at = bo[i];
    const side: 1 | -1 = bo[i + 1] > 0 ? 1 : -1;
    const len = bo[i + 2];
    const want = bo[i + 3];
    const flags = bo[i + 4];
    const lanesHere = side > 0 ? (e.lanesB > 0 ? e.lanesB : e.lanesF) : e.lanesF > 0 ? e.lanesF : e.lanesB;
    if (lanesHere === 0) continue;
    const room = buildOutRoom(e, side, (flags & BO.PAIRED) !== 0);
    const depth = want > 0 ? Math.min(want, room) : Math.min(BUILD_OUT_DEPTH, room);
    if (depth < 0.4) continue;
    const s0 = Math.max(lo, at - len / 2);
    const s1 = Math.min(hi, at + len / 2);
    if (s1 - s0 < 1.2) continue;
    out.push({
      s0,
      s1,
      at,
      side,
      depth,
      lo: -half,
      hi: half,
      single: false,
      flags,
    });
  }
  // the gap: what this one and those opposite it leave
  for (const n of out) {
    for (const m of out) {
      if (m.s0 >= n.s1 || n.s0 >= m.s1) continue;
      if (m.side > 0) n.hi = Math.min(n.hi, half - m.depth);
      else n.lo = Math.max(n.lo, -half + m.depth);
    }
    n.single = n.hi - n.lo < SINGLE_LANE;
  }
  return out;
}
