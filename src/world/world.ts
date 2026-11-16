// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Runtime road network: linked nodes/edges/arms, junction geometry, spatial
 * index and the analytic road-surface function.
 *
 * The same code runs in the map pipeline (to build meshes and conform the
 * terrain) and in the game (physics ground, map matching, AI), which is what
 * keeps what you see and what the tyres feel identical.
 */
import {
  Grid2,
  angleOf,
  clamp,
  lineLine,
  makePolyline,
  newPolySample,
  pointInRing,
  projectOnPolyline,
  samplePolyline,
  smoothstep,
  wrap2Pi,
} from '../core/geom.ts';
import type { PolyProjection, PolySample, Polyline3 } from '../core/geom.ts';
import { CLASS_TIER, CTRL, EF, KERB_H, ROLE, SURF } from './types.ts';
import type { CrossingJson, EdgeJson, NodeJson, SignalControllerJson, WorldChunkJson, WorldJson } from './types.ts';

export interface Edge {
  id: number;
  a: Node;
  b: Node;
  cls: number;
  tier: number;
  name: string;
  ref: string;
  pl: Polyline3;
  len: number;
  lanesF: number;
  lanesB: number;
  laneW: number;
  width: number;
  /** paved strip outside the lanes on each side */
  margin: number;
  maxF: number;
  maxB: number;
  zone: number;
  surf: number;
  swL: number;
  swR: number;
  flags: number;
  access: number;
  cutA: number;
  cutB: number;
  layer: number;
  turnF: string;
  turnB: string;
  osm: number;
  armA: Arm;
  armB: Arm;
  /** blend lengths over which the surface relaxes from junction plane to profile */
  blendA: number;
  blendB: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** the crossings on this edge */
  xings: CrossingJson[];
}

export interface Arm {
  node: Node;
  edge: Edge;
  /** true when the edge leaves the node (node === edge.a) */
  out: boolean;
  /** index in node.arms (counter-clockwise order) */
  idx: number;
  role: number;
  sg: number;
  /** stop/yield line distance from the node */
  stopS: number;
  cut: number;
  /** unit direction pointing away from the node */
  dx: number;
  dz: number;
  ang: number;
  half: number;
  /** sidewalk widths left/right when looking away from the node */
  swL: number;
  swR: number;
  /** true if vehicles can arrive at the node on this arm */
  isApproach: boolean;
  /** true if vehicles can leave the node on this arm */
  isExit: boolean;
}

/** One kerb line between two neighbouring arms of a junction. */
export interface JunctionCorner {
  /** flat [x,z,…] from the left mouth of arm i to the right mouth of arm i+1 */
  kerb: number[];
  /** sidewalk width at the start (arm i, its left side) and end (arm i+1, right side) */
  swA: number;
  swB: number;
  /** index range of the fillet arc inside `kerb` (point indices), -1 when none */
  arc0: number;
  arc1: number;
  ox: number;
  oz: number;
  r: number;
}

export interface JunctionShape {
  /** counter-clockwise flat ring [x,z,…] of the carriageway area */
  ring: number[];
  corners: JunctionCorner[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Node {
  id: number;
  x: number;
  y: number;
  z: number;
  gx: number;
  gz: number;
  ctrl: number;
  arms: Arm[];
  sc: number;
  fr: number[];
  tc: number;
  osm: number;
  shape: JunctionShape | null;
  /**
   * Only the roads that are loaded are known of this junction – its own
   * piece of the map is not (the network comes in chunks).  It has no area
   * and nothing leads through it yet; it is where the loaded network ends.
   */
  stub: boolean;
}

/** What changed when a piece of the network was added or taken away. */
export interface WorldChange {
  /** roads that came (or went) */
  edges: Edge[];
  /** junctions that are whole now (or no longer) */
  nodes: Node[];
}

export interface SurfaceHit {
  /** surface height */
  y: number;
  /** edge the point belongs to (nearest centreline), or null when off-road */
  edge: Edge | null;
  /** node whose junction area contains the point, or null */
  node: Node | null;
  /** station along the edge (from node a) and signed lateral offset (+ = left of a→b) */
  s: number;
  off: number;
  /** 0 = carriageway, 1 = sidewalk, 2 = off-road */
  zone: number;
  surf: number;
}

export function newSurfaceHit(): SurfaceHit {
  return { y: 0, edge: null, node: null, s: 0, off: 0, zone: 2, surf: SURF.GRASS };
}

const tmpSample = newPolySample();
const tmpProj: PolyProjection = { s: 0, off: 0, d2: 0, seg: 0 };

/** Point on an arm at distance `d` from its node. */
export function armPoint(arm: Arm, d: number, out: PolySample): PolySample {
  const e = arm.edge;
  return samplePolyline(e.pl, arm.out ? d : e.len - d, out);
}

function computeArmDirection(arm: Arm): void {
  const e = arm.edge;
  // Fixed probe distance: must not depend on the cut, otherwise the pipeline
  // (which solves the cuts) and the runtime would see different corner geometry.
  const probe = clamp(8, 0.5, e.len);
  armPoint(arm, probe, tmpSample);
  let dx = tmpSample.x - arm.node.x;
  let dz = tmpSample.z - arm.node.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-6) {
    dx = 1;
    dz = 0;
  } else {
    dx /= l;
    dz /= l;
  }
  arm.dx = dx;
  arm.dz = dz;
  arm.ang = angleOf(dx, dz);
}

/** Desired kerb radius between two arms (before length limits). */
function desiredFilletRadius(a: Arm, b: Arm): number {
  const t = Math.min(a.edge.tier, b.edge.tier);
  let r = t >= 3 ? 8 : t >= 2 ? 5.5 : t >= 1 ? 3.5 : 3;
  const sw = Math.max(a.swL, b.swR);
  if (sw > 0) r = Math.max(r, sw + 0.6);
  return r;
}

interface CornerSolve {
  /** distances from the node (along each arm) to the sharp corner, or -1 */
  t: number;
  u: number;
  cx: number;
  cz: number;
  phi: number;
}

function solveCorner(a: Arm, b: Arm, n: Node): CornerSolve {
  const phi = wrap2Pi(b.ang - a.ang);
  const res: CornerSolve = { t: -1, u: -1, cx: 0, cz: 0, phi };
  if (phi < 0.12 || phi > 3.0) return res; // ~7° … ~172°
  // left edge of a: P + left_a * half_a ; left of (dx,dz) is (dz,-dx)
  const ax = n.x + a.dz * a.half;
  const az = n.z - a.dx * a.half;
  // right edge of b: P - left_b * half_b
  const bx = n.x - b.dz * b.half;
  const bz = n.z + b.dx * b.half;
  const r = lineLine(ax, az, a.dx, a.dz, bx, bz, b.dx, b.dz);
  if (!r) return res;
  res.t = r[0];
  res.u = r[1];
  res.cx = ax + a.dx * r[0];
  res.cz = az + a.dz * r[0];
  return res;
}

/**
 * Pipeline step: decide how far each arm is cut back from the node and which
 * kerb radius each corner gets.  Writes `arm.cut`, `edge.cutA/B`, `node.fr`.
 */
export function computeJunctionCuts(node: Node): void {
  const arms = node.arms;
  const n = arms.length;
  node.fr = new Array<number>(n).fill(0);
  for (const arm of arms) arm.cut = 0;
  if (n < 2) return;
  for (const arm of arms) computeArmDirection(arm);

  const maxCut = arms.map((arm) => {
    const e = arm.edge;
    const other = arm.out ? e.b : e.a;
    // an edge that ends in a dead end may be consumed almost entirely
    const share = other.arms.length <= 1 ? 0.8 : 0.45;
    return Math.max(0, e.len * share);
  });

  if (n === 2) {
    const [p, q] = arms;
    const same =
      Math.abs(p.half - q.half) < 0.05 && Math.abs(p.swL - q.swR) < 0.05 && Math.abs(p.swR - q.swL) < 0.05;
    const bend = Math.abs(Math.PI - wrap2Pi(q.ang - p.ang));
    if (same && bend < 0.6) return; // smooth continuation: ribbons simply meet
    const taper = bend >= 0.6 ? Math.max(p.half, q.half) * Math.tan(Math.min(bend, 2.4) / 2) + 1 : 2;
    p.cut = Math.min(maxCut[0], taper);
    q.cut = Math.min(maxCut[1], taper);
    return;
  }

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = arms[i];
    const b = arms[j];
    const c = solveCorner(a, b, node);
    if (c.t < 0 || c.u < 0) {
      // No convex corner (straight-through side or reflex gap): tiny cut only.
      a.cut = Math.max(a.cut, Math.min(maxCut[i], 0.6));
      b.cut = Math.max(b.cut, Math.min(maxCut[j], 0.6));
      continue;
    }
    const tanHalf = Math.tan(c.phi / 2);
    let r = desiredFilletRadius(a, b);
    // keep the tangent length sane on acute corners and inside short edges
    r = Math.min(r, 12 * tanHalf);
    const room = Math.min(maxCut[i] - c.t, maxCut[j] - c.u);
    r = Math.min(r, Math.max(0, room) * tanHalf);
    if (r < 0.4) r = 0;
    node.fr[i] = r;
    const tl = r > 0 ? r / tanHalf : 0;
    a.cut = Math.max(a.cut, Math.min(maxCut[i], c.t + tl + 0.05));
    b.cut = Math.max(b.cut, Math.min(maxCut[j], c.u + tl + 0.05));
  }
  for (let i = 0; i < n; i++) arms[i].cut = clamp(arms[i].cut, 0, maxCut[i]);
}

/** Mouth corner of an arm: the ribbon edge point at the cut station. side = +1 left, -1 right (looking away from node). */
function mouthPoint(arm: Arm, side: number, out: [number, number]): void {
  armPoint(arm, arm.cut, tmpSample);
  // tangent of the polyline points a→b; flip so it points away from the node
  const tx = arm.out ? tmpSample.tx : -tmpSample.tx;
  const tz = arm.out ? tmpSample.tz : -tmpSample.tz;
  out[0] = tmpSample.x + tz * arm.half * side;
  out[1] = tmpSample.z - tx * arm.half * side;
}

/** Build the carriageway polygon and kerb lines of a junction from stored cuts/radii. */
export function buildJunctionShape(node: Node): JunctionShape | null {
  const arms = node.arms;
  const n = arms.length;
  if (n === 1 && node.tc > 0) {
    // turning circle at the end of a cul-de-sac
    const ring: number[] = [];
    const steps = 20;
    for (let k = 0; k < steps; k++) {
      const t = (k / steps) * Math.PI * 2;
      // counter-clockwise seen from above (north-up): x = cos, north = sin → z = -sin
      ring.push(node.x + Math.cos(t) * node.tc, node.z - Math.sin(t) * node.tc);
    }
    return {
      ring,
      corners: [],
      minX: node.x - node.tc,
      maxX: node.x + node.tc,
      minZ: node.z - node.tc,
      maxZ: node.z + node.tc,
    };
  }
  if (n < 2) return null;
  let any = false;
  for (const a of arms) if (a.cut > 1e-3) any = true;
  if (!any) return null;

  const ring: number[] = [];
  const corners: JunctionCorner[] = [];
  const pt: [number, number] = [0, 0];
  for (let i = 0; i < n; i++) {
    const a = arms[i];
    const b = arms[(i + 1) % n];
    mouthPoint(a, -1, pt);
    ring.push(pt[0], pt[1]);
    mouthPoint(a, +1, pt);
    const lx = pt[0];
    const lz = pt[1];
    mouthPoint(b, -1, pt);
    const rx = pt[0];
    const rz = pt[1];

    const kerb: number[] = [lx, lz];
    let arc0 = -1;
    let arc1 = -1;
    let ox = 0;
    let oz = 0;
    const r = node.fr[i] ?? 0;
    const c = n > 2 ? solveCorner(a, b, node) : null;
    if (c && c.t >= 0 && c.u >= 0) {
      if (r > 0) {
        const tl = r / Math.tan(c.phi / 2);
        const tix = c.cx + a.dx * tl;
        const tiz = c.cz + a.dz * tl;
        const tjx = c.cx + b.dx * tl;
        const tjz = c.cz + b.dz * tl;
        let bx = a.dx + b.dx;
        let bz = a.dz + b.dz;
        const bl = Math.hypot(bx, bz) || 1;
        bx /= bl;
        bz /= bl;
        const od = r / Math.sin(c.phi / 2);
        ox = c.cx + bx * od;
        oz = c.cz + bz * od;
        const sweep = Math.PI - c.phi;
        const steps = Math.max(2, Math.ceil(sweep / 0.21));
        const a0 = Math.atan2(tiz - oz, tix - ox);
        let a1 = Math.atan2(tjz - oz, tjx - ox);
        let d = a1 - a0;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        a1 = a0 + d;
        arc0 = kerb.length / 2;
        for (let k = 0; k <= steps; k++) {
          const t = a0 + (d * k) / steps;
          kerb.push(ox + Math.cos(t) * r, oz + Math.sin(t) * r);
        }
        arc1 = kerb.length / 2 - 1;
      } else {
        kerb.push(c.cx, c.cz);
      }
    }
    kerb.push(rx, rz);
    // drop consecutive duplicates
    const clean: number[] = [kerb[0], kerb[1]];
    let removedBeforeArc0 = 0;
    let removedBeforeArc1 = 0;
    for (let k = 2; k < kerb.length; k += 2) {
      const px = clean[clean.length - 2];
      const pz = clean[clean.length - 1];
      if (Math.hypot(kerb[k] - px, kerb[k + 1] - pz) < 0.02) {
        if (k / 2 <= arc0) removedBeforeArc0++;
        if (k / 2 <= arc1) removedBeforeArc1++;
        continue;
      }
      clean.push(kerb[k], kerb[k + 1]);
    }
    if (arc0 >= 0) {
      arc0 -= removedBeforeArc0;
      arc1 -= removedBeforeArc1;
    }
    corners.push({ kerb: clean, swA: a.swL, swB: b.swR, arc0, arc1, ox, oz, r });
    for (let k = 0; k < clean.length - 2; k += 2) ring.push(clean[k], clean[k + 1]);
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < ring.length; k += 2) {
    minX = Math.min(minX, ring[k]);
    maxX = Math.max(maxX, ring[k]);
    minZ = Math.min(minZ, ring[k + 1]);
    maxZ = Math.max(maxZ, ring[k + 1]);
  }
  return { ring, corners, minX, maxX, minZ, maxZ };
}

/** The centre line of an edge from its packed form (EdgeJson.q): metres. */
export function edgePoints(q: readonly number[]): number[] {
  const p = new Array<number>(q.length);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < q.length; i += 3) {
    x += q[i];
    y += q[i + 1];
    z += q[i + 2];
    p[i] = x / 100;
    p[i + 1] = y / 100;
    p[i + 2] = z / 100;
  }
  return p;
}

/** … and into it. */
export function packEdgePoints(p: readonly number[]): number[] {
  const q = new Array<number>(p.length);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < p.length; i += 3) {
    const cx = Math.round(p[i] * 100);
    const cy = Math.round(p[i + 1] * 100);
    const cz = Math.round(p[i + 2] * 100);
    q[i] = cx - x;
    q[i + 1] = cy - y;
    q[i + 2] = cz - z;
    x = cx;
    y = cy;
    z = cz;
  }
  return q;
}

export class World {
  readonly meta: WorldJson['meta'];
  /** by their number in the whole map – with gaps where the map is not loaded: go through `allNodes` / `allEdges` */
  readonly nodes: Node[] = [];
  readonly edges: Edge[] = [];
  /** every junction (stubs too) and every road that is loaded */
  readonly allNodes = new Set<Node>();
  readonly allEdges = new Set<Edge>();
  /** forbidden turns: from edge → [via node, to edge, …] (few edges have any) */
  private readonly banned = new Map<number, number[]>();
  /** signal controllers by their number (with gaps, like the nodes) */
  readonly signals: SignalControllerJson[] = [];
  /** the crossings of all loaded roads */
  readonly crossings: CrossingJson[] = [];
  /** what was read first: the description of the map (and, for a map in one piece, all of it) */
  readonly json: WorldJson;
  /** edge segments: value = edgeId * 4096 + segmentIndex */
  private readonly segGrid = new Grid2<number>(40);
  private readonly nodeGrid = new Grid2<Node>(40);

  /**
   * A map in one piece (all its nodes and edges in `json`) – or, with none
   * in it, an empty one that pieces are added to (`add`).
   */
  constructor(json: WorldJson) {
    this.json = json;
    this.meta = json.meta;
    if (json.nodes.length === 0 && json.edges.length === 0) return;
    // the same as one big piece: crossings and forbidden turns go with their edges
    const xings = new Map<number, CrossingJson[]>();
    for (const c of json.crossings) {
      const list = xings.get(c.e);
      if (list) list.push(c);
      else xings.set(c.e, [c]);
    }
    const bans = new Map<number, number[]>();
    for (const b of json.banned) {
      const list = bans.get(b[0]);
      if (list) list.push(b[1], b[2]);
      else bans.set(b[0], [b[1], b[2]]);
    }
    this.add({
      v: 1,
      nodes: json.nodes.map((n, i) => [i, n]),
      edges: json.edges.map((e, i) => {
        const x = xings.get(i);
        const bn = bans.get(i);
        return [i, x || bn ? { ...e, x: x ?? e.x, bn: bn ?? e.bn } : e];
      }),
      signals: json.signals.map((c, i) => [i, c]),
    });
  }

  private stubNode(id: number, p: number[], at: number): Node {
    const node: Node = { id, x: p[at], y: p[at + 1], z: p[at + 2], gx: 0, gz: 0, ctrl: CTRL.NONE, arms: [], sc: -1, fr: [], tc: 0, osm: 0, shape: null, stub: true };
    this.nodes[id] = node;
    this.allNodes.add(node);
    return node;
  }

  private newArm(node: Node, edge: Edge, out: boolean): Arm {
    return {
      node,
      edge,
      out,
      idx: 0,
      role: ROLE.NONE,
      sg: -1,
      stopS: out ? edge.cutA : edge.cutB,
      cut: out ? edge.cutA : edge.cutB,
      dx: 1,
      dz: 0,
      ang: 0,
      half: edge.width / 2,
      swL: out ? edge.swL : edge.swR,
      swR: out ? edge.swR : edge.swL,
      isApproach: out ? edge.lanesB > 0 : edge.lanesF > 0,
      isExit: out ? edge.lanesF > 0 : edge.lanesB > 0,
    };
  }

  private addEdge(id: number, ej: EdgeJson): Edge {
    const p = ej.q ? edgePoints(ej.q) : ej.p;
    const pl = makePolyline(Float64Array.from(p));
    const a = this.nodes[ej.a] ?? this.stubNode(ej.a, p, 0);
    const b = this.nodes[ej.b] ?? this.stubNode(ej.b, p, p.length - 3);
    const e: Edge = {
      id,
      a,
      b,
      cls: ej.c,
      tier: CLASS_TIER[ej.c],
      name: ej.n ?? '',
      ref: ej.r ?? '',
      pl,
      len: pl.len,
      lanesF: ej.lf,
      lanesB: ej.lb,
      laneW: ej.lw,
      width: ej.w,
      margin: ej.mg ?? 0,
      maxF: ej.mf,
      maxB: ej.mb,
      zone: ej.z ?? 0,
      surf: ej.s ?? SURF.ASPHALT,
      swL: ej.sl ?? 0,
      swR: ej.sr ?? 0,
      flags: ej.f,
      access: ej.ac ?? 0,
      cutA: ej.ca,
      cutB: ej.cb,
      layer: ej.ly ?? 0,
      turnF: ej.tf ?? '',
      turnB: ej.tb ?? '',
      osm: ej.o ?? 0,
      armA: null as unknown as Arm,
      armB: null as unknown as Arm,
      blendA: 0,
      blendB: 0,
      minX: 0,
      maxX: 0,
      minZ: 0,
      maxZ: 0,
      xings: (ej.x ?? []).map((x) => ({ ...x, e: id })),
    };
    e.armA = this.newArm(a, e, true);
    e.armB = this.newArm(b, e, false);
    // (of a junction that is not loaded itself, the roads are kept in the order they came)
    if (a.stub) a.arms.push(e.armA);
    if (b.stub) b.arms.push(e.armB);
    this.edges[id] = e;
    this.allEdges.add(e);
    this.indexEdge(e, true);
    for (const x of e.xings) this.crossings.push(x);
    if (ej.bn) this.banned.set(id, ej.bn);
    return e;
  }

  private completeNode(id: number, nj: NodeJson): Node {
    let node = this.nodes[id];
    if (!node) {
      node = { id, x: nj.x, y: nj.y, z: nj.z, gx: 0, gz: 0, ctrl: nj.t, arms: [], sc: -1, fr: [], tc: 0, osm: 0, shape: null, stub: true };
      this.nodes[id] = node;
      this.allNodes.add(node);
    }
    node.x = nj.x;
    node.y = nj.y;
    node.z = nj.z;
    node.gx = nj.gx ?? 0;
    node.gz = nj.gz ?? 0;
    node.ctrl = nj.t;
    node.sc = nj.sc ?? -1;
    node.fr = nj.fr ?? [];
    node.tc = nj.tc ?? 0;
    node.osm = nj.o ?? 0;
    node.stub = false;
    // the arms in their stored (counter-clockwise) order
    const arms: Arm[] = [];
    const seen = new Set<Edge>();
    for (let k = 0; k < nj.arms.length; k++) {
      const aj = nj.arms[k];
      const edge = this.edges[aj.e];
      if (!edge) throw new Error(`junction ${id}: its road ${aj.e} is not part of the piece it came with`);
      // A loop edge (a === b) appears twice: first occurrence is the "out" end.
      const out = edge.a === node && !(edge.b === node && seen.has(edge));
      seen.add(edge);
      const arm = out ? edge.armA : edge.armB;
      arm.idx = k;
      arm.role = aj.r;
      arm.sg = aj.g ?? -1;
      arm.stopS = Math.max(aj.sl ?? 0, arm.cut);
      arms.push(arm);
    }
    node.arms = arms;
    for (const arm of arms) computeArmDirection(arm);
    node.shape = buildJunctionShape(node);
    if (node.shape) this.nodeGrid.insertBox(node.shape.minX, node.shape.minZ, node.shape.maxX, node.shape.maxZ, node);
    return node;
  }

  /**
   * Add a piece of the network: the junctions of a chunk and every road at
   * them.  Roads that are there already (they came with the chunk beside)
   * are kept; junctions known only as the far end of such a road become
   * whole.  Returns the new roads and the junctions that are whole now –
   * for whoever keeps something for each of them (the lanes, the signals).
   */
  add(chunk: WorldChunkJson): WorldChange {
    const change: WorldChange = { edges: [], nodes: [] };
    for (const [id, c] of chunk.signals) this.signals[id] = c;
    for (const [id, ej] of chunk.edges) if (!this.edges[id]) change.edges.push(this.addEdge(id, ej));
    for (const [id, nj] of chunk.nodes) {
      const have = this.nodes[id];
      if (have && !have.stub) continue;
      change.nodes.push(this.completeNode(id, nj));
    }
    // (the far ends of the new roads: which way they leave, for whoever looks)
    for (const e of change.edges) {
      if (e.a.stub) computeArmDirection(e.armA);
      if (e.b.stub) computeArmDirection(e.armB);
    }
    return change;
  }

  /**
   * Take a piece of the network away again: these junctions (those of a
   * chunk).  A road goes when the junctions at both its ends are gone; a
   * junction with a road that stays is kept as the end of that road.
   * Returns what went – to be told to whoever keeps something for it,
   * BEFORE this is called if they need to look at it once more.
   */
  remove(nodeIds: Iterable<number>): WorldChange {
    const change: WorldChange = { edges: [], nodes: [] };
    const touched = new Set<Node>();
    for (const id of nodeIds) {
      const node = this.nodes[id];
      if (!node || node.stub) continue;
      if (node.shape) this.nodeGrid.removeBox(node.shape.minX, node.shape.minZ, node.shape.maxX, node.shape.maxZ, node);
      node.shape = null;
      node.stub = true;
      change.nodes.push(node);
      touched.add(node);
    }
    for (const node of touched) {
      for (const arm of [...node.arms]) {
        const e = arm.edge;
        if (!this.edges[e.id] || !e.a.stub || !e.b.stub) continue;
        // both ends are gone: the road goes
        this.indexEdge(e, false);
        delete this.edges[e.id];
        this.allEdges.delete(e);
        this.banned.delete(e.id);
        for (const x of e.xings) {
          const i = this.crossings.indexOf(x);
          if (i >= 0) {
            this.crossings[i] = this.crossings[this.crossings.length - 1];
            this.crossings.pop();
          }
        }
        for (const end of [e.armA, e.armB]) {
          const i = end.node.arms.indexOf(end);
          if (i >= 0) end.node.arms.splice(i, 1);
          touched.add(end.node);
        }
        change.edges.push(e);
      }
    }
    for (const node of touched) {
      if (node.stub && node.arms.length === 0) {
        delete this.nodes[node.id];
        this.allNodes.delete(node);
      }
    }
    return change;
  }

  /** Compute the cached geometry of an edge and index its segments (`on`), or take it out of the index again. */
  private indexEdge(e: Edge, on: boolean): void {
    const usable = Math.max(0, e.len - e.cutA - e.cutB);
    e.blendA = Math.min(14, usable * 0.45);
    e.blendB = Math.min(14, usable * 0.45);
    const pts = e.pl.pts;
    const n = e.pl.cum.length;
    const pad = e.width / 2 + Math.max(e.swL, e.swR) + 1;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 3];
      const z = pts[i * 3 + 2];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
      if (i < n - 1) {
        const x2 = pts[i * 3 + 3];
        const z2 = pts[i * 3 + 5];
        const x0 = Math.min(x, x2) - pad;
        const z0 = Math.min(z, z2) - pad;
        const x1 = Math.max(x, x2) + pad;
        const z1 = Math.max(z, z2) + pad;
        if (on) this.segGrid.insertBox(x0, z0, x1, z1, e.id * 4096 + i);
        else this.segGrid.removeBox(x0, z0, x1, z1, e.id * 4096 + i);
      }
    }
    e.minX = minX - pad;
    e.maxX = maxX + pad;
    e.minZ = minZ - pad;
    e.maxZ = maxZ + pad;
  }

  isBanned(from: Edge, via: Node, to: Edge): boolean {
    const list = this.banned.get(from.id);
    if (!list) return false;
    for (let i = 0; i < list.length; i += 2) if (list[i] === via.id && list[i + 1] === to.id) return true;
    return false;
  }

  /** Height of the junction plane of `node` at (x,z). */
  planeY(node: Node, x: number, z: number): number {
    return node.y + node.gx * (x - node.x) + node.gz * (z - node.z);
  }

  /** Road surface height on `edge` at station s for ground point (x,z). */
  edgeY(edge: Edge, s: number, x: number, z: number): number {
    samplePolyline(edge.pl, s, tmpSample);
    let y = tmpSample.y;
    const sa = s - edge.cutA;
    if (sa < edge.blendA) {
      const w = edge.blendA > 0 ? 1 - smoothstep(0, edge.blendA, sa) : sa <= 0 ? 1 : 0;
      if (w > 0) y += (this.planeY(edge.a, x, z) - y) * w;
    }
    const sb = edge.len - s - edge.cutB;
    if (sb < edge.blendB) {
      const w = edge.blendB > 0 ? 1 - smoothstep(0, edge.blendB, sb) : sb <= 0 ? 1 : 0;
      if (w > 0) y += (this.planeY(edge.b, x, z) - y) * w;
    }
    return y;
  }

  private bestY = 0;
  private bestScore = 0;
  private bestFound = false;

  /**
   * Candidate selection for `surfaceAt`: where decks overlap, the highest
   * surface that is not above the reference wins; on the same level the
   * smaller lateral score (more "inside" its road) wins.
   */
  private consider(
    out: SurfaceHit,
    y: number,
    score: number,
    edge: Edge | null,
    node: Node | null,
    s: number,
    off: number,
    zone: number,
    surf: number,
  ): void {
    if (this.bestFound) {
      const dy = y - this.bestY;
      if (dy < -1.5) return;
      if (dy <= 1.5 && score >= this.bestScore) return;
    }
    this.bestFound = true;
    this.bestY = y;
    this.bestScore = score;
    out.y = y;
    out.edge = edge;
    out.node = node;
    out.s = s;
    out.off = off;
    out.zone = zone;
    out.surf = surf;
  }

  /**
   * Road surface under (x,z).  `yRef` picks the right deck where roads cross
   * at different levels (surfaces more than 1.6 m above it are ignored).
   * Returns false (out.zone = 2) when the point is not on any road or
   * sidewalk — the caller then falls back to the terrain.
   */
  surfaceAt(x: number, z: number, yRef: number, out: SurfaceHit): boolean {
    this.bestFound = false;
    out.edge = null;
    out.node = null;
    out.zone = 2;
    const ceiling = yRef + 1.6;

    // 1) junction carriageway polygons
    const nodes = this.nodeGrid.at(x, z);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const sh = node.shape!;
      if (x < sh.minX || x > sh.maxX || z < sh.minZ || z > sh.maxZ) continue;
      if (!pointInRing(x, z, sh.ring)) continue;
      const y = this.planeY(node, x, z);
      if (y > ceiling) continue;
      this.consider(out, y, -50, null, node, 0, 0, 0, SURF.ASPHALT);
    }

    // 2) edges: carriageway between the cuts, plus sidewalks
    const segs = this.segGrid.at(x, z);
    for (let i = 0; i < segs.length; i++) {
      const code = segs[i];
      const edge = this.edges[(code / 4096) | 0];
      if (x < edge.minX || x > edge.maxX || z < edge.minZ || z > edge.maxZ) continue;
      const seg = code % 4096;
      projectOnPolyline(edge.pl, x, z, tmpProj, seg, seg);
      const s = tmpProj.s;
      const off = tmpProj.off;
      const absOff = Math.abs(off);
      const half = edge.width / 2;
      const sw = off > 0 ? edge.swL : edge.swR;
      const reach = half + sw;
      if (absOff > reach) continue;
      const cum = edge.pl.cum;
      const clampedStart = s <= cum[seg] + 1e-6;
      const clampedEnd = s >= cum[seg + 1] - 1e-6;
      // lateral distance used for ranking: for a projection clamped to a
      // segment end it is the true distance to that vertex – the
      // perpendicular offset alone would make far-away segments look close
      let lateral = absOff;
      if (clampedStart || clampedEnd) {
        const interior = clampedStart ? seg > 0 : seg < cum.length - 2;
        if (interior) {
          // outer side of a bend: round join around the vertex
          if (tmpProj.d2 > reach * reach) continue;
          lateral = Math.sqrt(tmpProj.d2);
        } else if (tmpProj.d2 > absOff * absOff + 0.04) {
          continue; // beyond the physical end of the road
        }
      }
      const inJunctionZone = s < edge.cutA || s > edge.len - edge.cutB;
      if (inJunctionZone && lateral > half) continue; // corner sidewalks are handled below
      let y = this.edgeY(edge, s, x, z);
      const onSidewalk = lateral > half;
      if (onSidewalk) y += KERB_H;
      if (y > ceiling) continue;
      this.consider(
        out,
        y,
        lateral - half + (onSidewalk ? 2 : 0) + (inJunctionZone ? 1 : 0),
        edge,
        null,
        s,
        off,
        onSidewalk ? 1 : 0,
        onSidewalk ? SURF.PAVING : edge.surf,
      );
    }

    // 3) sidewalks around junction corners
    if (!this.bestFound || out.zone !== 0) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const sh = node.shape!;
        const pad = 3.5;
        if (x < sh.minX - pad || x > sh.maxX + pad || z < sh.minZ - pad || z > sh.maxZ + pad) continue;
        for (let c = 0; c < sh.corners.length; c++) {
          const corner = sh.corners[c];
          if (corner.swA <= 0 && corner.swB <= 0) continue;
          if (!pointNearKerb(x, z, corner)) continue;
          const y = this.planeY(node, x, z) + KERB_H;
          if (y > ceiling) continue;
          this.consider(out, y, 3, null, node, 0, 0, 1, SURF.PAVING);
        }
      }
    }
    return this.bestFound;
  }

  /**
   * Map-match a point to the road network: nearest edge by lateral distance
   * within `maxDist` metres of its carriageway edge.  Returns false if none.
   */
  locate(x: number, z: number, yRef: number, maxDist: number, out: SurfaceHit): boolean {
    let best = Infinity;
    let found = false;
    const visit = (code: number): void => {
      const edge = this.edges[(code / 4096) | 0];
      const seg = code % 4096;
      projectOnPolyline(edge.pl, x, z, tmpProj, seg, seg);
      const d = Math.sqrt(tmpProj.d2) - edge.width / 2;
      if (d > maxDist) return;
      samplePolyline(edge.pl, tmpProj.s, tmpSample, seg);
      const dy = Math.abs(tmpSample.y - yRef);
      if (dy > 4.5) return;
      const score = d + dy * 0.5;
      if (score < best) {
        best = score;
        found = true;
        out.edge = edge;
        out.s = tmpProj.s;
        out.off = tmpProj.off;
        out.y = tmpSample.y;
        out.zone = Math.abs(tmpProj.off) <= edge.width / 2 ? 0 : 2;
        out.surf = edge.surf;
        out.node = null;
      }
    };
    this.segGrid.queryBox(x - maxDist, z - maxDist, x + maxDist, z + maxDist, visit);
    return found;
  }

  /**
   * Nearest road footprint (carriageway + sidewalks) to a ground point, used
   * to shape the terrain around roads.  `out.off` holds the distance OUTSIDE
   * the footprint (0 when inside), `out.y` the road surface height there.
   * Edges with any of the `skipFlags` are ignored.
   */
  nearestRoad(x: number, z: number, maxDist: number, skipFlags: number, out: SurfaceHit): boolean {
    let best = Infinity;
    let bestEdge: Edge | null = null;
    let bestS = 0;
    const c = this.segGrid.cell;
    const x0 = Math.floor((x - maxDist) / c);
    const x1 = Math.floor((x + maxDist) / c);
    const z0 = Math.floor((z - maxDist) / c);
    const z1 = Math.floor((z + maxDist) / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const segs = this.segGrid.at(ix * c + 0.5 * c, iz * c + 0.5 * c);
        for (let i = 0; i < segs.length; i++) {
          const code = segs[i];
          const edge = this.edges[(code / 4096) | 0];
          if (edge.flags & skipFlags) continue;
          const seg = code % 4096;
          projectOnPolyline(edge.pl, x, z, tmpProj, seg, seg);
          const reach = edge.width / 2 + (tmpProj.off > 0 ? edge.swL : edge.swR);
          const d = Math.max(0, Math.sqrt(tmpProj.d2) - reach);
          if (d < best) {
            best = d;
            bestEdge = edge;
            bestS = tmpProj.s;
          }
        }
      }
    }
    if (!bestEdge || best > maxDist) return false;
    out.edge = bestEdge;
    out.node = null;
    out.s = bestS;
    out.off = best;
    out.y = this.edgeY(bestEdge, bestS, x, z);
    out.zone = best <= 0 ? 0 : 2;
    out.surf = bestEdge.surf;
    return true;
  }

  /** Visit the junctions whose area touches the given box (each once). */
  nodesInBox(minX: number, minZ: number, maxX: number, maxZ: number, visit: (n: Node) => void): void {
    const seen = new Set<number>();
    this.nodeGrid.queryBox(minX, minZ, maxX, maxZ, (n) => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      const sh = n.shape!;
      if (sh.maxX < minX || sh.minX > maxX || sh.maxZ < minZ || sh.minZ > maxZ) return;
      visit(n);
    });
  }

  /** Visit the pieces of centre line near the given box: (edge, index of the segment) – a piece may come more than once. */
  segmentsInBox(minX: number, minZ: number, maxX: number, maxZ: number, visit: (e: Edge, seg: number) => void): void {
    this.segGrid.queryBox(minX, minZ, maxX, maxZ, (code) => visit(this.edges[(code / 4096) | 0], code % 4096));
  }

  /** Visit edges whose padded bounding box touches the given box. */
  edgesInBox(minX: number, minZ: number, maxX: number, maxZ: number, visit: (e: Edge) => void): void {
    const seen = new Set<number>();
    this.segGrid.queryBox(minX, minZ, maxX, maxZ, (code) => {
      const id = (code / 4096) | 0;
      if (seen.has(id)) return;
      seen.add(id);
      visit(this.edges[id]);
    });
  }
}

/** Is (x,z) on the sidewalk strip behind a junction kerb line? */
function pointNearKerb(x: number, z: number, c: JunctionCorner): boolean {
  const k = c.kerb;
  const n = k.length / 2;
  let best = Infinity;
  let bestT = 0;
  let side = 0;
  let total = 0;
  let acc = 0;
  for (let i = 0; i < n - 1; i++) total += Math.hypot(k[i * 2 + 2] - k[i * 2], k[i * 2 + 3] - k[i * 2 + 1]);
  if (total < 1e-6) return false;
  for (let i = 0; i < n - 1; i++) {
    const ax = k[i * 2];
    const az = k[i * 2 + 1];
    const dx = k[i * 2 + 2] - ax;
    const dz = k[i * 2 + 3] - az;
    const l2 = dx * dx + dz * dz;
    const l = Math.sqrt(l2);
    let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x - (ax + dx * t);
    const ez = z - (az + dz * t);
    const d2 = ex * ex + ez * ez;
    if (d2 < best) {
      best = d2;
      bestT = (acc + l * t) / total;
      // The kerb is part of the counter-clockwise junction ring, so the
      // carriageway is on its left and the block (sidewalk) on its RIGHT.
      // left-of-(dx,dz) is (dz,-dx): positive = left.
      side = ex * dz - ez * dx;
    }
    acc += l;
  }
  if (side >= 0) return false;
  const w = c.swA + (c.swB - c.swA) * bestT;
  return best <= w * w;
}

/**
 * Pipeline helper: create a `World` whose cuts have not been computed yet,
 * compute them, and write them back into the JSON.
 */
export function computeAllCuts(json: WorldJson): void {
  // first pass with zero cuts to get linked structures
  for (const e of json.edges) {
    e.ca = 0;
    e.cb = 0;
  }
  const w = new World(json);
  for (const node of w.nodes) {
    computeJunctionCuts(node);
    json.nodes[node.id].fr = node.fr.map((r) => Math.round(r * 100) / 100);
    for (const arm of node.arms) {
      const ej = json.edges[arm.edge.id];
      const c = Math.round(arm.cut * 100) / 100;
      if (arm.out) ej.ca = c;
      else ej.cb = c;
    }
  }
  // an edge shorter than the sum of its cuts keeps a sliver of ribbon
  for (const e of json.edges) {
    const len = makePolyline(e.p).len;
    if (e.ca + e.cb > len - 0.2) {
      const k = Math.max(0, len - 0.2) / (e.ca + e.cb);
      e.ca = Math.floor(e.ca * k * 100) / 100;
      e.cb = Math.floor(e.cb * k * 100) / 100;
    }
  }
}

export function hasFlag(e: Edge, flag: number): boolean {
  return (e.flags & flag) !== 0;
}

export { CTRL, EF, ROLE };
