// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The full-screen map: the whole road network north up, where the car is,
 * where it has been, and – in a free drive – a way to put it anywhere: tap a
 * road, then "put the car here".
 *
 * Drag to move the map, pinch or use the wheel to zoom.  Everything works
 * with a finger, a mouse or the keyboard (arrows, + and -).
 */
import type { DrivenPath } from '../game/track.ts';
import { AERIAL_SOURCE, AerialCache, aerialLevel, aerialTileSize, aerialTiles } from '../reality/aerial.ts';
import { formatUnit, localeOf, tr } from '../i18n/index.ts';
import { loadTours } from '../game/tourlog.ts';
import type { TourPrefs } from '../game/tourlog.ts';
import type { NetIndex } from '../world/netindex.ts';
import { CLASS_TIER } from '../world/types.ts';
import type { SpawnJson } from '../world/types.ts';
import type { World } from '../world/world.ts';
import type { AddressHit, AddressIndex } from '../game/address.ts';
import type { TourPlan } from '../game/tour.ts';
import { addressPicker } from './addresspicker.ts';
import { loadFavourites, loadPlaces, loadWays, removeFavourite, saveFavourite, savePlace, saveWay } from '../game/history.ts';
import { TransitLayer } from './transitmap.ts';
import type { TransitSource, WatchRequest } from './transitmap.ts';
import { PathDrawer } from './pathdraw.ts';
import type { RoadSource } from './pathdraw.ts';
import { addGrip, foldButton } from './mapwindow.ts';
import type { RoadEventInfo } from '../sim/roadevents.ts';
import { searchPlaces } from './placesearch.ts';
import type { LineSource, StopSource } from './placesearch.ts';
import { locate } from './geolocate.ts';
import { LAYERS, LAYER_KEYS, drawLayerIcons, extraLayers, layerIconAt, loadLayers, saveLayers } from './maplayers.ts';
import type { MapEmergency, MapService } from './maplayers.ts';
import { FUELS } from '../world/services.ts';
import { routePresetSection } from './lessonroutes.ts';

export interface BigMapHost {
  world: World;
  /** the roads of the whole map, where the road network itself is only loaded around the car (null: not read yet, or a map in one piece) */
  net(): NetIndex | null;
  lang(): string;
  /** the car: position and yaw (0 = north, positive = to the left) */
  car(): { x: number; z: number; yaw: number };
  path: DrivenPath;
  /** the place on a road next to a point of the map where the car could stand, or null */
  spotAt(x: number, z: number): SpawnJson | null;
  /** may the car be put somewhere else (a free drive)? */
  canTeleport(): boolean;
  teleport(spot: SpawnJson): void;
  /** opened from the main menu, before a drive: a place tapped is offered as where the drive is to begin (`teleport`) – nothing to plan there yet */
  menu?(): boolean;
  /** the fuel stations and car washes, the emergency vehicles of the traffic – and a fuel's price at a station (today's, or a typical one) */
  services?(): readonly MapService[];
  emergencies?(): readonly MapEmergency[];
  fuelPrice?(s: MapService, fuel: string): { price: number; live: boolean };
  /** the name of the service the prices come from (shown under them when they are today's) */
  priceSource?(): string;
  /** watch an emergency vehicle, a demonstration or a site of roadworks */
  watchPoint?(what: { kind: 'em'; id: number } | { kind: 'event'; ev: RoadEventInfo }): void;
  /** the stops of trams and buses (for the search field) */
  stops?(): readonly StopSource[];
  /** the roadworks and demonstrations of the day (sim/roadevents.ts) – drawn with their icons, the march's way in red */
  events?(): readonly RoadEventInfo[];
  /** the address list, for adding a place by its address */
  loadAddresses(): Promise<AddressIndex | null>;
  /** the place on the road in front of an address, or null */
  spotOf(hit: AddressHit): SpawnJson | null;
  /**
   * A drive to these places, in this order – or along a tour that was planned
   * (planTour).  `self`: the player drives and is shown the way; otherwise
   * the car drives by itself.
   */
  startTrip(stops: SpawnJson[], self: boolean, tour: TourPreview | null): void;
  /** start a set route (game/routepresets.ts) from where the vehicle stands */
  startPreset?(id: string): void;
  /**
   * A tour of about `metres` through as many different streets as possible,
   * from where the car stands back to there – or on to `end`.  Null: none found.
   */
  planTour(metres: number, end: SpawnJson | null, progress?: (share: number) => void): Promise<TourPreview | null>;
  /** are the roads of the whole map known (for planning ways through it)? */
  roadsKnown(): boolean;
  /** what a tour is to lead along (kept in the settings) */
  tourPrefs(): TourPrefs;
  setTourPrefs(p: TourPrefs): void;
  /**
   * Where trams can go: the tracks of trams and regional trams (x, z, … per
   * piece) and their stops – `version` changes when the tracks were read anew.
   * Null while they are not read.
   */
  tramways?(): { version: number; tracks: readonly Float32Array[]; stops: ReadonlyArray<{ x: number; z: number; name: string }> } | null;
  /** is a drive to places or a tour under way? – and a way to end it */
  tripActive(): boolean;
  endTrip(): void;
  /** latitude and longitude of a point of the map */
  latLon(x: number, z: number): [number, number];
  /** aerial photographs under the roads: has the player switched them on? (they come from a server of the land survey) */
  aerial(): boolean;
  setAerial(on: boolean): void;
  /** the trams and buses of the timetables and the stops, for the map (src/ui/transitmap.ts) – null: none */
  transit?(): TransitSource | null;
  /** watch one of them: the camera goes with it (in a free drive) */
  watch?(v: WatchRequest): void;
  /** the roads as the route planner sees them, for laying a way drawn on the map onto them (null: not read yet) */
  roads?(): RoadSource | null;
  /** the aeroplane is flown: it is put somewhere in the air, `height` metres above the ground there */
  flying?(): boolean;
  teleportAir?(spot: SpawnJson, height: number): void;
  /** the area of the world in memory, where a car may be put down: the line round it (x1, z1, x2, z2 per side) – null: not shown */
  loadedArea?(): Float32Array | null;
  /** may a car be put down at (x, z) now ('outside': not on the loaded area; 'no': not now) – and put it there (game/spawncar.ts) */
  canSpawnCar?(x: number, z: number): 'ok' | 'outside' | 'no';
  spawnCar?(x: number, z: number): void;
  close(): void;
}

/** A planned tour: what it comes to, and its line on the map (x, z, x, z, …). */
export interface TourPreview {
  plan: TourPlan;
  line: Float32Array;
  /** the way (world/routegraph.ts) it begins behind: the road the car stood on */
  from: number;
  /** where it ends (a round trip: where it started) */
  end: SpawnJson;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** px per metre: the whole map on a phone … one house filling the screen */
const MIN_SCALE = 0.012;
const MAX_SCALE = 4;

/** How roads are drawn, by priority tier (see src/world/types.ts): colour, least width in px, from which zoom on. */
const CLASSES: Array<{ min: number; max: number; color: string; px: number; from: number }> = [
  { min: 0, max: 1.5, color: '#55606b', px: 0.8, from: 0.11 },
  { min: 2, max: 2.9, color: '#aab4bd', px: 1, from: 0.045 },
  { min: 3, max: 5.5, color: '#f1f3f5', px: 1.6, from: 0 },
  { min: 6, max: 9, color: '#f5b942', px: 2.4, from: 0 },
];

export class BigMap {
  private readonly host: BigMapHost;
  private node: HTMLElement | null = null;
  private canvas!: HTMLCanvasElement;
  private spotBar!: HTMLElement;
  /** which of the layers are shown (maplayers.ts) */
  private layers = loadLayers();
  private cx = 0;
  private cz = 0;
  private scale = 0.25;
  private showPath = true;
  private spot: SpawnJson | null = null;
  /** the places of a demonstration drive being planned (kept while the map is closed) */
  private readonly stops: SpawnJson[] = [];
  private planBox!: HTMLElement;
  /** the tour that was planned for the places as they are now, and the length asked for (km) */
  private tour: TourPreview | null = null;
  private tourKm = 10;
  private tourNote = '';
  /** the line of a tour driven before, shown on the map */
  private pastTour: Float32Array | null = null;
  /** the tram tracks as one path (world coordinates), and for which version of them it was made */
  private tramPath: Path2D | null = null;
  private tramVersion = -1;
  /** a tour is being worked out (the button waits) */
  private planning = false;
  private scaleBar!: HTMLElement;
  private scaleText!: HTMLElement;
  private credit!: HTMLElement;
  private frame = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private moved = 0;
  private pinch = 0;
  private readonly photos = new AerialCache(() => this.redraw());
  /** the trams and buses and the stops (transitmap.ts), drawing a way (pathdraw.ts), the grip of the panel for planning */
  private readonly transit: TransitLayer;
  private readonly drawer: PathDrawer;
  private ungrip: (() => void) | null = null;
  /** the height the aeroplane is put at (m above the ground) */
  private airHeight = 600;
  private readonly onResize = (): void => this.redraw();
  private readonly onKey = (e: KeyboardEvent): void => this.key(e);

  constructor(host: BigMapHost) {
    this.host = host;
    this.transit = new TransitLayer({
      lang: () => host.lang(),
      source: () => host.transit?.() ?? null,
      canWatch: () => !!host.watch && (host.canTeleport() || host.menu?.() === true),
      watch: (v) => host.watch?.(v),
      redraw: () => this.redraw(),
    });
    this.drawer = new PathDrawer({
      lang: () => host.lang(),
      roads: () => host.roads?.() ?? null,
      toWorld: (px, py) => {
        const r = this.canvas.getBoundingClientRect();
        return [this.cx + (px - r.left - r.width / 2) / this.scale, this.cz + (py - r.top - r.height / 2) / this.scale];
      },
      pan: (dx, dy) => {
        this.cx -= dx / this.scale;
        this.cz -= dy / this.scale;
        this.redraw();
      },
      zoom: (f, px, py) => this.zoom(f, px, py),
      redraw: () => this.redraw(),
      // (while drawing, the map is free: the panel for planning and the small windows step aside)
      mode: (on) => {
        this.planBox.hidden = on;
        this.spot = null;
        this.spotBar.hidden = true;
        this.transit.closePopup();
        if (!on) this.fillPlan();
      },
      drive: (way, self) => this.host.startTrip([], self, way),
    });
  }

  get isOpen(): boolean {
    return this.node !== null;
  }

  private t(key: string, params?: Record<string, string | number>): string {
    return tr(key, this.host.lang(), params);
  }

  /** `close`: a close-up of where the car is (for comparing the model with the aerial photograph). */
  open(parent: HTMLElement, close = false): void {
    if (this.node) return;
    const car = this.host.car();
    this.cx = car.x;
    this.cz = car.z;
    this.scale = close ? 1.6 : 0.22;
    this.spot = null;

    const o = el('div', 'overlay bigmap');
    this.canvas = el('canvas');
    this.canvas.tabIndex = 0;
    const top = el('div', 'bm-top');
    const title = el('div', 'bm-title');
    title.append(el('b', '', this.t('mapTitle')), el('small', '', this.t(this.host.canTeleport() || this.host.menu?.() ? 'mapHint' : 'mapHintLesson')));
    const tools = el('div', 'bm-tools');
    const button = (label: string, title2: string, fn: () => void, cls = ''): HTMLButtonElement => {
      const b = el('button', `btn ghost ${cls}`.trim(), label);
      b.type = 'button';
      b.title = title2;
      b.setAttribute('aria-label', title2);
      b.onclick = fn;
      return b;
    };
    tools.append(
      button('◎', this.t('mapCentre'), () => {
        const c = this.host.car();
        this.cx = c.x;
        this.cz = c.z;
        if (this.scale < 0.12) this.scale = 0.22;
        this.redraw();
      }),
      button('+', '+', () => this.zoom(1.6)),
      button('−', '−', () => this.zoom(1 / 1.6)),
      button('✕', this.t('realityClose'), () => this.host.close(), 'bm-close'),
    );
    // a place to look for – a town, a stop, a street, an address – and where the player is: the map goes there
    const search = addressPicker({
      placeholder: this.t('mapSearch'),
      loading: this.t('realityLoading'),
      none: this.t('addressNone'),
      load: async () => {
        const idx = await this.host.loadAddresses();
        // (the favourite places first, among the towns)
        const towns = (): Array<{ name: string; kind: string; x: number; z: number }> => [...loadFavourites().map((f) => ({ name: f.name, kind: 'city', x: f.x, z: f.z })), ...(this.host.world.json.places ?? [])];
        return { search: (q: string, n = 8, near: { x: number; z: number } | null = null) => searchPlaces(q, towns(), this.host.stops?.() ?? [], idx ? (qq, nn, nr) => idx.search(qq, nn, nr) : null, n, near, this.lineSources()) };
      },
      near: () => ({ x: this.cx, z: this.cz }),
      pick: (hit) => {
        search.input.value = '';
        search.input.blur();
        // (a line: show its whole way and go to where it runs)
        if (hit.what === 'line' && hit.line) {
          const l = hit.line;
          this.transit.showLine(l.kind, l.index, '#e3000f');
          this.goTo(l.x, l.z, 0.5, hit.label);
          return;
        }
        this.goTo(hit.x, hit.z, hit.exact || hit.street ? 1.2 : 0.3, hit.label);
      },
    });
    search.node.classList.add('bm-search');
    const me = button('⌖', this.t('myLocation'), () => {
      me.disabled = true;
      void locate(this.host.world.json.meta).then((r) => {
        me.disabled = false;
        if (r.ok) this.goTo(r.x, r.z, 1.2, this.t('myLocation'));
        else this.note(this.t(r.why === 'outside' ? 'myLocationOutside' : r.why === 'denied' ? 'myLocationDenied' : 'myLocationNone'));
      });
    });
    tools.prepend(me);
    top.append(title, search.node, tools);

    const bottom = el('div', 'bm-bottom');
    const pathToggle = el('label', 'bm-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = this.showPath;
    box.onchange = () => {
      this.showPath = box.checked;
      this.redraw();
    };
    const pathInfo = el('span');
    const describe = (): void => {
      const km = this.host.path.length() / 1000;
      pathInfo.textContent = km >= 0.05 ? `${this.t('mapPath')} (${formatUnit(km, 'kilometer', this.host.lang(), 1)})` : this.t('mapPath');
    };
    describe();
    pathToggle.append(box, pathInfo);
    const clear = button(this.t('mapClearPath'), this.t('mapClearPath'), () => {
      this.host.path.clear();
      describe();
      this.redraw();
    });
    // aerial photographs: ticking the box is the player's word that they may be fetched
    const aerialToggle = el('label', 'bm-check');
    const aerialBox = el('input');
    aerialBox.type = 'checkbox';
    aerialBox.checked = this.host.aerial();
    aerialBox.onchange = () => {
      this.host.setAerial(aerialBox.checked);
      this.redraw();
    };
    aerialToggle.append(aerialBox, el('span', '', this.t('mapAerial')));
    aerialToggle.title = AERIAL_SOURCE.name;
    // the scale, and whose photographs these are
    const scale = el('div', 'bm-scale');
    this.scaleBar = el('i');
    this.scaleText = el('span');
    this.credit = el('small');
    scale.append(this.scaleText, this.scaleBar, this.credit);
    bottom.append(scale, aerialToggle, pathToggle, clear);
    if (this.host.transit) bottom.append(this.transit.toggle());
    // which layers are shown: a small panel of switches
    const layersBtn = button(this.t('mapLayers'), this.t('mapLayers'), () => {
      layersBox.hidden = !layersBox.hidden;
    });
    const layersBox = el('div', 'bm-layers');
    layersBox.hidden = true;
    for (const id of LAYERS) {
      const l = el('label', 'bm-check');
      const box2 = el('input');
      box2.type = 'checkbox';
      box2.checked = this.layers[id];
      box2.onchange = () => {
        this.layers[id] = box2.checked;
        saveLayers(this.layers);
        this.redraw();
      };
      l.append(box2, el('span', '', this.t(LAYER_KEYS[id])));
      layersBox.append(l);
    }
    bottom.append(layersBtn, layersBox);
    // a drive is planned here: places by a tap on the map or by their address, or a tour of the streets
    this.planBox = el('div', 'bm-plan');
    this.planBox.hidden = true;
    if (this.host.canTeleport()) {
      scale.after(button(this.t('planTitle'), this.t('planTitle'), () => {
        this.planBox.hidden = !this.planBox.hidden;
        this.fillPlan();
      }, 'bm-demo'));
    }
    this.spotBar = el('div', 'bm-spot');
    this.spotBar.hidden = true;
    // Everything on top of the map stands in one column – the title and the tools, the panel for
    // planning (it takes what room is left, and scrolls), the chosen place, the switches – so that
    // nothing lies over anything else, however small the screen is.
    const ui = el('div', 'bm-ui');
    const mid = el('div', 'bm-mid');
    mid.append(this.planBox);
    ui.append(top, mid, this.spotBar, bottom);
    o.append(this.canvas, ui);
    parent.append(o);
    this.node = o;
    // the small window of a tram, a bus or a stop (before the switches); the bar for drawing a way (under the title)
    this.transit.attach(ui, bottom);
    this.drawer.attach(o, this.canvas, ui, top);
    this.ungrip = addGrip(this.planBox, this.t('winResize'));

    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.transit.closePopup();
      this.showSpot(this.cx + (e.clientX - r.left - r.width / 2) / this.scale, this.cz + (e.clientY - r.top - r.height / 2) / this.scale);
    });
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) this.moved = 0;
      this.pinch = 0;
    });
    c.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 1) {
        this.moved += Math.abs(dx) + Math.abs(dy);
        this.cx -= dx / this.scale;
        this.cz -= dy / this.scale;
      } else if (this.pointers.size === 2) {
        // two fingers: the distance between them is the zoom, their middle stays where it is
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch > 0 && d > 0) this.zoom(d / this.pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        this.pinch = d;
        this.moved += 100;
      }
      this.redraw();
    });
    const up = (e: PointerEvent): void => {
      if (!this.pointers.delete(e.pointerId)) return;
      this.pinch = 0;
      // a tap (not a drag): choose that place (a fingertip wobbles a little more than a mouse)
      if (this.pointers.size === 0 && this.moved < (e.pointerType === 'mouse' ? 8 : 16) && e.type === 'pointerup') this.choose(e.clientX, e.clientY);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * 0.004), e.clientX, e.clientY);
      },
      { passive: false },
    );
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKey, true);
    // places chosen earlier and not driven to yet: go on planning where it was left
    if (this.stops.length > 0) this.plan();
    this.redraw();
    c.focus();
  }

  /** Open the panel for planning a drive (the map must be open). */
  plan(): void {
    if (!this.node || !this.host.canTeleport()) return;
    this.planBox.hidden = false;
    this.fillPlan();
  }

  private fillPlan(): void {
    const box = this.planBox;
    box.replaceChildren();
    if (box.hidden) return;
    const lang = this.host.lang();
    const close = el('button', 'bm-x', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', this.t('realityClose'));
    close.onclick = () => {
      box.hidden = true;
    };
    const head = el('div', 'bm-head');
    head.append(el('b', '', this.t('planTitle')), close);
    foldButton(box, head, (folded) => this.t(folded ? 'winUnfold' : 'winFold'));
    box.append(head, el('small', '', this.t('planHint')));
    if (this.host.tripActive()) {
      // a drive is under way: it can be ended here (starting another one ends it, too)
      const end = el('button', 'btn ghost', this.t('tripEnd'));
      end.type = 'button';
      end.onclick = () => {
        this.host.endTrip();
        this.fillPlan();
      };
      box.append(end);
    }
    const changed = (): void => {
      // (a tour belongs to the places it was planned for)
      this.tour = null;
      this.tourNote = '';
      this.fillPlan();
      this.redraw();
    };
    const picker = addressPicker({
      placeholder: this.t('addressPlaceholder'),
      loading: this.t('realityLoading'),
      none: this.t('addressNone'),
      load: () => this.host.loadAddresses(),
      near: () => this.host.car(),
      pick: (hit) => {
        const spot = this.host.spotOf(hit);
        if (!spot) return;
        // (kept: offered again at the next visit)
        savePlace({ name: spot.name || hit.label, x: spot.x, z: spot.z, yaw: spot.yaw });
        this.stops.push(spot);
        this.cx = spot.x;
        this.cz = spot.z;
        if (this.scale < 0.5) this.scale = 0.5;
        picker.input.value = '';
        changed();
      },
    });
    box.append(picker.node);
    if (this.stops.length === 0) {
      box.append(el('small', 'bm-none', this.t('demoNone')));
      // the favourite places: a tap adds one to the drive
      const favs = loadFavourites();
      if (favs.length > 0) {
        const list = el('details', 'bm-tours');
        list.open = true;
        list.append(el('summary', '', `★ ${this.t('favourites')}`));
        for (const f of favs) {
          const b = el('button', 'bm-tour', f.name);
          b.type = 'button';
          b.onclick = () => {
            this.stops.push({ name: f.name, x: f.x, z: f.z, yaw: f.yaw, kind: 'street', rough: true });
            this.cx = f.x;
            this.cz = f.z;
            if (this.scale < 0.5) this.scale = 0.5;
            changed();
          };
          list.append(b);
        }
        box.append(list);
      }
      // what was looked for before: the places picked, the ways driven – a tap sets them again
      const places = loadPlaces();
      const ways = loadWays();
      if (places.length > 0) {
        const recent = el('details', 'bm-tours');
        recent.append(el('summary', '', this.t('recentPlaces')));
        for (const p of places) {
          const b = el('button', 'bm-tour', p.name);
          b.type = 'button';
          b.onclick = () => {
            this.stops.push({ name: p.name, x: p.x, z: p.z, yaw: p.yaw, kind: 'street', rough: true });
            this.cx = p.x;
            this.cz = p.z;
            if (this.scale < 0.5) this.scale = 0.5;
            changed();
          };
          recent.append(b);
        }
        box.append(recent);
      }
      if (ways.length > 0) {
        const recent = el('details', 'bm-tours');
        recent.append(el('summary', '', this.t('recentWays')));
        const loc = localeOf(lang);
        for (const w of ways) {
          const d = new Date(w.date);
          const b = el('button', 'bm-tour', `${d.toLocaleDateString(loc)} · ${w.stops.map((p) => p.name).join(' → ')}`);
          b.type = 'button';
          b.onclick = () => {
            this.stops.length = 0;
            for (const p of w.stops) this.stops.push({ name: p.name, x: p.x, z: p.z, yaw: p.yaw, kind: 'street', rough: true });
            changed();
          };
          recent.append(b);
        }
        box.append(recent);
      }
    }
    else {
      const list = el('ol');
      this.stops.forEach((stop, i) => {
        const li = el('li');
        const [lat, lon] = this.host.latLon(stop.x, stop.z);
        li.append(el('span', '', stop.name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`));
        const del = el('button', '', '✕');
        del.type = 'button';
        del.setAttribute('aria-label', `✕ ${i + 1}`);
        del.onclick = () => {
          this.stops.splice(i, 1);
          changed();
        };
        li.append(del);
        list.append(li);
      });
      box.append(list);
    }

    // --- the set routes (game/routepresets.ts): driven from where the vehicle stands (not from the menu's map: no vehicle yet) ---
    if (this.host.startPreset && !this.host.menu?.()) box.append(routePresetSection((k, v) => this.t(k, v), (id) => this.host.startPreset?.(id)));
    // --- a tour of the streets: as long as asked for, through as many different streets as possible ---
    const tourBox = el('div', 'bm-tour');
    tourBox.append(el('b', '', this.t('tourTitle')), el('small', '', this.t(this.stops.length > 0 ? 'tourHintTo' : 'tourHintRound')));
    const row = el('div', 'bm-row');
    const km = el('input');
    km.type = 'number';
    km.min = '1';
    km.max = '300';
    km.step = '1';
    km.inputMode = 'numeric';
    km.value = String(this.tourKm);
    km.setAttribute('aria-label', this.t('tourLength'));
    const kmLabel = el('label', 'bm-km');
    kmLabel.append(el('span', '', this.t('tourLength')), km, el('span', '', 'km'));
    const planIt = el('button', 'btn ghost', this.t('tourPlan'));
    planIt.type = 'button';
    planIt.onclick = async () => {
      if (this.planning) return;
      this.tourKm = Math.max(1, Math.min(300, Math.round(Number(km.value) || 10)));
      // a long tour takes a while to work out: a bar shows how far it is, the button waits
      this.planning = true;
      planIt.disabled = true;
      const bar = el('div', 'bm-progress');
      const fill = el('i');
      const label = el('small', '', this.t('tourPlanning', { p: 0 }));
      bar.append(fill);
      tourBox.append(bar, label);
      try {
        this.tour = await this.host.planTour(this.tourKm * 1000, this.stops[this.stops.length - 1] ?? null, (share) => {
          const p = Math.round(Math.max(0, Math.min(1, share)) * 100);
          fill.style.width = `${p}%`;
          label.textContent = this.t('tourPlanning', { p });
        });
      } finally {
        this.planning = false;
      }
      // (the roads of the whole map are read in the background after the start: until then, a moment's patience)
      this.tourNote = this.tour ? '' : this.host.roadsKnown() ? this.t('tourNone') : this.t('realityLoading');
      if (this.tour) this.showAll(this.tour.line);
      this.fillPlan();
      this.redraw();
    };
    km.onchange = () => {
      this.tourKm = Math.max(1, Math.min(300, Math.round(Number(km.value) || 10)));
      if (this.tour) changed();
    };
    row.append(kmLabel, planIt);
    // what the tour is to lead along: roads left out, the kind of street looked for
    const prefs = this.host.tourPrefs();
    const wishes = el('div', 'bm-wishes');
    const wish = (key: 'noMotorway' | 'noExpress' | 'noMain', label: string): void => {
      const l = el('label', 'bm-check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = prefs[key];
      box.onchange = () => {
        prefs[key] = box.checked;
        this.host.setTourPrefs(prefs);
      };
      l.append(box, el('span', '', label));
      wishes.append(l);
    };
    wish('noMotorway', this.t('tourNoMotorway'));
    wish('noExpress', this.t('tourNoExpress'));
    wish('noMain', this.t('tourNoMain'));
    const mostly = el('select');
    for (const [v, k] of [['any', 'tourAny'], ['small', 'tourSmall'], ['town', 'tourTown'], ['country', 'tourCountry']] as const) {
      const op = el('option');
      op.value = v;
      op.textContent = this.t(k);
      mostly.append(op);
    }
    mostly.value = prefs.mostly;
    mostly.onchange = () => {
      prefs.mostly = mostly.value as TourPrefs['mostly'];
      this.host.setTourPrefs(prefs);
    };
    const ml = el('label', 'bm-check');
    ml.append(el('span', '', this.t('tourMostly')), mostly);
    wishes.append(ml);
    tourBox.append(wishes, row);
    if (this.tour) {
      const t = this.tour.plan;
      const f = (m: number): string => formatUnit(m / 1000, 'kilometer', lang, 1);
      tourBox.append(el('small', 'bm-result', this.t('tourResult', { km: f(t.metres), fresh: f(t.fresh), again: f(t.again) })));
    } else if (this.tourNote) tourBox.append(el('small', 'bm-result', this.tourNote));
    // the tours driven before, with their dates: each shown on the map at a tap
    const driven = loadTours();
    if (driven.length > 0) {
      const list = el('details', 'bm-tours');
      list.append(el('summary', '', this.t('toursDriven', { n: driven.length })));
      const loc = localeOf(lang);
      const f = (m: number): string => formatUnit(m / 1000, 'kilometer', lang, 1);
      for (const t of driven.slice(0, 15)) {
        const b = el('button', 'bm-tour');
        b.type = 'button';
        const d = new Date(t.date);
        b.textContent = `${d.toLocaleDateString(loc)} ${d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })} · ${f(t.driven)} / ${f(t.planned)}${t.done ? ' ✓' : ''}`;
        b.onclick = () => {
          this.pastTour = Float32Array.from(t.line);
          this.showAll(this.pastTour);
          this.redraw();
        };
        list.append(b);
      }
      tourBox.append(list);
    }
    box.append(tourBox);
    // --- a way drawn on the map with a finger or the mouse, laid onto the roads ---
    if (this.host.roads) box.append(this.drawer.section());

    // --- go: the car drives, or the player ---
    // (what the panel is for stays in view however long the list above it grows)
    const go = el('div', 'bm-row bm-go');
    const ready = this.stops.length > 0 || this.tour !== null;
    const start = (self: boolean): void => {
      const stops = [...this.stops];
      const tour = this.tour;
      if (stops.length > 0) saveWay(stops.map((p) => ({ name: p.name, x: p.x, z: p.z, yaw: p.yaw })), self);
      this.stops.length = 0;
      this.tour = null;
      this.host.startTrip(stops, self, tour);
    };
    const auto = el('button', 'btn', this.t('tripAuto'));
    auto.type = 'button';
    auto.disabled = !ready;
    auto.onclick = () => start(false);
    const self = el('button', 'btn ghost', this.t('tripSelf'));
    self.type = 'button';
    self.disabled = !ready;
    self.onclick = () => start(true);
    go.append(auto, self);
    if (ready) {
      // (not among the buttons that start the drive: these stay in view and should not take half the panel)
      const clear = el('button', 'btn ghost bm-clear', this.t('demoClear'));
      clear.type = 'button';
      clear.onclick = () => {
        this.stops.length = 0;
        changed();
      };
      box.append(clear);
    }
    box.append(go);
  }

  /** Move and zoom the map so that a line (x, z, x, z, …) is in view. */
  private showAll(line: Float32Array): void {
    if (line.length < 4) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < line.length; i += 2) {
      minX = Math.min(minX, line[i]);
      maxX = Math.max(maxX, line[i]);
      minZ = Math.min(minZ, line[i + 1]);
      maxZ = Math.max(maxZ, line[i + 1]);
    }
    this.cx = (minX + maxX) / 2;
    this.cz = (minZ + maxZ) / 2;
    const r = this.canvas.getBoundingClientRect();
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(r.width / (maxX - minX + 200), r.height / (maxZ - minZ + 200)) * 0.8));
  }

  close(): void {
    if (!this.node) return;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKey, true);
    this.transit.detach();
    this.drawer.detach();
    this.ungrip?.();
    this.ungrip = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pointers.clear();
    this.node.remove();
    this.node = null;
  }

  private key(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') return;
    const step = 90 / this.scale;
    let used = true;
    if (e.code === 'ArrowLeft') this.cx -= step;
    else if (e.code === 'ArrowRight') this.cx += step;
    else if (e.code === 'ArrowUp') this.cz -= step;
    else if (e.code === 'ArrowDown') this.cz += step;
    else if (e.key === '+' || e.code === 'NumpadAdd' || e.key === '=') this.zoom(1.6);
    else if (e.key === '-' || e.code === 'NumpadSubtract') this.zoom(1 / 1.6);
    else used = false;
    if (used) {
      // the arrows move the map here, not the car
      e.preventDefault();
      e.stopPropagation();
      this.redraw();
    }
  }

  /** Zoom by a factor; the point of the screen under (px, py) keeps its place (default: the middle). */
  private zoom(factor: number, px?: number, py?: number): void {
    const r = this.canvas.getBoundingClientRect();
    const ox = (px ?? r.left + r.width / 2) - r.left - r.width / 2;
    const oy = (py ?? r.top + r.height / 2) - r.top - r.height / 2;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    // world point under the cursor before and after must be the same
    this.cx += ox / this.scale - ox / next;
    this.cz += oy / this.scale - oy / next;
    this.scale = next;
    this.redraw();
  }

  /** A tap at a point of the screen: the nearest place on a road. */
  private choose(px: number, py: number): void {
    const r = this.canvas.getBoundingClientRect();
    // a place asked for (the place of a photo to upload: net/online.ts): handed over, nothing else
    if (extraLayers.pick) {
      extraLayers.pick(this.cx + (px - r.left - r.width / 2) / this.scale, this.cz + (py - r.top - r.height / 2) / this.scale);
      return;
    }
    // a tram, a bus or a stop there: its small window instead
    if (this.transit.tap(px - r.left, py - r.top)) {
      this.spot = null;
      this.spotBar.hidden = true;
      return;
    }
    this.transit.closePopup();
    // an emergency vehicle, a fuel station or a car wash there
    const sxf = (x: number): number => r.width / 2 + (x - this.cx) * this.scale;
    const syf = (z: number): number => r.height / 2 + (z - this.cz) * this.scale;
    const icon = layerIconAt(px - r.left, py - r.top, this.scale, sxf, syf, this.host.services?.() ?? [], this.host.emergencies?.() ?? [], this.layers);
    // (a photo of the players of a server: its viewer)
    if (icon && 'extra' in icon) {
      icon.extra();
      return;
    }
    if (icon && 'em' in icon) {
      this.spot = null;
      const bar = this.spotBar;
      bar.replaceChildren();
      bar.hidden = false;
      const names = ['emPolice', 'emAmbulance', 'emFire', 'emDoctor'];
      const text = el('div');
      text.append(el('b', '', this.t(names[icon.em.kind] ?? 'emPolice')), el('small', '', this.t(icon.em.call ? 'emOnCall' : 'emPatrol')));
      bar.append(text);
      if (this.host.watchPoint && this.host.canTeleport()) {
        const w = el('button', 'btn', this.t('transitWatch'));
        w.type = 'button';
        const id = icon.em.id;
        w.onclick = () => this.host.watchPoint?.({ kind: 'em', id });
        bar.append(w);
      }
      this.redraw();
      return;
    }
    if (icon && 'service' in icon) {
      const sv = icon.service;
      this.showSpot(sv.x, sv.z, sv.name || sv.brand || this.t(sv.k === 'fuel' ? 'layerFuel' : 'layerWash'));
      // its prices: today's where the player has a key of the price service, else typical ones
      const prices = el('div', 'bm-prices');
      if (sv.k === 'fuel') {
        let live = false;
        for (const f of sv.fuels && sv.fuels.length > 0 ? sv.fuels : ['e10', 'e5', 'diesel']) {
          const p = this.host.fuelPrice?.(sv, f);
          if (!p || !FUELS[f]) continue;
          live ||= p.live;
          prices.append(el('span', '', `${FUELS[f].label} ${p.price.toLocaleString(localeOf(this.host.lang()), { minimumFractionDigits: 3, maximumFractionDigits: 3 })} €`));
        }
        prices.append(el('small', '', live ? `${this.t('priceToday')} · ${this.host.priceSource?.() ?? ''}` : this.t('priceTypical')));
      } else prices.append(el('span', '', `${this.t('layerWash')} 9,90 €`));
      this.spotBar.prepend(prices);
      return;
    }
    // roadworks or a demonstration there: what it is, where, until when
    const ev = this.eventAt(px - r.left, py - r.top, r.width, r.height);
    if (ev) {
      this.spot = null;
      const bar = this.spotBar;
      bar.replaceChildren();
      bar.hidden = false;
      const text = el('div');
      const loc = localeOf(this.host.lang());
      const hm = (ms: number): string => new Date(ms).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
      if (ev.kind === 'works') text.append(el('b', '', this.t(ev.detail === 'lane' ? 'eventWorksLane' : ev.detail === 'light' ? 'eventWorksLight' : ev.detail === 'signs' ? 'eventWorksSigns' : 'eventWorks')), el('small', '', ev.street));
      else text.append(el('b', '', ev.active ? this.t('eventDemoNow', { place: ev.detail, until: hm(ev.until) }) : this.t('eventDemo', { place: ev.detail, from: hm(ev.from), until: hm(ev.until) })), el('small', '', ev.street));
      bar.append(text);
      if (this.host.watchPoint && this.host.canTeleport()) {
        const w = el('button', 'btn', this.t('transitWatch'));
        w.type = 'button';
        w.onclick = () => this.host.watchPoint?.({ kind: 'event', ev });
        bar.append(w);
      }
      this.redraw();
      return;
    }
    const x = this.cx + (px - r.left - r.width / 2) / this.scale;
    const z = this.cz + (py - r.top - r.height / 2) / this.scale;
    this.showSpot(x, z);
  }

  /**
   * The lines of public transport as the search may find them (world/…: trams
   * of lines.json.gz and buses of buslines.json.gz, by their number): each with
   * where its first stop is, for putting the map there.
   */
  private lineSources(): LineSource[] {
    const src = this.host.transit?.() ?? null;
    const tt = src?.timetable() ?? null;
    if (!src || !tt) return [];
    const stops = this.host.stops?.() ?? [];
    const at = (name: string): { x: number; z: number } | null => {
      const s = stops.find((p) => p.name === name);
      return s ? { x: s.x, z: s.z } : null;
    };
    const out: LineSource[] = [];
    const add = (kind: 'tram' | 'bus', list: Array<{ index: number; ref: string; patterns: Array<{ stops: string[] }> } | undefined>): void => {
      for (const l of list) {
        if (!l) continue;
        const first = l.patterns[0]?.stops[0];
        const p = first ? at(first) : null;
        out.push({ ref: l.ref, kind, index: l.index, x: p?.x ?? 0, z: p?.z ?? 0 });
      }
    };
    add('tram', tt.lines);
    add('bus', tt.buses);
    return out;
  }

  /** The map to a place (a search hit, the player's position): centred, zoomed to `scale` at least, its place panel open. */
  private goTo(x: number, z: number, scale: number, name: string): void {
    this.cx = x;
    this.cz = z;
    this.scale = Math.max(this.scale, scale);
    this.transit.closePopup();
    this.showSpot(x, z, name);
  }

  /** A short line in the place panel (a position that could not be found). */
  private note(text: string): void {
    this.spot = null;
    this.spotBar.replaceChildren(el('span', '', text));
    this.spotBar.hidden = false;
    this.redraw();
  }

  /** The place panel for a point of the map: the road there, and what can be done (go there, plan a drive, start from it). */
  private showSpot(x: number, z: number, name = ''): void {
    this.spot = this.host.spotAt(x, z);
    if (this.spot && name) this.spot = { ...this.spot, name };
    const bar = this.spotBar;
    bar.replaceChildren();
    bar.hidden = false;
    if (!this.spot) {
      bar.append(el('span', '', this.t('addressNoRoad')));
    } else {
      const spot = this.spot;
      const [lat, lon] = this.host.latLon(spot.x, spot.z);
      const text = el('div');
      text.append(el('b', '', spot.name || this.t('mapPlace')), el('small', '', `${lat.toFixed(5)}, ${lon.toFixed(5)}`));
      bar.append(text);
      if (this.host.canTeleport()) {
        // (the aeroplane: in the air there, at the height chosen beside the button)
        const air = this.host.flying?.() === true && !!this.host.teleportAir;
        const go = el('button', 'btn', this.t(air ? 'mapTeleportPlane' : 'mapTeleport'));
        go.type = 'button';
        go.onclick = () => (air ? this.host.teleportAir?.(spot, this.airHeight) : this.host.teleport(spot));
        // … or drive there (or have the car drive there by itself)
        const add = el('button', 'btn ghost', this.t('planAdd'));
        add.type = 'button';
        add.onclick = () => {
          this.stops.push(spot);
          this.spot = null;
          this.tour = null;
          this.tourNote = '';
          bar.hidden = true;
          this.planBox.hidden = false;
          this.fillPlan();
          this.redraw();
        };
        if (air) {
          const h = el('label', 'bm-height');
          const sel = el('select');
          for (const m of [150, 300, 600, 1000, 1500, 2000, 3000]) {
            const op = el('option', '', `${m} m (${Math.round((m * 3.28084) / 50) * 50} ft)`);
            op.value = String(m);
            sel.append(op);
          }
          sel.value = String(this.airHeight);
          sel.onchange = () => (this.airHeight = Number(sel.value));
          h.append(el('span', '', this.t('planeHeight')), sel);
          bar.append(h, go);
        } else bar.append(go, add);
        // … or straight there by the autopilot (the aeroplane flies there and circles – or lands, if it is an airfield)
        const auto = el('button', 'btn', this.t(this.host.flying?.() ? 'autoFlyHere' : 'autoDriveHere'));
        auto.type = 'button';
        auto.onclick = () => {
          this.stops.length = 0;
          this.tour = null;
          this.host.startTrip([spot], false, null);
        };
        bar.append(auto);
      } else if (this.host.menu?.()) {
        // (from the main menu: the drive is to begin there)
        const go = el('button', 'btn', this.t('mapTeleport'));
        go.type = 'button';
        go.onclick = () => this.host.teleport(spot);
        bar.append(go);
      }
      // a car put down here (on foot, at a crane): only on the area in memory, inside the dashed line
      const can = this.host.canSpawnCar?.(x, z) ?? 'no';
      if (can === 'ok') {
        const car = el('button', 'btn ghost', this.t('mapSpawnCar'));
        car.type = 'button';
        car.onclick = () => this.host.spawnCar?.(x, z);
        bar.append(car);
      } else if (can === 'outside') bar.append(el('small', '', this.t('spawnCarOutside')));
      // a favourite place: kept on this device, a star on the map, in the list of the plan panel
      const fav = loadFavourites().find((f) => Math.hypot(f.x - spot.x, f.z - spot.z) <= 20);
      const star = el('button', 'btn ghost', fav ? `★ ${this.t('favRemove')}` : `☆ ${this.t('favAdd')}`);
      star.type = 'button';
      star.onclick = () => {
        if (fav) removeFavourite(fav.x, fav.z);
        else saveFavourite({ name: spot.name || this.t('mapPlace'), x: spot.x, z: spot.z, yaw: spot.yaw });
        this.showSpot(x, z, name);
        if (!this.planBox.hidden) this.fillPlan();
      };
      bar.append(star);
    }
    this.redraw();
  }

  /** The roadworks (an orange sign) and demonstrations (a red one, the march's way in red dashes) in view. */
  private drawEvents(g: CanvasRenderingContext2D, W: number, H: number, s: number): void {
    const list = (this.host.events?.() ?? []).filter((e) => (e.kind === 'works' ? this.layers.works : this.layers.demos));
    if (list.length === 0) return;
    const sx = (x: number): number => W / 2 + (x - this.cx) * s;
    const sy = (z: number): number => H / 2 + (z - this.cz) * s;
    g.save();
    for (const e of list) {
      if (e.kind !== 'demo' || e.line.length < 4) continue;
      g.strokeStyle = e.active ? 'rgba(230, 40, 40, 0.9)' : 'rgba(230, 40, 40, 0.45)';
      g.lineWidth = Math.max(3, Math.min(8, 6 * s));
      g.setLineDash([8, 6]);
      g.beginPath();
      for (let i = 0; i + 1 < e.line.length; i += 2) {
        if (i === 0) g.moveTo(sx(e.line[i]), sy(e.line[i + 1]));
        else g.lineTo(sx(e.line[i]), sy(e.line[i + 1]));
      }
      g.stroke();
    }
    g.setLineDash([]);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const e of list) {
      const x = sx(e.x);
      const y = sy(e.z);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      // (a warning triangle: orange for works, red for a demonstration – faded when it is not on now)
      g.globalAlpha = e.active || e.kind === 'works' ? 1 : 0.55;
      g.fillStyle = e.kind === 'works' ? '#ff9f1a' : '#e62828';
      g.strokeStyle = '#1b1208';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, y - 11);
      g.lineTo(x + 11, y + 8);
      g.lineTo(x - 11, y + 8);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = e.kind === 'works' ? '#1b1208' : '#ffffff';
      g.font = '700 11px system-ui, sans-serif';
      g.fillText(e.kind === 'works' ? '⚒' : '!', x, y + 2);
    }
    g.restore();
  }

  /** The roadworks or demonstration whose sign is under a point of the map (null: none). */
  private eventAt(px: number, py: number, W: number, H: number): RoadEventInfo | null {
    const list = (this.host.events?.() ?? []).filter((e) => (e.kind === 'works' ? this.layers.works : this.layers.demos));
    let best: RoadEventInfo | null = null;
    let bestD = 18;
    for (const e of list) {
      const d = Math.hypot(W / 2 + (e.x - this.cx) * this.scale - px, H / 2 + (e.z - this.cz) * this.scale - py);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private redraw(): void {
    if (this.frame || !this.node) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const c = this.canvas;
    const g = c.getContext('2d');
    if (!g || !this.node) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const world = this.host.world;
    const m = world.json.meta;
    // do not lose the map: its middle stays within reach
    this.cx = Math.min(m.maxX, Math.max(m.minX, this.cx));
    this.cz = Math.min(m.maxZ, Math.max(m.minZ, this.cz));
    const s = this.scale;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#16202a';
    g.fillRect(0, 0, W, H);
    // world → screen
    g.translate(W / 2, H / 2);
    g.scale(s, s);
    g.translate(-this.cx, -this.cz);
    const minX = this.cx - W / 2 / s;
    const maxX = this.cx + W / 2 / s;
    const minZ = this.cz - H / 2 / s;
    const maxZ = this.cz + H / 2 / s;

    // the area the map covers
    g.fillStyle = '#1c2a36';
    g.fillRect(m.minX, m.minZ, m.maxX - m.minX, m.maxZ - m.minZ);

    // aerial photographs under the roads (only within the map, only what is in view)
    const aerial = this.host.aerial();
    if (aerial) {
      this.photos.beginFrame();
      const e0 = Math.max(minX, m.minX) + m.originE;
      const e1 = Math.min(maxX, m.maxX) + m.originE;
      const n0 = m.originN - Math.min(maxZ, m.maxZ);
      const n1 = m.originN - Math.max(minZ, m.minZ);
      if (e1 > e0 && n1 > n0) {
        let level = aerialLevel(s * dpr);
        // never more than a screenful of pictures at once
        while (level < 8 && ((e1 - e0) / aerialTileSize(level) + 1) * ((n1 - n0) / aerialTileSize(level) + 1) > 30) level++;
        // a coarse picture first (it is there at once), the fine ones on top as they arrive
        for (const l of level + 3 <= 8 ? [level + 3, level] : [8, level]) {
          for (const t of aerialTiles(l, e0, n0, e1, n1)) {
            const img = this.photos.get(t);
            if (img) g.drawImage(img, t.minE - m.originE, m.originN - (t.minN + t.size), t.size, t.size);
          }
          if (l === level) break;
        }
      }
    }

    g.lineCap = 'round';
    g.lineJoin = 'round';
    // over a photograph the roads are only hinted at
    g.globalAlpha = aerial ? 0.38 : 1;
    // one path per class and width: roads of a class are drawn at their real width once that is more than the least
    const paths: Array<Map<number, Path2D>> = CLASSES.map(() => new Map());
    const pathFor = (tier: number, width: number): Path2D | null => {
      const ci = CLASSES.findIndex((c) => tier >= c.min && tier <= c.max);
      if (ci < 0 || s < CLASSES[ci].from) return null;
      const w = Math.max(CLASSES[ci].px / s, Math.round(width));
      let path = paths[ci].get(w);
      if (!path) paths[ci].set(w, (path = new Path2D()));
      return path;
    };
    const net = this.host.net();
    if (net) {
      // the roads of the whole map (most of them are not loaded): from the file that holds them all in a few points
      const cls = net.net.edgeCls;
      net.edgesInBox(
        minX,
        minZ,
        maxX,
        maxZ,
        (e) => {
          const tier = CLASS_TIER[cls[e]];
          const path = pathFor(tier, tier >= 6 ? 11 : tier >= 4 ? 7.5 : tier >= 3 ? 6.5 : tier >= 2 ? 5.5 : 3.5);
          if (path) net.trace(e, path);
        },
        s < CLASSES[1].from,
      );
    } else {
      world.edgesInBox(minX, minZ, maxX, maxZ, (e) => {
        const path = pathFor(e.tier, e.width);
        if (!path) return;
        const p = e.pl.pts;
        path.moveTo(p[0], p[2]);
        for (let i = 3; i < p.length; i += 3) path.lineTo(p[i], p[i + 2]);
      });
    }
    CLASSES.forEach((cls, ci) => {
      g.strokeStyle = cls.color;
      for (const [w, path] of paths[ci]) {
        g.lineWidth = w;
        g.stroke(path);
      }
    });

    g.globalAlpha = 1;

    // the tram tracks: where a tram can go (one path for all of them, made once)
    const trams = this.host.tramways?.() ?? null;
    if (trams) {
      if (!this.tramPath || this.tramVersion !== trams.version) {
        const p = new Path2D();
        for (const t of trams.tracks) {
          p.moveTo(t[0], t[1]);
          for (let i = 2; i < t.length; i += 2) p.lineTo(t[i], t[i + 1]);
        }
        this.tramPath = p;
        this.tramVersion = trams.version;
      }
      g.strokeStyle = '#c070f0';
      g.lineWidth = Math.max(2.4 / s, 1.6);
      g.globalAlpha = aerial ? 0.9 : 0.8;
      g.stroke(this.tramPath);
      g.globalAlpha = 1;
    }

    // where the car has been
    if (this.showPath) {
      const p = this.host.path.points;
      g.strokeStyle = '#38b6ff';
      g.lineWidth = Math.max(3 / s, 2.5);
      g.beginPath();
      let pen = false;
      for (let i = 0; i < p.length; i += 2) {
        if (Number.isNaN(p[i])) {
          pen = false;
          continue;
        }
        if (pen) g.lineTo(p[i], p[i + 1]);
        else g.moveTo(p[i], p[i + 1]);
        pen = true;
      }
      g.stroke();
    }

    // a tour driven before (chosen from the list)
    if (this.pastTour && this.pastTour.length >= 4) {
      const p = this.pastTour;
      g.strokeStyle = '#7fd4ff';
      g.lineWidth = Math.max(4 / s, 3.5);
      g.globalAlpha = 0.85;
      g.setLineDash([10 / s, 7 / s]);
      g.beginPath();
      g.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }

    // the tour that was planned
    if (this.tour) {
      const p = this.tour.line;
      g.strokeStyle = '#ff8a3d';
      g.lineWidth = Math.max(4 / s, 3.5);
      g.globalAlpha = 0.85;
      g.beginPath();
      g.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
      g.stroke();
      g.globalAlpha = 1;
    }

    // from here on in screen pixels
    const sx = (x: number): number => W / 2 + (x - this.cx) * s;
    const sy = (z: number): number => H / 2 + (z - this.cz) * s;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // the tram stops: a dot each, their names when one is close enough to read them
    if (trams && s > 0.05) {
      g.fillStyle = '#ffffff';
      g.strokeStyle = '#7a2fb0';
      g.lineWidth = 2;
      const named = s > 0.6;
      g.font = '600 12px system-ui, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      for (const st of trams.stops) {
        const x = sx(st.x);
        const y = sy(st.z);
        if (x < -40 || y < -20 || x > W + 40 || y > H + 20) continue;
        g.beginPath();
        g.arc(x, y, named ? 4.5 : 3, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        if (named) {
          g.lineWidth = 3;
          g.strokeStyle = 'rgba(12, 18, 24, 0.85)';
          g.strokeText(st.name, x + 7, y);
          g.fillStyle = '#e8d4ff';
          g.fillText(st.name, x + 7, y);
          g.fillStyle = '#ffffff';
          g.strokeStyle = '#7a2fb0';
          g.lineWidth = 2;
        }
      }
    }

    // names of towns and districts
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(12, 18, 24, 0.85)';
    const taken: Array<[number, number, number]> = [];
    const carX = sx(this.host.car().x);
    const carY = sy(this.host.car().z);
    const places = world.json.places
      .filter((p) => p.x > minX && p.x < maxX && p.z > minZ && p.z < maxZ)
      .sort((a, b) => rank(b.kind) - rank(a.kind));
    for (const p of places) {
      const r = rank(p.kind);
      if (r === 0 || (r === 1 && s < 0.05) || (r === 2 && s < 0.03)) continue;
      const size = r === 3 ? 17 : r === 2 ? 14 : 12;
      const x = sx(p.x);
      let y = sy(p.z);
      const half = (p.name.length * size * 0.3) + 6;
      // a name that would lie under the car's arrow is written below it
      if (Math.abs(x - carX) < half + 10 && Math.abs(y - carY) < size * 0.6 + 14) y = carY + 18 + size * 0.6;
      if (taken.some(([tx, ty, th]) => Math.abs(tx - x) < th + half && Math.abs(ty - y) < size + 4)) continue;
      taken.push([x, y, half]);
      g.font = `${r === 3 ? 700 : 600} ${size}px system-ui, sans-serif`;
      g.strokeText(p.name, x, y);
      g.fillStyle = r === 3 ? '#ffffff' : '#d5dde4';
      g.fillText(p.name, x, y);
    }

    // the roadworks and demonstrations of the day, the fuel stations and car washes, the emergency vehicles
    this.drawEvents(g, W, H, s);
    // the favourite places: gold stars
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 18px system-ui, sans-serif';
    for (const f of loadFavourites()) {
      const fx = W / 2 + (f.x - this.cx) * s;
      const fy = H / 2 + (f.z - this.cz) * s;
      if (fx < -12 || fy < -12 || fx > W + 12 || fy > H + 12) continue;
      g.lineWidth = 3;
      g.strokeStyle = '#1b1208';
      g.strokeText('★', fx, fy);
      g.fillStyle = '#ffcc00';
      g.fillText('★', fx, fy);
    }
    g.restore();
    drawLayerIcons(g, W, H, s, (x) => W / 2 + (x - this.cx) * s, (z) => H / 2 + (z - this.cz) * s, this.host.services?.() ?? [], this.host.emergencies?.() ?? [], this.layers, Math.floor(performance.now() / 400) % 2 === 0);
    // the area of the world in memory (where a car may be put down): a dashed line round it
    const area = this.host.loadedArea?.() ?? null;
    if (area && area.length > 0) {
      g.save();
      g.strokeStyle = 'rgba(56,182,255,0.9)';
      g.lineWidth = 2;
      g.setLineDash([8, 6]);
      g.beginPath();
      for (let i = 0; i + 3 < area.length; i += 4) {
        g.moveTo(W / 2 + (area[i] - this.cx) * s, H / 2 + (area[i + 1] - this.cz) * s);
        g.lineTo(W / 2 + (area[i + 2] - this.cx) * s, H / 2 + (area[i + 3] - this.cz) * s);
      }
      g.stroke();
      g.restore();
    }
    // the trams and buses with their stops, and a way drawn on the map
    this.transit.draw(g, W, H, s, this.cx, this.cz);
    this.drawer.draw(g, W, H, s, this.cx, this.cz);
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    // the places of a demonstration drive, numbered in their order
    this.stops.forEach((stop, i) => {
      const x = sx(stop.x);
      const y = sy(stop.z);
      g.fillStyle = '#38b6ff';
      g.strokeStyle = '#06131c';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, 11, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = '#06131c';
      g.font = '700 13px system-ui, sans-serif';
      g.fillText(String(i + 1), x, y + 0.5);
    });

    // the chosen place
    if (this.spot) {
      const x = sx(this.spot.x);
      const y = sy(this.spot.z);
      g.fillStyle = '#ff5252';
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y - 14, 8, Math.PI, 0);
      g.lineTo(x, y);
      g.closePath();
      g.fill();
      g.stroke();
    }

    // the car
    const car = this.host.car();
    g.save();
    g.translate(sx(car.x), sy(car.z));
    g.rotate(-car.yaw);
    g.fillStyle = '#ffcc00';
    g.strokeStyle = '#111';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -13);
    g.lineTo(8, 9);
    g.lineTo(0, 5);
    g.lineTo(-8, 9);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();

    // scale: a round number of metres that is about a fifth of the width
    const want = Math.min(W / 5, 150) / s;
    const pow = 10 ** Math.floor(Math.log10(want));
    const metres = (want / pow >= 5 ? 5 : want / pow >= 2 ? 2 : 1) * pow;
    const lang = this.host.lang();
    this.scaleBar.style.width = `${Math.round(metres * s)}px`;
    const label = metres >= 1000 ? formatUnit(metres / 1000, 'kilometer', lang) : formatUnit(metres, 'meter', lang);
    if (this.scaleText.textContent !== label) this.scaleText.textContent = label;
    // whose pictures these are
    const credit = aerial ? AERIAL_SOURCE.attribution : '';
    if (this.credit.textContent !== credit) this.credit.textContent = credit;
  }
}

/** How prominent a place is on the map. */
function rank(kind: string): number {
  return kind === 'city' || kind === 'town' ? 3 : kind === 'suburb' || kind === 'village' ? 2 : kind === 'quarter' || kind === 'neighbourhood' || kind === 'hamlet' ? 1 : 0;
}
