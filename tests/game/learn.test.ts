// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The learning modes besides the exam (game/exam/): the sign trainer – every
 * sign drawable and named, four different choices, the boxes of spaced
 * repetition –, what is kept (merged from two devices, synced as the
 * progress kind "learn") and the lesson log gathered from the stores.
 *
 *   node --test tests/game/learn.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { seeded } from '../../src/game/exam/exam.ts';
import { ART_SIGNS, BOX_WAIT, TRAINER_SIGNS, nextSign, review, signChoices, signFamily, signProgress } from '../../src/game/exam/signs.ts';
import type { SignStat } from '../../src/game/exam/signs.ts';
import { LEARN_KEY, addExam, cleanLearn, emptyLearn, lessonStars, loadLearn, mergeLearn, noteLessonEnd, noteTry } from '../../src/game/exam/learnstore.ts';
import { learnLog } from '../../src/game/exam/learnlog.ts';
import { EXAM_EN } from '../../src/i18n/exam/index.ts';
import { artAspect } from '../../src/render/signart.ts';
import { KINDS } from '../../src/net/sync.ts';

const manifest = JSON.parse(readFileSync(new URL('../../public/signs/manifest.json', import.meta.url), 'utf8')) as Record<string, unknown>;

function memory(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

test('the sign trainer: every sign can be drawn and has a meaning; the meanings differ', () => {
  assert.ok(TRAINER_SIGNS.length >= 150, `only ${TRAINER_SIGNS.length} signs`);
  assert.equal(new Set(TRAINER_SIGNS).size, TRAINER_SIGNS.length);
  for (const c of TRAINER_SIGNS) {
    if (ART_SIGNS.has(c)) {
      assert.ok(!(c in manifest), `${c}: has a graphic – not to be drawn by signart`);
      assert.notEqual(artAspect(c), null, `${c}: render/signart.ts cannot draw it`);
    } else assert.ok(c in manifest, `${c}: no graphic in public/signs/`);
    assert.ok(EXAM_EN.signs[c]?.length > 2, `${c}: meaning`);
  }
  for (const c of ART_SIGNS) assert.ok(TRAINER_SIGNS.includes(c), `${c} drawn but not trained`);
  // every graphic the game has is trained
  for (const c of Object.keys(manifest)) assert.ok(TRAINER_SIGNS.includes(c), `${c}: in public/signs/ but not in the trainer`);
  const meanings = TRAINER_SIGNS.map((c) => EXAM_EN.signs[c]);
  assert.equal(new Set(meanings).size, meanings.length, 'two signs with the same meaning');
});

test('the sign trainer: four choices, the right one among them, no two alike, of the same family where possible', () => {
  const rand = seeded(3);
  const meaning = (c: string): string => EXAM_EN.signs[c];
  for (const code of TRAINER_SIGNS) {
    for (const label of [meaning, (c: string): string => c]) {
      const ch = signChoices(code, rand, label);
      assert.equal(ch.length, 4, code);
      assert.ok(ch.includes(code), `${code}: the right one is there`);
      assert.equal(new Set(ch.map(label)).size, 4, `${code}: choices alike`);
    }
    const fam = signFamily(code);
    if (TRAINER_SIGNS.filter((c) => signFamily(c) === fam).length >= 4) assert.ok(signChoices(code, rand, meaning).every((c) => signFamily(c) === fam), `${code}: of its family`);
  }
  assert.equal(signFamily('274-50'), 'speed');
  assert.equal(signFamily('101'), 'danger');
  assert.equal(signFamily('1020-30'), 'panel');
  assert.equal(signFamily('306'), 'info');
  assert.equal(signFamily('205'), 'rule');
});

test('spaced repetition: right moves a sign up a box and further away, wrong back to the first; due ones first, then new ones', () => {
  const t0 = 1_000_000_000;
  let s = review(undefined, true, t0);
  assert.deepEqual([s.box, s.due, s.right, s.wrong], [1, t0 + BOX_WAIT[1], 1, 0]);
  s = review(s, true, t0 + 1);
  assert.equal(s.box, 2);
  for (let i = 0; i < 10; i++) s = review(s, true, t0 + 2);
  assert.equal(s.box, 5, 'the top box at most');
  s = review(s, false, t0 + 3);
  assert.deepEqual([s.box, s.due, s.wrong], [0, t0 + 3, 1]);

  const codes = ['a', 'b', 'c', 'd'];
  const stats: Record<string, SignStat> = {};
  // nothing seen: the first new one
  assert.equal(nextSign(stats, t0, '', codes), 'a');
  stats.a = review(undefined, true, t0);
  // a learned, not due: the next new one
  assert.equal(nextSign(stats, t0 + 1, '', codes), 'b');
  stats.b = review(undefined, false, t0);
  // b wrong, due at once – before any new one; but not twice in a row
  assert.equal(nextSign(stats, t0 + 1, '', codes), 'b');
  assert.equal(nextSign(stats, t0 + 1, 'b', codes), 'c');
  // all seen, none due: the one due soonest
  stats.c = review(review(undefined, true, t0), true, t0);
  stats.d = review(undefined, true, t0 + 10);
  stats.b = review(stats.b, true, t0 + 5);
  assert.equal(nextSign(stats, t0 + 6, '', codes), 'a');
  // due: the lower box first
  assert.equal(nextSign(stats, t0 + 10 * 60_000, '', codes), 'a');
  const p = signProgress(stats, t0 + 6, codes);
  assert.deepEqual(p, { learned: 0, seen: 4, due: 0, total: 4 });
});

test('the store: lessons tried and passed, drills with stars, exams kept newest first; garbage made well-formed', () => {
  const m = memory();
  noteLessonEnd('bParallel', true, 0, [{ id: 'parallel', stars: 2, failed: false }], 1000, m);
  noteLessonEnd('bParallel', false, 12, [{ id: 'parallel', stars: 0, failed: true }], 2000, m);
  noteLessonEnd('rbl', true, 3, [], 3000, m);
  const d = loadLearn(m);
  assert.deepEqual(d.lessons.bParallel, { tries: 2, passes: 1, stars: 2, last: 2000, passedAt: 1000 });
  assert.deepEqual(d.drills.parallel, { tries: 2, passes: 1, stars: 2, last: 2000, passedAt: 1000 });
  assert.equal(d.lessons.rbl.stars, lessonStars(true, 3));
  assert.deepEqual([lessonStars(true, 0), lessonStars(true, 4), lessonStars(true, 9), lessonStars(false, 0)], [3, 2, 1, 0]);
  const e = (t: number, passed = true): Parameters<typeof addExam>[1] => ({ t, points: 104, max: 110, errors: 6, passed, wrong: ['dan01'], secs: 900 });
  addExam(d, e(5));
  addExam(d, e(9, false));
  addExam(d, e(5));
  assert.deepEqual(d.exams.map((x) => x.t), [9, 5]);
  m.setItem(LEARN_KEY, '{"exams":[{"t":"x"},null,7],"signs":{"205":{"box":99,"due":"no"}},"lessons":[1,2]}');
  const g = loadLearn(m);
  assert.equal(g.signs['205'].box, 5);
  assert.equal(g.signs['205'].due, 0);
  assert.deepEqual(g.lessons, {});
  assert.equal(g.exams.length, 1);
  m.setItem(LEARN_KEY, 'not json');
  assert.deepEqual(loadLearn(m), emptyLearn());
});

test('two devices: exams a union, of a sign the copy answered more often, of a lesson the best of both – and synced as the kind "learn"', () => {
  const a = emptyLearn();
  const b = emptyLearn();
  addExam(a, { t: 1, points: 100, max: 110, errors: 10, passed: true, wrong: [], secs: 1 });
  addExam(b, { t: 2, points: 90, max: 110, errors: 20, passed: false, wrong: [], secs: 1 });
  addExam(b, { t: 1, points: 100, max: 110, errors: 10, passed: true, wrong: [], secs: 1 });
  a.signs['205'] = { box: 1, due: 5, right: 1, wrong: 0, last: 5 };
  b.signs['205'] = { box: 3, due: 9, right: 3, wrong: 1, last: 4 };
  b.signs['206'] = { box: 0, due: 1, right: 0, wrong: 1, last: 1 };
  noteTry(a.lessons, 'rbl', true, 3, 10);
  noteTry(b.lessons, 'rbl', false, 0, 20);
  noteTry(b.lessons, 'rbl', false, 0, 21);
  const m = mergeLearn(a, b);
  assert.deepEqual(m.exams.map((x) => x.t), [2, 1]);
  assert.equal(m.signs['205'].box, 3);
  assert.equal(m.signs['206'].wrong, 1);
  assert.deepEqual(m.lessons.rbl, { tries: 2, passes: 1, stars: 3, last: 21, passedAt: 10 });
  // the same either way round, and nothing lost merging with nothing
  assert.deepEqual(mergeLearn(b, a).signs, m.signs);
  assert.deepEqual(mergeLearn(a, null), cleanLearn(a));
  const kind = KINDS.find((k) => k.kind === 'learn');
  assert.ok(kind, 'net/sync.ts has the kind "learn"');
  const store = memory();
  assert.equal(kind.read(store), null);
  kind.write(store, m);
  assert.deepEqual(kind.read(store), m);
  assert.deepEqual(kind.merge(null, a, b), m);
});

test('the lesson log: not tried, tried (also by a fault in it), passed with stars and date; the theory, the danger items, exams, signs, tours', () => {
  const d = emptyLearn();
  noteTry(d.lessons, 'rbl', true, 2, 5000);
  noteTry(d.lessons, 'priority', false, 0, 6000);
  noteTry(d.drills, 'parallel', true, 3, 7000);
  d.danger.zebra = { right: 1, wrong: 1, ok: true, last: 8000 };
  d.danger.rbl = { right: 0, wrong: 1, ok: false, last: 8100 };
  addExam(d, { t: 9000, points: 106, max: 110, errors: 4, passed: true, wrong: [], secs: 600 });
  addExam(d, { t: 9500, points: 80, max: 110, errors: 30, passed: false, wrong: [], secs: 600 });
  d.signs['205'] = { box: 3, due: 1e12, right: 3, wrong: 0, last: 1 };
  d.signs['206'] = { box: 0, due: 0, right: 0, wrong: 1, last: 1 };
  const log = learnLog({
    learn: d,
    lessons: ['basics', 'rbl', 'priority', 'signals'],
    drills: ['parallel', 'turn'],
    theory: ['rbl', 'zebra'],
    theoryDone: ['zebra', 'gone'],
    danger: ['rbl', 'zebra', 'tram'],
    faults: [{ mode: 'signals', t: 4000 }, { mode: 'free', t: 4500 }],
    tours: [{ date: '2026-11-01T10:00:00Z', done: true }, { date: 'bad', done: false }],
    now: 10_000,
  });
  const sec = (id: string): Map<string, { state: string; stars?: number; date: number }> => new Map((log.sections.find((s) => s.id === id)?.rows ?? []).map((r) => [r.id, r]));
  const lessons = sec('lessons');
  assert.deepEqual([...lessons.values()].map((r) => r.state), ['none', 'passed', 'tried', 'tried']);
  assert.equal(lessons.get('rbl')?.stars, 2);
  assert.equal(lessons.get('rbl')?.date, 5000);
  assert.equal(lessons.get('signals')?.date, 4000, 'tried: a fault was logged in it');
  assert.equal(sec('drills').get('parallel')?.stars, 3);
  assert.equal(sec('drills').get('turn')?.state, 'none');
  assert.deepEqual([...sec('theory').values()].map((r) => r.state), ['none', 'passed']);
  assert.deepEqual([...sec('danger').values()].map((r) => r.state), ['tried', 'passed', 'none']);
  const s = log.sections.find((x) => x.id === 'lessons');
  assert.deepEqual([s?.passed, s?.total], [1, 4]);
  assert.deepEqual(log.exams, { taken: 2, passed: 1, best: 106, max: 110, last: 9500 });
  assert.equal(log.signs.learned, 1);
  assert.equal(log.signs.seen, 2);
  assert.equal(log.signs.due, 1);
  assert.deepEqual(log.tours, { driven: 2, done: 1, last: Date.parse('2026-11-01T10:00:00Z') });
});
