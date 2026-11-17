// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lessons in real places (game/lessonplaces.ts): which lessons look for a
 * place and which stay as they are, where a lesson begins by the setting –
 * and, on the real map, the places found in Baunatal and Kassel: right
 * before a junction of the lesson's kind, in a lane leading to it, with the
 * way through it to the destination.
 *
 *   node --test tests/game/lessonplaces.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { LESSONS, junctionOfType } from '../../src/game/nav.ts';
import { areaChoices, findLessonPlace, lessonStart, placeKindOf } from '../../src/game/lessonplaces.ts';
import type { PlaceKind } from '../../src/game/lessonplaces.ts';
import { CLS, EF } from '../../src/world/types.ts';
import type { SpawnJson } from '../../src/world/types.ts';
import { haveMap, openRealMap } from '../realmap.ts';

const spawn = (name: string, x: number, z: number): SpawnJson => ({ name, x, z, yaw: 0, kind: 'parking' });
const SPAWNS = [spawn('Baunatal – Parkplatz', 700, -300), spawn('Altenbauna – Parkplatz', 1100, -800), spawn('Altenbauna – Markt', 1150, -850), spawn('Kassel – Parkplatz', 6000, -7000), spawn('Bad Hersfeld – Am Markt', 21588, 42581)];

test('which lessons look for a real place – the yard, the tram and the bus do not', () => {
  const kinds = Object.fromEntries(LESSONS.map((l) => [l.id, placeKindOf(l)]));
  assert.equal(kinds.basics, 'quiet');
  assert.equal(kinds.rbl, 'rbl');
  assert.equal(kinds.priority, 'priority');
  assert.equal(kinds.signals, 'signals');
  assert.equal(kinds.roundabout, 'roundabout');
  assert.equal(kinds.rural, 'rural');
  assert.equal(kinds.motorway, 'motorway');
  assert.equal(kinds.exam, 'area');
  assert.equal(kinds.ceExam, 'area');
  for (const id of ['ceCouple', 'ceCorner', 'ceRamp', 'tramLine', 'busLine']) assert.equal(kinds[id], null, id);
});

test('the districts to choose from, and where a lesson begins by the setting', () => {
  const areas = areaChoices(SPAWNS);
  assert.deepEqual(
    areas.map((a) => a.name),
    ['Baunatal', 'Altenbauna', 'Kassel'],
    'each district once, nearest first, none far away',
  );
  const rbl = LESSONS.find((l) => l.id === 'rbl')!;
  const here = spawn('Somewhere', 1, 2);
  assert.equal(lessonStart(rbl, 'start', null, SPAWNS, here), null, 'as before');
  assert.equal(lessonStart(LESSONS.find((l) => l.id === 'ceCouple')!, 'town', null, SPAWNS, here), null, 'the yard stays the yard');
  const inArea = lessonStart(rbl, 'area', { name: 'Kassel', x: 6010, z: -7010 }, SPAWNS, here)!;
  assert.equal(inArea.spawn.name, 'Kassel – Parkplatz');
  assert.equal(inArea.kind, 'rbl');
  assert.equal(inArea.fallback, here, 'nothing found: where the player chose');
  // at random: a district of the home region – never one far away
  for (let i = 0; i < 20; i++) {
    const s = lessonStart(rbl, 'town', null, SPAWNS, here, () => i / 20)!;
    assert.ok(Math.hypot(s.spawn.x - 700, s.spawn.z + 300) < 12000, s.spawn.name);
  }
  // the test drive: only the district
  assert.equal(lessonStart(LESSONS.find((l) => l.id === 'exam')!, 'area', null, SPAWNS, here)!.kind, 'area');
});

test('on the real map: places for each lesson round Baunatal and in Kassel', { skip: !haveMap && 'no map (public/map or MAP_DIR)' }, async () => {
  const r = await openRealMap();
  let seed = 11;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const found = new Map<string, number>();
  for (const [x, z] of [
    [744, -272],
    [4265, -5927],
  ]) {
    await r.map.loadAround(x, z, 3100);
    for (const kind of ['quiet', 'rbl', 'priority', 'signals', 'roundabout', 'rural', 'motorway'] as PlaceKind[]) {
      const at = findLessonPlace(r.world, r.lanes, kind, x, z, { rnd, usable: (l) => r.usable(l) });
      if (!at) continue;
      found.set(kind, (found.get(kind) ?? 0) + 1);
      if (kind === 'quiet') {
        assert.equal(at.goal, null);
        continue;
      }
      assert.ok(at.node, `${kind}: a junction`);
      if (kind !== 'rural' && kind !== 'motorway') assert.ok(junctionOfType(at.node, kind as 'rbl' | 'signals' | 'roundabout' | 'priority'), `${kind}: the junction is of the lesson's kind`);
      // about a hundred metres before it (less where the road is short), facing it
      const d = Math.hypot(at.node.x - at.x, at.node.z - at.z);
      assert.ok(d > 15 && d < 250, `${kind}: ${Math.round(d)} m before the junction`);
      const fx = -Math.sin(at.yaw);
      const fz = -Math.cos(at.yaw);
      assert.ok(((at.node.x - at.x) * fx + (at.node.z - at.z) * fz) / d > 0.3, `${kind}: facing the junction`);
      assert.ok(at.goal, `${kind}: a destination`);
      if (kind === 'motorway') assert.equal(at.goal.cls, CLS.MOTORWAY);
      if (kind === 'rural') assert.equal(at.goal.flags & EF.URBAN, 0);
      if (kind === 'roundabout') assert.equal(at.goal.flags & EF.ROUNDABOUT, 0, 'out of the ring');
    }
  }
  // what a town of this size has: every kind somewhere
  for (const kind of ['quiet', 'rbl', 'priority', 'signals', 'roundabout', 'rural', 'motorway']) assert.ok((found.get(kind) ?? 0) > 0, `${kind} found (${[...found].join(' ')})`);
});
