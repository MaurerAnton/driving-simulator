// SPDX-License-Identifier: AGPL-3.0-only
/** Which notice of the instructor is shown in the street-name block. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NoticeBoard, noticeColour } from '../../src/ui/notices.ts';

test('of several notices the gravest shows, the newest among equals', () => {
  const b = new NoticeBoard();
  assert.equal(b.current(0), null);
  b.add('Too fast', 'why', 'minor · § 3', 'minor', 8, 1000);
  assert.equal(b.current(1000)?.title, 'Too fast');
  b.add('Hint', '', '', 'hint', 5.5, 1500);
  assert.equal(b.current(1500)?.title, 'Too fast', 'a hint does not push a fault aside');
  b.add('Red light', 'why', 'fail · § 37', 'fail', 8, 2000);
  assert.equal(b.current(2000)?.title, 'Red light', 'the serious fault takes over');
  b.add('No indicator', '', '', 'minor', 8, 2500);
  assert.equal(b.current(2500)?.title, 'Red light', 'a later minor one does not hide it');
  b.add('Crash', '', '', 'fail', 8, 3000);
  assert.equal(b.current(3000)?.title, 'Crash', 'equally grave: the newest');
  // as they run out, the next gravest that is still current comes back
  assert.equal(b.current(10500)?.title, 'Crash');
  assert.equal(b.current(11200), null, 'all over after their time');
  assert.equal(b.count, 0);
});

test('a notice runs out; the same one again starts afresh instead of piling up', () => {
  const b = new NoticeBoard();
  b.add('Too fast', '', '', 'minor', 8, 0);
  b.add('Red light', '', '', 'major', 2, 0);
  assert.equal(b.current(1000)?.title, 'Red light');
  assert.equal(b.current(2500)?.title, 'Too fast', 'the minor one is still current when the major one has run out');
  b.add('Too fast', '', '', 'minor', 8, 7000);
  assert.equal(b.count, 1);
  assert.equal(b.current(12000)?.title, 'Too fast', 'renewed: counts from the second time');
  assert.equal(b.current(15001), null);
  b.add('x', '', '', 'hint', 5, 0);
  b.clear();
  assert.equal(b.current(1), null);
});

test('red for serious faults, yellow for the rest', () => {
  const n = (severity: 'fail' | 'major' | 'minor' | 'hint') => ({ title: '', why: '', meta: '', severity, at: 0, until: 1 });
  assert.deepEqual([noticeColour(n('fail')), noticeColour(n('major')), noticeColour(n('minor')), noticeColour(n('hint'))], ['red', 'red', 'yellow', 'yellow']);
});
