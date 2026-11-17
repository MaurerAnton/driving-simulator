// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The articulated lorry (sim/semitrailer.ts, game/semice.ts): where the
 * kingpin sits, how the semi-trailer follows (its swept path, no jack-knife
 * on a gentle turn, the jack-knife limit), its weight on the tractor – and
 * the coupling lesson driven through with the real tractor and trailer.
 *
 *   node --test tests/sim/semitrailer.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CouplingStepId } from '../../src/game/ce.ts';
import { YardTask } from '../../src/game/yardtask.ts';
import { SEMI_RIG, taskTextKey } from '../../src/game/semice.ts';
import { VEHICLES } from '../../src/game/vehicles.ts';
import { FIFTH_WHEEL_AT, JACKKNIFE_LIMIT, SEMI_TRAILER, SemiTrailer, TRACTOR_UNIT, isSemiSpec, makeTrailer, steadyAxleRadius } from '../../src/sim/semitrailer.ts';
import { TANDEM_TRAILER, Trailer, trailerOutline } from '../../src/sim/trailer.ts';
import { TRUCK } from '../../src/sim/vehicle/index.ts';
import type { DriverInput, Vehicle } from '../../src/sim/vehicle/index.ts';
import { DT, PlaneGround, input, makeCar } from '../vehicle/harness.ts';

const wrap = (a: number): number => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

/**
 * A towing vehicle moved by hand along a path (no physics): what the trailer
 * asks of it – its pose, its body points, impulses (counted).
 */
class Puppet {
  readonly spec: { wheelbase: number };
  readonly modelOrigin = new Float64Array([0, 0, 0]);
  x = 0;
  z = 0;
  yaw = 0;
  speed = 0;
  liftImpulse = 0;
  constructor(wheelbase: number) {
    this.spec = { wheelbase };
  }
  toWorld(bx: number, by: number, bz: number, out: number[]): void {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    out[0] = this.x + c * bx + s * bz;
    out[1] = by;
    out[2] = this.z - s * bx + c * bz;
  }
  applyImpulse(_px: number, _py: number, _pz: number, _jx: number, jy: number): void {
    this.liftImpulse += jy;
  }
  /** the rear axle's middle (on the ground) */
  rearAxle(): [number, number] {
    const p = [0, 0, 0];
    this.toWorld(0, 0, this.spec.wheelbase / 2, p);
    return [p[0], p[2]];
  }
}

/** Drive the puppet's rear axle round a circle of radius R to the left at speed v (negative: reversing) for `seconds`. */
function circle(p: Puppet, t: Trailer, R: number, v: number, seconds: number, each?: () => void): void {
  const inp = input();
  const half = p.spec.wheelbase / 2;
  // (the centre lies R to the left of the rear axle; the axle goes round it as the heading turns)
  const [rx, rz] = p.rearAxle();
  const cx = rx - R * Math.cos(p.yaw);
  const cz = rz + R * Math.sin(p.yaw);
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    p.yaw += (v / R) * DT;
    const ax = cx + R * Math.cos(p.yaw);
    const az = cz - R * Math.sin(p.yaw);
    // the model origin is half the wheelbase ahead of the rear axle
    p.x = ax - Math.sin(p.yaw) * half;
    p.z = az - Math.cos(p.yaw) * half;
    p.speed = v;
    t.step(DT, p as unknown as Vehicle, inp);
    each?.();
  }
}

test('the kingpin stands over the tractor’s rear axle, the trailer’s axles 7.75 m behind it; 16.5 m in all', () => {
  assert.ok(isSemiSpec(SEMI_TRAILER) && !isSemiSpec(TANDEM_TRAILER));
  assert.ok(makeTrailer(SEMI_TRAILER, new PlaneGround()) instanceof SemiTrailer);
  assert.ok(!(makeTrailer(TANDEM_TRAILER, new PlaneGround()) instanceof SemiTrailer));
  const ground = new PlaneGround();
  const tractor = makeCar(ground, TRACTOR_UNIT);
  const t = new SemiTrailer(SEMI_TRAILER, ground);
  t.coupleBehind(tractor);
  const hit = [0, 0, 0];
  t.hitchPoint(tractor, hit);
  const mpos = [0, 0, 0];
  tractor.getModelPosition(mpos);
  // (facing north: behind is +z)
  const behind = hit[2] - mpos[2];
  assert.ok(Math.abs(behind - FIFTH_WHEEL_AT) < 1e-6, `kingpin ${behind.toFixed(2)} m behind the origin`);
  assert.ok(behind < TRACTOR_UNIT.wheelbase / 2 && behind > TRACTOR_UNIT.wheelbase / 2 - 0.6, 'just ahead of the rear axle');
  assert.ok(Math.abs(hit[1] - mpos[1] - 1.15) < 0.01, 'at the fifth wheel’s height');
  assert.ok(Math.abs(t.z - hit[2] - SEMI_TRAILER.hitchToAxle) < 1e-6, 'the axle group in line behind');
  const o = trailerOutline(SEMI_TRAILER);
  assert.ok(Math.abs(o.front + o.rear - 13.6) < 1e-9, 'a 13.6 m trailer');
  const total = VEHICLES.semi.outline.front + behind + SEMI_TRAILER.length;
  assert.ok(Math.abs(total - 16.5) < 0.05, `combination ${total.toFixed(2)} m long`);
  assert.equal(VEHICLES.semi.licence, 'CE');
  assert.equal(VEHICLES.semi.trailer, SEMI_TRAILER);
  assert.equal(VEHICLES.truckSolo.licence, 'C');
  assert.notEqual(VEHICLES.truckSolo.model, VEHICLES.lightTruck.model, 'class C looks unlike class C1');
  assert.ok(SEMI_RIG.trailer.front > 9 && SEMI_RIG.trailerAxles.at.length === 3);
});

test('swept path: round a bend the trailer’s axles run inside the tractor’s – further inside than a drawbar trailer’s', () => {
  const R = 15;
  const inside = (spec: typeof SEMI_TRAILER | typeof TANDEM_TRAILER, wheelbase: number): number => {
    const p = new Puppet(wheelbase);
    const t = new Trailer(spec, new PlaneGround());
    t.coupleBehind(p as unknown as Vehicle);
    // (the circle's centre: R to the left of the rear axle)
    const [rx, rz] = p.rearAxle();
    const cx = rx - R;
    const cz = rz;
    circle(p, t, R, 3, 60);
    const [ax, az] = p.rearAxle();
    assert.ok(Math.abs(Math.hypot(ax - cx, az - cz) - R) < 0.05, 'the tractor’s rear axle on its circle');
    return Math.hypot(t.x - cx, t.z - cz);
  };
  const semi = inside(SEMI_TRAILER, TRACTOR_UNIT.wheelbase);
  const drawbar = inside(TANDEM_TRAILER, TRUCK.wheelbase);
  // the kingpin's circle (it lies 0.45 m ahead of the rear axle) and the steady circle of the axles behind it
  const kp = Math.hypot(R, -SEMI_TRAILER.hitch.behindRearAxle);
  assert.ok(Math.abs(semi - steadyAxleRadius(kp, SEMI_TRAILER.hitchToAxle)) < 0.05, `semi: axles on ${semi.toFixed(2)} m, steady ${steadyAxleRadius(kp, SEMI_TRAILER.hitchToAxle).toFixed(2)} m`);
  assert.ok(semi < R - 1.5, `the semi-trailer cuts in: ${(R - semi).toFixed(2)} m`);
  assert.ok(semi < drawbar - 0.5, `more than the drawbar trailer: ${semi.toFixed(2)} m against ${drawbar.toFixed(2)} m`);
});

test('a gentle turn: the articulation settles well short of the jack-knife limit; reversing in a tight curve it runs up to the limit and stops there', () => {
  const p = new Puppet(TRACTOR_UNIT.wheelbase);
  const t = new SemiTrailer(SEMI_TRAILER, new PlaneGround());
  t.coupleBehind(p as unknown as Vehicle);
  let most = 0;
  circle(p, t, 40, 8, 30, () => (most = Math.max(most, Math.abs(t.articulation))));
  assert.equal(t.jackknifed, false);
  const steady = Math.asin(SEMI_TRAILER.hitchToAxle / 40);
  assert.ok(Math.abs(Math.abs(t.articulation) - steady) < 0.03, `settled at ${t.articulation.toFixed(3)} rad (steady ${steady.toFixed(3)})`);
  assert.ok(most < JACKKNIFE_LIMIT / 3, `at most ${most.toFixed(2)} rad`);

  // reversing round a bend: the trailer breaks out further and further – until it stands against the cab
  const q = new Puppet(TRACTOR_UNIT.wheelbase);
  const r = new SemiTrailer(SEMI_TRAILER, new PlaneGround());
  r.coupleBehind(q as unknown as Vehicle);
  let events = 0;
  let max = 0;
  circle(q, r, 20, -1.5, 40, () => {
    if (r.jackknifeEvent) events++;
    max = Math.max(max, Math.abs(r.articulation));
  });
  assert.equal(r.jackknifed, true, 'jack-knifed');
  assert.equal(events, 1, 'said once');
  assert.ok(max <= JACKKNIFE_LIMIT + 1e-9, `never past the limit: ${max.toFixed(3)}`);
  assert.ok(Math.abs(Math.abs(wrap(q.yaw - r.yaw)) - JACKKNIFE_LIMIT) < 1e-6, 'the trailer held at the limit');
  // the kingpin stays on the fifth wheel
  const hit = [0, 0, 0];
  r.hitchPoint(q as unknown as Vehicle, hit);
  assert.ok(Math.abs(Math.hypot(r.x - hit[0], r.z - hit[2]) - SEMI_TRAILER.hitchToAxle) < 1e-6);
});

test('its weight rests on the fifth wheel; its spring brakes hold while its brake is set or the red line is off', () => {
  const p = new Puppet(TRACTOR_UNIT.wheelbase);
  const t = new SemiTrailer(SEMI_TRAILER, new PlaneGround());
  t.coupleBehind(p as unknown as Vehicle);
  circle(p, t, 1e6, 1, 1);
  const g = 9.81;
  assert.ok(Math.abs(-p.liftImpulse - SEMI_TRAILER.mass * g * SEMI_TRAILER.kingpinShare) < 50, `kingpin load ${(-p.liftImpulse / g).toFixed(0)} kg over a second`);
  assert.equal(t.braked, false);
  t.supply = false;
  assert.equal(t.braked, true, 'no supply air: the spring brakes are on');
  t.supply = true;
  t.parkBrake = true;
  assert.equal(t.braked, true);
  // a real tractor cannot pull it away against its brakes
  const ground = new PlaneGround();
  const tractor = makeCar(ground, TRACTOR_UNIT);
  const s = new SemiTrailer(SEMI_TRAILER, ground);
  s.coupleBehind(tractor);
  s.parkBrake = true;
  for (let i = 0; i < Math.round(4 / DT); i++) {
    const inp = input({ gear: 1, throttle: 1 });
    tractor.step(DT, inp);
    s.step(DT, tractor, inp);
  }
  assert.ok(Math.abs(tractor.speed) < 0.6, `held: ${tractor.speed.toFixed(2)} m/s`);
});

// ---- the coupling lesson with the real tractor and semi-trailer

interface Rig {
  truck: Vehicle;
  trailer: SemiTrailer;
  task: YardTask;
  faults: string[];
}

function rig(): Rig {
  const ground = new PlaneGround();
  const truck = makeCar(ground, TRACTOR_UNIT);
  const trailer = new SemiTrailer(SEMI_TRAILER, ground);
  trailer.coupleBehind(truck);
  return { truck, trailer, task: new YardTask('couple', true), faults: [] };
}

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

const park = (r: Rig): void => drive(r, 8, () => input({ gear: 0, brake: Math.abs(r.truck.speed) > 0.05 ? 0.6 : 0, handbrake: Math.abs(r.truck.speed) > 0.05 ? 0 : 1 }), () => Math.abs(r.truck.speed) < 0.02 && r.task.state.handbrake);

function onFoot(r: Rig, ...ids: CouplingStepId[]): void {
  const proc = r.task.coupling!;
  for (const id of ids) {
    assert.ok(proc.choices().includes(id), `${id} is offered (offered: ${proc.choices().join(' ')})`);
    assert.equal(proc.act(id, r.task.state), null, id);
  }
}

const gap = (r: Rig): number => r.trailer.offsetFrom(r.truck).dist;

test('uncoupling and coupling the semi-trailer, step by step: legs, lines, fifth wheel, under the trailer, brake test', () => {
  const r = rig();
  park(r);
  // out of turn: the fifth wheel cannot be opened before the trailer is secured and the lines are off
  assert.equal(r.task.coupling!.act('uOpen', r.task.state), 'ceOpen', 'out of turn: a fault');
  assert.equal(r.task.coupling!.done.has('uOpen'), false);
  onFoot(r, 'uBrake', 'uChocks');
  drive(r, 0.1, () => input({ handbrake: 1 }));
  assert.equal(r.trailer.parkBrake, true, 'its parking brake is set');
  onFoot(r, 'uLeg');
  drive(r, 2.5, () => input({ handbrake: 1 }));
  assert.equal(r.trailer.legsDown, true);
  assert.ok(r.trailer.legs > 0.99, 'the landing gear is down');
  onFoot(r, 'uRed', 'uYellow', 'uCable');
  drive(r, 0.1, () => input({ handbrake: 1 }));
  assert.equal(r.trailer.supply, false);
  onFoot(r, 'uOpen');
  const at = [r.trailer.x, r.trailer.z];
  drive(r, 25, () => input({ gear: 1, throttle: 0.2 }), () => !r.trailer.coupled && gap(r) > 6);
  assert.equal(r.trailer.coupled, false, 'out from under the trailer');
  park(r);
  assert.ok(Math.hypot(r.trailer.x - at[0], r.trailer.z - at[1]) < 0.02, 'it stays on its legs');
  onFoot(r, 'cCheck');
  // back to just before the trailer's front
  drive(r, 40, () => input({ gear: -1, brake: r.truck.speed < -0.6 ? 0.3 : 0 }), () => gap(r) < 3.0);
  park(r);
  assert.ok(gap(r) > 2.3 && gap(r) < 4, `stopped before the trailer: ${gap(r).toFixed(2)} m`);
  assert.equal(r.task.coupling!.done.has('cApproach'), true);
  onFoot(r, 'cHeight');
  drive(r, 40, () => input({ gear: -1, brake: r.truck.speed < -0.3 ? 0.4 : 0 }), () => r.trailer.coupled);
  assert.equal(r.trailer.coupled, true, 'the jaws closed round the kingpin');
  park(r);
  onFoot(r, 'cLocked', 'cYellow', 'cRed', 'cCable', 'cLights', 'cLeg', 'cChocks', 'cBrake');
  drive(r, 2.5, () => input({ handbrake: 1 }));
  assert.equal(r.trailer.legsDown, false);
  assert.ok(r.trailer.legs < 0.01, 'the landing gear is up');
  assert.equal(r.trailer.braked, false, 'brake released, air on');
  drive(r, 20, () => input({ gear: 1, throttle: 0.5 }), () => r.truck.speed > 2.2);
  drive(r, 10, () => input({ gear: 1, brake: 0.6 }), () => r.task.coupling!.status.state === 'done');
  assert.deepEqual(r.faults, [], 'no fault on the way');
  assert.equal(r.task.coupling!.status.state, 'done');
  assert.ok(Math.abs(r.trailer.articulation) < 0.1);
});

test('missing the kingpin: the tractor goes on under the trailer until its cab stands against the front – not coupled', () => {
  const r = rig();
  park(r);
  onFoot(r, 'uBrake', 'uChocks', 'uLeg', 'uRed', 'uYellow', 'uCable', 'uOpen');
  drive(r, 25, () => input({ gear: 1, throttle: 0.2 }), () => !r.trailer.coupled && gap(r) > 6);
  park(r);
  onFoot(r, 'cCheck');
  // the trailer 60 cm to the side
  r.trailer.place(r.trailer.x + 0.6 * Math.cos(r.trailer.yaw), r.trailer.z - 0.6 * Math.sin(r.trailer.yaw), r.trailer.yaw);
  drive(r, 30, () => input({ gear: -1, brake: r.truck.speed < -0.5 ? 0.3 : 0 }));
  assert.equal(r.trailer.coupled, false);
  const mpos = [0, 0, 0];
  r.truck.getModelPosition(mpos);
  // (facing north: the kingpin's distance behind the tractor's origin)
  const behind = r.trailer.hitchZ - mpos[2];
  assert.ok(behind > 0.7 && behind < 1.1, `stopped with its cab at the trailer's front: kingpin ${behind.toFixed(2)} m behind the origin`);
});

test('the texts of the steps: the articulated lorry’s own where it differs', () => {
  assert.equal(taskTextKey(true, 'step', 'uLeg'), 'semi.step.uLeg');
  assert.equal(taskTextKey(true, 'step', 'uRed'), 'ce.step.uRed');
  assert.equal(taskTextKey(false, 'step', 'uLeg'), 'ce.step.uLeg');
  assert.equal(taskTextKey(true, 'do', 'corner'), 'ce.do.corner');
});
