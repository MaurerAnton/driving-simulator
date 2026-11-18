// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The road-network model shared by the map pipeline (tools/) and the game.
 *
 * The pipeline writes `public/map/world.json` in the compact `WorldJson`
 * shape; `hydrateWorld()` (world.ts) turns it into the linked `World` used at
 * runtime (lanes, connectors, spatial index, surface queries).
 */
import type { RoadSideJson } from './xsection.ts';

export const ROAD_CLASSES = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'track',
] as const;
export type RoadClassName = (typeof ROAD_CLASSES)[number];

export const CLS = {
  MOTORWAY: 0,
  MOTORWAY_LINK: 1,
  TRUNK: 2,
  TRUNK_LINK: 3,
  PRIMARY: 4,
  PRIMARY_LINK: 5,
  SECONDARY: 6,
  SECONDARY_LINK: 7,
  TERTIARY: 8,
  TERTIARY_LINK: 9,
  UNCLASSIFIED: 10,
  RESIDENTIAL: 11,
  LIVING_STREET: 12,
  SERVICE: 13,
  TRACK: 14,
} as const;

/**
 * Priority tier used to derive right-of-way where OSM carries no explicit
 * sign.  Higher tier = more important road.  Links rank below the roads they
 * feed so that ramps and slip lanes give way at their end.
 * Tier < 2 means "§ 10 StVO": leaving such a road you yield to everybody.
 */
export const CLASS_TIER: readonly number[] = [7, 2.5, 6, 2.5, 5, 4.5, 4, 3.5, 3, 2.5, 2, 2, 1, 0, 0];

/** Default lane width (m) per class when OSM has no width. */
export const CLASS_LANE_WIDTH: readonly number[] = [
  3.75, 3.75, 3.5, 3.5, 3.5, 3.5, 3.25, 3.5, 3.1, 3.4, 2.85, 2.75, 2.6, 2.6, 2.4,
];

export const SURF = {
  ASPHALT: 0,
  CONCRETE: 1,
  PAVING: 2,
  SETT: 3,
  GRAVEL: 4,
  DIRT: 5,
  GRASS: 6,
} as const;
/** Tyre grip multiplier per surface. */
export const SURF_GRIP: readonly number[] = [1.0, 0.97, 0.92, 0.82, 0.62, 0.52, 0.42];
/** Rolling-resistance multiplier per surface. */
export const SURF_ROLLING: readonly number[] = [1.0, 1.0, 1.25, 1.6, 2.2, 3.0, 4.0];

/** Edge flag bits. */
export const EF = {
  BRIDGE: 1,
  TUNNEL: 2,
  ROUNDABOUT: 4,
  LINK: 8,
  LIT: 16,
  /** continuous centre line (overtaking prohibited / lane separation) */
  SOLID_CENTER: 32,
  /** carriageway has painted lane/centre markings at all */
  MARKED: 64,
  /** painted edge lines */
  EDGE_LINES: 128,
  /** built-up area (innerorts) */
  URBAN: 256,
  /** parking aisle / driveway / alley */
  MINOR_SERVICE: 512,
  /** structurally separated carriageway of a dual road */
  DUAL: 1024,
  /** bicycle road (Zeichen 244.1) */
  BICYCLE_ROAD: 2048,
} as const;

/** Who may drive here. */
export const ACCESS = {
  YES: 0,
  /** Anlieger frei */
  DESTINATION: 1,
  /** private / no / customers-only yard: entering is a violation in the sim */
  PRIVATE: 2,
  /** agricultural / forestry traffic only */
  AGRICULTURAL: 3,
} as const;

/** Junction control type. */
export const CTRL = {
  /** plain joint (2 arms) or dead end */
  NONE: 0,
  /** rechts vor links */
  RBL: 1,
  /** priority regulated by signs (or by § 10 for minor arms) */
  SIGNS: 2,
  /** traffic lights */
  SIGNALS: 3,
  ROUNDABOUT: 4,
  /** motorway-style merge/diverge */
  MERGE: 5,
  /** edge of the simulated world */
  MAP_END: 6,
} as const;

/** Role of an approach (traffic arriving at the node on this arm). */
export const ROLE = {
  /** has priority (Zeichen 301/306, roundabout ring, through carriageway) */
  PRIORITY: 0,
  /** Zeichen 205 */
  YIELD: 1,
  /** Zeichen 206 */
  STOP: 2,
  /** equal-ranked: right before left */
  RBL: 3,
  /** § 10 StVO: driveway, track, traffic-calmed area, lowered kerb */
  MINOR: 4,
  /** not an approach (one-way leaving the node) or plain joint */
  NONE: 5,
} as const;

/** Pedestrian crossing kinds. */
export const XING = { UNMARKED: 0, ZEBRA: 1, SIGNAL: 2, RAIL: 3, TRAM: 4 } as const;

/** What runs on a track: trams, light rail (regional trams), trains. */
export const RAIL = { TRAM: 0, LIGHT: 1, TRAIN: 2 } as const;

/** A level, open rectangle of the map: its middle, its size, and whether its long side runs east–west (0) or north–south (1). */
export interface YardJson {
  x: number;
  z: number;
  len: number;
  wid: number;
  rot: number;
}

/** A piece of track between two switches (or ends), as a path for the vehicles that run on it. */
export interface RailJson {
  /** RAIL */
  k: number;
  /** top of the rail along the middle of the track: x, y, z, … a point every few metres */
  p: number[];
  /** the pieces that join at the start and at the end: index * 2 + (0: their start is here, 1: their end) */
  a: number[];
  b: number[];
  /** stops: metres from the start */
  st?: number[];
  /** their names, as the stops are signed (tools/build-stops.ts; '' where the map has none) */
  sn?: string[];
  /** on which side of the track their platform lies: 1 right, -1 left of the direction it was drawn in, 0 not known */
  ss?: number[];
  /** an overhead wire along it: 1 yes, 0 no – missing when the map does not say */
  e?: number;
}

/** What a stop has, and what kind of stop it is (bits). */
export const STOP_FLAG = {
  SHELTER: 1,
  BENCH: 2,
  BIN: 4,
  /** a departure board */
  BOARD: 8,
  /** tactile paving at the edge */
  TACTILE: 16,
  LIT: 32,
  TRAM: 64,
  BUS: 128,
  RAIL: 256,
  /** a pole that stands on the road itself: the tiles already show its sign */
  ON_ROAD: 512,
  /** a platform drawn as an area, not as a line */
  AREA: 1024,
} as const;

/**
 * The stops of the region (stops.json.gz, tools/build-stops.ts).  A place is
 * one stop under one name – both directions, all its poles and platforms.
 */
export interface StopsJson {
  v: number;
  towns: string[];
  /** name, index into towns, kind (STOP_FLAG.TRAM | BUS | RAIL), x, z (the middle of its members) */
  places: Array<[string, number, number, number, number]>;
  /** where people wait: place index, x, z, STOP_FLAG bits */
  poles: Array<[number, number, number, number]>;
  /** platforms drawn as ways: place index, STOP_FLAG bits, width (0: not known), x, z, … */
  platforms: Array<[number, number, number, number[]]>;
}

export interface RunwayJson {
  /** "04/22" */
  ref: string;
  /** the ends of its middle line */
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  /** width (m) and surface (OpenStreetMap: asphalt, concrete, grass, …) */
  w: number;
  s: string;
}

export interface AirfieldJson {
  name: string;
  icao: string;
  /** airport, airfield or gliding */
  kind: string;
  x: number;
  z: number;
  runways: RunwayJson[];
  taxiways: Array<{ w: number; s: string; p: number[] }>;
  aprons: Array<{ s: string; p: number[] }>;
}

/**
 * A line of the trams (lines.json.gz, tools/build-lines.ts): one direction of
 * it – from its first stop to its last –, the pieces of track it runs (by
 * their number in rails.json.gz, and which way: 1 as drawn, −1 against it)
 * and the stops it calls at, in their order (piece, mark).
 */
export interface LineJson {
  /** "5", "RT4" */
  ref: string;
  name: string;
  from: string;
  to: string;
  /** "#e3000f" or '' */
  colour: string;
  /** 0 tram, 1 regional tram (light rail) */
  kind: number;
  paths: Array<[number, number]>;
  stops: Array<[number, number]>;
}

export interface LinesJson {
  v: number;
  lines: LineJson[];
}

/**
 * A line of the city buses (buslines.json.gz, tools/build-buslines.ts): one
 * direction of it, as a route relation of OpenStreetMap has it – the roads
 * it drives along, in their order, and the stops it calls at.
 *
 * A road is named by its number in the whole map (the same in net.bin.gz
 * and in every chunk of the network that holds it) and driven in one
 * direction: a "way", road * 2 + (0: from its junction a to b, 1: from b to
 * a), as routegraph.ts counts them.  The numbers belong to one build of the
 * road network: `map` says which.
 */
export interface BusLineJson {
  /** "52", "N3" ('' where the relation has none) */
  ref: string;
  name: string;
  from: string;
  to: string;
  operator: string;
  /** "#e3000f" or '' */
  colour: string;
  /** 0 bus, 1 trolleybus */
  kind: number;
  /** the route relation in OpenStreetMap */
  osm: number;
  /** the ways it drives, in order – each as the difference to the way before (the first as it is): mostly ±2 */
  w: number[];
  /**
   * how many of the ways are the route itself: after them come the ways
   * from its end round to where the line `back` begins (missing: none)
   */
  end?: number;
  /** the stops it calls at, in order: stop place (its number in stops.json.gz), index into the ways, metres along that way (in the direction of travel) – three numbers each */
  st: number[];
  /** the line (index in `lines`) it goes on as at the end of its route – missing where none begins there */
  back?: number;
}

export interface BusLinesJson {
  v: number;
  /** the build of the road network the road numbers belong to (meta.generated of map.json) */
  map: string;
  /** how many stop places stops.json.gz had (the stops are numbered in it) */
  places: number;
  lines: BusLineJson[];
}

/**
 * The timetables of the trams and buses (timetable.json.gz,
 * tools/build-timetable.ts, read by src/sim/timetable.ts): for each line of
 * lines.json.gz that has one, the ways its trips run – the stops in their
 * order and the seconds between them – and when they leave, on a working
 * day, a Saturday and a Sunday.  Taken from a GTFS feed, from one ordinary
 * week of it.  Version 2 adds the buses (`bus`) and where the trams' stops
 * are among the stop places (`stopPlaces`); version 1 files have the trams
 * alone and are read as well.
 */
export interface TimetableJson {
  /** 1: the trams only; 2: with `stopPlaces` and `bus` (both may be missing) */
  version: number;
  /** when the file was made (ISO 8601) */
  generated: string;
  /** the feeds it was made from */
  feeds: TimetableFeedJson[];
  /** the days all of them are valid for (YYYY-MM-DD) */
  valid: [string, string];
  /** the week the trips were taken from (its Monday and Sunday) */
  week: [string, string];
  /** the day of it each day type comes from: Monday–Friday, Saturday, Sunday and holidays */
  days: [string, string, string];
  /** whom to name, and under which licence, wherever the times are shown */
  attribution: string;
  /** the names of the stops, as the tracks have them (rails.json.gz `sn`): the patterns refer to them by their place here */
  stops: string[];
  lines: TimetableLineJson[];
  /** for each of `stops`: the stop places of stops.json.gz the trams call at under that name (by their number there; none where the build found none) */
  stopPlaces?: number[][];
  /** the timetables of the buses (version 2) */
  bus?: TimetableBusJson;
}

/**
 * The timetables of the buses: for each line of buslines.json.gz that has
 * one, the ways its trips run – which of the line's stops they call at, and
 * the seconds between them – and when they leave.  Lists that count up are
 * kept as the steps from one number to the next, which packs small.
 */
export interface TimetableBusJson {
  /** the bus lines the timetables belong to: their build (buslines.json.gz `map`) and how many stop places their stops count on */
  map: string;
  places: number;
  /** the names of the stop places the buses call at: [number in stops.json.gz, name] */
  stops: Array<[number, string]>;
  /** where the buses go, as their fronts say it: the patterns name them by their place here */
  dests: string[];
  lines: TimetableBusLineJson[];
}

export interface TimetableBusLineJson {
  /** the line's place in buslines.json.gz `lines`, its ref and its route relation there (to see that the two files belong together) */
  line: number;
  ref: string;
  osm: number;
  /** its colour: OpenStreetMap's, else the feed's route_color – missing where neither has one */
  colour?: string;
  /** the stop places of the line's stops, in the order BusLines (src/world/buslines.ts) keeps them – the patterns name the stops by their place here */
  s: number[];
  patterns: TimetableBusPatternJson[];
}

/** One way the trips of a bus line run: the same stops at the same intervals. */
export interface TimetableBusPatternJson {
  /** the line's stops it calls at, in order, by their place in the line's `s`: the first as it is, each next as the step from the one before */
  j: number[];
  /** the departure from each stop, as the seconds since the departure from the one before (the first: 0) */
  d: number[];
  /** how long it stands at each stop before it leaves (its arrival is that much before its departure), seconds – only where it stands somewhere */
  w?: number[];
  /** where it goes as its front says, and from which stop on: [k, index into `dests`], … – the first for k = 0 */
  to: number[];
  /** 1: its trips come from further back than its first stop / go on beyond its last (beyond the line's stops on the map) */
  pre?: number;
  post?: number;
  /** when its trips leave the first stop – Monday–Friday, Saturday, Sunday and holidays: the first in seconds after midnight (past 86 400: the night after), each next as the step from the one before */
  t: [number[], number[], number[]];
}

export interface TimetableFeedJson {
  name: string;
  version: string;
  url: string;
  /** first and last day it is valid for (YYYY-MM-DD) */
  start: string;
  end: string;
}

export interface TimetableLineJson {
  /** the line's place in lines.json.gz `lines`, and its ref there (to see that the two files belong together) */
  line: number;
  ref: string;
  /** its colour ("#00954B", or a name OpenStreetMap uses: "red"): OpenStreetMap's, else the feed's route_color – missing where neither has one (version 2) */
  colour?: string;
  patterns: TimetablePatternJson[];
}

/** One way the trips of a line run: the same stops at the same intervals. */
export interface TimetablePatternJson {
  /** its stops (indices into TimetableJson.stops), in the order it calls at them – only those of the line on the map */
  s: number[];
  /** the same stops by their place in the line's `stops` in lines.json.gz (where its piece of track and mark are) */
  j: number[];
  /** the departure from each, seconds after the departure from the first */
  d: number[];
  /** the arrival at each, the same way – only where some arrival differs from its departure */
  a?: number[];
  /** where its trams go: the last stop of the whole trip */
  to: string;
  /** 1: the trips come from further back than the first of `s` / go on beyond the last (the map's tracks end there) */
  pre?: number;
  post?: number;
  /** when its trips leave the first stop, seconds after midnight, sorted (past 86 400: the night after) – Monday–Friday, Saturday, Sunday and holidays */
  t: [number[], number[], number[]];
}

/** The airfields of the region (air.json.gz, tools/build-stops.ts). */
export interface AirJson {
  v: number;
  airfields: AirfieldJson[];
}

/** Height of a standard kerb in metres. */
export const KERB_H = 0.12;

// ---------------------------------------------------------------------------
// Serialised form (world.json)
// ---------------------------------------------------------------------------

export interface EdgeJson {
  /** node indices */
  a: number;
  b: number;
  c: number; // class index
  n?: string; // name
  r?: string; // ref
  /** centreline, [x, y, z] triples in world metres (cm precision) */
  p: number[];
  /**
   * the same in whole centimetres, each point as the step from the one before
   * (the first from the origin) – what chunks of the network carry instead
   * of `p`, which is then empty: it takes half the room
   */
  q?: number[];
  lf: number; // lanes forward (along a→b)
  lb: number; // lanes backward
  lw: number; // lane width
  w: number; // carriageway width (paved surface between kerbs/verges)
  /** paved margin outside the lanes on each side (hard strip / shoulder), default 0 */
  mg?: number;
  mf: number; // max speed forward km/h (0 = unlimited)
  mb: number; // max speed backward km/h
  /** 0, or 30/20 for Tempo zones, 7 for verkehrsberuhigter Bereich */
  z?: number;
  s?: number; // surface (default asphalt)
  sl?: number; // sidewalk width on the left of a→b
  sr?: number; // sidewalk width on the right
  f: number; // EF flags
  ac?: number; // ACCESS
  ca: number; // junction cut-back at node a
  cb: number; // junction cut-back at node b
  ly?: number; // layer
  tf?: string; // turn:lanes forward (left→right, as in OSM)
  tb?: string; // turn:lanes backward
  o?: number; // OSM way id (provenance / debugging)
  /** crossings on this edge (where the road network comes in chunks: there they travel with their edge) */
  x?: EdgeCrossingJson[];
  /** forbidden movements from this edge, in chunks: via node, to edge, via node, to edge, … */
  bn?: number[];
  /** the cross-section beyond the lanes on the left and right of a→b – parking, cycle lanes, verge, kerb (src/world/xsection.ts) */
  xl?: RoadSideJson;
  xr?: RoadSideJson;
  /** a one-way carriageway of a dual road: what lies on its left, towards the other one (MEDIAN bits) */
  md?: number;
  /** traffic calming across the carriageway: per entry station, CALM kind, length, height (src/world/roadfeatures.ts) */
  cm?: number[];
  /** kerb build-outs narrowing the carriageway: per entry station, side, length, depth, BO flags (src/world/narrowing.ts) */
  bo?: number[];
  /** 1: meets the roads at its ends over a continuous pavement – a lowered kerb across its mouth (src/world/roadfeatures.ts) */
  mk?: number;
  /** give-way line (Zeichen 341) at a yield: 1 painted, 0 not; absent: as the road's markings say */
  gl?: number;
  /** zigzag lines (Zeichen 299) along the kerb: 1 left, 2 right of a→b (bits) */
  zz?: number;
  /** text painted on the carriageway: [text, station, +1 read going a→b / −1 going b→a], … */
  rt?: Array<[string, number, number]>;
  /** zigzag lines over a stretch only: [from station, to station, side bits], … (a bus stop's) */
  zs?: number[];
}

/** A crossing as part of its edge's record (CrossingJson without the edge). */
export interface EdgeCrossingJson {
  s: number;
  k: number;
  w: number;
  isl?: boolean;
  sc?: number;
  g?: number;
}

export interface ArmJson {
  e: number; // edge index
  /** approach role (ROLE) for traffic arriving on this arm */
  r: number;
  /** signal group index inside the node's controller, or -1 */
  g?: number;
  /** distance from the node to the stop/yield line along the edge (>= cut) */
  sl?: number;
}

export interface NodeJson {
  x: number;
  y: number;
  z: number;
  /** junction plane gradient (dy/dx, dy/dz) */
  gx?: number;
  gz?: number;
  t: number; // CTRL
  /** arms in counter-clockwise order */
  arms: ArmJson[];
  /** signal controller index */
  sc?: number;
  /** corner fillet radius per arm gap (arm i → arm i+1), parallel to `arms` */
  fr?: number[];
  /** turning circle radius (dead ends) */
  tc?: number;
  o?: number; // OSM node id
}

export interface SignalPhaseJson {
  /** duration in seconds */
  d: number;
  /** one char per group: R red, Y red+yellow, G green, A amber (yellow), O off */
  s: string;
}

export interface SignalControllerJson {
  x: number;
  z: number;
  groups: number;
  phases: SignalPhaseJson[];
  /** cycle offset in seconds (staggers neighbouring junctions) */
  off: number;
  /** pedestrian-crossing light (rests on green for vehicles) */
  ped?: boolean;
}

export interface CrossingJson {
  e: number; // edge
  s: number; // station along the edge (from node a)
  k: number; // XING
  w: number; // width of the crossing strip along the road
  isl?: boolean;
  /** signal controller + group for signalised crossings */
  sc?: number;
  g?: number;
}

export interface PlaceJson {
  name: string;
  kind: string;
  x: number;
  z: number;
}

/** A spot where the player can start (parking lots, driving school yard). */
export interface SpawnJson {
  name: string;
  x: number;
  z: number;
  /** yaw in radians (0 = north, positive = left/counter-clockwise) */
  yaw: number;
  kind: 'parking' | 'street' | 'school';
  /**
   * The place was taken from the overview of the whole map (its roads were
   * not loaded): it lies on a road only roughly, and is put into a lane once
   * the roads there are loaded.
   */
  rough?: boolean;
  /** the town or municipality it lies in: the list of start points is grouped by it */
  g?: string;
}

export interface WorldJson {
  version: number;
  meta: {
    name: string;
    generated: string;
    /** when tiles of the map were replaced after its build (tools/fetch-map.ts: tiles-patch.tar) – part of their address */
    patched?: string;
    /** world-space bounds in metres */
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    tileSize: number;
    originE: number;
    originN: number;
    attribution: string[];
  };
  nodes: NodeJson[];
  edges: EdgeJson[];
  /** forbidden movements: [fromEdge, viaNode, toEdge] */
  banned: number[][];
  signals: SignalControllerJson[];
  crossings: CrossingJson[];
  places: PlaceJson[];
  spawns: SpawnJson[];
  /** tram and railway tracks as paths (maps built before trams ran have none) */
  rails?: RailJson[];
  /** the open field the practice yard of the truck lessons is laid on */
  yard?: YardJson;
  /** tile keys ("ix_iz") that exist on disk */
  tiles: string[];
}

// ---------------------------------------------------------------------------
// A map in pieces: the index (map.json), chunks of the road network (w/<cx>_<cz>.json.gz)
// ---------------------------------------------------------------------------

/**
 * One chunk of the road network: the junctions that lie in a square of the
 * chunk grid, and every road that begins or ends at one of them.  Nodes,
 * edges and signal controllers keep their numbers of the whole map; a road
 * between two chunks is in both.
 */
export interface WorldChunkJson {
  v: 1;
  nodes: Array<[number, NodeJson]>;
  edges: Array<[number, EdgeJson]>;
  signals: Array<[number, SignalControllerJson]>;
}

/** What the game loads first of a map in pieces. */
export interface MapIndexJson {
  version: 2;
  meta: WorldJson['meta'];
  places: PlaceJson[];
  spawns: SpawnJson[];
  yard?: YardJson;
  /** which tiles (500 m) and which chunks of the road network (4 km) exist */
  tiles: import('./grid.ts').GridBits;
  chunks: import('./grid.ts').GridBits;
  /** numbers of nodes and edges in the whole map */
  nodes: number;
  edges: number;
}
