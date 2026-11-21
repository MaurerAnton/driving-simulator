// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The regions of the game: the maps it can load besides the one the site
 * serves (map-assets/regions.json).
 *
 * The site ships one map (Hesse) as `public/map`; the other regions are maps
 * of their own – a region has its own extent, its own roads, its own places to
 * start at – and their files live in map-assets beside the tiles that carry
 * them (world/partcache.ts reads them from raw.githubusercontent.com, which
 * answers with a CORS header a release asset does not).
 *
 * `regions.json` is the index of them: what exists, which one is the default,
 * and where each one's files are.  It is read once when the game starts, like
 * the parts index (world/tileversions.ts):
 *
 *   {
 *     "latest": "hesse",
 *     "regions": [
 *       { "id": "hesse",  "name": "Nordhessen", "box": [-65000, -46000, 59000, 60000],
 *         "map": "regions/hesse/map.json", "tiles": ["1.tar", …] },
 *       { "id": "bremen", "name": "Bremen",     "box": [ … ],
 *         "map": "regions/bremen/map.json", "tiles": ["34.tar"] }
 *     ]
 *   }
 *
 * - `latest` – the region the game loads when none is chosen (the site's own map).
 * - `id`     – the name the region is referred to by (its folder under map-assets/regions/).
 * - `name`   – what it is called in the interface (a town or a land, in the map's own words).
 * - `box`    – where it lies in the world frame: [minX, minZ, maxX, maxZ] in metres, the same
 *              numbers the map's own map.json carries (meta.minX …), so the big map and the
 *              geolocation know where it is.
 * - `map`    – the path of its map.json (relative to map-assets/): the index the loader reads.
 * - `tiles`  – the parts (files of map-assets) that carry its tiles (world/partcache.ts).
 *
 * What a region needs to be playable – the map.json, the road network (w/*.json.gz) and
 * net.bin.gz – is fetched by its own path from the same folder; `map` names the first of them,
 * the rest follow from it (the loader asks for `w/<cx>_<cz>.json.gz` and `net.bin.gz` beside it).
 */

/** One region as the index names it. */
export interface Region {
  /** the name the region is referred to by (its folder under map-assets/regions/) */
  id: string;
  /** what it is called in the interface */
  name: string;
  /** where it lies in the world frame: [minX, minZ, maxX, maxZ] in metres */
  box: [number, number, number, number];
  /** the path of its map.json, relative to map-assets/ */
  map: string;
  /** the parts (files of map-assets) that carry its tiles */
  tiles: string[];
}

/** The index of map-assets: what regions exist, which one is the default. */
export interface RegionIndex {
  /** the region the game loads when none is chosen */
  latest: string;
  regions: Region[];
}

/** The folder every region's files live under, relative to map-assets/. */
export const REGIONS_DIR = 'regions';

/** The path of a region's map.json from its id (the folder it is kept in). */
export function regionMapPath(id: string): string {
  return `${REGIONS_DIR}/${id}/map.json`;
}

/**
 * The index the game reads: `latest` and the regions, in the order they are
 * listed (which is the order they are offered in).  Anything unusable is left
 * out rather than failing the whole index – a region the game cannot read is
 * one the player simply does not see.
 */
export function parseRegions(json: unknown): RegionIndex | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as { latest?: unknown; regions?: unknown };
  if (!Array.isArray(o.regions)) return null;
  const regions: Region[] = [];
  const seen = new Set<string>();
  for (const r of o.regions) {
    if (typeof r !== 'object' || r === null) continue;
    const e = r as { id?: unknown; name?: unknown; box?: unknown; map?: unknown; tiles?: unknown; zone?: unknown };
    const id = typeof e.id === 'string' ? e.id : '';
    if (!id || seen.has(id)) continue;
    const box = Array.isArray(e.box) && e.box.length === 4 && e.box.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (e.box as [number, number, number, number]) : null;
    if (!box) continue;
    const map = typeof e.map === 'string' && e.map ? e.map : regionMapPath(id);
    seen.add(id);
    regions.push({
      id,
      name: typeof e.name === 'string' && e.name ? e.name : id,
      box,
      map,
      tiles: Array.isArray(e.tiles) ? e.tiles.filter((t): t is string => typeof t === 'string') : [],
    });
  }
  const latest = typeof o.latest === 'string' && regions.some((r) => r.id === o.latest) ? o.latest : regions[0]?.id ?? '';
  return { latest, regions };
}

/** The region the game loads when none is chosen (the site's own map), or null. */
export function defaultRegion(index: RegionIndex | null): Region | null {
  if (!index) return null;
  return index.regions.find((r) => r.id === index.latest) ?? index.regions[0] ?? null;
}

/** The region with this id, or null. */
export function regionById(index: RegionIndex | null, id: string): Region | null {
  if (!index) return null;
  return index.regions.find((r) => r.id === id) ?? null;
}

/** Is the point inside the region's box (world metres)? – where the big map may show it. */
export function boxContains(box: [number, number, number, number], x: number, z: number): boolean {
  return x >= box[0] && x <= box[2] && z >= box[1] && z <= box[3];
}

/** The region a point lies in, or null (it lies in none of them). */
export function regionAt(index: RegionIndex | null, x: number, z: number): Region | null {
  if (!index) return null;
  return index.regions.find((r) => boxContains(r.box, x, z)) ?? null;
}
