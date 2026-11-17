// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The roadworks and the demonstrations of the day as they are seen
 * (sim/roadevents.ts says where they are and what they are made of).
 *
 * A work zone: its signs on mobile feet (drawn with the sign atlas of
 * render/signs.ts), the barrier (Zeichen 600) and the beacons (Zeichen 605)
 * in red and white with their yellow lamps – lit at night, the beacons'
 * flashing –, cones, a fence round the pit, a mini excavator, a heap of
 * gravel, a site trailer, the temporary traffic lights with their three
 * lamps, and the workers in orange.  A march: the police barriers with
 * their lamps and tape, the signs of the diversion, officers, the patrol
 * cars of render/emergency.ts at its ends (blue lights, "STOP POLIZEI"), and the
 * crowd – everybody of render/people.ts, many of them with placards on
 * sticks or a banner between two of them, in bright colours and without
 * any words.
 *
 * Everything that stands still is built once per zone or closure as two
 * merged meshes (one painted per vertex, one with the red-and-white stripes)
 * when it comes within reach of the camera, and thrown away when it is far
 * behind; what moves – the people, the placards, the lamps – is updated each
 * frame and drawn instanced.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CrowdNoise } from '../audio/crowd.ts';
import type { AudioOut } from '../audio/crowd.ts';
import { hash01, newPolySample } from '../core/geom.ts';
import { gameClock, sunAt } from '../game/clock.ts';
import { crowdShape, lightAt, marchAt, routeAt } from '../sim/roadevents.ts';
import type { ClosureLayout, Demonstration, RoadEvents, WorkZone, WorksLayout } from '../sim/roadevents.ts';
import { SIG } from '../sim/signals.ts';
import type { SignPost } from '../world/tilefmt.ts';
import { buildPoliceCar } from './emergency.ts';
import type { EmergencyModel } from './emergency.ts';
import { PeopleRenderer, workerLook } from './people.ts';
import type { Look, PersonPose } from './people.ts';
import type { SignRenderer } from './signs.ts';

/** a site is built within this distance of the camera, and thrown away beyond the other (m) */
const BUILD = 600;
const DROP = 820;
/** the people of a march are drawn within this distance (m) */
const CROWD_NEAR = 420;
/** look numbers of the people at work: road workers in orange, police officers (render/people.ts gives the rest of them) */
const WORKER_LOOKS = 0x7100000;
const POLICE_LOOKS = 0x7200000;

const ORANGE = 0xf2661c;
const YELLOW = 0xf2c418;
const DARK = 0x26282b;

/** The red-and-white stripes of barriers, beacons and tape: one tile is half a metre square. */
function stripeTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f4f0';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#d3192a';
  // two diagonal bands per tile, seamless when repeated
  for (const o of [-64, 0, 64]) {
    g.beginPath();
    g.moveTo(o, 64);
    g.lineTo(o + 32, 64);
    g.lineTo(o + 96, 0);
    g.lineTo(o + 64, 0);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Pieces of a site, collected and then merged into two meshes. */
class Parts {
  readonly plain: THREE.BufferGeometry[] = [];
  readonly striped: THREE.BufferGeometry[] = [];
  readonly lamps: THREE.BufferGeometry[] = [];
  readonly blinks: THREE.BufferGeometry[] = [];

  /** A piece painted in one colour (positions relative to the site), turned by yaw (and tipped by pitch before that). */
  add(g: THREE.BufferGeometry, color: number, x: number, y: number, z: number, yaw = 0, pitch = 0): void {
    if (pitch) g.rotateX(pitch);
    if (yaw) g.rotateY(yaw);
    g.translate(x, y, z);
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    const c = new THREE.Color(color);
    const count = n.getAttribute('position').count;
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    n.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (n.getAttribute('uv')) n.deleteAttribute('uv');
    this.plain.push(n);
  }

  box(w: number, h: number, d: number, color: number, x: number, y: number, z: number, yaw = 0, pitch = 0): void {
    this.add(new THREE.BoxGeometry(w, h, d), color, x, y, z, yaw, pitch);
  }

  /** A board in the stripes: `w` × `h` × `d`, its stripes `w / 0.5` and `h / 0.5` tiles (mirrored with flip). */
  stripes(w: number, h: number, d: number, x: number, y: number, z: number, yaw: number, flip = false, pitch = 0): void {
    const g = new THREE.BoxGeometry(w, h, d);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (flip ? 1 - uv.getX(i) : uv.getX(i)) * Math.max(0.5, w / 0.5), uv.getY(i) * Math.max(0.5, h / 0.5));
    if (pitch) g.rotateX(pitch);
    g.rotateY(yaw);
    g.translate(x, y, z);
    this.striped.push(g.index ? g.toNonIndexed() : g);
  }

  /** A warning lamp: steady (a barrier's) or flashing (a beacon's). */
  lamp(x: number, y: number, z: number, yaw: number, flashing: boolean): void {
    const g = new THREE.CylinderGeometry(0.075, 0.075, 0.05, 10).rotateX(Math.PI / 2).rotateY(yaw).translate(x, y, z);
    (flashing ? this.blinks : this.lamps).push(g.index ? g.toNonIndexed() : g);
  }

  /** The merged meshes (null for an empty kind). */
  build(plainMat: THREE.Material, stripeMat: THREE.Material, lampMat: THREE.Material, blinkMat: THREE.Material): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    const one = (list: THREE.BufferGeometry[], mat: THREE.Material, name: string, shadow: boolean): void => {
      if (list.length === 0) return;
      // (the attributes must be alike: without uv where any piece has none)
      const uvs = list.every((g) => g.getAttribute('uv'));
      if (!uvs) for (const g of list) if (g.getAttribute('uv')) g.deleteAttribute('uv');
      const g = mergeGeometries(list, false);
      for (const p of list) p.dispose();
      if (!g) return;
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.name = name;
      m.castShadow = shadow;
      m.receiveShadow = true;
      out.push(m);
    };
    one(this.plain, plainMat, 'roadworks', true);
    one(this.striped, stripeMat, 'roadworks: stripes', true);
    one(this.lamps, lampMat, 'roadworks: lamps', false);
    one(this.blinks, blinkMat, 'roadworks: flashing lamps', false);
    return out;
  }
}

/** One temporary light: its head and the three lamps in it. */
interface SiteLight {
  zone: WorkZone;
  group: 0 | 1;
  red: THREE.Mesh;
  amber: THREE.Mesh;
  green: THREE.Mesh;
}

/** What is built of a zone or a closure. */
interface Site {
  /** in the world's frame (the signs); `local` in it at the middle of the site (everything else) */
  group: THREE.Group;
  local: THREE.Group;
  disposables: Array<{ dispose(): void }>;
  /** its signs, made by the sign renderer – given back to it when the site goes */
  signs: { by: SignRenderer; group: THREE.Object3D } | null;
  /** the patrol cars at a closure (taken from the pool, given back when the site goes) */
  police: EmergencyModel[];
  lights: SiteLight[];
  x: number;
  z: number;
  /** the version of the events it was built for (a closure is rebuilt when its march changes) */
  version: number;
}

export class RoadworksRenderer {
  readonly group = new THREE.Group();
  private readonly people = new PeopleRenderer(300);
  private readonly sites = new Map<string, Site>();
  /** patrol cars not shown now (models are kept for the next closure) */
  private readonly policePool: EmergencyModel[] = [];
  private readonly stripeTex = stripeTexture();
  private readonly plainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly stripeMat = new THREE.MeshLambertMaterial({ map: this.stripeTex });
  /** the lamps: a barrier's burn steadily at night, a beacon's flash */
  private readonly lampMat = new THREE.MeshLambertMaterial({ color: 0xc8a020, emissive: 0x000000 });
  private readonly blinkMat = new THREE.MeshLambertMaterial({ color: 0xc8a020, emissive: 0x000000 });
  /** the lamps of the temporary lights: off, and lit */
  private readonly off = { red: new THREE.MeshLambertMaterial({ color: 0x3a0d0d }), amber: new THREE.MeshLambertMaterial({ color: 0x3a2a08 }), green: new THREE.MeshLambertMaterial({ color: 0x0b2a14 }) };
  private readonly on = {
    red: new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
    amber: new THREE.MeshBasicMaterial({ color: 0xffb21a }),
    green: new THREE.MeshBasicMaterial({ color: 0x2aff6a }),
  };
  private readonly lampGeo = new THREE.CircleGeometry(0.085, 14);
  private readonly poses: PersonPose[] = [];
  private readonly worn = new Map<number, Look>();
  private readonly smp = newPolySample();
  // the placards and banners of the marches
  private readonly sticks: THREE.InstancedMesh;
  private readonly boards: THREE.InstancedMesh;
  private readonly marks: THREE.InstancedMesh;
  private readonly banners: THREE.InstancedMesh;
  private readonly bands: THREE.InstancedMesh;
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly col = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);
  /** how many of a crowd are drawn at most (the quality of the graphics) */
  crowdCap = 220;
  /** the whistles and the murmur of a march (null: silent) */
  private readonly noise: CrowdNoise | null;

  /** `audio`: the game's sound, for the march to be heard (none: silent). */
  constructor(audio: AudioOut | null = null) {
    this.noise = audio ? new CrowdNoise(audio) : null;
    this.group.name = 'roadworks and demonstrations';
    this.group.add(this.people.group);
    const stick = new THREE.BoxGeometry(0.03, 1.35, 0.03).translate(0, 0.675, 0);
    const board = new THREE.BoxGeometry(0.62, 0.46, 0.02);
    const mark = new THREE.CircleGeometry(0.13, 16);
    const banner = new THREE.PlaneGeometry(1, 0.7);
    const band = new THREE.PlaneGeometry(1, 0.16);
    const cloth = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    this.sticks = new THREE.InstancedMesh(stick, new THREE.MeshLambertMaterial({ color: 0x9a7a52 }), 160);
    this.boards = new THREE.InstancedMesh(board, new THREE.MeshLambertMaterial({ color: 0xffffff }), 80);
    this.marks = new THREE.InstancedMesh(mark, new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }), 80);
    this.banners = new THREE.InstancedMesh(banner, cloth, 12);
    this.bands = new THREE.InstancedMesh(band, cloth, 12);
    for (const m of [this.sticks, this.boards, this.marks, this.banners, this.bands]) {
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.name = 'demonstration: placards';
      this.group.add(m);
    }
  }

  /**
   * Each frame: the sites near the camera built (and those far behind
   * thrown away), the lamps and lights as they are now, the people.
   * `time`: seconds of the game (for the small movements of the people), `dt`: since the last frame.
   */
  update(ev: RoadEvents | null, signs: SignRenderer | null, camX: number, camZ: number, time: number, dt = 0): void {
    const poses = this.poses;
    poses.length = 0;
    if (!ev) {
      this.people.update(poses, time);
      this.noise?.update(dt, Infinity, 0, false);
      return;
    }
    // --- the sites near the camera: built once, dropped when far
    const want = new Set<string>();
    for (const z of ev.zones.values()) {
      if (Math.hypot(z.x - camX, z.z - camZ) > BUILD) continue;
      const key = `works:${z.id}:${z.seed}`;
      want.add(key);
      if (!this.sites.has(key)) this.sites.set(key, this.buildWorks(z, ev.worksLayout(z), signs));
    }
    for (const d of ev.demos) {
      if (!ev.marching(d) || Math.hypot(d.x - camX, d.z - camZ) > BUILD + 900) continue;
      const key = `demo:${d.id}`;
      want.add(key);
      const site = this.sites.get(key);
      if (site && site.version !== d.route?.length) {
        this.drop(key, site);
      }
      if (!this.sites.has(key)) this.sites.set(key, this.buildClosure(ev.closureLayout(d), signs, d.route?.length ?? 0));
    }
    for (const [key, site] of this.sites) {
      if (want.has(key)) continue;
      if (key.startsWith('demo:') || Math.hypot(site.x - camX, site.z - camZ) > DROP || !this.zoneStill(ev, key)) this.drop(key, site);
    }
    // --- the lamps: lit from dusk to dawn, the beacons' flashing about once a second
    const sun = sunAt(gameClock.ms()).elevation;
    const night = Math.min(1, Math.max(0, (4 - sun) / 8));
    this.lampMat.emissive.setRGB(1, 0.72, 0.15).multiplyScalar(0.95 * night);
    const flash = time % 1 < 0.45 ? 1 : 0;
    this.blinkMat.emissive.setRGB(1, 0.72, 0.15).multiplyScalar(1.1 * night * flash);
    // --- the temporary lights, the blue lights of the patrol cars
    for (const site of this.sites.values()) {
      site.police.forEach((m, i) => m.setLights(true, time + i * 0.17));
      for (const l of site.lights) {
        const st = lightAt(l.zone, l.group, ev.signals.time).state;
        l.red.material = st === SIG.RED || st === SIG.RED_AMBER ? this.on.red : this.off.red;
        l.amber.material = st === SIG.AMBER || st === SIG.RED_AMBER ? this.on.amber : this.off.amber;
        l.green.material = st === SIG.GREEN ? this.on.green : this.off.green;
      }
    }
    // --- the people at work
    for (const z of ev.zones.values()) {
      if (Math.abs(z.x - camX) > 260 || Math.abs(z.z - camZ) > 260) continue;
      const L = ev.worksLayout(z);
      L.workers.forEach((w, i) => this.worker(w, time, i));
    }
    // --- the marches: their crowds, the officers at the barriers and beside the march
    let sticks = 0;
    let boards = 0;
    let banners = 0;
    const ms = ev.now();
    let heard = Infinity;
    let heardSize = 0;
    let heardWalking = false;
    for (const d of ev.demos) {
      if (!ev.marching(d) || !d.route) continue;
      if (Math.abs(d.x - camX) > 1500 || Math.abs(d.z - camZ) > 1500) continue;
      // (how far its middle is: for what is heard of it)
      const m = marchAt(d, ms);
      if (routeAt(ev.world, d.route, m.head - (m.dir * crowdShape(d).length) / 2, 0, this.smp)) {
        const dist = Math.hypot(this.smp.x - camX, this.smp.z - camZ);
        if (dist < heard) {
          heard = dist;
          heardSize = d.size;
          heardWalking = m.walking;
        }
      }
      const L = ev.closureLayout(d);
      L.officers.forEach((o, i) => {
        if (Math.abs(o.x - camX) < 300 && Math.abs(o.z - camZ) < 300) poses.push({ x: o.x, y: o.y, z: o.z, yaw: o.yaw, walk: -1, look: this.police(d.id * 31 + i) });
      });
      const counts = this.crowd(ev, d, ms, time, camX, camZ, sticks, boards, banners);
      sticks = counts[0];
      boards = counts[1];
      banners = counts[2];
    }
    this.finish(this.sticks, sticks);
    this.finish(this.boards, boards);
    this.finish(this.marks, boards);
    this.finish(this.banners, banners);
    this.finish(this.bands, banners);
    this.people.update(poses, time);
    this.noise?.update(dt, heard, heardSize, heardWalking);
  }

  /** Is the zone a site was built for still there (its road loaded, the same day)? */
  private zoneStill(ev: RoadEvents, key: string): boolean {
    const [, id, seed] = key.split(':');
    const z = ev.zones.get(Number(id));
    return !!z && z.seed === Number(seed);
  }

  private drop(key: string, site: Site): void {
    this.group.remove(site.group);
    for (const d of site.disposables) d.dispose();
    // (the sign atlas may draw other signs where these were, once nothing else shows them)
    if (site.signs) site.signs.by.release(site.signs.group);
    for (const m of site.police) {
      site.group.remove(m.group);
      this.policePool.push(m);
    }
    this.sites.delete(key);
  }

  private finish(m: THREE.InstancedMesh, n: number): void {
    m.count = n;
    m.visible = n > 0;
    if (n > 0) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  /** A worker: walks to and fro between two points (at a slow pace, pausing at the ends) or stands. */
  private worker(w: WorksLayout['workers'][number], time: number, i: number): void {
    const look = WORKER_LOOKS + (w.look % 0xfffff);
    if (!this.worn.has(look)) {
      const L = workerLook(look, 'orange');
      const trousers = new THREE.Color(ORANGE).multiplyScalar(0.9);
      this.worn.set(look, { ...L, legs: trousers, second: trousers.clone() });
    }
    this.people.wear(this.worn.get(look)!);
    const dx = w.x2 - w.x1;
    const dz = w.z2 - w.z1;
    const len = Math.hypot(dx, dz);
    if (len < 0.3) {
      this.poses.push({ x: w.x1, y: w.y, z: w.z1, yaw: w.yaw + 0.3 * Math.sin(time * 0.2 + i), walk: -1, look });
      return;
    }
    // (there, a pause, back, a pause: 0.8 m/s)
    const leg = len / 0.8;
    const cycle = 2 * leg + 8;
    const t = (time + i * 3.7) % cycle;
    let f: number;
    let walking = true;
    let back = false;
    if (t < leg) f = t / leg;
    else if (t < leg + 4) {
      f = 1;
      walking = false;
    } else if (t < 2 * leg + 4) {
      f = 1 - (t - leg - 4) / leg;
      back = true;
    } else {
      f = 0;
      walking = false;
    }
    const yaw = Math.atan2(back ? dx : -dx, back ? dz : -dz);
    this.poses.push({ x: w.x1 + dx * f, y: w.y, z: w.z1 + dz * f, yaw, walk: walking ? (time + i * 3.7) * 0.8 : -1, look });
  }

  /** A police officer's look: the dark blue uniform, or the yellow vest over it. */
  private police(n: number): number {
    const look = POLICE_LOOKS + (Math.abs(n) % 0xfffff);
    if (!this.worn.has(look)) {
      const L = workerLook(look, 'yellow');
      const navy = new THREE.Color(0x1f2b45);
      this.worn.set(look, { ...L, top: L.seed < 0.45 ? navy.clone() : L.top, legs: navy, second: navy.clone(), hairColour: L.seed < 0.5 ? new THREE.Color(0x1a2338) : L.hairColour });
    }
    this.people.wear(this.worn.get(look)!);
    return look;
  }

  /**
   * The crowd of a march: in rows across the street, walking slowly or
   * standing at its rally – some with placards, the front rows with
   * banners – and officers ahead and behind.  Returns the counts of sticks,
   * boards and banners used so far.
   */
  private crowd(ev: RoadEvents, d: Demonstration, ms: number, time: number, camX: number, camZ: number, sticks0: number, boards0: number, banners0: number): [number, number, number] {
    let sticks = sticks0;
    let boards = boards0;
    let banners = banners0;
    const route = d.route!;
    const shape = crowdShape(d);
    const { head, dir, walking } = marchAt(d, ms);
    const p = this.smp;
    // (near enough to be seen at all?)
    if (!routeAt(ev.world, route, head - (dir * shape.length) / 2, 0, p) || Math.hypot(p.x - camX, p.z - camZ) > CROWD_NEAR) return [sticks, boards, banners];
    // (which way they face: the way the march goes – turned round when it walks back)
    const back = dir < 0 ? Math.PI : 0;
    const n = Math.min(d.size, this.crowdCap, 300 - this.poses.length - 8);
    const cols = shape.cols;
    const r = (i: number, k: number): number => hash01(d.seed * 7 + i * 131 + k * 7919);
    const palette = [0xe63946, 0xf4a261, 0x2a9d8f, 0x457b9d, 0xffd166, 0x06d6a0, 0xef476f, 0x8338ec, 0x3a86ff, 0xfb5607, 0xffbe0b, 0x8ac926];
    const posFor = (row: number, col: number, i: number, out: { x: number; y: number; z: number; tx: number; tz: number }): boolean => {
      const u = head - dir * (row * shape.gap + 0.5 + (r(i, 1) - 0.5) * 0.5 + (walking ? 0.12 * Math.sin(time * 0.7 + i) : 0));
      const at = routeAt(ev.world, route, u, 0, p);
      if (!at) return false;
      const half = Math.max(1, at.edge.width / 2 - 0.45);
      const across = (((col + 0.5) / cols) * 2 - 1) * half * 0.94 + (r(i, 2) - 0.5) * 0.45;
      routeAt(ev.world, route, u, across, p);
      out.x = p.x;
      out.z = p.z;
      out.y = ev.world.edgeY(at.edge, at.s, p.x, p.z);
      out.tx = p.tx;
      out.tz = p.tz;
      return true;
    };
    const pt = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      if (!posFor(row, col, i, pt)) continue;
      const along = Math.atan2(-pt.tx, -pt.tz) + back;
      // standing at a rally: turned this way and that, towards the front
      const yaw = along + (walking ? (r(i, 3) - 0.5) * 0.25 : (r(i, 3) - 0.5) * 1.1 + 0.25 * Math.sin(time * 0.13 + i));
      const look = Math.floor(r(i, 4) * 99991);
      this.poses.push({ x: pt.x, y: pt.y, z: pt.z, yaw, walk: walking ? head * dir : -1, look });
      // a placard on a stick, held up in the right hand (a few rows from the front)
      if (r(i, 5) < 0.24 && sticks < 150 && boards < 80 && row > 0) {
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const hx = pt.x + Math.cos(yaw) * 0.26 + fx * 0.08;
        const hz = pt.z - Math.sin(yaw) * 0.26 + fz * 0.08;
        const sway = 0.12 * Math.sin(time * (walking ? 2.4 : 0.8) + i);
        this.q.setFromAxisAngle(this.up, yaw + sway);
        this.m4.compose(this.v.set(hx, pt.y + 0.95, hz), this.q, this.sc.set(1, 1, 1));
        this.sticks.setMatrixAt(sticks++, this.m4);
        this.m4.compose(this.v.set(hx, pt.y + 2.15, hz), this.q, this.sc.set(1, 1, 1));
        this.boards.setMatrixAt(boards, this.m4);
        this.boards.setColorAt(boards, this.col.setHex(palette[Math.floor(r(i, 6) * palette.length)]));
        // a round mark on its face (towards those who see the march come)
        const mx = hx + fx * 0.012;
        const mz = hz + fz * 0.012;
        this.m4.compose(this.v.set(mx, pt.y + 2.15 + (r(i, 7) - 0.5) * 0.12, mz), this.q, this.sc.setScalar(0.7 + r(i, 8) * 0.6));
        this.marks.setMatrixAt(boards, this.m4);
        this.marks.setColorAt(boards, this.col.setHex(r(i, 9) < 0.5 ? 0xffffff : palette[Math.floor(r(i, 10) * palette.length)]));
        boards++;
      }
    }
    // banners across the front rows: held between the outer two of a row
    for (const row of [0, 4, 9]) {
      if (banners >= 12 || row * cols + cols > n) continue;
      const a = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
      const b = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
      if (!posFor(row, 0, row * cols, a) || !posFor(row, cols - 1, row * cols + cols - 1, b)) continue;
      const w = Math.hypot(b.x - a.x, b.z - a.z);
      if (w < 1.5) continue;
      const yaw = Math.atan2(-a.tx, -a.tz) + back;
      this.q.setFromAxisAngle(this.up, yaw);
      const cx = (a.x + b.x) / 2 - Math.sin(yaw) * 0.35;
      const cz = (a.z + b.z) / 2 - Math.cos(yaw) * 0.35;
      const cy = (a.y + b.y) / 2;
      this.m4.compose(this.v.set(cx, cy + 1.5, cz), this.q, this.sc.set(w, 1, 1));
      this.banners.setMatrixAt(banners, this.m4);
      this.banners.setColorAt(banners, this.col.setHex(palette[Math.floor(r(row, 11) * palette.length)]));
      this.m4.compose(this.v.set(cx - Math.sin(yaw) * 0.01, cy + 1.5, cz - Math.cos(yaw) * 0.01), this.q, this.sc.set(w, 1, 1));
      this.bands.setMatrixAt(banners, this.m4);
      this.bands.setColorAt(banners, this.col.setHex(r(row, 12) < 0.5 ? 0xffffff : palette[Math.floor(r(row, 13) * palette.length)]));
      banners++;
      // its two poles
      for (const e of [a, b]) {
        if (sticks >= 160) break;
        this.m4.compose(this.v.set(e.x - Math.sin(yaw) * 0.35, e.y + 0.6, e.z - Math.cos(yaw) * 0.35), this.q, this.sc.set(1, 1.05, 1));
        this.sticks.setMatrixAt(sticks++, this.m4);
      }
    }
    // officers ahead of the march and behind it, at its sides
    const ends: Array<[number, number]> = [[head + dir * 5, 1], [head + dir * 5, -1], [head - dir * (shape.length + 4), 1], [head - dir * (shape.length + 4), -1]];
    ends.forEach(([u, side], k) => {
      const at = routeAt(ev.world, route, u, 0, p);
      if (!at) return;
      const off = side * Math.max(0.8, at.edge.width / 2 - 0.6);
      routeAt(ev.world, route, u, off, p);
      this.poses.push({ x: p.x, y: ev.world.edgeY(at.edge, at.s, p.x, p.z), z: p.z, yaw: Math.atan2(-p.tx, -p.tz) + back, walk: walking ? head * dir : -1, look: this.police(d.id * 17 + 100 + k) });
    });
    return [sticks, boards, banners];
  }

  // ---------------------------------------------------------------------------- building

  /** The signs of a site on mobile feet, drawn with the atlas of the map's signs. */
  private signs(posts: SignPost[], parts: Parts, ox: number, oy: number, oz: number, signs: SignRenderer | null, site: Site): void {
    if (posts.length === 0) return;
    for (const s of posts) {
      // (the foot: a slab of recycled rubber)
      parts.box(0.42, 0.07, 0.75, 0x1d1d1f, s.x - ox, s.y - oy + 0.035, s.z - oz, s.yaw);
    }
    if (!signs) return;
    // (the sign renderer places them in the world's frame)
    const { group, disposables } = signs.build(posts, ox, oy, oz);
    site.group.add(group);
    site.disposables.push(...disposables);
    site.signs = { by: signs, group };
  }

  /** A barrier (Zeichen 600) on two feet, its lamps on top. */
  private barrier(b: { x1: number; z1: number; x2: number; z2: number; y: number; yaw: number; lamps: number }, parts: Parts, ox: number, oy: number, oz: number): void {
    const len = Math.hypot(b.x2 - b.x1, b.z2 - b.z1);
    const mx = (b.x1 + b.x2) / 2 - ox;
    const mz = (b.z1 + b.z2) / 2 - oz;
    const y = b.y - oy;
    // (the boards are 1.6 m wide at most: several side by side over a whole street)
    const n = Math.max(1, Math.ceil(len / 1.7));
    const ux = (b.x2 - b.x1) / len;
    const uz = (b.z2 - b.z1) / len;
    for (let i = 0; i < n; i++) {
      const c = (i + 0.5) / n - 0.5;
      const x = mx + ux * len * c;
      const z = mz + uz * len * c;
      const w = len / n - 0.08;
      parts.stripes(w, 0.25, 0.04, x, y + 1.0, z, b.yaw);
      for (const e of [-1, 1]) {
        const fx = x + ux * e * (w / 2 - 0.12);
        const fz = z + uz * e * (w / 2 - 0.12);
        parts.box(0.04, 1.0, 0.04, 0xe8e8e4, fx, y + 0.5, fz, b.yaw);
        parts.box(0.36, 0.06, 0.62, 0x1d1d1f, fx, y + 0.03, fz, b.yaw);
      }
    }
    for (let k = 0; k < b.lamps; k++) {
      const c = (k + 0.5) / b.lamps - 0.5;
      const x = mx + ux * len * c * 0.9;
      const z = mz + uz * len * c * 0.9;
      parts.box(0.18, 0.2, 0.08, 0x2a2a2c, x, y + 1.22, z, b.yaw);
      parts.lamp(x - Math.sin(b.yaw) * 0.05, y + 1.24, z - Math.cos(b.yaw) * 0.05, b.yaw, false);
    }
  }

  private buildWorks(z: WorkZone, L: WorksLayout, signs: SignRenderer | null): Site {
    const ox = z.x;
    const oz = z.z;
    const oy = L.pit ? L.pit.y : L.barriers[0]?.y ?? 0;
    const site: Site = { group: new THREE.Group(), local: new THREE.Group(), disposables: [], signs: null, police: [], lights: [], x: z.x, z: z.z, version: 0 };
    site.group.name = `roadworks ${z.street}`;
    const parts = new Parts();
    this.signs(L.signs, parts, ox, oy, oz, signs, site);
    for (const b of L.barriers) this.barrier(b, parts, ox, oy, oz);
    // beacons (Zeichen 605): a striped board on a foot, a lamp on top
    for (const b of L.beacons) {
      const x = b.x - ox;
      const y = b.y - oy;
      const zz = b.z - oz;
      parts.stripes(0.25, 1.0, 0.035, x, y + 0.72, zz, b.yaw, b.pass < 0);
      parts.box(0.36, 0.09, 0.36, 0x1d1d1f, x, y + 0.045, zz, b.yaw);
      parts.box(0.03, 0.24, 0.03, 0x2a2a2c, x, y + 0.11, zz, b.yaw);
      if (b.lamp) parts.lamp(x - Math.sin(b.yaw) * 0.04, y + 1.32, zz - Math.cos(b.yaw) * 0.04, b.yaw, true);
    }
    // cones
    for (const c of L.cones) {
      const x = c.x - ox;
      const y = c.y - oy;
      const zz = c.z - oz;
      parts.box(0.38, 0.03, 0.38, 0x1d1d1f, x, y + 0.015, zz);
      parts.add(new THREE.CylinderGeometry(0.1, 0.16, 0.2, 10, 1, true), ORANGE, x, y + 0.13, zz);
      parts.add(new THREE.CylinderGeometry(0.083, 0.1, 0.07, 10, 1, true), 0xf4f4f0, x, y + 0.265, zz);
      parts.add(new THREE.CylinderGeometry(0.06, 0.083, 0.1, 10, 1, true), ORANGE, x, y + 0.35, zz);
      parts.add(new THREE.CylinderGeometry(0.045, 0.06, 0.06, 10, 1, true), 0xf4f4f0, x, y + 0.43, zz);
      parts.add(new THREE.ConeGeometry(0.045, 0.1, 10), ORANGE, x, y + 0.51, zz);
    }
    // the pit, the fence round it
    if (L.pit) {
      const p = L.pit;
      parts.box(p.wid, 0.03, p.len, 0x3b2f24, p.x - ox, p.y - oy + 0.015, p.z - oz, p.yaw);
      parts.box(p.wid * 0.7, 0.032, p.len * 0.8, 0x17120e, p.x - ox, p.y - oy + 0.017, p.z - oz, p.yaw);
    }
    const f = L.fence;
    for (let i = 0; i < f.length / 2; i++) {
      const j = (i + 1) % (f.length / 2);
      const x1 = f[i * 2] - ox;
      const z1 = f[i * 2 + 1] - oz;
      const x2 = f[j * 2] - ox;
      const z2 = f[j * 2 + 1] - oz;
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 0.2) continue;
      const yaw = Math.atan2(x2 - x1, z2 - z1) + Math.PI / 2;
      const n = Math.max(1, Math.ceil(len / 2.1));
      for (let k = 0; k < n; k++) {
        const c = (k + 0.5) / n;
        const x = x1 + (x2 - x1) * c;
        const z = z1 + (z2 - z1) * c;
        const w = len / n - 0.06;
        const y = L.fenceY - oy;
        // (an Absperrgitter: two striped rails on a frame, feet at the ends)
        parts.stripes(w, 0.1, 0.03, x, y + 0.95, z, yaw);
        parts.stripes(w, 0.1, 0.03, x, y + 0.45, z, yaw);
        for (const e of [-1, 1]) {
          const fx = x + ((x2 - x1) / len) * e * (w / 2);
          const fz = z + ((z2 - z1) / len) * e * (w / 2);
          parts.box(0.035, 1.0, 0.035, 0xd8d8d4, fx, y + 0.5, fz);
          parts.box(0.12, 0.05, 0.5, 0x2a2a2c, fx, y + 0.025, fz, yaw);
        }
      }
    }
    // the machines
    for (const m of L.machines) {
      const x = m.x - ox;
      const y = m.y - oy;
      const zz = m.z - oz;
      if (m.kind === 'excavator') this.excavator(parts, x, y, zz, m.yaw);
      else if (m.kind === 'heap') {
        parts.add(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.25, 0.7, 1.05), 0x8a8172, x, y, zz, m.yaw);
        parts.add(new THREE.SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.6, 0.35, 0.5), 0x9b917f, x + 0.6 * Math.cos(m.yaw), y + 0.35, zz - 0.6 * Math.sin(m.yaw), m.yaw);
      } else this.trailer(parts, x, y, zz, m.yaw);
    }
    // the temporary lights
    for (const l of L.lights) {
      const x = l.x - ox;
      const y = l.y - oy;
      const zz = l.z - oz;
      parts.box(0.7, 0.12, 0.7, 0x1d1d1f, x, y + 0.06, zz, l.yaw);
      parts.box(0.08, 2.2, 0.08, 0x8a8f94, x, y + 1.1, zz, l.yaw);
      parts.box(0.38, 1.0, 0.24, YELLOW, x, y + 2.55, zz, l.yaw);
      parts.box(0.46, 1.08, 0.02, DARK, x + Math.sin(l.yaw) * 0.12, y + 2.55, zz + Math.cos(l.yaw) * 0.12, l.yaw);
      const lamps: THREE.Mesh[] = [];
      for (const [k, mat] of [[0, this.off.red], [1, this.off.amber], [2, this.off.green]] as const) {
        // (the faces of the lamps towards the traffic: −z of the light's frame)
        const lamp = new THREE.Mesh(this.lampGeo, mat);
        const fy = y + 2.85 - k * 0.3;
        lamp.position.set(x - Math.sin(l.yaw) * 0.125, fy, zz - Math.cos(l.yaw) * 0.125);
        lamp.rotation.set(0, l.yaw + Math.PI, 0);
        site.local.add(lamp);
        lamps.push(lamp);
        parts.box(0.22, 0.04, 0.12, DARK, x - Math.sin(l.yaw) * 0.17, fy + 0.11, zz - Math.cos(l.yaw) * 0.17, l.yaw);
      }
      site.lights.push({ zone: z, group: l.group, red: lamps[0], amber: lamps[1], green: lamps[2] });
    }
    this.finishSite(site, parts, ox, oy, oz);
    return site;
  }

  /** The merged meshes into the site's group at its middle, the site into the scene. */
  private finishSite(site: Site, parts: Parts, ox: number, oy: number, oz: number): void {
    for (const m of parts.build(this.plainMat, this.stripeMat, this.lampMat, this.blinkMat)) {
      site.local.add(m);
      site.disposables.push(m.geometry);
    }
    site.local.position.set(ox, oy, oz);
    site.group.add(site.local);
    this.group.add(site.group);
  }

  /** A mini excavator facing −z of its frame (towards the pit): tracks, the turning upper part with its cab, the boom and the bucket down in the pit. */
  private excavator(parts: Parts, x: number, y: number, z: number, yaw: number): void {
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    // (a point of the excavator's frame: right a, up b, back d)
    const at = (a: number, d: number): [number, number] => [x + c * a + s * d, z - s * a + c * d];
    for (const side of [-1, 1]) {
      const [tx, tz] = at(side * 0.62, 0);
      parts.box(0.32, 0.38, 2.0, 0x1f2022, tx, y + 0.19, tz, yaw);
    }
    let [px, pz] = at(0, 0);
    parts.box(0.9, 0.22, 1.5, 0x3a3c40, px, y + 0.3, pz, yaw);
    // the upper part: the body, the counterweight behind, the cab on the left
    parts.box(1.42, 0.62, 1.5, YELLOW, px, y + 0.72, pz, yaw);
    [px, pz] = at(0, 0.82);
    parts.box(1.42, 0.5, 0.36, 0xd9a910, px, y + 0.68, pz, yaw);
    [px, pz] = at(-0.22, -0.05);
    parts.box(0.86, 1.02, 0.95, 0x2b3a44, px, y + 1.54, pz, yaw);
    parts.box(0.92, 0.07, 1.0, YELLOW, px, y + 2.08, pz, yaw);
    for (const [a, d] of [[-0.64, -0.5], [0.2, -0.5], [-0.64, 0.42], [0.2, 0.42]] as const) {
      [px, pz] = at(a, d);
      parts.box(0.05, 1.05, 0.05, YELLOW, px, y + 1.55, pz, yaw);
    }
    // the boom up and forward, the arm down into the pit, the bucket
    [px, pz] = at(0.3, -1.25);
    parts.box(0.2, 0.22, 1.7, YELLOW, px, y + 1.45, pz, yaw, 0.62);
    [px, pz] = at(0.3, -2.2);
    parts.box(0.16, 0.16, 1.4, 0xd9a910, px, y + 1.25, pz, yaw, -1.05);
    [px, pz] = at(0.3, -2.55);
    parts.box(0.5, 0.36, 0.34, 0x2a2a2c, px, y + 0.42, pz, yaw, 0.4);
    // the dozer blade at the front
    [px, pz] = at(0, -1.12);
    parts.box(1.5, 0.3, 0.08, YELLOW, px, y + 0.2, pz, yaw);
  }

  /** A site trailer on two wheels: a box with a door and a window, its drawbar towards −z. */
  private trailer(parts: Parts, x: number, y: number, z: number, yaw: number): void {
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    const at = (a: number, d: number): [number, number] => [x + c * a + s * d, z - s * a + c * d];
    parts.box(1.9, 1.95, 3.4, 0xd5d8d2, x, y + 1.55, z, yaw);
    parts.box(1.96, 0.08, 3.46, 0x8e9396, x, y + 2.56, z, yaw);
    let [px, pz] = at(0.96, 0.6);
    parts.box(0.04, 1.55, 0.75, 0x6d7478, px, y + 1.35, pz, yaw);
    [px, pz] = at(0.96, -0.9);
    parts.box(0.04, 0.55, 0.8, 0x33414a, px, y + 1.8, pz, yaw);
    for (const side of [-1, 1]) {
      [px, pz] = at(side * 0.98, 0.3);
      parts.add(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12).rotateZ(Math.PI / 2), 0x1d1d1f, px, y + 0.3, pz, yaw);
    }
    [px, pz] = at(0, -2.3);
    parts.box(0.08, 0.08, 1.4, 0x55595c, px, y + 0.45, pz, yaw);
    [px, pz] = at(0, -2.95);
    parts.box(0.06, 0.45, 0.06, 0x55595c, px, y + 0.24, pz, yaw);
  }

  private buildClosure(L: ClosureLayout, signs: SignRenderer | null, version: number): Site {
    const first = L.barriers[0];
    const ox = first ? (first.x1 + first.x2) / 2 : 0;
    const oz = first ? (first.z1 + first.z2) / 2 : 0;
    const oy = first ? first.y : 0;
    const site: Site = { group: new THREE.Group(), local: new THREE.Group(), disposables: [], signs: null, police: [], lights: [], x: ox, z: oz, version };
    site.group.name = 'closure of a march';
    const parts = new Parts();
    this.signs(L.signs, parts, ox, oy, oz, signs, site);
    for (const b of L.barriers) this.barrier(b, parts, ox, oy, oz);
    // the tape: a band at hip height, sagging a little in the middle
    for (const t of L.tape) {
      const len = Math.hypot(t.x2 - t.x1, t.z2 - t.z1);
      if (len < 0.3) continue;
      const yaw = Math.atan2(t.x2 - t.x1, t.z2 - t.z1) + Math.PI / 2;
      const n = Math.max(1, Math.ceil(len / 3));
      for (let k = 0; k < n; k++) {
        const c = (k + 0.5) / n;
        const sag = 0.12 * Math.sin(Math.PI * c);
        parts.stripes(len / n, 0.07, 0.004, t.x1 + (t.x2 - t.x1) * c - ox, t.y - oy + 1.05 - sag, t.z1 + (t.z2 - t.z1) * c - oz, yaw);
      }
    }
    // a patrol car behind the barriers at the ends of the march: blue lights on, its "STOP POLIZEI" sign raised
    for (const c of L.cars) {
      const m = this.policePool.pop() ?? buildPoliceCar();
      m.group.position.set(c.x, c.y, c.z);
      m.group.rotation.set(0, c.yaw, 0);
      m.setSign(true);
      m.setMotion(0, false, false, false);
      site.group.add(m.group);
      site.police.push(m);
    }
    this.finishSite(site, parts, ox, oy, oz);
    return site;
  }
}
