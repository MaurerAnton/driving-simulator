// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The road network of the detail region (mapgen/detailregion.ts), put into
 * the network of the whole map without changing the rest of it.
 *
 * tools/build-graph.ts first builds the whole network as the published map
 * was built (roadAttrsLegacy, nothing of observed-roads.json, every height
 * solved over the whole network at once): that is the published network,
 * with its numbers of junctions, roads and signal controllers.  Then, here:
 *
 *  1. The ways that reach into the region (with a margin) and the ways that
 *     share a node with them are copied, the corrections of
 *     observed-roads.json applied to the copy (OsmData.applyObserved: those
 *     that lie in the region), and the network of the copy built – the roads
 *     whose middle lies in the region the new way (MapArea.fresh).
 *  2. Which roads are replaced: in the new network the roads in the region
 *     and those of ways the corrections changed; in the published one the
 *     roads in the region and those of the changed ways.  Both sets are grown
 *     until they cover the same pieces of ways (a road cut in two, a way
 *     made one road with another).
 *  3. The heights of the new part: solved with the junctions and roads it
 *     shares with the published network held at their heights there (and
 *     every road that is the same as before keeps its heights) – a part
 *     solved on its own would move the heights of the whole network a little.
 *  4. Right of way, signals and crossings of the new part (deriveControl),
 *     on its own as well.
 *  5. Splicing: the new roads take the numbers of the roads they replace (in
 *     order), junctions and signal controllers likewise; what is left over is
 *     numbered after the last of the published network.  Every other road,
 *     junction and controller keeps its number – and so its chunk of the
 *     network (public/map/w) its bytes – and the files that refer to roads by
 *     number (stops, bus lines, addresses, signs) stay right.  Numbers of the
 *     published network that nothing new takes are kept by placeholders: a
 *     short private road far outside the map (two dead ends), which no chunk
 *     and no block holds (`placeholders`).
 *
 * The roads and junctions built anew are what the tile build treats the new
 * way (`fresh`, written into the blocks for tools/build-tiles.ts).
 */
import { CLS, CTRL, ACCESS } from '../../src/world/types.ts';
import type { ArmJson, CrossingJson, EdgeJson, NodeJson } from '../../src/world/types.ts';
import { deriveControl } from './control.ts';
import type { ControlResult } from './control.ts';
import { detailBounds, hasDetail, lineInDetail } from './detailregion.ts';
import type { Dgm } from './dgm.ts';
import { solveElevation } from './elevation.ts';
import type { OsmData } from './osm.ts';
import { buildRoadGraph } from './roads.ts';
import type { MapArea, RoadGraph } from './roads.ts';

/** how far around the region the ways are copied (m): all ways whose box reaches into it, and their neighbours */
const MARGIN = 400;
/** where the placeholders lie: far west and north of any map of the region */
const HOLD_X = -150_000;
const HOLD_Z = -150_000;

export interface DetailSplice {
  /** the roads built anew (their numbers in the spliced network) */
  freshEdges: Set<number>;
  /** the junctions of those roads */
  freshNodes: Set<number>;
  /** placeholder roads and junctions: in no chunk, in no block */
  placeholderEdges: Set<number>;
  placeholderNodes: Set<number>;
  report: string;
}

const segKey = (way: number, u: number, v: number): string => (u < v ? `${way}:${u}:${v}` : `${way}:${v}:${u}`);

/** The points (flat x, z) of an edge's nodes, as buildRoadGraph decided the region by them. */
function nodesLine(g: RoadGraph, k: number, osm: OsmData): number[] {
  const e = g.edges[k];
  const refs = g.edgeRefs[k];
  const out: number[] = [];
  refs.forEach((id, i) => {
    const n = osm.nodes.get(id);
    if (n) out.push(n.x, n.z);
    else {
      // (a node made where the road leaves the terrain: only at an end)
      const end = g.nodes[i === 0 ? e.a : e.b];
      out.push(end.x, end.z);
    }
  });
  return out;
}

/**
 * Build the network of the detail region and put it into `graph` (built as
 * the published map was, with `control`), in place.  Null: there is no region.
 */
export function spliceDetail(graph: RoadGraph, control: ControlResult, osm: OsmData, dgm: Dgm, area: MapArea, log: (msg: string) => void): DetailSplice | null {
  const bounds = detailBounds(MARGIN);
  if (!bounds || !hasDetail()) return null;

  // ---- 1. the network of the copy, the corrections applied ----
  const local = osm.localCopy(bounds);
  local.applyObserved();
  const changed = local.observedWays;
  const N = buildRoadGraph(local, { ...area, fresh: (pts) => lineInDetail(pts) });
  log(`detail region: ${local.ways.length} ways copied, ${changed.size} changed by observed-roads.json; network ${N.nodes.length} nodes, ${N.edges.length} edges`);

  // ---- 2. which roads are replaced ----
  const wayOf = (g: RoadGraph, k: number): number => g.edgeWay[k].of ?? g.edgeWay[k].id;
  const segsOf = (g: RoadGraph, k: number): string[] => {
    const refs = g.edgeRefs[k];
    const w = wayOf(g, k);
    const out: string[] = [];
    for (let i = 1; i < refs.length; i++) out.push(segKey(w, refs[i - 1], refs[i]));
    return out;
  };
  const inCopy = (wayId: number): boolean => local.wayById.has(wayId) || changed.has(wayId);
  // the published roads of the copied ways, by their pieces and by their nodes
  const lSeg = new Map<string, number>();
  const lByRefs = new Map<string, number>();
  const lLocal: number[] = [];
  for (let k = 0; k < graph.edges.length; k++) {
    if (!inCopy(wayOf(graph, k))) continue;
    lLocal.push(k);
    for (const s of segsOf(graph, k)) lSeg.set(s, k);
    lByRefs.set(`${wayOf(graph, k)}|${graph.edgeRefs[k].join(',')}`, k);
  }
  const nSeg = new Map<string, number[]>();
  for (let k = 0; k < N.edges.length; k++) {
    for (const s of segsOf(N, k)) {
      const list = nSeg.get(s);
      if (list) list.push(k);
      else nSeg.set(s, [k]);
    }
  }
  const dN = new Set<number>();
  const dL = new Set<number>();
  for (let k = 0; k < N.edges.length; k++) if (N.edgeNew[k] || changed.has(wayOf(N, k))) dN.add(k);
  for (const k of lLocal) if (changed.has(wayOf(graph, k)) || lineInDetail(nodesLine(graph, k, osm))) dL.add(k);
  // (grown until both cover the same pieces of ways)
  for (let grown = true; grown; ) {
    grown = false;
    for (const k of dN) {
      for (const s of segsOf(N, k)) {
        const l = lSeg.get(s);
        if (l !== undefined && !dL.has(l)) {
          dL.add(l);
          grown = true;
        }
      }
    }
    for (const k of dL) {
      for (const s of segsOf(graph, k)) {
        for (const n of nSeg.get(s) ?? []) {
          if (!dN.has(n)) {
            dN.add(n);
            grown = true;
          }
        }
      }
    }
  }

  // ---- the junctions: by their OSM node ----
  const lNodeOf = (v: number): number | undefined => {
    const o = N.nodeOsm[v];
    return o ? graph.nodeIndex.get(o.id) : undefined;
  };
  const nFrom = new Set<number>();
  for (const k of dN) {
    nFrom.add(N.edges[k].a);
    nFrom.add(N.edges[k].b);
  }

  // ---- 3. heights: held where the new part meets the published network, and where nothing changed ----
  const samePlace = (v: number, l: number): boolean => Math.abs(N.nodes[v].x - graph.nodes[l].x) < 1e-6 && Math.abs(N.nodes[v].z - graph.nodes[l].z) < 1e-6;
  const sameAs = new Map<number, number>();
  for (let k = 0; k < N.edges.length; k++) {
    const l = lByRefs.get(`${wayOf(N, k)}|${N.edgeRefs[k].join(',')}`);
    if (l === undefined) continue;
    const a = N.edges[k].p;
    const b = graph.edges[l].p;
    if (a.length !== b.length) continue;
    let same = true;
    for (let i = 0; i < a.length && same; i += 3) same = a[i] === b[i] && a[i + 2] === b[i + 2];
    if (same) sameAs.set(k, l);
  }
  const lys = (l: number): number[] => {
    const p = graph.edges[l].p;
    const out: number[] = [];
    for (let i = 1; i < p.length; i += 3) out.push(p[i]);
    return out;
  };
  solveElevation(N, dgm, {
    node: (v) => {
      const l = lNodeOf(v);
      return l !== undefined && samePlace(v, l) ? graph.nodes[l].y : undefined;
    },
    edge: (k) => {
      const l = sameAs.get(k);
      return l !== undefined ? lys(l) : undefined;
    },
  });

  // ---- 4. right of way, signals, crossings of the new part ----
  const nControl = deriveControl(N, local);

  // ---- 5. numbers ----
  const E0 = graph.edges.length;
  const N0 = graph.nodes.length;
  const S0 = control.signals.length;
  const freeEdges = [...dL].sort((a, b) => a - b);
  const edgeId = new Map<number, number>();
  let nextEdge = E0;
  let fe = 0;
  for (let k = 0; k < N.edges.length; k++) {
    if (!dN.has(k)) continue;
    edgeId.set(k, fe < freeEdges.length ? freeEdges[fe++] : nextEdge++);
  }
  // junctions: those of the new part that the published network has keep their numbers
  const nodeId = new Map<number, number>();
  const takenL = new Set<number>();
  for (const v of [...nFrom].sort((a, b) => a - b)) {
    const l = lNodeOf(v);
    if (l !== undefined && !takenL.has(l)) {
      nodeId.set(v, l);
      takenL.add(l);
    }
  }
  // the published junctions of the replaced roads: what is left of them
  const lostArms = new Map<number, number>();
  for (const k of dL) {
    for (const l of [graph.edges[k].a, graph.edges[k].b]) lostArms.set(l, (lostArms.get(l) ?? 0) + 1);
  }
  const freeNodes: number[] = [];
  const pruned: number[] = [];
  for (const [l, lost] of lostArms) {
    if (takenL.has(l)) continue;
    const left = graph.nodes[l].arms.filter((a) => !dL.has(a.e)).length;
    if (left === 0 && lost > 0) freeNodes.push(l);
    else pruned.push(l);
  }
  freeNodes.sort((a, b) => a - b);
  let fn = 0;
  let nextNode = N0;
  for (const v of [...nFrom].sort((a, b) => a - b)) {
    if (nodeId.has(v)) continue;
    nodeId.set(v, fn < freeNodes.length ? freeNodes[fn++] : nextNode++);
  }

  // an arm of a new junction on a road that is not new: the published road with the same first piece
  const armEdge = (v: number, k: number): number | undefined => {
    const id = edgeId.get(k);
    if (id !== undefined) return id;
    const refs = N.edgeRefs[k];
    const atA = N.edges[k].a === v;
    const u = atA ? refs[0] : refs[refs.length - 1];
    const w = atA ? refs[1] : refs[refs.length - 2];
    const l = lSeg.get(segKey(wayOf(N, k), u, w));
    return l !== undefined && !dL.has(l) ? l : undefined;
  };

  // signal controllers: those only the replaced part used are free
  const usedKept = new Set<number>();
  const usedLost = new Set<number>();
  const freeNodeSet = new Set(freeNodes);
  const nodeSourcedL = (l: number): boolean => !takenL.has(l) && !freeNodeSet.has(l);
  graph.nodes.forEach((n, l) => {
    if (n.sc === undefined || n.sc < 0) return;
    (nodeSourcedL(l) ? usedKept : usedLost).add(n.sc);
  });
  for (const c of control.crossings) {
    if (c.sc === undefined || c.sc < 0) continue;
    (dL.has(c.e) ? usedLost : usedKept).add(c.sc);
  }
  const freeSignals = [...usedLost].filter((s) => !usedKept.has(s)).sort((a, b) => a - b);
  const signalId = new Map<number, number>();
  let fs = 0;
  let nextSignal = S0;
  const sigOf = (s: number | undefined): number | undefined => {
    if (s === undefined || s < 0) return s;
    let id = signalId.get(s);
    if (id === undefined) {
      id = fs < freeSignals.length ? freeSignals[fs++] : nextSignal++;
      signalId.set(s, id);
    }
    return id;
  };

  // ---- the spliced network ----
  const edges = graph.edges;
  const nodes = graph.nodes;
  const nodeOsm = graph.nodeOsm;
  const nodeMapEnd = graph.nodeMapEnd;
  const edgeWay = graph.edgeWay;
  const edgeRefs = graph.edgeRefs;
  const edgeFeatures = graph.edgeFeatures;
  const edgeNew = graph.edgeNew;
  let dropped = 0;
  for (let k = 0; k < N.edges.length; k++) {
    const id = edgeId.get(k);
    if (id === undefined) continue;
    const e: EdgeJson = { ...N.edges[k], a: nodeId.get(N.edges[k].a) as number, b: nodeId.get(N.edges[k].b) as number };
    edges[id] = e;
    edgeWay[id] = N.edgeWay[k];
    edgeRefs[id] = N.edgeRefs[k];
    edgeFeatures[id] = N.edgeFeatures[k];
    edgeNew[id] = true;
  }
  for (const v of nFrom) {
    const id = nodeId.get(v) as number;
    const src = N.nodes[v];
    const arms: ArmJson[] = [];
    for (const a of src.arms) {
      const e = armEdge(v, a.e);
      if (e === undefined) {
        dropped++;
        continue;
      }
      arms.push({ ...a, e });
    }
    const n: NodeJson = { ...src, arms };
    if (src.sc !== undefined) n.sc = sigOf(src.sc);
    nodes[id] = n;
    nodeOsm[id] = N.nodeOsm[v];
    nodeMapEnd[id] = N.nodeMapEnd[v];
  }
  for (const l of pruned) nodes[l] = { ...nodes[l], arms: nodes[l].arms.filter((a) => !dL.has(a.e)) };
  // crossings: the published ones on the roads kept, the new ones on the new roads
  const signals = control.signals;
  const crossings: CrossingJson[] = control.crossings.filter((c) => !dL.has(c.e));
  for (const c of nControl.crossings) {
    const id = edgeId.get(c.e);
    if (id === undefined) continue;
    const out: CrossingJson = { ...c, e: id };
    if (c.sc !== undefined) out.sc = sigOf(c.sc);
    crossings.push(out);
  }
  for (const [s, id] of signalId) signals[id] = nControl.signals[s];
  // forbidden turns: at the new junctions as the new part says, elsewhere as published
  const newJunction = new Set<number>([...nFrom].map((v) => nodeId.get(v) as number));
  const banned: number[][] = control.banned.filter((b) => !dL.has(b[0]) && !dL.has(b[2]) && !newJunction.has(b[1]));
  for (const b of nControl.banned) {
    const via = nodeId.get(b[1]);
    if (via === undefined || !nFrom.has(b[1])) continue;
    const from = armEdge(b[1], b[0]);
    const to = armEdge(b[1], b[2]);
    if (from === undefined || to === undefined) continue;
    banned.push([from, via, to]);
  }

  // ---- placeholders for the numbers nothing new took ----
  const placeholderEdges = new Set<number>();
  const placeholderNodes = new Set<number>();
  const spareEdges = freeEdges.slice(fe);
  const spareNodes = freeNodes.slice(fn);
  let hold = 0;
  const holdNode = (): number => {
    const id = spareNodes.length ? (spareNodes.shift() as number) : nextNode++;
    placeholderNodes.add(id);
    return id;
  };
  const holdEdge = (id: number): void => {
    const a = holdNode();
    const b = holdNode();
    const x = HOLD_X - 20 * hold++;
    edges[id] = { a, b, c: CLS.SERVICE, p: [x, 0, HOLD_Z, x + 2, 0, HOLD_Z], lf: 1, lb: 1, lw: 2.5, w: 5, mf: 0, mb: 0, f: 0, ca: 0, cb: 0, ac: ACCESS.PRIVATE, o: 0 };
    nodes[a] = { x, y: 0, z: HOLD_Z, t: CTRL.MAP_END, arms: [{ e: id, r: 0 }] };
    nodes[b] = { x: x + 2, y: 0, z: HOLD_Z, t: CTRL.MAP_END, arms: [{ e: id, r: 0 }] };
    for (const n of [a, b]) {
      nodeOsm[n] = null;
      nodeMapEnd[n] = true;
    }
    edgeWay[id] = { id: 0, refs: [], tags: {} };
    edgeRefs[id] = [];
    edgeFeatures[id] = [];
    edgeNew[id] = false;
    placeholderEdges.add(id);
  };
  for (const id of spareEdges) holdEdge(id);
  while (spareNodes.length) holdEdge(nextEdge++);
  // (a controller nothing new took stays where it was, used by no junction: no chunk holds it)

  control.crossings = crossings;
  control.banned = banned;
  // (OSM node → junction, OSM way → roads: for what is built after)
  for (const v of nFrom) {
    const o = N.nodeOsm[v];
    if (o) graph.nodeIndex.set(o.id, nodeId.get(v) as number);
  }

  // (check: the arms of every junction touched are the roads that end there)
  const touched = new Set<number>([...newJunction, ...pruned]);
  const ends = new Map<number, number[]>();
  edges.forEach((e, k) => {
    for (const n of [e.a, e.b]) {
      if (!touched.has(n)) continue;
      const list = ends.get(n);
      if (list) list.push(k);
      else ends.set(n, [k]);
    }
  });
  let mismatched = 0;
  for (const n of touched) {
    const want = (ends.get(n) ?? []).slice().sort((a, b) => a - b).join(',');
    const have = nodes[n].arms.map((a) => a.e).sort((a, b) => a - b).join(',');
    if (want !== have) {
      mismatched++;
      if (mismatched <= 5) log(`detail region: junction ${n} at ${nodes[n].x.toFixed(1)}, ${nodes[n].z.toFixed(1)} has arms ${have} but roads ${want}`);
    }
  }

  const freshEdges = new Set(edgeId.values());
  const freshNodes = new Set<number>(newJunction);
  const report =
    `detail region: ${dL.size} roads replaced by ${dN.size} (${Math.max(0, nextEdge - E0)} numbers added, ${spareEdges.length} placeholders), ` +
    `${nFrom.size} junctions anew (${Math.max(0, nextNode - N0)} numbers added, ${placeholderNodes.size} placeholder ends, ${pruned.length} published junctions lost roads), ` +
    `${signalId.size} signal controllers (${Math.max(0, nextSignal - S0)} added), ${dropped} arms without a road, ${mismatched} junctions whose arms do not match their roads`;
  return { freshEdges, freshNodes, placeholderEdges, placeholderNodes, report };
}
