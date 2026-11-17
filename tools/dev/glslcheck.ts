// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Checks that patched shaders of the game compile, without a browser: it
 * builds the GLSL that three.js would hand to WebGL 2 for a material (the
 * Lambert shader, run through the material's onBeforeCompile chain, its
 * includes resolved, with the prefix of defines, built-in uniforms and
 * attributes that three's WebGLProgram puts in front) and runs
 * glslangValidator over the vertex and the fragment shader.
 *
 * Now: the terrain and the far view, with the season and the water; the
 * water's spray.
 *
 *   node tools/dev/glslcheck.ts            (needs glslangValidator on the PATH)
 *
 * The prefix is a close copy of three's, not three's own: a shader that
 * passes here may still meet a define this one lacks – but a typo, a wrong
 * type or an undeclared name is caught.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';
import { makeTerrainMaterial } from '../../src/render/materials.ts';
import { FarTerrain } from '../../src/render/far.ts';
import { SeasonLook } from '../../src/render/season.ts';
import { WaterLook, WaterSpray } from '../../src/render/water.ts';

const LIGHTS: Record<string, number> = {
  NUM_SUN_LIGHTS: 0,
  NUM_DIR_LIGHTS: 1,
  NUM_SPOT_LIGHTS: 0,
  NUM_SPOT_LIGHT_MAPS: 0,
  NUM_SPOT_LIGHT_COORDS: 0,
  NUM_RECT_AREA_LIGHTS: 0,
  NUM_POINT_LIGHTS: 0,
  NUM_HEMI_LIGHTS: 1,
  NUM_SUN_LIGHT_SHADOWS: 0,
  NUM_DIR_LIGHT_SHADOWS: 1,
  NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS: 0,
  NUM_SPOT_LIGHT_SHADOWS: 0,
  NUM_POINT_LIGHT_SHADOWS: 0,
  NUM_LIGHT_PROBE_GRIDS: 0,
  NUM_CLIPPING_PLANES: 0,
  UNION_CLIPPING_PLANES: 0,
};

function resolve(src: string): string {
  return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_m, name: string) => {
    const chunk = (THREE.ShaderChunk as Record<string, string>)[name];
    if (chunk === undefined) throw new Error(`no chunk <${name}>`);
    return resolve(chunk);
  });
}

function finish(src: string): string {
  let s = resolve(src);
  // (longest names first: NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS before NUM_SPOT_LIGHT_SHADOWS)
  for (const k of Object.keys(LIGHTS).sort((a, b) => b.length - a.length)) s = s.replace(new RegExp(k, 'g'), String(LIGHTS[k]));
  s = s.replace(/#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g, (_m, a: string, b: string, body: string) => {
    let out = '';
    for (let i = +a; i < +b; i++) out += body.replace(/\[\s*i\s*\]/g, `[ ${i} ]`).replace(/UNROLLED_LOOP_INDEX/g, String(i));
    return out;
  });
  return s;
}

const PRECISION = ['float', 'int', 'sampler2D', 'samplerCube', 'sampler3D', 'sampler2DArray', 'sampler2DShadow', 'samplerCubeShadow', 'sampler2DArrayShadow', 'isampler2D', 'isampler3D', 'isamplerCube', 'isampler2DArray', 'usampler2D', 'usampler3D', 'usamplerCube', 'usampler2DArray']
  .map((t) => `precision highp ${t};`)
  .join('\n');

function build(material: THREE.Material, defines: string[]): { vs: string; fs: string } {
  // (a ShaderMaterial brings its own shaders; the built-in materials here are Lambert's)
  const lib = material instanceof THREE.ShaderMaterial ? material : THREE.ShaderLib.lambert;
  const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: THREE.UniformsUtils.clone(lib.uniforms), defines: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  // ('average', a function of three's common chunk, is a built-in of an extension glslang knows: renamed for the check)
  const common = ['#define average fsAverage', ...defines, '#define USE_FOG', '#define USE_SHADOWMAP', '#define SHADOWMAP_TYPE_PCF', '#define HIGH_PRECISION'].join('\n');
  const vs = [
    '#version 300 es',
    '#define attribute in',
    '#define varying out',
    '#define texture2D texture',
    PRECISION,
    common,
    'uniform mat4 modelMatrix;',
    'uniform mat4 modelViewMatrix;',
    'uniform mat4 projectionMatrix;',
    'uniform mat4 viewMatrix;',
    'uniform mat3 normalMatrix;',
    'uniform vec3 cameraPosition;',
    'uniform bool isOrthographic;',
    'attribute vec3 position;',
    'attribute vec3 normal;',
    'attribute vec2 uv;',
    '#ifdef USE_COLOR',
    'attribute vec3 color;',
    '#endif',
    finish(shader.vertexShader),
  ].join('\n');
  const fs = [
    '#version 300 es',
    '#define varying in',
    'layout(location = 0) out highp vec4 pc_fragColor;',
    '#define gl_FragColor pc_fragColor',
    '#define texture2D texture',
    PRECISION,
    common,
    '#define OPAQUE',
    'uniform mat4 viewMatrix;',
    'uniform vec3 cameraPosition;',
    'uniform bool isOrthographic;',
    '#define TONE_MAPPING',
    THREE.ShaderChunk.tonemapping_pars_fragment,
    'vec3 toneMapping( vec3 color ) { return ACESFilmicToneMapping( color ); }',
    THREE.ShaderChunk.colorspace_pars_fragment,
    'vec4 linearToOutputTexel( vec4 value ) { return sRGBTransferOETF( value ); }',
    'float luminance( const in vec3 rgb ) { return dot( rgb, vec3( 0.2126, 0.7152, 0.0722 ) ); }',
    finish(shader.fragmentShader),
  ].join('\n');
  return { vs, fs };
}

const dir = mkdtempSync(join(tmpdir(), 'glslcheck-'));
let failed = 0;
function check(name: string, material: THREE.Material, defines: string[]): void {
  const { vs, fs } = build(material, defines);
  for (const [ext, src] of [['vert', vs], ['frag', fs]] as const) {
    const file = join(dir, `${name}.${ext}`);
    writeFileSync(file, src);
    try {
      execFileSync('glslangValidator', [file], { encoding: 'utf8' });
      console.log(`ok    ${name}.${ext}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}.${ext}  (${file})\n${(e as { stdout?: string }).stdout ?? e}`);
    }
  }
}

const season = new SeasonLook();
const water = new WaterLook();
water.enabled = true;
const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
for (const withWater of [false, true]) {
  water.enabled = withWater;
  const terrain = makeTerrainMaterial(tex);
  season.patch(terrain, 'terrain');
  water.patch(terrain, 'terrain');
  check(`terrain${withWater ? '-water' : ''}`, terrain, ['#define USE_MAP', '#define MAP_UV uv']);
  const far = (new FarTerrain() as unknown as { material: THREE.Material }).material;
  season.patch(far, 'far');
  water.patch(far, 'far');
  check(`far${withWater ? '-water' : ''}`, far, ['#define USE_COLOR', '#define DOUBLE_SIDED']);
}
check('spray', new WaterSpray(4).points.material as THREE.Material, []);
if (!failed) rmSync(dir, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
