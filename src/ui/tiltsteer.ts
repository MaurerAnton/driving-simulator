// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Steering by tilting the phone (settings: tiltSteer) on a touch screen
 * (input/input.ts).  The phone's left/right tilt – DeviceOrientationEvent's
 * `gamma`, degrees about the front-back axis, negative when tilted left – is
 * turned into the steer −1 … +1 the on-screen bar would give, and written into
 * `input.touch.steer` while it runs, so the driving reads it exactly as it
 * reads the bar.
 *
 * The browser's caveats, as they are:
 *
 *  - iOS (Safari and anything WebKit) asks for permission the first time:
 *    `DeviceOrientationEvent.requestPermission()` from a gesture – the toggle
 *    in the settings is that gesture.  Android and desktop never ask.
 *  - Some devices fire no event without motion (a phone lying still may send
 *    nothing until it moves); the listener simply waits.
 *  - The event's `gamma` is only meaningful with the phone held in the usual
 *    portrait way; a phone flat on its back reports ~0 – the steering then
 *    centres itself, which is what the driver wants anyway.
 *
 * The tilt is calibrated when it is switched on: the angle held then is
 * straight ahead (`neutral`), and the steer is the difference, scaled so a
 * comfortable hand tilt (TILT_DEG) reaches full lock.  Let go of the phone and
 * it steers as it hangs – to be switched off again for a phone in a pocket.
 */

/** Degrees of tilt from straight ahead that reach full lock (a comfortable hand angle). */
export const TILT_DEG = 30;

/** What the driver needs from the phone: the phone's left/right tilt, and a way to ask for it. */
export interface TiltSource {
  /** the current tilt −1 … +1 (negative: tilted left), or null when nothing has arrived yet */
  readonly steer: number | null;
  /** start listening (asks the browser where it asks); false: no sensors / permission refused */
  start(): Promise<boolean>;
  /** stop listening and centre the steer */
  stop(): void;
}

const clamp01 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

/**
 * The steer −1 … +1 from the tilt: the difference to the calibrated angle,
 * scaled so `TILT_DEG` of tilt is full lock.  `gamma` is null on a device that
 * reports nothing (a phone on its back): no steering then (null).
 */
export function steerFromTilt(gammaDeg: number, neutralDeg: number): number {
  if (!Number.isFinite(gammaDeg)) return 0;
  return clamp01((gammaDeg - neutralDeg) / TILT_DEG);
}

/** The listeners and state of the tilt steering, when the setting is on. */
export class TiltSteer implements TiltSource {
  private listener: ((e: DeviceOrientationEvent) => void) | null = null;
  private neutral = 0;
  private value: number | null = null;
  /** where the steer goes every event (input.touch.steer); null: not wired */
  private readonly out: (steer: number) => void;

  constructor(out: (steer: number) => void) {
    this.out = out;
  }

  get steer(): number | null {
    return this.value;
  }

  private readonly onOrient = (e: DeviceOrientationEvent): void => {
    if (e.gamma === null || e.beta === null) return;
    // (the first reading calibrates: what the phone is held at then is straight ahead)
    if (this.value === null) this.neutral = e.gamma;
    this.value = steerFromTilt(e.gamma, this.neutral);
    // (a line in the console now and then, so a phone one cannot see into still says whether
    //  the sensor speaks and what it says – console.debug, once a second at most)
    const now = Date.now();
    if (now - this.lastLog > 1000) {
      this.lastLog = now;
      console.debug(`[tilt] gamma ${e.gamma.toFixed(1)}° neutral ${this.neutral.toFixed(1)}° → steer ${this.value.toFixed(2)}`);
    }
    this.out(this.value);
  };
  private lastLog = 0;

  async start(): Promise<boolean> {
    if (this.listener) return true;
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return false;
    // (the listener is attached at once: on Android and most browsers the events come with no
    //  asking.  iOS asks a permission that only a gesture may be given for, so there it is asked
    //  at the first touch or key – until then the events simply do not arrive, and the setting
    //  stays on rather than being turned off for want of a gesture at start-up)
    this.value = null; // (the next event calibrates)
    this.listener = this.onOrient;
    window.addEventListener('deviceorientation', this.listener);
    console.debug('[tilt] listening for deviceorientation');
    const D = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (D && typeof D.requestPermission === 'function') {
      const ask = async (): Promise<void> => {
        window.removeEventListener('pointerdown', ask, true);
        window.removeEventListener('keydown', ask, true);
        try {
          if ((await D.requestPermission!()) !== 'granted') this.stop();
        } catch {
          this.stop();
        }
      };
      window.addEventListener('pointerdown', ask, true);
      window.addEventListener('keydown', ask, true);
    }
    return true;
  }

  stop(): void {
    if (this.listener) window.removeEventListener('deviceorientation', this.listener);
    this.listener = null;
    if (this.value !== null) this.out(0);
    this.value = null;
  }
}
