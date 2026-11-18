// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The choice of the voice (src/audio/voicepick.ts), on made-up lists of
 * voices as Chrome, Edge, Safari, Firefox and Android give them.
 *
 *   node --test tests/audio/voicepick.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseVoice, cleanSpeechPrefs, parseTag, prefOf, rankVoices, voiceFit, voiceStatus } from '../../src/audio/voicepick.ts';
import type { VoiceLike } from '../../src/audio/voicepick.ts';

const v = (name: string, lang: string, localService = true, isDefault = false): VoiceLike => ({ name, lang, voiceURI: `uri:${name}`, localService, default: isDefault });

// a mix of what browsers list
const VOICES: VoiceLike[] = [
  v('Microsoft David - English (United States)', 'en-US', true, true),
  v('Google US English', 'en-US', false),
  v('Google UK English Female', 'en-GB', false),
  v('Microsoft Hedda - German (Germany)', 'de-DE'),
  v('Microsoft Katja Online (Natural) - German (Germany)', 'de-DE', false),
  v('Microsoft Ingrid Online (Natural) - German (Austria)', 'de-AT', false),
  v('Anna', 'de-DE'),
  v('Bubbles', 'de-DE'),
  v('Google português do Brasil', 'pt-BR', false),
  v('Joana', 'pt_PT'),
  v('Google 粤語（香港）', 'zh-HK', false),
  v('Google 普通话（中国大陆）', 'zh-CN', false),
  v('Google 國語（臺灣）', 'zh-TW', false),
  v('eSpeak Hindi', 'hi'),
  v('Google हिन्दी', 'hi-IN', false),
  v('Microsoft Gabrijela Online (Natural) - Croatian (Croatia)', 'sr-Latn-RS', false),
  v('Damayanti', 'in-ID'),
];

test('language tags of every browser are understood', () => {
  assert.deepEqual(parseTag('pt_PT'), { lang: 'pt', region: 'pt', script: '' });
  assert.deepEqual(parseTag('sr-Latn-RS'), { lang: 'sr', region: 'rs', script: 'latn' });
  assert.equal(parseTag('in-ID').lang, 'id');
  assert.equal(parseTag('cmn-Hans-CN').lang, 'zh');
  assert.equal(parseTag('zh-Hant').region, 'tw');
});

test('the best voice of the locale wins: natural/online first, the right region before another', () => {
  assert.equal(rankVoices(VOICES, 'de-DE')[0].name, 'Microsoft Katja Online (Natural) - German (Germany)');
  // (Austria after Germany, even as a natural voice; the toy voice last)
  const de = rankVoices(VOICES, 'de-DE').map((x) => x.name);
  assert.ok(de.indexOf('Microsoft Hedda - German (Germany)') < de.indexOf('Microsoft Ingrid Online (Natural) - German (Austria)'));
  assert.equal(de.at(-1), 'Bubbles');
  assert.equal(rankVoices(VOICES, 'en-GB')[0].name, 'Google UK English Female');
  assert.equal(rankVoices(VOICES, 'pt-PT')[0].name, 'Joana');
  assert.equal(rankVoices(VOICES, 'hi-IN')[0].name, 'Google हिन्दी');
  assert.equal(rankVoices(VOICES, 'zh-CN')[0].name, 'Google 普通话（中国大陆）');
  assert.equal(rankVoices(VOICES, 'id-ID')[0].name, 'Damayanti');
});

test('never a voice of another language; Cantonese never reads Mandarin', () => {
  assert.equal(voiceFit(v('Google US English', 'en-US'), 'sq-AL'), null);
  assert.deepEqual(rankVoices(VOICES, 'sq-AL'), []);
  assert.deepEqual(rankVoices(VOICES, 'bn-BD'), []);
  assert.ok(!rankVoices(VOICES, 'zh-CN').some((x) => x.lang === 'zh-HK'));
  assert.equal(voiceFit(v('Ting-Ting', 'zh-TW'), 'zh-CN'), 'language');
  assert.equal(voiceFit(v('x', 'yue-HK'), 'zh-CN'), null);
});

test('what the settings say about a language', () => {
  assert.equal(voiceStatus(VOICES, 'de-DE'), 'good');
  assert.equal(voiceStatus(VOICES, 'ur-PK'), 'none');
  assert.equal(voiceStatus(VOICES, 'hr-HR'), 'related');
  assert.equal(voiceStatus([], 'de-DE'), 'unknown');
});

test('the voice the player chose – if it is there, reads the language and has not failed', () => {
  assert.equal(chooseVoice(VOICES, 'de-DE', 'uri:Anna')?.name, 'Anna');
  assert.equal(chooseVoice(VOICES, 'de-DE', 'Anna')?.name, 'Anna');
  assert.equal(chooseVoice(VOICES, 'de-DE', 'uri:Google US English')?.name, 'Microsoft Katja Online (Natural) - German (Germany)');
  assert.equal(chooseVoice(VOICES, 'de-DE', 'uri:gone')?.name, 'Microsoft Katja Online (Natural) - German (Germany)');
  // (offline: the network voice failed – the next one)
  const failed = new Set(['uri:Microsoft Katja Online (Natural) - German (Germany)']);
  assert.notEqual(chooseVoice(VOICES, 'de-DE', '', failed)?.name, 'Microsoft Katja Online (Natural) - German (Germany)');
  assert.equal(chooseVoice(VOICES, 'sq-AL'), null);
});

test('the stored choices are checked', () => {
  assert.deepEqual(cleanSpeechPrefs(null), {});
  assert.deepEqual(cleanSpeechPrefs({ de: { voice: 'uri:Anna', rate: 1.2, pitch: 0.9 }, xx1: {}, en: { voice: 3, rate: 9, pitch: 'a' } }), {
    de: { voice: 'uri:Anna', rate: 1.2, pitch: 0.9 },
    en: { voice: '', rate: 1, pitch: 1 },
  });
  assert.deepEqual(prefOf(undefined, 'de'), { voice: '', rate: 1, pitch: 1 });
  assert.equal(prefOf({ de: { voice: 'a', rate: 1.4, pitch: 1 } }, 'de').rate, 1.4);
});
