// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The box body of a truck with its two rear doors, which open: for the
 * goods to be loaded (render/loading.ts).
 *
 * The box is a shell – paint outside, plywood inside, a floor of planks –
 * open at the back behind a frame, and closed there by two doors hung at
 * the rear corners.  Opened, each door swings out and round until it lies
 * against the side of the box (270°, held there as on a real truck), and
 * the inside of the box is seen.
 *
 * The frame is the truck's: x to the right, y up, z to the back; the box
 * runs from `front` to `rear` along z, from `floor` to `top` in height.
 */
import * as THREE from 'three';

const PLY = new THREE.MeshLambertMaterial({ color: 0xc2b59c });
const PLANKS = new THREE.MeshLambertMaterial({ color: 0x6e5a44 });
const FRAME = new THREE.MeshLambertMaterial({ color: 0x3a3f45 });
const STEEL = new THREE.MeshLambertMaterial({ color: 0x8d949b });

/** A quad facing along `normal`, from (a0, b0) to (a1, b1) in its plane – see `face`. */
function face(axis: 'x' | 'y' | 'z', sign: number, a0: number, a1: number, b0: number, b1: number, at: number, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(a1 - a0), Math.abs(b1 - b0)), material);
  const a = (a0 + a1) / 2;
  const b = (b0 + b1) / 2;
  if (axis === 'z') {
    // a: x, b: y
    m.position.set(a, b, at);
    if (sign < 0) m.rotation.y = Math.PI;
  } else if (axis === 'x') {
    // a: z, b: y
    m.position.set(at, b, a);
    m.rotation.y = sign > 0 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    // a: x, b: z
    m.position.set(a, at, b);
    m.rotation.x = sign > 0 ? -Math.PI / 2 : Math.PI / 2;
  }
  return m;
}

function block(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), material);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return m;
}

export class BoxBody {
  readonly group = new THREE.Group();
  /** the inside: where the goods may stand (truck frame) */
  readonly inside: { x0: number; x1: number; floor: number; top: number; front: number; rear: number };
  /** the plate with the lettering on the doors: hidden while they are open */
  rearPlate: THREE.Object3D | null = null;
  private readonly doors: THREE.Group[] = [];
  private open = 0;

  /** `paint`: the outside of the box */
  constructor(hw: number, floor: number, top: number, front: number, rear: number, paint: THREE.Material) {
    const g = this.group;
    g.name = 'box body';
    const t = 0.05;
    // the shell outside: front, sides, roof, underside
    const outer: THREE.Mesh[] = [
      face('z', -1, -hw, hw, floor, top, front, paint),
      face('x', -1, front, rear, floor, top, -hw, paint),
      face('x', 1, front, rear, floor, top, hw, paint),
      face('y', 1, -hw, hw, front, rear, top, paint),
      face('y', -1, -hw, hw, front, rear, floor, paint),
    ];
    for (const m of outer) m.castShadow = true;
    g.add(...outer);
    // inside: plywood walls and roof, a floor of planks
    const i0 = -hw + t;
    const i1 = hw - t;
    const f = floor + 0.03;
    const top1 = top - t;
    g.add(
      face('z', 1, i0, i1, f, top1, front + t, PLY),
      face('x', 1, front + t, rear, f, top1, i0, PLY),
      face('x', -1, front + t, rear, f, top1, i1, PLY),
      face('y', -1, i0, i1, front + t, rear, top1, PLY),
      face('y', 1, i0, i1, front + t, rear, f, PLANKS),
    );
    // the rear frame round the opening: the posts, the header and the sill
    g.add(block(-hw, i0, floor, top, rear - 0.08, rear, FRAME), block(i1, hw, floor, top, rear - 0.08, rear, FRAME), block(-hw, hw, top1, top, rear - 0.08, rear, FRAME), block(-hw, hw, floor - 0.06, f, rear - 0.12, rear, STEEL));
    this.inside = { x0: i0, x1: i1, floor: f, top: top1, front: front + t, rear: rear - 0.08 };
    // the doors: hung at the rear corners, each closing half the opening
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * (hw + 0.02), 0, rear);
      const w = hw + 0.01;
      const x0 = side < 0 ? 0 : -w;
      const x1 = side < 0 ? w : 0;
      const leaf = block(x0, x1, floor + 0.02, top - 0.02, 0.005, 0.055, paint);
      leaf.castShadow = true;
      pivot.add(leaf);
      // two locking bars on each door, and its hinges
      for (const k of [0.3, 0.75]) {
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, top - floor - 0.1, 6), STEEL);
        bar.position.set(-side * w * k, (floor + top) / 2, 0.075);
        pivot.add(bar);
      }
      for (const y of [floor + 0.35, (floor + top) / 2, top - 0.35]) pivot.add(block(-0.05, 0.05, y - 0.06, y + 0.06, -0.01, 0.07, FRAME));
      this.doors.push(pivot);
      g.add(pivot);
    }
  }

  /** How far the doors are open: 0 shut … 1 swung round against the sides. */
  setDoors(open: number): void {
    const o = Math.max(0, Math.min(1, open));
    if (o === this.open) return;
    this.open = o;
    // (the left door turns one way, the right one the other; both outwards first)
    const a = o * ((260 * Math.PI) / 180);
    this.doors[0].rotation.y = -a;
    this.doors[1].rotation.y = a;
    if (this.rearPlate) this.rearPlate.visible = o < 0.01;
  }

  get doorsOpen(): number {
    return this.open;
  }
}
