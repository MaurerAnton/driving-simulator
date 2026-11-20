// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A map part (world/patchpart.ts): read a tar of tile files, learn from its
 * manifest how each entry is stored, and take one tile out decoded – the
 * developer mode's delivery of new tiles (settings: devMap).
 *
 * The part is built here as the bytes a tar would have (a header block per
 * file, then its body), with entries stored under different codecs, so the
 * container, the manifest and the codec registry are all exercised.
 *
 *   node --test tests/world/patchpart.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync, deflateSync } from 'node:zlib';
import { MANIFEST, PatchPart, parseManifest } from '../../src/world/patchpart.ts';
import { detect, decode, codecNames, hasCodec } from '../../src/world/tarcodecs.ts';
import { parseIndex, parsePatchType, versionsOfTile, versionedTiles } from '../../src/world/tileversions.ts';

/** The bytes of a tar: one 512-byte header per file (name, size), then the bodies. */
function tar(files: Array<{ path: string; data: Uint8Array }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const header = (path: string, size: number): Uint8Array => {
    const h = new Uint8Array(512);
    const name = new TextEncoder().encode(path);
    h.set(name.subarray(0, 100), 0); // name
    const mode = '0000644\0';
    h.set(new TextEncoder().encode(mode), 100);
    h.set(new TextEncoder().encode('0000000\0'), 108); // uid
    h.set(new TextEncoder().encode('0000000\0'), 116); // gid
    h.set(new TextEncoder().encode(size.toString(8).padStart(11, '0') + '\0'), 124); // size (octal, as tar has it)
    h.set(new TextEncoder().encode('00000000000\0'), 136); // mtime
    h.fill(0x20, 148, 156); // checksum: spaces first
    h[156] = 0x30; // typeflag: regular file
    h.set(new TextEncoder().encode('ustar\0'), 257);
    h.set(new TextEncoder().encode('00'), 263);
    let sum = 0;
    for (const b of h) sum += b;
    const chk = (sum.toString(8).padStart(6, '0') + '\0 ').slice(0, 8);
    h.set(new TextEncoder().encode(chk), 148);
    return h;
  };
  const pad = (n: number): Uint8Array => new Uint8Array((512 - (n % 512)) % 512);
  for (const f of files) {
    blocks.push(header(f.path, f.data.length));
    blocks.push(f.data);
    blocks.push(pad(f.data.length));
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks: end of archive
  const total = blocks.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/** the tile body as a game reads it: a few plain bytes (the .fsb's own gzip is irrelevant here) */
const tile = (s: string): Uint8Array => new TextEncoder().encode(s);

test('a part: the manifest names the codec of each entry, and a tile comes out decoded', async () => {
  const manifest = JSON.stringify({ type: 'modified', tiles: { 'a_1': 'gzip', 'b_2': 'deflate', 'c_3': 'identity' } });
  const bytes = tar([
    { path: MANIFEST, data: new TextEncoder().encode(manifest) },
    { path: 'a_1', data: new Uint8Array(gzipSync(Buffer.from('GZIP-TILE'))) },
    { path: 'b_2', data: new Uint8Array(deflateSync(Buffer.from('DEFLATE-TILE'))) },
    { path: 'c_3', data: tile('PLAIN-TILE') },
  ]);
  const part = PatchPart.fromBytes(1, '1.tar', bytes);
  assert.equal(part.manifest.type, 'modified');
  assert.equal(part.has('a_1'), true);
  assert.equal(part.has('nope'), false);
  assert.deepEqual(part.tiles().sort(), ['a_1', 'b_2', 'c_3']);
  assert.equal(new TextDecoder().decode((await part.file('a_1'))!), 'GZIP-TILE');
  assert.equal(new TextDecoder().decode((await part.file('b_2'))!), 'DEFLATE-TILE');
  assert.equal(new TextDecoder().decode((await part.file('c_3'))!), 'PLAIN-TILE');
  assert.equal(await part.file('missing'), null);
});

test('a part without a manifest: each entry is decoded by sniffing its bytes', async () => {
  const bytes = tar([
    { path: 'a_1', data: new Uint8Array(gzipSync(Buffer.from('SNIFFED-GZIP'))) },
    { path: 'b_2', data: tile('SNIFFED-PLAIN') },
  ]);
  const part = PatchPart.fromBytes(2, '2.tar', bytes);
  assert.equal(part.manifest.type, 'modified', 'no manifest: assumed modified');
  assert.equal(new TextDecoder().decode((await part.file('a_1'))!), 'SNIFFED-GZIP');
  assert.equal(new TextDecoder().decode((await part.file('b_2'))!), 'SNIFFED-PLAIN');
});

test('a part whose manifest is not JSON: falls back to sniffing, does not throw', async () => {
  const bytes = tar([
    { path: MANIFEST, data: new TextEncoder().encode('{ not json') },
    { path: 'a_1', data: new Uint8Array(gzipSync(Buffer.from('OK'))) },
  ]);
  const part = PatchPart.fromBytes(3, '3.tar', bytes);
  assert.equal(part.manifest.type, 'modified');
  assert.equal(new TextDecoder().decode((await part.file('a_1'))!), 'OK');
});

test('not a tar: reading it says so', () => {
  // (the indexer rejects it: a non-tar breaks off mid-file, or has a bad header)
  assert.throws(() => PatchPart.fromBytes(9, 'x.tar', new TextEncoder().encode('hello')), /not a tar|breaks off/);
});

test('the codec registry: the formats a browser decodes, and sniffing the rest', async () => {
  assert.ok(hasCodec('gzip') && hasCodec('deflate') && hasCodec('identity'));
  assert.equal(detect(new Uint8Array([0x1f, 0x8b, 8, 0])), 'gzip');
  assert.equal(detect(new Uint8Array([0x78, 0x9c])), 'deflate');
  assert.equal(detect(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])), 'zstd');
  assert.equal(detect(new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0])), 'xz');
  assert.equal(detect(new Uint8Array([1, 2, 3])), 'identity');
  // gzip round-trip through the registry
  const gz = new Uint8Array(gzipSync(Buffer.from('ROUND')));
  assert.equal(new TextDecoder().decode(await decode('gzip', gz)), 'ROUND');
  assert.equal(new TextDecoder().decode(await decode('identity', gz)), new TextDecoder().decode(gz), 'identity is as-is');
  await assert.rejects(() => decode('nope', gz), /no decoder/);
});

test('lzma2 (xz): a browser has no decoder for it, so it comes bundled (xz-decompress)', async () => {
  // (the magic of xz: fd 37 7a 58 5a 00 – what detect() looks for)
  assert.ok(hasCodec('xz') && hasCodec('lzma2'), 'both names are registered');
  assert.ok(codecNames().includes('xz'));
  assert.equal(detect(new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])), 'xz');
  // (a real xz of the words below: made with `printf '…' | xz -c -F xz`, kept as bytes)
  const xz = new Uint8Array([
    253, 55, 122, 88, 90, 0, 0, 4, 230, 214, 180, 70, 4, 192, 27, 47, 33, 1, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 173, 172, 216, 105, 224, 0, 46, 0, 19, 93, 0, 52, 25, 73, 238, 141, 233, 23, 137, 58, 51, 95, 253, 129, 224, 30, 12, 136, 0, 0, 0, 0, 149, 149, 103, 146, 114, 66, 161, 114, 0, 1, 55, 47, 70, 40, 80, 27, 31, 182, 243, 125, 1, 0, 0, 0, 0, 4, 89, 90,
  ]);
  const expect = 'hello world hello world hello world hello world';
  assert.equal(new TextDecoder().decode(await decode('xz', xz)), expect, 'xz decodes');
  assert.equal(new TextDecoder().decode(await decode('lzma2', xz)), expect, 'lzma2 is the same format here');
});

test('the type: the contract a shipped part names its build by', () => {
  assert.equal(parsePatchType('base'), 'base');
  assert.equal(parsePatchType('b'), 'base');
  assert.equal(parsePatchType('modified'), 'modified');
  assert.equal(parsePatchType('stable'), 'modified');
  assert.equal(parsePatchType('unstable'), 'unstable');
  assert.equal(parsePatchType('dev'), 'unstable');
  assert.equal(parsePatchType(''), 'modified');
  assert.equal(parsePatchType(undefined), 'modified');
  assert.equal(parsePatchType('nonsense'), 'modified', 'unknown: the safe default');
});

test('the index: which files exist, which is latest, and which tiles each holds', () => {
  const idx = parseIndex({
    latest: 3,
    files: [
      { n: 1, file: '1.tar', type: 'base', codec: 'gzip', tiles: ['a_1'] },
      { n: 2, file: '2.tar', type: 'modified', codec: 'gzip', tiles: ['a_1', 'b_2'] },
      { n: 3, file: '3.tar', type: 'unstable', codec: 'lzma2', tiles: ['b_2'] },
    ],
  });
  assert.ok(idx);
  assert.equal(idx.latest, 3);
  assert.deepEqual(idx.files.map((f) => f.n), [1, 2, 3]);
  assert.equal(idx.files[2].type, 'unstable');
  assert.deepEqual([...versionedTiles(idx)].sort(), ['a_1', 'b_2']);
  // the version list of a tile, in order, the loaded one marked
  const list = versionsOfTile(idx, 'a_1', 2);
  assert.deepEqual(list.map((v) => v.label), ['base', 'modified 2', 'modified-latest-stable']);
  assert.equal(list[1].loaded, true, 'the loaded part is marked');
  const u = versionsOfTile(idx, 'b_2', 3);
  // part 2 holds b_2 and is the newest stable: it is both a version and the latest-stable slot
  assert.deepEqual(u.map((v) => v.label), ['modified 2', 'unstable 3', 'modified-latest-stable', 'unstable-latest']);
});

test('parseIndex: a file without a number or name is dropped, not fatal', () => {
  const idx = parseIndex({ latest: 1, files: [{ n: 1, file: '1.tar' }, { file: 'no-number.tar' }, 'not-an-object', { n: 3, file: '3.tar', type: 'unstable' }] });
  assert.ok(idx);
  assert.deepEqual(idx.files.map((f) => f.n), [1, 3], 'sorted by n');
  assert.equal(idx.latest, 1);
  assert.equal(parseIndex(null), null);
  assert.equal(parseIndex({ nope: 1 }), null);
});

test('parseManifest: codecs by entry, unknown type to modified', () => {
  const m = parseManifest({ type: 'unstable', tiles: { 'a_1': 'gzip', 'b_2': 42, 'c_3': 'lzma2' } });
  assert.equal(m.type, 'unstable');
  assert.deepEqual(m.tiles, { a_1: 'gzip', c_3: 'lzma2' }, 'a non-string codec is left out');
  assert.equal(parseManifest({}).type, 'modified');
});
