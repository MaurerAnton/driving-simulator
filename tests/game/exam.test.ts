// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The theory exam (game/exam/): the question bank is whole – unique ids,
 * every question with its words, a right answer, an explanation and a rule
 * – an exam is 20 + 10 questions worth 110 points, it is scored as the real
 * one (more than 10 error points, or two wrong 5-point questions: failed),
 * typed numbers are read as people type them, and the clock runs down.
 *
 *   node --test tests/game/exam.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { EXAM_BASIC, EXAM_CLASS, EXAM_MAX, clockText, isRight, pickExam, scoreExam, seeded, timeLeft, typedNumber } from '../../src/game/exam/exam.ts';
import type { ExamAnswer } from '../../src/game/exam/exam.ts';
import { CLASS_TOPICS, EXAM_TOPICS, QUESTIONS } from '../../src/game/exam/questions.ts';
import type { ExamQuestion } from '../../src/game/exam/questions.ts';
import { DANGER_ITEMS } from '../../src/game/exam/danger.ts';
import { EXAM_EN, withFallback } from '../../src/i18n/exam/index.ts';
import { THEORY } from '../../src/game/theory.ts';

const REF = /§ \d+[a-z]? |Anlage \d+ |Zeichen \d|Verordnung|StGB|StVG|FeV|StVZO/;

test('the question bank: unique ids, words for every question, a right answer, an explanation and a rule', () => {
  assert.ok(QUESTIONS.length >= 150, `only ${QUESTIONS.length} questions`);
  const ids = new Set<string>();
  for (const q of QUESTIONS) {
    assert.ok(!ids.has(q.id), `${q.id} twice`);
    ids.add(q.id);
    assert.ok(EXAM_TOPICS.includes(q.topic), `${q.id}: topic ${q.topic}`);
    assert.ok([2, 3, 4, 5].includes(q.points), `${q.id}: points`);
    const w = EXAM_EN.questions[q.id];
    assert.ok(w, `${q.id}: no English words`);
    assert.ok(w.q.trim().length > 10, `${q.id}: question`);
    assert.ok(w.why.trim().length > 10, `${q.id}: explanation`);
    assert.match(q.ref, REF, `${q.id}: reference "${q.ref}"`);
    if (q.number) {
      assert.equal(q.answers, 0, `${q.id}: a number question has no answers to tick`);
      assert.ok(Number.isFinite(q.number.value), `${q.id}: its number`);
      assert.equal(w.a.length, 0, `${q.id}: no answer texts`);
    } else {
      assert.ok(q.answers >= 2 && q.answers <= 4, `${q.id}: 2–4 answers`);
      assert.equal(w.a.length, q.answers, `${q.id}: as many answer texts as answers`);
      assert.ok(q.correct.length >= 1, `${q.id}: at least one right answer`);
      assert.ok(q.correct.every((i) => Number.isInteger(i) && i >= 0 && i < q.answers), `${q.id}: right answers among the answers`);
      assert.equal(new Set(w.a).size, w.a.length, `${q.id}: answers differ`);
      assert.ok(w.a.every((a) => a.trim().length > 0), `${q.id}: empty answer`);
    }
  }
  for (const id of Object.keys(EXAM_EN.questions)) assert.ok(ids.has(id), `words for ${id}, which is no question`);
  // every topic has questions, the class part enough for two exams
  for (const t of EXAM_TOPICS) assert.ok(QUESTIONS.filter((q) => q.topic === t).length >= 8, `topic ${t}`);
  assert.ok(QUESTIONS.filter((q) => CLASS_TOPICS.includes(q.topic)).length >= 2 * EXAM_CLASS);
  // pictures: signs the trainer knows, scenes and questions that exist
  for (const q of QUESTIONS) {
    const p = q.picture;
    if (!p) continue;
    if ('sign' in p) assert.ok(EXAM_EN.signs[p.sign], `${q.id}: sign ${p.sign}`);
    else {
      const l = THEORY.find((x) => x.id === p.scene);
      assert.ok(l && l.steps[p.step], `${q.id}: scene ${p.scene} step ${p.step}`);
    }
  }
});

test('the questions are our own words: nothing that looks like a number of the official catalogue', () => {
  // (the official catalogue numbers its questions like "1.1.02-001"; none of that here)
  const text = readFileSync(new URL('../../src/i18n/exam/en.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /\d\.\d\.\d{2}-\d{3}/);
});

test('an exam: 20 basic and 10 class questions, no question twice, 110 points, spread over the topics', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const qs = pickExam(QUESTIONS, seeded(seed));
    assert.equal(qs.length, EXAM_BASIC + EXAM_CLASS);
    assert.equal(new Set(qs.map((q) => q.id)).size, qs.length, `seed ${seed}: twice`);
    assert.equal(qs.reduce((s, q) => s + q.points, 0), EXAM_MAX, `seed ${seed}: points`);
    const cls = qs.filter((q) => CLASS_TOPICS.includes(q.topic));
    assert.equal(cls.length, EXAM_CLASS, `seed ${seed}: class part`);
    // the basic part first
    assert.ok(qs.slice(0, EXAM_BASIC).every((q) => !CLASS_TOPICS.includes(q.topic)));
    // every basic topic at least once
    for (const t of EXAM_TOPICS.filter((x) => !CLASS_TOPICS.includes(x))) assert.ok(qs.some((q) => q.topic === t), `seed ${seed}: ${t}`);
  }
  // the same seed, the same exam
  assert.deepEqual(pickExam(QUESTIONS, seeded(7)).map((q) => q.id), pickExam(QUESTIONS, seeded(7)).map((q) => q.id));
});

const Q = (id: string, points: ExamQuestion['points'], correct = [0]): ExamQuestion => ({ id, topic: 'danger', points, answers: 3, correct, ref: '§ 1 StVO' });

test('scoring: exactly the right answers ticked; more than 10 error points or two wrong 5-point questions fail', () => {
  const multi = Q('m', 4, [0, 2]);
  assert.equal(isRight(multi, [2, 0]), true);
  assert.equal(isRight(multi, [0]), false, 'one right answer missing');
  assert.equal(isRight(multi, [0, 1, 2]), false, 'one wrong answer too many');
  assert.equal(isRight(multi, []), false);
  assert.equal(isRight(multi, undefined), false);
  assert.equal(isRight(multi, '0'), false);

  const qs = [Q('a', 5), Q('b', 5), Q('c', 4), Q('d', 3), Q('e', 3), Q('f', 2)];
  const all: Record<string, ExamAnswer> = Object.fromEntries(qs.map((q) => [q.id, [0]]));
  let s = scoreExam(qs, all);
  assert.deepEqual([s.points, s.max, s.errors, s.passed], [22, 22, 0, true]);
  // 10 error points without two 5-pointers: passed
  s = scoreExam(qs, { ...all, a: [1], d: [1], f: [1] });
  assert.deepEqual([s.errors, s.wrongFive, s.passed], [10, 1, true]);
  assert.deepEqual(s.wrong, ['a', 'd', 'f']);
  // 11: failed
  s = scoreExam(qs, { ...all, c: [1], d: [1], e: [1], f: undefined });
  assert.deepEqual([s.errors, s.passed], [12, false]);
  // two wrong 5-point questions: 10 error points – and failed
  s = scoreExam(qs, { ...all, a: [1], b: [] });
  assert.deepEqual([s.errors, s.wrongFive, s.passed], [10, 2, false]);
  // nothing answered (the time ran out)
  s = scoreExam(qs, {});
  assert.deepEqual([s.points, s.errors, s.passed], [0, 22, false]);
});

test('numbers typed: commas, points, units, thousands', () => {
  assert.equal(typedNumber('1,6'), 1.6);
  assert.equal(typedNumber(' 1.6 mm'), 1.6);
  assert.equal(typedNumber('50 km/h'), 50);
  assert.equal(typedNumber('3.500'), 3500);
  assert.equal(typedNumber('3500'), 3500);
  assert.equal(typedNumber('0,5 ‰'), 0.5);
  assert.ok(Number.isNaN(typedNumber('fifty')));
  const q: ExamQuestion = { id: 'n', topic: 'speed', points: 3, answers: 0, correct: [], number: { value: 1.6, unit: 'mm' }, ref: '§ 36 StVZO' };
  assert.equal(isRight(q, '1,6'), true);
  assert.equal(isRight(q, '1.60'), true);
  assert.equal(isRight(q, '16'), false);
  assert.equal(isRight(q, [0]), false);
  // every number question of the bank is right with its own value typed, German style
  for (const x of QUESTIONS.filter((x) => x.number)) assert.equal(isRight(x, String(x.number?.value).replace('.', ',')), true, x.id);
});

test('the clock: 45 minutes, down to the second, never below zero', () => {
  const t0 = 1_000_000;
  assert.equal(timeLeft(t0, t0), 45 * 60_000);
  assert.equal(clockText(timeLeft(t0, t0)), '45:00');
  assert.equal(clockText(timeLeft(t0, t0 + 1)), '45:00');
  assert.equal(clockText(timeLeft(t0, t0 + 1000)), '44:59');
  assert.equal(clockText(timeLeft(t0, t0 + 44 * 60_000 + 50_500)), '0:10');
  assert.equal(timeLeft(t0, t0 + 46 * 60_000), 0);
  assert.equal(clockText(0), '0:00');
});

test('spot the danger: one item for each theory scene, at a moment of it, with a right answer and its words', () => {
  const ids = new Set(DANGER_ITEMS.map((d) => d.id));
  assert.equal(ids.size, DANGER_ITEMS.length, 'ids unique');
  for (const d of DANGER_ITEMS) {
    const l = THEORY.find((x) => x.id === d.scene);
    assert.ok(l, `${d.id}: no scene ${d.scene}`);
    assert.ok(l.steps[d.step], `${d.id}: no question ${d.step} in the scene`);
    const t = l.steps[d.step].at + d.off;
    assert.ok(t >= 0 && t <= l.end, `${d.id}: the moment ${t} lies in the scene`);
    assert.ok(d.answers >= 2 && d.answers <= 4, `${d.id}: 2–4 answers`);
    assert.ok(d.correct.length >= 1 && d.correct.every((i) => i >= 0 && i < d.answers), `${d.id}: right answers`);
    assert.match(d.ref, REF, `${d.id}: reference`);
    const w = EXAM_EN.danger[d.id];
    assert.ok(w && w.q && w.why && w.a.length === d.answers, `${d.id}: words`);
    assert.equal(new Set(w.a).size, w.a.length, `${d.id}: answers differ`);
  }
  // (a scene added later needs an item: listed, so that it is not forgotten)
  const missing = THEORY.filter((l) => !DANGER_ITEMS.some((d) => d.scene === l.id)).map((l) => l.id);
  assert.deepEqual(missing, [], 'theory scenes without a "spot the danger" item – add one to game/exam/danger.ts');
});

test('a translation lacking words falls back to English, answer by answer', () => {
  const id = QUESTIONS[0].id;
  const en = EXAM_EN.questions[id];
  const t = withFallback({ questions: { [id]: { q: 'Frage?', a: ['Eins'], why: '' } }, signs: { '205': 'Vorfahrt gewähren' } });
  assert.equal(t.questions[id].q, 'Frage?');
  assert.equal(t.questions[id].a[0], 'Eins');
  assert.equal(t.questions[id].a[1], en.a[1]);
  assert.equal(t.questions[id].why, en.why);
  assert.equal(t.signs['205'], 'Vorfahrt gewähren');
  assert.equal(t.signs['206'], EXAM_EN.signs['206']);
  assert.equal(Object.keys(t.danger).length, Object.keys(EXAM_EN.danger).length);
});
