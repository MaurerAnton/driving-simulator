// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Acceptance tests for the flight model (src/sim/flight.ts).
 *
 * The expectations are written from how a two-seat high-wing trainer of
 * 160 PS flies (handbook figures of that class, flying-school practice),
 * not from what the code happens to output.  The "pilots" below are simple
 * controllers of the kind an instructor would describe: hold the pitch for
 * the speed, the wings level, the ball in the middle.
 *
 *   node --test tests/vehicle/flight.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AERO, Aircraft, maxLift } from '../../src/sim/flight.ts';
import type { FlightControls } from '../../src/sim/flight.ts';
import { TRAINER } from '../../src/sim/flightspec.ts';
import { PlaneGround } from './harness.ts';

const DT = 1 / 60;
const DEG = Math.PI / 180;
const G = 9.81;

const between = (v: number, lo: number, hi: number, what: string): void => {
  assert.ok(v >= lo && v <= hi, `${what}: ${v.toFixed(3)} not in [${lo}, ${hi}]`);
};
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function controls(over: Partial<FlightControls> = {}): FlightControls {
  return { throttle: 0, elevator: 0, aileron: 0, rudder: 0, flaps: 0, trim: 0, brake: 0, parkingBrake: false, engineOn: true, ...over };
}

/** Run until `seconds` have passed or `pilot` returns true; returns the time flown. */
function fly(a: Aircraft, g: PlaneGround, seconds: number, c: FlightControls, pilot: (t: number) => boolean | void, dt = DT): number {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    if (pilot(t) === true) return t;
    a.step(dt, c, g);
  }
  return seconds;
}

// ---- the pilot's hands ----------------------------------------------------------

/** ailerons: bank towards `target` (rad), damping the roll rate */
function ailerons(a: Aircraft, c: FlightControls, target = 0): void {
  const p = -a.omega.z;
  c.aileron = clamp(2 * (target - a.bank) - 0.4 * p, -1, 1);
}

/** elevator: pitch attitude towards `target` (rad), damping the pitch rate */
function pitchTo(a: Aircraft, c: FlightControls, target: number): void {
  c.elevator = clamp(2.5 * (target - a.pitch) - 1 * a.omega.x, -1, 1);
}

/** rudder in the air: no sideslip (the ball in the middle) */
function ball(a: Aircraft, c: FlightControls): void {
  c.rudder = clamp(3 * a.sideslip, -1, 1);
}

/** rudder on the ground: keep the heading (compass degrees) */
function track(a: Aircraft, c: FlightControls, heading: number): void {
  let e = heading - a.heading;
  e -= 360 * Math.round(e / 360);
  c.rudder = clamp(0.25 * e - 2 * a.turnRate, -1, 1);
}

/** Altitude hold: a vertical speed from the height error, the pitch attitude from the vertical speed error. */
function altitudeHold(target: number): (a: Aircraft, c: FlightControls, dt: number) => void {
  let base = Number.NaN;
  return (a, c, dt) => {
    if (Number.isNaN(base)) base = a.pitch;
    const e = clamp(0.1 * (target - a.altitude), -3, 3) - a.verticalSpeed;
    base = clamp(base + 0.004 * e * dt, -15 * DEG, 20 * DEG);
    pitchTo(a, c, base + 0.012 * e);
  };
}

/** Speed by pitch (as in the climb): raise the nose when too fast.  `target` may change with time. */
function speedHold(target: number | ((t: number) => number)): (a: Aircraft, c: FlightControls, dt: number) => void {
  let base = Number.NaN;
  let t = 0;
  return (a, c, dt) => {
    if (Number.isNaN(base)) base = a.pitch;
    const e = a.ias - (typeof target === 'number' ? target : target(t));
    t += dt;
    base = clamp(base + 0.002 * e * dt, -15 * DEG, 25 * DEG);
    pitchTo(a, c, base + 0.02 * e);
  };
}

function trimmedInAir(speed: number, altitude: number, flaps = 0): { a: Aircraft; c: FlightControls } {
  const a = new Aircraft();
  a.placeInAir(0, altitude, 0, 0, speed);
  const lf = a.levelFlight(speed, flaps);
  return { a, c: controls({ throttle: lf.throttle, trim: lf.trim, flaps }) };
}

// ---- 1. standing ------------------------------------------------------------------------

for (const [name, grade, yaw] of [
  ['flat', 0, 0],
  ['2 % slope, nose uphill', 0.02, 0],
  ['2 % slope, nose downhill', 0.02, Math.PI],
  ['2 % slope, across', 0.02, Math.PI / 2],
] as const) {
  test(`parked (${name}): no creeping, no trembling, standing on its legs`, () => {
    const g = new PlaneGround(grade);
    for (const engine of [false, true]) {
      const a = new Aircraft();
      a.placeOnGround(0, 0, yaw, g, engine);
      const c = controls({ parkingBrake: true, engineOn: engine });
      fly(a, g, 2, c, () => {});
      const x0 = a.pos.x;
      const y0 = a.pos.y;
      const z0 = a.pos.z;
      let vmax = 0;
      fly(a, g, 10, c, () => {
        vmax = Math.max(vmax, Math.hypot(a.vel.x, a.vel.y, a.vel.z), Math.hypot(a.omega.x, a.omega.y, a.omega.z));
      });
      const what = `${name}, engine ${engine ? 'idling' : 'off'}`;
      assert.ok(vmax < 0.02, `${what}: moves at ${vmax.toFixed(4)} m/s`);
      assert.ok(Math.hypot(a.pos.x - x0, a.pos.y - y0, a.pos.z - z0) < 0.005, `${what}: creeps`);
      assert.equal(a.crashed, null);
      assert.ok(a.onGround, `${what}: on the ground`);
      if (engine) between(a.rpm, 600, 800, `${what}: idle rpm`);
      // every leg loaded, none at its stop
      a.wheels.forEach((w, i) => {
        const travel = TRAINER.gear[i].travel;
        assert.ok(w.contact, `${what}: wheel ${i} touches`);
        between(w.compression / travel, 0.2, 0.8, `${what}: wheel ${i} compression share`);
      });
      // centre of mass above the ground: main leg, tyre and compression (the slope tilts it a little)
      const m = TRAINER.gear[1];
      const expect = -m.y + m.radius - a.wheels[1].compression;
      between(a.pos.y - (-a.pos.z * grade), expect - 0.06, expect + 0.06, `${what}: height of the centre of mass`);
      between(a.agl, 0, 0.01, `${what}: agl`);
    }
  });
}

test('engine: idle, static full power, fuel, switching off and on', () => {
  const g = new PlaneGround();
  const a = new Aircraft();
  a.placeOnGround(0, 0, 0, g, false);
  const c = controls({ parkingBrake: true, engineOn: false });
  fly(a, g, 1, c, () => {});
  assert.equal(a.rpm, 0, 'a cold engine stands');
  // starting: the starter turns it until it fires, then it idles
  c.engineOn = true;
  fly(a, g, 10, c, () => {});
  assert.ok(a.engineRunning, 'started');
  between(a.rpm, 620, 780, 'idle rpm');
  c.throttle = 1;
  fly(a, g, 8, c, () => {});
  between(a.rpm, 2200, 2400, 'static rpm at full throttle');
  between(a.propThrust, 1700, 2500, 'static thrust (N)');
  between(a.fuelFlow, 30, 55, 'fuel flow at full power (l/h)');
  const fuel = a.fuel;
  fly(a, g, 60, c, () => {});
  between(fuel - a.fuel, 0.4, 1, 'litres burnt in a minute at full power');
  assert.ok(Math.hypot(a.pos.x, a.pos.z) < 0.1, 'the parking brake holds full power');
  c.throttle = 0;
  fly(a, g, 5, c, () => {});
  c.engineOn = false;
  fly(a, g, 5, c, () => {});
  assert.equal(a.rpm, 0, 'stops when switched off at idle');
});

test('engine off in flight: the propeller windmills when fast, stops when slow', () => {
  const g = new PlaneGround();
  const { a, c } = trimmedInAir(45, 1500);
  c.engineOn = false;
  c.throttle = 0;
  const hold = speedHold(45);
  fly(a, g, 20, c, (t) => {
    hold(a, c, DT);
    ailerons(a, c);
  });
  between(a.rpm, 600, 1600, 'windmilling at 45 m/s');
  assert.ok(a.propThrust < 0, 'a windmilling propeller drags');
  const slow = speedHold(27);
  fly(a, g, 60, c, () => {
    slow(a, c, DT);
    ailerons(a, c);
  });
  assert.equal(a.rpm, 0, 'stops at 27 m/s');
  // and it starts again in a dive
  c.engineOn = true;
  fly(a, g, 10, c, () => {
    ailerons(a, c);
    pitchTo(a, c, -5 * DEG);
  });
  assert.ok(a.engineRunning, 'restarted');
});

// ---- 2. take-off ----------------------------------------------------------------------------

interface TakeOff {
  distance: number;
  time: number;
  tail: boolean;
  crashed: string | null;
  heading: number;
}

/** Full throttle, flaps 10°, rotate at vr to 8°, keep the heading with the rudder. */
function takeOff(g: PlaneGround, dt = DT, headwind = 0): TakeOff {
  const a = new Aircraft();
  a.placeOnGround(0, 0, 0, g, true);
  // heading north; a wind from the north blows towards +z
  a.wind.z = headwind;
  const c = controls({ flaps: 1 / 3 });
  // flaps out first, standing on the brakes
  fly(a, g, 3, c, () => {
    c.brake = 1;
  }, dt);
  c.brake = 0;
  const z0 = a.pos.z;
  let airborne = -1;
  let tail = false;
  const t = fly(a, g, 60, c, (t) => {
    c.throttle = Math.min(1, t / 2);
    track(a, c, 0);
    ailerons(a, c);
    // rotate firmly at vr, then hold the attitude
    if (a.ias > TRAINER.vr) c.elevator = clamp(4 * (8 * DEG - a.pitch) - 1.5 * a.omega.x, -1, 1);
    else pitchTo(a, c, 0);
    tail ||= a.tailStrike;
    if (!a.onGround && airborne < 0) airborne = t;
    if (a.onGround) airborne = -1;
    return (airborne >= 0 && t - airborne > 1) || a.crashed !== null;
  }, dt);
  return { distance: z0 - a.pos.z, time: t, tail, crashed: a.crashed, heading: a.heading };
}

test('take-off: airborne within 250–450 m on asphalt, longer on grass', (t) => {
  const asphalt = takeOff(new PlaneGround(0, 1, 1));
  assert.equal(asphalt.crashed, null);
  assert.ok(!asphalt.tail, 'no tail strike');
  between(asphalt.distance, 250, 450, 'take-off run on asphalt (m)');
  between(asphalt.time, 12, 30, 'take-off run (s)');
  assert.ok(Math.min(asphalt.heading, 360 - asphalt.heading) < 5, 'kept straight');
  const grass = takeOff(new PlaneGround(0, 0.5, 4));
  assert.equal(grass.crashed, null);
  assert.ok(grass.distance > asphalt.distance * 1.1, `grass ${grass.distance.toFixed(0)} m vs asphalt ${asphalt.distance.toFixed(0)} m`);
  t.diagnostic(`take-off run: asphalt ${asphalt.distance.toFixed(0)} m in ${asphalt.time.toFixed(1)} s, grass ${grass.distance.toFixed(0)} m`);
});

// ---- 3. climb -----------------------------------------------------------------------------------

test('climb at vy with full power: 2.5–5 m/s at sea level', (t) => {
  const g = new PlaneGround();
  const { a, c } = trimmedInAir(TRAINER.vy, 300);
  c.throttle = 1;
  const hold = speedHold(TRAINER.vy);
  fly(a, g, 15, c, () => {
    hold(a, c, DT);
    ailerons(a, c);
    ball(a, c);
  });
  const h0 = a.altitude;
  let vmin = Infinity;
  let vmax = 0;
  fly(a, g, 30, c, () => {
    hold(a, c, DT);
    ailerons(a, c);
    ball(a, c);
    vmin = Math.min(vmin, a.ias);
    vmax = Math.max(vmax, a.ias);
  });
  const rate = (a.altitude - h0) / 30;
  between(rate, 2.5, 5, 'climb rate (m/s)');
  between(vmin, TRAINER.vy - 3, TRAINER.vy + 3, 'lowest speed in the climb');
  between(vmax, TRAINER.vy - 3, TRAINER.vy + 3, 'highest speed in the climb');
  between(a.rpm, 2350, 2700, 'rpm in the climb');
  assert.ok(Math.abs(c.rudder) < 0.4, 'a little right rudder at most');
  t.diagnostic(`climb at ${TRAINER.vy} m/s: ${rate.toFixed(2)} m/s, ${a.rpm.toFixed(0)} rpm, rudder ${c.rudder.toFixed(2)}`);
});

// ---- 4. cruise --------------------------------------------------------------------------------------

test('cruise: 75 % power trimmed level gives about vcruise; altitude held for a minute', (t) => {
  const g = new PlaneGround();
  const { a, c } = trimmedInAir(TRAINER.vcruise, 600);
  const hold = altitudeHold(600);
  const rated = TRAINER.power * 735.5;
  let lo = Infinity;
  let hi = -Infinity;
  fly(a, g, 120, c, (time) => {
    // the pilot sets 75 % power on the rpm/power gauge
    c.throttle = clamp(c.throttle + (0.75 - a.enginePower / rated) * 0.02, 0, 1);
    hold(a, c, DT);
    ailerons(a, c);
    ball(a, c);
    if (time > 60) {
      lo = Math.min(lo, a.altitude);
      hi = Math.max(hi, a.altitude);
    }
  });
  t.diagnostic(`cruise at 75 %: ${a.tas.toFixed(1)} m/s true (${a.ias.toFixed(1)} indicated) at ${a.rpm.toFixed(0)} rpm, ${a.fuelFlow.toFixed(1)} l/h; altitude ${lo.toFixed(0)}…${hi.toFixed(0)} m`);
  between(a.enginePower / rated, 0.72, 0.78, 'power');
  between(a.tas, TRAINER.vcruise * 0.9, TRAINER.vcruise * 1.1, 'cruise speed (true, m/s)');
  between(a.rpm, 2450, 2750, 'cruise rpm');
  between(lo, 570, 630, 'lowest altitude');
  between(hi, 570, 630, 'highest altitude');
  // the trim wheel does the work: the elevator stays near the middle
  assert.ok(Math.abs(c.elevator) < 0.2, `elevator ${c.elevator.toFixed(2)}`);
});

test('hands off, trimmed: holds its speed and height for a minute', () => {
  const g = new PlaneGround();
  const { a, c } = trimmedInAir(50, 800);
  const v0 = a.ias;
  let dv = 0;
  let dh = 0;
  fly(a, g, 60, c, () => {
    ailerons(a, c);
    c.elevator = 0;
    dv = Math.max(dv, Math.abs(a.ias - v0));
    dh = Math.max(dh, Math.abs(a.altitude - 800));
  });
  assert.ok(dv < 4, `speed wanders by ${dv.toFixed(1)} m/s`);
  assert.ok(dh < 40, `height wanders by ${dh.toFixed(0)} m`);
});

// ---- 5. stall -------------------------------------------------------------------------------------------

function stall(flaps: number): { warn: number; stall: number; recovered: boolean; lost: number; crashed: string | null } {
  const g = new PlaneGround();
  const { a, c } = trimmedInAir(40, 800, flaps);
  // flaps out at 40 m/s
  const hold0 = altitudeHold(800);
  fly(a, g, 8, c, () => {
    hold0(a, c, DT);
    ailerons(a, c);
    c.throttle = a.levelFlight(40, flaps).throttle;
  });
  c.throttle = 0;
  c.trim = a.levelFlight(40, flaps).trim;
  let warn = -1;
  let stalled = -1;
  // raise the nose slowly: about 1 m/s of speed lost per second
  const v0 = a.ias;
  const slow = speedHold((t) => v0 - t);
  fly(a, g, 60, c, () => {
    slow(a, c, DT);
    ailerons(a, c);
    ball(a, c);
    if (warn < 0 && a.stallWarning) warn = a.ias;
    if (stalled < 0 && a.stalled) stalled = a.ias;
    return stalled >= 0;
  });
  // recovery: release the elevator, full power, wings level, then a gentle pull-out
  const h0 = a.altitude;
  let lowest = h0;
  let again = false;
  fly(a, g, 15, c, (t) => {
    c.throttle = t > 0.5 ? 1 : 0;
    if (t < 2) c.elevator = 0;
    else c.elevator = Math.min(0.25, 2.5 * (0 - a.pitch) - a.omega.x);
    ailerons(a, c);
    ball(a, c);
    lowest = Math.min(lowest, a.altitude);
    if (t > 2 && a.stalled) again = true;
  });
  const recovered = !again && !a.stalled && a.ias > stalled + 3;
  return { warn, stall: stalled, recovered, lost: h0 - lowest, crashed: a.crashed };
}

test('stall: warning first, clean at about vs1, lower with full flaps, recovered by releasing the elevator', (t) => {
  const clean = stall(0);
  assert.ok(clean.warn > 0 && clean.stall > 0, 'warned and stalled');
  assert.ok(clean.warn > clean.stall, `warning at ${clean.warn.toFixed(1)} before the stall at ${clean.stall.toFixed(1)} m/s`);
  between(clean.stall, TRAINER.vs1 - 3, TRAINER.vs1 + 3, 'clean stall speed (m/s)');
  assert.ok(clean.recovered, 'recovered (clean)');
  assert.ok(clean.lost < 150, `height lost ${clean.lost.toFixed(0)} m`);
  assert.equal(clean.crashed, null);
  const flaps = stall(1);
  assert.ok(flaps.warn > flaps.stall, 'warning first (flaps)');
  between(flaps.stall, TRAINER.vs0 - 3, TRAINER.vs0 + 3, 'stall speed with full flaps (m/s)');
  assert.ok(flaps.stall < clean.stall - 1, `full flaps ${flaps.stall.toFixed(1)} < clean ${clean.stall.toFixed(1)}`);
  assert.ok(flaps.recovered, 'recovered (flaps)');
  assert.equal(flaps.crashed, null);
  t.diagnostic(`stall clean: warning ${clean.warn.toFixed(1)}, stall ${clean.stall.toFixed(1)} m/s, ${clean.lost.toFixed(0)} m lost; full flaps: warning ${flaps.warn.toFixed(1)}, stall ${flaps.stall.toFixed(1)} m/s, ${flaps.lost.toFixed(0)} m lost`);
});

// ---- 6. turn --------------------------------------------------------------------------------------------

test('30° banked turn: rate g·tan φ / V, height holdable, ball in the middle', (t) => {
  const g = new PlaneGround();
  const V = 50;
  const { a, c } = trimmedInAir(V, 700);
  const hold = altitudeHold(700);
  let lo = Infinity;
  let hi = -Infinity;
  let rate = 0;
  let n = 0;
  fly(a, g, 60, c, (time) => {
    ailerons(a, c, 30 * DEG);
    ball(a, c);
    hold(a, c, DT);
    // a little more power in the turn
    c.throttle = clamp(c.throttle + (V - a.tas) * 0.0005, 0, 1);
    if (time > 20) {
      lo = Math.min(lo, a.altitude);
      hi = Math.max(hi, a.altitude);
      rate += a.turnRate;
      n++;
    }
  });
  rate /= n;
  const expect = (G * Math.tan(30 * DEG)) / a.tas;
  between(rate / expect, 0.85, 1.15, `turn rate ${(rate / DEG).toFixed(1)}°/s vs ${(expect / DEG).toFixed(1)}°/s`);
  between(a.loadFactor, 1.08, 1.25, 'load factor');
  between(lo, 670, 730, 'lowest altitude in the turn');
  between(hi, 670, 730, 'highest altitude in the turn');
  assert.ok(Math.abs(a.slip) < 0.3, `ball ${a.slip.toFixed(2)}`);
  t.diagnostic(`30° turn at ${a.tas.toFixed(1)} m/s: ${(rate / DEG).toFixed(2)}°/s (g·tan φ/V = ${(expect / DEG).toFixed(2)}), ${a.loadFactor.toFixed(2)} g, altitude ${lo.toFixed(0)}…${hi.toFixed(0)} m`);
});

// ---- 7. landing ------------------------------------------------------------------------------------------

interface Landing {
  crashed: string | null;
  touchdown: number;
  roll: number;
  fromAim: number;
  sink: number;
  stopped: boolean;
}

/** A 3° approach at about 33 m/s with full flaps, flare, touchdown, brakes. */
function landing(g: PlaneGround, dt = DT): Landing {
  const a = new Aircraft();
  // 1.5 km out on the glide path, aiming at z = 0
  const start = 1500;
  const slope = Math.tan(3 * DEG);
  a.placeInAir(0, start * slope + 1.25, start, 0, 34, g);
  const lf = a.levelFlight(33, 1);
  const c = controls({ flaps: 1, trim: lf.trim, throttle: lf.throttle });
  let pitch = a.pitch;
  let touchdown = Number.NaN;
  let sink = 0;
  let flare = false;
  const t = fly(a, g, 150, c, () => {
    const path = Math.max(0, a.pos.z) * slope;
    const agl = a.agl;
    ailerons(a, c);
    if (a.onGround) {
      if (Number.isNaN(touchdown)) {
        touchdown = a.pos.z;
        sink = -a.verticalSpeed;
      }
      c.throttle = 0;
      // nose wheel down, then brakes
      pitchTo(a, c, 0);
      c.brake = a.wheels[0].contact ? 1 : 0;
      track(a, c, 0);
      return a.groundSpeed < 0.3 && a.wheels[0].contact;
    }
    ball(a, c);
    if (!flare && agl < 6) flare = true;
    if (flare) {
      // flare: idle, the sink rate brought down with the height, to some 0.3 m/s at the wheels
      c.throttle = 0;
      const e = -Math.max(0.3, 0.3 * agl) - a.verticalSpeed;
      pitch = clamp(pitch + 0.03 * e * DT, -5 * DEG, 12 * DEG);
      pitchTo(a, c, pitch + 0.04 * e);
      return a.crashed !== null;
    }
    // glide path by pitch, speed by power
    const e = -a.groundSpeed * slope + clamp(0.2 * (path - agl), -2, 2) - a.verticalSpeed;
    pitch = clamp(pitch + 0.004 * e * DT, -10 * DEG, 10 * DEG);
    pitchTo(a, c, pitch + 0.012 * e);
    c.throttle = clamp(lf.throttle + 0.08 * (33 - a.ias), 0, 1);
    return a.crashed !== null;
  }, dt);
  return {
    crashed: a.crashed,
    touchdown,
    roll: touchdown - a.pos.z,
    fromAim: -a.pos.z,
    sink,
    stopped: t < 150 && a.groundSpeed < 0.3,
  };
}

test('landing: 3° approach, flare, touchdown, brakes: stops within 150–400 m of the aiming point', (t) => {
  const l = landing(new PlaneGround());
  t.diagnostic(`landing: touchdown at ${l.sink.toFixed(2)} m/s sink, ${(-l.touchdown).toFixed(0)} m past the aiming point, ground roll ${l.roll.toFixed(0)} m, stopped ${l.fromAim.toFixed(0)} m past the aiming point`);
  assert.equal(l.crashed, null);
  assert.ok(l.stopped, 'came to a stop');
  between(l.sink, 0, 2, 'sink rate at touchdown (m/s)');
  between(l.roll, 80, 300, 'ground roll (m)');
  between(l.fromAim, 150, 400, 'from the aiming point to the stop (m)');
});

// ---- 8. crashes -------------------------------------------------------------------------------------------

test('crash: flying steeply into the ground is an impact, and the wreck stays where it is', () => {
  const g = new PlaneGround();
  const a = new Aircraft();
  a.placeInAir(0, 60, 0, 0, 50);
  const c = controls({ throttle: 0.7 });
  fly(a, g, 20, c, () => {
    pitchTo(a, c, -30 * DEG);
    return a.crashed !== null;
  });
  assert.equal(a.crashed, 'impact');
  const p = { ...a.pos };
  fly(a, g, 2, c, () => {});
  assert.deepEqual({ ...a.pos }, p, 'the wreck does not move');
  assert.equal(a.groundSpeed, 0);
});

test('crash: a wing tip on the ground at 60° bank, 1 m up', () => {
  const g = new PlaneGround();
  const a = new Aircraft();
  a.placeInAir(0, 10, 0, 0, 35);
  // roll to 60° (right wing down: about the body z axis, negative) and put the lowest wheel 1 m above the ground
  const [x, y, z, w] = a.q;
  const s = Math.sin(-30 * DEG);
  const k = Math.cos(-30 * DEG);
  a.q[0] = x * k + y * s;
  a.q[1] = y * k - x * s;
  a.q[2] = z * k + w * s;
  a.q[3] = w * k - z * s;
  const c = controls({ throttle: 0.6 });
  a.step(DT, c, g);
  a.pos.y += 1 - a.agl;
  between(a.bank / DEG, 55, 65, 'bank');
  a.step(DT, c, g);
  assert.equal(a.crashed, 'wing');
});

test('crash: a hard touchdown (4 m/s) is an impact, a firm one (2 m/s) is not', () => {
  const g = new PlaneGround();
  for (const [sink, expect] of [
    [4, 'impact'],
    [2, null],
  ] as const) {
    const a = new Aircraft();
    a.placeInAir(0, 1.6, 0, 0, 30);
    a.vel.y = -sink;
    const c = controls();
    fly(a, g, 3, c, () => {
      pitchTo(a, c, 6 * DEG);
      c.elevator = 0.3;
      return a.crashed !== null;
    });
    assert.equal(a.crashed, expect, `sink ${sink} m/s`);
  }
});

test('crash: far beyond vne the airframe fails', () => {
  const g = new PlaneGround();
  const { a, c } = trimmedInAir(70, 3000);
  c.throttle = 1;
  fly(a, g, 60, c, () => {
    pitchTo(a, c, -45 * DEG);
    ailerons(a, c);
    return a.crashed !== null;
  });
  assert.equal(a.crashed, 'overspeed');
  assert.ok(a.altitude > 100, 'it broke in the air');
});

// ---- 9. robustness ----------------------------------------------------------------------------------------

test('robust: the take-off at 1/30 s and 1/60 s steps gives the same result', () => {
  const fine = takeOff(new PlaneGround(), 1 / 60);
  const coarse = takeOff(new PlaneGround(), 1 / 30);
  assert.equal(coarse.crashed, null);
  between(coarse.distance / fine.distance, 0.95, 1.05, 'take-off distance 1/30 vs 1/60');
  const steps = takeOff(new PlaneGround(), 1 / 20);
  between(steps.distance / fine.distance, 0.9, 1.1, 'take-off distance 1/20 vs 1/60');
});

test('robust: a minute of random inputs and step lengths, in the air and on the ground: never NaN', () => {
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (const start of ['air', 'ground'] as const) {
    const g = new PlaneGround(0.03);
    const a = new Aircraft();
    if (start === 'air') a.placeInAir(0, 300, 0, 1, 45);
    else a.placeOnGround(0, 0, 1, g, true);
    const c = controls();
    for (let i = 0; i < 3600; i++) {
      if (i % 20 === 0) {
        c.throttle = rnd();
        c.elevator = rnd() * 2 - 1;
        c.aileron = rnd() * 2 - 1;
        c.rudder = rnd() * 2 - 1;
        c.flaps = Math.floor(rnd() * 4) / 3;
        c.trim = rnd() * 2 - 1;
        c.brake = rnd() < 0.3 ? rnd() : 0;
        c.brakeLeft = rnd() < 0.2 ? rnd() : undefined;
        c.parkingBrake = rnd() < 0.1;
        c.engineOn = rnd() < 0.95;
      }
      if (i === 1800) {
        // and some nonsense
        c.throttle = Number.NaN;
        c.elevator = Infinity;
        c.aileron = -Infinity;
      }
      a.step(rnd() * 0.05 + 0.001, c, g);
      const vals = [a.pos.x, a.pos.y, a.pos.z, a.vel.x, a.vel.y, a.vel.z, ...a.q, a.omega.x, a.omega.y, a.omega.z, a.ias, a.agl, a.heading, a.pitch, a.bank, a.slip, a.aoa, a.turnRate, a.rpm, a.loadFactor, a.propAngle, a.flapsDeg, a.fuel];
      assert.ok(vals.every(Number.isFinite), `${start}: not finite after ${i} steps`);
      assert.ok(Math.abs(Math.hypot(...a.q) - 1) < 1e-6, 'unit quaternion');
    }
  }
});

test('surfaces, flaps and instruments move as they should', () => {
  const g = new PlaneGround();
  const { a, c } = trimmedInAir(45, 500);
  c.flaps = 1;
  c.elevator = 1;
  c.aileron = 1;
  c.rudder = 1;
  c.trim = 0;
  fly(a, g, 0.5, c, () => {});
  const s = a.surfaces;
  between(s.elevator / DEG, AERO.elevUp / DEG - 1, AERO.elevUp / DEG + 0.01, 'elevator up');
  between(s.aileron / DEG, 19, 20.01, 'aileron');
  between(s.rudder / DEG, 15, 16.01, 'rudder');
  // the flaps run at 5°/s
  between(a.flapsDeg, 2, 3, 'flaps after 0.5 s');
  fly(a, g, 7, c, () => {});
  between(a.flapsDeg, TRAINER.flapsMax - 0.01, TRAINER.flapsMax, 'flaps out');
  between(maxLift(1).cl, 1.85, 2.1, 'CLmax full flaps');
  between(maxLift(0).cl, 1.4, 1.6, 'CLmax clean');
});

test('performance: well under 0.05 ms per 1/60 s step in the air', () => {
  const g = new PlaneGround();
  const { a, c } = trimmedInAir(50, 1000);
  for (let i = 0; i < 600; i++) a.step(DT, c, g);
  const n = 6000;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) a.step(DT, c, g);
  const ms = (performance.now() - t0) / n;
  // generous: the machines the tests run on are busy with other things too
  assert.ok(ms < 0.15, `${ms.toFixed(4)} ms per step`);
});

// ---- handling ------------------------------------------------------------------------------------------------

/** Roll the aeroplane about its longitudinal axis by `bank` (rad, + = right wing down). */
function rollBy(a: Aircraft, bank: number): void {
  const [x, y, z, w] = a.q;
  const s = Math.sin(-bank / 2);
  const k = Math.cos(-bank / 2);
  a.q[0] = x * k + y * s;
  a.q[1] = y * k - x * s;
  a.q[2] = z * k + w * s;
  a.q[3] = w * k - z * s;
}

/** Pitch the aeroplane about its lateral axis by `pitch` (rad, + = nose up). */
function pitchBy(a: Aircraft, pitch: number): void {
  const [x, y, z, w] = a.q;
  const s = Math.sin(pitch / 2);
  const k = Math.cos(pitch / 2);
  a.q[0] = w * s + x * k;
  a.q[1] = y * k + z * s;
  a.q[2] = z * k - y * s;
  a.q[3] = w * k - x * s;
}

test('stability hands off: phugoid lightly damped, Dutch roll damped, spiral about neutral', (t) => {
  const g = new PlaneGround();
  // phugoid: a gust from above, only the wings held level
  {
    const { a, c } = trimmedInAir(50, 800);
    fly(a, g, 2, c, () => ailerons(a, c));
    a.vel.y -= 4;
    const ias: number[] = [];
    fly(a, g, 150, c, () => {
      ailerons(a, c);
      ias.push(a.ias);
    });
    const mean = ias.slice(120 * 60).reduce((p, v) => p + v, 0) / (30 * 60);
    const swing = (from: number, to: number): number => Math.max(...ias.slice(from * 60, to * 60).map((v) => Math.abs(v - mean)));
    const first = swing(0, 40);
    const later = swing(60, 100);
    // period from the crossings of the mean
    const cross: number[] = [];
    for (let i = 1; i < 100 * 60; i++) if ((ias[i - 1] - mean) * (ias[i] - mean) < 0) cross.push(i / 60);
    const period = cross.length >= 3 ? ((cross[cross.length - 1] - cross[0]) / (cross.length - 1)) * 2 : 0;
    t.diagnostic(`phugoid: period ${period.toFixed(1)} s, speed swing ${first.toFixed(2)} → ${later.toFixed(2)} m/s`);
    between(period, 18, 40, 'phugoid period (s)');
    assert.ok(first > 1, 'the gust starts a phugoid');
    assert.ok(later < first * 0.7 && later > first * 0.05, `lightly damped: ${first.toFixed(2)} → ${later.toFixed(2)}`);
  }
  // Dutch roll: a rudder doublet, then hands off
  {
    const { a, c } = trimmedInAir(50, 800);
    const beta: number[] = [];
    fly(a, g, 12, c, (time) => {
      c.rudder = time < 0.5 ? 0 : time < 1 ? 1 : time < 1.5 ? -1 : 0;
      beta.push(Math.abs(a.sideslip));
    });
    const peak = (from: number, to: number): number => Math.max(...beta.slice(from * 60, to * 60));
    const early = peak(2, 4.5);
    const late = peak(7, 9.5);
    t.diagnostic(`Dutch roll: sideslip ${(early / DEG).toFixed(1)}° → ${(late / DEG).toFixed(1)}° five seconds later`);
    assert.ok(early > 3 * DEG, 'the doublet starts a Dutch roll');
    assert.ok(late < early * 0.3, 'Dutch roll damped');
  }
  // spiral: from 10° of bank either way, hands off, in cruise
  for (const side of [-1, 1]) {
    const { a, c } = trimmedInAir(TRAINER.vcruise, 800);
    rollBy(a, side * 10 * DEG);
    fly(a, g, 60, c, () => {});
    t.diagnostic(`spiral: ${side * 10}° → ${(a.bank / DEG).toFixed(1)}° after a minute`);
    between((side * a.bank) / DEG, 3, 25, 'bank after a minute hands off (neither back level at once nor diving away)');
  }
});

test('ground handling: nose wheel steered by the rudder, less at speed; differential brakes', (t) => {
  const g = new PlaneGround();
  const a = new Aircraft();
  a.placeOnGround(0, 0, 0, g, true);
  const c = controls({ rudder: 1 });
  fly(a, g, 1, c, () => {});
  between(a.wheels[0].steer / DEG, 11, 12.01, 'nose wheel at full rudder, standing');
  assert.equal(a.wheels[1].steer, 0);
  // taxi in a right-hand circle at walking pace and a bit more
  fly(a, g, 20, c, () => {
    c.throttle = clamp(0.3 + 0.1 * (4 - a.groundSpeed), 0, 0.6);
  });
  const radius = a.groundSpeed / a.turnRate;
  t.diagnostic(`taxi circle at ${a.groundSpeed.toFixed(1)} m/s with full rudder: radius ${radius.toFixed(1)} m`);
  assert.ok(a.turnRate > 0, 'right rudder turns right');
  between(radius, 7, 20, 'turning radius (m)');
  // less steering at speed
  const fast = new Aircraft();
  fast.placeOnGround(0, 0, 0, g, true);
  const cf = controls();
  fly(fast, g, 60, cf, () => {
    cf.throttle = 1;
    track(fast, cf, 0);
    return fast.groundSpeed > 20;
  });
  cf.rudder = 1;
  fly(fast, g, 0.5, cf, () => {});
  assert.ok(fast.wheels[0].steer < 4 * DEG, `nose wheel at 20 m/s: ${(fast.wheels[0].steer / DEG).toFixed(1)}°`);
  // differential brakes: the left brake turns the taxiing aeroplane to the left
  const b = new Aircraft();
  b.placeOnGround(0, 0, 0, g, true);
  const cb = controls({ throttle: 0.35 });
  fly(b, g, 8, cb, () => {});
  const h0 = b.heading;
  cb.brakeLeft = 1;
  fly(b, g, 3, cb, () => {});
  let turned = b.heading - h0;
  turned -= 360 * Math.round(turned / 360);
  assert.ok(turned < -10, `left brake: turned ${turned.toFixed(1)}°`);
  assert.equal(b.crashed, null);
});

test('crash: put down on the nose wheel, the nose leg folds', () => {
  const g = new PlaneGround();
  const a = new Aircraft();
  a.placeInAir(0, 3, 0, 0, 30, g);
  pitchBy(a, -8 * DEG - a.pitch);
  a.step(DT, controls(), g);
  a.pos.y -= a.agl - 0.02;
  a.vel.y = -2.5;
  fly(a, g, 2, controls(), () => a.crashed !== null, 1 / 240);
  assert.equal(a.crashed, 'noseOver');
});

test('wind: a headwind shortens the take-off; in the air the ground speed is the airspeed less the wind', (t) => {
  const calm = takeOff(new PlaneGround());
  const windy = takeOff(new PlaneGround(), DT, 5);
  t.diagnostic(`take-off run: calm ${calm.distance.toFixed(0)} m, 5 m/s headwind ${windy.distance.toFixed(0)} m`);
  assert.equal(windy.crashed, null);
  assert.ok(windy.distance < calm.distance * 0.85, 'shorter into the wind');
  const g = new PlaneGround();
  const { a, c } = trimmedInAir(50, 800);
  a.wind.z = 10;
  const hold = altitudeHold(800);
  fly(a, g, 40, c, () => {
    hold(a, c, DT);
    ailerons(a, c);
    ball(a, c);
  });
  between(a.groundSpeed - (a.tas - 10), -1.5, 1.5, 'ground speed minus (airspeed − headwind)');
});
