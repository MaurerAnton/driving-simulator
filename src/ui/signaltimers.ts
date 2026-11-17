// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The small timers over the traffic lights: above each head near the player
 * and in view, a half-transparent label with the seconds until its light
 * changes and a dot in the colour that comes next – one for each light the
 * head shows: a head with a green arrow beside it gets a second one for the
 * arrow.  On foot, the pedestrians' lights get theirs instead.
 *
 * A tap or click on a label switches its traffic lights on to their next
 * phase at once – through amber, red for all and red-amber as always, the
 * crossing streams kept apart (SignalSystem.skip).
 *
 * The labels are a handful of buttons, made once and used again, put in
 * place every frame by projecting the head into the picture.  The layer lies
 * under the rest of the interface: a pedal or a menu over a label wins.
 */
import * as THREE from 'three';
import { SIG } from '../sim/signals.ts';
import type { SignalChange, SignalSystem } from '../sim/signals.ts';
import type { Arm } from '../world/world.ts';

/** A head as the timers need it (render/actors.ts HeadSpot; world/pedlights.ts PedPole for the pedestrians' heads). */
export interface TimerHead {
  x: number;
  y: number;
  z: number;
  /** the way the head faces (0 = north, + = left) */
  yaw: number;
  controller: number;
  group: number;
  /** the green arrow that hangs beside it */
  arrow?: Arm | null;
}

/** heads further than this from the camera get no timer (m) */
const RANGE = 150;
/** at most this many heads at a time (the nearest) */
const MOST = 10;
/** where the label sits above the foot of a head: over a vehicles' head (3.25 m high), over a pedestrians' head (2.6 m) */
const ABOVE = 3.6;
const ABOVE_PED = 2.85;
/** the size a label takes, for keeping them apart (CSS pixels) */
const LABEL_W = 50;
const LABEL_H = 26;

interface Label {
  el: HTMLButtonElement;
  dot: HTMLElement;
  num: HTMLElement;
  text: string;
  dotClass: string;
  kind: string;
  controller: number;
}

const DOT: Record<number, string> = { [SIG.RED]: 'r', [SIG.RED_AMBER]: 'ra', [SIG.GREEN]: 'g', [SIG.AMBER]: 'a' };

/** "12", or "–" while a light waits for somebody to ask for it */
function seconds(c: SignalChange): string {
  if (!Number.isFinite(c.left)) return '–';
  return String(Math.max(0, Math.ceil(c.left - 0.05)));
}

export class SignalTimers {
  private readonly layer: HTMLDivElement;
  private readonly pool: Label[] = [];
  private shown = 0;
  private readonly v = new THREE.Vector3();
  private readonly near: Array<{ h: TimerHead; d: number; ped: boolean }> = [];
  private readonly placed: number[] = [];
  /** a tap on a label: the traffic lights it belongs to */
  onTap: (controller: number) => void = () => {};
  /** the label's tooltip (and what a screen reader says) */
  private hint = '';

  constructor(parent: HTMLElement) {
    this.layer = document.createElement('div');
    this.layer.className = 'sigtimes';
    // (first: under the interface that lies over the picture)
    parent.prepend(this.layer);
  }

  /** The tooltip of the labels (in the player's language). */
  setHint(text: string): void {
    if (text === this.hint) return;
    this.hint = text;
    for (const l of this.pool) {
      l.el.title = text;
      l.el.setAttribute('aria-label', text);
    }
  }

  /** No labels (another state of the game, a lesson, switched off in the settings). */
  hide(): void {
    for (let i = 0; i < this.shown; i++) this.pool[i].el.style.display = 'none';
    this.shown = 0;
  }

  private label(i: number): Label {
    let l = this.pool[i];
    if (l) return l;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'sigt';
    el.tabIndex = -1;
    const dot = document.createElement('i');
    const num = document.createElement('b');
    el.append(dot, num);
    el.title = this.hint;
    el.setAttribute('aria-label', this.hint);
    l = { el, dot, num, text: '', dotClass: '', kind: '', controller: -1 };
    const me = l;
    // (at once on the press: the label moves with the picture, a click might miss it on the way up)
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (me.controller >= 0) this.onTap(me.controller);
    });
    el.style.display = 'none';
    this.layer.append(el);
    this.pool.push(l);
    return l;
  }

  /**
   * Put the labels in place for this frame: the heads within reach of the
   * camera that face it, the nearest first, those that would cover one
   * already placed left out.  `peds`: the pedestrians' heads (on foot) –
   * then only those.  `zoom`: the interface's size (the layer is scaled with it).
   */
  update(camera: THREE.Camera, width: number, height: number, zoom: number, heads: readonly TimerHead[], peds: readonly TimerHead[] | null, signals: SignalSystem): void {
    const cam = camera.position;
    const near = this.near;
    near.length = 0;
    const consider = (list: readonly TimerHead[], ped: boolean): void => {
      for (const h of list) {
        const dx = cam.x - h.x;
        const dz = cam.z - h.z;
        if (Math.abs(dx) > RANGE || Math.abs(dz) > RANGE) continue;
        const d = Math.hypot(dx, dz);
        if (d > RANGE || signals.isDark(h.controller)) continue;
        // only heads one sees from the front (their lamps): the facing (−sin yaw, −cos yaw) towards the camera
        if (d > 3 && (-Math.sin(h.yaw) * dx - Math.cos(h.yaw) * dz) / d < 0.25) continue;
        near.push({ h, d, ped });
      }
    };
    if (peds) consider(peds, true);
    else consider(heads, false);
    near.sort((a, b) => a.d - b.d);
    const placed = this.placed;
    placed.length = 0;
    const w = width / zoom;
    const hgt = height / zoom;
    let used = 0;
    const put = (kind: string, controller: number, c: SignalChange | null, x: number, y: number): void => {
      if (!c) return;
      // (kept apart: one that would cover a nearer one is left out)
      for (let k = 0; k < placed.length; k += 2) if (Math.abs(placed[k] - x) < LABEL_W && Math.abs(placed[k + 1] - y) < LABEL_H) return;
      placed.push(x, y);
      const l = this.label(used++);
      l.controller = controller;
      const text = seconds(c);
      if (text !== l.text) {
        l.text = text;
        l.num.textContent = text;
      }
      const dot = c.next < 0 ? 'off' : (DOT[c.next] ?? 'off');
      if (dot !== l.dotClass) {
        l.dotClass = dot;
        l.dot.className = dot;
      }
      if (kind !== l.kind) {
        l.kind = kind;
        l.el.className = `sigt ${kind}`;
      }
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      l.el.style.display = '';
    };
    for (let i = 0; i < near.length && i < MOST; i++) {
      const { h, ped } = near[i];
      this.v.set(h.x, h.y + (ped ? ABOVE_PED : ABOVE), h.z).project(camera);
      if (this.v.z > 1 || this.v.x < -1.05 || this.v.x > 1.05 || this.v.y < -1.05 || this.v.y > 1.05) continue;
      const x = ((this.v.x + 1) / 2) * w;
      const y = ((1 - this.v.y) / 2) * hgt;
      if (ped) {
        put('ped', h.controller, signals.pedestrianChange(h.controller, h.group), x, y);
        continue;
      }
      const arrow = h.arrow ? signals.arrowChange(h.arrow) : null;
      // with an arrow beside it: the two side by side, the arrow's on the side it hangs (the driver's right)
      put('main', h.controller, signals.change(h.controller, h.group), arrow ? x - LABEL_W * 0.52 : x, y);
      if (arrow) put('arrow', h.controller, arrow, x + LABEL_W * 0.52, y);
    }
    for (let i = used; i < this.shown; i++) this.pool[i].el.style.display = 'none';
    this.shown = used;
  }
}
