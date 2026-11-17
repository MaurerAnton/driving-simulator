// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The weather: Open-Meteo's answer read as the game's weather (every WMO code
 * 0–99), the weather the player picks, what is left of the tyres' grip, how
 * often the real weather is asked for (with a fake fetch and a fake clock),
 * the forecast at another moment of the game's clock and the climate beyond
 * it, the weather "now" for the rest of the game, and what the renderer makes
 * of it (fog, light, particles – without a graphics chip).
 *
 *   node --test tests/game/weather.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  CLEAR_WEATHER,
  FIXED_WEATHER,
  RealWeather,
  WEATHER_ATTRIBUTION,
  WEATHER_KINDS,
  WEATHER_SETTINGS,
  climateWeather,
  gripFactor,
  isRaining,
  isWeatherSetting,
  parseOpenMeteo,
  parseOpenMeteoHourly,
  rainIntensity,
  setWeatherNow,
  snowIntensity,
  snowOnGround,
  weatherFor,
  weatherFromOpenMeteo,
  weatherNow,
  weatherUrl,
  windSpeed,
  windVector,
} from '../../src/game/weather.ts';
import type { OpenMeteoCurrent, WeatherFetch, WeatherState } from '../../src/game/weather.ts';
import { WeatherRenderer, weatherFog } from '../../src/render/weather.ts';
import { Outdoors } from '../../src/game/outdoors.ts';
import { worldToLatLon } from '../../src/geo/utm.ts';

const HOUR = 3600_000;

/** an answer's current block: overcast, 8 °C, 20 km, a light wind – and what is given */
function cur(code: number, extra: OpenMeteoCurrent = {}): WeatherState {
  return weatherFromOpenMeteo({ interval: 900, weather_code: code, temperature_2m: 8, cloud_cover: 95, visibility: 20000, wind_speed_10m: 3, wind_direction_10m: 240, is_day: 1, precipitation: 0, snowfall: 0, ...extra });
}

test('every WMO code 0–99 at any temperature gives a sound weather', () => {
  for (let code = 0; code <= 99; code++) {
    for (const temperature_2m of [-6, 0.5, 9]) {
      const s = cur(code, { temperature_2m });
      const at = `code ${code} at ${temperature_2m} °C`;
      assert.ok(WEATHER_KINDS.includes(s.kind), at);
      assert.equal(s.code, code, at);
      for (const k of ['intensity', 'cloud', 'wet', 'ice'] as const) assert.ok(s[k] >= 0 && s[k] <= 1, `${at}: ${k} ${s[k]}`);
      assert.ok(s.visibility >= 30 && s.visibility <= 50000, `${at}: visibility ${s.visibility}`);
      assert.ok(s.wind >= 0 && s.gust >= s.wind && s.windFrom >= 0 && s.windFrom < 360, at);
      assert.equal(s.source, 'real');
      const falls = s.kind === 'drizzle' || s.kind === 'rain' || s.kind === 'snow';
      assert.equal(falls, s.intensity > 0 && s.kind !== 'fog' && s.kind !== 'storm', at);
      const g = gripFactor(s);
      assert.ok(g >= 0.25 && g <= 1, `${at}: grip ${g}`);
    }
  }
});

test('the codes read as their words say: clear, cloudy, fog, drizzle, rain, snow, showers, thunderstorms', () => {
  assert.equal(cur(0, { cloud_cover: 5 }).kind, 'clear');
  assert.equal(cur(2, { cloud_cover: 50 }).kind, 'clear');
  assert.equal(cur(3, { cloud_cover: 100 }).kind, 'cloudy');
  const fog = cur(45);
  assert.equal(fog.kind, 'fog');
  assert.ok(fog.visibility <= 400, `fog: ${fog.visibility} m`);
  assert.ok(cur(48, { temperature_2m: -3 }).ice > 0, 'rime fog leaves ice');
  const steps = (codes: number[], kind: string): void => {
    const s = codes.map((c) => cur(c));
    for (const x of s) assert.equal(x.kind, kind, `${x.code}`);
    for (let i = 1; i < s.length; i++) assert.ok(s[i].intensity > s[i - 1].intensity, `${s[i].code} harder than ${s[i - 1].code}`);
  };
  steps([51, 53, 55], 'drizzle');
  steps([61, 63, 65], 'rain');
  steps([71, 73, 75], 'snow');
  steps([80, 81, 82], 'rain');
  steps([85, 86], 'snow');
  assert.equal(cur(77).kind, 'snow');
  for (const c of [56, 57, 66, 67]) {
    assert.equal(cur(c).ice, 1, `freezing ${c}`);
    assert.ok(gripFactor(cur(c)) <= 0.3 + 1e-9, `glaze ice ${c}`);
  }
  for (const c of [95, 96, 99]) assert.equal(cur(c).kind, 'storm');
  assert.equal(cur(99).intensity, 1);
  // rain and snow mixed: whichever it looks more like
  for (const c of [68, 69, 83, 84]) {
    assert.equal(cur(c, { temperature_2m: -2 }).kind, 'snow', `${c} cold`);
    assert.equal(cur(c, { temperature_2m: 6 }).kind, 'rain', `${c} mild`);
  }
  // it rained in the last hour, it does not now: the road is still wet
  const after = cur(21);
  assert.equal(after.kind, 'cloudy');
  assert.equal(after.intensity, 0);
  assert.ok(after.wet >= 0.5);
  // thunder without rain
  const dry = cur(17);
  assert.equal(dry.kind, 'storm');
  assert.equal(dry.intensity, 0);
});

test('the amounts say how hard: the sum of a quarter hour, of an hour, and no code at all', () => {
  assert.equal(cur(61).intensity, 0.3, 'nothing measured: as the code words it');
  const pour = cur(61, { precipitation: 2.4 }); // 9.6 mm/h
  assert.ok(pour.intensity >= 0.75, `${pour.intensity}`);
  const hourly = cur(61, { precipitation: 2.4, interval: 3600 }); // 2.4 mm/h
  assert.ok(hourly.intensity < pour.intensity && hourly.intensity > 0.3);
  // no code: by the amounts
  assert.equal(weatherFromOpenMeteo({ precipitation: 1, temperature_2m: 6 }).kind, 'rain');
  assert.equal(weatherFromOpenMeteo({ precipitation: 0.5, snowfall: 0.7, temperature_2m: -1 }).kind, 'snow');
  // nothing at all: plausible defaults
  const none = weatherFromOpenMeteo({});
  assert.equal(none.kind, 'clear');
  assert.equal(none.code, -1);
  assert.equal(none.temperature, 10);
  assert.equal(none.isDay, true);
  assert.equal(none.snowDepth, 0);
  assert.equal(parseOpenMeteo({ nothing: 1 }), null);
  assert.equal(parseOpenMeteo(null), null);
  assert.equal(parseOpenMeteo({ current: { weather_code: 63 } })?.kind, 'rain');
});

test('how far one sees: the model\'s number within what fog, rain and snow allow', () => {
  const misty = cur(3, { visibility: 400 });
  assert.equal(misty.kind, 'fog', 'a dry sky with 400 m is fog');
  assert.equal(misty.visibility, 400);
  assert.ok(cur(75, { visibility: 30000 }).visibility <= 600, 'heavy snow');
  assert.ok(cur(65, { visibility: 30000 }).visibility <= 3000, 'heavy rain');
  assert.equal(weatherFromOpenMeteo({ weather_code: 0 }).visibility, 25000);
  assert.equal(cur(0, { visibility: 5 }).visibility, 30, 'never below 30 m');
});

test('the request: the place rounded to 0.1°, the ground height to 10 m – nothing else; hour by hour for another moment', () => {
  const url = new URL(weatherUrl(51.2834, 9.4612, 172.4));
  assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(url.searchParams.get('latitude'), '51.3');
  assert.equal(url.searchParams.get('longitude'), '9.5');
  assert.equal(url.searchParams.get('elevation'), '170');
  assert.equal(url.searchParams.get('wind_speed_unit'), 'ms');
  assert.ok(url.searchParams.get('current')?.includes('weather_code'));
  assert.deepEqual([...url.searchParams.keys()].sort(), ['current', 'elevation', 'latitude', 'longitude', 'timezone', 'wind_speed_unit']);
  assert.equal(new URL(weatherUrl(51.3, 9.4)).searchParams.get('elevation'), null);
  const hours = new URL(weatherUrl(51.3, 9.4, undefined, { from: Date.UTC(2026, 10, 25, 14, 20), to: Date.UTC(2026, 10, 26, 15) }));
  assert.equal(hours.searchParams.get('start_hour'), '2026-11-25T14:00');
  assert.equal(hours.searchParams.get('end_hour'), '2026-11-26T15:00');
  assert.equal(hours.searchParams.get('timeformat'), 'unixtime');
  assert.equal(hours.searchParams.get('current'), null);
  assert.ok(hours.searchParams.get('hourly')?.includes('snow_depth'));
  assert.equal(WEATHER_ATTRIBUTION.text, 'Weather data by Open-Meteo.com');
  assert.equal(WEATHER_ATTRIBUTION.url, 'https://open-meteo.com/');
});

test('the weather the player picks needs no network and never changes', () => {
  let calls = 0;
  const real = new RealWeather({ fetch: async () => (calls++, { ok: true, json: async () => ({}) }) });
  for (const setting of WEATHER_SETTINGS) {
    assert.ok(isWeatherSetting(setting));
    if (setting === 'real') continue;
    const s = weatherFor(setting, real);
    assert.equal(s, setting === 'off' ? CLEAR_WEATHER : FIXED_WEATHER[setting]);
    assert.ok(Object.isFrozen(s));
    assert.equal(s.source, setting === 'off' ? 'none' : 'fixed');
  }
  assert.equal(calls, 0);
  assert.ok(!isWeatherSetting('hail'));
  assert.equal(FIXED_WEATHER.fog.visibility, 120);
  assert.equal(FIXED_WEATHER.snow.kind, 'snow');
  assert.ok(FIXED_WEATHER.rain.wet > 0.8);
});

test('grip: a wet road about 0.8, snow about 0.5, glaze ice 0.3, snow on the road down to 0.5', () => {
  assert.equal(gripFactor(FIXED_WEATHER.clear), 1);
  assert.equal(gripFactor(FIXED_WEATHER.cloudy), 1);
  const rain = gripFactor(FIXED_WEATHER.rain);
  assert.ok(rain > 0.7 && rain < 0.85, `rain ${rain}`);
  const snow = gripFactor(FIXED_WEATHER.snow);
  assert.ok(snow >= 0.4 && snow <= 0.55, `snow ${snow}`);
  assert.ok(gripFactor(FIXED_WEATHER.storm) < rain);
  assert.ok(gripFactor(FIXED_WEATHER.drizzle) > rain);
  assert.ok(gripFactor(FIXED_WEATHER.fog) > 0.9 && gripFactor(FIXED_WEATHER.fog) < 1);
  assert.equal(gripFactor(FIXED_WEATHER.clear, 1), 0.5);
  assert.ok(gripFactor(FIXED_WEATHER.clear, 0.5) > gripFactor(FIXED_WEATHER.clear, 1));
  assert.equal(gripFactor(FIXED_WEATHER.clear, NaN), 1);
  // harder rain, less grip
  let last = 1;
  for (const precipitation of [0, 0.5, 1, 2, 4]) {
    const g = gripFactor(cur(61, { precipitation }));
    assert.ok(g <= last, `${precipitation} mm`);
    last = g;
  }
});

test('the wind blows from where the report says to the other side', () => {
  const v = { x: 0, z: 0 };
  windVector({ ...FIXED_WEATHER.clear, wind: 4, windFrom: 0 }, v);
  assert.ok(Math.abs(v.x) < 1e-9 && Math.abs(v.z - 4) < 1e-9, 'from the north: to the south (+z)');
  windVector({ ...FIXED_WEATHER.clear, wind: 4, windFrom: 270 }, v);
  assert.ok(Math.abs(v.x - 4) < 1e-9 && Math.abs(v.z) < 1e-9, 'from the west: to the east (+x)');
});

/** a fake service: the current weather, or hours from start_hour on */
function service(answer: () => 'ok' | 'offline' | 'error' | 'refuse' | 'garbage' | 'empty', urls: string[], inits: RequestInit[]): WeatherFetch {
  return async (url, init) => {
    urls.push(url);
    inits.push(init);
    const a = answer();
    if (a === 'offline') throw new TypeError('Failed to fetch');
    if (a === 'error') return { ok: false, status: 503, json: async () => ({}) };
    if (a === 'refuse') return { ok: false, status: 400, json: async () => ({ error: true }) };
    if (a === 'garbage') return { ok: true, json: async () => ({ hello: 'world' }) };
    const u = new URL(url);
    const start = u.searchParams.get('start_hour');
    if (!start) return { ok: true, json: async () => ({ current: { interval: 900, weather_code: 63, precipitation: 1, temperature_2m: 9, cloud_cover: 100, snow_depth: 0 } }) };
    const from = Date.parse(`${start}:00Z`) / 1000;
    const to = Date.parse(`${u.searchParams.get('end_hour')}:00Z`) / 1000;
    const time: number[] = [];
    for (let t = from; t <= to; t += 3600) time.push(t);
    // overcast in the first hour, snow from the second on (empty: the service kept nothing of those hours)
    const val = (f: (i: number) => number): Array<number | null> => time.map((_, i) => (a === 'empty' ? null : f(i)));
    return { ok: true, json: async () => ({ hourly: { time, weather_code: val((i) => (i < 1 ? 3 : 73)), temperature_2m: val(() => -1), cloud_cover: val(() => 100), precipitation: val((i) => (i < 1 ? 0 : 1)), snowfall: val((i) => (i < 1 ? 0 : 1.2)), snow_depth: val((i) => i * 0.01), is_day: val(() => 1) } }) };
  };
}

test('the real weather: asked for only when the game asks, at most every 15 minutes, one at a time, failures quiet', async () => {
  let t = Date.UTC(2026, 10, 16, 12);
  let answer: 'ok' | 'offline' | 'error' | 'garbage' = 'ok';
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const real = new RealWeather({ fetch: service(() => answer, urls, inits), now: () => t });
  assert.equal(real.current(), null);
  assert.equal(weatherFor('real', real), CLEAR_WEATHER, 'nothing yet: clear');
  assert.ok(real.due());
  const p = real.request(51.2834, 9.4612, 172);
  assert.ok(p);
  assert.ok(real.pending);
  assert.equal(real.request(51.3, 9.4), null, 'one at a time');
  const s = await p;
  assert.equal(s?.kind, 'rain');
  assert.equal(weatherFor('real', real).kind, 'rain');
  assert.equal(urls.length, 1);
  // nothing about the player goes with it
  assert.match(urls[0], /latitude=51\.3&longitude=9\.5&/);
  assert.equal(inits[0].credentials, 'omit');
  assert.equal(inits[0].referrerPolicy, 'no-referrer');
  assert.equal(inits[0].cache, 'no-store');
  // within 15 minutes nothing more, however often the game asks
  for (let i = 0; i < 22; i++) {
    t += 40_000;
    assert.equal(real.request(51.3, 9.4), null);
  }
  assert.equal(urls.length, 1);
  t += 80_000; // 16 min
  for (const failure of ['offline', 'error', 'garbage'] as const) {
    answer = failure;
    const q = real.request(51.3, 9.4);
    assert.ok(q, failure);
    assert.equal(await q, null, failure);
    assert.equal(real.current()?.kind, 'rain', `${failure}: the last answer stays`);
    t += 60_000;
    assert.equal(real.request(51.3, 9.4), null, `${failure}: not again sooner`);
    t += 15 * 60_000;
  }
  assert.equal(urls.length, 4);
  // two hours without an answer: too old – clear
  t += 2 * HOUR;
  assert.equal(real.current(), null);
  assert.equal(weatherFor('real', real), CLEAR_WEATHER);
  assert.equal(real.requests, 4);
});

test('no answer in time: the request ends quietly after the timeout', async () => {
  let aborted = false;
  const hang: WeatherFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    });
  const real = new RealWeather({ fetch: hang, timeoutMs: 30 });
  const t0 = Date.now();
  assert.equal(await real.request(51.3, 9.4), null);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(aborted, 'the request was called off');
  assert.ok(!real.pending);
  // and a fetch that ignores the signal still ends
  const deaf = new RealWeather({ fetch: () => new Promise(() => {}), timeoutMs: 30 });
  assert.equal(await deaf.request(51.3, 9.4), null);
});

test('at another moment of the game clock: the forecast for that hour; beyond its reach the climate', async () => {
  let t = Date.UTC(2026, 10, 16, 12);
  let answer: 'ok' | 'refuse' | 'empty' = 'ok';
  const urls: string[] = [];
  const real = new RealWeather({ fetch: service(() => answer, urls, []), now: () => t });
  // in four days, at ten past three
  const at = Date.UTC(2026, 10, 20, 15, 10);
  assert.ok(real.covers(at));
  assert.ok(real.due(at));
  const s = await real.request(51.3, 9.4, 170, at);
  const u = new URL(urls[0]);
  assert.equal(u.searchParams.get('start_hour'), '2026-11-20T14:00', 'from the hour before');
  assert.equal(u.searchParams.get('end_hour'), '2026-11-21T15:00', 'a day on');
  // the nearest hour, 15:00, is the answer's second: snow
  assert.equal(s?.kind, 'snow');
  assert.equal(weatherFor('real', real, at), s);
  assert.equal(weatherFor('real', real, Date.UTC(2026, 10, 20, 14, 5)).kind, 'cloudy', 'the hour before: still dry');
  assert.equal(weatherFor('real', real).kind, 'clear', 'the real now is the current weather – not asked yet');
  // the clock runs on within the hours fetched: nothing new for 15 minutes
  t += 2 * 60_000;
  assert.equal(real.request(51.3, 9.4, 170, at + 3 * HOUR), null);
  assert.equal(weatherFor('real', real, at + 3 * HOUR).kind, 'snow');
  // another moment: soon (a minute after the last request), not at once
  const later = Date.UTC(2026, 10, 25, 9);
  t += 30_000;
  assert.ok(real.due(later), 'more than a minute since the last');
  answer = 'empty';
  // the past beyond what the service kept: answered without data – the climate
  const past = Date.UTC(2026, 9, 1, 12);
  assert.equal(await real.request(51.3, 9.4, 170, past), null);
  assert.ok(!real.covers(past));
  assert.equal(weatherFor('real', real, past), climateWeather(past));
  // beyond the forecast: nothing is asked, the climate is shown
  const far = Date.UTC(2027, 0, 20, 14);
  t += 5 * 60_000;
  assert.ok(!real.covers(far));
  assert.ok(!real.due(far));
  assert.equal(real.request(51.3, 9.4, 170, far), null);
  const c = weatherFor('real', real, far);
  assert.equal(c.source, 'climate');
  assert.equal(c, climateWeather(far));
  // a refusal (a moment the service will not answer) counts as no data too
  answer = 'refuse';
  t += 5 * 60_000;
  const soon = Date.UTC(2026, 10, 28, 8);
  assert.equal(await real.request(51.3, 9.4, 170, soon), null);
  assert.ok(!real.covers(soon));
  assert.equal(weatherFor('real', real, soon).source, 'climate');
  // back at the real time: the current weather
  answer = 'ok';
  assert.equal((await real.request(51.3, 9.4, 170))?.kind, 'rain');
  assert.equal(weatherFor('real', real).kind, 'rain');
  assert.equal(weatherFor('real', real, t + 5 * 60_000).kind, 'rain', 'a game clock a few minutes off is still now');
});

test('an hourly answer: hours without data are left out', () => {
  const h = parseOpenMeteoHourly({ hourly: { time: [1000, 4600, 8200], weather_code: [null, 61, 3], temperature_2m: [null, 5, 4], precipitation: [null, 1, 0] } });
  assert.deepEqual(h?.t, [4600_000, 8200_000]);
  assert.equal(h?.s[0].kind, 'rain');
  assert.equal(h?.s[1].kind, 'cloudy');
  assert.equal(parseOpenMeteoHourly({ hourly: { time: [1000], weather_code: [null], temperature_2m: [null] } }), null);
  assert.equal(parseOpenMeteoHourly({ current: {} }), null);
  assert.equal(parseOpenMeteoHourly('nonsense'), null);
});

test('the climate: a typical hour of the season round Kassel, the same object for the same hour', () => {
  const jan = climateWeather(Date.UTC(2027, 0, 15, 14));
  const jul = climateWeather(Date.UTC(2027, 6, 15, 14));
  assert.equal(jan.source, 'climate');
  assert.equal(jan.intensity, 0);
  assert.ok(jan.temperature < 5 && jul.temperature > 15, `${jan.temperature} / ${jul.temperature} °C`);
  assert.equal(jan.kind, 'cloudy');
  assert.equal(jul.kind, 'clear');
  const a = Date.UTC(2027, 3, 10, 13, 10);
  assert.equal(climateWeather(a), climateWeather(a + 20 * 60_000), 'the same hour, the same object');
  assert.ok(climateWeather(Date.UTC(2027, 3, 10, 13)).temperature > climateWeather(Date.UTC(2027, 3, 10, 3)).temperature, 'warmer in the afternoon');
  assert.equal(climateWeather(Date.UTC(2027, 0, 15, 2)).isDay, false);
  assert.equal(climateWeather(Date.UTC(2027, 0, 15, 11)).isDay, true);
  assert.equal(weatherFor('real', null, Date.UTC(2027, 0, 15, 2)).source, 'climate', 'no service: the climate at another moment');
  assert.equal(weatherFor('real', null), CLEAR_WEATHER, 'no service now: clear');
});

test('the weather now, for the rest of the game: rain, wind, snow on the ground', () => {
  assert.equal(weatherNow(), CLEAR_WEATHER);
  assert.ok(!isRaining());
  setWeatherNow(FIXED_WEATHER.rain);
  assert.equal(weatherNow(), FIXED_WEATHER.rain);
  assert.ok(isRaining());
  assert.equal(rainIntensity(), 0.6);
  assert.equal(windSpeed(), 5);
  assert.equal(snowIntensity(), 0);
  assert.equal(snowOnGround(), 0);
  setWeatherNow(FIXED_WEATHER.drizzle);
  assert.ok(isRaining());
  setWeatherNow(FIXED_WEATHER.snow, 0.8);
  assert.ok(!isRaining());
  assert.equal(snowIntensity(), 0.55);
  assert.equal(snowOnGround(), 0.8, 'as the player sees it, with the season');
  assert.equal(snowOnGround(FIXED_WEATHER.snow), 0.75, 'of a state: 3 cm of 4');
  assert.equal(snowOnGround({ ...FIXED_WEATHER.snow, snowDepth: 0.1 }), 1);
  assert.ok(snowOnGround({ ...FIXED_WEATHER.snow, snowDepth: 0 }) > 0.5, 'falling snow settles');
  assert.equal(snowOnGround({ ...FIXED_WEATHER.snow, snowDepth: 0, temperature: 4 }), 0, 'not when it is warm');
  assert.equal(rainIntensity(FIXED_WEATHER.storm), 0.9);
  setWeatherNow(CLEAR_WEATHER);
  assert.equal(snowOnGround(), 0);
});

// ------------------------------------------------------------ the picture

test('fog: as the game sets it in clear weather, down to the visibility in fog – and starting at the camera', () => {
  const out = { near: 0, far: 0 };
  weatherFog(30000, 375, 1312.5, out);
  assert.deepEqual(out, { near: 375, far: 1312.5 });
  weatherFog(120, 375, 1312.5, out);
  assert.ok(Math.abs(out.far - 126) < 1e-9, `${out.far}`);
  assert.ok(out.near < 0);
  let lastFar = Infinity;
  for (const v of [20000, 5000, 2000, 800, 200, 50]) {
    weatherFog(v, 750, 7600, out);
    assert.ok(out.far <= lastFar && out.near < out.far);
    lastFar = out.far;
  }
});

/** the parts of render/sky.ts's Sky that the weather touches */
function fakeSky() {
  const uniforms = { uZenith: { value: new THREE.Color(0x3a74c6) }, uHorizon: { value: new THREE.Color(0xc2d3e4) }, uSunColor: { value: new THREE.Color(0xfff2d0) }, uSunDir: { value: new THREE.Vector3(0, 1, 0) } };
  return {
    fog: new THREE.Fog(0xc2d3e4, 375, 1312.5),
    sun: new THREE.DirectionalLight(0xfff4e0, 3.2),
    hemi: new THREE.HemisphereLight(0xbfd6ff, 0x6b6a55, 1.2),
    dome: new THREE.Mesh(new THREE.SphereGeometry(1, 8, 4), new THREE.ShaderMaterial({ uniforms })),
    uniforms,
  };
}

test('the renderer: rain and snow by intensity, darker light in the rain, the sky given back as it was', () => {
  const r = new WeatherRenderer(1000);
  assert.equal(r.quality, 1000);
  const [rain, snow] = r.group.children as Array<THREE.Mesh<THREE.InstancedBufferGeometry>>;
  const cam = new THREE.Vector3(100, 180, -50);
  r.jump();
  r.update(cam, 1 / 60, FIXED_WEATHER.rain);
  assert.ok(rain.visible && !snow.visible);
  assert.equal(rain.geometry.instanceCount, Math.round(1000 * (0.12 + 0.88 * 0.6)));
  assert.ok(r.look.sunFactor < 0.3 && r.look.ambientFactor > 0.9);
  assert.ok(Math.abs(r.look.visibility - 4000) < 1);
  assert.ok(r.look.wet > 0.8);
  r.jump();
  r.update(cam, 1 / 60, FIXED_WEATHER.snow);
  assert.ok(!rain.visible && snow.visible);
  assert.equal(snow.geometry.instanceCount, Math.round(600 * (0.15 + 0.85 * 0.55)));
  // fading over: the rain comes within seconds, not at once
  r.jump();
  r.update(cam, 1 / 60, FIXED_WEATHER.clear);
  assert.ok(!rain.visible && !snow.visible);
  r.update(cam, 0.1, FIXED_WEATHER.rain);
  assert.ok(r.look.rain > 0 && r.look.rain < 0.1);
  for (let i = 0; i < 300; i++) r.update(cam, 0.1, FIXED_WEATHER.rain);
  assert.ok(Math.abs(r.look.rain - 0.648) < 0.01);
  // more particles at a higher quality (a new geometry, once)
  r.quality = 3000;
  r.update(cam, 1 / 60, FIXED_WEATHER.rain);
  assert.ok(rain.geometry.instanceCount > 1900);

  // the sky
  const sky = fakeSky();
  const before = { fogColor: sky.fog.color.clone(), zenith: sky.uniforms.uZenith.value.clone(), hemi: sky.hemi.color.clone() };
  r.attachSky(sky);
  r.jump();
  r.update(cam, 1 / 60, FIXED_WEATHER.fog);
  assert.ok(Math.abs(sky.fog.far - 126) < 0.5, `fog far ${sky.fog.far}`);
  assert.ok(sky.fog.near < 0);
  assert.ok(sky.sun.intensity < 3.2 * 0.1);
  assert.ok(!sky.uniforms.uZenith.value.equals(before.zenith), 'a grey sky');
  // the game sets its own fog (applySettings): taken as the clear weather's from then on
  sky.fog.near = 600;
  sky.fog.far = 2000;
  r.update(cam, 1 / 60, FIXED_WEATHER.fog);
  assert.ok(sky.fog.far < 200);
  r.jump();
  r.update(cam, 1 / 60, FIXED_WEATHER.clear);
  assert.equal(sky.fog.near, 600);
  assert.equal(sky.fog.far, 2000);
  // given back exactly when detached
  r.jump();
  r.update(cam, 1 / 60, FIXED_WEATHER.storm);
  r.attachSky(null);
  assert.equal(sky.fog.near, 600);
  assert.equal(sky.fog.far, 2000);
  assert.equal(sky.sun.intensity, 3.2);
  assert.equal(sky.hemi.intensity, 1.2);
  assert.ok(sky.fog.color.equals(before.fogColor));
  assert.ok(sky.uniforms.uZenith.value.equals(before.zenith));
  assert.ok(sky.hemi.color.equals(before.hemi));
  r.dispose();
  assert.equal(r.group.parent, null);
});

test('a thunderstorm: lightning now and then', () => {
  const r = new WeatherRenderer(200);
  const cam = new THREE.Vector3();
  r.jump();
  let flashes = 0;
  for (let i = 0; i < 60 * 120; i++) {
    r.update(cam, 1 / 60, FIXED_WEATHER.storm);
    if (r.look.flash > 0.5) flashes++;
  }
  assert.ok(r.strikes >= 2 && r.strikes <= 40, `${r.strikes} strikes in two minutes`);
  assert.ok(flashes > 0);
  const calm = new WeatherRenderer(200);
  calm.jump();
  for (let i = 0; i < 60 * 60; i++) calm.update(cam, 1 / 60, FIXED_WEATHER.rain);
  assert.equal(calm.strikes, 0);
});

test('wet roads: a material is taught once, with a program of its own', () => {
  const r = new WeatherRenderer(100);
  const m = new THREE.MeshLambertMaterial();
  m.customProgramCacheKey = () => 'fs-ground';
  const v = m.version;
  r.addWetness(m);
  r.addWetness(m);
  assert.equal(m.customProgramCacheKey(), 'fs-ground|fs-wet');
  assert.ok(m.version > v, 'compiled anew');
  const shader = { vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
  m.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
  assert.ok(shader.fragmentShader.includes('uFsWet') && shader.vertexShader.includes('vFsWetXZ'));
  assert.ok('uFsWet' in shader.uniforms);
  r.jump();
  r.update({ x: 0, y: 0, z: 0 }, 1 / 60, FIXED_WEATHER.rain);
  assert.ok((shader.uniforms.uFsWet as { value: number }).value > 0.8);
});

test('outdoors: the weather and the season together – the picture, the grip, the weather now, the requests', async () => {
  const scene = new THREE.Scene();
  const sky = fakeSky();
  const urls: string[] = [];
  let t = Date.UTC(2027, 0, 15, 12);
  const real = new RealWeather({ fetch: service(() => 'ok', urls, []), now: () => t });
  const o = new Outdoors(scene, sky, 500, real);
  assert.ok(scene.children.includes(o.view.group) && scene.children.includes(o.tracks.mesh));
  const clock = { real: true, ms: () => t };
  const cam = new THREE.Vector3(1000, 200, -2000);
  const place = { x: 1000, y: 183, z: -2000 };
  o.update(1 / 60, cam, place, { weather: 'rain', season: 'winter' }, null, clock);
  assert.equal(o.weather, FIXED_WEATHER.rain);
  assert.equal(o.season.snow, 1);
  assert.ok(Math.abs(o.grip - 0.65) < 1e-9, `rain on a snowy road: ${o.grip}`);
  assert.equal(o.tracks.amount, 0.7);
  assert.equal(weatherNow(), FIXED_WEATHER.rain);
  assert.equal(snowOnGround(), 1);
  assert.ok(sky.fog.far < 1312.5 || sky.sun.intensity < 3.2, 'the sky follows');
  assert.equal(urls.length, 0, 'a chosen weather asks nothing');
  // the real weather, where the vehicle is
  o.update(1 / 60, cam, place, { weather: 'real', season: 'real' }, null, clock);
  assert.equal(urls.length, 1);
  const [lat, lon] = worldToLatLon(place.x, place.z);
  const u = new URL(urls[0]);
  assert.equal(u.searchParams.get('latitude'), (Math.round(lat * 10) / 10).toFixed(1));
  assert.equal(u.searchParams.get('longitude'), (Math.round(lon * 10) / 10).toFixed(1));
  assert.equal(u.searchParams.get('elevation'), '180');
  await new Promise((r) => setTimeout(r, 20));
  o.update(1 / 60, cam, place, { weather: 'real', season: 'real' }, null, clock);
  assert.equal(o.weather.kind, 'rain');
  assert.equal(o.season.snow, 0, 'January – but the real weather reports no snow lying');
  for (let i = 0; i < 100; i++) o.update(1 / 60, cam, place, { weather: 'real', season: 'real' }, null, clock);
  assert.equal(urls.length, 1, 'not again for a quarter of an hour');
  // the game clock at another moment: the forecast for that hour
  t += 2 * 60_000;
  o.update(1 / 60, cam, place, { weather: 'real', season: 'real' }, null, { real: false, ms: () => Date.UTC(2027, 0, 17, 15, 10) });
  assert.equal(urls.length, 2);
  assert.match(urls[1], /start_hour=2027-01-17T14:00/);
  o.dispose();
  assert.equal(weatherNow(), CLEAR_WEATHER);
  assert.equal(sky.fog.far, 1312.5);
  assert.equal(sky.sun.intensity, 3.2);
});
