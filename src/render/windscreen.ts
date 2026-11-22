// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The windscreen in rain and snow, seen from the driver's seat ("very high"
 * graphics only): drops gather on the glass and run up and to the sides
 * when driving fast, a sheet of water and the spray of the road blur the
 * view, snowflakes settle and build up into a white cover – and the wipers
 * sweep it clear (game/wipers.ts keeps what lies where, and the stalk).
 *
 * How it is drawn, cheaply: one thin mesh lying just inside the windscreen
 * of the vehicle (so the dashboard, the pillars and the driver's hands stand
 * in front of it as they should), with a shader that
 *   - reads a coarse grid of the glass (48 × 24: water, snow, dirt, drops)
 *     sent up each frame as a tiny texture;
 *   - draws the drops themselves procedurally, a few per centimetre, each a
 *     little lens that shows the scene behind it upside down;
 *   - blurs the picture behind it where water lies: after each frame the
 *     picture is copied into a texture (one copy on the graphics chip), and
 *     the next frame samples it around each point of the glass;
 *   - lays the snow over it, and draws the two wiper arms where they are.
 *
 * Where the glass is: for a car from its body (render/carBody.ts: the
 * windscreen runs from the cowl to the roof's front edge, crowned in the
 * middle); for a truck, a bus, a tractor or a crane's cab the biggest pane
 * of glass in front of the driver's eyes; the tram's cab has an opening.
 */
import * as THREE from 'three';
import { Windscreen, nextWiperMode } from '../game/wipers.ts';
import type { ScreenWeather, WiperMode } from '../game/wipers.ts';
import { GLASS } from './truck.ts';

/** The glass as a mesh in the model's frame, and its size along the glass (m). */
interface GlassShape {
  geometry: THREE.BufferGeometry;
  width: number;
  height: number;
}

/** A model the player drives (render/fleet.ts VehicleModel), as far as this needs it. */
export interface ScreenModel {
  readonly root: THREE.Group;
  readonly eye: THREE.Vector3;
}

/** The car's body, as render/car.ts keeps it (PlayerCar.exterior.shell). */
interface ShellLike {
  zCowl: number;
  zRoofFront: number;
  halfWidth: number;
  roofY: number;
  cowlY: number;
  cowlCrownY: number;
}

/** how far inside the glass the mesh lies (m) */
const INSET = 0.014;

/**
 * Rows of points across the glass, foot to top (each row left → right as the
 * driver sees it), as a mesh: u across, v up.  `inward`: the way into the cab.
 */
function sheet(rows: THREE.Vector3[][], inward: THREE.Vector3): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const n = rows[0].length;
  rows.forEach((row, j) => {
    row.forEach((p, i) => {
      pos.push(p.x + inward.x * INSET, p.y + inward.y * INSET, p.z + inward.z * INSET);
      uv.push(i / (n - 1), j / (rows.length - 1));
    });
  });
  for (let j = 0; j + 1 < rows.length; j++) {
    for (let i = 0; i + 1 < n; i++) {
      const a = j * n + i;
      idx.push(a, a + 1, a + n + 1, a, a + n + 1, a + n);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** The car's windscreen: from the cowl up to the roof's front edge, a little narrower than the body. */
function carGlass(sh: ShellLike): GlassShape {
  const hw = sh.halfWidth;
  // (kept clear of the A pillars standing on its edges)
  const k = 0.93;
  const foot = [new THREE.Vector3(-hw * 0.9 * k, sh.cowlY, sh.zCowl), new THREE.Vector3(0, sh.cowlCrownY, sh.zCowl), new THREE.Vector3(hw * 0.9 * k, sh.cowlY, sh.zCowl)];
  const top = [new THREE.Vector3(-hw * 0.74 * k, sh.roofY - 0.055, sh.zRoofFront), new THREE.Vector3(0, sh.roofY - 0.004, sh.zRoofFront), new THREE.Vector3(hw * 0.74 * k, sh.roofY - 0.055, sh.zRoofFront)];
  const dy = top[1].y - foot[1].y;
  const dz = top[1].z - foot[1].z;
  const inward = new THREE.Vector3(0, -dz, dy).normalize();
  if (inward.z < 0) inward.negate();
  return { geometry: sheet([foot, top], inward), width: hw * (0.9 + 0.74) * k, height: Math.hypot(dy, dz) };
}

/** An upright pane across the front of a cab: x0 … x1, y0 … y1, standing at z (the cab behind it, +z). */
function flatGlass(x0: number, x1: number, y0: number, y1: number, z: number): GlassShape {
  const foot = [new THREE.Vector3(x0, y0, z), new THREE.Vector3(x1, y0, z)];
  const top = [new THREE.Vector3(x0, y1, z), new THREE.Vector3(x1, y1, z)];
  return { geometry: sheet([foot, top], new THREE.Vector3(0, 0, 1)), width: x1 - x0, height: y1 - y0 };
}

const tmpBox = new THREE.Box3();
const tmpM = new THREE.Matrix4();

/** The target the scene behind the glass is drawn into for its blur: kept at the drawing size, reused between frames. */
function ensureTarget(t: THREE.WebGLRenderTarget | null, w: number, h: number): THREE.WebGLRenderTarget {
  if (t && t.width === w && t.height === h) return t;
  t?.dispose();
  const next = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false });
  next.texture.minFilter = THREE.LinearFilter;
  next.texture.magFilter = THREE.LinearFilter;
  return next;
}

/**
 * Where the windscreen of a model is (null: it has none – a motorcycle, the
 * aeroplane's canopy is not done).  Found once per model.
 */
export function findGlass(model: ScreenModel): GlassShape | null {
  const shell = (model as { exterior?: { shell?: ShellLike } }).exterior?.shell;
  if (shell && typeof shell.zCowl === 'number') return carGlass(shell);
  const root = model.root;
  // the tram's cab has no glass of its own: the opening between its pillars (render/fleet.ts TramCab)
  if (root.name === 'tram cab') return flatGlass(-1.05, 1.05, 1.27, 2.78, -4.62);
  root.updateMatrixWorld(true);
  const inv = tmpM.copy(root.matrixWorld).invert();
  const eye = model.eye;
  let best: THREE.Box3 | null = null;
  let bestArea = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.material !== GLASS) return;
    const g = m.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox) return;
    const b = tmpBox.copy(g.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    const w = b.max.x - b.min.x;
    const h = b.max.y - b.min.y;
    // a pane across the front, ahead of the eyes, at their height
    if (b.max.z - b.min.z > 0.12 || w < 0.6 || b.max.z > eye.z - 0.2 || b.max.y < eye.y || b.min.y > eye.y) return;
    if (w * h > bestArea) {
      bestArea = w * h;
      best = b.clone();
    }
  });
  const b = best as THREE.Box3 | null;
  if (!b) return null;
  return flatGlass(b.min.x + 0.02, b.max.x - 0.02, b.min.y + 0.02, b.max.y - 0.02, b.max.z + 0.01);
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uState;
uniform sampler2D uGen;
uniform sampler2D uBg;
uniform vec2 uSize;
uniform vec2 uRes;
uniform float uHaveBg;
uniform float uLight;
uniform vec2 uFlow;
uniform float uRun;
uniform vec4 uArm0;
uniform vec4 uArm1;
uniform vec2 uIn;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 hash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }

// one layer of drops: cells of 'cell' metres, a drop in a cell when its number is under the density
// returns the slope of the drop's surface (xy) and how much of a drop is there (z)
vec3 drops(vec2 p, float cell, float den, float gen, vec2 stretch, float seed) {
  vec2 id = floor(p / cell);
  vec2 f = fract(p / cell) - 0.5;
  vec2 h = hash2(id + seed + gen * 7.13);
  float there = step(hash(id * 1.37 + seed + gen * 3.71), den);
  float r = mix(0.16, 0.4, h.x * h.x);
  vec2 c = (hash2(id + 11.0 + gen) - 0.5) * (1.0 - 2.0 * r);
  vec2 d = (f - c) / stretch;
  float q = dot(d, d) / (r * r);
  float m = there * (1.0 - smoothstep(0.7, 1.0, q));
  return vec3(d / r * m, m);
}

vec3 behind(vec2 sp, float rad) {
  if (uHaveBg < 0.5) return vec3(0.4, 0.43, 0.47) * uLight;
  vec3 c = texture2D(uBg, sp).rgb;
  if (rad < 0.0006) return c;
  float a0 = hash(gl_FragCoord.xy) * 6.2832;
  float asp = uRes.x / uRes.y;
  for (int i = 0; i < 8; i++) {
    float a = a0 + float(i) * 0.7854;
    float r = rad * (0.45 + 0.55 * fract(float(i) * 0.618 + 0.3));
    c += texture2D(uBg, clamp(sp + vec2(cos(a) / asp, sin(a)) * r, 0.001, 0.999)).rgb;
  }
  return c / 9.0;
}

// a wiper: its arm from the pivot, the rubber of the blade along it
float wiper(vec2 p, vec4 arm, float rIn) {
  vec2 d = vec2(cos(arm.z), sin(arm.z));
  vec2 q = p - arm.xy;
  float along = dot(q, d);
  float off = abs(q.x * d.y - q.y * d.x);
  float aa = fwidth(off) + 0.0005;
  float bar = (1.0 - smoothstep(0.007, 0.007 + aa, off)) * step(0.0, along) * step(along, arm.w);
  float blade = (1.0 - smoothstep(0.011, 0.011 + aa, off)) * step(rIn, along) * step(along, arm.w);
  return max(bar, blade * 0.9);
}

void main() {
  vec2 p = vUv * uSize;
  vec4 st = texture2D(uState, vUv);
  float gen = floor(texture2D(uGen, vUv).r * 255.0 + 0.5);
  float film = st.r;
  float snow = st.g;
  float grime = st.b;
  float den = st.a;
  float still = 1.0 - 0.8 * uRun;
  vec3 a = drops(p, 0.009, den * still, gen, vec2(1.0), 0.0);
  vec3 b = drops(p + vec2(0.0031, 0.0047), 0.0055, den * 0.8 * still, gen, vec2(1.0), 5.0);
  vec3 c = drops(p - uFlow, 0.012, den * uRun, gen, vec2(0.75, 1.0 + 1.6 * uRun), 9.0);
  vec2 n = a.xy + b.xy + c.xy;
  float dm = clamp(a.z + b.z + c.z, 0.0, 1.0);
  vec2 sp = gl_FragCoord.xy / uRes;
  // water blurs, a drop is a little lens that turns the picture behind it over
  float rad = (film * 16.0 + grime * 7.0 + snow * 10.0 + dm * 2.0) / uRes.y;
  vec3 col = behind(sp - n * 0.022, rad);
  // a grey veil of water and dirt; the dirt wiped dry lies in arcs
  float streak = 0.7 + 0.3 * sin(length(p - uArm0.xy) * 1500.0);
  float g = clamp(grime * streak, 0.0, 1.0);
  col = mix(col, col * 0.8 + vec3(0.11) * uLight, film * 0.4);
  col = mix(col, vec3(0.42, 0.39, 0.33) * uLight, g * 0.5);
  // the light in a drop: bright on its lower edge, a glint up top
  col += dm * (smoothstep(0.3, 1.0, -n.y) * 0.18 + smoothstep(0.6, 1.0, n.y) * 0.1) * (0.3 + 0.7 * uLight);
  float alpha = max(max(film * 0.9, dm * 0.95), g * 0.85);
  // snow: single flakes first, then a cover that grows together in patches
  vec2 fid = floor(p / 0.006);
  vec2 fh = hash2(fid + gen * 2.1);
  float fr = mix(0.12, 0.35, fh.y);
  float flake = step(hash(fid + 4.4 + gen), snow * 2.5) * (1.0 - smoothstep(fr * 0.6, fr, length(fract(p / 0.006) - 0.5 - (fh - 0.5) * 0.3)));
  vec2 cid = p / 0.03;
  vec2 ci = floor(cid);
  vec2 cf = smoothstep(0.0, 1.0, fract(cid));
  float nz = mix(mix(hash(ci), hash(ci + vec2(1.0, 0.0)), cf.x), mix(hash(ci + vec2(0.0, 1.0)), hash(ci + 1.0), cf.x), cf.y);
  float cover = smoothstep(0.32, 0.8, snow + (nz - 0.5) * 0.35);
  float s = max(cover, flake * 0.9);
  vec3 snowCol = vec3(0.9, 0.92, 0.95) * (0.12 + 0.88 * uLight) * (0.9 + 0.1 * nz) + col * 0.15;
  col = mix(col, snowCol, s);
  alpha = max(alpha, s);
  float arm = max(wiper(p, uArm0, uIn.x), wiper(p, uArm1, uIn.y));
  col = mix(col, vec3(0.02), arm);
  alpha = max(alpha, arm);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(col, alpha);
}
`;

/** What the game gives each frame. */
export interface WindscreenFrame {
  renderer: THREE.WebGLRenderer;
  /** the scene and camera: to draw the background once without the glass for its blur (world, not part of the glass) */
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** the vehicle the player drives (null: none) */
  model: ScreenModel | null;
  /** the "very high" graphics: there is a windscreen to see */
  detail: boolean;
  /** seen from the driver's seat now (not on foot, not from outside, not the aeroplane) */
  cockpit: boolean;
  dt: number;
  /** the weather (game/weather.ts) */
  rain: number;
  snow: number;
  temperature: number;
  roadWet: number;
  /** the wind (m/s, world frame: where it blows to) */
  windX: number;
  windZ: number;
  heater: boolean;
  /** the washer held */
  washer: boolean;
  /** daylight 0 … 1 (snow is not white in the night) */
  light: number;
}

const STATE_COLS = 48;
const STATE_ROWS = 24;

/** The windscreen of the vehicle the player drives, and the stalk of its wipers. */
export class WindscreenView {
  /** the stalk: where it stands is kept from vehicle to vehicle */
  mode: WiperMode = 'off';
  /** the glass of the vehicle now (null: none, or not the "very high" graphics) */
  screen: Windscreen | null = null;
  /** seconds the driver has been driving with too little view through the glass */
  blindFor = 0;
  private model: ScreenModel | null = null;
  private mesh: THREE.Mesh | null = null;
  private readonly stateData = new Uint8Array(STATE_COLS * STATE_ROWS * 4);
  private readonly stateTex = new THREE.DataTexture(this.stateData, STATE_COLS, STATE_ROWS, THREE.RGBAFormat);
  private readonly genData = new Uint8Array(STATE_COLS * STATE_ROWS);
  private readonly genTex = new THREE.DataTexture(this.genData, STATE_COLS, STATE_ROWS, THREE.RedFormat);
  private bg: THREE.FramebufferTexture | null = null;
  /** the scene behind the glass drawn into a target of its own, for the blur (kept clean: no glass in it) */
  private offscreen: THREE.WebGLRenderTarget | null = null;
  private readonly material: THREE.ShaderMaterial;
  private readonly lastPos = new THREE.Vector3();
  private havePos = false;
  private readonly tv = new THREE.Vector3();
  private readonly tf = new THREE.Vector3();
  private readonly tr = new THREE.Vector3();
  private readonly size = new THREE.Vector2();

  constructor() {
    this.stateTex.magFilter = THREE.LinearFilter;
    this.stateTex.minFilter = THREE.LinearFilter;
    this.genTex.magFilter = THREE.NearestFilter;
    this.genTex.minFilter = THREE.NearestFilter;
    this.genTex.unpackAlignment = 1;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uState: { value: this.stateTex },
        uGen: { value: this.genTex },
        uBg: { value: null },
        uSize: { value: new THREE.Vector2(1, 1) },
        uRes: { value: new THREE.Vector2(1, 1) },
        uHaveBg: { value: 0 },
        uLight: { value: 1 },
        uFlow: { value: new THREE.Vector2() },
        uRun: { value: 0 },
        uArm0: { value: new THREE.Vector4() },
        uArm1: { value: new THREE.Vector4() },
        uIn: { value: new THREE.Vector2() },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
  }

  /** The stalk one place on (the key, the button): the new place. */
  cycle(): WiperMode {
    this.mode = nextWiperMode(this.mode);
    this.screen?.wipers.set(this.mode);
    return this.mode;
  }

  /** How much of the view is lost now, 0 … 1 (0 without the "very high" graphics). */
  obscured(): number {
    return this.screen ? this.screen.obscured() : 0;
  }

  /**
   * Once a frame, right after the picture is drawn: the weather on the
   * glass, the wipers, and the picture kept for the next frame's blur.
   * Returns the vehicle's speed it measured (m/s forwards).
   */
  frame(f: WindscreenFrame): number {
    const model = f.detail ? f.model : null;
    if (model !== this.model) this.attach(model);
    const s = this.screen;
    const mesh = this.mesh;
    if (!s || !mesh || !model) {
      this.blindFor = 0;
      return 0;
    }
    // how the vehicle moves: from where its model was a frame ago
    const root = model.root;
    const pos = this.tv.setFromMatrixPosition(root.matrixWorld);
    const dt = Math.max(1e-3, f.dt);
    let speed = 0;
    let cross = 0;
    if (this.havePos) {
      const vx = (pos.x - this.lastPos.x) / dt;
      const vz = (pos.z - this.lastPos.z) / dt;
      const fwd = this.tf.set(0, 0, -1).transformDirection(root.matrixWorld);
      const right = this.tr.set(1, 0, 0).transformDirection(root.matrixWorld);
      speed = vx * fwd.x + vz * fwd.z;
      // (a jump – a new place, a reset – is no speed)
      if (Math.abs(speed) > 120) speed = 0;
      // the air across the glass, as the vehicle meets it
      cross = (f.windX - vx) * right.x + (f.windZ - vz) * right.z;
      if (!Number.isFinite(cross) || Math.abs(cross) > 60) cross = 0;
    }
    this.lastPos.copy(pos);
    this.havePos = true;
    const w: ScreenWeather = { rain: f.rain, snow: f.snow, temperature: f.temperature, roadWet: f.roadWet, speed, crossWind: cross, heater: f.heater };
    s.wipers.set(this.mode);
    s.step(f.dt, w, f.washer);
    const ob = s.obscured();
    this.blindFor = f.cockpit && ob > 0.6 && speed > 2 ? this.blindFor + f.dt : 0;
    mesh.visible = f.cockpit;
    if (!f.cockpit) return speed;
    this.upload(s);
    const u = this.material.uniforms;
    u.uLight.value = Math.max(0.05, Math.min(1, f.light));
    (u.uFlow.value as THREE.Vector2).set(s.flow.x % 50, s.flow.y % 50);
    u.uRun.value = s.running;
    const arms = [u.uArm0.value as THREE.Vector4, u.uArm1.value as THREE.Vector4];
    for (let k = 0; k < 2 && k < s.arms.length; k++) {
      const a = s.arms[k];
      // (parked they lie at the foot of the glass, where the model has its own)
      arms[k].set(a.px, a.py, s.armAngle(k), s.wipers.running ? a.rOut : 0);
    }
    (u.uIn.value as THREE.Vector2).set(s.arms[0]?.rIn ?? 0, s.arms[1]?.rIn ?? 0);
    // the picture just drawn: what the glass blurs in the next frame (only while there is something on it)
    if (ob > 0.002 || s.wipers.running) this.keepPicture(f.renderer, f.scene, f.camera);
    return speed;
  }

  /** The vehicle changed (or the graphics): a new glass for it, or none. */
  private attach(model: ScreenModel | null): void {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.model = model;
    this.screen = null;
    this.havePos = false;
    this.blindFor = 0;
    if (!model) return;
    const shape = findGlass(model);
    if (!shape) return;
    this.screen = new Windscreen(shape.width, shape.height, STATE_COLS, STATE_ROWS);
    this.screen.wipers.set(this.mode);
    (this.material.uniforms.uSize.value as THREE.Vector2).set(shape.width, shape.height);
    const mesh = new THREE.Mesh(shape.geometry, this.material);
    mesh.name = 'windscreen weather';
    mesh.renderOrder = 20;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    model.root.add(mesh);
    this.mesh = mesh;
  }

  private upload(s: Windscreen): void {
    const d = this.stateData;
    const n = STATE_COLS * STATE_ROWS;
    for (let k = 0; k < n; k++) {
      const o = k * 4;
      d[o] = Math.round(s.film[k] * 255);
      d[o + 1] = Math.round(s.snow[k] * 255);
      d[o + 2] = Math.round(Math.min(1, s.dirt[k] + s.smear[k]) * 255);
      d[o + 3] = Math.round(s.drops[k] * 255);
    }
    this.genData.set(s.gen);
    this.stateTex.needsUpdate = true;
    this.genTex.needsUpdate = true;
  }

  private keepPicture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    if (renderer.getRenderTarget() !== null) return;
    renderer.getDrawingBufferSize(this.size);
    const w = Math.floor(this.size.x);
    const h = Math.floor(this.size.y);
    if (w < 2 || h < 2) return;
    const u = this.material.uniforms;
    if (!this.bg || this.bg.image.width !== w || this.bg.image.height !== h) {
      this.bg?.dispose();
      this.bg = new THREE.FramebufferTexture(w, h);
      this.bg.magFilter = THREE.LinearFilter;
      this.bg.minFilter = THREE.LinearFilter;
      u.uBg.value = this.bg;
      u.uHaveBg.value = 0;
      (u.uRes.value as THREE.Vector2).set(w, h);
    }
    try {
      // (the glass itself is in the picture just drawn: it must not be captured,
      //  or the blur would show last frame's water.  Draw the scene behind the
      //  glass once into a target of its own – the picture the player sees keeps
      //  the glass – and capture that.)
      const wasVisible = this.mesh?.visible ?? false;
      if (this.mesh) this.mesh.visible = false;
      this.offscreen = ensureTarget(this.offscreen, w, h);
      renderer.setRenderTarget(this.offscreen);
      renderer.render(scene, camera);
      renderer.copyFramebufferToTexture(this.bg);
      renderer.setRenderTarget(null);
      if (this.mesh) this.mesh.visible = wasVisible;
      u.uHaveBg.value = 1;
    } catch {
      renderer.setRenderTarget(null);
      u.uHaveBg.value = 0;
    }
  }

  dispose(): void {
    this.attach(null);
    this.material.dispose();
    this.stateTex.dispose();
    this.genTex.dispose();
    this.bg?.dispose();
    this.offscreen?.dispose();
    this.offscreen = null;
  }
}
