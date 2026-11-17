// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Building blocks of the finer vehicles of the "very high" graphics
 * (render/cardetail.ts, render/fleetdetail.ts).
 *
 * - Parts: geometry collected per material and merged into one mesh each, so
 *   that a hundred small parts cost a handful of draw calls.
 * - Frame: a little coordinate system (an origin and three axes) to build a
 *   part in where it sits – on a door, a spoke, the face of a lamp.
 * - Surface: rays against the body's shell, quick enough to fix strips and
 *   sheets onto it point by point: panel gaps, window seals, lamp lenses
 *   that follow the curve of the bodywork.
 * - The detailed wheel: a tyre with a rounded sidewall and tread, an open
 *   rim with spokes, nuts and a centre cap, the brake disc behind it and the
 *   caliper on the disc – the four of a vehicle drawn as instances.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type V3 = [number, number, number];

/** Position and normal only, un-indexed: the form in which parts are merged. */
export function bare(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(n.attributes)) if (name !== 'position' && name !== 'normal') n.deleteAttribute(name);
  if (!n.getAttribute('normal')) n.computeVertexNormals();
  return n;
}

/** Geometry collected per material; `build` merges each material's parts into one mesh. */
export class Parts {
  private readonly lists = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(material: THREE.Material, ...geos: THREE.BufferGeometry[]): void {
    let l = this.lists.get(material);
    if (!l) this.lists.set(material, (l = []));
    for (const g of geos) l.push(bare(g));
  }

  /** One mesh per material, added to `parent`. */
  build(parent: THREE.Object3D, name: string, castShadow = false): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [mat, list] of this.lists) {
      if (list.length === 0) continue;
      const m = new THREE.Mesh(list.length === 1 ? list[0] : mergeGeometries(list, false)!, mat);
      m.name = name;
      m.castShadow = castShadow;
      parent.add(m);
      out.push(m);
    }
    this.lists.clear();
    return out;
  }
}

const _m = new THREE.Matrix4();

/** An origin and three axes (x across, y up, z out of the surface the part sits on): parts are built in it. */
export class Frame {
  readonly o: THREE.Vector3;
  readonly x: THREE.Vector3;
  readonly y: THREE.Vector3;
  readonly z: THREE.Vector3;

  constructor(o: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, z?: THREE.Vector3) {
    this.o = o.clone();
    this.z = (z ?? new THREE.Vector3().crossVectors(x, y)).clone().normalize();
    // x and y square to z (y kept as near as it was)
    this.x = new THREE.Vector3().crossVectors(y, this.z).normalize();
    this.y = new THREE.Vector3().crossVectors(this.z, this.x).normalize();
  }

  /** A frame on a surface point: z its normal, y as near to `up` as the surface lets it be. */
  static on(p: THREE.Vector3, n: THREE.Vector3, up: THREE.Vector3 = new THREE.Vector3(0, 1, 0)): Frame {
    const z = n.clone().normalize();
    let y = up.clone().addScaledVector(z, -up.dot(z));
    if (y.lengthSq() < 1e-6) y = new THREE.Vector3(0, 0, -1).addScaledVector(z, z.z);
    const x = new THREE.Vector3().crossVectors(y, z);
    return new Frame(p, x, y, z);
  }

  /** A point given in the frame. */
  at(u: number, v: number, w = 0): THREE.Vector3 {
    return this.o.clone().addScaledVector(this.x, u).addScaledVector(this.y, v).addScaledVector(this.z, w);
  }

  /** The same frame moved to (u, v, w) of itself (and turned by `roll` about its z). */
  moved(u: number, v: number, w = 0, roll = 0): Frame {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const x = this.x.clone().multiplyScalar(c).addScaledVector(this.y, s);
    const y = this.y.clone().multiplyScalar(c).addScaledVector(this.x, -s);
    return new Frame(this.at(u, v, w), x, y, this.z);
  }

  /** Geometry built around the origin (x, y, z as the frame's) put into place. */
  put(g: THREE.BufferGeometry): THREE.BufferGeometry {
    _m.makeBasis(this.x, this.y, this.z).setPosition(this.o);
    return g.applyMatrix4(_m);
  }

  /** A box w × h × d (along the frame's x, y, z), its middle at (u, v, w). */
  box(w: number, h: number, d: number, u = 0, v = 0, wz = 0): THREE.BufferGeometry {
    return this.put(new THREE.BoxGeometry(w, h, d).translate(u, v, wz));
  }

  /** A cylinder along the frame's z, its middle at (u, v, w). */
  cyl(r: number, len: number, u = 0, v = 0, wz = 0, seg = 14, r2 = r): THREE.BufferGeometry {
    return this.put(new THREE.CylinderGeometry(r2, r, len, seg).rotateX(Math.PI / 2).translate(u, v, wz));
  }

  /** A ring (a torus) in the frame's x-y plane. */
  ring(r: number, tube: number, u = 0, v = 0, wz = 0, seg = 24): THREE.BufferGeometry {
    return this.put(new THREE.TorusGeometry(r, tube, 6, seg).translate(u, v, wz));
  }

  /** A flat disc facing the frame's z. */
  disc(r: number, u = 0, v = 0, wz = 0, seg = 16): THREE.BufferGeometry {
    return this.put(new THREE.CircleGeometry(r, seg).translate(u, v, wz));
  }
}

/** A point where a ray met the surface, and the surface's normal there (towards where the ray came from). */
export interface Hit {
  p: THREE.Vector3;
  n: THREE.Vector3;
}

/**
 * Rays against a few geometries (a body's shell).  The triangles are sorted
 * into slices along z, so that a ray tests only those of the slices it passes.
 */
export class Surface {
  private readonly tri: Float32Array;
  private readonly slices: number[][] = [];
  private readonly z0: number;
  private readonly step: number;
  private readonly seen: Uint32Array;
  private stamp = 0;

  constructor(geos: THREE.BufferGeometry[], step = 0.05) {
    const t: number[] = [];
    for (const g of geos) {
      const pos = g.getAttribute('position');
      const idx = g.getIndex();
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i + 2 < n; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = idx ? idx.getX(i + k) : i + k;
          t.push(pos.getX(v), pos.getY(v), pos.getZ(v));
        }
      }
    }
    this.tri = Float32Array.from(t);
    this.step = step;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 2; i < t.length; i += 3) {
      lo = Math.min(lo, t[i]);
      hi = Math.max(hi, t[i]);
    }
    this.z0 = lo - step;
    const count = Math.ceil((hi - this.z0) / step) + 2;
    for (let i = 0; i < count; i++) this.slices.push([]);
    for (let f = 0; f < t.length / 9; f++) {
      const a = Math.min(t[f * 9 + 2], t[f * 9 + 5], t[f * 9 + 8]);
      const b = Math.max(t[f * 9 + 2], t[f * 9 + 5], t[f * 9 + 8]);
      for (let s = this.slice(a); s <= this.slice(b); s++) this.slices[s].push(f);
    }
    this.seen = new Uint32Array(t.length / 9);
  }

  private slice(z: number): number {
    return Math.max(0, Math.min(this.slices.length - 1, Math.floor((z - this.z0) / this.step)));
  }

  /** The first point of the surface on the ray from `o` along the unit vector `d`, within `far`. */
  hit(o: THREE.Vector3, d: THREE.Vector3, far = 4): Hit | null {
    const t = this.tri;
    const stamp = ++this.stamp;
    let best = far;
    let bf = -1;
    const s0 = this.slice(Math.min(o.z, o.z + d.z * far));
    const s1 = this.slice(Math.max(o.z, o.z + d.z * far));
    for (let s = s0; s <= s1; s++) {
      for (const f of this.slices[s]) {
        if (this.seen[f] === stamp) continue;
        this.seen[f] = stamp;
        const i = f * 9;
        // Möller–Trumbore
        const e1x = t[i + 3] - t[i];
        const e1y = t[i + 4] - t[i + 1];
        const e1z = t[i + 5] - t[i + 2];
        const e2x = t[i + 6] - t[i];
        const e2y = t[i + 7] - t[i + 1];
        const e2z = t[i + 8] - t[i + 2];
        const px = d.y * e2z - d.z * e2y;
        const py = d.z * e2x - d.x * e2z;
        const pz = d.x * e2y - d.y * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const tx = o.x - t[i];
        const ty = o.y - t[i + 1];
        const tz = o.z - t[i + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (dist > 1e-5 && dist < best) {
          best = dist;
          bf = f;
        }
      }
    }
    if (bf < 0) return null;
    const i = bf * 9;
    const n = new THREE.Vector3(t[i + 3] - t[i], t[i + 4] - t[i + 1], t[i + 5] - t[i + 2]).cross(new THREE.Vector3(t[i + 6] - t[i], t[i + 7] - t[i + 1], t[i + 8] - t[i + 2])).normalize();
    if (n.dot(d) > 0) n.negate();
    return { p: o.clone().addScaledVector(d, best), n };
  }

  /** The surface below `p` as seen along `d` (from 1 m before it). */
  onto(p: THREE.Vector3, d: THREE.Vector3): Hit | null {
    const dir = d.clone().normalize();
    return this.hit(p.clone().addScaledVector(dir, -1), dir, 2.5);
  }
}

/**
 * A sheet over the surface: rays from the points of a grid (`origin(u, v)`,
 * u and v from 0 to 1) along `d`, the hits lifted `lift` off the surface.
 * Cells with a missed corner stay open.
 */
export function drape(surf: Surface, origin: (u: number, v: number) => THREE.Vector3, d: THREE.Vector3, nu: number, nv: number, lift: number): THREE.BufferGeometry {
  const dir = d.clone().normalize();
  const grid: Array<Array<Hit | null>> = [];
  for (let j = 0; j <= nv; j++) {
    const row: Array<Hit | null> = [];
    for (let i = 0; i <= nu; i++) row.push(surf.hit(origin(i / nu, j / nv), dir, 3));
    grid.push(row);
  }
  return sheetOf(grid, lift);
}

/** A sheet through rows of surface points, lifted along their normals; open where a point is missing. */
export function sheetOf(grid: Array<Array<Hit | null>>, lift: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const lifted = (h: Hit): THREE.Vector3 => h.p.clone().addScaledVector(h.n, lift);
  const push = (h: Hit): void => {
    const p = lifted(h);
    pos.push(p.x, p.y, p.z);
    nrm.push(h.n.x, h.n.y, h.n.z);
  };
  for (let j = 0; j + 1 < grid.length; j++) {
    for (let i = 0; i + 1 < grid[j].length; i++) {
      const a = grid[j][i];
      const b = grid[j][i + 1];
      const c = grid[j + 1][i + 1];
      const e = grid[j + 1][i];
      if (!a || !b || !c || !e) continue;
      // wound so that the face looks the way the normals do
      const f = new THREE.Vector3().subVectors(lifted(b), lifted(a)).cross(new THREE.Vector3().subVectors(lifted(e), lifted(a)));
      const out = f.dot(a.n) >= 0;
      const quad = out ? [a, b, c, a, c, e] : [a, c, b, a, e, c];
      for (const h of quad) push(h);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/** A strip `width` wide along points of a surface, lifted `lift` off it (a panel gap, a seal, a trim line). */
export function ribbon(pts: Hit[], width: number, lift: number): THREE.BufferGeometry {
  const rows: Array<Array<Hit | null>> = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)].p;
    const b = pts[Math.min(pts.length - 1, i + 1)].p;
    const along = new THREE.Vector3().subVectors(b, a).normalize();
    const side = new THREE.Vector3().crossVectors(pts[i].n, along).normalize().multiplyScalar(width / 2);
    rows.push([
      { p: pts[i].p.clone().sub(side), n: pts[i].n },
      { p: pts[i].p.clone().add(side), n: pts[i].n },
    ]);
  }
  return sheetOf(rows, lift);
}

/** Points along a path of the surface: `path(t)` for t from 0 to 1 in `n` steps, each brought onto the surface along `d(t)`. */
export function along(surf: Surface, path: (t: number) => THREE.Vector3, d: (t: number) => THREE.Vector3, n: number): Hit[] {
  const out: Hit[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const h = surf.onto(path(t), d(t));
    if (h) out.push(h);
  }
  return out;
}

/** A surface of revolution about the x axis: profile points [radius, x], as seen from +x: outward normals when x rises along it. */
export function lathe(profile: Array<[number, number]>, seg: number, phase = 0): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    profile.map(([r, x]) => new THREE.Vector2(r, x)),
    seg,
    phase,
  );
  // (the lathe turns about y: lay its axis along x)
  g.rotateZ(-Math.PI / 2);
  return bare(g);
}

// ------------------------------------------------------------------------------------ the wheel
export interface WheelSpec {
  /** outer radius of the tyre, its width (m) */
  radius: number;
  width: number;
  /** radius of the rim's edge (where the tyre sits on it) */
  rim: number;
  /** number of spokes of the rim (0: a steel wheel – a dished disc with holes) */
  spokes: number;
  /** wheel nuts round the hub */
  nuts: number;
  /** the brake disc and its caliper behind the rim (a car), or a drum (a truck) */
  disc: boolean;
  /** lugs of a tractor tyre instead of a road tread */
  lugs?: boolean;
  /** two tyres side by side (the rear axle of a truck or a bus): `width` is that of both */
  twin?: boolean;
}

/**
 * The parts of one wheel, its axis along x and its outer face towards +x
 * (side 1) or −x (side −1): what turns with it (tyre, metal: rim and disc)
 * and what only steers with it (the caliper).
 */
export function wheelParts(w: WheelSpec, side: 1 | -1): { tyre: THREE.BufferGeometry; metal: THREE.BufferGeometry; caliper: THREE.BufferGeometry | null } {
  const r = w.radius;
  const hw = w.width / 2;
  const rr = w.rim;
  // ---- the tyre: bead, sidewall with its bulge, shoulder, tread with grooves – from the inner bead to the outer one
  const prof: Array<[number, number]> = [];
  const side1 = (s: number): Array<[number, number]> => [
    [rr, s * (hw - 0.012)],
    [rr + 0.012, s * (hw + 0.002)],
    [rr + (r - rr) * 0.45, s * (hw + 0.008)],
    [r - (r - rr) * 0.22, s * (hw + 0.004)],
    [r - 0.012, s * (hw - 0.01)],
    [r - 0.002, s * (hw - 0.028)],
  ];
  prof.push(...side1(-1));
  const grooves = w.lugs ? [] : (w.twin ? [-0.78, -0.42, 0.42, 0.78] : [-0.5, -0.17, 0.17, 0.5]).map((k) => k * (hw - 0.03));
  for (const gx of grooves) {
    const gw = Math.min(0.006, w.width * 0.03);
    prof.push([r, gx - gw - 0.002], [r - 0.007, gx - gw], [r - 0.007, gx + gw], [r, gx + gw + 0.002]);
    // (between the two tyres of a twin wheel: down to the rims)
    if (w.twin && gx < 0 && grooves.indexOf(gx) === 1) prof.push([r - 0.01, -0.03], [r - (r - rr) * 0.25, -0.022], [rr + 0.05, -0.012], [rr + 0.05, 0.012], [r - (r - rr) * 0.25, 0.022], [r - 0.01, 0.03]);
  }
  prof.push(...side1(1).reverse());
  const tyreParts: THREE.BufferGeometry[] = [lathe(prof, 40)];
  // blocks of the tread on the shoulders – or the chevrons of a tractor's lugs
  const blocks = w.lugs ? 22 : 36;
  for (let i = 0; i < blocks; i++) {
    const a = (i / blocks) * Math.PI * 2;
    if (w.lugs) {
      for (const s of [-1, 1]) {
        const lug = new THREE.BoxGeometry(hw * 0.95, 0.035, 0.07).translate(s * hw * 0.5, r + 0.012, 0).rotateY(s * 0.45);
        tyreParts.push(bare(lug.rotateX(a + (s > 0 ? Math.PI / blocks : 0))));
      }
    } else {
      for (const s of [-1, 1]) {
        const bk = new THREE.BoxGeometry(0.02, 0.004, (Math.PI * 2 * r) / blocks / 2.6).translate(s * (hw - 0.03), r - 0.0005, 0);
        tyreParts.push(bare(bk.rotateX(a)));
      }
    }
  }
  const tyre = mergeGeometries(tyreParts, false)!;

  // ---- the metal: the rim's barrel and lip, spokes (or a dished disc), hub, nuts, cap – and the brake disc
  const metal: THREE.BufferGeometry[] = [];
  const face = hw - 0.012;
  // barrel, seen from inside (normals inwards: the x falls along the profile)
  metal.push(lathe([[rr - 0.004, face - 0.004], [rr - 0.006, 0], [rr - 0.004, -face]], 28));
  // the lip over the tyre's bead
  metal.push(lathe([[rr - 0.012, face - 0.006], [rr - 0.004, face + 0.004], [rr + 0.006, face + 0.004], [rr + 0.008, face - 0.004]].reverse() as Array<[number, number]>, 36));
  const hubR = rr * 0.3;
  const hubX = face - 0.024;
  // hub face and its rim
  metal.push(bare(new THREE.CylinderGeometry(hubR, hubR * 1.05, 0.02, 20).rotateZ(-Math.PI / 2).translate(hubX, 0, 0)));
  if (w.spokes > 0) {
    // spokes from the hub out to the lip, dished: the hub lies deeper than the rim
    for (let i = 0; i < w.spokes; i++) {
      const a = (i / w.spokes) * Math.PI * 2;
      const pts: V3[][] = [];
      for (const [rad, x, wd] of [
        [hubR * 0.9, hubX + 0.012, 0.03],
        [rr * 0.6, face - 0.006, 0.026],
        [rr - 0.01, face + 0.002, 0.034],
      ]) {
        const c = Math.cos(a);
        const sn = Math.sin(a);
        // a ring across the spoke: its width round the wheel, its depth along x
        const ring: V3[] = [];
        for (const [du, dx] of [
          [-wd / 2, 0.011],
          [wd / 2, 0.011],
          [wd / 2, -0.011],
          [-wd / 2, -0.011],
        ]) ring.push([x + dx, c * rad - sn * du, sn * rad + c * du]);
        pts.push(ring);
      }
      metal.push(tubeOf(pts));
    }
  } else {
    // a steel wheel: a dished disc from the lip down to the hub
    metal.push(lathe([[rr - 0.01, face - 0.004], [rr * 0.62, hubX + 0.02], [hubR, hubX + 0.006]], 28));
  }
  // nuts and the centre cap
  for (let i = 0; i < w.nuts; i++) {
    const a = (i / w.nuts) * Math.PI * 2;
    const nr = hubR * 0.62;
    metal.push(bare(new THREE.CylinderGeometry(0.009, 0.009, 0.02, 6).rotateZ(-Math.PI / 2).translate(hubX + 0.016, Math.cos(a) * nr, Math.sin(a) * nr)));
  }
  metal.push(lathe([[hubR * 0.38, hubX + 0.008], [hubR * 0.36, hubX + 0.02], [hubR * 0.22, hubX + 0.027], [0.001, hubX + 0.029]], 18));
  // the brake disc (or a truck's drum) behind the spokes, darker: its vertices carry a colour
  const discParts: THREE.BufferGeometry[] = [];
  if (w.disc) {
    const ro = rr * 0.74;
    const ri = rr * 0.38;
    const th = 0.024;
    // (a face looks to +x where the radius shrinks along the profile, outwards where x grows)
    discParts.push(lathe([[ri, -0.004 - th], [ro, -0.004 - th], [ro, -0.004], [ri, -0.004]], 32));
    // the hat up to the hub
    discParts.push(lathe([[ri, -0.004], [hubR * 1.1, hubX - 0.012]], 20));
  } else {
    discParts.push(lathe([[rr * 0.8, -hw * 0.7], [rr * 0.8, hubX - 0.016], [hubR * 1.1, hubX - 0.014]], 24));
  }
  const tint = (g: THREE.BufferGeometry, k: number): THREE.BufferGeometry => {
    const n = g.getAttribute('position').count;
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(k), 3));
    return g;
  };
  const metalGeo = mergeGeometries([...metal.map((g) => tint(g, 1)), ...discParts.map((g) => tint(bare(g), 0.42))], false)!;

  // ---- the caliper: astride the disc's edge, behind and above the axle
  let caliper: THREE.BufferGeometry | null = null;
  if (w.disc) {
    const ro = rr * 0.74;
    const a = 0.55; // up from the rear, rad
    const cz = Math.cos(a) * (ro - 0.012);
    const cy = Math.sin(a) * (ro - 0.012);
    const body = new THREE.BoxGeometry(0.05, 0.04, 0.1).translate(-0.016, 0, 0);
    // (its length along the disc's edge there)
    body.rotateX(Math.PI / 2 - a);
    body.translate(0, cy, cz);
    caliper = bare(body);
  }
  // the other side: the mirror image (the faces turned the right way round again)
  const mirror = (g: THREE.BufferGeometry): THREE.BufferGeometry => (side > 0 ? g : flipX(g));
  return { tyre: mirror(tyre), metal: mirror(metalGeo), caliper: caliper ? mirror(caliper) : null };
}

/** The mirror image across x = 0, with the winding and the normals put right. */
export function flipX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
  const pos = out.getAttribute('position') as THREE.BufferAttribute;
  const nrm = out.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const col = out.getAttribute('color') as THREE.BufferAttribute | undefined;
  for (let i = 0; i + 2 < pos.count; i += 3) {
    for (const a of [pos, nrm, col]) {
      if (!a) continue;
      for (let k = 0; k < a.itemSize; k++) {
        const t = a.getComponent(i + 1, k);
        a.setComponent(i + 1, k, a.getComponent(i + 2, k));
        a.setComponent(i + 2, k, t);
      }
    }
  }
  return out;
}

/** A closed skin through rings of the same number of points (no caps). */
export function tubeOf(rings: V3[][], caps = true): THREE.BufferGeometry {
  const pos: number[] = [];
  const n = rings[0].length;
  const tri = (a: V3, b: V3, c: V3): void => void pos.push(...a, ...b, ...c);
  // which way round the rings run, seen along the sweep: the skin must face out
  const centre = (r: V3[]): V3 => r.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n, s[2] + p[2] / n] as V3, [0, 0, 0] as V3);
  const c0 = centre(rings[0]);
  const c1 = centre(rings[rings.length - 1]);
  const axis = new THREE.Vector3(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]);
  const a0 = new THREE.Vector3(...rings[0][0]).sub(new THREE.Vector3(...c0));
  const a1 = new THREE.Vector3(...rings[0][1]).sub(new THREE.Vector3(...c0));
  const ccw = new THREE.Vector3().crossVectors(a0, a1).dot(axis) > 0;
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      const [a, b, c, d] = [rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]];
      if (ccw) {
        tri(a, b, c);
        tri(a, c, d);
      } else {
        tri(a, c, b);
        tri(a, d, c);
      }
    }
  }
  if (caps) {
    for (const [r, end] of [
      [rings[0], false],
      [rings[rings.length - 1], true],
    ] as Array<[V3[], boolean]>) {
      const c = centre(r);
      for (let j = 0; j < n; j++) {
        const k = (j + 1) % n;
        // (a ring running counter-clockwise seen from where the sweep heads: its fan looks that way)
        if (ccw === end) tri(c, r[j], r[k]);
        else tri(c, r[k], r[j]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * The four detailed wheels of a vehicle as instances: one draw call for the
 * tyres of a side, one for their metal, one for the calipers.  `place`
 * puts wheel i where its plain twin is (its steering and its turning).
 */
export class WheelSet {
  readonly group = new THREE.Group();
  private readonly meshes: Array<{ tyre: THREE.InstancedMesh; metal: THREE.InstancedMesh; caliper: THREE.InstancedMesh | null; index: number[] }> = [];
  private readonly sides: number[];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly p = new THREE.Vector3();

  /** `sides`: the side of each wheel (−1 left, 1 right); `materials`: tyre, metal (vertex colours), caliper. */
  constructor(spec: WheelSpec, sides: number[], materials: { tyre: THREE.Material; metal: THREE.Material; caliper: THREE.Material }) {
    this.sides = sides;
    for (const side of [-1, 1] as const) {
      const index = sides.map((s, i) => (s === side ? i : -1)).filter((i) => i >= 0);
      if (index.length === 0) continue;
      const parts = wheelParts(spec, side);
      const make = (g: THREE.BufferGeometry, mat: THREE.Material): THREE.InstancedMesh => {
        const im = new THREE.InstancedMesh(g, mat, index.length);
        // (always near the camera that follows the vehicle: no bounds to keep up to date)
        im.frustumCulled = false;
        im.castShadow = true;
        this.group.add(im);
        return im;
      };
      this.meshes.push({ tyre: make(parts.tyre, materials.tyre), metal: make(parts.metal, materials.metal), caliper: parts.caliper ? make(parts.caliper, materials.caliper) : null, index });
    }
    this.group.name = 'detailed wheels';
  }

  /** Wheel i at `pos` (in the vehicle's frame), steered by `steer` (rad, + = right) and turned by `spin` (rad, rolling forward +). */
  place(i: number, pos: THREE.Vector3, steer: number, spin: number): void {
    for (const set of this.meshes) {
      const k = set.index.indexOf(i);
      if (k < 0) continue;
      this.e.set(-spin, -steer, 0, 'YXZ');
      this.m.compose(pos, this.q.setFromEuler(this.e), this.one);
      set.tyre.setMatrixAt(k, this.m);
      set.metal.setMatrixAt(k, this.m);
      set.tyre.instanceMatrix.needsUpdate = true;
      set.metal.instanceMatrix.needsUpdate = true;
      if (set.caliper) {
        this.e.set(0, -steer, 0, 'YXZ');
        this.m.compose(this.p.copy(pos), this.q.setFromEuler(this.e), this.one);
        set.caliper.setMatrixAt(k, this.m);
        set.caliper.instanceMatrix.needsUpdate = true;
      }
    }
  }

  get count(): number {
    return this.sides.length;
  }
}

/** A number plate as a German one is: the EU band with the country letter, the characters, the seals (both on the rear plate). */
export function plateTexture(text: string, rear: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1040;
  c.height = 220;
  const x = c.getContext('2d')!;
  x.fillStyle = '#f5f5f1';
  x.fillRect(0, 0, 1040, 220);
  x.strokeStyle = '#111';
  x.lineWidth = 10;
  x.strokeRect(5, 5, 1030, 210);
  // the EU band: twelve stars in a ring, the country's letter under them
  x.fillStyle = '#1b3fa0';
  x.fillRect(10, 10, 90, 200);
  x.fillStyle = '#ffd200';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const sx = 55 + Math.cos(a) * 28;
    const sy = 66 + Math.sin(a) * 28;
    x.beginPath();
    for (let k = 0; k < 10; k++) {
      const r = k % 2 === 0 ? 6 : 2.6;
      const b = (k / 10) * Math.PI * 2 - Math.PI / 2;
      if (k === 0) x.moveTo(sx + Math.cos(b) * r, sy + Math.sin(b) * r);
      else x.lineTo(sx + Math.cos(b) * r, sy + Math.sin(b) * r);
    }
    x.fill();
  }
  x.fillStyle = '#fff';
  x.font = '700 60px "DIN Alternate", "Bahnschrift", "Arial Narrow", Arial, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('D', 55, 168);
  // the characters: the district, the seals, the rest – a little raised (a light edge above, a shadow below)
  const [district, ...restParts] = text.split(' ');
  const rest = restParts.join(' ');
  x.font = '700 150px "DIN Alternate", "Bahnschrift", "Arial Narrow", Arial, sans-serif';
  x.textAlign = 'left';
  const draw = (t: string, px: number): void => {
    x.fillStyle = 'rgba(0, 0, 0, 0.35)';
    x.fillText(t, px + 3, 122);
    x.fillStyle = '#111';
    x.fillText(t, px, 118, 900);
  };
  draw(district, 130);
  const dw = x.measureText(district).width;
  // the seals: the inspection's (rear only) above the district's
  const sealX = 130 + dw + 52;
  if (rear) {
    x.fillStyle = '#e8c32c';
    x.beginPath();
    x.arc(sealX, 72, 30, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = '#6d5a12';
    x.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      x.beginPath();
      x.moveTo(sealX + Math.cos(a) * 18, 72 + Math.sin(a) * 18);
      x.lineTo(sealX + Math.cos(a) * 28, 72 + Math.sin(a) * 28);
      x.stroke();
    }
  }
  x.fillStyle = '#c9ccd0';
  x.beginPath();
  x.arc(sealX, rear ? 150 : 110, 30, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = '#7d1f1f';
  x.fillRect(sealX - 9, (rear ? 150 : 110) - 14, 18, 22);
  draw(rest, sealX + 50);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
