// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Deer and wild boar, from a few boxes each: a roe deer (brown, the white
 * patch on its rump, big ears) and a wild boar (dark, bristly, a long
 * snout) – or a young boar, smaller and lighter.  The legs swing with the
 * distance run, so the hooves keep step at any speed: a bounding gallop for
 * the deer, a trot for the boar; standing, a deer holds its head up.
 *
 * Used by the theory lessons (render/theory.ts) and by the animals that
 * cross the country roads at dusk (render/wildlife.ts, sim/wildlife.ts).
 * The geometries and the material are shared: a model costs six meshes.
 *
 * Local frame as for the cars: −z is forwards, y is up, the origin lies on
 * the ground under the middle of the body.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** a roe deer, a wild boar, a young boar */
export type AnimalKind = 'deer' | 'boar' | 'piglet';

function tint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (geo.getAttribute('uv')) geo.deleteAttribute('uv');
  return geo.index ? geo.toNonIndexed() : geo;
}

/** A box w × h × l with its middle at (x, y, z), tipped by rx (nose up: positive). */
function box(w: number, h: number, l: number, x: number, y: number, z: number, hex: number, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, l);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return tint(g, hex);
}

/** The measures of a kind: the body, where the legs hang from and how long they are, the length of a stride. */
interface Build {
  body: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
  /** the hips and shoulders (x, z) and their height */
  hips: Array<[number, number]>;
  hipY: number;
  /** metres per stride; how far the legs swing (rad) at a run */
  stride: number;
  swing: number;
  /** a gallop (front and hind legs in pairs) or a trot (diagonal pairs) */
  gallop: boolean;
}

const builds = new Map<AnimalKind, Build>();

function deer(): Build {
  const coat = 0x8b5a32;
  const belly = 0xb08660;
  const dark = 0x2b211b;
  const parts = [
    box(0.3, 0.34, 0.86, 0, 0.68, 0.02, coat),
    box(0.26, 0.1, 0.7, 0, 0.53, 0.02, belly),
    // the neck, slanting up and forwards, and the head
    box(0.13, 0.42, 0.16, 0, 0.92, -0.42, coat, -0.45),
    box(0.15, 0.16, 0.3, 0, 1.12, -0.6, coat, 0.15),
    box(0.09, 0.09, 0.08, 0, 1.08, -0.77, dark),
    // the ears
    box(0.04, 0.15, 0.07, 0.08, 1.24, -0.52, coat, 0.2),
    box(0.04, 0.15, 0.07, -0.08, 1.24, -0.52, coat, 0.2),
    // the white patch on the rump, the tiny tail
    box(0.24, 0.24, 0.06, 0, 0.7, 0.46, 0xeae6dc),
    box(0.05, 0.06, 0.04, 0, 0.8, 0.5, coat),
  ];
  const leg = mergeGeometries([box(0.07, 0.3, 0.08, 0, -0.15, 0, coat), box(0.045, 0.26, 0.05, 0, -0.42, 0.01, 0x6e4a2c), box(0.05, 0.04, 0.07, 0, -0.55, -0.01, dark)]) as THREE.BufferGeometry;
  return { body: mergeGeometries(parts) as THREE.BufferGeometry, leg, hips: [[0.1, -0.33], [-0.1, -0.33], [0.1, 0.36], [-0.1, 0.36]], hipY: 0.57, stride: 2.2, swing: 0.75, gallop: true };
}

function boar(young: boolean): Build {
  const coat = young ? 0x7a5a3a : 0x3a302a;
  const dark = young ? 0x4a3524 : 0x241e1a;
  const s = young ? 0.5 : 1;
  const parts = [
    // the body, higher at the shoulders, the bristly ridge along the back
    box(0.46 * s, 0.5 * s, 0.95 * s, 0, 0.6 * s, 0.02 * s, coat, 0.06),
    box(0.12 * s, 0.1 * s, 0.7 * s, 0, 0.88 * s, -0.04 * s, dark, 0.06),
    // the head, long and pointing down, the snout
    box(0.3 * s, 0.3 * s, 0.38 * s, 0, 0.56 * s, -0.6 * s, coat, -0.35),
    box(0.16 * s, 0.14 * s, 0.14 * s, 0, 0.43 * s, -0.8 * s, dark, -0.35),
    box(0.05 * s, 0.1 * s, 0.06 * s, 0.11 * s, 0.76 * s, -0.5 * s, dark),
    box(0.05 * s, 0.1 * s, 0.06 * s, -0.11 * s, 0.76 * s, -0.5 * s, dark),
    box(0.03 * s, 0.18 * s, 0.03 * s, 0, 0.58 * s, 0.52 * s, dark, 0.4),
  ];
  const leg = mergeGeometries([box(0.1 * s, 0.22 * s, 0.11 * s, 0, -0.11 * s, 0, coat), box(0.07 * s, 0.16 * s, 0.07 * s, 0, -0.3 * s, 0, dark)]) as THREE.BufferGeometry;
  return { body: mergeGeometries(parts) as THREE.BufferGeometry, leg, hips: [[0.14 * s, -0.3 * s], [-0.14 * s, -0.3 * s], [0.14 * s, 0.33 * s], [-0.14 * s, 0.33 * s]], hipY: 0.38 * s, stride: 1.1 * s, swing: 0.6, gallop: false };
}

function buildOf(kind: AnimalKind): Build {
  let b = builds.get(kind);
  if (!b) {
    b = kind === 'deer' ? deer() : boar(kind === 'piglet');
    b.body.computeVertexNormals();
    b.leg.computeVertexNormals();
    builds.set(kind, b);
  }
  return b;
}

const SKIN = new THREE.MeshLambertMaterial({ vertexColors: true });

/** One animal: its body and four legs that swing. */
export class AnimalModel {
  readonly group = new THREE.Group();
  readonly kind: AnimalKind;
  private readonly body: THREE.Mesh;
  private readonly legs: THREE.Group[] = [];
  private readonly b: Build;

  constructor(kind: AnimalKind) {
    this.kind = kind;
    this.b = buildOf(kind);
    this.body = new THREE.Mesh(this.b.body, SKIN);
    this.body.castShadow = true;
    this.group.add(this.body);
    for (const [x, z] of this.b.hips) {
      const pivot = new THREE.Group();
      pivot.position.set(x, this.b.hipY, z);
      const m = new THREE.Mesh(this.b.leg, SKIN);
      m.castShadow = true;
      pivot.add(m);
      this.group.add(pivot);
      this.legs.push(pivot);
    }
    this.group.name = kind;
  }

  /**
   * The legs and the body for `dist` metres run so far at `speed` m/s:
   * standing still, the legs straight (a deer's head up, watching).
   */
  pose(dist: number, speed: number): void {
    const b = this.b;
    const run = Math.min(1, Math.max(0, speed / 3));
    const phase = (dist / b.stride) * Math.PI * 2;
    const amp = b.swing * run;
    // gallop: the front pair, then the hind pair (a little apart); trot: the diagonals together
    const off = b.gallop ? [0, 0.35, Math.PI, Math.PI + 0.35] : [0, Math.PI, Math.PI, 0];
    for (let i = 0; i < 4; i++) this.legs[i].rotation.x = Math.sin(phase + off[i]) * amp;
    // the body rises and falls with the bounds, and pitches a little
    this.body.position.y = (b.gallop ? 0.06 : 0.02) * run * Math.abs(Math.sin(phase));
    this.body.rotation.x = (b.gallop ? 0.08 : 0.02) * run * Math.sin(phase + 0.6);
  }
}
