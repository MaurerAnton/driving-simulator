// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Headlights and the main beam as the rules see them (§ 17 StVO).
 *
 * In the dark (and in thick fog) a vehicle drives with its lights on
 * (§ 17 Abs. 1, Abs. 3).  The main beam lights the road far ahead, and it
 * dazzles: it must be dipped in time when somebody comes towards one – a
 * car about 300 m off on the open road, earlier where the road runs
 * straight –, when one follows another vehicle closely (its driver sees the
 * beam in his mirrors), for cyclists and people on foot coming towards one,
 * and on streets that are lit throughout, as in a town, it is not used at
 * all (§ 17 Abs. 2).
 *
 * `BeamWatch` watches the player: what to tell him (a tip, before it is a
 * fault), the faults once he dazzles somebody, and – for the optional
 * main-beam assist – whether the main beam could be on now.
 * `TrafficBeams` gives the cars of the traffic their own main beam: on on
 * the empty country road at night, dipped when anybody comes into its reach
 * (a few drivers dip late), and flashed back twice at a player who dazzles
 * them.  It also says how much the player is dazzled by such a beam (`glare`).
 *
 * Nothing here draws: render/headlights.ts does, game/beamplay.ts feeds it.
 * Directions as everywhere in the game: yaw 0 faces north (−z), a positive
 * yaw turns left, forward is (−sin yaw, −cos yaw).
 */

/** Somebody on the road: a car, a cyclist, a person on foot. */
export interface BeamUser {
  id: number;
  x: number;
  z: number;
  yaw: number;
}

/** What the watch needs to know about the player and around him. */
export interface BeamScene {
  x: number;
  z: number;
  yaw: number;
  /** signed forward speed (m/s) */
  speed: number;
  /** the lights (dipped beam) are on */
  low: boolean;
  /** the main beam is lit (switched on, or the flasher held) */
  high: boolean;
  /** night: the main beam matters, and lights are required */
  dark: boolean;
  /** lights required although it is not night (thick fog, heavy snow) */
  poorSight?: boolean;
  /** the street is lit throughout (in a town, or marked as lit): no main beam here */
  lit: boolean;
  /** the cars of the traffic */
  cars: readonly BeamUser[];
  /** cyclists and people on foot */
  riders: readonly BeamUser[];
  /** can one see from (x0, z0) to (x1, z1) – no hill crest between?  (default: yes) */
  sees?: (x0: number, z0: number, x1: number, z1: number) => boolean;
}

export type BeamTip = 'beam.tipOncoming' | 'beam.tipAhead' | 'beam.tipRider' | 'beam.tipLit' | 'beam.tipLightsOn';
export type BeamFaultId = 'dazzleOncoming' | 'dazzleAhead' | 'dazzleRider' | 'beamLit' | 'noLights';

export interface BeamFault {
  id: BeamFaultId;
  severity: 'hint' | 'minor' | 'major';
  /** seconds before the same fault is counted again */
  cooldown: number;
}

/** Distances (m) and how long (s) a state may last before it is a fault. */
export const BEAM = {
  /** an oncoming vehicle this near (in the beam, in sight): dip now (the tip) */
  ONCOMING_TIP: 400,
  /** … this near with the main beam still on: it is dazzled */
  ONCOMING_FAULT: 200,
  /** … and flashes back */
  ONCOMING_FLASH: 250,
  /** following another vehicle this closely: dip (the tip) … */
  AHEAD_TIP: 150,
  /** … this closely for a while: its driver is dazzled by his mirrors */
  AHEAD_FAULT: 80,
  /** a cyclist or somebody on foot coming towards one */
  RIDER_TIP: 200,
  RIDER_FAULT: 100,
  /** reaction time allowed once dazzling begins */
  GRACE_ONCOMING: 0.8,
  GRACE_AHEAD: 3,
  GRACE_RIDER: 1,
  GRACE_LIT: 5,
  /** driving with the lights off in the dark this long */
  GRACE_DARK: 4,
  /** the assist puts the main beam on only above this speed (m/s): about 40 km/h */
  ASSIST_SPEED: 11,
} as const;

/** Where `o` is seen from (x, z, yaw): metres ahead, metres to the left, and how its way lies to ours (1 the same, −1 towards us). */
export function relate(x: number, z: number, yaw: number, o: { x: number; z: number; yaw: number }, out = { along: 0, side: 0, facing: 0 }): { along: number; side: number; facing: number } {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const dx = o.x - x;
  const dz = o.z - z;
  out.along = dx * fx + dz * fz;
  // (to the left: the forward turned a quarter to the left, (−cos yaw, sin yaw))
  out.side = dx * -Math.cos(yaw) + dz * Math.sin(yaw);
  out.facing = Math.cos(o.yaw - yaw);
  return out;
}

/** Is `r` (relate's answer) a vehicle coming towards one, inside the reach of a main beam `range` m long? */
export function inOncomingBeam(r: { along: number; side: number; facing: number }, range: number): boolean {
  return r.facing < -0.5 && r.along > 3 && r.along < range && Math.abs(r.side) < 4 + r.along * 0.2;
}

/** … a vehicle going the same way in front, `range` m at most? */
export function inBeamAhead(r: { along: number; side: number; facing: number }, range: number): boolean {
  return r.facing > 0.6 && r.along > 3 && r.along < range && Math.abs(r.side) < 2.5 + r.along * 0.06;
}

/** … a cyclist or somebody walking towards one? */
function riderInBeam(r: { along: number; side: number; facing: number }, range: number): boolean {
  return r.facing < -0.3 && r.along > 2 && r.along < range && Math.abs(r.side) < 3 + r.along * 0.15;
}

/** How dark it is for the lamps, 0 day … 1 night, by the sun's elevation (degrees). */
export function darkness(sunElevation: number): number {
  const t = Math.min(1, Math.max(0, (sunElevation - -4) / 10));
  return 1 - t * t * (3 - 2 * t);
}

/** Below this elevation of the sun (degrees) lights are required and the main beam counts. */
export const DARK_SUN = -2;
/** Below this the tip to switch the lights on is given (dusk). */
export const DUSK_SUN = 1;

/** The player's lights, watched by the rules of § 17 StVO. */
export class BeamWatch {
  /** what the driver should do now (a text key) – null: nothing */
  tip: BeamTip | null = null;
  /** the traffic car the main beam dazzles now (−1: none): it flashes back */
  dazzling = -1;
  /** the main-beam assist would have the main beam on now */
  assistHigh = false;
  /** the nearest vehicle coming towards one in the beam's reach (m; Infinity: none) */
  oncoming = Infinity;
  private tOncoming = 0;
  private tAhead = 0;
  private tRider = 0;
  private tLit = 0;
  private tDark = 0;
  private readonly r = { along: 0, side: 0, facing: 0 };

  reset(): void {
    this.tip = null;
    this.dazzling = -1;
    this.assistHigh = false;
    this.oncoming = Infinity;
    this.tOncoming = this.tAhead = this.tRider = this.tLit = this.tDark = 0;
  }

  /** One step of `dt` seconds: the faults found in it (none most of the time). */
  update(dt: number, s: BeamScene): BeamFault[] {
    const out: BeamFault[] = [];
    this.tip = null;
    this.dazzling = -1;
    const moving = Math.abs(s.speed) > 2;

    // --- lights at all: in the dark, and in thick fog, by day too (§ 17 Abs. 1, Abs. 3) ---
    const need = s.dark || !!s.poorSight;
    if (need && !s.low && moving) {
      this.tDark += dt;
      this.tip = 'beam.tipLightsOn';
      if (this.tDark > BEAM.GRACE_DARK) out.push({ id: 'noLights', severity: 'major', cooldown: 60 });
    } else this.tDark = 0;

    // --- who is in the main beam's reach ---
    let oncoming = Infinity;
    let oncomingId = -1;
    let ahead = Infinity;
    let rider = Infinity;
    if (s.dark) {
      const r = this.r;
      for (const c of s.cars) {
        relate(s.x, s.z, s.yaw, c, r);
        if (inOncomingBeam(r, BEAM.ONCOMING_TIP)) {
          if (r.along < oncoming && (!s.sees || s.sees(s.x, s.z, c.x, c.z))) {
            oncoming = r.along;
            oncomingId = c.id;
          }
        } else if (inBeamAhead(r, BEAM.AHEAD_TIP) && r.along < ahead) ahead = r.along;
      }
      for (const p of s.riders) {
        relate(s.x, s.z, s.yaw, p, r);
        if (riderInBeam(r, BEAM.RIDER_TIP) && r.along < rider) rider = r.along;
      }
    }
    this.oncoming = oncoming;
    this.assistHigh = s.dark && s.low && !s.lit && s.speed > BEAM.ASSIST_SPEED && oncoming === Infinity && ahead === Infinity && rider === Infinity;

    if (!s.high || !s.dark) {
      this.tOncoming = this.tAhead = this.tRider = this.tLit = 0;
      return out;
    }
    // --- the main beam on: dip it in time (§ 17 Abs. 2) ---
    if (oncoming < BEAM.ONCOMING_FLASH) this.dazzling = oncomingId;
    this.tOncoming = oncoming < BEAM.ONCOMING_FAULT ? this.tOncoming + dt : 0;
    this.tAhead = ahead < BEAM.AHEAD_FAULT ? this.tAhead + dt : 0;
    this.tRider = rider < BEAM.RIDER_FAULT ? this.tRider + dt : 0;
    this.tLit = s.lit && moving ? this.tLit + dt : 0;
    if (this.tOncoming > BEAM.GRACE_ONCOMING) out.push({ id: 'dazzleOncoming', severity: 'minor', cooldown: 20 });
    if (this.tAhead > BEAM.GRACE_AHEAD) out.push({ id: 'dazzleAhead', severity: 'minor', cooldown: 20 });
    if (this.tRider > BEAM.GRACE_RIDER) out.push({ id: 'dazzleRider', severity: 'minor', cooldown: 20 });
    if (this.tLit > BEAM.GRACE_LIT) out.push({ id: 'beamLit', severity: 'hint', cooldown: 60 });
    // (the tip: the most urgent first)
    if (oncoming < BEAM.ONCOMING_TIP) this.tip = 'beam.tipOncoming';
    else if (rider < BEAM.RIDER_TIP) this.tip = 'beam.tipRider';
    else if (ahead < BEAM.AHEAD_TIP) this.tip = 'beam.tipAhead';
    else if (s.lit) this.tip = 'beam.tipLit';
    return out;
  }
}

/** A car of the traffic, as its own lights see it. */
export interface TrafficBeamCar extends BeamUser {
  /** speed (m/s) */
  v: number;
  /** on a road outside towns, not lit: the main beam may be used */
  rural: boolean;
}

interface CarBeam {
  high: boolean;
  /** since when nothing has been in its reach (s of the clock) */
  clearSince: number;
  /** when its last flash began (−∞: never) */
  flash: number;
  /** how long the player has been dazzling it */
  dazzled: number;
  seen: number;
}

/** the flasher's rhythm: two flashes of 0.3 s, a quarter of a second apart */
function flashLit(t: number): boolean {
  return (t >= 0 && t < 0.3) || (t >= 0.55 && t < 0.85);
}

/** The main beam of the cars of the traffic (see the top of the file). */
export class TrafficBeams {
  /** how much the player is dazzled by a main beam coming towards him, 0 … 1 */
  glare = 0;
  private readonly m = new Map<number, CarBeam>();
  private time = 0;
  private nextTick = 0;
  private stamp = 0;
  private readonly r = { along: 0, side: 0, facing: 0 };

  reset(): void {
    this.m.clear();
    this.glare = 0;
  }

  /** Is the main beam of car `id` lit now (on, or flashing)? */
  high(id: number): boolean {
    const b = this.m.get(id);
    return !!b && (b.high || flashLit(this.time - b.flash));
  }

  /** Is car `id` flashing its main beam now? */
  flashing(id: number): boolean {
    const b = this.m.get(id);
    return !!b && this.time - b.flash < 0.85;
  }

  /** How far a car dips its beam for somebody coming towards it (m): most in good time, every eighth late. */
  static dipDistance(id: number): number {
    return id % 8 === 3 ? 170 : 340 + (id % 5) * 20;
  }

  /**
   * One step: the cars near the player (`cars`), the player (null: none on the
   * road), the car the player dazzles (BeamWatch.dazzling), is it night.
   */
  update(dt: number, cars: readonly TrafficBeamCar[], player: (BeamUser & { high: boolean }) | null, dazzling: number, dark: boolean, sees?: (x0: number, z0: number, x1: number, z1: number) => boolean): void {
    this.time += dt;
    if (!dark) {
      if (this.m.size) this.m.clear();
      this.glare = 0;
      return;
    }
    const t = this.time;
    // the player dazzles somebody: after a second that one flashes back (once in a while)
    for (const [id, b] of this.m) {
      if (id !== dazzling) b.dazzled = 0;
      else {
        b.dazzled += dt;
        if (b.dazzled > 1 && t - b.flash > 12) b.flash = t;
      }
    }
    if (t >= this.nextTick) {
      this.nextTick = t + 0.2;
      const st = ++this.stamp;
      const r = this.r;
      for (const c of cars) {
        let b = this.m.get(c.id);
        if (!b) {
          b = { high: false, clearSince: t, flash: -Infinity, dazzled: 0, seen: st };
          this.m.set(c.id, b);
          if (c.id === dazzling) b.dazzled = dt;
        }
        b.seen = st;
        if (!c.rural || c.v < 8) {
          b.high = false;
          b.clearSince = t;
          continue;
        }
        const dip = TrafficBeams.dipDistance(c.id);
        let blocked = false;
        for (const o of cars) {
          if (o === c) continue;
          relate(c.x, c.z, c.yaw, o, r);
          if (inOncomingBeam(r, dip) || inBeamAhead(r, 150)) {
            blocked = true;
            break;
          }
        }
        if (!blocked && player) {
          relate(c.x, c.z, c.yaw, player, r);
          blocked = (inOncomingBeam(r, dip) && (!sees || sees(c.x, c.z, player.x, player.z))) || inBeamAhead(r, 150);
        }
        if (blocked) {
          b.high = false;
          b.clearSince = t;
        } else if (t - b.clearSince > 2) b.high = true;
      }
      for (const [id, b] of this.m) if (b.seen !== st) this.m.delete(id);
    }
    // the player dazzled by a beam coming towards him
    let g = 0;
    if (player) {
      const r = this.r;
      for (const c of cars) {
        if (!this.high(c.id)) continue;
        relate(player.x, player.z, player.yaw, c, r);
        if (r.facing > -0.7 || r.along < 5 || r.along > 300 || Math.abs(r.side) > 4 + r.along * 0.15) continue;
        const k = (1 - r.along / 300) * (this.flashing(c.id) ? 1 : 0.8);
        if (k > g && (!sees || sees(player.x, player.z, c.x, c.z))) g = k;
      }
    }
    this.glare = g;
  }
}
