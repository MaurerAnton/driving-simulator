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
import { RELEASES, VERSION, newsDue, sizeWords } from '../../src/game/releases.ts';
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
    for (const r of RELEASES) for (const key of [...r.items, ...(r.intro ? [r.intro] : []), 'news', 'newsVersion', 'news.size', ...(r.dev ? ['news.dev', 'news.devIntro'] : [])]) assert.ok(dict[key], `${lang.code}: ${key}`);
  }
});

test('the development versions come below the releases, oldest last, each with its commit', () => {
  const firstDev = RELEASES.findIndex((r) => r.dev);
  assert.ok(firstDev > 0, 'there are development versions, and they are not the newest');
  for (let i = 0; i < RELEASES.length; i++) {
    const r = RELEASES[i];
    assert.equal(r.dev === true, i >= firstDev, `${r.version}: all development versions together, below the releases`);
    if (r.dev) {
      assert.ok(r.version.startsWith('0.'), `${r.version}: before 1.0.0`);
      assert.match(r.commit ?? '', /^[0-9a-f]{40}$/, `${r.version}: its commit`);
      assert.ok(r.at !== '', `${r.version}: the moment of its commit`);
    } else assert.equal(r.commit, undefined, `${r.version}: a release is found by its tag`);
  }
  assert.equal(RELEASES[RELEASES.length - 1].version, '0.1.0');
});

test('every version says how big the game was – and it grew', () => {
  for (const [i, r] of RELEASES.entries()) {
    // (the newest: counted right before its release – node tools/release-stats.ts --fill X.Y.Z --worktree)
    if (r.size === null) {
      assert.ok(i === 0 && r.at === '', `${r.version}: the numbers are missing (node tools/release-stats.ts --fill ${r.version})`);
      continue;
    }
    const s = r.size;
    for (const k of ['lines', 'code', 'tests', 'i18n', 'bytes'] as const) assert.ok(Number.isInteger(s[k]) && s[k] >= 0, `${r.version}: ${k}`);
    assert.ok(s.code + s.tests + s.i18n <= s.lines, `${r.version}: the parts are lines among all`);
    assert.ok(s.code > 10_000 && s.lines < s.bytes, `${r.version}: plausible`);
  }
  const counted = RELEASES.filter((r) => r.size !== null);
  for (let i = 1; i < counted.length; i++) {
    const newer = counted[i - 1].size!;
    const older = counted[i].size!;
    const what = `${counted[i].version} → ${counted[i - 1].version}`;
    // (a version may tidy up a little, not lose a tenth)
    assert.ok(newer.lines >= older.lines * 0.9, `${what}: lines`);
    assert.ok(newer.code >= older.code * 0.9, `${what}: code`);
    assert.ok(newer.bytes >= older.bytes * 0.9, `${what}: bytes`);
    assert.ok(newer.lines <= older.lines * 3, `${what}: not more than three times as many lines at once`);
  }
  const w = sizeWords({ lines: 172000, code: 120400, tests: 17000, i18n: 36000, bytes: 11_600_000 }, 'en-GB');
  assert.deepEqual(w, { lines: '172,000', code: '120k', tests: '17k', texts: '36k', bytes: '11.6 MB', maps: '' }, 'no additional maps: no word for them');
  assert.equal(sizeWords({ lines: 1, code: 1, tests: 1, i18n: 1, bytes: 1_450_000 }, 'de-DE').bytes, '1,5 MB');
  // (the additional maps are counted apart from the game's own files)
  assert.equal(sizeWords({ lines: 1, code: 1, tests: 1, i18n: 1, bytes: 20_000_000, maps: 2_532_710_569 }, 'en-GB').maps, '2.5 GB');
  assert.equal(sizeWords({ lines: 1, code: 1, tests: 1, i18n: 1, bytes: 20_000_000, maps: 2_532_710_569 }, 'en-GB').bytes, '20.0 MB', 'the game is not inflated by the maps');
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
