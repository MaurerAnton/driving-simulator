// SPDX-License-Identifier: AGPL-3.0-only
/** User settings, persisted in localStorage. */
import { LANGS, pickLang } from '../i18n/index.ts';
import { DEFAULT_TOUR_PREFS } from './tourlog.ts';
import type { TourPrefs } from './tourlog.ts';
import { vehicleKind } from './vehicles.ts';
import type { VehicleKind } from './vehicles.ts';
import type { TramSet } from '../sim/rail.ts';
import type { LessonArea, LessonPlaceMode } from './lessonplaces.ts';
import { ZOOM_RELEASES } from '../input/camzoom.ts';
import { cleanSpeechPrefs } from '../audio/voicepick.ts';
import type { SpeechPref } from '../audio/voicepick.ts';
import type { ZoomRelease } from '../input/camzoom.ts';
import { normaliseServerUrl } from '../net/client.ts';

export type Transmission = 'assist' | 'manual' | 'automatic';
/** a preset of the graphics – or 'custom': the advanced settings chosen one by one */
export type Quality = 'low' | 'medium' | 'high' | 'ultra' | 'nomercy' | 'custom';

/** What the graphics presets set – everything but the resolutions, which are settings of their own. */
export interface Graphics {
  /** shadows of buildings and vehicles: none, around the vehicle, far around */
  shadows: 'off' | 'near' | 'far';
  /** how far the map is drawn (m) */
  viewDistance: number;
  /** how many of the trees and roadside objects are drawn (0 … 1) */
  propDensity: number;
  /** buildings with windows, doors and roof tiles (false: plain walls and roofs) */
  facades: boolean;
  /** trees and signs cast shadows */
  propShadows: boolean;
  /** how far the ground beyond the map is drawn – the hills on the horizon (m; 0: not at all) */
  farView: number;
  /** the player's vehicles in finer detail, outside and in the cockpit (render/cardetail.ts, render/fleetdetail.ts) */
  vehicleDetail: boolean;
  /** real water: rivers, lakes and ponds with ripples, the sky mirrored and the sun glinting (render/water.ts) */
  water: boolean;
  /**
   * the weather on the vehicle and the roads (1.7.1: only "No mercy" by default) – rain and snow on the windscreen
   * (render/windscreen.ts), water standing on the roads (render/weather.ts), mud on the body (render/dirt.ts) – and the
   * seasons by the date: without it a season "by the date" is summer
   */
  weatherFx: boolean;
}

export const GRAPHICS_PRESETS: Record<Exclude<Quality, 'custom'>, Graphics> = {
  // (for weak phones: little to draw, few trees, a short view – the resolutions go down with it: lowResolutions)
  low: { shadows: 'off', viewDistance: 500, propDensity: 0.2, facades: false, propShadows: false, farView: 0, vehicleDetail: false, water: false, weatherFx: false },
  medium: { shadows: 'near', viewDistance: 1250, propDensity: 0.8, facades: true, propShadows: false, farView: 8000, vehicleDetail: false, water: false, weatherFx: false },
  high: { shadows: 'far', viewDistance: 2000, propDensity: 1, facades: true, propShadows: true, farView: 12000, vehicleDetail: false, water: false, weatherFx: false },
  ultra: { shadows: 'far', viewDistance: 3000, propDensity: 1, facades: true, propShadows: true, farView: 20000, vehicleDetail: true, water: true, weatherFx: false },
  // (1.7.1: "very high" and the weather on the vehicle and the roads, and the seasons – planned to grow, see README)
  nomercy: { shadows: 'far', viewDistance: 3000, propDensity: 1, facades: true, propShadows: true, farView: 20000, vehicleDetail: true, water: true, weatherFx: true },
};
export const VIEW_DISTANCES = [500, 700, 1000, 1250, 1600, 2000, 2500, 3000];

/** A weak device by what the browser tells: four cores or fewer, or 3 GB of memory or less (a phone of the lower end). */
export function lowDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const cores = navigator.hardwareConcurrency ?? 8;
  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  return cores <= 4 || mem <= 3;
}

/** What the low preset sets beside the graphics: the resolutions (the biggest saving on a weak phone). */
export const LOW_RESOLUTIONS = { pixelCap: 1, render3d: 0.75 } as const;
/** the ground beyond the map: off, or so far (m) */
export const FAR_VIEWS = [0, 5000, 8000, 12000, 20000, 30000];
/** running on foot (km/h): a jog … a sprint */
export const RUN_SPEEDS = [8, 10, 12, 15, 18, 22, 26];
/** the camera a drive starts with: behind the car, or at the driver's eyes */
export type View = 'chase' | 'cockpit';


export interface WheelMapping {
  steerAxis: number;
  throttleAxis: number;
  brakeAxis: number;
  clutchAxis: number;
  /** pedal axes rest at +1 and go to -1 when pressed (typical for wheels) */
  pedalsInverted: boolean;
  /** degrees of wheel rotation lock to lock as configured in the wheel's driver */
  wheelRange: number;
  /** button indices of an H-shifter: [1st … 6th, reverse] */
  shifter: number[];
}

export interface Settings {
  /** language code, one of LANGS in src/i18n */
  lang: string;
  /** a car (class B) or the truck with trailer (class CE) */
  vehicle: VehicleKind;
  transmission: Transmission;
  /**
   * the engine power chosen for each kind of vehicle, in PS (metric horsepower, as German vehicle papers print
   * it); one of its VehicleDef.powers – a kind not listed has the power it comes with
   */
  powers: Partial<Record<VehicleKind, number>>;
  /**
   * with keys or pedals on the screen the throttle eases off at the current speed limit.
   * Off by default since 1.7.5: no speed is held back unless the player asks for it – one
   * who wants 150 km/h in a town can have it; the limit roundel still shows when it is passed.
   */
  limiter: boolean;
  /** the autopilot lets the player take over for a moment and drives on to its places when let go (else taking over ends it) */
  autopilotAssist: boolean;
  /** arcade driving (game/arcadedrive.ts): the automatic gearbox, D and R by the pedals, no handbrake, the engine always running – none of it judged */
  arcadeDrive: boolean;
  /** the road physics off (sim/ground.ts WorldGround.even): every road and land, in any weather, grips as dry asphalt */
  evenRoads: boolean;
  /** the main-beam assist: at night the main beam goes on and off by itself (game/beamplay.ts) */
  beamAssist: boolean;
  /** the light of day: the game's fair afternoon always, or the sun as it stands at the time (night at night) */
  daylight: 'day' | 'clock';
  /** the player's key of Tankerkönig for today's fuel prices (empty: typical prices; world/fuelprices.ts) */
  fuelKey: string;
  /** the weather: the real one where the vehicle is (Open-Meteo), none, or one chosen – and the season: by the date, or one chosen */
  weather: 'off' | 'real' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';
  season: 'real' | 'spring' | 'summer' | 'autumn' | 'winter';
  /** flying by hand with help (sim/autopilot.ts FlightAssist): none, a little (softer stick, balanced turns, no stall), or the most (wings level when let go, too) */
  flightAssist: 'off' | 'light' | 'beginner';
  /** music, made as it plays (audio/music.ts): none, a piece now and then, or more often – and how loud (0…1) */
  music: 'off' | 'quiet' | 'on';
  musicVolume: number;
  /** how fast one runs on foot (km/h), one of RUN_SPEEDS */
  runSpeed: number;
  /**
   * how sharply A/D turn for a given speed (settings: a slider):
   * 1 the feel as built, above 1 sharper, below 1 gentler (input/steerfeel.ts).
   * A key-steering feel only – a real wheel keeps its own shape.
   */
  steerSensitivity: number;
  /** on foot: through one's own eyes, or seen from behind (the camera key switches) */
  footView: 'eyes' | 'behind';
  /** how one walks (game/walkmodes.ts): 'auto' – the classic way on a touch screen, as before with keys –, the classic way (stick or W A S D, look by dragging), as before 1.7.0 (pedals and bar, A D turn), or tap to walk */
  walkControls: 'auto' | 'classic' | 'tank' | 'tap';
  /** a tap (or click) on a place in the 3D picture offers "Teleport here" for a few seconds (ui/worldtap.ts) */
  teleportTap: boolean;
  /** developer mode: show which map tiles have several versions, and let a tile be chosen from a part of map-assets (ui/mapversions.ts) */
  devMap: boolean;
  /** where the parts of map-assets come from: the site, the repository over raw.githubusercontent (CORS ok), or a stored map pack */
  devMapFetch: 'site' | 'repo' | 'pack';
  /** the repository that holds map-assets (owner/repo), for devMapFetch 'repo' */
  devMapRepo: string;
  /** how much of the parts to keep in memory, in megabytes */
  devMapRam: number;
  /** show the loading bar while a part of map-assets is downloaded (netstats + hud setLoadingProgress) */
  devMapProgress: boolean;
  /** the tram the player drives: one unit, two coupled units, or one with a trailer car */
  tramSet: TramSet;
  /** the main menu: the vehicle large in the 3D picture with icons round it (the default since 1.4.0), rows of cards over the 3D scene, or the simple list of before */
  menuStyle: 'stage' | 'carousel' | 'classic';
  /** what a tour is to lead along (the map's tour planner) */
  tourPrefs: TourPrefs;
  view: View;
  /** how solid the interior is drawn in the cockpit view, 0.2 (see-through) … 1 */
  cabinOpacity: number;
  /** where the last drive began: a start point of the map, or an address */
  lastStart: { spawn: number; address: { label: string; street: string; x: number; z: number; exact: boolean } | null; /** the tram's: "name|town" */ tramStop?: string; /** the aeroplane's: "field|end" */ runway?: string };
  quality: Quality;
  /** the graphics as the preset (or the advanced settings) set them */
  graphics: Graphics;
  /** size of the interface – menus, HUD – (1 = as designed) */
  uiScale: number;
  /** most pixels per CSS pixel the picture is drawn with on a sharp screen (1, 1.5 or 3: as sharp as the screen) */
  pixelCap: number;
  /** share of those pixels the 3D picture is drawn with (0.5 … 1; less: softer and quicker) */
  render3d: number;
  /** off | one mirror per frame | all mirrors every frame */
  mirrors: 'off' | 'alternate' | 'full';
  /** show the current speed limit and the next priority sign in the HUD */
  hudRules: boolean;
  /** small timers over the traffic lights near by (a tap switches the light on; not in lessons and tests) */
  signalTimers: boolean;
  /** small labels over the queues in the traffic near by: how long, how many cars, the wait (not in lessons and tests) */
  queueLabels: boolean;
  /** show the engaged gear in the instrument cluster */
  hudGear: boolean;
  /** spoken instructor (browser speech synthesis) */
  voice: boolean;
  volume: number;
  /** per language: the voice chosen ('' = the best there is), rate and pitch (audio/voicepick.ts) */
  speech?: Record<string, SpeechPref>;
  /** traffic density 0 … 1 */
  traffic: number;
  drawDistance: number;
  wheel: WheelMapping;
  invertLookY: boolean;
  /**
   * Reality view: which street-level imagery services may be asked for
   * pictures of the place the car is at.  All off until the player says so –
   * a request tells the service the player's IP address and the place.
   */
  reality: { panoramax: boolean; kartaview: boolean; mapillary: boolean; mapillaryToken: string; /** aerial photographs of the land survey under the maps – the big one, the corner one, the car's screen (on since 1.4.0) */ aerial: boolean };
  /**
   * Driving controls on the screen (steering bar, pedals, buttons):
   * 'auto' shows them while the screen is being touched and hides them as soon
   * as a keyboard is used; 'on' / 'off' force them.
   */
  touchControls: 'auto' | 'on' | 'off';
  /** how solid the on-screen controls are drawn, 0.15 … 1 */
  touchOpacity: number;
  /** short reminder of the keys while standing or crawling (keyboard only) */
  keyHints: boolean;
  /** show how many pictures a second are drawn (FPS) in a corner of the screen */
  showFps: boolean;
  /** begin each drive on foot beside the vehicle: walk round it, get in */
  startOutside: boolean;
  /** when the game starts, ask the browser where the player is: on the map, the drive begins there */
  startHere: boolean;
  /** "place precisely": a drive at an address or a place chosen begins at that very place, not in the lane of the nearest road */
  placeExact: boolean;
  /** in the driver's seat: the map on the vehicle's own screen (where it has one) instead of the corner */
  mapOnScreen: boolean;
  /** the map: '' the site's, else the id of a map stored in this browser from files (world/mappack.ts) */
  mapPack: string;
  /** the region: '' the site's own map, else the id of a region in map-assets (world/regions.ts) – loaded instead of the site's map */
  region: string;
  /** a tap on the vehicle's screen in the driver's seat: the big map, or the map back in the corner of the HUD (another tap: on the screen again) */
  screenTap: 'bigmap' | 'minimap';
  /** when a zoomed view (on foot, in the driver's seat) goes back by itself once let go (input/camzoom.ts) */
  zoomRelease: ZoomRelease;
  /**
   * The inside rear-view mirror (ui/hudmirror.ts): in the car, moved along the
   * windscreen's top as on a rail (`shift`, m to the right) – or taken off into
   * the HUD, its middle at (fx, fy) of the screen; `size`: larger or smaller.
   */
  insideMirror: { mode: 'car' | 'hud'; shift: number; size: number; fx: number; fy: number };
  /** where the driving lessons begin (game/lessonplaces.ts): the start place as before, a random fitting place of the town, or one in the district chosen */
  lessonPlace: LessonPlaceMode;
  /** the player was asked once where the lessons are to take place */
  lessonPlaceAsked: boolean;
  /** the district chosen for the lessons (lessonPlace 'area'); null: the home town */
  lessonArea: LessonArea | null;
  /** the lessons are watched: the autopilot drives them, the instructor says what it does (game/lessonwatch.ts) – chosen at each lesson's start */
  lessonWatch: boolean;
  /** the computations that have a WebAssembly twin (src/wasm/kernels.ts – tiles, the quickest way): 'auto' in WebAssembly where the browser has it, 'off' in JavaScript only */
  wasm: 'auto' | 'off';
  /** the Fahrsim Baunatal server the player chose (net/client.ts: accounts, progress, photos, playing together) – '' none: the game needs none */
  server: string;
  /** what the stored settings were written by (SETTINGS_VERSION): older ones are brought up to date once, in merge */
  version: number;
}

/** 2 (1.4.0): the map on the vehicle's screen became the default – before, a stored `false` was only the old default */
export const SETTINGS_VERSION = 3;

export const DEFAULT_SETTINGS: Settings = {
  // the first of the browser's languages that the simulator speaks
  lang: typeof navigator !== 'undefined' ? pickLang(navigator.languages?.length ? navigator.languages : [navigator.language]) : 'en',
  // what the playtesters asked for: an automatic, seen from behind, with an engine that is easy to dose
  vehicle: 'car',
  transmission: 'automatic',
  powers: {},
  limiter: false,
  autopilotAssist: true,
  arcadeDrive: false,
  evenRoads: true,
  beamAssist: false,
  daylight: 'day',
  fuelKey: '',
  weather: 'real',
  season: 'real',
  flightAssist: 'beginner',
  music: 'off',
  musicVolume: 1,
  runSpeed: 12,
  steerSensitivity: 1,
  footView: 'eyes',
  walkControls: 'auto',
  teleportTap: true,
  devMap: false,
  devMapFetch: 'repo',
  devMapRepo: 'MaurerAnton/driving-simulator',
  devMapRam: 256,
  devMapProgress: true,
  tramSet: 'single',
  // (new players get the stage; a list chosen before stays – the rows, 1.3.0's default, become the stage once)
  menuStyle: 'stage',
  tourPrefs: { ...DEFAULT_TOUR_PREFS },
  view: 'chase',
  cabinOpacity: 1,
  lastStart: { spawn: 0, address: null },
  // (a weak device – few cores or little memory – begins on the low preset: lowDevice)
  quality: lowDevice() ? 'low' : 'medium',
  graphics: { ...GRAPHICS_PRESETS.medium },
  uiScale: 1,
  pixelCap: lowDevice() ? 1 : 1.5,
  render3d: lowDevice() ? 0.75 : 1,
  mirrors: lowDevice() ? 'off' : 'alternate',
  hudRules: true,
  signalTimers: true,
  queueLabels: true,
  hudGear: true,
  voice: false,
  volume: 0.7,
  traffic: lowDevice() ? 0.4 : 0.6,
  drawDistance: 1300,
  wheel: { steerAxis: 0, throttleAxis: 2, brakeAxis: 5, clutchAxis: 1, pedalsInverted: true, wheelRange: 900, shifter: [12, 13, 14, 15, 16, 17, 18] },
  invertLookY: false,
  reality: { panoramax: false, kartaview: false, mapillary: false, mapillaryToken: '', aerial: true },
  touchControls: 'auto',
  touchOpacity: 0.55,
  keyHints: true,
  showFps: false,
  startOutside: false,
  startHere: false,
  placeExact: false,
  mapOnScreen: true,
  mapPack: '',
  region: '',
  screenTap: 'bigmap',
  zoomRelease: 'auto',
  insideMirror: { mode: 'car', shift: 0, size: 1, fx: 0.5, fy: 0.09 },
  lessonPlace: 'start',
  lessonPlaceAsked: false,
  lessonArea: null,
  lessonWatch: false,
  wasm: 'auto',
  server: '',
  version: SETTINGS_VERSION,
};

const KEY = 'fahrsim-baunatal.settings.v2';
/** settings of the versions before the playtest (other defaults) */
const OLD_KEY = 'fahrsim-baunatal.settings.v1';

function fresh(): Settings {
  return { ...DEFAULT_SETTINGS, graphics: { ...DEFAULT_SETTINGS.graphics }, powers: {}, tourPrefs: { ...DEFAULT_TOUR_PREFS }, wheel: { ...DEFAULT_SETTINGS.wheel }, reality: { ...DEFAULT_SETTINGS.reality }, lastStart: { ...DEFAULT_SETTINGS.lastStart }, insideMirror: { ...DEFAULT_SETTINGS.insideMirror } };
}

/** Defaults, overlaid with what was stored – whatever is missing or implausible keeps its default. */
function merge(parsed: Partial<Settings>): Settings {
  const d = fresh();
  const s: Settings = { ...d, ...parsed, graphics: { ...d.graphics, ...(parsed.graphics ?? {}) }, wheel: { ...d.wheel, ...(parsed.wheel ?? {}) }, reality: { ...d.reality, ...(parsed.reality ?? {}) }, lastStart: { ...d.lastStart, ...(parsed.lastStart ?? {}) }, insideMirror: { ...d.insideMirror, ...(typeof parsed.insideMirror === 'object' && parsed.insideMirror ? parsed.insideMirror : {}) } };
  if (!LANGS.some((l) => l.code === s.lang)) s.lang = d.lang;
  // (before 1.2.0 there was one engine power, the car's)
  const old = (parsed as { power?: unknown }).power;
  s.powers = typeof parsed.powers === 'object' && parsed.powers !== null ? { ...parsed.powers } : {};
  if (typeof old === 'number' && s.powers.car === undefined) s.powers.car = old;
  delete (s as { power?: unknown }).power;
  for (const k of Object.keys(s.powers) as VehicleKind[]) if (!vehicleKind(k) || typeof s.powers[k] !== 'number') delete s.powers[k];
  if (s.view !== 'chase' && s.view !== 'cockpit') s.view = d.view;
  if (!vehicleKind(s.vehicle)) s.vehicle = d.vehicle;
  if (!RUN_SPEEDS.includes(s.runSpeed)) s.runSpeed = d.runSpeed;
  if (typeof s.steerSensitivity !== 'number' || !Number.isFinite(s.steerSensitivity)) s.steerSensitivity = d.steerSensitivity;
  else s.steerSensitivity = Math.min(2, Math.max(0.5, s.steerSensitivity));
  if (s.footView !== 'eyes' && s.footView !== 'behind') s.footView = d.footView;
  if (!(['auto', 'classic', 'tank', 'tap'] as const).includes(s.walkControls)) s.walkControls = d.walkControls;
  if (typeof s.teleportTap !== 'boolean') s.teleportTap = d.teleportTap;
  if (typeof s.devMap !== 'boolean') s.devMap = d.devMap;
  if (s.devMapFetch !== 'site' && s.devMapFetch !== 'repo' && s.devMapFetch !== 'pack') s.devMapFetch = d.devMapFetch;
  if (typeof s.devMapRepo !== 'string') s.devMapRepo = d.devMapRepo;
  if (!(s.devMapRam >= 16 && s.devMapRam <= 4096)) s.devMapRam = d.devMapRam;
  if (typeof s.devMapProgress !== 'boolean') s.devMapProgress = d.devMapProgress;
  if (s.tramSet !== 'single' && s.tramSet !== 'double' && s.tramSet !== 'trailer') s.tramSet = d.tramSet;
  if (s.menuStyle !== 'stage' && s.menuStyle !== 'carousel' && s.menuStyle !== 'classic') s.menuStyle = d.menuStyle;
  s.tourPrefs = { ...DEFAULT_TOUR_PREFS, ...(typeof parsed.tourPrefs === 'object' && parsed.tourPrefs ? parsed.tourPrefs : {}) };
  if (!['any', 'small', 'town', 'country'].includes(s.tourPrefs.mostly)) s.tourPrefs.mostly = 'any';
  // (stored before there was a far view: the one of the preset chosen then)
  if (parsed.graphics && typeof (parsed.graphics as Partial<Graphics>).farView !== 'number') s.graphics.farView = GRAPHICS_PRESETS[s.quality === 'custom' || !GRAPHICS_PRESETS[s.quality as Exclude<Quality, 'custom'>] ? 'medium' : (s.quality as Exclude<Quality, 'custom'>)].farView;
  if (!FAR_VIEWS.includes(s.graphics.farView)) s.graphics.farView = FAR_VIEWS.reduce((a, b) => (Math.abs(b - s.graphics.farView) < Math.abs(a - s.graphics.farView) ? b : a));
  if (!['assist', 'manual', 'automatic'].includes(s.transmission)) s.transmission = d.transmission;
  if (!['low', 'medium', 'high', 'ultra', 'nomercy', 'custom'].includes(s.quality)) s.quality = d.quality;
  // (stored before there were advanced graphics settings: what the level gave then)
  if (!parsed.graphics) {
    s.graphics = { ...GRAPHICS_PRESETS[s.quality === 'custom' ? 'medium' : s.quality] };
    if (parsed.quality === 'low') {
      s.pixelCap = 1;
      s.render3d = 0.7;
    } else if (parsed.quality === 'high') s.pixelCap = 3;
  }
  const g = s.graphics;
  if (!['off', 'near', 'far'].includes(g.shadows)) g.shadows = d.graphics.shadows;
  if (!VIEW_DISTANCES.includes(g.viewDistance)) g.viewDistance = d.graphics.viewDistance;
  if (!(g.propDensity >= 0 && g.propDensity <= 1)) g.propDensity = d.graphics.propDensity;
  if (typeof g.facades !== 'boolean') g.facades = d.graphics.facades;
  if (typeof g.propShadows !== 'boolean') g.propShadows = d.graphics.propShadows;
  // (stored before there were finer vehicles: as the preset of then gives them – on "very high" only)
  if (typeof (parsed.graphics as Partial<Graphics> | undefined)?.vehicleDetail !== 'boolean') g.vehicleDetail = s.quality === 'ultra';
  if (typeof (parsed.graphics as Partial<Graphics> | undefined)?.water !== 'boolean') g.water = s.quality === 'ultra';
  // (before 1.7.1 "very high" had the weather on the vehicle and the roads; now only "No mercy" – a custom choice of before keeps it)
  if (typeof (parsed.graphics as Partial<Graphics> | undefined)?.weatherFx !== 'boolean') g.weatherFx = s.quality === 'nomercy' || (s.quality === 'custom' && g.vehicleDetail);
  if (!(s.uiScale >= 0.7 && s.uiScale <= 1.6)) s.uiScale = d.uiScale;
  if (![1, 1.5, 3].includes(s.pixelCap)) s.pixelCap = d.pixelCap;
  if (!(s.render3d >= 0.5 && s.render3d <= 1)) s.render3d = d.render3d;
  if (!(s.cabinOpacity >= 0.2 && s.cabinOpacity <= 1)) s.cabinOpacity = d.cabinOpacity;
  if (typeof s.showFps !== 'boolean') s.showFps = d.showFps;
  if (typeof s.signalTimers !== 'boolean') s.signalTimers = d.signalTimers;
  if (typeof s.queueLabels !== 'boolean') s.queueLabels = d.queueLabels;
  if (typeof s.startOutside !== 'boolean') s.startOutside = d.startOutside;
  if (typeof s.startHere !== 'boolean') s.startHere = d.startHere;
  if (typeof s.placeExact !== 'boolean') s.placeExact = d.placeExact;
  if (typeof s.mapOnScreen !== 'boolean') s.mapOnScreen = d.mapOnScreen;
  if (typeof s.mapPack !== 'string') s.mapPack = d.mapPack;
  if (typeof s.region !== 'string') s.region = d.region;
  if (s.screenTap !== 'bigmap' && s.screenTap !== 'minimap') s.screenTap = d.screenTap;
  if (!ZOOM_RELEASES.includes(s.zoomRelease)) s.zoomRelease = d.zoomRelease;
  if (s.wasm !== 'auto' && s.wasm !== 'off') s.wasm = d.wasm;
  s.server = normaliseServerUrl(s.server) ?? d.server;
  s.speech = cleanSpeechPrefs(parsed.speech);
  {
    const m = s.insideMirror;
    if (m.mode !== 'car' && m.mode !== 'hud') m.mode = d.insideMirror.mode;
    if (!(m.shift >= -0.3 && m.shift <= 0.3)) m.shift = d.insideMirror.shift;
    if (!(m.size >= 0.6 && m.size <= 2)) m.size = d.insideMirror.size;
    if (!(m.fx >= 0 && m.fx <= 1)) m.fx = d.insideMirror.fx;
    if (!(m.fy >= 0 && m.fy <= 1)) m.fy = d.insideMirror.fy;
  }
  // settings written before 1.4.0 stored the map's old default (not on the screen) as if chosen: the new default, once
  if (!(Number(parsed.version) >= 2)) s.mapOnScreen = true;
  // (the same for the aerial photographs under the maps: before 1.4.0 they had to be asked for)
  if (!(Number(parsed.version) >= 2)) s.reality.aerial = true;
  // (and for the main menu: the rows were 1.3.0's default – the stage is 1.4.0's; a list chosen stays a list)
  if (!(Number(parsed.version) >= 2) && s.menuStyle === 'carousel') s.menuStyle = 'stage';
  // (1.7.1: simpler physics by default – the even grip of every road and field; settings of before stored the old default)
  if (!(Number(parsed.version) >= 3)) s.evenRoads = true;
  s.version = SETTINGS_VERSION;
  if (typeof s.autopilotAssist !== 'boolean') s.autopilotAssist = d.autopilotAssist;
  if (typeof s.beamAssist !== 'boolean') s.beamAssist = d.beamAssist;
  if (typeof s.arcadeDrive !== 'boolean') s.arcadeDrive = d.arcadeDrive;
  if (typeof s.evenRoads !== 'boolean') s.evenRoads = d.evenRoads;
  if (s.daylight !== 'day' && s.daylight !== 'clock') s.daylight = d.daylight;
  if (s.music !== 'off' && s.music !== 'quiet' && s.music !== 'on') s.music = d.music;
  if (typeof s.fuelKey !== 'string') s.fuelKey = d.fuelKey;
  if (s.flightAssist !== 'off' && s.flightAssist !== 'light' && s.flightAssist !== 'beginner') s.flightAssist = d.flightAssist;
  if (!['off', 'real', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'storm'].includes(s.weather)) s.weather = d.weather;
  if (!['real', 'spring', 'summer', 'autumn', 'winter'].includes(s.season)) s.season = d.season;
  if (!(s.musicVolume >= 0 && s.musicVolume <= 1)) s.musicVolume = d.musicVolume;
  if (!Number.isInteger(s.lastStart.spawn) || s.lastStart.spawn < 0) s.lastStart.spawn = 0;
  const a = s.lastStart.address;
  if (a && !(typeof a.label === 'string' && Number.isFinite(a.x) && Number.isFinite(a.z))) s.lastStart.address = null;
  if (s.lessonPlace !== 'start' && s.lessonPlace !== 'town' && s.lessonPlace !== 'area') s.lessonPlace = d.lessonPlace;
  if (typeof s.lessonPlaceAsked !== 'boolean') s.lessonPlaceAsked = d.lessonPlaceAsked;
  const la = s.lessonArea;
  s.lessonArea = la && typeof la === 'object' && typeof la.name === 'string' && Number.isFinite(la.x) && Number.isFinite(la.z) ? { name: la.name, x: la.x, z: la.z } : null;
  if (typeof s.lessonWatch !== 'boolean') s.lessonWatch = d.lessonWatch;
  return s;
}

/**
 * The settings put back to their defaults ("Reset settings"), except what is
 * the player's own rather than a choice: the language, where the last drive
 * began, the map stored from files, the keys typed in (Tankerkönig,
 * Mapillary) and the answers already given to the game's questions.
 */
export function resetSettings(s: Settings): Settings {
  const r = fresh();
  r.lang = s.lang;
  r.lastStart = { ...s.lastStart };
  r.mapPack = s.mapPack;
  r.region = s.region;
  r.fuelKey = s.fuelKey;
  r.server = s.server;
  r.reality.mapillaryToken = s.reality.mapillaryToken;
  r.lessonPlaceAsked = s.lessonPlaceAsked;
  return r;
}

/** Are there settings of an earlier visit (has this browser played before)? */
export function playedBefore(): boolean {
  try {
    return localStorage.getItem(KEY) !== null || localStorage.getItem(OLD_KEY) !== null;
  } catch {
    return false;
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return merge(JSON.parse(raw) as Partial<Settings>);
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      // Older versions stored every setting, also those nobody had touched.  What was a default
      // then and is another one now (gearbox with clutch help) follows the new default.
      const parsed = JSON.parse(old) as Partial<Settings>;
      if (parsed.transmission === 'assist') delete parsed.transmission;
      const s = merge(parsed);
      saveSettings(s);
      return s;
    }
  } catch {
    /* private mode or corrupted entry: fall back to defaults */
  }
  return fresh();
}

/** false: this browser keeps nothing (private window, storage switched off) */
export function saveSettings(s: Settings): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}
