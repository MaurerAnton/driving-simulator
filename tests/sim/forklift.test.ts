// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The forklift (src/sim/forklift.ts): the load moment and the load chart,
 * tipping forwards (too heavy, braked hard with the load high) and sideways
 * (turned hard with the load high), the forks sliding into a pallet and
 * lifting it, a misaligned or too high approach that does not take it, and
 * setting a pallet down on a rack's beams.
 *
 *   node --test tests/sim/forklift.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FORKLIFT, Forklift, capacityAt, engagement, euroPallet, stability } from '../../src/sim/forklift.ts';
import type { ForkCommand, ForkWorld, Pallet, Shelf } from '../../src/sim/forklift.ts';

const idle = (): ForkCommand => ({ throttle: 0, brake: 0, dir: 1, hold: false, steer: 0, lift: 0, tilt: 0, shift: 0 });

function world(pallets: Pallet[], shelves: Shelf[] = []): ForkWorld {
  return { ground: () => 0, obstacles: [], shelves, pallets };
}

function pallet(id: string, x: number, z: number, yaw = 0, mass = 600, y = 0): Pallet {
  return { id, def: euroPallet(1.0, mass), x, y, z, yaw, fork: null, on: 'ground' };
}

/** Steps for a while (1/120 s), with the command made each step; stops early when `until` says so. */
function run(f: Forklift, w: ForkWorld, seconds: number, cmd: (t: number) => Partial<ForkCommand>, until?: () => boolean): void {
  const dt = 1 / 120;
  for (let t = 0; t < seconds; t += dt) {
    f.step(dt, { ...idle(), ...cmd(t) }, w);
    if (until?.()) return;
  }
}

/** The pallet's middle this far ahead of a forklift at the origin facing north (its heel at z = −1.295). */
const heelZ = -(FORKLIFT.wheelbase / 2 + FORKLIFT.heelAhead);

test('the load chart: the rated load at the rated centre, less further out', () => {
  assert.equal(Math.round(capacityAt(0.5)), 2500);
  assert.ok(capacityAt(0.6) < 2500 && capacityAt(0.6) > 2200);
  assert.equal(Math.round(capacityAt(0.3)), 2500);
});

test('the rated load stands, braked gently low; a load far over it lifts the rear wheels', () => {
  const ahead = FORKLIFT.heelAhead + 0.5;
  const rated = stability({ mass: 2500, ahead, height: 0.6, decel: 0, lateral: 0 });
  assert.ok(rated.forward < 0.75, `rated ${rated.forward}`);
  const braked = stability({ mass: 2500, ahead, height: 0.6, decel: 2, lateral: 0 });
  assert.ok(braked.forward < 1, `braked low ${braked.forward}`);
  const high = stability({ mass: 2500, ahead, height: 3.6, decel: 2, lateral: 0 });
  assert.ok(high.forward > 1, `braked high ${high.forward}`);
  const heavy = stability({ mass: 3800, ahead: FORKLIFT.heelAhead + 0.6, height: 0.6, decel: 0, lateral: 0 });
  assert.ok(heavy.forward > 1, `3.8 t ${heavy.forward}`);
});

test('sideways: a load high up makes it tip at less lateral acceleration than empty', () => {
  const empty = stability({ mass: 0, ahead: 0, height: 0, decel: 0, lateral: 3.2 });
  const high = stability({ mass: 1500, ahead: 1.07, height: 3.6, decel: 0, lateral: 3.2 });
  assert.ok(empty.side < 1, `empty ${empty.side}`);
  assert.ok(high.side > 1, `high ${high.side}`);
});

test('the forks slide into a pallet square ahead, lift it, carry it and set it down on a rack', () => {
  const p = pallet('a', 0, heelZ - 0.6 - 2.0);
  // a rack's beams 1.6 m up, a little further on
  const shelf: Shelf = { id: 'rack', x: 0, z: heelZ - 6, hx: 1.1, hz: 0.55, yaw: 0, y0: 1.48, y1: 1.6, y: 1.6 };
  const w = world([p], [shelf]);
  const f = new Forklift();
  f.place(0, 0, 0, 0);
  // forwards slowly with the forks down, until it stops at the pallet
  run(f, w, 12, () => ({ throttle: 0.3 }), () => engagement(f.forks(), p).depth > 0.97);
  const e = engagement(f.forks(), p);
  assert.ok(e.fits && e.depth > 0.9, `fits ${e.fits} depth ${e.depth}`);
  // stop, lift: it is taken
  run(f, w, 2, () => ({ brake: 1 }));
  run(f, w, 1, () => ({ lift: 1 }));
  assert.equal(f.load, p);
  assert.ok(p.y > 0.2, `lifted ${p.y}`);
  // up over the beams, forwards over them, lowered: set down on them
  run(f, w, 6, () => ({ lift: 1 }), () => p.y > 1.75);
  const z0 = f.z;
  run(f, w, 20, () => ({ throttle: 0.2 }), () => p.z < shelf.z + 0.05);
  assert.ok(f.z < z0 - 1, 'it drove on');
  run(f, w, 2, () => ({ brake: 1 }));
  run(f, w, 3, () => ({ lift: -1 }));
  assert.equal(f.load, null);
  assert.equal(p.on, 'rack');
  assert.ok(Math.abs(p.y - 1.6) < 1e-9, `on the beams ${p.y}`);
  // the forks go on down, out of the pallet: it stays
  assert.ok(f.lift < 1.6 - 0.1);
  run(f, w, 4, () => ({ dir: -1, throttle: 0.3 }));
  assert.equal(p.on, 'rack');
  assert.equal(engagement(f.forks(), p).depth, 0);
});

test('a pallet at an angle or forks too high: it is not taken, the forks run into it', () => {
  for (const [yaw, lift] of [
    [0.35, FORKLIFT.liftMin],
    [0, 0.4],
  ]) {
    const p = pallet('b', 0, heelZ - 0.6 - 1.5, yaw);
    const w = world([p]);
    const f = new Forklift();
    f.place(0, 0, 0, 0);
    f.lift = lift;
    let hit = 0;
    run(f, w, 8, () => ({ throttle: 0.3 }), () => {
      hit = Math.max(hit, f.ev.hit);
      return f.ev.hit > 0;
    });
    assert.ok(hit > 0, `yaw ${yaw} lift ${lift}: stopped`);
    run(f, w, 2, () => ({ lift: 1 }));
    assert.equal(f.load, null);
  }
});

test('too heavy: lifted, the rear comes up and it tips forwards', () => {
  const p = pallet('h', 0, heelZ - 0.6 - 0.5, 0, 3900);
  const w = world([p]);
  const f = new Forklift();
  f.place(0, 0, 0, 0);
  run(f, w, 6, () => ({ throttle: 0.3 }), () => engagement(f.forks(), p).depth > 0.97);
  run(f, w, 1, () => ({ brake: 1 }));
  let rear = false;
  run(f, w, 8, () => ({ lift: 1 }), () => {
    rear ||= f.ev.rearLift;
    return f.tipped !== null;
  });
  assert.ok(rear, 'the rear wheels lifted');
  assert.equal(f.tipped, 'forward');
});

test('a light load stays down; braked hard with the forks high it tips forwards, low it does not', () => {
  const trial = (high: boolean): Forklift => {
    const p = pallet('c', 0, heelZ - 0.6 - 0.3, 0, 2000);
    const w = world([p]);
    const f = new Forklift();
    f.place(0, 0, 0, 0);
    run(f, w, 6, () => ({ throttle: 0.3 }), () => engagement(f.forks(), p).depth > 0.97);
    run(f, w, 1, () => ({ brake: 1 }));
    run(f, w, 8, () => ({ lift: 1 }), () => f.lift >= (high ? FORKLIFT.liftMax - 0.01 : 0.3));
    assert.equal(f.load, p);
    assert.equal(f.pitch, 0, 'standing, it stays on its wheels');
    // backwards up to speed, then the brake hard (the load is thrown forwards: away from the way it went)
    run(f, w, 6, () => ({ dir: 1, throttle: 1 }), () => f.v > 4.5);
    run(f, w, 4, () => ({ brake: 1, throttle: 0 }), () => f.tipped !== null);
    return f;
  };
  assert.equal(trial(false).tipped, null);
  assert.equal(trial(true).tipped, 'forward');
});

test('turning at full lock at walking pace: empty it stays up; with a load high up it goes over sideways', () => {
  const spin = (load: boolean): Forklift => {
    const p = pallet('d', 0, heelZ - 0.6 - 0.3, 0, 2000);
    const w = world(load ? [p] : []);
    const f = new Forklift();
    f.place(0, 0, 0, 0);
    if (load) {
      run(f, w, 6, () => ({ throttle: 0.3 }), () => engagement(f.forks(), p).depth > 0.97);
      run(f, w, 1, () => ({ brake: 1 }));
      run(f, w, 10, () => ({ lift: 1 }), () => f.lift >= FORKLIFT.liftMax - 0.01);
    }
    run(f, w, 5, () => ({ throttle: 0.6 }), () => f.v > 1.0);
    // (the curve speed control holds it to about 1 m/s at full lock)
    run(f, w, 6, () => ({ throttle: 0.6, steer: 1 }), () => f.tipped !== null);
    return f;
  };
  const empty = spin(false);
  assert.equal(empty.tipped, null);
  assert.ok(Math.abs(empty.aLat) > 2.5, `it did turn hard: ${empty.aLat}`);
  assert.equal(spin(true).tipped, 'side');
});

test('turning sharply at full speed throws even an empty forklift over', () => {
  const f = new Forklift();
  const w = world([]);
  f.place(0, 0, 0, 0);
  run(f, w, 6, () => ({ throttle: 1 }), () => f.v > 5.2);
  run(f, w, 3, () => ({ throttle: 1, steer: -1 }), () => f.tipped !== null);
  assert.equal(f.tipped, 'side');
  assert.equal(f.rollSide, 1, 'turning left, it falls outwards: to the right');
});
