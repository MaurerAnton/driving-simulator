// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A map, and how it gets into memory.
 *
 * A map in one piece (world.json: small test maps, maps of older builds) is
 * read whole.  A map in pieces (map.json, written by tools/build-map.ts) is
 * a region too large for that: an index says what there is; the road
 * network comes in chunks of 4 km that are loaded around the place where
 * something happens and dropped again far behind; one small file holds every
 * road of the region in a few numbers, for planning routes and drawing the
 * whole map (netfile.ts).
 *
 * The same loader serves the game (files fetched from the server) and the
 * tools and tests (files read from disk): how a file is got is handed in.
 */
import { CHUNK, GRID_OFFSET, GridSet, TILE, gridIndex, gridStart } from './grid.ts';
import { unpackNet } from './netfile.ts';
import type { NetData } from './netfile.ts';
import type { MapIndexJson, RailJson, WorldChunkJson, WorldJson } from './types.ts';
import { World } from './world.ts';
import type { WorldChange, WorldOptions } from './world.ts';

/** How the files of a map folder are read. */
export interface MapFiles {
  /** a file of the folder as bytes (gunzipped if it is gzipped), or null if it is not there */
  bytes(path: string): Promise<ArrayBuffer | null>;
}

/** Which tiles a map has, and where they lie. */
export interface TileGrid {
  /** the corner of tile (0, 0) and the side of a tile */
  x0: number;
  z0: number;
  size: number;
  has(ix: number, iz: number): boolean;
}

export interface MapListener {
  /** roads and whole junctions that were added to the world */
  added?(change: WorldChange): void;
  /** roads and junctions that have just been taken out of the world – they still hold what they held */
  removed?(change: WorldChange): void;
}

async function readJson<T>(files: MapFiles, path: string): Promise<T | null> {
  const buf = await files.bytes(path);
  return buf ? (JSON.parse(new TextDecoder().decode(buf)) as T) : null;
}

/**
 * How many roads / junctions are added in one go: a step of a few
 * milliseconds, so that a frame of the game in which a piece of the network
 * arrives is not held up noticeably (a junction costs several times a road:
 * its area and every path through it are worked out).
 */
const EDGE_BATCH = 40;
const NODE_BATCH = 12;
/** how often a chunk is asked for before the game goes on without it */
const TRIES = 4;

export class MapLoader {
  readonly world: World;
  readonly tiles: TileGrid;
  /** does the road network come in chunks? */
  readonly pieces: boolean;
  /**
   * Which build of the map this is (from the time it was made): part of the
   * address of every other file of the map, so that a browser never mixes
   * files it kept from an older map with those of a newer one.
   */
  readonly version: string;
  private readonly files: MapFiles;
  private readonly chunks: GridSet | null;
  /** the junctions of each chunk that is loaded or being added */
  private readonly loaded = new Map<string, number[]>();
  private readonly fetching = new Set<string>();
  /** chunks that could not be fetched: how often it was tried, and when last (they are asked for again a few times) */
  private readonly failed = new Map<string, { n: number; at: number }>();
  /** what has arrived and waits to be added, in small portions */
  private readonly work: Array<{ key: string; part: WorldChunkJson }> = [];
  private readonly pending = new Map<string, number>();
  private readonly listeners: MapListener[] = [];
  /** the network is kept loaded within this distance (m) of the place of interest, and dropped beyond the other */
  loadRadius = 3200;
  keepRadius = 7000;
  private netData: Promise<NetData | null> | null = null;
  private railData: Promise<RailJson[]> | null = null;

  private constructor(files: MapFiles, world: World, tiles: TileGrid, chunks: GridSet | null) {
    this.files = files;
    this.world = world;
    this.tiles = tiles;
    this.chunks = chunks;
    this.pieces = chunks !== null;
    this.version = (world.json.meta.generated ?? '').replace(/\D/g, '').slice(0, 14);
  }

  static async open(files: MapFiles, opts: WorldOptions = {}): Promise<MapLoader> {
    const index = await readJson<MapIndexJson>(files, 'map.json');
    if (index) {
      const json: WorldJson = { version: index.version, meta: index.meta, nodes: [], edges: [], banned: [], signals: [], crossings: [], places: index.places, spawns: index.spawns, tiles: [] };
      if (index.yard) json.yard = index.yard;
      const tileSet = GridSet.from(index.tiles);
      return new MapLoader(files, new World(json, opts), { x0: -GRID_OFFSET, z0: -GRID_OFFSET, size: TILE, has: (ix, iz) => tileSet.has(ix, iz) }, GridSet.from(index.chunks));
    }
    const json = await readJson<WorldJson>(files, 'world.json');
    // (the map is not part of the repository: `npm run map:fetch` gets it, see docs/MAP_DATA.md)
    if (!json) throw new Error('The map is missing (public/map/map.json). Fetch it with: npm run map:fetch');
    const have = new Set(json.tiles);
    return new MapLoader(files, new World(json, opts), { x0: json.meta.minX, z0: json.meta.minZ, size: json.meta.tileSize, has: (ix, iz) => have.has(`${ix}_${iz}`) }, null);
  }

  listen(l: MapListener): void {
    this.listeners.push(l);
  }

  /** The chunks that reach into the circle of `radius` around (x, z): their keys. */
  private around(x: number, z: number, radius: number): string[] {
    const out: string[] = [];
    if (!this.chunks) return out;
    for (let cx = gridIndex(x - radius, CHUNK); cx <= gridIndex(x + radius, CHUNK); cx++) {
      for (let cz = gridIndex(z - radius, CHUNK); cz <= gridIndex(z + radius, CHUNK); cz++) {
        if (!this.chunks.has(cx, cz)) continue;
        // (the point of the chunk nearest to the place)
        const nx = Math.max(gridStart(cx, CHUNK), Math.min(gridStart(cx + 1, CHUNK), x));
        const nz = Math.max(gridStart(cz, CHUNK), Math.min(gridStart(cz + 1, CHUNK), z));
        if (Math.hypot(nx - x, nz - z) <= radius) out.push(`${cx}_${cz}`);
      }
    }
    return out;
  }

  /** Is the road network within `radius` of the place all there? */
  ready(x: number, z: number, radius = this.loadRadius): boolean {
    for (const key of this.around(x, z, radius)) {
      if (this.gaveUp(key)) continue;
      if (!this.loaded.has(key) || this.pending.has(key)) return false;
    }
    return true;
  }

  /** A chunk that was tried often enough: the game goes on without it. */
  private gaveUp(key: string): boolean {
    return (this.failed.get(key)?.n ?? 0) >= TRIES;
  }

  /** May a chunk be asked for (again)?  After a failure only after a while – a connection on the road comes and goes. */
  private mayFetch(key: string): boolean {
    const f = this.failed.get(key);
    return !f || (f.n < TRIES && performance.now() - f.at > 1500 * 2 ** (f.n - 1));
  }

  private async fetchChunk(key: string): Promise<void> {
    this.fetching.add(key);
    try {
      const chunk = await readJson<WorldChunkJson>(this.files, `w/${key}.json.gz`);
      if (!chunk) throw new Error('not there');
      this.failed.delete(key);
      // roads first (in portions), then the junctions: a junction needs all its roads
      this.loaded.set(key, chunk.nodes.map((n) => n[0]));
      let parts = 0;
      for (let i = 0; i < chunk.edges.length; i += EDGE_BATCH) {
        this.work.push({ key, part: { v: 1, nodes: [], edges: chunk.edges.slice(i, i + EDGE_BATCH), signals: i === 0 ? chunk.signals : [] } });
        parts++;
      }
      for (let i = 0; i < chunk.nodes.length; i += NODE_BATCH) {
        this.work.push({ key, part: { v: 1, nodes: chunk.nodes.slice(i, i + NODE_BATCH), edges: [], signals: [] } });
        parts++;
      }
      if (parts > 0) this.pending.set(key, parts);
    } catch (err) {
      console.warn('chunk of the road network failed', key, err);
      this.failed.set(key, { n: (this.failed.get(key)?.n ?? 0) + 1, at: performance.now() });
    } finally {
      this.fetching.delete(key);
    }
  }

  /** Add what has arrived, for at most `budgetMs` (at least one portion). */
  private addWork(budgetMs: number): void {
    const until = performance.now() + budgetMs;
    while (this.work.length > 0) {
      const { key, part } = this.work.shift() as { key: string; part: WorldChunkJson };
      // (a chunk that was dropped again before it was all in)
      if (this.loaded.has(key)) {
        const change = this.world.add(part);
        if (change.edges.length || change.nodes.length) for (const l of this.listeners) l.added?.(change);
      }
      const left = (this.pending.get(key) ?? 1) - 1;
      if (left > 0) this.pending.set(key, left);
      else this.pending.delete(key);
      if (performance.now() >= until) break;
    }
  }

  /**
   * Keep the road network around (x, z) loaded: asks for the chunks that are
   * missing, adds what has arrived (for `budgetMs` at most) and drops what
   * lies far away.  To be called every frame; does nothing for a map in one piece.
   */
  update(x: number, z: number, budgetMs = 4): void {
    if (!this.chunks) return;
    for (const key of this.around(x, z, this.loadRadius)) {
      if (!this.loaded.has(key) && !this.fetching.has(key) && this.mayFetch(key) && this.fetching.size < 3) void this.fetchChunk(key);
    }
    if (this.work.length > 0) this.addWork(budgetMs);
    else {
      // far behind: away with it (one chunk per call)
      for (const [key, nodes] of this.loaded) {
        if (this.pending.has(key)) continue;
        const [cx, cz] = key.split('_').map(Number);
        const nx = Math.max(gridStart(cx, CHUNK), Math.min(gridStart(cx + 1, CHUNK), x));
        const nz = Math.max(gridStart(cz, CHUNK), Math.min(gridStart(cz + 1, CHUNK), z));
        if (Math.hypot(nx - x, nz - z) <= this.keepRadius) continue;
        this.loaded.delete(key);
        const change = this.world.remove(nodes);
        if (change.edges.length || change.nodes.length) for (const l of this.listeners) l.removed?.(change);
        break;
      }
    }
  }

  /** Load the network within `radius` of a place and wait for it (tools, tests, and the game before a drive begins). */
  async loadAround(x: number, z: number, radius = this.loadRadius): Promise<void> {
    if (!this.chunks) return;
    const keys = this.around(x, z, radius).filter((k) => !this.loaded.has(k) && this.mayFetch(k));
    await Promise.all(keys.filter((k) => !this.fetching.has(k)).map((k) => this.fetchChunk(k)));
    while (this.fetching.size > 0) await new Promise((r) => setTimeout(r, 5));
    this.addWork(Infinity);
  }

  /** Load the whole network (small maps, tools). */
  async loadAll(): Promise<void> {
    if (!this.chunks) return;
    for (let cz = this.chunks.z0; cz < this.chunks.z0 + this.chunks.h; cz++) {
      for (let cx = this.chunks.x0; cx < this.chunks.x0 + this.chunks.w; cx++) {
        const key = `${cx}_${cz}`;
        if (this.chunks.has(cx, cz) && !this.loaded.has(key)) await this.fetchChunk(key);
      }
    }
    this.addWork(Infinity);
  }

  /** A JSON file of the map folder (gzipped or not), or null if it is not there. */
  json<T>(path: string): Promise<T | null> {
    return readJson<T>(this.files, path);
  }

  /** Every road of the map in a few numbers (for routes and the big map) – null for a map in one piece. */
  net(): Promise<NetData | null> {
    this.netData ??= this.pieces ? this.files.bytes('net.bin.gz').then((buf) => (buf ? unpackNet(buf) : null)) : Promise.resolve(null);
    return this.netData;
  }

  /** The tracks trams and trains run on. */
  rails(): Promise<RailJson[]> {
    this.railData ??= this.pieces
      ? readJson<{ rails: RailJson[] }>(this.files, 'rails.json.gz').then((r) => r?.rails ?? [])
      : Promise.resolve(this.world.json.rails ?? []);
    return this.railData;
  }
}
