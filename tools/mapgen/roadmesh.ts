// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Road geometry: carriageway ribbons, junction areas, kerbs, sidewalks,
 * verges, bridge structures and all painted markings.
 *
 * Heights always come from World.edgeY / World.planeY, i.e. exactly the
 * surface the physics uses.
 */
import earcut from 'earcut';
import { clamp, newPolySample, samplePolyline } from '../../src/core/geom.ts';
import { GM } from '../../src/world/tilefmt.ts';
import { CLS, CTRL, EF, KERB_H, ROLE, SURF, XING } from '../../src/world/types.ts';
import type { Arm, Edge, Node, World } from '../../src/world/world.ts';
import { addBand, addQuad, addTriangles } from './meshacc.ts';
import type { TileSet } from './meshacc.ts';

const PAINT_LIFT = 0.018;
const CONCRETE: [number, number, number] = [168, 166, 160];
const STEEL: [number, number, number] = [132, 138, 142];

const SURF_TO_GM: number[] = [GM.ASPHALT, GM.CONCRETE, GM.PAVING, GM.SETT, GM.GRAVEL, GM.DIRT, GM.GRASS];

interface Station {
  s: number;
  x: number;
  z: number;
  /** left normal (unit) and mitre scale */
  nx: number;
  nz: number;
  scale: number;
}

const tmp = newPolySample();

function segDir(e: Edge, seg: number): [number, number] {
  const p = e.pl.pts;
  const n = e.pl.cum.length;
  const i = clamp(seg, 0, n - 2);
  const dx = p[i * 3 + 3] - p[i * 3];
  const dz = p[i * 3 + 5] - p[i * 3 + 2];
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

/** Direction of the *other* arm at a plain 2-arm joint, pointing away from the node. */
function jointPartnerDir(node: Node, self: Arm): [number, number] | null {
  if (node.arms.length !== 2 || self.cut > 1e-3) return null;
  const other = node.arms[0] === self ? node.arms[1] : node.arms[0];
  if (other.cut > 1e-3) return null;
  const oe = other.edge;
  const d = segDir(oe, other.out ? 0 : oe.pl.cum.length - 2);
  return other.out ? d : [-d[0], -d[1]];
}

/** Stations along an edge between s0 and s1 with mitred normals at polyline vertices. */
function stationsOf(e: Edge, s0: number, s1: number, maxStep: number): Station[] {
  const out: Station[] = [];
  const cum = e.pl.cum;
  const n = cum.length;
  const push = (s: number, tx: number, tz: number, scale: number): void => {
    samplePolyline(e.pl, s, tmp);
    out.push({ s, x: tmp.x, z: tmp.z, nx: tz, nz: -tx, scale });
  };
  const atVertex = (i: number): void => {
    let tx: number;
    let tz: number;
    let scale = 1;
    if (i > 0 && i < n - 1) {
      const a = segDir(e, i - 1);
      const b = segDir(e, i);
      tx = a[0] + b[0];
      tz = a[1] + b[1];
      const l = Math.hypot(tx, tz);
      if (l < 1e-6) {
        tx = a[0];
        tz = a[1];
      } else {
        tx /= l;
        tz /= l;
        scale = Math.min(2.2, 1 / Math.max(tx * a[0] + tz * a[1], 0.2));
      }
    } else {
      // edge end: at plain joints use the bisector with the continuing road
      const first = i === 0;
      const d = segDir(e, first ? 0 : n - 2);
      const partner = jointPartnerDir(first ? e.a : e.b, first ? e.armA : e.armB);
      tx = d[0];
      tz = d[1];
      if (partner) {
        // through direction: at the start we come from the partner, at the end we continue into it
        let bx = first ? d[0] - partner[0] : d[0] + partner[0];
        let bz = first ? d[1] - partner[1] : d[1] + partner[1];
        const l = Math.hypot(bx, bz);
        if (l > 1e-6) {
          bx /= l;
          bz /= l;
          const c = bx * d[0] + bz * d[1];
          if (c > 0.3) {
            tx = bx;
            tz = bz;
            scale = Math.min(2.2, 1 / c);
          }
        }
      }
    }
    push(cum[i], tx, tz, scale);
  };
  const between = (sa: number, sb: number, seg: number): void => {
    const steps = Math.ceil((sb - sa) / maxStep - 1e-9);
    const d = segDir(e, seg);
    for (let k = 1; k < steps; k++) push(sa + ((sb - sa) * k) / steps, d[0], d[1], 1);
  };
  // first station
  let seg = 0;
  while (seg < n - 2 && cum[seg + 1] <= s0 + 1e-6) seg++;
  if (Math.abs(cum[seg] - s0) < 1e-6) atVertex(seg);
  else {
    const d = segDir(e, seg);
    push(s0, d[0], d[1], 1);
  }
  let prev = s0;
  for (let i = seg + 1; i < n; i++) {
    const sv = cum[i];
    if (sv >= s1 - 1e-6) {
      between(prev, s1, i - 1);
      if (Math.abs(sv - s1) < 1e-6) atVertex(i);
      else {
        const d = segDir(e, i - 1);
        push(s1, d[0], d[1], 1);
      }
      return out;
    }
    between(prev, sv, i - 1);
    atVertex(i);
    prev = sv;
  }
  return out;
}

export interface RoadMeshOptions {
  /** natural terrain height (for bridge piers) */
  ground: (x: number, z: number) => number;
}

export class RoadMesher {
  private readonly world: World;
  private readonly ts: TileSet;
  private readonly opt: RoadMeshOptions;
  stats = { edges: 0, junctions: 0, paintQuads: 0, bridges: 0 };

  constructor(world: World, ts: TileSet, opt: RoadMeshOptions) {
    this.world = world;
    this.ts = ts;
    this.opt = opt;
  }

  build(): void {
    for (const e of this.world.edges) this.edge(e);
    for (const n of this.world.nodes) this.junction(n);
    for (const e of this.world.edges) this.markings(e);
    this.crossings();
  }

  /** Lateral line along stations: offset `off` (+ = left) and height delta `dy`. */
  private line(e: Edge, st: Station[], off: number, dy: number): Float64Array {
    const out = new Float64Array(st.length * 3);
    for (let i = 0; i < st.length; i++) {
      const q = st[i];
      const x = q.x + q.nx * off * q.scale;
      const z = q.z + q.nz * off * q.scale;
      out[i * 3] = x;
      out[i * 3 + 1] = this.world.edgeY(e, q.s, x, z) + dy;
      out[i * 3 + 2] = z;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  private edge(e: Edge): void {
    const s0 = e.cutA;
    const s1 = e.len - e.cutB;
    if (s1 - s0 < 0.05) return;
    const ts = this.ts;
    const st = stationsOf(e, s0, s1, 6);
    if (st.length < 2) return;
    this.stats.edges++;
    const half = e.width / 2;
    const bridge = (e.flags & EF.BRIDGE) !== 0;
    const mat = SURF_TO_GM[e.surf] ?? GM.ASPHALT;
    const centre = this.line(e, st, 0, 0);
    const left = this.line(e, st, half, 0);
    const right = this.line(e, st, -half, 0);
    // split the carriageway at the centreline: keeps wide roads well-shaped on crests
    addBand(ts, 'ground', left, centre, [mat]);
    addBand(ts, 'ground', centre, right, [mat]);

    for (const side of [1, -1]) {
      const sw = side > 0 ? e.swL : e.swR;
      const edgeLine = side > 0 ? left : right;
      if (sw > 0) {
        const top = this.line(e, st, side * half, KERB_H);
        const back = this.line(e, st, side * (half + sw), KERB_H);
        addBandFacing(ts, 'ground', edgeLine, top, [GM.KERB], centre);
        addBand(ts, 'ground', top, back, [GM.SIDEWALK]);
        if (!bridge) {
          const skirt = this.line(e, st, side * (half + sw + 0.5), -0.5);
          addBand(ts, 'ground', back, skirt, [GM.VERGE]);
        }
      } else if (!bridge) {
        const skirt = this.line(e, st, side * (half + 1.7), -0.5);
        addBand(ts, 'ground', edgeLine, skirt, [e.surf >= SURF.GRAVEL ? mat : GM.VERGE]);
      }
    }
    if (bridge) this.bridge(e, st, centre);
  }

  private bridge(e: Edge, st: Station[], centre: Float64Array): void {
    this.stats.bridges++;
    const ts = this.ts;
    const half = e.width / 2;
    const outL = half + e.swL + 0.3;
    const outR = half + e.swR + 0.3;
    const DECK = 1.1;
    const PARAPET = 0.95;
    for (const side of [1, -1]) {
      const out = side > 0 ? outL : outR;
      const inner = out - 0.3;
      const base = side > 0 ? e.swL > 0 : e.swR > 0;
      const yIn = base ? KERB_H : 0;
      const outerTop = this.line(e, st, side * out, PARAPET);
      const outerBot = this.line(e, st, side * out, -DECK);
      const innerTop = this.line(e, st, side * inner, PARAPET);
      const innerBot = this.line(e, st, side * inner, yIn);
      // outside fascia faces away from the road, inside face towards it
      addBandFacing(ts, 'struct', outerTop, outerBot, CONCRETE, centre, true);
      addBandFacing(ts, 'struct', innerTop, innerBot, CONCRETE, centre, false);
      addBand(ts, 'struct', outerTop, innerTop, CONCRETE);
      // collision line of the parapet
      for (let i = 0; i < st.length - 1; i++) {
        const t = ts.at(innerTop[i * 3], innerTop[i * 3 + 2]);
        t.collSeg.push(innerTop[i * 3], innerTop[i * 3 + 2], innerTop[i * 3 + 3], innerTop[i * 3 + 5], innerTop[i * 3 + 1] - PARAPET);
      }
    }
    const underL = this.line(e, st, outL, -DECK);
    const underR = this.line(e, st, -outR, -DECK);
    addBand(ts, 'struct', underL, underR, [118, 116, 112], 0, -1, 0);

    // piers every ~28 m, never standing on a road that passes below
    const span = st[st.length - 1].s - st[0].s;
    if (span < 34) return;
    const count = Math.max(1, Math.round(span / 28) - 1);
    const hit = { y: 0, edge: null, node: null, s: 0, off: 0, zone: 2, surf: 0 } as Parameters<World['surfaceAt']>[3];
    for (let k = 1; k <= count; k++) {
      const s = st[0].s + (span * k) / (count + 1);
      samplePolyline(e.pl, s, tmp);
      const deckY = this.world.edgeY(e, s, tmp.x, tmp.z) - DECK;
      const gy = this.opt.ground(tmp.x, tmp.z);
      if (Number.isNaN(gy) || deckY - gy < 1.8) continue;
      if (this.world.surfaceAt(tmp.x, tmp.z, deckY - 1.5, hit) && hit.y < deckY - 1.5) continue;
      const hw = Math.max(1.2, half - 0.8);
      const ht = 0.55;
      const nx = tmp.tz;
      const nz = -tmp.tx;
      const corners: Array<[number, number]> = [
        [tmp.x + nx * hw + tmp.tx * ht, tmp.z + nz * hw + tmp.tz * ht],
        [tmp.x - nx * hw + tmp.tx * ht, tmp.z - nz * hw + tmp.tz * ht],
        [tmp.x - nx * hw - tmp.tx * ht, tmp.z - nz * hw - tmp.tz * ht],
        [tmp.x + nx * hw - tmp.tx * ht, tmp.z + nz * hw - tmp.tz * ht],
      ];
      for (let c = 0; c < 4; c++) {
        const p = corners[c];
        const q = corners[(c + 1) % 4];
        const mx = (p[0] + q[0]) / 2 - tmp.x;
        const mz = (p[1] + q[1]) / 2 - tmp.z;
        addQuad(ts, 'struct', [p[0], deckY, p[1], q[0], deckY, q[1], q[0], gy - 1, q[1], p[0], gy - 1, p[1]], [150, 148, 143], mx, 0, mz);
      }
    }
  }

  // -------------------------------------------------------------------------
  private junction(n: Node): void {
    const sh = n.shape;
    if (!sh) return;
    this.stats.junctions++;
    const ts = this.ts;
    const world = this.world;
    // surface material of the most important arm
    let best: Arm | null = null;
    for (const a of n.arms) if (!best || a.edge.tier > best.edge.tier) best = a;
    const mat = best ? (SURF_TO_GM[best.edge.surf] ?? GM.ASPHALT) : GM.ASPHALT;
    const ring = sh.ring;
    const count = ring.length / 2;
    const p3 = new Float64Array(count * 3 + 3);
    for (let i = 0; i < count; i++) {
      p3[i * 3] = ring[i * 2];
      p3[i * 3 + 1] = world.planeY(n, ring[i * 2], ring[i * 2 + 1]);
      p3[i * 3 + 2] = ring[i * 2 + 1];
    }
    const tris = earcut(ring, undefined, 2);
    addTriangles(ts, 'ground', p3.subarray(0, count * 3), tris, [mat]);

    const anyBridge = n.arms.some((a) => (a.edge.flags & EF.BRIDGE) !== 0);
    if (n.arms.length === 1) {
      // turning circle: grass skirt all round
      const a = new Float64Array((count + 1) * 3);
      const b = new Float64Array((count + 1) * 3);
      for (let i = 0; i <= count; i++) {
        const j = i % count;
        const x = ring[j * 2];
        const z = ring[j * 2 + 1];
        const dx = x - n.x;
        const dz = z - n.z;
        const l = Math.hypot(dx, dz) || 1;
        const y = world.planeY(n, x, z);
        a.set([x, y, z], i * 3);
        b.set([x + (dx / l) * 1.7, y - 0.5, z + (dz / l) * 1.7], i * 3);
      }
      addBand(ts, 'ground', a, b, [GM.VERGE]);
      return;
    }

    for (const c of sh.corners) {
      const k = c.kerb;
      const m = k.length / 2;
      if (m < 2) continue;
      // outward (block-side) normal = right of the walking direction
      const kerb = new Float64Array(m * 3);
      const top = new Float64Array(m * 3);
      const back = new Float64Array(m * 3);
      const skirt = new Float64Array(m * 3);
      const inner = new Float64Array(m * 3);
      let total = 0;
      const acc = new Float64Array(m);
      for (let i = 1; i < m; i++) {
        total += Math.hypot(k[i * 2] - k[i * 2 - 2], k[i * 2 + 1] - k[i * 2 - 1]);
        acc[i] = total;
      }
      const hasWalk = c.swA > 0.05 || c.swB > 0.05;
      for (let i = 0; i < m; i++) {
        const x = k[i * 2];
        const z = k[i * 2 + 1];
        const ip = Math.max(0, i - 1);
        const iq = Math.min(m - 1, i + 1);
        let tx = k[iq * 2] - k[ip * 2];
        let tz = k[iq * 2 + 1] - k[ip * 2 + 1];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        let ox = -tz; // right of (tx,tz)
        let oz = tx;
        let w = total > 0 ? c.swA + (c.swB - c.swA) * (acc[i] / total) : Math.max(c.swA, c.swB);
        if (c.arc0 >= 0 && i >= c.arc0 && i <= c.arc1 && c.r > 0) {
          // on the fillet the outward direction points at the arc centre
          const dx = c.ox - x;
          const dz = c.oz - z;
          const dl = Math.hypot(dx, dz) || 1;
          ox = dx / dl;
          oz = dz / dl;
          w = Math.min(w, Math.max(0.05, c.r - 0.25));
        }
        const y = world.planeY(n, x, z);
        kerb.set([x, y, z], i * 3);
        inner.set([x - ox, y, z - oz], i * 3);
        if (hasWalk) {
          top.set([x, y + KERB_H, z], i * 3);
          const bx = x + ox * w;
          const bz = z + oz * w;
          back.set([bx, world.planeY(n, bx, bz) + KERB_H, bz], i * 3);
          skirt.set([bx + ox * 0.5, world.planeY(n, bx, bz) - 0.5, bz + oz * 0.5], i * 3);
        } else {
          skirt.set([x + ox * 1.7, y - 0.5, z + oz * 1.7], i * 3);
        }
      }
      if (hasWalk) {
        addBandFacing(ts, 'ground', kerb, top, [GM.KERB], inner);
        addBand(ts, 'ground', top, back, [GM.SIDEWALK]);
        if (!anyBridge) addBand(ts, 'ground', back, skirt, [GM.VERGE]);
      } else if (!anyBridge) {
        addBand(ts, 'ground', kerb, skirt, [GM.VERGE]);
      }
    }
  }

  // -------------------------------------------------------------------------
  /** Point on the road surface at station s and lateral offset. */
  private pt(e: Edge, s: number, off: number, out: number[]): void {
    samplePolyline(e.pl, s, tmp);
    const x = tmp.x + tmp.tz * off;
    const z = tmp.z - tmp.tx * off;
    out.push(x, this.world.edgeY(e, s, x, z) + PAINT_LIFT, z);
  }

  /** Painted stripe along the road between stations sa..sb at lateral offset. */
  private stripe(e: Edge, sa: number, sb: number, off: number, width: number, mat: number): void {
    if (sb - sa < 0.05) return;
    const steps = Math.max(1, Math.ceil((sb - sa) / 2.5));
    const a: number[] = [];
    const b: number[] = [];
    for (let k = 0; k <= steps; k++) {
      const s = sa + ((sb - sa) * k) / steps;
      this.pt(e, s, off + width / 2, a);
      this.pt(e, s, off - width / 2, b);
    }
    addBand(this.ts, 'mark', a, b, [mat]);
    this.stats.paintQuads += steps;
  }

  private dashed(e: Edge, sa: number, sb: number, off: number, width: number, dash: number, gap: number): void {
    const period = dash + gap;
    for (let s = Math.ceil(sa / period) * period; s < sb; s += period) {
      this.stripe(e, Math.max(sa, s), Math.min(sb, s + dash), off, width, GM.PAINT_WHITE);
    }
  }

  /** Transverse bar (stop line etc.): from offset o0 to o1 at station s, `len` long along the road. */
  private bar(e: Edge, s: number, o0: number, o1: number, len: number, mat: number): void {
    const p: number[] = [];
    this.pt(e, s - len / 2, o0, p);
    this.pt(e, s - len / 2, o1, p);
    this.pt(e, s + len / 2, o1, p);
    this.pt(e, s + len / 2, o0, p);
    addQuad(this.ts, 'mark', p, [mat]);
    this.stats.paintQuads++;
  }

  private markings(e: Edge): void {
    const marked = (e.flags & EF.MARKED) !== 0;
    const F = e.lanesF;
    const B = e.lanesB;
    const W = e.width;
    const lw = e.laneW;
    const oR = -W / 2 + e.margin;
    const oD = oR + F * lw;
    const oL = W / 2 - e.margin;
    const motorway = e.cls <= CLS.TRUNK_LINK;
    const urban = (e.flags & EF.URBAN) !== 0;
    const s0 = e.cutA;
    const s1 = e.len - e.cutB;
    const armA = e.armA;
    const armB = e.armB;
    // where traffic waits: forward traffic stops before node b, backward before node a
    const stopB = e.len - armB.stopS;
    const stopA = armA.stopS;
    const ctlB = armB.isApproach && (armB.sg >= 0 || armB.role === ROLE.STOP || armB.role === ROLE.YIELD);
    const ctlA = armA.isApproach && (armA.sg >= 0 || armA.role === ROLE.STOP || armA.role === ROLE.YIELD);

    if (marked && s1 - s0 > 1) {
      const dash = motorway ? 6 : urban ? 3 : 4;
      const gap = motorway ? 12 : urban ? 6 : 8;
      const lineW = motorway ? 0.15 : 0.12;
      // lines turn solid ahead of a controlled stop line
      const solidLenB = armB.sg >= 0 ? 24 : 0;
      const solidLenA = armA.sg >= 0 ? 24 : 0;
      if (F > 0 && B > 0) {
        const a = ctlA ? Math.max(s0, stopA) : s0;
        const b = ctlB ? Math.min(s1, stopB) : s1;
        if (e.flags & EF.SOLID_CENTER || F + B >= 4) {
          if (F + B >= 4) {
            this.stripe(e, a, b, oD + 0.12, 0.12, GM.PAINT_WHITE);
            this.stripe(e, a, b, oD - 0.12, 0.12, GM.PAINT_WHITE);
          } else this.stripe(e, a, b, oD, lineW, GM.PAINT_WHITE);
        } else {
          const sa = a + solidLenA;
          const sb = b - solidLenB;
          if (solidLenA > 0) this.stripe(e, a, Math.min(sa, b), oD, lineW, GM.PAINT_WHITE);
          if (solidLenB > 0) this.stripe(e, Math.max(sb, a), b, oD, lineW, GM.PAINT_WHITE);
          if (sb > sa) this.dashed(e, sa, sb, oD, lineW, dash, gap);
        }
      }
      for (let k = 1; k < F; k++) {
        const b = ctlB ? Math.min(s1, stopB) : s1;
        const sb = b - solidLenB;
        this.dashed(e, s0, Math.max(s0, sb), oR + k * lw, lineW, dash, gap);
        if (solidLenB > 0) this.stripe(e, Math.max(sb, s0), b, oR + k * lw, lineW, GM.PAINT_WHITE);
      }
      for (let k = 1; k < B; k++) {
        const a = ctlA ? Math.max(s0, stopA) : s0;
        const sa = a + solidLenA;
        this.dashed(e, Math.min(sa, s1), s1, oD + k * lw, lineW, dash, gap);
        if (solidLenA > 0) this.stripe(e, a, Math.min(sa, s1), oD + k * lw, lineW, GM.PAINT_WHITE);
      }
    }
    if (e.flags & EF.EDGE_LINES && s1 - s0 > 1) {
      const wR = motorway ? 0.3 : 0.12;
      const wL = motorway ? 0.15 : 0.12;
      this.stripe(e, s0, s1, oR + (motorway ? -wR / 2 : wR / 2 + 0.1), wR, GM.PAINT_WHITE);
      this.stripe(e, s0, s1, oL + (motorway ? wL / 2 : -wL / 2 - 0.1), wL, GM.PAINT_WHITE);
    }

    // stop and give-way lines
    const line = (arm: Arm, atB: boolean): void => {
      if (!arm.isApproach) return;
      const node = arm.node;
      const s = atB ? e.len - arm.stopS : arm.stopS;
      // lanes of the approaching direction
      const from = atB ? oR : oD;
      const to = atB ? oD : oL;
      const lo = F > 0 && B > 0 ? from : -W / 2 + 0.15;
      const hi = F > 0 && B > 0 ? to : W / 2 - 0.15;
      const dir = atB ? -1 : 1; // keep the bar on the approach side of the line
      if (arm.sg >= 0 || arm.role === ROLE.STOP) {
        this.bar(e, s + dir * 0.25, lo, hi, 0.5, GM.PAINT_WHITE);
      } else if (arm.role === ROLE.YIELD) {
        const paint =
          node.ctrl === CTRL.ROUNDABOUT || marked || node.arms.some((a) => (a.edge.flags & EF.MARKED) !== 0 && a.edge.tier >= 3);
        if (!paint || e.tier < 2) return;
        for (let o = lo + 0.1; o + 0.5 <= hi; o += 0.75) this.bar(e, s + dir * 0.25, o, o + 0.5, 0.5, GM.PAINT_WHITE);
      }
    };
    line(armB, true);
    line(armA, false);

    // lane arrows from turn:lanes
    this.arrows(e, e.turnF, true, oR, lw, F, ctlB ? stopB : s1);
    this.arrows(e, e.turnB, false, oL, lw, B, ctlA ? stopA : s0);
  }

  /**
   * Direction arrows.  `turn` is the OSM turn:lanes string, listed left→right
   * in driving direction.  `fwd`: lanes run a→b; `edgeRight`: lateral offset of
   * the right lane edge (fwd) or of the left carriageway edge (backward lanes).
   */
  private arrows(e: Edge, turn: string, fwd: boolean, edgeOff: number, lw: number, lanes: number, stopS: number): void {
    if (!turn || lanes < 1) return;
    const parts = turn.split('|');
    if (parts.length !== lanes) return;
    for (let li = 0; li < lanes; li++) {
      const spec = parts[li];
      if (!spec || spec === 'none') continue;
      const left = /left/.test(spec) && !/merge/.test(spec);
      const right = /right/.test(spec) && !/merge/.test(spec);
      const through = /through/.test(spec);
      if (!left && !right && !through) continue;
      // lane index from the right: OSM lists left→right
      const fromRight = lanes - 1 - li;
      const off = fwd ? edgeOff + (fromRight + 0.5) * lw : edgeOff - (fromRight + 0.5) * lw;
      for (const back of [7, 32]) {
        const s = fwd ? stopS - back : stopS + back;
        if (s < e.cutA + 3 || s > e.len - e.cutB - 3) continue;
        this.arrow(e, s, off, fwd ? 1 : -1, through, left, right);
      }
    }
  }

  /** One arrow, 5 m long, tip pointing in driving direction. */
  private arrow(e: Edge, s: number, off: number, dir: number, through: boolean, left: boolean, right: boolean): void {
    // local coordinates: u = lateral (+ = left of driving direction), v = along driving direction
    const P = (u: number, v: number, out: number[]): void => this.pt(e, s + v * dir, off + u * dir, out);
    const poly = (uv: number[]): void => {
      const p: number[] = [];
      for (let i = 0; i < uv.length; i += 2) P(uv[i], uv[i + 1], p);
      const n = uv.length / 2;
      const tris: number[] = [];
      for (let i = 1; i < n - 1; i++) tris.push(0, i, i + 1);
      addTriangles(this.ts, 'mark', p, tris, [GM.PAINT_WHITE]);
      this.stats.paintQuads += n - 2;
    };
    const shaftTop = through ? 3.0 : 1.6;
    poly([-0.075, 0, 0.075, 0, 0.075, shaftTop, -0.075, shaftTop]);
    if (through) poly([-0.38, 3.0, 0.38, 3.0, 0, 5.0]);
    for (const sgn of [left ? 1 : 0, right ? -1 : 0]) {
      if (!sgn) continue;
      const y0 = through ? 1.0 : 1.6;
      // short bent shaft and a sideways head
      poly([0, y0 - 0.15, sgn * 0.55, y0 + 0.75, sgn * 0.55, y0 + 0.95, 0, y0 + 0.15]);
      poly([sgn * 0.45, y0 + 0.35, sgn * 1.25, y0 + 1.15, sgn * 0.45, y0 + 1.75]);
    }
  }

  private crossings(): void {
    for (const c of this.world.crossings) {
      const e = this.world.edges[c.e];
      if (c.s < e.cutA + 0.3 || c.s > e.len - e.cutB - 0.3) continue;
      const half = e.width / 2;
      if (c.k === XING.ZEBRA) {
        for (let o = -half + 0.3; o + 0.5 <= half - 0.2; o += 1.0) this.bar(e, c.s, o, o + 0.5, c.w, GM.PAINT_WHITE);
      } else if (c.k === XING.SIGNAL) {
        for (const ds of [-c.w / 2, c.w / 2]) {
          for (let o = -half + 0.2; o + 0.5 <= half - 0.1; o += 0.7) this.bar(e, c.s + ds, o, o + 0.5, 0.12, GM.PAINT_WHITE);
        }
      }
    }
  }
}

/** Like addBand, but each quad faces towards (or away from) a reference line. */
function addBandFacing(
  ts: TileSet,
  layer: 'ground' | 'struct',
  a: Float64Array,
  b: Float64Array,
  attrs: number[],
  ref: Float64Array,
  away = false,
): void {
  const n = a.length / 3;
  for (let i = 0; i < n - 1; i++) {
    const i3 = i * 3;
    let nx = ref[i3] + ref[i3 + 3] - a[i3] - a[i3 + 3];
    let nz = ref[i3 + 2] + ref[i3 + 5] - a[i3 + 2] - a[i3 + 5];
    if (away) {
      nx = -nx;
      nz = -nz;
    }
    addQuad(
      ts,
      layer,
      [a[i3], a[i3 + 1], a[i3 + 2], a[i3 + 3], a[i3 + 4], a[i3 + 5], b[i3 + 3], b[i3 + 4], b[i3 + 5], b[i3], b[i3 + 1], b[i3 + 2]],
      attrs,
      nx,
      0,
      nz,
    );
  }
}

void STEEL;
