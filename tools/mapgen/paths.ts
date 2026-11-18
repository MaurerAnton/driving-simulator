// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The paths that OpenStreetMap maps as ways of their own – footways, cycle
 * paths, shared paths, pedestrian streets, bridleways – drawn as strips of
 * their width on the ground, following the terrain, in their surface.
 *
 *   highway   footway (2.0 m) | cycleway (2.5) | path (2.5 where bicycles and walkers share it, else 1.5)
 *             | pedestrian (4.0) | bridleway (2.5)
 *   width     the strip's width (m), 0.6 … 8
 *   surface   asphalt | paving_stones | sett | cobblestone | concrete | compacted | fine_gravel | gravel
 *             | ground | dirt … – without one: paving stones in built-up land for a footway,
 *             asphalt for a cycle path, compacted gravel for a path outside
 *
 * What already has its place in the road model is left out: every piece
 * whose middle (or, for a pavement mapped beside its road – footway=sidewalk
 * –, any part) lies on a road, a pavement or a junction; also bridges,
 * tunnels, steps, areas and paths of grass or wood.  Crossings of a road
 * (footway=crossing) therefore leave the road as it is: their markings come
 * from the crossing's node (control.ts, roadmesh.ts).  The cells a path
 * covers are marked occupied, so that no tree of the scattered vegetation
 * stands on it.
 */
import { COVER } from '../../src/world/cover.ts';
import { GM } from '../../src/world/tilefmt.ts';
import { newSurfaceHit } from '../../src/world/world.ts';
import type { World } from '../../src/world/world.ts';
import type { CoverMap } from './cover.ts';
import { addBand } from './meshacc.ts';
import type { TileSet } from './meshacc.ts';
import type { OsmData, Tags } from './osm.ts';
import { isClosedWay } from './osm.ts';
import type { TerrainGrid } from './terrain.ts';

/** how far above the ground a path lies (the terrain mesh is coarser than the strip) */
const LIFT = 0.05;
/** how often the strip follows the ground (m): half a terrain cell */
const STEP = 2.5;

const WIDTHS: Record<string, number> = { footway: 2.0, cycleway: 2.5, pedestrian: 4.0, bridleway: 2.5 };

function num(v: string | undefined): number {
  if (v === undefined) return NaN;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(m)?\s*$/.exec(v);
  return m ? Number(m[1].replace(',', '.')) : NaN;
}

/** Is this way a path drawn here? */
export function isDrawnPath(t: Tags): boolean {
  const hw = t.highway;
  if (hw !== 'footway' && hw !== 'cycleway' && hw !== 'path' && hw !== 'pedestrian' && hw !== 'bridleway') return false;
  if (t.area === 'yes' || (t.bridge && t.bridge !== 'no') || (t.tunnel && t.tunnel !== 'no') || t.covered === 'yes' || t.indoor === 'yes') return false;
  if (Number(t.layer ?? 0) !== 0 || t.footway === 'traffic_island') return false;
  const s = t.surface ?? '';
  return !/grass|wood|metal|grass_paver|stepping_stones/.test(s);
}

/** The width of a path (m). */
export function pathWidth(t: Tags): number {
  const w = num(t.width ?? t.est_width);
  if (w >= 0.6 && w <= 8) return w;
  if (t.highway === 'path') {
    const shared = (t.bicycle === 'designated' || t.bicycle === 'yes') && (t.foot === 'designated' || t.foot === 'yes');
    return shared ? 2.5 : 1.5;
  }
  return WIDTHS[t.highway] ?? 2.0;
}

/** The ground material of a path from its surface (`built`: it lies in built-up land). */
export function pathMaterial(t: Tags, built: boolean): number {
  const s = t.surface;
  if (s) {
    if (/^asphalt|^chipseal/.test(s)) return GM.ASPHALT_OLD;
    if (/^concrete:plates|paving_stones|^paved$|bricks?|tiles/.test(s)) return GM.PAVING;
    if (/sett|cobblestone|unhewn|pebblestone/.test(s)) return GM.SETT;
    if (/^concrete/.test(s)) return GM.CONCRETE;
    if (/compacted|fine_gravel/.test(s)) return GM.PATH;
    if (/gravel|rock|stone/.test(s)) return GM.GRAVEL;
    if (/ground|dirt|earth|mud|sand|unpaved|soil/.test(s)) return GM.DIRT;
  }
  if (t.highway === 'cycleway') return GM.ASPHALT_OLD;
  if (t.highway === 'pedestrian' || t.highway === 'footway') return built ? GM.PAVING : GM.PATH;
  // (a plain path without a surface is rarely paved, also in town – through a park, under trees; a shared foot and cycle path is)
  if (t.highway === 'path' && t.bicycle !== 'designated') return GM.PATH;
  return built ? GM.ASPHALT_OLD : GM.PATH;
}

export interface PathStats {
  ways: number;
  km: number;
}

const BUILT = new Set<number>([COVER.RESIDENTIAL, COVER.COMMERCIAL, COVER.INDUSTRIAL, COVER.PAVED, COVER.ASPHALT, COVER.ALLOTMENT, COVER.CEMETERY]);

/**
 * Draw the paths into the tiles (`ground` mesh) and mark their cells in
 * `occupied` (the 2 m raster of the cover map: no scattered tree there).
 */
export function addPaths(
  osm: OsmData,
  world: World,
  cover: CoverMap,
  terrain: TerrainGrid,
  ts: TileSet,
  inWorld: (x: number, z: number) => boolean,
  occupied: Uint8Array,
  /** only the ways this says yes to (by their points, flat x, z: the detail region – mapgen/detailregion.ts) */
  keep?: (pts: number[]) => boolean,
): PathStats {
  const stats: PathStats = { ways: 0, km: 0 };
  const hit = newSurfaceHit();
  const onRoad = (x: number, z: number): boolean => {
    const g = terrain.at(x, z);
    return world.surfaceAt(x, z, g + 1, hit) && Math.abs(hit.y - g) < 3;
  };
  for (const w of osm.ways) {
    const t = w.tags;
    if (!isDrawnPath(t)) continue;
    const c = osm.wayCoords(w);
    if (c.length < 4 || (isClosedWay(w) && t.highway === 'pedestrian')) continue;
    if (keep && !keep(c)) continue;
    const width = pathWidth(t);
    const half = width / 2;
    const sidewalk = t.footway === 'sidewalk' || t.cycleway === 'sidewalk';
    // stations along the way every STEP metres (and at its corners)
    const pts: number[] = [];
    for (let i = 0; i + 3 < c.length; i += 2) {
      const l = Math.hypot(c[i + 2] - c[i], c[i + 3] - c[i + 1]);
      const k = Math.max(1, Math.ceil(l / STEP));
      if (i === 0) pts.push(c[0], c[1]);
      for (let j = 1; j <= k; j++) pts.push(c[i] + ((c[i + 2] - c[i]) * j) / k, c[i + 1] + ((c[i + 3] - c[i + 1]) * j) / k);
    }
    const n = pts.length / 2;
    if (n < 2) continue;
    const mid = Math.floor(n / 2) * 2;
    const mat = pathMaterial(t, BUILT.has(cover.at(pts[mid], pts[mid + 1])));
    // both edges of the strip (mitred at the corners), and which points may be drawn
    const L: number[] = [];
    const R: number[] = [];
    const ok: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let tx = pts[b * 2] - pts[a * 2];
      let tz = pts[b * 2 + 1] - pts[a * 2 + 1];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      const x = pts[i * 2];
      const z = pts[i * 2 + 1];
      const lx = x + tz * half;
      const lz = z - tx * half;
      const rx = x - tz * half;
      const rz = z + tx * half;
      L.push(lx, terrain.at(lx, lz) + LIFT, lz);
      R.push(rx, terrain.at(rx, rz) + LIFT, rz);
      ok.push(inWorld(x, z) && !onRoad(x, z) && !(sidewalk && (onRoad(lx, lz) || onRoad(rx, rz))));
    }
    // runs of pieces with both ends free
    let drawn = false;
    let i = 0;
    while (i < n - 1) {
      if (!ok[i] || !ok[i + 1]) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j + 1 < n && ok[j + 1]) j++;
      addBand(ts, 'ground', L.slice(i * 3, (j + 1) * 3), R.slice(i * 3, (j + 1) * 3), [mat]);
      for (let k = i; k < j; k++) stats.km += Math.hypot(pts[k * 2 + 2] - pts[k * 2], pts[k * 2 + 3] - pts[k * 2 + 1]) / 1000;
      for (let k = i; k <= j; k++) markCells(occupied, cover, pts[k * 2], pts[k * 2 + 1], half + 1);
      drawn = true;
      i = j;
    }
    if (drawn) stats.ways++;
  }
  return stats;
}

/** Mark the cells of the cover raster within `r` of a point. */
function markCells(mask: Uint8Array, cover: CoverMap, x: number, z: number, r: number): void {
  const c = cover.cell;
  const i0 = Math.max(0, Math.floor((x - r - cover.minX) / c));
  const i1 = Math.min(cover.w - 1, Math.floor((x + r - cover.minX) / c));
  const j0 = Math.max(0, Math.floor((z - r - cover.minZ) / c));
  const j1 = Math.min(cover.h - 1, Math.floor((z + r - cover.minZ) / c));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) mask[j * cover.w + i] = 1;
}
