// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The cross-section of a road beyond its driving lanes: what lies on each
 * side between the outermost lane and the far edge of the pavement, and
 * what lies between the two carriageways of a dual road.
 *
 * From the middle of the road outwards, one side is laid out as
 *
 *   lanes | hard strip | cycle lane | parking (on the road) | KERB |
 *   parking (on the pavement) | verge | cycle track | pavement
 *
 * The map build reads it from OpenStreetMap's tags (tools/mapgen/xsection.ts)
 * and stores it with each road (EdgeJson.xl / xr, md).  Everything from the
 * lanes to the kerb is carriageway – the road's `w` – and the lanes keep
 * clear of what is not for driving (World: marginL / marginR); everything
 * beyond the kerb is the road's `sl` / `sr`, at kerb height.
 */

/** where the cars stand (parking:<side>=…) */
export const PARK = { NONE: 0, LANE: 1, STREET_SIDE: 2, HALF_ON_KERB: 3, ON_KERB: 4, SHOULDER: 5 } as const;
/** how they stand (parking:<side>:orientation=…) */
export const ORIENT = { PARALLEL: 0, DIAGONAL: 1, PERPENDICULAR: 2 } as const;
/** a cycle lane on the carriageway, or a track of its own beyond the kerb (cycleway:<side>=…) */
export const CYCLE = { NONE: 0, LANE: 1, TRACK: 2 } as const;
/** the kerb between carriageway and pavement (kerb:<side>=…) */
export const KERB = { RAISED: 0, LOWERED: 1, FLUSH: 2 } as const;
/** what lies between the carriageways of a dual road (median:contents=…, bits); PAVED: paving stones */
export const MEDIAN = { GRASS: 1, PARKING: 2, HEDGE: 4, TREES: 8, PAVED: 16 } as const;
/** what stands right behind the pavement (frontage:<side>=…) */
export const FRONT = { NONE: 0, HEDGE: 1, FENCE: 2, WALL: 3, LAWN: 4 } as const;
/** usual heights by FRONT (m): a garden hedge is mostly kept at about 1–1.2 m (the map build varies it plot by plot) */
export const FRONT_HEIGHTS = [0, 1.2, 1.2, 1.0, 0] as const;
/**
 * how far behind the pavement a hedge, fence or wall stands when nothing is tagged (m): right behind a
 * pavement; where there is none, behind the gutter or a narrow gravel strip
 */
export const FRONT_OFFSETS = { behindWalk: 0.05, noWalk: 0.5 } as const;
/** width of the paved gutter (Rinne) between asphalt and kerb in towns, when nothing is tagged (m) */
export const GUTTER_DEFAULT = 0.4;

/** One side of a road as stored with it (all fields optional: absent = none / the default). */
export interface RoadSideJson {
  /** PARK */
  p?: number;
  /** ORIENT */
  po?: number;
  /** depth of the parking strip across the road (m) */
  pw?: number;
  /** 1: the bays are marked with lines */
  pm?: number;
  /** share of the bays a car stands in (0…1), absent: 60–80 % (the map build's parked cars only) */
  pq?: number;
  /** CYCLE */
  c?: number;
  /** width of the cycle lane or track (m) */
  cw?: number;
  /** 1: red surface */
  cr?: number;
  /** 1: an advisory lane (Schutzstreifen, dashed line); else a lane of its own (Radfahrstreifen, solid line) */
  ca?: number;
  /** 1: the track is paved with stones (else asphalt) */
  cs?: number;
  /** width of the grass verge between kerb and pavement (m) */
  v?: number;
  /** KERB */
  k?: number;
  /** width of the paved gutter along the kerb (m); 0: none; absent: the default (gutterWidth) */
  g?: number;
  /** painted edge line: 1 yes, 0 no; absent: as the road's class says (EF.EDGE_LINES) */
  el?: number;
  /** 1: the verge is paved (paving stones) rather than grass */
  vp?: number;
  /** 1: young trees stand in the verge */
  vt?: number;
  /** a kerbed tree bulb in place of a parking bay every this many metres (0 / absent: none) */
  pt?: number;
  /** FRONT: a hedge, fence, wall or lawn right behind the pavement */
  ft?: number;
  /** its height (m), absent: FRONT_HEIGHTS */
  fh?: number;
  /** how far behind the pavement (or the kerb, where there is none) it stands (m), absent: FRONT_OFFSETS */
  fo?: number;
  /** what the pavement is made of: a ground material (src/world/tilefmt.ts GM); absent: grey slabs (GM.SIDEWALK) */
  wm?: number;
}

/** kerb heights by KERB (m) */
export const KERB_HEIGHTS = [0.12, 0.03, 0] as const;

/** How deep a parking strip is across the road, by ORIENT: cars along the kerb, at an angle, side by side. */
export function parkDepth(orient: number): number {
  return orient === ORIENT.PERPENDICULAR ? 5.0 : orient === ORIENT.DIAGONAL ? 5.3 : 2.0;
}

/** The depth of the side's parking strip (0: none). */
export function parkWidth(s: RoadSideJson | undefined): number {
  if (!s || !s.p) return 0;
  return s.pw ?? parkDepth(s.po ?? ORIENT.PARALLEL);
}

/** How much of the side lies on the carriageway beyond the lanes: cycle lane and the cars' part of it. */
export function sideInner(s: RoadSideJson | undefined): number {
  if (!s) return 0;
  const pw = parkWidth(s);
  let w = s.c === CYCLE.LANE ? (s.cw ?? 1.5) : 0;
  if (s.p === PARK.LANE || s.p === PARK.STREET_SIDE || s.p === PARK.SHOULDER) w += pw;
  else if (s.p === PARK.HALF_ON_KERB) w += pw / 2;
  return w;
}

/** How much of the side lies beyond the kerb before the pavement proper: cars on it, verge, cycle track. */
export function sideOuter(s: RoadSideJson | undefined): number {
  if (!s) return 0;
  const pw = parkWidth(s);
  let w = s.p === PARK.ON_KERB ? pw : s.p === PARK.HALF_ON_KERB ? pw / 2 : 0;
  w += s.v ?? 0;
  if (s.c === CYCLE.TRACK) w += s.cw ?? 1.6;
  return w;
}

/** Height of the kerb of a side. */
export function kerbHeight(s: RoadSideJson | undefined): number {
  return KERB_HEIGHTS[s?.k ?? 0] ?? KERB_HEIGHTS[0];
}

/** Is there anything to store about a side? */
export function sideIsPlain(s: RoadSideJson | undefined): boolean {
  return !s || Object.keys(s).length === 0;
}

/** Where everything of one side lies: distances from the centreline outwards (m). */
export interface SideLayout {
  /** the kerb line (= half the carriageway) */
  kerb: number;
  kerbH: number;
  /** the outer edge of the lanes and their hard strip: from here on nothing is driven along */
  laneEdge: number;
  cycleLane: [number, number] | null;
  /** the strip the parked cars stand in (it straddles the kerb for half_on_kerb) */
  park: [number, number] | null;
  verge: [number, number] | null;
  track: [number, number] | null;
  /** the pavement proper (null: none) */
  walk: [number, number] | null;
  /** the far edge of it all (= kerb + sl / sr) */
  outer: number;
}

/**
 * The layout of one side of a road whose carriageway is `half` wide on each
 * side of the centreline and has `beyond` metres beyond its kerb on this side
 * (the road's sl or sr).
 */
export function sideLayout(half: number, beyond: number, s: RoadSideJson | undefined): SideLayout {
  const pw = parkWidth(s);
  const kerb = half;
  let inner = kerb;
  let park: [number, number] | null = null;
  if (s && s.p) {
    if (s.p === PARK.HALF_ON_KERB) park = [kerb - pw / 2, kerb + pw / 2];
    else if (s.p === PARK.ON_KERB) park = [kerb, kerb + pw];
    else park = [kerb - pw, kerb];
    inner = Math.min(inner, park[0]);
  }
  let cycleLane: [number, number] | null = null;
  if (s?.c === CYCLE.LANE) {
    const cw = s.cw ?? 1.5;
    cycleLane = [inner - cw, inner];
    inner -= cw;
  }
  let out = s && (s.p === PARK.ON_KERB || s.p === PARK.HALF_ON_KERB) && park ? park[1] : kerb;
  const outerEdge = kerb + Math.max(0, beyond);
  let verge: [number, number] | null = null;
  if (s?.v && s.v > 0) {
    verge = [out, Math.min(outerEdge, out + s.v)];
    out = verge[1];
  }
  let track: [number, number] | null = null;
  if (s?.c === CYCLE.TRACK) {
    track = [out, Math.min(outerEdge, out + (s.cw ?? 1.6))];
    out = track[1];
  }
  const walk: [number, number] | null = outerEdge - out > 0.3 ? [out, outerEdge] : null;
  return { kerb, kerbH: beyond > 0 ? kerbHeight(s) : 0, laneEdge: inner, cycleLane, park, verge, track, walk, outer: outerEdge };
}

/**
 * The width of the paved gutter (Rinne) between the asphalt and the kerb of
 * one side: as tagged, else GUTTER_DEFAULT on a road in town with a raised
 * kerb on that side (`urban`, `kerbH` the side's kerb height, 0 without a
 * pavement), else none.  Not on bays with their own paving (street_side).
 */
export function gutterWidth(s: RoadSideJson | undefined, urban: boolean, kerbH: number): number {
  if (kerbH < 0.005 || s?.p === PARK.STREET_SIDE) return 0;
  if (s?.g !== undefined) return s.g;
  return urban && kerbH >= 0.08 ? GUTTER_DEFAULT : 0;
}

/** Is there a painted edge line on this side?  `byClass`: the road's default (EF.EDGE_LINES). */
export function edgeLineOn(s: RoadSideJson | undefined, byClass: boolean): boolean {
  return s?.el !== undefined ? s.el === 1 : byClass;
}

/** The bits of a median:contents value ("grass;trees" …). */
export function medianBits(v: string | undefined): number {
  if (!v) return 0;
  let bits = 0;
  for (const part of v.split(';')) {
    const p = part.trim().toLowerCase();
    if (p === 'grass') bits |= MEDIAN.GRASS;
    else if (p === 'parking') bits |= MEDIAN.PARKING;
    else if (p === 'hedge') bits |= MEDIAN.HEDGE;
    else if (p === 'trees' || p === 'tree') bits |= MEDIAN.TREES;
    else if (p === 'paving_stones' || p === 'paved' || p === 'sett' || p === 'cobblestone') bits |= MEDIAN.PAVED;
  }
  return bits;
}
