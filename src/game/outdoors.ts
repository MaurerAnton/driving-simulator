// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The weather and the season, put together for the game: one object it
 * makes once and updates once a frame.
 *
 * It asks for the real weather where the vehicle is (when the setting wants
 * it, as often as RealWeather allows, at the game clock's moment), picks the
 * weather to show (weatherFor), works out the season (seasonFor – once an hour
 * of game time, or when the weather or the settings change), and from both:
 * the rain and snow in the picture and the sky's fog and light
 * (WeatherRenderer), the season's colours and snow in the materials
 * (SeasonLook), the wheel tracks on a snowy road (SnowTracks), the grip of
 * the tyres (`grip`, for WorldGround.weatherGrip) and the weather "now" that
 * any other part of the game may ask (setWeatherNow).
 */
import type * as THREE from 'three';
import { gameClock } from './clock.ts';
import { CLEAR_WEATHER, RealWeather, gripFactor, setWeatherNow, weatherFor } from './weather.ts';
import type { WeatherSetting, WeatherState } from './weather.ts';
import { worldToLatLon } from '../geo/utm.ts';
import { SnowTracks } from '../render/snowtracks.ts';
import { SeasonLook, seasonFor } from '../render/season.ts';
import type { SeasonSetting, SeasonState, SeasonTarget } from '../render/season.ts';
import { WEATHER_PARTICLES, WeatherRenderer } from '../render/weather.ts';
import type { SkyParts } from '../render/weather.ts';
import { WaterLook } from '../render/water.ts';
import type { Connector, Lane } from '../world/lanes.ts';

/** what of the game's clock is needed (game/clock.ts's gameClock fits) */
export interface OutdoorsClock {
  /** at the real time (the current weather), or at a moment of its own (the forecast for that hour) */
  readonly real: boolean;
  ms(): number;
}

/** what of the lane network is needed for the wheel tracks (world/lanes.ts's LaneGraph fits) */
export interface OutdoorsLanes {
  readonly lanes: readonly (Lane | undefined)[];
  readonly connectors?: readonly (Connector | undefined)[];
}

const HOUR = 3600_000;

export class Outdoors {
  readonly real: RealWeather;
  readonly view: WeatherRenderer;
  readonly look = new SeasonLook();
  readonly tracks = new SnowTracks();
  /** real water in the terrain and the far view (`water.enabled`: the graphics setting) */
  readonly water = new WaterLook();
  /** the weather and the season shown now */
  weather: WeatherState = CLEAR_WEATHER;
  season: SeasonState;
  /** what the weather and the snow on the road leave of the tyres' grip (for WorldGround.weatherGrip) */
  grip = 1;
  private weatherSetting: WeatherSetting | '' = '';
  private seasonSetting: SeasonSetting | '' = '';
  private hour = NaN;

  /**
   * `scene`: where the rain, the snow and the tracks are added; `sky`: the
   * game's Sky (its fog, sun, sky light and dome follow the weather);
   * `quality`: the most raindrops at once (WEATHER_PARTICLES).
   */
  constructor(scene: THREE.Object3D, sky: SkyParts | null, quality: number = WEATHER_PARTICLES.medium, real: RealWeather = new RealWeather()) {
    this.real = real;
    this.view = new WeatherRenderer(quality);
    this.season = { ...this.look.state };
    scene.add(this.view.group, this.tracks.mesh);
    this.view.attachSky(sky);
    this.water.attachSky(sky?.dome);
  }

  /**
   * Teach a material the season – and, the roads and their markings, the
   * wet: for the tiles' materials (terrain, ground, paint, struct, building),
   * the far view's, the trees' of each kind.  Once per material.
   */
  patch(material: THREE.Material, target: SeasonTarget): void {
    this.look.patch(material, target);
    if (target === 'ground' || target === 'paint') this.view.addWetness(material);
    if (target === 'terrain' || target === 'far') this.water.patch(material, target);
  }

  /**
   * Once a frame, before the picture is drawn (and after the sky's sun was
   * set for the frame): `dt` seconds since the last, the camera's position,
   * the place of the vehicle or walker (x, z; y its ground height, NaN when
   * not known), the settings, the lanes for the wheel tracks (null: none)
   * and the game's clock.
   */
  update(dt: number, camera: Readonly<{ x: number; y: number; z: number }>, place: Readonly<{ x: number; y: number; z: number }>, settings: Readonly<{ weather: WeatherSetting; season: SeasonSetting }>, lanes: OutdoorsLanes | null = null, clock: OutdoorsClock = gameClock): void {
    const ms = clock.ms();
    const at = clock.real ? undefined : ms;
    // the real weather where the vehicle is (asked only when RealWeather allows – cheap to try every frame)
    if (settings.weather === 'real' && this.real.due(at) && Number.isFinite(place.x) && Number.isFinite(place.z)) {
      const [lat, lon] = worldToLatLon(place.x, place.z);
      this.real.request(lat, lon, Number.isFinite(place.y) ? place.y : undefined, at);
    }
    const w = weatherFor(settings.weather, this.real, at);
    const hour = Math.floor(ms / HOUR);
    if (w !== this.weather || hour !== this.hour || settings.weather !== this.weatherSetting || settings.season !== this.seasonSetting) {
      const switched = settings.weather !== this.weatherSetting || settings.season !== this.seasonSetting;
      this.weather = w;
      this.hour = hour;
      this.weatherSetting = settings.weather;
      this.seasonSetting = settings.season;
      this.season = seasonFor(settings.season, w, new Date(ms));
      this.look.set(this.season);
      this.grip = gripFactor(w, this.season.roadSnow);
      this.tracks.amount = this.season.roadSnow;
      setWeatherNow(w, this.season.snow);
      // a setting changed: show it at once rather than fading over
      if (switched) this.view.jump();
    }
    this.view.update(camera, dt, w);
    this.water.update(dt);
    if (lanes) this.tracks.update(camera.x, camera.z, lanes.lanes, lanes.connectors);
  }

  dispose(): void {
    this.view.dispose();
    this.tracks.dispose();
    setWeatherNow(CLEAR_WEATHER);
  }
}
