// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The theory lessons in 3D (game/theory.ts): the place of a lesson – its
 * asphalt, pavements, paint, kerbs, signs and traffic lights – laid over
 * the practice yard, and the vehicles, cyclists and people of its script
 * drawn with the game's own models (the cars of the traffic, the bus, the
 * lorry, the tram, cyclists, people).  Above the vehicles a question is
 * about, their names float; a tap near one picks it.
 *
 * The place is built anew for each lesson and draped over the ground of
 * the map: every outline is cut into triangles, those into smaller ones,
 * and each corner is lifted onto the terrain.  Nothing of the map changes.
 */
import * as THREE from 'three';
import type { Scene, Pose } from '../game/theory.ts';
import { FOOT, actorLift, lightAt, newPose, poseAt } from '../game/theory.ts';
import type { LightState } from '../game/theory.ts';
import { LIFT, liftAt, newPathPoint, pathPoint } from '../game/theorystage.ts';
import type { SurfaceKind } from '../game/theorystage.ts';
import { carLayout, consistOf } from '../sim/rail.ts';
import type { RailVehicle } from '../sim/rail.ts';
import { RAIL } from '../world/types.ts';
import type { SignPost } from '../world/tilefmt.ts';
import { CarExterior } from './car.ts';
import type { CarVisualState } from './car.ts';
import { COMPACT_DIMS } from './carBody.ts';
import type { CarDims } from './carBody.ts';
import { CyclistModel } from './cyclist.ts';
import { PlayerBus } from './fleet.ts';
import { lookOf, PeopleRenderer, roleLook, workerLook } from './people.ts';
import type { PersonPose } from './people.ts';
import type { SignRenderer } from './signs.ts';
import type { LoadedTile } from './tiles.ts';
import { RailActors } from './trams.ts';
import { PlayerTruck } from './truck.ts';
import type { AnimalModel } from './animals.ts';
import { TheoryExtras } from './theoryprops.ts';
import { armsAt } from '../game/theoryscenes.ts';

/** Where the stage lies on the map: its points and headings in the map's. */
export interface StageFrame {
  toWorld(x: number, z: number): [number, number];
  yawToWorld(yaw: number): number;
}

/** the three bodies of the traffic's cars */
const STYLES: CarDims[] = [COMPACT_DIMS, { ...COMPACT_DIMS, length: 4.6, height: 1.5, wheelbase: 2.7, tail: 1 }, { ...COMPACT_DIMS, length: 4.45, height: 1.42, wheelbase: 2.68, tail: 2 }];
/** an ambulance or a police van: a tall estate (its measures are FOOT.van's) */
const VAN: CarDims = { length: 5.9, width: 2.02, height: 2.35, wheelbase: 3.66, track: 1.74, wheelRadius: 0.36, tyreWidth: 0.225, frontOverhang: 1.0, tail: 1 };

const MAT: Record<SurfaceKind, THREE.Material> = {
  asphalt: new THREE.MeshLambertMaterial({ color: 0x3d4044, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }),
  walk: new THREE.MeshLambertMaterial({ color: 0x9d9c96, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }),
  island: new THREE.MeshLambertMaterial({ color: 0x55803d, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }),
  apron: new THREE.MeshLambertMaterial({ color: 0x7c776f, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }),
  paint: new THREE.MeshBasicMaterial({ color: 0xeeeeea, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -12 }),
  red: new THREE.MeshLambertMaterial({ color: 0xa84a3c, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -9 }),
  steel: new THREE.MeshLambertMaterial({ color: 0xb4b8bc, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -12 }),
};
const KERB = new THREE.MeshLambertMaterial({ color: 0xb9b8b1, side: THREE.DoubleSide });
const METAL = new THREE.MeshLambertMaterial({ color: 0xa3a8ad });
const KERB_METAL = new THREE.MeshLambertMaterial({ color: 0xa3a8ad, side: THREE.DoubleSide });
const POLE = new THREE.MeshLambertMaterial({ color: 0x6f757a });
const HOUSING = new THREE.MeshLambertMaterial({ color: 0x1d2022 });
const ZONE = new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -18 });
const GAP = new THREE.MeshBasicMaterial({ color: 0xffcc00, depthTest: false, transparent: true, opacity: 0.95 });

const LAMP_ON: Record<string, number> = { red: 0xff2a1a, amber: 0xffb000, green: 0x1aff6a };
const LAMP_OFF = 0x161616;

/** the height of a label, as a part of the height of the picture (roughly) */
const LABEL_H = 0.062;

/** The longest edge of a draped triangle (m): short enough to follow the ground. */
const CELL = 2.4;

/** An ambulance or police van: the body, the band round it, its blue lights. */
interface Van {
  car: CarExterior;
  band: THREE.MeshLambertMaterial;
  blue: THREE.MeshBasicMaterial[];
  lamps: THREE.Mesh[];
}

interface ActorView {
  /** what is moved: a group (or null: a person, a tram) */
  root: THREE.Object3D | null;
  car?: CarExterior;
  bus?: PlayerBus;
  truck?: PlayerTruck;
  bike?: CyclistModel;
  van?: Van;
  tram?: RailVehicle;
  /** a deer or a boar (render/animals.ts) */
  animal?: AnimalModel;
  look?: number;
  pose: Pose;
  /** where it is drawn (for the labels and for picking): the middle of the body in the map */
  at: THREE.Vector3;
  height: number;
}

interface Light {
  id: string;
  ped: boolean;
  lamps: THREE.MeshBasicMaterial[];
  shown: string;
}

/** A label floating over a vehicle: its name in a dark pill, pointing down. */
function labelSprite(text: string, accent: boolean): THREE.Sprite {
  const c = document.createElement('canvas');
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const font = '700 44px system-ui, sans-serif';
  g.font = font;
  const w = Math.min(1000, Math.ceil(g.measureText(text).width) + 56);
  c.width = w;
  c.height = 110;
  g.font = font;
  g.fillStyle = accent ? 'rgba(255, 204, 0, 0.96)' : 'rgba(16, 24, 34, 0.9)';
  g.beginPath();
  g.roundRect(3, 3, w - 6, 74, 22);
  g.fill();
  g.beginPath();
  g.moveTo(w / 2 - 16, 76);
  g.lineTo(w / 2 + 16, 76);
  g.lineTo(w / 2, 104);
  g.closePath();
  g.fill();
  g.fillStyle = accent ? '#141000' : '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, 42, w - 30);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // (the same size on the screen however far away: about a sixteenth of its height)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false }));
  const h = LABEL_H;
  sprite.scale.set((h * w) / 110, h, 1);
  sprite.center.set(0.5, 0.02);
  sprite.renderOrder = 20;
  return sprite;
}

export class TheoryView {
  readonly group = new THREE.Group();
  private readonly place = new THREE.Group();
  private readonly movers = new THREE.Group();
  private readonly people = new PeopleRenderer(24);
  private readonly rail = new RailActors();
  /** the props, what people hold, the animals, the headlights in the dark (render/theoryprops.ts) */
  private readonly extras = new TheoryExtras();
  private readonly signs: SignRenderer;
  private signTile: LoadedTile | null = null;
  private readonly made: Array<{ dispose(): void }> = [];
  private actors: ActorView[] = [];
  private lights: Light[] = [];
  private scene: Scene | null = null;
  private frame: StageFrame | null = null;
  private height: (x: number, z: number) => number = () => 0;
  private readonly poses: PersonPose[] = [];
  private readonly labels = new Map<string, THREE.Sprite>();
  private readonly zone: THREE.Mesh;
  private readonly gapBar: THREE.Mesh;
  private gapLabel: THREE.Sprite | null = null;
  private gapText = '';
  private readonly visual: CarVisualState = {
    speedKmh: 0, rpm: 800, gear: 1, indicator: 0, hazard: false, blinkOn: false, lowBeam: true, highBeam: false, handbrake: false, ignition: true, engineRunning: true, abs: false, seatbelt: true, fuel: 0.6, automatic: true, showGear: false, odometerKm: 0,
    steerWheel: 0, wheelSteer: [0, 0, 0, 0], wheelSpin: [0, 0, 0, 0], wheelY: [0.5, 0.5, 0.5, 0.5], clutch: 0, brake: 0, throttle: 0, handbrakeLever: 0, braking: false, reversing: false,
  };
  private readonly pp = newPathPoint();
  private readonly tmp = new THREE.Vector3();
  /**
   * The models, kept from one lesson to the next (the bus and the lorry have
   * mirrors with pictures of their own: made once): the learner's car, the
   * cars of each body, the vans, the cyclists.
   */
  private readonly pool = { me: null as CarExterior | null, cars: [[], [], []] as CarExterior[][], vans: [] as Van[], bikes: [] as CyclistModel[], bus: null as PlayerBus | null, truck: null as PlayerTruck | null };
  /** what of the pool the lesson shown uses */
  private used: Array<() => void> = [];

  constructor(signs: SignRenderer) {
    this.signs = signs;
    this.group.name = 'theory lessons';
    this.group.visible = false;
    this.group.add(this.place, this.movers, this.people.group, this.rail.group, this.extras.group);
    // the blind spot beside and behind the right rear of a car (its own frame: −z ahead, +x right)
    const shape = new THREE.Shape([new THREE.Vector2(0.95, -0.4), new THREE.Vector2(3.9, 1.6), new THREE.Vector2(4.3, 6.4), new THREE.Vector2(0.95, 3.4)]);
    const zg = new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2);
    this.zone = new THREE.Mesh(zg, ZONE);
    this.zone.visible = false;
    this.zone.renderOrder = 6;
    this.gapBar = new THREE.Mesh(new THREE.BoxGeometry(1, 0.05, 0.16), GAP);
    this.gapBar.visible = false;
    this.gapBar.renderOrder = 19;
    this.group.add(this.zone, this.gapBar);
  }

  /** Lay a lesson's place out and make its actors. False while the ground there is not loaded yet (call again). */
  build(scene: Scene, frame: StageFrame, heightAt: (x: number, z: number) => number): boolean {
    const b = scene.stage.bounds;
    // (the ground under the corners and the middle must be there)
    for (const [x, z] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]], [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]]) {
      const [wx, wz] = frame.toWorld(x, z);
      if (Number.isNaN(heightAt(wx, wz))) return false;
    }
    this.clear();
    this.scene = scene;
    this.frame = frame;
    const [cx, cz] = frame.toWorld((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
    const base = heightAt(cx, cz);
    this.height = (x, z) => {
      const h = heightAt(x, z);
      return Number.isNaN(h) ? base : h;
    };
    this.buildPlace(scene);
    this.buildActors(scene);
    this.group.visible = true;
    return true;
  }

  /** Everything of the last lesson gone. */
  clear(): void {
    for (const m of this.made) m.dispose();
    this.made.length = 0;
    this.place.clear();
    this.movers.clear();
    if (this.signTile) {
      for (const d of this.signTile.disposables) d.dispose();
      this.signs.remove(this.signTile);
      this.signTile = null;
    }
    for (const s of this.labels.values()) {
      s.material.map?.dispose();
      s.material.dispose();
      this.group.remove(s);
    }
    this.labels.clear();
    if (this.gapLabel) {
      this.gapLabel.material.map?.dispose();
      this.gapLabel.material.dispose();
      this.group.remove(this.gapLabel);
      this.gapLabel = null;
      this.gapText = '';
    }
    for (const back of this.used) back();
    this.used = [];
    this.extras.clear();
    this.actors = [];
    this.lights = [];
    this.people.update([], 0);
    this.rail.update([]);
    this.zone.visible = false;
    this.gapBar.visible = false;
    this.scene = null;
  }

  hide(): void {
    this.clear();
    this.group.visible = false;
  }

  // ------------------------------------------------------------------ the place
  private buildPlace(scene: Scene): void {
    const f = this.frame as StageFrame;
    const st = scene.stage;
    // the surfaces, one mesh per kind
    const byKind = new Map<SurfaceKind, number[]>();
    for (const s of st.surfaces) {
      const pos = byKind.get(s.kind) ?? [];
      byKind.set(s.kind, pos);
      this.drape(s.ring, s.holes ?? [], LIFT[s.kind], pos);
    }
    for (const [kind, pos] of byKind) {
      if (pos.length === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      this.made.push(geo);
      const mesh = new THREE.Mesh(geo, MAT[kind]);
      mesh.receiveShadow = kind === 'asphalt' || kind === 'walk';
      this.place.add(mesh);
    }
    // the kerbs: a low wall from one surface up to the other
    const kerb: number[] = [];
    for (const k of st.kerbs) {
      const lo = LIFT[k.lo];
      const hi = LIFT[k.hi];
      for (let i = 0; i + 3 < k.line.length; i += 2) {
        const [ax, az] = f.toWorld(k.line[i], k.line[i + 1]);
        const [bx, bz] = f.toWorld(k.line[i + 2], k.line[i + 3]);
        const ya = this.height(ax, az);
        const yb = this.height(bx, bz);
        kerb.push(ax, ya + lo, az, bx, yb + lo, bz, bx, yb + hi, bz, ax, ya + lo, az, bx, yb + hi, bz, ax, ya + hi, az);
      }
    }
    if (kerb.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(kerb, 3));
      geo.computeVertexNormals();
      this.made.push(geo);
      this.place.add(new THREE.Mesh(geo, KERB));
    }
    // crash barriers: posts every 4 m and the rail along them
    for (const g of st.guards) {
      const [ax, az] = f.toWorld(g[0], g[1]);
      const [bx, bz] = f.toWorld(g[2], g[3]);
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(len / 4));
      const postGeo = new THREE.BoxGeometry(0.1, 0.75, 0.1).translate(0, 0.375, 0);
      const posts = new THREE.InstancedMesh(postGeo, METAL, n + 1);
      const m4 = new THREE.Matrix4();
      const beam: number[] = [];
      for (let i = 0; i <= n; i++) {
        const x = ax + ((bx - ax) * i) / n;
        const z = az + ((bz - az) * i) / n;
        const y = this.height(x, z);
        m4.makeTranslation(x, y, z);
        posts.setMatrixAt(i, m4);
        if (i < n) {
          const x2 = ax + ((bx - ax) * (i + 1)) / n;
          const z2 = az + ((bz - az) * (i + 1)) / n;
          const y2 = this.height(x2, z2);
          beam.push(x, y + 0.48, z, x2, y2 + 0.48, z2, x2, y2 + 0.78, z2, x, y + 0.48, z, x2, y2 + 0.78, z2, x, y + 0.78, z);
        }
      }
      posts.instanceMatrix.needsUpdate = true;
      posts.computeBoundingSphere();
      this.made.push(postGeo, posts);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(beam, 3));
      geo.computeVertexNormals();
      this.made.push(geo);
      this.place.add(posts, new THREE.Mesh(geo, KERB_METAL));
    }
    // the signs, drawn by the signs of the map (one "tile" of their own)
    const posts: SignPost[] = [];
    for (const s of st.signs) {
      const [x, z] = f.toWorld(s.x, s.z);
      posts.push({ x, y: this.height(x, z) + liftAt(st, s.x, s.z), z, yaw: f.yawToWorld(s.yaw), s: s.codes, h: 2.0 });
    }
    // the traffic lights: a pole, a box, three lamps – or two for people on foot; the green-arrow sign beside the red lamp
    for (const l of st.lights) {
      const [x, z] = f.toWorld(l.x, l.z);
      const y = this.height(x, z) + liftAt(st, l.x, l.z);
      const yaw = f.yawToWorld(l.yaw);
      const g = new THREE.Group();
      g.position.set(x, y, z);
      g.rotation.y = yaw;
      const top = l.ped ? 2.45 : 3.4;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, top, 8).translate(0, top / 2, 0), POLE);
      const n = l.ped ? 2 : 3;
      const boxH = l.ped ? 0.62 : 0.92;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, boxH, 0.2).translate(0, top - boxH / 2, 0.06), HOUSING);
      g.add(pole, box);
      this.made.push(pole.geometry, box.geometry);
      const lamps: THREE.MeshBasicMaterial[] = [];
      for (let k = 0; k < n; k++) {
        const mat = new THREE.MeshBasicMaterial({ color: LAMP_OFF });
        // (the box faces the way the light's yaw points: its lamps on that side, −z)
        const lamp = new THREE.Mesh(new THREE.CircleGeometry(l.ped ? 0.1 : 0.095, 16), mat);
        lamp.position.set(0, top - boxH / 2 + (n === 3 ? 0.29 - k * 0.29 : 0.15 - k * 0.3), -0.045);
        lamp.rotation.y = Math.PI;
        g.add(lamp);
        lamps.push(mat);
        this.made.push(lamp.geometry, mat);
      }
      this.place.add(g);
      this.lights.push({ id: l.id, ped: !!l.ped, lamps, shown: '' });
      if (l.arrow) {
        // Zeichen 720 to the right of the head (seen by the traffic coming), level with its red lamp
        const right = 0.42;
        posts.push({ x: x - Math.cos(yaw) * right, y, z: z + Math.sin(yaw) * right, yaw, s: ['720'], h: top - 0.5 });
      }
    }
    if (posts.length > 0) {
      const [cx, cz] = f.toWorld(0, 0);
      const tile = { key: 'theory', header: { signs: posts, cx, cz, yBase: this.height(cx, cz) }, group: new THREE.Group(), disposables: [] } as unknown as LoadedTile;
      this.signs.add(tile);
      this.place.add(tile.group);
      this.signTile = tile;
    }
    // trees, posts, a warning triangle, roadworks, a tunnel
    this.extras.build(st, f, this.height);
  }

  /** An outline (with holes) cut into triangles of at most CELL a side, each corner on the ground plus `lift`: into `out` (x, y, z, …). */
  private drape(ring: readonly number[], holes: readonly number[][], lift: number, out: number[]): void {
    const f = this.frame as StageFrame;
    const contour: THREE.Vector2[] = [];
    for (let i = 0; i < ring.length; i += 2) contour.push(new THREE.Vector2(ring[i], ring[i + 1]));
    const hs = holes.map((h) => {
      const v: THREE.Vector2[] = [];
      for (let i = 0; i < h.length; i += 2) v.push(new THREE.Vector2(h[i], h[i + 1]));
      return v;
    });
    let faces: number[][];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, hs);
    } catch {
      return;
    }
    // (after cutting: it drops an end point that repeats the first, and the faces count without it)
    const all = [...contour, ...hs.flat()];
    const put = (x: number, z: number): void => {
      const [wx, wz] = f.toWorld(x, z);
      out.push(wx, this.height(wx, wz) + lift, wz);
    };
    const tri = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, depth: number): void => {
      const ab = Math.hypot(bx - ax, bz - az);
      const bc = Math.hypot(cx - bx, cz - bz);
      const ca = Math.hypot(ax - cx, az - cz);
      if (depth < 7 && Math.max(ab, bc, ca) > CELL) {
        const mx = (ax + bx) / 2;
        const mz = (az + bz) / 2;
        const nx = (bx + cx) / 2;
        const nz = (bz + cz) / 2;
        const ox = (cx + ax) / 2;
        const oz = (cz + az) / 2;
        tri(ax, az, mx, mz, ox, oz, depth + 1);
        tri(mx, mz, bx, bz, nx, nz, depth + 1);
        tri(ox, oz, nx, nz, cx, cz, depth + 1);
        tri(mx, mz, nx, nz, ox, oz, depth + 1);
        return;
      }
      // (facing up on the map, whichever way the outline ran and the stage is turned)
      const [wax, waz] = f.toWorld(ax, az);
      const [wbx, wbz] = f.toWorld(bx, bz);
      const [wcx, wcz] = f.toWorld(cx, cz);
      const up = (wbz - waz) * (wcx - wax) - (wbx - wax) * (wcz - waz) > 0;
      if (up) {
        put(ax, az);
        put(bx, bz);
        put(cx, cz);
      } else {
        put(ax, az);
        put(cx, cz);
        put(bx, bz);
      }
    };
    for (const [a, b, c] of faces) tri(all[a].x, all[a].y, all[b].x, all[b].y, all[c].x, all[c].y, 0);
  }

  // ----------------------------------------------------------------- the actors
  private buildActors(scene: Scene): void {
    let style = 0;
    for (const r of scene.actors) {
      const d = r.def;
      const v: ActorView = { root: null, pose: newPose(), at: new THREE.Vector3(), height: 1.5 };
      switch (d.kind) {
        case 'me': {
          const car = (this.pool.me ??= new CarExterior(0xf3f3ef, { roofSign: true }));
          v.car = car;
          v.root = car.group;
          v.height = 1.5;
          break;
        }
        case 'car': {
          const k = style++ % STYLES.length;
          const car = this.pool.cars[k].pop() ?? new CarExterior(d.colour ?? 0x8a8f96, { dims: STYLES[k] });
          car.paint.color.set(d.colour ?? 0x8a8f96);
          this.used.push(() => this.pool.cars[k].push(car));
          v.car = car;
          v.root = car.group;
          v.height = 1.5;
          break;
        }
        case 'van': {
          const van = this.pool.vans.pop() ?? makeVan();
          this.used.push(() => this.pool.vans.push(van));
          van.car.paint.color.set(d.colour ?? 0xf2f2ee);
          // (a red band round an ambulance, a light one round the police)
          van.band.color.set(d.colour === 0x2d5d9a ? 0xe8edf2 : 0xd2261c);
          for (const l of van.lamps) l.visible = !!d.blue;
          v.van = van;
          v.car = van.car;
          v.root = van.car.group;
          v.height = 2.4;
          break;
        }
        case 'bus': {
          const bus = (this.pool.bus ??= new PlayerBus());
          bus.setLine('', d.display ?? '');
          v.bus = bus;
          v.root = bus.root;
          v.height = 3.2;
          break;
        }
        case 'truck': {
          const t = (this.pool.truck ??= new PlayerTruck());
          v.truck = t;
          v.root = t.root;
          v.height = 3.4;
          break;
        }
        case 'bike': {
          const bike = this.pool.bikes.pop() ?? new CyclistModel(d.colour ?? 0x2f8a4a);
          bike.setColour(d.colour ?? 0x2f8a4a);
          this.used.push(() => this.pool.bikes.push(bike));
          v.bike = bike;
          v.root = bike.group;
          v.height = 1.85;
          break;
        }
        case 'tram': {
          const consist = consistOf(RAIL.TRAM, 'single');
          v.tram = { id: -900, kind: RAIL.TRAM, consist, path: 0, s: 0, dir: 1, speed: 0, dwell: 0, noStop: 0, plan: [], cars: carLayout(consist).map(() => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 })), trail: null as unknown as RailVehicle['trail'], blocked: false, panto: 1 };
          v.height = 3.6;
          break;
        }
        case 'person':
        case 'child':
          v.look = d.kind === 'child' ? childLook(d.look ?? 1) : (d.look ?? 1);
          v.height = d.kind === 'child' ? 1.3 : 1.8;
          if (d.role) {
            // (in their clothes of work or of age: a look of its own number, worn by the people renderer)
            const id = 700000 + scene.actors.indexOf(r) * 1000 + (d.look ?? 1);
            this.people.wear(d.role === 'police' || d.role === 'senior' ? roleLook(id, d.look ?? 1, d.role) : { ...workerLook(d.look ?? 1, 'orange'), id });
            v.look = id;
          }
          break;
        case 'deer':
        case 'boar': {
          const a = this.extras.animal(d.kind);
          v.animal = a;
          v.root = a.group;
          v.height = d.kind === 'deer' ? 1.3 : 0.9;
          break;
        }
      }
      if (v.root) {
        v.root.traverse((o) => {
          if (o instanceof THREE.Mesh) o.castShadow = true;
        });
        this.movers.add(v.root);
      }
      this.actors.push(v);
    }
  }

  /** The scene at time t of the script (`now`: the clock, for the blinking). */
  update(t: number, now: number): void {
    const scene = this.scene;
    const f = this.frame;
    if (!scene || !f) return;
    const blinkOn = Math.floor(now * 3) % 2 === 0;
    this.poses.length = 0;
    const trams: RailVehicle[] = [];
    scene.actors.forEach((r, i) => {
      const v = this.actors[i];
      const p = poseAt(r, t, v.pose);
      const root = v.root;
      if (!p.visible) {
        if (root) root.visible = false;
        this.extras.drop(i);
        this.extras.light(i, r.def, -1, 0, 0, 0, 0, 0);
        return;
      }
      const [x, z] = f.toWorld(p.x, p.z);
      const yaw = f.yawToWorld(p.yaw);
      const lift = actorLift(scene, r, p.x, p.z);
      if (r.def.kind === 'person' || r.def.kind === 'child') {
        const y = this.height(x, z) + lift;
        const arms = armsAt(r.def, t);
        this.poses.push(arms ? { x, y, z, yaw, walk: p.v > 0.05 ? p.s : -1, look: v.look ?? 1, arms, head: 0 } : { x, y, z, yaw, walk: p.v > 0.05 ? p.s : -1, look: v.look ?? 1 });
        v.at.set(x, y + v.height * 0.6, z);
        this.extras.hold(i, r.def, t, x, y, z, yaw);
        return;
      }
      if (v.tram) {
        this.placeTram(r, p, v.tram);
        trams.push(v.tram);
        const mid = v.tram.cars[Math.floor(v.tram.cars.length / 2)];
        v.at.set(mid.x, mid.y + 2, mid.z);
        return;
      }
      if (!root) return;
      root.visible = true;
      // the height of the ground under both axles: the body's height and its slope
      const wb = r.foot.wheelbase;
      const fx = x - Math.sin(yaw) * (wb / 2);
      const fz = z - Math.cos(yaw) * (wb / 2);
      const bx = x + Math.sin(yaw) * (wb / 2);
      const bz = z + Math.cos(yaw) * (wb / 2);
      const yf = this.height(fx, fz);
      const yb = this.height(bx, bz);
      const pitch = Math.atan2(yf - yb, Math.max(1, wb));
      const y = (yf + yb) / 2 + lift;
      root.position.set(x, y, z);
      root.rotation.set(pitch, yaw, 0, 'YXZ');
      v.at.set(x, y + v.height * 0.62, z);
      const braking = p.v < 0.15 || p.a < -0.6;
      const left = blinkOn && (p.blink === 2 || p.blink < 0);
      const right = blinkOn && (p.blink === 2 || p.blink === 1);
      if (v.car) {
        const rad = v.car.dims.wheelRadius;
        const spin = (p.s - r.foot.front) / rad;
        v.car.setWheels([p.steer, p.steer, 0, 0], [spin, spin, spin, spin], [rad, rad, rad, rad]);
        v.car.setLamps({ low: true, high: false, brake: braking, reverse: false, left, right });
        if (v.van && r.def.blue) {
          const k = Math.floor(now * 6) % 2;
          v.van.blue[0].color.set(k === 0 ? 0x4d8bff : 0x0b1a44);
          v.van.blue[1].color.set(k === 1 ? 0x4d8bff : 0x0b1a44);
        }
      } else if (v.bus || v.truck) {
        const s = this.visual;
        const rad = v.bus ? 0.5 : 0.49;
        s.wheelSpin.fill((p.s - r.foot.front) / rad);
        s.wheelSteer[0] = s.wheelSteer[1] = p.steer;
        s.wheelY.fill(rad);
        s.indicator = p.blink === 2 ? 0 : p.blink;
        s.hazard = p.blink === 2;
        s.blinkOn = blinkOn;
        s.braking = braking;
        s.speedKmh = p.v * 3.6;
        s.steerWheel = p.steer * 12;
        if (v.bus) v.bus.update(s, 0, now);
        else v.truck?.update(s, 0, now);
      } else if (v.bike) {
        // (the pedals go round once in about four metres, the wheels as they roll)
        v.bike.pose(p.s * 1.6, p.s / 0.34, false);
      } else if (v.animal) v.animal.pose(p.s, p.v);
      // the light of its headlights on the road, in the dark
      if (r.def.beam) this.extras.light(i, r.def, t, x, y, z, yaw, r.foot.front);
    });
    this.extras.update(t);
    this.people.update(this.poses, now);
    this.rail.update(trams);
    // the lamps of the lights
    for (const l of this.lights) {
      const st: LightState = lightAt(scene, l.id, t);
      const key = `${st}${l.ped ? 'p' : ''}${st === 'A' || st === 'Y' ? (blinkOn ? 1 : 0) : ''}`;
      if (key === l.shown) continue;
      l.shown = key;
      if (l.ped) {
        l.lamps[0].color.set(st === 'R' ? LAMP_ON.red : LAMP_OFF);
        l.lamps[1].color.set(st === 'G' ? LAMP_ON.green : LAMP_OFF);
      } else {
        l.lamps[0].color.set(st === 'R' || st === 'Y' ? LAMP_ON.red : LAMP_OFF);
        l.lamps[1].color.set(st === 'A' || st === 'Y' ? LAMP_ON.amber : LAMP_OFF);
        l.lamps[2].color.set(st === 'G' ? LAMP_ON.green : LAMP_OFF);
      }
    }
  }

  /** The cars of a tram, each where the track has it, from its nose back. */
  private placeTram(r: Scene['actors'][number], p: Pose, v: RailVehicle): void {
    const f = this.frame as StageFrame;
    const roles = carLayout(v.consist);
    roles.forEach((role, i) => {
      const s0 = p.s - role.start;
      const s1 = s0 - role.len;
      pathPoint(r.path, s0, this.pp);
      const [ax, az] = f.toWorld(this.pp.x, this.pp.z);
      pathPoint(r.path, s1, this.pp);
      const [bx, bz] = f.toWorld(this.pp.x, this.pp.z);
      const ya = this.height(ax, az);
      const yb = this.height(bx, bz);
      const c = v.cars[i];
      c.x = (ax + bx) / 2;
      c.z = (az + bz) / 2;
      c.y = (ya + yb) / 2 + LIFT.asphalt;
      c.yaw = Math.atan2(-(ax - bx), -(az - bz));
      c.pitch = Math.atan2(ya - yb, role.len);
    });
  }

  // ------------------------------------------------------------------ overlays
  /**
   * Names over these actors (a question is about them) – or none.  `you`:
   * the learner's own car, marked always (in the accent colour).
   */
  setLabels(names: ReadonlyMap<string, string>, you: string): void {
    const scene = this.scene;
    if (!scene) return;
    const want = new Map<string, string>();
    for (const [id, text] of names) want.set(id, text);
    if (!want.has('me') && you) want.set('me', you);
    for (const [id, s] of this.labels) {
      if (want.get(id) === s.name) continue;
      s.material.map?.dispose();
      s.material.dispose();
      this.group.remove(s);
      this.labels.delete(id);
    }
    for (const [id, text] of want) {
      if (this.labels.has(id)) continue;
      const s = labelSprite(text, id === 'me');
      s.name = text;
      this.labels.set(id, s);
      this.group.add(s);
    }
  }

  /** Where the labels float now (call after `update`). */
  placeLabels(now: number): void {
    const scene = this.scene;
    if (!scene) return;
    for (const [id, s] of this.labels) {
      const i = scene.actors.findIndex((a) => a.def.id === id);
      const v = this.actors[i];
      if (!v || !v.pose.visible) {
        s.visible = false;
        continue;
      }
      s.visible = true;
      s.position.copy(v.at);
      s.position.y += v.height * 0.45 + 0.3 + Math.sin(now * 3) * 0.06;
    }
  }

  /** The blind spot of an actor shown on the ground (null: none). */
  showZone(id: string | null): void {
    const scene = this.scene;
    const f = this.frame;
    const i = id && scene ? scene.actors.findIndex((a) => a.def.id === id) : -1;
    const v = this.actors[i];
    if (!scene || !f || !v || !v.root || !v.pose.visible) {
      this.zone.visible = false;
      return;
    }
    this.zone.visible = true;
    this.zone.position.copy(v.root.position);
    this.zone.position.y += 0.03;
    this.zone.rotation.set(0, f.yawToWorld(v.pose.yaw), 0);
    // (drawn for a car: a lorry's is as much wider and longer as the lorry is, and begins at its cab – beside the front)
    const foot = FOOT[scene.actors[i].def.kind];
    this.zone.scale.set(foot.width / FOOT.car.width, 1, foot.length / FOOT.car.length);
    if (scene.actors[i].def.kind === 'truck') {
      const yaw = f.yawToWorld(v.pose.yaw);
      this.zone.position.x -= Math.sin(yaw) * foot.front;
      this.zone.position.z -= Math.cos(yaw) * foot.front;
    }
  }

  /** The gap beside a vehicle passing another, with its width written over it (null: none); returns the gap (m). */
  showGap(a: string | null, b: string | null, text: (m: number) => string): number {
    const scene = this.scene;
    const f = this.frame;
    const ia = a && scene ? scene.actors.findIndex((x) => x.def.id === a) : -1;
    const ib = b && scene ? scene.actors.findIndex((x) => x.def.id === b) : -1;
    const va = this.actors[ia];
    const vb = this.actors[ib];
    if (!scene || !f || !va || !vb || !va.pose.visible || !vb.pose.visible) {
      this.gapBar.visible = false;
      if (this.gapLabel) this.gapLabel.visible = false;
      return 0;
    }
    // across the way b goes: from b's left side to a's right side (a passes on b's left)
    const pa = va.pose;
    const pb = vb.pose;
    const lx = -Math.cos(pb.yaw);
    const lz = Math.sin(pb.yaw);
    const fa = FOOT[scene.actors[ia].def.kind];
    const fb = FOOT[scene.actors[ib].def.kind];
    const across = (pa.x - pb.x) * lx + (pa.z - pb.z) * lz;
    const gap = Math.max(0, across - fa.width / 2 - fb.width / 2);
    const sx = pb.x + lx * (fb.width / 2);
    const sz = pb.z + lz * (fb.width / 2);
    const ex = sx + lx * gap;
    const ez = sz + lz * gap;
    const [wsx, wsz] = f.toWorld(sx, sz);
    const [wex, wez] = f.toWorld(ex, ez);
    const y = this.height((wsx + wex) / 2, (wsz + wez) / 2) + 0.75;
    this.gapBar.visible = gap > 0.05;
    this.gapBar.position.set((wsx + wex) / 2, y, (wsz + wez) / 2);
    this.gapBar.scale.set(Math.max(0.05, gap), 1, 1);
    this.gapBar.rotation.set(0, Math.atan2(-(wez - wsz), wex - wsx), 0);
    const label = text(gap);
    if (label !== this.gapText) {
      if (this.gapLabel) {
        this.gapLabel.material.map?.dispose();
        this.gapLabel.material.dispose();
        this.group.remove(this.gapLabel);
      }
      this.gapLabel = labelSprite(label, true);
      this.group.add(this.gapLabel);
      this.gapText = label;
    }
    if (this.gapLabel) {
      this.gapLabel.visible = true;
      this.gapLabel.position.set((wsx + wex) / 2, y + 0.4, (wsz + wez) / 2);
    }
    return gap;
  }

  /** Where an actor is drawn (the middle of its body), for the camera that follows it. */
  where(id: string, out: THREE.Vector3): boolean {
    const scene = this.scene;
    const i = scene ? scene.actors.findIndex((a) => a.def.id === id) : -1;
    const v = this.actors[i];
    if (!v || !v.pose.visible) return false;
    out.copy(v.at);
    return true;
  }

  /** The heading of an actor on the map (for the camera that follows it). */
  heading(id: string): number | null {
    const scene = this.scene;
    const f = this.frame;
    const i = scene ? scene.actors.findIndex((a) => a.def.id === id) : -1;
    const v = this.actors[i];
    return f && v ? f.yawToWorld(v.pose.yaw) : null;
  }

  /**
   * Which of these actors a tap at (px, py) – pixels in a view `w` × `h` –
   * means: the one whose body or label is nearest on the screen, within a
   * finger's reach.
   */
  pick(ids: readonly string[], camera: THREE.Camera, px: number, py: number, w: number, h: number): string | null {
    const scene = this.scene;
    if (!scene) return null;
    let best: string | null = null;
    let bestD = Math.max(44, Math.min(w, h) * 0.09);
    for (const id of ids) {
      const i = scene.actors.findIndex((a) => a.def.id === id);
      const v = this.actors[i];
      if (!v || !v.pose.visible) continue;
      const label = this.labels.get(id);
      const spots: Array<[THREE.Vector3, number]> = [[v.at, 0], [v.at.clone().setY(v.at.y - v.height * 0.4), 0]];
      // (the label stands over its anchor: half its height higher on the screen)
      if (label?.visible) spots.push([label.position, (LABEL_H * h) / 2]);
      for (const [p, up] of spots) {
        this.tmp.copy(p).project(camera);
        if (this.tmp.z > 1) continue;
        const sx = ((this.tmp.x + 1) / 2) * w;
        const sy = ((1 - this.tmp.y) / 2) * h - up;
        const d = Math.hypot(sx - px, sy - py);
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
    }
    return best;
  }
}

/** An ambulance's or a police van's body: a tall estate with a band round it and two blue lamps on the roof. */
function makeVan(): Van {
  const car = new CarExterior(0xf2f2ee, { dims: VAN, ownMaterials: true });
  const band = new THREE.MeshLambertMaterial({ color: 0xd2261c });
  car.group.add(new THREE.Mesh(new THREE.BoxGeometry(VAN.width + 0.02, 0.24, VAN.length * 0.86).translate(0, 1.0, 0.1), band));
  const blue: THREE.MeshBasicMaterial[] = [];
  const lamps: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x1b3d9a });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.3), mat);
    lamp.position.set(side * 0.42, VAN.height + 0.06, -VAN.length / 2 + 1.6);
    car.group.add(lamp);
    blue.push(mat);
    lamps.push(lamp);
  }
  return { car, band, blue, lamps };
}

/** The look of a child: the first child among the looks from `seed` on. */
function childLook(seed: number): number {
  for (let id = seed; id < seed + 600; id++) if (lookOf(id).scale < 0.82) return id;
  return seed;
}
