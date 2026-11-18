// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the basic tasks of class B (game/drills.ts) put on the practice yard
 * besides its asphalt, lines and cones (drawn by render/yard.ts): the
 * parked cars of the gap and of the bays, kerb stones along the kerbs, and
 * the sloping sides of the ramp for the hill start.  A few boxes sharing
 * their geometries – cheap on a phone.
 */
import * as THREE from 'three';
import type { YardFrame } from '../game/ce.ts';
import type { DrillLayout } from '../game/drills.ts';

const BODY_COLOURS = [0x8a1c1c, 0x2c4f7c, 0xb9bcbf, 0x2f3a2f, 0xd9d4c4];
const BODIES = BODY_COLOURS.map((c) => new THREE.MeshLambertMaterial({ color: c }));
const GLASS = new THREE.MeshLambertMaterial({ color: 0x1f2a33 });
const TYRE = new THREE.MeshLambertMaterial({ color: 0x151515 });
const KERB = new THREE.MeshLambertMaterial({ color: 0xb4b2ac });
const BANK = new THREE.MeshLambertMaterial({ color: 0x8d9093 });

const bodyGeo = new THREE.BoxGeometry(1.8, 0.72, 4.3);
const cabinGeo = new THREE.BoxGeometry(1.6, 0.55, 2.2);
const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.2, 12);
wheelGeo.rotateZ(Math.PI / 2);
const kerbGeo = new THREE.BoxGeometry(1, 0.14, 0.2);

export class DrillScene {
  readonly group = new THREE.Group();
  private readonly made: THREE.BufferGeometry[] = [];

  constructor() {
    this.group.name = 'basic tasks';
    this.group.visible = false;
  }

  /** Lay out what a task has; `heightAt`: the ground with the ramp (NaN where not loaded – false then: call again). */
  show(frame: YardFrame, layout: DrillLayout, heightAt: (x: number, z: number) => number): boolean {
    this.hide();
    const g = this.group;
    let complete = true;
    const y = (u: number, w: number): number => {
      const [x, z] = frame.toWorld(u, w);
      const h = heightAt(x, z);
      if (Number.isNaN(h)) {
        complete = false;
        return 0;
      }
      return h;
    };

    // the parked cars: a body, a cabin, four wheels
    layout.parked.forEach((b, i) => {
      const car = new THREE.Group();
      const [x, z] = frame.toWorld(b.x, b.z);
      car.position.set(x, y(b.x, b.z) + 0.05, z);
      car.rotation.y = frame.yawToWorld(b.yaw);
      const body = new THREE.Mesh(bodyGeo, BODIES[i % BODIES.length]);
      body.position.y = 0.3 + 0.36;
      body.castShadow = true;
      const cabin = new THREE.Mesh(cabinGeo, GLASS);
      cabin.position.set(0, 0.3 + 0.72 + 0.27, 0.25);
      car.add(body, cabin);
      for (const [wx, wz] of [
        [-0.78, -1.35],
        [0.78, -1.35],
        [-0.78, 1.3],
        [0.78, 1.3],
      ]) {
        const wheel = new THREE.Mesh(wheelGeo, TYRE);
        wheel.position.set(wx, 0.32, wz);
        car.add(wheel);
      }
      g.add(car);
    });

    // kerb stones, in pieces of at most 4 m following the ground
    for (const [u0, w0, u1, w1] of layout.kerbs) {
      const len = Math.hypot(u1 - u0, w1 - w0);
      const n = Math.max(1, Math.ceil(len / 4));
      const [ax, az] = frame.toWorld(u0, w0);
      const [bx, bz] = frame.toWorld(u1, w1);
      const turn = Math.atan2(-(bz - az), bx - ax);
      for (let i = 0; i < n; i++) {
        const u = u0 + ((u1 - u0) * (i + 0.5)) / n;
        const w = w0 + ((w1 - w0) * (i + 0.5)) / n;
        const [x, z] = frame.toWorld(u, w);
        const stone = new THREE.Mesh(kerbGeo, KERB);
        stone.scale.x = len / n;
        stone.position.set(x, y(u, w) + 0.07, z);
        stone.rotation.y = turn;
        stone.receiveShadow = true;
        g.add(stone);
      }
    }

    // the ramp's sides: from the edge of its deck down to the ground
    const h = layout.hill;
    if (h) {
      for (const [edge, toe] of [
        [h.w1, h.w1 + h.side],
        [h.w0, h.w0 - h.side],
      ]) {
        const us: number[] = [];
        for (let u = h.u0; u < h.u3 - 1e-6; u += 2.5) us.push(u);
        us.push(h.u3);
        const pos = new Float32Array(us.length * 2 * 3);
        us.forEach((u, i) => {
          for (const [k, w] of [
            [0, edge],
            [1, toe],
          ]) {
            const [x, z] = frame.toWorld(u, w);
            const o = (i * 2 + k) * 3;
            pos[o] = x;
            pos[o + 1] = y(u, w) + 0.05;
            pos[o + 2] = z;
          }
        });
        const index: number[] = [];
        for (let i = 0; i + 1 < us.length; i++) {
          const a = i * 2;
          index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setIndex(index);
        geo.computeVertexNormals();
        // (whichever way the yard is turned, the slope must face up)
        let up = 0;
        const nrm = geo.getAttribute('normal');
        for (let i = 0; i < nrm.count; i++) up += nrm.getY(i);
        if (up < 0) {
          geo.setIndex(index.map((_, k) => index[k - (k % 3) + [0, 2, 1][k % 3]]));
          geo.computeVertexNormals();
        }
        this.made.push(geo);
        const mesh = new THREE.Mesh(geo, BANK);
        mesh.receiveShadow = true;
        g.add(mesh);
      }
    }
    g.visible = true;
    return complete;
  }

  hide(): void {
    this.group.visible = false;
    this.group.clear();
    for (const geo of this.made) geo.dispose();
    this.made.length = 0;
  }
}
