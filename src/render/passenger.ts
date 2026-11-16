// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Inside a tram, as a passenger sees it: the floor, seats in pairs, the
 * yellow poles to hold on to at the doors, the walls below and above the
 * windows, the ceiling with its lights – one per car, placed where the cars
 * of the vehicle one rides in are (its outside is not drawn then, see
 * render/trams.ts).  Generic, like the trams themselves.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Consist, RailVehicle } from '../sim/rail.ts';

/** height of the floor above the rail (as the outside, render/trams.ts) */
export const FLOOR = 0.34;

function bare(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  n.deleteAttribute('uv');
  return n;
}

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): THREE.BufferGeometry {
  return bare(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
}

const PANEL = new THREE.MeshLambertMaterial({ color: 0xd8dcd6, side: THREE.DoubleSide });
const FLOORING = new THREE.MeshLambertMaterial({ color: 0x4a4f55 });
const SEAT = new THREE.MeshLambertMaterial({ color: 0x2c5f8a });
const POLE = new THREE.MeshLambertMaterial({ color: 0xf0c020 });
const LIGHT = new THREE.MeshBasicMaterial({ color: 0xfff8e6 });
const GLASS = new THREE.MeshBasicMaterial({ color: 0x9fb8c8, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });

/** The inside of one car: built once per consist, x right, y up from the rail, the front towards −z. */
function carInside(c: Consist, front: boolean): THREE.Group {
  const g = new THREE.Group();
  const hw = c.width / 2 - 0.08;
  const L = c.carLen;
  const z0 = -L / 2;
  const z1 = L / 2;
  const top = c.height - 0.18;
  const sill = FLOOR + 0.82;
  const lintel = c.height - 1.0;
  // the doors: a quarter of the way in from each end, on both sides
  const doors = [z0 + L * 0.25, z0 + L * 0.75];
  const atDoor = (z: number, half: number): boolean => doors.some((d) => Math.abs(z - d) < half);
  const panels: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    // below the windows (not at the doors), above them, the window posts
    for (let z = z0; z < z1 - 0.01; z += 0.5) {
      const za = z;
      const zb = Math.min(z1, z + 0.5);
      if (!atDoor((za + zb) / 2, 0.7)) panels.push(box(side * hw - 0.04, side * hw + 0.04, FLOOR, sill, za, zb));
    }
    panels.push(box(side * hw - 0.04, side * hw + 0.04, lintel, top, z0, z1));
    for (let z = z0 + 0.8; z < z1; z += 1.6) if (!atDoor(z, 0.75)) panels.push(box(side * hw - 0.05, side * hw + 0.05, sill, lintel, z - 0.06, z + 0.06));
  }
  // the ceiling, and the end wall behind the driver's cab
  panels.push(box(-hw, hw, top, top + 0.05, z0, z1));
  if (front) {
    panels.push(box(-hw, hw, FLOOR, sill + 0.2, z0 + 0.9, z0 + 0.96), box(-hw, -0.4, sill + 0.2, top, z0 + 0.9, z0 + 0.96), box(0.4, hw, sill + 0.2, top, z0 + 0.9, z0 + 0.96));
  }
  g.add(new THREE.Mesh(mergeGeometries(panels, false)!, PANEL));
  g.add(new THREE.Mesh(box(-hw, hw, FLOOR - 0.02, FLOOR, z0, z1), FLOORING));
  // seats in pairs along both sides, facing each other in bays, none at the doors
  const seats: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const x0 = side > 0 ? 0.25 : -hw + 0.05;
    const x1 = side > 0 ? hw - 0.05 : -0.25;
    for (let z = z0 + (front ? 1.6 : 0.6); z < z1 - 0.6; z += 0.85) {
      if (atDoor(z, 1.2)) continue;
      seats.push(box(x0, x1, FLOOR + 0.42, FLOOR + 0.5, z - 0.22, z + 0.22), box(x0, x1, FLOOR + 0.5, FLOOR + 1.05, z + 0.2, z + 0.27), box(x0 + 0.1, x1 - 0.1, FLOOR, FLOOR + 0.42, z - 0.12, z + 0.12));
    }
  }
  if (seats.length) g.add(new THREE.Mesh(mergeGeometries(seats, false)!, SEAT));
  // poles at the doors and a rail along the ceiling on each side
  const poles: THREE.BufferGeometry[] = [];
  for (const d of doors) for (const side of [-1, 1]) poles.push(bare(new THREE.CylinderGeometry(0.02, 0.02, top - FLOOR, 8).translate(side * (hw - 0.7), (FLOOR + top) / 2, d)));
  for (const side of [-1, 1]) poles.push(bare(new THREE.CylinderGeometry(0.018, 0.018, L - 0.4, 8).rotateX(Math.PI / 2).translate(side * 0.55, top - 0.15, 0)));
  g.add(new THREE.Mesh(mergeGeometries(poles, false)!, POLE));
  // lights along the middle of the ceiling
  g.add(new THREE.Mesh(box(-0.12, 0.12, top - 0.02, top, z0 + 0.4, z1 - 0.4), LIGHT));
  // the windows: hardly there, a hint of glass
  const glass: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) glass.push(box(side * hw - 0.005, side * hw + 0.005, sill, lintel, z0, z1));
  g.add(new THREE.Mesh(mergeGeometries(glass, false)!, GLASS));
  return g;
}

export class PassengerView {
  readonly group = new THREE.Group();
  private cars: THREE.Group[] = [];
  private consist: Consist | null = null;

  constructor() {
    this.group.name = 'inside the tram';
    this.group.visible = false;
  }

  /** Inside `v` (null: nobody rides – nothing is drawn). */
  show(v: RailVehicle | null): void {
    if (!v) {
      this.group.visible = false;
      return;
    }
    if (this.consist !== v.consist || this.cars.length !== v.cars.length) {
      for (const c of this.cars) this.group.remove(c);
      this.cars = v.cars.map((_, i) => carInside(v.consist, i === 0));
      for (const c of this.cars) {
        c.rotation.order = 'YXZ';
        this.group.add(c);
      }
      this.consist = v.consist;
    }
    this.group.visible = true;
    v.cars.forEach((car, i) => {
      const m = this.cars[i];
      m.position.set(car.x, car.y, car.z);
      m.rotation.set(car.pitch, car.yaw, 0);
    });
  }
}
