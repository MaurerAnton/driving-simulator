// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Places traffic-sign posts.
 *
 * The rules of each junction and road are already decided (control.ts,
 * roads.ts); this stage only puts up the signs a road authority would install
 * to express them, plus the signs mapped explicitly in OSM.
 *
 * tools/build-signs.ts adds to a map built before what this stage puts up
 * now (the town signs at junctions, the plates with times): it shares
 * `postBeside`, `parseSignTag` and the town signs (townsigns.ts) with it.
 */
import { newPolySample, projectOnPolyline, samplePolyline } from '../../src/core/geom.ts';
import type { PolyProjection, Polyline3 } from '../../src/core/geom.ts';
import { panelCodeFor, parseConditional, parseTimeWindow, windowSpec } from '../../src/sim/signtime.ts';
import type { TimeWindow } from '../../src/sim/signtime.ts';
import type { SignPost } from '../../src/world/tilefmt.ts';
import { ACCESS, CLASS_TIER, CLS, CTRL, EF, KERB_H, ROLE, XING } from '../../src/world/types.ts';
import type { PlaceJson } from '../../src/world/types.ts';
import { newSurfaceHit } from '../../src/world/world.ts';
import type { Arm, Edge, Node, World } from '../../src/world/world.ts';
import type { CoverMap } from './cover.ts';
import type { TileSet } from './meshacc.ts';
import type { ONode, OWay, Tags } from './osm.ts';
import type { RoadGraph } from './roads.ts';
import { townSignNear, townSignsAt } from './townsigns.ts';
import type { TownArm, TownSignSpot } from './townsigns.ts';

const tmp = newPolySample();

/** What putting a post beside a road needs of the road. */
export interface RoadSide {
  pl: Polyline3;
  len: number;
  width: number;
  /** pavement left and right of its course (0: none) */
  swL: number;
  swR: number;
  flags: number;
  cls: number;
}

/**
 * A post beside `road` at station `s` for traffic moving in direction `dir`
 * (+1 along the road's course, −1 against it), on the driver's right (`side`
 * 1) or left (−1): on the pavement just behind the kerb, or a metre beyond
 * the edge where there is none – its plates facing that traffic.  `y(s, x,
 * z)`: the height of the road there.
 */
export function postBeside(road: RoadSide, s: number, dir: number, codes: string[], y: (s: number, x: number, z: number) => number, side = 1, extraOut = 0): SignPost {
  s = Math.max(0.5, Math.min(road.len - 0.5, s));
  samplePolyline(road.pl, s, tmp);
  const urban = (road.flags & EF.URBAN) !== 0;
  // lateral offset relative to the road's course: the driver's right is -dir
  const lat = -dir * side;
  const sw = lat > 0 ? road.swL : road.swR;
  const bridge = (road.flags & EF.BRIDGE) !== 0;
  const out = road.width / 2 + (sw > 0 ? Math.min(0.55, sw * 0.4) : bridge ? 0.1 : 1.0) + extraOut;
  const x = tmp.x + tmp.tz * out * lat;
  const z = tmp.z - tmp.tx * out * lat;
  const h = y(s, x, z) + (sw > 0 ? KERB_H : bridge ? 0 : -0.15);
  // plates face the oncoming driver: facing vector = -travel direction
  const fx = -tmp.tx * dir;
  const fz = -tmp.tz * dir;
  const yaw = Math.atan2(-fx, -fz);
  const sp: SignPost = {
    x: Math.round(x * 100) / 100,
    y: Math.round(h * 100) / 100,
    z: Math.round(z * 100) / 100,
    yaw: Math.round(yaw * 1000) / 1000,
    s: codes.slice(),
    h: urban ? 2.1 : 1.7,
  };
  if (road.cls <= CLS.TRUNK_LINK) sp.big = 1;
  return sp;
}

/** Signs that warn of or rule what comes next (danger signs, give way, stop, priority, a crossing): mapped without a direction, they are for the traffic coming to the nearer junction. */
export function forWhatComes(codes: readonly string[]): boolean {
  return codes.some((c) => {
    const base = c.split(':')[0];
    const n = Number.parseFloat(base);
    return (n >= 100 && n < 200) || ['205', '206', '208', '301', '306', '307', '308', '350'].includes(base);
  });
}

/** Where a sign node of OpenStreetMap lies on or beside the road it was matched to. */
export interface SignOnRoad {
  /** a node of the road's own way (else it stands beside the road) */
  onWay: boolean;
  /** −1 where the road runs against its way (made of a one-way way drawn the other way round) */
  wayDir: number;
  /** station on the road, the road's course there (unit vector) and how far the node lies to the left of it */
  s: number;
  tx: number;
  tz: number;
  off: number;
  road: { len: number; lanesF: number; lanesB: number };
  /** are the road's ends junctions (three roads or more)? */
  junctionA: boolean;
  junctionB: boolean;
}

/**
 * The posts a sign node stands for: for which traffic (`dir` +1 along the
 * road's course), on which side (`side` −1: the driver's left), with which
 * plates.  The way it is read: a direction along the way it is a node of
 * ("forward"), a compass direction (the way its face looks: read by the
 * traffic going the other way), or – beside the road – the side it stands
 * on; without any, both ways (signDirections).  traffic_sign:forward /
 * :backward are for the traffic along / against the way.
 */
export function mappedSignPosts(tags: Tags, at: SignOnRoad): Array<{ dir: number; side: number; codes: string[] }> {
  const dirTag = tags['traffic_sign:direction'] ?? tags.direction;
  let dir = 0;
  if (dirTag !== undefined && /^\s*-?\d+(\.\d+)?\s*$/.test(dirTag)) {
    // (a face looking north – 0° – is read by traffic heading south: +z)
    const a = (Number(dirTag) * Math.PI) / 180;
    dir = -Math.sin(a) * at.tx + Math.cos(a) * at.tz >= 0 ? 1 : -1;
  } else if (at.onWay && (dirTag === 'forward' || dirTag === 'backward')) dir = (dirTag === 'forward' ? 1 : -1) * at.wayDir;
  else if (!at.onWay) {
    // beside the road: for the traffic that has it on its right – on a one-way road for its traffic
    if (at.road.lanesF === 0) dir = -1;
    else if (at.road.lanesB === 0) dir = 1;
    else dir = at.off > 0 ? -1 : 1;
  }
  const out: Array<{ dir: number; side: number; codes: string[] }> = [];
  // (beside a one-way road a sign may stand on its left)
  const oneWay = at.road.lanesF === 0 || at.road.lanesB === 0;
  const sideOf = (d: number): number => (!at.onWay && oneWay && at.off > 0 === d > 0 ? -1 : 1);
  const both = parseSignTag(tags.traffic_sign ?? '');
  if (both.length > 0) for (const d of signDirections(at.road, at.s, dir, both, at.junctionA, at.junctionB)) out.push({ dir: d, side: sideOf(d), codes: both });
  const fwd = parseSignTag(tags['traffic_sign:forward'] ?? '');
  if (fwd.length > 0) out.push({ dir: at.wayDir, side: sideOf(at.wayDir), codes: fwd });
  const back = parseSignTag(tags['traffic_sign:backward'] ?? '');
  if (back.length > 0) out.push({ dir: -at.wayDir, side: sideOf(-at.wayDir), codes: back });
  return out;
}

/** A sign with a time on it, as a way's conditional tags make it. */
export interface TimedSign {
  /** a speed limit (for vehicles over 3.5 t), the road shut to motor vehicles (to those over 3.5 t), no overtaking for them */
  kind: 'max' | 'hgvMax' | 'shut' | 'hgvShut' | 'overtake';
  /** the limit (km/h) */
  value: number;
  when: TimeWindow | 'wet';
  /** for the traffic along the way (+1 as it is drawn), against it (−1), or both (0) */
  along: number;
  /** the plates: the sign and the panel with the time */
  codes: string[];
  /** the same sign on the road before says the same: no new post */
  same: string;
}

/** the conditional tags that make signs with a time: what, and for which traffic */
export const CONDITIONAL = /^(maxspeed|maxspeed:hgv|motor_vehicle|vehicle|access|motorcar|hgv|overtaking:hgv)(:forward|:backward)?:conditional$/;

/**
 * The signs with a time of a way, from its conditional tags of OpenStreetMap
 * ("maxspeed:conditional = 30 @ (22:00-06:00)", "hgv:conditional = no @
 * (22:00-06:00)") – where its traffic_sign tag names the plates (with a time
 * panel), those.  Conditions that are not times (or "wet") make none.
 */
export function timedSigns(tags: Tags): TimedSign[] {
  const out: TimedSign[] = [];
  const plates = (suffix: string): string[] => {
    const tag = tags[`traffic_sign${suffix}`] ?? '';
    return /\b10(40|42)-/.test(tag) ? parseSignTag(tag) : [];
  };
  for (const [k, v] of Object.entries(tags)) {
    const m = CONDITIONAL.exec(k);
    if (!m) continue;
    const what = m[1];
    const along = m[2] === ':forward' ? 1 : m[2] === ':backward' ? -1 : 0;
    for (const c of parseConditional(v)) {
      let kind: TimedSign['kind'];
      let value = 0;
      if (what === 'maxspeed' || what === 'maxspeed:hgv') {
        value = Number.parseFloat(c.value);
        if (!(value > 0)) continue;
        kind = what === 'maxspeed' ? 'max' : 'hgvMax';
      } else if (c.value === 'no') kind = what === 'hgv' ? 'hgvShut' : what === 'overtaking:hgv' ? 'overtake' : 'shut';
      else continue;
      if (c.when === 'wet' && kind !== 'max') continue;
      const main = kind === 'max' || kind === 'hgvMax' ? `274-${value}` : kind === 'hgvShut' ? '253' : kind === 'overtake' ? '277' : what === 'vehicle' || what === 'access' ? '250' : what === 'motorcar' ? '251' : '260';
      const panel = c.when === 'wet' ? '1053-35' : `${panelCodeFor(c.when)}:${windowSpec(c.when)}`;
      const own = plates(along === 0 ? '' : along > 0 ? ':forward' : ':backward');
      const codes = own.length > 0 && own.some((p) => p.split(':')[0] === main) ? own : kind === 'hgvMax' ? [main, '1010-51', panel] : [main, panel];
      out.push({ kind, value, when: c.when, along, codes, same: `${kind}|${value}|${c.when === 'wet' ? 'wet' : windowSpec(c.when)}` });
    }
  }
  return out;
}

/** An arm as the town signs see it (townsigns.ts). */
export function townArm(arm: Arm): TownArm {
  const e = arm.edge;
  return {
    urban: (e.flags & EF.URBAN) !== 0,
    counts: CLASS_TIER[e.cls] >= 2 && e.cls > CLS.TRUNK_LINK && e.zone !== 7,
    signable: !(e.flags & (EF.ROUNDABOUT | EF.LINK)) && e.len > 8,
    approach: arm.isApproach,
    exit: arm.isExit,
  };
}

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
  /**
   * OpenStreetMap around (set by the caller): the ways the roads were made of
   * (their times on signs) and the tagged nodes – the signs among them that
   * stand beside a road rather than on it are put up too.
   */
  osm: { nodes: Map<number, ONode>; wayById: Map<number, OWay> } | null = null;

  constructor(world: World, ts: TileSet, places: PlaceJson[]) {
    this.world = world;
    this.ts = ts;
    this.places = places;
  }

  /**
   * Put a post beside `edge` at station `s` for traffic moving in direction
   * `dir` (+1 = a→b).  `side`: +1 = driver's right (default), -1 = driver's left.
   */
  private post(edge: Edge, s: number, dir: number, codes: string[], side = 1, extraOut = 0, alone = false): void {
    if (codes.length === 0) return;
    const sp = postBeside(edge, s, dir, codes, (at, x, z) => this.world.edgeY(edge, at, x, z), side, extraOut);
    // merge with an existing post at (almost) the same spot facing the same way (a town sign stands alone)
    if (!alone) {
      for (const p of this.posts) {
        if (Math.abs(p.x - sp.x) < 2.2 && Math.abs(p.z - sp.z) < 2.2 && Math.abs(Math.atan2(Math.sin(p.yaw - sp.yaw), Math.cos(p.yaw - sp.yaw))) < 0.5 && !p.s.some((c) => /^31[01]:/.test(c))) {
          for (const c of codes) if (!p.s.includes(c) && p.s.length < 4) p.s.push(c);
          return;
        }
      }
    }
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
    this.looseSigns(graph);
    this.timedSigns();
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

  /** The two lines of a town sign at (x, z): the place, and the town it belongs to – or for the town itself its county / title. */
  townName(x: number, z: number, name = ''): { enter: string; leave: string } {
    const m = this.municipalityAt(x, z);
    const label = name || this.nearestPlace(x, z) || m?.name || 'Baunatal';
    const town = !m ? `${label}|Kreis Kassel` : label === m.name ? `${m.name}|${m.sign}` : `${label}|Stadt ${m.name}`;
    return { enter: `310:${town}`, leave: `311:${label}` };
  }

  /** Town signs (Zeichen 310/311): mapped ones first, then wherever the road changes between inside and outside a built-up area. */
  private cityLimits(graph: SignGraph, cover: CoverMap): void {
    const world = this.world;
    const done: TownSignSpot[] = [];
    /**
     * One town sign, unless there is one for the same traffic already – on a post of its own: where a post
     * stands there, moved on `away` (+1 with the traffic, −1 against it), away from the junction.
     */
    const one = (edge: Edge, s: number, dir: number, kind: 'enter' | 'leave', name: string, away = 1): void => {
      const probe = postBeside(edge, s, dir, [], () => 0);
      const spot: TownSignSpot = { kind, x: probe.x, z: probe.z, yaw: probe.yaw };
      if (townSignNear(done, spot)) return;
      done.push(spot);
      let at = s;
      for (const ds of [6, 12, 18]) {
        const here = postBeside(edge, at, dir, [], () => 0);
        if (!this.posts.some((p) => Math.abs(p.x - here.x) < 3 && Math.abs(p.z - here.z) < 3 && Math.abs(Math.atan2(Math.sin(p.yaw - here.yaw), Math.cos(p.yaw - here.yaw))) < 0.9)) break;
        const next = s + away * dir * ds;
        if (next < 1 || next > edge.len - 1) break;
        at = next;
      }
      const n = this.townName(probe.x, probe.z, name);
      this.post(edge, at, dir, [kind === 'enter' ? n.enter : n.leave], 1, 0, true);
    };
    const place = (edge: Edge, s: number, enterDir: number, name: string): void => {
      one(edge, s, enterDir, 'enter', name);
      if (edge.lanesF > 0 && edge.lanesB > 0) one(edge, s, -enterDir, 'leave', name);
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
    // … and those mapped beside the road
    if (this.osm) {
      const onRoad = this.onRoadNodes(graph);
      const hit = newSurfaceHit();
      for (const n of this.osm.nodes.values()) {
        if (n.tags?.traffic_sign !== 'city_limit' || onRoad.has(n.id)) continue;
        if (!world.nearestRoad(n.x, n.z, 20, 0, hit) || !hit.edge) continue;
        const enter = builtAhead(hit.edge, hit.s, 1) >= builtAhead(hit.edge, hit.s, -1) ? 1 : -1;
        place(hit.edge, hit.s, enter, n.tags.name ?? '');
      }
    }
    // derived: wherever the road one drives on changes between inside and outside a built-up area – between
    // two sections of a road, at a junction, on a small road that leads into the town (townsigns.ts).
    // Only on request (SIGNS_DERIVED_TOWNS=1, as in tools/build-signs.ts): the built-up flag follows the houses,
    // not a town's legal boundary, so these stood where no town sign is.
    if (process.env.SIGNS_DERIVED_TOWNS !== '1') return;
    for (const node of world.nodes) {
      if (node.arms.length < 2) continue;
      for (const t of townSignsAt(node.arms.map(townArm))) {
        const arm = node.arms[t.arm];
        // (a few metres from the joint of two sections; beyond the corners of a junction)
        const d = node.arms.length > 2 ? Math.min(arm.cut + 4, arm.edge.len * 0.5) : Math.min(4, arm.edge.len * 0.3);
        const [s, dir] = t.side === 'away' ? this.depart(arm, d) : this.approach(arm, d);
        one(arm.edge, s, dir, t.kind, '', t.side === 'away' ? 1 : -1);
      }
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
        for (const dir of signDirections(edge, f.s, f.dir, codes, edge.a.arms.length > 2, edge.b.arms.length > 2)) this.post(edge, f.s, dir, codes);
      }
    });
  }

  /** The nodes of OpenStreetMap the map knows on its roads (features of the roads, junctions): the others with a sign stand beside a road. */
  private onRoadNodes(graph: SignGraph): Set<number> {
    const on = new Set<number>();
    for (const list of graph.edgeFeatures) for (const f of list) on.add(f.osm);
    for (const o of graph.nodeOsm) if (o) on.add(o.id);
    return on;
  }

  /** The signs mapped as nodes of their own beside a road (town signs aside: cityLimits). */
  private looseSigns(graph: SignGraph): void {
    if (!this.osm) return;
    const onRoad = this.onRoadNodes(graph);
    const hit = newSurfaceHit();
    for (const n of this.osm.nodes.values()) {
      const t = n.tags;
      if (!t || onRoad.has(n.id) || t.traffic_sign === 'city_limit' || !(t.traffic_sign || t['traffic_sign:forward'] || t['traffic_sign:backward'])) continue;
      if (!this.world.nearestRoad(n.x, n.z, 12, 0, hit) || !hit.edge) continue;
      const e = hit.edge;
      projectOnPolyline(e.pl, n.x, n.z, proj);
      samplePolyline(e.pl, proj.s, tmp);
      const at = { onWay: false, wayDir: 1, s: proj.s, tx: tmp.tx, tz: tmp.tz, off: proj.off, road: e, junctionA: e.a.arms.length > 2, junctionB: e.b.arms.length > 2 };
      for (const p of mappedSignPosts(t, at)) this.post(e, proj.s, p.dir, p.codes, p.side);
    }
  }

  /** The signs with a time on them (timedSigns), where what they say begins – and again after each junction. */
  private timedSigns(): void {
    const osm = this.osm;
    if (!osm) return;
    const of = new Map<Edge, { list: TimedSign[]; wayDir: number }>();
    for (const e of this.world.edges) {
      const way = e ? osm.wayById.get(e.osm) : undefined;
      if (!way) continue;
      const list = timedSigns(way.tags);
      if (list.length > 0) of.set(e, { list, wayDir: way.tags.oneway === '-1' || way.tags.oneway === 'reverse' ? -1 : 1 });
    }
    const has = (e: Edge, dir: number, same: string): boolean => {
      const o = of.get(e);
      return !!o && o.list.some((t) => t.same === same && (t.along === 0 || t.along * o.wayDir === dir));
    };
    for (const [e, { list, wayDir }] of of) {
      for (const t of list) {
        for (const dir of t.along !== 0 ? [t.along * wayDir] : [1, -1]) {
          if ((dir > 0 ? e.lanesF : e.lanesB) === 0) continue;
          const arm = dir > 0 ? e.armA : e.armB;
          if (arm.node.arms.length <= 2) {
            // (the road before says the same: no new post where two sections of a way join)
            const prev = arm.node.arms.find((a) => a.edge !== e);
            if (prev && has(prev.edge, prev.out ? -1 : 1, t.same)) continue;
          } else if (e.len < 40) continue;
          const [s, d] = this.depart(arm, Math.min(e.len * 0.5, arm.cut + (e.flags & EF.URBAN ? 12 : 30)));
          this.post(e, s, d, t.codes);
        }
      }
    }
  }
}

const proj: PolyProjection = { s: 0, off: 0, d2: 0, seg: 0 };

/**
 * For which traffic a sign mapped on a road stands (+1 along the road's
 * course, −1 against it): the way OpenStreetMap says (`dir`, already turned
 * to the road's course) – else on a one-way road its way, and on a road both
 * ways both, but a warning, a give-way or a priority sign only for the
 * traffic coming to the junction it is nearer to (within 80 m).
 */
export function signDirections(edge: { len: number; lanesF: number; lanesB: number }, s: number, dir: number, codes: readonly string[], junctionA = true, junctionB = true): number[] {
  if (dir !== 0) return [dir];
  if (edge.lanesF === 0) return [-1];
  if (edge.lanesB === 0) return [1];
  if (forWhatComes(codes)) {
    const toB = edge.len - s;
    if (junctionB && toB < 80 && (toB <= s || !junctionA)) return [1];
    if (junctionA && s < 80) return [-1];
  }
  return [1, -1];
}

/**
 * Is this a plate a post carries?  Not the ring on a lamp post (394), not the
 * boards with names and destinations (385 – 393, the signposts 4xx) the map
 * knows nothing of – but the detour signs (454 – 457), the beacons and
 * barriers (600 – 629) and the green arrow (720).
 */
function onAPost(base: string): boolean {
  const n = Number.parseFloat(base);
  if (!(n >= 100 && n < 1100)) return false;
  if (n >= 385 && n < 400) return false;
  if (n >= 400 && n < 1000) return (n >= 454 && n < 458) || (n >= 600 && n < 630) || n === 720;
  return true;
}

/** "7,5 t" → "7.5" (a number as the plates show it, or '' if there is none) */
function amount(v: string): string {
  const m = /(\d+(?:[.,]\d+)?)/.exec(v);
  return m ? m[1].replace(',', '.') : '';
}

/**
 * "DE:274[30],1040-30[22:00-06:00];DE:250" → ["274-30", "1040-30:22:00-06:00", "250"]:
 * the signs of a traffic_sign tag of OpenStreetMap as the codes of a sign
 * post, with what a plate shows after a colon – a time window as
 * OpenStreetMap writes it (src/sim/signtime.ts), a mass or a size ("262:7.5"),
 * a distance ("1004-30:150"), any other inscription as it is.  Speed limits
 * carry their speed in the code (274-30), so do the gradients (108-8).  Signs
 * are parted by "," and ";" outside brackets; at most four, in their order.
 */
export function parseSignTag(tag: string): string[] {
  const out: string[] = [];
  const items: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of tag) {
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';') && depth === 0) {
      items.push(cur);
      cur = '';
    } else cur += ch;
  }
  items.push(cur);
  for (const raw of items) {
    const c = raw.trim().replace(/^[A-Za-z]{2}:/, '');
    if (!c || c === 'city_limit') continue;
    const m = /^(\d+(?:\.\d+)?)(?:-(\d+))?(?:\[([^\]]*)\]|:(.+))?$/.exec(c);
    if (!m) continue;
    const baseCode = m[1];
    const sub = m[2];
    const value = (m[3] ?? m[4] ?? '').trim();
    if (!onAPost(baseCode)) continue;
    const code = sub ? `${baseCode}-${sub}` : baseCode;
    if (baseCode === '274' || baseCode === '278') {
      const v = amount(value) || sub;
      if (!v) continue;
      // old catalogue numbers 274-53 … 274-63 encode 30 … 130 km/h
      const n = Number(v);
      const speed = n > 50 && n < 64 && sub && !value ? [30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130][n - 53] : Math.round(n);
      if (speed) out.push(`${baseCode}-${speed}`);
    } else if (baseCode === '274.1' || baseCode === '274.2') {
      out.push(value === '20' || sub === '20' ? `${baseCode}-20` : baseCode);
    } else if ((baseCode === '108' || baseCode === '110') && amount(value)) {
      out.push(`${baseCode}-${Math.round(Number(amount(value)))}`);
    } else if (!value) {
      out.push(code);
    } else if (baseCode === '1040' || baseCode === '1042') {
      // a time: written the one way OpenStreetMap writes it, whichever way it was mapped ("22-6", "22:00-06:00")
      const w = parseTimeWindow(value);
      out.push(`${code}:${w ? windowSpec(w) : value}`);
    } else if (['262', '263', '264', '265', '266', '1052', '1053', '1060'].includes(baseCode)) {
      const v = amount(value);
      out.push(v ? `${code}:${v}` : code);
    } else out.push(`${code}:${value}`);
  }
  return out.slice(0, 4);
}
