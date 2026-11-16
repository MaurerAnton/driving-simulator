// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { Navigator, connectorsAlong } from '../../src/game/nav.ts';
import { planTour } from '../../src/game/tour.ts';
import { TURN } from '../../src/world/lanes.ts';
import type { Lane } from '../../src/world/lanes.ts';
import { quickest, routeGraphOf, wayOf } from '../../src/world/routegraph.ts';
import type { RouteGraph } from '../../src/world/routegraph.ts';
import { makeTown } from './town.ts';

/** Is each way of the list reached from the one before by a turn the junction allows (and none of them by turning round)? */
function chained(g: RouteGraph, start: number, ways: number[]): boolean {
  let cur = start;
  for (const w of ways) {
    let ok = false;
    for (let k = g.first[cur]; k < g.first[cur + 1]; k++) if (g.to[k] === w && g.turn[k] !== TURN.UTURN) ok = true;
    if (!ok) return false;
    cur = w;
  }
  return true;
}

test('the route graph has a way for each direction a street can be driven in', () => {
  const town = makeTown({ oneWay: [[0, 0, 1, 0]] });
  const g = routeGraphOf(town.lanes);
  assert.equal(g.n, town.world.edges.length * 2);
  const one = town.street(0, 0, 1, 0);
  assert.ok(g.len[one * 2] > 0, 'the one-way street can be driven its way');
  assert.equal(g.len[one * 2 + 1], 0, 'and not against it');
  const two = town.street(1, 1, 2, 1);
  assert.ok(g.len[two * 2] > 0 && g.len[two * 2 + 1] > 0);
  // every turn is listed from both sides
  assert.equal(g.from.length, g.to.length);
  for (let w = 0; w < g.n; w++) for (let p = g.firstIn[w]; p < g.firstIn[w + 1]; p++) assert.equal(g.to[g.inTurn[p]], w);
});

test('the quickest route leads from one street to another along connected ways', () => {
  const town = makeTown();
  const g = routeGraphOf(town.lanes);
  const from = town.street(0, 0, 1, 0) * 2;
  const to = town.street(2, 3, 3, 3) * 2;
  const r = quickest(g, from, to);
  assert.ok(r && r.length >= 4, 'a route across the town');
  assert.equal(r[r.length - 1], to);
  let cur = from;
  for (const w of r) {
    let ok = false;
    for (let k = g.first[cur]; k < g.first[cur + 1]; k++) if (g.to[k] === w) ok = true;
    assert.ok(ok, 'each way follows the one before');
    cur = w;
  }
});

test('a round trip leads through many streets once and back to where it began', () => {
  const town = makeTown({ cols: 6, rows: 6 });
  const g = routeGraphOf(town.lanes);
  const start = town.street(2, 2, 3, 2) * 2;
  const plan = planTour(g, start, start, 3000, { seed: 5, budgetMs: 150 });
  assert.ok(plan, 'a tour is found');
  assert.ok(plan.ways.length > 10);
  assert.equal(plan.ways[plan.ways.length - 1], start, 'it ends on the street it started from');
  assert.ok(chained(g, start, plan.ways), 'no turn that is not allowed, no turning round');
  assert.ok(plan.metres <= 3000 + 1, `not longer than asked for (${plan.metres.toFixed(0)} m)`);
  assert.ok(plan.metres >= 2400, `and not much shorter (${plan.metres.toFixed(0)} m)`);
  assert.ok(Math.abs(plan.fresh + plan.again - plan.metres) < 1);
  assert.ok(plan.fresh / plan.metres > 0.75, `mostly along new streets (${((plan.fresh / plan.metres) * 100).toFixed(0)} %)`);
  // the same seed plans the same tour
  const again = planTour(g, start, start, 3000, { seed: 5, budgetMs: 150 });
  assert.ok(again && again.fresh >= plan.fresh * 0.9);
});

test('a tour to another street ends there, and never enters a street it could only leave by turning round', () => {
  const town = makeTown({ cols: 5, rows: 4, deadEnd: 120 });
  const g = routeGraphOf(town.lanes);
  const start = town.street(0, 0, 1, 0) * 2;
  const goal = town.street(3, 3, 4, 3) * 2;
  const plan = planTour(g, start, goal, 2500, { seed: 2, budgetMs: 150 });
  assert.ok(plan);
  assert.equal(plan.ways[plan.ways.length - 1], goal);
  assert.ok(chained(g, start, plan.ways));
  const culDeSac = town.world.edges.length - 1;
  assert.ok(!plan.ways.some((w) => w >> 1 === culDeSac), 'the cul-de-sac is left out');
  // streets that are known already are nothing new
  const known = planTour(g, start, goal, 2500, { seed: 2, budgetMs: 100, known: () => true });
  assert.ok(known && known.fresh === 0);
  // asked for less than the way there takes: the way there it is
  const short = planTour(g, start, goal, 100, { seed: 2, budgetMs: 50 });
  assert.ok(short && short.ways[short.ways.length - 1] === goal && short.metres > 100);
});

test('a planned tour becomes lanes and paths through the junctions, and the navigation follows it to its end', () => {
  const town = makeTown({ cols: 5, rows: 5 });
  const g = routeGraphOf(town.lanes);
  const first = town.lanes.edgeLanes[town.street(1, 1, 2, 1)].fwd[0];
  const start = wayOf(first);
  const plan = planTour(g, start, start, 2200, { seed: 9, budgetMs: 150 });
  assert.ok(plan && plan.ways.length > 6);
  const path = connectorsAlong(town.lanes, plan.ways, first);
  assert.ok(path, 'the ways are connected lane by lane');
  assert.equal(path.length, plan.ways.length);
  let lane: Lane = first;
  for (let i = 0; i < path.length; i++) {
    assert.equal(wayOf(path[i].from), wayOf(lane), 'each path leaves the road the one before led onto');
    assert.equal(wayOf(path[i].to), plan.ways[i]);
    lane = path[i].to;
  }
  // drive it: the tour passes its first street again only at the very end – it is not over before
  const nav = new Navigator(town.lanes);
  nav.setPath(path, first);
  let h = nav.update(0.1, first, 1);
  assert.equal(h.done, false, 'standing on the street the tour ends on, at its start: not arrived');
  for (let i = 0; i < path.length; i++) {
    h = nav.update(0.1, path[i].to, 1);
    assert.equal(h.done, i === path.length - 1, `arrived exactly at the end (junction ${i + 1} of ${path.length})`);
  }
});

test('whoever leaves a tour is led back onto it', () => {
  const town = makeTown({ cols: 5, rows: 5 });
  const g = routeGraphOf(town.lanes);
  const first = town.lanes.edgeLanes[town.street(1, 1, 2, 1)].fwd[0];
  const plan = planTour(g, wayOf(first), wayOf(first), 2200, { seed: 9, budgetMs: 150 });
  assert.ok(plan);
  const path = connectorsAlong(town.lanes, plan.ways, first);
  assert.ok(path);
  const nav = new Navigator(town.lanes);
  nav.setPath(path, first);
  nav.update(0.1, first, 1);
  // a wrong turn at the first junction
  const wrong = first.out.find((c) => c !== path[0] && c.turn !== TURN.UTURN);
  assert.ok(wrong, 'there is another way to go at the first junction');
  for (let t = 0; t < 2; t += 0.1) nav.update(0.1, wrong.to, 1);
  const route = nav.route;
  assert.ok(route && route.length > 0 && wayOf(route[0].from) === wayOf(wrong.to), 'a new route from where the car is now');
  const tail = route.slice(-5);
  assert.deepEqual(tail, path.slice(-5), 'which joins the tour again and follows it to its end');
});

test('a tour may begin and end on a car park that tours do not otherwise lead through', async () => {
  const { RG } = await import('../../src/world/routegraph.ts');
  const town = makeTown({ cols: 5, rows: 5 });
  const g = routeGraphOf(town.lanes);
  // two streets in a row become the aisles of a car park (to get somewhere, not to drive through)
  const aisle = [town.street(0, 0, 1, 0), town.street(1, 0, 2, 0)];
  for (const e of aisle) for (const d of [0, 1]) g.kind[e * 2 + d] |= RG.ACCESS_ONLY;
  const start = aisle[0] * 2;
  const plan = planTour(g, start, start, 2000, { seed: 4, budgetMs: 120 });
  assert.ok(plan && plan.ways.length > 5, 'a tour is found from the car park');
  assert.equal(plan.ways[plan.ways.length - 1], start, 'and ends there');
  assert.ok(chained(g, start, plan.ways));
  assert.ok(plan.fresh > 1000);
  // another car park elsewhere is not driven through
  const other = town.street(3, 3, 4, 3);
  for (const d of [0, 1]) g.kind[other * 2 + d] |= RG.ACCESS_ONLY;
  const plan2 = planTour(g, start, start, 3000, { seed: 4, budgetMs: 120 });
  assert.ok(plan2 && !plan2.ways.some((w) => w >> 1 === other));
});

test('wishes: a road left out is never driven; the kind of street wished for gets most of the tour', () => {
  const town = makeTown({ cols: 6, rows: 6 });
  const g = routeGraphOf(town.lanes);
  const start = town.street(2, 2, 3, 2) * 2;
  // the streets of the middle row (z = 200) are left out: the tour goes round them
  const middle = new Set<number>();
  for (let i = 0; i < 5; i++) middle.add(town.street(i, 2, i + 1, 2));
  middle.delete(town.street(2, 2, 3, 2));
  const plan = planTour(g, start, start, 2600, { seed: 3, budgetMs: 150, avoid: (w) => middle.has(w >> 1) });
  assert.ok(plan, 'a tour all the same');
  assert.ok(!plan.ways.some((w) => middle.has(w >> 1)), 'none of the streets left out is driven');
  // the streets of the east of the town wished for – or those of the west: the tour goes where it is wished
  const east = (e: number): boolean => Math.min(g.x1[e * 2], g.x1[e * 2 + 1]) >= 300;
  const west = (e: number): boolean => Math.max(g.x1[e * 2], g.x1[e * 2 + 1]) <= 200;
  const liked = planTour(g, start, start, 2600, { seed: 3, budgetMs: 150, like: (e) => (east(e) ? 2.5 : 0.3) });
  const plain = planTour(g, start, start, 2600, { seed: 3, budgetMs: 150, like: (e) => (west(e) ? 2.5 : 0.3) });
  assert.ok(liked && plain);
  const share = (p: NonNullable<typeof liked>): number => {
    let inEast = 0;
    let all = 0;
    for (const w of p.ways) {
      all += g.len[w];
      if (east(w >> 1)) inEast += g.len[w];
    }
    return inEast / all;
  };
  assert.ok(share(liked) > share(plain) + 0.4, `wished east: ${(share(liked) * 100).toFixed(0)} % in the east; wished west: ${(share(plain) * 100).toFixed(0)} %`);
});
