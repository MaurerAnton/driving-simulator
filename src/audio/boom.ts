// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The bang of a vehicle going up in flames: a hard crack, a deep thump
 * that rolls on, and the roar and crackle of the fire dying down – made of
 * filtered noise and a falling sine, nothing recorded.  It plays in the
 * game's AudioContext, into its master gain (the game's volume).
 */

/** Play the bang now; `level` 0…1 (how near it was). */
export function playBoom(ctx: AudioContext, out: AudioNode, level = 1): void {
  const t0 = ctx.currentTime + 0.01;
  const len = 4;
  // white noise, once, for the crack and the roar
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * len), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  // the crack: bright noise, gone in a tenth of a second
  const crack = ctx.createBufferSource();
  crack.buffer = buf;
  const crackGain = ctx.createGain();
  const crackHp = ctx.createBiquadFilter();
  crackHp.type = 'highpass';
  crackHp.frequency.value = 900;
  crackGain.gain.setValueAtTime(0.9 * level, t0);
  crackGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
  crack.connect(crackHp).connect(crackGain).connect(out);
  crack.start(t0);
  crack.stop(t0 + 0.2);

  // the thump: a sine falling from 90 to 30 Hz
  const thump = ctx.createOscillator();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(90, t0);
  thump.frequency.exponentialRampToValueAtTime(30, t0 + 0.9);
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.0001, t0);
  thumpGain.gain.exponentialRampToValueAtTime(1.1 * level, t0 + 0.02);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.4);
  thump.connect(thumpGain).connect(out);
  thump.start(t0);
  thump.stop(t0 + 1.5);

  // the roar: low noise that swells and dies away, the fire crackling in it
  const roar = ctx.createBufferSource();
  roar.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1800, t0);
  lp.frequency.exponentialRampToValueAtTime(260, t0 + len - 0.2);
  const roarGain = ctx.createGain();
  roarGain.gain.setValueAtTime(0.0001, t0);
  roarGain.gain.exponentialRampToValueAtTime(0.75 * level, t0 + 0.05);
  roarGain.gain.exponentialRampToValueAtTime(0.002, t0 + len - 0.1);
  roar.connect(lp).connect(roarGain).connect(out);
  roar.start(t0);
  roar.stop(t0 + len);
}
