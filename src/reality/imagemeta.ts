// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What an image file says about itself, read from its first bytes without
 * decoding the picture: size, GPS position, viewing direction, date and
 * whether it is a 360° panorama.
 *
 * Understands JPEG, PNG and WebP with
 *  - EXIF (GPS IFD, DateTimeOriginal) and
 *  - XMP, in particular Google's Photo Sphere tags (GPano:ProjectionType,
 *    GPano:PoseHeadingDegrees, …) which street-view download tools, phone
 *    cameras and 360° cameras write.
 *
 * Runs unchanged in the browser and in Node.
 */

export interface ImageMeta {
  kind: 'jpeg' | 'png' | 'webp' | '';
  /** pixels, 0 if not found in the bytes given */
  width: number;
  height: number;
  /** degrees, NaN if the file carries no position */
  lat: number;
  lon: number;
  /** compass direction of the middle of the picture, degrees; NaN if unknown */
  heading: number;
  /** milliseconds since 1970 (local time of the camera read as UTC); NaN if unknown */
  time: number;
  /** true/false if the metadata says so, null if it is silent */
  pano: boolean | null;
}

const empty = (): ImageMeta => ({ kind: '', width: 0, height: 0, lat: NaN, lon: NaN, heading: NaN, time: NaN, pano: null });

const ascii = (b: Uint8Array, from: number, to: number): string => {
  let s = '';
  const end = Math.min(to, b.length);
  for (let i = from; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
};

const utf8 = (b: Uint8Array, from: number, to: number): string => new TextDecoder('utf-8').decode(b.subarray(from, Math.min(to, b.length)));

function startsWith(b: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

// ----------------------------------------------------------------------- EXIF
function readExif(b: Uint8Array, start: number, end: number, m: ImageMeta): void {
  if (end - start < 8) return;
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  if (!le && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return;
  const u16 = (o: number): number => (o + 2 > end ? 0 : le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number): number => (o + 4 > end ? 0 : le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  if (u16(start + 2) !== 42) return;

  /** Entries of one directory: tag → [type, count, offset of the value] */
  const dir = (off: number): Map<number, [number, number, number]> => {
    const out = new Map<number, [number, number, number]>();
    const at = start + off;
    if (off <= 0 || at + 2 > end) return out;
    const n = u16(at);
    for (let i = 0; i < n && at + 2 + (i + 1) * 12 <= end; i++) {
      const e = at + 2 + i * 12;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (type === 3 ? 2 : type === 4 || type === 9 ? 4 : type === 5 || type === 10 ? 8 : 1) * count;
      out.set(u16(e), [type, count, size <= 4 ? e + 8 : start + u32(e + 8)]);
    }
    return out;
  };
  const rational = (o: number): number => {
    const den = u32(o + 4);
    return den === 0 ? NaN : u32(o) / den;
  };
  const rationals = (e: [number, number, number] | undefined, n: number): number[] | null => {
    if (!e || (e[0] !== 5 && e[0] !== 10) || e[1] < n || e[2] + n * 8 > end) return null;
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(rational(e[2] + i * 8));
    return out;
  };
  const text = (e: [number, number, number] | undefined): string => (e && e[0] === 2 ? ascii(b, e[2], Math.min(e[2] + e[1], end)).replace(/\0.*$/, '') : '');

  const ifd0 = dir(u32(start + 4));
  const exifPtr = ifd0.get(0x8769);
  const exif = exifPtr ? dir(u32(exifPtr[2])) : new Map<number, [number, number, number]>();
  const stamp = text(exif.get(0x9003)) || text(exif.get(0x9004)) || text(ifd0.get(0x0132));
  const t = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(stamp);
  if (t) m.time = Date.UTC(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +t[6]);

  const gpsPtr = ifd0.get(0x8825);
  if (!gpsPtr) return;
  const gps = dir(u32(gpsPtr[2]));
  const dms = (e: [number, number, number] | undefined): number => {
    const r = rationals(e, 3);
    return r ? r[0] + r[1] / 60 + r[2] / 3600 : NaN;
  };
  const lat = dms(gps.get(2));
  const lon = dms(gps.get(4));
  if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)) {
    m.lat = text(gps.get(1)).toUpperCase().startsWith('S') ? -lat : lat;
    m.lon = text(gps.get(3)).toUpperCase().startsWith('W') ? -lon : lon;
  }
  // the pose of a panorama (XMP) describes the middle of the picture and wins wherever it stands in the file
  const dirn = rationals(gps.get(17), 1);
  if (dirn && Number.isFinite(dirn[0]) && Number.isNaN(m.heading)) m.heading = ((dirn[0] % 360) + 360) % 360;
}

// ------------------------------------------------------------------------ XMP
function xmpValue(xmp: string, name: string): string {
  // attribute form  GPano:Foo="…"  or element form  <GPano:Foo>…</GPano:Foo>
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = new RegExp(`${esc}\\s*=\\s*(["'])(.*?)\\1`).exec(xmp);
  if (a) return a[2].trim();
  const e = new RegExp(`<${esc}[^>]*>\\s*([^<]*?)\\s*</${esc}>`).exec(xmp);
  return e ? e[1].trim() : '';
}

/** XMP writes positions as "51,15.3174N" or "51,15,19.04N". */
function xmpCoordinate(v: string): number {
  const m = /^(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?(?:,(\d+(?:\.\d+)?))?\s*([NSEW])?$/i.exec(v.trim());
  if (!m) return NaN;
  const deg = Number(m[1]) + Number(m[2] ?? 0) / 60 + Number(m[3] ?? 0) / 3600;
  return /[SW]/i.test(m[4] ?? '') ? -deg : deg;
}

function readXmp(xmp: string, m: ImageMeta): void {
  const projection = xmpValue(xmp, 'GPano:ProjectionType').toLowerCase();
  if (projection) m.pano = projection === 'equirectangular';
  if (m.pano) {
    // a cropped photo sphere (a strip of the horizon) is no full panorama
    const full = Number(xmpValue(xmp, 'GPano:FullPanoWidthPixels'));
    const crop = Number(xmpValue(xmp, 'GPano:CroppedAreaImageWidthPixels'));
    if (full > 0 && crop > 0 && crop < full * 0.95) m.pano = false;
  }
  const pose = xmpValue(xmp, 'GPano:PoseHeadingDegrees');
  if (pose !== '' && Number.isFinite(Number(pose))) m.heading = ((Number(pose) % 360) + 360) % 360;
  if (Number.isNaN(m.lat)) {
    const lat = xmpCoordinate(xmpValue(xmp, 'exif:GPSLatitude'));
    const lon = xmpCoordinate(xmpValue(xmp, 'exif:GPSLongitude'));
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      m.lat = lat;
      m.lon = lon;
    }
  }
  if (Number.isNaN(m.time)) {
    const t = Date.parse(xmpValue(xmp, 'GPano:FirstPhotoDate') || xmpValue(xmp, 'xmp:CreateDate') || xmpValue(xmp, 'exif:DateTimeOriginal'));
    if (Number.isFinite(t)) m.time = t;
  }
}

// ---------------------------------------------------------------------- files
const XMP_JPEG = 'http://ns.adobe.com/xap/1.0/\0';

function readJpeg(b: Uint8Array, m: ImageMeta): void {
  m.kind = 'jpeg';
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = b[p + 1];
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // image data follows
    const len = (b[p + 2] << 8) | b[p + 3];
    const body = p + 4;
    const end = Math.min(p + 2 + len, b.length);
    if (marker === 0xe1) {
      if (startsWith(b, body, 'Exif\0\0')) readExif(b, body + 6, end, m);
      else if (startsWith(b, body, XMP_JPEG)) readXmp(utf8(b, body + XMP_JPEG.length, end), m);
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && body + 5 <= b.length) {
      m.height = (b[body + 1] << 8) | b[body + 2];
      m.width = (b[body + 3] << 8) | b[body + 4];
    }
    if (len < 2) break;
    p += 2 + len;
  }
}

function readPng(b: Uint8Array, m: ImageMeta): void {
  m.kind = 'png';
  const u32 = (o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  let p = 8;
  while (p + 12 <= b.length) {
    const len = u32(p);
    const type = ascii(b, p + 4, p + 8);
    const body = p + 8;
    const end = Math.min(body + len, b.length);
    if (type === 'IHDR' && body + 8 <= b.length) {
      m.width = u32(body);
      m.height = u32(body + 4);
    } else if (type === 'eXIf') readExif(b, body, end, m);
    else if (type === 'iTXt' && startsWith(b, body, 'XML:com.adobe.xmp\0')) {
      // keyword\0 compression flag, method, language\0, translated keyword\0, text
      let q = body + 18;
      const compressed = b[q] === 1;
      q += 2;
      while (q < end && b[q] !== 0) q++;
      q++;
      while (q < end && b[q] !== 0) q++;
      q++;
      if (!compressed && q < end) readXmp(utf8(b, q, end), m);
    } else if (type === 'IDAT' || type === 'IEND') break;
    p = body + len + 4;
  }
}

function readWebp(b: Uint8Array, m: ImageMeta): void {
  m.kind = 'webp';
  const u32 = (o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  let p = 12;
  while (p + 8 <= b.length) {
    const type = ascii(b, p, p + 4);
    const len = u32(p + 4);
    const body = p + 8;
    const end = Math.min(body + len, b.length);
    if (type === 'VP8X' && body + 10 <= b.length) {
      m.width = 1 + (b[body + 4] | (b[body + 5] << 8) | (b[body + 6] << 16));
      m.height = 1 + (b[body + 7] | (b[body + 8] << 8) | (b[body + 9] << 16));
    } else if (type === 'VP8 ' && m.width === 0 && body + 10 <= b.length && b[body + 3] === 0x9d && b[body + 4] === 0x01 && b[body + 5] === 0x2a) {
      m.width = (b[body + 6] | (b[body + 7] << 8)) & 0x3fff;
      m.height = (b[body + 8] | (b[body + 9] << 8)) & 0x3fff;
    } else if (type === 'VP8L' && m.width === 0 && body + 5 <= b.length && b[body] === 0x2f) {
      const bits = u32(body + 1);
      m.width = 1 + (bits & 0x3fff);
      m.height = 1 + ((bits >>> 14) & 0x3fff);
    } else if (type === 'EXIF') readExif(b, startsWith(b, body, 'Exif\0\0') ? body + 6 : body, end, m);
    else if (type === 'XMP ') readXmp(utf8(b, body, end), m);
    p = body + len + (len & 1);
  }
}

/** Read what the (first bytes of the) file tell.  Never throws. */
export function readImageMeta(bytes: Uint8Array): ImageMeta {
  const m = empty();
  try {
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) readJpeg(bytes, m);
    else if (startsWith(bytes, 0, '\x89PNG\r\n\x1a\n')) readPng(bytes, m);
    else if (startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP')) readWebp(bytes, m);
  } catch {
    /* a damaged file simply tells less */
  }
  return m;
}

/**
 * Is this a full 360° panorama?  The metadata decides if it speaks;
 * otherwise the shape does: equirectangular pictures are exactly twice as
 * wide as high (and nothing else of that size is).
 */
export function looksLikePanorama(meta: Pick<ImageMeta, 'pano' | 'width' | 'height'>): boolean {
  if (meta.pano !== null) return meta.pano;
  return meta.width >= 2000 && meta.height > 0 && Math.abs(meta.width / meta.height - 2) < 0.02;
}
