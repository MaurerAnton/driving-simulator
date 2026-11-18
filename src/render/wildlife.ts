// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The deer and wild boar that cross the country roads at dusk
 * (sim/wildlife.ts), drawn with the models of render/animals.ts – a few at
 * a time, the models kept for the next group.
 */
import * as THREE from 'three';
import type { WildAnimal } from '../sim/wildlife.ts';
import { AnimalModel } from './animals.ts';
import type { AnimalKind } from './animals.ts';

export class WildView {
  readonly group = new THREE.Group();
  private shown: AnimalModel[] = [];
  private readonly spare = new Map<AnimalKind, AnimalModel[]>();

  constructor() {
    this.group.name = 'wildlife';
  }

  /** Show exactly these animals (each frame). */
  update(animals: readonly WildAnimal[]): void {
    // (the models in the order of the animals: kept while the same kinds come)
    for (let i = 0; i < Math.max(animals.length, this.shown.length); i++) {
      const a = animals[i];
      let m = this.shown[i];
      if (m && (!a || m.kind !== a.kind)) {
        this.group.remove(m.group);
        const list = this.spare.get(m.kind) ?? [];
        list.push(m);
        this.spare.set(m.kind, list);
        m = undefined as unknown as AnimalModel;
      }
      if (!a) continue;
      if (!m) {
        m = this.spare.get(a.kind)?.pop() ?? new AnimalModel(a.kind);
        this.group.add(m.group);
      }
      this.shown[i] = m;
      const known = !Number.isNaN(a.y);
      m.group.visible = known;
      if (!known) continue;
      m.group.position.set(a.x, a.y, a.z);
      m.group.rotation.y = a.yaw;
      m.pose(a.dist, a.speed);
    }
    this.shown.length = animals.length;
  }
}
