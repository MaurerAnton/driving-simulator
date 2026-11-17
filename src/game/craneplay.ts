// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Working a crane on the construction site – what the game (game.ts) runs
 * for the tower crane, the mobile crane and the loader crane:
 *
 *  - the site is laid out on the practice yard once its ground is loaded
 *    (render/cranesite.ts draws it, game/cranetasks.ts says what is where),
 *    its buildings and loads stand in the vehicles' way, its roads are paved;
 *  - the mobile and the loader crane are driven like any truck from the
 *    depot to their stand; parked there with the parking brake on, the
 *    door key (or the button) changes to working the crane – and back,
 *    once it is folded and its outriggers are in again;
 *  - while the crane is worked its vehicle stands still: the controls move
 *    the crane's drives (sim/crane.ts), the hook swings on its rope, loads
 *    are slung and let go, the limiter watches, the tasks are judged and
 *    what goes wrong is told to the instructor (sim/rules.ts);
 *  - the crane's own cameras: from the operator's seat (looking where the
 *    load is), and round the hook;
 *  - the street-name block says what to do, the crane's display
 *    (ui/cranepanel.ts) what the limiter measures.
 */
import * as THREE from 'three';
import type { GameAudio } from '../audio/audio.ts';
import type { Controls, Input } from '../input/input.ts';
import type { CraneModel } from '../render/crane.ts';
import { CraneSiteScene } from '../render/cranesite.ts';
import type { SceneryCollider } from '../sim/collision.ts';
import type { WorldGround } from '../sim/ground.ts';
import { Crane, G, LOADER_BED, boomDir } from '../sim/crane.ts';
import type { Box3, CraneEvents, CraneType, CraneWorld, Weight } from '../sim/crane.ts';
import type { Vehicle } from '../sim/vehicle/index.ts';
import { CranePanel } from '../ui/cranepanel.ts';
import type { HudState } from '../ui/hud.ts';
import { localeOf, tr } from '../i18n/index.ts';
import { AREAS, BUILDING, CraneTasks, DEPOT_START, TOWER_SITE, bearersOf, loadFootprint, siteWorld } from './cranetasks.ts';
import type { CraneFault, CraneSnapshot, SiteWorld, TaskResult, WorldLoad } from './cranetasks.ts';
import type { YardFrame } from './ce.ts';
import type { Settings } from './settings.ts';
import { weatherNow, windVector } from './weather.ts';

/** the crane's physics step (as the vehicles') */
const STEP = 1 / 240;

/** What the crane work needs of the game. */
export interface CraneHost {
  readonly scene: THREE.Scene;
  readonly ui: HTMLElement;
  readonly settings: Settings;
  /** the practice yard the site is laid on (null: the map has none) */
  readonly yard: YardFrame | null;
  /** the map's ground (NaN where it is not loaded) */
  heightAt(x: number, z: number): number;
  readonly collider: SceneryCollider;
  readonly ground: WorldGround;
  readonly input: Input;
  readonly audio: GameAudio;
  /** tell the instructor of a fault (at a place) */
  note(f: CraneFault, x: number, z: number): void;
}

/** the site's drawing: one for the whole game, made the first time */
let siteScene: CraneSiteScene | null = null;
/** the crane's display and controls: one for the whole game */
let panel: CranePanel | null = null;

function sceneOf(host: Pick<CraneHost, 'scene'>): CraneSiteScene {
  if (!siteScene) {
    siteScene = new CraneSiteScene();
    host.scene.add(siteScene.group);
  }
  return siteScene;
}

function panelOf(host: Pick<CraneHost, 'ui' | 'settings'>): CranePanel {
  panel ??= new CranePanel(host.ui, () => host.settings.lang);
  return panel;
}

/**
 * Where a crane's work begins: the mobile and the loader crane at the
 * depot on the site road, the tower crane at its base – in the world, from
 * the practice yard's frame (null: the map has no practice yard).
 */
export function craneStart(type: CraneType, yard: YardFrame | null): { x: number; z: number; yaw: number } | null {
  if (!yard) return null;
  const p = type === 'tower' ? { u: TOWER_SITE.u, w: TOWER_SITE.w, yaw: TOWER_SITE.yaw } : DEPOT_START;
  const [x, z] = yard.toWorld(p.u, p.w);
  return { x, z, yaw: yard.yawToWorld(p.yaw) };
}

/**
 * The site behind the menu (the crane chosen stands on it): laid out – or
 * taken away again (type null).  `heightAt`: the map's ground.
 */
export function craneMenuSite(host: Pick<CraneHost, 'scene' | 'yard' | 'settings'>, type: CraneType | null, heightAt: (x: number, z: number) => number): void {
  if (!type || !host.yard) {
    siteScene?.hide();
    return;
  }
  const s = sceneOf(host);
  const [bx, bz] = host.yard.toWorld((BUILDING.u0 + BUILDING.u1) / 2, (BUILDING.w0 + BUILDING.w1) / 2);
  const y0 = heightAt(bx, bz);
  s.show(host.yard, heightAt, Number.isNaN(y0) ? 0 : y0, type !== 'tower', host.settings.quality === 'low' ? 'low' : 'full');
}

/** Is a vehicle's model a crane's (render/crane.ts)? */
export function isCraneModel(m: object): m is CraneModel {
  return 'operatorEye' in m && 'pose' in m;
}

/** A crane standing as it travels, for the picture behind the menu: folded, its hook hanging (where its model stands). */
export function craneMenuPose(model: CraneModel, type: CraneType): void {
  const r = model.root;
  r.updateMatrixWorld(true);
  const c = new Crane(type);
  c.place(r.position.x, r.position.y, r.position.z, new THREE.Euler().setFromQuaternion(r.quaternion, 'YXZ').y);
  if (type === 'tower') {
    // (the tower crane: its jib turned a little, the hook halfway down)
    c.q.slew = 0.5;
    c.q.trolley = 22;
    c.q.rope = 16;
    c.place(r.position.x, r.position.y, r.position.z, new THREE.Euler().setFromQuaternion(r.quaternion, 'YXZ').y);
  }
  model.pose(c, 0);
}

/** The vehicle's slope from its turn (rise per metre along its x and z). */
function slopeOf(q: ArrayLike<number>): { gx: number; gz: number } {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  return { gx: 2 * (x * y + z * w), gz: 2 * (y * z - x * w) };
}

/** The work with a crane on the site, from the start of the drive to its end. */
export class CraneWork {
  readonly type: CraneType;
  readonly crane: Crane;
  private readonly host: CraneHost;
  readonly panel: CranePanel;
  private readonly site: CraneSiteScene;
  /** the tasks (null until the site is laid out, or on a map without one) */
  tasks: CraneTasks | null = null;
  /** the crane is being worked (its vehicle stands still) – the tower crane always */
  operating: boolean;
  /** all is done, or it tipped: the drive is over (the game shows the result) */
  over = false;
  private overAt = -1;
  private laid = false;
  private laidTry = -10;
  private y0 = 0;
  private geo: SiteWorld | null = null;
  private boxes: Box3[] = [];
  private readonly own: Box3[] = [];
  private acc = 0;
  private time = 0;
  /** what happened in the crane's steps since the last frame */
  private readonly ev: CraneEvents = { hit: 0, landed: 0, liftedOff: false, cut: false };
  /** a tip for the player, and until when */
  private tip = '';
  private tipUntil = 0;
  /** the vehicle as it stands (world), for the tasks and the drawing */
  private readonly veh = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, handbrake: true };
  private readonly vq = new THREE.Quaternion();
  private readonly world: CraneWorld;
  private readonly wind = { x: 0, z: 0, gust: 1 };
  /** where the camera looks from the operator's seat (smoothed) */
  private readonly look = new THREE.Vector3();
  private lookReady = false;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private beepT = 0;

  constructor(type: CraneType, host: CraneHost) {
    this.type = type;
    this.host = host;
    this.crane = new Crane(type);
    this.panel = panelOf(host);
    this.site = sceneOf(host);
    this.operating = type === 'tower';
    this.panel.onAttach = () => this.attach();
    this.panel.onToggle = () => this.toggleRequested?.();
    this.panel.onClick = () => host.audio.click('tick');
    this.panel.show(type);
    // (shown once the drive runs: render says so each picture)
    this.panel.root.hidden = true;
    this.world = {
      floor: (x, z, hx, hz, y) => this.floor(x, z, hx, hz, y),
      boxes: () => this.boxes,
      ground: (x, z) => {
        const h = host.heightAt(x, z);
        return Number.isNaN(h) ? this.crane.base.y : h;
      },
      wind: () => {
        // the weather the game shows now (game/weather.ts): the mean wind, where it blows to, its gusts
        const w = weatherNow();
        windVector(w, this.wind);
        this.wind.gust = w.wind > 0.5 ? Math.max(1, w.gust / w.wind) : 1.3;
        return this.wind;
      },
    };
    this.setOperating(this.operating);
  }

  /** asked to change between driving and working the crane (the game decides: see `toggle`) */
  toggleRequested: (() => void) | null = null;

  // ---------------------------------------------------------------------------- the site

  /** Lay the site out once its ground is loaded (called each frame until it is). */
  private layout(): void {
    if (this.laid) return;
    const yard = this.host.yard;
    if (!yard || this.time - this.laidTry < 0.7) return;
    this.laidTry = this.time;
    const h = (x: number, z: number): number => this.host.heightAt(x, z);
    const [bx, bz] = yard.toWorld((BUILDING.u0 + BUILDING.u1) / 2, (BUILDING.w0 + BUILDING.w1) / 2);
    const y0 = h(bx, bz);
    if (Number.isNaN(y0)) return;
    this.y0 = y0;
    const detail = this.host.settings.quality === 'low' ? 'low' : 'full';
    if (!this.site.show(yard, h, y0, this.type !== 'tower', detail)) return;
    this.laid = true;
    this.tasks = new CraneTasks(this.type, yard, (x, z) => this.world.ground(x, z), y0);
    this.geo = siteWorld(yard, y0);
    // the timber bearers waiting at a place for their load: something to set it down on
    const bearers: Array<Box3 & { y: number }> = [];
    for (const t of this.tasks.plan.tasks) {
      const zone = this.tasks.zones.find((z) => z.id === t.zone);
      const load = this.tasks.loads.find((l) => l.id === t.load);
      if (zone?.bearers && load) bearers.push(...bearersOf(zone, load.def, this.world.ground(zone.x, zone.z)));
    }
    this.geo.platforms.push(...bearers);
    this.site.addBearers(bearers);
    // the site's paved areas, for the wheels
    const areas = [AREAS.depot, AREAS.road, AREAS.storage, AREAS.west, AREAS.site];
    this.host.ground.paved = (x, z) => {
      const [u, w] = yard.toLocal(x, z);
      for (const a of areas) if (u >= a.u0 && u <= a.u1 && w >= a.w0 && w <= a.w1) return true;
      return false;
    };
    this.colliders();
    this.refreshBoxes();
  }

  /** What the vehicles run into on the site: its buildings, the tower crane's base, the truck, the offices, the loads lying about. */
  private colliders(): void {
    const yard = this.host.yard;
    const geo = this.geo;
    if (!yard || !geo) return;
    const rings: number[] = [];
    const counts: number[] = [];
    const rect = (x0: number, z0: number, x1: number, z1: number): void => {
      rings.push(x0, z0, x1, z0, x1, z1, x0, z1);
      counts.push(4);
    };
    // (the solids that reach down to the ground; not the guard rails up on the roof)
    for (const b of geo.solids) if (b.y0 <= this.y0 + 0.5) rect(b.x0, b.z0, b.x1, b.z1);
    for (const l of this.tasks?.loads ?? []) {
      if (l.hooked || l.bed) continue;
      const [fx, fz] = loadFootprint(l.def, l.yaw);
      rect(l.x - fx, l.z - fz, l.x + fx, l.z + fz);
    }
    this.host.collider.remove('cranesite');
    this.host.collider.add({ key: 'cranesite', rings: Float32Array.from(rings), ringCounts: Uint16Array.from(counts), segments: null, discs: [] });
  }

  /** The solids the hook and the load stop at: the site's, the loads that lie about, the crane's own carrier. */
  private refreshBoxes(): void {
    const out: Box3[] = this.geo ? [...this.geo.solids] : [];
    for (const l of this.tasks?.loads ?? []) {
      if (l.hooked) continue;
      const [fx, fz] = loadFootprint(l.def, l.yaw);
      out.push({ x0: l.x - fx, x1: l.x + fx, z0: l.z - fz, z1: l.z + fz, y0: l.y, y1: l.y + 2 * l.def.hy });
    }
    out.push(...this.own);
    this.boxes = out;
  }

  /** The highest thing under a footprint: the ground, the site's slabs and platforms, the loads lying about, the loader's own flatbed. */
  private floor(x: number, z: number, hx: number, hz: number, y: number): number {
    const h = this.host;
    let best = -Infinity;
    for (const [dx, dz] of [
      [0, 0],
      [-hx, -hz],
      [hx, -hz],
      [-hx, hz],
      [hx, hz],
    ]) {
      const g = h.heightAt(x + dx, z + dz);
      if (!Number.isNaN(g)) best = Math.max(best, g);
    }
    if (best === -Infinity) best = this.crane.base.y;
    const top = y + 0.05;
    const x0 = x - hx;
    const x1 = x + hx;
    const z0 = z - hz;
    const z1 = z + hz;
    for (const p of this.geo?.platforms ?? []) {
      if (p.y > top || p.y <= best || x1 <= p.x0 || x0 >= p.x1 || z1 <= p.z0 || z0 >= p.z1) continue;
      best = p.y;
    }
    for (const l of this.tasks?.loads ?? []) {
      if (l.hooked) continue;
      const t = l.y + 2 * l.def.hy;
      if (t > top || t <= best) continue;
      const [fx, fz] = loadFootprint(l.def, l.yaw);
      if (x1 <= l.x - fx || x0 >= l.x + fx || z1 <= l.z - fz || z0 >= l.z + fz) continue;
      best = t;
    }
    // the loader crane's own flatbed (with its boards)
    if (this.type === 'loader') {
      const bed = this.bedBox();
      if (bed && bed.y <= top && bed.y > best && !(x1 <= bed.x0 || x0 >= bed.x1 || z1 <= bed.z0 || z0 >= bed.z1)) best = bed.y;
    }
    return best;
  }

  /** the loader's flatbed in the world (its floor's height), from where the crane stands */
  private bedBox(): (Box3 & { y: number }) | null {
    const c = this.crane;
    const B = LOADER_BED;
    const a = c.toWorld(-B.hw, B.y, B.z0, { x: 0, y: 0, z: 0 });
    const b = c.toWorld(B.hw, B.y, B.z1, { x: 0, y: 0, z: 0 });
    return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z), y0: 0, y1: 0, y: (a.y + b.y) / 2 };
  }

  /** the crane's own carrier as solids for its hook: the mobile crane's, the loader truck's cab and the boards of its flatbed */
  private ownBoxes(): void {
    const c = this.crane;
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void => {
      const pts = [c.toWorld(x0, y0, z0, { x: 0, y: 0, z: 0 }), c.toWorld(x1, y1, z1, { x: 0, y: 0, z: 0 }), c.toWorld(x0, y0, z1, { x: 0, y: 0, z: 0 }), c.toWorld(x1, y1, z0, { x: 0, y: 0, z: 0 })];
      this.own.push({ x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)), z0: Math.min(...pts.map((p) => p.z)), z1: Math.max(...pts.map((p) => p.z)), y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) });
    };
    this.own.length = 0;
    if (this.type === 'mobile') {
      box(-1.27, 1.27, 0, 1.75, -3.95, 4.6);
      box(-1.27, -0.5, 1.75, 3.2, -3.95, -2.25);
    } else if (this.type === 'loader') {
      const B = LOADER_BED;
      box(-1.25, 1.25, 0, 3.1, -3.9, -2.35);
      box(-B.hw, B.hw, 0, B.y + 1.1, B.z0 - 0.08, B.z0);
      box(-B.hw - 0.04, -B.hw, B.y, B.y + 0.4, B.z0, B.z1);
      box(B.hw, B.hw + 0.04, B.y, B.y + 0.4, B.z0, B.z1);
      box(-B.hw, B.hw, B.y, B.y + 0.4, B.z1 - 0.03, B.z1 + 0.03);
    }
  }

  // ---------------------------------------------------------------------------- driving and working

  /** Take over the vehicle's pose (where it stands, its heading, the ground's slope). */
  private fromVehicle(v: Vehicle, handbrake: boolean): void {
    const m = [0, 0, 0];
    v.getModelPosition(m);
    this.veh.x = m[0];
    this.veh.y = m[1];
    this.veh.z = m[2];
    this.veh.yaw = v.yaw;
    this.veh.speed = v.speed;
    this.veh.handbrake = handbrake;
    this.vq.set(v.quat[0], v.quat[1], v.quat[2], v.quat[3]);
  }

  private setOperating(on: boolean): void {
    this.operating = on;
    this.panel.active = on;
    this.host.input.crane = on;
    this.host.ui.classList.toggle('craning', on);
    this.lookReady = false;
  }

  /**
   * Change between driving and working the crane: to the crane once the
   * vehicle stands with its parking brake on, back to driving once the
   * crane is folded and its outriggers are in.  The key of a tip when it
   * cannot be done now (null: done).
   */
  toggle(v: Vehicle, handbrake: boolean): string | null {
    const no = (key: string): string => {
      this.say(key, 3);
      return key;
    };
    if (this.type === 'tower') return null;
    if (!this.operating) {
      if (Math.abs(v.speed) > 0.3) return no('craneTip.stopFirst');
      if (!handbrake) return no('craneTip.handbrake');
      this.fromVehicle(v, handbrake);
      const s = slopeOf(v.quat);
      this.crane.place(this.veh.x, this.veh.y, this.veh.z, this.veh.yaw, s.gx, s.gz);
      this.ownBoxes();
      this.refreshBoxes();
      // (the crane's hydraulics run off the engine: started from the crane's controls if it stood)
      if (!v.engineRunning) v.resetDrivetrain(true);
      this.setOperating(true);
      this.host.audio.click('door');
      return null;
    }
    if (this.crane.load) return no('craneTip.loadOn');
    if (!this.crane.stowed()) return no(this.type === 'loader' ? 'craneTip.fold' : 'craneTip.stow');
    if (!this.crane.outriggersIn()) return no('craneTip.outriggersIn');
    this.setOperating(false);
    this.own.length = 0;
    this.colliders();
    this.host.audio.click('door');
    return null;
  }

  /** Each frame while the vehicle is driven: the site, the loads on the flatbed going with it, the guide (drive there, park). */
  drive(dt: number, v: Vehicle, handbrake: boolean): void {
    this.time += dt;
    this.layout();
    this.fromVehicle(v, handbrake);
    // (the crane goes with its vehicle: its hook hangs where it is stowed – the loader crane's is hooked in under the folded boom)
    const s = slopeOf(v.quat);
    this.crane.place(this.veh.x, this.veh.y, this.veh.z, this.veh.yaw, s.gx, s.gz);
    if (this.type === 'loader') this.crane.hook.y = this.crane.head.y - 0.15;
    this.carryLoads();
    this.updateTasks();
  }

  /** The loads on the loader crane's own flatbed: where the truck is. */
  private carryLoads(): void {
    const t = this.tasks;
    if (!t || this.type !== 'loader') return;
    for (const l of t.loads) {
      if (!l.bed || l.hooked) continue;
      this.tmp.set(l.bed.x, LOADER_BED.y, l.bed.z).applyQuaternion(this.vq);
      l.x = this.veh.x + this.tmp.x;
      l.y = this.veh.y + this.tmp.y + this.crane.lift;
      l.z = this.veh.z + this.tmp.z;
      l.yaw = this.veh.yaw + l.bed.yaw;
    }
    // (the place on the flatbed goes with it)
    for (const zn of t.zones) {
      if (!zn.bed) continue;
      this.tmp.set(zn.bed.x, LOADER_BED.y, zn.bed.z).applyQuaternion(this.vq);
      zn.x = this.veh.x + this.tmp.x;
      zn.y = this.veh.y + this.tmp.y + this.crane.lift;
      zn.z = this.veh.z + this.tmp.z;
      zn.yaw = this.veh.yaw;
    }
  }

  /** Each frame while the crane is worked: the controls, the crane's steps, the load on the hook, the tasks. */
  work(dt: number, v: Vehicle): void {
    this.time += dt;
    this.layout();
    if (this.type === 'tower' && this.crane.time === 0) {
      // (the tower crane stands where its vehicle was put: on its base – its drives are electric, no engine runs)
      this.fromVehicle(v, true);
      this.crane.place(this.veh.x, this.veh.y, this.veh.z, this.veh.yaw);
      v.engineRunning = false;
    }
    const ctl = this.panel.read(dt);
    const cmd = this.crane.cmd;
    cmd.slew = -ctl.lx;
    cmd.hoist = ctl.ly;
    cmd.boom = ctl.ry;
    cmd.tele = ctl.rx;
    cmd.fine = ctl.fine;
    cmd.beams = ctl.beams;
    cmd.jacks = ctl.jacks;
    cmd.level = ctl.level;
    // the cargo on the loader crane's bed holds it down too
    const extra: Weight[] = [];
    if (this.type === 'loader') for (const l of this.tasks?.loads ?? []) if (l.bed && !l.hooked) extra.push({ t: l.def.t, x: l.bed.x, y: LOADER_BED.y + l.def.hy, z: l.bed.z });
    this.crane.extra = extra;
    const ev = this.ev;
    ev.hit = 0;
    ev.landed = 0;
    ev.liftedOff = false;
    ev.cut = false;
    this.acc = Math.min(this.acc + dt, 0.1);
    const wasLift = this.crane.lift;
    while (this.acc >= STEP) {
      this.crane.step(STEP, this.world);
      const e = this.crane.events;
      ev.hit = Math.max(ev.hit, e.hit);
      ev.landed = Math.max(ev.landed, e.landed);
      ev.liftedOff ||= e.liftedOff;
      ev.cut ||= e.cut;
      this.acc -= STEP;
    }
    // (lifted or lowered by its jacks: what it carries goes with it, and so does its own outline for the hook)
    if (Math.abs(this.crane.lift - wasLift) > 1e-4) this.ownBoxes();
    // the load on the hook goes where the hook goes
    const l = this.hooked();
    if (l) {
      const h = this.crane.hook;
      l.x = h.x;
      l.z = h.z;
      l.y = h.y - this.crane.drop();
    }
    this.carryLoads();
    if (ev.hit > 0.25) this.host.audio.click(ev.hit > 0.8 ? 'crash' : 'bump');
    if (ev.landed > 0.3) this.host.audio.click('bump');
    // the engine works the crane's hydraulics: it revs with what is moved (the tower crane's drives are electric)
    if (this.type !== 'tower') {
      const act = Math.min(1, Math.abs(ctl.lx) + Math.abs(ctl.ly) + Math.abs(ctl.rx) + Math.abs(ctl.ry) + (ctl.beams || ctl.jacks || ctl.level ? 0.6 : 0));
      v.rpm += (v.spec.idleRpm * (1 + act * 1.1) - v.rpm) * Math.min(1, dt * 3);
    }
    // the limiter's warning: a beep now and then from 90 %, quickly once it cuts off
    const lmi = this.crane.lmi;
    if (lmi.warn || lmi.stop) {
      this.beepT -= dt;
      if (this.beepT <= 0) {
        this.host.audio.click('beep');
        this.beepT = lmi.stop ? 0.35 : 1.1;
      }
    } else this.beepT = 0;
    this.updateTasks();
  }

  /** the load on the hook (as the work knows it) */
  private hooked(): WorldLoad | null {
    const id = this.crane.load?.id;
    return id ? (this.tasks?.loads.find((x) => x.id === id) ?? null) : null;
  }

  private readonly snap: CraneSnapshot = {
    time: 0,
    vx: 0,
    vz: 0,
    yaw: 0,
    speed: 0,
    handbrake: true,
    operating: false,
    beams: 0,
    padsDown: false,
    onOutriggers: false,
    incline: 0,
    stowed: true,
    luff: 0,
    unfolded: false,
    head: { x: 0, y: 0, z: 0 },
    hook: { x: 0, y: 0, z: 0 },
    hooked: null,
    resting: false,
    clearance: 0,
    swing: 0,
    lmi: null as unknown as CraneSnapshot['lmi'],
    events: null as unknown as CraneEvents,
    tipped: false,
  };

  /** What the crane is like now, for the tasks. */
  private snapshot(): CraneSnapshot {
    const s = this.snap;
    const c = this.crane;
    s.time = this.time;
    s.vx = this.veh.x;
    s.vz = this.veh.z;
    s.yaw = this.veh.yaw;
    s.speed = this.veh.speed;
    s.handbrake = this.veh.handbrake;
    s.operating = this.operating;
    s.beams = c.beamSetting();
    s.padsDown = c.padsDown(this.world);
    s.onOutriggers = c.onOutriggers(this.world);
    s.incline = c.incline();
    s.stowed = c.stowed();
    s.luff = (c.q.luff * 180) / Math.PI;
    s.unfolded = this.type === 'loader' && !c.stowed() && c.q.inner + c.q.outer > -0.5;
    s.head.x = c.head.x;
    s.head.y = c.head.y;
    s.head.z = c.head.z;
    s.hook.x = c.hook.x;
    s.hook.y = c.hook.y;
    s.hook.z = c.hook.z;
    s.hooked = c.load?.id ?? null;
    s.resting = c.resting;
    s.clearance = c.clearance;
    s.swing = c.swing;
    s.lmi = c.lmi;
    s.events = this.ev;
    s.tipped = c.tipped !== null;
    return s;
  }

  private updateTasks(): void {
    const t = this.tasks;
    if (!t) return;
    const ev = t.update(this.snapshot());
    for (const f of ev.faults) this.host.note(f, this.crane.hook.x, this.crane.hook.z);
    if (ev.stepDone) this.host.audio.click('chime');
    if (ev.taskDone) {
      this.host.audio.click('chime');
      const r = t.results[t.results.length - 1];
      this.say('craneTip.taskDone', 4, { stars: '★'.repeat(r.stars) + '☆'.repeat(3 - r.stars), score: r.score });
    }
    if (ev.allDone && this.overAt < 0) this.overAt = this.time + 3;
    if (this.crane.tipped && this.overAt < 0) this.overAt = this.time + 4;
    // the events were told: the next frame's steps collect anew
    this.ev.hit = 0;
    this.ev.landed = 0;
    this.ev.liftedOff = false;
    this.ev.cut = false;
    if (this.overAt > 0 && this.time >= this.overAt) this.over = true;
  }

  private sayData: Record<string, string | number> = {};

  private say(key: string, seconds: number, data: Record<string, string | number> = {}): void {
    this.tip = key;
    this.sayData = data;
    this.tipUntil = this.time + seconds;
  }

  /** Sling the load the hook is over, or let go of the one on it (once it stands and its slings are slack). */
  attach(): void {
    const t = this.tasks;
    const c = this.crane;
    if (!this.operating || !t || c.tipped) return;
    const audio = this.host.audio;
    if (c.load) {
      const l = this.hooked();
      if (!l) return;
      // (the slinger unhooks only a load that stands and no longer pulls on the rope)
      if (!c.resting || c.tension > 0.3 * c.load.t * G) {
        this.say('craneTip.setDownFirst', 3);
        return;
      }
      l.x = c.hook.x;
      l.z = c.hook.z;
      l.y = c.hook.y - c.drop();
      c.release();
      l.hooked = false;
      // set down on the loader's own flatbed: it goes with the truck from now on
      if (this.type === 'loader') {
        const bed = this.bedBox();
        const [cx, cz] = c.toCarrier(l.x, l.z);
        const B = LOADER_BED;
        if (bed && Math.abs(l.y - bed.y) < 0.1 && Math.abs(cx) <= B.hw && cz >= B.z0 && cz <= B.z1) l.bed = { x: cx, z: cz, yaw: l.yaw - this.veh.yaw };
      }
      this.refreshBoxes();
      audio.click('clack');
      return;
    }
    const l = t.reachable(c.hook, c.spec.hookDrop);
    if (!l) {
      const near = t.loads.some((x) => !x.fixed && !x.hooked && Math.hypot(x.x - c.hook.x, x.z - c.hook.z) < 1.5);
      this.say(near ? 'craneTip.lowerMore' : 'craneTip.noLoad', 3);
      return;
    }
    // (off the flatbed it is in the world now: where the truck put it)
    l.bed = null;
    l.bearers = false;
    l.hooked = true;
    c.attach({ id: l.id, t: l.def.t, hx: l.def.hx, hy: l.def.hy, hz: l.def.hz, sling: l.def.sling, yaw: l.yaw, area: l.def.area }, l.x, l.y + 2 * l.def.hy, l.z);
    this.refreshBoxes();
    audio.click('clack');
  }

  // ---------------------------------------------------------------------------- what is shown

  /** Pose the crane's model and draw the site's loads as they are; `shown`: the crane's display is shown (while driving or working, not over the menus). */
  render(model: CraneModel, now: number, shown: boolean): void {
    this.panel.root.hidden = !shown;
    model.root.updateMatrixWorld(true);
    model.pose(this.crane, now);
    const t = this.tasks;
    if (!t) return;
    const tg = t.target();
    const c = this.crane;
    const hook = c.load ? this.tmp2.set(c.hook.x, c.hook.y - c.spec.hookDrop, c.hook.z) : null;
    this.site.update(t.loads, hook, tg ? { load: tg.load.id, zone: tg.zone } : null, now);
    this.site.tick(now);
  }

  /** The panel and the street-name block: what the limiter measures, what to do now. */
  hud(hs: HudState, touch: boolean): void {
    const lang = this.host.settings.lang;
    const c = this.crane;
    this.panel.setMode(touch ? 'touch' : 'keys');
    const t = this.tasks;
    const canAttach = !!t && !c.load && t.reachable(c.hook, c.spec.hookDrop) !== null;
    const slope = c.tilt();
    const stillOk = Math.abs(this.veh.speed) < 0.3 && this.veh.handbrake;
    this.panel.update(
      c.lmi,
      {
        type: this.type,
        operating: this.operating,
        hooked: !!c.load,
        canAttach,
        swing: c.swing,
        beams: c.beamSetting(),
        padsDown: this.operating ? c.padsDown(this.world) : false,
        onOutriggers: this.operating ? c.onOutriggers(this.world) : false,
        slopeX: (Math.atan(slope.gx) * 180) / Math.PI,
        slopeZ: (Math.atan(slope.gz) * 180) / Math.PI,
        stowed: c.stowed(),
        canDrive: c.stowed() && c.outriggersIn() && !c.load,
        canOperate: stillOk,
        fine: this.panel.fine,
      },
      this.time,
    );
    // what to do, as the work says it
    const tk = (key: string, data: Record<string, string | number> = {}): string => {
      const d: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(data)) d[k] = k === 'load' ? tr(String(v), lang) : v;
      return tr(key, lang, d);
    };
    if (t) {
      const ins = t.instruction(this.snapshot());
      hs.navText = tk(ins.key, ins.data);
      const progress = t.stage === 'guide' ? tr('craneProgressGuide', lang) : t.stage === 'done' ? '' : tr('craneProgress', lang, { n: t.task + 1, max: t.plan.tasks.length });
      hs.navSub = [progress, ins.hint ? tr(ins.hint, lang) : ''].filter(Boolean).join(' · ');
    } else {
      hs.navText = tr(this.host.yard ? 'craneSiteLoading' : 'craneNoSite', lang);
      hs.navSub = '';
    }
    hs.navArrow = 0;
    hs.navActive = false;
    if (this.operating) {
      hs.limit = -1;
      hs.zone = 0;
      hs.junction = null;
      hs.onFoot = true;
      hs.noKeyHints = true;
      hs.tipAction = '';
      // (the little map turns with the boom)
      const [dx, dz] = boomDir(c.q.slew);
      const c0 = Math.cos(c.base.yaw);
      const s0 = Math.sin(c.base.yaw);
      hs.yaw = Math.atan2(-(dx * c0 + dz * s0), -(-dx * s0 + dz * c0));
      hs.tip = '';
    }
    // (the road's tips do not fit on the site: back onto the road, getting out – the door key changes to the crane here)
    if (!this.operating && (hs.tipAction === 'KeyT' || hs.tipAction === 'KeyG' || hs.tip === tr('offMap', lang))) {
      hs.tip = '';
      hs.tipAction = '';
    }
    if (this.time < this.tipUntil) {
      hs.tip = tk(this.tip, this.sayData);
      hs.tipAction = '';
    } else if (!this.operating && this.type !== 'tower' && stillOk && t?.inStand({ vx: this.veh.x, vz: this.veh.z, yaw: this.veh.yaw })) {
      // parked in its stand: change to working the crane
      hs.tip = tr(touch ? 'craneTip.operateTouch' : 'craneTip.operate', lang);
      hs.tipAction = touch ? '' : 'KeyG';
    }
  }

  /**
   * The camera while the crane is worked: from the operator's seat looking
   * where the hook is ('cockpit'), or round the hook ('chase').  False for
   * the free camera (the game's own).
   */
  camera(cam: THREE.PerspectiveCamera, mode: string, c: Controls, dt: number, model: CraneModel): boolean {
    if (!this.operating) return false;
    const cr = this.crane;
    const h = cr.hook;
    // what is watched: the load's middle on the hook, else the hook
    const l = this.hooked();
    const target = this.tmp2.set(h.x, l ? l.y + l.def.hy : h.y - 0.5, h.z);
    if (mode === 'cockpit') {
      cam.near = 0.08;
      cam.fov = 62;
      model.operatorEye(this.tmp);
      cam.position.copy(this.tmp);
      // the eyes follow the load (smoothly), the player's look turns them from there
      if (!this.lookReady) {
        this.look.copy(target);
        this.lookReady = true;
      } else this.look.lerp(target, Math.min(1, dt * 3));
      const d = this.look.clone().sub(cam.position);
      const yaw = Math.atan2(-d.x, -d.z);
      const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      cam.quaternion.setFromEuler(new THREE.Euler(Math.max(-1.45, Math.min(1.2, pitch + c.lookPitch)), yaw + c.lookYaw, 0, 'YXZ'));
      return true;
    }
    if (mode === 'chase') {
      cam.near = 0.3;
      cam.fov = 55;
      // behind the hook as seen from the crane, the player's drag turning round it, the wheel in and out
      const yawBase = Math.atan2(-(h.x - cr.base.x), -(h.z - cr.base.z));
      const yaw = yawBase + c.lookYaw;
      const el = Math.max(0.05, Math.min(1.45, 0.42 - c.lookPitch));
      const dist = Math.max(6, Math.min(90, c.lookZoom));
      const want = this.tmp.set(target.x + Math.sin(yaw) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z + Math.cos(yaw) * Math.cos(el) * dist);
      const g = this.host.heightAt(want.x, want.z);
      if (!Number.isNaN(g)) want.y = Math.max(want.y, g + 1.2);
      if (!this.lookReady) {
        cam.position.copy(want);
        this.lookReady = true;
      } else cam.position.lerp(want, Math.min(1, dt * 4));
      cam.lookAt(target);
      return true;
    }
    return false;
  }

  /** The tasks as they went, for the result page (null: none was done). */
  resultNode(): HTMLElement | null {
    const t = this.tasks;
    if (!t || t.results.length === 0) return null;
    const lang = this.host.settings.lang;
    const box = document.createElement('div');
    box.className = 'crane-results';
    const fmt = (v: number, d: number): string => {
      try {
        return new Intl.NumberFormat(localeOf(lang), { minimumFractionDigits: d, maximumFractionDigits: d, numberingSystem: 'latn' }).format(v);
      } catch {
        return v.toFixed(d);
      }
    };
    const total = Math.round(t.results.reduce((s, r) => s + r.score, 0) / t.results.length);
    const head = document.createElement('p');
    head.className = 'crane-total';
    head.textContent = tr('craneResult.total', lang, { done: t.results.length, max: t.plan.tasks.length, score: total });
    box.append(head);
    t.results.forEach((r: TaskResult, i) => {
      const row = document.createElement('div');
      row.className = `fault ${r.stars >= 2 ? 'hint' : r.stars === 1 ? 'minor' : 'major'}`;
      const b = document.createElement('b');
      b.textContent = `${i + 1} · ${tr(r.text, lang, { load: tr(r.load, lang) })}  ${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)}`;
      const small = document.createElement('small');
      const min = Math.floor(r.time / 60);
      const sec = Math.round(r.time % 60);
      small.textContent = tr('craneResult.line', lang, {
        score: r.score,
        time: `${min}:${String(sec).padStart(2, '0')}`,
        off: Math.round(r.offset * 100),
        swing: fmt(r.swing, 1),
        landing: fmt(r.landing, 2),
        peak: Math.round(r.peak * 100),
      });
      row.append(b, small);
      if (r.overload || r.hits > 0) {
        const em = document.createElement('em');
        em.textContent = [r.overload ? tr('craneResult.overload', lang) : '', r.hits > 0 ? tr('craneResult.hits', lang, { n: r.hits }) : ''].filter(Boolean).join(' · ');
        row.append(em);
      }
      box.append(row);
    });
    return box;
  }

  /** The work ends: the site and the panel go, the keys are the driver's again. */
  dispose(): void {
    this.site.hide();
    this.panel.show(null);
    this.panel.onAttach = () => {};
    this.panel.onToggle = () => {};
    this.host.collider.remove('cranesite');
    this.host.ground.paved = null;
    this.host.input.crane = false;
    this.host.ui.classList.remove('craning');
  }
}
