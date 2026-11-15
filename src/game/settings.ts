// SPDX-License-Identifier: AGPL-3.0-only
/** User settings, persisted in localStorage. */

export type Transmission = 'assist' | 'manual' | 'automatic';
export type Quality = 'low' | 'medium' | 'high';

export interface WheelMapping {
  steerAxis: number;
  throttleAxis: number;
  brakeAxis: number;
  clutchAxis: number;
  /** pedal axes rest at +1 and go to -1 when pressed (typical for wheels) */
  pedalsInverted: boolean;
  /** degrees of wheel rotation lock to lock as configured in the wheel's driver */
  wheelRange: number;
  /** button indices of an H-shifter: [1st … 6th, reverse] */
  shifter: number[];
}

export interface Settings {
  lang: 'de' | 'en';
  transmission: Transmission;
  quality: Quality;
  /** off | one mirror per frame | all mirrors every frame */
  mirrors: 'off' | 'alternate' | 'full';
  /** show the current speed limit and the next priority sign in the HUD */
  hudRules: boolean;
  /** show the engaged gear in the instrument cluster */
  hudGear: boolean;
  /** spoken instructor (browser speech synthesis) */
  voice: boolean;
  volume: number;
  /** traffic density 0 … 1 */
  traffic: number;
  drawDistance: number;
  wheel: WheelMapping;
  invertLookY: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  lang: typeof navigator !== 'undefined' && !navigator.language.toLowerCase().startsWith('de') ? 'en' : 'de',
  transmission: 'assist',
  quality: 'medium',
  mirrors: 'alternate',
  hudRules: true,
  hudGear: true,
  voice: false,
  volume: 0.7,
  traffic: 0.6,
  drawDistance: 1300,
  wheel: { steerAxis: 0, throttleAxis: 2, brakeAxis: 5, clutchAxis: 1, pedalsInverted: true, wheelRange: 900, shifter: [12, 13, 14, 15, 16, 17, 18] },
  invertLookY: false,
};

const KEY = 'fahrsim-baunatal.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return { ...DEFAULT_SETTINGS, ...parsed, wheel: { ...DEFAULT_SETTINGS.wheel, ...(parsed.wheel ?? {}) } };
    }
  } catch {
    /* private mode or corrupted entry: fall back to defaults */
  }
  return { ...DEFAULT_SETTINGS, wheel: { ...DEFAULT_SETTINGS.wheel } };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
