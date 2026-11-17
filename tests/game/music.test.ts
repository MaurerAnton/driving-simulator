// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The music made up while driving: every piece in its key and mode, its
 * tune leaning on the notes of its chords, of a length to listen to,
 * varied from piece to piece, quiet against the vehicles – and played on
 * the audio clock a moment ahead, with pauses of minutes between pieces,
 * nothing at all while it is off.
 *
 *   node --test tests/game/music.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Instrument, Piece } from '../../src/audio/compose.ts';
import { MODES, composePiece, scaleDegree } from '../../src/audio/compose.ts';
import { MUSIC_DB, MusicPlayer, pauseAfter, pieceGain, pieceLoudness } from '../../src/audio/music.ts';
import { REF_LOUDNESS } from '../../src/audio/profiles.ts';
import { MockContext } from './audiomock.ts';

const SEEDS = Array.from({ length: 24 }, (_, i) => (i + 1) * 104729);
const pieces: Piece[] = SEEDS.map((s) => composePiece(s));

/** where each instrument may play (MIDI) */
const RANGE: Record<Instrument, [number, number]> = { bell: [55, 88], flute: [55, 88], marimba: [52, 88], pluck: [50, 88], pad: [55, 67], bass: [36, 58] };

test('the same seed makes the same piece', () => {
  assert.deepEqual(composePiece(SEEDS[3]), pieces[3]);
});

test('every note in the key and mode, in its instrument’s range, in order, within the piece', () => {
  for (const p of pieces) {
    let last = 0;
    for (const n of p.notes) {
      assert.ok(scaleDegree(p, n.p) >= 0, `seed ${p.seed}: ${n.p} is in ${p.mode} on ${p.key}`);
      const [lo, hi] = RANGE[n.i];
      assert.ok(n.p >= lo && n.p <= hi, `seed ${p.seed}: ${n.i} at ${n.p}`);
      assert.ok(n.t >= last - 1e-9, 'in order');
      last = n.t;
      assert.ok(n.t >= 0 && n.t + n.d <= p.length, 'within the piece');
      assert.ok(n.d > 0 && n.v > 0 && n.v <= 1);
    }
  }
});

test('the tune leans on the chord: where it falls on the bar and where it is held, it is a note of the chord', () => {
  for (const p of pieces) {
    const spb = 60 / p.bpm;
    const bar = p.beatsPerBar * spb;
    const mel = p.notes.filter((n) => n.role === 'melody');
    assert.ok(mel.length > 20, `seed ${p.seed}: a tune`);
    let leaning = 0;
    for (const n of mel) {
      // (the notes are a little off the beat, as played: up to 8 ms)
      const b = Math.floor((n.t + 0.02) / bar);
      const beat = (n.t + 0.02 - b * bar) / spb;
      const held = n.d / 0.92 / spb;
      if (beat > 0.05 && held < 1.45) continue;
      leaning++;
      const root = p.chords[b];
      const deg = scaleDegree(p, n.p);
      const rel = (((deg - root) % 7) + 7) % 7;
      assert.ok(rel === 0 || rel === 2 || rel === 4, `seed ${p.seed}: bar ${b} on degree ${root}, tune on degree ${deg}`);
    }
    assert.ok(leaning > 8);
    // and it moves mostly by step: no leap beyond an octave and a step (that only where a section comes back), most moves a step or two
    let steps = 0;
    for (let i = 1; i < mel.length; i++) {
      const d = Math.abs(mel[i].p - mel[i - 1].p);
      assert.ok(d <= 14, `seed ${p.seed}: a leap of ${d}`);
      if (d <= 4) steps++;
    }
    assert.ok(steps / (mel.length - 1) > 0.6, `seed ${p.seed}: ${((100 * steps) / (mel.length - 1)).toFixed(0)} % steps`);
  }
});

test('a piece ends at home: its last chord and its last tune note on the tonic, the bass on its root', () => {
  for (const p of pieces) {
    assert.equal(p.chords[p.chords.length - 1], 0);
    const mel = p.notes.filter((n) => n.role === 'melody');
    assert.equal(scaleDegree(p, mel[mel.length - 1].p), 0, `seed ${p.seed}`);
    const bass = p.notes.filter((n) => n.role === 'bass');
    assert.equal(scaleDegree(p, bass[bass.length - 1].p), 0);
  }
});

test('pieces of a minute or two, calm, and different from each other', () => {
  for (const p of pieces) {
    assert.ok(p.length > 60 && p.length < 200, `seed ${p.seed}: ${p.length.toFixed(0)} s`);
    assert.ok(p.bpm >= 60 && p.bpm <= 84);
    assert.ok(p.beatsPerBar === 3 || p.beatsPerBar === 4);
    assert.ok(Object.keys(MODES).includes(p.mode));
  }
  const keys = new Set(pieces.map((p) => p.key));
  const modes = new Set(pieces.map((p) => p.mode));
  const tunes = new Set(pieces.map((p) => p.notes.filter((n) => n.role === 'melody').slice(0, 8).map((n) => n.p - p.key).join(',')));
  const instruments = new Set(pieces.map((p) => [...new Set(p.notes.filter((n) => n.role === 'melody').map((n) => n.i))].sort().join('+')));
  assert.ok(keys.size >= 8, `${keys.size} keys`);
  assert.ok(modes.size >= 4, `${modes.size} modes`);
  assert.equal(tunes.size, pieces.length, 'no two tunes alike');
  assert.ok(instruments.size >= 4, `${instruments.size} combinations of instruments`);
  assert.ok(pieces.some((p) => p.beatsPerBar === 3) && pieces.some((p) => p.beatsPerBar === 4));
});

test('cheap to play: never many notes sounding at once', () => {
  const ring: Record<Instrument, (d: number) => number> = {
    bell: () => 0.9 * 4,
    marimba: () => 0.3 * 4,
    pluck: () => 0.45 * 4,
    flute: (d) => d + 0.3,
    pad: (d) => d + 1.5,
    bass: (d) => d + 0.4,
  };
  for (const p of pieces) {
    const edges: Array<[number, number]> = [];
    for (const n of p.notes) edges.push([n.t, 1], [n.t + ring[n.i](n.d), -1]);
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let now = 0;
    let most = 0;
    for (const [, e] of edges) most = Math.max(most, (now += e));
    assert.ok(most <= 22, `seed ${p.seed}: ${most} notes at once`);
  }
});

test('quiet against the vehicles: every piece as loud as its mode asks, well under the car’s engine', () => {
  for (const p of pieces) {
    for (const mode of ['quiet', 'on'] as const) {
      const db = 20 * Math.log10(pieceLoudness(p, pieceGain(p, mode, 1)) / REF_LOUDNESS);
      assert.ok(Math.abs(db - MUSIC_DB[mode]) < 0.01, `seed ${p.seed}, ${mode}: ${db.toFixed(2)} dB`);
    }
    assert.ok(pieceGain(p, 'on', 0.5) < pieceGain(p, 'on', 1), 'the volume turns it down');
    assert.equal(pieceGain(p, 'off', 1), 0);
  }
  assert.ok(MUSIC_DB.quiet < MUSIC_DB.on && MUSIC_DB.on <= -3, 'quiet quieter, both under the engine');
});

test('pauses: a few minutes now and then, under a minute when on', () => {
  for (const r of [0, 0.5, 0.999]) {
    const q = pauseAfter('quiet', r);
    const o = pauseAfter('on', r);
    assert.ok(q >= 120 && q <= 360, `quiet: ${q} s`);
    assert.ok(o >= 20 && o <= 75, `on: ${o} s`);
  }
});

test('the player: nothing while off; then a piece soon, scheduled a moment ahead; a pause; off again', () => {
  const ctx = new MockContext();
  const out = ctx.createGain();
  const music = new MusicPlayer(ctx as unknown as BaseAudioContext, out as unknown as AudioNode, { timer: false, seed: 42 });
  music.tick();
  assert.equal(ctx.created, 1, 'off: nothing made');
  music.set('on', 1);
  const graph = ctx.created;
  assert.ok(graph > 5 && graph < 40, `a few shared nodes (${graph})`);
  const step = (s: number): void => {
    ctx.currentTime += s;
    music.tick();
  };
  step(0.25);
  assert.equal(music.playing, false, 'not at once');
  for (let i = 0; i < 40 && !music.playing; i++) step(0.25);
  assert.equal(music.playing, true, 'within a few seconds');
  assert.ok(ctx.currentTime < 8);
  // a note is made only a moment before it is due: never more than the look-ahead in advance
  const begun = ctx.currentTime;
  let made = (ctx.made.osc ?? 0) as number;
  const due: number[] = [];
  for (let i = 0; i < 80; i++) {
    step(0.25);
    const now = (ctx.made.osc ?? 0) as number;
    if (now > made) due.push(ctx.currentTime);
    made = now;
  }
  assert.ok(due.length > 10, 'notes keep coming');
  for (const n of ctx.nodes) if (n.kind === 'osc' && n.started > 0) assert.ok(n.started <= ctx.currentTime + 1.3, 'scheduled at most a little ahead');
  assert.ok(ctx.currentTime - begun > 15);
  // to the end of the piece, then a pause of under a minute ('on'), then the next piece
  for (let i = 0; i < 4 * 240 && music.playing; i++) step(0.25);
  assert.equal(music.playing, false, 'the piece has ended');
  assert.equal(music.played, 1);
  const pauseFrom = ctx.currentTime;
  for (let i = 0; i < 4 * 90 && !music.playing; i++) step(0.25);
  const pause = ctx.currentTime - pauseFrom;
  assert.ok(music.playing && pause >= 20 && pause <= 75, `a pause of ${pause.toFixed(0)} s`);
  assert.equal(music.played, 2);
  // off: no more notes
  music.set('off', 1);
  const after = ctx.created;
  for (let i = 0; i < 40; i++) step(0.25);
  assert.equal(ctx.created, after, 'off: nothing more is made');
});
