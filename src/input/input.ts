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
  /** distance of the camera behind the car in metres (mouse wheel) */
  lookZoom: number;
  /** which device is steering: decides how much assistance the input layer adds */
  device: 'keyboard' | 'gamepad' | 'wheel' | 'touch';
}

/** door: get out of the vehicle, or in again (on foot beside it) */
/** scrolled on and on, the camera behind the vehicle goes this many times further back than usual: a view from high above */
const ZOOM_FAR = 5;

/** mirror: look into the next mirror, large over the picture (ui/mirrorzoom.ts) */
/** service: fill up at a pump, wash at a car wash, call for help with an empty tank, skip the loading of a truck (game/serviceworld.ts) */
export type Action = 'view' | 'pause' | 'reset' | 'map' | 'help' | 'reality' | 'door' | 'panto' | 'mirror' | 'service';

/** Lateral acceleration (m/s²) the steering keys may ask for: brisk in town, gentle on the motorway. */
const keyLateral = (v: number): number => 2.4 + 3.4 / (1 + (v / 15) * (v / 15));
/** … and what full deflection of a stick or of the steering bar asks for: close to what the tyres hold. */
const ANALOG_LATERAL = 7;
const TAU = Math.PI * 2;
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
  private readonly cam = { yaw: 0, pitch: 0, right: 0, fwd: 0, dolly: 0, keyRight: 0, keyFwd: 0, keyUp: 0, fast: false, reset: false };
  /** fingers on the view */
  private readonly fingers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private lookIdle = 0;
  private wheelbase = 2.63;
  private maxWheelAngle = 0.576;
  /** suspend driving input (menus) */
  enabled = true;
  lastGamepadId = '';
  /**
   * A crane is being worked (game/craneplay.ts): its controls (ui/cranepanel.ts) take the keys and the
   * gamepad – only the camera (V), the map (M) and the door key (G: back to driving) stay the game's.
   */
  crane = false;

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
        if (this.freeCam) {
          // (each finger moves the middle between the two by half of what it moves)
          const k = 0.5 / Math.max(240, window.innerHeight);
          this.cam.right -= dx * k;
          this.cam.fwd += dy * k;
          this.cam.dolly += Math.log(scale);
        } else if (this.orbit) this.c.lookZoom = clamp(this.c.lookZoom / scale, 3.5, this.zoomMax * ZOOM_FAR);
      } else if (e.pointerId === this.lookId) {
        // a thumb travels less than a mouse: a third of the screen is a full shoulder check
        const k = 5.4 / Math.max(320, window.innerWidth);
        this.turnLook(dx * k, dy * k * 0.5 * inv);
      }
    });
    // the wheel of the mouse moves the camera closer to the car or further away
    canvas.addEventListener(
      'wheel',
      (e) => {
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
      this.mouseLookYaw = 0;
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
  walkInput(): { fwd: number; turn: number; run: boolean } {
    let fwd = (this.key('KeyW', 'ArrowUp') ? 1 : 0) - (this.key('KeyS', 'ArrowDown') ? 1 : 0);
    let turn = (this.key('KeyA', 'ArrowLeft') ? 1 : 0) - (this.key('KeyD', 'ArrowRight') ? 1 : 0);
    let run = this.key('ShiftLeft', 'ShiftRight');
    if (this.key('AltLeft', 'AltRight')) fwd = turn = 0;
    if (this.touch.active) {
      fwd += this.touch.throttle - this.touch.brake;
      turn -= this.touch.steer;
    }
    const pad = this.readPad();
    if (pad) {
      fwd += pad.throttle - pad.brake;
      if (Math.abs(pad.steer) > 0.12) turn -= pad.steer;
      run ||= pad.throttle > 0.95;
    }
    return { fwd: clamp(fwd, -1, 1), turn: clamp(turn, -1, 1), run };
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

  takeCam(): Readonly<{ yaw: number; pitch: number; right: number; fwd: number; dolly: number; keyRight: number; keyFwd: number; keyUp: number; fast: boolean; reset: boolean }> {
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
    c.yaw = c.pitch = c.right = c.fwd = c.dolly = c.keyRight = c.keyFwd = c.keyUp = 0;
    c.reset = false;
    return o;
  }

  private readonly camOut = { yaw: 0, pitch: 0, right: 0, fwd: 0, dolly: 0, keyRight: 0, keyFwd: 0, keyUp: 0, fast: false, reset: false };

  /** Looking around with the mouse or a finger; the stops depend on what is turning: a head or a camera. */
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

  /** The camera was changed: look straight ahead again. */
  resetLook(orbit: boolean, freeCam = false): void {
    this.orbit = orbit;
    this.freeCam = freeCam;
    this.takeCam();
    this.mouseLookYaw = 0;
    this.mouseLookPitch = 0;
    this.c.lookYaw = 0;
    this.c.lookPitch = 0;
    this.glance = false;
  }

  /** The car that is being steered (for how much lock the keys may ask for at speed). */
/** how far the outside camera can be moved away (m) – more for a truck with a trailer */
  /** how far the camera behind the vehicle goes back as usual (the vehicle's own measure) – scrolled on, ZOOM_FAR times that */
  zoomMax = 18;

  setSteering(wheelbase: number, maxWheelAngle: number): void {
    this.wheelbase = wheelbase;
    this.maxWheelAngle = maxWheelAngle;
  }

  /**
   * How much of the steering lock an input may ask for at this speed so that
   * the car turns with at most `lateral` m/s² (v²/r, r = wheelbase / angle).
   * Full lock up to walking pace.
   */
  private lockFor(lateral: number, speed: number): number {
    return clamp((lateral * this.wheelbase) / (Math.max(speed * speed, 1) * this.maxWheelAngle), 0.003, 1);
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
      // "Foto": what does this place really look like? (also from the pause menu)
      if (code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey) this.fire('reality');
      if (!this.enabled) return;
      // Alt held with the free camera: the keys fly the camera, they do not drive
      if (this.freeCam && e.altKey) {
        e.preventDefault();
        return;
      }
      if (this.crane && code !== 'KeyV' && code !== 'KeyM' && code !== 'KeyG') {
        if (code.startsWith('Arrow') || code === 'Space') e.preventDefault();
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
        case 'KeyG':
          this.fire('door');
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
        default:
          if (/^Digit[1-6]$/.test(code) && this.gearMax === 6) c.gear = Number(code.slice(5));
          else if (code === 'Digit1' && this.gearMax === 1) c.gear = 1;
      }
      if (code.startsWith('Arrow')) e.preventDefault();
    } else {
      this.keys.delete(code);
      if (code === 'AltLeft' || code === 'AltRight') e.preventDefault();
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
    // the free camera, flown with the keys while Alt is held (the car rolls on by itself meanwhile)
    const fly = this.freeCam && this.key('AltLeft', 'AltRight');
    if (fly) {
      const cam = this.cam;
      cam.keyFwd += ((this.key('KeyW', 'ArrowUp') ? 1 : 0) - (this.key('KeyS', 'ArrowDown') ? 1 : 0)) * dt;
      cam.keyRight += ((this.key('KeyD', 'ArrowRight') ? 1 : 0) - (this.key('KeyA', 'ArrowLeft') ? 1 : 0)) * dt;
      cam.keyUp += ((this.key('KeyE', 'PageUp') ? 1 : 0) - (this.key('KeyQ', 'PageDown') ? 1 : 0)) * dt;
      cam.fast = this.key('ShiftLeft', 'ShiftRight');
    }

    if (pad && pad.kind === 'wheel') {
      c.device = 'wheel';
      c.steer = pad.steer;
      c.throttle = pad.throttle;
      c.brake = pad.brake;
      c.clutch = pad.clutch;
    } else if (pad && (Math.abs(pad.steer) > 0.02 || pad.throttle > 0.02 || pad.brake > 0.02 || c.device === 'gamepad') && (fly || !this.anyDrivingKey())) {
      c.device = 'gamepad';
      // gentle non-linearity and less lock at speed make a thumb stick usable
      const limit = this.lockFor(ANALOG_LATERAL, absSpeed);
      const shaped = Math.sign(pad.steer) * Math.abs(pad.steer) ** 1.6;
      c.steer = approach(c.steer, shaped * limit, dt * Math.max(3.5 * limit, 0.05));
      c.throttle = pad.throttle;
      c.brake = pad.brake;
      c.clutch = pad.clutch;
    } else if (this.touch.active) {
      c.device = 'touch';
      const limit = this.lockFor(ANALOG_LATERAL, absSpeed);
      c.steer = approach(c.steer, this.touch.steer * limit, dt * Math.max(4 * limit, 0.05));
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
      const limit = this.lockFor(keyLateral(absSpeed), absSpeed);
      const target = (right ? 1 : 0) - (left ? 1 : 0);
      if (target !== 0) {
        const rate = limit * (1.2 + 1.3 * (1 - limit));
        // counter-steering is quicker than winding on more lock
        if (Math.sign(c.steer) === -target) c.steer = approach(c.steer, 0, dt * Math.max(1.6 * limit, Math.abs(c.steer) * 4));
        c.steer = approach(c.steer, target * limit, dt * rate);
      } else {
        // hands off: the wheel centres itself when the car rolls, and stays put when it stands
        const centring = clamp(absSpeed / 6, 0, 1) * Math.max((1.4 + Math.abs(selfAlign) * 2.5) * Math.max(limit, 0.15), Math.abs(c.steer) * 3);
        c.steer = approach(c.steer, 0, dt * centring);
      }
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
      else if (pad.kind === 'standard' && Math.abs(this.mouseLookYaw) > 0 && !this.dragging) this.mouseLookYaw = approach(this.mouseLookYaw, 0, dt * 6);
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
        this.mouseLookYaw = approach(this.mouseLookYaw, 0, dt * 1.6);
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
