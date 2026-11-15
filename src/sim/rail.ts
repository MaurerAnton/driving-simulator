// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trams and trains: vehicles that follow the tracks of the map (see
 * tools/mapgen/rails.ts), wherever the player is near tracks.
 *
 * They run in the direction the track was drawn, take the straight way at
 * switches most of the time, slow down for curves, call at the stops, and –
 * being unable to swerve – brake for whatever stands on their track.  At
 * the end of a line they wait and go back.  For the cars of the traffic and
 * for the player they are obstacles like any other vehicle.
 */
import type { RailJson } from '../world/types.ts';
import { RAIL } from '../world/types.ts';

/** A piece of track, ready for running on. */
export interface RailPath {
  kind: number;
  /** x, y, z of the points along the middle of the track (top of rail) */
  pts: Float64Array;
  /** metres from the start at each point */
  cum: Float64Array;
  len: number;
  /** pieces joining at the start / at the end: index * 2 + (0: their start is here, 1: their end) */
  a: number[];
  b: number[];
  /** stops: metres from the start */
  stops: number[];
  /** the speed its curves allow at each point (m/s) */
  cap: Float32Array;
  /**
   * Which way it is run: 1 along the way it was drawn, -1 against it, 0
   * both ways (a single track).  On a double track everybody keeps right,
   * so the other track lies to the left of the direction of travel.
   */
  way: 1 | -1 | 0;
}

/** What a rail vehicle is made of. */
export interface Consist {
  cars: number;
  carLen: number;
  /** the joint between two cars */
  gap: number;
  width: number;
  height: number;
  vmax: number;
  accel: number;
  brake: number;
  /** the kinds of track it may run on */
  tracks: number[];
}

export const CONSISTS: Record<number, Consist> = {
  // a low-floor city tram of three sections
  [RAIL.TRAM]: { cars: 3, carLen: 9.4, gap: 0.7, width: 2.4, height: 3.35, vmax: 13.9, accel: 1.0, brake: 1.3, tracks: [RAIL.TRAM, RAIL.LIGHT] },
  // a regional tram that also uses railway lines
  [RAIL.LIGHT]: { cars: 3, carLen: 11.8, gap: 0.8, width: 2.65, height: 3.6, vmax: 19.4, accel: 1.0, brake: 1.2, tracks: [RAIL.TRAM, RAIL.LIGHT, RAIL.TRAIN] },
  // a regional train of three coaches
  [RAIL.TRAIN]: { cars: 3, carLen: 23, gap: 1.0, width: 2.85, height: 4.0, vmax: 25, accel: 0.7, brake: 0.9, tracks: [RAIL.TRAIN, RAIL.LIGHT] },
};

/** One car body: middle of its floor line at rail level, heading (0 = north, positive = left) and slope. */
export interface RailCar {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface RailVehicle {
  id: number;
  kind: number;
  consist: Consist;
  /** where its front end is: piece of track, metres from the piece's start, direction of travel along it */
  path: number;
  s: number;
  dir: 1 | -1;
  speed: number;
  /** seconds left standing (at a stop, at the end of the line) */
  dwell: number;
  /** metres to run before the next stop counts (so that two marks of one stop are served once) */
  noStop: number;
  /** pieces chosen for the way ahead, nearest first */
  plan: Array<{ path: number; dir: 1 | -1 }>;
  cars: RailCar[];
  /** where the front end has been, newest first, a point every TRAIL_STEP metres */
  trail: Trail;
  /** something is on the track ahead (for a bell, for tests) */
  blocked: boolean;
}

/** Something a rail vehicle must not run into: a circle on the ground. */
export interface RailObstacle {
  x: number;
  z: number;
  r: number;
}

/** What the rail traffic needs to know about the player's car. */
export interface RailPlayer {
  x: number;
  y: number;
  z: number;
  yaw: number;
  length: number;
  width: number;
}

const TRAIL_STEP = 0.5;

/** The way a vehicle has come: positions of its front end and where on the network they were. */
class Trail {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly path: Int32Array;
  readonly s: Float32Array;
  readonly dir: Int8Array;
  /** index of the newest entry, and how many are valid */
  head = 0;
  count = 0;
  /** metres run since the newest entry */
  since = 0;

  constructor(n: number) {
    this.n = n;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.z = new Float64Array(n);
    this.path = new Int32Array(n);
    this.s = new Float32Array(n);
    this.dir = new Int8Array(n);
  }

  /** k entries back from the newest */
  at(k: number): number {
    return (this.head - k + this.n * 4) % this.n;
  }

  push(x: number, y: number, z: number, path: number, s: number, dir: number): void {
    this.head = (this.head + 1) % this.n;
    this.x[this.head] = x;
    this.y[this.head] = y;
    this.z[this.head] = z;
    this.path[this.head] = path;
    this.s[this.head] = s;
    this.dir[this.head] = dir;
    if (this.count < this.n) this.count++;
  }
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** switches are followed up to this change of direction (cos 42°): sharper is a crossing track, not a way on */
const MAX_TURN_COS = 0.74;

export class RailNetwork {
  readonly paths: RailPath[] = [];
  /** points to start from, bucketed by 200 m cells: pairs of (piece, metres) */
  private readonly cells = new Map<number, number[]>();

  constructor(rails: readonly RailJson[]) {
    for (const r of rails) {
      const n = Math.floor(r.p.length / 3);
      const pts = Float64Array.from(r.p.slice(0, n * 3));
      const cum = new Float64Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 2] - pts[i * 3 - 1]);
      const cap = new Float32Array(n).fill(99);
      // radius of the curve through the points a dozen metres before and behind: v² / r stays gentle
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 2);
        const b = Math.min(n - 1, i + 2);
        if (a === i || b === i) continue;
        const ax = pts[i * 3] - pts[a * 3];
        const az = pts[i * 3 + 2] - pts[a * 3 + 2];
        const bx = pts[b * 3] - pts[i * 3];
        const bz = pts[b * 3 + 2] - pts[i * 3 + 2];
        const la = Math.hypot(ax, az);
        const lb = Math.hypot(bx, bz);
        if (la < 0.5 || lb < 0.5) continue;
        const turn = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
        if (turn > 0.01) cap[i] = Math.sqrt(1.1 * ((la + lb) / 2 / turn));
      }
      this.paths.push({ kind: r.k, pts, cum, len: n > 0 ? cum[n - 1] : 0, a: r.a, b: r.b, stops: r.st ?? [], cap, way: 0 });
    }
    this.paths.forEach((p, pi) => {
      const n = p.cum.length;
      for (let i = 0; i < n; i += 4) {
        const key = RailNetwork.cell(p.pts[i * 3], p.pts[i * 3 + 2]);
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(pi, p.cum[i]);
      }
    });
    // double track: on which side does the neighbouring track lie?
    this.paths.forEach((p, pi) => {
      const n = p.cum.length;
      if (n < 2) return;
      const m = n >> 1;
      const a = Math.max(0, m - 1);
      const mx = (p.pts[a * 3] + p.pts[m * 3]) / 2;
      const mz = (p.pts[a * 3 + 2] + p.pts[m * 3 + 2]) / 2;
      let tx = p.pts[m * 3] - p.pts[a * 3];
      let tz = p.pts[m * 3 + 2] - p.pts[a * 3 + 2];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      let best = 9;
      let side = 0;
      const seen = new Set<number>();
      for (let cx = -1; cx <= 1; cx++) {
        for (let cz = -1; cz <= 1; cz++) {
          const list = this.near(mx + cx * 200, mz + cz * 200);
          for (let k = 0; k < list.length; k += 2) {
            const qi = list[k];
            if (qi === pi || seen.has(qi)) continue;
            seen.add(qi);
            const q = this.paths[qi];
            for (let j = 1; j < q.cum.length; j++) {
              // nearest point of this stretch of the other track
              const x0 = q.pts[j * 3 - 3];
              const z0 = q.pts[j * 3 - 1];
              const dx = q.pts[j * 3] - x0;
              const dz = q.pts[j * 3 + 2] - z0;
              const l2 = dx * dx + dz * dz;
              if (l2 < 1e-6) continue;
              const u = clamp(((mx - x0) * dx + (mz - z0) * dz) / l2, 0, 1);
              const ox = x0 + dx * u - mx;
              const oz = z0 + dz * u - mz;
              const d = Math.hypot(ox, oz);
              // a neighbour runs alongside, two to eight metres away
              if (d < 2 || d >= best || Math.abs(dx * tx + dz * tz) / Math.sqrt(l2) < 0.9) continue;
              best = d;
              // left of the drawn direction (x east, z south): the cross product tells
              side = tx * oz - tz * ox < 0 ? 1 : -1;
            }
          }
        }
      }
      p.way = side as 1 | -1 | 0;
    });
  }

  private static cell(x: number, z: number): number {
    return (Math.floor(x / 200) + 4096) * 8192 + Math.floor(z / 200) + 4096;
  }

  /** Places on tracks in the 200 m cell around a point: pairs of (piece, metres). */
  near(x: number, z: number): readonly number[] {
    return this.cells.get(RailNetwork.cell(x, z)) ?? [];
  }

  /** Position (and direction of the track) at `s` metres along a piece. */
  sample(path: number, s: number, out: { x: number; y: number; z: number; tx: number; tz: number; cap: number }): void {
    const p = this.paths[path];
    const n = p.cum.length;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = p.cum[hi] - p.cum[lo];
    const t = seg > 1e-6 ? clamp((s - p.cum[lo]) / seg, 0, 1) : 0;
    const a = lo * 3;
    const b = hi * 3;
    out.x = p.pts[a] + (p.pts[b] - p.pts[a]) * t;
    out.y = p.pts[a + 1] + (p.pts[b + 1] - p.pts[a + 1]) * t;
    out.z = p.pts[a + 2] + (p.pts[b + 2] - p.pts[a + 2]) * t;
    const l = Math.hypot(p.pts[b] - p.pts[a], p.pts[b + 2] - p.pts[a + 2]) || 1;
    out.tx = (p.pts[b] - p.pts[a]) / l;
    out.tz = (p.pts[b + 2] - p.pts[a + 2]) / l;
    out.cap = Math.min(p.cap[lo], p.cap[hi]);
  }

  /**
   * The ways on from the end of a piece that is being left in direction
   * `dir`: pieces of a kind the vehicle may use that continue without a
   * sharp bend, the straightest first.
   */
  waysOn(path: number, dir: 1 | -1, tracks: readonly number[]): Array<{ path: number; dir: 1 | -1; straight: number }> {
    const p = this.paths[path];
    const n = p.cum.length;
    if (n < 2) return [];
    // direction of travel at the end that is being left
    const e = dir > 0 ? n - 1 : 0;
    const f = dir > 0 ? n - 2 : 1;
    let hx = p.pts[e * 3] - p.pts[f * 3];
    let hz = p.pts[e * 3 + 2] - p.pts[f * 3 + 2];
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl;
    hz /= hl;
    const out: Array<{ path: number; dir: 1 | -1; straight: number }> = [];
    for (const link of dir > 0 ? p.b : p.a) {
      const qi = link >> 1;
      const q = this.paths[qi];
      if (!q || q.cum.length < 2 || !tracks.includes(q.kind)) continue;
      // entered at its start it is run along, entered at its end against
      const qdir: 1 | -1 = (link & 1) === 0 ? 1 : -1;
      const m = q.cum.length;
      const i0 = qdir > 0 ? 0 : m - 1;
      const i1 = qdir > 0 ? 1 : m - 2;
      const dx = q.pts[i1 * 3] - q.pts[i0 * 3];
      const dz = q.pts[i1 * 3 + 2] - q.pts[i0 * 3 + 2];
      const dl = Math.hypot(dx, dz) || 1;
      const straight = (dx * hx + dz * hz) / dl;
      if (straight >= MAX_TURN_COS) out.push({ path: qi, dir: qdir, straight });
    }
    return out.sort((x, y) => y.straight - x.straight);
  }
}

const tmp = { x: 0, y: 0, z: 0, tx: 0, tz: 0, cap: 0 };

export class RailTraffic {
  readonly net: RailNetwork;
  readonly vehicles: RailVehicle[] = [];
  /** how many vehicles may be about at once */
  target = 4;
  /** new vehicles appear this far from the player (out of the way, but soon in sight), and go when further than `far` */
  ringMin = 260;
  ringMax = 620;
  far = 900;
  private nextId = 1;
  private spawnT = 0;
  private readonly random: () => number;
  private readonly obstacles: RailObstacle[] = [];

  constructor(rails: readonly RailJson[], random: () => number = Math.random) {
    this.net = new RailNetwork(rails);
    this.random = random;
  }

  clear(): void {
    this.vehicles.length = 0;
  }

  /**
   * Put a vehicle on the track at a place (its front end), running in
   * direction `dir` of that piece.  Null if its length does not fit behind it.
   */
  spawnAt(path: number, s: number, dir: 1 | -1, speed = 0): RailVehicle | null {
    const p = this.net.paths[path];
    if (!p || p.len < 2) return null;
    const consist = CONSISTS[p.kind] ?? CONSISTS[RAIL.TRAM];
    const length = consist.cars * consist.carLen + (consist.cars - 1) * consist.gap;
    const n = Math.ceil((length + 6) / TRAIL_STEP) + 8;
    const trail = new Trail(n);
    // lay the vehicle out behind its front end: walk back along the track
    const back: Array<[number, number, number, number, number, number]> = [];
    let cp = path;
    let cs = clamp(s, 0, p.len);
    let cd: 1 | -1 = dir > 0 ? -1 : 1;
    for (let k = 0; k < n; k++) {
      this.net.sample(cp, cs, tmp);
      // (recorded with the direction the vehicle faces, not the one walked)
      back.push([tmp.x, tmp.y, tmp.z, cp, cs, -cd]);
      let step = TRAIL_STEP;
      while (step > 0) {
        const q = this.net.paths[cp];
        const room = cd > 0 ? q.len - cs : cs;
        if (room >= step) {
          cs += cd * step;
          step = 0;
        } else {
          step -= room;
          const on = this.net.waysOn(cp, cd, consist.tracks)[0];
          if (!on) return null;
          cp = on.path;
          cd = on.dir;
          cs = cd > 0 ? 0 : this.net.paths[cp].len;
        }
      }
    }
    for (let k = back.length - 1; k >= 0; k--) trail.push(...back[k]);
    const v: RailVehicle = {
      id: this.nextId++,
      kind: p.kind,
      consist,
      path,
      s: clamp(s, 0, p.len),
      dir,
      speed,
      dwell: 0,
      noStop: 30,
      plan: [],
      cars: Array.from({ length: consist.cars }, () => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 })),
      trail,
      blocked: false,
    };
    this.place(v);
    this.vehicles.push(v);
    return v;
  }

  /** The cars of all vehicles as circles (three along each car), for whoever must keep clear of them. */
  circles(skip: RailVehicle | null, out: RailObstacle[]): void {
    for (const v of this.vehicles) {
      if (v === skip) continue;
      const half = v.consist.carLen / 2;
      for (const c of v.cars) {
        const fx = -Math.sin(c.yaw);
        const fz = -Math.cos(c.yaw);
        for (const k of [-0.7, 0, 0.7]) out.push({ x: c.x + fx * half * k, z: c.z + fz * half * k, r: v.consist.width / 2 + 0.2 });
      }
    }
  }

  /**
   * One step.  `others`: what must not be run into besides the player – the
   * cars of the road traffic as circles.
   */
  update(dt: number, player: RailPlayer, others: readonly RailObstacle[] = []): void {
    // come and go with the player
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const c = this.vehicles[i].cars[0];
      if (Math.hypot(c.x - player.x, c.z - player.z) > this.far) this.vehicles.splice(i, 1);
    }
    this.spawnT -= dt;
    if (this.spawnT <= 0 && this.vehicles.length < this.target) {
      this.spawnT = 1.5;
      this.spawnNear(player);
    }

    for (const v of this.vehicles) {
      const obstacles = this.obstacles;
      obstacles.length = 0;
      // the player's car: two circles along its length
      const px = -Math.sin(player.yaw);
      const pz = -Math.cos(player.yaw);
      const off = Math.max(0, player.length / 2 - player.width / 2);
      obstacles.push({ x: player.x + px * off, z: player.z + pz * off, r: player.width / 2 + 0.15 }, { x: player.x - px * off, z: player.z - pz * off, r: player.width / 2 + 0.15 });
      for (const o of others) if (Math.abs(o.x - v.cars[0].x) < 120 && Math.abs(o.z - v.cars[0].z) < 120) obstacles.push(o);
      this.circles(v, obstacles);
      this.step(v, dt, obstacles);
    }
  }

  /** A new vehicle somewhere on a track in the ring around the player (if there is a track). */
  private spawnNear(player: RailPlayer): RailVehicle | null {
    for (let tries = 0; tries < 10; tries++) {
      const ang = this.random() * Math.PI * 2;
      const rad = this.ringMin + this.random() * (this.ringMax - this.ringMin);
      const list = this.net.near(player.x + Math.cos(ang) * rad, player.z + Math.sin(ang) * rad);
      if (list.length === 0) continue;
      const k = Math.floor(this.random() * (list.length / 2)) * 2;
      const path = list[k];
      const s = list[k + 1];
      this.net.sample(path, s, tmp);
      const d = Math.hypot(tmp.x - player.x, tmp.z - player.z);
      if (d < this.ringMin || d > this.ringMax + 150) continue;
      // not into another one
      if (this.vehicles.some((v) => v.cars.some((c) => Math.hypot(c.x - tmp.x, c.z - tmp.z) < 160))) continue;
      // on a double track keep to the right-hand one; a single track is run both ways
      const way = this.net.paths[path].way;
      const dir: 1 | -1 = way !== 0 ? way : this.random() < 0.5 ? 1 : -1;
      const v = this.spawnAt(path, s, dir, 0);
      if (v) {
        v.speed = Math.min(v.consist.vmax * 0.6, tmp.cap);
        return v;
      }
    }
    return null;
  }

  private step(v: RailVehicle, dt: number, obstacles: readonly RailObstacle[]): void {
    const c = v.consist;
    if (v.dwell > 0) {
      v.dwell -= dt;
      v.speed = 0;
      this.place(v);
      return;
    }
    // ---- look ahead along the way it will take: curves, stops, the end of the line, things on the track
    const reach = (v.speed * v.speed) / (2 * c.brake) + 25;
    let allowed = c.vmax;
    let stopIn = Infinity;
    let blockIn = Infinity;
    let endIn = Infinity;
    let cp = v.path;
    let cs = v.s;
    let cd = v.dir;
    let planned = 0;
    let dist = 0;
    const halfW = c.width / 2;
    while (dist <= reach) {
      const p = this.net.paths[cp];
      this.net.sample(cp, cs, tmp);
      // a curve further on limits the speed now by what braking takes
      allowed = Math.min(allowed, Math.sqrt(tmp.cap * tmp.cap + 2 * c.brake * 0.7 * dist));
      if (dist > 1) {
        for (const o of obstacles) {
          const d = Math.hypot(o.x - tmp.x, o.z - tmp.z);
          if (d < o.r + halfW + 0.25) {
            blockIn = Math.min(blockIn, dist);
            break;
          }
        }
        if (blockIn < Infinity) break;
      }
      const step = 2.5;
      const room = cd > 0 ? p.len - cs : cs;
      // stops on this piece within the next step
      if (v.noStop <= dist) {
        for (const st of p.stops) {
          const ahead = (st - cs) * cd;
          if (ahead >= 0 && ahead <= Math.min(step, room) + 0.01) stopIn = Math.min(stopIn, dist + ahead);
        }
      }
      if (room > step) {
        cs += cd * step;
        dist += step;
        continue;
      }
      // onto the next piece: the one planned, or choose now
      dist += room;
      let next = v.plan[planned];
      if (!next) {
        const ways = this.net.waysOn(cp, cd, c.tracks);
        if (ways.length > 0) {
          // mostly straight on, now and then the branch
          const pick = ways.length > 1 && this.random() < 0.3 ? ways[1 + Math.floor(this.random() * (ways.length - 1))] : ways[0];
          next = { path: pick.path, dir: pick.dir };
          v.plan.push(next);
        }
      }
      if (!next) {
        endIn = dist;
        break;
      }
      planned++;
      cp = next.path;
      cd = next.dir;
      cs = cd > 0 ? 0 : this.net.paths[cp].len;
    }

    // ---- speed
    v.blocked = blockIn < Infinity;
    const stopFor = (d: number, margin: number, brake: number): number => Math.sqrt(2 * brake * Math.max(0, d - margin));
    let target = allowed;
    if (stopIn < Infinity) target = Math.min(target, stopFor(stopIn, 0.3, c.brake * 0.8));
    if (endIn < Infinity) target = Math.min(target, stopFor(endIn, 1.5, c.brake * 0.8));
    if (blockIn < Infinity) target = Math.min(target, stopFor(blockIn, 4.5, c.brake * 1.6));
    if (v.speed < target) v.speed = Math.min(target, v.speed + c.accel * dt);
    else v.speed = Math.max(target, v.speed - (blockIn < Infinity ? c.brake * 2 : c.brake) * dt);
    if (v.speed < 0.05 && target < 0.3) v.speed = 0;

    // ---- arrived?
    if (v.speed === 0) {
      if (stopIn < 1.2) {
        v.dwell = 12 + this.random() * 8;
        v.noStop = 70;
      } else if (endIn < 3 && blockIn === Infinity) {
        // the end of the line: wait, then go back the way it came
        this.reverse(v);
        v.dwell = 20 + this.random() * 10;
        v.noStop = 40;
      }
      this.place(v);
      return;
    }

    // ---- move the front end, leaving the trail the cars follow
    let move = v.speed * dt;
    v.noStop = Math.max(0, v.noStop - move);
    while (move > 0) {
      const p = this.net.paths[v.path];
      const room = v.dir > 0 ? p.len - v.s : v.s;
      const go = Math.min(move, room, TRAIL_STEP - v.trail.since);
      v.s += v.dir * go;
      move -= go;
      v.trail.since += go;
      if (v.trail.since >= TRAIL_STEP - 1e-9) {
        this.net.sample(v.path, v.s, tmp);
        v.trail.push(tmp.x, tmp.y, tmp.z, v.path, v.s, v.dir);
        v.trail.since = 0;
      }
      if (go >= room - 1e-9 && move > 0) {
        const next = v.plan.shift();
        if (!next) {
          v.speed = 0;
          break;
        }
        v.path = next.path;
        v.dir = next.dir;
        v.s = v.dir > 0 ? 0 : this.net.paths[v.path].len;
      }
    }
    this.place(v);
  }

  /** The rear end becomes the front end. */
  private reverse(v: RailVehicle): void {
    const t = v.trail;
    const length = v.consist.cars * v.consist.carLen + (v.consist.cars - 1) * v.consist.gap;
    const k = Math.min(t.count - 1, Math.round(length / TRAIL_STEP));
    const tail = t.at(k);
    const entries: Array<[number, number, number, number, number, number]> = [];
    // from the old front end to the old rear end: that is oldest … newest of the way back
    for (let i = 0; i <= k; i++) {
      const e = t.at(i);
      entries.push([t.x[e], t.y[e], t.z[e], t.path[e], t.s[e], -t.dir[e]]);
    }
    v.path = t.path[tail];
    v.s = t.s[tail];
    v.dir = t.dir[tail] > 0 ? -1 : 1;
    t.count = 0;
    t.since = 0;
    for (const e of entries) t.push(...e);
    v.plan.length = 0;
  }

  /** Put the cars on the trail behind the front end. */
  private place(v: RailVehicle): void {
    const c = v.consist;
    const t = v.trail;
    const at = (dist: number, out: { x: number; y: number; z: number }): void => {
      // (the front end is `since` metres past the newest entry of the trail)
      const f = clamp((dist - t.since) / TRAIL_STEP, 0, t.count - 1.001);
      const i = Math.floor(f);
      const u = f - i;
      const a = t.at(i);
      const b = t.at(i + 1);
      out.x = t.x[a] + (t.x[b] - t.x[a]) * u;
      out.y = t.y[a] + (t.y[b] - t.y[a]) * u;
      out.z = t.z[a] + (t.z[b] - t.z[a]) * u;
    };
    for (let i = 0; i < c.cars; i++) {
      const start = i * (c.carLen + c.gap);
      // each car rides on two pivots a little in from its ends
      at(start + c.carLen * 0.14, pivotA);
      at(start + c.carLen * 0.86, pivotB);
      const car = v.cars[i];
      const fx = pivotA.x - pivotB.x;
      const fy = pivotA.y - pivotB.y;
      const fz = pivotA.z - pivotB.z;
      car.x = (pivotA.x + pivotB.x) / 2;
      car.y = (pivotA.y + pivotB.y) / 2;
      car.z = (pivotA.z + pivotB.z) / 2;
      const flat = Math.hypot(fx, fz);
      if (flat > 1e-6) {
        car.yaw = Math.atan2(-fx, -fz);
        car.pitch = Math.atan2(fy, flat);
      }
    }
  }

  /**
   * Does the player's car (a rectangle on the ground) touch a rail vehicle?
   * Returns how to push it clear (unit vector away from the vehicle, depth)
   * and how fast that vehicle moves, or null.
   */
  touching(player: RailPlayer): { nx: number; nz: number; depth: number; vx: number; vz: number } | null {
    let best: { nx: number; nz: number; depth: number; vx: number; vz: number } | null = null;
    for (const v of this.vehicles) {
      for (const car of v.cars) {
        if (Math.abs(car.y - player.y) > 4) continue;
        const reach = v.consist.carLen / 2 + player.length;
        if (Math.abs(car.x - player.x) > reach || Math.abs(car.z - player.z) > reach) continue;
        const hit = boxOverlap(player.x, player.z, player.yaw, player.length / 2, player.width / 2, car.x, car.z, car.yaw, v.consist.carLen / 2, v.consist.width / 2);
        if (hit && (!best || hit.depth > best.depth)) best = { ...hit, vx: -Math.sin(car.yaw) * v.speed, vz: -Math.cos(car.yaw) * v.speed };
      }
    }
    return best;
  }
}

const pivotA = { x: 0, y: 0, z: 0 };
const pivotB = { x: 0, y: 0, z: 0 };

/**
 * Two rectangles on the ground (centre, heading, half length, half width):
 * if they overlap, the shortest way to push the first one clear of the
 * second – a unit vector and a depth.  (Separating-axis test.)
 */
export function boxOverlap(ax: number, az: number, ayaw: number, ahl: number, ahw: number, bx: number, bz: number, byaw: number, bhl: number, bhw: number): { nx: number; nz: number; depth: number } | null {
  // forward and right of each rectangle
  const axes = [
    [-Math.sin(ayaw), -Math.cos(ayaw)],
    [Math.cos(ayaw), -Math.sin(ayaw)],
    [-Math.sin(byaw), -Math.cos(byaw)],
    [Math.cos(byaw), -Math.sin(byaw)],
  ];
  const dx = ax - bx;
  const dz = az - bz;
  let depth = Infinity;
  let nx = 0;
  let nz = 0;
  for (const [ux, uz] of axes) {
    // half extent of each rectangle along this axis
    const ra = ahl * Math.abs(axes[0][0] * ux + axes[0][1] * uz) + ahw * Math.abs(axes[1][0] * ux + axes[1][1] * uz);
    const rb = bhl * Math.abs(axes[2][0] * ux + axes[2][1] * uz) + bhw * Math.abs(axes[3][0] * ux + axes[3][1] * uz);
    const d = dx * ux + dz * uz;
    const over = ra + rb - Math.abs(d);
    if (over <= 0) return null;
    if (over < depth) {
      depth = over;
      const sign = d >= 0 ? 1 : -1;
      nx = ux * sign;
      nz = uz * sign;
    }
  }
  return { nx, nz, depth };
}
