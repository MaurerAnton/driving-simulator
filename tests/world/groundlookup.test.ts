// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The ground lookups made cheaper in 1.7.0 give exactly what they gave
 * before, bit for bit: `World.surfaceAt` with the bounding box of each
 * segment in the segment grid (it turns away the far segments of a cell
 * before projecting onto them), and `TileManager.heightAt` / `coverAt`,
 * which remember the tile they looked up last.  The old implementations are
 * kept here as the reference; both are asked the same many thousands of
 * questions – on synthetic towns and on the real map (Baunatal centre with
 * its raised tables, humps, flush mouths, parking strips and junction
 * corners, and a rural area; skipped without public/map) – also while pieces
 * of the network and terrain tiles come and go in between.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { Grid2, newPolySample, pointInRing, projectOnPolyline, samplePolyline } from '../../src/core/geom.ts';
import type { PolyProjection } from '../../src/core/geom.ts';
import { TileManager } from '../../src/render/tiles.ts';
import type { LoadedTile } from '../../src/render/tiles.ts';
import { CALM } from '../../src/world/roadfeatures.ts';
import { SegGrid } from '../../src/world/seggrid.ts';
import { calmLift } from '../../src/world/roadfeatures.ts';
import { PARK } from '../../src/world/xsection.ts';
import { packTile, tileKey } from '../../src/world/tilefmt.ts';
import { KERB_H, SURF } from '../../src/world/types.ts';
import type { WorldChunkJson, WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts, newSurfaceHit, packEdgePoints } from '../../src/world/world.ts';
import type { Edge, JunctionCorner, Node, SurfaceHit } from '../../src/world/world.ts';
import { makeTown } from '../game/town.ts';
import { haveMap, openRealMap } from '../realmap.ts';

// ---------------------------------------------------------------------------
// the reference: World.surfaceAt as it was before the segment boxes (a copy)

/** Is (x,z) on the sidewalk strip behind a junction kerb line?  (copy of world.ts) */
function refPointNearKerb(x: number, z: number, c: JunctionCorner): boolean {
  const k = c.kerb;
  const n = k.length / 2;
  let best = Infinity;
  let bestT = 0;
  let side = 0;
  let total = 0;
  let acc = 0;
  for (let i = 0; i < n - 1; i++) total += Math.hypot(k[i * 2 + 2] - k[i * 2], k[i * 2 + 3] - k[i * 2 + 1]);
  if (total < 1e-6) return false;
  for (let i = 0; i < n - 1; i++) {
    const ax = k[i * 2];
    const az = k[i * 2 + 1];
    const dx = k[i * 2 + 2] - ax;
    const dz = k[i * 2 + 3] - az;
    const l2 = dx * dx + dz * dz;
    const l = Math.sqrt(l2);
    let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x - (ax + dx * t);
    const ez = z - (az + dz * t);
    const d2 = ex * ex + ez * ez;
    if (d2 < best) {
      best = d2;
      bestT = (acc + l * t) / total;
      side = ex * dz - ez * dx;
    }
    acc += l;
  }
  if (side >= 0) return false;
  const w = c.swA + (c.swB - c.swA) * bestT;
  return best <= w * w;
}

interface Grid2Like<T> {
  at(x: number, z: number): readonly T[];
}
interface WorldInside {
  segGrid: Grid2Like<number>;
  nodeGrid: Grid2Like<Node>;
  edges: Edge[];
  planeY(node: Node, x: number, z: number): number;
  edgeY(edge: Edge, s: number, x: number, z: number): number;
}

/** The old `surfaceAt` over the same (private) grids of a world. */
function referenceSurfaceAt(world: World): (x: number, z: number, yRef: number, out: SurfaceHit) => boolean {
  const w = world as unknown as WorldInside;
  const tmpProj: PolyProjection = { s: 0, off: 0, d2: 0, seg: 0 };
  let bestY = 0;
  let bestScore = 0;
  let bestFound = false;
  const consider = (out: SurfaceHit, y: number, score: number, edge: Edge | null, node: Node | null, s: number, off: number, zone: number, surf: number): void => {
    if (bestFound) {
      const dy = y - bestY;
      if (dy < -1.5) return;
      if (dy <= 1.5 && score >= bestScore) return;
    }
    bestFound = true;
    bestY = y;
    bestScore = score;
    out.y = y;
    out.edge = edge;
    out.node = node;
    out.s = s;
    out.off = off;
    out.zone = zone;
    out.surf = surf;
  };
  return (x, z, yRef, out) => {
    bestFound = false;
    out.edge = null;
    out.node = null;
    out.zone = 2;
    const ceiling = yRef + 1.6;
    const nodes = w.nodeGrid.at(x, z);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const sh = node.shape!;
      if (x < sh.minX || x > sh.maxX || z < sh.minZ || z > sh.maxZ) continue;
      if (!pointInRing(x, z, sh.ring)) continue;
      const y = w.planeY(node, x, z);
      if (y > ceiling) continue;
      consider(out, y, -50, null, node, 0, 0, 0, SURF.ASPHALT);
    }
    const segs = w.segGrid.at(x, z);
    for (let i = 0; i < segs.length; i++) {
      const code = segs[i];
      const edge = w.edges[(code / 4096) | 0];
      if (x < edge.minX || x > edge.maxX || z < edge.minZ || z > edge.maxZ) continue;
      const seg = code % 4096;
      projectOnPolyline(edge.pl, x, z, tmpProj, seg, seg);
      const s = tmpProj.s;
      const off = tmpProj.off;
      const absOff = Math.abs(off);
      const half = edge.width / 2;
      const sw = off > 0 ? edge.swL : edge.swR;
      const reach = half + sw;
      if (absOff > reach) continue;
      const cum = edge.pl.cum;
      const clampedStart = s <= cum[seg] + 1e-6;
      const clampedEnd = s >= cum[seg + 1] - 1e-6;
      let lateral = absOff;
      if (clampedStart || clampedEnd) {
        const interior = clampedStart ? seg > 0 : seg < cum.length - 2;
        if (interior) {
          if (tmpProj.d2 > reach * reach) continue;
          lateral = Math.sqrt(tmpProj.d2);
        } else if (tmpProj.d2 > absOff * absOff + 0.04) {
          continue;
        }
      }
      const inJunctionZone = s < edge.cutA || s > edge.len - edge.cutB;
      if (inJunctionZone && lateral > half) continue;
      let y = w.edgeY(edge, s, x, z);
      const onSidewalk = lateral > half;
      if (edge.calm && !onSidewalk) y += calmLift(edge, s);
      if (onSidewalk) y += off > 0 ? edge.kerbL : edge.kerbR;
      if (y > ceiling) continue;
      consider(out, y, lateral - half + (onSidewalk ? 2 : 0) + (inJunctionZone ? 1 : 0), edge, null, s, off, onSidewalk ? 1 : 0, onSidewalk ? SURF.PAVING : edge.surf);
    }
    if (!bestFound || out.zone !== 0) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const sh = node.shape!;
        const pad = 3.5;
        if (x < sh.minX - pad || x > sh.maxX + pad || z < sh.minZ - pad || z > sh.maxZ + pad) continue;
        for (let c = 0; c < sh.corners.length; c++) {
          const corner = sh.corners[c];
          if (corner.swA <= 0 && corner.swB <= 0) continue;
          if (!refPointNearKerb(x, z, corner)) continue;
          const y = w.planeY(node, x, z) + KERB_H;
          if (y > ceiling) continue;
          consider(out, y, 3, null, node, 0, 0, 1, SURF.PAVING);
        }
      }
    }
    return bestFound;
  };
}

// ---------------------------------------------------------------------------
// asking both the same

/** A small seeded random source (the same points every run). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIELDS = ['y', 'edge', 'node', 's', 'off', 'zone', 'surf'] as const;
/** how many points were compared (all tests) */
let compared = 0;

/**
 * Compare the new and the old lookup on the points [x, z, yRef, …] – each
 * with its own result object kept from call to call, as the game keeps one
 * (fields a miss leaves alone must be left alone alike).  Returns how many
 * were on a road.
 */
function compare(world: World, pts: number[], label: string): number {
  const ref = referenceSurfaceAt(world);
  const a = newSurfaceHit();
  const b = newSurfaceHit();
  let on = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i];
    const z = pts[i + 1];
    const yRef = pts[i + 2];
    const ra = world.surfaceAt(x, z, yRef, a);
    const rb = ref(x, z, yRef, b);
    if (ra !== rb) assert.fail(`${label}: (${x}, ${z}, ${yRef}) found ${ra}, before ${rb}`);
    for (const f of FIELDS) {
      if (!Object.is(a[f], b[f])) assert.fail(`${label}: (${x}, ${z}, ${yRef}) ${f} = ${String(a[f] && (a[f] as Edge).id !== undefined ? (a[f] as Edge).id : a[f])}, before ${String(b[f] && (b[f] as Edge).id !== undefined ? (b[f] as Edge).id : b[f])}`);
    }
    if (ra) on++;
  }
  compared += pts.length / 3;
  return on;
}

const tmpS = newPolySample();

/**
 * Points that probe the edges of what a road accepts: along each edge, across
 * the carriageway, the kerb, the sidewalk and beyond it; exactly at the
 * borders; around the bends and past the open ends; with heights around the
 * road's own (decks, the ceiling) and far above.
 */
function probeEdges(edges: Iterable<Edge>, rand: () => number, perEdge: number, out: number[]): void {
  for (const e of edges) {
    const half = e.width / 2;
    const swMax = Math.max(e.swL, e.swR);
    const cum = e.pl.cum;
    for (let k = 0; k < perEdge; k++) {
      const s = -4 + rand() * (e.len + 8);
      samplePolyline(e.pl, Math.max(0, Math.min(e.len, s)), tmpS);
      const lx = tmpS.tz;
      const lz = -tmpS.tx;
      const side = rand() < 0.5 ? 1 : -1;
      const sw = side > 0 ? e.swL : e.swR;
      const r = rand();
      // across the whole width, or exactly on the borders (± a hair)
      const borders = [half, half + sw, half + swMax, half + swMax + 0.5, half + sw + 0.2];
      const off = r < 0.6 ? side * rand() * (half + swMax + 2) : side * (borders[(rand() * borders.length) | 0] + (rand() - 0.5) * 1e-9);
      const along = s < 0 ? s : s > e.len ? s - e.len : 0;
      const x = tmpS.x + lx * off + tmpS.tx * along;
      const z = tmpS.z + lz * off + tmpS.tz * along;
      const yRef = rand() < 0.1 ? 300 : tmpS.y + (rand() - 0.5) * 6;
      out.push(x, z, yRef);
    }
    // round the vertices: at the reach and just beyond it
    for (let i = 0; i < cum.length; i++) {
      const vx = e.pl.pts[i * 3];
      const vy = e.pl.pts[i * 3 + 1];
      const vz = e.pl.pts[i * 3 + 2];
      for (const d of [half + e.swL, half + e.swR, half + swMax + 0.19, half + swMax + 0.21, half + swMax + 0.5, rand() * (half + swMax + 1)]) {
        const a = rand() * Math.PI * 2;
        out.push(vx + Math.cos(a) * d, vz + Math.sin(a) * d, vy + (rand() - 0.5) * 3);
      }
    }
  }
}

/** Points around junction areas and their kerbed corners. */
function probeNodes(nodes: Iterable<Node>, rand: () => number, perNode: number, out: number[]): void {
  for (const n of nodes) {
    const sh = n.shape;
    if (!sh) continue;
    for (let k = 0; k < perNode; k++) {
      out.push(sh.minX - 5 + rand() * (sh.maxX - sh.minX + 10), sh.minZ - 5 + rand() * (sh.maxZ - sh.minZ + 10), n.y + (rand() - 0.5) * 4);
    }
    for (const c of sh.corners) {
      const kerb = c.kerb;
      for (let i = 0; i < kerb.length; i += 2) {
        const r = rand() * Math.max(c.swA, c.swB, 0.5) * 1.3;
        const a = rand() * Math.PI * 2;
        out.push(kerb[i] + Math.cos(a) * r, kerb[i + 1] + Math.sin(a) * r, n.y + (rand() - 0.5) * 2);
      }
    }
  }
}

function randomPoints(cx: number, cz: number, half: number, y: number, n: number, rand: () => number, out: number[]): void {
  for (let i = 0; i < n; i++) out.push(cx + (rand() * 2 - 1) * half, cz + (rand() * 2 - 1) * half, y + (rand() - 0.5) * 40);
}

// ---------------------------------------------------------------------------
// synthetic towns

/**
 * A grid town given what the real streets have: bends (and a doubled point),
 * pavements of different widths on the two sides, parking strips and lowered
 * or flush kerbs, raised tables and humps, a road crossing over another, and
 * mouths over a continuous pavement.
 */
function variedTown(): WorldJson {
  const town = makeTown({ cols: 5, rows: 4, block: 90, pavement: 2, deadEnd: 70 });
  const json = structuredClone(town.json);
  const rand = rng(7);
  json.edges.forEach((e, i) => {
    // a bend in the middle (and a point given twice: a segment of length zero)
    const p = e.p;
    const n = p.length / 3;
    if (n === 2 && i % 3 !== 2) {
      const [ax, ay, az, bx, by, bz] = p;
      const dx = bx - ax;
      const dz = bz - az;
      const l = Math.hypot(dx, dz);
      const bend = (rand() - 0.5) * 12;
      const pts = [ax, ay, az];
      for (const t of [0.3, 0.5, 0.7]) {
        const k = Math.sin(Math.PI * t) * bend;
        pts.push(ax + dx * t + (dz / l) * k, ay + (by - ay) * t + (i % 4 === 0 ? 3 * Math.sin(Math.PI * t) : 0), az + dz * t - (dx / l) * k);
        if (i % 5 === 0 && t === 0.5) pts.push(pts[pts.length - 3], pts[pts.length - 2], pts[pts.length - 1]);
      }
      pts.push(bx, by, bz);
      e.p = pts;
    }
    e.sl = [0, 1.5, 2.5, 4.2][i % 4];
    e.sr = [3, 0, 1.8, 2.2][(i >> 1) % 4];
    if (i % 3 === 0) e.xl = { p: PARK.STREET_SIDE, k: 1 };
    if (i % 4 === 1) e.xr = { p: PARK.HALF_ON_KERB, k: 2, v: 1.2 };
    if (i % 3 === 1) e.cm = [20, CALM.TABLE, 4, 0.08, 45, CALM.HUMP, 3.7, 0.08];
    if (i % 6 === 2) e.cm = [30, CALM.BUMP, 0.6, 0.06];
    if (i % 7 === 3) e.mk = 1;
    if (i % 5 === 4) e.md = 1;
  });
  // a road on a bridge across the town, at 8 m above it
  const top = json.nodes.length;
  json.nodes.push({ x: -40, y: 108, z: 125, t: 0, arms: [{ e: json.edges.length, r: 0 }] }, { x: 400, y: 108, z: 145, t: 0, arms: [{ e: json.edges.length, r: 0 }] });
  json.edges.push({ ...json.edges[0], a: top, b: top + 1, p: [-40, 108, 125, 180, 109, 135, 400, 108, 145], w: 7, sl: 1.5, sr: 0, cm: undefined, mk: undefined, xl: undefined, xr: undefined, md: undefined, x: undefined, bn: undefined });
  computeAllCuts(json);
  return json;
}

/** Its junctions sorted into pieces (as the map build cuts a map into chunks), each with every road at them. */
function pieces(json: WorldJson, n: number): WorldChunkJson[] {
  const out: WorldChunkJson[] = [];
  for (let k = 0; k < n; k++) out.push({ v: 1, nodes: [], edges: [], signals: [] });
  json.nodes.forEach((node, i) => {
    const c = out[Math.min(n - 1, Math.max(0, Math.floor(((node.x + 50) / 500) * n)))];
    c.nodes.push([i, node]);
    for (const arm of node.arms) if (!c.edges.some((e) => e[0] === arm.e)) c.edges.push([arm.e, { ...json.edges[arm.e], p: [], q: packEdgePoints(json.edges[arm.e].p) }]);
  });
  return out;
}

const emptyOf = (json: WorldJson): WorldJson => ({ ...json, nodes: [], edges: [], banned: [], signals: [], crossings: [] });

function townPoints(world: World, seed: number): number[] {
  const rand = rng(seed);
  const pts: number[] = [];
  randomPoints(180, 140, 260, 104, 6000, rand, pts);
  probeEdges(world.allEdges, rand, 60, pts);
  probeNodes(world.allNodes, rand, 30, pts);
  return pts;
}

test('surfaceAt with segment boxes: the same as before on a varied town, in one piece', () => {
  const json = variedTown();
  const world = new World(json);
  const pts = townPoints(world, 1);
  const on = compare(world, pts, 'town');
  assert.ok(on > pts.length / 3 / 4, `enough of the points on a road (${on})`);
});

test('surfaceAt with segment boxes: the same as before while pieces of the town come and go', () => {
  const json = variedTown();
  const parts = pieces(json, 4);
  const world = new World(emptyOf(json));
  const rand = rng(3);
  const ids = parts.map((p) => p.nodes.map((n) => n[0]));
  const loaded = new Set<number>();
  // roads first, junctions later – as the loader adds them – and pieces dropped and taken again
  const steps: Array<[string, number]> = [
    ['edges', 1], ['nodes', 1], ['edges', 2], ['edges', 0], ['nodes', 2], ['nodes', 0], ['drop', 1], ['edges', 3], ['nodes', 3],
    ['drop', 0], ['drop', 2], ['edges', 1], ['nodes', 1], ['edges', 0], ['nodes', 0], ['drop', 3], ['edges', 2], ['nodes', 2], ['edges', 3], ['nodes', 3],
  ];
  for (const [what, k] of steps) {
    if (what === 'edges') world.add({ ...parts[k], nodes: [] });
    else if (what === 'nodes') {
      world.add({ ...parts[k], edges: [], signals: [] });
      loaded.add(k);
    } else {
      world.remove(ids[k]);
      loaded.delete(k);
    }
    const pts: number[] = [];
    randomPoints(180, 140, 260, 104, 1500, rand, pts);
    probeEdges(world.allEdges, rand, 15, pts);
    probeNodes(world.allNodes, rand, 10, pts);
    compare(world, pts, `town after ${what} ${k}`);
  }
  // all in again: the same as the town in one piece
  const whole = new World(json);
  const pts = townPoints(whole, 9);
  const a = newSurfaceHit();
  const b = newSurfaceHit();
  for (let i = 0; i < pts.length; i += 3) {
    const ra = world.surfaceAt(pts[i], pts[i + 1], pts[i + 2], a);
    const rb = whole.surfaceAt(pts[i], pts[i + 1], pts[i + 2], b);
    assert.equal(ra, rb);
    assert.ok(Object.is(a.y, b.y) && Object.is(a.s, b.s) && Object.is(a.off, b.off) && a.zone === b.zone && a.edge?.id === b.edge?.id && a.node?.id === b.node?.id);
  }
});

test('a segment box (in its cell of the grid) holds everything the segment can give', () => {
  // what the old lookup (no boxes) found on a segment lies in that segment's box: the farthest it reaches
  // is half + the sidewalk of that side, √(reach² + 0.04) past an open end
  const json = variedTown();
  const world = new World(json);
  const grid = (world as unknown as { segGrid: SegGrid }).segGrid;
  const rand = rng(11);
  const hit = newSurfaceHit();
  const ref = referenceSurfaceAt(world);
  let checked = 0;
  for (const e of world.allEdges) {
    for (let k = 0; k < 400; k++) {
      const s = -1 + rand() * (e.len + 2);
      samplePolyline(e.pl, Math.max(0, Math.min(e.len, s)), tmpS);
      const off = (rand() * 2 - 1) * (e.width / 2 + Math.max(e.swL, e.swR) + 0.5);
      const x = tmpS.x + tmpS.tz * off + tmpS.tx * (s - Math.max(0, Math.min(e.len, s)));
      const z = tmpS.z - tmpS.tx * off + tmpS.tz * (s - Math.max(0, Math.min(e.len, s)));
      if (!ref(x, z, 1000, hit) || hit.edge !== e) continue;
      // the segment it was found on lies around it
      const p: PolyProjection = { s: 0, off: 0, d2: 0, seg: 0 };
      const cell = grid.cellAt(x, z)!;
      assert.equal(cell.boxes.length, cell.codes.length * 4);
      let inside = false;
      for (let i = 0; i < e.pl.cum.length - 1; i++) {
        projectOnPolyline(e.pl, x, z, p, i, i);
        if (Math.abs(p.s - hit.s) > 1e-9 || p.off !== hit.off) continue;
        const j = cell.codes.indexOf(e.id * 4096 + i);
        const b = cell.boxes;
        inside ||= j >= 0 && x >= b[j * 4] && z >= b[j * 4 + 1] && x <= b[j * 4 + 2] && z <= b[j * 4 + 3];
      }
      assert.ok(inside, `edge ${e.id} at (${x}, ${z})`);
      checked++;
    }
  }
  assert.ok(checked > 1000);
});

test('the segment grid holds its codes as Grid2 did (same cells, same order), each with its own box', () => {
  const rand = rng(17);
  const sg = new SegGrid(40);
  const g2 = new Grid2<number>(40);
  const placed = new Map<number, number[]>();
  const boxOf = (code: number): number[] => [code * 0.5, -code, code + 0.25, code * 3];
  for (let step = 0; step < 6000; step++) {
    const live = [...placed.keys()];
    if (live.length > 0 && rand() < 0.45) {
      const code = live[(rand() * live.length) | 0];
      const [x0, z0, x1, z1] = placed.get(code)!;
      sg.removeBox(x0, z0, x1, z1, code);
      g2.removeBox(x0, z0, x1, z1, code);
      placed.delete(code);
    } else {
      const code = ((rand() * 300) | 0) * 4096 + ((rand() * 50) | 0);
      if (placed.has(code)) continue;
      const x0 = (rand() - 0.5) * 400;
      const z0 = (rand() - 0.5) * 400;
      const box = [x0, z0, x0 + rand() * 90, z0 + rand() * 90];
      const [bx0, bz0, bx1, bz1] = boxOf(code);
      sg.insertBox(box[0], box[1], box[2], box[3], code, bx0, bz0, bx1, bz1);
      g2.insertBox(box[0], box[1], box[2], box[3], code);
      placed.set(code, box);
    }
    if (step % 50 === 0) {
      for (let x = -260; x <= 260; x += 40) {
        for (let z = -260; z <= 260; z += 40) {
          assert.deepEqual(sg.at(x, z), g2.at(x, z));
          const cell = sg.cellAt(x, z);
          if (!cell) continue;
          assert.equal(cell.boxes.length, cell.codes.length * 4);
          cell.codes.forEach((c, i) => assert.deepEqual(cell.boxes.slice(i * 4, i * 4 + 4), boxOf(c)));
          const a: number[] = [];
          const b: number[] = [];
          sg.queryBox(x - 50, z - 30, x + 20, z + 70, (c) => a.push(c));
          g2.queryBox(x - 50, z - 30, x + 20, z + 70, (c) => b.push(c));
          assert.deepEqual(a, b);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// the real map

const CENTRE = [690, -295] as const;
const RURAL = [-9000, 9000] as const;

function near(world: World, x: number, z: number, r: number): { edges: Edge[]; nodes: Node[] } {
  const edges: Edge[] = [];
  const nodes: Node[] = [];
  for (const e of world.allEdges) if (e.maxX > x - r && e.minX < x + r && e.maxZ > z - r && e.minZ < z + r) edges.push(e);
  for (const n of world.allNodes) if (n.shape && Math.abs(n.x - x) < r && Math.abs(n.z - z) < r) nodes.push(n);
  return { edges, nodes };
}

/** Points over an area of the real map: anywhere, and on the roads with what the detail region gave them. */
function realPoints(world: World, x: number, z: number, r: number, seed: number, scale = 1): number[] {
  const rand = rng(seed);
  const { edges, nodes } = near(world, x, z, r);
  const pts: number[] = [];
  const y = nodes.length ? nodes[0].y : 200;
  randomPoints(x, z, r, y, Math.round(8000 * scale), rand, pts);
  // the special ones: tables and humps, flush mouths, parking strips, kerbs of other heights, medians, uneven pavements
  const special = edges.filter((e) => e.calm || e.mouth || e.xl || e.xr || e.median || e.swL !== e.swR);
  probeEdges(special, rand, Math.round(40 * scale), pts);
  probeEdges(edges.filter((_, i) => i % 3 === 0), rand, Math.round(8 * scale), pts);
  probeNodes(nodes.filter((n) => n.arms.some((a) => a.edge.mouth) || n.id % 2 === 0), rand, Math.round(10 * scale), pts);
  return pts;
}

test('surfaceAt with segment boxes: the same as before on the real map, while its pieces come and go', { skip: !haveMap && 'no map in public/map' }, async (t) => {
  const before0 = compared;
  const real = await openRealMap();
  const { world, map } = real;
  await map.loadAround(CENTRE[0], CENTRE[1], 300);
  const special = near(world, CENTRE[0], CENTRE[1], 2000).edges;
  assert.ok(special.some((e) => e.calm), 'tables or humps near the centre');
  assert.ok(special.some((e) => e.mouth), 'mouths over a continuous pavement near the centre');
  assert.ok(special.some((e) => e.xl?.p || e.xr?.p), 'parking strips near the centre');
  for (const e of world.allEdges) assert.ok(e.pl.cum.length - 1 < 4096, 'segment codes stay apart');
  // the centre and what the detail region gave its roads
  let on = compare(world, realPoints(world, CENTRE[0], CENTRE[1], 2000, 21), 'centre');
  assert.ok(on > 5000, `points on roads in the centre: ${on}`);
  on = compare(world, realPoints(world, CENTRE[0], CENTRE[1], 250, 22), 'centre (close)');
  // a rural area
  await map.loadAround(RURAL[0], RURAL[1], 300);
  on = compare(world, realPoints(world, RURAL[0], RURAL[1], 1500, 23), 'rural');
  assert.ok(on > 300, `points on roads in the country: ${on}`);
  // drop what is far from the rural area, one chunk at a time, asking in between
  map.keepRadius = 1000;
  map.loadRadius = 300;
  const before = world.allEdges.size;
  for (let k = 0; k < 12; k++) {
    map.update(RURAL[0], RURAL[1], 4);
    await new Promise((r) => setTimeout(r, 0));
    compare(world, realPoints(world, CENTRE[0], CENTRE[1], 600, 30 + k, 0.15), `centre while dropping (${k})`);
  }
  assert.ok(world.allEdges.size < before, 'pieces were dropped');
  // and back to the centre: its pieces come again, a portion at a time (roads first, junctions after)
  for (let k = 0; k < 400; k++) {
    map.update(CENTRE[0], CENTRE[1], 0);
    await new Promise((r) => setTimeout(r, k < 5 ? 50 : 0));
    if (k % 4 === 0) compare(world, realPoints(world, CENTRE[0], CENTRE[1], 400, 60 + k, 0.08), `centre while loading (${k})`);
    if (map.ready(CENTRE[0], CENTRE[1], 300) && k > 20) break;
  }
  await map.loadAround(CENTRE[0], CENTRE[1], 300);
  compare(world, realPoints(world, CENTRE[0], CENTRE[1], 2000, 99), 'centre again');
  compare(world, realPoints(world, RURAL[0], RURAL[1], 1500, 98, 0.3), 'rural again');
  t.diagnostic(`${compared - before0} points compared on the real map`);
});

// ---------------------------------------------------------------------------
// the terrain tiles: heightAt / coverAt with the tile remembered

/** The old lookups (a copy): a key string and a map lookup every time. */
function refHeightAt(tm: TileManager, grid: { x0: number; z0: number; size: number }, x: number, z: number): number {
  const { x0: minX, z0: minZ, size: tileSize } = grid;
  const ix = Math.floor((x - minX) / tileSize);
  const iz = Math.floor((z - minZ) / tileSize);
  const tile = tm.tiles.get(tileKey(ix, iz));
  if (!tile) return NaN;
  const n = tile.header.terrainN;
  const step = tileSize / (n - 1);
  const fx = Math.max(0, Math.min(n - 1.0001, (x - (minX + ix * tileSize)) / step));
  const fz = Math.max(0, Math.min(n - 1.0001, (z - (minZ + iz * tileSize)) / step));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const hh = tile.heights;
  const k = j * n + i;
  const h00 = hh[k];
  const h10 = hh[k + 1];
  const h01 = hh[k + n];
  const h11 = hh[k + n + 1];
  return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
}

function refCoverAt(tm: TileManager, grid: { x0: number; z0: number; size: number }, x: number, z: number): number {
  const { x0: minX, z0: minZ, size: tileSize } = grid;
  const ix = Math.floor((x - minX) / tileSize);
  const iz = Math.floor((z - minZ) / tileSize);
  const tile = tm.tiles.get(tileKey(ix, iz));
  if (!tile) return 0;
  const cn = tile.header.coverN;
  const cov = tile.cover;
  const cx = Math.max(0, Math.min(cn - 1, Math.floor(((x - (minX + ix * tileSize)) / tileSize) * cn)));
  const cz = Math.max(0, Math.min(cn - 1, Math.floor(((z - (minZ + iz * tileSize)) / tileSize) * cn)));
  return cov[cz * cn + cx];
}

test('heightAt / coverAt with the last tile remembered: the same as before while tiles come and go', async () => {
  const grid = { x0: -1000, z0: -750, size: 250, has: () => true };
  // 6 × 6 tiles of random ground, served as a map server would
  const rand = rng(5);
  const files = new Map<string, Uint8Array>();
  for (let ix = 0; ix < 6; ix++) {
    for (let iz = 0; iz < 6; iz++) {
      const n = 9 + ((ix + iz) % 3) * 8;
      const cn = 16 + ((ix * iz) % 2) * 16;
      const hgt = new Uint16Array(n * n);
      for (let i = 0; i < hgt.length; i++) hgt[i] = (rand() * 65535) | 0;
      const cov = new Uint8Array(cn * cn);
      for (let i = 0; i < cov.length; i++) cov[i] = (rand() * 12) | 0;
      const header = { v: 3, ix, iz, cx: grid.x0 + (ix + 0.5) * grid.size, cz: grid.z0 + (iz + 0.5) * grid.size, yBase: 150, size: grid.size, terrainN: n, terrainMin: 140 + rand() * 20, terrainScale: 0.01, coverN: cn, signs: [], objects: [] };
      files.set(tileKey(ix, iz), packTile(header, { hgt, cov }));
    }
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const key = String(url).replace(/^mem\/tiles\//, '').replace(/\.fsb.*$/, '');
    const f = files.get(key);
    return f ? new Response(f.slice()) : new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    const tm = new TileManager(grid, 'mem/');
    const inside = tm as unknown as { build(key: string, data: unknown): LoadedTile; load(key: string): Promise<void>; unload(tile: LoadedTile): void };
    // (no meshes needed here: only what the lookups read)
    inside.build = (key, data) => {
      const d = data as LoadedTile['data'];
      const h = d.header;
      const hgt = d.get('hgt') as Uint16Array;
      const heights = new Float32Array(hgt.length);
      for (let i = 0; i < hgt.length; i++) heights[i] = h.terrainMin + hgt[i] * h.terrainScale;
      return { key, header: h, group: new THREE.Group(), heights, cover: d.get('cov') as Uint8Array, data: d, disposables: [] };
    };
    const ask = (n: number, label: string): void => {
      let x = grid.x0 + rand() * 1500;
      let z = grid.z0 + rand() * 1500;
      for (let i = 0; i < n; i++) {
        // mostly small steps (as the wheels go), now and then a jump; some off the map, some on tile borders
        const r = rand();
        if (r < 0.05) {
          x = grid.x0 - 300 + rand() * 2100;
          z = grid.z0 - 300 + rand() * 2100;
        } else if (r < 0.1) {
          x = grid.x0 + Math.round(rand() * 6) * grid.size + (rand() < 0.5 ? 0 : -1e-9);
          z = grid.z0 + Math.round(rand() * 6) * grid.size;
        } else {
          x += (rand() - 0.5) * 3;
          z += (rand() - 0.5) * 3;
        }
        const h = tm.heightAt(x, z);
        const hr = refHeightAt(tm, grid, x, z);
        if (!Object.is(h, hr)) assert.fail(`${label}: heightAt(${x}, ${z}) = ${h}, before ${hr}`);
        const c = tm.coverAt(x, z);
        const cr = refCoverAt(tm, grid, x, z);
        if (c !== cr) assert.fail(`${label}: coverAt(${x}, ${z}) = ${c}, before ${cr}`);
      }
    };
    const keys = [...files.keys()];
    ask(500, 'nothing loaded');
    for (let step = 0; step < 60; step++) {
      // a tile comes or goes – often the one asked about last
      const loadedKeys = [...tm.tiles.keys()];
      if (loadedKeys.length > 0 && rand() < 0.4) {
        const t = tm.tiles.get(loadedKeys[(rand() * loadedKeys.length) | 0])!;
        inside.unload(t);
      } else {
        const key = keys[(rand() * keys.length) | 0];
        if (!tm.tiles.has(key)) await inside.load(key);
      }
      ask(800, `step ${step}`);
      // the tile under the last point goes, and the same point is asked again
      const x = grid.x0 + rand() * 1500;
      const z = grid.z0 + rand() * 1500;
      tm.heightAt(x, z);
      const t = tm.tiles.get(tileKey(Math.floor((x - grid.x0) / grid.size), Math.floor((z - grid.z0) / grid.size)));
      if (t) {
        inside.unload(t);
        assert.ok(Number.isNaN(tm.heightAt(x, z)) && tm.coverAt(x, z) === 0, 'a tile that went is not used any more');
        await inside.load(t.key);
        assert.ok(Object.is(tm.heightAt(x, z), refHeightAt(tm, grid, x, z)), 'and the one that came again is');
      } else {
        // not loaded: asked for, it comes, and the lookup sees it
        assert.ok(Number.isNaN(tm.heightAt(x, z)));
        const key = tileKey(Math.floor((x - grid.x0) / grid.size), Math.floor((z - grid.z0) / grid.size));
        if (files.has(key)) {
          await inside.load(key);
          assert.ok(!Number.isNaN(tm.heightAt(x, z)) && Object.is(tm.heightAt(x, z), refHeightAt(tm, grid, x, z)));
        }
      }
    }
    assert.ok(tm.tiles.size > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
