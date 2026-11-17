// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The weather: the real one over the place the vehicle is at, or one the
 * player picks – rain, snow, fog … – which needs no network at all.
 *
 * The real weather comes from Open-Meteo (https://open-meteo.com/): free for
 * non-commercial use, no key, open to requests from any web page (CORS).
 * Its data are licensed CC BY 4.0, so wherever the game shows them it must
 * say so – WEATHER_ATTRIBUTION holds the text and the links.
 *
 * The real weather follows the game's clock (game/clock.ts): at the real time
 * the current weather; at another moment the player set, the forecast for
 * that hour (16 days ahead, about two months back); beyond that a typical
 * hour of that time of year (climateWeather).
 *
 * Only the place of the game is sent – the map's latitude and longitude
 * rounded to 0.1° (some 7 by 11 km round here) and, if given, its ground
 * height – and the hours asked for, never anything about the player: no
 * cookies, no referrer, a fixed language.  (The service does see the IP
 * address, as any server would; Open-Meteo deletes its logs after 90 days.)
 *
 * All of this is data and arithmetic: render/weather.ts draws it, the tyres
 * take gripFactor(), and any part of the game may ask weatherNow(),
 * isRaining(), windSpeed(), snowOnGround() ….
 */
import { sunAt } from './clock.ts';

export type WeatherKind = 'clear' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';
export const WEATHER_KINDS: readonly WeatherKind[] = ['clear', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'storm'];

export interface WeatherState {
  kind: WeatherKind;
  /** the WMO weather code it stands for (0 … 99; −1: none known) – for a symbol or a word in the HUD */
  code: number;
  /** how hard it rains or snows, 0 … 1 (fog: how thick; 0 when nothing falls) */
  intensity: number;
  /** share of the sky under cloud, 0 … 1 */
  cloud: number;
  /** how far one sees (m) */
  visibility: number;
  /** mean wind 10 m above the ground (m/s) */
  wind: number;
  /** the strongest gusts (m/s) */
  gust: number;
  /** compass direction the wind comes from (degrees: 0 north, 90 east), as weather reports give it */
  windFrom: number;
  /** air temperature 2 m above the ground (°C) */
  temperature: number;
  /** the sun is up (the game's own sun does not follow this) */
  isDay: boolean;
  /** how wet the road is, 0 dry … 1 streaming – it stays wet a while after the rain */
  wet: number;
  /** ice on the road, 0 … 1: freezing rain (1), rime from a freezing fog, a wet road below zero */
  ice: number;
  /** snow lying on the ground (m) – the season (render/season.ts) whitens the land by it */
  snowDepth: number;
  /** the real weather (or its forecast), one the player chose, a typical one of the season (beyond the forecast), or none to be had (offline: clear) */
  source: 'real' | 'fixed' | 'climate' | 'none';
}

/** The weather setting: none (clear), the real weather, or one of the fixed kinds. */
export type WeatherSetting = 'off' | 'real' | Exclude<WeatherKind, 'clear'>;
export const WEATHER_SETTINGS: readonly WeatherSetting[] = ['off', 'real', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'storm'];

export function isWeatherSetting(v: unknown): v is WeatherSetting {
  return typeof v === 'string' && (WEATHER_SETTINGS as readonly string[]).includes(v);
}

// ------------------------------------------------------------ fixed weather

function fixed(s: Omit<WeatherState, 'source'>, source: WeatherState['source'] = 'fixed'): WeatherState {
  return Object.freeze({ ...s, source });
}

/**
 * The weather of each kind as the player picks it: no network, always the
 * same.  (Frozen: shared, never to be changed.)
 */
export const FIXED_WEATHER: Readonly<Record<WeatherKind, WeatherState>> = Object.freeze({
  clear: fixed({ kind: 'clear', code: 0, intensity: 0, cloud: 0.1, visibility: 30000, wind: 2.5, gust: 5, windFrom: 250, temperature: 16, isDay: true, wet: 0, ice: 0, snowDepth: 0 }),
  cloudy: fixed({ kind: 'cloudy', code: 3, intensity: 0, cloud: 0.9, visibility: 20000, wind: 4, gust: 8, windFrom: 240, temperature: 11, isDay: true, wet: 0, ice: 0, snowDepth: 0 }),
  // thick enough to need the fog lamps, thin enough to drive by
  fog: fixed({ kind: 'fog', code: 45, intensity: 0.8, cloud: 1, visibility: 120, wind: 1, gust: 2, windFrom: 200, temperature: 5, isDay: true, wet: 0.3, ice: 0, snowDepth: 0 }),
  drizzle: fixed({ kind: 'drizzle', code: 53, intensity: 0.55, cloud: 1, visibility: 5000, wind: 3, gust: 6, windFrom: 240, temperature: 9, isDay: true, wet: 0.72, ice: 0, snowDepth: 0 }),
  // a moderate rain from the south-west, the usual one in Hesse
  rain: fixed({ kind: 'rain', code: 63, intensity: 0.6, cloud: 1, visibility: 4000, wind: 5, gust: 10, windFrom: 240, temperature: 11, isDay: true, wet: 0.9, ice: 0, snowDepth: 0 }),
  snow: fixed({ kind: 'snow', code: 73, intensity: 0.55, cloud: 1, visibility: 1500, wind: 3, gust: 6, windFrom: 60, temperature: -2, isDay: true, wet: 0.25, ice: 0, snowDepth: 0.03 }),
  storm: fixed({ kind: 'storm', code: 95, intensity: 0.9, cloud: 1, visibility: 2000, wind: 13, gust: 24, windFrom: 250, temperature: 19, isDay: true, wet: 1, ice: 0, snowDepth: 0 }),
});

/** No weather to be had (switched off, offline, not answered yet): a clear day. */
export const CLEAR_WEATHER: WeatherState = fixed({ ...FIXED_WEATHER.clear }, 'none');

/**
 * The weather to show for a setting: a fixed one, or the real one at the
 * game's moment `at` (ms since 1970; undefined: the real time) – clear as
 * long as there is none (offline, not answered yet), the climate's for a
 * moment the forecast does not reach.  Allocates nothing: fine to call every
 * frame.
 */
export function weatherFor(setting: WeatherSetting, real: RealWeather | null, at?: number): WeatherState {
  if (setting === 'off') return CLEAR_WEATHER;
  if (setting !== 'real') return FIXED_WEATHER[setting] ?? CLEAR_WEATHER;
  const s = real?.current(at);
  if (s) return s;
  if (at !== undefined && Number.isFinite(at) && !(real?.covers(at) ?? false)) return climateWeather(at);
  return CLEAR_WEATHER;
}

// ------------------------------------------------------------ grip and wind

/**
 * What the weather (and the season's snow on the road) leaves of the tyres'
 * grip, as a factor on that of a dry road: a wet road about 0.8 (less with
 * water standing in heavy rain), snow about 0.5, ice down to 0.3.  For
 * WorldGround.weatherGrip.  `roadSnow`: SeasonState.roadSnow (0 … 1) – snow
 * lying on the road, compacted by the traffic: down to 0.5.
 */
export function gripFactor(s: WeatherState, roadSnow = 0): number {
  // the film of water on a wet road
  let g = 1 - 0.2 * clamp01(s.wet);
  // heavy rain: water stands in the ruts, the tyres begin to float
  if (s.kind === 'rain' || s.kind === 'storm') g -= 0.1 * clamp01(s.intensity);
  // fresh snow on the road
  if (s.kind === 'snow') g = Math.min(g, 0.55 - 0.15 * clamp01(s.intensity));
  // snow lying on the road
  g = Math.min(g, 1 - 0.5 * clamp01(Number.isFinite(roadSnow) ? roadSnow : 0));
  // glaze from freezing rain, rime, a wet road frozen
  g = Math.min(g, 1 - 0.7 * clamp01(s.ice));
  return Math.min(1, Math.max(0.25, g));
}

/**
 * The wind as a velocity in the world frame (m/s, x east, z south) – where it
 * blows to, not where it comes from.
 */
export function windVector(s: WeatherState, out: { x: number; z: number }): { x: number; z: number } {
  const a = (s.windFrom * Math.PI) / 180;
  const v = Math.max(0, s.wind);
  // from the north (0°) it blows to the south, +z
  out.x = -Math.sin(a) * v;
  out.z = Math.cos(a) * v;
  return out;
}

// ------------------------------------------ the weather now, for anyone

/** snow this deep (m) whitens the land completely; less lies in patches */
export const FULL_SNOW_DEPTH = 0.04;

let shown: WeatherState = CLEAR_WEATHER;
let shownGroundSnow = -1;

/**
 * The weather the game shows now, for any part of the game that wants to
 * know – people under umbrellas, cranes in the wind, dirt on the car.  The
 * game sets it (setWeatherNow) whenever it changes; until then it is clear.
 * The helpers below read it when called without a state.
 */
export function weatherNow(): WeatherState {
  return shown;
}

/**
 * The game: this is the weather shown now; `groundSnow` the snow the player
 * sees lying, with the season's (SeasonState.snow, 0 … 1).
 */
export function setWeatherNow(s: WeatherState, groundSnow?: number): void {
  shown = s;
  shownGroundSnow = typeof groundSnow === 'number' && Number.isFinite(groundSnow) ? clamp01(groundSnow) : -1;
}

/** How hard it rains – drizzle, rain, a thunderstorm's rain: 0 dry … 1 a downpour. */
export function rainIntensity(s: WeatherState = shown): number {
  return s.kind === 'drizzle' || s.kind === 'rain' || s.kind === 'storm' ? clamp01(s.intensity) : 0;
}

/** Does it rain (or drizzle)? */
export function isRaining(s: WeatherState = shown): boolean {
  return rainIntensity(s) > 0;
}

/** How hard it snows, 0 … 1. */
export function snowIntensity(s: WeatherState = shown): number {
  return s.kind === 'snow' ? clamp01(s.intensity) : 0;
}

/** The mean wind 10 m above the ground (m/s); the gusts are `gust`, the direction windVector(). */
export function windSpeed(s: WeatherState = shown): number {
  return Math.max(0, s.wind);
}

/**
 * Snow lying on the ground, 0 none … 1 all white.  Without a state: as the
 * player sees it, the season's snow included, when the game said so.  Of a
 * state: by its snow depth, and snow falling below 1.5 °C settles.
 */
export function snowOnGround(s?: WeatherState): number {
  if (s === undefined && shownGroundSnow >= 0) return shownGroundSnow;
  const w = s ?? shown;
  let c = clamp01(w.snowDepth / FULL_SNOW_DEPTH);
  if (w.kind === 'snow' && w.intensity > 0 && w.temperature <= 1.5) c = Math.max(c, 0.3 + 0.5 * clamp01(w.intensity));
  return c;
}

// ---------------------------------------------------- the WMO weather codes

/** What a WMO present-weather code (table 4677, 0 … 99) says before the measured amounts refine it. */
interface CodeInfo {
  /** 'sky': clear or cloudy as the cloud cover says; 'mixed': rain and snow – one or the other by the temperature */
  kind: WeatherKind | 'sky' | 'mixed';
  /** how hard it falls as the code words it (slight, moderate, heavy) – the least the intensity will be */
  level: number;
  /** what the code says of the visibility (m): fog is fog below 1 km whatever the model's number */
  vis: number;
  /** the road still wet from what fell in the last hour */
  wet: number;
  /** ice on the road */
  ice: number;
}

function info(kind: CodeInfo['kind'], level = 0, vis = Infinity, wet = 0, ice = 0): CodeInfo {
  return { kind, level, vis, wet, ice };
}

/** slight … heavy, intermittent or continuous (the steps of 50–55, 60–65, 70–75) */
const STEPS = [0.2, 0.3, 0.45, 0.55, 0.75, 0.85];

/**
 * The full table 4677: Open-Meteo gives only some of its codes (0–3, 45, 48,
 * 51–57, 61–67, 71–77, 80–86, 95–99), but any of them may come.
 */
function codeInfo(code: number): CodeInfo {
  // 0–3: clear, mainly clear, partly cloudy, overcast (Open-Meteo's reading of "cloud development")
  if (code <= 3) return info('sky');
  // smoke, haze, dust in the air
  if (code <= 6) return info('sky', 0, 5000);
  // dust or sand raised by the wind, whirls, a duststorm in sight
  if (code <= 9) return info('sky', 0, 3000);
  if (code === 10) return info('fog', 0.25, 2500); // mist
  if (code <= 12) return info('fog', 0.45, 800); // shallow fog
  // lightning without thunder, precipitation in sight but not here
  if (code <= 16) return info('sky');
  if (code === 17) return info('storm'); // thunder, nothing falling
  if (code === 18) return info('sky'); // squalls (the wind says how strong)
  if (code === 19) return info('storm'); // funnel cloud
  // 20–29: something fell in the last hour, nothing now – the road is still wet
  if (code <= 29) {
    switch (code) {
      case 20: return info('sky', 0, Infinity, 0.5); // drizzle or snow grains
      case 22: return info('sky', 0, Infinity, 0.2); // snow
      case 24: return info('sky', 0, Infinity, 0.6, 0.8); // freezing drizzle or rain
      case 26: return info('sky', 0, Infinity, 0.3); // snow showers
      case 28: return info('sky', 0, 5000, 0.2); // fog
      default: return info('sky', 0, Infinity, code === 23 || code === 25 || code === 27 ? 0.6 : 0.7); // rain, showers, thunderstorm
    }
  }
  // dust- and sandstorms
  if (code <= 35) return info('sky', 0, code >= 33 ? 500 : 1500);
  // drifting snow below eye level, blowing snow above it
  if (code <= 39) return info('snow', [0.2, 0.35, 0.5, 0.85][code - 36], [4000, 2000, 1000, 300][code - 36]);
  if (code === 40) return info('sky', 0, 5000); // fog at a distance
  if (code === 41) return info('fog', 0.4, 800); // fog in patches
  // 42–47: fog, the sky seen through it (even codes) or not
  if (code <= 47) return code % 2 === 0 ? info('fog', 0.55, 600) : info('fog', 0.8, 300);
  // depositing rime: ice on the road
  if (code <= 49) return info('fog', 0.75, 350, 0.3, 0.5);
  // drizzle
  if (code <= 55) return info('drizzle', STEPS[code - 50]);
  if (code === 56) return info('drizzle', 0.3, Infinity, 0, 1); // freezing
  if (code === 57) return info('drizzle', 0.7, Infinity, 0, 1);
  if (code === 58) return info('rain', 0.3); // drizzle and rain
  if (code === 59) return info('rain', 0.6);
  // rain
  if (code <= 65) return info('rain', STEPS[code - 60]);
  if (code === 66) return info('rain', 0.3, Infinity, 0, 1); // freezing
  if (code === 67) return info('rain', 0.7, Infinity, 0, 1);
  if (code === 68) return info('mixed', 0.3); // rain (or drizzle) and snow
  if (code === 69) return info('mixed', 0.65);
  // snow
  if (code <= 75) return info('snow', STEPS[code - 70]);
  if (code === 76) return info('snow', 0.1); // diamond dust
  if (code === 77) return info('snow', 0.25); // snow grains
  if (code === 78) return info('snow', 0.1); // single star-like crystals
  if (code === 79) return info('snow', 0.4); // ice pellets
  // showers
  if (code <= 82) return info('rain', [0.35, 0.65, 1][code - 80]); // of rain: slight, moderate or heavy, violent
  if (code <= 84) return info('mixed', code === 83 ? 0.35 : 0.65); // of rain and snow
  if (code <= 86) return info('snow', code === 85 ? 0.35 : 0.7); // of snow
  if (code <= 88) return info('snow', code === 87 ? 0.35 : 0.6); // of snow pellets, small hail
  if (code <= 90) return info('rain', code === 89 ? 0.5 : 0.8); // of hail, with rain, no thunder
  // rain or snow now, a thunderstorm in the last hour
  if (code <= 92) return info('rain', code === 91 ? 0.3 : 0.65);
  if (code <= 94) return info('mixed', code === 93 ? 0.3 : 0.65);
  // thunderstorms: slight or moderate, with hail, heavy, with a duststorm, heavy with hail
  if (code === 98) return info('storm', 0.5, 1500);
  return info('storm', [0.6, 0.75, 0.9, 0, 1][code - 95]);
}

// --------------------------------------------------------- the API's answer

/** The `current` block of Open-Meteo's forecast answer (the fields asked for in weatherUrl). */
export interface OpenMeteoCurrent {
  time?: string;
  /** seconds the sums (precipitation …) are taken over: 900 for the 15-minute data */
  interval?: number | null;
  temperature_2m?: number | null;
  weather_code?: number | null;
  /** all that fell in the interval (mm of water) */
  precipitation?: number | null;
  rain?: number | null;
  showers?: number | null;
  /** snow that fell in the interval (cm; 7 cm are 10 mm of water) */
  snowfall?: number | null;
  /** % */
  cloud_cover?: number | null;
  /** m */
  visibility?: number | null;
  /** m/s (asked for with wind_speed_unit=ms) */
  wind_speed_10m?: number | null;
  /** degrees, where the wind comes from */
  wind_direction_10m?: number | null;
  wind_gusts_10m?: number | null;
  /** 1 by day, 0 by night */
  is_day?: number | null;
  /** snow lying on the ground (m) */
  snow_depth?: number | null;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

/**
 * Open-Meteo's current weather as the game's weather.  Pure: the WMO code
 * says what falls, the amounts how hard, the cloud cover whether a dry sky
 * is clear or cloudy, the model's visibility (within what the code allows)
 * how far one sees.  A field that is missing takes a plausible default.
 */
export function weatherFromOpenMeteo(c: OpenMeteoCurrent): WeatherState {
  const temperature = num(c.temperature_2m, 10);
  const interval = num(c.interval, 900) > 0 ? num(c.interval, 900) : 900;
  const perHour = 3600 / interval;
  // all that fell, as water: precipitation, or else its parts (snow: 7 cm make 10 mm)
  const snowWater = (Math.max(0, num(c.snowfall, 0)) * 10) / 7;
  const total = Math.max(0, num(c.precipitation, Math.max(0, num(c.rain, 0)) + Math.max(0, num(c.showers, 0)) + snowWater));
  const rate = total * perHour; // mm/h

  const rawCode = c.weather_code;
  const code = typeof rawCode === 'number' && Number.isInteger(rawCode) && rawCode >= 0 && rawCode <= 99 ? rawCode : -1;
  let ci: CodeInfo;
  if (code >= 0) ci = codeInfo(code);
  else if (rate > 0.05) {
    // no code: what falls, by the amounts
    ci = snowWater * perHour > rate * 0.5 ? info('snow', 0.2) : info(rate < 0.5 ? 'drizzle' : 'rain', 0.2);
  } else ci = info('sky');

  const cloudApi = c.cloud_cover;
  let cloud = typeof cloudApi === 'number' && Number.isFinite(cloudApi) ? clamp01(cloudApi / 100) : code >= 0 && code <= 3 ? [0, 0.25, 0.55, 1][code] : 0.6;

  let kind: WeatherKind;
  if (ci.kind === 'sky') kind = cloud >= 0.65 ? 'cloudy' : 'clear';
  else if (ci.kind === 'mixed') kind = temperature <= 1 ? 'snow' : 'rain'; // sleet: whichever it looks more like
  else kind = ci.kind;

  // how hard: as the code words it, or as much as the amounts say (light rain 1 mm/h, heavy 8 and more)
  let intensity = ci.level;
  if (kind === 'rain' || kind === 'storm') intensity = Math.max(intensity, Math.sqrt(rate / 16));
  else if (kind === 'drizzle') intensity = Math.max(intensity, Math.sqrt(rate / 1.6));
  else if (kind === 'snow') intensity = Math.max(intensity, Math.sqrt(rate / 3.5));
  intensity = clamp01(intensity);
  const falls = (kind === 'rain' || kind === 'drizzle' || kind === 'snow' || kind === 'storm') && intensity > 0;
  if (falls) cloud = Math.max(cloud, kind === 'storm' ? 0.9 : 0.85);

  // how far one sees: the model's number, no farther than the code and what falls allow
  let visibility = Math.min(num(c.visibility, 25000) > 0 ? num(c.visibility, 25000) : 25000, ci.vis);
  if (falls) {
    const dry = 1 - intensity;
    const limit = kind === 'snow' ? 250 + 8000 * dry * dry : kind === 'drizzle' ? 1500 + 8000 * dry * dry : kind === 'storm' ? 1000 + 12000 * dry * dry : 1500 + 20000 * dry * dry;
    visibility = Math.min(visibility, limit);
  }
  // a dry sky with the view below a kilometre is fog, whatever the code
  if ((kind === 'clear' || kind === 'cloudy') && visibility < 1000) {
    kind = 'fog';
    intensity = Math.max(0.3, 1 - visibility / 1000);
  } else if (kind === 'fog') intensity = Math.max(intensity, clamp01(1 - visibility / 1000));
  visibility = Math.min(50000, Math.max(30, visibility));

  // the road: wet in rain, damp in fog, slush when snow falls above freezing
  let wet = ci.wet;
  if ((kind === 'rain' || kind === 'storm') && intensity > 0) wet = 0.75 + 0.25 * intensity;
  else if (kind === 'drizzle') wet = 0.55 + 0.3 * intensity;
  else if (kind === 'snow') wet = temperature > 1.5 ? 0.7 : 0.25;
  else if (kind === 'fog') wet = Math.max(wet, 0.3);
  // it fell in the last quarter of an hour, even if the code says nothing falls now
  if (kind !== 'snow' && rate > 0) wet = Math.max(wet, 0.6);
  let ice = ci.ice;
  if ((kind === 'rain' || kind === 'drizzle' || kind === 'storm') && intensity > 0 && temperature <= -0.5) ice = Math.max(ice, 0.8); // rain on frozen ground
  else if (kind === 'fog' && temperature <= -0.5) ice = Math.max(ice, 0.4); // freezing fog leaves rime
  else if (kind !== 'snow' && wet >= 0.5 && temperature <= -1) ice = Math.max(ice, 0.6); // the wet road freezes

  const dir = num(c.wind_direction_10m, 240);
  const wind = Math.max(0, num(c.wind_speed_10m, 2));
  return {
    kind,
    code,
    intensity,
    cloud,
    visibility,
    wind,
    gust: Math.max(wind, num(c.wind_gusts_10m, wind * 1.5)),
    windFrom: ((dir % 360) + 360) % 360,
    temperature,
    isDay: num(c.is_day, 1) !== 0,
    wet: clamp01(wet),
    ice: clamp01(ice),
    snowDepth: Math.min(5, Math.max(0, num(c.snow_depth, 0))),
    source: 'real',
  };
}

/** The whole answer (parsed JSON) → the weather now; null for anything that is not an answer. */
export function parseOpenMeteo(json: unknown): WeatherState | null {
  if (typeof json !== 'object' || json === null) return null;
  const current = (json as { current?: unknown }).current;
  if (typeof current !== 'object' || current === null) return null;
  return weatherFromOpenMeteo(current as OpenMeteoCurrent);
}

/** what is asked for, now or hour by hour */
const FIELD_LIST = ['temperature_2m', 'weather_code', 'precipitation', 'rain', 'showers', 'snowfall', 'snow_depth', 'cloud_cover', 'visibility', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'is_day'] as const;
const FIELDS = FIELD_LIST.join(',');

/** Hours of a forecast: their moments (ms since 1970, ascending) and their weather. */
export interface WeatherHours {
  t: number[];
  s: WeatherState[];
}

/**
 * An hourly answer (asked with timeformat=unixtime) → the weather hour by
 * hour.  Hours without data – the service keeps the past only so long – are
 * left out; null when no hour has any.
 */
export function parseOpenMeteoHourly(json: unknown): WeatherHours | null {
  if (typeof json !== 'object' || json === null) return null;
  const h = (json as { hourly?: unknown }).hourly;
  if (typeof h !== 'object' || h === null) return null;
  const table = h as Record<string, unknown>;
  const time = table.time;
  if (!Array.isArray(time)) return null;
  const cols = FIELD_LIST.map((f) => (Array.isArray(table[f]) ? (table[f] as unknown[]) : null));
  const out: WeatherHours = { t: [], s: [] };
  for (let i = 0; i < time.length; i++) {
    const t = time[i];
    if (typeof t !== 'number' || !Number.isFinite(t)) continue;
    // (the sums – precipitation, snowfall – are of the hour before)
    const c: Record<string, unknown> = { interval: 3600 };
    let any = false;
    for (let k = 0; k < FIELD_LIST.length; k++) {
      const v = cols[k]?.[i];
      if (typeof v !== 'number') continue;
      c[FIELD_LIST[k]] = v;
      if (FIELD_LIST[k] === 'weather_code' || FIELD_LIST[k] === 'temperature_2m') any = true;
    }
    if (!any) continue;
    out.t.push(t * 1000);
    out.s.push(weatherFromOpenMeteo(c as OpenMeteoCurrent));
  }
  return out.t.length > 0 ? out : null;
}

// ---------------------------------------------- the weather of the climate

const HOUR = 3600_000;

/** Kassel's climate by month (DWD normals 1991–2020, rounded): mean temperature (°C), half the day's range (°C), cloud cover */
const CLIMATE: ReadonlyArray<readonly [number, number, number]> = [
  [1.0, 2.0, 0.8],
  [1.6, 2.5, 0.75],
  [4.8, 3.5, 0.7],
  [9.2, 4.5, 0.62],
  [13.3, 5.0, 0.6],
  [16.4, 5.0, 0.6],
  [18.4, 5.0, 0.58],
  [17.9, 5.0, 0.55],
  [14.0, 4.5, 0.6],
  [9.5, 3.5, 0.7],
  [5.0, 2.2, 0.82],
  [1.8, 1.8, 0.83],
];
let climateHour = NaN;
let climateState: WeatherState = CLEAR_WEATHER;

/**
 * A typical hour of that time of year round Kassel (pure, from the climate
 * normals): for a moment the forecast does not reach.  Nothing falls; the
 * month's cloud and warmth, warmest in the afternoon; day or night by the
 * sun.  The snow of a typical winter is the season's (render/season.ts).
 * The same object for the same hour: fine to ask every frame.
 */
export function climateWeather(ms: number): WeatherState {
  const hour = Math.floor(ms / HOUR);
  if (hour === climateHour) return climateState;
  const [mean, half, cloud] = CLIMATE[new Date(hour * HOUR).getUTCMonth()] ?? CLIMATE[0];
  // the sun's time here (9.45° E); the warmest is at about half past two
  const solar = (((ms / HOUR + 9.45 / 15) % 24) + 24) % 24;
  const temperature = Math.round((mean + half * Math.cos(((solar - 14.5) / 24) * 2 * Math.PI)) * 10) / 10;
  const grey = clamp01((cloud - 0.55) / 0.3);
  const wind = 3 + 1.2 * grey;
  const kind: WeatherKind = cloud >= 0.65 ? 'cloudy' : 'clear';
  climateState = Object.freeze({
    kind,
    code: kind === 'cloudy' ? 3 : 2,
    intensity: 0,
    cloud,
    visibility: 24000 - 10000 * grey,
    wind,
    gust: wind * 2,
    windFrom: 240,
    temperature,
    isDay: sunAt(ms).elevation > -0.833,
    wet: 0,
    ice: 0,
    snowDepth: 0,
    source: 'climate' as const,
  });
  climateHour = hour;
  return climateState;
}

// ------------------------------------------------------------ the request

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

/** What Open-Meteo's licence (CC BY 4.0) asks for wherever its data are shown: this text, linked to the site. */
export const WEATHER_ATTRIBUTION = Object.freeze({
  text: 'Weather data by Open-Meteo.com',
  url: 'https://open-meteo.com/',
  licence: 'CC BY 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
});

/** how far back and ahead of the real now the service tells the weather hour by hour (ms): it keeps about two months of the past, forecasts 16 days */
export const FORECAST_BACK_MS = 60 * 24 * HOUR;
export const FORECAST_AHEAD_MS = 15 * 24 * HOUR;
/** a forecast for another moment stays good this long (ms) */
const FORECAST_MAX_AGE_MS = 12 * HOUR;
/** a game moment this close to the real one is "now": the current weather */
const NOW_SLACK = 10 * 60_000;
/** hours asked for at once for another moment: from the hour before it, a day on (at the fastest clock three real hours) */
const BLOCK_HOURS = 25;

/** "2026-11-25T14:00" (UTC) */
function isoHour(ms: number): string {
  return `${new Date(Math.floor(ms / HOUR) * HOUR).toISOString().slice(0, 13)}:00`;
}

/**
 * The request for the weather at a place of the map: now, or hour by hour
 * from `hours.from` to `hours.to` (ms; within FORECAST_BACK_MS …
 * FORECAST_AHEAD_MS of now).  Latitude and longitude are rounded to 0.1°.
 * The ground height (m above sea level, rounded to 10 m) is optional; without
 * it the service takes the height of its terrain model at the rounded point –
 * round Kassel that may be the Habichtswald, 300 m higher and 2 °C colder
 * than the town (snow instead of rain).
 */
export function weatherUrl(lat: number, lon: number, elevation?: number, hours?: { from: number; to: number }): string {
  const la = Math.max(-90, Math.min(90, Math.round(lat * 10) / 10));
  const lo = Math.max(-180, Math.min(180, Math.round(lon * 10) / 10));
  let url = `${OPEN_METEO_URL}?latitude=${la.toFixed(1)}&longitude=${lo.toFixed(1)}`;
  url += hours ? `&hourly=${FIELDS}&timeformat=unixtime&start_hour=${isoHour(hours.from)}&end_hour=${isoHour(hours.to)}` : `&current=${FIELDS}`;
  url += '&wind_speed_unit=ms&timezone=GMT';
  if (typeof elevation === 'number' && Number.isFinite(elevation) && elevation > -450 && elevation < 9000) url += `&elevation=${Math.round(elevation / 10) * 10}`;
  return url;
}

/** what RealWeather needs of fetch (the browser's, or a fake one in the tests) */
export type WeatherFetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export interface RealWeatherOptions {
  /** default: the browser's fetch */
  fetch?: WeatherFetch;
  /**
   * the real clock in ms (default Date.now, a wall clock – a night in standby
   * counts): how often to ask and how far the forecast reaches go by it; the
   * game's own moment is what request(), current() and due() are given
   */
  now?: () => number;
  /** the least time between two requests for the same (ms; default 15 min – the service's data change every 15 min) */
  refreshMs?: number;
  /** the least time between requests for different moments (ms; default 1 min – the player sets another moment now and then) */
  minGapMs?: number;
  /** how long to wait for an answer (ms; default 8 s) */
  timeoutMs?: number;
  /** how long the current weather stays good when no newer answer comes (ms; default 2 h – then clear) */
  maxAgeMs?: number;
}

export const WEATHER_REFRESH_MS = 15 * 60_000;
export const WEATHER_MIN_GAP_MS = 60_000;
export const WEATHER_TIMEOUT_MS = 8000;
export const WEATHER_MAX_AGE_MS = 2 * HOUR;

/**
 * The real weather – now, or at the game's moment when the player set
 * another one (the arcade mode's clock): the forecast hour by hour up to 16
 * days ahead, the past as far as the service keeps it (about two months).
 *
 * Asked for only when the game asks (request), one request at a time, the
 * same thing at most once per refreshMs whatever the outcome, another moment
 * at most once per minGapMs.  A failure – offline, no answer in time, an
 * error – is silent: the last answer stays while it is fresh enough, and
 * then there is none (weatherFor: clear).  No timer of its own: nothing goes
 * out unless request() is called.
 */
export class RealWeather {
  readonly refreshMs: number;
  readonly minGapMs: number;
  readonly timeoutMs: number;
  readonly maxAgeMs: number;
  /** requests sent so far */
  requests = 0;
  private readonly fetchFn: WeatherFetch | null;
  private readonly now: () => number;
  // the game at the real time: the current weather
  private last: WeatherState | null = null;
  private lastAt = -Infinity;
  private askedNow = -Infinity;
  // the game at another moment: the forecast hour by hour
  private hours: WeatherHours | null = null;
  private hoursAt = -Infinity;
  private askedHours = -Infinity;
  private blockFrom = NaN;
  private blockTo = NaN;
  /** the hours asked last came back without data (the past beyond what the service keeps) */
  private blockEmpty = false;
  private askedAny = -Infinity;
  private inflight: Promise<WeatherState | null> | null = null;

  constructor(opts: RealWeatherOptions = {}) {
    this.refreshMs = opts.refreshMs ?? WEATHER_REFRESH_MS;
    this.minGapMs = opts.minGapMs ?? WEATHER_MIN_GAP_MS;
    this.timeoutMs = opts.timeoutMs ?? WEATHER_TIMEOUT_MS;
    this.maxAgeMs = opts.maxAgeMs ?? WEATHER_MAX_AGE_MS;
    // (bound: the browser's fetch refuses to be called as a method of another object)
    this.fetchFn = opts.fetch ?? (typeof fetch === 'function' ? (fetch.bind(globalThis) as WeatherFetch) : null);
    this.now = opts.now ?? Date.now;
  }

  /** `at` (the game's moment, ms; undefined: the real time) is the real now, near enough. */
  private isNow(at: number | undefined, now: number): boolean {
    return at === undefined || !Number.isFinite(at) || Math.abs(at - now) < NOW_SLACK;
  }

  /**
   * Can the service tell the weather at the game's moment `at`?  Now always;
   * another moment when the forecast reaches it and it was not answered
   * without data.  Where it cannot, weatherFor() shows the climate's.
   */
  covers(at?: number): boolean {
    const now = this.now();
    if (this.isNow(at, now)) return true;
    const t = at as number;
    if (!(t >= now - FORECAST_BACK_MS && t <= now + FORECAST_AHEAD_MS)) return false;
    return !(this.blockEmpty && t >= this.blockFrom && t <= this.blockTo);
  }

  /**
   * The weather at the game's moment `at` (ms since 1970; undefined: now) as
   * last answered – null when there is none (not asked yet, offline, too old,
   * not in the hours fetched).
   */
  current(at?: number): WeatherState | null {
    const now = this.now();
    if (this.isNow(at, now)) return this.last && now - this.lastAt <= this.maxAgeMs ? this.last : null;
    const h = this.hours;
    if (!h || now - this.hoursAt > FORECAST_MAX_AGE_MS) return null;
    const t = at as number;
    // the nearest hour (no more than three quarters of an hour away)
    let best = -1;
    let bestD = 0.75 * HOUR;
    for (let i = 0; i < h.t.length; i++) {
      const d = Math.abs(h.t[i] - t);
      if (d <= bestD) {
        best = i;
        bestD = d;
      }
    }
    return best >= 0 ? h.s[best] : null;
  }

  /** A request is under way. */
  get pending(): boolean {
    return this.inflight !== null;
  }

  /** Would request() send one now for the game's moment `at`?  (Cheap: ask it before working out the place.) */
  due(at?: number): boolean {
    if (this.inflight !== null || this.fetchFn === null) return false;
    const now = this.now();
    if (this.isNow(at, now)) return now - this.askedNow >= this.refreshMs;
    if (!this.covers(at)) return false;
    const t = at as number;
    // within the hours asked last (an hour to spare for a clock that runs fast): refreshed as seldom as the current weather
    if (t >= this.blockFrom && t <= this.blockTo - HOUR) return now - this.askedHours >= this.refreshMs;
    // another moment: soon – but not more often than minGapMs
    return now - this.askedAny >= this.minGapMs;
  }

  /**
   * Ask for the weather at a place (degrees; `elevation`: the ground height
   * there, m) at the game's moment `at` (ms; undefined: now).  Sent only when
   * due() – otherwise nothing happens and null comes back.  The promise never
   * fails: the weather at `at`, or null (current() then keeps what it had).
   * The game need not wait for it.
   */
  request(lat: number, lon: number, elevation?: number, at?: number): Promise<WeatherState | null> | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !this.due(at)) return null;
    const now = this.now();
    this.askedAny = now;
    this.requests++;
    let p: Promise<WeatherState | null>;
    if (this.isNow(at, now)) {
      this.askedNow = now;
      p = this.load(weatherUrl(lat, lon, elevation)).then((answer) => {
        const s = answer ? parseOpenMeteo(answer.json) : null;
        if (s) {
          this.last = s;
          this.lastAt = this.now();
        }
        return s;
      });
    } else {
      const t = at as number;
      // from the hour before the moment a day on, within what the service tells
      const from = Math.max(Math.floor(t / HOUR) * HOUR - HOUR, Math.ceil((now - FORECAST_BACK_MS) / HOUR) * HOUR);
      const to = Math.max(from, Math.min(from + BLOCK_HOURS * HOUR, Math.floor((now + FORECAST_AHEAD_MS) / HOUR) * HOUR));
      this.askedHours = now;
      this.blockFrom = from;
      this.blockTo = to;
      this.blockEmpty = false;
      p = this.load(weatherUrl(lat, lon, elevation, { from, to })).then((answer) => {
        const hours = answer ? parseOpenMeteoHourly(answer.json) : null;
        if (hours) {
          this.hours = hours;
          this.hoursAt = this.now();
        } else if (answer && this.blockFrom === from) this.blockEmpty = true; // answered – but nothing for those hours
        return this.current(t);
      });
    }
    const done = p.then((s) => {
      this.inflight = null;
      return s;
    });
    this.inflight = done;
    return done;
  }

  /**
   * The answer's JSON – `json: null` when the service refused the question
   * (4xx: a moment out of its range) – or null for no answer at all (offline,
   * too late, a server error).
   */
  private async load(url: string): Promise<{ json: unknown } | null> {
    const fetchFn = this.fetchFn;
    if (!fetchFn) return null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // (raced rather than trusted to the abort: an answer that hangs in its body still ends in time)
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        ctrl?.abort();
        resolve(null);
      }, this.timeoutMs);
    });
    const work = (async (): Promise<{ json: unknown } | null> => {
      const res = await fetchFn(url, {
        method: 'GET',
        mode: 'cors',
        // nothing of the player: no cookies, not the page it is asked from, no stored copy
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        // (a fixed language instead of the browser's; a "simple" header: no CORS preflight)
        headers: { 'Accept-Language': 'en' },
        signal: ctrl?.signal,
      });
      if (!res.ok) return typeof res.status === 'number' && res.status >= 400 && res.status < 500 ? { json: null } : null;
      return { json: await res.json() };
    })().catch(() => null);
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
  }
}
