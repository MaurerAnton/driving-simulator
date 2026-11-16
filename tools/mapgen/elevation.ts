// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Road elevation from the 1 m terrain model.
 *
 * Every centreline vertex gets the terrain height, then the whole network is
 * relaxed at once: each sample is pulled towards the terrain (data term) and
 * towards the mean of its neighbours along the road (smoothness term), with
 * junction nodes shared between all incident roads.  Bridge and tunnel
 * samples have no data term, so decks become straight spans between their
 * abutments instead of following the valley floor.
 */
import { CLASS_TIER, CLS, EF } from '../../src/world/types.ts';
import type { Dgm } from './dgm.ts';
import type { RoadGraph } from './roads.ts';

export interface ElevationReport {
  maxGrade: number;
  steepEdges: number;
  lowClearances: number;
  fixedClearances: number;
}

export function solveElevation(graph: RoadGraph, dgm: Dgm): ElevationReport {
  const { nodes, edges } = graph;
  const E = edges.length;
  const nodeH = new Float64Array(nodes.length);
  const nodeRaw = new Float64Array(nodes.length);
  const nodeLam = new Float64Array(nodes.length);
  const nodeFree = new Uint8Array(nodes.length); // 1 = no data term (bridge/tunnel)
  const eh: Float64Array[] = new Array(E);
  const eraw: Float64Array[] = new Array(E);
  const elam: Float64Array[] = new Array(E);
  const eseg: Float64Array[] = new Array(E); // segment lengths
  const structural = (f: number): boolean => (f & (EF.BRIDGE | EF.TUNNEL)) !== 0;

  // which nodes touch only structures → they float too
  const nodeStruct = new Int32Array(nodes.length);
  const nodeDeg = new Int32Array(nodes.length);
  for (const e of edges) {
    nodeDeg[e.a]++;
    nodeDeg[e.b]++;
    if (structural(e.f)) {
      nodeStruct[e.a]++;
      nodeStruct[e.b]++;
    }
  }

  const lamFor = (cls: number, spacing: number): number => {
    const L = cls <= CLS.TRUNK_LINK ? 22 : CLASS_TIER[cls] >= 3 ? 13 : 9;
    const r = L / Math.max(spacing, 0.5);
    return 1 / (1 + 2 * r * r);
  };

  // The terrain under every node and every point of every road – asked for tile by tile: the
  // model of a whole region is read piece by piece, and roads come in no particular order.
  let points = nodes.length;
  for (const e of edges) points += e.p.length / 3;
  const sx = new Float64Array(points);
  const sz = new Float64Array(points);
  nodes.forEach((n, i) => {
    sx[i] = n.x;
    sz[i] = n.z;
  });
  const edgeFirst = new Int32Array(E);
  for (let k = 0, at = nodes.length; k < E; k++) {
    edgeFirst[k] = at;
    const p = edges[k].p;
    for (let i = 0; i < p.length; i += 3, at++) {
      sx[at] = p[i];
      sz[at] = p[i + 2];
    }
  }
  const sampled = new Float64Array(points);
  {
    const order = new Uint32Array(points);
    const tile = new Float64Array(points);
    for (let i = 0; i < points; i++) {
      order[i] = i;
      tile[i] = Math.floor(sx[i] / 1000) * 100000 + Math.floor(sz[i] / 1000);
    }
    order.sort((a, b) => tile[a] - tile[b]);
    for (let j = 0; j < points; j++) {
      const i = order[j];
      let h = dgm.heightAvg(sx[i], sz[i], 1.5);
      if (Number.isNaN(h)) h = dgm.heightAvg(sx[i], sz[i], 6);
      sampled[i] = h;
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    const h = sampled[i];
    nodeRaw[i] = Number.isNaN(h) ? 200 : h;
    nodeH[i] = nodeRaw[i];
    // Abutment nodes float as well: OSM bridge ends are rarely exactly on the
    // abutment, and the terrain model there already shows the slope below.
    nodeFree[i] = nodeDeg[i] >= 2 && nodeStruct[i] > 0 ? 1 : 0;
    nodeLam[i] = nodeFree[i] ? 0 : 0.25;
  }

  for (let k = 0; k < E; k++) {
    const e = edges[k];
    const n = e.p.length / 3;
    const h = new Float64Array(n);
    const raw = new Float64Array(n);
    const lam = new Float64Array(n);
    const seg = new Float64Array(n);
    const free = structural(e.f);
    for (let i = 0; i < n; i++) {
      const x = e.p[i * 3];
      const z = e.p[i * 3 + 2];
      raw[i] = sampled[edgeFirst[k] + i];
      if (i > 0) seg[i] = Math.hypot(x - e.p[i * 3 - 3], z - e.p[i * 3 - 1]);
    }
    // fill gaps (points just outside coverage)
    for (let i = 0; i < n; i++) if (Number.isNaN(raw[i])) raw[i] = i > 0 ? raw[i - 1] : nodeRaw[e.a];
    for (let i = 0; i < n; i++) {
      h[i] = raw[i];
      if (free) lam[i] = 0;
      else {
        const sp = i === 0 ? seg[1] : i === n - 1 ? seg[n - 1] : (seg[i] + seg[i + 1]) / 2;
        lam[i] = lamFor(e.c, sp);
      }
    }
    // Approaches: close to a structure the terrain model shows the embankment
    // slope rather than the road, so the data term fades out there and the
    // deck is spanned between the embankments further back.
    if (!free) {
      const fade = (fromStart: boolean): void => {
        let acc = 0;
        for (let j = 0; j < n; j++) {
          const i = fromStart ? j : n - 1 - j;
          if (j > 0) acc += seg[fromStart ? i : i + 1];
          if (acc > 26) break;
          const t = Math.max(0, Math.min(1, (acc - 8) / 18));
          lam[i] *= t * t * (3 - 2 * t);
        }
      };
      if (nodeStruct[e.a] > 0 && nodeDeg[e.a] >= 2) fade(true);
      if (nodeStruct[e.b] > 0 && nodeDeg[e.b] >= 2) fade(false);
    }
    eh[k] = h;
    eraw[k] = raw;
    elam[k] = lam;
    eseg[k] = seg;
  }

  // adjacency for node updates: [edge, isA]
  const inc: Array<Array<[number, boolean]>> = nodes.map(() => []);
  edges.forEach((e, k) => {
    inc[e.a].push([k, true]);
    inc[e.b].push([k, false]);
  });

  // ---- flat system: H[i] = c0[i] + Σ w·H[neighbour] ------------------------
  // Samples 0..N-1 are the graph nodes, then all interior edge points.
  const N = nodes.length;
  const base = new Int32Array(E); // global index of interior point 1 of edge k is base[k]
  let total = N;
  for (let k = 0; k < E; k++) {
    base[k] = total;
    total += Math.max(0, eh[k].length - 2);
  }
  const gi = (k: number, i: number): number => {
    const n = eh[k].length;
    return i === 0 ? edges[k].a : i === n - 1 ? edges[k].b : base[k] + i - 1;
  };
  const H = new Float64Array(total);
  const c0 = new Float64Array(total);
  const c1 = new Float64Array(total);
  const c2 = new Float64Array(total);
  const L = new Int32Array(total);
  const R = new Int32Array(total);
  const isFree = new Uint8Array(total);
  // CSR neighbour lists for nodes
  const nStart = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) nStart[i + 1] = nStart[i] + inc[i].length;
  const nIdx = new Int32Array(nStart[N]);
  const nW = new Float64Array(nStart[N]);
  const nC0 = new Float64Array(N);

  const assemble = (): void => {
    for (let k = 0; k < E; k++) {
      const h = eh[k];
      const lam = elam[k];
      const raw = eraw[k];
      const seg = eseg[k];
      const n = h.length;
      const free = structural(edges[k].f);
      for (let i = 1; i < n - 1; i++) {
        const g = base[k] + i - 1;
        const w1 = 1 / Math.max(seg[i], 0.2);
        const w2 = 1 / Math.max(seg[i + 1], 0.2);
        const a = w1 / (w1 + w2);
        c0[g] = lam[i] * raw[i];
        c1[g] = (1 - lam[i]) * a;
        c2[g] = (1 - lam[i]) * (1 - a);
        L[g] = gi(k, i - 1);
        R[g] = gi(k, i + 1);
        isFree[g] = free && lam[i] < 1 ? 1 : 0;
      }
    }
    for (let i = 0; i < N; i++) {
      const list = inc[i];
      let sw = 0;
      let p = nStart[i];
      for (let j = 0; j < list.length; j++) {
        const k = list[j][0];
        const isA = list[j][1];
        const n = eh[k].length;
        const d = isA ? eseg[k][1] : eseg[k][n - 1];
        const w = (CLASS_TIER[edges[k].c] + 1) / Math.max(d, 0.2);
        nIdx[p] = gi(k, isA ? 1 : n - 2);
        nW[p] = w;
        sw += w;
        p++;
      }
      const lam = list.length === 1 ? Math.max(nodeLam[i], 0.3) : nodeLam[i];
      for (let q = nStart[i]; q < nStart[i + 1]; q++) nW[q] *= (1 - lam) / (sw || 1);
      nC0[i] = lam * nodeRaw[i];
      isFree[i] = nodeFree[i];
    }
  };
  const load = (): void => {
    for (let i = 0; i < N; i++) H[i] = nodeH[i];
    for (let k = 0; k < E; k++) for (let i = 1; i < eh[k].length - 1; i++) H[base[k] + i - 1] = eh[k][i];
  };
  const store = (): void => {
    for (let i = 0; i < N; i++) nodeH[i] = H[i];
    for (let k = 0; k < E; k++) {
      const h = eh[k];
      const n = h.length;
      h[0] = H[edges[k].a];
      h[n - 1] = H[edges[k].b];
      for (let i = 1; i < n - 1; i++) h[i] = H[base[k] + i - 1];
    }
  };
  let freeList = new Int32Array(0);
  const collectFree = (): void => {
    const tmp: number[] = [];
    for (let g = 0; g < total; g++) if (isFree[g]) tmp.push(g);
    freeList = Int32Array.from(tmp);
  };
  /** Gauss–Seidel sweep with over-relaxation, alternating direction. */
  const sweepAll = (omega: number, reverse: boolean): void => {
    for (let s = 0; s < total; s++) {
      const g = reverse ? total - 1 - s : s;
      let t: number;
      if (g < N) {
        if (nStart[g] === nStart[g + 1]) continue;
        t = nC0[g];
        for (let q = nStart[g]; q < nStart[g + 1]; q++) t += nW[q] * H[nIdx[q]];
      } else {
        t = c0[g] + c1[g] * H[L[g]] + c2[g] * H[R[g]];
      }
      H[g] += (t - H[g]) * omega;
    }
  };
  const sweepFree = (omega: number): void => {
    for (let s = 0; s < freeList.length; s++) {
      const g = freeList[s];
      let t: number;
      if (g < N) {
        t = nC0[g];
        for (let q = nStart[g]; q < nStart[g + 1]; q++) t += nW[q] * H[nIdx[q]];
      } else {
        t = c0[g] + c1[g] * H[L[g]] + c2[g] * H[R[g]];
      }
      H[g] += (t - H[g]) * omega;
    }
  };
  const solve = (structIters: number, fullIters: number): void => {
    assemble();
    collectFree();
    load();
    for (let it = 0; it < structIters; it++) sweepFree(1.8);
    for (let it = 0; it < fullIters; it++) sweepAll(1.5, (it & 1) === 1);
    for (let it = 0; it < 12; it++) sweepAll(1.0, (it & 1) === 1);
    store();
  };
  solve(1500, 70);

  // ---- grade separation: make sure decks clear what passes beneath ---------
  interface SegRef {
    k: number;
    i: number;
  }
  const cell = 60;
  const grid = new Map<number, SegRef[]>();
  const keyOf = (ix: number, iz: number): number => (ix + 4096) * 8192 + (iz + 4096);
  edges.forEach((e, k) => {
    const n = e.p.length / 3;
    for (let i = 0; i < n - 1; i++) {
      const x0 = Math.min(e.p[i * 3], e.p[i * 3 + 3]);
      const x1 = Math.max(e.p[i * 3], e.p[i * 3 + 3]);
      const z0 = Math.min(e.p[i * 3 + 2], e.p[i * 3 + 5]);
      const z1 = Math.max(e.p[i * 3 + 2], e.p[i * 3 + 5]);
      for (let ix = Math.floor(x0 / cell); ix <= Math.floor(x1 / cell); ix++) {
        for (let iz = Math.floor(z0 / cell); iz <= Math.floor(z1 / cell); iz++) {
          const key = keyOf(ix, iz);
          let arr = grid.get(key);
          if (!arr) grid.set(key, (arr = []));
          arr.push({ k, i });
        }
      }
    }
  });

  let lowClearances = 0;
  let fixedClearances = 0;
  interface Pin {
    k: number;
    i: number;
    y: number;
    /** true = raise at least to y, false = lower at most to y */
    up: boolean;
  }
  const findConflicts = (): Pin[] => {
    const pins: Pin[] = [];
    edges.forEach((e, k) => {
      if (!(e.f & EF.BRIDGE)) return;
      const n = e.p.length / 3;
      for (let i = 0; i < n - 1; i++) {
        const ax = e.p[i * 3];
        const az = e.p[i * 3 + 2];
        const bx = e.p[i * 3 + 3];
        const bz = e.p[i * 3 + 5];
        const seen = new Set<number>();
        for (let ix = Math.floor(Math.min(ax, bx) / cell); ix <= Math.floor(Math.max(ax, bx) / cell); ix++) {
          for (let iz = Math.floor(Math.min(az, bz) / cell); iz <= Math.floor(Math.max(az, bz) / cell); iz++) {
            for (const o of grid.get(keyOf(ix, iz)) ?? []) {
              if (o.k === k) continue;
              const f = edges[o.k];
              if (f.a === e.a || f.a === e.b || f.b === e.a || f.b === e.b) continue;
              if ((f.ly ?? 0) >= (e.ly ?? 1)) continue; // not below us
              const id = o.k * 4096 + o.i;
              if (seen.has(id)) continue;
              seen.add(id);
              const cx = f.p[o.i * 3];
              const cz = f.p[o.i * 3 + 2];
              const dx = f.p[o.i * 3 + 3];
              const dz = f.p[o.i * 3 + 5];
              const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
              if (Math.abs(den) < 1e-9) continue;
              const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den;
              const u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
              if (t < 0 || t > 1 || u < 0 || u > 1) continue;
              const deck = eh[k][i] + (eh[k][i + 1] - eh[k][i]) * t;
              const below = eh[o.k][o.i] + (eh[o.k][o.i + 1] - eh[o.k][o.i]) * u;
              // headroom the lower road needs (deck surface to road surface, incl. structure depth)
              const need = CLASS_TIER[f.c] >= 2 ? 5.4 : 3.6;
              const deficit = need - (deck - below);
              if (deficit <= 0.05) continue;
              if (process.env.MAP_VERBOSE) {
                console.log(
                  `[elev] clearance ${(deck - below).toFixed(1)} m (need ${need}): way ${e.o} (cls ${e.c}) over way ${f.o} (cls ${f.c}) at x=${(ax + (bx - ax) * t).toFixed(0)} z=${(az + (bz - az) * t).toFixed(0)}`,
                );
              }
              // dip the lower road first (underpasses usually are dips), raise the deck for the rest
              const dip = Math.min(deficit, 1.6);
              pins.push({ k: o.k, i: u < 0.5 ? o.i : o.i + 1, y: below - dip, up: false });
              if (deficit - dip > 0.05) pins.push({ k, i: t < 0.5 ? i : i + 1, y: deck + (deficit - dip), up: true });
            }
          }
        }
      }
    });
    return pins;
  };
  for (let round = 0; round < 2; round++) {
    const pins = findConflicts();
    if (round === 0) lowClearances = pins.filter((p) => !p.up).length;
    if (pins.length === 0) break;
    for (const p of pins) {
      const n = eh[p.k].length;
      if (n < 3) continue;
      const i = Math.min(n - 2, Math.max(1, p.i));
      const prev = elam[p.k][i] === 1 ? eraw[p.k][i] : p.up ? -Infinity : Infinity;
      eraw[p.k][i] = p.up ? Math.max(p.y, prev) : Math.min(p.y, prev);
      elam[p.k][i] = 1;
      eh[p.k][i] = eraw[p.k][i];
      // let the neighbours of a dip follow the pin instead of the terrain
      if (!p.up) {
        for (let d = 1; d <= 3; d++) {
          for (const j of [i - d, i + d]) {
            if (j > 0 && j < n - 1 && elam[p.k][j] < 1) elam[p.k][j] *= 0.25;
          }
        }
      }
      if (round === 0) fixedClearances++;
    }
    solve(1500, 40);
  }
  const unresolved = findConflicts().filter((p) => !p.up).length;
  if (unresolved > 0) console.log(`[elev] ${unresolved} crossings still below the wanted headroom`);

  // ---- write back, junction planes, report ---------------------------------
  let maxGrade = 0;
  let steepEdges = 0;
  for (let k = 0; k < E; k++) {
    const e = edges[k];
    const h = eh[k];
    const seg = eseg[k];
    let steep = false;
    for (let i = 0; i < h.length; i++) {
      e.p[i * 3 + 1] = Math.round(h[i] * 100) / 100;
      if (i > 0 && seg[i] > 1.5) {
        const g = Math.abs(h[i] - h[i - 1]) / seg[i];
        if (g > maxGrade) maxGrade = g;
        if (g > 0.2) steep = true;
      }
    }
    if (steep) {
      steepEdges++;
      if (process.env.MAP_VERBOSE) {
        let worst = 0;
        let wi = 0;
        for (let i = 1; i < h.length; i++) {
          const g = seg[i] > 1.5 ? Math.abs(h[i] - h[i - 1]) / seg[i] : 0;
          if (g > worst) {
            worst = g;
            wi = i;
          }
        }
        console.log(
          `[elev] steep ${(worst * 100).toFixed(0)}% cls ${e.c} way ${e.o} flags ${e.f} at x=${e.p[wi * 3].toFixed(0)} z=${e.p[wi * 3 + 2].toFixed(0)} h=${h[wi - 1].toFixed(1)}→${h[wi].toFixed(1)} raw=${eraw[k][wi - 1].toFixed(1)}→${eraw[k][wi].toFixed(1)}`,
        );
      }
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    node.y = Math.round(nodeH[i] * 100) / 100;
    // the plane through the arms' slopes near the node
    const arms: PlaneArm[] = [];
    for (const [k, isA] of inc[i]) {
      const e = edges[k];
      const h = eh[k];
      const n = h.length;
      // walk ~10 m along the arm
      let acc = 0;
      let j = isA ? 0 : n - 1;
      const step = isA ? 1 : -1;
      while (acc < 10 && j + step >= 0 && j + step < n) {
        j += step;
        acc += eseg[k][isA ? j : j + 1];
      }
      if (acc < 0.5) continue;
      const dx = e.p[j * 3] - node.x;
      const dz = e.p[j * 3 + 2] - node.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.5) continue;
      arms.push({ ux: dx / d, uz: dz / d, m: (h[j] - nodeH[i]) / d, w: CLASS_TIER[e.c] + 1 });
    }
    const [gx, gz] = fitJunctionPlane(arms);
    if (Math.abs(gx) > 5e-4 || Math.abs(gz) > 5e-4) {
      node.gx = Math.round(gx * 1e4) / 1e4;
      node.gz = Math.round(gz * 1e4) / 1e4;
    }
  }
  return { maxGrade, steepEdges, lowClearances, fixedClearances };
}

/** An arm of a junction as the plane of the junction sees it: its direction away from the node, its slope that way, its weight. */
export interface PlaneArm {
  ux: number;
  uz: number;
  m: number;
  w: number;
}

/** how steep the plane of a junction may be, and how far it may tilt a road sideways for the sake of a lesser road joining it */
const PLANE_MAX = 0.14;
const TILT_MAX = 0.04;

/**
 * The plane of a junction (its slope east and south) from the slopes of its
 * arms: the least-squares fit – except for what the arms do not say.  Arms
 * that (nearly) lie in one line, as at a joint in a road or where a track
 * leaves it, say nothing about the slope across them: fitted freely, a slight
 * bend with a slight change of grade tilted such a road sideways by a tenth,
 * a step of half a metre for the wheels on one side.  There the plane follows
 * the road and is level across it; and a lesser road that joins a greater one
 * tilts it by a few per cent at most.
 */
export function fitJunctionPlane(arms: PlaneArm[]): [number, number] {
  let a11 = 1e-3;
  let a12 = 0;
  let a22 = 1e-3;
  let b1 = 0;
  let b2 = 0;
  for (const a of arms) {
    a11 += a.w * a.ux * a.ux;
    a12 += a.w * a.ux * a.uz;
    a22 += a.w * a.uz * a.uz;
    b1 += a.w * a.m * a.ux;
    b2 += a.w * a.m * a.uz;
  }
  // along the direction the arms say most about (v), and across it
  const half = (a11 + a22) / 2;
  const disc = Math.sqrt(Math.max(0, half * half - (a11 * a22 - a12 * a12)));
  const l1 = half + disc;
  const l2 = half - disc;
  let vx = l1 - a22;
  let vz = a12;
  if (Math.abs(vx) + Math.abs(vz) < 1e-9) {
    vx = a12;
    vz = l1 - a11;
  }
  const vl = Math.hypot(vx, vz);
  if (vl < 1e-9) {
    // (no direction stands out: arms all round, or none)
    vx = 1;
    vz = 0;
  } else {
    vx /= vl;
    vz /= vl;
  }
  const along = (b1 * vx + b2 * vz) / l1;
  let across = l2 > 1e-6 ? (-b1 * vz + b2 * vx) / l2 : 0;
  const say = l2 / l1;
  if (say < 0.12) across = 0;
  else if (say < 0.6) across = Math.max(-TILT_MAX, Math.min(TILT_MAX, across));
  let gx = along * vx - across * vz;
  let gz = along * vz + across * vx;
  const gl = Math.hypot(gx, gz);
  if (gl > PLANE_MAX) {
    gx *= PLANE_MAX / gl;
    gz *= PLANE_MAX / gl;
  }
  return [gx, gz];
}
