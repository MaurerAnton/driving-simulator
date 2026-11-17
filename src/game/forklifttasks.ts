// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The forklift's place on the practice yard and what is done there
 * (game/forkliftplay.ts runs it, render/forkliftyard.ts draws it):
 *
 *  - the place, in the yard's own frame (u along it, w across, metres): a
 *    pallet rack of three bays with beams at 1.6 and 3.1 m, a flatbed truck
 *    standing with its side open to be loaded from the ground, pallets
 *    waiting on the ground, a crate of 3.6 t (more than the forklift may
 *    lift), a green place to set a pallet down on;
 *  - a short guided start with one pallet – forks in, lift it just clear,
 *    tilt the mast back, drive with the load low, set it down and back out;
 *  - then two tasks: load three pallets onto the truck, and put a pallet on
 *    the top level of the rack – each judged by its time and the faults
 *    the instructor noted meanwhile, with a score and up to three stars.
 */
import type { YardFrame } from './ce.ts';
import { euroPallet, inBox, engagement } from '../sim/forklift.ts';
import type { ForkFrame, OBox, Pallet, PalletDef, Shelf } from '../sim/forklift.ts';

const NORTH = 0;

/** Where the forklift starts: facing north (−w), the first pallet ahead of it. */
export const FORK_START = { u: -28, w: 4, yaw: NORTH };

/** The rack: the first upright's u, the bays' width and number, its front and back (w), the beams' tops, the uprights' height. */
export const RACK = { u0: -14, bay: 2.3, bays: 3, wFront: -10.0, wBack: -11.1, levels: [1.6, 3.1], height: 3.9, beam: 0.12, upright: 0.1 };

/** The flatbed truck: its floor (and its height), the chassis under it, its cab, its headboard, its wheels. */
export const TRUCK = {
  bed: { u0: -4, u1: 3.5, w0: 4.0, w1: 6.45, y: 1.25 },
  chassis: { u0: -4, u1: 3.5, w0: 4.4, w1: 6.05, y0: 0.25, y1: 1.1 },
  cab: { u0: 3.6, u1: 5.9, w0: 3.95, w1: 6.5, y0: 0.4, y1: 3.0 },
  head: { u0: 3.42, u1: 3.55, w0: 4.0, w1: 6.45, y0: 1.25, y1: 2.6 },
  wheels: [-2.6, -1.25, 4.6] as readonly number[],
  wheelR: 0.5,
};

/** The green place of the guided start (its middle and half its sides). */
export const GUIDE_ZONE = { u: -22, w: 6, hu: 0.9, hw: 1.1 };

/** The paved floor of the place, for the drawing. */
export const FORK_AREA = { u0: -34, u1: 9, w0: -14, w1: 11 };

/** The pallets: their ids, where they stand (u, w, the level: 0 the ground, 1 and 2 the rack's beams), what they carry. */
interface PalletPlan {
  id: string;
  u: number;
  w: number;
  level: number;
  def: PalletDef;
}

/** The middle of a slot of the rack: bay, left (0) or right (1). */
export function slotOf(bay: number, slot: number): { u: number; w: number } {
  const mid = RACK.u0 + RACK.bay * (bay + 0.5);
  return { u: mid + (slot === 0 ? -0.55 : 0.55), w: (RACK.wFront + RACK.wBack) / 2 };
}

const CRATE: PalletDef = { len: 1.2, wid: 0.8, base: 0.144, goods: 1.0, mass: 3600, kind: 3 };

function plan(): PalletPlan[] {
  const rack = (id: string, bay: number, slot: number, level: number, goods: number, mass: number, kind: number): PalletPlan => ({ id, ...slotOf(bay, slot), level, def: euroPallet(goods, mass, kind) });
  return [
    { id: 'guide', u: -28, w: -3, level: 0, def: euroPallet(0.9, 420, 0) },
    { id: 'load1', u: -19.6, w: -4, level: 0, def: euroPallet(1.1, 640, 0) },
    { id: 'load2', u: -18.2, w: -4, level: 0, def: euroPallet(0.8, 780, 1) },
    { id: 'load3', u: -16.8, w: -4, level: 0, def: euroPallet(1.0, 560, 2) },
    { id: 'top', u: slotOf(1, 0).u, w: -5.2, level: 0, def: euroPallet(0.9, 520, 0) },
    { id: 'crate', u: -2, w: -6, level: 0, def: CRATE },
    // (what stands in the rack already)
    rack('r1', 0, 0, 1, 1.0, 600, 0),
    rack('r2', 0, 1, 2, 0.8, 450, 1),
    rack('r3', 1, 1, 1, 1.1, 700, 0),
    rack('r4', 2, 0, 2, 0.9, 500, 0),
    rack('r5', 2, 1, 1, 1.0, 650, 2),
    rack('r6', 0, 1, 0, 1.0, 800, 1),
    rack('r7', 2, 0, 0, 1.1, 700, 0),
  ];
}

/** The place in the world: what stands in the forklift's way, what pallets can be set down on, the pallets, the green place, the truck's floor. */
export interface ForkSite {
  y0: number;
  obstacles: OBox[];
  shelves: Shelf[];
  pallets: Pallet[];
  zone: OBox;
  bed: Shelf;
  /** the slot of the top level the pallet is to go into */
  topSlot: OBox;
}

/**
 * The place laid out in the world from the yard's frame; `y0`: the floor's
 * height (the place is flat), `ground`: the map's ground, for the pallets.
 */
export function buildSite(frame: YardFrame, y0: number, ground: (x: number, z: number) => number): ForkSite {
  const yaw = frame.yawToWorld(0);
  const box = (u0: number, u1: number, w0: number, w1: number, ya: number, yb: number): OBox => {
    const [x, z] = frame.toWorld((u0 + u1) / 2, (w0 + w1) / 2);
    return { x, z, hx: Math.abs(u1 - u0) / 2, hz: Math.abs(w1 - w0) / 2, yaw, y0: y0 + ya, y1: y0 + yb };
  };
  const obstacles: OBox[] = [];
  const shelves: Shelf[] = [];
  const R = RACK;
  const h = R.upright / 2;
  for (let k = 0; k <= R.bays; k++) {
    const u = R.u0 + k * R.bay;
    for (const w of [R.wFront, R.wBack]) obstacles.push(box(u - h, u + h, w - h, w + h, 0, R.height));
  }
  for (let b = 0; b < R.bays; b++) {
    const ua = R.u0 + b * R.bay + h;
    const ub = R.u0 + (b + 1) * R.bay - h;
    R.levels.forEach((lv, i) => {
      obstacles.push(box(ua, ub, R.wFront - 0.08, R.wFront, lv - R.beam, lv));
      obstacles.push(box(ua, ub, R.wBack, R.wBack + 0.08, lv - R.beam, lv));
      const s = box(ua, ub, R.wBack, R.wFront, lv, lv);
      shelves.push({ ...s, id: `rack${i + 1}:${b}`, y: y0 + lv });
    });
  }
  const T = TRUCK;
  obstacles.push(box(T.bed.u0, T.bed.u1, T.bed.w0, T.bed.w1, T.bed.y - 0.15, T.bed.y));
  obstacles.push(box(T.chassis.u0, T.chassis.u1, T.chassis.w0, T.chassis.w1, T.chassis.y0, T.chassis.y1));
  obstacles.push(box(T.cab.u0, T.cab.u1, T.cab.w0, T.cab.w1, T.cab.y0, T.cab.y1));
  obstacles.push(box(T.head.u0, T.head.u1, T.head.w0, T.head.w1, T.head.y0, T.head.y1));
  for (const u of T.wheels) obstacles.push(box(u - T.wheelR, u + T.wheelR, T.bed.w0 + 0.05, T.bed.w1 - 0.05, 0, 2 * T.wheelR));
  const bedBox = box(T.bed.u0, T.bed.u1, T.bed.w0, T.bed.w1, T.bed.y, T.bed.y);
  const bed: Shelf = { ...bedBox, id: 'truck', y: y0 + T.bed.y };
  shelves.push(bed);
  const pallets: Pallet[] = plan().map((p) => {
    const [x, z] = frame.toWorld(p.u, p.w);
    const g = ground(x, z);
    const y = p.level === 0 ? (Number.isFinite(g) ? g : y0) : y0 + R.levels[p.level - 1];
    const bay = Math.floor((p.u - R.u0) / R.bay);
    return { id: p.id, def: p.def, x, y, z, yaw, fork: null, on: p.level === 0 ? 'ground' : `rack${p.level}:${bay}` };
  });
  const Z = GUIDE_ZONE;
  const zone = box(Z.u - Z.hu, Z.u + Z.hu, Z.w - Z.hw, Z.w + Z.hw, 0, 0);
  const ts = slotOf(1, 0);
  const topSlot = box(ts.u - 0.45, ts.u + 0.45, R.wBack, R.wFront, R.levels[1], R.levels[1]);
  return { y0, obstacles, shelves, pallets, zone, bed, topSlot };
}

/** Is the whole of a pallet's footprint within a box (with a margin)? */
export function footprintIn(p: Pallet, b: OBox, margin: number): boolean {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  const hx = p.def.wid / 2;
  const hz = p.def.len / 2;
  for (const [ax, az] of [
    [-hx, -hz],
    [hx, -hz],
    [hx, hz],
    [-hx, hz],
  ]) {
    if (!inBox(b, p.x + ax * c + az * s, p.z - ax * s + az * c, margin)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------- the tasks

/** What the tasks see of the forklift now. */
export interface ForkSnapshot {
  time: number;
  forks: ForkFrame;
  lift: number;
  tilt: number;
  speed: number;
  ground: number;
  load: Pallet | null;
  pallets: readonly Pallet[];
  /** the load moment now (1: the rear wheels lift) */
  moment: number;
  tipped: boolean;
}

export interface ForkResult {
  /** the task's name (a text key) */
  text: string;
  time: number;
  score: number;
  stars: number;
  minor: number;
  major: number;
  /** the highest load moment (of the tipping limit) */
  peak: number;
}

const GUIDE_STEPS = ['approach', 'lift', 'tilt', 'drive', 'setdown'] as const;
const TASKS = [
  { id: 'truck', text: 'forkTask.truck', par: 300 },
  { id: 'top', text: 'forkTask.top', par: 200 },
] as const;

/** The guided start and the tasks, judged as they go. */
export class ForkTasks {
  readonly site: ForkSite;
  stage: 'guide' | 'task' | 'done' = 'guide';
  /** the step of the guided start */
  step = 0;
  /** the task (of TASKS) */
  task = 0;
  readonly results: ForkResult[] = [];
  private began = 0;
  private minor = 0;
  private major = 0;
  private peak = 0;
  private guideBegan = 0;
  private started = false;

  constructor(site: ForkSite) {
    this.site = site;
  }

  get taskCount(): number {
    return TASKS.length;
  }

  private pallet(id: string): Pallet {
    return this.site.pallets.find((p) => p.id === id) as Pallet;
  }

  /** A fault the instructor noted: it counts against the task going on. */
  fault(severity: string): void {
    if (severity === 'major' || severity === 'fail') this.major++;
    else if (severity === 'minor') this.minor++;
  }

  /** The forks are out of every pallet and the forklift stands clear. */
  private forksOut(s: ForkSnapshot): boolean {
    if (s.load) return false;
    for (const p of s.pallets) if (engagement(s.forks, p).depth > 0) return false;
    return true;
  }

  /** The pallets on the truck's floor, wholly on it. */
  onTruck(): number {
    let n = 0;
    for (const id of ['load1', 'load2', 'load3']) {
      const p = this.pallet(id);
      if (p.on === 'truck' && footprintIn(p, this.site.bed, 0.05)) n++;
    }
    return n;
  }

  /** The pallets to be highlighted now, and the place they go to. */
  targets(): { pallets: string[]; zone: OBox | null; bed: boolean } {
    if (this.stage === 'guide') return { pallets: this.step < 4 && this.pallet('guide').on !== 'forks' ? ['guide'] : [], zone: this.step >= 3 ? this.site.zone : null, bed: false };
    if (this.stage === 'done') return { pallets: [], zone: null, bed: false };
    if (TASKS[this.task].id === 'truck') return { pallets: ['load1', 'load2', 'load3'].filter((id) => this.pallet(id).on !== 'truck' && this.pallet(id).on !== 'forks'), zone: null, bed: true };
    const t = this.pallet('top');
    return { pallets: t.on === 'forks' || t.on.startsWith('rack2') ? [] : ['top'], zone: this.site.topSlot, bed: false };
  }

  /** What happened: a step of the guide done, a task done (its result is the last), all done. */
  update(s: ForkSnapshot): { stepDone: boolean; taskDone: boolean; allDone: boolean } {
    const out = { stepDone: false, taskDone: false, allDone: false };
    if (!this.started) {
      this.started = true;
      this.guideBegan = s.time;
    }
    this.peak = Math.max(this.peak, s.moment);
    if (this.stage === 'done' || s.tipped) return out;
    if (this.stage === 'guide') {
      const g = this.pallet('guide');
      const onForks = g.on === 'forks';
      const above = g.y - s.ground;
      // (put down again before its place: from the start)
      if (this.step >= 1 && this.step <= 3 && !onForks) this.step = 0;
      const done = [
        () => onForks || (engagement(s.forks, g).fits && engagement(s.forks, g).depth >= 0.85),
        () => onForks && above > 0.07 && above < 0.45,
        () => onForks && s.tilt >= (2 * Math.PI) / 180,
        () => onForks && Math.hypot(g.x - this.site.zone.x, g.z - this.site.zone.z) < 1.6,
        () => !onForks && g.on === 'ground' && inBox(this.site.zone, g.x, g.z, 0.3) && engagement(s.forks, g).depth === 0 && s.lift < 0.35,
      ][this.step];
      if (done()) {
        this.step++;
        out.stepDone = true;
        if (this.step >= GUIDE_STEPS.length) {
          this.results.push(this.judge('forkTask.guide', s.time - this.guideBegan, 240));
          this.beginTask(s.time);
          out.taskDone = true;
        }
      }
      return out;
    }
    const t = TASKS[this.task];
    let done = false;
    if (t.id === 'truck') done = this.onTruck() === 3 && this.forksOut(s);
    else {
      const p = this.pallet('top');
      const sh = this.site.shelves.find((x) => x.id === p.on);
      done = p.on.startsWith('rack2') && !!sh && footprintIn(p, sh, 0.12) && this.forksOut(s) && s.lift < 0.5;
    }
    if (done) {
      this.results.push(this.judge(t.text, s.time - this.began, t.par));
      out.taskDone = true;
      this.task++;
      if (this.task >= TASKS.length) {
        this.stage = 'done';
        out.allDone = true;
      } else this.beginTask(s.time);
    }
    return out;
  }

  private beginTask(now: number): void {
    this.stage = 'task';
    this.began = now;
    this.minor = 0;
    this.major = 0;
    this.peak = 0;
  }

  /** A task's score: 100, less for each fault, less for a long time beyond its par. */
  private judge(text: string, time: number, par: number): ForkResult {
    const slow = Math.min(30, Math.max(0, (time - par) / 5));
    const score = Math.max(0, Math.round(100 - 12 * this.minor - 30 * this.major - slow));
    const stars = score >= 85 ? 3 : score >= 65 ? 2 : score >= 40 ? 1 : 0;
    return { text, time, score, stars, minor: this.minor, major: this.major, peak: this.peak };
  }

  /** What to do now (text keys and their values) and a hint. */
  instruction(s: ForkSnapshot): { key: string; data: Record<string, string | number>; hint: string } {
    if (this.stage === 'guide') return { key: `forkGuide.${GUIDE_STEPS[Math.min(this.step, GUIDE_STEPS.length - 1)]}`, data: {}, hint: `forkGuide.${GUIDE_STEPS[Math.min(this.step, GUIDE_STEPS.length - 1)]}Hint` };
    if (this.stage === 'done') return { key: 'forkDone', data: {}, hint: '' };
    const t = TASKS[this.task];
    if (t.id === 'truck') return { key: s.load ? 'forkTask.truckCarry' : 'forkTask.truck', data: { n: this.onTruck(), max: 3 }, hint: 'forkTask.truckHint' };
    return { key: s.load?.id === 'top' ? 'forkTask.topCarry' : 'forkTask.top', data: {}, hint: 'forkTask.topHint' };
  }
}

