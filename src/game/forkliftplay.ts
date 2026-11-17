// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Driving a forklift on the practice yard – what the game (game.ts) runs
 * for it:
 *
 *  - the place is laid out on the practice yard once its ground is loaded
 *    (game/forklifttasks.ts says what is where, render/forkliftyard.ts
 *    draws it); without a practice yard, round the place the drive starts;
 *  - the forklift is simulated by sim/forklift.ts (not by the vehicles'
 *    physics): each frame the controls go in – the pedals, the wheel, the
 *    direction (the gear selector: D forwards, R backwards; P and the
 *    parking brake hold it) and the mast's keys or buttons
 *    (Input.forkInput, ui/forkliftpanel.ts) –, and the game's vehicle is
 *    put where the forklift is, so the cameras, the speedometer, the sound
 *    and the replay follow it;
 *  - the guided start and the tasks are judged as they go; what is done
 *    unsafely is told to the instructor: driving with the load raised or
 *    the mast tilted forwards, turning too fast, lifting more than the load
 *    chart allows, the rear wheels lifting, running into things, tipping
 *    over;
 *  - the street-name block says what to do, the forklift's display the
 *    load moment, the load and the mast;
 *  - a free drive (any way to play but "Forklift work" – `FORK_WORK_MODE`
 *    in game/forkliftmodes.ts, with the cameras and getting off and on)
 *    lays out no place: the forklift is driven where the menu put it, the
 *    buildings and walls of the map stopping it (`ForkliftHost.blocked`);
 *  - its cameras: from the side (where it starts), the operator's seat,
 *    behind it, the free camera (`ForkView`, V or the camera button);
 *  - the operator gets off (G, the door button, "Get out" in the pause
 *    menu) beside the seat, and on again within a few steps of it.
 */
import type { GameAudio } from '../audio/audio.ts';
import type { Controls, Input } from '../input/input.ts';
import { ForkliftModel } from '../render/forklift.ts';
import { ForkYardScene } from '../render/forkliftyard.ts';
import { FORKLIFT, Forklift, capacityAt } from '../sim/forklift.ts';
import type { ForkCommand, ForkEvents, ForkWorld } from '../sim/forklift.ts';
import type { Severity } from '../sim/rules.ts';
import type { Vehicle } from '../sim/vehicle/index.ts';
import { ForkPanel } from '../ui/forkliftpanel.ts';
import type { HudState } from '../ui/hud.ts';
import { tr } from '../i18n/index.ts';
import { YardFrame } from './ce.ts';
import { FORK_START, ForkTasks, buildSite } from './forklifttasks.ts';
import { forkliftExit, nearForklift, nextForkView } from './forkliftmodes.ts';
import type { ForkView } from './forkliftmodes.ts';
import type { ForkSite, ForkSnapshot } from './forklifttasks.ts';
import type { Settings } from './settings.ts';
import type * as THREE from 'three';

/** the forklift's simulation step */
const STEP = 1 / 120;
const DEG = Math.PI / 180;

/** What the forklift's work needs of the game. */
export interface ForkliftHost {
  readonly scene: THREE.Scene;
  readonly ui: HTMLElement;
  readonly settings: Settings;
  /** the practice yard (null: the map has none) */
  readonly yard: YardFrame | null;
  heightAt(x: number, z: number): number;
  readonly input: Input;
  readonly audio: GameAudio;
  /** tell the instructor of a fault (at a place; not again within `cooldown` seconds) */
  note(id: string, severity: Severity, x: number, z: number, data: Record<string, number | string>, cooldown: number): void;
  /** does the forklift standing here (its middle, its heading) run into a building or a wall of the map? (a free drive) */
  blocked?(x: number, y: number, z: number, yaw: number): boolean;
}

/** the place's drawing: one for the whole game, made the first time */
let yardScene: ForkYardScene | null = null;

function sceneOf(host: Pick<ForkliftHost, 'scene'>): ForkYardScene {
  if (!yardScene) {
    yardScene = new ForkYardScene();
    host.scene.add(yardScene.group);
  }
  return yardScene;
}

/** The middle of the place in the yard's frame (its floor's height is taken there). */
const MIDDLE = { u: -12, w: -2 };

/** Where the forklift starts on the practice yard (null: the map has none). */
export function forkliftStart(yard: YardFrame | null): { x: number; z: number; yaw: number } | null {
  if (!yard) return null;
  const [x, z] = yard.toWorld(FORK_START.u, FORK_START.w);
  return { x, z, yaw: yard.yawToWorld(FORK_START.yaw) };
}

/** The place behind the menu (the forklift chosen stands on it) – or taken away again (`on` false). */
export function forkliftMenuSite(host: Pick<ForkliftHost, 'scene' | 'yard' | 'settings'>, on: boolean, heightAt: (x: number, z: number) => number): void {
  if (!on || !host.yard) {
    yardScene?.hide();
    return;
  }
  const [mx, mz] = host.yard.toWorld(MIDDLE.u, MIDDLE.w);
  const y0 = heightAt(mx, mz);
  if (Number.isNaN(y0)) return;
  const s = sceneOf(host);
  s.show(host.yard, y0, host.settings.quality === 'low');
  const site = buildSite(host.yard, y0, heightAt);
  s.update(site.pallets, null, { pallets: [], zone: null, bed: false, slot: false }, 0);
}

/** Is a vehicle's model the forklift's? */
export function isForkliftModel(m: object): m is ForkliftModel {
  return m instanceof ForkliftModel;
}

/** The forklift on its place, from the start of the drive to its end. */
export class ForkliftWork {
  readonly f = new Forklift();
  private readonly host: ForkliftHost;
  /** the work on the forklift yard with its tasks (false: a free drive where the menu put it) */
  readonly siteOn: boolean;
  /** the camera (V goes through them) */
  view: ForkView = 'side';
  /** it has been driven (the tip how to start is said till then) */
  private moved = false;
  private readonly scene: ForkYardScene;
  private readonly panel: ForkPanel;
  private site: ForkSite | null = null;
  tasks: ForkTasks | null = null;
  private world: ForkWorld | null = null;
  /** all is done, or it tipped over: the drive is over (the game shows the result) */
  over = false;
  private overAt = -1;
  private time = 0;
  private laidTry = -10;
  private acc = 0;
  private readonly mpos = [0, 0, 0];
  private tip = '';
  private tipData: Record<string, string | number> = {};
  private tipUntil = 0;
  private beepT = 0;
  private warnT = 0;
  /** the pallet the overload was told for (once each time it is lifted) */
  private overloadTold = '';
  private readonly ev: ForkEvents = { hit: 0, picked: null, pickedDepth: 0, placed: null, relief: false, rearLift: false, sideLift: false, tipped: false };

  constructor(host: ForkliftHost, site = true) {
    this.host = host;
    this.siteOn = site;
    this.scene = sceneOf(host);
    this.panel = new ForkPanel(
      host.ui,
      () => host.settings.lang,
      (code, down) => host.input.press(code, down),
      () => host.audio.click('tick'),
    );
    host.ui.classList.add('forklifting');
  }

  // ---------------------------------------------------------------------------- the place

  /** Lay the place out once its ground is loaded; the forklift where its vehicle stands. */
  private layout(v: Vehicle): boolean {
    if (this.world) return true;
    if (this.time - this.laidTry < 0.5) return false;
    this.laidTry = this.time;
    v.getModelPosition(this.mpos);
    if (!this.siteOn) {
      // a free drive: no place laid out – the ground where it stands, nothing else of its own
      const y0 = this.host.heightAt(this.mpos[0], this.mpos[2]);
      if (Number.isNaN(y0)) return false;
      const ground = (x: number, z: number): number => {
        const h = this.host.heightAt(x, z);
        return Number.isFinite(h) ? h : y0;
      };
      this.world = { ground, obstacles: [], shelves: [], pallets: [] };
      this.f.place(this.mpos[0], ground(this.mpos[0], this.mpos[2]), this.mpos[2], v.yaw);
      return true;
    }
    // (no practice yard: the place round where the drive began, as if the yard were there)
    const frame = this.host.yard ?? new YardFrame({ x: this.mpos[0] - FORK_START.u, z: this.mpos[2] - FORK_START.w, len: 120, wid: 60, rot: 0 });
    const [mx, mz] = frame.toWorld(MIDDLE.u, MIDDLE.w);
    const y0 = this.host.heightAt(mx, mz);
    if (Number.isNaN(y0)) return false;
    const ground = (x: number, z: number): number => {
      const h = this.host.heightAt(x, z);
      return Number.isFinite(h) ? h : y0;
    };
    this.site = buildSite(frame, y0, ground);
    this.world = { ground, obstacles: this.site.obstacles, shelves: this.site.shelves, pallets: this.site.pallets };
    this.tasks = new ForkTasks(this.site);
    this.scene.show(frame, y0, this.host.settings.quality === 'low');
    this.f.place(this.mpos[0], ground(this.mpos[0], this.mpos[2]), this.mpos[2], v.yaw);
    return true;
  }

  // ---------------------------------------------------------------------------- each frame

  /** A frame of driving: the controls, the forklift's steps, the vehicle put where it is, the faults, the tasks. */
  step(dt: number, v: Vehicle, c: Controls): void {
    this.time += dt;
    v.engineRunning = true;
    if (!this.layout(v)) {
      v.speed = 0;
      return;
    }
    const w = this.world as ForkWorld;
    const f = this.f;
    const mast = this.host.input.forkInput();
    const auto = c.gear;
    const cmd: ForkCommand = {
      throttle: c.throttle,
      brake: c.brake,
      dir: auto === 1 ? 1 : auto === -1 ? -1 : 0,
      hold: c.handbrake > 0.5 || auto === -2,
      steer: c.steer,
      lift: mast.lift,
      tilt: mast.tilt,
      shift: mast.shift,
    };
    // the steps, and what happened in them all
    const ev = this.ev;
    Object.assign(ev, { hit: 0, picked: null, pickedDepth: 0, placed: null, relief: false, rearLift: false, sideLift: false, tipped: false });
    this.acc = Math.min(this.acc + dt, 0.1);
    const [px, pz, pyaw] = [f.x, f.z, f.yaw];
    while (this.acc >= STEP) {
      const e = f.step(STEP, cmd, w);
      ev.hit = Math.max(ev.hit, e.hit);
      if (e.picked) {
        ev.picked = e.picked;
        ev.pickedDepth = e.pickedDepth;
      }
      if (e.placed) ev.placed = e.placed;
      ev.relief ||= e.relief;
      ev.rearLift ||= e.rearLift;
      ev.sideLift ||= e.sideLift;
      ev.tipped ||= e.tipped;
      this.acc -= STEP;
    }
    // (a free drive: a building or a wall of the map stops it where it stood – unless it stood in one already)
    const bl = this.host.blocked;
    if (!this.siteOn && bl && (f.x !== px || f.z !== pz || f.yaw !== pyaw) && bl(f.x, f.y, f.z, f.yaw) && !bl(px, f.y, pz, pyaw)) {
      ev.hit = Math.max(ev.hit, Math.abs(f.v));
      f.x = px;
      f.z = pz;
      f.yaw = pyaw;
      f.v = 0;
    }
    if (Math.abs(f.v) > 0.5) this.moved = true;
    // the game's vehicle where the forklift is (the cameras, the speedometer, the sound follow it)
    v.teleport(f.x, f.y, f.z, f.yaw);
    v.speed = f.v;
    v.gear = cmd.dir;
    v.odometer += Math.abs(f.v) * dt;
    const work = Math.min(1, cmd.throttle + Math.abs(mast.lift) * 0.8 + Math.abs(mast.tilt) * 0.4 + Math.abs(mast.shift) * 0.3);
    v.rpm += (v.spec.idleRpm * (1 + work * 1.4) - v.rpm) * Math.min(1, dt * 4);
    v.engineLoad = work;
    this.sounds(ev, dt, cmd);
    this.faults(ev, dt);
    this.updateTasks();
  }

  private sounds(ev: ForkEvents, dt: number, cmd: ForkCommand): void {
    const a = this.host.audio;
    if (ev.hit > 0.3) a.click(ev.hit > 2 ? 'crash' : 'bump');
    if (ev.picked || ev.placed) a.click('clack');
    // the reversing alarm, and the warning when a wheel lifts
    const f = this.f;
    this.beepT -= dt;
    const lifting = f.pitch > 0.01 || f.roll > 0.01;
    if ((lifting || (cmd.dir < 0 && f.v < -0.1)) && this.beepT <= 0 && !f.tipped) {
      a.click('beep');
      this.beepT = lifting ? 0.25 : 0.7;
    }
  }

  private note(id: string, severity: Severity, data: Record<string, string | number> = {}, cooldown = 6): void {
    const f = this.f;
    this.host.note(id, severity, f.x, f.z, data, cooldown);
    this.tasks?.fault(severity);
  }

  private say(key: string, seconds: number, data: Record<string, string | number> = {}): void {
    this.tip = key;
    this.tipData = data;
    this.tipUntil = this.time + seconds;
  }

  /** What the instructor notes. */
  private faults(ev: ForkEvents, dt: number): void {
    const f = this.f;
    const load = f.load;
    const speed = Math.abs(f.v);
    if (ev.tipped) {
      this.note('forkliftTipped', 'fail', {}, 60);
      this.say(f.tipped === 'forward' ? 'forkTip.tippedForward' : 'forkTip.tippedSide', 6);
      return;
    }
    if (ev.picked) {
      const c = f.loadCentre();
      const allowed = capacityAt(c);
      if (ev.picked.def.mass > allowed && this.overloadTold !== ev.picked.id) {
        this.overloadTold = ev.picked.id;
        this.note('forkliftOverload', 'major', { kg: Math.round(ev.picked.def.mass), max: Math.round(allowed / 10) * 10 }, 3);
        this.say('forkTip.overload', 5, { kg: Math.round(ev.picked.def.mass), max: Math.round(allowed / 10) * 10 });
      }
      if (ev.pickedDepth < 0.8) {
        this.note('forkliftForksIn', 'minor', { p: Math.round(ev.pickedDepth * 100) }, 6);
        this.say('forkTip.forksIn', 4);
      }
    }
    if (ev.placed && this.overloadTold === ev.placed.id) this.overloadTold = '';
    if (ev.relief) this.say('forkTip.relief', 3);
    if (ev.rearLift) {
      this.note('forkliftRearLift', 'major', {}, 4);
      this.say('forkTip.rearLift', 4);
    }
    if (ev.sideLift) {
      this.note('forkliftTurnFast', 'major', { kmh: Math.round(speed * 3.6) }, 4);
      this.say('forkTip.sideLift', 4);
    }
    if (ev.hit > 0.7) this.note('forkliftHit', ev.hit > 2 ? 'major' : 'minor', { kmh: Math.round(ev.hit * 3.6) }, 3);
    // driving: the load low, the mast back, not too fast round the turns
    this.warnT = Math.max(0, this.warnT - dt);
    const st = f.stability();
    if (st.side > 0.8 && !ev.sideLift && f.roll === 0) this.note('forkliftTurnFast', 'minor', { kmh: Math.round(speed * 3.6) }, 6);
    if (load && speed > 0.6) {
      const above = load.y - f.y;
      if (above > 0.5) {
        this.note('forkliftLoadHigh', 'minor', { cm: Math.round(above * 100) }, 8);
        if (this.warnT <= 0) {
          this.say('forkTip.loadHigh', 3);
          this.warnT = 4;
        }
      }
      if (f.tilt < -1 * DEG) this.note('forkliftTiltForward', 'minor', {}, 8);
    } else if (!load && speed > 1.2 && f.lift > 0.6) this.note('forkliftForksHigh', 'hint', {}, 10);
  }

  private snapshot(): ForkSnapshot {
    const f = this.f;
    return { time: this.time, forks: f.forks(), lift: f.lift, tilt: f.tilt, speed: f.v, ground: f.y, load: f.load, pallets: this.site?.pallets ?? [], moment: f.stability().forward, tipped: f.tipped !== null };
  }

  private updateTasks(): void {
    const t = this.tasks;
    if (t) {
      const ev = t.update(this.snapshot());
      const a = this.host.audio;
      if (ev.stepDone) a.click('chime');
      if (ev.taskDone) {
        const r = t.results[t.results.length - 1];
        this.say('forkTip.taskDone', 4, { stars: '★'.repeat(r.stars) + '☆'.repeat(3 - r.stars), score: r.score });
      }
      if (ev.allDone && this.overAt < 0) this.overAt = this.time + 4;
    }
    // (tipped over – on the yard or on a free drive – the drive is over)
    if (this.f.tipped && this.overAt < 0) this.overAt = this.time + 5;
    if (this.overAt > 0 && this.time >= this.overAt) this.over = true;
  }

  // ---------------------------------------------------------------------------- what is shown

  /** Pose the model, the pallets and the marks; `inside`: seen from the operator's seat; `shown`: the display is shown (while driving). */
  render(model: ForkliftModel, now: number, inside: boolean, shown: boolean): void {
    this.panel.root.hidden = !shown;
    model.root.updateMatrixWorld(true);
    model.setOperator(!inside);
    model.pose(this.f, now);
    const t = this.tasks;
    if (!t || !this.site) return;
    const tg = t.targets();
    this.scene.update(this.site.pallets, this.f.load ? { yaw: this.f.yaw, tilt: this.f.tilt } : null, { pallets: tg.pallets, zone: tg.zone, bed: tg.bed, slot: tg.zone === this.site.topSlot }, now);
  }

  /** A tip of the game's in the tip line (while driving, the forklift's own tips take the line's place). */
  tell(key: string, seconds = 3): void {
    this.say(key, seconds);
  }

  /** Getting off: where the operator stands (null: not while it moves – stop first). */
  getOff(): { x: number; z: number; yaw: number } | null {
    const f = this.f;
    if (Math.abs(f.v) > 0.3 && !f.tipped) return null;
    return forkliftExit(f.x, f.z, f.yaw);
  }

  /** Can somebody standing here get on? */
  canBoard(x: number, z: number): boolean {
    return nearForklift(this.f.x, this.f.z, x, z);
  }

  /** The next camera (V): the one now. */
  nextView(): ForkView {
    this.view = nextForkView(this.view);
    return this.view;
  }

  /** The display and the street-name block: what to do now, the tips; `walker`: the operator got off and stands there. */
  hud(hs: HudState, touch: boolean, walker: { x: number; z: number } | null = null): void {
    const lang = this.host.settings.lang;
    const f = this.f;
    if (walker) {
      // on foot: the game's tips stay (and, near the seat, how to get on again)
      if (!hs.tip && this.canBoard(walker.x, walker.z)) {
        hs.tip = tr(touch ? 'forkTip.getOnTouch' : 'forkTip.getOn', lang);
        hs.tipAction = 'KeyG';
      }
      return;
    }
    this.panel.setMode(touch);
    const st = f.stability();
    const l = f.load;
    this.panel.update({ moment: Math.max(st.forward, f.pitch > 0 ? 1 : 0), side: Math.max(st.side, f.roll > 0 ? 1 : 0), load: l?.def.mass ?? 0, allowed: l ? capacityAt(f.loadCentre()) : FORKLIFT.capacity, lift: f.lift, tilt: f.tilt / DEG });
    const t = this.tasks;
    if (!this.siteOn) {
      /* (a free drive: the street-name block is the road's) */
    } else if (t) {
      const ins = t.instruction(this.snapshot());
      hs.navText = tr(ins.key, lang, ins.data);
      const progress = t.stage === 'guide' ? tr('forkProgressGuide', lang) : t.stage === 'done' ? '' : tr('forkProgress', lang, { n: t.task + 1, max: t.taskCount });
      hs.navSub = [progress, ins.hint ? tr(ins.hint, lang) : ''].filter(Boolean).join(' · ');
    } else {
      hs.navText = tr('forkLoading', lang);
      hs.navSub = '';
    }
    hs.navArrow = 0;
    hs.navActive = false;
    if (this.siteOn) {
      hs.limit = -1;
      hs.junction = null;
    }
    // (the road's tips do not fit here: back onto the road, getting out)
    hs.tip = '';
    hs.tipAction = '';
    if (this.time < this.tipUntil) hs.tip = tr(this.tip, lang, this.tipData);
    else if ((this.siteOn ? t?.stage === 'guide' && t.step === 0 : !this.moved) && Math.abs(f.v) < 0.1 && (this.host.input.c.handbrake > 0.5 || this.host.input.c.gear !== 1)) hs.tip = tr(touch ? 'forkTip.startTouch' : 'forkTip.start', lang);
    else if (this.moved && !f.tipped && Math.abs(f.v) < 0.05 && this.host.input.c.handbrake > 0.5) {
      // parked with its brake on: getting off (on a touch screen the tip is the button)
      hs.tip = tr(touch ? 'getOutHintTouch' : 'getOutHint', lang);
      hs.tipAction = 'KeyG';
    }
  }

  /** The tasks as they went, for the result page (null: none was finished). */
  resultNode(): HTMLElement | null {
    const t = this.tasks;
    if (!t || t.results.length === 0) return null;
    const lang = this.host.settings.lang;
    const box = document.createElement('div');
    box.className = 'crane-results';
    const total = Math.round(t.results.reduce((s, r) => s + r.score, 0) / t.results.length);
    const head = document.createElement('p');
    head.className = 'crane-total';
    head.textContent = tr('forkResult.total', lang, { done: t.results.length, max: t.taskCount + 1, score: total });
    box.append(head);
    t.results.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = `fault ${r.stars >= 2 ? 'hint' : r.stars === 1 ? 'minor' : 'major'}`;
      const b = document.createElement('b');
      b.textContent = `${i + 1} · ${tr(r.text, lang)}  ${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)}`;
      const small = document.createElement('small');
      const min = Math.floor(r.time / 60);
      const sec = Math.round(r.time % 60);
      small.textContent = tr('forkResult.line', lang, { score: r.score, time: `${min}:${String(sec).padStart(2, '0')}`, minor: r.minor, major: r.major, peak: Math.round(r.peak * 100) });
      row.append(b, small);
      box.append(row);
    });
    return box;
  }

  /** The drive ends: the place goes, the display, the buttons. */
  dispose(): void {
    this.scene.hide();
    this.panel.dispose();
    this.host.ui.classList.remove('forklifting');
  }
}
