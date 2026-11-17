// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plays the music that compose.ts makes up – off unless the player asks
 * for it; then now and then a piece, quietly, with pauses of a few minutes
 * between ('quiet'), or more often and a little louder ('on').
 *
 * Kept cheap for a phone: a handful of shared nodes (a bus per instrument,
 * a soft low-pass, an echo of two delays that bounce between left and right
 * and grow darker – far cheaper than a reverb), and per note one or two
 * oscillators with an envelope, made just before the note is due and
 * stopped as soon as it has died away. A timer looks a second or so ahead
 * four times a second and schedules what is due on the audio clock, so a
 * busy frame does not shift the beat. With the music off nothing of it
 * exists and nothing runs.
 */
import type { Instrument, MusicNote, Piece } from './compose.ts';
import { composePiece } from './compose.ts';
import { REF_LOUDNESS } from './profiles.ts';
import { aWeight } from './waves.ts';

export type MusicMode = 'off' | 'quiet' | 'on';

/** how each instrument sounds: its wave (FM: a sine modulated by another), peak (per unit of strength), how it dies away (s), held while the note is */
const VOICES: Record<Instrument, { wave: 'sine' | 'triangle'; peak: number; decay: number; held: boolean }> = {
  // a soft electric piano: a sine whose brightness (the modulation) fades fast
  bell: { wave: 'sine', peak: 0.11, decay: 0.9, held: false },
  // wood: a sine struck with a short, bright knock four times its pitch
  marimba: { wave: 'sine', peak: 0.12, decay: 0.3, held: false },
  pluck: { wave: 'triangle', peak: 0.09, decay: 0.45, held: false },
  // a flute-like lead with a slow vibrato
  flute: { wave: 'triangle', peak: 0.07, decay: 0.09, held: true },
  pad: { wave: 'triangle', peak: 0.045, decay: 0.5, held: true },
  bass: { wave: 'triangle', peak: 0.14, decay: 0.12, held: true },
};

/** where each instrument stands, left (−1) to right (1) */
const PAN: Record<Instrument, number> = { bell: 0.15, marimba: 0.2, pluck: -0.3, flute: -0.1, pad: 0, bass: 0 };
/** what goes into the echo */
const SEND: Record<Instrument, number> = { bell: 0.3, marimba: 0.25, pluck: 0.3, flute: 0.25, pad: 0.1, bass: 0 };

/** how far ahead notes are scheduled (s), and how often (ms) */
const LOOKAHEAD = 1.2;
const TICK_MS = 250;

/** The pause before the next piece (s): a few minutes now and then ('quiet'), under a minute 'on'. `r` is a random number 0 … 1. */
export function pauseAfter(mode: MusicMode, r: number): number {
  return mode === 'quiet' ? 150 + 180 * r : 25 + 45 * r;
}

/** How loud the music is, against the vehicles' reference (the car's engine at half load, dB(A)): well below it – 'quiet' still more. */
export const MUSIC_DB: Record<Exclude<MusicMode, 'off'>, number> = { quiet: -10, on: -5 };

/**
 * The gain that plays a piece as loud as the mode asks, at the player's music volume (0 … 1): every piece
 * equally loud, whether it has a busy accompaniment or only held chords.
 */
export function pieceGain(piece: Piece, mode: MusicMode, volume: number): number {
  if (mode === 'off') return 0;
  const v = Math.max(0, Math.min(1, volume));
  return (v * REF_LOUDNESS * 10 ** (MUSIC_DB[mode] / 20)) / Math.max(1e-6, pieceLoudness(piece, 1));
}

const midiHz = (p: number): number => 440 * 2 ** ((p - 69) / 12);

/**
 * How loud a piece is on average (A-weighted RMS) at a level – roughly, from
 * each note's energy (its envelope, its wave, its pitch) – for balancing the
 * music against the vehicles' sounds.
 */
export function pieceLoudness(piece: Piece, level: number): number {
  let energy = 0;
  for (const n of piece.notes) {
    const vc = VOICES[n.i];
    const a = vc.peak * n.v;
    // (held: the note's length at about its peak; struck: e^(−t/τ)² integrates to τ/2)
    const time = vc.held ? n.d + vc.decay / 2 : vc.decay / 2;
    const shape = vc.wave === 'sine' ? 0.5 : 1 / 3;
    const w = aWeight(midiHz(n.p));
    energy += a * a * shape * time * w * w;
  }
  return level * Math.sqrt(energy / piece.length);
}

/** A timer that does not keep Node alive (the tests); in a browser a plain one. */
function unref(h: unknown): void {
  if (typeof h === 'object' && h !== null && 'unref' in h && typeof (h as { unref: unknown }).unref === 'function') (h as { unref(): void }).unref();
}

interface MusicGraph {
  level: GainNode;
  inst: Record<Instrument, GainNode>;
  echoA: DelayNode;
  echoB: DelayNode;
  vibrato: OscillatorNode;
  vibratoDepth: GainNode;
  nodes: AudioNode[];
}

export class MusicPlayer {
  private readonly ctx: BaseAudioContext;
  private readonly dest: AudioNode;
  private readonly useTimer: boolean;
  private mode: MusicMode = 'off';
  private volume = 1;
  private g: MusicGraph | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private piece: Piece | null = null;
  /** when the piece began (audio clock), the next of its notes to schedule, when the next piece is due */
  private begun = 0;
  private next = 0;
  private nextPieceAt = 0;
  private seed: number;
  private lastKey = '';
  /** pieces begun (for the tests) */
  played = 0;

  /** `timer: false` leaves calling tick() to the caller (the tests). */
  constructor(ctx: BaseAudioContext, dest: AudioNode, opts: { timer?: boolean; seed?: number } = {}) {
    this.ctx = ctx;
    this.dest = dest;
    this.useTimer = opts.timer ?? true;
    this.seed = opts.seed ?? ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0);
  }

  get playing(): boolean {
    return this.piece !== null;
  }

  /** Off, now and then, or more often – and how loud (0 … 1). */
  set(mode: MusicMode, volume: number): void {
    const was = this.mode;
    this.mode = mode;
    this.volume = Math.max(0, Math.min(1, volume));
    if (mode === 'off') {
      this.stop();
      return;
    }
    const now = this.ctx.currentTime;
    if (!this.g) this.g = this.build();
    if (this.piece) this.g.level.gain.setTargetAtTime(pieceGain(this.piece, mode, this.volume), now, 0.3);
    // switched on: the first piece soon, so that one hears it is on; 'on' after 'quiet': no long wait
    if (was === 'off') this.nextPieceAt = now + 3 + 4 * Math.random();
    else if (mode === 'on') this.nextPieceAt = Math.min(this.nextPieceAt, now + pauseAfter('on', Math.random()));
    if (this.useTimer && this.timer === null) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
      unref(this.timer);
    }
  }

  /** Schedules the notes due within the next moment (the timer calls it). */
  tick(): void {
    const g = this.g;
    if (this.mode === 'off' || !g) return;
    const now = this.ctx.currentTime;
    if (!this.piece) {
      if (now < this.nextPieceAt) return;
      this.begin(now + 0.1);
    }
    const p = this.piece as Piece;
    const until = now + LOOKAHEAD;
    while (this.next < p.notes.length) {
      const n = p.notes[this.next];
      const t = this.begun + n.t;
      if (t >= until) break;
      this.next++;
      // (missed while the page was busy: left out rather than played in a heap)
      if (t < now - 0.05) continue;
      this.play(g, n, Math.max(t, now));
    }
    if (this.next >= p.notes.length && now > this.begun + p.length) {
      this.piece = null;
      this.nextPieceAt = now + pauseAfter(this.mode, Math.random());
    }
  }

  /** Stops for good (the game is closed). */
  dispose(): void {
    this.mode = 'off';
    this.stop();
  }

  private begin(at: number): void {
    // a new piece – not in the key and mode of the last one
    let piece = composePiece(this.seed++ >>> 0);
    for (let i = 0; i < 4 && `${piece.key}/${piece.mode}` === this.lastKey; i++) piece = composePiece(this.seed++ >>> 0);
    this.lastKey = `${piece.key}/${piece.mode}`;
    this.piece = piece;
    this.begun = at;
    this.next = 0;
    this.played++;
    // the echo in time with it: a dotted eighth
    const g = this.g as MusicGraph;
    const dt = (0.75 * 60) / piece.bpm;
    g.echoA.delayTime.setValueAtTime(dt, at);
    g.echoB.delayTime.setValueAtTime(dt, at);
    g.level.gain.setValueAtTime(pieceGain(piece, this.mode, this.volume), at);
  }

  private build(): MusicGraph {
    const ctx = this.ctx;
    const nodes: AudioNode[] = [];
    const keep = <T extends AudioNode>(n: T): T => {
      nodes.push(n);
      return n;
    };
    const level = keep(ctx.createGain());
    level.gain.value = 0;
    level.connect(this.dest);
    // (a gentle low-pass takes the edge off every instrument at once)
    const soft = keep(ctx.createBiquadFilter());
    soft.type = 'lowpass';
    soft.frequency.value = 5200;
    soft.Q.value = -3;
    soft.connect(level);
    const pan = (x: number): AudioNode => {
      if (typeof ctx.createStereoPanner !== 'function') return soft;
      const p = keep(ctx.createStereoPanner());
      p.pan.value = x;
      p.connect(soft);
      return p;
    };
    // the echo: two delays bouncing left and right, each pass darker and weaker
    const send = keep(ctx.createGain());
    const echoA = keep(ctx.createDelay(2));
    const echoB = keep(ctx.createDelay(2));
    const dark = keep(ctx.createBiquadFilter());
    dark.type = 'lowpass';
    dark.frequency.value = 2200;
    const backA = keep(ctx.createGain());
    const backB = keep(ctx.createGain());
    backA.gain.value = 0.38;
    backB.gain.value = 0.38;
    echoA.delayTime.value = 0.5;
    echoB.delayTime.value = 0.5;
    send.connect(echoA);
    echoA.connect(dark);
    dark.connect(backA);
    backA.connect(echoB);
    echoB.connect(backB);
    backB.connect(echoA);
    dark.connect(pan(-0.6));
    echoB.connect(pan(0.6));
    const inst = {} as Record<Instrument, GainNode>;
    for (const i of Object.keys(VOICES) as Instrument[]) {
      const bus = keep(ctx.createGain());
      bus.connect(pan(PAN[i]));
      if (SEND[i] > 0) {
        const s = keep(ctx.createGain());
        s.gain.value = SEND[i];
        bus.connect(s);
        s.connect(send);
      }
      inst[i] = bus;
    }
    // one slow vibrato shared by every flute note
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 5.1;
    const vibratoDepth = keep(ctx.createGain());
    vibratoDepth.gain.value = 9;
    vibrato.connect(vibratoDepth);
    vibrato.start();
    nodes.push(vibrato);
    return { level, inst, echoA, echoB, vibrato, vibratoDepth, nodes };
  }

  private stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.piece = null;
    const g = this.g;
    this.g = null;
    if (!g) return;
    const now = this.ctx.currentTime;
    g.level.gain.cancelScheduledValues(now);
    g.level.gain.setTargetAtTime(0, now, 0.25);
    // (faded out, then taken apart: notes already scheduled die into nothing)
    const h = setTimeout(() => {
      try {
        g.vibrato.stop();
      } catch {
        // (already stopped)
      }
      for (const n of g.nodes) n.disconnect();
    }, 1500);
    unref(h);
  }

  /** One note: one or two oscillators and an envelope, stopped once it has died away. */
  private play(g: MusicGraph, n: MusicNote, t: number): void {
    const ctx = this.ctx;
    const vc = VOICES[n.i];
    const f = midiHz(n.p);
    const peak = vc.peak * n.v;
    const out = g.inst[n.i];
    const o = ctx.createOscillator();
    o.type = vc.wave;
    o.frequency.value = f;
    const a = ctx.createGain();
    const env = a.gain;
    env.setValueAtTime(0, t);
    let end: number;
    if (n.i === 'bell' || n.i === 'marimba') {
      // FM: a modulator at 2× (the piano) or 4× (the wooden bar), its depth fading fast – a bright strike that mellows
      const ratio = n.i === 'bell' ? 2 : 4;
      const m = ctx.createOscillator();
      m.frequency.value = f * ratio;
      const depth = ctx.createGain();
      const dev = f * ratio * (n.i === 'bell' ? 1.6 : 1.2);
      depth.gain.setValueAtTime(dev, t);
      depth.gain.setTargetAtTime(dev * 0.12, t, n.i === 'bell' ? 0.25 : 0.03);
      m.connect(depth);
      depth.connect(o.frequency);
      env.linearRampToValueAtTime(peak, t + 0.004);
      env.setTargetAtTime(0, t + 0.004, vc.decay);
      end = t + vc.decay * 6;
      m.start(t);
      m.stop(end);
    } else if (n.i === 'pluck') {
      env.linearRampToValueAtTime(peak, t + 0.004);
      env.setTargetAtTime(0, t + 0.004, vc.decay);
      end = t + vc.decay * 6;
    } else if (n.i === 'flute') {
      env.linearRampToValueAtTime(peak, t + 0.07);
      env.setTargetAtTime(peak * 0.8, t + 0.07, 0.3);
      env.setTargetAtTime(0, t + n.d, vc.decay);
      end = t + n.d + vc.decay * 7;
      g.vibratoDepth.connect(o.detune);
      o.onended = () => {
        try {
          g.vibratoDepth.disconnect(o.detune);
        } catch {
          // (the graph was taken apart already)
        }
      };
    } else if (n.i === 'pad') {
      // (a slow swell, a little detuned against its neighbours: a soft chorus)
      o.detune.value = (Math.random() - 0.5) * 14;
      env.linearRampToValueAtTime(peak, t + Math.min(0.9, n.d / 2));
      env.setTargetAtTime(0, t + n.d, vc.decay);
      end = t + n.d + vc.decay * 7;
    } else {
      env.linearRampToValueAtTime(peak, t + 0.01);
      env.setTargetAtTime(peak * 0.55, t + 0.01, 0.5);
      env.setTargetAtTime(0, t + n.d, vc.decay);
      end = t + n.d + vc.decay * 7;
    }
    o.connect(a);
    a.connect(out);
    o.start(t);
    o.stop(end);
  }
}
