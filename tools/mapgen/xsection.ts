// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OpenStreetMap's tags → the cross-section of a road beyond its lanes
 * (src/world/xsection.ts): parking, pavements, kerbs, verges, cycle lanes
 * and tracks, medians.
 *
 * Tags read, per side (<side> = left | right | both, as seen along the way;
 * a side's own key wins over both):
 *
 *   parking:<side>              lane | street_side | half_on_kerb | on_kerb | shoulder | no | separate
 *                               (yes, on_street: lane)
 *   parking:<side>:orientation  parallel | diagonal | perpendicular            (default parallel)
 *   parking:<side>:markings     yes | no – bay lines are painted   (default: yes for street_side, else no)
 *   parking:<side>:width        depth of the strip across the road (m)
 *   parking:<side>:occupancy    <0…1> | <n>% | low (15 %) | high (90 %) | none – OUR OWN key: how many bays
 *                               have a car in them (default 60–80 %; low where cars stand only now and then)
 *   parking:lane:<side>[:<orientation>]   the older scheme, read when the new one says nothing
 *   sidewalk[:<side>]           yes | both | left | right | no | separate
 *   sidewalk:<side>:width       width of the pavement (m)        (also sidewalk:width)
 *   kerb[:<side>]               raised | regular | lowered | rolled | flush | no
 *   verge:<side>                grass | <width in m> | no – OUR OWN key: a grass strip between
 *                               kerb and pavement (grass: 1.5 m)
 *   cycleway[:<side>]           lane | track (opposite_lane, opposite_track: on the left of a one-way road)
 *   cycleway[:<side>]:width     (lane default 1.5 m, track 1.6 m)
 *   cycleway[:<side>]:lane      advisory (dashed line) | exclusive (solid)  (default: exclusive with
 *                               traffic_sign DE:237, else advisory)
 *   cycleway[:<side>]:surface:colour   red (anything else: none)
 *   cycleway[:<side>]:surface   paving_stones … (a track's surface)
 *   verge:<side>                … also paving_stones (a paved strip), combinable with ";trees" (young
 *                               trees in it); verge:<side>:width
 *   median:contents             grass | parking | hedge | trees | paving_stones, combinable with ";" – OUR
 *                               OWN key: on a one-way carriageway of a dual road, what lies on its left
 *                               between it and the other carriageway
 *   gutter[:<side>]             no | yes | <width in m> – OUR OWN key: the paved gutter (Rinne) between
 *                               asphalt and kerb (default: 0.4 m in towns where there is a raised kerb)
 *   lane_markings:edge          yes | no | left | right | both – OUR OWN key: painted edge lines
 *                               (default: on marked roads outside towns and on motorways)
 *   parking:<side>:trees        <every n m> | yes (20 m) – OUR OWN key: a kerbed tree bulb in place of
 *                               a parking bay (also wherever OSM has a natural=tree in the strip)
 *   frontage:<side>             hedge | fence | wall | lawn – OUR OWN key: right behind the pavement;
 *                               frontage:<side>:height (default hedge 1.2, fence 1.2, wall 1.0)
 *
 * Where OpenStreetMap maps the pavement as a way of its own (footway=sidewalk)
 * beside a road whose pavement is `separate` – or not tagged at all –, the
 * road's pavement is made to reach to that way, with a verge between where
 * there is room (`besideFootways`): one pavement where the street has one,
 * not two.
 */
import { CYCLE, FRONT, KERB, MEDIAN, ORIENT, PARK, medianBits, parkDepth } from '../../src/world/xsection.ts';
import type { RoadSideJson } from '../../src/world/xsection.ts';
import { GM } from '../../src/world/tilefmt.ts';
import type { OsmData, Tags } from './osm.ts';

export { MEDIAN };

function num(v: string | undefined): number {
  if (v === undefined) return NaN;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(m|cm)?\s*$/.exec(v);
  if (!m) return NaN;
  const n = Number(m[1].replace(',', '.'));
  return m[2] === 'cm' ? n / 100 : n;
}

/** The value of a side's key: its own, else the one for both sides, else (when `plain`) the key without a side. */
function sided(tags: Tags, prefix: string, side: 'left' | 'right', suffix = '', plain = false): string | undefined {
  return tags[`${prefix}:${side}${suffix}`] ?? tags[`${prefix}:both${suffix}`] ?? (plain ? tags[`${prefix}${suffix}`] : undefined);
}

const PARK_KINDS: Record<string, number> = {
  lane: PARK.LANE,
  yes: PARK.LANE,
  on_street: PARK.LANE,
  street_side: PARK.STREET_SIDE,
  lay_by: PARK.STREET_SIDE,
  half_on_kerb: PARK.HALF_ON_KERB,
  on_kerb: PARK.ON_KERB,
  shoulder: PARK.SHOULDER,
};
const ORIENTS: Record<string, number> = { parallel: ORIENT.PARALLEL, diagonal: ORIENT.DIAGONAL, perpendicular: ORIENT.PERPENDICULAR };

/** What a pavement side says: present with a width, absent, or separate (mapped as a way of its own), or nothing said. */
export interface WalkSide {
  /** true: there is one; false: none; null: not tagged */
  has: boolean | null;
  separate: boolean;
  /** tagged width (m), NaN when not tagged */
  width: number;
}

/** One side of a road, as the tags say (left/right along the way as mapped). */
export interface TaggedSide {
  side: RoadSideJson;
  walk: WalkSide;
  /** verge explicitly tagged (also "no") */
  vergeTagged: boolean;
}

/** Parking of one side, from the current scheme or the older parking:lane one. */
function parkingOf(tags: Tags, side: 'left' | 'right', out: RoadSideJson): void {
  let kind = 0;
  let orient = NaN;
  const v = sided(tags, 'parking', side);
  if (v !== undefined) kind = PARK_KINDS[v] ?? 0;
  const o = sided(tags, 'parking', side, ':orientation');
  if (o !== undefined && ORIENTS[o] !== undefined) orient = ORIENTS[o];
  let markedOld = false;
  if (v === undefined) {
    // parking:lane:<side>=parallel|diagonal|perpendicular|marked, parking:lane:<side>:<orientation>=on_street|half_on_kerb|…
    const old = sided(tags, 'parking:lane', side);
    if (old !== undefined && (ORIENTS[old] !== undefined || old === 'marked')) {
      orient = ORIENTS[old] ?? ORIENT.PARALLEL;
      markedOld = old === 'marked';
      const name = Object.keys(ORIENTS).find((k) => ORIENTS[k] === orient) as string;
      const pos = sided(tags, 'parking:lane', side, `:${name}`) ?? 'on_street';
      kind = pos === 'painted_area_only' ? PARK.LANE : (PARK_KINDS[pos] ?? PARK.LANE);
    }
  }
  if (!kind) return;
  out.p = kind;
  if (!Number.isNaN(orient) && orient !== ORIENT.PARALLEL) out.po = orient;
  const w = num(sided(tags, 'parking', side, ':width'));
  if (w >= 1.5 && w <= 7) out.pw = w;
  const m = sided(tags, 'parking', side, ':markings');
  const marked = m === undefined ? markedOld || kind === PARK.STREET_SIDE : m === 'yes';
  if (marked) out.pm = 1;
  // parking:<side>:occupancy = <0…1> | low | high (OUR OWN key): how many of the bays have a car in them
  const q = sided(tags, 'parking', side, ':occupancy');
  const share = q === 'low' ? 0.15 : q === 'high' ? 0.9 : q === 'none' ? 0 : num(q?.replace('%', '') ?? '') / (q?.endsWith('%') ? 100 : 1);
  if (share >= 0 && share <= 1) out.pq = Math.round(share * 100) / 100;
}

/** Cycle lane or track of one side. `oneway`: the road is one-way (along the way as mapped, `reversed`: against it). */
function cycleOf(tags: Tags, side: 'left' | 'right', oneway: boolean, reversed: boolean, out: RoadSideJson): void {
  let v = sided(tags, 'cycleway', side);
  let key = v !== undefined ? (tags[`cycleway:${side}`] !== undefined ? `cycleway:${side}` : 'cycleway:both') : '';
  if (v === undefined && tags.cycleway !== undefined) {
    // the key without a side: both sides of a two-way road, the right of a one-way one (in its direction);
    // opposite_*: the left of a one-way road
    const plain = tags.cycleway;
    const driveRight = reversed ? 'left' : 'right';
    const opposite = plain.startsWith('opposite_');
    const applies = !oneway || (opposite ? side !== driveRight : side === driveRight);
    if (applies) {
      v = opposite ? plain.slice('opposite_'.length) : plain;
      key = 'cycleway';
    }
  }
  if (v !== 'lane' && v !== 'track') return;
  out.c = v === 'lane' ? CYCLE.LANE : CYCLE.TRACK;
  const sub = (suffix: string): string | undefined => tags[`${key}${suffix}`] ?? sided(tags, 'cycleway', side, suffix, true);
  const w = num(sub(':width'));
  if (w >= 0.8 && w <= 4) out.cw = w;
  const colour = sub(':surface:colour');
  if (colour !== undefined && /^(red|#[a-f0-9]{6})$/i.test(colour) && (colour === 'red' || parseInt(colour.slice(1, 3), 16) > 140)) out.cr = 1;
  if (out.c === CYCLE.LANE) {
    const lane = sub(':lane');
    const sign = `${sub(':traffic_sign') ?? ''}`;
    const exclusive = lane === 'exclusive' || (lane === undefined && /237/.test(sign));
    if (!exclusive) out.ca = 1;
  } else {
    const surface = sub(':surface');
    if (surface && /paving_stones|sett|bricks|concrete:plates/.test(surface)) out.cs = 1;
  }
}

function kerbOf(tags: Tags, side: 'left' | 'right', out: RoadSideJson): void {
  const v = sided(tags, 'kerb', side, '', true);
  if (v === undefined) return;
  if (v === 'lowered' || v === 'rolled' || v === 'low') out.k = KERB.LOWERED;
  else if (v === 'flush' || v === 'no' || v === 'none') out.k = KERB.FLUSH;
}

function vergeOf(tags: Tags, side: 'left' | 'right', out: RoadSideJson): boolean {
  const v = sided(tags, 'verge', side, '', true);
  if (v === undefined) return false;
  // grass | paving_stones | <width>, with ";trees" (young trees in it)
  let kind = '';
  let width = num(sided(tags, 'verge', side, ':width', true));
  for (const part of v.split(';')) {
    const p = part.trim().toLowerCase();
    if (p === 'trees' || p === 'tree') out.vt = 1;
    else if (p === 'grass' || p === 'yes') kind = kind || 'grass';
    else if (p === 'paving_stones' || p === 'paved' || p === 'sett' || p === 'cobblestone') kind = 'paved';
    else if (!Number.isNaN(num(p))) width = num(p);
  }
  if (kind === '' && Number.isNaN(width) && !out.vt) return true; // "no"
  if (!(width > 0 && width <= 20)) width = 1.5;
  out.v = width;
  if (kind === 'paved') out.vp = 1;
  return true;
}

/** gutter[:<side>] = no | yes | <width>: the paved gutter along the kerb (OUR OWN key). */
function gutterOf(tags: Tags, side: 'left' | 'right', out: RoadSideJson): void {
  const v = sided(tags, 'gutter', side, '', true);
  if (v === undefined) return;
  if (v === 'no' || v === 'none') out.g = 0;
  else if (v === 'yes') out.g = 0.4;
  else {
    const w = num(v);
    if (w >= 0 && w <= 1.5) out.g = w;
  }
}

/** lane_markings:edge = yes | no | left | right | both: painted edge lines (OUR OWN key). */
function edgeLineOf(tags: Tags, side: 'left' | 'right', out: RoadSideJson): void {
  const v = tags[`lane_markings:edge:${side}`] ?? tags['lane_markings:edge'];
  if (v === undefined) return;
  if (v === 'yes' || v === 'both' || v === side) out.el = 1;
  else if (v === 'no' || v === 'none' || v === 'left' || v === 'right') out.el = 0;
}

const FRONTS: Record<string, number> = { hedge: FRONT.HEDGE, fence: FRONT.FENCE, wall: FRONT.WALL, lawn: FRONT.LAWN, garden: FRONT.LAWN };

/** frontage:<side> = hedge | fence | wall | lawn, frontage:<side>:height: right behind the pavement (OUR OWN key). */
function frontageOf(tags: Tags, side: 'left' | 'right', out: RoadSideJson): void {
  const v = sided(tags, 'frontage', side, '', true);
  const f = v === undefined ? undefined : FRONTS[v];
  if (!f) return;
  out.ft = f;
  const h = num(sided(tags, 'frontage', side, ':height', true));
  if (h >= 0.3 && h <= 6) out.fh = h;
  const o = num(sided(tags, 'frontage', side, ':offset', true));
  if (o >= 0 && o <= 10) out.fo = o;
}

/** parking:<side>:trees = <every n m> | yes: kerbed tree bulbs in the parking strip (OUR OWN key). */
function bulbsOf(tags: Tags, side: 'left' | 'right', out: RoadSideJson): void {
  if (!out.p) return;
  const v = sided(tags, 'parking', side, ':trees');
  if (v === undefined) return;
  const n = v === 'yes' ? 20 : num(v);
  if (n >= 6 && n <= 200) out.pt = n;
}

/**
 * sidewalk:<side>:surface = asphalt | paving_stones | concrete | sett …, sidewalk:<side>:colour = grey | red |
 * anthracite (OUR OWN key): what the pavement is made of – as a ground material (src/world/tilefmt.ts GM).
 * Red pavers are drawn in the red of cycle tracks, anthracite ones as dark setts (the materials older
 * versions of the game know).
 */
export function walkMaterial(surface: string | undefined, colour: string | undefined): number | undefined {
  const c = colour?.toLowerCase();
  const red = c === 'red' || c === 'red-brown' || c === 'brown' || c === 'reddish';
  const dark = c === 'anthracite' || c === 'dark_grey' || c === 'darkgrey' || c === 'black';
  if (surface === undefined && c === undefined) return undefined;
  const s = surface ?? 'paving_stones';
  // (asphalt as the asphalt paths are drawn – not the carriageway's, so that the pavement does not read as road)
  if (/^asphalt|chipseal/.test(s)) return red ? GM.CYCLE : GM.ASPHALT_OLD;
  if (/^concrete/.test(s)) return red ? GM.CYCLE : GM.CONCRETE;
  if (/sett|cobblestone/.test(s)) return red ? GM.CYCLE : GM.SETT;
  if (/gravel|compacted/.test(s)) return GM.GRAVEL;
  if (/paving_stones|paved|bricks?|pavers?/.test(s)) return red ? GM.CYCLE : dark ? GM.SETT : GM.PAVING;
  return undefined;
}

function walkMaterialOf(tags: Tags, side: 'left' | 'right', out: RoadSideJson): void {
  const m = walkMaterial(sided(tags, 'sidewalk', side, ':surface', true), sided(tags, 'sidewalk', side, ':colour', true));
  if (m !== undefined && m !== GM.SIDEWALK) out.wm = m;
}

function walkOf(tags: Tags, side: 'left' | 'right'): WalkSide {
  const explicit = tags[`sidewalk:${side}`] ?? tags['sidewalk:both'];
  const general = tags.sidewalk;
  let has: boolean | null = null;
  let separate = false;
  if (explicit !== undefined) {
    has = explicit === 'yes';
    separate = explicit === 'separate';
  } else if (general !== undefined) {
    if (general === 'both' || general === 'yes') has = true;
    else if (general === 'left' || general === 'right') has = general === side;
    else {
      has = false; // no / none / separate
      separate = general === 'separate';
    }
  }
  const width = num(tags[`sidewalk:${side}:width`] ?? tags['sidewalk:both:width'] ?? tags['sidewalk:width']);
  return { has, separate, width: width >= 0.5 && width <= 12 ? width : NaN };
}

/** One side of a way as its tags say it (`side` as seen along the way as mapped). */
export function taggedSide(tags: Tags, side: 'left' | 'right', oneway: boolean, reversed: boolean): TaggedSide {
  const s: RoadSideJson = {};
  parkingOf(tags, side, s);
  cycleOf(tags, side, oneway, reversed, s);
  kerbOf(tags, side, s);
  const vergeTagged = vergeOf(tags, side, s);
  gutterOf(tags, side, s);
  edgeLineOf(tags, side, s);
  frontageOf(tags, side, s);
  bulbsOf(tags, side, s);
  walkMaterialOf(tags, side, s);
  return { side: s, walk: walkOf(tags, side), vergeTagged };
}

/** Both sides, as seen along the direction the road is stored in (`reversed`: against the way as mapped). */
export function taggedSides(tags: Tags, oneway: boolean, reversed: boolean): { left: TaggedSide; right: TaggedSide; median: number } {
  const l = taggedSide(tags, 'left', oneway, reversed);
  const r = taggedSide(tags, 'right', oneway, reversed);
  return { left: reversed ? r : l, right: reversed ? l : r, median: medianBits(tags['median:contents']) };
}

export { parkDepth };

// ---------------------------------------------------------------------------
// separate pavements beside a road

/** A way of footway=sidewalk, in pieces, on a grid. */
export class FootwayIndex {
  private readonly cell = 32;
  private readonly grid = new Map<number, number[]>();
  /** x1, z1, x2, z2, width, material (GM, −1: none said) per piece */
  private readonly segs: number[] = [];
  count = 0;

  /** `bridges`: instead of the ways of footway=sidewalk, the footway, cycleway and path bridges (beside a road bridge they are its walkways) */
  constructor(osm: OsmData, bridges = false) {
    for (const w of osm.ways) {
      const t = w.tags;
      if (!(t.highway === 'footway' || t.highway === 'path' || t.highway === 'cycleway')) continue;
      if (bridges ? !t.bridge || t.bridge === 'no' : t.footway !== 'sidewalk') continue;
      const c = osm.wayCoords(w);
      if (c.length < 4) continue;
      const width = num(t.width);
      const fw = width >= 0.8 && width <= 8 ? width : 2.0;
      // (what it is made of, as the road's own pavement would be drawn: its surface, else asphalt for a cycle path)
      const mat = walkMaterial(t.surface ?? (t.highway === 'cycleway' || t.bicycle === 'designated' ? 'asphalt' : undefined), t.colour ?? t['surface:colour']);
      this.count++;
      for (let i = 0; i + 3 < c.length; i += 2) this.add(c[i], c[i + 1], c[i + 2], c[i + 3], fw, mat ?? -1);
    }
  }

  private key(ix: number, iz: number): number {
    return (ix + 32768) * 65536 + (iz + 32768);
  }

  private add(x1: number, z1: number, x2: number, z2: number, w: number, mat: number): void {
    const id = this.segs.length / 6;
    this.segs.push(x1, z1, x2, z2, w, mat);
    const c = this.cell;
    for (let ix = Math.floor(Math.min(x1, x2) / c); ix <= Math.floor(Math.max(x1, x2) / c); ix++) {
      for (let iz = Math.floor(Math.min(z1, z2) / c); iz <= Math.floor(Math.max(z1, z2) / c); iz++) {
        const k = this.key(ix, iz);
        const list = this.grid.get(k);
        if (list) list.push(id);
        else this.grid.set(k, [id]);
      }
    }
  }

  /**
   * Along the ray from (x, z) in direction (nx, nz), up to `reach` metres: the
   * nearest piece of sidewalk that runs along (tx, tz) (either way).  Returns
   * the distance, its width and material (−1: none said), or null.
   */
  cast(x: number, z: number, nx: number, nz: number, tx: number, tz: number, reach: number): { d: number; w: number; m: number } | null {
    const c = this.cell;
    const ex = x + nx * reach;
    const ez = z + nz * reach;
    let best: { d: number; w: number; m: number } | null = null;
    const seen = new Set<number>();
    for (let ix = Math.floor(Math.min(x, ex) / c); ix <= Math.floor(Math.max(x, ex) / c); ix++) {
      for (let iz = Math.floor(Math.min(z, ez) / c); iz <= Math.floor(Math.max(z, ez) / c); iz++) {
        for (const id of this.grid.get(this.key(ix, iz)) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const s = this.segs;
          const ax = s[id * 6];
          const az = s[id * 6 + 1];
          const dx = s[id * 6 + 2] - ax;
          const dz = s[id * 6 + 3] - az;
          const l = Math.hypot(dx, dz);
          if (l < 0.3) continue;
          // runs along the road?
          if (Math.abs((dx * tx + dz * tz) / l) < 0.85) continue;
          // ray (x,z)+t·n against the piece a + u·d
          const den = nx * dz - nz * dx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((ax - x) * dz - (az - z) * dx) / den;
          const u = ((ax - x) * nz - (az - z) * nx) / den;
          if (t < 0 || t > reach || u < -0.02 || u > 1.02) continue;
          if (!best || t < best.d) best = { d: t, w: s[id * 6 + 4], m: s[id * 6 + 5] };
        }
      }
    }
    return best;
  }
}

/** What a measured separate pavement gives one side: the width beyond the kerb and the verge before the pavement. */
export interface MeasuredWalk {
  beyond: number;
  verge: number;
  /** what the separate pavement is made of (GM), where most of it says so */
  mat?: number;
}

/**
 * Where a separate pavement runs beside one side of a road: measured across
 * the road every 5 m along its centreline (flat x, z points), from the
 * kerb at `half`.  Null when it runs beside less than half of the road or
 * not within `reach` metres of the kerb.
 */
export function measureSeparateWalk(index: FootwayIndex, pts: number[], half: number, left: boolean, reach = 12): MeasuredWalk | null {
  const ds: number[] = [];
  const ws: number[] = [];
  const mats = new Map<number, number>();
  let samples = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i];
    const az = pts[i + 1];
    const dx = pts[i + 2] - ax;
    const dz = pts[i + 3] - az;
    const l = Math.hypot(dx, dz);
    if (l < 0.5) continue;
    const tx = dx / l;
    const tz = dz / l;
    // left of the direction (tx, tz) in this frame (x east, z south) is (tz, -tx)
    const nx = left ? tz : -tz;
    const nz = left ? -tx : tx;
    const n = Math.max(1, Math.floor(l / 5));
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      samples++;
      const hit = index.cast(ax + dx * f, az + dz * f, nx, nz, tx, tz, half + reach);
      if (hit && hit.d > half * 0.6) {
        ds.push(hit.d);
        ws.push(hit.w);
        mats.set(hit.m, (mats.get(hit.m) ?? 0) + 1);
      }
    }
  }
  if (samples === 0 || ds.length * 2 < samples) return null;
  ds.sort((a, b) => a - b);
  ws.sort((a, b) => a - b);
  const d = ds[ds.length >> 1];
  const w = ws[ws.length >> 1];
  const inner = d - w / 2 - half;
  const beyond = Math.max(1.2, d + w / 2 - half);
  let mat = -1;
  let most = 0;
  for (const [m, n] of mats) if (n > most) [mat, most] = [m, n];
  return { beyond: Math.round(beyond * 100) / 100, verge: inner >= 0.5 ? Math.round(inner * 100) / 100 : 0, ...(mat >= 0 ? { mat } : {}) };
}
