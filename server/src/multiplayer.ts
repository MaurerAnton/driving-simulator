// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Multiplayer sessions: the WebSocket relay.
 *
 * A session is made over HTTP (`POST /api/v1/sessions`, row in the
 * database) and lives in this hub while the server runs: who is connected,
 * who is host, each player's last snapshot.  The server relays, it does not
 * simulate: a `state` from one player goes to all others as it came
 * (unknown fields too), limited in rate and size.
 *
 * Rules:
 * - the account that made the session becomes host when it connects (if no
 *   one else is host by then); a host may kick (the kicked account – or for
 *   a guest the address – cannot come back into that session);
 * - when the host leaves, the session ends (`bye` "host_left") – unless it
 *   was made with `keep`, then the player who has been in longest becomes
 *   host (`host`);
 * - an empty session ends after `sessionEmptyMinutes` (30);
 * - the same account connecting again replaces its older connection;
 * - guests (no token, `&name=`) only where the session allows them and the
 *   admin's setting `guests` is on;
 * - per player: `state` up to 20 per second (15 Hz is what the game sends;
 *   more is dropped), `chat` 5 per 10 s, `event` 10 per second; a message
 *   may have at most 16 KB; a client flooding beyond 50 messages per second
 *   is disconnected; a WebSocket ping every 20 s, no answer for 60 s closes.
 */

import type { Db, SessionRow, Account } from './db.ts';
import { endSession, liveSessions, setSessionPlayers } from './db.ts';
import { RateLimiter } from './ratelimit.ts';
import { newId } from './tokens.ts';
import type { WsConnection } from './websocket.ts';

export const WS_MAX_MESSAGE = 16 * 1024;
const SNAPSHOT_MAX = 4096;
const EVENT_MAX = 8192;
const CHAT_MAX = 300;
const PING_MS = 20_000;
const TIMEOUT_MS = 60_000;

export interface Player {
  id: string;
  name: string;
  guest: boolean;
  account: string | null;
  /** Where a guest came from (to keep a kicked guest out). */
  ipKey: string;
  conn: WsConnection;
  joined: number;
  lastSeen: number;
  state: unknown;
}

export interface LiveSession {
  row: SessionRow;
  world: { map: string; x: number; z: number };
  players: Map<string, Player>;
  host: string | null;
  emptySince: number | null;
  banned: Set<string>;
}

export function sessionJson(s: LiveSession) {
  const host = s.host ? s.players.get(s.host) : undefined;
  return {
    id: s.row.id, code: s.row.code, title: s.row.title, world: s.world, public: !!s.row.public,
    guests: !!s.row.guests, keep: !!s.row.keep, maxPlayers: s.row.max_players, players: s.players.size,
    host: host ? host.name : null, created: s.row.created,
  };
}

const playerJson = (p: Player, host: string | null, withState: boolean) => ({
  id: p.id, name: p.name, guest: p.guest, host: p.id === host, ...(withState && p.state ? { s: p.state } : {}),
});

export class Hub {
  readonly db: Db;
  readonly emptyMs: number;
  readonly sessions = new Map<string, LiveSession>();
  private stateLimit = new RateLimiter(20, 20);
  private chatLimit = new RateLimiter(0.5, 5);
  private eventLimit = new RateLimiter(10, 20);
  private floodLimit = new RateLimiter(50, 100);
  private timer: NodeJS.Timeout;
  guestsAllowed: () => boolean;

  constructor(db: Db, emptyMinutes: number, guestsAllowed: () => boolean) {
    this.db = db;
    this.emptyMs = emptyMinutes * 60_000;
    this.guestsAllowed = guestsAllowed;
    const t = Date.now();
    // sessions that ran before a restart: everybody is gone, so they count as empty from now
    for (const row of liveSessions(db)) this.add(row, t);
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref();
  }

  add(row: SessionRow, t = Date.now()): LiveSession {
    let world = { map: '', x: 0, z: 0 };
    try { world = JSON.parse(row.world); } catch { /* keep the empty world */ }
    const s: LiveSession = { row, world, players: new Map(), host: null, emptySince: t, banned: new Set() };
    this.sessions.set(row.code, s);
    setSessionPlayers(this.db, row.id, 0);
    return s;
  }

  get(code: string): LiveSession | undefined {
    return this.sessions.get(code);
  }

  ownedBy(account: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.row.owner === account) n++;
    return n;
  }

  /** Ends the account's oldest session nobody is in (to make room for a new one); false when all are in use. */
  endOldestEmpty(account: string): boolean {
    const empty = [...this.sessions.values()].filter((s) => s.row.owner === account && !s.players.size)
      .sort((a, b) => a.row.created.localeCompare(b.row.created));
    return empty.length ? this.end(empty[0].row.code, 'replaced') : false;
  }

  /** Ends a session: every player gets `bye` with the reason and is disconnected. */
  end(code: string, reason: string): boolean {
    const s = this.sessions.get(code);
    if (!s) return false;
    this.sessions.delete(code);
    endSession(this.db, s.row.id);
    for (const p of s.players.values()) {
      p.conn.handlers = null;
      p.conn.send(JSON.stringify({ t: 'bye', reason }));
      p.conn.close(1000, reason);
    }
    s.players.clear();
    return true;
  }

  close(): void {
    clearInterval(this.timer);
    for (const s of this.sessions.values()) {
      for (const p of s.players.values()) {
        p.conn.handlers = null;
        p.conn.send(JSON.stringify({ t: 'bye', reason: 'server_stopping' }));
        p.conn.close(1001, 'server stopping');
      }
    }
  }

  private tick(): void {
    const t = Date.now();
    const ended = new Set(liveSessions(this.db).map((r) => r.code));
    for (const [code, s] of this.sessions) {
      if (!ended.has(code)) { this.end(code, 'ended'); continue; } // ended with the CLI
      if (s.emptySince !== null && t - s.emptySince > this.emptyMs) { this.end(code, 'expired'); continue; }
      for (const p of s.players.values()) {
        if (t - p.lastSeen > TIMEOUT_MS) {
          p.conn.send(JSON.stringify({ t: 'bye', reason: 'timeout' }));
          p.conn.close(1001, 'timeout');
        } else if (t - p.lastSeen > PING_MS / 2) p.conn.ping();
      }
    }
    for (const l of [this.stateLimit, this.chatLimit, this.eventLimit, this.floodLimit]) l.sweep(t);
  }

  /** Takes a freshly opened WebSocket into a session, or says `bye` why not. */
  connect(conn: WsConnection, code: string, who: { account: Account | null; guestName: string | null; badToken: boolean }, ipKey: string, maxPlayers: number): void {
    const refuse = (reason: string, wsCode: number) => {
      conn.send(JSON.stringify({ t: 'bye', reason }));
      conn.close(wsCode, reason);
    };
    const s = this.sessions.get(code);
    if (!s) return refuse('not_found', 4404);
    if (who.badToken) return refuse('bad_token', 4401);
    if (!who.account) {
      if (!who.guestName) return refuse('unauthorized', 4401);
      if (!s.row.guests || !this.guestsAllowed()) return refuse('guests_not_allowed', 4403);
    }
    if (s.banned.has(who.account ? 'a:' + who.account.id : 'ip:' + ipKey)) return refuse('kicked', 4403);
    // the same account again: the older connection goes
    let wasHost = false;
    if (who.account) {
      for (const old of [...s.players.values()]) {
        if (old.account !== who.account.id) continue;
        old.conn.handlers = null;
        old.conn.send(JSON.stringify({ t: 'bye', reason: 'replaced' }));
        old.conn.close(4000, 'replaced');
        s.players.delete(old.id);
        if (s.host === old.id) { s.host = null; wasHost = true; }
        this.broadcast(s, { t: 'leave', id: old.id, reason: 'replaced' });
      }
    }
    if (s.players.size >= Math.min(s.row.max_players, maxPlayers)) return refuse('full', 4409);
    const t = Date.now();
    const p: Player = {
      id: newId(10), name: who.account ? who.account.name : who.guestName!, guest: !who.account,
      account: who.account ? who.account.id : null, ipKey, conn, joined: t, lastSeen: t, state: null,
    };
    s.players.set(p.id, p);
    s.emptySince = null;
    if (wasHost || (!s.host && p.account === s.row.owner)) s.host = p.id;
    setSessionPlayers(this.db, s.row.id, s.players.size);
    conn.handlers = {
      onText: (text) => this.onMessage(s, p, text),
      onClose: () => this.leave(s, p, 'left'),
      onPong: () => { p.lastSeen = Date.now(); },
    };
    conn.send(JSON.stringify({
      t: 'hello', you: p.id, host: s.host, map: s.world.map, session: sessionJson(s),
      players: [...s.players.values()].map((q) => playerJson(q, s.host, q !== p)),
    }));
    this.broadcast(s, { t: 'join', player: playerJson(p, s.host, false) }, p.id);
    if (s.host === p.id) this.broadcast(s, { t: 'host', id: p.id }, p.id);
  }

  private broadcast(s: LiveSession, msg: unknown, except?: string): void {
    const text = JSON.stringify(msg);
    for (const q of s.players.values()) if (q.id !== except) q.conn.send(text);
  }

  private leave(s: LiveSession, p: Player, reason: string): void {
    if (s.players.get(p.id) !== p) return;
    s.players.delete(p.id);
    p.conn.handlers = null;
    if (this.sessions.get(s.row.code) !== s) return;
    setSessionPlayers(this.db, s.row.id, s.players.size);
    this.broadcast(s, { t: 'leave', id: p.id, reason });
    if (s.host === p.id) {
      s.host = null;
      if (!s.row.keep) {
        this.end(s.row.code, 'host_left');
        return;
      }
      const next = [...s.players.values()].sort((a, b) => Number(a.guest) - Number(b.guest) || a.joined - b.joined)[0];
      if (next) {
        s.host = next.id;
        this.broadcast(s, { t: 'host', id: next.id });
      }
    }
    if (!s.players.size) s.emptySince = Date.now();
  }

  private error(p: Player, code: string, message: string): void {
    p.conn.send(JSON.stringify({ t: 'error', code, message }));
  }

  private onMessage(s: LiveSession, p: Player, text: string): void {
    p.lastSeen = Date.now();
    if (!this.floodLimit.take(p.id)) {
      p.conn.send(JSON.stringify({ t: 'bye', reason: 'flood' }));
      p.conn.close(1008, 'flood');
      return;
    }
    let m: Record<string, unknown>;
    try {
      const v = JSON.parse(text);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      m = v;
    } catch {
      return this.error(p, 'bad_message', 'a message must be a JSON object');
    }
    switch (m.t) {
      case 'state': {
        const snap = m.s;
        if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return this.error(p, 'bad_state', 's must be an object');
        const o = snap as Record<string, unknown>;
        for (const k of ['x', 'y', 'z']) {
          if (typeof o[k] !== 'number' || !Number.isFinite(o[k] as number)) return this.error(p, 'bad_state', `s.${k} must be a number`);
        }
        if (JSON.stringify(snap).length > SNAPSHOT_MAX) return this.error(p, 'too_large', `a snapshot may have at most ${SNAPSHOT_MAX} bytes`);
        if (!this.stateLimit.take(p.id)) return; // above 20 Hz: dropped quietly
        p.state = snap;
        this.broadcast(s, { t: 'state', id: p.id, s: snap }, p.id);
        return;
      }
      case 'chat': {
        if (typeof m.text !== 'string') return this.error(p, 'bad_chat', 'text must be a string');
        const t = m.text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
        if (!t || t.length > CHAT_MAX) return this.error(p, 'bad_chat', `text must have 1 to ${CHAT_MAX} characters`);
        if (!this.chatLimit.take(p.id)) return this.error(p, 'rate_limited', 'too many chat messages, wait a moment');
        this.broadcast(s, { t: 'chat', id: p.id, name: p.name, text: t });
        return;
      }
      case 'event': {
        if (typeof m.kind !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(m.kind)) return this.error(p, 'bad_event', 'kind must match [a-z0-9_-]{1,32}');
        if (JSON.stringify(m.data ?? null).length > EVENT_MAX) return this.error(p, 'too_large', `event data may have at most ${EVENT_MAX} bytes`);
        if (!this.eventLimit.take(p.id)) return this.error(p, 'rate_limited', 'too many events');
        this.broadcast(s, { t: 'event', id: p.id, kind: m.kind, data: m.data ?? null }, p.id);
        return;
      }
      case 'kick': {
        if (s.host !== p.id) return this.error(p, 'not_host', 'only the host may kick');
        const q = typeof m.id === 'string' ? s.players.get(m.id) : undefined;
        if (!q || q === p) return this.error(p, 'bad_kick', 'no such other player');
        s.banned.add(q.account ? 'a:' + q.account : 'ip:' + q.ipKey);
        q.conn.send(JSON.stringify({ t: 'bye', reason: 'kicked' }));
        q.conn.handlers = null;
        q.conn.close(4003, 'kicked');
        this.leave(s, q, 'kicked');
        return;
      }
      case 'ping':
        p.conn.send(JSON.stringify({ t: 'pong', time: Date.now() }));
        return;
      default:
        return; // unknown types: ignored (newer games may send more)
    }
  }
}
