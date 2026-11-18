// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Image files: recognising the type from the bytes, reading the size, and
 * rewriting the container without its metadata – no image library needed,
 * the pixels are never decoded.
 *
 * - JPEG: the segments are walked; APP1 (EXIF with GPS, XMP), APP13 (IPTC),
 *   the other APPn and comments are dropped; JFIF (APP0), the colour profile
 *   (APP2 `ICC_PROFILE`) and Adobe (APP14, needed for the colours) are kept;
 *   whatever follows the end marker (the second picture of a "motion photo",
 *   MPF pictures) goes too.  If the camera's EXIF said the picture is turned
 *   (orientation 2…8), a minimal EXIF block holding only that orientation is
 *   written back, so the picture still shows upright.
 * - PNG: only the critical chunks and a list of known harmless ones (colour,
 *   transparency, physical size, animation) are kept; text chunks (tEXt,
 *   zTXt, iTXt), eXIf, tIME and anything unknown are dropped.
 * - WebP: EXIF and XMP chunks are dropped (and their flags in VP8X cleared);
 *   the picture, alpha, animation and colour profile chunks are kept.
 */

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface CleanImage {
  mime: ImageMime;
  ext: 'jpg' | 'png' | 'webp';
  /** Size as shown (after the EXIF orientation is applied). */
  width: number;
  height: number;
  /** The rewritten file. */
  data: Buffer;
}

export class ImageError extends Error {}

export function sniff(b: Buffer): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Recognises, measures and strips an image; throws ImageError for anything not a well-formed JPEG/PNG/WebP. */
export function cleanImage(b: Buffer): CleanImage {
  const mime = sniff(b);
  let r: { width: number; height: number; data: Buffer };
  if (mime === 'image/jpeg') r = cleanJpeg(b);
  else if (mime === 'image/png') r = cleanPng(b);
  else if (mime === 'image/webp') r = cleanWebp(b);
  else throw new ImageError('not a JPEG, PNG or WebP file');
  if (!(r.width > 0 && r.height > 0 && r.width <= 65535 && r.height <= 65535)) throw new ImageError('bad image size');
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp';
  return { mime, ext, ...r };
}

// ---------------------------------------------------------------- JPEG

function need(b: Buffer, end: number): void {
  if (end > b.length) throw new ImageError('truncated image');
}

/** The orientation tag (0x0112) of an EXIF APP1 payload (after "Exif\0\0"), or 1. */
function exifOrientation(tiff: Buffer): number {
  try {
    if (tiff.length < 8) return 1;
    const le = tiff.toString('latin1', 0, 2) === 'II';
    if (!le && tiff.toString('latin1', 0, 2) !== 'MM') return 1;
    const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    const ifd = u32(4);
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === 0x0112 && u16(e + 2) === 3) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
  } catch { /* unreadable EXIF: treat as upright */ }
  return 1;
}

/** An APP1 segment holding nothing but the orientation. */
function orientationSegment(o: number): Buffer {
  const s = Buffer.alloc(36);
  s.writeUInt16BE(0xffe1, 0);
  s.writeUInt16BE(34, 2);
  s.write('Exif\0\0', 4, 'latin1');
  s.write('MM', 10, 'latin1');
  s.writeUInt16BE(42, 12);
  s.writeUInt32BE(8, 14); // IFD0 offset
  s.writeUInt16BE(1, 18); // one entry
  s.writeUInt16BE(0x0112, 20);
  s.writeUInt16BE(3, 22); // SHORT
  s.writeUInt32BE(1, 24);
  s.writeUInt16BE(o, 28);
  s.writeUInt32BE(0, 32); // no next IFD
  return s;
}

function cleanJpeg(b: Buffer): { width: number; height: number; data: Buffer } {
  const out: Buffer[] = [b.subarray(0, 2)];
  let pos = 2;
  let width = 0;
  let height = 0;
  let orientation = 1;
  let afterApp0 = 1; // where the orientation segment goes (index in out)
  let ended = false;
  while (pos < b.length) {
    if (b[pos] !== 0xff) throw new ImageError('bad JPEG segment');
    while (pos < b.length && b[pos] === 0xff) pos++; // fill bytes
    need(b, pos + 1);
    const m = b[pos];
    const start = pos - 1;
    pos++;
    if (m === 0xd9) { out.push(Buffer.from([0xff, 0xd9])); ended = true; break; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { out.push(Buffer.from([0xff, m])); continue; }
    need(b, pos + 2);
    const len = b.readUInt16BE(pos);
    if (len < 2) throw new ImageError('bad JPEG segment length');
    const end = pos + len;
    need(b, end);
    const body = b.subarray(pos + 2, end);
    const seg = b.subarray(start, end);
    pos = end;
    if (m === 0xe0) {
      if (body.toString('latin1', 0, 5) === 'JFIF\0') { out.push(seg); afterApp0 = out.length; }
    } else if (m === 0xe1) {
      if (body.toString('latin1', 0, 6) === 'Exif\0\0' && orientation === 1) orientation = exifOrientation(body.subarray(6));
    } else if (m === 0xe2) {
      if (body.toString('latin1', 0, 12) === 'ICC_PROFILE\0') out.push(seg);
    } else if (m === 0xee) {
      if (body.toString('latin1', 0, 5) === 'Adobe') out.push(seg);
    } else if ((m >= 0xe3 && m <= 0xef) || m === 0xfe) {
      // other application data and comments: dropped
    } else {
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && !width) {
        if (body.length < 5) throw new ImageError('bad JPEG frame header');
        height = body.readUInt16BE(1);
        width = body.readUInt16BE(3);
      }
      out.push(seg);
      if (m === 0xda) {
        // entropy-coded data up to the next marker that is not a stuffed 0xFF00 or a restart marker
        let p = pos;
        while (p + 1 < b.length) {
          if (b[p] === 0xff) {
            const n = b[p + 1];
            if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) { p += n === 0xff ? 1 : 2; continue; }
            break;
          }
          p++;
        }
        if (p + 1 >= b.length) throw new ImageError('truncated JPEG');
        out.push(b.subarray(pos, p));
        pos = p;
      }
    }
  }
  if (!ended) throw new ImageError('JPEG without end marker');
  if (!width || !height) throw new ImageError('JPEG without frame header');
  if (orientation !== 1) out.splice(afterApp0, 0, orientationSegment(orientation));
  const turned = orientation >= 5;
  return { width: turned ? height : width, height: turned ? width : height, data: Buffer.concat(out) };
}

// ---------------------------------------------------------------- PNG

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCv', 'cLLi',
  'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT',
]);

function cleanPng(b: Buffer): { width: number; height: number; data: Buffer } {
  const out: Buffer[] = [PNG_SIG];
  let pos = 8;
  let width = 0;
  let height = 0;
  let ended = false;
  let first = true;
  while (pos + 12 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    need(b, end);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new ImageError('bad PNG chunk');
    if (first) {
      if (type !== 'IHDR' || len < 8) throw new ImageError('PNG without IHDR');
      width = b.readUInt32BE(pos + 8);
      height = b.readUInt32BE(pos + 12);
      first = false;
    }
    if (PNG_KEEP.has(type)) out.push(b.subarray(pos, end));
    pos = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended) throw new ImageError('PNG without IEND');
  return { width, height, data: Buffer.concat(out) };
}

// ---------------------------------------------------------------- WebP

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

function cleanWebp(b: Buffer): { width: number; height: number; data: Buffer } {
  const riffEnd = Math.min(b.length, 8 + b.readUInt32LE(4));
  const chunks: Buffer[] = [];
  let pos = 12;
  let width = 0;
  let height = 0;
  while (pos + 8 <= riffEnd) {
    const type = b.toString('latin1', pos, pos + 4);
    const len = b.readUInt32LE(pos + 4);
    const end = pos + 8 + len + (len & 1);
    need(b, pos + 8 + len);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'VP8X') {
      if (len < 10) throw new ImageError('bad VP8X');
      const c = Buffer.from(b.subarray(pos, Math.min(end, b.length)));
      c[8] &= ~0x0c; // no EXIF, no XMP
      chunks.push(c);
      width = 1 + data.readUIntLE(4, 3);
      height = 1 + data.readUIntLE(7, 3);
    } else if (WEBP_KEEP.has(type)) {
      if (!width && type === 'VP8 ') {
        if (len < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw new ImageError('bad VP8');
        width = data.readUInt16LE(6) & 0x3fff;
        height = data.readUInt16LE(8) & 0x3fff;
      } else if (!width && type === 'VP8L') {
        if (len < 5 || data[0] !== 0x2f) throw new ImageError('bad VP8L');
        const v = data.readUInt32LE(1);
        width = (v & 0x3fff) + 1;
        height = ((v >>> 14) & 0x3fff) + 1;
      }
      const c = b.subarray(pos, Math.min(end, b.length));
      chunks.push(c.length & 1 ? Buffer.concat([c, Buffer.alloc(1)]) : c);
    }
    pos = end;
  }
  if (!chunks.length) throw new ImageError('WebP without picture');
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return { width, height, data: Buffer.concat([head, body]) };
}
