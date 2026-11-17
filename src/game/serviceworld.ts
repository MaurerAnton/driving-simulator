// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fuel stations, car washes and the loading of a truck – in the game.
 *
 * This keeps what the game needs of them, and is called from a few places
 * of game.ts:
 *
 *  - load: the stations and washes of the map (services.json.gz; a map
 *    without the file simply has none);
 *  - tile: as a tile of the map comes, the blocks the building models drew
 *    for the canopies and wash halls are taken out of it (its building mesh,
 *    its collision outlines, the trees under them), and the sites whose
 *    middle lies on it are built a frame at a time (render/services.ts) –
 *    with their own collision outlines: islands, columns, walls;
 *  - begin: a new drive – a tank of the vehicle's kind with some fuel in it,
 *    some dirt on it, and on a free drive with a truck of class C1 or C the
 *    goods it is to be loaded with (its physics get the load: sim/payload.ts;
 *    with a trailer behind the box's doors – C1E, CE – nothing is loaded);
 *  - startScene: the loading of that truck at a depot beside the road (or
 *    at the roadside where there is no room), render/loading.ts, before the
 *    drive begins;
 *  - drive (every step of a drive): the engine burns its fuel (sim/fuel.ts)
 *    and stops with the tank empty; the dirt grows; what the vehicle stands
 *    at – a pump, the mark in a car wash – and what is going on there
 *    (game/services.ts); on a station's ground nothing is judged as on the
 *    road (rules.yard);
 *  - visual and hud (every frame): the fuel gauge, the dirt on the model,
 *    the nozzle and the gantry, and the tip that says what to do – on a
 *    touch screen the tip itself is the button, with keys it is 9 (the
 *    "service" action of input.ts).
 */
import * as THREE from 'three';
import { formatUnit, localeOf, tr } from '../i18n/index.ts';
import type { BoxBody } from '../render/boxbody.ts';
import type { CarVisualState } from '../render/car.ts';
import { DirtLook } from '../render/dirt.ts';
import type { VehicleModel } from '../render/fleet.ts';
import { LoadingScene } from '../render/loading.ts';
import { FillView, SiteView, SprayView } from '../render/services.ts';
import type { LoadedTile } from '../render/tiles.ts';
import type { CollisionSource, SceneryCollider } from '../sim/collision.ts';
import { FuelTank, fuelFlow, startShare, tankFor } from '../sim/fuel.ts';
import { withPayload } from '../sim/payload.ts';
import type { DriverInput, Vehicle, VehicleSpec } from '../sim/vehicle/index.ts';
import type { HudState } from '../ui/hud.ts';
import { FUELS, GANTRY, ServiceIndex, WASH_PRICE, inBay, inRing, onSite, parseServices, priceAt, pumpBeside, ringDistance } from '../world/services.ts';
import type { ServiceSite, ServicesJson } from '../world/services.ts';
import { POS_XZ_SCALE, POS_Y_SCALE } from '../world/tilefmt.ts';
import type { SectionArray } from '../world/tilefmt.ts';
import { HELP, LOADED_KINDS, Refuelling, Washing, bearingSector, dirtGrowth, findDepot, planLoad } from './services.ts';
import type { PalletPlan } from './services.ts';
import type { VehicleDef } from './vehicles.ts';
import { snowOnGround, weatherNow } from './weather.ts';

/** What the services need of the game. */
export interface ServiceHost {
  scene: THREE.Scene;
  collider: SceneryCollider;
  /** where the overlay of the loading scene goes */
  ui: HTMLElement;
  map: { json<T>(path: string): Promise<T | null> };
  /** the ground at a point (NaN where it is not loaded) */
  ground(x: number, z: number): number;
  /** is a point on a road or a pavement? */
  onRoad(x: number, z: number): boolean;
  /** would the vehicle being driven touch anything standing there? */
  blocked(x: number, z: number, yaw: number): boolean;
  lang(): string;
  /** a notice in the street-name block */
  message(title: string, sub?: string): void;
  click(sound: 'chime' | 'tick' | 'door'): void;
  hideOverlay(): void;
  rules: { yard: boolean };
  shadows(): boolean;
}

/** Where a vehicle's filler is (model frame: x to the right, y up, z back), on its right side – the left one mirrors it. */
const FILLER: Record<string, [number, number, number]> = {
  car: [0.88, 0.86, 1.02],
  truck: [1.24, 0.95, -0.4],
  truckLight: [1.18, 0.9, -0.3],
  bus: [1.28, 0.8, -2.5],
  minibus: [1.1, 0.75, 1.4],
  tractor: [0.95, 1.55, 0.3],
  motorcycle: [0.16, 1.02, -0.32],
};

/** How tall a vehicle is (m): the highest corner of its body (a car's when it says none). */
function heightOf(spec: VehicleSpec): number {
  let h = 1.45;
  if (spec.bodyPoints) {
    h = 0;
    for (const p of spec.bodyPoints) h = Math.max(h, p[1]);
  }
  return h;
}

/** A number as the language writes it, with `digits` decimals. */
function num(v: number, digits: number, lang: string): string {
  try {
    return new Intl.NumberFormat(localeOf(lang), { minimumFractionDigits: digits, maximumFractionDigits: digits, numberingSystem: 'latn' }).format(v);
  } catch {
    return v.toFixed(digits);
  }
}

type Activity =
  | { kind: 'fill'; r: Refuelling; site: ServiceSite; canopy: number; pump: number; side: number; noted: boolean }
  | { kind: 'wash'; w: Washing; site: ServiceSite; dir: number }
  | { kind: 'help'; t: number };

/** What the vehicle stands at, as worked out each step. */
interface Here {
  /** on the ground of a station, a wash or the depot (nothing is judged there as on the road) */
  onSite: boolean;
  pump: { site: ServiceSite; canopy: number; pump: number; side: number; fuel: string; why: string } | null;
  bay: { site: ServiceSite; dir: number; along: number; why: string } | null;
}

export class ServiceWorld {
  private readonly host: ServiceHost;
  private index: ServiceIndex | null = null;
  readonly group = new THREE.Group();
  private readonly views = new Map<number, SiteView>();
  /** sites whose tile has come, to be built (one a frame) */
  private readonly queue = new Set<ServiceSite>();
  private readonly fillView = new FillView();
  private readonly spray = new SprayView();
  private readonly dirtLook = new DirtLook();
  /** the fuel in the tank of the vehicle being driven (null: one without a tank) */
  tank: FuelTank | null = null;
  /** the dirt on it, 0 clean … 1 filthy */
  dirt = 0;
  private def: VehicleDef | null = null;
  private height = 1.45;
  private doing: Activity | null = null;
  private here: Here = { onSite: false, pump: null, bay: null };
  private standing = true;
  private engineOn = false;
  private yardSet = false;
  private lowWarned = false;
  private emptyWarned = false;
  /** the goods of the truck, and the scene of its loading (and the depot it leaves standing) */
  private goods: { pallets: PalletPlan[]; mass: number } | null = null;
  private scene: { s: LoadingScene; done: () => void; box: HTMLElement; caption: HTMLElement } | null = null;
  private depot: { s: LoadingScene; x: number; z: number } | null = null;
  private readonly p = [0, 0, 0];
  private readonly v3 = new THREE.Vector3();
  /** the nozzle stands in the filler (it is not moved again while the fuel runs) */
  private fillShown = false;

  constructor(host: ServiceHost) {
    this.host = host;
    this.group.name = 'fuel stations and car washes';
    this.group.add(this.fillView.group, this.spray.points);
    host.scene.add(this.group);
  }

  /** Read the stations and washes of the map (none if it has no services.json.gz). */
  async load(): Promise<void> {
    try {
      const json = await this.host.map.json<ServicesJson>('services.json.gz');
      if (json) this.index = new ServiceIndex(parseServices(json));
    } catch (e) {
      console.warn('the fuel stations and car washes could not be read', e);
    }
  }

  // ---------------------------------------------------------------- the tiles of the map

  /** A tile came (or went): take the blocks of the canopies and wash halls out of it, and build the sites on it. */
  tile(tile: LoadedTile, loaded: boolean): void {
    if (!this.index) return;
    const h = tile.header;
    const half = h.size / 2;
    const own = (s: ServiceSite): boolean => Math.abs(s.x - h.cx) <= half && Math.abs(s.z - h.cz) < half && !(s.x === h.cx + half || s.z === h.cz + half);
    if (!loaded) {
      for (const [i, v] of this.views) {
        if (!own(v.site)) continue;
        this.drop(i, v);
      }
      for (const s of this.queue) if (own(s)) this.queue.delete(s);
      return;
    }
    const roofs: Array<{ ring: number[]; top: number }> = [];
    for (const s of this.index.near(h.cx, h.cz, half + 30)) {
      if (own(s) && (s.k === 'fuel' ? s.canopies.length > 0 : !!s.wash)) this.queue.add(s);
      for (const r of s.roofs ?? []) {
        if (r.src !== 'lod2') continue;
        // (only roofs that reach into this tile)
        let inside = false;
        for (let i = 0; i < r.ring.length && !inside; i += 2) inside = Math.abs(r.ring[i] - h.cx) < half + 2 && Math.abs(r.ring[i + 1] - h.cz) < half + 2;
        if (inside) roofs.push({ ring: r.ring, top: r.y1 ?? NaN });
      }
    }
    if (roofs.length > 0) clearRoofs(tile, roofs);
  }

  private drop(i: number, v: SiteView): void {
    if (this.doing && this.doing.kind !== 'help' && this.doing.site === v.site) this.stopAll();
    v.dispose();
    this.host.collider.remove(`svc:${i}`);
    this.views.delete(i);
  }

  // ---------------------------------------------------------------- a drive

  /**
   * A new drive with this vehicle: its tank, its dirt – and on a free drive
   * (`free`) the goods of a truck of class C1 or C: returns the spec to build
   * its physics with (with the load in it).
   */
  begin(def: VehicleDef, spec: VehicleSpec, free: boolean): VehicleSpec {
    this.end();
    this.def = def;
    this.height = heightOf(spec);
    const ts = tankFor(def.kind);
    // (a free drive may begin with the reserve; a lesson, a test or a demonstration with a good part of the tank)
    this.tank = ts ? new FuelTank(ts, free ? startShare(Math.random(), Math.random()) : 0.6 + Math.random() * 0.35) : null;
    this.dirt = (def.model === 'car' ? 0.03 : 0.1) + Math.random() * 0.35;
    this.lowWarned = false;
    this.emptyWarned = false;
    this.goods = null;
    if (free && LOADED_KINDS.includes(def.kind)) {
      const plan = planLoad(spec.wheelbase, spec.width ?? 2.5, def.kind.startsWith('light') ? 1600 : 2400, Math.random);
      this.goods = { pallets: plan.pallets, mass: plan.payload.mass };
      return withPayload(spec, plan.payload);
    }
    return spec;
  }

  /**
   * The truck stands where the drive begins: if it is to be loaded, the
   * scene of the loading begins (true – `done` is called when it is over);
   * else nothing happens (false).
   */
  startScene(v: Vehicle, model: VehicleModel, done: () => void): boolean {
    const body = (model as unknown as { body?: BoxBody }).body;
    const def = this.def;
    if (!this.goods || !body || !def) return false;
    v.getModelPosition(this.p);
    const spot = findDepot(this.p[0], this.p[2], v.yaw, def.outline.front, def.outline.rear, {
      road: (x, z) => this.host.onRoad(x, z),
      blocked: (x, z, yaw) => this.host.blocked(x, z, yaw),
      ground: (x, z) => this.host.ground(x, z),
    });
    let pose = { x: this.p[0], y: this.p[1], z: this.p[2], yaw: v.yaw, dock: false };
    if (spot) {
      const y = this.host.ground(spot.x, spot.z);
      v.teleport(spot.x, y + 0.02, spot.z, spot.yaw);
      pose = { x: spot.x, y, z: spot.z, yaw: spot.yaw, dock: true };
    }
    const s = new LoadingScene(pose, body, this.goods.pallets);
    this.group.add(s.group);
    if (pose.dock) {
      // the warehouse stands in the way like any building
      const c = Math.cos(pose.yaw);
      const sn = Math.sin(pose.yaw);
      const ring: number[] = [];
      for (const [lx, lz] of [
        [-7, s.wallZ],
        [7, s.wallZ],
        [7, s.wallZ + 11],
        [-7, s.wallZ + 11],
      ])
        ring.push(pose.x + lx * c + lz * sn, pose.z - lx * sn + lz * c);
      this.host.collider.add({ key: 'svc:depot', rings: Float32Array.from(ring), ringCounts: Uint16Array.of(4), segments: null, discs: [] });
    }
    // what is being done, and a button to skip it
    const box = document.createElement('div');
    box.className = 'svc-scene';
    const caption = document.createElement('div');
    caption.className = 'svc-cap';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'svc-skip';
    skip.textContent = `${tr('load.skip', this.host.lang())} ⏭`;
    skip.onclick = (e) => {
      e.stopPropagation();
      s.skip();
    };
    box.append(caption, skip);
    this.host.ui.append(box);
    this.host.hideOverlay();
    this.scene = { s, done, box, caption };
    this.depot = { s, x: pose.x, z: pose.z };
    this.caption();
    return true;
  }

  private caption(): void {
    const sc = this.scene;
    if (!sc) return;
    const lang = this.host.lang();
    const pr = sc.s.progress;
    const text = `<b>${tr('load.title', lang)}</b><small>${tr('load.progress', lang, { n: pr.loaded, total: pr.total, kg: num(pr.mass, 0, lang) })}</small>`;
    if (sc.caption.innerHTML !== text) sc.caption.innerHTML = text;
  }

  private finishScene(): void {
    const sc = this.scene;
    if (!sc) return;
    this.scene = null;
    sc.box.remove();
    const lang = this.host.lang();
    const pr = sc.s.progress;
    this.host.message(tr('load.done', lang, { n: pr.total, kg: num(this.goods?.mass ?? pr.mass, 0, lang) }), tr('load.doneSub', lang));
    sc.done();
  }

  /**
   * A step of a drive (before the physics): fuel, dirt, what the vehicle
   * stands at, what is going on there.  `auto`: the vehicle drives by
   * itself (a demonstration) – it burns nothing then.  `task`: the yard of
   * the truck lessons is in charge of the rules.
   */
  drive(dt: number, v: Vehicle, d: DriverInput, def: VehicleDef, walking: boolean, task: boolean, auto: boolean): void {
    const tank = this.tank;
    const lang = this.host.lang();
    v.getModelPosition(this.p);
    const mid = (def.outline.rear - def.outline.front) / 2;
    const x = this.p[0] + Math.sin(v.yaw) * mid;
    const z = this.p[2] + Math.cos(v.yaw) * mid;
    this.standing = Math.abs(v.speed) < 0.25;
    this.engineOn = v.engineRunning;
    // ---- the fuel
    if (tank && !auto) {
      tank.burn(fuelFlow(v.spec, tank.spec, v.rpm, v.engineLoad, v.engineRunning), dt, Math.abs(v.speed) * dt);
      if (tank.empty) {
        // the engine stops and cannot be started
        d.ignition = false;
        d.starter = false;
        if (!this.emptyWarned) {
          this.emptyWarned = true;
          this.host.message(tr('svc.empty', lang), this.nearestText(x, z, v.yaw));
        }
      } else this.emptyWarned = false;
      if (tank.low && !tank.empty && !this.lowWarned) {
        this.lowWarned = true;
        this.host.message(tr('svc.reserve', lang, { l: num(tank.litres, 0, lang) }), this.nearestText(x, z, v.yaw));
      } else if (!tank.low) this.lowWarned = false;
    }
    // ---- the dirt: with the distance, more on a wet road, on snow, off the road
    let off = 0;
    for (const w of v.wheels) if (w.contact && w.grip < 0.62) off += 0.25;
    const weather = weatherNow();
    if (!this.doing || this.doing.kind !== 'wash') this.dirt = Math.min(1, this.dirt + dirtGrowth(Math.abs(v.speed) * dt, weather.wet, off, snowOnGround()));
    // ---- where the vehicle is
    this.here = this.whereIs(x, z, v, def, walking);
    if (!task && this.here.onSite !== this.yardSet) {
      this.yardSet = this.here.onSite;
      this.host.rules.yard = this.yardSet;
    }
    // ---- what is going on
    const st = { standing: this.standing, engineOn: this.engineOn };
    const a = this.doing;
    if (a?.kind === 'fill' && tank) {
      const before = a.r.phase;
      a.r.step(dt, tank, st);
      if (!a.noted && (before === 'run' || before === 'out') && a.r.phase === 'back') {
        a.noted = true;
        const f = a.r.fill;
        if (a.r.reason === 'engine') this.host.message(tr('svc.engineStarted', lang));
        else if (a.r.reason === 'moved') this.host.message(tr('svc.moved', lang));
        if (f.litres > 0.05) this.host.message(tr('svc.paid', lang, { l: num(f.litres, 2, lang), fuel: FUELS[a.r.fuel]?.label ?? a.r.fuel, cost: num(f.cost, 2, lang) }), tr('svc.paidSub', lang, { pct: Math.round(tank.share * 100) }));
        this.host.click('chime');
      }
      if (a.r.done) {
        this.doing = null;
        this.fillShown = false;
        this.fillView.hide();
      }
    } else if (a?.kind === 'wash') {
      a.w.update(dt, st);
      this.dirt = Math.min(this.dirt, a.w.dirt);
      if (a.w.done) {
        this.doing = null;
        if (a.w.aborted) this.host.message(tr('svc.washAbort', lang));
        else {
          this.dirt = 0;
          this.host.message(tr('svc.washDone', lang), tr('svc.washDoneSub', lang));
          this.host.click('chime');
        }
      }
    } else if (a?.kind === 'help' && tank) {
      a.t += dt;
      if (a.t >= HELP.time) {
        this.doing = null;
        tank.fill(HELP.litres);
        this.emptyWarned = false;
        this.host.message(tr('svc.helpDone', lang, { l: HELP.litres }), this.nearestText(x, z, v.yaw));
        this.host.click('chime');
      }
    }
  }

  /** What the vehicle stands at: a pump (and whether it may fill up there), the bay of a wash (and how far from the mark). */
  private whereIs(x: number, z: number, v: Vehicle, def: VehicleDef, walking: boolean): Here {
    const here: Here = { onSite: false, pump: null, bay: null };
    if (this.depot && Math.hypot(this.depot.x - x, this.depot.z - z) < 22) here.onSite = true;
    if (!this.index) return here;
    const pose = { x, z, yaw: v.yaw, length: v.spec.length ?? 4.28, width: v.spec.width ?? 1.79 };
    const tank = this.tank;
    for (const s of this.index.near(x, z, 30)) {
      if (!onSite(s, x, z, 4)) continue;
      here.onSite = true;
      if (walking) continue;
      if (s.k === 'fuel' && tank && !here.pump) {
        for (let c = 0; c < s.canopies.length; c++) {
          const plan = s.canopies[c];
          const at = pumpBeside(plan, pose);
          if (!at) continue;
          // which fuel: the vehicle's kind – petrol: E10 first, diesel: the lorry pump's for a heavy one
          const diesel = tank.spec.fuel === 'diesel';
          const want = diesel ? (def.heavy && s.sells.includes('hgv') ? ['hgv', 'diesel'] : ['diesel', 'hgv']) : ['e10', 'e5', 'plus'];
          const fuel = want.find((f) => s.sells.includes(f)) ?? '';
          // (the room under the slab, as render/services.ts builds it)
          const clear = (Number.isFinite(plan.y1) && Number.isFinite(plan.y0) ? Math.max(plan.y1 - plan.y0, 4.2) : Number.isFinite(plan.h) ? Math.max(4.2, plan.h) : 5.2) - 0.7 - this.height;
          const why = !fuel ? 'noFuel' : clear < 0.15 ? 'tooHigh' : tank.share > 0.97 ? 'full' : !this.standing ? 'moving' : this.engineOn ? 'engine' : '';
          here.pump = { site: s, canopy: c, pump: at.pump, side: at.side, fuel: fuel || (diesel ? 'diesel' : 'e10'), why };
          break;
        }
      } else if (s.k === 'wash' && s.wash && !here.bay) {
        const b = inBay(s.wash, pose);
        if (!b.inside) continue;
        const car = def.model === 'car' && !def.trailer;
        const why = !car || this.height > GANTRY.height - 0.15 || pose.width > GANTRY.width - 0.3 ? 'carsOnly' : !b.straight || Math.abs(b.across) > 0.5 ? 'straight' : b.along < -0.6 ? 'forward' : b.along > 0.6 ? 'back' : !this.standing ? 'moving' : this.engineOn ? 'engine' : '';
        here.bay = { site: s, dir: b.dir, along: b.along, why };
      }
    }
    return here;
  }

  /** "Nearest fuel station: Aral, 2.3 km ahead on the right" – or that there is none on the map. */
  private nearestText(x: number, z: number, yaw: number): string {
    const lang = this.host.lang();
    const n = this.index?.nearest(x, z, 'fuel');
    if (!n) return '';
    const d = n.dist < 1000 ? formatUnit(Math.round(n.dist / 10) * 10, 'meter', lang) : formatUnit(n.dist / 1000, 'kilometer', lang, 1);
    return tr('svc.nearest', lang, { name: n.site.name || n.site.brand || tr('svc.station', lang), d, dir: tr(`svc.dir${bearingSector(x, z, yaw, n.site.x, n.site.z)}`, lang) });
  }

  // ---------------------------------------------------------------- the button

  /** The service button (9, or the tip tapped): skip the loading, fill up, stop the pump, wash, call for help. */
  act(state: string): void {
    if (this.scene) {
      this.scene.s.skip();
      return;
    }
    if (state !== 'drive') return;
    const a = this.doing;
    if (a?.kind === 'fill') {
      a.r.stop('stopped');
      return;
    }
    if (a) return;
    const h = this.here;
    const tank = this.tank;
    if (h.pump && !h.pump.why && tank) {
      const p = h.pump;
      const price = priceAt(p.site, p.fuel);
      this.doing = { kind: 'fill', r: new Refuelling(p.fuel, price, tank.spec.flow), site: p.site, canopy: p.canopy, pump: p.pump, side: p.side, noted: false };
      this.host.click('door');
    } else if (h.bay && !h.bay.why) {
      this.doing = { kind: 'wash', w: new Washing(this.dirt), site: h.bay.site, dir: h.bay.dir };
      this.host.click('tick');
      this.host.message(tr('svc.washPaid', this.host.lang(), { cost: num(WASH_PRICE, 2, this.host.lang()) }));
    } else if (tank?.empty && this.standing) {
      this.doing = { kind: 'help', t: 0 };
      this.host.click('tick');
    }
  }

  // ---------------------------------------------------------------- every frame: what is drawn

  /** The frame's pictures: the fuel gauge of the instruments, the dirt, the sites, the nozzle, the gantry, the loading. */
  visual(s: CarVisualState, model: VehicleModel, dt: number): void {
    // (the road vehicles: those with a tank – not the tram, the aeroplane, nor somebody on foot)
    if (this.tank) {
      s.fuel = this.tank.share;
      this.dirtLook.apply(model as unknown as { root: THREE.Object3D; exterior?: { group: THREE.Object3D } });
    }
    this.dirtLook.update(this.tank ? this.dirt : 0, model.root, this.height);
    const px = model.root.position.x;
    const pz = model.root.position.z;
    this.buildNext(px, pz);
    // the nozzle in the filler and the pump's counter
    const a = this.doing;
    if (a?.kind === 'fill') {
      const view = this.views.get(a.site.index);
      const pump = view?.pumps[this.pumpIndex(a.site, a.canopy, a.pump)];
      const kind = this.def?.model ?? 'car';
      const f = FILLER[kind] ?? FILLER.car;
      if (view && pump) {
        // the filler on the side the pump is on
        const filler = this.v3.set(f[0] * (a.side > 0 ? 1 : -1), f[1], f[2]);
        model.root.localToWorld(filler);
        // (which face of the pump looks at it)
        const face = (filler.x - pump.x) * -pump.uz + (filler.z - pump.z) * pump.ux >= 0 ? 1 : -1;
        if (a.r.phase !== 'run' || !this.fillShown) this.fillView.show(pump, face, filler, a.r.nozzle, a.r.fuel);
        this.fillShown = a.r.phase === 'run';
        this.fillView.count(a.r.fill.litres, a.r.fill.cost);
      }
    }
    // the gantry: at its place, the brushes turning, foam and water
    for (const view of this.views.values()) {
      if (!view.gantry) continue;
      const w = a?.kind === 'wash' && a.site === view.site ? a : null;
      const bay = this.here.bay?.site === view.site ? this.here.bay : null;
      const face = w ? w.dir : (bay?.dir ?? 1);
      if (w) {
        const step = w.w.stepId;
        const at = w.w.at * face;
        const brushing = step === 'brush' || step === 'foam';
        view.placeGantry(at, face, brushing ? 1 : 0, step === 'brush' ? this.height + 0.38 : 0, step === 'brush' ? dt * 9 : step === 'dry' ? 0 : dt * 2, -1);
        const g = view.gantryAt(this.v3);
        const r = view.gantry.rect;
        this.spray.update(dt, g.x, g.y, g.z, -r.uz, r.ux, step === 'foam' ? 110 : step === 'rinse' || step === 'brush' ? 160 : 0, step === 'foam');
      } else {
        view.placeGantry(face, face, 0, 0, 0, bay ? (bay.why === 'forward' || bay.why === 'straight' ? 1 : -1) : 0);
      }
    }
    if (a?.kind !== 'wash') this.spray.stop();
    // the loading of the truck
    const sc = this.scene;
    if (sc) {
      sc.s.update(dt);
      this.caption();
      if (sc.s.done) this.finishScene();
    } else if (this.depot) {
      this.depot.s.update(dt);
      // (left standing once the truck is away; gone far behind)
      if (Math.hypot(this.depot.x - px, this.depot.z - pz) > 450) this.dropDepot();
    }
  }

  /** The place of a pump among the views' pumps: the canopies' islands one after the other. */
  private pumpIndex(site: ServiceSite, canopy: number, pump: number): number {
    let k = 0;
    for (let c = 0; c < canopy; c++) k += site.canopies[c].islands.length;
    return k + pump;
  }

  /** Build the nearest site that waits for it (one a frame). */
  private buildNext(px: number, pz: number): void {
    let best: ServiceSite | null = null;
    let bestD = Infinity;
    for (const s of this.queue) {
      const d = Math.hypot(s.x - px, s.z - pz);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best) return;
    this.queue.delete(best);
    if (this.views.has(best.index)) return;
    const g0 = this.host.ground(best.x, best.z);
    if (Number.isNaN(g0)) return;
    const view = new SiteView(
      best,
      (x, z) => {
        const g = this.host.ground(x, z);
        return Number.isNaN(g) ? g0 : g;
      },
      this.host.shadows(),
    );
    this.group.add(view.group);
    this.views.set(best.index, view);
    const counts: number[] = [];
    const pts: number[] = [];
    for (const r of view.rings) {
      counts.push(r.length / 2);
      pts.push(...r);
    }
    const src: CollisionSource = { key: `svc:${best.index}`, rings: pts.length ? Float32Array.from(pts) : null, ringCounts: counts.length ? Uint16Array.from(counts) : null, segments: null, discs: view.discs };
    this.host.collider.add(src);
  }

  /** The HUD: the fuel gauge and its lamp, and the tip of what to do here. */
  hud(hs: HudState, touch: boolean): void {
    const tank = this.tank;
    if (tank) {
      hs.fuel = tank.share;
      hs.fuelLow = tank.low;
    }
    const lang = this.host.lang();
    const say = (key: string, params: Record<string, string | number> = {}, action = 'Digit9', touchKey = true): void => {
      hs.tip = tr(touch && touchKey ? `${key}Touch` : key, lang, params);
      hs.tipAction = action;
    };
    const a = this.doing;
    if (a?.kind === 'fill') {
      const f = a.r.fill;
      if (a.r.phase === 'back') say('svc.fillEnd', { l: num(f.litres, 2, lang), cost: num(f.cost, 2, lang) }, '', false);
      else say('svc.filling', { l: num(f.litres, 2, lang), cost: num(f.cost, 2, lang) });
      return;
    }
    if (a?.kind === 'wash') {
      say('svc.washing', { step: tr(`svc.step.${a.w.stepId || 'dry'}`, lang), pct: Math.round(a.w.share * 100) }, '', false);
      return;
    }
    if (a?.kind === 'help') {
      say('svc.helpComing', { s: Math.max(1, Math.ceil(HELP.time - a.t)) }, '', false);
      return;
    }
    const h = this.here;
    if (h.pump && this.standing) {
      const p = h.pump;
      const fuel = FUELS[p.fuel]?.label ?? p.fuel;
      if (p.why === 'noFuel') say('svc.noFuel', { fuel: tr(tank?.spec.fuel === 'diesel' ? 'svc.diesel' : 'svc.petrol', lang) }, '', false);
      else if (p.why === 'tooHigh') say('svc.tooHigh', {}, '', false);
      else if (p.why === 'full') say('svc.tankFull', {}, '', false);
      else if (p.why === 'engine') say('svc.engineOff', {}, 'KeyI');
      else if (!p.why) say('svc.refuel', { fuel, price: num(priceAt(p.site, p.fuel), 3, lang) });
      return;
    }
    if (h.bay) {
      const b = h.bay;
      if (b.why === 'carsOnly') say('svc.washCarsOnly', {}, '', false);
      else if (b.why === 'straight') say('svc.washStraight', {}, '', false);
      else if (b.why === 'forward') say('svc.washForward', { d: num(-b.along, 1, lang) }, '', false);
      else if (b.why === 'back') say('svc.washBack', { d: num(b.along, 1, lang) }, '', false);
      else if (b.why === 'engine') say('svc.washEngineOff', {}, 'KeyI');
      else if (!b.why) say('svc.wash', { cost: num(WASH_PRICE, 2, lang) });
      return;
    }
    if (tank?.empty && this.standing) say('svc.emptyTip', { l: HELP.litres });
  }

  /** The camera of the loading scene (nothing otherwise). */
  camera(cam: THREE.PerspectiveCamera): void {
    this.scene?.s.camera(cam, (x, z) => this.host.ground(x, z));
  }

  /** Is the loading scene running? */
  get loading(): boolean {
    return this.scene !== null;
  }

  private stopAll(): void {
    this.doing = null;
    this.fillShown = false;
    this.fillView.hide();
    this.spray.stop();
  }

  private dropDepot(): void {
    if (!this.depot) return;
    if (this.scene?.s === this.depot.s) {
      this.scene.box.remove();
      this.scene = null;
    }
    this.depot.s.dispose();
    this.depot = null;
    this.host.collider.remove('svc:depot');
  }

  /** The drive is over (to the menu, or a new one begins): whatever was going on stops. */
  end(): void {
    this.stopAll();
    this.dropDepot();
    if (this.yardSet) {
      this.yardSet = false;
      this.host.rules.yard = false;
    }
    this.here = { onSite: false, pump: null, bay: null };
  }
}

// ------------------------------------------------------------------ taking the canopy's block out of a tile

/**
 * Take the blocks the map drew for these roofs out of a tile: the triangles
 * of its buildings under each roof (its top inside the outline, its walls on
 * the outline as high as the roof), the outlines of the buildings for the
 * collisions whose middle lies under a roof, and the trees under the roofs.
 * The tile's data are wrapped (game.ts reads the outlines and trees from
 * them after this).
 */
function clearRoofs(tile: LoadedTile, roofs: ReadonlyArray<{ ring: number[]; top: number }>): void {
  const h = tile.header;
  // the box round the roofs: most triangles are thrown out by it
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const r of roofs) {
    for (let i = 0; i < r.ring.length; i += 2) {
      x0 = Math.min(x0, r.ring[i]);
      x1 = Math.max(x1, r.ring[i]);
      z0 = Math.min(z0, r.ring[i + 1]);
      z1 = Math.max(z1, r.ring[i + 1]);
    }
  }
  x0 -= 0.5;
  z0 -= 0.5;
  x1 += 0.5;
  z1 += 0.5;
  const mesh = tile.group.children.find((o) => o.name === 'bldg') as THREE.Mesh | undefined;
  const index = mesh?.geometry.index;
  if (mesh && index) {
    const pos = mesh.geometry.getAttribute('position');
    const keep: number[] = [];
    const xs = [0, 0, 0];
    const zs = [0, 0, 0];
    const ys = [0, 0, 0];
    let dropped = 0;
    for (let t = 0; t + 2 < index.count; t += 3) {
      let inBox = true;
      for (let k = 0; k < 3; k++) {
        const vtx = index.getX(t + k);
        xs[k] = h.cx + pos.getX(vtx) * POS_XZ_SCALE;
        ys[k] = h.yBase + pos.getY(vtx) * POS_Y_SCALE;
        zs[k] = h.cz + pos.getZ(vtx) * POS_XZ_SCALE;
        if (xs[k] < x0 || xs[k] > x1 || zs[k] < z0 || zs[k] > z1) inBox = false;
      }
      let drop = false;
      if (inBox) {
        const cx = (xs[0] + xs[1] + xs[2]) / 3;
        const cz = (zs[0] + zs[1] + zs[2]) / 3;
        const top = Math.max(ys[0], ys[1], ys[2]);
        for (const r of roofs) {
          if (inRing(cx, cz, r.ring) && ringDistance(cx, cz, r.ring) > 0.12) drop = true;
          else if (ringDistance(xs[0], zs[0], r.ring) < 0.25 && ringDistance(xs[1], zs[1], r.ring) < 0.25 && ringDistance(xs[2], zs[2], r.ring) < 0.25 && (!Number.isFinite(r.top) || Math.abs(top - r.top) < 0.5)) drop = true;
          if (drop) break;
        }
      }
      if (drop) dropped++;
      else keep.push(index.getX(t), index.getX(t + 1), index.getX(t + 2));
    }
    if (dropped > 0) mesh.geometry.setIndex(new THREE.BufferAttribute(index.array instanceof Uint32Array ? Uint32Array.from(keep) : Uint16Array.from(keep), 1));
  }
  // the outlines and the trees, as game.ts reads them from the tile
  const data = tile.data;
  const under = (x: number, z: number, pad: number): boolean => roofs.some((r) => inRing(x, z, r.ring) || ringDistance(x, z, r.ring) < pad);
  let rings: { pts: Float32Array | null; cnt: Uint16Array | null; skip: Uint8Array | null } | null = null;
  let trees: Float32Array | null | undefined;
  const filtered = (): NonNullable<typeof rings> => {
    if (rings) return rings;
    const pts = data.get('collPts') as Float32Array | null;
    const cnt = data.get('collCnt') as Uint16Array | null;
    const skip = data.get('collSkip') as Uint8Array | null;
    if (!pts || !cnt) return (rings = { pts, cnt, skip });
    const outPts: number[] = [];
    const outCnt: number[] = [];
    const sides: boolean[] = [];
    let o = 0;
    let side = 0;
    for (const n of cnt) {
      let mx = 0;
      let mz = 0;
      for (let i = 0; i < n; i++) {
        mx += pts[o + i * 2];
        mz += pts[o + i * 2 + 1];
      }
      const away = n > 0 && under(mx / n, mz / n, 0.3);
      if (!away) {
        outCnt.push(n);
        for (let i = 0; i < n * 2; i++) outPts.push(pts[o + i]);
        for (let i = 0; i < n; i++) sides.push(skip ? (skip[(side + i) >> 3] & (1 << ((side + i) & 7))) !== 0 : false);
      }
      o += n * 2;
      side += n;
    }
    let outSkip: Uint8Array | null = null;
    if (skip) {
      outSkip = new Uint8Array(Math.ceil(sides.length / 8));
      sides.forEach((s, i) => {
        if (s) outSkip![i >> 3] |= 1 << (i & 7);
      });
    }
    return (rings = { pts: Float32Array.from(outPts), cnt: Uint16Array.from(outCnt), skip: outSkip });
  };
  tile.data = {
    header: data.header,
    get(name: string): SectionArray | null {
      if (name === 'collPts') return filtered().pts;
      if (name === 'collCnt') return filtered().cnt;
      if (name === 'collSkip') return filtered().skip;
      if (name === 'trees') {
        if (trees === undefined) {
          const t = data.get('trees') as Float32Array | null;
          if (!t) trees = null;
          else {
            const out: number[] = [];
            for (let i = 0; i + 4 < t.length; i += 5) if (!under(t[i], t[i + 2], 1)) for (let k = 0; k < 5; k++) out.push(t[i + k]);
            trees = Float32Array.from(out);
          }
        }
        return trees;
      }
      return data.get(name);
    },
  };
}

