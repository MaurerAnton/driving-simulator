// SPDX-License-Identifier: AGPL-3.0-only
// The signs as the published map's tiles have them (tools/mapgen/signs.ts of game 1.3.0, before the town signs
// and the other signs of 1.4.0), kept as it was but for the import paths: outside the detail region
// (tools/mapgen/detailregion.ts) and outside the tiles of the 1.6.0 patch (patch-1.6.0-tiles.json) the tile build
// must write the same bytes as then.  Do not improve it; improve tools/mapgen/signs.ts.
/**
 * Places traffic-sign posts.
 *
 * The rules of each junction and road are already decided (control.ts,
 * roads.ts); this stage only puts up the signs a road authority would install
 * to express them, plus the signs mapped explicitly in OSM.
 */
import { newPolySample, samplePolyline } from '../../../src/core/geom.ts';
import type { SignPost } from '../../../src/world/tilefmt.ts';
import { ACCESS, CLS, CTRL, EF, KERB_H, ROLE, XING } from '../../../src/world/types.ts';
import type { PlaceJson } from '../../../src/world/types.ts';
import type { Arm, Edge, Node, World } from '../../../src/world/world.ts';
import type { CoverMap } from '../cover.ts';
import type { TileSet } from '../meshacc.ts';
import type { RoadGraph } from '../roads.ts';

const tmp = newPolySample();

export interface SignStats {
  posts: number;
  byCode: Map<string, number>;
}

/** What the signs need of the road graph: what was mapped on each edge, and the node of OpenStreetMap behind each junction. */
export type SignGraph = Pick<RoadGraph, 'edgeFeatures' | 'nodeOsm'>;

export class SignPlacer {
  private readonly world: World;
  private readonly ts: TileSet;
  private readonly places: PlaceJson[];
  private readonly posts: SignPost[] = [];
  readonly stats: SignStats = { posts: 0, byCode: new Map() };

  /** which town a place belongs to and what stands under its name on the town sign (set by the caller) */
  municipalityAt: (x: number, z: number) => { name: string; sign: string } | null = () => ({ name: 'Baunatal', sign: 'Kreis Kassel' });

  constructor(world: World, ts: TileSet, places: PlaceJson[]) {
    this.world = world;
    this.ts = ts;
    this.places = places;
  }

  /**
   * Put a post beside `edge` at station `s` for traffic moving in direction
   * `dir` (+1 = a→b).  `side`: +1 = driver's right (default), -1 = driver's left.
   */
  private post(edge: Edge, s: number, dir: number, codes: string[], side = 1, extraOut = 0): void {
    if (codes.length === 0) return;
    s = Math.max(0.5, Math.min(edge.len - 0.5, s));
    samplePolyline(edge.pl, s, tmp);
    const urban = (edge.flags & EF.URBAN) !== 0;
    // lateral offset relative to the edge direction: driver's right is -dir
    const lat = -dir * side;
    const sw = lat > 0 ? edge.swL : edge.swR;
    const bridge = (edge.flags & EF.BRIDGE) !== 0;
    const out = edge.width / 2 + (sw > 0 ? Math.min(0.55, sw * 0.4) : bridge ? 0.1 : 1.0) + extraOut;
    const x = tmp.x + tmp.tz * out * lat;
    const z = tmp.z - tmp.tx * out * lat;
    const y = this.world.edgeY(edge, s, x, z) + (sw > 0 ? KERB_H : bridge ? 0 : -0.15);
    // plates face the oncoming driver: facing vector = -travel direction
    const fx = -tmp.tx * dir;
    const fz = -tmp.tz * dir;
    const yaw = Math.atan2(-fx, -fz);
    // merge with an existing post at (almost) the same spot facing the same way
    for (const p of this.posts) {
      if (Math.abs(p.x - x) < 2.2 && Math.abs(p.z - z) < 2.2 && Math.abs(Math.atan2(Math.sin(p.yaw - yaw), Math.cos(p.yaw - yaw))) < 0.5) {
        for (const c of codes) if (!p.s.includes(c) && p.s.length < 3) p.s.push(c);
        return;
      }
    }
    const big = edge.cls <= CLS.TRUNK_LINK ? 1 : 0;
    const sp: SignPost = {
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      z: Math.round(z * 100) / 100,
      yaw: Math.round(yaw * 1000) / 1000,
      s: codes.slice(),
      h: urban ? 2.1 : 1.7,
    };
    if (big) sp.big = 1;
    this.posts.push(sp);
  }

  /** Station and travel direction for traffic approaching `arm.node` at distance d. */
  private approach(arm: Arm, d: number): [number, number] {
    return arm.out ? [d, -1] : [arm.edge.len - d, 1];
  }

  /** Same for traffic leaving the node on this arm. */
  private depart(arm: Arm, d: number): [number, number] {
    return arm.out ? [d, 1] : [arm.edge.len - d, -1];
  }

  private limitOf(arm: Arm, leaving: boolean): number {
    const e = arm.edge;
    // leaving on an out-arm = travelling a→b
    const forward = arm.out === leaving;
    return forward ? e.maxF : e.maxB;
  }

  private nearestPlace(x: number, z: number): string {
    let best = '';
    let bd = 2600;
    for (const p of this.places) {
      if (!['suburb', 'village', 'town', 'hamlet', 'neighbourhood'].includes(p.kind)) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) {
        bd = d;
        best = p.name;
      }
    }
    return best;
  }

  build(graph: SignGraph, cover: CoverMap): void {
    const world = this.world;
    for (const node of world.nodes) this.junctionSigns(node);
    for (const node of world.nodes) this.limitSigns(node);
    this.cityLimits(graph, cover);
    this.crossingSigns();
    this.explicitSigns(graph);
    for (const p of this.posts) {
      this.ts.at(p.x, p.z).signs.push(p);
      this.stats.posts++;
      for (const c of p.s) {
        const k = c.split(':')[0];
        this.stats.byCode.set(k, (this.stats.byCode.get(k) ?? 0) + 1);
      }
    }
  }

  private junctionSigns(node: Node): void {
    const arms = node.arms;
    if (arms.length < 3) {
      // dead end ahead?
      return;
    }
    const anyYield = arms.some((a) => a.isApproach && (a.role === ROLE.YIELD || a.role === ROLE.STOP));
    for (const arm of arms) {
      const e = arm.edge;
      if (arm.isApproach) {
        const [s, dir] = this.approach(arm, arm.stopS + 1.2);
        if (arm.role === ROLE.STOP) this.post(e, s, dir, ['206']);
        else if (arm.role === ROLE.YIELD) {
          if (node.ctrl === CTRL.ROUNDABOUT) this.post(e, s, dir, ['205', '215']);
          else if (node.ctrl === CTRL.MERGE && e.cls <= CLS.TRUNK_LINK) {
            /* acceleration lanes carry no sign (§ 18 (3) StVO) */
          } else this.post(e, s, dir, ['205']);
        } else if (arm.role === ROLE.PRIORITY && anyYield && node.ctrl !== CTRL.ROUNDABOUT && node.ctrl !== CTRL.MERGE) {
          // only where a signed side road joins; driveways and tracks need nothing
          const d = Math.min(e.len * 0.5, arm.cut + (e.flags & EF.URBAN ? 22 : 60));
          const [s2, dir2] = this.approach(arm, d);
          this.post(e, s2, dir2, [e.tier >= 3 ? '306' : '301']);
        }
      }
      if (arm.isExit) {
        // signs greeting traffic that turns into this road
        const [s, dir] = this.depart(arm, arm.cut + 5);
        const others = arms.filter((a) => a !== arm && a.isApproach);
        const fromPublic = others.some((a) => a.edge.tier >= 2 && a.edge.access === ACCESS.YES);
        const codes: string[] = [];
        if (e.zone === 7 && others.some((a) => a.edge.zone !== 7)) codes.push('325.1');
        else if (e.zone === 30 && others.some((a) => a.edge.zone !== 30 && a.edge.tier >= 2)) codes.push('274.1');
        else if (e.zone === 20 && others.some((a) => a.edge.zone !== 20 && a.edge.tier >= 2)) codes.push('274.1-20');
        if (fromPublic && e.cls !== CLS.SERVICE) {
          if (e.access === ACCESS.DESTINATION) codes.push('250', '1020-30');
          else if (e.access === ACCESS.AGRICULTURAL) codes.push('260', '1026-38');
          else if (e.access === ACCESS.PRIVATE && e.tier >= 1) codes.push('250');
        }
        if (e.flags & EF.BICYCLE_ROAD && others.some((a) => !(a.edge.flags & EF.BICYCLE_ROAD))) codes.push('244.1');
        if (e.cls === CLS.MOTORWAY_LINK && others.some((a) => a.edge.cls > CLS.TRUNK_LINK) && arm.isExit && !arm.isApproach) {
          // only on-ramps (links that lead to the motorway)
          const far = arm.out ? e.b : e.a;
          if (far.arms.some((a) => a.edge.cls === CLS.MOTORWAY) || far.arms.every((a) => a.edge.cls <= CLS.MOTORWAY_LINK)) codes.push('330.1');
        }
        // cul-de-sac
        const far = arm.out ? e.b : e.a;
        if (far.arms.length === 1 && far.ctrl !== CTRL.MAP_END && e.len > 45 && e.tier >= 2 && e.access === ACCESS.YES) codes.push('357');
        if (codes.length) this.post(e, s, dir, codes);
      }
      if (arm.isApproach) {
        // leaving a zone / traffic-calmed area towards the junction
        const others = arms.filter((a) => a !== arm && a.isExit);
        const [s, dir] = this.approach(arm, arm.cut + 3.5);
        if (e.zone === 7 && others.some((a) => a.edge.zone !== 7)) this.post(e, s, dir, ['325.2'], 1, 0.3);
        else if (e.zone === 30 && others.some((a) => a.edge.zone !== 30 && a.edge.tier >= 2)) this.post(e, s, dir, ['274.2'], 1, 0.3);
        else if (e.zone === 20 && others.some((a) => a.edge.zone !== 20 && a.edge.tier >= 2)) this.post(e, s, dir, ['274.2-20'], 1, 0.3);
      }
      // one-way streets: no entry at the far end
      if (!arm.isExit && arm.isApproach && e.tier >= 1 && !(e.flags & (EF.ROUNDABOUT | EF.LINK)) && e.cls > CLS.TRUNK_LINK && !(e.flags & EF.DUAL)) {
        const [s, dir] = this.depart(arm, arm.cut + 1.5);
        this.post(e, s, dir, ['267']);
        this.post(e, s, dir, ['267'], -1);
      }
    }
  }

  /** Speed-limit signs after junctions and where the limit changes along a road. */
  private limitSigns(node: Node): void {
    const arms = node.arms;
    for (const arm of arms) {
      if (!arm.isExit) continue;
      const e = arm.edge;
      if (e.tier < 2 || e.zone > 0 || e.flags & EF.ROUNDABOUT) continue;
      const limit = this.limitOf(arm, true);
      const urban = (e.flags & EF.URBAN) !== 0;
      const motorway = e.cls === CLS.MOTORWAY;
      const implicit = motorway ? 0 : urban ? 50 : 100;
      // the road we continue from: the most opposite approach arm
      let prev: Arm | null = null;
      let bestAlign = -0.3;
      for (const a of arms) {
        if (a === arm || !a.isApproach) continue;
        const align = -(a.dx * arm.dx + a.dz * arm.dz);
        if (align > bestAlign) {
          bestAlign = align;
          prev = a;
        }
      }
      const prevLimit = prev ? this.limitOf(prev, false) : implicit;
      const prevZone = prev ? prev.edge.zone : 0;
      const [s, dir] = this.depart(arm, arm.cut + (motorway ? 40 : 14));
      const explicit = limit !== implicit;
      if (arms.length >= 3) {
        // limits end at junctions unless repeated
        if (explicit && limit > 0 && e.len > 60) this.post(e, s, dir, [`274-${limit}`]);
      } else if (limit !== prevLimit || prevZone > 0) {
        if (explicit && limit > 0) this.post(e, s, dir, [`274-${limit}`]);
        else if (!explicit && prev && prevZone === 0) {
          const prevUrban = (prev.edge.flags & EF.URBAN) !== 0;
          // a town sign already announces 50/100 at the boundary
          if (prevUrban === urban) this.post(e, s, dir, [urban && limit === 50 && prevLimit < 50 ? '274-50' : '282']);
        }
      }
    }
  }

  /** Town signs (Zeichen 310/311): mapped ones first, then derived boundaries. */
  private cityLimits(graph: SignGraph, cover: CoverMap): void {
    const world = this.world;
    const done: Array<[number, number]> = [];
    const place = (edge: Edge, s: number, enterDir: number, name: string): void => {
      samplePolyline(edge.pl, s, tmp);
      for (const d of done) if (Math.hypot(d[0] - tmp.x, d[1] - tmp.z) < 120) return;
      done.push([tmp.x, tmp.z]);
      // second line of the sign: the district's town, or for the town itself its county / title
      const m = this.municipalityAt(tmp.x, tmp.z);
      const label = name || this.nearestPlace(tmp.x, tmp.z) || m?.name || 'Baunatal';
      const town = !m ? `${label}|Kreis Kassel` : label === m.name ? `${m.name}|${m.sign}` : `${label}|Stadt ${m.name}`;
      this.post(edge, s, enterDir, [`310:${town}`]);
      if (edge.lanesF > 0 && edge.lanesB > 0) this.post(edge, s, -enterDir, [`311:${label}`]);
    };
    const builtAhead = (edge: Edge, s: number, dir: number): number => {
      let votes = 0;
      for (const d of [30, 70, 120]) {
        samplePolyline(edge.pl, s + dir * d, tmp);
        if (cover.builtUp(tmp.x, tmp.z)) votes++;
      }
      return votes;
    };
    // mapped town signs
    world.edges.forEach((edge, k) => {
      for (const f of graph.edgeFeatures[k]) {
        if (f.kind !== 'sign' || f.tags.traffic_sign !== 'city_limit') continue;
        const enter = builtAhead(edge, f.s, 1) >= builtAhead(edge, f.s, -1) ? 1 : -1;
        place(edge, f.s, enter, f.tags.name ?? '');
      }
    });
    graph.nodeOsm.forEach((o, ni) => {
      if (o?.tags?.traffic_sign !== 'city_limit') return;
      const node = world.nodes[ni];
      const arm = node.arms[0];
      if (!arm) return;
      const [s] = arm.out ? [1, 1] : [arm.edge.len - 1, 1];
      const enter = builtAhead(arm.edge, s, 1) >= builtAhead(arm.edge, s, -1) ? 1 : -1;
      place(arm.edge, s, enter, o.tags.name ?? '');
    });
    // derived: the built-up flag changes between two consecutive road sections
    for (const node of world.nodes) {
      if (node.arms.length !== 2) continue;
      const [p, q] = node.arms;
      if (p.edge.tier < 2 || q.edge.tier < 2 || p.edge.cls <= CLS.TRUNK_LINK) continue;
      const pu = (p.edge.flags & EF.URBAN) !== 0;
      const qu = (q.edge.flags & EF.URBAN) !== 0;
      if (pu === qu) continue;
      const urbanArm = pu ? p : q;
      const [s, dir] = this.depart(urbanArm, Math.min(4, urbanArm.edge.len * 0.3));
      place(urbanArm.edge, s, dir, '');
    }
  }

  private crossingSigns(): void {
    for (const c of this.world.crossings) {
      const e = this.world.edges[c.e];
      if (c.k === XING.ZEBRA) {
        if (e.lanesF > 0) this.post(e, c.s - c.w / 2 - 0.6, 1, ['350']);
        if (e.lanesB > 0) this.post(e, c.s + c.w / 2 + 0.6, -1, ['350']);
      } else if (c.k === XING.RAIL || c.k === XING.TRAM) {
        if (e.tier < 1) continue;
        if (e.lanesF > 0) this.post(e, c.s - 4.5, 1, ['201-50']);
        if (e.lanesB > 0) this.post(e, c.s + 4.5, -1, ['201-50']);
        if (c.k === XING.RAIL && e.tier >= 2) {
          if (e.lanesF > 0 && c.s > 150) this.post(e, c.s - 140, 1, ['151']);
          if (e.lanesB > 0 && e.len - c.s > 150) this.post(e, c.s + 140, -1, ['151']);
        }
      }
    }
  }

  /** Signs mapped as OSM nodes with a DE:… code. */
  private explicitSigns(graph: SignGraph): void {
    this.world.edges.forEach((edge, k) => {
      for (const f of graph.edgeFeatures[k]) {
        if (f.kind === 'bus_stop') {
          this.post(edge, f.s, 1, ['224']);
          continue;
        }
        if (f.kind !== 'sign') continue;
        const codes = parseSignTag(f.tags.traffic_sign ?? '');
        if (codes.length === 0) continue;
        const dir = f.dir !== 0 ? f.dir : 1;
        this.post(edge, f.s, dir, codes);
      }
    });
  }
}

/** "DE:274[30];DE:1020-30" → ["274-30", "1020-30"] (only codes we can draw). */
export function parseSignTag(tag: string): string[] {
  const out: string[] = [];
  for (const raw of tag.split(/[;,]/)) {
    let c = raw.trim().replace(/^DE:/i, '');
    if (!c || c === 'city_limit') continue;
    const m = /^(\d+(?:\.\d+)?)(?:-(\d+))?(?:\[(-?[\d.]+)\])?/.exec(c);
    if (!m) continue;
    const baseCode = m[1];
    if (baseCode === '274' || baseCode === '278') {
      const v = m[3] ?? m[2];
      if (!v) continue;
      // old catalogue numbers 274-53 … 274-63 encode 30 … 130 km/h
      const n = Number(v);
      const speed = n > 50 && n < 64 && m[2] && !m[3] ? [30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130][n - 53] : n;
      if (speed) out.push(`${baseCode}-${speed}`);
    } else if (baseCode === '274.1' || baseCode === '274.2') {
      out.push(m[3] === '20' ? `${baseCode}-20` : baseCode);
    } else {
      c = m[2] ? `${baseCode}-${m[2]}` : baseCode;
      out.push(c);
    }
  }
  return out.slice(0, 3);
}
