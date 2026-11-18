// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The server's configuration, read from environment variables.
 *
 * Everything has a default so that `node src/main.ts` runs as it is for a
 * local test; a real installation sets at least FAHRSIM_DATA (where the
 * database and the images live) and FAHRSIM_PEPPER (the secret mixed into
 * every stored token hash; without it a random one is made once and kept in
 * the data directory, file `pepper`).
 *
 * Settings the admin may change while the server runs (self-registration,
 * message of the day, allowed origins) start from these values and are then
 * kept in the database (see db.ts, `settings`).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Config {
  /** TCP port to listen on (0 = any free one, for tests). */
  port: number;
  host: string;
  /** Directory of the database and the image files. */
  dataDir: string;
  /** Secret mixed into token hashes. */
  pepper: string;
  /** Number of reverse proxies in front of the server whose X-Forwarded-For is trusted (0 = none). */
  trustProxy: number;
  /** Initial list of allowed browser origins (`*` in a port or a host part is a wildcard). */
  origins: string[];
  /** Initial value of self-registration. */
  registration: boolean;
  motd: string;
  /** Largest accepted image file. */
  imageBytes: number;
  /** Largest accepted thumbnail. */
  thumbBytes: number;
  /** Most players in one multiplayer session. */
  sessionPlayers: number;
  /** HTTP requests per minute and IP address. */
  ratePerIp: number;
  /** HTTP requests per minute and token. */
  ratePerToken: number;
  /** New accounts per hour and IP address (self-registration). */
  registrationsPerHour: number;
  /** Image uploads per hour and account. */
  uploadsPerHour: number;
  /** Largest JSON request body (bytes). */
  jsonBytes: number;
  /** Minutes until an empty multiplayer session ends. */
  sessionEmptyMinutes: number;
  /** Simultaneous WebSocket connections per IP address. */
  wsPerIp: number;
  /** Request log: 'info' (one line per request) or 'quiet'. */
  log: 'info' | 'quiet';
}

function num(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${key} must be a number from ${min} to ${max}`);
  return Math.floor(v);
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${key} must be true or false`);
}

export const DEFAULT_ORIGINS = ['https://maureranton.github.io', 'http://localhost:*', 'http://127.0.0.1:*'];

/** Reads the pepper from the environment or from `<dataDir>/pepper`, making one the first time. */
function loadPepper(env: NodeJS.ProcessEnv, dataDir: string): string {
  const fromEnv = env.FAHRSIM_PEPPER;
  if (fromEnv) {
    if (fromEnv.length < 16) throw new Error('FAHRSIM_PEPPER must have at least 16 characters');
    return fromEnv;
  }
  const file = join(dataDir, 'pepper');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const pepper = randomBytes(32).toString('base64url');
  writeFileSync(file, pepper + '\n', { mode: 0o600 });
  return pepper;
}

/** Builds the configuration from `env` (process.env by default); `over` replaces single fields (tests). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, over: Partial<Config> = {}): Config {
  const dataDir = resolve(over.dataDir ?? env.FAHRSIM_DATA ?? './data');
  mkdirSync(dataDir, { recursive: true });
  const origins = env.FAHRSIM_ORIGINS
    ? env.FAHRSIM_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ORIGINS;
  const log = env.FAHRSIM_LOG === 'quiet' ? 'quiet' : 'info';
  const cfg: Config = {
    port: num(env, 'FAHRSIM_PORT', 8080, 0, 65535),
    host: env.FAHRSIM_HOST || '0.0.0.0',
    dataDir,
    pepper: over.pepper ?? loadPepper(env, dataDir),
    trustProxy: num(env, 'FAHRSIM_TRUST_PROXY', 0, 0, 10),
    origins,
    registration: bool(env, 'FAHRSIM_REGISTRATION', false),
    motd: env.FAHRSIM_MOTD ?? '',
    imageBytes: num(env, 'FAHRSIM_IMAGE_BYTES', 26214400, 1024, 512 * 1024 * 1024),
    thumbBytes: num(env, 'FAHRSIM_THUMB_BYTES', 524288, 1024, 16 * 1024 * 1024),
    sessionPlayers: num(env, 'FAHRSIM_SESSION_PLAYERS', 16, 2, 256),
    ratePerIp: num(env, 'FAHRSIM_RATE_IP', 600, 1, 1_000_000),
    ratePerToken: num(env, 'FAHRSIM_RATE_TOKEN', 1200, 1, 1_000_000),
    registrationsPerHour: num(env, 'FAHRSIM_REGISTRATIONS_PER_HOUR', 5, 0, 100_000),
    uploadsPerHour: num(env, 'FAHRSIM_UPLOADS_PER_HOUR', 120, 0, 100_000),
    jsonBytes: num(env, 'FAHRSIM_JSON_BYTES', 1_200_000, 1024, 64 * 1024 * 1024),
    sessionEmptyMinutes: num(env, 'FAHRSIM_SESSION_EMPTY_MINUTES', 30, 1, 24 * 60),
    wsPerIp: num(env, 'FAHRSIM_WS_PER_IP', 8, 1, 10_000),
    log,
  };
  return { ...cfg, ...over, dataDir };
}
