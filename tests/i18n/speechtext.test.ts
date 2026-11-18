// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The texts made ready to be read out (src/i18n/speechtext.ts): units in
 * words, the ordinals of the roundabout exits, symbols and key codes gone,
 * long texts in pieces – for every language, on the texts the game speaks.
 *
 *   node --test tests/i18n/speechtext.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { LANGS, loadLang, tr } from '../../src/i18n/index.ts';
import { speakable, splitForSpeech } from '../../src/i18n/speechtext.ts';

const say = (key: string, lang: string, p?: Record<string, string | number>): string => speakable(tr(key, lang, p), lang);

test('units are read as words, in the grammar of the language', () => {
  assert.equal(speakable('In 200 m turn right', 'en'), 'In 200 metres turn right');
  assert.equal(speakable('Innerorts mindestens 1,5 m, außerorts mindestens 2 m.', 'de'), 'Innerorts mindestens 1,5 Meter, außerorts mindestens 2 Meter.');
  assert.equal(speakable('Za 200 m skręć w prawo', 'pl'), 'Za 200 metrów skręć w prawo');
  assert.equal(speakable('Через 200 м поверните', 'ru'), 'Через 200 метров поверните');
  assert.equal(speakable('Τουλάχιστον 1,5 m μέσα στην πόλη', 'el'), 'Τουλάχιστον 1,5 μέτρα μέσα στην πόλη');
  assert.equal(speakable('200 m先、右折', 'ja'), '200 メートル先、右折');
  assert.equal(speakable('Mit 30 km/h, vorsichtig', 'de'), 'Mit 30 Kilometer pro Stunde, vorsichtig');
  assert.equal(speakable('30 km/h', 'tr'), 'saatte 30 kilometre');
  assert.ok(!speakable('30 km/h', 'vi').includes('/'));
  // (not a unit: a word that begins with the letter)
  assert.equal(speakable('5 min', 'en'), '5 min');
  assert.equal(speakable('1 мин', 'ru'), '1 мин');
});

test('the exit of a roundabout is an ordinal word in the right case', () => {
  assert.equal(speakable('im Kreisverkehr die 2. Ausfahrt nehmen', 'de'), 'im Kreisverkehr die zweite Ausfahrt nehmen');
  assert.equal(speakable('en la rotonda, toma la 3.ª salida', 'es'), 'en la rotonda, toma la tercera salida');
  assert.equal(speakable('na kruhovém objezdu vyjeď 1. výjezdem', 'cs'), 'na kruhovém objezdu vyjeď prvním výjezdem');
  assert.equal(speakable('на круговом движении выберите 2-й съезд', 'ru'), 'на круговом движении выберите второй съезд');
  assert.equal(speakable('di bundaran ambil jalan keluar ke-1', 'id'), 'di bundaran ambil jalan keluar pertama');
  // (only before the noun: a full stop after a number stays one)
  assert.equal(speakable('Es sind 2. Dann weiter.', 'de'), 'Es sind 2. Dann weiter.');
});

test('symbols, dashes, quotes and key codes are not read as such', () => {
  assert.equal(speakable('Wer darf als Nächstes – du oder das weiße Auto?', 'de'), 'Wer darf als Nächstes, du oder das weiße Auto?');
  assert.equal(speakable('Am Schild „Vorfahrt gewähren“.', 'de'), 'Am Schild Vorfahrt gewähren.');
  assert.equal(speakable('in deinen toten Winkel (orange).', 'de'), 'in deinen toten Winkel, orange.');
  assert.equal(speakable('Press [[KeyG]] ★★☆ · then ↑', 'en'), 'Press G, then');
  assert.equal(speakable('⁦§ 37 StVO⁩', 'de'), '§ 37 Straßenverkehrsordnung');
  // (the Persian zero-width non-joiner belongs to the words)
  assert.equal(speakable('می‌رسند', 'fa'), 'می‌رسند');
  assert.equal(speakable('Trả lời đúng 3/5', 'vi'), 'Trả lời đúng 3 trên 5');
});

test('every language: the spoken texts come out clean', async () => {
  for (const l of LANGS) {
    assert.ok(await loadLang(l.code));
    const texts = [
      say('navIn', l.code, { d: 200, what: tr('navRight', l.code) }),
      say('navNow', l.code, { what: tr('navRoundabout', l.code, { n: 2 }) }),
      say('theory.overtake.2.why', l.code),
      say('theory.score', l.code, { right: 3, count: 5 }),
      say('theory.roundabout.intro', l.code),
    ];
    for (const s of texts) {
      assert.ok(s.length > 3, `${l.code}: ${s}`);
      assert.doesNotMatch(s, /[{}[\]„“”«»–—]|\d\s?(m|м|م)(?![\p{L}])/u, `${l.code}: ${s}`);
    }
  }
});

test('long texts are cut into pieces a voice reads in one go', () => {
  const s = 'Eins zwei drei. '.repeat(30).trim();
  const parts = splitForSpeech(s, 60);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 60, p);
  assert.equal(parts.join(' '), s);
  // (a single long sentence: at its commas, else at a space)
  const long = Array.from({ length: 20 }, (_, i) => `part ${i}`).join(', ');
  for (const p of splitForSpeech(long, 50)) assert.ok(p.length <= 50, p);
  const words = 'word '.repeat(60).trim();
  for (const p of splitForSpeech(words, 50)) assert.ok(p.length <= 50, p);
  // (scripts without spaces)
  const zh = '城区内至少1.5米。城区外至少2米。'.repeat(10);
  const zp = splitForSpeech(zh, 40);
  assert.ok(zp.length > 1 && zp.every((p) => p.length <= 40));
  assert.equal(zp.join(''), zh);
  // (short texts stay whole; the decimal point is no sentence end)
  assert.deepEqual(splitForSpeech('At least 1.5 metres. Go.'), ['At least 1.5 metres. Go.']);
  assert.deepEqual(splitForSpeech('   '), []);
});
