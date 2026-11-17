// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The sound of a march (sim/roadevents.ts): the murmur of the crowd and,
 * now and then, a whistle – a trilling pea whistle, as at any
 * demonstration – louder the nearer the listener is.  Made from noise and
 * an oscillator in the game's audio graph (audio/audio.ts); nothing is
 * downloaded.
 */

/** What of the game's audio is used: its context and the gain everything goes through. */
export interface AudioOut {
  readonly context: AudioContext | null;
  readonly masterGain: GainNode | null;
}

/** how far a march is heard at all (m) */
const HEARD = 320;

export class CrowdNoise {
  private readonly out: AudioOut;
  private murmur: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private quiet = 0;

  constructor(out: AudioOut) {
    this.out = out;
  }

  /**
   * Each frame: `dist` from the listener to the nearest crowd (m; Infinity:
   * none), how many walk in it, whether it is marching.
   */
  update(dt: number, dist: number, size: number, walking: boolean): void {
    const ctx = this.out.context;
    const master = this.out.masterGain;
    if (!ctx || !master || ctx.state !== 'running') return;
    const near = dist < HEARD ? Math.min(1, 22 / Math.max(dist, 6)) : 0;
    const loud = near * Math.min(1.4, Math.sqrt(size / 100));
    // the murmur: started when a crowd comes within hearing, faded out and stopped a while after it is gone
    if (loud > 0 && !this.murmur) this.murmur = this.startMurmur(ctx, master);
    const m = this.murmur;
    if (m) {
      m.gain.gain.setTargetAtTime(0.09 * loud, ctx.currentTime, 0.4);
      this.quiet = loud > 0 ? 0 : this.quiet + dt;
      if (this.quiet > 3) {
        m.src.stop();
        m.src.disconnect();
        m.gain.disconnect();
        this.murmur = null;
      }
    }
    // the whistles: about one a second from a crowd of a hundred on the march, fewer at the rally
    if (loud > 0 && Math.random() < dt * (size / 110) * (walking ? 1 : 0.55)) this.whistle(ctx, master, 0.05 * loud);
  }

  private startMurmur(ctx: AudioContext, master: GainNode): { src: AudioBufferSourceNode; gain: GainNode } {
    // brown-ish noise: many voices far apart blur into it
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.06 * (Math.random() * 2 - 1)) / 1.06;
      d[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 420;
    band.Q.value = 0.6;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(band).connect(gain).connect(master);
    src.start();
    return { src, gain };
  }

  /** One blast of a pea whistle: a high tone trilling fast, short – sometimes two. */
  private whistle(ctx: AudioContext, master: GainNode, level: number): void {
    const t = ctx.currentTime + 0.02;
    const blasts = Math.random() < 0.3 ? 2 : 1;
    for (let b = 0; b < blasts; b++) {
      const t0 = t + b * 0.42;
      const dur = 0.18 + Math.random() * 0.45;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 2700 + Math.random() * 700;
      // (the pea rattles: the pitch trills some thirty times a second)
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 26 + Math.random() * 10;
      const depth = ctx.createGain();
      depth.gain.value = 120 + Math.random() * 90;
      lfo.connect(depth).connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(level, t0 + 0.02);
      g.gain.setValueAtTime(level, t0 + dur - 0.05);
      g.gain.linearRampToValueAtTime(0, t0 + dur);
      o.connect(g).connect(master);
      o.start(t0);
      lfo.start(t0);
      o.stop(t0 + dur + 0.02);
      lfo.stop(t0 + dur + 0.02);
      o.onended = () => {
        o.disconnect();
        lfo.disconnect();
        depth.disconnect();
        g.disconnect();
      };
    }
  }
}
