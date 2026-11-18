// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Arcade driving: the simulator's chores left out (a setting, off unless
 * chosen).
 *
 * A driving school wants the gear chosen, the handbrake set and released,
 * the engine started and not stalled.  In arcade driving none of that is
 * asked: the vehicle has the automatic gearbox, its engine runs (it starts
 * again by itself), and the two pedals are all there is –
 *
 *  - the right pedal drives the way the vehicle goes (D), the left one brakes;
 *  - standing, the left pedal held a moment puts it in reverse (R): then the
 *    left pedal drives backwards and the right one brakes – and, standing
 *    again, the right pedal held a moment puts it back into D;
 *  - standing with no pedal for going pressed, the vehicle stays where it is
 *    (as if the handbrake were set; on a hill too).
 *
 * The rules judge none of it (no handbrake left on, no stalling).  The other
 * half of the arcade options, the road physics switched off, is
 * WorldGround.even (sim/ground.ts): every surface grips as dry asphalt.
 */

import type { DriverInput } from '../sim/vehicle/types.ts';

/** slower than this (m/s) the vehicle counts as standing */
export const ARCADE_STILL = 0.4;
/** how long (s) the other pedal is held, standing, to change between D and R */
export const ARCADE_SWITCH = 0.35;
/** a pedal pressed at least this far counts */
const PRESSED = 0.05;

/** What arcade driving keeps from one step to the next: the way chosen, and how long the other pedal has been held. */
export class ArcadeDrive {
  /** 1: forwards (D), −1: backwards (R) */
  dir: 1 | -1 = 1;
  /** how long the other pedal has been held, standing */
  private held = 0;
  /** held where it stopped: until the pedal for going is pressed (whatever the vehicle does meanwhile – settling on its springs, on a hill) */
  private parked = false;

  /** A new drive (or a new vehicle): forwards. */
  reset(): void {
    this.dir = 1;
    this.held = 0;
    this.parked = false;
  }

  /**
   * The pedals as the player presses them (`throttle` the right, `brake` the
   * left one, 0 … 1), the vehicle's speed along its length (m/s, + forwards)
   * and the time step: what goes to the vehicle, written into `d` (an
   * automatic's selector: 1 D, −1 R).  `limit` caps the right pedal driving
   * forwards (the speed limiter's, the governor's – 1: none).
   */
  step(throttle: number, brake: number, speed: number, dt: number, d: DriverInput, limit = 1, engineRunning = true): void {
    const still = Math.abs(speed) < ARCADE_STILL;
    let go = this.dir > 0 ? throttle : brake;
    let back = this.dir > 0 ? brake : throttle;
    if (still && back > 0.3 && go < PRESSED) {
      this.held += dt;
      if (this.held >= ARCADE_SWITCH) {
        this.dir = this.dir > 0 ? -1 : 1;
        this.held = 0;
        const t = go;
        go = back;
        back = t;
      }
    } else this.held = 0;
    d.throttle = this.dir > 0 ? Math.min(go, limit) : go;
    d.brake = back;
    d.gear = this.dir;
    d.clutch = 0;
    d.ignition = true;
    d.starter = !engineRunning;
    // standing and not asked to go: it stays where it is (the brakes and the parking brake – on a hill too)
    if (go >= PRESSED) this.parked = false;
    else if (still) this.parked = true;
    d.handbrake = this.parked ? 1 : 0;
    if (this.parked) d.brake = 1;
  }
}

/** The gearbox a drive is to have: arcade driving always has the automatic one. */
export function arcadeTransmission<T extends string>(arcade: boolean, chosen: T): T | 'automatic' {
  return arcade ? 'automatic' : chosen;
}
