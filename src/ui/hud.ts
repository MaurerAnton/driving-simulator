// SPDX-License-Identifier: AGPL-3.0-only
/** Menus and the in-game HUD (plain DOM, no framework). */
import { LESSONS } from '../game/nav.ts';
import type { Settings } from '../game/settings.ts';
import { saveSettings } from '../game/settings.ts';
import type { Input } from '../input/input.ts';
import type { Violation } from '../sim/rules.ts';
import { SIG } from '../sim/signals.ts';
import type { Lane } from '../world/lanes.ts';
import { CTRL, ROLE } from '../world/types.ts';
import type { SpawnJson } from '../world/types.ts';
import type { World } from '../world/world.ts';
import { VIOLATIONS, tr, violationTitle, violationWhy } from './i18n.ts';
import type { Lang } from './i18n.ts';

export interface HudState {
  speedKmh: number;
  rpm: number;
  gear: string;
  /** km/h; 0 = no limit; -1 = unknown */
  limit: number;
  zone: number;
  junction: null | { dist: number; role: number; ctrl: number; signal: number };
  navText: string;
  navSub: string;
  navArrow: number;
  tip: string;
  showDash: boolean;
  indicator: number;
  hazard: boolean;
  blinkOn: boolean;
  points: number;
  faults: number;
  x: number;
  z: number;
  yaw: number;
}

export interface StartRequest {
  mode: string;
  spawn: number;
}

export interface ResultSummary {
  title: string;
  exam: boolean;
  passed: boolean;
  log: Violation[];
  points: number;
  distanceKm: number;
  minutes: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

const ICON: Record<string, string> = {
  yield: '<svg viewBox="0 0 100 90"><path d="M3 3h94L50 87z" fill="#d0141e"/><path d="M20 13h60L50 67z" fill="#fff"/></svg>',
  stop: '<svg viewBox="0 0 100 100"><path d="M30 2h40l28 28v40L70 98H30L2 70V30z" fill="#d0141e" stroke="#fff" stroke-width="4"/><text x="50" y="62" text-anchor="middle" font-size="30" font-weight="800" fill="#fff" font-family="sans-serif">STOP</text></svg>',
  priority: '<svg viewBox="0 0 100 100"><path d="M50 3l47 47-47 47L3 50z" fill="#fff" stroke="#222" stroke-width="2"/><path d="M50 20l30 30-30 30-30-30z" fill="#f6c817"/></svg>',
  rbl: '<svg viewBox="0 0 100 90"><path d="M50 3l47 84H3z" fill="#d0141e"/><path d="M50 22l31 55H19z" fill="#fff"/><path d="M38 70l24-26M62 70L38 44" stroke="#111" stroke-width="7"/></svg>',
  minor: '<svg viewBox="0 0 100 90"><path d="M3 3h94L50 87z" fill="#888"/><path d="M20 13h60L50 67z" fill="#fff"/></svg>',
  roundabout: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="47" fill="#1b5fa8" stroke="#fff" stroke-width="3"/><path d="M50 22a28 28 0 1 1-26 18" fill="none" stroke="#fff" stroke-width="9"/><path d="M14 36l12 12 8-18z" fill="#fff"/></svg>',
};

export class Hud {
  private readonly root: HTMLElement;
  private readonly settings: Settings;
  private readonly world: World;
  private overlay: HTMLElement | null = null;
  private hud: HTMLElement;
  private navArrow!: HTMLElement;
  private navText!: HTMLElement;
  private navSub!: HTMLElement;
  private navBox!: HTMLElement;
  private roundel!: HTMLElement;
  private zone!: HTMLElement;
  private prio!: HTMLElement;
  private toasts!: HTMLElement;
  private dash!: HTMLElement;
  private dashV!: HTMLElement;
  private dashG!: HTMLElement;
  private dashRpm!: HTMLElement;
  private indL!: HTMLElement;
  private indR!: HTMLElement;
  private tip!: HTMLElement;
  private score!: HTMLElement;
  private mapCanvas!: HTMLCanvasElement;
  private lastDom = 0;
  private lastMap = 0;
  private lastPrio = '';
  onStart: (req: StartRequest) => void = () => {};
  onResume: () => void = () => {};
  onQuit: () => void = () => {};
  onReality: () => void = () => {};
  onSettingsChanged: () => void = () => {};
  routeLanes: Lane[] = [];

  constructor(root: HTMLElement, settings: Settings, world: World) {
    this.root = root;
    this.settings = settings;
    this.world = world;
    this.hud = this.buildHud();
    this.root.append(this.hud);
    this.setHudVisible(false);
  }

  get lang(): Lang {
    return this.settings.lang;
  }

  private t(key: string, p?: Record<string, string | number>): string {
    return tr(key, this.lang, p);
  }

  // ---------------------------------------------------------------- overlays
  private setOverlay(node: HTMLElement | null): void {
    this.overlay?.remove();
    this.overlay = node;
    if (node) this.root.append(node);
  }

  get menuOpen(): boolean {
    return this.overlay !== null;
  }

  showLoading(text: string): void {
    const o = el('div', 'overlay solid');
    const p = el('div', 'panel narrow');
    p.append(el('h1', '', 'Fahrsim <span>Baunatal</span>'), el('p', '', text), el('div', 'progress', '<i></i>'));
    o.append(p);
    this.setOverlay(o);
  }

  showError(text: string): void {
    const o = el('div', 'overlay solid');
    const p = el('div', 'panel narrow');
    p.append(el('h1', '', 'Fahrsim <span>Baunatal</span>'), el('p', '', text));
    o.append(p);
    this.setOverlay(o);
  }

  showMenu(spawns: SpawnJson[], lastSpawn = 0): void {
    const o = el('div', 'overlay');
    const p = el('div', 'panel');
    p.append(el('h1', '', 'Fahrsim <span>Baunatal</span>'), el('p', '', this.t('subtitle')));
    let spawn = Math.min(lastSpawn, Math.max(0, spawns.length - 1));

    const opts = el('div');
    const rowSpawn = el('div', 'row');
    const selSpawn = el('select');
    spawns.forEach((s, i) => {
      const op = el('option');
      op.value = String(i);
      op.textContent = s.name;
      selSpawn.append(op);
    });
    selSpawn.value = String(spawn);
    selSpawn.onchange = () => (spawn = Number(selSpawn.value));
    rowSpawn.append(el('label', '', this.t('startPoint')), selSpawn);
    const rowTr = el('div', 'row');
    const selTr = el('select');
    for (const [v, k] of [['assist', 'trAssist'], ['manual', 'trManual'], ['automatic', 'trAutomatic']]) {
      const op = el('option');
      op.value = v;
      op.textContent = this.t(k);
      selTr.append(op);
    }
    selTr.value = this.settings.transmission;
    selTr.onchange = () => {
      this.settings.transmission = selTr.value as Settings['transmission'];
      saveSettings(this.settings);
    };
    rowTr.append(el('label', '', this.t('transmission')), selTr);
    opts.append(rowSpawn, rowTr);
    p.append(opts);

    p.append(el('h2', '', this.t('start')));
    const cards = el('div', 'cards');
    const card = (title: string, desc: string, mode: string): void => {
      const c = el('button', 'card', `<b>${title}</b><small>${desc}</small>`);
      c.onclick = () => this.onStart({ mode, spawn });
      cards.append(c);
    };
    card(this.t('free'), this.t('freeDesc'), 'free');
    const li = this.lang === 'de' ? 0 : 1;
    for (const l of LESSONS) card(l.title[li], l.kind === 'exam' ? this.t('examDesc') : `${l.intro[li].slice(0, 118)}…`, l.id);
    p.append(cards);

    const b = el('div', 'buttons');
    const bs = el('button', 'btn ghost', this.t('settings'));
    bs.onclick = () => this.showSettings(() => this.showMenu(spawns, spawn));
    const bc = el('button', 'btn ghost', this.t('controls'));
    bc.onclick = () => this.showControls(() => this.showMenu(spawns, spawn));
    const ba = el('button', 'btn ghost', this.t('about'));
    ba.onclick = () => this.showAbout(() => this.showMenu(spawns, spawn));
    b.append(bs, bc, ba);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
  }

  showSettings(back: () => void): void {
    const s = this.settings;
    const o = el('div', 'overlay');
    const p = el('div', 'panel narrow');
    p.append(el('h1', '', this.t('settings')));
    const select = (label: string, value: string, options: Array<[string, string]>, set: (v: string) => void): void => {
      const row = el('div', 'row');
      const sel = el('select');
      for (const [v, text] of options) {
        const op = el('option');
        op.value = v;
        op.textContent = text;
        sel.append(op);
      }
      sel.value = value;
      sel.onchange = () => {
        set(sel.value);
        saveSettings(s);
        this.onSettingsChanged();
      };
      row.append(el('label', '', label), sel);
      p.append(row);
    };
    const check = (label: string, value: boolean, set: (v: boolean) => void): void => {
      const row = el('div', 'row');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = value;
      c.onchange = () => {
        set(c.checked);
        saveSettings(s);
        this.onSettingsChanged();
      };
      const l = el('label', '', label);
      l.style.minWidth = '0';
      l.style.flex = '1';
      row.append(c, l);
      p.append(row);
    };
    const range = (label: string, value: number, set: (v: number) => void): void => {
      const row = el('div', 'row');
      const r = el('input');
      r.type = 'range';
      r.min = '0';
      r.max = '1';
      r.step = '0.05';
      r.value = String(value);
      r.oninput = () => {
        set(Number(r.value));
        saveSettings(s);
        this.onSettingsChanged();
      };
      row.append(el('label', '', label), r);
      p.append(row);
    };
    select(this.t('language'), s.lang, [['de', 'Deutsch'], ['en', 'English']], (v) => {
      s.lang = v as Lang;
      this.showSettings(back);
    });
    select(this.t('transmission'), s.transmission, [['assist', this.t('trAssist')], ['manual', this.t('trManual')], ['automatic', this.t('trAutomatic')]], (v) => (s.transmission = v as Settings['transmission']));
    select(this.t('quality'), s.quality, [['low', this.t('qLow')], ['medium', this.t('qMedium')], ['high', this.t('qHigh')]], (v) => (s.quality = v as Settings['quality']));
    select(this.t('mirrors'), s.mirrors, [['off', this.t('mOff')], ['alternate', this.t('mAlt')], ['full', this.t('mFull')]], (v) => (s.mirrors = v as Settings['mirrors']));
    range(this.t('traffic'), s.traffic, (v) => (s.traffic = v));
    range(this.t('volume'), s.volume, (v) => (s.volume = v));
    check(this.t('hudRules'), s.hudRules, (v) => (s.hudRules = v));
    check(this.t('hudGear'), s.hudGear, (v) => (s.hudGear = v));
    check(this.t('voice'), s.voice, (v) => (s.voice = v));
    const b = el('div', 'buttons');
    const bb = el('button', 'btn', this.t('back'));
    bb.onclick = back;
    b.append(bb);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
  }

  showControls(back: () => void): void {
    const de = this.lang === 'de';
    const rows: Array<[string, string]> = [
      ['<kbd>W</kbd> <kbd>S</kbd> / <kbd>↑</kbd> <kbd>↓</kbd>', de ? 'Gas / Bremse' : 'Throttle / brake'],
      ['<kbd>A</kbd> <kbd>D</kbd> / <kbd>←</kbd> <kbd>→</kbd>', de ? 'Lenken' : 'Steer'],
      ['<kbd>Umschalt</kbd>', de ? 'Kupplung (bei „Kupplung selbst“)' : 'Clutch (Shift, with own-clutch mode)'],
      ['<kbd>E</kbd> <kbd>Q</kbd>', de ? 'Gang hoch / runter (Automatik: Wählhebel)' : 'Gear up / down (automatic: selector)'],
      ['<kbd>1</kbd>–<kbd>6</kbd>, <kbd>R</kbd>, <kbd>N</kbd>', de ? 'Gang direkt, Rückwärts, Leerlauf' : 'Direct gear, reverse, neutral'],
      ['<kbd>Leertaste</kbd>', de ? 'Handbremse' : 'Handbrake (Space)'],
      ['<kbd>Enter</kbd> / <kbd>I</kbd>', de ? 'Motor starten (halten) / Zündung aus' : 'Start engine (hold) / ignition off'],
      ['<kbd>Y</kbd> <kbd>C</kbd> / <kbd>X</kbd>', de ? 'Blinker links / rechts, Warnblinker (unterste Tastenreihe)' : 'Indicator left / right, hazards (Z C X on QWERTY)'],
      ['<kbd>J</kbd> <kbd>K</kbd>', de ? 'Schulterblick links / rechts (beide: nach hinten), oder Maus ziehen' : 'Shoulder check left / right (both: look back), or drag the mouse'],
      ['<kbd>B</kbd>', de ? 'Gurt anlegen' : 'Seat belt'],
      ['<kbd>L</kbd> / <kbd>O</kbd>', de ? 'Abblendlicht / Fernlicht' : 'Dipped / main beam'],
      ['<kbd>H</kbd>', de ? 'Hupe' : 'Horn'],
      ['<kbd>V</kbd>', de ? 'Kamera wechseln' : 'Change camera'],
      ['<kbd>T</kbd>', de ? 'Auto zurück auf die Straße setzen' : 'Put the car back on the road'],
      ['<kbd>F</kbd>', de ? 'Realansicht: echte Fotos dieser Stelle' : 'Reality view: real photos of this place'],
      ['<kbd>Esc</kbd>', de ? 'Pause' : 'Pause'],
    ];
    const o = el('div', 'overlay');
    const p = el('div', 'panel');
    p.append(el('h1', '', this.t('controls')));
    const table = el('table', 'keys');
    for (const [k, d] of rows) table.append(el('tr', '', `<td>${k}</td><td>${d}</td>`));
    p.append(table);
    p.append(
      el(
        'p',
        '',
        de
          ? 'Gamepad: linker Stick lenken, RT Gas, LT Bremse, RB/LB schalten, A Handbremse, X/B Blinker, Y Warnblinker. Lenkräder (Logitech, Thrustmaster, Fanatec …) werden über die Gamepad-Schnittstelle des Browsers erkannt, inklusive Kupplungspedal und H-Schaltung.'
          : 'Gamepad: left stick steers, RT throttle, LT brake, RB/LB shift, A handbrake, X/B indicators, Y hazards. Steering wheels (Logitech, Thrustmaster, Fanatec …) are detected through the browser gamepad API, including clutch pedal and H-shifter.',
      ),
    );
    const b = el('div', 'buttons');
    const bb = el('button', 'btn', this.t('back'));
    bb.onclick = back;
    b.append(bb);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
  }

  showAbout(back: () => void): void {
    const de = this.lang === 'de';
    const o = el('div', 'overlay');
    const p = el('div', 'panel');
    p.append(el('h1', '', this.t('about')));
    p.append(
      el(
        'p',
        '',
        de
          ? 'Fahrsim Baunatal ist freie Software unter der GNU Affero General Public License, Version 3 (AGPL-3.0-only). Du darfst sie nutzen, untersuchen, verändern und weitergeben. Der Simulator ersetzt keine Fahrstunde und keine amtliche Prüfung.'
          : 'Fahrsim Baunatal is free software under the GNU Affero General Public License, version 3 (AGPL-3.0-only). You may use, study, change and share it. The simulator does not replace driving lessons or the official test.',
      ),
    );
    p.append(el('h2', '', this.t('credits')));
    for (const a of this.world.meta.attribution) p.append(el('p', '', a));
    p.append(
      el(
        'p',
        '',
        de
          ? 'Verkehrszeichen: amtliche Werke (§ 5 Abs. 1 UrhG), Vektorgrafiken von Wikimedia Commons (gemeinfrei). 3D-Darstellung: three.js (MIT).'
          : 'Traffic signs: official works (§ 5 (1) UrhG), vector graphics from Wikimedia Commons (public domain). 3D rendering: three.js (MIT).',
      ),
    );
    p.append(el('h2', '', this.t('source')));
    p.append(el('p', '', '<a href="https://github.com/MaurerAnton/driving-simulator" target="_blank" rel="noopener">github.com/MaurerAnton/driving-simulator</a>'));
    const b = el('div', 'buttons');
    const bb = el('button', 'btn', this.t('back'));
    bb.onclick = back;
    b.append(bb);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
  }

  showIntro(title: string, text: string, go: () => void): void {
    const o = el('div', 'overlay');
    const p = el('div', 'panel narrow');
    p.append(el('h1', '', title), el('p', '', text));
    const b = el('div', 'buttons');
    const bb = el('button', 'btn', this.t('start'));
    bb.onclick = go;
    b.append(bb);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
    bb.focus();
  }

  showPause(): void {
    const o = el('div', 'overlay');
    const p = el('div', 'panel narrow');
    p.append(el('h1', '', this.t('paused')));
    const b = el('div', 'buttons');
    const r = el('button', 'btn', this.t('resume'));
    r.onclick = () => this.onResume();
    const s = el('button', 'btn ghost', this.t('settings'));
    s.onclick = () => this.showSettings(() => this.showPause());
    const c = el('button', 'btn ghost', this.t('controls'));
    c.onclick = () => this.showControls(() => this.showPause());
    const q = el('button', 'btn ghost', this.t('menu'));
    q.onclick = () => this.onQuit();
    const f = el('button', 'btn ghost', this.t('realityButton'));
    f.onclick = () => this.onReality();
    b.append(r, f, s, c, q);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
    r.focus();
  }

  showResult(r: ResultSummary): void {
    const o = el('div', 'overlay');
    const p = el('div', 'panel');
    p.append(el('h1', '', `${this.t('result')}: ${r.title}`));
    if (r.exam) p.append(el('div', `verdict ${r.passed ? 'ok' : 'bad'}`, this.t(r.passed ? 'passed' : 'failed')));
    p.append(el('p', '', `${this.t('distance')}: ${r.distanceKm.toFixed(1)} km · ${this.t('duration')}: ${Math.round(r.minutes)} min · ${this.t('points')}: ${r.points}`));
    if (r.log.length === 0) p.append(el('p', '', this.t('noFaults')));
    // group identical faults
    const groups = new Map<string, { v: Violation; n: number }>();
    for (const v of r.log) {
      const g = groups.get(v.id);
      if (g) g.n++;
      else groups.set(v.id, { v, n: 1 });
    }
    const order: Record<string, number> = { fail: 0, major: 1, minor: 2, hint: 3 };
    for (const g of [...groups.values()].sort((a, b) => order[a.v.severity] - order[b.v.severity])) {
      const f = el('div', `fault ${g.v.severity}`);
      f.append(el('b', '', `${violationTitle(g.v.id, this.lang, g.v.data)}${g.n > 1 ? ` (${g.n}×)` : ''}`), el('small', '', violationWhy(g.v.id, this.lang)), el('em', '', `${this.t(g.v.severity)} · ${VIOLATIONS[g.v.id]?.ref ?? ''}`));
      p.append(f);
    }
    const b = el('div', 'buttons');
    const q = el('button', 'btn', this.t('menu'));
    q.onclick = () => this.onQuit();
    b.append(q);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
  }

  hideOverlay(): void {
    this.setOverlay(null);
  }

  // --------------------------------------------------------------------- HUD
  private buildHud(): HTMLElement {
    const h = el('div', 'hud');
    this.navBox = el('div', 'nav');
    this.navArrow = el('div', 'arrow', '↑');
    const text = el('div', 'text');
    this.navText = el('b');
    this.navSub = el('small');
    text.append(this.navText, this.navSub);
    this.navBox.append(this.navArrow, text);
    const assist = el('div', 'assist');
    this.prio = el('div', 'prio');
    this.zone = el('div', 'zone');
    this.roundel = el('div', 'roundel');
    assist.append(this.prio, this.zone, this.roundel);
    this.toasts = el('div', 'toasts');
    this.dash = el('div', 'dash');
    this.indL = el('span', 'ind', '◀');
    this.dashV = el('span', 'v', '0');
    this.dashG = el('span', 'g', 'N');
    const rpm = el('span', 'rpm');
    this.dashRpm = el('i');
    rpm.append(this.dashRpm);
    this.indR = el('span', 'ind', '▶');
    this.dash.append(this.indL, this.dashV, el('span', 'u', 'km/h'), this.dashG, rpm, this.indR);
    this.tip = el('div', 'tip');
    const map = el('div', 'map');
    this.mapCanvas = el('canvas');
    this.mapCanvas.width = 220;
    this.mapCanvas.height = 220;
    map.append(this.mapCanvas);
    this.score = el('div', 'score');
    h.append(this.navBox, assist, this.toasts, this.dash, this.tip, map, this.score);
    return h;
  }

  setHudVisible(v: boolean): void {
    this.hud.style.display = v ? '' : 'none';
  }

  toast(v: Violation): void {
    const t = el('div', `toast ${v.severity}`);
    t.append(el('b', '', violationTitle(v.id, this.lang, v.data)), el('small', '', violationWhy(v.id, this.lang)), el('em', '', `${this.t(v.severity)} · ${VIOLATIONS[v.id]?.ref ?? ''}`));
    this.toasts.prepend(t);
    while (this.toasts.children.length > 3) this.toasts.lastChild?.remove();
    const life = v.severity === 'hint' ? 5500 : 8000;
    setTimeout(() => t.remove(), life);
  }

  message(title: string, sub = ''): void {
    const t = el('div', 'toast hint');
    t.append(el('b', '', title));
    if (sub) t.append(el('small', '', sub));
    this.toasts.prepend(t);
    while (this.toasts.children.length > 3) this.toasts.lastChild?.remove();
    setTimeout(() => t.remove(), 6000);
  }

  update(s: HudState, now: number): void {
    if (now - this.lastDom > 0.09) {
      this.lastDom = now;
      const rules = this.settings.hudRules;
      // navigation box
      const hasNav = s.navText !== '';
      this.navBox.style.display = hasNav ? '' : 'none';
      if (hasNav) {
        this.navArrow.textContent = s.navArrow < 0 ? '↰' : s.navArrow > 0 ? '↱' : '↑';
        this.navText.textContent = s.navText;
        this.navSub.textContent = s.navSub;
      }
      // speed limit
      if (rules && s.limit >= 0) {
        this.roundel.style.display = '';
        const none = s.limit === 0;
        this.roundel.className = `roundel${none ? ' none' : ''}${!none && s.speedKmh > s.limit + 6 ? ' over' : ''}`;
        this.roundel.textContent = none ? this.t('limitNone') : s.zone === 7 ? this.t('walk') : String(s.limit);
        if (s.zone === 7) this.roundel.style.fontSize = '12px';
        else this.roundel.style.fontSize = '';
        this.zone.style.display = s.zone === 30 || s.zone === 20 ? '' : 'none';
        this.zone.textContent = 'ZONE';
      } else {
        this.roundel.style.display = 'none';
        this.zone.style.display = 'none';
      }
      // right of way at the next junction
      let key = '';
      if (rules && s.junction && s.junction.dist < 120) {
        const j = s.junction;
        if (j.signal >= 0) key = `sig${j.signal}`;
        else if (j.ctrl === CTRL.ROUNDABOUT && j.role !== ROLE.PRIORITY) key = 'roundabout';
        else if (j.role === ROLE.STOP) key = 'stop';
        else if (j.role === ROLE.YIELD) key = 'yield';
        else if (j.role === ROLE.RBL) key = 'rbl';
        else if (j.role === ROLE.MINOR) key = 'minor';
        else if (j.role === ROLE.PRIORITY && j.ctrl === CTRL.SIGNS) key = 'priority';
      }
      if (key !== this.lastPrio) {
        this.lastPrio = key;
        if (key.startsWith('sig')) {
          const st = Number(key.slice(3));
          const lamp = (on: boolean, c: string): string => `<circle cx="30" cy="${c === '#ff2a1a' ? 16 : c === '#ffb000' ? 44 : 72}" r="11" fill="${on ? c : '#2a2a2a'}"/>`;
          this.prio.innerHTML = `<svg viewBox="0 0 60 88"><rect x="8" y="1" width="44" height="86" rx="8" fill="#111" stroke="#666"/>${lamp(st === SIG.RED || st === SIG.RED_AMBER, '#ff2a1a')}${lamp(st === SIG.AMBER || st === SIG.RED_AMBER, '#ffb000')}${lamp(st === SIG.GREEN, '#1aff6a')}</svg>`;
        } else this.prio.innerHTML = key ? ICON[key] : '';
      }
      // dashboard strip (outside views only; the cockpit has real instruments)
      this.dash.style.display = s.showDash ? '' : 'none';
      if (s.showDash) {
        this.dashV.textContent = String(Math.round(Math.abs(s.speedKmh)));
        this.dashG.textContent = s.gear;
        this.dashRpm.style.width = `${Math.min(100, (s.rpm / 7000) * 100).toFixed(0)}%`;
        this.indL.className = `ind${s.blinkOn && (s.hazard || s.indicator < 0) ? ' on' : ''}`;
        this.indR.className = `ind${s.blinkOn && (s.hazard || s.indicator > 0) ? ' on' : ''}`;
      }
      this.tip.style.display = s.tip ? '' : 'none';
      this.tip.textContent = s.tip;
      this.score.innerHTML = `${this.t('faults')}: <b>${s.faults}</b> · ${this.t('points')}: <b>${s.points}</b>`;
    }
    if (now - this.lastMap > 0.12) {
      this.lastMap = now;
      this.drawMap(s);
    }
  }

  private drawMap(s: HudState): void {
    const c = this.mapCanvas;
    const g = c.getContext('2d');
    if (!g) return;
    const W = c.width;
    const scale = 0.42; // px per metre
    const range = W / 2 / scale + 20;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#1c2630';
    g.fillRect(0, 0, W, W);
    // heading up: rotate so that the car's forward (-sin yaw, -cos yaw) points to -y
    g.translate(W / 2, W / 2 + 28);
    g.rotate(s.yaw);
    g.scale(scale, scale);
    g.translate(-s.x, -s.z);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const draw = (color: string, minTier: number, maxTier: number, extra: number): void => {
      g.strokeStyle = color;
      this.world.edgesInBox(s.x - range, s.z - range, s.x + range, s.z + range, (e) => {
        if (e.tier < minTier || e.tier > maxTier) return;
        g.lineWidth = e.width + extra;
        g.beginPath();
        const p = e.pl.pts;
        g.moveTo(p[0], p[2]);
        for (let i = 3; i < p.length; i += 3) g.lineTo(p[i], p[i + 2]);
        g.stroke();
      });
    };
    draw('#55606b', 0, 1.5, 0);
    draw('#aab4bd', 2, 2.9, 1);
    draw('#f1f3f5', 3, 5.5, 2);
    draw('#f5b942', 6, 9, 3);
    if (this.routeLanes.length) {
      g.strokeStyle = '#3d8bff';
      g.lineWidth = 7;
      for (const lane of this.routeLanes) {
        const e = lane.edge;
        if (e.maxX < s.x - range || e.minX > s.x + range || e.maxZ < s.z - range || e.minZ > s.z + range) continue;
        g.beginPath();
        const p = e.pl.pts;
        g.moveTo(p[0], p[2]);
        for (let i = 3; i < p.length; i += 3) g.lineTo(p[i], p[i + 2]);
        g.stroke();
      }
    }
    // the car
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.translate(W / 2, W / 2 + 28);
    g.fillStyle = '#ffcc00';
    g.strokeStyle = '#111';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -11);
    g.lineTo(7, 8);
    g.lineTo(0, 4);
    g.lineTo(-7, 8);
    g.closePath();
    g.fill();
    g.stroke();
  }

  // ------------------------------------------------------------- touch input
  enableTouch(input: Input): void {
    const t = el('div', 'touch');
    const steer = el('div', 'steer');
    const knob = el('i');
    steer.append(knob);
    const move = (e: PointerEvent): void => {
      const r = steer.getBoundingClientRect();
      const v = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      input.touch.steer = v;
      input.touch.active = true;
      knob.style.left = `${43 + v * 43}%`;
    };
    steer.onpointerdown = (e) => {
      steer.setPointerCapture(e.pointerId);
      move(e);
    };
    steer.onpointermove = (e) => {
      if (e.buttons || e.pointerType === 'touch') move(e);
    };
    steer.onpointerup = () => {
      input.touch.steer = 0;
      knob.style.left = '43%';
    };
    const pedal = (cls: string, label: string, set: (v: number) => void): HTMLElement => {
      const p = el('div', `pedal ${cls}`, label);
      const mv = (e: PointerEvent): void => {
        const r = p.getBoundingClientRect();
        set(Math.max(0.15, Math.min(1, 1 - (e.clientY - r.top) / r.height + 0.15)));
        input.touch.active = true;
      };
      p.onpointerdown = (e) => {
        p.setPointerCapture(e.pointerId);
        mv(e);
      };
      p.onpointermove = (e) => {
        if (e.buttons || e.pointerType === 'touch') mv(e);
      };
      p.onpointerup = () => set(0);
      p.onpointercancel = () => set(0);
      return p;
    };
    const key = (label: string, code: string, right: string, bottom: string): HTMLElement => {
      const b = el('button', 'tb', label);
      b.style.right = right;
      b.style.bottom = bottom;
      b.onpointerdown = (e) => {
        e.preventDefault();
        window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      };
      b.onpointerup = () => window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      return b;
    };
    t.append(
      steer,
      pedal('gas', 'GAS', (v) => (input.touch.throttle = v)),
      pedal('brk', 'BREMSE', (v) => (input.touch.brake = v)),
      key('▲', 'KeyE', '38vw', '6vh'),
      key('▼', 'KeyQ', '38vw', '20vh'),
      key('◀', 'KeyZ', '46vw', '6vh'),
      key('▶', 'KeyC', '46vw', '20vh'),
      key('P', 'Space', '38vw', '34vh'),
      key('⏻', 'Enter', '46vw', '34vh'),
    );
    this.hud.append(t);
  }
}
