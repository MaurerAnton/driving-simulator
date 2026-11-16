// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Binary container for map tiles (public/map/tiles/<ix>_<iz>.bin).
 *
 *   "FSB1" | u32 jsonLength | JSON header (space padded to 4 bytes) | sections …
 *
 * The header lists typed-array sections by name with byte offsets relative to
 * the start of the payload.  Everything is little-endian (all supported
 * platforms are), so sections can be viewed in place without copying.
 */
import { unpackFaces } from './facade.ts';

export type SectionType = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32';
export type SectionArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array;

export interface SectionInfo {
  off: number;
  n: number;
  t: SectionType;
  /** how the numbers are stored (CODING; absent: as they are) and, for that, how many belong together */
  c?: number;
  s?: number;
}

/**
 * How a section of whole numbers is stored.  Vertices, indices and heights
 * change little from one to the next: stored as the steps between them, with
 * the low and the high bytes apart, they take half the room once deflated.
 * Which way is smallest depends on the data – the map build tries them.
 */
export const CODING = {
  /** as they are */
  RAW: 0,
  /** component by component (all x, then all y, …), low bytes before high bytes */
  PLANES: 1,
  /** the same, of the step from the number of the same component before */
  DELTA: 2,
  /** a grid with rows of `s` numbers: what the neighbours to the left and above do not foretell */
  GRID: 3,
} as const;

/** A section in one of the codings: its bytes, and what it decodes to. */
export interface CodedSection {
  bytes: Uint8Array;
  t: SectionType;
  n: number;
  c: number;
  s: number;
}

const wrap = (d: number, bytes: number): number => (bytes === 4 ? d | 0 : bytes === 2 ? (d << 16) >> 16 : (d << 24) >> 24);
const zig = (d: number, bytes: number): number => ((d << 1) ^ (d >> 31)) & (bytes === 4 ? 0xffffffff : bytes === 2 ? 0xffff : 0xff);
const unzig = (u: number): number => (u >>> 1) ^ -(u & 1);

/** Store a section of whole numbers in a coding (`stride`: how many numbers belong together; for GRID the width of a row). */
export function encodeSection(a: Exclude<SectionArray, Float32Array>, coding: number, stride: number): CodedSection {
  const B = a.BYTES_PER_ELEMENT;
  const n = a.length;
  const t = typeOf(a);
  if (coding === CODING.RAW) return { bytes: new Uint8Array(a.buffer, a.byteOffset, a.byteLength), t, n, c: coding, s: stride };
  const groups = coding === CODING.GRID ? 1 : stride;
  const per = n / groups;
  const vals = new Uint32Array(n);
  if (coding === CODING.GRID) {
    for (let i = 0; i < n; i++) {
      const col = i % stride;
      const left = col > 0 ? a[i - 1] : 0;
      const up = i >= stride ? a[i - stride] : 0;
      const ul = col > 0 && i >= stride ? a[i - stride - 1] : 0;
      vals[i] = zig(wrap(a[i] - (left + up - ul), B), B);
    }
  } else {
    for (let c = 0; c < stride; c++) {
      let prev = 0;
      for (let i = 0; i < per; i++) {
        const v = a[i * stride + c];
        vals[c * per + i] = coding === CODING.DELTA ? zig(wrap(v - prev, B), B) : v & (B === 4 ? 0xffffffff : B === 2 ? 0xffff : 0xff);
        prev = v;
      }
    }
  }
  const bytes = new Uint8Array(n * B);
  let o = 0;
  for (let c = 0; c < groups; c++) for (let b = 0; b < B; b++) for (let i = 0; i < per; i++) bytes[o++] = (vals[c * per + i] >>> (8 * b)) & 255;
  return { bytes, t, n, c: coding, s: stride };
}

function decodeSection(bytes: Uint8Array, info: SectionInfo): SectionArray {
  const { n, t } = info;
  const coding = info.c ?? CODING.RAW;
  const stride = info.s ?? 1;
  const B = BYTES[t];
  const out = t === 'u8' ? new Uint8Array(n) : t === 'i8' ? new Int8Array(n) : t === 'u16' ? new Uint16Array(n) : t === 'i16' ? new Int16Array(n) : t === 'u32' ? new Uint32Array(n) : new Int32Array(n);
  const groups = coding === CODING.GRID ? 1 : stride;
  const per = n / groups;
  for (let c = 0; c < groups; c++) {
    const base = c * B * per;
    let prev = 0;
    for (let i = 0; i < per; i++) {
      let v = bytes[base + i];
      if (B > 1) v |= bytes[base + per + i] << 8;
      if (B > 2) v = (v | (bytes[base + 2 * per + i] << 16) | (bytes[base + 3 * per + i] << 24)) >>> 0;
      if (coding === CODING.GRID) {
        const col = i % stride;
        const left = col > 0 ? out[i - 1] : 0;
        const up = i >= stride ? out[i - stride] : 0;
        const ul = col > 0 && i >= stride ? out[i - stride - 1] : 0;
        out[i] = unzig(v) + left + up - ul;
      } else if (coding === CODING.DELTA) {
        // (the typed array wraps the sum the way the steps were wrapped)
        out[i * stride + c] = prev + unzig(v);
        prev = out[i * stride + c];
      } else out[i * stride + c] = v;
    }
  }
  return out;
}

/** Quantisation of mesh positions inside a tile. */
export const POS_XZ_SCALE = 0.02; // metres per unit, relative to the tile centre
export const POS_Y_SCALE = 0.01; // metres per unit, relative to header.yBase
export const UV_SCALE = 0.02;

/** Ground surface material ids (per-vertex attribute of the `ground` mesh). */
export const GM = {
  ASPHALT: 0,
  CONCRETE: 1,
  PAVING: 2,
  SETT: 3,
  GRAVEL: 4,
  DIRT: 5,
  GRASS: 6,
  SIDEWALK: 7,
  KERB: 8,
  VERGE: 9,
  ASPHALT_OLD: 10,
  RAIL_BALLAST: 11,
  PATH: 12,
  CYCLE: 13,
  /** paint (`mark` mesh) */
  PAINT_WHITE: 20,
  PAINT_YELLOW: 21,
  PAINT_RED: 22,
  PAINT_BLUE: 23,
} as const;

/** Building face styles (per-vertex attribute of the `bldg` mesh). */
export const BS = {
  WALL_HOUSE: 0,
  WALL_GARAGE: 1,
  WALL_COMMERCIAL: 2,
  WALL_PUBLIC: 3,
  WALL_CHURCH: 4,
  WALL_PLAIN: 5,
  ROOF_TILES: 8,
  ROOF_FLAT: 9,
  ROOF_METAL: 10,
} as const;

/** One sign post with its plates, top to bottom. */
export interface SignPost {
  x: number;
  y: number;
  z: number;
  /** direction the plates FACE (radians, same convention as vehicle yaw: 0 = facing north) */
  yaw: number;
  /** sign codes, e.g. ["205", "1002-12"]; "310:Name" style codes carry text */
  s: string[];
  /** mounting height of the lowest plate's lower edge above ground */
  h: number;
  /** 0 = normal size, 1 = large (motorway) */
  big?: number;
}

export interface TileObject {
  /** kind: lamp, bus_stop, bollard, bench, … */
  k: string;
  x: number;
  y: number;
  z: number;
  yaw?: number;
  /** free-form parameter (e.g. name of the bus stop) */
  p?: string;
}

export interface TileHeader {
  v: number;
  ix: number;
  iz: number;
  /** world coordinates of the tile centre and the height reference */
  cx: number;
  cz: number;
  yBase: number;
  size: number;
  /** terrain grid: (n × n) samples covering the tile, spacing = size / (n - 1) */
  terrainN: number;
  terrainMin: number;
  terrainScale: number;
  coverN: number;
  signs: SignPost[];
  objects: TileObject[];
  /** 1: nothing of this tile stands in a lane – the map build saw to it (src/sim/clearlanes.ts) */
  clr?: number;
  sections: Record<string, SectionInfo>;
}

const BYTES: Record<SectionType, number> = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4 };

function typeOf(a: SectionArray): SectionType {
  if (a instanceof Uint8Array) return 'u8';
  if (a instanceof Int8Array) return 'i8';
  if (a instanceof Uint16Array) return 'u16';
  if (a instanceof Int16Array) return 'i16';
  if (a instanceof Uint32Array) return 'u32';
  if (a instanceof Int32Array) return 'i32';
  return 'f32';
}

export function packTile(
  header: Omit<TileHeader, 'sections'>,
  sections: Record<string, SectionArray | CodedSection>,
): Uint8Array {
  return packSections(header, sections);
}

/** The container with any header: named typed arrays behind a JSON object (which gets their places as `sections`). */
export function packSections(header: object, sections: Record<string, SectionArray | CodedSection>): Uint8Array {
  const infos: Record<string, SectionInfo> = {};
  const data: Record<string, Uint8Array> = {};
  let off = 0;
  for (const [name, arr] of Object.entries(sections)) {
    const coded = 'bytes' in arr ? arr : null;
    const n = coded ? coded.n : (arr as SectionArray).length;
    if (n === 0) continue;
    const t = coded ? coded.t : typeOf(arr as SectionArray);
    off = (off + 3) & ~3;
    infos[name] = coded && coded.c !== CODING.RAW ? { off, n, t, c: coded.c, s: coded.s } : { off, n, t };
    const plain = arr as SectionArray;
    data[name] = coded ? coded.bytes : new Uint8Array(plain.buffer, plain.byteOffset, plain.byteLength);
    off += n * BYTES[t];
  }
  const payloadLen = (off + 3) & ~3;
  let json = JSON.stringify({ ...header, sections: infos });
  const enc = new TextEncoder();
  let jsonBytes = enc.encode(json);
  const pad = (4 - (jsonBytes.length & 3)) & 3;
  if (pad) {
    json += ' '.repeat(pad);
    jsonBytes = enc.encode(json);
  }
  const out = new Uint8Array(8 + jsonBytes.length + payloadLen);
  out.set([0x46, 0x53, 0x42, 0x31], 0); // "FSB1"
  new DataView(out.buffer).setUint32(4, jsonBytes.length, true);
  out.set(jsonBytes, 8);
  const base = 8 + jsonBytes.length;
  for (const name of Object.keys(infos)) out.set(data[name], base + infos[name].off);
  return out;
}

export interface UnpackedTile {
  header: TileHeader;
  get(name: string): SectionArray | null;
}

/**
 * Trees and the outlines of buildings are stored as whole numbers around the
 * tile's middle.  A tree: where it stands to a hand's breadth (section
 * treeXZ – it stands on the tile's ground, so its height above sea level is
 * not stored), how tall it is and of which kind (treeHK: all the heights,
 * then all the kinds).
 */
export const TREE_SCALE = 0.1;
/** (the first tiles of this kind: x, y, z per tree in steps of 2 cm, section treeQ) */
const TREE_Q_SCALE = 0.02;
export const TREE_HEIGHT_SCALE = 0.2;
export const RING_SCALE = 0.02;

/**
 * The height of a tile's ground at a place in it, from its grid of heights
 * (section hgt) – the surface the game draws: two triangles per cell, split
 * along the diagonal from its second to its third corner.
 */
export function tileGround(h: Pick<TileHeader, 'cx' | 'cz' | 'size' | 'terrainN' | 'terrainMin' | 'terrainScale'>, hgt: ArrayLike<number>, x: number, z: number): number {
  const n = h.terrainN;
  const step = h.size / (n - 1);
  const fx = Math.max(0, Math.min(n - 1.0001, (x - (h.cx - h.size / 2)) / step));
  const fz = Math.max(0, Math.min(n - 1.0001, (z - (h.cz - h.size / 2)) / step));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const k = j * n + i;
  const h00 = hgt[k];
  const h10 = hgt[k + 1];
  const h01 = hgt[k + n];
  const h11 = hgt[k + n + 1];
  const v = tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  return h.terrainMin + v * h.terrainScale;
}

export function unpackTile(buf: ArrayBuffer): UnpackedTile {
  const u = unpackSections<TileHeader>(buf);
  const h = u.header;
  let trees: Float32Array | null | undefined;
  let rings: Float32Array | null | undefined;
  let faces: Int16Array | null | undefined;
  return {
    header: h,
    get(name: string): SectionArray | null {
      // (what the faces of the buildings need for their facades follows from their corners: world/facade.ts)
      if (name === 'bldg_a16' && !h.sections.bldg_a16) {
        if (faces === undefined) {
          const pos = u.get('bldg_pos') as Int16Array | null;
          const run = u.get('bldg_run') as Uint16Array | null;
          faces = pos && run ? unpackFaces(pos, run, u.get('bldg_uvx') as Int16Array | null) : null;
        }
        return faces;
      }
      // (what older tiles hold as plain numbers: x, y, z, height, kind per tree; x, z per corner)
      if (name === 'trees' && !h.sections.trees) {
        if (trees === undefined) {
          const xz = u.get('treeXZ') as Int16Array | null;
          const q = u.get('treeQ') as Int16Array | null;
          const hk = u.get('treeHK') as Uint8Array | null;
          const hgt = u.get('hgt') as Uint16Array | null;
          trees = null;
          if (xz && hk && hgt) {
            const n = xz.length / 2;
            trees = new Float32Array(n * 5);
            for (let i = 0; i < n; i++) {
              const x = h.cx + xz[i * 2] * TREE_SCALE;
              const z = h.cz + xz[i * 2 + 1] * TREE_SCALE;
              trees[i * 5] = x;
              trees[i * 5 + 1] = tileGround(h, hgt, x, z);
              trees[i * 5 + 2] = z;
              trees[i * 5 + 3] = hk[i] * TREE_HEIGHT_SCALE;
              trees[i * 5 + 4] = hk[n + i];
            }
          } else if (q && hk) {
            const n = q.length / 3;
            trees = new Float32Array(n * 5);
            for (let i = 0; i < n; i++) {
              trees[i * 5] = h.cx + q[i * 3] * TREE_Q_SCALE;
              trees[i * 5 + 1] = h.yBase + q[i * 3 + 1] * TREE_Q_SCALE;
              trees[i * 5 + 2] = h.cz + q[i * 3 + 2] * TREE_Q_SCALE;
              trees[i * 5 + 3] = hk[i] * TREE_HEIGHT_SCALE;
              trees[i * 5 + 4] = hk[n + i];
            }
          }
        }
        return trees;
      }
      if (name === 'collPts' && !h.sections.collPts) {
        if (rings === undefined) {
          const q = u.get('collQ') as Int16Array | null;
          rings = null;
          if (q) {
            rings = new Float32Array(q.length);
            for (let i = 0; i < q.length; i += 2) {
              rings[i] = h.cx + q[i] * RING_SCALE;
              rings[i + 1] = h.cz + q[i + 1] * RING_SCALE;
            }
          }
        }
        return rings;
      }
      return u.get(name);
    },
  };
}

export function unpackSections<H extends { sections: Record<string, SectionInfo> }>(buf: ArrayBuffer): { header: H; get(name: string): SectionArray | null } {
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0x46 || bytes[1] !== 0x53 || bytes[2] !== 0x42 || bytes[3] !== 0x31) {
    throw new Error('not a map tile (bad magic)');
  }
  const jsonLen = new DataView(buf).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLen))) as H;
  const base = 8 + jsonLen;
  const decoded = new Map<string, SectionArray>();
  return {
    header,
    get(name: string): SectionArray | null {
      const info = header.sections[name];
      if (!info) return null;
      const o = base + info.off;
      if (info.c) {
        // (stored in a coding: decoded once, when first asked for)
        let a = decoded.get(name);
        if (!a) decoded.set(name, (a = decodeSection(new Uint8Array(buf, o, info.n * BYTES[info.t]), info)));
        return a;
      }
      switch (info.t) {
        case 'u8':
          return new Uint8Array(buf, o, info.n);
        case 'i8':
          return new Int8Array(buf, o, info.n);
        case 'u16':
          return new Uint16Array(buf, o, info.n);
        case 'i16':
          return new Int16Array(buf, o, info.n);
        case 'u32':
          return new Uint32Array(buf, o, info.n);
        case 'i32':
          return new Int32Array(buf, o, info.n);
        default:
          return new Float32Array(buf, o, info.n);
      }
    },
  };
}

/** Tile index of a world coordinate. */
export function tileIndex(v: number, min: number, size: number): number {
  return Math.floor((v - min) / size);
}

export function tileKey(ix: number, iz: number): string {
  return `${ix}_${iz}`;
}
