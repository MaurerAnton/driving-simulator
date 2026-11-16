// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The versions and their notes ("What's new"): the newest is the version of
 * package.json, every note is there in every language, it is shown once
 * after an update – to whoever played before.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RELEASES, VERSION, newsDue } from '../../src/game/releases.ts';
import { LANGS } from '../../src/i18n/index.ts';

test('the newest release is the version of the game, and the versions go down the list', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(VERSION, pkg.version, 'package.json and src/game/releases.ts name the same version');
  const num = (v: string): number => v.split('.').reduce((a, p) => a * 1000 + Number(p), 0);
  for (let i = 1; i < RELEASES.length; i++) assert.ok(num(RELEASES[i - 1].version) > num(RELEASES[i].version), 'newest first');
  for (const r of RELEASES) {
    assert.match(r.version, /^\d+\.\d+\.\d+$/);
    assert.ok(!Number.isNaN(Date.parse(r.date)));
    assert.ok(r.items.length > 0);
  }
});

test('every note of every release is there in every language', async () => {
  for (const lang of LANGS) {
    // (the language's own file: the game would fall back to English for what is missing)
    const dict = ((await import(`../../src/i18n/${lang.code}.ts`)) as { default: Record<string, string> }).default;
    for (const r of RELEASES) for (const key of [...r.items, ...(r.intro ? [r.intro] : []), 'news', 'newsVersion']) assert.ok(dict[key], `${lang.code}: ${key}`);
  }
});

test('“What’s new” comes once after an update – not for whoever comes for the first time', () => {
  const data = new Map<string, string>();
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  assert.equal(newsDue(false, store), false, 'a first visit');
  assert.equal(newsDue(true, store), false, 'and after it: the notes of this version were not news to them');
  data.clear();
  data.set('fahrsim-baunatal.news', '0.9.0');
  assert.equal(newsDue(true, store), true, 'played an earlier version: shown');
  assert.equal(newsDue(true, store), false, 'once');
  assert.equal(newsDue(true, null), false, 'without storage: never');
});
