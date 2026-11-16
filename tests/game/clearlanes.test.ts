// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { newPolySample } from '../../src/core/geom.ts';
import { POST_CLEAR, WALL_CLEAR, clearObjects, clearSigns, clearWalls, postInLane } from '../../src/sim/clearlanes.ts';
import { SceneryCollider } from '../../src/sim/collision.ts';
import { lanePoint } from '../../src/world/lanes.ts';
import type { PathFoot } from '../../src/world/lanes.ts';
import type { SignPost, TileObject } from '../../src/world/tilefmt.ts';
import { makeTown } from './town.ts';

const town = makeTown();
const lanes = town.lanes;
/** a point in the middle of a lane of the street between two junctions, halfway along */
const lane = lanes.edgeLanes[town.street(1, 1, 2, 1)].fwd[0];
const mid = lanePoint(lane, lane.len / 2, newPolySample());
const foot: PathFoot = { x: 0, z: 0, d: 0 };

test('the middle of the nearest lane is found, on the level asked for', () => {
  assert.ok(lanes.nearestPath(mid.x, mid.z, mid.y, 2, foot) < 0.01);
  assert.ok(Math.abs(lanes.nearestPath(mid.x, mid.z + 1, mid.y, 2, foot) - 1) < 0.02);
  assert.ok(Math.hypot(foot.x - mid.x, foot.z - mid.z) < 0.02, 'the foot point lies on the lane');
  assert.equal(lanes.nearestPath(mid.x, mid.z + 8, mid.y, 2, foot), Infinity, 'nothing within reach beside the road');
  assert.equal(lanes.nearestPath(mid.x, mid.z, mid.y + 6, 2, foot), Infinity, 'a road on another level does not count');
  // in the middle of a junction: the paths through it
  const node = town.world.nodes[town.node(1, 1)];
  assert.ok(lanes.nearestPath(node.x, node.z, node.y, 3, foot) < 3);
});

test('a sign post in a lane is moved beside the lanes, one beside the road stays', () => {
  const signs: SignPost[] = [
    { x: mid.x, y: mid.y, z: mid.z + 0.3, yaw: 0, s: ['205'], h: 2 },
    { x: mid.x + 10, y: mid.y, z: mid.z + 6, yaw: 0, s: ['306'], h: 2 },
  ];
  const [moved, dropped] = clearSigns(lanes, signs);
  assert.deepEqual([moved, dropped], [1, 0]);
  assert.equal(signs.length, 2);
  assert.ok(lanes.nearestPath(signs[0].x, signs[0].z, signs[0].y, POST_CLEAR, foot) >= POST_CLEAR, 'clear of every lane now');
  assert.ok(Math.hypot(signs[0].x - mid.x, signs[0].z - mid.z) < 5, 'and not far from where it stood');
  assert.deepEqual([signs[1].x, signs[1].z], [mid.x + 10, mid.z + 6]);
  assert.equal(postInLane(lanes, mid.x, mid.y, mid.z), true);
  assert.equal(postInLane(lanes, mid.x, mid.y, mid.z + 6), false);
});

test('lamps in a lane are dropped, other things are left alone', () => {
  const objects: TileObject[] = [
    { k: 'lamp', x: mid.x, y: mid.y, z: mid.z },
    { k: 'lamp', x: mid.x, y: mid.y, z: mid.z + 7 },
    { k: 'bench', x: mid.x, y: mid.y, z: mid.z },
  ];
  assert.equal(clearObjects(lanes, objects), 1);
  assert.deepEqual(objects.map((o) => o.k), ['lamp', 'bench']);
});

test('walls lose the pieces that reach into a lane – and only those', () => {
  // across the road, along it at the kerb, along it well beside it, and across it on a bridge high above
  assert.equal(lanes.wallInLane(mid.x, mid.z - 6, mid.x, mid.z + 6, mid.y, WALL_CLEAR), true);
  assert.equal(lanes.wallInLane(mid.x - 10, mid.z + 0.9, mid.x + 10, mid.z + 0.9, mid.y, WALL_CLEAR), true);
  assert.equal(lanes.wallInLane(mid.x - 10, mid.z + 5, mid.x + 10, mid.z + 5, mid.y, WALL_CLEAR), false);
  assert.equal(lanes.wallInLane(mid.x, mid.z - 6, mid.x, mid.z + 6, mid.y + 7, WALL_CLEAR), false);
  // a house whose corner stands in the lane: the two walls of that corner go, the others stay
  const ring = Float32Array.from([mid.x - 4, mid.z + 0.5, mid.x + 4, mid.z + 0.5, mid.x + 4, mid.z + 9, mid.x - 4, mid.z + 9]);
  const walls = clearWalls(lanes, ring, Uint16Array.from([4]), Float32Array.from([mid.x - 3, mid.z - 9, mid.x + 3, mid.z - 9, mid.y]));
  assert.equal(walls.length / 5, 2, 'the far wall of the house and the free-standing wall beside the road');
  for (let i = 0; i < walls.length; i += 5) assert.equal(lanes.wallInLane(walls[i], walls[i + 1], walls[i + 2], walls[i + 3], walls[i + 4], WALL_CLEAR), false);
});

test('a place is known to be taken when the vehicle would touch something there', () => {
  const c = new SceneryCollider();
  c.add({ key: 't', rings: null, ringCounts: null, segments: Float32Array.from([50, -5, 50, 5, 100]), discs: [0, 100, -20, 0.1] });
  // heading north (yaw 0: forward is -z): a post 20 m ahead, a wall 50 m to the east
  assert.equal(c.blocked(0, 100, 0, 0), false);
  assert.equal(c.blocked(0, 100, -18.2, 0), true, 'the nose at the post');
  assert.equal(c.blocked(1.2, 100, -20, 0), false, 'past it with a hand of room');
  assert.equal(c.blocked(49.5, 100, 0, 0), true, 'in the wall');
  assert.equal(c.blocked(49.5, 104, 0, 0), false, 'the wall stands on another level');
  c.remove('t');
  assert.equal(c.blocked(49.5, 100, 0, 0), false);
});
