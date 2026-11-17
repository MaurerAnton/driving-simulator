// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What opens at the back of a trailer, as that trailer really has it
 * (game/cardoors.ts has the logic, game/openplay.ts the game):
 *
 * - the box trailer behind a car, a 7.5-tonner, a minibus or a bus (render/
 *   fleet.ts CarTrailerModel): its tailgate folds down on its hinges at the
 *   floor, and the rear flap of the tarpaulin above it rolls up;
 * - the tandem trailer of the truck (render/truck.ts): its box has two
 *   rear wing doors that swing out and round against its sides, as the
 *   truck's own box body does (render/boxbody.ts – the same is used).
 *
 * The trailer stays as it was built while it is shut: the open version is
 * made the first time it is opened, and shown only while it is not shut.
 */
import * as THREE from 'three';
import { BoxBody } from './boxbody.ts';

const FLOOR = new THREE.MeshLambertMaterial({ color: 0x6e5a44 });
const INSIDE = new THREE.MeshLambertMaterial({ color: 0x24272b });

interface Opener {
  set(open: number): void;
}

const OPENERS = new WeakMap<THREE.Object3D, Opener | null>();

/** The extent of a box made by render/truck.ts box(): x0, x1, y0, y1, z0, z1. */
function extent(m: THREE.Mesh): [number, number, number, number, number, number] {
  const g = m.geometry as THREE.BoxGeometry;
  const { width, height, depth } = g.parameters;
  const p = m.position;
  return [p.x - width / 2, p.x + width / 2, p.y - height / 2, p.y + height / 2, p.z - depth / 2, p.z + depth / 2];
}

function slab(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.castShadow = true;
  return m;
}

/** The box trailer: a tailgate that folds down, a tarpaulin whose rear flap rolls up. */
function tarpTrailer(group: THREE.Object3D, body: THREE.Mesh, tarp: THREE.Mesh): Opener {
  const [x0, x1, y0, y1, z0, z1] = extent(body);
  const [tx0, tx1, ty0, ty1, tz0, tz1] = extent(tarp);
  const paint = body.material as THREE.Material;
  const cloth = tarp.material as THREE.Material;
  const open = new THREE.Group();
  open.name = 'trailer open';
  const t = 0.03;
  // the box without its back: the sides, the front, the floor
  open.add(slab(x0, x0 + t, y0, y1, z0, z1, paint), slab(x1 - t, x1, y0, y1, z0, z1, paint), slab(x0, x1, y0, y1, z0, z0 + t, paint), slab(x0 + t, x1 - t, y0, y0 + 0.04, z0 + t, z1, FLOOR));
  open.add(slab(x0, x1, y0 - 0.002, y0 + 0.002, z0, z1, INSIDE));
  // the tailgate, hinged at the floor at the back
  const gate = new THREE.Group();
  gate.position.set(0, y0, z1);
  gate.add(slab(x0, x1, 0, y1 - y0, -t, 0, paint));
  for (const x of [x0 + 0.12, x1 - 0.12]) gate.add(slab(x - 0.03, x + 0.03, y1 - y0 - 0.08, y1 - y0 - 0.02, 0, 0.025, INSIDE));
  open.add(gate);
  // the tarpaulin without its rear flap: the sides, the roof, the front
  const c = 0.02;
  open.add(slab(tx0, tx0 + c, ty0, ty1, tz0, tz1, cloth), slab(tx1 - c, tx1, ty0, ty1, tz0, tz1, cloth), slab(tx0, tx1, ty1 - c, ty1, tz0, tz1, cloth), slab(tx0, tx1, ty0, ty1, tz0, tz0 + c, cloth));
  // the rear flap, rolled up from below, and its roll
  const flap = slab(tx0, tx1, 0, 1, tz1 - c, tz1, cloth);
  const roll = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, tx1 - tx0, 12).rotateZ(Math.PI / 2), cloth);
  open.add(flap, roll);
  open.visible = false;
  group.add(open);
  return {
    set(o: number): void {
      const on = o > 0;
      open.visible = on;
      body.visible = !on;
      tarp.visible = !on;
      if (!on) return;
      // the flap first, then the gate
      const f = Math.min(1, o / 0.55);
      const g = Math.max(0, (o - 0.4) / 0.6);
      const ef = f * f * (3 - 2 * f);
      const eg = g * g * (3 - 2 * g);
      const h = ty1 - ty0;
      const bottom = ty0 + h * 0.86 * ef;
      flap.scale.y = Math.max(0.001, ty1 - bottom);
      flap.position.y = (ty1 + bottom) / 2;
      const r = 0.03 + 0.06 * ef;
      roll.scale.set(1, r, r);
      roll.position.set((tx0 + tx1) / 2, bottom + r * 0.6, tz1 + r * 0.5);
      gate.rotation.x = (Math.PI / 2) * eg;
    },
  };
}

/** The truck's trailer: its box with two rear wing doors (render/boxbody.ts). */
function boxTrailer(group: THREE.Object3D, shell: THREE.Mesh): Opener {
  const [x0, x1, y0, y1, z0, z1] = extent(shell);
  const body = new BoxBody((x1 - x0) / 2, y0, y1, z0, z1, shell.material as THREE.Material);
  body.rearPlate = group.getObjectByName('trailer rear plate') ?? null;
  body.group.position.x = (x0 + x1) / 2;
  body.group.visible = false;
  group.add(body.group);
  return {
    set(o: number): void {
      const on = o > 0;
      body.group.visible = on;
      shell.visible = !on;
      body.setDoors(o);
    },
  };
}

/** Open the back of a trailer (its group, as render/fleet.ts or render/truck.ts built it): 0 shut … 1 open. */
export function setTrailerOpen(group: THREE.Object3D, open: number): void {
  let op = OPENERS.get(group);
  if (op === undefined) {
    if (open <= 0) return;
    const box = group.getObjectByName('trailer box');
    const tarp = group.getObjectByName('trailer tarp');
    op = box instanceof THREE.Mesh ? (tarp instanceof THREE.Mesh ? tarpTrailer(group, box, tarp) : boxTrailer(group, box)) : null;
    OPENERS.set(group, op);
  }
  op?.set(Math.max(0, Math.min(1, open)));
}
