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
import { COMPACT_CAR, COMPACT_CAR_AUTOCLUTCH, COMPACT_CAR_AUTOMATIC, TRUCK, Vehicle, withPower } from '../sim/vehicle/index.ts';
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
import { LANGS, formatUnit, isRtl, lessonIntro, lessonTitle, loadLang, localeOf, setKeyStyle, tr } from '../i18n/index.ts';
import { initKeyLabels } from '../i18n/keys.ts';
import { RealityPanel } from '../ui/reality.ts';
import { LaneGraph } from '../world/lanes.ts';
import type { Lane } from '../world/lanes.ts';
import { CLS, CTRL, SURF_ROLLING } from '../world/types.ts';
import type { SpawnJson } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { Edge } from '../world/world.ts';
import { App } from './app.ts';
import { LESSONS, Navigator, findTarget } from './nav.ts';
import type { LessonDef } from './nav.ts';
import { loadSettings, saveSettings } from './settings.ts';
import { FaultLog } from './faultlog.ts';
import { DrivenPath } from './track.ts';
import { BigMap } from '../ui/bigmap.ts';
import { RailTraffic } from '../sim/rail.ts';
import type { RailObstacle } from '../sim/rail.ts';
import { RailActors } from '../render/trams.ts';
import { PlayerTruck } from '../render/truck.ts';
import { YardScene } from '../render/yard.ts';
import { TANDEM_TRAILER, Trailer } from '../sim/trailer.ts';
import { COUPLING_STEPS, MAX_CORRECTIONS, TRAILER_OUTLINE, TRUCK_OUTLINE, YardFrame, offArea } from './ce.ts';
import type { CouplingStepId, TaskId } from './ce.ts';
import { YardTask } from './yardtask.ts';
import { AutoDriver } from '../sim/autodriver.ts';
import type { Settings } from './settings.ts';

type State = 'loading' | 'menu' | 'intro' | 'placing' | 'drive' | 'pause' | 'reality' | 'map' | 'result';
type CameraMode = 'cockpit' | 'chase' | 'free';

const PHYS_DT = 1 / 240;

/** the outlines of the vehicles for collisions with the scenery: circles along the axis (m from the model origin; - = front) */
const CAR_CIRCLES: readonly number[] = [-1.28, -0.05, 1.18];
const TRUCK_CIRCLES: readonly number[] = [-2.5, -0.6, 1.3, 3.2];

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
  /** the truck of the class-CE lessons with its trailer (built when it is first driven) */
  private truck: PlayerTruck | null = null;
  private trailer: Trailer | null = null;
  private isTruck = false;
  /** the practice yard of the truck lessons, and the task that is being done on it */
  private readonly yardScene = new YardScene();
  private yardFrame: YardFrame | null = null;
  private task: { run: YardTask; laid: boolean; order: Map<string, number>; second: boolean } | null = null;
  private tasksLeft: TaskId[] = [];
  private taskCount = 0;
  private taskFailed = false;
  private taskSub = '';
  private laidTry = 0;
  /** where the drive in traffic begins once the tasks on the yard are done */
  private roadSpawn: SpawnJson | null = null;
  /**
   * A demonstration drive: the car drives by itself, by the rules, to the
   * places the player chose – to watch how the way there is driven.
   */
  private demo: { stops: SpawnJson[]; index: number; driver: AutoDriver; active: boolean; look: number; remark: string; takeT: number; lost: number } | null = null;
  /** open the map for planning such a drive as soon as the car stands (start "demo" of the menu) */
  private planDemo = false;
  private camSnap = false;
  private demoHead = 0;
  /** trams and trains on the tracks around the player */
  private rail!: RailTraffic;
  private readonly railActors = new RailActors();
  private readonly railBoxes: PlayerState[] = [];
  private readonly railOthers: RailObstacle[] = [];
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
  /** every fault of this and of earlier sessions */
  private readonly faultLog = new FaultLog();
  /** where the car has been, for the map */
  private readonly path = new DrivenPath();
  private bigMap!: BigMap;
  /** what the map was opened from – closing it leads back there */
  private mapFrom: 'drive' | 'pause' = 'drive';
  /** the car is being put somewhere else in the middle of a drive: distance and time go on */
  private keepClock = false;
  private hbWarned = false;
  private autoMap = '';
  private autoTram = false;
  private autoDemo: number[][] = [];
  private mapFrames = 0;
  private readonly tmpV = new THREE.Vector3();
  private readonly camTarget = new THREE.Vector3();
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
    // ?lang=xx chooses the language for this visit
    const ql = q.get('lang');
    if (ql && LANGS.some((l) => l.code === ql)) this.settings.lang = ql;
    // the texts of the chosen language and the letters of the player's keyboard
    const [ok] = await Promise.all([loadLang(this.settings.lang), initKeyLabels()]);
    if (!ok) this.settings.lang = 'en';
    this.applyLanguage();
    const lang = this.settings.lang;
    // a first, world-less HUD only for the loading screen
    const loading = document.createElement('div');
    loading.className = 'overlay solid';
    const panel = document.createElement('div');
    panel.className = 'panel narrow';
    panel.innerHTML = '<h1>Fahrsim <span>Baunatal</span></h1><p></p><div class="progress"><i></i></div>';
    (panel.querySelector('p') as HTMLElement).textContent = tr('loading', lang);
    loading.append(panel);
    this.ui.append(loading);
    await app.loadWorld();
    const world = app.world;
    await new Promise((r) => setTimeout(r));
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
    app.scene.add(this.car.root, this.actors.group, this.railActors.group, this.signalHeads.group, this.yardScene.group);
    this.yardFrame = world.json.yard ? new YardFrame(world.json.yard) : null;
    this.rail = new RailTraffic(world.json.rails ?? []);
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
      openAerial: () => this.openMap(true),
    });
    this.hud.onQuit = () => this.toMenu();
    this.hud.faultLog = this.faultLog;
    this.hud.onMap = () => this.openMap();
    this.hud.onDemo = () => {
      this.openMap();
      this.bigMap.plan();
    };
    this.hud.onFinish = () => {
      if (this.state === 'pause' && !this.lesson) this.finish();
    };
    this.bigMap = new BigMap({
      world,
      lang: () => this.settings.lang,
      car: () => ({ x: this.mpos[0], z: this.mpos[2], yaw: this.vehicle.yaw }),
      path: this.path,
      spotAt: (x, z) => {
        this.mainLanes ??= mainNetwork(world, this.lanes);
        return findRoadSpot(world, this.lanes, x, z, '', 160, this.mainLanes);
      },
      canTeleport: () => !this.lesson,
      teleport: (spot) => this.teleportSpot(spot),
      loadAddresses: () => this.loadAddresses(),
      spotOf: (hit) => this.spawnAt(hit),
      startDemo: (stops) => this.startDemo(stops),
      latLon: (x, z) => worldToLatLon(x, z),
      aerial: () => this.settings.reality.aerial,
      setAerial: (on) => {
        this.settings.reality.aerial = on;
        saveSettings(this.settings);
      },
      close: () => this.closeMap(),
    });
    // the driven path is written down now and then; make sure the last stretch is, too
    window.addEventListener('pagehide', () => this.path.save());
    this.hud.onSettingsChanged = () => this.applySettings();
    this.rules.onViolation = (v) => {
      this.hud.toast(v);
      this.faultLog.add({ t: Date.now(), id: v.id, severity: v.severity, data: v.data, street: this.rules.context.roadName, mode: this.lesson?.id ?? 'free', x: Math.round(v.x), z: Math.round(v.z) });
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
    // ?vehicle=truck|car chooses the vehicle for this visit
    const qv = q.get('vehicle');
    if (qv === 'truck' || qv === 'car') this.settings.vehicle = qv;
    this.applySettings();

    // developer / test shortcuts: ?start=<mode>&spawn=<n>&view=chase&auto=<throttle>&cam=x,y,z,yaw,pitch&look=yaw,pitch
    const view = q.get('view');
    this.cameraMode = view === 'chase' || view === 'cockpit' || view === 'free' ? view : this.settings.view;
    this.input.resetLook(this.cameraMode === 'chase');
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
    // ?map=1|aerial opens the full-screen map once the drive has started ("aerial": close up, with aerial photographs)
    this.autoMap = q.get('map') ?? '';
    // ?tram=1 puts a tram on the nearest track within 150 m as soon as the drive has started
    this.autoTram = q.get('tram') === '1';
    // ?demo=x,z;x,z starts a demonstration drive to these places of the map once the drive has started
    this.autoDemo = (q.get('demo') ?? '')
      .split(';')
      .filter((p) => p.includes(','))
      .map((p) => p.split(',').map(Number));
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

  /** Language of the page: for the browser (hyphenation, fonts, screen readers) and the writing direction. */
  private applyLanguage(): void {
    const lang = this.settings.lang;
    // the full tag (zh-CN, ja-JP …) also tells the browser which glyphs to take for Han characters
    document.documentElement.lang = localeOf(lang);
    this.ui.dir = isRtl(lang) ? 'rtl' : 'ltr';
    document.title = tr('pageTitle', lang);
  }

  private applySettings(): void {
    const s = this.settings;
    const app = this.app;
    this.applyLanguage();
    const q = s.quality;
    // Low: for weak devices – a softer picture (70 % of the pixels per side), no shadows, a short view.
    // Medium: sharp, shadows around the car.  High: every pixel of the screen, shadows of buildings
    // and trees far around, the longest view, all trees.
    app.pixelRatioCap = q === 'low' ? 1 : q === 'medium' ? 1.5 : 3;
    app.renderScale = q === 'low' ? 0.7 : 1;
    app.setShadows(q === 'low' ? 0 : q === 'medium' ? 1536 : 3072, q === 'high' ? 120 : 55);
    app.tiles.viewRadius = q === 'low' ? 700 : q === 'medium' ? 1250 : 2000;
    app.sky.fog.near = app.tiles.viewRadius * 0.3;
    app.sky.fog.far = app.tiles.viewRadius * 1.05;
    this.props.density = q === 'low' ? 0.35 : q === 'medium' ? 0.8 : 1;
    this.props.setShadows(q === 'high');
    app.resize();
    for (const m of this.car.mirrors) m.setEnabled(s.mirrors !== 'off');
    this.car.setCabinOpacity(s.cabinOpacity);
    if (this.truck) {
      for (const m of this.truck.mirrors) m.setEnabled(s.mirrors !== 'off');
      this.truck.setCabinOpacity(s.cabinOpacity);
    }
    this.audio.setVolume(s.volume);
    if (this.traffic) this.traffic.targetCount = Math.round(s.traffic * 34);
    // trams and trains come with the traffic: none when it is switched off
    if (this.rail) {
      this.rail.target = s.traffic > 0.02 ? 4 : 0;
      this.rail.ringMax = Math.min(620, app.tiles.viewRadius * 0.8);
      this.rail.far = Math.min(900, app.tiles.viewRadius * 1.1);
    }
  }

  // ------------------------------------------------------------------- flow
  private toMenu(): void {
    this.state = 'menu';
    this.demo = null;
    this.endTasks();
    this.car.root.visible = false;
    if (this.truck) {
      this.truck.root.visible = false;
      this.truck.trailer.visible = false;
    }
    this.input.enabled = false;
    this.hud.setHudVisible(false);
    this.audio.suspend();
    this.hud.showMenu(this.app.world.json.spawns);
    if (!this.spawn) {
      // show the town behind the menu
      const sp = this.app.world.json.spawns[0];
      if (sp) this.menuFocus.set(sp.x, 0, sp.z);
    }
  }

  private readonly menuFocus = new THREE.Vector3();

  /** The vehicle the player sits in: the car or the truck. */
  private get model(): PlayerCar | PlayerTruck {
    return this.isTruck && this.truck ? this.truck : this.car;
  }

  private showModel(on: boolean): void {
    this.car.root.visible = on && !this.isTruck;
    if (this.truck) {
      this.truck.root.visible = on && this.isTruck;
      this.truck.trailer.visible = on && this.isTruck;
    }
  }

  // ------------------------------------------------- class CE: truck and trailer
  /** A place on a road wide enough to start with a combination of 16 m, near a start point. */
  private truckSpot(near: SpawnJson): SpawnJson {
    this.mainLanes ??= mainNetwork(this.app.world, this.lanes);
    const wide = (e: Edge): boolean => (e.cls === CLS.PRIMARY || e.cls === CLS.SECONDARY || e.cls === CLS.TERTIARY) && e.len - e.cutA - e.cutB > 60;
    const spot = findRoadSpot(this.app.world, this.lanes, near.x, near.z, '', 900, this.mainLanes, wide, 20);
    return spot ? { ...spot, name: near.name } : near;
  }

  /** The next task on the practice yard: lay it out and stand the combination at its start. */
  private nextTask(): void {
    const frame = this.yardFrame!;
    const id = this.tasksLeft.shift()!;
    const run = new YardTask(id);
    const layout = run.layout;
    this.task = { run, laid: false, order: new Map(), second: false };
    const start = frame.poseToWorld(layout.start);
    this.spawn = { name: '', x: start.x, z: start.z, yaw: start.yaw, kind: 'street' };
    this.rules.yard = true;
    // the yard is asphalt while the lesson runs, whatever grows on the field
    this.ground.paved = (x, z) => {
      const [u, w] = frame.toLocal(x, z);
      return offArea(layout, u, w, 1.2) === 0;
    };
    this.taskSub = '';
    this.lessonLine = '';
    // reversing is watched from high above, coupling from close by
    this.input.c.lookZoom = id === 'couple' ? 17 : 34;
  }

  private endTasks(): void {
    if (this.task) this.input.c.lookZoom = 21;
    this.task = null;
    this.tasksLeft = [];
    this.yardScene.hide();
    this.ground.paved = null;
    this.rules.yard = false;
    this.hud.setChoices([], () => {});
  }

  /** Put the vehicle somewhere else in the middle of a lesson (the next task, the road after the yard). */
  private placeAgain(): void {
    this.traffic.clear();
    this.rail.clear();
    this.vehicle.vel.fill(0);
    this.vehicle.angVel.fill(0);
    this.input.c.handbrake = 1;
    this.path.breakLine();
    this.keepClock = true;
    this.state = 'placing';
    this.showModel(false);
    this.hud.showLoading(tr('loadingTiles', this.settings.lang));
  }

  private taskDone(ok: boolean): void {
    this.audio.click('chime');
    this.hud.setChoices([], () => {});
    if (!ok) {
      this.taskFailed = true;
      this.finish();
      return;
    }
    if (this.tasksLeft.length > 0) {
      this.nextTask();
      this.placeAgain();
      return;
    }
    this.endTasks();
    if (this.lesson && this.lesson.targets.length > 0 && this.roadSpawn) {
      // the tasks are done: now the drive in traffic
      this.spawn = this.truckSpot(this.roadSpawn);
      this.placeAgain();
      return;
    }
    this.finish();
  }

  /** Judge the task on the yard and say what is to be done. */
  private updateTask(dt: number): void {
    const task = this.task!;
    const run = task.run;
    const frame = this.yardFrame!;
    const v = this.vehicle;
    const t = this.trailer!;
    const lang = this.settings.lang;
    const handbrake = this.input.c.handbrake > 0.5;
    // (ground that was not loaded when the yard was laid out: once more, now and then)
    if (!task.laid && Math.abs(this.time - this.laidTry) > 0.7) {
      this.laidTry = this.time;
      task.laid = this.yardScene.show(frame, run.layout, (x, z) => this.app.tiles.heightAt(x, z));
    }
    if (run.judge) {
      const st = run.manoeuvre(dt, frame, v, t, handbrake);
      // a basic manoeuvre that went wrong may be repeated once – as in the test
      for (const f of st.faults) this.rules.note(f, f === 'ceLine' || !task.second ? 'major' : 'fail');
      this.lessonLine = tr(`ce.do.${run.id}`, lang);
      this.taskSub = tr('ce.corrections', lang, { n: st.corrections, max: MAX_CORRECTIONS });
      if (Number.isFinite(st.gap) && st.gap < 15) this.taskSub += ` · ${tr('ce.gap', lang, { d: formatUnit(Math.max(0, st.gap), 'meter', lang, 1) })}`;
      if (st.state === 'failed' && !task.second) {
        this.tasksLeft.unshift(run.id);
        this.nextTask();
        this.task!.second = true;
        this.placeAgain();
        this.hud.message(tr('ce.again', lang));
      } else if (st.state !== 'run') this.taskDone(st.state === 'done');
      return;
    }
    const proc = run.coupling!;
    const st = run.couple(dt, v, t, handbrake);
    if (run.bumped) this.rules.note('ceFast', 'major');
    for (const f of st.faults) this.rules.note(f, 'major');
    if (st.couple) this.audio.click('chime');
    // what can be done on foot now – in an order of its own each time, so that the list does not give the order away
    const choices: CouplingStepId[] = st.state === 'run' && proc.onFoot(run.state) ? proc.choices() : [];
    for (const id of choices) if (!task.order.has(id)) task.order.set(id, Math.random());
    choices.sort((a, b) => task.order.get(a)! - task.order.get(b)!);
    this.hud.setChoices(
      choices.map((id) => ({ id, label: tr(`ce.step.${id}`, lang) })),
      (id: string) => {
        const fault = proc.act(id as CouplingStepId, run.state);
        if (fault) this.rules.note(fault, 'major', {}, 0.5);
        else this.audio.click('chime');
      },
    );
    this.lessonLine = st.todo ? tr(`ce.do.${st.todo}`, lang) : choices.length ? tr('ce.onFoot', lang) : tr('ce.do.uPark', lang);
    this.taskSub = `${proc.done.size} / ${COUPLING_STEPS.length}`;
    if (st.state === 'done') this.taskDone(true);
  }

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
    this.teleportSpot(spot);
  }

  /** Free drive: put the car at a spot on a road (an address, or a place chosen on the map). */
  private teleportSpot(spot: SpawnJson): void {
    if (this.lesson || (this.state !== 'pause' && this.state !== 'map')) return;
    this.bigMap.close();
    if (this.demo) {
      this.demo = null;
      this.nav.clear();
      this.hud.routeLanes = [];
      this.rules.allowed = null;
    }
    this.spawn = spot;
    this.traffic.clear();
    this.rail.clear();
    this.vehicle.vel.fill(0);
    this.vehicle.angVel.fill(0);
    this.input.c.handbrake = 1;
    this.path.breakLine();
    this.keepClock = true;
    this.state = 'placing';
    this.showModel(false);
    this.hud.setHudVisible(true);
    this.hud.showLoading(tr('loadingTiles', this.settings.lang));
  }

  // ------------------------------------------------------------------ map
  /** The full-screen map: where am I, where have I been – and, in a free drive, put the car elsewhere. */
  private openMap(closeUp = false): void {
    if (this.state === 'reality') {
      // from the photographs to the map: back to where the photographs were opened from afterwards
      this.reality.close();
      this.state = 'pause';
    }
    if (this.state !== 'drive' && this.state !== 'pause') return;
    this.mapFrom = this.state;
    this.state = 'map';
    this.input.enabled = false;
    this.audio.suspend();
    this.hud.hideOverlay();
    this.hud.setHudVisible(false);
    this.vehicle.getModelPosition(this.mpos);
    this.bigMap.open(this.ui, closeUp);
  }

  // ------------------------------------------------- demonstration drives
  /** Drive by itself to these places, one after the other, from where the car stands. */
  private startDemo(stops: SpawnJson[]): void {
    if (this.lesson || stops.length === 0 || (this.state !== 'map' && this.state !== 'drive' && this.state !== 'pause')) return;
    if (this.state === 'map') {
      this.mapFrom = 'drive';
      this.closeMap();
    } else if (this.state === 'pause') this.resume();
    // the driver has no hand for a gear lever: the car gets the automatic gearbox for it
    if (this.vehicle.spec.transmission !== 'automatic') {
      const old = this.vehicle;
      old.getModelPosition(this.mpos);
      const spec = withPower(COMPACT_CAR_AUTOMATIC, this.settings.power);
      const v = new Vehicle(spec, this.ground);
      v.teleport(this.mpos[0], this.mpos[1] + 0.02, this.mpos[2], old.yaw);
      v.odometer = old.odometer;
      this.vehicle = v;
      this.input.setSteering(spec.wheelbase, spec.maxWheelAngle);
      this.input.setAutomatic(true);
      this.hud.gearbox = 'automatic';
    }
    const v = this.vehicle;
    v.resetDrivetrain(true);
    const c = this.input.c;
    c.seatbelt = true;
    c.ignition = true;
    c.handbrake = 0;
    c.gear = 1;
    c.indicator = 0;
    c.hazard = false;
    this.nav.clear();
    const driver = new AutoDriver(this.app.world, this.signals, this.rules, this.traffic, {
      spec: v.spec,
      front: this.isTruck ? TRUCK_OUTLINE.front : (v.spec.length ?? 4.28) / 2,
      truck: this.isTruck,
    });
    this.demo = { stops: [...stops], index: 0, driver, active: true, look: 0, remark: '', takeT: 0, lost: 0 };
    this.hud.clearNotices();
  }

  /** The drive is over: the car has arrived, the player takes it over, or there is no way to go on. */
  private endDemo(why: 'arrived' | 'taken' | 'lost'): void {
    const demo = this.demo;
    if (!demo) return;
    this.demo = null;
    this.nav.clear();
    this.hud.routeLanes = [];
    this.rules.allowed = null;
    const c = this.input.c;
    c.indicator = 0;
    const lang = this.settings.lang;
    if (why === 'arrived') {
      c.handbrake = 1;
      this.audio.click('chime');
      this.hud.message(tr('demoArrived', lang));
    } else if (why === 'lost') {
      c.handbrake = 1;
      this.hud.message(tr('demoNoRoute', lang));
    } else this.hud.message(tr('demoTaken', lang), tr('demoTakenSub', lang));
  }

  /** Where the demonstration drive is heading: the route to the next of its places. */
  private updateDemo(dt: number, p: PlayerState): void {
    const demo = this.demo!;
    const lane = this.currentLane();
    if (!lane) {
      // not on a road of the network (a yard, a field): there is no way from here
      demo.lost += dt;
      if (demo.lost > 4 && !this.nav.goal) this.endDemo('lost');
      return;
    }
    const last = demo.index >= demo.stops.length - 1;
    if (!this.nav.goal) {
      const stop = demo.stops[demo.index];
      const goal = this.app.world.nearestRoad(stop.x, stop.z, 60, 0, this.hit) ? this.hit.edge : null;
      if (!goal || !this.nav.setGoal(goal, lane)) {
        // no way there from here (yet): try again shortly, then give up
        this.nav.clear();
        demo.lost += dt;
        if (demo.lost > 3) this.endDemo('lost');
        return;
      }
      demo.lost = 0;
      demo.driver.halt = last ? { x: stop.x, z: stop.z } : null;
      this.hud.routeLanes = this.nav.routeLanes;
    }
    const lang = this.settings.lang;
    const h = this.nav.update(dt, lane, this.laneFront(), p.x, p.z);
    if (this.hud.routeLanes !== this.nav.routeLanes) {
      this.hud.routeLanes = this.nav.routeLanes;
      this.rules.allowed = new Set(this.nav.routeLanes.map((l) => l.edge));
    }
    if (h.done && !last) {
      demo.index++;
      this.nav.clear();
      this.audio.click('chime');
      this.hud.message(tr('demoStop', lang, { n: demo.index }));
    }
  }

  private closeMap(): void {
    if (this.state !== 'map') return;
    this.bigMap.close();
    if (this.mapFrom === 'pause') {
      this.state = 'pause';
      this.hud.setHudVisible(true);
      this.hud.showPause();
    } else this.resume();
  }

  private begin(mode: string, spawnIdx: number, skipIntro = false, address?: AddressHit): void {
    const world = this.app.world;
    this.audio.start();
    this.spawn = (address ? this.spawnAt(address) : null) ?? world.json.spawns[Math.max(0, Math.min(world.json.spawns.length - 1, spawnIdx))] ?? { name: '', x: 0, z: 0, yaw: 0, kind: 'street' };
    this.lesson = LESSONS.find((l) => l.id === mode) ?? null;
    this.demo = null;
    this.planDemo = mode === 'demo';
    this.hud.canTeleport = !this.lesson;
    this.hud.canFinish = !this.lesson;
    this.keepClock = false;
    this.path.breakLine();
    // the car, or the truck with its trailer (class CE)
    this.isTruck = this.lesson?.vehicle ? this.lesson.vehicle === 'truck' : this.settings.vehicle === 'truck';
    const base = this.settings.transmission === 'automatic' ? COMPACT_CAR_AUTOMATIC : this.settings.transmission === 'assist' ? COMPACT_CAR_AUTOCLUTCH : COMPACT_CAR;
    const spec = this.isTruck ? TRUCK : withPower(base, this.settings.power);
    this.vehicle = new Vehicle(spec, this.ground);
    if (this.isTruck && !this.truck) {
      this.truck = new PlayerTruck();
      this.app.scene.add(this.truck.root, this.truck.trailer);
      for (const m of this.truck.mirrors) m.setEnabled(this.settings.mirrors !== 'off');
      this.truck.setCabinOpacity(this.settings.cabinOpacity);
    }
    this.trailer = this.isTruck ? new Trailer(TANDEM_TRAILER, this.ground) : null;
    this.hud.gearbox = this.isTruck ? 'automatic' : null;
    this.endTasks();
    // the camera stands further back for 16 m of vehicle
    this.input.c.lookZoom = this.isTruck ? 21 : 7;
    this.input.zoomMax = this.isTruck ? 45 : 18;
    this.collider.setShape(this.isTruck ? TRUCK_CIRCLES : CAR_CIRCLES, this.isTruck ? 1.25 : 0.93);
    this.rules.truck = this.isTruck;
    this.taskFailed = false;
    this.roadSpawn = this.spawn;
    this.tasksLeft = this.isTruck && this.yardFrame && this.lesson?.tasks ? [...this.lesson.tasks] : [];
    this.taskCount = this.tasksLeft.length;
    if (this.tasksLeft.length > 0) this.nextTask();
    else if (this.isTruck && !address) this.spawn = this.truckSpot(this.spawn);
    this.input.setSteering(spec.wheelbase, spec.maxWheelAngle);
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
    this.rail.clear();
    this.nav.clear();
    this.targetIdx = 0;
    this.basicsStep = 0;
    this.visited.clear();
    this.failT = -1;
    this.homeEdge = null;
    this.state = 'placing';
    this.showModel(false);
    this.hud.showLoading(tr('loadingTiles', this.settings.lang));
    const lang = this.settings.lang;
    const note = this.isTruck && this.lesson?.kind === 'route' ? `${tr('lesson.truckNote', lang)} ` : '';
    this.pendingIntro = this.lesson && !skipIntro ? { title: lessonTitle(this.lesson.id, lang), text: note + lessonIntro(this.lesson.id, lang) } : null;
  }

  private pendingIntro: { title: string; text: string } | null = null;

  /** Called every frame while waiting for the terrain under the start point. */
  private tryPlace(): void {
    const sp = this.spawn!;
    const ty = this.app.tiles.heightAt(sp.x, sp.z);
    if (Number.isNaN(ty) || !this.app.tiles.settled) return;
    const y = this.app.world.surfaceAt(sp.x, sp.z, ty + 3, this.hit) ? this.hit.y : ty;
    // the practice yard is laid out over the field as soon as the ground under it is there
    if (this.task && !this.task.laid) this.task.laid = this.yardScene.show(this.yardFrame!, this.task.run.layout, (x, z) => this.app.tiles.heightAt(x, z));
    this.vehicle.teleport(sp.x, y + 0.02, sp.z, sp.yaw);
    this.trailer?.coupleBehind(this.vehicle);
    this.lastGood = { x: sp.x, y, z: sp.z, yaw: sp.yaw, t: 0 };
    this.camSnap = true;
    this.showModel(true);
    if (!this.keepClock) {
      this.startOdo = this.vehicle.odometer;
      this.startTime = this.time;
    }
    this.keepClock = false;
    if (this.pendingIntro) {
      this.state = 'intro';
      const intro = this.pendingIntro;
      this.pendingIntro = null;
      this.hud.showIntro(intro.title, intro.text, () => this.resume());
    } else this.resume();
    if (this.planDemo && this.state === 'drive') {
      this.planDemo = false;
      this.openMap();
      this.bigMap.plan();
    }
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
    this.path.save();
    this.hud.showPause();
  }

  private finish(): void {
    this.path.save();
    this.demo = null;
    const l = this.lesson;
    const exam = l?.kind === 'exam';
    const failed = this.rules.failed || this.rules.points >= 10 || this.taskFailed;
    const judged = this.taskCount > 0;
    this.endTasks();
    this.state = 'result';
    this.input.enabled = false;
    this.audio.suspend();
    this.hud.setHudVisible(false);
    this.hud.showResult({
      title: l ? lessonTitle(l.id, this.settings.lang) : tr('free', this.settings.lang),
      exam: !!exam || judged,
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
      else if (this.state === 'map') this.closeMap();
    } else if (a === 'view' && this.state === 'drive') {
      this.cameraMode = this.cameraMode === 'cockpit' ? 'chase' : 'cockpit';
      this.input.resetLook(this.cameraMode === 'chase');
      // the next drive begins with the camera the player chose
      this.settings.view = this.cameraMode;
      saveSettings(this.settings);
    } else if (a === 'reset' && this.state === 'drive') {
      this.resetToRoad();
    } else if (a === 'help') {
      if (this.state === 'drive') {
        this.state = 'pause';
        this.input.enabled = false;
        this.hud.showControls(() => this.resume());
      }
    } else if (a === 'map') {
      if (this.state === 'map') this.closeMap();
      else this.openMap();
    }
  }

  private resetToRoad(): void {
    const g = this.lastGood;
    this.vehicle.teleport(g.x, g.y + 0.05, g.z, g.yaw);
    if (this.trailer?.coupled) this.trailer.coupleBehind(this.vehicle);
    this.demo?.driver.reset();
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
    // Speed limiter: a key or a pedal on the screen is all or nothing, which makes it hard to hold
    // 30 or 50 km/h.  With the limiter the throttle eases off just below the current limit – the
    // driver still has to brake when the limit drops.
    const lim = this.rules?.context.limit ?? -1;
    if (this.settings.limiter && lim > 0 && c.gear !== -1 && (c.device === 'keyboard' || c.device === 'touch')) {
      d.throttle = Math.min(d.throttle, Math.max(0, (lim - 0.5 - v.speed * 3.6) / 4));
    }
    // a truck is governed at 90 km/h
    if (this.isTruck && v.speed * 3.6 > 85) d.throttle = Math.min(d.throttle, Math.max(0, (89.5 - v.speed * 3.6) / 4));
    const demo = this.demo;
    if (demo?.active) {
      // Whoever touches a pedal or the steering takes the car over (held for a moment: a wheel
      // that is not quite centred, or a thumb resting on the screen, is no decision).
      demo.takeT = c.throttle > 0.2 || c.brake > 0.2 || Math.abs(c.steer) > 0.35 || c.handbrake > 0.5 ? demo.takeT + dt : 0;
      if (demo.takeT > 0.18) this.endDemo('taken');
      else {
        v.getModelPosition(this.mpos);
        const cmd = demo.driver.step(Math.max(dt, 1e-3), v, this.mpos, this.nav.route ?? []);
        // (until the way is known the car stands: no lane under it yet, or no route found yet)
        const ready = this.nav.goal !== null;
        d.steer = ready ? cmd.steer : 0;
        d.throttle = ready ? cmd.throttle : 0;
        d.brake = ready ? cmd.brake : 0.5;
        d.clutch = 0;
        d.handbrake = 0;
        d.gear = 1;
        d.ignition = true;
        d.starter = !v.engineRunning;
        c.gear = 1;
        c.indicator = cmd.indicator;
        demo.look = cmd.look;
        demo.remark = cmd.remark;
        if (cmd.arrived) {
          d.brake = 1;
          this.endDemo('arrived');
        }
      }
    }
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
      this.trailer?.step(PHYS_DT, v, d);
      this.acc -= PHYS_DT;
      if (v.stalledEvent) stalled = true;
      if (v.gearGrind) grind = true;
      const hit = this.collider.resolve(v);
      if (hit > this.impact) this.impact = hit;
    }
    this.path.add(v.pos[0], v.pos[2]);
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
    // (the traffic wants the middle of the vehicle's length; a truck is measured from the middle of its wheelbase)
    const mid = this.isTruck ? (TRUCK_OUTLINE.rear - TRUCK_OUTLINE.front) / 2 : 0;
    const player: PlayerState = { x: this.mpos[0] + Math.sin(v.yaw) * mid, y: this.mpos[1], z: this.mpos[2] + Math.cos(v.yaw) * mid, yaw: v.yaw, speed: v.speed, length: v.spec.length ?? 4.28, width: v.spec.width ?? 1.79 };
    this.signals.update(dt);
    // trams and trains: they keep clear of the cars, the cars of them
    const others = this.railOthers;
    others.length = 0;
    for (const car of this.traffic.cars) others.push({ x: car.x, z: car.z, r: 1.3 });
    this.rail.update(dt, player, others);
    const boxes = this.railBoxes;
    boxes.length = 0;
    for (const rv of this.rail.vehicles) for (const rc of rv.cars) boxes.push({ x: rc.x, y: rc.y, z: rc.z, yaw: rc.yaw, speed: rv.speed, length: rv.consist.carLen, width: rv.consist.width });
    if (this.trailer) {
      // the trailer is in the way of the traffic like the truck itself
      const t = this.trailer;
      const off = (TRAILER_OUTLINE.front - TRAILER_OUTLINE.rear) / 2;
      boxes.push({ x: t.x - Math.sin(t.yaw) * off, y: t.y, z: t.z - Math.cos(t.yaw) * off, yaw: t.yaw, speed: t.coupled ? t.speed : 0, length: TRAILER_OUTLINE.front + TRAILER_OUTLINE.rear, width: TRAILER_OUTLINE.hw * 2 });
    }
    this.traffic.obstacles = boxes;
    this.traffic.update(dt, player);
    // run into a tram (or hit by one): pushed clear – it does not give way
    const tram = this.rail.touching(player);
    if (tram) {
      v.translate(tram.nx * Math.min(0.4, tram.depth + 0.02), 0, tram.nz * Math.min(0.4, tram.depth + 0.02));
      const closing = (v.vel[0] - tram.vx) * tram.nx + (v.vel[2] - tram.vz) * tram.nz;
      if (closing < 0) {
        v.applyImpulse(v.pos[0], v.pos[1], v.pos[2], -tram.nx * closing * v.spec.mass * 1.15, 0, -tram.nz * closing * v.spec.mass * 1.15);
        this.impact = Math.max(this.impact, -closing);
      }
    }
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
      // (on a demonstration drive it is the driver who looks over the shoulder)
      lookYaw: this.demo?.active ? this.demo.look : c.lookYaw,
      seatbelt: c.seatbelt,
      handbrake: c.handbrake,
      stalled,
      hitScenery: impact,
      length: v.spec.length ?? 4.28,
      front: this.isTruck ? TRUCK_OUTLINE.front : undefined,
    };
    this.rules.update(dt, snap, this.traffic.events);
    this.rememberGoodSpot(player);
    if (this.task) this.updateTask(dt);
    else if (this.demo) this.updateDemo(dt, player);
    else this.updateLesson(dt, player);
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
      const steps: Array<[string, () => boolean]> = [
        ['basics.belt', () => c.seatbelt],
        [auto ? 'basics.startAuto' : 'basics.startManual', () => v.engineRunning],
        [auto ? 'basics.gearAuto' : 'basics.gearManual', () => (auto ? c.gear === 1 : v.gear === 1)],
        ['basics.handbrake', () => c.handbrake < 0.5],
        ['basics.pullAway', () => v.speed * 3.6 > 15],
        [auto ? 'basics.accelAuto' : 'basics.accelManual', () => v.speed * 3.6 > 30 && (auto || v.gear >= 2)],
        ['basics.brake', () => Math.abs(v.speed) < 0.1],
        ['basics.reverse', () => v.speed < -1],
        ['basics.stop', () => Math.abs(v.speed) < 0.1 && c.handbrake > 0.5],
      ];
      if (this.basicsStep < steps.length && steps[this.basicsStep][1]()) {
        this.basicsStep++;
        this.audio.click('chime');
      }
      if (this.basicsStep >= steps.length) {
        this.finish();
        return;
      }
      this.lessonLine = `${this.basicsStep + 1}/${steps.length} · ${tr(steps[this.basicsStep][0], lang)}`;
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
    this.lessonLine = `${lessonTitle(l.id, lang)} · ${this.targetIdx + 1}/${l.targets.length}`;
  }

  private lessonLine = '';

  // ------------------------------------------------------------------ frame
  private frame(now: number): void {
    // (never backwards: the time stamp of a frame that was held up by a long task can lie before
    // the moment the clock was last read, and a clock running backwards freezes everything timed)
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
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
      setKeyStyle(this.inputMode);
      this.stepDrive(dt);
      if (this.autoNotice && this.time - this.startTime > 0.3) {
        const kind = this.autoNotice;
        this.autoNotice = '';
        // (they stay: the automated check may take minutes for a frame)
        const show = (id: string, severity: 'fail' | 'minor', data: Record<string, number> = {}): void => {
          this.hud.toast({ id, severity, time: this.time, x: 0, z: 0, data }, 3600);
          this.faultLog.add({ t: Date.now(), id, severity, data, street: this.rules.context.roadName, mode: this.lesson?.id ?? 'free', x: 0, z: 0 });
        };
        if (kind !== 'yellow') show('redLight', 'fail');
        if (kind !== 'red') show('speed', 'minor', { limit: 30, speed: 42 });
      }
      if (this.autoTram && this.time - this.startTime > 0.3) {
        this.autoTram = false;
        let best: [number, number, number] | null = null;
        for (let dx = -200; dx <= 200; dx += 200) {
          for (let dz = -200; dz <= 200; dz += 200) {
            const list = this.rail.net.near(this.mpos[0] + dx, this.mpos[2] + dz);
            for (let k = 0; k < list.length; k += 2) {
              const o = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };
              this.rail.net.sample(list[k], list[k + 1], o);
              const d = Math.hypot(o.x - this.mpos[0], o.z - this.mpos[2]);
              if (!best || d < best[2]) best = [list[k], list[k + 1], d];
            }
          }
        }
        if (best && best[2] < 150) {
          const way = this.rail.net.paths[best[0]].way;
          if (!this.rail.spawnAt(best[0], best[1], way === 0 ? 1 : way)) this.rail.spawnAt(best[0], best[1], way === 0 ? -1 : way);
        }
      }
      if (this.autoDemo.length > 0 && this.time - this.startTime > 0.3) {
        this.mainLanes ??= mainNetwork(this.app.world, this.lanes);
        const stops: SpawnJson[] = [];
        for (const [x, z] of this.autoDemo) {
          const spot = findRoadSpot(this.app.world, this.lanes, x, z, '', 200, this.mainLanes);
          if (spot) stops.push(spot);
        }
        this.autoDemo = [];
        this.startDemo(stops);
      }
      if (this.autoMap && this.time - this.startTime > 0.3) {
        const mode = this.autoMap;
        this.autoMap = '';
        if (mode === 'aerial') this.settings.reality.aerial = true;
        this.openMap(mode === 'aerial');
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

    const model = this.model;
    const haveCar = this.vehicle && model.root.visible;
    if (haveCar) {
      const v = this.vehicle;
      v.getModelPosition(this.mpos);
      model.root.position.set(this.mpos[0], this.mpos[1], this.mpos[2]);
      model.root.quaternion.set(v.quat[0], v.quat[1], v.quat[2], v.quat[3]);
      model.root.updateMatrixWorld(true);
      if (this.truck && this.trailer && this.isTruck) {
        const t = this.trailer;
        this.truck.setTrailer(t.x, t.y, t.z, t.yaw, t.pitch, t.wheelSpin, t.coupled);
      }
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
    this.railActors.update(this.rail.vehicles);

    if (this.state === 'reality') {
      // the panel covers the window: only a 360° panorama is drawn, not the world behind it
      this.reality.render(app.renderer, app.canvas);
    } else if (this.state === 'map') {
      // the map covers the window: nothing of the world needs drawing
    } else if (haveCar) {
      this.updateCamera(dt);
      const mode = this.settings.mirrors;
      if (this.cameraMode === 'cockpit' && mode !== 'off') {
        const mirrors = model.mirrors;
        const far = Math.min(450, app.tiles.viewRadius * 0.4);
        if (mode === 'full' || this.frames < 4) for (const m of mirrors) m.render(app.renderer, app.scene, model.root.matrixWorld, this.eyeWorld, far);
        else mirrors[this.mirrorTurn++ % mirrors.length].render(app.renderer, app.scene, model.root.matrixWorld, this.eyeWorld, far);
      }
      app.render(model.root.position);
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
    if (this.state === 'map') {
      if (++this.mapFrames > 3 && window.__fs) window.__fs.ready = true;
    } else this.mapFrames = 0;
    if (window.__fs && !window.__fs.ready && tiles.settled && this.frames > 6 && (this.state === 'drive' || this.state === 'menu' || this.state === 'intro')) {
      if (this.autoReality || this.autoMap) {
        /* the reality view or the map is about to open */
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
    s.brake = this.driver.brake;
    s.throttle = this.driver.throttle;
    s.handbrakeLever = c.handbrake;
    s.braking = this.driver.brake > 0.03;
    s.reversing = v.gear === -1;
    this.model.update(s, dt, this.time);

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
    const demo = this.demo;
    if (this.nav.goal && ((this.lesson && this.lesson.kind !== 'basics') || demo)) {
      const what = h.what === 'navRoundabout' ? tr('navRoundabout', lang, { n: h.n }) : tr(h.what, lang);
      if (h.what === 'navFollow' || h.dist < 0) navText = tr('navFollow', lang);
      else if (h.dist < 35) navText = tr('navNow', lang, { what });
      else navText = tr('navIn', lang, { d: Math.round(h.dist / 10) * 10, what });
      this.speak(h.what, h.dist, navText);
      // § 9 StVO: get in lane in good time – the route goes on from a particular lane
      if (h.lane !== 0) navText += ` – ${tr(h.lane < 0 ? 'laneLeft' : 'laneRight', lang)}`;
    } else if (this.lesson?.kind === 'basics' || this.task) navText = this.lessonLine;
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
    // driving against the handbrake: the lamp flashes and a chime sounds (once per attempt)
    const hbWarn = c.handbrake > 0.5 && v.engineRunning && (c.throttle > 0.1 || Math.abs(kmh) > 3);
    if (hbWarn && !this.hbWarned) this.audio.click('chime');
    this.hbWarned = hbWarn;
    const hs: HudState = {
      speedKmh: kmh,
      rpm: v.rpm,
      // (the bar is full a little above the limiter: 7000 for the car as before)
      rpmMax: v.spec.limiterRpm * 1.077,
      gear: gearText,
      limit: ctx.limit,
      zone: ctx.zone,
      junction: ctx.junction,
      navText,
      navSub: this.task ? this.taskSub : this.lesson && this.lesson.kind !== 'basics' ? this.lessonLine : ctx.roadName,
      navArrow: h.arrow,
      navActive: (!!this.lesson || !!demo) && h.dist >= 0 && h.what !== 'navFollow' && h.what !== 'routeDone',
      tip,
      tipAction,
      // (the truck's instruments stand far away at the foot of its windscreen: the strip stays)
      showDash: this.cameraMode !== 'cockpit' || this.isTruck,
      indicator: c.indicator,
      hazard: c.hazard,
      blinkOn: s.blinkOn,
      handbrake: c.handbrake > 0.5,
      handbrakeWarn: hbWarn,
      seatbelt: c.seatbelt,
      engineOn: v.engineRunning,
      lights: c.lowBeam,
      points: this.rules.points,
      faults: this.rules.log.filter((x) => x.severity !== 'hint').length,
      x: this.mpos[0],
      z: this.mpos[2],
      yaw: v.yaw,
    };
    if (demo) {
      // a demonstration drive: where it goes, and under it what the driver is doing just now and why
      if (!navText) hs.navText = ctx.roadName || tr('demo', lang);
      hs.navSub = demo.remark ? tr(`demo.${demo.remark}`, lang) : tr('demoRunning', lang, { n: demo.index + 1, max: demo.stops.length });
    } else if (!navText && !this.lesson) {
      hs.navText = ctx.roadName || tr('free', lang);
      hs.navSub = tr(touch ? 'navSubTouch' : 'navSubKeys', lang);
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
    u.lang = localeOf(this.settings.lang);
    u.volume = this.settings.volume;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  private updateCamera(dt: number): void {
    const cam = this.app.camera;
    const car = this.model.root;
    const v = this.vehicle;
    const c = this.input.c;
    // the eye is always needed for the mirrors
    const lean = this.tmpV.set(-v.accLat * 0.004, 0, v.accLong * 0.005);
    lean.clampLength(0, 0.06);
    this.eyeWorld.copy(this.model.eye).add(lean).applyMatrix4(car.matrixWorld);
    if (this.cameraMode === 'cockpit') {
      cam.near = 0.06;
      cam.fov = 60;
      cam.position.copy(this.eyeWorld);
      // looking over the shoulder also moves the head a little towards that side
      // (on a demonstration drive the head turns as the driver looks over the shoulder – not in a jerk)
      const want = this.demo?.active ? this.demo.look * 0.8 : 0;
      this.demoHead += Math.max(-dt * 5, Math.min(dt * 5, want - this.demoHead));
      this.tmpQ.setFromEuler(new THREE.Euler(c.lookPitch, c.lookYaw + this.demoHead, 0, 'YXZ'));
      cam.quaternion.copy(car.quaternion).multiply(this.tmpQ);
    } else if (this.cameraMode === 'chase') {
      cam.near = 0.3;
      cam.fov = 55;
      // The camera circles a point above the car: the mouse (or a finger) turns it all the way
      // round and from road level up to a bird's view, the wheel changes the distance.
      // (With a trailer it circles the coupling – the middle of the combination – and looks from
      // higher up, so that the trailer does not hide the road and its end can be watched.)
      // (While reversing on the yard it looks down steeply on the trailer's axles: what matters is
      // where the trailer's end goes, and that lies behind.)
      const long = this.isTruck;
      const reversing = !!this.task?.run.judge;
      const lift = Math.min(1.5, Math.max(0.03, (reversing ? 1.05 : long ? 0.42 : 0.2) - c.lookPitch));
      const reach = c.lookZoom * Math.cos(lift);
      const up = long ? 2.2 : 1.1;
      const behind = reversing ? 9.5 : long ? 4.2 : 0;
      const fx = car.position.x + Math.sin(v.yaw) * behind;
      const fz = car.position.z + Math.cos(v.yaw) * behind;
      const back = this.tmpV.set(Math.sin(c.lookYaw) * reach, up + c.lookZoom * Math.sin(lift), Math.cos(c.lookYaw) * reach).applyAxisAngle(THREE.Object3D.DEFAULT_UP, v.yaw);
      const target = this.camTarget.set(fx, car.position.y, fz).add(back);
      const g = this.app.tiles.heightAt(target.x, target.z);
      if (!Number.isNaN(g)) target.y = Math.max(target.y, g + 0.6);
      // (after the car was put somewhere the camera is there at once – it does not fly in from where it was)
      if (this.camSnap) cam.position.copy(target);
      else cam.position.lerp(target, Math.min(1, dt * 8));
      this.camSnap = false;
      cam.lookAt(fx, car.position.y + up, fz);
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
