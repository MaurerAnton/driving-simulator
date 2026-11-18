// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Which of the browser's voices reads a language – the choice, without the
 * browser (audio/speech.ts does the speaking).
 *
 * Browsers offer very different voices: Chrome on the desktop "Google
 * Deutsch" (over the network, good), Edge "Microsoft Katja Online (Natural)",
 * Safari "Anna" and "Anna (Enhanced)" next to toy voices ("Bubbles",
 * "Zarvox"), Firefox on Linux eSpeak, Android the system's engine.  A voice
 * counts for a language when its language tag says so; the locale of the
 * texts (de-DE, pt-PT, zh-CN) comes first, other regions of the same
 * language after it; Cantonese never reads Mandarin, and no voice of an
 * unrelated language is ever taken – the texts are then shown only.  Among
 * the voices of a language the natural/neural/online/enhanced ones win.
 *
 * Also the player's choices per language (voice, rate, pitch) as the
 * settings keep them, and their check when they are loaded.
 *
 * tests/audio/voicepick.test.ts
 */

/** What is used of a SpeechSynthesisVoice (and what the tests make up). */
export interface VoiceLike {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
  default: boolean;
}

/** How well a voice fits a language. */
export type VoiceFit = 'locale' | 'language' | 'related';

/** A language as a browser writes it, made comparable: "de_DE" → de-de; Android's old "in" → id. */
interface Tag {
  lang: string;
  region: string;
  script: string;
}

const ALIASES: Record<string, string> = { in: 'id', iw: 'he', cmn: 'zh', fil: 'tl', nb: 'no' };

export function parseTag(tag: string): Tag {
  const parts = tag.trim().replace(/_/g, '-').toLowerCase().split('-');
  const lang = ALIASES[parts[0]] ?? parts[0];
  let region = '';
  let script = '';
  for (const p of parts.slice(1)) {
    if (/^[a-z]{4}$/.test(p)) script = p;
    else if (/^([a-z]{2}|\d{3})$/.test(p) && !region) region = p;
  }
  // (Mandarin written in traditional characters is Taiwan's)
  if (lang === 'zh' && !region && script === 'hant') region = 'tw';
  return { lang, region, script };
}

/**
 * Languages close enough that a voice of one reads the other's texts well:
 * only where no voice of the language itself is there (status "related").
 */
const RELATED: Record<string, readonly string[]> = {
  hr: ['bs', 'sr'],
  id: ['ms'],
};

/** Is this Chinese voice a Cantonese one (Hong Kong, "yue")? It cannot read Mandarin texts. */
const cantonese = (v: VoiceLike, t: Tag): boolean => t.lang === 'yue' || (t.lang === 'zh' && (t.region === 'hk' || t.region === 'mo')) || /cantonese|粤語|粵語|廣東/i.test(v.name);

/** How a voice fits the locale of the texts (de-DE, pt-PT, ar), or null when it does not read that language. */
export function voiceFit(v: VoiceLike, locale: string): VoiceFit | null {
  const want = parseTag(locale);
  const has = parseTag(v.lang);
  if (want.lang === 'zh' && cantonese(v, has)) return null;
  if (has.lang === want.lang) return !want.region || has.region === want.region ? 'locale' : 'language';
  if (RELATED[want.lang]?.includes(has.lang)) return 'related';
  return null;
}

/** Apple's toy voices: fun, but not an instructor. */
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|pipe organ|superstar|trinoids|whisper|wobble|zarvox)\b/i;
/** Apple's old Eloquence voices (Eddy, Flo, Grandma …): understandable, but robotic. */
const ELOQUENCE = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;

/** Points of a voice for a locale: higher is better; -Infinity when it does not read that language. */
export function voiceScore(v: VoiceLike, locale: string): number {
  const fit = voiceFit(v, locale);
  if (!fit) return -Infinity;
  const want = parseTag(locale);
  const has = parseTag(v.lang);
  // (another region – pt-BR for pt-PT, Mandarin of Taiwan for zh-CN – reads well, with another accent: behind the locale's)
  let s = fit === 'locale' ? (has.region || !want.region ? 100 : 85) : fit === 'language' ? 50 : 20;
  const n = v.name;
  if (/natural|neural|premium|enhanced|wavenet|studio|journey|polyglot/i.test(n)) s += 40;
  else if (/\bonline\b/i.test(n)) s += 30;
  if (/^google\b/i.test(n)) s += 25;
  if (/network/i.test(n) || /-network$/i.test(v.voiceURI)) s += 10;
  if (/espeak|pico|festival|mbrola|^default$/i.test(n)) s -= 15;
  if (ELOQUENCE.test(n)) s -= 10;
  if (NOVELTY.test(n)) s -= 80;
  if (v.default) s += 5;
  return s;
}

/** The voices that read a language, the best first. */
export function rankVoices<V extends VoiceLike>(voices: readonly V[], locale: string): V[] {
  return voices
    .map((v, i) => ({ v, i, s: voiceScore(v, locale) }))
    .filter((x) => x.s > -Infinity)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.v);
}

/**
 * What can be said about the voices of a language:
 * good – there is one of the language; related – only one of a closely related language;
 * none – the browser lists voices, none of them for the language (the texts are shown only);
 * unknown – the browser lists no voices at all (it may still speak: its system decides).
 */
export type VoiceStatus = 'good' | 'related' | 'none' | 'unknown';

export function voiceStatus(voices: readonly VoiceLike[], locale: string): VoiceStatus {
  if (!voices.length) return 'unknown';
  const best = rankVoices(voices, locale)[0];
  if (!best) return 'none';
  return voiceFit(best, locale) === 'related' ? 'related' : 'good';
}

/**
 * The voice to read with: the one the player chose (by its URI, or its name –
 * the URI differs between browsers), if it is there and still reads the
 * language and has not failed; the best one otherwise; null when none fits.
 */
export function chooseVoice<V extends VoiceLike>(voices: readonly V[], locale: string, chosen = '', failed: ReadonlySet<string> = new Set()): V | null {
  const ranked = rankVoices(voices, locale).filter((v) => !failed.has(v.voiceURI));
  if (chosen) {
    const mine = ranked.find((v) => v.voiceURI === chosen) ?? ranked.find((v) => v.name === chosen);
    if (mine) return mine;
  }
  return ranked[0] ?? null;
}

// ------------------------------------------------------------------ the player's choices

/** What the player set for the voice of one language. */
export interface SpeechPref {
  /** the voice's URI; '' = automatic */
  voice: string;
  /** 0.6 … 1.6 (1 = the voice's own) */
  rate: number;
  /** 0.6 … 1.4 */
  pitch: number;
}

export const RATE_RANGE = [0.6, 1.6] as const;
export const PITCH_RANGE = [0.6, 1.4] as const;
export const DEFAULT_PREF: Readonly<SpeechPref> = { voice: '', rate: 1, pitch: 1 };

/** The choices of a language (the defaults where none). */
export function prefOf(all: Record<string, SpeechPref> | undefined, lang: string): SpeechPref {
  return { ...DEFAULT_PREF, ...(all?.[lang] ?? {}) };
}

/** The choices as they were stored, checked: whatever is broken goes. */
export function cleanSpeechPrefs(raw: unknown): Record<string, SpeechPref> {
  const out: Record<string, SpeechPref> = {};
  if (!raw || typeof raw !== 'object') return out;
  const within = (x: unknown, [lo, hi]: readonly [number, number], d: number): number => (typeof x === 'number' && x >= lo && x <= hi ? x : d);
  for (const [lang, p] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z]{2,3}$/.test(lang) || !p || typeof p !== 'object') continue;
    const q = p as Partial<Record<keyof SpeechPref, unknown>>;
    out[lang] = {
      voice: typeof q.voice === 'string' ? q.voice.slice(0, 300) : '',
      rate: within(q.rate, RATE_RANGE, 1),
      pitch: within(q.pitch, PITCH_RANGE, 1),
    };
  }
  return out;
}
