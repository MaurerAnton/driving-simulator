// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The bell of a level crossing (src/sim/levelcrossing.ts): the bright,
 * quickly repeated strokes of the electric bell that rings while the
 * lights come on and the barriers go down – louder the nearer the listener
 * is.  Each stroke is two partials of a struck bell, dying away; made in
 * the game's audio graph (audio/audio.ts), nothing is downloaded.
 */
import type { AudioOut } from './crowd.ts';

/** how far a bell is heard at all (m) */
const HEARD = 180;
/** strokes a second */
const RATE = 3.2;

export class CrossingBell {
  private readonly out: AudioOut;
  private next = 0;

  constructor(out: AudioOut) {
    this.out = out;
  }

  /** Each frame: `dist` from the listener to the nearest bell that rings (m; Infinity: none). */
  update(dist: number): void {
    const ctx = this.out.context;
    const master = this.out.masterGain;
    if (!ctx || !master || ctx.state !== 'running' || dist >= HEARD) return;
    const level = 0.11 * Math.min(1, 14 / Math.max(dist, 4));
    const now = ctx.currentTime;
    if (this.next < now) this.next = now + 0.02;
    // (the strokes due within the next quarter of a second, each at its time)
    while (this.next < now + 0.25) {
      this.stroke(ctx, master, this.next, level);
      this.next += 1 / RATE;
    }
  }

  private stroke(ctx: AudioContext, master: GainNode, t0: number, level: number): void {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.28);
    g.connect(master);
    const parts: OscillatorNode[] = [];
    for (const [f, a] of [
      [1480, 1],
      [3960, 0.35],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const pg = ctx.createGain();
      pg.gain.value = a;
      o.connect(pg).connect(g);
      o.start(t0);
      o.stop(t0 + 0.3);
      parts.push(o);
    }
    parts[0].onended = () => {
      for (const o of parts) o.disconnect();
      g.disconnect();
    };
  }
}
