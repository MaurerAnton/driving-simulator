// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Texts in many languages.
 *
 * German and English are always there; every other language is a file of its
 * own (src/i18n/<code>.ts) that is fetched when it is chosen.  A text missing
 * in a language falls back to English.  To add a language: copy en.ts,
 * translate the values, add a line to LANGS – `npm test` checks that nothing
 * is missing.
 */
import de from './de.ts';
import en from './en.ts';
import { keyLabel, touchLabel } from './keys.ts';
import type { Dict } from './types.ts';
import { VIOLATION_REFS } from './violations.ts';

export type Lang = string;

export interface LangInfo {
  code: string;
  /** the name of the language in the language itself */
  name: string;
  /** for dates and the spoken instructions */
  locale: string;
  /** written from right to left */
  rtl?: boolean;
  load?: () => Promise<{ default: Dict }>;
}

/** In the order of the language menu. */
export const LANGS: readonly LangInfo[] = [
  { code: 'de', name: 'Deutsch', locale: 'de-DE' },
  { code: 'en', name: 'English', locale: 'en-GB' },
  { code: 'id', name: 'Bahasa Indonesia', locale: 'id-ID', load: () => import('./id.ts') },
  { code: 'cs', name: 'Čeština', locale: 'cs-CZ', load: () => import('./cs.ts') },
  { code: 'es', name: 'Español', locale: 'es-ES', load: () => import('./es.ts') },
  { code: 'fr', name: 'Français', locale: 'fr-FR', load: () => import('./fr.ts') },
  { code: 'hr', name: 'Hrvatski', locale: 'hr-HR', load: () => import('./hr.ts') },
  { code: 'it', name: 'Italiano', locale: 'it-IT', load: () => import('./it.ts') },
  { code: 'hu', name: 'Magyar', locale: 'hu-HU', load: () => import('./hu.ts') },
  { code: 'nl', name: 'Nederlands', locale: 'nl-NL', load: () => import('./nl.ts') },
  { code: 'pl', name: 'Polski', locale: 'pl-PL', load: () => import('./pl.ts') },
  { code: 'pt', name: 'Português', locale: 'pt-PT', load: () => import('./pt.ts') },
  { code: 'ro', name: 'Română', locale: 'ro-RO', load: () => import('./ro.ts') },
  { code: 'sq', name: 'Shqip', locale: 'sq-AL', load: () => import('./sq.ts') },
  { code: 'vi', name: 'Tiếng Việt', locale: 'vi-VN', load: () => import('./vi.ts') },
  { code: 'tr', name: 'Türkçe', locale: 'tr-TR', load: () => import('./tr.ts') },
  { code: 'el', name: 'Ελληνικά', locale: 'el-GR', load: () => import('./el.ts') },
  { code: 'bg', name: 'Български', locale: 'bg-BG', load: () => import('./bg.ts') },
  { code: 'ru', name: 'Русский', locale: 'ru-RU', load: () => import('./ru.ts') },
  { code: 'uk', name: 'Українська', locale: 'uk-UA', load: () => import('./uk.ts') },
  { code: 'ar', name: 'العربية', locale: 'ar', rtl: true, load: () => import('./ar.ts') },
  { code: 'fa', name: 'فارسی', locale: 'fa-IR', rtl: true, load: () => import('./fa.ts') },
  { code: 'ur', name: 'اردو', locale: 'ur-PK', rtl: true, load: () => import('./ur.ts') },
  { code: 'hi', name: 'हिन्दी', locale: 'hi-IN', load: () => import('./hi.ts') },
  { code: 'bn', name: 'বাংলা', locale: 'bn-BD', load: () => import('./bn.ts') },
  { code: 'zh', name: '简体中文', locale: 'zh-CN', load: () => import('./zh.ts') },
  { code: 'ja', name: '日本語', locale: 'ja-JP', load: () => import('./ja.ts') },
  { code: 'ko', name: '한국어', locale: 'ko-KR', load: () => import('./ko.ts') },
];

const dicts = new Map<string, Dict>([
  ['de', de],
  ['en', en],
]);

export const langInfo = (code: string): LangInfo => LANGS.find((l) => l.code === code) ?? LANGS[1];
export const isRtl = (code: string): boolean => langInfo(code).rtl === true;
export const localeOf = (code: string): string => langInfo(code).locale;

/** Fetch the texts of a language (no-op if they are there). Resolves to false if that fails. */
export async function loadLang(code: string): Promise<boolean> {
  if (dicts.has(code)) return true;
  const info = LANGS.find((l) => l.code === code);
  if (!info?.load) return false;
  try {
    dicts.set(code, (await info.load()).default);
    return true;
  } catch {
    return false;
  }
}

/** Languages that are not here, but whose readers understand one that is. */
const RELATED: Record<string, string> = {
  bs: 'hr',
  sr: 'hr',
  sh: 'hr',
  sk: 'cs',
  ms: 'id',
  be: 'ru',
  ca: 'es',
  gl: 'es',
  mo: 'ro',
  lb: 'de',
  gsw: 'de',
  nds: 'de',
};

/** The first of the reader's languages (navigator.languages) that exists here – or a closely related one; English otherwise. */
export function pickLang(preferred: readonly string[]): string {
  const has = (code: string | undefined): code is string => !!code && LANGS.some((l) => l.code === code);
  for (const p of preferred) {
    const primary = p.toLowerCase().split('-')[0];
    if (has(primary)) return primary;
    if (has(RELATED[primary])) return RELATED[primary];
  }
  return 'en';
}

let keyStyle: 'keys' | 'touch' = 'keys';
/** Name keys as keys of the keyboard or as the buttons on the screen that stand in for them. */
export function setKeyStyle(style: 'keys' | 'touch'): void {
  keyStyle = style;
}

/**
 * Inside right-to-left text a citation such as "§ 37 Abs. 2 StVO" would be
 * torn apart and re-ordered; marked as one left-to-right piece it stays whole.
 */
const ltrPiece = (s: string): string => `\u2066${s}\u2069`;
const CITATION = /§\s*\d[\w\s.,()§]*?(?:StVO|UrhG)/g;

function lookup(key: string, lang: Lang): string {
  return dicts.get(lang)?.[key] ?? en[key] ?? key;
}

/** The label of a key of the keyboard for the texts and tables (always the key, never the touch button). */
export function keyName(code: string, lang: Lang): string {
  return keyLabel(code, lang, (k) => lookup(k, lang));
}

/** A text: {name} placeholders are filled from `params`, [[KeyX]] becomes the name of that key. */
export function tr(key: string, lang: Lang, params?: Record<string, string | number>): string {
  let s = lookup(key, lang);
  if (s.includes('[[')) {
    const name = (k: string): string => lookup(k, lang);
    s = s.replace(/\[\[(\w+)\]\]/g, (_, code: string) => (keyStyle === 'touch' ? touchLabel(code, lang, name) : keyLabel(code, lang, name)));
  }
  // (a function as replacement: a value may contain "$&" – a file name, a street name)
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, () => String(v));
  // (inside a sentence also kept on one line)
  if (isRtl(lang) && s.includes('§')) s = s.replace(CITATION, (c) => ltrPiece(c.replace(/ /g, '\u00a0')));
  return s;
}

const UNIT_FALLBACK = { kilometer: 'km', meter: 'm', minute: 'min' } as const;

/**
 * A quantity with its unit the way the language writes it ("5,1 km",
 * "12 мин", "5.1公里") – with Western digits, like all the texts.
 */
export function formatUnit(value: number, unit: keyof typeof UNIT_FALLBACK, lang: Lang, digits = 0): string {
  try {
    return new Intl.NumberFormat(localeOf(lang), {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      numberingSystem: 'latn',
    }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${UNIT_FALLBACK[unit]}`;
  }
}

/** Month and year of a point in time ("May 2023"). */
export function formatMonth(time: number, lang: Lang): string {
  // (the calendar of the photographs and of the country the simulator is about, whatever the language's own is)
  return new Date(time).toLocaleDateString(localeOf(lang), { year: 'numeric', month: 'long', timeZone: 'UTC', numberingSystem: 'latn', calendar: 'gregory' });
}

export function violationTitle(id: string, lang: Lang, data: Record<string, number | string>): string {
  return tr(`v.${id}.title`, lang, data);
}

export function violationWhy(id: string, lang: Lang): string {
  return tr(`v.${id}.why`, lang);
}

/** The rule a fault refers to (the German citation, or a word where there is none). */
export function violationRef(id: string, lang: Lang): string {
  const r = VIOLATION_REFS[id] ?? '';
  if (r.startsWith('@')) return tr(r.slice(1), lang);
  return isRtl(lang) ? ltrPiece(r) : r;
}

export const lessonTitle = (id: string, lang: Lang): string => tr(`lesson.${id}.title`, lang);
export const lessonIntro = (id: string, lang: Lang): string => tr(`lesson.${id}.intro`, lang);

/** For the tests and tools: the texts of a language that has been loaded. */
export function dictOf(code: string): Dict | undefined {
  return dicts.get(code);
}
