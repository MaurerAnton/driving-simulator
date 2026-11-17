// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reading where the files of a map.tar lie while it streams past
 * (src/world/tarindex.ts): every file found at its place, in pieces of any
 * size, with long names and pax headers, and a broken archive told apart.
 *
 *   node --test tests/world/tarindex.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TarError, TarIndexer, mapPath } from '../../src/world/tarindex.ts';
import type { TarEntry } from '../../src/world/tarindex.ts';

const enc = new TextEncoder();

/** One header block of a ustar archive. */
function header(name: string, size: number, type = '0', prefix = ''): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, at: number): void => h.set(enc.encode(s), at);
  put(name, 0);
  put('0000644\0', 100);
  put('0000000\0', 108);
  put('0000000\0', 116);
  put(size.toString(8).padStart(11, '0') + '\0', 124);
  put('00000000000\0', 136);
  put(type, 156);
  put('ustar\0', 257);
  put('00', 263);
  put(prefix, 345);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function pad(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(b.length / 512) * 512);
  out.set(b);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** An archive of these files (with a long name and a pax header among them) – and the contents. */
function sample(): { tar: Uint8Array; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const parts: Uint8Array[] = [];
  parts.push(header('map/', 0, '5'));
  const add = (name: string, data: Uint8Array, h: Uint8Array = header(name, data.length)): void => {
    parts.push(h, pad(data));
    files.set(mapPath(name), data);
  };
  add('map/map.json', enc.encode('{"meta":{}}'));
  add('./map/tiles/270_458.fsb', Uint8Array.from({ length: 1300 }, (_, i) => i & 255));
  add('map/empty.txt', new Uint8Array(0));
  // a name longer than 100 bytes: the GNU way …
  const long = `map/w/${'x'.repeat(120)}.json.gz`;
  const longData = enc.encode('long one');
  parts.push(header('././@LongLink', long.length + 1, 'L'), pad(enc.encode(long + '\0')));
  add('map/w/cut-off-name', longData, header('map/w/cut-off-name', longData.length));
  files.delete('w/cut-off-name');
  files.set(mapPath(long), longData);
  // … and the pax way (with a size in the pax header)
  const paxName = `map/w/${'ü'.repeat(70)}.bin`;
  const rec = (k: string, v: string): string => {
    const body = ` ${k}=${v}\n`;
    const len = enc.encode(body).length;
    let n = len + 1;
    while (n !== len + String(n).length) n = len + String(n).length;
    return `${n}${body}`;
  };
  const paxData = new Uint8Array(777).fill(7);
  const pax = enc.encode(rec('path', paxName) + rec('size', String(paxData.length)));
  parts.push(header('PaxHeader', pax.length, 'x'), pad(pax));
  add('ignored-name', paxData, header('ignored-name', paxData.length));
  files.delete('ignored-name');
  files.set(mapPath(paxName), paxData);
  // a ustar prefix
  add('tiles/1_2.fsb', enc.encode('prefixed'), header('1_2.fsb', 8, '0', 'map/tiles'));
  parts.push(new Uint8Array(1024));
  return { tar: concat(parts), files };
}

function index(tar: Uint8Array, piece: (i: number) => number, base = 0): TarEntry[] {
  const found: TarEntry[] = [];
  const ix = new TarIndexer((e) => found.push(e), base);
  for (let i = 0; i < tar.length; ) {
    const n = Math.max(1, piece(i));
    ix.push(tar.subarray(i, i + n));
    i += n;
  }
  ix.finish();
  assert.equal(ix.pos, base + tar.length, 'every byte counted');
  return found;
}

test('paths lose "./" and the map folder', () => {
  assert.equal(mapPath('./map/tiles/a.fsb'), 'tiles/a.fsb');
  assert.equal(mapPath('/map/map.json'), 'map.json');
  assert.equal(mapPath('map.json'), 'map.json');
});

test('every file is found where it lies, however the stream is cut', () => {
  const { tar, files } = sample();
  let seed = 7;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (const piece of [() => tar.length, () => 1, () => 511, () => 513, () => 1 + Math.floor(random() * 3000)]) {
    const base = 1000;
    const found = index(tar, piece, base);
    assert.equal(found.length, files.size);
    for (const e of found) {
      const want = files.get(e.path);
      assert.ok(want, `unexpected ${e.path}`);
      assert.equal(e.size, want.length, e.path);
      assert.deepEqual(tar.subarray(e.offset - base, e.offset - base + e.size), want, e.path);
    }
  }
});

test('an archive cut short, or something that is no archive, is told apart', () => {
  const { tar } = sample();
  assert.throws(() => index(tar.subarray(0, 2000), () => 300), TarError);
  const junk = enc.encode('<!doctype html>'.repeat(100));
  assert.throws(() => index(junk, () => 64), TarError);
});

test('an archive written by tar itself (if there is a tar program)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tarindex-'));
  try {
    mkdirSync(join(dir, 'map', 'tiles'), { recursive: true });
    const want = new Map<string, Buffer>();
    const put = (rel: string, data: Buffer): void => {
      writeFileSync(join(dir, 'map', rel), data);
      want.set(rel, data);
    };
    put('map.json', Buffer.from('{"meta":{"name":"x"}}'));
    put(`tiles/${'long'.repeat(40)}.fsb`, Buffer.alloc(5000, 3));
    put('tiles/1_1.fsb', Buffer.alloc(512, 9));
    const r = spawnSync('tar', ['-cf', join(dir, 'map.tar'), '-C', dir, 'map']);
    if (r.status !== 0) {
      t.skip('no tar program');
      return;
    }
    const tar = new Uint8Array(readFileSync(join(dir, 'map.tar')));
    const found = index(tar, () => 4096);
    assert.equal(found.length, want.size);
    for (const e of found) assert.deepEqual(Buffer.from(tar.subarray(e.offset, e.offset + e.size)), want.get(e.path), e.path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
