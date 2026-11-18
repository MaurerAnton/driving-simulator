// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A small multipart/form-data parser for a body already read into memory
 * (its size is limited before, see http.ts `readBody`).  It returns the
 * parts by field name; file names and content types sent by the client are
 * not trusted (the server looks at the bytes, imagefile.ts).
 */

export interface Part {
  name: string;
  filename: string | null;
  type: string | null;
  data: Buffer;
}

export class MultipartError extends Error {}

export function boundaryOf(contentType: string | undefined): string | null {
  if (!contentType || !/^multipart\/form-data\s*;/i.test(contentType)) return null;
  const m = /boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(contentType);
  return m ? (m[1] ?? m[2]) : null;
}

function headerParam(h: string, key: string): string | null {
  const m = new RegExp(`;\\s*${key}="([^"]*)"`, 'i').exec(h) ?? new RegExp(`;\\s*${key}=([^;\\s]+)`, 'i').exec(h);
  return m ? m[1] : null;
}

/** Splits a multipart body; at most `maxParts` parts. */
export function parseMultipart(body: Buffer, boundary: string, maxParts = 8): Part[] {
  const delim = Buffer.from('--' + boundary, 'latin1');
  const parts: Part[] = [];
  let pos = body.indexOf(delim);
  if (pos < 0) throw new MultipartError('no multipart boundary');
  for (;;) {
    pos += delim.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // closing "--"
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else throw new MultipartError('bad multipart delimiter');
    const headEnd = body.indexOf('\r\n\r\n', pos, 'latin1');
    if (headEnd < 0 || headEnd - pos > 4096) throw new MultipartError('bad part headers');
    const head = body.toString('utf8', pos, headEnd);
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), headEnd + 4);
    if (next < 0) throw new MultipartError('unterminated part');
    let name: string | null = null;
    let filename: string | null = null;
    let type: string | null = null;
    for (const line of head.split('\r\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k === 'content-disposition') {
        if (!/^form-data\b/i.test(v)) throw new MultipartError('bad content-disposition');
        name = headerParam(v, 'name');
        filename = headerParam(v, 'filename');
      } else if (k === 'content-type') type = v.toLowerCase();
    }
    if (!name) throw new MultipartError('part without name');
    parts.push({ name, filename, type, data: body.subarray(headEnd + 4, next) });
    if (parts.length > maxParts) throw new MultipartError('too many parts');
    pos = next + 2;
  }
  return parts;
}
