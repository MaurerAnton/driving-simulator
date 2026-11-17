// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The autopilot and the assist of the light aeroplane (src/sim/autopilot.ts),
 * flown headless on the flight model (src/sim/flight.ts) at fixed steps, the
 * way tests/vehicle/flight.test.ts flies it.
 *
 * The expectations are those of a flying school: the take-off on the centre
 * line, rotation at vr, flaps up after the climb has begun; heading and
 * height held within ±5° and ±50 ft; the circuit with its legs; a stable
 * approach, a touchdown on the main wheels at well under 2 m/s and a stop on
 * the runway – or a go-around when the approach is not stable at 100 ft.
 * For the assist: what a beginner does with the keys (the stick pulled or
 * rolled all the way and let go) must not stall the aeroplane, overstress it
 * or leave it in a steepening turn.
 *
 *   node --test tests/vehicle/autopilot.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AirfieldGround, runwayStart } from '../../src/sim/airfield.ts';
import { ASSIST, ASSIST_BEGINNER, ASSIST_LIGHT, AUTOPILOT, FlightAssist, FlightAutopilot, landingRunway, runwayAt } from '../../src/sim/autopilot.ts';
import type { AutopilotWaypoint, StickInput } from '../../src/sim/autopilot.ts';
import { Aircraft } from '../../src/sim/flight.ts';
import type { FlightControls } from '../../src/sim/flight.ts';
import { TRAINER } from '../../src/sim/flightspec.ts';
import type { Ground, GroundSample } from '../../src/sim/vehicle/types.ts';
import type { AirfieldJson } from '../../src/world/types.ts';
import { PlaneGround } from './harness.ts';

const DT = 1 / 60;
const DEG = Math.PI / 180;
const FT = 0.3048;

const between = (v: number, lo: number, hi: number, what: string): void => {
  assert.ok(v >= lo && v <= hi, `${what}: ${v.toFixed(3)} not in [${lo}, ${hi}]`);
};
const wrap180 = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180;

/** Level ground at a height: mown grass. */
function level(y: number): Ground {
  return {
    sample(_x: number, _z: number, _y: number, out: GroundSample): void {
      out.y = y;
      out.nx = 0;
      out.ny = 1;
      out.nz = 0;
      out.grip = 0.6;
      out.rolling = 3;
    },
  };
}

/** An airfield with one runway "09/27" from (0, 0) eastwards: x is the way along it, z the way across (+ south, to the right of 09). */
function airfield(len = 1000, surface = 'asphalt'): AirfieldJson {
  return { name: 'Testfeld', icao: 'EDXX', kind: 'airport', x: len / 2, z: 0, runways: [{ ref: '09/27', x1: 0, z1: 0, x2: len, z2: 0, w: 30, s: surface }], taxiways: [], aprons: [] };
}

interface Log {
  /** seconds flown */
  time: number;
  crashed: string | null;
  stalled: boolean;
  /** seconds the stall warning sounded */
  warning: number;
  /** greatest bank off the ground (rad) */
  maxBank: number;
  tailStrike: boolean;
  /** the phases in the order they came */
  phases: string[];
  /** the first touch of a main wheel: where, how fast it sank (m/s) */
  touchdown: { x: number; z: number; sink: number } | null;
}

/**
 * Fly with the autopilot until it is done (standing still after a landing),
 * the aeroplane crashes, `seconds` have passed or `each` returns true.
 */
function fly(a: Aircraft, ap: FlightAutopilot, g: Ground, seconds: number, each?: (t: number) => boolean | void, dt = DT): Log {
  const log: Log = { time: 0, crashed: null, stalled: false, warning: 0, maxBank: 0, tailStrike: false, phases: [], touchdown: null };
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    log.time = t;
    if (each?.(t) === true) break;
    const vy = a.verticalSpeed;
    const main = a.wheels[1].contact || a.wheels[2].contact;
    a.step(dt, ap.update(a, dt, g), g);
    if (!main && (a.wheels[1].contact || a.wheels[2].contact) && log.touchdown === null && log.phases.includes('final')) log.touchdown = { x: a.pos.x, z: a.pos.z, sink: -vy };
    const p = ap.state.phase;
    if (log.phases[log.phases.length - 1] !== p) log.phases.push(p);
    if (!a.onGround) log.maxBank = Math.max(log.maxBank, Math.abs(a.bank));
    if (a.stalled) log.stalled = true;
    if (a.stallWarning) log.warning += dt;
    if (a.crashed || ap.state.done) break;
  }
  log.crashed = a.crashed;
  log.tailStrike = a.tailStrike;
  return log;
}

/** The phases in `want` come in this order in `got` (others may lie between). */
function inOrder(got: readonly string[], want: readonly string[]): boolean {
  let i = 0;
  for (const p of got) if (p === want[i]) i++;
  return i === want.length;
}

/** Standing on the runway of `airfield(len)`: between its ends, within its width. */
function onRunway(a: Aircraft, len: number, what: string): void {
  between(a.pos.x, 0, len, `${what}: stopped along the runway (m)`);
  between(a.pos.z, -15, 15, `${what}: stopped across the runway (m)`);
  assert.ok(a.groundSpeed < 0.5 && a.onGround, `${what}: standing`);
}

function inAir(x: number, height: number, z: number, heading: number, speed: number, g: Ground): Aircraft {
  const a = new Aircraft();
  a.placeInAir(x, height, z, -heading * DEG, speed, g);
  return a;
}

// ---- 1. take-off ------------------------------------------------------------------------------------

test('take-off: on the centre line, rotation at vr, flaps up, 1000 ft above the field without a stall – then it holds the departure height', (t) => {
  const f = airfield();
  const g = new AirfieldGround(level(0), [f]);
  const r = f.runways[0];
  const sp = runwayStart(r, false);
  const a = new Aircraft();
  a.placeOnGround(sp.x, sp.z, sp.yaw, g, true);
  const ap = new FlightAutopilot();
  ap.takeoff(r, false);
  let rotate = Number.NaN;
  let liftoff = Number.NaN;
  let offRoll = 0;
  let at1000 = Number.NaN;
  let flapsUp = Number.NaN;
  let maxBankLow = 0;
  let holding = Number.NaN;
  let holdLo = Infinity;
  let holdHi = -Infinity;
  const log = fly(a, ap, g, 400, (time) => {
    if (ap.state.phase === 'rotate' && Number.isNaN(rotate)) rotate = a.ias;
    if (a.onGround) offRoll = Math.max(offRoll, Math.abs(a.pos.z));
    else if (Number.isNaN(liftoff)) liftoff = a.pos.x;
    if (!a.onGround && a.agl < 1000 * FT) maxBankLow = Math.max(maxBankLow, Math.abs(a.bank));
    if (Number.isNaN(flapsUp) && ap.state.flapNotch === 0 && !a.onGround) flapsUp = a.agl;
    if (Number.isNaN(at1000) && a.agl >= 1000 * FT) at1000 = time;
    if (Number.isNaN(holding) && ap.state.mode === 'hold') holding = time;
    if (!Number.isNaN(holding)) {
      holdLo = Math.min(holdLo, a.agl);
      holdHi = Math.max(holdHi, a.agl);
    }
    return time > holding + 60;
  });
  t.diagnostic(`take-off: rotation at ${rotate.toFixed(1)} m/s, lift-off ${(liftoff - sp.x).toFixed(0)} m from the start, ${offRoll.toFixed(1)} m off the centre line, flaps up at ${flapsUp.toFixed(0)} m, 1000 ft after ${at1000.toFixed(0)} s, then ${holdLo.toFixed(0)}…${holdHi.toFixed(0)} m for a minute`);
  assert.equal(log.crashed, null);
  assert.ok(!log.stalled, 'never stalled');
  assert.equal(log.warning, 0, 'the stall warning never sounded');
  assert.ok(!log.tailStrike, 'no tail strike');
  assert.ok(inOrder(log.phases, ['lineup', 'takeoffRoll', 'rotate', 'initialClimb', 'climb', 'cruise']), log.phases.join(' '));
  between(rotate, TRAINER.vr - 0.5, TRAINER.vr + 1.5, 'rotation speed (m/s)');
  between(liftoff, sp.x + 250, r.x2 - 300, 'lift-off point, well within the runway (m)');
  assert.ok(offRoll < 3, `on the centre line (${offRoll.toFixed(1)} m off)`);
  between(flapsUp, AUTOPILOT.flapsUp - 5, 200, 'flaps up (m above the ground)');
  assert.ok(maxBankLow < 5 * DEG, 'wings level in the climb');
  assert.ok(at1000 < 150, `1000 ft above the field after ${at1000.toFixed(0)} s`);
  // then: holding the height it climbs to (1500 ft above the field), on the runway's heading
  const target = AUTOPILOT.departHeight;
  between(holdLo, target - 50 * FT, target + 50 * FT, 'height held after the climb, lowest (m)');
  between(holdHi, target - 50 * FT, target + 50 * FT, 'height held after the climb, highest (m)');
  assert.ok(Math.abs(wrap180(a.heading - 90)) < 5, `heading ${a.heading.toFixed(1)}`);
});

// ---- 2. heading and height hold ------------------------------------------------------------------------

test('heading hold: turns the shorter way to a new heading, holds it within ±5° and the height within ±50 ft', (t) => {
  const g = level(0);
  const a = inAir(0, 600, 0, 0, 50, g);
  const ap = new FlightAutopilot();
  for (const [heading, side] of [
    [120, 1],
    [330, -1],
    [140, 1],
  ] as const) {
    ap.hold(heading, 600);
    let first = 0;
    let lo = Infinity;
    let hi = -Infinity;
    let off = 0;
    const log = fly(a, ap, g, 90, (time) => {
      if (time > 2 && first === 0 && Math.abs(a.turnRate) > 1 * DEG) first = Math.sign(a.turnRate);
      lo = Math.min(lo, a.altitude);
      hi = Math.max(hi, a.altitude);
      if (time > 45) off = Math.max(off, Math.abs(wrap180(a.heading - heading)));
    });
    t.diagnostic(`to ${heading}°: turned ${first > 0 ? 'right' : 'left'}, height ${lo.toFixed(1)}…${hi.toFixed(1)} m, heading within ${off.toFixed(1)}° after 45 s, bank up to ${(log.maxBank / DEG).toFixed(1)}°`);
    assert.equal(log.crashed, null);
    assert.ok(!log.stalled);
    assert.equal(first, side, `to ${heading}°: the shorter way`);
    assert.ok(off < 5, `to ${heading}°: heading held (${off.toFixed(1)}° off)`);
    between(lo, 600 - 50 * FT, 600 + 50 * FT, 'lowest height');
    between(hi, 600 - 50 * FT, 600 + 50 * FT, 'highest height');
    assert.ok(log.maxBank < AUTOPILOT.bankMax + 0.5 * DEG, `bank ${(log.maxBank / DEG).toFixed(1)}°`);
    assert.equal(ap.state.phase, 'cruise');
    assert.equal(ap.state.targetHeading, heading);
  }
});

test('height changes: a climb at full power and climb speed, a descent at a few m/s, each ended without overshooting by more than 50 ft', (t) => {
  const g = level(0);
  const a = inAir(0, 600, 0, 0, 50, g);
  const ap = new FlightAutopilot();
  for (const target of [1200, 400]) {
    ap.hold(0, target);
    let vertical = '';
    let over = 0;
    let h20 = 0;
    let h60 = 0;
    const climb = target > a.altitude;
    const log = fly(a, ap, g, 400, (time) => {
      if (Math.abs(time - 5) < DT / 2) vertical = ap.state.vertical;
      if (Math.abs(time - 20) < DT / 2) h20 = a.altitude;
      if (Math.abs(time - 60) < DT / 2) h60 = a.altitude;
      over = Math.max(over, climb ? a.altitude - target : target - a.altitude);
      return time > 60 && Math.abs(a.altitude - target) < 3 && Math.abs(a.verticalSpeed) < 0.3;
    });
    // (the rate once settled: in the first seconds a climb also trades the speed for height)
    const rate = (h60 - h20) / 40;
    t.diagnostic(`to ${target} m: ${vertical} at ${rate.toFixed(2)} m/s, there after ${log.time.toFixed(0)} s, overshoot ${over.toFixed(1)} m`);
    assert.equal(log.crashed, null);
    assert.ok(!log.stalled && log.warning === 0);
    assert.equal(vertical, climb ? 'climb' : 'descend');
    assert.ok(over < 50 * FT, `overshoot ${over.toFixed(1)} m`);
    if (climb) between(rate, 2.5, 5, 'climb rate (m/s)');
    else between(rate, -AUTOPILOT.vsDown - 0.3, -2.5, 'descent rate (m/s)');
    assert.ok(log.time < 399, 'arrived');
  }
});

// ---- 3. to a place, and round it --------------------------------------------------------------------------

test('goto: flies to a place 5 km away and circles it at its radius and height', (t) => {
  const g = level(0);
  const a = inAir(0, 600, 0, 0, 50, g);
  const ap = new FlightAutopilot();
  ap.goto(3000, -4000, 800);
  let arrived = Number.NaN;
  let rMin = Infinity;
  let rMax = 0;
  let hOff = 0;
  const log = fly(a, ap, g, 400, (time) => {
    if (Number.isNaN(arrived) && ap.state.phase === 'orbit') arrived = time;
    if (!Number.isNaN(arrived) && time > arrived + 60) {
      const r = Math.hypot(a.pos.x - 3000, a.pos.z + 4000);
      rMin = Math.min(rMin, r);
      rMax = Math.max(rMax, r);
      hOff = Math.max(hOff, Math.abs(a.altitude - 800));
    }
  });
  t.diagnostic(`goto: circling after ${arrived.toFixed(0)} s, radius ${rMin.toFixed(0)}…${rMax.toFixed(0)} m, height within ${hOff.toFixed(1)} m`);
  assert.equal(log.crashed, null);
  assert.ok(!log.stalled);
  assert.ok(arrived < 150, `there after ${arrived.toFixed(0)} s (5 km at some 50 m/s and a climb)`);
  between(rMin, AUTOPILOT.orbit - 100, AUTOPILOT.orbit + 100, 'smallest distance from the place while circling (m)');
  between(rMax, AUTOPILOT.orbit - 100, AUTOPILOT.orbit + 100, 'greatest distance from the place while circling (m)');
  assert.ok(hOff < 50 * FT, 'height held while circling');
  assert.deepEqual(ap.state.waypoint, { x: 3000, z: -4000 });
  assert.ok(log.maxBank < AUTOPILOT.bankMax + 0.5 * DEG);
});

// ---- 4. landing ------------------------------------------------------------------------------------------------

test('landing on a 1000 m runway: from every side into the circuit (or straight in), touchdown on the main wheels, stopped on the runway', (t) => {
  const f = airfield();
  const g = new AirfieldGround(level(0), [f]);
  const r = f.runways[0];
  for (const [x, z, h, heading, how] of [
    [-5000, 3000, 305, 90, 'from the south-west: base'],
    [500, -6000, 305, 180, 'from the north: downwind'],
    [8000, 500, 305, 270, 'from beyond the far end: downwind'],
    [-8000, 200, 400, 90, 'from far out on the centre line: straight in'],
    [500, 0, 600, 0, 'overhead, high'],
    [-3000, -3000, 1500, 90, 'far too high: down beside the field first'],
  ] as const) {
    const a = inAir(x, h, z, heading, 45, g);
    const ap = new FlightAutopilot();
    ap.land(r, false);
    const log = fly(a, ap, g, 1500);
    const td = log.touchdown;
    t.diagnostic(`${how}: ${log.phases.join(' ')}; touchdown ${td ? `${td.x.toFixed(0)} m past the threshold, ${td.sink.toFixed(2)} m/s` : '–'}, stopped ${a.pos.x.toFixed(0)} m, ${log.time.toFixed(0)} s, attempt ${ap.state.attempt}`);
    assert.equal(log.crashed, null, how);
    assert.ok(!log.stalled && !log.tailStrike, how);
    assert.ok(ap.state.done && ap.state.phase === 'stopped', `${how}: landed`);
    assert.equal(ap.state.goArounds, 0, `${how}: at the first attempt`);
    assert.ok(td !== null, how);
    between(td.sink, 0, 1.5, `${how}: sink rate at touchdown (m/s)`);
    between(td.x, 60, 450, `${how}: touchdown (m past the threshold)`);
    onRunway(a, 1000, how);
    assert.ok(inOrder(log.phases, ['final', 'flare', 'rollout', 'stopped']), `${how}: ${log.phases.join(' ')}`);
    assert.ok(log.maxBank < AUTOPILOT.bankMax + 0.5 * DEG, `${how}: bank ${(log.maxBank / DEG).toFixed(1)}°`);
  }
});

test('landing in wind: 6 m/s across the runway, 5 m/s from behind, 8 m/s on the nose', (t) => {
  const f = airfield();
  const g = new AirfieldGround(level(0), [f]);
  const r = f.runways[0];
  for (const [wx, wz, what] of [
    [0, 6, 'crosswind from the north'],
    [5, 0, 'tailwind'],
    [-8, 0, 'headwind'],
  ] as const) {
    const a = inAir(-5000, 305, 3000, 90, 45, g);
    a.wind.x = wx;
    a.wind.z = wz;
    const ap = new FlightAutopilot();
    ap.land(r, false);
    const log = fly(a, ap, g, 1500);
    t.diagnostic(`${what}: touchdown ${log.touchdown?.x.toFixed(0)} m, ${log.touchdown?.z.toFixed(1)} m off the centre line, stopped ${a.pos.x.toFixed(0)} m, attempts ${ap.state.attempt}`);
    assert.equal(log.crashed, null, what);
    assert.ok(ap.state.done, `${what}: landed`);
    onRunway(a, 1000, what);
    assert.ok(log.touchdown !== null && log.touchdown.sink < 1.5, what);
  }
});

test('go-around: an approach that is not lined up at 100 ft goes round, flies the circuit again and lands at the second attempt', (t) => {
  const f = airfield();
  const g = new AirfieldGround(level(0), [f]);
  const a = inAir(-5000, 305, 3000, 90, 45, g);
  const ap = new FlightAutopilot();
  ap.land(f.runways[0], false);
  let pushed = false;
  let gaAt = Number.NaN;
  let lowest = Infinity;
  const log = fly(a, ap, g, 1500, (time) => {
    // a gust puts it 60 m beside the centre line just above the gate
    if (!pushed && ap.state.phase === 'final' && a.agl < AUTOPILOT.gate + 4) {
      a.pos.z += 60;
      pushed = true;
    }
    if (ap.state.phase === 'goAround') {
      if (Number.isNaN(gaAt)) gaAt = time;
      lowest = Math.min(lowest, a.agl);
    }
  });
  t.diagnostic(`go-around at ${gaAt.toFixed(0)} s, lowest ${lowest.toFixed(1)} m; ${log.phases.join(' ')}; landed after ${log.time.toFixed(0)} s`);
  assert.equal(log.crashed, null);
  assert.ok(!log.stalled);
  assert.ok(pushed && !Number.isNaN(gaAt), 'went round');
  assert.ok(lowest > 15, `it climbed away (lowest ${lowest.toFixed(1)} m)`);
  assert.equal(ap.state.goArounds, 1);
  assert.equal(ap.state.attempt, 2);
  assert.ok(inOrder(log.phases, ['final', 'goAround', 'upwind', 'crosswind', 'downwind', 'base', 'final', 'flare', 'rollout', 'stopped']), log.phases.join(' '));
  onRunway(a, 1000, 'second attempt');
});

test('rejected take-off: a runway too short to get airborne on is stopped on, not run off the end at speed', (t) => {
  const f = airfield(300);
  const g = new AirfieldGround(level(0), [f]);
  const r = f.runways[0];
  const sp = runwayStart(r, false);
  const a = new Aircraft();
  a.placeOnGround(sp.x, sp.z, sp.yaw, g, true);
  const ap = new FlightAutopilot();
  ap.takeoff(r, false);
  let vmax = 0;
  const log = fly(a, ap, g, 120, () => {
    vmax = Math.max(vmax, a.ias);
  });
  t.diagnostic(`rejected at up to ${vmax.toFixed(1)} m/s, stopped ${a.pos.x.toFixed(0)} m along the 300 m runway`);
  assert.equal(log.crashed, null);
  assert.ok(ap.state.rejected && ap.state.done, 'stopped');
  assert.ok(log.phases.includes('rejected'));
  assert.ok(vmax < TRAINER.vr, 'never flew');
  between(a.pos.x, 0, 300, 'stopped on the runway (m)');
});

// ---- 5. the demonstration flight ----------------------------------------------------------------------------------

test('demonstration flight: take-off, circuit, landing on the same runway – the legs in order, the flaps by the book', (t) => {
  const f = airfield();
  const g = new AirfieldGround(level(0), [f]);
  const r = f.runways[0];
  const sp = runwayStart(r, false);
  const a = new Aircraft();
  a.placeOnGround(sp.x, sp.z, sp.yaw, g, true);
  const ap = new FlightAutopilot();
  ap.demo(r, false);
  const flaps: number[] = [];
  let downwindLo = Infinity;
  let downwindHi = -Infinity;
  const log = fly(a, ap, g, 900, () => {
    if (flaps[flaps.length - 1] !== ap.state.flapNotch) flaps.push(ap.state.flapNotch);
    if (ap.state.phase === 'downwind' && ap.state.vertical === 'hold' && a.pos.x > 0) {
      downwindLo = Math.min(downwindLo, a.agl);
      downwindHi = Math.max(downwindHi, a.agl);
    }
  });
  if (flaps[flaps.length - 1] !== ap.state.flapNotch) flaps.push(ap.state.flapNotch);
  t.diagnostic(`demonstration: ${log.phases.join(' ')} in ${log.time.toFixed(0)} s; flaps ${flaps.join('→')}; downwind ${downwindLo.toFixed(0)}…${downwindHi.toFixed(0)} m; touchdown ${log.touchdown?.x.toFixed(0)} m at ${log.touchdown?.sink.toFixed(2)} m/s, stopped ${a.pos.x.toFixed(0)} m; bank up to ${(log.maxBank / DEG).toFixed(1)}°`);
  assert.equal(log.crashed, null);
  assert.ok(!log.stalled && log.warning === 0 && !log.tailStrike);
  assert.deepEqual(log.phases, ['lineup', 'takeoffRoll', 'rotate', 'initialClimb', 'upwind', 'crosswind', 'downwind', 'base', 'final', 'flare', 'rollout', 'stopped']);
  assert.deepEqual(flaps, [1, 0, 1, 2, 3, 0]);
  between(downwindLo, AUTOPILOT.circuitHeight - 50 * FT, AUTOPILOT.circuitHeight + 50 * FT, 'downwind height, lowest (m)');
  between(downwindHi, AUTOPILOT.circuitHeight - 50 * FT, AUTOPILOT.circuitHeight + 50 * FT, 'downwind height, highest (m)');
  assert.ok(log.maxBank < AUTOPILOT.bankMax + 0.5 * DEG);
  assert.ok(log.time < 480, `${log.time.toFixed(0)} s`);
  assert.equal(ap.state.attempt, 1);
  assert.ok(log.touchdown !== null && log.touchdown.sink < 1.5);
  onRunway(a, 1000, 'demonstration');
});

test('demonstration with a sightseeing route, from a field 280 m above the sea and in the other direction', (t) => {
  const f = airfield(1200);
  const g = new AirfieldGround(level(280), [f]);
  const r = f.runways[0];
  const sp = runwayStart(r, true);
  const a = new Aircraft();
  a.placeOnGround(sp.x, sp.z, sp.yaw, g, true);
  const ap = new FlightAutopilot();
  const route: AutopilotWaypoint[] = [{ x: -4000, z: -3000, altitude: 280 + 450 }, { x: -2000, z: 4000 }, { x: 4000, z: 4000, altitude: 280 + 600 }];
  ap.demo(r, true, route);
  const closest = route.map(() => Infinity);
  const log = fly(a, ap, g, 1500, () => {
    route.forEach((p, i) => (closest[i] = Math.min(closest[i], Math.hypot(a.pos.x - p.x, a.pos.z - p.z))));
  });
  t.diagnostic(`route: ${log.phases.join(' ')} in ${log.time.toFixed(0)} s; came within ${closest.map((d) => d.toFixed(0)).join(', ')} m of the waypoints; stopped ${a.pos.x.toFixed(0)} m`);
  assert.equal(log.crashed, null);
  assert.ok(!log.stalled);
  assert.equal(ap.state.runway, '27');
  assert.ok(inOrder(log.phases, ['takeoffRoll', 'initialClimb', 'route', 'final', 'flare', 'stopped']), log.phases.join(' '));
  for (const d of closest) assert.ok(d < 250, `a waypoint flown over at ${d.toFixed(0)} m`);
  assert.ok(ap.state.done && ap.state.routeIndex === route.length);
  // landing towards the west: from the second end
  between(a.pos.x, 0, 1200, 'stopped on the runway (m)');
  assert.ok(Math.abs(a.pos.z) < 15 && a.groundSpeed < 0.5);
  assert.ok(Math.abs(wrap180(a.heading - 270)) < 10, 'facing west');
});

test('demonstration with every engine of the game and at long frame times', (t) => {
  const f = airfield();
  const g = new AirfieldGround(level(0), [f]);
  const r = f.runways[0];
  const sp = runwayStart(r, false);
  for (const [power, dt, how] of [
    [100, 1 / 30, '100 PS'],
    [180, 1 / 30, '180 PS'],
    [160, 1 / 20, '1/20 s steps'],
    [160, 0.2, 'fly() with 1/5 s frames'],
  ] as const) {
    const a = new Aircraft(TRAINER, power);
    a.placeOnGround(sp.x, sp.z, sp.yaw, g, true);
    const ap = new FlightAutopilot();
    ap.demo(r, false);
    let log: Log;
    if (how.startsWith('fly()')) {
      // the game's frame, cut into pieces of at most 1/30 s by the autopilot itself
      let time = 0;
      while (time < 1500 && !ap.state.done && !a.crashed) {
        ap.fly(a, dt, g);
        time += dt;
      }
      log = { time, crashed: a.crashed, stalled: false, warning: 0, maxBank: 0, tailStrike: a.tailStrike, phases: [ap.state.phase], touchdown: null };
    } else log = fly(a, ap, g, 1500, undefined, dt);
    t.diagnostic(`${how}: ${log.time.toFixed(0)} s, stopped ${a.pos.x.toFixed(0)} m, attempts ${ap.state.attempt}`);
    assert.equal(log.crashed, null, how);
    assert.ok(!log.stalled, how);
    assert.ok(ap.state.done, `${how}: landed`);
    onRunway(a, 1000, how);
  }
});

// ---- 6. placed in the air anywhere (the map's teleport) ---------------------------------------------------------------

test('placed in the air at any height and speed: the instruments are right at once and the autopilot holds that height and heading', (t) => {
  const g = level(200);
  for (const [height, speed, flaps, what] of [
    [300, 50, 0, '300 m, cruise'],
    [1500, 30, 0, '1500 m, slow'],
    [3000, 70, 0, '3000 m, fast'],
    [4500, 45, 0, '4500 m'],
    [800, 32, 20, '800 m, slow with 20° of flap'],
  ] as const) {
    const a = new Aircraft();
    if (flaps > 0) {
      // (the flaps are where the lever left them before the aeroplane was placed)
      a.placeOnGround(0, 0, 0, g, true);
      const c: FlightControls = { throttle: 0, elevator: 0, aileron: 0, rudder: 0, flaps: flaps / TRAINER.flapsMax, trim: 0, brake: 1, parkingBrake: true, engineOn: true };
      for (let i = 0; i < 6 * 60; i++) a.step(DT, c, g);
    }
    const y = 200 + height;
    a.placeInAir(1000, y, 2000, -60 * DEG, speed, g);
    between(a.agl, height - TRAINER.gear[1].radius + TRAINER.gear[1].y - 0.5, height, `${what}: agl right after the placement`);
    const ap = new FlightAutopilot();
    ap.hold(a.heading, a.altitude);
    let off = 0;
    let lowest = Infinity;
    const log = fly(a, ap, g, 120, (time) => {
      lowest = Math.min(lowest, a.altitude);
      if (time > 60) off = Math.max(off, Math.abs(a.altitude - y));
    });
    t.diagnostic(`${what}: lowest ${(lowest - y).toFixed(1)} m, after a minute within ${off.toFixed(1)} m, ${a.ias.toFixed(1)} m/s indicated, flaps ${ap.state.flapNotch}`);
    assert.equal(log.crashed, null, what);
    assert.ok(!log.stalled, `${what}: no stall`);
    assert.ok(off < 50 * FT, `${what}: height held (${off.toFixed(1)} m off)`);
    assert.ok(Math.abs(wrap180(a.heading - 60)) < 5, `${what}: heading ${a.heading.toFixed(1)}`);
    assert.equal(ap.state.flapNotch, 0, `${what}: flaps up`);
  }
  // too low over rising ground: it keeps 150 m above what lies ahead
  const hill = new PlaneGround(0.05);
  const a = new Aircraft();
  a.placeInAir(0, 60, 0, 0, 50, hill);
  const ap = new FlightAutopilot();
  ap.hold(0, a.altitude);
  let low = Infinity;
  const log = fly(a, ap, hill, 150, (time) => {
    if (time > 40) low = Math.min(low, a.agl);
  });
  t.diagnostic(`placed 60 m above a 5 % slope: ${low.toFixed(0)} m above the ground after 40 s`);
  assert.equal(log.crashed, null);
  assert.ok(low > 120, `clear of the rising ground (${low.toFixed(0)} m)`);
});

// ---- 7. the rest of the interface ------------------------------------------------------------------------------------------

test('the same flight gives the same controls; the HUD state tells what it does; off hands back', () => {
  const f = airfield();
  const run = (): number[] => {
    const g = new AirfieldGround(level(0), [f]);
    const sp = runwayStart(f.runways[0], false);
    const a = new Aircraft();
    a.placeOnGround(sp.x, sp.z, sp.yaw, g, true);
    const ap = new FlightAutopilot();
    ap.demo(f.runways[0], false);
    fly(a, ap, g, 150);
    return [a.pos.x, a.pos.y, a.pos.z, ...a.q, ap.controls.elevator, ap.controls.throttle];
  };
  assert.deepEqual(run(), run());
  const g = level(0);
  const a = inAir(0, 600, 0, 0, 50, g);
  const ap = new FlightAutopilot();
  ap.goto(2000, 0, 700, { radius: 500, right: true });
  fly(a, ap, g, 5);
  const s = ap.state;
  assert.equal(s.mode, 'goto');
  assert.equal(s.phase, 'enroute');
  assert.equal(s.targetAltitude, 700);
  assert.ok(s.targetSpeed > 30 && s.targetSpeed < 60);
  assert.ok(s.distance > 1500 && s.distance < 2100);
  assert.ok(ap.engaged);
  ap.off();
  assert.equal(ap.state.mode, 'off');
  assert.ok(!ap.engaged);
  const before = { ...ap.controls };
  assert.deepEqual(ap.update(a, DT, g), before, 'switched off it no longer steers');
});

test('runwayAt finds the runway and direction the aeroplane stands on; landingRunway picks a runway and its approach', () => {
  const f = airfield();
  const second: AirfieldJson = { ...airfield(600, 'grass'), name: 'Weit', x: 20000, z: 0, runways: [{ ref: '18/36', x1: 20000, z1: -300, x2: 20000, z2: 300, w: 30, s: 'grass' }] };
  const start = runwayStart(f.runways[0], true);
  const at = runwayAt([second, f], start.x, start.z, start.yaw);
  assert.ok(at !== null && at.runway === f.runways[0] && at.fromSecond === true);
  assert.equal(runwayAt([f], 500, 200, 0), null, 'beside the runway: none');
  const west = landingRunway([f, second], -6000, 300);
  assert.ok(west !== null && west.field === f && west.fromSecond === false, 'from the west: towards the east');
  const east = landingRunway([f, second], 6000, 300);
  assert.ok(east !== null && east.field === f && east.fromSecond === true, 'from the east: towards the west');
  assert.equal(landingRunway([second], 0, 0, 700), null, 'none long enough');
});

// ---- 8. the assist ----------------------------------------------------------------------------------------------------------------

/** The game's own mapping of the stick (game.ts stepFlight): what flying without the assist is. */
function gameMapping(a: Aircraft, s: StickInput, c: FlightControls): void {
  c.elevator = s.pitch;
  c.aileron = s.roll;
  c.rudder = Math.max(-1, Math.min(1, s.yaw + s.roll * (a.onGround ? 0.9 : 0.25)));
  if (!a.onGround) c.trim = Math.max(-1, Math.min(1, c.trim + s.pitch * DT * 0.06));
}

interface HandLog {
  stalled: boolean;
  maxG: number;
  minG: number;
  maxBank: number;
  maxIas: number;
  crashed: string | null;
}

/** Fly by hand for `seconds`: `hands(t)` gives the stick; with an assist or the game's plain mapping. */
function byHand(a: Aircraft, g: Ground, seconds: number, hands: (t: number) => StickInput, assist: FlightAssist | null, c: FlightControls, each?: (t: number) => void): HandLog {
  const log: HandLog = { stalled: false, maxG: 0, minG: 0, maxBank: 0, maxIas: 0, crashed: null };
  for (let i = 0; i < seconds / DT; i++) {
    const t = i * DT;
    const s = hands(t);
    if (assist) assist.apply(a, s, DT, c);
    else gameMapping(a, s, c);
    a.step(DT, c, g);
    if (a.stalled) log.stalled = true;
    log.maxG = Math.max(log.maxG, a.loadFactor);
    log.minG = Math.min(log.minG, a.loadFactor);
    log.maxBank = Math.max(log.maxBank, Math.abs(a.bank));
    log.maxIas = Math.max(log.maxIas, a.ias);
    each?.(t);
    if (a.crashed) break;
  }
  log.crashed = a.crashed;
  return log;
}

function trimmed(speed: number, height: number, g: Ground): { a: Aircraft; c: FlightControls } {
  const a = new Aircraft();
  a.placeInAir(0, height, 0, 0, speed, g);
  const lf = a.levelFlight(speed, 0);
  return { a, c: { throttle: lf.throttle, elevator: 0, aileron: 0, rudder: 0, flaps: 0, trim: lf.trim, brake: 0, parkingBrake: false, engineOn: true } };
}

const stick = (pitch = 0, roll = 0, yaw = 0): StickInput => ({ pitch, roll, yaw });

test('assist: the stick pulled right back with the keys for 8 s – no stall and no overstress with it, a stall without', (t) => {
  const g = level(0);
  const results: string[] = [];
  for (const [name, opts] of [
    ['none', null],
    ['light', ASSIST_LIGHT],
    ['beginner', ASSIST_BEGINNER],
  ] as const) {
    const { a, c } = trimmed(45, 1500, g);
    const assist = opts ? new FlightAssist(opts) : null;
    assist?.reset(c.trim);
    const log = byHand(a, g, 12, (time) => stick(time < 8 ? 1 : 0), assist, c);
    results.push(`${name}: ${log.stalled ? 'stalled' : 'no stall'}, up to ${log.maxG.toFixed(2)} g`);
    assert.equal(log.crashed, null, name);
    if (opts) {
      assert.ok(!log.stalled, `${name}: no stall`);
      assert.ok(log.maxG < ASSIST.gMax + 0.3, `${name}: ${log.maxG.toFixed(2)} g`);
    } else assert.ok(log.stalled, 'without the assist the pulled stick stalls it (that is what the assist is for)');
  }
  t.diagnostic(results.join('; '));
});

test('assist (beginner): rolled hard and let go, the wings come level by themselves and the height stays', (t) => {
  const g = level(0);
  const out: string[] = [];
  for (const [name, opts] of [
    ['none', null],
    ['beginner', ASSIST_BEGINNER],
  ] as const) {
    const { a, c } = trimmed(50, 1500, g);
    const assist = opts ? new FlightAssist(opts) : null;
    assist?.reset(c.trim);
    let levelAt = Number.NaN;
    let lo = Infinity;
    let hi = -Infinity;
    const log = byHand(a, g, 30, (time) => stick(0, time < 1.2 ? 1 : 0), assist, c, (time) => {
      lo = Math.min(lo, a.altitude);
      hi = Math.max(hi, a.altitude);
      if (time > 1.2 && Number.isNaN(levelAt) && Math.abs(a.bank) < 3 * DEG) levelAt = time - 1.2;
    });
    out.push(`${name}: bank up to ${(log.maxBank / DEG).toFixed(0)}°, ${Number.isNaN(levelAt) ? `still ${(a.bank / DEG).toFixed(0)}° half a minute later` : `level ${levelAt.toFixed(1)} s after letting go`}, height ${(lo - 1500).toFixed(0)}…${(hi - 1500).toFixed(0)} m`);
    if (opts) {
      assert.ok(log.maxBank < ASSIST.bank + 1 * DEG, `bank limited (${(log.maxBank / DEG).toFixed(1)}°)`);
      assert.ok(levelAt < 8, `level ${levelAt.toFixed(1)} s after letting go`);
      assert.ok(Math.abs(a.bank) < 2 * DEG, 'and stays level');
      assert.ok(hi - lo < 30, `height kept (${(hi - lo).toFixed(0)} m)`);
    } else assert.ok(Number.isNaN(levelAt), 'without it the aeroplane stays in its bank');
  }
  t.diagnostic(out.join('; '));
});

/** Roll the aeroplane about its longitudinal axis by `bank` (rad, + = right wing down) – a gust. */
function rollBy(a: Aircraft, bank: number): void {
  const [x, y, z, w] = a.q;
  const s = Math.sin(-bank / 2);
  const k = Math.cos(-bank / 2);
  a.q[0] = x * k + y * s;
  a.q[1] = y * k - x * s;
  a.q[2] = z * k + w * s;
  a.q[3] = w * k - z * s;
}

test('assist (beginner): hands off after a gust has rolled and dropped it, it flies straight and level again', (t) => {
  const g = level(0);
  const { a, c } = trimmed(50, 1500, g);
  const assist = new FlightAssist(ASSIST_BEGINNER);
  assist.reset(c.trim);
  byHand(a, g, 5, () => stick(), assist, c);
  rollBy(a, -30 * DEG);
  a.vel.y -= 4;
  const h0 = a.altitude;
  let maxBank = 0;
  const log = byHand(a, g, 60, () => stick(), assist, c, () => {
    maxBank = Math.max(maxBank, Math.abs(a.bank));
  });
  t.diagnostic(`after the gust: bank ${(a.bank / DEG).toFixed(1)}°, ${a.verticalSpeed.toFixed(2)} m/s, ${(a.altitude - h0).toFixed(0)} m from where it was hit`);
  assert.equal(log.crashed, null);
  assert.ok(!log.stalled);
  assert.ok(maxBank < 31 * DEG, 'the bank only got smaller');
  assert.ok(Math.abs(a.bank) < 2 * DEG, 'wings level');
  assert.ok(Math.abs(a.turnRate) < 0.5 * DEG, 'not turning');
  assert.ok(Math.abs(a.verticalSpeed) < 1, `steady (${a.verticalSpeed.toFixed(2)} m/s)`);
});

test('assist (light): the rudder keeps the ball in the middle in a turn flown with the stick alone', (t) => {
  const g = level(0);
  const out: number[] = [];
  for (const opts of [null, ASSIST_LIGHT]) {
    const { a, c } = trimmed(45, 1500, g);
    const assist = opts ? new FlightAssist(opts) : null;
    assist?.reset(c.trim);
    let slip = 0;
    let n = 0;
    // roll in with half the stick for a second and a half, then let it be
    byHand(a, g, 6, (time) => stick(0, time < 1.5 ? 0.5 : 0), assist, c, (time) => {
      if (time > 0.3 && time < 4) {
        slip += Math.abs(a.sideslip);
        n++;
      }
    });
    out.push(slip / n);
  }
  t.diagnostic(`mean sideslip rolling in: ${(out[0] / DEG).toFixed(2)}° with the game's rudder, ${(out[1] / DEG).toFixed(2)}° coordinated`);
  assert.ok(out[1] < out[0] * 0.5, 'the coordinated rudder halves the sideslip at least');
});

test('assist: the stick pushed forward at full power – the airspeed stays below vne with it, without it the airframe fails', (t) => {
  const g = level(0);
  const out: string[] = [];
  for (const [name, opts] of [
    ['none', null],
    ['light', ASSIST_LIGHT],
    ['beginner', ASSIST_BEGINNER],
  ] as const) {
    const { a, c } = trimmed(55, 3000, g);
    c.throttle = 1;
    const assist = opts ? new FlightAssist(opts) : null;
    assist?.reset(c.trim);
    const log = byHand(a, g, 40, () => stick(-1), assist, c);
    out.push(`${name}: up to ${log.maxIas.toFixed(1)} m/s, ${log.minG.toFixed(2)}…${log.maxG.toFixed(2)} g${log.crashed ? `, ${log.crashed}` : ''}`);
    if (opts) {
      assert.equal(log.crashed, null, name);
      assert.ok(log.maxIas < TRAINER.vne, `${name}: ${log.maxIas.toFixed(1)} m/s`);
      between(log.minG, ASSIST.gMin - 0.5, 1, `${name}: least load factor (g)`);
      between(log.maxG, 1, ASSIST.gMax + 0.5, `${name}: greatest load factor (g)`);
    } else assert.ok(log.maxIas > TRAINER.vne || log.crashed !== null, 'without the assist it goes beyond vne or breaks');
  }
  t.diagnostic(out.join('; '));
});

test('assist on the runway: the stick steers the nose wheel as the game does, and a take-off by hand works with it', (t) => {
  const f = airfield();
  const g = new AirfieldGround(level(0), [f]);
  const sp = runwayStart(f.runways[0], false);
  const a = new Aircraft();
  a.placeOnGround(sp.x, sp.z, sp.yaw, g, true);
  const assist = new FlightAssist(ASSIST_BEGINNER);
  const c: FlightControls = { throttle: 1, elevator: 0, aileron: 0, rudder: 0, flaps: 1 / 3, trim: 0.15, brake: 0, parkingBrake: false, engineOn: true };
  assist.reset(c.trim);
  for (let i = 0; i < 10; i++) assist.apply(a, stick(0, 1), 0.1, c);
  assert.ok(c.rudder > 0.85, `the nose wheel follows the stick (${c.rudder.toFixed(2)})`);
  for (let i = 0; i < 10; i++) assist.apply(a, stick(), 0.1, c);
  // a pilot who keeps straight with the stick, pulls at vr and lets go once climbing
  let airborne = Number.NaN;
  const log = byHand(a, g, 60, (time) => {
    const keep = Math.max(-1, Math.min(1, -0.05 * a.pos.z - 0.3 * wrap180(a.heading - 90)));
    if (a.onGround) return stick(a.ias > TRAINER.vr ? 0.5 : 0, keep);
    if (Number.isNaN(airborne)) airborne = time;
    return stick(time - airborne < 3 ? 0.3 : 0, 0);
  }, assist, c);
  t.diagnostic(`by hand with the assist: airborne after ${airborne.toFixed(1)} s, ${a.agl.toFixed(0)} m up a minute after brakes off`);
  assert.equal(log.crashed, null);
  assert.ok(!log.stalled);
  assert.ok(a.agl > 30 && !a.onGround, 'climbing away');
});

test('assist: random sticks for two minutes at random frame times – never a stall, a crash or a number that is not one', () => {
  let seed = 4242;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const g = level(0);
  for (const opts of [ASSIST_BEGINNER, ASSIST_LIGHT]) {
    const { a, c } = trimmed(50, 3000, g);
    const assist = new FlightAssist(opts);
    assist.reset(c.trim);
    let s = stick();
    for (let i = 0; i < 4000; i++) {
      if (i % 25 === 0) s = stick(rnd() * 2 - 1, rnd() * 2 - 1, rnd() < 0.2 ? rnd() * 2 - 1 : 0);
      if (i % 400 === 0) c.throttle = rnd();
      const dt = rnd() * 0.05 + 0.005;
      assist.apply(a, s, dt, c);
      a.step(dt, c, g);
      for (const v of [c.elevator, c.aileron, c.rudder, c.trim, a.pos.y, a.ias]) assert.ok(Number.isFinite(v), `finite after ${i} steps`);
      assert.ok(!a.stalled, `no stall after ${i} steps`);
      assert.equal(a.crashed, null);
    }
  }
});
