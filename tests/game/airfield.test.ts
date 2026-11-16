// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The airfields as an aeroplane meets them: firm ground on the runway, the
 * taxiway and the apron, a mown strip on a grass runway; where a flight
 * begins (lined up at a runway's end) and how its ends are called.
 *
 *   node --test "tests/game/*.test.ts"
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { AirfieldGround, paved, runwayEnd, runwayStart } from '../../src/sim/airfield.ts';
import type { Ground, GroundSample } from '../../src/sim/vehicle/types.ts';
import type { AirfieldJson } from '../../src/world/types.ts';

/** flat grass everywhere */
const grass: Ground = {
  sample(_x: number, _z: number, _y: number, out: GroundSample): void {
    out.y = 200;
    out.nx = 0;
    out.ny = 1;
    out.nz = 0;
    out.grip = 0.7;
    out.rolling = 4;
  },
};

const field: AirfieldJson = {
  name: 'Testfeld',
  icao: 'EDXX',
  kind: 'airport',
  x: 0,
  z: 0,
  // a runway east–west (09/27) 1000 m long, a taxiway to an apron, and a grass strip north–south
  runways: [
    { ref: '09/27', x1: -500, z1: 0, x2: 500, z2: 0, w: 30, s: 'asphalt' },
    { ref: '', x1: 0, z1: 300, x2: 0, z2: -300, w: 30, s: 'grass' },
  ],
  taxiways: [{ w: 10, s: 'asphalt', p: [200, 0, 200, 100] }],
  aprons: [{ s: 'concrete', p: [180, 100, 260, 100, 260, 160, 180, 160, 180, 100] }],
};

test('the runway, its taxiway and apron are firm; the grass strip rolls like a mown field; elsewhere the ground is as it is', () => {
  const g = new AirfieldGround(grass, [field]);
  const s: GroundSample = { y: 0, nx: 0, ny: 1, nz: 0, grip: 0, rolling: 0 };
  for (const [x, z] of [
    [-300, 5],
    [200, 60],
    [220, 130],
  ]) {
    g.sample(x, z, 201, s);
    assert.equal(s.rolling, 1, `paved at ${x}, ${z}`);
    assert.ok(s.grip >= 1);
  }
  g.sample(5, -200, 201, s);
  assert.ok(s.rolling > 1 && s.rolling < 4, 'the grass runway');
  g.sample(-300, 80, 201, s);
  assert.equal(s.rolling, 4, 'beside it: the field');
  assert.equal(paved('asphalt'), true);
  assert.equal(paved('grass'), false);
});

test('a flight begins lined up at the end of a runway – the ends called as they are painted', () => {
  const r = field.runways[0];
  const a = runwayStart(r, false);
  // from the west end towards the east: yaw −90° (0 north, + left)
  assert.ok(Math.abs(a.yaw + Math.PI / 2) < 1e-6, `yaw ${a.yaw}`);
  assert.ok(a.x > -500 && a.x < -400 && Math.abs(a.z) < 1e-6);
  const b = runwayStart(r, true);
  assert.ok(Math.abs(b.yaw - Math.PI / 2) < 1e-6 && b.x < 500 && b.x > 400);
  assert.equal(runwayEnd(r, false), '09');
  assert.equal(runwayEnd(r, true), '27');
  // without a name in the map: from its direction – north–south from the south end is 36
  assert.equal(runwayEnd(field.runways[1], false), '36');
  assert.equal(runwayEnd(field.runways[1], true), '18');
});

test('what is drawn of an airfield faces up: the runway, its markings, the taxiway with its line, the apron', async () => {
  // (the figures of the runway's ends are painted on a canvas: a stand-in that paints nothing)
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}), set: () => true });
  const g = globalThis as { document?: unknown };
  const had = g.document;
  g.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
  try {
    const { AirfieldRenderer } = await import('../../src/render/airfield.ts');
    const view = new AirfieldRenderer(() => 200, () => true);
    view.set([field]);
    view.update(field.x, field.z);
    let meshes = 0;
    view.group.traverse((o) => {
      // (the figures at the ends are planes of their own)
      if (!(o instanceof THREE.Mesh) || o.geometry.type === 'PlaneGeometry') return;
      meshes++;
      const n = o.geometry.getAttribute('normal');
      const colour = (o.material as THREE.MeshLambertMaterial).color.getHexString();
      for (let i = 0; i < n.count; i++) assert.ok(n.getY(i) > 0.9, `${colour}: a face looks down`);
    });
    assert.ok(meshes >= 4, `${meshes} kinds of surface drawn`);
  } finally {
    g.document = had;
  }
});
