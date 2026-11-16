// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The lines of the trams: the way each runs over the tracks and the stops it
 * calls at, in their order – from the route relations of OpenStreetMap
 * (route=tram and route=light_rail, as public transport is mapped there) –
 * so that the trams of the game run their real lines, with the line and its
 * destination on the front.
 *
 *   node --max-old-space-size=3072 tools/build-lines.ts [path/to/hessen-latest.osm.pbf]
 *
 * Reads what it needs from the file itself – the relations, then their ways,
 * then the nodes of those (three quick passes, little memory) – and the
 * map's rails.json.gz (MAP_OUT, default public/map).  Writes lines.json.gz
 * there (see LinesJson in src/world/types.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { latLonToWorld } from '../src/geo/utm.ts';
import type { LineJson, LinesJson, RailJson } from '../src/world/types.ts';
import { readPbf } from './osm/pbf.ts';
import type { OsmMember, Tags } from './osm/pbf.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = resolve(root, process.argv[2] ?? 'data/raw/osm/hessen-latest.osm.pbf');
const mapDir = resolve(root, process.env.MAP_OUT ?? 'public/map');
const t0 = Date.now();
const lap = (msg: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);

// ---- the route relations of trams and regional trams, from the whole file ----
interface Route {
  id: number;
  tags: Tags;
  members: OsmMember[];
}
const routes: Route[] = [];
readPbf(input, {
  relation(id, members, tags) {
    const t = tags();
    if (t.type !== 'route' || (t.route !== 'tram' && t.route !== 'light_rail')) return;
    routes.push({ id, tags: t, members: members() });
  },
});
lap(`${routes.length} route relations of trams and regional trams in the file`);

// ---- their ways, then the nodes of those (positions in the world, the names of the stops) ----
const wantWays = new Set<number>();
const wantNodes = new Set<number>();
for (const r of routes) for (const m of r.members) (m.type === 'w' ? wantWays : m.type === 'n' ? wantNodes : null)?.add(m.ref);
const wayRefs = new Map<number, number[]>();
readPbf(input, {
  way(id, refs) {
    if (!wantWays.has(id)) return;
    wayRefs.set(id, refs);
    for (const r of refs) wantNodes.add(r);
  },
});
const nodes = new Map<number, { x: number; z: number; name: string }>();
readPbf(input, {
  node(id, lat, lon, tags) {
    if (!wantNodes.has(id)) return;
    const [x, z] = latLonToWorld(lat, lon);
    nodes.set(id, { x, z, name: tags()?.name ?? '' });
  },
});
const osm = {
  wayById: new Map([...wayRefs].map(([id, refs]) => [id, { id, refs }])),
  nodes,
};
lap(`${wayRefs.size} ways, ${nodes.size} nodes of the lines`);
const railDoc = JSON.parse(gunzipSync(readFileSync(resolve(mapDir, 'rails.json.gz'))).toString('utf8')) as { rails: RailJson[] };
const rails = railDoc.rails;

// ---- the points of the tracks, on a grid: which piece, how far along it ----
const CELL = 20;
const grid = new Map<number, number[]>();
const key = (x: number, z: number): number => (Math.floor(x / CELL) + 32768) * 65536 + (Math.floor(z / CELL) + 32768);
const cums: Float64Array[] = rails.map((r, ri) => {
  const n = r.p.length / 3;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(r.p[i * 3] - r.p[i * 3 - 3], r.p[i * 3 + 2] - r.p[i * 3 - 1]);
  for (let i = 0; i < n; i++) {
    const k = key(r.p[i * 3], r.p[i * 3 + 2]);
    const list = grid.get(k);
    const entry = [ri, i];
    if (list) list.push(...entry);
    else grid.set(k, entry);
  }
  return cum;
});
/** the nearest point of a track within `reach` metres: its piece and how far along it, or null */
function nearest(x: number, z: number, reach: number, kinds: Set<number>): { path: number; s: number; d: number } | null {
  let best: { path: number; s: number; d: number } | null = null;
  const i0 = Math.floor((x - reach) / CELL);
  const i1 = Math.floor((x + reach) / CELL);
  const j0 = Math.floor((z - reach) / CELL);
  const j1 = Math.floor((z + reach) / CELL);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const list = grid.get((i + 32768) * 65536 + (j + 32768));
      if (!list) continue;
      for (let k = 0; k < list.length; k += 2) {
        const path = list[k];
        if (!kinds.has(rails[path].k)) continue;
        const pi = list[k + 1];
        const p = rails[path].p;
        // along the segments on either side of the point
        for (const q of [pi - 1, pi]) {
          if (q < 0 || q + 1 >= p.length / 3) continue;
          const ax = p[q * 3];
          const az = p[q * 3 + 2];
          const dx = p[q * 3 + 3] - ax;
          const dz = p[q * 3 + 5] - az;
          const l2 = dx * dx + dz * dz;
          const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
          const d = Math.hypot(ax + dx * u - x, az + dz * u - z);
          if (d <= reach && (!best || d < best.d)) best = { path, s: cums[path][q] + Math.sqrt(l2) * u, d };
        }
      }
    }
  }
  return best;
}

// ---- each line ----
const lines: LineJson[] = [];
let gaps = 0;
for (const r of routes) {
  const t = r.tags;
  const kinds = new Set(t.route === 'tram' ? [0, 1] : [1, 0, 2]);
  // its ways in their order, each turned to follow on from the one before
  const ways = r.members.filter((m) => m.type === 'w' && !/platform/.test(m.role)).map((m) => osm.wayById.get(m.ref)).filter((w) => w !== undefined);
  if (ways.length === 0) continue;
  const chain: number[] = [];
  let lastNode = -1;
  ways.forEach((w, i) => {
    let refs = w.refs;
    if (i === 0 && ways.length > 1) {
      const next = ways[1].refs;
      // (the first way runs towards the second)
      if (refs[0] === next[0] || refs[0] === next[next.length - 1]) refs = [...refs].reverse();
    } else if (i > 0 && refs[refs.length - 1] === lastNode && refs[0] !== lastNode) refs = [...refs].reverse();
    for (const ref of refs) {
      const n = osm.nodes.get(ref);
      if (!n) continue;
      if (chain.length >= 2 && chain[chain.length - 2] === n.x && chain[chain.length - 1] === n.z) continue;
      chain.push(n.x, n.z);
    }
    lastNode = refs[refs.length - 1];
  });
  // along it every 4 m: on which piece of track, how far along – the pieces it runs, and which way
  const paths: Array<[number, number]> = [];
  let cur = -1;
  let firstS = 0;
  let lastS = 0;
  let missed = 0;
  const flush = (): void => {
    if (cur < 0) return;
    const dir = lastS >= firstS ? 1 : -1;
    const prev = paths[paths.length - 1];
    if (!prev || prev[0] !== cur || prev[1] !== dir) paths.push([cur, dir]);
  };
  for (let i = 0; i + 3 < chain.length; i += 2) {
    const ax = chain[i];
    const az = chain[i + 1];
    const l = Math.hypot(chain[i + 2] - ax, chain[i + 3] - az);
    const steps = Math.max(1, Math.ceil(l / 4));
    for (let k = 0; k < steps; k++) {
      const x = ax + ((chain[i + 2] - ax) * k) / steps;
      const z = az + ((chain[i + 3] - az) * k) / steps;
      const hit = nearest(x, z, 3, kinds);
      if (!hit) {
        missed++;
        continue;
      }
      if (hit.path !== cur) {
        flush();
        cur = hit.path;
        firstS = hit.s;
      }
      lastS = hit.s;
    }
  }
  flush();
  if (paths.length === 0) continue;
  // Along the tracks themselves: each piece sampled must be reachable from the end of the one before (over the
  // short pieces of a switch the samples stepped over, found by a search) – a piece that is not (the samples
  // touched a track close by) is left out, and every piece is run the way it is entered.
  const fixed: Array<[number, number]> = [paths[0]];
  if (paths.length > 1) {
    const q0 = paths[1][0];
    const p0 = paths[0][0];
    if (rails[p0].b.some((v) => v >> 1 === q0)) fixed[0] = [p0, 1];
    else if (rails[p0].a.some((v) => v >> 1 === q0)) fixed[0] = [p0, -1];
  }
  let skipped = 0;
  for (let i = 1; i < paths.length; i++) {
    const [p, d] = fixed[fixed.length - 1];
    const q = paths[i][0];
    if (q === p) continue;
    const out = d > 0 ? rails[p].b : rails[p].a;
    // breadth first over the pieces from the end of p, up to 500 m
    const seen: Array<{ path: number; dir: number; prev: number; len: number }> = [];
    let front = out.map((v) => ({ path: v >> 1, dir: (v & 1) === 0 ? 1 : -1, prev: -1, len: 0 }));
    let found = -1;
    for (let depth = 0; depth < 10 && found < 0 && front.length > 0; depth++) {
      const next: typeof front = [];
      for (const f of front) {
        const k = seen.length;
        seen.push(f);
        if (f.path === q) {
          found = k;
          break;
        }
        const len = f.len + cums[f.path][cums[f.path].length - 1];
        if (len > 500 || seen.length > 400) continue;
        for (const v of f.dir > 0 ? rails[f.path].b : rails[f.path].a) next.push({ path: v >> 1, dir: (v & 1) === 0 ? 1 : -1, prev: k, len });
      }
      front = next;
    }
    if (found >= 0) {
      const way: Array<[number, number]> = [];
      for (let k = found; k >= 0; k = seen[k].prev) way.unshift([seen[k].path, seen[k].dir]);
      fixed.push(...way);
      skipped = 0;
    } else if (++skipped >= 3) {
      // (lost for a while – the tracks of the map end there, or a tunnel left out: on from here)
      fixed.push(paths[i]);
      skipped = 0;
    }
  }
  paths.length = 0;
  paths.push(...fixed);
  // pieces that do not join the next one: the line is followed where it can be, the trams choose themselves elsewhere
  for (let i = 0; i + 1 < paths.length; i++) {
    const [p, d] = paths[i];
    const ends = d > 0 ? rails[p].b : rails[p].a;
    const [q, e] = paths[i + 1];
    if (!ends.includes(q * 2 + (e > 0 ? 0 : 1))) gaps++;
  }
  // its stops, in their order: the stop of the tracks nearest to each (a mark on one of its pieces)
  const onLine = new Set(paths.map(([p]) => p));
  const stops: Array<[number, number]> = [];
  for (const m of r.members) {
    if (m.type !== 'n' || !/^stop/.test(m.role)) continue;
    const n = osm.nodes.get(m.ref);
    if (!n) continue;
    let best: [number, number] | null = null;
    let bd = 30;
    for (const p of onLine) {
      const st = rails[p].st ?? [];
      for (const mark of st) {
        // the point at the mark
        const cum = cums[p];
        let q = 1;
        while (q < cum.length - 1 && cum[q] < mark) q++;
        const u = (mark - cum[q - 1]) / (cum[q] - cum[q - 1] || 1);
        const pp = rails[p].p;
        const x = pp[q * 3 - 3] + (pp[q * 3] - pp[q * 3 - 3]) * u;
        const z = pp[q * 3 - 1] + (pp[q * 3 + 2] - pp[q * 3 - 1]) * u;
        const d = Math.hypot(x - n.x, z - n.z);
        if (d < bd) {
          bd = d;
          best = [p, mark];
        }
      }
    }
    if (best && !stops.some((s) => s[0] === best![0] && s[1] === best![1])) stops.push(best);
  }
  void missed;
  lines.push({ ref: t.ref ?? '', name: t.name ?? '', from: t.from ?? '', to: t.to ?? '', colour: t.colour ?? '', kind: t.route === 'tram' ? 0 : 1, paths, stops });
}
lines.sort((a, b) => a.ref.localeCompare(b.ref, 'de', { numeric: true }) || a.to.localeCompare(b.to, 'de'));
const out: LinesJson = { v: 1, lines };
const bytes = gzipSync(JSON.stringify(out), { level: 9 });
writeFileSync(resolve(mapDir, 'lines.json.gz'), bytes);
lap(`lines.json.gz: ${lines.length} lines (${lines.map((l) => `${l.ref} → ${l.to} ${l.paths.length} pieces, ${l.stops.length} stops`).join('; ')}), ${gaps} joins the tracks do not have, ${(bytes.length / 1024).toFixed(0)} KB`);
