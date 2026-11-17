// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Headlights in the game: what ties sim/beams.ts (the rules of § 17 StVO,
 * the traffic's own main beam) to render/headlights.ts (the light on the
 * road, the lamps of the traffic) and to the game – once a frame, from one
 * short hook in game.ts.
 *
 * The dark comes from the sun (game.ts updateSun gives its elevation): by
 * day nothing here costs anything.  The main beam is lit when it is switched
 * on (with the dipped beam), by the assist when the settings ask for it, and
 * while the flasher is held (it works with the lights off, too).
 */
import * as THREE from 'three';
import { BeamWatch, DARK_SUN, DUSK_SUN, TrafficBeams, darkness } from '../sim/beams.ts';
import type { BeamFault, BeamTip, BeamUser, TrafficBeamCar } from '../sim/beams.ts';
import { PlayerLights, TrafficGlow } from '../render/headlights.ts';
import type { GlowCar } from '../render/headlights.ts';
import { EF } from '../world/types.ts';
import type { Edge } from '../world/world.ts';

/** a car of the traffic as it comes from sim/traffic.ts (only what is needed here) */
interface Car extends GlowCar {
  v: number;
  lane: { edge: Edge } | null;
}

export interface BeamFrame {
  dt: number;
  /** the player's vehicle is on the road and driven (not on foot, not flying, not the tram, not a replay) */
  driving: boolean;
  /** its faults count (driving, not a demonstration drive, not a passenger) */
  judged: boolean;
  /** the model to throw the light from (null: none – lights off) */
  root: THREE.Object3D | null;
  front: number;
  height: number;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  low: boolean;
  /** the main beam lit (see `high`) */
  high: boolean;
  /** the street is lit throughout (in a town, or a lit road) */
  lit: boolean;
  /** how far one sees in the weather (m) */
  visibility: number;
  cheap: boolean;
  cars: readonly Car[];
  riders: readonly BeamUser[];
  /** the scene the light and the lamps go into (on the first frame) */
  scene: THREE.Object3D;
  camera: THREE.PerspectiveCamera;
  heightPx: number;
  heightAt: (x: number, z: number) => number;
}

export class BeamPlay {
  /** the sun's elevation (degrees), set by the game where it places the sun */
  sunElevation = 52;
  readonly watch = new BeamWatch();
  readonly traffic = new TrafficBeams();
  private lights: PlayerLights | null = null;
  readonly glow = new TrafficGlow();
  private readonly near: TrafficBeamCar[] = [];
  private readonly player = { id: -1, x: 0, z: 0, yaw: 0, high: false };
  /** the tip given last, and when (s): the same one is not said again for a while */
  private lastTip: BeamTip | null = null;
  private lastTipAt = -1e9;
  private clock = 0;

  /** how dark it is for the lamps, 0 … 1 */
  get dark(): number {
    return darkness(this.sunElevation);
  }

  /** The main beam lit: switched on with the dipped beam (or put on by the assist), or the flasher held. */
  high(low: boolean, high: boolean, flasher: boolean, assist: boolean): boolean {
    return flasher || (low && (assist ? this.watch.assistHigh : high));
  }

  /** Can one see from one place to the other over the hills (a few points of the ground on the line between, eyes 1.2 m up)? */
  private sees(heightAt: (x: number, z: number) => number, x0: number, z0: number, x1: number, z1: number): boolean {
    const y0 = heightAt(x0, z0) + 1.2;
    const y1 = heightAt(x1, z1) + 1.2;
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      if (heightAt(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t) > y0 + (y1 - y0) * t + 0.4) return false;
    }
    return true;
  }

  /**
   * One frame: the light, the lamps of the traffic, and what the rules say –
   * a tip to show (only when it is new, or again after half a minute) and the
   * faults found.
   */
  frame(f: BeamFrame): { tip: BeamTip | null; faults: BeamFault[] } {
    this.clock += f.dt;
    if (!this.lights) {
      this.lights = new PlayerLights(f.scene);
      f.scene.add(this.glow.points);
    }
    const dark = this.dark;
    const night = this.sunElevation < DARK_SUN;
    const sees = (x0: number, z0: number, x1: number, z1: number): boolean => this.sees(f.heightAt, x0, z0, x1, z1);
    this.lights.update({ dark, root: f.driving ? f.root : null, front: f.front, height: f.height, low: f.low, high: f.high, cheap: f.cheap });
    // the traffic near by: its main beam, flashing back
    const near = this.near;
    near.length = 0;
    if (dark > 0) {
      for (const c of f.cars) {
        if (Math.abs(c.x - f.x) > 900 || Math.abs(c.z - f.z) > 900) continue;
        const e = c.lane?.edge;
        // (across a junction: dipped)
        const rural = !!e && (e.flags & (EF.URBAN | EF.LIT)) === 0;
        near.push({ id: c.id, x: c.x, z: c.z, yaw: c.yaw, v: c.v, rural });
      }
    }
    let tip: BeamTip | null = null;
    let faults: BeamFault[] = [];
    if (f.driving) {
      faults = this.watch.update(f.dt, { x: f.x, z: f.z, yaw: f.yaw, speed: f.speed, low: f.low, high: f.high, dark: night, poorSight: f.visibility < 150, lit: f.lit, cars: night ? near : [], riders: night ? f.riders : [], sees });
      tip = this.watch.tip;
      // (at dusk, before it counts: the lights on)
      if (!tip && !f.low && this.sunElevation < DUSK_SUN && Math.abs(f.speed) > 2) tip = 'beam.tipLightsOn';
      if (!f.judged) faults = [];
    } else this.watch.reset();
    const p = this.player;
    p.x = f.x;
    p.z = f.z;
    p.yaw = f.yaw;
    p.high = f.high;
    this.traffic.update(f.dt, near, f.driving ? p : null, f.driving ? this.watch.dazzling : -1, night, sees);
    this.glow.update(f.cars, dark, f.camera, f.heightPx, (id) => this.traffic.high(id), this.traffic.glare);
    if (tip && (tip !== this.lastTip || this.clock - this.lastTipAt > 30)) {
      this.lastTip = tip;
      this.lastTipAt = this.clock;
    } else {
      if (!tip && this.clock - this.lastTipAt > 8) this.lastTip = null;
      tip = null;
    }
    return { tip, faults };
  }
}
