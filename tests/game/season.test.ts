// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The seasons: what the date (the game's clock) makes of the trees, the
 * ground and the snow; the seasons the player picks; summer as the land was
 * always drawn; the colours of the ground, the crowns and the snow (the pure
 * mirrors of the shaders); snow from the real weather; grip with snow on the
 * road; and the materials taught the seasons.
 *
 *   node --test tests/game/season.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { makePolyline } from '../../src/core/geom.ts';
import { seasonOf } from '../../src/game/clock.ts';
import { FIXED_WEATHER, climateWeather, gripFactor, weatherFromOpenMeteo } from '../../src/game/weather.ts';
import { SEASON_PRESETS, SEASON_SETTINGS, SeasonLook, coverColor, coverPalette, crownLook, dayOfYear, isSeasonSetting, seasonAt, seasonFor, seasonGround, snowCover } from '../../src/render/season.ts';
import { HALF_TRACK, SnowTracks } from '../../src/render/snowtracks.ts';
import { COVER, COVER_COLORS } from '../../src/world/cover.ts';
import type { Lane } from '../../src/world/lanes.ts';

/** linear RGB of an sRGB hex colour, as the shaders see it */
function lin(hex: number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}
function rgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}
function saturation(hex: number): number {
  const c = rgb(hex);
  return (Math.max(...c) - Math.min(...c)) / Math.max(...c);
}

test('the season by the date: leaves, blossom, autumn colours, snow – and its name is the clock\'s', () => {
  const jan = seasonAt(new Date(2027, 0, 15));
  assert.equal(jan.season, 'winter');
  assert.equal(jan.leaves, 0);
  assert.equal(jan.dormant, 1);
  assert.equal(jan.snow, 1, 'a typical winter');
  assert.equal(seasonAt(new Date(2027, 0, 15), false).snow, 0, 'unless the real weather says how much');
  const apr = seasonAt(new Date(2027, 3, 22));
  assert.equal(apr.season, 'spring');
  assert.ok(apr.blossom > 0.8 && apr.spring > 0.8, JSON.stringify(apr));
  assert.ok(apr.leaves > 0.05 && apr.leaves < 0.8);
  assert.equal(apr.snow, 0);
  const jul = seasonAt(new Date(2027, 6, 15));
  assert.deepEqual({ ...jul }, { season: 'summer', leaves: 1, spring: 0, blossom: 0, autumn: 0, dormant: 0, snow: 0, roadSnow: 0 });
  const oct = seasonAt(new Date(2026, 9, 20));
  assert.equal(oct.season, 'autumn');
  assert.ok(oct.autumn > 0.8 && oct.leaves > 0.8, JSON.stringify(oct));
  const lateNov = seasonAt(new Date(2026, 10, 25));
  assert.equal(lateNov.leaves, 0);
  assert.equal(lateNov.autumn, 1);
  // every day of a year: the name is the game clock's, the values within 0 … 1
  for (let d = 0; d < 365; d++) {
    const date = new Date(2027, 0, 1 + d);
    const s = seasonAt(date);
    assert.equal(s.season, seasonOf(date));
    assert.equal(dayOfYear(date), d + 1);
    for (const k of ['leaves', 'spring', 'blossom', 'autumn', 'dormant', 'snow', 'roadSnow'] as const) assert.ok(s[k] >= 0 && s[k] <= 1, `${date.toDateString()} ${k}`);
  }
});

test('summer is the land as it was always drawn', () => {
  assert.deepEqual(coverPalette(SEASON_PRESETS.summer), [...COVER_COLORS]);
  assert.deepEqual(coverPalette(seasonAt(new Date(2027, 6, 15))), [...COVER_COLORS]);
  for (const r1 of [0, 0.4, 0.9]) {
    for (const kind of ['deciduous', 'orchard', 'evergreen'] as const) {
      const c = crownLook(SEASON_PRESETS.summer, kind, r1, 1 - r1);
      assert.deepEqual(c.tint, [1, 1, 1]);
      assert.equal(c.cover, 1);
    }
  }
  for (const s of SEASON_SETTINGS) assert.ok(isSeasonSetting(s));
  assert.ok(!isSeasonSetting('monsoon'));
});

test('spring: fresher green, young crops on the fields, fruit trees in blossom', () => {
  const sp = SEASON_PRESETS.spring;
  const meadow = rgb(coverColor(COVER.MEADOW, sp));
  const summerMeadow = rgb(COVER_COLORS[COVER.MEADOW]);
  assert.ok(meadow[1] > summerMeadow[1], 'greener');
  const field = rgb(coverColor(COVER.FARMLAND, sp));
  assert.ok(field[1] > field[0], `young crops: ${field}`);
  const bloom = crownLook(sp, 'orchard', 0.5, 0.5, true);
  assert.ok(bloom.tint[2] > bloom.tint[1] && bloom.tint[0] > bloom.tint[1] && bloom.tint[1] > 2, `white-pink: ${bloom.tint}`);
  assert.deepEqual(crownLook(sp, 'orchard', 0.5, 0.5, false).tint, crownLook(sp, 'deciduous', 0.5, 0.5).tint, 'between the blossoms: the leaves');
  assert.ok(crownLook(sp, 'deciduous', 0.9, 0.5).tint[1] > 2, 'now and then another tree blooms');
});

test('autumn: yellow, orange, red and brown crowns, each tree its own; ploughed fields; streets and water stay', () => {
  const au = SEASON_PRESETS.autumn;
  const tints = [0.1, 0.5, 0.75, 0.95].map((r2) => crownLook(au, 'deciduous', 0.1, r2).tint);
  for (const t of tints) assert.ok(t[0] > t[1] * 1.3, `turned: ${t}`);
  assert.equal(new Set(tints.map((t) => t.join())).size, 4, 'four colours');
  const field = rgb(coverColor(COVER.FARMLAND, au));
  const summerField = rgb(COVER_COLORS[COVER.FARMLAND]);
  assert.ok(field[0] / field[1] > summerField[0] / summerField[1] && field[1] < summerField[1], `browner: ${field}`);
  for (const season of [SEASON_PRESETS.spring, au, SEASON_PRESETS.winter]) {
    for (const cls of [COVER.ASPHALT, COVER.PAVED, COVER.WATER, COVER.COMMERCIAL, COVER.INDUSTRIAL, COVER.RAILWAY]) assert.equal(coverColor(cls, season), COVER_COLORS[cls], `class ${cls} in ${season.season}`);
  }
  assert.deepEqual(crownLook(au, 'evergreen', 0.3, 0.3).tint, [1, 1, 1], 'conifers keep their green');
});

test('winter: bare crowns (the twigs, seen through), dull grass, brown fields, leaf litter on the forest floor', () => {
  const wi = SEASON_PRESETS.winter;
  for (const kind of ['deciduous', 'orchard'] as const) {
    const c = crownLook(wi, kind, 0.5, 0.5);
    assert.equal(c.cover, 1, 'the twigs: a soft grey-brown mass, not speckles against the sky');
    assert.ok(c.tint[0] > c.tint[1], `grey-brown twigs: ${c.tint}`);
  }
  assert.equal(crownLook(wi, 'evergreen', 0.5, 0.5).cover, 1);
  assert.ok(saturation(coverColor(COVER.MEADOW, wi)) < saturation(COVER_COLORS[COVER.MEADOW]), 'duller grass');
  const floor = rgb(coverColor(COVER.FOREST, wi));
  assert.ok(floor[0] > rgb(COVER_COLORS[COVER.FOREST])[0], `litter: ${floor}`);
  // the pure function and the palette agree
  const g = seasonGround(lin(COVER_COLORS[COVER.MEADOW]), wi);
  assert.equal(new THREE.Color().setRGB(g[0], g[1], g[2]).getHex(), coverColor(COVER.MEADOW, wi));
});

test('snow lies on what faces the sky, in patches where it is thin', () => {
  assert.equal(snowCover(0, 1, 0.55, 0.8, 0.9), 0);
  for (const n of [0, 0.3, 0.7, 1]) assert.equal(snowCover(1, 1, 0.55, 0.8, n), 1, 'all white');
  assert.equal(snowCover(1, 0, 0.55, 0.8, 0.5), 0, 'not on a wall');
  assert.equal(snowCover(1, 0.7, 0.4, 0.65, 0.5), 1, 'a pitched roof holds it');
  assert.equal(snowCover(1, 0.7, 0.55, 0.8, 0.5) < 1, true, 'a steep bank less');
  const thin = [0.1, 0.3, 0.5, 0.7, 0.9].map((n) => snowCover(0.5, 1, 0.55, 0.8, n));
  assert.ok(thin[0] === 0 && thin[4] === 1, `patches: ${thin}`);
  for (let i = 1; i < thin.length; i++) assert.ok(thin[i] >= thin[i - 1]);
});

test('the season to show: chosen or by the game\'s day; snow from the real weather, falling snow settles; grip on a snowy road', () => {
  const jan = new Date(2027, 0, 15);
  const winter = seasonFor('winter', null, new Date(2027, 6, 1));
  assert.equal(winter.snow, 1);
  assert.equal(winter.roadSnow, 0.7);
  assert.equal(winter.season, 'winter', 'chosen: whatever the date');
  assert.ok(gripFactor(FIXED_WEATHER.clear, winter.roadSnow) <= 0.65);
  assert.equal(seasonFor('real', null, jan).snow, 1, 'no real weather: a typical winter');
  const green = weatherFromOpenMeteo({ weather_code: 3, cloud_cover: 90, temperature_2m: 2, snow_depth: 0 });
  assert.equal(green.source, 'real');
  assert.equal(seasonFor('real', green, jan).snow, 0, 'the real weather says: no snow lies');
  const white = weatherFromOpenMeteo({ weather_code: 3, cloud_cover: 90, temperature_2m: -2, snow_depth: 0.05 });
  const s = seasonFor('real', white, jan);
  assert.equal(s.snow, 1);
  assert.ok(Math.abs(s.roadSnow - 0.7) < 1e-12);
  const thaw = seasonFor('real', weatherFromOpenMeteo({ weather_code: 3, temperature_2m: 6, snow_depth: 0.05 }), jan);
  assert.ok(thaw.roadSnow < 0.3, 'a thaw clears the roads first');
  // the climate (a moment beyond the forecast) is no real report: a typical winter
  assert.equal(seasonFor('real', climateWeather(jan.getTime()), jan).snow, 1);
  // snow falling in July settles; on the road as well when it freezes
  const july = seasonFor('real', FIXED_WEATHER.snow, new Date(2027, 6, 15));
  assert.ok(july.snow >= 0.75 && july.roadSnow >= 0.5, JSON.stringify(july));
  assert.equal(july.leaves, 1, 'the trees keep their leaves');
  assert.equal(seasonFor('summer', FIXED_WEATHER.rain).snow, 0);
  // without a date: the game's clock
  assert.equal(seasonFor('real').season, seasonOf(new Date()));
});

test('the materials: taught once, a uniform per season – the trees compiled anew only when their crowns get thin', () => {
  const look = new SeasonLook();
  const terrain = new THREE.MeshLambertMaterial();
  terrain.customProgramCacheKey = () => 'fs-terrain';
  const tree = new THREE.MeshLambertMaterial({ vertexColors: true });
  look.patch(terrain, 'terrain');
  look.patch(terrain, 'terrain');
  look.patch(tree, 'deciduous');
  assert.equal(terrain.customProgramCacheKey(), 'fs-terrain|fs-season-terrain');
  assert.ok(tree.customProgramCacheKey().endsWith('|fs-season-deciduous'));
  const shader = (m: THREE.Material) => {
    const s = { vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(s, null as unknown as THREE.WebGLRenderer);
    return s;
  };
  const t = shader(terrain);
  assert.ok(t.fragmentShader.includes('fsSeasonGround(diffuseColor.rgb)') && t.fragmentShader.includes('fsSnowCover('));
  assert.ok(t.vertexShader.includes('vFsSeasonXZ ='));
  assert.equal(t.uniforms.uFsSnow, look.uniforms.uFsSnow, 'shared uniforms');
  const leafy = shader(tree);
  assert.ok(leafy.vertexShader.includes('fsCrown') && !leafy.fragmentShader.includes('#define FS_THIN'));
  // winter: uniforms, and the trees once more
  const v = tree.version;
  const vt = terrain.version;
  look.set(SEASON_PRESETS.winter);
  assert.equal(look.uniforms.uFsSnow.value, 1);
  assert.equal(look.uniforms.uFsLeaves.value, 0);
  assert.ok(look.thinCrowns);
  assert.ok(tree.version > v && terrain.version === vt);
  assert.ok(tree.customProgramCacheKey().endsWith('-thin'));
  assert.ok(shader(tree).fragmentShader.includes('#define FS_THIN'));
  look.set(SEASON_PRESETS.autumn);
  const v2 = tree.version;
  look.set(SEASON_PRESETS.winter);
  assert.equal(tree.version, v2, 'thin already: nothing to compile');
  look.set(SEASON_PRESETS.summer);
  assert.ok(!look.thinCrowns && !tree.customProgramCacheKey().endsWith('-thin'));
});

test('wheel tracks in the snow: two soft strips along each lane near the camera, only while snow lies on the road', () => {
  // a lane 400 m long running east at 200 m above the sea, its middle 1.75 m south of the road's
  const pl = makePolyline([0, 200, 0, 400, 200, 0]);
  const lane = { s0: 0, s1: 400, dir: 1, len: 400, off: -1.75, edge: { pl, flags: 0, minX: 0, maxX: 400, minZ: -5, maxZ: 5 } } as unknown as Lane;
  const tunnel = { ...lane, edge: { ...lane.edge, flags: 2 } } as unknown as Lane;
  const elsewhere = { ...lane, edge: { ...lane.edge, minX: 5000, maxX: 5400 } } as unknown as Lane;
  const tracks = new SnowTracks();
  tracks.update(100, 0, [lane]);
  assert.equal(tracks.mesh.visible, false);
  assert.equal(tracks.mesh.geometry.index, null, 'nothing built without snow on the road');
  tracks.amount = SEASON_PRESETS.winter.roadSnow;
  // (the camera above the lane's middle line)
  tracks.update(100, 1.75, [lane, tunnel, elsewhere, undefined]);
  assert.ok(tracks.mesh.visible);
  assert.ok(Math.abs(tracks.mesh.material.opacity - 0.63) < 1e-9);
  const g = tracks.mesh.geometry;
  const p = g.getAttribute('position');
  // within 184 m of the camera: x = 0 … 284, a point every 4 m – six vertices each (two tracks, three across)
  assert.equal(p.count, 72 * 6, 'not in the tunnel, not far away');
  assert.equal(g.index?.count, 71 * 2 * 2 * 6);
  const offsets = new Set<string>();
  for (let i = 0; i < p.count; i++) {
    assert.ok(Math.abs(p.getY(i) - 200.03) < 1e-4);
    assert.ok(p.getX(i) >= 0 && p.getX(i) <= 284.001);
    offsets.add(Math.abs(p.getZ(i) - 1.75).toFixed(2));
  }
  assert.deepEqual([...offsets].sort(), [(HALF_TRACK - 0.26).toFixed(2), HALF_TRACK.toFixed(2), (HALF_TRACK + 0.26).toFixed(2)]);
  const alpha = g.getAttribute('color');
  assert.equal(alpha.itemSize, 4);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => alpha.getW(i)), [0, 1, 0, 0, 1, 0], 'soft edges');
  // a few metres on: nothing rebuilt; far on: laid anew
  tracks.update(120, 0, [lane]);
  assert.equal(tracks.mesh.geometry, g);
  tracks.update(250, 0, [lane]);
  assert.notEqual(tracks.mesh.geometry, g);
  tracks.amount = 0;
  tracks.update(250, 0, [lane]);
  assert.equal(tracks.mesh.visible, false);
  tracks.dispose();
});
