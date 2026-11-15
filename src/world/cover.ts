// SPDX-License-Identifier: AGPL-3.0-only
/** Ground-cover classes of the terrain raster (shared by pipeline and renderer). */
export const COVER = {
  MEADOW: 0,
  FARMLAND: 1,
  GRASS: 2,
  FOREST: 3,
  SCRUB: 4,
  RESIDENTIAL: 5,
  COMMERCIAL: 6,
  INDUSTRIAL: 7,
  FARMYARD: 8,
  ALLOTMENT: 9,
  ORCHARD: 10,
  CEMETERY: 11,
  RAILWAY: 12,
  BARE: 13,
  PITCH: 14,
  ASPHALT: 15,
  PAVED: 16,
  WATER: 17,
} as const;

/** Base colours (sRGB hex) per cover class – the renderer adds detail noise. */
export const COVER_COLORS: readonly number[] = [
  0x7d9a4e, // meadow
  0xa9a35c, // farmland
  0x6f9a48, // mown grass / parks
  0x3f6534, // forest floor
  0x5f7f3f, // scrub
  0x7a9457, // residential gardens
  0x9a9a92, // commercial yards
  0x8f8d88, // industrial yards
  0x9a8a6a, // farmyard
  0x7c9550, // allotments
  0x86a052, // orchard
  0x6f8f55, // cemetery
  0x77706a, // railway ballast
  0x9c8b70, // bare earth
  0x5f9a55, // sports pitch
  0x55565a, // asphalt (car parks)
  0xa39f97, // paved squares
  0x4d7089, // water
];

export const COVER_NAMES: readonly string[] = [
  'meadow',
  'farmland',
  'grass',
  'forest',
  'scrub',
  'residential',
  'commercial',
  'industrial',
  'farmyard',
  'allotment',
  'orchard',
  'cemetery',
  'railway',
  'bare',
  'pitch',
  'asphalt',
  'paved',
  'water',
];
