// SPDX-License-Identifier: AGPL-3.0-only
/** Instanced scenery per tile: trees and street lamps. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01 } from '../core/geom.ts';
import { ParkedCarRenderer } from './parked.ts';
import type { LoadedTile } from './tiles.ts';

function colored(geo: THREE.BufferGeometry, color: number, darkenBottom = 0): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute('position');
  const c = new THREE.Color(color);
  const arr = new Float32Array(pos.count * 3);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    minY = Math.min(minY, pos.getY(i));
    maxY = Math.max(maxY, pos.getY(i));
  }
  for (let i = 0; i < pos.count; i++) {
    const t = maxY > minY ? (pos.getY(i) - minY) / (maxY - minY) : 1;
    const f = 1 - darkenBottom * (1 - t);
    arr[i * 3] = c.r * f;
    arr[i * 3 + 1] = c.g * f;
    arr[i * 3 + 2] = c.b * f;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  g.computeVertexNormals();
  return g;
}

/**
 * How wide a tree is drawn (the scale across of its unit shape) for its
 * height `h` and a random number `r` in [0, 1).  A broadleaf tree's crown is
 * as wide as real ones: about 6 m at 7 m high, 8–9 m at 10 m, 11–13 m at
 * 15 m, at most 14 m (the unit crown is 0.6 across); the other kinds keep
 * their shape's proportions.
 */
export function treeWidth(kind: number, h: number, r: number): number {
  if (kind !== 0) return h * (0.85 + 0.4 * r);
  // (a young tree – a street tree, one in a build-out – is slim: about 3 m across at 5 m, 4.5 m at 7 m)
  const young = Math.min(1, Math.max(0, (h - 3) / 9));
  const crown = Math.min(14, 0.6 * h + 2.2 * young * young * (3 - 2 * young)) * (0.9 + 0.2 * r);
  return Math.max(h * (0.6 + 0.25 * young), crown / 0.6);
}

/** Unit-height tree shapes (1 = full tree height), detailed and reduced. */
function treeGeometries(): { hi: THREE.BufferGeometry[]; lo: THREE.BufferGeometry[] } {
  // (bark is grey-brown, not black; trunks slim: a broadleaf's about 0.3 m across at 15 m)
  const trunk = (h: number, r: number): THREE.BufferGeometry => colored(new THREE.CylinderGeometry(r * 0.7, r, h, 5, 1, true).translate(0, h / 2, 0), 0x6f665b);
  const blob = (y: number, rx: number, ry: number, detail: number, color: number): THREE.BufferGeometry =>
    colored(new THREE.IcosahedronGeometry(1, detail).scale(rx, ry, rx).translate(0, y, 0), color, 0.35);
  const cone = (y0: number, y1: number, r: number, color: number, sides: number): THREE.BufferGeometry =>
    colored(new THREE.ConeGeometry(r, y1 - y0, sides, 1, true).translate(0, (y0 + y1) / 2, 0), color, 0.3);
  const hi = [
    // (broadleaf: drawn wider than high – treeWidth – so its trunk is slim in the unit shape)
    merged([trunk(0.42, 0.011), blob(0.66, 0.3, 0.34, 1, 0x4c7a36)]),
    merged([trunk(0.2, 0.022), cone(0.14, 0.62, 0.23, 0x2f5a34, 7), cone(0.42, 1.0, 0.16, 0x356338, 7)]),
    merged([blob(0.5, 0.62, 0.5, 1, 0x4f7a3a)]),
    merged([trunk(0.5, 0.025), blob(0.72, 0.36, 0.3, 1, 0x5d8c3d)]),
  ];
  const lo = [
    merged([blob(0.6, 0.3, 0.4, 0, 0x4c7a36)]),
    merged([cone(0.1, 1.0, 0.21, 0x31603a, 5)]),
    merged([blob(0.5, 0.62, 0.5, 0, 0x4f7a3a)]),
    merged([blob(0.68, 0.36, 0.33, 0, 0x5d8c3d)]),
  ];
  return { hi, lo };
}

function lampGeometry(): THREE.BufferGeometry {
  const pole = colored(new THREE.CylinderGeometry(0.05, 0.075, 7.2, 6, 1, true).translate(0, 3.6, 0), 0x70757a);
  // arm reaches along -Z (the instance yaw turns it towards the road)
  const arm = colored(new THREE.CylinderGeometry(0.035, 0.035, 1.3, 5, 1, true).rotateX(Math.PI / 2).translate(0, 7.2, -0.6), 0x70757a);
  const head = colored(new THREE.BoxGeometry(0.22, 0.09, 0.55).translate(0, 7.18, -1.3), 0xd8d8d0);
  return merged([pole, arm, head]);
}

interface TileProps {
  group: THREE.Group;
  trees: Array<{ mesh: THREE.InstancedMesh; kind: number; total: number }>;
  cx: number;
  cz: number;
}

export class PropRenderer {
  private readonly geos = treeGeometries();
  private readonly lampGeo = lampGeometry();
  /** one material for each kind of tree (broadleaf, conifer, …): the season colours and strips them each in its own way */
  private readonly treeMats = [0, 1, 2, 3].map(() => new THREE.MeshLambertMaterial({ vertexColors: true }));
  private readonly lampMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly perTile = new Map<string, TileProps>();
  /** global multiplier for how many trees are drawn (quality setting) */
  density = 1;
  /** the cars parked along the streets (render/parked.ts): on every graphics level, in detail from medium on */
  readonly parked = new ParkedCarRenderer();
  private shadows = false;

  /** The season on the trees: broadleaf and the other deciduous kind, conifers, fruit trees (game/outdoors.ts). */
  setSeason(patch: (m: THREE.Material, kind: 'deciduous' | 'evergreen' | 'orchard') => void): void {
    patch(this.treeMats[0], 'deciduous');
    patch(this.treeMats[1], 'evergreen');
    patch(this.treeMats[2], 'deciduous');
    patch(this.treeMats[3], 'orchard');
  }

  /** Trees throw shadows (the highest quality only: there are many of them). */
  setShadows(on: boolean): void {
    if (this.shadows === on) return;
    this.shadows = on;
    for (const p of this.perTile.values()) for (const t of p.trees) t.mesh.castShadow = on;
  }

  add(tile: LoadedTile): void {
    const group = new THREE.Group();
    const props: TileProps = { group, trees: [], cx: tile.header.cx, cz: tile.header.cz };
    const trees = tile.data.get('trees') as Float32Array | null;
    if (trees) {
      const n = trees.length / 5;
      // shuffle once so that drawing only the first k instances thins the stand evenly
      const order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(hash01(i * 7919 + tile.header.ix * 31 + tile.header.iz) * (i + 1));
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
      }
      const counts = [0, 0, 0, 0];
      for (let i = 0; i < n; i++) counts[trees[i * 5 + 4] | 0]++;
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      const col = new THREE.Color();
      for (let kind = 0; kind < 4; kind++) {
        if (!counts[kind]) continue;
        const mesh = new THREE.InstancedMesh(this.geos.hi[kind], this.treeMats[kind], counts[kind]);
        let k = 0;
        for (let oi = 0; oi < n; oi++) {
          const i = order[oi];
          if ((trees[i * 5 + 4] | 0) !== kind) continue;
          const h = trees[i * 5 + 3];
          const r = hash01(i * 13 + kind);
          q.setFromAxisAngle(up, r * 6.283);
          const wide = treeWidth(kind, h, hash01(i * 29 + 5));
          m4.compose(new THREE.Vector3(trees[i * 5], trees[i * 5 + 1] - 0.15, trees[i * 5 + 2]), q, new THREE.Vector3(wide, h, wide));
          mesh.setMatrixAt(k, m4);
          const v = 0.82 + 0.36 * hash01(i * 3 + 11);
          col.setRGB(v * (0.94 + 0.12 * r), v, v * (0.9 + 0.1 * r));
          mesh.setColorAt(k, col);
          k++;
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.castShadow = this.shadows;
        mesh.name = `trees${kind}`;
        group.add(mesh);
        props.trees.push({ mesh, kind, total: counts[kind] });
      }
    }
    const lamps = tile.header.objects.filter((o) => o.k === 'lamp');
    if (lamps.length) {
      const mesh = new THREE.InstancedMesh(this.lampGeo, this.lampMat, lamps.length);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      lamps.forEach((l, i) => {
        q.setFromAxisAngle(up, l.yaw ?? 0);
        m4.compose(new THREE.Vector3(l.x, l.y, l.z), q, new THREE.Vector3(1, 1, 1));
        mesh.setMatrixAt(i, m4);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.name = 'lamps';
      group.add(mesh);
    }
    this.parked.add(tile, group);
    tile.group.add(group);
    this.perTile.set(tile.key, props);
  }

  remove(tile: LoadedTile): void {
    const p = this.perTile.get(tile.key);
    if (!p) return;
    this.parked.remove(tile);
    for (const t of p.trees) t.mesh.dispose();
    for (const c of p.group.children) if (c instanceof THREE.InstancedMesh) c.dispose();
    this.perTile.delete(tile.key);
  }

  /** Choose tree detail and density per tile from the viewer distance. */
  update(x: number, z: number): void {
    // (the low preset draws a fifth of the trees: its parked cars are plain boxes)
    this.parked.detail = this.density >= 0.5;
    this.parked.update(x, z);
    for (const p of this.perTile.values()) {
      const d = Math.hypot(p.cx - x, p.cz - z);
      const near = d < 420;
      const frac = (d < 420 ? 1 : d < 800 ? 0.55 : d < 1200 ? 0.3 : 0.16) * this.density;
      for (const t of p.trees) {
        const geo = near ? this.geos.hi[t.kind] : this.geos.lo[t.kind];
        if (t.mesh.geometry !== geo) t.mesh.geometry = geo;
        t.mesh.count = Math.max(1, Math.min(t.total, Math.round(t.total * frac)));
      }
    }
  }
}
