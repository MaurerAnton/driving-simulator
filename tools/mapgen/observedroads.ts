// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What was seen on site about single roads: corrections to the tags of
 * OpenStreetMap ways, where the street as it is (compared by eye with
 * street-level pictures) differs from what is mapped – a parking lane that
 * is not mapped, a pavement on one side only, a verge, the contents of a
 * median.
 *
 * The list is tools/mapgen/observed-roads.json:
 *
 *   { "about": "…",
 *     "ways": { "<osm way id>": { "tags": { "parking:right": "lane", "sidewalk:left": null }, "note": "…" } } }
 *
 * Each tag given replaces the mapped one; null deletes it.  The corrections
 * are applied when an extract is read (OsmData.load in tools/mapgen/osm.ts),
 * so the road network, the tiles, the signs and everything else built from
 * OpenStreetMap see the same street.  OBSERVED_ROADS=<file> reads another
 * list (tests; "none": none at all).
 *
 * Besides the tags, the list corrects where a way lies (OpenStreetMap is
 * locally a few metres off the road as the official orthophotos show it):
 *
 *   "ways":  { "<id>": { "shift": [dx, dz] } }   every node of the way moves by dx metres east, dz south
 *   "nodes": { "<id>": [dx, dz] }                 one node moves (a junction, a bend) – this wins over
 *                                                 the shifts of its ways
 *
 * A node shared by several shifted ways moves by the mean of their shifts.
 *
 * And it adds what OpenStreetMap lacks and drops what is not there:
 *
 *   "areas":   [{ "id": "obs-1", "tags": { "amenity": "parking" }, "pts": [[x, z], …] }]
 *              closed areas in world metres (x east, z south), taken like mapped areas with these tags
 *   "newWays": [{ "id": "obs-w1", "tags": { "highway": "service" }, "pts": [[x, z], …], "connect": true }]
 *              new ways; with connect, each end joins the nearest node of a way of the same kind
 *              (highway, railway …) within 3 m, or – if one passes more than 1 m nearer – the
 *              nearest piece of one (a node is put in there)
 *   "remove":  [<osm way id>, …]   ways that are not there
 *
 * Ways cut where their tags change ("split"), pairs of carriageways made one
 * road ("merge") and tagged nodes put into roads ("points"): waysplit.ts.
 *
 * The added ways and their nodes get negative ids (from their names, the same
 * on every build) that cannot meet OpenStreetMap's: ways −1e9 − n, nodes
 * −2e9 − n·1000 − i.  Added and removed ways are known where an extract is read
 * (OsmData.load); readPbf leaves the removed ways out but adds nothing (what
 * reads the PBF directly – signs, lines, bus lines, services – finds its
 * things by OSM ids and tags).
 * The extracts keep the coordinates as mapped; the shifts are applied when
 * they are read (OsmData.load) and when the PBF is read directly (readPbf,
 * tools/osm/pbf.ts – which finds the nodes of the shifted ways once and keeps
 * them beside the PBF: `<pbf>.shift-refs.json`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type TagEdit = Record<string, string | null>;

interface ObservedRoadsJson {
  about?: string;
  ways?: Record<string, { tags?: TagEdit; shift?: unknown; note?: string } | undefined>;
  nodes?: Record<string, unknown>;
  areas?: Array<{ id?: unknown; tags?: unknown; pts?: unknown; note?: string }>;
  newWays?: Array<{ id?: unknown; tags?: unknown; pts?: unknown; connect?: unknown; note?: string }>;
  remove?: unknown[];
}

/** A move in the world frame (m): east, south. */
export type Shift = [number, number];

/** Where ways and nodes are moved to (the "shift" of ways and the "nodes" of the list). */
export interface GeometryCorrections {
  ways: Map<number, Shift>;
  nodes: Map<number, Shift>;
}

function shiftOf(v: unknown): Shift | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const dx = Number(v[0]);
  const dz = Number(v[1]);
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || Math.hypot(dx, dz) > 50) return null;
  return [dx, dz];
}

const DEFAULT_FILE = fileURLToPath(new URL('./observed-roads.json', import.meta.url));

/** The corrections read from `file` (default: the list next to this module, or OBSERVED_ROADS): way id → tag edits. */
export function loadRoadCorrections(file = process.env.OBSERVED_ROADS ?? DEFAULT_FILE): Map<number, TagEdit> {
  const out = new Map<number, TagEdit>();
  if (file === 'none' || !existsSync(file)) return out;
  const j = JSON.parse(readFileSync(file, 'utf8')) as ObservedRoadsJson;
  for (const [key, entry] of Object.entries(j.ways ?? {})) {
    const id = Number(key);
    if (!Number.isInteger(id) || !entry || typeof entry.tags !== 'object' || entry.tags === null) continue;
    const edit: TagEdit = {};
    for (const [k, v] of Object.entries(entry.tags)) {
      if (v === null) edit[k] = null;
      else if (typeof v === 'string' || typeof v === 'number') edit[k] = String(v);
    }
    out.set(id, edit);
  }
  return out;
}

/** The tags of a way with its corrections over them (a new object when anything changes). */
export function correctTags(tags: Record<string, string> | undefined, edit: TagEdit | undefined): Record<string, string> {
  const base = tags ?? {};
  if (!edit) return base;
  const out: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(edit)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

let cached: Map<number, TagEdit> | null = null;
let cachedFrom = '';

/** The corrections as the map build uses them (read once per file). */
export function roadCorrections(): Map<number, TagEdit> {
  const file = process.env.OBSERVED_ROADS ?? DEFAULT_FILE;
  if (!cached || cachedFrom !== file) {
    cached = loadRoadCorrections(file);
    cachedFrom = file;
  }
  return cached;
}

/** The geometry corrections read from `file` (as loadRoadCorrections). */
export function loadGeometryCorrections(file = process.env.OBSERVED_ROADS ?? DEFAULT_FILE): GeometryCorrections {
  const out: GeometryCorrections = { ways: new Map(), nodes: new Map() };
  if (file === 'none' || !existsSync(file)) return out;
  const j = JSON.parse(readFileSync(file, 'utf8')) as ObservedRoadsJson;
  for (const [key, entry] of Object.entries(j.ways ?? {})) {
    const id = Number(key);
    const sh = entry ? shiftOf(entry.shift) : null;
    if (Number.isInteger(id) && sh && (sh[0] !== 0 || sh[1] !== 0)) out.ways.set(id, sh);
  }
  for (const [key, v] of Object.entries(j.nodes ?? {})) {
    const id = Number(key);
    const sh = shiftOf(v);
    if (Number.isInteger(id) && sh) out.nodes.set(id, sh);
  }
  return out;
}

let cachedGeo: GeometryCorrections | null = null;
let cachedGeoFrom = '';

/** The geometry corrections as the map build uses them (read once per file). */
export function geometryCorrections(): GeometryCorrections {
  const file = process.env.OBSERVED_ROADS ?? DEFAULT_FILE;
  if (!cachedGeo || cachedGeoFrom !== file) {
    cachedGeo = loadGeometryCorrections(file);
    cachedGeoFrom = file;
  }
  return cachedGeo;
}

/** Are there any geometry corrections at all? */
export function hasGeometryCorrections(g: GeometryCorrections): boolean {
  return g.ways.size > 0 || g.nodes.size > 0;
}

/**
 * How far each node moves: the mean of the shifts of the shifted ways it
 * belongs to (each way counted once), unless the list moves the node itself.
 * `ways`: the ways that are known with their nodes (at least the shifted ones).
 */
export function nodeShifts(ways: Iterable<{ id: number; refs: readonly number[] }>, g: GeometryCorrections): Map<number, Shift> {
  const sum = new Map<number, [number, number, number]>();
  for (const w of ways) {
    const sh = g.ways.get(w.id);
    if (!sh) continue;
    const seen = new Set<number>();
    for (const r of w.refs) {
      if (seen.has(r)) continue; // (a closed way lists its first node twice)
      seen.add(r);
      const a = sum.get(r);
      if (a) {
        a[0] += sh[0];
        a[1] += sh[1];
        a[2]++;
      } else sum.set(r, [sh[0], sh[1], 1]);
    }
  }
  const out = new Map<number, Shift>();
  for (const [id, [x, z, n]] of sum) out.set(id, [x / n, z / n]);
  for (const [id, sh] of g.nodes) out.set(id, sh);
  return out;
}

/** A way added by the list (world metres). */
export interface AddedWay {
  /** its name in the list, and its negative id */
  name: string;
  id: number;
  tags: Record<string, string>;
  /** flat x, z – an area closed (its first point not repeated) */
  pts: number[];
  closed: boolean;
  connect: boolean;
}

export interface Additions {
  ways: AddedWay[];
  remove: Set<number>;
}

/** The negative id of an added way from its name (the same on every build): −1e9 − n, n < 1e6. */
export function addedWayId(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return -1e9 - (h % 1_000_000);
}

/** The id of node `i` of an added way. */
export function addedNodeId(wayId: number, i: number): number {
  return -2e9 - (-wayId - 1e9) * 1000 - i;
}

function ptsOf(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const x = Number(p[0]);
    const z = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    out.push(x, z);
  }
  return out;
}

function tagsOf(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'string' || typeof x === 'number') out[k] = String(x);
  return out;
}

/** The areas, new ways and removals read from `file` (as loadRoadCorrections). */
export function loadAdditions(file = process.env.OBSERVED_ROADS ?? DEFAULT_FILE): Additions {
  const out: Additions = { ways: [], remove: new Set() };
  if (file === 'none' || !existsSync(file)) return out;
  const j = JSON.parse(readFileSync(file, 'utf8')) as ObservedRoadsJson;
  const used = new Set<number>();
  const add = (entry: { id?: unknown; tags?: unknown; pts?: unknown; connect?: unknown }, closed: boolean, k: number): void => {
    const tags = tagsOf(entry.tags);
    let pts = ptsOf(entry.pts);
    if (!tags || !pts) return;
    // (an area given closed: its last point is its first)
    if (closed && pts.length >= 4 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts = pts.slice(0, -2);
    if (pts.length < (closed ? 6 : 4)) return;
    const name = entry.id === undefined ? `${closed ? 'area' : 'way'}-${k}` : String(entry.id);
    let id = addedWayId(name);
    while (used.has(id)) id = id === -1e9 - 999_999 ? -1e9 : id - 1;
    used.add(id);
    out.ways.push({ name, id, tags, pts, closed, connect: !closed && entry.connect === true });
  };
  (j.areas ?? []).forEach((a, k) => add(a, true, k));
  (j.newWays ?? []).forEach((w, k) => add(w, false, k));
  for (const r of j.remove ?? []) {
    const id = Number(r);
    if (Number.isInteger(id) && id > 0) out.remove.add(id);
  }
  return out;
}

let cachedAdd: Additions | null = null;
let cachedAddFrom = '';

/** The additions as the map build uses them (read once per file). */
export function additions(): Additions {
  const file = process.env.OBSERVED_ROADS ?? DEFAULT_FILE;
  if (!cachedAdd || cachedAddFrom !== file) {
    cachedAdd = loadAdditions(file);
    cachedAddFrom = file;
  }
  return cachedAdd;
}

/** What kind of network a way belongs to, for joining an added way to it ('' : none). */
export function networkKind(tags: Record<string, string> | undefined): string {
  if (!tags) return '';
  if (tags.highway && tags.area !== 'yes') return 'highway';
  if (tags.railway) return 'railway';
  if (tags.waterway) return 'waterway';
  return '';
}

/** How an end of an added way joins the network: to a node, or into a piece of a way (a new node there). */
export type Join = { node: number } | { way: number; after: number; x: number; z: number };

/**
 * Where the end (x, z) of an added way of network `kind` joins: the nearest
 * node of a way of that kind within `reach`, else the nearest point on one of
 * its pieces (inserted after its node index `after`).  Null: nothing near.
 */
export function findJoin(
  x: number,
  z: number,
  kind: string,
  ways: Iterable<{ id: number; refs: number[]; tags: Record<string, string> }>,
  pos: (id: number) => { x: number; z: number } | undefined,
  reach = 3,
): Join | null {
  let bestNode: number | null = null;
  let bn = reach;
  let bestSeg: { way: number; after: number; x: number; z: number } | null = null;
  let bs = reach;
  for (const w of ways) {
    if (networkKind(w.tags) !== kind) continue;
    for (let i = 0; i < w.refs.length; i++) {
      const p = pos(w.refs[i]);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bn) {
        bn = d;
        bestNode = w.refs[i];
      }
      if (i + 1 >= w.refs.length) continue;
      const q = pos(w.refs[i + 1]);
      if (!q) continue;
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / l2));
      const fx = p.x + dx * t;
      const fz = p.z + dz * t;
      const ds = Math.hypot(fx - x, fz - z);
      if (ds < bs && t > 0 && t < 1) {
        bs = ds;
        bestSeg = { way: w.id, after: i, x: fx, z: fz };
      }
    }
  }
  // (a node unless a piece of a way passes much nearer)
  if (bestNode !== null && (!bestSeg || bn <= bs + 1)) return { node: bestNode };
  return bestSeg;
}
