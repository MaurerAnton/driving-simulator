// SPDX-License-Identifier: AGPL-3.0-only
/**
 * People on foot at the stops of trams and buses: waiting, sitting on a
 * bench, walking to the doors, getting off and walking away.
 *
 * There may be a few hundred of them, so each part of the body is one
 * instanced mesh for everybody – thighs, lower legs, torso, arms, the head
 * with its hair, and what people carry –: six draw calls for a crowd.  The
 * pose of every part is worked out here each frame from where a person is
 * and how far they have walked; the gait follows the distance, so the feet
 * keep step at any speed, and the lowest foot always stands on the ground.
 *
 * What a person looks like – clothes and their colours, hair, height
 * (children too), a bag, a backpack, a suitcase on wheels, a walking stick –
 * follows from one number, so the same person looks the same every time.
 * The variants of a part (hair styles, a coat or a skirt, the kinds of bag)
 * share its mesh: the shader folds away those a person does not wear.
 *
 * The frame of a person is that of everything in the game: x to the right,
 * y up, the face towards −z.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01 } from '../core/geom.ts';

/** Where a person is and what they are doing (given every frame). */
export interface PersonPose {
  /** the feet on the ground – for somebody sitting, the ground below the hips */
  x: number;
  y: number;
  z: number;
  /** 0 = facing north (−z), positive = turned to the left */
  yaw: number;
  /** metres walked so far (drives the gait); −1 = standing still */
  walk: number;
  /** a whole number that settles the look: clothes, colours, hair, height, what is carried */
  look: number;
  /** sitting on a seat SEAT_HEIGHT above y (a bench, the bench in a shelter) */
  sit?: boolean;
}

/** How high the seats are that people sit on (m): the benches of render/stopmodels.ts have this height. */
export const SEAT_HEIGHT = 0.45;

// ---- the measures of the figure, for a person 1.72 m tall (everything scales with the height)
const HEIGHT = 1.72;
/** half the distance between the hip joints */
const HIP_X = 0.088;
/** hip joint to knee, and knee to sole */
const THIGH = 0.42;
const LOWER_LEG = 0.49;
/** the heel behind the ankle, the toe ahead of it */
const HEEL_Z = 0.06;
const TOE_Z = -0.19;
/** the shoulder joints and the foot of the neck above the hip joints */
const SHOULDER_Y = 0.475;
const SHOULDER_X = 0.182;
const NECK_Y = 0.555;
const UPPER_ARM = 0.31;
/** where the hand holds things, in the frame of the arm (shoulder joint at the origin, the arm hanging down) */
const GRIP = new THREE.Vector3(0, -0.635, -0.075);
/** the radius of the wheels of a suitcase */
const CASE_WHEEL = 0.032;

// ---- the variants of each part (a bit each in the mask of a piece)
const JACKET = 0;
const HOODIE = 1;
const COAT = 2;
const DRESS = 3;
/** a coat and a dress on somebody sitting: the skirt lies over the thighs */
const COAT_SITTING = 4;
const DRESS_SITTING = 5;

const LONG_SLEEVE = 0;
const SHORT_SLEEVE = 1;

const SHOES = 0;
const BOOTS = 1;

const SHORT = 0;
const LONG = 1;
const BUN = 2;
const PONYTAIL = 3;
const CAP = 4;
const BEANIE = 5;
const HEADSCARF = 6;
const BALDING = 7;
const CURLY = 8;
const FLAT_CAP = 9;

const NOTHING = -1;
const SHOULDER_BAG = 0;
const STRAP = 1;
const BACKPACK = 2;
const BACKPACK_STRAPS = 3;
const HANDBAG = 4;
const SHOPPING_BAG = 5;
const BRIEFCASE = 6;
const SUITCASE = 7;
const STICK = 8;

// ------------------------------------------------------------------------------------ shapes
type V3 = [number, number, number];

/** Which colour a piece takes: the first colour of its part, the second one, or a colour of its own. */
const A = 0;
const B = 1;
const OWN = 2;

/**
 * Prepares a piece of a part: its colour slot, the variants it belongs to
 * (null: all of them) and its own colour – for A and B pieces a shade that
 * darkens the person's colour (a lining, a flap), for OWN pieces the colour.
 */
function piece(g: THREE.BufferGeometry, slot: number, variants: readonly number[] | null, own = 0xffffff): THREE.BufferGeometry {
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  const n = g.getAttribute('position').count;
  const c = new THREE.Color(own);
  const colour = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colour[i * 3] = c.r;
    colour[i * 3 + 1] = c.g;
    colour[i * 3 + 2] = c.b;
  }
  let mask = 0xffff;
  if (variants) {
    mask = 0;
    for (const v of variants) mask |= 1 << v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colour, 3));
  g.setAttribute('aSlot', new THREE.BufferAttribute(new Float32Array(n).fill(slot), 1));
  g.setAttribute('aMask', new THREE.BufferAttribute(new Float32Array(n).fill(mask), 1));
  return g;
}

/** An ellipsoid (or a part of one: down to `thetaLength` from the top, tipped back by `tilt`). */
function ellipsoid(r: V3, at: V3, w = 10, h = 7, thetaLength = Math.PI, tilt = 0, phiStart = 0, phiLength = Math.PI * 2, thetaStart = 0): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, w, h, phiStart, phiLength, thetaStart, thetaLength).scale(r[0], r[1], r[2]);
  if (tilt) g.rotateX(tilt);
  return g.translate(at[0], at[1], at[2]);
}

/** A limb hanging from y0: a round bar, r0 thick at the top and r1 at the bottom, `len` long. */
function limb(r0: number, r1: number, len: number, y0 = 0, sides = 8): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r0, r1, len, sides).translate(0, y0 - len / 2, 0);
}

const UP = new THREE.Vector3(0, 1, 0);

/** A round bar from a to b, r0 thick at a and r1 at b. */
function tube(a: V3, b: V3, r0: number, r1 = r0, sides = 7): THREE.BufferGeometry {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const g = new THREE.CylinderGeometry(r1, r0, d.length(), sides);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()));
  return g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
}

function cube(size: V3, at: V3, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
  if (rx) g.rotateX(rx);
  return g.translate(at[0], at[1], at[2]);
}

interface Ring {
  y: number;
  rx: number;
  rz: number;
  z?: number;
}

/** A body of elliptic rings, given from the lowest up; `inside`: the faces turned inwards (a lining). */
function loft(rings: readonly Ring[], sides: number, caps: boolean, inside = false): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const r of rings) {
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      pos.push(Math.sin(a) * r.rx, r.y, (r.z ?? 0) + Math.cos(a) * r.rz);
    }
  }
  for (let j = 0; j + 1 < rings.length; j++) {
    for (let k = 0; k < sides; k++) {
      const a = j * sides + k;
      const b = j * sides + ((k + 1) % sides);
      if (inside) idx.push(a, b + sides, b, a, a + sides, b + sides);
      else idx.push(a, b, b + sides, a, b + sides, a + sides);
    }
  }
  if (caps) {
    for (const top of [false, true]) {
      const j = top ? rings.length - 1 : 0;
      const r = rings[j];
      const centre = pos.length / 3;
      pos.push(0, r.y, r.z ?? 0);
      for (let k = 0; k < sides; k++) {
        const a = j * sides + k;
        const b = j * sides + ((k + 1) % sides);
        if (top) idx.push(centre, a, b);
        else idx.push(centre, b, a);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('people: the pieces of a part do not fit together');
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

/** The torso from the hip joints up to the neck, with a jacket, a hooded jacket, a coat and scarf, or a dress. */
function torsoShape(): THREE.BufferGeometry {
  const upper: Ring[] = [
    { y: -0.03, rx: 0.166, rz: 0.106 },
    { y: 0.07, rx: 0.158, rz: 0.1 },
    { y: 0.18, rx: 0.148, rz: 0.095 },
    { y: 0.31, rx: 0.167, rz: 0.108, z: -0.012 },
    { y: 0.425, rx: 0.177, rz: 0.102, z: -0.005 },
    { y: 0.49, rx: 0.158, rz: 0.088 },
    { y: 0.535, rx: 0.1, rz: 0.066 },
    { y: 0.56, rx: 0.052, rz: 0.048 },
  ];
  const coat: Ring[] = [
    { y: -0.41, rx: 0.205, rz: 0.2, z: -0.01 },
    { y: -0.2, rx: 0.188, rz: 0.15 },
    { y: 0.0, rx: 0.17, rz: 0.11 },
    { y: 0.08, rx: 0.162, rz: 0.103 },
  ];
  const skirt: Ring[] = [
    { y: -0.36, rx: 0.2, rz: 0.19, z: -0.01 },
    { y: -0.12, rx: 0.178, rz: 0.13 },
    { y: 0.06, rx: 0.16, rz: 0.104 },
    { y: 0.19, rx: 0.15, rz: 0.097 },
  ];
  const lining = (rings: Ring[]): Ring[] => rings.map((r) => ({ ...r, rx: r.rx - 0.006, rz: r.rz - 0.006 }));
  /** cloth over the thighs of somebody sitting: a flattened tube reaching forward, a little downhill */
  const lap = (length: number, y: number): THREE.BufferGeometry =>
    new THREE.CylinderGeometry(1, 1, length, 12).rotateX(Math.PI / 2).scale(0.185, 0.09, 1).rotateX(-0.14).translate(0, y, -length / 2 + 0.03);
  return merge([
    piece(loft(upper, 10, true), A, null),
    // the seat of the trousers below a jacket
    piece(loft([{ y: -0.125, rx: 0.128, rz: 0.086 }, { y: -0.06, rx: 0.15, rz: 0.097 }, { y: 0.0, rx: 0.155, rz: 0.099 }], 10, true), B, [JACKET, HOODIE]),
    // the hood, lying on the back
    piece(ellipsoid([0.115, 0.075, 0.06], [0, 0.5, 0.098]), A, [HOODIE]),
    // a coat down to the knees, its lining inside (seen from below), a scarf with an end hanging down the front
    piece(loft(coat, 10, false), A, [COAT]),
    piece(loft(lining(coat), 10, false, true), A, [COAT], 0x8a8a8a),
    piece(loft([{ y: 0.47, rx: 0.106, rz: 0.088 }, { y: 0.535, rx: 0.098, rz: 0.083 }, { y: 0.62, rx: 0.075, rz: 0.07 }], 10, false), B, [COAT, COAT_SITTING]),
    piece(cube([0.058, 0.22, 0.022], [0.055, 0.39, -0.116], 0.06), B, [COAT, COAT_SITTING]),
    // a dress: the skirt flares from the waist to above the knees
    piece(loft(skirt, 10, false), B, [DRESS]),
    piece(loft(lining(skirt), 10, false, true), B, [DRESS], 0x8a8a8a),
    // sitting (the thighs reach forward 0.42 m, a little downhill): the coat round the hips, over the
    // thighs and down in front of the knees; the dress round the hips and over the thighs
    piece(loft([{ y: -0.13, rx: 0.173, rz: 0.113 }, { y: 0.0, rx: 0.17, rz: 0.11 }, { y: 0.08, rx: 0.162, rz: 0.103 }], 10, true), A, [COAT_SITTING]),
    piece(lap(0.5, -0.03), A, [COAT_SITTING]),
    piece(cube([0.36, 0.3, 0.035], [0, -0.21, -0.495]), A, [COAT_SITTING]),
    piece(loft([{ y: -0.12, rx: 0.166, rz: 0.107 }, { y: 0.06, rx: 0.16, rz: 0.104 }, { y: 0.19, rx: 0.15, rz: 0.097 }], 10, true), B, [DRESS_SITTING]),
    piece(lap(0.38, -0.025), B, [DRESS_SITTING]),
  ]);
}

/** An arm from the shoulder joint, hanging down, a little bent at the elbow: in a long or a short sleeve. */
function armShape(): THREE.BufferGeometry {
  const elbow: V3 = [0, -UPPER_ARM, 0];
  const wrist: V3 = [0, -0.555, -0.055];
  return merge([
    piece(ellipsoid([0.05, 0.052, 0.054], [0, -0.03, 0], 8, 6), A, null),
    piece(limb(0.052, 0.045, UPPER_ARM), A, [LONG_SLEEVE]),
    piece(ellipsoid([0.045, 0.045, 0.045], elbow, 8, 6), A, [LONG_SLEEVE]),
    piece(tube(elbow, wrist, 0.044, 0.038), A, [LONG_SLEEVE]),
    piece(limb(0.057, 0.055, 0.15), A, [SHORT_SLEEVE]),
    piece(limb(0.041, 0.037, UPPER_ARM - 0.12, -0.12), B, [SHORT_SLEEVE]),
    piece(ellipsoid([0.038, 0.038, 0.038], elbow, 8, 6), B, [SHORT_SLEEVE]),
    piece(tube(elbow, wrist, 0.036, 0.029), B, [SHORT_SLEEVE]),
    // the hand, along the forearm
    piece(ellipsoid([0.026, 0.07, 0.044], [0, -0.618, -0.07], 8, 6, Math.PI, 0.22), B, null),
  ]);
}

function thighShape(): THREE.BufferGeometry {
  return merge([piece(ellipsoid([0.08, 0.08, 0.08], [0, 0, 0], 8, 6), A, null), piece(limb(0.08, 0.06, THIGH + 0.02, 0, 9), A, null)]);
}

/** The lower leg from the knee down, with a shoe (or a boot). */
function shinShape(): THREE.BufferGeometry {
  const sole = -LOWER_LEG;
  return merge([
    piece(ellipsoid([0.061, 0.061, 0.063], [0, 0, 0], 8, 6), A, null),
    piece(limb(0.058, 0.042, LOWER_LEG - 0.04), A, null),
    piece(limb(0.062, 0.052, 0.27, -0.19), B, [BOOTS]),
    piece(cube([0.086, 0.064, 0.25], [0, sole + 0.032, (HEEL_Z + TOE_Z) / 2]), B, null),
    piece(ellipsoid([0.042, 0.036, 0.07], [0, sole + 0.044, -0.12], 8, 5), B, null),
  ]);
}

/** The head on its neck (from the foot of the neck), with the hair styles and hats. */
function headShape(): THREE.BufferGeometry {
  const skull: V3 = [0, 0.142, 0];
  const pieces = [
    piece(limb(0.046, 0.05, 0.1, 0.075), A, null),
    piece(ellipsoid([0.079, 0.114, 0.096], skull, 12, 9), A, null),
    piece(cube([0.022, 0.034, 0.03], [0, 0.128, -0.094]), A, null),
  ];
  for (const side of [-1, 1]) {
    pieces.push(piece(ellipsoid([0.012, 0.027, 0.019], [side * 0.078, 0.138, 0.008], 6, 4), A, null));
    pieces.push(piece(cube([0.017, 0.01, 0.012], [side * 0.03, 0.157, -0.085]), OWN, null, 0x2b2420));
    // long hair falls past the face on both sides
    pieces.push(piece(ellipsoid([0.022, 0.085, 0.05], [side * 0.07, 0.1, 0.015], 6, 5), B, [LONG]));
  }
  pieces.push(
    // short hair, also under the long hair, the bun and the ponytail: cut on a slant, so that it ends
    // 2 cm above the eyes at the front, over the ears at the sides and at the nape behind
    piece(ellipsoid([0.085, 0.121, 0.102], [0, 0.15, 0.01], 12, 7, Math.PI * 0.567, 0.52), B, [SHORT, LONG, BUN, PONYTAIL]),
    piece(ellipsoid([0.083, 0.15, 0.048], [0, 0.065, 0.066], 10, 7), B, [LONG]),
    piece(ellipsoid([0.048, 0.045, 0.048], [0, 0.215, 0.085], 8, 6), B, [BUN]),
    piece(ellipsoid([0.032, 0.09, 0.032], [0, 0.1, 0.12], 7, 5, Math.PI, 0.25), B, [PONYTAIL]),
    // a cap with a peak
    piece(ellipsoid([0.089, 0.092, 0.104], [0, 0.168, 0.004], 12, 5, Math.PI * 0.5), B, [CAP]),
    piece(cube([0.15, 0.012, 0.09], [0, 0.172, -0.13], 0.12), B, [CAP]),
    // a woolly hat, pulled down at the back
    piece(ellipsoid([0.09, 0.135, 0.105], [0, 0.148, 0.006], 12, 6, Math.PI * 0.5, 0.3), B, [BEANIE]),
    // a headscarf: over the crown, round the face, down over the neck
    piece(ellipsoid([0.091, 0.127, 0.107], [0, 0.142, 0.006], 14, 4, Math.PI * 0.32), B, [HEADSCARF]),
    piece(ellipsoid([0.091, 0.127, 0.107], [0, 0.142, 0.006], 14, 9, Math.PI * 0.8, 0, Math.PI * 1.5 + 0.75, Math.PI * 2 - 1.5), B, [HEADSCARF]),
    piece(loft([{ y: -0.05, rx: 0.15, rz: 0.125 }, { y: 0.0, rx: 0.1, rz: 0.092 }, { y: 0.06, rx: 0.083, rz: 0.085 }], 12, false), B, [HEADSCARF]),
    // the horseshoe of hair round the back of a balding head, from the temples down to the nape
    piece(ellipsoid([0.087, 0.119, 0.101], skull, 12, 4, Math.PI * 0.3, 0, Math.PI / 2 - 1.75, 3.5, Math.PI * 0.36), B, [BALDING]),
    // curls
    piece(ellipsoid([0.112, 0.11, 0.118], [0, 0.17, 0.016], 12, 7, Math.PI * 0.6, 0.45), B, [CURLY]),
    // a flat cap
    piece(ellipsoid([0.095, 0.092, 0.115], [0, 0.168, -0.008], 12, 4, Math.PI * 0.5), B, [FLAT_CAP]),
    piece(cube([0.16, 0.012, 0.06], [0, 0.172, -0.118]), B, [FLAT_CAP]),
  );
  return merge(pieces);
}

/** What people carry, each in its own frame (see PeopleRenderer for where each one is held). */
function itemShape(): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [
    // a bag over the shoulder, hanging from its top at the hip
    piece(cube([0.07, 0.24, 0.3], [0, -0.12, 0]), A, [SHOULDER_BAG]),
    piece(cube([0.076, 0.1, 0.306], [0, -0.05, 0]), A, [SHOULDER_BAG], 0xb4b4b4),
    // a backpack, hanging from its top
    piece(cube([0.3, 0.37, 0.14], [0, -0.2, 0]), A, [BACKPACK]),
    piece(ellipsoid([0.15, 0.045, 0.07], [0, -0.015, 0], 10, 4, Math.PI * 0.5), A, [BACKPACK]),
    piece(cube([0.22, 0.15, 0.04], [0, -0.29, 0.085]), A, [BACKPACK], 0xb4b4b4),
    // held in the hand (the origin is the grip): a handbag, a shopping bag, a briefcase
    piece(cube([0.1, 0.2, 0.27], [0, -0.15, 0]), A, [HANDBAG]),
    piece(tube([0, -0.05, -0.07], [0, 0.005, 0], 0.008, 0.008, 4), B, [HANDBAG]),
    piece(tube([0, 0.005, 0], [0, -0.05, 0.07], 0.008, 0.008, 4), B, [HANDBAG]),
    piece(cube([0.12, 0.34, 0.3], [0, -0.22, 0]), A, [SHOPPING_BAG]),
    piece(cube([0.124, 0.035, 0.304], [0, -0.068, 0]), A, [SHOPPING_BAG], 0xc8c8c8),
    piece(tube([0, -0.05, -0.08], [0, 0.005, 0], 0.007, 0.007, 4), B, [SHOPPING_BAG]),
    piece(tube([0, 0.005, 0], [0, -0.05, 0.08], 0.007, 0.007, 4), B, [SHOPPING_BAG]),
    piece(cube([0.085, 0.28, 0.4], [0, -0.18, 0]), A, [BRIEFCASE]),
    piece(cube([0.03, 0.035, 0.11], [0, -0.025, 0]), B, [BRIEFCASE]),
    // a suitcase on wheels, around the axle of its wheels, the handle pulled out
    piece(cube([0.37, 0.52, 0.22], [0, 0.29, -0.09]), A, [SUITCASE]),
    piece(cube([0.376, 0.04, 0.226], [0, 0.29, -0.09]), A, [SUITCASE], 0xa0a0a0),
    piece(cube([0.24, 0.025, 0.03], [0, 0.905, 0.01]), OWN, [SUITCASE], 0x222326),
    // a walking stick, held at its crook, 0.8 m down to the rubber tip
    piece(tube([0, -0.8, 0], [0, 0, 0], 0.011, 0.012, 6), A, [STICK]),
    piece(tube([0, 0, 0], [0, 0.015, -0.1], 0.012, 0.012, 5), A, [STICK]),
    piece(limb(0.014, 0.014, 0.04, -0.76), OWN, [STICK], 0x1a1a1a),
  ];
  for (const side of [-1, 1]) {
    pieces.push(
      // the strap of the shoulder bag runs from the left shoulder across chest and back to the right hip (frame of the torso)
      piece(tube([-0.11, 0.53, side * 0.02], [-0.02, 0.365, side * 0.12], 0.012, 0.012, 4), B, [STRAP]),
      piece(tube([-0.02, 0.365, side * 0.12], [0.19, 0.14, side * 0.09], 0.012, 0.012, 4), B, [STRAP]),
      // the straps of the backpack over the shoulders (frame of the torso)
      piece(tube([side * 0.09, 0.535, 0.03], [side * 0.1, 0.43, -0.112], 0.014, 0.014, 4), B, [BACKPACK_STRAPS]),
      piece(tube([side * 0.1, 0.43, -0.112], [side * 0.12, 0.22, -0.1], 0.014, 0.014, 4), B, [BACKPACK_STRAPS]),
      // the wheels and the pulled-out rods of the suitcase
      piece(new THREE.CylinderGeometry(CASE_WHEEL, CASE_WHEEL, 0.03, 8).rotateZ(Math.PI / 2).translate(side * 0.14, 0, 0), OWN, [SUITCASE], 0x1c1c1e),
      piece(tube([side * 0.1, 0.55, 0.01], [side * 0.1, 0.9, 0.01], 0.008, 0.008, 5), OWN, [SUITCASE], 0x8c9094),
    );
  }
  return merge(pieces);
}

interface Shapes {
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  torso: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  item: THREE.BufferGeometry;
}
let shapes: Shapes | null = null;

// ------------------------------------------------------------------------------------ material
// Per vertex: aSlot (the colour slot) and aMask (the variants the piece belongs to); per instance:
// aColA, aColB (the two colours of the part for this person) and aVar (the variant the person wears).
const FOLD_DECL = 'attribute float aVar;\nattribute float aMask;';
/** Pieces of the variants the person does not wear shrink to a point: no pixels, no shadow. */
const FOLD = 'if (((int(aMask + 0.5) >> int(aVar + 0.5)) & 1) == 0) transformed = vec3(0.0);';

const BODY = new THREE.MeshLambertMaterial({ vertexColors: true });
BODY.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${FOLD_DECL}\nattribute vec3 aColA;\nattribute vec3 aColB;\nattribute float aSlot;`)
    .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb = color * (aSlot < 0.5 ? aColA : (aSlot < 1.5 ? aColB : vec3(1.0)));')
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FOLD}`);
};
BODY.customProgramCacheKey = () => 'fs-people';

/** The shadow pass folds the same pieces away. */
const BODY_DEPTH = new THREE.MeshDepthMaterial();
BODY_DEPTH.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${FOLD_DECL}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FOLD}`);
};
BODY_DEPTH.customProgramCacheKey = () => 'fs-people-depth';

// ------------------------------------------------------------------------------------ looks
const MUTED = [0x2b3a55, 0x3a3d42, 0x55603f, 0x5e4433, 0x7d6a55, 0x6b2f37, 0x6f747a, 0x222326, 0x2f4a3c, 0x4a5a6e];
const BRIGHT = [0xc0392b, 0xe0a91f, 0xd96a24, 0x1f8a83, 0x2f62c4, 0xc95683, 0x7fae3a, 0x6b4aa0, 0xe6e4dc, 0x38a0d8];
const COATS = [0xa8835a, 0x2e3440, 0x6b6f75, 0x2b3a55, 0x7a3b3b, 0xb9ad98, 0x3f4b3a, 0x222326];
const SCARVES = [0x8a2e2e, 0x6f747a, 0x2f4a6e, 0xc9b38a, 0x3d5a40, 0xd9d4c6, 0xb5652e, 0x5b3a6e];
const JEANS = [0x34496b, 0x2c3b57, 0x485f82, 0x23262b];
const TROUSERS = [0x26282c, 0x3d4045, 0x5a5d62, 0x8c7f68, 0x473a2e, 0x2b3240];
const TIGHTS = [0x1e1e22, 0x2b2b30, 0x4a3a33, 0xb08a74];
const SKIN = [0xf0c8a8, 0xe3b08e, 0xd29c78, 0xb27a56, 0x8c5a3c, 0x5e3d2a];
const HAIR = [0x1c1917, 0x33251b, 0x55392a, 0x7a5532, 0xb08a52, 0xd4b77a, 0x8a3f22, 0x1c1917, 0x33251b];
const GREY_HAIR = [0x9c9c9a, 0xbdbdb8, 0xdedcd6];
const SHOE_COLOURS = [0x19191b, 0x3f2c20, 0x5a5c60, 0x19191b];
const TRAINERS = [0xe6e6e2, 0xd2d2ce, 0x2a2c30, 0x9a3a32, 0xe6e6e2];
const BAGS = [0x2a2a2c, 0x5e3d28, 0x8a6a48, 0x3a4a5e, 0x7a2e30, 0x5a5f55, 0x1f1f21];

/** A kind of person: the choices for each part (one is picked per person). */
interface Kind {
  torso: readonly number[];
  sleeve?: number;
  hair: readonly number[];
  top: readonly number[];
  legs: readonly number[];
  /** the colour of the hair, or of the hat or scarf on it (default: natural hair colours) */
  hairs?: readonly number[];
  shoes: readonly number[];
  /** the second colour of the torso: the scarf to a coat, the skirt of a dress (default: the legs) */
  second?: readonly number[];
  /** the share of them in boots */
  boots?: number;
  items: readonly number[];
  bags?: readonly number[];
  height: readonly [number, number];
  build?: 'child' | 'old' | 'woman';
}

const KINDS: readonly Kind[] = [
  // a man in a short jacket and jeans, a bag over his shoulder
  { torso: [JACKET], hair: [SHORT, SHORT, BALDING], top: MUTED, legs: JEANS, shoes: SHOE_COLOURS, items: [SHOULDER_BAG, NOTHING], height: [1.72, 1.9] },
  // a woman in a long coat, with long hair and a handbag
  { torso: [COAT], hair: [LONG, LONG, BUN], top: COATS, second: SCARVES, legs: [...JEANS, ...TIGHTS], shoes: SHOE_COLOURS, boots: 0.5, items: [HANDBAG, SHOULDER_BAG], height: [1.6, 1.76], build: 'woman' },
  // a student in a hooded jacket with a backpack and white trainers
  { torso: [HOODIE], hair: [SHORT, BEANIE, SHORT, CURLY], top: [...BRIGHT, 0x6f747a, 0x3a3d42], hairs: [...HAIR, 0x2b3a55, 0x6f747a], legs: JEANS, shoes: TRAINERS, items: [BACKPACK], height: [1.65, 1.88] },
  // an older woman in a coat, her grey hair in a bun, with a walking stick
  { torso: [COAT], hair: [BUN, SHORT], hairs: GREY_HAIR, top: [0x6e5a4a, 0x4a5568, 0x7a6e60, 0x5b4a5e, 0x8a7a68], second: SCARVES, legs: [0x3d4045, 0x4a3a33, 0x5a5d62], shoes: SHOE_COLOURS, items: [STICK], height: [1.55, 1.66], build: 'old' },
  // an older man in a jacket and a flat cap, with a shopping bag or a stick
  { torso: [JACKET], hair: [FLAT_CAP], hairs: [0x4a4440, 0x5d564c, 0x3a3c40, 0x6b5a48], top: [0x5e5546, 0x4a5240, 0x3d4652, 0x6b6258], legs: [0x5a5d62, 0x8c7f68, 0x473a2e], shoes: SHOE_COLOURS, items: [SHOPPING_BAG, STICK, NOTHING], height: [1.66, 1.8], build: 'old' },
  // a woman in a dress, tights and boots, with a handbag
  { torso: [DRESS], hair: [SHORT, PONYTAIL, LONG], top: [...BRIGHT, ...MUTED], second: [...MUTED, 0x6b2f37, 0x2b3a55], legs: TIGHTS, shoes: SHOE_COLOURS, boots: 0.6, items: [HANDBAG, SHOULDER_BAG, NOTHING], height: [1.58, 1.74], build: 'woman' },
  // a schoolchild in a bright jacket with a school bag
  { torso: [JACKET], hair: [SHORT, PONYTAIL, SHORT, BEANIE], top: BRIGHT, legs: JEANS, shoes: TRAINERS, items: [BACKPACK], bags: BRIGHT, height: [1.25, 1.5], build: 'child' },
  // a teenager with a cap
  { torso: [HOODIE, JACKET], hair: [CAP], hairs: [...BRIGHT, 0x222326], top: BRIGHT, legs: [...JEANS, 0x26282c], shoes: TRAINERS, items: [BACKPACK, NOTHING], height: [1.6, 1.82] },
  // a commuter in a dark coat with a scarf and a briefcase (or a suitcase)
  { torso: [COAT], hair: [SHORT, BALDING], top: [0x2e3440, 0x222326, 0x3a3d42, 0x2b3a55, 0x6b6f75], second: SCARVES, legs: TROUSERS, shoes: SHOE_COLOURS, items: [BRIEFCASE, BRIEFCASE, SUITCASE], height: [1.72, 1.92] },
  // a woman with a headscarf and a long coat
  { torso: [COAT], hair: [HEADSCARF], hairs: [0x2b3a55, 0x6b2f37, 0xc9b38a, 0x3f4b3a, 0x7a6a8a, 0x1f1f22, 0xb5652e], top: [0x2e3440, 0x5e4433, 0x6b6f75, 0x3f4b3a, 0x222326, 0x8a7a68], legs: [...TROUSERS, ...TIGHTS], shoes: SHOE_COLOURS, items: [SHOPPING_BAG, HANDBAG], height: [1.58, 1.72], build: 'woman' },
  // a man in a bright rain jacket with a backpack
  { torso: [JACKET], hair: [CAP, SHORT, BEANIE], hairs: [0x222326, 0x2b3a55, 0x6f747a, 0x55392a], top: [0xe0a91f, 0xd96a24, 0x7fae3a, 0xc0392b, 0x2f62c4, 0x1f8a83], legs: [...JEANS, ...TROUSERS], shoes: [...SHOE_COLOURS, ...TRAINERS], items: [BACKPACK], height: [1.7, 1.9] },
  // a small child in a bright jacket and a woolly hat
  { torso: [JACKET], hair: [BEANIE, SHORT], hairs: BRIGHT, top: BRIGHT, legs: [...JEANS, 0xc95683, 0x2f62c4], shoes: TRAINERS, items: [NOTHING, NOTHING, BACKPACK], bags: BRIGHT, height: [1.05, 1.25], build: 'child' },
  // a woman in a sports jacket and leggings, with a ponytail
  { torso: [JACKET], hair: [PONYTAIL], top: [...BRIGHT, 0x3a3d42], legs: [0x1e1e22, 0x2b2b30, 0x3a3d48], shoes: TRAINERS, items: [BACKPACK, SHOULDER_BAG], height: [1.6, 1.75], build: 'woman' },
  // a man in a T-shirt and jeans
  { torso: [JACKET], sleeve: SHORT_SLEEVE, hair: [SHORT, BALDING, CURLY], top: [0xe6e4dc, 0x2f62c4, 0x222326, 0x7a8a9a, 0xc0392b, 0x55603f], legs: JEANS, shoes: [...TRAINERS, ...SHOE_COLOURS], items: [NOTHING, SHOULDER_BAG], height: [1.72, 1.9] },
  // a businesswoman in a long coat, her hair in a bun, with a briefcase
  { torso: [COAT], hair: [BUN, SHORT], top: [0xb9ad98, 0x2e3440, 0x6b6f75, 0xa8835a], second: [0xe6e4dc, 0x8a2e2e, 0x2f4a6e], legs: TIGHTS, shoes: SHOE_COLOURS, items: [BRIEFCASE, HANDBAG], height: [1.62, 1.76], build: 'woman' },
  // somebody with curly hair in a bright jacket, a shopping bag in hand
  { torso: [JACKET], hair: [CURLY], top: BRIGHT, legs: [...JEANS, ...TROUSERS], shoes: TRAINERS, items: [SHOPPING_BAG, NOTHING], height: [1.62, 1.85] },
  // a traveller pulling a suitcase
  { torso: [JACKET, HOODIE], hair: [SHORT, LONG, CAP], top: [...MUTED, ...BRIGHT], hairs: [...HAIR, 0x222326], legs: JEANS, shoes: [...TRAINERS, ...SHOE_COLOURS], items: [SUITCASE], height: [1.62, 1.88] },
];

/** A person's look, worked out once from the look number. */
export interface Look {
  id: number;
  /** height / 1.72, and the head a little bigger on children */
  scale: number;
  head: number;
  wide: number;
  deep: number;
  torso: number;
  sleeve: number;
  hair: number;
  shoe: number;
  top: THREE.Color;
  second: THREE.Color;
  skin: THREE.Color;
  hairColour: THREE.Color;
  legs: THREE.Color;
  shoes: THREE.Color;
  bag: THREE.Color;
  bag2: THREE.Color;
  item: number;
  /** metres per double step (in the figure's own measure), arm swing and hip swing (rad), forward stoop */
  stride: number;
  swing: number;
  hipSwing: number;
  stoop: number;
  /** 0 … 1: when the idle movements happen */
  seed: number;
  /** how far the head is bowed while waiting (somebody reading) */
  bow: number;
}

export function lookOf(id: number): Look {
  const r = (k: number): number => hash01(Math.imul(id | 0, 0x2c1b3c6d) ^ Math.imul(k + 1, 0x297a2d39));
  const pick = <T>(list: readonly T[], k: number): T => list[Math.min(list.length - 1, Math.floor(r(k) * list.length))];
  const kind = pick(KINDS, 0);
  const torso = pick(kind.torso, 1);
  const hair = pick(kind.hair, 2);
  const height = kind.height[0] + (kind.height[1] - kind.height[0]) * r(3);
  const scale = height / HEIGHT;
  const child = kind.build === 'child';
  const old = kind.build === 'old';
  const woman = kind.build === 'woman';
  const legs = new THREE.Color(pick(kind.legs, 4));
  const item = pick(kind.items, 5);
  const stride = (old ? 1.02 : child ? 1.36 : 1.42) * (0.95 + 0.1 * r(6));
  const wrapped = torso === COAT || torso === DRESS;
  const backpackish = item === BACKPACK || item === SHOULDER_BAG;
  const bag = new THREE.Color(pick(kind.bags ?? (backpackish ? [...BAGS, ...BRIGHT.slice(0, 6)] : BAGS), 7));
  return {
    id,
    scale,
    head: 1.06 + (child ? 0.6 * Math.max(0, 1 - scale) : 0),
    wide: (woman ? 0.93 : 1) * (0.95 + 0.1 * r(8)),
    deep: 0.94 + 0.14 * r(9),
    torso,
    sleeve: kind.sleeve ?? LONG_SLEEVE,
    hair,
    shoe: r(10) < (kind.boots ?? 0) ? BOOTS : SHOES,
    top: new THREE.Color(pick(kind.top, 11)),
    second: torso === JACKET || torso === HOODIE ? legs.clone() : new THREE.Color(pick(kind.second ?? kind.top, 12)),
    skin: new THREE.Color(pick(SKIN, 13)),
    hairColour: new THREE.Color(pick(kind.hairs ?? (old ? GREY_HAIR : HAIR), 14)),
    legs,
    shoes: new THREE.Color(pick(kind.shoes, 15)),
    bag,
    bag2: item === BACKPACK || item === SHOULDER_BAG ? new THREE.Color(0x1e1f21) : bag.clone().multiplyScalar(0.55),
    item,
    stride,
    swing: (old ? 0.13 : child ? 0.36 : 0.29) * (0.85 + 0.3 * r(16)),
    hipSwing: Math.asin(Math.min(0.9, stride / (4 * 0.91))) * (wrapped ? 0.82 : 0.95),
    stoop: old ? 0.1 + 0.06 * r(17) : 0.02 * r(17),
    seed: r(18),
    bow: !child && !old && r(19) < 0.25 ? 0.38 : 0,
  };
}

/** How far a knee is bent at a point of the walking cycle (0: the leg straight up, π/2: it strikes the ground ahead). */
function kneeBend(phase: number): number {
  const w = phase - Math.floor(phase / (Math.PI * 2)) * Math.PI * 2;
  const swing = Math.max(0, Math.cos(w + 0.5));
  let k = 0.06 + swing * Math.sqrt(swing);
  // a little give as the weight comes on to the leg
  if (w > Math.PI / 2 && w < Math.PI) k += 0.16 * Math.sin((w - Math.PI / 2) * 2);
  return k;
}

/** The lowest point of a foot below the hip joint, for the angle at the hip (forwards) and the bend of the knee. */
function lowestFoot(hip: number, knee: number): number {
  const a = hip - knee;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  return -THIGH * Math.cos(hip) + Math.min(-LOWER_LEG * ca - HEEL_Z * sa, -LOWER_LEG * ca - TOE_Z * sa);
}

// ------------------------------------------------------------------------------------ renderer
/** One part of the body for all the people: an instanced mesh with two colours and a variant per instance. */
class Part {
  readonly mesh: THREE.InstancedMesh;
  private readonly colA: THREE.InstancedBufferAttribute;
  private readonly colB: THREE.InstancedBufferAttribute;
  private readonly variant: THREE.InstancedBufferAttribute;
  private painted = false;

  constructor(shape: THREE.BufferGeometry, count: number, name: string) {
    // (the shape's attributes are shared between renderers; the per-person ones are this renderer's own)
    const g = new THREE.BufferGeometry();
    for (const [key, attribute] of Object.entries(shape.attributes)) g.setAttribute(key, attribute);
    g.setIndex(shape.index);
    g.boundingSphere = shape.boundingSphere;
    this.colA = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colB = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.variant = new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aColA', this.colA);
    g.setAttribute('aColB', this.colB);
    g.setAttribute('aVar', this.variant);
    this.mesh = new THREE.InstancedMesh(g, BODY, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.customDepthMaterial = BODY_DEPTH;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.name = name;
  }

  paint(i: number, a: THREE.Color, b: THREE.Color, variant: number): void {
    this.colA.setXYZ(i, a.r, a.g, a.b);
    this.colB.setXYZ(i, b.r, b.g, b.b);
    this.variant.setX(i, variant);
    this.painted = true;
  }

  /** After the frame's matrices: how many instances are shown, and the sphere around all of them. */
  show(count: number, bounds: THREE.Sphere): void {
    const m = this.mesh;
    m.count = count;
    m.visible = count > 0;
    m.boundingSphere = bounds;
    if (count > 0) m.instanceMatrix.needsUpdate = true;
    if (this.painted) {
      this.colA.needsUpdate = true;
      this.colB.needsUpdate = true;
      this.variant.needsUpdate = true;
      this.painted = false;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _local = new THREE.Matrix4();
const _v = new THREE.Vector3();
const IDENTITY = new THREE.Matrix4();

/**
 * out = parent · translate(x, y, z) · rotate (yaw ry, then pitch rx, then roll rz) · scale.
 * (A positive pitch tips the top backwards and swings a hanging limb forwards.)
 */
function joint(out: THREE.Matrix4, parent: THREE.Matrix4, x: number, y: number, z: number, rx: number, ry: number, rz: number, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _local.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(sx, sy, sz));
  return out.multiplyMatrices(parent, _local);
}

/**
 * Draws the people at the stops: many low-polygon figures, each part of the
 * body one instanced mesh for all of them.  Call `update` every frame with
 * the people to show; add `group` to the scene as it is (the instances are
 * placed in its frame).
 */
export class PeopleRenderer {
  readonly group = new THREE.Group();
  private readonly capacity: number;
  private readonly thigh: Part;
  private readonly shin: Part;
  private readonly torso: Part;
  private readonly arm: Part;
  private readonly head: Part;
  private readonly item: Part;
  /** the look of the person in each slot, and of the item in each item slot */
  private readonly slots: Array<Look | null>;
  /** the variant of the torso shown in each slot (it changes when somebody sits down) */
  private readonly torsoShown: Int8Array;
  private readonly itemLooks: Array<Look | null>;
  private readonly itemKinds: Int16Array;
  private readonly cache = new Map<number, Look>();
  private readonly bounds = new THREE.Sphere();
  private readonly lo = new THREE.Vector3();
  private readonly hi = new THREE.Vector3();
  // the frames of one person, in the person's own measure (the instance matrices are world · these)
  private readonly world = new THREE.Matrix4();
  private readonly base = new THREE.Matrix4();
  private readonly body = new THREE.Matrix4();
  private readonly armR = new THREE.Matrix4();
  private readonly armL = new THREE.Matrix4();
  private readonly thighR = new THREE.Matrix4();
  private readonly thighL = new THREE.Matrix4();
  private readonly m = new THREE.Matrix4();
  private readonly out = new THREE.Matrix4();

  constructor(capacity = 256) {
    this.capacity = Math.max(1, Math.floor(capacity));
    const n = this.capacity;
    const s = (shapes ??= { thigh: thighShape(), shin: shinShape(), torso: torsoShape(), arm: armShape(), head: headShape(), item: itemShape() });
    this.thigh = new Part(s.thigh, n * 2, 'people: thighs');
    this.shin = new Part(s.shin, n * 2, 'people: legs');
    this.torso = new Part(s.torso, n, 'people: torsos');
    this.arm = new Part(s.arm, n * 2, 'people: arms');
    this.head = new Part(s.head, n, 'people: heads');
    // (a bag and its strap are two items)
    this.item = new Part(s.item, n * 2, 'people: things they carry');
    this.slots = new Array<Look | null>(n).fill(null);
    this.torsoShown = new Int8Array(n).fill(-1);
    this.itemLooks = new Array<Look | null>(n * 2).fill(null);
    this.itemKinds = new Int16Array(n * 2).fill(-1);
    this.group.name = 'people';
    this.group.add(this.thigh.mesh, this.shin.mesh, this.torso.mesh, this.arm.mesh, this.head.mesh, this.item.mesh);
  }

  /** Shows exactly these people (those beyond the capacity are left out). `time`: seconds, for the small movements of those waiting. */
  update(people: readonly PersonPose[], time: number): void {
    const n = Math.min(people.length, this.capacity);
    let items = 0;
    this.lo.set(Infinity, Infinity, Infinity);
    this.hi.set(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < n; i++) {
      const p = people[i];
      let look = this.slots[i];
      const fresh = !look || look.id !== p.look;
      if (!look || fresh) {
        look = this.lookFor(p.look);
        this.slots[i] = look;
        this.thigh.paint(i * 2, look.legs, look.legs, 0);
        this.thigh.paint(i * 2 + 1, look.legs, look.legs, 0);
        this.shin.paint(i * 2, look.legs, look.shoes, look.shoe);
        this.shin.paint(i * 2 + 1, look.legs, look.shoes, look.shoe);
        this.arm.paint(i * 2, look.top, look.skin, look.sleeve);
        this.arm.paint(i * 2 + 1, look.top, look.skin, look.sleeve);
        this.head.paint(i, look.skin, look.hairColour, look.hair);
      }
      // (a coat or a dress lies differently on somebody sitting)
      const torso = p.sit ? (look.torso === COAT ? COAT_SITTING : look.torso === DRESS ? DRESS_SITTING : look.torso) : look.torso;
      if (fresh || this.torsoShown[i] !== torso) {
        this.torso.paint(i, look.top, look.second, torso);
        this.torsoShown[i] = torso;
      }
      items = this.pose(i, p, look, time, items);
      this.lo.min(_v.set(p.x, p.y, p.z));
      this.hi.max(_v);
    }
    if (n > 0) {
      this.bounds.center.addVectors(this.lo, this.hi).multiplyScalar(0.5);
      this.bounds.radius = this.lo.distanceTo(this.hi) / 2 + 2.5;
    } else {
      this.bounds.center.set(0, 0, 0);
      this.bounds.radius = 0;
    }
    this.thigh.show(n * 2, this.bounds);
    this.shin.show(n * 2, this.bounds);
    this.torso.show(n, this.bounds);
    this.arm.show(n * 2, this.bounds);
    this.head.show(n, this.bounds);
    this.item.show(items, this.bounds);
  }

  dispose(): void {
    for (const part of [this.thigh, this.shin, this.torso, this.arm, this.head, this.item]) part.dispose();
    this.group.clear();
  }

  private lookFor(id: number): Look {
    let look = this.cache.get(id);
    if (!look) {
      if (this.cache.size > 4096) this.cache.clear();
      look = lookOf(id);
      this.cache.set(id, look);
    }
    return look;
  }

  /** Writes the instance matrices of person i (and of what they carry, from item slot k on); returns the next item slot. */
  private pose(i: number, p: PersonPose, L: Look, time: number, k: number): number {
    const s = L.scale;
    const t = time + L.seed * 97;
    let hipR = 0;
    let kneeR = 0;
    let hipL = 0;
    let kneeL = 0;
    let splay = 0.03;
    let armR = 0.04;
    let armL = 0.04;
    let outR = 0.07;
    let outL = 0.07;
    let lean = L.stoop;
    let roll = 0;
    let twist = 0;
    let shift = 0;
    // waiting people look about now and then, some read
    let headYaw = 0.55 * Math.sin(t * 0.19) * Math.sin(t * 0.053 + L.seed * 3);
    let headBow = L.bow + 0.05 * Math.sin(t * 0.27);
    let hip: number;
    const sitting = p.sit === true;
    const walking = !sitting && p.walk >= 0;
    const inHand = L.item === HANDBAG || L.item === SHOPPING_BAG || L.item === BRIEFCASE;
    if (sitting) {
      // the hips on the seat, the thighs along it, the feet on the ground (children's dangle)
      hip = SEAT_HEIGHT / s + 0.095;
      const lift = 1.42;
      const reach = (hip - THIGH * Math.cos(lift)) / LOWER_LEG;
      const forward = reach >= 1 ? 0 : Math.acos(reach);
      hipR = lift;
      hipL = lift;
      kneeR = lift - forward - 0.12 * L.seed;
      kneeL = lift - forward;
      splay = 0.09;
      armR = 0.62;
      armL = 0.62;
      outR = -0.1;
      outL = -0.1;
      lean = -0.04 + L.stoop * 0.5;
    } else if (walking) {
      // the gait follows the distance walked: a double step per stride
      const phase = (p.walk / s / L.stride) * Math.PI * 2 + L.seed * 6.283;
      const sn = Math.sin(phase);
      const cs = Math.cos(phase);
      hipR = 0.02 + L.hipSwing * sn;
      hipL = 0.02 - L.hipSwing * sn;
      kneeR = kneeBend(phase);
      kneeL = kneeBend(phase + Math.PI);
      armR = 0.05 - L.swing * sn;
      armL = 0.05 + L.swing * sn * (inHand ? 0.5 : 1);
      if (L.item === SUITCASE) {
        // the right hand pulls the suitcase behind
        armR = -0.5;
        outR = 0.14;
      }
      lean = 0.045 + L.stoop;
      twist = -0.05 * sn;
      roll = 0.02 * cs;
      shift = -0.018 * cs;
      headYaw = -twist * 0.8;
      headBow = 0.04;
      hip = -Math.min(lowestFoot(hipR, kneeR), lowestFoot(hipL, kneeL));
    } else {
      // standing: the weight now on one leg, now on the other (the free knee a little bent, its foot a
      // little forward), the arms hanging loosely; the leg that carries is straight
      const weight = Math.sin(t * 0.31) * 0.75 + Math.sin(t * 0.083 + 1.3) * 0.25;
      const easeL = Math.max(0, weight);
      const easeR = Math.max(0, -weight);
      hipL = 0.12 * easeL;
      kneeL = 0.15 * easeL;
      hipR = 0.12 * easeR;
      kneeR = 0.15 * easeR;
      shift = 0.03 * weight;
      roll = -0.025 * weight;
      armR = 0.03 + 0.025 * Math.sin(t * 0.7);
      armL = 0.03 + 0.025 * Math.sin(t * 0.7 + 2);
      hip = THIGH + LOWER_LEG;
    }

    // ---- the frames, in the person's own measure: the world matrix scales them to the height
    this.world.compose(_p.set(p.x, p.y, p.z), _q.setFromAxisAngle(UP, p.yaw), _s.set(s, s, s));
    joint(this.base, IDENTITY, 0, hip, 0, 0, 0, 0);
    joint(this.body, this.base, shift, 0, 0, -lean, twist, roll);
    joint(this.armR, this.body, SHOULDER_X * L.wide, SHOULDER_Y, 0, armR, 0, outR);
    joint(this.armL, this.body, -SHOULDER_X * L.wide, SHOULDER_Y, 0, armL, 0, -outL);
    joint(this.thighR, this.base, HIP_X, 0, 0, hipR, 0, splay);
    joint(this.thighL, this.base, -HIP_X, 0, 0, hipL, 0, -splay);
    this.put(this.torso, i, joint(this.m, this.body, 0, 0, 0, 0, 0, 0, L.wide, 1, L.deep));
    this.put(this.head, i, joint(this.m, this.body, 0, NECK_Y, 0, lean * 0.8 - headBow, headYaw, 0, L.head));
    this.put(this.arm, i * 2, this.armR);
    this.put(this.arm, i * 2 + 1, this.armL);
    this.put(this.thigh, i * 2, this.thighR);
    this.put(this.thigh, i * 2 + 1, this.thighL);
    this.put(this.shin, i * 2, joint(this.m, this.thighR, 0, -THIGH, 0, -kneeR, 0, 0));
    this.put(this.shin, i * 2 + 1, joint(this.m, this.thighL, 0, -THIGH, 0, -kneeL, 0, 0));

    // ---- what they carry (bags hang from their top, things in the hand from the grip)
    if (L.item === NOTHING || k + 2 > this.itemKinds.length) return k;
    switch (L.item) {
      case SHOULDER_BAG:
        if (sitting) return this.carry(k, L, SHOULDER_BAG, this.putDown(0.24));
        k = this.carry(k, L, SHOULDER_BAG, joint(this.m, this.body, 0.205 * L.wide, 0.145, 0.01, 0, 0, 0.05));
        return this.carry(k, L, STRAP, joint(this.m, this.body, 0, 0, 0, 0, 0, 0, L.wide, 1, L.deep));
      case BACKPACK:
        if (sitting) return this.carry(k, L, BACKPACK, this.putDown(0.385));
        k = this.carry(k, L, BACKPACK, joint(this.m, this.body, 0, 0.5, 0.103 * L.deep + 0.07, 0, 0, 0));
        return this.carry(k, L, BACKPACK_STRAPS, joint(this.m, this.body, 0, 0, 0, 0, 0, 0, L.wide, 1, L.deep));
      case HANDBAG:
        // (sitting: on the seat beside)
        if (sitting) return this.carry(k, L, HANDBAG, joint(this.m, this.base, -0.45, -0.095 + 0.25, 0.02, 0, 0.2, 0));
        return this.carry(k, L, HANDBAG, joint(this.m, this.armL, GRIP.x, GRIP.y, GRIP.z, 0, 0, 0));
      case SHOPPING_BAG:
      case BRIEFCASE:
        if (sitting) return this.carry(k, L, L.item, this.putDown(L.item === BRIEFCASE ? 0.32 : 0.39));
        return this.carry(k, L, L.item, joint(this.m, this.armL, GRIP.x, GRIP.y, GRIP.z, 0, 0, 0));
      case SUITCASE: {
        if (!walking) return this.carry(k, L, SUITCASE, joint(this.m, IDENTITY, sitting ? 0.45 : 0.36, CASE_WHEEL, sitting ? -0.3 : 0.04, 0, sitting ? 0.25 : 0, 0));
        // pulled behind on its wheels, tipped so that the handle is in the hand
        _v.copy(GRIP).applyMatrix4(this.armR);
        const grip = 0.905;
        const tip = Math.acos(Math.min(0.99, Math.max(0.3, (_v.y - CASE_WHEEL) / grip)));
        return this.carry(k, L, SUITCASE, joint(this.m, IDENTITY, _v.x, CASE_WHEEL, _v.z + grip * Math.sin(tip), -tip, 0, 0));
      }
      case STICK:
        if (sitting) return this.carry(k, L, STICK, joint(this.m, IDENTITY, 0.34, 0.78, -0.3, 0.25, 0, 0));
        // upright from the hand to the ground
        _v.copy(GRIP).applyMatrix4(this.armR);
        return this.carry(k, L, STICK, joint(this.m, IDENTITY, _v.x, _v.y, _v.z, 0, 0, 0, 1, Math.max(0.3, _v.y / 0.8), 1));
    }
    return k;
  }

  private put(part: Part, index: number, local: THREE.Matrix4): void {
    part.mesh.setMatrixAt(index, this.out.multiplyMatrices(this.world, local));
  }

  /** Item slot k shows this thing of this person; returns the next slot. */
  private carry(k: number, L: Look, kind: number, local: THREE.Matrix4): number {
    if (this.itemLooks[k] !== L || this.itemKinds[k] !== kind) {
      this.itemLooks[k] = L;
      this.itemKinds[k] = kind;
      this.item.paint(k, L.bag, L.bag2, kind);
    }
    this.put(this.item, k, local);
    return k + 1;
  }

  /** Where a bag goes that is put down beside somebody sitting: on the ground by the feet (`top`: its height). */
  private putDown(top: number): THREE.Matrix4 {
    return joint(this.m, IDENTITY, 0.4, top, -0.42, 0, 0.3, 0);
  }
}
