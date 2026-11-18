// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Minimal streaming reader for OpenStreetMap PBF files (the format Geofabrik
 * publishes).  Dependency-free: protobuf wire decoding + zlib from node.
 *
 * Only what the map pipeline needs is decoded: ids, coordinates, tags, way
 * node references and relation members.  Author/changeset metadata is skipped.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { latLonToWorld, worldToLatLon } from '../../src/geo/utm.ts';
import { additions, correctTags, geometryCorrections, hasGeometryCorrections, nodeShifts, roadCorrections } from '../mapgen/observedroads.ts';
import type { Shift } from '../mapgen/observedroads.ts';

export type Tags = Record<string, string>;

export interface OsmMember {
  type: 'n' | 'w' | 'r';
  ref: number;
  role: string;
}

export interface OsmHandlers {
  /** Return quickly: called for every node in the file. `tags()` is lazy. */
  node?(id: number, lat: number, lon: number, tags: () => Tags | null): void;
  way?(id: number, refs: number[], tags: () => Tags): void;
  relation?(id: number, members: () => OsmMember[], tags: () => Tags): void;
  progress?(bytesRead: number, bytesTotal: number): void;
}

/** Cursor over a protobuf-encoded byte range. */
class Reader {
  buf: Uint8Array;
  pos: number;
  end: number;

  constructor(buf: Uint8Array, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  /** Unsigned varint as a double; exact up to 2^53 (OSM ids fit comfortably). */
  varint(): number {
    const buf = this.buf;
    let b = buf[this.pos++];
    if (b < 128) return b;
    let result = b & 0x7f;
    let mul = 128;
    do {
      b = buf[this.pos++];
      result += (b & 0x7f) * mul;
      mul *= 128;
    } while (b >= 128);
    return result;
  }

  /** ZigZag-encoded signed varint. */
  svarint(): number {
    const n = this.varint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }

  /** Length-delimited field: returns a sub-reader and advances past it. */
  sub(): Reader {
    const len = this.varint();
    const r = new Reader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return r;
  }

  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2: {
        // Not `this.pos += this.varint()`: JS reads the left operand first, which
        // would discard the bytes consumed by the length prefix itself.
        const len = this.varint();
        this.pos += len;
        break;
      }
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }

  get more(): boolean {
    return this.pos < this.end;
  }
}

const utf8 = new TextDecoder('utf-8');

function parseBlobHeader(buf: Uint8Array): { type: string; dataSize: number } {
  const r = new Reader(buf);
  let type = '';
  let dataSize = 0;
  while (r.more) {
    const key = r.varint();
    const field = key >>> 3;
    const wt = key & 7;
    if (field === 1) type = utf8.decode(r.bytes());
    else if (field === 3) dataSize = r.varint();
    else r.skip(wt);
  }
  return { type, dataSize };
}

function parseBlob(buf: Uint8Array): Uint8Array {
  const r = new Reader(buf);
  let raw: Uint8Array | null = null;
  let zlibData: Uint8Array | null = null;
  while (r.more) {
    const key = r.varint();
    const field = key >>> 3;
    const wt = key & 7;
    if (field === 1) raw = r.bytes();
    else if (field === 3) zlibData = r.bytes();
    else if (field === 4 || field === 6 || field === 7) {
      throw new Error('PBF blob uses lzma/lz4/zstd compression, which this reader does not support');
    } else r.skip(wt);
  }
  if (raw) return raw;
  if (zlibData) return inflateSync(zlibData);
  throw new Error('PBF blob without data');
}

function parsePrimitiveBlock(buf: Uint8Array, h: OsmHandlers): void {
  const r = new Reader(buf);
  let strings: string[] = [];
  const groups: Reader[] = [];
  let granularity = 100;
  let latOffset = 0;
  let lonOffset = 0;
  while (r.more) {
    const key = r.varint();
    const field = key >>> 3;
    const wt = key & 7;
    if (field === 1) {
      const st = r.sub();
      strings = [];
      while (st.more) {
        const k = st.varint();
        if (k >>> 3 === 1) strings.push(utf8.decode(st.bytes()));
        else st.skip(k & 7);
      }
    } else if (field === 2) groups.push(r.sub());
    else if (field === 17) granularity = r.varint();
    else if (field === 19) latOffset = r.varint();
    else if (field === 20) lonOffset = r.varint();
    else r.skip(wt);
  }
  const scale = granularity * 1e-9;
  const lat0 = latOffset * 1e-9;
  const lon0 = lonOffset * 1e-9;

  for (const g of groups) {
    while (g.more) {
      const key = g.varint();
      const field = key >>> 3;
      const wt = key & 7;
      if (field === 2 && h.node) parseDense(g.sub(), strings, scale, lat0, lon0, h);
      else if (field === 1 && h.node) parsePlainNode(g.sub(), strings, scale, lat0, lon0, h);
      else if (field === 3 && h.way) parseWay(g.sub(), strings, h);
      else if (field === 4 && h.relation) parseRelation(g.sub(), strings, h);
      else g.skip(wt);
    }
  }
}

function parsePlainNode(
  r: Reader,
  strings: string[],
  scale: number,
  lat0: number,
  lon0: number,
  h: OsmHandlers,
): void {
  let id = 0;
  let lat = 0;
  let lon = 0;
  let keys: Reader | null = null;
  let vals: Reader | null = null;
  while (r.more) {
    const key = r.varint();
    const field = key >>> 3;
    if (field === 1) id = r.svarint();
    else if (field === 2) keys = r.sub();
    else if (field === 3) vals = r.sub();
    else if (field === 8) lat = r.svarint();
    else if (field === 9) lon = r.svarint();
    else r.skip(key & 7);
  }
  h.node!(id, lat0 + lat * scale, lon0 + lon * scale, () => {
    if (!keys || !vals) return null;
    const tags: Tags = {};
    while (keys.more) tags[strings[keys.varint()]] = strings[vals.varint()];
    return tags;
  });
}

function parseDense(
  r: Reader,
  strings: string[],
  scale: number,
  lat0: number,
  lon0: number,
  h: OsmHandlers,
): void {
  let ids: Reader | null = null;
  let lats: Reader | null = null;
  let lons: Reader | null = null;
  let kv: Reader | null = null;
  while (r.more) {
    const key = r.varint();
    const field = key >>> 3;
    if (field === 1) ids = r.sub();
    else if (field === 8) lats = r.sub();
    else if (field === 9) lons = r.sub();
    else if (field === 10) kv = r.sub();
    else r.skip(key & 7);
  }
  if (!ids || !lats || !lons) return;
  const hasTags = kv !== null && kv.more;
  let id = 0;
  let lat = 0;
  let lon = 0;
  const onNode = h.node!;
  while (ids.more) {
    id += ids.svarint();
    lat += lats.svarint();
    lon += lons.svarint();
    let tagStart = -1;
    if (hasTags) {
      // keys_vals: k v k v ... 0 — remember where this node's run starts and skip it.
      tagStart = kv!.pos;
      while (kv!.varint() !== 0) kv!.varint();
    }
    const start = tagStart;
    onNode(id, lat0 + lat * scale, lon0 + lon * scale, () => {
      if (start < 0) return null;
      const t = new Reader(kv!.buf, start, kv!.end);
      let k = t.varint();
      if (k === 0) return null;
      const tags: Tags = {};
      while (k !== 0) {
        tags[strings[k]] = strings[t.varint()];
        k = t.varint();
      }
      return tags;
    });
  }
}

function parseWay(r: Reader, strings: string[], h: OsmHandlers): void {
  let id = 0;
  let keys: Reader | null = null;
  let vals: Reader | null = null;
  const refs: number[] = [];
  while (r.more) {
    const key = r.varint();
    const field = key >>> 3;
    if (field === 1) id = r.varint();
    else if (field === 2) keys = r.sub();
    else if (field === 3) vals = r.sub();
    else if (field === 8) {
      const rr = r.sub();
      let ref = 0;
      while (rr.more) {
        ref += rr.svarint();
        refs.push(ref);
      }
    } else r.skip(key & 7);
  }
  h.way!(id, refs, () => {
    const tags: Tags = {};
    if (keys && vals) while (keys.more) tags[strings[keys.varint()]] = strings[vals.varint()];
    return tags;
  });
}

const MEMBER_TYPES = ['n', 'w', 'r'] as const;

function parseRelation(r: Reader, strings: string[], h: OsmHandlers): void {
  let id = 0;
  let keys: Reader | null = null;
  let vals: Reader | null = null;
  let roles: Reader | null = null;
  let memIds: Reader | null = null;
  let types: Reader | null = null;
  while (r.more) {
    const key = r.varint();
    const field = key >>> 3;
    if (field === 1) id = r.varint();
    else if (field === 2) keys = r.sub();
    else if (field === 3) vals = r.sub();
    else if (field === 8) roles = r.sub();
    else if (field === 9) memIds = r.sub();
    else if (field === 10) types = r.sub();
    else r.skip(key & 7);
  }
  h.relation!(
    id,
    () => {
      const members: OsmMember[] = [];
      if (!roles || !memIds || !types) return members;
      let ref = 0;
      while (memIds.more) {
        ref += memIds.svarint();
        members.push({ type: MEMBER_TYPES[types.varint()], ref, role: strings[roles.varint()] });
      }
      return members;
    },
    () => {
      const tags: Tags = {};
      if (keys && vals) while (keys.more) tags[strings[keys.varint()]] = strings[vals.varint()];
      return tags;
    },
  );
}

/**
 * How far the nodes of the ways the corrections move are moved (null: none
 * are).  The nodes of those ways are looked up in the PBF once and kept
 * beside it (`<pbf>.shift-refs.json`, until the PBF changes or a way is added
 * to the list).
 */
export function pbfNodeShifts(path: string): Map<number, Shift> | null {
  const geo = geometryCorrections();
  if (!hasGeometryCorrections(geo)) return null;
  const st = statSync(path);
  const cacheFile = `${path}.shift-refs.json`;
  let cache: { size: number; mtime: number; ways: Record<string, number[]> } = { size: st.size, mtime: st.mtimeMs, ways: {} };
  if (existsSync(cacheFile)) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, 'utf8')) as typeof cache;
      if (c.size === st.size && c.mtime === st.mtimeMs && c.ways) cache = c;
    } catch {
      // (read again)
    }
  }
  const missing = new Set([...geo.ways.keys()].filter((id) => cache.ways[id] === undefined));
  if (missing.size > 0) {
    console.log(`[pbf] finding the nodes of ${missing.size} shifted ways (tools/mapgen/observed-roads.json) …`);
    readPbf(
      path,
      {
        way(id, refs) {
          if (missing.has(id)) cache.ways[id] = refs.slice();
        },
      },
      { raw: true },
    );
    for (const id of missing) if (cache.ways[id] === undefined) cache.ways[id] = [];
    try {
      writeFileSync(cacheFile, JSON.stringify(cache));
    } catch {
      // (a read-only place: found again next time)
    }
  }
  const ways = [...geo.ways.keys()].map((id) => ({ id, refs: cache.ways[id] ?? [] }));
  return nodeShifts(ways, geo);
}

/** Options of readPbf. */
export interface ReadPbfOptions {
  /** true: the data as mapped, without the corrections of tools/mapgen/observed-roads.json (tags and geometry) */
  raw?: boolean;
  /** with `raw`: still correct the tags (the extracts: their coordinates stay as mapped, OsmData.load moves them) */
  tags?: boolean;
}

/** Stream a .osm.pbf file through the given handlers (synchronous). */
export function readPbf(path: string, given: OsmHandlers, opts: ReadPbfOptions = {}): void {
  // (the corrections of what was seen on site go over the tags of the ways: tools/mapgen/observedroads.ts)
  const fixes = opts.raw && !opts.tags ? new Map() : roadCorrections();
  // (ways that are not there are left out – not in the extracts, which keep them for OsmData.load to drop)
  const removed = opts.raw ? new Set<number>() : additions().remove;
  const way = given.way;
  let handlers: OsmHandlers =
    way && (fixes.size > 0 || removed.size > 0)
      ? { ...given, way: (id, refs, tags) => (removed.has(id) ? undefined : way(id, refs, fixes.has(id) ? () => correctTags(tags(), fixes.get(id)) : tags)) }
      : given;
  // (and where a way lies off the road, its nodes are moved)
  const node = given.node;
  const shifts = node && !opts.raw ? pbfNodeShifts(path) : null;
  if (node && shifts && shifts.size > 0) {
    handlers = {
      ...handlers,
      node(id, lat, lon, tags) {
        const sh = shifts.get(id);
        if (!sh) return node(id, lat, lon, tags);
        const [x, z] = latLonToWorld(lat, lon);
        const [la, lo] = worldToLatLon(x + sh[0], z + sh[1]);
        node(id, la, lo, tags);
      },
    };
  }
  const fd = openSync(path, 'r');
  try {
    const total = fstatSync(fd).size;
    const lenBuf = Buffer.alloc(4);
    let offset = 0;
    let scratch = Buffer.alloc(1 << 20);
    let lastReport = 0;
    while (offset < total) {
      if (readSync(fd, lenBuf, 0, 4, offset) !== 4) break;
      offset += 4;
      const headerLen = lenBuf.readUInt32BE(0);
      if (scratch.length < headerLen) scratch = Buffer.alloc(headerLen * 2);
      readSync(fd, scratch, 0, headerLen, offset);
      offset += headerLen;
      const header = parseBlobHeader(scratch.subarray(0, headerLen));
      if (scratch.length < header.dataSize) scratch = Buffer.alloc(header.dataSize * 2);
      readSync(fd, scratch, 0, header.dataSize, offset);
      offset += header.dataSize;
      if (header.type === 'OSMData') {
        parsePrimitiveBlock(parseBlob(scratch.subarray(0, header.dataSize)), handlers);
      }
      if (handlers.progress && offset - lastReport > 32 << 20) {
        lastReport = offset;
        handlers.progress(offset, total);
      }
    }
  } finally {
    closeSync(fd);
  }
}
