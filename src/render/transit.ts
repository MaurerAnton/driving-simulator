// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Public transport in the world, around the camera: the stops of the map
 * (stops.json.gz) with their signs, shelters, benches, platforms and the
 * people waiting at them; the board where a tram's front stops (Sh 7); the
 * overhead line along the tram tracks that have one, with its masts; and
 * the tram signals where the tracks cross a junction with lights.
 *
 * What comes near is built a little at a time (a stop or a piece of track
 * per frame) and dropped again when the camera has gone on.  The people get
 * on when a tram or a bus stands at their stop with its doors open, and
 * others get off and walk away.
 */
import * as THREE from 'three';
import { hash01, newPolySample, samplePolyline } from '../core/geom.ts';
import type { RailTraffic, RailVehicle } from '../sim/rail.ts';
import { SIG } from '../sim/signals.ts';
import type { SignalSystem } from '../sim/signals.ts';
import type { TrafficCar } from '../sim/traffic.ts';
import type { StopPlace, Stops } from '../world/stops.ts';
import { CTRL, RAIL, STOP_FLAG } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { World } from '../world/world.ts';
import { PeopleRenderer } from './people.ts';
import type { PersonPose } from './people.ts';
import { CONTACT_WIRE_HEIGHT, DepartureBoard, SwitchSignal, TramSignal, bench, benchSeats, bin, catenaryMast, contactWire, mergeStatic, platform, releaseModel, shelter, shelterSeats, stopBoard, stopSign } from './stopmodels.ts';
import type { StopKind, SwitchAspect, TramAspect } from './stopmodels.ts';

/** one of the people at a stop */
interface Waiter {
  x: number;
  y: number;
  z: number;
  yaw: number;
  look: number;
  sit: boolean;
  walk: number;
  /** waiting, walking to a door (and in), getting off and walking away */
  state: 'wait' | 'board' | 'leave';
  tx: number;
  tz: number;
  speed: number;
}

interface PlaceView {
  place: StopPlace;
  root: THREE.Group;
  /** what has to be let go of properly (the signs hold a place in a shared texture) */
  signs: THREE.Object3D[];
  boards: DepartureBoard[];
  people: Waiter[];
  /** where people wait (beside the poles, on the platforms), facing the road or the track */
  spots: Array<{ x: number; z: number; yaw: number }>;
  seats: Array<{ x: number; z: number; yaw: number }>;
  /** the vehicles whose doors were served last (so that a standing tram is boarded once) */
  served: Set<number>;
  nextArrival: number;
}

interface TrackView {
  root: THREE.Group;
  signals: Array<{ head: TramSignal; sc: number; group: number }>;
  /** the switches at the piece's ends: the way on each of their branches turns (+1 left, −1 right, 0 straight) */
  switches: Array<{ head: SwitchSignal; path: number; dir: 1 | -1; ways: Array<{ path: number; dir: 1 | -1; turn: number }> }>;
}

const tmp = newPolySample();
const hit = newSurfaceHit();

export class TransitScene {
  readonly group = new THREE.Group();
  readonly people = new PeopleRenderer(320);
  /** how far around the camera the stops (and the tracks' wires and signals) are drawn */
  radius = 320;
  trackRadius = 420;
  private stops: Stops | null = null;
  private readonly places = new Map<number, PlaceView>();
  private readonly tracks = new Map<number, TrackView>();
  private readonly world: World;
  private readonly ground: (x: number, z: number, yRef: number) => number;
  private rail: RailTraffic | null = null;
  private poses: PersonPose[] = [];
  private boxes: Array<[number, number, number, number]> = [];
  private readonly near: StopPlace[] = [];

  constructor(world: World, ground: (x: number, z: number, yRef: number) => number) {
    this.world = world;
    this.ground = ground;
    this.group.name = 'public transport';
    this.group.add(this.people.group);
  }

  /** The stops of the map (null: none). */
  setStops(stops: Stops | null): void {
    this.stops = stops;
    for (const v of this.places.values()) this.dropPlace(v);
    this.places.clear();
  }

  /** The tracks (they are read a while after the map). */
  setRail(rail: RailTraffic): void {
    if (rail === this.rail) return;
    this.rail = rail;
    // the rectangle round each piece (to see quickly which are near)
    this.boxes = rail.net.paths.map((p) => {
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (let k = 0; k < p.pts.length; k += 3) {
        x0 = Math.min(x0, p.pts[k]);
        x1 = Math.max(x1, p.pts[k]);
        z0 = Math.min(z0, p.pts[k + 2]);
        z1 = Math.max(z1, p.pts[k + 2]);
      }
      return [x0, z0, x1, z1];
    });
    for (const t of this.tracks.values()) this.dropTrack(t);
    this.tracks.clear();
  }

  /**
   * Build what has come near (x, z), drop what is far, light the tram
   * signals, and move the people: on into a tram or bus standing at their
   * stop with its doors open, off out of it.
   */
  update(x: number, z: number, time: number, dt: number, signals: SignalSystem, buses: readonly TrafficCar[]): void {
    if (!this.group.visible) return;
    let budget = 1;
    // ---- the stops
    if (this.stops) {
      const want = new Set<number>();
      for (const p of this.stops.near(x, z, this.radius, this.near)) {
        if (Math.hypot(p.x - x, p.z - z) > this.radius) continue;
        want.add(p.id);
        // (built once the ground under it is there: the tile loaded)
        if (!this.places.has(p.id) && budget > 0 && Number.isFinite(this.ground(p.x, p.z, 400))) {
          this.places.set(p.id, this.buildPlace(p, time));
          budget--;
        }
      }
      for (const [id, v] of this.places) {
        if (want.has(id)) continue;
        this.dropPlace(v);
        this.places.delete(id);
      }
    }
    // ---- the tracks: the overhead line and its masts, the tram signals
    const rail = this.rail;
    if (rail && rail.net.paths.length > 0) {
      const want = new Set<number>();
      const list = rail.net.paths;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p.kind === RAIL.TRAIN) continue;
        // (near: its rectangle within reach)
        const b = this.boxes[i];
        if (!b || x < b[0] - this.trackRadius || x > b[2] + this.trackRadius || z < b[1] - this.trackRadius || z > b[3] + this.trackRadius) continue;
        want.add(i);
        if (!this.tracks.has(i) && budget > 0) {
          this.tracks.set(i, this.buildTrack(i));
          budget--;
        }
      }
      for (const [i, t] of this.tracks) {
        if (want.has(i)) continue;
        this.dropTrack(t);
        this.tracks.delete(i);
      }
      // the tram signals: what the light of the trams' approach shows
      for (const t of this.tracks.values()) {
        for (const s of t.signals) {
          const st = signals.get(s.sc, s.group);
          const a: TramAspect = st === SIG.FLASH ? 'dark' : st === SIG.GREEN ? 'F1' : st === SIG.AMBER || st === SIG.RED_AMBER ? 'F4' : 'F0';
          if (s.head.aspect !== a) s.head.set(a);
        }
        // the switch signals: the way the switch is set for the tram that comes up to it (straight on while none does)
        for (const w of t.switches) {
          let turn = 0;
          for (const v of rail.vehicles) {
            if (v.path !== w.path || v.dir !== w.dir) continue;
            const p = rail.net.paths[w.path];
            const left = w.dir > 0 ? p.len - v.s : v.s;
            if (left > 150) continue;
            const next = v.plan[0] ?? rail.lineNext(v, w.path, w.dir);
            const way = next ? w.ways.find((x) => x.path === next.path && x.dir === next.dir) : undefined;
            turn = way?.turn ?? 0;
            break;
          }
          const a: SwitchAspect = turn > 0 ? 'W3' : turn < 0 ? 'W2' : 'W1';
          if (w.head.aspect !== a) w.head.set(a);
        }
      }
    }
    // ---- the people
    this.movePeople(time, dt, buses);
  }

  private buildPlace(place: StopPlace, time: number): PlaceView {
    const root = new THREE.Group();
    root.name = `stop ${place.name}`;
    const view: PlaceView = { place, root, signs: [], boards: [], people: [], spots: [], seats: [], served: new Set(), nextArrival: time + 10 };
    const tram = (place.kind & STOP_FLAG.TRAM) !== 0;
    const statics = new THREE.Group();
    for (const pole of place.poles) {
      const y = this.ground(pole.x, pole.z, 400);
      if (!Number.isFinite(y)) continue;
      // facing the road (or the track): the way to the nearest carriageway
      const yaw = this.faceRoad(pole.x, pole.z);
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      // along the kerb: to the right of the way it faces
      const ax = Math.cos(yaw);
      const az = -Math.sin(yaw);
      const at = (along: number, back: number): [number, number] => [pole.x + ax * along - fx * back, pole.z + az * along - fz * back];
      const put = (o: THREE.Object3D, along: number, back: number, turn = 0): void => {
        const [px, pz] = at(along, back);
        o.position.set(px, this.groundOr(px, pz, y + 2, y), pz);
        o.rotation.y = yaw + turn;
        statics.add(o);
      };
      const kind: StopKind = pole.flags & STOP_FLAG.TRAM ? (pole.flags & STOP_FLAG.BUS ? 'both' : 'tram') : 'bus';
      // (the tiles already show the sign of a stop mapped on the road itself)
      if (!(pole.flags & STOP_FLAG.ON_ROAD)) {
        const sign = stopSign(kind, place.name);
        sign.position.set(pole.x, y, pole.z);
        sign.rotation.y = yaw;
        root.add(sign);
        view.signs.push(sign);
      }
      if (pole.flags & STOP_FLAG.SHELTER) {
        const w = 3.6;
        put(shelter(w), 2.6, 1.6);
        for (const [sx, sz] of shelterSeats(w)) {
          const [px, pz] = at(2.6 + sx, 1.6 - sz);
          view.seats.push({ x: px, z: pz, yaw });
        }
      } else if (pole.flags & STOP_FLAG.BENCH) {
        put(bench(), -1.8, 1.4);
        for (const [sx, sz] of benchSeats()) {
          const [px, pz] = at(-1.8 + sx, 1.4 - sz);
          view.seats.push({ x: px, z: pz, yaw });
        }
      }
      if (pole.flags & STOP_FLAG.BIN) put(bin(), 0.9, 0.5);
      if (pole.flags & STOP_FLAG.BOARD) {
        const b = new DepartureBoard(true);
        b.group.position.set(...((): [number, number, number] => {
          const [px, pz] = at(-0.9, 0.6);
          return [px, this.groundOr(px, pz, y + 2, y), pz];
        })());
        b.group.rotation.y = yaw;
        root.add(b.group);
        view.boards.push(b);
      }
      for (let k = -2; k <= 2; k++) {
        const [px, pz] = at(k * 1.1, 1.2 + (k & 1) * 0.5);
        view.spots.push({ x: px, z: pz, yaw });
      }
    }
    // platforms drawn on the map
    for (const pf of place.platforms) {
      if (pf.area || pf.pts.length < 4) continue;
      const pts: Array<[number, number, number]> = [];
      for (let i = 0; i < pf.pts.length; i += 2) pts.push([pf.pts[i], this.ground(pf.pts[i], pf.pts[i + 1], 400), pf.pts[i + 1]]);
      if (pts.some((p) => !Number.isFinite(p[1]))) continue;
      // its edge is on the side of the track or road: towards the nearest carriageway from its middle
      const mid = pts[Math.floor(pts.length / 2)];
      const nxt = pts[Math.min(pts.length - 1, Math.floor(pts.length / 2) + 1)];
      const prv = pts[Math.max(0, Math.floor(pts.length / 2) - 1)];
      const dx = nxt[0] - prv[0];
      const dz = nxt[2] - prv[2];
      const yaw = this.faceRoad(mid[0], mid[2]);
      // (right of the line's direction is (−dz, dx) … in the world frame (x east, z south): (−dz, dx) points right)
      const side: 1 | -1 = -Math.sin(yaw) * -dz + -Math.cos(yaw) * dx > 0 ? 1 : -1;
      const width = pf.width > 0.8 ? Math.min(pf.width, 5) : tram ? 2.6 : 2;
      const m = platform(pts, width, tram ? 0.24 : 0.16, side);
      statics.add(m);
      for (let i = 1; i < pts.length; i += 2) view.spots.push({ x: pts[i][0], z: pts[i][2], yaw });
    }
    // the tram's stops: the board where its front stops, and a platform beside the track where the map draws none
    if (tram && this.rail) this.addTramStops(view, statics);
    if (statics.children.length > 0) root.add(mergeStatic(statics));
    for (const b of view.boards) b.set(this.departures(place, time));
    this.group.add(root);
    // the people already there
    const n = Math.floor(hash01(place.id * 7919 + Math.floor(time / 600)) * (tram ? 7 : 4));
    for (let i = 0; i < n; i++) this.arrive(view, i, time, true);
    return view;
  }

  /** The Sh 7 board at each mark of the tram's stops of this place, and a platform where the map has none and the track runs off the road. */
  private addTramStops(view: PlaceView, statics: THREE.Group): void {
    const rail = this.rail;
    if (!rail) return;
    const place = view.place;
    const net = rail.net;
    const smp = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };
    const hasPlatform = place.platforms.some((p) => !p.area);
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const list = net.near(place.x + (i % 3) * 60 - 60, place.z + Math.floor(i / 3) * 60 - 60);
      for (let k = 0; k < list.length; k += 2) {
        const path = list[k];
        const p = net.paths[path];
        p.stops.forEach((mark, si) => {
          if (p.stopNames[si] !== place.name || seen.has(`${path}:${mark}`)) return;
          seen.add(`${path}:${mark}`);
          net.sample(path, mark, smp);
          if (Math.hypot(smp.x - place.x, smp.z - place.z) > 250) return;
          // which way the trams run here (as the piece is drawn, or against it), and the side of the platform
          const dir = p.way !== 0 ? p.way : 1;
          const side = p.stopSides[si] !== 0 ? p.stopSides[si] * dir : 1;
          // right of the way of travel: (−tz, tx)·dir
          const rx = -smp.tz * dir;
          const rz = smp.tx * dir;
          const board = stopBoard();
          board.position.set(smp.x + rx * side * 1.85, smp.y - 0.1, smp.z + rz * side * 1.85);
          board.rotation.y = Math.atan2(smp.tx * dir, smp.tz * dir);
          statics.add(board);
          if (hasPlatform) return;
          // a platform along the 32 m behind the mark – not where the track runs in the road (people get on from the pavement there)
          const pts: Array<[number, number, number]> = [];
          let onRoad = 0;
          for (let d = -30; d <= 2; d += 4) {
            net.sample(path, Math.max(0, Math.min(p.len, mark + d * dir)), smp);
            const ox = smp.x + -smp.tz * dir * side * 2.75;
            const oz = smp.z + smp.tx * dir * side * 2.75;
            if (this.world.surfaceAt(ox, oz, smp.y + 2, hit) && hit.zone === 0) onRoad++;
            pts.push([ox, smp.y - 0.1, oz]);
          }
          if (onRoad > 1 || pts.length < 3) return;
          // (the points run the way the trams do; a platform on their right has its edge – the track – on its left)
          statics.add(platform(pts, 2.5, 0.24, side > 0 ? -1 : 1));
          for (let q = 1; q < pts.length; q += 2) view.spots.push({ x: pts[q][0] - -smp.tz * dir * side * 0.6, z: pts[q][2] - smp.tx * dir * side * 0.6, yaw: Math.atan2(-smp.tz * dir * side, smp.tx * dir * side) });
        });
      }
    }
  }

  /** The height of the ground at (x, z) – `or` where it is not known yet (its tile not loaded). */
  private groundOr(x: number, z: number, yRef: number, or: number): number {
    const y = this.ground(x, z, yRef);
    return Number.isFinite(y) ? y : or;
  }

  /** The way from (x, z) to the nearest carriageway, as a yaw (what faces it looks at the road). */
  private faceRoad(x: number, z: number): number {
    if (this.world.nearestRoad(x, z, 40, 0, hit) && hit.edge) {
      samplePolyline(hit.edge.pl, hit.s, tmp);
      const dx = tmp.x - x;
      const dz = tmp.z - z;
      if (Math.hypot(dx, dz) > 0.3) return Math.atan2(-dx, -dz);
    }
    return 0;
  }

  /** What the departure board of a stop shows: the lines of the map that call there – and when, by the clock. */
  private departures(place: StopPlace, time: number): Array<{ line: string; destination: string; minutes: number | string }> {
    const rows: Array<{ line: string; destination: string; minutes: number | string }> = [];
    const lines = this.lines.filter((l) => l.stops.includes(place.name));
    lines.forEach((l, i) => {
      const every = 10 + (hash01(place.id + i * 31) > 0.5 ? 5 : 0);
      const at = (Math.floor(hash01(place.id * 13 + i) * every) - Math.floor(time / 60)) % every;
      rows.push({ line: l.ref, destination: l.to, minutes: ((at + every) % every) || 'sofort' });
    });
    rows.sort((a, b) => (typeof a.minutes === 'number' ? a.minutes : 0) - (typeof b.minutes === 'number' ? b.minutes : 0));
    return rows.slice(0, 4);
  }

  /** the lines of the trams: their number, their destination and the names of their stops (set by the game) */
  lines: Array<{ ref: string; to: string; stops: string[] }> = [];

  private dropPlace(v: PlaceView): void {
    for (const s of v.signs) releaseModel(s);
    for (const b of v.boards) b.dispose();
    this.group.remove(v.root);
    v.root.traverse((o) => {
      if (o instanceof THREE.Mesh && !o.userData.shared) o.geometry.dispose();
    });
  }

  /** The overhead line along a piece of track that has one (and the masts that carry it), and the tram signals on it. */
  private buildTrack(i: number): TrackView {
    const rail = this.rail as RailTraffic;
    const p = rail.net.paths[i];
    const root = new THREE.Group();
    root.name = `track ${i}`;
    const view: TrackView = { root, signals: [], switches: [] };
    const n = p.pts.length / 3;
    // a wire where the map says so – and on the tracks of the trams where it does not say (they all have one)
    const wired = p.wire === 1 || (p.wire === -1 && p.kind === RAIL.TRAM);
    if (wired && n >= 2) {
      const pts = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) {
        pts[k * 3] = p.pts[k * 3];
        pts[k * 3 + 1] = p.pts[k * 3 + 1] + CONTACT_WIRE_HEIGHT;
        pts[k * 3 + 2] = p.pts[k * 3 + 2];
      }
      root.add(contactWire(pts, n < 60));
      // masts every 35 m on the right of the piece's direction – not in the road (there the wire hangs from span wires)
      const masts = new THREE.Group();
      const smp = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };
      for (let s = 12 + (i % 7) * 3; s < p.len - 6; s += 35) {
        rail.net.sample(i, s, smp);
        const mx = smp.x - smp.tz * 2.6;
        const mz = smp.z + smp.tx * 2.6;
        if (this.world.surfaceAt(mx, mz, smp.y + 2, hit) && hit.zone === 0) continue;
        const m = catenaryMast(2.6);
        // (where the tile beside the track is not loaded yet: at the track's height)
        m.position.set(mx, this.groundOr(mx, mz, smp.y + 2, smp.y), mz);
        // (the arm – the mast's +x – reaches over the track, to the left of the piece's direction)
        m.rotation.y = Math.atan2(smp.tx, smp.tz);
        masts.add(m);
      }
      if (masts.children.length > 0) root.add(mergeStatic(masts));
    }
    // the switch signals (W 1–W 3): a few metres before a switch at an end of the piece, on the right
    const end = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };
    for (const dir of p.way === 0 ? ([1, -1] as const) : ([p.way] as const)) {
      const ways = rail.net.waysOn(i, dir, [RAIL.TRAM, RAIL.LIGHT]);
      if (ways.length < 2 || p.len < 10) continue;
      rail.net.sample(i, dir > 0 ? p.len : 0, end);
      const hx = end.tx * dir;
      const hz = end.tz * dir;
      const branches = ways.map((w) => {
        const q = rail.net.paths[w.path];
        const m = q.cum.length;
        const i0 = w.dir > 0 ? 0 : m - 1;
        const i1 = w.dir > 0 ? Math.min(m - 1, 3) : Math.max(0, m - 4);
        const dx = q.pts[i1 * 3] - q.pts[i0 * 3];
        const dz = q.pts[i1 * 3 + 2] - q.pts[i0 * 3 + 2];
        // (+ to the left of the way it runs)
        const a = Math.atan2(-(hx * dz - hz * dx), hx * dx + hz * dz);
        return { path: w.path, dir: w.dir, turn: Math.abs(a) < 0.06 ? 0 : Math.sign(a) };
      });
      // (the straightest of them counts as straight on)
      const straightest = branches.reduce((b, w) => (Math.abs(w.turn) < Math.abs(b.turn) ? w : b), branches[0]);
      if (straightest.turn !== 0 && branches.every((b) => b.turn !== 0)) straightest.turn = 0;
      const at = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };
      rail.net.sample(i, dir > 0 ? Math.max(0, p.len - 8) : Math.min(p.len, 8), at);
      const head = new SwitchSignal(true);
      head.group.position.set(at.x - at.tz * dir * 1.75, at.y - 0.1, at.z + at.tx * dir * 1.75);
      head.group.rotation.y = Math.atan2(at.tx * dir, at.tz * dir);
      root.add(head.group);
      view.switches.push({ head, path: i, dir, ways: branches });
    }
    // the tram signals: where the track enters a junction with lights, a head on the right a few metres before
    const smp = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };
    for (const dir of p.way === 0 ? [1, -1] : [p.way]) {
      let inside = false;
      for (let k = 0; k < n; k++) {
        const s = dir > 0 ? p.cum[k] : p.len - p.cum[n - 1 - k];
        rail.net.sample(i, s, smp);
        const node = this.world.surfaceAt(smp.x, smp.z, smp.y + 1, hit) ? hit.node : null;
        const lit = !!node && node.ctrl === CTRL.SIGNALS && node.sc >= 0;
        if (lit && !inside && node) {
          // the arm the tram comes in on: the one pointing back the way it comes
          const hx = smp.tx * dir;
          const hz = smp.tz * dir;
          let best = -1;
          let bestDot = 0.3;
          node.arms.forEach((arm, ai) => {
            const dot = -(arm.dx * hx + arm.dz * hz);
            if (dot > bestDot && arm.sg >= 0) {
              bestDot = dot;
              best = ai;
            }
          });
          if (best >= 0) {
            const back = Math.max(0, Math.min(p.len, s - dir * 4));
            rail.net.sample(i, back, smp);
            const rx = -smp.tz * dir;
            const rz = smp.tx * dir;
            const head = new TramSignal(true);
            head.group.position.set(smp.x + rx * 1.9, smp.y - 0.1, smp.z + rz * 1.9);
            head.group.rotation.y = Math.atan2(smp.tx * dir, smp.tz * dir);
            root.add(head.group);
            view.signals.push({ head, sc: node.sc, group: node.arms[best].sg });
          }
        }
        inside = lit;
      }
    }
    this.group.add(root);
    return view;
  }

  private dropTrack(t: TrackView): void {
    this.group.remove(t.root);
    t.root.traverse((o) => {
      if ((o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Line) && !o.userData.shared) o.geometry.dispose();
    });
  }

  /** Somebody comes to the stop (or is there already): standing at one of its spots, or sitting down. */
  private arrive(v: PlaceView, i: number, time: number, already: boolean): void {
    const look = Math.floor(hash01(v.place.id * 104729 + i * 31 + Math.floor(time)) * 100000);
    const seat = v.seats.length > 0 && hash01(look) < 0.4 ? v.seats.find((s) => !v.people.some((p) => p.sit && Math.hypot(p.x - s.x, p.z - s.z) < 0.3)) : undefined;
    const spot = seat ?? v.spots[look % Math.max(1, v.spots.length)];
    if (!spot) return;
    const jitter = seat ? 0 : (hash01(look + 7) - 0.5) * 1.2;
    const x = spot.x + Math.cos(spot.yaw) * jitter;
    const z = spot.z - Math.sin(spot.yaw) * jitter;
    const w: Waiter = { x, y: this.groundOr(x, z, 400, this.ground(v.place.x, v.place.z, 400)), z, yaw: spot.yaw + (seat ? 0 : (hash01(look + 3) - 0.5) * 0.8), look, sit: !!seat, walk: -1, state: 'wait', tx: x, tz: z, speed: 1.2 + hash01(look + 5) * 0.3 };
    if (!already) {
      // walking up from a little way off
      const a = hash01(look + 9) * Math.PI * 2;
      w.x += Math.cos(a) * 18;
      w.z += Math.sin(a) * 18;
      w.sit = false;
      w.walk = 0;
      w.state = 'leave';
      // (on the way to the stop: "leave" with the stop as its goal, then waiting)
      w.tx = x;
      w.tz = z;
    }
    v.people.push(w);
  }

  /** The doors of the vehicles standing at a stop with their doors open: where they are, and which side they open to. */
  private openDoors(v: PlaceView, buses: readonly TrafficCar[]): Array<{ id: number; x: number; z: number }> {
    const out: Array<{ id: number; x: number; z: number }> = [];
    const px = v.place.x;
    const pz = v.place.z;
    const rail = this.rail;
    if (rail) {
      for (const rv of rail.vehicles) {
        if (rv.player || rv.dwell <= 0.5 || Math.abs(rv.speed) > 0.05) continue;
        const c0 = rv.cars[0];
        if (Math.hypot(c0.x - px, c0.z - pz) > 120) continue;
        for (const door of this.tramDoors(rv)) out.push({ id: rv.id * 16 + out.length, x: door.x, z: door.z });
      }
    }
    for (const b of buses) {
      if (!b.bus?.doors || Math.hypot(b.x - px, b.z - pz) > 80) continue;
      // the front door: at the front on the right
      const fx = -Math.sin(b.yaw);
      const fz = -Math.cos(b.yaw);
      const rx = Math.cos(b.yaw);
      const rz = -Math.sin(b.yaw);
      out.push({ id: 1e6 + b.id, x: b.x + fx * (b.length / 2 - 1.3) + rx * (b.width / 2 + 0.4), z: b.z + fz * (b.length / 2 - 1.3) + rz * (b.width / 2 + 0.4) });
    }
    return out;
  }

  /** A tram's doors, on both sides (people come from wherever the platform is). */
  private tramDoors(rv: RailVehicle): Array<{ x: number; z: number }> {
    const out: Array<{ x: number; z: number }> = [];
    for (const c of rv.cars) {
      const s = Math.sin(c.yaw);
      const co = Math.cos(c.yaw);
      for (const along of [-0.25, 0.25]) {
        for (const side of [-1, 1]) {
          const a = along * rv.consist.carLen;
          const r = side * (rv.consist.width / 2 + 0.35);
          out.push({ x: c.x - s * a + co * r, z: c.z - co * a - s * r });
        }
      }
    }
    return out;
  }

  private movePeople(time: number, dt: number, buses: readonly TrafficCar[]): void {
    const poses = this.poses;
    poses.length = 0;
    for (const v of this.places.values()) {
      const doors = this.openDoors(v, buses);
      if (doors.length > 0) {
        // the doors are open: those waiting go to the nearest one, and a few get off
        for (const d of doors) {
          if (v.served.has(d.id)) continue;
          v.served.add(d.id);
          if (hash01(d.id + Math.floor(time)) < 0.35) {
            const look = Math.floor(hash01(d.id * 3 + time) * 100000);
            const a = hash01(look) * Math.PI * 2;
            v.people.push({ x: d.x, y: this.groundOr(d.x, d.z, 400, this.ground(v.place.x, v.place.z, 400)), z: d.z, yaw: 0, look, sit: false, walk: 0, state: 'leave', tx: d.x + Math.cos(a) * 25, tz: d.z + Math.sin(a) * 25, speed: 1.3 });
          }
        }
        for (const p of v.people) {
          if (p.state !== 'wait') continue;
          let best = doors[0];
          let bd = Infinity;
          for (const d of doors) {
            const dd = Math.hypot(d.x - p.x, d.z - p.z);
            if (dd < bd) {
              bd = dd;
              best = d;
            }
          }
          if (bd > 60) continue;
          p.state = 'board';
          p.sit = false;
          p.tx = best.x;
          p.tz = best.z;
          p.walk = 0;
        }
      } else if (v.served.size > 0) v.served.clear();
      // now and then somebody new comes to wait
      if (time > v.nextArrival) {
        v.nextArrival = time + 15 + hash01(v.place.id + time) * 40;
        if (v.people.filter((p) => p.state === 'wait').length < 8) this.arrive(v, v.people.length + Math.floor(time), time, false);
      }
      for (let i = v.people.length - 1; i >= 0; i--) {
        const p = v.people[i];
        if (p.state !== 'wait') {
          const dx = p.tx - p.x;
          const dz = p.tz - p.z;
          const d = Math.hypot(dx, dz);
          const step = p.speed * dt;
          if (d <= step + 0.05) {
            if (p.state === 'board') {
              // in through the door
              v.people.splice(i, 1);
              continue;
            }
            // arrived where they were going: at the stop (to wait) – or gone round the corner
            const atStop = v.spots.some((s) => Math.hypot(s.x - p.x, s.z - p.z) < 3);
            if (atStop) {
              p.state = 'wait';
              p.walk = -1;
              p.yaw = v.spots[0]?.yaw ?? p.yaw;
            } else {
              v.people.splice(i, 1);
              continue;
            }
          } else {
            p.x += (dx / d) * step;
            p.z += (dz / d) * step;
            p.yaw = Math.atan2(-dx, -dz);
            p.walk += step;
            p.y = this.groundOr(p.x, p.z, p.y + 1.5, p.y);
          }
        }
        poses.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, walk: p.walk, look: p.look, sit: p.sit });
      }
    }
    this.people.update(poses, time);
  }
}
