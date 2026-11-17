// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Zooming the view: a closer look through the eyes on foot and from the
 * driver's seat – at a sign far ahead, a house number, the lights of a
 * junction.
 *
 * On a phone two fingers pinch the view larger or smaller; the zoom stays
 * while they are on the glass.  On a computer the mouse wheel (or a pinch of
 * the touchpad, which the browser sends as a wheel) and the keys + and −
 * zoom; a key held keeps the zoom like a finger.  Once let go the view goes
 * back to its usual width by itself – after a time the settings choose
 * (Settings.zoomRelease): "auto" lets it go at once when the fingers lift and
 * a few seconds after the wheel or a key, or never.
 *
 * It only narrows the camera's angle of view (fov): nothing else is drawn,
 * nothing costs more.  Pure arithmetic, tested in tests/input/camzoom.test.ts.
 */

/** what the settings may choose for letting the zoom go */
export type ZoomRelease = 'auto' | 'release' | '3' | '6' | '12' | 'never';
export const ZOOM_RELEASES: readonly ZoomRelease[] = ['auto', 'release', '3', '6', '12', 'never'];

/** the closest the view goes: four times */
export const ZOOM_MAX = 4;
/** one notch of the wheel or one press of a key: this much closer */
const STEP = 1.25;
/** "auto": how long after the wheel or a key the zoom lets go (s) */
const AUTO_DELAY = 4;
/** the wheel can not be "held": a zoom by it stays at least this long (s) */
const WHEEL_MIN = 1.5;

export class CamZoom {
  /** how many times larger the view is drawn now (1: as usual) */
  factor = 1;
  /** … and where it is going */
  target = 1;
  private fingers = false;
  private key = false;
  /** what zoomed last: the fingers, the wheel or a key */
  private source: 'touch' | 'wheel' | 'key' = 'touch';
  /** seconds since the zoom was last touched or let go */
  private idle = 0;

  /** Is the zoom held (fingers on the glass, a key down)? */
  get held(): boolean {
    return this.fingers || this.key;
  }

  /** Two fingers moved apart by `scale` (new spread / old spread). */
  pinch(scale: number): void {
    if (!(scale > 0) || !Number.isFinite(scale)) return;
    this.fingers = true;
    this.source = 'touch';
    this.set(this.target * scale);
  }

  /** The fingers are off the glass (fewer than two left). */
  fingersOff(): void {
    if (!this.fingers) return;
    this.fingers = false;
    this.idle = 0;
  }

  /** A turn of the wheel: `step` > 0 away (smaller), < 0 closer – as the wheel moves the camera behind the car. */
  wheel(step: number): void {
    if (!Number.isFinite(step)) return;
    this.source = 'wheel';
    this.idle = 0;
    this.set(this.target * Math.exp(-step * 1.6));
  }

  /** A key + (`dir` 1) or − (−1) went down (true) or up (false). */
  press(dir: number, down: boolean): void {
    if (!down) {
      if (this.key) this.idle = 0;
      this.key = false;
      return;
    }
    this.key = true;
    this.source = 'key';
    this.idle = 0;
    this.set(this.target * (dir > 0 ? STEP : 1 / STEP));
  }

  /** Back to the usual view at once (another view, out of the vehicle …). */
  reset(): void {
    this.factor = this.target = 1;
    this.fingers = this.key = false;
    this.idle = 0;
  }

  /** How long after being let go the zoom goes back (s; Infinity: never). */
  delay(release: ZoomRelease): number {
    switch (release) {
      case 'never':
        return Infinity;
      case 'release':
        return this.source === 'wheel' ? WHEEL_MIN : 0;
      case '3':
      case '6':
      case '12':
        return Number(release);
      default:
        return this.source === 'touch' ? 0 : AUTO_DELAY;
    }
  }

  /**
   * Each frame: `active` – the view can be zoomed now (else it is reset).
   * Lets the zoom go when its time is up and moves the factor smoothly to
   * where it is going.
   */
  update(dt: number, release: ZoomRelease, active: boolean): void {
    if (!active) {
      if (this.factor !== 1 || this.target !== 1 || this.held) this.reset();
      return;
    }
    if (!this.held && this.target !== 1) {
      this.idle += dt;
      if (this.idle >= this.delay(release)) this.target = 1;
    }
    // (in steps of the logarithm: zooming in and out feel alike)
    const a = Math.log(this.factor);
    const b = Math.log(this.target);
    const k = this.held ? 1 - Math.exp(-dt * 18) : 1 - Math.exp(-dt * 7);
    const next = a + (b - a) * k;
    this.factor = Math.abs(next - b) < 0.002 ? this.target : Math.exp(next);
  }

  /** The angle of view (degrees) for a camera whose usual one is `base`. */
  fov(base: number): number {
    if (this.factor === 1) return base;
    const half = (base * Math.PI) / 360;
    return (Math.atan(Math.tan(half) / this.factor) * 360) / Math.PI;
  }

  private set(f: number): void {
    this.target = Math.max(1, Math.min(ZOOM_MAX, f));
  }
}
