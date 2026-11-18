// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Arranging the HUD: the player drags its parts where they suit them.
 *
 * "Arrange the display" (a tile of the pause menu, a button of the settings
 * while driving – or a long press on a part of the display) lays a layer over
 * the picture: each part of the HUD named below is outlined and can be
 * dragged with a finger or the mouse – also parts that are hidden just now
 * (shown dimmed meanwhile), and the buttons on the corner map, which can be
 * taken out of it onto the main screen (the "my position" button, the button
 * of the big map).  "Done" ends it, "Reset layout" puts everything back.
 *
 * A part that stays in its place in the page is only shifted (the CSS
 * property `translate`, which adds to whatever `transform` it has, so its
 * own styles stay as they are); a part taken out of the map is moved into
 * the HUD and placed there.  Positions are kept in this browser as shares of
 * the screen, one set for the keyboard layout and one for the touch layout
 * of the HUD (as the corner map's own place, ui/minimap.ts – the map itself
 * is moved by dragging its rim).
 *
 * So that the player finds it: a long press (a finger held still for a
 * moment) on one of the display's read-outs – the street name, the speed,
 * the score, the clock … – begins arranging (not on the on-screen controls,
 * which are held while driving), and once, some seconds into the first
 * drive, a short notice says so.
 */

const KEY = 'fahrsim-baunatal.hudlayout.v1';
/** set once the notice about arranging was shown (or the player found it alone) */
const HINT_KEY = 'fahrsim-baunatal.hudlayout.hinted';
/** how long (ms) a finger is held still to begin arranging */
export const LONG_PRESS_MS = 650;
/** how far (px) it may wander meanwhile */
const LONG_PRESS_SLOP = 10;
/** the parts a long press on which begins arranging: read-outs, never controls that are held while driving */
export const LONG_PRESS_IDS: readonly string[] = ['nav', 'assist', 'dash', 'tip', 'score', 'keys', 'fps', 'clock'];
/** seconds into the drive the notice about arranging is shown */
const HINT_AFTER = 20;

/** A part of the HUD that can be moved. */
interface Item {
  id: string;
  /** where it is in the HUD */
  selector: string;
  /** the i18n key of its name (shown on it while it is empty) */
  name: string;
  /** taken out of its box onto the HUD when moved (its box clips it) */
  detach?: boolean;
}

const ITEMS: readonly Item[] = [
  { id: 'nav', selector: '.side > .nav', name: 'hudLayout.nav' },
  { id: 'assist', selector: ':scope > .assist', name: 'hudLayout.assist' },
  { id: 'dash', selector: ':scope > .dash', name: 'hudLayout.dash' },
  { id: 'tip', selector: ':scope > .tip', name: 'hudLayout.tip' },
  { id: 'score', selector: ':scope > .score', name: 'hudLayout.score' },
  { id: 'keys', selector: ':scope > .keyhelp', name: 'hudLayout.keys' },
  { id: 'fps', selector: ':scope > .fps', name: 'hudLayout.fps' },
  { id: 'clock', selector: '.clock-badge', name: 'hudLayout.clock' },
  { id: 'newVehicle', selector: '.new-vehicle', name: 'hudLayout.newVehicle' },
  { id: 'mirrorBtn', selector: '.mirrorbtn', name: 'mirrorLook' },
  { id: 'locate', selector: '.mini-back', name: 'hudLayout.locate', detach: true },
  { id: 'mapBtn', selector: '.expand', name: 'mapTitle', detach: true },
  // the on-screen controls (touch layout)
  { id: 'steer', selector: '.touch > .steer', name: 'hudLayout.steer' },
  { id: 'gas', selector: '.touch > .pedal.gas', name: 'tbGas' },
  { id: 'brake', selector: '.touch > .pedal.brk', name: 'tbBrake' },
  { id: 'indL', selector: '.touch > .ind-l', name: 'tbIndLeft' },
  { id: 'indR', selector: '.touch > .ind-r', name: 'tbIndRight' },
  { id: 'gearUp', selector: '.touch > .gear-up', name: 'tbGearUp' },
  { id: 'gearDown', selector: '.touch > .gear-dn', name: 'tbGearDown' },
  { id: 'handbrake', selector: '.touch > .hb', name: 'tbHandbrake' },
  { id: 'autopilot', selector: '.touch > .ap', name: 'tbAutopilot' },
  { id: 'more', selector: '.touch > .more-btn', name: 'tbMore' },
];

/** Where a part is: shifted by (x, y) – or, taken out, its upper left corner at (x, y) – as shares of the HUD's width and height. */
interface Pos {
  x: number;
  y: number;
  free?: boolean;
}
type Saved = Record<string, Record<string, Pos>>;

function hintedBefore(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) !== null;
  } catch {
    return false;
  }
}

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved;
    return typeof v === 'object' && v ? v : {};
  } catch {
    return {};
  }
}

/** A bound part: its element and where it came from (to put it back). */
interface Bound {
  el: HTMLElement;
  parent: Node | null;
  next: Node | null;
}

export class HudLayout {
  private readonly hud: HTMLElement;
  private readonly t: (key: string) => string;
  private saved: Saved = load();
  private readonly bound = new Map<string, Bound>();
  private layout = '';
  private lastCheck = -1;
  private bar: HTMLElement | null = null;
  private shield: HTMLElement | null = null;
  private drag: { id: number; item: Item; el: HTMLElement; x: number; y: number; px: number; py: number; k: number; moved: boolean } | null = null;
  /** a finger (or the mouse) held on a part: arranging begins when it stays */
  private press: { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** the notice about arranging (null: none to give) */
  private readonly hint: ((text: string) => void) | null;
  private hinted = hintedBefore();
  private hintFrom = -1;

  constructor(hud: HTMLElement, t: (key: string) => string, hint: ((text: string) => void) | null = null) {
    this.hud = hud;
    this.t = t;
    this.hint = hint;
    window.addEventListener('resize', () => this.applyAll());
    // a long press on a read-out begins arranging (on the window: the read-outs let the fingers through to the picture)
    window.addEventListener('pointerdown', this.pressDown, true);
    // while arranging: a finger on a part drags it – its own buttons and handlers get nothing
    hud.addEventListener('pointerdown', this.down, true);
    hud.addEventListener('click', this.swallow, true);
    window.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
    window.addEventListener('pointercancel', this.up);
  }

  get arranging(): boolean {
    return this.hud.classList.contains('arranging');
  }

  private layoutNow(): string {
    return this.hud.classList.contains('touchmode') ? 'touch' : 'keys';
  }

  /** Called with the HUD's update (seconds): finds parts that appeared, follows the layout (keys / touch). Cheap: twice a second. */
  tick(now: number): void {
    if (!this.hinted && Number.isFinite(now)) this.tickHint(now);
    const layout = this.layoutNow();
    if (layout === this.layout && now - this.lastCheck < 0.5 && now >= this.lastCheck) return;
    this.lastCheck = now;
    const changed = layout !== this.layout;
    this.layout = layout;
    for (const item of ITEMS) {
      const b = this.bound.get(item.id);
      if (b && b.el.isConnected && !changed) continue;
      this.bind(item);
    }
  }

  private find(item: Item): HTMLElement | null {
    const b = this.bound.get(item.id);
    if (b?.el.isConnected) return b.el;
    return this.hud.querySelector<HTMLElement>(item.selector);
  }

  private bind(item: Item): void {
    const el = this.find(item);
    if (!el) return;
    let b = this.bound.get(item.id);
    if (!b || b.el !== el) {
      b = { el, parent: el.parentNode, next: el.nextSibling };
      this.bound.set(item.id, b);
      el.dataset.hudMove = item.id;
      el.dataset.hudName = this.t(item.name);
    }
    this.apply(item, b);
  }

  private applyAll(): void {
    for (const item of ITEMS) {
      const b = this.bound.get(item.id);
      if (b) this.apply(item, b);
    }
  }

  /** Put a part where this layout keeps it (or where it belongs). */
  private apply(item: Item, b: Bound): void {
    const p = this.saved[this.layout]?.[item.id];
    const el = b.el;
    const W = this.hud.clientWidth || window.innerWidth;
    const H = this.hud.clientHeight || window.innerHeight;
    if (p?.free && item.detach) {
      if (el.parentNode !== this.hud) this.hud.append(el);
      el.classList.add('hud-free');
      el.style.translate = '';
      el.style.left = `${Math.round(p.x * W)}px`;
      el.style.top = `${Math.round(p.y * H)}px`;
      el.style.right = el.style.bottom = 'auto';
      return;
    }
    if (el.classList.contains('hud-free')) this.putBack(b);
    el.style.translate = p ? `${Math.round(p.x * W)}px ${Math.round(p.y * H)}px` : '';
  }

  /** A part taken out of its box: back into it. */
  private putBack(b: Bound): void {
    const el = b.el;
    el.classList.remove('hud-free');
    el.style.left = el.style.top = el.style.right = el.style.bottom = '';
    if (b.parent && b.parent.isConnected && el.parentNode !== b.parent) b.parent.insertBefore(el, b.next && b.next.parentNode === b.parent ? b.next : null);
  }

  /** Once, some seconds into a drive: a notice that the display can be arranged (not to one who has arranged it already). */
  private tickHint(now: number): void {
    if (this.hintFrom < 0 || now < this.hintFrom) this.hintFrom = now;
    if (now - this.hintFrom < HINT_AFTER || this.hud.style.display === 'none') return;
    this.markHinted();
    if (Object.keys(this.saved).length === 0) this.hint?.(this.t('hudLayout.firstHint'));
  }

  private markHinted(): void {
    this.hinted = true;
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      /* (kept for this page only) */
    }
  }

  /** Begin arranging: the parts outlined and draggable, a bar with "Done" and "Reset layout". */
  arrange(): void {
    this.endPress();
    if (this.arranging) return;
    if (!this.hinted) this.markHinted();
    this.tick(Number.POSITIVE_INFINITY);
    this.lastCheck = -1;
    this.hud.classList.add('arranging');
    for (const item of ITEMS) {
      const b = this.bound.get(item.id);
      if (b) b.el.dataset.hudName = this.t(item.name);
    }
    const shield = document.createElement('div');
    shield.className = 'hud-arrange-shield';
    const bar = document.createElement('div');
    bar.className = 'hud-arrange';
    const text = document.createElement('span');
    text.textContent = this.t('hudLayout.hint');
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn ghost';
    reset.textContent = this.t('hudLayout.reset');
    reset.onclick = () => this.reset();
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'btn';
    done.textContent = this.t('hudLayout.done');
    done.onclick = () => this.stop();
    bar.append(text, reset, done);
    this.hud.prepend(shield);
    this.hud.append(bar);
    this.shield = shield;
    this.bar = bar;
  }

  /** End arranging. */
  stop(): void {
    this.hud.classList.remove('arranging');
    this.bar?.remove();
    this.shield?.remove();
    this.bar = this.shield = null;
    this.drag = null;
  }

  /** Everything back where it belongs (both layouts). */
  reset(): void {
    this.saved = {};
    this.save();
    for (const item of ITEMS) {
      const b = this.bound.get(item.id);
      if (!b) continue;
      if (b.el.classList.contains('hud-free')) this.putBack(b);
      b.el.style.translate = '';
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.saved));
    } catch {
      /* (a browser that keeps nothing: the layout holds until the page is left) */
    }
  }

  private readonly down = (e: PointerEvent): void => {
    if (!this.arranging || !(e.target instanceof Element)) return;
    if (this.bar && this.bar.contains(e.target)) return;
    const el = e.target.closest<HTMLElement>('[data-hud-move]');
    const item = el ? ITEMS.find((i) => i.id === el.dataset.hudMove) : undefined;
    e.preventDefault();
    e.stopPropagation();
    if (!el || !item || !this.hud.contains(el)) return;
    // how many of the HUD's own pixels a pixel of the screen is (the interface may be zoomed)
    const k = this.hud.clientWidth / Math.max(1, this.hud.getBoundingClientRect().width) || 1;
    const p = this.saved[this.layout]?.[item.id];
    let px = 0;
    let py = 0;
    if (p?.free && item.detach) {
      px = el.offsetLeft;
      py = el.offsetTop;
    } else if (p) {
      px = p.x * this.hud.clientWidth;
      py = p.y * this.hud.clientHeight;
    }
    this.drag = { id: e.pointerId, item, el, x: e.clientX, y: e.clientY, px, py, k, moved: false };
  };

  /** The part of the display under a point that a long press begins arranging on, if any. */
  private readOutAt(x: number, y: number): Item | null {
    for (const id of LONG_PRESS_IDS) {
      const b = this.bound.get(id);
      if (!b || !b.el.isConnected) continue;
      const r = b.el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return ITEMS.find((i) => i.id === id) ?? null;
    }
    return null;
  }

  private readonly pressDown = (e: PointerEvent): void => {
    this.endPress();
    if (this.arranging || e.button > 0 || this.hud.style.display === 'none' || !this.hud.isConnected) return;
    const target = e.target instanceof Element ? e.target : null;
    // (the controls on the screen, the corner map, the mirror, the menus: theirs)
    if (target && target.closest('.touch, .map, .mirrorbtn, .mirrorzoom, .overlay, select, input')) return;
    if (!this.readOutAt(e.clientX, e.clientY)) return;
    const id = e.pointerId;
    this.press = {
      id,
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        if (this.press?.id !== id) return;
        this.press = null;
        (navigator as { vibrate?: (ms: number) => boolean }).vibrate?.(25);
        this.arrange();
      }, LONG_PRESS_MS),
    };
  };

  private endPress(): void {
    if (this.press) clearTimeout(this.press.timer);
    this.press = null;
  }

  private readonly move = (e: PointerEvent): void => {
    const p = this.press;
    if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP) this.endPress();
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved && d.item.detach && !d.el.classList.contains('hud-free')) {
      // out of its box: from where it is on the screen now
      const r = d.el.getBoundingClientRect();
      const h = this.hud.getBoundingClientRect();
      d.px = (r.left - h.left) * d.k;
      d.py = (r.top - h.top) * d.k;
      this.store(d.item, d.px, d.py, true);
      this.apply(d.item, this.bound.get(d.item.id)!);
    }
    d.moved = true;
    const free = d.el.classList.contains('hud-free');
    let x = d.px + dx * d.k;
    let y = d.py + dy * d.k;
    // (not off the screen: the part's rectangle stays within the HUD)
    const W = this.hud.clientWidth;
    const H = this.hud.clientHeight;
    if (free) {
      x = Math.max(0, Math.min(W - d.el.offsetWidth, x));
      y = Math.max(0, Math.min(H - d.el.offsetHeight, y));
    } else {
      const r = d.el.getBoundingClientRect();
      const h = this.hud.getBoundingClientRect();
      const cur = this.saved[this.layout]?.[d.item.id];
      // where it would be without a shift (screen px)
      const baseL = r.left - h.left - ((cur?.x ?? 0) * W) / d.k;
      const baseT = r.top - h.top - ((cur?.y ?? 0) * H) / d.k;
      x = Math.max(-baseL * d.k, Math.min((h.width - r.width - baseL) * d.k, x));
      y = Math.max(-baseT * d.k, Math.min((h.height - r.height - baseT) * d.k, y));
    }
    this.store(d.item, x, y, free);
    this.apply(d.item, this.bound.get(d.item.id)!);
  };

  private readonly up = (e: PointerEvent): void => {
    if (this.press?.id === e.pointerId) this.endPress();
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    if (d.moved) this.save();
  };

  private readonly swallow = (e: MouseEvent): void => {
    if (!this.arranging || !(e.target instanceof Element)) return;
    if (this.bar && this.bar.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  private store(item: Item, x: number, y: number, free: boolean): void {
    const W = Math.max(1, this.hud.clientWidth);
    const H = Math.max(1, this.hud.clientHeight);
    const layout = (this.saved[this.layout] ??= {});
    layout[item.id] = free ? { x: x / W, y: y / H, free: true } : { x: x / W, y: y / H };
  }
}
