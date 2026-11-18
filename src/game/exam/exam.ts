// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The theory exam, as the German test for class B is made: 30 questions in
 * 45 minutes – 20 of the basic material and 10 of the class – each worth 2
 * to 5 points, 110 points in all.  Failed with more than 10 error points, or
 * with two wrong 5-point questions (which are 10 error points already).  A
 * question with answers to tick counts only when exactly the right ones are
 * ticked; a question with a number counts when the number is right.  When the
 * time is up, what is not answered is wrong.
 *
 * Pure functions (tests/game/exam.test.ts); ui/learn.ts shows it, the
 * results are kept by game/exam/learnstore.ts.
 */
import { CLASS_TOPICS, EXAM_TOPICS, QUESTIONS } from './questions.ts';
import type { ExamQuestion, ExamTopic } from './questions.ts';

export const EXAM_BASIC = 20;
export const EXAM_CLASS = 10;
export const EXAM_MINUTES = 45;
export const EXAM_MAX = 110;
/** more error points than these: failed */
export const EXAM_MAX_ERRORS = 10;

/** A small seeded random generator (mulberry32): the same seed, the same exam. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(list: readonly T[], rand: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const isClass = (q: ExamQuestion): boolean => CLASS_TOPICS.includes(q.topic);

/** `n` questions spread over the topics as evenly as can be: one of each topic in turn, the topics in a random order. */
function spread(pool: readonly ExamQuestion[], n: number, rand: () => number): ExamQuestion[] {
  const byTopic = new Map<ExamTopic, ExamQuestion[]>();
  for (const t of shuffle(EXAM_TOPICS, rand)) {
    const qs = pool.filter((q) => q.topic === t);
    if (qs.length > 0) byTopic.set(t, shuffle(qs, rand));
  }
  const out: ExamQuestion[] = [];
  while (out.length < n && byTopic.size > 0) {
    for (const [t, qs] of byTopic) {
      if (out.length >= n) break;
      const q = qs.pop();
      if (q) out.push(q);
      if (qs.length === 0) byTopic.delete(t);
    }
  }
  return out;
}

/**
 * The questions of one exam: 20 of the basic material and 10 of the class,
 * spread over the topics, together worth 110 points – questions are swapped
 * for others of the same part (of the same topic where one fits) until the
 * points add up.
 */
export function pickExam(bank: readonly ExamQuestion[] = QUESTIONS, rand: () => number = Math.random, target = EXAM_MAX): ExamQuestion[] {
  const basicPool = bank.filter((q) => !isClass(q));
  const classPool = bank.filter(isClass);
  const chosen = [...spread(basicPool, EXAM_BASIC, rand), ...spread(classPool, EXAM_CLASS, rand)];
  const used = new Set(chosen.map((q) => q.id));
  let sum = chosen.reduce((s, q) => s + q.points, 0);
  for (let tries = 0; tries < 2000 && sum !== target; tries++) {
    const diff = target - sum;
    const i = Math.floor(rand() * chosen.length);
    const q = chosen[i];
    const pool = isClass(q) ? classPool : basicPool;
    const fits = (c: ExamQuestion): boolean => {
      const d = c.points - q.points;
      return !used.has(c.id) && d !== 0 && Math.sign(d) === Math.sign(diff) && Math.abs(d) <= Math.abs(diff);
    };
    const same = pool.filter((c) => c.topic === q.topic && fits(c));
    // (another topic only while this one keeps a question in the exam)
    const keeps = chosen.filter((c) => c.topic === q.topic).length > 1;
    const any = same.length > 0 || !keeps ? same : pool.filter(fits);
    if (any.length === 0) continue;
    const c = any[Math.floor(rand() * any.length)];
    used.delete(q.id);
    used.add(c.id);
    chosen[i] = c;
    sum += c.points - q.points;
  }
  return chosen;
}

/** An answer: the answers ticked (indices), or the number typed (as typed). */
export type ExamAnswer = number[] | string;

/** A number as typed: "1,6", "1.6", " 50 km/h" → 1.6, 50 (NaN: none). */
export function typedNumber(s: string): number {
  const m = /-?\d+(?:[.,]\d+)?/.exec(s.replace(/\s+/g, '').replace(/(\d)[.](\d{3})(?!\d)/g, '$1$2'));
  return m ? Number(m[0].replace(',', '.')) : Number.NaN;
}

/** Is this answer right? (ticked: exactly the right ones; typed: the right number) */
export function isRight(q: ExamQuestion, a: ExamAnswer | undefined): boolean {
  if (a === undefined) return false;
  if (q.number) return typeof a === 'string' && Math.abs(typedNumber(a) - q.number.value) < 1e-9;
  if (typeof a === 'string') return false;
  const got = [...new Set(a)].sort((x, y) => x - y);
  const want = [...q.correct].sort((x, y) => x - y);
  return got.length === want.length && got.every((x, i) => x === want[i]);
}

export interface ExamScore {
  /** points of the right answers, of how many */
  points: number;
  max: number;
  /** points of the wrong (and the unanswered) */
  errors: number;
  /** wrong 5-point questions */
  wrongFive: number;
  passed: boolean;
  /** the ids of the wrong questions, in the order of the exam */
  wrong: string[];
}

/** The result of an exam: failed with more than 10 error points or two wrong 5-point questions. */
export function scoreExam(qs: readonly ExamQuestion[], answers: Readonly<Record<string, ExamAnswer | undefined>>): ExamScore {
  let points = 0;
  let max = 0;
  let wrongFive = 0;
  const wrong: string[] = [];
  for (const q of qs) {
    max += q.points;
    if (isRight(q, answers[q.id])) points += q.points;
    else {
      wrong.push(q.id);
      if (q.points === 5) wrongFive++;
    }
  }
  const errors = max - points;
  return { points, max, errors, wrongFive, wrong, passed: errors <= EXAM_MAX_ERRORS && wrongFive < 2 };
}

/** How much time is left (ms, never below 0) of an exam begun at `start` (ms). */
export function timeLeft(start: number, now: number, minutes = EXAM_MINUTES): number {
  return Math.max(0, start + minutes * 60_000 - now);
}

/** A time left as the clock shows it: "44:59" (rounded up to the second, as a countdown does). */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Has this answer been given at all (something ticked or typed)? */
export function answered(a: ExamAnswer | undefined): boolean {
  return a !== undefined && (typeof a === 'string' ? a.trim() !== '' : a.length > 0);
}
