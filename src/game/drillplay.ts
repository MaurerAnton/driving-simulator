// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The basic tasks of class B on the practice yard as the game (game.ts)
 * runs them – one after the other, as a lesson lists them:
 *
 *  - each task is laid out on the yard (render/yard.ts draws its asphalt,
 *    lines and cones, render/drillyard.ts its parked cars, kerb stones and
 *    the ramp's sides); the ground under the wheels is asphalt there, and
 *    the ramp of the hill start raises it (`raise`, for sim/ground.ts);
 *  - the judge (game/drills.ts) is told each moment where the car is; what
 *    to do now goes into the street-name block, the instructor's remarks
 *    into the tip line, the faults to the instructor's log;
 *  - a task that went wrong may be repeated once, as in the test (its
 *    faults that end it count as serious ones the first time);
 *  - each finished task gets a score and up to three stars, shown when it
 *    is done and on the result page.
 */
import { tr } from '../i18n/index.ts';
import type { DrillScene } from '../render/drillyard.ts';
import type { YardScene } from '../render/yard.ts';
import type { YardFrame } from './ce.ts';
import { offArea } from './ce.ts';
import { DrillJudge, MAX_CORRECTIONS, hillRise } from './drills.ts';
import type { CarShape, DrillFault, DrillId, DrillLayout, DrillResult } from './drills.ts';

/** What the game tells the run each moment (world coordinates; the pose of the model origin). */
export interface DrillDrive {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  handbrake: boolean;
  brake: number;
  engine: boolean;
}

/** What happened in a step, for the game to do. */
export interface DrillEvents {
  /** the faults, with the severity to note them with */
  faults: DrillFault[];
  /** the instructor's remark (already in the player's language; '' for none) */
  remark: string;
  /** the emergency stop's signal: now */
  signal: boolean;
  /** hold the car where it is (it ran into a parked one) */
  stop: boolean;
  /** 'again': the task once more from its start; 'next': the next task's start; 'over': all done (or failed twice) */
  next: '' | 'again' | 'next' | 'over';
}

const stars = (n: number): string => '★'.repeat(n) + '☆'.repeat(3 - n);

export class DrillRun {
  readonly ids: readonly DrillId[];
  private idx = 0;
  judge: DrillJudge;
  /** this is the task's second try */
  second = false;
  readonly results: DrillResult[] = [];
  /** a task failed twice */
  failed = false;
  private readonly frame: YardFrame;
  private readonly shape: CarShape;
  private readonly yardScene: YardScene;
  private readonly scene: DrillScene;
  private readonly lang: () => string;
  private readonly rand: () => number;
  private laid = false;
  private laidTry = -10;
  private now = 0;
  /** when the run is over (after the last remark has been read) */
  private overAt = -1;
  private readonly ev: DrillEvents = { faults: [], remark: '', signal: false, stop: false, next: '' };

  constructor(ids: readonly DrillId[], frame: YardFrame, shape: CarShape, yardScene: YardScene, scene: DrillScene, lang: () => string, rand: () => number = Math.random) {
    this.ids = ids;
    this.frame = frame;
    this.shape = shape;
    this.yardScene = yardScene;
    this.scene = scene;
    this.lang = lang;
    this.rand = rand;
    this.judge = new DrillJudge(ids[0], shape, rand);
  }

  get layout(): DrillLayout {
    return this.judge.layout;
  }

  /** Where the car stands at the start of the task now (world). */
  start(): { x: number; z: number; yaw: number } {
    return this.frame.poseToWorld(this.layout.start);
  }

  /** the yard is asphalt where the task is (sim/ground.ts `paved`) */
  readonly paved = (x: number, z: number): boolean => {
    const [u, w] = this.frame.toLocal(x, z);
    return offArea(this.layout, u, w, 1.2) === 0;
  };

  /** how much the ramp raises the ground (sim/ground.ts `raise`) */
  readonly raise = (x: number, z: number): number => {
    const h = this.layout.hill;
    if (!h) return 0;
    const [u, w] = this.frame.toLocal(x, z);
    return hillRise(h, u, w);
  };

  /** Lay the task out on the yard (again, now and then, until the ground under it is loaded). */
  private lay(heightAt: (x: number, z: number) => number): void {
    if (this.laid || Math.abs(this.now - this.laidTry) < 0.7) return;
    this.laidTry = this.now;
    const withRamp = (x: number, z: number): number => heightAt(x, z) + this.raise(x, z);
    const a = this.yardScene.show(this.frame, this.layout, withRamp);
    const b = this.scene.show(this.frame, this.layout, withRamp);
    this.laid = a && b;
  }

  /** One step of the task: judge it, and say what the game is to do. */
  update(dt: number, d: DrillDrive, heightAt: (x: number, z: number) => number): DrillEvents {
    this.now += dt;
    const ev = this.ev;
    ev.faults.length = 0;
    ev.remark = '';
    ev.signal = false;
    ev.stop = false;
    ev.next = '';
    const lang = this.lang();
    this.lay(heightAt);
    if (this.overAt >= 0) {
      if (this.now >= this.overAt) ev.next = 'over';
      return ev;
    }
    const j = this.judge;
    const st = j.update({ pose: this.frame.poseToLocal({ x: d.x, z: d.z, yaw: d.yaw }), speed: d.speed, handbrake: d.handbrake, brake: d.brake, engine: d.engine }, dt);
    // (the first try: a fault that ends the task is a serious one – the task is repeated)
    for (const f of st.faults) ev.faults.push(f.severity === 'fail' && !this.second ? { ...f, severity: 'major' } : f);
    if (st.remark) ev.remark = tr(st.remark, lang, st.remarkData);
    ev.signal = st.signal;
    ev.stop = st.stop;
    if (st.state === 'run') return ev;
    if (st.state === 'failed' && !this.second) {
      this.second = true;
      this.next(this.ids[this.idx]);
      ev.next = 'again';
      ev.remark = [ev.remark, tr('drill.again', lang)].filter(Boolean).join(' ');
      return ev;
    }
    const r = j.result();
    this.results.push(r);
    ev.remark = [ev.remark, r.failed ? tr('drill.failed', lang, { name: tr(r.text, lang) }) : tr('drill.done', lang, { name: tr(r.text, lang), stars: stars(r.stars), score: r.score })].filter(Boolean).join(' ');
    if (r.failed) this.failed = true;
    if (!r.failed && this.idx + 1 < this.ids.length) {
      this.idx++;
      this.second = false;
      this.next(this.ids[this.idx]);
      ev.next = 'next';
      return ev;
    }
    // (a moment to read the last remark, then the result)
    this.overAt = this.now + 3;
    return ev;
  }

  private next(id: DrillId): void {
    this.judge = new DrillJudge(id, this.shape, this.rand);
    this.laid = false;
    this.laidTry = -10;
  }

  /** What to do now – for the street-name block. */
  line(): string {
    const lang = this.lang();
    const lay = this.layout;
    const st = this.judge.status;
    const step = lay.steps[Math.min(st.step, lay.steps.length - 1)];
    return `${this.judge.status.step + 1}/${lay.steps.length} · ${tr(`drill.step.${step}`, lang)}`;
  }

  /** Below it: the task, its number, the corrections or what is measured. */
  sub(): string {
    const lang = this.lang();
    const j = this.judge;
    const st = j.status;
    const parts = [tr(`drill.${j.id}.name`, lang)];
    if (this.ids.length > 1) parts.push(tr('drill.sub.task', lang, { n: this.idx + 1, max: this.ids.length }));
    if (this.second) parts.push(tr('drill.sub.second', lang));
    if (j.layout.moves >= 0) parts.push(tr('drill.sub.corrections', lang, { n: st.corrections, max: MAX_CORRECTIONS }));
    if (Number.isFinite(st.kerb) && st.kerb < 3) parts.push(tr('drill.sub.kerb', lang, { d: Math.round(st.kerb * 100) }));
    if (j.id === 'hill' && st.step > 0) parts.push(tr('drill.sub.rollback', lang, { d: Math.round(st.rollback * 100) }));
    return parts.join(' · ');
  }

  /** The tasks as they went, for the result page (null: none was finished). */
  resultNode(): HTMLElement | null {
    if (this.results.length === 0) return null;
    const lang = this.lang();
    const box = document.createElement('div');
    box.className = 'crane-results';
    const head = document.createElement('p');
    head.className = 'crane-total';
    const total = Math.round(this.results.reduce((s, r) => s + r.score, 0) / this.results.length);
    const got = this.results.reduce((s, r) => s + r.stars, 0);
    head.textContent = tr('drillResult.total', lang, { done: this.results.filter((r) => !r.failed).length, max: this.ids.length, score: total, stars: got, all: 3 * this.ids.length });
    box.append(head);
    this.results.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = `fault ${r.stars >= 2 ? 'hint' : r.stars === 1 ? 'minor' : 'major'}`;
      const b = document.createElement('b');
      b.textContent = `${i + 1} · ${tr(r.text, lang)}  ${stars(r.stars)}`;
      const small = document.createElement('small');
      const min = Math.floor(r.time / 60);
      const sec = Math.round(r.time % 60);
      const line = r.failed ? tr('drillResult.failed', lang) : tr('drillResult.line', lang, { score: r.score, time: `${min}:${String(sec).padStart(2, '0')}`, minor: r.minor, major: r.major });
      small.textContent = `${line} · ${tr(r.measure, lang, r.measureData)}`;
      row.append(b, small);
      box.append(row);
    });
    return box;
  }

  /** The drive ends: the yard goes. */
  hide(): void {
    this.yardScene.hide();
    this.scene.hide();
  }
}
