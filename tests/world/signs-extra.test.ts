// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The signs a map was built without (signs.json.gz, tools/build-signs.ts):
 * the times on their plates and when they hold, the codes read from
 * OpenStreetMap, where the town signs belong, and the rules the game takes
 * from them by its clock.
 *
 *   node --test tests/world/signs-extra.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PH, hasDays, holds, panelCodeFor, parseConditional, parseTimeWindow, signTimeOf, windowLines, windowSpec, windowText } from '../../src/sim/signtime.ts';
import type { SignTime, TimeWindow } from '../../src/sim/signtime.ts';
import { ExtraSigns, TimedRules } from '../../src/world/extrasigns.ts';
import type { SignPost } from '../../src/world/tilefmt.ts';
import { mappedSignPosts, parseSignTag, signDirections, timedSigns } from '../../tools/mapgen/signs.ts';
import { townSignNear, townSignsAt } from '../../tools/mapgen/townsigns.ts';
import type { TownArm } from '../../tools/mapgen/townsigns.ts';

/** a moment: weekday (0 Sunday … 6 Saturday), "hh:mm", holiday today / yesterday */
const at = (day: number, hm: string, holiday = false, holidayBefore = false): SignTime => {
  const [h, m] = hm.split(':').map(Number);
  return { day, min: h * 60 + m, holiday, holidayBefore };
};
const win = (s: string): TimeWindow => {
  const w = parseTimeWindow(s);
  assert.ok(w, `"${s}" is read`);
  return w;
};
const MON = 1;
const FRI = 5;
const SAT = 6;
const SUN = 0;

test('night-time signs: "22:00-06:00" holds from ten in the evening until six in the morning, every day', () => {
  const w = win('22:00-06:00');
  assert.equal(holds(w, at(MON, '21:59')), false);
  assert.equal(holds(w, at(MON, '22:00')), true);
  assert.equal(holds(w, at(MON, '23:30')), true);
  assert.equal(holds(w, at(SUN, '03:00')), true, 'into the morning, the day after');
  assert.equal(holds(w, at(SUN, '06:00')), false);
  assert.equal(holds(w, at(SAT, '12:00')), false);
  // as the plates and OpenStreetMap's sign codes write it, too
  assert.deepEqual(win('22-6'), w);
  assert.deepEqual(win('(22:00 - 06:00)'), w);
  assert.deepEqual(windowLines(w), ['22–6 h']);
});

test('school times: "Mo-Fr 07:00-17:00" holds on working days only – also on a public holiday that is a Monday', () => {
  const w = win('Mo-Fr 07:00-17:00');
  assert.equal(holds(w, at(MON, '07:00')), true);
  assert.equal(holds(w, at(FRI, '16:59')), true);
  assert.equal(holds(w, at(FRI, '17:00')), false);
  assert.equal(holds(w, at(SAT, '10:00')), false);
  assert.equal(holds(w, at(SUN, '10:00')), false);
  assert.equal(holds(w, at(MON, '10:00', true)), true, 'opening_hours: Mo-Fr names weekdays, holidays are not excepted');
  assert.deepEqual(windowLines(w), ['Mo–Fr', '7–17 h']);
  assert.equal(windowText(w), 'Mo–Fr 7–17 h');
  assert.equal(hasDays(w), true);
  assert.equal(panelCodeFor(w), '1042-33');
  assert.equal(panelCodeFor(win('22:00-06:00')), '1040-30');
  // the forms mappers write it in
  for (const s of ['Mo-Fr: 07:00-17:00', 'Mo-Fr 7:00-17:00', '(Mo-Fr 07:00-17:00)', 'mo-fr 07:00-17:00']) assert.deepEqual(win(s), w, s);
});

test('several rules, holidays, "off", weekdays apart and hours beyond midnight', () => {
  const w = win('Mo-Fr 06:00-10:00, 19:00-21:00; Sa 06:00-10:00');
  assert.equal(holds(w, at(MON, '20:00')), true);
  assert.equal(holds(w, at(SAT, '09:00')), true);
  assert.equal(holds(w, at(SAT, '20:00')), false);
  assert.deepEqual(windowLines(w), ['Mo–Fr 6–10 h, 19–21 h', 'Sa 6–10 h']);
  const off = win('Mo-Sa 06:00-12:00; PH off');
  assert.equal(holds(off, at(SAT, '08:00')), true);
  assert.equal(holds(off, at(SAT, '08:00', true)), false, 'not on a public holiday');
  const sundays = win('Su,PH');
  assert.equal(holds(sundays, at(SUN, '15:00')), true);
  assert.equal(holds(sundays, at(MON, '15:00', true)), true);
  assert.equal(holds(sundays, at(MON, '15:00')), false);
  assert.equal(sundays.spans[0].days, (1 << 0) | PH);
  const apart = win('Tu,Fr 16:00-43:00; Sa 12:00-18:00');
  assert.equal(holds(apart, at(2, '17:00')), true);
  assert.equal(holds(apart, at(3, '18:30')), true, '43:00 is seven in the evening of the next day');
  assert.equal(holds(apart, at(3, '19:30')), false);
  assert.equal(holds(apart, at(4, '17:00')), false, 'Thursday is not named');
  // the panel of "werktags": Monday to Saturday, not on holidays
  const work = win('werktags 18-19');
  assert.deepEqual(windowLines(work), ['werktags', '18–19 h']);
  assert.equal(holds(work, at(SAT, '18:30')), true);
  assert.equal(holds(work, at(SAT, '18:30', true)), false);
  // written back the one way, read again the same
  for (const x of [w, off, sundays, apart, work, win('22:00-06:00'), win('07:30-16:00')]) assert.deepEqual(win(windowSpec(x)), x, windowSpec(x));
  assert.equal(windowSpec(win('22-6')), '22:00-06:00');
  assert.deepEqual(windowLines(win('07:30-16:00')), ['7.30–16 h']);
});

test('what is not a plain time is not guessed at', () => {
  for (const s of ['May Su[-1] 09:30-18:00', '2026 Mar 21-2026 Jun 14', 'sunset-sunrise', 'Apr-Jun', 'weight>7.5', 'destination', '', 'Mo-Fr 25:00-26:00']) {
    assert.equal(parseTimeWindow(s), null, s);
  }
});

test('conditional tags: the alternatives with a time (or "wet") are taken, the others left out', () => {
  assert.deepEqual(
    parseConditional('30 @ (22:00-06:00); 50 @ (06:00-22:00)').map((c) => [c.value, c.when === 'wet' ? 'wet' : windowSpec(c.when)]),
    [
      ['30', '22:00-06:00'],
      ['50', '06:00-22:00'],
    ],
  );
  assert.deepEqual(parseConditional('80 @ wet').map((c) => [c.value, c.when]), [['80', 'wet']]);
  assert.equal(parseConditional('none @ (destination)').length, 0);
  assert.equal(parseConditional('30 @ (weight > 7.5 and 22:00-06:00)').length, 0);
  assert.equal(parseConditional('no @ (2026 Mar 21-2026 Jun 14)').length, 0);
  assert.deepEqual(
    parseConditional('delivery @ (Mo-Fr 06:00-12:00; Sa 06:00-10:00)').map((c) => c.value),
    ['delivery'],
  );
});

test('the game\'s clock as the signs see it: the time in Kassel, summer time and public holidays included', () => {
  // 2026-11-16 21:30 UTC is 22:30 in Kassel (winter time), a Monday
  let t = signTimeOf(new Date(Date.UTC(2026, 10, 16, 21, 30)));
  assert.equal(t.day, 1);
  assert.equal(t.min, 22 * 60 + 30);
  assert.equal(t.holiday, false);
  // 2026-10-03 (German Unity Day, a Saturday) 10:00 UTC is 12:00 in Kassel (summer time)
  t = signTimeOf(new Date(Date.UTC(2026, 9, 3, 10, 0)));
  assert.equal(t.day, 6);
  assert.equal(t.min, 12 * 60);
  assert.equal(t.holiday, true);
  t = signTimeOf(new Date(Date.UTC(2026, 9, 4, 10, 0)));
  assert.equal(t.holidayBefore, true);
});

test('sign codes from OpenStreetMap: values, times, several plates, what is no plate at all', () => {
  assert.deepEqual(parseSignTag('DE:274[30],1040-30[22:00-06:00]'), ['274-30', '1040-30:22:00-06:00']);
  assert.deepEqual(parseSignTag('DE:274[30],1040-30[22-6]'), ['274-30', '1040-30:22:00-06:00'], 'the time written the one way');
  assert.deepEqual(parseSignTag('DE:274-30,1042-33[Mo-Fr 7:00-17:00]'), ['274-30', '1042-33:Mo-Fr 07:00-17:00']);
  assert.deepEqual(parseSignTag('DE:245;DE:1042-31:7-15'), ['245', '1042-31:07:00-15:00']);
  assert.deepEqual(parseSignTag('DE:262[7,5],1020-30'), ['262:7.5', '1020-30'], 'the comma inside the brackets is no separator');
  assert.deepEqual(parseSignTag('DE:250,1026-36,1020-30,1022-10'), ['250', '1026-36', '1020-30', '1022-10']);
  assert.deepEqual(parseSignTag('DE:274-80[80];DE:276'), ['274-80', '276']);
  assert.deepEqual(parseSignTag('DE:274:80,1052-36'), ['274-80', '1052-36']);
  assert.deepEqual(parseSignTag('DE:274-53'), ['274-30'], 'old catalogue number');
  assert.deepEqual(parseSignTag('DE:274.1[30]'), ['274.1']);
  assert.deepEqual(parseSignTag('DE:274.1-20'), ['274.1-20']);
  assert.deepEqual(parseSignTag('DE:108-50[8 %],1001-31[1 km]'), ['108-8', '1001-31:1 km']);
  assert.deepEqual(parseSignTag('DE:133-10,274[40],1004-30[150]'), ['133-10', '274-40', '1004-30:150']);
  assert.deepEqual(parseSignTag('de:357'), ['357']);
  // no plates on a post: the ring on a lamp post, the tourist and direction boards, words
  for (const t of ['DE:394', 'DE:386.3', 'DE:453', 'city_limit', 'maxspeed', 'variable', 'none']) assert.deepEqual(parseSignTag(t), [], t);
  assert.deepEqual(parseSignTag('DE:454-10'), ['454-10'], 'a detour sign is one');
});

test('a sign mapped on a road without a direction: both ways – a warning only for the junction it is near', () => {
  const road = { len: 200, lanesF: 1, lanesB: 1 };
  assert.deepEqual(signDirections(road, 100, 0, ['274-30']), [1, -1]);
  assert.deepEqual(signDirections(road, 100, -1, ['274-30']), [-1]);
  assert.deepEqual(signDirections({ len: 200, lanesF: 1, lanesB: 0 }, 100, 0, ['274-30']), [1]);
  assert.deepEqual(signDirections(road, 170, 0, ['205']), [1], 'give way, 30 m before junction b');
  assert.deepEqual(signDirections(road, 20, 0, ['136-10']), [-1], 'children, 20 m before junction a');
  assert.deepEqual(signDirections(road, 100, 0, ['205']), [1, -1], 'no junction near');
  assert.deepEqual(signDirections(road, 170, 0, ['205'], true, false), [1, -1], 'b is no junction');
});

test('a mapped sign is read the way OpenStreetMap says – or by the side of the road it stands on', () => {
  const two = { len: 300, lanesF: 1, lanesB: 1 };
  const base = { onWay: false, wayDir: 1, s: 150, tx: 0, tz: 1, off: -4, road: two, junctionA: true, junctionB: true };
  const tags = { traffic_sign: 'DE:274[30],1040-30[22-6]' };
  // beside a road both ways: for the traffic that has it on its right (left of the course: against it)
  assert.deepEqual(mappedSignPosts(tags, base), [{ dir: 1, side: 1, codes: ['274-30', '1040-30:22:00-06:00'] }]);
  assert.deepEqual(mappedSignPosts(tags, { ...base, off: 4 }).map((p) => p.dir), [-1]);
  // beside a one-way road on its left: for its traffic, on the driver's left
  assert.deepEqual(mappedSignPosts(tags, { ...base, off: 4, road: { len: 300, lanesF: 1, lanesB: 0 } }).map((p) => [p.dir, p.side]), [[1, -1]]);
  // a compass direction: the face looks north (0°), read by traffic going south – the road runs south here (+z)
  assert.deepEqual(mappedSignPosts({ ...tags, direction: '0' }, base).map((p) => p.dir), [1]);
  assert.deepEqual(mappedSignPosts({ ...tags, direction: '180' }, { ...base, off: -4 }).map((p) => p.dir), [-1]);
  // on the way: "forward" along the way – the road runs against a way drawn the other way round
  assert.deepEqual(mappedSignPosts({ ...tags, direction: 'forward' }, { ...base, onWay: true }).map((p) => p.dir), [1]);
  assert.deepEqual(mappedSignPosts({ ...tags, direction: 'forward' }, { ...base, onWay: true, wayDir: -1 }).map((p) => p.dir), [-1]);
  // on the way without a direction: both ways
  assert.deepEqual(mappedSignPosts(tags, { ...base, onWay: true }).map((p) => p.dir), [1, -1]);
  // traffic_sign:forward / :backward
  assert.deepEqual(
    mappedSignPosts({ 'traffic_sign:forward': 'DE:274[50]', 'traffic_sign:backward': 'DE:274[70]' }, { ...base, onWay: true }).map((p) => [p.dir, p.codes]),
    [
      [1, ['274-50']],
      [-1, ['274-70']],
    ],
  );
});

test('the signs with a time a way\'s conditions make – with the plates its traffic_sign names, where it does', () => {
  const night = timedSigns({ 'maxspeed:conditional': '30 @ (22:00-06:00)' });
  assert.deepEqual(night.map((t) => [t.kind, t.value, t.along, t.codes]), [['max', 30, 0, ['274-30', '1040-30:22:00-06:00']]]);
  const school = timedSigns({ 'maxspeed:forward:conditional': '30 @ (Mo-Fr 07:00-17:00)' });
  assert.deepEqual(school.map((t) => [t.along, t.codes]), [[1, ['274-30', '1042-33:Mo-Fr 07:00-17:00']]]);
  const lorries = timedSigns({ 'hgv:conditional': 'no @ (22:00-06:00); none @ destination', 'maxspeed:hgv:conditional': '60 @ (22:00-06:00)' });
  assert.deepEqual(
    lorries.map((t) => [t.kind, t.codes]),
    [
      ['hgvShut', ['253', '1040-30:22:00-06:00']],
      ['hgvMax', ['274-60', '1010-51', '1040-30:22:00-06:00']],
    ],
  );
  assert.deepEqual(timedSigns({ 'maxspeed:conditional': '80 @ wet' }).map((t) => t.codes), [['274-80', '1053-35']]);
  assert.deepEqual(timedSigns({ 'overtaking:hgv:conditional': 'no @ (06:00-22:00)' }).map((t) => t.codes), [['277', '1040-30:06:00-22:00']]);
  assert.deepEqual(timedSigns({ 'motor_vehicle:conditional': 'no @ (20:00-06:00)' }).map((t) => t.codes), [['260', '1040-30:20:00-06:00']]);
  // the plates as the way's own traffic_sign names them
  const own = timedSigns({ 'maxspeed:conditional': '30 @ (16:00-18:00)', traffic_sign: 'DE:274-30,1040-30[16:00-18:00],1010-51,1053-33' });
  assert.deepEqual(own[0].codes, ['274-30', '1040-30:16:00-18:00', '1010-51', '1053-33']);
  // what is not a time makes no sign
  assert.deepEqual(timedSigns({ 'maxspeed:conditional': 'none @ (destination)', 'motor_vehicle:conditional': 'delivery @ (06:00-11:00)', 'access:conditional': 'no @ (2026 Jul 06-2026 Aug 10)' }), []);
});

/** an arm of a junction: inside the town or not, which way traffic may go on it */
const arm = (urban: boolean, o: Partial<TownArm> = {}): TownArm => ({ urban, counts: true, signable: true, approach: true, exit: true, ...o });

test('town signs where a road goes on into the town: on the road in the town, just beyond the joint', () => {
  const signs = townSignsAt([arm(false), arm(true)]);
  assert.deepEqual(signs, [
    { arm: 1, kind: 'enter', side: 'away' },
    { arm: 1, kind: 'leave', side: 'toward' },
  ]);
  // nothing where both are in the town, or both outside
  assert.deepEqual(townSignsAt([arm(true), arm(true)]), []);
  assert.deepEqual(townSignsAt([arm(false), arm(false), arm(false)]), []);
  // one-way: only the sign its traffic passes
  assert.deepEqual(townSignsAt([arm(false, { exit: false }), arm(true, { approach: false })]), [{ arm: 1, kind: 'enter', side: 'away' }]);
});

test('town signs at a junction: behind the one arm in the town – or, where the junction is in the town, on the arms to the country', () => {
  // the main road becomes the town's street at a junction with a road from the country
  assert.deepEqual(
    townSignsAt([arm(false), arm(true), arm(false)]).map((s) => [s.arm, s.kind, s.side]),
    [
      [1, 'enter', 'away'],
      [1, 'leave', 'toward'],
    ],
  );
  // a road from the country joins the town's main street: the signs stand on it, not on the main street
  assert.deepEqual(
    townSignsAt([arm(true), arm(true), arm(false)]).map((s) => [s.arm, s.kind, s.side]),
    [
      [2, 'enter', 'toward'],
      [2, 'leave', 'away'],
    ],
  );
  // a small road (a residential street) leads off a country road into a village
  assert.deepEqual(
    townSignsAt([arm(false), arm(false), arm(true)]).map((s) => [s.arm, s.kind]),
    [
      [2, 'enter'],
      [2, 'leave'],
    ],
  );
  // the town's arm is a roundabout's ring: the signs stand on the road from the country, before it
  assert.deepEqual(
    townSignsAt([arm(true, { signable: false }), arm(false)]).map((s) => [s.arm, s.kind, s.side]),
    [
      [1, 'enter', 'toward'],
      [1, 'leave', 'away'],
    ],
  );
  // tracks, car parks and motorways do not count
  assert.deepEqual(townSignsAt([arm(true), arm(true), arm(false, { counts: false })]), []);
});

test('a town sign is put up once: one for the same traffic within 100 m on the same road is enough – and none against the one there', () => {
  const have = [{ kind: 'enter' as const, x: 0, z: 0, yaw: 0 }];
  // (yaw 0: the plate faces north, read by traffic going south, +z)
  assert.equal(townSignNear(have, { kind: 'enter', x: 0, z: 60, yaw: 0.2 }), true);
  assert.equal(townSignNear(have, { kind: 'leave', x: 0, z: 40, yaw: 0 }), true, 'the other kind for the same traffic close by: the map has decided');
  assert.equal(townSignNear(have, { kind: 'leave', x: 0, z: 90, yaw: 0 }), false, 'the other kind further on: the next town');
  assert.equal(townSignNear(have, { kind: 'enter', x: 0, z: 60, yaw: Math.PI }), false, 'for the traffic the other way');
  assert.equal(townSignNear(have, { kind: 'enter', x: 40, z: 30, yaw: 0 }), false, 'a road beside it');
  assert.equal(townSignNear(have, { kind: 'enter', x: 0, z: 140, yaw: 0 }), false, 'too far along');
});

test('the rules of signs with a time hold by the game\'s clock: a limit at night, a road shut, a limit for lorries', () => {
  let now = new Date(Date.UTC(2026, 10, 16, 21, 30)); // Monday 22:30 in Kassel
  const rules = new TimedRules(
    [
      { e: 7, d: 0, k: 'max', v: 30, w: '22:00-06:00' },
      { e: 8, d: 1, k: 'max', v: 30, w: 'Mo-Fr 07:00-17:00' },
      { e: 9, d: 0, k: 'hgvMax', v: 60, w: '22:00-06:00' },
      { e: 9, d: 0, k: 'hgvShut', w: '22:00-06:00' },
      { e: 10, d: -1, k: 'shut', w: '20:00-06:00' },
      { e: 11, d: 0, k: 'max', v: 80, w: 'wet' },
      { e: 12, d: 0, k: 'max', v: 30, w: 'May Su[-1] 09:30-18:00' },
    ],
    () => now,
  );
  assert.deepEqual(rules.limit(7, 1, false), { v: 30, when: '22–6 h' });
  assert.deepEqual(rules.limit(7, -1, false), { v: 30, when: '22–6 h' });
  assert.equal(rules.limit(8, 1, false), null, 'school hours are over');
  assert.equal(rules.limit(9, 1, false), null, 'the limit for lorries is not for a car');
  assert.deepEqual(rules.limit(9, 1, true), { v: 60, when: '22–6 h' });
  assert.equal(rules.shut(9, 1, false), '');
  assert.equal(rules.shut(9, 1, true), '22–6 h');
  assert.equal(rules.shut(10, 1, false), '', 'only against the course of road 10');
  assert.equal(rules.shut(10, -1, false), '20–6 h');
  assert.equal(rules.limit(11, 1, false), null, 'dry');
  rules.wet = () => true;
  assert.deepEqual(rules.limit(11, 1, false), { v: 80, when: 'bei Nässe' });
  assert.equal(rules.limit(12, 1, false), null, 'a time it cannot read never holds');
  assert.equal(rules.limit(99, 1, false), null);
  // the next morning at nine: the night is over, the school's time has begun
  now = new Date(Date.UTC(2026, 10, 17, 8, 0));
  assert.equal(rules.limit(7, 1, false), null);
  assert.deepEqual(rules.limit(8, 1, false), { v: 30, when: 'Mo–Fr 7–17 h' });
  assert.equal(rules.limit(8, -1, false), null, 'only along the course of road 8');
  assert.equal(rules.roads, 5, 'the rule it cannot read is left out');
});

test('the posts of signs.json.gz go into their tile: added – or in place of the plates of the post that stands there', () => {
  const extra = new ExtraSigns({
    v: 1,
    map: 'x',
    tiles: {
      '1_2': [
        { x: 10, y: 0, z: 10, yaw: 0, s: ['274-30', '1040-30:22:00-06:00'], h: 2.1, r: 1 },
        { x: 50, y: 0, z: 50, yaw: 1, s: ['310:Altenbauna|Stadt Baunatal'], h: 2.1, big: 1 },
      ],
    },
    rules: [],
  });
  const signs: SignPost[] = [{ x: 10.2, y: 0, z: 9.9, yaw: 0, s: ['274-30'], h: 2.1 }];
  extra.mergeInto('1_2', signs);
  assert.equal(signs.length, 2);
  assert.deepEqual(signs[0].s, ['274-30', '1040-30:22:00-06:00'], 'the plate with the time under the speed limit');
  assert.equal(signs[0].x, 10.2, 'the post stays where it stands');
  assert.deepEqual(signs[1].s, ['310:Altenbauna|Stadt Baunatal']);
  assert.equal(signs[1].big, 1);
  // a tile loaded again gets them again – as copies
  const again: SignPost[] = [];
  extra.mergeInto('1_2', again);
  assert.equal(again.length, 2, 'without the post to replace, the plates come as a post of their own');
  again[1].s.push('x');
  const third: SignPost[] = [];
  extra.mergeInto('1_2', third);
  assert.deepEqual(third[1].s, ['310:Altenbauna|Stadt Baunatal']);
  extra.mergeInto('9_9', third);
  assert.equal(third.length, 2);
  assert.equal(extra.posts, 2);
});
