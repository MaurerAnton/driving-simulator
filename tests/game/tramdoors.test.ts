// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The doors of the trams as they are drawn (render/trams.ts): where they
 * are on each body, on both sides; the leaves come out of the wall and slide
 * apart when a vehicle's doors open and go back when they shut; without the
 * detail (the low graphics setting) the plain bodies – and switching it
 * builds what is shown anew.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { RailActors, carDoors } from '../../src/render/trams.ts';
import { carLayout, consistOf } from '../../src/sim/rail.ts';
import type { RailVehicle, TramSet } from '../../src/sim/rail.ts';
import { RAIL } from '../../src/world/types.ts';

const SETS: readonly TramSet[] = ['single', 'double', 'trailer'];

/** A vehicle standing on a straight track, its front to the north, its doors as far open as `doors`. */
function standing(kind: number, set: TramSet, doors: number, id = 7): RailVehicle {
  const consist = consistOf(kind, set);
  const cars = carLayout(consist).map((r) => ({ x: 0, y: 0, z: r.start + r.len / 2, yaw: 0, pitch: 0 }));
  return { id, kind, consist, cars, panto: 1, doors } as unknown as RailVehicle;
}

/** The meshes of the bodies of the (only) vehicle shown. */
function bodies(r: RailActors): THREE.Mesh[] {
  assert.equal(r.group.children.length, 1, 'one vehicle shown');
  return (r.group.children[0] as THREE.Group).children as THREE.Mesh[];
}

/** The groups of door leaves of a body. */
const leavesOf = (body: THREE.Mesh): THREE.Mesh[] => body.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.name === 'door leaves');

/** Which side a group of leaves is on (-1 left, 1 right) and which way it slides (-1 to the front, 1 to the back), from where its leaves are drawn. */
function groupOf(leaf: THREE.Mesh): { side: number; way: number } {
  const box = new THREE.Box3().setFromBufferAttribute(leaf.geometry.getAttribute('position') as THREE.BufferAttribute);
  const mid = box.getCenter(new THREE.Vector3());
  // (the doors lie evenly before and behind the middle of the body: the leaves sliding forwards lie forwards of them)
  return { side: Math.sign(mid.x), way: Math.sign(mid.z) };
}

const triangles = (m: THREE.Mesh): number => m.geometry.getAttribute('position').count / 3;

test('every body has two double doors on each side, the same on both sides, clear of the cabs and of each other', () => {
  for (const kind of [RAIL.TRAM, RAIL.LIGHT, RAIL.TRAIN]) {
    for (const set of SETS) {
      const roles = carLayout(consistOf(kind, set));
      for (const role of roles) {
        const name = `kind ${kind}, ${set}, ${role.trailer ? 'the trailer car' : `unit ${role.unit}`} at ${role.start.toFixed(1)} m`;
        const doors = carDoors(role);
        const left = doors.filter((d) => d.side === -1).map((d) => d.z);
        const right = doors.filter((d) => d.side === 1).map((d) => d.z);
        assert.equal(left.length, 2, `${name}: two doors on the left`);
        assert.deepEqual(right, left, `${name}: the doors on the right are where those on the left are`);
        // a quarter of the body's length before and behind its middle
        assert.deepEqual(
          right.map((z) => z / role.len),
          [-0.25, 0.25],
          `${name}: at ${right.join(', ')}`,
        );
        for (const d of doors) {
          assert.ok(d.width >= 1.2 && d.width <= 1.5, `${name}: a double door about 1.3 m wide (${d.width})`);
          // within the body, and at least a cab's length from an end with a cab
          assert.ok(d.z - d.width / 2 > -role.len / 2 + (role.front ? 1.3 : 0.5), `${name}: the door at ${d.z} is clear of the front end`);
          assert.ok(d.z + d.width / 2 < role.len / 2 - (role.back ? 1.3 : 0.5), `${name}: the door at ${d.z} is clear of the back end`);
        }
        assert.ok(right[1] - right[0] - doors[0].width > 0.5, `${name}: the doors keep apart`);
      }
      // (a trailer car carries passengers too)
      if (set === 'trailer') assert.equal(carDoors(roles[roles.length - 1]).length, 4, 'the trailer car has doors');
    }
  }
  // a tram of three sections: six double doors a side, two on each section
  const tram = carLayout(consistOf(RAIL.TRAM));
  assert.equal(tram.reduce((n, r) => n + carDoors(r).filter((d) => d.side === 1).length, 0), 6);
});

test('the doors of every body are drawn on both sides, shut, as part of the body', () => {
  for (const kind of [RAIL.TRAM, RAIL.LIGHT]) {
    for (const set of SETS) {
      const r = new RailActors();
      const v = standing(kind, set, 0);
      r.update([v]);
      const roles = carLayout(v.consist);
      const cars = bodies(r);
      assert.equal(cars.length, roles.length, 'one mesh a body, as before (the leaves hang from their body)');
      cars.forEach((body, i) => {
        const leaves = leavesOf(body);
        assert.equal(leaves.length, 4, 'four groups of leaves: left and right, sliding forwards and backwards');
        const groups = leaves.map(groupOf).map((g) => `${g.side}${g.way}`).sort();
        assert.deepEqual(groups, ['-1-1', '-11', '1-1', '11'], `body ${i}: a group for each side and way`);
        // shut, the leaves are drawn with the body: their own meshes are not drawn
        for (const leaf of leaves) {
          assert.equal(leaf.visible, false, 'shut: the leaves are part of the body');
          assert.equal(leaf.position.length(), 0, 'shut: at rest');
          // the leaves of a group lie in the wall of their side
          const box = new THREE.Box3().setFromBufferAttribute(leaf.geometry.getAttribute('position') as THREE.BufferAttribute);
          const { side } = groupOf(leaf);
          const wall = (side * v.consist.width) / 2;
          assert.ok(Math.abs((side > 0 ? box.max.x : box.min.x) - wall) < 1e-6, `body ${i}: leaves in the wall on side ${side}`);
        }
        // the two leaves of each door on a side – one sliding forwards, one backwards – fill its opening
        for (const side of [-1, 1]) {
          const zs: number[] = [];
          const ys: number[] = [];
          for (const leaf of leaves.filter((l) => groupOf(l).side === side)) {
            const p = leaf.geometry.getAttribute('position');
            for (let k = 0; k < p.count; k++) {
              zs.push(p.getZ(k));
              ys.push(p.getY(k));
            }
          }
          for (const d of carDoors(roles[i]).filter((d) => d.side === side)) {
            const here = zs.filter((z) => Math.abs(z - d.z) <= d.width / 2 + 0.01);
            assert.ok(Math.abs(Math.min(...here) - (d.z - d.width / 2)) < 1e-6 && Math.abs(Math.max(...here) - (d.z + d.width / 2)) < 1e-6, `body ${i}: the leaves fill the opening at ${d.z} on side ${side}`);
          }
          assert.ok(Math.max(...ys) - Math.min(...ys) > 1.9, `body ${i}: doors about two metres high`);
        }
      });
    }
  }
});

test('opening, the leaves come out of the wall and slide apart; shutting, they go back', () => {
  const r = new RailActors();
  const v = standing(RAIL.TRAM, 'single', 0);
  r.update([v]);
  const cars = bodies(r);
  const shut = cars.map((m) => m.geometry);
  const roles = carLayout(v.consist);

  // just opening: out of the wall a little, not yet sliding
  v.doors = 0.1;
  r.update([v]);
  for (const body of cars) {
    assert.notEqual(body.geometry, shut[cars.indexOf(body)], 'moving: the body with its doorways');
    for (const leaf of leavesOf(body)) {
      const { side } = groupOf(leaf);
      assert.equal(leaf.visible, true);
      assert.ok(leaf.position.x * side > 0.005, `out of the wall: ${leaf.position.x}`);
      assert.ok(Math.abs(leaf.position.z) < 1e-9, `not sliding yet: ${leaf.position.z}`);
    }
  }

  // open: out of the wall by more than a leaf is thick, and slid clear of the openings
  v.doors = 1;
  r.update([v]);
  cars.forEach((body, i) => {
    for (const leaf of leavesOf(body)) {
      const { side, way } = groupOf(leaf);
      leaf.updateMatrixWorld(true);
      assert.ok(leaf.position.x * side >= 0.04 && leaf.position.x * side <= 0.15, `out by ${leaf.position.x}`);
      assert.ok(leaf.position.z * way >= 0.6, `slid by ${leaf.position.z} towards ${way}`);
      // no part of a leaf is left in front of an opening
      const p = leaf.geometry.getAttribute('position');
      for (const d of carDoors(roles[i])) {
        for (let k = 0; k < p.count; k++) {
          const z = p.getZ(k) + leaf.position.z;
          assert.ok(Math.abs(z - d.z) >= d.width / 2 - 1e-6, `a leaf still in the opening at ${z.toFixed(3)} (door at ${d.z})`);
        }
      }
    }
  });

  // half way: the leaves half way along
  v.doors = 0.6;
  r.update([v]);
  const half = leavesOf(cars[0])[0];
  assert.ok(Math.abs(half.position.z) > 0.1 && Math.abs(half.position.z) < 0.55, `half way: ${half.position.z}`);

  // shut again: back in the wall, drawn with the body
  v.doors = 0;
  r.update([v]);
  cars.forEach((body, i) => {
    assert.equal(body.geometry, shut[i], 'shut: the body with its doors drawn in');
    for (const leaf of leavesOf(body)) {
      assert.equal(leaf.visible, false);
      assert.equal(leaf.position.length(), 0);
    }
  });
});

test('the leaves are left alone while the doors do not move', () => {
  const r = new RailActors();
  const v = standing(RAIL.LIGHT, 'double', 0.5);
  r.update([v]);
  const leaf = leavesOf(bodies(r)[0])[0];
  const z = leaf.position.z;
  assert.ok(z !== 0, 'half open');
  // (a mark that a fresh placing would wipe out)
  leaf.position.y = 5;
  r.update([v]);
  assert.equal(leaf.position.y, 5, 'not placed again: the doors stand still');
  v.doors = 0.55;
  r.update([v]);
  assert.equal(leaf.position.y, 0, 'placed again once they move');
  assert.ok(Math.abs(leaf.position.z) > Math.abs(z), 'further open');
});

test('without the detail the bodies are the plain ones; switching it builds what is shown anew, at once', () => {
  const r = new RailActors();
  const v = standing(RAIL.TRAM, 'trailer', 1);
  r.update([v]);
  const detailed = bodies(r);
  const many = detailed.reduce((n, m) => n + triangles(m), 0);
  assert.ok(detailed.every((m) => leavesOf(m).length === 4 && leavesOf(m).every((l) => l.visible)), 'open doors drawn');

  r.detail = false;
  assert.equal(r.detail, false);
  // (without another update – the yard of every model is shown only once)
  const plain = bodies(r);
  assert.equal(plain.length, detailed.length, 'the same bodies');
  assert.ok(plain.every((m, i) => m !== detailed[i]), 'made anew');
  assert.ok(plain.every((m) => leavesOf(m).length === 0 && m.userData.doors === undefined), 'no doors drawn');
  assert.ok(plain.reduce((n, m) => n + triangles(m), 0) < many / 2, 'the plain bodies are the light ones');
  plain.forEach((m, i) => assert.equal(m.position.z, v.cars[i].z, 'where the vehicle stands'));
  // a plain body is the one the low setting always had: the same as that of any other plain RailActors
  const other = new RailActors();
  other.detail = false;
  other.update([standing(RAIL.TRAM, 'trailer', 0, 8)]);
  bodies(other).forEach((m, i) => assert.deepEqual(m.geometry.getAttribute('position').array, plain[i].geometry.getAttribute('position').array));

  // doors that move without the detail: nothing to move
  v.doors = 0.3;
  r.update([v]);
  assert.ok(bodies(r).every((m) => leavesOf(m).length === 0));

  r.detail = true;
  const again = bodies(r);
  assert.ok(again.every((m) => leavesOf(m).length === 4), 'the doors are back');
  assert.ok(again.every((m) => leavesOf(m).every((l) => l.visible && l.position.x !== 0)), 'as far open as the vehicle has them');
  r.detail = true;
  assert.equal(bodies(r)[0], again[0], 'setting it to what it is changes nothing');
});
