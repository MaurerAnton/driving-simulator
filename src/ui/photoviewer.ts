// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Looking at a photo or a 360° panorama of a server (net/images.ts) over
 * the game: a photo fills the screen (a pinch or the wheel zooms it, a drag
 * moves it); a panorama is put on the inside of a sphere (three.js) and
 * looked round in by dragging, pinching, the wheel – or, on a phone, by
 * turning it (the gyroscope, when the player switches it on: iOS asks
 * first).  The panorama has a small renderer of its own, made when it opens
 * and given back when it closes.
 */
import * as THREE from 'three';

const DEG = Math.PI / 180;

export interface ViewerOptions {
  /** the picture's address (a blob: one for private pictures) */
  url: string;
  pano: boolean;
  /** compass direction of the middle of a panorama / the photo, degrees (NaN unknown) */
  heading: number;
  /** a line under the picture */
  caption: string;
  /** labels */
  closeLabel: string;
  gyroLabel: string;
  /** a delete button (own pictures, or the admin's) – null: none */
  onDelete: (() => void) | null;
  deleteLabel: string;
  onClose: () => void;
}

/** A 360° panorama on a sphere, looked round in with the pointer, the wheel and (on request) the phone's turning. */
class PanoSphere {
  readonly canvas = document.createElement('canvas');
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(75, 1, 0.1, 20);
  private readonly material = new THREE.MeshBasicMaterial();
  private texture: THREE.Texture | null = null;
  yaw = 0;
  pitch = 0;
  fov = 75;
  /** the phone's turning, when on: its angles at the moment it was switched on, and now */
  private gyro: { a0: number; a: number; b: number } | null = null;
  private frame = 0;
  private readonly onOrient = (e: DeviceOrientationEvent): void => {
    if (!this.gyro || e.alpha === null || e.beta === null) return;
    if (Number.isNaN(this.gyro.a0)) this.gyro.a0 = e.alpha + this.yaw / DEG;
    this.gyro.a = e.alpha;
    this.gyro.b = e.beta;
  };

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.SphereGeometry(5, 64, 32);
    geo.scale(-1, 1, 1);
    this.scene.add(new THREE.Mesh(geo, this.material));
    const loop = (): void => {
      this.frame = requestAnimationFrame(loop);
      this.draw();
    };
    this.frame = requestAnimationFrame(loop);
  }

  async load(url: string, maxWidth: number): Promise<void> {
    const img = new Image();
    if (!url.startsWith('blob:') && !url.startsWith('data:')) img.crossOrigin = 'anonymous';
    await new Promise<void>((ok, bad) => {
      img.onload = () => ok();
      img.onerror = () => bad(new Error('The picture could not be loaded'));
      img.src = url;
    });
    let src: HTMLImageElement | HTMLCanvasElement = img;
    if (img.naturalWidth > maxWidth) {
      const c = document.createElement('canvas');
      c.width = maxWidth;
      c.height = Math.round((img.naturalHeight * maxWidth) / img.naturalWidth);
      c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
      src = c;
    }
    const tex = new THREE.Texture(src);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    this.texture?.dispose();
    this.texture = tex;
    this.material.map = tex;
    this.material.needsUpdate = true;
  }

  get maxTexture(): number {
    return Math.min(8192, this.renderer.capabilities.maxTextureSize);
  }

  drag(dx: number, dy: number): void {
    const h = Math.max(1, this.canvas.clientHeight);
    const k = (this.fov * DEG) / h;
    this.yaw -= dx * k;
    this.pitch = Math.max(-85 * DEG, Math.min(85 * DEG, this.pitch + dy * k));
    if (this.gyro) this.gyro.a0 = Number.NaN;
  }

  zoom(f: number): void {
    this.fov = Math.max(25, Math.min(100, this.fov * f));
  }

  /** the phone's turning on or off – false: not available (or refused) */
  async setGyro(on: boolean): Promise<boolean> {
    if (!on) {
      this.gyro = null;
      window.removeEventListener('deviceorientation', this.onOrient);
      return true;
    }
    const D = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (!D) return false;
    try {
      if (typeof D.requestPermission === 'function' && (await D.requestPermission()) !== 'granted') return false;
    } catch {
      return false;
    }
    this.gyro = { a0: Number.NaN, a: 0, b: 90 };
    window.addEventListener('deviceorientation', this.onOrient);
    return true;
  }

  private draw(): void {
    const c = this.canvas;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (w < 2 || h < 2 || !this.texture) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) this.renderer.setSize(w, h, false);
    const g = this.gyro;
    if (g && !Number.isNaN(g.a0)) {
      // (alpha: the compass turn – turning left raises it; beta: 90° held upright)
      this.yaw = -(g.a - g.a0) * DEG;
      this.pitch = Math.max(-85 * DEG, Math.min(85 * DEG, (g.b - 90) * DEG));
    }
    const cam = this.camera;
    cam.aspect = w / h;
    cam.fov = this.fov;
    cam.updateProjectionMatrix();
    const cp = Math.cos(this.pitch);
    cam.lookAt(-Math.cos(this.yaw) * cp, Math.sin(this.pitch), -Math.sin(this.yaw) * cp);
    this.renderer.render(this.scene, cam);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    void this.setGyro(false);
    this.texture?.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** The viewer as an overlay; `close()` takes it away (and gives back what it held). */
export function photoViewer(o: ViewerOptions): { node: HTMLElement; close: () => void } {
  const node = el('div', 'overlay net-viewer');
  const stage = el('div', 'net-viewer-stage');
  const bar = el('div', 'net-viewer-bar');
  const cap = el('div', 'net-viewer-cap', o.caption);
  const status = el('div', 'net-viewer-status', '…');
  stage.append(status);
  let sphere: PanoSphere | null = null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    sphere?.dispose();
    sphere = null;
    node.remove();
  };
  const x = el('button', 'x-close panel-x', '✕');
  x.type = 'button';
  x.title = o.closeLabel;
  x.setAttribute('aria-label', o.closeLabel);
  x.onclick = () => {
    close();
    o.onClose();
  };
  // pointers: a drag looks round (or moves the photo), two fingers zoom
  const pts = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  let photo: HTMLImageElement | null = null;
  const view = { k: 1, x: 0, y: 0 };
  const applyPhoto = (): void => {
    if (photo) photo.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  };
  const zoomBy = (f: number): void => {
    if (sphere) sphere.zoom(1 / f);
    else {
      view.k = Math.max(1, Math.min(8, view.k * f));
      if (view.k === 1) view.x = view.y = 0;
      applyPhoto();
    }
  };
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0 && d > 0) zoomBy(d / pinch);
      pinch = d;
    } else if (sphere) sphere.drag(dx, dy);
    else if (view.k > 1) {
      view.x += dx;
      view.y += dy;
      applyPhoto();
    }
  });
  const up = (e: PointerEvent): void => {
    pts.delete(e.pointerId);
    pinch = 0;
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  if (o.pano) {
    sphere = new PanoSphere();
    stage.append(sphere.canvas);
    const s = sphere;
    s.load(o.url, s.maxTexture).then(
      () => {
        // (the middle of the picture where it looks; the player looks north at first, if its direction is known)
        if (Number.isFinite(o.heading)) s.yaw = -o.heading * DEG;
        status.remove();
      },
      () => (status.textContent = '⚠'),
    );
    if (typeof window !== 'undefined' && 'DeviceOrientationEvent' in window) {
      const g = el('button', 'btn ghost small', o.gyroLabel);
      g.type = 'button';
      let on = false;
      g.onclick = async () => {
        on = !on;
        const ok = await s.setGyro(on);
        if (!ok) on = false;
        g.classList.toggle('on', on);
      };
      bar.append(g);
    }
  } else {
    photo = el('img', 'net-viewer-photo');
    photo.alt = o.caption;
    photo.decoding = 'async';
    photo.draggable = false;
    photo.onload = () => status.remove();
    photo.onerror = () => (status.textContent = '⚠');
    photo.src = o.url;
    stage.append(photo);
  }
  if (o.onDelete) {
    const del = el('button', 'btn ghost small warn', o.deleteLabel);
    del.type = 'button';
    const go = o.onDelete;
    del.onclick = () => go();
    bar.append(del);
  }
  node.append(stage, x, cap, bar);
  return { node, close };
}
