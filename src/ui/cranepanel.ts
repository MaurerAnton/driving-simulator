// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The crane's display and its controls (plain DOM, like the HUD):
 *
 *  - the load moment limiter's display: the load on the hook against what
 *    the load chart allows here, as a bar (amber from 90 %, red at 100 %,
 *    when the limiter cuts off), the radius, the boom's length and angle,
 *    the hook's height, the swing, the wind at the boom head against the
 *    crane's limit, the carrier's slope as a bubble level, the outrigger
 *    setting, and how far the crane is from tipping;
 *  - the controls, as on a crane's two master switches: the left one slews
 *    (sideways) and hoists (forwards and back) – on the loader crane it
 *    moves the inner boom –, the right one luffs the boom (runs the trolley
 *    of the tower crane, moves the loader crane's outer boom) and
 *    telescopes.  On a keyboard A D / W S and the arrow keys, Shift for
 *    creep speed; a gamepad's two sticks; on a touch screen two joysticks
 *    under the thumbs.  Buttons (and keys) for slinging and letting go of
 *    the load, the creep speed, the outriggers, the jacks, the levelling,
 *    and for changing between driving and working the crane.
 *
 * The game (game/craneplay.ts) reads the controls each step (`read`) and
 * gives the display what the crane measures (`update`).
 */
import { keyName, localeOf, tr } from '../i18n/index.ts';
import type { CraneType, Lmi } from '../sim/crane.ts';

/** The two master switches (−1 … 1; y + = pushed away), and what is held of the rest. */
export interface CraneControls {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  fine: boolean;
  beams: number;
  jacks: number;
  level: boolean;
}

/** What the display shows besides the limiter's readings. */
export interface CraneInfo {
  type: CraneType;
  /** the crane is being worked (else: driven) */
  operating: boolean;
  /** a load hangs on the hook / one is within reach of it */
  hooked: boolean;
  canAttach: boolean;
  /** the swing (m), the hook's height above what is under it (m) */
  swing: number;
  /** the outrigger beams out (least, 0 … 1), the pads down, the carrier off its wheels, its slope along its x and z (deg) */
  beams: number;
  padsDown: boolean;
  onOutriggers: boolean;
  slopeX: number;
  slopeZ: number;
  /** the boom is in its rest (folded, for the loader crane) */
  stowed: boolean;
  /** the crane may be driven now (folded, outriggers in), and stands still with its brake on */
  canDrive: boolean;
  canOperate: boolean;
  /** creep speed is on */
  fine: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** a key's state: held, and pressed since it was last asked */
const HELD = new Set<string>();

/** The keys of the crane (by position: KeyboardEvent.code). */
const KEYS = {
  slewL: 'KeyA',
  slewR: 'KeyD',
  up: 'KeyW',
  down: 'KeyS',
  boomUp: 'ArrowUp',
  boomDown: 'ArrowDown',
  teleIn: 'ArrowLeft',
  teleOut: 'ArrowRight',
  fine: 'ShiftLeft',
  attach: 'Space',
  beamsOut: 'Digit1',
  beamsIn: 'Digit2',
  jacksDown: 'Digit3',
  jacksUp: 'Digit4',
  level: 'Digit5',
};

/** A joystick on the screen: a ring with a knob that follows the thumb and springs back to the middle. */
class Stick {
  readonly el: HTMLElement;
  x = 0;
  y = 0;
  private readonly knob: HTMLElement;
  private id = -1;

  constructor(cls: string, labels: { up: HTMLElement; down: HTMLElement; left: HTMLElement; right: HTMLElement }) {
    this.el = el('div', `crane-stick ${cls}`);
    this.knob = el('i');
    const ring = el('b');
    labels.up.className = 'lbl up';
    labels.down.className = 'lbl down';
    labels.left.className = 'lbl left';
    labels.right.className = 'lbl right';
    this.el.append(ring, labels.up, labels.down, labels.left, labels.right, this.knob);
    const move = (e: PointerEvent): void => {
      const r = this.el.getBoundingClientRect();
      const half = r.width / 2;
      let dx = (e.clientX - (r.left + half)) / half;
      let dy = -(e.clientY - (r.top + r.height / 2)) / half;
      const l = Math.hypot(dx, dy);
      if (l > 1) {
        dx /= l;
        dy /= l;
      }
      this.x = dx;
      this.y = dy;
      this.knob.style.transform = `translate(${dx * 90}%, ${-dy * 90}%)`;
    };
    this.el.onpointerdown = (e) => {
      e.preventDefault();
      if (this.id >= 0) return;
      this.id = e.pointerId;
      this.el.setPointerCapture(e.pointerId);
      move(e);
    };
    this.el.onpointermove = (e) => {
      if (e.pointerId === this.id) move(e);
    };
    const up = (e: PointerEvent): void => {
      if (e.pointerId !== this.id) return;
      this.id = -1;
      this.x = 0;
      this.y = 0;
      this.knob.style.transform = '';
    };
    this.el.onpointerup = up;
    this.el.onpointercancel = up;
  }

  release(): void {
    this.id = -1;
    this.x = 0;
    this.y = 0;
    this.knob.style.transform = '';
  }
}

/** A button that is held (a dead man's button: it moves only while held). */
function holdButton(cls: string, label: string, hold: (on: boolean) => void): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  let held = false;
  const up = (): void => {
    if (!held) return;
    held = false;
    b.classList.remove('on');
    hold(false);
  };
  b.onpointerdown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      b.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is gone already */
    }
    held = true;
    b.classList.add('on');
    hold(true);
  };
  b.onpointerup = up;
  b.onpointercancel = up;
  return b;
}

/**
 * A button that is tapped.  It answers to the finger's (or the mouse's) own
 * pointer events – down on it, up on it – not to the click the browser makes
 * of them afterwards: on a phone that click may never come while the display
 * beside it is rewritten several times a second (Safari takes changing
 * content under the finger for a hover and swallows the tap).  The click
 * stays for the keyboard (Enter or Space on the focused button).
 */
function tapButton(cls: string, label: string, tap: () => void): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  let down = -1;
  b.onpointerdown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    down = e.pointerId;
    try {
      b.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is gone already */
    }
  };
  b.onpointerup = (e) => {
    if (e.pointerId !== down) return;
    down = -1;
    e.stopPropagation();
    // (let go on the button: tapped – drawn off it: not)
    const r = b.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) tap();
  };
  b.onpointercancel = () => {
    down = -1;
  };
  b.onclick = (e) => {
    e.stopPropagation();
    // (a click from the keyboard has no count of presses: the pointer's taps were answered above)
    if (e.detail === 0) tap();
  };
  return b;
}

/** Text written only when it changed (the panel is updated every frame: no work, no mutation, when nothing changed). */
function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

/** shaped for fine control: a little deflection moves a little */
const shape = (v: number, dead = 0.08): number => {
  const a = Math.abs(v);
  if (a < dead) return 0;
  return Math.sign(v) * Math.pow((a - dead) / (1 - dead), 1.6);
};

export class CranePanel {
  readonly root: HTMLElement;
  private readonly lang: () => string;
  private type: CraneType = 'tower';
  private readonly lmiBox: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly barText: HTMLElement;
  private readonly vals: HTMLElement;
  private readonly msg: HTMLElement;
  private readonly level: HTMLElement;
  private readonly bubble: HTMLElement;
  private readonly tipBar: HTMLElement;
  private readonly setup: HTMLElement;
  private readonly acts: HTMLElement;
  private readonly attachBtn: HTMLButtonElement;
  private readonly fineBtn: HTMLButtonElement;
  private readonly modeBtn: HTMLButtonElement;
  private readonly keysBox: HTMLElement;
  private readonly left: Stick;
  private readonly right: Stick;
  private readonly leftLabels: Record<'up' | 'down' | 'left' | 'right', HTMLElement>;
  private readonly rightLabels: Record<'up' | 'down' | 'left' | 'right', HTMLElement>;
  private readonly setupButtons: HTMLButtonElement[] = [];
  /** what the set-up buttons on the screen hold */
  private readonly touchHold = { beams: 0, jacks: 0, level: false };
  /** the creep speed switched on (button, gamepad); Shift holds it */
  private fineOn = false;
  /** the keys ramp up rather than jump (a master switch is moved, not flicked) */
  private readonly keyAxes = { lx: 0, ly: 0, rx: 0, ry: 0 };
  private padPrev: boolean[] = [];
  private mode: 'touch' | 'keys' = 'keys';
  private shownLang = '';
  private shownType = '';
  private lastDom = 0;
  private numFmt: Intl.NumberFormat | null = null;
  private numLang = '';
  /** the crane is being worked: the keys are the crane's */
  active = false;
  /** sling the load or let it go */
  onAttach: () => void = () => {};
  /** from driving to working the crane and back */
  onToggle: () => void = () => {};
  /** something was pressed (for a click) */
  onClick: () => void = () => {};

  constructor(parent: HTMLElement, lang: () => string) {
    this.lang = lang;
    const r = (this.root = el('div', 'crane-ui'));
    r.hidden = true;
    // ---- the limiter's display
    const lmi = (this.lmiBox = el('div', 'crane-lmi'));
    const barBox = el('div', 'crane-bar');
    this.bar = el('i');
    this.barText = el('b');
    barBox.append(this.bar, el('span', 'mark'), this.barText);
    this.vals = el('div', 'crane-vals');
    this.msg = el('div', 'crane-msg');
    const levelBox = el('div', 'crane-level');
    this.level = el('span');
    this.bubble = el('i');
    const vial = el('b');
    vial.append(this.bubble);
    levelBox.append(vial, this.level);
    const tip = el('div', 'crane-tip');
    this.tipBar = el('i');
    tip.append(this.tipBar);
    lmi.append(barBox, this.vals, levelBox, tip, this.msg);
    // ---- the set-up: outrigger beams, jacks, levelling
    this.setup = el('div', 'crane-setup');
    const hold = (cls: string, set: (on: boolean) => void): HTMLButtonElement => {
      const b = holdButton(`crane-btn ${cls}`, '', (on) => {
        set(on);
        if (on) this.onClick();
      });
      this.setupButtons.push(b);
      this.setup.append(b);
      return b;
    };
    hold('beams-out', (on) => (this.touchHold.beams = on ? 1 : 0));
    hold('beams-in', (on) => (this.touchHold.beams = on ? -1 : 0));
    hold('jacks-down', (on) => (this.touchHold.jacks = on ? 1 : 0));
    hold('jacks-up', (on) => (this.touchHold.jacks = on ? -1 : 0));
    hold('level', (on) => (this.touchHold.level = on));
    // ---- the actions: sling / let go, creep speed, crane ↔ driving
    this.acts = el('div', 'crane-acts');
    this.attachBtn = tapButton('crane-btn attach', '', () => this.onAttach());
    this.fineBtn = tapButton('crane-btn fine', '', () => {
      this.fineOn = !this.fineOn;
      this.onClick();
    });
    this.modeBtn = tapButton('crane-btn mode', '', () => this.onToggle());
    this.acts.append(this.attachBtn, this.fineBtn, this.modeBtn);
    // ---- the joysticks
    const labels = (): Record<'up' | 'down' | 'left' | 'right', HTMLElement> => ({ up: el('span'), down: el('span'), left: el('span'), right: el('span') });
    this.leftLabels = labels();
    this.rightLabels = labels();
    this.left = new Stick('left', this.leftLabels);
    this.right = new Stick('right', this.rightLabels);
    // ---- the reminder of the keys
    this.keysBox = el('div', 'crane-keys');
    r.append(lmi, this.setup, this.acts, this.left.el, this.right.el, this.keysBox);
    parent.append(r);
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (!this.active || this.root.hidden) return;
      if (e.repeat) return;
      HELD.add(e.code);
      if (e.code === KEYS.attach) {
        e.preventDefault();
        this.onAttach();
      }
    });
    window.addEventListener('keyup', (e) => HELD.delete(e.code));
    window.addEventListener('blur', () => HELD.clear());
  }

  private t(key: string, p?: Record<string, string | number>): string {
    return tr(key, this.lang(), p);
  }

  /** A number the way the language writes it (always Western digits). */
  private num(v: number, digits = 1): string {
    const lang = this.lang();
    if (!this.numFmt || this.numLang !== `${lang}:${digits}`) {
      try {
        this.numFmt = new Intl.NumberFormat(localeOf(lang), { minimumFractionDigits: digits, maximumFractionDigits: digits, numberingSystem: 'latn' });
      } catch {
        this.numFmt = new Intl.NumberFormat('en', { minimumFractionDigits: digits, maximumFractionDigits: digits });
      }
      this.numLang = `${lang}:${digits}`;
    }
    return this.numFmt.format(v);
  }

  /** Show it for a crane (or hide it: null). */
  show(type: CraneType | null): void {
    this.root.hidden = type === null;
    if (!type) {
      this.active = false;
      this.left.release();
      this.right.release();
      HELD.clear();
      return;
    }
    this.type = type;
    this.root.dataset.crane = type;
  }

  /** Fingers or keys: the joysticks, or the reminder of the keys. */
  setMode(mode: 'touch' | 'keys'): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.root.classList.toggle('touch', mode === 'touch');
  }

  /** the texts of the buttons and the joysticks' labels, in the language chosen (again when it changes) */
  private label(): void {
    const key = `${this.lang()}|${this.type}`;
    if (key === `${this.shownLang}|${this.shownType}`) return;
    this.shownLang = this.lang();
    this.shownType = this.type;
    const t = (k: string): string => this.t(k);
    const [bo, bi, jd, ju, lv] = this.setupButtons;
    bo.textContent = t('craneBtn.beamsOut');
    bi.textContent = t('craneBtn.beamsIn');
    jd.textContent = t('craneBtn.jacksDown');
    ju.textContent = t('craneBtn.jacksUp');
    lv.textContent = t('craneBtn.level');
    this.fineBtn.textContent = t('craneBtn.fine');
    const L = this.leftLabels;
    const R = this.rightLabels;
    L.left.textContent = '⟲';
    L.right.textContent = '⟳';
    L.up.textContent = this.type === 'loader' ? t('craneAxis.innerUp') : t('craneAxis.hoistUp');
    L.down.textContent = this.type === 'loader' ? t('craneAxis.innerDown') : t('craneAxis.hoistDown');
    R.up.textContent = this.type === 'tower' ? t('craneAxis.trolleyOut') : this.type === 'loader' ? t('craneAxis.outerUp') : t('craneAxis.luffUp');
    R.down.textContent = this.type === 'tower' ? t('craneAxis.trolleyIn') : this.type === 'loader' ? t('craneAxis.outerDown') : t('craneAxis.luffDown');
    R.left.textContent = this.type === 'tower' ? '' : t('craneAxis.teleIn');
    R.right.textContent = this.type === 'tower' ? '' : t('craneAxis.teleOut');
    // the keys
    const k = (code: string): string => keyName(code, this.lang());
    const item = (keys: string, text: string): HTMLElement => {
      const e = el('span');
      const kb = el('kbd', '', keys);
      e.append(kb, ` ${text}`);
      return e;
    };
    const right = this.type === 'tower' ? t('craneKeys.trolley') : this.type === 'loader' ? t('craneKeys.outer') : t('craneKeys.luff');
    const items = [
      item(`${k(KEYS.slewL)} ${k(KEYS.slewR)}`, t('craneKeys.slew')),
      item(`${k(KEYS.up)} ${k(KEYS.down)}`, this.type === 'loader' ? t('craneKeys.inner') : t('craneKeys.hoist')),
      item('↑ ↓', right),
    ];
    if (this.type !== 'tower') items.push(item('← →', this.type === 'loader' ? t('craneKeys.ext') : t('craneKeys.tele')));
    items.push(item(k('Space'), t('craneKeys.attach')), item(k('ShiftLeft'), t('craneKeys.fine')));
    if (this.type !== 'tower') items.push(item('1 2', t('craneKeys.beams')), item('3 4', t('craneKeys.jacks')), item('5', t('craneKeys.level')), item(k('KeyG'), t('craneKeys.drive')));
    items.push(item(k('KeyV'), t('craneKeys.camera')));
    this.keysBox.replaceChildren(...items);
  }

  /**
   * The controls now: the keys (ramped), a gamepad's sticks, the joysticks
   * on the screen; the set-up held on the buttons, the keys 1 … 5 or the
   * gamepad's cross; the creep speed.
   */
  read(dt: number): CraneControls {
    const out: CraneControls = { lx: 0, ly: 0, rx: 0, ry: 0, fine: this.fineOn, beams: this.touchHold.beams, jacks: this.touchHold.jacks, level: this.touchHold.level };
    if (!this.active) return out;
    const key = (c: string): number => (HELD.has(c) ? 1 : 0);
    const shift = HELD.has('ShiftLeft') || HELD.has('ShiftRight');
    const ramp = (cur: number, want: number): number => {
      const step = dt * (want === 0 ? 4 : 1.6);
      return Math.abs(want - cur) <= step ? want : cur + Math.sign(want - cur) * step;
    };
    const ka = this.keyAxes;
    ka.lx = ramp(ka.lx, key(KEYS.slewR) - key(KEYS.slewL));
    ka.ly = ramp(ka.ly, key(KEYS.up) - key(KEYS.down));
    ka.rx = ramp(ka.rx, key(KEYS.teleOut) - key(KEYS.teleIn));
    ka.ry = ramp(ka.ry, key(KEYS.boomUp) - key(KEYS.boomDown));
    out.lx = ka.lx + shape(this.left.x);
    out.ly = ka.ly + shape(this.left.y);
    out.rx = ka.rx + shape(this.right.x);
    out.ry = ka.ry + shape(this.right.y);
    if (shift) out.fine = true;
    if (key(KEYS.beamsOut)) out.beams = 1;
    if (key(KEYS.beamsIn)) out.beams = -1;
    if (key(KEYS.jacksDown)) out.jacks = 1;
    if (key(KEYS.jacksUp)) out.jacks = -1;
    if (key(KEYS.level)) out.level = true;
    // a gamepad: the two sticks; A slings or lets go, B changes to driving, X the creep speed, Y levels, the cross the outriggers
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    let gp: Gamepad | null = null;
    for (const g of pads) {
      if (g && g.connected && g.mapping === 'standard') {
        gp = g;
        break;
      }
    }
    if (gp) {
      const ax = (i: number): number => shape(gp!.axes[i] ?? 0, 0.12);
      out.lx += ax(0);
      out.ly -= ax(1);
      out.rx += ax(2);
      out.ry -= ax(3);
      const b = gp.buttons.map((x) => x.pressed);
      const pressed = (i: number): boolean => !!b[i] && !this.padPrev[i];
      if (pressed(0)) this.onAttach();
      if (pressed(1)) this.onToggle();
      if (pressed(2)) this.fineOn = !this.fineOn;
      if (b[3]) out.level = true;
      if (b[15]) out.beams = 1;
      if (b[14]) out.beams = -1;
      if (b[13]) out.jacks = 1;
      if (b[12]) out.jacks = -1;
      this.padPrev = b;
    }
    const c = (v: number): number => Math.max(-1, Math.min(1, v));
    out.lx = c(out.lx);
    out.ly = c(out.ly);
    out.rx = c(out.rx);
    out.ry = c(out.ry);
    return out;
  }

  /** The creep speed (as the display shows it). */
  get fine(): boolean {
    return this.fineOn || HELD.has('ShiftLeft') || HELD.has('ShiftRight');
  }

  /** Show what the limiter measures and what can be done now. */
  update(l: Lmi, info: CraneInfo, now: number): void {
    if (this.root.hidden) return;
    this.label();
    const op = info.operating;
    this.root.classList.toggle('operating', op);
    // (the buttons that change between driving and working the crane, and sling the load)
    this.modeBtn.hidden = info.type === 'tower' || !(op ? info.canDrive : info.canOperate);
    setText(this.modeBtn, this.t(op ? 'craneBtn.drive' : 'craneBtn.operate'));
    this.attachBtn.hidden = !op;
    setText(this.attachBtn, this.t(info.hooked ? 'craneBtn.release' : 'craneBtn.attach'));
    this.attachBtn.classList.toggle('ready', info.canAttach || info.hooked);
    this.fineBtn.hidden = !op;
    this.fineBtn.classList.toggle('on', info.fine);
    // (the set-up's buttons while it is being set up: once it stands on its outriggers, level, its boom out, they make room)
    this.setup.hidden = !op || info.type === 'tower' || (info.onOutriggers && !info.stowed && l.incline <= l.levelGood);
    if (now - this.lastDom < 0.08) return;
    this.lastDom = now;
    this.lmiBox.hidden = !op;
    if (!op) return;
    // the bar: the load against the chart
    const p = Math.max(0, l.ratio);
    this.bar.style.width = `${Math.min(100, p * 100).toFixed(1)}%`;
    this.lmiBox.classList.toggle('warn', l.warn && !l.stop);
    this.lmiBox.classList.toggle('stop', l.stop);
    setText(this.barText, l.capacity > 0 ? `${Math.round(p * 100)} %` : '–');
    const n = (v: number, d = 1): string => this.num(v, d);
    const rows: string[] = [
      this.t('lmi.load', { load: n(l.load, 2), max: l.capacity > 0 ? n(l.capacity, 2) : '–' }),
      this.t('lmi.radius', { r: n(l.radius) }) + (info.type === 'mobile' ? ` · ${this.t('lmi.boom', { l: n(l.length), a: n(l.angle, 0) })}` : info.type === 'loader' ? ` · ${this.t('lmi.boomLoader', { a: n(l.angle, 0) })}` : ''),
      `${this.t('lmi.hook', { h: n(l.hookHeight) })} · ${this.t('lmi.swing', { s: n(info.swing) })}`,
      this.t('lmi.wind', { v: n(l.wind), max: n(l.windLimit, 0) }),
    ];
    if (info.type !== 'tower') rows.push(this.t(`lmi.setting.${l.setting}`));
    // (the rows written into the spans that are there – new ones only when their number changes)
    if (this.vals.children.length !== rows.length) this.vals.replaceChildren(...rows.map((t) => el('span', '', t)));
    else rows.forEach((t, i) => setText(this.vals.children[i] as HTMLElement, t));
    this.vals.children[3]?.classList.toggle('bad', l.wind > l.windLimit);
    this.vals.children[3]?.classList.toggle('warn', l.wind > l.windLimit * 0.8 && l.wind <= l.windLimit);
    // the bubble level: the slope along the carrier and across it
    const lv = this.level.parentElement as HTMLElement;
    lv.hidden = info.type === 'tower';
    if (info.type !== 'tower') {
      const k = 18;
      const bx = Math.max(-1, Math.min(1, info.slopeX / 2)) * k;
      const bz = Math.max(-1, Math.min(1, info.slopeZ / 2)) * k;
      this.bubble.style.transform = `translate(${bx.toFixed(1)}px, ${bz.toFixed(1)}px)`;
      lv.classList.toggle('ok', l.incline <= l.levelGood);
      lv.classList.toggle('bad', l.notLevel);
      setText(this.level, this.t('lmi.incline', { d: n(l.incline) }));
    }
    // how near tipping: the crane's own measure (100 %: it tips)
    const u = Number.isFinite(l.tipping) ? l.tipping : 9.99;
    this.tipBar.style.width = `${Math.min(100, u * 100).toFixed(1)}%`;
    this.tipBar.parentElement!.classList.toggle('warn', u > 0.75);
    this.tipBar.parentElement!.title = this.t('lmi.tipping', { p: Math.round(u * 100) });
    this.tipBar.parentElement!.dataset.label = this.t('lmi.tipping', { p: Math.round(u * 100) });
    // what the limiter says
    const msg = l.stop ? (l.capacity <= 0 ? this.t('lmi.msg.range') : this.t('lmi.msg.stop')) : l.notLevel ? this.t('lmi.msg.level') : l.wind > l.windLimit ? this.t('lmi.msg.wind') : l.warn ? this.t('lmi.msg.warn') : '';
    setText(this.msg, msg);
    this.msg.hidden = !msg;
  }

  dispose(): void {
    this.root.remove();
  }
}
