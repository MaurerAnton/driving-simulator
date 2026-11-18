// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The HTTP server: every route of protocol v1 (server/PROTOCOL.md).
 *
 * Each request goes through, in this order: CORS (preflight answered here),
 * the per-IP rate limit, the bearer token (looked up by its keyed hash,
 * with a limit on failed attempts per IP), the per-token rate limit, then
 * the route.  Routes take ids only from fixed patterns; a request log line
 * has the method, the path without its query (tokens can be in a query) and
 * the status – never a header or a body.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';
import {
  type Account, type Db, type Settings, countAdmins, countProgressKinds, deleteAccount, deleteImageRow, deleteProgress,
  getAccount, getImage, getProgress, getSettings, insertSession, listAccounts, listProgress, listTokens, now, openDb,
  putProgress, putSettings, queryImages, revokeTokens, sessionByCode, tokenRow, touchToken, updateAccount, updateImage,
} from './db.ts';
import {
  ApiError, bad, clientIp, corsHeaders, forbidden, notFound, numIn, optBool, optNum, originAllowed, readBody, readJson,
  sendBytes, sendJson,
} from './http.ts';
import { boundaryOf, MultipartError, parseMultipart } from './multipart.ts';
import { Hub, sessionJson, WS_MAX_MESSAGE } from './multiplayer.ts';
import { perHour, perMinute } from './ratelimit.ts';
import {
  addToken, createAccount, imageJson, parseImageMeta, publicAccount, readImageFile, removeImageFiles,
  removeImageFilesById, storeImage, validName, type ImageMetaIn,
} from './services.ts';
import { CODE_RE, ID_RE, PREFIX_LEN, TOKEN_RE, hashToken, newCode, newId, sameHash } from './tokens.ts';
import { acceptUpgrade, rejectUpgrade } from './websocket.ts';

export const SERVER_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

export const SOURCE_URL = process.env.FAHRSIM_SOURCE_URL || 'https://github.com/MaurerAnton/driving-simulator';

export const PROGRESS_BYTES = 1024 * 1024;
const PROGRESS_KINDS_MAX = 100;
const KIND_RE = /^[a-z0-9_-]{1,32}$/;
const SESSIONS_PER_ACCOUNT = 5;
/** Uploads are read into memory whole; this many at once at most. */
const MAX_PARALLEL_UPLOADS = 6;
let uploadsRunning = 0;

export interface ServerSettings extends Settings {
  guests: boolean;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  ip: string;
  url: URL;
  account: Account | null;
  tokenHash: string | null;
  cors: Record<string, string>;
}

export interface App {
  server: Server;
  db: Db;
  hub: Hub;
  config: Config;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createApp(config: Config): App {
  const db = openDb(config.dataDir);
  const defaults: Settings = { registration: config.registration, motd: config.motd, origins: config.origins };
  const settings = (): ServerSettings => {
    const s = getSettings(db, defaults);
    const g = db.prepare("SELECT value FROM settings WHERE key = 'guests'").get() as { value: string } | undefined;
    return { ...s, guests: g ? JSON.parse(g.value) === true : true };
  };
  const hub = new Hub(db, config.sessionEmptyMinutes, () => settings().guests);

  const ipLimit = perMinute(config.ratePerIp);
  const tokenLimit = perMinute(config.ratePerToken);
  const authFailLimit = perMinute(30);
  const registerLimit = perHour(config.registrationsPerHour);
  const uploadLimit = perHour(config.uploadsPerHour);
  const sessionLimit = perHour(30);
  const wsPerIp = new Map<string, number>();
  const sweeper = setInterval(() => {
    for (const l of [ipLimit, tokenLimit, authFailLimit, registerLimit, uploadLimit, sessionLimit]) l.sweep();
  }, 60_000);
  sweeper.unref();

  const log = (ip: string, method: string, path: string, status: number, t0: number) => {
    if (config.log === 'quiet') return;
    console.log(`${new Date().toISOString()} ${ip} ${method} ${path} ${status} ${Date.now() - t0}ms`);
  };

  /** The account a token belongs to; null when there is no token; throws for a wrong one. */
  const authenticate = (token: string | null, ip: string): { account: Account; hash: string } | null => {
    if (token === null) return null;
    if (!authFailLimit.has(ip)) throw new ApiError(429, 'rate_limited', 'too many failed sign-ins, wait a minute');
    const hash = TOKEN_RE.test(token) ? hashToken(config.pepper, token) : null;
    const row = hash ? tokenRow(db, hash) : undefined;
    if (!hash || !row || !sameHash(row.hash, hash)) {
      authFailLimit.take(ip);
      throw new ApiError(401, 'bad_token', 'the token is not valid');
    }
    const account = getAccount(db, row.account);
    if (!account) throw new ApiError(401, 'bad_token', 'the token is not valid');
    if (account.disabled) throw forbidden('this account is disabled', 'account_disabled');
    if (!row.last_used || Date.now() - Date.parse(row.last_used) > 3600_000) touchToken(db, hash);
    return { account, hash };
  };

  const bearer = (req: IncomingMessage): string | null => {
    const h = req.headers.authorization;
    if (!h) return null;
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m) throw new ApiError(401, 'bad_token', 'Authorization must be "Bearer <token>"');
    return m[1];
  };

  const need = (c: Ctx): Account => {
    if (!c.account) throw new ApiError(401, 'unauthorized', 'sign in with a token first');
    return c.account;
  };
  const needAdmin = (c: Ctx): Account => {
    const a = need(c);
    if (!a.admin) throw forbidden('only an admin may do this', 'not_admin');
    return a;
  };
  const json = (c: Ctx, status: number, body: unknown, headers: Record<string, string> = {}) =>
    sendJson(c.res, status, body, { ...c.cors, ...headers });

  const accountJson = (a: Account) => ({ ...publicAccount(a), disabled: a.disabled });

  /** Refuses to leave the server without an admin. */
  const keepAnAdmin = (target: Account, becomesNonAdmin: boolean) => {
    if (becomesNonAdmin && target.admin && !target.disabled && countAdmins(db) <= 1) {
      throw new ApiError(409, 'last_admin', 'the last admin cannot be removed, disabled or made a normal account');
    }
  };

  const tokenOf = (body: Record<string, unknown>): unknown => body.token;

  // ------------------------------------------------------------ routes

  async function route(c: Ctx): Promise<void> {
    const { req, url } = c;
    const method = req.method ?? 'GET';
    const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1); // ['api','v1',…]
    if (url.pathname === '/' && method === 'GET') {
      c.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...c.cors });
      c.res.end(`Fahrsim Baunatal server ${SERVER_VERSION} – free software (AGPL-3.0-only).\nSource: ${SOURCE_URL}\nAPI: /api/v1/info\n`);
      return;
    }
    if (parts[0] !== 'api' || parts[1] !== 'v1') throw notFound();
    const p = parts.slice(2);
    const at = (...pat: string[]) => p.length === pat.length && pat.every((x, i) => x === '*' || x === p[i]);

    // info
    if (at('info') && method === 'GET') {
      const s = settings();
      return json(c, 200, {
        name: 'Fahrsim Baunatal server', server: SERVER_VERSION, api: 1,
        capabilities: ['accounts', 'images', 'images360', 'progress', 'multiplayer'],
        limits: {
          imageBytes: config.imageBytes, thumbBytes: config.thumbBytes, thumbSide: 1024, sessionPlayers: config.sessionPlayers,
          progressBytes: PROGRESS_BYTES, chatLength: 300, stateHz: 15, wsMessageBytes: WS_MAX_MESSAGE,
        },
        registration: s.registration, guests: s.guests, motd: s.motd, source: SOURCE_URL,
      });
    }

    // accounts
    if (at('accounts') && method === 'POST') {
      const s = settings();
      if (!s.registration) throw forbidden('self-registration is closed on this server', 'registration_closed');
      const body = await readJson(req, 4096);
      if (config.registrationsPerHour === 0 || !registerLimit.take(c.ip)) {
        throw new ApiError(429, 'rate_limited', 'too many new accounts from this address, try again later');
      }
      const r = createAccount(db, config.pepper, body.name);
      return json(c, 201, { account: publicAccount(r.account), token: r.token });
    }

    if (p[0] === 'me') {
      const a = need(c);
      if (at('me') && method === 'GET') return json(c, 200, publicAccount(a));
      if (at('me') && method === 'PATCH') {
        const body = await readJson(req, 4096);
        const u = updateAccount(db, a.id, { name: body.name === undefined ? undefined : validName(body.name) })!;
        return json(c, 200, publicAccount(u));
      }
      if (at('me') && method === 'DELETE') {
        keepAnAdmin(a, true);
        const ids = deleteAccount(db, a.id) ?? [];
        removeImageFilesById(config.dataDir, ids);
        return json(c, 200, { deleted: true });
      }
      if (at('me', 'tokens') && method === 'GET') return json(c, 200, { tokens: listTokens(db, a.id) });
      if (at('me', 'tokens') && method === 'POST') {
        const token = addToken(db, config.pepper, a.id);
        return json(c, 201, { token, prefix: token.slice(0, PREFIX_LEN) });
      }
      if (at('me', 'tokens', '*') && method === 'DELETE') {
        const n = revokeTokens(db, a.id, p[2]);
        if (!n) throw notFound('no token with this prefix');
        return json(c, 200, { revoked: n });
      }
      throw notFound();
    }

    // admin
    if (p[0] === 'admin') {
      needAdmin(c);
      if (at('admin', 'accounts') && method === 'GET') {
        return json(c, 200, { accounts: listAccounts(db).map((a) => ({ ...accountJson(a), tokens: a.tokens })) });
      }
      if (at('admin', 'accounts') && method === 'POST') {
        const body = await readJson(req, 4096);
        const r = createAccount(db, config.pepper, body.name, { admin: optBool(body.admin, 'admin'), token: tokenOf(body) });
        return json(c, 201, { account: accountJson(r.account), token: r.token });
      }
      if (p[1] === 'accounts' && p.length >= 3) {
        const target = getAccount(db, p[2]);
        if (!target) throw notFound('no such account');
        if (at('admin', 'accounts', '*') && method === 'GET') {
          return json(c, 200, { account: accountJson(target), tokens: listTokens(db, target.id) });
        }
        if (at('admin', 'accounts', '*') && method === 'PATCH') {
          const body = await readJson(req, 4096);
          const admin = optBool(body.admin, 'admin');
          const disabled = optBool(body.disabled, 'disabled');
          keepAnAdmin(target, admin === false || disabled === true);
          const u = updateAccount(db, target.id, {
            name: body.name === undefined ? undefined : validName(body.name), admin, disabled,
          })!;
          return json(c, 200, { account: accountJson(u) });
        }
        if (at('admin', 'accounts', '*') && method === 'DELETE') {
          keepAnAdmin(target, true);
          removeImageFilesById(config.dataDir, deleteAccount(db, target.id) ?? []);
          return json(c, 200, { deleted: true });
        }
        if (at('admin', 'accounts', '*', 'tokens') && method === 'GET') return json(c, 200, { tokens: listTokens(db, target.id) });
        if (at('admin', 'accounts', '*', 'tokens') && method === 'POST') {
          const body = await readJson(req, 4096, true);
          const token = addToken(db, config.pepper, target.id, tokenOf(body));
          return json(c, 201, { token, prefix: token.slice(0, PREFIX_LEN) });
        }
        if (at('admin', 'accounts', '*', 'tokens', '*') && method === 'DELETE') {
          const n = revokeTokens(db, target.id, p[4]);
          if (!n) throw notFound('no token with this prefix');
          return json(c, 200, { revoked: n });
        }
      }
      if (at('admin', 'settings') && method === 'GET') return json(c, 200, settings());
      if (at('admin', 'settings') && method === 'PATCH') {
        const body = await readJson(req, 16384);
        const patch: Partial<ServerSettings> = {};
        patch.registration = optBool(body.registration, 'registration');
        patch.guests = optBool(body.guests, 'guests');
        if (body.motd !== undefined) {
          if (typeof body.motd !== 'string' || body.motd.length > 1000) throw bad('motd must be a string of at most 1000 characters');
          patch.motd = body.motd;
        }
        if (body.origins !== undefined) {
          if (!Array.isArray(body.origins) || body.origins.length > 50
            || !body.origins.every((o) => typeof o === 'string' && (o === '*' || /^https?:\/\/[A-Za-z0-9.*-]+(:(\d{1,5}|\*))?$/.test(o)))) {
            throw bad('origins must be a list of at most 50 origins like "https://example.org" or "http://localhost:*"');
          }
          patch.origins = body.origins as string[];
        }
        putSettings(db, patch);
        return json(c, 200, settings());
      }
      if (at('admin', 'sessions') && method === 'GET') {
        return json(c, 200, {
          sessions: [...hub.sessions.values()].map((s) => ({
            ...sessionJson(s), owner: s.row.owner,
            playerList: [...s.players.values()].map((q) => ({ id: q.id, name: q.name, guest: q.guest, account: q.account })),
          })),
        });
      }
      if (at('admin', 'sessions', '*') && method === 'DELETE') {
        if (!hub.end(p[2], 'ended')) throw notFound('no such session');
        return json(c, 200, { ended: true });
      }
      throw notFound();
    }

    // images
    if (p[0] === 'images') {
      if (at('images') && method === 'POST') return uploadImage(c);
      if (at('images') && method === 'GET') {
        const q = url.searchParams;
        let bbox: [number, number, number, number] | undefined;
        if (q.has('bbox')) {
          const v = (q.get('bbox') ?? '').split(',').map(Number);
          if (v.length !== 4 || !v.every(Number.isFinite) || v[1] > v[3] || Math.abs(v[1]) > 90 || Math.abs(v[3]) > 90
            || Math.abs(v[0]) > 180 || Math.abs(v[2]) > 180) {
            throw bad('bbox must be minLon,minLat,maxLon,maxLat');
          }
          bbox = v as [number, number, number, number];
        }
        const kind = q.get('kind') ?? undefined;
        if (kind !== undefined && kind !== 'photo' && kind !== 'pano360') throw bad('kind must be photo or pano360');
        const limit = q.has('limit') ? numIn(Number(q.get('limit')), 'limit', 1, 1000) : 200;
        const all = q.get('all') === '1';
        if (all) needAdmin(c);
        const rows = queryImages(db, {
          bbox, kind, viewer: c.account?.id ?? null, mine: q.get('mine') === '1', all, limit: Math.floor(limit),
          owner: all ? q.get('owner') ?? undefined : undefined,
        });
        const names = new Map<string, string>();
        return json(c, 200, { images: rows.map((r) => imageJson(db, r, names)) });
      }
      if (p.length >= 2) {
        if (!ID_RE.test(p[1])) throw notFound('no such image');
        const r = getImage(db, p[1]);
        const mayView = r && (r.visibility === 'public' || r.owner === c.account?.id || c.account?.admin);
        if (!r || !mayView) throw notFound('no such image');
        const mayEdit = r.owner === c.account?.id || !!c.account?.admin;
        if (at('images', '*') && method === 'GET') return json(c, 200, { image: imageJson(db, r) });
        if ((at('images', '*', 'file') || at('images', '*', 'thumb')) && method === 'GET') {
          const thumb = p[2] === 'thumb';
          const data = readImageFile(config.dataDir, r, thumb);
          if (!data) throw notFound(thumb ? 'this image has no thumbnail' : 'the image file is missing');
          const etag = `"${r.id}${thumb ? 't' : ''}"`;
          const cache = r.visibility === 'public' ? 'public, max-age=86400' : 'private, max-age=3600';
          if (req.headers['if-none-match'] === etag) {
            c.res.writeHead(304, { ETag: etag, 'Cache-Control': cache, ...c.cors });
            c.res.end();
            return;
          }
          return sendBytes(c.res, thumb ? r.thumb_mime! : r.mime, data, { ETag: etag, 'Cache-Control': cache, ...c.cors });
        }
        if (at('images', '*') && method === 'PATCH') {
          if (!mayEdit) throw forbidden('only the owner or an admin may change an image');
          const body = await readJson(req, 8192);
          const m = parseImageMeta(body, true);
          updateImage(db, r.id, {
            lat: m.lat, lon: m.lon, heading: m.heading, pitch: m.pitch, taken: m.taken, title: m.title, visibility: m.visibility,
          });
          return json(c, 200, { image: imageJson(db, getImage(db, r.id)!) });
        }
        if (at('images', '*') && method === 'DELETE') {
          if (!mayEdit) throw forbidden('only the owner or an admin may delete an image');
          deleteImageRow(db, r.id);
          removeImageFiles(config.dataDir, r);
          return json(c, 200, { deleted: true });
        }
      }
      throw notFound();
    }

    // progress
    if (p[0] === 'progress') {
      const a = need(c);
      if (at('progress') && method === 'GET') {
        const out: Record<string, { rev: number; updated: string }> = {};
        for (const r of listProgress(db, a.id)) out[r.kind] = { rev: r.rev, updated: r.updated };
        return json(c, 200, out);
      }
      const kind = p[1];
      if (!KIND_RE.test(kind ?? '')) throw bad('a kind must match [a-z0-9_-]{1,32}', 'bad_kind');
      if (at('progress', '*') && method === 'GET') {
        const r = getProgress(db, a.id, kind);
        if (!r) throw notFound('nothing stored of this kind');
        return json(c, 200, { rev: r.rev, updated: r.updated, data: JSON.parse(r.data) });
      }
      if (at('progress', '*') && method === 'PUT') {
        const body = await readJson(req, config.jsonBytes);
        const rev = body.rev ?? 0;
        if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) throw bad('rev must be a whole number ≥ 0');
        if (!('data' in body)) throw bad('data is required');
        const text = JSON.stringify(body.data);
        if (Buffer.byteLength(text) > PROGRESS_BYTES) throw new ApiError(413, 'too_large', 'data may have at most 1 MB');
        if (rev === 0 && countProgressKinds(db, a.id) >= PROGRESS_KINDS_MAX && !getProgress(db, a.id, kind)) {
          throw new ApiError(409, 'too_many_kinds', `an account may keep at most ${PROGRESS_KINDS_MAX} kinds`);
        }
        if (!putProgress(db, a.id, kind, rev, text)) {
          const cur = getProgress(db, a.id, kind);
          throw new ApiError(409, 'conflict', 'the stored revision is newer; merge and retry',
            cur ? { rev: cur.rev, updated: cur.updated, data: JSON.parse(cur.data) } : { rev: 0, data: null });
        }
        return json(c, 200, { rev: rev + 1 });
      }
      if (at('progress', '*') && method === 'DELETE') {
        if (!deleteProgress(db, a.id, kind)) throw notFound('nothing stored of this kind');
        return json(c, 200, { deleted: true });
      }
      if (at('progress', '*', 'items') && method === 'POST') {
        const body = await readJson(req, config.jsonBytes);
        if (!('item' in body)) throw bad('item is required');
        const itemText = JSON.stringify(body.item);
        if (Buffer.byteLength(itemText) > PROGRESS_BYTES / 4) throw new ApiError(413, 'too_large', 'an item may have at most 256 KB');
        const cur = getProgress(db, a.id, kind);
        if (!cur && countProgressKinds(db, a.id) >= PROGRESS_KINDS_MAX) {
          throw new ApiError(409, 'too_many_kinds', `an account may keep at most ${PROGRESS_KINDS_MAX} kinds`);
        }
        const list: unknown[] = cur ? JSON.parse(cur.data) : [];
        if (!Array.isArray(list)) throw new ApiError(409, 'not_a_list', 'the stored document of this kind is not a list');
        list.push(body.item);
        let text = JSON.stringify(list);
        let dropped = 0;
        while (Buffer.byteLength(text) > PROGRESS_BYTES && list.length > 1) { // the oldest items go first
          const n = Math.max(1, Math.floor(list.length / 20));
          list.splice(0, n);
          dropped += n;
          text = JSON.stringify(list);
        }
        const rev = cur?.rev ?? 0;
        if (!putProgress(db, a.id, kind, rev, text)) throw new ApiError(409, 'conflict', 'changed meanwhile, retry');
        return json(c, 200, { rev: rev + 1, items: list.length, dropped });
      }
      throw notFound();
    }

    // sessions
    if (p[0] === 'sessions') {
      if (at('sessions') && method === 'POST') {
        const a = need(c);
        if (!sessionLimit.take(a.id)) throw new ApiError(429, 'rate_limited', 'too many new sessions, try again later');
        if (hub.ownedBy(a.id) >= SESSIONS_PER_ACCOUNT && !hub.endOldestEmpty(a.id)) {
          throw new ApiError(409, 'too_many_sessions', `an account may run at most ${SESSIONS_PER_ACCOUNT} sessions`);
        }
        const body = await readJson(req, 8192);
        const w = body.world;
        if (!w || typeof w !== 'object' || Array.isArray(w)) throw bad('world must be an object {map, x, z}');
        const wo = w as Record<string, unknown>;
        if (typeof wo.map !== 'string' || wo.map.length > 64 || /[\u0000-\u001f]/.test(wo.map)) throw bad('world.map must be a string of at most 64 characters');
        const world = { map: wo.map, x: numIn(wo.x, 'world.x', -1e7, 1e7), z: numIn(wo.z, 'world.z', -1e7, 1e7) };
        let title = '';
        if (body.title !== undefined && body.title !== null) {
          if (typeof body.title !== 'string') throw bad('title must be a string');
          title = body.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
          if (title.length > 60) throw bad('title may have at most 60 characters');
        }
        const maxPlayers = Math.floor(optNum(body.maxPlayers, 'maxPlayers', 2, config.sessionPlayers) ?? config.sessionPlayers);
        let code = newCode();
        for (let i = 0; i < 20 && (hub.get(code) || sessionByCode(db, code)); i++) code = newCode();
        if (hub.get(code) || sessionByCode(db, code)) throw new ApiError(503, 'busy', 'no free session code, try again');
        db.prepare('DELETE FROM sessions WHERE code = ? AND ended IS NOT NULL').run(code);
        const row = {
          id: newId(), code, owner: a.id, title, world: JSON.stringify(world), public: optBool(body.public, 'public') ? 1 : 0,
          guests: optBool(body.guests, 'guests') ? 1 : 0, keep: optBool(body.keep, 'keep') ? 1 : 0, max_players: maxPlayers,
          created: now(),
        };
        insertSession(db, row);
        const live = hub.add({ ...row, players: 0, ended: null });
        return json(c, 201, { session: sessionJson(live) });
      }
      if (at('sessions') && method === 'GET') {
        return json(c, 200, {
          sessions: [...hub.sessions.values()].filter((s) => s.row.public).map(sessionJson),
        });
      }
      if (at('sessions', '*') && method === 'GET') {
        const code = p[1].toUpperCase();
        const s = CODE_RE.test(code) ? hub.get(code) : undefined;
        if (!s) throw notFound('no such session');
        return json(c, 200, { session: sessionJson(s) });
      }
      throw notFound();
    }
    throw notFound();
  }

  async function uploadImage(c: Ctx): Promise<void> {
    const a = need(c);
    const boundary = boundaryOf(c.req.headers['content-type']);
    if (!boundary) throw bad('the upload must be multipart/form-data', 'bad_upload');
    if (!uploadLimit.take(a.id)) {
      c.req.resume();
      throw new ApiError(429, 'rate_limited', 'too many uploads, try again later');
    }
    if (uploadsRunning >= MAX_PARALLEL_UPLOADS) {
      c.req.resume();
      throw new ApiError(503, 'busy', 'the server is busy with other uploads, try again in a moment');
    }
    uploadsRunning++;
    let body: Buffer;
    try {
      body = await readBody(c.req, config.imageBytes + config.thumbBytes + 64 * 1024);
    } finally {
      uploadsRunning--;
    }
    let parts;
    try {
      parts = parseMultipart(body, boundary);
    } catch (e) {
      if (e instanceof MultipartError) throw bad(e.message, 'bad_upload');
      throw e;
    }
    const file = parts.find((x) => x.name === 'file');
    const metaPart = parts.find((x) => x.name === 'meta');
    const thumb = parts.find((x) => x.name === 'thumb');
    if (!file || !file.data.length) throw bad('the part "file" is missing', 'bad_upload');
    if (!metaPart) throw bad('the part "meta" is missing', 'bad_upload');
    if (file.data.length > config.imageBytes) throw new ApiError(413, 'too_large', `an image may have at most ${config.imageBytes} bytes`);
    if (thumb && thumb.data.length > config.thumbBytes) throw new ApiError(413, 'too_large', `a thumbnail may have at most ${config.thumbBytes} bytes`);
    let metaJson: unknown;
    try {
      metaJson = JSON.parse(metaPart.data.toString('utf8'));
    } catch {
      throw bad('meta is not valid JSON', 'bad_meta');
    }
    const meta = parseImageMeta(metaJson, false) as ImageMetaIn;
    const row = storeImage(db, config.dataDir, a.id, meta, file.data, thumb && thumb.data.length ? thumb.data : null);
    return json(c, 201, { image: imageJson(db, row) });
  }

  // ------------------------------------------------------------ server

  // a 25 MB upload over a slow mobile connection may take minutes
  const server = createServer({ requestTimeout: 900_000, headersTimeout: 20_000 }, (req, res) => {
    const t0 = Date.now();
    const ip = clientIp(req, config.trustProxy);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      url = new URL('http://x/');
    }
    const s = settings();
    const origin = req.headers.origin;
    const cors = corsHeaders(origin, s.origins);
    res.on('finish', () => log(ip, req.method ?? '?', url.pathname, res.statusCode, t0));
    const c: Ctx = { req, res, ip, url, account: null, tokenHash: null, cors };
    void (async () => {
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(origin && !cors['Access-Control-Allow-Origin'] ? 403 : 204, cors);
          res.end();
          return;
        }
        if (origin && !cors['Access-Control-Allow-Origin'] && url.pathname.startsWith('/api/')) {
          throw forbidden('this origin is not allowed on this server', 'origin_not_allowed');
        }
        if (!ipLimit.take(ip)) throw new ApiError(429, 'rate_limited', 'too many requests, slow down');
        const auth = authenticate(bearer(req), ip);
        if (auth) {
          c.account = auth.account;
          c.tokenHash = auth.hash;
          if (!tokenLimit.take(auth.hash)) throw new ApiError(429, 'rate_limited', 'too many requests, slow down');
        }
        await route(c);
      } catch (e) {
        if (res.headersSent) { res.destroy(); return; }
        if (e instanceof ApiError) {
          sendJson(res, e.status, { error: e.code, message: e.message, ...e.extra },
            { ...cors, ...(e.status === 429 ? { 'Retry-After': '60' } : {}) });
        } else {
          console.error(`${new Date().toISOString()} error on ${req.method} ${url.pathname}:`, e instanceof Error ? e.message : e);
          sendJson(res, 500, { error: 'internal', message: 'internal server error' }, cors);
        }
      }
    })();
  });

  // longer than the proxies' idle timeout, so a proxy never reuses a connection the server is just closing
  server.keepAliveTimeout = 65_000;

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const t0 = Date.now();
    const ip = clientIp(req, config.trustProxy);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    socket.on('error', () => {});
    const done = (status: number) => log(ip, 'WS', url.pathname, status, t0);
    if (url.pathname !== '/api/v1/ws') { done(404); return rejectUpgrade(socket, 404, 'Not Found'); }
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin, settings().origins)) { done(403); return rejectUpgrade(socket, 403, 'Forbidden'); }
    if (!ipLimit.take(ip) || (wsPerIp.get(ip) ?? 0) >= config.wsPerIp) { done(429); return rejectUpgrade(socket, 429, 'Too Many Requests'); }
    const conn = acceptUpgrade(req, socket, WS_MAX_MESSAGE);
    if (!conn) { done(400); return; }
    done(101);
    wsPerIp.set(ip, (wsPerIp.get(ip) ?? 0) + 1);
    socket.once('close', () => {
      const n = (wsPerIp.get(ip) ?? 1) - 1;
      if (n <= 0) wsPerIp.delete(ip); else wsPerIp.set(ip, n);
    });
    const q = url.searchParams;
    const code = (q.get('session') ?? '').toUpperCase();
    let account: Account | null = null;
    let badToken = false;
    const token = q.get('token');
    if (token) {
      try {
        account = authenticate(token, ip)?.account ?? null;
      } catch {
        badToken = true;
      }
    }
    let guestName: string | null = null;
    if (!account && q.get('name')) {
      try { guestName = validName(q.get('name')); } catch { guestName = null; }
    }
    hub.connect(conn, CODE_RE.test(code) ? code : '', { account, guestName, badToken }, ip, config.sessionPlayers);
    conn.feed(head);
  });

  return {
    server, db, hub, config,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : config.port);
      });
    }),
    close: () => new Promise((resolve) => {
      clearInterval(sweeper);
      hub.close();
      server.close(() => {
        db.close();
        resolve();
      });
      server.closeAllConnections();
    }),
  };
}
