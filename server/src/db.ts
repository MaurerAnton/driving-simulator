// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The database (node:sqlite, one file `fahrsim.db` in the data directory) and
 * every query the server and the CLI make.
 *
 * Tables:
 * - `accounts`: id, name, admin flag, disabled flag, creation time;
 * - `tokens`: access tokens, stored only as a keyed hash (see tokens.ts),
 *   with the first six characters kept in clear to name a token;
 * - `settings`: what the admin changes at run time (registration, motd,
 *   origins), as JSON values;
 * - `images`: the metadata of uploaded photos and panoramas (the bytes are
 *   files under `images/`);
 * - `progress`: the player's opaque documents, one per account and kind,
 *   with a revision number for conflict detection;
 * - `sessions`: multiplayer sessions (who is connected lives only in the
 *   running server; the table lets the CLI list and end sessions).
 *
 * The database runs in WAL mode, so the CLI may use it while the server runs.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL,
  created TEXT NOT NULL,
  last_used TEXT
);
CREATE INDEX IF NOT EXISTS tokens_account ON tokens(account);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  heading REAL,
  pitch REAL,
  taken TEXT,
  title TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  thumb_mime TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS images_pos ON images(lon, lat);
CREATE INDEX IF NOT EXISTS images_owner ON images(owner);
CREATE TABLE IF NOT EXISTS progress (
  account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  rev INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated TEXT NOT NULL,
  PRIMARY KEY (account, kind)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  world TEXT NOT NULL,
  public INTEGER NOT NULL,
  guests INTEGER NOT NULL,
  keep INTEGER NOT NULL,
  max_players INTEGER NOT NULL,
  players INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  ended TEXT
);
`;

export function openDb(dataDir: string): Db {
  const db = new DatabaseSync(join(dataDir, 'fahrsim.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export const now = (): string => new Date().toISOString();

// ---------------------------------------------------------------- accounts

export interface AccountRow {
  id: string;
  name: string;
  admin: number;
  disabled: number;
  created: string;
}

export interface Account {
  id: string;
  name: string;
  admin: boolean;
  disabled: boolean;
  created: string;
}

export const toAccount = (r: AccountRow): Account => ({
  id: r.id, name: r.name, admin: !!r.admin, disabled: !!r.disabled, created: r.created,
});

export function insertAccount(db: Db, a: { id: string; name: string; admin: boolean }): Account {
  const created = now();
  db.prepare('INSERT INTO accounts (id, name, admin, disabled, created) VALUES (?, ?, ?, 0, ?)')
    .run(a.id, a.name, a.admin ? 1 : 0, created);
  return { id: a.id, name: a.name, admin: a.admin, disabled: false, created };
}

export function getAccount(db: Db, id: string): Account | null {
  const r = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
  return r ? toAccount(r) : null;
}

/** Finds an account by id, or else by exact name (CLI convenience); null when none or the name is ambiguous. */
export function findAccount(db: Db, idOrName: string): Account | null {
  const byId = getAccount(db, idOrName);
  if (byId) return byId;
  const rows = db.prepare('SELECT * FROM accounts WHERE name = ?').all(idOrName) as unknown as AccountRow[];
  return rows.length === 1 ? toAccount(rows[0]) : null;
}

export function listAccounts(db: Db): (Account & { tokens: number })[] {
  const rows = db.prepare(
    'SELECT a.*, (SELECT COUNT(*) FROM tokens t WHERE t.account = a.id) AS tokens FROM accounts a ORDER BY created',
  ).all() as unknown as (AccountRow & { tokens: number })[];
  return rows.map((r) => ({ ...toAccount(r), tokens: r.tokens }));
}

export function updateAccount(db: Db, id: string, p: { name?: string; admin?: boolean; disabled?: boolean }): Account | null {
  const a = getAccount(db, id);
  if (!a) return null;
  const name = p.name ?? a.name;
  const admin = p.admin ?? a.admin;
  const disabled = p.disabled ?? a.disabled;
  db.prepare('UPDATE accounts SET name = ?, admin = ?, disabled = ? WHERE id = ?')
    .run(name, admin ? 1 : 0, disabled ? 1 : 0, id);
  return { ...a, name, admin, disabled };
}

export function countAdmins(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE admin = 1 AND disabled = 0').get() as { n: number }).n;
}

/** Deletes an account with its tokens, progress and image rows; returns the ids of its images (files to remove). */
export function deleteAccount(db: Db, id: string): string[] | null {
  if (!getAccount(db, id)) return null;
  const images = (db.prepare('SELECT id FROM images WHERE owner = ?').all(id) as unknown as { id: string }[]).map((r) => r.id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  return images;
}

// ---------------------------------------------------------------- tokens

export interface TokenInfo {
  prefix: string;
  created: string;
  lastUsed: string | null;
}

export function insertToken(db: Db, account: string, hash: string, prefix: string): boolean {
  try {
    db.prepare('INSERT INTO tokens (hash, account, prefix, created) VALUES (?, ?, ?, ?)').run(hash, account, prefix, now());
    return true;
  } catch {
    return false; // the same token exists already
  }
}

export function tokenRow(db: Db, hash: string): { hash: string; account: string; last_used: string | null } | undefined {
  return db.prepare('SELECT hash, account, last_used FROM tokens WHERE hash = ?').get(hash) as
    { hash: string; account: string; last_used: string | null } | undefined;
}

export function touchToken(db: Db, hash: string): void {
  db.prepare('UPDATE tokens SET last_used = ? WHERE hash = ?').run(now(), hash);
}

export function listTokens(db: Db, account: string): TokenInfo[] {
  const rows = db.prepare('SELECT prefix, created, last_used FROM tokens WHERE account = ? ORDER BY created')
    .all(account) as unknown as { prefix: string; created: string; last_used: string | null }[];
  return rows.map((r) => ({ prefix: r.prefix, created: r.created, lastUsed: r.last_used }));
}

/** Revokes every token of `account` starting with `prefix`; returns how many. */
export function revokeTokens(db: Db, account: string, prefix: string): number {
  return Number(db.prepare('DELETE FROM tokens WHERE account = ? AND prefix = ?').run(account, prefix).changes);
}

export function countTokens(db: Db, account: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE account = ?').get(account) as { n: number }).n;
}

// ---------------------------------------------------------------- settings

export interface Settings {
  registration: boolean;
  motd: string;
  origins: string[];
}

export function getSettings(db: Db, defaults: Settings): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as unknown as { key: string; value: string }[];
  const s: Settings = { ...defaults, origins: [...defaults.origins] };
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value);
      if (r.key === 'registration' && typeof v === 'boolean') s.registration = v;
      if (r.key === 'motd' && typeof v === 'string') s.motd = v;
      if (r.key === 'origins' && Array.isArray(v) && v.every((o) => typeof o === 'string')) s.origins = v;
    } catch { /* a broken value falls back to the default */ }
  }
  return s;
}

export function putSettings(db: Db, p: Partial<Settings>): void {
  const st = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(p)) if (v !== undefined) st.run(k, JSON.stringify(v));
}

// ---------------------------------------------------------------- images

export interface ImageRow {
  id: string;
  owner: string;
  kind: string;
  lat: number;
  lon: number;
  heading: number | null;
  pitch: number | null;
  taken: string | null;
  title: string;
  visibility: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  thumb_mime: string | null;
  created: string;
  updated: string;
}

export function insertImage(db: Db, r: ImageRow): void {
  db.prepare(`INSERT INTO images (id, owner, kind, lat, lon, heading, pitch, taken, title, visibility, mime, width,
    height, bytes, thumb_mime, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.id, r.owner, r.kind, r.lat, r.lon, r.heading, r.pitch, r.taken, r.title, r.visibility, r.mime, r.width,
      r.height, r.bytes, r.thumb_mime, r.created, r.updated);
}

export function getImage(db: Db, id: string): ImageRow | null {
  return (db.prepare('SELECT * FROM images WHERE id = ?').get(id) as ImageRow | undefined) ?? null;
}

export function updateImage(db: Db, id: string, p: Partial<Pick<ImageRow, 'lat' | 'lon' | 'heading' | 'pitch' | 'taken' | 'title' | 'visibility'>>): void {
  const keys = Object.keys(p).filter((k) => (p as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return;
  const sql = `UPDATE images SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated = ? WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => (p as Record<string, string | number | null>)[k]), now(), id);
}

export function deleteImageRow(db: Db, id: string): void {
  db.prepare('DELETE FROM images WHERE id = ?').run(id);
}

export interface ImageQuery {
  bbox?: [number, number, number, number];
  kind?: string;
  /** The caller (their private images are included); null for anonymous. */
  viewer: string | null;
  /** Only the viewer's own. */
  mine?: boolean;
  /** Admins see everything. */
  all?: boolean;
  owner?: string;
  limit: number;
}

export function queryImages(db: Db, q: ImageQuery): ImageRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.bbox) {
    const [minLon, minLat, maxLon, maxLat] = q.bbox;
    where.push('lat BETWEEN ? AND ?');
    args.push(minLat, maxLat);
    if (minLon <= maxLon) {
      where.push('lon BETWEEN ? AND ?');
      args.push(minLon, maxLon);
    } else { // across the antimeridian
      where.push('(lon >= ? OR lon <= ?)');
      args.push(minLon, maxLon);
    }
  }
  if (q.kind) { where.push('kind = ?'); args.push(q.kind); }
  if (q.owner) { where.push('owner = ?'); args.push(q.owner); }
  if (q.mine) {
    where.push('owner = ?');
    args.push(q.viewer ?? '');
  } else if (!q.all) {
    if (q.viewer) { where.push("(visibility = 'public' OR owner = ?)"); args.push(q.viewer); }
    else where.push("visibility = 'public'");
  }
  const sql = `SELECT * FROM images ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created DESC LIMIT ?`;
  args.push(q.limit);
  return db.prepare(sql).all(...args) as unknown as ImageRow[];
}

// ---------------------------------------------------------------- progress

export interface ProgressRow {
  kind: string;
  rev: number;
  data: string;
  updated: string;
}

export function listProgress(db: Db, account: string): { kind: string; rev: number; updated: string }[] {
  return db.prepare('SELECT kind, rev, updated FROM progress WHERE account = ? ORDER BY kind').all(account) as
    unknown as { kind: string; rev: number; updated: string }[];
}

export function getProgress(db: Db, account: string, kind: string): ProgressRow | null {
  return (db.prepare('SELECT kind, rev, data, updated FROM progress WHERE account = ? AND kind = ?').get(account, kind) as
    ProgressRow | undefined) ?? null;
}

/** Writes `data` as revision rev+1 if the stored revision is still `rev` (0 = none yet); false on a conflict. */
export function putProgress(db: Db, account: string, kind: string, rev: number, data: string): boolean {
  if (rev === 0) {
    const r = db.prepare('INSERT OR IGNORE INTO progress (account, kind, rev, data, updated) VALUES (?, ?, 1, ?, ?)')
      .run(account, kind, data, now());
    return Number(r.changes) === 1;
  }
  const r = db.prepare('UPDATE progress SET rev = rev + 1, data = ?, updated = ? WHERE account = ? AND kind = ? AND rev = ?')
    .run(data, now(), account, kind, rev);
  return Number(r.changes) === 1;
}

export function countProgressKinds(db: Db, account: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM progress WHERE account = ?').get(account) as { n: number }).n;
}

export function deleteProgress(db: Db, account: string, kind: string): boolean {
  return Number(db.prepare('DELETE FROM progress WHERE account = ? AND kind = ?').run(account, kind).changes) === 1;
}

// ---------------------------------------------------------------- sessions

export interface SessionRow {
  id: string;
  code: string;
  owner: string;
  title: string;
  world: string;
  public: number;
  guests: number;
  keep: number;
  max_players: number;
  players: number;
  created: string;
  ended: string | null;
}

export function insertSession(db: Db, r: Omit<SessionRow, 'players' | 'ended'>): void {
  db.prepare(`INSERT INTO sessions (id, code, owner, title, world, public, guests, keep, max_players, players, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(r.id, r.code, r.owner, r.title, r.world, r.public, r.guests, r.keep, r.max_players, r.created);
}

export function liveSessions(db: Db): SessionRow[] {
  return db.prepare('SELECT * FROM sessions WHERE ended IS NULL ORDER BY created').all() as unknown as SessionRow[];
}

export function sessionByCode(db: Db, code: string): SessionRow | null {
  return (db.prepare('SELECT * FROM sessions WHERE code = ? AND ended IS NULL').get(code) as SessionRow | undefined) ?? null;
}

export function setSessionPlayers(db: Db, id: string, players: number): void {
  db.prepare('UPDATE sessions SET players = ? WHERE id = ?').run(players, id);
}

export function endSession(db: Db, idOrCode: string): boolean {
  const r = db.prepare('UPDATE sessions SET ended = ? WHERE (id = ? OR code = ?) AND ended IS NULL').run(now(), idOrCode, idOrCode);
  return Number(r.changes) > 0;
}

/** Removes ended sessions older than a day (the table is only a list of what runs). */
export function pruneSessions(db: Db): void {
  db.prepare('DELETE FROM sessions WHERE ended IS NOT NULL AND ended < ?').run(new Date(Date.now() - 86400_000).toISOString());
}
