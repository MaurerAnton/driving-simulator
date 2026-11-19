// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The speed limit the rule monitor reports (src/sim/rules.ts): a weak match –
 * a gap in the road surface, a junction area, the nearest-road fallback – must
 * not change it, or the 50 km/h of a town road on a bridge over the motorway
 * (or of a road under it) becomes the limit of the motorway, and the speed
 * limiter of the game (src/game/game.ts) holds the car there.
 *
 * The world is a motorway with a slip road joining it, and a 50 km/h town road
 * crossing 3.5 m above it on a bridge.
 *
 *   node --test tests/sim/limitmatch.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { angleOf } from '../../src/core/geom.ts';
import { RuleMonitor } from '../../src/sim/rules.ts';
import type { PlayerSnapshot } from '../../src/sim/rules.ts';
import { SignalSystem } from '../../src/sim/signals.ts';
import { Traffic } from '../../src/sim/traffic.ts';
import { LaneGraph } from '../../src/world/lanes.ts';
import { CLS, CTRL, ROLE } from '../../src/world/types.ts';
import type { EdgeJson, NodeJson, WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts, newSurfaceHit } from '../../src/world/world.ts';
import type { Edge } from '../../src/world/world.ts';

const DT = 1 / 10;
/** standing still, looking the way the road runs */
const EAST = Math.atan2(-1, 0); // travel +x
const NORTH = Math.PI; // travel +z

interface Road {
  a: number;
  b: number;
  cls?: number;
  lf?: number;
  lb?: number;
  lw?: number;
  max?: number;
  name?: string;
  flags?: number;
}

interface Net {
  world: World;
  lanes: LaneGraph;
  /** the roads, in the order they were given */
  edges: Edge[];
}

/** Straight roads between junctions at these points (x, y, z), built as the map build hands them to the game. */
function makeNet(points: Array<[number, number, number]>, roads: Road[]): Net {
  const nodes: NodeJson[] = points.map(([x, y, z]) => ({ x, y, z, t: CTRL.NONE, arms: [] }));
  const edges: EdgeJson[] = roads.map((r, i) => {
    const A = nodes[r.a];
    const B = nodes[r.b];
    const p: number[] = [];
    const n = Math.max(1, Math.round(Math.hypot(B.x - A.x, B.z - A.z) / 20));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      p.push(A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t, A.z + (B.z - A.z) * t);
    }
    const lf = r.lf ?? 1;
    const lb = r.lb ?? 1;
    const lw = r.lw ?? 3;
    return { a: r.a, b: r.b, c: r.cls ?? CLS.RESIDENTIAL, n: r.name ?? `Road ${i}`, p, lf, lb, lw, w: (lf + lb) * lw, mf: r.max ?? 50, mb: r.max ?? 50, f: r.flags ?? 0, ca: 0, cb: 0 };
  });
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
    meta: { name: 'Limit match', generated: '', minX: -3000, maxX: 3000, minZ: -3000, maxZ: 3000, tileSize: 500, originE: 0, originN: 0, attribution: [] },
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
  return { world, lanes: new LaneGraph(world), edges: world.edges.filter(Boolean) };
}

/**
 * A motorway (no limit) from x 0 to 400 with a slip road joining it at x 100,
 * and a 50 km/h town road crossing it 3.5 m above on a bridge at x 250.
 *
 *   0        100      250            400
 *   A========J========X==============B   motorway, y 100
 *            \                          slip road, y 100
 *             \
 *             |  town road, y 103.5 (50 km/h)
 */
function setUp(): Net {
  return makeNet(
    [
      [0, 100, 0],
      [100, 100, 0],
      [400, 100, 0],
      [160, 100, -70],
      [250, 103.5, -60],
      [250, 103.5, 60],
    ],
    [
      { a: 0, b: 1, cls: CLS.MOTORWAY, lf: 2, lb: 2, lw: 3.75, max: 0, name: 'A 99' },
      { a: 1, b: 2, cls: CLS.MOTORWAY, lf: 2, lb: 2, lw: 3.75, max: 0, name: 'A 99' },
      { a: 1, b: 3, cls: CLS.MOTORWAY_LINK, lf: 1, lb: 0, lw: 3.75, max: 80 },
      { a: 4, b: 5, cls: CLS.RESIDENTIAL, lf: 1, lb: 1, lw: 3, max: 50, name: 'Brückenstraße' },
    ],
  );
}

/** A still car at (x, y, z) looking `yaw` – what the monitor makes of it. */
function stand(rules: RuleMonitor, x: number, y: number, z: number, yaw: number): void {
  const snap: PlayerSnapshot = { x, y, z, yaw, speed: 0, indicator: 0, hazard: false, lookYaw: 0, seatbelt: true, handbrake: 0, stalled: false, hitScenery: 0, length: 4.3, front: 2.15 };
  rules.update(DT, snap, []);
}

function monitor(net: Net): RuleMonitor {
  const signals = new SignalSystem(net.world.signals);
  const traffic = new Traffic(net.world, net.lanes, signals);
  traffic.targetCount = 0;
  return new RuleMonitor(net.world, net.lanes, signals, traffic);
}

const hit = newSurfaceHit();

test('a gap in the road surface keeps the limit of the motorway under the bridge', () => {
  const net = setUp();
  const rules = monitor(net);
  // just outside the carriageway, directly under the town road 3.5 m above:
  // no road surface there, and the fallback must not take the road on the bridge
  assert.equal(net.world.surfaceAt(250, 9.6, 100.6, hit), false);
  stand(rules, 250, 100, 9.6, EAST);
  assert.equal(rules.context.limit, 0);
});

test('a junction area keeps the limit of the road the car came from', () => {
  const net = setUp();
  const rules = monitor(net);
  stand(rules, 85, 100, 0, EAST);
  assert.equal(rules.context.limit, 0);
  // the junction area of the interchange: its own surface, no carriageway of its own
  assert.equal(net.world.surfaceAt(100, 0, 100.6, hit) && hit.node !== null && hit.edge === null, true);
  stand(rules, 100, 100, 0, EAST);
  assert.equal(rules.context.limit, 0);
});

test('a gap with no road near keeps the limit of the road before it', () => {
  const net = setUp();
  const rules = monitor(net);
  stand(rules, 140, 100, 0, EAST);
  assert.equal(rules.context.limit, 0);
  // off the carriageway by more than the fallback reaches: neither a surface nor a road
  assert.equal(net.world.surfaceAt(150, 11, 100.6, hit), false);
  stand(rules, 150, 100, 11, EAST);
  assert.equal(rules.context.limit, 0);
});

test('the hold does not reach beyond 40 m', () => {
  const net = setUp();
  const rules = monitor(net);
  stand(rules, 140, 100, 0, EAST);
  stand(rules, 140, 100, 60, EAST);
  assert.equal(rules.context.limit, -1);
});

test('a solid hit on another road takes its limit at once', () => {
  const net = setUp();
  const rules = monitor(net);
  stand(rules, 240, 100, 0, EAST);
  assert.equal(rules.context.limit, 0);
  // on the town road of the bridge: its 50 counts from the first step on it
  const town = net.world.edges.find((e) => e && e.name === 'Brückenstraße');
  assert.ok(town);
  assert.equal(net.world.surfaceAt(250, 0, 104.1, hit) && hit.edge === town, true);
  stand(rules, 250, 103.5, 0, NORTH);
  assert.equal(rules.context.limit, 50);
});
