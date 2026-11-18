// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Right-of-way for every junction.
 *
 * Explicit OSM data wins (traffic signals, give-way and stop signs with their
 * direction, roundabouts, turn restrictions).  Where OSM is silent the German
 * rules of thumb are applied, which is also how the roads are signed in
 * practice:
 *
 *   - roads of equal standing in residential areas / Tempo-30 zones:
 *     "rechts vor links" (§ 8 (1) StVO), no signs;
 *   - a higher-class road meeting lower-class roads: the main road is a
 *     priority road (Zeichen 306/301), side roads get Zeichen 205;
 *   - driveways, car parks, tracks and traffic-calmed areas always give way
 *     (§ 10 StVO), no signs needed;
 *   - roundabouts: Zeichen 215 + 205 at every entry;
 *   - motorway-style merges: the through carriageway has priority (§ 18 (3)).
 */
import { hash01 } from '../../src/core/geom.ts';
import { CLASS_TIER, CLS, CTRL, EF, ROLE, XING } from '../../src/world/types.ts';
import type { CrossingJson, EdgeJson, SignalControllerJson } from '../../src/world/types.ts';
import type { OsmData } from './osm.ts';
import { armAngle } from './roads.ts';
import type { EdgeFeature, RoadGraph } from './roads.ts';

export interface ControlResult {
  signals: SignalControllerJson[];
  crossings: CrossingJson[];
  banned: number[][];
  report: Record<string, number>;
}

interface ArmInfo {
  k: number;
  e: EdgeJson;
  isA: boolean;
  approach: boolean;
  exit: boolean;
  tier: number;
  ang: number;
  len: number;
}

function edgeLen(e: EdgeJson): number {
  let l = 0;
  for (let i = 3; i < e.p.length; i += 3) l += Math.hypot(e.p[i] - e.p[i - 3], e.p[i + 2] - e.p[i - 1]);
  return l;
}

export function deriveControl(graph: RoadGraph, osm: OsmData): ControlResult {
  const { nodes, edges } = graph;
  const elen = edges.map(edgeLen);
  const report: Record<string, number> = {};
  const bump = (k: string, n = 1): void => {
    report[k] = (report[k] ?? 0) + n;
  };

  const armsOf = (ni: number): ArmInfo[] =>
    nodes[ni].arms.map((a) => {
      const e = edges[a.e];
      // A loop cannot occur (roads.ts splits them), so the end is unambiguous.
      const isA = e.a === ni;
      return {
        k: a.e,
        e,
        isA,
        approach: isA ? e.lb > 0 : e.lf > 0,
        exit: isA ? e.lf > 0 : e.lb > 0,
        tier: CLASS_TIER[e.c],
        ang: armAngle(e, isA),
        len: elen[a.e],
      };
    });
  const allArms = nodes.map((_, i) => armsOf(i));

  // ---- features sitting exactly on 2-arm graph nodes become edge features --
  graph.nodeOsm.forEach((o, ni) => {
    const t = o?.tags;
    if (!t || nodes[ni].arms.length !== 2) return;
    let kind: EdgeFeature['kind'] | null = null;
    if (t.highway === 'traffic_signals') kind = 'signal';
    else if (t.highway === 'give_way') kind = 'give_way';
    else if (t.highway === 'stop') kind = 'stop';
    else if (t.highway === 'crossing') kind = 'crossing';
    else if (t.railway === 'level_crossing' || t.railway === 'tram_level_crossing' || t.railway === 'tram_crossing') kind = 'level_crossing';
    if (!kind) return;
    const arms = allArms[ni];
    const arm = arms.find((a) => !a.isA) ?? arms[0];
    const dirTag = t.direction ?? t['traffic_signals:direction'];
    const dir = dirTag === 'forward' ? 1 : dirTag === 'backward' ? -1 : 0;
    graph.edgeFeatures[arm.k].push({ kind, s: arm.isA ? 0.01 : arm.len - 0.01, dir, tags: t, osm: o!.id });
  });

  /**
   * Features met when driving towards node `ni` on arm `arm`, nearest first,
   * following the road through plain 2-arm joints up to `maxDist`.
   */
  const approachFeatures = (ni: number, arm: ArmInfo, maxDist: number): Array<{ f: EdgeFeature; d: number; k: number }> => {
    const out: Array<{ f: EdgeFeature; d: number; k: number }> = [];
    let node = ni;
    let cur = arm;
    let offset = 0;
    for (let hop = 0; hop < 6; hop++) {
      const toward = cur.isA ? -1 : 1; // travel direction along the edge when heading to `node`
      for (const f of graph.edgeFeatures[cur.k]) {
        const d = offset + (cur.isA ? f.s : cur.len - f.s);
        if (d > maxDist) continue;
        if (f.dir !== 0 && f.dir !== toward) continue;
        out.push({ f, d, k: cur.k });
      }
      offset += cur.len;
      if (offset >= maxDist) break;
      const far = cur.isA ? cur.e.b : cur.e.a;
      if (nodes[far].arms.length !== 2) break;
      const next = allArms[far].find((a) => a.k !== cur.k);
      if (!next) break;
      node = far;
      cur = next;
    }
    void node;
    out.sort((p, q) => p.d - q.d);
    return out;
  };

  const isPedSignal = (f: EdgeFeature): boolean =>
    f.tags.traffic_signals === 'pedestrian_crossing' ||
    f.tags.traffic_signals === 'crossing' ||
    f.tags.crossing === 'traffic_signals' ||
    f.tags.highway === 'crossing';

  // ---- 1. which junction nodes are signal-controlled ----------------------
  const signalNode = new Uint8Array(nodes.length);
  const armSignalDist = new Map<string, number>(); // "node:edge" → stop line distance
  const usedSignalFeature = new Set<EdgeFeature>();
  nodes.forEach((n, ni) => {
    if (n.arms.length < 3) return;
    const tags = graph.nodeOsm[ni]?.tags;
    if (tags?.highway === 'traffic_signals') signalNode[ni] = 1;
    for (const arm of allArms[ni]) {
      if (!arm.approach) continue;
      const hit = approachFeatures(ni, arm, 55).find(
        (h) => h.f.kind === 'signal' && (h.f.dir !== 0 || (!isPedSignal(h.f) && h.d < 30) || h.d < 14),
      );
      if (!hit) continue;
      signalNode[ni] = 1;
      armSignalDist.set(`${ni}:${arm.k}`, hit.d);
      usedSignalFeature.add(hit.f);
    }
  });

  // cluster signalised nodes that belong to one junction
  const parent = new Int32Array(nodes.length).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const sigNodes: number[] = [];
  nodes.forEach((_, i) => {
    if (signalNode[i]) sigNodes.push(i);
  });
  for (let i = 0; i < sigNodes.length; i++) {
    for (let j = i + 1; j < sigNodes.length; j++) {
      const a = nodes[sigNodes[i]];
      const b = nodes[sigNodes[j]];
      if (Math.hypot(a.x - b.x, a.z - b.z) < 55 && Math.abs(a.y - b.y) < 3) parent[find(sigNodes[i])] = find(sigNodes[j]);
    }
  }
  const signals: SignalControllerJson[] = [];
  const controllerOf = new Map<number, number>(); // cluster root → controller index
  const clusterNodes = new Map<number, number[]>();
  for (const ni of sigNodes) {
    const r = find(ni);
    let list = clusterNodes.get(r);
    if (!list) clusterNodes.set(r, (list = []));
    list.push(ni);
  }

  // ---- 2. roles ------------------------------------------------------------
  const setRole = (ni: number, k: number, role: number): void => {
    const arm = nodes[ni].arms.find((a) => a.e === k)!;
    arm.r = role;
  };
  const setStop = (ni: number, k: number, d: number): void => {
    const arm = nodes[ni].arms.find((a) => a.e === k)!;
    arm.sl = Math.round(d * 100) / 100;
  };

  const pickPriorityPair = (arms: ArmInfo[]): [ArmInfo, ArmInfo] => {
    let best = -Infinity;
    let pair: [ArmInfo, ArmInfo] = [arms[0], arms[1]];
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        const a = arms[i];
        const b = arms[j];
        const align = -Math.cos(a.ang - b.ang);
        let score = (a.tier + b.tier) * 1.0 + align * 2.5;
        if (a.e.n && a.e.n === b.e.n) score += 1.5;
        if (a.e.r && a.e.r === b.e.r) score += 1.5;
        // a one-way pair that cannot be driven through is not a "through road"
        if (!((a.approach && b.exit) || (b.approach && a.exit))) score -= 3;
        if (score > best) {
          best = score;
          pair = [a, b];
        }
      }
    }
    return pair;
  };

  nodes.forEach((n, ni) => {
    const arms = allArms[ni];
    if (arms.length === 0) return;
    if (n.t === CTRL.MAP_END) return;
    if (arms.length <= 2) {
      n.t = CTRL.NONE;
      return;
    }
    const approaches = arms.filter((a) => a.approach);
    const exits = arms.filter((a) => a.exit);

    // explicit signs mapped in OSM
    const explicit = new Map<number, number>();
    for (const arm of approaches) {
      const hit = approachFeatures(ni, arm, 45).find((h) => h.f.kind === 'give_way' || h.f.kind === 'stop');
      if (!hit) continue;
      // an undirected sign node belongs to the nearer end of its road
      if (hit.f.dir === 0 && hit.d > arm.len * 0.5 && hit.k === arm.k) continue;
      explicit.set(arm.k, hit.f.kind === 'stop' ? ROLE.STOP : ROLE.YIELD);
      setStop(ni, arm.k, hit.d);
      bump(hit.f.kind === 'stop' ? 'explicit stop' : 'explicit give_way');
    }

    const roundabout = arms.some((a) => (a.e.f & EF.ROUNDABOUT) !== 0);
    const allOneWay = arms.every((a) => a.e.lb === 0 || a.e.lf === 0);
    const maxTier = Math.max(...arms.map((a) => a.tier));
    // "public" = of the highest standing present, but at least an ordinary street
    const pubTier = Math.min(2, maxTier);
    const pub = arms.filter((a) => a.tier >= pubTier);
    const role = new Map<number, number>();

    if (roundabout) {
      n.t = CTRL.ROUNDABOUT;
      for (const a of approaches) role.set(a.k, a.e.f & EF.ROUNDABOUT ? ROLE.PRIORITY : ROLE.YIELD);
      bump('roundabout nodes');
    } else if (allOneWay && approaches.length === 2 && exits.length === 1 && maxTier >= 2.5 && explicit.size === 0) {
      // merge: the straighter / higher-class carriageway keeps priority
      n.t = CTRL.MERGE;
      const ex = exits[0];
      const score = (a: ArmInfo): number => a.tier * 2 - Math.cos(a.ang - ex.ang) * 1.5 - (a.e.f & EF.LINK ? 3 : 0);
      const [p, q] = score(approaches[0]) >= score(approaches[1]) ? approaches : [approaches[1], approaches[0]];
      role.set(p.k, ROLE.PRIORITY);
      role.set(q.k, ROLE.YIELD);
      bump('merges');
    } else if (approaches.length <= 1) {
      n.t = allOneWay ? CTRL.MERGE : CTRL.SIGNS;
      for (const a of approaches) role.set(a.k, ROLE.PRIORITY);
      bump('diverges');
    } else {
      // lower-standing arms always yield (§ 10): driveways, tracks, car parks …
      for (const a of approaches) if (a.tier < pubTier) role.set(a.k, ROLE.MINOR);
      const pubApproaches = pub.filter((a) => a.approach);
      const inZone = pub.every((a) => (a.e.z ?? 0) >= 20 || a.e.c === CLS.RESIDENTIAL || a.e.c === CLS.LIVING_STREET);
      const equalStanding = pub.every((a) => a.tier === pub[0].tier);
      if (explicit.size > 0) {
        n.t = CTRL.SIGNS;
        for (const a of pubApproaches) role.set(a.k, ROLE.PRIORITY);
      } else if (pub.length <= 2) {
        n.t = CTRL.SIGNS;
        for (const a of pubApproaches) role.set(a.k, ROLE.PRIORITY);
        bump('minor side roads only');
      } else if ((equalStanding && pub[0].tier <= 2) || (inZone && maxTier <= 3)) {
        n.t = CTRL.RBL;
        for (const a of pubApproaches) role.set(a.k, ROLE.RBL);
        bump('rechts-vor-links');
      } else {
        n.t = CTRL.SIGNS;
        const [p, q] = pickPriorityPair(pub);
        for (const a of pubApproaches) role.set(a.k, a === p || a === q ? ROLE.PRIORITY : ROLE.YIELD);
        bump('derived priority road');
      }
    }
    for (const [k, r] of explicit) role.set(k, r);
    for (const a of arms) setRole(ni, a.k, a.approach ? (role.get(a.k) ?? ROLE.PRIORITY) : ROLE.NONE);
  });

  // ---- 3. signal controllers ----------------------------------------------
  for (const [rootNode, members] of clusterNodes) {
    const memberSet = new Set(members);
    interface SigArm {
      ni: number;
      arm: ArmInfo;
      axis: number;
    }
    const sigArms: SigArm[] = [];
    for (const ni of members) {
      for (const arm of allArms[ni]) {
        if (!arm.approach) continue;
        // "internal" = this approach starts at another node of the same junction a
        // few metres back (possibly through plain joints where a way was split)
        let internal = false;
        {
          let cur = arm;
          let dist = 0;
          for (let hop = 0; hop < 5; hop++) {
            dist += cur.len;
            if (dist > 55) break;
            const far = cur.isA ? cur.e.b : cur.e.a;
            if (memberSet.has(far)) {
              internal = true;
              break;
            }
            if (nodes[far].arms.length !== 2) break;
            const nx = allArms[far].find((a) => a.k !== cur.k);
            if (!nx) break;
            cur = nx;
          }
        }
        const hasFeature = armSignalDist.has(`${ni}:${arm.k}`);
        // Stubs inside the junction (median crossings, turn pockets) are cleared
        // on the signal of the entry: no second stop a few metres further on.
        if (internal && (!hasFeature || arm.len < 30)) continue;
        // unmapped approaches of a signalised junction are signalised too,
        // except driveways and the like
        if (!hasFeature && arm.tier < 2) continue;
        sigArms.push({ ni, arm, axis: arm.ang });
      }
    }
    if (sigArms.length === 0) continue;
    const ref = sigArms.reduce((best, s) => (s.arm.tier > best.arm.tier ? s : best), sigArms[0]);
    const group = (s: SigArm): number => (Math.abs(Math.sin(s.axis - ref.axis)) < 0.64 ? 0 : 1);
    const hasCross = sigArms.some((s) => group(s) === 1);
    let cx = 0;
    let cz = 0;
    for (const ni of members) {
      cx += nodes[ni].x;
      cz += nodes[ni].z;
    }
    cx /= members.length;
    cz /= members.length;
    const idx = signals.length;
    const mainFast = sigArms.some((s) => group(s) === 0 && Math.max(s.arm.e.mf, s.arm.e.mb) >= 70);
    const amber = mainFast ? 4 : 3;
    signals.push({
      x: Math.round(cx * 10) / 10,
      z: Math.round(cz * 10) / 10,
      groups: hasCross ? 2 : 1,
      phases: hasCross
        ? [
            { d: 28, s: 'GR' },
            { d: amber, s: 'AR' },
            { d: 1, s: 'RR' },
            { d: 1, s: 'RY' },
            { d: 18, s: 'RG' },
            { d: 3, s: 'RA' },
            { d: 1, s: 'RR' },
            { d: 1, s: 'YR' },
          ]
        : [
            { d: 42, s: 'G' },
            { d: amber, s: 'A' },
            { d: 12, s: 'R' },
            { d: 1, s: 'Y' },
          ],
      off: Math.round(hash01(Math.round(cx * 7 + cz * 13)) * 50),
    });
    controllerOf.set(rootNode, idx);
    for (const ni of members) {
      nodes[ni].t = CTRL.SIGNALS;
      nodes[ni].sc = idx;
    }
    for (const s of sigArms) {
      const armJson = nodes[s.ni].arms.find((a) => a.e === s.arm.k)!;
      armJson.g = group(s);
      const d = armSignalDist.get(`${s.ni}:${s.arm.k}`);
      if (d !== undefined) armJson.sl = Math.round(d * 100) / 100;
      bump('signalised approaches');
    }
    bump('signal controllers');
  }

  // ---- 4. crossings --------------------------------------------------------
  const crossings: CrossingJson[] = [];
  const nearestSignalArm = (k: number, s: number): { sc: number; g: number; d: number } | null => {
    const e = edges[k];
    let best: { sc: number; g: number; d: number } | null = null;
    for (const [ni, d] of [
      [e.a, s],
      [e.b, elen[k] - s],
    ] as Array<[number, number]>) {
      const n = nodes[ni];
      if (n.t !== CTRL.SIGNALS || n.sc === undefined || d > 40) continue;
      const arm = n.arms.find((a) => a.e === k)!;
      const g = arm.g ?? 0;
      if (!best || d < best.d) best = { sc: n.sc, g, d };
    }
    return best;
  };
  const newPedController = (x: number, z: number): number => {
    signals.push({
      x: Math.round(x * 10) / 10,
      z: Math.round(z * 10) / 10,
      groups: 1,
      phases: [
        { d: 48, s: 'G' },
        { d: 3, s: 'A' },
        { d: 13, s: 'R' },
        { d: 1, s: 'Y' },
      ],
      off: Math.round(hash01(Math.round(x * 3 + z * 11)) * 60),
      ped: true,
    });
    bump('pedestrian signals');
    return signals.length - 1;
  };
  const posAt = (k: number, s: number): [number, number] => {
    const e = edges[k];
    let acc = 0;
    for (let i = 3; i < e.p.length; i += 3) {
      const l = Math.hypot(e.p[i] - e.p[i - 3], e.p[i + 2] - e.p[i - 1]);
      if (acc + l >= s) {
        const t = l > 0 ? (s - acc) / l : 0;
        return [e.p[i - 3] + (e.p[i] - e.p[i - 3]) * t, e.p[i - 1] + (e.p[i + 2] - e.p[i - 1]) * t];
      }
      acc += l;
    }
    return [e.p[e.p.length - 3], e.p[e.p.length - 1]];
  };

  edges.forEach((e, k) => {
    const feats = graph.edgeFeatures[k];
    const tier = CLASS_TIER[e.c];
    for (const f of feats) {
      if (f.kind === 'level_crossing') {
        const tram = f.tags.railway !== 'level_crossing';
        crossings.push({ e: k, s: Math.round(f.s * 10) / 10, k: tram ? XING.TRAM : XING.RAIL, w: 6 });
        bump(tram ? 'tram crossings' : 'rail crossings');
        continue;
      }
      if (f.kind !== 'crossing') continue;
      if (tier < 2 && e.c !== CLS.LIVING_STREET) continue; // paths crossing driveways/tracks
      const t = f.tags;
      const markings = t['crossing:markings'];
      const signalised = t.crossing === 'traffic_signals' || t['crossing:signals'] === 'yes';
      const zebra =
        !signalised &&
        (t.crossing === 'zebra' ||
          t.crossing_ref === 'zebra' ||
          markings === 'zebra' ||
          // (marked, but with other lines than a zebra's – dashes, lines, a coloured surface: none painted here;
          // on a road built as the published map was – outside the detail region – every marked one, as then)
          (t.crossing === 'marked' && (graph.edgeNew?.[k] === false || markings === undefined || markings === 'yes')));
      const c: CrossingJson = {
        e: k,
        s: Math.round(f.s * 10) / 10,
        k: signalised ? XING.SIGNAL : zebra ? XING.ZEBRA : XING.UNMARKED,
        w: zebra ? 4 : 3.5,
      };
      if (t['crossing:island'] === 'yes') c.isl = true;
      if (signalised) {
        const near = nearestSignalArm(k, f.s);
        if (near) {
          c.sc = near.sc;
          c.g = near.g;
        } else {
          const [x, z] = posAt(k, f.s);
          c.sc = newPedController(x, z);
          c.g = 0;
        }
      }
      crossings.push(c);
      bump(signalised ? 'signalised crossings' : zebra ? 'zebra crossings' : 'unmarked crossings');
    }
    // signal heads mapped mid-block without a crossing node next to them
    for (const f of feats) {
      if (f.kind !== 'signal' || usedSignalFeature.has(f)) continue;
      const hasCrossing = crossings.some((c) => c.e === k && Math.abs(c.s - f.s) < 14 && c.k === XING.SIGNAL);
      if (hasCrossing) continue;
      // one controller per location (both directions are usually mapped separately)
      const [x, z] = posAt(k, f.s);
      let sc = -1;
      for (let i = 0; i < signals.length; i++) {
        if (signals[i].ped && Math.hypot(signals[i].x - x, signals[i].z - z) < 25) sc = i;
      }
      if (sc < 0) sc = newPedController(x, z);
      crossings.push({ e: k, s: Math.round(f.s * 10) / 10, k: XING.SIGNAL, w: 3.5, sc, g: 0 });
      bump('signalised crossings');
    }
  });

  // signalised arms stop before a signalised crossing lying between line and junction
  nodes.forEach((n, ni) => {
    if (n.t !== CTRL.SIGNALS) return;
    for (const arm of n.arms) {
      if (arm.g === undefined) continue;
      const e = edges[arm.e];
      const isA = e.a === ni;
      for (const c of crossings) {
        if (c.e !== arm.e || c.k !== XING.SIGNAL) continue;
        const d = isA ? c.s : elen[arm.e] - c.s;
        if (d < 28) arm.sl = Math.max(arm.sl ?? 0, Math.round((d + c.w / 2 + 1.2) * 100) / 100);
      }
    }
  });

  // ---- 5. turn restrictions ------------------------------------------------
  const banned: number[][] = [];
  for (const rel of osm.relations) {
    if (rel.tags.type !== 'restriction') continue;
    const kind = rel.tags.restriction ?? rel.tags['restriction:motorcar'] ?? '';
    if (!kind) continue;
    const from = rel.members.find((m) => m.role === 'from' && m.type === 'w');
    const to = rel.members.find((m) => m.role === 'to' && m.type === 'w');
    const via = rel.members.find((m) => m.role === 'via' && m.type === 'n');
    if (!from || !to || !via) continue;
    const ni = graph.nodeIndex.get(via.ref);
    if (ni === undefined) continue;
    const incident = (wayId: number): number | undefined =>
      (graph.wayEdges.get(wayId) ?? []).find((k) => edges[k].a === ni || edges[k].b === ni);
    const fe = incident(from.ref);
    const te = incident(to.ref);
    if (fe === undefined || te === undefined) continue;
    if (kind.startsWith('no_')) {
      banned.push([fe, ni, te]);
      bump('turn bans');
    } else if (kind.startsWith('only_')) {
      for (const arm of nodes[ni].arms) {
        if (arm.e !== fe && arm.e !== te) {
          banned.push([fe, ni, arm.e]);
          bump('turn bans');
        }
      }
    }
  }

  return { signals, crossings, banned, report };
}
