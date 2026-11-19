// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Does the rule monitor see a speed limit on the motorways and slip roads
 * that the road itself does not have?  (The speed limiter of the game holds
 * exactly the number the monitor reports, so a wrong one holds the car on the
 * Autobahn at 50 km/h with no sign in sight.)
 *
 * For every motorway and slip-road edge of the map it stands a still car on
 * the lanes – centre, lane edges, shoulder – every 10 m, in the direction the
 * lanes go, and asks the monitor what limit it sees there (src/sim/rules.ts).
 * Every point where that number differs from the limit of the road sampled is
 * recorded with the road it was matched to, how far off in height that road
 * was, and how the match was made:
 *
 *   surface   the road surface under the point (world.surfaceAt)
 *   fallback  the nearest road within FALLBACK_MAX_DIST m (world.locate,
 *             which reaches FALLBACK_MAX_DY metres up or down)
 *   junction  a junction area: its surface, or the fallback inside one
 *   sidewalk  the pavement beside a road
 *   none      no road at all
 *
 * Before the first sample of an edge the car is driven onto it from its
 * junction, as a real one arrives there, so that the monitor knows the road
 * at the first sample too.
 *
 *   node tools/dev/limit-sweep.ts
 *   MAP_DIR=<folder> node tools/dev/limit-sweep.ts    # another map
 *   SWEEP_EVERY=5 node tools/dev/limit-sweep.ts       # m between samples
 *
 * Exits 1 when a limit was found that the road does not have.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPolySample, samplePolyline } from '../../src/core/geom.ts';
import { followMap } from '../../src/sim/follow.ts';
import type { MapFollowers } from '../../src/sim/follow.ts';
import { FALLBACK_MAX_DIST, FALLBACK_MAX_DY, RuleMonitor } from '../../src/sim/rules.ts';
import type { PlayerSnapshot } from '../../src/sim/rules.ts';
import { SignalSystem } from '../../src/sim/signals.ts';
import { Traffic } from '../../src/sim/traffic.ts';
import { TimedRules, loadExtraSigns } from '../../src/world/extrasigns.ts';
import { CHUNK, GRID_OFFSET, GridSet } from '../../src/world/grid.ts';
import type { GridBits } from '../../src/world/grid.ts';
import { LaneGraph } from '../../src/world/lanes.ts';
import { MapLoader } from '../../src/world/loader.ts';
import { CLS } from '../../src/world/types.ts';
import { newSurfaceHit } from '../../src/world/world.ts';
import type { Edge } from '../../src/world/world.ts';
import { diskFiles } from '../mapgen/mapfiles.ts';

const root = fileURLToPath(new URL(`../../${(process.env.MAP_DIR ?? 'public/map').replace(/\/$/, '')}/`, import.meta.url));
const map = await MapLoader.open(diskFiles(root));
const world = map.world;
const graph = new LaneGraph(world);
const followers: MapFollowers = { lanes: graph };
followMap(map, followers);
const signals = new SignalSystem(world.signals, world.lightsOut);
const traffic = new Traffic(world, graph, signals);
followers.signals = signals;
followers.traffic = traffic;
traffic.targetCount = 0;
const rules = new RuleMonitor(world, graph, signals, traffic);
// the signs with a time on them (signs.json.gz): they take the place of the road's own
// limit while they hold, by the game's clock – as they do in the game
const extra = await loadExtraSigns(map);
if (extra) rules.timed = new TimedRules(extra.rules, () => new Date());

/** how long one still step of the monitor counts as (s) */
const DT = 1 / 10;
/** metres between two samples along an edge */
const EVERY = Number(process.env.SWEEP_EVERY ?? 10);
/** how far the car is driven onto an edge from its junction before its first sample (m) */
const WARM = 60;

const hit = newSurfaceHit();
const nearHit = newSurfaceHit();
const smp = newPolySample();

/** How a point was matched to a road. */
type Cause = 'surface' | 'fallback' | 'junction' | 'sidewalk' | 'none';

interface Match {
  cause: Cause;
  edge: Edge | null;
  /** how far the matched surface lies above or below the point (m) */
  dy: number;
}

/**
 * The junction areas of the loaded network: whether a point lies in one.  The
 * shapes are what world.surfaceAt finds the junction carriageway by; a point
 * in the area of a junction but outside that shape (between the polygon and
 * the roads, a junction area without an edge) reaches the fallback of the
 * monitor instead.
 */
const NODE_CELL = 64;
let nodeBoxes: Array<{ x0: number; z0: number; x1: number; z1: number }> = [];
let nodeGrid = new Map<number, number[]>();
let nodeCount = -1;
function indexNodes(): void {
  const count = world.allNodes.size;
  if (count === nodeCount) return;
  nodeCount = count;
  nodeBoxes = [];
  nodeGrid = new Map();
  for (const n of world.allNodes) {
    const sh = n.shape;
    if (!sh) continue;
    // a hand's breadth around the shape: the point may stand just beside it
    const i = nodeBoxes.push({ x0: sh.minX - 6, z0: sh.minZ - 6, x1: sh.maxX + 6, z1: sh.maxZ + 6 }) - 1;
    const b = nodeBoxes[i];
    for (let ix = Math.floor(b.x0 / NODE_CELL); ix <= Math.floor(b.x1 / NODE_CELL); ix++) {
      for (let iz = Math.floor(b.z0 / NODE_CELL); iz <= Math.floor(b.z1 / NODE_CELL); iz++) {
        const k = (ix + 4096) * 8192 + iz + 4096;
        const list = nodeGrid.get(k);
        if (list) list.push(i);
        else nodeGrid.set(k, [i]);
      }
    }
  }
}
function inJunctionArea(x: number, z: number): boolean {
  const k = (Math.floor(x / NODE_CELL) + 4096) * 8192 + Math.floor(z / NODE_CELL) + 4096;
  const list = nodeGrid.get(k);
  if (!list) return false;
  for (const i of list) {
    const b = nodeBoxes[i];
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return true;
  }
  return false;
}

/** How the point was matched to a road – the same way src/sim/rules.ts does it. */
function matchAt(x: number, y: number, z: number): Match {
  const onSurface = world.surfaceAt(x, z, y + 0.6, hit);
  if (!onSurface || (hit.zone !== 0 && !hit.edge)) {
    if (world.locate(x, z, y, FALLBACK_MAX_DIST, nearHit, FALLBACK_MAX_DY) && nearHit.edge) {
      return { cause: !onSurface && inJunctionArea(x, z) ? 'junction' : 'fallback', edge: nearHit.edge, dy: Math.abs(nearHit.y - y) };
    }
    return { cause: 'none', edge: null, dy: 0 };
  }
  if (hit.edge && hit.zone === 0) return { cause: 'surface', edge: hit.edge, dy: Math.abs(hit.y - y) };
  if (hit.node) return { cause: 'junction', edge: null, dy: Math.abs(hit.y - y) };
  return { cause: 'sidewalk', edge: hit.edge, dy: Math.abs(hit.y - y) };
}

/** The limit of the road itself, as the monitor works it out for a car (no caps, no roadworks). */
function ownLimit(edge: Edge, dir: number): number {
  if (edge.zone === 7) return 7;
  const timed = rules.timed?.limit(edge.id, dir, false) ?? null;
  if (timed) return timed.v;
  if (edge.cls >= CLS.SERVICE && edge.zone === 0) return -1;
  return dir > 0 ? edge.maxF : edge.maxB;
}

/** What the driver is shown for a limit: -1 (unknown) and 0 (none) are both no number. */
function shown(limit: number): number {
  return limit > 0 ? limit : 0;
}

/**
 * Every sample point of the lanes of `dir` at station `s`: the centre of each
 * lane, both lane edges, and the shoulder on the outside of the carriageway.
 * `cb` gets the point with the yaw a car driving `dir` there would have.
 */
function points(edge: Edge, dir: number, s: number, cb: (x: number, y: number, z: number, yaw: number, what: string) => void): void {
  const el = graph.edgeLanes[edge.id];
  const lanes = !el ? [] : dir > 0 ? el.fwd : el.back;
  if (lanes.length === 0) return;
  samplePolyline(edge.pl, s, smp);
  const yaw = dir > 0 ? Math.atan2(-smp.tx, -smp.tz) : Math.atan2(smp.tx, smp.tz);
  // +off = left of a→b, as the lane offsets of src/world/lanes.ts count it
  const put = (off: number, what: string): void => cb(smp.x + smp.tz * off, smp.y, smp.z - smp.tx * off, yaw, what);
  const half = edge.width / 2;
  const margin = dir > 0 ? edge.marginR : edge.marginL;
  const sign = dir > 0 ? -1 : 1;
  for (let k = 0; k < lanes.length; k++) {
    const c = sign * (half - margin - (k + 0.5) * edge.laneW);
    put(c, 'lane');
    put(c - (sign * edge.laneW) / 2, 'lane edge');
    put(c + (sign * edge.laneW) / 2, 'lane edge');
  }
  put(sign * (half - margin / 2), 'shoulder');
}

const snap = (x: number, y: number, z: number, yaw: number): PlayerSnapshot => ({
  x,
  y,
  z,
  yaw,
  speed: 0,
  indicator: 0,
  hazard: false,
  lookYaw: 0,
  seatbelt: true,
  handbrake: 0,
  stalled: false,
  hitScenery: 0,
  length: 4.3,
  front: 2.15,
});

interface Finding {
  cause: Cause;
  /** what the monitor says */
  got: number;
  /** what the road says */
  want: number;
  /** the plate of the sign with a time on it, where the number came from one */
  when: string;
  edge: Edge;
  dir: number;
  s: number;
  what: string;
  /** the road the monitor matched the point to */
  match: Edge | null;
  matchLimit: number;
  dy: number;
  x: number;
  z: number;
}

interface Signed {
  edge: Edge;
  dir: number;
  limit: number;
  when: string;
  points: number;
  first: { x: number; z: number };
}

const findings: Finding[] = [];
const signed = new Map<string, Signed>();
/** how often each way of matching a point happened – over every point, not only the mismatches */
const causes = new Map<string, number>();
let sampled = 0;
let km = 0;
let edgesDone = 0;

/** A still car on the point: what the monitor makes of it. */
function stand(x: number, y: number, z: number, yaw: number): void {
  rules.update(DT, snap(x, y, z, yaw), []);
}

/** The car is driven onto the edge from its junction, so that the monitor knows the road there. */
function driveOn(edge: Edge, dir: number): void {
  const start = dir > 0 ? 0 : edge.len;
  for (let k = 0; k * 2 <= WARM; k++) {
    const s = start + dir * k * 2;
    if (s < 0 || s > edge.len) break;
    let solid = false;
    points(edge, dir, s, (x, y, z, yaw) => {
      if (solid) return;
      const m = matchAt(x, y, z);
      stand(x, y, z, yaw);
      if (m.cause === 'surface' && m.edge === edge) solid = true;
    });
    if (solid) break;
  }
}

/** Both directions of one edge: drive on, then sample every `EVERY` metres. */
function sweepEdge(edge: Edge): void {
  const el = graph.edgeLanes[edge.id];
  if (!el) return;
  edgesDone++;
  km += edge.len / 1000;
  for (const dir of [1, -1] as const) {
    if ((dir > 0 ? el.fwd : el.back).length === 0) continue;
    driveOn(edge, dir);
    const len = edge.len;
    for (let s = dir > 0 ? 0 : len; dir > 0 ? s <= len : s >= 0; s += dir * EVERY) {
      points(edge, dir, s, (x, y, z, yaw, what) => {
        const m = matchAt(x, y, z);
        stand(x, y, z, yaw);
        sampled++;
        const key = m.cause === 'junction' && m.edge ? 'junction (fallback)' : `${m.cause}${m.edge && m.edge !== edge ? ' (another road)' : ''}`;
        causes.set(key, (causes.get(key) ?? 0) + 1);
        const got = rules.context.limit;
        const want = ownLimit(edge, dir);
        if (shown(got) !== shown(want)) {
          findings.push({ cause: m.cause, got, want, when: rules.context.limitWhen, edge, dir, s, what, match: m.edge, matchLimit: m.edge ? ownLimit(m.edge, dir) : 0, dy: m.dy, x, z });
        } else if (edge.cls === CLS.MOTORWAY && want > 0) {
          const key = `${edge.id}|${dir}`;
          const was = signed.get(key);
          if (was) was.points++;
          else signed.set(key, { edge, dir, limit: want, when: rules.context.limitWhen, points: 1, first: { x, z } });
        }
      });
    }
  }
}

/** Is the middle of the edge inside the rectangle of the chunk being swept? */
function inRect(edge: Edge, r: { minX: number; minZ: number; maxX: number; maxZ: number }): boolean {
  const mid = (edge.pl.pts.length / 3) >> 1;
  const x = edge.pl.pts[mid * 3];
  const z = edge.pl.pts[mid * 3 + 2];
  return x >= r.minX && x < r.maxX && z >= r.minZ && z < r.maxZ;
}

const motorway = (e: Edge): boolean => e.cls <= CLS.MOTORWAY_LINK && !!graph.edgeLanes[e.id];

if (!map.pieces) {
  for (const e of world.allEdges) if (motorway(e)) sweepEdge(e);
} else {
  const index = JSON.parse(readFileSync(resolve(root, 'map.json'), 'utf8')) as { chunks: GridBits };
  const chunks = GridSet.from(index.chunks);
  let count = 0;
  for (let cz = chunks.z0; cz < chunks.z0 + chunks.h; cz++) for (let cx = chunks.x0; cx < chunks.x0 + chunks.w; cx++) if (chunks.has(cx, cz)) count++;
  let done = 0;
  for (let cz = chunks.z0; cz < chunks.z0 + chunks.h; cz++) {
    for (let cx = chunks.x0; cx < chunks.x0 + chunks.w; cx++) {
      if (!chunks.has(cx, cz)) continue;
      const r = { minX: cx * CHUNK - GRID_OFFSET, minZ: cz * CHUNK - GRID_OFFSET, maxX: (cx + 1) * CHUNK - GRID_OFFSET, maxZ: (cz + 1) * CHUNK - GRID_OFFSET };
      const mx = r.minX + CHUNK / 2;
      const mz = r.minZ + CHUNK / 2;
      // the roads of the chunk with the roads around it (the same as tools/check-lanes.ts)
      map.loadRadius = CHUNK * 0.71 + 1200;
      map.keepRadius = CHUNK * 0.71 + 4200;
      await map.loadAround(mx, mz);
      for (let i = 0; i < 40; i++) map.update(mx, mz, Infinity);
      indexNodes();
      for (const e of world.allEdges) if (motorway(e) && inRect(e, r)) sweepEdge(e);
      process.stdout.write(`\r[limit-sweep] chunk ${++done} of ${count}: ${km.toFixed(0)} km, ${edgesDone} edges, ${sampled} points, ${findings.length} mismatches  `);
    }
  }
  process.stdout.write('\n');
}

// ---------------------------------------------------------------- report
const groups = new Map<string, Finding[]>();
for (const f of findings) {
  const what = f.match ? `e${f.match.id} "${f.match.name || f.match.ref}" cls ${f.match.cls} own ${f.matchLimit}` : 'no road';
  const k = `${f.cause}: got ${f.got} want ${f.want}, matched ${what}`;
  const list = groups.get(k);
  if (list) list.push(f);
  else groups.set(k, [f]);
}
console.log(`[limit-sweep] ${world.meta.name}: ${km.toFixed(0)} km on ${edgesDone} motorway and slip-road edges, ${sampled} points`);
console.log(`[limit-sweep] how the points were matched: ${[...causes].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
if (findings.length === 0) console.log('[limit-sweep] no limit the road does not have');
else {
  console.log(`[limit-sweep] ${findings.length} points where the limit is not the road's, in ${groups.size} group(s):`);
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length);
  for (const [k, list] of sorted) {
    let lo = Infinity;
    let hi = 0;
    for (const f of list) {
      lo = Math.min(lo, f.dy);
      hi = Math.max(hi, f.dy);
    }
    console.log(`  ${k} – ${list.length} point(s), |dy| ${lo.toFixed(1)}…${hi.toFixed(1)} m`);
    for (const f of list.slice(0, 5)) {
      console.log(`     at (${f.x.toFixed(1)}, ${f.z.toFixed(1)}) s ${f.s.toFixed(0)} ${f.what} of e${f.edge.id} "${f.edge.name || f.edge.ref}" dir ${f.dir}${f.when ? `, timed "${f.when}"` : ''}`);
    }
    if (list.length > 5) console.log(`     … ${list.length - 5} more`);
  }
}
if (signed.size > 0) {
  // (grouped: how many roads of the motorway network carry a limit, and which)
  const byLimit = new Map<string, number>();
  for (const s of signed.values()) {
    const k = `${s.limit} km/h${s.when ? ` (timed: ${s.when})` : ''}`;
    byLimit.set(k, (byLimit.get(k) ?? 0) + 1);
  }
  console.log(`[limit-sweep] ${signed.size} road(s) where a motorway itself carries a limit (to check against its signs):`);
  for (const [k, n] of [...byLimit].sort((a, b) => b[1] - a[1])) console.log(`  ${n} × ${k}`);
  for (const s of [...signed.values()].slice(0, 8)) {
    console.log(`     e${s.edge.id} "${s.edge.name || s.edge.ref}" dir ${s.dir} limit ${s.limit}${s.when ? ` timed "${s.when}"` : ''} from (${s.first.x.toFixed(0)}, ${s.first.z.toFixed(0)})`);
  }
}
process.exitCode = findings.length > 0 ? 1 : 0;
