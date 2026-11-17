// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Music for the drive, made up anew for every piece – nothing recorded,
 * nothing borrowed: calm pieces of a minute or two in the manner of light
 * background music, each drawn from a seed –
 *
 *  - a key, a mode (major, Lydian, Mixolydian, Dorian or minor), a calm
 *    tempo, four or three beats to the bar, a set of instruments;
 *  - a form of eight-bar sections: a theme (A), a second theme (B), the
 *    theme again – with a short intro and an ending on the home chord;
 *  - chords from progressions known to sound pleasant (no diminished
 *    chords), every A closing with a cadence, B with a half close that
 *    leads back into A;
 *  - the theme: two phrases that begin alike and end apart – the first
 *    open, the second home –, built from a two-bar rhythmic motif whose
 *    first bar comes back on the next chord (a sequence), moving mostly by
 *    step and leaning on the notes of the chord; it returns later on
 *    another instrument;
 *  - an accompaniment of broken or held chords, and a bass.
 *
 * Pure numbers – what is played when; music.ts plays it.
 */
import { seeded } from './waves.ts';

export type Instrument = 'bell' | 'pluck' | 'marimba' | 'flute' | 'pad' | 'bass';

export interface MusicNote {
  /** when it starts (s from the start of the piece) and how long it is held (s) */
  t: number;
  d: number;
  /** pitch (MIDI number: 60 = c′, 69 = a′ at 440 Hz) and strength (0 … 1) */
  p: number;
  v: number;
  i: Instrument;
  /** what it belongs to: the tune, the chords (broken or held), the bass */
  role: 'melody' | 'chords' | 'bass';
}

export type ModeName = 'major' | 'lydian' | 'mixolydian' | 'dorian' | 'minor';

export interface Piece {
  seed: number;
  bpm: number;
  beatsPerBar: number;
  /** the key's tonic (pitch class: 0 = C … 11 = B) and its mode */
  key: number;
  mode: ModeName;
  /** the chord of every bar, as a degree of the mode (0: on the tonic) */
  chords: number[];
  /** seconds from the start until the last note has died away */
  length: number;
  /** in the order they start */
  notes: MusicNote[];
}

/** the steps of each mode above its tonic (semitones) */
export const MODES: Record<ModeName, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

/** four-chord progressions per mode (degrees; the mode's diminished triad is left out) */
const PROGRESSIONS: Record<ModeName, ReadonlyArray<readonly number[]>> = {
  major: [
    [0, 4, 5, 3],
    [0, 5, 3, 4],
    [0, 3, 0, 4],
    [0, 2, 3, 4],
    [5, 3, 0, 4],
    [0, 3, 5, 4],
    [0, 3, 1, 4],
    [3, 4, 2, 5],
    [0, 1, 3, 4],
  ],
  lydian: [
    [0, 1, 0, 1],
    [0, 1, 5, 4],
    [0, 1, 6, 5],
    [0, 1, 0, 4],
    [0, 6, 1, 0],
  ],
  mixolydian: [
    [0, 6, 3, 0],
    [0, 6, 0, 3],
    [0, 3, 6, 0],
    [0, 4, 6, 3],
    [0, 5, 6, 3],
  ],
  dorian: [
    [0, 3, 0, 3],
    [0, 2, 3, 0],
    [0, 6, 3, 0],
    [0, 3, 6, 0],
    [0, 1, 2, 3],
  ],
  minor: [
    [0, 5, 2, 6],
    [0, 3, 5, 4],
    [5, 6, 0, 0],
    [0, 6, 5, 6],
    [0, 5, 3, 4],
    [0, 2, 6, 5],
    [0, 3, 6, 2],
  ],
};

/** the last two chords of a section that comes home: [before, home] */
const CADENCES: Record<ModeName, ReadonlyArray<readonly [number, number]>> = {
  major: [
    [4, 0],
    [3, 0],
  ],
  lydian: [
    [1, 0],
    [4, 0],
  ],
  mixolydian: [
    [6, 0],
    [3, 0],
  ],
  dorian: [
    [3, 0],
    [6, 0],
  ],
  minor: [
    [6, 0],
    [3, 0],
    [4, 0],
  ],
};

type Rhythm = ReadonlyArray<readonly [number, number]>;
/** a bar of melody: [beat, beats held] */
const RHYTHMS: Record<3 | 4, readonly Rhythm[]> = {
  4: [
    [
      [0, 1],
      [1, 1],
      [2, 2],
    ],
    [
      [0, 1.5],
      [1.5, 0.5],
      [2, 2],
    ],
    [
      [0, 2],
      [2, 1],
      [3, 1],
    ],
    [
      [0, 0.5],
      [0.5, 0.5],
      [1, 1],
      [2, 2],
    ],
    [
      [0, 1],
      [1, 0.5],
      [1.5, 0.5],
      [2, 1],
      [3, 1],
    ],
    [
      [0, 3],
      [3, 1],
    ],
    [
      [1, 1],
      [2, 1],
      [3, 1],
    ],
    [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ],
  ],
  3: [
    [
      [0, 2],
      [2, 1],
    ],
    [
      [0, 1],
      [1, 1],
      [2, 1],
    ],
    [
      [0, 1.5],
      [1.5, 0.5],
      [2, 1],
    ],
    [
      [0, 1],
      [1, 2],
    ],
    [
      [1, 1],
      [2, 1],
    ],
  ],
};
/** the bar a phrase ends with: a long note */
const ENDINGS: Record<3 | 4, readonly Rhythm[]> = {
  4: [
    [[0, 4]],
    [
      [0, 2],
      [2, 2],
    ],
    [
      [0, 1],
      [1, 3],
    ],
    [[0, 3]],
  ],
  3: [
    [[0, 3]],
    [
      [0, 1],
      [1, 2],
    ],
    [[0, 2]],
  ],
};

/** broken chords: which of the chord's notes (root, third, fifth, octave, third above) on each eighth or quarter */
const ARPEGGIOS: Record<3 | 4, { eighths: ReadonlyArray<readonly number[]>; quarters: ReadonlyArray<readonly number[]> }> = {
  4: {
    eighths: [
      [0, 2, 3, 2, 1, 2, 3, 2],
      [0, 1, 2, 3, 2, 1, 2, 1],
      [0, 2, 4, 2, 3, 2, 1, 2],
      [0, 3, 2, 3, 1, 3, 2, 3],
    ],
    quarters: [
      [0, 2, 3, 2],
      [0, 1, 2, 3],
      [0, 2, 1, 2],
    ],
  },
  3: {
    eighths: [
      [0, 2, 3, 2, 1, 2],
      [0, 1, 2, 3, 2, 1],
      [0, 2, 4, 2, 3, 2],
    ],
    quarters: [
      [0, 2, 3],
      [0, 1, 2],
      [0, 2, 1],
    ],
  },
};

/** the bass in a bar: [beat, beats held, root (0) or fifth (1)] */
const BASSES: Record<3 | 4, ReadonlyArray<ReadonlyArray<readonly [number, number, number]>>> = {
  4: [[[0, 4, 0]], [[0, 2, 0], [2, 2, 1]], [[0, 3, 0], [3, 1, 1]]],
  3: [[[0, 3, 0]], [[0, 2, 0], [2, 1, 1]]],
};

/** who plays: the theme (and on its return), broken chords (or none), held chords */
const PALETTES: ReadonlyArray<{ melody: Instrument; second: Instrument; arp: Instrument | null; pad: boolean }> = [
  { melody: 'bell', second: 'flute', arp: 'pluck', pad: true },
  { melody: 'flute', second: 'bell', arp: 'pluck', pad: false },
  { melody: 'marimba', second: 'bell', arp: null, pad: true },
  { melody: 'flute', second: 'marimba', arp: 'marimba', pad: true },
  { melody: 'bell', second: 'pluck', arp: null, pad: true },
  { melody: 'pluck', second: 'flute', arp: 'marimba', pad: false },
];

/** the melody's range, in steps of the scale above its tonic (an octave and a half) */
const LO = 0;
const HI = 10;

const mod = (a: number, n: number): number => ((a % n) + n) % n;

interface MelNote {
  /** beat from the start of the section, beats held, step of the scale (0: the tonic), leant on */
  beat: number;
  dur: number;
  idx: number;
  strong: boolean;
}

/** Makes up a piece from a seed – the same piece for the same seed. */
export function composePiece(seed: number): Piece {
  const rnd = seeded(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length) % a.length];
  const weighted = <T>(items: ReadonlyArray<readonly [T, number]>): T => {
    let sum = 0;
    for (const [, w] of items) sum += w;
    let r = rnd() * sum;
    for (const [x, w] of items) {
      r -= w;
      if (r <= 0) return x;
    }
    return items[items.length - 1][0];
  };

  const mode = weighted<ModeName>([
    ['major', 0.3],
    ['lydian', 0.15],
    ['mixolydian', 0.15],
    ['dorian', 0.2],
    ['minor', 0.2],
  ]);
  const scale = MODES[mode];
  const key = Math.floor(rnd() * 12);
  const bpm = Math.round(60 + rnd() * 24);
  const bpb: 3 | 4 = rnd() < 0.3 ? 3 : 4;
  const spb = 60 / bpm;
  const barSec = bpb * spb;
  const palette = pick(PALETTES);
  const sevenths = rnd() < 0.45;
  const arpKind = bpm < 70 || rnd() < 0.5 ? 'eighths' : 'quarters';
  const arpPattern = pick(ARPEGGIOS[bpb][arpKind]);
  const bassPattern = pick(BASSES[bpb]);

  /** the scale's notes as one ladder: step `idx` above the tonic `base` (MIDI) */
  const midi = (base: number, idx: number): number => base + 12 * Math.floor(idx / 7) + scale[mod(idx, 7)];
  const isChordTone = (idx: number, root: number): boolean => {
    const d = mod(idx - root, 7);
    return d === 0 || d === 2 || d === 4;
  };
  /** the nearest note of the chord, looking first the way the melody moves – within the melody's range */
  const snap = (idx: number, root: number, dir: number): number => {
    const first = dir >= 0 ? 1 : -1;
    for (let d = 0; d <= 3; d++) {
      for (const s of d === 0 ? [0] : [d * first, -d * first]) {
        const j = idx + s;
        if (j >= LO && j <= HI && isChordTone(j, root)) return j;
      }
    }
    return Math.max(LO, Math.min(HI, idx));
  };
  const steps: ReadonlyArray<readonly [number, number]> = [
    [-4, 1],
    [-3, 3],
    [-2, 10],
    [-1, 28],
    [0, 5],
    [1, 28],
    [2, 10],
    [3, 3],
    [4, 1],
  ];
  /**
   * The next note: mostly a step, a leap turned back by a step the other way, on the chord where it leans – and
   * near where the phrase began (`center`): a step that would take it more than four steps away turns back.
   */
  const walk = (prev: number, last: number, strong: boolean, root: number, center: number): number => {
    let step = Math.abs(last) >= 3 ? -Math.sign(last) : weighted(steps);
    if (Math.abs(prev + step - center) > 4 && Math.abs(prev + step - center) > Math.abs(prev - center)) step = -step;
    if (prev + step < LO || prev + step > HI) step = -step;
    let idx = Math.max(LO, Math.min(HI, prev + step));
    if (strong) idx = snap(idx, root, step);
    return idx;
  };

  // ---- harmony: a progression for A (closing with a cadence), another for B (closing half)
  const progs = PROGRESSIONS[mode];
  const progA = pick(progs);
  let progB = pick(progs);
  for (let i = 0; i < 4 && progB === progA && progs.length > 1; i++) progB = pick(progs);
  // (B begins away from home: the progression turned until it starts elsewhere than on the tonic)
  let turn = 0;
  while (progB[turn % 4] === 0 && turn < 3) turn++;
  const rotB = [0, 1, 2, 3].map((k) => progB[(k + turn) % 4]);
  // (a cadence whose first chord is not the one just before it: no chord twice in a row on the way home)
  const cads = CADENCES[mode].filter((c) => c[0] !== progA[1]);
  const cad = pick(cads.length > 0 ? cads : CADENCES[mode]);
  const chordsA = [progA[0], progA[1], progA[2], progA[3], progA[0], progA[1], cad[0], cad[1]];
  const beforeHalf = rotB[2] !== cad[0] ? rotB[2] : rotB[3] !== cad[0] ? rotB[3] : rotB[1];
  const chordsB = [rotB[0], rotB[1], rotB[2], rotB[3], rotB[0], rotB[1], beforeHalf, cad[0]];

  // ---- the themes
  const melodyBase = 57 + mod(key - 57, 12);
  const motif = (): Rhythm[] => [pick(RHYTHMS[bpb]), pick(RHYTHMS[bpb])];
  const ending = (): Rhythm => pick(ENDINGS[bpb]);

  /** a phrase of four bars from `bar0` of the section; `copy`: its first two bars as another phrase had them */
  const phrase = (chords: readonly number[], bar0: number, rhythms: readonly Rhythm[], close: 'home' | 'open' | 'half', start: number, copy: MelNote[] | null): MelNote[] => {
    const out: MelNote[] = [];
    let prev = start;
    // (the note the phrase keeps near: where it begins)
    const center = copy && copy.length > 0 ? copy[0].idx : start;
    let last = 0;
    const push = (bar: number, beat: number, dur: number, idx: number, strong: boolean): void => {
      out.push({ beat: (bar0 + bar) * bpb + beat, dur, idx, strong });
      last = idx - prev;
      prev = idx;
    };
    const strongAt = (beat: number, dur: number): boolean => beat === 0 || (bpb === 4 && beat === 2) || dur >= 1.5;
    for (let bar = 0; bar < 2; bar++) {
      if (copy) {
        for (const n of copy) if (Math.floor(n.beat / bpb) % 4 === bar) push(bar, n.beat % bpb, n.dur, n.idx, n.strong);
        continue;
      }
      for (const [beat, dur] of rhythms[bar]) {
        const strong = strongAt(beat, dur);
        push(bar, beat, dur, walk(prev, last, strong, chords[bar], center), strong);
      }
    }
    // the third bar: the first bar's figure again, moved onto this bar's chord (a sequence) – unless it is free
    const first = out.filter((n) => n.beat < (bar0 + 1) * bpb);
    if (rhythms[2] === rhythms[0] && first.length > 0) {
      const target = snap(prev + (rnd() < 0.5 ? 1 : -1), chords[2], 0);
      const shift = target - first[0].idx;
      for (const n of first) {
        let idx = Math.max(LO, Math.min(HI, n.idx + shift));
        if (n.strong) idx = snap(idx, chords[2], shift);
        push(2, n.beat - bar0 * bpb, n.dur, idx, n.strong);
      }
    } else {
      for (const [beat, dur] of rhythms[2]) {
        const strong = strongAt(beat, dur);
        push(2, beat, dur, walk(prev, last, strong, chords[2], center), strong);
      }
    }
    // the last bar: towards where the phrase ends – home on the tonic, open on the chord's third or fifth
    const end = rhythms[3];
    const root = chords[3];
    let goal: number;
    if (close === 'home') {
      // (the tonic nearest between the last note and where the phrase began)
      goal = Math.round((prev + center) / 2 / 7) * 7;
      if (goal > HI) goal -= 7;
      if (goal < LO) goal += 7;
    } else {
      // (open: on the chord's third or fifth – the half close on its root or fifth –, near both the last note and
      // where the phrase began, so that the next phrase does not have to leap far to begin again)
      const want = close === 'open' ? [2, 4] : [0, 4];
      let best = prev;
      let bd = Infinity;
      for (let j = LO; j <= HI; j++) {
        const d = mod(j - root, 7);
        const cost = Math.abs(j - prev) + 1.5 * Math.abs(j - center);
        if (want.includes(d) && cost < bd) {
          bd = cost;
          best = j;
        }
      }
      goal = best;
    }
    end.forEach(([beat, dur], k) => {
      if (k === end.length - 1) push(3, beat, dur, goal, true);
      else {
        // (stepping towards the goal, on a note of the chord where it leans)
        const dir = Math.sign(goal - prev) || 1;
        let idx = prev + dir * (Math.abs(goal - prev) > 2 ? 2 : 1);
        if (idx === goal) idx = goal + dir;
        idx = Math.max(LO, Math.min(HI, idx));
        push(3, beat, dur, beat === 0 ? snap(idx, root, dir) : idx, beat === 0);
      }
    });
    return out;
  };

  const section = (chords: readonly number[], start: number, close: 'home' | 'half'): MelNote[] => {
    const m = motif();
    const one = phrase(chords.slice(0, 4), 0, [m[0], m[1], m[0], ending()], 'open', start, null);
    const firstTwo = one.filter((n) => n.beat < 2 * bpb);
    const lastOfTwo = firstTwo.length > 0 ? firstTwo[firstTwo.length - 1].idx : start;
    // (the second phrase begins as the first – its third bar goes its own way)
    const two = phrase(chords.slice(4, 8), 4, [m[0], m[1], pick(RHYTHMS[bpb]), ending()], close, lastOfTwo, firstTwo);
    return [...one, ...two];
  };
  const themeA = section(chordsA, snap(2 + Math.floor(rnd() * 3), chordsA[0], 1), 'home');
  // (the second theme begins between where the first ends and where it begins – it follows the one and leads
  // back into the other, so neither has to leap to reach it)
  const startA = themeA.length > 0 ? themeA[0].idx : 3;
  const endA = themeA.length > 0 ? themeA[themeA.length - 1].idx : 0;
  const themeB = section(chordsB, snap(Math.round((startA + endA) / 2) + (rnd() < 0.5 ? 0 : 1), chordsB[0], 1), 'half');

  // ---- the form: intro, sections, ending – shorter at a slow tempo
  type Part = { kind: 'intro' | 'A' | 'A2' | 'B' | 'A3' | 'outro'; bars: number; chords: readonly number[]; level: number };
  const intro = rnd() < 0.5 ? 1 : 2;
  const long = (4 * 8 + intro + 2) * barSec <= 170;
  const parts: Part[] = [{ kind: 'intro', bars: intro, chords: Array(intro).fill(0), level: 0.75 }];
  const sections: Array<Part['kind']> = long ? ['A', 'A2', 'B', 'A3'] : ['A', 'B', 'A3'];
  const levelOf = { A: 0.9, A2: 1, B: 0.95, A3: 0.9 } as Record<string, number>;
  for (const k of sections) parts.push({ kind: k, bars: 8, chords: k === 'B' ? chordsB : chordsA, level: levelOf[k] });
  parts.push({ kind: 'outro', bars: 2, chords: [0, 0], level: 0.8 });

  const notes: MusicNote[] = [];
  const chords: number[] = [];
  const human = (t: number, amount: number): number => Math.max(0, t + (rnd() - 0.5) * amount);
  const vary = (v: number): number => Math.min(1, v * (0.94 + 0.12 * rnd()));
  /** the chord on `root` as pitch classes, its notes from the root up (semitones), with its seventh if the piece colours them */
  const chordPcs = (root: number, seventh: boolean): number[] => {
    const out = [0, 2, 4].map((k) => mod(key + midi(0, root + k), 12));
    if (seventh) out.push(mod(key + midi(0, root + 6), 12));
    return out;
  };
  const above = (lo: number, pc: number): number => lo + mod(pc - lo, 12);

  let bar = 0;
  for (const part of parts) {
    for (let b = 0; b < part.bars; b++, bar++) {
      const root = part.chords[b];
      chords.push(root);
      const t0 = bar * barSec;
      const lv = part.kind === 'intro' ? part.level + (0.25 * b) / Math.max(1, part.bars - 1) : part.kind === 'A3' ? part.level * (1 - 0.15 * (b / 8)) : part.level;
      // held chords: the palette's, and more the second time; merged with the next bar where the chord stays
      const pad = palette.pad || part.kind === 'A2' || part.kind === 'outro';
      const prevRoot = chords.length > 1 ? chords[chords.length - 2] : -1;
      const newChord = b === 0 || root !== prevRoot;
      if (pad && newChord) {
        let len = 1;
        while (b + len < part.bars && part.chords[b + len] === root) len++;
        for (const pc of chordPcs(root, sevenths && part.kind !== 'outro')) notes.push({ t: t0, d: len * barSec + 0.1, p: above(55, pc), v: vary(0.3 * lv), i: 'pad', role: 'chords' });
      }
      // broken chords (not in the ending's last bar: it rings out)
      if (palette.arp && !(part.kind === 'outro' && b > 0)) {
        const r0 = above(52, chordPcs(root, false)[0]);
        const tones = [r0, r0 + midi(0, root + 2) - midi(0, root), r0 + midi(0, root + 4) - midi(0, root), r0 + 12, r0 + 12 + midi(0, root + 2) - midi(0, root)];
        const step = arpKind === 'eighths' ? 0.5 : 1;
        arpPattern.forEach((k, j) => {
          const beat = j * step;
          notes.push({ t: human(t0 + beat * spb, 0.012), d: step * spb, p: tones[k], v: vary((j === 0 ? 0.5 : 0.4) * lv), i: palette.arp as Instrument, role: 'chords' });
        });
      }
      // the bass (in from the intro's second bar; one long note in the ending)
      if (!(part.kind === 'intro' && b === 0 && part.bars > 1)) {
        const rootBass = above(40, chordPcs(root, false)[0]);
        const fifthBass = rootBass + midi(0, root + 4) - midi(0, root);
        if (part.kind === 'outro') {
          if (b === 0) notes.push({ t: t0, d: 2 * barSec, p: rootBass, v: vary(0.55 * lv), i: 'bass', role: 'bass' });
        } else for (const [beat, dur, which] of bassPattern) notes.push({ t: t0 + beat * spb, d: dur * spb * 0.95, p: which ? fifthBass : rootBass, v: vary((beat === 0 ? 0.6 : 0.5) * lv), i: 'bass', role: 'bass' });
      }
    }
  }

  // the themes on their instruments
  let barAt = intro;
  for (const k of sections) {
    const theme = k === 'B' ? themeB : themeA;
    const inst = k === 'A2' ? palette.second : palette.melody;
    const level = levelOf[k];
    theme.forEach((n, j) => {
      const last = j === theme.length - 1;
      // (the very last note of the piece is held into the ending)
      const dur = last && k === 'A3' ? n.dur + bpb : n.dur;
      notes.push({ t: human((barAt * bpb + n.beat) * spb, 0.016), d: dur * spb * 0.92, p: midi(melodyBase, n.idx), v: vary((n.strong ? 0.82 : 0.72) * level), i: inst, role: 'melody' });
    });
    barAt += 8;
  }
  // a last bell on the tonic as the ending begins
  notes.push({ t: barAt * barSec, d: barSec, p: melodyBase + 12, v: 0.5, i: 'bell', role: 'chords' });

  notes.sort((a, b) => a.t - b.t);
  return { seed, bpm, beatsPerBar: bpb, key, mode, chords, length: bar * barSec + 4, notes };
}

/** The scale steps of a pitch in a piece's key and mode (−1: not in the scale). */
export function scaleDegree(piece: Piece, p: number): number {
  return MODES[piece.mode].indexOf(mod(p - piece.key, 12));
}
