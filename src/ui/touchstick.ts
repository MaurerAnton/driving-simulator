// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A stick on the screen for the left thumb – walking the classic way (and
 * tap to walk: game/walkmodes.ts), and flying the free camera
 * (game/flycam.ts).  It stands in for W A S D: pushed up it goes forwards,
 * to the side it steps or flies sideways, and springs back to the middle
 * when let go.  Beside it: the runner's button (running on or off) when
 * walking, the buttons for up and down when flying.
 *
 * While it is shown, the pedals, the steering bar and the buttons of the
 * gears, the indicators and the parking brake – of no use on foot or to a
 * camera – are hidden (the class `stickmode` on the game's #ui element); the
 * right half of the picture is left to look round with a finger (as
 * before: input/input.ts).
 *
 * Also here: a small badge that says something for a moment (the flying
 * camera's speed, when the wheel or a pinch changes it).
 */
import type { Input } from '../input/input.ts';

/** what the stick is for now: walking, flying – or nothing (hidden) */
export type StickUse = 'walk' | 'fly' | null;

const STYLE = `
#ui.stickmode .touch .steer, #ui.stickmode .touch .pedal, #ui.stickmode .touch .ind-l, #ui.stickmode .touch .ind-r,
#ui.stickmode .touch .gear-up, #ui.stickmode .touch .gear-dn, #ui.stickmode .touch .hb, #ui.stickmode .touch .ap { display: none !important; }
.tstick { position: absolute; z-index: 6; left: calc(max(12px, env(safe-area-inset-left)) + 68px); bottom: max(4vh, env(safe-area-inset-bottom)); width: min(36vw, 30vh, 150px); aspect-ratio: 1; border-radius: 50%;
  background: rgba(20, 28, 38, 0.45); border: 2px solid rgba(255, 255, 255, 0.5); pointer-events: auto; touch-action: none; opacity: var(--touch-opacity, 0.8); }
.tstick > i { position: absolute; left: 50%; top: 50%; width: 42%; height: 42%; margin: -21% 0 0 -21%; border-radius: 50%; background: rgba(255, 204, 0, 0.92); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4); pointer-events: none; }
.tstick-btn { position: absolute; z-index: 6; width: 52px; height: 52px; border-radius: 50%; padding: 0; background: rgba(20, 28, 38, 0.75); border: 1px solid rgba(255, 255, 255, 0.5);
  color: #fff; font-size: 20px; font-weight: 700; pointer-events: auto; touch-action: none; display: flex; align-items: center; justify-content: center; }
.tstick-btn.on { background: var(--accent, #ffcc00); color: #111; }
/* (a display rule above beats the hidden attribute: hidden buttons and the hidden stick must really go) */
.tstick-btn[hidden], .tstick[hidden] { display: none !important; }
.tstick-badge { position: absolute; z-index: 7; left: 50%; top: calc(max(10px, env(safe-area-inset-top)) + 76px); transform: translateX(-50%); padding: 6px 14px; border-radius: 16px;
  background: rgba(10, 16, 24, 0.82); color: #fff; font-weight: 700; font-size: 15px; pointer-events: none; transition: opacity 0.3s; }
`;

let styled = false;

export class TouchStick {
  private readonly root: HTMLElement;
  private readonly input: Input;
  private readonly pad: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly run: HTMLButtonElement;
  private readonly up: HTMLButtonElement;
  private readonly down: HTMLButtonElement;
  private readonly badgeEl: HTMLElement;
  private badgeUntil = 0;
  private use: StickUse = null;
  private finger = -1;

  /** `root`: the game's #ui element; `t`: the texts */
  constructor(root: HTMLElement, input: Input, t: (key: string) => string) {
    this.root = root;
    this.input = input;
    if (!styled) {
      styled = true;
      const st = document.createElement('style');
      st.textContent = STYLE;
      document.head.append(st);
    }
    const pad = (this.pad = document.createElement('div'));
    pad.className = 'tstick';
    pad.hidden = true;
    this.knob = document.createElement('i');
    pad.append(this.knob);
    const move = (e: PointerEvent): void => {
      const r = pad.getBoundingClientRect();
      const rad = r.width / 2;
      const x = (e.clientX - (r.left + rad)) / rad;
      const y = -(e.clientY - (r.top + rad)) / rad;
      const l = Math.hypot(x, y);
      const m = Math.min(l, 1);
      const ux = l > 1e-6 ? x / l : 0;
      const uy = l > 1e-6 ? y / l : 0;
      // (a little play in the middle, then all the way out a little before the edge)
      const k = m < 0.12 ? 0 : Math.min(1, (m - 0.12) / 0.78);
      input.stick.x = ux * k;
      input.stick.y = uy * k;
      input.touched();
      this.knob.style.transform = `translate(${ux * m * rad * 0.62}px, ${-uy * m * rad * 0.62}px)`;
    };
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== this.finger) return;
      this.finger = -1;
      this.centre();
    };
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.finger >= 0) return;
      this.finger = e.pointerId;
      try {
        pad.setPointerCapture(e.pointerId);
      } catch {
        /* gone already */
      }
      move(e);
    });
    pad.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.finger) move(e);
    });
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);
    const button = (label: string, title: string, left: string, bottom: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tstick-btn';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.style.left = left;
      b.style.bottom = bottom;
      b.hidden = true;
      return b;
    };
    // (to the right of the stick, where the pedals were)
    const beside = 'calc(max(12px, env(safe-area-inset-left)) + 68px + min(36vw, 30vh, 150px) + 14px)';
    const low = 'max(4vh, env(safe-area-inset-bottom))';
    const high = 'calc(max(4vh, env(safe-area-inset-bottom)) + 62px)';
    this.run = button('🏃', t('walk.run'), beside, low);
    this.run.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      input.runToggle = !input.runToggle;
      input.touched();
    });
    this.up = button('▲', t('fly.up'), beside, high);
    this.down = button('▼', t('fly.down'), beside, low);
    const hold = (b: HTMLButtonElement, code: string): void => {
      let held = false;
      const up = (): void => {
        if (held) input.press(code, false);
        held = false;
      };
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          b.setPointerCapture(e.pointerId);
        } catch {
          /* gone already */
        }
        held = true;
        input.press(code, true);
      });
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    };
    hold(this.up, 'FlyUp');
    hold(this.down, 'FlyDown');
    const badge = (this.badgeEl = document.createElement('div'));
    badge.className = 'tstick-badge';
    badge.style.opacity = '0';
    root.append(pad, this.run, this.up, this.down, badge);
  }

  private centre(): void {
    this.input.stick.x = 0;
    this.input.stick.y = 0;
    this.knob.style.transform = '';
  }

  /** Every picture: what the stick is for now (null: hidden – on keys, or driving). */
  frame(use: StickUse): void {
    if (use !== this.use) {
      this.use = use;
      this.pad.hidden = use === null;
      this.root.classList.toggle('stickmode', use !== null);
      this.up.hidden = this.down.hidden = use !== 'fly';
      this.run.hidden = use !== 'walk';
      if (use === null) {
        this.finger = -1;
        this.centre();
      }
    }
    if (use === 'walk') this.run.classList.toggle('on', this.input.runToggle);
    if (this.badgeUntil > 0 && performance.now() > this.badgeUntil) {
      this.badgeUntil = 0;
      this.badgeEl.style.opacity = '0';
    }
  }

  /** Say something for a moment (the flying camera's speed). */
  badge(text: string, ms = 1400): void {
    this.badgeEl.textContent = text;
    this.badgeEl.style.opacity = '1';
    this.badgeUntil = performance.now() + ms;
  }
}
