// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The words of the learning modes (ui/learn.ts) in the languages: the
 * questions of the theory exam, the "spot the danger" items and the meanings
 * of the signs of the sign trainer.  They are many and long, so they live
 * apart from the texts of the interface (src/i18n/<lang>.ts) and are fetched
 * only when a learning mode is opened.
 *
 * All 28 languages of the game.  To add a language: copy en.ts to <lang>.ts,
 * translate the values (keep the ids and the order of the answers – the right
 * answers are counted by their places, game/exam/questions.ts), and add a
 * line to EXAM_LANGS below.  Whatever a language lacks – a question, an
 * answer, a sign – is taken from English, so a translation can be done bit
 * by bit.  The rules (the references) stay in German in every language.
 */
import en from './en.ts';

/** A question (or a danger item): its text, its answers in order, why the right ones are right. */
export interface ExamText {
  q: string;
  a: string[];
  why: string;
}

export interface ExamTexts {
  questions: Record<string, ExamText>;
  danger: Record<string, ExamText>;
  /** what a sign means, by its catalogue number */
  signs: Record<string, string>;
}

/** The languages that have the words of their own (all others: English). */
export const EXAM_LANGS: Readonly<Record<string, () => Promise<{ default: ExamTexts }>>> = {
  en: () => Promise.resolve({ default: en }),
  ar: () => import('./ar.ts'),
  bg: () => import('./bg.ts'),
  bn: () => import('./bn.ts'),
  cs: () => import('./cs.ts'),
  de: () => import('./de.ts'),
  el: () => import('./el.ts'),
  es: () => import('./es.ts'),
  fa: () => import('./fa.ts'),
  fr: () => import('./fr.ts'),
  hi: () => import('./hi.ts'),
  hr: () => import('./hr.ts'),
  hu: () => import('./hu.ts'),
  id: () => import('./id.ts'),
  it: () => import('./it.ts'),
  ja: () => import('./ja.ts'),
  ko: () => import('./ko.ts'),
  nl: () => import('./nl.ts'),
  pl: () => import('./pl.ts'),
  pt: () => import('./pt.ts'),
  ro: () => import('./ro.ts'),
  ru: () => import('./ru.ts'),
  sq: () => import('./sq.ts'),
  tr: () => import('./tr.ts'),
  uk: () => import('./uk.ts'),
  ur: () => import('./ur.ts'),
  vi: () => import('./vi.ts'),
  zh: () => import('./zh.ts'),
};

/** One language's words with English beneath: what it lacks comes from English. */
export function withFallback(own: Partial<ExamTexts> | null): ExamTexts {
  if (!own) return en;
  const merge = (a: Record<string, ExamText> | undefined, b: Record<string, ExamText>): Record<string, ExamText> => {
    const out: Record<string, ExamText> = { ...b };
    for (const [k, v] of Object.entries(a ?? {})) {
      const base = b[k];
      // (a question whose answers are not all translated keeps English for the missing ones)
      out[k] = base ? { q: v.q || base.q, a: base.a.map((x, i) => v.a?.[i] || x), why: v.why || base.why } : v;
    }
    return out;
  };
  return { questions: merge(own.questions, en.questions), danger: merge(own.danger, en.danger), signs: { ...en.signs, ...(own.signs ?? {}) } };
}

/** The words in a language (English for a language that has none of its own yet). */
export async function loadExamTexts(lang: string): Promise<ExamTexts> {
  const load = EXAM_LANGS[lang];
  if (!load || lang === 'en') return en;
  try {
    return withFallback((await load()).default);
  } catch {
    return en;
  }
}

/** The English words, at once (tests, and while another language is fetched). */
export const EXAM_EN: ExamTexts = en;
