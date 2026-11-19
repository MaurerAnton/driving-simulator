// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Turning a vehicle round (game.ts turnAround, input action 'turn'): into the
 * lane of the other direction on a two-way road, or where it stands on a
 * one-way street.  The choice is made here, away from the game, so that it
 * can be tested (tests/game/turnaround.test.ts).
 */

/** Where a vehicle stands or is put: a place on the ground, facing `yaw` (rad). */
export interface TurnSpot {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** How far from where the vehicle stands the lane of the other direction may lie (m). */
const REACH = 10;
/** The lane must face the other way: the angle between the two ways over 120° (cos below −0.5). */
const OPPOSITE = -0.5;

/**
 * Where the turn-round puts the vehicle: `here` where it stands, `found` the
 * lane found the other way round (freeSpot with yaw + π), or null.
 *
 * The lane is taken when it lies close by and faces the other way – the lane
 * of the other direction on a two-way road.  Otherwise the vehicle turns
 * where it stands, facing the other way: a one-way street, no lane there, or
 * one that is not really the other direction (a lane beside it, one that runs
 * on past it, a road nearby that goes the same way).
 */
export function turnedSpot(here: TurnSpot, found: TurnSpot | null): TurnSpot {
  const inPlace: TurnSpot = { x: here.x, y: here.y, z: here.z, yaw: here.yaw + Math.PI };
  if (!found) return inPlace;
  if (Math.hypot(found.x - here.x, found.z - here.z) > REACH) return inPlace;
  if (Math.cos(found.yaw - here.yaw) > OPPOSITE) return inPlace;
  return found;
}
