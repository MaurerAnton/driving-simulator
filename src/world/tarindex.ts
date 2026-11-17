// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where the files of a tar archive lie in it – found while the archive
 * streams past, without holding more of it than one header.
 *
 * A map pack (world/mappack.ts) is the map.tar of a release, a gigabyte or
 * more, loaded by hand from a file.  It is stored as it comes, byte for byte;
 * all the game needs besides is which file begins where and how long it is.
 * TarIndexer is told every piece of the stream in turn (push) and reports
 * every regular file in it (onEntry): its path, the place of its first byte
 * counted from `base`, and its size.
 *
 * It reads what tar programs write: the old format and ustar (names with a
 * prefix), GNU long names (type L) and pax headers (type x: path, size).
 * Paths lose a leading "./" and the "map/" folder the release packs the map
 * in: "map/tiles/270_458.fsb" is found as "tiles/270_458.fsb".
 */

export interface TarEntry {
  /** the path of the file within the map ("map.json", "tiles/270_458.fsb") */
  path: string;
  /** where its first byte lies: `base` plus its place in the archive */
  offset: number;
  size: number;
}

export class TarError extends Error {}

const BLOCK = 512;
/** the most a long name or a pax header may take (they are kept whole) */
const META_MAX = 1 << 20;

const utf8 = new TextDecoder();

/** A path as the game asks for it: no "./", no leading slash, no "map/" folder. */
export function mapPath(name: string): string {
  let p = name.replace(/\\/g, '/');
  for (;;) {
    const q = p.replace(/^\.\//, '').replace(/^\/+/, '');
    if (q === p) break;
    p = q;
  }
  if (p.startsWith('map/')) p = p.slice(4);
  return p;
}

function cString(b: Uint8Array, from: number, len: number): string {
  let end = from;
  while (end < from + len && b[end] !== 0) end++;
  return utf8.decode(b.subarray(from, end));
}

/** A number of a header: octal digits – or, for big ones, base 256 (the first byte's top bit set). */
function headerNumber(b: Uint8Array, from: number, len: number): number {
  if (b[from] & 0x80) {
    let n = b[from] & 0x7f;
    for (let i = from + 1; i < from + len; i++) n = n * 256 + b[i];
    return n;
  }
  const s = cString(b, from, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError(`not a tar archive (a size of "${s}")`);
  return parseInt(s, 8);
}

/** pax records: "<length> <key>=<value>\n" */
function paxRecords(b: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const text = utf8.decode(b);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = Number(text.slice(i, sp));
    if (!(len > 0)) break;
    // (the length counts bytes, the text characters: take the line up to its newline)
    const nl = text.indexOf('\n', sp);
    const rec = text.slice(sp + 1, nl < 0 ? text.length : nl);
    const eq = rec.indexOf('=');
    if (eq > 0) out.set(rec.slice(0, eq), rec.slice(eq + 1));
    i = nl < 0 ? text.length : nl + 1;
  }
  return out;
}

export class TarIndexer {
  /** the place of the next byte pushed: `base` plus what came before */
  pos: number;
  /** the archive's end was seen (what comes after it is ignored) */
  ended = false;
  /** how many files were reported */
  count = 0;
  private readonly onEntry: (e: TarEntry) => void;
  private readonly header = new Uint8Array(BLOCK);
  private have = 0;
  /** bytes of the current entry (with its padding) still to come */
  private skip = 0;
  /** a long name or pax header being read: its bytes, how many of them are wanted */
  private meta: Uint8Array | null = null;
  private metaHave = 0;
  private metaKind = '';
  private longName: string | null = null;
  private paxPath: string | null = null;
  private paxSize: number | null = null;

  constructor(onEntry: (e: TarEntry) => void, base = 0) {
    this.onEntry = onEntry;
    this.pos = base;
  }

  push(chunk: Uint8Array): void {
    let i = 0;
    while (i < chunk.length && !this.ended) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - i);
        if (this.meta && this.metaHave < this.meta.length) {
          const m = Math.min(n, this.meta.length - this.metaHave);
          this.meta.set(chunk.subarray(i, i + m), this.metaHave);
          this.metaHave += m;
        }
        this.skip -= n;
        i += n;
        this.pos += n;
        if (this.skip === 0 && this.meta) this.endMeta();
        continue;
      }
      const n = Math.min(BLOCK - this.have, chunk.length - i);
      this.header.set(chunk.subarray(i, i + n), this.have);
      this.have += n;
      i += n;
      this.pos += n;
      if (this.have === BLOCK) {
        this.have = 0;
        this.readHeader();
      }
    }
    // (after the end: only the zeros that fill up the last record – counted, not looked at)
    if (this.ended) this.pos += chunk.length - i;
  }

  /** The stream is over: was the archive whole? */
  finish(): void {
    if (this.ended) return;
    if (this.skip > 0 || this.have > 0) throw new TarError('the archive breaks off in the middle of a file (is a part missing?)');
    // (no end blocks: tolerated – some writers leave them out)
  }

  private readHeader(): void {
    const h = this.header;
    let zero = true;
    for (let k = 0; k < BLOCK; k++) {
      if (h[k] !== 0) {
        zero = false;
        break;
      }
    }
    if (zero) {
      this.ended = true;
      return;
    }
    // the checksum: the sum of the header's bytes, its own field counted as spaces
    let sum = 0;
    for (let k = 0; k < BLOCK; k++) sum += k >= 148 && k < 156 ? 32 : h[k];
    if (headerNumber(h, 148, 8) !== sum) throw new TarError('not a tar archive (a header does not add up)');
    const type = String.fromCharCode(h[156] || 48);
    let size = headerNumber(h, 124, 12);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L' || type === 'x') {
      if (size > META_MAX) throw new TarError('not a tar archive (a header of its own is too big)');
      this.meta = new Uint8Array(size);
      this.metaHave = 0;
      this.metaKind = type;
      this.skip = padded;
      if (padded === 0) this.endMeta();
      return;
    }
    if (type === '0' || type === '7') {
      let name = cString(h, 0, 100);
      // ustar: a prefix before the name
      if (cString(h, 257, 5) === 'ustar') {
        const prefix = cString(h, 345, 155);
        if (prefix) name = `${prefix}/${name}`;
      }
      if (this.longName !== null) name = this.longName;
      if (this.paxPath !== null) name = this.paxPath;
      if (this.paxSize !== null) size = this.paxSize;
      const path = mapPath(name);
      if (path && !path.endsWith('/')) {
        this.onEntry({ path, offset: this.pos, size });
        this.count++;
      }
      this.skip = Math.ceil(size / BLOCK) * BLOCK;
    } else {
      // folders, links, global pax headers …: nothing to keep
      this.skip = padded;
    }
    this.longName = null;
    this.paxPath = null;
    this.paxSize = null;
  }

  private endMeta(): void {
    const b = this.meta as Uint8Array;
    this.meta = null;
    if (this.metaKind === 'L') this.longName = cString(b, 0, b.length);
    else {
      const rec = paxRecords(b);
      const p = rec.get('path');
      if (p !== undefined) this.paxPath = p;
      const s = rec.get('size');
      if (s !== undefined && /^\d+$/.test(s)) this.paxSize = Number(s);
    }
  }
}
