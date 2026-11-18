// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The weather in the picture: rain and snow falling round the camera, and
 * what clouds, rain and fog do to the sky, the light and the view.
 *
 * Rain and snow are one mesh each: a small quad per drop or flake, drawn
 * instanced.  The vertex shader does all the work – nothing per particle in
 * JavaScript, nothing allocated per frame:
 *  - every particle has a fixed place in a box round the camera; the box
 *    moves with the camera and the places wrap round it, so a particle stays
 *    where it is in the world while the camera drives through the rain;
 *  - all fall and drift with the wind (in three speed classes, so that the
 *    rain is not one rigid curtain);
 *  - a drop is drawn as a streak along its motion relative to the camera,
 *    the way a camera or an eye sees it – at speed the rain comes at you;
 *  - inside the vehicle (the "shelter", setShelter) nothing falls.
 *
 * Sky, fog and light: `look` says what the weather does to them, smoothed
 * over a few seconds.  attachSky() applies it to the game's Sky every frame
 * (and gives the sky its own values back on detach); without it the game may
 * apply the values itself.  addWetness() darkens the roads in the rain and
 * lets them mirror the sky.
 */
import * as THREE from 'three';
import { windVector } from '../game/weather.ts';
import type { WeatherKind, WeatherState } from '../game/weather.ts';

export type WeatherQuality = 'low' | 'medium' | 'high' | 'ultra' | 'nomercy';

/** the most raindrops in the air at once, by graphics quality (snow: 60 % of it – the flakes are bigger) */
export const WEATHER_PARTICLES: Readonly<Record<WeatherQuality, number>> = Object.freeze({ low: 600, medium: 3000, high: 6000, ultra: 10000, nomercy: 10000 });
const SNOW_SHARE = 0.6;

/** What the weather does to the picture now (smoothed). */
export interface WeatherLook {
  /** how far one sees (m) – weatherFog() makes fog distances of it */
  visibility: number;
  /** the weather's colour of the fog and the horizon, and of the sky overhead (linear, for a clear noon) */
  readonly fogColor: THREE.Color;
  readonly zenithColor: THREE.Color;
  /** how much of those colours replaces the clear sky's (0 … 1) */
  tint: number;
  /** factors on the sun's and on the sky light's (hemisphere) intensity */
  sunFactor: number;
  ambientFactor: number;
  /** how wet the roads look (0 … 1) */
  wet: number;
  /** a lightning flash, now (0 … 1) */
  flash: number;
  /** how much of the rain and of the snow is drawn (0 … 1) */
  rain: number;
  snow: number;
}

/** The parts of the game's Sky that the weather changes (render/sky.ts's Sky fits). */
export interface SkyParts {
  readonly fog: THREE.Fog;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** the dome, a mesh with a ShaderMaterial: its uZenith, uHorizon and uSunColor are tinted */
  readonly dome?: THREE.Object3D;
}

/**
 * Fog distances for a visibility, from the game's own (`near`, `far`: the haze
 * of a clear day, which stay as they are where one sees farther than they
 * reach).  Below that `far` shrinks to the visibility – there the fog is
 * all but complete – and `near` goes towards the camera and below zero, so
 * that, like real fog, it begins at once and thickens steadily.  Writes `out`.
 */
export function weatherFog(visibility: number, near: number, far: number, out: { near: number; far: number }): { near: number; far: number } {
  const f = far > 0 ? Math.min(1, (1.05 * Math.max(1, visibility)) / far) : 1;
  out.far = far * f;
  const g = 1 - f;
  out.near = near * f * f - 0.25 * out.far * g * g;
  return out;
}

// ------------------------------------------------------------- the colours

/** the weather's sky (sRGB): at the horizon, where the fog takes its colour, and overhead */
const SKY_HEX: Readonly<Record<WeatherKind, readonly [number, number]>> = {
  clear: [0xb7bfc8, 0x8f99a5],
  cloudy: [0xb7bfc8, 0x8f99a5],
  fog: [0xc4c8cc, 0xbec2c6],
  drizzle: [0xa4abb3, 0x87909a],
  rain: [0x949ba3, 0x737b85],
  snow: [0xc9ced4, 0xaab1ba],
  storm: [0x656c74, 0x42484f],
};
const SKY_LIN = Object.fromEntries(Object.entries(SKY_HEX).map(([k, [h, z]]) => [k, [new THREE.Color(h), new THREE.Color(z)]])) as Record<WeatherKind, [THREE.Color, THREE.Color]>;
/** the sky light of an overcast day: neutral, without the blue of a clear sky */
const GREY_SKYLIGHT = new THREE.Color(0xd2d6da);
/** what a lightning flash lights the clouds with */
const FLASH_COLOR = new THREE.Color(0xe8e8ff);
/** the horizon of the game's clear noon (sky.ts), for how bright the sky is now */
const DAY_HORIZON_LUM = luminance(new THREE.Color(0xc2d3e4));

function luminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** a in [0, m) */
function wrap(a: number, m: number): number {
  return a - m * Math.floor(a / m);
}

/** small, quick, repeatable random numbers (the same rain every time) */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -------------------------------------------------------- the particles

const PARTICLE_VERT = /* glsl */ `
#include <fog_pars_vertex>
attribute vec4 aSeed;        // xyz: the particle's place in the box (0 … 1); w: a random number of its own
uniform vec3 uBox;           // size of the box round the camera (m)
uniform vec3 uShift[3];      // how far each speed class has fallen and drifted, within the box (m)
uniform vec3 uCamLocal;      // the camera in the box (m)
uniform vec3 uVel;           // the particles' velocity (m/s): the wind, and the fall of the middle class
uniform vec3 uCamVel;        // the camera's velocity (m/s)
uniform float uExposure;     // how many seconds of the motion a streak shows
uniform float uRadius;       // half the width of a drop or a flake (m)
uniform float uPixel;        // the size of a pixel 1 m from the camera (m)
uniform float uTime;         // s
uniform float uFlutter;      // how far snowflakes sway (m)
uniform mat4 uShelter;       // box → the shelter's unit cube
uniform float uShelterOn;
varying vec3 vShape;         // across (−1 … 1), along (in half-widths from the head), the streak's length (in half-widths)
varying float vAlpha;

void main() {
  int cls = int(min(aSeed.w * 3.0, 2.0));
  float speed = 0.85 + 0.15 * float(cls);
  vec3 p = mod(aSeed.xyz * uBox + uShift[cls], uBox);
#ifdef SNOW
  float ph = aSeed.w * 61.0;
  p.x += uFlutter * sin(uTime * (0.6 + aSeed.y) + ph);
  p.z += uFlutter * sin(uTime * (0.5 + aSeed.z) + ph * 1.7);
#endif
  // faded out towards the walls of the box, so that none is seen to wrap round
  vec3 d = p - uCamLocal;
  float fade = 1.0 - smoothstep(0.6, 1.0, length(d.xz) / (0.5 * uBox.x));
  float h = p.y / uBox.y;
  fade *= smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(0.82, 1.0, h));
  // nothing falls inside the vehicle
  vec3 q = (uShelter * vec4(p, 1.0)).xyz;
  if (uShelterOn > 0.5 && max(max(abs(q.x), abs(q.y)), abs(q.z)) < 1.0) fade = 0.0;
  // the streak: from the particle back along its motion relative to the camera
  vec3 rel = vec3(uVel.x, uVel.y * speed, uVel.z) - uCamVel;
  vec4 head = modelViewMatrix * vec4(p, 1.0);
  vec4 tail = modelViewMatrix * vec4(p - rel * (uExposure * (0.7 + 0.6 * fract(aSeed.w * 13.7))), 1.0);
  float dist = max(length(head.xyz), 1e-3);
  // at least about a pixel wide: thinner than that it is drawn fainter instead
  float hw = max(uRadius, uPixel * dist * 0.7);
  vec3 axis = tail.xyz - head.xyz;
  float len = length(axis);
  vec3 dir = len > 1e-5 ? axis / len : vec3(0.0, 1.0, 0.0);
  vec3 side = cross(dir, head.xyz / dist);
  float sl = length(side);
  side = sl > 1e-3 ? side / sl : vec3(1.0, 0.0, 0.0);
  float along = mix(-hw, len + hw, position.y);
  vec4 mvPosition = vec4(head.xyz + dir * along + side * (position.x * hw), 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // one that is not to be seen goes beyond the far plane: nothing of it is drawn
  if (fade < 0.001) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  vShape = vec3(position.x, along / hw, len / hw);
  // (and right at the eye it would fill the view: faded)
  vAlpha = fade * (uRadius / hw) * smoothstep(0.25, 0.9, dist);
  #include <fog_vertex>
}
`;

const PARTICLE_FRAG = /* glsl */ `
#include <fog_pars_fragment>
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vShape;
varying float vAlpha;

void main() {
  // the distance from the line from head to tail, in half-widths: a capsule with soft edges
  float beyond = max(0.0, max(-vShape.y, vShape.y - vShape.z));
  float r = length(vec2(vShape.x, beyond));
  float a = vAlpha * uOpacity * (1.0 - smoothstep(0.35, 1.0, r));
#ifndef SNOW
  // a streak is brightest at the drop and fades along its tail
  a *= 1.0 - 0.65 * clamp(vShape.y / max(vShape.z, 0.001), 0.0, 1.0);
#endif
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

function fieldUniforms() {
  return {
    fogDensity: { value: 0.00025 },
    fogNear: { value: 1 },
    fogFar: { value: 2000 },
    fogColor: { value: new THREE.Color(0xffffff) },
    uBox: { value: new THREE.Vector3() },
    uShift: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
    uCamLocal: { value: new THREE.Vector3() },
    uVel: { value: new THREE.Vector3() },
    uCamVel: { value: new THREE.Vector3() },
    uExposure: { value: 0.04 },
    uRadius: { value: 0.003 },
    uPixel: { value: 0.001 },
    uTime: { value: 0 },
    uFlutter: { value: 0 },
    uShelter: { value: new THREE.Matrix4() },
    uShelterOn: { value: 0 },
    uColor: { value: new THREE.Color(0xffffff) },
    uOpacity: { value: 0.3 },
  };
}
type FieldUniforms = ReturnType<typeof fieldUniforms>;

/** the vehicle the camera sits in: no rain inside its box */
interface Shelter {
  object: THREE.Object3D | null;
  /** the box in the object's own frame */
  readonly box: THREE.Box3;
}

/** One kind of particle (rain or snow) in its box round the camera. */
class Field {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly u: FieldUniforms;
  readonly box: THREE.Vector3;
  /** how many there may be (and are in the geometry) */
  capacity = 0;
  private allocated = 0;
  /** the camera's height in the box, as a share of the box's height (more of the box above: it falls from there) */
  private readonly camShare: number;
  /** how far each speed class has fallen and drifted, wrapped to the box */
  private readonly drift = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly seed: number;
  // (for onBeforeRender)
  private readonly size = new THREE.Vector2();
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Vector3();
  private readonly h = new THREE.Vector3();

  constructor(snow: boolean, capacity: number, box: THREE.Vector3, camShare: number, shelter: Shelter, seed: number) {
    this.box = box;
    this.camShare = camShare;
    this.seed = seed;
    this.u = fieldUniforms();
    this.u.uBox.value.copy(box);
    this.u.uCamLocal.value.set(box.x * 0.5, box.y * camShare, box.z * 0.5);
    const material = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      defines: snow ? { SNOW: '' } : {},
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.mesh = new THREE.Mesh(this.geometry(Math.max(1, capacity)), material);
    this.capacity = Math.max(0, Math.round(capacity));
    this.mesh.name = snow ? 'snow' : 'rain';
    this.mesh.frustumCulled = false;
    // after the vehicles' glass (5): the rain is nearly always nearer than anything else see-through
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    const u = this.u;
    // Per picture (the mirrors are pictures of their own): the size of a pixel, and the shelter
    // where it is now – after the scene's matrices were brought up to date.
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      const target = renderer.getRenderTarget();
      const height = target ? target.height : renderer.getDrawingBufferSize(this.size).y;
      const cam = camera as THREE.PerspectiveCamera;
      const fov = cam.isPerspectiveCamera ? cam.getEffectiveFOV() : 60;
      u.uPixel.value = (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, height);
      const s = shelter.object;
      if (s && !shelter.box.isEmpty()) {
        shelter.box.getCenter(this.c);
        shelter.box.getSize(this.h).multiplyScalar(0.5).addScalar(0.05);
        // box → the shelter's unit cube: (the object's world matrix · its box)⁻¹ · this mesh's world matrix
        this.m.makeScale(this.h.x, this.h.y, this.h.z).setPosition(this.c).premultiply(s.matrixWorld).invert().multiply(this.mesh.matrixWorld);
        u.uShelter.value.copy(this.m);
        u.uShelterOn.value = 1;
      } else u.uShelterOn.value = 0;
      material.uniformsNeedUpdate = true;
    };
  }

  /** How many may be drawn at most; a larger number than ever before makes a new geometry (never per frame). */
  setCapacity(n: number): void {
    this.capacity = Math.max(0, Math.round(n));
    if (this.capacity > this.allocated) {
      const old = this.mesh.geometry;
      this.mesh.geometry = this.geometry(this.capacity);
      old.dispose();
    }
  }

  private geometry(n: number): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    // one quad: x across the streak (−1 … 1), y from its head (0) to its tail (1)
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    const seeds = new Float32Array(n * 4);
    const rand = rng(this.seed);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = 0;
    this.allocated = n;
    return g;
  }

  /**
   * Move the box with the camera, let the particles fall and drift `step`
   * seconds (velocity of the middle class, m/s), draw `amount` of them.
   */
  advance(cx: number, cy: number, cz: number, step: number, vx: number, vy: number, vz: number, amount: number): void {
    const B = this.box;
    const lx = cx - B.x * 0.5;
    const ly = cy - B.y * this.camShare;
    const lz = cz - B.z * 0.5;
    this.mesh.position.set(lx, ly, lz);
    const shift = this.u.uShift.value;
    for (let c = 0; c < 3; c++) {
      const d = this.drift[c];
      d.x = wrap(d.x + vx * step, B.x);
      d.y = wrap(d.y + vy * (0.85 + 0.15 * c) * step, B.y);
      d.z = wrap(d.z + vz * step, B.z);
      // (the box's corner subtracted here, in double precision: the shader only sees small numbers)
      shift[c].set(wrap(d.x - lx, B.x), wrap(d.y - ly, B.y), wrap(d.z - lz, B.z));
    }
    this.u.uVel.value.set(vx, vy, vz);
    const n = Math.min(this.capacity, Math.round(this.capacity * Math.min(1, Math.max(0, amount))));
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// --------------------------------------------- the sky's own values, kept

/** A number of the sky that the weather changes: the value the game gave it, told from the one the weather wrote. */
class Kept {
  base = 0;
  private last = NaN;
  private known = false;
  /** the game's value: what is there now, unless it is what the weather wrote last */
  read(v: number): number {
    if (!this.known || v !== this.last) {
      this.base = v;
      this.known = true;
    }
    return this.base;
  }
  wrote(v: number): number {
    this.last = v;
    return v;
  }
  forget(): void {
    this.known = false;
  }
}

class KeptColor {
  readonly base = new THREE.Color();
  private readonly last = new THREE.Color();
  private known = false;
  read(c: THREE.Color): THREE.Color {
    if (!this.known || !c.equals(this.last)) {
      this.base.copy(c);
      this.known = true;
    }
    return this.base;
  }
  wrote(c: THREE.Color): void {
    this.last.copy(c);
  }
  forget(): void {
    this.known = false;
  }
}

interface DomeUniforms {
  uZenith: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uSunColor: { value: THREE.Color };
}

// ------------------------------------------------------------ wet roads

const WET_PARS = /* glsl */ `
uniform float uFsWet;
uniform vec3 uFsWetSky;
varying vec2 vFsWetXZ;
float fsWetHash(vec2 p) {
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}
float fsWetNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fsWetHash(i), fsWetHash(i + vec2(1.0, 0.0)), f.x), mix(fsWetHash(i + vec2(0.0, 1.0)), fsWetHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

const WET_FRAG = /* glsl */ `
if (uFsWet > 0.001) {
  // A wet road: darker, and at a glancing angle the sky mirrored in its film of water –
  // most of all in the puddles, which come once it has rained a while.
  float fsC = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
  float fsF = 0.03 + 0.97 * pow(1.0 - fsC, 5.0);
  float fsPuddle = smoothstep(0.64, 0.74, fsWetNoise(vFsWetXZ * 0.23)) * smoothstep(0.55, 1.0, uFsWet);
  outgoingLight *= 1.0 - uFsWet * (0.38 + 0.25 * fsPuddle);
  outgoingLight = mix(outgoingLight, uFsWetSky, clamp(fsF * uFsWet * (0.45 + 0.5 * fsPuddle), 0.0, 1.0));
}
`;

// ------------------------------------------------------------ the renderer

/** what the weather is heading for (internal) */
interface Target {
  rain: number;
  fall: number;
  exposure: number;
  radius: number;
  opacity: number;
  snow: number;
  windX: number;
  windZ: number;
  logVis: number;
  readonly fog: THREE.Color;
  readonly zenith: THREE.Color;
  tint: number;
  sun: number;
  ambient: number;
  wet: number;
  storm: number;
}

/** how quickly the picture follows the weather (s; a change of the setting shows within a few seconds) */
const FADE = 2.5;
/** the near-ground wind: two thirds or so of the wind 10 m up */
const GROUND_WIND = 0.75;

export class WeatherRenderer {
  /** water standing on the roads in the wet (the graphics' weatherFx, 1.7.1: "No mercy"): without it they stay dry to the eye */
  roadWater = true;
  /** add this to the scene */
  readonly group = new THREE.Group();
  readonly look: WeatherLook = {
    visibility: 30000,
    fogColor: SKY_LIN.cloudy[0].clone(),
    zenithColor: SKY_LIN.cloudy[1].clone(),
    tint: 0,
    sunFactor: 1,
    ambientFactor: 1,
    wet: 0,
    flash: 0,
    rain: 0,
    snow: 0,
  };
  /** lightning strikes so far (the sound may follow each with thunder) */
  strikes = 0;
  private readonly rain: Field;
  private readonly snow: Field;
  private readonly shelter: Shelter = { object: null, box: new THREE.Box3() };
  private readonly target: Target = {
    rain: 0,
    fall: 8,
    exposure: 0.04,
    radius: 0.0028,
    opacity: 0.3,
    snow: 0,
    windX: 0,
    windZ: 0,
    logVis: Math.log(30000),
    fog: new THREE.Color(),
    zenith: new THREE.Color(),
    tint: 0,
    sun: 1,
    ambient: 1,
    wet: 0,
    storm: 0,
  };
  // the smoothed state (what `look` does not show)
  private logVis = Math.log(30000);
  private fall = 8;
  private exposure = 0.04;
  private radius = 0.0028;
  private opacity = 0.3;
  private windX = 0;
  private windZ = 0;
  private storm = 0;
  private time = 0;
  private snapNext = true;
  private readonly wind = { x: 0, z: 0 };
  // the camera's velocity
  private readonly camVel = new THREE.Vector3();
  private readonly camLast = new THREE.Vector3();
  private hasCam = false;
  // lightning
  private readonly rand = rng(0x5eed);
  private nextStrike = 8;
  private flashT = -1;
  // the sky, when attached
  private sky: SkyParts | null = null;
  private dome: DomeUniforms | null = null;
  private readonly fogNear = new Kept();
  private readonly fogFar = new Kept();
  private readonly sunI = new Kept();
  private readonly hemiI = new Kept();
  private readonly fogColor = new KeptColor();
  private readonly hemiColor = new KeptColor();
  private readonly zenith = new KeptColor();
  private readonly horizon = new KeptColor();
  private readonly sunColor = new KeptColor();
  private readonly fogOut = { near: 0, far: 0 };
  private readonly tmp = new THREE.Color();
  // wet roads
  private readonly wetUniforms = { uFsWet: { value: 0 }, uFsWetSky: { value: new THREE.Color(0xa0a8b0) } };
  private readonly wetted = new WeakSet<THREE.Material>();

  /** `quality`: the most raindrops at once (WEATHER_PARTICLES has them by graphics quality) */
  constructor(quality: number = WEATHER_PARTICLES.medium) {
    this.group.name = 'weather';
    const q = Math.max(0, Math.round(quality));
    // rain: a box 30 m wide and 18 m high, two fifths of it below the camera; snow: a smaller one (flakes are seen less far)
    this.rain = new Field(false, q, new THREE.Vector3(30, 18, 30), 0.4, this.shelter, 1);
    this.snow = new Field(true, Math.round(q * SNOW_SHARE), new THREE.Vector3(24, 14, 24), 0.45, this.shelter, 2);
    this.group.add(this.rain.mesh, this.snow.mesh);
  }

  /** the most raindrops in the air at once (snowflakes: 60 % of it) – WEATHER_PARTICLES[quality] */
  get quality(): number {
    return this.rain.capacity;
  }

  set quality(n: number) {
    const q = Number.isFinite(n) ? Math.max(0, Math.round(n)) : WEATHER_PARTICLES.medium;
    this.rain.setCapacity(q);
    this.snow.setCapacity(Math.round(q * SNOW_SHARE));
  }

  /**
   * The vehicle the camera is in or behind: no rain inside `box` (in the
   * object's own frame – e.g. its outline and height, a little more round
   * the cabin).  null: none (on foot).
   */
  setShelter(object: THREE.Object3D | null, box?: THREE.Box3): void {
    this.shelter.object = object;
    if (box) this.shelter.box.copy(box);
    else if (!object) this.shelter.box.makeEmpty();
  }

  /** The next update shows the weather at once, without fading over (at the start of a drive). */
  jump(): void {
    this.snapNext = true;
  }

  /**
   * Apply the look to the game's sky every update: fog distances and colour,
   * the sun and the sky light, the dome.  What the game sets there itself
   * (applySettings: fog distances; setSun: colours) is taken as the clear
   * weather's value from then on.  null: give the sky its own values back.
   */
  attachSky(sky: SkyParts | null): void {
    if (this.sky) this.restoreSky();
    this.sky = sky;
    this.dome = null;
    if (!sky) return;
    const mat = (sky.dome as THREE.Mesh | undefined)?.material as THREE.ShaderMaterial | undefined;
    const u = mat?.isShaderMaterial ? (mat.uniforms as Partial<DomeUniforms>) : null;
    if (u?.uZenith?.value instanceof THREE.Color && u.uHorizon?.value instanceof THREE.Color && u.uSunColor?.value instanceof THREE.Color) this.dome = u as DomeUniforms;
    this.applySky();
  }

  /**
   * Wet roads: darker in the rain, mirroring the sky at a glancing angle,
   * with puddles once it has rained a while.  For a MeshLambertMaterial (or
   * Phong/Standard) of the ground – the tiles' road and paint materials.
   * Recompiles the material once; the wetness itself is a uniform.
   */
  addWetness(material: THREE.Material): void {
    if (this.wetted.has(material)) return;
    this.wetted.add(material);
    const prevCompile = material.onBeforeCompile;
    // the program's key: the material's own one (its onBeforeCompile's text, unless it has a key of its own) and ours
    const own = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey');
    const ownKey = own ? material.customProgramCacheKey.bind(material) : null;
    const plainKey = own ? '' : prevCompile.toString();
    const u = this.wetUniforms;
    material.onBeforeCompile = (shader, renderer) => {
      prevCompile.call(material, shader, renderer);
      shader.uniforms.uFsWet = u.uFsWet;
      shader.uniforms.uFsWetSky = u.uFsWetSky;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFsWetXZ;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvFsWetXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${WET_PARS}`)
        .replace('#include <opaque_fragment>', `${WET_FRAG}\n#include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => (ownKey ? ownKey() : plainKey) + '|fs-wet';
    material.needsUpdate = true;
  }

  /**
   * Once a frame: the camera's position (world, m), the time since the last
   * frame (s) and the weather to show (weatherFor()).
   */
  update(camera: Readonly<{ x: number; y: number; z: number }>, dt: number, state: WeatherState): void {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    this.time += step;
    const t = this.target;
    this.aim(state);
    const snap = this.snapNext;
    const k = snap ? 1 : 1 - Math.exp(-step / FADE);
    this.snapNext = false;
    const L = this.look;
    L.rain += (t.rain - L.rain) * k;
    L.snow += (t.snow - L.snow) * k;
    L.tint += (t.tint - L.tint) * k;
    L.sunFactor += (t.sun - L.sunFactor) * k;
    L.ambientFactor += (t.ambient - L.ambientFactor) * k;
    L.fogColor.lerp(t.fog, k);
    L.zenithColor.lerp(t.zenith, k);
    // (roads dry more slowly than they get wet)
    L.wet += (t.wet - L.wet) * (t.wet > L.wet || snap ? k : 1 - Math.exp(-step / (FADE * 4)));
    this.logVis += (t.logVis - this.logVis) * k;
    L.visibility = Math.exp(this.logVis);
    this.fall += (t.fall - this.fall) * k;
    this.exposure += (t.exposure - this.exposure) * k;
    this.radius += (t.radius - this.radius) * k;
    this.opacity += (t.opacity - this.opacity) * k;
    this.windX += (t.windX - this.windX) * k;
    this.windZ += (t.windZ - this.windZ) * k;
    this.storm += (t.storm - this.storm) * k;

    // the camera's velocity: the streaks show the motion relative to it
    if (this.hasCam && Number.isFinite(dt) && dt > 1e-4) {
      const dx = camera.x - this.camLast.x;
      const dy = camera.y - this.camLast.y;
      const dz = camera.z - this.camLast.z;
      if (dx * dx + dy * dy + dz * dz > 2500) this.camVel.set(0, 0, 0); // a jump (a new drive, a replay)
      else {
        const a = 1 - Math.exp(-dt / 0.12);
        this.camVel.x += (dx / dt - this.camVel.x) * a;
        this.camVel.y += (dy / dt - this.camVel.y) * a;
        this.camVel.z += (dz / dt - this.camVel.z) * a;
        const v = this.camVel.length();
        if (v > 70) this.camVel.multiplyScalar(70 / v);
      }
    }
    this.camLast.set(camera.x, camera.y, camera.z);
    this.hasCam = true;

    // lightning
    let flash = 0;
    if (this.storm > 0.3) {
      this.nextStrike -= step;
      if (this.nextStrike <= 0) {
        this.flashT = 0;
        this.strikes++;
        this.nextStrike = (5 + this.rand() * 20) / this.storm;
      }
    }
    if (this.flashT >= 0) {
      const f = this.flashT;
      flash = f < 0.06 ? 1 : f < 0.12 ? 0.2 : f < 0.2 ? 0.8 : 0.8 * Math.exp(-(f - 0.2) / 0.12);
      this.flashT += step;
      if (this.flashT > 1.5) this.flashT = -1;
    }
    L.flash = flash;

    // the particles: wind with gusts, the fall, their colour in this light
    const gust = 1 + 0.3 * Math.sin(this.time * 0.31) * Math.sin(this.time * 0.17 + 1.3);
    const wx = this.windX * gust;
    const wz = this.windZ * gust;
    const light = Math.min(1.2, Math.max(0.25, 0.3 * L.sunFactor + 0.6 * L.ambientFactor) + flash);
    const ru = this.rain.u;
    ru.uCamVel.value.copy(this.camVel);
    ru.uExposure.value = this.exposure;
    ru.uRadius.value = this.radius;
    ru.uOpacity.value = this.opacity;
    ru.uColor.value.setRGB(0.62 * light, 0.66 * light, 0.72 * light);
    this.rain.advance(camera.x, camera.y, camera.z, step, wx, -this.fall, wz, L.rain);
    const su = this.snow.u;
    su.uCamVel.value.copy(this.camVel);
    su.uExposure.value = 0.02;
    su.uRadius.value = 0.009;
    su.uOpacity.value = 0.85;
    su.uFlutter.value = 0.25;
    su.uTime.value = this.time % 3600;
    const sl = 0.55 + 0.45 * light;
    su.uColor.value.setRGB(0.86 * sl, 0.88 * sl, 0.92 * sl);
    this.snow.advance(camera.x, camera.y, camera.z, step, wx, -1.1, wz, L.snow);

    this.applySky();
    this.wetUniforms.uFsWet.value = this.roadWater ? L.wet : 0;
    if (!this.sky) this.wetUniforms.uFsWetSky.value.copy(L.fogColor);
  }

  /** Where the weather is heading: the target of the smoothing. */
  private aim(s: WeatherState): void {
    const t = this.target;
    const I = Math.min(1, Math.max(0, s.intensity));
    const cloud = Math.min(1, Math.max(0, s.cloud));
    const vis = Math.min(50000, Math.max(20, s.visibility));
    const kind = s.kind;
    const falls = I > 0 && (kind === 'drizzle' || kind === 'rain' || kind === 'storm' || kind === 'snow');
    t.rain = 0;
    t.snow = 0;
    if (kind === 'drizzle' && I > 0) {
      t.rain = 0.35 + 0.65 * I;
      t.fall = 2.2;
      t.exposure = 0.07;
      t.radius = 0.0016;
      t.opacity = 0.22;
    } else if ((kind === 'rain' || kind === 'storm') && I > 0) {
      t.rain = (kind === 'storm' ? 0.2 : 0.12) + (kind === 'storm' ? 0.8 : 0.88) * I;
      t.fall = kind === 'storm' ? 9.5 : 8;
      t.exposure = 0.04;
      t.radius = kind === 'storm' ? 0.0032 : 0.0028;
      t.opacity = kind === 'storm' ? 0.34 : 0.3;
    } else if (kind === 'snow' && I > 0) t.snow = 0.15 + 0.85 * I;
    windVector(s, this.wind);
    t.windX = this.wind.x * GROUND_WIND;
    t.windZ = this.wind.z * GROUND_WIND;
    t.logVis = Math.log(vis);
    const sky = SKY_LIN[kind] ?? SKY_LIN.cloudy;
    t.fog.copy(sky[0]);
    t.zenith.copy(sky[1]);
    const fogDensity = 1 - smooth(300, 5000, vis);
    if (kind === 'clear' || kind === 'cloudy') t.tint = 0.85 * smooth(0.25, 1, cloud);
    else if (kind === 'fog') t.tint = 0.55 + 0.45 * (1 - smooth(150, 2500, vis));
    else t.tint = Math.max(0.85 * smooth(0.25, 1, cloud), 0.85 + 0.15 * I);
    const p = falls ? I : 0;
    const storm = kind === 'storm' ? 1 : 0;
    t.sun = Math.min(1, Math.max(0.03, (1 - 0.85 * Math.pow(cloud, 1.5)) * (1 - 0.45 * p) * (1 - 0.7 * fogDensity) * (storm ? 0.55 : 1)));
    // overcast, the light comes from the whole sky: less sun, more sky light (a snowy sky is bright)
    t.ambient = Math.min(1.45, Math.max(0.45, 1 + 0.32 * cloud - 0.3 * p - 0.35 * storm + (kind === 'snow' ? 0.12 * I : 0) + 0.05 * fogDensity));
    t.wet = Math.min(1, Math.max(0, s.wet));
    t.storm = storm;
  }

  /** Bring the look onto the attached sky. */
  private applySky(): void {
    const sky = this.sky;
    if (!sky) return;
    const L = this.look;
    const fog = sky.fog;
    const near = this.fogNear.read(fog.near);
    const far = this.fogFar.read(fog.far);
    weatherFog(L.visibility, near, far, this.fogOut);
    fog.near = this.fogNear.wrote(this.fogOut.near);
    fog.far = this.fogFar.wrote(this.fogOut.far);
    // the weather's greys are those of a clear noon; as bright as the sky is now (a night stays dark)
    const base = this.fogColor.read(fog.color);
    const bright = Math.min(1.2, Math.max(0.03, luminance(base) / DAY_HORIZON_LUM));
    const flash = L.flash * 0.45;
    fog.color.copy(base).lerp(this.tmp.copy(L.fogColor).multiplyScalar(bright), L.tint).lerp(FLASH_COLOR, flash);
    this.fogColor.wrote(fog.color);
    this.wetUniforms.uFsWetSky.value.copy(fog.color);
    sky.sun.intensity = this.sunI.wrote(this.sunI.read(sky.sun.intensity) * L.sunFactor);
    sky.hemi.intensity = this.hemiI.wrote(this.hemiI.read(sky.hemi.intensity) * (L.ambientFactor + 1.6 * L.flash));
    sky.hemi.color.copy(this.hemiColor.read(sky.hemi.color)).lerp(GREY_SKYLIGHT, L.tint * 0.8);
    this.hemiColor.wrote(sky.hemi.color);
    const d = this.dome;
    if (d) {
      d.uHorizon.value.copy(this.horizon.read(d.uHorizon.value)).lerp(this.tmp.copy(L.fogColor).multiplyScalar(bright), L.tint).lerp(FLASH_COLOR, flash);
      this.horizon.wrote(d.uHorizon.value);
      d.uZenith.value.copy(this.zenith.read(d.uZenith.value)).lerp(this.tmp.copy(L.zenithColor).multiplyScalar(bright), L.tint).lerp(FLASH_COLOR, flash * 0.7);
      this.zenith.wrote(d.uZenith.value);
      // the sun's disc and glow fade behind the clouds
      d.uSunColor.value.copy(this.sunColor.read(d.uSunColor.value)).multiplyScalar(L.sunFactor * L.sunFactor);
      this.sunColor.wrote(d.uSunColor.value);
    }
  }

  /** The sky's own values back, as the game last set them. */
  private restoreSky(): void {
    const sky = this.sky;
    if (!sky) return;
    sky.fog.near = this.fogNear.read(sky.fog.near);
    sky.fog.far = this.fogFar.read(sky.fog.far);
    sky.fog.color.copy(this.fogColor.read(sky.fog.color));
    sky.sun.intensity = this.sunI.read(sky.sun.intensity);
    sky.hemi.intensity = this.hemiI.read(sky.hemi.intensity);
    sky.hemi.color.copy(this.hemiColor.read(sky.hemi.color));
    const d = this.dome;
    if (d) {
      d.uHorizon.value.copy(this.horizon.read(d.uHorizon.value));
      d.uZenith.value.copy(this.zenith.read(d.uZenith.value));
      d.uSunColor.value.copy(this.sunColor.read(d.uSunColor.value));
    }
    for (const k of [this.fogNear, this.fogFar, this.sunI, this.hemiI, this.fogColor, this.hemiColor, this.zenith, this.horizon, this.sunColor]) k.forget();
  }

  /** Off the scene; the sky gets its own values back; wet materials stay patched but dry. */
  dispose(): void {
    this.attachSky(null);
    this.wetUniforms.uFsWet.value = 0;
    this.rain.dispose();
    this.snow.dispose();
    this.group.removeFromParent();
  }
}
