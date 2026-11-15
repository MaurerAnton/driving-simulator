// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Viewer for 360° panoramas (equirectangular pictures): the picture is put on
 * the inside of a sphere and looked at from its centre.  It is drawn with the
 * game's own renderer into a rectangle of the window, so no second 3D context
 * is needed.
 */
import * as THREE from 'three';

const DEG = Math.PI / 180;

export class PanoramaView {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(75, 1, 0.1, 20);
  private readonly material = new THREE.MeshBasicMaterial({ toneMapped: false });
  private texture: THREE.Texture | null = null;
  private loadId = 0;
  private readonly size = new THREE.Vector2();
  private readonly clear = new THREE.Color();
  private readonly dir = new THREE.Vector3();
  /** viewing direction relative to the middle of the picture, radians: positive = to the right / up */
  yaw = 0;
  pitch = 0;
  /** vertical field of view in degrees */
  fov = 75;

  constructor() {
    const geo = new THREE.SphereGeometry(5, 96, 48);
    geo.scale(-1, 1, 1); // seen from the inside, not mirrored
    this.scene.add(new THREE.Mesh(geo, this.material));
  }

  get active(): boolean {
    return this.texture !== null;
  }

  /**
   * Load a panorama.  Pictures larger than `maxWidth` are scaled down first
   * (downloaded street-view panoramas reach 16384 × 8192 pixels, more than
   * many graphics chips take as one texture).  Rejects if the picture cannot
   * be loaded or may not be used as a texture.
   */
  async show(src: string, maxWidth: number): Promise<void> {
    const id = ++this.loadId;
    const img = new Image();
    if (!src.startsWith('blob:') && !src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('The picture could not be loaded'));
      img.src = src;
    });
    if (id !== this.loadId) return; // something else was chosen meanwhile
    let source: HTMLImageElement | HTMLCanvasElement = img;
    const scale = Math.min(1, maxWidth / img.naturalWidth);
    if (scale < 1) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const g = canvas.getContext('2d');
      if (!g) throw new Error('No 2D canvas');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      source = canvas;
    }
    const tex = new THREE.Texture(source);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping; // no seam where the picture closes
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    this.dispose();
    this.texture = tex;
    this.material.map = tex;
    this.material.needsUpdate = true;
    this.pitch = 0;
    this.fov = 75;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
    this.material.map = null;
  }

  /** Stop showing (and forget a load that is still under way). */
  close(): void {
    this.loadId++;
    this.dispose();
  }

  /** The pointer dragged the picture by (dx, dy) pixels in a view `viewHeight` pixels high. */
  drag(dx: number, dy: number, viewHeight: number): void {
    const perPixel = (this.fov * DEG) / Math.max(1, viewHeight);
    this.yaw -= dx * perPixel;
    this.pitch = Math.max(-85 * DEG, Math.min(85 * DEG, this.pitch + dy * perPixel));
  }

  zoom(delta: number): void {
    this.fov = Math.max(20, Math.min(100, this.fov * Math.exp(delta * 0.0012)));
  }

  /**
   * Draw into the rectangle `rect` (CSS pixels, relative to the top left of
   * the canvas); the rest of the canvas is cleared.
   */
  render(renderer: THREE.WebGLRenderer, rect: { left: number; top: number; width: number; height: number }): void {
    if (!this.texture || rect.width < 2 || rect.height < 2) return;
    renderer.getSize(this.size);
    renderer.getClearColor(this.clear);
    const alpha = renderer.getClearAlpha();
    renderer.setScissorTest(false);
    renderer.setClearColor(0x0b1118, 1);
    renderer.clear();
    const y = this.size.y - rect.top - rect.height;
    renderer.setViewport(rect.left, y, rect.width, rect.height);
    renderer.setScissor(rect.left, y, rect.width, rect.height);
    renderer.setScissorTest(true);
    const cam = this.camera;
    cam.aspect = rect.width / rect.height;
    cam.fov = this.fov;
    cam.updateProjectionMatrix();
    // the middle of the picture lies on the -X axis, turning right goes towards -Z
    const cp = Math.cos(this.pitch);
    this.dir.set(-Math.cos(this.yaw) * cp, Math.sin(this.pitch), -Math.sin(this.yaw) * cp);
    cam.position.set(0, 0, 0);
    cam.lookAt(this.dir);
    renderer.render(this.scene, cam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.size.x, this.size.y);
    renderer.setClearColor(this.clear, alpha);
  }
}
