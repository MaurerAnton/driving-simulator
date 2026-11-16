// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Start at / jump to an address: the search in the house numbers and the
 * spot on the road in front of a house – checked on the real map.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { projectOnPolyline } from '../../src/core/geom.ts';
import { AddressIndex, findRoadSpot, normaliseAddress } from '../../src/game/address.ts';
import type { AddressJson } from '../../src/game/address.ts';
import { findTarget } from '../../src/game/nav.ts';
import { LaneGraph } from '../../src/world/lanes.ts';
import type { Lane } from '../../src/world/lanes.ts';
import { CLS } from '../../src/world/types.ts';
import { haveMap, openRealMap } from '../realmap.ts';

// The real map (it is built or fetched, not part of the repository: without it these tests are skipped).
// Its road network may come in pieces: the tests look at the town the first start point lies in.
const opened = haveMap ? await openRealMap() : null;
const skip = opened ? false : 'the map is not there (see docs/MAP_DATA.md)';
const { map, world, lanes: graph } = opened ?? ({} as NonNullable<typeof opened>);
const main = (l: Lane): boolean => (opened ? opened.usable(l) : false);
const home = opened ? world.json.spawns[0] : { x: 0, z: 0 };
if (opened) await map.loadAround(home.x, home.z, 5200);
const addresses = opened ? ((await map.json<AddressJson>('addresses.json.gz')) ?? (await map.json<AddressJson>('addresses.json'))) : null;
const real = new AddressIndex(addresses ?? { version: 1, streets: [] });
/** how far a house lies from the start point the tests are held around */
const fromHome = (x: number, z: number): number => Math.hypot(x - home.x, z - home.z);

test('street names are compared the way people type them', () => {
  const same = (a: string, b: string): void => assert.equal(normaliseAddress(a), normaliseAddress(b), `${a} / ${b}`);
  same('Hauptstraße', 'hauptstrasse');
  same('Hauptstraße', 'Hauptstr.');
  same('Hauptstraße', 'HAUPTSTR');
  same('Brüder-Grimm-Straße', 'brueder grimm str');
  same('Brüder-Grimm-Straße', 'Bruder Grimm Strasse');
  same('Müllerweg', 'Muellerweg');
  same("Adams Ruh'", 'adams ruh');
  assert.equal(normaliseAddress('  Am   Stadtpark '), 'am stadtpark');
  assert.notEqual(normaliseAddress('Kirchweg'), normaliseAddress('Kirchstraße'));
});

test('search: street, house number, town – in any order', () => {
  const ix = new AddressIndex({
    version: 1,
    streets: [
      { n: 'Am Stadtpark', c: 'Baunatal', x: 10, z: 20, h: ['10', 1, 2, '10a', 3, 4, '2', 5, 6, '100', 7, 8, '1', 9, 10] },
      { n: 'Hauptstraße', c: 'Baunatal-Großenritte', x: 100, z: 200, h: ['5', 11, 12] },
      { n: 'Hauptstraße', c: 'Schauenburg', x: 300, z: 400, h: ['5', 13, 14, '7', 15, 16] },
      { n: 'Parkstraße', c: 'Baunatal', x: 50, z: 60, h: [] },
      { n: 'A 49', c: 'Kirchbauna', x: 70, z: 80, h: [] },
    ],
  });
  assert.equal(ix.size, 8);
  assert.equal(ix.streetCount, 5);
  const labels = (q: string, n = 8): string[] => ix.search(q, n).map((h) => h.label);
  assert.deepEqual(labels('am stadtpark 10a'), ['Am Stadtpark 10a, Baunatal']);
  assert.deepEqual(labels('10 a Am Stadtpark'), ['Am Stadtpark 10a, Baunatal'], 'number first, letter apart');
  assert.deepEqual(labels('stadtpark 10'), ['Am Stadtpark 10, Baunatal', 'Am Stadtpark 10a, Baunatal', 'Am Stadtpark 100, Baunatal'], 'the number itself, then its letters, then longer numbers');
  assert.deepEqual(labels('Am Stadtpark'), ['Am Stadtpark, Baunatal'], 'no number: the street');
  const hit = ix.search('am stadtpark 2')[0];
  assert.deepEqual([hit.x, hit.z, hit.exact, hit.street], [5, 6, true, 'Am Stadtpark']);
  // a number that does not exist: the street is offered instead
  const miss = ix.search('am stadtpark 77')[0];
  assert.deepEqual([miss.label, miss.exact, miss.x], ['Am Stadtpark, Baunatal', false, 10]);
  // the town narrows it down, in any spelling
  assert.deepEqual(labels('hauptstr 5'), ['Hauptstraße 5, Baunatal-Großenritte', 'Hauptstraße 5, Schauenburg']);
  assert.deepEqual(labels('hauptstrasse 5 grossenritte'), ['Hauptstraße 5, Baunatal-Großenritte']);
  assert.deepEqual(labels('Hauptstraße schauenburg 7'), ['Hauptstraße 7, Schauenburg']);
  // part of a word, best match first
  assert.deepEqual(labels('park'), ['Parkstraße, Baunatal', 'Am Stadtpark, Baunatal']);
  assert.deepEqual(labels('a 49'), ['A 49, Kirchbauna'], 'a road number is not mistaken for a house number');
  assert.deepEqual(labels('A49'), ['A 49, Kirchbauna']);
  assert.deepEqual(labels('a'), ['A 49, Kirchbauna', 'Am Stadtpark, Baunatal'], 'one letter only matches the beginning of a word');
  assert.deepEqual(labels('xyz'), []);
  assert.deepEqual(labels('5'), [], 'a number alone says nothing');
  assert.deepEqual(labels(''), []);
  assert.equal(ix.search('str', 2).length, 2, 'the limit holds');
});

test('the address list of the map', { skip }, () => {
  assert.ok(real.streetCount > 400, `${real.streetCount} streets`);
  assert.ok(real.size > 5000, `${real.size} house numbers`);
  const hit = real.search('Marktplatz 5')[0];
  assert.equal(hit.label, 'Marktplatz 5, Baunatal');
  assert.equal(hit.exact, true);
  assert.ok(real.search('altenritter str').some((h) => h.street === 'Altenritter Straße'));
});

test('every house can be driven up to: on the road, in lane, clear of junctions, house on the right', { skip }, () => {
  const json = addresses as AddressJson;
  const proj = { s: 0, off: 0, d2: 0, seg: 0 };
  let n = 0;
  let onRight = 0;
  let twoWay = 0;
  let k = 0;
  for (const s of json.streets) {
    for (let i = 0; i + 2 < s.h.length; i += 3) {
      const hx = Number(s.h[i + 1]);
      const hz = Number(s.h[i + 2]);
      // (of the houses of the town around the start point, every 11th)
      if (fromHome(hx, hz) > 4000 || k++ % 11 !== 0) continue;
      const what = `${s.n} ${s.h[i]}, ${s.c}`;
      const spot = findRoadSpot(world, graph, hx, hz, s.n, 220, main);
      assert.ok(spot, `${what}: no road`);
      n++;
      assert.ok(Math.hypot(spot.x - hx, spot.z - hz) < 235, `${what}: put ${Math.hypot(spot.x - hx, spot.z - hz).toFixed(0)} m away`);
      // on the carriageway of a road one may use
      let best: { e: (typeof world.edges)[number]; d: number; s: number } | null = null;
      world.edgesInBox(spot.x - 12, spot.z - 12, spot.x + 12, spot.z + 12, (e) => {
        projectOnPolyline(e.pl, spot.x, spot.z, proj);
        const d = Math.sqrt(proj.d2);
        if (LaneGraph.drivable(e, false) && d <= e.width / 2 + 0.05 && (!best || d < best.d)) best = { e, d, s: proj.s };
      });
      const b = best as { e: (typeof world.edges)[number]; d: number; s: number } | null;
      assert.ok(b, `${what}: not on a carriageway`);
      // heading along the road
      const i0 = Math.min(b.e.pl.cum.length - 2, Math.max(0, b.e.pl.cum.findIndex((c) => c > b.s) - 1));
      const tx = b.e.pl.pts[i0 * 3 + 3] - b.e.pl.pts[i0 * 3];
      const tz = b.e.pl.pts[i0 * 3 + 5] - b.e.pl.pts[i0 * 3 + 2];
      const fx = -Math.sin(spot.yaw);
      const fz = -Math.cos(spot.yaw);
      const along = (fx * tx + fz * tz) / Math.hypot(tx, tz);
      assert.ok(Math.abs(along) > 0.9, `${what}: standing across the road (${along.toFixed(2)})`);
      // not against a one-way street
      assert.ok((along > 0 ? b.e.lanesF : b.e.lanesB) > 0, `${what}: facing the wrong way in a one-way street`);
      if (b.e.lanesF > 0 && b.e.lanesB > 0) {
        twoWay++;
        // right of the driving direction (fx, fz) is (-fz, fx)
        if ((hx - spot.x) * -fz + (hz - spot.z) * fx > 0) onRight++;
      }
    }
  }
  assert.ok(n > 400, `${n} houses checked`);
  assert.ok(onRight > twoWay * 0.9, `house on the right for ${onRight} of ${twoWay} (two-way streets)`);
});

test('the connected network: lessons can start at any address of the list', { skip }, () => {
  let all = 0;
  let connected = 0;
  for (const l of graph.lanes) {
    if (!l) continue;
    all++;
    if (main(l)) connected++;
  }
  assert.ok(connected > all * 0.5, `${connected} of ${all} lanes are connected`);
  assert.ok(connected < all, 'fragments at the rim and private roads are left out');
  const json = addresses as AddressJson;
  const proj = { s: 0, off: 0, d2: 0, seg: 0 };
  let n = 0;
  let withTarget = 0;
  let k = 0;
  for (const s of json.streets) {
    for (let i = 0; i + 2 < s.h.length; i += 3) {
      if (fromHome(Number(s.h[i + 1]), Number(s.h[i + 2])) > 2200 || k++ % 13 !== 0) continue;
      const spot = findRoadSpot(world, graph, Number(s.h[i + 1]), Number(s.h[i + 2]), s.n, 220, main);
      assert.ok(spot, `${s.n} ${s.h[i]}`);
      // the lane the car stands in
      let lane = null;
      let bd = Infinity;
      world.edgesInBox(spot.x - 8, spot.z - 8, spot.x + 8, spot.z + 8, (e) => {
        projectOnPolyline(e.pl, spot.x, spot.z, proj);
        const el = graph.edgeLanes[e.id];
        for (const l of [...el.fwd, ...el.back]) {
          const d = Math.abs(proj.off - l.off) + Math.max(0, Math.sqrt(proj.d2) - e.width);
          const i0 = Math.min(e.pl.cum.length - 2, Math.max(0, proj.seg));
          const tx = (e.pl.pts[i0 * 3 + 3] - e.pl.pts[i0 * 3]) * l.dir;
          const tz = (e.pl.pts[i0 * 3 + 5] - e.pl.pts[i0 * 3 + 2]) * l.dir;
          if (-Math.sin(spot.yaw) * tx - Math.cos(spot.yaw) * tz > 0 && d < bd) {
            bd = d;
            lane = l;
          }
        }
      });
      assert.ok(lane && bd < 0.5, `${s.n} ${s.h[i]}: not in a lane (${bd.toFixed(2)} m off)`);
      assert.ok(main(lane as Lane), `${s.n} ${s.h[i]}: put on a road that leads nowhere`);
      n++;
      // a right-before-left junction to drive to, as the second lesson asks for
      if (findTarget(world, graph, 'rbl', spot.x, spot.z, lane, null, new Set())) withTarget++;
    }
  }
  assert.ok(n > 80, `${n} addresses checked`);
  assert.ok(withTarget >= n * 0.98, `a lesson destination from ${withTarget} of ${n} addresses`);
});

test('a road without houses: the motorway by its number', { skip }, async () => {
  const hit = real.search('A 49')[0];
  assert.ok(hit, 'A 49 is in the list');
  await map.loadAround(hit.x, hit.z, 1500);
  const spot = findRoadSpot(world, graph, hit.x, hit.z, hit.street, 220, main);
  assert.ok(spot);
  let onMotorway = false;
  const proj = { s: 0, off: 0, d2: 0, seg: 0 };
  world.edgesInBox(spot.x - 8, spot.z - 8, spot.x + 8, spot.z + 8, (e) => {
    projectOnPolyline(e.pl, spot.x, spot.z, proj);
    if (e.cls === CLS.MOTORWAY && e.ref === 'A 49' && Math.sqrt(proj.d2) < e.width / 2) onMotorway = true;
  });
  assert.ok(onMotorway, 'put on the A 49 itself');
  assert.equal(findRoadSpot(world, graph, 1e6, 1e6), null, 'far from every road');
});
