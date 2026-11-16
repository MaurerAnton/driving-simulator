// SPDX-License-Identifier: AGPL-3.0-only
/**
 * All sound is synthesised with the Web Audio API – engine, tyres, wind,
 * indicator relay, horn, starter – so no audio files are shipped.
 */

export interface AudioState {
  rpm: number;
  /** 0 … 1 engine load (throttle) */
  load: number;
  engineRunning: boolean;
  starter: boolean;
  /** m/s */
  speed: number;
  /** 0 … 1 tyre squeal */
  skid: number;
  indicatorOn: boolean;
  blinkOn: boolean;
  horn: boolean;
  /** surface roughness for road noise (1 asphalt … 3 gravel) */
  rough: number;
}

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engOsc: OscillatorNode[] = [];
  private engGain!: GainNode;
  private engFilter!: BiquadFilterNode;
  private noiseBuf!: AudioBuffer;
  private roadGain!: GainNode;
  private roadFilter!: BiquadFilterNode;
  private skidGain!: GainNode;
  private hornGain!: GainNode;
  private starterGain!: GainNode;
  private lastBlink = false;
  volume = 0.7;

  /** Must be called from a user gesture (click / key) – browsers require it. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // white noise, reused by several voices
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      d[i] = (seed / 4294967296) * 2 - 1;
    }
    const noise = (): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      s.start();
      return s;
    };

    // engine: firing order fundamental plus two partials through a low-pass that opens with revs
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 1.2;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter.connect(this.engGain).connect(this.master);
    const types: OscillatorType[] = ['sawtooth', 'square', 'sawtooth'];
    const levels = [0.5, 0.22, 0.28];
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = types[i];
      const g = ctx.createGain();
      g.gain.value = levels[i];
      o.connect(g).connect(this.engFilter);
      o.start();
      this.engOsc.push(o);
    }
    const intake = ctx.createGain();
    intake.gain.value = 0.12;
    noise().connect(intake).connect(this.engFilter);

    // road + wind
    this.roadFilter = ctx.createBiquadFilter();
    this.roadFilter.type = 'lowpass';
    this.roadGain = ctx.createGain();
    this.roadGain.gain.value = 0;
    noise().connect(this.roadFilter).connect(this.roadGain).connect(this.master);

    // tyre squeal
    const skidFilter = ctx.createBiquadFilter();
    skidFilter.type = 'bandpass';
    skidFilter.frequency.value = 1150;
    skidFilter.Q.value = 6;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    noise().connect(skidFilter).connect(this.skidGain).connect(this.master);

    // horn: two tones
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    this.hornGain.connect(this.master);
    for (const f of [415, 520]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      o.connect(lp).connect(this.hornGain);
      o.start();
    }

    // starter motor: buzzing whirr
    this.starterGain = ctx.createGain();
    this.starterGain.gain.value = 0;
    const so = ctx.createOscillator();
    so.type = 'sawtooth';
    so.frequency.value = 88;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 22;
    lfo.connect(lfoGain).connect(so.frequency);
    so.connect(this.starterGain).connect(this.master);
    so.start();
    lfo.start();
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Short percussive sounds. */
  click(kind: 'tick' | 'tock' | 'crash' | 'grind' | 'chime' | 'bump' | 'door' | 'doorShut' | 'step'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (kind === 'chime') {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(880, t);
      o.frequency.setValueAtTime(660, t + 0.12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.45);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    let dur = 0.03;
    if (kind === 'tick' || kind === 'tock') {
      f.type = 'bandpass';
      f.frequency.value = kind === 'tick' ? 2600 : 1900;
      f.Q.value = 4;
      g.gain.setValueAtTime(0.35, t);
    } else if (kind === 'crash') {
      f.type = 'lowpass';
      f.frequency.value = 900;
      dur = 0.5;
      g.gain.setValueAtTime(1.0, t);
    } else if (kind === 'bump') {
      f.type = 'lowpass';
      f.frequency.value = 220;
      dur = 0.12;
      g.gain.setValueAtTime(0.7, t);
    } else if (kind === 'door') {
      // the latch of a door that opens
      f.type = 'bandpass';
      f.frequency.value = 1150;
      f.Q.value = 3;
      dur = 0.07;
      g.gain.setValueAtTime(0.5, t);
    } else if (kind === 'doorShut') {
      f.type = 'lowpass';
      f.frequency.value = 320;
      dur = 0.2;
      g.gain.setValueAtTime(1.0, t);
    } else if (kind === 'step') {
      f.type = 'lowpass';
      f.frequency.value = 600;
      dur = 0.05;
      g.gain.setValueAtTime(0.12, t);
    } else {
      f.type = 'bandpass';
      f.frequency.value = 1700;
      f.Q.value = 1.5;
      dur = 0.28;
      g.gain.setValueAtTime(0.4, t);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  update(s: AudioState): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const rpm = Math.max(s.rpm, 0);
    // four-stroke four-cylinder: two ignitions per revolution
    const f0 = Math.max(20, rpm / 30);
    this.engOsc[0].frequency.setTargetAtTime(f0, t, 0.03);
    this.engOsc[1].frequency.setTargetAtTime(f0 * 0.5, t, 0.03);
    this.engOsc[2].frequency.setTargetAtTime(f0 * 2.01, t, 0.03);
    const turning = rpm > 120;
    const level = turning ? (s.engineRunning ? 0.05 + 0.1 * s.load + (rpm / 7000) * 0.08 : 0.03) : 0;
    this.engGain.gain.setTargetAtTime(level, t, 0.05);
    this.engFilter.frequency.setTargetAtTime(260 + rpm * 0.33 + s.load * 900, t, 0.05);
    const v = Math.abs(s.speed);
    this.roadGain.gain.setTargetAtTime(Math.min(0.22, v * 0.0045 * s.rough), t, 0.1);
    this.roadFilter.frequency.setTargetAtTime(300 + v * 28 * s.rough, t, 0.1);
    this.skidGain.gain.setTargetAtTime(s.skid * 0.3, t, 0.04);
    this.hornGain.gain.setTargetAtTime(s.horn ? 0.16 : 0, t, 0.015);
    this.starterGain.gain.setTargetAtTime(s.starter && !s.engineRunning ? 0.12 : 0, t, 0.02);
    if (s.indicatorOn && s.blinkOn !== this.lastBlink) this.click(s.blinkOn ? 'tick' : 'tock');
    this.lastBlink = s.blinkOn;
  }
}
