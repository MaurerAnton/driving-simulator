// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The set routes (game/routepresets.ts): the watch over the route (leaving
 * it, driving it the other way), the mode that starts one from the menu –
 * and, on the real map, every route planned as a round trip of sensible
 * length through what it is about.
 *
 *   node --test tests/game/routepresets.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE_PRESETS, RouteWatch, planPreset, presetOfMode, routeLine, routeMode, snapPoint } from '../../src/game/routepresets.ts';
import { RG } from '../../src/world/routegraph.ts';
import { haveMap, openRealMap } from '../realmap.ts';

test('the watch: on the route nothing; off it a fault once per leaving; against it a bigger one', () => {
  // the route: ways 10 (start), 12, 14, 16 – each road's other direction is way ^ 1
  const w = new RouteWatch(10, [12, 14, 16]);
  let odo = 0;
  const drive = (way: number, metres: number): string[] => {
    const out: string[] = [];
    for (let m = 0; m < metres; m += 5) {
      odo += 5;
      const f = w.update(way, odo);
      if (f) out.push(f);
    }
    return out;
  };
  assert.deepEqual(drive(10, 100), []);
  assert.deepEqual(drive(12, 100), []);
  // through a junction (no road) and a few metres onto another road: not yet leaving
  assert.deepEqual(drive(-1, 20), []);
  assert.deepEqual(drive(40, 30), []);
  assert.deepEqual(drive(14, 50), [], 'back on it in time');
  // off it for good: one fault, however long
  assert.deepEqual(drive(40, 300), ['routeLeft']);
  assert.deepEqual(drive(42, 300), [], 'still off: said once');
  assert.deepEqual(drive(14, 30), []);
  // turned round: along the route the wrong way
  assert.deepEqual(drive(15, 20), [], 'turning takes a few metres');
  assert.deepEqual(drive(15, 200), ['routeReverse']);
  assert.deepEqual(drive(14, 10), []);
  assert.deepEqual(drive(50, 100), ['routeLeft'], 'a new leaving after being back on it');
});

test('a set route is started from the menu by its mode', () => {
  for (const p of ROUTE_PRESETS) {
    assert.equal(presetOfMode(routeMode(p.id)), p);
    assert.ok(p.points.length >= 3, `${p.id}: a round trip through several places`);
  }
  assert.equal(presetOfMode('free'), null);
  assert.equal(presetOfMode('route:nowhere'), null);
  assert.equal(new Set(ROUTE_PRESETS.map((p) => p.id)).size, ROUTE_PRESETS.length);
});

test('on the real map: every set route is a round trip of sensible length through what it is about', { skip: !haveMap && 'no map (public/map or MAP_DIR)' }, async () => {
  const r = await openRealMap();
  assert.ok(r.index, 'the map comes with the network of the whole map');
  const g = r.index.graph;
  const main = r.index.main;
  for (const p of ROUTE_PRESETS) {
    const start = snapPoint(g, p.points[0], main)[0];
    assert.ok(start >= 0, `${p.id}: its first place lies on a road`);
    const plan = planPreset(g, start, p, main);
    assert.ok(plan, `${p.id}: planned`);
    // a drive of a driving test or a bit more: 10 to 35 km
    assert.ok(plan.metres > 10000 && plan.metres < 35000, `${p.id}: ${Math.round(plan.metres)} m`);
    assert.equal(plan.at.length, p.points.length + 1, `${p.id}: every place passed, and the first again`);
    // the ways follow each other: each one begins where the one before ends
    let prev = start;
    for (const w of plan.ways) {
      let joined = false;
      for (let k = g.first[prev]; k < g.first[prev + 1]; k++) if (g.to[k] === w) joined = true;
      assert.ok(joined, `${p.id}: way ${prev} → ${w}`);
      assert.equal(g.kind[w] & RG.NO_ENTRY, 0, `${p.id}: no private roads`);
      prev = w;
    }
    // back to where it began
    assert.equal(plan.ways[plan.ways.length - 1] >> 1, start >> 1, `${p.id}: a round trip`);
    let motorway = 0;
    for (const w of plan.ways) if (g.cls[w] === 0) motorway += g.len[w];
    if (p.id === 'motorway') assert.ok(motorway > 3000, `on the A 49: ${Math.round(motorway)} m`);
    if (p.id === 'baunatal' || p.id === 'kasselCentre' || p.id === 'hills') assert.equal(motorway, 0, `${p.id}: no motorway`);
    const line = routeLine(g, start, plan.ways);
    assert.ok(line.length >= 4 * (plan.ways.length + 1));
  }
});
