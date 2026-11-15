// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The coupling lesson with the real truck and trailer (their dynamics, on
 * level ground): uncoupled, driven away, backed up to the trailer in two
 * steps, coupled, brake test – as the game runs it through YardTask.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CouplingStepId } from '../../src/game/ce.ts';
import { BUMP_SPEED, YardTask } from '../../src/game/yardtask.ts';
import { TANDEM_TRAILER, Trailer } from '../../src/sim/trailer.ts';
import { TRUCK } from '../../src/sim/vehicle/index.ts';
import type { DriverInput, Vehicle } from '../../src/sim/vehicle/index.ts';
import { DT, PlaneGround, input, makeCar } from '../vehicle/harness.ts';

interface Rig {
  truck: Vehicle;
  trailer: Trailer;
  task: YardTask;
  faults: string[];
}

function rig(): Rig {
  const ground = new PlaneGround();
  const truck = makeCar(ground, TRUCK);
  const trailer = new Trailer(TANDEM_TRAILER, ground);
  trailer.coupleBehind(truck);
  return { truck, trailer, task: new YardTask('couple'), faults: [] };
}

/** Drive for at most `seconds`, until `done` says so. */
function drive(r: Rig, seconds: number, d: () => DriverInput, done: () => boolean = () => false): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const inp = d();
    r.truck.step(DT, inp);
    r.trailer.step(DT, r.truck, inp);
    const st = r.task.couple(DT, r.truck, r.trailer, inp.handbrake > 0.5);
    r.faults.push(...st.faults);
    if (r.task.bumped) r.faults.push('ceFast');
    if (done()) return;
  }
}

const park = (r: Rig): void => drive(r, 6, () => input({ gear: 0, brake: Math.abs(r.truck.speed) > 0.05 ? 0.6 : 0, handbrake: Math.abs(r.truck.speed) > 0.05 ? 0 : 1 }), () => Math.abs(r.truck.speed) < 0.02 && r.task.state.handbrake);

function onFoot(r: Rig, ...ids: CouplingStepId[]): void {
  const proc = r.task.coupling!;
  for (const id of ids) {
    assert.ok(proc.onFoot(r.task.state), `${id}: standing with the handbrake on`);
    assert.ok(proc.choices().includes(id), `${id} is offered (offered: ${proc.choices().join(' ')})`);
    const fault = proc.act(id, r.task.state);
    assert.equal(fault, null, `${id}: ${fault}`);
  }
}

const gap = (r: Rig): number => r.trailer.offsetFrom(r.truck).dist;

test('the coupling lesson can be driven: uncouple, pull away, back up in two steps, couple, brake test', () => {
  const r = rig();
  park(r);
  onFoot(r, 'uBrake', 'uChocks', 'uLeg', 'uRed', 'uYellow', 'uCable', 'uOpen');
  // pull forward: the trailer stays where it is
  const trailerAt = [r.trailer.x, r.trailer.z];
  drive(r, 20, () => input({ gear: 1, throttle: 0.25 }), () => !r.trailer.coupled && gap(r) > 4);
  assert.equal(r.trailer.coupled, false, 'uncoupled');
  park(r);
  assert.ok(Math.hypot(r.trailer.x - trailerAt[0], r.trailer.z - trailerAt[1]) < 0.02, 'the trailer has not moved');
  assert.ok(gap(r) > 3.5, `pulled away: ${gap(r).toFixed(2)} m`);
  onFoot(r, 'cCheck');
  // back to about a metre before the eye – at walking pace, with the brake against the creep
  drive(r, 40, () => input({ gear: -1, brake: r.truck.speed < -0.6 ? 0.25 : 0 }), () => gap(r) < 1.1);
  park(r);
  assert.ok(gap(r) > 0.3 && gap(r) < 1.5, `stopped a metre before the eye: ${gap(r).toFixed(2)} m`);
  assert.equal(r.trailer.coupled, false, 'not coupled yet');
  onFoot(r, 'cHeight');
  // the last metre at a crawl
  drive(r, 40, () => input({ gear: -1, brake: r.truck.speed < -0.3 ? 0.3 : 0 }), () => r.trailer.coupled);
  assert.equal(r.trailer.coupled, true, 'the coupling has taken the eye');
  park(r);
  onFoot(r, 'cLocked', 'cYellow', 'cRed', 'cCable', 'cLights', 'cLeg', 'cChocks', 'cBrake');
  // brake test, with the trailer on the hook again
  drive(r, 20, () => input({ gear: 1, throttle: 0.5 }), () => r.truck.speed > 2.2);
  drive(r, 10, () => input({ gear: 1, brake: 0.6 }), () => r.task.coupling!.status.state === 'done');
  assert.deepEqual(r.faults, [], 'no fault on the way');
  assert.equal(r.task.coupling!.status.state, 'done');
  assert.ok(Math.abs(r.trailer.articulation) < 0.1, 'the trailer hangs in line');
});

test('backing into the standing trailer beside its eye: the truck is stopped at the drawbar, fast is a fault', () => {
  const r = rig();
  park(r);
  onFoot(r, 'uBrake', 'uChocks', 'uLeg', 'uRed', 'uYellow', 'uCable', 'uOpen');
  drive(r, 20, () => input({ gear: 1, throttle: 0.25 }), () => !r.trailer.coupled && gap(r) > 5);
  park(r);
  onFoot(r, 'cCheck');
  // the trailer stands 40 cm to the side of where the truck will come back to
  r.trailer.place(r.trailer.x + 0.4 * Math.cos(r.trailer.yaw), r.trailer.z - 0.4 * Math.sin(r.trailer.yaw), r.trailer.yaw);
  let fastest = 0;
  drive(r, 20, () => {
    fastest = Math.min(fastest, r.truck.speed);
    return input({ gear: -1, throttle: 0.6 });
  });
  assert.ok(fastest < -BUMP_SPEED, `it came fast (${fastest.toFixed(2)} m/s)`);
  assert.equal(r.trailer.coupled, false, 'the eye was missed: not coupled');
  assert.ok(r.faults.includes('ceFast'), `bumping into the trailer is a fault (${r.faults.join(' ') || 'none'})`);
  // … and the truck has not driven through the trailer: its coupling is still about at the eye
  assert.ok(gap(r) < 1, `stopped at the drawbar: ${gap(r).toFixed(2)} m past or beside the eye`);
});
