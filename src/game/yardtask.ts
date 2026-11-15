// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A task of the truck lessons, run with the real vehicles: it judges a
 * reversing manoeuvre from where truck and trailer stand, or runs the
 * coupling procedure and does to the two what coupling does – the trailer
 * stays behind, is taken up again, and its drawbar stops a truck that
 * backs up beside the eye or too far.
 *
 * What is shown and said about it is the game's business (game.ts); the
 * rules of the tasks are in ce.ts.
 */
import type { Trailer } from '../sim/trailer.ts';
import type { Vehicle } from '../sim/vehicle/index.ts';
import { CouplingProcedure, ManoeuvreJudge, TRUCK_OUTLINE, taskLayout } from './ce.ts';
import type { CouplingState, CouplingStatus, ManoeuvreStatus, TaskId, TaskLayout, YardFrame } from './ce.ts';

/** how far past the coupling the drawbar eye can get before the truck's rear end stands against the drawbar (m) */
const PAST_THE_EYE = 0.22;
/** backing into the trailer faster than this is a fault (m/s) */
export const BUMP_SPEED = 0.9;

export class YardTask {
  readonly id: TaskId;
  readonly layout: TaskLayout;
  /** the judge of a reversing manoeuvre, or null for coupling */
  readonly judge: ManoeuvreJudge | null;
  /** the coupling procedure, or null for a manoeuvre */
  readonly coupling: CouplingProcedure | null;
  /** what the coupling procedure was told in the last step (also what a thing done on foot is judged by) */
  readonly state: CouplingState = { speed: 0, handbrake: true, coupled: true, dist: 0, angle: 0 };
  /** the truck ran into the standing trailer in the last step, faster than a crawl */
  bumped = false;
  private readonly mpos = new Float64Array(3);

  constructor(id: TaskId) {
    this.id = id;
    this.layout = taskLayout(id);
    this.judge = id === 'couple' ? null : new ManoeuvreJudge(id);
    this.coupling = id === 'couple' ? new CouplingProcedure() : null;
  }

  /** One step of a reversing manoeuvre on the yard `frame`. */
  manoeuvre(dt: number, frame: YardFrame, truck: Vehicle, trailer: Trailer, handbrake: boolean): ManoeuvreStatus {
    truck.getModelPosition(this.mpos);
    return this.judge!.update(
      {
        truck: frame.poseToLocal({ x: this.mpos[0], z: this.mpos[2], yaw: truck.yaw }),
        trailer: frame.poseToLocal({ x: trailer.x, z: trailer.z, yaw: trailer.yaw }),
        speed: truck.speed,
        handbrake,
      },
      dt,
    );
  }

  /** One step of uncoupling and coupling: moves on in the procedure and couples or uncouples the trailer. */
  couple(dt: number, truck: Vehicle, trailer: Trailer, handbrake: boolean): CouplingStatus {
    this.bumped = false;
    if (!trailer.coupled) {
      // The trailer stands alone.  Its drawbar eye goes into the coupling and no further: backed up
      // beside it, or past it, the truck's rear cross-member stops at the drawbar.
      truck.getModelPosition(this.mpos);
      const dx = trailer.hitchX - this.mpos[0];
      const dz = trailer.hitchZ - this.mpos[2];
      const sin = Math.sin(truck.yaw);
      const cos = Math.cos(truck.yaw);
      const behind = dx * sin + dz * cos;
      const side = dx * cos - dz * sin;
      const over = TRUCK_OUTLINE.hitch - PAST_THE_EYE - behind;
      if (over > 0 && behind > -2 && Math.abs(side) < TRUCK_OUTLINE.hw) {
        if (truck.speed < -BUMP_SPEED) this.bumped = true;
        const push = Math.min(over, 0.3);
        truck.translate(-sin * push, 0, -cos * push);
        if (truck.speed < 0) {
          truck.vel[0] = 0;
          truck.vel[2] = 0;
        }
      }
    }
    const off = trailer.offsetFrom(truck);
    const s = this.state;
    s.speed = truck.speed;
    s.handbrake = handbrake;
    s.coupled = trailer.coupled;
    s.dist = trailer.coupled ? 0 : off.dist;
    s.angle = off.angle;
    const st = this.coupling!.update(s, dt);
    if (st.uncouple) trailer.uncouple();
    if (st.couple) trailer.couple();
    return st;
  }
}
