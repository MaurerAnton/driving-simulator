// SPDX-License-Identifier: AGPL-3.0-only
/** Game orchestration: loading, menus, the main loop, cameras, lessons. */
import * as THREE from 'three';
import { GameAudio } from '../audio/audio.ts';
import { Input } from '../input/input.ts';
import type { Action } from '../input/input.ts';
import { clearObjects, clearSigns, clearWalls, postInLane } from '../sim/clearlanes.ts';
import { SceneryCollider } from '../sim/collision.ts';
import { WorldGround } from '../sim/ground.ts';
import { RuleMonitor } from '../sim/rules.ts';
import type { PlayerSnapshot } from '../sim/rules.ts';
import { markArrows } from '../sim/arrows.ts';
import { COMPACT_DIMS } from '../render/carBody.ts';
import { CheckMarkers, EYE, OnFoot } from './onfoot.ts';
import type { CheckId, WalkUnit, WalkVehicle } from './onfoot.ts';
import { SIG, SignalSystem } from '../sim/signals.ts';
import { Traffic } from '../sim/traffic.ts';
import type { BusStopOnLane, PlayerState, TrafficCar } from '../sim/traffic.ts';
import { Vehicle } from '../sim/vehicle/index.ts';
import { LIGHT_TRUCK, MINIBUS } from '../sim/vehicle/fleet.ts';
import type { DriverInput } from '../sim/vehicle/index.ts';
import { SignalRenderer, TrafficRenderer } from '../render/actors.ts';
import { PedLightRenderer } from '../render/pedlights.ts';
import { WalkerModel } from '../render/walker.ts';
import { FLOOR as TRAM_FLOOR, PassengerView } from '../render/passenger.ts';
import { FarTerrain } from '../render/far.ts';
import { TransitScene } from '../render/transit.ts';
import { AirfieldRenderer } from '../render/airfield.ts';
import { PlaneModel } from '../render/plane.ts';
import type { PlaneVisualState } from '../render/plane.ts';
import { AirfieldGround, runwayEnd, runwayStart } from '../sim/airfield.ts';
import { Aircraft } from '../sim/flight.ts';
import type { FlightControls } from '../sim/flight.ts';
import { TRAINER } from '../sim/flightspec.ts';
import { farHeight } from '../world/far.ts';
import type { AirJson } from '../world/types.ts';
import type { LinesJson } from '../world/types.ts';
import { farBuilt, parseFar } from '../world/far.ts';
import { pedPoles, poleInReach } from '../world/pedlights.ts';
import type { PedPole } from '../world/pedlights.ts';
import { PlayerCar } from '../render/car.ts';
import type { CarVisualState } from '../render/car.ts';
import { PropRenderer } from '../render/props.ts';
import { SignRenderer } from '../render/signs.ts';
import type { LoadedTile } from '../render/tiles.ts';
import { latLonToWorld, worldToLatLon } from '../geo/utm.ts';
import { AddressIndex, findRoadSpot, mainNetwork } from './address.ts';
import type { AddressHit, AddressJson } from './address.ts';
import { Hud } from '../ui/hud.ts';
import type { HudState, RunwayChoice, TramStopChoice } from '../ui/hud.ts';
import { Stops } from '../world/stops.ts';
import { LANGS, formatUnit, isRtl, lessonIntro, lessonTitle, loadLang, localeOf, setKeyStyle, tr } from '../i18n/index.ts';
import { initKeyLabels } from '../i18n/keys.ts';
import { RealityPanel } from '../ui/reality.ts';
import { LaneGraph, TURN, lanePoint } from '../world/lanes.ts';
import type { Lane } from '../world/lanes.ts';
import { newPolySample, projectOnPolyline, samplePolyline } from '../core/geom.ts';
import { CLS, CTRL, RAIL, STOP_FLAG, SURF_ROLLING, XING } from '../world/types.ts';
import type { SpawnJson } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { Edge, Node as Junction } from '../world/world.ts';
import { App } from './app.ts';
import { LESSONS, Navigator, findTarget } from './nav.ts';
import { planTourInSlices } from './tour.ts';
import { BusService } from './busline.ts';
import type { BusEvent } from './busline.ts';
import { saveTour, thinLine } from './tourlog.ts';
import type { TourPlan } from './tour.ts';
import { quickest, quickestToEdge, routeFor, routeGraphOf, wayOf } from '../world/routegraph.ts';
import type { RouteGraph } from '../world/routegraph.ts';
import { NetIndex } from '../world/netindex.ts';
import { netPolyline } from '../world/netfile.ts';
import type { LessonDef } from './nav.ts';
import { GRAPHICS_PRESETS, loadSettings, playedBefore, saveSettings } from './settings.ts';
import { newsDue } from './releases.ts';
import { FaultLog } from './faultlog.ts';
import { DrivenPath } from './track.ts';
import { BigMap } from '../ui/bigmap.ts';
import type { TourPreview } from '../ui/bigmap.ts';
import { RailTraffic } from '../sim/rail.ts';
import type { RailObstacle, RailVehicle } from '../sim/rail.ts';
import type { CrossingJson } from '../world/types.ts';
import { RailActors } from '../render/trams.ts';
import { PlayerTruck } from '../render/truck.ts';
import { CarTrailerModel, PlayerBike, PlayerBus, PlayerTractor, TramCab } from '../render/fleet.ts';
import type { BikeVariant } from '../render/bike.ts';
import { TramDriver, tramStart } from '../sim/tramdrive.ts';
import type { TramEvent } from '../sim/tramdrive.ts';
import type { VehicleModel } from '../render/fleet.ts';
import { VEHICLES, powerOf, trailerOf, vehicleKind } from './vehicles.ts';
import type { ModelKind, VehicleDef } from './vehicles.ts';
import { YardScene } from '../render/yard.ts';
import { Trailer } from '../sim/trailer.ts';
import { COUPLING_STEPS, MAX_CORRECTIONS, TRAILER_AXLES, TRAILER_OUTLINE, TRUCK_AXLES, TRUCK_OUTLINE, YardFrame, offArea } from './ce.ts';
import type { CouplingStepId, TaskId } from './ce.ts';
import { YardTask } from './yardtask.ts';
import { AutoDriver } from '../sim/autodriver.ts';
import { followMap } from '../sim/follow.ts';
import type { Settings } from './settings.ts';

type State = 'loading' | 'menu' | 'intro' | 'placing' | 'drive' | 'pause' | 'reality' | 'map' | 'result';
/** the driver's seat, behind the car, a camera that is moved about freely – and a fixed one for pictures (?cam=) */
type CameraMode = 'cockpit' | 'chase' | 'free' | 'dev';

const PHYS_DT = 1 / 240;

/** the outlines of the vehicles for collisions with the scenery: circles along the axis (m from the model origin; - = front) */

/** stops in the tram lesson */
const TRAM_STOPS = 5;
/** … and the bus lesson */
const BUS_STOPS = 5;
/** the lean of the motorcycle, for the rider's eyes */
const BIKE_ROLL = new THREE.Quaternion();
const AXIS_Z = new THREE.Vector3(0, 0, 1);
/** what is checked round the vehicle, by the key of its name */
const CHECK_TEXT: Record<CheckId, string> = { tyres: 'checkTyres', front: 'checkFront', rear: 'checkRear', coupling: 'checkCoupling' };

/** The motorcycle of each class has its own build (render/bike.ts): moped, 125, 35 kW, the big one. */
function bikeVariant(kind: string): BikeVariant {
  return kind === 'moped' ? 'moped' : kind === 'motorcycle125' ? 'light' : kind === 'motorcycle35' ? 'mid' : 'big';
}

/** Which model a vehicle is drawn with: its kind of model – for a motorcycle, the build of its class. */
function modelKey(def: VehicleDef): string {
  return def.model === 'motorcycle' ? `motorcycle:${bikeVariant(def.kind)}` : def.model;
}

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
  /** the vehicle driven now (by its licence class), and the models of the vehicles made so far */
  private def: VehicleDef = VEHICLES.car;
  /**
   * the models of the vehicles driven so far, by modelKey (each motorcycle class has its own build) – the car's
   * from the start (without it, the first drive of class B made a motorcycle for the car: the model of a kind
   * not yet in here is made when it is first driven)
   */
  private readonly models = new Map<string, VehicleModel>([['car', this.car]]);
  /** the box trailer behind a car (class BE) */
  private carTrailer: CarTrailerModel | null = null;
  /** the car's centre display, for the HUD to draw the map on */
  private readonly carScreen = { canvas: this.car.mapCanvas, drawn: (): void => void (this.car.mapTexture.needsUpdate = true) };
  /** what the vehicle's lamps showed in the last picture (for the trailer's) */
  private lastVisual: CarVisualState | null = null;
  /** the truck with the trailer of the class CE (its yard tasks, the coupling) */
  private get isTruck(): boolean {
    return this.def.model === 'truck';
  }
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
   * A drive to places the player chose, or along a tour that was planned.
   * `active`: a demonstration drive – the car drives by itself, by the rules,
   * to watch how the way is driven; otherwise the player drives and is shown
   * the way.
   */
  private demo: {
    stops: SpawnJson[];
    index: number;
    driver: AutoDriver | null;
    active: boolean;
    look: number;
    remark: string;
    takeT: number;
    lost: number;
    /** when a way may be looked for again (after a search that found none) */
    searchAt: number;
    stuck: number;
    /** a tour: the ways to drive (world/routegraph.ts), the way they begin behind, and what it comes to */
    tour: { ways: number[]; from: number; metres: number; fresh: number; odo: number; set: boolean; line: Float32Array } | null;
  } | null = null;
  /** the road network as the route planner sees it, of a map in one piece (made when a way is first planned) */
  private routeGraph: RouteGraph | null = null;
  /**
   * The roads of the whole map – of a map whose road network comes in pieces
   * around the car: for routes and tours beyond what is loaded, for the big
   * map, for places far away.  Read in the background once the game runs.
   */
  private netIndex: NetIndex | null = null;
  private signalsDirty = false;
  private signalsBuilt = 0;
  /** the street of the address the car is being put at (to find the right road once the roads there are loaded) */
  private spawnStreet = '';
  private tourSeed = 1;
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
  /** the pedestrian lights: their poles (with the buttons) and their heads */
  private pedPoles: PedPole[] = [];
  private readonly pedHeads = new PedLightRenderer();
  /** inside the tram one rides in as a passenger */
  private readonly passengerView = new PassengerView();
  /** the ground beyond the map's tiles: the hills on the horizon */
  private readonly far = new FarTerrain();
  /** stops, platforms, people waiting, the overhead line and the tram signals around the camera */
  private transit!: TransitScene;
  // ------------------------------------------------- the aeroplane
  /** the aeroplane being flown (null: none), its model, and the airfields of the map with their firm ground */
  private aircraft: Aircraft | null = null;
  private planeModel: PlaneModel | null = null;
  private air: AirJson | null = null;
  private airGround: AirfieldGround | null = null;
  private airfieldView!: AirfieldRenderer;
  /** a flight is to begin once the runway is placed */
  private planePending = false;
  /** the throttle lever (0 … 1), the flap lever (0 … 3: 0°, 10°, 20°, 30°), the trim (−1 … 1), when it crashed */
  private readonly flight = { throttle: 0, flaps: 1, trim: 0.15, crashT: -1 };
  private readonly flightControls: FlightControls = { throttle: 0, elevator: 0, aileron: 0, rudder: 0, flaps: 0, trim: 0, brake: 0, parkingBrake: false, engineOn: true };
  /** the lines of the trams (null: the map has none) – and whether the departure boards still have to learn them */
  private lines: LinesJson | null = null;
  private lineStopsDirty = false;
  /** the rail traffic that was given the lines (a new one is made when the tracks are read) */
  private linesFor: RailTraffic | null = null;
  readonly collider = new SceneryCollider();
  readonly audio = new GameAudio();
  state: State = 'loading';
  cameraMode: CameraMode = 'cockpit';

  private last = 0;
  private time = 0;
  private acc = 0;
  private frames = 0;
  private fpsFrames = 0;
  private fpsSince = 0;
  private mirrorTurn = 0;
  private spawn: SpawnJson | null = null;
  private lesson: LessonDef | null = null;
  private targetIdx = 0;
  /** the road a lesson began on (its number in the map: the road itself may be dropped and loaded again on the way), or -1 */
  private homeEdge = -1;
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
  /**
   * The free camera: where it is (from the car, in the directions of the map –
   * it travels along with the car, but does not turn with it) and where it looks.
   */
  private readonly fc = { off: new THREE.Vector3(), yaw: 0, pitch: -0.3, ready: false };
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
  private autoTour = 0;
  private autoSelf = false;
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
    this.signals = new SignalSystem(world.signals, world.lightsOut);
    // (the green arrows of what is there already – a map in one piece; the pieces of a map in pieces get theirs as they come)
    markArrows(world, this.lanes, this.signals, world.allNodes);
    this.traffic = new Traffic(world, this.lanes, this.signals);
    this.rules = new RuleMonitor(world, this.lanes, this.signals, this.traffic);
    this.nav = new Navigator(this.lanes);
    this.ground = new WorldGround(world, app.tiles);
    this.signs = new SignRenderer(new URL('signs/', document.baseURI).href, app.renderer.capabilities.getMaxAnisotropy());
    await this.signs.init();
    this.signalHeads = new SignalRenderer(world, this.signals);
    this.collider.add({ key: 'signals', rings: null, ringCounts: null, segments: null, discs: this.signalHeads.poles });
    this.buildPedLights();
    this.transit = new TransitScene(world, (x, z, yRef) => this.footGround(x, z, yRef));
    this.airfieldView = new AirfieldRenderer((x, z) => this.groundHeight(x, z), (x, z) => !Number.isNaN(this.app.tiles.heightAt(x, z)));
    app.tiles.onTile((tile, loaded) => this.onTile(tile, loaded));
    app.scene.add(this.car.root, this.actors.group, this.railActors.group, this.signalHeads.group, this.pedHeads.group, this.passengerView.group, this.far.group, this.transit.group, this.airfieldView.group, this.yardScene.group, this.markers.group);
    this.fadeEl.className = 'fade';
    this.ui.append(this.fadeEl);
    this.yardFrame = world.json.yard ? new YardFrame(world.json.yard) : null;
    this.rail = new RailTraffic(world.json.rails ?? []);
    // The road network may come in pieces around the car: lanes, traffic and signals follow it.
    followMap(app.map, { lanes: this.lanes, traffic: this.traffic, signals: this.signals, changed: () => (this.signalsDirty = true) });
    if (app.map.pieces) {
      // … then the roads of the whole map (some megabytes: on a connection that asks to save data only
      // once they are needed) and the railway tracks are read while the menu is up
      const saving = (globalThis.navigator as unknown as { connection?: { saveData?: boolean } }).connection?.saveData === true;
      if (!saving || this.autoTour > 0 || this.autoDemo.length > 0 || this.autoMap) this.wantNet();
      void app.map.rails().then((rails) => {
        if (rails.length === 0) return;
        this.rail = new RailTraffic(rails);
        this.applySettings();
      });
      // the airfields: drawn on the ground, firm under an aeroplane's wheels, and the ends of their runways to take off from
      void app.map.air().then((json) => {
        if (!json) return;
        this.air = json;
        this.airGround = new AirfieldGround(this.ground, json.airfields);
        this.airfieldView.set(json.airfields);
        const ends: RunwayChoice[] = [];
        for (const f of json.airfields) {
          const field = f.icao ? `${f.name || f.icao} (${f.icao})` : f.name;
          for (const r of f.runways) {
            if (Math.hypot(r.x2 - r.x1, r.z2 - r.z1) < 300) continue;
            for (const second of [false, true]) ends.push({ field, end: runwayEnd(r, second), ...runwayStart(r, second) });
          }
        }
        this.hud.setRunways(ends);
      });
      // the lines of the trams: which way they run and where they call (with the tracks, the departure boards know them)
      void app.map.lines().then((json) => {
        this.lines = json;
        this.lineStopsDirty = true;
      });
      // the ground of the whole region, coarse: what lies beyond the tiles
      void app.map.far().then((buf) => {
        const f = buf ? parseFar(buf) : null;
        if (f) this.far.set(f);
      });
      // the stops (their names, poles and platforms): the tram's start points in the menu, what is drawn at a stop
      void app.map.stops().then((json) => {
        if (!json) return;
        this.stops = new Stops(json);
        this.transit.setStops(this.stops);
        this.hud.setTramStops(this.stops.tramPlaces().map((p) => ({ name: p.name, town: p.town, x: p.x, z: p.z })));
        // with the stops, city buses come with the traffic: they call at the stops on their way
        this.laneStops.clear();
        this.traffic.busStops = (lane) => this.busStopsOn(lane);
      });
    }
    this.car.root.visible = false;
    loading.remove();

    this.hud = new Hud(this.ui, this.settings, world);
    this.input = new Input(app.canvas, this.settings);
    this.input.onAction((a) => this.onAction(a));
    this.hud.onStart = (req) => this.begin(req.mode, req.spawn, false, req.address, req.stop, req.runway);
    this.hud.onResume = () => this.resume();
    this.hud.onReality = () => this.openReality();
    this.hud.onGetOut = () => {
      if (Math.abs(this.vehicle.speed) > 0.3 || this.walker || this.demo?.active || this.task) return;
      this.resume();
      this.getOut();
    };
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
    this.hud.where = () => (this.vehicle ? { x: this.mpos[0], z: this.mpos[2] } : null);
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
      net: () => this.netIndex,
      spotAt: (x, z) => this.roadSpot(x, z, '', 160),
      canTeleport: () => !this.lesson,
      teleport: (spot) => this.teleportSpot(spot),
      loadAddresses: () => this.loadAddresses(),
      spotOf: (hit) => this.spawnAt(hit),
      startTrip: (stops, self, tour) => this.startTrip(stops, self, tour),
      planTour: (metres, end, progress) => this.planTour(metres, end, progress),
      tramways: () => this.tramways(),
      tourPrefs: () => this.settings.tourPrefs,
      setTourPrefs: (p) => {
        this.settings.tourPrefs = { ...p };
        saveSettings(this.settings);
      },
      roadsKnown: () => this.routeGraphNow() !== null,
      tripActive: () => this.demo !== null,
      endTrip: () => this.endDemo('ended'),
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
    if (qq === 'low' || qq === 'medium' || qq === 'high' || qq === 'ultra') {
      this.settings.quality = qq;
      this.settings.graphics = { ...GRAPHICS_PRESETS[qq] };
      if (qq === 'low') this.settings.render3d = 0.7;
    }
    const qm = q.get('mirrors');
    if (qm === 'off' || qm === 'alternate' || qm === 'full') this.settings.mirrors = qm;
    if (q.get('traffic')) this.settings.traffic = Number(q.get('traffic'));
    // ?vehicle=truck|car chooses the vehicle for this visit
    const qv = q.get('vehicle');
    const kind = vehicleKind(qv);
    if (kind) this.settings.vehicle = kind;
    // ?onfoot=1: this visit's drives begin beside the vehicle (the setting itself is not changed)
    if (q.get('onfoot') === '1') this.settings.startOutside = true;
    this.applySettings();

    // developer / test shortcuts: ?start=<mode>&spawn=<n>&view=chase&auto=<throttle>&cam=x,y,z,yaw,pitch&look=yaw,pitch
    const view = q.get('view');
    this.cameraMode = view === 'chase' || view === 'cockpit' || view === 'free' ? view : this.settings.view;
    this.input.resetLook(this.cameraMode === 'chase', this.cameraMode === 'free');
    const cam = q.get('cam');
    if (cam) {
      const c = cam.split(',').map(Number);
      this.cameraMode = 'dev';
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
    // ?demo=x,z;x,z starts a demonstration drive to these places of the map once the drive has started,
    // ?tour=<km> one along a tour of the streets of that length; with &self=1 the player drives and is shown the way
    this.autoDemo = (q.get('demo') ?? '')
      .split(';')
      .filter((p) => p.includes(','))
      .map((p) => p.split(',').map(Number));
    this.autoTour = Number(q.get('tour') ?? 0) || 0;
    this.autoSelf = q.get('self') === '1';
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
      void this.loadAddresses().then((ix) => this.begin(start, Number(q.get('spawn') ?? 0), true, ix?.search(addr, 1, app.world.json.spawns[Number(q.get('spawn') ?? 0)] ?? null)[0]));
    } else if (start) this.begin(start, Number(q.get('spawn') ?? 0), true);
    else this.toMenu();
  }

  private debugLook: [number, number] | null = null;
  private inputMode: 'touch' | 'keys' = 'keys';
  private addressIndex: Promise<AddressIndex | null> | null = null;
  private mainSet: Set<number> | null = null;

  private netAsked = false;
  /**
   * Read the roads of the whole map (once): for ways to places far away, for
   * tours and for the large map.  Until they are there, only the roads around
   * the car are known.
   */
  private wantNet(): void {
    if (this.netAsked || !this.app.map.pieces) return;
    this.netAsked = true;
    void this.app.map
      .net()
      .then((net) => (net ? NetIndex.build(net) : null))
      .then((index) => {
        if (!index) return;
        this.netIndex = index;
        this.nav.net = index.graph;
      })
      .catch((err: unknown) => {
        // (asked again the next time they are needed)
        this.netAsked = false;
        console.warn('the road network of the whole map could not be read', err);
      });
  }

  /** The way to the nearest stretch of motorway that can be reached, through the roads of the whole map (for the motorway lesson far from one). */
  private waysToMotorway(g: RouteGraph, lane: Lane, x: number, z: number): number[] | null {
    const net = this.netIndex?.net;
    if (!net) return null;
    const near: Array<[number, number]> = [];
    for (let e = 0; e < net.edgeCls.length; e++) {
      if (net.edgeCls[e] !== CLS.MOTORWAY || net.edgeLen[e] < 250) continue;
      const d = Math.hypot(net.nodeX[net.edgeA[e]] - x, net.nodeZ[net.edgeA[e]] - z);
      // (a lesson, not a journey)
      if (d < 60000) near.push([e, d]);
    }
    near.sort((a, b) => a[1] - b[1]);
    for (const [e] of near.slice(0, 12)) {
      const ways = quickestToEdge(g, wayOf(lane), e);
      if (ways && ways.length > 0) return ways;
    }
    return null;
  }

  /** May the car be put on this lane, or a way be planned from it: is it part of the network one can drive around in? */
  private usableLane(): ((l: Lane) => boolean) | undefined {
    if (this.app.map.pieces) {
      const index = this.netIndex;
      return index ? (l) => index.main[wayOf(l)] === 1 : undefined;
    }
    const set = (this.mainSet ??= mainNetwork(this.app.world, this.lanes));
    return (l) => set.has(l.id);
  }

  /** The road network for planning ways: that of the whole map if it comes in pieces (null until it is read). */
  private routeGraphNow(): RouteGraph | null {
    if (this.app.map.pieces) return this.netIndex?.graph ?? null;
    return (this.routeGraph ??= routeGraphOf(this.lanes));
  }

  /**
   * A place on a road near (x, z) – to put the car at, or to drive to.
   * Where the roads are loaded it lies in a lane; elsewhere it is taken from
   * the overview of the whole map (`rough`) and put right when the car gets there.
   */
  private roadSpot(x: number, z: number, street: string, maxDist: number): SpawnJson | null {
    const world = this.app.world;
    if (this.app.map.ready(x, z, maxDist + 60)) return findRoadSpot(world, this.lanes, x, z, street, maxDist, this.usableLane());
    const index = this.netIndex;
    if (!index) return null;
    const hit = index.nearest(x, z, maxDist, (e) => index.main[e * 2] === 1 || index.main[e * 2 + 1] === 1);
    if (!hit) return null;
    // (along the road, the way it may be driven)
    return { name: '', x: hit.x, z: hit.z, yaw: index.main[hit.edge * 2] ? hit.yaw : hit.yaw + Math.PI, kind: 'street', rough: true };
  }

  /** The road (its number in the map) nearest to a place, or -1. */
  private edgeNear(x: number, z: number): number {
    // (from the roads of the whole map if they are known – and of these a road of the network one can
    // drive around in, if there is one: beside it may lie a yard or a path no way leads to)
    const index = this.netIndex;
    if (index) {
      const hit = index.nearest(x, z, 150, (e) => index.main[e * 2] === 1 || index.main[e * 2 + 1] === 1) ?? index.nearest(x, z, 150);
      if (hit) return hit.edge;
    }
    if (this.app.map.ready(x, z, 120)) return this.app.world.nearestRoad(x, z, 60, 0, this.hit) && this.hit.edge ? this.hit.edge.id : -1;
    return -1;
  }
  private autoReality = '';
  private autoNotice = '';
  private realityFrames = 0;
  private reality!: RealityPanel;

  private onTile(tile: LoadedTile, loaded: boolean): void {
    if (loaded) {
      // What stands in a lane (a fault of the map) is taken out of the way: sign posts are moved
      // beside the lane, lamps dropped, walls lose the pieces that reach in.  Maps built since do
      // this themselves and mark their tiles.
      const clear = !tile.header.clr;
      if (clear) {
        clearSigns(this.lanes, tile.header.signs);
        clearObjects(this.lanes, tile.header.objects);
      }
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
          if (clear && postInLane(this.lanes, trees[i], trees[i + 1], trees[i + 2])) continue;
          discs.push(trees[i], trees[i + 1], trees[i + 2], kind === 3 ? 0.12 : 0.22);
        }
      }
      const rings = tile.data.get('collPts') as Float32Array | null;
      const ringCounts = tile.data.get('collCnt') as Uint16Array | null;
      const segments = tile.data.get('collSeg') as Float32Array | null;
      if (clear) this.collider.add({ key: tile.key, rings: null, ringCounts: null, segments: clearWalls(this.lanes, rings, ringCounts, segments), discs });
      else this.collider.add({ key: tile.key, rings, ringCounts, ringSkip: tile.data.get('collSkip') as Uint8Array | null, segments, discs });
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
    // The graphics: what the preset (or the advanced settings) chose – and, apart from it, the
    // resolutions: how sharp on a sharp screen, which share of it the 3D picture takes, how big the interface is.
    const gx = s.graphics;
    app.pixelRatioCap = s.pixelCap;
    app.renderScale = s.render3d;
    app.setShadows(gx.shadows === 'off' ? 0 : gx.shadows === 'near' ? 1536 : 3072, gx.shadows === 'far' ? 120 : 55);
    app.tiles.viewRadius = gx.viewDistance;
    app.tiles.setFacades(gx.facades);
    // the ground beyond the tiles, as far as asked: then the haze lies over the far hills, not over the near streets
    const farView = gx.farView;
    this.far.group.visible = farView > 0;
    this.far.radius = farView;
    this.far.inner = Math.max(300, app.tiles.viewRadius - 200);
    app.sky.fog.near = app.tiles.viewRadius * (farView > 0 ? 0.6 : 0.3);
    app.sky.fog.far = farView > 0 ? Math.max(app.tiles.viewRadius * 1.6, farView * 0.95) : app.tiles.viewRadius * 1.05;
    app.camera.far = Math.max(4500, farView * 1.1);
    app.camera.updateProjectionMatrix();
    this.props.density = gx.propDensity;
    this.props.setShadows(gx.propShadows);
    this.ui.style.setProperty('zoom', String(s.uiScale));
    app.resize();
    for (const m of this.car.mirrors) m.setEnabled(s.mirrors !== 'off');
    this.car.setCabinOpacity(s.cabinOpacity);
    for (const model of this.models.values()) {
      if (model === this.car) continue;
      for (const m of model.mirrors) m.setEnabled(s.mirrors !== 'off');
      model.setCabinOpacity(s.cabinOpacity);
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
    // (a tour that is left for the menu is kept as far as it was driven)
    if (this.demo?.tour) this.endDemo('ended');
    this.state = 'menu';
    this.demo = null;
    this.endTasks();
    this.car.root.visible = false;
    for (const model of this.models.values()) model.root.visible = false;
    if (this.carTrailer) this.carTrailer.group.visible = false;
    if (this.truck) {
      this.truck.trailer.visible = false;
    }
    this.input.enabled = false;
    this.hud.setHudVisible(false);
    this.audio.suspend();
    this.hud.showMenu(this.app.world.json.spawns);
    // once after an update: what is new (to whoever played an earlier version)
    if (this.showNewsOnce) {
      this.showNewsOnce = false;
      this.hud.showNews(() => this.hud.showMenu(this.app.world.json.spawns));
    }
    if (!this.spawn) {
      // show the town behind the menu
      const sp = this.app.world.json.spawns[0];
      if (sp) this.menuFocus.set(sp.x, 0, sp.z);
    }
  }

  private readonly menuFocus = new THREE.Vector3();

  /** The model a kind of vehicle is drawn with – every kind named (a new one cannot end up as somebody else's). */
  private makeModel(def: VehicleDef): VehicleModel {
    const mk = def.model;
    switch (mk) {
      case 'car':
        return this.car;
      case 'truck':
        return (this.truck = new PlayerTruck());
      case 'truckLight':
        return new PlayerTruck(LIGHT_TRUCK);
      case 'bus':
        return new PlayerBus();
      case 'minibus':
        return new PlayerBus(MINIBUS);
      case 'tractor':
        return new PlayerTractor();
      case 'tram':
        return new TramCab();
      case 'walker':
        return new WalkerModel();
      case 'plane':
        return this.planeAdapter();
      case 'motorcycle':
        return new PlayerBike(bikeVariant(def.kind));
      default: {
        const none: never = mk;
        return none;
      }
    }
  }

  /** The vehicle the player sits in: the car or the truck. */
  private get model(): VehicleModel {
    return this.models.get(modelKey(this.def)) ?? this.car;
  }

  private showModel(on: boolean): void {
    this.car.root.visible = on && this.def.model === 'car';
    const key = modelKey(this.def);
    for (const [k, model] of this.models) if (model !== this.car) model.root.visible = on && k === key;
    if (this.carTrailer) this.carTrailer.group.visible = on && !!this.def.trailer && this.def.model !== 'truck';
    if (this.truck) {
      this.truck.trailer.visible = on && this.def.kind === 'truck';
    }
  }

  // ------------------------------------------------- class CE: truck and trailer
  /** A place on a road wide enough to start with a combination of 16 m, near a start point. */
  private truckSpot(near: SpawnJson): SpawnJson {
    const wide = (e: Edge): boolean => (e.cls === CLS.PRIMARY || e.cls === CLS.SECONDARY || e.cls === CLS.TERTIARY) && e.len - e.cutA - e.cutB > 60;
    const spot = findRoadSpot(this.app.world, this.lanes, near.x, near.z, '', 900, this.usableLane(), wide, 20);
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
      // (nothing to do with the truck just now: it is the driver's turn on foot)
      !st.todo,
    );
    this.lessonLine = st.todo ? tr(`ce.do.${st.todo}`, lang) : choices.length ? tr('ce.onFoot', lang) : tr('ce.do.uPark', lang);
    this.taskSub = `${proc.done.size} / ${COUPLING_STEPS.length}`;
    if (st.state === 'done') this.taskDone(true);
  }

  /** The address list (house numbers of the map), fetched when somebody first searches. */
  private loadAddresses(): Promise<AddressIndex | null> {
    const map = this.app.map;
    this.addressIndex ??= map
      .json<AddressJson>('addresses.json.gz')
      .then((a) => a ?? map.json<AddressJson>('addresses.json'))
      .then((a) => (a ? new AddressIndex(a) : null))
      .catch(() => null);
    return this.addressIndex;
  }

  /** The spot on the road in front of an address, as a starting point. */
  private spawnAt(hit: AddressHit): SpawnJson | null {
    const spot = this.roadSpot(hit.x, hit.z, hit.street, 220);
    if (spot) return { ...spot, name: hit.label };
    // Neither the roads there nor those of the whole map are read yet: the house itself, for now –
    // the car is put into a lane of its street once the roads around it are there (tryPlace).
    if (this.app.map.pieces && !this.netIndex && !this.app.map.ready(hit.x, hit.z, 280)) return { name: hit.label, x: hit.x, z: hit.z, yaw: 0, kind: 'street', rough: true };
    return null;
  }

  /** Free drive: jump to an address (from the pause menu). */
  private teleportTo(hit: AddressHit): void {
    if (this.state !== 'pause' || this.lesson) return;
    const spot = this.spawnAt(hit);
    this.spawnStreet = hit.street;
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
    if (this.def.kind === 'tram') {
      // The tram is one of the rail vehicles that were just cleared away: it is put on the tracks anew, at the
      // stop nearest to the place chosen – as when a drive begins (tryPlace).  (Before, its driver kept running
      // a tram that was no longer drawn: only the cab was to be seen.)
      this.tram = null;
      this.tramAt = null;
      this.tramStopName = '';
      this.tramWait = this.time;
    }
    // on foot: on the pavement there (and nobody rides a tram or a bus any more) – somebody who got out of the
    // vehicle gets out again beside it there (before, they stayed behind, tied to a vehicle far away)
    if (this.walker && this.def.kind !== 'pedestrian') {
      this.leaveWalk();
      this.footAfterJump = true;
    }
    this.riding = null;
    this.busRide = null;
    this.railActors.hidden = null;
    this.passengerView.show(null);
    this.vehicle.vel.fill(0);
    this.vehicle.angVel.fill(0);
    this.input.c.handbrake = this.def.kind === 'tram' ? 0 : 1;
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
    this.wantNet();
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

  // --------------------------------------- drives to places, tours, demonstrations
  /** The lane nearest to a place that goes the way `yaw` points. */
  private laneAt(x: number, z: number, yaw: number): Lane | null {
    const proj = this.proj;
    const smp = this.smp;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let lane: Lane | null = null;
    let best = 40;
    this.app.world.edgesInBox(x - 20, z - 20, x + 20, z + 20, (e) => {
      const el = this.lanes.edgeLanes[e.id];
      projectOnPolyline(e.pl, x, z, proj);
      for (const l of [...el.fwd, ...el.back]) {
        lanePoint(l, Math.max(0, Math.min(l.len, l.dir > 0 ? proj.s - l.s0 : l.s0 - proj.s)), smp);
        const score = Math.hypot(smp.x - x, smp.z - z) + (1 - (smp.tx * fx + smp.tz * fz)) * 6;
        if (score < best) {
          best = score;
          lane = l;
        }
      }
    });
    return lane;
  }

  /**
   * A tour of about `metres` through as many different streets as possible:
   * from where the car stands back to there, or on to `end`.
   */
  private async planTour(metres: number, end: SpawnJson | null, progress?: (share: number) => void): Promise<TourPreview | null> {
    this.wantNet();
    const v = this.vehicle;
    v.getModelPosition(this.mpos);
    const from = this.currentLane() ?? this.laneAt(this.mpos[0], this.mpos[2], v.yaw);
    if (!from) return null;
    const g = this.routeGraphNow();
    if (!g) return null;
    const start = wayOf(from);
    // It ends on the road it is meant to end on – whichever way that road is then driven: back
    // into a car park with one way in and out, the tour arrives facing the other way.
    const endEdge = end ? this.edgeNear(end.x, end.z) : from.edge.id;
    if (endEdge < 0) return null;
    const last = end ? endEdge * 2 : start;
    const ends = [last, last ^ 1].filter((w) => g.len[w] > 0);
    const seed = this.tourSeed++;
    let plan: TourPlan | null = null;
    // what the driver wishes: roads to leave out, the kind of street to look for
    const wish = this.tourWishes(g);
    // (a slice at a time: a long tour takes a while, and the map shows how far the planning is)
    for (const goal of ends) {
      plan = await planTourInSlices(g, start, goal, metres, { budgetMs: 500, seed, progress, ...wish });
      if (plan) break;
    }
    let canTurn = false;
    for (let k = g.first[start]; k < g.first[start + 1]; k++) if (g.to[k] === (start ^ 1)) canTurn = true;
    if (!plan && canTurn) {
      // from a street with no way on (a cul-de-sac): turn round at its end first
      for (const goal of ends) {
        const back = await planTourInSlices(g, start ^ 1, goal, Math.max(0, metres - g.len[start]), { budgetMs: 500, seed, progress, ...wish });
        if (!back) continue;
        plan = { ways: [start ^ 1, ...back.ways], metres: back.metres + g.len[start], fresh: back.fresh, again: back.again + g.len[start], valued: back.valued };
        break;
      }
    }
    if (!plan || plan.ways.length === 0) return null;
    // its line on the map: from the car along the roads, each in the direction it is driven
    const line: number[] = [this.mpos[0], this.mpos[2]];
    const edges = this.app.world.edges;
    const net = this.netIndex?.net ?? null;
    const add = (w: number, fromS: number): void => {
      const e = edges[w >> 1];
      if (!e) {
        // (a road that is not loaded: its course from the overview of the map)
        const c = net ? netPolyline(net, w >> 1) : [];
        if ((w & 1) === 0) for (let i = 0; i < c.length; i += 2) line.push(c[i], c[i + 1]);
        else for (let i = c.length - 2; i >= 0; i -= 2) line.push(c[i], c[i + 1]);
        return;
      }
      const p = e.pl;
      const n = p.cum.length;
      for (let i = 0; i < n; i++) {
        const k = (w & 1) === 0 ? i : n - 1 - i;
        // (of the road the car stands on, only what lies ahead)
        if (fromS >= 0 && ((w & 1) === 0 ? p.cum[k] < fromS : p.cum[k] > fromS)) continue;
        line.push(p.pts[k * 3], p.pts[k * 3 + 2]);
      }
    };
    projectOnPolyline(from.edge.pl, this.mpos[0], this.mpos[2], this.proj);
    add(start, this.proj.s);
    for (const w of plan.ways) add(w, -1);
    return {
      plan,
      line: Float32Array.from(line),
      from: start,
      end: end ?? { name: '', x: this.mpos[0], z: this.mpos[2], yaw: v.yaw, kind: 'street' },
    };
  }

  /**
   * Drive to these places, one after the other, from where the car stands –
   * or along a tour.  `self`: the player drives and is shown the way;
   * otherwise it is a demonstration drive: the car drives by itself.
   */
  private startTrip(stops: SpawnJson[], self: boolean, tour: TourPreview | null): void {
    if (this.lesson || (stops.length === 0 && !tour) || (this.state !== 'map' && this.state !== 'drive' && this.state !== 'pause')) return;
    // (on foot beside the vehicle: back into the seat first; a tram is driven by hand only)
    if (this.walker) this.leaveWalk();
    if (this.tram) {
      // the tram follows its tracks: "by itself" is its demonstration drive (the places chosen do not matter to it)
      if (!self) {
        this.tramAuto = true;
        this.tramTake = 0;
        if (this.state === 'map') this.closeMap();
        this.hud.message(tr('tramAutoOn', this.settings.lang));
      }
      return;
    }
    if (this.state === 'map') {
      this.mapFrom = 'drive';
      this.closeMap();
    } else if (this.state === 'pause') this.resume();
    let driver: AutoDriver | null = null;
    if (!self) {
      // the driver has no hand for a gear lever: the car gets the automatic gearbox for it
      if (this.vehicle.spec.transmission !== 'automatic') {
        const old = this.vehicle;
        old.getModelPosition(this.mpos);
        const spec = this.def.spec('automatic', powerOf(this.def, this.settings.powers));
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
      driver = new AutoDriver(this.app.world, this.signals, this.rules, this.traffic, {
        spec: v.spec,
        front: this.def.outline.front,
        truck: this.def.heavy,
        caps: this.def.caps,
      });
    }
    this.nav.clear();
    this.hud.routeLanes = [];
    this.demo = {
      stops: tour ? [tour.end] : [...stops],
      index: 0,
      driver,
      active: !self,
      look: 0,
      remark: '',
      takeT: 0,
      lost: 0,
      searchAt: 0,
      stuck: 0,
      tour: tour ? { ways: tour.plan.ways, from: tour.from, metres: tour.plan.metres, fresh: tour.plan.fresh, odo: this.vehicle.odometer, set: false, line: tour.line } : null,
    };
    this.hud.clearNotices();
  }

  /** The drive is over: the car has arrived, the player takes it over, or there is no way to go on. */
  private endDemo(why: 'arrived' | 'taken' | 'lost' | 'ended'): void {
    const demo = this.demo;
    if (!demo) return;
    this.demo = null;
    // a tour is kept with its date – also one given up half-way (but not one hardly begun)
    if (demo.tour) {
      const driven = this.vehicle.odometer - demo.tour.odo;
      if (driven > 200) saveTour({ date: new Date().toISOString(), planned: Math.round(demo.tour.metres), driven: Math.round(driven), fresh: Math.round(demo.tour.fresh), done: why === 'arrived', line: thinLine(demo.tour.line), prefs: { ...this.settings.tourPrefs } });
    }
    this.nav.clear();
    this.hud.routeLanes = [];
    this.rules.allowed = null;
    const c = this.input.c;
    c.indicator = 0;
    const lang = this.settings.lang;
    if (why === 'arrived') {
      // (the car that drove by itself is left standing; the player's own stays in the player's hands)
      if (demo.active) c.handbrake = 1;
      this.audio.click('chime');
      const km = (m: number): string => formatUnit(m / 1000, 'kilometer', lang, 1);
      if (demo.tour) this.hud.message(tr('tourDone', lang), tr('tourResult', lang, { km: km(this.vehicle.odometer - demo.tour.odo), fresh: km(demo.tour.fresh), again: km(Math.max(0, demo.tour.metres - demo.tour.fresh)) }));
      else this.hud.message(tr('demoArrived', lang));
    } else if (why === 'lost') {
      if (demo.active) c.handbrake = 1;
      this.hud.message(tr('demoNoRoute', lang));
    } else if (why === 'ended') {
      if (demo.active) c.handbrake = 1;
      this.hud.message(tr('tripEnded', lang));
    } else this.hud.message(tr('demoTaken', lang), tr('demoTakenSub', lang));
  }

  /** Where the demonstration drive is heading: the route to the next of its places. */
  private updateDemo(dt: number, p: PlayerState): void {
    const demo = this.demo!;
    const lane = this.currentLane();
    const cmd = demo.active && demo.driver ? demo.driver.cmd : null;
    const lang = this.settings.lang;
    // The end of a street the way leads back out of: the car is turned round on the spot.
    // (Turning in the road means going back and forth, which the driver of this drive does not do.)
    if (cmd?.turnRound) {
      const to = cmd.turnRound.to;
      lanePoint(to, Math.min(3, to.len / 2), this.smp);
      const y = this.app.world.surfaceAt(this.smp.x, this.smp.z, this.smp.y + 1.5, this.hit) ? this.hit.y : this.smp.y;
      this.putOnRoad({ x: this.smp.x, y, z: this.smp.z, yaw: Math.atan2(-this.smp.tx, -this.smp.tz) });
      this.camSnap = true;
      this.hud.message(tr('demoTurned', lang));
      return;
    }
    // Standing, and not for a light, a line or traffic: something is in the way that the driver
    // cannot pass (a fault of the map), or the car has left the road.  It is put back into its
    // lane a little further on.  (Waiting for others who do not move either: after a long while, too.)
    if (!cmd || Math.abs(p.speed) > 0.3) demo.stuck = 0;
    else if (!this.nav.busy) demo.stuck = 0;
    else if (cmd.waiting && lane) demo.stuck += cmd.remark === 'red' ? 0 : dt * 0.12;
    else demo.stuck += dt;
    if (demo.stuck > 7) {
      demo.stuck = 0;
      const g = lane ? { x: p.x, z: p.z, yaw: p.yaw } : this.lastGood;
      const spot = this.freeSpot(g.x, g.z, g.yaw, 8);
      if (spot) {
        this.putOnRoad(spot);
        this.camSnap = true;
        this.hud.message(tr('demoRescued', lang));
        return;
      }
      if (!lane) {
        this.endDemo('lost');
        return;
      }
    }
    if (!lane) {
      // not on a road of the network (a yard, a field): there is no way from here
      demo.lost += dt;
      if (demo.lost > 4 && !this.nav.busy) this.endDemo('lost');
      return;
    }
    const last = demo.index >= demo.stops.length - 1;
    const stop = demo.stops[demo.index];
    if (!this.nav.busy) {
      let found = false;
      const tour = demo.tour;
      const g = this.routeGraphNow();
      // (the roads of the whole map are still being read: a moment)
      if (!g) return;
      // (a search that finds no way runs through the roads of the whole map: not every picture, then)
      if (this.time < demo.searchAt) return;
      {
        this.nav.net = g;
        const here = wayOf(lane);
        let ways: number[] | null = null;
        if (tour) {
          // the tour was planned from a road: if the car is on another one by now, to that one first
          const lead = here === tour.from ? [] : quickest(g, here, tour.from);
          ways = lead ? [...lead, ...tour.ways] : null;
        } else {
          const edge = this.edgeNear(stop.x, stop.z);
          ways = edge < 0 ? null : edge === lane.edge.id ? [] : quickestToEdge(g, here, edge);
        }
        if (ways) {
          this.nav.setWays(ways, lane, tour !== null);
          if (tour) tour.set = true;
          found = true;
        }
      }
      if (!found) {
        // no way there from here (yet): try again shortly – three times –, then give up
        this.nav.clear();
        demo.searchAt = this.time + 1;
        demo.lost += 1.2;
        if (demo.lost > 3) this.endDemo('lost');
        return;
      }
      demo.lost = 0;
      this.hud.routeLanes = this.nav.routeLanes;
      this.rules.allowed = new Set(this.nav.routeLanes.map((l) => l.edge));
    }
    // where the car that drives by itself comes to a halt: at the last place – on a tour, which may
    // pass that place before, only once the end is near
    if (demo.driver) demo.driver.halt = last && (!demo.tour || this.nav.left <= 1) ? { x: stop.x, z: stop.z } : null;
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
    } else if (h.done && !demo.active) this.endDemo('arrived');
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

  private begin(mode: string, spawnIdx: number, skipIntro = false, address?: AddressHit, stop?: TramStopChoice, runway?: RunwayChoice): void {
    if (VEHICLES[this.settings.vehicle]?.kind === 'plane' && !runway && !this.air && !this.airAwaited && this.app.map.pieces) {
      // (a flight asked for by a link before the airfields were read: it begins once they are)
      this.airAwaited = true;
      void this.app.map.air().then(() => this.begin(mode, spawnIdx, skipIntro, address, stop, runway));
      return;
    }
    const world = this.app.world;
    this.audio.start();
    this.spawnStreet = address?.street ?? '';
    this.spawn = (address ? this.spawnAt(address) : null) ?? world.json.spawns[Math.max(0, Math.min(world.json.spawns.length - 1, spawnIdx))] ?? { name: '', x: 0, z: 0, yaw: 0, kind: 'street' };
    // (the aeroplane: at the end of the runway chosen in the menu – the first of the map's if none was)
    this.aircraft = null;
    this.planePending = false;
    this.ui.classList.remove('flying');
    if (VEHICLES[this.settings.vehicle]?.kind === 'plane') {
      const r = runway ?? this.firstRunway();
      if (r) {
        this.spawn = { name: `${r.field} ${r.end}`, x: r.x, z: r.z, yaw: r.yaw, kind: 'street' };
        this.planePending = true;
      }
    }
    // (the tram: at the stop chosen in the menu – and, for a demonstration drive, driving by itself)
    this.tramStopName = '';
    this.tramAuto = false;
    this.tramAutoPending = mode === 'demo' && VEHICLES[this.settings.vehicle]?.kind === 'tram';
    if (stop && VEHICLES[this.settings.vehicle]?.kind === 'tram') {
      this.spawn = { name: stop.name, x: stop.x, z: stop.z, yaw: 0, kind: 'street' };
      this.tramStopName = stop.name;
    }
    this.lesson = LESSONS.find((l) => l.id === mode) ?? null;
    this.demo = null;
    if (this.walker) this.leaveWalk();
    this.footAfterJump = false;
    // (nobody rides a tram or a bus any more)
    this.riding = null;
    this.busRide = null;
    // (the bus on a line: its stops from here on)
    this.busService = this.lesson?.kind === 'bus' ? new BusService() : null;
    this.busNav = '';
    this.railActors.hidden = null;
    this.passengerView.show(null);
    this.doorT = -1;
    this.fadeEl.classList.remove('on');
    // ("demo" and "tour" are free drives that begin with the map open, for planning – the tram's drives by itself at once)
    this.planDemo = (mode === 'demo' || mode === 'tour') && !this.tramAutoPending;
    this.hud.canTeleport = !this.lesson;
    this.hud.canFinish = !this.lesson;
    this.keepClock = false;
    this.path.breakLine();
    // the car, or the truck with its trailer (class CE)
    this.def = VEHICLES[this.lesson?.vehicle ?? this.settings.vehicle] ?? VEHICLES.car;
    // (a tractor may not go on the motorway: its lesson is driven with the car)
    if (this.def.noMotorway && this.lesson?.id === 'motorway') this.def = VEHICLES.car;
    // the tram: at the stop nearest to the place chosen (on the tracks of Kassel and Baunatal)
    this.tram = null;
    this.tramAt = null;
    // (the tracks are read a moment after the map: the stop to start at is found when they are there – tryPlace)
    this.tramWait = this.def.kind === 'tram' ? this.time : -1;
    if (this.def.kind === 'tram') this.hud.canTeleport = false;
    // (ways for the truck with its trailer avoid turns that double back within a few metres)
    this.lanes.longVehicle = this.def.long;
    this.lanes.noMotorway = this.def.noMotorway;
    routeFor.noMotorway = this.def.noMotorway;
    const spec = this.def.spec(this.settings.transmission, powerOf(this.def, this.settings.powers));
    this.vehicle = new Vehicle(spec, this.ground);
    if (!this.models.has(modelKey(this.def))) {
      // the model of a vehicle is made when it is first driven
      const m = this.makeModel(this.def);
      this.models.set(modelKey(this.def), m);
      this.app.scene.add(m.root);
      if (this.truck && m === this.truck) this.app.scene.add(this.truck.trailer);
      for (const mirror of m.mirrors) mirror.setEnabled(this.settings.mirrors !== 'off');
      m.setCabinOpacity(this.settings.cabinOpacity);
    }
    // (the box trailer behind a car, a 7.5-tonner or a bus; the truck of class CE has its own)
    if (this.def.trailer && this.def.model !== 'truck' && !this.carTrailer) {
      this.carTrailer = new CarTrailerModel();
      this.app.scene.add(this.carTrailer.group);
    }
    this.trailer = this.def.trailer ? new Trailer(this.def.trailer, this.ground) : null;
    this.hud.gearbox = spec.transmission === 'automatic' && this.def.model !== 'car' && this.def.model !== 'motorcycle' ? 'automatic' : null;
    this.endTasks();
    // the camera stands further back for 16 m of vehicle
    this.input.c.lookZoom = this.def.zoom;
    this.input.zoomMax = this.def.zoomMax;
    this.collider.setShape(this.def.circles, this.def.radius);
    this.rules.setVehicle(this.def.caps, this.def.capFault, this.def.heavy, this.def.noMotorway);
    this.taskFailed = false;
    this.roadSpawn = this.spawn;
    this.tasksLeft = this.isTruck && this.yardFrame && this.lesson?.tasks ? [...this.lesson.tasks] : [];
    this.taskCount = this.tasksLeft.length;
    if (this.tasksLeft.length > 0) this.nextTask();
    else if (this.def.long && !address) this.spawn = this.truckSpot(this.spawn);
    this.input.setSteering(spec.wheelbase, spec.maxWheelAngle);
    this.input.setAutomatic(spec.transmission === 'automatic');
    const c = this.input.c;
    c.handbrake = 1;
    c.ignition = true;
    c.indicator = 0;
    c.hazard = false;
    // the basics lesson starts with a cold car; everything else is ready to go
    const cold = this.lesson?.kind === 'basics';
    // (on a motorcycle there is no belt: the helmet is on)
    c.seatbelt = !cold || this.def.model === 'motorcycle';
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
    this.homeEdge = -1;
    this.state = 'placing';
    this.showModel(false);
    this.hud.showLoading(tr('loadingTiles', this.settings.lang));
    const lang = this.settings.lang;
    const caps = this.def.caps;
    const note = this.lesson?.kind === 'route' && (caps || this.def.noMotorway) ? `${caps ? tr('lesson.capNote', lang, { vehicle: tr(this.def.name, lang), rural: caps.rural, motorway: caps.motorway }) : tr('lesson.slowNote', lang, { vehicle: tr(this.def.name, lang), max: this.def.governed })} ` : '';
    this.pendingIntro = this.lesson && !skipIntro ? { title: lessonTitle(this.lesson.id, lang), text: note + lessonIntro(this.lesson.id, lang) } : null;
  }

  private pendingIntro: { title: string; text: string } | null = null;

  /** Called every frame while waiting for the terrain under the start point. */
  private tryPlace(): void {
    if (this.tramWait >= 0) {
      // the tram: at the stop nearest to the place chosen – once the tracks are read
      if (this.rail.net.paths.length === 0) {
        if (this.time - this.tramWait > 40) {
          this.tramWait = -1;
          this.hud.message(tr('tramNoTracks', this.settings.lang));
          this.toMenu();
        }
        return;
      }
      this.tramWait = -1;
      const at = tramStart(this.rail, this.spawn!.x, this.spawn!.z, [RAIL.TRAM, RAIL.LIGHT], this.tramStopName);
      if (at) {
        const smp = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };
        this.rail.net.sample(at.path, at.s, smp);
        this.tramAt = at;
        this.spawn = { ...this.spawn!, x: at.x, z: at.z, yaw: Math.atan2(-smp.tx * at.dir, -smp.tz * at.dir), rough: false };
        this.spawnStreet = '';
      } else {
        // (a map without tram tracks)
        this.hud.message(tr('tramNoTracks', this.settings.lang));
        this.toMenu();
        return;
      }
    }
    if (this.planePending) {
      // the aeroplane: on its wheels at the end of the runway, once the ground there is there
      const p = this.spawn!;
      this.hud.setLoadingProgress(this.app.tiles.progress);
      if (Number.isNaN(this.app.tiles.heightAt(p.x, p.z)) || !this.app.tiles.settled) return;
      this.planePending = false;
      this.startPlane(p);
      return;
    }
    let sp = this.spawn!;
    // how far the loading is: the roads around the place, then the tiles (the bar of the loading screen)
    this.hud.setLoadingProgress(this.app.map.pieces ? 0.35 * this.app.map.progress(sp.x, sp.z, 1500) + 0.65 * this.app.tiles.progress : this.app.tiles.progress);
    // (the roads around the place: without them there is no lane to stand in, and nothing to drive on)
    if (!this.app.map.ready(sp.x, sp.z, 1500)) return;
    if (sp.rough) {
      // chosen on the overview of the map: now that the roads are there, into a lane of the road meant
      // (or at an address before any roads were known: then from the house to its street)
      const exact = findRoadSpot(this.app.world, this.lanes, sp.x, sp.z, this.spawnStreet, 230, this.usableLane());
      sp = this.spawn = exact ? { ...exact, name: sp.name } : { ...sp, rough: false };
    }
    const ty = this.app.tiles.heightAt(sp.x, sp.z);
    if (Number.isNaN(ty) || !this.app.tiles.settled) return;
    let y = this.app.world.surfaceAt(sp.x, sp.z, ty + 3, this.hit) ? this.hit.y : ty;
    // the practice yard is laid out over the field as soon as the ground under it is there
    if (this.task && !this.task.laid) this.task.laid = this.yardScene.show(this.yardFrame!, this.task.run.layout, (x, z) => this.app.tiles.heightAt(x, z));
    let place = { x: sp.x, z: sp.z, yaw: sp.yaw };
    // (never into a wall or onto a post: then the nearest free place in a lane instead)
    if (!this.task && this.collider.blocked(sp.x, y, sp.z, sp.yaw, 0.05)) {
      const free = this.freeSpot(sp.x, sp.z, sp.yaw, 0);
      if (free) {
        place = free;
        y = free.y;
      }
    }
    this.vehicle.teleport(place.x, y + 0.02, place.z, place.yaw);
    this.trailer?.coupleBehind(this.vehicle);
    this.lastGood = { x: place.x, y, z: place.z, yaw: place.yaw, t: 0 };
    // (on foot first – not on the yard of the class CE tasks, not when the car is to drive by itself)
    this.walkPending = this.settings.startOutside && !this.task && !this.planDemo && !this.walker && this.def.kind !== 'tram' && this.def.kind !== 'pedestrian';
    this.footPending = this.def.kind === 'pedestrian';
    if (this.tramAt) {
      // the player's tram, its front at the stop's mark (the other way round if it does not fit behind it there)
      const at = this.tramAt;
      this.tramAt = null;
      const rv = this.rail.spawnAt(at.path, at.s, at.dir, 0) ?? this.rail.spawnAt(at.path, at.s, at.dir > 0 ? -1 : 1, 0);
      if (rv) {
        this.tram = new TramDriver(this.rail, rv, this.app.world, this.signals);
        // a line that calls at this stop: the switches are set for it unless the indicator asks for another way
        this.rail.assignLine(rv);
        this.placeTramProxy();
        this.tramAuto = this.tramAutoPending;
        this.tramTake = 0;
        // (the handbrake is the tram's emergency brake: not on when the drive begins at the stop)
        this.input.c.handbrake = 0;
      }
    }
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
    // the drive begins on foot beside the vehicle (once, when it is first placed)
    if (this.walkPending) {
      this.walkPending = false;
      this.startOnFoot();
    }
    if (this.footPending) {
      this.footPending = false;
      this.startPedestrian();
    }
    if (this.footAfterJump) {
      this.footAfterJump = false;
      if (!this.walker) this.enterWalk();
    }
  }

  /** somebody on foot beside the vehicle jumped elsewhere on the map: on foot again there once it is placed */
  private footAfterJump = false;

  /** "What's new" is to be shown when the menu first comes up */
  private showNewsOnce = newsDue(playedBefore());

  /** the vehicle has just been placed for a drive that begins on foot */
  private walkPending = false;

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
    if (this.demo?.tour) this.endDemo('ended');
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
      distanceKm: this.tram ? this.tram.odometer / 1000 : (this.vehicle.odometer - this.startOdo) / 1000,
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
    } else if (a === 'door' && this.state === 'drive' && this.def.kind === 'pedestrian') {
      this.footAction();
    } else if (a === 'door' && this.state === 'drive' && this.aircraft) {
      // the flap lever, a notch at a time: 0°, 10°, 20°, 30° – and back up
      this.flight.flaps = (this.flight.flaps + 1) % 4;
      this.audio.click('tick');
    } else if (a === 'door' && this.state === 'drive' && this.busService && !this.walker) {
      // the bus on a line: its doors
      const ev: BusEvent[] = [];
      const { front, stops } = this.busStopsHere();
      this.busService.toggleDoors(front, stops, this.vehicle.speed, ev);
      this.audio.click('door');
      for (const e of ev) this.rules.noteAt(e.fault, e.severity, this.mpos[0], this.mpos[2], {}, 8);
    } else if (a === 'door' && this.state === 'drive') {
      if (this.tram) {
        // the tram's doors
        const ev = this.tramEvents;
        ev.length = 0;
        this.tram.toggleDoors(ev);
        this.audio.click('door');
        this.noteTram(ev);
      } else if (this.walker) this.getIn();
      else this.getOut();
    } else if (a === 'view' && this.state === 'drive' && !this.walker) {
      // the driver's seat → behind the car → the free camera → …
      this.cameraMode = this.cameraMode === 'cockpit' ? 'chase' : this.cameraMode === 'chase' ? 'free' : 'cockpit';
      this.input.resetLook(this.cameraMode === 'chase', this.cameraMode === 'free');
      if (this.cameraMode === 'free') {
        // it starts where the camera is, and says how it is moved
        this.fc.ready = false;
        const lang = this.settings.lang;
        this.hud.message(tr('viewFree', lang), tr(this.inputMode === 'touch' ? 'freeCamTouch' : 'freeCamKeys', lang));
      } else {
        // the next drive begins with the camera the player chose
        this.settings.view = this.cameraMode;
        saveSettings(this.settings);
      }
    } else if (a === 'reset' && this.state === 'drive' && !this.walker && !this.tram) {
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

  /**
   * Back onto the road: into the middle of the lane the car was last driving
   * in, where it touches nothing.  Asked for again from there (something is
   * still in the way): a stretch further on each time.
   */
  private resetToRoad(): void {
    const v = this.vehicle;
    const g = this.lastGood;
    v.getModelPosition(this.mpos);
    const again = this.time - this.resetAt.t < 10 && Math.hypot(this.mpos[0] - this.resetAt.x, this.mpos[2] - this.resetAt.z) < 6;
    this.resetHop = again ? this.resetHop + 1 : 0;
    const spot = this.freeSpot(g.x, g.z, g.yaw, this.resetHop * 15) ?? g;
    this.putOnRoad(spot);
    this.input.c.handbrake = 1;
  }

  private resetHop = 0;
  private resetAt = { x: 0, z: 0, t: -100 };
  private readonly proj = { s: 0, off: 0, d2: 0, seg: 0 };
  private readonly smp = newPolySample();

  private putOnRoad(spot: { x: number; y: number; z: number; yaw: number }): void {
    const v = this.vehicle;
    v.teleport(spot.x, spot.y + 0.05, spot.z, spot.yaw);
    if (this.trailer?.coupled) this.trailer.coupleBehind(v);
    // (the instructor – and with him the driver of a demonstration drive – forgets where the car was:
    // else the driver would act once more on the lane it has just been taken from)
    this.rules.placed();
    this.demo?.driver?.reset();
    this.lastGood = { x: spot.x, y: spot.y, z: spot.z, yaw: spot.yaw, t: this.time };
    this.resetAt = { x: spot.x, z: spot.z, t: this.time };
  }

  /**
   * A place in the middle of a lane where the vehicle touches nothing: the
   * lane nearest to (x, z) that goes the way `yaw` points, at least `ahead`
   * metres on from there – following the route (or the road) over the next
   * junctions if need be.  Null when there is no lane near, or no room.
   */
  private freeSpot(x: number, z: number, yaw: number, ahead: number): { x: number; y: number; z: number; yaw: number } | null {
    const world = this.app.world;
    const proj = this.proj;
    const smp = this.smp;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let lane: Lane | null = null;
    let at = 0;
    let best = Infinity;
    world.edgesInBox(x - 15, z - 15, x + 15, z + 15, (e) => {
      const el = this.lanes.edgeLanes[e.id];
      projectOnPolyline(e.pl, x, z, proj);
      for (const l of [...el.fwd, ...el.back]) {
        if (l.len < 1) continue;
        const d = Math.max(0, Math.min(l.len, l.dir > 0 ? proj.s - l.s0 : l.s0 - proj.s));
        lanePoint(l, d, smp);
        // near, going our way, and a road rather than somebody's yard
        const score = Math.hypot(smp.x - x, smp.z - z) + (1 - (smp.tx * fx + smp.tz * fz)) * 6 + (LaneGraph.drivable(e, false) ? 0 : 8);
        if (score < best) {
          best = score;
          lane = l;
          at = d;
        }
      }
    });
    if (!lane || best > 30) return null;
    const route = this.nav.route ?? [];
    let cur: Lane = lane;
    let d = at + ahead;
    for (let walked = 0, hops = 0; walked < 200 && hops < 14; ) {
      if (d > cur.len - 1 && (cur.len > 2.5 || d > cur.len)) {
        // on to the next lane: by the route, else straight on, else by whatever leads on
        const from: Lane = cur;
        const c = route.find((r) => r.from === from) ?? from.out.find((o) => o.turn === TURN.STRAIGHT) ?? from.out.find((o) => o.turn !== TURN.UTURN) ?? from.out[0] ?? null;
        if (!c) return null;
        d = Math.max(1.5, d - from.len - c.len);
        cur = c.to;
        hops++;
        continue;
      }
      lanePoint(cur, d, smp);
      const y = world.surfaceAt(smp.x, smp.z, smp.y + 1.5, this.hit) ? this.hit.y : smp.y;
      const heading = Math.atan2(-smp.tx, -smp.tz);
      let free = !this.collider.blocked(smp.x, y, smp.z, heading, 0.2);
      if (free) for (const car of this.traffic.cars) if (Math.hypot(car.x - smp.x, car.z - smp.z) < 7) free = false;
      if (free) return { x: smp.x, y, z: smp.z, yaw: heading };
      d += 2;
      walked += 2;
    }
    return null;
  }

  // ------------------------------------------------------------- simulation
  private stepDrive(dt: number): void {
    const v = this.vehicle;
    const c = this.input.update(dt, v.speed, v.steerTorque);
    if (this.debugLook) {
      c.lookYaw = this.debugLook[0];
      c.lookPitch = this.debugLook[1];
    }
    if (this.tram) {
      this.stepTram(dt);
      return;
    }
    if (this.def.kind === 'pedestrian') {
      this.stepFoot(dt);
      return;
    }
    if (this.aircraft) {
      this.stepFlight(dt);
      return;
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
    // a look back over the left shoulder: that is what is asked for before the door is opened
    if (c.lookYaw > 0.9) this.lookedBackAt = this.time;
    this.stepDoor(dt);
    if (this.walker) {
      // nobody in the seat: the vehicle stands as it was left (the keys W S A D walk)
      c.steer = d.steer = this.parkedSteer;
      c.throttle = d.throttle = 0;
      c.brake = d.brake = 0;
      c.clutch = d.clutch = 0;
      d.starter = false;
      this.stepWalk(dt);
    }
    // Speed limiter: a key or a pedal on the screen is all or nothing, which makes it hard to hold
    // 30 or 50 km/h.  With the limiter the throttle eases off just below the current limit – the
    // driver still has to brake when the limit drops.
    const lim = this.rules?.context.limit ?? -1;
    if (this.settings.limiter && lim > 0 && c.gear !== -1 && (c.device === 'keyboard' || c.device === 'touch')) {
      d.throttle = Math.min(d.throttle, Math.max(0, (lim - 0.5 - v.speed * 3.6) / 4));
    }
    // a truck is governed at 90 km/h
    // a truck is governed at 90 km/h, a bus at 100, a tractor runs 40 by construction
    const gov = this.def.governed;
    if (gov > 0 && v.speed * 3.6 > gov - 5) d.throttle = Math.min(d.throttle, Math.max(0, (gov - 0.5 - v.speed * 3.6) / 4));
    const demo = this.demo;
    if (demo?.active && demo.driver) {
      // Whoever touches a pedal or the steering takes the car over (held for a moment: a wheel
      // that is not quite centred, or a thumb resting on the screen, is no decision).
      demo.takeT = c.throttle > 0.2 || c.brake > 0.2 || Math.abs(c.steer) > 0.35 || c.handbrake > 0.5 ? demo.takeT + dt : 0;
      if (demo.takeT > 0.18) this.endDemo('taken');
      else {
        v.getModelPosition(this.mpos);
        const cmd = demo.driver.step(Math.max(dt, 1e-3), v, this.mpos, this.nav.route ?? []);
        // (until the way is known the car stands: no lane under it yet, or no route found yet)
        const ready = this.nav.busy;
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
    const mid = (this.def.outline.rear - this.def.outline.front) / 2;
    const player: PlayerState = { x: this.mpos[0] + Math.sin(v.yaw) * mid, y: this.mpos[1], z: this.mpos[2] + Math.cos(v.yaw) * mid, yaw: v.yaw, speed: v.speed, length: v.spec.length ?? 4.28, width: v.spec.width ?? 1.79 };
    // (the lane the vehicle was on in the last step, and where its middle was along it: the cyclists are sent along by it)
    player.lane = this.rules.context.onRoad ? this.currentLane() : null;
    player.s = this.laneFront() - player.length / 2;
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
      const o = trailerOf(this.def) ?? TRAILER_OUTLINE;
      const off = (o.front - o.rear) / 2;
      boxes.push({ x: t.x - Math.sin(t.yaw) * off, y: t.y, z: t.z - Math.cos(t.yaw) * off, yaw: t.yaw, speed: t.coupled ? t.speed : 0, length: o.front + o.rear, width: o.hw * 2, own: t.coupled });
    }
    if (this.walker) boxes.push({ x: this.walker.x, y: this.walker.y, z: this.walker.z, yaw: this.walker.yaw, speed: 0, length: 0.6, width: 0.6 });
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
      } else if (ev.type === 'cyclistEndangered' && ev.hit) this.audio.click('bump');
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
      front: this.def.outline.front,
    };
    this.rules.update(dt, snap, this.traffic.events);
    this.signalTips(dt);
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

  // ------------------------------------------------- on foot: round the vehicle, out and in
  /** somebody on foot beside the vehicle (null: in the driver's seat) */
  private walker: OnFoot | null = null;
  private readonly markers = new CheckMarkers();
  private readonly fadeEl = document.createElement('div');
  /** the drive began on foot: the check round the vehicle counts */
  private walkStart = false;
  /** getting in or out: seconds into it, which way, and the camera at its start */
  private doorT = -1;
  private doorWay: 'in' | 'out' = 'in';
  private readonly doorFrom = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  /** when the driver last looked back over the left shoulder (before opening the door) */
  private lookedBackAt = -100;
  /** the steering wheel as it was left */
  private parkedSteer = 0;
  private walkSince = 0;

  /** The vehicle as somebody on foot meets it: its parts in the plan, the driver's door, the coupling. */
  private walkVehicle(): WalkVehicle {
    const v = this.vehicle;
    v.getModelPosition(this.mpos);
    const units: WalkUnit[] = [];
    let hitch: WalkVehicle['hitch'] = null;
    const d = this.def;
    units.push({ x: this.mpos[0], z: this.mpos[2], yaw: v.yaw, ...d.outline, axles: d.axles, track: d.track });
    const t = this.trailer;
    const o = trailerOf(d);
    if (t?.coupled && o && d.trailer) {
      const axles = d.trailer.axleSpread > 0 ? [d.trailer.axleSpread / 2, -d.trailer.axleSpread / 2] : [0];
      units.push({ x: t.x, z: t.z, yaw: t.yaw, front: o.front, rear: o.rear, hw: o.hw, axles, track: d.trailer.track / 2 });
      hitch = { x: t.hitchX, y: t.hitchY, z: t.hitchZ };
    }
    return { units, y: this.mpos[1], door: d.door, doorSide: d.doorSide || -1, hitch };
  }

  /**
   * Out of the vehicle (it stands): the door is opened into the road only
   * after a look back (§ 14 Abs. 1 StVO), the vehicle is left secured –
   * engine off, parking brake on (§ 14 Abs. 2 StVO).
   */
  private getOut(): void {
    const v = this.vehicle;
    const c = this.input.c;
    const lang = this.settings.lang;
    if (this.walker || this.doorT >= 0 || this.demo?.active || this.task) return;
    if (Math.abs(v.speed) > 0.3) {
      this.tipText = tr('stopFirst', lang);
      this.tipUntil = this.time + 3;
      return;
    }
    v.getModelPosition(this.mpos);
    const x = this.mpos[0];
    const z = this.mpos[2];
    // (a motorcycle has no parking brake to set: the engine off is enough)
    if ((c.handbrake < 0.5 && this.def.doorSide !== 0) || v.engineRunning) this.rules.noteAt('notSecured', 'minor', x, z);
    // what comes from behind on the side where the door opens: within four seconds of it (a motorcycle has no door)
    const side = this.def.doorSide;
    const s = Math.sin(v.yaw);
    const co = Math.cos(v.yaw);
    let coming = false;
    const movers: Array<{ x: number; z: number; v: number; yaw: number }> = [...this.traffic.cars.map((k) => ({ x: k.x, z: k.z, v: k.v, yaw: k.yaw })), ...this.traffic.cyclists.list.map((k) => ({ x: k.x, z: k.z, v: k.v, yaw: k.yaw }))];
    for (const m of movers) {
      const dx = m.x - x;
      const dz = m.z - z;
      const ahead = -dx * s - dz * co;
      const right = dx * co - dz * s;
      const along = Math.cos(m.yaw - v.yaw);
      if (right * side > 0.4 && right * side < 4.5 && ahead < 3 && ahead > -60 && along > 0.5 && m.v > 1 && (0.5 - ahead) / m.v < 4) coming = true;
    }
    // (only a door on the left opens into the road: the front door of a bus opens towards the kerb,
    // a motorcycle has none)
    const looked = this.time - this.lookedBackAt < 5;
    if (side < 0 && coming) this.rules.noteAt('doorTraffic', 'major', x, z);
    else if (side < 0 && !looked) this.rules.noteAt('doorCheck', 'hint', x, z);
    // (whatever was done: the vehicle does not roll away)
    c.handbrake = 1;
    c.seatbelt = false;
    this.parkedSteer = c.steer;
    this.walkStart = false;
    this.startDoor('out');
  }

  /** In again: from beside the driver's door. */
  private getIn(): void {
    const w = this.walker;
    const lang = this.settings.lang;
    if (!w || this.doorT >= 0) return;
    if (!w.atDoor) {
      this.tipText = tr('toDoor', lang);
      this.tipUntil = this.time + 3;
      return;
    }
    // a drive that began on foot: was the vehicle looked at?
    if (this.walkStart && !w.allChecked) this.rules.noteAt('preCheck', 'hint', this.mpos[0], this.mpos[2], { missing: new Intl.ListFormat(localeOf(lang), { style: 'long', type: 'conjunction' }).format(w.missing().map((id) => tr(CHECK_TEXT[id], lang))) }, 30);
    this.startDoor('in');
  }

  /** Begin on foot beside the vehicle (the start "beside the vehicle"): engine off, belt off. */
  private startOnFoot(): void {
    const c = this.input.c;
    c.handbrake = 1;
    c.seatbelt = false;
    this.vehicle.resetDrivetrain(false);
    this.parkedSteer = 0;
    this.walkStart = true;
    this.enterWalk();
  }

  private enterWalk(): void {
    const w = new OnFoot(this.walkVehicle());
    w.y = this.footGround(w.x, w.z, this.mpos[1] + 1);
    this.walker = w;
    // (nobody sits on the motorcycle while its rider walks round it)
    if (this.model instanceof PlayerBike) this.model.setRider(false);
    this.walkSince = this.time;
    this.input.resetLook(false, true);
    this.markers.show(w.spots, (x, z) => this.footGround(x, z, this.mpos[1] + 1));
  }

  private leaveWalk(): void {
    this.walker = null;
    if (this.model instanceof PlayerBike) this.model.setRider(true);
    if (this.def.model === 'motorcycle') this.input.c.seatbelt = true;
    this.markers.hide();
    this.cameraMode = 'cockpit';
    this.input.resetLook(false, false);
  }

  private startDoor(way: 'in' | 'out'): void {
    this.doorWay = way;
    this.doorT = 0;
    this.doorFrom.pos.copy(this.app.camera.position);
    this.doorFrom.quat.copy(this.app.camera.quaternion);
    this.audio.click('door');
    this.fadeEl.classList.add('on');
  }

  /** Getting in or out: the picture goes dark while the door is opened, the seat taken or left, the door closed. */
  private stepDoor(dt: number): void {
    if (this.doorT < 0) return;
    const before = this.doorT;
    this.doorT += dt;
    if (before < 0.35 && this.doorT >= 0.35) {
      if (this.doorWay === 'out') this.enterWalk();
      else this.leaveWalk();
    }
    if (before < 0.6 && this.doorT >= 0.6) {
      this.audio.click('doorShut');
      this.fadeEl.classList.remove('on');
    }
    if (this.doorT >= 1) this.doorT = -1;
  }

  /** The height to stand on: the road or pavement there, else the ground. */
  private footGround(x: number, z: number, yRef: number): number {
    return this.app.world.surfaceAt(x, z, yRef, this.hit) ? this.hit.y : this.app.tiles.heightAt(x, z);
  }

  private stepWalk(dt: number): void {
    const w = this.walker;
    if (!w) return;
    const look = this.input.takeCam();
    const r = w.update(dt, this.input.walkInput(), look, (x, z, yRef) => this.footGround(x, z, yRef), (x, y, z, rad) => this.collider.circleBlocked(x, y, z, rad));
    if (r.step) this.audio.click('step');
    if (r.checked) {
      this.audio.click('tick');
      this.markers.update(w.spots);
      if (w.allChecked) {
        this.tipText = tr('checkDone', this.settings.lang);
        this.tipUntil = this.time + 5;
      }
    }
  }

  // ------------------------------------------------- on foot, as a pedestrian
  /** the drive of a pedestrian is to begin once the start point is placed */
  private footPending = false;
  /** the crossing the person is on (to judge its light once, when stepping onto the road), whether they were on the road a moment ago, and how far they have walked along it */
  private footCrossing: CrossingJson | null = null;
  private footOnRoad = false;
  private footAlong = 0;
  /** the pole whose button is within reach */
  private footPole: PedPole | null = null;
  /** riding a tram as a passenger: the vehicle and the car one is in, and the side of its doors one got in by */
  private riding: { v: RailVehicle; car: number; side: number } | null = null;
  /** a tram standing at a stop close enough to get in */
  private footBoard: { v: RailVehicle; car: number; side: number } | null = null;
  /** the bus on a line (its lesson): the stops served, the doors, the passengers – and what the HUD says of the next stop */
  private busService: BusService | null = null;
  private busNav = '';
  /** riding a bus of the traffic as a passenger – and a bus at its stop with the front door within reach */
  private busRide: TrafficCar | null = null;
  private footBus: TrafficCar | null = null;

  /** On foot, as a pedestrian: on the pavement beside the start point (to the right of the road), looking along it. */
  private startPedestrian(): void {
    const v = this.vehicle;
    v.getModelPosition(this.mpos);
    const yaw = v.yaw;
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    let x = this.mpos[0];
    let z = this.mpos[2];
    for (let d = 1.5; d <= 16; d += 0.5) {
      const px = this.mpos[0] + rx * d;
      const pz = this.mpos[2] + rz * d;
      const road = this.app.world.surfaceAt(px, pz, this.mpos[1] + 2, this.hit) && this.hit.zone === 0;
      const y = this.footGround(px, pz, this.mpos[1] + 1);
      if (!road && Number.isFinite(y) && !this.collider.circleBlocked(px, y, pz, 0.35)) {
        x = px;
        z = pz;
        break;
      }
    }
    const w = new OnFoot(null, { x, y: this.footGround(x, z, this.mpos[1] + 1), z, yaw });
    w.runSpeed = this.settings.runSpeed / 3.6;
    this.walker = w;
    this.walkSince = this.time;
    this.riding = null;
    this.footCrossing = null;
    this.footOnRoad = false;
    this.footAlong = 0;
    this.cameraMode = 'cockpit';
    this.input.resetLook(false, true);
    v.teleport(x, w.y, z, yaw);
    v.getModelPosition(this.mpos);
  }

  /**
   * A step on foot: walking (or running), the traffic around – which sees a
   * person, not a car –, the trams, and what the rules ask of somebody on foot.
   */
  private stepFoot(dt: number): void {
    const w = this.walker;
    if (!w) return;
    const bus = this.busRide;
    if (bus) {
      // on the bus: a seat behind the driver; it takes them along
      if (!this.traffic.cars.includes(bus)) this.alightBus();
      else {
        const look = this.input.takeCam();
        w.yaw += look.yaw;
        w.pitch = Math.max(-1.2, Math.min(1, w.pitch + look.pitch));
        w.x = bus.x;
        w.y = bus.y;
        w.z = bus.z;
        w.speed = bus.v;
      }
    }
    const ride = this.riding;
    if (bus) {
      /* (taken along by the bus) */
    } else if (ride) {
      // a passenger: sitting in the car, looking round; the tram takes them along
      if (!this.rail.vehicles.includes(ride.v)) this.alight();
      else {
        const look = this.input.takeCam();
        w.yaw += look.yaw;
        w.pitch = Math.max(-1.2, Math.min(1, w.pitch + look.pitch));
        const car = ride.v.cars[ride.car];
        w.x = car.x;
        w.y = car.y + TRAM_FLOOR;
        w.z = car.z;
        w.speed = ride.v.speed;
        this.passengerView.show(ride.v);
      }
    } else this.stepWalk(dt);
    // the game's vehicle stands where the person is: the camera, the map, the traffic keep to it
    this.vehicle.teleport(w.x, w.y, w.z, this.riding ? this.riding.v.cars[this.riding.car].yaw : this.busRide ? this.busRide.yaw : w.yaw);
    this.vehicle.getModelPosition(this.mpos);
    this.rules.time += dt;
    this.signals.update(dt);
    // (riding, the passenger is no obstacle to anybody: the vehicle around them is)
    const riding = !!this.riding || !!this.busRide;
    const player: PlayerState = { x: w.x, y: w.y, z: w.z, yaw: w.yaw, speed: w.speed, length: riding ? 0.1 : 0.6, width: riding ? 0.1 : 0.6, onFoot: !riding };
    const others = this.railOthers;
    others.length = 0;
    for (const car of this.traffic.cars) others.push({ x: car.x, z: car.z, r: 1.3 });
    this.rail.update(dt, player, others);
    const boxes = this.railBoxes;
    boxes.length = 0;
    for (const rv of this.rail.vehicles) for (const rc of rv.cars) boxes.push({ x: rc.x, y: rc.y, z: rc.z, yaw: rc.yaw, speed: rv.speed, length: rv.consist.carLen, width: rv.consist.width });
    this.traffic.obstacles = boxes;
    this.traffic.update(dt, player);
    const lang = this.settings.lang;
    for (const e of this.traffic.events) {
      if (e.type === 'collision') this.rules.noteAt('pedHit', 'fail', w.x, w.z, {}, 6);
      else if (e.type === 'forcedBrake') this.rules.noteAt('pedForcedBrake', 'major', w.x, w.z, {}, 10);
    }
    if (!riding) {
      // a tram does not give way: whoever stands on its track is hit
      if (this.rail.touching(player)) this.rules.noteAt('pedHit', 'fail', w.x, w.z, {}, 6);
      this.footRules(dt, w);
      // what is within reach: a button, a tram to get in
      this.footPole = poleInReach(this.pedPoles, w.x, w.z);
      this.footBoard = this.boardable(w.x, w.z);
      this.footBus = this.footBoard ? null : this.busAt(w.x, w.z);
    } else {
      this.footPole = null;
      this.footBoard = null;
      this.footBus = null;
    }
    if (this.failT < 0 && this.rules.failed) {
      this.failT = this.time + 2.5;
      this.tipText = tr('pedHitTip', lang);
      this.tipUntil = this.time + 4;
    }
    if (this.failT > 0 && this.time > this.failT) this.finish();
  }

  /**
   * What the rules ask of somebody on foot (§ 25, § 37 Abs. 2 Nr. 5 StVO): to
   * keep to the pavement, to cross the road straight across – at the crossing
   * if there is one near – and not against the red light of a pedestrian light.
   */
  private footRules(dt: number, w: OnFoot): void {
    const world = this.app.world;
    const onRoad = world.surfaceAt(w.x, w.z, w.y + 1, this.hit) && this.hit.zone === 0 && this.hit.edge !== null;
    if (!onRoad || !this.hit.edge) {
      this.footOnRoad = false;
      this.footCrossing = null;
      this.footAlong = Math.max(0, this.footAlong - dt * 2);
      return;
    }
    const e = this.hit.edge;
    // where along the road, and which crossing (if any) the person is on
    const proj = this.proj;
    projectOnPolyline(e.pl, w.x, w.z, proj);
    let at: CrossingJson | null = null;
    let near: CrossingJson | null = null;
    for (const c of e.xings) {
      if (c.k !== XING.SIGNAL && c.k !== XING.ZEBRA && c.k !== XING.UNMARKED) continue;
      const d = Math.abs(proj.s - c.s);
      if (d <= c.w / 2 + 1) at = c;
      else if (d < 30 && (c.k === XING.SIGNAL || c.k === XING.ZEBRA)) near = c;
    }
    const stepping = !this.footOnRoad;
    this.footOnRoad = true;
    if (stepping) {
      this.footCrossing = at;
      // onto the road against the red light (once green turns red on the way, one goes on – that is allowed)
      if (at && at.k === XING.SIGNAL && at.sc !== undefined && this.signals.pedestrian(at.sc, at.g ?? 0) === 'red') this.rules.noteAt('pedRed', 'major', w.x, w.z, {}, 15);
      // across the road a few steps from a crossing (or a light) that is not used
      else if (!at && near) this.rules.noteAt('pedCrossing', 'minor', w.x, w.z, {}, 20);
    }
    // along the road rather than across it, where there is a pavement
    samplePolyline(e.pl, proj.s, this.smp);
    const along = Math.abs(Math.cos(w.yaw) * -this.smp.tz + Math.sin(w.yaw) * -this.smp.tx) * w.speed;
    this.footAlong += along * dt;
    if (this.footAlong > 25 && (e.swL > 0 || e.swR > 0)) {
      this.rules.noteAt('pedRoad', 'minor', w.x, w.z, {}, 30);
      this.footAlong = 0;
    }
  }

  /** A tram (or train) standing at a stop with a car whose doors are within a step or two – null if there is none. */
  private boardable(x: number, z: number): { v: RailVehicle; car: number; side: number } | null {
    for (const rv of this.rail.vehicles) {
      if (rv.player || Math.abs(rv.speed) > 0.05 || rv.dwell <= 0.5) continue;
      for (let i = 0; i < rv.cars.length; i++) {
        const c = rv.cars[i];
        const s = Math.sin(c.yaw);
        const co = Math.cos(c.yaw);
        const dx = x - c.x;
        const dz = z - c.z;
        const ahead = -dx * s - dz * co;
        const right = dx * co - dz * s;
        const hw = rv.consist.width / 2;
        if (Math.abs(ahead) < rv.consist.carLen / 2 - 0.6 && Math.abs(right) > hw - 0.2 && Math.abs(right) < hw + 2.2) return { v: rv, car: i, side: Math.sign(right) };
      }
    }
    return null;
  }

  /** Into the tram at its stop: a seat in the car by the door, looking ahead; the driver waits a moment. */
  private board(at: { v: RailVehicle; car: number; side: number }): void {
    const w = this.walker;
    if (!w) return;
    this.riding = at;
    at.v.dwell = Math.max(at.v.dwell, 4);
    w.yaw = 0;
    w.pitch = -0.05;
    this.railActors.hidden = at.v;
    this.passengerView.show(at.v);
    this.audio.click('door');
  }

  /** Out of the tram: beside the door one got in by (the platform side), facing away from it. */
  private alight(): void {
    const w = this.walker;
    const ride = this.riding;
    this.riding = null;
    this.railActors.hidden = null;
    this.passengerView.show(null);
    if (!w || !ride) return;
    const car = ride.v.cars[ride.car];
    const s = Math.sin(car.yaw);
    const c = Math.cos(car.yaw);
    const out = ride.v.consist.width / 2 + 0.9;
    // the nearer of the car's doors (a quarter in from either end)
    const ahead = (w.yaw > -Math.PI / 2 && w.yaw < Math.PI / 2 ? 1 : -1) * ride.v.consist.carLen * 0.25;
    w.x = car.x - s * ahead + c * out * ride.side;
    w.z = car.z - c * ahead - s * out * ride.side;
    w.y = this.footGround(w.x, w.z, car.y + 1.5);
    w.yaw = car.yaw - (ride.side * Math.PI) / 2;
    w.pitch = -0.1;
    this.audio.click('door');
  }

  /** A bus of the traffic standing at its stop with its doors open, its front door within a step or two – null if there is none. */
  private busAt(x: number, z: number): TrafficCar | null {
    for (const b of this.traffic.cars) {
      if (!b.bus?.doors || b.v > 0.05) continue;
      const fx = -Math.sin(b.yaw);
      const fz = -Math.cos(b.yaw);
      const rx = Math.cos(b.yaw);
      const rz = -Math.sin(b.yaw);
      const dx = b.x + fx * (b.length / 2 - 1.3) + rx * (b.width / 2 + 0.6) - x;
      const dz = b.z + fz * (b.length / 2 - 1.3) + rz * (b.width / 2 + 0.6) - z;
      if (Math.hypot(dx, dz) < 2.4) return b;
    }
    return null;
  }

  /** Off the bus: out of the front door onto the pavement, facing away from it. */
  private alightBus(): void {
    const w = this.walker;
    const b = this.busRide;
    this.busRide = null;
    if (!w || !b) return;
    const fx = -Math.sin(b.yaw);
    const fz = -Math.cos(b.yaw);
    const rx = Math.cos(b.yaw);
    const rz = -Math.sin(b.yaw);
    w.x = b.x + fx * (b.length / 2 - 1.3) + rx * (b.width / 2 + 1.0);
    w.z = b.z + fz * (b.length / 2 - 1.3) + rz * (b.width / 2 + 1.0);
    w.y = this.footGround(w.x, w.z, b.y + 1.5);
    w.yaw = b.yaw - Math.PI / 2;
    w.pitch = -0.1;
    this.audio.click('door');
  }

  /** The door key on foot: press the button of a pedestrian light, get into a tram, get out of it. */
  private footAction(): void {
    const lang = this.settings.lang;
    if (this.busRide) {
      const b = this.busRide;
      if (b.v < 0.05 && b.bus?.doors) this.alightBus();
      else {
        this.tipText = tr('rideWaitBus', lang);
        this.tipUntil = this.time + 3;
      }
      return;
    }
    if (this.footBus && this.walker) {
      // on through the front door: the driver waits a moment longer
      const b = this.footBus;
      if (b.bus) b.bus.dwell = Math.max(b.bus.dwell, 4);
      this.busRide = b;
      this.walker.yaw = 0;
      this.walker.pitch = -0.05;
      this.audio.click('door');
      return;
    }
    if (this.riding) {
      // out at a stop, once it stands there with its doors open
      if (Math.abs(this.riding.v.speed) < 0.05 && this.riding.v.dwell > 0) this.alight();
      else {
        this.tipText = tr('rideWait', lang);
        this.tipUntil = this.time + 3;
      }
      return;
    }
    if (this.footBoard) {
      this.board(this.footBoard);
      return;
    }
    if (this.footPole) {
      const p = this.footPole;
      const st = this.signals.pedestrian(p.controller, p.group);
      if (st === 'dark') this.tipText = tr('pedLightDark', lang);
      else if (st === 'green') this.tipText = tr('pedLightGreen', lang);
      else {
        this.signals.request(p.controller);
        this.audio.click('tick');
        this.tipText = tr('pedRequested', lang);
      }
      this.tipUntil = this.time + 4;
    }
  }

  // ------------------------------------------------- flying
  /** The ground's height: the tiles' where they are loaded, else the far view's (an aeroplane sees far). */
  private groundHeight(x: number, z: number): number {
    const y = this.app.tiles.heightAt(x, z);
    if (!Number.isNaN(y)) return y;
    const f = this.far.data ? farHeight(this.far.data, x, z) : Number.NaN;
    return Number.isNaN(f) ? 0 : f;
  }

  /** whether a flight asked for before the airfields were read has waited for them (once is enough: a map may have none) */
  private airAwaited = false;

  /** The first end of a runway of the map (a flight asked for without a choice, by a link). */
  private firstRunway(): RunwayChoice | null {
    const f = this.air?.airfields.find((a) => a.runways.some((r) => Math.hypot(r.x2 - r.x1, r.z2 - r.z1) >= 300));
    const r = f?.runways.find((q) => Math.hypot(q.x2 - q.x1, q.z2 - q.z1) >= 300);
    if (!f || !r) return null;
    return { field: f.name, end: runwayEnd(r, false), ...runwayStart(r, false) };
  }

  /** The aeroplane's model, as the game holds every vehicle's – its parts move with the flight (planeVisual). */
  private planeAdapter(): VehicleModel {
    const pm = new PlaneModel();
    pm.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    this.planeModel = pm;
    return { root: pm.root, eye: pm.eye, mirrors: [], setCabinOpacity: (o: number) => pm.setCabinOpacity(o), update: () => {} };
  }

  /** On its wheels at the end of the runway, engine running, flaps at 10°: ready to take off. */
  private startPlane(sp: SpawnJson): void {
    const a = new Aircraft(TRAINER, powerOf(this.def, this.settings.powers));
    a.placeOnGround(sp.x, sp.z, sp.yaw, this.airGround ?? this.ground, true);
    this.aircraft = a;
    this.flight.throttle = 0;
    this.flight.flaps = 1;
    this.flight.trim = 0.15;
    this.flight.crashT = -1;
    // (the gear buttons are the flap lever now: from where they stand nothing is to be moved)
    this.input.c.gear = 0;
    this.ui.classList.add('flying');
    this.placePlaneProxy();
    this.lastGood = { x: sp.x, y: a.pos.y, z: sp.z, yaw: sp.yaw, t: 0 };
    this.camSnap = true;
    this.showModel(true);
    if (!this.keepClock) {
      this.startOdo = this.vehicle.odometer;
      this.startTime = this.time;
    }
    this.keepClock = false;
    this.resume();
  }

  /** The game's vehicle stands below the aeroplane: the map, the tiles and the minimap keep to it. */
  private placePlaneProxy(): void {
    const a = this.aircraft as Aircraft;
    this.vehicle.teleport(a.pos.x, a.pos.y, a.pos.z, a.yaw);
    this.mpos[0] = a.pos.x;
    this.mpos[1] = a.pos.y;
    this.mpos[2] = a.pos.z;
  }

  /**
   * A step of the flight: the stick, the rudder, the throttle lever (it
   * stays where it is put), the flaps, the trim – which follows a stick held
   * off the middle for a while, so that the aeroplane keeps the attitude it
   * is put in –, the brakes on the ground.  The traffic goes on below.
   */
  private stepFlight(dt: number): void {
    const a = this.aircraft as Aircraft;
    const f = this.flight;
    const fi = this.input.flightInput();
    // the flap lever also on the gear buttons (▲ ▼ on the screen, E Q on the keys): down for more flap, up for less
    const ci = this.input.c;
    if (ci.gear !== 0) {
      f.flaps = Math.max(0, Math.min(3, f.flaps + (ci.gear < 0 ? 1 : -1)));
      ci.gear = 0;
      this.audio.click('tick');
    }
    f.throttle = Math.max(0, Math.min(1, f.throttle + fi.throttle * dt * 0.5));
    if (!a.onGround) f.trim = Math.max(-1, Math.min(1, f.trim + fi.pitch * dt * 0.06));
    const c = this.flightControls;
    c.throttle = f.throttle;
    c.elevator = fi.pitch;
    c.aileron = fi.roll;
    // the rudder: from its keys, else a little with the ailerons (turns stay balanced) – and on the ground the nose wheel follows the stick
    c.rudder = Math.max(-1, Math.min(1, fi.yaw + fi.roll * (a.onGround ? 0.9 : 0.25)));
    c.flaps = f.flaps / 3;
    c.trim = f.trim;
    c.brake = fi.brake;
    c.parkingBrake = false;
    c.engineOn = true;
    if (f.crashT < 0) a.step(dt, c, this.airGround ?? this.ground);
    this.placePlaneProxy();
    this.rules.time += dt;
    this.signals.update(dt);
    // below: the trains and trams, the traffic (high up nobody comes near enough to be in the way)
    const player: PlayerState = { x: a.pos.x, y: a.pos.y, z: a.pos.z, yaw: a.yaw, speed: 0, length: 0.1, width: 0.1 };
    this.rail.update(dt, player, []);
    this.traffic.obstacles = [];
    this.traffic.update(dt, player);
    this.airfieldView.update(a.pos.x, a.pos.z);
    const lang = this.settings.lang;
    if (a.crashed && f.crashT < 0) {
      f.crashT = this.time;
      this.hud.message(tr('planeCrashed', lang), tr(`planeCrash.${a.crashed}`, lang));
    }
    if (f.crashT > 0 && this.time - f.crashT > 4) this.finish();
  }

  /** How the aeroplane looks: its control surfaces, wheels, propeller, lights – and its instruments. */
  private planeVisual(a: Aircraft): PlaneVisualState {
    const s = a.surfaces;
    const c = this.flightControls;
    const deg = 180 / Math.PI;
    return {
      aileron: s.aileron,
      elevator: s.elevator,
      rudder: s.rudder,
      flapsDeg: a.flapsDeg,
      throttle: this.flight.throttle,
      rpm: a.rpm,
      propAngle: a.propAngle,
      wheels: a.wheels.map((w) => ({ compression: w.compression, spin: w.spin, steer: w.steer })),
      yoke: { pitch: c.elevator, roll: c.aileron },
      pedals: c.rudder,
      lights: { nav: true, beacon: a.engineRunning, strobe: !a.onGround, landing: a.agl < 300, taxi: a.onGround },
      iasKt: a.ias * 1.94384,
      altitudeFt: a.altitude * 3.28084,
      vsFpm: a.verticalSpeed * 196.85,
      headingDeg: a.heading,
      pitchDeg: a.pitch * deg,
      bankDeg: a.bank * deg,
      slip: a.slip,
      turnRateDegS: a.turnRate * deg,
      rpmGauge: a.rpm,
      fuel: a.fuel / TRAINER.fuel,
      flapsGauge: a.flapsDeg,
      stallWarning: a.stallWarning,
      parkingBrake: false,
      engineOn: a.engineRunning,
    };
  }

  // ------------------------------------------------- the tram
  /** the player's tram (null: a road vehicle), and the stop it is to start at */
  private tram: TramDriver | null = null;
  private tramAt: { path: number; s: number; dir: 1 | -1; x: number; z: number } | null = null;
  /** since when the tram waits for the tracks to be read (−1: it does not) */
  private tramWait = -1;
  /** the stop chosen to start at ('' : the one nearest to the start point) */
  private tramStopName = '';
  /** the tram drives by itself (a demonstration drive) – and is to, once it is placed */
  private tramAuto = false;
  private tramAutoPending = false;
  /** how long the controller has been touched during a demonstration drive (taking over) */
  private tramTake = 0;
  /** the stops of the map (null: a map without the list) */
  private stops: Stops | null = null;
  private readonly tramEvents: TramEvent[] = [];
  /** the names of stops the map does not name (the street they are in), by piece of track and mark */
  private readonly stopNames = new Map<string, string>();

  /** The game's vehicle stands where the tram's first car is: the camera, the map, the traffic keep to it. */
  private placeTramProxy(): void {
    const c = (this.tram as TramDriver).v.cars[0];
    this.vehicle.teleport(c.x, c.y, c.z, c.yaw);
    this.vehicle.getModelPosition(this.mpos);
  }

  private noteTram(events: readonly TramEvent[]): void {
    for (const e of events) this.rules.noteAt(e.fault, e.severity, this.mpos[0], this.mpos[2], e.data ?? {}, 8);
  }

  /** A stop's name: as the map names it – or, on an older map, the street it is in. */
  private stopName(path: number, mark: number): string {
    const p = this.rail.net.paths[path];
    const i = p ? p.stops.findIndex((s) => Math.abs(s - mark) < 0.5) : -1;
    if (i >= 0 && p.stopNames[i]) return p.stopNames[i];
    const key = `${path}:${Math.round(mark)}`;
    let name = this.stopNames.get(key);
    if (name === undefined) {
      const smp = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };
      this.rail.net.sample(path, mark, smp);
      name = this.app.world.nearestRoad(smp.x, smp.z, 60, 0, this.hit) && this.hit.edge ? this.hit.edge.name : '';
      this.stopNames.set(key, name);
    }
    return name || tr('tramStop', this.settings.lang);
  }

  /** A step of the tram: the controller, the switch asked for, the tram on its track, the traffic around it. */
  private stepTram(dt: number): void {
    const tram = this.tram as TramDriver;
    const c = this.input.c;
    const ev = this.tramEvents;
    ev.length = 0;
    if (this.tramAuto) {
      // driving by itself – until the controller is touched for a moment: then the player drives
      this.tramTake = c.throttle > 0.2 || c.brake > 0.2 || c.handbrake > 0.5 ? this.tramTake + dt : 0;
      if (this.tramTake > 0.18) {
        this.tramAuto = false;
        this.hud.message(tr('demoTaken', this.settings.lang), tr('tramAutoAgain', this.settings.lang));
      } else tram.drive(ev);
    }
    if (!this.tramAuto) {
      tram.lever = Math.max(-1, Math.min(1, c.throttle - c.brake));
      tram.emergency = c.handbrake > 0.5;
    }
    // the indicator asks for the way at the next switch
    tram.wish = c.indicator < 0 ? 1 : c.indicator > 0 ? -1 : 0;
    tram.step(dt, ev);
    this.placeTramProxy();
    this.rules.time += dt;
    this.signals.update(dt);
    // the other trams and trains (the player's is among them and is left to its driver)
    const others = this.railOthers;
    others.length = 0;
    for (const car of this.traffic.cars) others.push({ x: car.x, z: car.z, r: 1.3 });
    // (the others appear around the player's tram and keep clear of it like of any other)
    const front = tram.v.cars[0];
    this.rail.update(dt, { x: front.x, y: front.y, z: front.z, yaw: front.yaw, length: tram.v.consist.carLen, width: tram.v.consist.width }, others);
    // the road traffic keeps clear of every car of the tram
    const boxes = this.railBoxes;
    boxes.length = 0;
    for (const rv of this.rail.vehicles) for (const rc of rv.cars) boxes.push({ x: rc.x, y: rc.y, z: rc.z, yaw: rc.yaw, speed: rv.speed, length: rv.consist.carLen, width: rv.consist.width, own: rv === tram.v });
    this.traffic.obstacles = boxes;
    this.traffic.update(dt, { x: front.x, y: front.y, z: front.z, yaw: front.yaw, speed: tram.speed, length: tram.v.consist.carLen, width: tram.v.consist.width });
    for (const e of this.traffic.events) {
      if (e.type === 'collision') this.rules.noteAt('crash', 'fail', front.x, front.z, { speed: Math.round(tram.speed * 3.6) }, 6);
      else if (e.type === 'cyclistEndangered') this.rules.noteAt(e.hit ? 'cyclistHit' : 'cyclistCutOff', e.hit ? 'fail' : 'major', front.x, front.z, {}, 8);
    }
    this.noteTram(ev);
    // the lesson: a line with its stops
    if (this.lesson?.kind === 'tram') {
      const n = Math.min(tram.served, TRAM_STOPS);
      this.lessonLine = tr('tramProgress', this.settings.lang, { n, max: TRAM_STOPS });
      if (tram.served >= TRAM_STOPS && tram.speed < 0.1 && !tram.doorsOpen) this.finish();
    }
    if (this.failT > 0 && this.time > this.failT) this.finish();
  }

  /** the bus stops along each lane (worked out when a bus first needs them) */
  private readonly laneStops = new Map<number, BusStopOnLane[]>();

  /**
   * The bus stops along a lane: the poles of the map's stops at the right of
   * it (people wait at the kerb on the right), each where the front of a bus
   * comes to stand – a metre and a half past the pole, the front door at it.
   */
  private busStopsOn(lane: Lane): readonly BusStopOnLane[] {
    const known = this.laneStops.get(lane.id);
    if (known) return known;
    const list: BusStopOnLane[] = [];
    const stops = this.stops;
    const e = lane.edge;
    if (stops && e.len > 10) {
      samplePolyline(e.pl, e.len / 2, this.smp);
      const proj = { s: 0, off: 0, d2: 0, seg: 0 };
      for (const place of stops.near(this.smp.x, this.smp.z, e.len / 2 + 40)) {
        if (!(place.kind & STOP_FLAG.BUS)) continue;
        for (const pole of place.poles) {
          if (pole.flags & STOP_FLAG.TRAM && !(pole.flags & STOP_FLAG.BUS)) continue;
          projectOnPolyline(e.pl, pole.x, pole.z, proj);
          if (proj.s < 1 || proj.s > e.len - 1 || Math.abs(proj.off) > e.width / 2 + 7) continue;
          // on the right of the lane's direction: left of the edge (off > 0) when it runs against it
          if ((lane.dir > 0 ? -proj.off : proj.off) < 0.5) continue;
          const s = (lane.dir > 0 ? proj.s - lane.s0 : lane.s0 - proj.s) + 1.5;
          if (s > 12 && s < lane.len) list.push({ s, id: place.id * 64 + place.poles.indexOf(pole) });
        }
      }
      list.sort((a, b) => a.s - b.s);
    }
    this.laneStops.set(lane.id, list);
    return list;
  }

  /**
   * The wishes for a tour (settings.tourPrefs) as the planner takes them:
   * motorways and expressways left out altogether if so wished; main roads
   * still used to get somewhere but not looked for; streets of the kind of
   * houses asked for (from the far view's buildings) more welcome than others.
   */
  private tourWishes(g: RouteGraph): { avoid?: (way: number) => boolean; like?: (edge: number) => number } {
    const p = this.settings.tourPrefs;
    const avoid = p.noMotorway || p.noExpress ? (w: number): boolean => (p.noMotorway && g.cls[w] <= CLS.MOTORWAY_LINK) || (p.noExpress && g.cls[w] >= CLS.TRUNK && g.cls[w] <= CLS.TRUNK_LINK) : undefined;
    const far = this.far.data;
    const kind = (e: number): number => (far ? farBuilt(far, (g.x1[e * 2] + g.x1[e * 2 + 1]) / 2, (g.z1[e * 2] + g.z1[e * 2 + 1]) / 2) : -1);
    const mostly: Record<string, number[]> = {
      // welcome by the buildings along the street: none, small houses, rows and blocks, tall ones
      small: [0.35, 2.5, 0.6, 0.3],
      town: [0.25, 0.7, 1.8, 2.5],
      country: [2.2, 0.7, 0.4, 0.3],
    };
    const by = mostly[p.mostly];
    const like =
      p.noMain || by
        ? (e: number): number => {
            const c = g.cls[e * 2];
            const main = c >= CLS.PRIMARY && c <= CLS.SECONDARY_LINK;
            const k = by ? kind(e) : -1;
            return (p.noMain && main ? 0.15 : 1) * (by && k >= 0 ? by[k] : 1);
          }
        : undefined;
    return { avoid, like };
  }

  /** where trams can go, for the big map: their tracks and stops (made once per set of tracks) */
  private tramMap: { version: number; tracks: Float32Array[]; stops: Array<{ x: number; z: number; name: string }> } | null = null;
  private tramMapOf: RailTraffic | null = null;
  private tramMapStops: Stops | null = null;

  private tramways(): { version: number; tracks: readonly Float32Array[]; stops: ReadonlyArray<{ x: number; z: number; name: string }> } | null {
    if (this.rail.net.paths.length === 0) return null;
    if (this.tramMap && this.tramMapOf === this.rail && this.tramMapStops === this.stops) return this.tramMap;
    const tracks: Float32Array[] = [];
    for (const p of this.rail.net.paths) {
      if (p.kind !== RAIL.TRAM && p.kind !== RAIL.LIGHT) continue;
      const n = p.pts.length / 3;
      const t = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        t[i * 2] = p.pts[i * 3];
        t[i * 2 + 1] = p.pts[i * 3 + 2];
      }
      tracks.push(t);
    }
    const stops = (this.stops?.tramPlaces() ?? []).map((p) => ({ x: p.x, z: p.z, name: p.name }));
    this.tramMap = { version: (this.tramMap?.version ?? 0) + 1, tracks, stops };
    this.tramMapOf = this.rail;
    this.tramMapStops = this.stops;
    return this.tramMap;
  }

  /** The pedestrian lights of the roads that are loaded: their heads, and their poles in the way of whoever moves. */
  private buildPedLights(): void {
    this.pedPoles = pedPoles(this.app.world);
    this.pedHeads.rebuild(this.pedPoles);
    const discs: number[] = [];
    for (const p of this.pedPoles) discs.push(p.x, p.y, p.z, 0.07);
    this.collider.remove('pedlights');
    this.collider.add({ key: 'pedlights', rings: null, ringCounts: null, segments: null, discs });
  }

  /** the junction whose lights were last said to be out of order, and for how long the car has stood at a lit green arrow */
  private toldDark: Junction | null = null;
  private atArrow = 0;

  /**
   * What the instructor says about lights that are not the usual three
   * lamps – with the rule help on, and not in the test: the lights of the
   * junction ahead are out of order (the signs count), and the green arrow
   * beside a red light is lit (whoever turns right may go).
   */
  private signalTips(dt: number): void {
    const j = this.rules.context.junction;
    if (!j || !this.settings.hudRules || this.rules.strict || this.demo?.active || this.time < this.tipUntil) {
      this.atArrow = 0;
      return;
    }
    const lang = this.settings.lang;
    if (j.dark && j.dist < 70) {
      const node = this.currentLane()?.to ?? null;
      if (node && node !== this.toldDark) {
        this.toldDark = node;
        this.tipText = tr(j.ctrl === CTRL.RBL ? 'tipLightsOutRbl' : 'tipLightsOut', lang);
        this.tipUntil = this.time + 6;
      }
    }
    // standing at the line on red while the arrow is lit: say so after a moment (once per stop)
    if (j.arrow === SIG.GREEN && j.signal !== SIG.GREEN && j.dist < 8 && Math.abs(this.vehicle.speed) < 0.3) {
      const before = this.atArrow;
      this.atArrow += dt;
      if (before < 1.2 && this.atArrow >= 1.2) {
        this.tipText = tr('tipArrow', lang);
        this.tipUntil = this.time + 5;
      }
    } else this.atArrow = 0;
  }

  private laneFront(): number {
    return (this.rules as unknown as { laneS: number }).laneS;
  }

  /** The stops on the lane the bus is in, with their names. */
  private busStopsHere(): { front: number; stops: Array<{ id: number; s: number; name: string }> } {
    const lane = this.currentLane();
    if (!lane) return { front: 0, stops: [] };
    const places = this.stops?.places ?? [];
    return { front: this.laneFront(), stops: this.busStopsOn(lane).map((s) => ({ id: s.id, s: s.s, name: places[Math.floor(s.id / 64)]?.name ?? '' })) };
  }

  /** The bus on a line: the next stop, the doors and the passengers there, pulling out – five stops, then the lesson is done. */
  private updateBusLine(dt: number): void {
    const bs = this.busService;
    if (!bs) return;
    const v = this.vehicle;
    const lang = this.settings.lang;
    const { front, stops } = this.busStopsHere();
    const ev: BusEvent[] = [];
    bs.step(dt, front, stops, v.speed, this.input.c.indicator, ev);
    for (const e of ev) this.rules.noteAt(e.fault, e.severity, this.mpos[0], this.mpos[2], {}, 8);
    const next = bs.next(front, stops);
    this.busNav = next ? tr('tramNextStop', lang, { name: next.name || tr('tramStop', lang), d: Math.max(0, Math.round(next.s - front)) }) : tr('tramNoStop', lang);
    this.lessonLine = tr('tramProgress', lang, { n: Math.min(bs.served, BUS_STOPS), max: BUS_STOPS });
    if (bs.served >= BUS_STOPS && !bs.doorsOpen && Math.abs(v.speed) < 0.3) this.finish();
  }

  private updateLesson(dt: number, p: PlayerState): void {
    const l = this.lesson;
    const lane = this.currentLane();
    const v = this.vehicle;
    const lang = this.settings.lang;
    if (!l) return;
    if (l.kind === 'bus') {
      this.updateBusLine(dt);
      return;
    }
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
    if (this.homeEdge < 0) this.homeEdge = lane.edge.id;
    if (!this.nav.busy) {
      // (the road network comes in pieces: a destination is looked for once the roads all around are there)
      if (!this.app.map.ready(p.x, p.z)) return;
      const type = l.targets[this.targetIdx];
      const home = this.app.world.edges[this.homeEdge] ?? null;
      let goal = type === 'home' && !home ? null : findTarget(this.app.world, this.lanes, type, p.x, p.z, lane, home, this.visited);
      // The way home, or to a motorway, can lead through parts of the map that are not loaded:
      // then it is found in the roads of the whole map and followed like a planned drive.
      if (this.app.map.pieces && (type === 'home' || type === 'motorway') && !(goal && this.nav.setGoal(goal, lane))) {
        this.nav.clear();
        goal = null;
        const g = this.routeGraphNow();
        if (!g) {
          // (the roads of the whole map are still being read)
          this.wantNet();
          return;
        }
        const ways = type === 'home' ? (this.homeEdge === lane.edge.id ? [] : quickestToEdge(g, wayOf(lane), this.homeEdge)) : this.waysToMotorway(g, lane, p.x, p.z);
        if (ways) {
          this.nav.net = g;
          this.nav.setWays(ways, lane, false);
          this.hud.routeLanes = this.nav.routeLanes;
          return;
        }
      }
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
    // pictures a second, for whoever asked for the display (twice a second, from the clock of the pictures)
    this.fpsFrames++;
    if (now - this.fpsSince >= 500) {
      this.hud.setFps(this.fpsSince > 0 && this.state === 'drive' ? (this.fpsFrames * 1000) / (now - this.fpsSince) : -1);
      this.fpsSince = now;
      this.fpsFrames = 0;
    }
    const app = this.app;
    const tiles = app.tiles;

    // the road network around where things happen (it may come in pieces), and the signal heads of what is loaded
    if (this.state === 'placing') app.map.update(this.spawn!.x, this.spawn!.z, 40);
    else if (this.vehicle && this.state !== 'menu' && this.state !== 'loading') app.map.update(this.mpos[0], this.mpos[2], this.state === 'drive' ? 5 : 25);
    if (this.signalsDirty && this.time - this.signalsBuilt > 0.6) {
      this.signalsDirty = false;
      this.signalsBuilt = this.time;
      this.signalHeads.rebuild(app.world, this.signals);
      this.collider.remove('signals');
      this.collider.add({ key: 'signals', rings: null, ringCounts: null, segments: null, discs: this.signalHeads.poles });
      this.buildPedLights();
      this.laneStops.clear();
    }
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
        const stops: SpawnJson[] = [];
        for (const [x, z] of this.autoDemo) {
          const spot = this.roadSpot(x, z, '', 200);
          if (spot) stops.push(spot);
        }
        this.autoDemo = [];
        this.startTrip(stops, this.autoSelf, null);
      }
      if (this.autoTour > 0 && this.time - this.startTime > 0.3 && this.currentLane() && this.routeGraphNow()) {
        const km = this.autoTour;
        this.autoTour = 0;
        void this.planTour(km * 1000, null).then((tour) => {
          if (tour) this.startTrip([], this.autoSelf, tour);
        });
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
      const t = this.trailer;
      if (t && this.truck && this.def.kind === 'truck') this.truck.setTrailer(t.x, t.y, t.z, t.yaw, t.pitch, t.wheelSpin, t.coupled);
      if (t && this.carTrailer && this.def.model !== 'truck') this.carTrailer.place(t.x, t.y, t.z, t.yaw, t.pitch, t.wheelSpin, this.lastVisual);
      // a motorcycle leans into the bend: as far as it must for the speed and the curve
      if (model instanceof PlayerBike) model.setLean(Math.atan(Math.max(-8, Math.min(8, v.accLat)) / 9.81));
      // the aeroplane: where the flight has it, turned every way it is
      if (this.aircraft && this.planeModel) {
        const ac = this.aircraft;
        model.root.position.set(ac.pos.x, ac.pos.y, ac.pos.z);
        model.root.quaternion.set(ac.q[0], ac.q[1], ac.q[2], ac.q[3]);
        model.root.updateMatrixWorld(true);
        this.planeModel.update(this.planeVisual(ac), dt, this.time);
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
    this.pedHeads.update(this.signals);
    this.actors.update(this.traffic.cars, this.traffic.peds, this.time, this.traffic.cyclists.list);
    this.railActors.update(this.rail.vehicles, this.rail.lines);
    // the stops, the overhead line, the tram signals, the people at the stops – around the camera
    this.transit.setRail(this.rail);
    if (this.lines && this.rail.net.paths.length > 0 && (this.lineStopsDirty || this.linesFor !== this.rail)) {
      // the lines: the trams run them, the departure boards list them
      this.lineStopsDirty = false;
      this.linesFor = this.rail;
      const paths = this.rail.net.paths;
      this.transit.lines = this.lines.lines.map((l) => ({ ref: l.ref, to: l.to, stops: l.stops.map(([p, mark]) => paths[p]?.stopNames[paths[p].stops.indexOf(mark)] ?? '') }));
      this.rail.setLines(this.lines.lines.filter((l) => l.paths.every(([p]) => p < paths.length)).map((l) => ({ ref: l.ref, from: l.from, to: l.to, colour: l.colour, kind: l.kind, seq: l.paths.map(([p, d]) => ({ path: p, dir: d > 0 ? 1 : -1 })) })));
    }
    const cam = this.app.camera.position;
    this.transit.update(cam.x, cam.z, this.time, dt, this.signals, this.traffic.cars);

    if (this.state === 'reality') {
      // the panel covers the window: only a 360° panorama is drawn, not the world behind it
      this.reality.render(app.renderer, app.canvas);
    } else if (this.state === 'map') {
      // the map covers the window: nothing of the world needs drawing
    } else if (haveCar) {
      this.updateCamera(dt);
      this.far.update(this.app.camera.position.x, this.app.camera.position.z);
      const mode = this.settings.mirrors;
      if (this.cameraMode === 'cockpit' && mode !== 'off' && !this.walker) {
        const mirrors = model.mirrors;
        const far = Math.min(450, app.tiles.viewRadius * 0.4);
        // (each mirror in the frame of what it is fixed to: the motorcycle's turn with the handlebar and lean with it)
        if (mode === 'full' || this.frames < 4) for (const m of mirrors) m.render(app.renderer, app.scene, (m.mesh.parent ?? model.root).matrixWorld, this.eyeWorld, far);
        else if (mirrors.length > 0) {
          // (one mirror a picture – a cab without mirrors, the tram's, has none to turn)
          const m = mirrors[this.mirrorTurn++ % mirrors.length];
          m.render(app.renderer, app.scene, (m.mesh.parent ?? model.root).matrixWorld, this.eyeWorld, far);
        }
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
    const kmh = (this.tram ? this.tram.speed : v.speed) * 3.6;
    // (a tram is not steered: no steering bar on the screen – the indicators choose the way at a switch)
    this.ui.classList.toggle('rail', !!this.tram);
    if (this.tram && this.model instanceof TramCab) this.model.setLever(this.tram.emergency ? -1.2 : this.tram.lever);
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
    this.lastVisual = s;
    this.model.update(s, dt, this.time);
    // the map on the car's centre display, in the driver's seat (the other vehicles have no such screen)
    const onScreen = this.settings.mapOnScreen && this.cameraMode === 'cockpit' && !this.walker && this.doorT < 0 && this.model === this.car;
    this.car.setMapOnScreen(onScreen);
    this.hud.screen = onScreen ? this.carScreen : null;

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
      engineRunning: v.engineRunning && !this.tram,
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
    if (this.nav.busy && ((this.lesson && this.lesson.kind !== 'basics') || demo)) {
      const what = h.what === 'navRoundabout' ? tr('navRoundabout', lang, { n: h.n }) : tr(h.what, lang);
      if (h.what === 'navFollow' || h.dist < 0) navText = tr('navFollow', lang);
      else if (h.dist < 35) navText = tr('navNow', lang, { what });
      else navText = tr('navIn', lang, { d: Math.round(h.dist / 10) * 10, what });
      this.speak(h.what, h.dist, navText);
      // § 9 StVO: get in lane in good time – the route goes on from a particular lane
      if (h.lane !== 0) navText += ` – ${tr(h.lane < 0 ? 'laneLeft' : 'laneRight', lang)}`;
    } else if (this.lesson?.kind === 'basics' || this.task) navText = this.lessonLine;
    else if (this.lesson?.kind === 'bus') navText = `${this.lessonLine} · ${this.busNav}`;
    let tip = this.time < this.tipUntil ? this.tipText : '';
    // on a touch screen the tip says what to tap – and is itself the button for it
    let tipAction = '';
    const touch = this.inputMode === 'touch';
    const say = (key: string, action: string): void => {
      tip = tr(touch ? `${key}Touch` : key, lang);
      tipAction = action;
    };
    // the bus on a line: the doors at the stop, the people, the indicator to pull out
    const bs = this.busService;
    if (!tip && bs && v.engineRunning) {
      const here = this.busStopsHere();
      if (bs.doorsOpen && bs.passengers > 0) tip = tr('tramPassengers', lang, { n: bs.passengers });
      else if (bs.doorsOpen) say('tramCloseDoors', 'KeyG');
      else if (bs.atStop(here.front, here.stops, v.speed)) say('tramOpenDoors', 'KeyG');
    }
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
      // (on foot there is nothing to read off a dashboard)
      showDash: this.cameraMode !== 'cockpit' || this.def.dash,
      onFoot: !!this.walker,
      // (the reminder of the keys is the car's: not for the tram – its lesson says how it is driven – nor for the
      // aeroplane, whose keys the tip line names)
      noKeyHints: !!this.tram || !!this.aircraft,
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
      // a drive to places or a tour: where it goes – and, when the car drives by itself, what the
      // driver is doing just now and why
      if (!navText) hs.navText = ctx.roadName || tr(demo.active ? 'demo' : 'free', lang);
      const km = (m: number): string => formatUnit(Math.max(0, m) / 1000, 'kilometer', lang, 1);
      const where = demo.tour ? tr('tourRunning', lang, { done: km(v.odometer - demo.tour.odo), total: km(demo.tour.metres) }) : tr('guideRunning', lang, { n: demo.index + 1, max: demo.stops.length });
      hs.navSub = !demo.active ? where : demo.remark ? tr(`demo.${demo.remark}`, lang) : demo.tour ? `${where} · ${tr('demoTakeOver', lang)}` : tr('demoRunning', lang, { n: demo.index + 1, max: demo.stops.length });
    } else if (!navText && !this.lesson) {
      hs.navText = ctx.roadName || tr('free', lang);
      hs.navSub = tr(touch ? 'navSubTouch' : 'navSubKeys', lang);
      hs.navArrow = 0;
    }
    const tram = this.tram;
    if (tram) {
      // the tram: the next stop, the controller, the switch asked for, the doors
      const A = tram.ahead;
      hs.limit = tram.limit;
      hs.zone = 0;
      hs.junction = A.signalIn < 120 && A.signal >= 0 ? { dist: A.signalIn, role: 0, ctrl: CTRL.SIGNALS, signal: A.signal, arrow: -2, dark: false } : null;
      hs.gear = tram.emergency ? '!' : tram.lever > 0.02 ? `+${Math.round(tram.lever * 100)}` : tram.lever < -0.02 ? `−${Math.round(-tram.lever * 100)}` : '0';
      hs.navText = A.stop < 800 ? tr('tramNextStop', lang, { name: this.stopName(A.stopPath, A.stopMark), d: Math.max(0, Math.round(A.stop)) }) : tr('tramNoStop', lang);
      const control = tram.emergency ? tr('tramEmergency', lang) : tram.lever > 0.02 ? tr('tramPower', lang, { p: Math.round(tram.lever * 100) }) : tram.lever < -0.02 ? tr('tramBrake', lang, { p: Math.round(-tram.lever * 100) }) : tr('tramCoast', lang);
      const way = tr(tram.wish > 0 ? 'tramWayLeft' : tram.wish < 0 ? 'tramWayRight' : 'tramWayStraight', lang);
      const parts = [control, way, tr(tram.doorsOpen ? 'tramDoorsOpen' : 'tramDoorsClosed', lang)];
      const line = tram.v.line ? this.rail.lines[tram.v.line.index] : null;
      if (line) parts.unshift(tr('tramLineTo', lang, { line: line.ref, to: line.to }));
      if (this.lesson?.kind === 'tram') parts.unshift(this.lessonLine);
      if (this.tramAuto) parts.unshift(tr('tramAutoRunning', lang));
      hs.navSub = parts.join(' · ');
      hs.navArrow = 0;
      hs.navActive = false;
      hs.tip = '';
      hs.tipAction = '';
      if (tram.doorsOpen && tram.passengers > 0) hs.tip = tr('tramPassengers', lang, { n: tram.passengers });
      else if (tram.doorsOpen) {
        hs.tip = tr(touch ? 'tramCloseDoorsTouch' : 'tramCloseDoors', lang);
        hs.tipAction = 'KeyG';
      } else if (tram.atUnservedStop) {
        hs.tip = tr(touch ? 'tramOpenDoorsTouch' : 'tramOpenDoors', lang);
        hs.tipAction = 'KeyG';
      } else if (A.switchIn < 60 && tram.speed > 0.5) hs.tip = tr('tramSwitchAhead', lang, { d: Math.round(A.switchIn) });
    }
    const w = this.walker;
    if (w && this.def.kind === 'pedestrian' && this.busRide) {
      // on the bus: how fast, and getting off at its stop
      const b = this.busRide;
      hs.navText = tr('busRide', lang, { speed: Math.round(b.v * 3.6) });
      hs.navSub = '';
      hs.navArrow = 0;
      hs.navActive = false;
      hs.tip = '';
      hs.tipAction = '';
      if (this.time < this.tipUntil) hs.tip = this.tipText;
      else if (b.v < 0.05 && b.bus?.doors) {
        hs.tip = tr(touch ? 'rideGetOffTouch' : 'rideGetOff', lang);
        hs.tipAction = 'KeyG';
      }
    } else if (w && this.def.kind === 'pedestrian' && this.riding) {
      // riding along: the next stop, and getting off there
      const rv = this.riding.v;
      const next = this.rail.nextStop(rv);
      hs.navText = next ? tr('tramNextStop', lang, { name: this.stopName(next.path, next.mark), d: Math.round(next.dist) }) : tr('tramNoStop', lang);
      hs.navSub = tr('rideSpeed', lang, { speed: Math.round(Math.abs(rv.speed) * 3.6) });
      hs.navArrow = 0;
      hs.navActive = false;
      hs.tip = '';
      hs.tipAction = '';
      if (this.time < this.tipUntil) hs.tip = this.tipText;
      else if (Math.abs(rv.speed) < 0.05 && rv.dwell > 0) {
        hs.tip = tr(touch ? 'rideGetOffTouch' : 'rideGetOff', lang);
        hs.tipAction = 'KeyG';
      }
    } else if (w && this.def.kind === 'pedestrian') {
      // on foot in the town: the speed, and what there is to do here – a button, a tram to get in
      hs.navText = tr(w.running ? 'footRunning' : 'footWalking', lang, { speed: Math.round(w.speed * 3.6) });
      hs.navSub = '';
      hs.navArrow = 0;
      hs.navActive = false;
      hs.tip = '';
      hs.tipAction = '';
      if (this.time < this.tipUntil) hs.tip = this.tipText;
      else if (this.footBoard) {
        hs.tip = tr(touch ? 'footBoardTouch' : 'footBoard', lang);
        hs.tipAction = 'KeyG';
      } else if (this.footBus) {
        hs.tip = tr(touch ? 'footBusTouch' : 'footBus', lang);
        hs.tipAction = 'KeyG';
      } else if (this.footPole && this.signals.pedestrian(this.footPole.controller, this.footPole.group) === 'red' && !this.signals.requested(this.footPole.controller)) {
        hs.tip = tr(touch ? 'footButtonTouch' : 'footButton', lang);
        hs.tipAction = 'KeyG';
      } else if (this.time - this.walkSince < 12) hs.tip = tr(touch ? 'footHelpTouch' : 'footHelp', lang);
    } else if (w) {
      // on foot: what there is to check round the vehicle, and how far that is done
      hs.navText = tr(w.allChecked ? 'checkDone' : 'walkTitle', lang);
      hs.navSub = w.progress().map((p) => `${tr(CHECK_TEXT[p.id], lang)} ${p.done >= p.of ? '✓' : p.of > 1 ? `${p.done}/${p.of}` : '·'}`).join('  ');
      hs.navArrow = 0;
      hs.navActive = false;
      hs.tip = '';
      hs.tipAction = '';
      if (w.atDoor) {
        hs.tip = tr(touch ? 'getInTouch' : 'getIn', lang);
        hs.tipAction = 'KeyG';
      } else if (w.tooFar) hs.tip = tr('tooFar', lang);
      else if (this.time - this.walkSince < 10) hs.tip = tr(touch ? 'walkHelpTouch' : 'walkHelp', lang);
    } else if (this.doorT < 0 && !demo?.active && !this.task && (!hs.tip || hs.tipAction === 'Enter') && Math.abs(kmh) < 1 && !v.engineRunning && c.handbrake > 0.5 && v.odometer - this.startOdo > 30) {
      // standing, engine off, parking brake on: getting out is offered
      hs.tip = tr(touch ? 'getOutHintTouch' : 'getOutHint', lang);
      hs.tipAction = 'KeyG';
    }
    const ac = this.aircraft;
    if (ac) {
      // flying: how fast through the air (the strip in km/h, the line in knots), how high, climbing or sinking
      hs.speedKmh = ac.ias * 3.6;
      hs.rpm = ac.rpm;
      hs.rpmMax = 2800;
      hs.gear = `${this.flight.flaps * 10}°`;
      hs.limit = 0;
      hs.zone = 0;
      hs.junction = null;
      hs.navText = tr('flyStatus', lang, { ias: Math.round(ac.ias * 1.94384), alt: Math.round((ac.altitude * 3.28084) / 10) * 10, vs: Math.round((ac.verticalSpeed * 196.85) / 50) * 50 });
      hs.navSub = tr('flySub', lang, { t: Math.round(this.flight.throttle * 100), f: this.flight.flaps * 10, rpm: Math.round(ac.rpm / 10) * 10 });
      hs.navArrow = 0;
      hs.navActive = false;
      hs.tipAction = '';
      hs.tip = this.time < this.tipUntil ? this.tipText : ac.stallWarning ? tr('flyStall', lang) : this.time - this.startTime < 20 ? tr(touch ? 'flyHelpTouch' : 'flyHelp', lang) : '';
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
    const w = this.walker;
    if (w || this.doorT >= 0) {
      // on foot: the eyes of somebody standing beside the vehicle – and on the way in or out, from one to the other
      cam.near = 0.06;
      cam.fov = 62;
      const to = this.tmpV;
      const q = this.tmpQ;
      if (w && this.busRide) {
        // on the bus: a seat behind the driver on the right, looking round from there
        const b = this.busRide;
        const s = Math.sin(b.yaw);
        const co = Math.cos(b.yaw);
        const ahead = b.length / 2 - 3.6;
        to.set(b.x - s * ahead + co * 0.6, b.y + 1.95, b.z - co * ahead - s * 0.6);
        q.setFromEuler(new THREE.Euler(w.pitch, b.yaw + w.yaw, 0, 'YXZ'));
      } else if (w && this.riding) {
        // a passenger: on a seat by the window, looking round from there
        const car = this.riding.v.cars[this.riding.car];
        const s = Math.sin(car.yaw);
        const co = Math.cos(car.yaw);
        const side = this.riding.side * (this.riding.v.consist.width / 2 - 0.55);
        to.set(car.x + co * side, car.y + TRAM_FLOOR + 1.22, car.z - s * side);
        q.setFromEuler(new THREE.Euler(w.pitch, car.yaw + w.yaw, 0, 'YXZ'));
      } else if (w) {
        to.set(w.x, w.y + EYE, w.z);
        q.setFromEuler(new THREE.Euler(w.pitch, w.yaw, 0, 'YXZ'));
      } else {
        to.copy(this.eyeWorld);
        q.copy(car.quaternion);
      }
      if (this.doorT >= 0) {
        const k = Math.min(1, this.doorT / 0.6);
        cam.position.copy(this.doorFrom.pos).lerp(to, k);
        cam.quaternion.copy(this.doorFrom.quat).slerp(q, k);
      } else {
        cam.position.copy(to);
        cam.quaternion.copy(q);
      }
      cam.updateProjectionMatrix();
      return;
    }
    if (this.cameraMode === 'cockpit') {
      cam.near = 0.06;
      cam.fov = 60;
      cam.position.copy(this.eyeWorld);
      // looking over the shoulder also moves the head a little towards that side
      // (on a demonstration drive the head turns as the driver looks over the shoulder – not in a jerk)
      const want = this.demo?.active ? this.demo.look * 0.8 : 0;
      this.demoHead += Math.max(-dt * 5, Math.min(dt * 5, want - this.demoHead));
      // (a rider looks a little down the road: the instruments, the bar and the mirrors in view)
      const gaze = this.model instanceof PlayerBike ? this.model.gaze : this.aircraft ? 0.17 : 0;
      this.tmpQ.setFromEuler(new THREE.Euler(c.lookPitch - gaze, c.lookYaw + this.demoHead, 0, 'YXZ'));
      cam.quaternion.copy(car.quaternion).multiply(this.tmpQ);
      if (this.model instanceof PlayerBike) {
        // the rider leans with the motorcycle: the eye swings round the line where the tyres touch the road
        BIKE_ROLL.setFromAxisAngle(AXIS_Z, -this.model.leaning);
        this.eyeWorld.copy(this.model.eye).applyQuaternion(BIKE_ROLL).applyMatrix4(car.matrixWorld);
        cam.position.copy(this.eyeWorld);
        cam.quaternion.copy(car.quaternion).multiply(BIKE_ROLL).multiply(this.tmpQ);
      }
    } else if (this.cameraMode === 'chase') {
      cam.near = 0.3;
      cam.fov = 55;
      // The camera circles a point above the car: the mouse (or a finger) turns it all the way
      // round and from road level up to a bird's view, the wheel changes the distance.
      // (With a trailer it circles the coupling – the middle of the combination – and looks from
      // higher up, so that the trailer does not hide the road and its end can be watched.)
      // (While reversing on the yard it looks down steeply on the trailer's axles: what matters is
      // where the trailer's end goes, and that lies behind.)
      const long = this.def.long;
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
    } else if (this.cameraMode === 'free') {
      cam.near = 0.3;
      cam.fov = 55;
      const fc = this.fc;
      const t = this.input.takeCam();
      const long = this.def.long;
      if (!fc.ready) {
        // from where the camera is now, looking the way it looks
        fc.ready = true;
        fc.off.copy(cam.position).sub(car.position);
        const dir = cam.getWorldDirection(this.tmpV);
        fc.yaw = Math.atan2(-dir.x, -dir.z);
        fc.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
        // (from the driver's seat, or from nowhere in particular: start behind the car instead)
        if (fc.off.length() < 2.5 || fc.off.length() > 400) fc.ready = false;
      }
      if (!fc.ready || t.reset) {
        // behind the car, a little above it
        fc.ready = true;
        const back = long ? 20 : 8;
        fc.off.set(Math.sin(v.yaw) * back, long ? 7 : 3.2, Math.cos(v.yaw) * back);
        fc.yaw = v.yaw;
        fc.pitch = -0.28;
      }
      fc.yaw += t.yaw;
      fc.pitch = Math.max(-1.5, Math.min(1.3, fc.pitch + t.pitch));
      const sy = Math.sin(fc.yaw);
      const cy = Math.cos(fc.yaw);
      const cp = Math.cos(fc.pitch);
      const sp = Math.sin(fc.pitch);
      const tiles = this.app.tiles;
      let ground = tiles.heightAt(car.position.x + fc.off.x, car.position.z + fc.off.z);
      if (Number.isNaN(ground)) ground = car.position.y;
      // what a drag or a key moves it by grows with the height: metres near the ground, a block from high up
      const reach = Math.max(4, Math.min(220, (car.position.y + fc.off.y - ground) * 1.6 + 3));
      const speed = (t.fast ? 4 : 1) * Math.max(5, Math.min(90, reach * 0.9));
      const right = t.right * reach + t.keyRight * speed;
      const fwd = t.fwd * reach + t.keyFwd * speed;
      const dolly = t.dolly * reach;
      fc.off.x += cy * right - sy * fwd - sy * cp * dolly;
      fc.off.z += -sy * right - cy * fwd - cy * cp * dolly;
      fc.off.y += sp * dolly + t.keyUp * speed * 0.7;
      // it stays within the part of the map that is loaded around the car, and above the ground
      const far = Math.min(900, tiles.viewRadius * 0.7);
      const hd = Math.hypot(fc.off.x, fc.off.z);
      if (hd > far) {
        fc.off.x *= far / hd;
        fc.off.z *= far / hd;
      }
      ground = tiles.heightAt(car.position.x + fc.off.x, car.position.z + fc.off.z);
      if (Number.isNaN(ground)) ground = car.position.y;
      fc.off.y = Math.max(ground + 0.4, Math.min(ground + 600, car.position.y + fc.off.y)) - car.position.y;
      cam.position.copy(car.position).add(fc.off);
      this.camSnap = false;
      cam.quaternion.setFromEuler(new THREE.Euler(fc.pitch, fc.yaw, 0, 'YXZ'));
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
      // the road network that is loaded (it may come in pieces around the car), and whether the roads of the whole map are known
      roads: this.app.world ? { pieces: this.app.map.pieces, edges: this.app.world.allEdges.size, nodes: this.app.world.allNodes.size, whole: this.netIndex !== null } : null,
      trip: this.demo ? { auto: this.demo.active, tour: this.demo.tour ? Math.round(this.demo.tour.metres) : 0, route: this.nav.route?.length ?? -1, left: this.nav.left } : null,
    };
  }
}
