// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The lesson log – "where am I?": every practical lesson, every basic task
 * of class B (game/drills.ts), every theory scene, the theory exams, the sign
 * trainer and "spot the danger", each with its state – not tried, tried, or
 * passed (with stars and the date) – gathered from what the browser keeps:
 * the learning store (learnstore.ts), the theory scenes passed
 * (game/theorymode.ts), the log of faults (a lesson with faults was at
 * least tried: game/faultlog.ts) and the tours (game/tourlog.ts).
 *
 * A pure function of those (tests/game/learn.test.ts); ui/learn.ts shows it.
 */
import type { LearnData, LessonRecord } from './learnstore.ts';
import { signProgress } from './signs.ts';

export type LogState = 'none' | 'tried' | 'passed';

export interface LogRow {
  id: string;
  state: LogState;
  /** 0–3 (passed only; undefined: a lesson that has no stars) */
  stars?: number;
  /** when it was passed – or last tried (ms; 0: never) */
  date: number;
  /** tries so far */
  tries: number;
}

export interface LogSection {
  id: 'lessons' | 'drills' | 'theory' | 'danger' | 'exams';
  rows: LogRow[];
  /** passed, of how many */
  passed: number;
  total: number;
}

export interface LogInput {
  learn: LearnData;
  /** the practical lessons and the basic tasks, in their order */
  lessons: readonly string[];
  drills: readonly string[];
  /** the theory scenes, and those answered all right */
  theory: readonly string[];
  theoryDone: readonly string[];
  /** the "spot the danger" items */
  danger: readonly string[];
  /** the faults of all drives: in which mode (lesson id), when */
  faults: ReadonlyArray<{ mode: string; t: number }>;
  /** the tours: when (ISO), driven to the end */
  tours: ReadonlyArray<{ date: string; done: boolean }>;
  now: number;
}

export interface LearnLog {
  sections: LogSection[];
  exams: { taken: number; passed: number; best: number; max: number; last: number };
  signs: { learned: number; seen: number; due: number; total: number };
  tours: { driven: number; done: number; last: number };
}

function lessonRow(id: string, r: LessonRecord | undefined, lastFault: number): LogRow {
  if (r && r.passes > 0) return { id, state: 'passed', stars: r.stars, date: r.passedAt || r.last, tries: r.tries };
  if ((r && r.tries > 0) || lastFault > 0) return { id, state: 'tried', date: Math.max(r?.last ?? 0, lastFault), tries: Math.max(r?.tries ?? 0, lastFault > 0 ? 1 : 0) };
  return { id, state: 'none', date: 0, tries: 0 };
}

function section(id: LogSection['id'], rows: LogRow[]): LogSection {
  return { id, rows, passed: rows.filter((r) => r.state === 'passed').length, total: rows.length };
}

export function learnLog(o: LogInput): LearnLog {
  const lastFault = new Map<string, number>();
  for (const f of o.faults) lastFault.set(f.mode, Math.max(lastFault.get(f.mode) ?? 0, f.t));
  const lessons = section('lessons', o.lessons.map((id) => lessonRow(id, o.learn.lessons[id], lastFault.get(id) ?? 0)));
  const drills = section('drills', o.drills.map((id) => lessonRow(id, o.learn.drills[id], 0)));
  const done = new Set(o.theoryDone);
  const theory = section('theory', o.theory.map((id): LogRow => (done.has(id) ? { id, state: 'passed', date: 0, tries: 1 } : { id, state: 'none', date: 0, tries: 0 })));
  const danger = section(
    'danger',
    o.danger.map((id): LogRow => {
      const s = o.learn.danger[id];
      if (!s) return { id, state: 'none', date: 0, tries: 0 };
      return { id, state: s.ok ? 'passed' : 'tried', date: s.last, tries: s.right + s.wrong };
    }),
  );
  const ex = o.learn.exams;
  const exams = section(
    'exams',
    ex.map((e): LogRow => ({ id: String(e.t), state: e.passed ? 'passed' : 'tried', date: e.t, tries: 1 })),
  );
  let best = 0;
  let max = 0;
  for (const e of ex) {
    if (e.points / Math.max(1, e.max) > best / Math.max(1, max) || max === 0) {
      best = e.points;
      max = e.max;
    }
  }
  const tourDates = o.tours.map((t) => Date.parse(t.date)).filter((t) => Number.isFinite(t));
  return {
    sections: [lessons, drills, theory, danger, exams],
    exams: { taken: ex.length, passed: ex.filter((e) => e.passed).length, best, max, last: ex.reduce((m, e) => Math.max(m, e.t), 0) },
    signs: signProgress(o.learn.signs, o.now),
    tours: { driven: o.tours.length, done: o.tours.filter((t) => t.done).length, last: tourDates.length > 0 ? Math.max(...tourDates) : 0 },
  };
}
