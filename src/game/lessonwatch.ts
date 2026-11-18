// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Watching a lesson.  At the start of a driving lesson the player may choose
 * to watch it instead of driving it: the car drives the lesson by itself –
 * the same autopilot as the demonstration drive (sim/autodriver.ts), along
 * the way the lesson's guidance plans (game/nav.ts), at the real place the
 * lesson was put at (game/lessonplaces.ts) – and the instructor says what
 * it does and why ("Red: stop at the line and wait.", "No signs: right
 * before left …").  Whoever steers, brakes or accelerates takes the car
 * over, and the lesson goes on with the player at the wheel.
 *
 * Only the lessons on the road can be watched (the routed ones and the test
 * drive): the first lesson's steps (belt, engine, gears), the yard tasks,
 * the tram and the bus on their lines are about the player's own hands.
 *
 * The game owns the vehicle, the route and the lesson; this only turns the
 * driver's commands into the pedals and the wheel, and tells what to show.
 */
import type { AutoCommand, AutoDriver, AutoRemark } from '../sim/autodriver.ts';
import type { DriverInput, Vehicle } from '../sim/vehicle/index.ts';
import type { Connector } from '../world/lanes.ts';
import type { LessonDef } from './nav.ts';

/** Can this lesson be watched (driven by the autopilot)? */
export function canWatch(l: Pick<LessonDef, 'kind' | 'tasks'> | null | undefined): boolean {
  return !!l && (l.kind === 'route' || l.kind === 'exam') && !(l.tasks && l.tasks.length > 0);
}

/** what of the player's controls the watch reads (the hands) and sets (gear, indicator, belt …) */
export interface WatchControls {
  steer: number;
  throttle: number;
  brake: number;
  handbrake: number;
  gear: number;
  indicator: number;
  ignition: boolean;
  seatbelt: boolean;
  hazard: boolean;
}

/** how long hands on the controls count as nothing (a wheel not quite centred, a thumb resting on the screen) (s) */
const TAKE_HOLD = 0.18;

export class LessonWatch {
  readonly driver: AutoDriver;
  /** where the driver looks (rad, + = left) and why it does what it does just now */
  look = 0;
  remark: AutoRemark = '';
  /** how long the player's hands have been on the controls (s) */
  private takeT = 0;
  /** the last command, for whoever wants more of it (turning round at the end of a street) */
  cmd: AutoCommand | null = null;
  private prepared = false;

  constructor(driver: AutoDriver) {
    this.driver = driver;
  }

  /** Ready to go: belt on, engine on, handbrake off, in D (the car has the automatic gearbox for the driver). */
  prepare(c: WatchControls): void {
    c.seatbelt = true;
    c.ignition = true;
    c.handbrake = 0;
    c.gear = 1;
    c.indicator = 0;
    c.hazard = false;
    this.takeT = 0;
    this.prepared = true;
    this.driver.reset();
  }

  /**
   * One picture: the driver's commands into `d` (the vehicle's inputs) and the controls it shows.  `ready`:
   * the lesson's way is known (until then the car stands).  'taken': the player has taken the wheel – the
   * watch is over.
   */
  control(dt: number, v: Vehicle, mpos: ArrayLike<number>, route: readonly Connector[], ready: boolean, c: WatchControls, d: DriverInput): 'driving' | 'taken' {
    // (the first picture of the drive: the car was placed with its parking brake on)
    if (!this.prepared) this.prepare(c);
    const hands = c.throttle > 0.2 || c.brake > 0.2 || Math.abs(c.steer) > 0.35 || c.handbrake > 0.5;
    this.takeT = hands ? this.takeT + dt : 0;
    if (this.takeT > TAKE_HOLD) return 'taken';
    const cmd = this.driver.step(Math.max(dt, 1e-3), v, mpos, route);
    this.cmd = cmd;
    d.steer = ready ? cmd.steer : 0;
    d.throttle = ready ? cmd.throttle : 0;
    d.brake = ready ? cmd.brake : 0.5;
    d.clutch = 0;
    d.handbrake = 0;
    d.gear = 1;
    d.ignition = true;
    d.starter = !v.engineRunning;
    c.gear = 1;
    c.ignition = true;
    c.seatbelt = true;
    c.indicator = cmd.indicator;
    this.look = cmd.look;
    this.remark = cmd.remark;
    return 'driving';
  }

  /** The instructor's line under the guidance: what the car does and why – or that it drives by itself. */
  text(tr: (key: string) => string): string {
    return this.remark ? tr(`demo.${this.remark}`) : tr('lessonWatch.running');
  }
}
