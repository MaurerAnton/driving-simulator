// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Woodland and scrub right up to the road.  The trees of the ground cover
 * (objects.ts: addVegetation) are scattered on a grid of 9 m and keep 3.2 m
 * (scrub 2.5 m) from every road, so a wood mapped up to the road reads as a
 * lawn with trees behind it.  Here a row of trees (in a wood) or shrubs (in
 * scrub) is set along each side of a road where the cover beside its verge
 * is wood or scrub – mapped (landuse=forest, natural=wood | scrub) or added
 * as an area of tools/mapgen/observed-roads.json – 1.4 to 2.6 m beyond the
 * edge of the road and its pavement, every 5 to 8 m (not along tracks).
 */
import { newPolySample, samplePolyline } from '../../src/core/geom.ts';
import { COVER } from '../../src/world/cover.ts';
import { CLS, EF } from '../../src/world/types.ts';
import { newSurfaceHit } from '../../src/world/world.ts';
import type { Edge, World } from '../../src/world/world.ts';
import type { CoverMap } from './cover.ts';
import type { TileSet } from './meshacc.ts';
import { mix01 } from './parking.ts';
import type { TerrainGrid } from './terrain.ts';

const tmp = newPolySample();

export interface WoodEdgeStats {
  trees: number;
  shrubs: number;
}

/** Trees and shrubs along the roads where wood or scrub reaches their verge. */
export function addWoodEdges(
  world: World,
  cover: CoverMap,
  terrain: TerrainGrid,
  ts: TileSet,
  occupied: (x: number, z: number) => boolean,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  /** only along these roads (the detail region – mapgen/detailregion.ts) */
  only?: (e: Edge) => boolean,
): WoodEdgeStats {
  const stats: WoodEdgeStats = { trees: 0, shrubs: 0 };
  const hit = newSurfaceHit();
  for (const e of world.edges) {
    // (not along tracks: a forest track has no verge to speak of, its trees stand as the wood's)
    if (!e || e.flags & (EF.BRIDGE | EF.TUNNEL) || e.cls === CLS.TRACK) continue;
    if (only && !only(e)) continue;
    const s0 = e.cutA + 2;
    const s1 = e.len - e.cutB - 2;
    if (s1 - s0 < 4) continue;
    for (const side of [1, -1] as const) {
      const edgeOff = e.width / 2 + (side > 0 ? e.swL : e.swR);
      let k = 0;
      for (let s = s0 + 4 * mix01(e.osm, e.id, side, 1); s < s1; s += 5 + 3 * mix01(e.osm, e.id, side, k, 2)) {
        k++;
        const out = edgeOff + 1.4 + 1.2 * mix01(e.osm, e.id, side, k, 3);
        samplePolyline(e.pl, s, tmp);
        const x = tmp.x + tmp.tz * out * side;
        const z = tmp.z - tmp.tx * out * side;
        if (x < bounds.minX + 1 || x > bounds.maxX - 1 || z < bounds.minZ + 1 || z > bounds.maxZ - 1) continue;
        // wood or scrub here and a little further out (not a stray cell of it)
        const c = cover.at(x, z);
        if (c !== COVER.FOREST && c !== COVER.SCRUB) continue;
        const fx = x + tmp.tz * 2 * side;
        const fz = z - tmp.tx * 2 * side;
        if (cover.at(fx, fz) !== c) continue;
        if (occupied(x, z)) continue;
        // clear of every road and its pavement (another road may pass nearer than this one)
        if (world.nearestRoad(x, z, 2, 0, hit) && hit.off < 1.2) continue;
        const y = terrain.at(x, z);
        if (Number.isNaN(y)) continue;
        const r = mix01(e.osm, e.id, side, k, 4);
        const forest = c === COVER.FOREST;
        const h = forest ? 11 + 10 * r : 2 + 2.5 * r;
        const kind = forest ? (r < 0.2 ? 1 : 0) : r < 0.8 ? 2 : 0;
        ts.at(x, z).trees.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(z * 10) / 10, Math.round(h * 10) / 10, kind);
        if (forest) stats.trees++;
        else stats.shrubs++;
      }
    }
  }
  return stats;
}
