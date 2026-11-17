// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The inside rear-view mirror where the player wants it.
 *
 * The settings (Settings.insideMirror) choose between two ways:
 *
 *  - "in the car": the real glass stays in the car, moved to the left or the
 *    right along the top of the windscreen as if on a rail, and larger or
 *    smaller – turned as it moves, so that it still shows straight back
 *    (render/mirrors.ts Mirror.place; the housing goes with it, the stem
 *    stays);
 *  - "in the HUD": the glass is taken out of the car (in the driver's seat)
 *    and its picture drawn into a frame of the HUD instead – the same
 *    picture, from the driver's eye reflected in the glass where it was
 *    built (render/mirrorzoom.ts).  The frame is dragged where it suits the
 *    player, its corner grip makes it larger or smaller; both are kept in
 *    this browser with the other settings.
 *
 * The frame costs one picture of the scene every other frame (each frame
 * with "all mirrors every frame"), at the frame's own size: no more than the
 * glass in the car, whose picture is then not drawn.
 */
import * as THREE from 'three';
import { tr } from '../i18n/index.ts';
import { saveSettings } from '../game/settings.ts';
import type { Settings } from '../game/settings.ts';
import { MirrorZoom } from '../render/mirrorzoom.ts';
import type { Mirror } from '../render/mirrors.ts';
import type { MirrorHost } from './mirrorzoom.ts';

/** What the game tells the mirror each frame. */
export interface HudMirrorView {
  /** the mirrors of the vehicle shown – null: none (the menu, a replay …) */
  mirrors: readonly Mirror[] | null;
  /** in the driver's seat (the HUD frame shows only there) */
  cockpit: boolean;
  /** the driver's eye in the world, and in the vehicle's coordinates */
  eye: THREE.Vector3;
  eyeLocal: THREE.Vector3 | null;
  /** how far the picture reaches (m) */
  far: number;
  /** draw the scene anew this frame (else the last picture is laid again) */
  refresh: boolean;
  lang: string;
}

/** the frame's width at size 1 (px of the HUD), and its shape (wider than the glass is not) */
const WIDTH = 230;
const ASPECT = 3.2;

export class HudMirror {
  private readonly zoom = new MirrorZoom();
  private readonly host: MirrorHost;
  private readonly ui: HTMLElement;
  private readonly settings: Settings;
  private readonly frameEl: HTMLElement;
  private readonly grip: HTMLElement;
  private readonly size = new THREE.Vector2();
  private lang = '';
  private placed = '';
  /** the inside mirror of the last frame, and whether its glass is shown in the car */
  private last: Mirror | null = null;
  private drag: { id: number; resize: boolean; x: number; y: number; fx: number; fy: number; w: number; moved: boolean } | null = null;

  constructor(ui: HTMLElement, host: MirrorHost, settings: Settings) {
    this.ui = ui;
    this.host = host;
    this.settings = settings;
    const hud = ui.querySelector<HTMLElement>('.hud') ?? ui;
    this.frameEl = document.createElement('div');
    this.frameEl.className = 'hudmirror';
    this.frameEl.hidden = true;
    this.grip = document.createElement('span');
    this.grip.className = 'hm-grip';
    this.frameEl.append(this.grip);
    hud.prepend(this.frameEl);
    this.frameEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const m = this.settings.insideMirror;
      const r = this.frameEl.getBoundingClientRect();
      this.drag = { id: e.pointerId, resize: e.target === this.grip, x: e.clientX, y: e.clientY, fx: m.fx, fy: m.fy, w: r.width, moved: false };
      try {
        this.frameEl.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer is gone already */
      }
    });
    this.frameEl.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      const m = this.settings.insideMirror;
      const c = this.host.canvas.getBoundingClientRect();
      if (d.resize) {
        // (the grip at the right-hand corner: the frame grows to the right as much as it is drawn)
        m.size = Math.max(0.6, Math.min(2, sizeOf(d.w + dx * 2, this.zoomNow())));
      } else {
        m.fx = Math.max(0, Math.min(1, d.fx + dx / Math.max(1, c.width)));
        m.fy = Math.max(0, Math.min(1, d.fy + dy / Math.max(1, c.height)));
      }
    });
    const up = (e: PointerEvent): void => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      if (d.moved) saveSettings(this.settings);
    };
    this.frameEl.addEventListener('pointerup', up);
    this.frameEl.addEventListener('pointercancel', up);
  }

  private zoomNow(): number {
    return Number.parseFloat(this.ui.style.getPropertyValue('zoom')) || 1;
  }

  /** Each frame, after the scene was drawn: the glass in the car where the settings put it – or its picture in the HUD. */
  frame(v: HudMirrorView): void {
    const inside = v.mirrors?.find((m) => m.spec.name === 'inside') ?? null;
    if (this.last && this.last !== inside) this.show(this.last, true);
    this.last = inside;
    const m = this.settings.insideMirror;
    const inHud = m.mode === 'hud' && this.settings.mirrors !== 'off';
    if (inside) {
      if (m.mode === 'car') inside.place(m.shift, m.size, v.eyeLocal);
      else inside.place(0, 1, null);
      this.show(inside, !(inHud && v.cockpit));
    }
    if (v.lang !== this.lang) {
      this.lang = v.lang;
      this.frameEl.title = tr('hudMirror.drag', v.lang);
      this.grip.title = tr('hudMirror.resize', v.lang);
      this.placed = '';
    }
    if (!inside || !inHud || !v.cockpit) {
      if (!this.frameEl.hidden) this.frameEl.hidden = true;
      return;
    }
    const { x: cw, y: ch } = this.host.renderer.getSize(this.size);
    const z = this.zoomNow();
    const w = Math.round(Math.min(cw * 0.9, WIDTH * m.size * z));
    const h = Math.round(w / ASPECT);
    const x = Math.round(Math.max(0, Math.min(cw - w, m.fx * cw - w / 2)));
    const y = Math.round(Math.max(0, Math.min(ch - h, m.fy * ch - h / 2)));
    const key = `${x},${y},${w},${h},${z}`;
    if (key !== this.placed) {
      this.placed = key;
      // (the HUD is drawn at the size of the interface: its pixels are the screen's divided by that)
      const st = this.frameEl.style;
      st.left = `${x / z - 3}px`;
      st.top = `${y / z - 3}px`;
      st.width = `${w / z}px`;
      st.height = `${h / z}px`;
    }
    const parent = inside.mesh.parent;
    const drawn = parent !== null && this.zoom.draw(this.host.renderer, this.host.scene, inside, parent.matrixWorld, v.eye, v.far, { x, y, w, h }, { minTan: 0, refresh: v.refresh });
    if (this.frameEl.hidden === drawn) this.frameEl.hidden = !drawn;
  }

  /** The glass and its housing in the car shown or not. */
  private show(mirror: Mirror, on: boolean): void {
    if (mirror.mesh.visible === on) return;
    mirror.mesh.visible = on;
    for (const o of mirror.attached) o.visible = on;
  }
}

/** The size setting a frame `w` px of the screen wide stands for. */
function sizeOf(w: number, zoom: number): number {
  return w / (WIDTH * zoom);
}
