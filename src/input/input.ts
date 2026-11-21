// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Driver input from keyboard, gamepad, steering wheel and touch.
 *
 * Keys are bound by physical position (KeyboardEvent.code), so the layout
 * is the same on QWERTZ and QWERTY keyboards.
 */
import type { Settings } from '../game/settings.ts';
import { analogSteer, keySteer, steerFeel } from './steerfeel.ts';
import { CamZoom } from './camzoom.ts';
import type { SteerFeel, SteerSpec } from './steerfeel.ts';

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
  /** distance of the camera behind the car in metres (mouse wheel) */
  lookZoom: number;
  /** which device is steering: decides how much assistance the input layer adds */
  device: 'keyboard' | 'gamepad' | 'wheel' | 'touch';
}

/** door: get out of the vehicle, or in again (on foot beside it) */
/** scrolled on and on, the camera behind the vehicle goes this many times further back than usual: a view from high above */
const ZOOM_FAR = 5;
/** the keys that fly the flying camera (they do not drive meanwhile) */
const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);

/** mirror: look into the next mirror, large over the picture (ui/mirrorzoom.ts) */
/** service: fill up at a pump, wash at a car wash, call for help with an empty tank, skip the loading of a truck (game/serviceworld.ts) */
export type Action = 'view' | 'pause' | 'reset' | 'turn' | 'map' | 'help' | 'reality' | 'door' | 'panto' | 'mirror' | 'service' | 'wiper' | 'open' | 'hud';

const TAU = Math.PI * 2;
/** O held longer than this (ms) is the flasher, not a switch of the main beam */
const FLASH_HOLD_MS = 350;
/** an angle brought into -π … π */
const wrap = (a: number): number => a - TAU * Math.round(a / TAU);

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
    lookZoom: 7,
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
  /** the controls on the screen: the steering bar (and, flying, its height: the stick pulled or pushed, + pulled), the pedals */
  touch = { active: false, steer: 0, pitch: 0, throttle: 0, brake: 0 };
  /**
   * What the driver is using right now: fingers on the screen or keys.
   * It follows the last real input, so a tablet with a keyboard works both ways.
   */
  mode: 'touch' | 'keys' = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches ? 'touch' : 'keys';
  /** a finger glance: the view swings back when the finger lifts */
  private glance = false;
  private lookId = -1;
  private lookX = 0;
  private lookY = 0;
  /**
   * The camera circles the car (view from behind): looking around has no stops,
   * and the view swings back behind the car by itself once the car is driving.
   * False: the driver's head (stops at the shoulders).
   */
  orbit = false;
  /**
   * Where the camera circling the vehicle rests (radians, 0: behind it): it
   * starts there and swings back there – the forklift's view from the side
   * (game/forkliftplay.ts).  Set by `resetLook`.
   */
  orbitRest = 0;
  /**
   * The free camera: fingers and mouse move the camera itself (see `cam`)
   * instead of turning a head or circling the car, and it stays where it is put.
   */
  freeCam = false;
  /**
   * What was asked of the free camera since it was last read (takeCam):
   * turning in radians, moving sideways / forwards / up and towards what it
   * looks at in parts of the distance to it – by dragging, pinching and the
   * wheel – and flying with the keys (Alt held) in seconds of key time.
   */
  private readonly cam = { yaw: 0, pitch: 0, right: 0, fwd: 0, dolly: 0, keyRight: 0, keyFwd: 0, keyUp: 0, fast: false, reset: false, lift: 0, speed: 0 };
  /**
   * The free camera flies (game/flycam.ts – set by the game while it is the view): the keys W A S D, Q E,
   * the arrows and Page Up / Down fly it without Alt, the wheel and a pinch set its speed, two fingers
   * lift or lower it – and the vehicle is held where it is.
   */
  flyCam = false;
  /** the stick on the screen (ui/touchstick.ts): to the right (+) and forwards (+), −1 … 1 each */
  readonly stick = { x: 0, y: 0 };
  /** on foot: running switched on (Caps Lock, the runner's button by the stick) */
  runToggle = false;
  /** fingers on the view */
  private readonly fingers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private lookIdle = 0;
  /** how the keys, the bar and a stick move the steering for this vehicle (input/steerfeel.ts) */
  private feel: SteerFeel = steerFeel();
  /** suspend driving input (menus) */
  enabled = true;
  lastGamepadId = '';
  /**
   * A crane is being worked (game/craneplay.ts): its controls (ui/cranepanel.ts) take the keys and the
   * gamepad – only the camera (V), the map (M) and the door key (G: back to driving) stay the game's.
   */
  crane = false;
  /** zooming the view (input/camzoom.ts): pinch, the wheel, + and − – while `viewZoom` (set by the game: on foot, the driver's seat) */
  readonly zoom = new CamZoom();
  viewZoom = false;

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.settings = settings;
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') {
        if (e.button === 0) this.dragging = true;
        // (a drag goes on when the pointer passes over a part of the HUD)
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          /* the pointer is gone already */
        }
        return;
      }
      // A finger on the view.  From the driver's seat: swipe to glance left or right (shoulder
      // check), let go to look ahead again.  From outside: it turns the camera, which stays.
      // Two fingers move the free camera, and pinching brings a camera closer or takes it away.
      this.mode = 'touch';
      this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.fingers.size === 2) this.pinch = this.fingerSpread();
      if (this.lookId >= 0) return;
      this.lookId = e.pointerId;
      this.lookX = e.clientX;
      this.lookY = e.clientY;
      this.dragging = true;
      this.glance = !this.orbit && !this.freeCam;
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerType === 'mouse') {
        this.dragging = false;
        return;
      }
      this.fingers.delete(e.pointerId);
      if (this.fingers.size < 2) this.zoom.fingersOff();
      if (e.pointerId === this.lookId) {
        // (another finger still on the view goes on turning it)
        const rest = this.fingers.entries().next();
        if (rest.done) {
          this.lookId = -1;
          this.dragging = false;
        } else {
          this.lookId = rest.value[0];
          this.lookX = rest.value[1].x;
          this.lookY = rest.value[1].y;
        }
      }
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    canvas.addEventListener('pointermove', (e) => {
      const inv = settings.invertLookY ? -1 : 1;
      if (e.pointerType === 'mouse') {
        // the left button held – or Alt, with no button at all – turns the view;
        // the right or the middle button moves the free camera
        const turn = this.dragging || (e.altKey && e.buttons === 0);
        if (this.freeCam && (e.buttons & 6) !== 0) {
          const k = 1 / Math.max(240, window.innerHeight);
          this.cam.right -= e.movementX * k;
          this.cam.fwd += e.movementY * k;
        } else if (turn) {
          this.lookIdle = 0;
          this.turnLook(-e.movementX * 0.005, -e.movementY * 0.004 * inv);
        }
        return;
      }
      const f = this.fingers.get(e.pointerId);
      if (!f) return;
      const dx = e.clientX - f.x;
      const dy = e.clientY - f.y;
      f.x = e.clientX;
      f.y = e.clientY;
      this.lookIdle = 0;
      if (this.fingers.size >= 2) {
        const spread = this.fingerSpread();
        const scale = this.pinch > 8 && spread > 8 ? spread / this.pinch : 1;
        this.pinch = spread;
        if (this.viewZoom) this.zoom.pinch(scale);
        else if (this.flyCam) {
          // (the flying camera: both fingers up or down lift or lower it – each moves the middle by half –, a pinch sets the speed)
          this.cam.lift -= (dy * 0.5) / Math.max(240, window.innerHeight);
          this.cam.speed += Math.log(scale) * 4;
        } else if (this.freeCam) {
          // (each finger moves the middle between the two by half of what it moves)
          const k = 0.5 / Math.max(240, window.innerHeight);
          this.cam.right -= dx * k;
          this.cam.fwd += dy * k;
          this.cam.dolly += Math.log(scale);
        } else if (this.orbit) this.c.lookZoom = clamp(this.c.lookZoom / scale, 3.5, this.zoomMax * ZOOM_FAR);
      } else if (e.pointerId === this.lookId) {
        // a thumb travels less than a mouse: a third of the screen is a full shoulder check – and it turns
        // the view the way the mouse does (to the right when drawn to the right, down when drawn down)
        const k = 5.4 / Math.max(320, window.innerWidth);
        this.turnLook(-dx * k, -dy * k * 0.5 * inv);
      }
    });
    // the wheel of the mouse moves the camera closer to the car or further away
    canvas.addEventListener(
      'wheel',
      (e) => {
        // (the flying camera: the wheel sets how fast it flies – a notch a step)
        if (this.flyCam && this.enabled) {
          e.preventDefault();
          this.cam.speed -= clamp(e.deltaY, -120, 120) / 100;
          return;
        }
        // (on foot and in the driver's seat the wheel zooms the view)
        if (this.viewZoom && this.enabled) {
          e.preventDefault();
          this.zoom.wheel(clamp(e.deltaY, -120, 120) * 0.0016);
          return;
        }
        if ((!this.orbit && !this.freeCam) || !this.enabled) return;
        e.preventDefault();
        const step = clamp(e.deltaY, -120, 120) * 0.0016;
        if (this.freeCam) this.cam.dolly -= step;
        else this.c.lookZoom = clamp(this.c.lookZoom * Math.exp(step), 3.5, this.zoomMax * ZOOM_FAR);
      },
      { passive: false },
    );
    // (the right button moves the free camera: no menu of the browser over the view)
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('dblclick', () => {
      this.mouseLookYaw = this.orbit ? this.orbitRest : 0;
      this.mouseLookPitch = 0;
      this.cam.reset = true;
    });
  }

  private fingerSpread(): number {
    const it = this.fingers.values();
    const a = it.next().value;
    const b = it.next().value;
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  /** What was asked of the free camera since the last call (see `cam`); the object is reused. */
  /**
   * On foot: forwards (-1 … 1), turning (+ = to the left) and running, from
   * whatever is in use – the keys W S A D (Shift to run), the pedals and the
   * steering bar on the screen, a gamepad's stick and triggers.  (Not from
   * the controls of the vehicle: its steering wheel stays where it is when
   * nobody holds it.)
   */
  walkInput(mode: 'classic' | 'tank' | 'tap' = 'tank'): { fwd: number; turn: number; side: number; run: boolean } {
    // (classic, and tap to walk: A D a step to the side, the arrows ← → turn – game/walkmodes.ts)
    const classic = mode !== 'tank';
    let fwd = (this.key('KeyW', 'ArrowUp') ? 1 : 0) - (this.key('KeyS', 'ArrowDown') ? 1 : 0);
    let turn = classic ? (this.key('ArrowLeft') ? 1 : 0) - (this.key('ArrowRight') ? 1 : 0) : (this.key('KeyA', 'ArrowLeft') ? 1 : 0) - (this.key('KeyD', 'ArrowRight') ? 1 : 0);
    let side = classic ? (this.key('KeyD') ? 1 : 0) - (this.key('KeyA') ? 1 : 0) : 0;
    let run = this.key('ShiftLeft', 'ShiftRight') || this.runToggle;
    if (this.key('AltLeft', 'AltRight')) fwd = turn = side = 0;
    // the stick on the screen (shown for the classic way and tap to walk)
    fwd += this.stick.y;
    side += this.stick.x;
    if (this.touch.active) {
      fwd += this.touch.throttle - this.touch.brake;
      turn -= this.touch.steer;
      // (the pedal pressed near its top: running)
      run ||= this.touch.throttle > 0.85;
    }
    const pad = this.readPad();
    if (pad) {
      fwd += pad.throttle - pad.brake;
      if (classic && pad.kind === 'standard') {
        // (the left stick walks and steps aside; the right one turns)
        if (Math.abs(pad.pitch) > 0.12) fwd -= pad.pitch;
        if (Math.abs(pad.steer) > 0.12) side += pad.steer;
        if (Math.abs(pad.lookX) > 0.15) turn -= pad.lookX;
      } else if (Math.abs(pad.steer) > 0.12) turn -= pad.steer;
      run ||= pad.throttle > 0.95;
    }
    return { fwd: clamp(fwd, -1, 1), turn: clamp(turn, -1, 1), side: clamp(side, -1, 1), run };
  }

  /**
   * A forklift's mast (game/forkliftplay.ts): the forks up (+) or down, the
   * mast tilted back (+) or forwards, the side-shift right (+) or left, each
   * −1 … 1 – from Page Up / Page Down, Home / End and Insert / Delete (the
   * buttons on the screen press the same keys), and a gamepad's right stick
   * (up and down: the forks) and its pad (left and right: the tilt).
   */
  forkInput(): { lift: number; tilt: number; shift: number } {
    if (!this.enabled) return { lift: 0, tilt: 0, shift: 0 };
    let lift = (this.key('PageUp') ? 1 : 0) - (this.key('PageDown') ? 1 : 0);
    let tilt = (this.key('Home') ? 1 : 0) - (this.key('End') ? 1 : 0);
    const shift = (this.key('Delete') ? 1 : 0) - (this.key('Insert') ? 1 : 0);
    const pad = this.readPad();
    if (pad && pad.kind === 'standard') {
      const gp = navigator.getGamepads().find((g) => g?.connected);
      const ry = gp?.axes[3] ?? 0;
      if (Math.abs(ry) > 0.15) lift -= ry;
      tilt += (pad.buttons[15] ? 1 : 0) - (pad.buttons[14] ? 1 : 0);
    }
    return { lift: clamp(lift, -1, 1), tilt: clamp(tilt, -1, 1), shift: clamp(shift, -1, 1) };
  }

  /**
   * Flying: the stick (pitch + = pulled, roll + = to the right), the rudder
   * pedals (+ = right), which way the throttle is moved (+ open, − close) and
   * the wheel brakes – from the arrow keys (the stick), W S (the throttle),
   * A D (the rudder) and Space (the brakes); the steering bar on the screen as
   * the stick, its pedals as the throttle (the left one brakes on the ground
   * too); a gamepad's left stick and its triggers.
   */
  flightInput(): { pitch: number; roll: number; yaw: number; throttle: number; brake: number } {
    let pitch = (this.key('ArrowDown') ? 1 : 0) - (this.key('ArrowUp') ? 1 : 0);
    let roll = (this.key('ArrowRight') ? 1 : 0) - (this.key('ArrowLeft') ? 1 : 0);
    let yaw = (this.key('KeyD') ? 1 : 0) - (this.key('KeyA') ? 1 : 0);
    let throttle = (this.key('KeyW') ? 1 : 0) - (this.key('KeyS') ? 1 : 0);
    let brake = this.key('Space') ? 1 : 0;
    if (this.touch.active) {
      roll += this.touch.steer;
      pitch += this.touch.pitch;
      throttle += (this.touch.throttle > 0.2 ? 1 : 0) - (this.touch.brake > 0.2 ? 1 : 0);
      brake = Math.max(brake, this.touch.brake > 0.2 ? this.touch.brake : 0);
    }
    const pad = this.readPad();
    if (pad && pad.kind === 'standard') {
      roll += pad.steer;
      pitch += pad.pitch;
      throttle += pad.throttle - pad.brake;
      brake = Math.max(brake, pad.brake);
    }
    return { pitch: clamp(pitch, -1, 1), roll: clamp(roll, -1, 1), yaw: clamp(yaw, -1, 1), throttle: clamp(throttle, -1, 1), brake: clamp(brake, 0, 1) };
  }

  takeCam(): Readonly<{ yaw: number; pitch: number; right: number; fwd: number; dolly: number; keyRight: number; keyFwd: number; keyUp: number; fast: boolean; reset: boolean; lift: number; speed: number }> {
    const c = this.cam;
    const o = this.camOut;
    o.yaw = c.yaw;
    o.pitch = c.pitch;
    o.right = c.right;
    o.fwd = c.fwd;
    o.dolly = c.dolly;
    o.keyRight = c.keyRight;
    o.keyFwd = c.keyFwd;
    o.keyUp = c.keyUp;
    o.fast = c.fast;
    o.reset = c.reset;
    o.lift = c.lift;
    o.speed = c.speed;
    c.yaw = c.pitch = c.right = c.fwd = c.dolly = c.keyRight = c.keyFwd = c.keyUp = c.lift = c.speed = 0;
    c.reset = false;
    return o;
  }

  private readonly camOut = { yaw: 0, pitch: 0, right: 0, fwd: 0, dolly: 0, keyRight: 0, keyFwd: 0, keyUp: 0, fast: false, reset: false, lift: 0, speed: 0 };

  /** Looking around with the mouse or a finger; the stops depend on what is turning: a head or a camera. */
  /** Where the glance keys (or their buttons) turn the head now: left, right, back over the shoulder (radians, 0: ahead). */
  glanceYaw(): number {
    const l = this.key('KeyJ');
    const r = this.key('KeyK');
    if (this.key('KeyU') || (l && r)) return Math.PI;
    return l ? 1.6 : r ? -1.6 : 0;
  }

  private turnLook(dYaw: number, dPitch: number): void {
    if (this.freeCam) {
      this.cam.yaw += dYaw;
      this.cam.pitch += dPitch;
    } else if (this.orbit) {
      this.mouseLookYaw = wrap(this.mouseLookYaw + dYaw);
      // from just above the road to almost straight down onto the roof
      this.mouseLookPitch = clamp(this.mouseLookPitch + dPitch, -1.15, 0.28);
    } else {
      this.mouseLookYaw = clamp(this.mouseLookYaw + dYaw, -2.6, 2.6);
      this.mouseLookPitch = clamp(this.mouseLookPitch + dPitch, -0.8, 0.6);
    }
  }

  /** The camera was changed: look straight ahead again (circling the vehicle: from `rest`, 0 behind it). */
  resetLook(orbit: boolean, freeCam = false, rest = 0): void {
    this.orbit = orbit;
    this.freeCam = freeCam;
    this.orbitRest = orbit ? rest : 0;
    this.takeCam();
    this.mouseLookYaw = this.orbitRest;
    this.mouseLookPitch = 0;
    this.c.lookYaw = this.orbitRest;
    this.c.lookPitch = 0;
    this.glance = false;
  }

  /** The car that is being steered (for how much lock the keys may ask for at speed). */
/** how far the outside camera can be moved away (m) – more for a truck with a trailer */
  /** how far the camera behind the vehicle goes back as usual (the vehicle's own measure) – scrolled on, ZOOM_FAR times that */
  zoomMax = 18;

  /** `spec`: the whole vehicle – a heavy one is steered slower and more gently (input/steerfeel.ts). */
  setSteering(wheelbase: number, maxWheelAngle: number, spec?: SteerSpec): void {
    this.feel = steerFeel(spec ? { ...spec, wheelbase, maxWheelAngle } : null, wheelbase, maxWheelAngle);
  }

  onAction(fn: (a: Action) => void): void {
    this.actions.push(fn);
  }

  /** The on-screen controls are being used. */
  touched(): void {
    this.mode = 'touch';
    this.touch.active = true;
  }

  /** A button on the screen stands in for a key (down / up). */
  press(code: string, down: boolean): void {
    this.mode = 'touch';
    this.onKey(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }), down);
  }

  private fire(a: Action): void {
    for (const f of this.actions) f(a);
  }

  /**
   * One step up (+1) or down (−1) of the gear lever.  A manual gearbox counts
   * R N 1 … 6.  The selector of an automatic is P (−2) R (−1) N (0) D (1),
   * but up from P or R goes towards D – what one wants nearly every time –
   * and down from D through N to R, then P: drive comes before reverse.
   */
  private shift(g: number, dir: 1 | -1): number {
    if (this.gearMin !== -2) return dir > 0 ? Math.min(this.gearMax, g + 1) : Math.max(this.gearMin, g - 1);
    if (dir > 0) return g === -1 ? 0 : 1;
    return g === 1 ? 0 : g === 0 ? -1 : -2;
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
      // a real key (the on-screen buttons send untrusted ones): the driver is on the keyboard now
      if (e.isTrusted && !e.ctrlKey && !e.metaKey && !e.altKey && code !== 'Escape') {
        this.mode = 'keys';
        this.touch.active = false;
      }
      this.keys.add(code);
      // (Alt alone must not put the browser's menu in charge of the keyboard)
      if (code === 'AltLeft' || code === 'AltRight') e.preventDefault();
      if (code === 'Escape') this.fire('pause');
      if (code === 'F1') {
        e.preventDefault();
        this.fire('help');
      }
      // F2: hide or show the whole display (ui/viewbuttons.ts)
      if (code === 'F2') {
        e.preventDefault();
        this.fire('hud');
      }
      // F3: turn the vehicle round (game.ts turnAround – into the lane of the other direction)
      if (code === 'F3') {
        e.preventDefault();
        this.fire('turn');
      }
      // "Foto": what does this place really look like? (also from the pause menu)
      if (code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey) this.fire('reality');
      if (!this.enabled) return;
      // (on foot: Caps Lock switches running on or off)
      if (code === 'CapsLock') this.runToggle = !this.runToggle;
      // Alt held with the free camera – or the flying camera: the keys fly the camera, they do not drive
      if ((this.freeCam && e.altKey) || (this.flyCam && FLY_KEYS.has(code))) {
        e.preventDefault();
        return;
      }
      // (working a crane: its own keys – but the camera, the map, the door, and the lights, hazard lights, horn and ignition still work)
      if (this.crane && !['KeyV', 'KeyM', 'KeyG', 'KeyL', 'KeyO', 'KeyX', 'KeyH', 'KeyI'].includes(code)) {
        if (code.startsWith('Arrow') || code === 'Space') e.preventDefault();
        return;
      }
      // + and −: the view closer or wider (on foot, in the driver's seat; held, the zoom stays)
      const zoomDir = zoomKey(e);
      if (zoomDir !== 0 && this.viewZoom) {
        this.zoom.press(zoomDir, true);
        return;
      }
      const c = this.c;
      switch (code) {
        case 'KeyE':
          c.gear = this.shift(c.gear, 1);
          break;
        case 'KeyQ':
          c.gear = this.shift(c.gear, -1);
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
          // (in the tram: the pantograph up or down)
          this.fire('panto');
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
          // (a tap switches the main beam when it is let go; held, it is the flasher – see `flasher`)
          this.oDownAt = performance.now();
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
        case 'KeyG':
          this.fire('door');
          break;
        case 'Period':
          // (on foot: open or shut the door, the bonnet, the boot where one stands – game/openplay.ts)
          this.fire('open');
          break;
        case 'KeyM':
          this.fire('map');
          break;
        case 'KeyY':
          this.fire('mirror');
          break;
        case 'KeyT':
          this.fire('reset');
          break;
        case 'Digit9':
          this.fire('service');
          break;
        case 'Digit8':
          // the wiper stalk one place on (Digit7 held: the washer, see `washer`)
          this.fire('wiper');
          break;
        default:
          if (/^Digit[1-6]$/.test(code) && this.gearMax === 6) c.gear = Number(code.slice(5));
          else if (code === 'Digit1' && this.gearMax === 1) c.gear = 1;
      }
      if (code.startsWith('Arrow')) e.preventDefault();
    } else {
      if (zoomKey(e) !== 0) this.zoom.press(0, false);
      // the main beam on or off: O tapped, not held as the flasher
      if (code === 'KeyO' && this.keys.has('KeyO') && this.enabled && performance.now() - this.oDownAt < FLASH_HOLD_MS) this.c.highBeam = !this.c.highBeam && this.c.lowBeam;
      this.keys.delete(code);
      if (code === 'AltLeft' || code === 'AltRight') e.preventDefault();
    }
  }

  /**
   * The headlight flasher (the stalk pulled towards one): the main beam lit
   * while O is held – a short tap switches the main beam instead – or while
   * the flasher's own button on the screen is held (its code 'Flash').
   */
  get flasher(): boolean {
    return this.enabled && (this.keys.has('Flash') || this.keys.has('KeyO'));
  }

  /** when O went down (ms, performance.now) */
  private oDownAt = 0;

  /** The washer: sprays while its key (7) or button is held. */
  get washer(): boolean {
    return this.enabled && this.key('Digit7');
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
    // the free camera, flown with the keys while Alt is held (the car rolls on by itself meanwhile)
    const fly = (this.freeCam && this.key('AltLeft', 'AltRight')) || this.flyCam;
    if (fly) {
      const cam = this.cam;
      cam.keyFwd += ((this.key('KeyW', 'ArrowUp') ? 1 : 0) - (this.key('KeyS', 'ArrowDown') ? 1 : 0)) * dt;
      cam.keyRight += ((this.key('KeyD', 'ArrowRight') ? 1 : 0) - (this.key('KeyA', 'ArrowLeft') ? 1 : 0)) * dt;
      cam.keyUp += ((this.key('KeyE', 'PageUp', 'FlyUp') ? 1 : 0) - (this.key('KeyQ', 'PageDown', 'FlyDown') ? 1 : 0)) * dt;
      cam.fast = this.key('ShiftLeft', 'ShiftRight');
      // (the stick on the screen, and a gamepad's left stick)
      cam.keyFwd += this.stick.y * dt;
      cam.keyRight += this.stick.x * dt;
      if (this.flyCam && pad && pad.kind === 'standard') {
        cam.keyFwd -= pad.pitch * dt;
        cam.keyRight += pad.steer * dt;
        cam.keyUp += (pad.throttle - pad.brake) * dt;
      }
    }

    if (this.flyCam) {
      // the camera flies: nobody drives – the vehicle is braked to a stop and waits (the clutch down: the engine does not stall)
      c.throttle = 0;
      c.brake = approach(c.brake, 1, dt * 2);
      c.clutch = approach(c.clutch, 1, dt * 7);
    } else if (pad && pad.kind === 'wheel') {
      c.device = 'wheel';
      c.steer = pad.steer;
      c.throttle = pad.throttle;
      c.brake = pad.brake;
      c.clutch = pad.clutch;
    } else if (pad && (Math.abs(pad.steer) > 0.02 || pad.throttle > 0.02 || pad.brake > 0.02 || c.device === 'gamepad') && (fly || !this.anyDrivingKey())) {
      c.device = 'gamepad';
      // gentle non-linearity and less lock at speed make a thumb stick usable
      const shaped = Math.sign(pad.steer) * Math.abs(pad.steer) ** 1.6;
      c.steer = analogSteer(this.feel, c.steer, shaped, absSpeed, dt, 3.5);
      c.throttle = pad.throttle;
      c.brake = pad.brake;
      c.clutch = pad.clutch;
    } else if (this.touch.active) {
      c.device = 'touch';
      c.steer = analogSteer(this.feel, c.steer, this.touch.steer, absSpeed, dt, 4);
      c.throttle = this.touch.throttle;
      c.brake = this.touch.brake;
      c.clutch = 0;
    } else {
      c.device = 'keyboard';
      const left = !fly && this.key('KeyA', 'ArrowLeft');
      const right = !fly && this.key('KeyD', 'ArrowRight');
      // A key is all or nothing, a steering wheel is not: the keys ask for the lock that turns the car
      // with a comfortable lateral acceleration at this speed – full lock at walking pace, a fraction
      // of a degree on the motorway – and wind it on within about half a second.
      // (hands off: the wheel centres itself when the car rolls, and stays put when it stands)
      // the sensitivity is read here so a slider change takes effect at once
      this.feel.sens = this.settings.steerSensitivity;
      c.steer = keySteer(this.feel, c.steer, (right ? 1 : 0) - (left ? 1 : 0), absSpeed, selfAlign, dt);
      const gas = !fly && this.key('KeyW', 'ArrowUp');
      const brake = !fly && this.key('KeyS', 'ArrowDown');
      // quick to half travel, slower to the floor: easier to dose with a key
      const gasTarget = gas ? 1 : 0;
      c.throttle = gas ? approach(c.throttle, gasTarget, dt * (c.throttle < 0.35 ? 2.4 : 0.6)) : approach(c.throttle, 0, dt * 5);
      c.brake = brake ? approach(c.brake, 1, dt * (c.brake < 0.45 ? 2.6 : 1.3)) : approach(c.brake, 0, dt * 6);
      const clutch = !fly && this.key('ShiftLeft', 'ShiftRight');
      // press quickly, release smoothly (like lifting the foot with feeling)
      c.clutch = clutch ? approach(c.clutch, 1, dt * 7) : approach(c.clutch, 0, dt * (c.clutch > 0.3 && c.clutch < 0.78 ? 0.55 : 2.2));
    }

    if (pad && this.crane) {
      // (the sticks and buttons work the crane: only the camera and the pause stay the game's)
      const b = pad.buttons;
      if (b[8] && !this.prevButtons[8]) this.fire('view');
      if (b[16] && !this.prevButtons[16]) this.fire('pause');
      this.prevButtons = b;
    } else if (pad) {
      this.applyPadButtons(pad.buttons, pad.kind === 'wheel');
      if (Math.abs(pad.lookX) > 0.15) this.mouseLookYaw = -pad.lookX * 1.9;
      else if (pad.kind === 'standard' && this.mouseLookYaw !== this.orbitRest && !this.dragging) this.mouseLookYaw = this.orbitRest + approach(wrap(this.mouseLookYaw - this.orbitRest), 0, dt * 6);
    }

    c.starter = this.key('Enter', 'NumpadEnter') || (pad?.starter ?? false);
    if (c.starter) c.ignition = true;
    c.horn = this.key('KeyH') || (pad?.horn ?? false);

    // a finger glance swings back by itself
    if (this.freeCam) this.glance = false;
    if (this.glance && !this.dragging) {
      this.mouseLookYaw = approach(this.mouseLookYaw, 0, dt * 5);
      this.mouseLookPitch = approach(this.mouseLookPitch, 0, dt * 2.5);
      if (this.mouseLookYaw === 0 && this.mouseLookPitch === 0) this.glance = false;
    }
    // shoulder check / look around
    let yaw = this.mouseLookYaw;
    const lookL = this.key('KeyJ');
    const lookR = this.key('KeyK');
    const back = this.key('KeyU') || (lookL && lookR);
    // looking back: over the left shoulder through the rear window – or, seen from outside, the camera in front of the car
    if (back) yaw = this.orbit ? Math.PI : 2.6;
    else if (lookL) yaw = 1.75;
    else if (lookR) yaw = -1.75;
    if (this.orbit) {
      // once the car is driving and nobody is looking around, the camera swings back behind it
      if (this.dragging || back || lookL || lookR) this.lookIdle = 0;
      else this.lookIdle += dt;
      if (this.lookIdle > 2.2 && absSpeed > 2.5 && !this.glance) {
        this.mouseLookYaw = this.orbitRest + approach(wrap(this.mouseLookYaw - this.orbitRest), 0, dt * 1.6);
        this.mouseLookPitch = approach(this.mouseLookPitch, 0, dt * 0.6);
      }
      // the short way round
      c.lookYaw = wrap(c.lookYaw + clamp(wrap(yaw - c.lookYaw), -dt * 7, dt * 7));
    } else c.lookYaw = approach(c.lookYaw, yaw, dt * 7);
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

  private readPad(): { kind: 'standard' | 'wheel'; steer: number; pitch: number; throttle: number; brake: number; clutch: number; lookX: number; buttons: boolean[]; starter: boolean; horn: boolean } | null {
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
        pitch: 0,
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
      // (the left stick's height: back is pulled)
      pitch: dead(gp.axes[1] ?? 0, 0.1),
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
      if (pressed(4)) c.gear = this.shift(c.gear, 1);
      if (pressed(5)) c.gear = this.shift(c.gear, -1);
      if (pressed(0)) c.indicator = c.indicator === -1 ? 0 : -1;
      if (pressed(2)) c.indicator = c.indicator === 1 ? 0 : 1;
      if (pressed(3)) c.hazard = !c.hazard;
      if (pressed(1)) c.handbrake = c.handbrake > 0.5 ? 0 : 1;
      if (pressed(8)) this.fire('view');
    } else {
      if (pressed(5)) c.gear = this.shift(c.gear, 1); // RB
      if (pressed(4)) c.gear = this.shift(c.gear, -1); // LB
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

/** The zoom keys: + (1), − (−1), anything else 0 – by the character, so that + on a German keyboard counts too. */
function zoomKey(e: KeyboardEvent): number {
  if (e.ctrlKey || e.metaKey || e.altKey) return 0;
  if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') return 1;
  if (e.key === '-' || e.code === 'NumpadSubtract') return -1;
  return 0;
}
