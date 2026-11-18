// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Corrections of tools/mapgen/observed-roads.json that change how ways run,
 * not only what they say: a way cut into parts whose tags differ along it,
 * and a pair of one-way carriageways that is really one two-way road over a
 * stretch.
 *
 *   "split": [{ "osm": 22757384, "at": [x, z] }, …]
 *       cuts the way at the point of it nearest to (x, z) – at its node there
 *       if one lies within 1 m, else at a node put in.  Several entries for
 *       one way cut it several times.  The parts are numbered from 1 in the
 *       order the way is drawn in OpenStreetMap and are addressed as
 *       "<id>:<n>": in "ways" (tags for that part only, over the tags given to
 *       the whole way under "<id>") and in "remove".
 *
 *   "merge": [{ "id": "tha-east", "a": [ways of one carriageway, in order],
 *               "b": [ways of the other], "from": [x, z], "to": [x, z],
 *               "tags": { "lanes": "2", … } }]
 *       between the points of the two carriageways nearest to `from` and to
 *       `to`, both are taken out and one two-way way runs along the middle
 *       of them instead.  Its tags are those of the first carriageway without
 *       oneway, lanes, turn lanes and median, with `tags` over them (null
 *       deletes).  The ends of the carriageways outside the stretch meet the
 *       new way in one node; junctions and mapped things (crossings, signals)
 *       on the stretch move onto the new way, so the side streets stay joined.
 *
 *   "points": [{ "at": [x, z], "tags": { "traffic_calming": "table" }, "way": "<id>" | "<id>:<n>" }]
 *       a node with these tags put into the road nearest to (x, z) (within
 *       10 m; or into the way given) – where OpenStreetMap lacks a raised
 *       table, a choker, a give-way sign, a bus stop on the road.  A node of
 *       the road within 0.3 m takes the tags instead.
 *
 * The parts and the new way are ways of their own (negative ids from their
 * names, the same on every build); a part remembers the OpenStreetMap way it
 * was cut from (`of`), and the road network names its roads after that – bus
 * lines and turn restrictions find them as before.  `wayById` keeps the uncut
 * way under its own id for whatever looks a way up by number (outlines of
 * areas, the times on signs).  Applied where an extract is read
 * (OsmData.load); what reads the PBF directly does not see it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addedWayId } from './observedroads.ts';
import type { TagEdit } from './observedroads.ts';
import type { ONode, OWay } from './osm.ts';

export interface SplitSpec {
  way: number;
  x: number;
  z: number;
}

export interface MergeSpec {
  name: string;
  /** the ways of each carriageway: OSM ids or "<id>:<n>" parts */
  a: string[];
  b: string[];
  from: [number, number];
  to: [number, number];
  tags: TagEdit;
}

export interface PointSpec {
  name: string;
  x: number;
  z: number;
  tags: Record<string, string>;
  /** the way to put it in ("<id>" or "<id>:<n>"); absent: the nearest road */
  way?: string;
}

export interface WayEdits {
  points: PointSpec[];
  splits: SplitSpec[];
  /** "<id>:<n>" → tag edits of that part */
  parts: Map<string, TagEdit>;
  /** "<id>:<n>" parts that are not there */
  removeParts: Set<string>;
  merges: MergeSpec[];
}

/** What of an extract the edits work on (OsmData). */
export interface WayStore {
  nodes: Map<number, ONode>;
  ways: OWay[];
  wayById: Map<number, OWay>;
}

const DEFAULT_FILE = fileURLToPath(new URL('./observed-roads.json', import.meta.url));

function pt(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = Number(v[0]);
  const z = Number(v[1]);
  return Number.isFinite(x) && Number.isFinite(z) ? [x, z] : null;
}

function edit(v: unknown): TagEdit {
  const out: TagEdit = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === null) out[k] = null;
    else if (typeof x === 'string' || typeof x === 'number') out[k] = String(x);
  }
  return out;
}

const PART = /^(\d+):(\d+)$/;

/** The splits, part tags, part removals and merges of `file` (default: the list, or OBSERVED_ROADS; "none": none). */
export function loadWayEdits(file = process.env.OBSERVED_ROADS ?? DEFAULT_FILE): WayEdits {
  const out: WayEdits = { points: [], splits: [], parts: new Map(), removeParts: new Set(), merges: [] };
  if (file === 'none' || !existsSync(file)) return out;
  const j = JSON.parse(readFileSync(file, 'utf8')) as {
    ways?: Record<string, { tags?: unknown } | undefined>;
    split?: Array<{ osm?: unknown; at?: unknown }>;
    remove?: unknown[];
    merge?: Array<{ id?: unknown; a?: unknown; b?: unknown; from?: unknown; to?: unknown; tags?: unknown }>;
    points?: Array<{ id?: unknown; at?: unknown; tags?: unknown; way?: unknown }>;
  };
  (j.points ?? []).forEach((q, k) => {
    const at = pt(q?.at);
    const tags: Record<string, string> = {};
    for (const [key, v] of Object.entries(edit(q?.tags))) if (v !== null) tags[key] = v;
    if (!at || Object.keys(tags).length === 0) return;
    const way = q.way === undefined ? undefined : String(q.way);
    out.points.push({ name: q.id === undefined ? `point-${k}` : String(q.id), x: at[0], z: at[1], tags, ...(way && /^\d+(:\d+)?$/.test(way) ? { way } : {}) });
  });
  for (const s of j.split ?? []) {
    const id = Number(s?.osm);
    const at = pt(s?.at);
    if (Number.isInteger(id) && id > 0 && at) out.splits.push({ way: id, x: at[0], z: at[1] });
  }
  for (const [key, entry] of Object.entries(j.ways ?? {})) {
    if (PART.test(key) && entry && typeof entry.tags === 'object' && entry.tags) out.parts.set(key, edit(entry.tags));
  }
  for (const r of j.remove ?? []) if (typeof r === 'string' && PART.test(r)) out.removeParts.add(r);
  (j.merge ?? []).forEach((m, k) => {
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => /^\d+(:\d+)?$/.test(x)) : []);
    const a = list(m?.a);
    const b = list(m?.b);
    const from = pt(m?.from);
    const to = pt(m?.to);
    if (!a.length || !b.length || !from || !to) return;
    out.merges.push({ name: m.id === undefined ? `merge-${k}` : String(m.id), a, b, from, to, tags: edit(m.tags) });
  });
  return out;
}

let cached: WayEdits | null = null;
let cachedFrom = '';

/** The edits as the map build uses them (read once per file). */
export function wayEdits(): WayEdits {
  const file = process.env.OBSERVED_ROADS ?? DEFAULT_FILE;
  if (!cached || cachedFrom !== file) {
    cached = loadWayEdits(file);
    cachedFrom = file;
  }
  return cached;
}

/** Are there any? */
export function hasWayEdits(e: WayEdits): boolean {
  return e.splits.length > 0 || e.merges.length > 0 || e.points.length > 0;
}

/** A number from a name, the same on every build. */
function hash(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** The id of a node put in by these edits (below the ids of observedroads.ts: −3e9 and lower). */
export function editNodeId(name: string): number {
  return -3e9 - (hash(name) % 100_000_000);
}

/** A way id from a name that no way of `store` has yet. */
function freshWayId(store: WayStore, name: string): number {
  let id = addedWayId(name);
  while (store.wayById.has(id)) id = id === -1e9 - 999_999 ? -1e9 : id - 1;
  return id;
}

/** The nearest point of a way's line to (x, z): its piece (after node index `i`), how far along it (0…1), the distance. */
function nearestOn(store: WayStore, refs: readonly number[], x: number, z: number): { i: number; t: number; d: number; fx: number; fz: number } | null {
  let best: { i: number; t: number; d: number; fx: number; fz: number } | null = null;
  for (let i = 0; i + 1 < refs.length; i++) {
    const p = store.nodes.get(refs[i]);
    const q = store.nodes.get(refs[i + 1]);
    if (!p || !q) continue;
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / l2)) : 0;
    const fx = p.x + dx * t;
    const fz = p.z + dz * t;
    const d = Math.hypot(fx - x, fz - z);
    if (!best || d < best.d) best = { i, t, d, fx, fz };
  }
  return best;
}

/**
 * The node of way `refs` nearest to (x, z) to cut at: a node of it within
 * `snap` metres of the nearest point, else a new node put in there (refs
 * changed in place).  Returns its index in refs, or -1 (no line).
 */
function cutPoint(store: WayStore, refs: number[], x: number, z: number, nodeName: string, snap = 1): number {
  const n = nearestOn(store, refs, x, z);
  if (!n) return -1;
  const p = store.nodes.get(refs[n.i])!;
  const q = store.nodes.get(refs[n.i + 1])!;
  const dp = Math.hypot(p.x - n.fx, p.z - n.fz);
  const dq = Math.hypot(q.x - n.fx, q.z - n.fz);
  if (dp <= snap && dp <= dq) return n.i;
  if (dq <= snap) return n.i + 1;
  const id = editNodeId(nodeName);
  store.nodes.set(id, { id, x: n.fx, z: n.fz, tags: null });
  refs.splice(n.i + 1, 0, id);
  return n.i + 1;
}

/**
 * Cut `way` at the points given (each the nearest point of the way): the
 * parts in drawing order (just the way itself when no cut falls inside it).
 * The parts replace the way in `store.ways` (where it stood); `wayById`
 * keeps the uncut way under its own id and gets each part under its own.
 */
export function splitWay(store: WayStore, way: OWay, at: ReadonlyArray<readonly [number, number]>, name: string): OWay[] {
  const closed = way.refs.length > 2 && way.refs[0] === way.refs[way.refs.length - 1];
  if (closed || at.length === 0) return [way];
  const refs = way.refs.slice();
  const cutIds = new Set<number>();
  at.forEach(([x, z], k) => {
    const i = cutPoint(store, refs, x, z, `${name}@${k}`);
    if (i > 0 && i < refs.length - 1) cutIds.add(refs[i]);
  });
  if (cutIds.size === 0) return [way];
  const parts: OWay[] = [];
  let start = 0;
  for (let i = 1; i < refs.length; i++) {
    if (i < refs.length - 1 && !cutIds.has(refs[i])) continue;
    const part: OWay = { id: freshWayId(store, `${name}:${parts.length + 1}`), refs: refs.slice(start, i + 1), tags: { ...way.tags }, of: way.of ?? way.id };
    store.wayById.set(part.id, part);
    parts.push(part);
    start = i;
  }
  const at0 = store.ways.indexOf(way);
  if (at0 >= 0) store.ways.splice(at0, 1, ...parts);
  else store.ways.push(...parts);
  // (the uncut way stays known by its number, for outlines and the like)
  if (!store.wayById.has(way.id)) store.wayById.set(way.id, way);
  return parts;
}

/** Apply the splits of the list, the tags of the parts and the removal of parts. */
export function applySplits(store: WayStore, edits: WayEdits): Map<string, OWay> {
  const byWay = new Map<number, Array<[number, number]>>();
  for (const s of edits.splits) {
    let l = byWay.get(s.way);
    if (!l) byWay.set(s.way, (l = []));
    l.push([s.x, s.z]);
  }
  const named = new Map<string, OWay>();
  for (const [id, pts] of byWay) {
    const way = store.wayById.get(id);
    if (!way || !store.ways.includes(way)) continue;
    const parts = splitWay(store, way, pts, String(id));
    if (parts.length < 2) continue;
    parts.forEach((p, k) => named.set(`${id}:${k + 1}`, p));
  }
  for (const [key, ed] of edits.parts) {
    const p = named.get(key);
    if (!p) continue;
    for (const [k, v] of Object.entries(ed)) {
      if (v === null) delete p.tags[k];
      else p.tags[k] = v;
    }
  }
  for (const key of edits.removeParts) {
    const p = named.get(key);
    if (!p) continue;
    const i = store.ways.indexOf(p);
    if (i >= 0) store.ways.splice(i, 1);
    store.wayById.delete(p.id);
    named.delete(key);
  }
  return named;
}

// ---------------------------------------------------------------------------
// merging two carriageways

/** Length along a chain of points, and a point a fraction of the way along it. */
function chainPts(store: WayStore, ids: readonly number[]): number[] {
  const out: number[] = [];
  for (const id of ids) {
    const n = store.nodes.get(id);
    if (n) out.push(n.x, n.z);
  }
  return out;
}

function lengthOf(p: readonly number[]): number {
  let l = 0;
  for (let i = 2; i < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return l;
}

function along(p: readonly number[], f: number): [number, number] {
  const total = lengthOf(p);
  let want = f * total;
  for (let i = 2; i < p.length; i += 2) {
    const l = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    if (want <= l || i === p.length - 2) {
      const t = l > 1e-9 ? Math.min(1, want / l) : 0;
      return [p[i - 2] + (p[i] - p[i - 2]) * t, p[i - 1] + (p[i + 1] - p[i - 1]) * t];
    }
    want -= l;
  }
  return [p[0], p[1]];
}

/** Station and foot of (x, z) on a line of points. */
function project(p: readonly number[], x: number, z: number): { s: number; x: number; z: number } {
  let best = Infinity;
  let res = { s: 0, x: p[0], z: p[1] };
  let acc = 0;
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2];
    const az = p[i - 1];
    const dx = p[i] - ax;
    const dz = p[i + 1] - az;
    const l2 = dx * dx + dz * dz;
    const l = Math.sqrt(l2);
    const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    const fx = ax + dx * t;
    const fz = az + dz * t;
    const d = Math.hypot(fx - x, fz - z);
    if (d < best) {
      best = d;
      res = { s: acc + l * t, x: fx, z: fz };
    }
    acc += l;
  }
  return res;
}

/** The node ids from node `from` to node `to` over the given ways (each usable either way round), or null. */
function chainBetween(ways: readonly OWay[], from: number, to: number): { ids: number[]; ways: OWay[] } | null {
  if (from === to) return null;
  const prev = new Map<number, { node: number; way: OWay }>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const n = queue.shift()!;
    if (n === to) break;
    for (const w of ways) {
      const first = w.refs[0];
      const last = w.refs[w.refs.length - 1];
      const other = first === n ? last : last === n ? first : null;
      if (other === null || seen.has(other)) continue;
      seen.add(other);
      prev.set(other, { node: n, way: w });
      queue.push(other);
    }
  }
  if (!seen.has(to)) return null;
  const used: OWay[] = [];
  let ids: number[] = [to];
  for (let n = to; n !== from; ) {
    const p = prev.get(n)!;
    used.unshift(p.way);
    const r = p.way.refs[0] === p.node ? p.way.refs.slice(1) : p.way.refs.slice(0, -1).reverse();
    // (r runs from the node after p.node to n)
    ids = [...r.slice(0, -1), ...ids];
    n = p.node;
  }
  return { ids: [from, ...ids], ways: used };
}

/** Keys of a carriageway that do not hold for the two-way road made of a pair. */
/** The tag a merged way carries (its name in the list): not OpenStreetMap's, read by mapgen/islands.ts only. */
export const MERGED_KEY = 'observed:merge';

const ONE_WAY_KEYS = /^(oneway(:.*)?|lanes(:.*)?|turn:lanes(:.*)?|median:contents|dual_carriageway|destination(:.*)?)$/;

export interface MergeResult {
  name: string;
  way: OWay | null;
  why?: string;
}

/**
 * Merge two one-way carriageways into one two-way way between the points
 * nearest to `from` and `to` (MergeSpec).  `named`: the parts of split ways
 * by "<id>:<n>".
 */
export function mergePair(store: WayStore, spec: MergeSpec, named: ReadonlyMap<string, OWay> = new Map()): MergeResult {
  const resolve = (keys: string[]): OWay[] => {
    const out: OWay[] = [];
    for (const k of keys) {
      const w = PART.test(k) ? named.get(k) : store.wayById.get(Number(k));
      if (!w) continue;
      if (store.ways.includes(w)) out.push(w);
      else for (const p of store.ways) if ((p.of ?? p.id) === w.id) out.push(p); // (a way that was split: its parts)
    }
    return out;
  };
  const sides = [resolve(spec.a), resolve(spec.b)];
  if (sides.some((s) => s.length === 0)) return { name: spec.name, way: null, why: 'carriageway not found' };

  // cut each carriageway where the stretch begins and ends
  const ends: number[][] = [];
  for (let k = 0; k < 2; k++) {
    let ways = sides[k];
    const cut: number[] = [];
    for (const [e, p] of [spec.from, spec.to].entries()) {
      // the way of this carriageway passing nearest
      let best: OWay | null = null;
      let bd = Infinity;
      for (const w of ways) {
        const n = nearestOn(store, w.refs, p[0], p[1]);
        if (n && n.d < bd) {
          bd = n.d;
          best = w;
        }
      }
      if (!best || bd > 40) return { name: spec.name, way: null, why: 'stretch end far from carriageway' };
      const tag = `${spec.name}/${k}/${e}`;
      const parts = splitWay(store, best, [p], tag);
      ways = ways.flatMap((w) => (w === best ? parts : [w]));
      // the node at the cut: the end of a part nearest to p (or the way's end)
      let node = -1;
      let nd = Infinity;
      for (const w of parts) {
        for (const id of [w.refs[0], w.refs[w.refs.length - 1]]) {
          const n = store.nodes.get(id);
          if (!n) continue;
          const d = Math.hypot(n.x - p[0], n.z - p[1]);
          if (d < nd) {
            nd = d;
            node = id;
          }
        }
      }
      cut.push(node);
    }
    sides[k] = ways;
    ends.push(cut);
  }
  const chains = [chainBetween(sides[0], ends[0][0], ends[0][1]), chainBetween(sides[1], ends[1][0], ends[1][1])];
  if (!chains[0] || !chains[1]) return { name: spec.name, way: null, why: 'no chain between the stretch ends' };
  const [ca, cb] = chains as Array<{ ids: number[]; ways: OWay[] }>;

  // the line along the middle: both carriageways at the same fraction of their length
  const pa = chainPts(store, ca.ids);
  const pb = chainPts(store, cb.ids);
  const len = Math.max(lengthOf(pa), lengthOf(pb));
  const m = Math.max(2, Math.ceil(len / 4)) + 1;
  const mid: number[] = [];
  for (let i = 0; i < m; i++) {
    const a = along(pa, i / (m - 1));
    const b = along(pb, i / (m - 1));
    mid.push((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }

  // the carriageways go; what else used their nodes keeps them, moved onto the middle line
  const gone = new Set<OWay>([...ca.ways, ...cb.ways]);
  const template = ca.ways[0];
  for (const w of gone) {
    const i = store.ways.indexOf(w);
    if (i >= 0) store.ways.splice(i, 1);
    if (store.wayById.get(w.id) === w) store.wayById.delete(w.id);
  }
  const usedElsewhere = new Set<number>();
  for (const w of store.ways) for (const r of w.refs) usedElsewhere.add(r);

  // the ends: one node each, where both carriageways now meet the new way
  const endNode = (ia: number, ib: number, at: number): number => {
    const keep = ia;
    const n = store.nodes.get(keep)!;
    n.x = mid[at * 2];
    n.z = mid[at * 2 + 1];
    if (ib !== ia) for (const w of store.ways) for (let i = 0; i < w.refs.length; i++) if (w.refs[i] === ib) w.refs[i] = keep;
    return keep;
  };
  const first = endNode(ca.ids[0], cb.ids[0], 0);
  const last = endNode(ca.ids[ca.ids.length - 1], cb.ids[cb.ids.length - 1], m - 1);

  const kept: Array<{ s: number; id: number }> = [];
  for (const id of [...ca.ids.slice(1, -1), ...cb.ids.slice(1, -1)]) {
    const n = store.nodes.get(id);
    if (!n || id === first || id === last) continue;
    if (!usedElsewhere.has(id) && !n.tags) continue;
    if (kept.some((k) => k.id === id)) continue;
    const f = project(mid, n.x, n.z);
    n.x = f.x;
    n.z = f.z;
    kept.push({ s: f.s, id });
  }
  let acc = 0;
  for (let i = 1; i < m - 1; i++) {
    acc += Math.hypot(mid[i * 2] - mid[i * 2 - 2], mid[i * 2 + 1] - mid[i * 2 - 1]);
    if (kept.some((k) => Math.abs(k.s - acc) < 2)) continue;
    const id = editNodeId(`${spec.name}#${i}`);
    store.nodes.set(id, { id, x: mid[i * 2], z: mid[i * 2 + 1], tags: null });
    kept.push({ s: acc, id });
  }
  kept.sort((p, q) => p.s - q.s);

  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(template.tags)) if (!ONE_WAY_KEYS.test(k)) tags[k] = v;
  for (const [k, v] of Object.entries(spec.tags)) {
    if (v === null) delete tags[k];
    else tags[k] = v;
  }
  // (as wide as both carriageways were together, unless the list says how wide: one way's width is not the road's)
  if (!Object.hasOwn(spec.tags, 'width')) {
    const w = mergedWidth(pa, pb, ca.ways[0].tags, cb.ways[0].tags);
    if (w > 0) tags.width = String(w);
    else delete tags.width;
  }
  // (marked as merged: where its carriageways leave it is no split of a road – no island there, mapgen/islands.ts)
  tags[MERGED_KEY] = spec.name;
  const way: OWay = { id: freshWayId(store, `merge:${spec.name}`), refs: [first, ...kept.map((k) => k.id), last], tags };
  store.ways.push(way);
  store.wayById.set(way.id, way);
  return { name: spec.name, way };
}

/** The width (m) of one carriageway as its tags say: `width`, else its lanes at 3.25 m (NaN: unknown). */
function carriagewayWidth(t: Readonly<Record<string, string>>): number {
  const w = Number.parseFloat(t.width ?? '');
  if (w >= 2.5 && w <= 20) return w;
  const n = Number.parseInt(t.lanes ?? '1', 10);
  return (n >= 1 && n <= 6 ? n : 1) * 3.25;
}

/**
 * The width of the one road two merged carriageways become: how far apart
 * their centrelines run (the median of samples along the stretch) plus half
 * of each carriageway – so that the new road covers both, rounded to 0.5 m.
 * 0 where they lie on top of each other (less than 2 m apart).
 */
export function mergedWidth(pa: readonly number[], pb: readonly number[], ta: Readonly<Record<string, string>>, tb: Readonly<Record<string, string>>): number {
  const ds: number[] = [];
  for (let i = 1; i < 12; i++) {
    const [x, z] = along(pa, i / 12);
    const f = project(pb, x, z);
    ds.push(Math.hypot(f.x - x, f.z - z));
  }
  ds.sort((p, q) => p - q);
  const sep = ds[ds.length >> 1];
  if (!(sep >= 2)) return 0;
  const w = sep + (carriagewayWidth(ta) + carriagewayWidth(tb)) / 2;
  return Math.round(Math.min(30, w) * 2) / 2;
}

/** Roads a point may be put into (not paths, not areas). */
const DRIVEN = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$|^(unclassified|residential|living_street|service|track|road|busway)$/;

/** Put the tagged points of the list into their roads (the node, or null where no road is near). */
export function applyPoints(store: WayStore, points: readonly PointSpec[], named: ReadonlyMap<string, OWay> = new Map()): Array<number | null> {
  return points.map((q) => {
    let host: OWay | null = null;
    if (q.way) {
      const w = PART.test(q.way) ? named.get(q.way) : store.wayById.get(Number(q.way));
      // (a way that was cut: the part nearest the point)
      const cands = w && store.ways.includes(w) ? [w] : store.ways.filter((p) => w && (p.of ?? p.id) === w.id);
      let bd = Infinity;
      for (const c of cands) {
        const n = nearestOn(store, c.refs, q.x, q.z);
        if (n && n.d < bd) {
          bd = n.d;
          host = c;
        }
      }
    } else {
      let bd = 10;
      for (const w of store.ways) {
        if (!DRIVEN.test(w.tags.highway ?? '') || w.tags.area === 'yes') continue;
        const n = nearestOn(store, w.refs, q.x, q.z);
        if (n && n.d < bd) {
          bd = n.d;
          host = w;
        }
      }
    }
    if (!host) return null;
    const i = cutPoint(store, host.refs, q.x, q.z, `point:${q.name}`, 0.3);
    if (i < 0) return null;
    const node = store.nodes.get(host.refs[i])!;
    node.tags = { ...(node.tags ?? {}), ...q.tags };
    return node.id;
  });
}

/** Apply all splits, points and merges of the list to an extract (OsmData.load). */
export function applyWayEdits(store: WayStore, edits: WayEdits = wayEdits()): MergeResult[] {
  const named = applySplits(store, edits);
  const res = edits.merges.map((m) => mergePair(store, m, named));
  applyPoints(store, edits.points, named);
  return res;
}
