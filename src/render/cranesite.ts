// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The construction site the cranes work on (game/cranetasks.ts lays it out):
 * gravel and asphalt draped over the field of the practice yard, the
 * building going up – slabs, columns, walls, the stair core, the loading
 * platform, the guard rails and the scaffolding –, the tower crane beside
 * it (when it is not the player's), the delivery truck on the site road,
 * the site office and the store at the depot, the fence, the stands marked
 * out for the cranes – and the loads: pallets of bricks, steel beams, a
 * container, formwork, reinforcing mesh, each where the work has put it,
 * with its slings when it hangs on the hook, the load of the task marked
 * and the place it goes lit up.
 *
 * Nothing of the map is changed: like the practice yard of the truck
 * lessons (render/yard.ts) the site is a few meshes following the ground,
 * shown for as long as a crane works there.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AREAS, BUILDING, DELIVERY, OFFICES, STANDS, TOWER_SITE, loadFootprint } from '../game/cranetasks.ts';
import type { LoadDef, LoadKind, SitePlacement, SiteRect, WorldLoad, WorldZone } from '../game/cranetasks.ts';
import { Crane } from '../sim/crane.ts';
import type { CraneDetail } from './crane.ts';
import { TowerCraneModel } from './crane.ts';
import { GLASS, lettering } from './truck.ts';

const ASPHALT = new THREE.MeshLambertMaterial({ color: 0x3b3e42, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
const GRAVEL = new THREE.MeshLambertMaterial({ color: 0x8d877c, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
const SAND = new THREE.MeshLambertMaterial({ color: 0xa89474, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
const MARK = new THREE.MeshBasicMaterial({ color: 0xf2c500, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -12 });
const ZONE = new THREE.MeshBasicMaterial({ color: 0x38d06a, transparent: true, opacity: 0.38, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -18 });
const ZONE_EDGE = new THREE.MeshBasicMaterial({ color: 0x2bff6a, transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -18 });
const PILLAR = new THREE.MeshBasicMaterial({ color: 0x5dff8a, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
const AIM = new THREE.MeshBasicMaterial({ color: 0xffd21a, transparent: true, opacity: 0.85, depthWrite: false });
const CONCRETE = new THREE.MeshLambertMaterial({ color: 0xb9b7b1 });
const MASONRY = new THREE.MeshLambertMaterial({ color: 0xe6e1d6 });
const STEEL = new THREE.MeshLambertMaterial({ color: 0x8f969c });
const SCAFFOLD = new THREE.MeshLambertMaterial({ color: 0xaeb3b7 });
const PLANK = new THREE.MeshLambertMaterial({ color: 0x8e6b45 });
const RAIL = new THREE.MeshLambertMaterial({ color: 0xd8331f });
const WHITE = new THREE.MeshLambertMaterial({ color: 0xeceeea });
const DARK = new THREE.MeshLambertMaterial({ color: 0x24272b });
const TRUCK_CAB = new THREE.MeshLambertMaterial({ color: 0x2b6ca8 });
const TYRE = new THREE.MeshLambertMaterial({ color: 0x151515 });
const TIMBER = new THREE.MeshLambertMaterial({ color: 0xa0784c });
const SLING = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });
const FENCE = new THREE.MeshLambertMaterial({ color: 0xc9cdd0, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
const PRIMER = new THREE.MeshLambertMaterial({ color: 0x8c3b2a });

/** A canvas texture drawn once (bricks, corrugation, plywood …). */
function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat: [number, number] = [1, 1]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (g) draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 4;
  return t;
}

let textures: { bricks: THREE.Material; container: THREE.Material; formwork: THREE.Material; mesh: THREE.Material; plywood: THREE.Material } | null = null;

/** The materials of the loads (their textures drawn the first time they are needed). */
function loadMaterials(): NonNullable<typeof textures> {
  if (textures) return textures;
  const bricks = canvasTexture(256, 256, (g) => {
    g.fillStyle = '#b9b3a6';
    g.fillRect(0, 0, 256, 256);
    for (let r = 0; r < 8; r++) {
      for (let k = -1; k < 4; k++) {
        const x = k * 80 + (r % 2 ? 40 : 0);
        g.fillStyle = `hsl(40, 12%, ${80 + ((r * 7 + k * 13) % 9)}%)`;
        g.fillRect(x + 3, r * 32 + 3, 74, 26);
      }
    }
  });
  const container = canvasTexture(256, 128, (g) => {
    g.fillStyle = '#245f86';
    g.fillRect(0, 0, 256, 128);
    for (let x = 0; x < 256; x += 16) {
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(x, 0, 5, 128);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x + 8, 0, 4, 128);
    }
  }, [3, 1]);
  const formwork = canvasTexture(128, 128, (g) => {
    g.fillStyle = '#d6a22a';
    g.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 21) {
      g.fillStyle = '#7a5a2a';
      g.fillRect(0, y, 128, 3);
    }
  });
  const meshTex = canvasTexture(128, 128, (g) => {
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = '#6a4630';
    g.lineWidth = 5;
    for (let k = 0; k <= 128; k += 21) {
      g.beginPath();
      g.moveTo(k, 0);
      g.lineTo(k, 128);
      g.moveTo(0, k);
      g.lineTo(128, k);
      g.stroke();
    }
  }, [4, 2]);
  const plywood = canvasTexture(64, 64, (g) => {
    g.fillStyle = '#c8a46c';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = 'rgba(120,80,40,0.25)';
    for (let y = 4; y < 64; y += 9) g.fillRect(0, y, 64, 2);
  });
  textures = {
    bricks: new THREE.MeshLambertMaterial({ map: bricks }),
    container: new THREE.MeshLambertMaterial({ map: container }),
    formwork: new THREE.MeshLambertMaterial({ map: formwork }),
    mesh: new THREE.MeshLambertMaterial({ map: meshTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide }),
    plywood: new THREE.MeshLambertMaterial({ map: plywood }),
  };
  return textures;
}

/** Boxes and their kin collected by material, merged into one mesh each (as render/crane.ts does). */
class Parts {
  private readonly lists = new Map<THREE.Material, THREE.BufferGeometry[]>();

  private push(mat: THREE.Material, g: THREE.BufferGeometry): void {
    let l = this.lists.get(mat);
    if (!l) this.lists.set(mat, (l = []));
    // (position, normal and uv: the textured loads need their uv)
    l.push(g.index ? g.toNonIndexed() : g);
  }

  box(mat: THREE.Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.push(mat, g);
  }

  cyl(mat: THREE.Material, x: number, y: number, z: number, r: number, len: number, axis: 'x' | 'y' | 'z', seg = 12): void {
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.push(mat, g);
  }

  build(group: THREE.Object3D, shadow = true): void {
    for (const [mat, list] of this.lists) {
      const g = mergeGeometries(list, false);
      if (!g) continue;
      const m = new THREE.Mesh(g, mat);
      m.castShadow = shadow && !(mat as THREE.MeshBasicMaterial).transparent;
      m.receiveShadow = true;
      group.add(m);
    }
    this.lists.clear();
  }
}

/** The mesh of a load, its bottom's middle at the origin, its length along x. */
function loadMesh(def: LoadDef, detail: CraneDetail): THREE.Group {
  const g = new THREE.Group();
  const m = loadMaterials();
  const p = new Parts();
  const { hx, hy, hz } = def;
  const kind: LoadKind = def.kind;
  if (kind === 'bricks') {
    // the pallet: boards and blocks; the bricks on it, strapped
    p.box(TIMBER, -hx, hx, 0, 0.03, -hz, hz);
    for (const x of [-hx + 0.08, 0, hx - 0.08]) p.box(TIMBER, x - 0.07, x + 0.07, 0.03, 0.12, -hz, hz);
    p.box(TIMBER, -hx, hx, 0.12, 0.145, -hz, hz);
    p.box(m.bricks, -hx + 0.02, hx - 0.02, 0.145, 2 * hy, -hz + 0.02, hz - 0.02);
    if (detail === 'full') {
      for (const x of [-hx * 0.5, hx * 0.5]) p.box(DARK, x - 0.02, x + 0.02, 0.145, 2 * hy + 0.005, -hz + 0.015, hz - 0.015);
    }
  } else if (kind === 'beam') {
    // an I-beam: two flanges and the web, in red primer
    const fl = 0.019;
    p.box(PRIMER, -hx, hx, 0, fl, -hz, hz);
    p.box(PRIMER, -hx, hx, 2 * hy - fl, 2 * hy, -hz, hz);
    p.box(PRIMER, -hx, hx, fl, 2 * hy - fl, -0.0055, 0.0055);
  } else if (kind === 'container') {
    p.box(m.container, -hx, hx, 0.1, 2 * hy - 0.1, -hz, hz);
    p.box(DARK, -hx, hx, 0, 0.12, -hz, hz);
    p.box(DARK, -hx, hx, 2 * hy - 0.1, 2 * hy, -hz, hz);
    for (const x of [-hx, hx]) for (const z of [-hz, hz]) p.box(DARK, x - 0.08, x + 0.08, 0, 2 * hy, z - 0.08, z + 0.08);
    if (detail === 'full') {
      // the doors at one end, their locking bars
      p.box(DARK, hx - 0.005, hx + 0.01, 0.15, 2 * hy - 0.15, -0.01, 0.01);
      for (const z of [-0.6, -0.35, 0.35, 0.6]) p.box(STEEL, hx + 0.01, hx + 0.04, 0.2, 2 * hy - 0.2, z - 0.02, z + 0.02);
    }
  } else if (kind === 'formwork') {
    p.box(m.formwork, -hx, hx, 0.1, 2 * hy, -hz, hz);
    p.box(m.plywood, -hx + 0.03, hx - 0.03, 2 * hy, 2 * hy + 0.005, -hz + 0.03, hz - 0.03);
    for (const x of [-hx + 0.3, hx - 0.3]) p.box(TIMBER, x - 0.06, x + 0.06, 0, 0.1, -hz, hz);
  } else {
    // reinforcing mesh: a bundle of mats, seen through
    for (let k = 0; k < (detail === 'full' ? 6 : 3); k++) {
      const y = 0.04 + (k * (2 * hy - 0.08)) / 5;
      p.box(m.mesh, -hx, hx, y, y + 0.012, -hz, hz);
    }
    for (const x of [-hx + 0.4, 0, hx - 0.4]) p.box(STEEL, x - 0.01, x + 0.01, 0, 2 * hy, -hz, hz);
  }
  p.build(g);
  return g;
}

/** A rope (a sling's leg): a unit cylinder stretched between two points each picture. */
class Leg {
  readonly mesh: THREE.Mesh;
  private static readonly geo = new THREE.CylinderGeometry(1, 1, 1, 5, 1).translate(0, 0.5, 0);
  private readonly d = new THREE.Vector3();

  constructor(parent: THREE.Object3D) {
    this.mesh = new THREE.Mesh(Leg.geo, SLING);
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  set(a: THREE.Vector3, b: THREE.Vector3): void {
    this.d.subVectors(b, a);
    const len = this.d.length();
    this.mesh.visible = len > 0.01;
    if (!this.mesh.visible) return;
    this.mesh.position.copy(a);
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.d.divideScalar(len));
    this.mesh.scale.set(0.018, len, 0.018);
  }
}

/** One load as it is drawn: its mesh, the bearers under it, the slings when it hangs. */
interface DrawnLoad {
  group: THREE.Group;
  mesh: THREE.Group;
  bearers: THREE.Group;
  legs: Leg[];
}

/**
 * The construction site.  `show` lays it out once the ground there is
 * loaded (call it again until it says so), `update` puts the loads where
 * the work has them, `hide` takes it all away.
 */
export class CraneSiteScene {
  readonly group = new THREE.Group();
  /** the tower crane standing on the site when the player works another crane (null: the player's own is there) */
  private tower: TowerCraneModel | null = null;
  private readonly made: THREE.BufferGeometry[] = [];
  private readonly loads = new Map<string, DrawnLoad>();
  private zoneMesh: THREE.Group | null = null;
  private zoneFor = '';
  private readonly aim = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.9, 12).rotateX(Math.PI), AIM);
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private detail: CraneDetail = 'full';

  constructor() {
    this.group.name = 'crane site';
    this.group.visible = false;
    this.aim.visible = false;
    this.group.add(this.aim);
  }

  /**
   * Lay the site out over the ground: `heightAt` is the map's ground (NaN
   * where it is not loaded yet – then it returns false: call again), `y0`
   * the base height of the building, `towerToo` whether the site's tower
   * crane is to be drawn here (not when it is the player's).
   */
  show(p: SitePlacement, heightAt: (x: number, z: number) => number, y0: number, towerToo: boolean, detail: CraneDetail): boolean {
    this.clear();
    this.detail = detail;
    this.heightAt = (x, z) => {
      const h = heightAt(x, z);
      return Number.isNaN(h) ? y0 : h;
    };
    const g = this.group;
    let complete = true;
    const yAt = (u: number, w: number): number => {
      const [x, z] = p.toWorld(u, w);
      const h = heightAt(x, z);
      if (Number.isNaN(h)) {
        complete = false;
        return y0;
      }
      return h;
    };
    const drape = (r: SiteRect, lift: number, mat: THREE.Material, cell = 3): void => {
      const nu = Math.max(1, Math.ceil(Math.abs(r.u1 - r.u0) / cell));
      const nw = Math.max(1, Math.ceil(Math.abs(r.w1 - r.w0) / cell));
      const pos = new Float32Array((nu + 1) * (nw + 1) * 3);
      for (let j = 0; j <= nw; j++) {
        for (let i = 0; i <= nu; i++) {
          const u = r.u0 + ((r.u1 - r.u0) * i) / nu;
          const w = r.w0 + ((r.w1 - r.w0) * j) / nw;
          const [x, z] = p.toWorld(u, w);
          const k = (j * (nu + 1) + i) * 3;
          pos[k] = x;
          pos[k + 1] = yAt(u, w) + lift;
          pos[k + 2] = z;
        }
      }
      const index: number[] = [];
      for (let j = 0; j < nw; j++) {
        for (let i = 0; i < nu; i++) {
          const a = j * (nu + 1) + i;
          index.push(a, a + nu + 1, a + 1, a + 1, a + nu + 1, a + nu + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setIndex(index);
      geo.computeVertexNormals();
      // (whichever way the yard is turned, the ground must face up)
      if (geo.getAttribute('normal').getY(0) < 0) {
        geo.setIndex(index.map((_, k) => index[k - (k % 3) + [0, 2, 1][k % 3]]));
        geo.computeVertexNormals();
      }
      this.made.push(geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      g.add(mesh);
    };
    /** a painted line round a rectangle */
    const outline = (r: SiteRect, width: number, mat: THREE.Material): void => {
      drape({ u0: r.u0, u1: r.u1, w0: r.w0, w1: r.w0 + width }, 0.08, mat, 4);
      drape({ u0: r.u0, u1: r.u1, w0: r.w1 - width, w1: r.w1 }, 0.08, mat, 4);
      drape({ u0: r.u0, u1: r.u0 + width, w0: r.w0, w1: r.w1 }, 0.08, mat, 4);
      drape({ u0: r.u1 - width, u1: r.u1, w0: r.w0, w1: r.w1 }, 0.08, mat, 4);
    };
    // ---- the ground: the depot, the site road, the storage areas, the site itself, the stands
    drape(AREAS.site, 0.04, SAND);
    drape(AREAS.storage, 0.05, GRAVEL);
    drape(AREAS.west, 0.05, GRAVEL);
    drape(AREAS.depot, 0.05, GRAVEL);
    drape(AREAS.road, 0.06, ASPHALT);
    for (const s of Object.values(STANDS)) {
      outline(s.area, 0.2, MARK);
      // (hatched at the front: where the vehicle's nose goes)
      for (let k = 0; k < 4; k++) {
        const u = s.area.u1 - 0.6 - k * 0.9;
        drape({ u0: u - 0.25, u1: u, w0: s.area.w0 + 0.3, w1: s.area.w1 - 0.3 }, 0.08, MARK, 4);
      }
    }
    // ---- what stands on it, in the world's frame: one group, turned like the yard
    const site = new THREE.Group();
    const [ox, oz] = p.toWorld(0, 0);
    site.position.set(ox, y0, oz);
    site.rotation.y = p.yawToWorld(0);
    g.add(site);
    // (the site's own frame in that group: x = u, z = w, y above the base height)
    const b = new Parts();
    const B = BUILDING;
    const full = detail === 'full';
    // the plinth and the slabs, the columns of each storey
    b.box(CONCRETE, B.u0 - 0.2, B.u1 + 0.2, -0.8, B.floors[0], B.w0 - 0.2, B.w1 + 0.2);
    for (let f = 1; f < B.floors.length; f++) b.box(CONCRETE, B.u0, B.u1, B.floors[f] - B.slab, B.floors[f], B.w0, B.w1);
    const cols = [B.u0 + 0.2, B.u0 + 4.1, B.u0 + 8.0, B.u0 + 11.9, B.u1 - 0.2];
    const rows = [B.w0 + 0.2, B.w0 + 4.1, B.w1 - 4.1, B.w1 - 0.2];
    for (let f = 0; f < B.floors.length - 1; f++) {
      for (const u of cols) for (const w of rows) b.box(CONCRETE, u - 0.15, u + 0.15, B.floors[f], B.floors[f + 1] - B.slab, w - 0.15, w + 0.15);
    }
    // the walls of the ground and first floor (masonry, with window openings), the second floor still open
    for (let f = 0; f < 2; f++) {
      const y0w = B.floors[f];
      const y1w = B.floors[f + 1] - B.slab;
      // north and south faces: wall pieces between the windows
      for (const w of [B.w0 + 0.05, B.w1 - 0.05]) {
        for (let u = B.u0 + 0.3; u < B.u1 - 0.3; u += 3.9) {
          b.box(MASONRY, u, u + 1.2, y0w, y1w, w - 0.12, w + 0.12);
          b.box(MASONRY, u + 1.2, Math.min(u + 3.9, B.u1 - 0.3), y0w, y0w + 0.9, w - 0.12, w + 0.12);
          b.box(MASONRY, u + 1.2, Math.min(u + 3.9, B.u1 - 0.3), y1w - 0.45, y1w, w - 0.12, w + 0.12);
        }
      }
      if (f === 0) b.box(MASONRY, B.u0 - 0.07, B.u0 + 0.17, y0w, y1w, B.w0 + 0.3, B.w1 - 0.3);
    }
    // the stair core, a storey above the roof
    b.box(CONCRETE, B.core.u0, B.core.u1, B.floors[0], B.core.top, B.core.w0, B.core.w1);
    // the loading platform at the second floor: its deck, its girders, its side rails
    const P = B.platform;
    b.box(STEEL, P.u0, P.u1, P.y - 0.18, P.y, P.w0, P.w1 + 0.5);
    b.box(PLANK, P.u0 + 0.05, P.u1 - 0.05, P.y, P.y + 0.03, P.w0 + 0.05, P.w1);
    for (const u of [P.u0, P.u1]) {
      b.box(RAIL, u - 0.04, u + 0.04, P.y, P.y + 1.1, P.w0, P.w1);
      b.box(STEEL, u - 0.05, u + 0.05, P.y - 1.4, P.y - 0.18, P.w1 - 0.1, P.w1 + 0.1);
    }
    // the guard rails round the roof
    for (const r of B.rails) {
      b.box(RAIL, r.u0, r.u1, B.railTop - 0.06, B.railTop, r.w0, r.w1);
      b.box(RAIL, r.u0, r.u1, (B.floors[3] + B.railTop) / 2 - 0.03, (B.floors[3] + B.railTop) / 2 + 0.03, r.w0, r.w1);
      const along = r.u1 - r.u0 > r.w1 - r.w0;
      const len = along ? r.u1 - r.u0 : r.w1 - r.w0;
      for (let k = 0; k <= len; k += 2) {
        const u = along ? r.u0 + k : (r.u0 + r.u1) / 2;
        const w = along ? (r.w0 + r.w1) / 2 : r.w0 + k;
        b.box(RAIL, u - 0.03, u + 0.03, B.floors[3], B.railTop, w - 0.03, w + 0.03);
      }
    }
    // the scaffolding: standards, ledgers, decks, toe boards, the diagonals
    for (const s of B.scaffold) {
      const along = s.u1 - s.u0 > s.w1 - s.w0;
      const len = along ? s.u1 - s.u0 : s.w1 - s.w0;
      const bays = Math.max(1, Math.round(len / 2.5));
      for (let k = 0; k <= bays; k++) {
        const t = k / bays;
        for (const side of [0, 1]) {
          const u = along ? s.u0 + t * (s.u1 - s.u0) : side ? s.u1 - 0.05 : s.u0 + 0.05;
          const w = along ? (side ? s.w1 - 0.05 : s.w0 + 0.05) : s.w0 + t * (s.w1 - s.w0);
          b.box(SCAFFOLD, u - 0.025, u + 0.025, 0.3, B.scaffoldTop, w - 0.025, w + 0.025);
        }
      }
      for (let y = 2.3; y < B.scaffoldTop; y += 2) {
        b.box(PLANK, s.u0, s.u1, y - 0.04, y, s.w0, s.w1);
        b.box(SCAFFOLD, s.u0, s.u1, y + 0.45, y + 0.5, along ? s.w1 - 0.07 : s.w0, along ? s.w1 - 0.02 : s.w1);
        b.box(SCAFFOLD, s.u0, s.u1, y + 0.95, y + 1.0, along ? s.w1 - 0.07 : s.w0, along ? s.w1 - 0.02 : s.w1);
        if (full) b.box(PLANK, s.u0, s.u1, y, y + 0.15, along ? s.w1 - 0.05 : s.w0, along ? s.w1 - 0.03 : s.w1);
      }
      if (full) {
        // a diagonal brace in every other bay of the outer face
        for (let k = 0; k < bays; k += 2) {
          const t0 = k / bays;
          const t1 = (k + 1) / bays;
          const n = 8;
          for (let i = 0; i < n; i++) {
            const a = t0 + ((t1 - t0) * i) / n;
            const y = 0.3 + ((B.scaffoldTop - 0.3) * i) / n;
            const u = along ? s.u0 + a * (s.u1 - s.u0) : s.u1 - 0.02;
            const w = along ? s.w1 - 0.02 : s.w0 + a * (s.w1 - s.w0);
            b.box(SCAFFOLD, u - 0.03, u + 0.03, y, y + (B.scaffoldTop - 0.3) / n, w - 0.03, w + 0.03);
          }
        }
      }
    }
    // the delivery truck: cab, chassis, wheels, its flatbed
    const D = DELIVERY;
    b.box(TRUCK_CAB, D.cab.u0, D.cab.u1, D.cab.y0 + 0.9, D.cab.y1, D.cab.w0, D.cab.w1);
    b.box(DARK, D.cab.u0, D.cab.u1, 0.45, 0.95, D.cab.w0 + 0.05, D.cab.w1 - 0.05);
    b.box(GLASS, D.cab.u1 - 0.01, D.cab.u1 + 0.01, 2.0, 2.9, D.cab.w0 + 0.1, D.cab.w1 - 0.1);
    b.box(DARK, D.chassis.u0, D.chassis.u1, 0.75, D.bed.y - 0.15, D.chassis.w0, D.chassis.w1);
    b.box(PLANK, D.bed.u0, D.bed.u1, D.bed.y - 0.15, D.bed.y, D.bed.w0, D.bed.w1);
    for (const u of [6.4, 7.8, 12.9]) for (const w of [D.bed.w0 + 0.3, D.bed.w1 - 0.3]) b.cyl(TYRE, u, 0.5, w, 0.5, 0.4, 'z', 16);
    // the office and the store at the depot, the site's sign
    for (const o of OFFICES) {
      b.box(WHITE, o.u0, o.u1, o.y0, o.y1, o.w0, o.w1);
      b.box(DARK, o.u0 + 0.8, o.u0 + 1.7, 0.2, 2.2, o.w1, o.w1 + 0.02);
      b.box(GLASS, o.u0 + 2.5, o.u1 - 0.6, 1.0, 2.0, o.w1 + 0.005, o.w1 + 0.015);
    }
    // the fence round the site (gaps where the road comes in)
    if (full) {
      const fence = (u0: number, w0: number, u1: number, w1: number): void => {
        const len = Math.hypot(u1 - u0, w1 - w0);
        const n = Math.max(1, Math.round(len / 3.5));
        for (let k = 0; k < n; k++) {
          const a = k / n;
          const c = (k + 1) / n;
          const pu0 = u0 + (u1 - u0) * a;
          const pw0 = w0 + (w1 - w0) * a;
          const pu1 = u0 + (u1 - u0) * c;
          const pw1 = w0 + (w1 - w0) * c;
          b.box(FENCE, Math.min(pu0, pu1), Math.max(pu0, pu1) + 0.02, 0.15, 2.0, Math.min(pw0, pw1), Math.max(pw0, pw1) + 0.02);
          b.box(CONCRETE, pu0 - 0.3, pu0 + 0.3, 0, 0.15, pw0 - 0.12, pw0 + 0.12);
        }
      };
      fence(-47, -27.5, 46, -27.5);
      fence(-47, 27, 46, 27);
      fence(46, -27.5, 46, -24.5);
      fence(46, -16.5, 46, 27);
      fence(-47, -16.5, -47, 27);
    }
    b.build(site);
    // the site's sign at the depot
    const sign = lettering('Baustelle · Kranhof', 4.2, 0.7);
    sign.position.set(-50.5, 2.3, -8.2);
    site.add(sign);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.4, 0.1), STEEL);
    post.position.set(-50.5, 1.2, -8.25);
    site.add(post);
    // ---- the tower crane, when it is not the player's own
    if (towerToo) {
      const t = new TowerCraneModel(detail);
      const [tx, tz] = p.toWorld(TOWER_SITE.u, TOWER_SITE.w);
      const sim = new Crane('tower');
      sim.place(tx, y0, tz, p.yawToWorld(TOWER_SITE.yaw));
      // (out of service: turned with the wind, the hook up)
      sim.q.slew = 2.3;
      sim.q.trolley = 9;
      sim.q.rope = 3;
      sim.place(tx, y0, tz, p.yawToWorld(TOWER_SITE.yaw));
      t.root.position.set(tx, y0, tz);
      t.root.rotation.y = p.yawToWorld(TOWER_SITE.yaw);
      t.root.updateMatrixWorld(true);
      t.pose(sim, 0);
      g.add(t.root);
      this.tower = t;
    }
    g.visible = true;
    return complete;
  }

  /** The site's tower crane (when it stands there): its obstruction lights flash. */
  tick(now: number): void {
    this.tower?.flash(now);
  }

  /**
   * Put the loads where the work has them; `hook`: the hook's bottom (world)
   * for the slings of the load on it; `target`: the load of the task now and
   * the place it goes (marked).
   */
  update(loads: readonly WorldLoad[], hook: THREE.Vector3 | null, target: { load: string; zone: WorldZone } | null, now: number): void {
    for (const l of loads) {
      let d = this.loads.get(l.id);
      if (!d) {
        const group = new THREE.Group();
        const mesh = loadMesh(l.def, this.detail);
        const bearers = new THREE.Group();
        const bp = new Parts();
        const [x0, x1] = l.def.hx > 1.5 ? [-l.def.hx + 0.8, l.def.hx - 0.8] : [-l.def.hx + 0.2, l.def.hx - 0.2];
        for (const x of [x0, x1]) bp.box(TIMBER, x - 0.06, x + 0.06, -0.12, 0, -l.def.hz - 0.15, l.def.hz + 0.15);
        bp.build(bearers);
        group.add(mesh, bearers);
        this.group.add(group);
        const legs: Leg[] = [];
        for (let i = 0; i < 4; i++) legs.push(new Leg(this.group));
        d = { group, mesh, bearers, legs };
        this.loads.set(l.id, d);
      }
      d.group.position.set(l.x, l.y, l.z);
      d.group.rotation.y = l.yaw;
      d.bearers.visible = l.bearers && !l.hooked;
      // the slings from the hook's bowl to the load's corners (two legs to a beam)
      const legs = d.legs;
      if (l.hooked && hook) {
        const def = l.def;
        const c = Math.cos(l.yaw);
        const s = Math.sin(l.yaw);
        const top = l.y + 2 * def.hy;
        const pts: Array<[number, number]> = def.kind === 'beam' ? [[-def.hx * 0.6, 0], [def.hx * 0.6, 0]] : [[-def.hx * 0.85, -def.hz * 0.85], [def.hx * 0.85, -def.hz * 0.85], [def.hx * 0.85, def.hz * 0.85], [-def.hx * 0.85, def.hz * 0.85]];
        legs.forEach((leg, i) => {
          const q = pts[i];
          if (!q) {
            leg.mesh.visible = false;
            return;
          }
          // (local x along (cos, −sin) of the world, z along (sin, cos))
          this.tmpA.set(l.x + q[0] * c + q[1] * s, top, l.z - q[0] * s + q[1] * c);
          leg.set(hook, this.tmpA);
        });
      } else for (const leg of legs) leg.mesh.visible = false;
    }
    // the load of the task now: an arrow over it – the place it goes: lit up
    const aim = this.aim;
    if (target) {
      const l = loads.find((x) => x.id === target.load);
      aim.visible = !!l && !l.hooked;
      if (l) aim.position.set(l.x, l.y + 2 * l.def.hy + 1.6 + 0.25 * Math.sin(now * 3), l.z);
      this.showZone(target.zone, loads.find((x) => x.id === target.load)?.def ?? null);
    } else {
      aim.visible = false;
      this.showZone(null, null);
    }
  }

  /** The place a load goes: a green rectangle the load's size on what it lies on, and a pillar of light above it (seen from afar). */
  private showZone(zone: WorldZone | null, def: LoadDef | null): void {
    const key = zone ? zone.id : '';
    if (key === this.zoneFor) {
      // (the same place – one on the loader crane's bed goes where the truck goes)
      if (zone && this.zoneMesh) {
        this.zoneMesh.position.set(zone.x, Number.isNaN(zone.y) ? this.heightAt(zone.x, zone.z) : zone.y, zone.z);
        this.zoneMesh.rotation.y = zone.yaw;
      }
      return;
    }
    this.zoneFor = key;
    if (this.zoneMesh) {
      this.group.remove(this.zoneMesh);
      this.zoneMesh.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      this.zoneMesh = null;
    }
    if (!zone || !def) return;
    const g = new THREE.Group();
    // (the load's footprint, as large as the zone lets its middle wander)
    const [fx, fz] = loadFootprint(def, 0);
    const w = 2 * (fx + zone.hu);
    const d = 2 * (fz + zone.hw);
    const y = Number.isNaN(zone.y) ? this.heightAt(zone.x, zone.z) : zone.y;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(w, 0.03, d), ZONE);
    plate.position.y = 0.04;
    g.add(plate);
    const e = 0.08;
    for (const [px, pz, sx, sz] of [
      [0, -d / 2, w, e],
      [0, d / 2, w, e],
      [-w / 2, 0, e, d],
      [w / 2, 0, e, d],
    ]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.05, sz), ZONE_EDGE);
      edge.position.set(px, 0.06, pz);
      g.add(edge);
    }
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 30, 12, 1, true), PILLAR);
    pillar.position.y = 15;
    g.add(pillar);
    g.position.set(zone.x, y, zone.z);
    g.rotation.y = zone.yaw;
    this.zoneMesh = g;
    this.group.add(g);
  }

  /** the map's ground (for a place on the ground) */
  private heightAt: (x: number, z: number) => number = () => 0;

  /** Timber bearers lying on the ground (world boxes, from the ground to their top). */
  addBearers(list: ReadonlyArray<{ x0: number; x1: number; z0: number; z1: number; y: number }>): void {
    const p = new Parts();
    for (const b of list) p.box(TIMBER, b.x0, b.x1, b.y - 0.12, b.y, b.z0, b.z1);
    p.build(this.group);
  }

  private clear(): void {
    this.group.clear();
    this.group.add(this.aim);
    for (const geo of this.made) geo.dispose();
    this.made.length = 0;
    this.loads.clear();
    this.zoneMesh = null;
    this.zoneFor = '';
    this.tower = null;
  }

  hide(): void {
    this.clear();
    this.group.visible = false;
  }
}
