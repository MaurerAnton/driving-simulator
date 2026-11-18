// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Any vehicle can be watched and taken over.
 *
 * A tap on a vehicle in the 3D picture chooses it: a car of the traffic, a
 * city bus, a police car, an ambulance, a fire engine, the emergency doctor's
 * car, a tram or a train – the camera then goes with it (game/pointwatch.ts),
 * and touching a driving control (or "Take over") lets the player drive it
 * from where it is.  On the test place ("Every model") a tap on one of the
 * models standing there gets the player into it.
 *
 * The game has no vehicle of its own for each kind of the traffic: a car of
 * the traffic, the police car and the doctor's car are taken over as the
 * car, the ambulance as the van (class C1), the fire engine as the rigid
 * lorry, the city bus as the bus (on its line's way, where it runs one) –
 * `takeKindOf`.
 *
 * A tap is a pointer let go soon and near where it came down; it is tested
 * against the vehicles' boxes along one ray, only when it happens (no cost
 * otherwise), and only while the game says a vehicle may be chosen
 * (`boxes` returns null when not).
 */

import type * as THREE from 'three';
import { Raycaster, Vector2 } from 'three';
import { EM, emKind } from '../sim/emergency.ts';
import { BUS_STYLE } from '../sim/traffic.ts';
import { rayBox } from './spawnplace.ts';
import type { StandingBox } from './spawnplace.ts';
import type { VehicleKind } from './vehicles.ts';

/** The kind of the game's vehicles a vehicle of the traffic (by its style) is driven as when taken over. */
export function takeKindOf(style: number): VehicleKind {
  if (style === BUS_STYLE) return 'bus';
  const em = emKind(style);
  if (em === EM.AMBULANCE) return 'lightTruck';
  if (em === EM.FIRE) return 'truckSolo';
  return 'car';
}

/** What a tap chose: a car of the traffic (buses and emergency vehicles too) by its id, a tram or train by its id, a model of the test place by its number. */
export type PickTarget = { kind: 'car'; id: number } | { kind: 'rail'; id: number } | { kind: 'show'; i: number };

/** A vehicle's box (as it stands) and what it is. */
export interface PickBox extends StandingBox {
  what: PickTarget;
}

/** The nearest box along a ray (from o along d) within `reach` metres; null: none. */
export function pickAlong(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, boxes: readonly PickBox[], reach = 400): PickTarget | null {
  let best: PickTarget | null = null;
  let bt = reach;
  for (const b of boxes) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, b);
    if (t >= 0 && t < bt) {
      bt = t;
      best = b.what;
    }
  }
  return best;
}

/** a tap: let go within this time (ms) and this distance (px) of where it came down */
const TAP_MS = 450;
const TAP_PX = 12;

/** Taps on the 3D picture that choose a vehicle. */
export class TapPicker {
  private readonly down = { id: -1, x: 0, y: 0, t: 0 };
  private readonly ray = new Raycaster();
  private readonly ndc = new Vector2();

  /**
   * `boxes`: the vehicles that may be chosen now (null: none may – a tap
   * does nothing); `pick`: one was tapped.
   */
  constructor(canvas: HTMLCanvasElement, camera: THREE.Camera, boxes: () => readonly PickBox[] | null, pick: (t: PickTarget) => void) {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      Object.assign(this.down, { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() });
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      if (e.pointerId !== d.id) return;
      d.id = -1;
      if (performance.now() - d.t > TAP_MS || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_PX) return;
      const list = boxes();
      if (!list || list.length === 0) return;
      const r = canvas.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.ray.setFromCamera(this.ndc, camera);
      const o = this.ray.ray.origin;
      const v = this.ray.ray.direction;
      const t = pickAlong(o.x, o.y, o.z, v.x, v.y, v.z, list);
      if (t) pick(t);
    });
  }
}
