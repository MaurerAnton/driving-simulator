// SPDX-License-Identifier: AGPL-3.0-only
/** Vegetation, street lamps, barriers, railway tracks, place names and start points. */
import { hash01, newPolySample, ringArea, samplePolyline } from '../../src/core/geom.ts';
import { COVER } from '../../src/world/cover.ts';
import { ACCESS, CLS, EF, KERB_H } from '../../src/world/types.ts';
import type { PlaceJson, SpawnJson } from '../../src/world/types.ts';
import { newSurfaceHit } from '../../src/world/world.ts';
import type { World } from '../../src/world/world.ts';
import { CoverMap } from './cover.ts';
import { addBand } from './meshacc.ts';
import type { TileSet } from './meshacc.ts';
import type { OsmData } from './osm.ts';
import { isClosedWay } from './osm.ts';
import type { TerrainGrid } from './terrain.ts';

const tmp = newPolySample();

/** 2 m raster of building footprints, grown by one cell. */
export function buildingMask(ts: TileSet, cover: CoverMap): Uint8Array {
  const mask = new Uint8Array(cover.w * cover.h);
  for (const t of ts.tiles.values()) {
    let p = 0;
    for (const n of t.collCnt) {
      const ring = t.collPts.slice(p, p + n * 2);
      p += n * 2;
      CoverMap.fillGrid([ring], mask, cover.w, cover.h, cover.minX, cover.minZ, cover.cell, 1);
    }
  }
  const src = mask.slice();
  const w = cover.w;
  for (let i = w + 1; i < mask.length - w - 1; i++) {
    if (!src[i] && (src[i - 1] || src[i + 1] || src[i - w] || src[i + w])) mask[i] = 1;
  }
  return mask;
}

export interface VegetationStats {
  mapped: number;
  rows: number;
  forest: number;
  garden: number;
}

/** Tree kinds: 0 broadleaf, 1 conifer, 2 bush, 3 small ornamental. */
export function addVegetation(
  osm: OsmData,
  world: World,
  cover: CoverMap,
  terrain: TerrainGrid,
  ts: TileSet,
  bmask: Uint8Array,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): VegetationStats {
  const stats: VegetationStats = { mapped: 0, rows: 0, forest: 0, garden: 0 };
  const hit = newSurfaceHit();
  const occupied = (x: number, z: number): boolean => {
    const ix = Math.floor((x - cover.minX) / cover.cell);
    const iz = Math.floor((z - cover.minZ) / cover.cell);
    if (ix < 0 || iz < 0 || ix >= cover.w || iz >= cover.h) return true;
    return bmask[iz * cover.w + ix] !== 0;
  };
  const put = (x: number, z: number, height: number, kind: number, clearance: number): boolean => {
    if (x < bounds.minX + 1 || x > bounds.maxX - 1 || z < bounds.minZ + 1 || z > bounds.maxZ - 1) return false;
    if (occupied(x, z)) return false;
    if (world.nearestRoad(x, z, clearance + 1, 0, hit) && hit.off < clearance) return false;
    const y = terrain.at(x, z);
    ts.at(x, z).trees.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(z * 10) / 10, Math.round(height * 10) / 10, kind);
    return true;
  };

  for (const n of osm.nodes.values()) {
    if (n.tags?.natural !== 'tree') continue;
    const conifer = n.tags.leaf_type === 'needleleaved';
    const h = Number.parseFloat(n.tags.height ?? '') || 7 + hash01(n.id) * 8;
    if (put(n.x, n.z, Math.min(28, h), conifer ? 1 : 0, 0.6)) stats.mapped++;
  }
  for (const w of osm.ways) {
    if (w.tags.natural !== 'tree_row') continue;
    const c = osm.wayCoords(w);
    let carry = 4;
    for (let i = 0; i + 3 < c.length; i += 2) {
      const l = Math.hypot(c[i + 2] - c[i], c[i + 3] - c[i + 1]);
      let d = carry;
      while (d < l) {
        const t = d / l;
        const x = c[i] + (c[i + 2] - c[i]) * t;
        const z = c[i + 1] + (c[i + 3] - c[i + 1]) * t;
        if (put(x, z, 8 + hash01(Math.round(x * 31 + z * 17)) * 6, 0, 0.6)) stats.rows++;
        d += 9.5;
      }
      carry = d - l;
    }
  }

  // scatter by ground cover on a jittered grid
  const G = 9;
  for (let gz = bounds.minZ; gz < bounds.maxZ; gz += G) {
    for (let gx = bounds.minX; gx < bounds.maxX; gx += G) {
      const seed = Math.round(gx * 7919 + gz * 104729);
      const x = gx + hash01(seed) * G;
      const z = gz + hash01(seed + 1) * G;
      const c = cover.at(x, z);
      const r = hash01(seed + 2);
      const r2 = hash01(seed + 3);
      if (c === COVER.FOREST) {
        // stands of conifers inside mostly broadleaf woodland
        const stand = hash01(Math.round(gx / 140) * 131 + Math.round(gz / 140) * 197);
        const kind = stand < 0.32 ? 1 : r2 < 0.12 ? 1 : 0;
        if (r < 0.82 && put(x, z, 14 + r2 * 11, kind, 3.2)) stats.forest++;
      } else if (c === COVER.SCRUB) {
        if (r < 0.6 && put(x, z, 2.2 + r2 * 3.5, r2 < 0.75 ? 2 : 0, 2.5)) stats.forest++;
      } else if (c === COVER.ORCHARD) {
        if (r < 0.8 && put(x, z, 4 + r2 * 2, 3, 2.5)) stats.garden++;
      } else if (c === COVER.RESIDENTIAL || c === COVER.ALLOTMENT) {
        if (r < 0.14 && put(x, z, 4.5 + r2 * 6, r2 < 0.2 ? 1 : r2 < 0.55 ? 3 : 0, 2.2)) stats.garden++;
        else if (r > 0.9 && put(x, z, 1.4 + r2 * 1.2, 2, 2.0)) stats.garden++;
      } else if (c === COVER.GRASS || c === COVER.CEMETERY) {
        if (r < 0.07 && put(x, z, 8 + r2 * 8, r2 < 0.15 ? 1 : 0, 2.5)) stats.garden++;
      }
    }
  }
  return stats;
}

/** Street lamps along lit streets (plus the few mapped individually). */
export function addLamps(osm: OsmData, world: World, terrain: TerrainGrid, ts: TileSet): number {
  let count = 0;
  for (const e of world.edges) {
    if (!(e.flags & EF.LIT) || !(e.flags & EF.URBAN) || e.tier < 2 || e.flags & (EF.BRIDGE | EF.TUNNEL)) continue;
    const s0 = e.cutA + 6;
    const s1 = e.len - e.cutB - 6;
    if (s1 - s0 < 10) continue;
    const spacing = e.tier >= 3 ? 34 : 40;
    const first = s0 + hash01(e.id * 17 + 3) * Math.min(spacing, s1 - s0);
    const side = hash01(e.id * 5 + 1) < 0.5 ? 1 : -1;
    for (let s = first; s < s1; s += spacing) {
      samplePolyline(e.pl, s, tmp);
      const sw = side > 0 ? e.swL : e.swR;
      const out = e.width / 2 + (sw > 0 ? Math.max(0.35, sw - 0.3) : 1.3);
      const x = tmp.x + tmp.tz * out * side;
      const z = tmp.z - tmp.tx * out * side;
      const y = world.edgeY(e, s, x, z) + (sw > 0 ? KERB_H : -0.15);
      // the arm reaches over the road: yaw points from the pole to the carriageway
      const yaw = Math.atan2(tmp.tz * side, -tmp.tx * side);
      ts.at(x, z).objects.push({ k: 'lamp', x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100, yaw: Math.round(yaw * 100) / 100 });
      count++;
    }
  }
  void osm;
  void terrain;
  return count;
}

/** Walls, hedges, guard rails as low extrusions; railway tracks as rails on ballast. */
export function addBarriersAndRails(osm: OsmData, world: World, cover: CoverMap, terrain: TerrainGrid, ts: TileSet, inWorld: (x: number, z: number) => boolean): { barriers: number; railKm: number; guardKm: number } {
  const hit = newSurfaceHit();
  let barriers = 0;
  let railKm = 0;
  let guardKm = 0;

  /** Box strip along a polyline: `yAt` gives the foot height. */
  const strip = (
    pts: number[],
    halfW: number,
    y0: number,
    y1: number,
    color: number[],
    yAt: (x: number, z: number) => number,
    collide: boolean,
  ): void => {
    const n = pts.length / 2;
    if (n < 2) return;
    const L0: number[] = [];
    const L1: number[] = [];
    const R0: number[] = [];
    const R1: number[] = [];
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
      const y = yAt(x, z);
      L0.push(x + tz * halfW, y + y0, z - tx * halfW);
      L1.push(x + tz * halfW, y + y1, z - tx * halfW);
      R0.push(x - tz * halfW, y + y0, z + tx * halfW);
      R1.push(x - tz * halfW, y + y1, z + tx * halfW);
      if (collide && i > 0) {
        ts.at(x, z).collSeg.push(pts[i * 2 - 2], pts[i * 2 - 1], x, z, y);
      }
    }
    // sides face outwards; choose the hint from the first segment
    const tx = pts[2] - pts[0];
    const tz = pts[3] - pts[1];
    addBand(ts, 'struct', L0, L1, color, tz, 0, -tx);
    addBand(ts, 'struct', R0, R1, color, -tz, 0, tx);
    addBand(ts, 'struct', L1, R1, color, 0, 1, 0);
  };
  const densify = (c: number[], step: number): number[] => {
    const out: number[] = [c[0], c[1]];
    for (let i = 0; i + 3 < c.length; i += 2) {
      const l = Math.hypot(c[i + 2] - c[i], c[i + 3] - c[i + 1]);
      const k = Math.max(1, Math.ceil(l / step));
      for (let j = 1; j <= k; j++) out.push(c[i] + ((c[i + 2] - c[i]) * j) / k, c[i + 1] + ((c[i + 3] - c[i + 1]) * j) / k);
    }
    return out;
  };
  const clip = (c: number[]): number[][] => {
    // keep the runs that lie inside the simulated area
    const runs: number[][] = [];
    let cur: number[] = [];
    for (let i = 0; i < c.length; i += 2) {
      if (inWorld(c[i], c[i + 1])) cur.push(c[i], c[i + 1]);
      else {
        if (cur.length >= 4) runs.push(cur);
        cur = [];
      }
    }
    if (cur.length >= 4) runs.push(cur);
    return runs;
  };
  const ground = (x: number, z: number): number => terrain.at(x, z);

  for (const w of osm.ways) {
    const t = w.tags;
    if (t.barrier === 'wall' || t.barrier === 'retaining_wall' || t.barrier === 'city_wall') {
      for (const run of clip(densify(osm.wayCoords(w), 4))) strip(run, 0.14, -0.4, t.barrier === 'retaining_wall' ? 1.2 : 1.5, [176, 170, 160], ground, true);
      barriers++;
    } else if (t.barrier === 'hedge' || t.natural === 'hedge') {
      for (const run of clip(densify(osm.wayCoords(w), 4))) strip(run, 0.45, -0.3, 1.5, [58, 92, 44], ground, true);
      barriers++;
    } else if (t.barrier === 'guard_rail' || t.barrier === 'jersey_barrier') {
      for (const run of clip(densify(osm.wayCoords(w), 4))) strip(run, 0.06, 0.42, 0.78, [150, 155, 160], ground, true);
      barriers++;
    } else if ((t.railway === 'rail' || t.railway === 'tram' || t.railway === 'light_rail') && t.tunnel !== 'yes' && !isClosedWay(w)) {
      for (const run of clip(densify(osm.wayCoords(w), 4))) {
        if (t.bridge !== 'yes') cover.paintLine(run, 3.0, COVER.RAILWAY);
        const railY = (x: number, z: number): number => {
          const g = terrain.at(x, z);
          if (world.surfaceAt(x, z, g + 1.5, hit) && hit.zone === 0) return Math.max(g, hit.y - 0.11);
          return g;
        };
        for (const off of [-0.7175, 0.7175]) {
          const side: number[] = [];
          const n = run.length / 2;
          for (let i = 0; i < n; i++) {
            const a = Math.max(0, i - 1);
            const b = Math.min(n - 1, i + 1);
            let tx = run[b * 2] - run[a * 2];
            let tz = run[b * 2 + 1] - run[a * 2 + 1];
            const l = Math.hypot(tx, tz) || 1;
            tx /= l;
            tz /= l;
            side.push(run[i * 2] + tz * off, run[i * 2 + 1] - tx * off);
          }
          strip(side, 0.035, 0.0, 0.125, [92, 86, 82], railY, false);
        }
        for (let i = 2; i < run.length; i += 2) railKm += Math.hypot(run[i] - run[i - 2], run[i + 1] - run[i - 1]) / 1000;
      }
    }
  }

  // guard rails along motorways and their ramps (rarely mapped individually)
  for (const e of world.edges) {
    if (e.cls > CLS.TRUNK_LINK || e.flags & EF.BRIDGE) continue;
    const s0 = e.cutA + 2;
    const s1 = e.len - e.cutB - 2;
    if (s1 - s0 < 12) continue;
    for (const side of [1, -1]) {
      // ramps: only on the outside of bends would be nicer; keep both sides on the main carriageway
      if (e.cls !== CLS.MOTORWAY && side > 0) continue;
      const line: number[] = [];
      for (let s = s0; s <= s1; s += 4) {
        samplePolyline(e.pl, s, tmp);
        const out = e.width / 2 + 0.55;
        line.push(tmp.x + tmp.tz * out * side, tmp.z - tmp.tx * out * side);
      }
      strip(line, 0.05, 0.42, 0.78, [150, 155, 160], (x, z) => {
        samplePolyline(e.pl, 0, tmp);
        return world.nearestRoad(x, z, 3, 0, hit) ? hit.y : terrain.at(x, z);
      }, true);
      guardKm += (s1 - s0) / 1000;
    }
  }
  return { barriers, railKm, guardKm };
}

export function collectPlaces(osm: OsmData, inRect: (x: number, z: number) => boolean): PlaceJson[] {
  const out: PlaceJson[] = [];
  for (const n of osm.nodes.values()) {
    const t = n.tags;
    if (!t?.place || !t.name) continue;
    if (!['town', 'suburb', 'village', 'hamlet', 'neighbourhood', 'locality', 'isolated_dwelling'].includes(t.place)) continue;
    if (!inRect(n.x, n.z)) continue;
    out.push({ name: t.name, kind: t.place, x: Math.round(n.x), z: Math.round(n.z) });
  }
  return out;
}

/** Start points: one public car park per district, placed on its access aisle. */
export function collectSpawns(osm: OsmData, world: World, terrain: TerrainGrid, places: PlaceJson[], inWorld: (x: number, z: number) => boolean): SpawnJson[] {
  interface Lot {
    x: number;
    z: number;
    area: number;
    name: string;
  }
  const lots: Lot[] = [];
  for (const w of osm.ways) {
    const t = w.tags;
    if (t.amenity !== 'parking' || !isClosedWay(w)) continue;
    if (t.access === 'private' || t.access === 'no' || t.parking === 'underground' || t.parking === 'multi-storey') continue;
    const ring = osm.wayCoords(w);
    ring.length -= 2;
    const area = Math.abs(ringArea(ring));
    if (area < 500) continue;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < ring.length; i += 2) {
      cx += ring[i];
      cz += ring[i + 1];
    }
    cx /= ring.length / 2;
    cz /= ring.length / 2;
    if (!inWorld(cx, cz)) continue;
    lots.push({ x: cx, z: cz, area, name: t.name ?? '' });
  }
  const hit = newSurfaceHit();
  const spawns: SpawnJson[] = [];
  const used = new Set<Lot>();
  const districts = places.filter((p) => ['town', 'suburb', 'village'].includes(p.kind));
  // the town itself first
  districts.sort((a, b) => (a.kind === 'town' ? -1 : 0) - (b.kind === 'town' ? -1 : 0));
  for (const p of districts) {
    let best: Lot | null = null;
    let bestScore = Infinity;
    for (const l of lots) {
      if (used.has(l)) continue;
      const d = Math.hypot(l.x - p.x, l.z - p.z);
      if (d > 900) continue;
      const score = d - Math.min(l.area, 4000) * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = l;
      }
    }
    if (!best) continue;
    const y = terrain.at(best.x, best.z);
    if (!world.locate(best.x, best.z, y, 60, hit) || !hit.edge) continue;
    const e = hit.edge;
    if (e.access === ACCESS.PRIVATE) continue;
    used.add(best);
    const s = Math.max(e.cutA + 3, Math.min(e.len - e.cutB - 3, hit.s));
    samplePolyline(e.pl, s, tmp);
    // keep right on two-way aisles
    const off = e.lanesB > 0 ? -e.width / 4 : 0;
    spawns.push({
      name: `${p.name}${best.name ? ` – ${best.name}` : ' – Parkplatz'}`,
      x: Math.round((tmp.x + tmp.tz * off) * 100) / 100,
      z: Math.round((tmp.z - tmp.tx * off) * 100) / 100,
      yaw: Math.round(Math.atan2(-tmp.tx, -tmp.tz) * 1000) / 1000,
      kind: 'parking',
    });
  }
  return spawns;
}
