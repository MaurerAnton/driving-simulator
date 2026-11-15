// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The practice yard of the truck lessons: asphalt, boundary lines, cones, a
 * loading ramp and the place to end up in – laid over the field the map
 * build chose (tools/mapgen/yard.ts) for as long as such a lesson runs.
 * Nothing of the map is changed: the yard is a few meshes following the
 * ground.
 */
import * as THREE from 'three';
import type { TaskLayout, YardFrame } from '../game/ce.ts';

const ASPHALT = new THREE.MeshLambertMaterial({ color: 0x3b3e42, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
const PAINT = new THREE.MeshBasicMaterial({ color: 0xf2f2ee, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -12 });
const GOAL = new THREE.MeshBasicMaterial({ color: 0x38d06a, transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -18 });
const CONE = new THREE.MeshLambertMaterial({ color: 0xf06a12 });
const CONE_BAND = new THREE.MeshLambertMaterial({ color: 0xf4f4f0 });
const CONCRETE = new THREE.MeshLambertMaterial({ color: 0x9a9d9f });
const BUFFER = new THREE.MeshLambertMaterial({ color: 0x1b1c1e });

export class YardScene {
  readonly group = new THREE.Group();
  private readonly made: Array<THREE.BufferGeometry> = [];

  constructor() {
    this.group.name = 'practice yard';
    this.group.visible = false;
  }

  /**
   * Lay a task out.  `heightAt` is the ground of the map (NaN where it is
   * not loaded yet – call again when it is).  Returns false in that case.
   */
  show(frame: YardFrame, layout: TaskLayout, heightAt: (x: number, z: number) => number): boolean {
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
    /** a strip of ground between two lines of points, draped over the terrain */
    const drape = (u0: number, w0: number, u1: number, w1: number, lift: number, material: THREE.Material, cell = 2.5): void => {
      const nu = Math.max(1, Math.ceil(Math.abs(u1 - u0) / cell));
      const nw = Math.max(1, Math.ceil(Math.abs(w1 - w0) / cell));
      const pos = new Float32Array((nu + 1) * (nw + 1) * 3);
      for (let j = 0; j <= nw; j++) {
        for (let i = 0; i <= nu; i++) {
          const u = u0 + ((u1 - u0) * i) / nu;
          const w = w0 + ((w1 - w0) * j) / nw;
          const [x, z] = frame.toWorld(u, w);
          const k = (j * (nu + 1) + i) * 3;
          pos[k] = x;
          pos[k + 1] = y(u, w) + lift;
          pos[k + 2] = z;
        }
      }
      const index: number[] = [];
      for (let j = 0; j < nw; j++) {
        for (let i = 0; i < nu; i++) {
          const a = j * (nu + 1) + i;
          const b = a + 1;
          const c = a + nu + 1;
          const d = c + 1;
          index.push(a, c, b, b, c, d);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setIndex(index);
      geo.computeVertexNormals();
      // (whichever way the yard is turned, the ground must face up)
      const n = geo.getAttribute('normal');
      if (n.getY(0) < 0) {
        geo.setIndex(index.map((_, k) => index[k - (k % 3) + [0, 2, 1][k % 3]]));
        geo.computeVertexNormals();
      }
      this.made.push(geo);
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = material === ASPHALT;
      g.add(mesh);
    };

    /** any flat piece given by its corner points (u, w) and triangles, draped over the terrain */
    const patch = (points: number[], index: number[], lift: number, material: THREE.Material): void => {
      const pos = new Float32Array((points.length / 2) * 3);
      for (let i = 0; i < points.length; i += 2) {
        const [x, z] = frame.toWorld(points[i], points[i + 1]);
        pos[(i / 2) * 3] = x;
        pos[(i / 2) * 3 + 1] = y(points[i], points[i + 1]) + lift;
        pos[(i / 2) * 3 + 2] = z;
      }
      // (whichever way the points run, the ground must face up)
      const a = [pos[index[0] * 3], pos[index[0] * 3 + 2]];
      const b = [pos[index[1] * 3], pos[index[1] * 3 + 2]];
      const c = [pos[index[2] * 3], pos[index[2] * 3 + 2]];
      const up = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]) > 0;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setIndex(up ? index : index.map((_, k) => index[k - (k % 3) + [0, 2, 1][k % 3]]));
      geo.computeVertexNormals();
      this.made.push(geo);
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = material === ASPHALT;
      g.add(mesh);
    };
    /** a painted line from one point to another, in any direction */
    const line = (u0: number, w0: number, u1: number, w1: number, width: number): void => {
      const len = Math.hypot(u1 - u0, w1 - w0);
      const n = Math.max(1, Math.ceil(len / 2.5));
      const nu = (-(w1 - w0) / len) * (width / 2);
      const nw = ((u1 - u0) / len) * (width / 2);
      const points: number[] = [];
      const index: number[] = [];
      for (let i = 0; i <= n; i++) {
        const u = u0 + ((u1 - u0) * i) / n;
        const w = w0 + ((w1 - w0) * i) / n;
        points.push(u + nu, w + nw, u - nu, w - nw);
        if (i < n) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 2, i * 2 + 1, i * 2 + 3);
      }
      patch(points, index, 0.07, PAINT);
    };

    // the paved areas, a little wider than what the vehicles may use
    for (const r of layout.allowed) drape(r.u0 - 1.2, r.w0 - 1.2, r.u1 + 1.2, r.w1 + 1.2, 0.05, ASPHALT);
    // the cut-off corners of a junction: triangles, in rows of small ones
    for (const c of layout.chamfers) {
      const pad = 1.2;
      const su = Math.sign(c.du);
      const sw = Math.sign(c.dw);
      // (as far beyond the cut as the asphalt of the roads reaches beyond their lines)
      const lu = Math.abs(c.du) + pad * 1.45;
      const lw = Math.abs(c.dw) + pad * 1.45;
      const n = 4;
      const points: number[] = [];
      const at: number[][] = [];
      for (let i = 0; i <= n; i++) {
        at.push([]);
        for (let j = 0; j <= n - i; j++) {
          at[i].push(points.length / 2);
          points.push(c.u + su * ((lu * i) / n), c.w + sw * ((lw * j) / n));
        }
      }
      const index: number[] = [];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n - i; j++) {
          index.push(at[i][j], at[i + 1][j], at[i][j + 1]);
          if (j < n - i - 1) index.push(at[i + 1][j], at[i + 1][j + 1], at[i][j + 1]);
        }
      }
      patch(points, index, 0.05, ASPHALT);
    }
    // boundary lines: 15 cm of white paint
    for (const [u0, w0, u1, w1] of layout.lines) line(u0, w0, u1, w1, 0.15);
    // where to end up
    if (layout.goalMarked) drape(layout.goal.u0, layout.goal.w0, layout.goal.u1, layout.goal.w1, 0.09, GOAL);

    // cones: orange with a white band
    const coneGeo = new THREE.ConeGeometry(0.17, 0.55, 10);
    const bandGeo = new THREE.CylinderGeometry(0.105, 0.135, 0.12, 10);
    const baseGeo = new THREE.BoxGeometry(0.4, 0.04, 0.4);
    this.made.push(coneGeo, bandGeo, baseGeo);
    for (const [u, w] of layout.cones) {
      const [x, z] = frame.toWorld(u, w);
      const h = y(u, w) + 0.05;
      const cone = new THREE.Mesh(coneGeo, CONE);
      cone.position.set(x, h + 0.3, z);
      cone.castShadow = true;
      const band = new THREE.Mesh(bandGeo, CONE_BAND);
      band.position.set(x, h + 0.3, z);
      const base = new THREE.Mesh(baseGeo, CONE);
      base.position.set(x, h + 0.02, z);
      g.add(cone, band, base);
    }

    // the loading ramp: a concrete block with a rubber buffer along its edge
    if (layout.ramp) {
      const r = layout.ramp;
      const [x, z] = frame.toWorld((r.u0 + r.u1) / 2, (r.w0 + r.w1) / 2);
      const h = Math.min(y(r.u0, r.w0), y(r.u1, r.w0), y(r.u0, r.w1), y(r.u1, r.w1));
      const turned = frame.yard.rot === 1;
      const blockGeo = new THREE.BoxGeometry(turned ? r.w1 - r.w0 : r.u1 - r.u0, r.h + 1, turned ? r.u1 - r.u0 : r.w1 - r.w0);
      this.made.push(blockGeo);
      const block = new THREE.Mesh(blockGeo, CONCRETE);
      block.position.set(x, h + (r.h + 1) / 2 - 1, z);
      block.castShadow = true;
      block.receiveShadow = true;
      g.add(block);
      const [bx, bz] = frame.toWorld(r.u1 + 0.04, (r.w0 + r.w1) / 2);
      const bufferGeo = new THREE.BoxGeometry(turned ? r.w1 - r.w0 : 0.08, 0.3, turned ? 0.08 : r.w1 - r.w0);
      this.made.push(bufferGeo);
      const buffer = new THREE.Mesh(bufferGeo, BUFFER);
      buffer.position.set(bx, h + r.h - 0.2, bz);
      g.add(buffer);
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
