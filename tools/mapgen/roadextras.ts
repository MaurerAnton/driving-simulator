// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What a road carries besides its cross-section, read from the tags of its
 * way and the nodes on it, and stored with each road (EdgeJson, src/world/types.ts):
 *
 * - traffic calming across the carriageway (`cm`): nodes with
 *   traffic_calming=table | hump | bump | cushion (with `length` and
 *   `height` where mapped), or a short way that is such a thing itself;
 * - kerb build-outs (`bo`): nodes with traffic_calming=choker | chicane
 *   (src/world/narrowing.ts);
 * - mouths over a continuous pavement (`mk`): `mouth:kerb=lowered` (our own
 *   key; `raised` says no), and without it a living street or a pedestrian
 *   service way paved with stones, a driveway, an emergency access;
 * - the give-way line at a yield (`gl`): `markings:give_way=yes | no` (our
 *   own key); without it painted where a give-way or stop sign is mapped on
 *   the road;
 * - zigzag lines (Zeichen 299) along the kerb (`zz`): `markings:zigzag=left |
 *   right | both` (our own key, sides in the way's drawing direction); and
 *   15 m either side of a bus stop on the road that says
 *   `markings:zigzag=yes | left | right | both` (`zs`);
 * - text painted on the carriageway (`rt`): `road_text=<text>` (our own key)
 *   in the lanes going the way's drawing direction, `road_text:position`
 *   metres from the way's start (default 10; several with `;`), and
 *   `road_text:backward=<text>` in the lanes going against it,
 *   `road_text:backward:position` metres from the way's end.
 */
import { CALM, CALM_DEFAULTS, TABLE_RAMP, calmKind } from '../../src/world/roadfeatures.ts';
import { buildOutEntries } from '../../src/world/narrowing.ts';
import { CLS, SURF } from '../../src/world/types.ts';
import type { EdgeJson } from '../../src/world/types.ts';
import type { OWay, Tags } from './osm.ts';
import type { EdgeFeature, RoadGraph } from './roads.ts';

function num(v: string | undefined): number {
  if (v === undefined) return Number.NaN;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(cm|m)?/.exec(v);
  if (!m) return Number.NaN;
  const x = Number(m[1].replace(',', '.'));
  return m[2] === 'cm' ? x / 100 : x;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

function edgeLength(e: EdgeJson): number {
  let l = 0;
  for (let i = 3; i < e.p.length; i += 3) l += Math.hypot(e.p[i] - e.p[i - 3], e.p[i + 2] - e.p[i - 1]);
  return l;
}

/** Is the way stored against its drawing direction (oneway=-1)? */
function reversedWay(t: Tags): boolean {
  return t.oneway === '-1' || t.oneway === 'reverse';
}

/** The calming entries of a road (EdgeJson.cm): from the nodes on it, and from its way if that is a table or hump itself. */
export function calmingOf(tags: Tags, feats: readonly EdgeFeature[], len: number): number[] {
  const out: number[] = [];
  const entry = (s: number, kind: number, t: Tags, own: number): void => {
    const d = CALM_DEFAULTS[kind];
    let l = num(t.length);
    if (!(l >= 0.3 && l <= 30)) l = own > 0 ? own : d.len;
    let h = num(t.height);
    if (!(h >= 0.02 && h <= 0.2)) h = d.h;
    out.push(r2(s), kind, r2(l), r2(h));
  };
  for (const f of feats) {
    if (f.kind !== 'bump') continue;
    const k = calmKind(f.tags.traffic_calming);
    if (k) entry(f.s, k, f.tags, 0);
  }
  const wk = calmKind(tags.traffic_calming);
  if (wk && len <= 40) {
    // (a way mapped as the table: its length is the top and the ramps)
    // (and room to spare at its ends: calmCentre keeps 0.3 m from the junction areas)
    const own = wk === CALM.TABLE ? Math.max(1, len - 2 * TABLE_RAMP - 1.4) : 0;
    entry(len / 2, wk, wk === CALM.TABLE ? {} : tags, own);
  }
  return out;
}

/** Does this road meet others over a continuous pavement (EdgeJson.mk)? */
export function mouthOf(tags: Tags, e: EdgeJson): boolean {
  const k = tags['mouth:kerb'];
  if (k === 'lowered' || k === 'flush' || k === 'yes') return true;
  if (k === 'raised' || k === 'no') return false;
  const paved = e.s === SURF.PAVING || e.s === SURF.SETT;
  if (e.c === CLS.LIVING_STREET && paved) return true;
  if (e.c === CLS.SERVICE && (tags.service === 'driveway' || tags.service === 'emergency_access')) return true;
  return false;
}

/** Side bits (1 left, 2 right of the stored direction) of a left | right | both value in the drawing direction. */
function sideBits(v: string | undefined, reversed: boolean): number {
  const l = v === 'left' || v === 'both' ? 1 : 0;
  const r = v === 'right' || v === 'both' ? 2 : 0;
  const bits = l | r;
  return reversed ? ((bits & 1) << 1) | ((bits & 2) >> 1) : bits;
}

function positions(v: string | undefined): number[] {
  if (v === undefined) return [10];
  const out = v
    .split(';')
    .map((x) => num(x))
    .filter((x) => x >= 0);
  return out.length ? out : [10];
}

/** Add calming, mouths, give-way lines, zigzags and road text to the roads of a graph (buildRoadGraph). */
export function addRoadExtras(graph: RoadGraph): void {
  const byWay = new Map<OWay, number[]>();
  graph.edges.forEach((e, i) => {
    // (only the roads built the new way: outside the detail region the map stays as published – mapgen/detailregion.ts)
    if (graph.edgeNew && !graph.edgeNew[i]) return;
    const way = graph.edgeWay[i];
    const t = way.tags;
    const feats = graph.edgeFeatures[i] ?? [];
    const len = edgeLength(e);
    const rev = reversedWay(t);
    const cm = calmingOf(t, feats, len);
    if (cm.length) e.cm = cm;
    const bo = buildOutEntries(feats);
    if (bo.length) e.bo = bo;
    if (mouthOf(t, e)) e.mk = 1;
    const gw = t['markings:give_way'];
    if (gw === 'yes') e.gl = 1;
    else if (gw === 'no') e.gl = 0;
    else if (feats.some((f) => f.kind === 'give_way' || f.kind === 'stop')) e.gl = 1;
    const zz = sideBits(t['markings:zigzag'], rev);
    if (zz) e.zz = zz;
    const zs: number[] = [];
    for (const f of feats) {
      if (f.kind !== 'bus_stop') continue;
      const v = f.tags['markings:zigzag'];
      if (!v || v === 'no') continue;
      // (yes: on the kerb of the traffic the stop serves – both where that is not known)
      let bits = v === 'yes' ? (f.dir > 0 ? 2 : f.dir < 0 ? 1 : 3) : sideBits(v, rev);
      if (!bits) bits = 3;
      zs.push(r2(f.s - 15), r2(f.s + 15), bits);
    }
    if (zs.length) e.zs = zs;
    if (t.road_text || t['road_text:backward']) {
      let list = byWay.get(way);
      if (!list) byWay.set(way, (list = []));
      list.push(i);
    }
  });
  // text: by station along the whole way (its roads in stored order)
  for (const [way, list] of byWay) {
    const t = way.tags;
    const rev = reversedWay(t);
    const starts: number[] = [];
    let total = 0;
    for (const i of list) {
      starts.push(total);
      total += edgeLength(graph.edges[i]);
    }
    const put = (text: string, sDraw: number, forward: boolean): void => {
      const s = Math.max(0.5, Math.min(total - 0.5, rev ? total - sDraw : sDraw));
      const dir = forward !== rev ? 1 : -1;
      for (let k = list.length - 1; k >= 0; k--) {
        if (s < starts[k]) continue;
        const e = graph.edges[list[k]];
        (e.rt ??= []).push([text, r2(s - starts[k]), dir]);
        return;
      }
    };
    if (t.road_text) for (const p of positions(t['road_text:position'])) put(t.road_text, p, true);
    if (t['road_text:backward']) for (const p of positions(t['road_text:backward:position'])) put(t['road_text:backward'], total - p, false);
  }
}
