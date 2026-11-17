// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The vehicles' sounds: every vehicle of the game has one; an engine fires
 * as often as its layout says (a four-stroke's cylinders once every two
 * turns), its sound follows the revs and the load, the vehicles are
 * balanced against each other; the tram whines with its speed and squeals
 * in tight curves, the aeroplane's propeller drones at its blade-passing
 * frequency – and on the device nothing is made anew while driving (a mock
 * of the Web Audio API counts it).
 *
 *   node --test tests/game/audio.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { VEHICLE_KINDS, VEHICLES } from '../../src/game/vehicles.ts';
import type { AudioState, SoundKind } from '../../src/audio/profiles.ts';
import { PROFILES, REF_LOUDNESS, SOUND_KINDS, firingHz, mainLoudness, newTargets, referenceState, soundKindOf, soundRpm, soundTargets, voicing } from '../../src/audio/profiles.ts';
import { aWeight, peakOf, rmsOf, samples, wavePartials } from '../../src/audio/waves.ts';
import type { ClickKind } from '../../src/audio/audio.ts';
import { GameAudio } from '../../src/audio/audio.ts';
import { installMockAudio } from './audiomock.ts';

const dB = (x: number): number => 20 * Math.log10(x / REF_LOUDNESS);

function state(over: Partial<AudioState>): AudioState {
  return { rpm: 0, load: 0, engineRunning: true, starter: false, speed: 0, skid: 0, indicatorOn: false, blinkOn: false, horn: false, rough: 1, ...over };
}

/** the kinds with a piston engine */
const ENGINES = SOUND_KINDS.filter((k) => {
  const m = PROFILES[k].main;
  return m !== null && m.kind !== 'motor';
});

test('every vehicle of the game has a sound – with a trailer the same as without, each motorcycle class its own', () => {
  for (const k of VEHICLE_KINDS) {
    const s = soundKindOf(k);
    assert.ok(SOUND_KINDS.includes(s), `${k} → ${s}`);
    assert.ok(PROFILES[s], `${s} has a profile`);
  }
  assert.equal(soundKindOf('carTrailer'), soundKindOf('car'));
  assert.equal(soundKindOf('busTrailer'), 'bus');
  assert.equal(soundKindOf('tram'), 'tram');
  assert.equal(soundKindOf('plane'), 'plane');
  assert.equal(soundKindOf('pedestrian'), 'onFoot');
  const bikes = new Set(['moped', 'motorcycle125', 'motorcycle35', 'motorcycle'].map((k) => soundKindOf(k as 'moped')));
  assert.equal(bikes.size, 4, 'four different motorcycle sounds');
  // (every kind of sound is used by some vehicle)
  for (const s of SOUND_KINDS) assert.ok(VEHICLE_KINDS.some((k) => soundKindOf(k) === s), `${s} is used`);
  assert.deepEqual(new Set(Object.keys(PROFILES)), new Set(SOUND_KINDS));
});

test('the profiles are sound: engine speeds in order, firings within the cycle, waves finite and peaking at 1', () => {
  for (const k of SOUND_KINDS) {
    const p = PROFILES[k];
    const v = voicing(k);
    const m = p.main;
    if (!m) {
      assert.equal(v.soft, null);
      continue;
    }
    if (m.kind !== 'motor') {
      assert.ok(m.idleRpm > 0 && m.maxRpm > m.idleRpm * 2, `${k}: idle ${m.idleRpm}, max ${m.maxRpm}`);
      for (const w of [m.soft, m.hard]) if (w.kind === 'pulses') for (const a of w.firing) assert.ok(a >= 0 && a < 360 * m.turns, `${k}: fires at ${a}°`);
    }
    for (const w of [v.soft, v.hard]) {
      assert.ok(w);
      assert.ok(w.real.length <= 2049, 'within what a browser keeps of a wave');
      for (let i = 0; i < w.real.length; i++) assert.ok(Number.isFinite(w.real[i]) && Number.isFinite(w.imag[i]));
      assert.ok(Math.abs(peakOf(w) - 1) < 0.01, `${k}: normalised to a peak of 1`);
    }
    for (const g of Object.values(v.gain).flat()) assert.ok(Number.isFinite(g) && g >= 0, `${k}: gains finite`);
  }
});

test('the partials of a pulse train are the pulses: the wave they make has a pulse at every firing', () => {
  // (a four-stroke four, no differences between cylinders: four equal pulses per cycle, a quarter apart)
  const w = wavePartials({ kind: 'pulses', firing: [0, 180, 360, 540], rise: 6, decay: 30, spread: 0, skew: 0 }, 720, 512, 1);
  const x = samples(w, 4096);
  const peaks: number[] = [];
  for (let i = 0; i < 4096; i++) if (x[i] > 0.9) peaks.push(i);
  const groups = peaks.filter((i, j) => j === 0 || i - peaks[j - 1] > 50);
  assert.equal(groups.length, 4, 'four pulses');
  for (let j = 1; j < 4; j++) assert.ok(Math.abs(groups[j] - groups[j - 1] - 1024) < 8, 'a quarter cycle apart');
  // an even four has nothing between its firing orders; the RMS is that of its partials
  for (let k = 1; k < 40; k++) if (k % 4) assert.ok(Math.hypot(w.real[k], w.imag[k]) < 1e-6, `order ${k / 2} is empty`);
  let s = 0;
  for (let i = 0; i < 4096; i++) s += x[i] * x[i];
  assert.ok(Math.abs(Math.sqrt(s / 4096) - rmsOf(w)) < 1e-6);
});

test('firing frequency: rpm/60 × cylinders/2 for a four-stroke, rpm/60 for the two-stroke – and the waves are strongest there', () => {
  assert.equal(firingHz(PROFILES.car, 3000), 100, 'a four at 3000 rpm: 100 Hz');
  assert.equal(firingHz(PROFILES.truck, 1200), 60, 'a six at 1200 rpm: 60 Hz');
  assert.equal(firingHz(PROFILES.motorcycle125, 6000), 50, 'a single: once every two turns');
  assert.equal(firingHz(PROFILES.moped, 6000), 100, 'the two-stroke: every turn');
  assert.equal(firingHz(PROFILES.motorcycle35, 6000), 100, 'a twin');
  for (const k of ['car', 'minibus', 'lightTruck', 'truck', 'bus', 'tractorSlow', 'tractor', 'motorcycle'] as SoundKind[]) {
    const m = PROFILES[k].main;
    assert.ok(m && m.kind === 'engine' && m.hard.kind === 'pulses');
    const cylinders = m.hard.firing.length;
    const v = voicing(k);
    const t = soundTargets(v, state({ rpm: 2000, load: 1 }), null, newTargets());
    // the main voice's fundamental is a whole cycle; the firings make the partial `cylinders` of it
    assert.ok(Math.abs(t.freq * cylinders - firingHz(PROFILES[k], 2000)) < 1e-9, `${k}: firing order`);
    const hard = v.hard as NonNullable<typeof v.hard>;
    const amp = (j: number): number => Math.hypot(hard.real[j], hard.imag[j]);
    let best = 1;
    for (let j = 1; j <= 2 * cylinders; j++) if (amp(j) > amp(best)) best = j;
    assert.equal(best, cylinders, `${k}: strongest at the firing frequency`);
    // the cylinders differ a little: the half orders are there, but well below
    assert.ok(amp(1) > 0 && amp(1) < 0.25 * amp(cylinders), `${k}: half orders present but weak`);
  }
});

test('the game’s engine speeds are mapped onto the sound’s own engine (and taken as they are without a mapping)', () => {
  const truckEngine = { idleRpm: 600, limiterRpm: 2400 };
  assert.equal(soundRpm(PROFILES.minibus, 600, truckEngine), 750, 'idle onto idle');
  assert.equal(soundRpm(PROFILES.minibus, 2400, truckEngine), 4000, 'limiter onto its highest');
  assert.equal(soundRpm(PROFILES.minibus, 300, truckEngine), 375, 'cranking in proportion');
  assert.equal(soundRpm(PROFILES.car, 3210, null), 3210);
  assert.equal(soundRpm(PROFILES.car, 3210, { idleRpm: 800, limiterRpm: 6500 }), 3210, 'the car’s own engine: unchanged');
  assert.equal(soundRpm(PROFILES.plane, 2300, { idleRpm: 800, limiterRpm: 6500 }), 2300, 'the aeroplane’s rpm are its own');
  // every road vehicle of the game with its own engine: its idle maps onto the profile's idle
  for (const k of VEHICLE_KINDS) {
    const p = PROFILES[soundKindOf(k)];
    const m = p.main;
    if (!p.mapRpm || !m || m.kind === 'motor') continue;
    const spec = VEHICLES[k].spec('manual', VEHICLES[k].power);
    assert.ok(Math.abs(soundRpm(p, spec.idleRpm, spec) - m.idleRpm) < 1e-9, k);
    assert.ok(Math.abs(soundRpm(p, spec.limiterRpm, spec) - m.maxRpm) < 1e-9, k);
  }
});

test('an engine sounds louder and brighter with load and with revs, its idle well below full load', () => {
  for (const k of ENGINES) {
    const v = voicing(k);
    const m = v.profile.main;
    assert.ok(m && m.kind !== 'motor');
    const at = (n: number, load: number): ReturnType<typeof newTargets> => soundTargets(v, state({ rpm: m.idleRpm + n * (m.maxRpm - m.idleRpm), load }), null, newTargets());
    for (const n of [0, 0.3, 0.6, 0.9]) {
      let last = -Infinity;
      let lastCut = 0;
      for (const load of [0, 0.25, 0.5, 0.75, 1]) {
        const t = at(n, load);
        assert.ok(t.level >= last - 1e-9, `${k}: level grows with load`);
        assert.ok(t.cutoff >= lastCut, `${k}: the low-pass opens with load`);
        last = t.level;
        lastCut = t.cutoff;
      }
    }
    for (const load of [0, 0.5, 1]) assert.ok(at(0.8, load).freq > at(0.2, load).freq, `${k}: pitch rises with revs`);
    const idle = dB(mainLoudness(v, at(0, 0.08)));
    const full = dB(mainLoudness(v, at(0.9, 1)));
    assert.ok(full - idle > 9, `${k}: idle ${idle.toFixed(1)} dB, full ${full.toFixed(1)} dB`);
  }
});

test('the vehicles are balanced: each as loud as its profile says, none far louder than the others', () => {
  const fulls: number[] = [];
  for (const k of SOUND_KINDS) {
    const v = voicing(k);
    const m = v.profile.main;
    if (!m) continue;
    const ref = dB(mainLoudness(v, soundTargets(v, referenceState(v.profile), null, newTargets())));
    assert.ok(Math.abs(ref - m.db) < 0.1, `${k}: ${ref.toFixed(2)} dB at its reference, ${m.db} asked`);
    assert.ok(m.db >= -6 && m.db <= 6, `${k}: within ±6 dB of the car`);
    if (m.kind !== 'motor') fulls.push(dB(mainLoudness(v, soundTargets(v, state({ rpm: m.maxRpm * 0.95, load: 1 }), null, newTargets()))));
  }
  const spread = Math.max(...fulls) - Math.min(...fulls);
  assert.ok(spread < 6, `full load within 6 dB of each other (${fulls.map((x) => x.toFixed(1)).join(', ')})`);
});

test('silent when the engine is off; the starter while cranking; compression while turned without firing', () => {
  for (const k of ENGINES) {
    const v = voicing(k);
    const off = soundTargets(v, state({ engineRunning: false, rpm: 0 }), null, newTargets());
    assert.equal(off.level, 0, `${k}: off`);
    assert.equal(off.noiseLevel, 0);
    assert.equal(off.turboLevel, 0);
    if (v.profile.starter) {
      const crank = soundTargets(v, state({ engineRunning: false, starter: true, rpm: 250 }), null, newTargets());
      assert.ok(crank.starterLevel > 0, `${k}: the starter whirrs`);
      if (v.profile.main?.kind === 'engine') assert.ok(crank.level > 0 && crank.hard === 0, `${k}: compression, no combustion`);
      assert.equal(soundTargets(v, state({ starter: true, rpm: 800 }), null, newTargets()).starterLevel, 0, `${k}: not once it runs`);
    }
  }
  const foot = soundTargets(voicing('onFoot'), state({ rpm: 3000, load: 1, speed: 1.4, horn: true, skid: 1 }), null, newTargets());
  for (const [name, x] of Object.entries(foot)) if (name.endsWith('Level') || name === 'level') assert.equal(x, 0, `on foot: ${name}`);
});

test('the old fields alone still work, and nothing ever comes out as NaN', () => {
  let seed = 7;
  const r = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (const k of SOUND_KINDS) {
    const v = voicing(k);
    const out = newTargets();
    for (let i = 0; i < 200; i++) {
      const s = state({ rpm: r() * 12000 - 500, load: r() * 1.4 - 0.2, engineRunning: r() < 0.8, starter: r() < 0.1, speed: r() * 100 - 10, skid: r(), horn: r() < 0.5, rough: r() * 3 });
      if (i % 2) Object.assign(s, { braking: r(), curve: r() * 0.05, airborne: r() < 0.5, stallWarning: r() < 0.5, reversing: r() < 0.5, parkingBrake: r() < 0.5 });
      soundTargets(v, s, i % 3 ? null : { idleRpm: 600, limiterRpm: 2400 }, out);
      for (const [name, x] of Object.entries(out)) assert.ok(Number.isFinite(x) && x >= 0, `${k}: ${name} = ${x}`);
    }
  }
});

test('turbo and diesel clatter: the whistle comes with boost, the clatter is a diesel’s at idle', () => {
  const v = voicing('truck');
  const idle = soundTargets(v, state({ rpm: 600, load: 0.08 }), null, newTargets());
  const boost = soundTargets(v, state({ rpm: 1900, load: 1 }), null, newTargets());
  assert.equal(idle.turboLevel, 0, 'no boost at idle');
  assert.ok(boost.turboLevel > 0 && boost.turboFreq > idle.turboFreq, 'whistling, higher, under boost');
  assert.ok(idle.noiseLevel > 0, 'clatter at idle');
  // (a petrol engine's intake roar comes with the load instead)
  const car = voicing('car');
  const a = soundTargets(car, state({ rpm: 3000, load: 0.05 }), null, newTargets()).noiseLevel;
  const b = soundTargets(car, state({ rpm: 3000, load: 1 }), null, newTargets()).noiseLevel;
  assert.ok(b > 2 * a, 'intake roar under load');
});

test('the tram: its motors whine higher the faster it goes, louder as they pull or brake; its wheels squeal in tight curves', () => {
  const v = voicing('tram');
  const at = (over: Partial<AudioState>): ReturnType<typeof newTargets> => soundTargets(v, state({ engineRunning: true, ...over }), null, newTargets());
  const f5 = at({ speed: 5 }).freq;
  const f10 = at({ speed: 10 }).freq;
  assert.ok(Math.abs(f10 / f5 - 2) < 1e-9, 'pitch in proportion to the speed');
  // the gear mesh order at full speed: about a kilohertz – a whine, not a hum
  const mesh = PROFILES.tram.main?.kind === 'motor' ? PROFILES.tram.main.perMps * 17 * (70 / 3.6) : 0;
  assert.ok(mesh > 800 && mesh < 2000, `gear mesh at 70 km/h: ${mesh.toFixed(0)} Hz`);
  assert.ok(at({ speed: 10, load: 1 }).level > at({ speed: 10 }).level * 1.5, 'louder pulling than coasting');
  assert.ok(at({ speed: 10, braking: 0.8 }).level > at({ speed: 10 }).level * 1.5, 'louder braking electrically');
  assert.equal(at({ speed: 10, load: 1, engineRunning: false }).hard, 0, 'no current, no magnetic whine');
  assert.ok(at({ speed: 1, load: 1 }).toneALevel > 0, 'the inverter sings as it pulls away');
  assert.equal(at({ speed: 15, load: 1 }).toneALevel, 0, '… and no longer at speed');
  assert.ok(at({ speed: 0 }).noiseLevel > 0, 'its fans while it stands with power');
  // the squeal: a curve of 25 m at 15 km/h – not on the straight, not in a wide curve, not standing
  const tight = at({ speed: 4, curve: 1 / 25 }).skidLevel;
  assert.ok(tight > 0, 'squeals in a tight curve');
  assert.equal(at({ speed: 4, curve: 0 }).skidLevel, 0, 'not on the straight');
  assert.equal(at({ speed: 4, curve: 1 / 500 }).skidLevel, 0, 'not in a wide curve');
  assert.equal(at({ speed: 0, curve: 1 / 25 }).skidLevel, 0, 'not standing');
  assert.ok(at({ speed: 0.5, braking: 1 }).skidLevel > 0, 'the brakes just before it stands');
  assert.ok(at({ speed: 12 }).roadLevel > at({ speed: 4 }).roadLevel, 'the rails roar with speed');
  assert.ok(soundTargets(v, state({ speed: 10 }), null, newTargets()).level > 0, 'the gears whine while it coasts');
});

test('the aeroplane: the propeller drones at the blade-passing frequency, which windmilling keeps; the stall horn', () => {
  const v = voicing('plane');
  const soft = v.soft as NonNullable<typeof v.soft>;
  let best = 1;
  for (let k = 1; k < soft.real.length; k++) if (Math.hypot(soft.real[k], soft.imag[k]) > Math.hypot(soft.real[best], soft.imag[best])) best = k;
  const t = soundTargets(v, state({ rpm: 2400, load: 0.8, speed: 50, airborne: true }), null, newTargets());
  // two blades: twice a turn – 2400 rpm, 80 Hz
  assert.ok(Math.abs(best * t.freq - (2400 / 60) * 2) < 1e-9, `blade passing: ${best * t.freq} Hz`);
  assert.ok(t.soft > 0 && t.hard > 0, 'propeller and exhaust');
  const windmill = soundTargets(v, state({ rpm: 1200, engineRunning: false, speed: 40, airborne: true }), null, newTargets());
  assert.ok(windmill.level > 0 && windmill.soft > 0 && windmill.hard === 0, 'a dead engine: the propeller only');
  assert.equal(t.roadLevel, 0, 'no wheels rumbling in the air');
  assert.ok(soundTargets(v, state({ rpm: 1200, speed: 20 }), null, newTargets()).roadLevel > 0, 'on the runway they do');
  assert.ok(t.windLevel > soundTargets(v, state({ rpm: 2400, speed: 25 }), null, newTargets()).windLevel, 'more wind, faster');
  assert.ok(soundTargets(v, state({ rpm: 2000, speed: 25, stallWarning: true }), null, newTargets()).toneALevel > 0, 'the stall horn');
  assert.equal(t.toneALevel, 0);
  assert.equal(soundTargets(v, state({ rpm: 2000, horn: true }), null, newTargets()).hornLevel, 0, 'no horn');
});

test('A-weighting: 1 at 1 kHz, little of a low hum', () => {
  assert.ok(Math.abs(aWeight(1000) - 1) < 0.005);
  assert.ok(20 * Math.log10(aWeight(100)) < -18 && 20 * Math.log10(aWeight(100)) > -20.5);
});

// ---------------------------------------------------------------- on the (mock) device

const contexts = installMockAudio();

function frames(a: GameAudio, ctx: { currentTime: number }, n: number, s: (i: number) => AudioState): void {
  for (let i = 0; i < n; i++) {
    ctx.currentTime += 1 / 60;
    a.update(s(i));
  }
}

test('on the device: nothing is made while driving, and only what changes is sent', () => {
  const a = new GameAudio();
  a.setVehicle('car');
  assert.equal(a.context, null, 'no context before start()');
  let ready = 0;
  a.onReady(() => ready++);
  a.start();
  const ctx = contexts[contexts.length - 1];
  assert.equal(ready, 1, 'onReady once the context is there');
  assert.ok(a.context && a.masterGain, 'context and master gain for other sounds of the game');
  a.onReady(() => ready++);
  assert.equal(ready, 2, 'at once when it already is');
  for (const kind of SOUND_KINDS) {
    a.setVehicle(kind, kind === 'minibus' ? { idleRpm: 600, limiterRpm: 2400 } : null);
    const made = ctx.created;
    const calls0 = ctx.paramCalls;
    frames(a, ctx, 240, (i) => state({ rpm: 900 + 20 * i, load: (i % 60) / 60, speed: i / 10, rough: 1 + (i % 2), braking: 0, curve: kind === 'tram' ? 0.03 : 0 }));
    assert.equal(ctx.created, made, `${kind}: no nodes made in 240 frames`);
    assert.ok((ctx.paramCalls - calls0) / 240 <= 26, `${kind}: ${(ctx.paramCalls - calls0) / 240} settings a frame`);
    // standing still with nothing changing: nothing is sent at all
    frames(a, ctx, 10, () => state({ rpm: 900, load: 0.1, speed: 0 }));
    const calls1 = ctx.paramCalls;
    frames(a, ctx, 60, () => state({ rpm: 900, load: 0.1, speed: 0 }));
    assert.equal(ctx.paramCalls, calls1, `${kind}: a steady state sends nothing`);
  }
  // every vehicle with an engine or motors got its waves
  assert.ok(ctx.waves >= 2 * (SOUND_KINDS.length - 1));
});

test('on the device: every short sound plays', () => {
  const a = new GameAudio();
  a.start();
  const ctx = contexts[contexts.length - 1];
  const kinds: ClickKind[] = ['tick', 'tock', 'crash', 'grind', 'chime', 'bump', 'door', 'doorShut', 'step', 'air', 'airShort', 'airDoor', 'bell', 'clack', 'beep'];
  for (const k of kinds) {
    const made = ctx.created;
    const calls = ctx.paramCalls;
    a.click(k);
    assert.ok(ctx.created > made || ctx.paramCalls > calls, `${k} sounds`);
  }
});

test('on the device: the tram’s bell rings while held; air brakes hiss; a truck beeps in reverse', () => {
  const a = new GameAudio();
  a.start();
  const ctx = contexts[contexts.length - 1];
  a.setVehicle('tram');
  const osc0 = ctx.made.osc ?? 0;
  frames(a, ctx, 60, () => state({ horn: true, speed: 3 }));
  const strikes = ((ctx.made.osc ?? 0) - osc0) / 4;
  assert.ok(strikes >= 3 && strikes <= 4, `${strikes} strikes in a second`);
  const osc1 = ctx.made.osc ?? 0;
  frames(a, ctx, 60, () => state({ horn: false, speed: 3 }));
  assert.equal(ctx.made.osc ?? 0, osc1, 'quiet once let go');

  // the air: a hiss when the parking brake is set – not for the one a drive begins with, not on a car
  const hisses: number[][] = [];
  (a as unknown as { hiss: (...x: number[]) => void }).hiss = (...x: number[]) => void hisses.push(x);
  a.setVehicle('truck', { idleRpm: 600, limiterRpm: 2400 });
  frames(a, ctx, 5, () => state({ rpm: 600, parkingBrake: true }));
  assert.equal(hisses.length, 0, 'the parking brake a drive begins with: no pssht');
  frames(a, ctx, 5, () => state({ rpm: 600, parkingBrake: false }));
  const released = hisses.length;
  frames(a, ctx, 5, () => state({ rpm: 600, parkingBrake: true }));
  assert.equal(hisses.length, released + 1, 'pssht as it is set');
  assert.ok(hisses[hisses.length - 1][0] > hisses[0][0], 'louder than letting it go');
  // braking, then letting go: a puff
  frames(a, ctx, 30, () => state({ rpm: 600, speed: 5, braking: 0.6, parkingBrake: true }));
  const before = hisses.length;
  frames(a, ctx, 5, () => state({ rpm: 600, speed: 5, braking: 0, parkingBrake: true }));
  assert.equal(hisses.length, before + 1, 'a puff as the brake is let go');
  a.setVehicle('car');
  frames(a, ctx, 5, () => state({ rpm: 800, parkingBrake: false }));
  frames(a, ctx, 5, () => state({ rpm: 800, parkingBrake: true }));
  frames(a, ctx, 30, () => state({ rpm: 800, braking: 0.6 }));
  frames(a, ctx, 5, () => state({ rpm: 800, braking: 0 }));
  assert.equal(hisses.length, before + 1, 'a car has no air brakes');

  // the reversing alarm: a beep a second
  a.setVehicle('truck');
  const osc2 = ctx.made.osc ?? 0;
  frames(a, ctx, 180, () => state({ rpm: 700, reversing: true }));
  assert.equal((ctx.made.osc ?? 0) - osc2, 3, 'three beeps in three seconds');
  a.setVehicle('car');
  const osc3 = ctx.made.osc ?? 0;
  frames(a, ctx, 120, () => state({ rpm: 900, reversing: true }));
  assert.equal(ctx.made.osc ?? 0, osc3, 'a car does not beep');
});

test('on the device: the music is off until asked for – then it is there, and gone again when switched off', () => {
  const a = new GameAudio();
  a.setMusic('quiet', 0.8);
  a.setMusic('off');
  a.start();
  const ctx = contexts[contexts.length - 1];
  const made = ctx.created;
  a.setMusic('off');
  assert.equal(ctx.created, made, 'off: nothing made');
  a.setMusic('on', 0.5);
  assert.ok(ctx.created > made, 'on: its nodes are made');
  a.setMusic('off');
});
