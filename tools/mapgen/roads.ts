// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OSM ways → drivable road graph (nodes, edges, attributes, refined
 * centreline geometry).  Elevation, right-of-way and meshes are added by
 * later pipeline stages.
 */
import { angleOf, clamp } from '../../src/core/geom.ts';
import { ACCESS, CLASS_LANE_WIDTH, CLASS_TIER, CLS, CTRL, EF, ROLE, SURF } from '../../src/world/types.ts';
import type { EdgeJson, NodeJson } from '../../src/world/types.ts';
import { GM } from '../../src/world/tilefmt.ts';
import type { ONode, OWay, OsmData, Tags } from './osm.ts';
import { sideInner, sideIsPlain, sideOuter } from '../../src/world/xsection.ts';
import type { RoadSideJson } from '../../src/world/xsection.ts';
import { FootwayIndex, measureSeparateWalk, taggedSides } from './xsection.ts';
import { addRoadExtras } from './roadextras.ts';

const DRIVE_CLASS: Record<string, number> = {
  motorway: CLS.MOTORWAY,
  motorway_link: CLS.MOTORWAY_LINK,
  trunk: CLS.TRUNK,
  trunk_link: CLS.TRUNK_LINK,
  primary: CLS.PRIMARY,
  primary_link: CLS.PRIMARY_LINK,
  secondary: CLS.SECONDARY,
  secondary_link: CLS.SECONDARY_LINK,
  tertiary: CLS.TERTIARY,
  tertiary_link: CLS.TERTIARY_LINK,
  unclassified: CLS.UNCLASSIFIED,
  road: CLS.UNCLASSIFIED,
  residential: CLS.RESIDENTIAL,
  living_street: CLS.LIVING_STREET,
  service: CLS.SERVICE,
  track: CLS.TRACK,
};

/** Something mapped as a tagged node on a road: stop line, crossing, signal … */
export interface EdgeFeature {
  kind: 'signal' | 'give_way' | 'stop' | 'crossing' | 'level_crossing' | 'bump' | 'barrier' | 'bus_stop' | 'sign';
  /** station along the edge from node a */
  s: number;
  /** +1 applies to traffic a→b, -1 to b→a, 0 both/unknown */
  dir: number;
  tags: Tags;
  osm: number;
}

export interface RoadGraph {
  nodes: NodeJson[];
  edges: EdgeJson[];
  /** per node: OSM node (null for synthetic map-edge nodes) */
  nodeOsm: Array<ONode | null>;
  /** per node: true when the road was cut at the edge of the terrain coverage */
  nodeMapEnd: boolean[];
  /** per edge: source way */
  edgeWay: OWay[];
  /** per edge: OSM node ids along it (in a→b order) */
  edgeRefs: number[][];
  edgeFeatures: EdgeFeature[][];
  /** OSM node id → node index */
  nodeIndex: Map<number, number>;
  /** OSM way id → edge indices in way order */
  wayEdges: Map<number, number[]>;
  /** per edge: built the new way (cross-sections, calming …) – false where MapArea.fresh said no (mapgen/detailregion.ts) */
  edgeNew: boolean[];
}

function num(v: string | undefined): number {
  if (v === undefined) return NaN;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)/.exec(v);
  return m ? Number(m[1].replace(',', '.')) : NaN;
}

function parseMaxspeed(v: string | undefined): number {
  if (v === undefined) return NaN;
  if (v === 'none') return 0;
  if (v === 'walk' || v === 'DE:living_street') return 7;
  if (v === 'DE:urban') return 50;
  if (v === 'DE:rural') return 100;
  if (v === 'DE:motorway') return 0;
  if (/zone:?30/.test(v)) return 30;
  return num(v);
}

interface Attrs {
  cls: number;
  oneway: boolean;
  reversed: boolean;
  lf: number;
  lb: number;
  lw: number;
  w: number;
  mg: number;
  mf: number;
  mb: number;
  zone: number;
  surf: number;
  swL: number;
  swR: number;
  flags: number;
  access: number;
  layer: number;
  tf: string;
  tb: string;
  urban: boolean;
  /** the cross-section beyond the lanes, left and right along the stored direction (src/world/xsection.ts) */
  xl: RoadSideJson;
  xr: RoadSideJson;
  /** median:contents (MEDIAN bits) */
  md: number;
  /** may a separate pavement beside it be taken as its own (tagged separate, or not tagged at all)? */
  walkFromL: boolean;
  walkFromR: boolean;
  vergeTaggedL: boolean;
  vergeTaggedR: boolean;
}

/** Derive all per-road attributes from OSM tags. `urbanHint` comes from the built-up mask. */
export function roadAttrs(tags: Tags, urbanHint: boolean): Attrs | null {
  const hw = tags.highway;
  const cls = DRIVE_CLASS[hw];
  if (cls === undefined) return null;
  if (tags.area === 'yes') return null;
  if (cls === CLS.TRACK && (tags.tracktype === 'grade4' || tags.tracktype === 'grade5')) return null;
  if (cls === CLS.SERVICE && (tags.indoor === 'yes' || tags.location === 'underground' || num(tags.layer) < -1)) return null;
  if (tags.parking === 'underground' || tags.parking === 'multi-storey') return null;

  const tier = CLASS_TIER[cls];
  const isLink = hw.endsWith('_link');
  const roundabout = tags.junction === 'roundabout' || tags.junction === 'circular';
  let reversed = false;
  let oneway = false;
  const ow = tags.oneway;
  if (ow === 'yes' || ow === 'true' || ow === '1') oneway = true;
  else if (ow === '-1' || ow === 'reverse') {
    oneway = true;
    reversed = true;
  } else if (ow !== 'no' && (cls === CLS.MOTORWAY || roundabout || (isLink && cls === CLS.MOTORWAY_LINK))) oneway = true;

  // --- built-up area / speed regime ---
  const src = `${tags['source:maxspeed'] ?? ''}|${tags['maxspeed:type'] ?? ''}|${tags['zone:maxspeed'] ?? ''}|${tags['zone:traffic'] ?? ''}|${tags.maxspeed ?? ''}`;
  let zone = 0;
  if (cls === CLS.LIVING_STREET || /living_street/.test(src)) zone = 7;
  else if (/zone:?30|DE:30\b/.test(src)) zone = 30;
  else if (/zone:?20|DE:20\b/.test(src)) zone = 20;
  let urban: boolean;
  if (/DE:urban/.test(src) || zone > 0) urban = true;
  else if (/DE:rural|DE:motorway/.test(src) || cls <= CLS.TRUNK_LINK) urban = false;
  else if (cls === CLS.RESIDENTIAL || cls === CLS.LIVING_STREET) urban = true;
  else urban = urbanHint;

  let ms = parseMaxspeed(tags.maxspeed);
  if (Number.isNaN(ms)) {
    if (zone === 7) ms = 7;
    else if (zone > 0) ms = zone;
    else if (cls === CLS.MOTORWAY || cls === CLS.MOTORWAY_LINK) ms = cls === CLS.MOTORWAY ? 0 : 80;
    else if (cls === CLS.TRACK) ms = 30;
    else if (cls === CLS.SERVICE) ms = 30;
    else ms = urban ? 50 : 100;
  } else if (ms >= 60 && !/DE:urban/.test(src) && zone === 0 && cls !== CLS.RESIDENTIAL) {
    // an explicit 60+ limit is strong evidence for "outside built-up area"
    if (!urbanHint) urban = false;
  }
  let mf = parseMaxspeed(tags['maxspeed:forward']);
  let mb = parseMaxspeed(tags['maxspeed:backward']);
  if (Number.isNaN(mf)) mf = ms;
  if (Number.isNaN(mb)) mb = ms;

  // --- lanes ---
  const lanesTag = num(tags.lanes);
  let lf = num(tags['lanes:forward']);
  let lb = num(tags['lanes:backward']);
  let singleTrack = false;
  if (oneway) {
    lf = Number.isNaN(lanesTag) ? (cls === CLS.MOTORWAY ? 2 : 1) : Math.max(1, Math.round(lanesTag));
    lb = 0;
  } else if (!Number.isNaN(lf) && !Number.isNaN(lb)) {
    lf = Math.max(1, Math.round(lf));
    lb = Math.max(1, Math.round(lb));
  } else if (!Number.isNaN(lanesTag)) {
    const l = Math.max(1, Math.round(lanesTag));
    if (l === 1) {
      singleTrack = true;
      lf = 1;
      lb = 1;
    } else {
      lf = Number.isNaN(lf) ? Math.ceil(l / 2) : lf;
      lb = l - lf;
      if (lb < 1) {
        lb = 1;
        lf = Math.max(1, l - 1);
      }
    }
  } else {
    lf = 1;
    lb = 1;
    if (cls === CLS.SERVICE || cls === CLS.TRACK) singleTrack = true;
  }

  // --- what lies beside the lanes: parking, cycle lanes, verges, kerbs (tools/mapgen/xsection.ts) ---
  const xs = taggedSides(tags, oneway, reversed);
  const xl = xs.left.side;
  const xr = xs.right.side;
  const extras = sideInner(xl) + sideInner(xr);

  // --- width ---
  let lw = CLASS_LANE_WIDTH[cls];
  let w: number;
  let mg = 0;
  const widthTag = num(tags.width);
  if (singleTrack) {
    const def =
      cls === CLS.TRACK
        ? 3.0
        : cls === CLS.SERVICE
          ? tags.service === 'parking_aisle'
            ? 5.6
            : tags.service === 'driveway'
              ? 3.2
              : 4.0
          : cls === CLS.LIVING_STREET
            ? 4.6
            : 4.2;
    // (a width that holds the parking and cycle lanes, or one of the lanes alone)
    const drive = widthTag - extras;
    w = !Number.isNaN(widthTag) && drive >= 2.2 && drive <= 9 ? drive : !Number.isNaN(widthTag) && widthTag >= 2.2 && widthTag <= 9 ? widthTag : def;
    lw = w / 2;
  } else {
    const n = lf + lb;
    if (extras > 0 && !Number.isNaN(widthTag) && (widthTag - extras) / n >= 2.3 && (widthTag - extras) / n <= 4.6) {
      w = widthTag - extras;
      lw = w / n;
    } else if (!Number.isNaN(widthTag) && widthTag / n >= 2.3 && widthTag / n <= 4.6) {
      w = widthTag;
      lw = w / n;
    } else if (!Number.isNaN(widthTag) && (widthTag - extras) / n > 4.6 && (widthTag - extras) / n <= 9 && cls > CLS.TRUNK_LINK) {
      // (far wider than its lanes – two carriageways merged into one, a wide avenue: the lanes at their
      // usual width, the asphalt beyond them on both sides)
      lw = Math.min(3.5, Math.max(lw, 3.25));
      mg = (widthTag - extras - n * lw) / 2;
      w = widthTag - extras;
    } else {
      w = n * lw;
    }
    if (cls === CLS.MOTORWAY || cls === CLS.MOTORWAY_LINK || cls === CLS.TRUNK || cls === CLS.TRUNK_LINK) {
      // hard strips outside the edge lines
      mg = cls === CLS.MOTORWAY ? 1.5 : 0.75;
      w = n * lw + 2 * mg;
    } else if (oneway && n === 1) {
      // single-lane one-way streets are wider than one bare lane
      w = Math.max(w, roundabout ? 5.5 : 3.6);
      lw = w;
    }
  }
  // the carriageway from kerb to kerb: the lanes, and the parking and cycle lanes beside them
  w += extras;

  // --- surface ---
  let surf: number = SURF.ASPHALT;
  const s = tags.surface;
  if (s) {
    if (/^concrete/.test(s)) surf = SURF.CONCRETE;
    else if (/paving_stones|paved$|bricks?/.test(s) && s !== 'paved') surf = SURF.PAVING;
    else if (/sett|cobblestone/.test(s)) surf = SURF.SETT;
    else if (/gravel|compacted|pebblestone/.test(s)) surf = SURF.GRAVEL;
    else if (/unpaved|dirt|ground|earth|mud|sand/.test(s)) surf = SURF.DIRT;
    else if (/grass/.test(s)) surf = SURF.GRASS;
  } else if (cls === CLS.TRACK) {
    surf = tags.tracktype === 'grade1' ? SURF.ASPHALT : tags.tracktype === 'grade3' ? SURF.DIRT : SURF.GRAVEL;
  } else if (cls === CLS.LIVING_STREET) {
    surf = SURF.PAVING;
  }

  // --- sidewalks ---
  const dual = oneway && !isLink && !roundabout && tier >= 3;
  // (left and right along the stored direction: the tags' sides are swapped for a way stored against its drawing)
  const side = (key: 'left' | 'right'): number => {
    const tagged = key === 'left' ? xs.left : xs.right;
    let has = tagged.walk.has;
    const outer = sideOuter(tagged.side);
    if (has === null) {
      // default: built-up public streets have a pavement on both sides
      const eligible =
        urban &&
        (cls === CLS.RESIDENTIAL ||
          cls === CLS.UNCLASSIFIED ||
          cls === CLS.TERTIARY ||
          cls === CLS.SECONDARY ||
          cls === CLS.PRIMARY);
      has = eligible && !((dual || roundabout) && key === 'left');
    }
    // (cars on the pavement need one, whatever else is said)
    if (!has) return outer > 0 ? outer + (tagged.side.p ? 1.0 : 0) : 0;
    const walk = Number.isNaN(tagged.walk.width) ? (tier >= 3 ? 2.2 : 1.8) : tagged.walk.width;
    return outer + walk;
  };
  let swL = side('left');
  let swR = side('right');
  if (tags.bridge && tags.bridge !== 'no' && cls <= CLS.TRUNK_LINK) {
    swL = 0;
    swR = 0;
  }

  // --- flags ---
  let flags = 0;
  if (tags.bridge && tags.bridge !== 'no') flags |= EF.BRIDGE;
  if (tags.tunnel === 'yes' || tags.tunnel === 'culvert' || tags.covered === 'yes') flags |= EF.TUNNEL;
  if (roundabout) flags |= EF.ROUNDABOUT;
  if (isLink) flags |= EF.LINK;
  if (urban) flags |= EF.URBAN;
  if (dual) flags |= EF.DUAL;
  if (tags.bicycle_road === 'yes') flags |= EF.BICYCLE_ROAD;
  if (cls === CLS.SERVICE && (tags.service === 'parking_aisle' || tags.service === 'driveway' || tags.service === 'alley' || tags.service === 'drive-through')) {
    flags |= EF.MINOR_SERVICE;
  }
  if (tags.lit === 'yes' || (tags.lit === undefined && urban && tier >= 2)) flags |= EF.LIT;
  // (an approach tagged with more lanes in one direction than one, or with turn lanes, has its lane lines
  // painted, whatever its class – a street of a 30 zone aside)
  const turnTagged = /\|/.test(`${tags['turn:lanes'] ?? ''}${tags['turn:lanes:forward'] ?? ''}${tags['turn:lanes:backward'] ?? ''}`);
  const multiLane = !singleTrack && zone === 0 && (Math.max(lf, lb) >= 2 || turnTagged);
  const marked =
    tags.lane_markings === 'yes' ||
    (tags.lane_markings !== 'no' &&
      !singleTrack &&
      zone === 0 &&
      (tier >= 3 || isLink || multiLane || (lf + lb >= 2 && !Number.isNaN(lanesTag) && cls === CLS.UNCLASSIFIED && !urban)));
  if (marked) flags |= EF.MARKED;
  // (edge lines by class: on marked roads outside towns – not where the limit is 50 or less: there the
  // carriageway ends at kerbs or verges without a line; lane_markings:edge says otherwise per side)
  if ((marked && !urban && tier >= 3 && !(ms > 0 && ms <= 50)) || cls <= CLS.TRUNK_LINK) flags |= EF.EDGE_LINES;
  if (tags.overtaking === 'no' || tags['overtaking:forward'] === 'no') flags |= EF.SOLID_CENTER;

  // --- access ---
  const av = tags.motor_vehicle ?? tags.motorcar ?? tags.vehicle ?? tags.access;
  let access: number = ACCESS.YES;
  if (av === 'destination') access = ACCESS.DESTINATION;
  else if (av === 'agricultural' || av === 'forestry' || av === 'agricultural;forestry') access = ACCESS.AGRICULTURAL;
  else if (av === 'no' || av === 'private' || av === 'delivery' || av === 'military' || av === 'emergency' || av === 'bus') {
    access = ACCESS.PRIVATE;
  } else if (av === undefined && cls === CLS.TRACK) access = ACCESS.AGRICULTURAL;
  if (hw === 'busway' || tags.service === 'emergency_access') access = ACCESS.PRIVATE;

  const layerNum = num(tags.layer);
  const layer = Number.isNaN(layerNum) ? (flags & EF.BRIDGE ? 1 : flags & EF.TUNNEL ? -1 : 0) : layerNum;

  const tf = tags['turn:lanes:forward'] ?? (oneway ? tags['turn:lanes'] : undefined) ?? '';
  const tb = tags['turn:lanes:backward'] ?? '';

  // (a bridge too: its footway bridges beside it become its raised walkways – separateWalks)
  const walkFrom = (t: (typeof xs)['left']): boolean => cls > CLS.TRUNK_LINK && !(flags & EF.TUNNEL) && (t.walk.separate || t.walk.has === null);
  return {
    cls, oneway, reversed, lf, lb, lw, w, mg, mf, mb, zone, surf, swL, swR, flags, access, layer, tf, tb, urban,
    xl, xr, md: oneway ? xs.median : 0,
    walkFromL: walkFrom(xs.left), walkFromR: walkFrom(xs.right),
    vergeTaggedL: xs.left.vergeTagged, vergeTaggedR: xs.right.vergeTagged,
  };
}

/**
 * roadAttrs as the published map was built with it (before the cross-sections of
 * mapgen/xsection.ts): for the roads outside the detail region (mapgen/detailregion.ts),
 * which must come out as they are in that map.  Kept as it was, line by line.
 */
export function roadAttrsLegacy(tags: Tags, urbanHint: boolean): Attrs | null {
  const hw = tags.highway;
  const cls = DRIVE_CLASS[hw];
  if (cls === undefined) return null;
  if (tags.area === 'yes') return null;
  if (cls === CLS.TRACK && (tags.tracktype === 'grade4' || tags.tracktype === 'grade5')) return null;
  if (cls === CLS.SERVICE && (tags.indoor === 'yes' || tags.location === 'underground' || num(tags.layer) < -1)) return null;
  if (tags.parking === 'underground' || tags.parking === 'multi-storey') return null;

  const tier = CLASS_TIER[cls];
  const isLink = hw.endsWith('_link');
  const roundabout = tags.junction === 'roundabout' || tags.junction === 'circular';
  let reversed = false;
  let oneway = false;
  const ow = tags.oneway;
  if (ow === 'yes' || ow === 'true' || ow === '1') oneway = true;
  else if (ow === '-1' || ow === 'reverse') {
    oneway = true;
    reversed = true;
  } else if (ow !== 'no' && (cls === CLS.MOTORWAY || roundabout || (isLink && cls === CLS.MOTORWAY_LINK))) oneway = true;

  // --- built-up area / speed regime ---
  const src = `${tags['source:maxspeed'] ?? ''}|${tags['maxspeed:type'] ?? ''}|${tags['zone:maxspeed'] ?? ''}|${tags['zone:traffic'] ?? ''}|${tags.maxspeed ?? ''}`;
  let zone = 0;
  if (cls === CLS.LIVING_STREET || /living_street/.test(src)) zone = 7;
  else if (/zone:?30|DE:30\b/.test(src)) zone = 30;
  else if (/zone:?20|DE:20\b/.test(src)) zone = 20;
  let urban: boolean;
  if (/DE:urban/.test(src) || zone > 0) urban = true;
  else if (/DE:rural|DE:motorway/.test(src) || cls <= CLS.TRUNK_LINK) urban = false;
  else if (cls === CLS.RESIDENTIAL || cls === CLS.LIVING_STREET) urban = true;
  else urban = urbanHint;

  let ms = parseMaxspeed(tags.maxspeed);
  if (Number.isNaN(ms)) {
    if (zone === 7) ms = 7;
    else if (zone > 0) ms = zone;
    else if (cls === CLS.MOTORWAY || cls === CLS.MOTORWAY_LINK) ms = cls === CLS.MOTORWAY ? 0 : 80;
    else if (cls === CLS.TRACK) ms = 30;
    else if (cls === CLS.SERVICE) ms = 30;
    else ms = urban ? 50 : 100;
  } else if (ms >= 60 && !/DE:urban/.test(src) && zone === 0 && cls !== CLS.RESIDENTIAL) {
    // an explicit 60+ limit is strong evidence for "outside built-up area"
    if (!urbanHint) urban = false;
  }
  let mf = parseMaxspeed(tags['maxspeed:forward']);
  let mb = parseMaxspeed(tags['maxspeed:backward']);
  if (Number.isNaN(mf)) mf = ms;
  if (Number.isNaN(mb)) mb = ms;

  // --- lanes ---
  const lanesTag = num(tags.lanes);
  let lf = num(tags['lanes:forward']);
  let lb = num(tags['lanes:backward']);
  let singleTrack = false;
  if (oneway) {
    lf = Number.isNaN(lanesTag) ? (cls === CLS.MOTORWAY ? 2 : 1) : Math.max(1, Math.round(lanesTag));
    lb = 0;
  } else if (!Number.isNaN(lf) && !Number.isNaN(lb)) {
    lf = Math.max(1, Math.round(lf));
    lb = Math.max(1, Math.round(lb));
  } else if (!Number.isNaN(lanesTag)) {
    const l = Math.max(1, Math.round(lanesTag));
    if (l === 1) {
      singleTrack = true;
      lf = 1;
      lb = 1;
    } else {
      lf = Number.isNaN(lf) ? Math.ceil(l / 2) : lf;
      lb = l - lf;
      if (lb < 1) {
        lb = 1;
        lf = Math.max(1, l - 1);
      }
    }
  } else {
    lf = 1;
    lb = 1;
    if (cls === CLS.SERVICE || cls === CLS.TRACK) singleTrack = true;
  }

  // --- width ---
  let lw = CLASS_LANE_WIDTH[cls];
  let w: number;
  let mg = 0;
  const widthTag = num(tags.width);
  if (singleTrack) {
    const def =
      cls === CLS.TRACK
        ? 3.0
        : cls === CLS.SERVICE
          ? tags.service === 'parking_aisle'
            ? 5.6
            : tags.service === 'driveway'
              ? 3.2
              : 4.0
          : cls === CLS.LIVING_STREET
            ? 4.6
            : 4.2;
    w = !Number.isNaN(widthTag) && widthTag >= 2.2 && widthTag <= 9 ? widthTag : def;
    lw = w / 2;
  } else {
    const n = lf + lb;
    if (!Number.isNaN(widthTag) && widthTag / n >= 2.3 && widthTag / n <= 4.6) {
      w = widthTag;
      lw = w / n;
    } else {
      w = n * lw;
    }
    if (cls === CLS.MOTORWAY || cls === CLS.MOTORWAY_LINK || cls === CLS.TRUNK || cls === CLS.TRUNK_LINK) {
      // hard strips outside the edge lines
      mg = cls === CLS.MOTORWAY ? 1.5 : 0.75;
      w = n * lw + 2 * mg;
    } else if (oneway && n === 1) {
      // single-lane one-way streets are wider than one bare lane
      w = Math.max(w, roundabout ? 5.5 : 3.6);
      lw = w;
    }
  }

  // --- surface ---
  let surf: number = SURF.ASPHALT;
  const s = tags.surface;
  if (s) {
    if (/^concrete/.test(s)) surf = SURF.CONCRETE;
    else if (/paving_stones|paved$|bricks?/.test(s) && s !== 'paved') surf = SURF.PAVING;
    else if (/sett|cobblestone/.test(s)) surf = SURF.SETT;
    else if (/gravel|compacted|pebblestone/.test(s)) surf = SURF.GRAVEL;
    else if (/unpaved|dirt|ground|earth|mud|sand/.test(s)) surf = SURF.DIRT;
    else if (/grass/.test(s)) surf = SURF.GRASS;
  } else if (cls === CLS.TRACK) {
    surf = tags.tracktype === 'grade1' ? SURF.ASPHALT : tags.tracktype === 'grade3' ? SURF.DIRT : SURF.GRAVEL;
  } else if (cls === CLS.LIVING_STREET) {
    surf = SURF.PAVING;
  }

  // --- sidewalks ---
  const dual = oneway && !isLink && !roundabout && tier >= 3;
  const side = (key: 'left' | 'right'): number => {
    const explicit = tags[`sidewalk:${key}`] ?? tags['sidewalk:both'];
    const general = tags.sidewalk;
    let has: boolean | null = null;
    if (explicit !== undefined) has = explicit === 'yes';
    else if (general !== undefined) {
      if (general === 'both' || general === 'yes') has = true;
      else if (general === 'left' || general === 'right') has = general === key;
      else has = false; // no / none / separate
    }
    if (has === null) {
      // default: built-up public streets have a pavement on both sides
      const eligible =
        urban &&
        (cls === CLS.RESIDENTIAL ||
          cls === CLS.UNCLASSIFIED ||
          cls === CLS.TERTIARY ||
          cls === CLS.SECONDARY ||
          cls === CLS.PRIMARY);
      has = eligible && !((dual || roundabout) && key === 'left');
    }
    if (!has) return 0;
    return tier >= 3 ? 2.2 : 1.8;
  };
  let swL = side('left');
  let swR = side('right');
  if (tags.bridge && tags.bridge !== 'no' && cls <= CLS.TRUNK_LINK) {
    swL = 0;
    swR = 0;
  }

  // --- flags ---
  let flags = 0;
  if (tags.bridge && tags.bridge !== 'no') flags |= EF.BRIDGE;
  if (tags.tunnel === 'yes' || tags.tunnel === 'culvert' || tags.covered === 'yes') flags |= EF.TUNNEL;
  if (roundabout) flags |= EF.ROUNDABOUT;
  if (isLink) flags |= EF.LINK;
  if (urban) flags |= EF.URBAN;
  if (dual) flags |= EF.DUAL;
  if (tags.bicycle_road === 'yes') flags |= EF.BICYCLE_ROAD;
  if (cls === CLS.SERVICE && (tags.service === 'parking_aisle' || tags.service === 'driveway' || tags.service === 'alley' || tags.service === 'drive-through')) {
    flags |= EF.MINOR_SERVICE;
  }
  if (tags.lit === 'yes' || (tags.lit === undefined && urban && tier >= 2)) flags |= EF.LIT;
  const marked =
    tags.lane_markings === 'yes' ||
    (tags.lane_markings !== 'no' &&
      !singleTrack &&
      zone === 0 &&
      (tier >= 3 || isLink || (lf + lb >= 2 && !Number.isNaN(lanesTag) && cls === CLS.UNCLASSIFIED && !urban)));
  if (marked) flags |= EF.MARKED;
  if ((marked && !urban && tier >= 3) || cls <= CLS.TRUNK_LINK) flags |= EF.EDGE_LINES;
  if (tags.overtaking === 'no' || tags['overtaking:forward'] === 'no') flags |= EF.SOLID_CENTER;

  // --- access ---
  const av = tags.motor_vehicle ?? tags.motorcar ?? tags.vehicle ?? tags.access;
  let access: number = ACCESS.YES;
  if (av === 'destination') access = ACCESS.DESTINATION;
  else if (av === 'agricultural' || av === 'forestry' || av === 'agricultural;forestry') access = ACCESS.AGRICULTURAL;
  else if (av === 'no' || av === 'private' || av === 'delivery' || av === 'military' || av === 'emergency' || av === 'bus') {
    access = ACCESS.PRIVATE;
  } else if (av === undefined && cls === CLS.TRACK) access = ACCESS.AGRICULTURAL;
  if (hw === 'busway' || tags.service === 'emergency_access') access = ACCESS.PRIVATE;

  const layerNum = num(tags.layer);
  const layer = Number.isNaN(layerNum) ? (flags & EF.BRIDGE ? 1 : flags & EF.TUNNEL ? -1 : 0) : layerNum;

  const tf = tags['turn:lanes:forward'] ?? (oneway ? tags['turn:lanes'] : undefined) ?? '';
  const tb = tags['turn:lanes:backward'] ?? '';

  return { cls, oneway, reversed, lf, lb, lw, w, mg, mf, mb, zone, surf, swL, swR, flags, access, layer, tf, tb, urban, xl: {}, xr: {}, md: 0, walkFromL: false, walkFromR: false, vergeTaggedL: false, vergeTaggedR: false };
}


/** Counter-clockwise angle of an edge as seen from one of its end nodes (probe 8 m along, matching world.ts). */
export function armAngle(e: EdgeJson, fromA: boolean): number {
  // direction from the node towards the point 8 m along the edge (matches world.ts)
  const n = e.p.length / 3;
  const nx = fromA ? e.p[0] : e.p[(n - 1) * 3];
  const nz = fromA ? e.p[2] : e.p[(n - 1) * 3 + 2];
  let acc = 0;
  let px = nx;
  let pz = nz;
  for (let k = 1; k < n; k++) {
    const i = fromA ? k : n - 1 - k;
    const qx = e.p[i * 3];
    const qz = e.p[i * 3 + 2];
    const l = Math.hypot(qx - px, qz - pz);
    if (acc + l >= 8) {
      const t = (8 - acc) / l;
      px += (qx - px) * t;
      pz += (qz - pz) * t;
      acc = 8;
      break;
    }
    acc += l;
    px = qx;
    pz = qz;
  }
  return angleOf(px - nx, pz - nz);
}

type P2 = [number, number];

/** Round sharp polyline corners and limit segment length. */
function refineCenterline(pts: P2[], radius: number, maxSeg: number): P2[] {
  const src: P2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const q = src[src.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) src.push(p);
  }
  if (src.length < 2) return src;
  const out: P2[] = [src[0]];
  for (let i = 1; i < src.length - 1; i++) {
    const p0 = src[i - 1];
    const p1 = src[i];
    const p2 = src[i + 1];
    let ux = p1[0] - p0[0];
    let uz = p1[1] - p0[1];
    let vx = p2[0] - p1[0];
    let vz = p2[1] - p1[1];
    const l1 = Math.hypot(ux, uz);
    const l2 = Math.hypot(vx, vz);
    ux /= l1;
    uz /= l1;
    vx /= l2;
    vz /= l2;
    const ang = Math.acos(clamp(ux * vx + uz * vz, -1, 1));
    const d = Math.min(radius * Math.tan(Math.min(ang, 2.6) / 2), l1 * 0.45, l2 * 0.45);
    if (ang < 0.07 || d < 0.3) {
      out.push(p1);
      continue;
    }
    const ax = p1[0] - ux * d;
    const az = p1[1] - uz * d;
    const bx = p1[0] + vx * d;
    const bz = p1[1] + vz * d;
    const steps = Math.max(2, Math.ceil(ang / 0.13));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const w0 = (1 - t) * (1 - t);
      const w1 = 2 * t * (1 - t);
      const w2 = t * t;
      out.push([w0 * ax + w1 * p1[0] + w2 * bx, w0 * az + w1 * p1[1] + w2 * bz]);
    }
  }
  out.push(src[src.length - 1]);
  // densify
  const dense: P2[] = [out[0]];
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1];
    const b = out[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(l / maxSeg));
    for (let k = 1; k <= n; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return dense;
}

function polyLength(pts: P2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

/** Station of the point on `pts` closest to (x,z). */
function stationOf(pts: P2[], x: number, z: number): number {
  let best = Infinity;
  let bestS = 0;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    const l = Math.sqrt(l2);
    const t = l2 > 0 ? clamp(((x - a[0]) * dx + (z - a[1]) * dz) / l2, 0, 1) : 0;
    const d = Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
    if (d < best) {
      best = d;
      bestS = acc + l * t;
    }
    acc += l;
  }
  return bestS;
}

function featureOf(n: ONode, wayDir: number): EdgeFeature | null {
  const t = n.tags;
  if (!t) return null;
  const dirTag = t.direction ?? t['traffic_signals:direction'] ?? t['traffic_sign:direction'];
  let dir = dirTag === 'forward' ? 1 : dirTag === 'backward' ? -1 : 0;
  dir *= wayDir;
  let kind: EdgeFeature['kind'] | null = null;
  if (t.highway === 'traffic_signals') kind = 'signal';
  else if (t.highway === 'give_way') kind = 'give_way';
  else if (t.highway === 'stop') kind = 'stop';
  else if (t.highway === 'crossing' || t.railway === 'crossing') kind = t.highway === 'crossing' ? 'crossing' : null;
  else if (t.railway === 'level_crossing' || t.railway === 'tram_level_crossing' || t.railway === 'tram_crossing') kind = 'level_crossing';
  else if (t.traffic_calming) kind = 'bump';
  else if (t.barrier && t.barrier !== 'kerb' && t.barrier !== 'entrance') kind = 'barrier';
  else if (t.highway === 'bus_stop') kind = 'bus_stop';
  else if (t.traffic_sign) kind = 'sign';
  if (!kind) return null;
  return { kind, s: 0, dir, tags: t, osm: n.id };
}

/** Where the map is: there is terrain (`inWorld`), and where it is built up (a hint for roads that do not say). */
export interface MapArea {
  inWorld(x: number, z: number): boolean;
  builtUp(x: number, z: number): boolean;
  /**
   * Is the road along these points (flat x, z: the nodes of an edge) built the
   * way the map build does it now – cross-sections, separate pavements,
   * calming and markings – or as the published map was (roadAttrsLegacy,
   * nothing of mapgen/roadextras.ts)?  Without: every road the new way.  (The
   * detail region: mapgen/detailregion.ts.)
   */
  fresh?(pts: number[]): boolean;
}

export function buildRoadGraph(osm: OsmData, area: MapArea): RoadGraph {
  const inWorld = (x: number, z: number): boolean => area.inWorld(x, z);

  // ---- 1. select ways, clip them to the terrain coverage --------------------
  interface Run {
    way: OWay;
    attrs: Attrs;
    /** with MapArea.fresh: the attributes the new way, for the edges it says yes to (attrs: as the published map) */
    fresh: Attrs | null;
    /** node ids; synthetic boundary nodes are negative */
    ids: number[];
  }
  const synth = new Map<number, { x: number; z: number }>();
  let synthId = -1;
  // (synthetic nodes are negative; so are the nodes added by tools/mapgen/observed-roads.json, which are in osm.nodes)
  const pos = (id: number): { x: number; z: number } => synth.get(id) ?? osm.nodes.get(id)!;
  const runs: Run[] = [];

  for (const way of osm.ways) {
    const hw = way.tags.highway;
    if (!hw || DRIVE_CLASS[hw] === undefined) continue;
    const ids0 = way.refs.filter((r) => osm.nodes.has(r));
    if (ids0.length < 2) continue;
    // built-up hint: majority vote along the way
    let builtVotes = 0;
    for (const id of ids0) {
      const n = osm.nodes.get(id)!;
      if (area.builtUp(n.x, n.z)) builtVotes++;
    }
    // (with a detail region: the runs as the published map has them, the edges in it the new way – addEdge)
    const urbanHint = builtVotes * 2 > ids0.length;
    const attrs = area.fresh ? roadAttrsLegacy(way.tags, urbanHint) : roadAttrs(way.tags, urbanHint);
    if (!attrs) continue;
    const fresh = area.fresh ? roadAttrs(way.tags, urbanHint) : null;
    const ids = attrs.reversed ? ids0.slice().reverse() : ids0;

    let cur: number[] = [];
    const flush = (): void => {
      if (cur.length >= 2) runs.push({ way, attrs, fresh, ids: cur });
      cur = [];
    };
    for (let i = 0; i < ids.length; i++) {
      const n = osm.nodes.get(ids[i])!;
      const inside = inWorld(n.x, n.z);
      if (i > 0) {
        const p = osm.nodes.get(ids[i - 1])!;
        const prevInside = inWorld(p.x, p.z);
        if (prevInside !== inside) {
          // bisect for the coverage boundary
          let ax = prevInside ? p.x : n.x;
          let az = prevInside ? p.z : n.z;
          let bx = prevInside ? n.x : p.x;
          let bz = prevInside ? n.z : p.z;
          for (let k = 0; k < 14; k++) {
            const mx = (ax + bx) / 2;
            const mz = (az + bz) / 2;
            if (inWorld(mx, mz)) {
              ax = mx;
              az = mz;
            } else {
              bx = mx;
              bz = mz;
            }
          }
          const sid = synthId--;
          synth.set(sid, { x: ax, z: az });
          if (prevInside) {
            cur.push(sid);
            flush();
          } else {
            cur = [sid];
          }
        }
      }
      if (inside) cur.push(ids[i]);
    }
    flush();
  }

  // ---- 2. graph nodes: shared nodes, way ends, loops -----------------------
  const use = new Map<number, number>();
  for (const r of runs) {
    for (let i = 0; i < r.ids.length; i++) {
      const id = r.ids[i];
      const endpoint = i === 0 || i === r.ids.length - 1;
      use.set(id, (use.get(id) ?? 0) + (endpoint ? 2 : 1));
    }
  }
  const isGraphNode = (id: number): boolean => (use.get(id) ?? 0) >= 2;

  const graph: RoadGraph = {
    nodes: [],
    edges: [],
    nodeOsm: [],
    nodeMapEnd: [],
    edgeWay: [],
    edgeRefs: [],
    edgeFeatures: [],
    nodeIndex: new Map(),
    wayEdges: new Map(),
    edgeNew: [],
  };
  const nodeOf = (id: number): number => {
    let idx = graph.nodeIndex.get(id);
    if (idx === undefined) {
      idx = graph.nodes.length;
      const p = pos(id);
      graph.nodes.push({ x: p.x, y: 0, z: p.z, t: CTRL.NONE, arms: [] });
      graph.nodeOsm.push(synth.has(id) ? null : osm.nodes.get(id)!);
      graph.nodeMapEnd.push(synth.has(id));
      graph.nodeIndex.set(id, idx);
    }
    return idx;
  };

  const edgeAttrs: Attrs[] = [];
  const addEdge = (r: Run, ids: number[]): void => {
    if (ids.length < 2) return;
    if (ids[0] === ids[ids.length - 1]) {
      // closed loop: split in the middle so no edge starts and ends at the same node
      if (ids.length < 4) return;
      const mid = Math.floor(ids.length / 2);
      use.set(ids[mid], 2);
      addEdge(r, ids.slice(0, mid + 1));
      addEdge(r, ids.slice(mid));
      return;
    }
    const raw: P2[] = ids.map((id) => {
      const p = pos(id);
      return [p.x, p.z];
    });
    // (the new way – or, outside the detail region, as the published map was: MapArea.fresh)
    const isNew = !area.fresh || (r.fresh !== null && area.fresh(raw.flat()));
    const a = isNew && r.fresh ? r.fresh : r.attrs;
    const tier = CLASS_TIER[a.cls];
    const refined = refineCenterline(raw, tier >= 3 ? 22 : tier >= 2 ? 9 : 5, 8);
    const len = polyLength(refined);
    if (len < 0.4) return;
    const p: number[] = [];
    for (const q of refined) p.push(Math.round(q[0] * 100) / 100, 0, Math.round(q[1] * 100) / 100);
    const edge: EdgeJson = {
      a: nodeOf(ids[0]),
      b: nodeOf(ids[ids.length - 1]),
      c: a.cls,
      p,
      lf: a.lf,
      lb: a.lb,
      lw: Math.round(a.lw * 100) / 100,
      w: Math.round(a.w * 100) / 100,
      mf: a.mf,
      mb: a.mb,
      f: a.flags,
      ca: 0,
      cb: 0,
      // (a part of a way cut by tools/mapgen/observed-roads.json is named after the way it was cut from)
      o: r.way.of ?? r.way.id,
    };
    if (r.way.tags.name) edge.n = r.way.tags.name;
    if (r.way.tags.ref) edge.r = r.way.tags.ref;
    if (a.zone) edge.z = a.zone;
    if (a.mg) edge.mg = a.mg;
    if (a.surf) edge.s = a.surf;
    if (a.swL) edge.sl = a.swL;
    if (a.swR) edge.sr = a.swR;
    if (a.access) edge.ac = a.access;
    if (a.layer) edge.ly = a.layer;
    if (a.tf) edge.tf = a.tf;
    if (a.tb) edge.tb = a.tb;
    if (!sideIsPlain(a.xl)) edge.xl = { ...a.xl };
    if (!sideIsPlain(a.xr)) edge.xr = { ...a.xr };
    if (a.md) edge.md = a.md;

    const feats: EdgeFeature[] = [];
    for (let i = 1; i < ids.length - 1; i++) {
      // (the cut at the edge of the map has nothing on it; the nodes of observed-roads.json may: waysplit.ts points)
      if (synth.has(ids[i])) continue;
      const n = osm.nodes.get(ids[i])!;
      const f = featureOf(n, a.reversed ? -1 : 1);
      if (!f) continue;
      f.s = stationOf(refined, n.x, n.z);
      feats.push(f);
    }
    const idx = graph.edges.length;
    edgeAttrs.push(a);
    graph.edgeNew.push(isNew);
    graph.edges.push(edge);
    graph.edgeWay.push(r.way);
    graph.edgeRefs.push(ids);
    graph.edgeFeatures.push(feats);
    let list = graph.wayEdges.get(r.way.of ?? r.way.id);
    if (!list) graph.wayEdges.set(r.way.of ?? r.way.id, (list = []));
    list.push(idx);
  };

  for (const r of runs) {
    let start = 0;
    for (let i = 1; i < r.ids.length; i++) {
      if (i === r.ids.length - 1 || isGraphNode(r.ids[i])) {
        addEdge(r, r.ids.slice(start, i + 1));
        start = i;
      }
    }
  }

  // calming, mouths over the pavement, give-way lines, zigzags, road text (mapgen/roadextras.ts) – on the roads built the new way
  if (graph.edgeNew.some(Boolean)) {
    addRoadExtras(graph);

    // ---- 3. pavements mapped as ways of their own: the road's pavement reaches to them ----
    separateWalks(graph, edgeAttrs, new FootwayIndex(osm), new FootwayIndex(osm, true));
  }

  // ---- 4. arms, sorted counter-clockwise -----------------------------------
  const armAngles: Array<Array<{ e: number; ang: number }>> = graph.nodes.map(() => []);
  graph.edges.forEach((e, i) => {
    armAngles[e.a].push({ e: i, ang: armAngle(e, true) });
    armAngles[e.b].push({ e: i, ang: armAngle(e, false) });
  });
  graph.nodes.forEach((n, i) => {
    armAngles[i].sort((p, q) => p.ang - q.ang);
    n.arms = armAngles[i].map((a) => ({ e: a.e, r: ROLE.NONE }));
    const o = graph.nodeOsm[i];
    if (o) n.o = o.id;
    if (graph.nodeMapEnd[i]) n.t = CTRL.MAP_END;
    const tc = o?.tags?.highway;
    if (tc === 'turning_circle' || tc === 'turning_loop') n.tc = 8;
  });

  return graph;
}

/**
 * Where a road's pavement is mapped as a way of its own (footway=sidewalk)
 * beside it, the road's pavement is drawn out to that way – with a verge
 * between kerb and footway where there is room – instead of a second one, or
 * none, beside it.
 */
/** the narrowest gap (m) between a road's kerb and a separate footway that is drawn as a grass verge */
export const SEPARATE_VERGE_MIN = 1.0;
/** a separate footway lends the road's pavement its surface only when it starts within this of the kerb (m) */
export const SEPARATE_LEND_MAX = 1.0;

function separateWalks(graph: RoadGraph, attrs: Attrs[], sidewalks: FootwayIndex, bridges?: FootwayIndex): void {
  if (sidewalks.count === 0 && !bridges?.count) return;
  graph.edges.forEach((e, i) => {
    const a = attrs[i];
    if (!a.walkFromL && !a.walkFromR) return;
    // (on a bridge: the footway bridges beside it, and its walkways right at the kerb – no verge on a deck)
    const onBridge = (e.f & EF.BRIDGE) !== 0;
    const index = onBridge ? bridges : sidewalks;
    if (!index?.count) return;
    const pts: number[] = [];
    for (let k = 0; k < e.p.length; k += 3) pts.push(e.p[k], e.p[k + 2]);
    for (const left of [true, false]) {
      if (!(left ? a.walkFromL : a.walkFromR)) continue;
      let m = measureSeparateWalk(index, pts, e.w / 2, left);
      if (!m) continue;
      const side: RoadSideJson = { ...((left ? e.xl : e.xr) ?? {}) };
      const other = sideOuter(side) - (side.v ?? 0);
      if (onBridge) m = { ...m, verge: 0 };
      if (!(left ? a.vergeTaggedL : a.vergeTaggedR)) {
        const v = Math.round((m.verge - other) * 100) / 100;
        // (a gap of less than a metre between kerb and footway is paved: one pavement, not a hairline of grass)
        if (v >= SEPARATE_VERGE_MIN) side.v = v;
        else delete side.v;
      }
      // (the pavement drawn out to the separate way is made of what that way is, unless the road says – only
      // where that way is the street's pavement, right beside the kerb: one further out is a path of its own)
      if (side.wm === undefined && m.mat !== undefined && m.mat !== GM.SIDEWALK && m.verge < SEPARATE_LEND_MAX) side.wm = m.mat;
      const beyond = Math.round(Math.max(m.beyond, sideOuter(side) + 1.0) * 100) / 100;
      if (left) {
        e.sl = beyond;
        if (!sideIsPlain(side)) e.xl = side;
      } else {
        e.sr = beyond;
        if (!sideIsPlain(side)) e.xr = side;
      }
    }
  });
}

/** Total centreline length per class, for the build report. */
export function roadStats(graph: RoadGraph): string {
  const km = new Map<number, number>();
  for (const e of graph.edges) {
    let l = 0;
    for (let i = 3; i < e.p.length; i += 3) l += Math.hypot(e.p[i] - e.p[i - 3], e.p[i + 2] - e.p[i - 1]);
    km.set(e.c, (km.get(e.c) ?? 0) + l / 1000);
  }
  return [...km.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([c, l]) => `${['mw', 'mw_l', 'tr', 'tr_l', 'pri', 'pri_l', 'sec', 'sec_l', 'ter', 'ter_l', 'uncl', 'res', 'living', 'service', 'track'][c]} ${l.toFixed(1)}`)
    .join(', ');
}
