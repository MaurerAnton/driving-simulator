// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The parts of the player's car that open: the four side doors, the bonnet
 * and the tailgate (game/cardoors.ts has the logic of them).
 *
 * The body is one shell (render/carBody.ts).  The parts are cut out of it
 * along their panel lines – the ones the finer model draws as gaps
 * (render/cardetail.ts): each door from the sill up to the edge of the
 * roof, with its window, the rear door round the wheel arch; the bonnet
 * between the top of the wings, from the scuttle to the nose; the tailgate
 * with the rear window, from the roof down over the tail.  A triangle that
 * a panel line crosses is split along it (its normals taken across as they
 * are), so the pieces show exactly the surface the whole shell did.  What
 * is fixed to a part goes with it: the door panels inside, the door
 * mirrors, and on "very high" graphics the handles, seals and switches.
 *
 * Each part hangs on its hinge: a door at its front edge (it swings out
 * about 65°), the bonnet at the scuttle, the tailgate at the roof (both
 * lift).  Behind an opened part the opening shows its edges dark, the
 * bonnet an engine bay.
 *
 * Cheap while shut: as long as every part is shut, nothing here is drawn –
 * the car is drawn as it always was, from its whole meshes.  Only once a
 * part opens do those meshes take the shell without the parts, and the
 * parts are drawn on their hinges.
 */
import * as THREE from 'three';
import { bodyProfile } from './carBody.ts';
import type { CarDims, CarShell } from './carBody.ts';
import type { Mirror } from './mirrors.ts';

/** the parts, in the order of game/cardoors.ts CAR_OPENINGS */
const FL = 0;
const FR = 1;
const RL = 2;
const RR = 3;
const BONNET = 4;
const BOOT = 5;
const PARTS = 6;

/** how far each part opens (radians) */
const DOOR_ANGLE = (65 * Math.PI) / 180;
const BONNET_ANGLE = (52 * Math.PI) / 180;
const BOOT_ANGLE = (78 * Math.PI) / 180;

/** What of the player's car the parts are taken from (render/car.ts PlayerCar). */
export interface OpeningsHost {
  root: THREE.Group;
  exterior: { group: THREE.Group; shell: CarShell; dims: CarDims };
  cockpit: THREE.Group;
  mirrors: readonly Mirror[];
  /** the door panels inside: their material's mesh as a whole, without them, and each door's own (fl fr rl rr) */
  doorTrim: ReadonlyArray<{ mesh: THREE.Mesh; rest: THREE.BufferGeometry | null; doors: ReadonlyArray<THREE.BufferGeometry | null> }>;
  /** take a new mesh into the see-through cabin */
  register(mesh: THREE.Mesh): void;
}

// ------------------------------------------------------------------ panel lines ----

type P2 = [number, number];

/** Linear through points [t, value] sorted by t (held at the ends). */
function along(pts: readonly P2[], t: number): number {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [t1, v1] = pts[i];
    if (t <= t1) {
      const [t0, v0] = pts[i - 1];
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0 || 1);
    }
  }
  return pts[pts.length - 1][1];
}

/** Where the parts end: the lines of the finer model's panel gaps (render/cardetail.ts). */
export interface PanelLines {
  /** the front doors from zFD to zB, the rear doors from zB to zRD below the window and to zRW beside it, all above `sill` */
  zFD: number;
  zB: number;
  zRD: number;
  zRW: number;
  sill: number;
  /** the rear door's edge round the wheel arch: [y, z] from the sill up */
  arch: P2[];
  /** the bonnet from bz0 to bz1, out to its edge [z, x] */
  bz0: number;
  bz1: number;
  bonnetEdge: P2[];
  /** the tailgate from tz0 back, out to its edge [z, x] behind the rear window, down to `tailSill` on the tail */
  tz0: number;
  tailEdge: P2[];
  tailSill: number;
  zTail: number;
  zRear: number;
  belt: number;
}

export function panelLines(sh: CarShell, d: CarDims): PanelLines {
  const at = bodyProfile(d);
  const zRD = sh.zAxleR - 0.255;
  const bz0 = sh.zFront + 0.105;
  const bz1 = sh.zCowl - 0.09;
  // (the same points the gap is drawn through)
  const bonnetEdge: P2[] = [];
  for (let z = bz1; z > sh.zFront + 0.1; z -= 0.08) bonnetEdge.push([z, at(z)[5][0] - 0.05]);
  bonnetEdge.push([bz0, at(bz0)[5][0] - 0.05]);
  bonnetEdge.reverse();
  const zt = sh.zTail;
  return {
    zFD: sh.zCowl + 0.105,
    zB: sh.zPillarB,
    zRD,
    zRW: sh.zRoofRear - 0.17,
    sill: 0.37,
    arch: [
      [0.37, zRD - 0.16],
      [0.42, zRD - 0.13],
      [0.55, zRD - 0.07],
      [0.63, zRD],
    ],
    bz0,
    bz1,
    bonnetEdge,
    tz0: sh.zRoofRear + 0.01,
    tailEdge: [
      [zt, at(zt)[5][0]],
      [zt + 0.07, 0.4],
      [sh.zRear - 0.06, 0.385],
      [sh.zRear + 0.01, 0.385],
    ],
    tailSill: 0.745,
    zTail: zt,
    zRear: sh.zRear,
    belt: sh.beltY,
  };
}

/** Distances from (|x|, y) to the six segments of the body's outline at z: 0 floor … 4 side window, 5 roof/bonnet/boot. */
function segmentDistances(profile: number[][], ax: number, y: number, out: number[]): number[] {
  for (let k = 0; k < 6; k++) {
    const [x0, y0] = profile[k];
    const [x1, y1] = profile[k + 1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((ax - x0) * dx + (y - y0) * dy) / l2)) : 0;
    out[k] = Math.hypot(ax - (x0 + dx * t), y - (y0 + dy * t));
  }
  return out;
}

/** How far (|x|, y) lies outside segment k of the outline (negative: inside). */
function outside(profile: number[][], k: number, ax: number, y: number): number {
  const [x0, y0] = profile[k];
  const [x1, y1] = profile[k + 1];
  // (the outline runs counter-clockwise: outwards is to the right of it)
  const l = Math.hypot(x1 - x0, y1 - y0) || 1;
  return ((ax - x0) * (y1 - y0) - (y - y0) * (x1 - x0)) / l;
}

function nearest(ds: readonly number[]): number {
  let k = 0;
  for (let i = 1; i < ds.length; i++) if (ds[i] < ds[k]) k = i;
  return k;
}

/**
 * Which part a point of the shell belongs to (−1: the body).  `k`: the
 * segment of the outline it lies on, `cap`: on the flat face of the tail.
 */
export function shellPart(L: PanelLines, x: number, y: number, z: number, k: number, cap: boolean): number {
  const ax = Math.abs(x);
  const s = x < 0 ? 0 : 1;
  if (cap) return z > L.zRear - 0.006 && y >= L.tailSill && ax <= 0.385 ? BOOT : -1;
  if (k >= 1 && k <= 4 && y >= L.sill) {
    if (z >= L.zFD && z <= L.zB) return FL + s;
    if (z > L.zB && (k === 4 ? z <= L.zRW : z <= along(L.arch, y))) return RL + s;
  }
  if (k === 5) {
    if (z >= L.bz0 && z <= L.bz1 && ax <= along(L.bonnetEdge, z)) return BONNET;
    if (z >= L.tz0 && (z <= L.zTail || ax <= along(L.tailEdge, z))) return BOOT;
  }
  return -1;
}

/** The planes the shell is cut along: n·p = d, applied to triangles that reach into `box`. */
interface Cut {
  n: [number, number, number];
  d: number;
  box: [number, number, number, number, number, number] | null;
}

function shellCuts(L: PanelLines): Cut[] {
  const cuts: Cut[] = [];
  const zPlane = (z: number): void => void cuts.push({ n: [0, 0, 1], d: z, box: null });
  for (const z of [L.zFD, L.zB, L.zRD, L.zRW, L.bz0, L.bz1, L.tz0]) zPlane(z);
  cuts.push({ n: [0, 1, 0], d: L.sill, box: [-9, 0, L.zFD - 0.3, 9, 1, L.zRD + 0.3] });
  cuts.push({ n: [0, 1, 0], d: L.tailSill, box: [-0.6, 0.6, L.zRear - 0.02, 0.6, 0.9, L.zRear + 0.02] });
  // round the wheel arch: planes across the car through each piece of the edge (in y and z)
  for (let i = 0; i + 1 < L.arch.length; i++) {
    const [y0, z0] = L.arch[i];
    const [y1, z1] = L.arch[i + 1];
    const n: [number, number, number] = [0, z1 - z0, -(y1 - y0)];
    const l = Math.hypot(n[1], n[2]);
    n[1] /= l;
    n[2] /= l;
    cuts.push({ n, d: n[1] * y0 + n[2] * z0, box: [-9, y0 - 0.05, Math.min(z0, z1) - 0.05, 9, Math.max(y1, 0.66) + 0.05, Math.max(z0, z1) + 0.05] });
  }
  // the edges of the bonnet and of the tailgate: upright planes through each piece, on both sides
  const edge = (pts: readonly P2[], yLow: number): void => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [za, xa] = pts[i];
      const [zb, xb] = pts[i + 1];
      for (const s of [-1, 1]) {
        const n: [number, number, number] = [zb - za, 0, -(s * xb - s * xa)];
        const l = Math.hypot(n[0], n[2]);
        n[0] /= l;
        n[2] /= l;
        const x0 = Math.min(s * xa, s * xb);
        const x1 = Math.max(s * xa, s * xb);
        cuts.push({ n, d: n[0] * s * xa + n[2] * za, box: [x0 - 0.05, yLow, Math.min(za, zb) - 0.01, x1 + 0.05, 3, Math.max(za, zb) + 0.01] });
      }
    }
  };
  edge(L.bonnetEdge, L.belt - 0.35);
  edge(L.tailEdge, 0.6);
  for (const s of [-1, 1]) cuts.push({ n: [1, 0, 0], d: s * 0.385, box: [s * 0.385 - 0.01, L.tailSill - 0.01, L.zRear - 0.02, s * 0.385 + 0.01, 0.9, L.zRear + 0.02] });
  return cuts;
}

// ----------------------------------------------------------------- triangle soup ----

/** The triangles of a geometry with every attribute, to be cut and sorted. */
class Soup {
  readonly names: string[] = [];
  readonly sizes: number[] = [];
  readonly data: number[][] = [];
  tris: number[] = [];
  /** vertices made where a triangle was cut (for mending the edges of its neighbours) */
  readonly made: number[] = [];

  constructor(g: THREE.BufferGeometry) {
    for (const name of Object.keys(g.attributes)) {
      const a = g.getAttribute(name);
      if (!(a instanceof THREE.BufferAttribute)) continue;
      this.names.push(name);
      this.sizes.push(a.itemSize);
      const out: number[] = [];
      for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out.push(a.getComponent(i, c));
      this.data.push(out);
    }
    const idx = g.getIndex();
    const n = idx ? idx.count : g.getAttribute('position').count;
    for (let i = 0; i < n; i++) this.tris.push(idx ? idx.getX(i) : i);
  }

  pos(i: number): [number, number, number] {
    const d = this.data[this.names.indexOf('position')];
    return [d[i * 3], d[i * 3 + 1], d[i * 3 + 2]];
  }

  /** A new vertex between i and j (every attribute interpolated: normals stay as the surface had them). */
  lerp(i: number, j: number, t: number): number {
    const id = this.data[0].length / this.sizes[0];
    this.data.forEach((d, a) => {
      const s = this.sizes[a];
      for (let c = 0; c < s; c++) d.push(d[i * s + c] + (d[j * s + c] - d[i * s + c]) * t);
    });
    this.made.push(id);
    return id;
  }

  /** The geometry of the triangles `list` (indices into tris / 3). */
  build(list: readonly number[]): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const remap = new Map<number, number>();
    const index: number[] = [];
    const out = this.data.map(() => [] as number[]);
    for (const t of list) {
      for (let c = 0; c < 3; c++) {
        const v = this.tris[t * 3 + c];
        let r = remap.get(v);
        if (r === undefined) {
          r = remap.size;
          remap.set(v, r);
          this.data.forEach((d, a) => {
            const s = this.sizes[a];
            for (let k = 0; k < s; k++) out[a].push(d[v * s + k]);
          });
        }
        index.push(r);
      }
    }
    this.names.forEach((name, a) => g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(out[a]), this.sizes[a])));
    g.setIndex(index);
    g.computeBoundingSphere();
    return g;
  }
}

/** Cut every triangle of the soup that `cut` passes through (and that reaches into its box) in two along it. */
function cutSoup(s: Soup, cut: Cut): void {
  const pi = s.names.indexOf('position');
  const P = s.data[pi];
  const [nx, ny, nz] = cut.n;
  const out: number[] = [];
  const b = cut.box;
  const tris = s.tris;
  const v = [0, 0, 0];
  const d = [0, 0, 0];
  for (let t = 0; t < tris.length; t += 3) {
    const i0 = tris[t];
    const i1 = tris[t + 1];
    const i2 = tris[t + 2];
    if (b) {
      let inBox = true;
      for (let c = 0; c < 3 && inBox; c++) {
        const p0 = P[i0 * 3 + c];
        const p1 = P[i1 * 3 + c];
        const p2 = P[i2 * 3 + c];
        if (Math.max(p0, p1, p2) < b[c] || Math.min(p0, p1, p2) > b[c + 3]) inBox = false;
      }
      if (!inBox) {
        out.push(i0, i1, i2);
        continue;
      }
    }
    v[0] = i0;
    v[1] = i1;
    v[2] = i2;
    let pos = false;
    let neg = false;
    for (let k = 0; k < 3; k++) {
      const i = v[k];
      const x = P[i * 3] * nx + P[i * 3 + 1] * ny + P[i * 3 + 2] * nz - cut.d;
      d[k] = Math.abs(x) < 1e-7 ? 0 : x;
      if (d[k] > 0) pos = true;
      if (d[k] < 0) neg = true;
    }
    if (!pos || !neg) {
      out.push(i0, i1, i2);
      continue;
    }
    // the two sides as polygons (in the triangle's order, so they keep its winding)
    const front: number[] = [];
    const back: number[] = [];
    for (let k = 0; k < 3; k++) {
      const i = v[k];
      const j = v[(k + 1) % 3];
      const di = d[k];
      const dj = d[(k + 1) % 3];
      if (di >= 0) front.push(i);
      if (di <= 0) back.push(i);
      if ((di > 0 && dj < 0) || (di < 0 && dj > 0)) {
        const m = s.lerp(i, j, di / (di - dj));
        front.push(m);
        back.push(m);
      }
    }
    for (const poly of [front, back]) for (let k = 1; k + 1 < poly.length; k++) out.push(poly[0], poly[k], poly[k + 1]);
  }
  s.tris = out;
}

/**
 * Mend the edges where a neighbour was cut and this triangle was not (a
 * vertex of the cut lies on its edge): split it there too, so no hairline
 * crack can open between them.
 */
function mendSoup(s: Soup): void {
  if (s.made.length === 0) return;
  const P = s.data[s.names.indexOf('position')];
  // the vertices made, in cells of 5 cm
  const cell = 0.05;
  const grid = new Map<number, number[]>();
  // (the car is within ±25 m of its middle)
  const key = (x: number, y: number, z: number): number => ((Math.floor(x / cell) + 512) * 1024 + Math.floor(y / cell) + 512) * 1024 + Math.floor(z / cell) + 512;
  for (const m of s.made) {
    const k = key(P[m * 3], P[m * 3 + 1], P[m * 3 + 2]);
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(m);
  }
  const queue = s.tris.slice();
  const out: number[] = [];
  let guard = 0;
  while (queue.length) {
    const c = queue.pop()!;
    const b = queue.pop()!;
    const a = queue.pop()!;
    let split = false;
    const v = [a, b, c];
    for (let e = 0; e < 3 && !split && guard < 200000; e++) {
      const i = v[e];
      const j = v[(e + 1) % 3];
      const ix = P[i * 3];
      const iy = P[i * 3 + 1];
      const iz = P[i * 3 + 2];
      const dx = P[j * 3] - ix;
      const dy = P[j * 3 + 1] - iy;
      const dz = P[j * 3 + 2] - iz;
      const l2 = dx * dx + dy * dy + dz * dz;
      if (l2 < 1e-10) continue;
      // the cells along the edge
      const n = Math.ceil(Math.sqrt(l2) / cell) + 1;
      let last = -1;
      for (let q = 0; q <= n && !split; q++) {
        const t = q / n;
        const k = key(ix + dx * t, iy + dy * t, iz + dz * t);
        if (k === last) continue;
        last = k;
        for (const m of grid.get(k) ?? []) {
          if (m === i || m === j) continue;
          const mx = P[m * 3] - ix;
          const my = P[m * 3 + 1] - iy;
          const mz = P[m * 3 + 2] - iz;
          const u = (mx * dx + my * dy + mz * dz) / l2;
          if (u <= 1e-6 || u >= 1 - 1e-6) continue;
          const ex = mx - dx * u;
          const ey = my - dy * u;
          const ez = mz - dz * u;
          if (ex * ex + ey * ey + ez * ez > 1e-12) continue;
          // the point on this triangle's own edge, its attributes from this triangle's own corners
          const w = s.lerp(i, j, u);
          s.made.pop();
          const o = v[(e + 2) % 3];
          queue.push(i, w, o, w, j, o);
          split = true;
          guard++;
          break;
        }
      }
    }
    if (!split) out.push(a, b, c);
  }
  s.tris = out;
}

// ------------------------------------------------------------------- the parts ----

interface Swap {
  mesh: THREE.Mesh;
  whole: THREE.BufferGeometry;
  body: THREE.BufferGeometry;
  parts: Array<THREE.Mesh | null>;
}

const DARK = new THREE.MeshLambertMaterial({ color: 0x141518, side: THREE.DoubleSide });
const BAY = new THREE.MeshLambertMaterial({ color: 0x2a2c30 });
const BAY_METAL = new THREE.MeshLambertMaterial({ color: 0x6d7278 });
const CAP = new THREE.MeshLambertMaterial({ color: 0xd8b21c });
const EMPTY = new THREE.BufferGeometry();

/** Swap a mesh's geometry – and that of its twin in the see-through cabin, which draws the same. */
function setGeometry(mesh: THREE.Mesh, from: THREE.BufferGeometry, to: THREE.BufferGeometry): void {
  if (mesh.geometry === to) return;
  mesh.geometry = to;
  for (const c of mesh.children) if (c instanceof THREE.Mesh && c.geometry === from) c.geometry = to;
}

/** Whether a mesh is part of the see-through cabin (it has a twin that draws its depth). */
function ghosted(mesh: THREE.Mesh): boolean {
  return mesh.children.some((c) => c instanceof THREE.Mesh && c.geometry === mesh.geometry);
}

export class CarOpenings {
  private readonly host: OpeningsHost;
  private readonly L: PanelLines;
  private readonly profile: (z: number) => number[][];
  private readonly pivots: THREE.Group[] = [];
  private readonly holders: THREE.Group[] = [];
  private readonly swaps: Swap[] = [];
  /** what is shown only while its part is open: the dark edges of the opening, the engine bay */
  private readonly shows: Array<{ obj: THREE.Object3D; part: number }> = [];
  private readonly values = new Float32Array(PARTS);
  private split = false;
  private readonly ds = [0, 0, 0, 0, 0, 0];

  constructor(host: OpeningsHost) {
    this.host = host;
    const sh = host.exterior.shell;
    const L = (this.L = panelLines(sh, host.exterior.dims));
    this.profile = bodyProfile(host.exterior.dims);
    const at = this.profile;
    const hw = sh.halfWidth;
    const hinges: Array<[number, number, number]> = [
      [-hw, 0, L.zFD],
      [hw, 0, L.zFD],
      [-hw, 0, L.zB],
      [hw, 0, L.zB],
      [0, at(L.bz1)[6][1], L.bz1],
      [0, at(L.tz0)[6][1], L.tz0],
    ];
    for (const [x, y, z] of hinges) {
      const pivot = new THREE.Group();
      pivot.name = 'opening';
      pivot.position.set(x, y, z);
      const holder = new THREE.Group();
      holder.position.set(-x, -y, -z);
      pivot.add(holder);
      host.root.add(pivot);
      this.pivots.push(pivot);
      this.holders.push(holder);
    }

    // ---- the shell, cut along the panel lines ----
    const cuts = shellCuts(L);
    const sources: Array<[THREE.BufferGeometry, boolean]> = [
      [sh.paint, true],
      [sh.glass, true],
      [sh.lining, false],
      [sh.headliner, false],
    ];
    const meshes: THREE.Mesh[] = [];
    host.root.traverse((o) => {
      if (o instanceof THREE.Mesh && !(o.parent && this.holders.includes(o.parent as THREE.Group))) meshes.push(o);
    });
    // edges round each part, and round the openings in the body, for the dark strips
    const partEdges: number[][] = Array.from({ length: PARTS }, () => []);
    const bodyEdges: number[][] = Array.from({ length: PARTS }, () => []);
    const skins: Array<{ soup: Soup; region: Int8Array }> = [];
    for (const [geo, skin] of sources) {
      const mesh = meshes.find((m) => m.geometry === geo);
      if (!mesh) continue;
      const soup = new Soup(geo);
      for (const c of cuts) cutSoup(soup, c);
      mendSoup(soup);
      const region = this.classifyShell(soup);
      this.addSwap(mesh, soup, region);
      if (skin) skins.push({ soup, region });
    }
    this.collectEdges(skins, partEdges, bodyEdges);
    for (let p = 0; p < PARTS; p++) {
      const own = this.strips(partEdges[p]);
      if (own) {
        const m = new THREE.Mesh(own, DARK);
        m.name = 'opening edge';
        this.holders[p].add(m);
        this.shows.push({ obj: m, part: p });
      }
      const hole = this.strips(bodyEdges[p]);
      if (hole) {
        const m = new THREE.Mesh(hole, DARK);
        m.name = 'opening frame';
        host.exterior.group.add(m);
        this.shows.push({ obj: m, part: p });
      }
    }

    // ---- the door panels inside ----
    for (const t of host.doorTrim) {
      const parts = t.doors.map((g, i) => (g ? this.partMesh(t.mesh, g, i) : null));
      this.swaps.push({ mesh: t.mesh, whole: t.mesh.geometry, body: t.rest ?? EMPTY, parts: [...parts, null, null] });
    }

    // ---- the door mirrors go with the front doors ----
    for (const m of host.mirrors) {
      const side = m.spec.name === 'left' ? FL : m.spec.name === 'right' ? FR : -1;
      if (side < 0) continue;
      this.holders[side].add(m.mesh);
      const housing = host.cockpit.getObjectByName(`mirror housing ${m.spec.name}`);
      if (housing) this.holders[side].add(housing);
    }
    const feet = host.cockpit.getObjectByName('mirror feet');
    if (feet instanceof THREE.Mesh) this.addVolume(feet);

    // ---- the engine bay under the bonnet ----
    const bay = this.engineBay();
    host.exterior.group.add(bay);
    this.shows.push({ obj: bay, part: BONNET });
    this.pose(this.values);
  }

  /** The finer model's meshes (render/cardetail.ts): what lies on a part goes with it. */
  addDetail(objects: readonly THREE.Object3D[]): void {
    for (const o of objects) if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh)) this.addVolume(o);
    this.pose(this.values);
  }

  /** How far each part is open (fl fr rl rr bonnet boot), 0 … 1. */
  pose(values: ArrayLike<number>): void {
    let any = false;
    for (let i = 0; i < PARTS; i++) {
      const v = Math.max(0, Math.min(1, values[i] ?? 0));
      this.values[i] = v;
      if (v > 0) any = true;
    }
    if (any !== this.split) {
      this.split = any;
      for (const s of this.swaps) setGeometry(s.mesh, any ? s.whole : s.body, any ? s.body : s.whole);
    }
    for (const s of this.swaps) for (const p of s.parts) if (p) p.visible = any && s.mesh.visible;
    for (const s of this.shows) s.obj.visible = this.values[s.part] > 0;
    for (let i = 0; i < PARTS; i++) {
      const v = this.values[i];
      const e = v * v * (3 - 2 * v);
      const pv = this.pivots[i];
      if (i <= RR) pv.rotation.y = (i % 2 === 0 ? -1 : 1) * DOOR_ANGLE * e;
      else if (i === BONNET) pv.rotation.x = BONNET_ANGLE * e;
      else pv.rotation.x = -BOOT_ANGLE * e;
    }
  }

  // ---------------------------------------------------------------- building ----

  /** Which part each triangle of the cut shell lies on (−1: the body). */
  private classifyShell(soup: Soup): Int8Array {
    const n = soup.tris.length / 3;
    const out = new Int8Array(n);
    for (let t = 0; t < n; t++) {
      const [a, b, c] = [soup.pos(soup.tris[t * 3]), soup.pos(soup.tris[t * 3 + 1]), soup.pos(soup.tris[t * 3 + 2])];
      out[t] = this.shellAt(a, b, c);
    }
    return out;
  }

  private shellAt(a: number[], b: number[], c: number[]): number {
    const x = (a[0] + b[0] + c[0]) / 3;
    const y = (a[1] + b[1] + c[1]) / 3;
    const z = (a[2] + b[2] + c[2]) / 3;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    // (the flat face of the tail – and the panel just inside it, which stays)
    const cap = Math.abs(nz) / nl > 0.97 && z > this.L.zRear - 0.03;
    return this.pointPart(x, y, z, cap);
  }

  /** Which part a point of the shell belongs to. */
  private pointPart(x: number, y: number, z: number, cap: boolean): number {
    const k = nearest(segmentDistances(this.profile(z), Math.abs(x), y, this.ds));
    return shellPart(this.L, x, y, z, k, cap);
  }

  /** A part's own mesh of a geometry, like `src` (material, shadow, order; in the see-through cabin if it is). */
  private partMesh(src: THREE.Mesh, geo: THREE.BufferGeometry, part: number): THREE.Mesh {
    const m = new THREE.Mesh(geo, src.material);
    m.name = `${src.name || 'part'} (opening)`;
    m.castShadow = src.castShadow;
    m.receiveShadow = src.receiveShadow;
    m.renderOrder = src.renderOrder;
    m.visible = false;
    this.holders[part].add(m);
    if (ghosted(src)) this.host.register(m);
    return m;
  }

  private addSwap(mesh: THREE.Mesh, soup: Soup, region: Int8Array): void {
    const lists: number[][] = Array.from({ length: PARTS + 1 }, () => []);
    region.forEach((r, t) => lists[r + 1].push(t));
    if (lists.slice(1).every((l) => l.length === 0)) return;
    const parts = lists.slice(1).map((l, p) => (l.length ? this.partMesh(mesh, soup.build(l), p) : null));
    this.swaps.push({ mesh, whole: mesh.geometry, body: soup.build(lists[0]), parts });
  }

  /** A mesh fixed to the body or to a part: each triangle goes where its middle lies (not cut). */
  private addVolume(mesh: THREE.Mesh): void {
    if (this.swaps.some((s) => s.mesh === mesh)) return;
    const soup = new Soup(mesh.geometry);
    const mat = mesh.material as THREE.Material;
    // (a dark gap drawn along a panel line stays with the body: only what lies well inside a part goes with it)
    const gap = mat.name === 'panel gap';
    const n = soup.tris.length / 3;
    const region = new Int8Array(n);
    let any = false;
    for (let t = 0; t < n; t++) {
      const a = soup.pos(soup.tris[t * 3]);
      const b = soup.pos(soup.tris[t * 3 + 1]);
      const c = soup.pos(soup.tris[t * 3 + 2]);
      const x = (a[0] + b[0] + c[0]) / 3;
      const y = (a[1] + b[1] + c[1]) / 3;
      const z = (a[2] + b[2] + c[2]) / 3;
      let r = this.volumeAt(x, y, z);
      if (gap && r >= 0) {
        const m = 0.03;
        for (const [dx, dy, dz] of [
          [m, 0, 0],
          [-m, 0, 0],
          [0, m, 0],
          [0, -m, 0],
          [0, 0, m],
          [0, 0, -m],
        ])
          if (this.volumeAt(x + dx, y + dy, z + dz) !== r) r = -1;
      }
      region[t] = r;
      if (r >= 0) any = true;
    }
    if (any) this.addSwap(mesh, soup, region);
  }

  /** Which part a point fixed to the car lies on: on its skin, or (a door) on the panel inside it. */
  private volumeAt(x: number, y: number, z: number): number {
    const L = this.L;
    const ax = Math.abs(x);
    const prof = this.profile(z);
    const ds = segmentDistances(prof, ax, y, this.ds);
    const hw = this.host.exterior.shell.halfWidth;
    // (on the outside of the shell – not on the lining inside it)
    const k = nearest(ds);
    if (ds[k] < 0.04 && outside(prof, k, ax, y) > -0.012) {
      const part = shellPart(L, x, y, z, k, false);
      if (part >= 0) return part;
    }
    // the tail's face above the tailgate's lower edge
    if (z > L.zRear - 0.05 && z < L.zRear + 0.08 && y >= L.tailSill && ax <= 0.385) return BOOT;
    // inside a door: its panel (below the window), as far in as the panel reaches
    if (ax > hw - 0.17 && y >= L.sill && y < L.belt + 0.01) {
      const s = x < 0 ? 0 : 1;
      if (z >= L.zFD && z <= L.zB) return FL + s;
      if (z > L.zB && z <= Math.max(L.zRW, along(L.arch, y))) return RL + s;
    }
    return -1;
  }

  /** The edges of the cut skin: round each part, and round each opening in the body (for the dark strips). */
  private collectEdges(skins: Array<{ soup: Soup; region: Int8Array }>, partEdges: number[][], bodyEdges: number[][]): void {
    const q = (v: number): number => Math.round(v * 1e4);
    const pkey = (p: number[]): string => `${q(p[0])},${q(p[1])},${q(p[2])}`;
    // per region: each edge with how often it is used, and one use of it (positions and normals of its ends, the triangle's middle)
    const uses = new Map<string, { count: number; region: number; a: number[]; b: number[]; na: number[]; nb: number[]; mid: number[]; cap: boolean }>();
    for (const { soup, region } of skins) {
      const ni = soup.names.indexOf('normal');
      const N = soup.data[ni];
      const nrm = (i: number): number[] => (ni >= 0 ? [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]] : [0, 0, 0]);
      for (let t = 0; t < region.length; t++) {
        const v = [soup.tris[t * 3], soup.tris[t * 3 + 1], soup.tris[t * 3 + 2]];
        const p = v.map((i) => soup.pos(i));
        const mid = [(p[0][0] + p[1][0] + p[2][0]) / 3, (p[0][1] + p[1][1] + p[2][1]) / 3, (p[0][2] + p[1][2] + p[2][2]) / 3];
        const ux = p[1][0] - p[0][0];
        const uy = p[1][1] - p[0][1];
        const vx = p[2][0] - p[0][0];
        const vy = p[2][1] - p[0][1];
        const fz = ux * vy - uy * vx;
        const fl = Math.hypot(fz, (p[1][1] - p[0][1]) * (p[2][2] - p[0][2]) - (p[1][2] - p[0][2]) * vy, (p[1][2] - p[0][2]) * vx - ux * (p[2][2] - p[0][2])) || 1;
        const cap = Math.abs(fz) / fl > 0.97 && mid[2] > this.L.zRear - 0.03;
        for (let e = 0; e < 3; e++) {
          const ka = pkey(p[e]);
          const kb = pkey(p[(e + 1) % 3]);
          if (ka === kb) continue;
          const key = `${region[t]}|${ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`}`;
          const u = uses.get(key);
          if (u) u.count++;
          else uses.set(key, { count: 1, region: region[t], a: p[e], b: p[(e + 1) % 3], na: nrm(v[e]), nb: nrm(v[(e + 1) % 3]), mid, cap });
        }
      }
    }
    for (const u of uses.values()) {
      if (u.count !== 1) continue;
      const push = (list: number[]): void => void list.push(...u.a, ...u.b, ...u.na, ...u.nb);
      if (u.region >= 0) {
        push(partEdges[u.region]);
        continue;
      }
      // an edge of the body: which part lies just across it?
      const mx = (u.a[0] + u.b[0]) / 2;
      const my = (u.a[1] + u.b[1]) / 2;
      const mz = (u.a[2] + u.b[2]) / 2;
      const dx = mx - u.mid[0];
      const dy = my - u.mid[1];
      const dz = mz - u.mid[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      const e = 0.003 / l;
      const part = this.pointPart(mx + dx * e, my + dy * e, mz + dz * e, u.cap);
      if (part >= 0) push(bodyEdges[part]);
    }
  }

  /** Dark strips from edges into the car (along each end's normal, inwards): the cut edge of a sheet of metal or of a frame. */
  private strips(edges: readonly number[]): THREE.BufferGeometry | null {
    if (edges.length === 0) return null;
    const T = 0.028;
    const pos: number[] = [];
    for (let i = 0; i < edges.length; i += 12) {
      const [ax, ay, az, bx, by, bz, nax, nay, naz, nbx, nby, nbz] = edges.slice(i, i + 12);
      const la = Math.hypot(nax, nay, naz) || 1;
      const lb = Math.hypot(nbx, nby, nbz) || 1;
      const a2 = [ax - (nax / la) * T, ay - (nay / la) * T, az - (naz / la) * T];
      const b2 = [bx - (nbx / lb) * T, by - (nby / lb) * T, bz - (nbz / lb) * T];
      pos.push(ax, ay, az, bx, by, bz, b2[0], b2[1], b2[2], ax, ay, az, b2[0], b2[1], b2[2], a2[0], a2[1], a2[2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.computeVertexNormals();
    return g;
  }

  /** Under the bonnet: a dark bay, the engine, the battery, a reservoir with a yellow cap, the radiator at the front. */
  private engineBay(): THREE.Group {
    const L = this.L;
    const g = new THREE.Group();
    g.name = 'engine bay';
    const at = this.profile;
    const z0 = L.bz0 + 0.04;
    const z1 = L.bz1;
    const zm = (z0 + z1) / 2;
    const w = Math.min(along(L.bonnetEdge, z1), along(L.bonnetEdge, z0) + 0.1);
    const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number, mat: THREE.Material): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
      m.position.set(x, y, z);
      g.add(m);
    };
    const top = (z: number): number => at(z)[6][1];
    // the floor of the bay, the bulkhead behind it, the radiator in front
    box(2 * w, 0.02, z1 - z0, 0, 0.4, zm, BAY);
    box(2 * w, top(z1) - 0.43, 0.03, 0, (top(z1) + 0.4) / 2 - 0.02, z1 - 0.015, BAY);
    box(2 * w - 0.2, top(z0) - 0.5, 0.05, 0, (top(z0) + 0.4) / 2 - 0.02, z0 + 0.04, BAY_METAL);
    // the engine across the car, its cover, the battery and the reservoir
    const ez = zm + 0.06;
    const eh = Math.min(0.32, top(ez) - 0.5);
    box(0.68, eh, 0.48, -0.05, 0.42 + eh / 2, ez, BAY);
    box(0.5, 0.03, 0.34, -0.05, 0.42 + eh + 0.012, ez, BAY_METAL);
    box(0.26, 0.19, 0.17, -w + 0.22, 0.42 + 0.095, z1 - 0.2, BAY);
    const res = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.14, 12), BAY_METAL);
    res.position.set(w - 0.2, 0.49, z1 - 0.22);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.025, 12), CAP);
    cap.position.set(w - 0.2, 0.57, z1 - 0.22);
    g.add(res, cap);
    g.visible = false;
    return g;
  }
}
