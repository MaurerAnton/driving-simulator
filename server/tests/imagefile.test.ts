// SPDX-License-Identifier: AGPL-3.0-only
/** Image type sniffing, sizes and metadata stripping (no server needed). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanImage, ImageError, sniff } from '../src/imagefile.ts';
import { boundaryOf, parseMultipart } from '../src/multipart.ts';
import { hasSecret, jpeg, png, webp } from './helpers.ts';

test('JPEG: EXIF/XMP/IPTC/comment/trailing data dropped, size read, JFIF kept', () => {
  const src = jpeg(640, 480);
  assert.ok(hasSecret(src));
  const r = cleanImage(src);
  assert.equal(r.mime, 'image/jpeg');
  assert.equal(r.width, 640);
  assert.equal(r.height, 480);
  assert.ok(!hasSecret(r.data));
  assert.ok(r.data.includes(Buffer.from('JFIF')));
  assert.ok(!r.data.includes(Buffer.from('Exif')));
  assert.deepEqual([...r.data.subarray(-2)], [0xff, 0xd9]);
  // the entropy-coded data (with a stuffed 0xFF00 and a restart marker) is kept as it was
  assert.ok(r.data.includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a])));
  // stripping again changes nothing
  assert.ok(cleanImage(r.data).data.equals(r.data));
});

test('JPEG: a turned picture keeps only its orientation, and its size is the upright one', () => {
  const r = cleanImage(jpeg(400, 800, 6));
  assert.equal(r.width, 800);
  assert.equal(r.height, 400);
  assert.ok(!hasSecret(r.data));
  const i = r.data.indexOf(Buffer.from('Exif\0\0', 'latin1'));
  assert.ok(i > 0);
  assert.equal(r.data.readUInt16BE(i - 2), 34); // the minimal block
  assert.equal(cleanImage(r.data).width, 800);
});

test('PNG: text and eXIf chunks dropped, pHYs kept', () => {
  const r = cleanImage(png(300, 150));
  assert.equal(r.mime, 'image/png');
  assert.equal(r.width, 300);
  assert.equal(r.height, 150);
  assert.ok(!hasSecret(r.data));
  assert.ok(r.data.includes(Buffer.from('pHYs')));
  assert.ok(!r.data.includes(Buffer.from('tEXt')));
});

test('WebP: EXIF and XMP chunks dropped and their VP8X flags cleared', () => {
  const r = cleanImage(webp(1000, 500));
  assert.equal(r.mime, 'image/webp');
  assert.equal(r.width, 1000);
  assert.equal(r.height, 500);
  assert.ok(!hasSecret(r.data));
  assert.equal(r.data[20] & 0x0c, 0);
  assert.equal(r.data.readUInt32LE(4), r.data.length - 8);
});

test('other files and broken images are refused', () => {
  assert.equal(sniff(Buffer.from('GIF89a......')), null);
  assert.throws(() => cleanImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), ImageError);
  assert.throws(() => cleanImage(jpeg(10, 10).subarray(0, 60)), ImageError);
  assert.throws(() => cleanImage(png(10, 10).subarray(0, 40)), ImageError);
});

test('multipart parsing', async () => {
  const f = new FormData();
  f.append('meta', '{"a":1}');
  f.append('file', new Blob([new Uint8Array([1, 2, 13, 10, 45, 45, 3])]), 'x.bin');
  const req = new Request('http://x/', { method: 'POST', body: f });
  const b = boundaryOf(req.headers.get('content-type') ?? '');
  assert.ok(b);
  const parts = parseMultipart(Buffer.from(await req.arrayBuffer()), b!);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].data.toString(), '{"a":1}');
  assert.deepEqual([...parts[1].data], [1, 2, 13, 10, 45, 45, 3]);
  assert.equal(parts[1].filename, 'x.bin');
});
