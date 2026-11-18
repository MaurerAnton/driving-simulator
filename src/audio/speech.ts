// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The spoken instructions: the browser's speech synthesis, used with care.
 *
 * - The voice: the player's choice for the language, else the best one the
 *   browser has (audio/voicepick.ts) – never a voice of another language:
 *   where there is none the text is only shown (Chrome would otherwise read
 *   Albanian or Bengali with an English voice).
 * - The voices arrive late (Chrome: after "voiceschanged", Safari sometimes
 *   without telling): they are looked for again on that event and for a few
 *   seconds after the start; a text that comes before waits for them briefly.
 * - The text is made speakable (i18n/speechtext.ts) and cut into sentences:
 *   Chrome stops a voice after about 15 seconds, and a short utterance is
 *   cancelled cleanly when the next instruction comes.
 * - A new instruction replaces the one being read (or queues behind it).
 * - A voice over the network that fails (offline) is left for the session,
 *   and the piece is read again with the next best voice.
 * - Chrome forgets an utterance that nothing holds (and never ends it): the
 *   current one is held, and a watchdog moves on if no end comes.
 */
import { speakable, splitForSpeech } from '../i18n/speechtext.ts';
import { localeOf } from '../i18n/index.ts';
import { chooseVoice, prefOf, rankVoices, voiceStatus } from './voicepick.ts';
import type { SpeechPref, VoiceStatus } from './voicepick.ts';

/** What the speaking needs of the settings. */
export interface SpeechSettings {
  /** the spoken instructions are on */
  voice: boolean;
  volume: number;
  /** per language: voice, rate, pitch */
  speech?: Record<string, SpeechPref>;
}

interface Piece {
  text: string;
  lang: string;
  pref: SpeechPref;
  volume: number;
}

/** how long to wait for the voices before speaking with the language alone (ms) */
const VOICE_WAIT = 2500;

class Speech {
  private synth: SpeechSynthesis | null = null;
  private voices: SpeechSynthesisVoice[] = [];
  private started = 0;
  private readonly listeners = new Set<() => void>();
  private queue: Piece[] = [];
  /** the utterance being read (held: Chrome drops what nobody holds) */
  private current: SpeechSynthesisUtterance | null = null;
  private watchdog = 0;
  private pending = 0;
  /** voices that failed this session (a network voice while offline) */
  private readonly failed = new Set<string>();

  /** Look for the voices (once; harmless where the browser cannot speak). */
  init(): void {
    if (this.started || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    this.synth = window.speechSynthesis;
    this.started = performance.now();
    const load = (): void => {
      const list = this.synth?.getVoices() ?? [];
      if (list.length === this.voices.length && list.every((v, i) => v === this.voices[i])) return;
      this.voices = list;
      for (const f of this.listeners) f();
    };
    load();
    this.synth.addEventListener?.('voiceschanged', load);
    // (Safari and some Androids fill the list without the event)
    let tries = 0;
    const poll = window.setInterval(() => {
      load();
      if (++tries >= 12 || this.voices.length) window.clearInterval(poll);
    }, 250);
  }

  get supported(): boolean {
    this.init();
    return !!this.synth;
  }

  /** Call when the list of voices changes; gives back a function that stops that. */
  onVoices(f: () => void): () => void {
    this.init();
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** The voices that read a language, the best first. */
  voicesFor(lang: string): SpeechSynthesisVoice[] {
    this.init();
    return rankVoices(this.voices, localeOf(lang));
  }

  status(lang: string): VoiceStatus {
    this.init();
    return voiceStatus(this.voices, localeOf(lang));
  }

  /** The voice that would read a language now (null: none – or the browser lists none). */
  voiceFor(lang: string, pref: SpeechPref): SpeechSynthesisVoice | null {
    this.init();
    return chooseVoice(this.voices, localeOf(lang), pref.voice, this.failed);
  }

  /**
   * Read a text out – when the spoken instructions are on.  `queue`: after
   * what is being read; otherwise instead of it.  false when nothing is read
   * (switched off, no speech, no voice for the language).
   */
  say(text: string, lang: string, s: SpeechSettings, queue = false): boolean {
    if (!s.voice) return false;
    return this.speak(text, lang, s, queue);
  }

  /** Read a text whatever the switch says (the test in the settings). */
  test(text: string, lang: string, s: SpeechSettings): boolean {
    return this.speak(text, lang, s, false);
  }

  /** Stop reading, and forget what was waiting. */
  stop(): void {
    this.queue = [];
    this.reset();
  }

  private speak(text: string, lang: string, s: SpeechSettings, queue: boolean): boolean {
    if (!this.supported || !text.trim()) return false;
    if (this.voices.length && this.status(lang) === 'none') return false;
    const pref = prefOf(s.speech, lang);
    const pieces = splitForSpeech(speakable(text, lang)).map((t): Piece => ({ text: t, lang, pref, volume: s.volume }));
    if (!pieces.length) return false;
    if (!queue) this.stop();
    this.queue.push(...pieces);
    if (!this.current && !this.pending) this.next(queue ? 0 : 60);
    return true;
  }

  private reset(): void {
    window.clearTimeout(this.watchdog);
    window.clearTimeout(this.pending);
    this.pending = 0;
    const was = this.current;
    this.current = null;
    if (was || this.synth?.speaking || this.synth?.pending) this.synth?.cancel();
  }

  /** The next piece – after a short pause (Chrome drops a speak() right after cancel()). */
  private next(delay: number): void {
    window.clearTimeout(this.pending);
    this.pending = window.setTimeout(() => {
      this.pending = 0;
      this.play();
    }, delay);
  }

  private play(): void {
    const synth = this.synth;
    const p = this.queue[0];
    if (!synth || !p || this.current) return;
    // (the voices not there yet: wait a little for them)
    if (!this.voices.length && performance.now() - this.started < VOICE_WAIT) {
      this.next(200);
      return;
    }
    const voice = this.voiceFor(p.lang, p.pref);
    if (this.voices.length && !voice) {
      this.queue = [];
      return;
    }
    this.queue.shift();
    const u = new SpeechSynthesisUtterance(p.text);
    u.lang = voice?.lang || localeOf(p.lang);
    if (voice) u.voice = voice;
    u.rate = p.pref.rate;
    u.pitch = p.pref.pitch;
    u.volume = p.volume;
    const done = (): void => {
      if (this.current !== u) return;
      window.clearTimeout(this.watchdog);
      this.current = null;
      if (this.queue.length) this.next(0);
    };
    u.onend = done;
    u.onerror = (e) => {
      if (this.current !== u) return;
      // (a voice over the network without a network: the next best voice reads the piece again)
      if (voice && !voice.localService && e.error !== 'interrupted' && e.error !== 'canceled' && !this.failed.has(voice.voiceURI)) {
        this.failed.add(voice.voiceURI);
        this.queue.unshift(p);
      }
      done();
    };
    this.current = u;
    // (if no end ever comes: on after the longest the piece can take)
    window.clearTimeout(this.watchdog);
    this.watchdog = window.setTimeout(() => {
      if (this.current !== u) return;
      this.current = null;
      synth.cancel();
      if (this.queue.length) this.next(60);
    }, 4000 + (p.text.length * 250) / Math.max(0.5, p.pref.rate));
    // (Safari and Chrome can be left paused – after a call, a locked screen)
    if (synth.paused) synth.resume();
    synth.speak(u);
  }
}

/** The one speaker of the game. */
export const speech = new Speech();
