// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A mirror looked into: its picture drawn large over a part of the screen.
 *
 * The mirror's own camera (render/mirrors.ts, the driver's eye reflected in
 * the glass) is pointed at what the glass shows – in the shape of the panel,
 * and for a glass far from the eye (the door mirror on the passenger's side
 * is more than a metre and a half away: it shows a few degrees) widened to
 * at least MIN_ANGLE up and down, still far narrower than the view through
 * the windscreen – and renders into a picture as sharp as the panel it
 * fills.  That picture is then laid onto the screen, after the scene,
 * flipped left to right as a mirror shows it.  For parking: the kerb, the
 * line of the bay or the edge of the garage door beside the rear wheel.
 *
 * Costs one more picture of the scene each frame while it is open (without a
 * new shadow map: the scene's of this frame is still right).
 */
import * as THREE from 'three';
import type { Mirror } from './mirrors.ts';

/** how far up and down the picture reaches at least (rad, the whole angle) */
const MIN_ANGLE = (14 * Math.PI) / 180;
const MIN_TAN = Math.tan(MIN_ANGLE / 2);
/** the largest picture rendered (px): enough for half a big screen, little enough for a phone's graphics chip */
const MAX_W = 1600;
const MAX_H = 900;

export class MirrorZoom {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly quad: THREE.Mesh;
  private readonly screen = new THREE.Scene();
  private readonly flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly size = new THREE.Vector2();

  constructor() {
    this.target = new THREE.WebGLRenderTarget(4, 4, {
      depthBuffer: true,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      samples: 0,
      // like the glass: linear and un-tonemapped, tone mapping and sRGB when laid onto the screen
      type: THREE.HalfFloatType,
    });
    const g = new THREE.PlaneGeometry(2, 2);
    // a mirror shows the camera's right on the viewer's left: u runs right → left
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    this.quad = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: this.target.texture, depthTest: false, depthWrite: false, fog: false }));
    this.quad.frustumCulled = false;
    this.screen.add(this.quad);
  }

  /**
   * Draw the picture of `mirror` into the rectangle `rect` of the canvas (CSS
   * pixels of the canvas, from its top left corner), after the scene was
   * drawn.  `frame`: the world matrix of what the mirror is fixed to, `eye`:
   * the driver's eye in the world.  False: nothing to show (the eye behind the glass).
   * `opts.minTan`: how far up and down the picture reaches at least (the
   * tangent; the inside mirror in the HUD shows what its glass shows: 0);
   * `opts.refresh` false: lay the last picture again without drawing the scene anew.
   */
  draw(renderer: THREE.WebGLRenderer, scene: THREE.Scene, mirror: Mirror, frame: THREE.Matrix4, eye: THREE.Vector3, far: number, rect: { x: number; y: number; w: number; h: number }, opts: { minTan?: number; refresh?: boolean } = {}): boolean {
    if (rect.w < 8 || rect.h < 8) return false;
    if (!mirror.aim(frame, eye, far, 1, rect.w / rect.h, opts.minTan ?? MIN_TAN)) return false;
    // as sharp as the panel is on the screen, within limits
    const pr = renderer.getPixelRatio();
    const k = Math.min(1, MAX_W / (rect.w * pr), MAX_H / (rect.h * pr));
    const w = Math.max(16, Math.round(rect.w * pr * k));
    const h = Math.max(16, Math.round(rect.h * pr * k));
    const resized = this.target.width !== w || this.target.height !== h;
    if (resized) this.target.setSize(w, h);
    if (opts.refresh !== false || resized) this.picture(renderer, scene, mirror);
    this.lay(renderer, rect);
    return true;
  }

  /** The mirror's picture into the target. */
  private picture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, mirror: Mirror): void {
    // the picture: the mirror's own glass is not in it (as when the glass itself is drawn)
    const prevTarget = renderer.getRenderTarget();
    const prevVisible = mirror.mesh.visible;
    const shadows = renderer.shadowMap.autoUpdate;
    mirror.mesh.visible = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, mirror.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = shadows;
    mirror.mesh.visible = prevVisible;
  }

  /** The picture laid onto the screen, over what is there. */
  private lay(renderer: THREE.WebGLRenderer, rect: { x: number; y: number; w: number; h: number }): void {
    renderer.getSize(this.size);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    const y = this.size.y - rect.y - rect.h;
    renderer.setViewport(rect.x, y, rect.w, rect.h);
    renderer.setScissor(rect.x, y, rect.w, rect.h);
    renderer.setScissorTest(true);
    renderer.render(this.screen, this.flat);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.size.x, this.size.y);
    renderer.setScissor(0, 0, this.size.x, this.size.y);
    renderer.autoClear = autoClear;
  }

  dispose(): void {
    this.target.dispose();
    this.quad.geometry.dispose();
    (this.quad.material as THREE.Material).dispose();
  }
}
