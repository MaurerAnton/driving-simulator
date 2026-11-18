// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The arcade panel: the world at another moment, and time that runs faster.
 *
 * The world follows the real clock – the trams and buses by their
 * timetables, the sun where it stands now.  Here the player sets another
 * day and hour to see a place as it will be then, and lets the time run
 * faster – while the autopilot drives or while driving oneself (the
 * timetables are not kept while it does; back at the real speed the world
 * is at the real time again).  "Now" puts everything back.  The game's
 * clock itself is game/clock.ts.
 *
 * And the simulator's chores can be left out here: arcade driving (D and R
 * by the pedals, no handbrake, no stalling – game/arcadedrive.ts) and the
 * road physics (every surface, in any weather, as dry asphalt).
 */

import { RATES } from '../game/clock.ts';
import { closeX } from './closex.ts';

export interface ArcadeHost {
  /** a text of the game's language */
  t(key: string, vars?: Record<string, string | number>): string;
  /** the language's locale (for the date) */
  locale(): string;
  /** the moment of the world, and whether it is the real one / one the player chose */
  clockMs(): number;
  real(): boolean;
  travelled(): boolean;
  /** how many times faster than real the time runs */
  rate(): number;
  /** set the world to a moment – null: back to the real time and speed */
  setTime(ms: number | null): void;
  setRate(rate: number): void;
  /** does the autopilot drive now? */
  autopilot(): boolean;
  /** the seasons and weathers one may choose ([value, name]), the ones chosen, and choosing one */
  seasons(): ReadonlyArray<readonly [string, string]>;
  season(): string;
  setSeason(v: string): void;
  weathers(): ReadonlyArray<readonly [string, string]>;
  weather(): string;
  setWeather(v: string): void;
  /** arcade driving and the road physics switched off (settings arcadeDrive, evenRoads) */
  arcadeDrive(): boolean;
  setArcadeDrive(v: boolean): void;
  evenRoads(): boolean;
  setEvenRoads(v: boolean): void;
  /** close the panel (back to the drive) */
  close(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** A datetime-local value of a moment (in the browser's time zone). */
export function localInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The moment of a datetime-local value (NaN if it is none). */
export function fromLocalInput(v: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}

/**
 * The moment of a quick choice: today (or tomorrow) at an hour – the next
 * such hour from `fromMs` when `next` (so "evening" in the evening is
 * tomorrow's when today's has passed).
 */
export function atHour(fromMs: number, hour: number, dayOffset = 0): number {
  const d = new Date(fromMs);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** The short form of the world's moment for the HUD: weekday, hour and minute (and the rate when faster). */
export function clockBadge(ms: number, rate: number, locale: string): string {
  const d = new Date(ms);
  let s: string;
  try {
    s = d.toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    s = d.toISOString().slice(0, 16).replace('T', ' ');
  }
  return rate > 1 ? `${s} · ${rate}×` : s;
}

/** The panel's content (the HUD puts it in an overlay). */
export function arcadePanel(host: ArcadeHost): HTMLElement {
  const p = el('div', 'panel narrow arcade');
  const head = el('h1', '', host.t('arcadeTitle'));
  p.append(closeX(host.t('resume'), () => host.close()), head, el('p', 'note', host.t('arcadeHint')));

  // --- the simulator's chores left out ---
  const easy = el('div', 'arc-block');
  easy.append(el('b', '', host.t('arcadeEasy')));
  const toggle = (label: string, on: () => boolean, set: (v: boolean) => void): void => {
    const row = el('label', 'row arc-toggle');
    const c = el('input');
    c.type = 'checkbox';
    c.checked = on();
    c.onchange = () => set(c.checked);
    row.append(c, el('span', '', label));
    easy.append(row);
  };
  toggle(host.t('arcadeDrive'), () => host.arcadeDrive(), (v) => host.setArcadeDrive(v));
  easy.append(el('small', '', host.t('arcadeDriveNote')));
  toggle(host.t('evenRoads'), () => host.evenRoads(), (v) => host.setEvenRoads(v));
  p.append(easy);

  // --- the moment ---
  const when = el('div', 'arc-block');
  when.append(el('b', '', host.t('arcadeTime')));
  const now = el('small', 'arc-now', clockBadge(host.clockMs(), 1, host.locale()));
  const input = el('input');
  input.type = 'datetime-local';
  input.value = localInput(host.clockMs());
  input.setAttribute('aria-label', host.t('arcadeTime'));
  const refresh = (): void => {
    now.textContent = host.real() ? `${clockBadge(host.clockMs(), 1, host.locale())} · ${host.t('arcadeReal')}` : clockBadge(host.clockMs(), host.rate(), host.locale());
    input.value = localInput(host.clockMs());
    for (const b of rateButtons) b.classList.toggle('on', Number(b.dataset.rate) === host.rate());
    back.disabled = host.real() && host.rate() === 1;
  };
  input.onchange = () => {
    const ms = fromLocalInput(input.value);
    if (Number.isFinite(ms)) host.setTime(ms);
    refresh();
  };
  const chips = el('div', 'arc-chips');
  const chip = (label: string, ms: () => number): void => {
    const b = el('button', 'btn ghost chip', label);
    b.type = 'button';
    b.onclick = () => {
      host.setTime(ms());
      refresh();
    };
    chips.append(b);
  };
  const base = (): number => host.clockMs();
  chip(host.t('arcadeMorning'), () => atHour(base(), 8));
  chip(host.t('arcadeNoon'), () => atHour(base(), 12));
  chip(host.t('arcadeEvening'), () => atHour(base(), 18));
  chip(host.t('arcadeNight'), () => atHour(base(), 23));
  chip(host.t('arcadeTomorrow'), () => base() + 24 * 3600 * 1000);
  const back = el('button', 'btn', host.t('arcadeNow'));
  back.type = 'button';
  back.onclick = () => {
    host.setTime(null);
    refresh();
  };
  when.append(now, input, chips, back);
  p.append(when);

  // --- the speed of time (the autopilot driving, or the player) ---
  const speed = el('div', 'arc-block');
  speed.append(el('b', '', host.t('arcadeSpeed')), el('small', '', host.t('arcadeSpeedAny')));
  const rates = el('div', 'arc-chips');
  const rateButtons: HTMLButtonElement[] = [];
  for (const r of RATES) {
    const b = el('button', 'btn ghost chip', `${r}×`);
    b.type = 'button';
    b.dataset.rate = String(r);
    b.onclick = () => {
      host.setRate(r);
      refresh();
    };
    rateButtons.push(b);
    rates.append(b);
  }
  speed.append(rates);
  p.append(speed);

  // --- the season and the weather (also in the settings) ---
  const choice = (title: string, list: ReadonlyArray<readonly [string, string]>, now: () => string, set: (v: string) => void): void => {
    const block = el('div', 'arc-block');
    block.append(el('b', '', title));
    const row = el('div', 'arc-chips');
    const buttons: HTMLButtonElement[] = [];
    for (const [v, name] of list) {
      const b = el('button', 'btn ghost chip', name);
      b.type = 'button';
      b.classList.toggle('on', now() === v);
      b.onclick = () => {
        set(v);
        for (const o of buttons) o.classList.toggle('on', o === b);
      };
      buttons.push(b);
      row.append(b);
    }
    block.append(row);
    p.append(block);
  };
  choice(host.t('season'), host.seasons(), () => host.season(), (v) => host.setSeason(v));
  choice(host.t('weather'), host.weathers(), () => host.weather(), (v) => host.setWeather(v));

  const close = el('div', 'buttons');
  const ok = el('button', 'btn', host.t('resume'));
  ok.type = 'button';
  ok.onclick = () => host.close();
  close.append(ok);
  p.append(close);
  refresh();
  return p;
}
