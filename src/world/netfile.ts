// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The road network of the whole map as one small file (map/net.bin.gz): what
 * a route planner needs of every road – where it is, how long, how fast,
 * what may be turned into at its ends – and its course in a few points, for
 * drawing the map.  The roads themselves, with their lanes and junctions,
 * come in chunks around the car (world.ts); this file is what lets a route
 * or a tour be planned through parts of the map that are not loaded.
 *
 * Written by the map build (tools/build-graph.ts), read by the game.
 */
import type { RouteGraph } from './routegraph.ts';
import { packSections, unpackSections } from './tilefmt.ts';
import type { SectionInfo } from './tilefmt.ts';

export interface NetData {
  /** junctions: where they are */
  nodeX: Float32Array;
  nodeZ: Float32Array;
  /** roads: the junctions at their ends, their length (m) and class */
  edgeA: Uint32Array;
  edgeB: Uint32Array;
  edgeLen: Float32Array;
  edgeCls: Uint8Array;
  /** ways (road * 2 + direction, see routegraph.ts): RG bits, and the speed allowed in km/h (0: not to be driven this way) */
  wayKind: Uint8Array;
  waySpeed: Uint8Array;
  /** the turns at the end of each way: first[w] … first[w + 1] - 1 index `to`, `turn` (TURN) and `across` (dm through the junction) */
  first: Uint32Array;
  to: Uint32Array;
  turn: Uint8Array;
  across: Uint16Array;
  /**
   * the course of each road between its ends: polyFirst[e] … polyFirst[e + 1] - 1
   * index pairs in `poly` – steps (east, south) in quarter metres from the
   * point before, starting at junction a
   */
  polyFirst: Uint32Array;
  poly: Int16Array;
}

/** quarter metres: the unit of the steps in NetData.poly */
export const POLY_UNIT = 0.25;

export function packNet(d: NetData): Uint8Array {
  return packSections({ v: 1, kind: 'net', nodes: d.nodeX.length, edges: d.edgeA.length }, d as unknown as Record<string, Uint8Array>);
}

export function unpackNet(buf: ArrayBuffer): NetData {
  const u = unpackSections<{ v: number; kind: string; sections: Record<string, SectionInfo> }>(buf);
  if (u.header.kind !== 'net') throw new Error('not a road-network file');
  const need = <T>(name: string): T => {
    const a = u.get(name);
    if (!a) throw new Error(`road-network file without "${name}"`);
    return a as unknown as T;
  };
  // (sections that have no entries are not stored)
  const opt = <T>(name: string, empty: T): T => (u.get(name) as unknown as T | null) ?? empty;
  return {
    nodeX: need('nodeX'),
    nodeZ: need('nodeZ'),
    edgeA: need('edgeA'),
    edgeB: need('edgeB'),
    edgeLen: need('edgeLen'),
    edgeCls: need('edgeCls'),
    wayKind: need('wayKind'),
    waySpeed: need('waySpeed'),
    first: need('first'),
    to: opt('to', new Uint32Array(0)),
    turn: opt('turn', new Uint8Array(0)),
    across: opt('across', new Uint16Array(0)),
    polyFirst: need('polyFirst'),
    poly: opt('poly', new Int16Array(0)),
  };
}

/** The network as the route planner searches it. */
export function routeGraphOfNet(d: NetData): RouteGraph {
  const E = d.edgeA.length;
  const n = E * 2;
  const g: RouteGraph = {
    n,
    len: new Float32Array(n),
    secs: new Float32Array(n),
    kind: d.wayKind,
    cls: new Uint8Array(n),
    x0: new Float32Array(n),
    z0: new Float32Array(n),
    x1: new Float32Array(n),
    z1: new Float32Array(n),
    first: d.first,
    to: d.to,
    turn: d.turn,
    across: Float32Array.from(d.across, (v) => v / 10),
    firstIn: new Uint32Array(n + 1),
    from: new Uint32Array(d.to.length),
    inTurn: new Uint32Array(d.to.length),
  };
  for (let e = 0; e < E; e++) {
    for (let dir = 0; dir < 2; dir++) {
      const w = e * 2 + dir;
      const a = dir === 0 ? d.edgeA[e] : d.edgeB[e];
      const b = dir === 0 ? d.edgeB[e] : d.edgeA[e];
      g.cls[w] = d.edgeCls[e];
      g.x0[w] = d.nodeX[a];
      g.z0[w] = d.nodeZ[a];
      g.x1[w] = d.nodeX[b];
      g.z1[w] = d.nodeZ[b];
      if (d.waySpeed[w] === 0) continue;
      g.len[w] = Math.max(0.5, d.edgeLen[e]);
      g.secs[w] = g.len[w] / Math.max(Math.min(d.waySpeed[w] / 3.6, 36), 2);
    }
  }
  const count = new Uint32Array(n + 1);
  for (let k = 0; k < g.to.length; k++) count[g.to[k] + 1]++;
  for (let w = 0; w < n; w++) count[w + 1] += count[w];
  g.firstIn.set(count);
  const fill = count.slice(0, n);
  for (let w = 0; w < n; w++) {
    for (let k = g.first[w]; k < g.first[w + 1]; k++) {
      const at = fill[g.to[k]]++;
      g.from[at] = w;
      g.inTurn[at] = k;
    }
  }
  return g;
}

/** The course of road `e`: x, z, x, z, … from junction a to junction b. */
export function netPolyline(d: NetData, e: number): number[] {
  let x = d.nodeX[d.edgeA[e]];
  let z = d.nodeZ[d.edgeA[e]];
  const out = [x, z];
  for (let k = d.polyFirst[e]; k < d.polyFirst[e + 1]; k++) {
    x += d.poly[k * 2] * POLY_UNIT;
    z += d.poly[k * 2 + 1] * POLY_UNIT;
    out.push(x, z);
  }
  out.push(d.nodeX[d.edgeB[e]], d.nodeZ[d.edgeB[e]]);
  return out;
}
