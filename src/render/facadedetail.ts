// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The measured details of walls in a tile (tools/mapgen/facadedetail.ts):
 * real windows, doors, balconies, shop fronts and plinths as geometry,
 * instead of the window grid the facade shader works out.
 *
 * Two sections carry them, both new in 1.6.0 and never asked for by older
 * versions (which read sections only by name – they draw these walls with
 * their usual windows):
 *  - `fdet_pos`, `fdet_idx`, `fdet_a8`: the details, a mesh like `struct`
 *    (r, g, b per corner);
 *  - `bldg_obs`: the walls in the building mesh that have them, as pairs
 *    (first corner, number of corners).  Their face style gets OBSERVED
 *    added when the tile is loaded: the facade shader then leaves out its
 *    windows and doors there (materials.ts).
 *
 * The details are built only while buildings are drawn with facades (from
 * the medium graphics level up), and drawn only near by: the tile is cut
 * into squares, each shown within DETAIL_DISTANCE of the viewer.
 */
import * as THREE from 'three';
import { POS_XZ_SCALE, POS_Y_SCALE } from '../world/tilefmt.ts';
import type { TileHeader, UnpackedTile } from '../world/tilefmt.ts';

/** added to the face style of a wall with measured details (the styles themselves are below 16) */
export const OBSERVED = 16;
/** the details of a square are drawn while the viewer is this near to its middle (metres) */
export const DETAIL_DISTANCE = 380;
/** the squares the details of a tile are cut into, per side */
const CELLS = 4;

/**
 * Mark the walls with measured details in the building mesh's style bytes
 * (`a8`: style, r, g, b per corner) – once: a corner already marked stays as
 * it is.  Returns the number of corners marked.
 */
export function flagObservedWalls(a8: Uint8Array | null, runs: ArrayLike<number> | null): number {
  if (!a8 || !runs) return 0;
  const corners = a8.length / 4;
  let marked = 0;
  for (let r = 0; r + 1 < runs.length; r += 2) {
    const end = Math.min(corners, runs[r] + runs[r + 1]);
    for (let i = runs[r]; i < end; i++) {
      if (a8[i * 4] < OBSERVED) {
        a8[i * 4] += OBSERVED;
        marked++;
      }
    }
  }
  return marked;
}

/** The material of the details: their colours, lit; drawn just before the wall they lie on, both sides (railings). */
export function makeDetailMaterial(): THREE.Material {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -2;
  return m;
}

/**
 * The details of a tile as objects to add to its group: one level of detail
 * per square of the tile that has any (null: the tile has none).  The
 * geometries made are put into `disposables`.
 */
export function buildFacadeDetail(data: UnpackedTile, h: TileHeader, mat: THREE.Material, disposables: Array<{ dispose(): void }>): THREE.Group | null {
  const pos = data.get('fdet_pos') as Int16Array | null;
  const idx = data.get('fdet_idx') as Uint16Array | Uint32Array | null;
  const col = data.get('fdet_a8') as Uint8Array | null;
  if (!pos || !idx || !col || idx.length < 3) return null;
  // which square each triangle lies in (by its first corner)
  const cellSize = h.size / CELLS / POS_XZ_SCALE;
  const half = CELLS / 2;
  const cellOf = (v: number): number => {
    const i = Math.max(0, Math.min(CELLS - 1, Math.floor(pos[v * 3] / cellSize + half)));
    const j = Math.max(0, Math.min(CELLS - 1, Math.floor(pos[v * 3 + 2] / cellSize + half)));
    return j * CELLS + i;
  };
  const count = new Uint32Array(CELLS * CELLS);
  for (let t = 0; t < idx.length; t += 3) count[cellOf(idx[t])] += 3;
  const lists = Array.from(count, (n) => (idx instanceof Uint32Array ? new Uint32Array(n) : new Uint16Array(n)));
  const fill = new Uint32Array(CELLS * CELLS);
  for (let t = 0; t < idx.length; t += 3) {
    const c = cellOf(idx[t]);
    lists[c].set([idx[t], idx[t + 1], idx[t + 2]], fill[c]);
    fill[c] += 3;
  }
  const position = new THREE.BufferAttribute(pos, 3);
  const color = new THREE.BufferAttribute(col, 3, true);
  // (the normals once, for all the squares)
  const all = new THREE.BufferGeometry();
  all.setAttribute('position', position);
  all.setIndex(new THREE.BufferAttribute(idx, 1));
  all.computeVertexNormals();
  const normal = all.getAttribute('normal');
  all.dispose();
  const group = new THREE.Group();
  group.name = 'fdet';
  lists.forEach((list, c) => {
    if (list.length === 0) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', position);
    g.setAttribute('color', color);
    g.setAttribute('normal', normal);
    g.setIndex(new THREE.BufferAttribute(list, 1));
    // (the sphere around this square's corners only – the others share the list of corners)
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    for (let k = 0; k < list.length; k++) box.expandByPoint(p.fromBufferAttribute(position, list[k]));
    g.boundingBox = box;
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    disposables.push(g);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'fdet';
    mesh.receiveShadow = true;
    // (the mesh in the tile's frame, the level of detail at the middle of its square)
    const mx = h.cx + ((c % CELLS) + 0.5 - half) * (h.size / CELLS);
    const mz = h.cz + (Math.floor(c / CELLS) + 0.5 - half) * (h.size / CELLS);
    mesh.position.set(h.cx - mx, 0, h.cz - mz);
    mesh.scale.set(POS_XZ_SCALE, POS_Y_SCALE, POS_XZ_SCALE);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    const lod = new THREE.LOD();
    lod.addLevel(mesh, 0);
    lod.addLevel(new THREE.Object3D(), DETAIL_DISTANCE);
    lod.position.set(mx, h.yBase, mz);
    lod.updateMatrix();
    lod.matrixAutoUpdate = false;
    group.add(lod);
  });
  group.matrixAutoUpdate = false;
  return group;
}
