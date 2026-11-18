// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The flying free camera (game/flycam.ts): it flies the way it looks, to the
 * side, up and down; the wheel sets its speed in steps; it keeps above the
 * ground.
 *
 *   node --test tests/game/flycam.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FLY_MAX_STEP, FlyCam } from '../../src/game/flycam.ts';
import type { FlyInput } from '../../src/game/flycam.ts';

const idle = (): FlyInput => ({ yaw: 0, pitch: 0, right: 0, fwd: 0, keyFwd: 0, keyRight: 0, keyUp: 0, fast: false, lift: 0, speed: 0 });
const flat = (): number => 0;

/** `secs` seconds with the keys held as `held` asks (key time = dt each picture) */
function fly(c: FlyCam, secs: number, held: Partial<FlyInput>, ground = flat): void {
  const dt = 1 / 50;
  for (let i = 0; i < secs * 50; i++) {
    const t = idle();
    t.keyFwd = (held.keyFwd ?? 0) * dt;
    t.keyRight = (held.keyRight ?? 0) * dt;
    t.keyUp = (held.keyUp ?? 0) * dt;
    t.fast = held.fast ?? false;
    c.update(dt, t, ground);
  }
}

test('forwards the way it looks: north, and down when it looks down', () => {
  const c = new FlyCam();
  c.start(0, 50, 0, 0, 0, -1);
  fly(c, 2, { keyFwd: 1 });
  assert.ok(c.z < -15 && Math.abs(c.x) < 1e-6 && Math.abs(c.y - 50) < 1e-6, `${c.x} ${c.y} ${c.z}`);
  const d = new FlyCam();
  d.start(0, 50, 0, 0, -1, -1);
  fly(d, 2, { keyFwd: 1 });
  assert.ok(d.y < 40 && d.z < -10);
});

test('to the side and straight up; shift: four times as fast', () => {
  const c = new FlyCam();
  c.start(0, 20, 0, 0, 0, -1);
  fly(c, 2, { keyRight: 1 });
  assert.ok(c.x > 15 && Math.abs(c.z) < 1e-6);
  const u = new FlyCam();
  u.start(0, 20, 0, 0, 0, -1);
  fly(u, 2, { keyUp: 1 });
  assert.ok(u.y > 35);
  const a = new FlyCam();
  const b = new FlyCam();
  a.start(0, 100, 0, 0, 0, -1);
  b.start(0, 100, 0, 0, 0, -1);
  fly(a, 3, { keyFwd: 1 });
  fly(b, 3, { keyFwd: 1, fast: true });
  assert.ok(Math.abs(b.z / a.z - 4) < 0.2, `${a.z} ${b.z}`);
});

test('the wheel: speed in steps of √2, within its bounds', () => {
  const c = new FlyCam();
  const s0 = c.speed;
  const t = idle();
  t.speed = 2;
  assert.equal(c.update(0.02, t, flat), true);
  assert.ok(Math.abs(c.speed / s0 - 2) < 1e-9);
  assert.equal(c.update(0.02, idle(), flat), false);
  t.speed = 100;
  c.update(0.02, t, flat);
  assert.equal(c.step, FLY_MAX_STEP);
  t.speed = -100;
  c.update(0.02, t, flat);
  assert.ok(c.speed >= 1.5 && c.speed < 1.6);
});

test('it keeps above the ground – and flies on where nothing is loaded', () => {
  const c = new FlyCam();
  c.start(0, 5, 0, 0, -1, 0);
  fly(c, 3, { keyFwd: 1 }, () => 2);
  assert.ok(Math.abs(c.y - 2.5) < 1e-6);
  const n = new FlyCam();
  n.start(0, 5, 0, 0, 0, -1);
  fly(n, 1, { keyFwd: 1 }, () => NaN);
  assert.ok(n.z < -5 && Number.isFinite(n.z));
});
