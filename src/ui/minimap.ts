// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The round map in the corner of the screen (drawn by hud.ts drawMap):
 *
 *  - the aerial photographs of the land survey under its roads, as on the
 *    big map (src/reality/aerial.ts; on unless the settings say otherwise) –
 *    also on the car's centre display, whose picture is a texture: the
 *    survey's server sends its pictures for any page (CORS), so the canvas
 *    stays clean;
 *  - dragging it looks round: its middle moves away from the vehicle, and
 *    comes back to it a few seconds after the finger has let go – or at once
 *    with the button that appears meanwhile.  A plain tap does what it did
 *    (the real photographs of the place; its lower button the big map);
 *  - dragging its rim moves the whole map to another place on the screen,
 *    which is kept (one place for the keyboard layout, one for the touch
 *    layout of the HUD); a double tap on the rim puts it back.
 */
import { AerialCache, aerialLevel, aerialTiles } from '../reality/aerial.ts';

const KEY = 'fahrsim-baunatal.minimap.v1';
/** how long after looking round the map comes back to the vehicle (ms) */
const BACK_AFTER = 6000;

export interface MiniMapHost {
  /** the label of the button that brings the map back to the vehicle */
  backLabel(): string;
  /** the label of the rim (how to move the map) */
  moveLabel(): string;
  /** may the aerial photographs be fetched? */
  photos(): boolean;
  /** where the map lies in the survey's coordinates (world x = east − originE, z = originN − north) and what it covers */
  meta: { originE: number; originN: number; minX: number; maxX: number; minZ: number; maxZ: number };
}

interface Place {
  fx: number;
  fy: number;
}

function loadPlaces(): Record<string, Place> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Place>;
    return typeof v === 'object' && v ? v : {};
  } catch {
    return {};
  }
}

export class MiniMap {
  private readonly host: MiniMapHost;
  private readonly box: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  /** looking round: how far the middle is from the vehicle (metres east, south) */
  private ox = 0;
  private oz = 0;
  private lookedAt = -1e9;
  private lastCentre = 0;
  /** the heading and scale of the last picture of the corner map: a drag is turned into metres by them */
  private yaw = 0;
  private scale = 0.42;
  private readonly photosCache = new AerialCache(() => {}, 48);
  private readonly backBtn: HTMLButtonElement;
  private drag: { id: number; move: boolean; x: number; y: number; moved: number; left: number; top: number } | null = null;
  private eatClick = false;
  private layout = '';
  private places: Record<string, Place> = loadPlaces();
  private lastRimTap = 0;

  constructor(box: HTMLElement, canvas: HTMLCanvasElement, host: MiniMapHost) {
    this.box = box;
    this.canvas = canvas;
    this.host = host;
    box.classList.add('mini');
    box.style.touchAction = 'none';
    // (what a tap does, and that the rim moves it)
    box.title = [box.title, host.moveLabel()].filter(Boolean).join(' · ');
    this.backBtn = document.createElement('button');
    this.backBtn.type = 'button';
    this.backBtn.className = 'mini-back';
    this.backBtn.hidden = true;
    this.backBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="12" r="6.6" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    this.backBtn.onclick = (e) => {
      e.stopPropagation();
      this.ox = this.oz = 0;
      this.backBtn.hidden = true;
    };
    box.append(this.backBtn);
    box.addEventListener('pointerdown', this.down);
    box.addEventListener('pointermove', this.move);
    box.addEventListener('pointerup', this.up);
    box.addEventListener('pointercancel', this.up);
    // a drag is no tap: the click after it is swallowed before the map's own handler sees it
    box.addEventListener(
      'click',
      (e) => {
        if (!this.eatClick) return;
        this.eatClick = false;
        e.stopPropagation();
        e.preventDefault();
      },
      true,
    );
    window.addEventListener('resize', () => this.applyPlace());
  }

  /** Which layout of the HUD the map is in (it has a place of its own in each). */
  private layoutNow(): string {
    return this.box.closest('.hud')?.classList.contains('touchmode') ? 'touch' : 'keys';
  }

  private applyPlace(): void {
    const p = this.places[this.layout];
    const s = this.box.style;
    if (!p) {
      s.left = s.top = s.right = s.bottom = '';
      return;
    }
    const [W, H] = this.room();
    this.putAt(p.fx * W, p.fy * H);
  }

  /** The room the map has (its box, the HUD), in the HUD's own pixels (the interface may be zoomed: settings uiScale). */
  private room(): [number, number] {
    const parent = this.box.offsetParent as HTMLElement | null;
    return [parent?.clientWidth ?? window.innerWidth, parent?.clientHeight ?? window.innerHeight];
  }

  /** How many of the HUD's own pixels a pixel of the screen is. */
  private ratio(): number {
    return this.box.offsetWidth / Math.max(1, this.box.getBoundingClientRect().width);
  }

  /** Put the map's upper left corner here (the HUD's pixels), within the screen. */
  private putAt(left: number, top: number): void {
    const [W, H] = this.room();
    const s = this.box.style;
    s.left = `${Math.round(Math.max(0, Math.min(W - this.box.offsetWidth, left)))}px`;
    s.top = `${Math.round(Math.max(0, Math.min(H - this.box.offsetHeight, top)))}px`;
    s.right = s.bottom = 'auto';
  }

  private onRim(e: PointerEvent): boolean {
    const r = this.box.getBoundingClientRect();
    const R = r.width / 2;
    const d = Math.hypot(e.clientX - (r.left + R), e.clientY - (r.top + r.height / 2));
    return d > R - Math.max(13, R * 0.2);
  }

  private readonly down = (e: PointerEvent): void => {
    this.eatClick = false;
    // (the buttons on the map keep their own taps)
    if (e.target instanceof Element && e.target.closest('button')) return;
    const move = this.onRim(e);
    if (move) {
      // a double tap on the rim: back to where the map belongs
      const now = performance.now();
      if (now - this.lastRimTap < 350) {
        delete this.places[this.layout];
        this.save();
        this.applyPlace();
        this.lastRimTap = 0;
        return;
      }
      this.lastRimTap = now;
    }
    this.drag = { id: e.pointerId, move, x: e.clientX, y: e.clientY, moved: 0, left: this.box.offsetLeft, top: this.box.offsetTop };
    this.box.setPointerCapture(e.pointerId);
  };

  private readonly move = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.move) {
      d.moved = Math.max(d.moved, Math.hypot(dx, dy));
      if (d.moved < 4) return;
      const k = this.ratio();
      this.putAt(d.left + dx * k, d.top + dy * k);
      return;
    }
    d.x = e.clientX;
    d.y = e.clientY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    if (d.moved < 6) return;
    // the finger moves the map under it: its middle goes the other way, turned back into the directions of the world
    const k = this.canvas.width / Math.max(1, this.canvas.getBoundingClientRect().width) / this.scale;
    const c = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    this.ox -= (dx * c + dy * sn) * k;
    this.oz -= (-dx * sn + dy * c) * k;
    // (not further than the map shows twice over)
    const far = 1200;
    const l = Math.hypot(this.ox, this.oz);
    if (l > far) {
      this.ox *= far / l;
      this.oz *= far / l;
    }
    this.lookedAt = performance.now();
    this.backBtn.hidden = false;
  };

  private readonly up = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    if (d.moved >= 6) this.eatClick = true;
    if (d.move && d.moved >= 4) {
      const [W, H] = this.room();
      this.places[this.layout] = { fx: this.box.offsetLeft / Math.max(1, W), fy: this.box.offsetTop / Math.max(1, H) };
      this.save();
    } else if (d.move) {
      // (a tap on the rim is a tap on the map)
      this.eatClick = false;
    }
    if (!d.move && d.moved >= 6) this.lookedAt = performance.now();
  };

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.places));
    } catch {
      /* (a browser that keeps nothing: the place holds until the page is left) */
    }
  }

  /**
   * The middle of the map for a picture: the vehicle at (x, z) – or, while
   * the player looks round, where the map was dragged to (it drifts back to
   * the vehicle a while after).  `own`: the picture is the corner map's
   * (its heading and scale turn drags into metres).
   */
  centre(x: number, z: number, yaw: number, scale: number, own: boolean): [number, number] {
    const now = performance.now();
    const dt = Math.min(0.5, (now - this.lastCentre) / 1000);
    this.lastCentre = now;
    if (own) {
      this.yaw = yaw;
      this.scale = scale;
      const layout = this.layoutNow();
      if (layout !== this.layout) {
        this.layout = layout;
        this.applyPlace();
      }
    }
    if ((this.ox !== 0 || this.oz !== 0) && !this.drag && now - this.lookedAt > BACK_AFTER) {
      const k = Math.exp(-dt * 3);
      this.ox *= k;
      this.oz *= k;
      if (Math.hypot(this.ox, this.oz) < 1) {
        this.ox = this.oz = 0;
        this.backBtn.hidden = true;
      }
    }
    this.backBtn.title = this.host.backLabel();
    this.backBtn.setAttribute('aria-label', this.backBtn.title);
    return [x + this.ox, z + this.oz];
  }

  /**
   * The aerial photographs round (cx, cz) within `range` metres, drawn into
   * the map's world coordinates (the transform of the roads) at `pxPerMetre`
   * – if the settings allow them.  True when they are drawn (the roads over
   * them are then only hinted at).
   */
  photos(g: CanvasRenderingContext2D, cx: number, cz: number, range: number, pxPerMetre: number): boolean {
    if (!this.host.photos()) return false;
    const m = this.host.meta;
    const e0 = Math.max(cx - range, m.minX) + m.originE;
    const e1 = Math.min(cx + range, m.maxX) + m.originE;
    const n0 = m.originN - Math.min(cz + range, m.maxZ);
    const n1 = m.originN - Math.max(cz - range, m.minZ);
    if (e1 <= e0 || n1 <= n0) return false;
    this.photosCache.beginFrame();
    const level = aerialLevel(pxPerMetre);
    let any = false;
    // a coarse picture first (there at once when the vehicle moves on), the fine ones over it
    for (const l of level + 2 <= 8 ? [level + 2, level] : [level]) {
      for (const t of aerialTiles(l, e0, n0, e1, n1)) {
        const img = this.photosCache.get(t);
        if (!img) continue;
        g.drawImage(img, t.minE - m.originE, m.originN - (t.minN + t.size), t.size, t.size);
        any = true;
      }
    }
    return any;
  }
}
