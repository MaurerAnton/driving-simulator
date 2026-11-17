// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The forklift's drive besides the forklift itself (src/game/forkliftmodes.ts):
 * its cameras go round – the view from the side it starts with among them –,
 * where the operator stands after getting off, and from how far one gets on
 * again; and the camera circling a vehicle resting beside it, not behind it
 * (Input.orbitRest, src/input/input.ts).
 *
 *   node --test tests/game/forkliftmodes.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FORK_SIDE_YAW, FORK_VIEWS, FORK_WORK_MODE, forkCamera, forkliftExit, nearForklift, nextForkView } from '../../src/game/forkliftmodes.ts';
import type { ForkView } from '../../src/game/forkliftmodes.ts';

test('the camera key goes through every view and back to the side view the drive starts with', () => {
  let v: ForkView = 'side';
  const seen: ForkView[] = [];
  for (let i = 0; i < FORK_VIEWS.length; i++) {
    seen.push(v);
    v = nextForkView(v);
  }
  assert.equal(v, 'side');
  assert.deepEqual(seen, ['side', 'cockpit', 'chase', 'free']);
  // (twice round: still the same order)
  for (let i = 0; i < FORK_VIEWS.length * 2; i++) v = nextForkView(v);
  assert.equal(v, 'side');
});

test('the side view is the camera circling the forklift, resting on its left a little ahead; the others are the game\'s own', () => {
  const s = forkCamera('side');
  assert.equal(s.mode, 'chase');
  assert.equal(s.rest, FORK_SIDE_YAW);
  // (the chase camera stands at (sin r, cos r) turned by the heading: 0 behind, so −π/2 … −π is left and ahead)
  assert.ok(Math.sin(s.rest) < -0.8, 'on the left');
  assert.ok(Math.cos(s.rest) < 0, 'a little ahead of the middle');
  assert.deepEqual(forkCamera('cockpit'), { mode: 'cockpit', rest: 0 });
  assert.deepEqual(forkCamera('chase'), { mode: 'chase', rest: 0 });
  assert.deepEqual(forkCamera('free'), { mode: 'free', rest: 0 });
});

test('getting off: beside the seat on the left, clear of the forklift, facing its way; on again only from near by', () => {
  for (const yaw of [0, 0.7, Math.PI / 2, -2.2, Math.PI]) {
    const x = 120;
    const z = -40;
    const p = forkliftExit(x, z, yaw);
    // forwards (−sin, −cos), to the right (cos, −sin)
    const dx = p.x - x;
    const dz = p.z - z;
    const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const ahead = -dx * Math.sin(yaw) - dz * Math.cos(yaw);
    assert.ok(right < -0.9 && right > -2, `left of it (${right.toFixed(2)})`);
    assert.ok(Math.abs(ahead) < 1e-9);
    assert.equal(p.yaw, yaw);
    // (its half width is 0.58 m: the person stands clear of it – and can get on again from there)
    assert.ok(Math.hypot(dx, dz) > 0.58 + 0.3);
    assert.ok(nearForklift(x, z, p.x, p.z));
  }
  assert.equal(nearForklift(0, 0, 3, 0), true);
  assert.equal(nearForklift(0, 0, 4, 0), false);
  assert.equal(nearForklift(0, 0, 0, -12), false);
});

test('"Forklift work" has a mode of its own (the free drive is "free")', () => {
  assert.equal(FORK_WORK_MODE, 'forklift');
  assert.notEqual(FORK_WORK_MODE, 'free');
});

/** an Input with no page: listeners go nowhere, no gamepad */
async function bareInput(): Promise<import('../../src/input/input.ts').Input> {
  const g = globalThis as Record<string, unknown>;
  g.window ??= { addEventListener: () => {}, matchMedia: () => ({ matches: false }), innerWidth: 1280, innerHeight: 720 };
  const { Input } = await import('../../src/input/input.ts');
  const canvas = { addEventListener: () => {}, setPointerCapture: () => {} } as unknown as HTMLCanvasElement;
  return new Input(canvas, { invertLookY: false, wheel: { shifter: [] } } as never);
}

test('the camera circling the vehicle starts where it rests – beside it – and swings back there, not behind it', async () => {
  const input = await bareInput();
  input.resetLook(true, false, FORK_SIDE_YAW);
  assert.equal(input.orbit, true);
  assert.equal(input.c.lookYaw, FORK_SIDE_YAW);
  // standing: it stays beside it
  for (let i = 0; i < 300; i++) input.update(1 / 60, 0, 0);
  assert.ok(Math.abs(input.c.lookYaw - FORK_SIDE_YAW) < 1e-9);
  // driving after a look round (here: put behind it), nobody touching the view: back to the side, not behind it
  (input as unknown as { mouseLookYaw: number }).mouseLookYaw = 0;
  for (let i = 0; i < 600; i++) input.update(1 / 60, 4, 0);
  assert.ok(Math.abs(input.c.lookYaw - FORK_SIDE_YAW) < 0.02, `rests beside it (${input.c.lookYaw.toFixed(3)})`);
  // another camera: behind again as before
  input.resetLook(true);
  assert.equal(input.orbitRest, 0);
  assert.equal(input.c.lookYaw, 0);
  // the driver's head: no resting place but straight ahead
  input.resetLook(false, false, 1.2);
  assert.equal(input.orbitRest, 0);
  assert.equal(input.c.lookYaw, 0);
});

test("the forklift's layer over the whole view lets the mouse and the fingers through (#ui's children take them otherwise)", async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../../src/ui/forklift.css', import.meta.url), 'utf8');
  const main = await readFile(new URL('../../src/ui/style.css', import.meta.url), 'utf8');
  // (the rule that makes it necessary – and the one that answers it, as strong)
  assert.match(main, /#ui > \* \{ pointer-events: auto; \}/);
  assert.match(css, /#ui > \.fork-ui \{ pointer-events: none; \}/);
  assert.match(css, /\.fork-btns \{[^}]*pointer-events: auto/);
});
