// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Map packs: a map loaded by hand from files and kept in the browser.
 *
 * The map the site serves is the one it was built with.  A bigger or another
 * one can be had as files of a release on GitHub (map.tar, or its parts
 * map.tar.00, map.tar.01, …, perhaps with tiles-patch.tar and small files
 * such as timetable.json.gz beside it) – but a page cannot fetch those
 * itself (GitHub sends them without CORS headers), so the player downloads
 * them and picks them here.
 *
 * They are stored as they come, in pieces of a few megabytes, in IndexedDB
 * (which every browser has, phones too, and which keeps big Blobs on disk):
 * the archives' bytes one after the other, and an index of where each file
 * of the map lies in them (world/tarindex.ts reads it while the bytes stream
 * past – nothing near the size of the map is ever held in memory).  The
 * parts of a split archive are put together in the order of their numbers;
 * archives picked besides (tiles-patch.tar) come after the map and win
 * where they hold the same file; any other file is a file of the map by its
 * own name.  .gz archives are inflated on the way in.
 *
 * The game reads the chosen pack through mapFetch (game/app.ts for the map's
 * files, render/tiles.ts for the tiles): addresses under the map folder are
 * answered from it, everything else from the network.  A file the pack does
 * not have is "not there" (404), not one of the site's map – that would
 * belong to another map.
 */
import { TarIndexer } from './tarindex.ts';

/** what is known of a stored map */
export interface PackInfo {
  id: string;
  /** the names of the files it was made of (shortened) */
  name: string;
  /** bytes stored */
  size: number;
  /** files of the map in it */
  files: number;
  /** when it was stored (ISO) */
  stored: string;
  /** the map's own name and build (map.json meta), if it says */
  map?: string;
  pieces: number;
}

/** why a map could not be stored: an i18n key of the reason (mapPack.err.*) */
export class MapPackError extends Error {
  readonly key: string;
  constructor(key: string, detail = '') {
    super(detail || key);
    this.key = key;
  }
}

const DB = 'fahrsim-baunatal.maps';
/** the size of a stored piece */
const PIECE = 8 << 20;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, fail) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error ?? new Error('IndexedDB'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((ok, fail) => {
    tx.oncomplete = () => ok();
    tx.onerror = () => fail(tx.error ?? new Error('IndexedDB'));
    tx.onabort = () => {
      const e = tx.error;
      fail(e && e.name === 'QuotaExceededError' ? new MapPackError('mapPack.err.space') : (e ?? new Error('IndexedDB: aborted')));
    };
  });
}

let dbOpen: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new MapPackError('mapPack.err.storage'));
  dbOpen ??= new Promise<IDBDatabase>((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      // packs: PackInfo by id; index: id → { path: [offset, size] }; pieces: [id, n] → Blob
      d.createObjectStore('packs', { keyPath: 'id' });
      d.createObjectStore('index');
      d.createObjectStore('pieces');
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(new MapPackError('mapPack.err.storage', String(r.error)));
    r.onblocked = () => fail(new MapPackError('mapPack.err.storage', 'blocked'));
  }).catch((e: unknown) => {
    dbOpen = null;
    throw e;
  });
  return dbOpen;
}

/** The maps stored in this browser, the newest first. */
export async function listMapPacks(): Promise<PackInfo[]> {
  try {
    const d = await db();
    const all = await req(d.transaction('packs').objectStore('packs').getAll() as IDBRequest<PackInfo[]>);
    return all.sort((a, b) => b.stored.localeCompare(a.stored));
  } catch {
    return [];
  }
}

/** Remove a stored map (and give its space back). */
export async function removeMapPack(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['packs', 'index', 'pieces'], 'readwrite');
  tx.objectStore('packs').delete(id);
  tx.objectStore('index').delete(id);
  tx.objectStore('pieces').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
  await done(tx);
}

/** How much this site keeps in the browser, and may keep (bytes) – null if the browser does not say. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e && typeof e.quota === 'number' ? { usage: e.usage ?? 0, quota: e.quota } : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ reading

/** A stored map, opened: its files by path. */
export class MapPack {
  readonly info: PackInfo;
  private readonly index: Record<string, [number, number]>;
  private readonly data: Blob;

  constructor(info: PackInfo, index: Record<string, [number, number]>, pieces: Blob[]) {
    this.info = info;
    this.index = index;
    // (a Blob of the stored Blobs: nothing is read until a slice of it is)
    this.data = new Blob(pieces);
  }

  has(path: string): boolean {
    return Object.hasOwn(this.index, path);
  }

  /** a file of the map (still as stored: gzip stays gzip), or null */
  file(path: string): Blob | null {
    const e = this.has(path) ? this.index[path] : undefined;
    return e ? this.data.slice(e[0], e[0] + e[1]) : null;
  }
}

/** Open a stored map – null if there is no such one (any more). */
export async function openMapPack(id: string): Promise<MapPack | null> {
  if (!id) return null;
  try {
    const d = await db();
    const tx = d.transaction(['packs', 'index', 'pieces']);
    const info = await req(tx.objectStore('packs').get(id) as IDBRequest<PackInfo | undefined>);
    if (!info) return null;
    const [index, pieces] = await Promise.all([
      req(tx.objectStore('index').get(id) as IDBRequest<Record<string, [number, number]> | undefined>),
      req(tx.objectStore('pieces').getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])) as IDBRequest<Blob[]>),
    ]);
    if (!index || pieces.length !== info.pieces) return null;
    return new MapPack(info, index, pieces);
  } catch (e) {
    console.warn('[map pack]', e);
    return null;
  }
}

let active: { base: string; pack: MapPack } | null = null;

/** A file of the map from a map part instead of the site (developer mode, settings: devMap). */
export type MapFileFromPart = (path: string) => Promise<Uint8Array | null>;
let fromPart: MapFileFromPart | null = null;
/** the address of the site's map folder, so a path can be read out of a map URL */
let base0: string | null = null;
/** set while one read wants the site's file, not the part's (to get the base a diff applies over) */
let bypassPart = false;

/**
 * Serve files of `map-assets` from the parts held in memory from now on
 * (null: from the site, as always) – the developer mode's delivery of new
 * tiles and of network changes (world/partcache.ts, world/netdiff.ts).
 * `path` is the path in the map: a tile key ("412_398"), "net.bin.gz",
 * "w/50_49.json.gz".
 */
export function useTileSource(src: MapFileFromPart | null, siteBase = ''): void {
  fromPart = src;
  base0 = src ? siteBase : null;
}

/** The stored map the game reads now, if it reads one. */
export function activeMapPack(): MapPack | null {
  return active?.pack ?? null;
}

/**
 * Read the map under `base` (the address of the site's map folder) from the
 * stored map `id` from now on – or from the network ('' or a map that is not
 * there any more: then false).
 */
export async function useMapPack(id: string, base: string): Promise<boolean> {
  const pack = await openMapPack(id);
  active = pack ? { base, pack } : null;
  if (id && !pack) console.warn(`[map pack] ${id} is not there: the map comes from the site`);
  return !!pack;
}

/** fetch – but a tile may come from a map part, and a file of the map from the stored map while one is in use. */
/**
 * Read a file of the map from the site, ignoring the parts – to get the base a
 * part's diff applies over (world/netdiff.ts).  The parts' own files are not
 * the base, so this must not be intercepted.
 */
export async function siteBytes(base: string, path: string): Promise<Uint8Array | null> {
  bypassPart = true;
  try {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    bypassPart = false;
  }
}

/** The path of a map file inside its address: what comes after the map folder, before the query. */
function mapPathOf(url: string, base: string): string | null {
  if (!url.startsWith(base)) return null;
  const rest = decodeURIComponent(url.slice(base.length).split(/[?#]/)[0]);
  return rest || null;
}

export function mapFetch(url: string, init?: RequestInit): Promise<Response> {
  // (a file the developer's part holds: tiles, the net, a network chunk – the part decides, the site does not)
  if (fromPart && base0 !== null && !bypassPart) {
    const path = mapPathOf(url, base0);
    if (path) {
      const key = path.startsWith('tiles/') && path.endsWith('.fsb') ? path.slice(6, -4) : path;
      return fromPart(key).then((bytes) => (bytes ? new Response(new Blob([bytes as BlobPart]), { status: 200 }) : fetch(url, init)));
    }
  }
  if (active && url.startsWith(active.base)) {
    const path = decodeURIComponent(url.slice(active.base.length).split(/[?#]/)[0]);
    const blob = active.pack.file(path);
    return Promise.resolve(blob ? new Response(blob, { status: 200 }) : new Response(null, { status: 404 }));
  }
  return fetch(url, init);
}

// ------------------------------------------------------------------ storing

/** How the picked files are taken: archives (a split one as its parts in order) and loose files. */
export interface PackSource {
  kind: 'tar' | 'file';
  files: File[];
  /** a loose file: its path in the map */
  path?: string;
  gzip: boolean;
}

/** The name a browser gave a download that was there already ("map.tar.01 (1)", "timetable (2).json.gz") put right. */
function cleanName(name: string): string {
  return name.replace(/ \(\d+\)(?=\.|$)/, '').replace(/ \(\d+\)$/, '');
}

/** Sort the picked files into what is to be read, in order. */
export function packSources(files: ReadonlyArray<File>): PackSource[] {
  const parts = new Map<string, Array<{ n: number; f: File }>>();
  const tars: PackSource[] = [];
  const loose: PackSource[] = [];
  for (const f of files) {
    const name = cleanName(f.name);
    const part = /^(.*\.tar)\.(\d+)$/.exec(name);
    if (part) {
      const list = parts.get(part[1]) ?? [];
      list.push({ n: Number(part[2]), f });
      parts.set(part[1], list);
    } else if (/\.(tar|tar\.gz|tgz)$/i.test(name)) tars.push({ kind: 'tar', files: [f], gzip: !/\.tar$/i.test(name) });
    else loose.push({ kind: 'file', files: [f], path: name.replace(/^.*[\\/]/, ''), gzip: false });
  }
  const whole: PackSource[] = [...parts.entries()].map(([, list]) => ({ kind: 'tar', files: list.sort((a, b) => a.n - b.n).map((p) => p.f), gzip: false }));
  const first = (s: PackSource): number => (/^map\.tar/.test(cleanName(s.files[0].name)) ? 0 : 1);
  // the map first (map.tar or its parts), other archives after it, loose files last: what comes later wins
  return [...whole, ...tars].sort((a, b) => first(a) - first(b) || a.files[0].name.localeCompare(b.files[0].name)).concat(loose);
}

/** Do the parts of a split archive follow each other without a gap (00, 01, 02, …)? */
export function missingPart(sources: ReadonlyArray<PackSource>): string | null {
  for (const s of sources) {
    const nums = s.files.map((f) => Number(/\.tar\.(\d+)$/.exec(cleanName(f.name))?.[1] ?? NaN));
    if (s.kind !== 'tar' || nums.some((n) => Number.isNaN(n))) continue;
    // (the name of the part that is missing: the number it would have)
    const name = (n: number): string => cleanName(s.files[0].name).replace(/\d+$/, (d) => String(n).padStart(d.length, '0'));
    if (nums[0] !== 0) return name(0);
    for (let i = 0; i < nums.length; i++) if (nums[i] !== i) return name(i);
  }
  return null;
}

/**
 * Store a map from the picked files.  `progress(read, total)` in bytes of the
 * files.  Throws a MapPackError (with the key of its reason) when it cannot.
 */
export async function importMapPack(files: ReadonlyArray<File>, progress: (read: number, total: number) => void, signal?: AbortSignal): Promise<PackInfo> {
  const sources = packSources(files);
  if (!sources.some((s) => s.kind === 'tar')) throw new MapPackError('mapPack.err.noTar');
  const gap = missingPart(sources);
  if (gap) throw new MapPackError('mapPack.err.part', gap);
  const total = files.reduce((a, f) => a + f.size, 0);
  const room = await storageEstimate();
  if (room && room.quota - room.usage < total) throw new MapPackError('mapPack.err.space');
  // (ask for the storage to be kept: otherwise a browser short of space may clear it)
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* not offered */
  }
  const d = await db();
  const id = `m${Date.now().toString(36)}`;
  const index: Record<string, [number, number]> = {};
  let pos = 0;
  let read = 0;
  let piece = 0;
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  const flush = async (): Promise<void> => {
    if (heldBytes === 0) return;
    const blob = new Blob(held as BlobPart[]);
    held = [];
    heldBytes = 0;
    const tx = d.transaction('pieces', 'readwrite');
    tx.objectStore('pieces').put(blob, [id, piece++]);
    await done(tx);
  };
  const keep = async (chunk: Uint8Array): Promise<void> => {
    held.push(chunk);
    heldBytes += chunk.length;
    pos += chunk.length;
    if (heldBytes >= PIECE) await flush();
  };
  const counted = (f: File): ReadableStream<Uint8Array> =>
    f.stream().pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(c, ctl) {
          read += c.length;
          progress(read, total);
          ctl.enqueue(c);
        },
      }),
    );
  const pump = async (stream: ReadableStream<Uint8Array>, each: (c: Uint8Array) => void): Promise<void> => {
    const reader = stream.getReader();
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel();
        throw new MapPackError('mapPack.err.cancelled');
      }
      const { value, done: end } = await reader.read();
      if (end) break;
      each(value);
      await keep(value);
    }
  };
  try {
    for (const s of sources) {
      if (s.kind === 'file') {
        const at = pos;
        await pump(counted(s.files[0]), () => {});
        index[s.path as string] = [at, s.files[0].size];
        continue;
      }
      const ix = new TarIndexer((e) => (index[e.path] = [e.offset, e.size]), pos);
      try {
        for (const f of s.files) {
          const stream = s.gzip ? counted(f).pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>) : counted(f);
          await pump(stream, (c) => ix.push(c));
        }
        ix.finish();
      } catch (e) {
        if (e instanceof MapPackError) throw e;
        throw new MapPackError('mapPack.err.notTar', `${s.files[0].name}: ${(e as Error).message}`);
      }
    }
    await flush();
    if (!index['map.json']) throw new MapPackError('mapPack.err.notMap');
    // the map's name and build, from its index
    let mapName: string | undefined;
    try {
      const [o, n] = index['map.json'];
      if (n < 4 << 20) {
        const tx = d.transaction('pieces');
        const pieces = await req(tx.objectStore('pieces').getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])) as IDBRequest<Blob[]>);
        const meta = (JSON.parse(await new Blob(pieces).slice(o, o + n).text()) as { meta?: { name?: string; generated?: string } }).meta;
        if (meta?.name) mapName = `${meta.name}${meta.generated ? ` (${meta.generated.slice(0, 10)})` : ''}`;
      }
    } catch {
      /* no name then */
    }
    const names = sources.map((s) => cleanName(s.files[0].name).replace(/\.00$/, '') + (s.files.length > 1 ? ` (${s.files.length})` : ''));
    const info: PackInfo = {
      id,
      name: names.join(', ').slice(0, 120),
      size: pos,
      files: Object.keys(index).length,
      stored: new Date().toISOString(),
      pieces: piece,
      ...(mapName ? { map: mapName } : {}),
    };
    const tx = d.transaction(['packs', 'index'], 'readwrite');
    tx.objectStore('index').put(index, id);
    tx.objectStore('packs').put(info);
    await done(tx);
    return info;
  } catch (e) {
    held = [];
    await removeMapPack(id).catch(() => {});
    if (e instanceof MapPackError) throw e;
    if (e instanceof DOMException && e.name === 'QuotaExceededError') throw new MapPackError('mapPack.err.space');
    throw new MapPackError('mapPack.err.other', (e as Error).message);
  }
}
