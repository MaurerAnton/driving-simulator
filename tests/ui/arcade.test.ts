// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The arcade panel's arithmetic: a moment as the date-and-time field shows
 * it and back, the quick choices of an hour, the clock in the HUD.
 *
 *   node --test tests/ui/arcade.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { atHour, clockBadge, fromLocalInput, localInput } from '../../src/ui/arcade.ts';

test('a moment and the date-and-time field: there and back', () => {
  const ms = new Date(2026, 10, 20, 17, 30).getTime();
  assert.equal(localInput(ms), '2026-11-20T17:30');
  assert.equal(fromLocalInput('2026-11-20T17:30'), ms);
  assert.ok(Number.isNaN(fromLocalInput('')));
  assert.ok(Number.isNaN(fromLocalInput('tomorrow')));
});

test('the quick choices: an hour of the same day, or of a day later', () => {
  const from = new Date(2026, 10, 20, 9, 41).getTime();
  assert.equal(atHour(from, 18), new Date(2026, 10, 20, 18, 0).getTime());
  assert.equal(atHour(from, 8, 1), new Date(2026, 10, 21, 8, 0).getTime());
});

test('the clock in the HUD names the day and the hour, and how much faster the time runs', () => {
  const ms = new Date(2026, 10, 20, 17, 30).getTime();
  const plain = clockBadge(ms, 1, 'de-DE');
  assert.match(plain, /17:30/);
  assert.match(clockBadge(ms, 4, 'de-DE'), /4×$/);
  assert.doesNotMatch(plain, /×/);
});
