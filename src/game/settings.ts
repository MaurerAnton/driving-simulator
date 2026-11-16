// SPDX-License-Identifier: AGPL-3.0-only
/** User settings, persisted in localStorage. */
import { LANGS, pickLang } from '../i18n/index.ts';
import { vehicleKind } from './vehicles.ts';
import type { VehicleKind } from './vehicles.ts';

export type Transmission = 'assist' | 'manual' | 'automatic';
/** a preset of the graphics – or 'custom': the advanced settings chosen one by one */
export type Quality = 'low' | 'medium' | 'high' | 'ultra' | 'custom';

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
}

export const GRAPHICS_PRESETS: Record<Exclude<Quality, 'custom'>, Graphics> = {
  low: { shadows: 'off', viewDistance: 700, propDensity: 0.35, facades: false, propShadows: false },
  medium: { shadows: 'near', viewDistance: 1250, propDensity: 0.8, facades: true, propShadows: false },
  high: { shadows: 'far', viewDistance: 2000, propDensity: 1, facades: true, propShadows: true },
  ultra: { shadows: 'far', viewDistance: 3000, propDensity: 1, facades: true, propShadows: true },
};
export const VIEW_DISTANCES = [500, 700, 1000, 1250, 1600, 2000, 2500, 3000];
/** the camera a drive starts with: behind the car, or at the driver's eyes */
export type View = 'chase' | 'cockpit';

/** Engine powers that can be chosen, in PS (metric horsepower) as printed in German vehicle papers. */
export const ENGINE_POWERS = [60, 75, 95, 115, 150, 200] as const;

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
  /** engine power in PS, one of ENGINE_POWERS */
  power: number;
  /** with keys or pedals on the screen the throttle eases off at the current speed limit */
  limiter: boolean;
  view: View;
  /** how solid the interior is drawn in the cockpit view, 0.2 (see-through) … 1 */
  cabinOpacity: number;
  /** where the last drive began: a start point of the map, or an address */
  lastStart: { spawn: number; address: { label: string; street: string; x: number; z: number; exact: boolean } | null };
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
  /** show the engaged gear in the instrument cluster */
  hudGear: boolean;
  /** spoken instructor (browser speech synthesis) */
  voice: boolean;
  volume: number;
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
  reality: { panoramax: boolean; kartaview: boolean; mapillary: boolean; mapillaryToken: string; /** aerial photographs of the land survey under the map */ aerial: boolean };
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
  /** in the driver's seat: the map on the vehicle's own screen (where it has one) instead of the corner */
  mapOnScreen: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  // the first of the browser's languages that the simulator speaks
  lang: typeof navigator !== 'undefined' ? pickLang(navigator.languages?.length ? navigator.languages : [navigator.language]) : 'en',
  // what the playtesters asked for: an automatic, seen from behind, with an engine that is easy to dose
  vehicle: 'car',
  transmission: 'automatic',
  power: 75,
  limiter: true,
  view: 'chase',
  cabinOpacity: 1,
  lastStart: { spawn: 0, address: null },
  quality: 'medium',
  graphics: { ...GRAPHICS_PRESETS.medium },
  uiScale: 1,
  pixelCap: 1.5,
  render3d: 1,
  mirrors: 'alternate',
  hudRules: true,
  hudGear: true,
  voice: false,
  volume: 0.7,
  traffic: 0.6,
  drawDistance: 1300,
  wheel: { steerAxis: 0, throttleAxis: 2, brakeAxis: 5, clutchAxis: 1, pedalsInverted: true, wheelRange: 900, shifter: [12, 13, 14, 15, 16, 17, 18] },
  invertLookY: false,
  reality: { panoramax: false, kartaview: false, mapillary: false, mapillaryToken: '', aerial: false },
  touchControls: 'auto',
  touchOpacity: 0.55,
  keyHints: true,
  showFps: false,
  startOutside: false,
  mapOnScreen: false,
};

const KEY = 'fahrsim-baunatal.settings.v2';
/** settings of the versions before the playtest (other defaults) */
const OLD_KEY = 'fahrsim-baunatal.settings.v1';

function fresh(): Settings {
  return { ...DEFAULT_SETTINGS, wheel: { ...DEFAULT_SETTINGS.wheel }, reality: { ...DEFAULT_SETTINGS.reality }, lastStart: { ...DEFAULT_SETTINGS.lastStart } };
}

/** Defaults, overlaid with what was stored – whatever is missing or implausible keeps its default. */
function merge(parsed: Partial<Settings>): Settings {
  const d = fresh();
  const s: Settings = { ...d, ...parsed, graphics: { ...d.graphics, ...(parsed.graphics ?? {}) }, wheel: { ...d.wheel, ...(parsed.wheel ?? {}) }, reality: { ...d.reality, ...(parsed.reality ?? {}) }, lastStart: { ...d.lastStart, ...(parsed.lastStart ?? {}) } };
  if (!LANGS.some((l) => l.code === s.lang)) s.lang = d.lang;
  if (!(ENGINE_POWERS as readonly number[]).includes(s.power)) s.power = d.power;
  if (s.view !== 'chase' && s.view !== 'cockpit') s.view = d.view;
  if (!vehicleKind(s.vehicle)) s.vehicle = d.vehicle;
  if (!['assist', 'manual', 'automatic'].includes(s.transmission)) s.transmission = d.transmission;
  if (!['low', 'medium', 'high', 'ultra', 'custom'].includes(s.quality)) s.quality = d.quality;
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
  if (!(s.uiScale >= 0.7 && s.uiScale <= 1.6)) s.uiScale = d.uiScale;
  if (![1, 1.5, 3].includes(s.pixelCap)) s.pixelCap = d.pixelCap;
  if (!(s.render3d >= 0.5 && s.render3d <= 1)) s.render3d = d.render3d;
  if (!(s.cabinOpacity >= 0.2 && s.cabinOpacity <= 1)) s.cabinOpacity = d.cabinOpacity;
  if (typeof s.showFps !== 'boolean') s.showFps = d.showFps;
  if (typeof s.startOutside !== 'boolean') s.startOutside = d.startOutside;
  if (typeof s.mapOnScreen !== 'boolean') s.mapOnScreen = d.mapOnScreen;
  if (!Number.isInteger(s.lastStart.spawn) || s.lastStart.spawn < 0) s.lastStart.spawn = 0;
  const a = s.lastStart.address;
  if (a && !(typeof a.label === 'string' && Number.isFinite(a.x) && Number.isFinite(a.z))) s.lastStart.address = null;
  return s;
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
