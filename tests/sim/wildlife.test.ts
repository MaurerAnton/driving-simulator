// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Deer and wild boar on the country roads (sim/wildlife.ts): only at dusk
 * and at night, only outside towns where a forest meets the road ahead;
 * out of the forest, a moment at its edge, across and away – obstacles for
 * the traffic while they are at the road; gone again, and a while before
 * the next.
 *
 *   node --test tests/sim/wildlife.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { COVER } from '../../src/world/cover.ts';
import { Wildlife } from '../../src/sim/wildlife.ts';
import type { WildHost, WildRoad } from '../../src/sim/wildlife.ts';

/** A straight road north–south along x = 0, 7 m wide; forest on the east side (x > 6) where `forest`; a town where `town`. */
function host(o: { sun: number; forest?: boolean; town?: boolean }): WildHost {
  return {
    sun: () => o.sun,
    coverAt: (x) => (o.forest !== false && x > 6 ? COVER.FOREST : COVER.FARMLAND),
    heightAt: () => 200,
    road: (x: number, z: number, reach: number, out: WildRoad) => {
      if (Math.abs(x) > reach + 3.5) return false;
      out.x = 0;
      out.z = z;
      out.dx = 0;
      out.dz = -1;
      out.half = 3.5;
      out.rural = !o.town;
      return true;
    },
  };
}

/** Driving north along the road at 20 m/s for `secs` seconds; what was seen. */
function drive(w: Wildlife, secs: number): { spawned: number; boxes: number; crossed: number; maxX: number; minX: number } {
  const p = { x: 1.75, z: 0, yaw: 0, speed: 20 };
  let spawned = 0;
  let boxes = 0;
  let crossed = 0;
  let maxX = -Infinity;
  let minX = Infinity;
  let had = 0;
  for (let t = 0; t < secs; t += 0.05) {
    w.update(0.05, p);
    p.z -= p.speed * 0.05;
    if (w.animals.length > had) spawned += w.animals.length - had;
    had = w.animals.length;
    boxes = Math.max(boxes, w.boxes.length);
    for (const a of w.animals) {
      maxX = Math.max(maxX, a.x);
      minX = Math.min(minX, a.x);
      if (a.phase === 'away') crossed++;
    }
  }
  return { spawned, boxes, crossed, maxX, minX };
}

/** A fixed sequence of "random" numbers: always below the chance, so every look finds animals. */
const always = (): number => 0.01;

test('none by day, none in town, none without a forest', () => {
  assert.equal(drive(new Wildlife(host({ sun: 30 }), always), 60).spawned, 0, 'by day');
  assert.equal(drive(new Wildlife(host({ sun: -3, town: true }), always), 60).spawned, 0, 'in town');
  assert.equal(drive(new Wildlife(host({ sun: -3, forest: false }), always), 60).spawned, 0, 'without a forest');
});

test('at dusk by a forest: out of it, across the road and away to the other side – obstacles meanwhile', () => {
  const w = new Wildlife(host({ sun: -3 }), always);
  const r = drive(w, 40);
  assert.ok(r.spawned >= 1, 'animals came');
  assert.ok(r.maxX > 10, 'out of the forest on the east');
  assert.ok(r.minX < -10, 'over to the west');
  assert.ok(r.crossed > 0, 'and away');
  assert.ok(r.boxes >= 1, 'the traffic sees them');
});

test('they come ahead of the car, stand a moment at the edge, and run', () => {
  const w = new Wildlife(host({ sun: -10 }), always);
  const p = { x: 1.75, z: 0, yaw: 0, speed: 20 };
  let first: { z: number } | null = null;
  let waited = 0;
  let fastest = 0;
  for (let t = 0; t < 20; t += 0.05) {
    w.update(0.05, p);
    p.z -= p.speed * 0.05;
    const a = w.animals[0];
    if (!a) continue;
    first ??= { z: a.z - p.z };
    if (a.phase === 'wait') waited += 0.05;
    fastest = Math.max(fastest, a.speed);
  }
  assert.ok(first && first.z < -60 && first.z > -160, `ahead of the car (${first?.z.toFixed(0)} m)`);
  assert.ok(waited > 0.15, 'a moment at the edge');
  assert.ok(fastest > 3.5 && fastest < 10.5, `running at ${fastest.toFixed(1)} m/s`);
});

test('rarely: with ordinary chance, a long drive by a forest at night sees few groups; a pause after each', () => {
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const w = new Wildlife(host({ sun: -12 }), rnd);
  const r = drive(w, 600);
  // (ten minutes of forest at night: a look every 2.5 s, 5 % each, at least 100 s apart – a handful)
  assert.ok(r.spawned <= 3 * 6, `${r.spawned} animals in ten minutes`);
  const off = new Wildlife(host({ sun: -3 }), always);
  off.enabled = false;
  assert.equal(drive(off, 30).spawned, 0, 'switched off');
});

test('gone when the car is far away, and cleared with the traffic', () => {
  const w = new Wildlife(host({ sun: -3 }), always);
  const p = { x: 1.75, z: 0, yaw: 0, speed: 20 };
  for (let t = 0; t < 6 && w.animals.length === 0; t += 0.05) w.update(0.05, p);
  assert.ok(w.animals.length > 0);
  w.update(0.05, { ...p, z: 2000 });
  assert.equal(w.animals.length, 0);
  for (let t = 0; t < 6 && w.animals.length === 0; t += 0.05) w.update(0.05, p);
  assert.equal(w.animals.length, 0, 'a while before the next');
  w.clear();
  assert.equal(w.boxes.length, 0);
});
