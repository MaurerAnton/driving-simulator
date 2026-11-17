// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Watching a tram or a bus of the timetables (chosen on the big map): the
 * camera goes with it while it runs on along its line, and the world – the
 * ground, the roads, the traffic – comes and goes round it, as it does round
 * the player.  The player's own vehicle waits where it was left.
 *
 * The tram is one of the trams of the traffic (src/sim/rail.ts), which are
 * put at their timetable places when their part of the map is loaded – the
 * trip has the same name there (game.ts railSchedule); if it does not come
 * (the traffic has enough trams about), it is put there here.  A bus is put
 * on its line's road by the traffic (src/sim/traffic.ts addCar) once the
 * roads there are loaded, and follows its line from there.  Until either is
 * there, the camera looks at where the timetable has it.
 *
 * Touching a driving control while watching asks whether the player wants to
 * take the vehicle over: yes – the player drives it from there on its line
 * (game.ts begins a drive of the tram at its stop, of the bus where it is,
 * shown the way of its line); no – back to the player's own vehicle.
 *
 * Here also: transitSource, what the big map needs to know of the trams and
 * buses (src/ui/transitmap.ts), made from what the game has read.
 */
import type * as THREE from 'three';
import type { Controls } from '../input/input.ts';
import { consistLength } from '../sim/rail.ts';
import type { RailTraffic, RailVehicle } from '../sim/rail.ts';
import { busTripsAt, serviceTime, tripsAt } from '../sim/timetable.ts';
import type { Timetable, TripState } from '../sim/timetable.ts';
import type { PlayerState, Traffic, TrafficCar } from '../sim/traffic.ts';
import type { BusLines } from '../world/buslines.ts';
import type { Lane, LaneGraph } from '../world/lanes.ts';
import { netPolyline } from '../world/netfile.ts';
import type { NetIndex } from '../world/netindex.ts';
import type { Stops } from '../world/stops.ts';
import type { LinesJson } from '../world/types.ts';
import type { World } from '../world/world.ts';
import { projectOnPolyline } from '../core/geom.ts';
import { courseLength, lineColour, spotOf, textOn } from '../ui/transitmap.ts';
import type { Spot, TransitSource, WatchRequest } from '../ui/transitmap.ts';
import type { TourPreview } from '../ui/bigmap.ts';
import { tr } from '../i18n/index.ts';
import { gameNow } from './clock.ts';

// ---------------------------------------------------------------- what the map needs to know

/** What the game has read that the trams and buses on the map come from. */
export interface TransitGetters {
  timetable(): Timetable | null;
  lines(): LinesJson | null;
  rail(): RailTraffic;
  busLines(): BusLines | null;
  /** the roads of the whole map (a map in pieces), else null */
  net(): NetIndex | null;
  world: World;
  stops(): Stops | null;
}

/** The trams and buses for the big map: positions along their lines, at the game's clock. */
export function transitSource(get: TransitGetters): TransitSource {
  const smp = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };
  // the courses of ways (bounded: they are asked for again as the buses move on)
  const ways = new Map<number, Float32Array>();
  let waysOf: NetIndex | null = null;
  const tramCourses = new Map<number, Float32Array>();
  let tramsOf: RailTraffic | null = null;
  return {
    timetable: () => get.timetable(),
    now: () => serviceTime(gameNow()),
    tramLine: (i) => {
      const l = get.lines()?.lines[i];
      return l ? { colour: l.colour, stops: l.stops } : null;
    },
    tramSpot: (i, a, b, frac) => {
      const rail = get.rail();
      const sp = rail.lineSpot(i, a, b, frac);
      if (!sp) return null;
      rail.net.sample(sp.path, sp.s, smp);
      return { x: smp.x, z: smp.z, yaw: Math.atan2(-smp.tx * sp.dir, -smp.tz * sp.dir) };
    },
    tramCourse: (i) => {
      const rail = get.rail();
      if (tramsOf !== rail) {
        tramCourses.clear();
        tramsOf = rail;
      }
      let c = tramCourses.get(i);
      if (c) return c;
      const line = rail.lines[i];
      if (!line || line.seq.length === 0) return null;
      const out: number[] = [];
      for (const { path, dir } of line.seq) {
        const p = rail.net.paths[path];
        if (!p) continue;
        const n = p.pts.length / 3;
        for (let k = 0; k < n; k++) {
          const i3 = (dir > 0 ? k : n - 1 - k) * 3;
          out.push(p.pts[i3], p.pts[i3 + 2]);
        }
      }
      c = Float32Array.from(out);
      tramCourses.set(i, c);
      return c;
    },
    busLines: () => get.busLines(),
    wayCourse: (w) => {
      const net = get.net();
      if (waysOf !== net || ways.size > 4000) {
        ways.clear();
        waysOf = net;
      }
      const have = ways.get(w);
      if (have) return have;
      const e = w >> 1;
      let pts: number[] | null = null;
      const edge = get.world.edges[e];
      if (edge) {
        pts = [];
        const p = edge.pl.pts;
        for (let i = 0; i + 2 < p.length; i += 3) pts.push(p[i], p[i + 2]);
      } else if (net && e < net.net.edgeA.length) pts = netPolyline(net.net, e);
      if (!pts || pts.length < 4) return null;
      const out = new Float32Array(pts.length);
      if ((w & 1) === 0) out.set(pts);
      else for (let i = 0; i < pts.length; i += 2) {
        out[i] = pts[pts.length - 2 - i];
        out[i + 1] = pts[pts.length - 1 - i];
      }
      // (only roads of the whole map are kept: a loaded road's course is there anyway)
      if (!edge) ways.set(w, out);
      return out;
    },
    stops: () => get.stops(),
  };
}

// ---------------------------------------------------------------- watching

/** What the watching needs of the game. */
export interface WatchHost {
  /** the HUD (the bar about what is watched goes into it) and the whole interface (the question) */
  hud(): HTMLElement | null;
  ui: HTMLElement;
  lang(): string;
  source: TransitSource;
  rail(): RailTraffic;
  traffic(): Traffic;
  lanes: LaneGraph;
  /** are the roads and the ground round a place loaded? */
  ready(x: number, z: number): boolean;
  /** the height of the ground (the far view's where the tiles are not loaded) */
  ground(x: number, z: number): number;
  /** the player takes the vehicle over: a drive of it from here, on its line */
  takeOver(w: WatchRequest, at: TakeOver): void;
  /** back to the player's own vehicle */
  back(): void;
}

/** Where a vehicle is taken over: its place, the stop it stands at or runs to next – and, a bus, the ways of its line from here on. */
export interface TakeOver {
  x: number;
  z: number;
  yaw: number;
  stop: string;
  /** a bus: its line's ways from the one it is on (to the end of its route), and where its last stop is */
  ways: number[];
  end: Spot | null;
}

/**
 * A bus taken over: the ways of its line from where it is to the end of its
 * route, as a way planned for the player to drive and be shown (game.ts
 * startTrip) – ending at its last stop.  Null where the ways are not known.
 */
export function lineWay(src: TransitSource, at: TakeOver): TourPreview | null {
  const line: number[] = [];
  let metres = 0;
  for (const w of at.ways) {
    const c = src.wayCourse(w);
    if (!c) continue;
    for (let i = 0; i + 1 < c.length; i += 2) line.push(c[i], c[i + 1]);
    metres += courseLength(c);
  }
  const L = line.length;
  if (at.ways.length === 0 || L < 4) return null;
  const end = at.end ?? { x: line[L - 2], z: line[L - 1], yaw: Math.atan2(-(line[L - 2] - line[L - 4]), -(line[L - 1] - line[L - 3])) };
  return {
    plan: { ways: at.ways.slice(1), metres, fresh: metres, again: 0, valued: metres },
    line: Float32Array.from(line),
    from: at.ways[0],
    end: { name: '', x: end.x, z: end.z, yaw: end.yaw, kind: 'street' },
  };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** A tram or bus being watched. */
export class Watcher {
  readonly req: WatchRequest;
  private readonly h: WatchHost;
  /** where it is: the vehicle itself once it is there, else where the timetable has it; its height */
  readonly at = { x: 0, y: 0, z: 0, yaw: 0 };
  private tram: RailVehicle | null = null;
  private bus: TrafficCar | null = null;
  /** the trip by the timetable (worked out twice a second) – null: it is not under way (any more) */
  private trip: TripState | null = null;
  private tripAt = -1;
  private spot: Spot | null = null;
  private clock = 0;
  /** how long the area round it has been ready while the tram did not come */
  private waited = 0;
  private bar: HTMLElement | null = null;
  private barText = '';
  private dialog: HTMLElement | null = null;
  /** the controls as they were when watching began (and after "keep watching"): a change is a touch */
  private base: { handbrake: number; gear: number } | null = null;
  /** a control must have been let go before touching one asks again */
  private armed = false;
  private camReady = false;
  /** how long the vehicle is (m): the camera keeps back by it */
  private length = 12;
  /** the player that the traffic comes and goes round: where the vehicle is, high above it (nobody gives way to it) */
  readonly ghost: PlayerState = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, length: 0.2, width: 0.2 };

  constructor(req: WatchRequest, host: WatchHost) {
    this.req = req;
    this.h = host;
    this.update(0);
    this.showBar();
  }

  private t(key: string, p?: Record<string, string | number>): string {
    return tr(key, this.h.lang(), p);
  }

  /** Where the world is to load round. */
  focus(): [number, number] {
    return [this.at.x, this.at.z];
  }

  /** Where the trip is by the timetable now (null: not under way). */
  private timetableTrip(): TripState | null {
    const tt = this.h.source.timetable();
    if (!tt) return null;
    const now = this.h.source.now();
    const list = this.req.kind === 'tram' ? tripsAt(tt, this.req.line, now) : busTripsAt(tt, this.req.line, now);
    return list.find((q) => q.pattern === this.req.pattern && Math.abs(q.t0 - this.req.t0) < 1) ?? null;
  }

  private spotOfTrip(trip: TripState): Spot | null {
    const p = trip.pattern;
    return spotOf(this.h.source, {
      kind: this.req.kind,
      line: this.req.line,
      fromStop: p.lineStops[trip.from] ?? -1,
      toStop: p.lineStops[trip.to] ?? -1,
      fromPlace: p.places[trip.from] ?? -1,
      toPlace: p.places[trip.to] ?? -1,
      standing: trip.standing,
      frac: trip.frac,
    });
  }

  /**
   * A step: the timetable's place of the trip, the vehicle itself (found
   * among the traffic, or put there), and where it is now.
   */
  private update(dt: number): void {
    this.clock += dt;
    if (this.clock - this.tripAt > 0.5 || this.tripAt < 0) {
      this.tripAt = this.clock;
      this.trip = this.timetableTrip();
      const s = this.trip ? this.spotOfTrip(this.trip) : null;
      if (s) this.spot = s;
    }
    const rail = this.h.rail();
    const traffic = this.h.traffic();
    if (this.req.kind === 'tram') {
      if (this.tram && !rail.vehicles.includes(this.tram)) this.tram = null;
      this.tram ??= rail.vehicles.find((v) => v.trip === this.req.trip) ?? null;
      // (the traffic of the trams did not bring it – it has enough about: it is put on its tracks here)
      if (!this.tram && this.spot && this.trip && this.h.ready(this.spot.x, this.spot.z)) {
        this.waited += dt;
        if (this.waited > 3) {
          this.waited = 0;
          this.tram = this.placeTram(rail, this.trip);
        }
      }
    } else {
      if (this.bus && !traffic.cars.includes(this.bus)) this.bus = null;
      // (the buses of the timetables are put on their roads by the traffic itself: src/game/timedtransit.ts)
      this.bus ??= traffic.cars.find((c) => c.bus?.trip === this.req.trip) ?? null;
      if (!this.bus && this.spot && this.trip && this.h.ready(this.spot.x, this.spot.z)) this.bus = this.placeBus(traffic);
    }
    // where it is now
    if (this.tram) {
      this.length = consistLength(this.tram.consist);
      // (the middle of the tram – its front leads the way)
      const c = this.tram.cars[Math.floor((this.tram.cars.length - 1) / 2)];
      const f = this.tram.cars[0];
      this.at.x = c.x;
      this.at.y = c.y;
      this.at.z = c.z;
      this.at.yaw = f.yaw;
      // the traffic comes and goes round its last car (behind it, a "player" is in nobody's way)
      const r = this.tram.cars[this.tram.cars.length - 1];
      this.setGhost(r.x, r.y, r.z, r.yaw);
    } else if (this.bus) {
      this.at.x = this.bus.x;
      this.at.y = this.bus.y;
      this.at.z = this.bus.z;
      this.at.yaw = this.bus.yaw;
      this.setGhost(this.bus.x, this.bus.y, this.bus.z, this.bus.yaw);
    } else if (this.spot) {
      this.at.x = this.spot.x;
      this.at.z = this.spot.z;
      this.at.yaw = this.spot.yaw;
      const gy = this.h.ground(this.spot.x, this.spot.z);
      this.at.y = Number.isFinite(gy) ? gy : this.at.y;
      this.setGhost(this.spot.x, this.at.y, this.spot.z, this.spot.yaw);
    }
  }

  private setGhost(x: number, y: number, z: number, yaw: number): void {
    const g = this.ghost;
    g.x = x;
    // (high above: the cars of the traffic neither give way to it nor run into it)
    g.y = y + 30;
    g.z = z;
    g.yaw = yaw;
  }

  /** Put the tram on its tracks where the timetable has it, as the traffic of the trams does. */
  private placeTram(rail: RailTraffic, trip: TripState): RailVehicle | null {
    const line = this.h.source.tramLine(this.req.line);
    const p = trip.pattern;
    const a = line?.stops[p.lineStops[trip.from] ?? -1];
    const b = line?.stops[p.lineStops[trip.to] ?? -1] ?? a;
    if (!a || !b) return null;
    const sp = rail.lineSpot(this.req.line, a, b, trip.standing ? 0 : trip.frac);
    if (!sp) return null;
    const v = rail.spawnAt(sp.path, sp.s, sp.dir, trip.standing ? 0 : 6);
    if (!v) return null;
    v.trip = this.req.trip;
    v.line = { index: this.req.line, k: sp.k };
    return v;
  }

  /** Put the bus on its line's road where the timetable has it: the right-hand lane of that way. */
  private placeBus(traffic: Traffic): TrafficCar | null {
    const s = this.spot;
    const line = this.h.source.busLines()?.lines[this.req.line];
    if (!s || !line || s.k === undefined) return null;
    const w = line.ways[s.k];
    if (w === undefined || w < 0) return null;
    const el = this.h.lanes.edgeLanes[w >> 1];
    const lanes = el ? ((w & 1) === 0 ? el.fwd : el.back) : [];
    const lane: Lane | undefined = lanes.find((l) => l.idx === 0) ?? lanes[0];
    if (!lane) return null;
    const proj = { s: 0, off: 0, d2: 0, seg: 0 };
    projectOnPolyline(lane.edge.pl, s.x, s.z, proj);
    const along = lane.dir > 0 ? proj.s - lane.s0 : lane.s0 - proj.s;
    const car = traffic.addCar(lane, Math.max(1, Math.min(lane.len - 1, along)), true, { ref: this.req.ref, to: this.req.dest, index: this.req.line, k: s.k, off: 0 });
    // (it drives off at once if it is under way, not at a crawl – and keeps to its trip's times)
    car.v = this.trip?.standing ? 0 : car.v;
    if (car.bus) car.bus.trip = this.req.trip;
    return car;
  }

  /**
   * One step of watching: where it is, the controls – touching one asks
   * whether to take it over.  The game steps the world round `ghost`.
   */
  step(dt: number, c: Controls): void {
    this.update(dt);
    this.base ??= { handbrake: c.handbrake, gear: c.gear };
    const touched = c.throttle > 0.25 || c.brake > 0.25 || Math.abs(c.steer) > 0.4 || Math.abs(c.handbrake - this.base.handbrake) > 0.5 || c.gear !== this.base.gear;
    const idle = c.throttle < 0.08 && c.brake < 0.08 && Math.abs(c.steer) < 0.15;
    if (!this.dialog) {
      if (touched && this.armed) this.ask();
      else if (idle) this.armed = true;
    }
    this.showBar();
  }

  /** The camera: behind and above the vehicle, turned and moved as the player looks round. */
  camera(cam: THREE.PerspectiveCamera, c: Controls, dt: number): void {
    const a = this.at;
    const long = this.req.kind === 'tram';
    const yaw = a.yaw + c.lookYaw;
    const lift = Math.max(0.05, Math.min(1.45, 0.3 - c.lookPitch));
    // (behind its end, further back as the player zooms out)
    const dist = Math.max(this.length / 2 + (long ? 14 : 8), Math.min(160, c.lookZoom * (long ? 2.4 : 1.7)));
    const up = long ? 2.4 : 1.8;
    let tx = a.x + Math.sin(yaw) * dist * Math.cos(lift);
    let ty = a.y + up + dist * Math.sin(lift);
    let tz = a.z + Math.cos(yaw) * dist * Math.cos(lift);
    const g = this.h.ground(tx, tz);
    if (Number.isFinite(g)) ty = Math.max(ty, g + 1.5);
    if (!this.camReady) {
      cam.position.set(tx, ty, tz);
      this.camReady = true;
    } else {
      const k = Math.min(1, dt * 5);
      tx = cam.position.x + (tx - cam.position.x) * k;
      ty = cam.position.y + (ty - cam.position.y) * k;
      tz = cam.position.z + (tz - cam.position.z) * k;
      cam.position.set(tx, ty, tz);
    }
    cam.near = 0.3;
    cam.fov = 55;
    cam.lookAt(a.x, a.y + up, a.z);
    cam.updateProjectionMatrix();
  }

  /** The bar at the top: what is watched, where it goes, and the ways out. */
  private showBar(): void {
    const req = this.req;
    const trip = this.trip;
    const p = trip?.pattern;
    const next = !trip || !p ? this.t('watchGone') : trip.standing ? this.t('transitAt', { stop: p.stops[trip.from] || '?' }) : this.t('transitNext', { stop: p.stops[trip.to] || '?', min: Math.max(0, Math.round((trip.until - this.h.source.now().s) / 60)) });
    const waiting = !this.tram && !this.bus ? this.t('watchWaiting') : '';
    const text = `${req.ref}|${req.dest}|${next}|${waiting}|${this.h.lang()}`;
    if (this.bar && text === this.barText) return;
    this.barText = text;
    const hud = this.h.hud();
    if (!hud) return;
    if (!this.bar) {
      this.bar = el('div', 'watchbar');
      hud.append(this.bar);
      // (what belongs to the player's own vehicle steps back meanwhile: maps.css)
      hud.classList.add('watching');
    }
    const b = this.bar;
    b.replaceChildren();
    const colour = lineColour(req.kind, req.ref, req.colour);
    const badge = el('span', `bm-line ${req.kind}`, req.ref || '?');
    badge.style.background = colour;
    badge.style.color = textOn(colour);
    const what = el('div', 'wb-text');
    const title = el('b', '', `${this.t(req.kind === 'tram' ? 'transitTram' : 'transitBus')} ${req.ref} → ${req.dest}`);
    what.append(title, el('small', '', [next, waiting || this.t('watchHint')].filter(Boolean).join(' · ')));
    const take = el('button', 'btn', this.t('watchTake'));
    take.type = 'button';
    take.onclick = (e) => {
      e.stopPropagation();
      this.ask();
    };
    const back = el('button', 'btn ghost', this.t('watchBack'));
    back.type = 'button';
    back.onclick = (e) => {
      e.stopPropagation();
      this.h.back();
    };
    b.append(badge, what, take, back);
  }

  /** "Take over this tram?" */
  private ask(): void {
    if (this.dialog) return;
    this.armed = false;
    const o = el('div', 'overlay watchask');
    const p = el('div', 'panel narrow');
    p.append(el('h1', '', this.t(this.req.kind === 'tram' ? 'watchAskTram' : 'watchAskBus')), el('p', '', this.t('watchAskSub', { ref: this.req.ref, dest: this.req.dest })));
    const row = el('div', 'buttons');
    const yes = el('button', 'btn', this.t('watchYes'));
    yes.type = 'button';
    yes.onclick = () => {
      this.closeDialog();
      this.take();
    };
    const no = el('button', 'btn ghost', this.t('watchNo'));
    no.type = 'button';
    no.onclick = () => {
      this.closeDialog();
      this.h.back();
    };
    const keep = el('button', 'btn ghost', this.t('watchKeep'));
    keep.type = 'button';
    keep.onclick = () => {
      this.closeDialog();
      // (what the controls are now counts as untouched)
      this.base = null;
    };
    row.append(yes, no, keep);
    p.append(row);
    o.append(p);
    this.h.ui.append(o);
    this.dialog = o;
    yes.focus();
  }

  private closeDialog(): void {
    this.dialog?.remove();
    this.dialog = null;
  }

  /** Take the vehicle over: where it is, the stop it stands at or runs to next – a bus with its line's ways from here on. */
  private take(): void {
    const trip = this.trip;
    const p = trip?.pattern;
    const stop = !trip || !p ? '' : trip.standing ? (p.stops[trip.from] ?? '') : (p.stops[trip.to] ?? '');
    const ways: number[] = [];
    let end: Spot | null = null;
    if (this.req.kind === 'bus') {
      const line = this.h.source.busLines()?.lines[this.req.line];
      const k = this.bus?.bus?.line?.k ?? this.spot?.k ?? -1;
      if (line && k >= 0) {
        for (let i = k; i < line.end; i++) if (line.ways[i] >= 0) ways.push(line.ways[i]);
        const last = line.stops.filter((s) => s.k < line.end).pop();
        const c = last ? this.h.source.wayCourse(line.ways[last.k]) : null;
        if (last && c) {
          // (its last stop: where along its way)
          let left = last.m;
          for (let i = 2; i + 1 < c.length; i += 2) {
            const l = Math.hypot(c[i] - c[i - 2], c[i + 1] - c[i - 1]);
            if (left <= l || i + 3 >= c.length) {
              const f = l > 0 ? Math.min(1, left / l) : 0;
              end = { x: c[i - 2] + (c[i] - c[i - 2]) * f, z: c[i - 1] + (c[i + 1] - c[i - 1]) * f, yaw: Math.atan2(-(c[i] - c[i - 2]), -(c[i + 1] - c[i - 1])) };
              break;
            }
            left -= l;
          }
        }
      }
    }
    // (a bus: a little to the right of the middle of its road, in its lane – so that it is put facing its way)
    const right = this.bus ? 0 : 2;
    const x = this.at.x + Math.cos(this.at.yaw) * right;
    const z = this.at.z - Math.sin(this.at.yaw) * right;
    this.h.takeOver(this.req, { x, z, yaw: this.at.yaw, stop, ways, end });
  }

  /** Watching ends: the bar and any question go. */
  dispose(): void {
    this.closeDialog();
    this.bar?.parentElement?.classList.remove('watching');
    this.bar?.remove();
    this.bar = null;
  }
}
