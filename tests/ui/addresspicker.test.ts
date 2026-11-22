// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The map's search field waits for two characters before it looks – except for
 * a line number of public transport, which is whole at one ("5", "N3"): the
 * search for a line number must not be refused for being short.
 *
 *   node --test tests/ui/addresspicker.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLineToken } from '../../src/ui/addresspicker.ts';

test('a line number is whole at one character', () => {
  for (const q of ['5', '52', 'N3', 'n3', 'A49', 'x7']) assert.ok(isLineToken(q), q);
});

test('a name is not a line number', () => {
  for (const q of ['a', 'ab', 'rathaus', '5a', 'N', 'baunatal']) assert.ok(!isLineToken(q), q);
});

test('a line token with a space around it still counts', () => {
  assert.ok(isLineToken(' 5 '));
});
