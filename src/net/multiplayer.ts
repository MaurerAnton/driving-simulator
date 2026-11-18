// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Playing together (server/PROTOCOL.md, "Multiplayer"): a session one
 * player hosts and others join by its code, a WebSocket through which each
 * sends where their vehicle is 12 times a second and gets everybody else's,
 * a chat, and the host's right to send somebody away.
 *
 * The server only relays; nothing is simulated together.  Each player's
 * traffic, lights and weather stay their own – only the players' vehicles
 * are shared, drawn where their snapshots say, ~100 ms in the past so that
 * there are always two snapshots to go between (RemoteTrack: like the
 * smoothly drawn cars one watches).
 *
 * No DOM and no three.js here: the WebSocket class and the clock are handed
 * in (tests bring fakes).
 */
import { backoff } from './client.ts';
import type { ServerClient } from './client.ts';

/** Where a player's vehicle is and what it shows – sent ≤ 15 times a second. */
export interface Snapshot {
  /** the sender's clock, ms */
  time: number;
  /** the vehicle kind (game/vehicles.ts VehicleKind; 'pedestrian' on foot) */
  kind: string;
  /** its colour, '#rrggbb' */
  paint?: string;
  x: number;
  y: number;
  z: number;
  /** 0 = facing north, positive = to the left (radians) */
  yaw: number;
  pitch: number;
  roll: number;
  /** m/s */
  speed: number;
  /** the front wheels' angle (radians) */
  steer: number;
  /** LIGHT_* bits */
  lights: number;
  signal: -1 | 0 | 1;
  brake: boolean;
  horn: boolean;
  walker?: { walk?: number; moving?: boolean };
  [more: string]: unknown;
}

export const LIGHT_LOW = 1;
export const LIGHT_HIGH = 2;
export const LIGHT_HAZARD = 4;
export const LIGHT_REVERSE = 8;

/** how far in the past the others are drawn (ms) */
export const DELAY = 100;
/** how long a vehicle is carried on along its last motion when nothing new comes (ms) */
const EXTRAPOLATE = 250;
/** how many snapshots are kept per player */
const KEEP = 24;
/** how often the own state goes out (Hz) */
export const SEND_HZ = 12;

const wrap = (a: number): number => {
  let d = a % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** An angle part of the way from a to b, the short way round. */
export function lerpAngle(a: number, b: number, f: number): number {
  return a + wrap(b - a) * f;
}

/** A snapshot from the wire made safe: every number finite, the known fields of the right type – or null. */
export function cleanSnapshot(s: unknown): Snapshot | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  const n = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  if (typeof o.x !== 'number' || typeof o.z !== 'number' || !Number.isFinite(o.x) || !Number.isFinite(o.z)) return null;
  const sig = n(o.signal);
  return {
    ...o,
    time: n(o.time),
    kind: typeof o.kind === 'string' ? o.kind.slice(0, 32) : 'car',
    paint: typeof o.paint === 'string' && /^#[0-9a-f]{6}$/i.test(o.paint) ? o.paint : undefined,
    x: o.x,
    y: n(o.y),
    z: o.z,
    yaw: n(o.yaw),
    pitch: n(o.pitch),
    roll: n(o.roll),
    speed: n(o.speed),
    steer: Math.max(-1, Math.min(1, n(o.steer))),
    lights: n(o.lights) | 0,
    signal: sig < 0 ? -1 : sig > 0 ? 1 : 0,
    brake: o.brake === true,
    horn: o.horn === true,
    walker: o.walker && typeof o.walker === 'object' ? (o.walker as Snapshot['walker']) : undefined,
  };
}

/**
 * One other player's snapshots, and where to draw them now.  The sender's
 * clock is not ours: the difference is learned from the snapshots (the
 * smallest seen – the one that came quickest), and they are drawn DELAY ms
 * behind the newest one there could be.
 */
export class RemoteTrack {
  private readonly list: Snapshot[] = [];
  /** our clock minus theirs, the least seen (ms) */
  private offset = Number.POSITIVE_INFINITY;
  /** when (our clock) the last snapshot came */
  lastSeen = 0;

  add(s: Snapshot, now: number): void {
    const list = this.list;
    // (out of order or twice: the older one is not wanted)
    if (list.length > 0 && s.time <= list[list.length - 1].time) {
      // (the sender's clock jumped back – a reload: start anew)
      if (list[list.length - 1].time - s.time > 5000) {
        list.length = 0;
        this.offset = Number.POSITIVE_INFINITY;
      } else return;
    }
    list.push(s);
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    // (the offset may grow a little over time – the clocks drift: let it creep up)
    const o = now - s.time;
    this.offset = o < this.offset ? o : this.offset + Math.min(o - this.offset, 0.02 * Math.max(0, now - this.lastSeen));
    this.lastSeen = now;
  }

  get latest(): Snapshot | null {
    return this.list.length > 0 ? this.list[this.list.length - 1] : null;
  }

  /** Where it is to be drawn at our time `now` – into `out` (the newer snapshot's other fields with it). False: nothing yet. */
  sample(now: number, out: Snapshot): boolean {
    const list = this.list;
    if (list.length === 0) return false;
    const t = now - this.offset - DELAY;
    let i = list.length - 1;
    while (i > 0 && list[i - 1].time > t) i--;
    // i: the first snapshot at or after t (or the oldest)
    const b = list[i];
    const a = i > 0 ? list[i - 1] : null;
    Object.assign(out, b);
    if (a && t <= b.time) {
      const f = b.time > a.time ? Math.max(0, Math.min(1, (t - a.time) / (b.time - a.time))) : 1;
      out.x = a.x + (b.x - a.x) * f;
      out.y = a.y + (b.y - a.y) * f;
      out.z = a.z + (b.z - a.z) * f;
      out.yaw = lerpAngle(a.yaw, b.yaw, f);
      out.pitch = lerpAngle(a.pitch, b.pitch, f);
      out.roll = lerpAngle(a.roll, b.roll, f);
      out.speed = a.speed + (b.speed - a.speed) * f;
      out.steer = a.steer + (b.steer - a.steer) * f;
      out.time = a.time + (b.time - a.time) * f;
    } else if (t > b.time) {
      // ahead of the newest: carried on along its motion for a moment (from the last two), then held
      const dt = Math.min(EXTRAPOLATE, t - b.time);
      const p = i > 0 ? list[i - 1] : null;
      if (p && b.time > p.time) {
        const k = dt / (b.time - p.time);
        out.x = b.x + (b.x - p.x) * k;
        out.y = b.y + (b.y - p.y) * k;
        out.z = b.z + (b.z - p.z) * k;
        out.yaw = b.yaw + wrap(b.yaw - p.yaw) * k;
      }
      out.time = b.time + dt;
    }
    return true;
  }
}

// ------------------------------------------------------------------ the session

export interface Player {
  id: string;
  name: string;
  host: boolean;
  track: RemoteTrack;
}

export interface ChatLine {
  id: string;
  name: string;
  text: string;
  /** our clock (ms) */
  at: number;
  /** a line of the game itself (joined, left …), not somebody's */
  system?: boolean;
}

export interface SessionInfo {
  id: string;
  code: string;
  title?: string;
  players?: number;
  maxPlayers?: number;
  world?: { map?: string; x?: number; z?: number };
  host?: string;
  public?: boolean;
}

/** What the session tells the game. */
export interface SessionEvents {
  /** joined, left, became host, chat … (to show as a line) */
  line?(l: ChatLine): void;
  /** the list of players changed */
  players?(): void;
  /** the session ended for us: 'left' (we did), 'kicked', 'closed', 'refused', 'lost' (gave up reconnecting) */
  ended?(reason: string): void;
  /** a world event of another player (unknown kinds are ignored) */
  event?(id: string, kind: string, data: unknown): void;
  /** the hello: the session's map (to compare with ours) */
  hello?(map: string, host: string): void;
  /** the server refused a message ('rate_limited' chat, 'not_host' kick …) */
  error?(code: string): void;
}

/** the WebSocket as far as it is used (the browser's, or a test's fake) */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

/** The WebSocket address of a session (http → ws, https → wss). */
export function socketUrl(server: string, code: string, token: string, name = ''): string {
  const u = new URL(`${server.replace(/^http/, 'ws')}/api/v1/ws`);
  u.searchParams.set('session', code);
  if (token) u.searchParams.set('token', token);
  else if (name) u.searchParams.set('name', name);
  return u.toString();
}

export function parseSession(j: unknown): SessionInfo | null {
  const s = (j && typeof j === 'object' && 'session' in j ? (j as { session: unknown }).session : j) as Partial<SessionInfo> | null;
  if (!s || typeof s !== 'object' || typeof s.code !== 'string') return null;
  return { ...s, id: String(s.id ?? s.code), code: s.code.toUpperCase() };
}

export class MultiplayerSession {
  readonly code: string;
  readonly players = new Map<string, Player>();
  readonly chat: ChatLine[] = [];
  /** our id in the session ('' until the hello) */
  you = '';
  host = '';
  map = '';
  /** open: messages go through */
  get open(): boolean {
    return this.socket !== null && this.socket.readyState === 1 && this.you !== '';
  }
  private socket: SocketLike | null = null;
  private readonly url: string;
  private readonly make: SocketFactory;
  private readonly ev: SessionEvents;
  private readonly now: () => number;
  private lastSent = 0;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private done = false;

  constructor(o: { url: string; code: string; socket: SocketFactory; events?: SessionEvents; now?: () => number }) {
    this.url = o.url;
    this.code = o.code;
    this.make = o.socket;
    this.ev = o.events ?? {};
    this.now = o.now ?? (() => performance.now());
    this.connect();
  }

  get amHost(): boolean {
    return this.you !== '' && this.you === this.host;
  }

  private connect(): void {
    if (this.done) return;
    let s: SocketLike;
    try {
      s = this.make(this.url);
    } catch {
      this.lost();
      return;
    }
    this.socket = s;
    s.onopen = () => {
      this.failures = 0;
    };
    s.onmessage = (m) => {
      // (an old connection's last words – "replaced" after a reconnect – are not this session's end)
      if (this.socket !== s) return;
      if (typeof m.data !== 'string' || m.data.length > 65536) return;
      let msg: unknown;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      this.handle(msg as Record<string, unknown>);
    };
    s.onclose = (e) => {
      if (this.socket !== s) return;
      this.socket = null;
      this.you = '';
      if (this.done) return;
      // (refused for good: 4xxx codes of the server, or a policy close)
      if (e?.code === 1008 || (e?.code !== undefined && e.code >= 4000 && e.code < 4500)) {
        this.finish(e.code === 4003 || /kick/i.test(e.reason ?? '') ? 'kicked' : 'refused');
        return;
      }
      this.lost();
    };
    s.onerror = () => {};
  }

  private lost(): void {
    if (this.done) return;
    // (the connection broke: again after a pause, a few times)
    if (this.failures >= 6) {
      this.finish('lost');
      return;
    }
    const wait = backoff(this.failures++);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, wait);
  }

  private finish(reason: string): void {
    if (this.done) return;
    this.done = true;
    if (this.timer !== null) clearTimeout(this.timer);
    const s = this.socket;
    this.socket = null;
    if (s && s.readyState <= 1) s.close(1000, reason);
    this.players.clear();
    this.ev.players?.();
    this.ev.ended?.(reason);
  }

  private nameOf(id: string): string {
    return this.players.get(id)?.name ?? '?';
  }

  private addPlayer(p: unknown): Player | null {
    if (!p || typeof p !== 'object') return null;
    const o = p as { id?: unknown; name?: unknown; s?: unknown };
    if (o.id === undefined || o.id === null) return null;
    const id = String(o.id);
    let pl = this.players.get(id);
    if (!pl) {
      pl = { id, name: typeof o.name === 'string' && o.name ? o.name.slice(0, 40) : `#${id}`, host: id === this.host, track: new RemoteTrack() };
      this.players.set(id, pl);
    }
    const s = cleanSnapshot(o.s);
    if (s) pl.track.add(s, this.now());
    return pl;
  }

  private say(id: string, text: string, system = false): void {
    const l: ChatLine = { id, name: system ? '' : this.nameOf(id), text, at: this.now(), system };
    this.chat.push(l);
    if (this.chat.length > 100) this.chat.splice(0, this.chat.length - 100);
    this.ev.line?.(l);
  }

  /** A message of the server. */
  handle(m: Record<string, unknown>): void {
    switch (m.t) {
      case 'hello': {
        const you = m.you as unknown;
        this.you = String(you && typeof you === 'object' ? (you as { id?: unknown }).id : (you ?? ''));
        this.host = String(m.host ?? '');
        this.map = typeof m.map === 'string' ? m.map : '';
        this.players.clear();
        if (Array.isArray(m.players)) for (const p of m.players) if (String((p as { id?: unknown })?.id) !== this.you) this.addPlayer(p);
        for (const p of this.players.values()) p.host = p.id === this.host;
        this.ev.hello?.(this.map, this.host);
        this.ev.players?.();
        break;
      }
      case 'join': {
        const p = this.addPlayer(m.player);
        if (p && p.id !== this.you) {
          this.say(p.id, 'join', true);
          this.ev.players?.();
        } else if (p) this.players.delete(p.id);
        break;
      }
      case 'leave': {
        const id = String(m.id);
        if (this.players.has(id)) {
          this.say(id, 'leave', true);
          this.players.delete(id);
          this.ev.players?.();
        }
        break;
      }
      case 'state': {
        const id = String(m.id);
        if (id === this.you) break;
        const s = cleanSnapshot(m.s);
        if (!s) break;
        const p = this.players.get(id) ?? this.addPlayer({ id });
        p?.track.add(s, this.now());
        break;
      }
      case 'chat': {
        // (to everybody, the sender too: our own line comes back this way)
        const text = typeof m.text === 'string' ? m.text.slice(0, 300) : '';
        const id = String(m.id);
        if (typeof m.name === 'string' && m.name && this.players.has(id)) this.players.get(id)!.name = m.name.slice(0, 40);
        if (text) {
          const l: ChatLine = { id, name: typeof m.name === 'string' && m.name ? m.name.slice(0, 40) : this.nameOf(id), text, at: this.now() };
          this.chat.push(l);
          if (this.chat.length > 100) this.chat.splice(0, this.chat.length - 100);
          this.ev.line?.(l);
        }
        break;
      }
      case 'error':
        this.ev.error?.(typeof m.code === 'string' ? m.code : 'error');
        break;
      case 'event':
        if (typeof m.kind === 'string') this.ev.event?.(String(m.id), m.kind, m.data);
        break;
      case 'host': {
        this.host = String(m.id);
        for (const p of this.players.values()) p.host = p.id === this.host;
        this.say(this.host, 'host', true);
        this.ev.players?.();
        break;
      }
      case 'bye': {
        // (the server's word: not_found, bad_token, unauthorized, guests_not_allowed, kicked, full, host_left, replaced, ended, expired, timeout, flood, server_stopping)
        const r = typeof m.reason === 'string' ? m.reason : 'closed';
        this.finish(/kick/i.test(r) ? 'kicked' : r);
        break;
      }
      default:
        /* (a newer server's message: not known here) */
        break;
    }
  }

  private send(msg: unknown): boolean {
    if (!this.open) return false;
    try {
      this.socket!.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The own state – sent at most SEND_HZ times a second (call every frame).
   * Without one (in the menu, on the map) a ping now and then: a silent
   * client is dropped by the server after a minute.
   */
  tick(s: Snapshot | null): void {
    if (!this.open) return;
    const now = this.now();
    if (!s) {
      if (now - this.lastSent > 20_000) {
        this.lastSent = now;
        this.send({ t: 'ping' });
      }
      return;
    }
    // (on the beat of SEND_HZ, whatever the frames' rate: the next one is due a period after the last was due)
    const period = 1000 / SEND_HZ;
    if (now - this.lastSent < period) return;
    this.lastSent = Math.max(this.lastSent + period, now - period);
    this.send({ t: 'state', s });
  }

  chatSend(text: string): boolean {
    const t = text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
    if (!t) return false;
    // (shown when the server sends it back to everybody, us too)
    return this.send({ t: 'chat', text: t });
  }

  kick(id: string): boolean {
    return this.amHost && this.send({ t: 'kick', id });
  }

  event(kind: string, data: unknown): boolean {
    return this.send({ t: 'event', kind, data });
  }

  /** Leave the session. */
  leave(): void {
    this.finish('left');
  }

  /** players not heard of for long (their connection hangs): not drawn */
  stale(p: Player, now = this.now()): boolean {
    return now - p.track.lastSeen > 10_000;
  }
}

// ------------------------------------------------------------------ the session API

export interface NewSession {
  title?: string;
  map: string;
  x: number;
  z: number;
  public: boolean;
  maxPlayers?: number;
  keep?: boolean;
  /** may guests (no account) join */
  guests?: boolean;
}

export async function createSession(c: ServerClient, s: NewSession): Promise<SessionInfo> {
  const body: Record<string, unknown> = { world: { map: s.map, x: Math.round(s.x), z: Math.round(s.z) }, public: s.public };
  if (s.title) body.title = s.title.slice(0, 60);
  if (s.maxPlayers) body.maxPlayers = s.maxPlayers;
  if (s.keep) body.keep = true;
  if (s.guests) body.guests = true;
  const r = parseSession(await c.request('POST', '/sessions', body));
  if (!r) throw new Error('No session');
  return r;
}

export async function listSessions(c: ServerClient): Promise<SessionInfo[]> {
  const r = await c.request('GET', '/sessions', undefined, { retries: 1 });
  const list = Array.isArray(r) ? r : (r as { sessions?: unknown })?.sessions;
  return Array.isArray(list) ? list.map(parseSession).filter((s): s is SessionInfo => s !== null) : [];
}

export async function getSession(c: ServerClient, code: string): Promise<SessionInfo | null> {
  return parseSession(await c.request('GET', `/sessions/${encodeURIComponent(code.toUpperCase())}`));
}

/** A code as typed (or a whole link with ?join=): the six letters, or null. */
export function sessionCode(typed: string): string | null {
  const t = typed.trim();
  const m = /[?&]join=([A-Za-z0-9]{4,12})/.exec(t);
  const c = (m ? m[1] : t).toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(c) ? c : null;
}
