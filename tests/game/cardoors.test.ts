// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The parts that open and the seats of the car: how far a part is open as
 * time goes, getting in and out step by step (the door opens, one moves,
 * the door shuts), which seat a door leads to, what one can do where one
 * stands – and the car's body cut into its parts: the pieces cover exactly
 * the surface of the whole, and with every part shut the car is drawn from
 * its whole meshes again.
 *
 *   node --test tests/game/cardoors.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Boarding, MOVE_TIME, Openings, SEAT_EYE, carSpots, doorOfSeat, footActs, isDoor, nearestSpot, rearSpot, seatOfDoor } from '../../src/game/cardoors.ts';
import type { OpeningEvent } from '../../src/game/cardoors.ts';
import { COMPACT_DIMS, buildCarShell } from '../../src/render/carBody.ts';
import { CarOpenings, panelLines, shellPart } from '../../src/render/caropen.ts';

test('a part opens and shuts at its pace, and says when it begins and when it is shut', () => {
  const o = new Openings();
  assert.equal(o.get('fl'), 0);
  assert.equal(o.anyOpen, false);
  assert.equal(o.toggle('fl'), true);
  const ev: OpeningEvent[] = [];
  o.step(0.1, ev);
  assert.deepEqual(ev, [{ id: 'fl', what: 'opening' }]);
  assert.ok(o.get('fl') > 0 && o.get('fl') < 1);
  for (let i = 0; i < 20; i++) o.step(0.1);
  assert.equal(o.get('fl'), 1);
  assert.equal(o.anyOpen, true);
  // halfway shut, then opened again: it turns round where it is
  o.set('fl', false);
  o.step(0.3);
  const mid = o.get('fl');
  assert.ok(mid < 1 && mid > 0);
  assert.equal(o.toggle('fl'), true);
  o.step(0.1);
  assert.ok(o.get('fl') > mid);
  o.set('fl', false);
  ev.length = 0;
  for (let i = 0; i < 20; i++) o.step(0.1, ev);
  assert.equal(o.get('fl'), 0);
  assert.deepEqual(ev, [{ id: 'fl', what: 'shut' }]);
  assert.equal(o.anyOpen, false);
  // the bonnet is slower than a door
  o.set('bonnet', true);
  o.set('fr', true);
  o.step(0.5);
  assert.ok(o.get('bonnet') < o.get('fr'));
  o.reset();
  assert.equal(o.anyOpen, false);
});

test('each door leads to its own seat', () => {
  assert.equal(seatOfDoor('fl'), 'driver');
  assert.equal(seatOfDoor('fr'), 'front');
  assert.equal(seatOfDoor('rl'), 'rearLeft');
  assert.equal(seatOfDoor('rr'), 'rearRight');
  for (const d of ['fl', 'fr', 'rl', 'rr'] as const) assert.equal(doorOfSeat(seatOfDoor(d)), d);
  assert.ok(isDoor('rr') && !isDoor('bonnet') && !isDoor('boot') && !isDoor('trailer'));
  // the eyes: the driver on the left, the passenger on the right, the rear seats further back
  assert.ok(SEAT_EYE.driver[0] < 0 && SEAT_EYE.front[0] > 0);
  assert.ok(SEAT_EYE.rearLeft[2] > SEAT_EYE.driver[2] + 0.6 && SEAT_EYE.rearRight[0] > 0);
});

test('getting in: the door opens, one moves into the seat, the door shuts', () => {
  const o = new Openings();
  const b = new Boarding('in', 'fr');
  assert.equal(b.seat, 'front');
  const log: string[] = [];
  let seatedAt = -1;
  let t = 0;
  for (let i = 0; i < 200 && b.phase !== 'done'; i++) {
    o.step(0.05);
    const r = b.step(0.05, o);
    t += 0.05;
    if (r.start) log.push(`start ${o.get('fr') >= 0.85}`);
    if (r.arrive) {
      log.push('arrive');
      seatedAt = t;
    }
    if (r.done) log.push(`done ${o.get('fr')}`);
    if (b.phase === 'move') assert.ok(b.blend >= 0 && b.blend <= 1);
  }
  assert.deepEqual(log, ['start true', 'arrive', 'done 0']);
  assert.ok(seatedAt > MOVE_TIME);
  assert.equal(b.blend, 1);
  assert.equal(o.anyOpen, false);
});

test('getting out through a door that stands open already: no waiting for it', () => {
  const o = new Openings();
  o.set('rl', true);
  for (let i = 0; i < 30; i++) o.step(0.05);
  const b = new Boarding('out', 'rl');
  const r = b.step(0.016, o);
  assert.equal(r.start, true);
  assert.equal(b.phase, 'move');
  assert.equal(b.blend, 0);
});

test('where one stands decides what can be done there', () => {
  const unit = { x: 100, z: 50, yaw: 0, front: 2.2, rear: 2.1, hw: 0.9 };
  const spots = carSpots(unit, { frontAhead: 0.1, rearDoorRear: 1.06, nose: -2.2, tail: 2.1 });
  assert.equal(spots.length, 6);
  const fl = spots.find((s) => s.id === 'fl')!;
  const fr = spots.find((s) => s.id === 'fr')!;
  const bonnet = spots.find((s) => s.id === 'bonnet')!;
  const boot = spots.find((s) => s.id === 'boot')!;
  // facing north (−z): left is west (−x), the bonnet to the north, the tailgate to the south
  assert.ok(fl.x < 100 && fr.x > 100);
  assert.ok(bonnet.z < 50 - 2.2 && boot.z > 50 + 2.1);
  assert.equal(nearestSpot(spots, fl.x + 0.3, fl.z)?.id, 'fl');
  assert.equal(nearestSpot(spots, 100, 50), null);
  // turned round (yaw π): the left door is on the east side now
  const turned = carSpots({ ...unit, yaw: Math.PI }, { frontAhead: 0.1, rearDoorRear: 1.06, nose: -2.2, tail: 2.1 });
  assert.ok(turned.find((s) => s.id === 'fl')!.x > 100);
  const back = rearSpot('trailer', unit);
  assert.ok(back.z > 50 + 2.1 && Math.abs(back.x - 100) < 1e-9);
  const o = new Openings();
  assert.deepEqual(footActs('fl', o, true), ['open', 'enter']);
  assert.deepEqual(footActs('fl', o, false), ['open']);
  assert.deepEqual(footActs('bonnet', o, true), ['open']);
  o.set('fl', true);
  assert.deepEqual(footActs('fl', o, true), ['close', 'enter']);
});

test('the shell is cut along the panel lines: the parts lie where they should', () => {
  const sh = buildCarShell(COMPACT_DIMS);
  const L = panelLines(sh, COMPACT_DIMS);
  // a point on the flank of each door, on the bonnet, on the rear window, on the roof, on a wing
  assert.equal(shellPart(L, -0.89, 0.7, 0, 3, false), 0);
  assert.equal(shellPart(L, 0.89, 0.7, 0, 3, false), 1);
  assert.equal(shellPart(L, -0.89, 0.7, 0.8, 3, false), 2);
  assert.equal(shellPart(L, 0.89, 1.1, 0.8, 4, false), 3);
  assert.equal(shellPart(L, 0, 0.85, -1.6, 5, false), 4);
  assert.equal(shellPart(L, 0.2, 1.2, 1.6, 5, false), 5);
  assert.equal(shellPart(L, 0, 1.46, 0, 5, false), -1);
  assert.equal(shellPart(L, 0.85, 0.75, -1.6, 4, false), -1);
  // below the sill and over the rear wheel: the body
  assert.equal(shellPart(L, 0.89, 0.3, 0, 2, false), -1);
  assert.equal(shellPart(L, 0.89, 0.5, 1.05, 3, false), -1);
});

test('cut into its parts, the car shows the same surface – and shut it is the whole mesh again', () => {
  const sh = buildCarShell(COMPACT_DIMS);
  const root = new THREE.Group();
  const ext = new THREE.Group();
  const cockpit = new THREE.Group();
  root.add(ext, cockpit);
  const paintMat = new THREE.MeshBasicMaterial();
  const glassMat = new THREE.MeshBasicMaterial();
  const paint = new THREE.Mesh(sh.paint, paintMat);
  const glass = new THREE.Mesh(sh.glass, glassMat);
  const lining = new THREE.Mesh(sh.lining, new THREE.MeshBasicMaterial());
  ext.add(paint, glass);
  cockpit.add(lining);
  const o = new CarOpenings({ root, exterior: { group: ext, shell: sh, dims: COMPACT_DIMS }, cockpit, mirrors: [], doorTrim: [], register: () => {} });
  // shut: nothing changed
  assert.equal(paint.geometry, sh.paint);
  const area = (g: THREE.BufferGeometry, m = new THREE.Matrix4()): number => {
    const p = g.getAttribute('position');
    const idx = g.getIndex();
    const n = idx ? idx.count : p.count;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    let s = 0;
    for (let i = 0; i < n; i += 3) {
      a.fromBufferAttribute(p, idx ? idx.getX(i) : i).applyMatrix4(m);
      b.fromBufferAttribute(p, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(m);
      c.fromBufferAttribute(p, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(m);
      s += b.sub(a).cross(c.sub(a)).length() / 2;
    }
    return s;
  };
  o.pose([0.001, 0.001, 0.001, 0.001, 0.001, 0.001]);
  assert.notEqual(paint.geometry, sh.paint);
  const parts: THREE.Mesh[] = [];
  root.traverse((m) => {
    if (m instanceof THREE.Mesh && m.name.endsWith('(opening)')) parts.push(m);
  });
  const ofMat = (mat: THREE.Material): THREE.Mesh[] => parts.filter((m) => m.material === mat);
  assert.equal(ofMat(paintMat).length, 6, 'six parts of paint');
  assert.ok(ofMat(glassMat).length >= 5, 'the windows of the doors and the rear window');
  for (const [whole, mesh, mat] of [
    [sh.paint, paint, paintMat],
    [sh.glass, glass, glassMat],
  ] as const) {
    const sum = area(mesh.geometry) + ofMat(mat).reduce((s, m) => s + area(m.geometry), 0);
    assert.ok(Math.abs(sum - area(whole)) < 1e-4 * area(whole), `surface kept: ${sum} vs ${area(whole)}`);
  }
  // the normals of the pieces are the shell's (no new shading): every vertex normal of a piece is as long as an interpolated one may be
  for (const m of ofMat(paintMat)) {
    const n = m.geometry.getAttribute('normal');
    for (let i = 0; i < n.count; i++) assert.ok(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) > 0.3);
  }
  // the parts where they belong: the front left door left of the middle, between the windscreen and the B pillar
  const L = panelLines(sh, COMPACT_DIMS);
  const fl = ofMat(paintMat).find((m) => m.parent?.parent?.position.x === -sh.halfWidth && m.parent?.parent?.position.z === L.zFD)!;
  fl.geometry.computeBoundingBox();
  const bb = fl.geometry.boundingBox!;
  assert.ok(bb.max.x < 0 && bb.min.z >= L.zFD - 1e-4 && bb.max.z <= L.zB + 1e-4 && bb.min.y >= L.sill - 1e-4, JSON.stringify(bb));
  // opened, the door swings out to the left; the bonnet lifts
  o.pose([1, 0, 0, 0, 1, 0]);
  root.updateMatrixWorld(true);
  const fb = new THREE.Box3().setFromObject(fl);
  assert.ok(fb.min.x < -sh.halfWidth - 0.8, `door out: ${fb.min.x}`);
  // shut again: the whole meshes, the parts hidden
  o.pose([0, 0, 0, 0, 0, 0]);
  assert.equal(paint.geometry, sh.paint);
  assert.equal(glass.geometry, sh.glass);
  assert.equal(lining.geometry, sh.lining);
  assert.ok(parts.every((m) => !m.visible));
});
