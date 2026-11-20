// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A map part (map-assets/N.tar) as the game reads it: a tar of tile files
 * (.fsb), each stored with some codec, plus the manifest that says which is
 * which (developer mode, settings: devMap).
 *
 * The part is held as the bytes it came in – nothing is unpacked until a tile
 * is asked for, and then only that tile (world/tarindex.ts finds it, the
 * codec of world/tarcodecs.ts decodes it).  So a part of 100 MB costs its
 * download and, for each tile actually shown, one slice and one decode.
 *
 * The manifest is one entry of the tar (MANIFEST), a JSON that names the
 * build's kind and each entry's codec:
 *
 *   { "type": "modified", "tiles": { "412_398": "gzip", "413_398": "lzma2" } }
 *
 * A part without a manifest still works: the codec of each entry is sniffed
 * from its bytes (world/tarcodecs.ts detect), and the type is assumed
 * 'modified' (world/tileversions.ts parsePatchType).
 */
import { TarIndexer, type TarEntry } from './tarindex.ts';
import { decodeAuto, textOf, type Codec } from './tarcodecs.ts';
import { parsePatchType, type PatchType } from './tileversions.ts';

/** The entry of a part that says what it is and how it is stored. */
export const MANIFEST = 'manifest.json';

/** What a part's manifest says. */
export interface PartManifest {
  /** what kind of build this is ('base' | 'modified' | 'unstable') */
  type: PatchType;
  /** the codec of each tile entry, by tile key; an entry left out is sniffed from its bytes */
  tiles: Record<string, Codec>;
  /**
   * the map files other than tiles this part holds, with their codec, by their
   * path in the map ("net.bin.gz", "w/50_49.json.gz") – a network change goes
   * with its tiles (world/netdiff.ts), so the manifest says as much as the
   * index does (world/tileversions.ts PartFile.maps).
   */
  maps: Record<string, Codec>;
}

/** A manifest read from a part: its kind and the codecs it names. */
export function parseManifest(json: unknown): PartManifest {
  const o = (typeof json === 'object' && json !== null ? json : {}) as { type?: unknown; tiles?: unknown; maps?: unknown };
  const read = (v: unknown): Record<string, Codec> => {
    const out: Record<string, Codec> = {};
    if (typeof v === 'object' && v !== null) for (const [k, c] of Object.entries(v as Record<string, unknown>)) if (typeof c === 'string') out[k] = c;
    return out;
  };
  return { type: parsePatchType(typeof o.type === 'string' ? o.type : undefined), tiles: read(o.tiles), maps: read(o.maps) };
}

/** One file of a part, where it lies in the bytes and how it is stored. */
interface Entry {
  path: string;
  offset: number;
  size: number;
  codec?: Codec;
}

/**
 * A part in memory: its bytes, the place of every file in them, and the
 * manifest that names their codecs.  `fromBytes` indexes the tar once;
 * `file` slices and decodes one entry on demand.
 */
export class PatchPart {
  /** its number in map-assets/index.json */
  readonly n: number;
  /** the file it was read from (for messages) */
  readonly name: string;
  readonly manifest: PartManifest;
  private readonly bytes: Uint8Array;
  private readonly entries = new Map<string, Entry>();
  /** decoded tiles, so a tile shown more than once is decoded once (cleared with `forget`) */
  private readonly decoded = new Map<string, Uint8Array>();

  private constructor(n: number, name: string, bytes: Uint8Array, manifest: PartManifest) {
    this.n = n;
    this.name = name;
    this.bytes = bytes;
    this.manifest = manifest;
  }

  /**
   * Read a part from its bytes: index the tar (one pass over the headers),
   * then take the manifest out of it.  Rejects when there is no tar in it.
   */
  static fromBytes(n: number, name: string, bytes: Uint8Array): PatchPart {
    const entries = new Map<string, Entry>();
    const ix = new TarIndexer((e: TarEntry) => entries.set(e.path, { path: e.path, offset: e.offset, size: e.size }), 0);
    // one chunk of everything: the headers are read as they stream past, the
    // bodies are only remembered by offset (nothing is copied)
    ix.push(bytes);
    ix.finish();
    if (entries.size === 0) throw new Error(`${name}: not a tar archive`);
    // the manifest, if it names the codecs
    let manifest: PartManifest = { type: 'modified', tiles: {}, maps: {} };
    const m = entries.get(MANIFEST);
    if (m) {
      try {
        manifest = parseManifest(JSON.parse(textOf(bytes.subarray(m.offset, m.offset + m.size))));
      } catch {
        // a manifest that is not readable JSON: sniff every entry instead
      }
    }
    const part = new PatchPart(n, name, bytes, manifest);
    for (const e of entries.values()) {
      const codec = manifest.tiles[e.path] ?? manifest.maps[e.path];
      part.entries.set(e.path, { ...e, codec });
    }
    return part;
  }

  /** Does the part hold this file (a tile key, or the manifest)? */
  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** The tile keys this part holds (its manifest's list, or every file but the manifest and map files). */
  tiles(): string[] {
    const keys = Object.keys(this.manifest.tiles);
    if (keys.length > 0) return keys;
    const maps = new Set(Object.keys(this.manifest.maps));
    return [...this.entries.keys()].filter((p) => p !== MANIFEST && !maps.has(p) && !p.startsWith('w/') && p !== 'net.bin.gz');
  }

  /** The map files other than tiles this part holds (their path in the map). */
  maps(): string[] {
    const keys = Object.keys(this.manifest.maps);
    if (keys.length > 0) return keys;
    return [...this.entries.keys()].filter((p) => p.startsWith('w/') || p === 'net.bin.gz');
  }

  /**
   * The plain bytes of one file of the part: its slice, decoded with the
   * codec its manifest names – or sniffed from the bytes when it names none.
   * A file that is not in the part is null.
   */
  async file(path: string): Promise<Uint8Array | null> {
    const hit = this.decoded.get(path);
    if (hit) return hit;
    const e = this.entries.get(path);
    if (!e) return null;
    const slice = this.bytes.subarray(e.offset, e.offset + e.size);
    const out = await decodeAuto(e.codec, slice);
    this.decoded.set(path, out);
    return out;
  }

  /** The size of the part's bytes (how much RAM it stands for). */
  get byteLength(): number {
    return this.bytes.byteLength;
  }

  /** Drop the decoded tiles (the part's bytes stay; `forgetAll` drops those too). */
  forget(): void {
    this.decoded.clear();
  }

  /** The bytes of the whole part (so a cache can drop the part entirely). */
  get raw(): Uint8Array {
    return this.bytes;
  }
}
