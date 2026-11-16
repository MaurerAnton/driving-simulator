// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The ground beyond the tiles: the hills on the horizon, the land below an
 * aeroplane.  Drawn from the coarse grid of the whole region (far.bin.gz, a
 * point every 100 m with its height and cover), in square chunks that are
 * made when the camera comes near and dropped when it leaves – finer near,
 * coarser far away.  Nothing of it is drawn within `inner` metres of the
 * camera: there the tiles show the ground as it is.
 */
import * as THREE from 'three';
import { COVER_COLORS } from '../world/cover.ts';
import type { FarGround } from '../world/far.ts';
import { FAR_NONE } from '../world/far.ts';

/** cells (of 100 m) along a side of a chunk */
const CHUNK = 32;

interface Chunk {
  mesh: THREE.Mesh;
  step: number;
}

export class FarTerrain {
  readonly group = new THREE.Group();
  /** how far it reaches, and the radius round the camera that the tiles cover (m) */
  radius = 12000;
  inner = 1200;
  /** the grid (null until it is read) – the tour planner asks it what kind of place a street runs through */
  data: FarGround | null = null;
  private readonly chunks = new Map<string, Chunk>();
  private readonly material: THREE.MeshLambertMaterial;
  private readonly uniforms = { uInner: { value: 1200 }, uCam: { value: new THREE.Vector2() } };
  /** the colours of the cover classes, a little greyer than near by (seen through the air) */
  private readonly colours: Array<[number, number, number]>;

  constructor() {
    this.group.name = 'far ground';
    // (both sides: the skirts that close the gaps between chunks of other steps face either way)
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 });
    const u = this.uniforms;
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uInner = u.uInner;
      shader.uniforms.uCam = u.uCam;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFarXZ;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvFarXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFarXZ;\nuniform float uInner;\nuniform vec2 uCam;')
        .replace('void main() {', 'void main() {\n  if (distance(vFarXZ, uCam) < uInner) discard;');
    };
    this.material.customProgramCacheKey = () => 'fs-far';
    const c = new THREE.Color();
    const haze = new THREE.Color(0x9fb0bf);
    this.colours = COVER_COLORS.map((hex) => {
      c.setHex(hex).lerp(haze, 0.12);
      return [c.r, c.g, c.b];
    });
  }

  /** The grid to draw from (null: none – nothing is drawn). */
  set(data: FarGround | null): void {
    this.data = data;
    for (const ch of this.chunks.values()) this.drop(ch);
    this.chunks.clear();
  }

  get ready(): boolean {
    return this.data !== null;
  }

  /** Make the chunks around the camera at (x, z) – a few per call – and drop those out of reach. */
  update(x: number, z: number, budget = 2): void {
    const f = this.data;
    this.uniforms.uInner.value = this.inner;
    this.uniforms.uCam.value.set(x, z);
    if (!f || !this.group.visible) return;
    const size = CHUNK * f.cell;
    const ci0 = Math.floor((x - this.radius - f.minX) / size);
    const ci1 = Math.floor((x + this.radius - f.minX) / size);
    const cj0 = Math.floor((z - this.radius - f.minZ) / size);
    const cj1 = Math.floor((z + this.radius - f.minZ) / size);
    const want = new Set<string>();
    const todo: Array<{ key: string; i: number; j: number; d: number; step: number }> = [];
    for (let j = Math.max(0, cj0); j <= cj1 && j * CHUNK < f.h - 1; j++) {
      for (let i = Math.max(0, ci0); i <= ci1 && i * CHUNK < f.w - 1; i++) {
        // the nearest point of the chunk
        const x0 = f.minX + i * size;
        const z0 = f.minZ + j * size;
        const nx = Math.max(x0, Math.min(x0 + size, x));
        const nz = Math.max(z0, Math.min(z0 + size, z));
        const d = Math.hypot(nx - x, nz - z);
        if (d > this.radius) continue;
        // (wholly inside the tiles' circle: not needed)
        const fx = Math.max(Math.abs(x0 - x), Math.abs(x0 + size - x));
        const fz = Math.max(Math.abs(z0 - z), Math.abs(z0 + size - z));
        if (Math.hypot(fx, fz) < this.inner) continue;
        const step = d < 5000 ? 1 : d < 14000 ? 2 : 4;
        const key = `${i}_${j}`;
        want.add(key);
        const have = this.chunks.get(key);
        if (!have || have.step !== step) todo.push({ key, i, j, d, step });
      }
    }
    for (const [key, ch] of this.chunks) {
      if (want.has(key)) continue;
      this.drop(ch);
      this.chunks.delete(key);
    }
    todo.sort((a, b) => a.d - b.d);
    for (const t of todo.slice(0, budget)) {
      const old = this.chunks.get(t.key);
      if (old) this.drop(old);
      const mesh = this.build(f, t.i, t.j, t.step);
      if (!mesh) {
        this.chunks.delete(t.key);
        continue;
      }
      this.group.add(mesh);
      this.chunks.set(t.key, { mesh, step: t.step });
    }
  }

  private drop(ch: Chunk): void {
    this.group.remove(ch.mesh);
    ch.mesh.geometry.dispose();
  }

  /** One chunk: its points every `step` cells, with a skirt round it so that chunks of other steps meet without gaps. */
  private build(f: FarGround, ci: number, cj: number, step: number): THREE.Mesh | null {
    const i0 = ci * CHUNK;
    const j0 = cj * CHUNK;
    const n = CHUNK / step + 1;
    const ox = f.minX + i0 * f.cell;
    const oz = f.minZ + j0 * f.cell;
    const pos = new Float32Array((n * n + 4 * n) * 3);
    const col = new Float32Array((n * n + 4 * n) * 3);
    let known = 0;
    const at = (a: number, b: number): number => {
      const i = Math.min(f.w - 1, i0 + a * step);
      const j = Math.min(f.h - 1, j0 + b * step);
      return j * f.w + i;
    };
    for (let b = 0; b < n; b++) {
      for (let a = 0; a < n; a++) {
        const k = at(a, b);
        const v = f.heights[k];
        const y = v === FAR_NONE ? Number.NaN : f.base + v * f.step;
        if (!Number.isNaN(y)) known++;
        const o = (b * n + a) * 3;
        pos[o] = a * step * f.cell;
        // (a little below the ground as it is: where both are drawn the tiles win)
        pos[o + 1] = Number.isNaN(y) ? 0 : y - 1.5;
        pos[o + 2] = b * step * f.cell;
        const c = this.colours[f.cover[k]] ?? this.colours[0];
        col[o] = c[0];
        col[o + 1] = c[1];
        col[o + 2] = c[2];
      }
    }
    if (known === 0) return null;
    // the skirt: each edge point again, 40 m lower
    const edge: number[] = [];
    for (let a = 0; a < n; a++) edge.push(a);
    for (let b = 1; b < n; b++) edge.push(b * n + n - 1);
    for (let a = n - 2; a >= 0; a--) edge.push((n - 1) * n + a);
    for (let b = n - 2; b > 0; b--) edge.push(b * n);
    edge.forEach((k, e) => {
      const o = (n * n + e) * 3;
      pos[o] = pos[k * 3];
      pos[o + 1] = pos[k * 3 + 1] - 40;
      pos[o + 2] = pos[k * 3 + 2];
      col[o] = col[k * 3];
      col[o + 1] = col[k * 3 + 1];
      col[o + 2] = col[k * 3 + 2];
    });
    const idx: number[] = [];
    for (let b = 0; b + 1 < n; b++) {
      for (let a = 0; a + 1 < n; a++) {
        const k = b * n + a;
        idx.push(k, k + n, k + 1, k + 1, k + n, k + n + 1);
      }
    }
    for (let e = 0; e < edge.length; e++) {
      const a = edge[e];
      const b = edge[(e + 1) % edge.length];
      const sa = n * n + e;
      const sb = n * n + ((e + 1) % edge.length);
      idx.push(a, sa, b, b, sa, sb);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(ox, 0, oz);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    return mesh;
  }
}
