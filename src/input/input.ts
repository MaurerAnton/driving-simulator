// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Driver input from keyboard, gamepad, steering wheel and touch.
 *
 * Keys are bound by physical position (KeyboardEvent.code), so the layout
 * is the same on QWERTZ and QWERTY keyboards.
 */
import type { Settings } from '../game/settings.ts';

export interface Controls {
  steer: number;
  throttle: number;
  brake: number;
  clutch: number;
  handbrake: number;
  /** manual: -1 R, 0 N, 1…6; automatic: -2 P, -1 R, 0 N, 1 D */
  gear: number;
  ignition: boolean;
  starter: boolean;
  indicator: number;
  hazard: boolean;
  lowBeam: boolean;
  highBeam: boolean;
  horn: boolean;
  seatbelt: boolean;
  /** head turn target in radians (+ = left) and pitch */
  lookYaw: number;
  lookPitch: number;
  /** which device is steering: decides how much assistance the input layer adds */
  device: 'keyboard' | 'gamepad' | 'wheel' | 'touch';
}

export type Action = 'view' | 'pause' | 'reset' | 'map' | 'help';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const approach = (cur: number, target: number, maxStep: number): number =>
  Math.abs(target - cur) <= maxStep ? target : cur + Math.sign(target - cur) * maxStep;

export class Input {
  readonly c: Controls = {
    steer: 0,
    throttle: 0,
    brake: 0,
    clutch: 0,
    handbrake: 1,
    gear: 0,
    ignition: true,
    starter: false,
    indicator: 0,
    hazard: false,
    lowBeam: false,
    highBeam: false,
    horn: false,
    seatbelt: false,
    lookYaw: 0,
    lookPitch: 0,
    device: 'keyboard',
  };
  private readonly keys = new Set<string>();
  private readonly settings: Settings;
  private readonly actions: Array<(a: Action) => void> = [];
  private mouseLookYaw = 0;
  private mouseLookPitch = 0;
  private dragging = false;
  private indicatorArmed = false;
  private prevButtons: boolean[] = [];
  private gearMin = -1;
  private gearMax = 6;
  /** touch state, written by the on-screen controls */
  touch = { active: false, steer: 0, throttle: 0, brake: 0 };
  /** suspend driving input (menus) */
  enabled = true;
  lastGamepadId = '';

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.settings = settings;
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button === 0) this.dragging = true;
    });
    window.addEventListener('pointerup', () => {
      this.dragging = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging || e.pointerType !== 'mouse') return;
      this.mouseLookYaw = clamp(this.mouseLookYaw - e.movementX * 0.005, -2.6, 2.6);
      this.mouseLookPitch = clamp(this.mouseLookPitch - e.movementY * 0.004 * (settings.invertLookY ? -1 : 1), -0.8, 0.6);
    });
    canvas.addEventListener('dblclick', () => {
      this.mouseLookYaw = 0;
      this.mouseLookPitch = 0;
    });
  }

  onAction(fn: (a: Action) => void): void {
    this.actions.push(fn);
  }

  private fire(a: Action): void {
    for (const f of this.actions) f(a);
  }

  setAutomatic(auto: boolean): void {
    this.gearMin = auto ? -2 : -1;
    this.gearMax = auto ? 1 : 6;
    this.c.gear = auto ? -2 : 0;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    const code = e.code;
    if (down) {
      if (e.repeat) {
        if (code.startsWith('Arrow') || code === 'Space') e.preventDefault();
        return;
      }
      this.keys.add(code);
      if (code === 'Escape') this.fire('pause');
      if (code === 'F1') {
        e.preventDefault();
        this.fire('help');
      }
      if (!this.enabled) return;
      const c = this.c;
      switch (code) {
        case 'KeyE':
          c.gear = Math.min(this.gearMax, c.gear + 1);
          break;
        case 'KeyQ':
          c.gear = Math.max(this.gearMin, c.gear - 1);
          break;
        case 'KeyR':
          c.gear = -1;
          break;
        case 'KeyN':
        case 'Digit0':
          c.gear = 0;
          break;
        case 'KeyP':
          if (this.gearMin === -2) c.gear = -2;
          break;
        case 'Space':
          c.handbrake = c.handbrake > 0.5 ? 0 : 1;
          e.preventDefault();
          break;
        case 'KeyZ':
          c.indicator = c.indicator === -1 ? 0 : -1;
          this.indicatorArmed = false;
          break;
        case 'KeyC':
          c.indicator = c.indicator === 1 ? 0 : 1;
          this.indicatorArmed = false;
          break;
        case 'KeyX':
          c.hazard = !c.hazard;
          break;
        case 'KeyL':
          c.lowBeam = !c.lowBeam;
          if (!c.lowBeam) c.highBeam = false;
          break;
        case 'KeyO':
          c.highBeam = !c.highBeam && c.lowBeam;
          break;
        case 'KeyB':
          c.seatbelt = !c.seatbelt;
          break;
        case 'KeyI':
          c.ignition = !c.ignition;
          break;
        case 'KeyV':
          this.fire('view');
          break;
        case 'KeyM':
          this.fire('map');
          break;
        case 'KeyT':
          this.fire('reset');
          break;
        default:
          if (/^Digit[1-6]$/.test(code) && this.gearMax === 6) c.gear = Number(code.slice(5));
          else if (code === 'Digit1' && this.gearMax === 1) c.gear = 1;
      }
      if (code.startsWith('Arrow')) e.preventDefault();
    } else {
      this.keys.delete(code);
    }
  }

  private key(...codes: string[]): boolean {
    for (const k of codes) if (this.keys.has(k)) return true;
    return false;
  }

  /**
   * Sample all devices.  `speed` (m/s) scales the keyboard steering,
   * `selfAlign` (-1…1) is the tyre feedback from the vehicle model.
   */
  update(dt: number, speed: number, selfAlign: number): Controls {
    const c = this.c;
    if (!this.enabled) {
      c.throttle = 0;
      c.starter = false;
      c.horn = false;
      return c;
    }
    const pad = this.readPad();
    const absSpeed = Math.abs(speed);

    if (pad && pad.kind === 'wheel') {
      c.device = 'wheel';
      c.steer = pad.steer;
      c.throttle = pad.throttle;
      c.brake = pad.brake;
      c.clutch = pad.clutch;
    } else if (pad && (Math.abs(pad.steer) > 0.02 || pad.throttle > 0.02 || pad.brake > 0.02 || c.device === 'gamepad') && !this.anyDrivingKey()) {
      c.device = 'gamepad';
      // gentle non-linearity and less lock at speed make a thumb stick usable
      const limit = 1 / (1 + (absSpeed / 22) * (absSpeed / 22));
      const shaped = Math.sign(pad.steer) * Math.abs(pad.steer) ** 1.6;
      c.steer = approach(c.steer, shaped * (0.3 + 0.7 * limit), dt * 3.5);
      c.throttle = pad.throttle;
      c.brake = pad.brake;
      c.clutch = pad.clutch;
    } else if (this.touch.active) {
      c.device = 'touch';
      const limit = 1 / (1 + (absSpeed / 20) * (absSpeed / 20));
      c.steer = approach(c.steer, this.touch.steer * (0.25 + 0.75 * limit), dt * 4);
      c.throttle = this.touch.throttle;
      c.brake = this.touch.brake;
      c.clutch = 0;
    } else {
      c.device = 'keyboard';
      const left = this.key('KeyA', 'ArrowLeft');
      const right = this.key('KeyD', 'ArrowRight');
      // full lock is only available at walking pace; at speed the keys ask for less
      const limit = clamp(1 / (1 + (absSpeed / 9) * (absSpeed / 9)), 0.06, 1);
      const target = (right ? 1 : 0) - (left ? 1 : 0);
      if (target !== 0) {
        const rate = 0.55 + 0.9 * limit;
        c.steer = approach(c.steer, target * limit, dt * rate);
        // counter-steering is quicker than winding on more lock
        if (Math.sign(c.steer) !== target) c.steer = approach(c.steer, 0, dt * 1.6);
      } else {
        // hands off: the wheel centres itself when the car rolls, and stays put when it stands
        const centring = clamp(absSpeed / 6, 0, 1) * (1.4 + Math.abs(selfAlign) * 2.5);
        c.steer = approach(c.steer, 0, dt * centring);
      }
      const gas = this.key('KeyW', 'ArrowUp');
      const brake = this.key('KeyS', 'ArrowDown');
      // quick to half travel, slower to the floor: easier to dose with a key
      const gasTarget = gas ? 1 : 0;
      c.throttle = gas ? approach(c.throttle, gasTarget, dt * (c.throttle < 0.5 ? 2.4 : 0.9)) : approach(c.throttle, 0, dt * 5);
      c.brake = brake ? approach(c.brake, 1, dt * (c.brake < 0.45 ? 2.6 : 1.3)) : approach(c.brake, 0, dt * 6);
      const clutch = this.key('ShiftLeft', 'ShiftRight');
      // press quickly, release smoothly (like lifting the foot with feeling)
      c.clutch = clutch ? approach(c.clutch, 1, dt * 7) : approach(c.clutch, 0, dt * (c.clutch > 0.3 && c.clutch < 0.78 ? 0.55 : 2.2));
    }

    if (pad) {
      this.applyPadButtons(pad.buttons, pad.kind === 'wheel');
      if (Math.abs(pad.lookX) > 0.15) this.mouseLookYaw = -pad.lookX * 1.9;
      else if (pad.kind === 'standard' && Math.abs(this.mouseLookYaw) > 0 && !this.dragging) this.mouseLookYaw = approach(this.mouseLookYaw, 0, dt * 6);
    }

    c.starter = this.key('Enter', 'NumpadEnter') || (pad?.starter ?? false);
    if (c.starter) c.ignition = true;
    c.horn = this.key('KeyH') || (pad?.horn ?? false);

    // shoulder check / look around
    let yaw = this.mouseLookYaw;
    const lookL = this.key('KeyJ');
    const lookR = this.key('KeyK');
    if (lookL && lookR) yaw = 2.6;
    else if (lookL) yaw = 1.75;
    else if (lookR) yaw = -1.75;
    c.lookYaw = approach(c.lookYaw, yaw, dt * 7);
    c.lookPitch = approach(c.lookPitch, this.mouseLookPitch, dt * 6);

    // indicator self-cancel: arms once the wheel is turned into the bend, cancels when it comes back
    if (c.indicator !== 0) {
      const turned = c.steer * c.indicator;
      if (turned > 0.22) this.indicatorArmed = true;
      else if (this.indicatorArmed && turned < 0.05) {
        c.indicator = 0;
        this.indicatorArmed = false;
      }
    }
    return c;
  }

  private anyDrivingKey(): boolean {
    return this.key('KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight');
  }

  private readPad(): { kind: 'standard' | 'wheel'; steer: number; throttle: number; brake: number; clutch: number; lookX: number; buttons: boolean[]; starter: boolean; horn: boolean } | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    let gp: Gamepad | null = null;
    for (const g of navigator.getGamepads()) {
      if (g && g.connected) {
        gp = g;
        break;
      }
    }
    if (!gp) return null;
    this.lastGamepadId = gp.id;
    const buttons = gp.buttons.map((b) => b.pressed);
    const dead = (v: number, d: number): number => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
    const isWheel = gp.mapping !== 'standard' && /wheel|racing|g2[579]|g920|g923|t150|t300|t248|tmx|driving force|fanatec|simucube|moza/i.test(gp.id);
    if (isWheel) {
      const m = this.settings.wheel;
      const axis = (i: number): number => gp!.axes[i] ?? 0;
      const pedal = (i: number): number => {
        if (i < 0 || i >= gp!.axes.length) return 0;
        const v = axis(i);
        return clamp(m.pedalsInverted ? (1 - v) / 2 : (v + 1) / 2, 0, 1);
      };
      // the wheel reports its full range as -1…1; map it onto the car's 2.66 turns
      const carRange = 957;
      const steer = clamp((axis(m.steerAxis) * m.wheelRange) / carRange, -1, 1);
      return {
        kind: 'wheel',
        steer,
        throttle: dead(pedal(m.throttleAxis), 0.03),
        brake: dead(pedal(m.brakeAxis), 0.03),
        clutch: dead(pedal(m.clutchAxis), 0.05),
        lookX: 0,
        buttons,
        starter: buttons[9] ?? false,
        horn: buttons[10] ?? false,
      };
    }
    const b = (i: number): number => gp!.buttons[i]?.value ?? 0;
    return {
      kind: 'standard',
      steer: dead(gp.axes[0] ?? 0, 0.1),
      throttle: dead(b(7), 0.04),
      brake: dead(b(6), 0.04),
      clutch: 0,
      lookX: gp.axes[2] ?? 0,
      buttons,
      starter: buttons[9] ?? false,
      horn: buttons[10] ?? false,
    };
  }

  private applyPadButtons(buttons: boolean[], wheel: boolean): void {
    const c = this.c;
    const pressed = (i: number): boolean => buttons[i] && !this.prevButtons[i];
    if (wheel) {
      const sh = this.settings.wheel.shifter;
      // H-shifter: a gear is "in" while its button is held, neutral otherwise
      let gear = 0;
      let any = false;
      for (let i = 0; i < sh.length; i++) {
        if (buttons[sh[i]]) {
          gear = i === 6 ? -1 : i + 1;
          any = true;
        }
      }
      const hadShifter = sh.some((i) => this.prevButtons[i]);
      if (any || hadShifter) c.gear = gear;
      // paddles
      if (pressed(4)) c.gear = Math.min(this.gearMax, c.gear + 1);
      if (pressed(5)) c.gear = Math.max(this.gearMin, c.gear - 1);
      if (pressed(0)) c.indicator = c.indicator === -1 ? 0 : -1;
      if (pressed(2)) c.indicator = c.indicator === 1 ? 0 : 1;
      if (pressed(3)) c.hazard = !c.hazard;
      if (pressed(1)) c.handbrake = c.handbrake > 0.5 ? 0 : 1;
      if (pressed(8)) this.fire('view');
    } else {
      if (pressed(5)) c.gear = Math.min(this.gearMax, c.gear + 1); // RB
      if (pressed(4)) c.gear = Math.max(this.gearMin, c.gear - 1); // LB
      if (pressed(0)) c.handbrake = c.handbrake > 0.5 ? 0 : 1; // A
      if (pressed(2)) c.indicator = c.indicator === -1 ? 0 : -1; // X
      if (pressed(1)) c.indicator = c.indicator === 1 ? 0 : 1; // B
      if (pressed(3)) c.hazard = !c.hazard; // Y
      if (pressed(12)) {
        c.lowBeam = !c.lowBeam;
        if (!c.lowBeam) c.highBeam = false;
      }
      if (pressed(13)) c.seatbelt = !c.seatbelt;
      if (pressed(8)) this.fire('view');
      if (pressed(16)) this.fire('pause');
    }
    this.prevButtons = buttons;
  }
}
