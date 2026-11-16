// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Nothing of the scenery may stand in a lane.
 *
 * The map is put together from sources that do not know of each other: a
 * guard rail of one carriageway can end up in the lane of the one beside it,
 * a sign post on a traffic island the road model has no room for, the corner
 * of a house in a street that is narrower than its lanes.  A human driver
 * steers round such a thing or is stuck in front of it; the demonstration
 * driver is stuck.  So whatever comes closer to the middle of a lane than a
 * vehicle is wide is taken out of the way here: posts are moved beside the
 * lanes (or dropped), walls and footprints lose the pieces that reach in.
 *
 * The map build does this for the scenery it draws (and marks the tile);
 * the game repeats it for the collision shapes of tiles that are not marked.
 */
import type { LaneGraph, PathFoot } from '../world/lanes.ts';
import type { SignPost, TileObject } from '../world/tilefmt.ts';

/** how far a post (sign, lamp, trunk) keeps from the middle of a lane */
export const POST_CLEAR = 1.5;
/** how far walls, guard rails and buildings keep from it: the half width of the truck and a little */
export const WALL_CLEAR = 1.3;

const foot: PathFoot = { x: 0, z: 0, d: 0 };

/** Move the sign posts that stand in a lane beside it; those there is no place for are dropped. Returns how many were moved and dropped. */
export function clearSigns(lanes: LaneGraph, signs: SignPost[]): [number, number] {
  let moved = 0;
  let dropped = 0;
  for (let i = signs.length - 1; i >= 0; i--) {
    const s = signs[i];
    const at = lanes.besideLanes(s.x, s.z, s.y, POST_CLEAR, foot);
    if (!at) {
      signs.splice(i, 1);
      dropped++;
    } else if (at.d > 0) {
      s.x = Math.round(at.x * 100) / 100;
      s.z = Math.round(at.z * 100) / 100;
      moved++;
    }
  }
  return [moved, dropped];
}

/** Drop the lamps that stand in a lane.  Returns how many. */
export function clearObjects(lanes: LaneGraph, objects: TileObject[]): number {
  let dropped = 0;
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.k !== 'lamp') continue;
    if (lanes.nearestPath(o.x, o.z, o.y, POST_CLEAR, foot) < POST_CLEAR) {
      objects.splice(i, 1);
      dropped++;
    }
  }
  return dropped;
}

/** Is a post at this place in a lane? */
export function postInLane(lanes: LaneGraph, x: number, y: number, z: number): boolean {
  return lanes.nearestPath(x, z, y, POST_CLEAR, foot) < POST_CLEAR;
}

/**
 * The walls of a tile as the collision test wants them (x1, z1, x2, z2, y per
 * piece; y = NaN: at any height), without the pieces that reach into a lane:
 * the footprints of the buildings (rings) and the free-standing walls.
 */
export function clearWalls(lanes: LaneGraph, rings: Float32Array | null, ringCounts: Uint16Array | null, segments: Float32Array | null): Float32Array {
  const out: number[] = [];
  if (rings && ringCounts) {
    let o = 0;
    for (const n of ringCounts) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x1 = rings[o + i * 2];
        const z1 = rings[o + i * 2 + 1];
        const x2 = rings[o + j * 2];
        const z2 = rings[o + j * 2 + 1];
        if (!lanes.wallInLane(x1, z1, x2, z2, NaN, WALL_CLEAR)) out.push(x1, z1, x2, z2, NaN);
      }
      o += n * 2;
    }
  }
  if (segments) {
    for (let i = 0; i + 4 < segments.length; i += 5) {
      if (!lanes.wallInLane(segments[i], segments[i + 1], segments[i + 2], segments[i + 3], segments[i + 4], WALL_CLEAR)) {
        out.push(segments[i], segments[i + 1], segments[i + 2], segments[i + 3], segments[i + 4]);
      }
    }
  }
  return Float32Array.from(out);
}

/**
 * The sides of the footprints that would stand in a lane: one bit per side,
 * in the order of the rings (for tiles that keep their footprints whole and
 * carry this beside them).  Null when none does.
 */
export function ringSidesInLanes(lanes: LaneGraph, rings: ArrayLike<number>, ringCounts: ArrayLike<number>): Uint8Array | null {
  const bits = new Uint8Array(Math.ceil(rings.length / 2 / 8));
  let any = false;
  let o = 0;
  for (let r = 0; r < ringCounts.length; r++) {
    const n = ringCounts[r];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (lanes.wallInLane(rings[o + i * 2], rings[o + i * 2 + 1], rings[o + j * 2], rings[o + j * 2 + 1], NaN, WALL_CLEAR)) {
        const side = o / 2 + i;
        bits[side >> 3] |= 1 << (side & 7);
        any = true;
      }
    }
    o += n * 2;
  }
  return any ? bits : null;
}
