// SPDX-License-Identifier: AGPL-3.0-only
/** Loads the JSON extract written by tools/osm-extract.ts and projects it into world space. */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { latLonToWorld } from '../../src/geo/utm.ts';

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

  /**
   * Read an extract written by tools/osm-extract.ts (gzipped or not).  Its
   * nodes are [id, x, z, tags?] in world coordinates, or – extracts of older
   * builds – [id, lat, lon, tags?].
   */
  static load(path: string): OsmData {
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
