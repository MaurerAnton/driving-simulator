// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The theory lessons as a mode of the game (a way to start from the main
 * menu): the list of situations, then one lesson after another on the
 * practice yard – its script played (game/theory.ts), drawn
 * (render/theory.ts) and explained in the bar at the foot of the screen
 * (ui/theory.ts).  The camera circles the scene and is turned and moved
 * closer by dragging and pinching (or the mouse and its wheel); a tap near
 * a vehicle answers a question about it.  With the spoken instructions on,
 * the texts are read out.
 *
 * Nothing of a drive runs meanwhile – no traffic, no rules, no HUD: game.ts
 * only hands over each frame and the camera.
 */
import * as THREE from 'three';
import type { App } from './app.ts';
import type { YardFrame } from './ce.ts';
import type { Input } from '../input/input.ts';
import type { Settings } from './settings.ts';
import type { SignRenderer } from '../render/signs.ts';
import { TheoryView } from '../render/theory.ts';
import type { StageFrame } from '../render/theory.ts';
import { TheoryPanel } from '../ui/theory.ts';
import type { TheoryBar } from '../ui/theory.ts';
import { formatUnit, localeOf, tr } from '../i18n/index.ts';
import { THEORY, TheoryRun, actorName, answerKey, prepare, theoryKeys } from './theory.ts';
import type { LessonDef, Scene } from './theory.ts';

/** What the mode needs of the game. */
export interface TheoryHost {
  app: App;
  ui: HTMLElement;
  settings: Settings;
  input: Input;
  signs: SignRenderer;
  yard: YardFrame;
  /** keep the ground, the trees and the far hills loaded and drawn round this point (each frame) */
  around(x: number, z: number): void;
  /** back to the main menu */
  close(): void;
}

/** which lessons were once answered all right (kept in the browser) */
const KEY = 'fahrsim-baunatal.theory.v1';

function loadDone(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as { done?: unknown }).done : null;
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveDone(done: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ done: [...done] }));
  } catch {
    /* (private mode: not kept) */
  }
}

export class TheoryMode {
  /** what the camera looks at (for the sky and the shadows) */
  readonly focus = new THREE.Vector3();
  private readonly host: TheoryHost;
  private readonly view: TheoryView;
  private readonly panel: TheoryPanel;
  private readonly frameOf: StageFrame;
  private phase: 'off' | 'list' | 'loading' | 'lesson' = 'off';
  private index = 0;
  private scene: Scene | null = null;
  private run: TheoryRun | null = null;
  /** what the bar shows (it is drawn anew when this changes) */
  private shown = '';
  private readonly done = loadDone();
  private readonly cam = { yaw: 0, pitch: -0.6, dist: 34, panX: 0, panZ: 0, ready: false };
  private readonly target = new THREE.Vector3();
  private down: { x: number; y: number; t: number; id: number } | null = null;
  /** frames drawn since the lesson's place was laid out (for the automated pictures) */
  private builtFrames = 0;
  /** ?theoryAt=<s>: the first lesson opened starts at that moment of its script (for pictures of it) */
  private jump = typeof location === 'undefined' ? NaN : Number(new URLSearchParams(location.search).get('theoryAt') ?? NaN);

  constructor(host: TheoryHost) {
    this.host = host;
    this.view = new TheoryView(host.signs);
    host.app.scene.add(this.view.group);
    this.panel = new TheoryPanel(host.ui, (k, vars) => tr(k, this.lang, vars));
    // the stage's north (where the learner drives) along the yard's long side
    const yard = host.yard;
    this.frameOf = {
      toWorld: (x, z) => yard.toWorld(-z, x),
      yawToWorld: (yaw) => yard.yawToWorld(yaw - Math.PI / 2),
    };
    // a tap on the picture (not a drag): an answer, when it is near a vehicle a question is about
    const canvas = host.app.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      if (this.phase === 'lesson') this.down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || d.id !== e.pointerId || this.phase !== 'lesson') return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12 || performance.now() - d.t > 700) return;
      this.tap(e.clientX, e.clientY);
    });
  }

  private get lang(): string {
    return this.host.settings.lang;
  }

  /** the lesson laid out and drawn for a few frames (for the automated pictures) */
  get ready(): boolean {
    return this.phase === 'lesson' && this.builtFrames > 3;
  }

  /** Into the mode: the list – or straight into one lesson (by its id). */
  open(id?: string): void {
    const i = id ? THEORY.findIndex((l) => l.id === id) : -1;
    this.cam.ready = false;
    if (i >= 0) this.start(i);
    else this.showList();
  }

  /** Out of the mode (the main menu takes over). */
  close(): void {
    this.phase = 'off';
    this.view.hide();
    this.panel.hide();
    this.scene = null;
    this.run = null;
    this.shown = '';
    this.silence();
  }

  /** Escape: from a lesson to the list, from the list to the main menu. */
  back(): void {
    if (this.phase === 'lesson' || this.phase === 'loading') this.showList();
    else this.host.close();
  }

  private showList(): void {
    this.phase = 'list';
    this.view.hide();
    this.scene = null;
    this.run = null;
    this.shown = '';
    this.silence();
    const items = THEORY.map((l) => ({ id: l.id, title: tr(theoryKeys.title(l.id), this.lang), intro: tr(theoryKeys.intro(l.id), this.lang), done: this.done.has(l.id) }));
    this.panel.showList(
      items,
      (id) => this.start(THEORY.findIndex((l) => l.id === id)),
      () => this.host.close(),
    );
  }

  private start(i: number): void {
    this.index = Math.max(0, Math.min(THEORY.length - 1, i));
    this.phase = 'loading';
    this.scene = prepare(THEORY[this.index]);
    this.run = null;
    this.builtFrames = 0;
    this.shown = '';
    this.silence();
    this.drawBar();
  }

  private get lesson(): LessonDef {
    return THEORY[this.index];
  }

  // ------------------------------------------------------------------ each frame
  frame(dt: number, now: number): void {
    const app = this.host.app;
    const scene = this.scene;
    if (this.phase === 'loading' && scene) {
      // (the yard and what is round it are loaded first)
      const [cx, cz] = this.frameOf.toWorld(0, 10);
      this.host.around(cx, cz);
      this.overview(now);
      if (app.tiles.settled && this.view.build(scene, this.frameOf, (x, z) => app.tiles.heightAt(x, z))) {
        this.phase = 'lesson';
        this.run = new TheoryRun(scene);
        if (Number.isFinite(this.jump) && this.jump > 0) {
          this.run.skipTo(this.jump);
          this.jump = NaN;
        }
        this.resetCamera();
        this.view.update(this.run.t, now);
        this.speak(`${tr(theoryKeys.title(this.lesson.id), this.lang)}. ${tr(theoryKeys.intro(this.lesson.id), this.lang)}`);
        this.drawBar();
      }
      return;
    }
    if (this.phase === 'list' || this.phase === 'off') {
      const [cx, cz] = this.frameOf.toWorld(0, 10);
      this.host.around(cx, cz);
      this.overview(now);
      return;
    }
    const run = this.run;
    if (!run || !scene) return;
    this.builtFrames++;
    if (run.advance(dt)) this.stopped();
    this.view.update(run.t, now);
    // the names over the vehicles the open question is about; "you" over the learner's car all along
    const step = run.current;
    const names = new Map<string, string>();
    if (run.phase === 'ask' && step) {
      for (const a of step.answers) {
        const actor = this.lesson.actors.find((x) => x.id === a);
        if (actor) names.set(a, tr(actorName(actor), this.lang));
      }
    }
    this.view.setLabels(names, tr('theory.who.me', this.lang));
    this.view.placeLabels(now);
    this.view.showZone(run.phase === 'ask' && step?.blind ? step.blind : null);
    const gap = this.lesson.gap;
    if (gap && run.t >= gap.t0 && run.t <= gap.t1) this.view.showGap(gap.a, gap.b, (m) => formatUnit(m, 'meter', this.lang, 1));
    else this.view.showGap(null, null, () => '');
    this.camera(dt);
    const [fx, fz] = [this.focus.x, this.focus.z];
    this.host.around(fx, fz);
    this.drawBar();
  }

  /** The scene stopped: a question, or the end. */
  private stopped(): void {
    const run = this.run as TheoryRun;
    const l = this.lesson;
    if (run.phase === 'ask' && run.current) {
      const n = run.step + 1;
      this.speak(`${tr(theoryKeys.text(l.id, n), this.lang)} ${tr(theoryKeys.ask(l.id, n, run.current), this.lang)}`);
    } else if (run.phase === 'end') {
      const all = run.right === l.steps.length;
      if (all && !this.done.has(l.id)) {
        this.done.add(l.id);
        saveDone(this.done);
      }
      this.speak(this.score());
    }
  }

  private score(): string {
    const run = this.run as TheoryRun;
    return tr('theory.score', this.lang, { right: run.right, count: this.lesson.steps.length });
  }

  private answer(id: string): void {
    const run = this.run;
    if (!run || run.phase !== 'ask') return;
    const n = run.step + 1;
    const ok = run.answer(id);
    if (ok === null) return;
    this.speak(`${tr(ok ? 'theory.right' : 'theory.wrong', this.lang)} ${tr(theoryKeys.why(this.lesson.id, n), this.lang)}`);
    this.drawBar();
  }

  /** A tap at a point of the screen: the vehicle there, if the open question is about it. */
  private tap(cx: number, cy: number): void {
    const run = this.run;
    const step = run?.current;
    if (!run || run.phase !== 'ask' || !step) return;
    const ids = step.answers.filter((a) => this.lesson.actors.some((x) => x.id === a));
    if (ids.length === 0) return;
    const rect = this.host.app.canvas.getBoundingClientRect();
    const id = this.view.pick(ids, this.host.app.camera, cx - rect.left, cy - rect.top, rect.width, rect.height);
    if (id) this.answer(id);
  }

  // ------------------------------------------------------------------- the bar
  private drawBar(): void {
    const l = this.lesson;
    const run = this.run;
    const phase: TheoryBar['phase'] = this.phase === 'loading' || !run ? 'loading' : run.phase === 'end' ? 'end' : run.phase;
    const key = `${this.index}|${phase}|${run?.step ?? 0}|${run?.picked ?? ''}|${this.lang}`;
    if (key === this.shown) return;
    this.shown = key;
    const step = run?.current ?? null;
    const n = (run?.step ?? 0) + 1;
    const lang = this.lang;
    const bar: TheoryBar = {
      n: this.index + 1,
      count: THEORY.length,
      title: tr(theoryKeys.title(l.id), lang),
      phase,
      // (playing: the introduction – after a question, the reason just given, to read while it plays on)
      text: phase === 'play' ? tr(run && run.step > 0 ? theoryKeys.why(l.id, run.step) : theoryKeys.intro(l.id), lang) : step ? tr(theoryKeys.text(l.id, n), lang) : '',
      ask: step ? tr(theoryKeys.ask(l.id, n, step), lang) : '',
      answers: step ? step.answers.map((a) => ({ id: a, label: tr(answerKey(l, n, a), lang) })) : [],
      picked: run?.picked ?? null,
      right: step?.right ?? '',
      why: step ? tr(theoryKeys.why(l.id, n), lang) : '',
      ref: step?.ref ?? '',
      score: run ? this.score() : '',
      hasNext: this.index < THEORY.length - 1,
    };
    this.panel.show(bar, {
      answer: (id) => this.answer(id),
      goOn: () => {
        this.silence();
        this.run?.goOn();
        this.drawBar();
      },
      again: () => this.start(this.index),
      next: () => this.start(this.index + 1),
      list: () => this.showList(),
    });
  }

  // ----------------------------------------------------------------- the camera
  /** The lesson's own view: from where its script says, the drag and the zoom forgotten. */
  private resetCamera(): void {
    const v = this.lesson.view;
    const c = this.cam;
    c.yaw = this.frameOf.yawToWorld(v.yaw);
    c.pitch = v.pitch;
    c.dist = v.dist;
    c.panX = 0;
    c.panZ = 0;
    c.ready = false;
    this.host.input.takeCam();
  }

  /** Circling what the lesson looks at: turned by dragging, closer and further by pinching or the wheel, moved with two fingers or the right mouse button. */
  private camera(dt: number): void {
    const app = this.host.app;
    const c = this.cam;
    const t = this.host.input.takeCam();
    if (t.reset) this.resetCamera();
    c.yaw += t.yaw;
    c.pitch = Math.max(-1.45, Math.min(-0.12, c.pitch + t.pitch));
    c.dist = Math.max(8, Math.min(130, c.dist * Math.exp(-t.dolly)));
    // (moving: in the directions the camera looks, by parts of its distance)
    const sy = Math.sin(c.yaw);
    const cy = Math.cos(c.yaw);
    const right = t.right * c.dist;
    const fwd = t.fwd * c.dist;
    c.panX += cy * right - sy * fwd;
    c.panZ += -sy * right - cy * fwd;
    const pan = Math.hypot(c.panX, c.panZ);
    if (pan > 80) {
      c.panX *= 80 / pan;
      c.panZ *= 80 / pan;
    }
    // what it looks at: a point of the place, or a vehicle it follows (a little ahead of it)
    const v = this.lesson.view;
    if (typeof v.at === 'string') {
      if (this.view.where(v.at, this.target)) {
        const h = this.view.heading(v.at) ?? 0;
        this.target.x -= Math.sin(h) * (v.ahead ?? 0);
        this.target.z -= Math.cos(h) * (v.ahead ?? 0);
      }
    } else {
      const [x, z] = this.frameOf.toWorld(v.at[0], v.at[1]);
      const y = app.tiles.heightAt(x, z);
      this.target.set(x, Number.isNaN(y) ? this.focus.y : y + 1, z);
    }
    this.target.x += c.panX;
    this.target.z += c.panZ;
    if (!c.ready) {
      this.focus.copy(this.target);
      c.ready = true;
    } else this.focus.lerp(this.target, 1 - Math.exp(-dt * 5));
    const cam = app.camera;
    const cp = Math.cos(c.pitch);
    cam.position.set(this.focus.x + sy * cp * c.dist, this.focus.y - Math.sin(c.pitch) * c.dist, this.focus.z + cy * cp * c.dist);
    const g = app.tiles.heightAt(cam.position.x, cam.position.z);
    if (!Number.isNaN(g)) cam.position.y = Math.max(cam.position.y, g + 1.5);
    cam.fov = 55;
    cam.near = 0.3;
    cam.lookAt(this.focus);
    // (a little further down: what it looks at stands above the middle of the picture, clear of the bar at its foot)
    cam.rotateX(-0.09);
    cam.updateProjectionMatrix();
  }

  /** Behind the list and while a place is laid out: the yard from above, slowly circled. */
  private overview(now: number): void {
    const app = this.host.app;
    const [cx, cz] = this.frameOf.toWorld(0, 10);
    const gy = app.tiles.heightAt(cx, cz);
    const base = Number.isNaN(gy) ? this.focus.y : gy;
    this.focus.set(cx, base + 1, cz);
    const a = now * 0.04;
    const cam = app.camera;
    cam.position.set(cx + Math.cos(a) * 110, base + 70, cz + Math.sin(a) * 110);
    cam.fov = 55;
    cam.near = 0.5;
    cam.lookAt(this.focus);
    cam.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------- voice
  /** Read a text out – when the spoken instructions are on (as the directions of a drive are). */
  private speak(text: string): void {
    const s = this.host.settings;
    if (!s.voice || typeof window === 'undefined' || !('speechSynthesis' in window) || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = localeOf(this.lang);
    u.volume = s.volume;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  private silence(): void {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window && this.host.settings.voice) window.speechSynthesis.cancel();
  }
}
