// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the player learned, kept in the browser (and on the server, as the
 * progress kind "learn": net/sync.ts): the theory exams taken, the sign
 * trainer's boxes, the "spot the danger" answers, and how each practical
 * lesson and each basic task ended – tried, passed, with stars, when.
 *
 * Two copies (two devices) are merged item by item: the exams are a union;
 * of a sign, a danger item, a lesson the copy answered more often wins (on a
 * tie the later one); a lesson keeps the most tries and the best stars.
 */
import type { SignStat } from './signs.ts';

/** A theory exam taken. */
export interface ExamRecord {
  /** when it ended (ms) */
  t: number;
  points: number;
  max: number;
  errors: number;
  passed: boolean;
  /** the ids of the questions answered wrong */
  wrong: string[];
  /** how long it took (s) */
  secs: number;
}

/** A "spot the danger" item answered. */
export interface DangerStat {
  right: number;
  wrong: number;
  /** the last answer was right */
  ok: boolean;
  last: number;
}

/** How a practical lesson (or a basic task) went. */
export interface LessonRecord {
  tries: number;
  passes: number;
  /** the best stars (0–3) */
  stars: number;
  /** the last try, the last pass (ms; 0: never) */
  last: number;
  passedAt: number;
}

export interface LearnData {
  exams: ExamRecord[];
  signs: Record<string, SignStat>;
  danger: Record<string, DangerStat>;
  lessons: Record<string, LessonRecord>;
  drills: Record<string, LessonRecord>;
}

/** What is needed of localStorage (tests bring a Map). */
export interface LearnStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LEARN_KEY = 'fahrsim.learn.v1';
/** the exams kept (the newest) */
export const EXAMS_KEPT = 50;

export const emptyLearn = (): LearnData => ({ exams: [], signs: {}, danger: {}, lessons: {}, drills: {} });

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function record<T>(v: unknown, fix: (x: Record<string, unknown>) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(obj(v))) if (x && typeof x === 'object') out[k] = fix(obj(x));
  return out;
}

const fixSign = (x: Record<string, unknown>): SignStat => ({ box: Math.max(0, Math.min(5, Math.round(num(x.box)))), due: num(x.due), right: num(x.right), wrong: num(x.wrong), last: num(x.last) });
const fixDanger = (x: Record<string, unknown>): DangerStat => ({ right: num(x.right), wrong: num(x.wrong), ok: x.ok === true, last: num(x.last) });
const fixLesson = (x: Record<string, unknown>): LessonRecord => ({ tries: num(x.tries), passes: num(x.passes), stars: Math.max(0, Math.min(3, num(x.stars))), last: num(x.last), passedAt: num(x.passedAt) });
const fixExam = (x: Record<string, unknown>): ExamRecord => ({ t: num(x.t), points: num(x.points), max: num(x.max), errors: num(x.errors), passed: x.passed === true, wrong: Array.isArray(x.wrong) ? x.wrong.filter((w): w is string => typeof w === 'string') : [], secs: num(x.secs) });

/** Whatever was stored (or sent by the server), made well-formed. */
export function cleanLearn(v: unknown): LearnData {
  const o = obj(v);
  return {
    exams: (Array.isArray(o.exams) ? o.exams : []).filter((e) => e && typeof e === 'object').map((e) => fixExam(obj(e))),
    signs: record(o.signs, fixSign),
    danger: record(o.danger, fixDanger),
    lessons: record(o.lessons, fixLesson),
    drills: record(o.drills, fixLesson),
  };
}

const defaultStore = (): LearnStore | null => (typeof localStorage === 'undefined' ? null : localStorage);

export function loadLearn(store: LearnStore | null = defaultStore()): LearnData {
  try {
    const raw = store?.getItem(LEARN_KEY);
    return raw ? cleanLearn(JSON.parse(raw)) : emptyLearn();
  } catch {
    return emptyLearn();
  }
}

export function saveLearn(d: LearnData, store: LearnStore | null = defaultStore()): void {
  try {
    store?.setItem(LEARN_KEY, JSON.stringify(d));
  } catch {
    /* (private window, storage full: kept as long as the page) */
  }
}

/** Change what is stored: read it, change it, write it back (and give it back). */
export function updateLearn(change: (d: LearnData) => void, store: LearnStore | null = defaultStore()): LearnData {
  const d = loadLearn(store);
  change(d);
  saveLearn(d, store);
  return d;
}

/** An exam taken: kept with the newest first. */
export function addExam(d: LearnData, e: ExamRecord): void {
  d.exams = [e, ...d.exams.filter((x) => x.t !== e.t)].sort((a, b) => b.t - a.t).slice(0, EXAMS_KEPT);
}

/** A try of a lesson or a task: passed or not, with stars (0–3). */
export function noteTry(list: Record<string, LessonRecord>, id: string, passed: boolean, stars: number, now: number): void {
  const r = list[id] ?? { tries: 0, passes: 0, stars: 0, last: 0, passedAt: 0 };
  list[id] = { tries: r.tries + 1, passes: r.passes + (passed ? 1 : 0), stars: passed ? Math.max(r.stars, Math.max(0, Math.min(3, Math.round(stars)))) : r.stars, last: now, passedAt: passed ? now : r.passedAt };
}

/** The stars of a lesson driven on the road: passed without a fault 3, with up to 4 fault points 2, else 1. */
export function lessonStars(passed: boolean, faultPoints: number): number {
  if (!passed) return 0;
  return faultPoints <= 0 ? 3 : faultPoints <= 4 ? 2 : 1;
}

/**
 * The end of a practical lesson (game.ts finish): its try, and the try of
 * each basic task finished in it (game/drills.ts) with the task's stars.
 */
export function noteLessonEnd(id: string, passed: boolean, faultPoints: number, drills: ReadonlyArray<{ id: string; stars: number; failed: boolean }> = [], now = Date.now(), store: LearnStore | null = defaultStore()): void {
  updateLearn((d) => {
    const stars = drills.length > 0 ? Math.round(drills.reduce((s, r) => s + r.stars, 0) / drills.length) : lessonStars(passed, faultPoints);
    noteTry(d.lessons, id, passed, stars, now);
    for (const r of drills) noteTry(d.drills, r.id, !r.failed, r.stars, now);
  }, store);
}

// ------------------------------------------------------------------ merging two copies

/** of two items, the one answered (tried) more often – on a tie the later */
function mergeBy<T>(a: Record<string, T>, b: Record<string, T>, weight: (t: T) => number, last: (t: T) => number): Record<string, T> {
  const out: Record<string, T> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const mine = out[k];
    if (!mine || weight(v) > weight(mine) || (weight(v) === weight(mine) && last(v) > last(mine))) out[k] = v;
  }
  return out;
}

function mergeLessons(a: Record<string, LessonRecord>, b: Record<string, LessonRecord>): Record<string, LessonRecord> {
  const out: Record<string, LessonRecord> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const m = out[k];
    out[k] = m ? { tries: Math.max(m.tries, v.tries), passes: Math.max(m.passes, v.passes), stars: Math.max(m.stars, v.stars), last: Math.max(m.last, v.last), passedAt: Math.max(m.passedAt, v.passedAt) } : v;
  }
  return out;
}

/** Two copies of what was learned, merged (the base – the copy both last agreed on – is not needed: nothing is ever taken out). */
export function mergeLearn(local: unknown, remote: unknown): LearnData {
  const l = cleanLearn(local);
  const r = cleanLearn(remote);
  const exams = new Map<number, ExamRecord>();
  for (const e of [...l.exams, ...r.exams]) if (!exams.has(e.t)) exams.set(e.t, e);
  return {
    exams: [...exams.values()].sort((a, b) => b.t - a.t).slice(0, EXAMS_KEPT),
    signs: mergeBy(l.signs, r.signs, (s) => s.right + s.wrong, (s) => s.last),
    danger: mergeBy(l.danger, r.danger, (s) => s.right + s.wrong, (s) => s.last),
    lessons: mergeLessons(l.lessons, r.lessons),
    drills: mergeLessons(l.drills, r.drills),
  };
}
