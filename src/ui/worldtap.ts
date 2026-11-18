// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A tap (or a click) on a place in the 3D picture: a small button "Teleport
 * here" shows beside it for a few seconds – tapped, the player is put there
 * (game.ts teleportTo: a vehicle into the lane of the nearest road, facing
 * along it; somebody on foot at that very place).  With "tap to walk"
 * (game/walkmodes.ts) the walker also sets off there.
 *
 * Only a tap counts: let go soon and near where it came down, with one
 * finger (or the left mouse button) – a drag that looks round, a pinch, the
 * on-screen controls and the rest of the HUD (which are not the picture)
 * never show it.  Nor does a tap that is somebody else's: on the vehicle's
 * screen, on a parked car, while a place for a car is being picked
 * (`claimed`).  Where the tap meets the ground is found along the ray
 * through the terrain's heights (game/spawnplace.ts rayGround); nothing is
 * looked for while nothing is tapped.  The button follows its place while
 * the camera moves, and goes after a few seconds, at the next tap, or when
 * teleporting is not possible any more.
 */
import * as THREE from 'three';
import { rayGround } from '../game/spawnplace.ts';

/** a tap: let go within this time (ms) and this distance (px) of where it came down */
const TAP_MS = 450;
const TAP_PX = 10;
/** how long the button stays (ms) */
const SHOW_MS = 4500;

export interface WorldTapHost {
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  /** where the button goes (the game's #ui element) */
  ui: HTMLElement;
  /** the terrain's height (NaN: not loaded) */
  heightAt(x: number, z: number): number;
  /** may the player be teleported now? */
  allowed(): boolean;
  /** is a tap there somebody else's – checked when the finger comes down (`down`) and when it is let go */
  claimed(cx: number, cy: number, down: boolean): boolean;
  /** a place on the ground was tapped (tap to walk – also where teleporting is not allowed) */
  tapped(p: { x: number; y: number; z: number }): void;
  /** teleport there; `yaw`: the way the camera looked (which way a lane is chosen) */
  teleport(p: { x: number; y: number; z: number }, yaw: number): void;
  t(key: string): string;
}

export class WorldTap {
  private readonly host: WorldTapHost;
  private readonly button: HTMLButtonElement;
  private readonly ring: HTMLElement;
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly v = new THREE.Vector3();
  /** the fingers (or the mouse) down on the picture now, and whether more than one was down in this touch */
  private readonly downs = new Map<number, { x: number; y: number; t: number; claimed: boolean }>();
  private multi = false;
  /** the place offered, and until when */
  private at: { x: number; y: number; z: number; yaw: number } | null = null;
  private until = 0;

  constructor(host: WorldTapHost) {
    this.host = host;
    const b = (this.button = document.createElement('button'));
    b.type = 'button';
    b.className = 'world-tap';
    Object.assign(b.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transform: 'translate(-50%, calc(-100% - 14px))',
      minHeight: '44px',
      padding: '0 14px',
      borderRadius: '22px',
      border: '1px solid rgba(255,255,255,0.75)',
      background: 'rgba(16,24,34,0.86)',
      color: '#fff',
      font: 'inherit',
      fontSize: '14px',
      fontWeight: '600',
      whiteSpace: 'nowrap',
      display: 'none',
      alignItems: 'center',
      gap: '6px',
      zIndex: '7',
      pointerEvents: 'auto',
      touchAction: 'manipulation',
      boxShadow: '0 2px 10px rgba(0,0,0,0.45)',
    } satisfies Partial<CSSStyleDeclaration>);
    b.onpointerdown = (e) => e.stopPropagation();
    b.onclick = (e) => {
      e.stopPropagation();
      const at = this.at;
      this.hide();
      if (at && this.host.allowed()) this.host.teleport({ x: at.x, y: at.y, z: at.z }, at.yaw);
    };
    const r = (this.ring = document.createElement('div'));
    Object.assign(r.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '16px',
      height: '16px',
      margin: '-8px 0 0 -8px',
      borderRadius: '50%',
      border: '2px solid #fff',
      boxShadow: '0 0 0 2px rgba(0,0,0,0.35)',
      display: 'none',
      zIndex: '7',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    host.ui.append(r, b);
    const c = host.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this.downs.size > 0) this.multi = true;
      else this.multi = false;
      this.downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), claimed: host.claimed(e.clientX, e.clientY, true) });
      // (another tap elsewhere: the button offered before goes)
      if (this.at) this.hide();
    });
    const up = (e: PointerEvent, cancel: boolean): void => {
      const d = this.downs.get(e.pointerId);
      if (!d) return;
      this.downs.delete(e.pointerId);
      if (cancel || this.multi || d.claimed) return;
      if (performance.now() - d.t > TAP_MS || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_PX) return;
      this.tap(e.clientX, e.clientY);
    };
    window.addEventListener('pointerup', (e) => up(e, false));
    window.addEventListener('pointercancel', (e) => up(e, true));
  }

  private tap(cx: number, cy: number): void {
    const h = this.host;
    if (h.claimed(cx, cy, false)) return;
    const r = h.canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, h.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    const g = rayGround(o.x, o.y, o.z, d.x, d.y, d.z, (x, z) => h.heightAt(x, z), 2500);
    if (!g) return;
    h.tapped(g);
    if (!h.allowed()) return;
    this.at = { ...g, yaw: Math.atan2(-d.x, -d.z) };
    this.until = performance.now() + SHOW_MS;
    const label = h.t('teleportHere');
    this.button.textContent = `⤓ ${label}`;
    this.button.title = label;
    this.button.setAttribute('aria-label', label);
    this.frame();
  }

  hide(): void {
    this.at = null;
    this.button.style.display = 'none';
    this.ring.style.display = 'none';
  }

  /** Every picture: the button where its place is now on the screen – or gone. */
  frame(): void {
    const at = this.at;
    if (!at) return;
    const h = this.host;
    if (performance.now() > this.until || !h.allowed()) {
      this.hide();
      return;
    }
    const p = this.v.set(at.x, at.y, at.z).project(h.camera);
    // (behind the camera, or off the picture: not shown until it is back)
    const off = p.z > 1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05;
    const r = h.canvas.getBoundingClientRect();
    const u = h.ui.getBoundingClientRect();
    const sx = r.left - u.left + ((p.x + 1) / 2) * r.width;
    const sy = r.top - u.top + ((1 - p.y) / 2) * r.height;
    // (kept within the picture, clear of its edges)
    const bx = Math.max(90, Math.min(u.width - 90, sx));
    const by = Math.max(70, sy);
    this.button.style.display = off ? 'none' : 'flex';
    this.ring.style.display = off ? 'none' : 'block';
    this.button.style.left = `${bx}px`;
    this.button.style.top = `${by}px`;
    this.ring.style.left = `${sx}px`;
    this.ring.style.top = `${sy}px`;
  }
}
