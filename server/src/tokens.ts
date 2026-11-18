// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Access tokens, ids and the codes of multiplayer sessions.
 *
 * A token is a secret string (letters, digits, `-`, `_`, `.`; at least 8
 * characters, at most 128).  Made by the server, it has 32 random
 * base64url characters (192 bits).  The admin may set a custom one, e.g. a
 * word to hand out on paper.
 *
 * Tokens are never stored: the database keeps HMAC-SHA-256(pepper, token),
 * so a stolen database alone does not reveal or let one test tokens without
 * the pepper (which lives outside the database, in the environment or the
 * data directory's `pepper` file).  A keyed hash rather than scrypt because
 * the token must be found by its hash on every request; the lookup goes
 * through the primary key and the found hash is compared again in constant
 * time.  The first six characters are kept in clear to name a token
 * (revoking, listing) – that is 36 of 192 bits for a generated token.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const TOKEN_RE = /^[A-Za-z0-9_.-]{8,128}$/;
export const PREFIX_LEN = 6;

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashToken(pepper: string, token: string): string {
  return createHmac('sha256', pepper).update(token, 'utf8').digest('hex');
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export const tokenPrefix = (token: string): string => token.slice(0, PREFIX_LEN);

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** A random id of `n` characters (lower-case letters and digits without look-alikes); used in paths and file names. */
export function newId(n = 16): string {
  let s = '';
  for (let i = 0; i < n; i++) s += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return s;
}

export const ID_RE = /^[a-z0-9]{8,32}$/;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** A session code: six upper-case letters without I and O. */
export function newCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export const CODE_RE = /^[A-Z]{6}$/;
