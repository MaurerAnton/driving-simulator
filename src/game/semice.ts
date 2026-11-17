// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Class CE with the articulated lorry: the same three tasks as with the
 * drawbar combination (game/ce.ts) – coupling and uncoupling, reversing round
 * a corner, reversing to the ramp – done with a tractor unit and its
 * semi-trailer (sim/semitrailer.ts).
 *
 * The coupling procedure has the same steps in the same order – only some of
 * them are done differently, and are said differently:
 *
 *   uncoupling ("Absatteln"): stand straight, handbrake; set the trailer's
 *   parking brake, chocks; wind the landing gear down; red line, yellow
 *   line, cables off; pull the fifth wheel's release handle; drive slowly
 *   out from under the trailer – it stays on its legs.
 *
 *   coupling ("Aufsatteln"): look at the trailer (secured, kingpin, the fifth
 *   wheel open); reverse in line until the fifth wheel stands just before the
 *   trailer's front, stop; compare the heights (the trailer's plate a little
 *   below the fifth wheel); reverse at a crawl under it until the jaws close
 *   round the kingpin; check the lock; yellow, red, cables on; wind the
 *   landing gear up; chocks away, the trailer's parking brake off; lights;
 *   brake test.
 *
 * What the steps do to the trailer (its brake, its lines, its legs) is set
 * here from the procedure, and the tractor is stopped where it stands
 * against the trailer.
 */
import { trailerOutline } from '../sim/trailer.ts';
import type { Trailer } from '../sim/trailer.ts';
import type { Vehicle } from '../sim/vehicle/index.ts';
import { FIFTH_WHEEL_AT, SEMI_TRAILER, SemiTrailer, TRACTOR_OUTLINE, TRACTOR_UNIT } from '../sim/semitrailer.ts';
import type { CouplingProcedure, RigShape } from './ce.ts';

const TRAILER = trailerOutline(SEMI_TRAILER);

/** What the judge of the reversing tasks needs of the articulated lorry. */
export const SEMI_RIG: RigShape = {
  truck: TRACTOR_OUTLINE,
  trailer: TRAILER,
  truckAxles: { at: [TRACTOR_UNIT.wheelbase / 2, -TRACTOR_UNIT.wheelbase / 2], hw: TRACTOR_OUTLINE.hw },
  trailerAxles: { at: [SEMI_TRAILER.axleSpread, 0, -SEMI_TRAILER.axleSpread], hw: SEMI_TRAILER.width / 2 },
};

/**
 * Where to stop before going under the trailer: the fifth wheel this far
 * from the kingpin – just before its ramps touch the trailer's front edge
 * (1.6 m ahead of the kingpin, the fifth wheel's half-width more).
 */
export const SEMI_APPROACH: readonly [number, number] = [2.3, 4.0];

/** how far the fifth wheel can go past the kingpin before the jaws stop it (m) */
const PAST_THE_KINGPIN = 0.1;
/** the kingpin finds the jaws within this much to the side (the fifth wheel's guide funnels it in) */
const JAWS = 0.3;
/** backing into the trailer faster than this is a fault (m/s) */
const BUMP_SPEED = 0.9;

/** Is the steps' text of the articulated lorry its own (else the drawbar combination's serves)? */
const OWN_TEXT = new Set(['do.uPull', 'do.cApproach', 'do.cLatch', 'step.uLeg', 'step.uOpen', 'step.cCheck', 'step.cHeight', 'step.cLocked', 'step.cLeg']);

/** The i18n key of what to do now ('do') or of a thing to do on foot ('step'): "semi.…" where the articulated lorry has its own, else "ce.…". */
export function taskTextKey(semi: boolean, what: 'do' | 'step', id: string): string {
  const k = `${what}.${id}`;
  return semi && OWN_TEXT.has(k) ? `semi.${k}` : `ce.${k}`;
}

/**
 * The tractor backing up to a semi-trailer that stands alone: the kingpin
 * goes into the fifth wheel's jaws and no further; a tractor that comes in
 * beside the kingpin goes on under the trailer until its cab stands against
 * the trailer's front.  Pushes the tractor back out to where it stops and
 * returns whether it ran in faster than a crawl.  `mpos`: scratch for the
 * tractor's model origin.
 */
export function semiStop(truck: Vehicle, trailer: Trailer, mpos: Float64Array): boolean {
  truck.getModelPosition(mpos);
  const dx = trailer.hitchX - mpos[0];
  const dz = trailer.hitchZ - mpos[2];
  const sin = Math.sin(truck.yaw);
  const cos = Math.cos(truck.yaw);
  // the kingpin: how far behind the tractor's origin, and to its right
  const behind = dx * sin + dz * cos;
  const side = dx * cos - dz * sin;
  let a = truck.yaw - trailer.yaw;
  a -= Math.PI * 2 * Math.round(a / (Math.PI * 2));
  let over = 0;
  if (Math.abs(side) < JAWS && Math.abs(a) < 0.3 && behind > FIFTH_WHEEL_AT - 1.5) {
    over = FIFTH_WHEEL_AT - PAST_THE_KINGPIN - behind;
  } else if (Math.abs(side) < SEMI_TRAILER.width && behind > -3) {
    // the trailer's front wall – -bodyFront ahead of the kingpin – against the back of the cab
    over = -TRACTOR_OUTLINE.cabBack + 0.08 - SEMI_TRAILER.bodyFront * Math.cos(a) - behind;
  }
  if (over <= 0) return false;
  const bumped = truck.speed < -BUMP_SPEED;
  const push = Math.min(over, 0.3);
  truck.translate(-sin * push, 0, -cos * push);
  if (truck.speed < 0) {
    truck.vel[0] = 0;
    truck.vel[2] = 0;
  }
  return bumped;
}

/** What the steps done so far have done to the semi-trailer: its brake, its lines, its landing gear. */
export function syncSemi(trailer: Trailer, proc: CouplingProcedure): void {
  if (!(trailer instanceof SemiTrailer)) return;
  const d = proc.done;
  const between = (off: 'uBrake' | 'uLeg' | 'uRed' | 'uYellow' | 'uCable', on: 'cBrake' | 'cLeg' | 'cRed' | 'cYellow' | 'cCable'): boolean => d.has(off) && !d.has(on);
  trailer.parkBrake = between('uBrake', 'cBrake');
  trailer.legsDown = between('uLeg', 'cLeg');
  trailer.supply = !between('uRed', 'cRed');
  trailer.control = !between('uYellow', 'cYellow');
  trailer.cables = !between('uCable', 'cCable');
}
