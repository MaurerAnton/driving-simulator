// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A small town for tests: streets on a square grid, built the way the map
 * build hands a road network to the game (world.json) – without needing the
 * real map.
 */
import { angleOf } from '../../src/core/geom.ts';
import { LaneGraph } from '../../src/world/lanes.ts';
import { CLS, CTRL, EF, ROLE } from '../../src/world/types.ts';
import type { EdgeJson, NodeJson, WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts } from '../../src/world/world.ts';

export interface Town {
  /** the town as the map build writes a map in one piece */
  json: WorldJson;
  world: World;
  lanes: LaneGraph;
  /** the node at column i, row j of the grid */
  node(i: number, j: number): number;
  /** the street between two neighbouring nodes of the grid (its edge) */
  street(i0: number, j0: number, i1: number, j1: number): number;
}

export interface TownOptions {
  /** streets along the columns and rows: `cols` × `rows` junctions, `block` metres apart */
  cols?: number;
  rows?: number;
  block?: number;
  /** streets (given by the grid points they join) that may only be driven from the first point to the second */
  oneWay?: Array<[number, number, number, number]>;
  /** streets that are left out */
  missing?: Array<[number, number, number, number]>;
  /** a cul-de-sac of this length (m) leading east from the last junction of the first row */
  deadEnd?: number;
}

export function makeTown(opt: TownOptions = {}): Town {
  const cols = opt.cols ?? 4;
  const rows = opt.rows ?? 4;
  const block = opt.block ?? 100;
  const nodes: NodeJson[] = [];
  const edges: EdgeJson[] = [];
  const at = (i: number, j: number): number => j * cols + i;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) nodes.push({ x: i * block, y: 100, z: j * block, t: CTRL.NONE, arms: [] });
  const key = (a: number, b: number): string => `${Math.min(a, b)}-${Math.max(a, b)}`;
  const byKey = new Map<string, number>();
  const same = (list: Array<[number, number, number, number]> | undefined, a: number, b: number): number => {
    for (const [i0, j0, i1, j1] of list ?? []) {
      if (at(i0, j0) === a && at(i1, j1) === b) return 1;
      if (at(i0, j0) === b && at(i1, j1) === a) return -1;
    }
    return 0;
  };
  const join = (a: number, b: number): void => {
    if (same(opt.missing, a, b) !== 0) return;
    const way = same(opt.oneWay, a, b);
    const one = way !== 0;
    const A = nodes[a];
    const B = nodes[b];
    const p: number[] = [];
    const n = Math.max(1, Math.round(Math.hypot(B.x - A.x, B.z - A.z) / 20));
    for (let k = 0; k <= n; k++) p.push(A.x + ((B.x - A.x) * k) / n, 100, A.z + ((B.z - A.z) * k) / n);
    byKey.set(key(a, b), edges.length);
    edges.push({
      a,
      b,
      c: CLS.RESIDENTIAL,
      n: `Street ${edges.length}`,
      p,
      lf: one && way < 0 ? 0 : 1,
      lb: one && way > 0 ? 0 : 1,
      lw: one ? 3.5 : 2.75,
      w: one ? 3.5 : 5.5,
      mf: 50,
      mb: 50,
      f: EF.URBAN,
      ca: 0,
      cb: 0,
    });
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (i + 1 < cols) join(at(i, j), at(i + 1, j));
      if (j + 1 < rows) join(at(i, j), at(i, j + 1));
    }
  }
  if (opt.deadEnd) {
    const from = at(cols - 1, 0);
    nodes.push({ x: nodes[from].x + opt.deadEnd, y: 100, z: nodes[from].z, t: CTRL.NONE, arms: [] });
    join(from, nodes.length - 1);
  }
  // the arms of each junction, counter-clockwise
  nodes.forEach((node, ni) => {
    const arms: Array<{ e: number; ang: number }> = [];
    edges.forEach((e, ei) => {
      if (e.a !== ni && e.b !== ni) return;
      const other = nodes[e.a === ni ? e.b : e.a];
      arms.push({ e: ei, ang: angleOf(other.x - node.x, other.z - node.z) });
    });
    arms.sort((p, q) => p.ang - q.ang);
    node.arms = arms.map((a) => ({ e: a.e, r: arms.length > 2 ? ROLE.RBL : ROLE.NONE }));
    node.t = arms.length > 2 ? CTRL.RBL : CTRL.NONE;
  });
  const json: WorldJson = {
    version: 1,
    meta: { name: 'Test town', generated: '', minX: -200, maxX: cols * block + 400, minZ: -200, maxZ: rows * block + 200, tileSize: 500, originE: 0, originN: 0, attribution: [] },
    nodes,
    edges,
    banned: [],
    signals: [],
    crossings: [],
    places: [],
    spawns: [],
    tiles: [],
  };
  computeAllCuts(json);
  const world = new World(json);
  return {
    json,
    world,
    lanes: new LaneGraph(world),
    node: at,
    street: (i0, j0, i1, j1) => {
      const e = byKey.get(key(at(i0, j0), at(i1, j1)));
      if (e === undefined) throw new Error('no such street');
      return e;
    },
  };
}
