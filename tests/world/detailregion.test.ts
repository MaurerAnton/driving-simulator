// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The detail region (tools/mapgen/detailregion.ts): what lies in it, and that
 * a road outside it is built as the published map has it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { areaInDetail, inDetail, lineInDetail, loadDetailBoxes, midpointOf, rectInDetail } from '../../tools/mapgen/detailregion.ts';
import { OsmData } from '../../tools/mapgen/osm.ts';
import { buildRoadGraph, roadAttrs, roadAttrsLegacy } from '../../tools/mapgen/roads.ts';

const dir = mkdtempSync(join(tmpdir(), 'detail-'));
const file = join(dir, 'region.json');
writeFileSync(file, JSON.stringify({ about: 'test', boxes: [[0, 0, 100, 100]] }));
process.env.DETAIL_REGION = file;

test('boxes, points, lines by their middle, areas by the middle of their box', () => {
  assert.deepEqual(loadDetailBoxes(file), [[0, 0, 100, 100]]);
  assert.deepEqual(loadDetailBoxes('none'), []);
  assert.equal(inDetail(50, 50), true);
  assert.equal(inDetail(150, 50), false);
  assert.deepEqual(midpointOf([0, 0, 10, 0, 10, 30]), [10, 10]);
  // a road from inside to far outside: its middle decides
  assert.equal(lineInDetail([60, 50, 130, 50]), true);
  assert.equal(lineInDetail([90, 50, 400, 50]), false);
  assert.equal(areaInDetail([-50, -50, 120, -50, 120, 120]), true);
  assert.equal(rectInDetail(100, 100, 200, 200), true);
  assert.equal(rectInDetail(101, 0, 200, 200), false);
});

test('a road the area does not call fresh is built as the published map was', () => {
  const tags = { highway: 'residential', 'parking:both': 'lane', width: '10', sidewalk: 'both' };
  const now = roadAttrs(tags, true)!;
  const then = roadAttrsLegacy(tags, true)!;
  assert.ok(now.xl.p !== undefined && then.xl.p === undefined);
  const d = new OsmData();
  const nodes: Array<[number, number, number]> = [
    [1, 10, 50],
    [2, 90, 50],
    [3, 300, 50],
    [4, 600, 50],
  ];
  for (const [id, x, z] of nodes) d.nodes.set(id, { id, x, z, tags: null });
  for (const w of [
    { id: 10, refs: [1, 2], tags },
    { id: 11, refs: [2, 3, 4], tags },
  ]) {
    d.ways.push(w);
    d.wayById.set(w.id, w);
  }
  const g = buildRoadGraph(d, { inWorld: () => true, builtUp: () => true, fresh: (pts) => lineInDetail(pts) });
  const inside = g.edges.findIndex((e, i) => g.edgeWay[i].id === 10);
  const outside = g.edges.findIndex((e, i) => g.edgeWay[i].id === 11);
  assert.equal(g.edgeNew[inside], true);
  assert.equal(g.edgeNew[outside], false);
  assert.ok(g.edges[inside].xl !== undefined);
  assert.equal(g.edges[outside].xl, undefined);
  assert.equal(g.edges[outside].w, then.w);
});
