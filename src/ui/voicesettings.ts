// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The voice of the spoken instructions, in the settings: which of the
 * browser's voices reads the current language (automatic: the best one),
 * how fast and how high, a button to hear it – kept per language.  Below,
 * what the player should know: that this device has no voice for the
 * language (the instructions are then shown only, and where a voice can be
 * added), that only a related language's voice is there, that the voices
 * marked "online" send the text to the browser's speech service.
 *
 * The list follows the browser's voices as they arrive (audio/speech.ts).
 */
import { speech } from '../audio/speech.ts';
import { PITCH_RANGE, RATE_RANGE, prefOf } from '../audio/voicepick.ts';
import type { SpeechPref } from '../audio/voicepick.ts';
import { tr } from '../i18n/index.ts';

type T = (key: string, vars?: Record<string, string | number>) => string;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** What the settings panel hands over. */
export interface VoiceSettingsHost {
  voice: boolean;
  volume: number;
  speech?: Record<string, SpeechPref>;
}

/**
 * The rows of the voice settings for a language.  `changed`: store the
 * settings (called after every change).
 */
export function voiceSettings(s: VoiceSettingsHost, lang: string, t: T, changed: () => void): HTMLElement {
  const box = el('div', 'voice-settings');
  if (!speech.supported) {
    box.append(el('p', 'note', t('voice.unsupported')));
    return box;
  }
  const pref = (): SpeechPref => prefOf(s.speech, lang);
  const set = (p: Partial<SpeechPref>): void => {
    s.speech = { ...(s.speech ?? {}), [lang]: { ...pref(), ...p } };
    changed();
  };

  // the voice
  const row = el('div', 'row');
  const sel = el('select');
  sel.onchange = () => {
    set({ voice: sel.value });
    status();
  };
  row.append(el('label', '', t('voice.choice')), sel);

  // rate and pitch: their own ranges, 1 in the middle of the track
  const slider = (label: string, [lo, hi]: readonly [number, number], value: number, put: (v: number) => void): HTMLElement => {
    const r = el('div', 'row');
    const input = el('input');
    input.type = 'range';
    input.min = String(lo);
    input.max = String(hi);
    input.step = '0.05';
    input.value = String(value);
    input.onchange = () => put(Math.round(Number(input.value) * 100) / 100);
    r.append(el('label', '', label), input);
    return r;
  };
  const rate = slider(t('voice.rate'), RATE_RANGE, pref().rate, (v) => set({ rate: v }));
  const pitch = slider(t('voice.pitch'), PITCH_RANGE, pref().pitch, (v) => set({ pitch: v }));

  const buttons = el('div', 'buttons');
  const test = el('button', 'btn ghost chip', t('voice.test'));
  // (a sentence the game really says – with a distance, so the units are heard too)
  test.onclick = () => speech.test(tr('navIn', lang, { d: 200, what: tr('navRight', lang) }), lang, s);
  const reset = el('button', 'btn ghost chip', t('voice.reset'));
  reset.onclick = () => {
    const all = { ...(s.speech ?? {}) };
    delete all[lang];
    s.speech = all;
    changed();
    (rate.querySelector('input') as HTMLInputElement).value = '1';
    (pitch.querySelector('input') as HTMLInputElement).value = '1';
    fill();
  };
  buttons.append(test, reset);

  const note = el('p', 'note');
  const online = el('p', 'note', t('voice.onlineNote'));
  box.append(row, rate, pitch, buttons, note, online);

  const status = (): void => {
    const st = speech.status(lang);
    const v = speech.voiceFor(lang, pref());
    note.className = st === 'none' ? 'note warn' : 'note';
    note.textContent = st === 'none' ? t('voice.none') : st === 'related' ? t('voice.related', { name: v ? `${v.name} (${v.lang})` : '' }) : st === 'unknown' ? t('voice.unknown') : '';
    note.hidden = !note.textContent;
    const has = st === 'good' || st === 'related' || st === 'unknown';
    row.hidden = st === 'none' || st === 'unknown';
    rate.hidden = pitch.hidden = buttons.hidden = !has;
  };
  const fill = (): void => {
    const list = speech.voicesFor(lang);
    sel.textContent = '';
    const best = list[0];
    const auto = el('option', '', best ? t('voice.auto', { name: best.name }) : t('voice.autoNone'));
    auto.value = '';
    sel.append(auto);
    for (const v of list) {
      const o = el('option', '', `${v.name} (${v.lang})${v.localService ? '' : ` · ${t('voice.online')}`}`);
      o.value = v.voiceURI;
      sel.append(o);
    }
    const chosen = pref().voice;
    sel.value = list.some((v) => v.voiceURI === chosen) ? chosen : '';
    online.hidden = !list.some((v) => !v.localService);
    status();
  };
  fill();
  // (the voices arrive late; once the panel is gone, it stops listening)
  const off = speech.onVoices(() => {
    if (!box.isConnected && box.dataset.shown) off();
    else fill();
  });
  requestAnimationFrame(() => (box.dataset.shown = '1'));
  return box;
}
