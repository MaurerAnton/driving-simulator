// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Procedural car body: a lofted compact hatchback shell built from a handful
 * of cross-section parameters.  No model files – the same builder makes the
 * player's driving-school car and the traffic cars.
 *
 * Car frame: origin on the ground under the middle of the wheelbase,
 * +X right, +Y up, -Z forward (so the bonnet points to -Z).
 */
import * as THREE from 'three';

export interface CarDims {
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  track: number;
  wheelRadius: number;
  tyreWidth: number;
  frontOverhang: number;
  /** 0 = hatchback, 1 = estate/van-like long roof, 2 = saloon boot */
  tail: number;
}

export const COMPACT_DIMS: CarDims = {
  length: 4.28,
  width: 1.79,
  height: 1.46,
  wheelbase: 2.63,
  track: 1.54,
  wheelRadius: 0.316,
  tyreWidth: 0.205,
  frontOverhang: 0.88,
  tail: 0,
};

interface Section {
  z: number;
  /** half width at the waist */
  w: number;
  /** underside */
  yb: number;
  /** widest crease */
  ym: number;
  /** belt line (window sill) or bonnet/boot edge height */
  ybelt: number;
  /** half width and height of the roof edge; equal to belt values where there is no cabin */
  wr: number;
  yr: number;
  /** crown height at the centre line */
  yc: number;
}

function lerpSec(a: Section, b: Section, t: number): Section {
  // smooth in z so the loft has no creases at the key sections
  const s = t * t * (3 - 2 * t);
  const m = (p: number, q: number, u: number): number => p + (q - p) * u;
  return {
    z: m(a.z, b.z, t),
    w: m(a.w, b.w, s),
    yb: m(a.yb, b.yb, s),
    ym: m(a.ym, b.ym, s),
    ybelt: m(a.ybelt, b.ybelt, t),
    wr: m(a.wr, b.wr, t),
    yr: m(a.yr, b.yr, t),
    yc: m(a.yc, b.yc, t),
  };
}

export interface CarShell {
  paint: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  trim: THREE.BufferGeometry;
  /** inward-facing copy of the opaque shell below the windows: floor, flanks, bulkheads */
  lining: THREE.BufferGeometry;
  /** the same for the roof and the pillars between the windows */
  headliner: THREE.BufferGeometry;
  /** A pillars along the windscreen edges: the faces seen from outside (body colour) … */
  pillars: THREE.BufferGeometry;
  /** … and their trim towards the cabin */
  pillarTrim: THREE.BufferGeometry;
  /** z of front and rear axle, bumper tips, cabin landmarks */
  zFront: number;
  zRear: number;
  zAxleF: number;
  zAxleR: number;
  zCowl: number;
  zRoofFront: number;
  zRoofRear: number;
  /** middle of the B pillar and where the rear window meets the boot */
  zPillarB: number;
  zTail: number;
  halfWidth: number;
  beltY: number;
  roofY: number;
  /** height of the windscreen's lower edge at its corners and in the middle */
  cowlY: number;
  cowlCrownY: number;
  /** right-hand outline [x, y] of the flat nose and tail faces (the bumpers), bottom → top */
  noseOutline: number[][];
  tailOutline: number[][];
}

export type Vec3 = [number, number, number];

/**
 * Collects the triangles of a hand-built part (pillar, dashboard, seat …) and
 * shades it: smooth where neighbouring faces meet at a shallow angle, a sharp
 * edge where they do not.  Rounded shapes can then be drawn with few triangles
 * without looking faceted.
 */
export class Sculpt {
  private readonly p: number[] = [];

  /** Corners counter-clockwise as seen from the visible side. */
  tri(a: Vec3, b: Vec3, c: Vec3): this {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    return this;
  }

  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): this {
    return this.tri(a, b, c).tri(a, c, d);
  }

  /**
   * Skin over closed rings (each ring the same number of points), visible from
   * outside – or from inside with `inward` (a recess) –, optionally with the
   * two ends closed.
   */
  tube(rings: Vec3[][], capStart = false, capEnd = false, inward = false): this {
    const n = rings[0].length;
    for (let i = 0; i + 1 < rings.length; i++) {
      const a = rings[i];
      const b = rings[i + 1];
      // ring turning counter-clockwise when seen from where the sweep is heading → as listed
      const fwd = dot3(ringNormal(a), sub3(centroid(b), centroid(a))) >= 0 !== inward;
      for (let j = 0; j < n; j++) {
        const k = (j + 1) % n;
        if (fwd) this.quad(a[j], a[k], b[k], b[j]);
        else this.quad(a[j], b[j], b[k], a[k]);
      }
    }
    const last = rings.length - 1;
    if (capStart) this.fan(rings[0], sub3(centroid(rings[0]), centroid(rings[1])));
    if (capEnd) this.fan(rings[last], sub3(centroid(rings[last]), centroid(rings[last - 1])));
    return this;
  }

  /** Skin over open rows of points; `facing` is a direction its visible side looks to. */
  sheet(rows: Vec3[][], facing: Vec3): this {
    const quads: Vec3[][] = [];
    const sum: Vec3 = [0, 0, 0];
    for (let i = 0; i + 1 < rows.length; i++) {
      for (let j = 0; j + 1 < rows[i].length; j++) {
        const q = [rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]];
        const nq = cross3(sub3(q[2], q[0]), sub3(q[3], q[1]));
        sum[0] += nq[0];
        sum[1] += nq[1];
        sum[2] += nq[2];
        quads.push(q);
      }
    }
    const flip = dot3(sum, facing) < 0;
    for (const q of quads) {
      if (flip) this.quad(q[0], q[3], q[2], q[1]);
      else this.quad(q[0], q[1], q[2], q[3]);
    }
    return this;
  }

  /** A flat polygon as a fan around its middle, looking towards `facing`. */
  fan(ring: Vec3[], facing: Vec3): this {
    const c = centroid(ring);
    const flip = dot3(ringNormal(ring), facing) < 0;
    for (let j = 0; j < ring.length; j++) {
      const a = ring[j];
      const b = ring[(j + 1) % ring.length];
      if (flip) this.tri(c, b, a);
      else this.tri(c, a, b);
    }
    return this;
  }

  /** Non-indexed geometry with normals; faces meeting at more than `creaseDeg` keep a sharp edge. */
  build(creaseDeg = 40): THREE.BufferGeometry {
    const src = this.p;
    // drop slivers without area: they have no normal
    const pos: number[] = [];
    const faceN: number[] = [];
    for (let i = 0; i < src.length; i += 9) {
      const a: Vec3 = [src[i], src[i + 1], src[i + 2]];
      const b: Vec3 = [src[i + 3], src[i + 4], src[i + 5]];
      const c: Vec3 = [src[i + 6], src[i + 7], src[i + 8]];
      const nrm = cross3(sub3(b, a), sub3(c, a));
      const len = Math.hypot(nrm[0], nrm[1], nrm[2]);
      if (len < 1e-10) continue;
      pos.push(...a, ...b, ...c);
      faceN.push(nrm[0] / len, nrm[1] / len, nrm[2] / len);
    }
    const corners = pos.length / 3;
    // corners that share a position, and the angle each face spans there (its weight)
    const at = new Map<string, number[]>();
    const weight = new Float32Array(corners);
    for (let c = 0; c < corners; c++) {
      const key = `${Math.round(pos[c * 3] * 1e4)}_${Math.round(pos[c * 3 + 1] * 1e4)}_${Math.round(pos[c * 3 + 2] * 1e4)}`;
      const list = at.get(key);
      if (list) list.push(c);
      else at.set(key, [c]);
      const f = c - (c % 3);
      const o: Vec3 = [pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]];
      const c1 = f + ((c - f + 1) % 3);
      const c2 = f + ((c - f + 2) % 3);
      const u = sub3([pos[c1 * 3], pos[c1 * 3 + 1], pos[c1 * 3 + 2]], o);
      const v = sub3([pos[c2 * 3], pos[c2 * 3 + 1], pos[c2 * 3 + 2]], o);
      const d = dot3(u, v) / (Math.hypot(u[0], u[1], u[2]) * Math.hypot(v[0], v[1], v[2]) || 1);
      weight[c] = Math.acos(Math.max(-1, Math.min(1, d)));
    }
    const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);
    const normal = new Float32Array(pos.length);
    for (const list of at.values()) {
      for (const c of list) {
        const f = Math.floor(c / 3) * 3;
        let x = 0;
        let y = 0;
        let z = 0;
        for (const o of list) {
          const g = Math.floor(o / 3) * 3;
          if (faceN[f] * faceN[g] + faceN[f + 1] * faceN[g + 1] + faceN[f + 2] * faceN[g + 2] < cosCrease) continue;
          x += faceN[g] * weight[o];
          y += faceN[g + 1] * weight[o];
          z += faceN[g + 2] * weight[o];
        }
        const len = Math.hypot(x, y, z) || 1;
        normal[c * 3] = x / len;
        normal[c * 3 + 1] = y / len;
        normal[c * 3 + 2] = z / len;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    return g;
  }
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function centroid(ring: Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const q of ring) {
    c[0] += q[0] / ring.length;
    c[1] += q[1] / ring.length;
    c[2] += q[2] / ring.length;
  }
  return c;
}

/** Normal of a closed ring (Newell): points at the viewer who sees the ring turn counter-clockwise. */
function ringNormal(ring: Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let j = 0; j < ring.length; j++) {
    const a = ring[j];
    const b = ring[(j + 1) % ring.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

class Geo {
  readonly pos: number[] = [];
  readonly idx: number[] = [];

  v(x: number, y: number, z: number): number {
    this.pos.push(x, y, z);
    return this.pos.length / 3 - 1;
  }

  /** Quad a,b,c,d wound so that its normal points along (nx,ny,nz). */
  quad(a: number[], b: number[], c: number[], d: number[], nx: number, ny: number, nz: number): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const flip = cx * nx + cy * ny + cz * nz < 0;
    const i0 = this.v(a[0], a[1], a[2]);
    const i1 = this.v(b[0], b[1], b[2]);
    const i2 = this.v(c[0], c[1], c[2]);
    const i3 = this.v(d[0], d[1], d[2]);
    if (flip) this.idx.push(i0, i2, i1, i0, i3, i2);
    else this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  /** Triangle wound so that its normal points along (nx,ny,nz). */
  tri(a: number[], b: number[], c: number[], nx: number, ny: number, nz: number): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const i0 = this.v(a[0], a[1], a[2]);
    const i1 = this.v(b[0], b[1], b[2]);
    const i2 = this.v(c[0], c[1], c[2]);
    if (cx * nx + cy * ny + cz * nz < 0) this.idx.push(i0, i2, i1);
    else this.idx.push(i0, i1, i2);
  }

  build(smooth = true): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setIndex(this.idx);
    if (smooth) {
      // weld coincident vertices so the loft shades smoothly
      const merged = mergeByPosition(g);
      merged.computeVertexNormals();
      return merged;
    }
    g.computeVertexNormals();
    return g;
  }
}

function mergeByPosition(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const map = new Map<string, number>();
  const out: number[] = [];
  const remap = new Uint32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 2000)}_${Math.round(pos.getY(i) * 2000)}_${Math.round(pos.getZ(i) * 2000)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      map.set(key, id);
    }
    remap[i] = id;
  }
  const idx = g.getIndex()!;
  const ni: number[] = [];
  for (let i = 0; i < idx.count; i += 3) {
    const a = remap[idx.getX(i)];
    const b = remap[idx.getX(i + 1)];
    const c = remap[idx.getX(i + 2)];
    if (a !== b && b !== c && a !== c) ni.push(a, b, c);
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
  m.setIndex(ni);
  return m;
}

export function buildCarShell(d: CarDims): CarShell {
  const hw = d.width / 2;
  const zF = -(d.wheelbase / 2 + d.frontOverhang);
  const zR = zF + d.length;
  const zAF = -d.wheelbase / 2;
  const zAR = d.wheelbase / 2;
  const H = d.height;
  const belt = H * 0.655;
  const zCowl = zAF + 0.36;
  const zRoofF = zCowl + 0.74;
  const zRoofR = d.tail === 1 ? zR - 0.42 : d.tail === 2 ? zAR - 0.25 : zAR - 0.02;
  const zTailTop = d.tail === 1 ? zR - 0.12 : d.tail === 2 ? zAR + 0.38 : zR - 0.32;
  const bootY = d.tail === 2 ? belt + 0.04 : belt + 0.02;

  const noCabin = (z: number, w: number, yb: number, top: number, crown = 0.03): Section => ({
    z,
    w,
    yb,
    ym: yb + (top - yb) * 0.55,
    ybelt: top - 0.015,
    wr: w * 0.86,
    yr: top,
    yc: top + crown,
  });
  const cabin = (z: number, wr: number, yr: number, yc: number, ybelt = belt): Section => ({
    z,
    w: hw,
    yb: 0.2,
    ym: 0.63,
    ybelt,
    wr,
    yr,
    yc,
  });
  // The bonnet falls away to the front and the windscreen starts low, below the
  // window sills: from the driver's seat the base of the screen then lies under
  // the line of sight over the bonnet, and the road shows from about 6 m on.
  const cowlTop = belt - 0.03;
  const cowlCrown = 0.03;
  const keys: Section[] = [
    noCabin(zF, hw * 0.8, 0.3, 0.66, 0.01),
    noCabin(zF + 0.09, hw * 0.93, 0.21, 0.72, 0.02),
    noCabin(zF + 0.36, hw * 0.985, 0.19, 0.785),
    noCabin(zAF, hw, 0.2, 0.88, 0.035),
    { ...noCabin(zCowl, hw, 0.2, cowlTop, cowlCrown), wr: hw * 0.9 },
    cabin(zRoofF, hw * 0.74, H - 0.055, H - 0.004),
    cabin((zRoofF + zRoofR) / 2, hw * 0.735, H - 0.045, H),
    cabin(zRoofR, hw * 0.72, H - 0.07, H - 0.022, belt + 0.02),
    { ...noCabin(zTailTop, hw * 0.985, 0.22, bootY + 0.01, 0.02), wr: hw * 0.82 },
    noCabin(zR - 0.1, hw * 0.94, 0.25, bootY - 0.05, 0.015),
    noCabin(zR, hw * 0.72, 0.33, bootY - 0.2, 0.005),
  ];

  // dense station list: key sections, pillar edges and wheel-arch samples
  const zs = new Set<number>();
  for (const k of keys) zs.add(k.z);
  const Ra = d.wheelRadius + 0.075;
  for (const za of [zAF, zAR]) {
    for (const f of [-1, -0.92, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 0.92, 1]) zs.add(za + f * Ra);
  }
  const zB = (zRoofF + zRoofR) / 2 - 0.02; // B pillar
  for (const z of [zB - 0.045, zB + 0.045, zRoofR - 0.17]) zs.add(z);
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1].z;
    const b = keys[i].z;
    const n = Math.ceil((b - a) / 0.22);
    for (let k = 1; k < n; k++) zs.add(a + ((b - a) * k) / n);
  }
  const zList = [...zs].filter((z) => z >= zF - 1e-6 && z <= zR + 1e-6).sort((p, q) => p - q);
  /** The cross-section at any z, blended between the key sections around it. */
  const sectionAt = (z: number): Section => {
    let i = 1;
    while (i < keys.length - 1 && keys[i].z < z) i++;
    const a = keys[i - 1];
    const b = keys[i];
    const s = lerpSec(a, b, Math.max(0, Math.min(1, (z - a.z) / (b.z - a.z))));
    s.z = z;
    return s;
  };
  const stations: Section[] = [];
  const keyZ = new Set(keys.map((k) => k.z));
  for (const z of zList) {
    if (stations.length && z - stations[stations.length - 1].z < 0.012) {
      // two stations nearly on top of each other: keep the key section (glass
      // and pillars start exactly there), otherwise the first one
      if (keyZ.has(z) && !keyZ.has(stations[stations.length - 1].z)) stations.pop();
      else continue;
    }
    stations.push(sectionAt(z));
  }

  /** Right-hand profile points of a station, bottom centre → roof centre. */
  const profile = (s: Section): number[][] => {
    let arch = 0;
    for (const za of [zAF, zAR]) {
      const dz = s.z - za;
      if (Math.abs(dz) < Ra) arch = Math.max(arch, d.wheelRadius * 0.93 + Math.sqrt(Ra * Ra - dz * dz) - 0.02);
    }
    const low = Math.max(s.yb, arch);
    const rocker = Math.max(s.yb + 0.13, arch);
    const ym = Math.max(s.ym, rocker + 0.02);
    return [
      [0, s.yb, s.z],
      [s.w * 0.8, low, s.z],
      [s.w * 0.985, rocker, s.z],
      [s.w, ym, s.z],
      [s.w * 0.975, Math.max(s.ybelt, ym + 0.02), s.z],
      [s.wr, s.yr, s.z],
      [0, s.yc, s.z],
    ];
  };

  const paint = new Geo();
  const glass = new Geo();
  const trim = new Geo();
  const lining = new Geo();
  const headliner = new Geo();
  const mirrorX = (p: number[]): number[] => [-p[0], p[1], p[2]];
  const eps = 1e-4;
  // cabin lining: a panel pulled 2.5 cm inwards, facing in (the floor is raised a little)
  const inset = (p: number[], k: number): number[] =>
    k === 0 ? [p[0], p[1] + 0.03, p[2]] : [p[0] - Math.sign(p[0]) * 0.025, p[1] - (k === 5 ? 0.025 : 0), p[2]];

  for (let i = 0; i < stations.length - 1; i++) {
    const A = profile(stations[i]);
    const B = profile(stations[i + 1]);
    const zm = (stations[i].z + stations[i + 1].z) / 2;
    const inCabin = zm > zCowl + eps && zm < zTailTop - eps;
    const underRoof = zm > zRoofF - eps && zm < zRoofR + eps;
    for (let k = 0; k < 6; k++) {
      // outward hint: sideways for the flanks, down for the floor, up for the top.  The sill
      // panel lies flat where it bridges a wheel arch: there "out" is down, towards the wheel.
      const nx = k === 0 ? 0 : k === 5 ? 0.25 : 1;
      const ny = k === 0 ? -1 : k === 5 ? 1 : k === 4 ? 0.45 : k === 1 ? -0.35 : 0;
      let target: Geo = paint;
      let glazed = false;
      if (k === 0) target = trim;
      else if (k === 4 && inCabin) {
        // side glazing with A, B and C pillars left in body colour
        const pillarB = Math.abs(zm - zB) < 0.045;
        const pillarC = zm > zRoofR - 0.17;
        const pillarA = zm < zRoofF + 0.02;
        if (!pillarA && !pillarB && !pillarC) glazed = true;
        // glass also beside the A pillar, down to where the gap to the sill closes
        if (pillarA && zm > zCowl + 0.12) glazed = true;
      } else if (k === 5 && inCabin && !underRoof) {
        glazed = true; // windscreen and rear window
      }
      if (glazed) target = glass;
      for (const side of [1, -1]) {
        const a0 = side > 0 ? A[k] : mirrorX(A[k]);
        const a1 = side > 0 ? A[k + 1] : mirrorX(A[k + 1]);
        const b0 = side > 0 ? B[k] : mirrorX(B[k]);
        const b1 = side > 0 ? B[k + 1] : mirrorX(B[k + 1]);
        target.quad(a0, a1, b1, b0, nx * side, ny, 0);
        if (!glazed) {
          const inner = inCabin && k >= 4 ? headliner : lining;
          inner.quad(inset(a0, k), inset(a1, k), inset(b1, k), inset(b0, k), -nx * side, -ny, 0);
        }
      }
    }
  }
  // nose and tail caps; inside, a bulkhead closes the cabin towards the engine and behind the boot
  // (taken at their exact places, not looked up among the stations: a station that was
  // dropped for lying too close to its neighbour must not move a pillar to the car's nose)
  const cowlStation = sectionAt(zCowl);
  const roofStation = sectionAt(zRoofF);
  const first = stations[0];
  const last = stations[stations.length - 1];
  for (const [s, nz, inside] of [
    [first, -1, false],
    [last, 1, false],
    [cowlStation, 1, true],
    [last, -1, true],
  ] as Array<[Section, number, boolean]>) {
    const P = profile(s);
    const cy = (s.yb + s.yc) / 2;
    // the inner panels stand a little inside the opening they close
    const z = inside ? s.z + nz * 0.012 : s.z;
    for (let k = 0; k < 6; k++) {
      for (const side of [1, -1]) {
        const p0 = side > 0 ? P[k] : mirrorX(P[k]);
        const p1 = side > 0 ? P[k + 1] : mirrorX(P[k + 1]);
        if (inside) {
          const q0 = inset(p0, k === 0 ? 0 : 1);
          const q1 = inset(p1, 1);
          lining.tri([0, cy, z], [q0[0], q0[1], z], [q1[0], q1[1], z], 0, 0, nz);
        } else paint.tri([0, cy, z], p0, p1, 0, 0, nz);
      }
    }
  }

  // ---- A pillars -------------------------------------------------------------
  // Slim wedges along the edges of the windscreen: two narrow faces lie on the
  // windscreen and on the side glass, the trim between them comes to a rounded
  // edge that points at the occupant on that side, who therefore looks at the
  // pillar end-on and loses as little of the view as a pillar can cost.
  const pc = profile(cowlStation);
  const pr = profile(roofStation);
  const pillarOut = new Sculpt();
  const pillarIn = new Sculpt();
  const lerp3 = (a: number[], b: number[], t: number, side: number): THREE.Vector3 =>
    new THREE.Vector3(side * (a[0] + (b[0] - a[0]) * t), a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  const v3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
  for (const side of [1, -1]) {
    const axis = lerp3(pc[5], pr[5], 1, side).sub(lerp3(pc[5], pr[5], 0, side)).normalize();
    // across the pillar: the part of `v` at right angles to it
    const across = (v: THREE.Vector3): THREE.Vector3 => v.addScaledVector(axis, -v.dot(axis)).normalize();
    const head = new THREE.Vector3(side * hw * 0.4, H - 0.26, zRoofF + 0.42);
    const outer: Vec3[][] = [];
    const inner: Vec3[][] = [];
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      // a little beyond both ends, so the pillar disappears into scuttle and roof
      const t = -0.05 + (1.1 * i) / steps;
      const edge = lerp3(pc[5], pr[5], t, side);
      const toMiddle = across(lerp3(pc[6], pr[6], t, side).sub(edge));
      const toSill = across(lerp3(pc[4], pr[4], t, side).sub(edge));
      const toHead = across(head.clone().sub(edge));
      // stouter at the foot and where it joins the roof
      const k = 1 + 0.55 * (1 - t) ** 3 + 0.25 * t ** 3;
      const corner = edge.clone().addScaledVector(toHead, -0.007);
      const onScreen = edge.clone().addScaledVector(toMiddle, 0.021 * k).addScaledVector(toHead, -0.004);
      const onSide = edge.clone().addScaledVector(toSill, 0.025 * k).addScaledVector(toHead, -0.004);
      const flankScreen = edge.clone().addScaledVector(toMiddle, 0.017 * k).addScaledVector(toHead, 0.02 * k);
      const flankSide = edge.clone().addScaledVector(toSill, 0.02 * k).addScaledVector(toHead, 0.02 * k);
      const nose = edge.clone().addScaledVector(toMiddle, 0.005 * k).addScaledVector(toSill, 0.006 * k).addScaledVector(toHead, 0.038 * k);
      outer.push([v3(onSide), v3(corner), v3(onScreen)]);
      inner.push([v3(onScreen), v3(flankScreen), v3(nose), v3(flankSide), v3(onSide)]);
    }
    pillarOut.sheet(outer, [side, 0.3, -0.4]);
    pillarIn.sheet(inner, [-side, -0.3, 0.6]);
  }

  // outlines of the flat end faces, for whatever is fixed to the bumpers
  const outline = (s: Section): number[][] => profile(s).map((q) => [q[0], q[1]]);

  return {
    paint: paint.build(),
    glass: glass.build(),
    trim: trim.build(),
    lining: lining.build(),
    headliner: headliner.build(),
    pillars: pillarOut.build(50),
    pillarTrim: pillarIn.build(70),
    zFront: zF,
    zRear: zR,
    zAxleF: zAF,
    zAxleR: zAR,
    zCowl,
    zRoofFront: zRoofF,
    zRoofRear: zRoofR,
    zPillarB: zB,
    zTail: zTailTop,
    halfWidth: hw,
    beltY: belt,
    roofY: H,
    cowlY: cowlTop,
    cowlCrownY: cowlTop + cowlCrown,
    noseOutline: outline(first),
    tailOutline: outline(last),
  };
}

/** A wheel lying along the X axis (rotate about X to spin). */
export function buildWheel(d: CarDims): { tyre: THREE.BufferGeometry; rim: THREE.BufferGeometry } {
  const r = d.wheelRadius;
  const w = d.tyreWidth;
  const tyre = new THREE.CylinderGeometry(r, r, w, 20, 1, false).rotateZ(Math.PI / 2);
  const rimParts: THREE.BufferGeometry[] = [];
  const disc = new THREE.CylinderGeometry(r * 0.66, r * 0.66, w * 1.02, 14, 1, false).rotateZ(Math.PI / 2);
  rimParts.push(disc);
  const g = disc;
  // five chunky spokes stand proud of the disc so the rotation is visible
  const spokes: THREE.BufferGeometry[] = [g];
  for (let i = 0; i < 5; i++) {
    const s = new THREE.BoxGeometry(w * 1.06, r * 0.6, r * 0.16).translate(0, r * 0.34, 0).rotateX((i / 5) * Math.PI * 2);
    spokes.push(s);
  }
  const pos: number[] = [];
  const idx: number[] = [];
  for (const sg of spokes) {
    const p = sg.getAttribute('position');
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
    const ix = sg.getIndex()!;
    for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
  }
  const rim = new THREE.BufferGeometry();
  rim.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  rim.setIndex(idx);
  rim.computeVertexNormals();
  tyre.deleteAttribute('uv');
  return { tyre, rim };
}
