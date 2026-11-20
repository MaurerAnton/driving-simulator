// SPDX-License-Identifier: AGPL-3.0-only
/** Game orchestration: loading, menus, the main loop, cameras, lessons. */
import * as THREE from 'three';
import { GameAudio, soundKindOf } from '../audio/audio.ts';
import { Sirens } from '../audio/siren.ts';
import { Emergencies } from '../sim/emergency.ts';
import { Input } from '../input/input.ts';
import type { Action } from '../input/input.ts';
import { clearObjects, clearSigns, clearWalls, postInLane } from '../sim/clearlanes.ts';
import { SceneryCollider } from '../sim/collision.ts';
import { Explosion } from '../render/explosion.ts';
import { playBoom } from '../audio/boom.ts';
import { WorldGround } from '../sim/ground.ts';
import { RuleMonitor } from '../sim/rules.ts';
import type { PlayerSnapshot } from '../sim/rules.ts';
import { markArrows } from '../sim/arrows.ts';
import { COMPACT_DIMS } from '../render/carBody.ts';
import { CheckMarkers, EYE, OnFoot, TETHER } from './onfoot.ts';
import { isDoor } from './cardoors.ts';
import { OpenPlay } from './openplay.ts';
import type { CheckId, WalkUnit, WalkVehicle } from './onfoot.ts';
import { SIG, SignalSystem } from '../sim/signals.ts';
import { Traffic } from '../sim/traffic.ts';
import { crowdTarget } from '../sim/pedestrians.ts';
import type { BusStopOnLane, Pedestrian, PlayerState, TrafficCar } from '../sim/traffic.ts';
import type { Cyclist } from '../sim/cyclists.ts';
import type { SignalSnapshot } from '../sim/signals.ts';
import { CAR_FIELDS, CYCLIST_FIELDS, PED_FIELDS, RAIL_CAR_FIELDS, RAIL_HEAD, Recorder, ReplayView } from './replay.ts';
import type { ReplayFrame } from './replay.ts';
import { Vehicle } from '../sim/vehicle/index.ts';
import { bikeLean, LIGHT_TRUCK, MINIBUS } from '../sim/vehicle/fleet.ts';
import type { DriverInput } from '../sim/vehicle/index.ts';
import { SignalRenderer, TrafficRenderer } from '../render/actors.ts';
import { PedLightRenderer } from '../render/pedlights.ts';
import { PlayerFigure, WalkerModel } from '../render/walker.ts';
import { FLOOR as TRAM_FLOOR, PassengerView } from '../render/passenger.ts';
import { FarTerrain } from '../render/far.ts';
import { TransitScene } from '../render/transit.ts';
import { RoadworksRenderer } from '../render/roadworks.ts';
import { WildView } from '../render/wildlife.ts';
import { Wildlife, worldRoads } from '../sim/wildlife.ts';
import { LevelCrossingRenderer } from '../render/levelcrossings.ts';
import { LevelCrossings } from '../sim/levelcrossing.ts';
import { RoadEvents } from '../sim/roadevents.ts';
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
import { CarExterior, PlayerCar } from '../render/car.ts';
import { CyclistModel } from '../render/cyclist.ts';
import { PeopleRenderer } from '../render/people.ts';
import type { CarVisualState } from '../render/car.ts';
import { PropRenderer } from '../render/props.ts';
import { SignRenderer } from '../render/signs.ts';
import { SignalTimers } from '../ui/signaltimers.ts';
import { QueueLabels } from '../ui/queuelabels.ts';
import { TimedRules, loadExtraSigns } from '../world/extrasigns.ts';
import type { ExtraSigns } from '../world/extrasigns.ts';
import type { LoadedTile } from '../render/tiles.ts';
import { latLonToWorld, worldToLatLon } from '../geo/utm.ts';
import { AddressIndex, findRoadSpot, mainNetwork } from './address.ts';
import type { AddressHit, AddressJson } from './address.ts';
import { Hud, SEASON_CHOICES, SEASON_KEYS, WEATHER_CHOICES, WEATHER_KEYS } from '../ui/hud.ts';
import { MirrorZoomPanel } from '../ui/mirrorzoom.ts';
import { HudMirror } from '../ui/hudmirror.ts';
import { ScreenTap } from '../ui/screentap.ts';
import { WalkControl, planFootPath, walkModeOf } from './walkmodes.ts';
import type { FootRoad } from './walkmodes.ts';
import { FlyCam } from './flycam.ts';
import { TouchStick } from '../ui/touchstick.ts';
import { WorldTap } from '../ui/worldtap.ts';
import type { HudState, ReplayState, ResultSummary, RunwayChoice, TramStopChoice } from '../ui/hud.ts';
import type { MenuPreview } from '../ui/carousel.ts';
import { stageFrame } from '../ui/stage.ts';
import { Stops } from '../world/stops.ts';
import { LANGS, formatUnit, isRtl, lessonIntro, lessonTitle, loadLang, localeOf, setKeyStyle, tr } from '../i18n/index.ts';
import { speech } from '../audio/speech.ts';
import { gameClock, gameNow, sunAt } from './clock.ts';
import { busSchedule, resyncBuses, tramSchedule } from './timedtransit.ts';
import { downloaded, formatBytes } from './netstats.ts';
import { clockBadge } from '../ui/arcade.ts';
import { Outdoors } from './outdoors.ts';
import { weatherNow } from './weather.ts';
import { rainIntensity, snowIntensity, windVector } from './weather.ts';
import { WindscreenView } from '../render/windscreen.ts';
import { ASSIST_BEGINNER, ASSIST_LIGHT, FlightAssist, FlightAutopilot, landingRunway, runwayAt } from '../sim/autopilot.ts';
import type { AutopilotState } from '../sim/autopilot.ts';
import { WEATHER_PARTICLES } from '../render/weather.ts';
import { initKeyLabels } from '../i18n/keys.ts';
import { RealityPanel } from '../ui/reality.ts';
import { Online } from '../net/online.ts';
import type { Snapshot } from '../net/multiplayer.ts';
import { extraLayers } from '../ui/maplayers.ts';
import { LaneGraph, TURN, lanePoint } from '../world/lanes.ts';
import type { Lane } from '../world/lanes.ts';
import { newPolySample, projectOnPolyline, samplePolyline } from '../core/geom.ts';
import type { SignPost } from '../world/tilefmt.ts';
import { tileKey } from '../world/tilefmt.ts';
import { PartCache, sourceFor } from '../world/partcache.ts';
import { useTileSource } from '../world/mappack.ts';
import { versionedTiles, versionsOfTile, type PartIndex } from '../world/tileversions.ts';
import { TILE, gridIndex } from '../world/grid.ts';
import { CLS, CTRL, EF, RAIL, STOP_FLAG, SURF_ROLLING, XING } from '../world/types.ts';
import type { SpawnJson } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { Edge, Node as Junction } from '../world/world.ts';
import { App } from './app.ts';
import { turnedSpot } from './turnaround.ts';
import { LESSONS, Navigator, findTarget } from './nav.ts';
import { planTourInSlices } from './tour.ts';
import { ROUTE_PRESETS, RouteWatch, planPreset, presetOfMode, routeLine } from './routepresets.ts';
import { findLessonPlace, lessonStart, placeKindOf, searchRadius } from './lessonplaces.ts';
import type { LessonStart } from './lessonplaces.ts';
import { lessonStartPanel } from '../ui/lessonstart.ts';
import { LessonWatch, canWatch } from './lessonwatch.ts';
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
import { Watcher, lineTakeOver, lineWay, transitSource } from './spectate.ts';
import { TapPicker, takeKindOf } from './takeover.ts';
import type { PickBox, PickTarget } from './takeover.ts';
import { ShowSpots } from './showdrive.ts';
import { PointWatcher } from './pointwatch.ts';
import { FUEL_PRICE_SOURCE, fuelPrices } from '../world/fuelprices.ts';
import { priceAt } from '../world/services.ts';
import type { WatchTarget } from './pointwatch.ts';
import type { RoadEventInfo } from '../sim/roadevents.ts';
import type { TakeOver } from './spectate.ts';
import type { TransitSource, WatchRequest } from '../ui/transitmap.ts';
import { roadSource } from '../ui/pathdraw.ts';
import type { TourPreview } from '../ui/bigmap.ts';
import { RailTraffic, carLayout, consistLength, consistOf } from '../sim/rail.ts';
import type { RailObstacle, RailVehicle } from '../sim/rail.ts';
import { departures, parseTimetable, scheduledAt, serviceTime } from '../sim/timetable.ts';
import { loadBusLines } from '../world/buslines.ts';
import type { Timetable } from '../sim/timetable.ts';
import type { CrossingJson } from '../world/types.ts';
import { RailActors } from '../render/trams.ts';
import { PlayerTruck } from '../render/truck.ts';
import { PlayerBike, PlayerBus, PlayerTractor, TramCab } from '../render/fleet.ts';
import type { BikeVariant } from '../render/bike.ts';
import { TramDriver, tramStart } from '../sim/tramdrive.ts';
import type { TramEvent } from '../sim/tramdrive.ts';
import type { VehicleModel } from '../render/fleet.ts';
import type { VehicleScreen } from '../render/navscreen.ts';
import { VEHICLES, powerOf, trailerOf, vehicleKind } from './vehicles.ts';
import type { ModelKind, VehicleDef, VehicleKind } from './vehicles.ts';
import { YardScene } from '../render/yard.ts';
import { Trailer } from '../sim/trailer.ts';
import { SemiTrailer, makeTrailer } from '../sim/semitrailer.ts';
import { PlayerRigid, PlayerSemi, linkTowed, towedModel } from '../render/semitruck.ts';
import type { TowedModel } from '../render/semitruck.ts';
import { taskTextKey } from './semice.ts';
import { COUPLING_STEPS, MAX_CORRECTIONS, TRAILER_AXLES, TRAILER_OUTLINE, TRUCK_AXLES, TRUCK_OUTLINE, YardFrame, offArea } from './ce.ts';
import type { CouplingStepId, TaskId } from './ce.ts';
import { YardTask } from './yardtask.ts';
import { DrillRun } from './drillplay.ts';
import { examDrills } from './drills.ts';
import type { DrillId } from './drills.ts';
import { DrillScene } from '../render/drillyard.ts';
import { CraneWork, craneMenuPose, craneMenuSite, craneStart, isCraneModel } from './craneplay.ts';
import { makeCraneModel } from '../render/crane.ts';
import { ForkliftWork, forkliftMenuSite, forkliftStart, isForkliftModel } from './forkliftplay.ts';
import { FORK_WORK_MODE, forkCamera } from './forkliftmodes.ts';
import { ForkliftModel } from '../render/forklift.ts';
import type { CraneType } from '../sim/crane.ts';
import { TheoryMode } from './theorymode.ts';
import { THEORY_MODE } from './theory.ts';
import { noteLessonEnd } from './exam/learnstore.ts';
import { AutoDriver } from '../sim/autodriver.ts';
import { followMap } from '../sim/follow.ts';
import { narrowCollide } from '../sim/narrowings.ts';
import { ServiceWorld } from './serviceworld.ts';
import { Wading } from './wading.ts';
import { BeamPlay } from './beamplay.ts';
import type { Settings } from './settings.ts';
import { SpawnCars } from './spawncar.ts';
import type { Parked } from './spawncar.ts';
import { exactSpots, freeNear, inBuilding } from './spawnplace.ts';
import { locate } from '../ui/geolocate.ts';
import { ArcadeDrive, arcadeTransmission } from './arcadedrive.ts';

type State = 'loading' | 'menu' | 'intro' | 'placing' | 'drive' | 'pause' | 'reality' | 'map' | 'result' | 'replay' | 'theory';
/** the driver's seat, behind the car, a camera that is moved about freely – and a fixed one for pictures (?cam=) */
type CameraMode = 'cockpit' | 'chase' | 'free' | 'dev';

const PHYS_DT = 1 / 240;

/** What the aeroplane's autopilot is doing, in a few words a pilot would use (a text key). */
function apPhaseKey(st: AutopilotState): string {
  switch (st.phase) {
    case 'lineup':
    case 'takeoffRoll':
    case 'rotate':
    case 'initialClimb':
      return 'ap.takeoff';
    case 'rejected':
      return 'ap.rejected';
    case 'climb':
      return 'ap.climb';
    case 'upwind':
    case 'crosswind':
    case 'downwind':
    case 'base':
      return 'ap.circuit';
    case 'final':
    case 'flare':
      return 'ap.final';
    case 'rollout':
    case 'stopped':
      return 'ap.landed';
    case 'goAround':
      return 'ap.goAround';
    case 'orbit':
      return 'ap.orbit';
    case 'enroute':
    case 'route':
      return 'ap.enroute';
    default:
      return 'ap.hold';
  }
}

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

/** (for the own vehicle's angles, sent to the other players) */
const NET_EULER = new THREE.Euler();

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
  /** the work with a crane on the construction site (game/craneplay.ts; null: no crane is worked) */
  private crane: CraneWork | null = null;
  /** the forklift on the practice yard (game/forkliftplay.ts; null: not driving one) */
  private forklift: ForkliftWork | null = null;
  /** the box trailer behind a car (class BE) */
  private carTrailer: TowedModel | null = null;
  /** the car's centre display, for the HUD to draw the map on */
  private readonly carScreen: VehicleScreen = { canvas: this.car.mapCanvas, drawn: (): void => void (this.car.mapTexture.needsUpdate = true), setLive: (on) => this.car.setMapOnScreen(on), hitMesh: () => this.car.screenMesh };
  /** what the vehicle's lamps showed in the last picture (for the trailer's) */
  private lastVisual: CarVisualState | null = null;
  /** the truck with the trailer of the class CE (its yard tasks, the coupling) */
  private get isTruck(): boolean {
    return this.def.model === 'truck' || this.def.model === 'semi';
  }
  /** the practice yard of the truck lessons, and the task that is being done on it */
  private readonly yardScene = new YardScene();
  private yardFrame: YardFrame | null = null;
  private task: { run: YardTask; laid: boolean; order: Map<string, number>; second: boolean } | null = null;
  private tasksLeft: TaskId[] = [];
  private taskCount = 0;
  private taskFailed = false;
  private taskSub = '';
  /** the basic tasks of class B on the practice yard (game/drillplay.ts), while such a lesson runs – kept for its result */
  private drill: DrillRun | null = null;
  private readonly drillScene = new DrillScene();
  private readonly drillPos = [0, 0, 0];
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
    /** the player has taken the wheel for a moment (the assisted autopilot): it drives on when let go, after `freeT` s without a hand on it */
    held: boolean;
    freeT: number;
    lost: number;
    /** when a way may be looked for again (after a search that found none) */
    searchAt: number;
    stuck: number;
    /** how often it was put on (the last minute), and when last */
    rescues: number;
    rescuedAt: number;
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
  /** a set route being driven (game/routepresets.ts): is it kept?  And one to start once the drive is placed (from the menu). */
  private routeWatch: RouteWatch | null = null;
  private presetPending = '';
  /** a lesson in a real place (game/lessonplaces.ts): what to look for once the roads round the start are there – and the destination found with it */
  private placeSearch: LessonStart | null = null;
  private placeGoal: Edge | null = null;
  /** watching the lesson: the autopilot drives it (game/lessonwatch.ts); the lesson's start panel was answered (ui/lessonstart.ts) */
  private lessonWatch: LessonWatch | null = null;
  private lessonChosen = false;
  private camSnap = false;
  private demoHead = 0;
  /** trams and trains on the tracks around the player */
  private rail!: RailTraffic;
  private readonly railActors = new RailActors();
  private readonly railBoxes: PlayerState[] = [];
  private readonly railOthers: RailObstacle[] = [];
  signalHeads!: SignalRenderer;
  /** the timers over the traffic lights (ui/signaltimers.ts) */
  private signalTimers!: SignalTimers;
  /** the labels over the queues in the traffic (ui/queuelabels.ts) – made with the first one to show */
  private queueLabels: QueueLabels | null = null;
  /** the signs the map was built without (signs.json.gz, world/extrasigns.ts): added to each tile */
  private extraSigns: ExtraSigns | null = null;
  /** the pedestrian lights: their poles (with the buttons) and their heads */
  private pedPoles: PedPole[] = [];
  private readonly pedHeads = new PedLightRenderer();
  /** inside the tram one rides in as a passenger */
  private readonly passengerView = new PassengerView();
  /** the ground beyond the map's tiles: the hills on the horizon */
  private readonly far = new FarTerrain();
  /** driving through water: its depth for the wheels, the wash, wet brakes, a drowned engine, the spray (game/wading.ts) */
  private wading!: Wading;
  /** stops, platforms, people waiting, the overhead line and the tram signals around the camera */
  private transit!: TransitScene;
  /** the roadworks and the demonstrations of the day (src/sim/roadevents.ts – `roadEvents.list()` for the map), and how they are drawn */
  roadEvents!: RoadEvents;
  private roadworks!: RoadworksRenderer;
  /** the level crossings: lights, barriers and bells, driven by the trains (src/sim/levelcrossing.ts), and how they are drawn */
  private levelCrossings!: LevelCrossings;
  private crossingView!: LevelCrossingRenderer;
  // ------------------------------------------------- the aeroplane
  /** the aeroplane being flown (null: none), its model, and the airfields of the map with their firm ground */
  private aircraft: Aircraft | null = null;
  private planeModel: PlaneModel | null = null;
  private air: AirJson | null = null;
  /** the aeroplane's autopilot (take-off, holding height and heading, to a place, the circuit and landing), and the help for flying by hand */
  private readonly flightAuto = new FlightAutopilot();
  private readonly flightAssist = new FlightAssist(ASSIST_BEGINNER);
  /** how long the stick has been moved while the autopilot flies (taking over), and a demonstration flight to begin once the aeroplane stands */
  private flightTake = 0;
  /** where the autopilot is to fly once it has taken off (a place chosen on the map while standing on the runway) */
  private flightGoto: { x: number; z: number; alt: number } | null = null;
  private planeDemoPending = false;
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
  /** the weather and the season (game/outdoors.ts): made once the map is read */
  private outdoors: Outdoors | null = null;
  /** what keeps the rain out of the cab now (the model it is fixed to; null: none) */
  private shelterOf: THREE.Object3D | null = null;
  /** a vehicle that hit a building at speed went up in flames (render/explosion.ts) */
  private readonly explosion = new Explosion();
  /** … and is gone: the player goes on on foot, and may take a new vehicle (the door key, or the button) */
  private wrecked = false;
  readonly audio = new GameAudio();
  /** the horns of the emergency vehicles (src/audio/siren.ts) */
  private readonly sirens = new Sirens();
  /** fuel stations and car washes, the fuel in the tank, the dirt on the vehicle, a truck's load (game/serviceworld.ts) */
  private services!: ServiceWorld;
  state: State = 'loading';
  cameraMode: CameraMode = 'cockpit';

  private last = 0;
  private time = 0;
  private acc = 0;
  private frames = 0;
  private fpsFrames = 0;
  private fpsSince = 0;
  private mirrorTurn = 0;
  /** the windscreen in rain and snow, and the wiper stalk (render/windscreen.ts, game/wipers.ts) */
  private readonly windscreen = new WindscreenView();
  /** looking into a mirror, large over the picture (ui/mirrorzoom.ts) – made with the first picture of a drive */
  private mirrorZoom: MirrorZoomPanel | null = null;
  /** the inside mirror moved in the car or taken off into the HUD (ui/hudmirror.ts) */
  private hudMirror: HudMirror | null = null;
  /** a tap on the vehicle's screen: the big map or the corner map (ui/screentap.ts) */
  private screenTap: ScreenTap | null = null;
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
  /** arcade driving (a setting): D and R by the pedals, held at a standstill, the engine always running (game/arcadedrive.ts) */
  private readonly arcadeDrive = new ArcadeDrive();
  private autoDrive = 0;
  private tipText = '';
  /** the headlights: their light, the traffic's lamps and main beam, the rules of § 17 StVO (game/beamplay.ts) */
  private readonly beams = new BeamPlay();
  /** the deer and wild boar crossing the country roads at dusk (sim/wildlife.ts), drawn */
  private readonly wildView = new WildView();
  /** every fault of this and of earlier sessions */
  private readonly faultLog = new FaultLog();
  /** the server, when the player set one: accounts, progress, photos, playing together (net/online.ts) */
  private online: Online | null = null;
  /** where the car has been, for the map */
  private readonly path = new DrivenPath();
  private bigMap!: BigMap;
  /**
   * The maps' trams and buses (spectate.ts transitSource); a tram or bus being
   * watched (spectate.ts); the line a tram taken over keeps to; what is to be
   * done once the vehicle is placed (a bus taken over is shown its line's
   * way); the height the aeroplane is to be put at (m above the ground, 0: on
   * a runway).
   */
  private transitSrc: TransitSource | null = null;
  private watcher: Watcher | PointWatcher | null = null;
  private tramLineRef = '';
  private afterPlace: (() => void) | null = null;
  private airAgl = 0;
  /** what the map was opened from – closing it leads back there (from the main menu: a place tapped on it is where the drive will begin) */
  private mapFrom: 'drive' | 'pause' | 'menu' = 'drive';
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
  private readonly tmpM = new THREE.Matrix4();
  private readonly headV = new THREE.Vector3();
  /** the player's own figure on foot, seen from behind */
  private readonly figure = new PlayerFigure();
  /** the drive written down as it goes, the replay being watched, where it was opened from, and the live lights meanwhile */
  private readonly recorder = new Recorder();
  private replay: ReplayView | null = null;
  private replayFrom: 'pause' | 'result' = 'pause';
  private replayLive: SignalSnapshot | null = null;
  private replayShown: SignalSnapshot | null = null;
  private replayHidden: RailVehicle | null = null;
  private readonly replayCam = { mode: 'behind' as 'behind' | 'driver' | 'free', yaw: 0, pitch: -0.25, dist: 9 };
  private lastResult: ResultSummary | null = null;
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
    panel.innerHTML = '<h1>Fahrsim <span>Baunatal</span></h1><p></p><div class="progress known"><i style="width:0%"></i></div><small class="progress-pct">0 %</small>';
    (panel.querySelector('p') as HTMLElement).textContent = tr('loading', lang);
    loading.append(panel);
    this.ui.append(loading);
    // how far it is: each step's share is reached when it is done – meanwhile the bar creeps on towards it
    const bar = panel.querySelector('.progress i') as HTMLElement;
    const pct = panel.querySelector('.progress-pct') as HTMLElement;
    let shown = 0;
    let from = 0.05;
    let to = 0.45;
    let since = performance.now();
    const show = (p: number): void => {
      shown = Math.max(shown, Math.min(1, p));
      bar.style.width = `${Math.round(shown * 100)}%`;
      pct.textContent = `${Math.round(shown * 100)} % · ${formatBytes(downloaded(), localeOf(this.settings.lang))}`;
    };
    const step = (done: number, next: number): void => {
      show(done);
      from = done;
      to = next;
      since = performance.now();
    };
    const creep = setInterval(() => show(from + (to - from) * 0.9 * (1 - Math.exp(-(performance.now() - since) / 2500))), 120);
    show(0.05);
    try {
      await app.loadWorld();
    } finally {
      // (on an error the message takes the screen: the bar stops)
      if (!app.world) clearInterval(creep);
    }
    step(0.45, 0.75);
    const world = app.world;
    // the weather and the season: the tiles', the trees' and the far hills' materials learn them before the first tile is drawn
    this.outdoors = new Outdoors(app.scene, app.sky, WEATHER_PARTICLES[this.settings.quality === 'custom' ? 'medium' : this.settings.quality]);
    this.outdoors.view.roadWater = this.settings.graphics.weatherFx;
    const learn = (m: THREE.Material, k: Parameters<Outdoors['patch']>[1]): void => this.outdoors?.patch(m, k);
    app.tiles.setMaterialHook(learn);
    this.props.setSeason(learn);
    this.far.setSeason(learn);
    await new Promise((r) => setTimeout(r));
    this.lanes = new LaneGraph(world);
    this.signals = new SignalSystem(world.signals, world.lightsOut);
    // (the green arrows of what is there already – a map in one piece; the pieces of a map in pieces get theirs as they come)
    markArrows(world, this.lanes, this.signals, world.allNodes);
    this.traffic = new Traffic(world, this.lanes, this.signals);
    // the buses of the lines with timetables come where and when their trips are (src/game/timedtransit.ts)
    this.traffic.busSchedule = busSchedule({ timetable: () => this.timetable, source: () => this.transitData(), traffic: () => this.traffic, nowMs: () => gameClock.ms() });
    // now and then an emergency vehicle on a call, police on patrol (src/sim/emergency.ts; ?emergency=<s>: a call every <s> seconds)
    this.traffic.emergency = new Emergencies(this.traffic, Number(new URLSearchParams(location.search).get('emergency')) || 0);
    this.rules = new RuleMonitor(world, this.lanes, this.signals, this.traffic);
    this.nav = new Navigator(this.lanes);
    this.ground = new WorldGround(world, app.tiles);
    this.wading = new Wading(app.tiles);
    this.ground.waterDepth = (x, z) => this.wading.depth.at(x, z);
    app.scene.add(this.wading.group);
    this.signs = new SignRenderer(new URL('signs/', document.baseURI).href, app.renderer.capabilities.getMaxAnisotropy());
    // (and the signs the map was built without – with the rules of those with a time on them, by the game's clock)
    const [, extra] = await Promise.all([this.signs.init(), loadExtraSigns(app.map)]);
    this.extraSigns = extra;
    if (extra) {
      this.rules.timed = new TimedRules(extra.rules, gameNow);
      // ("bei Nässe": while the road is wet – the weather of game/weather.ts, real or chosen)
      this.rules.timed.wet = () => weatherNow().wet > 0.3;
    }
    step(0.75, 0.98);
    this.signalHeads = new SignalRenderer(world, this.signals);
    this.collider.add({ key: 'signals', rings: null, ringCounts: null, segments: null, discs: this.signalHeads.poles });
    this.buildPedLights();
    this.transit = new TransitScene(world, (x, z, yRef) => this.footGround(x, z, yRef));
    // the people on foot in the town (sim/pedestrians.ts): posts and walls in their way, the stops they go to and get off at
    this.traffic.crowd.blocked = (x, y, z, r) => this.collider.circleBlocked(x, y, z, r);
    this.traffic.crowd.toStop = (p) => this.transit.join(p.x, p.y, p.z, p.colour);
    this.transit.onAlight = (x, y, z, look) => this.traffic.crowd.adopt(x, y, z, look);
    this.traffic.crowd.standing = () => this.transit.waiting;
    this.actors.view = app.camera;
    this.actors.highOf = (id) => this.beams.traffic.high(id);
    this.airfieldView = new AirfieldRenderer((x, z) => this.groundHeight(x, z), (x, z) => !Number.isNaN(this.app.tiles.heightAt(x, z)));
    this.services = new ServiceWorld({ scene: app.scene, collider: this.collider, ui: this.ui, map: app.map, ground: (x, z) => app.tiles.heightAt(x, z), onRoad: (x, z) => app.world.surfaceAt(x, z, app.tiles.heightAt(x, z) + 1, this.hit), blocked: (x, z, yaw) => this.collider.blocked(x, app.tiles.heightAt(x, z), z, yaw, 0.2), lang: () => this.settings.lang, message: (t, sub) => this.hud.message(t, sub), click: (k) => this.audio.click(k), hideOverlay: () => this.hud.hideOverlay(), rules: this.rules, shadows: () => this.settings.graphics.shadows !== 'off' });
    this.services.dirtShown = this.settings.graphics.weatherFx;
    await this.services.load();
    this.spawnCars = this.makeSpawnCars();
    // (a tap on a vehicle: watch it, or get into a model of the test place – game/takeover.ts)
    new TapPicker(app.canvas, app.camera, () => this.pickBoxes(), (t) => this.picked(t));
    app.tiles.onTile((tile, loaded) => this.onTile(tile, loaded));
    app.scene.add(this.car.root, this.actors.group, this.railActors.group, this.signalHeads.group, this.pedHeads.group, this.passengerView.group, this.far.group, this.transit.group, this.airfieldView.group, this.yardScene.group, this.drillScene.group, this.markers.group, this.figure.group, this.showGroup, this.showRail.group, this.showPeople.group, this.explosion.group);
    this.showGroup.name = 'every model';
    this.fadeEl.className = 'fade';
    this.ui.append(this.fadeEl);
    this.yardFrame = world.json.yard ? new YardFrame(world.json.yard) : null;
    this.rail = new RailTraffic(world.json.rails ?? []);
    // The road network may come in pieces around the car: lanes, traffic and signals follow it.
    followMap(app.map, { lanes: this.lanes, traffic: this.traffic, signals: this.signals, changed: () => (this.signalsDirty = true) });
    // the roadworks and demonstrations of the day: the traffic, the rules and the way planners know them; the map's pieces bring their zones
    this.roadEvents = new RoadEvents(world, this.lanes, this.signals);
    // deer and wild boar at dusk where forests meet the country roads: the traffic brakes for them
    this.traffic.wild = new Wildlife({ sun: () => this.beams.sunElevation, coverAt: (x, z) => app.tiles.coverAt(x, z), heightAt: (x, z) => app.tiles.heightAt(x, z), road: worldRoads(world) });
    // (?wildlife: at every forest by the road, to try it out)
    if (new URLSearchParams(location.search).has('wildlife')) this.traffic.wild.chance = 1;
    app.scene.add(this.wildView.group);
    this.roadEvents.ready = (x, z, r) => !app.map.pieces || app.map.ready(x, z, r);
    this.roadEvents.collider = this.collider;
    this.traffic.roadEvents = this.roadEvents;
    this.lanes.wayCost = routeFor.wayCost = (w) => this.roadEvents.wayCost(w);
    app.map.listen(this.roadEvents.listener);
    // the kerb build-outs narrowing the roads: their beds and beacons are solid (src/sim/narrowings.ts)
    narrowCollide(this.collider, world.allEdges, true);
    app.map.listen({ added: (c) => narrowCollide(this.collider, c.edges, true), removed: (c) => narrowCollide(this.collider, c.edges, false) });
    this.roadEvents.setTracks(this.rail.net);
    this.levelCrossings = new LevelCrossings(world, this.traffic);
    this.levelCrossings.setRail(this.rail);
    this.traffic.levelCrossings = this.levelCrossings;
    this.signs.editPost = (p) => this.levelCrossings.editPost(p);
    this.crossingView = new LevelCrossingRenderer(this.audio);
    app.scene.add(this.crossingView.group);
    this.roadworks = new RoadworksRenderer(this.audio);
    app.scene.add(this.roadworks.group);
    if (app.map.pieces) {
      // … then the roads of the whole map (some megabytes: on a connection that asks to save data only
      // once they are needed) and the railway tracks are read while the menu is up
      const saving = (globalThis.navigator as unknown as { connection?: { saveData?: boolean } }).connection?.saveData === true;
      if (!saving || this.autoTour > 0 || this.autoDemo.length > 0 || this.autoMap) this.wantNet();
      void app.map.rails().then((rails) => {
        if (rails.length === 0) return;
        this.rail = new RailTraffic(rails);
        this.roadEvents.setTracks(this.rail.net);
        this.levelCrossings.setRail(this.rail);
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
        // … and their timetables (they refer to the lines by their place in that file)
        if (json) {
          void app.map.timetable().then((tj) => {
            if (!tj) return;
            try {
              this.timetable = parseTimetable(tj, json);
              this.lineStopsDirty = true;
              // (the departure displays at the stops of trams and buses show what leaves next by them)
              this.transit.setTimetable(this.timetable);
            } catch (e) {
              console.warn('the timetables could not be read', e);
            }
          });
        }
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
        this.traffic.crowd.stops = this.stops;
        // the lines of the city buses (they name the stops by their place in that file): the buses of the traffic run them
        const places = this.stops.places.length;
        void loadBusLines(app.map, places).then((lines) => this.traffic.setBusLines(lines));
        this.hud.setTramStops(this.stops.tramPlaces().map((p) => ({ name: p.name, town: p.town, x: p.x, z: p.z })));
        // with the stops, city buses come with the traffic: they call at the stops on their way
        this.laneStops.clear();
        this.traffic.busStops = (lane) => this.busStopsOn(lane);
      });
    }
    this.car.root.visible = false;
    clearInterval(creep);
    show(1);
    loading.remove();

    this.hud = new Hud(this.ui, this.settings, world);
    // the timers over the traffic lights: a tap puts the lights on to their next phase (not in lessons and tests)
    this.signalTimers = new SignalTimers(this.ui);
    this.signalTimers.onTap = (c) => {
      if (!this.lesson && this.signals.skip(c)) this.audio.click('tick');
    };
    this.input = new Input(app.canvas, this.settings);
    this.input.onAction((a) => this.onAction(a));
    this.hud.onStart = (req) => this.begin(req.mode, req.spawn, false, req.address, req.stop, req.runway);
    this.hud.onMenuPreview = (p) => this.setMenuPreview(p);
    // the departure boards: what the timetables say leaves next (by the clock of the day)
    this.transit.departuresFor = (name) => {
      const tt = this.timetable;
      if (!tt) return null;
      const list = departures(tt, name, serviceTime(gameNow()), 4);
      if (list.length === 0) return tt.calls.has(name) ? [] : null;
      return list.map((d) => ({ line: d.ref, destination: d.to, minutes: d.wait < 60 ? 'sofort' : Math.floor(d.wait / 60) }));
    };
    this.hud.onResume = () => this.resume();
    this.hud.onReality = () => this.openReality();
    // the arcade mode: the world at another moment, the time faster while the autopilot drives
    this.hud.arcade = {
      t: (key, vars) => tr(key, this.settings.lang, vars),
      locale: () => localeOf(this.settings.lang),
      clockMs: () => gameClock.ms(),
      real: () => gameClock.real,
      travelled: () => gameClock.travelled,
      rate: () => gameClock.rate,
      setTime: (ms) => {
        if (ms === null) gameClock.reset();
        else gameClock.set(ms);
        this.clockJumped();
      },
      setRate: (r) => {
        const was = gameClock.real;
        gameClock.setRate(r);
        // (back at the real speed after only that: the world is at the real time again – the timetables catch up)
        if (gameClock.real && !was) this.clockJumped();
      },
      autopilot: () => this.autopilotDriving(),
      seasons: () => SEASON_CHOICES.map((k) => [k, tr(SEASON_KEYS[k], this.settings.lang)] as const),
      season: () => this.settings.season,
      setSeason: (v) => {
        this.settings.season = v as Settings['season'];
        saveSettings(this.settings);
      },
      weathers: () => WEATHER_CHOICES.map((k) => [k, tr(WEATHER_KEYS[k], this.settings.lang)] as const),
      weather: () => this.settings.weather,
      setWeather: (v) => {
        this.settings.weather = v as Settings['weather'];
        saveSettings(this.settings);
      },
      arcadeDrive: () => this.settings.arcadeDrive,
      setArcadeDrive: (v) => {
        this.settings.arcadeDrive = v;
        saveSettings(this.settings);
      },
      evenRoads: () => this.settings.evenRoads,
      setEvenRoads: (v) => {
        this.settings.evenRoads = v;
        saveSettings(this.settings);
      },
      close: () => this.resume(),
    };
    this.hud.onChangeVehicle = (kind) => this.changeVehicle(kind);
    this.hud.onLiveLocation = () => {
      this.toggleLiveGeo();
      this.resume();
    };
    this.hud.onNewVehicle = () => {
      if (this.state === 'drive') this.newVehicle();
    };
    this.hud.onArcade = () => {
      this.pause();
      if (this.state === 'pause') this.hud.showArcade();
    };
    this.hud.onGetOut = () => {
      // (off the forklift, down from the tower crane: on foot beside it – game/forkliftplay.ts, craneplay.ts)
      if (!this.walker && (this.forklift || this.crane?.type === 'tower')) {
        this.resume();
        if (this.forklift) this.forkliftDoor();
        else this.towerDoor();
        return;
      }
      if (this.walker || this.demo?.active || this.task || this.crane || this.forklift) return;
      // (the tram: standing, not driving by itself – out of the cab and on foot beside it)
      if (this.tram ? this.tram.speed > 0.1 || this.tramAuto : Math.abs(this.vehicle.speed) > 0.3) return;
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
      extraImages: (lat, lon) => this.online?.realityImages(lat, lon) ?? Promise.resolve([]),
    });
    this.hud.onQuit = () => this.toMenu();
    this.makeOnline();
    this.hud.faultLog = this.faultLog;
    this.hud.onMap = () => this.openMap();
    this.hud.where = () => (this.vehicle ? { x: this.mpos[0], z: this.mpos[2] } : null);
    this.hud.onDemo = () => {
      // the aeroplane: its autopilot on (a demonstration flight from the runway, else holding height and heading) or off
      if (this.aircraft) {
        this.toggleFlightAuto();
        if (this.state === 'pause') this.resume();
        return;
      }
      this.openMap();
      this.bigMap.plan();
    };
    this.hud.onFinish = () => {
      if (this.state === 'pause' && !this.lesson) this.finish();
    };
    this.bigMap = new BigMap({
      world,
      lang: () => this.settings.lang,
      car: () => ({ x: this.mpos[0], z: this.mpos[2], yaw: this.mapFrom === 'menu' ? (this.menuPreview?.yaw ?? 0) : this.vehicle.yaw }),
      path: this.path,
      net: () => this.netIndex,
      spotAt: (x, z) => (this.settings.placeExact ? this.exactSpot(tr('mapPlace', this.settings.lang), x, z) : this.roadSpot(x, z, '', 160)),
      loadedArea: () => (this.mapFrom === 'menu' ? null : this.spawnCars.area.outline()),
      canSpawnCar: (x, z) => (!this.canSpawnCar(true) ? 'no' : this.spawnCars.canPlaceAt(x, z) ? 'ok' : 'outside'),
      spawnCar: (x, z) => {
        this.closeMap();
        this.spawnCars.spawnAt(x, z);
      },
      canTeleport: () => this.mapFrom !== 'menu' && !this.lesson && !this.crane && !this.forklift,
      teleport: (spot) => {
        if (this.mapFrom !== 'menu') return this.teleportSpot(spot);
        this.hud.menuStartAt(spot);
        this.closeMap();
      },
      menu: () => this.mapFrom === 'menu',
      events: () => this.roadEvents?.list() ?? [],
      stops: () => this.stops?.places ?? [],
      services: () => this.services.sites(),
      emergencies: () => this.traffic.cars.filter((c) => c.em).map((c) => ({ id: c.id, kind: c.em!.kind, call: c.em!.call, x: c.x, z: c.z })),
      fuelPrice: (sv, fuel) => {
        const live = fuelPrices.priceAt(sv.x, sv.z, fuel);
        return live !== null ? { price: live, live: true } : { price: priceAt(sv, fuel), live: false };
      },
      priceSource: () => `${FUEL_PRICE_SOURCE.name}, ${FUEL_PRICE_SOURCE.licence}`,
      watchPoint: (what) => this.startPointWatch(what),
      loadAddresses: () => this.loadAddresses(),
      spotOf: (hit) => this.spawnAt(hit),
      startTrip: (stops, self, tour) => this.startTrip(stops, self, tour),
      startPreset: (id) => this.startPreset(id),
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
      transit: () => this.transitData(),
      watch: (v) => this.startWatch(v),
      roads: () => {
        const g = this.routeGraphNow();
        return g ? roadSource(g, this.netIndex, world) : null;
      },
      flying: () => this.aircraft !== null,
      teleportAir: (spot, height) => this.flyFrom(spot, height),
      close: () => this.closeMap(),
    });
    // the driven path is written down now and then; make sure the last stretch is, too
    window.addEventListener('pagehide', () => this.path.save());
    this.hud.onSettingsChanged = () => this.applySettings();
    this.hud.onTileVersion = (tile, part, when) => this.onTileVersion(tile, part, when);
    this.rules.onViolation = (v) => {
      this.hud.toast(v);
      this.faultLog.add({ t: Date.now(), id: v.id, severity: v.severity, data: v.data, street: this.rules.context.roadName, mode: this.lesson?.id ?? 'free', x: Math.round(v.x), z: Math.round(v.z) });
      // (on the timeline of the replay too)
      this.recorder.note({ t: this.time, id: v.id, severity: v.severity, data: v.data });
      this.audio.click('chime');
      if (v.severity === 'fail' && this.lesson?.kind === 'exam' && this.failT < 0) this.failT = this.time + 2.5;
    };
    this.hud.attachInput(this.input);
    // test overrides (not saved): ?quality=low|medium|high&mirrors=off|alternate|full&traffic=0..1
    const qq = q.get('quality');
    if (qq === 'low' || qq === 'medium' || qq === 'high' || qq === 'ultra' || qq === 'nomercy') {
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
    else {
      this.toMenu();
      this.startWhereIAm();
    }
  }

  private debugLook: [number, number] | null = null;
  /** the developer's view's field of view (degrees, vertical) */
  private devFov = 60;

  /**
   * Developer: look from (x, height above the ground, z) towards the compass heading (degrees, 0 north, clockwise
   * as photos are) and pitch (degrees, up positive) with a vertical field of view – the world loads round it.
   */
  devView(x: number, h: number, z: number, heading: number, pitch = 0, fov = 60, absolute = false): number {
    this.cameraMode = 'dev';
    // (the player's vehicle out of the picture – its parts, not its root: the loop draws while the root is shown)
    for (const c of this.model.root.children) c.visible = false;
    const g = this.app.tiles.heightAt(x, z);
    this.free.pos.set(x, absolute ? h : (Number.isNaN(g) ? 200 : g) + h, z);
    this.free.yaw = (-heading * Math.PI) / 180;
    this.free.pitch = (pitch * Math.PI) / 180;
    this.devFov = fov;
    return Number.isNaN(g) ? NaN : g;
  }
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
    this.services.tile(tile, loaded);
    // (where a car may be put down: the loaded area, the footprints of its buildings – game/spawncar.ts)
    this.spawnCars.tile(tile.key, tile.header, tile.data.get('collPts') as Float32Array | null, tile.data.get('collCnt') as Uint16Array | null, loaded);
    if (loaded) {
      // What stands in a lane (a fault of the map) is taken out of the way: sign posts are moved
      // beside the lane, lamps dropped, walls lose the pieces that reach in.  Maps built since do
      // this themselves and mark their tiles.
      // the signs the map was built without (signs.json.gz), on the ground where they stand
      this.extraSigns?.mergeInto(tile.key, tile.header.signs, (x, z, y) => this.footGround(x, z, y));
      const clear = !tile.header.clr;
      if (clear) {
        clearSigns(this.lanes, tile.header.signs);
        clearObjects(this.lanes, tile.header.objects);
      }
      this.signsBesideRoad(tile.header.signs);
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
    // as many raindrops and snowflakes as the graphics allow
    if (this.outdoors) this.outdoors.view.quality = WEATHER_PARTICLES[s.quality === 'custom' ? 'medium' : s.quality];
    if (this.outdoors) this.outdoors.water.enabled = gx.water;
    // the weather on the vehicle and the roads ("No mercy"): water on the roads, mud on the body (the windscreen: below)
    if (this.outdoors) this.outdoors.view.roadWater = gx.weatherFx;
    if (this.services) this.services.dirtShown = gx.weatherFx;
    // the trams' doors: drawn, opening and closing, from the medium graphics on (on the low preset the plain bodies of before)
    this.railActors.detail = this.showRail.detail = s.quality !== 'low';
    this.ui.style.setProperty('zoom', String(s.uiScale));
    app.resize();
    for (const m of this.car.mirrors) m.setEnabled(s.mirrors !== 'off');
    // the player's vehicles in finer detail ("very high": render/cardetail.ts, render/fleetdetail.ts)
    this.car.setDetail(gx.vehicleDetail);
    this.car.setCabinOpacity(s.cabinOpacity);
    for (const model of this.models.values()) {
      if (model === this.car) continue;
      for (const m of model.mirrors) m.setEnabled(s.mirrors !== 'off');
      model.setCabinOpacity(s.cabinOpacity);
      model.setDetail?.(gx.vehicleDetail);
    }
    this.audio.setVolume(s.volume);
    // the music: off, now and then, or more often (made as it plays: audio/music.ts)
    this.audio.setMusic(s.music, s.musicVolume);
    if (this.traffic) this.traffic.targetCount = Math.round(s.traffic * 34);
    // the people on foot: with the traffic, as many as the graphics allow
    if (this.traffic) this.traffic.crowd.target = crowdTarget(s.traffic, s.quality);
    // trams and trains come with the traffic: none when it is switched off
    if (this.rail) {
      this.rail.target = s.traffic > 0.02 ? 4 : 0;
      this.rail.ringMax = Math.min(620, app.tiles.viewRadius * 0.8);
      this.rail.far = Math.min(900, app.tiles.viewRadius * 1.1);
    }
    this.applyDevMap();
  }

  /**
   * The developer mode's parts (settings: devMap): the cache of map-assets,
   * built from the settings, and the index that says which tiles ever had a
   * version – read once, so the corner label knows where it may show.
   */
  private applyDevMap(): void {
    const s = this.settings;
    if (!s.devMap) {
      this.parts = null;
      this.partIndex = null;
      this.versioned = new Set();
      this.labelTile = '';
      this.pendingParts.clear();
      useTileSource(null); // (the tiles come from the site again, as always)
      this.hud.setTileVersions('', []);
      return;
    }
    const opts = { fetch: s.devMapFetch, repo: s.devMapRepo, budgetMb: s.devMapRam, onProgress: (share: number) => this.hud.setAssetProgress(share) };
    const cache = new PartCache(opts, sourceFor(s.devMapFetch, opts, this.app.baseUrl));
    this.parts = cache;
    // (a file of the map a part holds comes from it – a tile, the net, a network chunk –
    // the site's file is the fallback; the path is the one in the map, the tile key for a tile)
    useTileSource(async (path) => {
      const prefer = this.pendingParts.get(path);
      if (path.endsWith('.fsb') || /^\d+_\d+$/.test(path)) {
        const got = await cache.tile(path.replace(/\.fsb$/, ''), prefer);
        return got ? got.bytes : null;
      }
      const got = await cache.mapFile(path, prefer);
      return got ? got.bytes : null;
    }, this.app.baseUrl);
    // the index says what exists: which tiles ever had a version, and the update check reads it too
    void this.parts.getIndex(0).then((idx) => {
      if (!idx || this.parts === null) return;
      this.partIndex = idx;
      this.versioned = versionedTiles(idx);
      this.checkForNewerParts(idx);
    });
  }

  /**
   * The load-time check (first load, page reload): is there a newer part than
   * the one the site ships?  The index's `latest` says so; a newer one means
   * the developer has something to look at (the corner label, and the notice).
   */
  private async checkForNewerParts(idx: PartIndex): Promise<void> {
    const newest = idx.latest;
    const here = idx.files.find((f) => f.n === newest);
    if (!here) return;
    // (the site's own tiles are the "base"; a part newer than that is news)
    if (here.type === 'base') return;
    this.hud.message(tr('devMap.newer', this.settings.lang, { n: newest, type: here.type }));
  }

  /**
   * A version of a tile chosen from the corner label (ui/hud.ts): `part` is a
   * part number to load now, or 'next' to load it the next time the player
   * drives into that region.
   */
  private onTileVersion(tile: string, part: number, when: 'now' | 'next'): void {
    if (!this.parts) return;
    if (when === 'next') {
      // remembered: the next time the player drives into this tile's region,
      // that part is preferred over the newest (the choice is one per tile)
      this.pendingParts.set(tile, part);
      this.hud.message(tr('devMap.next', this.settings.lang));
      return;
    }
    void this.parts.tile(tile, part).then((got) => {
      if (got) this.hud.message(tr('devMap.loadedNow', this.settings.lang, { n: got.part }));
      else this.hud.message(tr('devMap.couldNot', this.settings.lang));
    });
  }

  // ------------------------------------------------------------------- flow
  private toMenu(): void {
    this.theory?.close();
    this.endWatch(false);
    this.afterPlace = null;
    // (a tour that is left for the menu is kept as far as it was driven)
    if (this.demo?.tour) this.endDemo('ended');
    this.state = 'menu';
    this.demo = null;
    this.endTasks();
    this.services.end();
    this.crane?.dispose();
    this.crane = null;
    this.endForklift();
    this.figure.hide();
    this.spawnCars?.clear();
    this.intoParked = false;
    // (the menu of rows places the vehicle chosen anew; the test place is left)
    this.previewKey = '';
    this.showOn = false;
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

  // ------------------------------------------------------------- timetables
  /** the timetables of the trams and buses (null: none for this map) – the trams and buses of the traffic keep to them (src/game/timedtransit.ts) */
  private timetable: Timetable | null = null;

  /** The model of a vehicle, made the first time it is needed (and the box trailer behind a car, a 7.5-tonner or a bus). */
  private ensureModel(def: VehicleDef): VehicleModel {
    let m = this.models.get(modelKey(def));
    if (!m) {
      m = this.makeModel(def);
      this.models.set(modelKey(def), m);
      this.app.scene.add(m.root);
      if (this.truck && m === this.truck) this.app.scene.add(this.truck.trailer);
      for (const mirror of m.mirrors) mirror.setEnabled(this.settings.mirrors !== 'off');
      m.setCabinOpacity(this.settings.cabinOpacity);
      m.setDetail?.(this.settings.graphics.vehicleDetail);
    }
    // (the truck of class CE has its own trailer)
    // (and the semi-trailer of the articulated lorry its own: render/semitruck.ts)
    const towed = def.trailer && def.model !== 'truck' ? towedModel(def.trailer, this.carTrailer) : this.carTrailer;
    if (towed !== this.carTrailer) {
      if (this.carTrailer) this.app.scene.remove(this.carTrailer.group);
      this.carTrailer = towed;
      if (towed) this.app.scene.add(towed.group);
    }
    return m;
  }

  // ------------------------------------------------- the vehicle behind the menu
  /** what the menu of rows has chosen (the vehicle and where it would start), what is placed of it, and the camera's circle round it */
  private menuPreview: MenuPreview | null = null;
  private previewKey = '';
  private previewTram: RailVehicle | null = null;
  private previewCentre: THREE.Vector3 | null = null;
  private previewRadius = 9;
  private readonly previewPos = [0, 0, 0];

  private setMenuPreview(p: MenuPreview | null): void {
    // (a crane is shown where its work begins: on the construction site)
    const crane = p ? VEHICLES[p.kind]?.crane : undefined;
    const at = crane ? craneStart(crane, this.yardFrame) : null;
    this.menuPreview = p && at ? { ...p, x: at.x, z: at.z, yaw: at.yaw } : p;
    if (!p) this.clearPreview();
  }

  /** What makes the vehicle behind the menu different from the one placed: the vehicle, the place, its make-up. */
  private menuPreviewKey(p: MenuPreview): string {
    return `${p.kind}|${p.x.toFixed(1)}|${p.z.toFixed(1)}|${p.yaw.toFixed(2)}|${p.stop?.name ?? ''}|${this.settings.tramSet}`;
  }

  /** Nothing placed behind the menu any more. */
  private clearPreview(): void {
    if (this.previewTram) {
      const i = this.rail.vehicles.indexOf(this.previewTram);
      if (i >= 0) this.rail.vehicles.splice(i, 1);
      this.previewTram = null;
    }
    this.figure.hide();
    this.car.root.visible = false;
    for (const model of this.models.values()) model.root.visible = false;
    if (this.carTrailer) this.carTrailer.group.visible = false;
    if (this.truck) this.truck.trailer.visible = false;
    craneMenuSite({ scene: this.app.scene, yard: this.yardFrame, settings: this.settings }, null, () => 0);
    forkliftMenuSite({ scene: this.app.scene, yard: this.yardFrame, settings: this.settings }, false, () => 0);
    this.previewCentre = null;
    this.previewKey = '';
  }

  /** The vehicle chosen in the menu, standing where the drive would begin: on the road, on the track at the stop, at the end of the runway. */
  private placePreview(p: MenuPreview): void {
    this.clearPreview();
    this.previewKey = this.menuPreviewKey(p);
    // (where it sensibly stands: on the road in front of the place chosen, facing along it, outside the buildings)
    const fit = this.menuSpot(p);
    p = { ...p, x: fit.x, z: fit.z, yaw: fit.yaw };
    const def = VEHICLES[p.kind] ?? VEHICLES.car;
    this.def = def;
    const tiles = this.app.tiles;
    const ty = tiles.heightAt(p.x, p.z);
    const y = this.app.world.surfaceAt(p.x, p.z, ty + 3, this.hit) ? this.hit.y : ty;
    if (def.kind === 'tram') {
      const at = tramStart(this.rail, p.x, p.z, [RAIL.TRAM, RAIL.LIGHT], p.stop?.name ?? '');
      const set = this.settings.tramSet;
      const v = at ? (this.rail.spawnAt(at.path, at.s, at.dir, 0, set) ?? this.rail.spawnAt(at.path, at.s, at.dir > 0 ? -1 : 1, 0, set)) : null;
      if (!v) return;
      // (it stays where it is: the traffic of the trams leaves it alone)
      v.player = true;
      this.rail.assignLine(v);
      this.previewTram = v;
      const mid = v.cars[Math.floor(v.cars.length / 2)];
      this.previewCentre = new THREE.Vector3(mid.x, mid.y + 1.8, mid.z);
      this.previewRadius = consistLength(v.consist) * 0.55 + 7;
      return;
    }
    if (def.kind === 'pedestrian') {
      this.figure.show(p.x, y, p.z, p.yaw, 0, false, this.time);
      this.previewCentre = new THREE.Vector3(p.x, y + 1, p.z);
      this.previewRadius = 4.2;
      return;
    }
    const model = this.ensureModel(def);
    if (def.kind === 'plane') {
      const a = new Aircraft(TRAINER, powerOf(def, this.settings.powers));
      a.placeOnGround(p.x, p.z, p.yaw, this.airGround ?? this.ground, false);
      model.root.position.set(a.pos.x, a.pos.y, a.pos.z);
      model.root.quaternion.set(a.q[0], a.q[1], a.q[2], a.q[3]);
      model.root.updateMatrixWorld(true);
      this.planeModel?.update(this.planeVisual(a), 0, this.time);
      this.previewRadius = 15;
    } else {
      const v = new Vehicle(def.spec(arcadeTransmission(this.settings.arcadeDrive, this.settings.transmission), powerOf(def, this.settings.powers)), this.ground);
      v.teleport(p.x, y + 0.02, p.z, p.yaw);
      v.getModelPosition(this.previewPos);
      model.root.position.set(this.previewPos[0], this.previewPos[1], this.previewPos[2]);
      model.root.quaternion.set(v.quat[0], v.quat[1], v.quat[2], v.quat[3]);
      model.root.updateMatrixWorld(true);
      this.parkedVisual(v);
      model.update(this.visual, 0, this.time);
      if (model instanceof PlayerBike) model.setRider(true);
      if (def.trailer) {
        const t = new Trailer(def.trailer, this.ground);
        t.coupleBehind(v);
        // (where the ground under its wheels is not loaded yet the trailer would tip: level, then, at the vehicle's height)
        const [ty0, tp] = this.levelTrailer(t, y);
        if (this.truck && def.kind === 'truck') this.truck.setTrailer(t.x, ty0, t.z, t.yaw, tp, 0, true);
        else if (this.carTrailer) this.carTrailer.place(t.x, ty0, t.z, t.yaw, tp, 0, this.visual);
      }
      this.previewRadius = def.long ? 25 : def.model === 'motorcycle' ? 5.5 : def.model === 'car' ? (def.trailer ? 12 : 8) : 15;
      if (def.crane && isCraneModel(model)) {
        // a crane: on its construction site, folded as it travels (the tower crane standing high over it)
        craneMenuSite({ scene: this.app.scene, yard: this.yardFrame, settings: this.settings }, def.crane, (x, z) => this.app.tiles.heightAt(x, z));
        craneMenuPose(model, def.crane);
        this.previewRadius = def.crane === 'tower' ? 55 : 18;
      }
      if (def.kind === 'forklift') {
        forkliftMenuSite({ scene: this.app.scene, yard: this.yardFrame, settings: this.settings }, true, (x, z) => this.app.tiles.heightAt(x, z));
        this.previewRadius = 6;
      }
    }
    this.showModel(true);
    const r = model.root.position;
    this.previewCentre = new THREE.Vector3(r.x, r.y + (def.model === 'car' || def.model === 'motorcycle' ? 0.9 : def.crane === 'tower' ? 22 : 1.8), r.z);
  }

  // ------------------------------------------------- the test place: every model
  /** every model of the game, parked on the practice yard (made the first time it is visited) */
  private readonly showGroup = new THREE.Group();
  private readonly showRail = new RailActors();
  private readonly showPeople = new PeopleRenderer(12);
  private showBuilt = false;
  /** the drive "every model": on the yard among them */
  private showOn = false;
  /** where each model stands there, which one is being driven (game/showdrive.ts) */
  private readonly showSpots = new ShowSpots();

  /** A sign with a name, standing over a model (a sprite: it faces whoever looks). */
  private nameSign(text: string, x: number, y: number, z: number): void {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 96;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.fillStyle = 'rgba(16, 24, 34, 0.86)';
    g.beginPath();
    g.roundRect(4, 4, 504, 88, 20);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = 'bold 40px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 256, 50, 480);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
    sprite.scale.set(4.2, 0.79, 1);
    sprite.position.set(x, y, z);
    this.showGroup.add(sprite);
  }

  /** A vehicle of the game standing (engine off) at (x, z) on the ground, facing yaw – and the trailer it pulls. */
  /**
   * A trailer just coupled behind a vehicle that stands (the menu, the test
   * place): its height and pitch – level at the vehicle's ground `y` where
   * the ground under its wheels gave an implausible slope (not loaded yet).
   */
  private levelTrailer(t: Trailer, y: number): [number, number] {
    const ground = this.app.tiles.heightAt(t.x, t.z);
    if (Math.abs(t.pitch) > 0.12 || Number.isNaN(ground)) return [y, 0];
    return [t.y, t.pitch];
  }

  private standModel(def: VehicleDef, model: VehicleModel, x: number, z: number, yaw: number, ground: (x: number, z: number) => number, trailer: TowedModel | null, truck: PlayerTruck | null): void {
    const v = new Vehicle(def.spec('automatic', powerOf(def, this.settings.powers)), this.ground);
    v.teleport(x, ground(x, z) + 0.02, z, yaw);
    v.getModelPosition(this.previewPos);
    model.root.position.set(this.previewPos[0], this.previewPos[1], this.previewPos[2]);
    model.root.quaternion.set(v.quat[0], v.quat[1], v.quat[2], v.quat[3]);
    this.parkedVisual(v);
    model.update(this.visual, 0, this.time);
    if (model instanceof PlayerBike) model.setRider(false);
    if (def.trailer) {
      const t = new Trailer(def.trailer, this.ground);
      t.coupleBehind(v);
      const [ty0, tp] = this.levelTrailer(t, ground(x, z));
      if (truck) truck.setTrailer(t.x, ty0, t.z, t.yaw, tp, 0, true);
      else trailer?.place(t.x, ty0, t.z, t.yaw, tp, 0, this.visual);
    }
  }

  /**
   * The test place: on the practice yard every model of the game – the
   * vehicles of every licence class side by side, the cars, cyclists and
   * people of the traffic, the trams (two coupled, one with a trailer car)
   * and the aeroplane – each with its name.  Made once, the first time.
   */
  private buildShowroom(): void {
    const frame = this.yardFrame;
    if (!frame || this.showBuilt) return;
    this.showBuilt = true;
    const tiles = this.app.tiles;
    const ground = (x: number, z: number): number => {
      const y = tiles.heightAt(x, z);
      return Number.isNaN(y) ? 0 : y;
    };
    const { len, wid } = frame.yard;
    const lang = this.settings.lang;
    // the small ones on the north side, noses to the aisle in the middle; the big ones on the south side
    const north = frame.yawToWorld(Math.PI);
    const south = frame.yawToWorld(0);
    let u = -len / 2 + 8;
    const smallRow = -wid / 2 + 13;
    const bigRow = wid / 2 - 12;
    const place = (kind: VehicleKind, row: number, facing: number, gap: number): void => {
      const def = VEHICLES[kind];
      const m: VehicleModel =
        def.model === 'car' ? new PlayerCar() : def.model === 'motorcycle' ? new PlayerBike(bikeVariant(kind)) : def.model === 'truckLight' ? new PlayerTruck(LIGHT_TRUCK) : def.model === 'truck' ? new PlayerTruck() : def.model === 'semi' ? new PlayerSemi() : def.model === 'truckHeavy' ? new PlayerRigid() : def.model === 'bus' ? new PlayerBus() : def.model === 'minibus' ? new PlayerBus(MINIBUS) : new PlayerTractor();
      const truck = m instanceof PlayerTruck && def.model === 'truck' ? m : null;
      if (truck) {
        this.showGroup.add(truck.trailer);
        truck.trailer.visible = kind === 'truck';
      }
      const trailer = def.trailer && !truck ? towedModel(def.trailer, null) : null;
      if (trailer) this.showGroup.add(trailer.group);
      this.showGroup.add(m.root);
      const [x, z] = frame.toWorld(u, row);
      this.standModel(def, m, x, z, facing, ground, trailer, truck);
      // (it can be got into: game/showdrive.ts)
      const small = def.model === 'car' || def.model === 'motorcycle';
      this.showSpots.add({ kind, x, y: ground(x, z), z, yaw: facing, outline: def.outline, height: small ? 1.6 : 3.4, roots: [m.root, ...(trailer ? [trailer.group] : []), ...(truck && kind === 'truck' ? [truck.trailer] : [])] });
      this.nameSign(tr(def.name, lang), x, ground(x, z) + (def.model === 'car' || def.model === 'motorcycle' ? 2.6 : 4.4), z);
      u += gap;
    };
    for (const kind of ['car', 'moped', 'motorcycle125', 'motorcycle35', 'motorcycle', 'tractorSlow', 'tractor'] as const) place(kind, smallRow, south, kind.startsWith('moto') || kind === 'moped' ? 3.6 : 5.2);
    // the cars of the traffic (three bodies), a cyclist and people
    const bodies = [COMPACT_DIMS, { ...COMPACT_DIMS, length: 4.6, height: 1.5, wheelbase: 2.7, tail: 1 }, { ...COMPACT_DIMS, length: 4.45, height: 1.42, wheelbase: 2.68, tail: 2 }];
    const paints = [0x8a1c1c, 0x2f5f8a, 0xd8d8d0];
    bodies.forEach((dims, i) => {
      const e = new CarExterior(paints[i], { dims });
      const [x, z] = frame.toWorld(u, smallRow);
      e.group.position.set(x, ground(x, z), z);
      e.group.rotation.y = south;
      const r = e.dims.wheelRadius;
      e.setWheels([0, 0, 0, 0], [0, 0, 0, 0], [r, r, r, r]);
      e.setLamps({ low: false, high: false, brake: false, reverse: false, left: false, right: false });
      this.showGroup.add(e.group);
      // (each driven as the car)
      this.showSpots.add({ kind: 'car', x, y: ground(x, z), z, yaw: south, outline: { front: e.dims.length / 2, rear: e.dims.length / 2, hw: e.dims.width / 2 }, height: 1.5, roots: [e.group] });
      if (i === 1) this.nameSign(tr('showTraffic', lang), x, ground(x, z) + 2.4, z);
      u += 4.6;
    });
    const bike = new CyclistModel(0x2f8a4a);
    const [bx, bz] = frame.toWorld(u, smallRow);
    bike.group.position.set(bx, ground(bx, bz), bz);
    bike.group.rotation.y = south;
    bike.pose(0, 0, false);
    this.showGroup.add(bike.group);
    this.nameSign(tr('showCyclist', lang), bx, ground(bx, bz) + 2.4, bz);
    u += 4;
    const poses: Array<{ x: number; y: number; z: number; yaw: number; walk: number; look: number }> = [];
    for (let i = 0; i < 8; i++) {
      const [x, z] = frame.toWorld(u + (i % 4) * 1.1, smallRow + Math.floor(i / 4) * 1.3);
      poses.push({ x, y: ground(x, z), z, yaw: south, walk: -1, look: 101 + i * 37 });
    }
    this.showPeople.update(poses, this.time);
    const [px, pz] = frame.toWorld(u + 1.6, smallRow);
    this.nameSign(tr('showPeople', lang), px, ground(px, pz) + 2.6, pz);
    // the big ones
    u = -len / 2 + 8;
    for (const kind of ['carTrailer', 'lightTruck', 'lightTruckTrailer', 'truckSolo', 'truck', 'semi', 'minibus', 'minibusTrailer', 'bus', 'busTrailer'] as const) place(kind, bigRow, north, 6.5);
    // the trams, lengthwise along the north edge: two coupled, and one with a trailer car
    const east = frame.yawToWorld(-Math.PI / 2);
    const trams: RailVehicle[] = [];
    let front = len / 2 - 50;
    for (const set of ['double', 'trailer'] as const) {
      const consist = consistOf(RAIL.TRAM, set);
      const roles = carLayout(consist);
      const cars = roles.map((r) => {
        const [x, z] = frame.toWorld(front - r.start - r.len / 2, -wid / 2 + 3);
        return { x, y: ground(x, z), z, yaw: east, pitch: 0 };
      });
      trams.push({ id: -1 - trams.length, kind: RAIL.TRAM, consist, path: 0, s: 0, dir: 1, speed: 0, dwell: 0, noStop: 0, plan: [], cars, trail: null as unknown as RailVehicle['trail'], blocked: false, panto: 1 });
      this.nameSign(tr(set === 'double' ? 'tramSetDouble' : 'tramSetTrailer', lang), cars[0].x, cars[0].y + 5.4, cars[0].z);
      front -= consistLength(consist) + 8;
    }
    this.showRail.update(trams);
    // the aeroplane at the east end of the aisle
    const plane = new PlaneModel();
    const a = new Aircraft(TRAINER, 160);
    const [ax, az] = frame.toWorld(len / 2 - 12, 0);
    a.placeOnGround(ax, az, frame.yawToWorld(Math.PI / 2), this.ground, false);
    plane.root.position.set(a.pos.x, a.pos.y, a.pos.z);
    plane.root.quaternion.set(a.q[0], a.q[1], a.q[2], a.q[3]);
    plane.update(this.planeVisual(a), 0, this.time);
    this.showGroup.add(plane.root);
    this.showSpots.add({ kind: 'plane', x: ax, y: ground(ax, az), z: az, yaw: frame.yawToWorld(Math.PI / 2), outline: VEHICLES.plane.outline, height: 3, roots: [plane.root] });
    this.nameSign(tr('vehPlane', lang), ax, ground(ax, az) + 4.2, az);
    this.showGroup.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
  }

  /** A vehicle standing with its engine off: wheels at rest, lamps dark, the handbrake on. */
  private parkedVisual(v: Vehicle): void {
    const s = this.visual;
    s.speedKmh = 0;
    s.rpm = 0;
    s.indicator = 0;
    s.hazard = false;
    s.blinkOn = false;
    s.lowBeam = false;
    s.highBeam = false;
    s.handbrake = true;
    s.ignition = false;
    s.engineRunning = false;
    s.abs = false;
    s.steerWheel = 0;
    v.getWheelHeights(this.wheelY);
    for (let i = 0; i < 4; i++) {
      s.wheelSteer[i] = 0;
      s.wheelSpin[i] = 0;
      s.wheelY[i] = this.wheelY[i];
    }
    s.clutch = 0;
    s.brake = 0;
    s.throttle = 0;
    s.handbrakeLever = 1;
    s.braking = false;
    s.reversing = false;
  }

  /**
   * The scene behind the menu of rows: the vehicle chosen where it would
   * start, the camera circling it slowly.  False while there is nothing to
   * show yet (the ground there is still loading): then the view from above.
   */
  private menuShow(): boolean {
    const p = this.menuPreview;
    if (!p) return false;
    const app = this.app;
    const tiles = app.tiles;
    // (the ground and the roads where it stands: they come in pieces)
    tiles.update(p.x, p.z);
    app.map.update(p.x, p.z, 25);
    this.props.update(p.x, p.z);
    if (this.previewKey !== this.menuPreviewKey(p)) {
      if (Number.isNaN(tiles.heightAt(p.x, p.z)) || (app.map.pieces && !app.map.ready(p.x, p.z, 150)) || (p.kind === 'tram' && this.rail.net.paths.length === 0)) {
        this.hud.setMenuLoading(app.map.pieces ? 0.35 * app.map.progress(p.x, p.z, 150) + 0.65 * tiles.progress : tiles.progress);
        return false;
      }
      this.placePreview(p);
      this.hud.setMenuLoading(null);
    }
    const c = this.previewCentre;
    if (!c) return false;
    const r = this.previewRadius;
    const cam = app.camera;
    // (the menu of rows aims below the vehicle: it stands in the upper part of the picture, above the rows;
    // the stage – ui/stage.ts – has it large in the middle)
    const f = this.settings.menuStyle === 'stage' ? stageFrame(this.time, p.kind, r, cam.aspect) : { angle: this.time * 0.1, dist: r, rise: r * 0.3 + 0.6, aim: -r * 0.36, fov: 50 };
    cam.position.set(c.x + Math.cos(f.angle) * f.dist, c.y + f.rise, c.z + Math.sin(f.angle) * f.dist);
    const gy = tiles.heightAt(cam.position.x, cam.position.z);
    if (!Number.isNaN(gy)) cam.position.y = Math.max(cam.position.y, gy + 1.2);
    cam.lookAt(c.x, c.y + f.aim, c.z);
    cam.fov = f.fov;
    cam.near = 0.3;
    cam.updateProjectionMatrix();
    this.menuFocus.set(c.x, c.y, c.z);
    return true;
  }

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
      case 'truckHeavy':
        return new PlayerRigid();
      case 'semi':
        return new PlayerSemi();
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
      case 'towerCrane':
      case 'mobileCrane':
      case 'loaderCrane':
        return makeCraneModel(def.crane ?? 'tower', this.settings.quality === 'low' ? 'low' : 'full');
      case 'forklift':
        return new ForkliftModel(this.settings.quality === 'low' ? 'low' : 'full');
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
    // (the vehicle left standing when the player got into another stays drawn – game/spawncar.ts)
    for (const [k, model] of this.models) if (model !== this.car) model.root.visible = (on && k === key) || !!this.spawnCars?.keeps(model.root);
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
    const run = new YardTask(id, this.def.kind === 'semi');
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
    this.drillScene.hide();
    this.ground.paved = null;
    this.ground.raise = null;
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
      this.lessonLine = tr(taskTextKey(run.semi, 'do', run.id), lang);
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
      choices.map((id) => ({ id, label: tr(taskTextKey(run.semi, 'step', id), lang) })),
      (id: string) => {
        const fault = proc.act(id as CouplingStepId, run.state);
        if (fault) this.rules.note(fault, 'major', {}, 0.5);
        else this.audio.click('chime');
      },
      // (nothing to do with the truck just now: it is the driver's turn on foot)
      !st.todo,
    );
    this.lessonLine = st.todo ? tr(taskTextKey(run.semi, 'do', st.todo), lang) : choices.length ? tr('ce.onFoot', lang) : tr('ce.do.uPark', lang);
    this.taskSub = `${proc.done.size} / ${COUPLING_STEPS.length}`;
    if (st.state === 'done') this.taskDone(true);
  }

  // ------------------------------------------------- class B: the basic tasks on the practice yard
  /** Lay out the first task, stand the car at its start (`ids`: 'exam' – three tasks as in the test: one of group a, two of group b, Anlage 7 FeV Nr. 2.1.4.2). */
  private drillBegin(ids: Array<DrillId | 'exam'>): void {
    const o = this.def.outline;
    const list = ids.flatMap((id) => (id === 'exam' ? examDrills() : [id]));
    this.drill = new DrillRun(list, this.yardFrame!, { front: o.front, rear: o.rear, hw: o.hw, axles: this.def.axles, track: this.def.track }, this.yardScene, this.drillScene, () => this.settings.lang);
    this.drillPlace();
    this.rules.yard = true;
    // the yard is asphalt while the lesson runs, the ramp of the hill start raises the ground
    this.ground.paved = this.drill.paved;
    this.ground.raise = this.drill.raise;
    this.lessonLine = this.drill.line();
    this.taskSub = this.drill.sub();
  }

  /** The car to the start of the task now (placed there by placeAgain or at the start of the drive). */
  private drillPlace(): void {
    const d = this.drill!;
    const at = d.start();
    this.spawn = { name: '', x: at.x, z: at.z, yaw: at.yaw, kind: 'street' };
    this.input.c.lookZoom = d.layout.zoom > 0 ? d.layout.zoom : this.def.zoom;
  }

  /** Judge the task on the yard; what to do in the street-name block, the instructor's remarks in the tip line. */
  private updateDrill(dt: number): void {
    const d = this.drill!;
    const v = this.vehicle;
    const c = this.input.c;
    const lang = this.settings.lang;
    v.getModelPosition(this.drillPos);
    const ev = d.update(dt, { x: this.drillPos[0], z: this.drillPos[2], yaw: v.yaw, speed: v.speed, handbrake: c.handbrake > 0.5, brake: c.brake, engine: v.engineRunning }, (x, z) => this.app.tiles.heightAt(x, z));
    for (const f of ev.faults) this.rules.note(f.id, f.severity, f.data, 0.5);
    if (ev.stop) {
      // (into a parked car: it stops there)
      v.vel.fill(0);
      v.angVel.fill(0);
      this.audio.click('bump');
    }
    if (ev.signal) {
      // the instructor's signal for the emergency stop
      this.audio.click('beep');
      this.hud.message(tr('drill.signal', lang), tr('drill.signalSub', lang));
    }
    if (ev.remark) {
      this.tipText = ev.remark;
      this.tipUntil = this.time + 6;
    }
    this.lessonLine = d.line();
    this.taskSub = d.sub();
    if (ev.next === 'again' || ev.next === 'next') {
      this.audio.click('chime');
      this.drillPlace();
      this.placeAgain();
    } else if (ev.next === 'over') this.finish();
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
    const spot = this.startSpot(hit);
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
    // (not from a lesson, nor from the crane's construction site)
    if (this.lesson || this.crane || this.forklift || (this.state !== 'pause' && this.state !== 'map')) return;
    this.bigMap.close();
    this.endWatch(false);
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
    if (this.state !== 'drive' && this.state !== 'pause' && this.state !== 'menu') return;
    // (from the main menu: the map round the place the drive would begin – the vehicle shown there is put away meanwhile)
    const from = this.state === 'menu' ? this.menuPreview : null;
    if (this.state === 'menu') this.clearPreview();
    this.mapFrom = this.state;
    this.state = 'map';
    this.input.enabled = false;
    this.audio.suspend();
    this.hud.hideOverlay();
    this.hud.setHudVisible(false);
    if (this.mapFrom === 'menu') {
      this.mpos[0] = from?.x ?? this.menuFocus.x;
      this.mpos[2] = from?.z ?? this.menuFocus.z;
    } else this.vehicle.getModelPosition(this.mpos);
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
    this.endWatch();
    this.routeWatch = null;
    // (on foot beside the vehicle: back into the seat first; a tram is driven by hand only)
    if (this.walker) this.leaveWalk();
    const plane = this.aircraft;
    if (plane) {
      // the aeroplane by itself: to the (first) place chosen, at least 300 m above the ground there, circling it –
      // or down onto the runway of an airfield if the place is one
      if (!self && stops.length > 0) {
        const to = stops[0];
        const field = this.air ? landingRunway(this.air.airfields, to.x, to.z) : null;
        const alt = Math.max(plane.altitude, this.groundHeight(to.x, to.z) + 300);
        const rw = plane.onGround && this.air ? runwayAt(this.air.airfields, plane.pos.x, plane.pos.z, plane.yaw) : null;
        this.flightGoto = null;
        if (field && field.distance < 1500 && !plane.onGround) this.flightAuto.land(field.runway, field.fromSecond);
        else if (rw) {
          // on a runway: take off first, then there (stepFlight hands over once it climbs)
          this.flightAuto.takeoff(rw.runway, rw.fromSecond);
          this.flightGoto = { x: to.x, z: to.z, alt };
        } else this.flightAuto.goto(to.x, to.z, alt);
        this.flightAuto.takeOver({ throttle: this.flight.throttle, trim: this.flight.trim });
        this.flightTake = 0;
        this.hud.message(tr('apOn', this.settings.lang));
      }
      if (this.state === 'map') this.closeMap();
      else if (this.state === 'pause') this.resume();
      return;
    }
    if (this.tram) {
      // the tram follows its tracks: "by itself" is its demonstration drive (the places chosen do not matter to it)
      if (!self) {
        this.tramAuto = true;
        this.tramTake = 0;
        this.tramHeld = false;
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
      this.toAutomatic();
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
      held: false,
      freeT: 0,
      lost: 0,
      searchAt: 0,
      stuck: 0,
      rescues: 0,
      rescuedAt: -100,
      tour: tour ? { ways: tour.plan.ways, from: tour.from, metres: tour.plan.metres, fresh: tour.plan.fresh, odo: this.vehicle.odometer, set: false, line: tour.line } : null,
    };
    this.hud.clearNotices();
  }

  /**
   * A set route (game/routepresets.ts): planned from the road the vehicle is on through its places
   * and back, then driven by the player with the way shown, as a tour – leaving it, or driving
   * along it the other way, is a fault (RouteWatch).
   */
  private startPreset(id: string): void {
    const preset = ROUTE_PRESETS.find((r) => r.id === id);
    const lang = this.settings.lang;
    if (!preset || this.lesson) return;
    const lane = this.currentLane();
    const g = this.routeGraphNow();
    if (!lane || !g) {
      // (not on a road – or the roads of the whole map are still being read)
      this.wantNet();
      this.hud.message(tr(lane ? 'realityLoading' : 'routes.noRoad', lang));
      return;
    }
    const from = wayOf(lane);
    const plan = planPreset(g, from, preset, this.netIndex?.main);
    if (!plan) {
      this.hud.message(tr('routes.none', lang));
      return;
    }
    const net = this.netIndex?.net ?? null;
    const line = routeLine(g, from, plan.ways, net ? (e) => netPolyline(net, e) : undefined);
    const p0 = preset.points[0];
    const name = tr(`routes.${id}.name`, lang);
    this.startTrip([], true, { plan: { ways: plan.ways, metres: plan.metres, fresh: plan.metres, again: 0, valued: plan.metres }, line, from, end: { name, x: p0.x, z: p0.z, yaw: 0, kind: 'street' } });
    if (!this.demo) return;
    this.routeWatch = new RouteWatch(from, plan.ways);
    this.hud.message(name, tr('routes.started', lang, { km: formatUnit(plan.metres / 1000, 'kilometer', lang, 1) }));
  }

  /** The drive is over: the car has arrived, the player takes it over, or there is no way to go on. */
  private endDemo(why: 'arrived' | 'taken' | 'lost' | 'ended'): void {
    const demo = this.demo;
    if (!demo) return;
    this.demo = null;
    this.routeWatch = null;
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
    if (!cmd || demo.held || Math.abs(p.speed) > 0.3) demo.stuck = 0;
    else if (!this.nav.busy) demo.stuck = 0;
    else if (cmd.waiting && lane) demo.stuck += cmd.remark === 'red' ? 0 : dt * 0.45;
    else demo.stuck += dt;
    if (demo.stuck > 7) {
      demo.stuck = 0;
      // (put further on each time it is stuck again soon after: past whatever stands in the way)
      demo.rescues = this.time - demo.rescuedAt < 60 ? demo.rescues + 1 : 0;
      demo.rescuedAt = this.time;
      const g = lane ? { x: p.x, z: p.z, yaw: p.yaw } : this.lastGood;
      const spot = this.freeSpot(g.x, g.z, g.yaw, 8 + 14 * demo.rescues);
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
    // a set route: kept – or left, or driven the other way (game/routepresets.ts)
    const off = this.routeWatch?.update(wayOf(lane), this.vehicle.odometer);
    if (off) this.rules.note(off, off === 'routeReverse' ? 'major' : 'minor', {}, 20);
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

  // ------------------------------------------------------------ the server (net/online.ts)
  private makeOnline(): void {
    const on = new Online({
      settings: this.settings,
      ui: this.ui,
      scene: this.app.scene,
      collider: this.collider,
      show: (node) => this.hud.showPanel(node),
      message: (text, sub) => this.hud.message(text, sub),
      where: () => (this.vehicle && this.state !== 'menu' && this.state !== 'loading' ? { x: this.mpos[0], z: this.mpos[2], yaw: this.vehicle.yaw } : null),
      mapStamp: () => {
        const m = this.app.world.json.meta;
        return `${m.generated}${m.patched ? `+${m.patched}` : ''}`;
      },
      settingsChanged: () => void loadLang(this.settings.lang).then(() => this.applySettings()),
      faultsChanged: () => {
        const fresh = new FaultLog();
        this.faultLog.entries.length = 0;
        this.faultLog.entries.push(...fresh.entries);
      },
      pickOnMap: (done) => {
        this.openMap();
        if (this.state !== 'map') return;
        extraLayers.pick = (x, z) => {
          extraLayers.pick = null;
          this.closeMap();
          done(x, z);
        };
        this.hud.message(tr('net.pickPlace', this.settings.lang));
      },
      goNear: (x, z) => {
        if (this.state !== 'pause' || this.lesson || this.crane || this.forklift || this.tram || this.aircraft) return false;
        const sp = this.roadSpot(x, z, '', 120);
        if (!sp) return false;
        this.teleportSpot(sp);
        return true;
      },
    });
    this.online = on;
    this.hud.onAccount = (back) => on.account(back);
    this.hud.onTogether = () => on.together(() => this.hud.showPause());
  }

  /** The own vehicle (or the player on foot) as the others of a session are to see it. */
  private netSelf(): Snapshot | null {
    if (!this.online?.session || this.wrecked || this.state === 'menu' || this.state === 'loading' || this.state === 'theory') return null;
    const now = performance.now();
    const wk = this.walker;
    if (wk && (this.def.kind === 'pedestrian' || this.walkerAway() || !this.riding)) {
      return { time: now, kind: 'pedestrian', x: wk.x, y: wk.y, z: wk.z, yaw: wk.yaw, pitch: 0, roll: 0, speed: wk.speed, steer: 0, lights: 0, signal: 0, brake: false, horn: false, walker: { walk: wk.distance, moving: wk.speed > 0.2 } };
    }
    const root = this.model.root;
    const e = NET_EULER.setFromQuaternion(root.quaternion, 'YXZ');
    const s = this.visual;
    return {
      time: now,
      kind: this.def.kind,
      x: root.position.x,
      y: root.position.y,
      z: root.position.z,
      yaw: e.y,
      pitch: e.x,
      roll: e.z,
      speed: this.tram ? this.tram.speed : this.aircraft ? this.aircraft.ias : this.vehicle.speed,
      steer: s.wheelSteer[0] ?? 0,
      lights: (s.lowBeam ? 1 : 0) | (s.highBeam ? 2 : 0) | (s.hazard ? 4 : 0) | (s.reversing ? 8 : 0),
      signal: s.indicator < 0 ? -1 : s.indicator > 0 ? 1 : 0,
      brake: s.braking,
      horn: this.input.c.horn,
    };
  }

  private closeMap(): void {
    if (this.state !== 'map') return;
    // (a place that was to be picked for a photo: not any more)
    extraLayers.pick = null;
    this.bigMap.close();
    if (this.mapFrom === 'menu') {
      // (back to the main menu: it places the vehicle anew – where it stood, or where it was chosen on the map)
      this.state = 'menu';
      this.hud.showMenu(this.app.world.json.spawns);
    } else if (this.mapFrom === 'pause') {
      this.state = 'pause';
      this.hud.setHudVisible(true);
      this.hud.showPause();
    } else this.resume();
  }

  // ------------------------------------------------------------ theory lessons
  /** the theory lessons (made when first opened) */
  private theory: TheoryMode | null = null;

  /** The theory lessons: situations shown on the practice yard – no drive, no traffic, no rules, no HUD meanwhile. */
  private openTheory(): void {
    if (!this.yardFrame) return;
    this.clearPreview();
    this.menuPreview = null;
    this.traffic.clear();
    this.rail.clear();
    this.hud.hideOverlay();
    this.hud.setHudVisible(false);
    this.audio.suspend();
    this.input.enabled = true;
    this.input.resetLook(false, true);
    this.state = 'theory';
    this.theory ??= new TheoryMode({
      app: this.app,
      ui: this.ui,
      settings: this.settings,
      input: this.input,
      signs: this.signs,
      yard: this.yardFrame,
      around: (x, z) => {
        this.app.tiles.update(x, z);
        this.props.update(x, z);
        this.far.update(this.app.camera.position.x, this.app.camera.position.z);
      },
      close: () => {
        this.input.resetLook(this.cameraMode === 'chase', this.cameraMode === 'free');
        this.toMenu();
      },
    });
    this.theory.open(new URLSearchParams(location.search).get('theory') ?? undefined);
  }

  private begin(mode: string, spawnIdx: number, skipIntro = false, address?: AddressHit, stop?: TramStopChoice, runway?: RunwayChoice): void {
    // (the theory lessons are no drive: a mode of their own on the practice yard)
    if (mode === THEORY_MODE) {
      this.openTheory();
      return;
    }
    // a set route from the menu (game/routepresets.ts): a drive of one's own from its first place – the route begins once there
    const preset = presetOfMode(mode);
    if (preset) {
      mode = 'free';
      address = { label: tr(`routes.${preset.id}.name`, this.settings.lang), street: '', x: preset.points[0].x, z: preset.points[0].z, exact: false };
      this.wantNet();
    }
    this.presetPending = preset?.id ?? '';
    // a lesson on the road: where it takes place, and whether it is driven or watched (ui/lessonstart.ts – game/lessonplaces.ts, lessonwatch.ts)
    const lessonAsked = LESSONS.find((l) => l.id === mode);
    if (lessonAsked && !this.lessonChosen && (placeKindOf(lessonAsked) || canWatch(lessonAsked))) {
      const lang = this.settings.lang;
      const ask = lessonStartPanel((k, v) => tr(k, lang, v), this.settings, this.app.world.json.spawns, { title: lessonTitle(lessonAsked.id, lang), place: !address && !!placeKindOf(lessonAsked), watch: canWatch(lessonAsked) }, () => {
        ask.remove();
        saveSettings(this.settings);
        this.lessonChosen = true;
        this.begin(mode, spawnIdx, skipIntro, address, stop, runway);
      }, () => ask.remove());
      this.ui.append(ask);
      return;
    }
    const watchLesson = this.lessonChosen && this.settings.lessonWatch;
    this.lessonChosen = false;
    if (VEHICLES[this.settings.vehicle]?.kind === 'plane' && !runway && !this.air && !this.airAwaited && this.app.map.pieces) {
      // (a flight asked for by a link before the airfields were read: it begins once they are)
      this.airAwaited = true;
      void this.app.map.air().then(() => this.begin(mode, spawnIdx, skipIntro, address, stop, runway));
      return;
    }
    const world = this.app.world;
    this.audio.start();
    this.spawnStreet = address?.street ?? '';
    this.spawn = (address ? this.startSpot(address) : null) ?? world.json.spawns[Math.max(0, Math.min(world.json.spawns.length - 1, spawnIdx))] ?? { name: '', x: 0, z: 0, yaw: 0, kind: 'street' };
    // On foot from the first start place: at the stop Baunatal Stadtmitte, looking at its departure board
    // (into a vehicle parked on the map: where it stands, as it stands – game/spawncar.ts)
    if (this.parkedAt) {
      this.spawn = { name: tr('mapPlace', this.settings.lang), x: this.parkedAt.x, z: this.parkedAt.z, yaw: this.parkedAt.yaw, kind: 'street' };
      this.parkedAt = null;
    }
    this.boardStart = null;
    if (VEHICLES[this.settings.vehicle]?.kind === 'pedestrian' && !address && spawnIdx === 0 && mode === 'free') {
      const st = this.stops?.places.find((p) => /stadtmitte/i.test(p.name) && (p.town === 'Baunatal' || /baunatal/i.test(p.name)));
      if (st) {
        this.spawn = { name: st.town && !st.name.includes(st.town) ? `${st.town}, ${st.name}` : st.name, x: st.x, z: st.z, yaw: 0, kind: 'street', rough: true };
        this.boardStart = { x: st.x, z: st.z, until: -1 };
      }
    }
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
    // (the test place: on the practice yard, at the west end of the aisle between the models)
    this.showOn = mode === 'show' && !!this.yardFrame;
    if (this.showOn && this.yardFrame) {
      const f = this.yardFrame;
      const [x, z] = f.toWorld(-f.yard.len / 2 + 4, -2);
      // (or, got into one of the models: where it stood – game/showdrive.ts)
      const at = this.showSpots.start();
      this.spawn = at ? { name: tr('showTitle', this.settings.lang), x: at.x, z: at.z, yaw: at.yaw, kind: 'street' } : { name: tr('showTitle', this.settings.lang), x, z, yaw: f.yawToWorld(-Math.PI / 2), kind: 'street' };
      if (!at) {
        this.tipText = tr('showEnter', this.settings.lang);
        this.tipUntil = this.time + 10;
      }
    }
    this.lesson = LESSONS.find((l) => l.id === mode) ?? null;
    this.demo = null;
    this.routeWatch = null;
    this.wrecked = false;
    this.explosion.clear();
    this.hud.setWrecked(false);
    if (this.walker) this.leaveWalk();
    this.footAfterJump = false;
    // (what stood behind the menu goes: the drive places its own vehicle)
    this.clearPreview();
    this.menuPreview = null;
    // (a new drive: a new recording for its replay)
    this.recorder.clear(VEHICLES[this.settings.vehicle]?.kind ?? 'car');
    // (nobody rides a tram or a bus any more)
    this.riding = null;
    this.busRide = null;
    // (the bus on a line: its stops from here on)
    this.busService = this.lesson?.kind === 'bus' ? new BusService() : null;
    this.busNav = '';
    this.railActors.hidden = null;
    this.passengerView.show(null);
    this.doorT = -1;
    this.opens.reset(this.car);
    this.fadeEl.classList.remove('on');
    // ("demo" and "tour" are free drives that begin with the map open, for planning – the tram's drives by itself at once)
    this.planeDemoPending = mode === 'demo' && VEHICLES[this.settings.vehicle]?.kind === 'plane';
    this.planDemo = (mode === 'demo' || mode === 'tour') && !this.tramAutoPending && VEHICLES[this.settings.vehicle]?.kind !== 'plane';
    this.hud.canTeleport = !this.lesson;
    this.hud.canFinish = !this.lesson;
    this.keepClock = false;
    this.path.breakLine();
    // the car, or the truck with its trailer (class CE)
    // (a lesson for some vehicles only – the yard tasks of class CE, the bus line – with one of them: the one chosen, if it is one)
    const allowed = this.lesson?.vehicles;
    this.def = VEHICLES[this.lesson?.vehicle ?? (allowed && !allowed.includes(this.settings.vehicle) ? allowed[0] : this.settings.vehicle)] ?? VEHICLES.car;
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
    const spec = this.services.begin(this.def, this.def.spec(arcadeTransmission(this.settings.arcadeDrive, this.settings.transmission), powerOf(this.def, this.settings.powers)), !this.lesson && mode === 'free');
    this.arcadeDrive.reset();
    this.vehicle = new Vehicle(spec, this.ground);
    this.wading.reset();
    // the sound of this kind of vehicle (its engine's revs – the tram and the aeroplane have their own)
    this.audio.setVehicle(soundKindOf(this.def.kind), spec);
    this.ensureModel(this.def);
    this.trailer = this.def.trailer ? makeTrailer(this.def.trailer, this.ground) : null;
    linkTowed(this.carTrailer, this.trailer);
    this.hud.gearbox = spec.transmission === 'automatic' && ((this.def.model !== 'car' && this.def.model !== 'motorcycle') || this.settings.arcadeDrive) ? 'automatic' : null;
    this.endTasks();
    // the camera stands further back for 16 m of vehicle
    this.input.c.lookZoom = this.def.zoom;
    this.input.zoomMax = this.def.zoomMax;
    this.collider.setShape(this.def.circles, this.def.radius);
    this.rules.setVehicle(this.def.caps, this.def.capFault, this.def.heavy, this.def.noMotorway);
    this.taskFailed = false;
    // watching the lesson: the car drives it by itself, with the automatic gearbox (game/lessonwatch.ts)
    this.lessonWatch = null;
    if (watchLesson && canWatch(this.lesson)) {
      this.toAutomatic();
      this.lessonWatch = new LessonWatch(new AutoDriver(this.app.world, this.signals, this.rules, this.traffic, { spec: this.vehicle.spec, front: this.def.outline.front, truck: this.def.heavy, caps: this.def.caps }));
    }
    // a lesson in a real place (game/lessonplaces.ts): from the district chosen – the place itself is looked for once the roads round it are there
    this.placeGoal = null;
    this.placeSearch = this.lesson && !address && this.spawn ? lessonStart(this.lesson, this.settings.lessonPlace, this.settings.lessonArea, world.json.spawns, this.spawn) : null;
    if (this.placeSearch) {
      this.spawn = this.placeSearch.spawn;
      if (this.placeSearch.kind === 'area') this.placeSearch = null;
    }
    this.roadSpawn = this.spawn;
    this.tasksLeft = this.isTruck && this.yardFrame && this.lesson?.tasks ? [...this.lesson.tasks] : [];
    this.taskCount = this.tasksLeft.length;
    if (this.tasksLeft.length > 0) this.nextTask();
    else if (this.def.long && !address) this.spawn = this.truckSpot(this.spawn);
    // the basic tasks of class B: on the practice yard, one after the other (game/drillplay.ts)
    this.drill = null;
    if (this.lesson?.drills && this.yardFrame) this.drillBegin(this.lesson.drills);
    // a crane: its free drive is the work on the construction site (game/craneplay.ts) – from the depot, the tower crane on its base
    this.crane?.dispose();
    this.crane = null;
    if (this.def.crane && !this.lesson && (mode === 'free' || mode === 'crane' || this.def.crane === 'tower')) {
      this.crane = this.makeCraneWork(this.def.crane);
      const at = craneStart(this.def.crane, this.yardFrame);
      if (at) this.spawn = { name: tr('craneSite', this.settings.lang), x: at.x, z: at.z, yaw: at.yaw, kind: 'street' };
      this.showOn = false;
      this.rules.yard = true;
      this.hud.canTeleport = false;
    }
    // the forklift (game/forkliftplay.ts): "Forklift work" on its place on the practice yard – any other way to play
    // a free drive where the menu put it (the place, the address, the test place); its camera from the side at first
    this.endForklift();
    if (this.def.kind === 'forklift') {
      const work = mode === FORK_WORK_MODE && !this.lesson;
      this.forklift = this.makeForkliftWork(work);
      const at = work ? forkliftStart(this.yardFrame) : null;
      if (at) this.spawn = { name: tr('forkPlace', this.settings.lang), x: at.x, z: at.z, yaw: at.yaw, kind: 'street' };
      if (work) {
        this.showOn = false;
        this.rules.yard = true;
      }
      this.hud.canTeleport = false;
      this.forkView();
    }
    this.input.setSteering(spec.wheelbase, spec.maxWheelAngle, spec);
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
      if (this.airAgl > 0) this.startPlaneAir(p, this.airAgl);
      else this.startPlane(p);
      return;
    }
    let sp = this.spawn!;
    // how far the loading is: the roads around the place, then the tiles (the bar of the loading screen)
    this.hud.setLoadingProgress(this.app.map.pieces ? 0.35 * this.app.map.progress(sp.x, sp.z, 1500) + 0.65 * this.app.tiles.progress : this.app.tiles.progress);
    // (the roads around the place: without them there is no lane to stand in, and nothing to drive on)
    if (!this.app.map.ready(sp.x, sp.z, 1500)) return;
    // a lesson in a real place: now that the roads round the district are there, the place itself (game/lessonplaces.ts)
    if (this.placeSearch && !this.task) {
      const ps = this.placeSearch;
      const radius = searchRadius(ps.kind);
      if (radius > 1500 && !this.app.map.ready(sp.x, sp.z, radius + 200)) return;
      this.placeSearch = null;
      const at = findLessonPlace(this.app.world, this.lanes, ps.kind, sp.x, sp.z, { usable: this.usableLane() });
      if (at) {
        this.placeGoal = at.goal;
        sp = this.spawn = this.roadSpawn = { name: at.name, x: at.x, z: at.z, yaw: at.yaw, kind: 'street' };
      } else {
        // (nothing fits there: where the player chose to start)
        sp = this.spawn = this.roadSpawn = ps.fallback;
        this.hud.message(tr('lessonPlace.none', this.settings.lang));
      }
      if (!this.app.map.ready(sp.x, sp.z, 1500)) return;
    }
    if (sp.rough) {
      // chosen on the overview of the map: now that the roads are there, into a lane of the road meant
      // (or at an address before any roads were known: then from the house to its street)
      const exact = findRoadSpot(this.app.world, this.lanes, sp.x, sp.z, this.spawnStreet, 230, this.usableLane());
      sp = this.spawn = exact ? { ...exact, name: sp.name } : { ...sp, rough: false };
    }
    const ty = this.app.tiles.heightAt(sp.x, sp.z);
    if (Number.isNaN(ty) || !this.app.tiles.settled) return;
    // "place precisely": at the very place chosen, facing along the road nearest – or the nearest free place round it
    if (exactSpots.has(sp)) sp = this.spawn = { ...sp, ...this.fitExact(sp, this.def.outline), rough: false };
    let y = this.app.world.surfaceAt(sp.x, sp.z, ty + 3, this.hit) ? this.hit.y : ty;
    // the practice yard is laid out over the field as soon as the ground under it is there
    if (this.task && !this.task.laid) this.task.laid = this.yardScene.show(this.yardFrame!, this.task.run.layout, (x, z) => this.app.tiles.heightAt(x, z));
    let place = { x: sp.x, z: sp.z, yaw: sp.yaw };
    // (never into a wall or onto a post: then the nearest free place in a lane instead)
    if (!this.task && !this.drill && (this.collider.blocked(sp.x, y, sp.z, sp.yaw, 0.05) || (!this.crane && !this.forklift?.siteOn && inBuilding(sp.x, sp.z, sp.yaw, this.def.outline, (x, z) => this.spawnCars.footprints.inside(x, z))))) {
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
    this.walkPending = this.settings.startOutside && !this.task && !this.drill && !this.planDemo && !this.lessonWatch && !this.walker && this.def.kind !== 'tram' && this.def.kind !== 'pedestrian' && !this.crane && !this.forklift && !this.intoParked;
    this.intoParked = false;
    this.footPending = this.def.kind === 'pedestrian';
    if (this.tramAt) {
      // the player's tram, its front at the stop's mark (the other way round if it does not fit behind it there)
      const at = this.tramAt;
      this.tramAt = null;
      const set = this.settings.tramSet;
      const rv = this.rail.spawnAt(at.path, at.s, at.dir, 0, set) ?? this.rail.spawnAt(at.path, at.s, at.dir > 0 ? -1 : 1, 0, set);
      if (rv) {
        this.tram = new TramDriver(this.rail, rv, this.app.world, this.signals);
        // a line that calls at this stop: the switches are set for it unless the indicator asks for another way
        this.rail.assignLine(rv, this.tramLineRef);
        this.tramLineRef = '';
        this.placeTramProxy();
        this.tramAuto = this.tramAutoPending;
        this.tramTake = 0;
        this.tramHeld = false;
        // (the handbrake is the tram's emergency brake: not on when the drive begins at the stop)
        this.input.c.handbrake = 0;
        // the drive begins with the pantograph down: it is raised first (the demonstration drive does that by itself)
        this.tram.panto = 0;
        this.tram.pantoUp = false;
        rv.panto = 0;
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
    } else if (this.services.startScene(this.vehicle, this.model, () => this.resume())) this.state = 'intro';
    else this.resume();
    if (this.planDemo && this.state === 'drive') {
      this.planDemo = false;
      this.openMap();
      this.bigMap.plan();
    }
    if (this.afterPlace && this.state === 'drive') {
      const f = this.afterPlace;
      this.afterPlace = null;
      f();
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

  /** On foot and well away from the vehicle (not riding a tram or bus): the world is to come and go round the person. */
  private walkerAway(): boolean {
    const w = this.walker;
    return !!w && (this.wrecked || (!this.riding && !this.busRide && this.def.kind !== 'pedestrian' && Math.hypot(w.x - this.mpos[0], w.z - this.mpos[2]) > TETHER));
  }

  /** Where the world loads round: the vehicle – or somebody who walked away from it. */
  private focus(): [number, number] {
    if (this.watcher) return this.watcher.focus();
    // (the developer's view: the world loads round the camera)
    if (this.cameraMode === 'dev') return [this.free.pos.x, this.free.pos.z];
    // (the flying camera: the world loads round it – game/flycam.ts)
    if (this.flyFree() && this.fly.ready) return [this.fly.x, this.fly.z];
    const w = this.walker;
    return w && this.walkerAway() ? [w.x, w.z] : [this.mpos[0], this.mpos[2]];
  }

  // ------------------------------------------------- watching a tram or bus of the timetables (spectate.ts)
  /** Watch a tram or bus (chosen on the big map): the camera goes with it, the world loads round it, the player's vehicle waits. */
  private startWatch(v: WatchRequest): void {
    if (this.state === 'map' && this.mapFrom === 'menu') {
      // from the main menu: a free drive begins (the vehicle and the place chosen there), and the watching with it once placed
      this.closeMap();
      const ls = this.settings.lastStart;
      this.begin('free', ls.spawn, true, ls.address ?? undefined);
      this.afterPlace = () => this.startWatch(v);
      return;
    }
    const src = this.transitData();
    if (!src || this.lesson || this.replay || (this.state !== 'map' && this.state !== 'drive' && this.state !== 'pause')) return;
    this.watcher?.dispose();
    // (the trams and cars round the player go: those round the vehicle watched come – the tram itself with them)
    this.clearRail();
    this.traffic.clear();
    this.watcher = new Watcher(v, {
      hud: () => this.ui.querySelector<HTMLElement>('.hud'),
      ui: this.ui,
      lang: () => this.settings.lang,
      source: src,
      rail: () => this.rail,
      traffic: () => this.traffic,
      lanes: this.lanes,
      ready: (x, z) => this.app.map.ready(x, z, 400) && !Number.isNaN(this.app.tiles.heightAt(x, z)),
      ground: (x, z) => this.groundHeight(x, z),
      takeOver: (w, at) => this.takeOverWatched(w, at),
      back: () => this.endWatch(),
    });
    if (this.state === 'map') {
      this.mapFrom = 'drive';
      this.closeMap();
    } else if (this.state === 'pause') this.resume();
  }

  /**
   * Watch something else the map shows: an emergency vehicle of the traffic
   * (by its id), a demonstration (its crowd) or a site of roadworks (its
   * middle, where the workers are).
   */
  private startPointWatch(what: { kind: 'em'; id: number } | { kind: 'car'; id: number } | { kind: 'rail'; id: number } | { kind: 'event'; ev: RoadEventInfo }): void {
    if (this.lesson || this.replay || (this.state !== 'map' && this.state !== 'drive' && this.state !== 'pause')) return;
    const lang = this.settings.lang;
    let target: WatchTarget;
    if (what.kind === 'em' || what.kind === 'car') {
      // an emergency vehicle (from the map), or any car, bus or emergency vehicle tapped (game/takeover.ts) – each can be taken over
      const car = this.traffic.cars.find((c) => c.id === what.id);
      if (!car) return;
      const names = ['emPolice', 'emAmbulance', 'emFire', 'emDoctor'];
      const line = car.bus?.line;
      target = {
        title: car.em ? tr(names[car.em.kind] ?? 'emPolice', lang) : car.bus ? `${tr('transitBus', lang)} ${line ? `${line.ref} → ${line.to}` : ''}`.trim() : tr('watchCar', lang),
        sub: car.em ? tr(car.em.call ? 'emOnCall' : 'emPatrol', lang) : '',
        length: car.length,
        get: () => {
          const c = this.traffic.cars.find((q) => q.id === what.id);
          // (as it is drawn: eased through the corners of its way – sim/smoothpose.ts)
          const d = c?.drawn ?? c;
          return c && d ? { x: d.x, y: c.y, z: d.z, yaw: d.yaw } : null;
        },
        take: () => this.takeOverCar(what.id),
      };
    } else if (what.kind === 'rail') {
      // a tram or a train tapped: a tram can be taken over (from its next stop)
      const v = this.rail.vehicles.find((q) => q.id === what.id);
      if (!v) return;
      const tram = v.kind !== RAIL.TRAIN;
      const ref = v.line ? (this.rail.lines[v.line.index]?.ref ?? '') : '';
      target = {
        title: `${tr(tram ? 'transitTram' : 'watchTrain', lang)} ${ref}`.trim(),
        sub: '',
        length: consistLength(v.consist),
        get: () => {
          const q = this.rail.vehicles.find((r) => r.id === what.id);
          if (!q) return null;
          const c = q.cars[Math.floor((q.cars.length - 1) / 2)];
          return { x: c.x, y: c.y, z: c.z, yaw: q.cars[0].yaw };
        },
        ...(tram ? { take: () => this.takeOverTram(what.id) } : {}),
      };
    } else {
      const ev = what.ev;
      const demo = ev.kind === 'demo';
      target = {
        title: demo ? tr('eventDemoTitle', lang, { place: ev.detail }) : tr('eventWorks', lang),
        sub: ev.street,
        length: demo ? 40 : 24,
        get: () => {
          if (demo) return this.roadEvents.crowdAt(ev.x, ev.z, gameClock.ms()) ?? { x: ev.x, y: NaN, z: ev.z, yaw: 0 };
          return { x: ev.x, y: NaN, z: ev.z, yaw: 0 };
        },
      };
    }
    this.watcher?.dispose();
    this.watcher = new PointWatcher(target, {
      hud: () => this.ui.querySelector<HTMLElement>('.hud'),
      ui: this.ui,
      t: (k, p) => tr(k, this.settings.lang, p),
      backText: () => tr('watchBack', this.settings.lang),
      goneText: () => tr('watchGone', this.settings.lang),
      ground: (x, z) => this.groundHeight(x, z),
      back: () => this.endWatch(),
    });
    if (this.state === 'map') {
      this.mapFrom = 'drive';
      this.closeMap();
    } else if (this.state === 'pause') this.resume();
  }

  // ------------------------------------------------- any vehicle watched, taken over; the models of the test place got into (game/takeover.ts, showdrive.ts)
  /**
   * What a tap on the 3D picture may choose now: in a free drive – while
   * watching, on foot, or standing in the vehicle seen from outside – any
   * vehicle of the traffic, the trams and trains; on the test place its
   * models.  Null: nothing (a tap is left to the rest of the game).
   */
  private pickBoxes(): PickBox[] | null {
    if (this.state !== 'drive' || this.lesson || this.task || this.demo?.active || this.spawnCars.picking || this.doorT >= 0 || this.opens.busy || this.riding || this.busRide) return null;
    const out: PickBox[] = [];
    // (on foot, or standing in the vehicle seen from outside – in the driver's seat a tap is for its screen and mirrors)
    const still = !!this.walker || (Math.abs(this.vehicle.speed) < 0.5 && this.cameraMode !== 'cockpit' && !this.aircraft && !this.tram);
    if (this.showOn && !this.watcher && still) for (const b of this.showSpots.boxes()) out.push(b);
    if (this.watcher || (still && !this.forklift && !this.crane && !this.showOn)) {
      for (const c of this.traffic.cars) {
        const d = c.drawn ?? c;
        out.push({ x: d.x, y: c.y, z: d.z, yaw: d.yaw, height: c.length > 7 ? 3.1 : c.length > 5 ? 2.7 : 1.5, front: c.length / 2, rear: c.length / 2, hw: c.width / 2, what: { kind: 'car', id: c.id } });
      }
      for (const v of this.rail.vehicles) {
        if (v.player) continue;
        const roles = carLayout(v.consist);
        v.cars.forEach((rc, i) => out.push({ x: rc.x, y: rc.y, z: rc.z, yaw: rc.yaw, height: 3.4, front: roles[i].len / 2, rear: roles[i].len / 2, hw: v.consist.width / 2, what: { kind: 'rail', id: v.id } }));
      }
    }
    return out;
  }

  /** A vehicle was tapped: watch it – or, on the test place, get into the model. */
  private picked(t: PickTarget): void {
    if (t.kind === 'show') this.enterShow(t.i);
    else this.startPointWatch(t);
  }

  /**
   * Take over a car of the traffic watched – any car, a bus, an emergency
   * vehicle: a free drive from where it is, as the game's vehicle nearest to
   * it (game/takeover.ts takeKindOf), standing at first – a bus on a line
   * shown its line's way.  The vehicle chosen in the menu stays what it was.
   */
  private takeOverCar(id: number): void {
    const car = this.traffic.cars.find((c) => c.id === id);
    if (!car) return;
    const lang = this.settings.lang;
    const d = car.drawn ?? car;
    const kind = takeKindOf(car.style);
    const line = car.bus?.line;
    const src = line ? this.transitData() : null;
    const way = line && src ? lineWay(src, { x: d.x, z: d.z, yaw: d.yaw, stop: '', ...lineTakeOver(src, line.index, line.k) }) : null;
    const paint = !car.em && !car.bus ? car.color : -1;
    this.endWatch(false);
    if (this.demo) this.endDemo('ended');
    const was = this.settings.vehicle;
    this.settings.vehicle = kind;
    this.parkedAt = { x: d.x, z: d.z, yaw: d.yaw };
    this.intoParked = true;
    try {
      this.begin('free', 0, true, { label: tr('mapPlace', lang), street: '', x: d.x, z: d.z, exact: true });
    } finally {
      this.settings.vehicle = was;
    }
    // (a car of the traffic: in its paint)
    if (paint >= 0 && this.def.model === 'car') this.car.exterior.paint.color.setHex(paint);
    if (way) this.afterPlace = () => this.startTrip([], true, way);
    this.hud.message(tr('watchTakenVehicle', lang, { what: tr(VEHICLES[kind].name, lang) }));
  }

  /** Take over a tram watched: a drive of the tram from the stop nearest to it, on its line. */
  private takeOverTram(id: number): void {
    const v = this.rail.vehicles.find((q) => q.id === id);
    if (!v) return;
    const lang = this.settings.lang;
    const f = v.cars[0];
    const ref = v.line ? (this.rail.lines[v.line.index]?.ref ?? '') : '';
    this.endWatch(false);
    if (this.demo) this.endDemo('ended');
    const was = this.settings.vehicle;
    this.settings.vehicle = 'tram';
    try {
      this.tramLineRef = ref;
      this.begin('free', 0, true, undefined, { name: '', town: '', x: f.x, z: f.z });
    } finally {
      this.settings.vehicle = was;
    }
    this.hud.message(tr('watchTakenVehicle', lang, { what: tr(VEHICLES.tram.name, lang) }));
  }

  /** On foot on the test place beside one of its models – nearer to it than to the own vehicle: which (−1: none). */
  private showBeside(): number {
    const w = this.walker;
    if (!w || !this.showOn || this.watcher) return -1;
    const i = this.showSpots.near(w.x, w.z);
    const s = this.showSpots.list[i];
    if (!s) return -1;
    this.vehicle.getModelPosition(this.mpos);
    return Math.hypot(s.x - w.x, s.z - w.z) < Math.hypot(this.mpos[0] - w.x, this.mpos[2] - w.z) ? i : -1;
  }

  /** Into a model of the test place (tapped, or the door key on foot beside it): the drive there goes on with it, from where it stands. */
  private enterShow(i: number): void {
    if (!this.showOn || this.state !== 'drive' || this.watcher || !this.showSpots.choose(i)) return;
    const s = this.showSpots.list[i];
    // (the vehicle chosen from now on, as when getting into a parked one)
    this.settings.vehicle = s.kind;
    saveSettings(this.settings);
    this.intoParked = true;
    this.begin('show', 0, true);
  }

  /** the trams and buses for the maps (made when first asked for) */
  private transitData(): TransitSource | null {
    return (this.transitSrc ??= transitSource({ timetable: () => this.timetable, lines: () => this.lines, rail: () => this.rail, busLines: () => this.traffic.busLines, net: () => this.netIndex, world: this.app.world, stops: () => this.stops }));
  }

  /** Back to the player's own vehicle: the world loads round it again. */
  private endWatch(clear = true): void {
    if (!this.watcher) return;
    this.watcher.dispose();
    this.watcher = null;
    if (clear) {
      this.clearRail();
      this.traffic.clear();
    }
    this.camSnap = true;
  }

  /** The trams and trains of the traffic go (to come anew where they are due) – the player's own tram stays. */
  private clearRail(): void {
    const own = this.rail.vehicles.filter((q) => q.player);
    this.rail.clear();
    this.rail.vehicles.push(...own);
  }

  /** A step while watching: the vehicle runs on, the world round it – the player's own vehicle waits. */
  private stepWatch(dt: number): void {
    const w = this.watcher as Watcher | PointWatcher;
    w.step(dt, this.input.c);
    const g = w.ghost;
    this.signals.update(dt);
    const others = this.railOthers;
    others.length = 0;
    for (const car of this.traffic.cars) others.push({ x: car.x, z: car.z, r: 1.3 });
    // (and the crowd of a march on its street)
    this.roadEvents.railBlocks(others);
    this.rail.update(dt, g, others);
    const boxes = this.railBoxes;
    boxes.length = 0;
    for (const rv of this.rail.vehicles) rv.cars.forEach((rc, i) => boxes.push({ x: rc.x, y: rc.y, z: rc.z, yaw: rc.yaw, speed: rv.speed, length: carLayout(rv.consist)[i].len, width: rv.consist.width }));
    this.traffic.obstacles = boxes;
    this.traffic.update(dt, g);
  }

  /**
   * The player takes the vehicle watched over: a drive of a tram from its
   * stop on its line, or of a bus from where it is, shown its line's way.
   */
  private takeOverWatched(w: WatchRequest, at: TakeOver): void {
    const src = this.transitSrc;
    this.endWatch(false);
    const was = this.settings.vehicle;
    // (for this drive only: the vehicle chosen in the menu stays what it was)
    this.settings.vehicle = w.kind === 'tram' ? 'tram' : 'bus';
    try {
      if (w.kind === 'tram') {
        this.tramLineRef = w.ref;
        this.begin('free', 0, true, undefined, { name: at.stop, town: '', x: at.x, z: at.z });
      } else {
        this.begin('free', 0, true, { label: `${w.ref} → ${w.dest}`, street: '', x: at.x, z: at.z, exact: true });
        const way = src ? lineWay(src, at) : null;
        if (way) this.afterPlace = () => this.startTrip([], true, way);
      }
    } finally {
      this.settings.vehicle = was;
    }
    this.hud.message(tr('watchTaken', this.settings.lang, { ref: w.ref, dest: w.dest }));
  }

  /**
   * Free flight: the aeroplane put over a place chosen on the map, `agl`
   * metres above the ground there (150 … 3000), flying level the way the road
   * there runs – once the ground there is loaded (tryPlace).
   */
  private flyFrom(spot: SpawnJson, agl: number): void {
    if (!this.aircraft || this.lesson || (this.state !== 'map' && this.state !== 'pause')) return;
    this.endWatch(false);
    this.bigMap.close();
    this.spawn = { ...spot, rough: false };
    this.airAgl = Math.max(150, Math.min(3000, agl));
    this.planePending = true;
    this.traffic.clear();
    this.rail.clear();
    this.keepClock = true;
    this.state = 'placing';
    this.showModel(false);
    this.hud.setHudVisible(true);
    this.hud.showLoading(tr('loadingTiles', this.settings.lang));
  }

  /** In the air over a place, `agl` metres above the ground, flying level at cruising speed with the power and trim for it. */
  private startPlaneAir(sp: SpawnJson, agl: number): void {
    this.airAgl = 0;
    const a = this.aircraft ?? new Aircraft(TRAINER, powerOf(this.def, this.settings.powers));
    const speed = TRAINER.vcruise;
    a.placeInAir(sp.x, this.groundHeight(sp.x, sp.z) + agl, sp.z, sp.yaw, speed, this.airGround ?? this.ground);
    const lf = a.levelFlight(speed);
    this.aircraft = a;
    this.flight.throttle = lf.throttle;
    this.flight.flaps = 0;
    this.flight.trim = lf.trim;
    this.flight.crashT = -1;
    // (placed in the air: the autopilot holds this height and heading until the stick is touched)
    this.flightAuto.off();
    this.flightAuto.hold(a.heading, a.altitude);
    this.flightAssist.reset(lf.trim);
    this.flightTake = 0;
    this.input.c.gear = 0;
    this.ui.classList.add('flying');
    this.placePlaneProxy();
    this.lastGood = { x: sp.x, y: a.pos.y, z: sp.z, yaw: sp.yaw, t: 0 };
    this.camSnap = true;
    this.showModel(true);
    this.keepClock = false;
    this.resume();
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
    this.offerReplay();
    this.hud.showPause();
  }

  /** Does the autopilot drive now (the car's, or the tram's), without the player at the controls? */
  private autopilotDriving(): boolean {
    return (!!this.demo?.active && !!this.demo.driver && !this.demo.held) || (this.tramAuto && !this.tramHeld) || (!!this.lessonWatch && !!this.lesson);
  }

  /**
   * The world's clock jumped (another moment chosen, or back to the real
   * time): the trams of the traffic are put where the timetables have them
   * then, the sun where it stands then.
   */
  private clockJumped(): void {
    this.rail.resync();
    resyncBuses(this.traffic);
    this.sunPlacedAt = -1;
    this.updateSun();
  }

  /** the last moment the sun was placed for (-1: to be placed, -2: the game's fixed afternoon) */
  private sunPlacedAt = -1;

  /**
   * The sun: where it stands at the world's moment when the arcade mode set
   * another one (or the settings ask for the real daylight) – otherwise the
   * fair afternoon the game has always had.
   */
  private updateSun(): void {
    const own = !gameClock.real || this.settings.daylight === 'clock';
    const ms = gameClock.ms();
    if (own) {
      if (this.sunPlacedAt >= 0 && Math.abs(ms - this.sunPlacedAt) < 20000) return;
      this.sunPlacedAt = ms;
      const sun = sunAt(ms);
      // (below the horizon the night is not black: the sky keeps some light, as on a clear night in town)
      this.app.sky.setSun(Math.max(sun.elevation, -6), sun.azimuth);
      this.beams.sunElevation = sun.elevation;
    } else if (this.sunPlacedAt !== -2) {
      this.sunPlacedAt = -2;
      this.app.sky.setSun(52, 215);
      this.beams.sunElevation = 52;
    }
  }

  /** The headlights, once a frame (game/beamplay.ts): `model` the vehicle driven (null: none – a replay, the menu). */
  private headlights(dt: number, model: VehicleModel | null): void {
    const v = this.vehicle;
    const drive = this.state === 'drive';
    const driving = !!model && !!v && !this.walker && !this.aircraft && !this.tram;
    const c = this.input.c;
    const night = this.beams.dark > 0 && !!this.traffic;
    const edge = this.rules.laneNow?.edge;
    const r = this.beams.frame({
      dt: drive ? dt : 0,
      driving,
      judged: drive && !this.demo?.active && !this.opens.passenger && !this.rules.yard,
      root: model?.root ?? null,
      front: this.def.outline.front,
      height: this.def.model === 'motorcycle' ? 1 : this.def.model === 'car' ? 0.68 : 0.95,
      x: this.mpos[0],
      z: this.mpos[2],
      yaw: v?.yaw ?? 0,
      speed: v?.speed ?? 0,
      low: c.lowBeam,
      high: this.lastVisual?.highBeam ?? false,
      lit: !!edge && (edge.flags & (EF.URBAN | EF.LIT)) !== 0,
      visibility: weatherNow().visibility,
      cheap: this.settings.graphics.shadows === 'off',
      cars: night ? this.traffic.cars : [],
      riders: night ? [...this.traffic.cyclists.list, ...this.traffic.crowd.people] : [],
      scene: this.app.scene,
      camera: this.app.camera,
      heightPx: this.app.canvas.height,
      heightAt: (x, z) => this.app.tiles.heightAt(x, z),
    });
    for (const f of r.faults) this.rules.note(f.id, f.severity, {}, f.cooldown);
    if (r.tip && driving && this.settings.hudRules && !this.rules.strict && !this.demo?.active) {
      this.tipText = tr(r.tip, this.settings.lang);
      this.tipUntil = this.time + 5;
    }
  }

  /** The replay is offered once there is something to see again (a few seconds of the drive). */
  private offerReplay(): void {
    this.hud.onReplay = this.recorder.frames.length > 30 ? () => this.startReplay() : null;
  }

  private finish(): void {
    this.path.save();
    if (this.demo?.tour) this.endDemo('ended');
    this.demo = null;
    const l = this.lesson;
    const exam = l?.kind === 'exam';
    const failed = this.rules.failed || this.rules.points >= 10 || this.taskFailed;
    const judged = this.taskCount > 0 || !!this.drill;
    this.endTasks();
    this.state = 'result';
    this.input.enabled = false;
    this.audio.suspend();
    this.hud.setHudVisible(false);
    this.lastResult = {
      title: l ? lessonTitle(l.id, this.settings.lang) : tr(this.crane ? 'craneWork' : this.forklift ? 'forkWork' : 'free', this.settings.lang),
      extra: this.crane?.resultNode() ?? this.forklift?.resultNode() ?? this.drill?.resultNode() ?? null,
      exam: !!exam || judged,
      passed: !failed,
      log: this.rules.log.slice(),
      points: this.rules.points,
      distanceKm: this.tram ? this.tram.odometer / 1000 : (this.vehicle.odometer - this.startOdo) / 1000,
      minutes: (this.time - this.startTime) / 60,
    };
    // how the lesson ended, for the lesson log (game/exam/learnstore.ts – ui/learn.ts)
    if (l) noteLessonEnd(l.id, !failed, this.rules.points, this.drill?.results ?? []);
    this.offerReplay();
    this.hud.showResult(this.lastResult);
  }

  // ---------------------------------------------------------------- replay
  /** One frame of the drive for its replay: what is drawn of the player, and – when due – of the others and the lights. */
  private captureFrame(others: boolean, lights: boolean): ReplayFrame {
    const model = this.model;
    const r = model.root;
    const pose = Float32Array.of(r.position.x, r.position.y, r.position.z, r.quaternion.x, r.quaternion.y, r.quaternion.z, r.quaternion.w);
    const look = this.aircraft ? this.recorder.planeLook.pack(this.planeVisual(this.aircraft)) : this.def.kind === 'pedestrian' || this.tram ? null : this.recorder.look.pack(this.visual);
    const t = this.trailer;
    const w = this.walker;
    const f: ReplayFrame = {
      t: this.time,
      pose,
      look,
      trailer: t ? Float32Array.of(t.x, t.y, t.z, t.yaw, t.pitch, t.wheelSpin, t.coupled ? 1 : 0) : null,
      walker: w ? Float32Array.of(w.x, w.y, w.z, w.yaw, w.distance, w.speed > 0.25 ? 1 : 0, this.riding || this.busRide ? 1 : 0) : null,
      cars: null,
      peds: null,
      cyclists: null,
      rail: null,
      signals: lights ? this.signals.snapshot(r.position.x, r.position.z, 600) : null,
    };
    if (others) {
      const cars = this.traffic.cars;
      const c = new Float32Array(cars.length * CAR_FIELDS);
      // (as they are drawn: eased through the corners of their ways – sim/smoothpose.ts)
      cars.forEach((k, i) => c.set([k.id, k.style, k.drawn?.x ?? k.x, k.y, k.drawn?.z ?? k.z, k.drawn?.yaw ?? k.yaw, k.pitch, k.wheelSpin, k.blinker, k.braking ? 1 : 0, k.v, k.color, k.bus?.line ? k.bus.line.index : -1], i * CAR_FIELDS));
      f.cars = c;
      // (the people on foot near the player: those that matter in a replay – the town has many more)
      const peds = this.traffic.crowd.near(r.position.x, r.position.z, 90);
      const p = new Float32Array(peds.length * PED_FIELDS);
      peds.forEach((k, i) => p.set([k.id, k.colour, k.x, k.y, k.z, k.yaw, k.state === 'cross' ? 1 : 0, k.phase], i * PED_FIELDS));
      f.peds = p;
      const cyc = this.traffic.cyclists.list;
      const y = new Float32Array(cyc.length * CYCLIST_FIELDS);
      cyc.forEach((k, i) => y.set([k.id, k.colour, k.x, k.y, k.z, k.yaw, k.phase, k.roll, k.down], i * CYCLIST_FIELDS));
      f.cyclists = y;
      const rail: number[] = [];
      for (const v of this.rail.vehicles) {
        const set = (v.consist.units ?? 1) > 1 ? 1 : v.consist.trailer ? 2 : 0;
        rail.push(v.id, v.kind, set, v.line ? v.line.index : -1, v.panto ?? 1, v.cars.length);
        for (const c of v.cars) rail.push(c.x, c.y, c.z, c.yaw, c.pitch);
      }
      f.rail = Float32Array.from(rail);
    }
    return f;
  }

  private replayState(): ReplayState {
    const rp = this.replay as ReplayView;
    return { t: rp.t, start: rp.start, end: rp.end, playing: rp.playing, speed: rp.speed, camera: this.replayCam.mode };
  }

  /** Watch the drive again: from a few seconds before the last note of the instructor, else from its start. */
  private startReplay(): void {
    const rec = this.recorder;
    if (rec.frames.length < 2 || (this.state !== 'pause' && this.state !== 'result')) return;
    this.replayFrom = this.state === 'result' ? 'result' : 'pause';
    this.replayLive = this.signals.snapshot(0, 0, Infinity);
    this.replayShown = null;
    const last = rec.notes[rec.notes.length - 1];
    this.replay = new ReplayView(rec, last ? last.t - 8 : rec.start);
    const c = this.replayCam;
    c.mode = 'behind';
    c.yaw = 0;
    c.pitch = -0.25;
    c.dist = this.def.long ? 24 : this.def.kind === 'plane' ? 18 : this.def.kind === 'pedestrian' ? 4.5 : 9;
    this.replayHidden = this.railActors.hidden;
    this.railActors.hidden = null;
    this.state = 'replay';
    this.hud.hideOverlay();
    this.hud.setHudVisible(false);
    this.input.enabled = true;
    this.input.resetLook(false, true);
    const rp = this.replay;
    const speeds = [0.5, 1, 2, 4];
    this.hud.showReplay(
      {
        toggle: () => {
          if (!rp.playing && rp.t >= rp.end - 0.05) rp.seek(rp.start);
          rp.playing = !rp.playing;
        },
        step: (sec) => rp.seek(rp.t + sec),
        speed: () => (rp.speed = speeds[(speeds.indexOf(rp.speed) + 1) % speeds.length]),
        seek: (t) => rp.seek(t),
        camera: () => {
          c.mode = c.mode === 'behind' ? 'driver' : c.mode === 'driver' ? 'free' : 'behind';
          c.yaw = 0;
          c.pitch = c.mode === 'driver' ? 0 : -0.25;
        },
        exit: () => this.endReplay(),
      },
      rec.notes,
      this.replayState(),
    );
  }

  /** Back from the replay to where it was opened: the live lights, the pause menu or the result. */
  private endReplay(): void {
    if (this.state !== 'replay') return;
    if (this.replayLive) this.signals.restore(this.replayLive);
    this.replayLive = null;
    this.replayShown = null;
    this.replay = null;
    this.railActors.hidden = this.replayHidden;
    this.figure.hide();
    this.hud.hideReplay();
    this.input.enabled = false;
    this.input.resetLook(this.cameraMode === 'chase', this.cameraMode === 'free');
    // (the vehicle where it really stands again)
    this.vehicle.getModelPosition(this.mpos);
    if (this.replayFrom === 'result' && this.lastResult) {
      this.state = 'result';
      this.hud.showResult(this.lastResult);
    } else {
      this.state = 'pause';
      this.hud.showPause();
    }
  }

  /** The replay's clock, and the player's model, trailer and figure as they were then. */
  private placeReplay(dt: number): void {
    const rp = this.replay;
    if (!rp) return;
    rp.advance(dt);
    this.hud.updateReplay(this.replayState());
    const fr = rp.frame();
    if (!fr) return;
    const p = rp.pose;
    const model = this.model;
    model.root.position.set(p[0], p[1], p[2]);
    model.root.quaternion.set(p[3], p[4], p[5], p[6]);
    model.root.updateMatrixWorld(true);
    this.mpos[0] = p[0];
    this.mpos[1] = p[1];
    this.mpos[2] = p[2];
    const a = fr.a;
    if (a.look && this.aircraft && this.planeModel) {
      const vis = this.planeVisual(this.aircraft);
      this.recorder.planeLook.unpack(a.look, vis);
      this.planeModel.update(vis, dt, this.time);
    } else if (a.look) {
      this.recorder.look.unpack(a.look, this.visual);
      model.update(this.visual, dt, this.time);
    }
    const t = a.trailer;
    if (t && this.truck && this.def.kind === 'truck') this.truck.setTrailer(t[0], t[1], t[2], t[3], t[4], t[5], t[6] === 1);
    if (t && this.carTrailer && this.def.model !== 'truck') this.carTrailer.place(t[0], t[1], t[2], t[3], t[4], t[5], this.visual);
    const w = a.walker;
    const wb = fr.b.walker ?? w;
    if (w && wb && w[6] !== 1) {
      const u = fr.u;
      let dy = wb[3] - w[3];
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      this.figure.show(w[0] + (wb[0] - w[0]) * u, w[1] + (wb[1] - w[1]) * u, w[2] + (wb[2] - w[2]) * u, w[3] + dy * u, w[4] + (wb[4] - w[4]) * u, w[5] === 1, this.time);
    } else this.figure.hide();
    this.app.tiles.update(p[0], p[2]);
    this.props.update(p[0], p[2]);
  }

  /** The camera of the replay: behind the vehicle (turning with it), from the driver's seat, or free round it – dragged round, closer and further. */
  private replayCamera(): void {
    const rp = this.replay;
    if (!rp) return;
    const cam = this.app.camera;
    const c = this.replayCam;
    const t = this.input.takeCam();
    c.yaw += t.yaw;
    c.pitch = Math.max(c.mode === 'driver' ? -1 : -1.45, Math.min(c.mode === 'driver' ? 0.8 : 0.35, c.pitch + t.pitch));
    c.dist = Math.max(2.5, Math.min(150, c.dist * Math.exp(-t.dolly * 0.25)));
    const model = this.model;
    const fwd = this.tmpV.set(0, 0, -1).applyQuaternion(model.root.quaternion);
    const heading = Math.atan2(-fwd.x, -fwd.z);
    cam.fov = 60;
    cam.near = 0.1;
    const fr = rp.frame();
    const w = fr?.a.walker;
    if (c.mode === 'driver' && !(w && w[6] !== 1)) {
      // the driver's eyes, looking where the vehicle points (turned by dragging)
      const eye = this.headV.copy(model.eye);
      model.root.localToWorld(eye);
      cam.position.copy(eye);
      cam.quaternion.setFromEuler(new THREE.Euler(c.pitch, heading + c.yaw, 0, 'YXZ'));
    } else {
      const target = this.headV;
      if (w && w[6] !== 1) target.set(w[0], w[1] + 1.4, w[2]);
      else target.set(model.root.position.x, model.root.position.y + (this.def.long ? 2 : 1.2), model.root.position.z);
      const yaw = (c.mode === 'behind' ? (w && w[6] !== 1 ? w[3] : heading) : 0) + c.yaw;
      const cp = Math.cos(c.pitch);
      cam.position.set(target.x + Math.sin(yaw) * cp * c.dist, target.y - Math.sin(c.pitch) * c.dist, target.z + Math.cos(yaw) * cp * c.dist);
      const gy = this.app.tiles.heightAt(cam.position.x, cam.position.z);
      if (!Number.isNaN(gy)) cam.position.y = Math.max(cam.position.y, gy + 0.6);
      cam.lookAt(target);
    }
    cam.updateProjectionMatrix();
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
    // F2: the whole display hidden or shown again – in any state
    if (a === 'hud') {
      this.hud.view?.toggleHud();
      return;
    }
    // (watching a tram or bus: nothing is done to the player's own vehicle meanwhile)
    if (this.watcher && a !== 'map' && a !== 'pause' && a !== 'help') return;
    if (a === 'reality') {
      if (this.state === 'reality') this.closeReality();
      else this.openReality();
    } else if (a === 'pause') {
      if (this.state === 'drive') this.pause();
      else if (this.state === 'pause') this.resume();
      else if (this.state === 'reality') this.closeReality();
      else if (this.state === 'map') this.closeMap();
      else if (this.state === 'replay') this.endReplay();
      else if (this.state === 'theory') this.theory?.back();
    } else if (a === 'open' && this.state === 'drive') {
      // on foot beside the vehicle: open or shut what is there (game/openplay.ts)
      this.opens.toggleAt(this.walker);
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
      this.audio.click('airDoor');
      for (const e of ev) this.rules.noteAt(e.fault, e.severity, this.mpos[0], this.mpos[2], {}, 8);
    } else if (a === 'door' && this.state === 'drive' && this.forklift) {
      // the forklift: the operator gets off beside the seat, and on again
      this.forkliftDoor();
    } else if (a === 'door' && this.state === 'drive' && this.crane?.type === 'tower') {
      // the tower crane: its operator climbs down, and up again
      this.towerDoor();
    } else if (a === 'door' && this.state === 'drive' && this.crane && !this.walker) {
      // the crane: from driving to working it, and back
      this.craneToggle();
    } else if (a === 'door' && this.state === 'drive' && this.showBeside() >= 0) {
      // on the test place, on foot beside one of the models: into it (game/showdrive.ts)
      this.enterShow(this.showBeside());
    } else if (a === 'door' && this.state === 'drive') {
      // (out of the tram's cab: the door key gets one in again at its door – after a vehicle went up in flames, a new one)
      const parked = this.walker ? this.spawnCars.near(this.walker.x, this.walker.z) : null;
      if (parked && this.canEnterParked()) this.enterParked(parked);
      else if (this.walker && this.wrecked) this.newVehicle();
      else if (this.walker && this.aircraft) this.boardPlane();
      else if (this.walker) this.getIn();
      else if (this.aircraft && !this.aircraft.onGround) {
        // (no stepping out in flight by a slip of the finger: the pause menu's "Get out" does that)
        this.tipText = tr('planeOutMenu', this.settings.lang);
        this.tipUntil = this.time + 4;
      }
      else if (this.tram) {
        // the tram's doors
        const ev = this.tramEvents;
        ev.length = 0;
        this.tram.toggleDoors(ev);
        this.audio.click('door');
        this.noteTram(ev);
      } else this.getOut();
    } else if (a === 'view' && this.state === 'replay') {
      const c = this.replayCam;
      c.mode = c.mode === 'behind' ? 'driver' : c.mode === 'driver' ? 'free' : 'behind';
      c.yaw = 0;
      c.pitch = c.mode === 'driver' ? 0 : -0.25;
    } else if (a === 'panto' && this.state === 'drive' && this.tram && !this.tramAuto) {
      // the tram's pantograph: up to the wire, or down
      const ev: TramEvent[] = [];
      this.tram.togglePanto(ev);
      this.audio.click('tick');
      this.noteTram(ev);
    } else if (a === 'view' && this.state === 'drive' && this.walker && !this.riding && !this.busRide) {
      // on foot: through one's own eyes ↔ seen from behind
      this.settings.footView = this.settings.footView === 'eyes' ? 'behind' : 'eyes';
      saveSettings(this.settings);
      this.hud.message(tr(this.settings.footView === 'behind' ? 'footViewBehind' : 'footViewEyes', this.settings.lang));
    } else if (a === 'view' && this.state === 'drive' && !this.walker && this.forklift) {
      // the forklift: from the side → the operator's seat → behind it → the free camera → …
      this.forklift.nextView();
      this.forkView();
      if (this.cameraMode === 'free') this.hud.message(tr('viewFree', this.settings.lang), tr(this.inputMode === 'touch' ? 'freeCamTouch' : 'freeCamKeys', this.settings.lang));
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
      // (in the aeroplane there is no road to be put back on: the key is its autopilot)
      if (this.aircraft) this.toggleFlightAuto();
      else this.resetToRoad();
    } else if (a === 'turn') {
      // F3, or "Turn around" in the ⋯ sheet: into the lane of the other direction, or on the spot
      this.turnAround();
    } else if (a === 'wiper' && this.state === 'drive' && !this.walker && !this.aircraft) {
      // the wiper stalk one place on: off → intermittent → normal → fast
      const m = this.windscreen.cycle();
      this.audio.click('tick');
      this.hud.message(tr('wipers.title', this.settings.lang), tr(`wipers.${m}`, this.settings.lang));
    } else if (a === 'service') {
      this.services.act(this.state);
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
    // (the parking brake on – unless the car drives by itself: then it simply drives on from there)
    if (!this.demo?.active && !this.lessonWatch) this.input.c.handbrake = 1;
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
    this.lessonWatch?.driver.reset();
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
  /** The vehicle driven gets the automatic gearbox, where it has another (for the autopilot, for arcade driving). */
  private toAutomatic(): void {
    if (this.vehicle.spec.transmission === 'automatic') return;
    const old = this.vehicle;
    old.getModelPosition(this.mpos);
    const spec = this.def.spec('automatic', powerOf(this.def, this.settings.powers));
    const v = new Vehicle(spec, this.ground);
    v.teleport(this.mpos[0], this.mpos[1] + 0.02, this.mpos[2], old.yaw);
    v.odometer = old.odometer;
    this.vehicle = v;
    this.input.setSteering(spec.wheelbase, spec.maxWheelAngle, spec);
    this.input.setAutomatic(true);
    this.hud.gearbox = 'automatic';
  }

  /** Arcade driving for the road vehicle driven now (not the tram, the aeroplane, the forklift, a crane at work, nor on foot or watching). */
  private arcadeNow(): boolean {
    return this.settings.arcadeDrive && !this.watcher && !this.tram && !this.aircraft && !this.forklift && !this.crane?.operating && this.def.kind !== 'pedestrian' && !this.walker && !this.wrecked;
  }

  private stepDrive(dt: number): void {
    // (arcade driving switched on in the middle of a drive: the automatic gearbox from here on)
    if (this.arcadeNow()) this.toAutomatic();
    const v = this.vehicle;
    const c = this.input.update(dt, v.speed, v.steerTorque);
    if (this.debugLook) {
      c.lookYaw = this.debugLook[0];
      c.lookPitch = this.debugLook[1];
    }
    if (this.watcher) {
      this.stepWatch(dt);
      return;
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
      // (out of the parked aeroplane: on foot beside it)
      if (this.walker) this.stepFoot(dt);
      else this.stepFlight(dt);
      return;
    }
    if (this.crane?.operating) {
      this.stepCrane(dt);
      return;
    }
    if (this.forklift) {
      this.stepForklift(dt);
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
    this.stepOpen(dt);
    if (this.walker) {
      // nobody in the seat: the vehicle stands as it was left (the keys W S A D walk)
      c.steer = d.steer = this.parkedSteer;
      c.throttle = d.throttle = 0;
      c.brake = d.brake = 0;
      c.clutch = d.clutch = 0;
      d.starter = false;
      // (not while getting into the car)
      if (!this.opens.busy) this.stepWalk(dt);
    } else this.opens.idle(c, d, !!this.demo?.active, this.parkedSteer);
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
      const hands = c.throttle > 0.2 || c.brake > 0.2 || Math.abs(c.steer) > 0.35 || c.handbrake > 0.5;
      demo.takeT = hands ? demo.takeT + dt : 0;
      if (demo.held) {
        // The assisted autopilot: the player drives for a while – when the hands have been off the
        // controls for a moment, on a road of the network, it drives on to its places from there.
        const idle = c.throttle < 0.05 && c.brake < 0.05 && Math.abs(c.steer) < 0.1 && c.handbrake < 0.5;
        demo.freeT = idle ? demo.freeT + dt : 0;
        c.gear = 1;
        d.gear = 1;
        if (demo.freeT > 2.5 && this.currentLane()) {
          demo.held = false;
          demo.takeT = 0;
          demo.stuck = 0;
          // (the way from where the player left it)
          this.nav.clear();
          this.hud.message(tr('demoResumed', this.settings.lang));
        }
      } else if (demo.takeT > 0.18 && this.settings.autopilotAssist) {
        demo.held = true;
        demo.freeT = 0;
        this.hud.message(tr('demoHeld', this.settings.lang));
      } else if (demo.takeT > 0.18) this.endDemo('taken');
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
    // watching the lesson: the autopilot drives it – until the player takes the wheel, and the lesson goes on with the player (game/lessonwatch.ts)
    if (this.lessonWatch && this.lesson && !this.walker) {
      v.getModelPosition(this.mpos);
      if (this.lessonWatch.control(dt, v, this.mpos, this.nav.route ?? [], this.nav.busy, c, d) === 'taken') {
        this.lessonWatch = null;
        this.hud.message(tr('lessonWatch.taken', this.settings.lang), tr('lessonWatch.takenSub', this.settings.lang));
      } else if (this.lessonWatch.cmd?.turnRound) {
        // (the end of a street the way leads back out of: turned round on the spot, as on a demonstration drive)
        const to = this.lessonWatch.cmd.turnRound.to;
        lanePoint(to, Math.min(3, to.len / 2), this.smp);
        const y = this.app.world.surfaceAt(this.smp.x, this.smp.z, this.smp.y + 1.5, this.hit) ? this.hit.y : this.smp.y;
        this.putOnRoad({ x: this.smp.x, y, z: this.smp.z, yaw: Math.atan2(-this.smp.tx, -this.smp.tz) });
        this.camSnap = true;
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
    // arcade driving: the pedals choose D and R, the vehicle holds at a standstill, the engine runs (game/arcadedrive.ts) –
    // not while the autopilot drives, nor for a passenger
    const arcade = this.arcadeNow() && !(demo?.active && !demo.held) && !this.lessonWatch && this.autoDrive <= 0 && !this.opens.passenger;
    if (arcade) {
      this.arcadeDrive.step(c.throttle, c.brake, v.speed, dt, d, d.throttle, v.engineRunning);
      c.gear = d.gear;
      c.handbrake = d.handbrake;
      c.ignition = true;
    }

    this.services.drive(dt, v, d, this.def, !!this.walker, !!this.task, !!this.demo?.active || this.autoDrive > 0);
    // through water: washed, the brakes wet (weaker while the physics steps), the engine drowned, the spray (game/wading.ts)
    const wadeTip = this.wading.step(dt, this.walker || this.tram || this.aircraft || this.wrecked ? null : v, this.def.model, this.services, d.brake, this.settings.quality !== 'low', this.app.sky.hemi.intensity / 1.2);
    if (wadeTip) {
      this.tipText = tr(wadeTip, this.settings.lang);
      this.tipUntil = this.time + 6;
    }
    const pedal = d.brake;
    // (wet brakes are road physics too: not when it is switched off)
    if (!this.settings.evenRoads) d.brake *= this.wading.brakeFactor;
    this.acc = Math.min(this.acc + dt, 0.1);
    let stalled = false;
    let grind = false;
    // (a vehicle that went up in flames is not there any more: nothing of it to step)
    if (this.wrecked || this.flyHold()) this.acc = 0;
    const speed0 = Math.abs(v.speed);
    let building = 0;
    while (this.acc >= PHYS_DT) {
      v.step(PHYS_DT, d);
      this.trailer?.step(PHYS_DT, v, d);
      // (the semi-trailer swung round against the tractor's cab)
      if (this.trailer instanceof SemiTrailer && this.trailer.jackknifeEvent) this.rules.note('semiJackknife', 'major');
      this.acc -= PHYS_DT;
      if (v.stalledEvent) stalled = true;
      if (v.gearGrind) grind = true;
      const hit = this.collider.resolve(v);
      if (hit > this.impact) this.impact = hit;
      if (this.collider.lastBuilding > building) building = this.collider.lastBuilding;
    }
    d.brake = pedal;
    // Into the wall of a building at 70 km/h or more, head on rather than grazing it: the vehicle goes up
    // in flames and is gone – the driver walks away unhurt (it is a game) and may take a new one.
    if (!this.wrecked && speed0 * 3.6 >= 70 && building > 0.5 * speed0 && !this.walker) this.explode();
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
    const car: PlayerState = { x: this.mpos[0] + Math.sin(v.yaw) * mid, y: this.mpos[1], z: this.mpos[2] + Math.cos(v.yaw) * mid, yaw: v.yaw, speed: v.speed, length: v.spec.length ?? 4.28, width: v.spec.width ?? 1.79 };
    // (somebody who walked away from the vehicle: the traffic comes and goes round them, and the parked vehicle is in its way)
    const away = this.walkerAway();
    const wk = this.walker;
    const player: PlayerState = away && wk ? { x: wk.x, y: wk.y, z: wk.z, yaw: wk.yaw, speed: wk.speed, length: 0.6, width: 0.6, onFoot: true } : car;
    // (the lane the vehicle was on in the last step, and where its middle was along it: the cyclists are sent along by it)
    player.lane = this.rules.context.onRoad ? this.currentLane() : null;
    player.s = this.laneFront() - player.length / 2;
    this.signals.update(dt);
    // trams and trains: they keep clear of the cars, the cars of them
    const others = this.railOthers;
    others.length = 0;
    for (const car of this.traffic.cars) others.push({ x: car.x, z: car.z, r: 1.3 });
    // (and the crowd of a march on its street)
    this.roadEvents.railBlocks(others);
    this.rail.update(dt, player, others);
    const boxes = this.railBoxes;
    boxes.length = 0;
    for (const rv of this.rail.vehicles) rv.cars.forEach((rc, i) => boxes.push({ x: rc.x, y: rc.y, z: rc.z, yaw: rc.yaw, speed: rv.speed, length: carLayout(rv.consist)[i].len, width: rv.consist.width }));
    if (this.trailer) {
      // the trailer is in the way of the traffic like the truck itself
      const t = this.trailer;
      const o = trailerOf(this.def) ?? TRAILER_OUTLINE;
      const off = (o.front - o.rear) / 2;
      boxes.push({ x: t.x - Math.sin(t.yaw) * off, y: t.y, z: t.z - Math.cos(t.yaw) * off, yaw: t.yaw, speed: t.coupled ? t.speed : 0, length: o.front + o.rear, width: o.hw * 2, own: t.coupled, parked: !t.coupled });
    }
    if (this.walker && !away) boxes.push({ x: this.walker.x, y: this.walker.y, z: this.walker.z, yaw: this.walker.yaw, speed: 0, length: 0.6, width: 0.6 });
    if (away && !this.wrecked) boxes.push({ x: car.x, y: car.y, z: car.z, yaw: car.yaw, speed: 0, length: car.length, width: car.width, parked: true });
    // (the other players' vehicles, when playing together: the traffic keeps clear of them too)
    this.online?.obstacles(boxes);
    this.traffic.obstacles = boxes;
    // (the horn: the people on foot near it start)
    player.horn = c.horn && !away;
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
      if (ev.type === 'collision') this.audio.click('crash');
      else if (ev.type === 'contact') {
        // out of the other vehicle by the shortest way, and no more speed into it (a little bounce): it is solid
        v.translate(ev.nx * (ev.depth + 0.02), 0, ev.nz * (ev.depth + 0.02));
        const vn = v.vel[0] * ev.nx + v.vel[2] * ev.nz;
        if (vn < 0) v.applyImpulse(v.pos[0], v.pos[1], v.pos[2], -ev.nx * vn * v.spec.mass * 1.2, 0, -ev.nz * vn * v.spec.mass * 1.2);
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
      // (arcade driving: no handbrake to forget, no engine to stall – nothing of it judged)
      handbrake: arcade ? 0 : c.handbrake,
      stalled: stalled && !arcade,
      hitScenery: impact,
      length: v.spec.length ?? 4.28,
      front: this.def.outline.front,
    };
    // (a passenger does not drive: nothing to judge)
    if (!this.opens.passenger) this.rules.update(dt, snap, this.traffic.events);
    this.signalTips(dt);
    // blue lights and siren near by: what to do (src/sim/emergency.ts) – not judged on a demonstration drive
    if (this.traffic.emergency) this.traffic.emergency.judging = !this.demo?.active;
    const emTip = this.traffic.emergency?.tip();
    if (emTip && this.settings.hudRules && !this.rules.strict && !this.demo?.active) {
      this.tipText = tr(emTip, this.settings.lang);
      this.tipUntil = this.time + 6;
    }
    // (what the roadworks or a closure ahead ask: said once as they come up)
    const roadTip = this.roadEvents.takeTip();
    if (roadTip && this.settings.hudRules && !this.rules.strict && !this.demo?.active) {
      this.tipText = tr(roadTip, this.settings.lang);
      this.tipUntil = this.time + 7;
    }
    if (!this.flyParked) this.rememberGoodSpot(player);
    if (this.task) this.updateTask(dt);
    else if (this.drill) this.updateDrill(dt);
    else if (this.demo) this.updateDemo(dt, player);
    else this.updateLesson(dt, player);
    // a crane driven to its stand: the site, the guide
    if (this.crane) {
      this.crane.drive(dt, v, c.handbrake > 0.5);
      if (this.crane.over) {
        this.finish();
        return;
      }
    }
    if (this.failT > 0 && this.time > this.failT) this.finish();
  }

  /** The work with a crane (game/craneplay.ts), told what it needs of the game. */
  private makeCraneWork(type: CraneType): CraneWork {
    const cw = new CraneWork(type, {
      scene: this.app.scene,
      ui: this.ui,
      settings: this.settings,
      yard: this.yardFrame,
      heightAt: (x, z) => this.app.tiles.heightAt(x, z),
      collider: this.collider,
      ground: this.ground,
      input: this.input,
      audio: this.audio,
      note: (f, x, z) => this.rules.noteAt(f.id, f.severity, x, z, f.data, 0.5),
    });
    cw.toggleRequested = () => this.craneToggle();
    return cw;
  }

  /** The crane: from driving it to working it, and back (the door key, or the button). */
  private craneToggle(): void {
    const cw = this.crane;
    if (!cw || this.state !== 'drive' || this.walker) return;
    const was = cw.operating;
    if (cw.toggle(this.vehicle, this.input.c.handbrake > 0.5) !== null || was === cw.operating) return;
    this.input.c.handbrake = 1;
    this.cameraMode = 'cockpit';
    this.input.resetLook(false, false);
    this.input.c.lookZoom = cw.operating ? 22 : this.def.zoom;
  }

  /**
   * A step of a crane at work: its controls, the crane and its hook, the
   * loads, the tasks (game/craneplay.ts) – its vehicle stands meanwhile –
   * and the traffic beyond the site.
   */
  private stepCrane(dt: number): void {
    const cw = this.crane as CraneWork;
    // (climbed down from the tower crane: on foot – the crane stands as it was left)
    const w = this.walker;
    if (w) this.stepWalk(dt);
    else cw.work(dt, this.vehicle);
    this.vehicle.getModelPosition(this.mpos);
    this.rules.time += dt;
    this.signals.update(dt);
    const player: PlayerState = w ? { x: w.x, y: w.y, z: w.z, yaw: w.yaw, speed: w.speed, length: 0.6, width: 0.6, onFoot: true } : { x: this.mpos[0], y: this.mpos[1], z: this.mpos[2], yaw: this.vehicle.yaw, speed: 0, length: 0.1, width: 0.1 };
    this.rail.update(dt, player, []);
    this.traffic.obstacles = [];
    this.traffic.update(dt, player);
    if (cw.over) this.finish();
  }

  /** The forklift's work (game/forkliftplay.ts), told what it needs of the game. */
  private makeForkliftWork(site: boolean): ForkliftWork {
    return new ForkliftWork(
      {
      scene: this.app.scene,
      ui: this.ui,
      settings: this.settings,
      yard: this.yardFrame,
      heightAt: (x, z) => this.app.tiles.heightAt(x, z),
      input: this.input,
      audio: this.audio,
      note: (id, severity, x, z, data, cooldown) => this.rules.noteAt(id, severity, x, z, data, cooldown),
      blocked: (x, y, z, yaw) => this.collider.blocked(x, y, z, yaw, 0.02),
      },
      site,
    );
  }

  /** The forklift's drive ends: its work goes, and the camera is the player's own again (not the forklift's view from the side). */
  private endForklift(): void {
    if (!this.forklift) return;
    this.forklift.dispose();
    this.forklift = null;
    this.cameraMode = this.settings.view;
    this.input.resetLook(this.cameraMode === 'chase', false);
  }

  /** The forklift's camera, as chosen with V (game/forkliftplay.ts: from the side at first). */
  private forkView(): void {
    const fw = this.forklift;
    if (!fw) return;
    const cam = forkCamera(fw.view);
    this.cameraMode = cam.mode;
    this.input.resetLook(cam.mode === 'chase', cam.mode === 'free', cam.rest);
    this.fc.ready = false;
    this.camSnap = true;
  }

  /** Off the forklift, beside its seat – or, on foot near it, on again (G, the door button, "Get out"). */
  private forkliftDoor(): void {
    const fw = this.forklift;
    if (!fw || this.state !== 'drive') return;
    const w = this.walker;
    if (w) {
      if (!fw.canBoard(w.x, w.z)) {
        this.tipText = tr('forkTooFar', this.settings.lang);
        this.tipUntil = this.time + 3;
        return;
      }
      this.walker = null;
      this.figure.hide();
      this.forkView();
      this.audio.click('door');
      return;
    }
    const at = fw.getOff();
    if (!at) {
      fw.tell('stopFirst');
      return;
    }
    this.input.c.handbrake = 1;
    this.vehicle.getModelPosition(this.mpos);
    this.leaveOnFoot(at, this.mpos[1]);
  }

  /** Down from the tower crane's cab, beside its base – or, on foot at its foot, up again (G, "Get out"). */
  private towerDoor(): void {
    const cw = this.crane;
    if (!cw || cw.type !== 'tower' || this.state !== 'drive') return;
    const w = this.walker;
    if (w) {
      if (!cw.atTowerFoot(w.x, w.z)) {
        this.tipText = tr('craneTooFar', this.settings.lang);
        this.tipUntil = this.time + 3;
        return;
      }
      this.walker = null;
      this.figure.hide();
      cw.setAway(false);
      this.cameraMode = 'cockpit';
      this.input.resetLook(false, false);
      this.input.c.lookZoom = 22;
      this.camSnap = true;
      this.audio.click('door');
      return;
    }
    this.vehicle.getModelPosition(this.mpos);
    const y0 = this.mpos[1];
    const at = cw.towerExit((x, z) => {
      const y = this.footGround(x, z, y0 + 2);
      return Number.isFinite(y) && !this.collider.circleBlocked(x, y, z, 0.4);
    });
    cw.setAway(true);
    this.leaveOnFoot(at, y0);
  }

  /** On foot here (off the forklift, down from the tower crane): the person's own eyes, the keys and the controls walk. */
  private leaveOnFoot(at: { x: number; z: number; yaw: number }, yRef: number): void {
    const y = this.footGround(at.x, at.z, yRef + 2);
    this.walker = new OnFoot(null, { x: at.x, y: Number.isFinite(y) ? y : yRef, z: at.z, yaw: at.yaw });
    this.walker.runSpeed = this.settings.runSpeed / 3.6;
    this.walkSince = this.time;
    this.cameraMode = 'cockpit';
    this.input.resetLook(false, true);
    this.camSnap = true;
    this.audio.click('door');
  }

  /** A step of the forklift: its own simulation drives it (game/forkliftplay.ts) – and the traffic beyond the yard. */
  private stepForklift(dt: number): void {
    const fw = this.forklift as ForkliftWork;
    // (the operator got off: on foot – the forklift stands as it was left)
    const w = this.walker;
    if (w) this.stepWalk(dt);
    else fw.step(dt, this.vehicle, this.input.c);
    this.vehicle.getModelPosition(this.mpos);
    this.rules.time += dt;
    this.signals.update(dt);
    const player: PlayerState = w ? { x: w.x, y: w.y, z: w.z, yaw: w.yaw, speed: w.speed, length: 0.6, width: 0.6, onFoot: true } : { x: this.mpos[0], y: this.mpos[1], z: this.mpos[2], yaw: this.vehicle.yaw, speed: this.vehicle.speed, length: 3.8, width: 1.2 };
    this.rail.update(dt, player, []);
    this.traffic.obstacles = [];
    this.traffic.update(dt, player);
    if (fw.over) this.finish();
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
  /** the doors, bonnet and boot that open, the car's seats (game/openplay.ts) */
  private readonly opens = new OpenPlay();
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
    const tram = this.tram;
    if (tram) {
      // the tram: its cars in the way, the door of the cab at the front on the right
      const roles = carLayout(tram.v.consist);
      const hw = tram.v.consist.width / 2;
      const units: WalkUnit[] = tram.v.cars.map((c, i) => ({ x: c.x, z: c.z, yaw: c.yaw, front: roles[i].len / 2, rear: roles[i].len / 2, hw, axles: [], track: 0 }));
      return { units, y: tram.v.cars[0].y + 0.3, door: roles[0].len / 2 - 1.4, doorSide: 1, hitch: null };
    }
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
    if (this.walker || this.doorT >= 0 || this.opens.busy || this.demo?.active || this.task) return;
    if (this.aircraft) {
      this.leavePlane();
      return;
    }
    if (this.tram) {
      // out of the tram's cab: it stands braked meanwhile (the passengers' doors as they are)
      if (this.tram.speed > 0.1 || this.tramAuto) return;
      this.walkStart = false;
      this.startDoor('out');
      return;
    }
    if (Math.abs(v.speed) > 0.3) {
      this.tipText = tr('stopFirst', lang);
      this.tipUntil = this.time + 3;
      return;
    }
    if (this.model === this.car && this.opens.passenger) {
      // a passenger: out through the door of that seat (what the driver has to see to is not the passenger's)
      this.walkStart = false;
      this.opens.beginOut();
      return;
    }
    v.getModelPosition(this.mpos);
    const x = this.mpos[0];
    const z = this.mpos[2];
    // (a motorcycle has no parking brake to set: the engine off is enough)
    if (!this.settings.arcadeDrive && ((c.handbrake < 0.5 && this.def.doorSide !== 0) || v.engineRunning)) this.rules.noteAt('notSecured', 'minor', x, z);
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
    // (the car: its door opens, no fade – game/openplay.ts)
    if (this.model === this.car) this.opens.beginOut();
    else this.startDoor('out');
  }

  /** In again: from beside the driver's door. */
  private getIn(): void {
    const w = this.walker;
    const lang = this.settings.lang;
    if (!w || this.doorT >= 0 || this.opens.busy) return;
    if (this.model === this.car) {
      // the car: into the seat of the door one stands at (at the bonnet or the boot: open or shut it)
      const at = this.opens.at(w);
      if (at && !isDoor(at.id)) {
        this.opens.toggleAt(w);
        return;
      }
      if (!at || !isDoor(at.id)) {
        this.tipText = tr('toDoor', lang);
        this.tipUntil = this.time + 3;
        return;
      }
      if (at.id === 'fl' && this.walkStart && !w.allChecked) this.rules.noteAt('preCheck', 'hint', this.mpos[0], this.mpos[2], { missing: new Intl.ListFormat(localeOf(lang), { style: 'long', type: 'conjunction' }).format(w.missing().map((id) => tr(CHECK_TEXT[id], lang))) }, 30);
      this.opens.beginIn(at.id);
      return;
    }
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
  /**
   * The vehicle hit a building at speed: a blast, and it is gone.  The
   * driver stands a few steps back from where it was, on foot; the drive
   * goes on (a lesson or an exam ends with it).
   */
  private explode(): void {
    const v = this.vehicle;
    v.getModelPosition(this.mpos);
    const [x, y, z] = [this.mpos[0], this.mpos[1], this.mpos[2]];
    const yaw = v.yaw;
    this.wrecked = true;
    if (this.demo) this.endDemo('ended');
    const paint = this.model === this.car ? this.car.exterior.paint.color.getHex() : 0x9aa3ad;
    this.explosion.start(x, y, z, paint, (px, pz) => this.footGround(px, pz, y + 2));
    const ctx = this.audio.context;
    const out = this.audio.masterGain;
    if (ctx && out) playBoom(ctx, out, 1);
    else this.audio.click('crash');
    // the wreck is gone: what is left of the vehicle is put out of the way, deep under the ground, and not stepped any more
    v.teleport(x, y - 400, z, yaw);
    v.resetDrivetrain(false);
    if (this.trailer?.coupled) this.trailer.coupleBehind(v);
    const c = this.input.c;
    c.handbrake = 1;
    c.throttle = 0;
    c.brake = 0;
    // the driver, unhurt, a few steps back the way the vehicle came – with no vehicle to walk round or get into
    this.parkedSteer = 0;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const wx = x - fx * 9;
    const wz = z - fz * 9;
    this.walker = new OnFoot(null, { x: wx, y: this.footGround(wx, wz, y + 2), z: wz, yaw });
    if (this.model instanceof PlayerBike) this.model.setRider(false);
    this.walkSince = this.time;
    this.input.resetLook(false, true);
    this.markers.hide();
    this.cameraMode = 'cockpit';
    this.camSnap = true;
    this.hud.setWrecked(true);
    this.tipText = tr('wrecked', this.settings.lang);
    this.tipUntil = this.time + 6;
    // (in a lesson or an exam that is the end of it)
    if (this.lesson && this.failT < 0) this.failT = this.time + 4;
  }

  /**
   * Out of the aeroplane: standing on the ground, beside it (it stays where it
   * is, and the door key gets one back in); in the air, down to the ground
   * below – the aeroplane is gone, and a new one waits at the nearest runway.
   */
  private leavePlane(): void {
    const a = this.aircraft as Aircraft;
    const lang = this.settings.lang;
    if (a.onGround && a.ias > 1.5) {
      this.tipText = tr('stopFirst', lang);
      this.tipUntil = this.time + 3;
      return;
    }
    if (this.flightAuto.engaged) this.flightAuto.off();
    const yaw = a.yaw;
    let x = a.pos.x;
    let z = a.pos.z;
    if (a.onGround) {
      // beside the left door, clear of the wing strut
      x -= Math.cos(yaw) * 3.2;
      z += Math.sin(yaw) * 3.2;
      this.flight.throttle = 0;
    } else {
      // in the air: down on the ground below – the aeroplane does not fly on without its pilot
      this.wrecked = true;
      this.aircraft = null;
      this.vehicle.teleport(x, a.pos.y - 400, z, yaw);
      this.hud.setWrecked(true);
      this.ui.classList.remove('flying');
      this.tipText = tr('planeLeft', lang);
      this.tipUntil = this.time + 6;
    }
    this.walker = new OnFoot(null, { x, y: this.footGround(x, z, a.pos.y + 2), z, yaw });
    this.walker.runSpeed = this.settings.runSpeed / 3.6;
    this.walkSince = this.time;
    this.cameraMode = 'cockpit';
    this.input.resetLook(false, true);
    this.camSnap = true;
  }

  /** Back into the aeroplane parked near by (within a few metres of it). */
  private boardPlane(): void {
    const a = this.aircraft;
    const w = this.walker;
    if (!a || !w) return;
    if (Math.hypot(w.x - a.pos.x, w.z - a.pos.z) > 7) {
      this.tipText = tr('planeTooFar', this.settings.lang);
      this.tipUntil = this.time + 3;
      return;
    }
    this.walker = null;
    this.figure.hide();
    this.cameraMode = 'cockpit';
    this.input.resetLook(false, false);
    this.camSnap = true;
  }

  /**
   * Another vehicle, here and now: a free drive with it begins where the
   * player is (the world stays loaded) – the tram at the nearest stop, the
   * aeroplane at the end of the nearest runway.
   */
  private changeVehicle(kind: VehicleKind): void {
    if (this.lesson || (this.state !== 'pause' && this.state !== 'drive')) return;
    const w = this.walker;
    const x = w ? w.x : this.mpos[0];
    const z = w ? w.z : this.mpos[2];
    this.endWatch(false);
    if (this.demo) this.endDemo('ended');
    this.settings.vehicle = kind;
    saveSettings(this.settings);
    const k = VEHICLES[kind]?.kind;
    if (k === 'tram') this.begin('free', 0, true, undefined, { name: '', town: '', x, z });
    else if (k === 'plane') {
      const near = this.air ? landingRunway(this.air.airfields, x, z, 300) : null;
      const r = near ? { field: near.field.name, end: runwayEnd(near.runway, near.fromSecond), ...runwayStart(near.runway, near.fromSecond) } : undefined;
      this.begin('free', 0, true, undefined, undefined, r);
    } else this.begin('free', 0, true, { label: tr('mapPlace', this.settings.lang), street: '', x, z, exact: false });
  }

  // ------------------------------------------------- a car here, places chosen precisely (game/spawncar.ts)
  /** the cars put down on the map, the vehicle left standing, the button and the taps for them */
  private spawnCars!: SpawnCars;
  /** the drive begins in a parked vehicle: where it stands (begin), the player in it rather than beside it (tryPlace) */
  private parkedAt: { x: number; z: number; yaw: number } | null = null;
  private intoParked = false;

  private makeSpawnCars(): SpawnCars {
    const app = this.app;
    return new SpawnCars({
      scene: app.scene,
      camera: app.camera,
      canvas: app.canvas,
      ui: this.ui,
      collider: this.collider,
      heightAt: (x, z) => app.tiles.heightAt(x, z),
      ground: (x, z) => {
        const ty = app.tiles.heightAt(x, z);
        return app.world.surfaceAt(x, z, ty + 3, this.hit) ? this.hit.y : ty;
      },
      canSpawn: () => this.canSpawnCar(),
      canEnter: () => this.canEnterParked(),
      player: () => {
        const w = this.walker;
        if (w) return { x: w.x, z: w.z, yaw: w.yaw };
        this.vehicle.getModelPosition(this.mpos);
        return { x: this.mpos[0], z: this.mpos[2], yaw: this.vehicle.yaw };
      },
      others: () => {
        const out: Array<{ x: number; z: number; r: number }> = [];
        const w = this.walker;
        if (w) out.push({ x: w.x, z: w.z, r: 0.5 });
        if (this.state === 'drive' && !this.wrecked && !this.tram) {
          if (this.aircraft) out.push({ x: this.aircraft.pos.x, z: this.aircraft.pos.z, r: 6 });
          else {
            // (the player's vehicle: its circles along its axis, as the collider has them)
            this.vehicle.getModelPosition(this.mpos);
            const s = Math.sin(this.vehicle.yaw);
            const c = Math.cos(this.vehicle.yaw);
            for (const o of this.def.circles) out.push({ x: this.mpos[0] + s * o, z: this.mpos[2] + c * o, r: this.def.radius });
          }
        }
        return out;
      },
      roadSpot: (x, z, d) => (app.map.ready(x, z, d + 60) ? findRoadSpot(app.world, this.lanes, x, z, '', d, this.usableLane()) : null),
      exact: () => this.settings.placeExact,
      paint: () => this.car.exterior.paint.color.getHex(),
      carOutline: VEHICLES.car.outline,
      enter: (p) => this.enterParked(p),
      tip: (text) => {
        this.tipText = text;
        this.tipUntil = this.time + 5;
      },
      t: (k) => tr(k, this.settings.lang),
    });
  }

  /** May a car be put down now: on foot, or at the controls of a crane – in a free drive (`fromMap`: the large map opened from it). */
  private canSpawnCar(fromMap = false): boolean {
    if (!(fromMap ? this.state === 'map' && this.mapFrom !== 'menu' : this.state === 'drive') || this.lesson || this.task || this.demo?.active || this.watcher || this.forklift || this.showOn) return false;
    return (!!this.walker && !this.riding && !this.busRide) || !!this.crane?.operating;
  }

  /** May the player get into a parked vehicle now: on foot, at a crane, or standing still in a vehicle – in a free drive. */
  private canEnterParked(): boolean {
    if (this.state !== 'drive' || this.lesson || this.task || this.demo?.active || this.watcher || this.doorT >= 0 || this.opens.busy || this.riding || this.busRide) return false;
    if (this.walker || this.crane?.operating) return true;
    return !this.aircraft && !this.tram && !this.forklift && Math.abs(this.vehicle.speed) < 0.5;
  }

  /**
   * Into a vehicle parked on the map (the car put down, or the vehicle left
   * before): a free drive with it begins where it stands – the vehicle driven
   * till now stays where it is (not a wreck, a tram, the aeroplane, the
   * forklift, nor a combination with a trailer: those go, as before).
   */
  private enterParked(p: Parked): void {
    if (!this.canEnterParked()) return;
    const def = this.def;
    this.vehicle.getModelPosition(this.mpos);
    const stays = !this.wrecked && !this.aircraft && !this.tram && def.kind !== 'pedestrian' && def.kind !== 'forklift' && !def.trailer;
    const height = def.model === 'car' || def.model === 'motorcycle' ? 1.6 : 3.6;
    this.spawnCars.swap(p, stays ? { kind: this.settings.vehicle, x: this.mpos[0], y: this.mpos[1], z: this.mpos[2], yaw: this.vehicle.yaw, outline: def.outline, height, root: def.model === 'car' ? null : this.model.root } : null);
    this.endWatch(false);
    if (this.demo) this.endDemo('ended');
    this.settings.vehicle = p.kind;
    saveSettings(this.settings);
    this.parkedAt = { x: p.x, z: p.z, yaw: p.yaw };
    this.intoParked = true;
    this.begin('free', 0, true, { label: tr('mapPlace', this.settings.lang), street: '', x: p.x, z: p.z, exact: true });
  }

  /** A start place exactly at (x, z) ("place precisely"): fitted to the ground and the vehicle once it is loaded (tryPlace). */
  private exactSpot(name: string, x: number, z: number): SpawnJson {
    const s: SpawnJson = { name, x, z, yaw: 0, kind: 'street' };
    exactSpots.add(s);
    return s;
  }

  /** Where a drive at an address or a place chosen begins: in front of it on the road – or, "place precisely", at the very place. */
  private startSpot(hit: AddressHit): SpawnJson | null {
    return this.settings.placeExact ? this.exactSpot(hit.label, hit.x, hit.z) : this.spawnAt(hit);
  }

  /** A place chosen precisely, made fit: facing along the road nearest (if one is near), and if it is not free, the nearest free place round it. */
  private fitExact(sp: { x: number; z: number; yaw: number }, o: VehicleDef['outline']): { x: number; z: number; yaw: number } {
    const road = findRoadSpot(this.app.world, this.lanes, sp.x, sp.z, '', 30, this.usableLane());
    const yaw = road?.yaw ?? sp.yaw;
    return freeNear(sp.x, sp.z, yaw, (x, z, y) => this.spawnCars.free(x, z, y, o, false), 40) ?? { x: sp.x, z: sp.z, yaw };
  }

  /**
   * Where the vehicle behind the main menu stands: where the drive would
   * begin – at an address or a place chosen, in the lane of the road in front
   * of it (or, "place precisely", at the very place) – facing along the road,
   * clear of walls and outside the buildings.  The tram, the aeroplane and
   * the cranes have places of their own (the forklift's free drive begins
   * where the others' do – its work on the yard is a way to play of its own).
   */
  private menuSpot(p: MenuPreview): { x: number; z: number; yaw: number } {
    const def = VEHICLES[p.kind] ?? VEHICLES.car;
    if (def.kind === 'tram' || def.kind === 'plane' || def.crane) return p;
    const a = this.settings.lastStart.address;
    const chosen = !!a && Math.abs(a.x - p.x) < 0.01 && Math.abs(a.z - p.z) < 0.01;
    const o = def.outline;
    if (chosen && this.settings.placeExact) return this.fitExact(p, o);
    const ok = (x: number, z: number, yaw: number): boolean => this.spawnCars.free(x, z, yaw, o, false);
    const at = (chosen ? findRoadSpot(this.app.world, this.lanes, p.x, p.z, a?.street ?? '', 220, this.usableLane()) : null) ?? p;
    if (ok(at.x, at.z, at.yaw)) return at;
    const lane = this.freeSpot(at.x, at.z, at.yaw, 0);
    if (lane && ok(lane.x, lane.z, lane.yaw)) return lane;
    return freeNear(at.x, at.z, at.yaw, ok, 40) ?? at;
  }

  /**
   * "Start where I am" (a setting): once, when the game starts, the browser
   * is asked where the player is – on the map, the drive is to begin there
   * (the main menu shows the vehicle there).
   */
  private startWhereIAm(): void {
    if (!this.settings.startHere) return;
    void locate(this.app.world.json.meta).then((r) => {
      const lang = this.settings.lang;
      if (!r.ok) {
        this.hud.message(tr(r.why === 'outside' ? 'myLocationOutside' : r.why === 'denied' ? 'myLocationDenied' : 'myLocationNone', lang));
        return;
      }
      if (this.state !== 'menu') return;
      this.hud.menuStartAt({ name: tr('myLocation', lang), x: r.x, z: r.z, yaw: 0, kind: 'street' });
      this.hud.redrawMenu();
    });
  }

  /** A new vehicle of the same kind, in the lane nearest to the person on foot – and the person in it. */
  private newVehicle(): void {
    const w = this.walker;
    if (!this.wrecked) return;
    if (this.def.kind === 'plane') {
      // a new aeroplane at the end of the runway nearest to where the person stands
      const near = w && this.air ? landingRunway(this.air.airfields, w.x, w.z, 300) : null;
      const r = near ? { field: near.field.name, end: runwayEnd(near.runway, near.fromSecond), ...runwayStart(near.runway, near.fromSecond) } : this.firstRunway();
      if (!r) return;
      this.wrecked = false;
      this.explosion.clear();
      this.hud.setWrecked(false);
      if (this.walker) this.leaveWalk();
      this.spawn = { name: `${r.field} ${r.end}`, x: r.x, z: r.z, yaw: r.yaw, kind: 'street' };
      this.planePending = true;
      this.keepClock = true;
      this.state = 'placing';
      this.hud.showLoading(tr('loadingTiles', this.settings.lang));
      return;
    }
    const g = this.lastGood;
    const spot = (w && this.freeSpot(w.x, w.z, w.yaw, 0)) ?? this.freeSpot(g.x, g.z, g.yaw, 0) ?? g;
    this.wrecked = false;
    this.explosion.clear();
    this.hud.setWrecked(false);
    if (this.walker) this.leaveWalk();
    this.putOnRoad(spot);
    this.vehicle.resetDrivetrain(true);
    const c = this.input.c;
    c.handbrake = 1;
    c.ignition = true;
    c.seatbelt = true;
    c.gear = 0;
    this.camSnap = true;
    this.audio.click('chime');
  }

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
    const wv = this.walkVehicle();
    const w = new OnFoot(wv);
    // (where its parts open; out of the car through another door: beside that one)
    this.opens.walk(w, wv, this.model === this.car ? this.car : null, this.model instanceof PlayerTruck);
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
    this.figure.hide();
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

  /** The parts that open, and getting into the car or out of it: the door opens, one moves, the door shuts (game/openplay.ts). */
  private stepOpen(dt: number): void {
    const car = this.model === this.car ? this.car : null;
    const r = this.opens.step(dt, (k) => this.audio.click(k));
    const b = this.opens.board;
    if (r.start && b) {
      // the camera goes from where it is to the seat, or to the place beside the door
      this.doorFrom.pos.copy(this.app.camera.position);
      this.doorFrom.quat.copy(this.app.camera.quaternion);
      if (b.way === 'in') {
        this.leaveWalk();
        this.opens.setSeat(car, b.seat);
      } else this.enterWalk();
    }
    const model = this.model;
    const trailer = !this.def.trailer ? null : this.def.model === 'truck' ? (this.truck?.trailer ?? null) : (this.carTrailer?.group ?? null);
    this.opens.pose(car, model instanceof PlayerTruck ? model : null, trailer);
  }

  /**
   * Sign posts that stand on a carriageway where no lane runs (between lanes,
   * a road without lanes of its own – faults of the map the lanes do not
   * see): moved beside it, on their side – onto the pavement, or just beyond
   * the edge where there is none.  Posts in a junction stay (its corners).
   */
  private signsBesideRoad(signs: SignPost[]): void {
    const world = this.app.world;
    const hit = this.hit;
    for (const p of signs) {
      if (!world.surfaceAt(p.x, p.z, p.y + 1.5, hit) || hit.zone !== 0 || !hit.edge || hit.node) continue;
      const e = hit.edge;
      const side = hit.off >= 0 ? 1 : -1;
      const sw = side > 0 ? e.swL : e.swR;
      const out = e.width / 2 + (sw > 0 ? 0.55 : 0.9);
      samplePolyline(e.pl, hit.s, this.smp);
      // (left of the direction (tx, tz) is (tz, −tx))
      p.x = this.smp.x + this.smp.tz * out * side;
      p.z = this.smp.z - this.smp.tx * out * side;
      const y = this.footGround(p.x, p.z, p.y + 1.5);
      if (Number.isFinite(y)) p.y = y;
    }
  }

  /** The height to stand on: the road or pavement there, else the ground. */
  private footGround(x: number, z: number, yRef: number): number {
    return this.app.world.surfaceAt(x, z, yRef, this.hit) ? this.hit.y : this.app.tiles.heightAt(x, z);
  }

  // ------------------------------------------------- ways of walking, the flying camera, a tap to teleport (1.7.0)
  // (game/walkmodes.ts, game/flycam.ts, ui/touchstick.ts, ui/worldtap.ts)
  private readonly walkCtl = new WalkControl();
  private readonly fly = new FlyCam();
  private touchStick: TouchStick | null = null;
  private worldTap: WorldTap | null = null;
  /** the parts of map-assets in memory (developer mode, settings: devMap) – null while off */
  private parts: PartCache | null = null;
  /** which tiles ever had several versions (from the index) – where the corner label may show */
  private versioned: Set<string> = new Set();
  /** the index of map-assets, read once on load (the update check of Module H) */
  private partIndex: PartIndex | null = null;
  /** the tile the corner label is for now ('' = none) */
  private labelTile = '';
  /** the versions chosen for "next time": tile -> the part to prefer on the next drive into its region */
  private pendingParts = new Map<string, number>();
  /** the vehicle stands still – its physics not stepped – while the flying camera is far from it, and till the world round it is loaded again */
  private flyParked = false;

  /** The free camera flies, apart from the vehicle (not from the aeroplane, the tram or the forklift, nor on foot or watching: there it goes with them as before). */
  private flyFree(): boolean {
    return this.cameraMode === 'free' && this.state === 'drive' && !this.walker && !this.watcher && !this.aircraft && !this.tram && !this.forklift && !this.crane?.operating && this.doorT < 0;
  }

  /** Each picture: the stick on the screen, the button offered after a tap on the picture, the keys of the flying camera. */
  private footFlyFrame(): void {
    const app = this.app;
    this.touchStick ??= new TouchStick(this.ui, this.input, (k) => tr(k, this.settings.lang));
    this.worldTap ??= new WorldTap({
      canvas: app.canvas,
      camera: app.camera,
      ui: this.ui,
      heightAt: (x, z) => app.tiles.heightAt(x, z),
      allowed: () => this.canTeleport(),
      canDrive: () => this.canDrive(),
      claimed: (cx, cy, down) => (down ? !!this.spawnCars?.picking : !!this.screenTap?.covers(cx, cy) || !!this.spawnCars?.claims(cx, cy)),
      tapped: (p) => this.tapToWalk(p.x, p.z),
      teleport: (p, yaw) => this.teleportHere(p.x, p.y, p.z, yaw),
      drive: (p) => this.driveHere(p.x, p.z),
      t: (k) => tr(k, this.settings.lang),
    });
    const fly = this.flyFree();
    this.input.flyCam = fly;
    // (the free camera begins anew – where the camera is – each time it is chosen)
    if (this.cameraMode !== 'free') this.fly.ready = false;
    const w = this.walker;
    const touch = this.inputMode === 'touch' && this.state === 'drive';
    const walking = !!w && !this.riding && !this.busRide && this.doorT < 0 && walkModeOf(this.settings.walkControls, true) !== 'tank';
    if (!w) this.walkCtl.cancel();
    this.touchStick.frame(touch ? (walking ? 'walk' : fly ? 'fly' : null) : null);
    this.worldTap.frame();
    this.tileVersionsFrame();
  }

  /**
   * Every picture: the corner label that the tile under the player has several
   * versions (developer mode).  It shows only on a tile that ever had one, and
   * only while the developer mode is on.
   */
  private tileVersionsFrame(): void {
    if (!this.settings.devMap || !this.parts || !this.partIndex) {
      this.hud.setTileVersions('', []);
      this.labelTile = '';
      return;
    }
    const key = tileKey(gridIndex(this.mpos[0], TILE), gridIndex(this.mpos[2], TILE));
    if (key === this.labelTile) return;
    this.labelTile = key;
    if (!this.versioned.has(key)) {
      this.hud.setTileVersions('', []);
      return;
    }
    // the loaded part of this tile: whichever the cache would pick now
    const loaded = this.loadedPartOf(key);
    const versions = versionsOfTile(this.partIndex, key, loaded).map((v) => ({ label: v.label, loaded: v.loaded, n: v.n }));
    this.hud.setTileVersions(key, versions);
  }

  /** The part of a tile that is loaded now, or null (nothing held). */
  private loadedPartOf(key: string): number | null {
    if (!this.parts || !this.partIndex) return null;
    const holders = this.partIndex.files.filter((f) => (f.tiles ?? []).includes(key));
    if (holders.length === 0) return null;
    const held = this.parts.heldParts();
    for (let i = holders.length - 1; i >= 0; i--) if (held.includes(holders[i].n)) return holders[i].n;
    return null;
  }

  /** The flying camera (game/flycam.ts): from where the camera was – or from behind the vehicle – wherever it is flown. */
  private flyCamera(cam: THREE.PerspectiveCamera, dt: number): void {
    cam.near = 0.3;
    cam.fov = 55;
    const fl = this.fly;
    const t = this.input.takeCam();
    const car = this.model.root.position;
    if (!fl.ready && cam.position.distanceTo(car) > 2.5 && cam.position.distanceTo(car) < 400) {
      const dir = cam.getWorldDirection(this.tmpV);
      fl.start(cam.position.x, cam.position.y, cam.position.z, dir.x, dir.y, dir.z);
    }
    if (!fl.ready || t.reset) {
      // (from the driver's seat, or a double click: behind the vehicle, a little above it, looking along it)
      const yaw = this.vehicle.yaw;
      const back = this.def.long ? 20 : 8;
      const p = -0.28;
      fl.start(car.x + Math.sin(yaw) * back, car.y + (this.def.long ? 7 : 3.2), car.z + Math.cos(yaw) * back, -Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p));
    }
    if (fl.update(dt, t, (x, z) => this.app.tiles.heightAt(x, z))) this.touchStick?.badge(tr('fly.speed', this.settings.lang, { v: Math.round(fl.speed * 3.6) }));
    cam.position.set(fl.x, fl.y, fl.z);
    cam.quaternion.setFromEuler(new THREE.Euler(fl.pitch, fl.yaw, 0, 'YXZ'));
    this.camSnap = false;
  }

  /** Is the vehicle to stand still for the flying camera (see flyParked)? */
  private flyHold(): boolean {
    const d = Math.hypot(this.fly.x - this.mpos[0], this.fly.z - this.mpos[2]);
    const far = this.flyFree() && this.fly.ready && ((Math.abs(this.vehicle.speed) < 0.5 && d > 250) || d > 600);
    if (far) this.flyParked = true;
    else if (this.flyParked && !Number.isNaN(this.app.tiles.heightAt(this.mpos[0], this.mpos[2])) && this.app.map.ready(this.mpos[0], this.mpos[2], 60)) this.flyParked = false;
    return this.flyParked;
  }

  /** May the player be teleported now (ui/worldtap.ts)?  In a drive of one's own, in a vehicle on the road or on foot. */
  private canTeleport(): boolean {
    if (!this.settings.teleportTap || this.state !== 'drive' || this.lesson || this.task || this.demo?.active || this.watcher || this.showOn) return false;
    if (this.doorT >= 0 || this.opens.busy || this.riding || this.busRide || this.wrecked) return false;
    if (this.walker) return true;
    return !this.aircraft && !this.tram && !this.forklift && !this.crane?.operating;
  }

  /**
   * May the vehicle be sent off to a place tapped on the picture (ui/worldtap.ts "Drive there")?
   * The same as canTeleport, but for what can drive itself: the aeroplane flies there, a tram,
   * a forklift and a crane never do.  On foot it is allowed too – startTrip puts the walker
   * back into the seat first.
   */
  private canDrive(): boolean {
    if (!this.settings.teleportTap || this.state !== 'drive' || this.lesson || this.task || this.demo?.active || this.watcher || this.showOn) return false;
    if (this.doorT >= 0 || this.opens.busy || this.riding || this.busRide || this.wrecked) return false;
    if (this.walker) return true;
    return !this.tram && !this.forklift && !this.crane?.operating;
  }

  /** "Teleport here": somebody on foot to that very place; a vehicle into the lane of the road nearest it, facing along it (the way the camera looked, where it may). */
  private teleportHere(x: number, y: number, z: number, yaw: number): void {
    if (!this.canTeleport()) return;
    const w = this.walker;
    if (w) {
      const gy = this.footGround(x, z, y + 1.5);
      if (!Number.isFinite(gy)) return;
      this.walkCtl.cancel();
      w.x = x;
      w.y = gy;
      w.z = z;
      this.camSnap = true;
      return;
    }
    let spot = this.freeSpot(x, z, yaw, 0);
    if (!spot || Math.hypot(spot.x - x, spot.z - z) > 30) {
      // (no lane within a few metres: the road nearest within 150 m)
      const road = this.roadSpot(x, z, '', 150);
      spot = road && !road.rough ? (this.freeSpot(road.x, road.z, road.yaw, 0) ?? { x: road.x, y: this.footGround(road.x, road.z, this.app.tiles.heightAt(road.x, road.z) + 3), z: road.z, yaw: road.yaw }) : null;
    }
    if (!spot || !Number.isFinite(spot.y)) {
      this.tipText = tr('teleportNoRoad', this.settings.lang);
      this.tipUntil = this.time + 4;
      return;
    }
    this.putOnRoad(spot);
    this.path.breakLine();
    this.camSnap = true;
  }

  /**
   * "Drive there" (ui/worldtap.ts): the vehicle drives to the place tapped on the picture by
   * itself, the way the big map's "drive there" does (startTrip).  The aeroplane flies there
   * and circles it; a car or a lorry goes to the nearest road there.  Takes over again at
   * once as ever: a pedal or the wheel brings the player back.
   */
  private driveHere(x: number, z: number): void {
    if (!this.canDrive()) return;
    const lang = this.settings.lang;
    if (this.aircraft) {
      // (the aeroplane needs no road: startTrip flies it there and circles the place)
      this.startTrip([{ name: '', x, z, yaw: 0, kind: 'street' }], false, null);
      return;
    }
    const road = this.roadSpot(x, z, '', 150);
    if (!road) {
      this.tipText = tr('teleportNoRoad', lang);
      this.tipUntil = this.time + 4;
      return;
    }
    this.startTrip([{ name: '', x: road.x, z: road.z, yaw: road.yaw, kind: 'street' }], false, null);
  }

  /** Turn the vehicle round (input action 'turn'): into the lane of the other direction where there is one. */
  private turnAround(): void {
    if (!this.canTurnAround()) return;
    const v = this.vehicle;
    v.getModelPosition(this.mpos);
    const here = { x: this.mpos[0], y: this.mpos[1], z: this.mpos[2], yaw: v.yaw };
    // (the lane the other way round, where there is one – else the vehicle turns where it stands)
    const spot = turnedSpot(here, this.freeSpot(here.x, here.z, here.yaw + Math.PI, 0));
    this.putOnRoad(spot);
    this.path.breakLine();
    this.camSnap = true;
    this.audio.click('tick');
  }

  /** May the vehicle be turned round now (input action 'turn', F3)?  A road vehicle while driving. */
  private canTurnAround(): boolean {
    if (this.state !== 'drive' || this.lesson || this.task || this.demo?.active || this.watcher || this.showOn) return false;
    if (this.doorT >= 0 || this.opens.busy || this.riding || this.busRide) return false;
    // not on foot, and not in what is driven by hand or by an operator: the aeroplane, the tram, the forklift, the crane
    return !this.walker && !this.aircraft && !this.tram && !this.forklift && !this.crane;
  }

  /** Tap to walk (game/walkmodes.ts): off to the place tapped, along the pavements of the roads round there. */
  private tapToWalk(x: number, z: number): void {
    const w = this.walker;
    if (!w || this.riding || this.busRide || this.state !== 'drive' || this.doorT >= 0) return;
    if (walkModeOf(this.settings.walkControls, this.inputMode === 'touch') !== 'tap' || Math.hypot(x - w.x, z - w.z) > 400) return;
    const roads: FootRoad[] = [];
    this.app.world.edgesInBox(Math.min(x, w.x) - 30, Math.min(z, w.z) - 30, Math.max(x, w.x) + 30, Math.max(z, w.z) + 30, (e) => {
      if (!LaneGraph.drivable(e, false)) return;
      roads.push({ pl: e.pl, half: e.width / 2, swL: e.swL, swR: e.swR, xings: e.xings.filter((c) => c.k === XING.SIGNAL || c.k === XING.ZEBRA).map((c) => c.s) });
    });
    this.walkCtl.goTo(planFootPath(w.x, w.z, x, z, roads));
  }

  private stepWalk(dt: number): void {
    const w = this.walker;
    if (!w) return;
    const look = this.input.takeCam();
    // (the way of walking chosen in the settings, a way being walked after a tap: game/walkmodes.ts)
    const mode = walkModeOf(this.settings.walkControls, this.inputMode === 'touch');
    const move = this.walkCtl.step(dt, this.input.walkInput(mode), w, look.yaw !== 0 || look.pitch !== 0);
    if (this.walkCtl.blocked) {
      this.walkCtl.blocked = false;
      this.tipText = tr('walk.blocked', this.settings.lang);
      this.tipUntil = this.time + 3;
    }
    const r = w.update(dt, move, look, (x, z, yRef) => this.footGround(x, z, yRef), (x, y, z, rad) => this.collider.circleBlocked(x, y, z, rad));
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
  /** a drive on foot that begins at a stop: the walker turns to its departure board once the stop is built (until: game time to give up) */
  private boardStart: { x: number; z: number; until: number } | null = null;

  /**
   * Live location: the walker follows where the player really is (the
   * browser's geolocation, asked once) – walking to each new fix, jumping
   * when it is far. (Finer steps between fixes from the motion sensors would
   * need a native app: see the README.)
   */
  private liveGeo: { watch: number; target: { x: number; z: number } | null; heading: number } | null = null;

  private toggleLiveGeo(): void {
    const lang = this.settings.lang;
    if (this.liveGeo) {
      navigator.geolocation?.clearWatch(this.liveGeo.watch);
      this.liveGeo = null;
      this.hud.message(tr('liveLocationStopped', lang));
      return;
    }
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
    if (!geo || !this.walker) {
      this.hud.message(tr('myLocationNone', lang));
      return;
    }
    const meta = this.app.world.json.meta;
    const state: { watch: number; target: { x: number; z: number } | null; heading: number } = { watch: -1, target: null, heading: NaN };
    state.watch = geo.watchPosition(
      (p) => {
        const [x, z] = latLonToWorld(p.coords.latitude, p.coords.longitude);
        if (x < meta.minX || x > meta.maxX || z < meta.minZ || z > meta.maxZ) {
          this.hud.message(tr('myLocationOutside', this.settings.lang));
          return;
        }
        state.target = { x, z };
        // (the compass heading of the device's movement: north 0, clockwise – the game's yaw turns the other way)
        if (p.coords.heading !== null && Number.isFinite(p.coords.heading) && (p.coords.speed ?? 0) > 0.5) state.heading = (-p.coords.heading * Math.PI) / 180;
      },
      (e) => this.hud.message(tr(e.code === 1 ? 'myLocationDenied' : 'myLocationNone', this.settings.lang)),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
    this.liveGeo = state;
    this.hud.message(tr('liveLocationStarted', lang));
  }

  private stepLiveGeo(dt: number): void {
    const g = this.liveGeo;
    const w = this.walker;
    if (!g || !w || !g.target) return;
    const dx = g.target.x - w.x;
    const dz = g.target.z - w.z;
    const d = Math.hypot(dx, dz);
    if (d > 80) {
      // far (the first fix, or a jump): there at once
      w.x = g.target.x;
      w.z = g.target.z;
      this.camSnap = true;
    } else if (d > 0.3) {
      // near: walking there, a little faster than walking when behind
      const step = Math.min(d, dt * Math.max(1.4, d * 0.8));
      w.x += (dx / d) * step;
      w.z += (dz / d) * step;
      w.yaw = Number.isFinite(g.heading) ? g.heading : Math.atan2(-dx, -dz);
    }
    w.y = this.footGround(w.x, w.z, w.y + 2);
  }

  /** On foot at the start stop: stand before its departure board, looking at it (once the stop is built, within 20 s). */
  private faceBoard(): void {
    const b = this.boardStart;
    const w = this.walker;
    if (!b || !w) return;
    if (b.until < 0) b.until = this.time + 20;
    if (this.time > b.until) {
      this.boardStart = null;
      return;
    }
    const board = this.transit.boardNear(b.x, b.z, 90);
    if (!board) return;
    this.boardStart = null;
    // a few steps from the board, on the side the walker came from – where there is room
    let dx = w.x - board.x;
    let dz = w.z - board.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    for (const d of [4, 3, 5, 2.5, 6]) {
      const px = board.x + dx * d;
      const pz = board.z + dz * d;
      const y = this.footGround(px, pz, w.y + 2);
      const road = this.app.world.surfaceAt(px, pz, w.y + 2, this.hit) && this.hit.zone === 0;
      if (!road && Number.isFinite(y) && !this.collider.circleBlocked(px, y, pz, 0.35)) {
        w.x = px;
        w.z = pz;
        w.y = y;
        break;
      }
    }
    w.yaw = Math.atan2(-(board.x - w.x), -(board.z - w.z));
    this.input.resetLook(false, true);
    this.camSnap = true;
  }

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
    // (and the crowd of a march on its street)
    this.roadEvents.railBlocks(others);
    this.rail.update(dt, player, others);
    const boxes = this.railBoxes;
    boxes.length = 0;
    for (const rv of this.rail.vehicles) rv.cars.forEach((rc, i) => boxes.push({ x: rc.x, y: rc.y, z: rc.z, yaw: rc.yaw, speed: rv.speed, length: carLayout(rv.consist)[i].len, width: rv.consist.width }));
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
        if (Math.abs(ahead) < carLayout(rv.consist)[i].len / 2 - 0.6 && Math.abs(right) > hw - 0.2 && Math.abs(right) < hw + 2.2) return { v: rv, car: i, side: Math.sign(right) };
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
    this.flightAuto.off();
    this.flightAssist.reset(this.flight.trim);
    this.flightTake = 0;
    // the demonstration flight chosen in the menu: from this runway round the field (or the sights) and down again
    if (this.planeDemoPending) {
      this.planeDemoPending = false;
      const r = this.air ? runwayAt(this.air.airfields, sp.x, sp.z, sp.yaw) : null;
      if (r) {
        this.flightAuto.demo(r.runway, r.fromSecond);
        this.hud.message(tr('apOn', this.settings.lang));
      }
    }
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
    const ground = this.airGround ?? this.ground;
    const ap = this.flightAuto;
    if (ap.engaged) {
      // whoever moves the stick, the rudder or the throttle for a moment flies by hand from there (the levers stay as they were)
      const hands = Math.abs(fi.pitch) > 0.25 || Math.abs(fi.roll) > 0.25 || Math.abs(fi.yaw) > 0.3 || Math.abs(fi.throttle) > 0.3 || fi.brake > 0.3;
      this.flightTake = hands ? this.flightTake + dt : 0;
      if (this.flightTake > 0.18) {
        ap.off();
        this.flightAssist.reset(f.trim);
        this.hud.message(tr('apOff', this.settings.lang));
      }
    }
    if (ap.engaged) {
      const ac = ap.update(a, dt, ground);
      if (this.flightGoto && ap.state.mode === 'hold') {
        const g = this.flightGoto;
        this.flightGoto = null;
        ap.goto(g.x, g.z, Math.max(g.alt, a.altitude));
      }
      // (the levers follow what the autopilot does: taking over is smooth)
      f.throttle = ac.throttle;
      f.flaps = ap.flapNotch;
      f.trim = ac.trim;
      Object.assign(this.flightControls, ac);
      if (f.crashT < 0) a.step(dt, ac, ground);
      this.afterFlightStep(a, f, dt);
      return;
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
    // the help for flying by hand (sim/autopilot.ts FlightAssist): softer stick, balanced turns, wings level when let go, no stall
    const help = this.settings.flightAssist;
    if (help !== 'off') {
      this.flightAssist.options = help === 'light' ? ASSIST_LIGHT : ASSIST_BEGINNER;
      this.flightAssist.apply(a, fi, dt, c);
      f.trim = c.trim;
    }
    if (f.crashT < 0) a.step(dt, c, ground);
    this.afterFlightStep(a, f, dt);
  }

  /** The aeroplane on or off its autopilot (the demonstration button, or its key): from the runway a demonstration flight, in the air holding height and heading. */
  private toggleFlightAuto(): void {
    const a = this.aircraft;
    if (!a) return;
    const ap = this.flightAuto;
    const lang = this.settings.lang;
    if (ap.engaged) {
      ap.off();
      this.flightAssist.reset(this.flight.trim);
      this.hud.message(tr('apOff', lang));
      return;
    }
    const r = a.onGround && this.air ? runwayAt(this.air.airfields, a.pos.x, a.pos.z, a.yaw) : null;
    if (r) ap.demo(r.runway, r.fromSecond);
    else if (!a.onGround) {
      ap.hold(a.heading, a.altitude);
      ap.takeOver({ throttle: this.flight.throttle, trim: this.flight.trim });
    } else {
      this.hud.message(tr('apNoRunway', lang));
      return;
    }
    this.flightTake = 0;
    this.hud.message(tr('apOn', lang));
  }

  /** What follows each step of the flight, by hand or by the autopilot: the world below, a crash. */
  private afterFlightStep(a: Aircraft, f: { crashT: number }, dt: number): void {
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
  /** the player has the controller for a moment (the assisted autopilot), and how long it has been let go */
  private tramHeld = false;
  private tramFree = 0;
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
      // (with the assisted autopilot only for as long as the controller is held: it drives on after)
      this.tramTake = c.throttle > 0.2 || c.brake > 0.2 || c.handbrake > 0.5 ? this.tramTake + dt : 0;
      if (this.tramHeld) {
        this.tramFree = c.throttle < 0.05 && c.brake < 0.05 && c.handbrake < 0.5 ? this.tramFree + dt : 0;
        if (this.tramFree > 2.5) {
          this.tramHeld = false;
          this.tramTake = 0;
          this.hud.message(tr('demoResumed', this.settings.lang));
        }
      } else if (this.tramTake > 0.18 && this.settings.autopilotAssist) {
        this.tramHeld = true;
        this.tramFree = 0;
        this.hud.message(tr('demoHeld', this.settings.lang));
      } else if (this.tramTake > 0.18) {
        this.tramAuto = false;
        this.hud.message(tr('demoTaken', this.settings.lang), tr('tramAutoAgain', this.settings.lang));
      }
      if (this.tramAuto && !this.tramHeld) tram.drive(ev);
    }
    if (this.walker || this.doorT >= 0) {
      // nobody in the cab: the tram stands braked, and the keys walk
      tram.lever = -0.6;
      tram.emergency = false;
      this.stepDoor(dt);
      this.stepWalk(dt);
    } else if (!this.tramAuto || this.tramHeld) {
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
    // (and the crowd of a march on its street)
    this.roadEvents.railBlocks(others);
    // (the others appear around the player's tram and keep clear of it like of any other)
    const front = tram.v.cars[0];
    this.rail.update(dt, { x: front.x, y: front.y, z: front.z, yaw: front.yaw, length: tram.v.consist.carLen, width: tram.v.consist.width }, others);
    // the road traffic keeps clear of every car of the tram
    const boxes = this.railBoxes;
    boxes.length = 0;
    for (const rv of this.rail.vehicles) rv.cars.forEach((rc, i) => boxes.push({ x: rc.x, y: rc.y, z: rc.z, yaw: rc.yaw, speed: rv.speed, length: carLayout(rv.consist)[i].len, width: rv.consist.width, own: rv === tram.v }));
    this.traffic.obstacles = boxes;
    this.traffic.update(dt, { x: front.x, y: front.y, z: front.z, yaw: front.yaw, speed: tram.speed, length: tram.v.consist.carLen, width: tram.v.consist.width, horn: c.horn });
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
      // (the first destination of a lesson in a real place: the road behind that place – game/lessonplaces.ts)
      const placed = this.placeGoal;
      this.placeGoal = null;
      let goal = placed ?? (type === 'home' && !home ? null : findTarget(this.app.world, this.lanes, type, p.x, p.z, lane, home, this.visited));
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
      // (the world's moment, when the arcade mode set another one or runs the time faster – and the sun of it)
      this.hud.setClock(gameClock.real || this.state !== 'drive' ? null : clockBadge(gameClock.ms(), gameClock.rate, localeOf(this.settings.lang)));
      this.updateSun();
      this.hud.setFps(this.fpsSince > 0 && this.state === 'drive' ? (this.fpsFrames * 1000) / (now - this.fpsSince) : -1);
      this.fpsSince = now;
      this.fpsFrames = 0;
    }
    const app = this.app;
    const tiles = app.tiles;
    this.spawnCars?.frame();
    this.footFlyFrame();

    // the road network around where things happen (it may come in pieces), and the signal heads of what is loaded
    if (this.state === 'placing') app.map.update(this.spawn!.x, this.spawn!.z, 40);
    else if (this.vehicle && this.state !== 'menu' && this.state !== 'loading') {
      const [fx, fz] = this.focus();
      app.map.update(fx, fz, this.state === 'drive' ? 5 : 25);
    }
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
      // The arcade mode lets the time run faster – while the autopilot drives, and since 1.7.0 with the
      // player at the wheel too: the world is stepped several times a picture, as often as the picture
      // can wait for (the world's clock goes on by what was really stepped); none of the steps is longer
      // than a tenth of a second, and the vehicle's physics divides each into its own small steps.
      const rate = gameClock.rate > 1 ? gameClock.rate : 1;
      if (gameClock.rate > 1 && rate === 1) {
        gameClock.setRate(1);
        if (gameClock.real) this.clockJumped();
      }
      if (rate > 1) {
        // (in as few steps as the world's parts allow – none of them is stepped by more than a tenth of a second)
        const n = Math.max(1, Math.ceil((dt * rate) / 0.1));
        const sub = (dt * rate) / n;
        const t0 = performance.now();
        // (the frame's own share of the time was already counted at its start)
        this.time -= dt;
        let done = 0;
        for (let i = 0; i < n && this.state === 'drive'; i++) {
          this.time += sub;
          this.stepDrive(sub);
          done += sub;
          if (performance.now() - t0 > 28) break;
        }
        gameClock.tick(done);
      } else {
        this.stepDrive(dt);
        gameClock.tick(dt);
        if (this.boardStart) this.faceBoard();
        if (this.liveGeo) this.stepLiveGeo(dt);
        this.hud.liveOffer = !!this.walker;
        this.hud.liveOn = !!this.liveGeo;
      }
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
      if (this.presetPending && this.time - this.startTime > 0.3 && this.currentLane() && this.routeGraphNow()) {
        const id = this.presetPending;
        this.presetPending = '';
        this.startPreset(id);
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
    // (in the menu the vehicle shown stands still: it is not driven)
    const haveCar = this.vehicle && model.root.visible && this.state !== 'menu' && this.state !== 'loading';
    const rp = this.state === 'replay' ? this.replay : null;
    if (haveCar && rp) this.placeReplay(dt);
    else if (haveCar) {
      const v = this.vehicle;
      v.getModelPosition(this.mpos);
      model.root.position.set(this.mpos[0], this.mpos[1], this.mpos[2]);
      model.root.quaternion.set(v.quat[0], v.quat[1], v.quat[2], v.quat[3]);
      model.root.updateMatrixWorld(true);
      const t = this.trailer;
      if (t && this.truck && this.def.kind === 'truck') this.truck.setTrailer(t.x, t.y, t.z, t.yaw, t.pitch, t.wheelSpin, t.coupled);
      if (t && this.carTrailer && this.def.model !== 'truck') this.carTrailer.place(t.x, t.y, t.z, t.yaw, t.pitch, t.wheelSpin, this.lastVisual);
      // a motorcycle leans into the bend: as far as it must for the speed and the curve
      if (model instanceof PlayerBike) model.setLean(bikeLean(v.speed, v.angVel[1]));
      // the aeroplane: where the flight has it, turned every way it is
      if (this.aircraft && this.planeModel) {
        const ac = this.aircraft;
        model.root.position.set(ac.pos.x, ac.pos.y, ac.pos.z);
        model.root.quaternion.set(ac.q[0], ac.q[1], ac.q[2], ac.q[3]);
        model.root.updateMatrixWorld(true);
        this.planeModel.update(this.planeVisual(ac), dt, this.time);
      }
      const [fx, fz] = this.focus();
      tiles.update(fx, fz);
      this.props.update(fx, fz);
      this.updateVisuals(dt);
      // a crane posed as it works, the loads of its site where they are
      if (this.crane && isCraneModel(model)) this.crane.render(model, this.time, this.state === 'drive' && !this.walker);
      // (off the forklift: nobody on its seat, its display and buttons away)
      if (this.forklift && isForkliftModel(model)) this.forklift.render(model, this.time, this.cameraMode === 'cockpit' || !!this.walker, this.state === 'drive' && !this.walker);
      // the drive written down for its replay
      if (this.state === 'drive') {
        const due = this.recorder.due(this.time);
        if (due) this.recorder.push(this.captureFrame(due.others, due.signals));
      }
    } else if (this.state === 'menu' && this.menuShow()) {
      this.signals.update(dt);
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
    } else if (this.state === 'theory' && this.theory) {
      // a theory lesson on the practice yard: its own scene and camera (game/theorymode.ts)
      this.theory.frame(dt, this.time);
      if (window.__fs && !window.__fs.ready && this.theory.ready) window.__fs.ready = true;
    }
    this.signs.flush();
    // the test place: built once the ground of the yard is there
    if (this.showOn && !this.showBuilt && this.state === 'drive' && tiles.settled) this.buildShowroom();
    this.showGroup.visible = this.showRail.group.visible = this.showPeople.group.visible = this.showOn;
    if (rp) {
      // the replay: the lights, the traffic and the trains as they were then
      const snap = rp.signals();
      if (snap && snap !== this.replayShown) {
        this.signals.restore(snap);
        this.replayShown = snap;
      }
      rp.traffic();
      rp.trains();
      // (the buses with the line they ran, for their displays)
      const bl = this.traffic.busLines;
      for (const c of rp.carList) {
        const l = c.line >= 0 ? bl?.lines[c.line] : undefined;
        c.bus = l ? { line: { ref: l.ref, to: l.to } } : undefined;
      }
    }
    this.signalHeads.update(this.signals);
    this.pedHeads.update(this.signals);
    if (rp) {
      this.actors.update(rp.carList as unknown as TrafficCar[], rp.pedList as unknown as Pedestrian[], this.time, rp.cyclistList as unknown as Cyclist[]);
      this.railActors.update(rp.railList as unknown as RailVehicle[], this.rail.lines);
    } else {
      this.actors.update(this.traffic.cars, this.traffic.peds, this.time, this.traffic.cyclists.list);
      this.wildView.update(this.traffic.wild?.animals ?? []);
      this.railActors.update(this.rail.vehicles, this.rail.lines);
    }
    // the stops, the overhead line, the tram signals, the people at the stops – around the camera
    this.transit.setRail(this.rail);
    if (this.lines && this.rail.net.paths.length > 0 && (this.lineStopsDirty || this.linesFor !== this.rail)) {
      // the lines: the trams run them, the departure boards list them
      this.lineStopsDirty = false;
      this.linesFor = this.rail;
      const paths = this.rail.net.paths;
      this.transit.lines = this.lines.lines.map((l) => ({ ref: l.ref, to: l.to, stops: l.stops.map(([p, mark]) => paths[p]?.stopNames[paths[p].stops.indexOf(mark)] ?? '') }));
      // (every line in its place – the timetables count them so –, one that does not fit the tracks without a way)
      this.rail.setLines(this.lines.lines.map((l) => ({ ref: l.ref, from: l.from, to: l.to, colour: l.colour, kind: l.kind, seq: l.paths.every(([p]) => p < paths.length) ? l.paths.map(([p, d]) => ({ path: p, dir: d > 0 ? 1 : -1 })) : [] })));
      this.rail.schedule = this.timetable ? tramSchedule({ timetable: () => this.timetable, lines: () => this.lines, rail: () => this.rail, nowMs: () => gameClock.ms() }) : null;
    }
    const cam = this.app.camera.position;
    // (the player's bus on its line, its doors open at a stop: the people there get on it like on any other)
    const bs = this.busService;
    let buses: readonly TrafficCar[] = this.traffic.cars;
    if (bs?.doorsOpen && this.vehicle && !rp) {
      const v = this.vehicle;
      const mid = (this.def.outline.rear - this.def.outline.front) / 2;
      const own = { id: -7, x: this.mpos[0] + Math.sin(v.yaw) * mid, z: this.mpos[2] + Math.cos(v.yaw) * mid, yaw: v.yaw, length: v.spec.length ?? 12, width: v.spec.width ?? 2.55, bus: { doors: true } } as unknown as TrafficCar;
      buses = [...buses, own];
    }
    this.transit.update(cam.x, cam.z, this.time, dt, this.signals, buses);
    // the roadworks and the demonstrations of the day around the camera
    this.roadworks.crowdCap = this.settings.quality === 'low' ? 70 : this.settings.quality === 'medium' ? 140 : 220;
    this.roadworks.update(this.roadEvents, this.signs, cam.x, cam.z, this.time, dt);
    // the level crossings around the camera: their lights, barriers and bells
    this.crossingView.update(this.levelCrossings, this.signs, cam.x, cam.z, this.time);
    if (this.explosion.active) this.explosion.update(this.state === 'drive' ? dt : 0);
    this.headlights(dt, haveCar && !rp ? model : null);
    // the server: the progress kept in step, the own vehicle sent, the other players drawn (net/online.ts)
    this.online?.frame(dt, haveCar && !rp ? this.netSelf() : null);

    if (this.state === 'reality') {
      // the panel covers the window: only a 360° panorama is drawn, not the world behind it
      this.reality.render(app.renderer, app.canvas);
    } else if (this.state === 'map') {
      // the map covers the window: nothing of the world needs drawing
    } else if (haveCar && rp) {
      this.replayCamera();
      this.updateOutdoors(dt, model);
      this.far.update(this.app.camera.position.x, this.app.camera.position.z);
      app.render(model.root.position);
    } else if (haveCar) {
      this.updateCamera(dt);
      this.updateOutdoors(dt, model);
      // the player's own figure: on foot, when the camera is not their eyes (not on the way in or out, not on a seat)
      const fw = this.walker;
      if (fw && this.settings.footView === 'behind' && !this.riding && !this.busRide && this.doorT < 0) this.figure.show(fw.x, fw.y, fw.z, fw.yaw, fw.distance, fw.speed > 0.25, this.time);
      else this.figure.hide();
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
      app.render(this.watcher ? this.tmpV.set(this.watcher.at.x, this.watcher.at.y, this.watcher.at.z) : model.root.position);
      // rain and snow on the windscreen, the wipers ("No mercy" graphics – 1.7.0: "very high" –, from the driver's seat): after the picture, which it keeps for its blur
      const wn = weatherNow();
      const wind = windVector(wn, { x: 0, z: 0 });
      const ws = this.windscreen;
      ws.frame({ renderer: app.renderer, model, detail: this.settings.graphics.vehicleDetail && this.settings.graphics.weatherFx && !this.aircraft, cockpit: this.cameraMode === 'cockpit' && !this.walker && this.doorT < 0 && !this.watcher, dt: this.state === 'drive' ? dt : 0, rain: rainIntensity(wn), snow: snowIntensity(wn), temperature: wn.temperature, roadWet: wn.wet, windX: wind.x, windZ: wind.z, heater: this.vehicle.engineRunning, washer: this.input.washer, light: app.sky.hemi.intensity / 1.2 });
      this.hud.setWipers(this.walker || this.aircraft ? null : ws.mode);
      if (ws.blindFor > 4 && this.state === 'drive') this.rules.note('noView', 'minor', {}, 60);
    } else {
      app.render(this.state === 'theory' && this.theory ? this.theory.focus : this.menuFocus);
    }
    // the timers over the traffic lights near by (ui/signaltimers.ts): while driving, not in lessons and tests
    if (this.state === 'drive' && !this.lesson && this.settings.signalTimers && this.signalTimers) {
      this.signalTimers.setHint(tr('signalTimers.hint', this.settings.lang));
      this.signalTimers.update(app.camera, window.innerWidth, window.innerHeight, this.settings.uiScale, this.signalHeads.spots, this.walker ? this.pedPoles : null, this.signals);
    } else this.signalTimers?.hide();
    // the labels over the queues near by (ui/queuelabels.ts): while driving, not in lessons and tests
    if (this.state === 'drive' && !this.lesson && this.settings.queueLabels && this.traffic) {
      (this.queueLabels ??= new QueueLabels(this.ui)).update(app.camera, window.innerWidth, window.innerHeight, this.settings.uiScale, this.traffic.cars, this.signals, this.settings.lang);
    } else this.queueLabels?.hide();
    // the inside mirror where the player put it: moved in the car, or its picture in the HUD (ui/hudmirror.ts)
    (this.hudMirror ??= new HudMirror(this.ui, app, this.settings)).frame({
      mirrors: haveCar ? model.mirrors : null,
      cockpit: this.state === 'drive' && haveCar && !rp && !this.walker && !this.watcher && this.doorT < 0 && this.cameraMode === 'cockpit',
      eye: this.eyeWorld,
      eyeLocal: haveCar ? model.eye : null,
      far: Math.min(450, app.tiles.viewRadius * 0.4),
      refresh: this.settings.mirrors === 'full' || (this.frames & 1) === 0,
      lang: this.settings.lang,
    });
    // looking into a mirror: one of the vehicle's mirrors large over the upper half of the picture (ui/mirrorzoom.ts)
    if (this.input) {
      (this.mirrorZoom ??= new MirrorZoomPanel(this.ui, this.input, app)).frame({
        mirrors: this.state === 'drive' && haveCar && !rp && !this.walker && this.doorT < 0 && (this.cameraMode === 'cockpit' || this.cameraMode === 'chase') ? model.mirrors : null,
        cockpit: this.cameraMode === 'cockpit',
        eye: this.eyeWorld,
        far: Math.min(450, app.tiles.viewRadius * 0.4),
        lang: this.settings.lang,
      });
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

  /**
   * The weather and the season, once a picture: the real weather (or the
   * one chosen) where the player is, rain and snow round the camera but not
   * in the cab, the grip of the road.
   */
  private updateOutdoors(dt: number, model: VehicleModel): void {
    const od = this.outdoors;
    if (!od) return;
    // the cab keeps the rain out: the vehicle's outline, as high as it is (the tram's and the aeroplane's cabs: none) –
    // a crane's cab, high up on its tower or turntable, round the eye (the loader crane is worked standing beside the truck)
    const craneCab = !!this.crane && this.cameraMode === 'cockpit' && this.def.kind !== 'loaderCrane' && this.state !== 'replay';
    const inside = !craneCab && !this.walker && !this.tram && !this.aircraft && this.state !== 'replay';
    const shelter: THREE.Object3D | null = craneCab ? this.app.camera : inside ? model.root : null;
    if (shelter !== this.shelterOf) {
      this.shelterOf = shelter;
      const o = this.def.outline;
      const high = this.def.model === 'car' ? 1.7 : this.def.model === 'motorcycle' ? 0 : 3.6;
      if (craneCab) od.view.setShelter(this.app.camera, new THREE.Box3(new THREE.Vector3(-1.6, -1.6, -1.6), new THREE.Vector3(1.6, 1.6, 1.6)));
      else if (shelter && high > 0) od.view.setShelter(shelter, new THREE.Box3(new THREE.Vector3(-o.hw - 0.1, 0, -o.front - 0.1), new THREE.Vector3(o.hw + 0.1, high, o.rear + 0.1)));
      else od.view.setShelter(null);
    }
    const w = this.walker;
    const x = w && this.walkerAway() ? w.x : this.mpos[0];
    const z = w && this.walkerAway() ? w.z : this.mpos[2];
    od.update(dt, this.app.camera.position, { x, y: this.app.tiles.heightAt(x, z), z }, this.settings, this.lanes);
    // (today's fuel prices round the player, where the settings hold a key of Tankerkönig)
    fuelPrices.key = this.settings.fuelKey;
    fuelPrices.refresh(x, z);
    this.ground.weatherGrip = od.grip;
    // (the road physics switched off in the arcade options: every surface as dry asphalt)
    this.ground.even = this.settings.evenRoads;
    // (bare winter crowns throw no full shadows: the trees' shadows go while they are bare)
    this.props.setShadows(this.settings.graphics.propShadows && !od.look.thinCrowns);
  }

  /** where on its track the tram is (for the sound of its curves) */
  private readonly soundAt = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };

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
    s.highBeam = this.beams.high(c.lowBeam, c.highBeam, this.input.flasher, this.settings.beamAssist);
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
    this.services.visual(s, this.model, dt);
    this.model.update(s, dt, this.time);
    // the map on the vehicle's own screen, in the driver's seat – the corner map is hidden meanwhile (render/navscreen.ts)
    const screen = this.model === this.car ? this.carScreen : (this.model.navScreen ?? null);
    const onScreen = !!screen && this.settings.mapOnScreen && this.cameraMode === 'cockpit' && !this.walker && this.doorT < 0;
    // (a tap on the screen opens the big map – or, as the settings choose, brings the map back into the corner: ui/screentap.ts)
    const tap = (this.screenTap ??= new ScreenTap(this.app.canvas, this.app.camera, () => this.settings.screenTap, () => this.openMap()));
    tap.setScreen(onScreen && this.state === 'drive' ? screen : null);
    const peek = tap.peek && this.settings.screenTap === 'minimap';
    screen?.setLive(onScreen && !peek);
    this.hud.screen = onScreen && !peek ? screen : null;

    // sound
    let skid = 0;
    let rough = 1;
    for (const w of v.wheels) {
      skid = Math.max(skid, w.skid);
      rough = Math.max(rough, w.grip < 0.75 ? 2.4 : 1);
    }
    void SURF_ROLLING;
    {
    const ac = this.aircraft;
    const tram = this.tram;
    if (ac) {
      // the aeroplane: its engine and propeller, the wind, the stall warning
      this.audio.update({ rpm: ac.rpm, load: this.flight.throttle, engineRunning: ac.engineRunning, starter: false, speed: ac.ias, skid: 0, indicatorOn: false, blinkOn: false, horn: false, rough: 1, airborne: !ac.onGround, stallWarning: ac.stallWarning, braking: this.flightControls.brake });
    } else if (tram) {
      // the tram: its motors pulling or braking, the rails, the squeal in tight curves, the bell
      this.rail.net.sample(tram.v.path, tram.v.s, this.soundAt);
      const cap = this.soundAt.cap;
      this.audio.update({
        rpm: 0,
        load: tram.powered ? Math.max(0, tram.lever) : 0,
        braking: tram.emergency ? 1 : Math.max(0, -tram.lever),
        engineRunning: tram.powered,
        starter: false,
        speed: tram.speed,
        skid: 0,
        indicatorOn: c.indicator !== 0 && this.state === 'drive',
        blinkOn: s.blinkOn,
        horn: c.horn,
        rough: 1,
        curve: cap < 90 ? 1.1 / (cap * cap) : 0,
      });
    } else {
      this.audio.update({
        rpm: v.rpm,
        load: v.engineLoad,
        engineRunning: v.engineRunning && !this.wrecked,
        starter: c.starter,
        speed: v.speed,
        skid,
        indicatorOn: (c.indicator !== 0 || c.hazard) && this.state === 'drive',
        blinkOn: s.blinkOn,
        horn: c.horn,
        rough,
        braking: this.driver.brake,
        parkingBrake: c.handbrake > 0.5,
        reversing: v.gear === -1,
      });
    }
    }

    // the horns of the emergency vehicles on their calls (src/audio/siren.ts)
    this.sirens.update(this.audio.context, this.audio.masterGain, this.traffic.cars, this.app.camera, this.cameraMode === 'cockpit' && !this.walker, v.vel[0], v.vel[2]);

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
    } else if (this.lesson?.kind === 'basics' || this.task || this.drill) navText = this.lessonLine;
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
      // (the handbrake on with a gear in: said before the throttle is pressed against it)
      else if (c.handbrake > 0.5 && (c.throttle > 0.1 || (s.automatic ? c.gear === 1 || c.gear === -1 : v.gear !== 0))) say('releaseHandbrake', 'Space');
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
      limitWhen: ctx.limitWhen,
      zone: ctx.zone,
      junction: ctx.junction,
      navText,
      navSub: this.task || this.drill ? this.taskSub : this.lesson && this.lesson.kind !== 'basics' ? this.lessonLine : ctx.roadName,
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
    // a lesson watched: the instructor says what the car does and why
    if (this.lessonWatch && this.lesson) hs.navSub = this.lessonWatch.text((k) => tr(k, lang));
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
      // where the power comes from: the wire (pantograph up, down, on its way) – or the regional tram's engine
      const power = !tram.wired ? tr(tram.hybrid ? 'tramEngine' : 'tramNoWire', lang) : tram.panto >= 0.999 ? tr('tramPantoUp', lang) : tram.pantoUp ? tr('tramPantoRising', lang) : tr('tramPantoDown', lang);
      const parts = [control, way, tr(tram.doorsOpen ? 'tramDoorsOpen' : 'tramDoorsClosed', lang), power];
      const line = tram.v.line ? this.rail.lines[tram.v.line.index] : null;
      if (line) parts.unshift(tr('tramLineTo', lang, { line: line.ref, to: line.to }));
      // standing at a stop of its line: on time by the timetable, or how late (or early)
      const tt = this.timetable;
      if (tt && tram.v.line && A.stop < 8 && A.stopPath >= 0 && tram.speed < 0.5) {
        const sch = scheduledAt(tt, tram.v.line.index, this.stopName(A.stopPath, A.stopMark), serviceTime(gameNow()));
        if (sch) {
          const m = Math.round(sch.late / 60);
          parts.push(m === 0 ? tr('tramOnTime', lang) : m > 0 ? tr('tramLate', lang, { m }) : tr('tramEarly', lang, { m: -m }));
        }
      }
      if (this.lesson?.kind === 'tram') parts.unshift(this.lessonLine);
      if (this.tramAuto) parts.unshift(tr('tramAutoRunning', lang));
      hs.navSub = parts.join(' · ');
      hs.navArrow = 0;
      hs.navActive = false;
      hs.tip = '';
      hs.tipAction = '';
      if (tram.doorsOpen && tram.passengers > 0) hs.tip = tr('tramPassengers', lang, { n: tram.passengers });
      else if (!this.tramAuto && tram.wired && !tram.pantoUp && !tram.doorsOpen && tram.speed < 3) {
        // no power: the pantograph is down (as at the start of a drive)
        hs.tip = tr(touch ? 'tramPantoRaiseTouch' : 'tramPantoRaise', lang);
        hs.tipAction = 'KeyP';
      } else if (!this.tramAuto && tram.pantoUp && tram.ahead.wireEndIn < 160) {
        // the wire ends ahead: the pantograph must be down before it does
        hs.tip = tr(touch ? 'tramWireEndsTouch' : 'tramWireEnds', lang, { d: Math.round(tram.ahead.wireEndIn) });
        hs.tipAction = 'KeyP';
      } else if (tram.doorsOpen) {
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
      const open = this.time < this.tipUntil ? null : this.opens.walkHud(w, touch, lang, !this.wrecked && this.model === this.car);
      if (this.time < this.tipUntil) hs.tip = this.tipText;
      else if (open) {
        hs.tip = open.tip;
        hs.tipAction = open.action;
      } else if (w.atDoor) {
        hs.tip = tr(touch ? 'getInTouch' : 'getIn', lang);
        hs.tipAction = 'KeyG';
      } else if (this.wrecked) hs.tip = tr('wreckedTip', lang);
      else if (w.tooFar) hs.tip = tr('tooFar', lang, { d: Math.round(Math.hypot(w.x - this.mpos[0], w.z - this.mpos[2])) });
      else if (this.time - this.walkSince < 10) hs.tip = tr(touch ? 'walkHelpTouch' : 'walkHelp', lang);
    } else if (this.doorT < 0 && !demo?.active && !this.task && (!hs.tip || hs.tipAction === 'Enter') && Math.abs(kmh) < 1 && !v.engineRunning && c.handbrake > 0.5 && v.odometer - this.startOdo > 30) {
      // standing, engine off, parking brake on: getting out is offered
      hs.tip = tr(touch ? 'getOutHintTouch' : 'getOutHint', lang);
      hs.tipAction = 'KeyG';
    }
    if (!w && this.opens.passenger && this.model === this.car && !this.opens.busy && this.time >= this.tipUntil) {
      // a passenger: where one sits – and, the car standing, how to get out
      const out = Math.abs(kmh) < 1 && !demo?.active;
      hs.tip = this.opens.seatTip(touch, lang, out);
      hs.tipAction = out ? 'KeyG' : '';
    }
    // the buttons beside the person on foot: open, shut, get in (game/openplay.ts)
    const near = w && this.state === 'drive' && this.def.kind !== 'pedestrian' ? this.opens.walkHud(w, touch, lang, !this.wrecked && this.model === this.car) : null;
    this.opens.buttons(this.ui, near?.buttons ?? [], (id) => {
      if (id === 'enter') this.getIn();
      else this.opens.toggleAt(this.walker);
    });
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
      hs.navSub = this.flightAuto.engaged
        ? tr('apStatus', lang, {
            what: tr(apPhaseKey(this.flightAuto.state), lang),
            // (on the runway there is no height to hold yet)
            alt: Number.isFinite(this.flightAuto.state.targetAltitude) ? Math.round((this.flightAuto.state.targetAltitude * 3.28084) / 50) * 50 : '–',
            hdg: Number.isFinite(this.flightAuto.state.targetHeading) ? String(Math.round(this.flightAuto.state.targetHeading) % 360).padStart(3, '0') : '–',
          })
        : tr('flySub', lang, { t: Math.round(this.flight.throttle * 100), f: this.flight.flaps * 10, rpm: Math.round(ac.rpm / 10) * 10 });
      hs.navArrow = 0;
      hs.navActive = false;
      hs.tipAction = '';
      hs.tip = this.time < this.tipUntil ? this.tipText : ac.stallWarning ? tr('flyStall', lang) : this.time - this.startTime < 20 ? tr(touch ? 'flyHelpTouch' : 'flyHelp', lang) : '';
    }
    // (watching a tram or bus: the corner map goes with it)
    if (this.watcher) {
      hs.x = this.watcher.at.x;
      hs.z = this.watcher.at.z;
      hs.yaw = this.watcher.at.yaw;
    }
    this.services.hud(hs, touch);
    if (this.crane) this.crane.hud(hs, touch, this.walker);
    if (this.forklift) this.forklift.hud(hs, touch, this.walker);
    this.hud.update(hs, this.time);
  }

  private speak(what: string, dist: number, text: string): void {
    if (!this.settings.voice || !('speechSynthesis' in window)) return;
    // announce each manoeuvre twice: early and right before it
    const stage = dist < 0 ? '' : dist < 45 ? 'now' : dist < 260 ? 'soon' : '';
    const key = `${what}:${stage}:${this.targetIdx}`;
    if (!stage || what === 'navFollow' || key === this.lastNavSpoken) return;
    this.lastNavSpoken = key;
    // (the voice, the text made speakable, the queue: audio/speech.ts)
    speech.say(text, this.settings.lang, this.settings);
  }

  /** on foot: how far the head is turned by the glance keys (smoothed) */
  private footGlance = 0;

  /** the chase camera's place relative to the point it circles (smoothed) */
  private readonly chaseOff = new THREE.Vector3();

  private updateCamera(dt: number): void {
    {
      const want = this.walker ? this.input.glanceYaw() : 0;
      this.footGlance += (want - this.footGlance) * (1 - Math.exp(-dt * 8));
    }
    const cam = this.app.camera;
    // zooming the view (input/camzoom.ts): on foot and in the driver's seat – pinch, the wheel, + and −
    const zoomable = !this.watcher && !this.crane && this.doorT < 0 && !this.opens.blending && (!!this.walker || this.cameraMode === 'cockpit');
    this.input.viewZoom = zoomable;
    this.input.zoom.update(dt, this.settings.zoomRelease, zoomable);
    if (this.watcher) {
      this.watcher.camera(cam, this.input.c, dt);
      return;
    }
    // the developer's view (?cam=… or devView()): a camera standing anywhere – for comparing the world with photos
    if (this.cameraMode === 'dev') {
      cam.near = 0.3;
      cam.fov = this.devFov;
      cam.position.copy(this.free.pos);
      cam.rotation.set(this.free.pitch, this.free.yaw, 0, 'YXZ');
      cam.updateProjectionMatrix();
      return;
    }
    const car = this.model.root;
    const v = this.vehicle;
    const c = this.input.c;
    // the eye is always needed for the mirrors
    const lean = this.tmpV.set(-v.accLat * 0.004, 0, v.accLong * 0.005);
    lean.clampLength(0, 0.06);
    this.eyeWorld.copy(this.model.eye).add(lean).applyMatrix4(car.matrixWorld);
    // working a crane: from the operator's seat, or round the hook (game/craneplay.ts)
    const craneModel = this.model;
    if (this.crane && !this.walker && isCraneModel(craneModel) && this.crane.camera(cam, this.cameraMode, c, dt, craneModel)) {
      cam.updateProjectionMatrix();
      return;
    }
    const w = this.walker;
    if (w || this.doorT >= 0 || this.opens.blending) {
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
      } else if (w && this.settings.footView === 'behind') {
        // seen from behind: a few metres back and above, looking past the head the way the person looks
        const head = this.headV.set(w.x, w.y + 1.55, w.z);
        const pitch = Math.max(-1.1, Math.min(0.6, w.pitch - 0.22));
        const back = 3.3 * Math.cos(pitch);
        const gy0 = w.yaw + this.footGlance;
        to.set(w.x + Math.sin(gy0) * back, head.y - Math.sin(pitch) * 3.3, w.z + Math.cos(gy0) * back);
        // (not into the ground behind a kerb or on a slope)
        const gy = this.footGround(to.x, to.z, to.y + 1);
        if (Number.isFinite(gy)) to.y = Math.max(to.y, gy + 0.5);
        this.tmpM.lookAt(to, head, THREE.Object3D.DEFAULT_UP);
        q.setFromRotationMatrix(this.tmpM);
      } else if (w) {
        to.set(w.x, w.y + EYE, w.z);
        // (looking left, right or back: the head turns – the glance keys and their buttons)
        q.setFromEuler(new THREE.Euler(w.pitch, w.yaw + this.footGlance, 0, 'YXZ'));
      } else {
        to.copy(this.eyeWorld);
        q.copy(car.quaternion);
      }
      if (this.opens.blending) {
        // into the car's seat or out of it, as the door stands open (game/openplay.ts)
        const k = this.opens.blend;
        cam.position.copy(this.doorFrom.pos).lerp(to, k);
        cam.quaternion.copy(this.doorFrom.quat).slerp(q, k);
      } else if (this.doorT >= 0) {
        const k = Math.min(1, this.doorT / 0.6);
        cam.position.copy(this.doorFrom.pos).lerp(to, k);
        cam.quaternion.copy(this.doorFrom.quat).slerp(q, k);
      } else {
        cam.position.copy(to);
        cam.quaternion.copy(q);
      }
      cam.fov = this.input.zoom.fov(cam.fov);
      cam.updateProjectionMatrix();
      return;
    }
    if (this.cameraMode === 'cockpit') {
      cam.near = 0.06;
      cam.fov = 60;
      cam.position.copy(this.eyeWorld);
      // looking over the shoulder also moves the head a little towards that side
      // (on a demonstration drive the head turns as the driver looks over the shoulder – not in a jerk)
      const want = this.demo?.active ? this.demo.look * 0.8 : this.lessonWatch && this.lesson ? this.lessonWatch.look * 0.8 : 0;
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
      // (the camera's place relative to the car is what is smoothed – not its place in the world: following a
      // moving point by a share of the way per picture left it trailing by more or less with every uneven
      // picture, a quick little zoom in and out while driving)
      if (this.camSnap) this.chaseOff.copy(back);
      else this.chaseOff.lerp(back, 1 - Math.exp(-dt * 8));
      const target = this.camTarget.set(fx, car.position.y, fz).add(this.chaseOff);
      const g = this.app.tiles.heightAt(target.x, target.z);
      if (!Number.isNaN(g)) target.y = Math.max(target.y, g + 0.6);
      cam.position.copy(target);
      this.camSnap = false;
      cam.lookAt(fx, car.position.y + up, fz);
    } else if (this.cameraMode === 'free' && this.flyFree()) {
      this.flyCamera(cam, dt);
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
    this.services.camera(cam);
    // (1 – nothing – unless the view is zoomed: only on foot and in the driver's seat)
    cam.fov = this.input.zoom.fov(cam.fov);
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
