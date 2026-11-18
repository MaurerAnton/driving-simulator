// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The cars parked along the streets (src/world/parked.ts), drawn as instances:
 * one mesh per kind of car and tile.  On the lowest graphics, and far away on
 * the others, a car is two boxes; near by on medium and above it has a
 * shaped body, glass, wheels and lights.  They are drawn on every graphics
 * level – a street lined with cars drives differently from an empty one.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PARKED_COLOURS, PARKED_MODELS, unpackParked } from '../world/parked.ts';
import type { LoadedTile } from './tiles.ts';

/** A geometry with one colour on all its vertices (multiplied by the car's colour, or – near black, light – not much changed by it). */
function tint(g: THREE.BufferGeometry, rgb: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(rgb);
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

/** Two boxes: the body and the cabin. Faces −z (forward), standing on y = 0. */
function simpleCar(len: number, wid: number, hgt: number, van: boolean): THREE.BufferGeometry {
  const body = tint(new THREE.BoxGeometry(wid, hgt * 0.5, len).translate(0, 0.18 + hgt * 0.25, 0), 0xffffff);
  const cabLen = van ? len * 0.78 : len * 0.5;
  const cab = tint(new THREE.BoxGeometry(wid * 0.9, hgt * 0.38, cabLen).translate(0, 0.18 + hgt * 0.5 + hgt * 0.16, van ? len * 0.08 : len * 0.04), 0x9aa0a8);
  const g = mergeGeometries([body, cab], false)!;
  g.computeVertexNormals();
  return g;
}

/** A shaped body with glass, wheels and lights. */
function detailedCar(len: number, wid: number, hgt: number, van: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const sill = 0.3;
  const belt = hgt * (van ? 0.52 : 0.58);
  // lower body with a sloped bonnet: an extruded side profile (z along the car, y up), −z = front
  const h = len / 2;
  const prof = new THREE.Shape();
  prof.moveTo(-h, sill);
  prof.lineTo(h, sill);
  prof.lineTo(h, belt - 0.05);
  prof.lineTo(h - 0.25, belt);
  prof.lineTo(-h + (van ? 0.35 : 0.85), belt);
  prof.lineTo(-h, belt - 0.12);
  prof.closePath();
  const lower = new THREE.ExtrudeGeometry(prof, { depth: wid, bevelEnabled: false });
  // (the shape's x is the car's length: turned so that it runs along z, front at −z, centred across)
  lower.rotateY(-Math.PI / 2).translate(wid / 2, 0, 0);
  parts.push(tint(lower, 0xffffff));
  // the glasshouse: tapered, darker
  const gl = new THREE.Shape();
  const g0 = -h + (van ? 0.45 : 1.15);
  const g1 = h - (van ? 0.15 : 0.45);
  gl.moveTo(g0, belt);
  gl.lineTo(g1, belt);
  gl.lineTo(g1 - (van ? 0.05 : 0.25), hgt - 0.02);
  gl.lineTo(g0 + (van ? 0.2 : 0.55), hgt - 0.02);
  gl.closePath();
  const glass = new THREE.ExtrudeGeometry(gl, { depth: wid * 0.86, bevelEnabled: false });
  glass.rotateY(-Math.PI / 2).translate(wid * 0.43, 0, 0);
  parts.push(tint(glass, 0x2a3036));
  // roof panel in the body colour
  const r0 = g0 + (van ? 0.2 : 0.55);
  const r1 = g1 - (van ? 0.05 : 0.25);
  parts.push(tint(new THREE.BoxGeometry(wid * 0.84, 0.05, r1 - r0 - 0.1).translate(0, hgt - 0.01, (r0 + r1) / 2), 0xffffff));
  // wheels
  const r = 0.31;
  for (const zf of [-h + 0.75, h - 0.7]) {
    for (const xs of [-1, 1]) {
      parts.push(tint(new THREE.CylinderGeometry(r, r, 0.2, 10).rotateZ(Math.PI / 2).translate(xs * (wid / 2 - 0.08), r, zf), 0x161616));
    }
  }
  // lights: front white, back red
  for (const xs of [-1, 1]) {
    parts.push(tint(new THREE.BoxGeometry(0.32, 0.1, 0.04).translate(xs * (wid / 2 - 0.25), belt - 0.18, -h - 0.01), 0xf4f4ea));
    parts.push(tint(new THREE.BoxGeometry(0.3, 0.12, 0.04).translate(xs * (wid / 2 - 0.22), belt - 0.12, h + 0.01), 0xb01010));
  }
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false)!;
  g.computeVertexNormals();
  return g;
}

interface TileCars {
  meshes: THREE.InstancedMesh[];
  /** the kind of car of each mesh */
  kinds: number[];
  cx: number;
  cz: number;
}

/** The parked cars of the loaded tiles. */
export class ParkedCarRenderer {
  private readonly simple = PARKED_MODELS.map((m, i) => simpleCar(m.len, m.wid, m.hgt, i === 3));
  private readonly detailed = PARKED_MODELS.map((m, i) => detailedCar(m.len, m.wid, m.hgt, i === 3));
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly perTile = new Map<string, TileCars>();
  /** near by in detail (medium graphics and above) */
  detail = true;

  add(tile: LoadedTile, group: THREE.Group): void {
    const h = tile.header;
    const cars = unpackParked(tile.data.get('parked') as Int16Array | null, tile.data.get('parkedK') as Uint8Array | null, h.cx, h.cz, h.yBase);
    if (cars.length === 0) return;
    const entry: TileCars = { meshes: [], kinds: [], cx: h.cx, cz: h.cz };
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    const col = new THREE.Color();
    for (let kind = 0; kind < PARKED_MODELS.length; kind++) {
      const mine = cars.filter((c) => c.model === kind);
      if (mine.length === 0) continue;
      const mesh = new THREE.InstancedMesh(this.simple[kind], this.material, mine.length);
      mine.forEach((c, i) => {
        q.setFromAxisAngle(up, c.yaw);
        m4.compose(pos.set(c.x, c.y, c.z), q, one);
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, col.setHex(PARKED_COLOURS[c.colour]));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.name = 'parkedCars';
      group.add(mesh);
      entry.meshes.push(mesh);
      entry.kinds.push(kind);
    }
    this.perTile.set(tile.key, entry);
  }

  remove(tile: LoadedTile): void {
    const p = this.perTile.get(tile.key);
    if (!p) return;
    for (const m of p.meshes) m.dispose();
    this.perTile.delete(tile.key);
  }

  /** Detail by the distance from the viewer. */
  update(x: number, z: number): void {
    for (const p of this.perTile.values()) {
      const near = this.detail && Math.hypot(p.cx - x, p.cz - z) < 380;
      p.meshes.forEach((m, i) => {
        const geo = near ? this.detailed[p.kinds[i]] : this.simple[p.kinds[i]];
        if (m.geometry !== geo) m.geometry = geo;
      });
    }
  }
}
