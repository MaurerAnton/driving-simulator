// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Water in the picture: rivers, lakes and ponds that look like water, and
 * the splashes, spray and wake of a vehicle driving through them.
 *
 * WaterLook teaches the terrain's material (and, simpler, the far view's)
 * what water is.  Where the ground cover is water (the cover texture's blue
 * of world/cover.ts) the ground is drawn as a water surface:
 *  - a little below the banks (the terrain's vertices in the water are
 *    lowered by WATER_DROP – the game's wading lowers the bed for the
 *    wheels by as much and more);
 *  - its colour: the bed showing through at the edge (a little
 *    transparency), dark and blue-green towards the middle, where the water
 *    is deep (how much water there is round a point: the cover texture's
 *    coarse mipmap level);
 *  - small ripples drifting over it: the slopes of two octaves of value
 *    noise – computed, no textures – fading out with distance (where they
 *    would only flicker);
 *  - the sky mirrored with a Fresnel term (the sky dome's own colours, which
 *    the weather tints) and the sun glinting on the ripples.
 * It costs a few noise lookups per pixel, and only in water pixels.  It is
 * a recompile, so it is switched on and off as a whole (`enabled`, the
 * graphics setting "real water").  The far view gets the mirrored sky and a
 * broad glint on a flat surface.
 *
 * WaterSpray is a pool of particles – drops thrown up by the wheels and the
 * foam of the wake – drawn as one THREE.Points; game/wading.ts emits them.
 */
import * as THREE from 'three';

/** how far the water's surface lies below the banks (m) – game/wading.ts lowers the bed for the wheels by this and more */
export const WATER_DROP = 0.15;

/** what of the sky dome's uniforms the water mirrors (render/sky.ts's Sky material has them) */
interface DomeUniforms {
  uSunDir: { value: THREE.Vector3 };
  uZenith: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uSunColor: { value: THREE.Color };
}

// ------------------------------------------------------------------ GLSL

/**
 * Water or not from a colour of the cover (linear): the water's blue is the
 * only cover colour with more blue than green (and clearly more than red).
 * Blended with a bank's colour (the texture is filtered) it fades out.
 */
const MASK_GLSL = /* glsl */ `
float fsWtrMask(vec3 c) {
  return smoothstep(0.02, 0.07, c.b - c.g) * step(c.r + 0.05, c.b);
}`;

const VERT_PARS = /* glsl */ `
varying vec3 vFsWtrW;
#ifdef FS_WATER_DROP
uniform sampler2D map;
${MASK_GLSL}
#endif
`;

/** after begin_vertex: lower the water (before anything else takes the vertex's place) */
const VERT_DROP = /* glsl */ `
#ifdef FS_WATER_DROP
transformed.y -= ${WATER_DROP.toFixed(3)} * fsWtrMask(textureLod(map, vMapUv, 0.0).rgb);
#endif
`;

const VERT_WORLD = /* glsl */ `
vFsWtrW = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAG_PARS = /* glsl */ `
uniform float uFsWtrTime;
uniform vec3 uFsWtrZenith;
uniform vec3 uFsWtrHorizon;
uniform vec3 uFsWtrSunDir;
uniform vec3 uFsWtrSunColor;
varying vec3 vFsWtrW;
// how much this pixel is water (0 … 1), and how deep (0 at the edge … 1 in the middle)
float fsWtrK = 0.0;
float fsWtrDeep = 0.0;
${MASK_GLSL}
// a hash of a lattice point, repeating every 'per' points (the noise repeats every 256 m: no precision trouble far from the origin)
float fsWtrHash(vec2 i, float per) {
  i = mod(i, per);
  vec3 p = fract(vec3(i.xyx) * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
// value noise with its gradient: (value, d/dx, d/dy)
vec3 fsWtrNoise(vec2 p, float per) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = fsWtrHash(i, per);
  float b = fsWtrHash(i + vec2(1.0, 0.0), per);
  float c = fsWtrHash(i + vec2(0.0, 1.0), per);
  float d = fsWtrHash(i + vec2(1.0, 1.0), per);
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * vec2(b - a + k * u.y, c - a + k * u.x));
}
// the sky mirrored in direction r (as the dome draws it, without the sun)
vec3 fsWtrSky(vec3 r) {
  return mix(uFsWtrZenith, uFsWtrHorizon, pow(1.0 - clamp(r.y, 0.0, 1.0), 3.2));
}
`;

/** the terrain, before emissivemap_fragment (after the season's colours): which pixels are water, and their colour */
const FRAG_COLOR_TERRAIN = /* glsl */ `
{
  fsWtrK = fsWtrMask(texture2D(map, vMapUv).rgb);
  if (fsWtrK > 0.001) {
    // (the coarse mipmap: how much of the surroundings is water – the middle of a river or a lake is deep)
    fsWtrDeep = smoothstep(0.0, 0.07, dot(textureLod(map, vMapUv, 3.0).rgb, vec3(0.0, -1.0, 1.0)));
    vec3 fsBed = diffuseColor.rgb * vec3(0.55, 0.58, 0.5);
    vec3 fsBody = mix(fsBed, vec3(0.012, 0.035, 0.04), 0.45 + 0.55 * fsWtrDeep);
    diffuseColor.rgb = mix(diffuseColor.rgb, fsBody, fsWtrK);
  }
}
`;

/** the far view: water by its vertex colour (the cover's blue, a little hazed) */
const FRAG_COLOR_FAR = /* glsl */ `
{
  fsWtrK = fsWtrMask(vColor.rgb);
  fsWtrDeep = 1.0;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02, 0.05, 0.06), fsWtrK);
}
`;

/** before opaque_fragment: the mirrored sky and the sun's glints on the ripples */
function fragLight(far: boolean): string {
  const ripples = far
    ? 'vec3 fsN = vec3(0.0, 1.0, 0.0);'
    : /* glsl */ `
    vec2 fsQ = mod(vFsWtrW.xz, 256.0);
    float fsT = uFsWtrTime;
    vec3 fsA = fsWtrNoise(fsQ * 0.5 + fsT * vec2(0.23, 0.13), 128.0);
    vec3 fsB = fsWtrNoise(fsQ * 1.75 + fsT * vec2(-0.12, 0.41), 448.0);
    float fsAmp = 1.0 - smoothstep(25.0, 260.0, fsDist);
    vec2 fsG = (fsA.yz * 0.5 * 0.16 + fsB.yz * 1.75 * 0.05) * fsAmp;
    vec3 fsN = normalize(vec3(-fsG.x, 1.0, -fsG.y));`;
  return /* glsl */ `
if (fsWtrK > 0.001) {
  vec3 fsV = vFsWtrW - cameraPosition;
  float fsDist = length(fsV);
  fsV /= max(fsDist, 1e-3);
  ${ripples}
  vec3 fsR = reflect(fsV, fsN);
  fsR.y = abs(fsR.y);
  float fsCos = clamp(-dot(fsV, fsN), 0.0, 1.0);
  float fsF = 0.02 + 0.98 * pow(1.0 - fsCos, 5.0);
  // (shallow water at the edge lets more of the bed through)
  fsF *= 0.75 + 0.25 * fsWtrDeep;
  vec3 fsWater = mix(outgoingLight, fsWtrSky(fsR), fsF);
  float fsS = max(dot(fsR, uFsWtrSunDir), 0.0);
  float fsSunUp = smoothstep(-0.03, 0.08, uFsWtrSunDir.y);
  fsWater += uFsWtrSunColor * fsSunUp * ${far ? '(pow(fsS, 60.0) * 0.6)' : '(pow(fsS, 350.0) * 5.0 + pow(fsS, 40.0) * 0.18)'};
  outgoingLight = mix(outgoingLight, fsWater, fsWtrK);
}
`;
}

export type WaterTarget = 'terrain' | 'far';

/**
 * Real water in the terrain's and the far view's materials.  patch() each
 * material once (as it is made); `enabled` switches the water on and off
 * (a recompile); update() every frame lets the ripples drift.
 */
export class WaterLook {
  readonly uniforms = {
    uFsWtrTime: { value: 0 },
    uFsWtrZenith: { value: new THREE.Color(0x3a74c6) },
    uFsWtrHorizon: { value: new THREE.Color(0xc2d3e4) },
    uFsWtrSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
    uFsWtrSunColor: { value: new THREE.Color(0xfff2d0) },
  };
  private on = false;
  /** the materials patched (weakly held: the tiles' terrain materials come and go) */
  private readonly patched = new WeakSet<THREE.Material>();
  private readonly mats: Array<WeakRef<THREE.Material>> = [];

  /**
   * The sky the water mirrors: the dome of render/sky.ts's Sky (a mesh with
   * a ShaderMaterial whose uSunDir, uZenith, uHorizon and uSunColor the sky
   * and the weather keep up to date) – its uniforms are shared, not copied.
   */
  attachSky(dome: THREE.Object3D | null | undefined): void {
    const mat = (dome as THREE.Mesh | undefined)?.material as THREE.ShaderMaterial | undefined;
    const u = mat?.isShaderMaterial ? (mat.uniforms as Partial<DomeUniforms>) : null;
    if (!u?.uSunDir || !u.uZenith || !u.uHorizon || !u.uSunColor) return;
    this.uniforms.uFsWtrSunDir = u.uSunDir;
    this.uniforms.uFsWtrZenith = u.uZenith;
    this.uniforms.uFsWtrHorizon = u.uHorizon;
    this.uniforms.uFsWtrSunColor = u.uSunColor;
  }

  /** real water drawn (the graphics setting) – a change recompiles the patched materials */
  get enabled(): boolean {
    return this.on;
  }

  set enabled(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    let k = 0;
    for (const ref of this.mats) {
      const m = ref.deref();
      if (!m) continue;
      m.needsUpdate = true;
      this.mats[k++] = ref;
    }
    this.mats.length = k;
  }

  /** Once a frame: the ripples drift on. */
  update(dt: number): void {
    if (Number.isFinite(dt) && dt > 0) this.uniforms.uFsWtrTime.value = (this.uniforms.uFsWtrTime.value + Math.min(dt, 0.25)) % 3600;
  }

  /**
   * Teach a material the water (once): 'terrain' – a tile's terrain (a
   * MeshLambertMaterial with the cover texture as its map); 'far' – the far
   * view's (vertex colours).  Chained after what the material already does.
   */
  patch(material: THREE.Material, target: WaterTarget): void {
    if (this.patched.has(material)) return;
    this.patched.add(material);
    this.mats.push(new WeakRef(material));
    const prevCompile = material.onBeforeCompile;
    // the program's key: the material's own one (its onBeforeCompile's text, unless it has a key of its own) and ours
    const own = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey');
    const ownKey = own ? material.customProgramCacheKey.bind(material) : null;
    const plainKey = own ? '' : prevCompile.toString();
    material.onBeforeCompile = (shader, renderer) => {
      prevCompile.call(material, shader, renderer);
      if (!this.on) return;
      patchShader(shader, target, this.uniforms);
    };
    material.customProgramCacheKey = () => `${ownKey ? ownKey() : plainKey}${this.on ? `|fs-water-${target}` : ''}`;
    material.needsUpdate = true;
  }
}

/** The water in a shader of a MeshLambertMaterial (exported for the GLSL check, tools/dev/glslcheck.ts). */
export function patchShader(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }, target: WaterTarget, uniforms: Record<string, THREE.IUniform>): void {
  Object.assign(shader.uniforms, uniforms);
  const far = target === 'far';
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${far ? '' : '#define FS_WATER_DROP\n'}${VERT_PARS}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${far ? '' : VERT_DROP}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_WORLD}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
    .replace('#include <emissivemap_fragment>', `${far ? FRAG_COLOR_FAR : FRAG_COLOR_TERRAIN}\n#include <emissivemap_fragment>`)
    .replace('#include <opaque_fragment>', `${fragLight(far)}\n#include <opaque_fragment>`);
}

// -------------------------------------------------------------- the spray

const SPRAY_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
uniform float uViewH;
varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = clamp(aSize * projectionMatrix[1][1] * 0.5 * uViewH / max(-mvPosition.z, 0.1), 0.0, 96.0);
  vAlpha = aAlpha;
  #include <fog_vertex>
}`;

const SPRAY_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r = dot(d, d);
  if (r > 1.0 || vAlpha <= 0.0) discard;
  gl_FragColor = vec4(uColor, vAlpha * (1.0 - r));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** one particle: drops (fall under gravity) or foam (lies on the water and spreads) */
export interface SprayParticle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** age and life span (s) */
  age: number;
  life: number;
  /** diameter at birth and at the end (m) */
  size0: number;
  size1: number;
  /** the water's surface where it was born: a drop falling back below it is gone */
  floor: number;
  foam: boolean;
}

/** gravity on the drops (m/s²) and how quickly the air slows them (1/s) */
const GRAVITY = 9.81;
const AIR_DRAG = 1.2;

/**
 * The drops and the foam: a pool of at most `capacity` particles drawn as one
 * THREE.Points (soft round sprites, white tinted by the light).  emit() adds
 * one (the oldest is replaced when the pool is full); update() once a frame.
 */
export class WaterSpray {
  readonly points: THREE.Points;
  /** how bright the light is (1 = a clear day): the drops' colour */
  light = 1;
  private readonly pool: SprayParticle[] = [];
  private live = 0;
  private next = 0;
  private readonly pos: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly geo = new THREE.BufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  private readonly viewSize = new THREE.Vector2();

  readonly capacity: number;

  constructor(capacity = 600) {
    this.capacity = capacity;
    for (let i = 0; i < capacity; i++) this.pool.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 1, life: 0, size0: 0, size1: 0, floor: 0, foam: false });
    this.pos = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uViewH: { value: 800 }, uColor: { value: new THREE.Color(0.85, 0.9, 0.93) } }]),
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.name = 'water spray';
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(this.viewSize);
      this.mat.uniforms.uViewH.value = this.viewSize.y;
    };
  }

  /** the particles alive now */
  get count(): number {
    return this.live;
  }

  /** Add a particle (its fields are copied).  The pool full: the one born longest ago makes room. */
  emit(p: Readonly<SprayParticle>): void {
    let slot: SprayParticle;
    if (this.live < this.capacity) slot = this.pool[this.live++];
    else {
      slot = this.pool[this.next];
      this.next = (this.next + 1) % this.capacity;
    }
    Object.assign(slot, p);
  }

  /** Move the particles on by `dt` seconds and hand them to the GPU. */
  update(dt: number): void {
    const h = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    const pool = this.pool;
    let n = 0;
    for (let i = 0; i < this.live; i++) {
      const p = pool[i];
      p.age += h;
      if (p.age < p.life && !(!p.foam && p.vy < 0 && p.y < p.floor)) {
        if (p.foam) {
          const k = Math.exp(-h * 0.8);
          p.vx *= k;
          p.vz *= k;
        } else {
          const k = Math.exp(-h * AIR_DRAG);
          p.vx *= k;
          p.vz *= k;
          p.vy = p.vy * k - GRAVITY * h;
        }
        p.x += p.vx * h;
        p.y += p.vy * h;
        p.z += p.vz * h;
        if (n !== i) {
          // (keep the living ones together at the front of the pool)
          pool[i] = pool[n];
          pool[n] = p;
        }
        n++;
      }
    }
    this.live = n;
    if (this.next >= n) this.next = 0;
    for (let i = 0; i < n; i++) {
      const p = pool[i];
      const t = p.age / p.life;
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
      this.size[i] = p.size0 + (p.size1 - p.size0) * t;
      this.alpha[i] = (p.foam ? 0.35 : 0.55) * Math.min(1, t * 8) * (1 - t);
    }
    (this.mat.uniforms.uColor.value as THREE.Color).setRGB(0.85, 0.9, 0.93).multiplyScalar(Math.max(0.08, Math.min(1.2, this.light)));
    this.geo.setDrawRange(0, n);
    for (const name of ['position', 'aSize', 'aAlpha']) {
      const a = this.geo.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
    this.points.visible = n > 0;
  }

  /** Gone at once (a new drive). */
  clear(): void {
    this.live = 0;
    this.next = 0;
    this.geo.setDrawRange(0, 0);
    this.points.visible = false;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
