// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Checks the translations against the English reference:
 *
 *   node tools/i18n-check.ts            # every language in src/i18n
 *   node tools/i18n-check.ts fr pl      # only these
 *
 * A language is complete when it has exactly the keys of en.ts, every text
 * keeps its {placeholders} and [[key]] tokens, the names and numbers that
 * must not change are still there, and the short labels are short.
 * See docs/TRANSLATING.md.
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import en from '../src/i18n/en.ts';
import type { Dict } from '../src/i18n/types.ts';

export interface Report {
  errors: string[];
  warnings: string[];
}

/** Names that are the same in every language. */
const KEEP = [
  'StVO', '§', 'Baunatal', 'Fahrsim', 'Panoramax', 'KartaView', 'Mapillary', 'OpenStreetMap', 'ODbL', 'AGPL-3.0-only', 'three.js', 'MIT', 'Wikimedia Commons', 'CC BY-SA 4.0',
  'EXIF', 'XMP', 'GeoJSON', 'JSON', 'CSV', 'JPEG', 'PNG', 'WebP', 'WebGL 2', '▲', '▼', '⋯', 'DGM1', 'LoD2', 'UrhG', 'Marktplatz 5', 'A 49', 'Logitech', 'Thrustmaster', 'Fanatec',
  'RT', 'LT', 'RB/LB', 'X/B', 'Anlieger frei', 'P·R·N·D', '360°', 'IP', 'Kassel', 'CE', 'BE', 'C1E', 'D1E', 'C1', 'D1', 'A1', 'A2', 'AM', 'DE',
];

/** Longest text (in characters) that still fits where these keys are shown. */
const MAX: Array<[RegExp, number]> = [
  [/^tb(Gas|Brake)$/, 9],
  [/^(limitNone|walk)$/, 14],
  [/^key\./, 12],
  [/^(q(Low|Medium|High)|mOff)$/, 16],
  [/^kr\./, 26],
  [/^tb/, 34],
  [/^(start|free|exam|settings|controls|about|resume|menu|paused|back|result|passed|failed|faults|points|distance|duration|hint|minor|major|fail|reality|realityClose)$/, 34],
  [/^(realityCopy|realityCopied)$/, 16],
  [/^mapTitle$/, 22],
  [/^(viewChase|viewCockpit|enginePower|startView|mapPath|mapClearPath|logClear|logTitle|realityPlace|mapTeleport|endDrive|mapCentre|mapPlace)$/, 36],
  [/^realityAerial$/, 44],
  [/^nav(Left|Right|Uturn|Follow|Motorway)$|^lane(Left|Right)$|^routeDone$/, 60],
  [/^lesson\.\w+\.title$/, 60],
  [/^(demo|demoStart|demoClear|demoArrived|demoStop|demoTaken)$/, 34],
  [/^demoAdd$/, 40],
  [/^demoRunning$/, 120],
  [/^demo\.\w+$/, 96],
  [/^vehicle$/, 30],
  [/^veh(Car|Truck)$/, 46],
  [/^ce\.(corrections|gap)$/, 46],
  [/^ce\.onFoot$/, 64],
  [/^ce\.step\./, 84],
  [/^ce\.(do\.\w+|again)$/, 200],
  [/^v\.\w+\.title$/, 80],
];

/** Scripts: most texts of these languages must contain letters of the script (catches untranslated texts). */
const SCRIPT: Record<string, RegExp> = {
  ru: /[Ѐ-ӿ]/,
  uk: /[Ѐ-ӿ]/,
  el: /[Ͱ-Ͽ]/,
  ar: /[؀-ۿ]/,
  fa: /[؀-ۿ]/,
  ur: /[؀-ۿ]/,
  bn: /[ঀ-৿]/,
  bg: /[Ѐ-ӿ]/,
  hi: /[ऀ-ॿ]/,
  zh: /[一-鿿]/,
  ja: /[぀-ヿ一-鿿]/,
  ko: /[가-힯]/,
};

/** Languages whose letters are as wide as they are high: fewer of them fit. */
const WIDE = new Set(['zh', 'ja', 'ko']);
/** How a sentence may end (in any of the scripts). */
// (the Greek question mark is ";" – U+037E, which most keyboards write as the semicolon)
const SENTENCE_END = /[.!?…。！？।؟۔;;]["”»“’')）」』]*$/;
/** Digits other than 0–9, and characters that change the writing direction. */
const FOREIGN_DIGITS = /[٠-٩۰-۹०-९০-৯０-９]/;
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

const tokens = (s: string, re: RegExp): string[] => [...s.matchAll(re)].map((m) => m[0]).sort();
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export function checkDict(code: string, dict: unknown, ref: Dict = en): Report {
  const r: Report = { errors: [], warnings: [] };
  if (typeof dict !== 'object' || dict === null) {
    r.errors.push('the file does not export an object of texts');
    return r;
  }
  const d = dict as Record<string, unknown>;
  for (const k of Object.keys(ref)) if (!(k in d)) r.errors.push(`${k}: missing`);
  for (const k of Object.keys(d)) if (!(k in ref)) r.errors.push(`${k}: not a key of en.ts`);
  let scriptOk = 0;
  let scriptAll = 0;
  let identical = 0;
  for (const [k, source] of Object.entries(ref)) {
    const v = d[k];
    if (v === undefined) continue;
    if (typeof v !== 'string') {
      r.errors.push(`${k}: not a text`);
      continue;
    }
    if (v.trim() === '') r.errors.push(`${k}: empty`);
    if (v !== v.trim()) r.errors.push(`${k}: starts or ends with white space`);
    if (/[<>]/.test(v)) r.errors.push(`${k}: contains < or > (no HTML in texts)`);
    if (/\n/.test(v)) r.errors.push(`${k}: contains a line break`);
    if (!same(tokens(v, /\{\w+\}/g), tokens(source, /\{\w+\}/g))) r.errors.push(`${k}: placeholders differ from English (${tokens(source, /\{\w+\}/g).join(' ') || 'none'})`);
    if (!same(tokens(v, /\[\[\w+\]\]/g), tokens(source, /\[\[\w+\]\]/g))) r.errors.push(`${k}: key tokens differ from English (${tokens(source, /\[\[\w+\]\]/g).join(' ') || 'none'})`);
    if (/\[\[|\]\]|\{|\}/.test(v.replace(/\[\[\w+\]\]/g, '').replace(/\{\w+\}/g, ''))) r.errors.push(`${k}: stray brackets or braces`);
    for (const name of KEEP) if (source.includes(name) && !v.includes(name)) r.errors.push(`${k}: "${name}" must stay as it is`);
    // numbers of two and more digits (sign numbers, speeds) must all be there
    // (written the language's way: 7,5 where English writes 7.5)
    for (const n of source.replace(/\[\[\w+\]\]|\{\w+\}/g, '').match(/\d[\d.]*\d/g) ?? []) {
      const ways = [n, n.replace(/\./g, ','), n.replace(/\./g, '٫'), n.replace(/\./g, '')];
      if (!ways.some((w) => v.includes(w))) r.errors.push(`${k}: the number ${n} is missing`);
    }
    for (const [re, max] of MAX) {
      if (re.test(k)) {
        if ([...v].length > max) r.errors.push(`${k}: ${[...v].length} characters, at most ${max} fit ("${v}")`);
        break;
      }
    }
    // the roundel of the speed limit: the text may wrap at spaces, but a word must fit its width
    if (/^(limitNone|walk)$/.test(k)) {
      const longest = Math.max(...v.split(/\s+/).map((w) => [...w].length));
      const fits = WIDE.has(code) ? 4 : 9;
      if (longest > fits) r.errors.push(`${k}: the word of ${longest} characters does not fit the roundel (at most ${fits}) ("${v}")`);
    }
    if (FOREIGN_DIGITS.test(v)) r.errors.push(`${k}: digits must be the Western ones (0–9)`);
    if (BIDI_CONTROLS.test(v)) r.errors.push(`${k}: contains an invisible direction mark`);
    if (/ {2}/.test(v)) r.errors.push(`${k}: two spaces in a row`);
    // a sentence stays a sentence, a label stays a label
    if (code !== 'en') {
      const sentence = /[.!?…]$/.test(source);
      if (sentence && !SENTENCE_END.test(v)) r.warnings.push(`${k}: the English text ends a sentence, this one does not ("…${v.slice(-24)}")`);
      // (not the pedal labels, which may be abbreviated, and not "2." – an ordinal)
      if (!sentence && /[.。।۔]$/.test(v) && !/\.\)?$/.test(source) && !/\d\.$/.test(v) && !/^tb(Gas|Brake)$/.test(k)) r.warnings.push(`${k}: the English text is a label without a full stop, this one ends with one ("…${v.slice(-24)}")`);
      // parts of a sentence ("turn left") are put behind other words: no capital letter
      if (/^[a-z]/.test(source) && /^\p{Lu}\p{Ll}/u.test(v) && code !== 'de') r.warnings.push(`${k}: starts with a capital letter, but it is put into the middle of a sentence ("${v.slice(0, 24)}…")`);
    }
    if (code !== 'en' && v === source && /[A-Za-z]{4,}/.test(source.replace(/\[\[\w+\]\]|\{\w+\}/g, '')) && !KEEP.some((n) => source === n)) identical++;
    const script = SCRIPT[code];
    if (script && /[A-Za-zÀ-ɏ]{3,}/.test(source)) {
      scriptAll++;
      if (script.test(v)) scriptOk++;
      else if ([...v].length > 14) r.warnings.push(`${k}: no letters of the language's script ("${v.slice(0, 50)}")`);
    }
  }
  // the list of controls names the gearbox setting as the settings do
  if (typeof d.trManual === 'string' && typeof d['ctl.clutch'] === 'string' && !d['ctl.clutch'].includes(d.trManual)) r.errors.push(`ctl.clutch: must quote the text of trManual ("${d.trManual}")`);
  if (identical > 12) r.warnings.push(`${identical} texts are identical to the English ones – untranslated?`);
  if (scriptAll > 0 && scriptOk < scriptAll * 0.93) r.errors.push(`only ${scriptOk} of ${scriptAll} texts are written in the script of the language`);
  return r;
}

/** Codes of all language files next to en.ts. */
export function languageFiles(): string[] {
  const dir = fileURLToPath(new URL('../src/i18n/', import.meta.url));
  return readdirSync(dir)
    .filter((f) => /^[a-z]{2,3}\.ts$/.test(f))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
}

export async function loadDict(code: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(fileURLToPath(new URL(`../src/i18n/${code}.ts`, import.meta.url))).href)) as { default?: unknown };
  return mod.default;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const codes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : languageFiles().filter((c) => c !== 'en');
  let bad = 0;
  for (const code of codes) {
    let report: Report;
    try {
      report = checkDict(code, await loadDict(code));
    } catch (e) {
      report = { errors: [`cannot be loaded: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`], warnings: [] };
    }
    for (const w of report.warnings) console.log(`${code}: warning – ${w}`);
    for (const e of report.errors) console.log(`${code}: ERROR – ${e}`);
    console.log(`${code}: ${report.errors.length === 0 ? 'ok' : `${report.errors.length} error(s)`}${report.warnings.length ? `, ${report.warnings.length} warning(s)` : ''} (${Object.keys(en).length} texts)`);
    if (report.errors.length > 0) bad++;
  }
  process.exit(bad > 0 ? 1 : 0);
}
