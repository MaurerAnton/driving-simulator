// SPDX-License-Identifier: AGPL-3.0-only
// A line drawn on the map laid onto the roads (src/ui/pathdraw.ts): on a grid of streets 100 m apart.
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchStroke, previewOf } from '../../src/ui/pathdraw.ts';
import type { RoadSource } from '../../src/ui/pathdraw.ts';
import { RG } from '../../src/world/routegraph.ts';
import type { RouteGraph } from '../../src/world/routegraph.ts';
import { TURN } from '../../src/world/lanes.ts';

/**
 * A grid of nx × nz junctions 100 m apart (junction (i, j) at x = 100 i,
 * z = 100 j): the streets of each row (west to east) come first, then those of
 * each column (north to south).  `oneWay(e)`: road e may only be driven from
 * its junction a to b.  Every turn is allowed, turning round only at a dead end.
 */
function grid(nx: number, nz: number, oneWay: (e: number) => boolean = () => false, noEntry: (w: number) => boolean = () => false) {
  const nodes: Array<[number, number]> = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) nodes.push([i * 100, j * 100]);
  const edges: Array<[number, number]> = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i + 1 < nx; i++) edges.push([j * nx + i, j * nx + i + 1]);
  for (let j = 0; j + 1 < nz; j++) for (let i = 0; i < nx; i++) edges.push([j * nx + i, (j + 1) * nx + i]);
  const n = edges.length * 2;
  const start = (w: number): number => edges[w >> 1][w & 1];
  const end = (w: number): number => edges[w >> 1][1 - (w & 1)];
  const len = new Float32Array(n);
  const kind = new Uint8Array(n);
  for (let w = 0; w < n; w++) {
    len[w] = (w & 1) === 1 && oneWay(w >> 1) ? 0 : 100;
    if (noEntry(w)) kind[w] |= RG.NO_ENTRY;
  }
  const first = new Uint32Array(n + 1);
  const to: number[] = [];
  const turn: number[] = [];
  const across: number[] = [];
  for (let w = 0; w < n; w++) {
    first[w] = to.length;
    const outs: number[] = [];
    for (let t = 0; t < n; t++) if (len[t] > 0 && start(t) === end(w) && t !== (w ^ 1)) outs.push(t);
    if (outs.length === 0 && len[w ^ 1] > 0) outs.push(w ^ 1);
    for (const t of outs) {
      to.push(t);
      turn.push(t === (w ^ 1) ? TURN.UTURN : TURN.STRAIGHT);
      across.push(5);
    }
  }
  first[n] = to.length;
  const g: RouteGraph = {
    n,
    len,
    secs: Float32Array.from(len, (l) => l / 14),
    kind,
    cls: new Uint8Array(n),
    x0: Float32Array.from({ length: n }, (_, w) => nodes[start(w)][0]),
    z0: Float32Array.from({ length: n }, (_, w) => nodes[start(w)][1]),
    x1: Float32Array.from({ length: n }, (_, w) => nodes[end(w)][0]),
    z1: Float32Array.from({ length: n }, (_, w) => nodes[end(w)][1]),
    first,
    to: Uint32Array.from(to),
    turn: Uint8Array.from(turn),
    across: Float32Array.from(across),
    firstIn: new Uint32Array(n + 1),
    from: new Uint32Array(0),
    inTurn: new Uint32Array(0),
  };
  const roads: RoadSource = {
    g,
    roadsIn: (minX, minZ, maxX, maxZ, visit) => {
      edges.forEach(([a, b], e) => {
        const [ax, az] = nodes[a];
        const [bx, bz] = nodes[b];
        if (Math.max(ax, bx) >= minX && Math.min(ax, bx) <= maxX && Math.max(az, bz) >= minZ && Math.min(az, bz) <= maxZ) visit(e);
      });
    },
    course: (e) => {
      const [a, b] = edges[e];
      return [nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1]];
    },
  };
  /** the way from junction (i1, j1) to the neighbouring junction (i2, j2) */
  const way = (i1: number, j1: number, i2: number, j2: number): number => {
    const a = j1 * nx + i1;
    const b = j2 * nx + i2;
    const e = edges.findIndex(([p, q]) => (p === a && q === b) || (p === b && q === a));
    assert.ok(e >= 0, 'no such street');
    return e * 2 + (edges[e][0] === a ? 0 : 1);
  };
  return { g, roads, way, edges };
}

/** A hand-drawn line through these points, a little off the road and wobbling. */
function stroke(...pts: Array<[number, number]>): number[] {
  const out: number[] = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k];
    const [bx, bz] = pts[k + 1];
    const n = Math.max(2, Math.round(Math.hypot(bx - ax, bz - az) / 7));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      out.push(ax + (bx - ax) * t + Math.sin(i * 1.7) * 3, az + (bz - az) * t + Math.cos(i * 2.3) * 3);
    }
  }
  const [lx, lz] = pts[pts.length - 1];
  out.push(lx, lz);
  return out;
}

test('a line along a street is laid onto it, in the direction it was drawn', () => {
  const { roads, way } = grid(4, 3);
  const m = matchStroke(stroke([10, 104], [290, 97]), roads);
  assert.ok(m, 'matched');
  assert.deepEqual(m.ways, [way(0, 1, 1, 1), way(1, 1, 2, 1), way(2, 1, 3, 1)]);
  assert.ok(Math.abs(m.metres - 280) < 6, `${m.metres} m`);
  // on the road itself, from where the drawing began to where it ended
  assert.ok(Math.abs(m.start.x - 10) < 4 && Math.abs(m.start.z - 100) < 0.01);
  assert.ok(Math.abs(m.end.x - 290) < 4 && Math.abs(m.end.z - 100) < 0.01);
  // east: yaw −90° (forward = (−sin yaw, −cos yaw))
  assert.ok(Math.abs(m.start.yaw + Math.PI / 2) < 0.01);
  // drawn the other way round: the other direction of the same streets
  const back = matchStroke(stroke([290, 97], [10, 104]), roads);
  assert.deepEqual(back?.ways, [way(3, 1, 2, 1), way(2, 1, 1, 1), way(1, 1, 0, 1)]);
});

test('a turn drawn at a junction follows the street turned into', () => {
  const { roads, way } = grid(4, 4);
  // east along the second row, then south down the third column
  const m = matchStroke(stroke([20, 103], [196, 98], [203, 290]), roads);
  assert.ok(m);
  assert.deepEqual(m.ways, [way(0, 1, 1, 1), way(1, 1, 2, 1), way(2, 1, 2, 2), way(2, 2, 2, 3)]);
  // the line runs through the corner of the junction
  let corner = false;
  for (let i = 0; i < m.line.length; i += 2) if (Math.hypot(m.line[i] - 200, m.line[i + 1] - 100) < 0.5) corner = true;
  assert.ok(corner);
});

test('a one-way street drawn against its direction is driven round, by legal turns only', () => {
  // the street from (1,1) to (2,1) may only be driven eastwards
  const probe = grid(4, 3);
  const e = probe.way(1, 1, 2, 1) >> 1;
  const { roads, g, way } = grid(4, 3, (k) => k === e);
  const m = matchStroke(stroke([290, 102], [10, 98]), roads);
  assert.ok(m);
  assert.ok(!m.ways.includes(e * 2 + 1), 'not against the one-way street');
  for (const w of m.ways) assert.ok(g.len[w] > 0, 'every way may be driven');
  // consecutive ways are joined by a turn of the junction between them
  for (let k = 1; k < m.ways.length; k++) {
    let ok = false;
    for (let q = g.first[m.ways[k - 1]]; q < g.first[m.ways[k - 1] + 1]; q++) if (g.to[q] === m.ways[k]) ok = true;
    assert.ok(ok, `turn ${m.ways[k - 1]} → ${m.ways[k]}`);
  }
  // it begins and ends where it was drawn
  assert.equal(m.ways[0], way(3, 1, 2, 1));
  assert.equal(m.ways[m.ways.length - 1], way(1, 1, 0, 1));
});

test('two strokes with a gap between them are joined by the shortest legal way', () => {
  const { roads, g, way } = grid(5, 3);
  // drawn on the first row near the west end, then again further east: the gap is closed along the row
  const a = stroke([10, 2], [90, -2]);
  const b = stroke([310, 3], [390, -1]);
  const m = matchStroke([...a, ...b], roads);
  assert.ok(m);
  assert.deepEqual(m.ways, [way(0, 0, 1, 0), way(1, 0, 2, 0), way(2, 0, 3, 0), way(3, 0, 4, 0)]);
  // … and across the blocks: from the first row to the last, by streets and the turns between them
  const c = matchStroke([...stroke([10, 2], [90, -2]), ...stroke([310, 203], [390, 199])], roads);
  assert.ok(c);
  assert.equal(c.ways[0], way(0, 0, 1, 0));
  assert.equal(c.ways[c.ways.length - 1], way(3, 2, 4, 2));
  for (let k = 1; k < c.ways.length; k++) {
    let ok = false;
    for (let q = g.first[c.ways[k - 1]]; q < g.first[c.ways[k - 1] + 1]; q++) if (g.to[q] === c.ways[k]) ok = true;
    assert.ok(ok, `turn ${c.ways[k - 1]} → ${c.ways[k]}`);
  }
  // (any staircase of streets from (10, 0) to (390, 200) is 380 m east and 200 m south long – no detour)
  assert.ok(c.metres > 565 && c.metres < 600, `${c.metres} m`);
});

test('roads not to be entered are not used', () => {
  const probe = grid(4, 3);
  const blocked = probe.way(1, 1, 2, 1);
  const { roads, way } = grid(4, 3, () => false, (w) => w === blocked || w === (blocked ^ 1));
  const m = matchStroke(stroke([10, 100], [290, 100]), roads);
  assert.ok(m);
  assert.ok(!m.ways.includes(blocked) && !m.ways.includes(blocked ^ 1));
  assert.equal(m.ways[0], way(0, 1, 1, 1));
  assert.equal(m.ways[m.ways.length - 1], way(2, 1, 3, 1));
});

test('nothing near any road: no way', () => {
  const { roads } = grid(3, 3);
  assert.equal(matchStroke(stroke([1000, 1000], [1200, 1100]), roads), null);
  assert.equal(matchStroke([], roads), null);
});

test('a matched way becomes a tour for the car to drive: from its first way on', () => {
  const { roads, way } = grid(4, 3);
  const m = matchStroke(stroke([10, 100], [290, 100]), roads);
  assert.ok(m);
  const p = previewOf(m);
  assert.equal(p.from, way(0, 1, 1, 1));
  assert.deepEqual(p.plan.ways, [way(1, 1, 2, 1), way(2, 1, 3, 1)]);
  assert.equal(p.plan.metres, m.metres);
  assert.ok(Math.abs(p.end.x - 290) < 4 && p.end.kind === 'street');
  assert.equal(p.line, m.line);
});
