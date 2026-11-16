// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The versions of the game and what each of them brought – shown in the
 * game as "What's new", in every language (the texts are in src/i18n,
 * under news.<version>.*).  1.0.0 is the first release: its notes say what
 * there is in the game; those of later versions what changed.
 *
 * A new release: raise the version in package.json, put an entry at the top
 * of this list with the keys of its notes, and add the notes to every
 * language (tests/game/releases.test.ts checks that it all fits).
 */

export interface Release {
  version: string;
  /** the day it was released (ISO) */
  date: string;
  /** a line before the list (i18n key), if there is one */
  intro?: string;
  /** what it brought: i18n keys, one line each */
  items: readonly string[];
}

export const RELEASES: readonly Release[] = [
  {
    version: '1.0.0',
    date: '2026-11-16',
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
