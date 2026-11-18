// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Texts made ready to be read out.
 *
 * The texts are written to be read on the screen: "In 200 m turn right",
 * "die 2. Ausfahrt", "la 2.ª salida", "[[KeyG]]", a dash, a star.  A voice of
 * the browser reads many of these badly – a lone "m" as the letter, "2.ª" as
 * "two point a", a Latin "m" inside Greek or Hindi text as the English
 * letter, an arrow as "leftwards arrow".  speakable() turns such pieces into
 * the words they stand for, language by language: a number with its unit
 * becomes the long form the language writes (the plural and case right, from
 * the browser's own Intl data: "200 metrów", "1,5 метра"), the ordinal of a
 * roundabout exit the word in the case the sentence wants, symbols a pause or
 * nothing.  splitForSpeech() then cuts a long text into pieces a voice reads
 * in one go (Chrome stops a voice after about 15 seconds).
 *
 * Pure functions, no DOM: tests/i18n/speechtext.test.ts.
 */
import { keyName, localeOf } from './index.ts';

// ------------------------------------------------------------------ units

type Unit = 'meter' | 'kilometer' | 'kilometer-per-hour';

/** The ways the texts write the units, in every script they use. */
const UNIT_TOKENS: Array<[string, Unit]> = [
  ['km/h', 'kilometer-per-hour'],
  ['км/ч', 'kilometer-per-hour'],
  ['км/год', 'kilometer-per-hour'],
  ['كم/س', 'kilometer-per-hour'],
  ['km', 'kilometer'],
  ['км', 'kilometer'],
  ['كم', 'kilometer'],
  ['m', 'meter'],
  ['м', 'meter'],
  ['م', 'meter'],
];
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/**
 * A number (decimal comma or point, one or two places) and a unit that stands
 * alone – not the start of a word in the same script ("1 мин", "5 min" are
 * not metres).  Japanese "200 m先" has a CJK sign after the unit: that is fine.
 */
const UNIT_RE = new RegExp(`(\\d+(?:[.,]\\d{1,2})?)(?!\\d)\\s?(${UNIT_TOKENS.map(([t]) => esc(t)).join('|')})(?![\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Arabic}\\p{N}])`, 'gu');
const UNIT_OF = new Map(UNIT_TOKENS);

/** "1,5" → 1.5; "200" → 200 */
const parseNum = (s: string): number => Number(s.replace(',', '.'));

function unitWords(value: number, unit: Unit, lang: string): string | null {
  let out: string;
  try {
    out = new Intl.NumberFormat(localeOf(lang), { style: 'unit', unit, unitDisplay: 'long', maximumFractionDigits: 2, numberingSystem: 'latn' }).format(value);
  } catch {
    return null;
  }
  // (CLDR writes a few speeds with a slash: "30 kilometre/saat", "30 kilômét/giờ")
  if (out.includes('/')) {
    if (lang === 'tr') out = out.replace(/^(.*?)\s*kilometre\/saat$/, 'saatte $1 kilometre');
    else if (lang === 'vi') out = out.replace('/', ' một ');
    out = out.replace(/\//g, ' ');
  }
  return out;
}

// ------------------------------------------------------------------ ordinals

/**
 * The exit of a roundabout is written with a figure ("die {n}. Ausfahrt");
 * read out, the figure needs the ordinal word in the gender and case of the
 * noun after it.  Each rule only fires right before that noun.
 */
const ORDINALS: Record<string, { re: RegExp; words: readonly string[] }> = {
  de: { re: /(?<!\d)(\d{1,2})\.(?=\s+Ausfahrt)/gu, words: ['erste', 'zweite', 'dritte', 'vierte', 'fünfte', 'sechste', 'siebte', 'achte', 'neunte', 'zehnte'] },
  cs: { re: /(?<!\d)(\d{1,2})\.(?=\s+výjezdem)/gu, words: ['prvním', 'druhým', 'třetím', 'čtvrtým', 'pátým', 'šestým', 'sedmým', 'osmým', 'devátým', 'desátým'] },
  pl: { re: /(?<!\d)(\d{1,2})\.(?=\s+zjazdem)/gu, words: ['pierwszym', 'drugim', 'trzecim', 'czwartym', 'piątym', 'szóstym', 'siódmym', 'ósmym', 'dziewiątym', 'dziesiątym'] },
  hr: { re: /(?<!\d)(\d{1,2})\.(?=\s+izlazu)/gu, words: ['prvom', 'drugom', 'trećem', 'četvrtom', 'petom', 'šestom', 'sedmom', 'osmom', 'devetom', 'desetom'] },
  tr: { re: /(?<!\d)(\d{1,2})\.(?=\s+çıkış)/gu, words: ['birinci', 'ikinci', 'üçüncü', 'dördüncü', 'beşinci', 'altıncı', 'yedinci', 'sekizinci', 'dokuzuncu', 'onuncu'] },
  hu: { re: /(?<!\d)(\d{1,2})\.(?=\s+kijárat)/gu, words: ['első', 'második', 'harmadik', 'negyedik', 'ötödik', 'hatodik', 'hetedik', 'nyolcadik', 'kilencedik', 'tizedik'] },
  nl: { re: /(?<!\d)(\d{1,2})e(?=\s+afslag)/gu, words: ['eerste', 'tweede', 'derde', 'vierde', 'vijfde', 'zesde', 'zevende', 'achtste', 'negende', 'tiende'] },
  es: { re: /(?<!\d)(\d{1,2})\.?ª(?=\s+salida)/gu, words: ['primera', 'segunda', 'tercera', 'cuarta', 'quinta', 'sexta', 'séptima', 'octava', 'novena', 'décima'] },
  pt: { re: /(?<!\d)(\d{1,2})\.?ª(?=\s+saída)/gu, words: ['primeira', 'segunda', 'terceira', 'quarta', 'quinta', 'sexta', 'sétima', 'oitava', 'nona', 'décima'] },
  el: { re: /(?<!\d)(\d{1,2})η(?=\s+έξοδο)/gu, words: ['πρώτη', 'δεύτερη', 'τρίτη', 'τέταρτη', 'πέμπτη', 'έκτη', 'έβδομη', 'όγδοη', 'ένατη', 'δέκατη'] },
  ru: { re: /(?<!\d)(\d{1,2})-й(?=\s+съезд)/gu, words: ['первый', 'второй', 'третий', 'четвёртый', 'пятый', 'шестой', 'седьмой', 'восьмой', 'девятый', 'десятый'] },
  uk: { re: /(?<!\d)(\d{1,2})-й(?=\s+з['’]їзд)/gu, words: ['перший', 'другий', 'третій', 'четвертий', 'п’ятий', 'шостий', 'сьомий', 'восьмий', 'дев’ятий', 'десятий'] },
  id: { re: /\bke-(\d{1,2})(?!\d)/gu, words: ['pertama', 'kedua', 'ketiga', 'keempat', 'kelima', 'keenam', 'ketujuh', 'kedelapan', 'kesembilan', 'kesepuluh'] },
};

// ------------------------------------------------------------------ words

/** Abbreviations a voice spells or stumbles over, per language: [pattern, spoken]. */
const WORDS: Record<string, Array<[RegExp, string]>> = {
  de: [
    [/\bz\.\s?B\./g, 'zum Beispiel'],
    [/\bbzw\./g, 'beziehungsweise'],
    [/\bggf\./g, 'gegebenenfalls'],
    [/\bStVO\b/g, 'Straßenverkehrsordnung'],
  ],
  en: [
    [/\be\.g\./g, 'for example'],
    [/\bi\.e\./g, 'that is'],
  ],
  // ("daljen nr. 2": the number, not "en-er")
  sq: [[/\bnr\.\s?(?=\d)/g, 'numër ']],
  // ("3/5" in the score: three of five, not a fraction or a date)
  vi: [[/(\d+)\s?\/\s?(\d+)/g, '$1 trên $2']],
};

// ------------------------------------------------------------------ the whole

/**
 * Glyphs that are labels on the screen (arrows of the keys, the buttons of
 * the touch controls, stars) or decoration: read out they are noise.
 */
const GLYPHS = /[←→↑↓▲▼◀▶⋯★☆✓✔✗✘•]|\p{Extended_Pictographic}/gu;

/** A text as it should be read out in a language. */
export function speakable(text: string, lang: string): string {
  let s = text;
  // marks of direction, soft hyphens, zero-width spaces (not the joiners: Persian writes with them)
  s = s.replace(/[⁦-⁩‎‏​­]/g, '');
  // a key left as code: its name
  s = s.replace(/\[\[(\w+)\]\]/g, (_, code: string) => keyName(code, lang));
  const ord = ORDINALS[lang];
  if (ord) s = s.replace(ord.re, (m, n: string) => ord.words[Number(n) - 1] ?? m);
  for (const [re, to] of WORDS[lang] ?? []) s = s.replace(re, to);
  s = s.replace(UNIT_RE, (m, num: string, tok: string) => unitWords(parseNum(num), UNIT_OF.get(tok) as Unit, lang) ?? m);
  // a separator or a dash between words: a pause
  s = s.replace(/\s*[·|]\s*/g, ', ').replace(/\s+[–—]\s+/g, ', ');
  s = s.replace(GLYPHS, ' ');
  // quotation marks are not read; brackets are a pause
  s = s.replace(/["„“”«»]/g, '').replace(/\s*[()]\s*/g, ', ');
  s = s.replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/,\s*,/g, ',').replace(/,\s*([.!?])/g, '$1');
  return s.replace(/^[\s,]+|[\s,]+$/g, '');
}

/** Where a sentence ends: a stop with a space after it, or a full-width / Indic / Arabic one. */
const SENTENCE = /(?<=[.!?…])\s+|(?<=[。！？।؟۔])\s*/u;
/** Where a long sentence may be cut: after a comma, colon or semicolon of any script. */
const CLAUSE = /(?<=[,;:،、，；：])\s*/u;

/**
 * A text in pieces a voice reads in one go: whole sentences, packed together
 * while they fit in `max` characters; a longer sentence cut at its commas,
 * and failing those at a space (or anywhere, in a script without spaces).
 */
export function splitForSpeech(text: string, max = 180): string[] {
  const parts: string[] = [];
  const cut = (piece: string): void => {
    if (piece.length <= max) {
      parts.push(piece);
      return;
    }
    const clauses = piece.split(CLAUSE).filter((c) => c.trim());
    if (clauses.length > 1) {
      pack(clauses, ' ');
      return;
    }
    let rest = piece;
    while (rest.length > max) {
      let at = rest.lastIndexOf(' ', max);
      if (at < max / 3) at = max;
      parts.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) parts.push(rest);
  };
  const pack = (pieces: string[], join: string): void => {
    let cur = '';
    for (const raw of pieces) {
      const p = raw.trim();
      if (!p) continue;
      if (!cur) cur = p;
      else if (cur.length + join.length + p.length <= max) cur += join + p;
      else {
        cut(cur);
        cur = p;
      }
    }
    if (cur) cut(cur);
  };
  // (the scripts without spaces between sentences are joined without one)
  const sentences = text.trim().split(SENTENCE);
  pack(sentences, /[　-鿿가-힯]/u.test(text) ? '' : ' ');
  return parts;
}
