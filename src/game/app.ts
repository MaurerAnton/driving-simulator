// SPDX-License-Identifier: AGPL-3.0-only
/** Rendering core shared by the game and the debug viewer. */
import * as THREE from 'three';
import { Sky } from '../render/sky.ts';
import { TileManager } from '../render/tiles.ts';
import type { WorldJson } from '../world/types.ts';
import { World } from '../world/world.ts';

export class App {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.08, 4500);
  readonly sky = new Sky();
  world!: World;
  tiles!: TileManager;
  readonly baseUrl: string;
  pixelRatioCap = 1.5;
  /** fraction of the screen's pixels that is drawn (below 1: a softer picture that costs less) */
  renderScale = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.baseUrl = new URL('map/', document.baseURI).href;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    // shadows are switched by the light (see setShadows): the renderer is always ready for them
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.fog = this.sky.fog;
    this.scene.add(this.sky.dome, this.sky.sun, this.sky.sun.target, this.sky.hemi);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  async loadWorld(onProgress?: (text: string) => void): Promise<void> {
    onProgress?.('world');
    const res = await fetch(`${this.baseUrl}world.json`);
    if (!res.ok) throw new Error(`world.json: HTTP ${res.status}`);
    const json = (await res.json()) as WorldJson;
    // (a breath for the page between the big steps, so that the loading screen is drawn)
    await new Promise((r) => setTimeout(r));
    this.world = new World(json);
    this.tiles = new TileManager(json, this.baseUrl);
    this.scene.add(this.tiles.group);
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap) * this.renderScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Shadows of the sun around the car: `mapSize` pixels square (0 = none)
   * for a box reaching `reach` metres from the car to every side.
   */
  setShadows(mapSize: number, reach: number): void {
    const sun = this.sky.sun;
    sun.castShadow = mapSize > 0;
    if (mapSize === 0) return;
    const cam = sun.shadow.camera;
    cam.left = -reach;
    cam.right = reach;
    cam.top = reach;
    cam.bottom = -reach;
    cam.near = 60;
    cam.far = 640;
    cam.updateProjectionMatrix();
    if (sun.shadow.mapSize.x !== mapSize) {
      sun.shadow.mapSize.set(mapSize, mapSize);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    // enough to keep surfaces from shadowing themselves, little enough to keep shadows attached to what casts them
    const texel = (2 * reach) / mapSize;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = Math.max(0.05, texel * 1.6);
    sun.shadow.radius = 1.6;
  }

  render(focus: THREE.Vector3): void {
    this.sky.follow(this.camera, focus);
    this.renderer.render(this.scene, this.camera);
  }
}
