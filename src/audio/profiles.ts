// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What each kind of vehicle sounds like, and how its sound follows what the
 * game tells it every frame – pure numbers, so that they can be tested
 * without a browser (audio.ts plays them).
 *
 * Every vehicle is made of the same voices, each set up for it:
 *
 *  - the main voice: the engine – its firing pulses at the crank angles of
 *    its layout (waves.ts), one wave for idle and overrun and a harder one
 *    for full load, blended with the load, through a low-pass that opens
 *    with revs and load and a resonance of its exhaust or body; for the
 *    aeroplane the propeller's blade passing as well, for the tram its
 *    traction motors and gears, whose whine rises with the speed;
 *  - combustion noise: a diesel's clatter, a petrol engine's intake roar,
 *    a two-stroke's rasp – noise that comes in pulses with the firings; the
 *    tram's fans, the propeller's swish;
 *  - the turbocharger's whistle, gear and chain whines, the tram's inverter;
 *  - the rolling of the tyres (the tram's wheels on the rails), the wind,
 *    a skidding tyre (the tram's flanges squealing in a tight curve);
 *  - the horn (the tram's bell), the starter, the indicator relay; air
 *    brakes and a reversing alarm on trucks and buses, the aeroplane's stall
 *    warning.
 *
 * All levels are given in dB(A) against one reference – the car's engine at
 * half load and middle revs – and turned into gains by measuring each
 * voice's loudness (A-weighted, after its filters) once per vehicle: so the
 * vehicles stay balanced against each other whatever their waves are like.
 */
import type { VehicleKind } from '../game/vehicles.ts';
import type { Partials, WaveSpec } from './waves.ts';
import { bandpassGain, lowpassGain, noiseLoudness, oscLoudness, peakingGain, rmsOf, wavePartials, waveLoudness } from './waves.ts';

/**
 * What the game tells the sound once a frame. The first fields are those of
 * every vehicle; the optional ones make the sound of particular vehicles –
 * left out, they change nothing.
 */
export interface AudioState {
  /** engine speed (rpm) as the game's engine has it (the tachometer's); the aeroplane: its own rpm, engine and propeller; not used for the tram */
  rpm: number;
  /** 0 … 1: the throttle (engine load); the aeroplane: the throttle lever; the tram: how hard its motors pull (the controller forward) */
  load: number;
  /** the engine runs; the tram: its motors have power (pantograph up at the wire, or a regional tram's engine) */
  engineRunning: boolean;
  /** the starter turns the engine */
  starter: boolean;
  /** m/s; the aeroplane: its airspeed */
  speed: number;
  /** 0 … 1 tyre squeal */
  skid: number;
  indicatorOn: boolean;
  blinkOn: boolean;
  /** the horn; the tram: its bell, which rings for as long as this is held; nothing for the aeroplane or on foot */
  horn: boolean;
  /** surface roughness for road noise (1 asphalt … 3 gravel) – also what footsteps sound like */
  rough: number;
  /** 0 … 1 the service brake (the pedal); the tram: the controller backwards (its motors brake – and whine as they do), 1 for the emergency brake. Air brakes let out a puff when it is let go. */
  braking?: number;
  /** the parking brake is on: a truck or a bus lets the air out of its spring brakes as it is set – "pssht" */
  parkingBrake?: boolean;
  /** in reverse gear: trucks and buses beep */
  reversing?: boolean;
  /** how sharply the way curves under the vehicle: 1 / radius (1/m, either side) – the tram's wheels squeal in tight curves */
  curve?: number;
  /** the aeroplane is off the ground: its wheels no longer rumble */
  airborne?: boolean;
  /** the aeroplane's stall warning: its horn sounds */
  stallWarning?: boolean;
}

/** The kinds of vehicle sound – one per kind of vehicle of the game (soundKindOf). */
export type SoundKind =
  | 'car'
  | 'moped'
  | 'motorcycle125'
  | 'motorcycle35'
  | 'motorcycle'
  | 'minibus'
  | 'lightTruck'
  | 'truck'
  | 'semi'
  | 'bus'
  | 'tractorSlow'
  | 'tractor'
  | 'tram'
  | 'plane'
  | 'onFoot';

export const SOUND_KINDS: readonly SoundKind[] = ['car', 'moped', 'motorcycle125', 'motorcycle35', 'motorcycle', 'minibus', 'lightTruck', 'truck', 'semi', 'bus', 'tractorSlow', 'tractor', 'tram', 'plane', 'onFoot'];

/** Each vehicle of the game and the sound it has (with a trailer the same as without). */
const OF_VEHICLE: Record<VehicleKind, SoundKind> = {
  car: 'car',
  carTrailer: 'car',
  moped: 'moped',
  motorcycle125: 'motorcycle125',
  motorcycle35: 'motorcycle35',
  motorcycle: 'motorcycle',
  lightTruck: 'lightTruck',
  lightTruckTrailer: 'lightTruck',
  truckSolo: 'semi',
  truck: 'truck',
  semi: 'semi',
  minibus: 'minibus',
  minibusTrailer: 'minibus',
  bus: 'bus',
  busTrailer: 'bus',
  tractorSlow: 'tractorSlow',
  tractor: 'tractor',
  tram: 'tram',
  plane: 'plane',
  // (the cranes: the mobile and the loader crane's diesels; the tower crane's drives are electric)
  mobileCrane: 'truck',
  loaderCrane: 'truck',
  towerCrane: 'tram',
  // (the forklift: a small diesel)
  forklift: 'tractorSlow',
  pedestrian: 'onFoot',
};

/** The sound of a vehicle of the game. */
export function soundKindOf(kind: VehicleKind): SoundKind {
  return OF_VEHICLE[kind] ?? 'car';
}

interface VoiceBase {
  /** the two waves the voice blends: soft (idle, overrun – coasting for the motor, the propeller for the aeroplane) and hard (full load, pulling – the aeroplane's exhaust) */
  soft: WaveSpec;
  hard: WaveSpec;
  /** how many partials of a pulse wave are worked out (enough to reach a few kHz at idle) */
  partials: number;
  /** loudness at the reference – half load at 45 % of the revs; the motor: 10 m/s at half effort – in dB(A) against the car's */
  db: number;
  /** low-pass (Hz): at idle, at the highest revs (the motor: per m/s), and what full load adds; and its resonance (dB) */
  lp: readonly [number, number, number];
  lpQ: number;
  /** a resonance of the exhaust, the intake or the body: centre (Hz), Q, gain (dB) */
  body: readonly [number, number, number];
  /** unsteadiness at idle (less under load): of the speed (cents) and of the strength (share) */
  jitter: readonly [number, number];
}

/** A piston engine (and the aeroplane's, with its propeller). */
export interface EngineVoice extends VoiceBase {
  kind: 'engine' | 'prop';
  /** crank turns per wave period: 2 for a four-stroke's cycle – and for the two-stroke moped, whose firings differ at idle */
  turns: number;
  /** its own idle and highest engine speeds (rpm) – the game's engine speeds are mapped onto them (setVehicle) */
  idleRpm: number;
  maxRpm: number;
  /** its level made up of a part at idle, one with the load and one with the revs */
  idle: number;
  load: number;
  revs: number;
  /** how quickly the hard wave takes over with the load (exponent: lower is sooner) */
  harden: number;
  /** the aeroplane: the propeller's loudness (the soft wave) against the exhaust's at the highest rpm */
  prop: number;
}

/** The tram's traction: motors and gears whose orders rise with the speed. */
export interface MotorVoice extends VoiceBase {
  kind: 'motor';
  /** the motors' turning (Hz) per m/s: gear ratio over the wheels' circumference */
  perMps: number;
  /** level of the gears while coasting, and of the motors with full effort (pulling or braking) */
  coast: number;
  effort: number;
}

/** Noise of the engine: clatter, intake roar, rasp – or of fans and a propeller. */
export interface NoiseVoice {
  /** band-pass centre at idle and at the highest revs (Hz), and its Q */
  f: readonly [number, number];
  q: number;
  /** loudness at the reference against the main voice (dB) */
  db: number;
  /** the share of it that comes in pulses with the firings (0: steady, as fans) */
  am: number;
  /** what it is made up of: a part always there, one with the load, one with the revs (negative: less at high revs, as a diesel's clatter) */
  base: number;
  load: number;
  revs: number;
  /** only while the engine fires – else while it turns (a windmilling propeller), or for the tram while it has power */
  firing: boolean;
}

export interface TurboVoice {
  /** its whistle (Hz) from spooling up to full boost, its loudness at full boost (dB), and how long it takes to spool up (s) */
  f: readonly [number, number];
  db: number;
  spool: number;
}

/** A whine: of gears, a chain, a pump, the tram's inverter. */
export interface ToneVoice {
  wave: 'sine' | 'triangle' | 'square' | 'sawtooth';
  /** what its pitch follows: the speed (hz per m/s), the revs (hz per rpm) or nothing (hz) */
  by: 'speed' | 'rpm' | 'fixed';
  hz: number;
  /** its loudness at full effort, once faded in, at 15 m/s or middle revs (dB) */
  db: number;
  /** the share of it that comes with effort – pulling or braking (0: steady) */
  effort: number;
  /** speeds (m/s) over which it comes in, and – if given – over which it goes again */
  fade: readonly [number, number];
  out?: readonly [number, number];
}

export interface SoundProfile {
  main: EngineVoice | MotorVoice | null;
  /** a road vehicle: the engine speeds of the game's engine are mapped onto the profile's (not the aeroplane, whose rpm are its own) */
  mapRpm: boolean;
  noise: NoiseVoice | null;
  turbo: TurboVoice | null;
  tones: readonly ToneVoice[];
  /** rolling: loudness at 30 m/s on asphalt (dB), low-pass (Hz: at a standstill, per m/s) and its resonance (dB) */
  road: { db: number; lp: readonly [number, number]; q: number } | null;
  /** wind: loudness at 30 m/s (dB), band-pass centre (Hz: at a standstill, per m/s) and its Q */
  wind: { db: number; bp: readonly [number, number]; q: number } | null;
  /** a skidding tyre: band-pass centre (Hz), Q, loudness at a full skid (dB) */
  skid: { f: number; q: number; db: number } | null;
  /** the tram's flanges in a tight curve: a narrow squeal (Hz, Q), its loudness (dB) and how far it wanders (cents) */
  squeal: { f: number; q: number; db: number; wobble: number } | null;
  horn: { f: readonly [number, number]; wave: 'sawtooth' | 'square'; lp: number; db: number } | null;
  /** a tram's bell instead of a horn */
  bell: boolean;
  /** the starter: its whirr (Hz), the compression pulses it labours through (Hz) and how far they pull its pitch (Hz), its loudness (dB) */
  starter: { f: number; lfo: number; depth: number; db: number } | null;
  /** the indicator relay: tick and tock (Hz) and how loud (as a gain) */
  relay: { tick: number; tock: number; level: number } | null;
  /** air brakes: a puff when the brake is let go, "pssht" as the parking brake is set, the air dryer now and then */
  air: boolean;
  /** a reversing alarm */
  beeper: boolean;
  /** the aeroplane's stall warning horn (a reed): pitch (Hz) and loudness (dB) */
  stallHorn: { f: number; db: number } | null;
}

/**
 * The scale of everything: the A-weighted RMS of the car's engine at its reference (half load, 45 % of its revs) –
 * a little above what the single engine sound before was, so that a volume set then still suits.
 */
export const REF_LOUDNESS = 0.03;
/** the speed road and wind levels are given at (m/s) */
const AT_SPEED = 30;
/** a cranked engine (turning, not firing) against its idle */
const CRANK = 0.35;

const I4 = [0, 180, 360, 540];
const I6 = [0, 120, 240, 360, 480, 600];

/** what the motorcycles have in common but their engines */
const BIKE = {
  mapRpm: true,
  turbo: null,
  road: { db: -10, lp: [380, 30], q: 0.5 },
  wind: { db: 0, bp: [480, 18], q: 0.5 },
  skid: { f: 1350, q: 6, db: -5 },
  squeal: null,
  bell: false,
  relay: { tick: 3300, tock: 2900, level: 0.16 },
  air: false,
  beeper: false,
  stallHorn: null,
} as const;

/** what the trucks and buses have in common but their engines */
const HEAVY = {
  mapRpm: true,
  squeal: null,
  bell: false,
  relay: { tick: 1700, tock: 1300, level: 0.5 },
  air: true,
  beeper: true,
  stallHorn: null,
} as const;

export const PROFILES: Record<SoundKind, SoundProfile> = {
  // A 1.5 l turbo petrol four: smooth, even firing (second order), intake roar under load, a faint turbo.
  car: {
    main: {
      kind: 'engine',
      turns: 2,
      idleRpm: 800,
      maxRpm: 6500,
      soft: { kind: 'pulses', firing: I4, rise: 14, decay: 50, spread: 0.1, skew: 2 },
      hard: { kind: 'pulses', firing: I4, rise: 6, decay: 34, spread: 0.05, skew: 1 },
      partials: 720,
      db: 0,
      idle: 0.6,
      load: 0.45,
      revs: 0.4,
      harden: 0.8,
      lp: [600, 2200, 1100],
      lpQ: 1,
      body: [160, 1.2, 4],
      jitter: [5, 0.05],
      prop: 0,
    },
    mapRpm: true,
    noise: { f: [500, 1800], q: 0.9, db: -9, am: 0.6, base: 0.3, load: 0.85, revs: 0.4, firing: true },
    turbo: { f: [2800, 6500], db: -22, spool: 0.5 },
    tones: [{ wave: 'sine', by: 'speed', hz: 38, db: -30, effort: 0.6, fade: [3, 12] }],
    road: { db: -6, lp: [300, 28], q: 0.7 },
    wind: { db: -9, bp: [380, 14], q: 0.6 },
    skid: { f: 1150, q: 6, db: -4 },
    squeal: null,
    horn: { f: [415, 520], wave: 'sawtooth', lp: 2400, db: 6 },
    bell: false,
    starter: { f: 88, lfo: 9, depth: 22, db: -5 },
    relay: { tick: 2600, tock: 1900, level: 0.35 },
    air: false,
    beeper: false,
    stallHorn: null,
  },
  // A moped's 50 cm³ two-stroke single: a buzz through its expansion chamber – at idle it fires
  // properly only every other turn ("ring-ding-ding"), which the soft wave's weak second firing is.
  moped: {
    ...BIKE,
    main: {
      kind: 'engine',
      turns: 2,
      idleRpm: 1800,
      maxRpm: 9500,
      soft: { kind: 'pulses', firing: [0, 360], amps: [1, 0.4], rise: 4, decay: 30, spread: 0.25, skew: 8 },
      hard: { kind: 'pulses', firing: [0, 360], amps: [1, 0.95], rise: 2, decay: 18, spread: 0.05, skew: 2 },
      partials: 360,
      db: 0,
      idle: 0.45,
      load: 0.4,
      revs: 0.45,
      harden: 0.6,
      lp: [900, 4500, 2000],
      lpQ: 3,
      body: [1300, 2.5, 8],
      jitter: [15, 0.18],
      prop: 0,
    },
    noise: { f: [2500, 4000], q: 1.2, db: -6, am: 0.9, base: 0.2, load: 0.6, revs: 0.4, firing: true },
    tones: [],
    road: { db: -12, lp: [400, 30], q: 0.5 },
    wind: { db: -3, bp: [480, 18], q: 0.5 },
    horn: { f: [480, 482], wave: 'square', lp: 3500, db: 0 },
    starter: { f: 190, lfo: 15, depth: 40, db: -10 },
  },
  // A 125 cm³ four-stroke single: one bang every other turn – a thump at idle, a buzz when revved.
  motorcycle125: {
    ...BIKE,
    main: {
      kind: 'engine',
      turns: 2,
      idleRpm: 1500,
      maxRpm: 10000,
      soft: { kind: 'pulses', firing: [0], rise: 8, decay: 40, spread: 0, skew: 0 },
      hard: { kind: 'pulses', firing: [0], rise: 3, decay: 26, spread: 0, skew: 0 },
      partials: 400,
      db: 1.5,
      idle: 0.45,
      load: 0.4,
      revs: 0.4,
      harden: 0.7,
      lp: [700, 3800, 1500],
      lpQ: 2,
      body: [260, 1.5, 6],
      jitter: [10, 0.14],
      prop: 0,
    },
    noise: { f: [1200, 3000], q: 1, db: -6, am: 0.85, base: 0.2, load: 0.6, revs: 0.4, firing: true },
    tones: [{ wave: 'sine', by: 'speed', hz: 70, db: -32, effort: 0.3, fade: [3, 15] }],
    horn: { f: [440, 442], wave: 'square', lp: 3000, db: 2 },
    starter: { f: 150, lfo: 12, depth: 30, db: -8 },
  },
  // A parallel twin with a 270° crank (class A2): it fires after 270° and again after 450° – the lumpy beat of a V-twin.
  motorcycle35: {
    ...BIKE,
    main: {
      kind: 'engine',
      turns: 2,
      idleRpm: 1250,
      maxRpm: 9000,
      soft: { kind: 'pulses', firing: [0, 270], rise: 7, decay: 38, spread: 0.08, skew: 2 },
      hard: { kind: 'pulses', firing: [0, 270], rise: 3, decay: 24, spread: 0.04, skew: 1 },
      partials: 480,
      db: 2.5,
      idle: 0.45,
      load: 0.42,
      revs: 0.4,
      harden: 0.7,
      lp: [600, 3500, 1500],
      lpQ: 2,
      body: [200, 1.3, 6],
      jitter: [7, 0.1],
      prop: 0,
    },
    noise: { f: [900, 2500], q: 1, db: -7, am: 0.8, base: 0.2, load: 0.6, revs: 0.4, firing: true },
    tones: [{ wave: 'sine', by: 'speed', hz: 60, db: -32, effort: 0.3, fade: [3, 15] }],
    horn: { f: [430, 432], wave: 'sawtooth', lp: 2800, db: 2 },
    starter: { f: 130, lfo: 10, depth: 26, db: -7 },
  },
  // A big inline four: even firing every 180°, sharp pulses, high revs – a howl, and a deep intake roar.
  motorcycle: {
    ...BIKE,
    main: {
      kind: 'engine',
      turns: 2,
      idleRpm: 1200,
      maxRpm: 11000,
      soft: { kind: 'pulses', firing: I4, rise: 6, decay: 32, spread: 0.06, skew: 1.5 },
      hard: { kind: 'pulses', firing: I4, rise: 2.5, decay: 20, spread: 0.03, skew: 1 },
      partials: 500,
      db: 3,
      idle: 0.4,
      load: 0.42,
      revs: 0.5,
      harden: 0.7,
      lp: [700, 5000, 2000],
      lpQ: 2,
      body: [420, 1.2, 5],
      jitter: [5, 0.06],
      prop: 0,
    },
    noise: { f: [700, 2400], q: 0.9, db: -6, am: 0.6, base: 0.15, load: 0.75, revs: 0.5, firing: true },
    tones: [{ wave: 'sine', by: 'speed', hz: 55, db: -32, effort: 0.3, fade: [3, 15] }],
    horn: { f: [420, 528], wave: 'sawtooth', lp: 2600, db: 3 },
    starter: { f: 120, lfo: 10, depth: 26, db: -7 },
  },
  // A minibus's 2.3 l turbo diesel four, revving higher than a truck's (the game's engine is mapped onto it):
  // clatter at idle, a turbo whistle, hydraulic brakes.
  minibus: {
    main: {
      kind: 'engine',
      turns: 2,
      idleRpm: 750,
      maxRpm: 4000,
      soft: { kind: 'pulses', firing: I4, rise: 12, decay: 46, spread: 0.12, skew: 2 },
      hard: { kind: 'pulses', firing: I4, rise: 5, decay: 30, spread: 0.08, skew: 1.5 },
      partials: 800,
      db: 1,
      idle: 0.45,
      load: 0.4,
      revs: 0.35,
      harden: 0.7,
      lp: [380, 1800, 900],
      lpQ: 1,
      body: [120, 1, 4],
      jitter: [7, 0.08],
      prop: 0,
    },
    mapRpm: true,
    noise: { f: [1700, 2400], q: 1.3, db: -9, am: 0.85, base: 1, load: 0.35, revs: -0.45, firing: true },
    turbo: { f: [2200, 5200], db: -18, spool: 0.7 },
    tones: [{ wave: 'sine', by: 'speed', hz: 30, db: -28, effort: 0.5, fade: [3, 12] }],
    road: { db: -5, lp: [280, 25], q: 0.7 },
    wind: { db: -8, bp: [350, 13], q: 0.6 },
    skid: { f: 1000, q: 6, db: -4 },
    squeal: null,
    horn: { f: [349, 440], wave: 'sawtooth', lp: 2200, db: 6 },
    bell: false,
    starter: { f: 70, lfo: 7, depth: 16, db: -4 },
    relay: { tick: 2400, tock: 1800, level: 0.35 },
    air: false,
    beeper: false,
    stallHorn: null,
  },
  // A 7.5 t truck's 5 l diesel four: a slow, shaking idle, turbo, air brakes.
  lightTruck: {
    ...HEAVY,
    main: {
      kind: 'engine',
      turns: 2,
      idleRpm: 600,
      maxRpm: 2400,
      soft: { kind: 'pulses', firing: I4, rise: 14, decay: 52, spread: 0.14, skew: 3 },
      hard: { kind: 'pulses', firing: I4, rise: 6, decay: 34, spread: 0.09, skew: 2 },
      partials: 1000,
      db: 2.5,
      idle: 0.5,
      load: 0.4,
      revs: 0.3,
      harden: 0.7,
      lp: [320, 1600, 800],
      lpQ: 1.5,
      body: [95, 1, 5],
      jitter: [8, 0.1],
      prop: 0,
    },
    noise: { f: [1400, 2000], q: 1.2, db: -8, am: 0.85, base: 1, load: 0.35, revs: -0.4, firing: true },
    turbo: { f: [1800, 4200], db: -15, spool: 0.9 },
    tones: [{ wave: 'sine', by: 'speed', hz: 26, db: -26, effort: 0.5, fade: [3, 12] }],
    road: { db: -4, lp: [220, 20], q: 1 },
    wind: { db: -8, bp: [320, 12], q: 0.6 },
    skid: { f: 800, q: 5, db: -3 },
    horn: { f: [311, 392], wave: 'sawtooth', lp: 2000, db: 7 },
    starter: { f: 55, lfo: 6, depth: 14, db: -3 },
  },
  // A heavy truck's 10–13 l diesel six under the cab: an even rumble (third order), a loud turbo, air brakes.
  truck: {
    ...HEAVY,
    main: {
      kind: 'engine',
      turns: 2,
      idleRpm: 600,
      maxRpm: 2400,
      soft: { kind: 'pulses', firing: I6, rise: 12, decay: 44, spread: 0.1, skew: 2 },
      hard: { kind: 'pulses', firing: I6, rise: 5, decay: 28, spread: 0.06, skew: 1.5 },
      partials: 1000,
      db: 3,
      idle: 0.5,
      load: 0.45,
      revs: 0.3,
      harden: 0.7,
      lp: [300, 1700, 900],
      lpQ: 2,
      body: [85, 1, 5],
      jitter: [6, 0.07],
      prop: 0,
    },
    noise: { f: [1200, 1800], q: 1.1, db: -9, am: 0.8, base: 1, load: 0.4, revs: -0.4, firing: true },
    turbo: { f: [1600, 3800], db: -12, spool: 1.1 },
    tones: [{ wave: 'sine', by: 'speed', hz: 22, db: -26, effort: 0.5, fade: [3, 12] }],
    road: { db: -4, lp: [200, 18], q: 1 },
    wind: { db: -7, bp: [300, 12], q: 0.6 },
    skid: { f: 700, q: 5, db: -3 },
    horn: { f: [247, 311], wave: 'sawtooth', lp: 1800, db: 8 },
    starter: { f: 50, lfo: 8, depth: 14, db: -3 },
  },
  // The heavy trucks' 13 l six (the tractor unit of the articulated lorry, the three-axle rigid): deeper and slower
  // than the 12-tonner's, a big turbo that whistles and blows off, the exhaust brake's bark; air brakes, an air horn.
  semi: {
    ...HEAVY,
    main: {
      kind: 'engine',
      turns: 2,
      idleRpm: 550,
      maxRpm: 2100,
      soft: { kind: 'pulses', firing: I6, rise: 13, decay: 48, spread: 0.12, skew: 2.2 },
      hard: { kind: 'pulses', firing: I6, rise: 5, decay: 26, spread: 0.07, skew: 1.6 },
      partials: 1000,
      db: 4,
      idle: 0.5,
      load: 0.5,
      revs: 0.28,
      harden: 0.65,
      lp: [260, 1500, 1000],
      lpQ: 2.4,
      body: [72, 1.1, 6],
      jitter: [7, 0.08],
      prop: 0,
    },
    noise: { f: [1000, 1600], q: 1.1, db: -9, am: 0.8, base: 1, load: 0.45, revs: -0.4, firing: true },
    turbo: { f: [1400, 3400], db: -10, spool: 1.3 },
    tones: [{ wave: 'sine', by: 'speed', hz: 19, db: -25, effort: 0.5, fade: [3, 12] }],
    road: { db: -3, lp: [180, 17], q: 1.1 },
    wind: { db: -6, bp: [280, 11], q: 0.6 },
    skid: { f: 650, q: 5, db: -2 },
    horn: { f: [185, 233], wave: 'sawtooth', lp: 1500, db: 9 },
    starter: { f: 46, lfo: 7, depth: 15, db: -2 },
  },
  // A city bus: the truck's six, but at the back – heard muffled through the long body, which booms; the
  // gearbox and its retarder whine (louder as it brakes); air brakes and air doors.
  bus: {
    ...HEAVY,
    main: {
      kind: 'engine',
      turns: 2,
      idleRpm: 600,
      maxRpm: 2400,
      soft: { kind: 'pulses', firing: I6, rise: 12, decay: 44, spread: 0.1, skew: 2 },
      hard: { kind: 'pulses', firing: I6, rise: 5, decay: 28, spread: 0.06, skew: 1.5 },
      partials: 1000,
      db: 1,
      idle: 0.45,
      load: 0.45,
      revs: 0.3,
      harden: 0.7,
      lp: [240, 1300, 600],
      lpQ: 2,
      body: [70, 0.9, 6],
      jitter: [6, 0.07],
      prop: 0,
    },
    noise: { f: [1100, 1600], q: 1.1, db: -13, am: 0.8, base: 1, load: 0.4, revs: -0.4, firing: true },
    turbo: { f: [1700, 4000], db: -16, spool: 1.1 },
    tones: [{ wave: 'triangle', by: 'speed', hz: 34, db: -21, effort: 0.8, fade: [2, 10] }],
    road: { db: -5, lp: [210, 18], q: 1 },
    wind: { db: -10, bp: [300, 12], q: 0.6 },
    skid: { f: 700, q: 5, db: -3 },
    horn: { f: [294, 370], wave: 'sawtooth', lp: 2000, db: 7 },
    starter: { f: 50, lfo: 8, depth: 14, db: -4 },
  },
  // A 40 km/h tractor's diesel four: a slow, heavy knock through an open bonnet and a straight stack,
  // mechanical clatter, the gearbox whining with the speed, the lugs of its tyres humming.
  tractorSlow: {
    main: {
      kind: 'engine',
      turns: 2,
      idleRpm: 800,
      maxRpm: 2200,
      soft: { kind: 'pulses', firing: I4, rise: 10, decay: 40, spread: 0.2, skew: 4 },
      hard: { kind: 'pulses', firing: I4, rise: 4, decay: 26, spread: 0.14, skew: 3 },
      partials: 750,
      db: 4,
      idle: 0.6,
      load: 0.35,
      revs: 0.25,
      harden: 0.6,
      lp: [450, 2000, 900],
      lpQ: 3,
      body: [140, 1.5, 6],
      jitter: [12, 0.16],
      prop: 0,
    },
    mapRpm: true,
    noise: { f: [1000, 1500], q: 0.9, db: -5, am: 0.9, base: 1, load: 0.4, revs: -0.3, firing: true },
    turbo: null,
    tones: [
      { wave: 'sine', by: 'speed', hz: 58, db: -20, effort: 0.4, fade: [1, 5] },
      { wave: 'triangle', by: 'speed', hz: 7.5, db: -18, effort: 0, fade: [1, 4] },
    ],
    road: { db: -5, lp: [180, 25], q: 1 },
    wind: { db: -12, bp: [320, 12], q: 0.6 },
    skid: { f: 600, q: 3, db: -6 },
    squeal: null,
    horn: { f: [370, 371.5], wave: 'square', lp: 2500, db: 5 },
    bell: false,
    starter: { f: 48, lfo: 6, depth: 12, db: -3 },
    relay: { tick: 1500, tock: 1200, level: 0.5 },
    air: false,
    beeper: false,
    stallHorn: null,
  },
  // A 60 km/h tractor's turbo diesel six: smoother than the four, louder, with a turbo whistle.
  tractor: {
    main: {
      kind: 'engine',
      turns: 2,
      idleRpm: 800,
      maxRpm: 2200,
      soft: { kind: 'pulses', firing: I6, rise: 10, decay: 38, spread: 0.15, skew: 3 },
      hard: { kind: 'pulses', firing: I6, rise: 4, decay: 24, spread: 0.1, skew: 2 },
      partials: 750,
      db: 4,
      idle: 0.55,
      load: 0.4,
      revs: 0.3,
      harden: 0.6,
      lp: [420, 2100, 1000],
      lpQ: 2.5,
      body: [150, 1.4, 5],
      jitter: [9, 0.12],
      prop: 0,
    },
    mapRpm: true,
    noise: { f: [1100, 1600], q: 1, db: -6, am: 0.85, base: 1, load: 0.4, revs: -0.3, firing: true },
    turbo: { f: [2000, 4500], db: -16, spool: 0.9 },
    tones: [
      { wave: 'sine', by: 'speed', hz: 46, db: -21, effort: 0.4, fade: [1, 5] },
      { wave: 'triangle', by: 'speed', hz: 6, db: -18, effort: 0, fade: [1, 4] },
    ],
    road: { db: -5, lp: [180, 22], q: 1 },
    wind: { db: -12, bp: [320, 12], q: 0.6 },
    skid: { f: 600, q: 3, db: -6 },
    squeal: null,
    horn: { f: [392, 394], wave: 'square', lp: 2500, db: 5 },
    bell: false,
    starter: { f: 48, lfo: 7, depth: 12, db: -3 },
    relay: { tick: 1500, tock: 1200, level: 0.5 },
    air: false,
    beeper: false,
    stallHorn: null,
  },
  // The tram: no engine. Its traction motors and gears whine in orders of their turning – a chord that
  // rises with the speed, the gears alone while it coasts, the motors' magnetic orders when they pull or
  // brake; the inverter's carrier sings while it pulls away; fans, the rails' roar, the flanges squealing
  // in tight curves, the bell.
  tram: {
    main: {
      kind: 'motor',
      perMps: 3.45,
      soft: { kind: 'orders', orders: [[4, 0.12], [17, 1], [34, 0.35], [51, 0.12]], scatter: true },
      hard: { kind: 'orders', orders: [[2, 0.2], [4, 0.55], [6, 0.18], [12, 0.3], [17, 0.8], [26, 0.25], [28, 0.5], [30, 0.25], [34, 0.3], [56, 0.12]], scatter: true },
      partials: 64,
      db: -3,
      coast: 0.25,
      effort: 0.9,
      lp: [900, 100, 1500],
      lpQ: 2,
      body: [900, 1, 3],
      jitter: [3, 0.04],
    },
    mapRpm: false,
    noise: { f: [650, 650], q: 0.8, db: -14, am: 0, base: 1, load: 0, revs: 0, firing: false },
    turbo: null,
    tones: [{ wave: 'triangle', by: 'fixed', hz: 1150, db: -16, effort: 1, fade: [0, 0], out: [4, 12] }],
    road: { db: 5, lp: [180, 32], q: 4 },
    wind: { db: -14, bp: [350, 12], q: 0.6 },
    skid: null,
    squeal: { f: 2900, q: 28, db: -4, wobble: 50 },
    horn: null,
    bell: true,
    starter: null,
    relay: { tick: 2000, tock: 1500, level: 0.3 },
    air: false,
    beeper: false,
    stallHorn: null,
  },
  // A trainer's flat four driving a two-blade propeller directly: the blades pass twice a turn (the
  // propeller's drone, the soft wave, with the square of the rpm) over the raw firing of four short
  // stacks (the hard wave) – which windmilling with a dead engine leaves out. The wind of the airspeed,
  // the wheels on the runway, the stall warning's reed horn.
  plane: {
    main: {
      kind: 'prop',
      turns: 2,
      idleRpm: 650,
      maxRpm: 2700,
      soft: {
        kind: 'orders',
        orders: [[2, 0.12], [4, 1], [8, 0.5], [12, 0.33], [16, 0.24], [20, 0.18], [24, 0.13], [28, 0.1], [32, 0.075], [36, 0.055], [40, 0.04], [44, 0.03], [48, 0.022], [52, 0.016], [56, 0.012], [60, 0.009]],
      },
      hard: { kind: 'pulses', firing: I4, rise: 3, decay: 22, spread: 0.16, skew: 4 },
      partials: 860,
      db: 1,
      idle: 0,
      load: 0,
      revs: 0,
      harden: 1,
      lp: [800, 3500, 1000],
      lpQ: 1,
      body: [180, 1, 4],
      jitter: [6, 0.08],
      prop: 1.2,
    },
    mapRpm: false,
    noise: { f: [350, 900], q: 0.7, db: -8, am: 0.5, base: 0.4, load: 0.3, revs: 0.6, firing: false },
    turbo: null,
    tones: [],
    road: { db: -8, lp: [250, 25], q: 1 },
    wind: { db: -4, bp: [350, 10], q: 0.5 },
    skid: { f: 1100, q: 6, db: -6 },
    squeal: null,
    horn: null,
    bell: false,
    starter: { f: 60, lfo: 5, depth: 14, db: -4 },
    relay: null,
    air: false,
    beeper: false,
    stallHorn: { f: 1650, db: -2 },
  },
  // On foot there is nothing to hear but one's steps (click('step')).
  onFoot: {
    main: null,
    mapRpm: false,
    noise: null,
    turbo: null,
    tones: [],
    road: null,
    wind: null,
    skid: null,
    squeal: null,
    horn: null,
    bell: false,
    starter: null,
    relay: { tick: 2600, tock: 1900, level: 0.35 },
    air: false,
    beeper: false,
    stallHorn: null,
  },
};

/** The game's engine speeds that are mapped onto a profile's: its engine's idle and its limiter. */
export interface RpmScale {
  idleRpm: number;
  limiterRpm: number;
}

/** The engine speed the profile plays at for the game's `rpm`: the game's idle onto its idle, the limiter onto its highest. */
export function soundRpm(p: SoundProfile, rpm: number, scale: RpmScale | null): number {
  const r = Math.max(0, rpm || 0);
  const m = p.main;
  if (!m || m.kind === 'motor' || !p.mapRpm || !scale || !(scale.idleRpm > 0) || !(scale.limiterRpm > scale.idleRpm)) return r;
  if (r <= scale.idleRpm) return (r * m.idleRpm) / scale.idleRpm;
  return m.idleRpm + ((r - scale.idleRpm) * (m.maxRpm - m.idleRpm)) / (scale.limiterRpm - scale.idleRpm);
}

/** How often the engine fires (Hz) at an engine speed: a four-stroke's cylinders once every two turns, the two-stroke's every turn. */
export function firingHz(p: SoundProfile, rpm: number): number {
  const m = p.main;
  if (!m || m.kind === 'motor' || m.hard.kind !== 'pulses') return 0;
  return (rpm / 60) * (m.hard.firing.length / m.turns);
}

/** A profile ready to be played: its waves and the gains that make each voice as loud as it says. */
export interface Voicing {
  kind: SoundKind;
  profile: SoundProfile;
  soft: Partials | null;
  hard: Partials | null;
  gain: {
    main: number;
    noise: number;
    turbo: number;
    tones: [number, number];
    road: number;
    wind: number;
    skid: number;
    squeal: number;
    horn: number;
    starter: number;
    stall: number;
  };
}

/** Where every voice is to go this frame (audio.ts glides there). */
export interface SoundTargets {
  /** the main voice: fundamental (Hz – a whole wave period, the engine's cycle), the shares of its soft and hard wave, its level, its low-pass (Hz), unsteadiness (cents, share) */
  freq: number;
  soft: number;
  hard: number;
  level: number;
  cutoff: number;
  jitCents: number;
  jitAmp: number;
  noiseFreq: number;
  noiseLevel: number;
  turboFreq: number;
  turboLevel: number;
  toneAFreq: number;
  toneALevel: number;
  toneBFreq: number;
  toneBLevel: number;
  roadCutoff: number;
  roadLevel: number;
  windFreq: number;
  windLevel: number;
  /** the skidding tyre – the tram's squeal: band-pass centre (Hz) and level */
  skidFreq: number;
  skidLevel: number;
  hornLevel: number;
  starterLevel: number;
}

export function newTargets(): SoundTargets {
  return {
    freq: 10,
    soft: 0,
    hard: 0,
    level: 0,
    cutoff: 1000,
    jitCents: 0,
    jitAmp: 0,
    noiseFreq: 1000,
    noiseLevel: 0,
    turboFreq: 3000,
    turboLevel: 0,
    toneAFreq: 440,
    toneALevel: 0,
    toneBFreq: 440,
    toneBLevel: 0,
    roadCutoff: 500,
    roadLevel: 0,
    windFreq: 500,
    windLevel: 0,
    skidFreq: 1000,
    skidLevel: 0,
    hornLevel: 0,
    starterLevel: 0,
  };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
/** 0 → 1 over a range of speeds; a range that is no range: always 1 */
const ramp = (r: readonly [number, number], v: number): number => (r[1] > r[0] ? smoothstep(r[0], r[1], v) : 1);

function engineShape(m: EngineVoice, load: number, n: number): number {
  return m.idle + m.load * load ** 0.8 + m.revs * Math.max(0, n) ** 1.3;
}

/**
 * Where every voice of a vehicle is to go for what the game says (its
 * engine speeds mapped by `scale`). Writes into `out` – nothing is made anew
 * per frame.
 */
export function soundTargets(v: Voicing, s: AudioState, scale: RpmScale | null, out: SoundTargets): SoundTargets {
  const p = v.profile;
  const g = v.gain;
  const speed = Math.abs(s.speed) || 0;
  const vv = Math.min(speed, 90);
  const load = clamp01(s.load || 0);
  const braking = clamp01(s.braking ?? 0);
  const m = p.main;
  let n = 0;
  let rpmS = 0;
  let effort = Math.max(load, braking);
  let firing = false;
  let turning = false;
  out.level = 0;
  out.soft = 0;
  out.hard = 0;
  out.jitCents = 0;
  out.jitAmp = 0;
  if (m && m.kind !== 'motor') {
    rpmS = soundRpm(p, s.rpm, scale);
    n = clamp((rpmS - m.idleRpm) / (m.maxRpm - m.idleRpm), 0, 1.2);
    turning = rpmS > 40;
    firing = s.engineRunning && turning;
    out.freq = Math.max(1, rpmS / 60 / m.turns);
    const h = firing ? load ** m.harden : 0;
    if (m.kind === 'prop') {
      // the propeller with the square of its speed (windmilling too), the exhaust only while it fires
      const x = Math.min(1.15, rpmS / m.maxRpm);
      out.soft = m.prop * x * x;
      out.hard = firing ? 0.45 + 0.55 * load : 0;
      out.level = turning ? g.main : 0;
    } else {
      out.soft = 1 - h;
      out.hard = h;
      // (turned by the starter: compression without combustion, softer)
      if (firing) out.level = g.main * engineShape(m, load, n);
      else if (turning) out.level = g.main * CRANK * engineShape(m, 0, 0) * Math.min(1, rpmS / m.idleRpm);
    }
    out.cutoff = m.lp[0] + (m.lp[1] - m.lp[0]) * Math.min(1, n) + m.lp[2] * (firing ? load : 0);
    out.jitCents = m.jitter[0] * (1 - 0.6 * h);
    out.jitAmp = m.jitter[1] * (1 - 0.5 * h);
  } else if (m) {
    // the motors pull or brake only with power; the gears turn whenever the tram rolls
    effort = s.engineRunning ? clamp01(Math.max(load, 0.8 * braking)) : 0;
    turning = speed > 0.05;
    firing = s.engineRunning;
    out.freq = Math.max(0.5, m.perMps * speed);
    out.soft = 1 - effort;
    out.hard = effort;
    out.level = g.main * (m.coast * smoothstep(0.3, 6, speed) + m.effort * effort * (0.35 + 0.65 * smoothstep(0, 5, speed)));
    out.cutoff = m.lp[0] + m.lp[1] * speed + m.lp[2] * effort;
    out.jitCents = m.jitter[0];
    out.jitAmp = m.jitter[1];
  }

  const nz = p.noise;
  out.noiseLevel = 0;
  if (nz) {
    const on = nz.firing ? firing : m?.kind === 'motor' ? s.engineRunning : turning;
    out.noiseFreq = nz.f[0] + (nz.f[1] - nz.f[0]) * Math.min(1, n);
    if (on) out.noiseLevel = g.noise * Math.max(0, nz.base + nz.load * load + nz.revs * n);
  }

  const tb = p.turbo;
  out.turboLevel = 0;
  if (tb) {
    // the turbine runs on the exhaust's energy – load and revs – and takes its time (audio.ts glides with tb.spool)
    const spool = firing ? clamp01(load * Math.min(1, n * 1.1)) : 0;
    out.turboFreq = tb.f[0] + (tb.f[1] - tb.f[0]) * spool ** 0.7;
    out.turboLevel = g.turbo * spool ** 1.2;
  }

  for (let i = 0; i < 2; i++) {
    const tn = p.tones[i];
    let f = 440;
    let lv = 0;
    if (tn) {
      const src = tn.by === 'speed' ? speed : tn.by === 'rpm' ? rpmS : 1;
      f = Math.max(1, tn.hz * src);
      lv = g.tones[i] * (1 - tn.effort + tn.effort * effort) * ramp(tn.fade, speed) * (tn.out ? 1 - ramp(tn.out, speed) : 1);
      if (tn.by === 'rpm' && !firing) lv = 0;
    }
    if (i === 0) {
      out.toneAFreq = f;
      out.toneALevel = lv;
    } else {
      out.toneBFreq = f;
      out.toneBLevel = lv;
    }
  }
  if (p.stallHorn) {
    out.toneAFreq = p.stallHorn.f;
    out.toneALevel = s.stallWarning ? g.stall : 0;
  }

  const rough = clamp(s.rough || 1, 1, 3);
  out.roadLevel = 0;
  if (p.road) {
    out.roadCutoff = (p.road.lp[0] + p.road.lp[1] * Math.min(vv, 45)) * (0.85 + 0.15 * rough);
    if (!s.airborne && speed > 0.05) out.roadLevel = g.road * Math.min(1.6, (vv / AT_SPEED) ** 1.25) * (0.4 + 0.6 * rough);
  }
  out.windLevel = 0;
  if (p.wind) {
    out.windFreq = p.wind.bp[0] + p.wind.bp[1] * Math.min(vv, 60);
    out.windLevel = g.wind * Math.min(3, (vv / AT_SPEED) ** 2);
  }

  out.skidLevel = 0;
  if (p.squeal) {
    // flanges in a curve tighter than a few hundred metres, at a fair pace; the brakes the moment before it stands
    const c = Math.abs(s.curve ?? 0);
    const curve = smoothstep(1 / 300, 1 / 40, c) * smoothstep(0.8, 3, speed) * (1 - 0.5 * smoothstep(8, 16, speed));
    const stopping = smoothstep(0.15, 0.6, braking) * smoothstep(0.03, 0.3, speed) * (1 - smoothstep(1.2, 2.5, speed));
    out.skidFreq = p.squeal.f;
    out.skidLevel = g.squeal * Math.max(curve, 0.45 * stopping, clamp01(s.skid || 0));
  } else if (p.skid) {
    out.skidFreq = p.skid.f;
    out.skidLevel = g.skid * clamp01(s.skid || 0);
  }

  out.hornLevel = p.horn && s.horn ? g.horn : 0;
  out.starterLevel = p.starter && s.starter && !s.engineRunning ? g.starter : 0;
  return out;
}

/** How loud (A-weighted RMS) the main voice is at some targets – with the waves, the filters it goes through. */
export function mainLoudness(v: Voicing, t: SoundTargets): number {
  const m = v.profile.main;
  if (!m || !v.soft || !v.hard) return 0;
  const [bf, bq, bg] = m.body;
  return t.level * waveLoudness(v.soft, t.soft, v.hard, t.hard, t.freq, (f) => lowpassGain(f, t.cutoff, m.lpQ) * peakingGain(f, bf, bq, bg));
}

/** The state the main voice's level is given at: half load at 45 % of the revs – for the tram 10 m/s at half effort. */
export function referenceState(p: SoundProfile): AudioState {
  const m = p.main;
  const rpm = m && m.kind !== 'motor' ? m.idleRpm + 0.45 * (m.maxRpm - m.idleRpm) : 0;
  return { rpm, load: 0.5, engineRunning: true, starter: false, speed: 10, skid: 0, indicatorOn: false, blinkOn: false, horn: false, rough: 1 };
}

const dbGain = (db: number): number => 10 ** (db / 20) * REF_LOUDNESS;

/** a seed per kind of vehicle, so that its cylinders differ the same way every time */
function seedOf(kind: string): number {
  let h = 2166136261;
  for (let i = 0; i < kind.length; i++) h = Math.imul(h ^ kind.charCodeAt(i), 16777619);
  return h >>> 0;
}

const voicings = new Map<SoundKind, Voicing>();

/** A profile ready to be played (worked out on first use, then kept). */
export function voicing(kind: SoundKind): Voicing {
  const have = voicings.get(kind);
  if (have) return have;
  const p = PROFILES[kind];
  const m = p.main;
  let soft: Partials | null = null;
  let hard: Partials | null = null;
  if (m) {
    const seed = seedOf(kind);
    const period = m.kind === 'motor' ? 360 : 360 * m.turns;
    const count = (w: WaveSpec): number => (w.kind === 'orders' ? Math.max(...w.orders.map((o) => o[0])) : m.partials);
    soft = wavePartials(m.soft, period, count(m.soft), seed);
    hard = wavePartials(m.hard, period, count(m.hard), seed);
  }
  const v: Voicing = {
    kind,
    profile: p,
    soft,
    hard,
    gain: { main: 1, noise: 1, turbo: 0, tones: [0, 0], road: 0, wind: 0, skid: 0, squeal: 0, horn: 0, starter: 0, stall: 0 },
  };
  const g = v.gain;
  // the main voice and the engine's noise, measured at the reference with unit gains
  if (m && soft && hard) {
    const t = soundTargets(v, referenceState(p), null, newTargets());
    g.main = dbGain(m.db) / Math.max(1e-9, mainLoudness(v, t));
    const nz = p.noise;
    if (nz) {
      const pulses = Math.sqrt((1 - nz.am) ** 2 + (nz.am * rmsOf(hard)) ** 2);
      const raw = noiseLoudness((f) => bandpassGain(f, t.noiseFreq, nz.q)) * pulses * t.noiseLevel;
      g.noise = dbGain(m.db + nz.db) / Math.max(1e-9, raw);
    }
  } else g.noise = 0;
  if (p.turbo) g.turbo = dbGain(p.turbo.db) / oscLoudness('sine', p.turbo.f[1]);
  p.tones.forEach((tn, i) => {
    const mid = m && m.kind !== 'motor' ? (m.idleRpm + m.maxRpm) / 2 : 1000;
    const f = tn.by === 'speed' ? tn.hz * 15 : tn.by === 'rpm' ? tn.hz * mid : tn.hz;
    g.tones[i] = dbGain(tn.db) / oscLoudness(tn.wave, f);
  });
  if (p.road) {
    const r = p.road;
    g.road = dbGain(r.db) / noiseLoudness((f) => lowpassGain(f, r.lp[0] + r.lp[1] * AT_SPEED, r.q));
  }
  if (p.wind) {
    const w = p.wind;
    g.wind = dbGain(w.db) / noiseLoudness((f) => bandpassGain(f, w.bp[0] + w.bp[1] * AT_SPEED, w.q));
  }
  if (p.skid) {
    const k = p.skid;
    g.skid = dbGain(k.db) / noiseLoudness((f) => bandpassGain(f, k.f, k.q));
  }
  if (p.squeal) {
    const q = p.squeal;
    g.squeal = dbGain(q.db) / noiseLoudness((f) => bandpassGain(f, q.f, q.q));
  }
  if (p.horn) {
    const h = p.horn;
    const one = (f0: number): number => oscLoudness(h.wave, f0, (f) => lowpassGain(f, h.lp, 0));
    g.horn = dbGain(h.db) / Math.hypot(one(h.f[0]), one(h.f[1]));
  }
  if (p.starter) g.starter = dbGain(p.starter.db) / oscLoudness('sawtooth', p.starter.f);
  if (p.stallHorn) g.stall = dbGain(p.stallHorn.db) / oscLoudness('triangle', p.stallHorn.f);
  voicings.set(kind, v);
  return v;
}
