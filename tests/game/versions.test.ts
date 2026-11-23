// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The earlier versions on the site (src/game/versions.ts, tools/old-versions.ts):
 * the list read, the addresses from wherever a version runs, which versions
 * get room, the moments of the releases – and how picked map files are
 * sorted (src/world/mappack.ts).
 *
 *   node --test tests/game/versions.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { RELEASES } from '../../src/game/releases.ts';
import { compareVersions, keepForReturn, loadVersions, parseVersions, playable, restoreAfterOldVersion, siteRoot, versionHref, versionOfPath } from '../../src/game/versions.ts';
import { missingPart, packSources } from '../../src/world/mappack.ts';
import { DEV_VERSIONS, MAP_READABLE_FROM, backLink, chooseHosted, earlierVersions, olderTags } from '../../tools/old-versions.ts';

test('versions compare as numbers, not as text', () => {
  assert.equal(compareVersions('1.10.0', '1.9.2'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
});

test('the list of the site is read – and nothing else is taken for it', () => {
  const list = parseVersions({
    latest: '1.6.0',
    versions: [
      { version: '1.0.0', hosted: true, at: '2026-11-16T10:37:55+01:00' },
      { version: '1.5.0', hosted: true },
      { version: '1.6.0', hosted: true },
      { version: 'x', hosted: true },
      { version: '1.1.0', hosted: false },
      { version: '0.9.0', hosted: true, map: false },
    ],
  });
  assert.ok(list);
  assert.deepEqual(list.versions.map((v) => v.version), ['1.5.0', '1.1.0', '1.0.0', '0.9.0']);
  assert.equal(list.versions[2].at, '2026-11-16T10:37:55+01:00');
  assert.ok(playable(list, '1.6.0'));
  assert.ok(playable(list, '1.5.0'));
  assert.ok(!playable(list, '1.1.0'), 'not on the site');
  assert.ok(!playable(list, '0.9.0'), 'cannot read the map');
  assert.ok(!playable(list, '1.3.0'), 'not in the list');
  assert.equal(parseVersions(null), null);
  assert.equal(parseVersions({ latest: 'new', versions: [] }), null);
  assert.equal(parseVersions('<!doctype html>'), null);
});

test('the addresses: the top of the site from the newest and from an earlier version', () => {
  const site = 'https://example.org/driving-simulator/';
  assert.equal(siteRoot(site), site);
  assert.equal(siteRoot(`${site}index.html?lang=de`), site);
  assert.equal(siteRoot(`${site}v/1.2.0/`), site);
  assert.equal(siteRoot(`${site}v/1.2.0/index.html`), site);
  assert.equal(versionOfPath(`${site}v/1.2.0/`), '1.2.0');
  assert.equal(versionOfPath(site), null);
  assert.equal(versionHref(site, '1.2.0', '1.6.0'), `${site}v/1.2.0/`);
  assert.equal(versionHref(site, '1.6.0', '1.6.0'), site);
  // (at the top of a domain too)
  assert.equal(siteRoot('http://127.0.0.1:4173/v/1.0.0/'), 'http://127.0.0.1:4173/');
});

test('without a list (a development server answers with its page) there are no versions', async () => {
  const page = async (): Promise<Response> => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
  assert.equal(await loadVersions('http://127.0.0.1:5173/', page as typeof fetch), null);
});

test('the earlier versions are the older tags, newest first, and the newest get the room', () => {
  assert.deepEqual(olderTags(['v1.0.0', 'v1.5.0', 'v1.10.0', 'v1.6.0', 'karte-2026-11-16c', 'v1.2.0-rc1', ''], '1.6.0'), ['1.5.0', '1.0.0']);
  const sizes = new Map([
    ['1.5.0', 6],
    ['1.4.0', 6],
    ['1.3.0', 5],
    ['1.2.0', 3],
  ]);
  assert.deepEqual([...chooseHosted(['1.5.0', '1.4.0', '1.3.0', '1.2.0', '1.1.0'], sizes, 15)], ['1.5.0', '1.4.0', '1.2.0']);
  assert.match(backLink('1.2.0'), /href="\.\.\/\.\.\/"/);
});

test('the development versions are earlier versions too – built from their commits, those from 0.8.0 on with today\'s map', () => {
  assert.deepEqual(
    DEV_VERSIONS.map((d) => d.version),
    ['0.9.0', '0.8.0', '0.7.0', '0.6.0', '0.5.0', '0.4.0', '0.3.0', '0.2.0', '0.1.0'],
  );
  for (const d of DEV_VERSIONS) assert.match(d.commit, /^[0-9a-f]{40}$/, d.version);
  const dev = [
    { version: '0.9.0', commit: 'a'.repeat(40) },
    { version: '0.1.0', commit: 'b'.repeat(40) },
    { version: '1.0.0', commit: 'c'.repeat(40) },
  ];
  assert.deepEqual(earlierVersions(['v1.0.0', 'v1.1.0', 'v1.2.0'], dev, '1.2.0'), ['1.1.0', '1.0.0', '0.9.0', '0.1.0']);
  // which can read the map of today: 0.8.0 on (before it: world.json and tiles of another coding)
  assert.equal(MAP_READABLE_FROM, '0.8.0');
  const readable = DEV_VERSIONS.filter((d) => compareVersions(d.version, MAP_READABLE_FROM) >= 0).map((d) => d.version);
  assert.deepEqual(readable, ['0.9.0', '0.8.0']);
});

test('every release has the moment it was published, on its day', () => {
  for (const r of RELEASES) {
    if (r.at === '') continue;
    const t = Date.parse(r.at);
    assert.ok(Number.isFinite(t), `${r.version}: ${r.at}`);
    // (the day as it was in Germany)
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
    assert.equal(day, r.date, r.version);
  }
});

test('picked map files: the parts in order, the map first, a gap told', () => {
  const f = (name: string): File => new File([new Uint8Array(1)], name);
  const s = packSources([f('timetable.json.gz'), f('map.tar.10'), f('tiles-patch.tar'), f('map.tar.02'), f('map.tar.00'), f('map.tar.01 (1)')]);
  assert.deepEqual(
    s.map((x) => [x.kind, x.files.map((y) => y.name).join(',')]),
    [
      ['tar', 'map.tar.00,map.tar.01 (1),map.tar.02,map.tar.10'],
      ['tar', 'tiles-patch.tar'],
      ['file', 'timetable.json.gz'],
    ],
  );
  assert.equal(s[2].path, 'timetable.json.gz');
  assert.equal(missingPart(s), 'map.tar.03');
  assert.equal(missingPart(packSources([f('map.tar.00'), f('map.tar.01')])), null);
  assert.equal(missingPart(packSources([f('map.tar.01'), f('map.tar.02')])), 'map.tar.00');
  assert.equal(packSources([f('map.tar.gz')])[0].gzip, true);
});

test('an earlier version does not spoil the settings of the newest', () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  const site = 'https://example.org/ds/';
  m.set('fahrsim-baunatal.settings.v2', '{"vehicle":"semi"}');
  m.set('fahrsim-baunatal.news', '1.6.0');
  keepForReturn(site, store);
  // the earlier version resets what it does not know – and restores nothing itself
  m.set('fahrsim-baunatal.settings.v2', '{"vehicle":"car"}');
  m.set('fahrsim-baunatal.news', '1.2.0');
  restoreAfterOldVersion(`${site}v/1.2.0/`, store);
  assert.equal(m.get('fahrsim-baunatal.settings.v2'), '{"vehicle":"car"}');
  restoreAfterOldVersion(site, store);
  assert.equal(m.get('fahrsim-baunatal.settings.v2'), '{"vehicle":"semi"}');
  assert.equal(m.get('fahrsim-baunatal.news'), '1.6.0');
  // (once: later changes stay)
  m.set('fahrsim-baunatal.settings.v2', '{"vehicle":"bus"}');
  restoreAfterOldVersion(site, store);
  assert.equal(m.get('fahrsim-baunatal.settings.v2'), '{"vehicle":"bus"}');
});

test('an archive of its own holds the earlier versions: they are played from there, on this site\'s map', () => {
  const list = parseVersions({
    latest: '1.7.0',
    archive: 'https://example.github.io/archive/',
    versions: [
      { version: '1.6.0', hosted: false, map: true },
      { version: '0.9.0', hosted: false, map: true },
      { version: '0.7.0', hosted: false, map: false },
    ],
  })!;
  assert.equal(list.archive, 'https://example.github.io/archive/');
  // (hosted: false here – the archive has them: playable, and the address is in the archive)
  assert.ok(playable(list, '1.6.0'));
  assert.ok(playable(list, '0.9.0'));
  assert.ok(!playable(list, '0.7.0'), 'cannot read the map of today');
  assert.equal(versionHref('https://example.github.io/site/', '1.6.0', '1.7.0', list.archive), 'https://example.github.io/archive/v/1.6.0/');
  // (the newest is still this site's, and without an archive the versions lie below it)
  assert.equal(versionHref('https://example.github.io/site/', '1.7.0', '1.7.0', list.archive), 'https://example.github.io/site/');
  assert.equal(versionHref('https://example.github.io/site/', '1.6.0', '1.7.0'), 'https://example.github.io/site/v/1.6.0/');
  // (an archive that is not a full http address is ignored)
  assert.equal(parseVersions({ latest: '1.7.0', archive: 'nope', versions: [] })!.archive, undefined);
});
