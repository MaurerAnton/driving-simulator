// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The tracks trams and trains run on, as paths for the game: every tram,
 * light-rail and railway line of OpenStreetMap inside the map, cut at its
 * switches, with the heights of the rails that are drawn (see objects.ts),
 * the stops along it and which pieces join which.
 *
 * The meshes of the rails are made in objects.ts; this is the same geometry
 * once more as a network a vehicle can follow.
 */
import type { RailJson } from '../../src/world/types.ts';
import { RAIL } from '../../src/world/types.ts';
import { newSurfaceHit } from '../../src/world/world.ts';
import type { World } from '../../src/world/world.ts';
import type { OsmData, OWay, Tags } from './osm.ts';
import { isClosedWay } from './osm.ts';
import type { TerrainGrid } from './terrain.ts';

/** distance between the points of a path (m) */
const STEP = 6;

const kindOf = (t: Tags): number => (t.railway === 'tram' ? RAIL.TRAM : t.railway === 'light_rail' ? RAIL.LIGHT : t.railway === 'rail' ? RAIL.TRAIN : -1);

/** Sidings, depots and yards have no passenger service: nothing runs there in the game. */
const inService = (t: Tags): boolean => t.tunnel !== 'yes' && !['yard', 'siding', 'spur', 'crossover'].includes(t.service ?? '') && t.usage !== 'industrial' && t.usage !== 'military';

const isStop = (t: Tags | null): boolean =>
  !!t && (t.railway === 'tram_stop' || t.railway === 'halt' || t.railway === 'station' || t.railway === 'stop' || (t.public_transport === 'stop_position' && (t.tram === 'yes' || t.light_rail === 'yes' || t.train === 'yes')));

export function collectRails(osm: OsmData, world: World, terrain: TerrainGrid, inWorld: (x: number, z: number) => boolean): { rails: RailJson[]; km: number[]; stops: number } {
  const hit = newSurfaceHit();
  // top of the rail as drawn: on the ground, or sunk into the road it runs in
  const railY = (x: number, z: number): number => {
    const g = terrain.at(x, z);
    const y = world.surfaceAt(x, z, g + 1.5, hit) && hit.zone === 0 ? Math.max(g, hit.y - 0.11) : g;
    return y + 0.125;
  };

  const ways: OWay[] = osm.ways.filter((w) => kindOf(w.tags) >= 0 && inService(w.tags) && !isClosedWay(w) && w.refs.length >= 2);
  // how many tracks meet at a node: where two or more do, a track is cut (a switch, a crossing, the end of a way)
  const uses = new Map<number, number>();
  for (const w of ways) {
    w.refs.forEach((r, i) => {
      // an end counts once, a node in the middle twice (the track goes on to both sides)
      uses.set(r, (uses.get(r) ?? 0) + (i === 0 || i === w.refs.length - 1 ? 1 : 2));
    });
  }

  interface Piece {
    kind: number;
    /** OSM node at each end, -1 where the piece was cut by the edge of the map */
    from: number;
    to: number;
    pts: number[];
    stops: number[];
  }
  const pieces: Piece[] = [];
  const km = [0, 0, 0];
  let stops = 0;

  for (const w of ways) {
    const kind = kindOf(w.tags);
    let start = 0;
    for (let i = 1; i < w.refs.length; i++) {
      const last = i === w.refs.length - 1;
      // cut where another track joins or crosses (use count above what this way alone accounts for)
      if (!last && (uses.get(w.refs[i]) ?? 0) <= 2) continue;
      const refs = w.refs.slice(start, i + 1);
      start = i;
      // coordinates, with the stops' places along the way
      const xz: number[] = [];
      const stopAt: number[] = [];
      let len = 0;
      let complete = true;
      for (const r of refs) {
        const n = osm.nodes.get(r);
        if (!n) {
          complete = false;
          continue;
        }
        if (xz.length >= 2) len += Math.hypot(n.x - xz[xz.length - 2], n.z - xz[xz.length - 1]);
        xz.push(n.x, n.z);
        if (isStop(n.tags)) stopAt.push(len);
      }
      if (xz.length < 4) continue;
      // a point every few metres, runs inside the map only
      let cur: number[] = [];
      let curStart = 0;
      let curEnd = 0;
      let along = 0;
      let firstRun = true;
      const flush = (endsAtNode: boolean): void => {
        if (cur.length >= 6) {
          const runLen = curEnd - curStart;
          pieces.push({
            kind,
            from: firstRun && complete && curStart === 0 ? refs[0] : -1,
            to: endsAtNode && complete ? refs[refs.length - 1] : -1,
            pts: cur,
            stops: stopAt.filter((s) => s >= curStart - 1 && s <= curEnd + 1).map((s) => Math.round(Math.min(runLen, Math.max(0, s - curStart)))),
          });
          km[kind] += runLen / 1000;
        }
        firstRun = false;
        cur = [];
      };
      const push = (x: number, z: number): void => {
        if (inWorld(x, z)) {
          if (cur.length === 0) curStart = along;
          curEnd = along;
          cur.push(Math.round(x * 10) / 10, Math.round(railY(x, z) * 100) / 100, Math.round(z * 10) / 10);
        } else flush(false);
      };
      push(xz[0], xz[1]);
      for (let k = 0; k + 3 < xz.length; k += 2) {
        const l = Math.hypot(xz[k + 2] - xz[k], xz[k + 3] - xz[k + 1]);
        const steps = Math.max(1, Math.ceil(l / STEP));
        for (let j = 1; j <= steps; j++) {
          along += l / steps;
          push(xz[k] + ((xz[k + 2] - xz[k]) * j) / steps, xz[k + 1] + ((xz[k + 3] - xz[k + 1]) * j) / steps);
        }
      }
      flush(true);
    }
  }

  // which pieces meet at a node: each end lists the others as index * 2 + (0: their start is here, 1: their end)
  const at = new Map<number, number[]>();
  pieces.forEach((p, i) => {
    if (p.from >= 0) at.set(p.from, [...(at.get(p.from) ?? []), i * 2]);
    if (p.to >= 0) at.set(p.to, [...(at.get(p.to) ?? []), i * 2 + 1]);
  });
  const rails: RailJson[] = pieces.map((p, i) => {
    const r: RailJson = { k: p.kind, p: p.pts, a: p.from >= 0 ? (at.get(p.from) ?? []).filter((v) => v !== i * 2) : [], b: p.to >= 0 ? (at.get(p.to) ?? []).filter((v) => v !== i * 2 + 1) : [] };
    if (p.stops.length) {
      r.st = p.stops;
      stops += p.stops.length;
    }
    return r;
  });
  return { rails, km, stops };
}
