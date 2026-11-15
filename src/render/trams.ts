// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trams and trains as seen from the road: each car a simple lofted body
 * (skirt, window band, roof), bogies, bellows between the cars, a
 * pantograph on trams.  Generic shapes and liveries – no real vehicle is
 * reproduced.  Where they are and how they move is decided in sim/rail.ts.
 */
import * as THREE from 'three';
import { CONSISTS } from '../sim/rail.ts';
import type { Consist, RailVehicle } from '../sim/rail.ts';
import { RAIL } from '../world/types.ts';

type Rgb = [number, number, number];

const LIVERY: Record<number, { body: Rgb; accent: Rgb }> = {
  [RAIL.TRAM]: { body: [0.93, 0.93, 0.9], accent: [0.1, 0.36, 0.68] },
  [RAIL.LIGHT]: { body: [0.93, 0.93, 0.9], accent: [0.05, 0.52, 0.52] },
  [RAIL.TRAIN]: { body: [0.88, 0.88, 0.86], accent: [0.68, 0.13, 0.12] },
};
const GLASS: Rgb = [0.07, 0.1, 0.13];
const ROOF: Rgb = [0.52, 0.54, 0.56];
const DARK: Rgb = [0.12, 0.12, 0.13];
const LAMP: Rgb = [1, 0.97, 0.82];
const TAIL: Rgb = [0.8, 0.08, 0.06];

/** Collects coloured triangles; flat shading comes from not sharing vertices. */
class Tris {
  readonly pos: number[] = [];
  readonly col: number[] = [];

  tri(a: number[], b: number[], c: number[], colour: Rgb): void {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) this.col.push(colour[0], colour[1], colour[2]);
  }

  /** a, b, c, d counter-clockwise seen from outside */
  quad(a: number[], b: number[], c: number[], d: number[], colour: Rgb): void {
    this.tri(a, b, c, colour);
    this.tri(a, c, d, colour);
  }

  /** an upright box, x0…x1, y0…y1, z0…z1 */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, colour: Rgb): void {
    const p = (x: number, y: number, z: number): number[] => [x, y, z];
    this.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), colour); // back (+z)
    this.quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), colour); // front (-z)
    this.quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), colour); // left
    this.quad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), colour); // right
    this.quad(p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0), colour); // top
    this.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), colour); // bottom
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * One car.  Local frame like every vehicle of the game: x right, y up from
 * the top of the rail, the front towards -z.  `nose`: the driver's end is
 * at the front (first car), at the back (last car) or there is none.
 */
function buildCar(c: Consist, kind: number, nose: 'front' | 'back' | 'none', bellows: boolean): THREE.BufferGeometry {
  const t = new Tris();
  const { body, accent } = LIVERY[kind] ?? LIVERY[RAIL.TRAM];
  const hw = c.width / 2;
  const L = c.carLen;
  const floor = 0.34;
  const top = c.height;
  // heights of the bands of the side wall: skirt, belt, windows, band above the windows
  const bands = [floor, floor + 0.62, floor + 0.98, top - 1.02, top - 0.42];
  const sideColours: Rgb[] = [accent, body, GLASS, body];

  /** the outline of the body at a place along the car: points from the lower left over the roof to the lower right */
  const section = (z: number, squeeze: number, drop: number): number[][] => {
    const w = hw * squeeze;
    const pts: number[][] = [];
    for (const y of bands) pts.push([-w, y - (y > floor + 1 ? drop * ((y - floor) / (top - floor)) : 0), z]);
    pts.push([-w * 0.84, top - drop, z], [w * 0.84, top - drop, z]);
    for (let i = bands.length - 1; i >= 0; i--) {
      const y = bands[i];
      pts.push([w, y - (y > floor + 1 ? drop * ((y - floor) / (top - floor)) : 0), z]);
    }
    return pts;
  };
  // faces between two sections, in the order of the outline
  const colours: Rgb[] = [...sideColours, ROOF, ROOF, ROOF, ...[...sideColours].reverse()];
  const loft = (a: number[][], b: number[][]): void => {
    for (let i = 0; i + 1 < a.length; i++) t.quad(a[i], a[i + 1], b[i + 1], b[i], colours[i]);
    // the floor
    t.quad(a[a.length - 1], a[0], b[0], b[b.length - 1], DARK);
  };
  /** close the body at an end; `front`: the end looks towards -z */
  const cap = (s: number[][], front: boolean, cab: boolean): void => {
    const n = s.length;
    const mid = [0, (floor + top) / 2, s[0][2]];
    for (let i = 0; i + 1 < n; i++) {
      // a driver's end: windscreen in the window band, lamps in the belt
      const band = Math.min(i, n - 2 - i);
      const colour: Rgb = !cab ? DARK : band === 2 || band === 3 ? GLASS : band === 1 ? body : band === 0 ? accent : ROOF;
      if (front) t.tri(mid, s[i], s[i + 1], colour);
      else t.tri(mid, s[i + 1], s[i], colour);
    }
    if (front) t.tri(mid, s[n - 1], s[0], DARK);
    else t.tri(mid, s[0], s[n - 1], DARK);
  };

  const z0 = -L / 2;
  const z1 = L / 2;
  const taper = Math.min(1.5, L * 0.14);
  const stations: Array<[number, number, number]> = [];
  if (nose === 'front') stations.push([z0, 0.8, 0.3], [z0 + taper, 1, 0]);
  else stations.push([z0, 1, 0]);
  if (nose === 'back') stations.push([z1 - taper, 1, 0], [z1, 0.8, 0.3]);
  else stations.push([z1, 1, 0]);
  const sections = stations.map(([z, squeeze, drop]) => section(z, squeeze, drop));
  // (lofting from the front to the back keeps the faces looking outwards)
  for (let i = 0; i + 1 < sections.length; i++) loft(sections[i + 1], sections[i]);
  cap(sections[0], true, nose === 'front');
  cap(sections[sections.length - 1], false, nose === 'back');

  // lamps of the driver's end: white ahead, red behind
  const lamps = (z: number, colour: Rgb, out: number): void => {
    for (const side of [-1, 1]) {
      const x = side * hw * 0.5;
      t.box(x - 0.16, x + 0.16, floor + 0.66, floor + 0.86, Math.min(z, z + out), Math.max(z, z + out), colour);
    }
  };
  if (nose === 'front') lamps(z0, LAMP, -0.03);
  if (nose === 'back') lamps(z1, TAIL, 0.03);

  // running gear
  for (const k of [-0.36, 0.36]) t.box(-hw * 0.72, hw * 0.72, 0.02, floor + 0.08, k * L - 1.05, k * L + 1.05, DARK);
  // what sits on the roof
  t.box(-hw * 0.55, hw * 0.55, top, top + 0.26, -L * 0.28, L * 0.28, ROOF);
  if (kind !== RAIL.TRAIN && nose === 'none') {
    // a pantograph: two arms meeting under the wire
    const y = top + 0.26;
    t.box(-0.05, 0.05, y, y + 0.9, -0.9, -0.8, DARK);
    t.box(-0.05, 0.05, y + 0.85, y + 0.93, -0.9, 0.5, DARK);
    t.box(-0.75, 0.75, y + 0.9, y + 0.96, 0.42, 0.52, DARK);
  }
  // the joint to the next car
  if (bellows) t.box(-hw * 0.8, hw * 0.8, floor + 0.1, top - 0.25, z1, z1 + c.gap, DARK);
  return t.geometry();
}

export class RailActors {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly shown = new Map<number, THREE.Group>();

  constructor() {
    this.group.name = 'rail vehicles';
  }

  private carGeometry(kind: number, index: number, count: number): THREE.BufferGeometry {
    const nose = index === 0 ? 'front' : index === count - 1 ? 'back' : 'none';
    const key = `${kind}:${nose}:${index < count - 1 ? 1 : 0}`;
    let g = this.geometries.get(key);
    if (!g) this.geometries.set(key, (g = buildCar(CONSISTS[kind] ?? CONSISTS[RAIL.TRAM], kind, nose, index < count - 1)));
    return g;
  }

  /** Show the vehicles where the simulation has them. */
  update(vehicles: readonly RailVehicle[]): void {
    const seen = new Set<number>();
    for (const v of vehicles) {
      seen.add(v.id);
      let g = this.shown.get(v.id);
      if (!g) {
        g = new THREE.Group();
        v.cars.forEach((_, i) => {
          const m = new THREE.Mesh(this.carGeometry(v.kind, i, v.cars.length), this.material);
          m.castShadow = true;
          m.rotation.order = 'YXZ';
          g!.add(m);
        });
        this.shown.set(v.id, g);
        this.group.add(g);
      }
      v.cars.forEach((car, i) => {
        const m = g!.children[i];
        m.position.set(car.x, car.y, car.z);
        m.rotation.set(car.pitch, car.yaw, 0);
      });
    }
    for (const [id, g] of this.shown) {
      if (seen.has(id)) continue;
      this.group.remove(g);
      this.shown.delete(id);
    }
  }

  dispose(): void {
    for (const g of this.geometries.values()) g.dispose();
    this.material.dispose();
  }
}
