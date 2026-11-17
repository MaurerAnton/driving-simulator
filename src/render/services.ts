// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The fuel stations and car washes as they are drawn: built from the
 * layout of each site (world/services.ts) when the player comes near, and
 * taken away again far behind.
 *
 * A fuel station: the canopy – a slab of the outline of the real one, its
 * edge in a colour of the station's own with its name on the long sides,
 * lights in its underside, carried by columns that stand on the islands –,
 * the pump islands (a raised kerb, a yellow post at each end) with a pump
 * on each: a white cabinet, a display on both faces, two nozzles in their
 * holsters on each face with their hoses hanging from the top, and the
 * price sign at the road.  While the player fills up, one nozzle leaves its
 * holster for the vehicle's filler, its hose following, and the display of
 * that pump counts the litres and the price.
 *
 * A car wash: its hall (walls along both sides, open at the ends) or its
 * roof on four columns, or a concrete bay in the open – and the gantry: a
 * portal on rails that travels over the car with two brushes standing at
 * the sides and one lying across the top, all of them turning, spraying
 * foam and water.
 *
 * The parts that do not move are merged per material: a station is a
 * handful of draw calls.  Everything is made of plain shapes and canvas
 * pictures – no real brand's design is copied: the colours come from the
 * name.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FUELS, GANTRY, fromRect, inRing, priceAt, rectRing } from '../world/services.ts';
import type { CanopyPlan, Rect, ServiceSite, WashPlan } from '../world/services.ts';

// ------------------------------------------------------------------ materials (shared by every site)

const lambert = (color: number): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color });
const M = {
  concrete: lambert(0xb4b1a9),
  underside: lambert(0xe6e8ea),
  steel: lambert(0x9aa2aa),
  dark: lambert(0x24282c),
  white: lambert(0xeef0f1),
  rubber: lambert(0x141517),
  yellow: lambert(0xf0c419),
  wall: lambert(0xd3d6d6),
  roof: lambert(0x8c9196),
  rail: lambert(0x6e757c),
  light: new THREE.MeshBasicMaterial({ color: 0xfffaea }),
  red: new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
  green: new THREE.MeshBasicMaterial({ color: 0x23e05a }),
  off: lambert(0x2b2f33),
};

/** Colours of a station's own, from its name: none is a real brand's. */
const BRAND_COLOURS = [0x1f5fa8, 0xc8281e, 0x1d8a4c, 0xe8a90c, 0x5b3591, 0x0d8aa0, 0xd8601a, 0x2c3e50];
const brandMaterials = new Map<number, THREE.MeshLambertMaterial>();

function brandColour(site: ServiceSite): number {
  const key = (site.brand || site.name || site.osm).toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return BRAND_COLOURS[(h >>> 0) % BRAND_COLOURS.length];
}

function brandMaterial(colour: number): THREE.MeshLambertMaterial {
  let m = brandMaterials.get(colour);
  if (!m) brandMaterials.set(colour, (m = lambert(colour)));
  return m;
}

/** The colours of the nozzles by fuel (as the grips on German pumps tend to be: diesel black, petrol green or blue). */
const NOZZLE_COLOURS: Record<string, number> = { e10: 0x2e9b45, e5: 0x2a5bd7, plus: 0x7d3fb0, diesel: 0x1b1c1e, hgv: 0x1b1c1e, lpg: 0xd8a514, cng: 0x8a8f94, adblue: 0x3a7fd0 };

/** A canvas texture of w × h pixels drawn by `draw`. */
function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const FONT = '"DIN Alternate", "Bahnschrift", "Roboto Condensed", "Arial Narrow", Arial, sans-serif';
const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

/** A pump's display while nobody fills up: dark, with dashes. */
let idleDisplay: THREE.MeshBasicMaterial | null = null;
function idleDisplayMaterial(): THREE.MeshBasicMaterial {
  idleDisplay ??= new THREE.MeshBasicMaterial({
    map: canvasTexture(128, 96, (c) => {
      c.fillStyle = '#10151a';
      c.fillRect(0, 0, 128, 96);
      c.fillStyle = '#3f6a3a';
      c.font = `600 26px ${FONT}`;
      c.textAlign = 'right';
      c.fillText('--,--', 118, 40);
      c.fillText('--,--', 118, 80);
    }),
    toneMapped: false,
  });
  return idleDisplay;
}

/** The bristles of a brush: stripes round it, so that its turning shows. */
let brushMat: THREE.MeshLambertMaterial | null = null;
function brushMaterial(): THREE.MeshLambertMaterial {
  if (!brushMat) {
    const tex = canvasTexture(64, 8, (c) => {
      const cols = ['#2f6fd0', '#5b9cf0', '#e8eef5', '#3f7fe0'];
      for (let i = 0; i < 16; i++) {
        c.fillStyle = cols[i % cols.length];
        c.fillRect(i * 4, 0, 4, 8);
      }
    });
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(3, 1);
    brushMat = new THREE.MeshLambertMaterial({ map: tex });
  }
  return brushMat;
}

/** A round soft dot for the foam and the water. */
let dotTex: THREE.CanvasTexture | null = null;
function dotTexture(): THREE.CanvasTexture {
  dotTex ??= canvasTexture(32, 32, (c) => {
    const g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.75)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 32, 32);
  });
  return dotTex;
}

// ------------------------------------------------------------------ building geometry

/** Collects pieces of geometry per material, to be merged into one mesh each. */
class Parts {
  private readonly lists = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(material: THREE.Material, g: THREE.BufferGeometry): void {
    const list = this.lists.get(material);
    if (list) list.push(g);
    else this.lists.set(material, [g]);
  }

  /** A box of w × h × d with its foot's middle at (x, y, z), turned by yaw. */
  box(material: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, yaw = 0): void {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, h / 2, 0);
    if (yaw) g.rotateY(yaw);
    g.translate(x, y, z);
    this.add(material, g);
  }

  /** Merge into meshes, added to `group`. */
  into(group: THREE.Group, shadows: boolean): void {
    for (const [material, list] of this.lists) {
      const geos = list.map((g) => (g.index ? g.toNonIndexed() : g));
      for (const g of geos) {
        if (g.getAttribute('uv')) g.deleteAttribute('uv');
        for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      }
      const merged = mergeGeometries(geos, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    this.lists.clear();
  }
}

/** The yaw that turns a model's −z towards (ux, uz). */
const yawOf = (ux: number, uz: number): number => Math.atan2(-ux, -uz);

/** Where a ray from (x, z) along (dx, dz) leaves a ring – the distance, or NaN. */
function rayOut(ring: number[], x: number, z: number, dx: number, dz: number): number {
  let best = NaN;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const ax = ring[j];
    const az = ring[j + 1];
    const ex = ring[i] - ax;
    const ez = ring[i + 1] - az;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - x) * ez - (az - z) * ex) / den;
    const s = ((ax - x) * dz - (az - z) * dx) / den;
    if (t > 0 && s >= 0 && s <= 1 && !(t >= best)) best = t;
  }
  return best;
}

/** A hose: a tube along a sagging curve from a to b. */
function hoseGeometry(a: THREE.Vector3, b: THREE.Vector3, sag: number): THREE.TubeGeometry {
  const mid = a.clone().lerp(b, 0.5);
  mid.y = Math.min(a.y, b.y) - sag;
  const q1 = a.clone().lerp(mid, 0.55);
  q1.y -= sag * 0.25;
  const q2 = b.clone().lerp(mid, 0.55);
  q2.y -= sag * 0.25;
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3([a, q1, mid, q2, b]), 16, 0.017, 5, false);
}

const colourMaterials = new Map<number, THREE.MeshLambertMaterial>();
/** A plain material of a colour, made once. */
function colourMaterial(colour: number): THREE.MeshLambertMaterial {
  let m = colourMaterials.get(colour);
  if (!m) colourMaterials.set(colour, (m = lambert(colour)));
  return m;
}

/**
 * The pieces of a nozzle in its own frame – the grip in its colour, the
 * spout pointing along −z and a little down –, each with its material.
 */
function nozzlePieces(colour: number): Array<[THREE.BufferGeometry, THREE.Material]> {
  const grip = new THREE.BoxGeometry(0.05, 0.16, 0.09).translate(0, 0, 0.08);
  const body = new THREE.BoxGeometry(0.06, 0.06, 0.16).translate(0, 0.07, 0.04);
  const spout = new THREE.CylinderGeometry(0.012, 0.014, 0.2, 6).rotateX(Math.PI / 2 + 0.35).translate(0, 0.04, -0.08);
  return [
    [grip, colourMaterial(colour)],
    [body, M.steel],
    [spout, M.steel],
  ];
}

/** A nozzle as a group of its own (the one that moves). */
function nozzle(colour: number): THREE.Group {
  const g = new THREE.Group();
  for (const [geo, mat] of nozzlePieces(colour)) g.add(new THREE.Mesh(geo, mat));
  return g;
}

// ------------------------------------------------------------------ a pump

/** A pump as drawn: where it stands, which way its faces look, where its nozzles hang. */
export interface PumpView {
  /** the foot of the pump (world) and the island's direction (u) and across (v) */
  x: number;
  y: number;
  z: number;
  ux: number;
  uz: number;
  /** its display on each face (swapped for the counting one) */
  displays: THREE.Mesh[];
}

const PUMP = { len: 0.92, depth: 0.46, height: 2.05, base: 0.22 };
/** where the nozzles hang on a face: along the pump, and how high */
const HOLSTER = { along: [-0.27, 0.27], y: 1.05 };
/** where a hose leaves the pump: along it, at the top */
const OUTLET_Y = 1.98;

// ------------------------------------------------------------------ a site

/** The animated parts of a car wash. */
interface GantryView {
  group: THREE.Group;
  brushL: THREE.Mesh;
  brushR: THREE.Mesh;
  brushTop: THREE.Mesh;
  lampRed: THREE.Mesh;
  lampGreen: THREE.Mesh;
  /** the bay's frame and the ground under its middle */
  rect: Rect;
  y: number;
  /** how far along the bay the gantry can travel (±), and how far its posts stand from the middle */
  reach: number;
  postV: number;
}

/** What is drawn of one site. */
export class SiteView {
  readonly group = new THREE.Group();
  readonly site: ServiceSite;
  readonly pumps: PumpView[] = [];
  /** for the collisions: the outlines of islands and walls (flat x, z rings) and the posts (x, y, z, r) */
  readonly rings: number[][] = [];
  readonly discs: number[] = [];
  gantry: GantryView | null = null;
  /** the colour of the site's own */
  readonly colour: number;
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(site: ServiceSite, ground: (x: number, z: number) => number, shadows: boolean) {
    this.site = site;
    this.colour = brandColour(site);
    this.group.name = `${site.k === 'fuel' ? 'fuel station' : 'car wash'} ${site.name}`;
    // (built round the site's middle: the numbers of the geometry stay small)
    this.group.position.set(site.x, 0, site.z);
    const parts = new Parts();
    for (const c of site.canopies) this.canopy(parts, c, ground);
    if (site.k === 'fuel' && site.sign) this.pylon(site.sign, ground);
    if (site.wash) this.wash(parts, site.wash, ground);
    parts.into(this.group, shadows);
    this.group.updateMatrixWorld(true);
  }

  /** world → the group's frame */
  private lx(x: number): number {
    return x - this.site.x;
  }

  private lz(z: number): number {
    return z - this.site.z;
  }

  // ---------------------------------------------------------------- the canopy, the islands, the pumps
  private canopy(parts: Parts, c: CanopyPlan, ground: (x: number, z: number) => number): void {
    const brand = brandMaterial(this.colour);
    const r = c.rect;
    const g0 = Number.isFinite(c.y0) ? c.y0 : ground(r.cx, r.cz);
    // the top: the building model's, else what a canopy usually has (never so low that a van would not fit)
    const top = Number.isFinite(c.y1) ? Math.max(c.y1, g0 + 4.2) : g0 + (Number.isFinite(c.h) ? Math.max(4.2, c.h) : 5.2);
    const thick = 0.7;
    const under = top - thick;
    // the slab: the outline drawn up from the underside, its edge in the station's colour
    const shape = new THREE.Shape();
    for (let i = 0; i < c.ring.length; i += 2) {
      const x = this.lx(c.ring[i]);
      const y = -this.lz(c.ring[i + 1]);
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    const slab = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
    slab.rotateX(-Math.PI / 2);
    slab.translate(0, under, 0);
    const slabMesh = new THREE.Mesh(slab, [M.underside, brand]);
    slabMesh.castShadow = true;
    slabMesh.receiveShadow = true;
    this.group.add(slabMesh);
    this.disposables.push(slab);
    // lights in the underside, every 4 m
    const nu = Math.max(1, Math.floor(r.len / 4));
    const nv = Math.max(1, Math.floor(r.wid / 4));
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const [x, z] = fromRect(r, (i + 0.5 - nu / 2) * (r.len / nu), (j + 0.5 - nv / 2) * (r.wid / nv));
        if (!inRing(x, z, c.ring)) continue;
        parts.box(M.light, 0.7, 0.04, 0.7, this.lx(x), under - 0.04, this.lz(z));
      }
    }
    // the name on the edge, on both long sides
    if (this.site.brand || this.site.name) {
      const label = (this.site.brand || this.site.name).toUpperCase();
      const tex = canvasTexture(512, 64, (cx) => {
        cx.fillStyle = hex(this.colour);
        cx.fillRect(0, 0, 512, 64);
        cx.fillStyle = '#ffffff';
        cx.textAlign = 'center';
        cx.textBaseline = 'middle';
        let size = 46;
        cx.font = `800 ${size}px ${FONT}`;
        const w = cx.measureText(label).width;
        if (w > 480) {
          size *= 480 / w;
          cx.font = `800 ${size}px ${FONT}`;
        }
        cx.fillText(label, 256, 34);
      });
      const mat = new THREE.MeshBasicMaterial({ map: tex });
      this.disposables.push(tex, mat);
      const w = Math.min(r.len * 0.5, 8);
      for (const side of [-1, 1]) {
        const vx = -r.uz * side;
        const vz = r.ux * side;
        const d = rayOut(c.ring, r.cx, r.cz, vx, vz);
        if (!Number.isFinite(d)) continue;
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 8), mat);
        panel.position.set(this.lx(r.cx + vx * (d + 0.03)), under + thick / 2, this.lz(r.cz + vz * (d + 0.03)));
        panel.rotation.y = yawOf(-vx, -vz);
        this.group.add(panel);
        this.disposables.push(panel.geometry);
      }
    }
    // the islands with their kerbs and posts, and the columns standing on them
    for (let i = 0; i < c.islands.length; i++) {
      const isl = c.islands[i];
      const y = ground(isl.x, isl.z);
      const yaw = yawOf(isl.ux, isl.uz);
      // (the box's length along its local z, turned onto the island's axis)
      parts.box(M.concrete, isl.wid, 0.16, isl.len, this.lx(isl.x), y - 0.05, this.lz(isl.z), yaw);
      for (const e of [-1, 1]) {
        const px = isl.x + isl.ux * e * (isl.len / 2 - 0.12);
        const pz = isl.z + isl.uz * e * (isl.len / 2 - 0.12);
        parts.box(M.yellow, 0.16, 1.0, 0.16, this.lx(px), y + 0.1, this.lz(pz), yaw);
      }
      const isRect: Rect = { cx: isl.x, cz: isl.z, ux: isl.ux, uz: isl.uz, len: isl.len, wid: isl.wid };
      this.rings.push(rectRing(isRect, 0.05));
      this.pump(parts, isl.x, y + 0.11, isl.z, isl.ux, isl.uz);
    }
    for (let k = 0; k < c.columns.length; k += 2) {
      const x = c.columns[k];
      const z = c.columns[k + 1];
      const y = ground(x, z);
      parts.box(brand, 0.42, under - y + 0.05, 0.42, this.lx(x), y, this.lz(z));
      this.discs.push(x, y, z, 0.28);
    }
  }

  /** A pump on its island: the cabinet, its displays, the nozzles in their holsters and the hanging hoses. */
  private pump(parts: Parts, x: number, y: number, z: number, ux: number, uz: number): void {
    const yaw = yawOf(ux, uz);
    const lx = this.lx(x);
    const lz = this.lz(z);
    // (the cabinet's length along the island: its local z)
    parts.box(M.dark, PUMP.depth + 0.06, PUMP.base, PUMP.len + 0.06, lx, y, lz, yaw);
    parts.box(M.white, PUMP.depth, PUMP.height - PUMP.base - 0.32, PUMP.len, lx, y + PUMP.base, lz, yaw);
    parts.box(brandMaterial(this.colour), PUMP.depth + 0.02, 0.32, PUMP.len + 0.02, lx, y + PUMP.height - 0.32, lz, yaw);
    const view: PumpView = { x, y, z, ux, uz, displays: [] };
    const vx = -uz;
    const vz = ux;
    const fuels = this.site.sells.length ? this.site.sells : ['e10', 'diesel'];
    for (const side of [-1, 1]) {
      // the display, a little out from the face
      const d = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.3), idleDisplayMaterial());
      const fx = x + vx * side * (PUMP.depth / 2 + 0.006);
      const fz = z + vz * side * (PUMP.depth / 2 + 0.006);
      d.position.set(this.lx(fx), y + 1.5, this.lz(fz));
      d.rotation.y = yawOf(-vx * side, -vz * side);
      this.group.add(d);
      this.disposables.push(d.geometry);
      view.displays.push(d);
      // two nozzles in their holsters, their hoses from the top of the pump
      HOLSTER.along.forEach((along, k) => {
        const fuel = fuels[(k + (side > 0 ? 0 : 1)) % fuels.length];
        const hx = x + ux * along + vx * side * (PUMP.depth / 2 + 0.07);
        const hz = z + uz * along + vz * side * (PUMP.depth / 2 + 0.07);
        parts.box(M.dark, 0.1, 0.16, 0.14, this.lx(hx - vx * side * 0.04), y + HOLSTER.y - 0.12, this.lz(hz - vz * side * 0.04), yaw);
        // (hanging, the spout down into the holster, towards the pump)
        const at = new THREE.Matrix4().compose(new THREE.Vector3(this.lx(hx), y + HOLSTER.y, this.lz(hz)), new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.2, yawOf(-vx * side, -vz * side), 0, 'YXZ')), new THREE.Vector3(1, 1, 1));
        for (const [geo, mat] of nozzlePieces(NOZZLE_COLOURS[fuel] ?? 0x1b1c1e)) parts.add(mat, geo.applyMatrix4(at));
        const top = new THREE.Vector3(this.lx(x + ux * along + vx * side * (PUMP.depth / 2 - 0.05)), y + OUTLET_Y, this.lz(z + uz * along + vz * side * (PUMP.depth / 2 - 0.05)));
        const end = new THREE.Vector3(this.lx(hx + vx * side * 0.05), y + HOLSTER.y + 0.1, this.lz(hz + vz * side * 0.05));
        parts.add(M.rubber, hoseGeometry(top, end, 0.55));
      });
    }
    this.pumps.push(view);
  }

  // ---------------------------------------------------------------- the price sign
  private pylon(sign: [number, number, number], ground: (x: number, z: number) => number): void {
    const [x, z, yaw] = sign;
    const y = ground(x, z);
    const s = this.site;
    const label = (s.brand || s.name || 'Tankstelle').toUpperCase();
    const rows = (s.sells.length ? s.sells : ['e10', 'e5', 'diesel']).filter((f) => f !== 'adblue').slice(0, 4);
    const tex = canvasTexture(256, 1024, (c) => {
      c.fillStyle = '#f4f5f6';
      c.fillRect(0, 0, 256, 1024);
      c.fillStyle = hex(this.colour);
      c.fillRect(0, 0, 256, 300);
      c.fillStyle = '#ffffff';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      let size = 60;
      c.font = `800 ${size}px ${FONT}`;
      const w = c.measureText(label).width;
      if (w > 230) {
        size *= 230 / w;
        c.font = `800 ${size}px ${FONT}`;
      }
      c.fillText(label, 128, 150);
      rows.forEach((f, i) => {
        const y0 = 330 + i * 160;
        c.fillStyle = '#1e2227';
        c.fillRect(10, y0, 236, 140);
        c.fillStyle = '#dfe4e8';
        c.font = `600 30px ${FONT}`;
        c.textAlign = 'left';
        c.fillText(FUELS[f]?.label ?? f, 22, y0 + 30);
        const p = priceAt(s, f).toFixed(3);
        c.fillStyle = '#ffd23a';
        c.font = `700 70px ${FONT}`;
        c.textAlign = 'right';
        c.fillText(p.slice(0, -1).replace('.', ','), 208, y0 + 95);
        c.font = `700 38px ${FONT}`;
        c.fillText(p.slice(-1), 236, y0 + 78);
      });
    });
    const face = new THREE.MeshLambertMaterial({ map: tex });
    const edge = brandMaterial(this.colour);
    const geo = new THREE.BoxGeometry(1.6, 5.4, 0.34);
    const board = new THREE.Mesh(geo, [edge, edge, edge, edge, face, face]);
    board.position.set(this.lx(x), y + 0.6 + 2.7, this.lz(z));
    board.rotation.y = yaw;
    board.castShadow = true;
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.6, 0.55), M.concrete);
    base.position.set(this.lx(x), y + 0.3 - 0.05, this.lz(z));
    base.rotation.y = yaw;
    this.group.add(board, base);
    this.disposables.push(tex, face, geo, base.geometry);
    this.discs.push(x, y, z, 0.95);
  }

  // ---------------------------------------------------------------- a car wash
  private wash(parts: Parts, w: WashPlan, ground: (x: number, z: number) => number): void {
    const r = w.rect;
    const y = Number.isFinite(w.y0) ? Math.max(w.y0, ground(r.cx, r.cz) - 0.3) : ground(r.cx, r.cz);
    const top = Number.isFinite(w.y1) ? Math.max(w.y1, y + 3.4) : y + 3.8;
    const yaw = yawOf(r.ux, r.uz);
    const site = this.site;
    const halfW = r.wid / 2;
    // the floor of the bay and the gantry's rails
    parts.box(M.concrete, r.wid, 0.06, r.len, this.lx(r.cx), y - 0.03, this.lz(r.cz), yaw);
    const railV = Math.min(halfW - 0.25, GANTRY.width / 2 + 0.75);
    for (const side of [-1, 1]) {
      const [x, z] = fromRect(r, 0, side * railV);
      parts.box(M.rail, 0.12, 0.1, r.len - 0.4, this.lx(x), y, this.lz(z), yaw);
    }
    const roof = site.roofs?.[0];
    if (w.hall && !roof?.open) {
      // a hall: a wall along each long side, a roof, open at both ends
      for (const side of [-1, 1]) {
        const [x, z] = fromRect(r, 0, side * (halfW - 0.12));
        parts.box(M.wall, 0.24, top - y - 0.3 + 0.4, r.len, this.lx(x), y - 0.4, this.lz(z), yaw);
        this.rings.push(rectRing({ cx: x, cz: z, ux: r.ux, uz: r.uz, len: r.len, wid: 0.24 }));
      }
      parts.box(M.roof, r.wid + 0.2, 0.3, r.len + 0.2, this.lx(r.cx), top - 0.3, this.lz(r.cz), yaw);
      // a light strip under the roof
      parts.box(M.light, 0.25, 0.04, r.len - 1, this.lx(r.cx), top - 0.34, this.lz(r.cz), yaw);
    } else if (w.hall) {
      // under a roof on columns
      for (const [su, sv] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const [x, z] = fromRect(r, su * (r.len / 2 - 0.25), sv * (halfW - 0.25));
        parts.box(M.steel, 0.3, top - y, 0.3, this.lx(x), y - 0.1, this.lz(z));
        this.discs.push(x, y, z, 0.25);
      }
      parts.box(M.roof, r.wid, 0.3, r.len, this.lx(r.cx), top - 0.3, this.lz(r.cz), yaw);
    }
    // the gantry: a portal over the bay, with its brushes
    const g = new THREE.Group();
    const postV = railV;
    const beamY = GANTRY.height + 0.55;
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.34, beamY, 0.7), brandMaterial(this.colour));
      post.position.set(side * postV, beamY / 2, 0);
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(postV * 2 + 0.34, 0.5, 0.7), brandMaterial(this.colour));
    beam.position.set(0, beamY + 0.25, 0);
    g.add(beam);
    const brush = brushMaterial();
    const side = new THREE.CylinderGeometry(0.42, 0.42, 2.0, 18, 1, true);
    const brushL = new THREE.Mesh(side, brush);
    const brushR = new THREE.Mesh(side, brush);
    brushL.position.set(-postV + 0.6, 1.1, 0.05);
    brushR.position.set(postV - 0.6, 1.1, 0.05);
    const topGeo = new THREE.CylinderGeometry(0.42, 0.42, postV * 2 - 0.5, 18, 1, true);
    topGeo.rotateZ(Math.PI / 2);
    const brushTop = new THREE.Mesh(topGeo, brush);
    brushTop.position.set(0, GANTRY.height, -0.3);
    g.add(brushL, brushR, brushTop);
    // the light at its front: green – drive in, red – stop
    const lampRed = new THREE.Mesh(new THREE.CircleGeometry(0.11, 12), M.off);
    const lampGreen = new THREE.Mesh(new THREE.CircleGeometry(0.11, 12), M.off);
    lampRed.position.set(-0.2, beamY + 0.25, -0.36);
    lampGreen.position.set(0.2, beamY + 0.25, -0.36);
    lampRed.rotation.y = Math.PI;
    lampGreen.rotation.y = Math.PI;
    g.add(lampRed, lampGreen);
    for (const o of g.children) o.castShadow = true;
    this.group.add(g);
    this.disposables.push(side, topGeo);
    // (over the car round the mark: in a long hall it does not travel the whole length)
    this.gantry = { group: g, brushL, brushR, brushTop, lampRed, lampGreen, rect: r, y, reach: Math.max(0.5, Math.min(3.6, r.len / 2 - 1.2)), postV };
    this.placeGantry(1, 1, 0, 0, 0, 0);
  }

  /**
   * Where the gantry is (−1 … 1 along the bay), which way its front faces
   * (1: towards −u, where a car comes in that drives along u), how far its
   * side brushes are in towards the car (0 apart … 1 at its sides), the top
   * brush's height over the floor (0: up out of the way), how far they turn
   * this frame (rad) – and its light (−1 red, 1 green, 0 off).
   */
  placeGantry(at: number, face: number, close: number, topY: number, spin: number, light: number): void {
    const gv = this.gantry;
    if (!gv) return;
    const [x, z] = fromRect(gv.rect, at * gv.reach, 0);
    gv.group.position.set(this.lx(x), gv.y, this.lz(z));
    gv.group.rotation.y = yawOf(-face * gv.rect.ux, -face * gv.rect.uz);
    const open = gv.postV - 0.6;
    // (in to the sides of a car of 1.8 m)
    const inner = 1.32;
    const v = open + (inner - open) * close;
    gv.brushL.position.x = -v;
    gv.brushR.position.x = v;
    gv.brushTop.position.y = topY > 0 ? topY : GANTRY.height;
    gv.brushL.rotation.y += spin;
    gv.brushR.rotation.y -= spin;
    gv.brushTop.rotation.x += spin;
    gv.lampRed.material = light < 0 ? M.red : M.off;
    gv.lampGreen.material = light > 0 ? M.green : M.off;
  }

  /** The middle of the gantry's beam (world): where the water comes from. */
  gantryAt(out: THREE.Vector3): THREE.Vector3 {
    const gv = this.gantry;
    if (!gv) return out.set(this.site.x, 0, this.site.z);
    return out.copy(gv.group.position).add(this.group.position);
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}

// ------------------------------------------------------------------ what moves while one fills up or washes

/** The nozzle in a vehicle's filler, its hose back to the pump, and the counting display. */
export class FillView {
  readonly group = new THREE.Group();
  private readonly nozzle: THREE.Group;
  private hose: THREE.Mesh | null = null;
  private readonly display: THREE.MeshBasicMaterial;
  private readonly canvas: HTMLCanvasElement;
  private readonly tex: THREE.CanvasTexture;
  private pump: PumpView | null = null;
  private last = '';

  constructor() {
    this.group.name = 'filling up';
    this.nozzle = nozzle(0x2e9b45);
    this.group.add(this.nozzle);
    this.canvas = document.createElement('canvas');
    this.canvas.width = 128;
    this.canvas.height = 96;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.display = new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false });
    this.group.visible = false;
  }

  /**
   * Show the nozzle `t` of the way (0 in its holster … 1 in the filler) from
   * the pump on the given side (−1/1 across the island) to the filler (world
   * point), its grip in the fuel's colour.
   */
  show(pump: PumpView, side: number, filler: THREE.Vector3, t: number, fuel: string): void {
    if (this.pump && this.pump !== pump) this.hide();
    this.pump = pump;
    for (const d of pump.displays) d.material = this.display;
    const vx = -pump.uz * side;
    const vz = pump.ux * side;
    const holster = new THREE.Vector3(pump.x + vx * (PUMP.depth / 2 + 0.07) + pump.ux * HOLSTER.along[0], pump.y + HOLSTER.y, pump.z + vz * (PUMP.depth / 2 + 0.07) + pump.uz * HOLSTER.along[0]);
    const e = t * t * (3 - 2 * t);
    const at = holster.clone().lerp(filler, e);
    // (lifted over the gap on the way)
    at.y += Math.sin(e * Math.PI) * 0.35;
    this.nozzle.position.copy(at);
    // the spout from the holster (towards the pump, down) round to the filler (into the vehicle's side)
    this.nozzle.rotation.set(-0.25 - (1 - e) * 0.95, yawOf(vx, vz) + (1 - e) * Math.PI, 0, 'YXZ');
    (this.nozzle.children[0] as THREE.Mesh).material = colourMaterial(NOZZLE_COLOURS[fuel] ?? 0x2e9b45);
    const outlet = new THREE.Vector3(pump.x + vx * (PUMP.depth / 2 - 0.05) + pump.ux * HOLSTER.along[0], pump.y + OUTLET_Y, pump.z + vz * (PUMP.depth / 2 - 0.05) + pump.uz * HOLSTER.along[0]);
    const end = at.clone().add(new THREE.Vector3(vx, 0, vz).multiplyScalar(0.12));
    end.y += 0.02;
    this.hose?.geometry.dispose();
    if (this.hose) this.group.remove(this.hose);
    this.hose = new THREE.Mesh(hoseGeometry(outlet, end, 0.35 + 0.25 * (1 - e)), M.rubber);
    this.group.add(this.hose);
    this.group.visible = true;
  }

  /** The counter on the pump's display. */
  count(litres: number, cost: number): void {
    const text = `${cost.toFixed(2)}|${litres.toFixed(2)}`;
    if (text === this.last) return;
    this.last = text;
    const c = this.canvas.getContext('2d')!;
    c.fillStyle = '#0e1418';
    c.fillRect(0, 0, 128, 96);
    c.textAlign = 'right';
    c.fillStyle = '#ff5b36';
    c.font = `700 30px ${FONT}`;
    c.fillText(cost.toFixed(2).replace('.', ','), 116, 38);
    c.fillStyle = '#7cf06a';
    c.fillText(litres.toFixed(2).replace('.', ','), 116, 80);
    c.fillStyle = '#7d8a94';
    c.font = `600 13px ${FONT}`;
    c.textAlign = 'left';
    c.fillText('EUR', 6, 30);
    c.fillText('L', 6, 72);
    this.tex.needsUpdate = true;
  }

  hide(): void {
    if (this.pump) for (const d of this.pump.displays) d.material = idleDisplayMaterial();
    this.pump = null;
    this.group.visible = false;
  }
}

/** Foam and water from the gantry: a cloud of dots thrown down and out round the car. */
export class SprayView {
  readonly points: THREE.Points;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly col: Float32Array;
  private next = 0;
  private static readonly N = 320;

  constructor() {
    const n = SprayView.N;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.col = new Float32Array(n * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.16, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, opacity: 0.9 }));
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.name = 'car wash: foam and water';
  }

  /**
   * Run for dt: `rate` new dots a second from the beam over (x, y, z), across
   * the direction (vx, vz) – foam (white, slow) or water (blue, quick).
   */
  update(dt: number, x: number, y: number, z: number, vx: number, vz: number, rate: number, foam: boolean): void {
    const n = SprayView.N;
    let add = Math.min(60, Math.round(rate * dt + Math.random()));
    while (add-- > 0) {
      const i = this.next;
      this.next = (this.next + 1) % n;
      const across = (Math.random() * 2 - 1) * 1.3;
      this.pos[i * 3] = x + vx * across;
      this.pos[i * 3 + 1] = y + 2.2 + Math.random() * 0.4;
      this.pos[i * 3 + 2] = z + vz * across;
      const s = foam ? 0.5 : 2.2;
      this.vel[i * 3] = vx * across * 0.6 + (Math.random() - 0.5) * s;
      this.vel[i * 3 + 1] = foam ? -0.4 - Math.random() * 0.6 : -1.5 - Math.random() * 2;
      this.vel[i * 3 + 2] = vz * across * 0.6 + (Math.random() - 0.5) * s;
      this.life[i] = foam ? 1.8 : 0.9;
      const c = foam ? [0.97, 0.97, 0.98] : [0.62, 0.8, 0.95];
      this.col.set(c, i * 3);
    }
    let alive = 0;
    for (let i = 0; i < n; i++) {
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = -1e4;
        continue;
      }
      alive++;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 9.81 * dt * 0.5;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(y + 0.02, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    this.points.visible = alive > 0;
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  stop(): void {
    this.life.fill(0);
    this.points.visible = false;
  }
}

