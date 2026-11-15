// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Tests for the reality view: reading the metadata of picture files, placing
 * the player's own pictures, and understanding the answers of the imagery
 * services (recorded answers, no network).
 *
 *   node --test "tests/reality/*.test.ts"
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gpkgPoint } from '../../tools/panos/gpkg.ts';
import { inMap, indexFolder } from '../../tools/panos/index-panos.ts';
import { looksLikePanorama, readImageMeta } from '../../src/reality/imagemeta.ts';
import { describeLocal, findInList, imagesFromIndex, parseFileName, parseList } from '../../src/reality/local.ts';
import { kartaviewUrl, mapillaryUrl, panoramaxUrl, parseKartaView, parseMapillary, parsePanoramax, placeLinks, searchImages } from '../../src/reality/providers.ts';
import { areaBox, headingDiff, metresBetween, rankImages } from '../../src/reality/types.ts';
import type { StreetImage } from '../../src/reality/types.ts';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const near = (a: number, b: number, eps: number, what: string): void => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} is not ${b} ± ${eps}`);
const bytesOf = (s: string): number[] => [...new TextEncoder().encode(s)];

// ---------------------------------------------------------------- test files
/** EXIF block: position 51°15'19.044" N, 9°24'39.96" E, looking 123.5°, taken 2023-09-29 17:22:02. */
function exifBlock(le: boolean, south = false): number[] {
  const b: number[] = [];
  const u16 = (v: number): void => void (le ? b.push(v & 255, v >> 8) : b.push(v >> 8, v & 255));
  const u32 = (v: number): void => void (le ? b.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255) : b.push((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255));
  const entry = (tag: number, type: number, count: number, value: number): void => {
    u16(tag);
    u16(type);
    u32(count);
    u32(value);
  };
  const inline = (tag: number, text: string): void => {
    u16(tag);
    u16(2);
    u32(2);
    b.push(text.charCodeAt(0), 0, 0, 0);
  };
  b.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]));
  u16(42);
  u32(8);
  // IFD0 at 8
  u16(2);
  entry(0x8769, 4, 1, 38);
  entry(0x8825, 4, 1, 76);
  u32(0);
  // Exif IFD at 38
  u16(1);
  entry(0x9003, 2, 20, 56);
  u32(0);
  b.push(...bytesOf('2023:09:29 17:22:02'), 0); // at 56
  // GPS IFD at 76
  u16(5);
  inline(1, south ? 'S' : 'N');
  entry(2, 5, 3, 142);
  inline(3, 'E');
  entry(4, 5, 3, 166);
  entry(17, 5, 1, 190);
  u32(0);
  for (const [n, d] of [[51, 1], [15, 1], [19044, 1000], [9, 1], [24, 1], [3996, 100], [247, 2]]) {
    u32(n);
    u32(d);
  }
  assert.equal(b.length, 198);
  return b;
}

const XMP = (extra = ''): string =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
  `<rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:ProjectionType="equirectangular" GPano:UsePanoramaViewer="True" ` +
  `GPano:FullPanoWidthPixels="8192" GPano:FullPanoHeightPixels="4096" GPano:CroppedAreaImageWidthPixels="8192" GPano:PoseHeadingDegrees="271.5"${extra}/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

function jpeg(parts: { exif?: number[]; xmp?: string; xmpFirst?: boolean; width: number; height: number }): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  const segment = (marker: number, body: number[]): void => void out.push(0xff, marker, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body);
  segment(0xe0, [...bytesOf('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const xmp = (): void => {
    if (parts.xmp) segment(0xe1, [...bytesOf('http://ns.adobe.com/xap/1.0/'), 0, ...bytesOf(parts.xmp)]);
  };
  if (parts.xmpFirst) xmp();
  if (parts.exif) segment(0xe1, [...bytesOf('Exif'), 0, 0, ...parts.exif]);
  if (!parts.xmpFirst) xmp();
  segment(0xc0, [8, parts.height >> 8, parts.height & 255, parts.width >> 8, parts.width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
  out.push(0x12, 0x34, 0xff, 0xd9);
  return new Uint8Array(out);
}

test('picture metadata: JPEG with EXIF position, direction and date', () => {
  for (const le of [true, false]) {
    const m = readImageMeta(jpeg({ exif: exifBlock(le), width: 4000, height: 3000 }));
    assert.equal(m.kind, 'jpeg');
    assert.equal(m.width, 4000);
    assert.equal(m.height, 3000);
    near(m.lat, 51.25529, 1e-6, `latitude (${le ? 'little' : 'big'} endian)`);
    near(m.lon, 9.4111, 1e-6, 'longitude');
    near(m.heading, 123.5, 1e-9, 'direction');
    assert.equal(new Date(m.time).toISOString(), '2023-09-29T17:22:02.000Z');
    assert.equal(m.pano, null, 'EXIF alone does not say whether it is a panorama');
    assert.equal(looksLikePanorama(m), false, 'a 4:3 photograph is none');
  }
  near(readImageMeta(jpeg({ exif: exifBlock(true, true), width: 10, height: 10 })).lat, -51.25529, 1e-6, 'southern latitude');
});

test('picture metadata: photo-sphere XMP as written by street-view download tools', () => {
  const m = readImageMeta(jpeg({ xmp: XMP(), width: 8192, height: 4096 }));
  assert.equal(m.pano, true);
  near(m.heading, 271.5, 1e-9, 'pose heading');
  assert.ok(Number.isNaN(m.lat), 'no position in the file');
  assert.equal(looksLikePanorama(m), true);
  // XMP wins over EXIF for the direction (it describes the middle of the panorama), EXIF gives the position
  const both = readImageMeta(jpeg({ exif: exifBlock(true), xmp: XMP(), width: 8192, height: 4096 }));
  near(both.heading, 271.5, 1e-9, 'heading with both blocks');
  near(both.lat, 51.25529, 1e-6, 'latitude with both blocks');
  const swapped = readImageMeta(jpeg({ exif: exifBlock(true), xmp: XMP(), xmpFirst: true, width: 8192, height: 4096 }));
  near(swapped.heading, 271.5, 1e-9, 'the pose wins whichever block comes first');
  near(swapped.lon, 9.4111, 1e-6, 'longitude with the blocks swapped');
  // element form and XMP-only position
  const el = readImageMeta(
    jpeg({
      xmp: '<x:xmpmeta><rdf:Description><GPano:ProjectionType>equirectangular</GPano:ProjectionType><GPano:PoseHeadingDegrees>12</GPano:PoseHeadingDegrees><exif:GPSLatitude>51,15.3174N</exif:GPSLatitude><exif:GPSLongitude>9,24.666E</exif:GPSLongitude></rdf:Description></x:xmpmeta>',
      width: 6000,
      height: 3000,
    }),
  );
  assert.equal(el.pano, true);
  assert.equal(el.heading, 12);
  near(el.lat, 51.25529, 1e-5, 'XMP latitude');
  near(el.lon, 9.4111, 1e-5, 'XMP longitude');
  // a cropped strip is not a full panorama
  const strip = readImageMeta(jpeg({ xmp: XMP().replace('CroppedAreaImageWidthPixels="8192"', 'CroppedAreaImageWidthPixels="3000"'), width: 3000, height: 1200 }));
  assert.equal(strip.pano, false);
});

test('picture metadata: shape decides when the file is silent; PNG and WebP; damaged files', () => {
  const plain = readImageMeta(jpeg({ width: 16384, height: 8192 }));
  assert.equal(plain.pano, null);
  assert.equal(looksLikePanorama(plain), true, '2:1 and large: an equirectangular panorama');
  assert.equal(looksLikePanorama({ pano: null, width: 1920, height: 1080 }), false);
  assert.equal(looksLikePanorama({ pano: null, width: 800, height: 400 }), false, 'too small to be one');
  assert.equal(looksLikePanorama({ pano: false, width: 8000, height: 4000 }), false, 'metadata overrules the shape');

  const u32 = (v: number): number[] => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  const chunk = (type: string, body: number[]): number[] => [...u32(body.length), ...bytesOf(type), ...body, 0, 0, 0, 0];
  const png = new Uint8Array([
    0x89, ...bytesOf('PNG\r\n'), 0x1a, 0x0a,
    ...chunk('IHDR', [...u32(6000), ...u32(3000), 8, 2, 0, 0, 0]),
    ...chunk('iTXt', [...bytesOf('XML:com.adobe.xmp'), 0, 0, 0, 0, 0, ...bytesOf(XMP())]),
    ...chunk('eXIf', exifBlock(false)),
    ...chunk('IDAT', [1, 2, 3]),
  ]);
  const p = readImageMeta(png);
  assert.deepEqual([p.kind, p.width, p.height, p.pano], ['png', 6000, 3000, true]);
  near(p.lon, 9.4111, 1e-6, 'PNG eXIf longitude');

  const xmp = bytesOf(XMP());
  const le32 = (v: number): number[] => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const le24 = (v: number): number[] => [v & 255, (v >> 8) & 255, (v >> 16) & 255];
  const webp = new Uint8Array([...bytesOf('RIFF'), ...le32(0), ...bytesOf('WEBP'), ...bytesOf('VP8X'), ...le32(10), 0x04, 0, 0, 0, ...le24(8191), ...le24(4095), ...bytesOf('XMP '), ...le32(xmp.length), ...xmp, ...(xmp.length & 1 ? [0] : [])]);
  const w = readImageMeta(webp);
  assert.deepEqual([w.kind, w.width, w.height, w.pano, w.heading], ['webp', 8192, 4096, true, 271.5]);

  // truncated or foreign bytes never throw
  const full = jpeg({ exif: exifBlock(true), xmp: XMP(), width: 8192, height: 4096 });
  for (let n = 0; n < full.length; n += 7) readImageMeta(full.subarray(0, n));
  assert.equal(readImageMeta(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).kind, '');
  assert.equal(readImageMeta(new Uint8Array(0)).kind, '');
});

test('own pictures: positions and directions in file names', () => {
  const inMap = (lat: number, lon: number): boolean => lat > 51.2 && lat < 51.3 && lon > 9.3 && lon < 9.5;
  assert.deepEqual(parseFileName('panos/51.25529,9.41110.jpg'), { id: '51.25529,9.41110', lat: 51.25529, lon: 9.4111, heading: NaN });
  const lonFirst = parseFileName('pano_9.41110_51.25529_h090.jpeg', inMap);
  assert.deepEqual([lonFirst.lat, lonFirst.lon, lonFirst.heading], [51.25529, 9.4111, 90], 'longitude first is recognised by the map area');
  assert.deepEqual([parseFileName('streetview 51.2553 9.4110 heading=271.5.png').heading], [271.5]);
  // one still per direction, as the Street View Static API downloaders name them
  const still = parseFileName('C/CA/CAoSLEFGMVFpcE1fabcdefghijk_090.jpg');
  assert.deepEqual([still.id, still.heading, Number.isNaN(still.lat)], ['CAoSLEFGMVFpcE1fabcdefghijk', 90, true]);
  // nothing to find: an ordinary camera name stays as it is
  const cam = parseFileName('IMG_20230929_172202.jpg');
  assert.deepEqual([cam.id, Number.isNaN(cam.lat), Number.isNaN(cam.heading)], ['IMG_20230929_172202', true, true]);
  assert.ok(Number.isNaN(parseFileName('DSC_0421.JPG').heading), 'a picture counter is no direction');
  assert.ok(Number.isNaN(parseFileName('200.300,400.500.jpg').lat), 'numbers that cannot be coordinates');
});

test('own pictures: lists written by download tools (JSON, GeoJSON, CSV)', () => {
  const geo = parseList(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [9.4111, 51.25529] }, properties: { pano_id: 'CAoSLEFGMVFpcE1fabcdefghijk', date: '2023-09', heading: 45 } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { pano_id: 'x' } },
      ],
    }),
  );
  assert.equal(geo.length, 1);
  assert.deepEqual([geo[0].key, geo[0].lat, geo[0].lon, geo[0].heading, new Date(geo[0].time).toISOString().slice(0, 7)], ['caoslefgmvfpce1fabcdefghijk', 51.25529, 9.4111, 45, '2023-09']);

  const arr = parseList(JSON.stringify([{ filename: 'a.jpg', lat: '51.2', lng: '9.4', yaw: 10 }, { file: 'b.jpg', location: { lat: 51.21, lng: 9.41 } }, { nothing: 1 }]));
  assert.deepEqual(arr.map((e) => [e.key, e.lat, e.lon]), [['a', 51.2, 9.4], ['b', 51.21, 9.41]]);

  const byId = parseList(JSON.stringify({ panoramas: { abcdefgh1234: { latitude: 51.3, longitude: 9.5, rotation: 180 } } }));
  assert.deepEqual(byId.map((e) => [e.key, e.lat, e.lon, e.heading]), [['abcdefgh1234', 51.3, 9.5, 180]]);

  const csv = parseList('pano_id;lat;lon;heading;date\n"abc;def12345";51,25;9,41;270;2022-05-01\nbroken;;;;\n');
  assert.deepEqual(csv.map((e) => [e.key, e.lat, e.lon, e.heading]), [['abc;def12345', 51.25, 9.41, 270]]);
  assert.equal(parseList('file,latitude,longitude\nx.jpg,51.1,9.2').length, 1);
  assert.deepEqual(parseList('{ not json'), []);
  assert.deepEqual(parseList(''), []);

  const info = parseFileName('CAoSLEFGMVFpcE1fabcdefghijk_090.jpg');
  assert.equal(findInList(geo, 'CAoSLEFGMVFpcE1fabcdefghijk_090.jpg', info), geo[0], 'matched by panorama id');
  assert.equal(findInList(geo, 'other.jpg', parseFileName('other.jpg')), null);
});

test('own pictures: metadata first, then the list, then the file name', () => {
  const meta = (over: object = {}) => ({ kind: 'jpeg' as const, width: 8192, height: 4096, lat: NaN, lon: NaN, heading: NaN, time: NaN, pano: null, ...over });
  const list = parseList(JSON.stringify([{ file: 'pano1.jpg', lat: 51.26, lon: 9.42, heading: 30 }]));
  const a = describeLocal({ name: 'dir/pano1.jpg', meta: meta({ lat: 51.25, lon: 9.41, heading: 200 }), url: 'blob:a' }, list);
  assert.deepEqual([a.lat, a.lon, a.heading, a.pano, a.located, a.title, a.source], [51.25, 9.41, 200, true, true, 'pano1.jpg', 'local']);
  const b = describeLocal({ name: 'dir/pano1.jpg', meta: meta(), url: 'blob:b' }, list);
  assert.deepEqual([b.lat, b.lon, b.heading], [51.26, 9.42, 30]);
  const c = describeLocal({ name: '51.2700_9.4300_h45.jpg', meta: meta({ width: 4000, height: 3000 }), url: 'blob:c' }, list);
  assert.deepEqual([c.lat, c.lon, c.heading, c.pano], [51.27, 9.43, 45, false]);
  const d = describeLocal({ name: 'IMG_0001.jpg', meta: meta(), url: 'blob:d' }, list);
  assert.deepEqual([d.located, Number.isNaN(d.lat)], [false, true], 'no position anywhere: to be pinned by hand');
});

test('own pictures: the index of a self-hosted panos/ folder', () => {
  const imgs = imagesFromIndex(
    { images: [{ file: 'a b/pano 1.jpg', lat: 51.25, lon: 9.41, heading: 90, time: 1700000000000, pano: true }, { file: '../../etc/passwd.jpg', lat: 1, lon: 1 }, { file: 'notes.txt' }, { file: 'x.png', lat: null, lon: null, heading: null, time: null, pano: false }] },
    'https://example.org/panos/',
  );
  assert.equal(imgs.length, 2);
  assert.deepEqual([imgs[0].url, imgs[0].pano, imgs[0].located, imgs[0].heading], ['https://example.org/panos/a%20b/pano%201.jpg', true, true, 90]);
  assert.equal(imgs[1].located, false);
  assert.deepEqual(imagesFromIndex(null, 'x/'), []);
});

// ------------------------------------------------------------------ services
test('services: Panoramax answers', () => {
  const imgs = parsePanoramax(fixture('panoramax.json'));
  assert.equal(imgs.length, 3);
  const [a, b, c] = imgs;
  assert.deepEqual([a.source, a.pano, a.heading, a.licence, a.author], ['panoramax', false, 90, 'CC BY-SA 4.0', 'example-contributor']);
  near(a.lat, 51.2589382, 1e-9, 'latitude');
  near(a.lon, 9.4106562, 1e-9, 'longitude');
  assert.equal(new Date(a.time).toISOString(), '2023-09-29T15:22:02.645Z');
  assert.ok(a.thumb.endsWith('/thumb.jpg') && a.url.endsWith('/sd.jpg') && a.full.endsWith('.jpg') && a.full !== a.url);
  assert.equal(a.page, `https://api.panoramax.xyz/#focus=pic&pic=${a.id}`);
  assert.equal(b.pano, false, 'a 74° lens is no panorama');
  assert.equal(c.pano, true, 'field of view 360° is one');
  assert.deepEqual(parsePanoramax({ features: [{ id: 'x', geometry: { coordinates: [9, 51] } }, 7, null] }), [], 'records without pictures are skipped');
  assert.deepEqual(parsePanoramax('nonsense'), []);
});

test('services: KartaView answers', () => {
  const imgs = parseKartaView(fixture('kartaview.json'));
  assert.equal(imgs.length, 4);
  const a = imgs[0];
  assert.deepEqual([a.source, a.pano, a.licence, a.author], ['kartaview', false, 'CC BY-SA 4.0', '']);
  near(a.lat, 51.2556, 1e-3, 'latitude');
  near(a.lon, 9.411, 1e-3, 'longitude');
  assert.ok(a.heading >= 0 && a.heading < 360);
  assert.equal(new Date(a.time).getUTCFullYear(), 2025);
  assert.ok(a.thumb.startsWith('https://') && a.url.startsWith('https://') && a.full.startsWith('https://'));
  assert.match(a.page, /^https:\/\/kartaview\.org\/details\/\d+\/\d+\/track-info$/);
  assert.equal(imgs[3].pano, true, 'projection SPHERE');
  assert.deepEqual(parseKartaView({ result: { data: [{ id: '1', lat: 'x', lng: '9' }] } }), []);
  assert.deepEqual(parseKartaView({ result: { data: [{ id: '1', lat: '51', lng: '9', fileurlLTh: 'http://insecure.example/x.jpg' }] } }), [], 'only https pictures are passed on');
});

test('services: Mapillary answers', () => {
  const imgs = parseMapillary(fixture('mapillary.json'));
  assert.equal(imgs.length, 2, 'the record without position is skipped');
  const [a, b] = imgs;
  assert.deepEqual([a.source, a.pano, a.author, a.licence], ['mapillary', false, 'example-contributor', 'CC BY-SA 4.0']);
  assert.deepEqual([a.lat, a.lon], [51.255302, 9.411061], 'the corrected position is preferred');
  assert.equal(a.heading, 268.9, 'and so is the corrected direction');
  assert.equal(a.time, 1690000000000);
  assert.ok(a.thumb.endsWith('256.jpg') && a.url.endsWith('1024.jpg') && a.full.endsWith('2048.jpg'));
  assert.equal(a.page, 'https://www.mapillary.com/app/?pKey=1000000000000001&focus=photo');
  assert.deepEqual([b.pano, b.heading], [true, 15]);
});

test('services: requests stay small, anonymous and inside the limits', async () => {
  const area = { lat: 51.25529, lon: 9.4111, radius: 80 };
  const box = areaBox(area);
  near(metresBetween(box[1], box[0], box[1], box[2]), 160, 0.5, 'width of the search box');
  near(metresBetween(box[1], box[0], box[3], box[0]), 160, 0.5, 'height of the search box');
  assert.match(panoramaxUrl(area), /^https:\/\/api\.panoramax\.xyz\/api\/search\?bbox=9\.4\d+,51\.25\d+,9\.41\d+,51\.25\d+&limit=60$/);
  assert.equal(kartaviewUrl(area), 'https://api.kartaview.org/2.0/photo/?lat=51.255290&lng=9.411100&radius=80&itemsPerPage=60');
  assert.match(kartaviewUrl({ ...area, radius: 5000 }, 500), /radius=500&itemsPerPage=150$/, 'the limits of the service are respected');
  const mly = new URL(mapillaryUrl(area, 'MLY|1|secret'));
  assert.equal(mly.searchParams.get('access_token'), 'MLY|1|secret');
  const bb = mly.searchParams.get('bbox')!.split(',').map(Number);
  assert.ok((bb[2] - bb[0]) * (bb[3] - bb[1]) < 0.01, 'box below 0.01 square degrees');

  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fake = (body: unknown, status = 200) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: status < 400, status, json: async () => body } as Response;
    }) as unknown as typeof fetch;
  const got = await searchImages('kartaview', area, { fetch: fake(fixture('kartaview.json')) });
  assert.equal(got.length, 4);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  await assert.rejects(searchImages('mapillary', area, { fetch: fake({}) }), /token/, 'Mapillary is not asked without a token');
  assert.equal(calls.length, 1);
  await assert.rejects(searchImages('mapillary', area, { token: 'bad', fetch: fake({ error: { message: 'Invalid OAuth 2.0 Access Token', code: 190 } }, 400) }), /Invalid OAuth/);
  await assert.rejects(searchImages('panoramax', area, { fetch: fake(null, 503) }), /HTTP 503/);
});

test('links to the same place on the web', () => {
  const links = placeLinks(51.25529, 9.4111, -90);
  assert.deepEqual(links.map((l) => l.id), ['kartaview', 'mapillary', 'panoramax', 'google', 'googlemaps', 'googleearth', 'osm']);
  for (const l of links) assert.ok(l.url.startsWith('https://') && l.url.includes('51.255290') && l.url.includes('9.411100'), l.url);
  assert.equal(links[0].url, 'https://kartaview.org/map/@51.255290,9.411100,18z', 'straight to the place on the KartaView map');
  assert.ok(links[3].url.endsWith('&heading=270'), 'the viewing direction is handed over');
  assert.ok(links[4].url.includes('basemap=satellite') && links[5].url.includes(',270h,'), 'satellite picture, and the globe turned the way the car faces');
});

test('ranking: near, looking the same way, panoramas first', () => {
  const img = (id: string, dNorth: number, heading: number, pano = false, located = true): StreetImage => ({ source: 'local', id, lat: 51.25 + dNorth / 111320, lon: 9.41, heading, pano, time: NaN, author: '', licence: '', thumb: '', url: '', full: '', page: '', title: id, located });
  const order = (list: StreetImage[], heading = 0): string[] => rankImages(list, 51.25, 9.41, heading).map((r) => r.image.id);
  assert.deepEqual(order([img('far', 60, 0), img('near', 10, 0)]), ['near', 'far']);
  assert.deepEqual(order([img('behind', 10, 180), img('ahead', 25, 5)]), ['ahead', 'behind'], 'the view ahead beats a slightly nearer view backwards');
  assert.deepEqual(order([img('photo', 10, 0), img('pano', 14, NaN, true)]), ['pano', 'photo'], 'a panorama a few metres further away comes first');
  assert.deepEqual(order([img('unplaced', 0, 0, false, false), img('placed', 30, 0)]), ['placed'], 'pictures without position are not ranked');
  near(rankImages([img('a', 50, 0)], 51.25, 9.41, 0)[0].dist, 50, 0.01, 'distance');
  assert.deepEqual([headingDiff(350, 10), headingDiff(10, 350), headingDiff(90, 270), headingDiff(0, 0)], [20, 20, 180, 0]);
});

// ------------------------------------------------------------ indexing tool
/** GeoPackage point geometry: header (optionally with an envelope) and a WKB point. */
function gpkgBlob(lon: number, lat: number, envelope = false): Uint8Array {
  const b = new Uint8Array(8 + (envelope ? 32 : 0) + 21);
  const v = new DataView(b.buffer);
  b.set([0x47, 0x50, 0, envelope ? 0x03 : 0x01]);
  v.setInt32(4, 4326, true);
  const w = 8 + (envelope ? 32 : 0);
  b[w] = 1;
  v.setUint32(w + 1, 1, true);
  v.setFloat64(w + 5, lon, true);
  v.setFloat64(w + 13, lat, true);
  return b;
}

test('indexing tool: GeoPackage points', () => {
  assert.deepEqual(gpkgPoint(gpkgBlob(9.4111, 51.25529)), { x: 9.4111, y: 51.25529, srs: 4326 });
  assert.deepEqual(gpkgPoint(gpkgBlob(9.4111, 51.25529, true)), { x: 9.4111, y: 51.25529, srs: 4326 });
  assert.equal(gpkgPoint(new Uint8Array(40)), null, 'not a GeoPackage geometry');
  const line = gpkgBlob(1, 2);
  new DataView(line.buffer).setUint32(9, 2, true);
  assert.equal(gpkgPoint(line), null, 'a line is not a position');
});

test('indexing tool: a folder as street-view download tools leave it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fahrsim-panos-'));
  try {
    assert.equal(inMap(51.25529, 9.4111), true);
    assert.equal(inMap(48.137, 11.575), false, 'Munich is not on the map');
    // stills of one panorama per direction in id-prefixed folders, positions in a GeoPackage
    mkdirSync(join(dir, 'A', 'AB'), { recursive: true });
    writeFileSync(join(dir, 'A', 'AB', 'ABCDEFGHIJKL_090.jpg'), jpeg({ width: 640, height: 640 }));
    writeFileSync(join(dir, 'A', 'AB', 'ABCDEFGHIJKL_270.jpg'), jpeg({ width: 640, height: 640 }));
    let sqlite = true;
    try {
      const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown }; close(): void } };
      const db = new DatabaseSync(join(dir, 'metadata.gpkg'));
      db.exec(`CREATE TABLE gpkg_contents (table_name TEXT, data_type TEXT, identifier TEXT, srs_id INTEGER);
        CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z TINYINT, m TINYINT);
        CREATE TABLE metadata (fid INTEGER PRIMARY KEY, pano_id TEXT, date TEXT, geometry BLOB);
        INSERT INTO gpkg_contents VALUES ('metadata', 'features', 'metadata', 4326);
        INSERT INTO gpkg_geometry_columns VALUES ('metadata', 'geometry', 'POINT', 4326, 0, 0);`);
      db.prepare('INSERT INTO metadata (pano_id, date, geometry) VALUES (?, ?, ?)').run('ABCDEFGHIJKL', '2023-09', gpkgBlob(9.4111, 51.25529, true));
      db.close();
    } catch {
      sqlite = false; // an old Node without SQLite: the rest must work regardless
    }
    // a stitched panorama with the position in its name, one with full metadata, one listed in JSON, one unknown
    writeFileSync(join(dir, 'pano_51.25600_9.41200_h180.jpg'), jpeg({ width: 8192, height: 4096 }));
    writeFileSync(join(dir, 'sphere.jpg'), jpeg({ exif: exifBlock(true), xmp: XMP(), width: 8192, height: 4096 }));
    writeFileSync(join(dir, 'listed.jpg'), jpeg({ width: 4000, height: 3000 }));
    writeFileSync(join(dir, 'IMG_0001.jpg'), jpeg({ width: 4000, height: 3000 }));
    writeFileSync(join(dir, 'positions.json'), JSON.stringify([{ file: 'listed.jpg', lat: 48.137, lng: 11.575, heading: 5 }]));
    writeFileSync(join(dir, 'notes.txt'), 'not a picture');
    writeFileSync(join(dir, 'index.json'), '{"images":[{"file":"stale.jpg"}]}');

    const r = await indexFolder(dir);
    const by = new Map(r.index.images.map((i) => [i.file, i]));
    assert.deepEqual([...by.keys()].sort(), ['A/AB/ABCDEFGHIJKL_090.jpg', 'A/AB/ABCDEFGHIJKL_270.jpg', 'IMG_0001.jpg', 'listed.jpg', 'pano_51.25600_9.41200_h180.jpg', 'sphere.jpg']);
    assert.deepEqual(by.get('pano_51.25600_9.41200_h180.jpg'), { file: 'pano_51.25600_9.41200_h180.jpg', lat: 51.256, lon: 9.412, heading: 180, time: null, pano: true });
    const sphere = by.get('sphere.jpg')!;
    assert.deepEqual([sphere.pano, sphere.heading], [true, 271.5]);
    near(sphere.lat!, 51.25529, 1e-6, 'position from EXIF');
    assert.deepEqual([by.get('listed.jpg')!.lat, by.get('listed.jpg')!.heading, by.get('listed.jpg')!.pano], [48.137, 5, false]);
    assert.deepEqual([by.get('IMG_0001.jpg')!.lat, r.unplaced.includes('IMG_0001.jpg')], [null, true]);
    assert.equal(r.panoramas, 2);
    assert.equal(r.outside, 1, 'the picture from Munich is reported as outside the map');
    if (sqlite) {
      const still = by.get('A/AB/ABCDEFGHIJKL_090.jpg')!;
      assert.deepEqual([still.lat, still.lon, still.heading, still.pano], [51.25529, 9.4111, 90, false], 'placed through the GeoPackage, direction from the name');
      assert.equal(new Date(still.time!).toISOString().slice(0, 7), '2023-09');
      assert.equal(by.get('A/AB/ABCDEFGHIJKL_270.jpg')!.heading, 270);
      assert.equal(r.lists, 2);
      assert.equal(r.placed, 5);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
