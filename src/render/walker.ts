// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Somebody on foot: "the vehicle" of the pedestrian, which is none, and the
 * player's own figure.
 *
 * The game asks every vehicle for a model with a root, an eye and mirrors; on
 * foot the camera is the person's eyes – or stands behind them – so the
 * pedestrian's vehicle model is empty.  The figure seen from behind is one of
 * the people of render/people.ts, always the same one, posed each frame in
 * the world's frame (not under a vehicle's root: the game's vehicle is only a
 * stand-in that follows the person).
 */
import * as THREE from 'three';
import type { CarVisualState } from './car.ts';
import type { VehicleModel } from './fleet.ts';
import type { Mirror } from './mirrors.ts';
import { PeopleRenderer } from './people.ts';
import type { PersonPose } from './people.ts';

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

/** The look of the player's figure (render/people.ts): a grown-up of 1.74 m in a blue jacket and jeans, hands free. */
export const PLAYER_LOOK = 27;

/** The player's own figure, for the times the camera is not their eyes. */
export class PlayerFigure {
  readonly group: THREE.Group;
  private readonly people = new PeopleRenderer(1);
  private readonly pose: PersonPose = { x: 0, y: 0, z: 0, yaw: 0, walk: -1, look: PLAYER_LOOK };
  private shown = false;

  constructor() {
    this.group = this.people.group;
    this.group.name = 'the player on foot';
    this.people.update([], 0);
  }

  /**
   * Standing at (x, y, z), facing `yaw` (0 north, + left); `walked`: the
   * metres walked so far (the gait follows them), `moving`: whether a step is
   * being taken.  `time`: seconds, for the small movements of standing.
   */
  show(x: number, y: number, z: number, yaw: number, walked: number, moving: boolean, time: number): void {
    const p = this.pose;
    p.x = x;
    p.y = y;
    p.z = z;
    p.yaw = yaw;
    p.walk = moving ? walked : -1;
    this.people.update([p], time);
    this.shown = true;
  }

  hide(): void {
    if (!this.shown) return;
    this.people.update([], 0);
    this.shown = false;
  }
}
