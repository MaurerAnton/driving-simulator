// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The periodic part of a vehicle's sound, as one wave period of partials –
 * what the Web Audio API's PeriodicWave takes. It is worked out once per
 * vehicle, so that while driving the oscillators only have to play it at the
 * right speed:
 *
 *  - an engine: the pressure pulses of its cylinders in the exhaust, one per
 *    firing, at the crank angles its layout fires at (an inline four every
 *    180°, a parallel twin at 0° and 270°, a single every other turn). One
 *    period is a whole cycle (two turns of the crank for a four-stroke), so
 *    that the small differences between the cylinders – drawn once, the same
 *    in every cycle, as in a real engine – give the half orders that make an
 *    engine sound like one and not like a buzzer;
 *  - a propeller or an electric motor: chosen orders of its turning.
 *
 * Here too is what the loudness of the vehicles is balanced with: the
 * responses of the filters the sound goes through and the A-weighting of
 * the ear. Nothing here needs an AudioContext.
 */

/** The partials of one wave period as createPeriodicWave takes them: cosine (real) and sine (imag) amplitudes; index 0, the mean, stays 0. */
export interface Partials {
  readonly real: Float32Array;
  readonly imag: Float32Array;
}

/** An engine's exhaust: one pressure pulse per firing. */
export interface PulseWave {
  kind: 'pulses';
  /** the crank angles the cylinders fire at within the period (degrees) */
  firing: readonly number[];
  /** how strongly each fires (1 if not said) – a two-stroke at idle fires properly only every other turn */
  amps?: readonly number[];
  /** the pulse: how fast its pressure rises and how slowly it dies away (time constants, crank degrees) – the shorter, the brighter */
  rise: number;
  decay: number;
  /** no two cylinders are quite alike: random differences of strength (share) and of timing (crank degrees), drawn once */
  spread: number;
  skew: number;
}

/** A turning machine heard at chosen orders of its turning: [order, amplitude]. */
export interface OrderWave {
  kind: 'orders';
  orders: ReadonlyArray<readonly [number, number]>;
  /** random phases (separate sources, as a motor's whines and its gears) – else all in phase, a pulse once a period (a propeller's blades) */
  scatter?: boolean;
}

export type WaveSpec = PulseWave | OrderWave;

/** A small seeded random generator (mulberry32): the same numbers for the same seed, so that a vehicle always sounds the same. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The partials of a wave, `count` of them, scaled so that the wave peaks at
 * 1 (then it makes no difference whether a browser normalises it again).
 * `periodDeg` is the crank angle of one period (720 for a four-stroke's cycle).
 */
export function wavePartials(spec: WaveSpec, periodDeg: number, count: number, seed: number): Partials {
  const real = new Float32Array(count + 1);
  const imag = new Float32Array(count + 1);
  const rnd = seeded(seed);
  if (spec.kind === 'pulses') {
    const n = spec.firing.length;
    const phase = new Float64Array(n);
    const amp = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      phase[i] = (spec.firing[i] + spec.skew * (rnd() * 2 - 1)) / periodDeg;
      amp[i] = (spec.amps?.[i] ?? 1) * (1 + spec.spread * (rnd() * 2 - 1));
    }
    const ta = spec.rise / periodDeg;
    const td = spec.decay / periodDeg;
    for (let k = 1; k <= count; k++) {
      const w = 2 * Math.PI * k;
      // the pulse e^(−t/decay) − e^(−t/rise): its spectrum at this partial (the periodic sum of its tail is exact)
      const dd = 1 + w * w * td * td;
      const da = 1 + w * w * ta * ta;
      const hr = td / dd - ta / da;
      const hi = (-w * td * td) / dd + (w * ta * ta) / da;
      // … once at every firing: Σ a·e^(−jwφ)
      let sr = 0;
      let si = 0;
      for (let i = 0; i < n; i++) {
        sr += amp[i] * Math.cos(w * phase[i]);
        si -= amp[i] * Math.sin(w * phase[i]);
      }
      const cr = hr * sr - hi * si;
      const ci = hr * si + hi * sr;
      real[k] = 2 * cr;
      imag[k] = -2 * ci;
    }
  } else {
    for (const [order, a] of spec.orders) {
      if (order < 1 || order > count) continue;
      // (a phase of its own for each order – the same in both waves of a voice, so that blending them never cancels a partial)
      const ph = spec.scatter ? seeded((seed ^ Math.imul(order, 2654435761)) >>> 0)() * 2 * Math.PI : 0;
      real[order] += a * Math.cos(ph);
      imag[order] += a * Math.sin(ph);
    }
  }
  const peak = peakOf({ real, imag });
  if (peak > 0) {
    for (let k = 1; k <= count; k++) {
      real[k] /= peak;
      imag[k] /= peak;
    }
  }
  return { real, imag };
}

/** In-place radix-2 FFT (forward, e^(−j…)); the length a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** The wave at n evenly spaced points of its period (n a power of two, more than twice the partials). */
export function samples(p: Partials, n: number): Float64Array {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const k = Math.min(p.real.length, n >> 1);
  for (let i = 1; i < k; i++) {
    re[i] = p.real[i];
    im[i] = p.imag[i];
  }
  // Re Σ (a + jb)·e^(−jθ) = Σ a·cos θ + b·sin θ: the wave itself
  fft(re, im);
  return re;
}

/** The highest excursion of a wave (sampled four times finer than its highest partial: within a few per cent). */
export function peakOf(p: Partials): number {
  let n = 64;
  while (n < 4 * p.real.length && n < 16384) n <<= 1;
  const x = samples(p, n);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  return peak;
}

/** The RMS of a wave: each partial a·cos + b·sin carries (a² + b²) / 2. */
export function rmsOf(p: Partials): number {
  let s = 0;
  for (let k = 1; k < p.real.length; k++) s += p.real[k] * p.real[k] + p.imag[k] * p.imag[k];
  return Math.sqrt(s / 2);
}

/** A-weighting – the ear at moderate levels – as a factor on the amplitude, 1 at 1 kHz. */
export function aWeight(f: number): number {
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  // (+2.00 dB: 1 at 1 kHz)
  return ra * 1.2589;
}

// The magnitudes of the BiquadFilterNode's responses (their analogue prototypes – close enough
// below a few kHz). As in the Web Audio API, the Q of the low-pass and the high-pass is in dB,
// that of the band-pass and the peaking filter a plain number.

export function lowpassGain(f: number, fc: number, qDb: number): number {
  const q = 10 ** (qDb / 20);
  const x = f / fc;
  return 1 / Math.sqrt((1 - x * x) ** 2 + (x / q) ** 2);
}

export function highpassGain(f: number, fc: number, qDb: number): number {
  const q = 10 ** (qDb / 20);
  const x = f / fc;
  return (x * x) / Math.sqrt((1 - x * x) ** 2 + (x / q) ** 2);
}

export function bandpassGain(f: number, f0: number, q: number): number {
  const x = f / f0;
  const b = x / q;
  return b / Math.sqrt((1 - x * x) ** 2 + b * b);
}

export function peakingGain(f: number, f0: number, q: number, gainDb: number): number {
  const a = 10 ** (gainDb / 40);
  const x = f / f0;
  const d = (1 - x * x) ** 2;
  return Math.sqrt((d + ((x * a) / q) ** 2) / (d + (x / (a * q)) ** 2));
}

/**
 * How loud (A-weighted RMS) two waves sound played together on one
 * fundamental f0 – they are in phase, so their partials add – after a
 * filter of the given response.
 */
export function waveLoudness(a: Partials, ga: number, b: Partials, gb: number, f0: number, response: (f: number) => number): number {
  let sum = 0;
  const n = Math.max(a.real.length, b.real.length);
  for (let k = 1; k < n; k++) {
    const f = k * f0;
    if (f > 16000) break;
    const re = (k < a.real.length ? ga * a.real[k] : 0) + (k < b.real.length ? gb * b.real[k] : 0);
    const im = (k < a.imag.length ? ga * a.imag[k] : 0) + (k < b.imag.length ? gb * b.imag[k] : 0);
    const g = response(f) * aWeight(f);
    sum += (re * re + im * im) * g * g;
  }
  return Math.sqrt(sum / 2);
}

/** How loud (A-weighted RMS) white noise of ±1 sounds after a filter of the given response. */
export function noiseLoudness(response: (f: number) => number, sampleRate = 48000): number {
  // (its variance of 1/3 is spread evenly up to half the sample rate; integrated over ln f)
  const density = 1 / 3 / (sampleRate / 2);
  const steps = 240;
  const lo = Math.log(20);
  const hi = Math.log(Math.min(20000, sampleRate / 2));
  const d = (hi - lo) / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const f = Math.exp(lo + d * i);
    const g = response(f) * aWeight(f);
    sum += g * g * f * d * (i === 0 || i === steps ? 0.5 : 1);
  }
  return Math.sqrt(density * sum);
}

/** How loud (A-weighted RMS) an oscillator of amplitude 1 and one of the standard shapes sounds after a filter. */
export function oscLoudness(type: 'sine' | 'square' | 'sawtooth' | 'triangle', f0: number, response: (f: number) => number = () => 1): number {
  let sum = 0;
  for (let k = 1; k * f0 < 16000 && k < 400; k++) {
    let a = 0;
    if (type === 'sine') a = k === 1 ? 1 : 0;
    else if (type === 'sawtooth') a = 2 / (Math.PI * k);
    else if (type === 'square') a = k % 2 ? 4 / (Math.PI * k) : 0;
    else a = k % 2 ? 8 / (Math.PI * Math.PI * k * k) : 0;
    if (a === 0) continue;
    const g = a * response(k * f0) * aWeight(k * f0);
    sum += g * g;
  }
  return Math.sqrt(sum / 2);
}
