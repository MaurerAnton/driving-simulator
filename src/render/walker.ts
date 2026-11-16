// SPDX-License-Identifier: AGPL-3.0-only
/**
 * "The vehicle" of somebody on foot: there is none.  The game asks every
 * vehicle for a model with a root, an eye and mirrors; on foot the camera is
 * the person's eyes (game.ts), so this one is empty.
 */
import * as THREE from 'three';
import type { CarVisualState } from './car.ts';
import type { VehicleModel } from './fleet.ts';
import type { Mirror } from './mirrors.ts';

export class WalkerModel implements VehicleModel {
  readonly root = new THREE.Group();
  readonly eye = new THREE.Vector3(0, 1.62, 0);
  readonly mirrors: Mirror[] = [];

  constructor() {
    this.root.name = 'on foot';
  }

  setCabinOpacity(): void {
    /* nothing to see through */
  }

  update(_s: CarVisualState, _dt: number, _now: number): void {
    /* nothing moves */
  }
}
