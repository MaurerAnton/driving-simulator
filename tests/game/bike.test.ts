// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The rider of the player's motorcycle: how he moves (RiderMotion – from speed, steering, lean,
 * throttle, brake and indicator) and that the model follows him in every class: hands on the grips,
 * feet on the pegs or on the road, no limb stretched, the camera of his eyes steady while he looks round.
 *
 *   node --test tests/game/bike.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { PlayerBike, RiderMotion } from '../../src/render/bike.ts';
import type { BikeVariant, RiderInput, RiderPose } from '../../src/render/bike.ts';
import type { CarVisualState } from '../../src/render/car.ts';

const DT = 1 / 30;
const DEG = Math.PI / 180;
const WHEELBASE = 1.45;
const RAKE = 25 * DEG;

/** Riding at `kmh` round a bend of radius `r` (m, + = to the right; 0 = straight on): the input of a steady curve. */
function curve(kmh: number, r = 0, over: Partial<RiderInput> = {}): RiderInput {
  const v = kmh / 3.6;
  const steer = r === 0 ? 0 : Math.sign(r) * Math.atan(WHEELBASE / Math.abs(r));
  const lean = r === 0 ? 0 : Math.sign(r) * Math.atan((v * v) / Math.abs(r) / 9.81);
  return { speedKmh: kmh, reversing: false, steer, wheelbase: WHEELBASE, bar: steer / Math.cos(RAKE), lean, throttle: 0.2, brake: 0, indicator: 0, ...over };
}

/** A rider, stepped frame by frame. */
class Ride {
  readonly m = new RiderMotion();

  /** `seconds` of the same input; the pose at the end. */
  hold(input: RiderInput, seconds: number): RiderPose {
    for (let i = 0; i < Math.round(seconds / DT); i++) this.m.step(input, DT);
    return this.m.pose;
  }

  /** where he looks, head and shoulders together (rad, + = right of straight ahead) */
  get look(): number {
    return this.m.pose.torsoYaw + this.m.pose.headYaw;
  }
}

test('he looks through the bend: into it, further in a tight turn than in a sweeping one, and before the machine leans', () => {
  const right = new Ride();
  right.hold(curve(15, 8), 2);
  assert.ok(right.look > 25 * DEG && right.look < 60 * DEG, `turning right at a junction: ${(right.look / DEG).toFixed(0)}°`);
  const left = new Ride();
  left.hold(curve(15, -8), 2);
  assert.ok(Math.abs(left.look + right.look) < 1e-9, 'turning left: the same to the other side');
  const sweep = new Ride();
  sweep.hold(curve(70, 150), 4);
  assert.ok(sweep.look > 0 && sweep.look < right.look - 0.2, `a sweeping bend: ${(sweep.look / DEG).toFixed(0)}°`);
  // (the wheel turned, the machine not yet leaning: the head turns first)
  const first = new Ride();
  first.hold(curve(15), 1);
  first.hold({ ...curve(15, 8), lean: 0 }, 0.4);
  assert.ok(first.look > 15 * DEG, `0.4 s into the turn: ${(first.look / DEG).toFixed(0)}°`);
  // (the shoulders take part of it, the head the rest)
  assert.ok(right.m.pose.torsoYaw > 0 && right.m.pose.headYaw > right.m.pose.torsoYaw);
  // a turn at full lock at walking pace: far round, but within what a neck does
  const uturn = new Ride();
  const p = uturn.hold(curve(8, 3), 2);
  assert.ok(uturn.look > 40 * DEG && Math.abs(p.headYaw) < 80 * DEG, `a U-turn: ${(uturn.look / DEG).toFixed(0)}°, the head ${(p.headYaw / DEG).toFixed(0)}° of it`);
});

test('in a bend his upper body leans in a little more than the machine, the hips slide inwards, the inside knee opens', () => {
  const fast = new Ride();
  const input = curve(100, -120);
  const p = fast.hold(input, 3);
  assert.ok(input.lean < -30 * DEG, 'a strong lean to the left');
  assert.ok(p.torsoRoll < -0.05 && p.torsoRoll > -0.25, `the upper body ${(p.torsoRoll / DEG).toFixed(1)}° further in`);
  assert.ok(p.hipShift < -0.03 && p.hipShift > -0.08, `the hips ${(p.hipShift * 100).toFixed(1)} cm to the inside`);
  assert.ok(p.kneeL > 0.8 && p.kneeR === 0, 'the inside knee opens, the outside one stays at the tank');
  // the head keeps the eyes nearer the horizon than the shoulders: leaning in, but less
  const shoulders = input.lean + p.tilt + p.torsoRoll;
  const head = shoulders + p.headRoll;
  assert.ok(head < 0 && head > shoulders * 0.9 && head < shoulders * 0.4, `head ${(head / DEG).toFixed(0)}°, shoulders ${(shoulders / DEG).toFixed(0)}°`);
  // a gentle lean: in with the machine, nothing hanging off
  const gentle = new Ride().hold(curve(50, 150), 3);
  assert.ok(gentle.torsoRoll > 0 && gentle.torsoRoll < 0.05);
  assert.equal(gentle.hipShift, 0);
  assert.equal(gentle.kneeL + gentle.kneeR, 0);
});

test('an indicator coming on brings one shoulder check to its side; the eye stays where it is', () => {
  const r = new Ride();
  r.hold(curve(30), 5);
  const eye = { ...r.m.pose };
  const on = curve(30, 0, { indicator: 1 });
  r.hold(on, 0.4);
  assert.ok(r.look > 60 * DEG, `0.4 s after: ${(r.look / DEG).toFixed(0)}° to the right`);
  r.hold(on, 0.3);
  assert.ok(r.look > 60 * DEG, 'still looking 0.7 s after');
  assert.ok(r.m.pose.headYaw > 55 * DEG && r.m.pose.torsoYaw > 0.1, 'the head turns, the shoulders a little with it');
  for (const k of ['eyeYaw', 'eyePitch', 'eyeRoll'] as const) assert.ok(Math.abs(r.m.pose[k] - eye[k]) < 1e-6, `the eye's frame (${k}) stays`);
  r.hold(on, 1);
  assert.ok(Math.abs(r.look) < 10 * DEG, 'back ahead after 1.7 s');
  r.hold(on, 3);
  assert.ok(Math.abs(r.look) < 10 * DEG, 'one check, however long the indicator blinks');
  r.hold(curve(30, 0, { indicator: -1 }), 0.5);
  assert.ok(r.look < -60 * DEG, 'changed to the left: a check over the left shoulder');
  // the hazard lights are no indicator: the game hands them over as 0
  const h = new Ride();
  h.hold(curve(30), 1);
  h.hold(curve(30, 0, { indicator: 0 }), 0.5);
  assert.ok(Math.abs(h.look) < 10 * DEG);
});

test('standing he puts his left foot down and the machine settles on to it; riding, the feet are on the pegs', () => {
  const r = new Ride();
  let p = r.hold(curve(20), 2);
  assert.ok(p.footL < 0.01 && p.footR < 0.01 && Math.abs(p.tilt) < 1e-3);
  p = r.hold(curve(0), 1.5);
  assert.ok(p.footL > 0.95 && p.footR < 0.01, 'the left foot on the road, the right on the brake pedal');
  assert.ok(p.tilt < -1.5 * DEG && p.tilt > -4 * DEG, `the machine ${(p.tilt / DEG).toFixed(1)}° on to it`);
  assert.ok(Math.abs(p.torsoRoll + p.tilt) < 0.03, 'he stays upright');
  // (rolling at a walk he keeps it down; up only once he rides – and down only once he stands)
  p = r.hold(curve(4.5), 1);
  assert.ok(p.footL > 0.95);
  p = r.hold(curve(20), 1.5);
  assert.ok(p.footL < 0.05 && Math.abs(p.tilt) < 0.2 * DEG, 'riding again: on the peg');
  p = r.hold(curve(4.5), 1);
  assert.ok(p.footL < 0.05);
  // pushed backwards: both feet on the road, looking over a shoulder
  p = r.hold({ ...curve(2), reversing: true }, 1.5);
  assert.ok(p.footL > 0.95 && p.footR > 0.95 && Math.abs(p.tilt) < 0.2 * DEG);
  assert.ok(Math.abs(r.look) > 50 * DEG);
});

test('hard on the throttle he tucks in, on the brakes he braces himself – not when he only holds the brake standing', () => {
  const r = new Ride();
  const cruise = r.hold(curve(50), 2).torsoPitch;
  let p = r.hold(curve(55, 0, { throttle: 1 }), 1.5);
  assert.ok(p.torsoPitch > cruise + 4 * DEG && p.elbows > 0.5, `tucked in by ${((p.torsoPitch - cruise) / DEG).toFixed(1)}°`);
  assert.ok(Math.abs(p.headPitch + p.torsoPitch) < 0.03, 'still looking ahead');
  p = r.hold(curve(40, 0, { throttle: 0, brake: 0.9 }), 1);
  assert.ok(p.torsoPitch < cruise - 3 * DEG && p.hipSlide > 0.015 && p.elbows < -0.3, 'braced: upright, slid forwards, elbows in');
  p = r.hold(curve(0, 0, { throttle: 0, brake: 0.9 }), 2);
  assert.ok(Math.abs(p.elbows) < 0.05 && p.hipSlide < 0.003, 'standing on the brake: at ease');
});

test('while he waits he looks round now and then – the same each time – and the eye stays where it is', () => {
  const a = new Ride();
  const b = new Ride();
  a.hold(curve(0), 2);
  b.hold(curve(0), 2);
  const eye = { ...a.m.pose };
  let busy = 0;
  let most = 0;
  for (let i = 0; i < 60 / DT; i++) {
    a.hold(curve(0), DT);
    b.hold(curve(0), DT);
    assert.deepEqual(a.m.pose, b.m.pose);
    for (const k of ['eyeYaw', 'eyePitch', 'eyeRoll'] as const) assert.ok(Math.abs(a.m.pose[k] - eye[k]) < 1e-9);
    if (Math.abs(a.look) > 0.15) busy++;
    most = Math.max(most, Math.abs(a.look));
  }
  const share = (busy * DT) / 60;
  assert.ok(share > 0.05 && share < 0.5, `looking round ${(share * 100).toFixed(0)} % of a minute`);
  assert.ok(most < 50 * DEG);
  // no time, no movement
  const before = { ...a.m.pose };
  a.m.step(curve(0, 0, { indicator: 1 }), 0);
  assert.deepEqual(a.m.pose, before);
});

test('odd numbers do no harm', () => {
  const r = new RiderMotion();
  const odd = [NaN, Infinity, -Infinity, 1e9, -1e9];
  for (const x of odd) {
    for (const dt of [x, -1, 0, DT, 1, 30]) {
      const p = r.step({ speedKmh: x, reversing: false, steer: x, wheelbase: x, bar: x, lean: x, throttle: x, brake: x, indicator: x }, dt);
      for (const [k, v] of Object.entries(p)) {
        assert.ok(Number.isFinite(v), `${k} with ${x} and dt ${dt}`);
        assert.ok(Math.abs(v) < 2, `${k}: ${v}`);
      }
    }
  }
});

// ------------------------------------------------------------------------------ the model

/** The standing state of render/bike.ts, changed by `over`. */
function state(over: Partial<CarVisualState> = {}): CarVisualState {
  const r = 0.31;
  return {
    speedKmh: 0, rpm: 1300, gear: 1, indicator: 0, hazard: false, blinkOn: false, lowBeam: true, highBeam: false, handbrake: false, ignition: true,
    engineRunning: true, abs: false, seatbelt: true, fuel: 0.7, automatic: false, showGear: true, odometerKm: 0, steerWheel: 0,
    wheelSteer: [0, 0, 0, 0], wheelSpin: [0, 0, 0, 0], wheelY: [r, r, r, r], clutch: 0, brake: 0, throttle: 0, handbrakeLever: 0, braking: false, reversing: false,
    ...over,
  };
}

interface Limb {
  upper: THREE.Object3D;
  fore: THREE.Object3D;
  wrist: THREE.Vector3;
}
interface Leg {
  side: number;
  thigh: THREE.Object3D;
  shin: THREE.Object3D;
  foot: THREE.Object3D;
}
/** what the tests look at inside the model */
interface Inside {
  arms: Limb[];
  legs: Leg[];
  front: THREE.Object3D;
  head: THREE.Object3D;
}

/** The model of a class, built with a stand-in for the canvases it paints (number plate, instruments). */
function build(variant: BikeVariant): PlayerBike {
  const ctx: unknown = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 }) : k === 'canvas' ? { width: 512, height: 256 } : () => ctx), set: () => true });
  const g = globalThis as { document?: unknown };
  const had = g.document;
  g.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
  try {
    return new PlayerBike(variant);
  } finally {
    g.document = had;
  }
}

/** The far end of a part posed along +y (an arm, a leg) with the length it has unstretched. */
function end(o: THREE.Object3D, length: number): THREE.Vector3 {
  return new THREE.Vector3(0, length * o.scale.y, 0).applyQuaternion(o.quaternion).add(o.position);
}

test('the model follows him in every class: hands on the grips, feet on the pegs or the road, nothing stretched, the eye steady', () => {
  for (const variant of ['moped', 'light', 'mid', 'big'] as const) {
    const bike = build(variant);
    const inside = bike as unknown as Inside;
    const rest = bike.eye.clone();
    let clock = 0;
    const check = (what: string): void => {
      for (const a of inside.arms) {
        assert.ok(a.upper.scale.y < 1.001 && a.fore.scale.y < 1.001, `${variant}, ${what}: an arm stretched`);
        const grip = a.wrist.clone().applyMatrix4(inside.front.matrix);
        assert.ok(end(a.fore, 0.26).distanceTo(grip) < 1e-3, `${variant}, ${what}: a hand off its grip`);
        assert.ok(end(a.upper, 0.29).distanceTo(a.fore.position) < 1e-3, `${variant}, ${what}: an elbow apart`);
      }
      for (const g of inside.legs) {
        assert.ok(g.thigh.scale.y < 1.001 && g.shin.scale.y < 1.001, `${variant}, ${what}: a leg stretched`);
        assert.ok(end(g.thigh, 0.45).distanceTo(g.shin.position) < 1e-3 && end(g.shin, 0.44).distanceTo(g.foot.position) < 1e-3, `${variant}, ${what}: a leg apart`);
      }
      assert.ok(bike.eye.distanceTo(rest) < 0.2, `${variant}, ${what}: the eye moved ${bike.eye.distanceTo(rest).toFixed(2)} m`);
    };
    /** `seconds` of the same state, every frame checked (on the way between poses too) */
    const ride = (what: string, s: CarVisualState, lean: number, seconds = 2): void => {
      bike.setLean(lean);
      for (let i = 0; i < seconds / DT; i++) {
        bike.update(s, DT, (clock += DT));
        check(`${what}, ${(i * DT).toFixed(2)} s`);
      }
      bike.root.updateMatrixWorld(true);
    };
    /** the lowest point of each boot above the road (the root's frame), left and right */
    const soles = (): number[] => inside.legs.map((g) => new THREE.Box3().setFromObject(g.foot).min.y);

    // standing: the left boot on the road, the right one on its peg, the machine a little on to the left
    ride('standing', state(), 0);
    const [l, r] = soles();
    assert.ok(Math.abs(l) < 0.015, `${variant}: the left sole ${l.toFixed(3)} m above the road`);
    assert.ok(r > 0.25, `${variant}: the right boot on its peg`);
    assert.ok(bike.leaning < -1.5 * DEG && bike.leaning > -4 * DEG);
    bike.setRider(false);
    assert.equal(bike.leaning, 0, 'nobody on it: upright');
    bike.setRider(true);
    // riding: both boots on the pegs, the lean as the game asks for it
    ride('riding', state({ speedKmh: 50, throttle: 0.3 }), 0);
    assert.ok(Math.min(...soles()) > 0.25);
    for (const lean of [-39, 39]) {
      const steer = Math.sign(lean) * 0.03;
      const bend = (over: Partial<CarVisualState>): CarVisualState => state({ speedKmh: 60, throttle: 0.3, wheelSteer: [steer, steer, 0, 0], ...over });
      ride(`leaning ${lean}°`, bend({}), lean * DEG);
      assert.ok(Math.abs(bike.leaning - lean * DEG) < 0.5 * DEG);
      ride(`leaning ${lean}°, tucked in`, bend({ throttle: 1 }), lean * DEG, 1);
      ride(`leaning ${lean}°, braking`, bend({ throttle: 0, brake: 1, braking: true }), lean * DEG, 1);
      // (the outside arm at its furthest: hanging off the inside, braced, looking back over the outside shoulder)
      ride(`leaning ${lean}°, braking, a shoulder check outwards`, bend({ throttle: 0, brake: 1, braking: true, indicator: -Math.sign(lean), blinkOn: true }), lean * DEG, 1.3);
      ride(`leaning ${lean}°, a shoulder check inwards`, bend({ indicator: Math.sign(lean), blinkOn: true }), lean * DEG, 1.3);
    }
    for (const steer of [-0.6, 0.6]) {
      ride(`full lock ${steer}`, state({ speedKmh: 8, wheelSteer: [steer, steer, 0, 0] }), Math.sign(steer) * 5 * DEG);
      ride(`full lock ${steer}, braking`, state({ speedKmh: 8, brake: 1, braking: true, wheelSteer: [steer, steer, 0, 0] }), Math.sign(steer) * 5 * DEG, 1);
      ride(`full lock ${steer}, a shoulder check`, state({ speedKmh: 8, wheelSteer: [steer, steer, 0, 0], indicator: Math.sign(steer), blinkOn: true }), Math.sign(steer) * 5 * DEG, 1.3);
    }
    ride('pushed back', state({ speedKmh: 2, reversing: true, gear: -1 }), 0);
    assert.ok(Math.max(...soles().map(Math.abs)) < 0.015, `${variant}: both soles on the road`);
    // a shoulder check: the head turns far round, the camera of the eyes stays where it was
    ride('riding on', state({ speedKmh: 30 }), 0);
    const eye = bike.eye.clone();
    let turned = 0;
    for (let i = 0; i < 1.2 / DT; i++) {
      bike.update(state({ speedKmh: 30, indicator: -1, blinkOn: i % 20 < 10 }), DT, (clock += DT));
      check('a shoulder check');
      turned = Math.max(turned, inside.head.rotation.y);
      assert.ok(bike.eye.distanceTo(eye) < 1e-3, `${variant}: the eye moved with the shoulder check`);
    }
    assert.ok(turned > 60 * DEG, `${variant}: the head turned ${(turned / DEG).toFixed(0)}° to the left`);
  }
});
