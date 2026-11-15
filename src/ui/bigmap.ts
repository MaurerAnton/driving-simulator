// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The full-screen map: the whole road network north up, where the car is,
 * where it has been, and – in a free drive – a way to put it anywhere: tap a
 * road, then "put the car here".
 *
 * Drag to move the map, pinch or use the wheel to zoom.  Everything works
 * with a finger, a mouse or the keyboard (arrows, + and -).
 */
import type { DrivenPath } from '../game/track.ts';
import { AERIAL_SOURCE, AerialCache, aerialLevel, aerialTileSize, aerialTiles } from '../reality/aerial.ts';
import { formatUnit, tr } from '../i18n/index.ts';
import type { SpawnJson } from '../world/types.ts';
import type { World } from '../world/world.ts';
import type { AddressHit, AddressIndex } from '../game/address.ts';
import { addressPicker } from './addresspicker.ts';

export interface BigMapHost {
  world: World;
  lang(): string;
  /** the car: position and yaw (0 = north, positive = to the left) */
  car(): { x: number; z: number; yaw: number };
  path: DrivenPath;
  /** the place on a road next to a point of the map where the car could stand, or null */
  spotAt(x: number, z: number): SpawnJson | null;
  /** may the car be put somewhere else (a free drive)? */
  canTeleport(): boolean;
  teleport(spot: SpawnJson): void;
  /** the address list, for adding a place by its address */
  loadAddresses(): Promise<AddressIndex | null>;
  /** the place on the road in front of an address, or null */
  spotOf(hit: AddressHit): SpawnJson | null;
  /** a demonstration drive: the car drives by itself to these places, in this order */
  startDemo(stops: SpawnJson[]): void;
  /** latitude and longitude of a point of the map */
  latLon(x: number, z: number): [number, number];
  /** aerial photographs under the roads: has the player switched them on? (they come from a server of the land survey) */
  aerial(): boolean;
  setAerial(on: boolean): void;
  close(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** px per metre: the whole map on a phone … one house filling the screen */
const MIN_SCALE = 0.012;
const MAX_SCALE = 4;

/** How roads are drawn, by priority tier (see src/world/types.ts): colour, least width in px, from which zoom on. */
const CLASSES: Array<{ min: number; max: number; color: string; px: number; from: number }> = [
  { min: 0, max: 1.5, color: '#55606b', px: 0.8, from: 0.11 },
  { min: 2, max: 2.9, color: '#aab4bd', px: 1, from: 0.045 },
  { min: 3, max: 5.5, color: '#f1f3f5', px: 1.6, from: 0 },
  { min: 6, max: 9, color: '#f5b942', px: 2.4, from: 0 },
];

export class BigMap {
  private readonly host: BigMapHost;
  private node: HTMLElement | null = null;
  private canvas!: HTMLCanvasElement;
  private spotBar!: HTMLElement;
  private cx = 0;
  private cz = 0;
  private scale = 0.25;
  private showPath = true;
  private spot: SpawnJson | null = null;
  /** the places of a demonstration drive being planned (kept while the map is closed) */
  private readonly stops: SpawnJson[] = [];
  private planBox!: HTMLElement;
  private frame = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private moved = 0;
  private pinch = 0;
  private readonly photos = new AerialCache(() => this.redraw());
  private readonly onResize = (): void => this.redraw();
  private readonly onKey = (e: KeyboardEvent): void => this.key(e);

  constructor(host: BigMapHost) {
    this.host = host;
  }

  get isOpen(): boolean {
    return this.node !== null;
  }

  private t(key: string, params?: Record<string, string | number>): string {
    return tr(key, this.host.lang(), params);
  }

  /** `close`: a close-up of where the car is (for comparing the model with the aerial photograph). */
  open(parent: HTMLElement, close = false): void {
    if (this.node) return;
    const car = this.host.car();
    this.cx = car.x;
    this.cz = car.z;
    this.scale = close ? 1.6 : 0.22;
    this.spot = null;

    const o = el('div', 'overlay bigmap');
    this.canvas = el('canvas');
    this.canvas.tabIndex = 0;
    const top = el('div', 'bm-top');
    const title = el('div', 'bm-title');
    title.append(el('b', '', this.t('mapTitle')), el('small', '', this.t(this.host.canTeleport() ? 'mapHint' : 'mapHintLesson')));
    const tools = el('div', 'bm-tools');
    const button = (label: string, title2: string, fn: () => void, cls = ''): HTMLButtonElement => {
      const b = el('button', `btn ghost ${cls}`.trim(), label);
      b.type = 'button';
      b.title = title2;
      b.setAttribute('aria-label', title2);
      b.onclick = fn;
      return b;
    };
    tools.append(
      button('◎', this.t('mapCentre'), () => {
        const c = this.host.car();
        this.cx = c.x;
        this.cz = c.z;
        if (this.scale < 0.12) this.scale = 0.22;
        this.redraw();
      }),
      button('+', '+', () => this.zoom(1.6)),
      button('−', '−', () => this.zoom(1 / 1.6)),
      button('✕', this.t('realityClose'), () => this.host.close(), 'bm-close'),
    );
    top.append(title, tools);

    const bottom = el('div', 'bm-bottom');
    const pathToggle = el('label', 'bm-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = this.showPath;
    box.onchange = () => {
      this.showPath = box.checked;
      this.redraw();
    };
    const pathInfo = el('span');
    const describe = (): void => {
      const km = this.host.path.length() / 1000;
      pathInfo.textContent = km >= 0.05 ? `${this.t('mapPath')} (${formatUnit(km, 'kilometer', this.host.lang(), 1)})` : this.t('mapPath');
    };
    describe();
    pathToggle.append(box, pathInfo);
    const clear = button(this.t('mapClearPath'), this.t('mapClearPath'), () => {
      this.host.path.clear();
      describe();
      this.redraw();
    });
    // aerial photographs: ticking the box is the player's word that they may be fetched
    const aerialToggle = el('label', 'bm-check');
    const aerialBox = el('input');
    aerialBox.type = 'checkbox';
    aerialBox.checked = this.host.aerial();
    aerialBox.onchange = () => {
      this.host.setAerial(aerialBox.checked);
      this.redraw();
    };
    aerialToggle.append(aerialBox, el('span', '', this.t('mapAerial')));
    aerialToggle.title = AERIAL_SOURCE.name;
    bottom.append(aerialToggle, pathToggle, clear);
    // a demonstration drive is planned here: places by a tap on the map or by their address
    this.planBox = el('div', 'bm-plan');
    this.planBox.hidden = true;
    if (this.host.canTeleport()) {
      bottom.prepend(button(this.t('demo'), this.t('demo'), () => {
        this.planBox.hidden = !this.planBox.hidden;
        this.fillPlan();
      }, 'bm-demo'));
    }
    this.spotBar = el('div', 'bm-spot');
    this.spotBar.hidden = true;
    o.append(this.canvas, top, this.planBox, this.spotBar, bottom);
    parent.append(o);
    this.node = o;

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) this.moved = 0;
      this.pinch = 0;
    });
    c.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 1) {
        this.moved += Math.abs(dx) + Math.abs(dy);
        this.cx -= dx / this.scale;
        this.cz -= dy / this.scale;
      } else if (this.pointers.size === 2) {
        // two fingers: the distance between them is the zoom, their middle stays where it is
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch > 0 && d > 0) this.zoom(d / this.pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        this.pinch = d;
        this.moved += 100;
      }
      this.redraw();
    });
    const up = (e: PointerEvent): void => {
      if (!this.pointers.delete(e.pointerId)) return;
      this.pinch = 0;
      // a tap (not a drag): choose that place
      if (this.pointers.size === 0 && this.moved < 8 && e.type === 'pointerup') this.choose(e.clientX, e.clientY);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * 0.004), e.clientX, e.clientY);
      },
      { passive: false },
    );
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKey, true);
    // places chosen earlier and not driven to yet: go on planning where it was left
    if (this.stops.length > 0) this.plan();
    this.redraw();
    c.focus();
  }

  /** Open the panel for planning a demonstration drive (the map must be open). */
  plan(): void {
    if (!this.node || !this.host.canTeleport()) return;
    this.planBox.hidden = false;
    this.fillPlan();
  }

  private fillPlan(): void {
    const box = this.planBox;
    box.replaceChildren();
    if (box.hidden) return;
    box.append(el('b', '', this.t('demo')), el('small', '', this.t('demoHint')));
    const picker = addressPicker({
      placeholder: this.t('addressPlaceholder'),
      loading: this.t('realityLoading'),
      none: this.t('addressNone'),
      load: () => this.host.loadAddresses(),
      pick: (hit) => {
        const spot = this.host.spotOf(hit);
        if (!spot) return;
        this.stops.push(spot);
        this.cx = spot.x;
        this.cz = spot.z;
        if (this.scale < 0.5) this.scale = 0.5;
        picker.input.value = '';
        this.fillPlan();
        this.redraw();
      },
    });
    box.append(picker.node);
    if (this.stops.length === 0) box.append(el('small', 'bm-none', this.t('demoNone')));
    else {
      const list = el('ol');
      this.stops.forEach((stop, i) => {
        const li = el('li');
        const [lat, lon] = this.host.latLon(stop.x, stop.z);
        li.append(el('span', '', stop.name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`));
        const del = el('button', '', '✕');
        del.type = 'button';
        del.setAttribute('aria-label', `✕ ${i + 1}`);
        del.onclick = () => {
          this.stops.splice(i, 1);
          this.fillPlan();
          this.redraw();
        };
        li.append(del);
        list.append(li);
      });
      box.append(list);
    }
    const row = el('div', 'bm-row');
    const go = el('button', 'btn', this.t('demoStart'));
    go.type = 'button';
    go.disabled = this.stops.length === 0;
    go.onclick = () => {
      const stops = [...this.stops];
      this.stops.length = 0;
      this.host.startDemo(stops);
    };
    row.append(go);
    if (this.stops.length > 0) {
      const clear = el('button', 'btn ghost', this.t('demoClear'));
      clear.type = 'button';
      clear.onclick = () => {
        this.stops.length = 0;
        this.fillPlan();
        this.redraw();
      };
      row.append(clear);
    }
    box.append(row);
  }

  close(): void {
    if (!this.node) return;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKey, true);
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pointers.clear();
    this.node.remove();
    this.node = null;
  }

  private key(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') return;
    const step = 90 / this.scale;
    let used = true;
    if (e.code === 'ArrowLeft') this.cx -= step;
    else if (e.code === 'ArrowRight') this.cx += step;
    else if (e.code === 'ArrowUp') this.cz -= step;
    else if (e.code === 'ArrowDown') this.cz += step;
    else if (e.key === '+' || e.code === 'NumpadAdd' || e.key === '=') this.zoom(1.6);
    else if (e.key === '-' || e.code === 'NumpadSubtract') this.zoom(1 / 1.6);
    else used = false;
    if (used) {
      // the arrows move the map here, not the car
      e.preventDefault();
      e.stopPropagation();
      this.redraw();
    }
  }

  /** Zoom by a factor; the point of the screen under (px, py) keeps its place (default: the middle). */
  private zoom(factor: number, px?: number, py?: number): void {
    const r = this.canvas.getBoundingClientRect();
    const ox = (px ?? r.left + r.width / 2) - r.left - r.width / 2;
    const oy = (py ?? r.top + r.height / 2) - r.top - r.height / 2;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    // world point under the cursor before and after must be the same
    this.cx += ox / this.scale - ox / next;
    this.cz += oy / this.scale - oy / next;
    this.scale = next;
    this.redraw();
  }

  /** A tap at a point of the screen: the nearest place on a road. */
  private choose(px: number, py: number): void {
    const r = this.canvas.getBoundingClientRect();
    const x = this.cx + (px - r.left - r.width / 2) / this.scale;
    const z = this.cz + (py - r.top - r.height / 2) / this.scale;
    this.spot = this.host.spotAt(x, z);
    const bar = this.spotBar;
    bar.replaceChildren();
    bar.hidden = false;
    if (!this.spot) {
      bar.append(el('span', '', this.t('addressNoRoad')));
    } else {
      const spot = this.spot;
      const [lat, lon] = this.host.latLon(spot.x, spot.z);
      const text = el('div');
      text.append(el('b', '', spot.name || this.t('mapPlace')), el('small', '', `${lat.toFixed(5)}, ${lon.toFixed(5)}`));
      bar.append(text);
      if (this.host.canTeleport()) {
        const go = el('button', 'btn', this.t('mapTeleport'));
        go.type = 'button';
        go.onclick = () => this.host.teleport(spot);
        // … or have the car drive there by itself
        const add = el('button', 'btn ghost', this.t('demoAdd'));
        add.type = 'button';
        add.onclick = () => {
          this.stops.push(spot);
          this.spot = null;
          bar.hidden = true;
          this.planBox.hidden = false;
          this.fillPlan();
          this.redraw();
        };
        bar.append(go, add);
      }
    }
    this.redraw();
  }

  private redraw(): void {
    if (this.frame || !this.node) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const c = this.canvas;
    const g = c.getContext('2d');
    if (!g || !this.node) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const world = this.host.world;
    const m = world.json.meta;
    // do not lose the map: its middle stays within reach
    this.cx = Math.min(m.maxX, Math.max(m.minX, this.cx));
    this.cz = Math.min(m.maxZ, Math.max(m.minZ, this.cz));
    const s = this.scale;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#16202a';
    g.fillRect(0, 0, W, H);
    // world → screen
    g.translate(W / 2, H / 2);
    g.scale(s, s);
    g.translate(-this.cx, -this.cz);
    const minX = this.cx - W / 2 / s;
    const maxX = this.cx + W / 2 / s;
    const minZ = this.cz - H / 2 / s;
    const maxZ = this.cz + H / 2 / s;

    // the area the map covers
    g.fillStyle = '#1c2a36';
    g.fillRect(m.minX, m.minZ, m.maxX - m.minX, m.maxZ - m.minZ);

    // aerial photographs under the roads (only within the map, only what is in view)
    const aerial = this.host.aerial();
    if (aerial) {
      this.photos.beginFrame();
      const e0 = Math.max(minX, m.minX) + m.originE;
      const e1 = Math.min(maxX, m.maxX) + m.originE;
      const n0 = m.originN - Math.min(maxZ, m.maxZ);
      const n1 = m.originN - Math.max(minZ, m.minZ);
      if (e1 > e0 && n1 > n0) {
        let level = aerialLevel(s * dpr);
        // never more than a screenful of pictures at once
        while (level < 8 && ((e1 - e0) / aerialTileSize(level) + 1) * ((n1 - n0) / aerialTileSize(level) + 1) > 30) level++;
        // a coarse picture first (it is there at once), the fine ones on top as they arrive
        for (const l of level + 3 <= 8 ? [level + 3, level] : [8, level]) {
          for (const t of aerialTiles(l, e0, n0, e1, n1)) {
            const img = this.photos.get(t);
            if (img) g.drawImage(img, t.minE - m.originE, m.originN - (t.minN + t.size), t.size, t.size);
          }
          if (l === level) break;
        }
      }
    }

    g.lineCap = 'round';
    g.lineJoin = 'round';
    // over a photograph the roads are only hinted at
    g.globalAlpha = aerial ? 0.38 : 1;
    for (const cls of CLASSES) {
      if (s < cls.from) continue;
      g.strokeStyle = cls.color;
      // one path per width: roads of a class are drawn at their real width once that is more than the least
      const byWidth = new Map<number, Path2D>();
      world.edgesInBox(minX, minZ, maxX, maxZ, (e) => {
        if (e.tier < cls.min || e.tier > cls.max) return;
        const w = Math.max(cls.px / s, Math.round(e.width));
        let path = byWidth.get(w);
        if (!path) byWidth.set(w, (path = new Path2D()));
        const p = e.pl.pts;
        path.moveTo(p[0], p[2]);
        for (let i = 3; i < p.length; i += 3) path.lineTo(p[i], p[i + 2]);
      });
      for (const [w, path] of byWidth) {
        g.lineWidth = w;
        g.stroke(path);
      }
    }

    g.globalAlpha = 1;

    // where the car has been
    if (this.showPath) {
      const p = this.host.path.points;
      g.strokeStyle = '#38b6ff';
      g.lineWidth = Math.max(3 / s, 2.5);
      g.beginPath();
      let pen = false;
      for (let i = 0; i < p.length; i += 2) {
        if (Number.isNaN(p[i])) {
          pen = false;
          continue;
        }
        if (pen) g.lineTo(p[i], p[i + 1]);
        else g.moveTo(p[i], p[i + 1]);
        pen = true;
      }
      g.stroke();
    }

    // from here on in screen pixels
    const sx = (x: number): number => W / 2 + (x - this.cx) * s;
    const sy = (z: number): number => H / 2 + (z - this.cz) * s;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // names of towns and districts
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(12, 18, 24, 0.85)';
    const taken: Array<[number, number, number]> = [];
    const carX = sx(this.host.car().x);
    const carY = sy(this.host.car().z);
    const places = world.json.places
      .filter((p) => p.x > minX && p.x < maxX && p.z > minZ && p.z < maxZ)
      .sort((a, b) => rank(b.kind) - rank(a.kind));
    for (const p of places) {
      const r = rank(p.kind);
      if (r === 0 || (r === 1 && s < 0.05) || (r === 2 && s < 0.03)) continue;
      const size = r === 3 ? 17 : r === 2 ? 14 : 12;
      const x = sx(p.x);
      let y = sy(p.z);
      const half = (p.name.length * size * 0.3) + 6;
      // a name that would lie under the car's arrow is written below it
      if (Math.abs(x - carX) < half + 10 && Math.abs(y - carY) < size * 0.6 + 14) y = carY + 18 + size * 0.6;
      if (taken.some(([tx, ty, th]) => Math.abs(tx - x) < th + half && Math.abs(ty - y) < size + 4)) continue;
      taken.push([x, y, half]);
      g.font = `${r === 3 ? 700 : 600} ${size}px system-ui, sans-serif`;
      g.strokeText(p.name, x, y);
      g.fillStyle = r === 3 ? '#ffffff' : '#d5dde4';
      g.fillText(p.name, x, y);
    }

    // the places of a demonstration drive, numbered in their order
    this.stops.forEach((stop, i) => {
      const x = sx(stop.x);
      const y = sy(stop.z);
      g.fillStyle = '#38b6ff';
      g.strokeStyle = '#06131c';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, 11, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = '#06131c';
      g.font = '700 13px system-ui, sans-serif';
      g.fillText(String(i + 1), x, y + 0.5);
    });

    // the chosen place
    if (this.spot) {
      const x = sx(this.spot.x);
      const y = sy(this.spot.z);
      g.fillStyle = '#ff5252';
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y - 14, 8, Math.PI, 0);
      g.lineTo(x, y);
      g.closePath();
      g.fill();
      g.stroke();
    }

    // the car
    const car = this.host.car();
    g.save();
    g.translate(sx(car.x), sy(car.z));
    g.rotate(-car.yaw);
    g.fillStyle = '#ffcc00';
    g.strokeStyle = '#111';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -13);
    g.lineTo(8, 9);
    g.lineTo(0, 5);
    g.lineTo(-8, 9);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();

    // scale: a round number of metres that is about a fifth of the width
    const want = W / 5 / s;
    const pow = 10 ** Math.floor(Math.log10(want));
    const metres = (want / pow >= 5 ? 5 : want / pow >= 2 ? 2 : 1) * pow;
    const bar = metres * s;
    const bx = 14;
    const by = H - 62;
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(bx, by - 5);
    g.lineTo(bx, by);
    g.lineTo(bx + bar, by);
    g.lineTo(bx + bar, by - 5);
    g.stroke();
    g.fillStyle = '#fff';
    g.font = '600 12px system-ui, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    const lang = this.host.lang();
    g.fillText(metres >= 1000 ? formatUnit(metres / 1000, 'kilometer', lang) : formatUnit(metres, 'meter', lang), bx + 5, by - 4);
    if (aerial) {
      // whose pictures these are
      g.font = '11px system-ui, sans-serif';
      g.textBaseline = 'top';
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(12, 18, 24, 0.85)';
      g.strokeText(AERIAL_SOURCE.attribution, bx, by + 5);
      g.fillText(AERIAL_SOURCE.attribution, bx, by + 5);
    }
  }
}

/** How prominent a place is on the map. */
function rank(kind: string): number {
  return kind === 'city' || kind === 'town' ? 3 : kind === 'suburb' || kind === 'village' ? 2 : kind === 'quarter' || kind === 'neighbourhood' || kind === 'hamlet' ? 1 : 0;
}
