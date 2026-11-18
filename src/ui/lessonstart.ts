// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The start of a driving lesson: where it takes place, and whether the
 * player drives it or watches it.  Shown each time a lesson on the road is
 * started – from any of the menus, since they all start the drive the same
 * way (game.ts begin) –, with what was chosen last time already chosen:
 *
 *  - where: at the start place chosen in the menu (as before – the
 *    practice ground, a car park), at real places anywhere in town, or in a
 *    district picked on a list or on a little map of the districts
 *    (game/lessonplaces.ts);
 *  - how: two big buttons, "Drive it myself" and "Watch it" – then the car
 *    drives the lesson by itself at that place and the instructor says what
 *    it does (game/lessonwatch.ts).
 *
 * Built from the classes the other pages use (overlay, panel, btn, row,
 * note), with tap targets of at least 48 px; the map is a canvas drawn once
 * per choice – no tiles, nothing to load.
 */
import { areaChoices } from '../game/lessonplaces.ts';
import type { LessonArea, LessonPlaceMode } from '../game/lessonplaces.ts';
import type { Settings } from '../game/settings.ts';
import type { SpawnJson } from '../world/types.ts';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** How the districts are laid onto the map's picture: x east to the right, z south downwards, the same scale both ways. */
export interface DistrictFrame {
  /** picture coordinates of a district's middle */
  toPx(x: number, z: number): [number, number];
}

/** The frame for `areas` on a picture `w` × `h` with `pad` pixels round it. */
export function districtFrame(areas: readonly LessonArea[], w: number, h: number, pad = 28): DistrictFrame {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const a of areas) {
    x0 = Math.min(x0, a.x);
    x1 = Math.max(x1, a.x);
    z0 = Math.min(z0, a.z);
    z1 = Math.max(z1, a.z);
  }
  if (!Number.isFinite(x0)) {
    x0 = z0 = -1;
    x1 = z1 = 1;
  }
  const span = Math.max(x1 - x0, z1 - z0, 1);
  const k = Math.min((w - 2 * pad) / Math.max(x1 - x0, span * 0.05), (h - 2 * pad) / Math.max(z1 - z0, span * 0.05));
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  return { toPx: (x, z) => [w / 2 + (x - cx) * k, h / 2 + (z - cz) * k] };
}

/** The district whose dot is nearest to the picture point (px, py), within `reach` pixels – its index, or −1. */
export function districtAt(areas: readonly LessonArea[], frame: DistrictFrame, px: number, py: number, reach = 40): number {
  let best = -1;
  let bd = reach;
  areas.forEach((a, i) => {
    const [x, y] = frame.toPx(a.x, a.z);
    const d = Math.hypot(x - px, y - py);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(cls: string, text: string, act: () => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.onclick = act;
  b.style.cssText = 'display:block;width:100%;min-height:48px;margin:6px 0';
  return b;
}

export interface LessonStartOptions {
  /** the lesson's name */
  title: string;
  /** whether the lesson can be put at a real place (not when the drive starts at an address) */
  place: boolean;
  /** whether it can be watched */
  watch: boolean;
}

/**
 * The panel.  `done` once the player chose to drive or to watch (the settings are set – lessonPlace,
 * lessonArea, lessonWatch; the caller saves them and starts the lesson); `back` closes it.
 */
export function lessonStartPanel(t: T, s: Settings, spawns: readonly SpawnJson[], o: LessonStartOptions, done: () => void, back: () => void): HTMLElement {
  const overlay = el('div', 'overlay');
  const p = el('div', 'panel narrow');
  p.append(el('h1', '', o.title));
  const areas = areaChoices(spawns);
  if (o.place) {
    p.append(el('h2', '', t('lessonPlace.title')));
    const modes: ReadonlyArray<[LessonPlaceMode, string]> = [
      ['start', 'lessonPlace.start'],
      ['town', 'lessonPlace.town'],
      ['area', 'lessonPlace.area'],
    ];
    const modeButtons = modes.map(([m, key]) => {
      const b = button('btn ghost', t(key), () => setMode(m));
      b.setAttribute('aria-pressed', 'false');
      return b;
    });
    p.append(...modeButtons);
    // the district: on a list, or on the map of the districts
    const pick = el('div');
    const sel = el('select');
    sel.style.cssText = 'width:100%;min-height:48px';
    sel.setAttribute('aria-label', t('lessonPlace.areaLabel'));
    areas.forEach((a, i) => {
      const op = el('option', '', a.name);
      op.value = String(i);
      sel.append(op);
    });
    const W = 640;
    const H = 400;
    const canvas = el('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.style.cssText = 'display:block;width:100%;height:auto;margin:8px 0;border-radius:8px;touch-action:manipulation;cursor:pointer';
    canvas.setAttribute('role', 'img');
    const frame = districtFrame(areas, W, H);
    const chosenIndex = (): number => {
      const now = s.lessonArea;
      const i = now ? areas.findIndex((a) => a.name === now.name) : -1;
      return i >= 0 ? i : 0;
    };
    const draw = (): void => {
      const g = canvas.getContext('2d');
      if (!g) return;
      const ink = getComputedStyle(p).color || '#ddd';
      const at = chosenIndex();
      g.clearRect(0, 0, W, H);
      g.fillStyle = 'rgba(127,127,127,0.14)';
      g.fillRect(0, 0, W, H);
      g.font = '22px system-ui, sans-serif';
      g.textAlign = 'center';
      areas.forEach((a, i) => {
        if (i === at) return;
        const [x, y] = frame.toPx(a.x, a.z);
        g.fillStyle = ink;
        g.globalAlpha = 0.55;
        g.beginPath();
        g.arc(x, y, 7, 0, Math.PI * 2);
        g.fill();
      });
      g.globalAlpha = 1;
      const a = areas[at];
      if (a) {
        const [x, y] = frame.toPx(a.x, a.z);
        g.fillStyle = '#e8a33d';
        g.beginPath();
        g.arc(x, y, 13, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = ink;
        g.font = 'bold 26px system-ui, sans-serif';
        g.fillText(a.name, Math.max(90, Math.min(W - 90, x)), y > 50 ? y - 22 : y + 42);
      }
      canvas.setAttribute('aria-label', `${t('lessonStart.map')}: ${a?.name ?? ''}`);
    };
    const choose = (i: number): void => {
      const a = areas[i];
      if (!a) return;
      s.lessonArea = { ...a };
      sel.value = String(i);
      draw();
    };
    sel.onchange = () => choose(Number(sel.value));
    canvas.onclick = (e) => {
      const r = canvas.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const i = districtAt(areas, frame, ((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height, 60);
      if (i >= 0) choose(i);
    };
    pick.append(sel, canvas, el('p', 'note', t('lessonStart.mapHint')));
    p.append(pick);
    const setMode = (m: LessonPlaceMode): void => {
      s.lessonPlace = m;
      s.lessonPlaceAsked = true;
      modeButtons.forEach((b, i) => {
        const on = modes[i][0] === m;
        b.className = on ? 'btn' : 'btn ghost';
        b.setAttribute('aria-pressed', String(on));
      });
      pick.hidden = m !== 'area' || areas.length === 0;
      if (m === 'area') {
        if (!s.lessonArea && areas[0]) s.lessonArea = { ...areas[0] };
        sel.value = String(chosenIndex());
        draw();
      }
    };
    setMode(s.lessonPlace);
  } else p.append(el('p', 'note', t('lessonStart.here')));
  // how: drive it, or watch it
  p.append(el('h2', '', t('lessonStart.how')));
  const go = (watch: boolean): void => {
    s.lessonWatch = watch;
    done();
  };
  const drive = button(s.lessonWatch && o.watch ? 'btn ghost' : 'btn', t('lessonStart.drive'), () => go(false));
  p.append(drive);
  if (o.watch) {
    p.append(button(s.lessonWatch ? 'btn' : 'btn ghost', t('lessonStart.watch'), () => go(true)), el('p', 'note', t('lessonStart.watchNote')));
  } else p.append(el('p', 'note', t('lessonStart.noWatch')));
  p.append(el('p', 'note', t('lessonPlace.note')));
  const b = el('div', 'buttons');
  const backBtn = el('button', 'btn ghost', t('back'));
  backBtn.type = 'button';
  backBtn.onclick = back;
  b.append(backBtn);
  p.append(b);
  overlay.append(p);
  return overlay;
}
