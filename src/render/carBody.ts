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
  /** inward-facing copy of the opaque shell (cabin lining), without the glazing */
  lining: THREE.BufferGeometry;
  /** A pillars: solid bars along the windscreen edges, seen from inside and outside */
  pillars: THREE.BufferGeometry;
  /** z of front and rear axle, bumper tips, cabin landmarks */
  zFront: number;
  zRear: number;
  zAxleF: number;
  zAxleR: number;
  zCowl: number;
  zRoofFront: number;
  zRoofRear: number;
  halfWidth: number;
  beltY: number;
  roofY: number;
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
  const keys: Section[] = [
    noCabin(zF, hw * 0.8, 0.3, 0.66, 0.01),
    noCabin(zF + 0.09, hw * 0.93, 0.21, 0.72, 0.02),
    noCabin(zF + 0.36, hw * 0.985, 0.19, 0.8),
    noCabin(zAF, hw, 0.2, 0.9, 0.035),
    { ...noCabin(zCowl, hw, 0.2, belt + 0.035, 0.03), wr: hw * 0.9 },
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
  const stations: Section[] = [];
  for (const z of zList) {
    if (stations.length && z - stations[stations.length - 1].z < 0.012) continue;
    let i = 1;
    while (i < keys.length - 1 && keys[i].z < z) i++;
    const a = keys[i - 1];
    const b = keys[i];
    stations.push(lerpSec(a, b, Math.max(0, Math.min(1, (z - a.z) / (b.z - a.z)))));
    stations[stations.length - 1].z = z;
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
  const mirrorX = (p: number[]): number[] => [-p[0], p[1], p[2]];
  const eps = 1e-4;

  for (let i = 0; i < stations.length - 1; i++) {
    const A = profile(stations[i]);
    const B = profile(stations[i + 1]);
    const zm = (stations[i].z + stations[i + 1].z) / 2;
    const inCabin = zm > zCowl + eps && zm < zTailTop - eps;
    const underRoof = zm > zRoofF - eps && zm < zRoofR + eps;
    for (let k = 0; k < 6; k++) {
      // outward hint: sideways for the flanks, down for the floor, up for the top
      const nx = k === 0 ? 0 : k === 5 ? 0.25 : 1;
      const ny = k === 0 ? -1 : k === 5 ? 1 : k === 4 ? 0.45 : 0;
      let target: Geo = paint;
      let glazed = false;
      if (k === 0) target = trim;
      else if (k === 4 && inCabin) {
        // side glazing with A, B and C pillars left in body colour
        const pillarB = Math.abs(zm - zB) < 0.045;
        const pillarC = zm > zRoofR - 0.17;
        const pillarA = zm < zRoofF + 0.02;
        if (!pillarA && !pillarB && !pillarC) glazed = true;
        if (pillarA && zm > zCowl + 0.3) glazed = true; // quarter light behind the A pillar
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
          // cabin lining: same panel pulled 2.5 cm inwards, facing in (the floor is raised a little)
          const inset = (p: number[]): number[] =>
            k === 0 ? [p[0], p[1] + 0.03, p[2]] : [p[0] - Math.sign(p[0]) * 0.025, p[1] - (k === 5 ? 0.025 : 0), p[2]];
          lining.quad(inset(a0), inset(a1), inset(b1), inset(b0), -nx * side, -ny, 0);
        }
      }
    }
  }
  // nose and tail caps
  for (const [s, nz] of [
    [stations[0], -1],
    [stations[stations.length - 1], 1],
  ] as Array<[Section, number]>) {
    const P = profile(s);
    const cy = (s.yb + s.yc) / 2;
    for (let k = 0; k < 6; k++) {
      for (const side of [1, -1]) {
        const p0 = side > 0 ? P[k] : mirrorX(P[k]);
        const p1 = side > 0 ? P[k + 1] : mirrorX(P[k + 1]);
        paint.tri([0, cy, s.z], p0, p1, 0, 0, nz);
      }
    }
  }

  // A pillars from the cowl corners up to the roof corners
  const cowl = profile(stations.find((st) => Math.abs(st.z - zCowl) < 1e-6) ?? stations[0])[5];
  const roofF = profile(stations.find((st) => Math.abs(st.z - zRoofF) < 1e-6) ?? stations[0])[5];
  const pillarParts: THREE.BufferGeometry[] = [];
  for (const side of [1, -1]) {
    const a = new THREE.Vector3(side * (cowl[0] - 0.02), cowl[1] - 0.03, cowl[2] + 0.02);
    const b = new THREE.Vector3(side * (roofF[0] - 0.005), roofF[1], roofF[2] + 0.01);
    const len = a.distanceTo(b);
    const g = new THREE.BoxGeometry(0.06, len, 0.06);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.applyQuaternion(q);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    g.translate(mid.x, mid.y, mid.z);
    g.deleteAttribute('uv');
    pillarParts.push(g.toNonIndexed());
  }
  const pillarPos: number[] = [];
  for (const g of pillarParts) pillarPos.push(...(g.getAttribute('position').array as Float32Array));
  const pillars = new THREE.BufferGeometry();
  pillars.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pillarPos), 3));
  pillars.computeVertexNormals();

  return {
    paint: paint.build(),
    glass: glass.build(),
    trim: trim.build(),
    lining: lining.build(),
    pillars,
    zFront: zF,
    zRear: zR,
    zAxleF: zAF,
    zAxleR: zAR,
    zCowl,
    zRoofFront: zRoofF,
    zRoofRear: zRoofR,
    halfWidth: hw,
    beltY: belt,
    roofY: H,
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
