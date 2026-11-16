// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The road network of the whole map (netfile.ts) made searchable by place:
 * which roads come into a rectangle – for drawing the map of a region whose
 * roads are mostly not loaded –, and which road is nearest to a point – for
 * putting the car somewhere far away, or driving there.
 */
import { POLY_UNIT, routeGraphOfNet } from './netfile.ts';
import type { NetData } from './netfile.ts';
import { mainWays } from './routegraph.ts';
import type { RouteGraph } from './routegraph.ts';

const CELL = 1000;

export interface NetSpot {
  edge: number;
  /** the point on the road, and the direction the road runs there from its junction a to b (yaw: 0 = north, positive = to the left) */
  x: number;
  z: number;
  yaw: number;
  /** how far that is from what was asked for */
  d: number;
}

export class NetIndex {
  readonly net: NetData;
  readonly graph: RouteGraph;
  /** the ways one can drive around on (routegraph.ts: mainWays) */
  readonly main: Uint8Array;
  private readonly cells = new Map<number, number[]>();
  /** the same for the bigger roads only (tertiary and above): what a map of the whole region shows */
  private readonly bigCells = new Map<number, number[]>();

  /**
   * Make the index in steps, with a breath for the page between them (for
   * the game, where a region's network would otherwise hold a frame up for
   * seconds).
   */
  static async build(net: NetData): Promise<NetIndex> {
    const pause = (): Promise<void> => new Promise((r) => setTimeout(r));
    const graph = routeGraphOfNet(net);
    await pause();
    const main = mainWays(graph);
    await pause();
    return new NetIndex(net, graph, main);
  }

  constructor(net: NetData, graph = routeGraphOfNet(net), main = mainWays(graph)) {
    this.net = net;
    this.graph = graph;
    this.main = main;
    const E = net.edgeA.length;
    for (let e = 0; e < E; e++) {
      let x = net.nodeX[net.edgeA[e]];
      let z = net.nodeZ[net.edgeA[e]];
      let minX = Math.min(x, net.nodeX[net.edgeB[e]]);
      let maxX = Math.max(x, net.nodeX[net.edgeB[e]]);
      let minZ = Math.min(z, net.nodeZ[net.edgeB[e]]);
      let maxZ = Math.max(z, net.nodeZ[net.edgeB[e]]);
      for (let k = net.polyFirst[e]; k < net.polyFirst[e + 1]; k++) {
        x += net.poly[k * 2] * POLY_UNIT;
        z += net.poly[k * 2 + 1] * POLY_UNIT;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      for (let ix = Math.floor(minX / CELL); ix <= Math.floor(maxX / CELL); ix++) {
        for (let iz = Math.floor(minZ / CELL); iz <= Math.floor(maxZ / CELL); iz++) {
          const key = (ix + 4096) * 8192 + iz + 4096;
          const list = this.cells.get(key);
          if (list) list.push(e);
          else this.cells.set(key, [e]);
          if (net.edgeCls[e] <= 9) {
            const big = this.bigCells.get(key);
            if (big) big.push(e);
            else this.bigCells.set(key, [e]);
          }
        }
      }
    }
  }

  /** Visit the roads that come near the rectangle (each once); `big`: only tertiary roads and above. */
  edgesInBox(minX: number, minZ: number, maxX: number, maxZ: number, visit: (e: number) => void, big = false): void {
    const cells = big ? this.bigCells : this.cells;
    const x0 = Math.floor(minX / CELL);
    const x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL);
    const z1 = Math.floor(maxZ / CELL);
    const single = x0 === x1 && z0 === z1;
    const seen = single ? null : new Set<number>();
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = cells.get((ix + 4096) * 8192 + iz + 4096);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const e = list[i];
          if (seen) {
            if (seen.has(e)) continue;
            seen.add(e);
          }
          visit(e);
        }
      }
    }
  }

  /** Draw the course of a road into a path (anything with moveTo and lineTo). */
  trace(e: number, path: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void }): void {
    const net = this.net;
    let x = net.nodeX[net.edgeA[e]];
    let z = net.nodeZ[net.edgeA[e]];
    path.moveTo(x, z);
    for (let k = net.polyFirst[e]; k < net.polyFirst[e + 1]; k++) {
      x += net.poly[k * 2] * POLY_UNIT;
      z += net.poly[k * 2 + 1] * POLY_UNIT;
      path.lineTo(x, z);
    }
    path.lineTo(net.nodeX[net.edgeB[e]], net.nodeZ[net.edgeB[e]]);
  }

  /** The point on a road nearest to (x, z), not further than `maxDist` – among the roads `usable` allows. */
  nearest(x: number, z: number, maxDist: number, usable?: (e: number) => boolean): NetSpot | null {
    const net = this.net;
    let best: NetSpot | null = null;
    let bd = maxDist;
    this.edgesInBox(x - maxDist, z - maxDist, x + maxDist, z + maxDist, (e) => {
      if (usable && !usable(e)) return;
      let ax = net.nodeX[net.edgeA[e]];
      let az = net.nodeZ[net.edgeA[e]];
      const n = net.polyFirst[e + 1] - net.polyFirst[e];
      for (let i = 0; i <= n; i++) {
        let bx: number;
        let bz: number;
        if (i < n) {
          const k = net.polyFirst[e] + i;
          bx = ax + net.poly[k * 2] * POLY_UNIT;
          bz = az + net.poly[k * 2 + 1] * POLY_UNIT;
        } else {
          bx = net.nodeX[net.edgeB[e]];
          bz = net.nodeZ[net.edgeB[e]];
        }
        const dx = bx - ax;
        const dz = bz - az;
        const l2 = dx * dx + dz * dz;
        let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + dx * t;
        const pz = az + dz * t;
        const d = Math.hypot(x - px, z - pz);
        if (d < bd) {
          bd = d;
          best = { edge: e, x: px, z: pz, yaw: Math.atan2(-dx, -dz), d };
        }
        ax = bx;
        az = bz;
      }
    });
    return best;
  }
}
