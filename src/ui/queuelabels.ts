// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The small labels over the queues in the traffic: over the last car of a
 * queue near the player and in view, a half-transparent label with how long
 * the queue is, how many cars stand in it and – where that can be told –
 * about how long the last one waits (src/sim/queues.ts measures them).
 *
 * As the timers over the traffic lights (ui/signaltimers.ts): a handful of
 * elements, made once and used again, put in place every frame by
 * projecting the end of the queue into the picture.  The queues themselves
 * are measured a few times a second only.  The labels take no pointer: the
 * picture under them is still turned and tapped as before.
 */
import * as THREE from 'three';
import { formatUnit, tr } from '../i18n/index.ts';
import type { Lang } from '../i18n/index.ts';
import { QueueMeter } from '../sim/queues.ts';
import type { Queue } from '../sim/queues.ts';
import type { SignalSystem } from '../sim/signals.ts';
import type { TrafficCar } from '../sim/traffic.ts';

/** queues whose end is further than this from the camera get no label (m) */
const RANGE = 300;
/** at most this many labels at a time (the nearest) */
const MOST = 6;
/** how high over the road the label sits above the last car (m) */
const ABOVE = 2.6;
/** seconds between two measurements of the queues */
const EVERY = 0.3;
/** the size a label takes, for keeping them apart (CSS pixels) */
const LABEL_W = 120;
const LABEL_H = 22;

interface Label {
  el: HTMLDivElement;
  text: string;
}

export class QueueLabels {
  private readonly layer: HTMLDivElement;
  private readonly pool: Label[] = [];
  private shown = 0;
  private readonly meter = new QueueMeter();
  private queues: Queue[] = [];
  private last = -Infinity;
  private readonly v = new THREE.Vector3();
  private readonly near: Array<{ q: Queue; d: number }> = [];
  private readonly placed: number[] = [];

  constructor(parent: HTMLElement) {
    this.layer = document.createElement('div');
    this.layer.className = 'queuelabels';
    this.layer.setAttribute('aria-hidden', 'true');
    this.layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
    // (first: under the interface that lies over the picture)
    parent.prepend(this.layer);
  }

  /** No labels (another state of the game, a lesson or a test, switched off in the settings). */
  hide(): void {
    for (let i = 0; i < this.shown; i++) this.pool[i].el.style.display = 'none';
    this.shown = 0;
    this.last = -Infinity;
  }

  private label(i: number): Label {
    let l = this.pool[i];
    if (l) return l;
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;left:0;top:0;padding:2px 8px;border:1px solid rgba(255,255,255,0.35);border-radius:11px;background:rgba(10,16,24,0.4);color:#fff;' +
      'font:600 12px/16px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums;text-shadow:0 0 2px #000;white-space:nowrap;pointer-events:none;will-change:transform;display:none';
    this.layer.append(el);
    l = { el, text: '' };
    this.pool.push(l);
    return l;
  }

  /** What a label says: "120 m · 18 cars · about 45 s". */
  static text(q: Queue, lang: Lang): string {
    const parts = [formatUnit(Math.max(5, Math.round(q.length / 5) * 5), 'meter', lang), tr('queueCars', lang, { n: q.cars })];
    if (Number.isFinite(q.wait)) {
      const s = Math.max(1, Math.round(q.wait / 5) * 5);
      parts.push(s < 100 ? tr('queueWait', lang, { s }) : tr('queueWaitMin', lang, { n: Math.round(s / 60) }));
    }
    return parts.join(' · ');
  }

  /**
   * Put the labels in place for this frame: the queues whose end is within
   * reach of the camera and in front of it, the nearest first, those that
   * would cover one already placed left out.  `zoom`: the interface's size
   * (the layer is scaled with it).
   */
  update(camera: THREE.Camera, width: number, height: number, zoom: number, cars: readonly TrafficCar[], signals: SignalSystem | null, lang: Lang): void {
    const now = performance.now() / 1000;
    if (now - this.last > EVERY) {
      this.last = now;
      this.queues = this.meter.measure(cars, signals, this.queues);
    }
    const cam = camera.position;
    const near = this.near;
    near.length = 0;
    for (const q of this.queues) {
      const t = q.tail;
      // (a car that has left the traffic since)
      if (!cars.includes(t)) continue;
      const d = Math.hypot(t.x - cam.x, t.z - cam.z);
      if (d <= RANGE) near.push({ q, d });
    }
    near.sort((a, b) => a.d - b.d);
    const placed = this.placed;
    placed.length = 0;
    const w = width / zoom;
    const h = height / zoom;
    let used = 0;
    for (let i = 0; i < near.length && used < MOST; i++) {
      const { q } = near[i];
      const t = q.tail;
      this.v.set(t.x, t.y + ABOVE, t.z).project(camera);
      if (this.v.z > 1 || this.v.x < -1.05 || this.v.x > 1.05 || this.v.y < -1.05 || this.v.y > 1.05) continue;
      const x = ((this.v.x + 1) / 2) * w;
      const y = ((1 - this.v.y) / 2) * h;
      let covered = false;
      for (let k = 0; k < placed.length; k += 2) if (Math.abs(placed[k] - x) < LABEL_W && Math.abs(placed[k + 1] - y) < LABEL_H) covered = true;
      if (covered) continue;
      placed.push(x, y);
      const l = this.label(used++);
      const text = QueueLabels.text(q, lang);
      if (text !== l.text) {
        l.text = text;
        l.el.textContent = text;
      }
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      l.el.style.display = '';
    }
    for (let i = used; i < this.shown; i++) this.pool[i].el.style.display = 'none';
    this.shown = used;
  }
}
