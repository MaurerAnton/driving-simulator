// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dirt on the player's vehicle: a cheap blend in the materials of its body.
 *
 * Each material of the vehicle's outside gets a few lines in its shader:
 * where a mask says so, the colour is drawn towards a greyish brown and
 * the shine goes.  The mask is a small tiling noise texture, looked up at
 * two scales where the point lies in the vehicle's own frame (so the dirt
 * stays put on the body as it drives), and it rises towards the bottom of
 * the body – the sills, the wheels and the lower doors get dirty first, the
 * roof last.  `level` (0 clean … 1 filthy) moves the mask's threshold: one
 * uniform for every material, so nothing is rebuilt as the dirt grows.
 *
 * The materials are changed in place, once (their shader is compiled
 * again then).  Materials of lamps, displays, glass and linings are left
 * as they are: MeshBasicMaterial, transparent ones, those seen from inside
 * (BackSide) and those with a picture on them.
 */
import * as THREE from 'three';

/** The uniforms every dirty material shares. */
const U = {
  uDirt: { value: 0 },
  /** world → the vehicle's frame */
  uDirtFrame: { value: new THREE.Matrix4() },
  /** how tall the vehicle is (m): the dirt climbs to about this height */
  uDirtHeight: { value: 1.45 },
  uDirtColour: { value: new THREE.Color(0x6a5d4a) },
  uDirtNoise: { value: null as THREE.Texture | null },
};

/** A 64 × 64 tile of soft value noise (one channel). */
function noiseTexture(): THREE.DataTexture {
  const N = 64;
  const g = 8;
  const grid = new Float32Array(g * g);
  let s = 1234567;
  const rand = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const data = new Uint8Array(N * N * 4);
  const at = (i: number, j: number): number => grid[((j + g) % g) * g + ((i + g) % g)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const fx = (x / N) * g;
      const fy = (y / N) * g;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const tx = fx - i;
      const ty = fy - j;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const a = at(i, j) + (at(i + 1, j) - at(i, j)) * sx;
      const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * sx;
      // (a fine grain on top of the soft blots: splashes)
      const v = (a + (b - a) * sy) * 0.8 + rand() * 0.2;
      const k = (y * N + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = Math.round(v * 255);
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const patched = new WeakSet<THREE.Material>();

/** Can this material get dirty (see above)? */
function dirtyable(m: THREE.Material): m is THREE.MeshLambertMaterial | THREE.MeshPhongMaterial | THREE.MeshStandardMaterial {
  if (!(m instanceof THREE.MeshLambertMaterial || m instanceof THREE.MeshPhongMaterial || m instanceof THREE.MeshStandardMaterial)) return false;
  return !m.transparent && m.side !== THREE.BackSide && !m.map;
}

/** Put the dirt into one material. */
function patch(m: THREE.MeshLambertMaterial | THREE.MeshPhongMaterial | THREE.MeshStandardMaterial): void {
  if (patched.has(m)) return;
  patched.add(m);
  U.uDirtNoise.value ??= noiseTexture();
  const before = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    before?.call(m, shader, renderer);
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uDirtFrame;\nvarying vec3 vDirtPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDirtPos = (uDirtFrame * modelMatrix * vec4(transformed, 1.0)).xyz;');
    let frag = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uDirt;\nuniform float uDirtHeight;\nuniform vec3 uDirtColour;\nuniform sampler2D uDirtNoise;\nvarying vec3 vDirtPos;\nfloat dirtMask = 0.0;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 p = vDirtPos;
  float n = texture2D(uDirtNoise, vec2(p.x + p.y * 0.7, p.z - p.y * 0.3) * 0.45).r * 0.6 + texture2D(uDirtNoise, vec2(p.z + p.x * 0.5, p.y) * 1.7).r * 0.4;
  float low = clamp(1.15 - p.y / uDirtHeight, 0.0, 1.0);
  dirtMask = smoothstep(0.32, 0.7, uDirt * (0.45 + 0.85 * low) + (n - 0.5) * 0.6 + 0.12) * min(1.0, uDirt * 4.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, uDirtColour * (0.7 + 0.6 * n), dirtMask * 0.85);
}`,
      );
    // (dirt takes the shine: the specular light where the colour says)
    if (frag.includes('#include <specularmap_fragment>')) frag = frag.replace('#include <specularmap_fragment>', '#include <specularmap_fragment>\nspecularStrength *= 1.0 - 0.85 * dirtMask;');
    if (frag.includes('#include <roughnessmap_fragment>')) frag = frag.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 1.0, dirtMask * 0.8);');
    shader.fragmentShader = frag;
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|dirt`;
  m.needsUpdate = true;
}

/**
 * The dirt on a vehicle: `apply` the materials of its model once, then
 * `update` each frame with the level and where the model stands.
 */
export class DirtLook {
  private readonly done = new WeakSet<THREE.Object3D>();

  /** Make the outside of a model able to get dirty (a model with an `exterior` group: only that – the car's cockpit stays clean). */
  apply(model: { root: THREE.Object3D; exterior?: { group: THREE.Object3D } }): void {
    const top = model.exterior?.group ?? model.root;
    if (this.done.has(top)) return;
    this.done.add(top);
    top.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (dirtyable(m)) patch(m);
    });
  }

  /** The level (0 … 1), the model's place (its root, whose matrixWorld is current) and how tall the vehicle is. */
  update(level: number, root: THREE.Object3D, height: number): void {
    U.uDirt.value = Math.max(0, Math.min(1, level));
    U.uDirtFrame.value.copy(root.matrixWorld).invert();
    U.uDirtHeight.value = Math.max(0.8, height);
  }
}
