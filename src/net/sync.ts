// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Everything the player did, kept on the server as well (server/PROTOCOL.md,
 * "Progress"): the game keeps its progress in the browser's storage as
 * before – the tours driven, the places looked for and the ways started, the
 * favourite places, the theory lessons passed, the log of faults, the
 * settings, the map's layers – and this copies each kind to the server as a
 * document and back.
 *
 * Offline-first: the browser's copy is the one the game uses; the server's
 * is merged in when it can be reached – pulled when the game starts and
 * after signing in, pushed a few seconds after something changed (seen by
 * looking at the stored entries every few seconds: the game's own code needs
 * no hooks).  Two devices that changed the same kind are merged per kind:
 *  - lists (tours, places, ways, favourites, theory, faults) are unions –
 *    against the copy both last agreed on (the "base"), so that a favourite
 *    taken out on one device is taken out on the other as well;
 *  - the settings and the map's layers: the newest wins (the settings of the
 *    device itself – graphics, resolution, the wheel, the server – stay
 *    apart and are never sent).
 */
import type { KeyValue, ServerClient } from './client.ts';
import { ServerError } from './client.ts';
import { LEARN_KEY, cleanLearn, mergeLearn } from '../game/exam/learnstore.ts';

/** One kind of progress: where it lives in the browser and how two copies are merged. */
export interface KindDef {
  kind: string;
  /** the document as it is in the browser now (null: nothing stored) */
  read(store: KeyValue): unknown;
  /** put a merged document into the browser */
  write(store: KeyValue, data: unknown): void;
  /** merge the browser's and the server's copies, given the copy both last agreed on (null: never synced) */
  merge(base: unknown, local: unknown, remote: unknown): unknown;
}

// ------------------------------------------------------------------ merging

/**
 * A three-way merge of two lists of items with keys: what one side added is
 * added, what one side took out (it is in the base but not there any more)
 * is taken out; the order is the local one, then what came from the other
 * side.  Without a base it is the union.
 */
export function mergeLists<T>(base: readonly T[] | null, local: readonly T[], remote: readonly T[], key: (t: T) => string): T[] {
  const b = new Set((base ?? []).map(key));
  const lk = new Set(local.map(key));
  const rk = new Set(remote.map(key));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const t of local) {
    const k = key(t);
    if (seen.has(k)) continue;
    // (in the base and gone from the server: taken out on another device)
    if (b.has(k) && !rk.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  for (const t of remote) {
    const k = key(t);
    if (seen.has(k)) continue;
    if (b.has(k) && !lk.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** The newer of two stamped documents ({t: ms, …}); the local one when they are equally old. */
export function newest<T extends { t: number }>(local: T | null, remote: T | null): T | null {
  if (!remote) return local;
  if (!local) return remote;
  return remote.t > local.t ? remote : local;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function readJson(store: KeyValue, key: string): unknown {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(store: KeyValue, key: string, v: unknown): void {
  try {
    store.setItem(key, JSON.stringify(v));
  } catch {
    /* (full or not allowed: the server keeps it) */
  }
}

/** a list kind kept under one key: merged by item key, sorted, cut to a length */
function listKind(kind: string, key: string, itemKey: (t: unknown) => string, keep: number, sort?: (a: unknown, b: unknown) => number): KindDef {
  return {
    kind,
    read: (s) => {
      const v = readJson(s, key);
      return Array.isArray(v) ? v : null;
    },
    write: (s, d) => writeJson(s, key, d),
    merge: (base, local, remote) => {
      const m = mergeLists(base === null ? null : arr(base), arr(local), arr(remote), itemKey);
      if (sort) m.sort(sort);
      return m.slice(0, keep);
    },
  };
}

const byDateDesc = (a: unknown, b: unknown): number => str(obj(b).date).localeCompare(str(obj(a).date));
const at = (o: Record<string, unknown>): string => `${Math.round(num(o.x))}|${Math.round(num(o.z))}`;

/** settings that belong to the device, not to the player: never sent, never taken over */
export const DEVICE_SETTINGS: readonly string[] = ['quality', 'graphics', 'uiScale', 'pixelCap', 'render3d', 'mirrors', 'wheel', 'touchControls', 'touchOpacity', 'mapPack', 'insideMirror', 'wasm', 'server', 'lastStart', 'version', 'drawDistance', 'speech'];

const SETTINGS_KEY = 'fahrsim-baunatal.settings.v2';
/** when the settings or the layers were last changed here (ms): the stamps of newest-wins */
const STAMPS_KEY = 'fahrsim.sync.stamps';

function stamps(s: KeyValue): Record<string, number> {
  return obj(readJson(s, STAMPS_KEY)) as Record<string, number>;
}

export function stampLocal(s: KeyValue, kind: string, t: number): void {
  writeJson(s, STAMPS_KEY, { ...stamps(s), [kind]: t });
}

/** the shared part of the settings */
export function sharedSettings(all: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) if (!DEVICE_SETTINGS.includes(k)) out[k] = v;
  return out;
}

function newestKind(kind: string, key: string, pick: (all: Record<string, unknown>) => Record<string, unknown>, apply: (local: Record<string, unknown>, remote: Record<string, unknown>) => Record<string, unknown>): KindDef {
  return {
    kind,
    read: (s) => {
      const v = readJson(s, key);
      if (!v || typeof v !== 'object') return null;
      return { t: num(stamps(s)[kind]), v: pick(obj(v)) };
    },
    write: (s, d) => {
      const doc = obj(d);
      writeJson(s, key, apply(obj(readJson(s, key)), obj(doc.v)));
      stampLocal(s, kind, num(doc.t));
    },
    merge: (_base, local, remote) => {
      const l = local ? { t: num(obj(local).t), v: obj(obj(local).v) } : null;
      const r = remote && typeof remote === 'object' ? { t: num(obj(remote).t), v: obj(obj(remote).v) } : null;
      return newest(l, r);
    },
  };
}

/** The kinds of progress the game has (and where each is in the browser). */
export const KINDS: readonly KindDef[] = [
  // the tours driven (game/tourlog.ts) – by when
  listKind('tours', 'fahrsim.tours', (t) => str(obj(t).date), 40, byDateDesc),
  // the places looked for and the ways started (game/history.ts)
  {
    kind: 'history',
    read: (s) => {
      const p = readJson(s, 'fahrsim.places');
      const w = readJson(s, 'fahrsim.ways');
      return p === null && w === null ? null : { places: arr(p), ways: arr(w) };
    },
    write: (s, d) => {
      writeJson(s, 'fahrsim.places', arr(obj(d).places));
      writeJson(s, 'fahrsim.ways', arr(obj(d).ways));
    },
    merge: (base, local, remote) => {
      const b = base === null ? null : obj(base);
      const placeKey = (p: unknown): string => `${str(obj(p).name)}|${at(obj(p))}`;
      const wayKey = (w: unknown): string => arr(obj(w).stops).map((p) => `${str(obj(p).name)}|${at(obj(p))}`).join(';');
      const places = mergeLists(b ? arr(b.places) : null, arr(obj(local).places), arr(obj(remote).places), placeKey).sort(byDateDesc).slice(0, 12);
      const ways = mergeLists(b ? arr(b.ways) : null, arr(obj(local).ways), arr(obj(remote).ways), wayKey).sort(byDateDesc).slice(0, 10);
      return { places, ways };
    },
  },
  // the favourite places (game/history.ts): one per 20 m – the local order first
  listKind('favourites', 'fahrsim.favourites', (p) => at(obj(p)), 50),
  // the theory lessons answered all right (game/theorymode.ts): they are never taken back – a plain union
  {
    kind: 'theory',
    read: (s) => {
      const v = readJson(s, 'fahrsim-baunatal.theory.v1');
      return v === null ? null : { done: arr(obj(v).done).filter((x) => typeof x === 'string') };
    },
    write: (s, d) => writeJson(s, 'fahrsim-baunatal.theory.v1', { done: arr(obj(d).done) }),
    merge: (_b, local, remote) => ({ done: [...new Set([...arr(obj(local).done), ...arr(obj(remote).done)].filter((x): x is string => typeof x === 'string'))].sort() }),
  },
  // the faults of all drives (game/faultlog.ts): a union – the log emptied on one device ("cleared") empties it on all
  {
    kind: 'results',
    read: (s) => {
      const v = readJson(s, 'fahrsim-baunatal.faults.v1');
      // (never null: an emptied log – the entry taken out – must reach the merge, which tells it by the base)
      return { cleared: num(obj(readJson(s, 'fahrsim.sync.cleared')).results), entries: arr(v) };
    },
    write: (s, d) => {
      writeJson(s, 'fahrsim-baunatal.faults.v1', arr(obj(d).entries));
      writeJson(s, 'fahrsim.sync.cleared', { results: num(obj(d).cleared) });
    },
    merge: (base, local, remote) => {
      const l = obj(local);
      const r = obj(remote);
      let cleared = Math.max(num(l.cleared), num(r.cleared));
      // (gone here although it was there when last synced: the log was emptied on this device)
      if (base !== null && arr(obj(base).entries).length > 0 && arr(l.entries).length === 0) cleared = Math.max(cleared, ...arr(obj(base).entries).map((e) => num(obj(e).t)));
      const key = (e: unknown): string => `${num(obj(e).t)}|${str(obj(e).id)}`;
      const all = mergeLists(null, arr(l.entries), arr(r.entries), key).filter((e) => num(obj(e).t) > cleared);
      all.sort((a, b) => num(obj(a).t) - num(obj(b).t));
      return { cleared, entries: all.slice(-400) };
    },
  },
  // the settings: the newest wins; the device's own stay
  newestKind('settings', SETTINGS_KEY, sharedSettings, (local, remote) => {
    const out = { ...local };
    for (const [k, v] of Object.entries(remote)) if (!DEVICE_SETTINGS.includes(k)) out[k] = v;
    return out;
  }),
  // the big map's layers (ui/maplayers.ts)
  newestKind('maplayers', 'fahrsim.mapLayers', (v) => v, (_l, r) => r),
  // what was learned (game/exam/learnstore.ts): the theory exams, the sign trainer, "spot the danger", how the lessons ended – merged item by item
  {
    kind: 'learn',
    read: (s) => {
      const v = readJson(s, LEARN_KEY);
      return v === null ? null : cleanLearn(v);
    },
    write: (s, d) => writeJson(s, LEARN_KEY, cleanLearn(d)),
    merge: (_b, local, remote) => mergeLearn(local, remote),
  },
];

// ------------------------------------------------------------------ the state of syncing

/** what was last agreed with the server, per kind: its revision and the document */
interface KindState {
  rev: number;
  base: unknown;
}

interface SyncState {
  /** whose: the server and the account */
  who: string;
  kinds: Record<string, KindState>;
}

const STATE_KEY = 'fahrsim.sync.v1';
/** documents above this are not sent (the protocol's limit is 1 MB) */
const MAX_BYTES = 900_000;

/** Two JSON values alike (the same text)? */
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface SyncOptions {
  client: ServerClient;
  store: KeyValue;
  kinds?: readonly KindDef[];
  now?: () => number;
  /** a kind was changed from the server (the game takes over the settings, …) */
  pulled?: (kind: string, data: unknown) => void;
}

export class ProgressSync {
  private readonly client: ServerClient;
  private readonly store: KeyValue;
  private readonly kinds: readonly KindDef[];
  private readonly now: () => number;
  /** a kind was changed from the server (set by the game's side: net/online.ts) */
  pulled: (kind: string, data: unknown) => void;
  /** what each kind was in the browser when last looked at (its JSON) */
  private readonly seen = new Map<string, string>();
  /** changed here since the last push */
  private readonly dirty = new Set<string>();
  /** when the last change was seen (ms; for the pause before pushing) */
  private changedAt = 0;
  private running: Promise<void> | null = null;
  private again = false;
  /** the last round: when it ended, and whether it worked */
  lastSync = 0;
  lastError = '';

  constructor(o: SyncOptions) {
    this.client = o.client;
    this.store = o.store;
    this.kinds = o.kinds ?? KINDS;
    this.now = o.now ?? Date.now;
    this.pulled = o.pulled ?? (() => {});
    for (const k of this.kinds) this.seen.set(k.kind, JSON.stringify(k.read(this.store)));
  }

  /** can it sync now (a server with progress, signed in)? */
  get possible(): boolean {
    return this.client.has('progress') && this.client.signedIn;
  }

  private who(): string {
    return `${this.client.url}#${this.client.me?.id ?? ''}`;
  }

  private loadState(): SyncState {
    try {
      const v = JSON.parse(this.store.getItem(STATE_KEY) ?? 'null') as SyncState | null;
      if (v && v.who === this.who() && v.kinds && typeof v.kinds === 'object') return v;
    } catch {
      /* (start anew) */
    }
    // (another server or account: nothing agreed yet – the first round is a union)
    return { who: this.who(), kinds: {} };
  }

  private saveState(st: SyncState): void {
    try {
      this.store.setItem(STATE_KEY, JSON.stringify(st));
    } catch {
      /* (no storage: the next round merges as a union) */
    }
  }

  /**
   * Look whether anything changed in the browser (call every few seconds).
   * True: something did – a push is due once `quiet` ms passed without more.
   */
  look(): boolean {
    let any = false;
    for (const k of this.kinds) {
      const now = JSON.stringify(k.read(this.store));
      if (now === this.seen.get(k.kind)) continue;
      this.seen.set(k.kind, now);
      // (newest-wins kinds: the moment of the change is their stamp)
      if (k.kind === 'settings' || k.kind === 'maplayers') {
        stampLocal(this.store, k.kind, this.now());
        this.seen.set(k.kind, JSON.stringify(k.read(this.store)));
      }
      this.dirty.add(k.kind);
      any = true;
    }
    if (any) this.changedAt = this.now();
    return any;
  }

  /** Something changed and nothing more for `quiet` ms: time to push. */
  due(quiet = 5000): boolean {
    return this.dirty.size > 0 && this.now() - this.changedAt >= quiet;
  }

  /** Pull and push all kinds (or those changed only); rounds asked for while one runs are run after it. */
  sync(onlyDirty = false): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const job = (async () => {
      try {
        do {
          this.again = false;
          await this.round(onlyDirty);
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    this.running = job;
    return job;
  }

  private async round(onlyDirty: boolean): Promise<void> {
    if (!this.possible) return;
    const st = this.loadState();
    let index: Record<string, { rev?: number }> = {};
    try {
      index = ((await this.client.request('GET', '/progress', undefined, { retries: 1 })) ?? {}) as typeof index;
    } catch (e) {
      this.lastError = e instanceof ServerError ? e.code : 'error';
      return;
    }
    const dirty = new Set(this.dirty);
    this.dirty.clear();
    let failed = '';
    for (const k of this.kinds) {
      const remoteRev = typeof index[k.kind]?.rev === 'number' ? (index[k.kind].rev as number) : 0;
      const ks = st.kinds[k.kind];
      const unchangedThere = ks !== undefined && ks.rev === remoteRev;
      if (onlyDirty && !dirty.has(k.kind) && unchangedThere) continue;
      try {
        await this.syncKind(k, st, remoteRev, unchangedThere);
      } catch (e) {
        failed = e instanceof ServerError ? e.code : 'error';
        // (tried again with the next round)
        if (dirty.has(k.kind)) this.dirty.add(k.kind);
      }
    }
    this.saveState(st);
    this.lastError = failed;
    if (!failed) this.lastSync = this.now();
  }

  private async syncKind(k: KindDef, st: SyncState, remoteRev: number, unchangedThere: boolean): Promise<void> {
    const local0 = k.read(this.store);
    const ks = st.kinds[k.kind];
    let rev = remoteRev;
    let remote: unknown = null;
    if (unchangedThere) {
      // nobody else changed it: the base is the server's copy
      remote = ks.base;
      if (same(local0, ks.base)) return;
    } else if (remoteRev > 0) {
      const r = (await this.client.request('GET', `/progress/${k.kind}`, undefined, { retries: 1 })) as { rev?: number; data?: unknown };
      rev = typeof r?.rev === 'number' ? r.rev : remoteRev;
      remote = r?.data ?? null;
    }
    // (the copy both last agreed on – none before the first round with this account: a union)
    const base = ks ? ks.base : null;
    let local = local0;
    for (let tries = 0; tries < 4; tries++) {
      const merged = local === null && remote === null ? null : local === null ? remote : remote === null ? k.merge(base, local, local) : k.merge(base, local, remote);
      if (merged === null) return;
      if (!same(merged, local)) {
        k.write(this.store, merged);
        // (what is in the browser now is not a change of the player's)
        this.seen.set(k.kind, JSON.stringify(k.read(this.store)));
        this.pulled(k.kind, merged);
        local = merged;
      }
      if (same(merged, remote)) {
        st.kinds[k.kind] = { rev, base: merged };
        return;
      }
      if (JSON.stringify(merged).length > MAX_BYTES) return;
      try {
        const r = (await this.client.request('PUT', `/progress/${k.kind}`, { rev, data: merged })) as { rev?: number };
        st.kinds[k.kind] = { rev: typeof r?.rev === 'number' ? r.rev : rev + 1, base: merged };
        return;
      } catch (e) {
        if (!(e instanceof ServerError) || e.status !== 409) throw e;
        // somebody was quicker: their copy (sent along, or fetched), merged in once more
        const b = (e.body ?? {}) as { rev?: number; data?: unknown; current?: { rev?: number; data?: unknown } };
        const cur = b.current ?? b;
        if (typeof cur.rev === 'number' && 'data' in cur) {
          rev = cur.rev;
          remote = cur.data ?? null;
        } else {
          const r = (await this.client.request('GET', `/progress/${k.kind}`)) as { rev?: number; data?: unknown };
          rev = typeof r?.rev === 'number' ? r.rev : rev;
          remote = r?.data ?? null;
        }
      }
    }
    throw new ServerError(409, 'conflict', 'Kept changing on the server');
  }
}
