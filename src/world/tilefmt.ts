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
  sections: Record<string, SectionArray>,
): Uint8Array {
  const infos: Record<string, SectionInfo> = {};
  let off = 0;
  for (const [name, arr] of Object.entries(sections)) {
    if (arr.length === 0) continue;
    const t = typeOf(arr);
    off = (off + 3) & ~3;
    infos[name] = { off, n: arr.length, t };
    off += arr.length * BYTES[t];
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
  for (const [name, arr] of Object.entries(sections)) {
    const info = infos[name];
    if (!info) continue;
    out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), base + info.off);
  }
  return out;
}

export interface UnpackedTile {
  header: TileHeader;
  get(name: string): SectionArray | null;
}

export function unpackTile(buf: ArrayBuffer): UnpackedTile {
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0x46 || bytes[1] !== 0x53 || bytes[2] !== 0x42 || bytes[3] !== 0x31) {
    throw new Error('not a map tile (bad magic)');
  }
  const jsonLen = new DataView(buf).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLen))) as TileHeader;
  const base = 8 + jsonLen;
  return {
    header,
    get(name: string): SectionArray | null {
      const info = header.sections[name];
      if (!info) return null;
      const o = base + info.off;
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
