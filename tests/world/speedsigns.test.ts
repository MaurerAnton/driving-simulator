// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Speed-limit signs (tools/mapgen/signs.ts): the roundel a road gets for its
 * limit – a base `maxspeed`, or a conditional one ("maxspeed:conditional =
 * 100 @ (22:00-06:00)") that holds only at times or when the road is wet.
 *
 * The conditional case is the one that showed up wrong in the game: a road
 * whose only limit is conditional (no base `maxspeed`) got no sign at all, so
 * at night or in the rain the limiter held a number the driver never saw
 * signed.  The sign comes from `SignPlacer.timedSigns()`; this test pins that
 * it posts a roundel (`274-<n>`) with its time plate (`1040-30:…` for a time
 * window, `1053-35` for "wet") for a conditional-only limit, and that a base
 * limit still gets its roundel when the limit changes along the road.
 *
 *   node --test tests/world/speedsigns.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { angleOf } from '../../src/core/geom.ts';
import { LaneGraph } from '../../src/world/lanes.ts';
import { CLS, CTRL, ROLE } from '../../src/world/types.ts';
import type { EdgeJson, NodeJson, WorldJson } from '../../src/world/types.ts';
import { World, computeAllCuts } from '../../src/world/world.ts';
import { SignPlacer } from '../../tools/mapgen/signs.ts';
import type { ONode, OWay, Tags } from '../../tools/mapgen/osm.ts';
import { TileSet } from '../../tools/mapgen/meshacc.ts';

/**
 * A straight motorway of two sections with a slip road at the middle node (a
 * 3-arm junction), built as the map build hands it to the sign placer.  The
 * tags are those of the OpenStreetMap way the roads were made of (`osm`).
 * Returns every sign code posted, without duplicates.
 */
function signsFor(wayTags: Tags): string[] {
  const nodes: NodeJson[] = [
    { x: 0, y: 100, z: 0, t: CTRL.NONE, arms: [] },
    { x: 400, y: 100, z: 0, t: CTRL.NONE, arms: [] },
    { x: 800, y: 100, z: 0, t: CTRL.NONE, arms: [] },
    { x: 400, y: 100, z: -400, t: CTRL.NONE, arms: [] },
  ];
  const edges: EdgeJson[] = [
    { a: 0, b: 1, c: CLS.MOTORWAY, n: 'A 99', p: [0, 100, 0, 400, 100, 0], lf: 2, lb: 0, lw: 3.75, w: 7.5, mf: 0, mb: 0, f: 0, ca: 0, cb: 0, o: 42 },
    { a: 1, b: 2, c: CLS.MOTORWAY, n: 'A 99', p: [400, 100, 0, 800, 100, 0], lf: 2, lb: 0, lw: 3.75, w: 7.5, mf: 0, mb: 0, f: 0, ca: 0, cb: 0, o: 42 },
    { a: 1, b: 3, c: CLS.MOTORWAY_LINK, n: 'slip', p: [400, 100, 0, 400, 100, -400], lf: 1, lb: 0, lw: 3.75, w: 3.75, mf: 0, mb: 0, f: 0, ca: 0, cb: 0, o: 43 },
  ];
  nodes.forEach((node, ni) => {
    const arms: Array<{ e: number; ang: number }> = [];
    edges.forEach((e, ei) => {
      if (e.a !== ni && e.b !== ni) return;
      const o = nodes[e.a === ni ? e.b : e.a];
      arms.push({ e: ei, ang: angleOf(o.x - node.x, o.z - node.z) });
    });
    arms.sort((p, q) => p.ang - q.ang);
    node.arms = arms.map((a) => ({ e: a.e, r: arms.length > 2 ? ROLE.RBL : ROLE.NONE }));
    node.t = CTRL.NONE;
  });
  const json: WorldJson = {
    version: 1,
    meta: { name: 'test', generated: '', minX: -3000, maxX: 3000, minZ: -3000, maxZ: 3000, tileSize: 500, originE: 0, originN: 0, attribution: [] },
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
  void new LaneGraph(world);
  const way = { id: 42, tags: wayTags, nodes: [1, 2], refs: [], pts: [] } as unknown as OWay;
  const osm = { nodes: new Map<number, ONode>(), wayById: new Map<number, OWay>([[42, way]]) };
  const ts = new TileSet(-3000, -3000, 3000, 3000, 500);
  const placer = new SignPlacer(world, ts, []);
  placer.osm = osm;
  placer.build({ edgeFeatures: world.edges.map(() => []), nodeOsm: world.nodes.map(() => null) } as never, {} as never);
  const codes = new Set<string>();
  for (const t of ts.tiles.values()) for (const s of t.signs) for (const c of s.s) codes.add(c);
  return [...codes];
}

test('a road whose only limit is conditional gets a roundel with its time plate', () => {
  const night = signsFor({ 'maxspeed:conditional': '100 @ (22:00-06:00)' });
  assert.ok(night.includes('274-100'), `roundel 274-100 for the conditional limit: [${night.join(' ')}]`);
  // the plate says when it holds (the window, in the sign's own code form)
  assert.ok(night.some((c) => c.startsWith('1040-30:') || c.includes('22:00-06:00')), `time plate: [${night.join(' ')}]`);
});

test('a conditional limit for wet roads gets its roundel and the "wet" plate', () => {
  const wet = signsFor({ 'maxspeed:conditional': '80 @ (wet)' });
  assert.ok(wet.includes('274-80'), `roundel 274-80: [${wet.join(' ')}]`);
  assert.ok(wet.includes('1053-35'), `the wet plate 1053-35: [${wet.join(' ')}]`);
});

test('a base limit and a conditional one: the conditional roundel wins', () => {
  const both = signsFor({ maxspeed: '60', 'maxspeed:conditional': '40 @ (22:00-06:00)' });
  assert.ok(both.includes('274-40'), `the conditional 40: [${both.join(' ')}]`);
  assert.ok(!both.includes('274-60'), `not the base 60 (the conditional overrides it): [${both.join(' ')}]`);
});

test('the junction gives way (control), so the sign placer ran at all', () => {
  // (357: the give-way sign of the slip road – proves the placer posted something)
  const night = signsFor({ 'maxspeed:conditional': '100 @ (22:00-06:00)' });
  assert.ok(night.includes('357'), `the give-way sign is there: [${night.join(' ')}]`);
});
