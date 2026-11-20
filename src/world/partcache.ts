// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The parts a developer picks tiles from (map-assets/N.tar) held in memory,
 * so a tile from a part can be shown without downloading it every time
 * (developer mode, settings: devMap).
 *
 * A part is downloaded whole (20–100 MB), unpacked lazily tile by tile
 * (world/patchpart.ts) and kept – for as long as the budget allows.  It is
 * "not so important": when the parts together pass the budget, the one not
 * used for the longest goes first (and its decoded tiles with it).  Nothing
 * here is persisted: the parts come back on the next load, from the network.
 *
 * Where the bytes come from is a choice the developer makes in the settings
 * (fetch): the site's own files, a part of the repository, or a stored map
 * pack.  Each is one small strategy behind `PartSource`; the cache asks the
 * chosen one for a part's bytes and does the rest the same way.
 */
import { PatchPart } from './patchpart.ts';
import { parseIndex, type PartIndex, type PartFile } from './tileversions.ts';

/** Where a part's bytes come from. */
export type FetchMethod = 'site' | 'repo' | 'pack';

/** The settings of the developer mode (game/settings.ts devMap*). */
export interface PartCacheOptions {
  /** how to get a part's bytes */
  fetch: FetchMethod;
  /** the repository that holds map-assets (owner/repo), for 'repo' */
  repo?: string;
  /** the branch of that repository (raw serves it), for 'repo' */
  ref?: string;
  /** the folder of the parts in that repository, for 'repo' */
  dir?: string;
  /** how much of the parts to keep in memory, in megabytes */
  budgetMb: number;
  /** called while a part downloads: its share (0 … 1), or -1 when the size is not known */
  onProgress?: (share: number) => void;
}

/** The bytes of a part, or null when they are not there. */
export type PartSource = (file: string) => Promise<Uint8Array | null>;

/**
 * Fetch a part's bytes, reporting how much of it has come (the share the
 * loading bar shows).  The size is the response's content-length, when the
 * server says it (raw.githubusercontent does); without it the share is -1 and
 * only the bytes count (netstats) are shown.
 */
async function fetchBytes(url: string, onProgress?: (share: number) => void): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const total = Number(res.headers.get('content-length') ?? '');
    const known = Number.isFinite(total) && total > 0;
    if (!onProgress) return new Uint8Array(await res.arrayBuffer());
    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer());
      onProgress(1);
      return buf;
    }
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        got += value.byteLength;
        onProgress(known ? got / total : -1);
      }
    }
    onProgress(known ? 1 : -1);
    const out = new Uint8Array(got);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  } catch {
    return null;
  }
}

/** The default: the parts beside the site (same origin, no CORS question). */
export function siteSource(base: string, onProgress?: (share: number) => void): PartSource {
  return (file) => fetchBytes(`${base}map-assets/${file}`, onProgress);
}

/**
 * The parts of a repository, read from raw.githubusercontent.com – which
 * answers with `Access-Control-Allow-Origin: *`, so a page on another origin
 * (GitHub Pages) may fetch it.  The path is the same for every part:
 * `raw.githubusercontent.com/<repo>/<ref>/<dir>/<file>`.
 */
export function repoSource(repo: string, ref: string, dir: string, onProgress?: (share: number) => void): PartSource {
  const base = `https://raw.githubusercontent.com/${repo}/${ref}/${dir.replace(/\/+$/, '')}/`;
  return (file) => fetchBytes(`${base}${file}`, onProgress);
}

/** The source the chosen method gives: how a part's bytes are had. */
export function sourceFor(method: FetchMethod, opts: PartCacheOptions, siteBase: string): PartSource {
  if (method === 'repo') return repoSource(opts.repo ?? 'MaurerAnton/driving-simulator', opts.ref ?? 'main', opts.dir ?? 'map-assets', opts.onProgress);
  if (method === 'pack') {
    // the stored map pack answers map files through mapFetch; a part is one of them
    return (file) => fetchBytes(`map-assets/${file}`, opts.onProgress);
  }
  return siteSource(siteBase, opts.onProgress);
}

/** One part as the cache holds it: its index entry and its bytes. */
interface Held {
  file: PartFile;
  part: PatchPart;
  /** the last time a tile of it was asked for (for the eviction order) */
  usedAt: number;
}

/**
 * The parts in memory.  A tile is served by `tile(key)`: the part that holds
 * it (the newest that does, by the index) is fetched, unpacked on demand and
 * its tile decoded; when several parts hold it, the loaded/latest choice of
 * the caller decides which one, by `prefer`.
 */
export class PartCache {
  private readonly opts: PartCacheOptions;
  private readonly source: PartSource;
  private readonly held = new Map<number, Held>();
  /** the index of map-assets, fetched once */
  private index: PartIndex | null = null;
  private indexAt = 0;
  /** parts being fetched, so a tile asked twice waits once */
  private readonly loading = new Map<number, Promise<PatchPart | null>>();
  /** how much of the budget the held parts stand for */
  private bytes = 0;

  constructor(opts: PartCacheOptions, source: PartSource) {
    this.opts = opts;
    this.source = source;
  }

  /** The index of map-assets (fetched at most once every `ttlMs`). */
  async getIndex(ttlMs = 60_000): Promise<PartIndex | null> {
    if (this.index && Date.now() - this.indexAt < ttlMs) return this.index;
    const bytes = await this.source('index.json');
    if (!bytes) return this.index;
    try {
      const json = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      const { parseIndex: parse } = await import('./tileversions.ts');
      const idx = parse(json);
      if (idx) {
        this.index = idx;
        this.indexAt = Date.now();
      }
    } catch {
      // an index that is not readable: keep what was known
    }
    return this.index;
  }

  /** The bytes of one part, fetched once and kept. */
  async part(n: number): Promise<PatchPart | null> {
    const have = this.held.get(n);
    if (have) {
      have.usedAt = Date.now();
      return have.part;
    }
    const inflight = this.loading.get(n);
    if (inflight) return inflight;
    const idx = await this.getIndex();
    const file = idx?.files.find((f) => f.n === n);
    if (!file) return null;
    const promise = (async () => {
      this.opts.onProgress?.(0);
      const bytes = await this.source(file.file);
      if (!bytes) {
        this.opts.onProgress?.(-1);
        return null;
      }
      const part = PatchPart.fromBytes(n, file.file, bytes);
      this.keep(n, file, part);
      // (the bytes are all there: the bar is full – the sources report as they
      // stream, but a source that does not stream still closes the bar here)
      this.opts.onProgress?.(1);
      return part;
    })().finally(() => this.loading.delete(n));
    this.loading.set(n, promise);
    return promise;
  }

  /**
   * The tile `key`: the part that holds it, fetched and unpacked on demand.
   * `prefer` names the part to use when several hold the tile (the one the
   * developer chose, or the newest stable).
   */
  async tile(key: string, prefer?: number): Promise<{ part: number; bytes: Uint8Array } | null> {
    const idx = await this.getIndex();
    if (!idx) return null;
    // the parts that hold this tile, newest last; the preferred one wins
    const holders = idx.files.filter((f) => (f.tiles ?? []).includes(key));
    if (holders.length === 0) return null;
    const want = prefer != null && holders.some((f) => f.n === prefer) ? prefer : holders[holders.length - 1].n;
    const part = await this.part(want);
    if (!part) return null;
    const bytes = await part.file(key);
    return bytes ? { part: want, bytes } : null;
  }

  /**
   * A map file that is not a tile (`net.bin.gz`, `w/50_49.json.gz`), from the
   * part that holds it: the newest that declares it, or `prefer`.  This is how
   * a network change reaches the player with its tiles – the file a part
   * names under `maps` is served here, by its path in the map.
   */
  async mapFile(path: string, prefer?: number): Promise<{ part: number; bytes: Uint8Array } | null> {
    const idx = await this.getIndex();
    if (!idx) return null;
    const holders = idx.files.filter((f) => (f.maps ?? []).includes(path));
    if (holders.length === 0) return null;
    const want = prefer != null && holders.some((f) => f.n === prefer) ? prefer : holders[holders.length - 1].n;
    const part = await this.part(want);
    if (!part) return null;
    const bytes = await part.file(path);
    return bytes ? { part: want, bytes } : null;
  }

  /** The parts held now (for the settings' picture of the memory). */
  heldParts(): number[] {
    return [...this.held.keys()].sort((a, b) => a - b);
  }

  /** The megabytes the held parts stand for. */
  usedMb(): number {
    return this.bytes / (1024 * 1024);
  }

  /** Add a part to the held set, then drop the least recently used until within budget. */
  private keep(n: number, file: PartFile, part: PatchPart): void {
    if (this.held.has(n)) return;
    this.held.set(n, { file, part, usedAt: Date.now() });
    this.bytes += part.byteLength;
    const budget = this.opts.budgetMb * 1024 * 1024;
    while (this.bytes > budget && this.held.size > 1) {
      // the one used least recently, never the one just added
      let oldest: number | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of this.held) {
        if (k === n) continue;
        if (v.usedAt < oldestAt) {
          oldestAt = v.usedAt;
          oldest = k;
        }
      }
      if (oldest == null) break;
      const gone = this.held.get(oldest)!;
      this.bytes -= gone.part.byteLength;
      gone.part.forget();
      this.held.delete(oldest);
    }
  }

  /** Drop every part (the memory, not the network). */
  clear(): void {
    for (const v of this.held.values()) v.part.forget();
    this.held.clear();
    this.bytes = 0;
  }
}
