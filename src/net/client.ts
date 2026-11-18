// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The game's side of the Fahrsim Baunatal server (server/PROTOCOL.md, v1):
 * which server – the player's setting, or `?server=<url>` –, the access token
 * that signs in (stored per server; `?tk=<token>` stores it and is taken out
 * of the address bar), what the server can do (GET /api/v1/info – features
 * are discovered, never assumed), and the requests themselves: JSON, the
 * token in the Authorization header, errors as ServerError, network trouble
 * retried with a growing pause.
 *
 * The game never needs a server: without one, or while it cannot be reached,
 * everything goes on as before (offline-first); this only adds.
 *
 * No DOM here – fetch, the storage and the clock are handed in, so the
 * tests run it in Node with fakes.
 */

/** The protocol's path prefix. */
export const API = '/api/v1';

/** What a server says of itself (GET /api/v1/info). */
export interface ServerInfo {
  name: string;
  /** the server's own version */
  server: string;
  api: number;
  capabilities: string[];
  limits: { imageBytes?: number; sessionPlayers?: number; [k: string]: number | undefined };
  motd?: string;
  /** server 1.0.0 and later: may anybody make an account, may guests play together, where its source is (AGPL § 13) */
  registration?: boolean;
  guests?: boolean;
  source?: string;
}

/** The account signed in (GET /api/v1/me). */
export interface Me {
  id: string;
  name: string;
  admin: boolean;
  created: string;
  /** the tokens of the account, if the server lists them (by their first 6 characters) */
  tokens?: TokenInfo[];
}

/** One of the account's tokens, as the server names it (never the token itself). */
export interface TokenInfo {
  prefix: string;
  created?: string;
  lastUsed?: string;
}

/** What is needed of localStorage (tests bring a Map-backed one). */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A failed request: the HTTP status (0: no answer at all) and the server's error code ('offline', 'timeout' from here). */
export class ServerError extends Error {
  readonly status: number;
  readonly code: string;
  /** the whole answer, for errors that carry data (409 conflict: the server's copy) */
  readonly body: unknown;
  constructor(status: number, code: string, message: string, body: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
  /** not the server's "no", but no answer: worth trying again later */
  get transient(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** where the tokens are kept: { "<server url>": "<token>" } – never in the settings (they are synced) */
const TOKENS_KEY = 'fahrsim.server.tokens';

/** A token as the protocol allows it: at least 8 letters, digits, '-', '_' or '.'. */
export function validToken(t: unknown): t is string {
  return typeof t === 'string' && t.length <= 200 && /^[A-Za-z0-9._-]{8,}$/.test(t);
}

/**
 * A server address as typed: trimmed, `https://` added when no scheme is
 * given (`http://` for localhost and plain IP addresses), no query, no
 * fragment, no trailing slash.  '' stays '' (no server); null: not usable.
 */
export function normaliseServerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s === '') return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = (/^(localhost|127\.|\[::1\]|\d+\.\d+\.\d+\.\d+)/i.test(s) ? 'http://' : 'https://') + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const path = u.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/**
 * The server and the token the address carries (`?server=…`, `?tk=…`) – and the
 * address without the token (null: nothing to take out), for history.replaceState:
 * a token must not stay in the address bar, the history or a link copied from there.
 */
export function urlParams(href: string): { server: string | null; token: string | null; cleaned: string | null; join: string | null } {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { server: null, token: null, cleaned: null, join: null };
  }
  const server = u.searchParams.get('server');
  const tk = u.searchParams.get('tk');
  const join = u.searchParams.get('join');
  let cleaned: string | null = null;
  if (tk !== null) {
    u.searchParams.delete('tk');
    cleaned = u.toString();
  }
  return { server: server !== null ? normaliseServerUrl(server) : null, token: validToken(tk) ? tk : null, cleaned, join: join && /^[A-Za-z0-9]{4,12}$/.test(join) ? join.toUpperCase() : null };
}

/** The pause before the n-th retry (n from 0): 1 s, 2 s, 4 s … at most 60 s, a little scattered (`rnd` 0…1). */
export function backoff(n: number, rnd = 0.5): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, Math.min(16, n)));
  return Math.round(base * (0.8 + 0.4 * rnd));
}

/** The first 6 characters of a token – how the server names it. */
export const tokenPrefix = (t: string): string => t.slice(0, 6);

export type Status = 'none' | 'connecting' | 'online' | 'offline';

export interface RequestOptions {
  /** send the token (default: yes, when there is one) */
  auth?: boolean;
  /** retries on no answer / 5xx (GET and PUT: safe to repeat); default 0 */
  retries?: number;
  /** ms before giving up (default 15 s; uploads longer) */
  timeout?: number;
  /** a FormData body: sent as it is */
  form?: FormData;
  /** the answer as bytes instead of JSON */
  blob?: boolean;
}

export interface ClientOptions {
  fetch?: typeof fetch;
  store?: KeyValue | null;
  /** waits ms (tests: at once) */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class ServerClient {
  /** the server's address ('' none) */
  url = '';
  token = '';
  info: ServerInfo | null = null;
  me: Me | null = null;
  status: Status = 'none';
  /** why the last attempt failed (an error code: 'offline', 'unauthorized', …) */
  lastError = '';
  private readonly fetchFn: typeof fetch;
  private readonly store: KeyValue | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly listeners = new Set<() => void>();
  /** reconnecting: how many attempts failed in a row, and the timer of the next */
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private connecting: Promise<boolean> | null = null;

  constructor(opts: ClientOptions = {}) {
    this.fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.store = opts.store === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : opts.store;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  /** called whenever status, info or the account change */
  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private changed(): void {
    for (const f of this.listeners) {
      try {
        f();
      } catch (e) {
        console.error(e);
      }
    }
  }

  // ---------------------------------------------------------------- server and token

  private tokens(): Record<string, string> {
    try {
      const v = JSON.parse(this.store?.getItem(TOKENS_KEY) ?? '{}') as unknown;
      return v && typeof v === 'object' ? (v as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  /** Another server ('' none): its stored token comes with it; nothing is asked yet (connect). */
  setServer(url: string): void {
    const u = normaliseServerUrl(url) ?? '';
    if (u === this.url) return;
    this.url = u;
    const t = u ? this.tokens()[u] : undefined;
    this.token = validToken(t) ? t : '';
    this.info = null;
    this.me = null;
    this.failures = 0;
    this.status = u ? 'connecting' : 'none';
    this.cancelRetry();
    this.changed();
  }

  /** Sign in with a token ('' signs out) – kept for this server in the browser. */
  setToken(token: string): void {
    const t = token.trim();
    if (t && !validToken(t)) throw new ServerError(0, 'bad_token', 'Not a token');
    this.token = t;
    this.me = null;
    if (this.url) {
      const all = this.tokens();
      if (t) all[this.url] = t;
      else delete all[this.url];
      try {
        this.store?.setItem(TOKENS_KEY, JSON.stringify(all));
      } catch {
        /* (no storage: signed in for this visit only) */
      }
    }
    this.changed();
  }

  /** Is the server there and does it offer this? (Nothing is offered without a server, or while it cannot be reached.) */
  has(cap: string): boolean {
    return this.status === 'online' && !!this.info && this.info.capabilities.includes(cap);
  }

  /** signed in (the server knows the token) */
  get signedIn(): boolean {
    return this.me !== null;
  }

  // ---------------------------------------------------------------- connecting

  private cancelRetry(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Ask the server what it is and who the token belongs to.  True: online.
   * On no answer the status is 'offline' and another attempt is planned
   * (1 s, 2 s, 4 s … 60 s); a refused token signs out of nothing – it is kept,
   * the account panel says it is not valid.
   */
  connect(): Promise<boolean> {
    if (!this.url) {
      this.status = 'none';
      return Promise.resolve(false);
    }
    if (this.connecting) return this.connecting;
    this.cancelRetry();
    const url = this.url;
    if (this.status !== 'online') this.status = 'connecting';
    this.changed();
    const job = (async (): Promise<boolean> => {
      try {
        const info = parseInfo(await this.request('GET', '/info', undefined, { auth: false, timeout: 8000 }));
        if (url !== this.url) return false;
        if (!info) throw new ServerError(0, 'not_a_server', 'This is not a Fahrsim Baunatal server');
        this.info = info;
        this.me = null;
        if (this.token && info.capabilities.includes('accounts')) {
          try {
            this.me = parseMe(await this.request('GET', '/me'));
            this.lastError = '';
          } catch (e) {
            if (e instanceof ServerError && e.transient) throw e;
            this.lastError = e instanceof ServerError ? e.code : 'error';
            // (a token the server does not know – revoked, or the account deleted: forgotten, as the protocol asks)
            if (this.lastError === 'bad_token') this.setToken('');
          }
        } else this.lastError = '';
        this.status = 'online';
        this.failures = 0;
        this.changed();
        return true;
      } catch (e) {
        if (url !== this.url) return false;
        this.status = 'offline';
        this.lastError = e instanceof ServerError ? e.code : 'offline';
        // (not a server at all: no point in asking again and again)
        if (this.lastError !== 'not_a_server') this.retryLater();
        this.changed();
        return false;
      } finally {
        this.connecting = null;
      }
    })();
    this.connecting = job;
    return job;
  }

  private retryLater(): void {
    this.cancelRetry();
    const wait = backoff(this.failures++, this.random());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, wait);
  }

  /** The network is back (the browser's 'online' event): try at once. */
  wake(): void {
    if (this.url && this.status === 'offline') {
      this.failures = 0;
      void this.connect();
    }
  }

  /** Forget everything of this server for this visit (stop retrying). */
  stop(): void {
    this.cancelRetry();
  }

  // ---------------------------------------------------------------- requests

  /** An absolute address under the API ('/images/7/file' → https://server/api/v1/images/7/file). */
  href(path: string): string {
    return `${this.url}${API}${path}`;
  }

  /**
   * A request to the API: the answer's JSON (or a Blob with `blob`).  Throws a
   * ServerError – status 0 and code 'offline' / 'timeout' when there was no answer.
   */
  async request<T = unknown>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    if (!this.url) throw new ServerError(0, 'no_server', 'No server set');
    const retries = opts.retries ?? 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.once(method, path, body, opts)) as T;
      } catch (e) {
        const again = e instanceof ServerError && e.transient && attempt < retries && (method === 'GET' || method === 'PUT' || method === 'DELETE');
        if (!again) throw e;
        await this.sleep(backoff(attempt, this.random()));
      }
    }
  }

  private async once(method: string, path: string, body: unknown, opts: RequestOptions): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if ((opts.auth ?? true) && this.token) headers.Authorization = `Bearer ${this.token}`;
    let payload: BodyInit | undefined;
    if (opts.form) payload = opts.form;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const ctrl = typeof AbortController === 'undefined' ? null : new AbortController();
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeout ?? 15_000) : null;
    let res: Response;
    try {
      res = await this.fetchFn(this.href(path), { method, headers, body: payload, signal: ctrl?.signal, mode: 'cors', credentials: 'omit' });
    } catch (e) {
      const aborted = (e as { name?: string })?.name === 'AbortError';
      throw new ServerError(0, aborted ? 'timeout' : 'offline', aborted ? 'The server did not answer in time' : 'The server cannot be reached');
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    if (res.ok && opts.blob) return await res.blob();
    let json: unknown = null;
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const j = (json ?? {}) as { error?: unknown; message?: unknown };
      const code = typeof j.error === 'string' ? j.error : res.status === 401 ? 'unauthorized' : res.status === 403 ? 'forbidden' : res.status === 404 ? 'not_found' : `http_${res.status}`;
      throw new ServerError(res.status, code, typeof j.message === 'string' ? j.message : `HTTP ${res.status}`, json);
    }
    return json;
  }

  // ---------------------------------------------------------------- accounts

  /** A new account (self-registration): signs in with its token. */
  async register(name: string): Promise<Me> {
    const r = (await this.request('POST', '/accounts', { name: cleanName(name) }, { auth: false })) as { account?: unknown; token?: unknown };
    if (!validToken(r?.token)) throw new ServerError(0, 'bad_answer', 'The server sent no token');
    this.setToken(r.token);
    this.me = parseMe(r.account) ?? parseMe(await this.request('GET', '/me'));
    this.changed();
    if (!this.me) throw new ServerError(0, 'bad_answer', 'No account');
    return this.me;
  }

  /** Sign in with a token: kept only if the server knows it. */
  async signIn(token: string): Promise<Me> {
    const t = token.trim();
    if (!validToken(t)) throw new ServerError(0, 'bad_token', 'Not a token');
    const was = this.token;
    this.token = t;
    try {
      const me = parseMe(await this.request('GET', '/me'));
      if (!me) throw new ServerError(0, 'bad_answer', 'No account');
      this.setToken(t);
      this.me = me;
      this.changed();
      return me;
    } catch (e) {
      this.token = was;
      throw e;
    }
  }

  signOut(): void {
    this.setToken('');
    this.me = null;
    this.changed();
  }

  async rename(name: string): Promise<void> {
    await this.request('PATCH', '/me', { name: cleanName(name) });
    if (this.me) this.me = { ...this.me, name: cleanName(name) };
    this.changed();
  }

  /** A new token of this account (to sign in on another device). */
  async newToken(): Promise<string> {
    const r = await this.request('POST', '/me/tokens', {});
    const t = typeof r === 'string' ? r : (r as { token?: unknown })?.token;
    if (!validToken(t)) throw new ServerError(0, 'bad_answer', 'The server sent no token');
    return t;
  }

  async revokeToken(prefix: string): Promise<void> {
    await this.request('DELETE', `/me/tokens/${encodeURIComponent(prefix.slice(0, 6))}`);
  }

  /** The account's tokens (server 1.0.0: GET /me/tokens) – null: the server does not list them. */
  async myTokens(): Promise<TokenInfo[] | null> {
    try {
      return parseTokens(await this.request('GET', '/me/tokens'));
    } catch (e) {
      if (e instanceof ServerError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  }

  /** Delete the own account with its pictures and progress (server 1.0.0) – then signed out. */
  async deleteMe(): Promise<void> {
    await this.request('DELETE', '/me');
    this.signOut();
  }

  // ---------------------------------------------------------------- admin

  async adminAccounts(): Promise<AdminAccount[]> {
    const r = await this.request('GET', '/admin/accounts');
    const list = Array.isArray(r) ? r : (r as { accounts?: unknown })?.accounts;
    return Array.isArray(list) ? list.map(parseAdminAccount).filter((a): a is AdminAccount => a !== null) : [];
  }

  async adminCreate(name: string, token?: string, admin = false): Promise<{ account: AdminAccount | null; token: string }> {
    const body: Record<string, unknown> = { name: cleanName(name), admin };
    if (token) {
      if (!validToken(token)) throw new ServerError(0, 'bad_token', 'Not a token');
      body.token = token;
    }
    const r = (await this.request('POST', '/admin/accounts', body)) as { account?: unknown; token?: unknown };
    return { account: parseAdminAccount(r?.account), token: typeof r?.token === 'string' ? r.token : '' };
  }

  async adminPatch(id: string, patch: { name?: string; admin?: boolean; disabled?: boolean }): Promise<void> {
    await this.request('PATCH', `/admin/accounts/${encodeURIComponent(id)}`, patch);
  }

  async adminDelete(id: string): Promise<void> {
    await this.request('DELETE', `/admin/accounts/${encodeURIComponent(id)}`);
  }

  async adminToken(id: string, token?: string): Promise<string> {
    if (token && !validToken(token)) throw new ServerError(0, 'bad_token', 'Not a token');
    const r = await this.request('POST', `/admin/accounts/${encodeURIComponent(id)}/tokens`, token ? { token } : {});
    const t = typeof r === 'string' ? r : (r as { token?: unknown })?.token;
    return typeof t === 'string' ? t : '';
  }

  /** An account's tokens (server 1.0.0). */
  async adminTokens(id: string): Promise<TokenInfo[]> {
    return parseTokens(await this.request('GET', `/admin/accounts/${encodeURIComponent(id)}/tokens`)) ?? [];
  }

  async adminRevoke(id: string, prefix: string): Promise<void> {
    await this.request('DELETE', `/admin/accounts/${encodeURIComponent(id)}/tokens/${encodeURIComponent(prefix.slice(0, 6))}`);
  }

  /** The sessions running (server 1.0.0). */
  async adminSessions(): Promise<Array<{ code: string; title: string; players: number; host: string; playerList: string[] }>> {
    const r = await this.request('GET', '/admin/sessions');
    const list = Array.isArray(r) ? r : (r as { sessions?: unknown })?.sessions;
    if (!Array.isArray(list)) return [];
    return list
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as { code?: unknown }).code === 'string')
      .map((s) => ({
        code: String(s.code),
        title: typeof s.title === 'string' ? s.title : '',
        players: typeof s.players === 'number' ? s.players : 0,
        host: typeof s.host === 'string' ? s.host : '',
        playerList: Array.isArray(s.playerList) ? s.playerList.map((p) => (p && typeof p === 'object' ? String((p as { name?: unknown }).name ?? '') : String(p))) : [],
      }));
  }

  async adminEndSession(code: string): Promise<void> {
    await this.request('DELETE', `/admin/sessions/${encodeURIComponent(code)}`);
  }

  async adminSettings(): Promise<AdminSettings> {
    const r = (await this.request('GET', '/admin/settings')) as Partial<AdminSettings> | null;
    return { registration: !!r?.registration, guests: r?.guests === true, motd: typeof r?.motd === 'string' ? r.motd : '', origins: Array.isArray(r?.origins) ? r.origins.filter((o): o is string => typeof o === 'string') : [] };
  }

  async adminSetSettings(p: Partial<AdminSettings>): Promise<void> {
    await this.request('PATCH', '/admin/settings', p);
    if (p.motd !== undefined && this.info) this.info = { ...this.info, motd: p.motd };
  }
}

export interface AdminAccount {
  id: string;
  name: string;
  admin: boolean;
  created: string;
  tokens?: number;
  disabled?: boolean;
}

export interface AdminSettings {
  registration: boolean;
  /** may guests (no account) join sessions at all */
  guests: boolean;
  motd: string;
  origins: string[];
}

/** A name as the server is to get it: one line, at most 40 characters. */
export function cleanName(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

export function parseInfo(j: unknown): ServerInfo | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Partial<ServerInfo>;
  if (!Array.isArray(o.capabilities)) return null;
  return {
    name: typeof o.name === 'string' ? o.name : '',
    server: typeof o.server === 'string' ? o.server : '',
    api: typeof o.api === 'number' ? o.api : 1,
    capabilities: o.capabilities.filter((c): c is string => typeof c === 'string'),
    limits: o.limits && typeof o.limits === 'object' ? { ...o.limits } : {},
    motd: typeof o.motd === 'string' ? o.motd : '',
    registration: typeof (o as { registration?: unknown }).registration === 'boolean' ? o.registration : undefined,
    guests: typeof (o as { guests?: unknown }).guests === 'boolean' ? o.guests : undefined,
    source: typeof o.source === 'string' ? o.source : undefined,
  };
}

function parseTokens(r: unknown): TokenInfo[] | null {
  const list = Array.isArray(r) ? r : (r as { tokens?: unknown })?.tokens;
  if (!Array.isArray(list)) return null;
  return list
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && typeof (t as { prefix?: unknown }).prefix === 'string')
    .map((t) => ({ prefix: String(t.prefix), created: typeof t.created === 'string' ? t.created : undefined, lastUsed: typeof t.lastUsed === 'string' ? t.lastUsed : undefined }));
}

export function parseMe(j: unknown): Me | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Partial<Me> & { id?: unknown };
  if (o.id === undefined || o.id === null) return null;
  const tokens = Array.isArray(o.tokens) ? (parseTokens(o.tokens) ?? undefined) : undefined;
  return { id: String(o.id), name: typeof o.name === 'string' ? o.name : '', admin: o.admin === true, created: typeof o.created === 'string' ? o.created : '', tokens };
}

function parseAdminAccount(j: unknown): AdminAccount | null {
  const m = parseMe(j);
  if (!m) return null;
  const n = (j as { tokens?: unknown }).tokens;
  return { id: m.id, name: m.name, admin: m.admin, created: m.created, tokens: typeof n === 'number' ? n : Array.isArray(n) ? n.length : undefined, disabled: (j as { disabled?: unknown }).disabled === true };
}
