// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trams and trains as seen from the road: each car a simple lofted body
 * (skirt, window band, roof), bogies, bellows between the cars, a
 * pantograph on trams.  Generic shapes and liveries – no real vehicle is
 * reproduced.  Where they are and how they move is decided in sim/rail.ts.
 *
 * With the detail on (`RailActors.detail`: medium graphics and above) every
 * body has double plug doors on both sides.  Shut they are drawn as part of
 * the body; while they move and stand open the body with its doorways is
 * drawn instead, and the leaves – meshes of their own – come out of the wall
 * and slide apart.  Without the detail the bodies are the plain ones.
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
/** inside an open door: the walls of the doorway – as dark as the inside seen through the windows –, and its threshold (a metal plate) */
const INSIDE: Rgb = [0.075, 0.08, 0.085];
const SILL: Rgb = [0.55, 0.56, 0.57];

/** the floor of the bodies over the top of the rail (low-floor: the doors open at its height) */
const FLOOR = 0.34;

/** Heights of the bands of a side wall: skirt, belt, windows, the band above the windows, where the roof begins. */
function wallBands(top: number): number[] {
  return [FLOOR, FLOOR + 0.62, FLOOR + 0.98, top - 1.02, top - 0.42];
}

/** how far the slanted end of a body with a driver's cab reaches back */
const capTaper = (len: number): number => Math.min(1.5, len * 0.14);

/**
 * The passenger doors: double plug doors with an opening this wide, a frame
 * round it in the livery's accent colour.  A leaf is this thick; opening, it
 * first comes this far out of the wall, then slides along the wall by its
 * own width, which clears the opening.
 */
const DOOR_WIDTH = 1.3;
const DOOR_FRAME = 0.07;
const LEAF_THICK = 0.04;
const LEAF_OUT = 0.07;
const LEAF_SLIDE = DOOR_WIDTH / 2;

/** How high the opening of a door reaches: to the top of the window band, but not much over two metres. */
const doorTop = (bands: readonly number[]): number => Math.min(bands[3], FLOOR + 2.25);

/** A passenger door of a body: the middle of its opening (metres from the middle of the body, negative towards its front), the side (-1 left, 1 right), the width of the opening. */
export interface DoorPlace {
  z: number;
  side: -1 | 1;
  width: number;
}

const doorLists = new WeakMap<CarRole, readonly DoorPlace[]>();

/**
 * The passenger doors of a body (sim/rail.ts carLayout): two double doors
 * on each side, a quarter of the body's length before and behind its middle
 * – just behind the cab on an end section, evenly spread on a middle
 * section and on a trailer car.  (render/transit.ts sends the people at the
 * stops to the same places.)  Only doors that fit beside the slanted cab
 * ends and beside each other are there.
 */
export function carDoors(role: CarRole): readonly DoorPlace[] {
  let list = doorLists.get(role);
  if (list) return list;
  const L = role.len;
  const taper = capTaper(L);
  // the straight part of the side wall, between the slanted cab ends
  const from = -L / 2 + (role.front ? taper : 0);
  const to = L / 2 - (role.back ? taper : 0);
  const half = DOOR_WIDTH / 2 + DOOR_FRAME;
  const out: DoorPlace[] = [];
  for (const k of [-0.25, 0.25]) {
    const z = k * L;
    if (z - half < from + 0.05 || z + half > to - 0.05 || Math.abs(z) < half + 0.05) continue;
    for (const side of [-1, 1] as const) out.push({ z, side, width: DOOR_WIDTH });
  }
  list = out;
  doorLists.set(role, list);
  return list;
}

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

  /** a flat face a, b, c, d (in order round it, either way) turned to look along `n` */
  face(a: number[], b: number[], c: number[], d: number[], n: readonly number[], colour: Rgb): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const along = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
    if (along >= 0) this.quad(a, b, c, d, colour);
    else this.quad(d, c, b, a, colour);
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
 * The doors of a body drawn with it: none (the plain body), shut (the leaves
 * in the wall), or open (doorways – the leaves are meshes of their own then).
 */
type DoorMode = 'none' | 'shut' | 'open';

/** what a stretch of a side wall between two sections of the loft is: plain wall, the frame beside a door, a door's opening */
const WALL = 0;
const FRAME = 1;
const OPENING = 2;

/**
 * One car body.  Local frame like every vehicle of the game: x right, y up
 * from the top of the rail, the front towards -z.  `role` (sim/rail.ts
 * carLayout): a driver's cab at its front or back end – both on a unit of
 * one section –, whether its lamps are those of the end of the whole
 * consist, bellows to the next section, a trailer car.  `mode`: its doors.
 */
function buildCar(c: Consist, kind: number, role: CarRole, coupler: boolean, mode: DoorMode = 'none'): THREE.BufferGeometry {
  const t = new Tris();
  const { body, accent } = LIVERY[kind] ?? LIVERY[RAIL.TRAM];
  const hw = c.width / 2;
  const L = role.len;
  const nose: 'front' | 'back' | 'none' = role.front && !role.back ? 'front' : role.back && !role.front ? 'back' : 'none';
  const bellows = role.bellows;
  const floor = FLOOR;
  const top = c.height;
  // heights of the bands of the side wall: skirt, belt, windows, band above the windows
  const bands = wallBands(top);
  const sideColours: Rgb[] = [accent, body, GLASS, body];
  // The doors: where along the body (none on the plain body).  The wall is cut at the top of
  // their openings and of their frames too – all along the body, so that the stretches of the
  // wall meet corner to corner and no crack opens between them.
  const doors = mode === 'none' ? [] : carDoors(role).filter((d) => d.side > 0).map((d) => d.z);
  const opening = doorTop(bands);
  const frameTop = Math.min(opening + DOOR_FRAME, bands[4]);
  const levels = doors.length === 0 ? bands : [...new Set([...bands, opening, frameTop])].sort((a, b) => a - b);
  // the band of each piece of the side wall between two levels (0 skirt … 3 above the windows)
  const bandOf = levels.slice(0, -1).map((y) => {
    let j = 0;
    while (j + 1 < bands.length - 1 && bands[j + 1] <= y) j++;
    return j;
  });

  /** the outline of the body at a place along the car: points from the lower left over the roof to the lower right */
  const section = (z: number, squeeze: number, drop: number): number[][] => {
    const w = hw * squeeze;
    const pts: number[][] = [];
    for (const y of levels) pts.push([-w, y - (y > floor + 1 ? drop * ((y - floor) / (top - floor)) : 0), z]);
    pts.push([-w * 0.84, top - drop, z], [w * 0.84, top - drop, z]);
    for (let i = levels.length - 1; i >= 0; i--) {
      const y = levels[i];
      pts.push([w, y - (y > floor + 1 ? drop * ((y - floor) / (top - floor)) : 0), z]);
    }
    return pts;
  };
  // faces between two sections, in the order of the outline: the band of each (4 the edge of the roof, 5 its top) and its colour
  const segBand = [...bandOf, 4, 5, 4, ...[...bandOf].reverse()];
  const colours: Rgb[] = segBand.map((b) => (b < 4 ? sideColours[b] : ROOF));
  const nSide = levels.length - 1;
  const loft = (a: number[][], b: number[][], stretch = WALL): void => {
    for (let i = 0; i + 1 < a.length; i++) {
      let colour = colours[i];
      if (stretch !== WALL && (i < nSide || i >= nSide + 3)) {
        // a side wall at a door: the frame reaches up to its top, the opening is open up to its top
        const y1 = levels[(i < nSide ? i : 2 * nSide + 2 - i) + 1];
        if (stretch === OPENING && y1 <= opening) continue;
        if (y1 <= frameTop) colour = accent;
      }
      t.quad(a[i], a[i + 1], b[i + 1], b[i], colour);
    }
    // the floor
    t.quad(a[a.length - 1], a[0], b[0], b[b.length - 1], DARK);
  };
  /** close the body at an end; `front`: the end looks towards -z */
  const cap = (s: number[][], front: boolean, cab: boolean): void => {
    const n = s.length;
    const mid = [0, (floor + top) / 2, s[0][2]];
    for (let i = 0; i + 1 < n; i++) {
      // a driver's end: windscreen in the window band, lamps in the belt
      const band = segBand[i];
      const colour: Rgb = !cab ? DARK : band === 2 || band === 3 ? GLASS : band === 1 ? body : band === 0 ? accent : ROOF;
      if (front) t.tri(mid, s[i], s[i + 1], colour);
      else t.tri(mid, s[i + 1], s[i], colour);
    }
    if (front) t.tri(mid, s[n - 1], s[0], DARK);
    else t.tri(mid, s[0], s[n - 1], DARK);
  };

  const z0 = -L / 2;
  const z1 = L / 2;
  const taper = capTaper(L);
  // the sections along the body: where, how much narrower and lower than the body it is there (at a
  // slanted cab end), and what the stretch of wall that begins there is (WALL, FRAME, OPENING)
  const stations: Array<[number, number, number, number]> = [];
  if (role.front) stations.push([z0, 0.8, 0.3, WALL], [z0 + taper, 1, 0, WALL]);
  else stations.push([z0, 1, 0, WALL]);
  const half = DOOR_WIDTH / 2;
  for (const z of doors) stations.push([z - half - DOOR_FRAME, 1, 0, FRAME], [z - half, 1, 0, OPENING], [z + half, 1, 0, FRAME], [z + half + DOOR_FRAME, 1, 0, WALL]);
  if (role.back) stations.push([z1 - taper, 1, 0, WALL], [z1, 0.8, 0.3, WALL]);
  else stations.push([z1, 1, 0, WALL]);
  const sections = stations.map(([z, squeeze, drop]) => section(z, squeeze, drop));
  // (lofting from the front to the back keeps the faces looking outwards)
  for (let i = 0; i + 1 < sections.length; i++) loft(sections[i + 1], sections[i], stations[i][3]);
  cap(sections[0], true, role.front);
  cap(sections[sections.length - 1], false, role.back);

  // Open: in each opening a shallow doorway, so that nothing shows through the body.  Shut: the
  // leaves in the opening, and well behind them a dark back (where they meet the frame no light
  // of the sky shows through a crack).
  const depth = hw * 0.25;
  for (const z of doors) {
    for (const s of [-1, 1] as const) {
      if (mode === 'open') {
        doorway(t, s, s * hw, depth, z, levels, opening);
        continue;
      }
      const xb = s * (hw - depth);
      t.face([xb, floor, z - half], [xb, floor, z + half], [xb, opening, z + half], [xb, opening, z - half], [s, 0, 0], INSIDE);
      for (const way of [-1, 1] as const) doorLeaf(t, s, way, s * hw, z, opening, bands[1], body, false);
    }
  }

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

/**
 * The doorway behind the opening of a door on side `s` (the wall at `x`):
 * its back `depth` into the body, its sides, its ceiling, the threshold.
 * Its back and sides are cut at the levels of the wall beside them, so that
 * they meet it corner to corner.
 */
function doorway(t: Tris, s: -1 | 1, x: number, depth: number, z: number, levels: readonly number[], top: number): void {
  const xi = x - s * depth;
  const za = z - DOOR_WIDTH / 2;
  const zb = z + DOOR_WIDTH / 2;
  for (let j = 0; j + 1 < levels.length && levels[j + 1] <= top; j++) {
    const y0 = levels[j];
    const y1 = levels[j + 1];
    t.face([xi, y0, za], [xi, y0, zb], [xi, y1, zb], [xi, y1, za], [s, 0, 0], INSIDE);
    t.face([x, y0, za], [xi, y0, za], [xi, y1, za], [x, y1, za], [0, 0, 1], INSIDE);
    t.face([x, y0, zb], [xi, y0, zb], [xi, y1, zb], [x, y1, zb], [0, 0, -1], INSIDE);
  }
  t.face([x, top, za], [xi, top, za], [xi, top, zb], [x, top, zb], [0, -1, 0], INSIDE);
  t.face([x, FLOOR, za], [xi, FLOOR, za], [xi, FLOOR, zb], [x, FLOOR, zb], [0, 1, 0], SILL);
}

/**
 * One leaf of the door at `z` on side `s` (its face in the wall at `x`),
 * shut: the one that slides towards `way` (-1 the front, 1 the back).  A
 * panel in the body colour with a window from `window` up, dark seals where
 * the leaves meet and round the edge.  `edges`: its thin sides too – a leaf
 * out of the wall shows them; shut in the wall only its face is seen.
 */
function doorLeaf(t: Tris, s: -1 | 1, way: -1 | 1, x: number, z: number, top: number, window: number, body: Rgb, edges: boolean): void {
  const w = DOOR_WIDTH / 2;
  /** a part of its face: across it from where the leaves meet (0) to the frame (w), and from y0 up to y1 */
  const part = (u0: number, u1: number, y0: number, y1: number, colour: Rgb): void => {
    const a = z + way * u0;
    const b = z + way * u1;
    t.face([x, y0, a], [x, y0, b], [x, y1, b], [x, y1, a], [s, 0, 0], colour);
  };
  const seal = 0.03;
  const rim = 0.025;
  const stile = 0.06;
  const head = top - rim - 0.1;
  part(0, seal, FLOOR, top, DARK);
  part(w - rim, w, FLOOR, top, DARK);
  part(seal, w - rim, top - rim, top, DARK);
  part(seal, w - rim, FLOOR, window, body);
  part(seal, w - rim, head, top - rim, body);
  part(seal, seal + stile, window, head, body);
  part(w - rim - stile, w - rim, window, head, body);
  part(seal + stile, w - rim - stile, window, head, GLASS);
  if (!edges) return;
  const xi = x - s * LEAF_THICK;
  const zb = z + way * w;
  t.face([x, top, z], [xi, top, z], [xi, top, zb], [x, top, zb], [0, 1, 0], DARK);
  t.face([x, FLOOR, z], [xi, FLOOR, z], [xi, FLOOR, zb], [x, FLOOR, zb], [0, -1, 0], DARK);
  t.face([x, FLOOR, z], [xi, FLOOR, z], [xi, top, z], [x, top, z], [0, 0, -way], DARK);
  t.face([x, FLOOR, zb], [xi, FLOOR, zb], [xi, top, zb], [x, top, zb], [0, 0, way], DARK);
}

/** The leaves of the doors of a body on side `side` that slide towards `way`, shut: one mesh moves them all. */
function buildLeaves(c: Consist, kind: number, role: CarRole, side: -1 | 1, way: -1 | 1): THREE.BufferGeometry {
  const t = new Tris();
  const { body } = LIVERY[kind] ?? LIVERY[RAIL.TRAM];
  const bands = wallBands(c.height);
  for (const d of carDoors(role)) if (d.side === side) doorLeaf(t, side, way, (side * c.width) / 2, d.z, doorTop(bands), bands[1], body, true);
  return t.geometry();
}

/** the four groups of leaves of a body: (side, way) – left and right, sliding to the front and to the back */
const LEAF_GROUPS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
] as const;

/** The doors of a car body as drawn: the body with them shut and with its doorways, and the four groups of leaves (LEAF_GROUPS). */
interface CarDoors {
  shut: THREE.BufferGeometry;
  open: THREE.BufferGeometry;
  leaves: THREE.Mesh[];
}

const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * The doors of a vehicle `open` (0 shut … 1 open), as plug doors move: the
 * leaves first come out of the wall, then slide apart along it – and back
 * the same way.  Shut, the body has its doors drawn in and the leaves are
 * not drawn (one mesh a car, as without doors).
 */
function placeLeaves(g: THREE.Group, open: number): void {
  const out = LEAF_OUT * ease(open / 0.25);
  // (sliding starts when a leaf is clear of the wall)
  const slide = LEAF_SLIDE * ease((open - 0.2) / 0.8);
  for (const m of g.children) {
    const d = m.userData.doors as CarDoors | undefined;
    if (!d) continue;
    (m as THREE.Mesh).geometry = open > 0 ? d.open : d.shut;
    for (let k = 0; k < LEAF_GROUPS.length; k++) {
      const [side, way] = LEAF_GROUPS[k];
      const leaf = d.leaves[k];
      leaf.visible = open > 0;
      leaf.position.set(side * out, 0, way * slide);
      leaf.updateMatrix();
    }
  }
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
  /** the bodies with doors and the leaves (let go when the detail is switched off) */
  private readonly doorGeometries = new Map<string, THREE.BufferGeometry>();
  private readonly shown = new Map<number, THREE.Group>();

  constructor() {
    this.group.name = 'rail vehicles';
  }

  private detailOn = true;
  /** what was shown last: shown again at once when the detail changes (the yard of every model is shown only once) */
  private lastVehicles: readonly RailVehicle[] | null = null;
  private lastLines: readonly RailLine[] = [];

  /**
   * Doors on the bodies, opening and shutting (true, the default) – or the
   * plain bodies (false: the low graphics setting).  Changing it builds
   * what is shown anew.
   */
  get detail(): boolean {
    return this.detailOn;
  }

  set detail(on: boolean) {
    if (on === this.detailOn) return;
    this.detailOn = on;
    for (const g of this.shown.values()) this.group.remove(g);
    this.shown.clear();
    this.showing.clear();
    if (!on) {
      for (const g of this.doorGeometries.values()) g.dispose();
      this.doorGeometries.clear();
    }
    if (this.lastVehicles) this.update(this.lastVehicles, this.lastLines);
  }

  private carGeometry(c: Consist, kind: number, role: CarRole, coupler: boolean, mode: DoorMode = 'none'): THREE.BufferGeometry {
    const key = `${kind}:${role.len}:${+role.front}${+role.back}${+role.lampsFront}${+role.lampsBack}${+role.trailer}${+role.bellows}${+coupler}`;
    const cache = mode === 'none' ? this.geometries : this.doorGeometries;
    const k = mode === 'none' ? key : `${key}:${mode}`;
    let g = cache.get(k);
    if (!g) cache.set(k, (g = buildCar(c, kind, role, coupler, mode)));
    return g;
  }

  private leafGeometry(c: Consist, kind: number, role: CarRole, side: -1 | 1, way: -1 | 1): THREE.BufferGeometry {
    const key = `${kind}:${role.len}:${+role.front}${+role.back}:leaves${side}${way}`;
    let g = this.doorGeometries.get(key);
    if (!g) this.doorGeometries.set(key, (g = buildLeaves(c, kind, role, side, way)));
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
    this.lastVehicles = vehicles;
    this.lastLines = lines;
    const seen = new Set<number>();
    for (const v of vehicles) {
      seen.add(v.id);
      let g = this.shown.get(v.id);
      if (!g) {
        g = new THREE.Group();
        const roles = carLayout(v.consist);
        roles.forEach((role, i) => {
          const coupler = role.back && i < roles.length - 1;
          // (with the detail a body with doors, drawn shut – see placeLeaves)
          const doors = this.detailOn && carDoors(role).length > 0;
          const m = new THREE.Mesh(this.carGeometry(v.consist, v.kind, role, coupler, doors ? 'shut' : 'none'), this.material);
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
          if (doors) {
            // the leaves, in four groups that each move one way; drawn only while the doors are not shut
            const leaves = LEAF_GROUPS.map(([side, way]) => {
              const leaf = new THREE.Mesh(this.leafGeometry(v.consist, v.kind, role, side, way), this.material);
              leaf.name = 'door leaves';
              leaf.visible = false;
              // (moved only when the doors move)
              leaf.matrixAutoUpdate = false;
              m.add(leaf);
              return leaf;
            });
            const d: CarDoors = { shut: m.geometry, open: this.carGeometry(v.consist, v.kind, role, coupler, 'open'), leaves };
            m.userData.doors = d;
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
      // the doors: only when they have moved since the last picture
      const open = Math.max(0, Math.min(1, v.doors ?? 0));
      if (g.userData.doorsAt !== open) {
        g.userData.doorsAt = open;
        placeLeaves(g, open);
      }
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
    for (const g of this.doorGeometries.values()) g.dispose();
    this.panto.arm.dispose();
    this.panto.head.dispose();
    this.material.dispose();
  }
}
