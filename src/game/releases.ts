// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The versions of the game and what each of them brought – shown in the
 * game as "What's new", in every language (the texts are in src/i18n,
 * under news.<version>.*).  1.0.0 is the first release: its notes say what
 * there is in the game; those of later versions what changed.
 *
 * A new release: raise the version in package.json, put an entry at the top
 * of this list with the keys of its notes, and add the notes to every
 * language (tests/game/releases.test.ts checks that it all fits).  Its
 * `at` stays '' until the release is published; then the moment of it goes
 * in (gh release view vX.Y.Z --json publishedAt).  Every version in the list
 * can be played again from "What's new" (game/versions.ts).
 */

export interface Release {
  version: string;
  /** the day it was released (ISO) */
  date: string;
  /**
   * the moment it was published (ISO, as GitHub has it:
   * gh release view vX.Y.Z --json publishedAt) – '' until it is
   */
  at: string;
  /** a line before the list (i18n key), if there is one */
  intro?: string;
  /** what it brought: i18n keys, one line each */
  items: readonly string[];
}

export const RELEASES: readonly Release[] = [
  {
    version: '1.6.0',
    date: '2026-11-17',
    at: '2026-11-17T19:31:07Z',
    items: ['news.1_6_0.town', 'news.1_6_0.transit', 'news.1_6_0.versions', 'news.1_6_0.routes', 'news.1_6_0.spawn', 'news.1_6_0.forklift', 'news.1_6_0.camera', 'news.1_6_0.pause', 'news.1_6_0.faster', 'news.1_6_0.more'],
  },
  {
    version: '1.5.0',
    date: '2026-11-17',
    at: '2026-11-17T12:19:15Z',
    items: ['news.1_5_0.vehicles', 'news.1_5_0.doors', 'news.1_5_0.night', 'news.1_5_0.weather', 'news.1_5_0.traffic', 'news.1_5_0.change', 'news.1_5_0.watch', 'news.1_5_0.layers', 'news.1_5_0.search', 'news.1_5_0.favourites', 'news.1_5_0.autopilot', 'news.1_5_0.plane', 'news.1_5_0.foot', 'news.1_5_0.touch', 'news.1_5_0.loading', 'news.1_5_0.lights', 'news.1_5_0.more'],
  },
  {
    version: '1.4.0',
    date: '2026-11-17',
    at: '2026-11-17T01:52:42Z',
    items: ['news.1_4_0.menu', 'news.1_4_0.cranes', 'news.1_4_0.theory', 'news.1_4_0.traffic', 'news.1_4_0.weather', 'news.1_4_0.arcade', 'news.1_4_0.services', 'news.1_4_0.signs', 'news.1_4_0.plane', 'news.1_4_0.maps', 'news.1_4_0.transit', 'news.1_4_0.cockpit', 'news.1_4_0.sounds', 'news.1_4_0.autopilot', 'news.1_4_0.more'],
  },
  {
    version: '1.3.0',
    date: '2026-11-16',
    at: '2026-11-16T20:14:29Z',
    items: ['news.1_3_0.menu', 'news.1_3_0.replay', 'news.1_3_0.timetables', 'news.1_3_0.busLines', 'news.1_3_0.pantograph', 'news.1_3_0.coupled', 'news.1_3_0.figure', 'news.1_3_0.models'],
  },
  {
    version: '1.2.0',
    date: '2026-11-16',
    at: '2026-11-16T17:58:01Z',
    items: ['news.1_2_0.plane', 'news.1_2_0.onFoot', 'news.1_2_0.stops', 'news.1_2_0.tramLines', 'news.1_2_0.busLine', 'news.1_2_0.powers', 'news.1_2_0.motorcycle', 'news.1_2_0.farView', 'news.1_2_0.tours', 'news.1_2_0.loading', 'news.1_2_0.carModel', 'news.1_2_0.fixes'],
  },
  {
    version: '1.1.0',
    date: '2026-11-16',
    at: '2026-11-16T12:26:20Z',
    items: ['news.1_1_0.tram', 'news.1_1_0.classes', 'news.1_1_0.graphics', 'news.1_1_0.screen', 'news.1_1_0.wheels', 'news.1_1_0.onFoot'],
  },
  {
    version: '1.0.0',
    date: '2026-11-16',
    at: '2026-11-16T10:37:55Z',
    intro: 'news.1_0_0.intro',
    items: [
      'news.1_0_0.map',
      'news.1_0_0.rules',
      'news.1_0_0.instructor',
      'news.1_0_0.lessons',
      'news.1_0_0.vehicles',
      'news.1_0_0.physics',
      'news.1_0_0.traffic',
      'news.1_0_0.lights',
      'news.1_0_0.plan',
      'news.1_0_0.voice',
      'news.1_0_0.tours',
      'news.1_0_0.onFoot',
      'news.1_0_0.views',
      'news.1_0_0.start',
      'news.1_0_0.controls',
      'news.1_0_0.settings',
      'news.1_0_0.languages',
      'news.1_0_0.free',
    ],
  },
];

/** the version running now */
export const VERSION = RELEASES[0].version;

const KEY = 'fahrsim-baunatal.news';

/**
 * Should "What's new" be shown by itself now?  Once after an update, to
 * whoever had played an earlier version (someone who comes for the first
 * time has no use for a list of changes).  `played`: there are settings of
 * an earlier visit.
 */
export function newsDue(played: boolean, store: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): boolean {
  if (!store) return false;
  try {
    const seen = store.getItem(KEY);
    store.setItem(KEY, VERSION);
    return played && seen !== VERSION;
  } catch {
    return false;
  }
}
