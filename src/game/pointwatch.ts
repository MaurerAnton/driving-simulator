// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Watching something on the map that is not a tram or a bus of the
 * timetables: a police car, an ambulance or a fire engine on its call, a
 * demonstration marching through the town, a site of roadworks.  The camera
 * goes with it and circles it as the player looks round; the world loads
 * round it; the player's own vehicle waits.  A bar at the top says what is
 * watched and leads back.  (Trams and buses of the timetables: spectate.ts.)
 *
 * A vehicle (any car of the traffic, a bus, an emergency vehicle, a tram –
 * game/takeover.ts) can be taken over: "Take over" in the bar, or touching a
 * driving control, which asks first – the player then drives it from where
 * it is (the game does that: `WatchTarget.take`).
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
  /** a vehicle that can be taken over: the game begins a drive of it from where it is (unset: it cannot) */
  take?: () => void;
}

export interface PointWatchHost {
  hud(): HTMLElement | null;
  /** the whole interface (the question whether to take it over goes there) and the texts */
  ui: HTMLElement;
  t(key: string, p?: Record<string, string | number>): string;
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
  private dialog: HTMLElement | null = null;
  /** the controls as they were when watching began (and after "keep watching"): a change is a touch */
  private base: { handbrake: number; gear: number } | null = null;
  /** a control must have been let go before touching one asks again */
  private armed = false;

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

  step(_dt: number, c: Controls): void {
    this.update();
    if (this.sub) this.sub.textContent = this.gone ? this.h.goneText() : this.subText();
    if (!this.target.take || this.gone) return;
    // touching a driving control asks whether to take it over (as with a tram or a bus: spectate.ts)
    this.base ??= { handbrake: c.handbrake, gear: c.gear };
    const touched = c.throttle > 0.25 || c.brake > 0.25 || Math.abs(c.steer) > 0.4 || Math.abs(c.handbrake - this.base.handbrake) > 0.5 || c.gear !== this.base.gear;
    const idle = c.throttle < 0.08 && c.brake < 0.08 && Math.abs(c.steer) < 0.15;
    if (!this.dialog) {
      if (touched && this.armed) this.ask();
      else if (idle) this.armed = true;
    }
  }

  private subText(): string {
    const s = this.target.sub;
    return this.target.take ? [s, this.h.t('watchHint')].filter(Boolean).join(' · ') : s;
  }

  /** "Drive this vehicle yourself?" */
  private ask(): void {
    if (this.dialog || !this.target.take) return;
    this.armed = false;
    const o = el('div', 'overlay watchask');
    const p = el('div', 'panel narrow');
    p.append(el('h1', '', this.h.t('watchAskVehicle')), el('p', '', this.h.t('watchAskVehicleSub', { what: this.target.title })));
    const row = el('div', 'buttons');
    const yes = el('button', 'btn', this.h.t('watchYes'));
    yes.type = 'button';
    yes.onclick = () => {
      this.closeDialog();
      if (!this.gone) this.target.take?.();
    };
    const no = el('button', 'btn ghost', this.h.t('watchNo'));
    no.type = 'button';
    no.onclick = () => {
      this.closeDialog();
      this.h.back();
    };
    const keep = el('button', 'btn ghost', this.h.t('watchKeep'));
    keep.type = 'button';
    keep.onclick = () => {
      this.closeDialog();
      // (what the controls are now counts as untouched)
      this.base = null;
    };
    row.append(yes, no, keep);
    p.append(row);
    o.append(p);
    this.h.ui.append(o);
    this.dialog = o;
    yes.focus();
  }

  private closeDialog(): void {
    this.dialog?.remove();
    this.dialog = null;
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
    this.sub = el('small', '', this.subText());
    text.append(el('b', '', this.target.title), this.sub);
    if (this.target.take) {
      const take = el('button', 'btn', this.h.t('watchTake'));
      take.type = 'button';
      take.onclick = (e) => {
        e.stopPropagation();
        if (!this.gone) this.target.take?.();
      };
      b.append(text, take);
    } else b.append(text);
    const back = el('button', 'btn ghost', this.h.backText());
    back.type = 'button';
    back.onclick = () => this.h.back();
    b.append(back);
    hud.append(b);
    hud.classList.add('watching');
    this.bar = b;
  }

  dispose(): void {
    this.closeDialog();
    this.bar?.remove();
    this.bar = null;
    this.h.hud()?.classList.remove('watching');
  }
}
