// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A tap on the vehicle's own screen in the driver's seat (the car's centre
 * display, the screen of the truck, the bus, the tractor, the tram's desk –
 * render/navscreen.ts): it opens the big map, or – as the settings choose
 * (Settings.screenTap) – brings the live map back into the corner of the HUD
 * (`peek`), where it is easier to read on a small screen; another tap on the
 * vehicle's screen puts it there again.
 *
 * A tap is a pointer let go soon and near where it came down; it is checked
 * against the screen's picture in the scene with one ray (no cost while
 * nothing is tapped).
 */
import * as THREE from 'three';
import type { VehicleScreen } from '../render/navscreen.ts';

/** a tap: let go within this time (ms) and this distance (px) of where it came down */
const TAP_MS = 450;
const TAP_PX = 12;

export class ScreenTap {
  /** the corner map is shown instead of the map on the vehicle's screen */
  peek = false;
  /** the screen that can be tapped now (set by the game each frame; null: none) */
  private screen: VehicleScreen | null = null;
  private setAt = 0;
  private readonly down = { id: -1, x: 0, y: 0, t: 0 };
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly hits: THREE.Intersection[] = [];

  /**
   * `camera`: the camera the picture is drawn with; `mode`: what a tap does
   * now; `openMap`: opens the big map.
   */
  constructor(canvas: HTMLCanvasElement, camera: THREE.Camera, mode: () => 'bigmap' | 'minimap', openMap: () => void) {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      Object.assign(this.down, { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() });
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      if (e.pointerId !== d.id) return;
      d.id = -1;
      if (performance.now() - d.t > TAP_MS || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_PX) return;
      // (only a screen the game named a moment ago: not after the drive has ended)
      const screen = performance.now() - this.setAt < 500 ? this.screen : null;
      const mesh = screen?.hitMesh?.() ?? null;
      if (!mesh || !this.hit(mesh, camera, canvas, e.clientX, e.clientY)) return;
      if (mode() === 'minimap') this.peek = !this.peek;
      else openMap();
    });
  }

  /** Each frame: the vehicle's screen in view in the driver's seat (null: none – then the corner map is the map anyway). */
  setScreen(screen: VehicleScreen | null): void {
    this.screen = screen;
    this.setAt = performance.now();
  }

  private hit(mesh: THREE.Object3D, camera: THREE.Camera, canvas: HTMLCanvasElement, x: number, y: number): boolean {
    const r = canvas.getBoundingClientRect();
    this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, camera);
    this.hits.length = 0;
    this.ray.intersectObject(mesh, false, this.hits);
    return this.hits.length > 0;
  }
}
