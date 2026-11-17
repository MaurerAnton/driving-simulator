// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Looking into a mirror: one of the vehicle's mirrors shown large over the
 * upper half of the picture – to see the kerb, the line of a parking bay or
 * the edge of the garage door while reversing.
 *
 * The mirror key ([[KeyY]]), the round mirror button of the on-screen
 * controls and a tap on the panel itself go round the mirrors the vehicle
 * has (left → right → inside → off, game/cockpit.ts); a tap on a mirror in
 * the driver's seat shows that one, the × puts it away.  It works from the
 * driver's seat and from the camera behind the vehicle (the picture is the
 * one the driver sees in the glass), in the car, the truck, the bus, the
 * tractor and on the motorcycle.
 *
 * The panel is a frame of the HUD with nothing in it: the picture is drawn
 * into the canvas underneath, in the same place (render/mirrorzoom.ts).
 */
import * as THREE from 'three';
import { tr } from '../i18n/index.ts';
import type { Input } from '../input/input.ts';
import { MirrorLook, mirrorAt, zoomAspect, zoomPanel } from '../game/cockpit.ts';
import type { MirrorOnScreen } from '../game/cockpit.ts';
import { MirrorZoom } from '../render/mirrorzoom.ts';
import type { Mirror } from '../render/mirrors.ts';

/** What the game tells the panel each frame. */
export interface MirrorView {
  /** the vehicle's mirrors, when the view lets one be looked into – null: it does not (on foot, a menu, the free camera …) */
  mirrors: readonly Mirror[] | null;
  /** seen from the driver's seat (a tap on a mirror then shows it) */
  cockpit: boolean;
  /** the driver's eye in the world */
  eye: THREE.Vector3;
  /** how far the picture reaches (m) */
  far: number;
  lang: string;
}

/** The parts of the game's rendering the panel draws with. */
export interface MirrorHost {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  readonly canvas: HTMLCanvasElement;
}

const TEXT: Record<string, string> = { left: 'mirrorLeft', right: 'mirrorRight', inside: 'mirrorInside' };
const ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="11" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 14.5 12.5 8.5M11 14.5l4-4.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12 17v3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
/** a tap: a pointer let go within this time (ms) and this distance (px) of where it came down */
const TAP_MS = 450;
const TAP_PX = 12;

export class MirrorZoomPanel {
  private readonly look = new MirrorLook();
  private readonly zoom = new MirrorZoom();
  private readonly host: MirrorHost;
  private readonly ui: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly frameEl: HTMLElement;
  private readonly label: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly button: HTMLButtonElement;
  /** the mirrors offered in the last frame (for the key, the buttons and a tap between two frames) */
  private mirrors: readonly Mirror[] = [];
  private cockpit = false;
  private lang = '';
  /** where the frame was put last (written again only when it moves) */
  private placed = '';
  private readonly down = { id: -1, x: 0, y: 0, t: 0 };
  private readonly v = new THREE.Vector3();
  private readonly size = new THREE.Vector2();

  constructor(ui: HTMLElement, input: Input, host: MirrorHost) {
    this.ui = ui;
    this.host = host;
    // in the HUD (hidden with it), below its other parts: the street-name block stays readable over the panel
    this.hud = ui.querySelector<HTMLElement>('.hud') ?? ui;
    this.frameEl = document.createElement('div');
    this.frameEl.className = 'mirrorzoom';
    this.frameEl.hidden = true;
    this.label = document.createElement('span');
    this.label.className = 'mz-label';
    this.closeBtn = document.createElement('button');
    this.closeBtn.type = 'button';
    this.closeBtn.className = 'mz-close';
    this.closeBtn.textContent = '✕';
    this.frameEl.append(this.label, this.closeBtn);
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'mirrorbtn';
    this.button.innerHTML = ICON;
    this.button.hidden = true;
    this.hud.prepend(this.frameEl, this.button);
    // (the buttons answer at once, on the finger's touch – and take it, so that it turns no view)
    const press = (e: Event, f: () => void): void => {
      e.preventDefault();
      e.stopPropagation();
      f();
    };
    this.button.addEventListener('pointerdown', (e) => press(e, () => this.next()));
    this.closeBtn.addEventListener('pointerdown', (e) => press(e, () => this.look.close()));
    this.frameEl.addEventListener('pointerdown', (e) => press(e, () => this.next()));
    input.onAction((a) => {
      if (a === 'mirror') this.next();
    });
    // a tap on a mirror in the driver's seat
    const canvas = host.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      Object.assign(this.down, { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() });
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      if (e.pointerId !== d.id) return;
      d.id = -1;
      if (performance.now() - d.t > TAP_MS || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_PX) return;
      this.tap(e.clientX, e.clientY);
    });
  }

  /** The mirror key, the button, a tap on the panel: the next mirror (after the last: none). */
  private next(): void {
    this.look.next(this.mirrors.map((m) => m.spec.name));
  }

  /** A tap on the picture at (x, y) (px of the window): a mirror there is shown large – or put away. */
  private tap(x: number, y: number): void {
    if (!this.cockpit || this.mirrors.length === 0) return;
    const cam = this.host.camera;
    const r = this.host.canvas.getBoundingClientRect();
    const boxes: MirrorOnScreen[] = [];
    for (const m of this.mirrors) {
      const pos = m.mesh.geometry.getAttribute('position');
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let behind = false;
      for (let i = 0; i < pos.count; i++) {
        const p = this.v.fromBufferAttribute(pos, i).applyMatrix4(m.mesh.matrixWorld).project(cam);
        if (p.z > 1 || p.z < -1) behind = true;
        const sx = r.left + ((p.x + 1) / 2) * r.width;
        const sy = r.top + ((1 - p.y) / 2) * r.height;
        x0 = Math.min(x0, sx);
        x1 = Math.max(x1, sx);
        y0 = Math.min(y0, sy);
        y1 = Math.max(y1, sy);
      }
      if (behind) continue;
      const distance = this.v.setFromMatrixPosition(m.mesh.matrixWorld).distanceTo(cam.getWorldPosition(new THREE.Vector3()));
      boxes.push({ name: m.spec.name, x0, y0, x1, y1, distance });
    }
    const name = mirrorAt(x, y, boxes, 26);
    if (name) this.look.pick(name, this.mirrors.map((m) => m.spec.name));
  }

  /** Each frame, after the scene was drawn: the button, the panel and the picture in it. */
  frame(v: MirrorView): void {
    const list = v.mirrors && v.mirrors.length > 0 ? v.mirrors : null;
    this.mirrors = list ?? [];
    this.cockpit = !!list && v.cockpit;
    if (v.lang !== this.lang) {
      this.lang = v.lang;
      this.button.title = tr('mirrorLook', v.lang);
      this.button.setAttribute('aria-label', this.button.title);
      this.closeBtn.title = tr('mirrorClose', v.lang);
      this.closeBtn.setAttribute('aria-label', this.closeBtn.title);
      this.frameEl.title = tr('mirrorNext', v.lang);
      this.placed = '';
    }
    const names = this.mirrors.map((m) => m.spec.name);
    if (list) this.look.keep(names);
    else this.look.close();
    if (this.button.hidden !== !list) this.button.hidden = !list;
    const shown = this.look.shown;
    this.button.classList.toggle('on', shown !== null);
    const mirror = shown !== null ? this.mirrors.find((m) => m.spec.name === shown) : undefined;
    if (!mirror) {
      if (!this.frameEl.hidden) this.frameEl.hidden = true;
      return;
    }
    // the panel: as large as the upper half of the picture allows, below the "⋯" of the on-screen controls
    // (the canvas's size as the renderer has it: no look at the page's layout each frame)
    const { x: cw, y: ch } = this.host.renderer.getSize(this.size);
    const z = Number.parseFloat(this.ui.style.getPropertyValue('zoom')) || 1;
    const touch = this.hud.classList.contains('touchmode');
    const rect = zoomPanel(cw, ch, zoomAspect(mirror.spec.width, mirror.spec.height), (touch ? 52 : 10) * z);
    const key = `${rect.x},${rect.y},${rect.w},${rect.h},${z},${shown},${this.lang}`;
    if (key !== this.placed) {
      this.placed = key;
      // (the HUD is drawn at the size of the interface: its pixels are the screen's divided by that)
      const st = this.frameEl.style;
      st.left = `${rect.x / z - 3}px`;
      st.top = `${rect.y / z - 3}px`;
      st.width = `${rect.w / z}px`;
      st.height = `${rect.h / z}px`;
      this.label.textContent = tr(TEXT[shown!] ?? 'mirrorLook', this.lang);
    }
    const parent = mirror.mesh.parent;
    const drawn = parent !== null && this.zoom.draw(this.host.renderer, this.host.scene, mirror, parent.matrixWorld, v.eye, v.far, rect);
    if (this.frameEl.hidden === drawn) this.frameEl.hidden = !drawn;
  }
}
