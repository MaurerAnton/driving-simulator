// SPDX-License-Identifier: AGPL-3.0-only
/** Menus and the in-game HUD (plain DOM, no framework). */
import type { AddressHit, AddressIndex } from '../game/address.ts';
import { LESSONS } from '../game/nav.ts';
import { VEHICLES, VEHICLE_KINDS, powerOf } from '../game/vehicles.ts';
import type { VehicleKind } from '../game/vehicles.ts';
import { RELEASES, VERSION } from '../game/releases.ts';
import type { Settings } from '../game/settings.ts';
import { FAR_VIEWS, GRAPHICS_PRESETS, LOW_RESOLUTIONS, RUN_SPEEDS, VIEW_DISTANCES, saveSettings } from '../game/settings.ts';
import type { Input } from '../input/input.ts';
import type { Violation } from '../sim/rules.ts';
import { SIG } from '../sim/signals.ts';
import type { Lane } from '../world/lanes.ts';
import { CTRL, ROLE } from '../world/types.ts';
import type { SpawnJson } from '../world/types.ts';
import type { World } from '../world/world.ts';
import { addressPicker } from './addresspicker.ts';
import { NoticeBoard, noticeColour } from './notices.ts';
import { LANGS, formatUnit, keyName, lessonIntro, lessonTitle, loadLang, localeOf, tr, violationRef, violationTitle, violationWhy } from '../i18n/index.ts';
import { VIOLATION_REFS, citationParts } from '../i18n/violations.ts';
import type { FaultLog } from '../game/faultlog.ts';
import type { ReplayNote } from '../game/replay.ts';
import { carouselMenu } from './carousel.ts';
import { MiniMap } from './minimap.ts';
import { stageMenu, startFromSpot } from './stage.ts';
import { arcadePanel, type ArcadeHost } from './arcade.ts';
import { locate } from './geolocate.ts';
import { downloaded, formatBytes } from '../game/netstats.ts';
import { WEATHER_ATTRIBUTION } from '../game/weather.ts';

/** the weathers and seasons one may choose, and the names of each */
export const WEATHER_CHOICES: ReadonlyArray<Settings['weather']> = ['real', 'off', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'storm'];
export const WEATHER_KEYS: Record<Settings['weather'], string> = { real: 'weatherReal', off: 'weatherOff', cloudy: 'weatherCloudy', fog: 'weatherFog', drizzle: 'weatherDrizzle', rain: 'weatherRain', snow: 'weatherSnow', storm: 'weatherStorm' };
export const SEASON_CHOICES: ReadonlyArray<Settings['season']> = ['real', 'spring', 'summer', 'autumn', 'winter'];
export const SEASON_KEYS: Record<Settings['season'], string> = { real: 'seasonReal', spring: 'seasonSpring', summer: 'seasonSummer', autumn: 'seasonAutumn', winter: 'seasonWinter' };
import type { MenuPreview } from './carousel.ts';
import type { Lang } from '../i18n/index.ts';
import { FuelGauge } from './fuelgauge.ts';

export interface HudState {
  speedKmh: number;
  rpm: number;
  /** engine speed at which the bar is full (a truck's diesel turns a third as fast as a car's engine) */
  rpmMax?: number;
  gear: string;
  /** km/h; 0 = no limit; -1 = unknown */
  limit: number;
  /** the limit is one of a sign with a time on it: what its panel says ("22–6 h") – shown under the roundel */
  limitWhen?: string;
  zone: number;
  /** the next junction (as the rule monitor tells it: RuleContext.junction) */
  junction: null | { dist: number; role: number; ctrl: number; signal: number; arrow: number; dark: boolean };
  navText: string;
  navSub: string;
  navArrow: number;
  /** a turn is announced (so a notice must not hide it) */
  navActive: boolean;
  tip: string;
  /** what tapping the tip does on a touch screen: a key code ('' = nothing) */
  tipAction: string;
  showDash: boolean;
  /** on foot beside the vehicle: no dashboard strip, no reminder of the driving keys */
  onFoot?: boolean;
  /** no reminder of the driving keys (the tram, the aeroplane) */
  noKeyHints?: boolean;
  indicator: number;
  hazard: boolean;
  blinkOn: boolean;
  handbrake: boolean;
  /** the car is being driven against the handbrake */
  handbrakeWarn: boolean;
  seatbelt: boolean;
  engineOn: boolean;
  lights: boolean;
  points: number;
  faults: number;
  x: number;
  z: number;
  yaw: number;
  /** how full the tank is (0 … 1; none: a vehicle without one) and whether the reserve is reached (game/serviceworld.ts) */
  fuel?: number;
  fuelLow?: boolean;
}

export interface StartRequest {
  mode: string;
  spawn: number;
  /** start at this address instead of one of the car parks */
  address?: AddressHit;
  /** the tram: start at this stop */
  stop?: TramStopChoice;
  /** the aeroplane: start at this end of a runway */
  runway?: RunwayChoice;
}

/** An end of a runway an aeroplane may take off from. */
export interface RunwayChoice {
  /** "Flughafen Kassel (EDVK)", "09" */
  field: string;
  end: string;
  x: number;
  z: number;
  yaw: number;
}

/** A stop the tram may start at (a place of the stops of the map). */
export interface TramStopChoice {
  name: string;
  town: string;
  x: number;
  z: number;
}

/** What the buttons of the replay bar do. */
export interface ReplayBar {
  toggle(): void;
  step(seconds: number): void;
  speed(): void;
  seek(t: number): void;
  camera(): void;
  exit(): void;
}

/** What the replay bar shows: where the replay stands, how fast, which view. */
export interface ReplayState {
  t: number;
  start: number;
  end: number;
  playing: boolean;
  speed: number;
  camera: 'behind' | 'driver' | 'free';
}

export interface ResultSummary {
  title: string;
  exam: boolean;
  passed: boolean;
  log: Violation[];
  points: number;
  distanceKm: number;
  minutes: number;
  /** more to show under the summary (the crane's tasks as they went: game/craneplay.ts) */
  extra?: HTMLElement | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

const ICON: Record<string, string> = {
  yield: '<svg viewBox="0 0 100 90"><path d="M3 3h94L50 87z" fill="#d0141e"/><path d="M20 13h60L50 67z" fill="#fff"/></svg>',
  stop: '<svg viewBox="0 0 100 100"><path d="M30 2h40l28 28v40L70 98H30L2 70V30z" fill="#d0141e" stroke="#fff" stroke-width="4"/><text x="50" y="62" text-anchor="middle" font-size="30" font-weight="800" fill="#fff" font-family="sans-serif">STOP</text></svg>',
  priority: '<svg viewBox="0 0 100 100"><path d="M50 3l47 47-47 47L3 50z" fill="#fff" stroke="#222" stroke-width="2"/><path d="M50 20l30 30-30 30-30-30z" fill="#f6c817"/></svg>',
  rbl: '<svg viewBox="0 0 100 90"><path d="M50 3l47 84H3z" fill="#d0141e"/><path d="M50 22l31 55H19z" fill="#fff"/><path d="M38 70l24-26M62 70L38 44" stroke="#111" stroke-width="7"/></svg>',
  minor: '<svg viewBox="0 0 100 90"><path d="M3 3h94L50 87z" fill="#888"/><path d="M20 13h60L50 67z" fill="#fff"/></svg>',
  roundabout: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="47" fill="#1b5fa8" stroke="#fff" stroke-width="3"/><path d="M50 22a28 28 0 1 1-26 18" fill="none" stroke="#fff" stroke-width="9"/><path d="M14 36l12 12 8-18z" fill="#fff"/></svg>',
};

export class Hud {
  private readonly root: HTMLElement;
  private readonly settings: Settings;
  private readonly world: World;
  private overlay: HTMLElement | null = null;
  private hud: HTMLElement;
  private navArrow!: HTMLElement;
  private navText!: HTMLElement;
  private navSub!: HTMLElement;
  private navBox!: HTMLElement;
  private choiceBox!: HTMLElement;
  private navLong = false;
  private choiceBtn!: HTMLButtonElement;
  private choiceKey = '';
  private choicePick: (id: string) => void = () => {};
  private roundel!: HTMLElement;
  private roundelText = '';
  private ruler: CanvasRenderingContext2D | null = null;
  private zone!: HTMLElement;
  private prio!: HTMLElement;
  /**
   * Notices (faults, hints) take the place of the street name; if several are
   * current, the gravest one shows.
   */
  private readonly notices = new NoticeBoard();
  private navExtra!: HTMLElement;
  private navMeta!: HTMLElement;
  private noticeShown: object | null = null;
  private dash!: HTMLElement;
  private dashV!: HTMLElement;
  private lampBrake!: HTMLElement;
  private lampBelt!: HTMLElement;
  /** the wiper stalk's place (setWipers): made the first time it is asked for */
  private lampWipers: HTMLElement | null = null;
  /** the fuel gauge of the dashboard strip (ui/fuelgauge.ts) */
  private fuelGauge!: FuelGauge;
  private dashG!: HTMLElement;
  private dashRpm!: HTMLElement;
  private indL!: HTMLElement;
  private indR!: HTMLElement;
  private tip!: HTMLElement;
  private tipAction = '';
  private score!: HTMLElement;
  private mapCanvas!: HTMLCanvasElement;
  /** the corner map's photographs, looking round on it and moving it (minimap.ts) */
  private mini!: MiniMap;
  private fpsBox!: HTMLElement;
  /** the touch sheet's starter, and in its place while the engine runs: switching it off */
  private starterBtn: HTMLElement | null = null;
  private engineOffBtn: HTMLElement | null = null;
  /** the world's moment when the arcade mode set another one or runs the time faster (a tap opens the arcade panel) */
  private clockBox!: HTMLButtonElement;
  /** the arcade mode's panel: another moment, faster time (set by the game for free drives) */
  arcade: ArcadeHost | null = null;
  /** the clock in the HUD was tapped: the game pauses and shows the arcade panel */
  onArcade: () => void = () => {};
  /** after the vehicle went up in flames: the button for a new one */
  private wreckBtn!: HTMLButtonElement;
  onNewVehicle: () => void = () => {};
  private keysBox!: HTMLElement;
  private keysFor = '';
  private input: Input | null = null;
  private mode: 'touch' | 'keys' = 'keys';
  private readonly lit = new Map<string, HTMLElement>();
  private moreBox: HTMLElement | null = null;
  private last: HudState | null = null;
  /** free drive: the pause menu offers to jump to an address */
  canTeleport = false;
  /** fetches the address list when somebody starts typing an address */
  loadAddresses: () => Promise<AddressIndex | null> = async () => null;
  private lastDom = 0;
  private lastMap = 0;
  private lastPrio = '';
  onStart: (req: StartRequest) => void = () => {};
  onResume: () => void = () => {};
  onQuit: () => void = () => {};
  /** watch the drive again (null: nothing recorded yet) */
  onReplay: (() => void) | null = null;
  /** the menu of rows: the vehicle chosen and where it would start, for the scene behind (null: the simple menu, no vehicle shown) */
  onMenuPreview: (p: MenuPreview | null) => void = () => {};
  onReality: () => void = () => {};
  /** get out of the vehicle (offered in the pause menu while it stands) */
  onGetOut: (() => void) | null = null;
  /** the faults of this and of earlier drives (set by the game) */
  faultLog: FaultLog | null = null;
  /** open the full-screen map */
  /**
   * The gearbox of the vehicle that is being driven, where it is not the one
   * of the settings: the truck's is automatic, and so is the car's on a
   * demonstration drive.  (The key reminder goes by it.)
   */
  gearbox: Settings['transmission'] | null = null;
  onMap: () => void = () => {};
  /** plan a demonstration drive (opens the map with its panel for that) */
  onDemo: () => void = () => {};
  /** end a free drive and show its result */
  onFinish: () => void = () => {};
  /** a free drive is running (it has no destination that would end it) */
  canFinish = false;
  onPause: () => void = () => {};
  onTeleport: (a: AddressHit) => void = () => {};
  /** where the vehicle is (for the search for addresses: what lies near comes first) */
  where: () => { x: number; z: number } | null = () => null;
  onSettingsChanged: () => void = () => {};
  routeLanes: Lane[] = [];
  /** the stops trams call at, by town and name – null until the map's list of stops is read */
  private tramStops: TramStopChoice[] | null = null;
  /** draws the menu again (while it is open) */
  private menuRedraw: (() => void) | null = null;
  /** the ends of the runways of the map's airfields – null until they are read */
  private runways: RunwayChoice[] | null = null;

  constructor(root: HTMLElement, settings: Settings, world: World) {
    this.root = root;
    this.settings = settings;
    this.world = world;
    this.hud = this.buildHud();
    this.root.append(this.hud);
    this.setHudVisible(false);
  }

  get lang(): Lang {
    return this.settings.lang;
  }

  private t(key: string, p?: Record<string, string | number>): string {
    return tr(key, this.lang, p);
  }

  /**
   * Font size at which a word ("walk", "none" – in any language and script)
   * fits into the speed-limit roundel: it may wrap at spaces, the widest word
   * must fit the width and the lines the height.
   */
  private fitRoundel(text: string): number {
    const WIDTH = 43;
    const HEIGHT = 38;
    this.ruler ??= document.createElement('canvas').getContext('2d');
    const c = this.ruler;
    if (!c) return 11;
    const family = getComputedStyle(this.roundel).fontFamily || 'sans-serif';
    const words = text.split(/\s+/).filter(Boolean);
    for (let px = 13; px > 7; px--) {
      c.font = `800 ${px}px ${family}`;
      const space = c.measureText(' ').width;
      let lines = 1;
      let line = 0;
      let widest = 0;
      for (const w of words) {
        const width = c.measureText(w).width;
        widest = Math.max(widest, width);
        if (line > 0 && line + space + width > WIDTH) {
          lines++;
          line = width;
        } else line += (line > 0 ? space : 0) + width;
      }
      if (widest <= WIDTH && lines * px * 1.1 <= HEIGHT) return px;
    }
    return 7;
  }

  // ---------------------------------------------------------------- overlays
  /** The ends of the runways (from the map): the start points of the aeroplane. */
  setRunways(list: RunwayChoice[]): void {
    this.runways = list;
    if (this.menuRedraw && VEHICLES[this.settings.vehicle]?.kind === 'plane') this.menuRedraw();
  }

  /** The stops trams call at (from the map): the start points of the tram. */
  setTramStops(list: TramStopChoice[]): void {
    this.tramStops = list;
    if (this.menuRedraw && VEHICLES[this.settings.vehicle]?.kind === 'tram') this.menuRedraw();
  }

  private setOverlay(node: HTMLElement | null): void {
    this.menuRedraw = null;
    this.overlay?.remove();
    this.overlay = node;
    if (node) this.root.append(node);
  }

  get menuOpen(): boolean {
    return this.overlay !== null;
  }

  showLoading(text: string): void {
    this.loadShown = 0;
    const o = el('div', 'overlay solid');
    const p = el('div', 'panel narrow');
    const bar = el('div', 'progress', '<i></i>');
    const pct = el('small', 'progress-pct', '');
    p.append(el('h1', '', 'Fahrsim <span>Baunatal</span>'), el('p', '', text), bar, pct);
    o.append(p);
    this.setOverlay(o);
    this.loadingBar = { bar, pct };
  }

  /** How far the loading is (0 … 1): the bar of the loading screen fills, and says so in per cent. */
  setLoadingProgress(share: number): void {
    const l = this.loadingBar;
    if (!l || !l.bar.isConnected) return;
    // (the share is put together from the roads and the tiles, which come at their own pace: it is shown only ever growing)
    this.loadShown = Math.max(this.loadShown, Math.max(0, Math.min(1, share)));
    const p = Math.round(this.loadShown * 100);
    l.bar.classList.add('known');
    (l.bar.firstElementChild as HTMLElement).style.width = `${p}%`;
    l.pct.textContent = `${p} % · ${formatBytes(downloaded(), localeOf(this.lang))}`;
  }

  private loadingBar: { bar: HTMLElement; pct: HTMLElement } | null = null;
  /** the largest share shown on the loading screen, and behind the menu, since each loading began */
  private loadShown = 0;
  private menuShown = 0;

  /** Behind the menu of rows: how far the surroundings of the start place are loaded (null: done). */
  setMenuLoading(share: number | null): void {
    const e = this.root.querySelector<HTMLElement>('.cm-loading');
    if (!e) return;
    // (only ever growing while the place loads; null: done – the next place counts from 0)
    this.menuShown = share === null ? 0 : Math.max(this.menuShown, Math.max(0, Math.min(1, share)));
    const text = share === null ? '' : `${this.t('loadingTiles')} ${Math.round(this.menuShown * 100)} % · ${formatBytes(downloaded(), localeOf(this.lang))}`;
    if (e.textContent !== text) e.textContent = text;
  }

  showError(text: string): void {
    const o = el('div', 'overlay solid');
    const p = el('div', 'panel narrow');
    p.append(el('h1', '', 'Fahrsim <span>Baunatal</span>'), el('p', '', text));
    o.append(p);
    this.setOverlay(o);
  }

  showMenu(spawns: SpawnJson[]): void {
    if (this.settings.menuStyle === 'stage') {
      this.showStage(spawns);
      return;
    }
    if (this.settings.menuStyle === 'carousel') {
      this.showCarousel(spawns);
      return;
    }
    this.onMenuPreview(null);
    const o = el('div', 'overlay');
    const p = el('div', 'panel');
    // the language first: whoever cannot read the page must be able to find it
    p.append(this.languagePicker(() => this.showMenu(spawns)));
    p.append(el('h1', '', 'Fahrsim <span>Baunatal</span>'), el('p', '', this.t('subtitle')));
    // where the last drive began – also after the page was closed
    const last = this.settings.lastStart;
    let spawn = Math.min(last.spawn, Math.max(0, spawns.length - 1));
    const remember = (): void => {
      last.spawn = spawn;
      last.address = address ?? null;
      saveSettings(this.settings);
    };

    const opts = el('div');
    const rowSpawn = el('div', 'row');
    const selSpawn = el('select');
    // (a large map has hundreds of them: grouped by town, in the order the map lists them)
    let group: HTMLOptGroupElement | null = null;
    spawns.forEach((s, i) => {
      const op = el('option');
      op.value = String(i);
      op.textContent = s.name;
      if (s.g && group?.label !== s.g) {
        group = document.createElement('optgroup');
        group.label = s.g;
        selSpawn.append(group);
      } else if (!s.g) group = null;
      (group ?? selSpawn).append(op);
    });
    selSpawn.value = String(spawn);
    let address: AddressHit | undefined = last.address ?? undefined;
    const atAddress = el('option');
    atAddress.value = 'address';
    if (address) {
      atAddress.textContent = address.label;
      selSpawn.append(atAddress);
      selSpawn.value = 'address';
    }
    selSpawn.onchange = () => {
      if (selSpawn.value === 'address') return;
      spawn = Number(selSpawn.value);
      address = undefined;
      remember();
    };
    rowSpawn.append(el('label', '', this.t('startPoint')), selSpawn);
    // the tram starts at one of its stops: those of the map, by town (the car parks above are for road vehicles)
    const tramMode = (VEHICLES[this.settings.vehicle] ?? VEHICLES.car).kind === 'tram';
    const planeMode = (VEHICLES[this.settings.vehicle] ?? VEHICLES.car).kind === 'plane';
    let stop: TramStopChoice | undefined;
    let runway: RunwayChoice | undefined;
    const rowStop = el('div', 'row');
    if (planeMode) {
      // the aeroplane begins at the end of a runway of one of the map's airfields
      const sel = el('select');
      const list = this.runways;
      if (!list || list.length === 0) {
        const op = el('option');
        op.textContent = list ? '–' : this.t('realityLoading');
        op.disabled = true;
        sel.append(op);
      } else {
        let g: HTMLOptGroupElement | null = null;
        list.forEach((r, i) => {
          if (g?.label !== r.field) {
            g = document.createElement('optgroup');
            g.label = r.field;
            sel.append(g);
          }
          const op = el('option');
          op.value = String(i);
          op.textContent = this.t('runwayEnd', { end: r.end });
          g.append(op);
        });
        const key = (r: RunwayChoice): string => `${r.field}|${r.end}`;
        let at = list.findIndex((r) => key(r) === last.runway);
        if (at < 0) at = 0;
        runway = list[at];
        sel.value = String(at);
        sel.onchange = () => {
          runway = list[Number(sel.value)];
          last.runway = runway ? key(runway) : undefined;
          saveSettings(this.settings);
        };
      }
      rowStop.append(el('label', '', this.t('startPoint')), sel);
    } else if (tramMode) {
      const selStop = el('select');
      const stops = this.tramStops;
      if (!stops || stops.length === 0) {
        const op = el('option');
        op.textContent = stops ? '–' : this.t('realityLoading');
        op.disabled = true;
        selStop.append(op);
      } else {
        let g: HTMLOptGroupElement | null = null;
        stops.forEach((s, i) => {
          const op = el('option');
          op.value = String(i);
          op.textContent = s.name;
          if (g?.label !== s.town) {
            g = document.createElement('optgroup');
            g.label = s.town;
            selStop.append(g);
          }
          g.append(op);
        });
        // (the stop of the last drive – else one in the middle of Kassel)
        const key = (s: TramStopChoice): string => `${s.name}|${s.town}`;
        let at = stops.findIndex((s) => key(s) === last.tramStop);
        if (at < 0) at = Math.max(0, stops.findIndex((s) => s.name === 'Königsplatz'));
        stop = stops[at];
        selStop.value = String(at);
        selStop.onchange = () => {
          stop = stops[Number(selStop.value)];
          last.tramStop = stop ? key(stop) : undefined;
          saveSettings(this.settings);
        };
      }
      rowStop.append(el('label', '', this.t('startPoint')), selStop);
    }
    // … or anywhere: street and house number
    const rowAddr = el('div', 'row');
    const picker = addressPicker({
      placeholder: this.t('addressPlaceholder'),
      loading: this.t('realityLoading'),
      none: this.t('addressNone'),
      load: () => this.loadAddresses(),
      // (every town has its Marktplatz: the one near the start point chosen comes first)
      near: () => spawns[spawn] ?? null,
      pick: (hit) => {
        address = hit;
        atAddress.textContent = hit.label;
        if (!atAddress.parentNode) selSpawn.append(atAddress);
        selSpawn.value = 'address';
        remember();
      },
    });
    rowAddr.append(el('label', '', this.t('startAddress')), picker.node);
    const rowTr = el('div', 'row');
    const selTr = el('select');
    for (const [v, k] of [['assist', 'trAssist'], ['manual', 'trManual'], ['automatic', 'trAutomatic']]) {
      const op = el('option');
      op.value = v;
      op.textContent = this.t(k);
      selTr.append(op);
    }
    selTr.value = this.settings.transmission;
    selTr.onchange = () => {
      this.settings.transmission = selTr.value as Settings['transmission'];
      saveSettings(this.settings);
    };
    rowTr.append(el('label', '', this.t('transmission')), selTr);
    // the vehicle of a licence class – the truck with its trailer (class CE) with lessons of its own
    const def = VEHICLES[this.settings.vehicle] ?? VEHICLES.car;
    const truck = def.model !== 'car' && def.model !== 'motorcycle';
    const rowVeh = el('div', 'row');
    const selVeh = el('select');
    for (const v of VEHICLE_KINDS) {
      const op = el('option');
      op.value = v;
      op.textContent = this.t(VEHICLES[v].name);
      selVeh.append(op);
    }
    selVeh.value = this.settings.vehicle;
    selVeh.onchange = () => {
      this.settings.vehicle = selVeh.value as Settings['vehicle'];
      saveSettings(this.settings);
      this.showMenu(spawns);
    };
    rowVeh.append(el('label', '', this.t('vehicle')), selVeh);
    // (trucks, buses and tractors have automated gearboxes, as nearly all of them today)
    opts.append(...(tramMode || planeMode ? [rowStop, rowVeh] : [rowSpawn, rowAddr, rowVeh]));
    if (tramMode) {
      // the tram: one unit, two coupled, or one with a trailer car
      const rowSet = el('div', 'row');
      const selSet = el('select');
      for (const [v, k] of [['single', 'tramSetSingle'], ['double', 'tramSetDouble'], ['trailer', 'tramSetTrailer']]) {
        const op = el('option');
        op.value = v;
        op.textContent = this.t(k);
        selSet.append(op);
      }
      selSet.value = this.settings.tramSet;
      selSet.onchange = () => {
        this.settings.tramSet = selSet.value as Settings['tramSet'];
        saveSettings(this.settings);
      };
      rowSet.append(el('label', '', this.t('tramSet')), selSet);
      opts.append(rowSet);
    }
    // its engine: the powers a vehicle of its class may have, each kind of vehicle with its own
    if (def.powers.length > 1) {
      const rowPw = el('div', 'row');
      const selPw = el('select');
      for (const ps of def.powers) {
        const op = el('option');
        op.value = String(ps);
        op.textContent = `${ps} PS (${Math.round(ps * 0.7355)} kW)`;
        selPw.append(op);
      }
      selPw.value = String(powerOf(def, this.settings.powers));
      selPw.onchange = () => {
        this.settings.powers[def.kind] = Number(selPw.value);
        saveSettings(this.settings);
      };
      rowPw.append(el('label', '', this.t('enginePower')), selPw);
      opts.append(rowPw);
    }
    if (!truck) opts.append(rowTr);
    p.append(opts);

    p.append(el('h2', '', this.t('start')));
    const cards = el('div', 'cards');
    const card = (title: string, desc: string, mode: string): void => {
      const c = el('button', 'card');
      const b = el('b');
      b.textContent = title;
      const d = el('small');
      d.textContent = desc;
      c.append(b, d);
      c.onclick = () => this.onStart(planeMode ? { mode, spawn, runway } : tramMode ? { mode, spawn, stop } : { mode, spawn, address });
      cards.append(c);
    };
    card(this.t(def.kind === 'plane' ? 'freeFly' : 'free'), this.t(def.kind === 'tram' ? 'freeTramDesc' : def.kind === 'pedestrian' ? 'freeWalkDesc' : def.kind === 'plane' ? 'freeFlyDesc' : 'freeDesc'), 'free');
    // (the drives the car does by itself, and the tours, are on the roads – and by car)
    if (def.kind === 'tram') card(this.t('demo'), this.t('demoTramDesc'), 'demo');
    if (def.kind === 'plane') card(this.t('demoFly'), this.t('demoFlyDesc'), 'demo');
    if (def.kind !== 'tram' && def.kind !== 'pedestrian' && def.kind !== 'plane') {
      card(this.t('demo'), this.t('demoDesc'), 'demo');
      card(this.t('tourTitle'), this.t('tourDesc'), 'tour');
    }
    // the theory lessons: difficult situations shown on the practice yard (game/theorymode.ts)
    if (def.kind !== 'plane' && this.world.json.yard) card(this.t('theory.title'), this.t('theory.desc'), 'theory');
    // the test place: every model of the game on the practice yard – on foot or with a vehicle of the road
    if (def.kind !== 'tram' && def.kind !== 'plane' && this.world.json.yard) card(this.t('showTitle'), this.t('showDesc'), 'show');
    // the lessons of the chosen vehicle: the practice yard first, the test last
    const rank = (kind: string): number => (kind === 'yard' ? 0 : kind === 'exam' ? 2 : 1);
    const kind = def.kind;
    const lessons = LESSONS.filter((l) => (l.vehicles ? l.vehicles.includes(kind) : l.vehicle ? l.vehicle === kind : kind !== 'tram' && kind !== 'pedestrian' && kind !== 'plane' && !(l.notFor ?? []).includes(kind)) && (l.kind !== 'yard' || !!this.world.json.yard)).sort((a, b) => rank(a.kind) - rank(b.kind));
    // (the lessons on the road were written for the car: what is different with this vehicle is said first)
    const note = def.caps ? `${this.t('lesson.capNote', { vehicle: this.t(def.name), rural: def.caps.rural, motorway: def.caps.motorway })} ` : def.noMotorway ? `${this.t('lesson.slowNote', { vehicle: this.t(def.name), max: def.governed })} ` : '';
    for (const l of lessons) card(lessonTitle(l.id, this.lang), l.id === 'exam' ? this.t('examDesc') : `${l.kind === 'route' ? note : ''}${lessonIntro(l.id, this.lang)}`, l.id);
    p.append(cards);

    const b = el('div', 'buttons');
    const bs = el('button', 'btn ghost', this.t('settings'));
    bs.onclick = () => this.showSettings(() => this.showMenu(spawns));
    const bc = el('button', 'btn ghost', this.t('controls'));
    bc.onclick = () => this.showControls(() => this.showMenu(spawns));
    const ba = el('button', 'btn ghost', this.t('about'));
    ba.onclick = () => this.showAbout(() => this.showMenu(spawns));
    const bn = el('button', 'btn ghost', this.t('news'));
    bn.onclick = () => this.showNews(() => this.showMenu(spawns));
    const bl = el('button', 'btn ghost', this.t('logTitle'));
    bl.onclick = () => this.showLog(() => this.showMenu(spawns));
    b.append(bs, bc, bl, bn, ba);
    p.append(b);
    p.append(el('p', 'version', this.t('newsVersion', { v: VERSION })));
    o.append(p);
    this.setOverlay(o);
    this.menuRedraw = () => this.showMenu(spawns);
  }

  /** The main menu in rows of cards over the 3D scene (ui/carousel.ts). */
  private showCarousel(spawns: SpawnJson[]): void {
    const o = el('div', 'overlay clear');
    const redraw = (): void => this.showMenu(spawns);
    o.append(
      carouselMenu({
        lang: this.lang,
        t: (k, vars) => this.t(k, vars),
        settings: this.settings,
        spawns,
        tramStops: this.tramStops,
        runways: this.runways,
        hasYard: !!this.world.json.yard,
        language: this.languagePicker(redraw),
        address: (pick) =>
          addressPicker({
            placeholder: this.t('addressPlaceholder'),
            loading: this.t('realityLoading'),
            none: this.t('addressNone'),
            load: () => this.loadAddresses(),
            near: () => spawns[this.settings.lastStart.spawn] ?? null,
            pick,
          }).node,
        tools: [
          [this.t('settings'), () => this.showSettings(redraw)],
          [this.t('controls'), () => this.showControls(redraw)],
          [this.t('logTitle'), () => this.showLog(redraw)],
          [this.t('news'), () => this.showNews(redraw)],
          [this.t('about'), () => this.showAbout(redraw)],
        ],
        version: this.t('newsVersion', { v: VERSION }),
        start: (req) => this.onStart(req),
        preview: (p) => this.onMenuPreview(p),
        redraw,
      }),
    );
    this.setOverlay(o);
    this.menuRedraw = redraw;
  }

  /** The main menu as a stage: the vehicle large in the 3D picture, icons round it (ui/stage.ts). */
  private showStage(spawns: SpawnJson[]): void {
    const o = el('div', 'overlay clear');
    const redraw = (): void => this.showMenu(spawns);
    o.append(
      stageMenu({
        lang: this.lang,
        t: (k, vars) => this.t(k, vars),
        settings: this.settings,
        spawns,
        tramStops: this.tramStops,
        runways: this.runways,
        hasYard: !!this.world.json.yard,
        language: this.languagePicker(redraw),
        address: (pick) =>
          addressPicker({
            placeholder: this.t('addressPlaceholder'),
            loading: this.t('realityLoading'),
            none: this.t('addressNone'),
            load: () => this.loadAddresses(),
            near: () => spawns[this.settings.lastStart.spawn] ?? null,
            pick,
          }).node,
        pages: {
          settings: () => this.showSettings(redraw),
          news: () => this.showNews(redraw),
          map: () => this.onMap(),
          controls: () => this.showControls(redraw),
          log: () => this.showLog(redraw),
          about: () => this.showAbout(redraw),
        },
        here: async () => {
          const r = await locate(this.world.json.meta);
          if (r.ok) return { hit: { label: this.t('myLocation'), street: '', x: r.x, z: r.z, exact: false } };
          return { error: this.t(r.why === 'outside' ? 'myLocationOutside' : r.why === 'denied' ? 'myLocationDenied' : 'myLocationNone') };
        },
        // the theory lessons: difficult situations shown on the practice yard (game/theorymode.ts) – for everything but the aeroplane
        extraModes: [{ id: 'theory', label: this.t('theory.title'), yard: true, kinds: VEHICLE_KINDS.filter((k) => k !== 'plane') }],
        version: this.t('newsVersion', { v: VERSION }),
        start: (req) => this.onStart(req),
        preview: (p) => this.onMenuPreview(p),
        redraw,
      }),
    );
    this.setOverlay(o);
    this.menuRedraw = redraw;
  }

  /** The map opened from the main menu: the drive is to begin at this place of it (the tram at the stop, the aeroplane at the runway nearest to it). */
  menuStartAt(spot: SpawnJson): void {
    const kind = (VEHICLES[this.settings.vehicle] ?? VEHICLES.car).kind;
    if (startFromSpot(kind, this.settings.lastStart, spot, this.tramStops, this.runways, this.t('mapPlace'))) saveSettings(this.settings);
  }

  /**
   * The list of languages, each under its own name.  Choosing one fetches its
   * texts and draws the current page again.
   */
  private languagePicker(redraw: () => void, inRow = false): HTMLElement {
    const sel = el('select', inRow ? '' : 'lang');
    sel.setAttribute('aria-label', 'Language · Sprache');
    for (const l of LANGS) {
      const op = el('option');
      op.value = l.code;
      op.textContent = l.name;
      op.lang = l.code;
      sel.append(op);
    }
    sel.value = this.settings.lang;
    sel.onchange = () => {
      const code = sel.value;
      void loadLang(code).then((ok) => {
        if (ok) {
          this.settings.lang = code;
          saveSettings(this.settings);
          this.onSettingsChanged();
        }
        redraw();
      });
    };
    return sel;
  }

  /** Key caps for the keys with these codes, as printed on the player's keyboard. */
  private keycaps(...codes: string[]): HTMLElement[] {
    return codes.map((c) => {
      const k = el('kbd');
      k.textContent = keyName(c, this.lang);
      return k;
    });
  }

  showSettings(back: () => void): void {
    const s = this.settings;
    const o = el('div', 'overlay');
    const p = el('div', 'panel narrow');
    p.append(el('h1', '', this.t('settings')));
    const select = (label: string, value: string, options: Array<[string, string]>, set: (v: string) => void): void => {
      const row = el('div', 'row');
      const sel = el('select');
      for (const [v, text] of options) {
        const op = el('option');
        op.value = v;
        op.textContent = text;
        sel.append(op);
      }
      sel.value = value;
      sel.onchange = () => {
        set(sel.value);
        saveSettings(s);
        this.onSettingsChanged();
      };
      row.append(el('label', '', label), sel);
      p.append(row);
    };
    const check = (label: string, value: boolean, set: (v: boolean) => void): void => {
      const row = el('div', 'row');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = value;
      c.onchange = () => {
        set(c.checked);
        saveSettings(s);
        this.onSettingsChanged();
      };
      const l = el('label', '', label);
      l.style.minWidth = '0';
      l.style.flex = '1';
      row.append(c, l);
      p.append(row);
    };
    const range = (label: string, value: number, set: (v: number) => void): void => {
      const row = el('div', 'row');
      const r = el('input');
      r.type = 'range';
      r.min = '0';
      r.max = '1';
      r.step = '0.05';
      r.value = String(value);
      r.oninput = () => {
        set(Number(r.value));
        saveSettings(s);
        this.onSettingsChanged();
      };
      row.append(el('label', '', label), r);
      p.append(row);
    };
    {
      const row = el('div', 'row');
      row.append(el('label', '', this.t('language')), this.languagePicker(() => this.showSettings(back), true));
      p.append(row);
    }
    select(this.t('transmission'), s.transmission, [['assist', this.t('trAssist')], ['manual', this.t('trManual')], ['automatic', this.t('trAutomatic')]], (v) => (s.transmission = v as Settings['transmission']));
    p.append(el('p', 'note', this.t('settingsNextDrive')));
    check(this.t('limiter'), s.limiter, (v) => (s.limiter = v));
    check(this.t('autopilotAssist'), s.autopilotAssist, (v) => (s.autopilotAssist = v));
    // the main beam on and off by itself at night (game/beamplay.ts)
    check(this.t('beam.assist'), s.beamAssist, (v) => (s.beamAssist = v));
    // the aeroplane by hand: how much the help does
    select(this.t('flightAssist'), s.flightAssist, [['beginner', this.t('flightAssistBeginner')], ['light', this.t('flightAssistLight')], ['off', this.t('flightAssistOff')]], (v) => (s.flightAssist = v as Settings['flightAssist']));
    // the light: the game's fair afternoon, or the sun as it stands at the time (the arcade mode's chosen time always has its own)
    select(this.t('daylight'), s.daylight, [['day', this.t('daylightDay')], ['clock', this.t('daylightClock')]], (v) => (s.daylight = v as Settings['daylight']));
    // on foot: how fast running is
    select(this.t('runSpeed'), String(s.runSpeed), RUN_SPEEDS.map((k): [string, string] => [String(k), `${k} km/h`]), (v) => (s.runSpeed = Number(v)));
    // the main menu: the vehicle large in the 3D picture with icons, rows over the 3D scene, or the simple list of before
    select(this.t('menuStyle'), s.menuStyle, [['stage', this.t('menuStage')], ['carousel', this.t('menuCarousel')], ['classic', this.t('menuClassic')]], (v) => (s.menuStyle = v as Settings['menuStyle']));
    // the picture
    select(this.t('startView'), s.view, [['chase', this.t('viewChase')], ['cockpit', this.t('viewCockpit')]], (v) => (s.view = v as Settings['view']));
    range(this.t('cabinOpacity'), (s.cabinOpacity - 0.2) / 0.8, (v) => (s.cabinOpacity = 0.2 + 0.8 * v));
    // Graphics: a preset – and, apart from it, the resolutions; the parts of the preset one by one below
    select(this.t('quality'), s.quality, [['low', this.t('qLow')], ['medium', this.t('qMedium')], ['high', this.t('qHigh')], ['ultra', this.t('qUltra')], ['custom', this.t('qCustom')]], (v) => {
      s.quality = v as Settings['quality'];
      if (v !== 'custom') s.graphics = { ...GRAPHICS_PRESETS[v as Exclude<Settings['quality'], 'custom'>] };
      // (the low preset is for weak phones: the resolutions go down with it)
      if (v === 'low') {
        s.pixelCap = LOW_RESOLUTIONS.pixelCap;
        s.render3d = LOW_RESOLUTIONS.render3d;
      }
      // (the advanced settings below show the preset's values)
      queueMicrotask(() => this.showSettings(back));
    });
    const pct = (list: number[]): Array<[string, string]> => list.map((n) => [String(n), `${Math.round(n * 100)} %`]);
    select(this.t('uiScale'), String(s.uiScale), pct([0.75, 0.85, 1, 1.15, 1.3, 1.5]), (v) => (s.uiScale = Number(v)));
    select(this.t('pixelCap'), String(s.pixelCap), [['1', this.t('pixelStandard')], ['1.5', this.t('pixelSharp')], ['3', this.t('pixelNative')]], (v) => (s.pixelCap = Number(v)));
    select(this.t('render3d'), String(s.render3d), pct([0.5, 0.6, 0.7, 0.8, 0.9, 1]), (v) => (s.render3d = Number(v)));
    {
      // the advanced graphics settings, folded away; changing one makes the preset "custom"
      const box = el('details', 'advanced');
      box.append(el('summary', '', this.t('gfxAdvanced')));
      const at = p.childElementCount;
      const g = s.graphics;
      const custom = (f: () => void) => (): void => {
        f();
        s.quality = 'custom';
      };
      select(this.t('gfxShadows'), g.shadows, [['off', this.t('shadowsOff')], ['near', this.t('shadowsNear')], ['far', this.t('shadowsFar')]], (v) => custom(() => (g.shadows = v as typeof g.shadows))());
      select(this.t('gfxView'), String(g.viewDistance), VIEW_DISTANCES.map((d): [string, string] => [String(d), `${d} m`]), (v) => custom(() => (g.viewDistance = Number(v)))());
      select(this.t('gfxTrees'), String(g.propDensity), pct([0, 0.35, 0.6, 0.8, 1]), (v) => custom(() => (g.propDensity = Number(v)))());
      check(this.t('gfxFacades'), g.facades, (v) => custom(() => (g.facades = v))());
      check(this.t('gfxPropShadows'), g.propShadows, (v) => custom(() => (g.propShadows = v))());
      // the ground beyond the map: the hills on the horizon
      select(this.t('gfxFar'), String(g.farView), FAR_VIEWS.map((m): [string, string] => [String(m), m === 0 ? this.t('farOff') : `${m / 1000} km`]), (v) => custom(() => (g.farView = Number(v)))());
      // the player's vehicles in finer detail, outside and in the cockpit (on "very high")
      check(this.t('gfxVehicleDetail'), g.vehicleDetail, (v) => custom(() => (g.vehicleDetail = v))());
      // real water: ripples, the sky mirrored, the sun glinting (on "very high")
      check(this.t('gfxWater'), g.water, (v) => custom(() => (g.water = v))());
      // (the rows were added to the panel: into the folded box with them)
      while (p.childElementCount > at) box.append(p.children[at]);
      p.append(box);
    }
    select(this.t('mirrors'), s.mirrors, [['off', this.t('mOff')], ['alternate', this.t('mAlt')], ['full', this.t('mFull')]], (v) => (s.mirrors = v as Settings['mirrors']));
    range(this.t('traffic'), s.traffic, (v) => (s.traffic = v));
    range(this.t('volume'), s.volume, (v) => (s.volume = v));
    // music made as it plays: off unless asked for
    select(this.t('music'), s.music, [['off', this.t('musicOff')], ['quiet', this.t('musicQuiet')], ['on', this.t('musicOn')]], (v) => (s.music = v as Settings['music']));
    range(this.t('musicVolume'), s.musicVolume, (v) => (s.musicVolume = v));
    // the weather – the real one comes from Open-Meteo (CC BY 4.0), which learns the IP address and the area – and the season
    select(this.t('weather'), s.weather, WEATHER_CHOICES.map((k): [string, string] => [k, this.t(WEATHER_KEYS[k])]), (v) => (s.weather = v as Settings['weather']));
    const credit = el('p', 'note');
    const link = el('a', '', this.t('weatherCredit'));
    link.href = WEATHER_ATTRIBUTION.url;
    link.target = '_blank';
    link.rel = 'noopener';
    const lic = el('a', '', WEATHER_ATTRIBUTION.licence);
    lic.href = WEATHER_ATTRIBUTION.licenceUrl;
    lic.target = '_blank';
    lic.rel = 'noopener';
    credit.append(link, ' (', lic, ') – ', this.t('weatherNote'));
    p.append(credit);
    select(this.t('season'), s.season, SEASON_CHOICES.map((k): [string, string] => [k, this.t(SEASON_KEYS[k])]), (v) => (s.season = v as Settings['season']));
    // today's fuel prices: with one's own key of Tankerkönig (free, asked for there) – else typical prices
    {
      const row = el('label', 'row');
      const input = el('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.value = s.fuelKey;
      input.placeholder = '00000000-0000-0000-0000-000000000000';
      input.onchange = () => {
        s.fuelKey = input.value.trim();
        saveSettings(s);
      };
      row.append(el('span', '', this.t('fuelKey')), input);
      p.append(row);
      const note = el('p', 'note');
      const a = el('a', '', 'creativecommons.tankerkoenig.de');
      a.href = 'https://creativecommons.tankerkoenig.de';
      a.target = '_blank';
      a.rel = 'noopener';
      note.append(this.t('fuelKeyNote'), ' ', a);
      p.append(note);
    }
    select(this.t('touchControls'), s.touchControls, [['auto', this.t('tcAuto')], ['on', this.t('tcOn')], ['off', this.t('tcOff')]], (v) => (s.touchControls = v as Settings['touchControls']));
    range(this.t('touchOpacity'), s.touchOpacity, (v) => (s.touchOpacity = Math.max(0.15, v)));
    check(this.t('keyHints'), s.keyHints, (v) => (s.keyHints = v));
    check(this.t('showFps'), s.showFps, (v) => (s.showFps = v));
    check(this.t('startOutside'), s.startOutside, (v) => (s.startOutside = v));
    check(this.t('mapOnScreen'), s.mapOnScreen, (v) => (s.mapOnScreen = v));
    // the aerial photographs under the maps – and where they come from
    check(this.t('mapAerialSetting'), s.reality.aerial, (v) => (s.reality.aerial = v));
    p.append(el('p', 'note', this.t('mapAerialNote')));
    check(this.t('hudRules'), s.hudRules, (v) => (s.hudRules = v));
    check(this.t('signalTimers'), s.signalTimers, (v) => (s.signalTimers = v));
    check(this.t('queueLabels'), s.queueLabels, (v) => (s.queueLabels = v));
    check(this.t('hudGear'), s.hudGear, (v) => (s.hudGear = v));
    check(this.t('voice'), s.voice, (v) => (s.voice = v));
    // settings live in the browser's storage; say so if this browser keeps none
    if (!saveSettings(s)) p.append(el('p', 'note warn', this.t('settingsNotSaved')));
    const b = el('div', 'buttons');
    const bb = el('button', 'btn', this.t('back'));
    bb.onclick = back;
    b.append(bb);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
  }

  showControls(back: () => void): void {
    const k = (...codes: string[]): HTMLElement[] => this.keycaps(...codes);
    const cap = (text: string): HTMLElement => el('kbd', '', text);
    // every key and every button of the game, by where it works – what it does, and when (the text of the row says both)
    type Row = [Array<HTMLElement | string>, string];
    const sections: Array<[string, Row[]]> = [
      [
        'ctl.section.drive',
        [
          [[...k('KeyW', 'KeyS'), ' / ', ...k('ArrowUp', 'ArrowDown')], 'ctl.throttleBrake'],
          [[...k('KeyA', 'KeyD'), ' / ', ...k('ArrowLeft', 'ArrowRight')], 'ctl.steer'],
          [k('ShiftLeft'), 'ctl.clutch'],
          [k('KeyE', 'KeyQ'), 'ctl.gearUpDown'],
          [[...k('Digit1'), '–', ...k('Digit6'), ' ', ...k('KeyR'), ' ', ...k('KeyN')], 'ctl.gearDirect'],
          [k('KeyP'), 'ctl.park'],
          [k('Space'), 'ctl.handbrake'],
          [[...k('Enter'), ' / ', ...k('KeyI')], 'ctl.engine'],
          [[...k('KeyZ', 'KeyC'), ' / ', ...k('KeyX')], 'ctl.indicators'],
          [k('KeyJ', 'KeyK'), 'ctl.look'],
          [k('KeyU'), 'ctl.lookBack'],
          [k('KeyY'), 'ctl.mirror'],
          [k('KeyB'), 'ctl.belt'],
          [[...k('KeyL'), ' / ', ...k('KeyO')], 'ctl.lights'],
          [k('KeyO'), 'beam.ctlFlasher'],
          [k('KeyH'), 'ctl.horn'],
          [[...k('Digit8'), ' / ', ...k('Digit7')], 'ctl.wipers'],
          [k('Digit9'), 'ctl.service'],
          [k('KeyV'), 'ctl.camera'],
          [k('KeyG'), 'ctl.door'],
          [['Alt + ', ...k('KeyW', 'KeyA', 'KeyS', 'KeyD')], 'ctl.freeCam'],
          [k('KeyT'), 'ctl.reset'],
          [k('KeyF'), 'ctl.reality'],
          [k('KeyM'), 'ctl.map'],
          [k('Escape'), 'ctl.pause'],
          [k('F1'), 'ctl.help'],
        ],
      ],
      [
        'ctl.section.foot',
        [
          [[...k('KeyW', 'KeyS', 'KeyA', 'KeyD'), ' + ', ...k('ShiftLeft')], 'ctl.walk'],
          [k('KeyJ', 'KeyK', 'KeyU'), 'ctl.footLook'],
          [k('KeyG'), 'ctl.footDoor'],
          [k('Period'), 'ctl.footOpen'],
          [k('KeyG'), 'ctl.footSeat'],
          [k('KeyG'), 'ctl.seatOut'],
          [k('KeyV'), 'ctl.footView'],
        ],
      ],
      [
        'ctl.section.tram',
        [
          [k('KeyW', 'KeyS'), 'ctl.tramLever'],
          [k('KeyP'), 'ctl.tramPanto'],
          [k('KeyG'), 'ctl.tramDoors'],
          [k('KeyZ', 'KeyC'), 'ctl.tramSwitch'],
          [k('KeyH'), 'ctl.tramBell'],
          [k('Space'), 'ctl.tramEmergency'],
        ],
      ],
      [
        'ctl.section.fly',
        [
          [k('KeyW', 'KeyS'), 'ctl.flyThrottle'],
          [k('ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'), 'ctl.flyStick'],
          [k('KeyA', 'KeyD'), 'ctl.flyRudder'],
          [k('KeyE', 'KeyQ'), 'ctl.flyFlaps'],
          [k('Space'), 'ctl.flyBrakes'],
          [k('KeyT'), 'ctl.flyAutopilot'],
          [k('KeyG'), 'ctl.flyOut'],
        ],
      ],
      [
        'ctl.section.crane',
        [
          [k('KeyA', 'KeyD'), 'craneKeys.slew'],
          [k('KeyW', 'KeyS'), 'craneKeys.hoist'],
          [k('ArrowUp', 'ArrowDown'), 'craneKeys.luff'],
          [k('ArrowLeft', 'ArrowRight'), 'craneKeys.tele'],
          [k('Space'), 'craneKeys.attach'],
          [k('ShiftLeft'), 'craneKeys.fine'],
          [k('Digit1', 'Digit2'), 'craneKeys.beams'],
          [k('Digit3', 'Digit4'), 'craneKeys.jacks'],
          [k('Digit5'), 'craneKeys.level'],
          [k('KeyG'), 'craneKeys.drive'],
        ],
      ],
      [
        'ctl.section.forklift',
        [
          [[...k('KeyW', 'KeyS'), ' / ', ...k('ArrowUp', 'ArrowDown')], 'ctl.forkDrive'],
          [[...k('KeyA', 'KeyD'), ' / ', ...k('ArrowLeft', 'ArrowRight')], 'ctl.forkSteer'],
          [[...k('KeyE', 'KeyQ'), ' / ', ...k('KeyR')], 'ctl.forkDirection'],
          [[...k('Space'), ' / ', ...k('KeyP')], 'ctl.forkHold'],
          [[...k('PageUp', 'PageDown'), ' / ', cap('▲'), cap('▼')], 'ctl.forkLift'],
          [[...k('Home', 'End'), ' / ', cap('↶'), cap('↷')], 'ctl.forkTilt'],
          [[...k('Insert', 'Delete'), ' / ', cap('◀'), cap('▶')], 'ctl.forkShift'],
          [[cap('🎮'), ' R ↕ / ◀ ▶'], 'ctl.forkPad'],
          [k('KeyV'), 'ctl.forkCamera'],
        ],
      ],
      [
        'ctl.section.semi',
        [
          [[...k('KeyR'), ' + ', ...k('KeyW')], 'ctl.semiReverse'],
          [[...k('Space'), ' / ', cap('P')], 'ctl.semiHandbrake'],
          [[cap(this.t('ce.choose', { n: '…' }))], 'ctl.semiChoices'],
          [[cap(this.t('ce.backToSeat'))], 'ctl.semiBack'],
          [[...k('KeyY'), ' / ', cap('◫')], 'ctl.semiMirror'],
          [k('KeyV'), 'ctl.semiCamera'],
        ],
      ],
      [
        'ctl.section.touch',
        [
          [[cap('▭')], 'ctl.tSteer'],
          [[cap('▮ ▮')], 'ctl.tPedals'],
          [[cap('◀'), cap('▶')], 'ctl.tIndicators'],
          [[cap('▲'), cap('▼')], 'ctl.tGears'],
          [[cap('P')], 'ctl.tHandbrake'],
          [[cap('AP')], 'ctl.tAutopilot'],
          [[cap('◫')], 'ctl.tMirror'],
          [[cap('⋯')], 'ctl.tMore'],
          [[cap('↔')], 'ctl.tSwipe'],
          [[cap(this.t('openDoor')), cap(this.t('getInSeat'))], 'ctl.tOpen'],
        ],
      ],
      [
        'ctl.section.hud',
        [
          [[cap('↑ …')], 'ctl.hStreet'],
          [[cap('◯')], 'ctl.hMap'],
          [[cap('⬚')], 'ctl.hTip'],
          [[cap('◀ ▶')], 'ctl.hArrows'],
          [[cap('⏱')], 'ctl.hClock'],
          [[cap('●')], 'ctl.hSignal'],
          [[cap('🚗')], 'ctl.hNewVehicle'],
        ],
      ],
      [
        'ctl.section.pause',
        [
          [[cap('▶')], 'ctl.pResume'],
          [[cap('🗺')], 'ctl.pMap'],
          [[cap('📷')], 'ctl.pReality'],
          [[cap('↺')], 'ctl.pReplay'],
          [[cap('⌖')], 'ctl.pTeleport'],
          [[cap('A')], 'ctl.pDemo'],
          [[cap('⏱')], 'ctl.pArcade'],
          [[cap('🚙')], 'ctl.pChange'],
          [[cap('📍')], 'ctl.pLive'],
          [[cap('🚪')], 'ctl.pGetOut'],
          [[cap('≡')], 'ctl.pLog'],
          [[cap('⚙')], 'ctl.pSettings'],
          [[cap('⏹')], 'ctl.pEnd'],
          [[cap('⌂')], 'ctl.pMenu'],
        ],
      ],
    ];
    const o = el('div', 'overlay');
    const p = el('div', 'panel');
    p.append(el('h1', '', this.t('controls')));
    for (const [title, rows] of sections) {
      p.append(el('h2', '', this.t(title)));
      const table = el('table', 'keys');
      for (const [keys, text] of rows) {
        const row = el('tr');
        const left = el('td');
        left.append(...keys);
        const right = el('td');
        right.textContent = this.t(text);
        row.append(left, right);
        table.append(row);
      }
      p.append(table);
    }
    const para = (title: string, text: string): void => {
      const e = el('p');
      if (title) {
        const b = el('b');
        b.textContent = `${this.t(title)}: `;
        e.append(b);
      }
      e.append(this.t(text));
      p.append(e);
    };
    para('', 'ctl.layoutNote');
    para('ctl.touchTitle', 'ctl.touchText');
    para('ctl.padTitle', 'ctl.padText');
    const b = el('div', 'buttons');
    const bb = el('button', 'btn', this.t('back'));
    bb.onclick = back;
    b.append(bb);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
  }

  /** What each version brought ("What's new"), newest first. */
  showNews(back: () => void): void {
    const o = el('div', 'overlay');
    const p = el('div', 'panel news');
    p.append(el('h1', '', this.t('news')));
    const date = new Intl.DateTimeFormat(localeOf(this.lang), { day: 'numeric', month: 'long', year: 'numeric' });
    for (const r of RELEASES) {
      p.append(el('h2', '', `${this.t('newsVersion', { v: r.version })} · ${date.format(new Date(`${r.date}T12:00:00`))}`));
      if (r.intro) p.append(el('p', '', this.t(r.intro)));
      const list = el('ul');
      for (const key of r.items) list.append(el('li', '', this.t(key)));
      p.append(list);
    }
    const b = el('div', 'buttons');
    const ok = el('button', 'btn', this.t('back'));
    ok.onclick = () => back();
    b.append(ok);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
  }

  showAbout(back: () => void): void {
    const o = el('div', 'overlay');
    const p = el('div', 'panel');
    const text = (key: string): void => {
      const e = el('p');
      e.textContent = this.t(key);
      p.append(e);
    };
    p.append(el('h1', '', this.t('about')));
    text('about.text');
    p.append(el('h2', '', this.t('credits')));
    text('about.dataOsm');
    text('about.dataHessen');
    text('about.timetables');
    text('about.signs');
    text('about.photos');
    p.append(el('h2', '', this.t('source')));
    p.append(el('p', '', '<a href="https://github.com/MaurerAnton/driving-simulator" target="_blank" rel="noopener">github.com/MaurerAnton/driving-simulator</a>'));
    const b = el('div', 'buttons');
    const bb = el('button', 'btn', this.t('back'));
    bb.onclick = back;
    b.append(bb);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
  }

  showIntro(title: string, text: string, go: () => void): void {
    const o = el('div', 'overlay');
    const p = el('div', 'panel narrow');
    p.append(el('h1', '', title), el('p', '', text));
    const b = el('div', 'buttons');
    const bb = el('button', 'btn', this.t('start'));
    bb.onclick = go;
    b.append(bb);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
    bb.focus();
  }

  showPause(): void {
    const o = el('div', 'overlay');
    const p = el('div', 'panel narrow');
    p.append(el('h1', '', this.t('paused')));
    if (this.last) p.append(el('p', '', `${this.t('faults')}: ${this.last.faults} · ${this.t('points')}: ${this.last.points}`));
    const b = el('div', 'buttons');
    const r = el('button', 'btn', this.t('resume'));
    r.onclick = () => this.onResume();
    const s = el('button', 'btn ghost', this.t('settings'));
    s.onclick = () => this.showSettings(() => this.showPause());
    const c = el('button', 'btn ghost', this.t('controls'));
    c.onclick = () => this.showControls(() => this.showPause());
    const q = el('button', 'btn ghost', this.t('menu'));
    q.onclick = () => this.onQuit();
    const f = el('button', 'btn ghost', this.t('realityButton'));
    f.onclick = () => this.onReality();
    const m = el('button', 'btn ghost', this.t('mapTitle'));
    m.onclick = () => this.onMap();
    b.append(r, m, f);
    if (this.onReplay) {
      const rp = el('button', 'btn ghost', this.t('replay'));
      const go = this.onReplay;
      rp.onclick = () => go();
      b.append(rp);
    }
    if (this.canTeleport) {
      const a = el('button', 'btn ghost', this.t('teleport'));
      a.onclick = () => this.showTeleport();
      // … or have the car drive somewhere by itself and watch how it is done
      // (in the aeroplane the same button switches its autopilot)
      const demo = el('button', 'btn ghost', this.t(this.root.closest('.flying') ? 'tbAutopilot' : 'demo'));
      demo.onclick = () => this.onDemo();
      b.append(a, demo);
      // on foot: the walker follows the player's real position (the browser asks first)
      if (this.liveOffer) {
        const live = el('button', 'btn ghost', this.t(this.liveOn ? 'liveLocationOff' : 'liveLocation'));
        live.onclick = () => this.onLiveLocation();
        b.append(live);
      }
      // another vehicle, here and now (the world stays as it is)
      const cv = el('button', 'btn ghost', this.t('changeVehicle'));
      cv.onclick = () => this.showVehiclePicker();
      b.append(cv);
      // the arcade mode: the world at another moment, the time faster while the autopilot drives
      if (this.arcade) {
        const ar = el('button', 'btn ghost', this.t('arcadeTitle'));
        ar.onclick = () => this.showArcade();
        b.append(ar);
      }
    }
    if (this.onGetOut) {
      const out = el('button', 'btn ghost', this.t('getOut'));
      const go = this.onGetOut;
      out.onclick = () => go();
      b.append(out);
    }
    const log = el('button', 'btn ghost', this.t('logTitle'));
    log.onclick = () => this.showLog(() => this.showPause());
    b.append(log, s, c);
    if (this.canFinish) {
      // a free drive ends when the driver says so: the result, then the main menu
      const e = el('button', 'btn ghost', this.t('endDrive'));
      e.onclick = () => this.onFinish();
      b.append(e);
    }
    b.append(q);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
    r.focus();
  }

  /** Free drive: put the car in front of an address. */
  showTeleport(): void {
    const o = el('div', 'overlay');
    const p = el('div', 'panel narrow');
    p.append(el('h1', '', this.t('teleport')), el('p', '', this.t('teleportText')));
    const picker = addressPicker({
      placeholder: this.t('addressPlaceholder'),
      loading: this.t('realityLoading'),
      none: this.t('addressNone'),
      load: () => this.loadAddresses(),
      near: () => this.where(),
      pick: (hit) => this.onTeleport(hit),
    });
    p.append(picker.node);
    const b = el('div', 'buttons');
    const back = el('button', 'btn ghost', this.t('back'));
    back.onclick = () => this.showPause();
    b.append(back);
    p.append(b);
    o.append(p);
    this.setOverlay(o);
    picker.input.focus();
  }

  showResult(r: ResultSummary): void {
    const o = el('div', 'overlay');
    const p = el('div', 'panel');
    p.append(el('h1', '', `${this.t('result')}: ${r.title}`));
    if (r.exam) p.append(el('div', `verdict ${r.passed ? 'ok' : 'bad'}`, this.t(r.passed ? 'passed' : 'failed')));
    const km = formatUnit(r.distanceKm, 'kilometer', this.lang, 1);
    const min = formatUnit(Math.round(r.minutes), 'minute', this.lang);
    p.append(el('p', '', `${this.t('distance')}: ${km} · ${this.t('duration')}: ${min} · ${this.t('points')}: ${r.points}`));
    if (r.extra) p.append(r.extra);
    if (r.log.length === 0) p.append(el('p', '', this.t('noFaults')));
    // group identical faults
    const groups = new Map<string, { v: Violation; n: number }>();
    for (const v of r.log) {
      const g = groups.get(v.id);
      if (g) g.n++;
      else groups.set(v.id, { v, n: 1 });
    }
    const order: Record<string, number> = { fail: 0, major: 1, minor: 2, hint: 3 };
    for (const g of [...groups.values()].sort((a, b) => order[a.v.severity] - order[b.v.severity])) {
      const f = el('div', `fault ${g.v.severity}`);
      const em = el('em', '', `${this.t(g.v.severity)} · `);
      em.append(this.ruleNode(g.v.id));
      f.append(el('b', '', `${violationTitle(g.v.id, this.lang, g.v.data)}${g.n > 1 ? ` (${g.n}×)` : ''}`), el('small', '', violationWhy(g.v.id, this.lang)), em);
      p.append(f);
    }
    const b = el('div', 'buttons');
    const q = el('button', 'btn', this.t('menu'));
    q.onclick = () => this.onQuit();
    const log = el('button', 'btn ghost', this.t('logTitle'));
    log.onclick = () => this.showLog(() => this.showResult(r));
    b.append(q, log);
    if (this.onReplay) {
      const rp = el('button', 'btn ghost', this.t('replay'));
      const go = this.onReplay;
      rp.onclick = () => go();
      b.append(rp);
    }
    p.append(b);
    o.append(p);
    this.setOverlay(o);
  }

  /**
   * The rule a fault refers to.  A citation of the StVO is written as it is
   * in German law (left to right in every language), and each paragraph
   * opens its official text in a new tab.
   */
  private ruleNode(id: string): HTMLElement {
    const ref = VIOLATION_REFS[id] ?? '';
    const node = el('span', 'rule');
    if (ref.startsWith('@') || !ref) {
      node.textContent = violationRef(id, this.lang);
      return node;
    }
    node.dir = 'ltr';
    for (const part of citationParts(ref)) {
      if (!part.url) {
        node.append(part.text);
        continue;
      }
      const a = el('a');
      a.href = part.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = part.text;
      a.title = this.t('logRule');
      node.append(a);
    }
    return node;
  }

  /**
   * The log of faults: every fault of this and of earlier drives, newest
   * first, each with its explanation and the rule to read up.
   */
  showLog(back: () => void): void {
    const o = el('div', 'overlay');
    const p = el('div', 'panel');
    p.append(el('h1', '', this.t('logTitle')));
    const entries = this.faultLog?.entries ?? [];
    if (entries.length === 0) p.append(el('p', '', this.t('logEmpty')));
    else p.append(el('p', '', this.t('logText')));
    const when = new Intl.DateTimeFormat(localeOf(this.lang), { dateStyle: 'medium', timeStyle: 'short', numberingSystem: 'latn', calendar: 'gregory' });
    const list = el('div', 'log');
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const f = el('div', `fault ${e.severity}`);
      const where = [when.format(new Date(e.t)), e.street, e.mode === 'free' ? this.t('free') : e.mode === 'exam' ? this.t('exam') : lessonTitle(e.mode, this.lang)].filter(Boolean).join(' · ');
      const em = el('em', '', `${this.t(e.severity)} · `);
      em.append(this.ruleNode(e.id));
      f.append(el('small', 'when', where), el('b', '', violationTitle(e.id, this.lang, e.data)), el('small', '', violationWhy(e.id, this.lang)), em);
      list.append(f);
    }
    p.append(list);
    const b = el('div', 'buttons');
    const bb = el('button', 'btn', this.t('back'));
    bb.onclick = back;
    b.append(bb);
    if (entries.length > 0) {
      const clear = el('button', 'btn ghost', this.t('logClear'));
      clear.onclick = () => {
        this.faultLog?.clear();
        this.showLog(back);
      };
      b.append(clear);
    }
    p.append(b);
    o.append(p);
    this.setOverlay(o);
    bb.focus();
  }

  private replayBox: { root: HTMLElement; play: HTMLButtonElement; speed: HTMLButtonElement; cam: HTMLButtonElement; time: HTMLElement; note: HTMLElement; range: HTMLInputElement; marks: HTMLElement; shown: string } | null = null;
  private replayNotes: readonly ReplayNote[] = [];

  /**
   * The bar of a replay, at the foot of the screen (the middle stays free for
   * the picture): the clock and the note of the instructor at that moment,
   * the timeline with a mark for each note (a tap jumps to just before it),
   * and the buttons – back, play, on, how fast, which view, done.
   */
  showReplay(bar: ReplayBar, notes: readonly ReplayNote[], state: ReplayState): void {
    this.hideReplay();
    this.replayNotes = notes;
    const root = el('div', 'replay');
    const top = el('div', 'replay-top');
    const time = el('span', 'replay-time');
    const note = el('span', 'replay-note');
    top.append(time, note);
    const line = el('div', 'replay-line');
    const range = el('input') as HTMLInputElement;
    range.type = 'range';
    range.min = '0';
    range.max = '1000';
    range.step = '1';
    range.setAttribute('aria-label', this.t('replay'));
    const span = Math.max(0.001, state.end - state.start);
    range.oninput = () => bar.seek(state.start + (Number(range.value) / 1000) * span);
    const marks = el('div', 'replay-marks');
    for (const n of notes) {
      const m = el('button', `replay-mark ${n.severity}`) as HTMLButtonElement;
      m.style.left = `${((n.t - state.start) / span) * 100}%`;
      m.title = violationTitle(n.id, this.lang, n.data);
      m.setAttribute('aria-label', m.title);
      m.onclick = () => bar.seek(n.t - 4);
      marks.append(m);
    }
    line.append(range, marks);
    const buttons = el('div', 'replay-buttons');
    const btn = (label: string, aria: string, run: () => void): HTMLButtonElement => {
      const b = el('button', 'btn ghost', label) as HTMLButtonElement;
      b.setAttribute('aria-label', aria);
      b.onclick = run;
      return b;
    };
    const play = btn('⏸', this.t('replayPause'), () => bar.toggle());
    const speed = btn('1×', this.t('replaySpeed'), () => bar.speed());
    const cam = btn('', this.t('tbCamera'), () => bar.camera());
    buttons.append(btn('⏪ 10 s', this.t('replayBack'), () => bar.step(-10)), play, btn('10 s ⏩', this.t('replayOn'), () => bar.step(10)), speed, cam, btn('✕', this.t('back'), () => bar.exit()));
    root.append(top, line, buttons, el('div', 'replay-help', this.t('replayHelp')));
    this.root.append(root);
    this.replayBox = { root, play, speed, cam, time, note, range, marks, shown: '' };
    this.updateReplay(state);
  }

  /** The bar as the replay stands now (only what changed is written). */
  updateReplay(s: ReplayState): void {
    const b = this.replayBox;
    if (!b) return;
    const clock = (t: number): string => {
      const sec = Math.max(0, Math.round(t));
      return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    };
    // (the note of the instructor that fell within the last seconds)
    const near = this.replayNotes.filter((n) => n.t <= s.t + 0.2 && n.t > s.t - 5).pop();
    const key = `${Math.round(s.t * 4)}|${s.playing}|${s.speed}|${s.camera}|${near?.t ?? ''}`;
    if (key === b.shown) return;
    b.shown = key;
    b.time.textContent = `${clock(s.t - s.start)} / ${clock(s.end - s.start)}`;
    b.note.textContent = near ? violationTitle(near.id, this.lang, near.data) : '';
    b.note.className = `replay-note ${near?.severity ?? ''}`;
    b.range.value = String(Math.round(((s.t - s.start) / Math.max(0.001, s.end - s.start)) * 1000));
    b.play.textContent = s.playing ? '⏸' : '▶';
    b.play.setAttribute('aria-label', this.t(s.playing ? 'replayPause' : 'replayPlay'));
    b.speed.textContent = `${s.speed < 1 ? '½' : s.speed}×`;
    b.cam.textContent = this.t(s.camera === 'behind' ? 'replayBehind' : s.camera === 'driver' ? 'replayDriver' : 'replayFree');
  }

  hideReplay(): void {
    this.replayBox?.root.remove();
    this.replayBox = null;
  }

  hideOverlay(): void {
    this.setOverlay(null);
  }

  // --------------------------------------------------------------------- HUD
  private buildHud(): HTMLElement {
    const h = el('div', 'hud');
    this.navBox = el('div', 'nav');
    this.navArrow = el('div', 'arrow', '↑');
    const text = el('div', 'text');
    this.navText = el('b');
    this.navSub = el('small');
    this.navMeta = el('em');
    this.navExtra = el('small', 'next');
    text.append(this.navText, this.navSub, this.navMeta, this.navExtra);
    // tap / click: pause menu with the settings (there is no Esc key on a phone)
    const burger = el('span', 'burger', '☰');
    this.navBox.append(this.navArrow, text, burger);
    this.navBox.title = this.t('menuHint');
    this.navBox.onclick = () => this.onPause();
    const assist = el('div', 'assist');
    this.prio = el('div', 'prio');
    this.zone = el('div', 'zone');
    this.roundel = el('div', 'roundel');
    assist.append(this.prio, this.zone, this.roundel);
    this.dash = el('div', 'dash');
    this.indL = el('span', 'ind', '◀');
    this.dashV = el('span', 'v', '0');
    this.dashG = el('span', 'g', 'N');
    const rpm = el('span', 'rpm');
    this.dashRpm = el('i');
    rpm.append(this.dashRpm);
    this.indR = el('span', 'ind', '▶');
    // a tap on an arrow: the hazard lights off when they flash – otherwise that indicator on or off
    const tapInd = (code: string): void => {
      const i = this.input;
      if (!i) return;
      const k = this.last?.hazard ? 'KeyX' : code;
      i.press(k, true);
      i.press(k, false);
    };
    this.indL.onclick = () => tapInd('KeyZ');
    this.indR.onclick = () => tapInd('KeyC');
    // warning lamps as in an instrument cluster: parking brake and seat belt
    this.lampBrake = el(
      'span',
      'lamp',
      '<svg viewBox="0 0 34 24" aria-hidden="true"><circle cx="17" cy="12" r="7.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M6 4.2a11.5 11.5 0 0 0 0 15.6M28 4.2a11.5 11.5 0 0 1 0 15.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><text x="17" y="16" text-anchor="middle" font-size="10.5" font-weight="800" font-family="sans-serif" fill="currentColor">P</text></svg>',
    );
    this.lampBelt = el(
      'span',
      'lamp',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="3.2" fill="currentColor"/><path d="M6 22v-6.5a6 6 0 0 1 12 0V22" fill="none" stroke="currentColor" stroke-width="2.3"/><path d="M7.2 11.2 17 21" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/></svg>',
    );
    this.dash.append(this.indL, this.lampBrake, this.dashV, el('span', 'u', 'km/h'), this.dashG, rpm, this.lampBelt, this.indR);
    this.fuelGauge = new FuelGauge(this.t('hud.fuel'), this.t('hud.fuelLow'));
    this.dash.insertBefore(this.fuelGauge.el, this.lampBelt);
    this.tip = el('div', 'tip');
    const map = el('div', 'map');
    this.mapCanvas = el('canvas');
    this.mapCanvas.width = 220;
    this.mapCanvas.height = 220;
    // tap / click on the map: real photographs of this place (the F key of the keyboard)
    map.append(this.mapCanvas, el('span', 'cam', '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 4 7.5 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.5L15 4H9zm3 4.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>'));
    map.title = this.t('realityButton');
    map.onclick = () => this.onReality();
    // … and a corner of it opens the whole map
    const expand = el('button', 'expand', '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>');
    expand.type = 'button';
    expand.title = this.t('mapTitle');
    expand.setAttribute('aria-label', this.t('mapTitle'));
    expand.onclick = (e) => {
      e.stopPropagation();
      this.onMap();
    };
    map.append(expand);
    this.mini = new MiniMap(map, this.mapCanvas, {
      backLabel: () => this.t('miniBack'),
      moveLabel: () => this.t('miniMove'),
      photos: () => this.settings.reality.aerial,
      meta: this.world.json.meta,
    });
    this.score = el('div', 'score');
    this.keysBox = el('div', 'keyhelp');
    // the upper left corner: the street-name block and, under it, things to choose from while standing
    const side = el('div', 'side');
    this.choiceBox = el('div', 'choices');
    this.choiceBox.hidden = true;
    // (on a touch screen the list would lie over the steering and the pedals: there it is a sheet
    // that this button opens, and that is closed again to drive on)
    this.choiceBtn = el('button', 'choose');
    this.choiceBtn.type = 'button';
    this.choiceBtn.hidden = true;
    this.choiceBtn.onclick = (e) => {
      e.stopPropagation();
      this.choiceBox.classList.add('open');
    };
    side.append(this.navBox, this.choiceBtn, this.choiceBox);
    // how many pictures a second (only if the settings ask for it): out of the way, in the upper right corner
    this.fpsBox = el('div', 'fps');
    this.clockBox = el('button', 'clock-badge');
    this.clockBox.type = 'button';
    this.clockBox.hidden = true;
    this.clockBox.onclick = () => this.onArcade();
    this.wreckBtn = el('button', 'btn new-vehicle');
    this.wreckBtn.type = 'button';
    this.wreckBtn.hidden = true;
    this.wreckBtn.onclick = () => this.onNewVehicle();
    this.fpsBox.hidden = true;
    h.append(side, assist, this.dash, this.tip, map, this.score, this.keysBox, this.fpsBox, this.clockBox, this.wreckBtn);
    return h;
  }

  /**
   * Things to choose from while the vehicle stands (class CE: what is done on
   * foot around truck and trailer; the street-name block above says what is
   * asked).  An empty list takes the panel away.
   * May be called every frame: the panel is rebuilt only when the list changes.
   */
  setChoices(items: ReadonlyArray<{ id: string; label: string }>, pick: (id: string) => void, asked = false): void {
    this.choicePick = pick;
    const key = items.length ? `${this.lang}|${items.map((i) => i.id).join(',')}` : '';
    // (`asked`: it is the driver's turn to do something on foot – the sheet of a touch screen opens by itself)
    if (asked && !this.choiceAsked && items.length) this.choiceBox.classList.add('open');
    this.choiceAsked = asked && items.length > 0;
    if (key === this.choiceKey) return;
    this.choiceKey = key;
    this.choiceBox.replaceChildren();
    this.choiceBox.hidden = items.length === 0;
    this.choiceBtn.hidden = items.length === 0;
    this.choiceBtn.textContent = this.t('ce.choose', { n: items.length });
    if (items.length === 0) this.choiceBox.classList.remove('open');
    for (const it of items) {
      const b = el('button');
      b.type = 'button';
      b.textContent = it.label;
      b.onclick = (e) => {
        e.stopPropagation();
        this.choicePick(it.id);
      };
      this.choiceBox.append(b);
    }
    if (items.length) {
      const back = el('button', 'back', this.t('ce.backToSeat'));
      back.type = 'button';
      back.onclick = (e) => {
        e.stopPropagation();
        this.choiceBox.classList.remove('open');
      };
      this.choiceBox.append(back);
    }
  }

  private choiceAsked = false;

  setHudVisible(v: boolean): void {
    this.hud.style.display = v ? '' : 'none';
  }

  /** A fault or hint of the rule monitor: shown in the block of the street name. */
  toast(v: Violation, seconds = v.severity === 'hint' ? 5.5 : 8): void {
    this.notices.add(violationTitle(v.id, this.lang, v.data), violationWhy(v.id, this.lang), `${this.t(v.severity)} · ${violationRef(v.id, this.lang)}`, v.severity, seconds, performance.now());
  }

  message(title: string, sub = ''): void {
    this.notices.add(title, sub, '', 'hint', 6, performance.now());
  }

  clearNotices(): void {
    this.notices.clear();
  }

  /** Pictures a second, measured by the game; a negative number hides the display. */
  /** The world's moment in the HUD (null: the real one – nothing shown). */
  setClock(text: string | null): void {
    if (!this.clockBox) return;
    this.clockBox.hidden = text === null;
    if (text !== null && this.clockBox.textContent !== `⏱ ${text}`) {
      this.clockBox.textContent = `⏱ ${text}`;
      this.clockBox.setAttribute('aria-label', `${this.t('arcadeTitle')}: ${text}`);
    }
  }

  /**
   * The wiper stalk's place as a lamp beside the speed (off: none) – "int",
   * "1", "2" under a wiper sign.  Without a dashboard (null) it is hidden.
   */
  setWipers(mode: 'off' | 'intermittent' | 'normal' | 'fast' | null): void {
    if (!this.dash) return;
    if (!this.lampWipers) {
      this.lampWipers = el(
        'span',
        'lamp wipers',
        '<svg viewBox="0 0 30 24" aria-hidden="true"><path d="M3 15a12 12 0 0 1 24 0z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 15 7.5 6.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><text x="15" y="23.5" text-anchor="middle" font-size="8.5" font-weight="800" font-family="sans-serif" fill="currentColor"></text></svg>',
      );
      // (green as a switched-on lamp; the class's display would beat the hidden attribute)
      this.lampWipers.style.color = '#4fd06a';
      this.lampWipers.style.opacity = '1';
      this.dash.insertBefore(this.lampWipers, this.lampBelt);
    }
    const show = mode !== null && mode !== 'off';
    const display = show ? '' : 'none';
    if (this.lampWipers.style.display !== display) this.lampWipers.style.display = display;
    const label = mode === 'intermittent' ? 'int' : mode === 'fast' ? '2' : '1';
    const text = this.lampWipers.querySelector('text');
    if (show && text && text.textContent !== label) {
      text.textContent = label;
      this.lampWipers.title = `${this.t('tbWipers')}: ${this.t(`wipers.${mode}`)}`;
    }
  }

  /** The vehicle went up in flames (true) – the button for a new one – or there is one again (false). */
  setWrecked(on: boolean): void {
    if (!this.wreckBtn) return;
    this.wreckBtn.hidden = !on;
    this.wreckBtn.textContent = `🚗 ${this.t('newVehicle')}`;
  }

  /** on foot the pause menu offers following the real position (liveOffer), which is on or off (liveOn) */
  liveOffer = false;
  liveOn = false;
  onLiveLocation: () => void = () => {};

  /** another vehicle chosen in the pause menu: the game puts it where the player is */
  onChangeVehicle: (kind: VehicleKind) => void = () => {};

  /** The vehicles to change to, by their names – the one driven now marked. */
  showVehiclePicker(): void {
    const o = el('div', 'overlay');
    const p = el('div', 'panel narrow');
    p.append(el('h1', '', this.t('changeVehicle')));
    const grid = el('div', 'veh-pick');
    for (const k of VEHICLE_KINDS) {
      const b = el('button', `btn ghost${k === this.settings.vehicle ? ' on' : ''}`, this.t(VEHICLES[k].name));
      b.type = 'button';
      b.onclick = () => this.onChangeVehicle(k);
      grid.append(b);
    }
    const back = el('button', 'btn', this.t('resume'));
    back.onclick = () => this.showPause();
    p.append(grid, back);
    o.append(p);
    this.setOverlay(o);
  }

  /** The arcade panel (over the paused drive). */
  showArcade(): void {
    if (!this.arcade) return;
    const o = el('div', 'overlay');
    o.append(arcadePanel(this.arcade));
    this.setOverlay(o);
  }

  setFps(fps: number): void {
    const show = fps >= 0 && this.settings.showFps;
    if (this.fpsBox.hidden === show) this.fpsBox.hidden = !show;
    if (!show) return;
    const text = `${fps < 10 ? fps.toFixed(1) : Math.round(fps)} FPS`;
    if (this.fpsBox.textContent !== text) this.fpsBox.textContent = text;
  }

  update(s: HudState, now: number): void {
    if (now - this.lastDom > 0.09) {
      this.lastDom = now;
      const rules = this.settings.hudRules;
      // navigation box
      const arrow = s.navArrow < 0 ? '↰' : s.navArrow > 0 ? '↱' : '↑';
      const note = this.notices.current(performance.now());
      // an instruction of several lines is set smaller than a street name
      const long = !note && s.navText.length > 64;
      if (long !== this.navLong) {
        this.navLong = long;
        this.navText.classList.toggle('long', long);
      }
      if (note) {
        // a fault or hint takes the place of the street name (red: serious, yellow: minor)
        if (note !== this.noticeShown) {
          this.noticeShown = note;
          this.navBox.className = `nav alert ${noticeColour(note)}`;
          this.navText.textContent = note.title;
          this.navSub.textContent = note.why;
          this.navMeta.textContent = note.meta;
        }
        // an announced turn stays readable underneath
        this.navArrow.textContent = s.navActive ? arrow : '!';
        this.navExtra.textContent = s.navActive ? `${arrow} ${s.navText}` : '';
      } else {
        if (this.noticeShown) {
          this.noticeShown = null;
          this.navBox.className = 'nav';
          this.navMeta.textContent = '';
          this.navExtra.textContent = '';
        }
        this.navArrow.textContent = arrow;
        this.navText.textContent = s.navText || 'Fahrsim Baunatal';
        this.navSub.textContent = s.navSub;
      }
      // speed limit
      if (rules && s.limit >= 0) {
        this.roundel.style.display = '';
        const none = s.limit === 0;
        this.roundel.className = `roundel${none ? ' none' : ''}${!none && s.speedKmh > s.limit + 6 ? ' over' : ''}`;
        const word = none ? this.t('limitNone') : s.zone === 7 ? this.t('walk') : '';
        const shown = word || String(s.limit);
        if (shown !== this.roundelText) {
          this.roundelText = shown;
          this.roundel.textContent = shown;
          this.roundel.style.fontSize = word ? `${this.fitRoundel(word)}px` : '';
        }
        this.zone.style.display = s.zone === 30 || s.zone === 20 || s.limitWhen ? '' : 'none';
        this.zone.textContent = s.limitWhen || 'ZONE';
      } else {
        this.roundel.style.display = 'none';
        this.zone.style.display = 'none';
      }
      // right of way at the next junction
      let key = '';
      if (rules && s.junction && s.junction.dist < 120) {
        const j = s.junction;
        // (a light – with the state of the green arrow beside it, where there is one)
        if (j.signal >= 0) key = j.arrow > -2 ? `sig${j.signal}a${j.arrow}` : `sig${j.signal}`;
        else if (j.ctrl === CTRL.ROUNDABOUT && j.role !== ROLE.PRIORITY) key = 'roundabout';
        else if (j.role === ROLE.STOP) key = 'stop';
        else if (j.role === ROLE.YIELD) key = 'yield';
        else if (j.role === ROLE.RBL) key = 'rbl';
        else if (j.role === ROLE.MINOR) key = 'minor';
        else if (j.role === ROLE.PRIORITY && j.ctrl === CTRL.SIGNS) key = 'priority';
        // the lights are out of order: a flashing amber, and beside it the sign that counts
        if (j.dark) key = `out:${key}`;
      }
      if (key !== this.lastPrio) {
        this.lastPrio = key;
        if (key.startsWith('sig')) {
          const [main, arrow] = key.slice(3).split('a');
          const st = Number(main);
          const lamp = (on: boolean, c: string): string => `<circle cx="30" cy="${c === '#ff2a1a' ? 16 : c === '#ffb000' ? 44 : 72}" r="11" fill="${on ? c : '#2a2a2a'}"/>`;
          const head = `<rect x="8" y="1" width="44" height="86" rx="8" fill="#111" stroke="#666"/>${lamp(st === SIG.RED || st === SIG.RED_AMBER, '#ff2a1a')}${lamp(st === SIG.AMBER || st === SIG.RED_AMBER, '#ffb000')}${lamp(st === SIG.GREEN, '#1aff6a')}`;
          if (arrow === undefined) this.prio.innerHTML = `<svg viewBox="0 0 60 88">${head}</svg>`;
          else {
            // the green arrow: a second, smaller head on the right with an amber and a green arrow
            const a = Number(arrow);
            const point = (on: boolean, c: string, y: number): string => `<circle cx="80" cy="${y}" r="11" fill="#1c1c1c"/><path d="M71 ${y - 3}h9v-6l10 9-10 9v-6h-9z" fill="${on ? c : '#3a3a3a'}"/>`;
            this.prio.innerHTML = `<svg viewBox="0 0 104 88">${head}<rect x="58" y="29" width="44" height="58" rx="8" fill="#111" stroke="#666"/>${point(a === SIG.AMBER, '#ffb000', 44)}${point(a === SIG.GREEN, '#1aff6a', 72)}</svg>`;
          }
        } else if (key.startsWith('out:')) {
          const sign = ICON[key.slice(4)] ?? '';
          const light = '<svg viewBox="0 0 60 88" style="width:26px;height:38px"><rect x="8" y="1" width="44" height="86" rx="8" fill="#111" stroke="#666"/><circle cx="30" cy="16" r="11" fill="#2a2a2a"/><circle cx="30" cy="44" r="11" fill="#ffb000"><animate attributeName="opacity" values="1;1;0.12;0.12" keyTimes="0;0.5;0.5;1" dur="1s" repeatCount="indefinite"/></circle><circle cx="30" cy="72" r="11" fill="#2a2a2a"/></svg>';
          this.prio.innerHTML = light + sign.replace('<svg ', '<svg style="width:38px;height:38px" ');
        } else this.prio.innerHTML = key ? ICON[key] : '';
      }
      // dashboard strip: outside views (the cockpit has real instruments) – and on a
      // phone, where the instruments are too small to read
      const showDash = !s.onFoot && (s.showDash || this.mode === 'touch');
      this.dash.style.display = showDash ? '' : 'none';
      // (the key reminder keeps clear of the strip)
      this.hud.classList.toggle('dashon', showDash);
      if (showDash) {
        this.dashV.textContent = String(Math.round(Math.abs(s.speedKmh)));
        this.dashG.textContent = s.gear;
        this.dashRpm.style.width = `${Math.min(100, (s.rpm / (s.rpmMax || 7000)) * 100).toFixed(0)}%`;
        this.indL.className = `ind${s.blinkOn && (s.hazard || s.indicator < 0) ? ' on' : ''}`;
        this.indR.className = `ind${s.blinkOn && (s.hazard || s.indicator > 0) ? ' on' : ''}`;
        // lit while the handbrake is on; large and flashing when the car is driven against it
        this.lampBrake.className = `lamp${s.handbrake ? ' on' : ''}${s.handbrakeWarn ? ' warn' : ''}`;
        this.lampBrake.title = s.handbrake ? this.t('tbHandbrake') : '';
        this.lampBelt.className = `lamp${s.seatbelt ? '' : ' on'}`;
        this.fuelGauge.update(s.fuel, s.fuelLow === true);
      }
      this.tip.style.display = s.tip ? '' : 'none';
      this.tip.textContent = s.tip;
      this.tipAction = s.tipAction;
      this.tip.classList.toggle('tap', this.mode === 'touch' && s.tipAction !== '');
      this.score.innerHTML = `${this.t('faults')}: <b>${s.faults}</b> · ${this.t('points')}: <b>${s.points}</b>`;
      this.last = s;
      if (this.mode === 'touch') {
        // the buttons show what is switched on
        const on = (code: string, v: boolean): void => void this.lit.get(code)?.classList.toggle('on', v);
        on('KeyZ', s.blinkOn && (s.hazard || s.indicator < 0));
        on('KeyC', s.blinkOn && (s.hazard || s.indicator > 0));
        on('Space', s.handbrake);
        on('KeyB', s.seatbelt);
        on('KeyI', s.engineOn);
        if (this.starterBtn && this.engineOffBtn) {
          this.starterBtn.hidden = s.engineOn;
          this.engineOffBtn.hidden = !s.engineOn;
        }
        on('KeyL', s.lights);
        on('KeyX', s.hazard);
      } else {
        // key reminder: while standing or crawling, out of the way once the car is rolling
        const want = this.settings.keyHints && !s.onFoot && !s.noKeyHints && Math.abs(s.speedKmh) < 12;
        this.keysBox.classList.toggle('show', want);
        const key = `${this.lang}:${this.gearbox ?? this.settings.transmission}`;
        if (want && key !== this.keysFor) {
          this.keysFor = key;
          this.keysBox.replaceChildren(...this.keyReminder());
        }
      }
    }
    if (now - this.lastMap > 0.12) {
      this.lastMap = now;
      // (the map on the vehicle's own screen instead of in the corner: see `screen`)
      const screen = this.screen;
      this.root.querySelector<HTMLElement>('.hud .map')?.classList.toggle('onscreen', !!screen);
      if (screen) {
        this.drawMap(s, screen.canvas);
        screen.drawn();
      } else this.drawMap(s, this.mapCanvas);
    }
  }

  /**
   * The vehicle's screen the map is drawn on instead of the corner of the
   * picture (the car's centre display, seen from the driver's seat) – null:
   * the map is in the corner.  `drawn` is told after each picture.
   */
  screen: { canvas: HTMLCanvasElement; drawn: () => void } | null = null;

  private drawMap(s: HudState, c: HTMLCanvasElement): void {
    const g = c.getContext('2d');
    if (!g) return;
    const W = c.width;
    const Hh = c.height;
    // (as many pixels per metre on a wide screen as in the round map of 220 px)
    const scale = 0.42 * (Hh / 220);
    const range = Math.max(W, Hh) / 2 / scale + 20;
    const cy = Hh / 2 + 28 * (Hh / 220);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#1c2630';
    g.fillRect(0, 0, W, Hh);
    // heading up: rotate so that the car's forward (-sin yaw, -cos yaw) points to -y
    g.translate(W / 2, cy);
    g.rotate(s.yaw);
    g.scale(scale, scale);
    // (the middle: the vehicle – or where the map was dragged to, to look round)
    const [mx, mz] = this.mini.centre(s.x, s.z, s.yaw, scale, c === this.mapCanvas);
    g.translate(-mx, -mz);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // the aerial photographs under the roads (unless switched off): the roads over them only hinted at
    const photo = this.mini.photos(g, mx, mz, range, scale);
    g.globalAlpha = photo ? 0.5 : 1;
    const draw = (color: string, minTier: number, maxTier: number, extra: number): void => {
      g.strokeStyle = color;
      this.world.edgesInBox(mx - range, mz - range, mx + range, mz + range, (e) => {
        if (e.tier < minTier || e.tier > maxTier) return;
        g.lineWidth = e.width + extra;
        g.beginPath();
        const p = e.pl.pts;
        g.moveTo(p[0], p[2]);
        for (let i = 3; i < p.length; i += 3) g.lineTo(p[i], p[i + 2]);
        g.stroke();
      });
    };
    draw('#55606b', 0, 1.5, 0);
    draw('#aab4bd', 2, 2.9, 1);
    draw('#f1f3f5', 3, 5.5, 2);
    draw('#f5b942', 6, 9, 3);
    g.globalAlpha = 1;
    if (this.routeLanes.length) {
      g.strokeStyle = '#3d8bff';
      g.lineWidth = 7;
      for (const lane of this.routeLanes) {
        const e = lane.edge;
        if (e.maxX < mx - range || e.minX > mx + range || e.maxZ < mz - range || e.minZ > mz + range) continue;
        g.beginPath();
        const p = e.pl.pts;
        g.moveTo(p[0], p[2]);
        for (let i = 3; i < p.length; i += 3) g.lineTo(p[i], p[i + 2]);
        g.stroke();
      }
    }
    // the car (off the middle while the map is looked round on)
    g.setTransform(1, 0, 0, 1, 0, 0);
    const cs = Math.cos(s.yaw);
    const sn = Math.sin(s.yaw);
    g.translate(W / 2 + ((s.x - mx) * cs - (s.z - mz) * sn) * scale, cy + ((s.x - mx) * sn + (s.z - mz) * cs) * scale);
    g.scale(Hh / 220, Hh / 220);
    g.fillStyle = '#ffcc00';
    g.strokeStyle = '#111';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -11);
    g.lineTo(7, 8);
    g.lineTo(0, 4);
    g.lineTo(-7, 8);
    g.closePath();
    g.fill();
    g.stroke();
  }

  // ------------------------------------------------------------- touch input
  // ------------------------------------------------------- on-screen controls
  /**
   * Steering bar, pedals and buttons for driving with the fingers.  They are
   * always built and shown only in touch mode (see setInputMode).
   *
   * Left thumb: steering, indicators.  Right thumb: pedals, gears, handbrake.
   * Everything else is behind "⋯".  The middle of the screen stays free.
   */
  attachInput(input: Input): void {
    this.input = input;
    const t = el('div', 'touch');
    const steer = el('div', 'steer');
    const knob = el('i');
    steer.append(knob);
    const move = (e: PointerEvent): void => {
      const r = steer.getBoundingClientRect();
      const v = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      input.touch.steer = v;
      // (flying, the bar is a stick: down the bar is pulled back)
      const u = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      input.touch.pitch = this.root.classList.contains('flying') ? u : 0;
      input.touched();
      knob.style.left = `${43 + v * 43}%`;
      knob.style.top = this.root.classList.contains('flying') ? `${40 + u * 40}%` : '';
    };
    steer.onpointerdown = (e) => {
      steer.setPointerCapture(e.pointerId);
      move(e);
    };
    steer.onpointermove = (e) => {
      if (e.buttons || e.pointerType === 'touch') move(e);
    };
    const centre = (): void => {
      input.touch.steer = 0;
      input.touch.pitch = 0;
      knob.style.left = '43%';
      knob.style.top = '';
    };
    steer.onpointerup = centre;
    steer.onpointercancel = centre;
    const pedal = (cls: string, label: string, set: (v: number) => void): HTMLElement => {
      const p = el('div', `pedal ${cls}`, label);
      const mv = (e: PointerEvent): void => {
        const r = p.getBoundingClientRect();
        set(Math.max(0.15, Math.min(1, 1 - (e.clientY - r.top) / r.height + 0.15)));
        input.touched();
      };
      p.onpointerdown = (e) => {
        p.setPointerCapture(e.pointerId);
        mv(e);
      };
      p.onpointermove = (e) => {
        if (e.buttons || e.pointerType === 'touch') mv(e);
      };
      p.onpointerup = () => set(0);
      p.onpointercancel = () => set(0);
      return p;
    };
    /** A button that stands in for a key: down while the finger is on it. */
    const key = (cls: string, label: string, code: string, title = ''): HTMLElement => {
      const b = el('button', cls, label);
      if (title) b.title = title;
      let held = false;
      const up = (): void => {
        if (!held) return;
        held = false;
        input.press(code, false);
      };
      b.onpointerdown = (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        held = true;
        input.press(code, true);
      };
      b.onpointerup = up;
      b.onpointercancel = up;
      this.lit.set(code, b);
      return b;
    };
    // everything that is needed now and then
    const more = el('div', 'more');
    more.hidden = true;
    const item = (label: string, code: string): void => {
      const b = key('mb', label, code);
      b.addEventListener('pointerup', () => {
        // a toggle is done with one tap; what must be held (horn, starter, glance) keeps the sheet open
        if (!['KeyH', 'Enter', 'KeyJ', 'KeyK', 'Digit7', 'Flash'].includes(code)) more.hidden = true;
      });
      more.append(b);
    };
    item(this.t('tbBelt'), 'KeyB');
    item(this.t('tbStarter'), 'Enter');
    // (with the engine running the starter's place is taken by switching it off)
    this.starterBtn = more.lastElementChild as HTMLElement;
    item(this.t('tbEngineOff'), 'KeyI');
    this.engineOffBtn = more.lastElementChild as HTMLElement;
    this.engineOffBtn.hidden = true;
    item(this.t('tbIgnition'), 'KeyI');
    item(this.t('tbLights'), 'KeyL');
    item(this.t('tbHighBeam'), 'KeyO');
    // the headlight flasher: lit while held
    item(this.t('beam.flasher'), 'Flash');
    item(this.t('tbHazard'), 'KeyX');
    // the wiper stalk one place on, and the washer (held)
    item(this.t('tbWipers'), 'Digit8');
    item(this.t('tbWasher'), 'Digit7');
    item(this.t('tbHorn'), 'KeyH');
    item(this.t('tbLookLeft'), 'KeyJ');
    item(this.t('tbLookRight'), 'KeyK');
    item(this.t('tbCamera'), 'KeyV');
    item(this.t('tbLookBack'), 'KeyU');
    item(this.t('mapTitle'), 'KeyM');
    item(this.t('tbReset'), 'KeyT');
    // (in the aeroplane the same key is its autopilot: the button says so while flying)
    more.lastElementChild?.classList.add('road-only');
    item(this.t('tbAutopilot'), 'KeyT');
    more.lastElementChild?.classList.add('fly-only');
    const menu = el('button', 'mb', this.t('tbMenu'));
    menu.onclick = () => {
      more.hidden = true;
      this.onPause();
    };
    more.append(menu);
    this.moreBox = more;
    const dots = el('button', 'tb more-btn', '⋯');
    dots.title = this.t('tbMore');
    dots.onclick = () => (more.hidden = !more.hidden);
    t.append(
      steer,
      pedal('gas', this.t('tbGas'), (v) => (input.touch.throttle = v)),
      pedal('brk', this.t('tbBrake'), (v) => (input.touch.brake = v)),
      key('tb ind-l', '◀', 'KeyZ', this.t('tbIndLeft')),
      key('tb ind-r', '▶', 'KeyC', this.t('tbIndRight')),
      key('tb gear-up', '▲', 'KeyE', this.t('tbGearUp')),
      key('tb gear-dn', '▼', 'KeyQ', this.t('tbGearDown')),
      key('tb hb', 'P', 'Space', this.t('tbHandbrake')),
      // (the aeroplane: its autopilot at hand, not only in the sheet)
      key('tb ap', 'AP', 'KeyT', this.t('tbAutopilot')),
      dots,
      more,
    );
    this.hud.append(t);
    // the tip line doubles as a button: "fasten your seat belt – tap here"
    let tipHeld = '';
    const tipUp = (): void => {
      if (tipHeld) input.press(tipHeld, false);
      tipHeld = '';
    };
    this.tip.onpointerdown = (e) => {
      if (!this.tipAction || this.mode !== 'touch') return;
      e.preventDefault();
      this.tip.setPointerCapture(e.pointerId);
      tipHeld = this.tipAction;
      input.press(tipHeld, true);
    };
    this.tip.onpointerup = tipUp;
    this.tip.onpointercancel = tipUp;
  }

  /** Fingers or keys?  Shows the on-screen controls or the key reminder. */
  setInputMode(mode: 'touch' | 'keys'): void {
    const o = String(Math.max(0.15, Math.min(1, this.settings.touchOpacity)));
    if (this.hud.style.getPropertyValue('--touch-opacity') !== o) this.hud.style.setProperty('--touch-opacity', o);
    if (mode === this.mode) return;
    this.mode = mode;
    this.hud.classList.toggle('touchmode', mode === 'touch');
    if (this.moreBox) this.moreBox.hidden = true;
  }

  /** The short reminder of the keys, depending on the gearbox chosen. */
  private keyReminder(): HTMLElement[] {
    const tr = this.gearbox ?? this.settings.transmission;
    const item = (text: string, ...keys: Array<HTMLElement | string>): HTMLElement => {
      const e = el('span');
      e.append(...keys, ` ${this.t(text)}`);
      return e;
    };
    const k = (...codes: string[]): HTMLElement[] => this.keycaps(...codes);
    const out: HTMLElement[] = [];
    if (tr === 'automatic') {
      out.push(item('kr.selector', ...k('KeyE', 'KeyQ')), item('kr.park', ...k('KeyP')), item('kr.reverse', ...k('KeyR')), item('kr.neutral', ...k('KeyN')));
    } else {
      if (tr === 'manual') out.push(item('kr.clutch', ...k('ShiftLeft')));
      out.push(item('kr.gear', ...k('Digit1'), '–', ...k('Digit6')), item('kr.reverse', ...k('KeyR')), item('kr.neutral', ...k('KeyN')), item('kr.upDown', ...k('KeyE', 'KeyQ')));
    }
    out.push(item('kr.handbrake', ...k('Space')), item('kr.startEngine', ...k('Enter')), item('kr.indicators', ...k('KeyZ', 'KeyC')), item('kr.shoulder', ...k('KeyJ', 'KeyK')), item('kr.mirror', ...k('KeyY')), item('kr.camera', ...k('KeyV')), item('kr.map', ...k('KeyM')), item('kr.allKeys', ...k('F1')));
    return out;
  }
}
