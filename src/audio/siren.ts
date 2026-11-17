// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The two-tone horn of the emergency vehicles – the German Einsatzhorn
 * ("Martinshorn"): two tones a pure fourth apart in turn, here a′ and d″
 * (440 and 587 Hz), within the range the standard (DIN 14610) allows.  Made
 * with the Web Audio API like every other sound of the game: two horns tuned
 * a little apart (they beat against each other), brassy, louder the nearer
 * it is, duller far away and through the walls of a closed cab, from the
 * side it comes from – and higher while it comes nearer, lower as it goes
 * away (the Doppler effect).
 *
 * It plays in the game's AudioContext (src/audio/audio.ts hands it out);
 * every frame the game passes the traffic's cars – those of them on a call
 * sound (src/sim/emergency.ts) – and where the listener is.
 */
import type { TrafficCar } from '../sim/traffic.ts';

/** the two tones (Hz): a′ and d″, a pure fourth */
export const SIREN_LOW = 440;
export const SIREN_HIGH = 587.33;
/** how long each of the two tones lasts (s) */
export const SIREN_TONE = 0.7;
const SOUND_SPEED = 343;
/** at most this many horns are heard at once (the nearest) */
const VOICES = 3;

/** The tone of a horn `t` seconds into its play (Hz, before the Doppler effect): the high one first, then the low one. */
export function sirenTone(t: number, pitch = 1): number {
  const round = 2 * SIREN_TONE;
  const ph = ((t % round) + round) % round;
  return (ph < SIREN_TONE ? SIREN_HIGH : SIREN_LOW) * pitch;
}

/**
 * How much higher a sound is heard than it is made (the Doppler effect):
 * the source comes towards the listener at `source` m/s, the listener goes
 * towards the source at `listener` m/s (negative: away).
 */
export function doppler(source: number, listener: number): number {
  const s = Math.max(-80, Math.min(80, source));
  const l = Math.max(-80, Math.min(80, listener));
  return (SOUND_SPEED + l) / (SOUND_SPEED - s);
}

/** How loud a horn is heard `d` metres away (1 within 12 m, then 6 dB less for each doubling of the distance). */
export function sirenLevel(d: number): number {
  return 12 / Math.max(12, d);
}

/** Where the listener is: the camera (its position, and its turn in matrixWorld – x its right, z its back). */
export interface SirenEar {
  position: { x: number; y: number; z: number };
  matrixWorld: { elements: ArrayLike<number> };
}

interface Voice {
  osc: OscillatorNode[];
  body: BiquadFilterNode;
  dull: BiquadFilterNode;
  level: GainNode;
  pan: StereoPannerNode | null;
  /** its own place in the rhythm and its pitch (the vehicle's) */
  phase: number;
  pitch: number;
  /** seconds it has not been heard (it is taken down after a while) */
  quiet: number;
}

export class Sirens {
  private readonly voices = new Map<number, Voice>();
  private readonly near: Array<{ car: TrafficCar; d: number }> = [];
  private readonly heard = new Set<number>();
  private last = 0;

  /**
   * Every frame: the cars of the traffic (those on a call sound), the
   * listener, whether the listener sits in a closed cab, and how the
   * listener moves (m/s, x and z).  Nothing happens before the game's sound
   * is started (`ctx` null) or while it is suspended.
   */
  update(ctx: AudioContext | null, out: AudioNode | null, cars: readonly TrafficCar[], ear: SirenEar, inside: boolean, vx = 0, vz = 0): void {
    if (!ctx || !out || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const dt = Math.min(0.25, Math.max(0, now - this.last));
    this.last = now;
    const ex = ear.position.x;
    const ez = ear.position.z;
    const near = this.near;
    near.length = 0;
    for (const car of cars) {
      if (!car.em?.call) continue;
      const d = Math.hypot(car.x - ex, car.z - ez);
      if (d < 1200) near.push({ car, d });
    }
    near.sort((a, b) => a.d - b.d);
    if (near.length > VOICES) near.length = VOICES;
    // the listener's right, along the ground (the camera's x axis)
    const m = ear.matrixWorld.elements;
    const rl = Math.hypot(m[0], m[2]) || 1;
    const rx = m[0] / rl;
    const rz = m[2] / rl;
    const heard = this.heard;
    heard.clear();
    for (const { car, d } of near) {
      const em = car.em;
      if (!em) continue;
      heard.add(car.id);
      let v = this.voices.get(car.id);
      if (!v) {
        v = this.voice(ctx, out, em.phase, em.pitch);
        this.voices.set(car.id, v);
      }
      v.quiet = 0;
      const dist = Math.max(0.5, d);
      // from the horn to the listener
      const ux = (ex - car.x) / dist;
      const uz = (ez - car.z) / dist;
      // (the horn coming towards the listener, the listener towards the horn: m/s)
      const source = (-Math.sin(car.yaw) * ux - Math.cos(car.yaw) * uz) * car.v;
      const listener = -(vx * ux + vz * uz);
      const f = sirenTone(now + v.phase, v.pitch) * doppler(source, listener);
      v.osc[0].frequency.setTargetAtTime(f, now, 0.01);
      v.osc[1].frequency.setTargetAtTime(f * 1.007, now, 0.01);
      v.level.gain.setTargetAtTime(sirenLevel(dist) * (inside ? 0.12 : 0.22), now, 0.06);
      // far away the high notes are lost; through the walls of a closed cab more so
      v.dull.frequency.setTargetAtTime((inside ? 2400 : 9000) / (1 + dist / 220), now, 0.1);
      if (v.pan) v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, ((car.x - ex) * rx + (car.z - ez) * rz) / dist)) * 0.8, now, 0.05);
    }
    // the horns no longer heard: quiet, and after a while taken down
    for (const [id, v] of this.voices) {
      if (heard.has(id)) continue;
      v.level.gain.setTargetAtTime(0, now, 0.15);
      v.quiet += dt;
      if (v.quiet > 1.5) {
        for (const o of v.osc) {
          o.stop();
          o.disconnect();
        }
        (v.pan ?? v.level).disconnect();
        this.voices.delete(id);
      }
    }
  }

  /** One horn: two oscillators tuned a little apart, a brassy peak, a low-pass for the distance, its loudness and its side. */
  private voice(ctx: AudioContext, out: AudioNode, phase: number, pitch: number): Voice {
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    const osc: OscillatorNode[] = [];
    for (const type of ['sawtooth', 'square'] as OscillatorType[]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = SIREN_HIGH * pitch;
      const g = ctx.createGain();
      g.gain.value = type === 'square' ? 0.35 : 0.65;
      o.connect(g).connect(mix);
      o.start();
      osc.push(o);
    }
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 1350;
    body.Q.value = 1.1;
    body.gain.value = 7;
    const dull = ctx.createBiquadFilter();
    dull.type = 'lowpass';
    dull.frequency.value = 6000;
    dull.Q.value = 0.7;
    const level = ctx.createGain();
    level.gain.value = 0;
    mix.connect(body).connect(dull).connect(level);
    let pan: StereoPannerNode | null = null;
    if (typeof ctx.createStereoPanner === 'function') {
      pan = ctx.createStereoPanner();
      level.connect(pan).connect(out);
    } else level.connect(out);
    return { osc, body, dull, level, pan, phase, pitch, quiet: 0 };
  }

  /** Silence every horn at once (the drive is over). */
  stop(): void {
    for (const v of this.voices.values()) {
      for (const o of v.osc) {
        o.stop();
        o.disconnect();
      }
      (v.pan ?? v.level).disconnect();
    }
    this.voices.clear();
  }
}
