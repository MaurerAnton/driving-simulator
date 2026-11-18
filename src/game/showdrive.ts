// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The test place ("Every model", game.ts buildShowroom): every model of the
 * game stands on the practice yard – and each can be driven.  A tap on one
 * (game/takeover.ts), or the door key pressed on foot beside it, gets the
 * player into it: the drive on the test place goes on with that vehicle,
 * from where it stood (the model standing there is hidden meanwhile; the
 * others stay).
 *
 * Here: where each model stands and what it is, which one is being driven,
 * and the boxes a tap is tested against.
 */

import type * as THREE from 'three';
import type { PickBox } from './takeover.ts';
import type { Outline } from './spawnplace.ts';
import type { VehicleKind } from './vehicles.ts';

/** A model standing on the test place. */
export interface ShowSpot {
  kind: VehicleKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  outline: Outline;
  height: number;
  /** what draws it (the vehicle, its trailer) */
  roots: THREE.Object3D[];
}

export class ShowSpots {
  readonly list: ShowSpot[] = [];
  /** the one being driven (−1: none) – hidden while it is */
  taken = -1;
  /** the one just chosen: where the next drive on the test place begins (once) */
  private next: ShowSpot | null = null;
  private readonly boxList: PickBox[] = [];

  add(s: ShowSpot): void {
    this.list.push(s);
    this.boxList.length = 0;
  }

  /** Get into model `i`: the next drive on the test place begins where it stands. */
  choose(i: number): ShowSpot | null {
    const s = this.list[i];
    if (!s) return null;
    this.next = s;
    return s;
  }

  /**
   * A drive on the test place begins: where (the model chosen – null: the
   * usual place); the model chosen is hidden, the others are shown again.
   */
  start(): ShowSpot | null {
    const s = this.next;
    this.next = null;
    this.taken = s ? this.list.indexOf(s) : -1;
    this.list.forEach((q, i) => {
      for (const r of q.roots) r.visible = i !== this.taken;
    });
    return s;
  }

  /** The model somebody on foot at (x, z) stands beside (within `reach` metres of its outline) – not the one being driven; −1: none. */
  near(x: number, z: number, reach = 1.6): number {
    let best = -1;
    let bd = Infinity;
    this.list.forEach((p, i) => {
      if (i === this.taken) return;
      const dx = x - p.x;
      const dz = z - p.z;
      const along = -dx * Math.sin(p.yaw) - dz * Math.cos(p.yaw);
      const side = dx * Math.cos(p.yaw) - dz * Math.sin(p.yaw);
      if (along <= p.outline.front + reach && along >= -p.outline.rear - reach && Math.abs(side) <= p.outline.hw + reach) {
        const d = Math.hypot(dx, dz);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
    });
    return best;
  }

  /** The boxes of the models a tap may choose (not the one being driven). */
  boxes(): readonly PickBox[] {
    if (this.boxList.length !== this.list.length) {
      this.boxList.length = 0;
      this.list.forEach((s, i) => this.boxList.push({ x: s.x, y: s.y, z: s.z, yaw: s.yaw, height: s.height, ...s.outline, what: { kind: 'show', i } }));
    }
    return this.taken < 0 ? this.boxList : this.boxList.filter((b) => b.what.kind !== 'show' || b.what.i !== this.taken);
  }
}
