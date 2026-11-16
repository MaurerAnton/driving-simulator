// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lane-level network derived from the road graph: driving lanes on every
 * edge, connectors through every junction, who has to give way to whom, and
 * shortest-path routing.  Used by the traffic simulation, the rule monitor
 * and the navigation hints.
 */
import { angleOf, clamp, makePolyline, newPolySample, projectOnPolyline, samplePolyline, segSeg, wrapAngle } from '../core/geom.ts';
import type { PolySample, Polyline3 } from '../core/geom.ts';
import { ACCESS, CLS, CTRL, EF, ROLE } from './types.ts';
import type { Arm, Edge, Node, World } from './world.ts';

export const TURN = { STRAIGHT: 0, LEFT: 1, RIGHT: 2, UTURN: 3 } as const;

export interface Lane {
  id: number;
  edge: Edge;
  /** +1 travels a→b, -1 travels b→a */
  dir: number;
  /** 0 = right-most lane of its direction */
  idx: number;
  /** number of lanes in this direction */
  count: number;
  /** lateral offset of the lane centre from the edge centreline (+ = left of a→b) */
  off: number;
  width: number;
  /** edge stations where the lane starts and ends (in travel order) */
  s0: number;
  s1: number;
  len: number;
  from: Node;
  to: Node;
  /** arm of `to` this lane arrives on / arm of `from` it leaves by */
  armTo: Arm;
  armFrom: Arm;
  out: Connector[];
  in: Connector[];
  /** speed limit in m/s (Infinity = none) */
  limit: number;
  /** distance from the lane start to the stop/yield line before `to` */
  stopAt: number;
}

export interface Conflict {
  other: Connector;
  /** distance along this connector / the other one to the conflict point */
  sSelf: number;
  sOther: number;
  merge: boolean;
  /** this connector has to give way to `other` */
  yield: boolean;
}

export interface Sibling {
  other: Connector;
  until: number;
  untilOther: number;
}

export interface Connector {
  id: number;
  node: Node;
  from: Lane;
  to: Lane;
  turn: number;
  pl: Polyline3;
  len: number;
  /** the paths through the junction this one crosses or merges with (worked out when first asked for) */
  readonly conflicts: Conflict[];
  /** connectors leaving the same lane, with the stations up to which the two paths overlap */
  readonly siblings: Sibling[];
}

/**
 * A path through a junction.  Which other paths it conflicts with is costly
 * to find (every pair of paths of the junction is compared) and only matters
 * where traffic actually is – so it is worked out for a junction when one of
 * its paths is first asked, not for the whole map at the start.
 */
class JunctionPath implements Connector {
  readonly id: number;
  readonly node: Node;
  readonly from: Lane;
  readonly to: Lane;
  readonly turn: number;
  readonly pl: Polyline3;
  readonly len: number;
  /** filled by LaneGraph.resolveNode */
  readonly foundConflicts: Conflict[] = [];
  readonly foundSiblings: Sibling[] = [];
  private readonly graph: LaneGraph;

  constructor(graph: LaneGraph, id: number, node: Node, from: Lane, to: Lane, turn: number, pl: Polyline3) {
    this.graph = graph;
    this.id = id;
    this.node = node;
    this.from = from;
    this.to = to;
    this.turn = turn;
    this.pl = pl;
    this.len = pl.len;
  }

  get conflicts(): Conflict[] {
    this.graph.resolveNode(this.node.id);
    return this.foundConflicts;
  }

  get siblings(): Sibling[] {
    this.graph.resolveNode(this.node.id);
    return this.foundSiblings;
  }
}

const tmpA = newPolySample();
const tmpB = newPolySample();

/** A point on the centre line of a lane (or of a path through a junction) and how far it is from what was asked about. */
export interface PathFoot {
  x: number;
  z: number;
  d: number;
}
const pathProj = { s: 0, off: 0, d2: 0, seg: 0 };
const postFoot: PathFoot = { x: 0, z: 0, d: 0 };

/** Position on a lane at distance d from its start. */
export function lanePoint(lane: Lane, d: number, out: PolySample): PolySample {
  const s = lane.s0 + lane.dir * clamp(d, 0, lane.len);
  samplePolyline(lane.edge.pl, s, out);
  const ox = out.tz * lane.off;
  const oz = -out.tx * lane.off;
  out.x += ox;
  out.z += oz;
  if (lane.dir < 0) {
    out.tx = -out.tx;
    out.tz = -out.tz;
  }
  return out;
}

function parseTurns(spec: string, lanes: number): number[] | null {
  if (!spec) return null;
  const parts = spec.split('|');
  if (parts.length !== lanes) return null;
  // result indexed from the right-most lane; bit 1 = straight, 2 = left, 4 = right
  const out: number[] = [];
  for (let i = lanes - 1; i >= 0; i--) {
    const p = parts[i];
    let m = 0;
    if (!p || p === 'none') m = 7;
    else {
      if (/through|merge/.test(p)) m |= 1;
      if (/left/.test(p) && !/merge/.test(p)) m |= 2;
      if (/right/.test(p) && !/merge/.test(p)) m |= 4;
      if (/reverse/.test(p)) m |= 2;
      if (m === 0) m = 7;
    }
    out.push(m);
  }
  return out;
}

function rank(arm: Arm): number {
  switch (arm.role) {
    case ROLE.PRIORITY:
      return 3;
    case ROLE.RBL:
      return 2;
    case ROLE.YIELD:
    case ROLE.STOP:
      return 1;
    default:
      return 0;
  }
}

export class LaneGraph {
  readonly world: World;
  /** by their number – with gaps once parts of the network were taken away again */
  readonly lanes: Lane[] = [];
  readonly connectors: Connector[] = [];
  /** lanes of each edge: [forward lanes right→left, backward lanes right→left] (by the number of the edge) */
  readonly edgeLanes: Array<{ fwd: Lane[]; back: Lane[] }> = [];

  /** the paths through each junction, and which junctions have their conflicts worked out */
  private readonly pathsAt = new Map<number, JunctionPath[]>();
  private readonly resolved = new Set<number>();
  private nextLane = 0;
  private nextPath = 0;

  /** The lanes of everything the world holds; what is added to the world later is added here with `addEdge` and `completeNode`. */
  constructor(world: World) {
    this.world = world;
    for (const e of world.allEdges) this.addEdge(e);
    for (const node of world.allNodes) if (!node.stub) this.completeNode(node);
  }

  /** The lanes of a road that was added to the world. */
  addEdge(e: Edge): void {
    if (this.edgeLanes[e.id]) return;
    const fwd: Lane[] = [];
    const back: Lane[] = [];
    const W = e.width;
    const oR = -W / 2 + e.margin;
    const oD = oR + e.lanesF * e.laneW;
    const sA = e.cutA;
    const sB = e.len - e.cutB;
    const len = Math.max(0, sB - sA);
    for (let k = 0; k < e.lanesF; k++) {
      const lane: Lane = {
        id: this.nextLane++,
        edge: e,
        dir: 1,
        idx: k,
        count: e.lanesF,
        off: oR + (k + 0.5) * e.laneW,
        width: e.laneW,
        s0: sA,
        s1: sB,
        len,
        from: e.a,
        to: e.b,
        armTo: e.armB,
        armFrom: e.armA,
        out: [],
        in: [],
        limit: e.maxF > 0 ? e.maxF / 3.6 : Infinity,
        stopAt: Math.max(0, len - Math.max(0, e.armB.stopS - e.cutB)),
      };
      fwd.push(lane);
      this.lanes[lane.id] = lane;
    }
    for (let k = 0; k < e.lanesB; k++) {
      // right-most backward lane is the left-most seen along a→b
      const off = e.lanesF > 0 ? W / 2 - e.margin - (k + 0.5) * e.laneW : oD + (e.lanesB - k - 0.5) * e.laneW;
      const lane: Lane = {
        id: this.nextLane++,
        edge: e,
        dir: -1,
        idx: k,
        count: e.lanesB,
        off,
        width: e.laneW,
        s0: sB,
        s1: sA,
        len,
        from: e.b,
        to: e.a,
        armTo: e.armA,
        armFrom: e.armB,
        out: [],
        in: [],
        limit: e.maxB > 0 ? e.maxB / 3.6 : Infinity,
        stopAt: Math.max(0, len - Math.max(0, e.armA.stopS - e.cutA)),
      };
      back.push(lane);
      this.lanes[lane.id] = lane;
    }
    this.edgeLanes[e.id] = { fwd, back };
  }

  /** A road was taken out of the world: its lanes go (the paths at its ends went with their junctions). */
  removeEdge(e: Edge): void {
    const el = this.edgeLanes[e.id];
    if (!el) return;
    for (const lane of [...el.fwd, ...el.back]) {
      // (paths of a junction that stays, as the end of another road, cannot lead here any more)
      for (const c of [...lane.out, ...lane.in]) this.dropPath(c as JunctionPath);
      delete this.lanes[lane.id];
    }
    delete this.edgeLanes[e.id];
  }

  private dropPath(c: JunctionPath): void {
    const out = c.from.out.indexOf(c);
    if (out >= 0) c.from.out.splice(out, 1);
    const into = c.to.in.indexOf(c);
    if (into >= 0) c.to.in.splice(into, 1);
    const at = this.pathsAt.get(c.node.id);
    if (at) {
      const i = at.indexOf(c);
      if (i >= 0) at.splice(i, 1);
    }
    const k = this.connectors.indexOf(c);
    if (k >= 0) {
      this.connectors[k] = this.connectors[this.connectors.length - 1];
      this.connectors.pop();
    }
  }

  /** A junction is no longer whole (its piece of the map was taken away): nothing leads through it any more. */
  removeNode(node: Node): void {
    for (const c of [...(this.pathsAt.get(node.id) ?? [])]) this.dropPath(c);
    this.pathsAt.delete(node.id);
    this.resolved.delete(node.id);
  }

  /** Lanes arriving at / leaving the node on an arm. */
  lanesInto(arm: Arm): Lane[] {
    const el = this.edgeLanes[arm.edge.id];
    return arm.out ? el.back : el.fwd;
  }

  lanesOutOf(arm: Arm): Lane[] {
    const el = this.edgeLanes[arm.edge.id];
    return arm.out ? el.fwd : el.back;
  }

  /**
   * A junction is whole (all its roads have their lanes): the paths through
   * it, and where the lanes that arrive at it have to stop.
   */
  completeNode(node: Node): void {
    if (this.pathsAt.has(node.id)) return;
    this.pathsAt.set(node.id, []);
    for (const a of node.arms) {
      for (const lane of this.lanesInto(a)) lane.stopAt = Math.max(0, lane.len - Math.max(0, a.stopS - a.cut));
    }
    {
      const arms = node.arms;
      for (const a of arms) {
        const ins = this.lanesInto(a);
        if (ins.length === 0) continue;
        const inAng = angleOf(-a.dx, -a.dz);
        // candidate exits with their turn type
        const moves: Array<{ arm: Arm; turn: number }> = [];
        for (const b of arms) {
          if (b === a) continue;
          if (this.lanesOutOf(b).length === 0) continue;
          if (this.world.isBanned(a.edge, node, b.edge)) continue;
          const d = wrapAngle(angleOf(b.dx, b.dz) - inAng);
          const ad = Math.abs(d);
          const turn = ad <= 0.62 ? TURN.STRAIGHT : ad > 2.8 ? TURN.UTURN : d > 0 ? TURN.LEFT : TURN.RIGHT;
          moves.push({ arm: b, turn });
        }
        if (moves.length === 0 && arms.length === 1 && this.lanesOutOf(a).length > 0) {
          moves.push({ arm: a, turn: TURN.UTURN }); // turn round at the end of a cul-de-sac
        }
        if (moves.length === 0) continue;
        // at a fork without a straight option the gentlest branch counts as "straight on"
        if (arms.length > 2 && !moves.some((m) => m.turn === TURN.STRAIGHT)) {
          let best = -1;
          let bestAd = 1.05;
          moves.forEach((m, i) => {
            const ad = Math.abs(wrapAngle(angleOf(m.arm.dx, m.arm.dz) - inAng));
            if (ad < bestAd) {
              bestAd = ad;
              best = i;
            }
          });
          if (best >= 0) moves[best].turn = TURN.STRAIGHT;
        }
        const n = ins.length;
        const hasS = moves.some((m) => m.turn === TURN.STRAIGHT);
        const tagged = parseTurns(a.out ? a.edge.turnB : a.edge.turnF, n);
        const allowed = (laneIdx: number, turn: number): boolean => {
          if (arms.length <= 2) return true;
          const bit = turn === TURN.STRAIGHT ? 1 : turn === TURN.RIGHT ? 4 : 2;
          if (tagged) return (tagged[laneIdx] & bit) !== 0;
          if (n === 1) return true;
          if (turn === TURN.STRAIGHT) return true;
          if (turn === TURN.RIGHT) return laneIdx === 0;
          return laneIdx === n - 1; // left and U-turn from the left-most lane
        };
        void hasS;
        for (const lane of ins) {
          let made = 0;
          const connect = (force: boolean): void => {
            for (const m of moves) {
              if (!force && !allowed(lane.idx, m.turn)) continue;
              const outs = this.lanesOutOf(m.arm);
              const target =
                m.turn === TURN.RIGHT
                  ? outs[0]
                  : m.turn === TURN.LEFT || m.turn === TURN.UTURN
                    ? outs[outs.length - 1]
                    : outs[Math.min(lane.idx, outs.length - 1)];
              this.addConnector(node, lane, target, m.turn);
              made++;
            }
          };
          connect(false);
          if (made === 0) connect(true); // never strand a lane
        }
      }
    }
  }

  private addConnector(node: Node, from: Lane, to: Lane, turn: number): void {
    lanePoint(from, from.len, tmpA);
    lanePoint(to, 0, tmpB);
    const ax = tmpA.x;
    const az = tmpA.z;
    const bx = tmpB.x;
    const bz = tmpB.z;
    const dist = Math.hypot(bx - ax, bz - az);
    const pts: number[] = [];
    const world = this.world;
    if (dist < 0.3) {
      pts.push(ax, world.planeY(node, ax, az), az, bx, world.planeY(node, bx, bz), bz);
    } else {
      const k = turn === TURN.UTURN ? clamp(dist * 0.9, 3, 9) : clamp(dist * 0.42, 0.5, 22);
      const c1x = ax + tmpA.tx * k;
      const c1z = az + tmpA.tz * k;
      const c2x = bx - tmpB.tx * k;
      const c2z = bz - tmpB.tz * k;
      const steps = Math.max(2, Math.min(16, Math.ceil(dist / 1.6)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        const x = u * u * u * ax + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * bx;
        const z = u * u * u * az + 3 * u * u * t * c1z + 3 * u * t * t * c2z + t * t * t * bz;
        pts.push(x, world.planeY(node, x, z), z);
      }
    }
    const pl = makePolyline(Float64Array.from(pts));
    const c = new JunctionPath(this, this.nextPath++, node, from, to, turn, pl);
    this.connectors.push(c);
    const at = this.pathsAt.get(node.id);
    if (at) at.push(c);
    else this.pathsAt.set(node.id, [c]);
    from.out.push(c);
    to.in.push(c);
  }

  /** Must connector `c1` give way to `c2`? */
  private yields(c1: Connector, c2: Connector, merge: boolean): boolean {
    const a1 = c1.from.armTo;
    const a2 = c2.from.armTo;
    const node = c1.node;
    if (a1 === a2) {
      // two lanes of one carriageway running into one: the lane that ends gives way
      return merge && c1.from.idx > c2.from.idx;
    }
    if (node.ctrl === CTRL.SIGNALS && a1.sg >= 0 && a2.sg >= 0) {
      // both signal-controlled: only permissive conflicts within the same green remain
      if (a1.sg !== a2.sg) return false;
    } else {
      const r1 = rank(a1);
      const r2 = rank(a2);
      if (r1 !== r2) return r1 < r2;
    }
    const opposite = a1.dx * a2.dx + a1.dz * a2.dz < -0.64;
    const turning1 = c1.turn === TURN.LEFT || c1.turn === TURN.UTURN;
    const turning2 = c2.turn === TURN.LEFT || c2.turn === TURN.UTURN;
    if (opposite || a1.role === ROLE.PRIORITY) {
      // § 9 (3): turning left, let oncoming traffic through
      if (turning1 && !turning2) return true;
      if (!turning1 && turning2) return false;
      if (turning1 && turning2) return false; // both turn left: pass in front of each other
      if (merge) return c1.turn !== TURN.STRAIGHT && c2.turn === TURN.STRAIGHT;
      return false;
    }
    // equal standing, crossing roads: the one coming from the right goes first
    const rx = a1.dz; // right of travel direction (-dx,-dz) is (dz,-dx)
    const rz = -a1.dx;
    const side = a2.dx * rx + a2.dz * rz;
    if (side > 0.25) return true;
    if (side < -0.25) return false;
    return turning1 && !turning2;
  }

  /** Work out the conflicts of every junction now (tools and tests; the game leaves it to resolveNode). */
  resolveAll(): void {
    for (const id of this.pathsAt.keys()) this.resolveNode(id);
  }

  /** Compare the paths through a junction with each other: where do they cross, merge or share their way, and who yields? */
  resolveNode(nodeId: number): void {
    if (this.resolved.has(nodeId)) return;
    this.resolved.add(nodeId);
    const list = this.pathsAt.get(nodeId);
    if (!list) return;
    {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const c1 = list[i];
          const c2 = list[j];
          if (c1.from === c2.from) {
            // diverging from one lane: no right-of-way question, but the paths share their first metres
            const u1 = divergence(c1.pl, c2.pl);
            const u2 = divergence(c2.pl, c1.pl);
            c1.foundSiblings.push({ other: c2, until: u1, untilOther: u2 });
            c2.foundSiblings.push({ other: c1, until: u2, untilOther: u1 });
            continue;
          }
          const sameArm = c1.from.armTo === c2.from.armTo;
          let s1 = -1;
          let s2 = -1;
          let merge = false;
          if (c1.to === c2.to) {
            // merging paths conflict from where they come too close to pass side by side
            merge = true;
            s1 = convergence(c1.pl, c2.pl, 2.4);
            s2 = convergence(c2.pl, c1.pl, 2.4);
          } else if (c1.len > 0.5 && c2.len > 0.5) {
            const hit = sameArm ? null : firstCrossing(c1.pl, c2.pl);
            if (hit) {
              s1 = hit[0];
              s2 = hit[1];
            } else {
              // paths that never intersect but squeeze past each other closer than a car is wide
              const p1 = convergence(c1.pl, c2.pl, 1.9);
              if (p1 < c1.len) {
                s1 = p1;
                s2 = convergence(c2.pl, c1.pl, 1.9);
                merge = true;
              }
            }
          }
          if (s1 < 0) continue;
          const y12 = this.yields(c1, c2, merge);
          const y21 = !y12 && this.yields(c2, c1, merge);
          c1.foundConflicts.push({ other: c2, sSelf: s1, sOther: s2, merge, yield: y12 });
          c2.foundConflicts.push({ other: c1, sSelf: s2, sOther: s1, merge, yield: y21 });
        }
      }
    }
  }

  /**
   * The nearest centre line of a lane, or of a path through a junction, to a
   * point – on the same level (`y`; NaN: on any).  Returns the distance and
   * writes the foot point to `out`; Infinity when none is closer than `reach`.
   * What stands closer to such a line than a vehicle is wide is in the way.
   */
  nearestPath(x: number, z: number, y: number, reach: number, out: PathFoot): number {
    let best = reach;
    let found = false;
    const proj = pathProj;
    const smp = tmpA;
    this.world.segmentsInBox(x - reach, z - reach, x + reach, z + reach, (e, seg) => {
      const el = this.edgeLanes[e.id];
      if (el.fwd.length + el.back.length === 0) return;
      projectOnPolyline(e.pl, x, z, proj, seg, seg);
      const far = e.width / 2 + best;
      if (proj.d2 > far * far) return;
      // (the lanes run between the junction areas at the two ends)
      samplePolyline(e.pl, clamp(proj.s, e.cutA, Math.max(e.cutA, e.len - e.cutB)), smp);
      if (!Number.isNaN(y) && Math.abs(smp.y - y) > 2.6) return;
      for (let side = 0; side < 2; side++) {
        const list = side === 0 ? el.fwd : el.back;
        for (let i = 0; i < list.length; i++) {
          const px = smp.x + smp.tz * list[i].off;
          const pz = smp.z - smp.tx * list[i].off;
          const d = Math.hypot(x - px, z - pz);
          if (d < best) {
            best = d;
            out.x = px;
            out.z = pz;
            found = true;
          }
        }
      }
    });
    this.world.nodesInBox(x - reach, z - reach, x + reach, z + reach, (node) => {
      if (!Number.isNaN(y) && Math.abs(this.world.planeY(node, x, z) - y) > 2.6) return;
      const paths = this.pathsAt.get(node.id);
      if (!paths) return;
      for (let i = 0; i < paths.length; i++) {
        projectOnPolyline(paths[i].pl, x, z, proj);
        if (proj.d2 >= best * best) continue;
        best = Math.sqrt(proj.d2);
        samplePolyline(paths[i].pl, proj.s, smp);
        out.x = smp.x;
        out.z = smp.z;
        found = true;
      }
    });
    out.d = found ? best : Infinity;
    return out.d;
  }

  /** Does a wall from (x1, z1) to (x2, z2) come closer than `need` to the middle of a lane (on the level `y`; NaN: on any)? */
  wallInLane(x1: number, z1: number, x2: number, z2: number, y: number, need: number): boolean {
    const world = this.world;
    const minX = Math.min(x1, x2) - need;
    const maxX = Math.max(x1, x2) + need;
    const minZ = Math.min(z1, z2) - need;
    const maxZ = Math.max(z1, z2) + need;
    const need2 = need * need;
    let hit = false;
    world.segmentsInBox(minX, minZ, maxX, maxZ, (e, seg) => {
      if (hit) return;
      const el = this.edgeLanes[e.id];
      if (el.fwd.length + el.back.length === 0) return;
      const p = e.pl.pts;
      const ax = p[seg * 3];
      const ay = p[seg * 3 + 1];
      const az = p[seg * 3 + 2];
      const bx = p[seg * 3 + 3];
      const bz = p[seg * 3 + 5];
      if (!Number.isNaN(y) && Math.abs((ay + p[seg * 3 + 4]) / 2 - y) > 2.6 + Math.abs(ay - p[seg * 3 + 4]) / 2) return;
      // (most pieces of road in reach of the grid are nowhere near the wall)
      const far = e.width / 2 + need;
      if (Math.max(ax, bx) + far < minX + need || Math.min(ax, bx) - far > maxX - need || Math.max(az, bz) + far < minZ + need || Math.min(az, bz) - far > maxZ - need) return;
      const l = Math.hypot(bx - ax, bz - az);
      if (l < 1e-6) return;
      // left of the direction of travel a→b
      const nx = (bz - az) / l;
      const nz = -(bx - ax) / l;
      for (let side = 0; side < 2 && !hit; side++) {
        const list = side === 0 ? el.fwd : el.back;
        for (let i = 0; i < list.length; i++) {
          const o = list[i].off;
          if (segSegDist2(x1, z1, x2, z2, ax + nx * o, az + nz * o, bx + nx * o, bz + nz * o) < need2) {
            hit = true;
            break;
          }
        }
      }
    });
    if (hit) return true;
    world.nodesInBox(minX, minZ, maxX, maxZ, (node) => {
      if (hit) return;
      if (!Number.isNaN(y) && Math.abs(world.planeY(node, (x1 + x2) / 2, (z1 + z2) / 2) - y) > 2.6) return;
      const paths = this.pathsAt.get(node.id);
      if (!paths) return;
      for (let k = 0; k < paths.length && !hit; k++) {
        const p = paths[k].pl.pts;
        for (let i = 0; i + 5 < p.length; i += 3) {
          if (segSegDist2(x1, z1, x2, z2, p[i], p[i + 2], p[i + 3], p[i + 5]) < need2) {
            hit = true;
            break;
          }
        }
      }
    });
    return hit;
  }

  /**
   * Where a post (a sign, a lamp) may stand: the place itself when it keeps
   * `need` metres from the middle of every lane, otherwise the nearest place
   * beside the lanes within a few metres – or null when there is none.
   */
  besideLanes(x: number, z: number, y: number, need: number, out: PathFoot): PathFoot | null {
    out.x = x;
    out.z = z;
    for (let tries = 0; tries < 5; tries++) {
      const d = this.nearestPath(out.x, out.z, y, need, postFoot);
      if (d >= need) {
        out.d = Math.hypot(out.x - x, out.z - z);
        return out;
      }
      // away from the middle of that lane (straight out of it; from dead centre towards where the post came from)
      let ux = out.x - postFoot.x;
      let uz = out.z - postFoot.z;
      if (d < 0.05) {
        ux = x - postFoot.x;
        uz = z - postFoot.z;
        if (Math.hypot(ux, uz) < 0.05) return null;
      }
      const l = Math.hypot(ux, uz);
      out.x = postFoot.x + (ux / l) * (need + 0.15);
      out.z = postFoot.z + (uz / l) * (need + 0.15);
      if (Math.hypot(out.x - x, out.z - z) > 4.5) return null;
    }
    return null;
  }

  /** The paths through a junction. */
  pathsThrough(node: Node): readonly Connector[] {
    return this.pathsAt.get(node.id) ?? [];
  }

  /** May ordinary traffic use this edge in this direction? */
  static drivable(e: Edge, forTraffic: boolean): boolean {
    if (e.access === ACCESS.PRIVATE || e.access === ACCESS.AGRICULTURAL) return false;
    if (forTraffic && (e.tier < 2 || e.laneW < 2.4 || (e.flags & EF.MINOR_SERVICE) !== 0)) return false;
    return true;
  }

  /**
   * Shortest route (by travel time) from the end of lane `start` to any lane
   * of `goal` (`goalDir`: only one that runs a→b (1) or b→a (-1)).  Returns
   * the connectors to take, or null.  `forTraffic` restricts the search to
   * ordinary public roads.
   */
  /** ways are looked for for a truck with a trailer: turns that double back within a few metres are avoided */
  longVehicle = false;
  /** the vehicle may not use the motorway (a tractor): ways do not lead over it */
  noMotorway = false;

  route(start: Lane, goal: Edge, forTraffic = false, goalDir = 0): Connector[] | null {
    const dist = new Map<number, number>();
    const prev = new Map<number, Connector>();
    const heap = new MinHeap();
    dist.set(start.id, 0);
    heap.push(start.id, 0);
    let found: Lane | null = null;
    while (heap.size > 0) {
      const [id, d] = heap.pop();
      if (d > (dist.get(id) ?? Infinity)) continue;
      const lane = this.lanes[id];
      if (lane.edge === goal && lane !== start && (goalDir === 0 || lane.dir === goalDir)) {
        found = lane;
        break;
      }
      for (const c of lane.out) {
        const next = c.to;
        if (next.edge !== goal && !LaneGraph.drivable(next.edge, forTraffic)) continue;
        if (this.noMotorway && next.edge !== goal && next.edge.cls <= CLS.MOTORWAY_LINK) continue;
        const v = Math.min(next.limit, 36);
        // Turning round is for when there is no other way: it needs a turning
        // circle or a three-point turn, and where the map ends (often a fast
        // rural road) it is a last resort.
        const uturn = c.from.to.ctrl === CTRL.MAP_END ? 900 : 150;
        let turnCost = c.turn === TURN.LEFT ? 6 : c.turn === TURN.RIGHT ? 3 : c.turn === TURN.UTURN ? uturn : 0;
        // a long vehicle does not get round a hairpin at a junction: like turning round, a last resort –
        // and for everybody else it is an awkward way to go where there is another
        if (c.turn !== TURN.STRAIGHT && c.turn !== TURN.UTURN && hairpin(c)) turnCost += this.longVehicle ? 400 : 120;
        // two left turns a few metres apart = turning round through a gap in the median
        if (c.turn === TURN.LEFT && lane.len < 15 && prev.get(lane.id)?.turn === TURN.LEFT) turnCost += 150;
        // "Anlieger frei" and car-park shortcuts are not through routes
        const through = next.edge !== goal && (next.edge.access === ACCESS.DESTINATION || (next.edge.flags & EF.MINOR_SERVICE) !== 0) ? 240 : 0;
        const nd = d + c.len / 6 + next.len / Math.max(v, 2) + turnCost + through;
        if (nd < (dist.get(next.id) ?? Infinity)) {
          dist.set(next.id, nd);
          prev.set(next.id, c);
          heap.push(next.id, nd);
        }
      }
    }
    if (!found) return null;
    const path: Connector[] = [];
    let cur: Lane = found;
    while (cur !== start) {
      const c = prev.get(cur.id);
      if (!c) return null;
      path.push(c);
      cur = c.from;
    }
    return path.reverse();
  }
}

/** Does the path through a junction double back (by more than 115°) on a radius under 7 m? */
function hairpin(c: Connector): boolean {
  const p = c.pl.pts;
  const n = p.length / 3;
  if (n < 2 || c.len > 22) return false;
  const ax = p[3] - p[0];
  const az = p[5] - p[2];
  const bx = p[(n - 1) * 3] - p[(n - 2) * 3];
  const bz = p[(n - 1) * 3 + 2] - p[(n - 2) * 3 + 2];
  const la = Math.hypot(ax, az);
  const lb = Math.hypot(bx, bz);
  if (la < 1e-6 || lb < 1e-6) return false;
  const turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb))));
  return turn > 2 && c.len / turn < 7;
}

/** Squared distance of a point from a segment. */
function pointSegDist2(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-12 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = x - (ax + dx * t);
  const ez = z - (az + dz * t);
  return ex * ex + ez * ez;
}

/** Squared distance between two segments in the plane (0 when they cross). */
function segSegDist2(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  // crossing: each segment has the ends of the other on different sides
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(pointSegDist2(ax, az, cx, cz, dx, dz), pointSegDist2(bx, bz, cx, cz, dx, dz), pointSegDist2(cx, cz, ax, az, bx, bz), pointSegDist2(dx, dz, ax, az, bx, bz));
}

/** Station on `a` from which it runs closer than `limit` metres to `b` (the end of `a` if never). */
function convergence(a: Polyline3, b: Polyline3, limit: number): number {
  const proj = { s: 0, off: 0, d2: 0, seg: 0 };
  const smp = newPolySample();
  const steps = Math.max(1, Math.ceil(a.len / 0.6));
  for (let i = 0; i <= steps; i++) {
    const s = (a.len * i) / steps;
    samplePolyline(a, s, smp);
    projectOnPolyline(b, smp.x, smp.z, proj);
    if (proj.d2 < limit * limit) return i === steps && i > 0 && limit < 2 ? a.len : Math.max(0, s - 0.6);
  }
  return a.len;
}

/** Station on `a` up to which it stays within 2.4 m of `b` (both start at the same point). */
function divergence(a: Polyline3, b: Polyline3): number {
  const proj = { s: 0, off: 0, d2: 0, seg: 0 };
  const smp = newPolySample();
  const steps = Math.max(1, Math.ceil(a.len / 0.6));
  for (let i = 0; i <= steps; i++) {
    const s = (a.len * i) / steps;
    samplePolyline(a, s, smp);
    projectOnPolyline(b, smp.x, smp.z, proj);
    if (proj.d2 > 2.4 * 2.4) return s;
  }
  return a.len;
}

/** First intersection of two stride-3 polylines: [station on a, station on b]. */
function firstCrossing(a: Polyline3, b: Polyline3): [number, number] | null {
  const pa = a.pts;
  const pb = b.pts;
  const na = a.cum.length;
  const nb = b.cum.length;
  for (let i = 0; i < na - 1; i++) {
    for (let j = 0; j < nb - 1; j++) {
      const r = segSeg(pa[i * 3], pa[i * 3 + 2], pa[i * 3 + 3], pa[i * 3 + 5], pb[j * 3], pb[j * 3 + 2], pb[j * 3 + 3], pb[j * 3 + 5]);
      if (r) return [a.cum[i] + (a.cum[i + 1] - a.cum[i]) * r[0], b.cum[j] + (b.cum[j + 1] - b.cum[j]) * r[1]];
    }
  }
  return null;
}

class MinHeap {
  private readonly ids: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }

  pop(): [number, number] {
    const ids = this.ids;
    const keys = this.keys;
    const topId = ids[0];
    const topKey = keys[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return [topId, topKey];
  }
}
