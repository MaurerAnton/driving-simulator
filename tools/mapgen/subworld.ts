// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Parts of the region's road network.
 *
 * The network of the whole region is one large WorldJson that is never
 * turned into a World at once for everything: the tile build, the lane
 * network and the game each work on a part.  A part keeps what its roads
 * need – junctions, signal controllers, crossings, turn restrictions –
 * numbered from 0 again, with the lists that lead back to the numbers of
 * the whole.
 */
import type { CrossingJson, EdgeJson, NodeJson, SignalControllerJson, WorldJson } from '../../src/world/types.ts';
import { TILE, gridIndex } from './store.ts';
import type { Rect } from './store.ts';

export interface SubWorld {
  json: WorldJson;
  /** number in the whole network of each node and edge of the part */
  nodes: number[];
  edges: number[];
  /** and the other way round */
  nodeAt: Map<number, number>;
  edgeAt: Map<number, number>;
}

export class GraphStore {
  readonly json: WorldJson;
  /** per edge: minX, minZ, maxX, maxZ of its centre line */
  readonly box: Float32Array;
  readonly crossingsOf = new Map<number, CrossingJson[]>();
  /** forbidden movements by the edge they start from: via node, to edge, … */
  readonly bannedFrom = new Map<number, number[]>();
  private readonly tileEdges = new Map<number, number[]>();
  private readonly tileNodes = new Map<number, number[]>();

  constructor(json: WorldJson) {
    this.json = json;
    const E = json.edges.length;
    this.box = new Float32Array(E * 4);
    const key = (ix: number, iz: number): number => ix * 4096 + iz;
    for (let i = 0; i < E; i++) {
      const p = json.edges[i].p;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let k = 0; k < p.length; k += 3) {
        if (p[k] < minX) minX = p[k];
        if (p[k] > maxX) maxX = p[k];
        if (p[k + 2] < minZ) minZ = p[k + 2];
        if (p[k + 2] > maxZ) maxZ = p[k + 2];
      }
      this.box.set([minX, minZ, maxX, maxZ], i * 4);
      for (let ix = gridIndex(minX, TILE); ix <= gridIndex(maxX, TILE); ix++) {
        for (let iz = gridIndex(minZ, TILE); iz <= gridIndex(maxZ, TILE); iz++) {
          const k = key(ix, iz);
          const list = this.tileEdges.get(k);
          if (list) list.push(i);
          else this.tileEdges.set(k, [i]);
        }
      }
    }
    json.nodes.forEach((n, i) => {
      const k = key(gridIndex(n.x, TILE), gridIndex(n.z, TILE));
      const list = this.tileNodes.get(k);
      if (list) list.push(i);
      else this.tileNodes.set(k, [i]);
    });
    for (const c of json.crossings) {
      const list = this.crossingsOf.get(c.e);
      if (list) list.push(c);
      else this.crossingsOf.set(c.e, [c]);
    }
    for (const b of json.banned) {
      const list = this.bannedFrom.get(b[0]);
      if (list) list.push(b[1], b[2]);
      else this.bannedFrom.set(b[0], [b[1], b[2]]);
    }
  }

  /** The edges whose centre line comes within `pad` metres of the rectangle (by their bounding boxes). */
  edgesIn(r: Rect, pad = 0): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (let ix = gridIndex(r.minX - pad, TILE); ix <= gridIndex(r.maxX + pad, TILE); ix++) {
      for (let iz = gridIndex(r.minZ - pad, TILE); iz <= gridIndex(r.maxZ + pad, TILE); iz++) {
        for (const e of this.tileEdges.get(ix * 4096 + iz) ?? []) {
          if (seen.has(e)) continue;
          seen.add(e);
          const b = this.box;
          if (b[e * 4] > r.maxX + pad || b[e * 4 + 2] < r.minX - pad || b[e * 4 + 1] > r.maxZ + pad || b[e * 4 + 3] < r.minZ - pad) continue;
          out.push(e);
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  /** The nodes that lie in the rectangle (its western and northern edge included). */
  nodesIn(r: Rect): number[] {
    const out: number[] = [];
    for (let ix = gridIndex(r.minX, TILE); ix <= gridIndex(r.maxX, TILE); ix++) {
      for (let iz = gridIndex(r.minZ, TILE); iz <= gridIndex(r.maxZ, TILE); iz++) {
        for (const n of this.tileNodes.get(ix * 4096 + iz) ?? []) {
          const node = this.json.nodes[n];
          if (node.x >= r.minX && node.x < r.maxX && node.z >= r.minZ && node.z < r.maxZ) out.push(n);
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  /** Every edge that begins or ends at one of these nodes. */
  edgesAt(nodes: Iterable<number>): number[] {
    const seen = new Set<number>();
    for (const n of nodes) for (const arm of this.json.nodes[n].arms) seen.add(arm.e);
    return [...seen].sort((a, b) => a - b);
  }

  /**
   * The part of the network made of these edges and the nodes at their ends.
   * A node that lost some of its roads keeps the others in their order (its
   * junction is then not what it is in the whole – it lies outside of what
   * the part is for).
   */
  sub(edgeIds: number[]): SubWorld {
    const all = this.json;
    const edgeAt = new Map<number, number>();
    edgeIds.forEach((e, i) => edgeAt.set(e, i));
    const nodeSet = new Set<number>();
    for (const e of edgeIds) {
      nodeSet.add(all.edges[e].a);
      nodeSet.add(all.edges[e].b);
    }
    const nodeIds = [...nodeSet].sort((a, b) => a - b);
    const nodeAt = new Map<number, number>();
    nodeIds.forEach((n, i) => nodeAt.set(n, i));
    // signal controllers in use
    const scAt = new Map<number, number>();
    const signals: SignalControllerJson[] = [];
    const sc = (id: number | undefined): number | undefined => {
      if (id === undefined || id < 0) return id;
      let at = scAt.get(id);
      if (at === undefined) {
        at = signals.length;
        scAt.set(id, at);
        signals.push(all.signals[id]);
      }
      return at;
    };
    const nodes: NodeJson[] = nodeIds.map((id) => {
      const n = all.nodes[id];
      const arms = n.arms.filter((a) => edgeAt.has(a.e)).map((a) => ({ ...a, e: edgeAt.get(a.e) as number }));
      const whole = arms.length === n.arms.length;
      const out: NodeJson = { ...n, arms };
      if (!whole) delete out.fr;
      if (n.sc !== undefined) out.sc = sc(n.sc);
      return out;
    });
    const edges: EdgeJson[] = edgeIds.map((id) => {
      const e = all.edges[id];
      return { ...e, a: nodeAt.get(e.a) as number, b: nodeAt.get(e.b) as number };
    });
    const crossings: CrossingJson[] = [];
    const banned: number[][] = [];
    for (const id of edgeIds) {
      for (const c of this.crossingsOf.get(id) ?? []) {
        const out: CrossingJson = { ...c, e: edgeAt.get(id) as number };
        if (c.sc !== undefined) out.sc = sc(c.sc);
        crossings.push(out);
      }
      const b = this.bannedFrom.get(id);
      if (b) {
        for (let i = 0; i < b.length; i += 2) {
          const via = nodeAt.get(b[i]);
          const to = edgeAt.get(b[i + 1]);
          if (via !== undefined && to !== undefined) banned.push([edgeAt.get(id) as number, via, to]);
        }
      }
    }
    return {
      json: { version: all.version, meta: all.meta, nodes, edges, banned, signals, crossings, places: [], spawns: [], tiles: [] },
      nodes: nodeIds,
      edges: edgeIds,
      nodeAt,
      edgeAt,
    };
  }
}
