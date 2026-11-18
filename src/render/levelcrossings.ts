// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The level crossings near the camera (src/sim/levelcrossing.ts): on each
 * side the mast with the St Andrew's cross (Zeichen 201) and the lights
 * beneath it – yellow above red, or the single red flashing light of an
 * older crossing –, the barrier with its drive (half barriers over the
 * lanes that come to the tracks, full ones over the whole road), lowered
 * and raised as the installation says, and outside built-up areas the
 * beacons before it (Zeichen 156, 159, 162).  The bell rings while the
 * lights come on and the barriers go down.
 *
 * The signs are drawn with the atlas of the map's signs (render/signs.ts),
 * which leaves out those of the map's own that these replace
 * (LevelCrossings.editPost).  Everything else is a handful of boxes and
 * discs per installation, built when it comes within reach.
 */
import * as THREE from 'three';
import { newPolySample, samplePolyline } from '../core/geom.ts';
import { CrossingBell } from '../audio/crossingbell.ts';
import type { AudioOut } from '../audio/crowd.ts';
import { entryOf, passive, redOn, ringing } from '../sim/levelcrossing.ts';
import type { LevelCrossing, LevelCrossings } from '../sim/levelcrossing.ts';
import type { SignRenderer } from './signs.ts';

/** installations are drawn within this distance of the camera (m) */
const REACH = 700;

/** One side of an installation: its lamps and the arm of its barrier. */
interface Side {
  yellow: THREE.Mesh | null;
  red: THREE.Mesh[];
  /** turns the boom up (about the road's direction) */
  arm: THREE.Object3D | null;
  boomLamps: THREE.Mesh[];
}

interface Site {
  c: LevelCrossing;
  group: THREE.Group;
  sides: Side[];
  disposables: Array<{ dispose(): void }>;
  signs: { by: SignRenderer; group: THREE.Object3D } | null;
}

/** red and white stripes, half a metre each: the boom of a barrier */
function stripeTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 8;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2f2ee';
  g.fillRect(0, 0, 64, 8);
  g.fillStyle = '#c4161c';
  g.fillRect(0, 0, 32, 8);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class LevelCrossingRenderer {
  readonly group = new THREE.Group();
  private readonly sites = new Map<number, Site>();
  private readonly bell: CrossingBell | null;
  private readonly smp = newPolySample();
  private readonly mastMat = new THREE.MeshLambertMaterial({ color: 0x9aa0a4 });
  private readonly housingMat = new THREE.MeshLambertMaterial({ color: 0x17181a });
  private readonly plateMat = new THREE.MeshLambertMaterial({ color: 0xf1f1ec });
  private readonly driveMat = new THREE.MeshLambertMaterial({ color: 0xd9b21c });
  private readonly boomMat = new THREE.MeshLambertMaterial({ map: stripeTexture() });
  private readonly off = { red: new THREE.MeshLambertMaterial({ color: 0x3b0c0c }), yellow: new THREE.MeshLambertMaterial({ color: 0x3d300a }) };
  private readonly on = { red: new THREE.MeshBasicMaterial({ color: 0xff2414 }), yellow: new THREE.MeshBasicMaterial({ color: 0xffbb1c }) };
  private readonly lampGeo = new THREE.CircleGeometry(0.105, 16);
  private readonly smallLampGeo = new THREE.SphereGeometry(0.05, 8, 6);
  private readonly mastGeo = new THREE.CylinderGeometry(0.055, 0.055, 1, 8).translate(0, 0.5, 0);

  /** `audio`: the game's sound, for the bell (none: silent). */
  constructor(audio: AudioOut | null = null) {
    this.bell = audio ? new CrossingBell(audio) : null;
    this.group.name = 'level crossings';
  }

  /** Each frame: build what came within reach, drop what went, set the lamps and barriers. */
  update(lx: LevelCrossings, signs: SignRenderer | null, camX: number, camZ: number, time: number): void {
    const near = new Set<number>();
    let bellDist = Infinity;
    for (const c of lx.list) {
      const d = Math.hypot(c.x - camX, c.z - camZ);
      if (d > REACH) continue;
      if (passive(c) && !c.beacons) continue;
      near.add(c.id);
      let site = this.sites.get(c.id);
      if (!site || site.c !== c) {
        if (site) this.drop(site);
        site = this.build(lx, c, signs);
        this.sites.set(c.id, site);
      }
      this.pose(site, time);
      if (ringing(c)) bellDist = Math.min(bellDist, d);
    }
    for (const [id, site] of this.sites) if (!near.has(id)) this.drop(site);
    this.bell?.update(bellDist);
  }

  private drop(site: Site): void {
    this.group.remove(site.group);
    for (const d of site.disposables) d.dispose();
    if (site.signs) site.signs.by.release(site.signs.group);
    this.sites.delete(site.c.id);
  }

  /** The lamps (steady, or flashing about once a second) and the barriers of a site as its installation says. */
  private pose(site: Site, time: number): void {
    const c = site.c;
    const red = redOn(c) && (c.eq.light !== 'blink' || time % 1 < 0.55);
    const yellow = c.phase === 'yellow';
    // (the lamps on the booms burn while they are not up)
    const boomLit = c.lower > 0.02 && time % 1 < 0.6;
    for (const s of site.sides) {
      if (s.yellow) s.yellow.material = yellow ? this.on.yellow : this.off.yellow;
      for (const m of s.red) m.material = red ? this.on.red : this.off.red;
      if (s.arm) s.arm.rotation.z = (1 - c.lower) * 1.48;
      for (const m of s.boomLamps) m.material = boomLit ? this.on.red : this.off.red;
    }
  }

  private build(lx: LevelCrossings, c: LevelCrossing, signs: SignRenderer | null): Site {
    const e = c.edge;
    const world = lx.world;
    const group = new THREE.Group();
    const y0 = world.edgeY(e, (c.s0 + c.s1) / 2, c.x, c.z);
    group.position.set(c.x, y0, c.z);
    this.group.add(group);
    const site: Site = { c, group, sides: [], disposables: [], signs: null };
    const groundY = (s: number, x: number, z: number): number => world.edgeY(e, s, x, z);
    if (!passive(c)) {
      for (const dir of [1, -1]) {
        if ((dir > 0 ? e.lanesF : e.lanesB) === 0) continue;
        site.sides.push(this.side(lx, c, dir, group, y0, site));
      }
    }
    // the cross on the masts, the beacons
    const posts = lx.signsFor(c, groundY);
    if (signs && posts.length > 0) {
      const built = signs.build(posts, c.x, y0, c.z);
      group.add(built.group);
      // (the sign renderer places them in the world's frame)
      built.group.position.set(-c.x, -y0, -c.z);
      site.disposables.push(...built.disposables);
      site.signs = { by: signs, group: built.group };
    }
    return site;
  }

  /** The mast with its lights, and the barrier, on the right of traffic going `dir`. */
  private side(lx: LevelCrossings, c: LevelCrossing, dir: number, group: THREE.Group, y0: number, site: Site): Side {
    const e = c.edge;
    const entry = entryOf(c, dir);
    const post = lx.postAt(e, entry, dir, [], (s, x, z) => lx.world.edgeY(e, s, x, z));
    const ox = post.x - c.x;
    const oz = post.z - c.z;
    const oy = post.y - y0;
    const fx = -Math.sin(post.yaw);
    const fz = -Math.cos(post.yaw);
    const side: Side = { yellow: null, red: [], arm: null, boomLamps: [] };
    // the mast, up to the cross
    const mast = new THREE.Mesh(this.mastGeo, this.mastMat);
    mast.position.set(ox, oy - 0.2, oz);
    mast.scale.set(1, 2.65, 1);
    group.add(mast);
    // the lights: a housing facing the traffic, its lamps on the front
    const head = new THREE.Group();
    head.position.set(ox + fx * 0.09, oy, oz + fz * 0.09);
    head.rotation.y = post.yaw;
    group.add(head);
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      head.add(m);
      site.disposables.push(geo);
      return m;
    };
    // (in the head's frame the traffic is at −z: a plane faces +z, so the lamps are turned round)
    if (c.eq.light === 'yellowRed') {
      add(new THREE.BoxGeometry(0.36, 0.78, 0.16), this.housingMat, 0, 1.95, 0);
      const yl = new THREE.Mesh(this.lampGeo, this.off.yellow);
      yl.position.set(0, 2.15, -0.082);
      yl.rotation.y = Math.PI;
      head.add(yl);
      const rd = new THREE.Mesh(this.lampGeo, this.off.red);
      rd.position.set(0, 1.78, -0.082);
      rd.rotation.y = Math.PI;
      head.add(rd);
      side.yellow = yl;
      side.red.push(rd);
    } else if (c.eq.light === 'blink') {
      // (the round white plate with the red lamp of the older Blinklicht)
      const plate = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 20).rotateX(Math.PI / 2);
      add(plate, this.plateMat, 0, 1.95, 0);
      const rd = new THREE.Mesh(this.lampGeo, this.off.red);
      rd.position.set(0, 1.95, -0.03);
      rd.rotation.y = Math.PI;
      head.add(rd);
      side.red.push(rd);
    }
    // the barrier: its drive just past the cross, the boom across the lanes it closes
    if (c.eq.barrier !== 'none') {
      samplePolyline(e.pl, entry, this.smp);
      const tx = this.smp.tx * dir;
      const tz = this.smp.tz * dir;
      // (towards the middle of the road: to the left of the direction of travel)
      const bx = tz;
      const bz = -tx;
      const outward = Math.hypot(ox + c.x - this.smp.x, oz + c.z - this.smp.z);
      const len = c.eq.barrier === 'full' ? Math.max(2, outward * 2 - 0.8) : Math.max(1.5, outward - 0.15);
      const px = ox + tx * 0.9;
      const pz = oz + tz * 0.9;
      const driveGeo = new THREE.BoxGeometry(0.34, 1.05, 0.34).translate(0, 0.52, 0);
      const drive = new THREE.Mesh(driveGeo, this.driveMat);
      drive.position.set(px - bx * 0.25, oy, pz - bz * 0.25);
      drive.rotation.y = Math.atan2(-bz, bx);
      group.add(drive);
      site.disposables.push(driveGeo);
      const pivot = new THREE.Object3D();
      pivot.position.set(px, oy + 0.95, pz);
      pivot.rotation.y = Math.atan2(-bz, bx);
      group.add(pivot);
      const arm = new THREE.Object3D();
      pivot.add(arm);
      const boomGeo = new THREE.BoxGeometry(len, 0.09, 0.07).translate(len / 2, 0, 0);
      // (the stripes: a metre of red and white, along the boom)
      const uv = boomGeo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * len);
      const boom = new THREE.Mesh(boomGeo, this.boomMat);
      arm.add(boom);
      site.disposables.push(boomGeo);
      for (const f of [0.35, 0.65, 0.95]) {
        const lamp = new THREE.Mesh(this.smallLampGeo, this.off.red);
        lamp.position.set(len * f, 0.07, 0);
        arm.add(lamp);
        side.boomLamps.push(lamp);
      }
      side.arm = arm;
    }
    return side;
  }
}
