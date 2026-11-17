// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Watching something on the map that is not a tram or a bus of the
 * timetables: a police car, an ambulance or a fire engine on its call, a
 * demonstration marching through the town, a site of roadworks.  The camera
 * goes with it and circles it as the player looks round; the world loads
 * round it; the player's own vehicle waits.  A bar at the top says what is
 * watched and leads back.  (Trams and buses: spectate.ts, with taking over.)
 */

import type * as THREE from 'three';
import type { Controls } from '../input/input.ts';
import type { PlayerState } from '../sim/traffic.ts';

/** What is watched: where it is now (null: gone), what it is called, how long it is. */
export interface WatchTarget {
  title: string;
  sub: string;
  get(): { x: number; y: number; z: number; yaw: number } | null;
  /** its length (m): the camera keeps back by it – a site or a crowd is looked at from further */
  length: number;
}

export interface PointWatchHost {
  hud(): HTMLElement | null;
  /** "Back to my vehicle", and the line said when it is gone */
  backText(): string;
  goneText(): string;
  ground(x: number, z: number): number;
  back(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export class PointWatcher {
  readonly at = { x: 0, y: 0, z: 0, yaw: 0 };
  /** the player that the traffic comes and goes round: where the thing watched is */
  readonly ghost: PlayerState = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, length: 0.2, width: 0.2 };
  private readonly target: WatchTarget;
  private readonly h: PointWatchHost;
  private gone = false;
  private camReady = false;
  private bar: HTMLElement | null = null;
  private sub: HTMLElement | null = null;

  constructor(target: WatchTarget, host: PointWatchHost) {
    this.target = target;
    this.h = host;
    this.update();
    this.showBar();
  }

  focus(): [number, number] {
    return [this.at.x, this.at.z];
  }

  private update(): void {
    const p = this.target.get();
    this.gone = !p;
    if (!p) return;
    this.at.x = p.x;
    this.at.y = Number.isFinite(p.y) ? p.y : this.h.ground(p.x, p.z);
    this.at.z = p.z;
    this.at.yaw = p.yaw;
    this.ghost.x = p.x;
    this.ghost.y = this.at.y + 60;
    this.ghost.z = p.z;
    this.ghost.yaw = p.yaw;
  }

  step(_dt: number, _c: Controls): void {
    this.update();
    if (this.sub) this.sub.textContent = this.gone ? this.h.goneText() : this.target.sub;
  }

  /** Behind and above it, turned and moved as the player looks round. */
  camera(cam: THREE.PerspectiveCamera, c: Controls, dt: number): void {
    const a = this.at;
    const yaw = a.yaw + c.lookYaw;
    const lift = Math.max(0.05, Math.min(1.45, 0.35 - c.lookPitch));
    const dist = Math.max(this.target.length / 2 + 8, Math.min(220, c.lookZoom * 1.7));
    let tx = a.x + Math.sin(yaw) * dist * Math.cos(lift);
    let ty = a.y + 1.8 + dist * Math.sin(lift);
    let tz = a.z + Math.cos(yaw) * dist * Math.cos(lift);
    const g = this.h.ground(tx, tz);
    if (Number.isFinite(g)) ty = Math.max(ty, g + 1.5);
    if (!this.camReady) {
      cam.position.set(tx, ty, tz);
      this.camReady = true;
    } else {
      const k = 1 - Math.exp(-dt * 5);
      tx = cam.position.x + (tx - cam.position.x) * k;
      ty = cam.position.y + (ty - cam.position.y) * k;
      tz = cam.position.z + (tz - cam.position.z) * k;
      cam.position.set(tx, ty, tz);
    }
    cam.near = 0.3;
    cam.fov = 55;
    cam.lookAt(a.x, a.y + 1.8, a.z);
    cam.updateProjectionMatrix();
  }

  /** The bar at the top: what is watched, and the way back. */
  private showBar(): void {
    const hud = this.h.hud();
    if (!hud || this.bar) return;
    const b = el('div', 'watchbar');
    const text = el('div', 'watch-text');
    this.sub = el('small', '', this.target.sub);
    text.append(el('b', '', this.target.title), this.sub);
    const back = el('button', 'btn ghost', this.h.backText());
    back.type = 'button';
    back.onclick = () => this.h.back();
    b.append(text, back);
    hud.append(b);
    hud.classList.add('watching');
    this.bar = b;
  }

  dispose(): void {
    this.bar?.remove();
    this.bar = null;
    this.h.hud()?.classList.remove('watching');
  }
}
