// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trams and trains as seen from the road: each car a simple lofted body
 * (skirt, window band, roof), bogies, bellows between the cars, a
 * pantograph on trams.  Generic shapes and liveries – no real vehicle is
 * reproduced.  Where they are and how they move is decided in sim/rail.ts.
 */
import * as THREE from 'three';
import { carLayout } from '../sim/rail.ts';
import type { CarRole, Consist, RailLine, RailVehicle } from '../sim/rail.ts';
import { RAIL } from '../world/types.ts';
import { CONTACT_WIRE_HEIGHT } from './stopmodels.ts';

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
 * One car body.  Local frame like every vehicle of the game: x right, y up
 * from the top of the rail, the front towards -z.  `role` (sim/rail.ts
 * carLayout): a driver's cab at its front or back end – both on a unit of
 * one section –, whether its lamps are those of the end of the whole
 * consist, bellows to the next section, a trailer car.
 */
function buildCar(c: Consist, kind: number, role: CarRole, coupler: boolean): THREE.BufferGeometry {
  const t = new Tris();
  const { body, accent } = LIVERY[kind] ?? LIVERY[RAIL.TRAM];
  const hw = c.width / 2;
  const L = role.len;
  const nose: 'front' | 'back' | 'none' = role.front && !role.back ? 'front' : role.back && !role.front ? 'back' : 'none';
  const bellows = role.bellows;
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
  if (role.front) stations.push([z0, 0.8, 0.3], [z0 + taper, 1, 0]);
  else stations.push([z0, 1, 0]);
  if (role.back) stations.push([z1 - taper, 1, 0], [z1, 0.8, 0.3]);
  else stations.push([z1, 1, 0]);
  const sections = stations.map(([z, squeeze, drop]) => section(z, squeeze, drop));
  // (lofting from the front to the back keeps the faces looking outwards)
  for (let i = 0; i + 1 < sections.length; i++) loft(sections[i + 1], sections[i]);
  cap(sections[0], true, role.front);
  cap(sections[sections.length - 1], false, role.back);

  // lamps: white ahead, red behind at the ends of the whole consist – dark at a cab that faces a coupled unit
  const lamps = (z: number, colour: Rgb, out: number): void => {
    for (const side of [-1, 1]) {
      const x = side * hw * 0.5;
      t.box(x - 0.16, x + 0.16, floor + 0.66, floor + 0.86, Math.min(z, z + out), Math.max(z, z + out), colour);
    }
  };
  if (role.front) lamps(z0, role.lampsFront ? LAMP : DARK, -0.03);
  if (role.back || (role.trailer && role.lampsBack)) lamps(z1, role.lampsBack ? TAIL : DARK, 0.03);

  // running gear
  for (const k of [-0.36, 0.36]) t.box(-hw * 0.72, hw * 0.72, 0.02, floor + 0.08, k * L - 1.05, k * L + 1.05, DARK);
  // what sits on the roof (a trailer car has no equipment up there)
  if (!role.trailer) t.box(-hw * 0.55, hw * 0.55, top, top + 0.26, -L * 0.28, L * 0.28, ROOF);
  // the joint to the next section, or the coupler to the next unit or the trailer
  if (bellows) t.box(-hw * 0.8, hw * 0.8, floor + 0.1, top - 0.25, z1, z1 + c.gap, DARK);
  if (coupler) t.box(-0.18, 0.18, floor + 0.2, floor + 0.5, z1, z1 + (c.couple ?? 1.3), DARK);
  return t.geometry();
}

/** The roof of a body and the top of its roof equipment, where a pantograph stands. */
const PANTO_FOOT = 0.26;

/**
 * A pantograph in two parts: the frame of arms, one metre high (it is
 * stretched to the height the pantograph stands at), and the head with the
 * collector bow that slides along the wire (moved to the top of the arms).
 */
function pantographParts(): { arm: THREE.BufferGeometry; head: THREE.BufferGeometry } {
  const a = new Tris();
  // the lower and upper arm, seen from the side a flat "Z" – as two bars rising from the frame
  a.box(-0.05, 0.05, 0, 1, -0.62, -0.52, DARK);
  a.box(-0.05, 0.05, 0, 1, 0.22, 0.32, DARK);
  a.box(-0.45, 0.45, 0, 0.05, -0.7, 0.4, DARK);
  const h = new Tris();
  h.box(-0.78, 0.78, 0, 0.07, -0.08, 0.08, DARK);
  h.box(-0.05, 0.05, -0.06, 0, -0.6, 0.3, DARK);
  return { arm: a.geometry(), head: h.geometry() };
}

export class RailActors {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly shown = new Map<number, THREE.Group>();

  constructor() {
    this.group.name = 'rail vehicles';
  }

  private carGeometry(c: Consist, kind: number, role: CarRole, coupler: boolean): THREE.BufferGeometry {
    const key = `${kind}:${role.len}:${+role.front}${+role.back}${+role.lampsFront}${+role.lampsBack}${+role.trailer}${+role.bellows}${+coupler}`;
    let g = this.geometries.get(key);
    if (!g) this.geometries.set(key, (g = buildCar(c, kind, role, coupler)));
    return g;
  }

  private readonly panto = pantographParts();

  /** the vehicle the player rides in (its outside is not drawn: they sit inside it) */
  hidden: RailVehicle | null = null;
  /** the destination displays: one texture per text, and what each vehicle shows */
  private readonly displays = new Map<string, THREE.MeshBasicMaterial>();
  private readonly showing = new Map<number, string>();
  private readonly displayGeo = new THREE.PlaneGeometry(1.7, 0.32);

  /** The display at the front of a tram: the line and where it goes, in amber dots on black. */
  private displayMaterial(text: string): THREE.MeshBasicMaterial {
    let m = this.displays.get(text);
    if (m) return m;
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 96;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.fillStyle = '#0b0b0b';
    g.fillRect(0, 0, 512, 96);
    g.fillStyle = '#ffb21a';
    g.font = 'bold 56px "Arial Narrow", Arial, sans-serif';
    g.textBaseline = 'middle';
    const [ref, ...rest] = text.split('\n');
    g.textAlign = 'left';
    g.fillText(ref, 14, 50, 110);
    g.textAlign = 'left';
    g.font = 'bold 46px "Arial Narrow", Arial, sans-serif';
    g.fillText(rest.join(' '), 140, 50, 360);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    m = new THREE.MeshBasicMaterial({ map: tex });
    this.displays.set(text, m);
    return m;
  }

  /** Show the vehicles where the simulation has them (`lines`: the lines, for the displays at their fronts). */
  update(vehicles: readonly RailVehicle[], lines: readonly RailLine[] = []): void {
    const seen = new Set<number>();
    for (const v of vehicles) {
      seen.add(v.id);
      let g = this.shown.get(v.id);
      if (!g) {
        g = new THREE.Group();
        const roles = carLayout(v.consist);
        roles.forEach((role, i) => {
          const m = new THREE.Mesh(this.carGeometry(v.consist, v.kind, role, role.back && i < roles.length - 1), this.material);
          m.castShadow = true;
          m.rotation.order = 'YXZ';
          if (role.panto && !role.trailer && v.kind !== RAIL.TRAIN) {
            // the pantograph of this unit: its arms and its head, raised and lowered with v.panto
            const arm = new THREE.Mesh(this.panto.arm, this.material);
            const head = new THREE.Mesh(this.panto.head, this.material);
            arm.name = 'pantograph';
            head.name = 'pantograph head';
            arm.position.set(0, v.consist.height + PANTO_FOOT, 0);
            head.position.set(0, v.consist.height + PANTO_FOOT, 0);
            m.add(arm, head);
            m.userData.panto = { arm, head };
          }
          g!.add(m);
        });
        this.shown.set(v.id, g);
        this.group.add(g);
      }
      g.visible = v !== this.hidden;
      // (lowered it lies folded on the roof; raised it presses its head against the wire)
      const reach = CONTACT_WIRE_HEIGHT - v.consist.height - PANTO_FOOT;
      const up = 0.16 + (reach - 0.16) * Math.max(0, Math.min(1, v.panto ?? 1));
      v.cars.forEach((car, i) => {
        const m = g!.children[i];
        m.position.set(car.x, car.y, car.z);
        m.rotation.set(car.pitch, car.yaw, 0);
        const p = m.userData.panto as { arm: THREE.Mesh; head: THREE.Mesh } | undefined;
        if (p && p.arm.scale.y !== up) {
          p.arm.scale.y = up;
          p.head.position.y = v.consist.height + PANTO_FOOT + up;
        }
      });
      // the line and its destination over the windscreen (and at the back of the last car)
      const line = v.line ? lines[v.line.index] : null;
      const text = line ? `${line.ref}\n${line.to}` : '';
      if (this.showing.get(v.id) !== text) {
        this.showing.set(v.id, text);
        // (over the windscreen at the front, and at the back of the last body with a cab – not on a trailer car)
        const roles = carLayout(v.consist);
        let last = roles.length - 1;
        while (last > 0 && !roles[last].back) last--;
        for (const m of [g.children[0], g.children[last]]) {
          const old = m.getObjectByName('display');
          if (old) m.remove(old);
        }
        if (text) {
          const c = v.consist;
          const front = new THREE.Mesh(this.displayGeo, this.displayMaterial(text));
          front.name = 'display';
          front.position.set(0, c.height - 0.42, -roles[0].len / 2 - 0.035);
          front.rotation.y = Math.PI;
          g.children[0].add(front);
          if (last > 0) {
            const back = new THREE.Mesh(this.displayGeo, this.displayMaterial(text));
            back.name = 'display';
            back.position.set(0, c.height - 0.42, roles[last].len / 2 + 0.035);
            g.children[last].add(back);
          }
        }
      }
    }
    for (const [id, g] of this.shown) {
      if (seen.has(id)) continue;
      this.group.remove(g);
      this.shown.delete(id);
      this.showing.delete(id);
    }
  }

  dispose(): void {
    for (const g of this.geometries.values()) g.dispose();
    this.panto.arm.dispose();
    this.panto.head.dispose();
    this.material.dispose();
  }
}
