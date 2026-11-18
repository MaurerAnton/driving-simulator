// SPDX-License-Identifier: AGPL-3.0-only
/** Loads the JSON extract written by tools/osm-extract.ts and projects it into world space. */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { latLonToWorld } from '../../src/geo/utm.ts';
import { additions, addedNodeId, correctTags, findJoin, geometryCorrections, hasGeometryCorrections, networkKind, nodeShifts, roadCorrections } from './observedroads.ts';
import type { Additions, GeometryCorrections } from './observedroads.ts';
import { applyWayEdits, hasWayEdits, wayEdits } from './waysplit.ts';
import type { WayEdits } from './waysplit.ts';
import { areaInDetail, hasDetail, inDetail, lineInDetail } from './detailregion.ts';

export type Tags = Record<string, string>;

export interface ONode {
  id: number;
  x: number;
  z: number;
  tags: Tags | null;
}

export interface OWay {
  id: number;
  refs: number[];
  tags: Tags;
  /** a part of a way cut by tools/mapgen/observed-roads.json: the OpenStreetMap way it was cut from (waysplit.ts) */
  of?: number;
}

export interface OMember {
  type: 'n' | 'w' | 'r';
  ref: number;
  role: string;
}

export interface ORelation {
  id: number;
  members: OMember[];
  tags: Tags;
}

export class OsmData {
  readonly nodes = new Map<number, ONode>();
  readonly ways: OWay[] = [];
  readonly wayById = new Map<number, OWay>();
  readonly relations: ORelation[] = [];
  extractedAt = '';
  /** the ways applyObserved() changed, added or left out (by their OpenStreetMap or list ids) */
  readonly observedWays = new Set<number>();

  /**
   * Read an extract written by tools/osm-extract.ts (gzipped or not).  Its
   * nodes are [id, x, z, tags?] in world coordinates, or – extracts of older
   * builds – [id, lat, lon, tags?].
   */
  static load(path: string, opts: { observed?: boolean } = {}): OsmData {
    const bytes = readFileSync(path);
    const raw = JSON.parse((path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8')) as {
      meta: { extractedAt: string; world?: boolean };
      nodes: Array<[number, number, number, Tags?]>;
      ways: OWay[];
      relations: ORelation[];
    };
    const d = new OsmData();
    d.extractedAt = raw.meta.extractedAt;
    const world = raw.meta.world === true;
    for (const n of raw.nodes) {
      const [x, z] = world ? [n[1], n[2]] : latLonToWorld(n[1], n[2]);
      d.nodes.set(n[0], { id: n[0], x, z, tags: n[3] ?? null });
    }
    for (const w of raw.ways) {
      d.ways.push(w);
      d.wayById.set(w.id, w);
    }
    for (const r of raw.relations) d.relations.push(r);
    // (what was seen on site, in the detail region: tools/mapgen/observed-roads.json, mapgen/detailregion.ts)
    if (opts.observed !== false) d.applyObserved();
    return d;
  }

  /**
   * Apply what was seen on site (tools/mapgen/observed-roads.json): tags
   * over the mapped ones, ways that are not there left out, nodes moved,
   * areas and ways added, ways cut, carriageways merged, tagged points put
   * into roads – each only where it lies in the detail region
   * (mapgen/detailregion.ts: by the point halfway along a way, the middle of
   * an area, the place of a node or a cut); outside it the map stays as the
   * published one was built.  The ways it changed: `observedWays`.
   */
  applyObserved(): void {
    if (!hasDetail()) return;
    const wayIn = (w: OWay): boolean => lineInDetail(this.wayCoords(w));
    const idIn = (id: number): boolean => {
      const w = this.wayById.get(id);
      return w !== undefined && wayIn(w);
    };
    // (what was seen on site goes over the mapped tags)
    const fixes = roadCorrections();
    const all = additions();
    const extra: Additions = { ways: all.ways.filter((a) => (a.closed ? areaInDetail(a.pts) : lineInDetail(a.pts))), remove: new Set([...all.remove].filter(idIn)) };
    if (extra.remove.size) {
      const kept = this.ways.filter((w) => !extra.remove.has(w.id));
      this.ways.length = 0;
      this.ways.push(...kept);
      for (const id of extra.remove) {
        this.wayById.delete(id);
        this.observedWays.add(id);
      }
    }
    for (const w of this.ways) {
      const fix = fixes.get(w.id);
      if (!fix || !wayIn(w)) continue;
      w.tags = correctTags(w.tags, fix);
      this.observedWays.add(w.id);
    }
    // (and where ways lie off the road: their nodes moved – the extracts keep them as mapped)
    const allGeo = geometryCorrections();
    const geo: GeometryCorrections = { ways: new Map([...allGeo.ways].filter(([id]) => idIn(id))), nodes: new Map() };
    for (const [id, sh] of allGeo.nodes) {
      const n = this.nodes.get(id);
      if (n && inDetail(n.x, n.z)) geo.nodes.set(id, sh);
    }
    if (hasGeometryCorrections(geo)) {
      const moved = new Set<number>();
      for (const [id, [dx, dz]] of nodeShifts(this.ways, geo)) {
        const n = this.nodes.get(id);
        if (!n) continue;
        n.x += dx;
        n.z += dz;
        moved.add(id);
      }
      for (const w of this.ways) if (w.refs.some((r) => moved.has(r))) this.observedWays.add(w.id);
    }
    // (and what is there but not mapped: areas and ways of the list, joined to the network where they say so)
    if (extra.ways.length) {
      const before = new Map(this.ways.map((w) => [w.id, w.refs.length]));
      this.addObserved(extra);
      for (const w of this.ways) if (before.get(w.id) !== w.refs.length) this.observedWays.add(w.id);
    }
    // (and ways cut where their tags change along them, pairs of carriageways that are one road: waysplit.ts)
    const allEdits = wayEdits();
    const baseIn = (key: string): boolean => idIn(Number(key.split(':')[0]));
    const edits: WayEdits = {
      points: allEdits.points.filter((q) => inDetail(q.x, q.z)),
      splits: allEdits.splits.filter((q) => inDetail(q.x, q.z)),
      parts: new Map([...allEdits.parts].filter(([key]) => baseIn(key))),
      removeParts: new Set([...allEdits.removeParts].filter(baseIn)),
      merges: allEdits.merges.filter((m) => inDetail((m.from[0] + m.to[0]) / 2, (m.from[1] + m.to[1]) / 2)),
    };
    if (hasWayEdits(edits)) {
      const before = new Map(this.ways.map((w) => [w.id, `${w.refs.join(',')}|${JSON.stringify(w.tags)}`]));
      for (const r of applyWayEdits(this, edits)) if (!r.way) console.warn(`observed-roads.json: merge ${r.name} not done (${r.why})`);
      const after = new Set<number>();
      for (const w of this.ways) {
        after.add(w.id);
        if (before.get(w.id) !== `${w.refs.join(',')}|${JSON.stringify(w.tags)}`) this.observedWays.add(w.of ?? w.id);
      }
      for (const id of before.keys()) if (!after.has(id)) this.observedWays.add(id);
    }
  }

  /**
   * A copy of the ways that reach into `r` and of the ways that share a node
   * with them, with their nodes and the relations they are in – each thing
   * copied, so that applyObserved() on the copy leaves this one as it is
   * (mapgen/detailgraph.ts).
   */
  localCopy(r: { minX: number; minZ: number; maxX: number; maxZ: number }): OsmData {
    const first = new Set<OWay>();
    for (const w of this.ways) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const id of w.refs) {
        const n = this.nodes.get(id);
        if (!n) continue;
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.z < minZ) minZ = n.z;
        if (n.z > maxZ) maxZ = n.z;
      }
      if (maxX >= r.minX && minX <= r.maxX && maxZ >= r.minZ && minZ <= r.maxZ) first.add(w);
    }
    const firstNodes = new Set<number>();
    for (const w of first) for (const id of w.refs) firstNodes.add(id);
    const d = new OsmData();
    d.extractedAt = this.extractedAt;
    for (const w of this.ways) {
      if (!first.has(w) && !w.refs.some((id) => firstNodes.has(id))) continue;
      const c: OWay = { id: w.id, refs: w.refs.slice(), tags: { ...w.tags } };
      if (w.of !== undefined) c.of = w.of;
      d.ways.push(c);
      d.wayById.set(c.id, c);
      for (const id of w.refs) {
        const n = this.nodes.get(id);
        if (n && !d.nodes.has(id)) d.nodes.set(id, { id, x: n.x, z: n.z, tags: n.tags ? { ...n.tags } : null });
      }
    }
    for (const rel of this.relations) {
      if (!rel.members.some((m) => m.type === 'w' && d.wayById.has(m.ref))) continue;
      d.relations.push({ id: rel.id, members: rel.members.map((m) => ({ ...m })), tags: { ...rel.tags } });
    }
    return d;
  }

  /** Add the areas and ways of tools/mapgen/observed-roads.json (observedroads.ts: loadAdditions). */
  addObserved(extra: Additions): void {
    const pos = (id: number): { x: number; z: number } | undefined => this.nodes.get(id);
    for (const a of extra.ways) {
      if (this.wayById.has(a.id)) continue;
      const n = a.pts.length / 2;
      const refs: number[] = [];
      for (let i = 0; i < n; i++) {
        const id = addedNodeId(a.id, i);
        this.nodes.set(id, { id, x: a.pts[i * 2], z: a.pts[i * 2 + 1], tags: null });
        refs.push(id);
      }
      if (a.closed) refs.push(refs[0]);
      else if (a.connect) {
        const kind = networkKind(a.tags);
        for (const end of [0, n - 1]) {
          const j = kind ? findJoin(a.pts[end * 2], a.pts[end * 2 + 1], kind, this.ways, pos) : null;
          if (!j) continue;
          if ('node' in j) refs[end] = j.node;
          else {
            // a node put into the piece of the other way, where the end meets it
            const host = this.wayById.get(j.way);
            if (!host) continue;
            const id = refs[end];
            const node = this.nodes.get(id)!;
            node.x = j.x;
            node.z = j.z;
            host.refs.splice(j.after + 1, 0, id);
          }
        }
      }
      const way: OWay = { id: a.id, refs, tags: { ...a.tags } };
      this.ways.push(way);
      this.wayById.set(way.id, way);
    }
  }

  /** Several extracts as one (for building a part of the region on its own: what overlaps is kept once). */
  static loadAll(paths: string[], opts: { observed?: boolean } = {}): OsmData {
    if (paths.length === 1) return OsmData.load(paths[0], opts);
    const d = new OsmData();
    for (const path of paths) {
      const part = OsmData.load(path, opts);
      d.extractedAt = part.extractedAt;
      for (const [id, n] of part.nodes) d.nodes.set(id, n);
      for (const w of part.ways) {
        if (d.wayById.has(w.id)) continue;
        d.ways.push(w);
        d.wayById.set(w.id, w);
      }
      // (the uncut ways of waysplit.ts, known by their numbers only)
      for (const [id, w] of part.wayById) if (!d.wayById.has(id)) d.wayById.set(id, w);
      const seen = new Set(d.relations.map((r) => r.id));
      for (const r of part.relations) if (!seen.has(r.id)) d.relations.push(r);
    }
    return d;
  }

  /** Flat [x,z,…] coordinates of a way; nodes missing from the extract are skipped. */
  wayCoords(way: OWay): number[] {
    const out: number[] = [];
    for (const ref of way.refs) {
      const n = this.nodes.get(ref);
      if (n) out.push(n.x, n.z);
    }
    return out;
  }

  /**
   * Assemble the rings of a multipolygon relation.  Returns outer and inner
   * rings as flat [x,z,…] arrays (closed implicitly, no repeated last point).
   */
  multipolygonRings(rel: ORelation): { outer: number[][]; inner: number[][] } {
    const collect = (role: (r: string) => boolean): number[][] => {
      const segs: number[][] = [];
      for (const m of rel.members) {
        if (m.type !== 'w' || !role(m.role)) continue;
        const w = this.wayById.get(m.ref);
        if (!w || w.refs.length < 2) continue;
        segs.push(w.refs.slice());
      }
      // stitch node-id chains into closed rings
      const rings: number[][] = [];
      while (segs.length) {
        let chain = segs.pop()!;
        let grown = true;
        while (chain[0] !== chain[chain.length - 1] && grown) {
          grown = false;
          for (let i = 0; i < segs.length; i++) {
            const s = segs[i];
            const tail = chain[chain.length - 1];
            const head = chain[0];
            if (s[0] === tail) chain = chain.concat(s.slice(1));
            else if (s[s.length - 1] === tail) chain = chain.concat(s.slice(0, -1).reverse());
            else if (s[s.length - 1] === head) chain = s.slice(0, -1).concat(chain);
            else if (s[0] === head) chain = s.slice(1).reverse().concat(chain);
            else continue;
            segs.splice(i, 1);
            grown = true;
            break;
          }
        }
        if (chain.length >= 4 && chain[0] === chain[chain.length - 1]) {
          const flat: number[] = [];
          let complete = true;
          for (let i = 0; i < chain.length - 1; i++) {
            const n = this.nodes.get(chain[i]);
            if (n) flat.push(n.x, n.z);
            else complete = false;
          }
          // an outline with corners missing would be closed across the map: better no area than a wrong one
          if (complete && flat.length >= 6) rings.push(flat);
        }
      }
      return rings;
    };
    return {
      outer: collect((r) => r !== 'inner'),
      inner: collect((r) => r === 'inner'),
    };
  }
}

export function isClosedWay(w: OWay): boolean {
  return w.refs.length >= 4 && w.refs[0] === w.refs[w.refs.length - 1];
}

export function tagIs(tags: Tags | null | undefined, key: string, ...values: string[]): boolean {
  if (!tags) return false;
  const v = tags[key];
  return v !== undefined && values.includes(v);
}
