// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The free camera that flies (the camera key's third view, from 1.7.0): no
 * longer tied to the vehicle, it goes wherever it is flown, and the world
 * loads round it (the game's focus()).  The vehicle meanwhile waits where it
 * is, braked (input/input.ts `flyCam`).
 *
 *  - Keys: W S (↑ ↓) forwards and back the way the camera looks – up or down
 *    with it –, A D (← →) to the side, E Q (Page Up, Page Down) straight up
 *    and down; Shift: four times as fast.
 *  - The mouse: held and moved, it looks round; the right (or middle) button
 *    held moves the camera over the ground; the wheel sets how fast it
 *    flies, in steps – the game shows the speed for a moment.
 *  - Fingers: the stick on the left flies (ui/touchstick.ts, with buttons
 *    for up and down), one finger on the picture looks round, two fingers
 *    moved up or down lift or lower it, pinching sets the speed.
 *
 * Speeds go in steps of √2 from 1.5 m/s to about 380 m/s.  The camera starts
 * where the camera was, looking the way it looked; it keeps above the ground
 * and below 1500 m over it.  Free of the DOM: tested in
 * tests/game/flycam.test.ts.
 */

/** the speed steps: 1.5 m/s × √2^k */
export const FLY_MIN_STEP = 0;
export const FLY_MAX_STEP = 16;
const BASE = 1.5;

/** What was asked of the camera since the last picture (Input.takeCam: key time in seconds, drags in parts of the screen). */
export interface FlyInput {
  yaw: number;
  pitch: number;
  /** dragged with the right or middle button: over the ground, in parts of the screen's height */
  right: number;
  fwd: number;
  /** seconds of key time (or stick) this picture: forwards, to the right, up */
  keyFwd: number;
  keyRight: number;
  keyUp: number;
  fast: boolean;
  /** two fingers moved up (+) or down, in parts of the screen's height */
  lift: number;
  /** speed steps asked for (the wheel, a pinch) */
  speed: number;
}

export class FlyCam {
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  pitch = -0.2;
  /** the speed step (see FLY_MIN_STEP …): continuous, shown rounded */
  step = 6;
  /** has a place: else it is taken from the camera when flying begins */
  ready = false;
  private vx = 0;
  private vy = 0;
  private vz = 0;

  /** metres a second at the step chosen */
  get speed(): number {
    return BASE * Math.SQRT2 ** Math.round(this.step);
  }

  /** Begin from where a camera is, looking the way it looks (direction dx, dy, dz). */
  start(x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    const l = Math.hypot(dx, dy, dz) || 1;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = Math.asin(Math.max(-1, Math.min(1, dy / l)));
    this.vx = this.vy = this.vz = 0;
    this.ready = true;
  }

  /**
   * One picture: turned, flown, kept above the ground (`ground(x, z)`: its
   * height there, NaN where nothing is loaded).  Returns true when the speed
   * step changed (for the game to show it).
   */
  update(dt: number, t: FlyInput, ground: (x: number, z: number) => number): boolean {
    const was = Math.round(this.step);
    this.step = Math.max(FLY_MIN_STEP, Math.min(FLY_MAX_STEP, this.step + t.speed));
    this.yaw += t.yaw;
    this.pitch = Math.max(-1.55, Math.min(1.45, this.pitch + t.pitch));
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    // what the keys (or the stick) ask for: −1 … 1 each, from the key time of this picture
    const k = 1 / Math.max(dt, 1e-3);
    const f = Math.max(-1, Math.min(1, t.keyFwd * k));
    const r = Math.max(-1, Math.min(1, t.keyRight * k));
    const u = Math.max(-1, Math.min(1, t.keyUp * k));
    const n = Math.max(1, Math.hypot(f, r, u));
    const v = (this.speed * (t.fast ? 4 : 1)) / n;
    // forwards along the look (up or down with it), to the right level, up straight up
    const wx = (-sy * cp * f + cy * r) * v;
    const wy = (sp * f + u) * v;
    const wz = (-cy * cp * f - sy * r) * v;
    // (eased: no jerk when a key goes down or up)
    const ease = 1 - Math.exp(-dt * 7);
    this.vx += (wx - this.vx) * ease;
    this.vy += (wy - this.vy) * ease;
    this.vz += (wz - this.vz) * ease;
    let g = ground(this.x, this.z);
    // dragged over the ground: a drag across the screen moves it about as far as it is high (metres near the ground, a block from high up)
    const reach = Math.max(4, Math.min(400, (Number.isNaN(g) ? 30 : this.y - g) * 1.6 + 3));
    const dragR = t.right * reach;
    const dragF = t.fwd * reach;
    this.x += this.vx * dt + cy * dragR - sy * dragF;
    this.z += this.vz * dt - sy * dragR - cy * dragF;
    this.y += this.vy * dt + t.lift * Math.max(8, reach * 0.6);
    g = ground(this.x, this.z);
    if (!Number.isNaN(g)) {
      if (this.y < g + 0.5) {
        this.y = g + 0.5;
        if (this.vy < 0) this.vy = 0;
      }
      this.y = Math.min(this.y, g + 1500);
    }
    return Math.round(this.step) !== was;
  }
}
