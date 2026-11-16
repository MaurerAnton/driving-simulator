// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The airfields on the ground: runways, taxiways and aprons from the map
 * (air.json.gz), laid on the terrain – asphalt or concrete with their white
 * markings (the bars at the thresholds, the dashed middle line, the edges,
 * the number of each end), or a mown strip of grass – and taxiways with
 * their yellow line.  Built when the camera comes within a few kilometres,
 * again when it is close (the ground is known better then).
 */
import * as THREE from 'three';
import { paved, runwayEnd } from '../sim/airfield.ts';
import type { AirfieldJson, RunwayJson } from '../world/types.ts';

const ASPHALT = new THREE.MeshLambertMaterial({ color: 0x4b4d51, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const CONCRETE = new THREE.MeshLambertMaterial({ color: 0x8e8c86, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const GRASS = new THREE.MeshLambertMaterial({ color: 0x86a35a, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const WHITE = new THREE.MeshLambertMaterial({ color: 0xf2f2ee, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
const YELLOW = new THREE.MeshLambertMaterial({ color: 0xe8b818, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });

type Height = (x: number, z: number) => number;

/**
 * Quads along a line from (x1, z1) to (x2, z2): `from`…`to` metres along it,
 * `left`…`right` across it, every `step` metres along and at most `across`
 * metres apart across it (a wide runway is crowned: it follows the ground).
 */
function band(out: number[], ground: Height, x1: number, z1: number, x2: number, z2: number, from: number, to: number, left: number, right: number, lift: number, step = 20, across = 6): void {
  const len = Math.hypot(x2 - x1, z2 - z1) || 1;
  const ux = (x2 - x1) / len;
  const uz = (z2 - z1) / len;
  // right of the direction (x east, z south): (−uz, ux)
  const rx = -uz;
  const rz = ux;
  const n = Math.max(1, Math.ceil((to - from) / step));
  const m = Math.max(1, Math.ceil((right - left) / across));
  const pt = (a: number, c: number): number[] => {
    const x = x1 + ux * a + rx * c;
    const z = z1 + uz * a + rz * c;
    return [x, ground(x, z) + lift, z];
  };
  for (let i = 0; i < n; i++) {
    const a0 = from + ((to - from) * i) / n;
    const a1 = from + ((to - from) * (i + 1)) / n;
    for (let j = 0; j < m; j++) {
      const c0 = left + ((right - left) * j) / m;
      const c1 = left + ((right - left) * (j + 1)) / m;
      const p00 = pt(a0, c0);
      const p01 = pt(a0, c1);
      const p10 = pt(a1, c0);
      const p11 = pt(a1, c1);
      // (facing up: counter-clockwise seen from above – along the line, then across to its right is clockwise)
      out.push(...p00, ...p01, ...p10, ...p01, ...p11, ...p10);
    }
  }
}

function mesh(pos: number[], mat: THREE.Material): THREE.Mesh | null {
  if (pos.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  return m;
}

/** The number of a runway end, painted: white figures, read by whoever lands there. */
function designation(text: string): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 192;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#ffffff';
  g.font = 'bold 150px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 100, 124);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  // 9 m wide, 18 m long, flat on the ground, the figures' foot towards the threshold
  const geo = new THREE.PlaneGeometry(9, 18);
  geo.rotateX(-Math.PI / 2);
  return new THREE.Mesh(geo, mat);
}

export class AirfieldRenderer {
  readonly group = new THREE.Group();
  /** within this distance of the camera an airfield is drawn (m) */
  radius = 9000;
  private fields: AirfieldJson[] = [];
  private readonly shown = new Map<number, { root: THREE.Group; known: number }>();
  private readonly ground: Height;
  /** whether the ground under a place is known in detail (the tiles there are loaded) */
  private readonly detailed: (x: number, z: number) => boolean;

  constructor(ground: Height, detailed: (x: number, z: number) => boolean) {
    this.ground = ground;
    this.detailed = detailed;
    this.group.name = 'airfields';
  }

  set(fields: AirfieldJson[]): void {
    this.fields = fields;
    for (const s of this.shown.values()) this.drop(s.root);
    this.shown.clear();
  }

  update(x: number, z: number): void {
    this.fields.forEach((f, i) => {
      const d = Math.hypot(f.x - x, f.z - z);
      const have = this.shown.get(i);
      if (d > this.radius) {
        if (have) {
          this.drop(have.root);
          this.shown.delete(i);
        }
        return;
      }
      // (made again as more of the ground under it comes to be known in detail – the tiles load around the camera)
      const known = d < 2500 ? this.known(f) : 0;
      if (have && known <= have.known) return;
      if (have) this.drop(have.root);
      const root = this.build(f);
      this.group.add(root);
      this.shown.set(i, { root, known });
    });
  }

  /** How many points of the field's runways (every 200 m) and taxiways lie where the ground is known in detail. */
  private known(f: AirfieldJson): number {
    let n = 0;
    for (const r of f.runways) {
      const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
      const k = Math.max(1, Math.ceil(len / 200));
      for (let i = 0; i <= k; i++) if (this.detailed(r.x1 + ((r.x2 - r.x1) * i) / k, r.z1 + ((r.z2 - r.z1) * i) / k)) n++;
    }
    for (const t of f.taxiways) if (t.p.length >= 2 && this.detailed(t.p[0], t.p[1])) n++;
    for (const a of f.aprons) if (a.p.length >= 2 && this.detailed(a.p[0], a.p[1])) n++;
    return n;
  }

  private drop(root: THREE.Group): void {
    this.group.remove(root);
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material as THREE.MeshLambertMaterial;
        if (m.map) {
          m.map.dispose();
          m.dispose();
        }
      }
    });
  }

  private build(f: AirfieldJson): THREE.Group {
    const root = new THREE.Group();
    root.name = f.name || f.icao;
    const g = this.ground;
    const surf: Record<string, number[]> = { asphalt: [], concrete: [], grass: [], white: [], yellow: [] };
    for (const a of f.aprons) {
      if (a.p.length < 6) continue;
      const pts: THREE.Vector2[] = [];
      for (let i = 0; i < a.p.length; i += 2) pts.push(new THREE.Vector2(a.p[i], a.p[i + 1]));
      if (pts.length > 3 && pts[0].distanceTo(pts[pts.length - 1]) < 0.5) pts.pop();
      const tris = THREE.ShapeUtils.triangulateShape(pts, []);
      const out = paved(a.s) ? (/concrete/.test(a.s) ? surf.concrete : surf.asphalt) : surf.grass;
      for (const [i, j, k] of tris) {
        for (const q of [pts[i], pts[k], pts[j]]) out.push(q.x, g(q.x, q.y) + 0.07, q.y);
      }
    }
    for (const t of f.taxiways) {
      const out = paved(t.s) ? surf.asphalt : surf.grass;
      for (let i = 0; i + 3 < t.p.length; i += 2) {
        const [x1, z1, x2, z2] = [t.p[i], t.p[i + 1], t.p[i + 2], t.p[i + 3]];
        const len = Math.hypot(x2 - x1, z2 - z1);
        if (len < 0.5) continue;
        // (a little longer at both ends: the joints close)
        band(out, g, x1, z1, x2, z2, -t.w / 2, len + t.w / 2, -t.w / 2, t.w / 2, 0.08);
        if (paved(t.s)) band(surf.yellow, g, x1, z1, x2, z2, 0, len, -0.15, 0.15, 0.1, 10);
      }
    }
    for (const r of f.runways) this.runway(r, surf, root);
    for (const [k, mat] of [['asphalt', ASPHALT], ['concrete', CONCRETE], ['grass', GRASS], ['white', WHITE], ['yellow', YELLOW]] as const) {
      const m = mesh(surf[k], mat);
      if (m) root.add(m);
    }
    return root;
  }

  /** A runway: its surface, and on a paved one the markings of ICAO Annex 14 in a simple form. */
  private runway(r: RunwayJson, surf: Record<string, number[]>, root: THREE.Group): void {
    const g = this.ground;
    const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
    if (len < 10) return;
    const hw = r.w / 2;
    const isPaved = paved(r.s);
    band(isPaved ? (/concrete/.test(r.s) ? surf.concrete : surf.asphalt) : surf.grass, g, r.x1, r.z1, r.x2, r.z2, 0, len, -hw, hw, 0.09, 10);
    if (!isPaved) return;
    const W = surf.white;
    const lift = 0.11;
    // the edges
    band(W, g, r.x1, r.z1, r.x2, r.z2, 0, len, -hw + 0.3, -hw + 1.2, lift, 10);
    band(W, g, r.x1, r.z1, r.x2, r.z2, 0, len, hw - 1.2, hw - 0.3, lift, 10);
    // the thresholds: bars along the runway at each end
    const bars = Math.max(4, Math.min(16, Math.floor(r.w / 3.6) & ~1));
    for (const atEnd of [false, true]) {
      const a0 = atEnd ? len - 36 : 6;
      for (let b = 0; b < bars; b++) {
        const c0 = -hw + 2 + ((r.w - 4) * b) / bars;
        const c1 = c0 + ((r.w - 4) / bars) * 0.6;
        band(W, g, r.x1, r.z1, r.x2, r.z2, a0, a0 + 30, c0, c1, lift, 10);
      }
    }
    // the middle line: 30 m dashes, 20 m gaps, between the numbers
    for (let a = 80; a + 30 < len - 80; a += 50) band(W, g, r.x1, r.z1, r.x2, r.z2, a, a + 30, -0.45, 0.45, lift, 10);
    // the numbers of the ends, read from the threshold looking along the runway
    const ux = (r.x2 - r.x1) / len;
    const uz = (r.z2 - r.z1) / len;
    for (const second of [false, true]) {
      const d = designation(runwayEnd(r, second));
      const along = second ? len - 52 : 52;
      const x = r.x1 + ux * along;
      const z = r.z1 + uz * along;
      d.position.set(x, g(x, z) + lift + 0.01, z);
      // (the top of the figures points the way one lands: along the runway from that end)
      const dx = second ? -ux : ux;
      const dz = second ? -uz : uz;
      d.rotation.y = Math.atan2(-dx, -dz);
      root.add(d);
    }
  }
}
