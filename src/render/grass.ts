// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Vertical grass on the ground ("No mercy" graphics): blades standing up out
 * of the grass cover of a tile, swaying in the wind (render/grass.ts).
 *
 * The map's cover says where grass is (COVER.GRASS, world/cover.ts); a tile's
 * `cover` raster and `heights` give a blade a place to stand and how high the
 * ground is there.  Each blade is a small bent quad, instanced over the grass
 * cells of the tile (one InstancedMesh per tile, like the trees in props.ts),
 * and a vertex shader bends them by a wind that travels across the world, so a
 * field ripples as the wind moves over it.
 *
 * It is drawn only on the "No mercy" graphics (the same flag as the water on
 * the roads): there are many blades, and only that preset pays for them.  The
 * blades thin out with the distance and the graphics' tree density, so a phone
 * is not asked to draw a whole meadow.
 */
import * as THREE from 'three';
import { hash01 } from '../core/geom.ts';
import { COVER } from '../world/cover.ts';
import type { LoadedTile } from './tiles.ts';

/** A clump of grass: a few blades bent from the ground, each a thin quad. */
function grassGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // (one blade: a quad of two triangles, from the ground up; x is across the blade, y up)
  const pos = new Float32Array([
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0,
    -0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
  ]);
  // (the tip leans back a little, so a blade reads as grass and not a wall)
  for (let i = 0; i < pos.length; i += 3) {
    const y = pos[i + 1];
    pos[i + 2] += y * y * 0.35;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // (0 at the root, 1 at the tip: how far the wind may bend it)
  const bend = new Float32Array([0, 0, 0, 1, 1, 1]);
  g.setAttribute('bend', new THREE.BufferAttribute(bend, 1));
  // (a blade's own colour, a little apart from its neighbours')
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(18).fill(1), 3));
  g.setIndex([0, 1, 2, 3, 4, 5]);
  return g;
}

/** The grass of one tile: an InstancedMesh over its grass cells. */
interface TileGrass {
  mesh: THREE.InstancedMesh;
  cx: number;
  cz: number;
  total: number;
}

/** The world's grass, tile by tile, swaying in the wind. */
export class GrassRenderer {
  private readonly geo = grassGeometry();
  private readonly mat: THREE.ShaderMaterial;
  private readonly perTile = new Map<string, TileGrass>();
  /** how much grass is drawn (the graphics' tree density) and whether it is drawn at all */
  private enabled = false;
  density = 1;
  private time = 0;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector2(1, 0.3) },
      },
      vertexShader: /* glsl */ `
        attribute float bend;
        attribute vec3 color;
        uniform float uTime;
        uniform vec2 uWind;
        varying vec3 vCol;
        void main() {
          vCol = color;
          vec3 p = position;
          // (a wind that travels across the world: a wave over the field, the blades bending with it)
          vec4 world = instanceMatrix * vec4(p, 1.0);
          float phase = world.x * 0.15 + world.z * 0.11 + uTime * 1.7;
          float sway = sin(phase) * 0.16 + sin(phase * 0.5 + 1.3) * 0.06;
          p.x += uWind.x * sway * bend;
          p.z += uWind.y * sway * bend;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        void main() {
          gl_FragColor = vec4(vCol, 1.0);
        }
      `,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
  }

  /** The grass on (or off): the "No mercy" graphics turn it on. */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    for (const g of this.perTile.values()) g.mesh.visible = on;
  }

  /** Blades standing up out of a tile's grass cover. */
  add(tile: LoadedTile): void {
    if (this.perTile.has(tile.key)) return;
    const h = tile.header;
    const cn = h.coverN;
    const cov = tile.cover;
    const n = h.terrainN;
    const step = h.size / (n - 1);
    const half = h.size / 2;
    const heights = tile.heights;
    // (a blade about every 3.5 m in each direction – a meadow one can see the ground through,
    //  not a wall of grass: one InstancedMesh per tile, thinned further with the distance)
    const spacing = 3.5;
    const stride = Math.max(1, Math.round(spacing / (h.size / cn)));
    const spots: Array<{ x: number; y: number; z: number; r: number }> = [];
    for (let j = 0; j < cn; j += stride) {
      for (let i = 0; i < cn; i += stride) {
        if (cov[j * cn + i] !== COVER.GRASS) continue;
        const fx = (i + 0.5) / cn;
        const fz = (j + 0.5) / cn;
        const lx = (fx - 0.5) * h.size;
        const lz = (fz - 0.5) * h.size;
        // (the ground under it: the terrain grid, nearest sample)
        const ti = Math.min(n - 1, Math.max(0, Math.round((lx + half) / step)));
        const tj = Math.min(n - 1, Math.max(0, Math.round((lz + half) / step)));
        spots.push({ x: h.cx + lx, y: heights[tj * n + ti], z: h.cz + lz, r: hash01(i * 7 + j * 13 + h.ix) });
      }
    }
    const total = spots.length;
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, Math.max(1, total));
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const sc = new THREE.Vector3();
    for (let k = 0; k < total; k++) {
      const s = spots[k];
      q.setFromAxisAngle(up, s.r * 6.283);
      const hh = 0.22 + s.r * 0.16;
      sc.set(0.05 + s.r * 0.03, hh, 1);
      m4.compose(new THREE.Vector3(s.x, s.y, s.z), q, sc);
      mesh.setMatrixAt(k, m4);
      // (a little colour apart: darker at the root, lighter at the tip, a touch of yellow)
      const v = 0.7 + s.r * 0.5;
      col.setRGB(v * 0.82, v, v * 0.55);
      mesh.setColorAt(k, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = 'grass';
    mesh.visible = this.enabled;
    tile.group.add(mesh);
    this.perTile.set(tile.key, { mesh, cx: h.cx, cz: h.cz, total });
  }

  remove(key: string): void {
    const g = this.perTile.get(key);
    if (!g) return;
    g.mesh.removeFromParent();
    this.perTile.delete(key);
  }

  /** Thinning the grass with the distance and the graphics' density, and the wind moving on. */
  update(x: number, z: number, dt: number): void {
    this.time += dt;
    (this.mat.uniforms.uTime as THREE.IUniform<number>).value = this.time;
    for (const g of this.perTile.values()) {
      const d = Math.hypot(g.cx - x, g.cz - z);
      const frac = (d < 260 ? 1 : d < 500 ? 0.5 : d < 900 ? 0.2 : 0) * this.density;
      g.mesh.count = Math.max(0, Math.min(g.total, Math.round(g.total * frac)));
    }
  }

  dispose(): void {
    for (const key of [...this.perTile.keys()]) this.remove(key);
    this.geo.dispose();
    this.mat.dispose();
  }
}
