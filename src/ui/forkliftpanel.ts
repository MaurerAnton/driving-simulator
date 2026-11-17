// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The forklift's display and the mast's buttons (plain DOM, like the HUD):
 *
 *  - the display, small in the top corner: the load moment against the
 *    point where the rear wheels lift (amber from 80 %, red from 100 %),
 *    the side stability the same way, the load on the forks against what
 *    the load chart allows at its load centre, the forks' height and the
 *    mast's tilt;
 *  - on a touch screen, buttons for the mast where the indicators usually
 *    are (a forklift has no use for them on the yard): forks up and down,
 *    the mast tilted back and forwards, the side-shift left and right –
 *    held down, they work like the keys (they press the same keys of
 *    input/input.ts);
 *  - with keys, a line at the bottom saying which keys work the mast.
 */
import { tr } from '../i18n/index.ts';
import type { Lang } from '../i18n/index.ts';
import './forklift.css';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** The mast's keys (by position: KeyboardEvent.code) – read by Input.forkInput. */
export const FORK_KEYS = { up: 'PageUp', down: 'PageDown', back: 'Home', forward: 'End', left: 'Insert', right: 'Delete' };

/** What the display shows. */
export interface ForkInfo {
  /** the load moment and the side stability (1: the wheels lift) */
  moment: number;
  side: number;
  /** the load on the forks (kg; 0: none), what the load chart allows at its load centre */
  load: number;
  allowed: number;
  /** the forks' height (m), the mast's tilt (deg, + back) */
  lift: number;
  tilt: number;
}

export class ForkPanel {
  readonly root = el('div', 'fork-ui');
  private readonly lang: () => Lang;
  private readonly bar = el('i');
  private readonly barText = el('b');
  private readonly sideBar = el('i');
  private readonly vals = el('div', 'fork-vals');
  private readonly keys = el('div', 'fork-keys');
  private readonly box = el('div', 'fork-box');
  private keysLang = '';
  private last = '';

  constructor(parent: HTMLElement, lang: () => Lang, press: (code: string, down: boolean) => void, click: () => void) {
    this.lang = lang;
    const L = lang();
    const meter = (bar: HTMLElement, text: HTMLElement | null, label: string): HTMLElement => {
      const m = el('div', 'fork-meter');
      m.append(el('span', '', label));
      const b = el('div', 'fork-bar');
      b.append(bar, el('u'));
      if (text) b.append(text);
      m.append(b);
      return m;
    };
    this.box.append(meter(this.bar, this.barText, tr('forkPanel.moment', L)), meter(this.sideBar, null, tr('forkPanel.side', L)), this.vals);
    // the mast's buttons: held down, they hold their key down
    const btns = el('div', 'fork-btns');
    const btn = (code: string, label: string, title: string): void => {
      const b = el('button', 'fork-btn', label);
      b.title = tr(title, L);
      b.setAttribute('aria-label', b.title);
      const up = (e: PointerEvent): void => {
        e.preventDefault();
        b.classList.remove('on');
        press(code, false);
      };
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try {
          b.setPointerCapture(e.pointerId);
        } catch {
          /* gone already */
        }
        b.classList.add('on');
        click();
        press(code, true);
      });
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      btns.append(b);
    };
    btn(FORK_KEYS.up, '▲', 'forkPanel.up');
    btn(FORK_KEYS.back, '↶', 'forkPanel.back');
    btn(FORK_KEYS.left, '◀', 'forkPanel.left');
    btn(FORK_KEYS.down, '▼', 'forkPanel.down');
    btn(FORK_KEYS.forward, '↷', 'forkPanel.forward');
    btn(FORK_KEYS.right, '▶', 'forkPanel.right');
    this.root.append(this.box, btns, this.keys);
    this.root.hidden = true;
    parent.append(this.root);
  }

  /** Touch screen or keys: the buttons, or the line of keys. */
  setMode(touch: boolean): void {
    this.root.classList.toggle('touch', touch);
    const L = this.lang();
    if (!touch && this.keysLang !== L) {
      this.keysLang = L;
      this.keys.replaceChildren(...['forkKeys.lift', 'forkKeys.tilt', 'forkKeys.shift'].map((k) => el('span', '', tr(k, L))));
    }
  }

  update(i: ForkInfo): void {
    const L = this.lang();
    const pct = Math.round(i.moment * 100);
    this.bar.style.width = `${Math.min(100, pct)}%`;
    this.sideBar.style.width = `${Math.min(100, Math.round(i.side * 100))}%`;
    this.box.classList.toggle('warn', i.moment >= 0.8 || i.side >= 0.8);
    this.box.classList.toggle('stop', i.moment >= 1 || i.side >= 1);
    this.barText.textContent = `${pct} %`;
    const text = [
      i.load > 0 ? tr('forkPanel.load', L, { kg: Math.round(i.load), max: Math.round(i.allowed / 10) * 10 }) : tr('forkPanel.empty', L),
      tr('forkPanel.lift', L, { m: i.lift.toFixed(2), deg: (Math.round(i.tilt * 10) / 10).toFixed(1) }),
    ];
    const key = text.join('|') + (i.load > i.allowed ? '!' : '');
    if (key === this.last) return;
    this.last = key;
    this.vals.replaceChildren(...text.map((t, n) => el('span', n === 0 && i.load > i.allowed ? 'bad' : '', t)));
  }

  dispose(): void {
    this.root.remove();
  }
}
