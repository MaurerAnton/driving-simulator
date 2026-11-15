// SPDX-License-Identifier: AGPL-3.0-only
/** Game orchestration: loading, menus, the main loop, cameras, lessons. */
import * as THREE from 'three';
import { GameAudio } from '../audio/audio.ts';
import { Input } from '../input/input.ts';
import type { Action } from '../input/input.ts';
import { SceneryCollider } from '../sim/collision.ts';
import { WorldGround } from '../sim/ground.ts';
import { RuleMonitor } from '../sim/rules.ts';
import type { PlayerSnapshot } from '../sim/rules.ts';
import { SignalSystem } from '../sim/signals.ts';
import { Traffic } from '../sim/traffic.ts';
import type { PlayerState } from '../sim/traffic.ts';
import { COMPACT_CAR, COMPACT_CAR_AUTOCLUTCH, COMPACT_CAR_AUTOMATIC, Vehicle } from '../sim/vehicle/index.ts';
import type { DriverInput } from '../sim/vehicle/index.ts';
import { SignalRenderer, TrafficRenderer } from '../render/actors.ts';
import { PlayerCar } from '../render/car.ts';
import type { CarVisualState } from '../render/car.ts';
import { PropRenderer } from '../render/props.ts';
import { SignRenderer } from '../render/signs.ts';
import type { LoadedTile } from '../render/tiles.ts';
import { latLonToWorld, worldToLatLon } from '../geo/utm.ts';
import { AddressIndex, findRoadSpot, mainNetwork } from './address.ts';
import type { AddressHit, AddressJson } from './address.ts';
import { Hud } from '../ui/hud.ts';
import type { HudState } from '../ui/hud.ts';
import { tr } from '../ui/i18n.ts';
import { RealityPanel } from '../ui/reality.ts';
import { LaneGraph } from '../world/lanes.ts';
import type { Lane } from '../world/lanes.ts';
import { CTRL, SURF_ROLLING } from '../world/types.ts';
import type { SpawnJson } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { Edge } from '../world/world.ts';
import { App } from './app.ts';
import { LESSONS, Navigator, findTarget } from './nav.ts';
import type { LessonDef } from './nav.ts';
import { loadSettings, saveSettings } from './settings.ts';
import type { Settings } from './settings.ts';

type State = 'loading' | 'menu' | 'intro' | 'placing' | 'drive' | 'pause' | 'reality' | 'result';
type CameraMode = 'cockpit' | 'chase' | 'free';

const PHYS_DT = 1 / 240;

export class Game {
  readonly app: App;
  readonly ui: HTMLElement;
  readonly settings: Settings = loadSettings();
  lanes!: LaneGraph;
  signals!: SignalSystem;
  traffic!: Traffic;
  rules!: RuleMonitor;
  nav!: Navigator;
  hud!: Hud;
  input!: Input;
  vehicle!: Vehicle;
  ground!: WorldGround;
  readonly props = new PropRenderer();
  signs!: SignRenderer;
  readonly car = new PlayerCar();
  readonly actors = new TrafficRenderer();
  signalHeads!: SignalRenderer;
  readonly collider = new SceneryCollider();
  readonly audio = new GameAudio();
  state: State = 'loading';
  cameraMode: CameraMode = 'cockpit';

  private last = 0;
  private time = 0;
  private acc = 0;
  private frames = 0;
  private mirrorTurn = 0;
  private spawn: SpawnJson | null = null;
  private lesson: LessonDef | null = null;
  private targetIdx = 0;
  private homeEdge: Edge | null = null;
  private readonly visited = new Set<Edge>();
  private basicsStep = 0;
  private startOdo = 0;
  private startTime = 0;
  private grindT = 0;
  private failT = -1;
  private lastGood = { x: 0, y: 0, z: 0, yaw: 0, t: 0 };
  private lastNavSpoken = '';
  private impact = 0;
  private rolledT = 0;
  private readonly hit = newSurfaceHit();
  private readonly mpos = new Float64Array(3);
  private readonly wheelY = [0.316, 0.316, 0.316, 0.316];
  private readonly free = { pos: new THREE.Vector3(0, 3, 8), yaw: 0, pitch: -0.2 };
  private freeRelative = true;
  private readonly keys = new Set<string>();
  private readonly driver: DriverInput = { steer: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 1, gear: 0, ignition: true, starter: false };
  private autoDrive = 0;
  private tipText = '';
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly eyeWorld = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement) {
    this.app = new App(canvas);
    this.ui = ui;
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  async boot(q: URLSearchParams): Promise<void> {
    const app = this.app;
    const lang = this.settings.lang;
    // a first, world-less HUD only for the loading screen
    const loading = document.createElement('div');
    loading.className = 'overlay solid';
    loading.innerHTML = `<div class="panel narrow"><h1>Fahrsim <span>Baunatal</span></h1><p>${tr('loading', lang)}</p><div class="progress"><i></i></div></div>`;
    this.ui.append(loading);
    await app.loadWorld();
    const world = app.world;
    this.lanes = new LaneGraph(world);
    this.signals = new SignalSystem(world.signals);
    this.traffic = new Traffic(world, this.lanes, this.signals);
    this.rules = new RuleMonitor(world, this.lanes, this.signals, this.traffic);
    this.nav = new Navigator(this.lanes);
    this.ground = new WorldGround(world, app.tiles);
    this.signs = new SignRenderer(new URL('signs/', document.baseURI).href, app.renderer.capabilities.getMaxAnisotropy());
    await this.signs.init();
    this.signalHeads = new SignalRenderer(world);
    this.collider.add({ key: 'signals', rings: null, ringCounts: null, segments: null, discs: this.signalHeads.poles });
    app.tiles.onTile((tile, loaded) => this.onTile(tile, loaded));
    app.scene.add(this.car.root, this.actors.group, this.signalHeads.group);
    this.car.root.visible = false;
    loading.remove();

    this.hud = new Hud(this.ui, this.settings, world);
    this.input = new Input(app.canvas, this.settings);
    this.input.onAction((a) => this.onAction(a));
    this.hud.onStart = (req) => this.begin(req.mode, req.spawn, false, req.address);
    this.hud.onResume = () => this.resume();
    this.hud.onReality = () => this.openReality();
    this.hud.onPause = () => this.pause();
    this.hud.loadAddresses = () => this.loadAddresses();
    this.hud.onTeleport = (hit) => this.teleportTo(hit);
    this.reality = new RealityPanel(this.ui, {
      settings: this.settings,
      saveSettings: () => saveSettings(this.settings),
      close: () => this.closeReality(),
      plausible: (lat, lon) => {
        const [x, z] = latLonToWorld(lat, lon);
        const m = world.json.meta;
        return x > m.minX - 500 && x < m.maxX + 500 && z > m.minZ - 500 && z < m.maxZ + 500;
      },
      maxTexture: app.renderer.capabilities.maxTextureSize,
    });
    this.hud.onQuit = () => this.toMenu();
    this.hud.onSettingsChanged = () => this.applySettings();
    this.rules.onViolation = (v) => {
      this.hud.toast(v);
      this.audio.click('chime');
      if (v.severity === 'fail' && this.lesson?.kind === 'exam' && this.failT < 0) this.failT = this.time + 2.5;
    };
    this.hud.attachInput(this.input);
    // test overrides (not saved): ?quality=low|medium|high&mirrors=off|alternate|full&traffic=0..1
    const qq = q.get('quality');
    if (qq === 'low' || qq === 'medium' || qq === 'high') this.settings.quality = qq;
    const qm = q.get('mirrors');
    if (qm === 'off' || qm === 'alternate' || qm === 'full') this.settings.mirrors = qm;
    if (q.get('traffic')) this.settings.traffic = Number(q.get('traffic'));
    this.applySettings();

    // developer / test shortcuts: ?start=<mode>&spawn=<n>&view=chase&auto=<throttle>&cam=x,y,z,yaw,pitch&look=yaw,pitch
    const view = q.get('view');
    if (view === 'chase' || view === 'cockpit' || view === 'free') this.cameraMode = view;
    const cam = q.get('cam');
    if (cam) {
      const c = cam.split(',').map(Number);
      this.cameraMode = 'free';
      this.free.pos.set(c[0], c[1], c[2]);
      this.free.yaw = ((c[3] ?? 0) * Math.PI) / 180;
      this.free.pitch = ((c[4] ?? -15) * Math.PI) / 180;
    }
    this.autoDrive = Number(q.get('auto') ?? 0);
    // ?reality=1|test opens the reality view once the drive has started ("test": with a drawn panorama),
    // ?rv=panoramax,kartaview switches services on for this visit
    this.autoReality = q.get('reality') ?? '';
    // ?notice=red|yellow|both shows sample notices, ?touch=on|off forces the on-screen controls,
    // ?addr=<street and number> starts at that address
    this.autoNotice = q.get('notice') ?? '';
    const tc = q.get('touch');
    if (tc === 'on' || tc === 'off' || tc === 'auto') this.settings.touchControls = tc;
    for (const s of (q.get('rv') ?? '').split(',')) {
      if (s === 'panoramax' || s === 'kartaview' || s === 'mapillary') this.settings.reality[s] = true;
    }
    const look = q.get('look');
    if (look) {
      const l = look.split(',').map(Number);
      this.input.c.lookYaw = ((l[0] ?? 0) * Math.PI) / 180;
      this.debugLook = [((l[0] ?? 0) * Math.PI) / 180, ((l[1] ?? 0) * Math.PI) / 180];
    }
    const at = q.get('at');
    if (at) {
      const p = at.split(',').map(Number);
      world.json.spawns.unshift({ name: 'Test', x: p[0], z: p[1], yaw: ((p[2] ?? 0) * Math.PI) / 180, kind: 'street' });
    }
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    const start = q.get('start');
    const addr = q.get('addr');
    if (start && addr) {
      void this.loadAddresses().then((ix) => this.begin(start, Number(q.get('spawn') ?? 0), true, ix?.search(addr, 1)[0]));
    } else if (start) this.begin(start, Number(q.get('spawn') ?? 0), true);
    else this.toMenu();
  }

  private debugLook: [number, number] | null = null;
  private inputMode: 'touch' | 'keys' = 'keys';
  private addressIndex: Promise<AddressIndex | null> | null = null;
  private mainLanes: Set<number> | null = null;
  private autoReality = '';
  private autoNotice = '';
  private realityFrames = 0;
  private reality!: RealityPanel;

  private onTile(tile: LoadedTile, loaded: boolean): void {
    if (loaded) {
      this.props.add(tile);
      this.signs.add(tile);
      const discs: number[] = [];
      for (const s of tile.header.signs) discs.push(s.x, s.y, s.z, 0.06);
      for (const o of tile.header.objects) if (o.k === 'lamp') discs.push(o.x, o.y, o.z, 0.09);
      const trees = tile.data.get('trees') as Float32Array | null;
      if (trees) {
        // only real trunks, and only where a car can plausibly get to
        for (let i = 0; i < trees.length; i += 5) {
          const kind = trees[i + 4];
          if (kind === 2) continue;
          discs.push(trees[i], trees[i + 1], trees[i + 2], kind === 3 ? 0.12 : 0.22);
        }
      }
      this.collider.add({
        key: tile.key,
        rings: tile.data.get('collPts') as Float32Array | null,
        ringCounts: tile.data.get('collCnt') as Uint16Array | null,
        segments: tile.data.get('collSeg') as Float32Array | null,
        discs,
      });
    } else {
      this.props.remove(tile);
      this.signs.remove(tile);
      this.collider.remove(tile.key);
    }
  }

  private applySettings(): void {
    const s = this.settings;
    const app = this.app;
    const q = s.quality;
    app.pixelRatioCap = q === 'low' ? 1 : q === 'medium' ? 1.5 : 2;
    app.tiles.viewRadius = q === 'low' ? 850 : q === 'medium' ? 1250 : 1700;
    app.sky.fog.near = app.tiles.viewRadius * 0.3;
    app.sky.fog.far = app.tiles.viewRadius * 1.05;
    this.props.density = q === 'low' ? 0.45 : q === 'medium' ? 0.8 : 1;
    app.resize();
    for (const m of this.car.mirrors) m.setEnabled(s.mirrors !== 'off');
    this.audio.setVolume(s.volume);
    if (this.traffic) this.traffic.targetCount = Math.round(s.traffic * 34);
  }

  // ------------------------------------------------------------------- flow
  private toMenu(): void {
    this.state = 'menu';
    this.input.enabled = false;
    this.hud.setHudVisible(false);
    this.audio.suspend();
    this.hud.showMenu(this.app.world.json.spawns, this.spawn ? this.app.world.json.spawns.indexOf(this.spawn) : 0);
    if (!this.spawn) {
      // show the town behind the menu
      const sp = this.app.world.json.spawns[0];
      if (sp) this.menuFocus.set(sp.x, 0, sp.z);
    }
  }

  private readonly menuFocus = new THREE.Vector3();

  /** The address list (house numbers of the map), fetched when somebody first searches. */
  private loadAddresses(): Promise<AddressIndex | null> {
    this.addressIndex ??= fetch(`${this.app.baseUrl}addresses.json`)
      .then(async (res) => (res.ok ? new AddressIndex((await res.json()) as AddressJson) : null))
      .catch(() => null);
    return this.addressIndex;
  }

  /** The spot on the road in front of an address, as a starting point. */
  private spawnAt(hit: AddressHit): SpawnJson | null {
    this.mainLanes ??= mainNetwork(this.app.world, this.lanes);
    const spot = findRoadSpot(this.app.world, this.lanes, hit.x, hit.z, hit.street, 220, this.mainLanes);
    return spot ? { ...spot, name: hit.label } : null;
  }

  /** Free drive: jump to an address (from the pause menu). */
  private teleportTo(hit: AddressHit): void {
    if (this.state !== 'pause' || this.lesson) return;
    const spot = this.spawnAt(hit);
    if (!spot) {
      this.hud.showPause();
      this.hud.message(tr('addressNoRoad', this.settings.lang), hit.label);
      return;
    }
    this.spawn = spot;
    this.traffic.clear();
    this.vehicle.vel.fill(0);
    this.vehicle.angVel.fill(0);
    this.input.c.handbrake = 1;
    this.state = 'placing';
    this.car.root.visible = false;
    this.hud.showLoading(tr('loadingTiles', this.settings.lang));
  }

  private begin(mode: string, spawnIdx: number, skipIntro = false, address?: AddressHit): void {
    const world = this.app.world;
    this.audio.start();
    this.spawn = (address ? this.spawnAt(address) : null) ?? world.json.spawns[Math.max(0, Math.min(world.json.spawns.length - 1, spawnIdx))] ?? { name: '', x: 0, z: 0, yaw: 0, kind: 'street' };
    this.lesson = LESSONS.find((l) => l.id === mode) ?? null;
    this.hud.canTeleport = !this.lesson;
    const spec = this.settings.transmission === 'automatic' ? COMPACT_CAR_AUTOMATIC : this.settings.transmission === 'assist' ? COMPACT_CAR_AUTOCLUTCH : COMPACT_CAR;
    this.vehicle = new Vehicle(spec, this.ground);
    this.input.setAutomatic(spec.transmission === 'automatic');
    const c = this.input.c;
    c.handbrake = 1;
    c.ignition = true;
    c.indicator = 0;
    c.hazard = false;
    // the basics lesson starts with a cold car; everything else is ready to go
    const cold = this.lesson?.kind === 'basics';
    c.seatbelt = !cold;
    this.vehicle.resetDrivetrain(!cold);
    this.rules.reset();
    this.hud.clearNotices();
    this.rules.strict = this.lesson?.kind === 'exam';
    this.traffic.clear();
    this.nav.clear();
    this.targetIdx = 0;
    this.basicsStep = 0;
    this.visited.clear();
    this.failT = -1;
    this.homeEdge = null;
    this.state = 'placing';
    this.car.root.visible = false;
    this.hud.showLoading(tr('loadingTiles', this.settings.lang));
    const li = this.settings.lang === 'de' ? 0 : 1;
    this.pendingIntro = this.lesson && !skipIntro ? { title: this.lesson.title[li], text: this.lesson.intro[li] } : null;
  }

  private pendingIntro: { title: string; text: string } | null = null;

  /** Called every frame while waiting for the terrain under the start point. */
  private tryPlace(): void {
    const sp = this.spawn!;
    const ty = this.app.tiles.heightAt(sp.x, sp.z);
    if (Number.isNaN(ty) || !this.app.tiles.settled) return;
    const y = this.app.world.surfaceAt(sp.x, sp.z, ty + 3, this.hit) ? this.hit.y : ty;
    this.vehicle.teleport(sp.x, y + 0.02, sp.z, sp.yaw);
    this.lastGood = { x: sp.x, y, z: sp.z, yaw: sp.yaw, t: 0 };
    this.car.root.visible = true;
    this.startOdo = this.vehicle.odometer;
    this.startTime = this.time;
    if (this.pendingIntro) {
      this.state = 'intro';
      const intro = this.pendingIntro;
      this.pendingIntro = null;
      this.hud.showIntro(intro.title, intro.text, () => this.resume());
    } else this.resume();
  }

  private resume(): void {
    this.hud.hideOverlay();
    this.hud.setHudVisible(true);
    this.input.enabled = true;
    this.audio.start();
    this.state = 'drive';
    this.app.canvas.focus();
  }

  private pause(): void {
    if (this.state !== 'drive') return;
    this.state = 'pause';
    this.input.enabled = false;
    this.audio.suspend();
    this.hud.showPause();
  }

  private finish(): void {
    const l = this.lesson;
    const exam = l?.kind === 'exam';
    const failed = this.rules.failed || this.rules.points >= 10;
    this.state = 'result';
    this.input.enabled = false;
    this.audio.suspend();
    this.hud.setHudVisible(false);
    const li = this.settings.lang === 'de' ? 0 : 1;
    this.hud.showResult({
      title: l ? l.title[li] : tr('free', this.settings.lang),
      exam: !!exam,
      passed: !failed,
      log: this.rules.log.slice(),
      points: this.rules.points,
      distanceKm: (this.vehicle.odometer - this.startOdo) / 1000,
      minutes: (this.time - this.startTime) / 60,
    });
  }

  // ---------------------------------------------------------- reality view
  /** Real photographs of where the car is (own files and free imagery services). */
  private openReality(): void {
    if (this.state !== 'drive' && this.state !== 'pause') return;
    this.state = 'reality';
    this.input.enabled = false;
    this.audio.suspend();
    this.hud.hideOverlay();
    this.hud.setHudVisible(false);
    this.vehicle.getModelPosition(this.mpos);
    const [lat, lon] = worldToLatLon(this.mpos[0], this.mpos[2]);
    // yaw: 0 = north, positive = to the left; a compass counts clockwise
    const heading = (((-this.vehicle.yaw * 180) / Math.PI) % 360 + 360) % 360;
    this.reality.open({ lat, lon, heading, name: this.rules.context.roadName });
  }

  private closeReality(): void {
    if (this.state !== 'reality') return;
    this.reality.close();
    this.state = 'pause';
    this.hud.setHudVisible(true);
    this.hud.showPause();
  }

  private onAction(a: Action): void {
    if (a === 'reality') {
      if (this.state === 'reality') this.closeReality();
      else this.openReality();
    } else if (a === 'pause') {
      if (this.state === 'drive') this.pause();
      else if (this.state === 'pause') this.resume();
      else if (this.state === 'reality') this.closeReality();
    } else if (a === 'view' && this.state === 'drive') {
      this.cameraMode = this.cameraMode === 'cockpit' ? 'chase' : 'cockpit';
    } else if (a === 'reset' && this.state === 'drive') {
      this.resetToRoad();
    } else if (a === 'help') {
      if (this.state === 'drive') {
        this.state = 'pause';
        this.input.enabled = false;
        this.hud.showControls(() => this.resume());
      }
    } else if (a === 'map' && this.state === 'drive' && !this.lesson) {
      this.finish();
    }
  }

  private resetToRoad(): void {
    const g = this.lastGood;
    this.vehicle.teleport(g.x, g.y + 0.05, g.z, g.yaw);
    this.input.c.handbrake = 1;
  }

  // ------------------------------------------------------------- simulation
  private stepDrive(dt: number): void {
    const v = this.vehicle;
    const c = this.input.update(dt, v.speed, v.steerTorque);
    if (this.debugLook) {
      c.lookYaw = this.debugLook[0];
      c.lookPitch = this.debugLook[1];
    }
    const d = this.driver;
    d.steer = c.steer;
    d.throttle = c.throttle;
    d.brake = c.brake;
    d.clutch = c.clutch;
    d.handbrake = c.handbrake;
    d.gear = c.gear;
    d.ignition = c.ignition;
    d.starter = c.starter;
    if (this.autoDrive > 0) {
      // test hook: drive off by itself
      d.ignition = true;
      d.handbrake = 0;
      c.handbrake = 0;
      d.gear = 1;
      c.gear = 1;
      d.throttle = this.autoDrive;
    }

    this.acc = Math.min(this.acc + dt, 0.1);
    let stalled = false;
    let grind = false;
    while (this.acc >= PHYS_DT) {
      v.step(PHYS_DT, d);
      this.acc -= PHYS_DT;
      if (v.stalledEvent) stalled = true;
      if (v.gearGrind) grind = true;
      const hit = this.collider.resolve(v);
      if (hit > this.impact) this.impact = hit;
    }
    // a refused gear change: crunch, then the lever springs back
    if (grind) {
      if (this.grindT <= 0) this.audio.click('grind');
      this.grindT += dt;
      if (this.grindT > 0.35) {
        c.gear = v.gear;
        this.grindT = 0;
      }
      this.tipText = tr('pressClutch', this.settings.lang);
      this.tipUntil = this.time + 2.5;
    } else this.grindT = 0;
    if (this.settings.transmission === 'automatic') {
      /* selector position is what the driver chose */
    }

    v.getModelPosition(this.mpos);
    const player: PlayerState = { x: this.mpos[0], y: this.mpos[1], z: this.mpos[2], yaw: v.yaw, speed: v.speed, length: 4.28, width: 1.79 };
    this.signals.update(dt);
    this.traffic.update(dt, player);
    for (const ev of this.traffic.events) {
      if (ev.type === 'collision') {
        // shove the cars apart and kill most of the closing speed
        const dx = player.x - ev.car.x;
        const dz = player.z - ev.car.z;
        const l = Math.hypot(dx, dz) || 1;
        v.translate((dx / l) * 0.25, 0, (dz / l) * 0.25);
        const vn = v.vel[0] * (dx / l) + v.vel[2] * (dz / l);
        if (vn < 0) v.applyImpulse(v.pos[0], v.pos[1], v.pos[2], -(dx / l) * vn * v.spec.mass * 1.2, 0, -(dz / l) * vn * v.spec.mass * 1.2);
        this.audio.click('crash');
      }
    }
    // on its side or roof: that is the end of this drive – count it as a crash and start again on the road
    if (v.upright < 0.35) {
      this.rolledT += dt;
      if (this.rolledT > 2.2 && Math.abs(v.speed) < 5) {
        this.rolledT = 0;
        this.impact = Math.max(this.impact, 12);
        this.resetToRoad();
        this.tipText = tr('rolledOver', this.settings.lang);
        this.tipUntil = this.time + 6;
      }
    } else this.rolledT = 0;
    const impact = this.impact;
    if (impact > 1.2) this.audio.click(impact > 4 ? 'crash' : 'bump');
    this.impact = 0;

    const snap: PlayerSnapshot = {
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: v.yaw,
      speed: v.speed,
      indicator: c.indicator,
      hazard: c.hazard,
      lookYaw: c.lookYaw,
      seatbelt: c.seatbelt,
      handbrake: c.handbrake,
      stalled,
      hitScenery: impact,
      length: 4.28,
    };
    this.rules.update(dt, snap, this.traffic.events);
    this.rememberGoodSpot(player);
    this.updateLesson(dt, player);
    if (this.failT > 0 && this.time > this.failT) this.finish();
  }

  private tipUntil = 0;

  private rememberGoodSpot(p: PlayerState): void {
    const ctx = this.rules.context;
    const lane = this.currentLane();
    if (ctx.onRoad && lane && Math.abs(p.speed) < 40 && !ctx.wrongWay && this.time - this.lastGood.t > 1.5) {
      this.lastGood = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, t: this.time };
    }
    // fell off the world or wandered beyond the map: back to the last good place
    if (Number.isNaN(this.app.tiles.heightAt(p.x, p.z)) || p.y < this.lastGood.y - 60) this.resetToRoad();
  }

  private currentLane(): Lane | null {
    return (this.rules as unknown as { lane: Lane | null }).lane;
  }

  private laneFront(): number {
    return (this.rules as unknown as { laneS: number }).laneS;
  }

  private updateLesson(dt: number, p: PlayerState): void {
    const l = this.lesson;
    const lane = this.currentLane();
    const v = this.vehicle;
    const lang = this.settings.lang;
    if (!l) return;
    if (l.kind === 'basics') {
      const c = this.input.c;
      const auto = v.spec.transmission === 'automatic';
      const de = lang === 'de';
      const steps: Array<[string, () => boolean]> = [
        [de ? 'Anschnallen: B drücken' : 'Fasten your seat belt: press B', () => c.seatbelt],
        [de ? (auto ? 'Bremse treten (S) und Motor starten: Enter halten' : 'Motor starten: Enter halten (Gang raus oder Kupplung treten)') : auto ? 'Hold the brake (S) and start the engine: hold Enter' : 'Start the engine: hold Enter (neutral or clutch pressed)', () => v.engineRunning],
        [de ? (auto ? 'Wählhebel auf D: E drücken' : '1. Gang einlegen: Taste 1 (Kupplung treten, falls ohne Kupplungshilfe)') : auto ? 'Select D: press E' : 'Select 1st gear: key 1 (press the clutch if you drive without assist)', () => (auto ? c.gear === 1 : v.gear === 1)],
        [de ? 'Handbremse lösen: Leertaste' : 'Release the handbrake: Space', () => c.handbrake < 0.5],
        [de ? 'Sanft anfahren: etwas Gas (W), bis 15 km/h' : 'Pull away gently: a little throttle (W) up to 15 km/h', () => v.speed * 3.6 > 15],
        [de ? (auto ? 'Weiter beschleunigen bis 30 km/h' : 'In den 2. Gang schalten (E) und bis 30 km/h beschleunigen') : auto ? 'Accelerate to 30 km/h' : 'Change up to 2nd (E) and accelerate to 30 km/h', () => v.speed * 3.6 > 30 && (auto || v.gear >= 2)],
        [de ? 'Bis zum Stillstand bremsen (S)' : 'Brake to a standstill (S)', () => Math.abs(v.speed) < 0.1],
        [de ? (auto ? 'Rückwärtsgang: R – und ein Stück zurücksetzen' : 'Rückwärtsgang: R – und ein Stück zurücksetzen') : 'Reverse gear: R – and back up a little', () => v.speed < -1],
        [de ? 'Anhalten und Handbremse anziehen (Leertaste)' : 'Stop and apply the handbrake (Space)', () => Math.abs(v.speed) < 0.1 && c.handbrake > 0.5],
      ];
      if (this.basicsStep < steps.length && steps[this.basicsStep][1]()) {
        this.basicsStep++;
        this.audio.click('chime');
      }
      if (this.basicsStep >= steps.length) {
        this.finish();
        return;
      }
      this.lessonLine = `${this.basicsStep + 1}/${steps.length} · ${steps[this.basicsStep][0]}`;
      return;
    }
    // routed lessons and the exam
    if (!lane) return;
    if (!this.homeEdge) this.homeEdge = lane.edge;
    if (!this.nav.goal) {
      const type = l.targets[this.targetIdx];
      const goal = findTarget(this.app.world, this.lanes, type, p.x, p.z, lane, this.homeEdge, this.visited);
      if (!goal) {
        // nothing suitable in reach: skip this part
        this.targetIdx++;
        if (this.targetIdx >= l.targets.length) {
          if (this.visited.size === 0 && this.time - this.startTime < 20) {
            // not a single destination from this starting point: drive freely instead of ending at once
            this.lesson = null;
            this.hud.canTeleport = true;
            this.hud.message(tr('lessonNoRoute', lang));
          } else this.finish();
        }
        return;
      }
      this.visited.add(goal);
      this.nav.setGoal(goal, lane);
      this.hud.routeLanes = this.nav.routeLanes;
    }
    const h = this.nav.update(dt, lane, this.laneFront(), p.x, p.z);
    if (this.hud.routeLanes !== this.nav.routeLanes) {
      this.hud.routeLanes = this.nav.routeLanes;
      this.rules.allowed = new Set(this.nav.routeLanes.map((l) => l.edge));
    }
    if (h.done) {
      this.targetIdx++;
      this.nav.clear();
      this.audio.click('chime');
      if (this.targetIdx >= l.targets.length) this.finish();
    }
    this.lessonLine = `${l.title[lang === 'de' ? 0 : 1]} · ${this.targetIdx + 1}/${l.targets.length}`;
  }

  private lessonLine = '';

  // ------------------------------------------------------------------ frame
  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.frames++;
    const app = this.app;
    const tiles = app.tiles;

    if (this.state === 'placing') {
      tiles.update(this.spawn!.x, this.spawn!.z);
      this.tryPlace();
    } else if (this.state === 'drive') {
      // fingers or keys: follows what the driver last used, unless the settings say otherwise
      const want = this.settings.touchControls;
      this.inputMode = want === 'on' ? 'touch' : want === 'off' ? 'keys' : this.input.mode;
      this.hud.setInputMode(this.inputMode);
      this.stepDrive(dt);
      if (this.autoNotice && this.time - this.startTime > 0.3) {
        const kind = this.autoNotice;
        this.autoNotice = '';
        // (they stay: the automated check may take minutes for a frame)
        const show = (id: string, severity: 'fail' | 'minor', data: Record<string, number> = {}): void => this.hud.toast({ id, severity, time: this.time, x: 0, z: 0, data }, 3600);
        if (kind !== 'yellow') show('redLight', 'fail');
        if (kind !== 'red') show('speed', 'minor', { limit: 30, speed: 42 });
      }
      if (this.autoReality && this.time - this.startTime > 0.3) {
        const mode = this.autoReality;
        this.autoReality = '';
        this.openReality();
        if (mode === 'test') {
          void import('../reality/testpano.ts').then(async (m) => {
            const [lat, lon] = worldToLatLon(this.mpos[0], this.mpos[2]);
            // drawn as if taken looking north-east, a few metres from the car
            await this.reality.importFiles([await m.makeTestPanorama(lat + 0.00004, lon, 45)]);
          });
        }
      }
    }

    const haveCar = this.vehicle && this.car.root.visible;
    if (haveCar) {
      const v = this.vehicle;
      v.getModelPosition(this.mpos);
      this.car.root.position.set(this.mpos[0], this.mpos[1], this.mpos[2]);
      this.car.root.quaternion.set(v.quat[0], v.quat[1], v.quat[2], v.quat[3]);
      this.car.root.updateMatrixWorld(true);
      tiles.update(this.mpos[0], this.mpos[2]);
      this.props.update(this.mpos[0], this.mpos[2]);
      this.updateVisuals(dt);
    } else if (this.state === 'menu' || this.state === 'loading') {
      // slow fly-over behind the menu
      const a = this.time * 0.05;
      const cx = this.menuFocus.x + Math.cos(a) * 260;
      const cz = this.menuFocus.z + Math.sin(a) * 260;
      tiles.update(this.menuFocus.x, this.menuFocus.z);
      this.props.update(cx, cz);
      const gy = tiles.heightAt(this.menuFocus.x, this.menuFocus.z);
      const base = Number.isNaN(gy) ? 230 : gy;
      app.camera.position.set(cx, base + 95, cz);
      app.camera.lookAt(this.menuFocus.x, base + 10, this.menuFocus.z);
      app.camera.fov = 55;
      app.camera.near = 0.5;
      app.camera.updateProjectionMatrix();
      this.signals.update(dt);
    }
    this.signs.flush();
    this.signalHeads.update(this.signals);
    this.actors.update(this.traffic.cars, this.traffic.peds, this.time);

    if (this.state === 'reality') {
      // the panel covers the window: only a 360° panorama is drawn, not the world behind it
      this.reality.render(app.renderer, app.canvas);
    } else if (haveCar) {
      this.updateCamera(dt);
      const mode = this.settings.mirrors;
      if (this.cameraMode === 'cockpit' && mode !== 'off') {
        const mirrors = this.car.mirrors;
        const far = Math.min(450, app.tiles.viewRadius * 0.4);
        if (mode === 'full' || this.frames < 4) for (const m of mirrors) m.render(app.renderer, app.scene, this.car.root.matrixWorld, this.eyeWorld, far);
        else mirrors[this.mirrorTurn++ % mirrors.length].render(app.renderer, app.scene, this.car.root.matrixWorld, this.eyeWorld, far);
      }
      app.render(this.car.root.position);
    } else {
      app.render(this.menuFocus);
    }
    if (this.state === 'reality') {
      // for the automated check: the page counts as ready once a picture shows (or nothing will come)
      this.realityFrames++;
      if (window.__fs && !window.__fs.ready) {
        const info = this.reality.debugInfo();
        if (info.panoActive === true || (info.current !== null && this.realityFrames > 6) || this.realityFrames > 60) window.__fs.ready = true;
      }
    } else this.realityFrames = 0;
    if (window.__fs && !window.__fs.ready && tiles.settled && this.frames > 6 && (this.state === 'drive' || this.state === 'menu' || this.state === 'intro')) {
      if (this.autoReality) {
        /* the reality view is about to open */
      } else if (this.state !== 'drive' || this.time - this.startTime > Number(new URLSearchParams(location.search).get('wait') ?? 0)) window.__fs.ready = true;
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  private readonly visual: CarVisualState = {
    speedKmh: 0,
    rpm: 0,
    gear: 0,
    indicator: 0,
    hazard: false,
    blinkOn: false,
    lowBeam: false,
    highBeam: false,
    handbrake: true,
    ignition: true,
    engineRunning: false,
    abs: false,
    seatbelt: true,
    fuel: 0.82,
    automatic: false,
    showGear: true,
    odometerKm: 0,
    steerWheel: 0,
    wheelSteer: [0, 0, 0, 0],
    wheelSpin: [0, 0, 0, 0],
    wheelY: [0.316, 0.316, 0.316, 0.316],
    clutch: 0,
    brake: 0,
    throttle: 0,
    handbrakeLever: 1,
    braking: false,
    reversing: false,
  };

  private updateVisuals(dt: number): void {
    const v = this.vehicle;
    const c = this.input.c;
    const s = this.visual;
    const kmh = v.speed * 3.6;
    s.speedKmh = Math.abs(kmh);
    s.rpm = v.rpm;
    s.gear = v.spec.transmission === 'automatic' ? (c.gear === 1 ? v.gear : c.gear) : v.gear;
    s.indicator = c.indicator;
    s.hazard = c.hazard;
    s.blinkOn = Math.floor(this.time * 3) % 2 === 0;
    s.lowBeam = c.lowBeam;
    s.highBeam = c.highBeam;
    s.handbrake = c.handbrake > 0.5;
    s.ignition = c.ignition;
    s.engineRunning = v.engineRunning;
    s.abs = v.absActive;
    s.seatbelt = c.seatbelt;
    s.automatic = v.spec.transmission === 'automatic';
    s.showGear = this.settings.hudGear;
    s.odometerKm = v.odometer / 1000;
    s.steerWheel = v.steerWheelAngle;
    v.getWheelHeights(this.wheelY);
    for (let i = 0; i < 4; i++) {
      s.wheelSteer[i] = v.wheels[i].steer;
      s.wheelSpin[i] = v.wheels[i].spin;
      s.wheelY[i] = this.wheelY[i];
    }
    s.clutch = v.clutchPedal;
    s.brake = c.brake;
    s.throttle = c.throttle;
    s.handbrakeLever = c.handbrake;
    s.braking = c.brake > 0.03;
    s.reversing = v.gear === -1;
    this.car.update(s, dt, this.time);

    // sound
    let skid = 0;
    let rough = 1;
    for (const w of v.wheels) {
      skid = Math.max(skid, w.skid);
      rough = Math.max(rough, w.grip < 0.75 ? 2.4 : 1);
    }
    void SURF_ROLLING;
    this.audio.update({
      rpm: v.rpm,
      load: v.engineLoad,
      engineRunning: v.engineRunning,
      starter: c.starter,
      speed: v.speed,
      skid,
      indicatorOn: (c.indicator !== 0 || c.hazard) && this.state === 'drive',
      blinkOn: s.blinkOn,
      horn: c.horn,
      rough,
    });

    // HUD
    if (this.state !== 'drive') return;
    const lang = this.settings.lang;
    const ctx = this.rules.context;
    const h = this.nav.hint;
    let navText = '';
    if (this.nav.goal && this.lesson && this.lesson.kind !== 'basics') {
      const what = h.what === 'navRoundabout' ? tr('navRoundabout', lang, { n: h.n }) : tr(h.what, lang);
      if (h.what === 'navFollow' || h.dist < 0) navText = tr('navFollow', lang);
      else if (h.dist < 35) navText = tr('navNow', lang, { what });
      else navText = tr('navIn', lang, { d: Math.round(h.dist / 10) * 10, what });
      this.speak(h.what, h.dist, navText);
      // § 9 StVO: get in lane in good time – the route goes on from a particular lane
      if (h.lane !== 0) navText += ` – ${tr(h.lane < 0 ? 'laneLeft' : 'laneRight', lang)}`;
    } else if (this.lesson?.kind === 'basics') navText = this.lessonLine;
    let tip = this.time < this.tipUntil ? this.tipText : '';
    // on a touch screen the tip says what to tap – and is itself the button for it
    let tipAction = '';
    const touch = this.inputMode === 'touch';
    const say = (key: string, action: string): void => {
      tip = tr(touch ? `${key}Touch` : key, lang);
      tipAction = action;
    };
    if (!tip) {
      if (!v.engineRunning) say(this.rules.log.some((x) => x.id === 'stall' && this.time - x.time < 6) ? 'engineStalled' : 'startEngine', 'Enter');
      else if (!c.seatbelt && Math.abs(kmh) < 5) say('fastenBelt', 'KeyB');
      else if (c.handbrake > 0.5 && c.throttle > 0.1) say('releaseHandbrake', 'Space');
      else if (c.throttle > 0.1 && Math.abs(kmh) < 2 && (s.automatic ? c.gear === -2 || c.gear === 0 : v.gear === 0)) say(s.automatic ? 'selectDrive' : 'selectGear', 'KeyE');
      else {
        const lane = this.currentLane();
        if (lane && lane.to.ctrl === CTRL.MAP_END && lane.len - this.laneFront() < 120) tip = tr('offMap', lang);
        else if (!ctx.onRoad && Math.abs(kmh) < 3 && this.time - this.lastGood.t > 6) say('resetHint', 'KeyT');
      }
    }
    const gearText = s.automatic ? (c.gear === -2 ? 'P' : c.gear === -1 ? 'R' : c.gear === 0 ? 'N' : `D${v.gear}`) : v.gear === -1 ? 'R' : v.gear === 0 ? 'N' : String(v.gear);
    const hs: HudState = {
      speedKmh: kmh,
      rpm: v.rpm,
      gear: gearText,
      limit: ctx.limit,
      zone: ctx.zone,
      junction: ctx.junction,
      navText,
      navSub: this.lesson && this.lesson.kind !== 'basics' ? this.lessonLine : ctx.roadName,
      navArrow: h.arrow,
      navActive: !!this.lesson && h.dist >= 0 && h.what !== 'navFollow' && h.what !== 'routeDone',
      tip,
      tipAction,
      showDash: this.cameraMode !== 'cockpit',
      indicator: c.indicator,
      hazard: c.hazard,
      blinkOn: s.blinkOn,
      handbrake: c.handbrake > 0.5,
      seatbelt: c.seatbelt,
      engineOn: v.engineRunning,
      lights: c.lowBeam,
      points: this.rules.points,
      faults: this.rules.log.filter((x) => x.severity !== 'hint').length,
      x: this.mpos[0],
      z: this.mpos[2],
      yaw: v.yaw,
    };
    if (!navText && !this.lesson) {
      hs.navText = ctx.roadName || (lang === 'de' ? 'Freie Fahrt' : 'Free drive');
      hs.navSub = touch
        ? lang === 'de'
          ? 'Hier tippen: Menü · Karte antippen: echte Fotos'
          : 'Tap here: menu · tap the map: real photos'
        : lang === 'de'
          ? 'M: Fahrt beenden und auswerten · F: echte Fotos dieser Stelle'
          : 'M: end the drive, show the result · F: real photos of this place';
      hs.navArrow = 0;
    }
    this.hud.update(hs, this.time);
  }

  private speak(what: string, dist: number, text: string): void {
    if (!this.settings.voice || !('speechSynthesis' in window)) return;
    // announce each manoeuvre twice: early and right before it
    const stage = dist < 0 ? '' : dist < 45 ? 'now' : dist < 260 ? 'soon' : '';
    const key = `${what}:${stage}:${this.targetIdx}`;
    if (!stage || what === 'navFollow' || key === this.lastNavSpoken) return;
    this.lastNavSpoken = key;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.settings.lang === 'de' ? 'de-DE' : 'en-GB';
    u.volume = this.settings.volume;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  private updateCamera(dt: number): void {
    const cam = this.app.camera;
    const car = this.car.root;
    const v = this.vehicle;
    const c = this.input.c;
    // the eye is always needed for the mirrors
    const lean = this.tmpV.set(-v.accLat * 0.004, 0, v.accLong * 0.005);
    lean.clampLength(0, 0.06);
    this.eyeWorld.copy(this.car.eye).add(lean).applyMatrix4(car.matrixWorld);
    if (this.cameraMode === 'cockpit') {
      cam.near = 0.06;
      cam.fov = 60;
      cam.position.copy(this.eyeWorld);
      // looking over the shoulder also moves the head a little towards that side
      this.tmpQ.setFromEuler(new THREE.Euler(c.lookPitch, c.lookYaw, 0, 'YXZ'));
      cam.quaternion.copy(car.quaternion).multiply(this.tmpQ);
    } else if (this.cameraMode === 'chase') {
      cam.near = 0.3;
      cam.fov = 55;
      const back = this.tmpV.set(Math.sin(c.lookYaw) * 7, 2.6, Math.cos(c.lookYaw) * 7).applyAxisAngle(THREE.Object3D.DEFAULT_UP, v.yaw);
      const target = new THREE.Vector3().copy(car.position).add(back);
      const g = this.app.tiles.heightAt(target.x, target.z);
      if (!Number.isNaN(g)) target.y = Math.max(target.y, g + 1.2);
      cam.position.lerp(target, Math.min(1, dt * 8));
      cam.lookAt(car.position.x, car.position.y + 1.1, car.position.z);
    } else {
      cam.near = 0.2;
      cam.fov = 60;
      const f = this.free;
      const speed = (this.keys.has('ShiftLeft') ? 80 : 12) * dt;
      if (this.keys.has('Numpad8')) f.pos.z -= speed;
      if (this.keys.has('Numpad2')) f.pos.z += speed;
      if (this.keys.has('Numpad4')) f.pos.x -= speed;
      if (this.keys.has('Numpad6')) f.pos.x += speed;
      if (this.freeRelative) {
        cam.position.copy(f.pos).applyQuaternion(car.quaternion).add(car.position);
        this.tmpQ.setFromEuler(new THREE.Euler(f.pitch, f.yaw, 0, 'YXZ'));
        cam.quaternion.copy(car.quaternion).multiply(this.tmpQ);
      }
    }
    cam.updateProjectionMatrix();
  }

  debugInfo(): unknown {
    const v = this.vehicle;
    return {
      state: this.state,
      tiles: this.app.tiles.tiles.size,
      frames: this.frames,
      cars: this.traffic?.cars.length ?? 0,
      kmh: v ? +(v.speed * 3.6).toFixed(1) : 0,
      rpm: v ? Math.round(v.rpm) : 0,
      pos: v ? [...this.mpos].map((x) => +x.toFixed(1)) : null,
      faults: this.rules?.log.map((x) => x.id) ?? [],
      missingSigns: this.signs ? [...this.signs.missing] : [],
      calls: this.app.renderer.info.render.calls,
      tris: this.app.renderer.info.render.triangles,
      reality: this.reality?.debugInfo() ?? null,
    };
  }
}
