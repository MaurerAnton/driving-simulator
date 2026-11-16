// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the playtest asked for, as far as it can be checked without a browser:
 * the log of faults and the driven path survive a session, citations link to
 * the paragraphs, the engine can be made weaker, old settings move over.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FAULT_LOG_MAX, FaultLog } from '../../src/game/faultlog.ts';
import type { FaultEntry, KeyValueStore } from '../../src/game/faultlog.ts';
import { DrivenPath, PATH_MAX_POINTS } from '../../src/game/track.ts';
import { VIOLATION_REFS, citationParts } from '../../src/i18n/violations.ts';
import { BASE_POWER_PS, COMPACT_CAR, withPower } from '../../src/sim/vehicle/index.ts';
import { AERIAL_TILE_PX, aerialLevel, aerialTileSize, aerialTiles, aerialUrl } from '../../src/reality/aerial.ts';

/** A browser's storage, in memory. */
function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const fault = (t: number, id = 'speed'): FaultEntry => ({ t, id, severity: 'minor', data: { limit: 30, speed: 42 }, street: 'Marktplatz', mode: 'free', x: 10, z: -20 });

test('the log of faults is still there in the next session', () => {
  const store = memoryStore();
  const log = new FaultLog(store);
  assert.equal(log.entries.length, 0);
  log.add(fault(1000));
  log.add(fault(2000, 'redLight'));
  const next = new FaultLog(store);
  assert.deepEqual(next.entries.map((e) => e.id), ['speed', 'redLight']);
  assert.deepEqual(next.entries[0], fault(1000));
  next.clear();
  assert.equal(new FaultLog(store).entries.length, 0);
});

test('the log keeps the newest faults, survives rubbish in the storage and a browser without storage', () => {
  const store = memoryStore();
  const log = new FaultLog(store);
  for (let i = 0; i < FAULT_LOG_MAX + 25; i++) log.add(fault(i));
  assert.equal(log.entries.length, FAULT_LOG_MAX);
  assert.equal(log.entries[0].t, 25, 'the oldest ones made room');
  assert.equal(new FaultLog(store).entries.length, FAULT_LOG_MAX);

  const broken = memoryStore();
  broken.setItem('fahrsim-baunatal.faults.v1', '{"not":"a list"');
  assert.equal(new FaultLog(broken).entries.length, 0);
  broken.setItem('fahrsim-baunatal.faults.v1', JSON.stringify([fault(5), { t: 'x' }, null, { ...fault(6), severity: 'huge' }]));
  assert.deepEqual(new FaultLog(broken).entries.map((e) => e.t), [5], 'only what is a fault is taken over');

  const none = new FaultLog(null);
  none.add(fault(1));
  assert.equal(none.entries.length, 1, 'without storage the log lives as long as the page');
  const full: KeyValueStore = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  assert.doesNotThrow(() => new FaultLog(full).add(fault(1)));
});

test('every citation of the StVO leads to the text of its paragraph', () => {
  assert.deepEqual(citationParts('§ 37 Abs. 2 StVO'), [{ text: '§ 37 Abs. 2', url: 'https://www.gesetze-im-internet.de/stvo_2013/__37.html' }, { text: ' StVO' }]);
  assert.deepEqual(
    citationParts('§ 1 Abs. 2, § 3 Abs. 2a StVO').filter((p) => p.url).map((p) => [p.text, p.url?.split('/').pop()]),
    [['§ 1 Abs. 2', '__1.html'], ['§ 3 Abs. 2a', '__3.html']],
  );
  assert.equal(citationParts('§ 21a Abs. 1 StVO')[0].url, 'https://www.gesetze-im-internet.de/stvo_2013/__21a.html');
  assert.deepEqual(citationParts('§ 9 Abs. 1, Abs. 3 StVO')[0], { text: '§ 9 Abs. 1, Abs. 3', url: 'https://www.gesetze-im-internet.de/stvo_2013/__9.html' });
  assert.deepEqual(citationParts('Anlage 2 StVO, Zeichen 206')[0], { text: 'Anlage 2', url: 'https://www.gesetze-im-internet.de/stvo_2013/anlage_2.html' });
  for (const [id, ref] of Object.entries(VIOLATION_REFS)) {
    const parts = citationParts(ref);
    assert.equal(parts.map((p) => p.text).join(''), ref, `${id}: nothing of the citation is lost`);
    if (/§|Anlage/.test(ref)) assert.ok(parts.some((p) => p.url), `${id}: "${ref}" has no link`);
    // (the StVO, or – for the tasks of the truck test – the annex of the driving-licence regulation)
    for (const p of parts) if (p.url) assert.match(p.url, /^https:\/\/www\.gesetze-im-internet\.de\/(stvo_2013\/(__\d+[a-z]?|anlage_\d)|fev_2010\/anlage_\d|strabbo_1987\/__\d+)\.html$/);
  }
  // (the tram's rules link to the tram regulation)
  assert.equal(citationParts('§ 54 Abs. 2 BOStrab')[0].url, 'https://www.gesetze-im-internet.de/strabbo_1987/__54.html');
  {
  }
});

test('the driven path: points a few metres apart, broken by jumps, kept between sessions', () => {
  const store = memoryStore();
  const path = new DrivenPath(store);
  for (let i = 0; i <= 100; i++) path.add(i, 0); // 100 m straight on, one call per metre
  assert.ok(path.points.length / 2 >= 12 && path.points.length / 2 <= 14, `${path.points.length / 2} points for 100 m`);
  assert.ok(Math.abs(path.length() - 96) < 9, `length ${path.length()}`);
  path.add(5000, 5000); // put somewhere else
  path.add(5010, 5000);
  const breaks = path.points.filter((v) => Number.isNaN(v)).length / 2;
  assert.equal(breaks, 1, 'a jump breaks the line');
  assert.ok(path.length() < 120, 'the jump is not driven distance');
  path.save();
  const next = new DrivenPath(store);
  assert.ok(Math.abs(next.length() - path.length()) < 2, 'the path of the last session is there');
  next.add(5010, 5000);
  assert.equal(next.points.filter((v) => Number.isNaN(v)).length / 2, 2, 'a new session starts a new stretch');
  for (let i = 0; i < PATH_MAX_POINTS + 500; i++) next.add(i * 9, 9000);
  assert.ok(next.points.length <= PATH_MAX_POINTS * 2, 'old points make room');
  next.clear();
  assert.equal(new DrivenPath(store).points.length, 0);
});

test('engine power: the torque curve follows the rated power, pulling away stays easy', () => {
  const power = (spec: typeof COMPACT_CAR): number => Math.max(...spec.torqueCurve.map(([rpm, t]) => (t * rpm * 2 * Math.PI) / 60 / 735.5));
  assert.ok(Math.abs(power(COMPACT_CAR) - BASE_POWER_PS) < 12, `the base engine has ${power(COMPACT_CAR).toFixed(0)} PS`);
  assert.equal(withPower(COMPACT_CAR, BASE_POWER_PS), COMPACT_CAR, 'the base power is the car as it is');
  for (const ps of [60, 75, 95, 115, 200]) {
    const s = withPower(COMPACT_CAR, ps);
    assert.ok(Math.abs(power(s) / power(COMPACT_CAR) - ps / BASE_POWER_PS) < 0.02, `${ps} PS: ${power(s).toFixed(0)}`);
    assert.equal(s.torqueCurve.length, COMPACT_CAR.torqueCurve.length);
    assert.equal(s.mass, COMPACT_CAR.mass);
  }
  const small = withPower(COMPACT_CAR, 75);
  const at = (spec: typeof COMPACT_CAR, rpm: number): number => spec.torqueCurve.find((p) => p[0] === rpm)![1];
  assert.ok(at(small, 1000) > at(COMPACT_CAR, 1000) * 0.68, 'near idle the small engine keeps most of its torque');
  assert.ok(Math.abs(at(small, 3500) - at(COMPACT_CAR, 3500) / 2) < 1, 'at speed it has half');
  assert.ok(withPower(COMPACT_CAR, 200).clutchTorque > COMPACT_CAR.clutchTorque, 'a stronger engine gets a stronger clutch');
});

test('aerial photographs: tiles in the map\'s own coordinates, fine enough for the zoom', () => {
  assert.equal(aerialTileSize(0), AERIAL_TILE_PX * 0.2);
  assert.equal(aerialLevel(5), 0, 'close up: the finest pictures (20 cm)');
  assert.equal(aerialLevel(0.02), 8, 'the whole map: the coarsest');
  for (let s = 0.02; s < 6; s *= 1.3) {
    const level = aerialLevel(s);
    const res = 0.2 * 2 ** level; // metres per pixel of the pictures
    assert.ok(level === 0 || res <= (1 / s) * 1.3, `at ${s.toFixed(2)} px/m pictures of ${res} m/px are too coarse`);
  }
  const tiles = aerialTiles(2, 527900, 5677900, 528500, 5678100);
  assert.ok(tiles.length >= 2);
  const size = aerialTileSize(2);
  for (const t of tiles) {
    assert.ok(Math.abs(t.minE - t.col * size) < 1e-6 && Math.abs(t.minN - t.row * size) < 1e-6, 'tiles lie on the grid of their level');
    assert.ok(t.minE < 528500 && t.minE + size > 527900 && t.minN < 5678100 && t.minN + size > 5677900, 'every tile touches the rectangle');
  }
  const covered = new Set(tiles.map((t) => `${t.col}/${t.row}`));
  assert.equal(covered.size, tiles.length, 'no tile twice');
  const url = new URL(aerialUrl(tiles[0]));
  assert.equal(url.protocol, 'https:');
  assert.equal(url.searchParams.get('CRS'), 'EPSG:25832');
  const box = (url.searchParams.get('BBOX') ?? '').split(',').map(Number);
  assert.ok(Math.abs(box[0] - tiles[0].minE) < 0.01 && Math.abs(box[1] - tiles[0].minN) < 0.01 && Math.abs(box[2] - box[0] - size) < 0.02 && Math.abs(box[3] - box[1] - size) < 0.02, 'east, north, east, north');
  assert.equal(url.searchParams.get('WIDTH'), String(AERIAL_TILE_PX));
});
