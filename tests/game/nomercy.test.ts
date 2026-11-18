// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 1.7.1: the weather on the vehicle and the roads (windscreen, wet roads, mud) and the real seasons belong to the
 * new "No mercy" preset only, which never comes by itself; and the simpler physics (even grip) are the default.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { seasonShown } from '../../src/game/outdoors.ts';
import { DEFAULT_SETTINGS, GRAPHICS_PRESETS, SETTINGS_VERSION, loadSettings } from '../../src/game/settings.ts';

function storage(entries: Record<string, string> = {}): void {
  const m = new Map(Object.entries(entries));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) },
  });
}
const KEY = 'fahrsim-baunatal.settings.v2';

test('only "No mercy" has the weather on the vehicle and the roads; it is never the default', () => {
  for (const q of ['low', 'medium', 'high', 'ultra'] as const) assert.equal(GRAPHICS_PRESETS[q].weatherFx, false, q);
  assert.equal(GRAPHICS_PRESETS.nomercy.weatherFx, true);
  assert.deepEqual({ ...GRAPHICS_PRESETS.nomercy, weatherFx: false }, GRAPHICS_PRESETS.ultra);
  assert.notEqual(DEFAULT_SETTINGS.quality, 'nomercy');
  storage();
  assert.equal(loadSettings().graphics.weatherFx, false);
});

test('settings of 1.7.0 and before: "very high" loses the weather effects, a custom choice with the fine vehicles keeps them', () => {
  const load = (quality: string, graphics: object) => {
    storage({ [KEY]: JSON.stringify({ version: 2, quality, graphics }) });
    return loadSettings().graphics.weatherFx;
  };
  const { weatherFx: _, ...ultra170 } = GRAPHICS_PRESETS.ultra;
  assert.equal(load('ultra', ultra170), false);
  assert.equal(load('custom', { ...ultra170 }), true);
  assert.equal(load('custom', { ...ultra170, vehicleDetail: false }), false);
});

test('simpler physics by default, also for settings stored before 1.7.1 – a choice made since stays', () => {
  assert.equal(DEFAULT_SETTINGS.evenRoads, true);
  storage({ [KEY]: JSON.stringify({ version: 2, evenRoads: false }) });
  assert.equal(loadSettings().evenRoads, true);
  storage({ [KEY]: JSON.stringify({ version: SETTINGS_VERSION, evenRoads: false }) });
  assert.equal(loadSettings().evenRoads, false);
});

test('always summer unless "No mercy" (a season chosen is shown all the same)', () => {
  assert.equal(seasonShown({ season: 'real', graphics: { weatherFx: false } }), 'summer');
  assert.equal(seasonShown({ season: 'real', graphics: { weatherFx: true } }), 'real');
  assert.equal(seasonShown({ season: 'winter', graphics: { weatherFx: false } }), 'winter');
});
