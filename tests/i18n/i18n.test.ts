// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The texts: every language is complete and well-formed, and the machinery
 * around them (fallback, placeholders, key names) works.
 *
 *   node --test "tests/i18n/*.test.ts"
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import en from '../../src/i18n/en.ts';
import { LANGS, dictOf, formatMonth, formatUnit, isRtl, keyName, lessonIntro, lessonTitle, loadLang, localeOf, pickLang, setKeyStyle, tr, violationRef, violationTitle, violationWhy } from '../../src/i18n/index.ts';
import { VIOLATION_REFS } from '../../src/i18n/violations.ts';
import { LESSONS } from '../../src/game/nav.ts';
import { checkDict, languageFiles } from '../../tools/i18n-check.ts';

test('every language file is registered, and every registered language loads', async () => {
  const files = languageFiles();
  assert.deepEqual([...LANGS.map((l) => l.code)].sort(), files, 'LANGS in src/i18n/index.ts and the files in src/i18n/ must match');
  assert.equal(new Set(LANGS.map((l) => l.code)).size, LANGS.length, 'no language twice');
  for (const l of LANGS) {
    assert.ok(await loadLang(l.code), `${l.code} cannot be loaded`);
    assert.ok(l.name.length > 1 && l.locale.startsWith(l.code), `${l.code}: name and locale`);
    // the locale must be one the browser's date and speech functions understand
    assert.doesNotThrow(() => new Intl.DateTimeFormat(l.locale, { month: 'long' }).format(new Date(0)), `${l.code}: locale ${l.locale}`);
  }
  assert.equal(await loadLang('xx'), false, 'an unknown language is refused');
});

test('every language is complete: same keys, placeholders, key tokens, names, numbers, lengths', async () => {
  for (const l of LANGS) {
    await loadLang(l.code);
    const report = checkDict(l.code, dictOf(l.code));
    assert.deepEqual(report.errors, [], `${l.name} (${l.code})`);
  }
});

test('the catalogue of faults and the lessons have their texts in the reference', () => {
  for (const id of Object.keys(VIOLATION_REFS)) {
    assert.ok(en[`v.${id}.title`], `v.${id}.title`);
    assert.ok(en[`v.${id}.why`], `v.${id}.why`);
    assert.ok(violationRef(id, 'en').length > 3, `rule of ${id}`);
  }
  for (const key of Object.keys(en)) {
    const m = /^v\.(\w+)\.title$/.exec(key);
    if (m) assert.ok(m[1] in VIOLATION_REFS, `${key} has no rule`);
  }
  for (const l of LESSONS) {
    assert.ok(en[`lesson.${l.id}.title`] && en[`lesson.${l.id}.intro`], `lesson ${l.id}`);
    assert.equal(lessonTitle(l.id, 'en'), en[`lesson.${l.id}.title`]);
    assert.ok(!lessonIntro(l.id, 'de').includes('[['), 'key tokens are resolved in the introduction');
  }
});

test('texts: placeholders, fallback to English, rule references', () => {
  assert.equal(tr('navIn', 'en', { d: 120, what: 'turn left' }), 'In 120 m turn left');
  assert.equal(tr('navIn', 'de', { d: 120, what: 'links abbiegen' }), 'In 120 m links abbiegen');
  assert.equal(violationTitle('speed', 'en', { speed: 62, limit: 50 }), 'Too fast: 62 where 50 km/h is allowed');
  assert.ok(violationWhy('redLight', 'de').startsWith('Rot'));
  assert.equal(violationRef('redLight', 'de'), '§ 37 Abs. 2 StVO', 'the citation is the same in every language');
  assert.equal(violationRef('stall', 'de'), 'Fahrzeugbedienung');
  assert.equal(violationRef('stall', 'en'), 'Vehicle handling');
  assert.equal(tr('no.such.key', 'de'), 'no.such.key', 'an unknown key shows itself');
  assert.equal(tr('paused', 'xx'), 'Paused', 'an unknown language falls back to English');
});

test('keys are named as printed on the keyboard usual for the language – or as the button on a touch screen', async () => {
  setKeyStyle('keys');
  assert.equal(tr('fastenBelt', 'en'), 'Fasten your seat belt: B');
  assert.equal(tr('releaseHandbrake', 'de'), 'Handbremse lösen: Leertaste');
  assert.equal(tr('releaseHandbrake', 'en'), 'Release the handbrake: Space');
  // the key left of X: Z on a US keyboard, Y on a German one
  assert.deepEqual([keyName('KeyZ', 'en'), keyName('KeyZ', 'de'), keyName('KeyY', 'de')], ['Z', 'Y', 'Z']);
  assert.deepEqual([keyName('Digit1', 'en'), keyName('ArrowUp', 'en'), keyName('F1', 'en'), keyName('ShiftLeft', 'de'), keyName('Escape', 'en')], ['1', '↑', 'F1', 'Umschalt', 'Esc']);
  if (LANGS.some((l) => l.code === 'fr')) {
    await loadLang('fr');
    // French keyboards: the driving keys W A S D carry Z Q S D
    assert.deepEqual(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ'].map((c) => keyName(c, 'fr')), ['Z', 'Q', 'S', 'D', 'A']);
  }
  setKeyStyle('touch');
  assert.equal(tr('releaseHandbrake', 'en'), 'Release the handbrake: P');
  assert.equal(tr('basics.belt', 'en'), 'Fasten your seat belt: press ⋯ Seat belt');
  assert.equal(tr('startEngine', 'en'), 'Start the engine: hold ⋯ Starter', 'the button is named without its hint in brackets');
  assert.equal(tr('basics.pullAway', 'de'), 'Sanft anfahren: etwas Gas (GAS), bis 15 km/h');
  assert.equal(keyName('KeyB', 'en'), 'B', 'tables of keys always show the key');
  setKeyStyle('keys');
});

test('the language is chosen from what the browser prefers', () => {
  assert.equal(pickLang(['de-AT', 'en']), 'de');
  assert.equal(pickLang(['en-US']), 'en');
  assert.equal(pickLang(['xx', 'yy']), 'en', 'nothing known: English');
  assert.equal(pickLang(['sr-RS', 'en']), 'hr', 'a closely related language before a foreign one');
  assert.equal(pickLang(['gsw-CH']), 'de');
  assert.equal(pickLang([]), 'en');
  for (const l of LANGS) assert.equal(pickLang([`${l.code}-XX`, 'en']), l.code);
  assert.equal(isRtl('de'), false);
  assert.equal(localeOf('de'), 'de-DE');
  if (LANGS.some((l) => l.code === 'ar')) assert.equal(isRtl('ar'), true);
});

test('right-to-left languages: citations stay in one left-to-right piece', async () => {
  const rtl = LANGS.filter((l) => l.rtl);
  assert.ok(rtl.some((l) => l.code === 'ar'), 'Arabic is written from right to left');
  for (const l of rtl) {
    await loadLang(l.code);
    assert.equal(violationRef('redLight', l.code), '\u2066§ 37 Abs. 2 StVO\u2069', l.code);
    assert.ok(tr('lesson.rbl.intro', l.code).includes('\u2066§\u00a08\u00a0StVO\u2069'), `${l.code}: the paragraph in the lesson text`);
    assert.ok(tr('about.signs', l.code).includes('\u2066§\u00a05\u00a0(1)\u00a0UrhG\u2069'), `${l.code}: the paragraph in the credits`);
    assert.doesNotMatch(violationRef('stall', l.code), /[\u2066\u2069]/, 'a word needs no mark');
  }
  assert.equal(violationRef('redLight', 'en'), '§ 37 Abs. 2 StVO', 'nothing is added in left-to-right languages');
  assert.doesNotMatch(tr('lesson.rbl.intro', 'de'), /[\u2066\u2069]/);
});

test('the checker finds what can go wrong in a translation', () => {
  const broken = (change: Record<string, string | undefined>): string[] => {
    const d: Record<string, string> = { ...en };
    for (const [k, v] of Object.entries(change)) {
      if (v === undefined) delete d[k];
      else d[k] = v;
    }
    return checkDict('xx', d).errors;
  };
  assert.deepEqual(broken({}), [], 'the reference itself is clean');
  assert.match(broken({ paused: undefined })[0], /paused: missing/);
  assert.match(broken({ extra: 'x' })[0], /not a key/);
  assert.match(broken({ navIn: 'In {dist} m {what}' })[0], /placeholders differ/);
  assert.match(broken({ fastenBelt: 'Fasten your seat belt: B' })[0], /key tokens differ/);
  assert.match(broken({ fastenBelt: 'Fasten your seat belt: [[KeyB]] [[KeyB]]' })[0], /key tokens differ/);
  assert.match(broken({ tbGas: 'ACCELERATOR' })[0], /at most 9 fit/);
  assert.match(broken({ walk: 'walkingspeed' })[0], /does not fit the roundel/);
  assert.match(broken({ 'lesson.motorway.title': '7 · Motorway' })[0], /"A 49" must stay/);
  assert.match(broken({ 'v.stopSign.why': en['v.stopSign.why'].replace('206', '207') })[0], /number 206 is missing/);
  assert.match(broken({ paused: 'Paused <b>' })[0], /no HTML/);
  assert.match(broken({ paused: ' Paused' })[0], /white space/);
  assert.match(broken({ 'v.speed.why': en['v.speed.why'].replace('50', '٥٠') }).join('|'), /Western/);
  assert.match(broken({ paused: 'Paused\u200f' })[0], /direction mark/);
  assert.match(broken({ trManual: 'Manual gearbox' })[0], /ctl\.clutch: must quote/);
  // a language with its own script must be written in it
  assert.match(checkDict('ru', en).errors.join('|'), /written in the script/);
  // hints, not errors: sentence ends and capital letters
  const hints = checkDict('xx', { ...en, paused: 'Paused.', navLeft: 'Turn left', freeDesc: en.freeDesc.replace(/\.$/, '') }).warnings.join('|');
  assert.match(hints, /paused: .*label/);
  assert.match(hints, /navLeft: .*capital/);
  assert.match(hints, /freeDesc: .*sentence/);
});

test('quantities and dates are written the way the language writes them, with Western digits', async () => {
  const plain = (s: string): string => s.replace(/\s/g, ' ');
  assert.equal(plain(formatUnit(5.12, 'kilometer', 'de', 1)), '5,1 km');
  assert.equal(plain(formatUnit(5.12, 'kilometer', 'en', 1)), '5.1 km');
  assert.match(formatUnit(12, 'minute', 'en'), /^12\s?min/);
  assert.equal(plain(formatUnit(40, 'meter', 'de')), '40 m');
  assert.match(formatUnit(5.12, 'kilometer', 'ru', 1), /^5,1\s?км$/);
  assert.equal(formatMonth(Date.UTC(2023, 4, 17), 'de'), 'Mai 2023');
  assert.equal(formatMonth(Date.UTC(2023, 4, 17), 'en'), 'May 2023');
  for (const l of LANGS) {
    const texts = [formatUnit(1234.5, 'kilometer', l.code, 1), formatUnit(7, 'minute', l.code), formatUnit(35, 'meter', l.code), formatMonth(Date.UTC(2023, 4, 17), l.code)];
    for (const t of texts) {
      assert.match(t, /[0-9]/, `${l.code}: "${t}" has Western digits`);
      assert.doesNotMatch(t, /[٠-٩۰-۹०-९]/, `${l.code}: "${t}"`);
    }
    assert.match(texts[3], /2023/, `${l.code}: the year`);
  }
  // a value is put in as it is, whatever it contains
  assert.equal(tr('navIn', 'en', { d: 50, what: 'cost $& more {d}' }), 'In 50 m cost $& more {d}');
});

test('every text the program asks for exists', () => {
  const src = fileURLToPath(new URL('../../src/', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !/[\\/]i18n[\\/][a-z]{2,3}\.ts$/.test(p)) files.push(p);
    }
  };
  walk(src);
  const asked = new Set<string>();
  for (const f of files) {
    const code = readFileSync(f, 'utf8');
    // this.t('key'), tr('key', …), and '@key' (a text named inside a table)
    for (const m of code.matchAll(/(?:\bt|\btr)\(\s*'([\w.]+)'/g)) asked.add(m[1]);
    for (const m of code.matchAll(/'[^'\n]*@(\w[\w.]*)'/g)) asked.add(m[1]);
  }
  assert.ok(asked.size > 100, `found only ${asked.size} texts in the code`);
  const missing = [...asked].filter((k) => !(k in en));
  assert.deepEqual(missing, [], 'asked for in the code, missing in src/i18n/en.ts');
});
