// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Headlights that light the road at dusk and at night.
 *
 * `PlayerLights`: the player's vehicle throws its dipped beam – short,
 * aimed down and a little to the right, so that it reaches further along the
 * right-hand verge than into the oncoming lane (the German pattern) – and,
 * switched on, its main beam: long and wide.  With the "medium" graphics and
 * up these are two real spotlights (no shadows); they are added to the scene
 * only once it first gets dark, so a game played by day pays nothing for
 * them.  On the "low" graphics a pool of light lies on the road instead: a
 * flat shape drawn over the ground in front of the vehicle, glowing.
 *
 * `TrafficGlow`: the lamps of the traffic's cars at night – white in front,
 * red behind, brighter when braking – as glowing points that light nothing
 * (one draw for all of them).  A car with its main beam on, or flashing it,
 * glows large: that is what dazzles.
 */
import * as THREE from 'three';

/** what the player's lights need each frame */
export interface PlayerLightState {
  /** how dark it is, 0 day … 1 night (sim/beams.ts darkness) */
  dark: number;
  /** the vehicle's model (its frame: x right, y up, forward −z, the origin on the ground) – null: no lights (on foot, flying) */
  root: THREE.Object3D | null;
  /** from the origin to the front bumper (m) */
  front: number;
  /** height of the lamps (m) */
  height: number;
  low: boolean;
  high: boolean;
  /** the pool of light on the road instead of the spotlights */
  cheap: boolean;
}

const WARM = 0xfff1dc;

/** A flat fan of light in the vehicle's frame: from `z0` to `z1` ahead (both negative), half-widths w0 … w1, shifted `shift` m to the right at the far end. */
function poolGeometry(z0: number, z1: number, w0: number, w1: number, shift: number): THREE.BufferGeometry {
  const rows = 8;
  const cols = 6;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const z = z0 + (z1 - z0) * t;
    const w = w0 + (w1 - w0) * Math.sqrt(t);
    // brightest a little way ahead, fading out towards the far end
    const along = Math.min(1, t * 5) * (1 - t) ** 1.4;
    for (let j = 0; j <= cols; j++) {
      const u = j / cols - 0.5;
      const across = 1 - (2 * u) ** 2;
      const k = Math.max(0, along * across);
      pos.push(u * 2 * w + shift * t, 0, z);
      col.push(k, k, k);
    }
  }
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j;
      const b = a + cols + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

export class PlayerLights {
  readonly group = new THREE.Group();
  private readonly scene: THREE.Object3D;
  private added = false;
  private readonly dipped = new THREE.SpotLight(WARM, 0, 95, 0.42, 0.85, 1.5);
  private readonly main = new THREE.SpotLight(0xffffff, 0, 240, 0.3, 0.6, 1.5);
  private readonly lamp = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  /** the pool of light of the low graphics: dipped and main beam */
  private readonly poolLow: THREE.Mesh;
  private readonly poolHigh: THREE.Mesh;
  private readonly poolMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, toneMapped: false });
  private readonly poolHighMat: THREE.MeshBasicMaterial;
  private readonly poolFrame = new THREE.Group();

  constructor(scene: THREE.Object3D) {
    this.scene = scene;
    this.group.name = 'headlights';
    for (const l of [this.dipped, this.main]) {
      l.castShadow = false;
      this.group.add(l, l.target);
    }
    // (the shapes start at the bumper: placed by `front` each frame through poolFrame's children)
    this.poolLow = new THREE.Mesh(poolGeometry(-1, -34, 1.1, 5.5, 2.2), this.poolMat);
    this.poolHighMat = this.poolMat.clone();
    this.poolHigh = new THREE.Mesh(poolGeometry(-2, -80, 1.4, 11, 0), this.poolHighMat);
    for (const m of [this.poolLow, this.poolHigh]) {
      m.frustumCulled = false;
      m.renderOrder = 2;
      this.poolFrame.add(m);
    }
    this.poolFrame.visible = false;
    scene.add(this.poolFrame);
  }

  update(s: PlayerLightState): void {
    const on = s.dark > 0.02 && !!s.root && (s.low || s.high);
    const root = s.root;
    // the pool on the road (low graphics)
    const pool = on && s.cheap;
    this.poolFrame.visible = pool;
    if (pool && root) {
      root.updateWorldMatrix(true, false);
      this.poolFrame.matrixAutoUpdate = false;
      this.poolFrame.matrix.copy(root.matrixWorld).multiply(this.tmpM.makeTranslation(0, 0.06, -s.front));
      this.poolFrame.matrixWorldNeedsUpdate = true;
      this.poolLow.visible = s.low || s.high;
      this.poolHigh.visible = s.high;
      this.poolMat.color.setScalar(0.55 * s.dark);
      this.poolHighMat.color.setScalar(0.4 * s.dark);
    }
    // the spotlights (medium graphics and up): into the scene the first time it is dark
    const spots = on && !s.cheap;
    if (spots && !this.added) {
      this.added = true;
      this.scene.add(this.group);
    }
    if (!this.added) return;
    if (!spots || !root) {
      this.dipped.intensity = 0;
      this.main.intensity = 0;
      return;
    }
    root.updateWorldMatrix(true, false);
    const mw = root.matrixWorld;
    this.lamp.set(0, s.height, -s.front - 0.1).applyMatrix4(mw);
    // dipped: down onto the road some 35 m ahead, a little to the right (the right verge lit further)
    this.dipped.position.copy(this.lamp);
    this.dipped.target.position.copy(this.aim.set(1.6, s.height - 0.95, -s.front - 35).applyMatrix4(mw));
    this.dipped.target.updateMatrixWorld();
    this.dipped.intensity = 320 * s.dark;
    // main: straight ahead, level, far
    this.main.position.copy(this.lamp);
    this.main.target.position.copy(this.aim.set(0, s.height - 0.6, -s.front - 120).applyMatrix4(mw));
    this.main.target.updateMatrixWorld();
    this.main.intensity = s.high ? 1700 * s.dark : 0;
  }

  private readonly tmpM = new THREE.Matrix4();
}

/** one car as its lamps need it */
export interface GlowCar {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  length: number;
  width: number;
  braking: boolean;
}

const MAX_POINTS = 4 * 400;

/**
 * The lamps of the traffic at night: four glowing points a car (two white in
 * front, two red behind), each bright only from its own side.
 */
export class TrafficGlow {
  readonly points: THREE.Points;
  private readonly pos = new Float32Array(MAX_POINTS * 3);
  private readonly col = new Float32Array(MAX_POINTS * 3);
  private readonly size = new Float32Array(MAX_POINTS);
  private readonly geo = new THREE.BufferGeometry();
  private readonly uniforms = { uScale: { value: 500 } };

  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute vec3 color;
        uniform float uScale;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // (a lamp far off stays a dot of a pixel or two)
          gl_PointSize = max(2.0, aSize * uScale / max(0.5, -mv.z));
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          float k = exp(-d * d * 7.0) + 0.6 * pow(1.0 - d, 6.0);
          gl_FragColor = vec4(vColor * k, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.name = 'traffic lamps';
    this.points.visible = false;
  }

  /**
   * Places the lamps of `cars` for the camera: `dark` 0 … 1, `heightPx` the
   * picture's height in pixels, `high(id)` the car's main beam lit, `glare`
   * how much the player is dazzled (it swells the beams coming towards him).
   */
  update(cars: readonly GlowCar[], dark: number, camera: THREE.PerspectiveCamera, heightPx: number, high: (id: number) => boolean, glare: number): void {
    const show = dark > 0.05 && cars.length > 0;
    this.points.visible = show;
    if (!show) return;
    this.uniforms.uScale.value = heightPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const cx = camera.position.x;
    const cz = camera.position.z;
    const pos = this.pos;
    const col = this.col;
    const size = this.size;
    let n = 0;
    const put = (x: number, y: number, z: number, r: number, g: number, b: number, s: number): void => {
      if (n >= MAX_POINTS) return;
      pos[n * 3] = x;
      pos[n * 3 + 1] = y;
      pos[n * 3 + 2] = z;
      col[n * 3] = r;
      col[n * 3 + 1] = g;
      col[n * 3 + 2] = b;
      size[n] = s;
      n++;
    };
    for (const c of cars) {
      const dx = cx - c.x;
      const dz = cz - c.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 900 * 900) continue;
      const d = Math.sqrt(d2) || 1;
      const fx = -Math.sin(c.yaw);
      const fz = -Math.cos(c.yaw);
      const rx = -fz;
      const rz = fx;
      // (seen from in front, or from behind: how squarely)
      const face = (fx * dx + fz * dz) / d;
      const big = c.length > 7;
      const half = c.length / 2;
      const side = c.width / 2 - 0.28;
      if (face > 0.05) {
        const lit = high(c.id);
        const k = dark * face * face * (lit ? 2.2 + 3 * glare : 1.1);
        const s = lit ? 1.6 + 5 * glare : 0.75;
        const hy = c.y + (big ? 0.9 : 0.66);
        for (const sg of [-1, 1]) put(c.x + fx * (half + 0.12) + rx * side * sg, hy, c.z + fz * (half + 0.12) + rz * side * sg, k, k * 0.96, k * 0.86, s);
      } else if (face < -0.05) {
        const k = dark * face * face * (c.braking ? 1.6 : 0.7);
        const hy = c.y + (big ? 1.0 : 0.88);
        for (const sg of [-1, 1]) put(c.x - fx * (half + 0.08) + rx * side * sg, hy, c.z - fz * (half + 0.08) + rz * side * sg, k, k * 0.06, k * 0.04, c.braking ? 0.7 : 0.45);
      }
    }
    this.geo.setDrawRange(0, n);
    for (const name of ['position', 'color', 'aSize']) {
      const a = this.geo.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }
}
