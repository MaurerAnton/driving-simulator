// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The cranes' physics (src/sim/crane.ts): the tipping check against hand
 * calculation, the load charts worked out from it (every one within three
 * quarters of the tipping load in every slewing direction), the load moment
 * limiter (warning, cut-off before an overload leaves the ground, which
 * movements it stops), the hook swinging as a pendulum, the outriggers and
 * the levelling, the wind, and a crane tipping over beyond its limits.
 *
 *   node --test tests/sim/crane.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Crane, G, LOADER_GEOMETRY, MARGIN_OUTRIGGERS, MOBILE_CRANE, MOBILE_GEOMETRY, TOWER_CRANE, TOWER_GEOMETRY, boomDir, capacity, chartOf, convexHull, craneWeights, gust, headOf, stability, supportsFor, tippingLoad, towerCapacity, windAtHeight } from '../../src/sim/crane.ts';
import type { Box3, CraneType, CraneWorld, HookLoad, Joints, Setting } from '../../src/sim/crane.ts';

const DT = 1 / 240;

/** flat ground at height 0, no wind (or the wind given), solids and platforms as asked */
function world(opts: { wind?: { x: number; z: number }; boxes?: Box3[]; platforms?: Array<Box3 & { y: number }>; ground?: (x: number, z: number) => number } = {}): CraneWorld {
  const ground = opts.ground ?? (() => 0);
  const wind = { x: opts.wind?.x ?? 0, z: opts.wind?.z ?? 0, gust: 1 };
  return {
    floor: (x, z, hx, hz, y) => {
      let best = Math.max(ground(x, z), ground(x - hx, z - hz), ground(x + hx, z - hz), ground(x - hx, z + hz), ground(x + hx, z + hz));
      for (const p of opts.platforms ?? []) if (p.y <= y + 0.05 && p.y > best && !(x + hx <= p.x0 || x - hx >= p.x1 || z + hz <= p.z0 || z - hz >= p.z1)) best = p.y;
      return best;
    },
    boxes: () => opts.boxes ?? [],
    ground,
    wind: () => wind,
  };
}

function run(c: Crane, w: CraneWorld, seconds: number, each?: () => boolean | void): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    c.step(DT, w);
    if (each?.()) return;
  }
}

const pallet = (t: number): HookLoad => ({ id: 'p', t, hx: 0.6, hy: 0.55, hz: 0.5, sling: 1.6, yaw: 0, area: 1.4 });

/** Lower the hook of a crane until it stands on the ground, then sling a load of `t` tonnes standing there. */
function slingOnGround(c: Crane, w: CraneWorld, t: number): void {
  c.cmd.hoist = -1;
  run(c, w, 90, () => c.resting);
  c.cmd.hoist = 0;
  run(c, w, 1);
  c.attach(pallet(t), c.hook.x, 1.1, c.hook.z);
}

/** A mobile crane on full outriggers, levelled, its boom up at `luff` and out to `tele`. */
function mobileSetUp(w: CraneWorld, luffDeg: number, tele = 0): Crane {
  const c = new Crane('mobile');
  c.place(0, 0, 0, 0);
  c.cmd.beams = 1;
  run(c, w, 16);
  c.cmd.beams = 0;
  c.cmd.jacks = 1;
  run(c, w, 20, () => c.onOutriggers(w));
  run(c, w, 1);
  c.cmd.jacks = 0;
  c.cmd.boom = 1;
  run(c, w, 60, () => c.q.luff >= (luffDeg * Math.PI) / 180);
  c.cmd.boom = 0;
  if (tele > 0) {
    c.cmd.tele = 1;
    run(c, w, 120, () => c.q.tele >= tele);
    c.cmd.tele = 0;
  }
  run(c, w, 3);
  return c;
}

test('the tipping check: a weight within the supports holds, beyond the tipping line it tips – the tipping load just balances', () => {
  const square: Array<[number, number]> = [
    [-2, -2],
    [2, -2],
    [2, 2],
    [-2, 2],
  ];
  assert.equal(convexHull([...square, [0, 0], [1, 1]]).length, 4, 'points inside are no supports');
  const base = [{ t: 10, x: 0, y: 1, z: 0 }];
  assert.ok(stability(base, [], square).u === 0, 'a weight over the middle tips nothing');
  // 10 t over the middle (2 m inside the line x = 2) and 4 t at x = 7 (5 m beyond it): 20 t·m hold, 20 t·m tip
  const tip = tippingLoad(base, 7, 0, square);
  assert.ok(Math.abs(tip - 4) < 1e-9, `tipping load ${tip}`);
  assert.ok(Math.abs(stability([...base, { t: 4, x: 7, y: 5, z: 0 }], [], square).u - 1) < 1e-9);
  assert.ok(stability([...base, { t: 3, x: 7, y: 5, z: 0 }], [], square).u < 1);
  assert.ok(stability([...base, { t: 5, x: 7, y: 5, z: 0 }], [], square).u > 1);
  // a sideways push at a height tips as well: 10 t · 2 m held against 20 kN·9.81 at 1 m … at 2 m
  const side = stability(base, [{ fx: 10 * G * 2, fz: 0, y: 1 }], square);
  assert.ok(Math.abs(side.u - 1) < 1e-9, `push ${side.u}`);
  // fewer than three supports: no standing at all
  assert.equal(stability(base, [], [[0, 0], [1, 0]]).u, Infinity);
});

test("the tower crane: 6 t to 16 m, 1.6 t at the jib's end – and with its ballast far from tipping, empty or loaded, in any direction", () => {
  assert.equal(towerCapacity(10), 6);
  assert.equal(towerCapacity(16), 6);
  assert.ok(Math.abs(towerCapacity(48.5) - 1.6) < 0.01);
  for (let r = 3; r < 48; r += 1) assert.ok(towerCapacity(r + 1) <= towerCapacity(r) + 1e-9, 'never more further out');
  const feet = supportsFor(TOWER_CRANE, 'fixed');
  for (const r of [2.5, 16, 30, 48.5]) {
    for (let k = 0; k < 16; k++) {
      const q: Joints = { slew: (k / 16) * Math.PI * 2, trolley: r, luff: 0, tele: 0, inner: 0, outer: 0, ext: 0, rope: 5 };
      const [dx, dz] = boomDir(q.slew);
      const loaded = stability(craneWeights(TOWER_CRANE, q, [{ t: towerCapacity(r) + TOWER_CRANE.hook, x: dx * r, y: 31, z: dz * r }]), [], feet);
      const empty = stability(craneWeights(TOWER_CRANE, q), [], feet);
      assert.ok(loaded.u < 0.75, `loaded at ${r} m: ${loaded.u.toFixed(2)}`);
      assert.ok(empty.u < 0.6, `empty at ${r} m (backwards): ${empty.u.toFixed(2)}`);
    }
  }
});

test("the mobile crane's chart: three quarters of the tipping load in the worst direction, less further out, less on smaller outriggers, little on tyres", () => {
  const chart = chartOf('mobile');
  const settings: Setting[] = ['full', 'half', 'zero', 'tyres'];
  for (let li = 0; li < chart.lengths.length; li++) {
    for (let ri = 1; ri < chart.radii.length; ri++) {
      for (const s of settings) {
        const col = chart.t[s]![li];
        if (col[ri] > 0 && col[ri - 1] > 0) assert.ok(col[ri] <= col[ri - 1] + 1e-9, `${s} L ${chart.lengths[li]}: more at ${chart.radii[ri]} m than at ${chart.radii[ri - 1]} m`);
      }
      const at = (s: Setting): number => chart.t[s]![li][ri];
      assert.ok(at('full') >= at('half') && at('half') >= at('zero') && at('zero') >= at('tyres'), `settings in order at L ${chart.lengths[li]}, R ${chart.radii[ri]}`);
    }
  }
  // the numbers of a 40-t class crane: about 12 t at 10 m on full outriggers, a fraction of that on tyres
  const full10 = capacity('mobile', 'full', 10, 14.5);
  const tyres10 = capacity('mobile', 'tyres', 10, 14.5);
  assert.ok(full10 > 10 && full10 < 15, `full, 10 m: ${full10}`);
  assert.ok(tyres10 < 0.25 * full10, `on tyres, 10 m: ${tyres10}`);
  assert.ok(capacity('mobile', 'full', 3, 9.6) === 40, 'its 40 t close in');
  // at the rated load, in every slewing direction, it stands – and it would take a third more (the load ÷ 0.75) to tip it
  const g = MOBILE_GEOMETRY;
  for (const [s, L, R] of [
    ['full', 14.48, 10],
    ['full', 24.24, 20],
    ['half', 19.36, 12],
    ['zero', 14.48, 8],
  ] as Array<[Setting, number, number]>) {
    const cap = capacity('mobile', s, R, L);
    const luff = Math.acos((R - g.footA) / (L + g.head));
    for (let k = 0; k < 36; k++) {
      const q: Joints = { slew: (k / 36) * Math.PI * 2, trolley: 0, luff, tele: (L - g.length0) / (g.length1 - g.length0), inner: 0, outer: 0, ext: 0, rope: 5 };
      const [dx, dz] = boomDir(q.slew);
      const lx = MOBILE_CRANE.slewX + dx * R;
      const lz = MOBILE_CRANE.slewZ + dz * R;
      const u = stability(craneWeights(MOBILE_CRANE, q, [{ t: cap, x: lx, y: 10, z: lz }]), [], supportsFor(MOBILE_CRANE, s)).u;
      assert.ok(u < 0.9, `${s} L ${L} R ${R} at ${k * 10}°: u ${u.toFixed(3)}`);
      const tip = tippingLoad(craneWeights(MOBILE_CRANE, q), lx, lz, supportsFor(MOBILE_CRANE, s));
      assert.ok(tip >= cap / MARGIN_OUTRIGGERS - 0.01, `${s} L ${L} R ${R} at ${k * 10}°: tips at ${tip.toFixed(2)} t, rated ${cap} t`);
      // (and at the tipping load itself the check says just that)
      if (Number.isFinite(tip)) assert.ok(Math.abs(stability(craneWeights(MOBILE_CRANE, q, [{ t: tip, x: lx, y: 10, z: lz }]), [], supportsFor(MOBILE_CRANE, s)).u - 1) < 1e-6);
    }
  }
});

test('the loader crane: its lifting moment of 14 t·m on outriggers, much less without them', () => {
  for (const r of [3.5, 5, 7, 10]) {
    const full = capacity('loader', 'full', r);
    assert.ok(full <= LOADER_GEOMETRY.moment / r + 1e-9 && full > 0.9 * Math.min(LOADER_GEOMETRY.maxLoad, LOADER_GEOMETRY.moment / r) - 0.06, `at ${r} m: ${full}`);
    assert.ok(capacity('loader', 'tyres', r) < 0.6 * full, `on tyres at ${r} m`);
  }
  // folded for the road the hook hangs close behind the cab; the extensions take the head further out
  const c = new Crane('loader');
  assert.ok(c.stowed());
  const q = { ...c.q, inner: 0.3, outer: -0.3 };
  const near = headOf('loader', { ...q, ext: 0 });
  const far = headOf('loader', { ...q, ext: 1 });
  assert.ok(Math.abs(far.a - near.a - (LOADER_GEOMETRY.outer1 - LOADER_GEOMETRY.outer0)) < 1e-9);
});

test('the limiter: an overload is cut off before it leaves the ground, a load within the chart is lifted', () => {
  const w = world();
  for (const [t, lifts] of [
    [5.2, true],
    [6.3, false],
    [8, false],
  ] as Array<[number, boolean]>) {
    const c = new Crane('tower');
    c.place(0, 0, 0, 0);
    slingOnGround(c, w, t);
    c.cmd.hoist = 1;
    let off = false;
    let cut = false;
    run(c, w, 12, () => {
      off ||= c.events.liftedOff;
      cut ||= c.events.cut;
    });
    if (lifts) {
      assert.ok(off && c.clearance > 1, `${t} t comes up`);
      assert.ok(c.lmi.warn && !c.lmi.stop, `${t} t at ${c.lmi.radius} m: warned (${(c.lmi.ratio * 100).toFixed(0)} %), not cut off`);
    } else {
      assert.ok(cut && c.lmi.stop, `${t} t: cut off`);
      assert.ok(c.resting && c.clearance < 0.02, `${t} t stays on the ground`);
      // what raises the moment stays cut off, what lowers it works
      assert.ok(c.momentUp('rope', -1) && c.momentUp('trolley', 1));
      assert.ok(!c.momentUp('rope', 1) && !c.momentUp('trolley', -1));
      c.cmd.hoist = 0;
      c.cmd.boom = 1;
      const was = c.q.trolley;
      run(c, w, 2);
      assert.equal(c.q.trolley, was, 'the trolley does not go out');
      c.cmd.boom = -1;
      run(c, w, 2);
      assert.ok(c.q.trolley < was - 0.3, 'it comes in');
    }
  }
});

test('the limiter knows what raises the load moment: luffing down, telescoping out, running the trolley out, hoisting', () => {
  const m = new Crane('mobile');
  m.q.luff = 0.6;
  m.q.tele = 0.3;
  assert.ok(m.momentUp('luff', -1) && !m.momentUp('luff', 1));
  assert.ok(m.momentUp('tele', 1) && !m.momentUp('tele', -1));
  assert.ok(m.momentUp('rope', -1) && !m.momentUp('rope', 1));
  assert.ok(!m.momentUp('slew', 1));
  const l = new Crane('loader');
  l.q.inner = 0.4;
  l.q.outer = -0.4;
  assert.ok(l.momentUp('ext', 1) && !l.momentUp('ext', -1));
});

test('the hook swings as a pendulum of its rope, and the swing dies away', () => {
  const w = world();
  const c = new Crane('tower');
  c.place(0, 0, 0, 0);
  run(c, w, 3);
  // run the trolley out and stop: the load swings on
  c.cmd.boom = 1;
  run(c, w, 6);
  c.cmd.boom = 0;
  let max = 0;
  run(c, w, 2, () => void (max = Math.max(max, c.swing)));
  assert.ok(max > 0.2, `it swings after the trolley stops (${max.toFixed(2)} m)`);
  // its period: 2π √(L/g)
  const L = c.head.y - c.hook.y;
  const crossings: number[] = [];
  let prev = c.hook.z - c.head.z;
  let t = 0;
  run(c, w, 40, () => {
    t += DT;
    const d = c.hook.z - c.head.z;
    if (prev < 0 && d >= 0) crossings.push(t);
    prev = d;
  });
  const period = (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
  const want = 2 * Math.PI * Math.sqrt(L / G);
  assert.ok(Math.abs(period - want) / want < 0.05, `period ${period.toFixed(2)} s, pendulum ${want.toFixed(2)} s`);
  assert.ok(c.swing < max * 0.6, `damped: ${c.swing.toFixed(2)} of ${max.toFixed(2)} m`);
  // at rest the rope holds the hook block's weight: that is what the limiter shows
  run(c, w, 30);
  assert.ok(Math.abs(c.lmi.load - TOWER_CRANE.hook) < 0.02, `the hook block alone: ${c.lmi.load.toFixed(3)} t`);
});

test('outriggers: beams out, jacks down until the wheels are free, levelling on a slope – and nothing taken away under a working crane', () => {
  // ground rising 2 % to the east and 1 % to the south
  const slope = (x: number, z: number): number => 0.02 * x + 0.01 * z;
  const w = world({ ground: slope });
  const c = new Crane('mobile');
  c.place(0, 0, 0, 0, 0.02, 0.01);
  assert.equal(c.setting(w), 'tyres');
  c.cmd.beams = 1;
  run(c, w, 16);
  c.cmd.beams = 0;
  assert.ok(c.beamSetting() > 0.99);
  c.cmd.jacks = 1;
  run(c, w, 25, () => c.onOutriggers(w));
  c.cmd.jacks = 0;
  assert.ok(c.onOutriggers(w), 'the wheels are free');
  assert.equal(c.setting(w), 'full');
  assert.ok(c.incline() > 1, `still on the slope: ${c.incline().toFixed(2)}°`);
  // not level: the limiter lets nothing out
  run(c, w, 0.5);
  assert.ok(c.lmi.notLevel);
  c.cmd.boom = 1;
  const before = c.q.luff;
  run(c, w, 2);
  assert.ok(c.q.luff > before, 'raising the boom (bringing it in) still works');
  c.cmd.boom = 0;
  c.cmd.tele = 1;
  run(c, w, 2);
  assert.equal(c.q.tele, 0, 'telescoping out is cut off');
  c.cmd.tele = 0;
  // the levelling
  c.cmd.level = true;
  run(c, w, 30, () => c.incline() < 0.05);
  c.cmd.level = false;
  assert.ok(c.incline() <= 0.3, `levelled: ${c.incline().toFixed(2)}°`);
  assert.ok(c.onOutriggers(w), 'still off its wheels');
  // the boom is up: jacks and beams stay where they are
  const jacks = [...c.jacks];
  c.cmd.jacks = -1;
  c.cmd.beams = -1;
  run(c, w, 3);
  assert.deepEqual(c.jacks, jacks, 'the jacks stay down under a raised boom');
  assert.ok(c.beamSetting() > 0.99, 'the beams stay out');
});

test('a hanging load beyond the tipping load tips the crane over its tipping line', () => {
  const w = world();
  const c = mobileSetUp(w, 45, 0.4);
  const R = c.lmi.radius;
  const cap = capacity('mobile', 'full', R, c.lmi.length);
  assert.ok(cap > 0);
  // hung on in the air (as if the limiter had been bridged): far beyond what tips it
  const top = c.hook.y - MOBILE_CRANE.hookDrop - 1.6;
  c.attach({ ...pallet(cap * 2), sling: 1.6 }, c.hook.x, top, c.hook.z);
  run(c, w, 3, () => c.tipped !== null);
  assert.ok(c.tipped, `tipped (u ${c.lmi.tipping.toFixed(2)})`);
  run(c, w, 2);
  assert.ok((c.tipped?.angle ?? 0) > 0.3, 'and goes over');
});

test('the same load within the chart: no tipping, and the limiter reading the rope', () => {
  const w = world();
  const c = mobileSetUp(w, 45, 0.4);
  const cap = capacity('mobile', 'full', c.lmi.radius, c.lmi.length);
  const t = cap * 0.8 - MOBILE_CRANE.hook;
  const top = c.hook.y - MOBILE_CRANE.hookDrop - 1.6;
  c.attach(pallet(t), c.hook.x, top, c.hook.z);
  run(c, w, 8);
  assert.equal(c.tipped, null);
  assert.ok(Math.abs(c.lmi.ratio - 0.8) < 0.03, `limiter ${(c.lmi.ratio * 100).toFixed(1)} %`);
  assert.ok(c.lmi.tipping < 0.75, `tipping check ${c.lmi.tipping.toFixed(2)}`);
});

test('wind: stronger higher up, gusting between its mean and its gusts, blowing a hanging load aside', () => {
  assert.ok(windAtHeight(10, 40) > windAtHeight(10, 10) && windAtHeight(10, 10) === 10);
  for (let t = 0; t < 200; t += 0.7) {
    const g = gust(t, 1.5);
    assert.ok(g >= 1 - 1e-9 && g <= 1.5 + 1e-9);
  }
  const calm = new Crane('tower');
  const windy = new Crane('tower');
  const w0 = world();
  const w1 = world({ wind: { x: 12, z: 0 } });
  for (const [c, w] of [
    [calm, w0],
    [windy, w1],
  ] as Array<[Crane, CraneWorld]>) {
    c.place(0, 0, 0, 0);
    c.attach({ id: 'c', t: 2.4, hx: 3, hy: 1.3, hz: 1.2, sling: 3.8, yaw: 0, area: 15.7 }, c.hook.x, c.hook.y - TOWER_CRANE.hookDrop - 3.8, c.hook.z);
    run(c, w, 10);
  }
  // (over two periods of its swing: where it hangs on average)
  let off = 0;
  let still = 0;
  let n = 0;
  for (let i = 0; i < 14 / DT; i++) {
    windy.step(DT, w1);
    calm.step(DT, w0);
    off += windy.hook.x - windy.head.x;
    still = Math.max(still, Math.abs(calm.hook.x - calm.head.x));
    n++;
  }
  assert.ok(off / n > 0.3, `blown east: ${(off / n).toFixed(2)} m`);
  assert.ok(still < 0.05);
  assert.ok(windy.lmi.wind > 12, 'the wind at the jib is stronger than 10 m up');
});

test('a load set down on a platform stands on it; a box stops the hook', () => {
  const plat: Box3 & { y: number } = { x0: -5, x1: 5, z0: -16, z1: -12, y0: -2, y1: 6, y: 6 };
  const wall: Box3 = { x0: -5, x1: 5, z0: -10.2, z1: -9.8, y0: 0, y1: 20 };
  const w = world({ platforms: [plat], boxes: [wall] });
  const c = new Crane('tower');
  c.place(0, 0, 0, 0);
  c.q.trolley = 14;
  c.place(0, 0, 0, 0);
  c.attach(pallet(1.2), c.hook.x, c.hook.y - TOWER_CRANE.hookDrop - 1.6, c.hook.z);
  let landed = 0;
  c.cmd.hoist = -1;
  run(c, w, 40, () => {
    landed = Math.max(landed, c.events.landed);
    return c.resting;
  });
  c.cmd.hoist = 0;
  run(c, w, 2);
  assert.ok(c.resting, 'it stands');
  assert.ok(Math.abs(c.hook.y - c.drop() - 6) < 0.02, `on the platform: bottom at ${(c.hook.y - c.drop()).toFixed(3)}`);
  assert.ok(landed > 0 && landed < 0.5, `set down gently near the platform: ${landed.toFixed(2)} m/s`);
  // run the trolley in: the load hits the wall in its way
  c.cmd.hoist = 1;
  run(c, w, 3);
  c.cmd.hoist = 0;
  c.cmd.boom = -1;
  let hit = 0;
  let nearest = -Infinity;
  run(c, w, 8, () => {
    hit = Math.max(hit, c.events.hit);
    nearest = Math.max(nearest, c.hook.z + c.footprint()[1]);
  });
  assert.ok(hit > 0.05, `it ran into the wall (${hit.toFixed(2)} m/s)`);
  assert.ok(nearest <= -10.2 + 0.03, `and does not pass through it (its near face at ${nearest.toFixed(3)})`);
});

test('every crane is built: its chart has what its tasks need, the hook hangs below the head at the start', () => {
  for (const type of ['tower', 'mobile', 'loader'] as CraneType[]) {
    const c = new Crane(type);
    c.place(10, 5, -3, 0.4);
    assert.ok(c.hook.y < c.head.y, `${type}: the hook below the head`);
    assert.ok(Number.isFinite(c.radius()));
  }
  assert.ok(TOWER_GEOMETRY.trolleyMax <= TOWER_GEOMETRY.jibLength);
});
