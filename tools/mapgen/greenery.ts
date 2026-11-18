// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trees and hedges seen on the official aerial photographs where
 * OpenStreetMap has none: tools/mapgen/observed-greenery.json
 * (OBSERVED_GREENERY=<file> reads another, "none" none at all).
 *
 *   { "about": "…",
 *     "trees":  [{ "kind": "wood" | "group" | "row", "pts": [[x, z], …],
 *                  "density": "dense" | "medium" | "sparse",
 *                  "height": "small" | "medium" | "large",
 *                  "leaf": "broadleaf" | "conifer" | "mixed", "note": "…" }],
 *     "hedges": [{ "pts": [[x, z], …], "height_m": 1.6, "note": "…" }] }
 *
 * World metres (x east, z south).  A wood or group is an area (its outline,
 * not closed) filled with trees on a jittered grid – every 6.5 m where it is
 * dense, 9 m medium, 13 m sparse; a row is a line of trees every 9 m.
 * Broadleaf trees unless `leaf` says otherwise: "conifer" all conifers,
 * "mixed" about a quarter of them (the aerial photographs of the town show
 * broadleaf trees nearly everywhere; scattered conifers stood out as wrong).  Heights by class: small 6–10 m,
 * medium 10–16 m, large 15–25 m (the renderer gives broadleaf crowns their
 * real width from the height: src/render/props.ts).  No tree on a road, its
 * pavement, a path or a building, nor where the cover is wood already (its
 * own trees stand there).  Hedges are drawn like the hedges seen beside
 * buildings (objects.ts, facadedetail.ts: observed barriers), `height_m`
 * high (default 1.4 m).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pointInRing } from '../../src/core/geom.ts';
import { COVER } from '../../src/world/cover.ts';
import { newSurfaceHit } from '../../src/world/world.ts';
import type { World } from '../../src/world/world.ts';
import type { CoverMap } from './cover.ts';
import type { ObservedBarrier } from './facadedetail.ts';
import type { TileSet } from './meshacc.ts';
import { mix01 } from './parking.ts';
import type { TerrainGrid } from './terrain.ts';

export interface GreenTrees {
  kind: 'wood' | 'group' | 'row';
  /** flat x, z */
  pts: number[];
  spacing: number;
  /** height range (m) */
  h0: number;
  h1: number;
  /** the share of conifers (0 broadleaf … 1 conifer) */
  conifers: number;
}

const LEAF: Record<string, number> = { broadleaf: 0, conifer: 1, mixed: 0.25 };

export interface Greenery {
  trees: GreenTrees[];
  hedges: ObservedBarrier[];
}

const DEFAULT_FILE = fileURLToPath(new URL('./observed-greenery.json', import.meta.url));
const SPACING: Record<string, number> = { dense: 6.5, medium: 9, sparse: 13 };
const HEIGHTS: Record<string, [number, number]> = { small: [6, 10], medium: [10, 16], large: [15, 25] };

function flat(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1]))) return null;
    out.push(Number(p[0]), Number(p[1]));
  }
  return out;
}

/** The greenery of `file`. */
export function loadGreenery(file = process.env.OBSERVED_GREENERY ?? DEFAULT_FILE): Greenery {
  const out: Greenery = { trees: [], hedges: [] };
  if (file === 'none' || !existsSync(file)) return out;
  const j = JSON.parse(readFileSync(file, 'utf8')) as {
    trees?: Array<{ kind?: string; pts?: unknown; density?: string; height?: string; leaf?: string }>;
    hedges?: Array<{ pts?: unknown; height_m?: unknown }>;
  };
  for (const t of j.trees ?? []) {
    const kind = t?.kind === 'wood' || t?.kind === 'group' || t?.kind === 'row' ? t.kind : null;
    let pts = flat(t?.pts);
    if (!kind || !pts) continue;
    // (an outline given closed: its last point is its first)
    if (kind !== 'row' && pts.length >= 4 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts = pts.slice(0, -2);
    if (pts.length < (kind === 'row' ? 4 : 6)) continue;
    const [h0, h1] = HEIGHTS[t.height ?? ''] ?? HEIGHTS.medium;
    out.trees.push({ kind, pts, spacing: kind === 'row' ? 9 : (SPACING[t.density ?? ''] ?? SPACING.medium), h0, h1, conifers: LEAF[t.leaf ?? ''] ?? 0 });
  }
  for (const h of j.hedges ?? []) {
    const pts = flat(h?.pts);
    if (!pts || pts.length < 4) continue;
    const hm = Number(h.height_m);
    out.hedges.push({ kind: 'hedge', h: hm > 0.3 && hm < 6 ? hm : 1.4, pts });
  }
  return out;
}

let cached: Greenery | null = null;
let cachedFrom = '';

/** The greenery as the map build uses it (read once per file). */
export function greenery(): Greenery {
  const file = process.env.OBSERVED_GREENERY ?? DEFAULT_FILE;
  if (!cached || cachedFrom !== file) {
    cached = loadGreenery(file);
    cachedFrom = file;
  }
  return cached;
}

export interface GreeneryStats {
  trees: number;
}

/** Plant the trees of the areas and rows (build-tiles, after the trees of the ground cover). */
export function addGreenery(
  world: World,
  cover: CoverMap,
  terrain: TerrainGrid,
  ts: TileSet,
  occupied: (x: number, z: number) => boolean,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  list: Greenery = greenery(),
  /** only the areas and rows this says yes to (by their points, flat x, z: the detail region – mapgen/detailregion.ts) */
  keep?: (pts: number[], row: boolean) => boolean,
): GreeneryStats {
  const stats: GreeneryStats = { trees: 0 };
  const hit = newSurfaceHit();
  const put = (x: number, z: number, h: number, kind: number): void => {
    if (x < bounds.minX + 1 || x > bounds.maxX - 1 || z < bounds.minZ + 1 || z > bounds.maxZ - 1) return;
    if (occupied(x, z) || cover.at(x, z) === COVER.FOREST) return;
    if (world.nearestRoad(x, z, 2.5, 0, hit) && hit.off < 1.5) return;
    const y = terrain.at(x, z);
    if (Number.isNaN(y)) return;
    ts.at(x, z).trees.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(z * 10) / 10, Math.round(h * 10) / 10, kind);
    stats.trees++;
  };
  list.trees.forEach((g, gi) => {
    const p = g.pts;
    if (keep && !keep(p, g.kind === 'row')) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      minX = Math.min(minX, p[i]);
      maxX = Math.max(maxX, p[i]);
      minZ = Math.min(minZ, p[i + 1]);
      maxZ = Math.max(maxZ, p[i + 1]);
    }
    if (maxX < bounds.minX || minX > bounds.maxX || maxZ < bounds.minZ || minZ > bounds.maxZ) return;
    if (g.kind === 'row') {
      let carry = g.spacing / 2;
      let k = 0;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const l = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
        let d = carry;
        for (; d < l; d += g.spacing) {
          const t = d / l;
          const kind = mix01(gi, k, 4) < g.conifers ? 1 : 0;
          put(p[i] + (p[i + 2] - p[i]) * t, p[i + 1] + (p[i + 3] - p[i + 1]) * t, g.h0 + (g.h1 - g.h0) * mix01(gi, k++, 3), kind);
        }
        carry = d - l;
      }
      return;
    }
    // a jittered grid fixed to the world (the same trees in every block that holds the area)
    const G = g.spacing;
    for (let gz = Math.floor(minZ / G) * G; gz <= maxZ; gz += G) {
      for (let gx = Math.floor(minX / G) * G; gx <= maxX; gx += G) {
        const cx = Math.round(gx / G);
        const cz = Math.round(gz / G);
        const x = gx + G * (0.15 + 0.7 * mix01(cx, cz, gi, 1));
        const z = gz + G * (0.15 + 0.7 * mix01(cx, cz, gi, 2));
        if (!pointInRing(x, z, p)) continue;
        const r = mix01(cx, cz, gi, 4);
        put(x, z, g.h0 + (g.h1 - g.h0) * mix01(cx, cz, gi, 3), r < g.conifers ? 1 : 0);
      }
    }
  });
  return stats;
}
