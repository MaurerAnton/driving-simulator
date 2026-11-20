// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Compression codecs for the map parts (map-assets/*.tar, developer mode).
 *
 * A part is a tar whose entries may be stored compressed – gzip, deflate,
 * lzma2, … – and the game must be able to read whichever the developer chose
 * (they benchmark and pick per part; see map-assets/index.json, `codec`).
 *
 * Two ways to learn an entry's codec:
 *   - the index/manifest names it (`codec`), the usual case;
 *   - else the bytes are sniffed by their magic (detect), so an entry that
 *     names no codec still decodes when its format is recognisable.
 *
 * The formats a browser decompresses without any library (DecompressionStream)
 * are registered here: identity, gzip, deflate, deflate-raw, brotli.  A format
 * the browser has no decoder for (lzma2, zstd, …) is added by registering a
 * decoder below – the container (world/patchpart.ts) does not change.
 */

/** How an entry of a part is stored. */
export type Codec = 'identity' | 'gzip' | 'deflate' | 'deflate-raw' | 'brotli' | (string & {});

// (a CommonJS bundle: Node's ESM interop puts the class on the default export,
// Vite's bundler also exposes it by name – take whichever is there)
import xzPkg from 'xz-decompress';
type XzCtor = new (compressed: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
const XzReadableStream: XzCtor = (xzPkg as unknown as { XzReadableStream?: XzCtor }).XzReadableStream ?? (xzPkg as unknown as { default?: { XzReadableStream?: XzCtor } }).default?.XzReadableStream!;

const utf8 = new TextDecoder();

/** A decoder: the stored bytes to the plain bytes. */
type Decoder = (bytes: Uint8Array) => Promise<Uint8Array>;

/** The formats DecompressionStream speaks (a browser that lacks one simply fails that codec). */
const NATIVE: Record<string, string> = {
  gzip: 'gzip',
  deflate: 'deflate',
  'deflate-raw': 'deflate-raw',
  brotli: 'brotli',
};

async function native(format: string, bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format as CompressionFormat) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** The decoders: codec name → how to decode it.  Add more here when a part needs them. */
const decoders = new Map<string, Decoder>();
for (const [codec, format] of Object.entries(NATIVE)) decoders.set(codec, (b) => native(format, b));
/** plain bytes, nothing to do */
decoders.set('identity', async (b) => b);

/**
 * xz (the container of lzma2) through WebAssembly, without native code
 * (xz-decompress, MIT).  The browser has no decoder for it; a part may name
 * it "xz" or "lzma2" – both are this format's names here.
 */
async function xz(bytes: Uint8Array): Promise<Uint8Array> {
  // (XzReadableStream reads a compressed stream and yields the plain bytes – as the README has it)
  const stream = new Blob([bytes as BlobPart]).stream();
  const out = new Response(new XzReadableStream(stream) as unknown as BodyInit);
  const buf = await out.arrayBuffer();
  return new Uint8Array(buf);
}
decoders.set('xz', xz);
decoders.set('lzma2', xz);

/** Register a decoder for a codec the browser cannot decompress by itself (lzma2, zstd, …). */
export function registerCodec(codec: string, decode: Decoder): void {
  decoders.set(codec, decode);
}

/** Is there a decoder for `codec`? */
export function hasCodec(codec: string): boolean {
  return decoders.has(codec);
}

/** The codecs the game can decode right now (for the developer's settings). */
export function codecNames(): string[] {
  return [...decoders.keys()].sort();
}

/** Decode `bytes` with `codec`; rejects when there is no decoder for it. */
export async function decode(codec: Codec, bytes: Uint8Array): Promise<Uint8Array> {
  const d = decoders.get(codec);
  if (!d) throw new Error(`no decoder for codec "${codec}"`);
  return d(bytes);
}

/**
 * The codec of bytes that name none: their magic number.
 *   gzip        1f 8b
 *   deflate     78 01 / 78 9c / 78 da   (zlib)
 *   zstd        28 b5 2f fd
 *   xz          fd 37 7a 58 5a 00       (lzma2 inside)
 *   lz4         04 22 4d 18
 *   brotli      no fixed magic – never sniffed
 * Returns 'identity' for anything it does not know (plain bytes).
 */
export function detect(bytes: Uint8Array): Codec {
  const b = bytes;
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (b.length >= 2 && b[0] === 0x78 && (b[1] === 0x01 || b[1] === 0x9c || b[1] === 0xda)) return 'deflate';
  if (b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) return 'zstd';
  if (b.length >= 6 && b[0] === 0xfd && b[1] === 0x37 && b[2] === 0x7a && b[3] === 0x58 && b[4] === 0x5a && b[5] === 0x00) return 'xz';
  if (b.length >= 4 && b[0] === 0x04 && b[1] === 0x22 && b[2] === 0x4d && b[3] === 0x18) return 'lz4';
  return 'identity';
}

/**
 * Decode `bytes` with `codec` – or, when none is given, by sniffing the bytes.
 * The codec the index names wins; `undefined` means "find out from the bytes".
 */
export async function decodeAuto(codec: Codec | undefined, bytes: Uint8Array): Promise<Uint8Array> {
  return decode(codec ?? detect(bytes), bytes);
}

/** The plain text of an entry (the manifest, the index) – UTF-8. */
export function textOf(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}
