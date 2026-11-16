// SPDX-License-Identifier: AGPL-3.0-only
/** A road network that comes in pieces: the same network as in one piece, whatever is loaded and dropped on the way. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { followMap } from '../../src/sim/follow.ts';
import { GridSet } from '../../src/world/grid.ts';
import { LaneGraph } from '../../src/world/lanes.ts';
import { MapLoader } from '../../src/world/loader.ts';
import type { MapFiles } from '../../src/world/loader.ts';
import type { MapIndexJson, WorldChunkJson, WorldJson } from '../../src/world/types.ts';
import { World, edgePoints, packEdgePoints } from '../../src/world/world.ts';
import { makeTown } from '../game/town.ts';

/** The pieces of a map in one piece: its junctions sorted into chunks by `chunkOf`, each with every road at them. */
function cut(json: WorldJson, chunkOf: (x: number, z: number) => string): Map<string, WorldChunkJson> {
  const out = new Map<string, WorldChunkJson>();
  json.nodes.forEach((n, i) => {
    const key = chunkOf(n.x, n.z);
    let c = out.get(key);
    if (!c) out.set(key, (c = { v: 1, nodes: [], edges: [], signals: [] }));
    c.nodes.push([i, n]);
    for (const arm of n.arms) if (!c.edges.some((e) => e[0] === arm.e)) c.edges.push([arm.e, { ...json.edges[arm.e], p: [], q: packEdgePoints(json.edges[arm.e].p) }]);
  });
  return out;
}

const empty = (json: WorldJson): WorldJson => ({ ...json, nodes: [], edges: [], banned: [], signals: [], crossings: [] });
const count = (lanes: LaneGraph): [number, number] => [lanes.lanes.filter(Boolean).length, lanes.connectors.length];

test('the course of a road survives being packed into steps of whole centimetres', () => {
  const p = [12.34, 100.5, -7.01, 13.0, 100.56, -9.99, -250.25, 99.0, 1234.56];
  const back = edgePoints(packEdgePoints(p));
  assert.equal(back.length, p.length);
  for (let i = 0; i < p.length; i++) assert.ok(Math.abs(back[i] - p[i]) < 0.0051, `${back[i]} for ${p[i]}`);
});

test('a network added in two pieces is the network in one piece', () => {
  const town = makeTown({ cols: 6, rows: 5, oneWay: [[2, 1, 3, 1]], deadEnd: 90 });
  const whole = count(town.lanes);
  const pieces = cut(town.json, (x) => (x < 250 ? 'west' : 'east'));
  const world = new World(empty(town.json));
  const lanes = new LaneGraph(world);
  const add = (key: string): void => {
    const change = world.add(pieces.get(key) as WorldChunkJson);
    for (const e of change.edges) lanes.addEdge(e);
    for (const n of change.nodes) lanes.completeNode(n);
  };
  add('west');
  // the streets that lead on to the east end at junctions of which nothing else is known yet
  const stubs = [...world.allNodes].filter((n) => n.stub);
  assert.equal(stubs.length, 5, 'one for each street across the border');
  for (const n of stubs) {
    assert.equal(n.arms.length, 1);
    assert.equal(lanes.pathsThrough(n).length, 0, 'nothing leads through them');
  }
  assert.ok(count(lanes)[1] < whole[1]);
  add('east');
  assert.equal([...world.allNodes].filter((n) => n.stub).length, 0);
  assert.equal(world.allEdges.size, town.world.allEdges.size);
  assert.deepEqual(count(lanes), whole, 'as many lanes and paths through junctions as in one piece');
  // every junction has its roads in the same order, every road its ends
  for (const n of town.world.allNodes) {
    const m = world.nodes[n.id];
    assert.deepEqual(m.arms.map((a) => a.edge.id), n.arms.map((a) => a.edge.id), `junction ${n.id}`);
    assert.deepEqual(m.arms.map((a) => [a.out, a.role, Math.round(a.cut * 100)]), n.arms.map((a) => [a.out, a.role, Math.round(a.cut * 100)]));
    assert.equal(m.shape === null, n.shape === null);
  }
  // a way across the border between the pieces
  const from = lanes.edgeLanes[town.street(0, 0, 1, 0)].fwd[0];
  assert.ok(lanes.route(from, world.edges[town.street(4, 4, 5, 4)]), 'a route from one piece into the other');
});

test('a piece that is dropped leaves the rest whole, and comes back as it was', () => {
  const town = makeTown({ cols: 6, rows: 5 });
  const whole = count(town.lanes);
  const pieces = cut(town.json, (x) => (x < 250 ? 'west' : 'east'));
  const world = new World(empty(town.json));
  const lanes = new LaneGraph(world);
  const add = (key: string): void => {
    const change = world.add(pieces.get(key) as WorldChunkJson);
    for (const e of change.edges) lanes.addEdge(e);
    for (const n of change.nodes) lanes.completeNode(n);
  };
  add('west');
  add('east');
  const westOnly = count(new LaneGraph(new World({ ...empty(town.json) })));
  assert.deepEqual(westOnly, [0, 0]);
  // away with the east
  const gone = world.remove((pieces.get('east') as WorldChunkJson).nodes.map((n) => n[0]));
  for (const n of gone.nodes) lanes.removeNode(n);
  for (const e of gone.edges) lanes.removeEdge(e);
  assert.ok(gone.edges.length > 0 && gone.nodes.length === 15);
  for (const e of gone.edges) assert.equal(world.edges[e.id], undefined);
  // what is left is what the west alone gives
  const alone = new World(empty(town.json));
  alone.add(pieces.get('west') as WorldChunkJson);
  assert.equal(world.allEdges.size, alone.allEdges.size);
  assert.equal(world.allNodes.size, alone.allNodes.size);
  assert.deepEqual(count(lanes), count(new LaneGraph(alone)));
  assert.equal(world.crossings.length, 0);
  // nothing of the east is found by place any more, the west still is
  const hit = { y: 0, edge: null, node: null, s: 0, off: 0, zone: 2, surf: 0 };
  assert.equal(world.surfaceAt(450, 200, 101, hit), false);
  assert.equal(world.surfaceAt(50, 100, 101, hit), true);
  // … and back again
  add('east');
  assert.deepEqual(count(lanes), whole);
  assert.equal(world.surfaceAt(450, 200, 101, hit), true);
});

test('the loader keeps the network around a place loaded and drops what lies far away', async () => {
  // a town 24 km wide, so that it spans several chunks of 4 km
  const town = makeTown({ cols: 13, rows: 3, block: 2000 });
  const whole = count(town.lanes);
  const key = (x: number, z: number): string => `${Math.floor((x + 200000) / 4000)}_${Math.floor((z + 200000) / 4000)}`;
  const pieces = cut(town.json, key);
  const index: MapIndexJson = {
    version: 2,
    meta: town.json.meta,
    places: [],
    spawns: [],
    tiles: GridSet.of([]).toJSON(),
    chunks: GridSet.of([...pieces.keys()].map((k) => k.split('_').map(Number) as [number, number])).toJSON(),
    nodes: town.json.nodes.length,
    edges: town.json.edges.length,
  };
  let asked = 0;
  const files: MapFiles = {
    bytes(path: string): Promise<ArrayBuffer | null> {
      const m = /^w\/(\d+_\d+)\.json\.gz$/.exec(path);
      const data = path === 'map.json' ? index : m ? pieces.get(m[1]) : undefined;
      if (m) asked++;
      if (data === undefined) return Promise.resolve(null);
      const bytes = new TextEncoder().encode(JSON.stringify(data));
      return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    },
  };
  const map = await MapLoader.open(files);
  assert.equal(map.pieces, true);
  const lanes = new LaneGraph(map.world);
  followMap(map, { lanes });
  map.loadRadius = 3000;
  map.keepRadius = 7000;
  assert.equal(map.ready(1000, 2000), false);
  await map.loadAround(1000, 2000);
  assert.equal(map.ready(1000, 2000), true);
  const near = count(lanes);
  assert.ok(near[0] > 0 && near[0] < whole[0], 'a part of the network');
  assert.equal(map.ready(20000, 2000), false);
  // drive east, a little at a time: the network follows
  for (let x = 1000; x <= 23000; x += 500) {
    await map.loadAround(x, 2000);
    for (let i = 0; i < 10; i++) map.update(x, 2000, Infinity);
    assert.equal(map.ready(x, 2000), true, `at ${x}`);
    assert.ok(map.world.surfaceAt(x, 2000, 101, { y: 0, edge: null, node: null, s: 0, off: 0, zone: 2, surf: 0 }), `road under the wheels at ${x}`);
  }
  assert.ok(count(lanes)[0] < whole[0], 'the west was dropped on the way');
  assert.equal(map.world.surfaceAt(1000, 2000, 101, { y: 0, edge: null, node: null, s: 0, off: 0, zone: 2, surf: 0 }), false);
  // everything at once, for tools
  await map.loadAll();
  assert.deepEqual(count(lanes), whole);
  assert.ok(asked >= pieces.size);
});

test('a way through parts of the map that are not loaded yet is followed as they arrive', async () => {
  const { Navigator } = await import('../../src/game/nav.ts');
  const { quickest, routeGraphOf, wayOf } = await import('../../src/world/routegraph.ts');
  const town = makeTown({ cols: 13, rows: 3, block: 2000 });
  const key = (x: number, z: number): string => `${Math.floor((x + 200000) / 4000)}_${Math.floor((z + 200000) / 4000)}`;
  const pieces = cut(town.json, key);
  const index: MapIndexJson = {
    version: 2,
    meta: town.json.meta,
    places: [],
    spawns: [],
    tiles: GridSet.of([]).toJSON(),
    chunks: GridSet.of([...pieces.keys()].map((k) => k.split('_').map(Number) as [number, number])).toJSON(),
    nodes: town.json.nodes.length,
    edges: town.json.edges.length,
  };
  const map = await MapLoader.open({
    bytes(path: string): Promise<ArrayBuffer | null> {
      const m = /^w\/(\d+_\d+)\.json\.gz$/.exec(path);
      const data = path === 'map.json' ? index : m ? pieces.get(m[1]) : undefined;
      if (data === undefined) return Promise.resolve(null);
      const bytes = new TextEncoder().encode(JSON.stringify(data));
      return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    },
  });
  const lanes = new LaneGraph(map.world);
  followMap(map, { lanes });
  map.loadRadius = 3000;
  map.keepRadius = 7000;
  // the roads of the whole town as the route planner knows them (in the game: from net.bin.gz)
  const g = routeGraphOf(town.lanes);
  await map.loadAround(0, 2000);
  const start = lanes.edgeLanes[town.street(0, 1, 1, 1)].fwd[0];
  const goal = town.street(11, 1, 12, 1) * 2;
  const ways = quickest(g, wayOf(start), goal);
  assert.ok(ways && ways.length >= 11, 'a way of 22 km to the other end of the town');
  const nav = new Navigator(lanes);
  nav.net = g;
  nav.setWays(ways, start, false);
  const first = nav.route?.length ?? 0;
  assert.ok(first > 0 && first < ways.length, `only the part that is loaded has its lanes yet (${first} of ${ways.length})`);
  assert.ok(nav.left > 500, 'and the navigation knows that more is to come');
  // drive it: the map follows the car, the route grows ahead of it
  let lane = start;
  let done = false;
  for (let i = 0; i < ways.length; i++) {
    const h0 = nav.update(0.1, lane, 1);
    assert.equal(h0.done, false, `not arrived on way ${i}`);
    const next = nav.route?.[i];
    assert.ok(next, `the path through junction ${i + 1} is known when the car gets there`);
    assert.equal(wayOf(next.to), ways[i]);
    lane = next.to;
    await map.loadAround(lane.to.x, lane.to.z);
    for (let k = 0; k < 10; k++) map.update(lane.to.x, lane.to.z, Infinity);
    done = nav.update(0.1, lane, 1).done;
  }
  assert.equal(done, true, 'arrived on the last road');
  assert.equal(map.world.surfaceAt(0, 2000, 101, { y: 0, edge: null, node: null, s: 0, off: 0, zone: 2, surf: 0 }), false, 'where it started is not loaded any more');
});
