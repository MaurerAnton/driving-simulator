// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The sign trainer: every sign the game can draw – the official graphics of
 * public/signs/ and those render/signart.ts draws itself – shown one at a
 * time; the player picks its meaning (or its number in the catalogue) from
 * four.  Which sign comes next is decided by spaced repetition (Leitner
 * boxes): a sign answered right moves up a box and comes back later and
 * later – in five minutes, a day, three days, a week, three weeks – a sign
 * answered wrong goes back to the first box and comes again soon.  Signs due
 * come first, then new ones; when none is due, the one due soonest.
 *
 * Pure functions (tests/game/learn.test.ts); the meanings are in
 * src/i18n/exam/<lang>.ts under `signs`, the statistics kept by learnstore.ts.
 */
import { EXAM_EN } from '../../i18n/exam/index.ts';
import { shuffle } from './exam.ts';

/** The signs that render/signart.ts draws (all others are SVG files in public/signs/svg/). */
export const ART_SIGNS: ReadonlySet<string> = new Set(['133-20', '136-20', '138-20', '140-10', '142-20', '144-10', '238', '257-53', '257-54', '257-58', '258', '261', '263', '266', '268', '269', '270.1', '270.2', '273', '275-30', '277.1', '279-30', '354', '358', '363', '1010-62', '1022-12', '1024-14', '1024-17']);

/** The signs of the trainer, in the order they are first shown: as the catalogue numbers them. */
export const TRAINER_SIGNS: readonly string[] = Object.keys(EXAM_EN.signs).sort((a, b) => signOrder(a) - signOrder(b));

function signOrder(code: string): number {
  const m = /^(\d+)(?:\.(\d+))?(?:-(\d+))?/.exec(code);
  return m ? Number(m[1]) * 1e4 + Number(m[2] ?? 0) * 1e3 + Number(m[3] ?? 0) : 1e9;
}

/** The family of a sign, from which the wrong answers are taken: danger signs, speed signs, other rules, directions and information, added panels. */
export function signFamily(code: string): 'danger' | 'speed' | 'rule' | 'info' | 'panel' {
  const n = Number(/^\d+/.exec(code)?.[0] ?? 0);
  if (n >= 1000) return 'panel';
  if (n < 200) return 'danger';
  if (n === 274 || n === 275 || n === 278 || n === 279) return 'speed';
  if (n < 300) return 'rule';
  return 'info';
}

/** The number of a sign as the catalogue writes it ("Zeichen 274-50"). */
export const signNumber = (code: string): string => code;

/**
 * The four choices for a sign: its own and three others – of its family
 * where there are enough, never two with the same text.  `label` gives the
 * text of a choice (the meaning, or the number).
 */
export function signChoices(code: string, rand: () => number, label: (code: string) => string, codes: readonly string[] = TRAINER_SIGNS, n = 4): string[] {
  const seen = new Set([label(code)]);
  const out = [code];
  const fam = signFamily(code);
  const same = shuffle(codes.filter((c) => c !== code && signFamily(c) === fam), rand);
  const other = shuffle(codes.filter((c) => c !== code && signFamily(c) !== fam), rand);
  for (const c of [...same, ...other]) {
    if (out.length >= n) break;
    const l = label(c);
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(c);
  }
  return shuffle(out, rand);
}

/** What the trainer knows of a sign. */
export interface SignStat {
  /** the Leitner box: 0 (just wrong) … 5 */
  box: number;
  /** when it is due again (ms) */
  due: number;
  right: number;
  wrong: number;
  /** when it was last answered (ms) */
  last: number;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** how long a sign rests in each box before it comes again */
export const BOX_WAIT: readonly number[] = [0, 5 * MIN, DAY, 3 * DAY, 7 * DAY, 21 * DAY];
export const TOP_BOX = BOX_WAIT.length - 1;
/** from this box on a sign counts as learned */
export const LEARNED_BOX = 3;

/** A sign answered: right – up a box, wrong – back to the first. */
export function review(s: SignStat | undefined, right: boolean, now: number): SignStat {
  const box = right ? Math.min(TOP_BOX, (s?.box ?? 0) + 1) : 0;
  return { box, due: now + BOX_WAIT[box], right: (s?.right ?? 0) + (right ? 1 : 0), wrong: (s?.wrong ?? 0) + (right ? 0 : 1), last: now };
}

/**
 * The next sign to ask: one that is due (the lowest box first, the longest
 * due first), else a new one (in the catalogue's order), else the one due
 * soonest.  Never `avoid` (the one just asked) while another can be asked.
 */
export function nextSign(stats: Readonly<Record<string, SignStat | undefined>>, now: number, avoid = '', codes: readonly string[] = TRAINER_SIGNS): string {
  const pool = codes.length > 1 ? codes.filter((c) => c !== avoid) : codes;
  const due = pool.filter((c) => stats[c] && (stats[c] as SignStat).due <= now);
  if (due.length > 0) {
    due.sort((a, b) => (stats[a] as SignStat).box - (stats[b] as SignStat).box || (stats[a] as SignStat).due - (stats[b] as SignStat).due);
    return due[0];
  }
  const fresh = pool.find((c) => !stats[c]);
  if (fresh) return fresh;
  let best = pool[0] ?? avoid;
  for (const c of pool) if ((stats[c]?.due ?? 0) < (stats[best]?.due ?? Infinity)) best = c;
  return best;
}

/** How far the trainer has come: signs learned (box 3 and up), seen, due now, of how many. */
export function signProgress(stats: Readonly<Record<string, SignStat | undefined>>, now: number, codes: readonly string[] = TRAINER_SIGNS): { learned: number; seen: number; due: number; total: number } {
  let learned = 0;
  let seen = 0;
  let due = 0;
  for (const c of codes) {
    const s = stats[c];
    if (!s) continue;
    seen++;
    if (s.box >= LEARNED_BOX) learned++;
    if (s.due <= now) due++;
  }
  return { learned, seen, due, total: codes.length };
}
