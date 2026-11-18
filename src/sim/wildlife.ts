// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Deer and wild boar on the country roads at dusk and at night.
 *
 * Now and then – rarely – where a country road runs along or through a
 * forest, animals come out of the trees ahead of the player and cross: a
 * roe deer, often a second and a third one after it (where one crossed,
 * more follow – as the theory lesson says), or a wild boar with her young.
 * They step out to the edge of the forest, stand a moment, and run across
 * into the field or the forest on the other side.  Only when it is getting
 * dark or dark (the sun a few degrees above the horizon or lower), only
 * outside towns, never on a motorway, in a tunnel or on a bridge, and only
 * where the ground beside the road is forest (the terrain's cover).
 *
 * While they are on or beside the road they are obstacles for the traffic
 * (sim/traffic.ts `wild`): the cars brake for them as for anything in their
 * lane.  render/wildlife.ts draws them (the models of render/animals.ts).
 *
 * All of this is plain arithmetic over a small host interface – the sun,
 * the cover and height of the ground, the road near a point – so that it
 * runs in the tests without a map; `worldRoads` gives the host its roads
 * from the game's world.
 */
import { clamp, newPolySample, samplePolyline } from '../core/geom.ts';
import { COVER } from '../world/cover.ts';
import { CLS, EF } from '../world/types.ts';
import { newSurfaceHit } from '../world/world.ts';
import type { World } from '../world/world.ts';
import type { PlayerState } from './traffic.ts';

/** The road near a point: its middle line there, the way it runs (a unit vector), half its width; whether it is a country road animals may cross. */
export interface WildRoad {
  x: number;
  z: number;
  dx: number;
  dz: number;
  half: number;
  rural: boolean;
}

export interface WildHost {
  /** the sun's elevation (degrees) */
  sun(): number;
  /** the ground's cover class (world/cover.ts) at a point */
  coverAt(x: number, z: number): number;
  /** the ground's height at a point (NaN: not known) */
  heightAt(x: number, z: number): number;
  /** the road nearest the point within `reach` metres (false: none) */
  road(x: number, z: number, reach: number, out: WildRoad): boolean;
}

export type WildKind = 'deer' | 'boar' | 'piglet';

/** One animal: where it is, which way it faces, how fast it goes, how far it ran (for the legs). */
export interface WildAnimal {
  kind: WildKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  dist: number;
  /** out of the forest to the edge; standing there; across the road; away into the far side */
  phase: 'out' | 'wait' | 'cross' | 'away';
  /** seconds until it sets off (the ones following wait longer) */
  delay: number;
  /** how long it stands at the edge */
  pause: number;
  /** its way: from the forest (a), the edge of the road (e), the far side (b) */
  ax: number;
  az: number;
  ex: number;
  ez: number;
  bx: number;
  bz: number;
  run: number;
}

/** how often to look for a place ahead (s), how far ahead (s of driving, m at least and at most) */
const CHECK = 2.5;
const AHEAD_S = 6;
const AHEAD_MIN = 70;
const AHEAD_MAX = 140;
/** the chance at each look where a forest meets the road at night – twice that at dusk */
const CHANCE = 0.05;
/** above this sun (degrees) it is day: no animals */
const DAY_SUN = 4;
/** at dusk: the sun between these */
const DUSK = [-7, 4];
/** after a group has gone: a while without (s) */
const COOLDOWN = 100;
/** gone when this far from the player (m) */
const GONE = 320;

/** The measures of an animal for the traffic: length, width. */
const SIZE: Record<WildKind, [number, number]> = { deer: [1.5, 0.5], boar: [1.3, 0.6], piglet: [0.7, 0.35] };

export class Wildlife {
  readonly animals: WildAnimal[] = [];
  /** the animals as obstacles for the traffic (those near the road) */
  readonly boxes: PlayerState[] = [];
  /** off: no animals (and those there go) */
  enabled = true;
  /** the chance at each look where a forest meets the road at night (twice that at dusk; 1: every time – to try it out) */
  chance = CHANCE;
  private readonly host: WildHost;
  private readonly rnd: () => number;
  private timer = CHECK;
  private cooldown = 0;
  private readonly road: WildRoad = { x: 0, z: 0, dx: 0, dz: -1, half: 3, rural: false };
  private readonly pool: PlayerState[] = [];

  constructor(host: WildHost, rnd: () => number = Math.random) {
    this.host = host;
    this.rnd = rnd;
  }

  clear(): void {
    this.animals.length = 0;
    this.boxes.length = 0;
  }

  /** On by dt seconds; `player`: where the player's vehicle is and how fast it goes. */
  update(dt: number, player: Readonly<{ x: number; z: number; yaw: number; speed: number }>): void {
    if (!this.enabled) {
      this.clear();
      return;
    }
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = CHECK;
      if (this.animals.length === 0 && this.cooldown <= 0) this.look(player);
    }
    this.step(dt, player);
    this.makeBoxes();
  }

  /** Is there a forest at the road ahead – and do animals come out of it now? */
  private look(player: Readonly<{ x: number; z: number; yaw: number; speed: number }>): void {
    const sun = this.host.sun();
    if (sun > DAY_SUN || player.speed < 7) return;
    const d = clamp(player.speed * AHEAD_S, AHEAD_MIN, AHEAD_MAX);
    const px = player.x - Math.sin(player.yaw) * d;
    const pz = player.z - Math.cos(player.yaw) * d;
    const r = this.road;
    if (!this.host.road(px, pz, 15, r) || !r.rural) return;
    // (the road ahead runs about the way the player goes – not a road crossing it)
    const fx = -Math.sin(player.yaw);
    const fz = -Math.cos(player.yaw);
    if (Math.abs(r.dx * fx + r.dz * fz) < 0.6) return;
    // the forest: on one side, near the road and further in
    const nx = -r.dz;
    const nz = r.dx;
    const sides: number[] = [];
    for (const side of [1, -1]) {
      let forest = true;
      for (const off of [6, 14]) if (this.host.coverAt(r.x + nx * side * (r.half + off), r.z + nz * side * (r.half + off)) !== COVER.FOREST) forest = false;
      if (forest) sides.push(side);
    }
    if (sides.length === 0) return;
    const dusk = sun >= DUSK[0] && sun <= DUSK[1];
    if (this.rnd() >= this.chance * (dusk ? 2 : 1)) return;
    const side = sides[Math.floor(this.rnd() * sides.length)];
    this.spawn(r, side);
  }

  /** A group comes out of the forest on `side` of the road (+1 its left). */
  private spawn(r: WildRoad, side: number): void {
    const deer = this.rnd() < 0.7;
    const kinds: WildKind[] = deer ? ['deer'] : ['boar'];
    if (deer) {
      if (this.rnd() < 0.55) kinds.push('deer');
      if (this.rnd() < 0.25) kinds.push('deer');
    } else {
      const young = Math.floor(this.rnd() * 4);
      for (let i = 0; i < young; i++) kinds.push('piglet');
    }
    const nx = -r.dz * side;
    const nz = r.dx * side;
    kinds.forEach((kind, i) => {
      // (one behind the other along the road, a little apart; the young close to the sow)
      const along = (deer ? 2.2 : 1.1) * i * (i % 2 ? 1 : -1) * 0.6;
      const ox = r.x + r.dx * along;
      const oz = r.z + r.dz * along;
      const a: WildAnimal = {
        kind,
        x: ox + nx * (r.half + 12),
        y: NaN,
        z: oz + nz * (r.half + 12),
        yaw: 0,
        speed: 0,
        dist: 0,
        phase: 'out',
        delay: deer ? i * (1.3 + this.rnd() * 0.8) : i * 0.25,
        pause: deer ? 0.5 + this.rnd() * 1.4 : 0.2 + this.rnd() * 0.4,
        ax: ox + nx * (r.half + 12),
        az: oz + nz * (r.half + 12),
        ex: ox + nx * (r.half + 1.5),
        ez: oz + nz * (r.half + 1.5),
        bx: ox - nx * (r.half + 24),
        bz: oz - nz * (r.half + 24),
        run: kind === 'deer' ? 7.5 + this.rnd() * 2 : kind === 'boar' ? 4.6 : 4.2,
      };
      a.yaw = Math.atan2(-(a.ex - a.ax), -(a.ez - a.az));
      a.y = this.host.heightAt(a.x, a.z);
      this.animals.push(a);
    });
  }

  private step(dt: number, player: Readonly<{ x: number; z: number }>): void {
    let done = this.animals.length > 0;
    let far = false;
    for (const a of this.animals) {
      if (Math.hypot(a.x - player.x, a.z - player.z) > GONE) far = true;
      if (a.delay > 0) {
        a.delay -= dt;
        done = false;
        continue;
      }
      let tx: number;
      let tz: number;
      let v: number;
      if (a.phase === 'out') {
        tx = a.ex;
        tz = a.ez;
        v = a.kind === 'deer' ? 2.2 : 1.6;
      } else if (a.phase === 'wait') {
        a.pause -= dt;
        a.speed = 0;
        if (a.pause <= 0) a.phase = 'cross';
        done = false;
        continue;
      } else {
        tx = a.bx;
        tz = a.bz;
        v = a.phase === 'away' ? a.run * 0.6 : a.run;
      }
      // (speeding up and slowing down like an animal: quickly)
      a.speed += clamp(v - a.speed, -8 * dt, 6 * dt);
      const dx = tx - a.x;
      const dz = tz - a.z;
      const d = Math.hypot(dx, dz);
      const go = Math.min(d, a.speed * dt);
      if (d > 1e-6) {
        a.x += (dx / d) * go;
        a.z += (dz / d) * go;
        a.yaw = Math.atan2(-dx, -dz);
      }
      a.dist += go;
      const y = this.host.heightAt(a.x, a.z);
      if (!Number.isNaN(y)) a.y = y;
      if (d - go < 0.3) {
        if (a.phase === 'out') {
          a.phase = 'wait';
          a.speed = 0;
        } else if (a.phase === 'cross') {
          // over: on, slower, a good way into the far side – then it is gone
          a.phase = 'away';
          const ux = a.bx - a.ex;
          const uz = a.bz - a.ez;
          const l = Math.hypot(ux, uz) || 1;
          a.bx += (ux / l) * 30;
          a.bz += (uz / l) * 30;
        } else continue;
      }
      done = false;
    }
    if (done || far) {
      if (this.animals.length > 0) this.cooldown = COOLDOWN;
      this.animals.length = 0;
    }
  }

  /** The animals on the road or at its edge, as obstacles. */
  private makeBoxes(): void {
    this.boxes.length = 0;
    let n = 0;
    for (const a of this.animals) {
      if (a.delay > 0 || a.phase === 'out' || a.phase === 'away') continue;
      const [len, wide] = SIZE[a.kind];
      const b = (this.pool[n++] ??= { x: 0, y: 0, z: 0, yaw: 0, speed: 0, length: len, width: wide });
      b.x = a.x;
      b.y = Number.isNaN(a.y) ? 0 : a.y;
      b.z = a.z;
      b.yaw = a.yaw;
      b.speed = a.speed;
      b.length = len;
      b.width = wide;
      this.boxes.push(b);
    }
  }
}

/** The host's roads from the game's world: the nearest road to a point, and whether it is a country road animals cross. */
export function worldRoads(world: World): WildHost['road'] {
  const hit = newSurfaceHit();
  const ps = newPolySample();
  return (x, z, reach, out) => {
    if (!world.nearestRoad(x, z, reach, 0, hit) || !hit.edge) return false;
    const e = hit.edge;
    samplePolyline(e.pl, hit.s, ps);
    out.x = ps.x;
    out.z = ps.z;
    out.dx = ps.tx;
    out.dz = ps.tz;
    out.half = e.width / 2;
    const motorway = e.cls === CLS.MOTORWAY || e.cls === CLS.MOTORWAY_LINK || (e.flags & EF.DUAL) !== 0;
    out.rural = !motorway && (e.flags & (EF.URBAN | EF.TUNNEL | EF.BRIDGE)) === 0;
    return true;
  };
}
