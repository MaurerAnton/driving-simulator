// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Acceptance tests for the vehicle dynamics.
 *
 * The expectations are written from how a real compact car behaves (published
 * figures for 110 kW compact hatchbacks, driving-school experience), not from
 * what the code happens to output.  If one fails, fix the model.
 *
 *   node --test "tests/vehicle/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPACT_CAR, COMPACT_CAR_AUTOCLUTCH, COMPACT_CAR_AUTOMATIC } from '../../src/sim/vehicle/index.ts';
import type { Vehicle } from '../../src/sim/vehicle/index.ts';
import { DT, PlaneGround, input, kmh, makeCar, run, sprintDriver } from './harness.ts';

const between = (v: number, lo: number, hi: number, what: string): void => {
  assert.ok(v >= lo && v <= hi, `${what}: ${v.toFixed(3)} not in [${lo}, ${hi}]`);
};

/** Bring a fresh car to `target` km/h with the sprint driver, then hand over. */
function cruiseTo(v: Vehicle, target: number, shiftRpm = 5500): void {
  const d = sprintDriver(shiftRpm);
  let t = 0;
  while (kmh(v) < target && t < 90) {
    v.step(DT, d(t, v));
    t += DT;
  }
  assert.ok(kmh(v) >= target, `could not reach ${target} km/h`);
}

test('rest: stands still, correct static loads', () => {
  const v = makeCar();
  run(v, 3, () => input({ handbrake: 1 }));
  const x0 = v.pos[0];
  const z0 = v.pos[2];
  const y0 = v.pos[1];
  run(v, 60, () => input({ handbrake: 1 }));
  assert.ok(Math.hypot(v.pos[0] - x0, v.pos[2] - z0) < 0.005, 'horizontal drift');
  assert.ok(Math.abs(v.speed) < 0.001, 'residual speed');
  assert.ok(Math.abs(v.pos[1] - y0) < 0.001, 'ride height drifts');
  between(v.pos[1], 0.53, 0.55, 'cg height at rest');
  const sum = v.wheels.reduce((a, w) => a + w.load, 0);
  between(sum / (v.spec.mass * 9.81), 0.99, 1.01, 'sum of wheel loads / weight');
  between((v.wheels[0].load + v.wheels[1].load) / sum, 0.58, 0.62, 'front load share');
});

test('idle: holds ~800 rpm, revs freely, returns to idle', () => {
  const v = makeCar();
  run(v, 8, () => input());
  between(v.rpm, 750, 850, 'idle rpm');
  let reached = -1;
  run(v, 1.5, () => input({ throttle: 1 }), (t, c) => {
    if (reached < 0 && c.rpm > 5500) reached = t;
  });
  assert.ok(reached > 0 && reached < 1.5, 'engine should rev past 5500 rpm within 1.5 s');
  assert.ok(v.rpm < 6800, 'rev limiter');
  run(v, 5, () => input());
  assert.ok(v.engineRunning, 'must not stall when the throttle is released');
  between(v.rpm, 740, 860, 'idle after blip');
});

test('clutch: dumping it stalls, feeding it in slowly creeps without throttle', () => {
  const v = makeCar();
  run(v, 1, () => input({ gear: 1, clutch: 1 }));
  const z0 = v.pos[2];
  let stalled = false;
  run(v, 3, (t) => input({ gear: 1, clutch: Math.max(0, 1 - t / 0.1) }), (_t, c) => {
    if (c.stalledEvent) stalled = true;
  });
  assert.ok(stalled, 'dumping the clutch at idle must stall the engine');
  assert.ok(!v.engineRunning);
  assert.ok(z0 - v.pos[2] < 1.5, 'the lurch stays short');

  const w = makeCar();
  run(w, 1, () => input({ gear: 1, clutch: 1 }));
  let stalled2 = false;
  run(w, 9, (t) => input({ gear: 1, clutch: Math.max(0, 1 - t / 3) }), (_t, c) => {
    if (c.stalledEvent) stalled2 = true;
  });
  assert.ok(!stalled2, 'slow release on the flat must not stall a modern petrol engine');
  between(kmh(w), 5, 9, 'idle creep speed in 1st');

  const u = makeCar();
  run(u, 1, () => input({ gear: 3, clutch: 1 }));
  let stalled3 = false;
  run(u, 5, (t) => input({ gear: 3, clutch: Math.max(0, 1 - t / 2) }), (_t, c) => {
    if (c.stalledEvent) stalled3 = true;
  });
  assert.ok(stalled3, 'pulling away in 3rd without throttle stalls');
});

test('normal launch: smooth, no stall', () => {
  const v = makeCar();
  run(v, 1, () => input({ gear: 1, clutch: 1 }));
  let minAcc = Infinity;
  let stalled = false;
  let t15 = -1;
  run(v, 5, (t) => input({ gear: 1, clutch: Math.max(0, 1 - t / 1.5), throttle: 0.35 }), (t, c) => {
    if (t > 0.4 && t < 3) minAcc = Math.min(minAcc, c.accLong);
    if (c.stalledEvent) stalled = true;
    if (t15 < 0 && kmh(c) > 15) t15 = t;
  });
  assert.ok(!stalled);
  assert.ok(t15 > 0 && t15 < 4, `15 km/h within 4 s (took ${t15.toFixed(2)})`);
  assert.ok(minAcc > -0.3, `no jerking backwards during the launch (min ${minAcc.toFixed(2)} m/s²)`);
});

test('performance: 0–100, top speed, elasticity', () => {
  const v = makeCar();
  const d = sprintDriver();
  let t100 = -1;
  run(v, 30, d, (t, c) => {
    if (t100 < 0 && kmh(c) >= 100) t100 = t;
  });
  between(t100 - 0.25, 8.0, 10.5, '0–100 km/h');
  run(v, 90, d);
  const top = kmh(v);
  run(v, 15, d);
  // a 110 kW compact reaches about 215–225 km/h
  between(kmh(v), 205, 228, 'top speed');
  assert.ok(kmh(v) - top < 1.5, 'top speed is approached asymptotically');

  const w = makeCar();
  cruiseTo(w, 50, 3200);
  // settle in 4th gear just below 60
  run(w, 1, () => input({ gear: 4, clutch: 1 }));
  run(w, 5, (_t, c) => input({ gear: 4, throttle: kmh(c) < 56 ? 0.6 : 0.05 }));
  assert.equal(w.gear, 4);
  let t60 = -1;
  let t100b = -1;
  run(w, 30, () => input({ gear: 4, throttle: 1 }), (t, c) => {
    if (t60 < 0 && kmh(c) >= 60) t60 = t;
    if (t100b < 0 && kmh(c) >= 100) t100b = t;
  });
  between(t100b - t60, 6, 10, '60–100 km/h in 4th');
});

test('coasting and engine braking', () => {
  const v = makeCar();
  cruiseTo(v, 104);
  run(v, 0.5, () => input({ gear: 0 }));
  const a = v.speed;
  run(v, 2, () => input({ gear: 0 }));
  between((a - v.speed) / 2, 0.25, 0.6, 'coast-down deceleration at 100 km/h');

  const w = makeCar();
  cruiseTo(w, 84, 4500);
  run(w, 0.4, () => input({ gear: 3, clutch: 1 }));
  run(w, 1.0, () => input({ gear: 3, throttle: 0.2 }));
  assert.equal(w.gear, 3);
  const b = w.speed;
  run(w, 2, () => input({ gear: 3 }));
  between((b - w.speed) / 2, 0.5, 1.5, 'engine braking in 3rd around 80 km/h');
});

test('braking: ABS stops in under 40 m from 100 km/h and stays straight', () => {
  const stop = (abs: boolean): { dist: number; lock: number; lateral: number } => {
    const v = makeCar(new PlaneGround(), { ...COMPACT_CAR, abs });
    cruiseTo(v, 100.5);
    run(v, 0.3, () => input({ gear: 0, clutch: 1 }));
    const v0 = kmh(v);
    const z0 = v.pos[2];
    const x0 = v.pos[0];
    let lock = 0;
    let longest = 0;
    run(v, 8, () => input({ gear: 0, brake: 1, clutch: 1 }), (_t, c) => {
      if (c.speed > 3 && c.wheels[0].omega * c.spec.wheelRadius < c.speed * 0.2) lock += DT;
      else lock = 0;
      longest = Math.max(longest, lock);
    });
    assert.ok(Math.abs(v.speed) < 0.05, 'car should have stopped');
    return { dist: (z0 - v.pos[2]) * (100 / v0) ** 2, lock: longest, lateral: Math.abs(v.pos[0] - x0) };
  };
  const withAbs = stop(true);
  between(withAbs.dist, 34, 40, 'stopping distance 100–0 with ABS');
  assert.ok(withAbs.lock < 0.15, `ABS must not let a front wheel stay locked (${withAbs.lock.toFixed(2)} s)`);
  assert.ok(withAbs.lateral < 0.3, 'stays in lane');
  const without = stop(false);
  assert.ok(without.lock > 0.5, 'without ABS the front wheels lock');
  assert.ok(without.dist > withAbs.dist, 'locked wheels need more distance');
});

test('low grip: stopping distance at least doubles', () => {
  const stop = (grip: number): number => {
    const v = makeCar(new PlaneGround(0, grip));
    const d = sprintDriver(3000);
    let t = 0;
    while (kmh(v) < 51 && t < 60) {
      const i = d(t, v);
      i.throttle = Math.min(i.throttle, grip < 1 ? 0.25 : 1);
      v.step(DT, i);
      t += DT;
    }
    const v0 = kmh(v);
    const z0 = v.pos[2];
    run(v, 15, () => input({ gear: 0, brake: 1, clutch: 1 }));
    return (z0 - v.pos[2]) * (50 / v0) ** 2;
  };
  const dry = stop(1);
  const slick = stop(0.4);
  between(dry, 8, 11, 'dry 50–0');
  assert.ok(slick > dry * 2, `grass-like surface: ${slick.toFixed(1)} m vs dry ${dry.toFixed(1)} m`);
});

test('cornering: ~0.9 g limit, understeer, turning circle', () => {
  const v = makeCar();
  const d = sprintDriver(4000);
  let maxLat = 0;
  let trim = 0;
  // circle of 40 m radius around a centre to the right of the start
  run(v, 70, (t, c) => {
    const target = Math.min(27, 6 + t * 0.35);
    const base = c.speed < target ? d(t, c) : input({ gear: c.gear || 2, throttle: 0.12 });
    const rr = Math.hypot(c.pos[0] - 40, c.pos[2]);
    trim += ((rr - 40) * 0.02 + 0.066 - trim) * 0.02;
    base.steer = Math.max(-1, Math.min(1, trim + (rr - 40) * 0.08));
    return base;
  }, (t, c) => {
    if (t > 5) maxLat = Math.max(maxLat, Math.abs(c.accLat));
  });
  between(maxLat / 9.81, 0.85, 1.0, 'peak lateral acceleration');
  const front = (Math.abs(v.wheels[0].slipAngle) + Math.abs(v.wheels[1].slipAngle)) / 2;
  const rear = (Math.abs(v.wheels[2].slipAngle) + Math.abs(v.wheels[3].slipAngle)) / 2;
  assert.ok(front > rear, 'at the limit the front slides first (understeer)');

  const w = makeCar();
  let minX = Infinity;
  let maxX = -Infinity;
  run(w, 32, (t, c) => input({ gear: 1, clutch: t < 2.5 ? Math.max(0, 1 - t / 2) : 0, throttle: kmh(c) < 7 ? 0.25 : 0.06, steer: 1 }), (t, c) => {
    if (t > 8) {
      minX = Math.min(minX, c.wheels[0].hx);
      maxX = Math.max(maxX, c.wheels[0].hx);
    }
  });
  between(maxX - minX, 10, 11.5, 'kerb-to-kerb turning circle');
});

test('hills: handbrake holds, neutral rolls, parked in gear, hill start', () => {
  const g = new PlaneGround(0.15);
  const v = makeCar(g);
  run(v, 3, () => input({ handbrake: 1 }));
  const z0 = v.pos[2];
  run(v, 20, () => input({ handbrake: 1 }));
  assert.ok(Math.abs(v.pos[2] - z0) < 0.005, `handbrake creep ${(Math.abs(v.pos[2] - z0) * 1000).toFixed(1)} mm`);
  run(v, 4, () => input());
  assert.ok(v.speed < -2, 'released in neutral the car rolls back and gathers speed');

  const p = makeCar(g, COMPACT_CAR, false);
  run(p, 2, () => input({ gear: 1, handbrake: 1, ignition: false }));
  const z1 = p.pos[2];
  run(p, 10, () => input({ gear: 1, ignition: false }));
  assert.ok(Math.abs(p.pos[2] - z1) < 0.3, 'left in 1st gear the dead engine holds the car');

  const h = makeCar(g);
  run(h, 2, () => input({ gear: 1, clutch: 1, handbrake: 1 }));
  const z2 = h.pos[2];
  let back = 0;
  let stalled = false;
  run(h, 8, (t) => input({ gear: 1, throttle: t < 0.5 ? 0.25 : 0.42, clutch: Math.max(0, 1 - Math.max(0, t - 0.3) / 2.2), handbrake: t < 1.5 ? 1 : 0 }), (_t, c) => {
    back = Math.max(back, c.pos[2] - z2);
    if (c.stalledEvent) stalled = true;
  });
  assert.ok(!stalled, 'hill start must not stall');
  assert.ok(back < 0.1, `rolled back ${back.toFixed(2)} m`);
  assert.ok(kmh(h) > 5, 'drives off up the hill');
});

test('a light foot on the brake stops the car completely and holds it, on any slope', () => {
  // Found by the virtual learner driver: the car kept crawling at 0.3 m/s
  // against a half-pressed brake and rolled over a red stop line.
  const cases: [string, typeof COMPACT_CAR, number][] = [
    ['automatic in D', COMPACT_CAR_AUTOMATIC, 1],
    ['manual in neutral', COMPACT_CAR, 0],
    ['clutch assist in 1st', COMPACT_CAR_AUTOCLUTCH, 1],
  ];
  for (const [name, spec, gear] of cases) {
    for (const grade of [0, -0.1, 0.1]) {
      for (const brake of [0.25, 0.5]) {
        const v = makeCar(new PlaneGround(grade), spec);
        run(v, 3, () => input({ gear, throttle: 0.12 })); // roll (or creep) first
        run(v, 4, () => input({ gear, brake }));
        const x0 = v.pos[0];
        const z0 = v.pos[2];
        run(v, 5, () => input({ gear, brake }));
        const moved = Math.hypot(v.pos[0] - x0, v.pos[2] - z0);
        const what = `${name}, grade ${grade}, brake ${brake}`;
        assert.ok(moved < 0.01, `${what}: crept ${(moved * 100).toFixed(1)} cm in 5 s`);
        assert.ok(Math.abs(v.speed) < 0.005, `${what}: still moving at ${v.speed.toFixed(3)} m/s`);
        for (const wh of v.wheels) assert.equal(wh.omega, 0, `${what}: wheel not held`);
      }
    }
  }
});

test('rollover: the body shell carries the car, it does not sink into the ground', () => {
  // Found by the virtual learner driver: once the car lay on its side the
  // wheels no longer reached the ground and it fell through the world.
  for (const [what, angle, lo, hi] of [
    ['on the roof', Math.PI, 0.7, 1.0],
    ['on its side', Math.PI / 2, 0.4, 1.0],
  ] as const) {
    const v = makeCar();
    v.quat[0] = 0;
    v.quat[1] = 0;
    v.quat[2] = Math.sin(angle / 2); // roll about the longitudinal axis
    v.quat[3] = Math.cos(angle / 2);
    v.pos[1] = 1.15;
    v.vel.fill(0);
    v.angVel.fill(0);
    let touched = false;
    run(
      v,
      5,
      () => input({ gear: 0 }),
      () => {
        if (v.bodyContact) touched = true;
      },
    );
    assert.ok(touched, `${what}: the body never touched the ground`);
    between(v.pos[1], lo, hi, `${what}: height of the centre of mass at rest`);
    assert.ok(Math.hypot(v.vel[0], v.vel[1], v.vel[2]) < 0.05, `${what}: still moving`);
  }
  // and on its wheels the shell stays out of it
  const v = makeCar();
  let touched = false;
  run(
    v,
    6,
    (t) => input({ gear: 1, clutch: t < 0.3 ? 1 : 0, throttle: 0.5, steer: t > 3 ? 1 : 0 }),
    () => {
      if (v.bodyContact) touched = true;
    },
  );
  assert.equal(touched, false, 'body contact while driving normally');
  assert.ok(v.upright > 0.97, `leaning ${v.upright.toFixed(3)} in a tight turn`);
});

test('reverse gear', () => {
  const v = makeCar();
  run(v, 1, () => input({ gear: -1, clutch: 1 }));
  run(v, 25, (t) => input({ gear: -1, clutch: Math.max(0, 1 - t / 1.5), throttle: 1 }));
  between(kmh(v), -62, -40, 'reverse top speed at the limiter');
});

test('gearbox refuses a shift without the clutch', () => {
  const v = makeCar();
  cruiseTo(v, 30, 9000); // stays in 1st
  assert.equal(v.gear, 1);
  let grind = false;
  // pull out of gear (always possible), then try 2nd with the engine at idle speed
  run(v, 0.3, () => input({ gear: 0, clutch: 0, throttle: 0 }));
  run(v, 0.5, () => input({ gear: 2, clutch: 0, throttle: 0 }), (_t, c) => {
    if (c.gearGrind) grind = true;
  });
  assert.ok(grind, 'gearGrind is reported');
  assert.equal(v.gear, 0, 'the gear does not go in');
  run(v, 0.3, () => input({ gear: 2, clutch: 1 }));
  assert.equal(v.gear, 2, 'with the clutch pressed it does');
});

test('starter: cranks, fires, and moves the car when left in gear', () => {
  const v = makeCar(new PlaneGround(), COMPACT_CAR, false);
  run(v, 0.5, () => input());
  assert.ok(!v.engineRunning);
  let fired = -1;
  run(v, 2, () => input({ starter: true }), (t, c) => {
    if (fired < 0 && c.engineRunning) fired = t;
  });
  between(fired, 0.4, 1.3, 'time until the engine fires');
  run(v, 3, () => input());
  between(v.rpm, 740, 860, 'idle after start');

  const w = makeCar(new PlaneGround(), COMPACT_CAR, false);
  run(w, 0.5, () => input({ gear: 1 }));
  const z0 = w.pos[2];
  run(w, 0.8, () => input({ gear: 1, starter: true }));
  assert.ok(z0 - w.pos[2] > 0.15, 'starting in gear with the clutch engaged makes the car lurch forward');
});

test('automatic gearbox: creep, kick-down, park', () => {
  const v = makeCar(new PlaneGround(), COMPACT_CAR_AUTOMATIC);
  run(v, 12, () => input({ gear: 1 }));
  between(kmh(v), 4, 8, 'creep speed in D');
  assert.ok(v.engineRunning);

  const w = makeCar(new PlaneGround(), COMPACT_CAR_AUTOMATIC);
  let t100 = -1;
  run(w, 30, () => input({ gear: 1, throttle: 1 }), (t, c) => {
    if (t100 < 0 && kmh(c) >= 100) t100 = t;
  });
  // modern automatics are about as quick as the manual version of the same car
  between(t100, 8.0, 11.5, 'automatic 0–100 km/h');

  const p = makeCar(new PlaneGround(0.15), COMPACT_CAR_AUTOMATIC);
  run(p, 2, () => input({ gear: -2, brake: 1 }));
  const z0 = p.pos[2];
  run(p, 10, () => input({ gear: -2 }));
  assert.ok(Math.abs(p.pos[2] - z0) < 0.05, 'P holds on a 15 % slope');
});

test('clutch assist: launches on throttle alone, never stalls when stopping', () => {
  const v = makeCar(new PlaneGround(), COMPACT_CAR_AUTOCLUTCH);
  let stalled = false;
  run(v, 5, () => input({ gear: 1, throttle: 0.5 }), (_t, c) => {
    if (c.stalledEvent) stalled = true;
  });
  assert.ok(kmh(v) > 20, 'pulls away');
  run(v, 6, () => input({ gear: 1, brake: 0.6 }), (_t, c) => {
    if (c.stalledEvent) stalled = true;
  });
  assert.ok(Math.abs(v.speed) < 0.05);
  assert.ok(!stalled && v.engineRunning, 'no stall');
});

test('kerb: 12 cm step at 20 km/h', () => {
  const g = new PlaneGround();
  g.stepZ = -30;
  g.stepHeight = 0.12;
  const v = makeCar(g);
  cruiseTo(v, 20, 3000);
  let maxPitch = 0;
  run(v, 8, (_t, c) => input({ gear: c.gear, throttle: kmh(c) < 20 ? 0.3 : 0.08 }), (_t, c) => {
    assert.ok(Number.isFinite(c.pos[1]) && Number.isFinite(c.vel[0]), 'state must stay finite');
    const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (c.quat[3] * c.quat[0] - c.quat[1] * c.quat[2]))));
    maxPitch = Math.max(maxPitch, Math.abs(pitch));
  });
  assert.ok(v.pos[2] < -32, 'car continues past the kerb');
  assert.ok((maxPitch * 180) / Math.PI < 12, 'pitch stays moderate');
  between(v.pos[1], 0.64, 0.68, 'settles 12 cm higher');
});

test('stability: straight at 180 km/h, damped response to a steering step', () => {
  const v = makeCar();
  cruiseTo(v, 180);
  const x0 = v.pos[0];
  let drift = 0;
  run(v, 30, (_t, c) => input({ gear: c.gear, throttle: kmh(c) < 180 ? 0.9 : 0.5 }), (_t, c) => {
    drift = Math.max(drift, Math.abs(c.pos[0] - x0));
  });
  assert.ok(drift < 0.5, `lateral drift ${drift.toFixed(3)} m`);

  const w = makeCar();
  cruiseTo(w, 100);
  const trace: number[] = [];
  run(w, 3, (_t, c) => input({ gear: c.gear, throttle: 0.3, steer: 0.05 }), (_t, c) => trace.push(c.angVel[1]));
  // steering right → yaw decreases → negative yaw rate
  const settled = trace.slice(-120).reduce((a, b) => a + b, 0) / 120;
  between(-settled, 0.08, 0.35, 'steady yaw rate for 0.05 steering at 100 km/h');
  const late = trace.slice(Math.round(2 / DT));
  const ripple = Math.max(...late) - Math.min(...late);
  assert.ok(ripple < 0.02, `yaw rate settles within 2 s (ripple ${ripple.toFixed(4)})`);
});

test('deterministic', () => {
  const runOnce = (): number[] => {
    const v = makeCar();
    const d = sprintDriver();
    run(v, 12, (t, c) => ({ ...d(t, c), steer: Math.sin(t * 0.7) * 0.1 }));
    return [...v.pos, ...v.quat, ...v.vel, ...v.angVel, v.rpm];
  };
  assert.deepEqual(runOnce(), runOnce());
});

test('performance: fast enough for 240 Hz', () => {
  const v = makeCar();
  const inp = input({ gear: 2, throttle: 0.5 });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 120000; i++) v.step(DT, inp);
  const us = Number(process.hrtime.bigint() - t0) / 1e3 / 120000;
  // budget: 240 steps/s must stay far below one frame; generous for slow CI machines
  assert.ok(us < 250, `${us.toFixed(1)} µs per step`);
});
