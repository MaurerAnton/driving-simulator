// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The seasons: fresh green and blossom in spring, the land as it is drawn
 * now in summer, yellow, red and brown leaves and ploughed fields in autumn,
 * bare trees, dull grass and snow in winter.
 *
 * By default the season follows the game's clock (game/clock.ts – the real
 * date, or the one the arcade mode set), by the phenology of northern Hesse:
 * leaves out in late April, turned in October, fallen by late November.  In
 * the "arcade" settings the player picks one.  Snow lies as the real weather
 * reports it (its snow depth) when the real weather is on – otherwise as in
 * a typical winter – and wherever snow is falling.
 *
 * Nothing is rebuilt for a season: the materials of the ground, the roads,
 * the buildings and the trees get a few lines of shader (SeasonLook.patch)
 * that read shared uniforms, so a change of season is a change of uniforms
 * (the bare trees' see-through crowns aside: one recompile of the tree
 * materials when the leaves go or come).  The colour arithmetic exists twice,
 * as GLSL and as the pure functions below – both built from the same
 * constants, so the tests of the one hold for the other.
 */
import * as THREE from 'three';
import { gameNow, seasonOf } from '../game/clock.ts';
import type { Season } from '../game/clock.ts';
import { snowOnGround } from '../game/weather.ts';
import type { WeatherState } from '../game/weather.ts';
import { COVER_COLORS } from '../world/cover.ts';

export type { Season };
export const SEASONS: readonly Season[] = ['spring', 'summer', 'autumn', 'winter'];
/** the season setting: the real one (by the date), or one chosen */
export type SeasonSetting = 'real' | Season;
export const SEASON_SETTINGS: readonly SeasonSetting[] = ['real', 'spring', 'summer', 'autumn', 'winter'];

export function isSeasonSetting(v: unknown): v is SeasonSetting {
  return typeof v === 'string' && (SEASON_SETTINGS as readonly string[]).includes(v);
}

export interface SeasonState {
  /** the season by name (meteorological: spring is March to May …) */
  season: Season;
  /** the foliage of the broadleaf trees and bushes, 0 bare … 1 full */
  leaves: number;
  /** the fresh, light green of young leaves, grass and crops, 0 … 1 */
  spring: number;
  /** fruit trees (and a few others) in blossom, 0 … 1 */
  blossom: number;
  /** how far the leaves have turned yellow, red and brown; fields ploughed, 0 … 1 */
  autumn: number;
  /** the dull grass, bare dark fields and leaf litter of the dormant season, 0 … 1 */
  dormant: number;
  /** snow lying on the ground, the roofs and the trees, 0 … 1 (1: all white) */
  snow: number;
  /** snow lying on the roads – cleared and driven, less than beside them, 0 … 1 */
  roadSnow: number;
}

/** of the snow beside the road, how much lies on it (the rest is cleared, driven away, salted) */
const ROAD_SHARE = 0.7;

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ------------------------------------------------------------ the dates

const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/** Day of the year, 1 … 365, by the local calendar (29 February counts as 1 March). */
export function dayOfYear(date: Date): number {
  return MONTH_START[date.getMonth()] + date.getDate();
}

/**
 * The season on a day round Kassel (pure; the local calendar day of `date`).
 * `typicalSnow`: snow as in a typical winter (lying from Christmas to
 * mid-February) – for when the real weather does not say how much there is.
 */
export function seasonAt(date: Date, typicalSnow = true): SeasonState {
  const d = dayOfYear(date);
  // the leaves come out from mid-April, are full by mid-May; turn from late September; fall from mid-October to late November
  const leaves = smooth(100, 135, d) * (1 - smooth(290, 325, d));
  const spring = smooth(95, 115, d) * (1 - smooth(140, 175, d));
  // fruit trees: the second half of April
  const blossom = smooth(98, 108, d) * (1 - smooth(122, 132, d));
  const autumn = d > 182 ? smooth(262, 300, d) : 0;
  const dormant = d > 182 ? smooth(300, 340, d) : 1 - smooth(75, 110, d);
  const snow = typicalSnow ? (d > 182 ? smooth(345, 360, d) : 1 - smooth(45, 60, d)) : 0;
  return { season: seasonOf(date), leaves, spring, blossom, autumn, dormant, snow, roadSnow: snow * ROAD_SHARE };
}

function preset(s: SeasonState): SeasonState {
  return Object.freeze(s);
}

/** The seasons as the player picks them: each at its most typical.  (Summer is the land as it was always drawn.) */
export const SEASON_PRESETS: Readonly<Record<Season, SeasonState>> = Object.freeze({
  spring: preset({ season: 'spring', leaves: 0.9, spring: 1, blossom: 1, autumn: 0, dormant: 0, snow: 0, roadSnow: 0 }),
  summer: preset({ season: 'summer', leaves: 1, spring: 0, blossom: 0, autumn: 0, dormant: 0, snow: 0, roadSnow: 0 }),
  autumn: preset({ season: 'autumn', leaves: 0.75, spring: 0, blossom: 0, autumn: 0.9, dormant: 0.25, snow: 0, roadSnow: 0 }),
  winter: preset({ season: 'winter', leaves: 0, spring: 0, blossom: 0, autumn: 1, dormant: 1, snow: 1, roadSnow: ROAD_SHARE }),
});

/**
 * The season to show: the one chosen, or the one of the game's day (`date`,
 * by default the game's clock, gameNow()) – with the snow the real weather
 * reports (its snow depth) when it is on, and snow settling wherever it is
 * falling (not when it is warm).  A new object: call it when the setting,
 * the day or the weather changed, not every frame.
 */
export function seasonFor(setting: SeasonSetting, weather?: WeatherState | null, date: Date = gameNow()): SeasonState {
  const real = weather?.source === 'real';
  const s: SeasonState = setting === 'real' ? seasonAt(date, !real) : { ...(SEASON_PRESETS[setting] ?? SEASON_PRESETS.summer) };
  if (weather) {
    const lying = snowOnGround(weather);
    // the real weather says how much lies; otherwise what falls (or a chosen snowy weather) adds to the season's
    s.snow = setting === 'real' && real ? lying : Math.max(s.snow, lying);
  }
  s.roadSnow = s.snow * ROAD_SHARE;
  if (weather && weather.kind === 'snow' && weather.intensity > 0 && weather.temperature <= 0) s.roadSnow = Math.max(s.roadSnow, 0.3 + 0.4 * clamp01(weather.intensity));
  // a thaw: the roads clear first
  if (setting === 'real' && weather && real && weather.temperature > 3) s.roadSnow *= 0.4;
  return s;
}

// ------------------------------------------------- the colours, as numbers

type RGB = [number, number, number];

/** sRGB hex → linear RGB (as the shaders see colours) */
function lin(hex: number): RGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

function lum(c: Readonly<RGB>): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** the green the broadleaf crowns are drawn in (props.ts) – the season's crown colours are factors on it */
const CROWN_GREEN = lin(0x4c7a36);
const tint = (hex: number): RGB => {
  const c = lin(hex);
  return [c[0] / CROWN_GREEN[0], c[1] / CROWN_GREEN[1], c[2] / CROWN_GREEN[2]];
};
/** the crowns: the young leaves' green, the autumn colours (yellow, orange, red, brown), blossom, bare twigs */
const CROWN_SPRING = tint(0x64953a);
const CROWN_AUTUMN: readonly RGB[] = [tint(0xc9a227), tint(0xc8641e), tint(0xa5321e), tint(0x7a5a2e)];
const CROWN_BLOSSOM = tint(0xf0dce4);
const CROWN_TWIGS = tint(0x7a6e66);
/** how much of a bare crown is drawn: all of it – a soft grey-brown mass of twigs (drawn see-through,
 *  against a bright sky a crown only showed as speckles) */
const TWIG_COVER = 1;

/** the ground: factors on green plants in spring, in autumn; the leaf litter on the forest floor */
const VEG_SPRING: RGB = [1.1, 1.15, 0.9];
const VEG_AUTUMN: RGB = [1.15, 0.92, 0.8];
const LITTER: RGB = [2.2, 0.85, 0.7];
/** dormant grass: its own brightness, olive and dull */
const VEG_DORMANT: RGB = [1.1, 1.0, 0.78];
/** the fields: young crops, ploughed in autumn, bare in winter – at the brightness of the farmland colour */
const FIELD_SPRING = lin(0x7c9a4a);
const FIELD_AUTUMN = lin(0x86704f);
const FIELD_DORMANT = lin(0x76654d);
const FIELD_LUM = lum(lin(0xa9a35c));
/** snow, and snow trodden on a road */
const SNOW = lin(0xe4e9f0);
const ROAD_SNOW: RGB = [SNOW[0] * 0.78, SNOW[1] * 0.8, SNOW[2] * 0.84];

/**
 * What the season does to a ground colour (linear RGB; writes `out`).  Green
 * plants are told by their colour (green above red and blue), fields by
 * theirs (yellow-tan: red and green alike, little blue), the forest floor by
 * being dark green; grey, brown and blue (streets, yards, water) stay.
 * Mirrors fsSeasonGround in the shaders.
 */
export function seasonGround(c: Readonly<RGB>, s: SeasonState, out: RGB = [0, 0, 0]): RGB {
  const mx = Math.max(c[0], c[1], c[2], 1e-4);
  const veg = smooth(0.08, 0.3, (c[1] - Math.max(c[0], c[2])) / mx);
  const field = smooth(0.3, 0.45, (Math.min(c[0], c[1]) - c[2]) / mx) * (1 - smooth(0.08, 0.2, Math.abs(c[0] - c[1]) / mx));
  const l = lum(c);
  const dark = 1 - smooth(0.06, 0.14, l);
  const fl = l / FIELD_LUM;
  const litter = Math.max(s.autumn * (1 - s.leaves), s.dormant);
  let [r, g, b] = c;
  for (let i = 0; i < 3; i++) {
    let v = c[i];
    v = mix(v, v * VEG_SPRING[i], s.spring * veg);
    v = mix(v, FIELD_SPRING[i] * fl, s.spring * field * 0.7);
    v = mix(v, v * VEG_AUTUMN[i], s.autumn * veg * (1 - dark) * 0.6);
    v = mix(v, v * LITTER[i], veg * dark * litter * 0.8);
    v = mix(v, FIELD_AUTUMN[i] * fl, s.autumn * field * 0.7);
    if (i === 0) r = v;
    else if (i === 1) g = v;
    else b = v;
  }
  const dl = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const o = [r, g, b];
  for (let i = 0; i < 3; i++) {
    let v = o[i];
    v = mix(v, dl * VEG_DORMANT[i], s.dormant * veg * (1 - dark) * 0.55);
    v = mix(v, FIELD_DORMANT[i] * fl, s.dormant * field * 0.75);
    out[i] = v;
  }
  return out;
}

/** The colour of a ground-cover class (COVER, world/cover.ts) in a season, as sRGB hex – snow aside (that the shader lays). */
export function coverColor(cls: number, s: SeasonState): number {
  const c = seasonGround(lin(COVER_COLORS[cls] ?? COVER_COLORS[0]), s);
  return new THREE.Color().setRGB(c[0], c[1], c[2]).getHex();
}

/** All the cover classes' colours in a season (sRGB hex, by class) – e.g. for the far view's chunks or a map. */
export function coverPalette(s: SeasonState): number[] {
  return COVER_COLORS.map((_, i) => coverColor(i, s));
}

export type TreeKind = 'deciduous' | 'orchard' | 'evergreen';

/**
 * A tree's crown in a season: a factor on its summer colour (linear RGB) and
 * how much of the crown is drawn (1 full; a bare crown 0.45: the twigs, seen
 * through).  `r1`, `r2`: the tree's own random numbers (0 … 1) – when its
 * leaves come and go, which colour they turn; `blossomHere`: this part of the
 * crown would carry blossom.  Mirrors the tree shader.
 */
export function crownLook(s: SeasonState, kind: TreeKind, r1: number, r2: number, blossomHere = true): { tint: RGB; cover: number } {
  if (kind === 'evergreen') return { tint: [1, 1, 1], cover: 1 };
  const turn = clamp01(s.autumn * 1.4 - r2 * 0.4);
  const aut = CROWN_AUTUMN[r2 < 0.45 ? 0 : r2 < 0.7 ? 1 : r2 < 0.85 ? 2 : 3];
  const blooms = kind === 'orchard' || r1 > 0.85;
  const b = blooms && blossomHere ? s.blossom : 0;
  const has = clamp01(s.leaves * 1.3 - r1 * 0.3);
  const t: RGB = [1, 1, 1];
  for (let i = 0; i < 3; i++) {
    let v = mix(1, CROWN_SPRING[i], s.spring);
    v = mix(v, aut[i], turn);
    v = mix(v, CROWN_BLOSSOM[i], b);
    t[i] = mix(CROWN_TWIGS[i], v, has);
  }
  return { tint: t, cover: TWIG_COVER + (1 - TWIG_COVER) * has };
}

/**
 * How much of a surface the snow covers (0 … 1): `amount` of snow
 * (SeasonState.snow, or roadSnow on a road), `up` the up-ness of the surface
 * (its normal's y: 1 flat, 0 a wall), `noise` the place's noise (0 … 1:
 * thin snow lies in patches).  Ground and roads take the band 0.55 … 0.8,
 * roofs 0.4 … 0.65 (snow holds on a pitched roof), trees 0.2 … 0.55.
 * Mirrors fsSnowCover in the shaders.
 */
export function snowCover(amount: number, up: number, lo: number, hi: number, noise = 0.5): number {
  if (amount <= 0.001) return 0;
  const e = 1.15 - 1.3 * amount;
  return smooth(lo, hi, up) * smooth(e - 0.15, e + 0.15, noise);
}

// ------------------------------------------------- the colours, as GLSL

function v3(c: Readonly<RGB>): string {
  return `vec3(${c.map((x) => x.toFixed(5)).join(', ')})`;
}

const SEASON_VERT_PARS = /* glsl */ `
varying vec2 vFsSeasonXZ;
uniform float uFsLeaves;
uniform float uFsSpring;
uniform float uFsBlossom;
uniform float uFsAutumn;
`;

/** after project_vertex: where the surface is in the world (for the patches of thin snow) */
const SEASON_VERT_WORLD = /* glsl */ `
{
  vec4 fsW = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  fsW = instanceMatrix * fsW;
#endif
  vFsSeasonXZ = (modelMatrix * fsW).xz;
}
`;

const SEASON_FRAG_PARS = /* glsl */ `
varying vec2 vFsSeasonXZ;
uniform float uFsLeaves;
uniform float uFsSpring;
uniform float uFsAutumn;
uniform float uFsDormant;
uniform float uFsSnow;
uniform float uFsRoadSnow;
float fsSeasonHash(vec2 p) {
  p = fract(p * vec2(127.13, 311.71));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}
float fsSeasonNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fsSeasonHash(i), fsSeasonHash(i + vec2(1.0, 0.0)), f.x), mix(fsSeasonHash(i + vec2(0.0, 1.0)), fsSeasonHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// how much of a surface the snow covers: on what faces the sky, in patches where it is thin
float fsSnowCover(float amount, float up, float lo, float hi, vec2 xz) {
  if (amount <= 0.001) return 0.0;
  float n = fsSeasonNoise(xz * 0.31) * 0.65 + fsSeasonNoise(xz * 2.3) * 0.35;
  float e = 1.15 - 1.3 * amount;
  return smoothstep(lo, hi, up) * smoothstep(e - 0.15, e + 0.15, n);
}
// what the season does to a ground colour: green plants, fields, the forest floor
vec3 fsSeasonGround(vec3 c) {
  float mx = max(max(c.r, c.g), max(c.b, 1e-4));
  float veg = smoothstep(0.08, 0.3, (c.g - max(c.r, c.b)) / mx);
  float field = smoothstep(0.3, 0.45, (min(c.r, c.g) - c.b) / mx) * (1.0 - smoothstep(0.08, 0.2, abs(c.r - c.g) / mx));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float dark = 1.0 - smoothstep(0.06, 0.14, l);
  float fl = l / ${FIELD_LUM.toFixed(5)};
  float litter = max(uFsAutumn * (1.0 - uFsLeaves), uFsDormant);
  vec3 o = c;
  o = mix(o, o * ${v3(VEG_SPRING)}, uFsSpring * veg);
  o = mix(o, ${v3(FIELD_SPRING)} * fl, uFsSpring * field * 0.7);
  o = mix(o, o * ${v3(VEG_AUTUMN)}, uFsAutumn * veg * (1.0 - dark) * 0.6);
  o = mix(o, o * ${v3(LITTER)}, veg * dark * litter * 0.8);
  o = mix(o, ${v3(FIELD_AUTUMN)} * fl, uFsAutumn * field * 0.7);
  float dl = dot(o, vec3(0.2126, 0.7152, 0.0722));
  o = mix(o, dl * ${v3(VEG_DORMANT)}, uFsDormant * veg * (1.0 - dark) * 0.55);
  o = mix(o, ${v3(FIELD_DORMANT)} * fl, uFsDormant * field * 0.75);
  return o;
}
`;

/** the trees: after color_vertex – the crown's colour and how much of it is drawn, per tree */
function treeVertex(kind: TreeKind): string {
  if (kind === 'evergreen') return 'vFsLeafCover = 1.0;';
  return /* glsl */ `
{
#ifdef USE_INSTANCING
  vec2 fsTree = instanceMatrix[3].xz;
#else
  vec2 fsTree = modelMatrix[3].xz;
#endif
  // the tree's own random numbers: when its leaves come and go, which colour they turn
  float fsR1 = fract(sin(dot(fsTree, vec2(12.9898, 78.233))) * 43758.5453);
  float fsR2 = fract(fsR1 * 91.7 + 0.31);
  // the crown is green, the trunk brown
  float fsCrown = step(color.r * 1.25, color.g);
  float fsTurn = clamp(uFsAutumn * 1.4 - fsR2 * 0.4, 0.0, 1.0);
  vec3 fsAut = fsR2 < 0.45 ? ${v3(CROWN_AUTUMN[0])} : fsR2 < 0.7 ? ${v3(CROWN_AUTUMN[1])} : fsR2 < 0.85 ? ${v3(CROWN_AUTUMN[2])} : ${v3(CROWN_AUTUMN[3])};
  vec3 fsT = mix(vec3(1.0), ${v3(CROWN_SPRING)}, uFsSpring);
  fsT = mix(fsT, fsAut, fsTurn);
  // blossom on some of the crown's faces: every fruit tree, now and then another
  float fsBlooms = ${kind === 'orchard' ? '1.0' : 'step(0.85, fsR1)'};
  float fsHere = step(fract(sin(dot(position.xyz, vec3(17.1, 31.7, 11.3)) + fsR1 * 7.0) * 4375.85), 0.65);
  fsT = mix(fsT, ${v3(CROWN_BLOSSOM)}, uFsBlossom * fsBlooms * fsHere);
  float fsHas = clamp(uFsLeaves * 1.3 - fsR1 * 0.3, 0.0, 1.0);
  fsT = mix(${v3(CROWN_TWIGS)}, fsT, fsHas);
  vColor.rgb *= mix(vec3(1.0), fsT, fsCrown);
  vFsLeafCover = mix(1.0, ${TWIG_COVER.toFixed(3)} + ${(1 - TWIG_COVER).toFixed(3)} * fsHas, fsCrown);
}
`;
}

/** a bare crown is drawn see-through: every other pixel or so (only compiled while some crowns are thin) */
const THIN_FRAG = /* glsl */ `
#ifdef FS_THIN
if (vFsLeafCover < 0.999) {
  float fsD = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (fsD > vFsLeafCover) discard;
}
#endif
`;

/** What can be patched: the materials of the terrain, the far view, the roads and their paint, the buildings, bridges and walls, the trees. */
export type SeasonTarget = 'terrain' | 'far' | 'ground' | 'paint' | 'building' | 'struct' | TreeKind;

/** before emissivemap_fragment: the colour is complete there, and the normal known */
function seasonFragment(target: SeasonTarget): string {
  const up = 'vec3 fsUpV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);\n  float fsUp = dot(normal, fsUpV);';
  switch (target) {
    case 'terrain':
    case 'far':
      return /* glsl */ `{
  ${up}
  diffuseColor.rgb = fsSeasonGround(diffuseColor.rgb);
  // (no snow on the water)
  float fsWater = step(diffuseColor.r + 0.05, diffuseColor.b) * step(diffuseColor.g, diffuseColor.b);
  diffuseColor.rgb = mix(diffuseColor.rgb, ${v3(SNOW)}, fsSnowCover(uFsSnow, fsUp, 0.55, 0.8, vFsSeasonXZ) * (1.0 - fsWater));
}`;
    case 'ground':
      // (vFsMat: the surface, materials.ts – asphalt, concrete, setts, worn asphalt and cycle paths are roads)
      return /* glsl */ `{
  ${up}
  diffuseColor.rgb = fsSeasonGround(diffuseColor.rgb);
  float fsRoad = (vFsMat < 1.5 || abs(vFsMat - 3.0) < 0.5 || abs(vFsMat - 10.0) < 0.5 || abs(vFsMat - 13.0) < 0.5) ? 1.0 : 0.0;
  float fsS = fsSnowCover(mix(uFsSnow, uFsRoadSnow, fsRoad), fsUp, 0.55, 0.8, vFsSeasonXZ);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(${v3(SNOW)}, ${v3(ROAD_SNOW)}, fsRoad), fsS);
}`;
    case 'paint':
      // under the road's snow the markings vanish with it
      return /* glsl */ `{
  ${up}
  diffuseColor.rgb = mix(diffuseColor.rgb, ${v3(ROAD_SNOW)}, fsSnowCover(uFsRoadSnow, fsUp, 0.55, 0.8, vFsSeasonXZ));
}`;
    case 'building':
      return /* glsl */ `{
  ${up}
  diffuseColor.rgb = mix(diffuseColor.rgb, ${v3(SNOW)}, fsSnowCover(uFsSnow, fsUp, 0.4, 0.65, vFsSeasonXZ));
}`;
    case 'struct':
      return /* glsl */ `{
  ${up}
  diffuseColor.rgb = mix(diffuseColor.rgb, ${v3(SNOW)}, fsSnowCover(uFsSnow, fsUp, 0.5, 0.75, vFsSeasonXZ));
}`;
    default:
      // trees: snow on what faces the sky – less on bare twigs
      return /* glsl */ `{
  ${up}
  diffuseColor.rgb = mix(diffuseColor.rgb, ${v3(SNOW)}, fsSnowCover(uFsSnow * ${target === 'evergreen' ? '1.0' : 'mix(0.5, 1.0, uFsLeaves)'}, fsUp, 0.2, 0.55, vFsSeasonXZ));
}`;
  }
}

// ------------------------------------------------------- the season look

/** below this much foliage the crowns get thin (and the tree materials their see-through variant) */
const THIN_BELOW = 0.97;

/**
 * The season in the materials: patch() each material once (terrain, far view,
 * roads, paint, buildings, bridges, the trees of each kind), then set() the
 * season whenever it changes – shared uniforms, nothing rebuilt.
 */
export class SeasonLook {
  readonly uniforms = {
    uFsLeaves: { value: 1 },
    uFsSpring: { value: 0 },
    uFsBlossom: { value: 0 },
    uFsAutumn: { value: 0 },
    uFsDormant: { value: 0 },
    uFsSnow: { value: 0 },
    uFsRoadSnow: { value: 0 },
  };
  /** the season shown */
  state: SeasonState = { ...SEASON_PRESETS.summer };
  private readonly patched = new WeakMap<THREE.Material, SeasonTarget>();
  /** the tree materials: recompiled when the crowns get thin or full again */
  private readonly trees: THREE.Material[] = [];
  private thin = false;

  /** Show a season (seasonFor()).  Cheap – uniforms – unless the crowns turn thin or full: then the tree materials compile anew. */
  set(s: SeasonState): void {
    this.state = { ...s };
    const u = this.uniforms;
    u.uFsLeaves.value = clamp01(s.leaves);
    u.uFsSpring.value = clamp01(s.spring);
    u.uFsBlossom.value = clamp01(s.blossom);
    u.uFsAutumn.value = clamp01(s.autumn);
    u.uFsDormant.value = clamp01(s.dormant);
    u.uFsSnow.value = clamp01(s.snow);
    u.uFsRoadSnow.value = clamp01(s.roadSnow);
    const thin = s.leaves < THIN_BELOW;
    if (thin !== this.thin) {
      this.thin = thin;
      for (const m of this.trees) m.needsUpdate = true;
    }
  }

  /** The bare crowns are drawn see-through now (their shadows are not: the game may want tree shadows off then). */
  get thinCrowns(): boolean {
    return this.thin;
  }

  /**
   * Teach a material the seasons (once; a second call does nothing).  For
   * the MeshLambertMaterials of the game: 'terrain' (the tiles' terrain),
   * 'far' (the far view), 'ground' and 'paint' (the tiles' road and marking
   * materials – 'ground' needs their vFsMat), 'building' (both building
   * materials), 'struct' (bridges, walls), and the trees: 'deciduous'
   * (broadleaf trees, bushes), 'orchard' (fruit and garden trees: blossom),
   * 'evergreen' (conifers) – vertex-coloured, green crowns, brown trunks.
   */
  patch(material: THREE.Material, target: SeasonTarget): void {
    if (this.patched.has(material)) return;
    this.patched.set(material, target);
    const tree = target === 'deciduous' || target === 'orchard' || target === 'evergreen';
    if (tree) this.trees.push(material);
    const prevCompile = material.onBeforeCompile;
    // the program's key: the material's own one (its onBeforeCompile's text, unless it has a key of its own) and ours
    const own = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey');
    const ownKey = own ? material.customProgramCacheKey.bind(material) : null;
    const plainKey = own ? '' : prevCompile.toString();
    const u = this.uniforms;
    material.onBeforeCompile = (shader, renderer) => {
      prevCompile.call(material, shader, renderer);
      Object.assign(shader.uniforms, u);
      let vs = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${SEASON_VERT_PARS}${tree ? 'varying float vFsLeafCover;\n' : ''}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${SEASON_VERT_WORLD}`);
      let fs = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${SEASON_FRAG_PARS}${tree ? 'varying float vFsLeafCover;\n' : ''}`)
        .replace('#include <emissivemap_fragment>', `${seasonFragment(target)}\n#include <emissivemap_fragment>`);
      if (tree) {
        vs = vs.replace('#include <color_vertex>', `#include <color_vertex>\n${treeVertex(target)}`);
        fs = (this.thin && target !== 'evergreen' ? '#define FS_THIN\n' : '') + fs.replace('#include <alphatest_fragment>', `#include <alphatest_fragment>\n${THIN_FRAG}`);
      }
      shader.vertexShader = vs;
      shader.fragmentShader = fs;
    };
    material.customProgramCacheKey = () => `${ownKey ? ownKey() : plainKey}|fs-season-${target}${tree && this.thin && target !== 'evergreen' ? '-thin' : ''}`;
    material.needsUpdate = true;
  }
}
