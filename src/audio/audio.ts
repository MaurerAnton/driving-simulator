// SPDX-License-Identifier: AGPL-3.0-only
/**
 * All sound is synthesised with the Web Audio API – nothing is recorded,
 * nothing downloaded. Every kind of vehicle has a sound of its own
 * (profiles.ts: a petrol four, diesels from the van to the truck, the
 * tractors, the motorcycles from the moped's two-stroke to the big four,
 * the tram's motors, the aeroplane's engine and propeller); here the voices
 * are built once, when the sound starts, and set up anew when the vehicle
 * changes – while driving, update() only moves their settings, so that it
 * stays cheap on a weak tablet or a phone:
 *
 *   main voice   two oscillators playing the vehicle's waves (soft, hard)
 *                → low-pass → resonance → unsteadiness → level
 *   engine noise noise → band-pass → in pulses with the hard wave → level
 *   whines       turbo, two tones (gears, chain, the tram's inverter, the stall horn)
 *   rolling, wind, skid (the tram's squeal), air (hisses), horn, starter
 *
 * All of it goes through one gain that silences it while the vehicle
 * changes and a high-pass that keeps the inaudible bottom of the engines'
 * waves off small speakers; then the master gain (the game's volume) and a
 * limiter. Short sounds (click) and the music (music.ts) join at the master.
 */
import { MusicPlayer } from './music.ts';
import type { MusicMode } from './music.ts';
import type { AudioState, RpmScale, SoundKind, Voicing } from './profiles.ts';
import { REF_LOUDNESS, newTargets, soundTargets, voicing } from './profiles.ts';
import { bandpassGain, noiseLoudness } from './waves.ts';

export type { AudioState, RpmScale, SoundKind } from './profiles.ts';
export { SOUND_KINDS, soundKindOf } from './profiles.ts';
export type { MusicMode } from './music.ts';

/** The short sounds click() makes. */
export type ClickKind =
  /** the indicator relay (also the game's small clicks) */
  | 'tick'
  | 'tock'
  | 'crash'
  | 'grind'
  | 'chime'
  | 'bump'
  /** a door's latch as it opens, a door shut */
  | 'door'
  | 'doorShut'
  /** a footstep – a crunch on rough ground */
  | 'step'
  /** air brakes: the parking brake set ("pssht"), a short puff, a passenger door working on air (hiss and thud) */
  | 'air'
  | 'airShort'
  | 'airDoor'
  /** the tram's bell, struck once */
  | 'bell'
  /** wheels over a rail joint or a switch: two knocks, an axle's distance apart at the speed going */
  | 'clack'
  /** one beep of a reversing alarm */
  | 'beep';

/** the tram's bell: partials of a dome bell (ratio to the lowest), how strong, how fast they die away (s) */
const BELL: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 0.35],
  [2.32, 0.5, 0.18],
  [4.25, 0.25, 0.09],
  [6.63, 0.12, 0.05],
];
const DEFAULT_RELAY = { tick: 2600, tock: 1900, level: 0.35 };
/** the hiss of air: its band-pass (Hz, Q) – loudness of the air sounds are given against this */
const HISS_F = 3600;
const HISS_Q = 0.6;

// The settings the main loop moves, numbered for the memory of what was last sent to each.
const F = 0;
const SOFT = 1;
const HARD = 2;
const LEVEL = 3;
const CUT = 4;
const JIT_P = 5;
const JIT_A = 6;
const NZ_F = 7;
const NZ_L = 8;
const TB_F = 9;
const TB_L = 10;
const TA_F = 11;
const TA_L = 12;
const TB2_F = 13;
const TB2_L = 14;
const RD_C = 15;
const RD_L = 16;
const WD_F = 17;
const WD_L = 18;
const SK_F = 19;
const SK_L = 20;
const HORN = 21;
const START = 22;
const SLOTS = 23;

interface Nodes {
  ctx: AudioContext;
  master: GainNode;
  bus: GainNode;
  noiseBuf: AudioBuffer;
  oscSoft: OscillatorNode;
  oscHard: OscillatorNode;
  gSoft: GainNode;
  gHard: GainNode;
  mainLp: BiquadFilterNode;
  mainBody: BiquadFilterNode;
  jitStage: GainNode;
  mainLevel: GainNode;
  jitPitch: GainNode;
  jitAmp: GainNode;
  jitSqueal: GainNode;
  nzBp: BiquadFilterNode;
  nzAm: GainNode;
  nzDepth: GainNode;
  nzLevel: GainNode;
  turbo: OscillatorNode;
  turboLevel: GainNode;
  toneA: OscillatorNode;
  toneALevel: GainNode;
  toneB: OscillatorNode;
  toneBLevel: GainNode;
  roadLp: BiquadFilterNode;
  roadLevel: GainNode;
  windBp: BiquadFilterNode;
  windLevel: GainNode;
  skidBp: BiquadFilterNode;
  skidLevel: GainNode;
  hissBp: BiquadFilterNode;
  hissLevel: GainNode;
  horn1: OscillatorNode;
  horn2: OscillatorNode;
  hornLp: BiquadFilterNode;
  hornLevel: GainNode;
  starter: OscillatorNode;
  starterLfo: OscillatorNode;
  starterDepth: GainNode;
  starterLevel: GainNode;
}

export class GameAudio {
  private n: Nodes | null = null;
  private kind: SoundKind = 'car';
  private voice: Voicing = voicing('car');
  private scale: RpmScale | null = null;
  private readonly tg = newTargets();
  /** what was last sent to each setting (NaN: whatever comes next is sent) – unchanged settings are not sent again */
  private readonly sent = new Float64Array(SLOTS).fill(NaN);
  private now = 0;
  /** RMS of the low-passed noise that makes the unsteadiness, and the gain that makes a hiss as loud as the reference */
  private jitRms = 0.0176;
  private hissUnit = 1;
  private lastBlink = false;
  private lastHorn = false;
  private nextBell = 0;
  private lastPark: boolean | null = null;
  private brakeHeld = 0;
  private nextPuff = 0;
  private purgeAt = 0;
  private nextBeep = 0;
  private lastRough = 1;
  private lastSpeed = 0;
  private music: MusicPlayer | null = null;
  private musicMode: MusicMode = 'off';
  private musicVolume = 1;
  private readonly ready: Array<(ctx: AudioContext, master: GainNode) => void> = [];
  volume = 0.7;

  /** Must be called from a user gesture (click / key) – browsers require it. */
  start(): void {
    if (this.n) {
      void this.n.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const t0 = ctx.currentTime;
    const gain = (v: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    const filter = (type: BiquadFilterType, f: number, q: number): BiquadFilterNode => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const osc = (type: OscillatorType, f: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      return o;
    };

    const master = gain(this.volume);
    // a limiter, so that a crash on top of a roaring engine does not clip (set high: below it nothing changes)
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 1;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    const bus = gain(1);
    const subsonic = filter('highpass', 28, -3);
    bus.connect(subsonic);
    subsonic.connect(master);

    // white noise, read by two sources at different places (so that the voices fed by them do not move together)
    const len = ctx.sampleRate * 2;
    const noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      d[i] = (seed / 4294967296) * 2 - 1;
    }
    const noise = (offset: number): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      s.loop = true;
      s.start(t0, offset);
      return s;
    };
    const noiseA = noise(0);
    const noiseB = noise(0.77);

    // the main voice: both waves on one clock (started together, they stay in phase as they blend)
    const oscSoft = osc('sine', 20);
    const oscHard = osc('sine', 20);
    const gSoft = gain(0);
    const gHard = gain(0);
    const mainLp = filter('lowpass', 1000, 1);
    const mainBody = filter('peaking', 150, 1);
    const jitStage = gain(1);
    const mainLevel = gain(0);
    oscSoft.connect(gSoft);
    oscHard.connect(gHard);
    gSoft.connect(mainLp);
    gHard.connect(mainLp);
    mainLp.connect(mainBody);
    mainBody.connect(jitStage);
    jitStage.connect(mainLevel);
    mainLevel.connect(bus);
    // unsteadiness: slow random wandering of the engine's speed and strength (and of the tram's squeal)
    const jitLp = filter('lowpass', 20, -3);
    this.jitRms = 0.577 * Math.sqrt((1.11 * 20) / (ctx.sampleRate / 2));
    const jitPitch = gain(0);
    const jitAmp = gain(0);
    const jitSqueal = gain(0);
    noiseA.connect(jitLp);
    jitLp.connect(jitPitch);
    jitLp.connect(jitAmp);
    jitLp.connect(jitSqueal);
    jitPitch.connect(oscSoft.detune);
    jitPitch.connect(oscHard.detune);
    jitAmp.connect(jitStage.gain);

    // the engine's noise, opened and closed by the hard wave: it comes with the firings
    const nzBp = filter('bandpass', 1000, 1);
    const nzAm = gain(1);
    const nzDepth = gain(0);
    const nzLevel = gain(0);
    noiseB.connect(nzBp);
    nzBp.connect(nzAm);
    nzAm.connect(nzLevel);
    nzLevel.connect(bus);
    oscHard.connect(nzDepth);
    nzDepth.connect(nzAm.gain);

    const turbo = osc('sine', 3000);
    const turboLevel = gain(0);
    turbo.connect(turboLevel);
    turboLevel.connect(bus);
    const toneA = osc('sine', 440);
    const toneALevel = gain(0);
    toneA.connect(toneALevel);
    toneALevel.connect(bus);
    const toneB = osc('sine', 440);
    const toneBLevel = gain(0);
    toneB.connect(toneBLevel);
    toneBLevel.connect(bus);

    // rolling, wind, a skidding tyre (the tram's squeal, wandering in pitch), air
    const roadLp = filter('lowpass', 500, 1);
    const roadLevel = gain(0);
    noiseA.connect(roadLp);
    roadLp.connect(roadLevel);
    roadLevel.connect(bus);
    const windBp = filter('bandpass', 500, 0.6);
    const windLevel = gain(0);
    noiseB.connect(windBp);
    windBp.connect(windLevel);
    windLevel.connect(bus);
    const skidBp = filter('bandpass', 1150, 6);
    const skidLevel = gain(0);
    noiseA.connect(skidBp);
    skidBp.connect(skidLevel);
    skidLevel.connect(bus);
    jitSqueal.connect(skidBp.detune);
    const hissBp = filter('bandpass', HISS_F, HISS_Q);
    const hissLevel = gain(0);
    noiseB.connect(hissBp);
    hissBp.connect(hissLevel);
    hissLevel.connect(bus);
    this.hissUnit = REF_LOUDNESS / noiseLoudness((f) => bandpassGain(f, HISS_F, HISS_Q), ctx.sampleRate);

    // horn: two tones
    const horn1 = osc('sawtooth', 415);
    const horn2 = osc('sawtooth', 520);
    const hornLp = filter('lowpass', 2400, 1);
    const hornLevel = gain(0);
    horn1.connect(hornLp);
    horn2.connect(hornLp);
    hornLp.connect(hornLevel);
    hornLevel.connect(bus);

    // starter motor: a whirr that labours through the compression strokes
    const starter = osc('sawtooth', 88);
    const starterLfo = osc('sine', 9);
    const starterDepth = gain(22);
    const starterLevel = gain(0);
    starterLfo.connect(starterDepth);
    starterDepth.connect(starter.frequency);
    starter.connect(starterLevel);
    starterLevel.connect(bus);

    for (const o of [oscSoft, oscHard, turbo, toneA, toneB, horn1, horn2, starter, starterLfo]) o.start(t0);

    this.n = {
      ctx,
      master,
      bus,
      noiseBuf,
      oscSoft,
      oscHard,
      gSoft,
      gHard,
      mainLp,
      mainBody,
      jitStage,
      mainLevel,
      jitPitch,
      jitAmp,
      jitSqueal,
      nzBp,
      nzAm,
      nzDepth,
      nzLevel,
      turbo,
      turboLevel,
      toneA,
      toneALevel,
      toneB,
      toneBLevel,
      roadLp,
      roadLevel,
      windBp,
      windLevel,
      skidBp,
      skidLevel,
      hissBp,
      hissLevel,
      horn1,
      horn2,
      hornLp,
      hornLevel,
      starter,
      starterLfo,
      starterDepth,
      starterLevel,
    };
    this.applyVehicle();
    if (this.musicMode !== 'off') this.setMusic(this.musicMode, this.musicVolume);
    for (const f of this.ready.splice(0)) f(ctx, master);
  }

  suspend(): void {
    void this.n?.ctx.suspend();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.n) this.n.master.gain.setTargetAtTime(v, this.n.ctx.currentTime, 0.05);
  }

  /** The game's AudioContext once start() has made it (null before) – other sounds of the game (a siren) play in it. */
  get context(): AudioContext | null {
    return this.n?.ctx ?? null;
  }

  /** The master gain – the game's volume, followed only by a limiter: where other sounds of the game connect (null before start()). */
  get masterGain(): GainNode | null {
    return this.n?.master ?? null;
  }

  /** Calls `f` with the context and the master gain once they are there – at once if they already are. */
  onReady(f: (ctx: AudioContext, master: GainNode) => void): void {
    if (this.n) f(this.n.ctx, this.n.master);
    else this.ready.push(f);
  }

  /** the vehicle sound now set */
  get vehicleSound(): SoundKind {
    return this.kind;
  }

  /**
   * The vehicle whose sound is to be heard (soundKindOf gives it for a vehicle of the game). `engine`: the idle
   * and limiter speeds of the game's engine for it (a VehicleSpec will do) – its rpm are then mapped onto the
   * sound's own engine (a minibus's diesel revs higher than the truck engine the game drives it with); left out,
   * rpm are taken as they come. The tram and the aeroplane ignore it.
   */
  setVehicle(kind: SoundKind, engine?: RpmScale | null): void {
    this.kind = kind;
    this.voice = voicing(kind);
    this.scale = engine && engine.idleRpm > 0 && engine.limiterRpm > engine.idleRpm ? { idleRpm: engine.idleRpm, limiterRpm: engine.limiterRpm } : null;
    this.applyVehicle();
  }

  /**
   * The music: 'off' (the default – nothing of it runs), 'quiet' (now and then a piece, softly, with pauses of a
   * few minutes) or 'on' (pieces with short pauses, a little louder); `volume` 0 … 1 on top of the game's volume.
   */
  setMusic(mode: MusicMode, volume: number = this.musicVolume): void {
    this.musicMode = mode;
    this.musicVolume = Math.max(0, Math.min(1, volume));
    const n = this.n;
    if (!n || (mode === 'off' && !this.music)) return;
    if (!this.music) this.music = new MusicPlayer(n.ctx, n.master);
    this.music.set(mode, this.musicVolume);
  }

  /** Short sounds. */
  click(kind: ClickKind): void {
    const n = this.n;
    if (!n) return;
    const ctx = n.ctx;
    const t = ctx.currentTime;
    switch (kind) {
      case 'chime': {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.setValueAtTime(880, t);
        o.frequency.setValueAtTime(660, t + 0.12);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
        o.connect(g);
        g.connect(n.master);
        o.start(t);
        o.stop(t + 0.45);
        return;
      }
      case 'tick':
      case 'tock': {
        // (the relay sounds as the vehicle's does: a truck's clacks, a motorcycle's barely ticks)
        const r = this.voice.profile.relay ?? DEFAULT_RELAY;
        this.noiseHit(t, 'bandpass', kind === 'tick' ? r.tick : r.tock, 4, r.level, 0.03);
        return;
      }
      case 'crash':
        this.noiseHit(t, 'lowpass', 900, 1, 1.0, 0.5);
        return;
      case 'bump':
        this.noiseHit(t, 'lowpass', 220, 1, 0.7, 0.12);
        return;
      case 'door':
        // the latch of a door that opens
        this.noiseHit(t, 'bandpass', 1150, 3, 0.5, 0.07);
        return;
      case 'doorShut':
        this.noiseHit(t, 'lowpass', 320, 1, 1.0, 0.2);
        return;
      case 'grind':
        this.noiseHit(t, 'bandpass', 1700, 1.5, 0.4, 0.28);
        return;
      case 'step': {
        // the heel, then the sole – a scuff on a pavement, a crunch on gravel; no two alike
        const r = Math.random;
        const gravel = this.lastRough > 1.6;
        this.noiseHit(t, 'lowpass', 170 + 90 * r(), 1, 0.13 * (0.8 + 0.4 * r()), 0.06);
        this.noiseHit(t + 0.02 + 0.03 * r(), 'bandpass', gravel ? 2400 + 600 * r() : 900 + 400 * r(), gravel ? 1.2 : 1.5, (gravel ? 0.09 : 0.05) * (0.8 + 0.4 * r()), gravel ? 0.11 : 0.05);
        return;
      }
      case 'air':
        // the spring brakes' air let out: loud at once, the hiss sinking as the pressure goes
        this.hiss(3, 0.25, 0.28, 4200, 2600);
        return;
      case 'airShort':
        this.hiss(-7, 0.05, 0.1, 4500, 3200);
        return;
      case 'airDoor':
        this.hiss(-2, 0.3, 0.15, 3000, 2200);
        this.noiseHit(t + 0.75, 'lowpass', 260, 1, 0.5, 0.15);
        return;
      case 'bell':
        this.strike(t);
        return;
      case 'clack': {
        // (the two axles of a bogie, 1.8 m apart)
        const gap = Math.min(0.5, 1.8 / Math.max(1, this.lastSpeed));
        for (const dt of [0, gap]) {
          this.noiseHit(t + dt, 'lowpass', 1300, 1, 0.45, 0.05);
          this.noiseHit(t + dt, 'bandpass', 2300, 8, 0.25, 0.09);
        }
        return;
      }
      case 'beep':
        this.beep(t);
        return;
    }
  }

  update(s: AudioState): void {
    const n = this.n;
    if (!n || n.ctx.state !== 'running') return;
    const t = (this.now = n.ctx.currentTime);
    const v = this.voice;
    const p = v.profile;
    const T = soundTargets(v, s, this.scale, this.tg);

    // the main voice: both oscillators always on the same speed
    if (this.changed(F, T.freq)) {
      n.oscSoft.frequency.setTargetAtTime(T.freq, t, 0.03);
      n.oscHard.frequency.setTargetAtTime(T.freq, t, 0.03);
    }
    this.glide(SOFT, n.gSoft.gain, T.soft, 0.06);
    this.glide(HARD, n.gHard.gain, T.hard, 0.06);
    this.glide(LEVEL, n.mainLevel.gain, T.level, 0.05);
    this.glide(CUT, n.mainLp.frequency, T.cutoff, 0.06);
    this.glide(JIT_P, n.jitPitch.gain, T.jitCents / this.jitRms, 0.2);
    this.glide(JIT_A, n.jitAmp.gain, T.jitAmp / this.jitRms, 0.2);
    this.glide(NZ_F, n.nzBp.frequency, T.noiseFreq, 0.08);
    this.glide(NZ_L, n.nzLevel.gain, T.noiseLevel, 0.06);
    // (the turbo spools up slowly and runs down faster)
    const spool = p.turbo ? p.turbo.spool : 0.5;
    const rising = !(T.turboLevel < this.sent[TB_L]);
    this.glide(TB_F, n.turbo.frequency, T.turboFreq, rising ? spool : spool * 0.5);
    this.glide(TB_L, n.turboLevel.gain, T.turboLevel, rising ? spool * 0.7 : spool * 0.35);
    this.glide(TA_F, n.toneA.frequency, T.toneAFreq, 0.05);
    this.glide(TA_L, n.toneALevel.gain, T.toneALevel, 0.06);
    this.glide(TB2_F, n.toneB.frequency, T.toneBFreq, 0.05);
    this.glide(TB2_L, n.toneBLevel.gain, T.toneBLevel, 0.06);
    this.glide(RD_C, n.roadLp.frequency, T.roadCutoff, 0.1);
    this.glide(RD_L, n.roadLevel.gain, T.roadLevel, 0.1);
    this.glide(WD_F, n.windBp.frequency, T.windFreq, 0.15);
    this.glide(WD_L, n.windLevel.gain, T.windLevel, 0.15);
    this.glide(SK_F, n.skidBp.frequency, T.skidFreq, 0.1);
    this.glide(SK_L, n.skidLevel.gain, T.skidLevel, p.squeal ? 0.08 : 0.04);
    this.glide(HORN, n.hornLevel.gain, T.hornLevel, 0.015);
    this.glide(START, n.starterLevel.gain, T.starterLevel, 0.02);

    // the indicator relay
    if (s.indicatorOn && s.blinkOn !== this.lastBlink) this.click(s.blinkOn ? 'tick' : 'tock');
    this.lastBlink = s.blinkOn;
    // the tram's bell: struck as it is pressed, and again and again while it is held
    if (p.bell && s.horn && (!this.lastHorn || t >= this.nextBell)) {
      this.strike(t);
      this.nextBell = t + 0.32;
    }
    this.lastHorn = s.horn;
    if (p.air) this.airBrakes(s, t);
    // the reversing alarm: a beep a second
    if (p.beeper) {
      if (s.reversing && s.engineRunning) {
        if (t >= this.nextBeep) {
          this.beep(t);
          this.nextBeep = t + 1;
        }
      } else this.nextBeep = 0;
    }
    this.lastRough = s.rough;
    this.lastSpeed = Math.abs(s.speed) || 0;
  }

  /** Sets up the voices for the vehicle now set (the waves, the filters, the horn …) – while they are silenced. */
  private applyVehicle(): void {
    const n = this.n;
    if (!n) return;
    const ctx = n.ctx;
    const t = ctx.currentTime;
    const v = this.voice;
    const p = v.profile;
    n.bus.gain.cancelScheduledValues(t);
    n.bus.gain.setValueAtTime(0, t);
    n.bus.gain.setTargetAtTime(1, t + 0.08, 0.05);
    for (const g of [n.gSoft, n.gHard, n.mainLevel, n.nzLevel, n.turboLevel, n.toneALevel, n.toneBLevel, n.roadLevel, n.windLevel, n.skidLevel, n.hornLevel, n.starterLevel, n.hissLevel]) {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(0, t);
    }
    this.sent.fill(NaN);
    if (v.soft && v.hard) {
      // (normalised already – peak 1 – so that browsers that normalise again change nothing)
      n.oscSoft.setPeriodicWave(ctx.createPeriodicWave(v.soft.real, v.soft.imag, { disableNormalization: true }));
      n.oscHard.setPeriodicWave(ctx.createPeriodicWave(v.hard.real, v.hard.imag, { disableNormalization: true }));
    }
    const m = p.main;
    if (m) {
      n.mainLp.Q.value = m.lpQ;
      n.mainBody.frequency.value = m.body[0];
      n.mainBody.Q.value = m.body[1];
      n.mainBody.gain.value = m.body[2];
    }
    const nz = p.noise;
    n.nzBp.Q.value = nz ? nz.q : 1;
    n.nzAm.gain.value = nz ? 1 - nz.am : 1;
    n.nzDepth.gain.value = nz ? nz.am : 0;
    if (p.road) n.roadLp.Q.value = p.road.q;
    if (p.wind) n.windBp.Q.value = p.wind.q;
    n.skidBp.Q.value = p.squeal ? p.squeal.q : (p.skid?.q ?? 6);
    n.jitSqueal.gain.value = p.squeal ? p.squeal.wobble / this.jitRms : 0;
    n.toneA.type = p.stallHorn ? 'triangle' : (p.tones[0]?.wave ?? 'sine');
    n.toneB.type = p.tones[1]?.wave ?? 'sine';
    if (p.horn) {
      n.horn1.type = p.horn.wave;
      n.horn2.type = p.horn.wave;
      n.horn1.frequency.value = p.horn.f[0];
      n.horn2.frequency.value = p.horn.f[1];
      n.hornLp.frequency.value = p.horn.lp;
    }
    if (p.starter) {
      n.starter.frequency.value = p.starter.f;
      n.starterLfo.frequency.value = p.starter.lfo;
      n.starterDepth.gain.value = p.starter.depth;
    }
    // (a drive begins with the parking brake on: that is no "pssht")
    this.lastPark = null;
    this.brakeHeld = 0;
    this.purgeAt = 0;
    this.nextBeep = 0;
    this.lastHorn = false;
  }

  /** Whether a setting has moved enough to be sent again (and remembers it if so). */
  private changed(i: number, v: number): boolean {
    const last = this.sent[i];
    if (Math.abs(v - last) <= 1e-4 + Math.abs(last) * 0.003) return false;
    this.sent[i] = v;
    return true;
  }

  private glide(i: number, param: AudioParam, v: number, tc: number): void {
    if (this.changed(i, v)) param.setTargetAtTime(v, this.now, tc);
  }

  /** Air brakes: "pssht" as the parking brake is set, a puff as the brake is let go, the air dryer now and then. */
  private airBrakes(s: AudioState, t: number): void {
    if (s.parkingBrake !== undefined) {
      if (this.lastPark !== null && s.parkingBrake !== this.lastPark) {
        if (s.parkingBrake) this.hiss(3, 0.25, 0.28, 4200, 2600);
        else this.hiss(-10, 0.1, 0.12, 3800, 3000);
      }
      this.lastPark = s.parkingBrake;
    }
    const b = s.braking ?? 0;
    if (b > 0.12) this.brakeHeld = Math.max(this.brakeHeld, b);
    else if (b < 0.04 && this.brakeHeld > 0) {
      if (this.brakeHeld > 0.15 && t >= this.nextPuff) {
        this.hiss(-12 + 6 * Math.min(1, this.brakeHeld), 0.05, 0.12, 4500, 3000);
        this.nextPuff = t + 0.8;
      }
      this.brakeHeld = 0;
    }
    // (the compressor has filled the tanks: the dryer blows out – every minute or two while the engine runs)
    if (s.engineRunning) {
      if (this.purgeAt === 0) this.purgeAt = t + 40 + 60 * Math.random();
      else if (t >= this.purgeAt) {
        this.hiss(0, 0.5, 0.35, 3600, 2400);
        this.purgeAt = t + 70 + 90 * Math.random();
      }
    } else this.purgeAt = 0;
  }

  /** A hiss of air on the vehicle's own hiss voice: loudness (dB against the reference), held (s), dying away (s), its pitch sinking from → to (Hz). */
  private hiss(db: number, hold: number, decay: number, from: number, to: number): void {
    const n = this.n;
    if (!n) return;
    const t = n.ctx.currentTime;
    const g = n.hissLevel.gain;
    const f = n.hissBp.frequency;
    const level = 10 ** (db / 20) * this.hissUnit;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(level, t + 0.015);
    g.setTargetAtTime(0, t + 0.015 + hold, decay);
    f.cancelScheduledValues(t);
    f.setValueAtTime(from, t);
    f.setTargetAtTime(to, t + 0.05, hold + decay);
  }

  /** A burst of filtered noise at time t. */
  private noiseHit(t: number, type: BiquadFilterType, freq: number, q: number, level: number, dur: number): void {
    const n = this.n;
    if (!n) return;
    const ctx = n.ctx;
    const src = ctx.createBufferSource();
    src.buffer = n.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(n.master);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  /** The tram's bell struck once: a dome bell's partials, the higher dying sooner, and the knock of the hammer. */
  private strike(t: number): void {
    const n = this.n;
    if (!n) return;
    const ctx = n.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.12;
    out.connect(n.bus);
    for (const [ratio, a, tc] of BELL) {
      const o = ctx.createOscillator();
      o.frequency.value = 1040 * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(a, t + 0.002);
      g.gain.setTargetAtTime(0, t + 0.002, tc);
      o.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + tc * 7);
    }
    this.noiseHit(t, 'bandpass', 3200, 2, 0.12, 0.012);
  }

  /** One beep of a reversing alarm, as heard from the cab. */
  private beep(t: number): void {
    const n = this.n;
    if (!n) return;
    const ctx = n.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 1150;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1150;
    f.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.035, t + 0.01);
    g.gain.setValueAtTime(0.035, t + 0.42);
    g.gain.linearRampToValueAtTime(0, t + 0.45);
    o.connect(f);
    f.connect(g);
    g.connect(n.bus);
    o.start(t);
    o.stop(t + 0.5);
  }
}
