// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The cars you see: body shell, wheels, lights – and for the player's car the
 * complete cockpit (dashboard, instruments, steering wheel, gear lever,
 * handbrake, pedals, seats, door trims) plus the three mirrors.
 *
 * Car frame: origin on the ground below the middle of the wheelbase,
 * +X right, +Y up, -Z forward.  Left-hand drive.
 *
 * Everything is built from code: no model files, no textures other than the
 * ones drawn here on a canvas.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COMPACT_DIMS, Sculpt, buildCarShell, buildWheel } from './carBody.ts';
import type { CarDims, CarShell, Vec3 } from './carBody.ts';
import { InstrumentPanel } from './instruments.ts';
import type { DashState } from './instruments.ts';
import { Mirror, mirrorNormal } from './mirrors.ts';

export interface CarVisualState extends DashState {
  /** steering wheel angle in rad, + = clockwise / right */
  steerWheel: number;
  /** road wheel steer angles (rad, + = right) and spin angles (rad) FL, FR, RL, RR */
  wheelSteer: number[];
  wheelSpin: number[];
  /** wheel centre height above the car origin plane, per wheel */
  wheelY: number[];
  clutch: number;
  brake: number;
  throttle: number;
  handbrakeLever: number;
  braking: boolean;
  reversing: boolean;
}

const DEG = Math.PI / 180;

/** Position and normal only, un-indexed: the form in which parts are merged. */
function bare(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(n.attributes)) if (name !== 'position' && name !== 'normal') n.deleteAttribute(name);
  return n;
}

/** A box; rotation as yaw (ry), then pitch (rx), then roll (rz). */
function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')));
  g.translate(x, y, z);
  return bare(g);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(parts, false)!;
}

/** Outline of a rectangle with rounded corners, counter-clockwise: [u, v] pairs. */
function roundRect(w: number, h: number, r: number, seg = 2): number[][] {
  const pts: number[][] = [];
  const corners = [
    [w / 2 - r, -h / 2 + r, -90],
    [w / 2 - r, h / 2 - r, 0],
    [-w / 2 + r, h / 2 - r, 90],
    [-w / 2 + r, -h / 2 + r, 180],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = (a0 + (90 * i) / seg) * DEG;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
}

/** Outline with soft corners that may be flatter below than above (a superellipse): [u, v] pairs. */
function softRing(halfWidth: number, top: number, bottom: number, n = 24): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const phi = (i / n) * Math.PI * 2;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    pts.push([halfWidth * Math.sign(c) * Math.sqrt(Math.abs(c)), (s >= 0 ? top : bottom) * Math.sign(s) * Math.sqrt(Math.abs(s))]);
  }
  return pts;
}

/** Put a flat outline into space: origin + u·right + v·up. */
function place(outline: number[][], o: Vec3, right: Vec3, up: Vec3): Vec3[] {
  return outline.map(([u, v]): Vec3 => [o[0] + right[0] * u + up[0] * v, o[1] + right[1] * u + up[1] * v, o[2] + right[2] * u + up[2] * v]);
}

function along(o: Vec3, dir: Vec3, s: number): Vec3 {
  return [o[0] + dir[0] * s, o[1] + dir[1] * s, o[2] + dir[2] * s];
}

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];

function plateTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 520;
  c.height = 110;
  const x = c.getContext('2d')!;
  x.fillStyle = '#f4f4f0';
  x.fillRect(0, 0, 520, 110);
  x.strokeStyle = '#111';
  x.lineWidth = 6;
  x.strokeRect(3, 3, 514, 104);
  x.fillStyle = '#1b3fa0';
  x.fillRect(6, 6, 44, 98);
  x.fillStyle = '#111';
  x.font = '700 78px "DIN Alternate", "Bahnschrift", "Arial Narrow", Arial, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(text, 285, 59, 450);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function roofSignTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const x = c.getContext('2d')!;
  x.fillStyle = '#f7f7f4';
  x.fillRect(0, 0, 512, 96);
  x.fillStyle = '#1454b8';
  x.fillRect(0, 0, 512, 12);
  x.fillRect(0, 84, 512, 12);
  x.font = '800 54px "DIN Alternate", "Bahnschrift", "Arial Narrow", Arial, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('FAHRSCHULE', 256, 50, 480);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Width : height of the lettering strip (and of its texture). */
const LETTERING_ASPECT = 8;

/**
 * The lettering as a mask: white letters on black, used as the alpha of a
 * plain-coloured strip.  The letters fill the strip's height; a bold face is
 * narrowed just enough to fit its length, which makes them as tall – and as
 * readable from behind – as the width of a bumper allows.
 */
function letteringTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.height = 256;
  c.width = c.height * LETTERING_ASPECT;
  const x = c.getContext('2d')!;
  x.fillStyle = '#000';
  x.fillRect(0, 0, c.width, c.height);
  const size = 200;
  x.font = `800 ${size}px "Helvetica Neue", Helvetica, Arial, "Liberation Sans", "Noto Sans", "DejaVu Sans", sans-serif`;
  x.textAlign = 'left';
  x.textBaseline = 'alphabetic';
  const m = x.measureText(text);
  // the inked box of this very text (no descenders in a web address like ours)
  const left = m.actualBoundingBoxLeft ?? 0;
  const right = m.actualBoundingBoxRight ?? m.width;
  const up = m.actualBoundingBoxAscent ?? size * 0.72;
  const down = m.actualBoundingBoxDescent ?? 0;
  const pad = 14;
  const sy = (c.height - 2 * pad) / Math.max(1, up + down);
  // never stretched wider than drawn, only narrowed
  const sx = Math.min(sy, (c.width - 2 * pad) / Math.max(1, left + right));
  x.setTransform(sx, 0, 0, sy, (c.width - (left + right) * sx) / 2 + left * sx, pad + up * sy);
  x.fillStyle = '#fff';
  x.fillText(text, 0, 0);
  x.setTransform(1, 0, 0, 1, 0, 0);
  const t = new THREE.CanvasTexture(c);
  // mip-maps and anisotropic filtering keep the strokes from breaking up at a distance and at a slant
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 8;
  return t;
}

/** Picture on the centre display: a stylised map with the route, and a row of tiles. */
function screenTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 288;
  const x = c.getContext('2d')!;
  x.fillStyle = '#0b131c';
  x.fillRect(0, 0, 512, 288);
  x.lineCap = 'round';
  x.lineJoin = 'round';
  const path = (pts: number[][], colour: string, width: number): void => {
    x.strokeStyle = colour;
    x.lineWidth = width;
    x.beginPath();
    pts.forEach((q, i) => (i === 0 ? x.moveTo(q[0], q[1]) : x.lineTo(q[0], q[1])));
    x.stroke();
  };
  // blocks of a town, streets between them
  x.fillStyle = '#121d29';
  x.fillRect(0, 0, 352, 288);
  for (const s of [
    [[-10, 78], [150, 64], [362, 40]],
    [[-10, 196], [176, 178], [362, 150]],
    [[58, -10], [84, 120], [100, 300]],
    [[236, -10], [246, 150], [262, 300]],
    [[150, 64], [176, 178]],
  ]) path(s, '#2c3d50', 15);
  path([[92, 300], [86, 186], [176, 178], [242, 168], [238, 40], [236, -10]], '#3d8bff', 8);
  x.fillStyle = '#eef2f5';
  x.beginPath();
  x.moveTo(88, 206);
  x.lineTo(104, 244);
  x.lineTo(89, 236);
  x.lineTo(73, 244);
  x.closePath();
  x.fill();
  // tiles at the side
  x.fillStyle = '#0e1822';
  x.fillRect(352, 0, 160, 288);
  const tiles = ['#3d8bff', '#35c06a', '#ffb020', '#9aa3ab'];
  tiles.forEach((colour, i) => {
    const tx = 372 + (i % 2) * 64;
    const ty = 28 + Math.floor(i / 2) * 64;
    x.fillStyle = '#1a2836';
    x.fillRect(tx, ty, 52, 52);
    x.fillStyle = colour;
    x.beginPath();
    x.arc(tx + 26, ty + 26, 11, 0, Math.PI * 2);
    x.fill();
  });
  x.fillStyle = '#1a2836';
  x.fillRect(372, 172, 116, 22);
  x.fillRect(372, 204, 116, 22);
  x.fillStyle = '#8f9aa5';
  x.fillRect(380, 180, 62, 6);
  x.fillRect(380, 212, 84, 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const SHELL_CACHE = new Map<string, CarShell>();
function shellFor(d: CarDims): CarShell {
  const key = JSON.stringify(d);
  let s = SHELL_CACHE.get(key);
  if (!s) SHELL_CACHE.set(key, (s = buildCarShell(d)));
  return s;
}

/** Half width of a bumper face (outline from the shell, bottom → top) at height y. */
function halfWidthAt(outline: number[][], y: number): number {
  let w = Infinity;
  for (let i = 0; i + 1 < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[i + 1];
    if (y0 === y1 || y < Math.min(y0, y1) || y > Math.max(y0, y1)) continue;
    w = Math.min(w, x0 + ((x1 - x0) * (y - y0)) / (y1 - y0));
  }
  return w === Infinity ? 0 : w;
}

const MAT = {
  trim: new THREE.MeshLambertMaterial({ color: 0x17191b }),
  tyre: new THREE.MeshLambertMaterial({ color: 0x151617 }),
  rim: new THREE.MeshPhongMaterial({ color: 0xb9bdc2, shininess: 60, specular: 0x555555 }),
  glassDark: new THREE.MeshPhongMaterial({ color: 0x0c1418, shininess: 140, specular: 0x9fb4c4 }),
};

export interface CarExteriorOptions {
  dims?: CarDims;
  plate?: string;
  seeThroughGlass?: boolean;
  roofSign?: boolean;
  noMirrorHousings?: boolean;
  /** lettering on the front and the rear bumper (the traffic cars carry none) */
  lettering?: string;
  /** own copies of the materials all cars share, for a car that changes them (see-through cabin) */
  ownMaterials?: boolean;
}

/** Body, wheels and lamps – everything a car shows from outside. */
export class CarExterior {
  readonly group = new THREE.Group();
  readonly dims: CarDims;
  readonly shell: CarShell;
  readonly wheels: THREE.Group[] = [];
  private readonly wheelSpinners: THREE.Group[] = [];
  readonly paint: THREE.MeshPhongMaterial;
  readonly glass: THREE.Material;
  /** the opaque body and what is fixed to it (not wheels, glass, plates, lettering) */
  readonly solids: THREE.Mesh[] = [];
  private readonly head: THREE.MeshBasicMaterial;
  private readonly tail: THREE.MeshBasicMaterial;
  private readonly reverse: THREE.MeshBasicMaterial;
  private readonly blinkL: THREE.MeshBasicMaterial;
  private readonly blinkR: THREE.MeshBasicMaterial;

  constructor(color: number, opts: CarExteriorOptions = {}) {
    const d = (this.dims = opts.dims ?? COMPACT_DIMS);
    const sh = (this.shell = shellFor(d));
    const trim = opts.ownMaterials ? MAT.trim.clone() : MAT.trim;
    this.paint = new THREE.MeshPhongMaterial({ color, shininess: 90, specular: 0x777777 });
    // Shadows: the shell is not a closed solid (the windows are openings, the floor is a part
    // of its own), so both of its sides throw shadow – otherwise the roof, which faces the sun,
    // would throw none.  Nothing on the car receives shadow: at the scale of a shadow map a
    // car shadowing itself, inside or out, only looks blotchy.
    this.paint.shadowSide = THREE.DoubleSide;
    this.glass = opts.seeThroughGlass
      ? new THREE.MeshPhongMaterial({ color: 0x9fc0d0, transparent: true, opacity: 0.16, shininess: 160, specular: 0xffffff, depthWrite: false })
      : MAT.glassDark;
    const g = this.group;
    const solid = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      this.solids.push(m);
      g.add(m);
      return m;
    };
    solid(sh.paint, this.paint).castShadow = true;
    const glass = new THREE.Mesh(sh.glass, this.glass);
    glass.renderOrder = 5;
    g.add(glass);
    solid(sh.trim, trim).castShadow = true;
    solid(sh.pillars, this.paint).castShadow = true;

    const wheelGeo = buildWheel(d);
    const xs = [-d.track / 2, d.track / 2, -d.track / 2, d.track / 2];
    const zs = [sh.zAxleF, sh.zAxleF, sh.zAxleR, sh.zAxleR];
    for (let i = 0; i < 4; i++) {
      const steer = new THREE.Group();
      const spin = new THREE.Group();
      spin.add(new THREE.Mesh(wheelGeo.tyre, MAT.tyre), new THREE.Mesh(wheelGeo.rim, MAT.rim));
      steer.add(spin);
      steer.position.set(xs[i], d.wheelRadius, zs[i]);
      g.add(steer);
      this.wheels.push(steer);
      this.wheelSpinners.push(spin);
    }

    // lamps
    this.head = new THREE.MeshBasicMaterial({ color: 0xdfe6ea });
    this.tail = new THREE.MeshBasicMaterial({ color: 0x5a0d0d });
    this.reverse = new THREE.MeshBasicMaterial({ color: 0x777777 });
    this.blinkL = new THREE.MeshBasicMaterial({ color: 0x6a3a08 });
    this.blinkR = new THREE.MeshBasicMaterial({ color: 0x6a3a08 });
    const hw = sh.halfWidth;
    const lamps: Array<[THREE.BufferGeometry, THREE.Material]> = [];
    for (const side of [-1, 1]) {
      lamps.push([box(0.34, 0.1, 0.05, side * hw * 0.62, 0.635, sh.zFront + 0.115, 0, side * -0.35), this.head]);
      lamps.push([box(0.1, 0.07, 0.05, side * hw * 0.86, 0.6, sh.zFront + 0.2, 0, side * -0.8), side < 0 ? this.blinkL : this.blinkR]);
      lamps.push([box(0.3, 0.13, 0.05, side * hw * 0.7, 0.9, sh.zRear - 0.115, 0, side * 0.3), this.tail]);
      lamps.push([box(0.1, 0.09, 0.05, side * hw * 0.88, 0.9, sh.zRear - 0.19, 0, side * 0.7), side < 0 ? this.blinkL : this.blinkR]);
      lamps.push([box(0.12, 0.05, 0.04, side * hw * 0.45, 0.86, sh.zRear - 0.06), this.reverse]);
      // mirror housings (the player's car builds its own, aligned with the working glass)
      if (!opts.noMirrorHousings) g.add(new THREE.Mesh(box(0.2, 0.13, 0.09, side * (hw + 0.1), sh.beltY + 0.06, sh.zCowl + 0.4), this.paint));
    }
    for (const [geo, mat] of lamps) solid(geo, mat);
    // grille and number plates
    solid(box(0.86, 0.14, 0.04, 0, 0.5, sh.zFront + 0.05), trim);
    if (opts.plate) {
      const tex = plateTexture(opts.plate);
      const pm = new THREE.MeshBasicMaterial({ map: tex });
      const front = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.11), pm);
      front.position.set(0, 0.36, sh.zFront - 0.012);
      front.rotation.y = Math.PI;
      const rear = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.11), pm);
      rear.position.set(0, 0.66, sh.zRear + 0.012);
      g.add(front, rear);
    }
    if (opts.lettering) this.addLettering(opts.lettering, color);
    if (opts.roofSign) {
      const tex = roofSignTexture();
      const sm = new THREE.MeshBasicMaterial({ map: tex });
      solid(box(0.86, 0.16, 0.2, 0, sh.roofY + 0.085, 0.25), new THREE.MeshLambertMaterial({ color: 0xf2f2ee }));
      const f = solid(new THREE.PlaneGeometry(0.84, 0.15), sm);
      f.position.set(0, sh.roofY + 0.085, 0.25 - 0.101);
      f.rotation.y = Math.PI;
      const r = solid(new THREE.PlaneGeometry(0.84, 0.15), sm);
      r.position.set(0, sh.roofY + 0.085, 0.25 + 0.101);
    }
  }

  /**
   * Lettering on both bumpers: a strip lying just in front of the flat nose
   * face (above the number plate) and of the tail face (below it), as wide as
   * the face allows.  Each strip is turned to its own side, so the text reads
   * left to right from in front as well as from behind.
   */
  private addLettering(text: string, paint: number): void {
    const sh = this.shell;
    const c = new THREE.Color(paint);
    // dark letters on light paint, light ones on dark paint
    const light = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.18;
    const ink = new THREE.MeshLambertMaterial({
      color: light ? 0x14171b : 0xf2f3f0,
      alphaMap: letteringTexture(text),
      transparent: true,
      depthWrite: false,
      // the strip lies a few millimetres off the paint; the bias keeps it from flickering far away
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const strip = (outline: number[][], yLow: number, yHigh: number, z: number, facing: number): void => {
      // as large as fits between yLow and yHigh without leaving the flat face
      let h = yHigh - yLow;
      for (let i = 0; i < 4; i++) h = Math.min(h, (2 * Math.min(halfWidthAt(outline, yLow), halfWidthAt(outline, yLow + h)) - 0.03) / LETTERING_ASPECT);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(h * LETTERING_ASPECT, h), ink);
      m.position.set(0, (yLow + yHigh) / 2, z + facing * 0.006);
      if (facing < 0) m.rotation.y = Math.PI;
      m.name = facing < 0 ? 'lettering front' : 'lettering rear';
      // after the body (which is drawn late while the cabin is see-through), before the glass
      m.renderOrder = 4;
      this.group.add(m);
    };
    strip(sh.noseOutline, 0.455, 0.625, sh.zFront, -1);
    strip(sh.tailOutline, 0.435, 0.595, sh.zRear, 1);
  }

  setWheels(steer: number[], spin: number[], y: number[]): void {
    for (let i = 0; i < 4; i++) {
      // + steer = right = negative rotation about +Y
      this.wheels[i].rotation.y = i < 2 ? -steer[i] : 0;
      this.wheels[i].position.y = y[i];
      // rolling forward (-Z) turns the top of the wheel forward: negative rotation about +X
      this.wheelSpinners[i].rotation.x = -spin[i];
    }
  }

  setLamps(o: { low: boolean; high: boolean; brake: boolean; reverse: boolean; left: boolean; right: boolean }): void {
    this.head.color.set(o.high ? 0xffffff : o.low ? 0xf4f6f0 : 0xcfd6da);
    this.tail.color.set(o.brake ? 0xff2a1e : o.low ? 0xa01410 : 0x5a0d0d);
    this.reverse.color.set(o.reverse ? 0xffffff : 0x777777);
    this.blinkL.color.set(o.left ? 0xffa010 : 0x6a3a08);
    this.blinkR.color.set(o.right ? 0xffa010 : 0x6a3a08);
  }
}

// ---------------------------------------------------------------- cockpit ----

/**
 * The cabin gets little direct light and the scene has no bounce light; a
 * self-lit share keeps it readable instead of a black hole (what your eyes do
 * when they adapt).  `hex` is roughly the colour the part shows in daylight.
 */
function cabinMaterial(hex: number, shine = 0): THREE.MeshLambertMaterial | THREE.MeshPhongMaterial {
  const c = new THREE.Color(hex);
  const color = c.clone().multiplyScalar(0.6);
  const emissive = c.clone().multiplyScalar(0.42);
  return shine > 0
    ? new THREE.MeshPhongMaterial({ color, emissive, shininess: shine, specular: new THREE.Color(hex).multiplyScalar(0.35) })
    : new THREE.MeshLambertMaterial({ color, emissive });
}

/** Geometry of the fixed cabin parts, collected per material. */
interface Kit {
  /** padded upper surfaces: dashboard top, door tops, instrument hood */
  soft: THREE.BufferGeometry[];
  /** hard plastic: lower dashboard, console, door panels */
  hard: THREE.BufferGeometry[];
  /** pale lining: sun visors, roof lamp */
  pale: THREE.BufferGeometry[];
  fabric: THREE.BufferGeometry[];
  accent: THREE.BufferGeometry[];
  carpet: THREE.BufferGeometry[];
  silver: THREE.BufferGeometry[];
  black: THREE.BufferGeometry[];
}

/** Where the instrument cluster sits, shared by the hood built around it and the picture itself. */
interface ClusterPlace {
  centre: Vec3;
  /** backward tilt of the face in rad */
  tilt: number;
  width: number;
  height: number;
}

/**
 * Dashboard: a side profile that changes across the car (deeper at the doors,
 * crowned like the scuttle), with a padded top, a bright trim strip under its
 * brow and a hard lower part; then the glove box, the air vents and the centre
 * stack with its display.
 */
function buildDashboard(sh: CarShell, kit: Kit): { browZ: (x: number) => number; browY: (x: number) => number } {
  const hw = sh.halfWidth;
  const zc = sh.zCowl;
  // just inside the side glass
  const xe = hw * 0.975 - 0.022;
  // lower edge of the windscreen across the car
  const cowlAt = (x: number): number => sh.cowlY + (sh.cowlCrownY - sh.cowlY) * (1 - Math.abs(x) / (hw * 0.9));
  // the brow: the edge of the top towards the occupants.  It stays below the
  // base of the windscreen as the driver sees it, so the top hides no road.
  const browZ = (x: number): number => zc + 0.385 + 0.05 * Math.abs(x / xe) ** 3;
  const browY = (x: number): number => sh.beltY + 0.002 - 0.012 * (x / xe) ** 2;
  const top: Vec3[][] = [];
  const band: Vec3[][] = [];
  const lower: Vec3[][] = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const x = -xe + (2 * xe * i) / n;
    const zb = browZ(x);
    const yb = browY(x);
    const zf = zc + 0.004;
    const yf = cowlAt(x) - 0.014;
    const p = (z: number, y: number): Vec3 => [x, y, z];
    const t: Vec3[] = [];
    for (const s of [0, 0.33, 0.66, 1]) t.push(p(zf + (zb - 0.032 - zf) * s, yf + (yb - yf) * s + 0.006 * Math.sin(Math.PI * s)));
    // rounded brow with a lip, the strip set back under it
    t.push(p(zb - 0.012, yb - 0.003), p(zb - 0.002, yb - 0.013), p(zb, yb - 0.027), p(zb - 0.008, yb - 0.04), p(zb - 0.02, yb - 0.045));
    top.push(t);
    band.push([p(zb - 0.02, yb - 0.045), p(zb - 0.018, yb - 0.074)]);
    lower.push([
      p(zb - 0.018, yb - 0.074),
      p(zb - 0.004, yb - 0.082),
      p(zb + 0.004, yb - 0.1),
      p(zb + 0.002, yb - 0.2),
      p(zb - 0.02, yb - 0.265),
      p(zb - 0.08, yb - 0.31),
      p(zc + 0.02, yb - 0.33),
    ]);
  }
  kit.soft.push(new Sculpt().sheet(top, [0, 1, 0.4]).build(50));
  kit.silver.push(new Sculpt().sheet(band, Z).build());
  const low = new Sculpt().sheet(lower, [0, -0.3, 1]);
  // closed ends towards the doors
  for (const i of [0, n]) low.fan([...top[i], ...lower[i]], [i === 0 ? -1 : 1, 0, 0]);
  kit.hard.push(low.build(50));

  // glove box lid on the passenger's side, standing a little proud, with its handle
  const lid: Vec3[][] = [];
  for (let i = 0; i <= 4; i++) {
    const x = 0.25 + 0.125 * i;
    const zb = browZ(x);
    const yb = browY(x);
    lid.push([
      [x, yb - 0.108, zb + 0.009],
      [x, yb - 0.196, zb + 0.008],
      [x, yb - 0.256, zb - 0.01],
    ]);
  }
  kit.soft.push(new Sculpt().sheet(lid, [0, -0.2, 1]).build(60));
  kit.silver.push(box(0.09, 0.012, 0.01, 0.5, browY(0.5) - 0.122, browZ(0.5) + 0.012));

  // round air vents at both ends, turned a little towards the middle of the cabin
  for (const side of [-1, 1]) {
    const x = side * (xe - 0.115);
    const o: Vec3 = [x, browY(x) - 0.066, browZ(x) - 0.008];
    const yaw = -side * 0.3;
    const out: Vec3 = [Math.sin(yaw), 0, Math.cos(yaw)];
    const right: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const circle = (r: number, s: number): Vec3[] => {
      const ring: Vec3[] = [];
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        ring.push(along(along(along(o, out, s), right, Math.cos(a) * r), Y, Math.sin(a) * r));
      }
      return ring;
    };
    kit.silver.push(new Sculpt().tube([circle(0.047, -0.01), circle(0.047, 0.016), circle(0.04, 0.019)]).build(50));
    kit.black.push(new Sculpt().tube([circle(0.04, 0.019), circle(0.038, 0.002)], false, false, true).fan(circle(0.038, 0.002), out).build(50));
    for (const dy of [-0.018, 0, 0.018]) kit.hard.push(box(Math.sqrt(0.037 ** 2 - dy ** 2) * 2, 0.004, 0.012, o[0] + out[0] * 0.01, o[1] + dy, o[2] + out[2] * 0.01, 0.25, yaw));
    kit.silver.push(box(0.008, 0.012, 0.008, o[0] + out[0] * 0.018, o[1], o[2] + out[2] * 0.018, 0, yaw));
  }

  // ---- centre stack: display on top, two vents, heating controls ------------
  const zs = browZ(0);
  const ys = browY(0);
  const stack: Vec3[][] = [];
  // rings from the top down; the face leans back, the foot widens into the console
  for (const [y, w, zFace, depth] of [
    [ys - 0.052, 0.3, zs + 0.012, 0.11],
    [ys - 0.075, 0.32, zs + 0.03, 0.14],
    [0.72, 0.31, zs + 0.052, 0.17],
    [0.6, 0.25, zs + 0.085, 0.2],
    [0.5, 0.215, zs + 0.13, 0.24],
  ]) stack.push(place(roundRect(w, depth, 0.028), [0, y, zFace - depth / 2], X, [0, 0, -1]));
  kit.hard.push(new Sculpt().tube(stack, true).build(50));
  // the face of the stack is a plane through its upper rings: things on it share its lean
  const lean = Math.atan2(0.052 - 0.03, ys - 0.075 - 0.72);
  const onFace = (y: number): number => zs + 0.03 + (ys - 0.075 - y) * Math.tan(lean);
  for (const side of [-1, 1]) {
    const y = ys - 0.118;
    kit.black.push(box(0.118, 0.04, 0.012, side * 0.072, y, onFace(y) - 0.002, -lean));
    for (const dy of [-0.009, 0.009]) kit.hard.push(box(0.11, 0.004, 0.014, side * 0.072, y + dy, onFace(y + dy) + 0.002, -lean - 0.3));
    kit.silver.push(box(0.01, 0.022, 0.008, side * 0.072, y, onFace(y) + 0.008, -lean));
  }
  const yk = ys - 0.185;
  kit.black.push(box(0.27, 0.058, 0.01, 0, yk, onFace(yk) - 0.001, -lean));
  for (const kx of [-0.09, 0, 0.09]) {
    const ring = new THREE.CylinderGeometry(0.02, 0.022, 0.022, 14, 1, true).rotateX(Math.PI / 2 - lean).translate(kx, yk, onFace(yk) + 0.014);
    kit.silver.push(bare(ring));
    const cap = new THREE.CircleGeometry(0.02, 14).rotateX(-lean).translate(kx, yk + 0.011 * Math.sin(lean), onFace(yk) + 0.014 + 0.011 * Math.cos(lean));
    kit.black.push(bare(cap));
  }
  return { browZ, browY };
}

/**
 * Instrument hood: a pod around the cluster with a rounded opening towards the
 * driver, running out forwards into the top of the dashboard.
 */
function buildBinnacle(kit: Kit, k: ClusterPlace, dashTopY: number): void {
  const up: Vec3 = [0, Math.cos(k.tilt), -Math.sin(k.tilt)];
  const out: Vec3 = [0, Math.sin(k.tilt), Math.cos(k.tilt)];
  const hw = k.width / 2;
  const hh = k.height / 2;
  // rings around the axis of the instrument face; their widest line lies below its middle
  const ring = (s: number, grow: number): Vec3[] =>
    place(softRing(hw + 0.02 + grow, hh + 0.042 + grow, hh - 0.014 + grow), along(along(k.centre, out, s), up, -0.02), X, up);
  const depth = 0.085;
  // outside: from inside the dashboard back to the rim, rounded over into the opening
  kit.soft.push(new Sculpt().tube([ring(-0.1, 0.026), ring(0, 0.02), ring(depth, 0.014), ring(depth + 0.006, 0.007)]).build(60));
  // inside: a dark tunnel down to the instrument face
  kit.black.push(
    new Sculpt()
      .tube([ring(depth + 0.006, 0.007), ring(depth, 0), ring(-0.004, -0.004)], false, false, true)
      .fan(ring(-0.004, -0.004), out)
      .build(60),
  );
  // the hood runs out forwards and downwards into the dashboard top
  const full = ring(0, 0.02);
  const rows: Vec3[][] = [full.slice(0, 13)];
  for (const [dz, half, rise] of [
    [0.15, hw + 0.05, 0.03],
    [0.3, hw + 0.01, -0.02],
  ]) {
    const row: Vec3[] = [];
    for (let i = 0; i <= 12; i++) {
      const phi = (i / 12) * Math.PI;
      const c = Math.cos(phi);
      row.push([k.centre[0] + half * Math.sign(c) * Math.sqrt(Math.abs(c)), dashTopY - 0.03 + (rise + 0.03) * Math.sqrt(Math.sin(phi)), k.centre[2] - dz]);
    }
    rows.push(row);
  }
  kit.soft.push(new Sculpt().sheet(rows, [0, 1, 0.2]).build(60));
}

/** Tunnel console between the seats: tray, gear lever frame, cup holders, padded armrest. */
function buildConsole(kit: Kit, zStack: number): void {
  // top line from the foot of the centre stack back to between the rear footwells
  const line = [
    [zStack + 0.04, 0.5, 0.2],
    [zStack + 0.2, 0.5, 0.2],
    [-0.02, 0.505, 0.2],
    [0.2, 0.51, 0.2],
    [0.27, 0.56, 0.21],
    [0.33, 0.585, 0.21],
    [0.7, 0.585, 0.21],
    [0.76, 0.52, 0.2],
    [0.8, 0.3, 0.19],
  ];
  const rings: Vec3[][] = line.map(([z, top, w]) => {
    const h = top - 0.22;
    return place(roundRect(w, h, 0.03), [0, 0.22 + h / 2, z], X, Y);
  });
  kit.hard.push(new Sculpt().tube(rings, false, true).build(50));
  // gear lever surround and two cup holders
  kit.silver.push(new Sculpt().tube([place(roundRect(0.13, 0.16, 0.03), [0, 0.503, -0.12], X, [0, 0, -1]), place(roundRect(0.12, 0.15, 0.028), [0, 0.509, -0.12], X, [0, 0, -1])], false, true).build(50));
  kit.black.push(new Sculpt().fan(place(roundRect(0.098, 0.128, 0.022), [0, 0.5095, -0.12], X, [0, 0, -1]), Y).build());
  for (const z of [0.06, 0.155]) {
    const disc: Vec3[] = [];
    const rim: Vec3[] = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      disc.push([-0.042 + Math.cos(a) * 0.036, 0.5115, z - Math.sin(a) * 0.036]);
      rim.push([-0.042 + Math.cos(a) * 0.041, 0.511, z - Math.sin(a) * 0.041]);
    }
    kit.black.push(new Sculpt().fan(disc, Y).build());
    kit.silver.push(new Sculpt().fan(rim, Y).build());
  }
  // padded lid of the armrest
  const pad = [0.345, 0.37, 0.67, 0.695].map((z, i) => place(roundRect(i % 3 === 0 ? 0.18 : 0.2, i % 3 === 0 ? 0.012 : 0.03, 0.006, 1), [0, 0.598, z], X, Y));
  kit.accent.push(new Sculpt().tube(pad, true, true).build(60));
}

/**
 * Inner door panel between z0 (front) and z1: padded top roll at the window
 * sill, a fabric insert, an armrest with the door pull, the handle and a
 * loudspeaker grille.  The driver's door also carries the window switches.
 */
function buildDoor(sh: CarShell, kit: Kit, side: number, z0: number, z1: number, front: boolean): void {
  // stations along the door: the front doors are in view all the time, the rear ones hardly ever
  const n = front ? 8 : 5;
  const xg = sh.halfWidth * 0.975 - 0.006;
  // the sill follows the lower edge of the glass, which rises from the scuttle to the cabin
  const sill = (z: number): number => sh.beltY - 0.004 - (sh.beltY - (sh.cowlY - 0.015)) * Math.max(0, Math.min(1, (sh.zRoofFront - z) / (sh.zRoofFront - sh.zCowl)));
  const roll: Vec3[][] = [];
  const insert: Vec3[][] = [];
  const panel: Vec3[][] = [];
  const armY = 0.735;
  const armAt = (z: number): number => {
    // the armrest grows out of the panel behind the door's front edge and fades before its rear edge
    const u = (z - z0) / (z1 - z0);
    const ramp = (a: number, b: number): number => {
      const t = Math.max(0, Math.min(1, (u - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    return ramp(0.2, 0.36) * (1 - ramp(0.84, 0.97));
  };
  for (let i = 0; i <= n; i++) {
    const z = z0 + ((z1 - z0) * i) / n;
    const ys = sill(z);
    const a = armAt(z);
    const p = (inward: number, y: number): Vec3 => [side * (xg - inward), y, z];
    roll.push([p(0, ys), p(0.04, ys + 0.004), p(0.068, ys - 0.016), p(0.076, ys - 0.05), p(0.07, ys - 0.074)]);
    insert.push([p(0.07, ys - 0.074), p(0.07, armY + 0.05)]);
    panel.push([
      p(0.07, armY + 0.05),
      p(0.078 + 0.062 * a, armY + 0.028),
      p(0.082 + 0.068 * a, armY),
      p(0.08 + 0.055 * a, armY - 0.045),
      p(0.078, armY - 0.1),
      p(0.074, 0.3),
      p(0.03, 0.24),
    ]);
  }
  const facing: Vec3 = [-side, 0.2, 0];
  kit.soft.push(new Sculpt().sheet(roll, [-side, 1, 0]).build(60));
  kit.accent.push(new Sculpt().sheet(insert, facing).build());
  const body = new Sculpt().sheet(panel, facing);
  // the panel's front and rear edges
  for (const i of [0, n]) body.fan([...roll[i], ...panel[i]], [0, 0, i === 0 ? -1 : 1]);
  kit.hard.push(body.build(50));

  const len = z1 - z0;
  // release handle in a dark recess, towards the front of the door
  const zh = z0 + len * (front ? 0.3 : 0.26);
  const yh = sill(zh) - 0.11;
  kit.black.push(box(0.006, 0.05, 0.15, side * (xg - 0.073), yh, zh));
  kit.silver.push(box(0.014, 0.022, 0.1, side * (xg - 0.083), yh, zh + 0.012));
  // door pull on the armrest
  const zp = z0 + len * 0.6;
  kit.black.push(box(0.05, 0.008, len * 0.22, side * (xg - 0.118), armY + 0.031, zp, 0, 0, side * 0.12));
  if (front && side < 0) {
    for (const dz of [-0.03, -0.01, 0.01, 0.03]) kit.silver.push(box(0.022, 0.006, 0.012, side * (xg - 0.12), armY + 0.037, zp - len * 0.18 + dz, 0, 0, side * 0.12));
  }
  // loudspeaker grille low in the panel
  const zl = z0 + len * (front ? 0.24 : 0.3);
  const grille: Vec3[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    grille.push([side * (xg - 0.079), 0.5 + Math.sin(a) * 0.075, zl + Math.cos(a) * 0.075]);
  }
  kit.black.push(new Sculpt().fan(grille, [-side, 0, 0]).build());
}

/**
 * A seat: cushion and backrest with raised side bolsters, a head restraint and
 * centre panels in a second fabric.  `width` 0.5 is a single seat, the rear
 * bench is the same shape drawn wide with two head restraints.
 */
function buildSeat(kit: Kit, x: number, zFront: number, width: number, recline: number, restraints: number[]): void {
  const w = width / 2;
  const top = 0.462;
  const zRear = zFront + 0.48;
  // cushion: outline across the car, swept from front to rear
  const cushion = (z: number, rise: number, scale: number): Vec3[] => {
    const o: number[][] = [
      [-w, -0.12],
      [w, -0.12],
      [w, -0.005],
      [w - 0.035, 0.028],
      [w - 0.095, 0],
      [-(w - 0.095), 0],
      [-(w - 0.035), 0.028],
      [-w, -0.005],
    ];
    return o.map(([u, v]): Vec3 => [x + u * scale, top + rise + v * (v > -0.1 ? scale : 1), z]);
  };
  kit.fabric.push(
    new Sculpt()
      .tube([cushion(zFront - 0.02, -0.035, 0.9), cushion(zFront + 0.02, 0.012, 1), cushion(zFront + 0.2, 0.004, 1), cushion(zRear, -0.02, 1)], true, true)
      .build(55),
  );
  // backrest: outline across the car, swept up along the reclined back
  const axis: Vec3 = [0, Math.cos(recline), Math.sin(recline)];
  const fwd: Vec3 = [0, Math.sin(recline), -Math.cos(recline)];
  const foot: Vec3 = [x, top - 0.03, zRear - 0.035];
  const back = (s: number, scale: number, bolster: number, thick: number): Vec3[] => {
    const b = w * scale;
    const o: number[][] = [
      [-b, -thick],
      [b, -thick],
      [b, 0],
      [b - 0.03, 0.035 * bolster],
      [b - 0.09, 0],
      [-(b - 0.09), 0],
      [-(b - 0.03), 0.035 * bolster],
      [-b, 0],
    ];
    return place(o, along(foot, axis, s), X, fwd);
  };
  const height = 0.62;
  kit.fabric.push(
    new Sculpt()
      .tube([back(0, 0.96, 1, 0.1), back(0.22, 0.98, 1, 0.1), back(0.46, 0.94, 0.7, 0.085), back(height - 0.02, 0.86, 0.2, 0.07), back(height, 0.78, 0, 0.05)], false, true)
      .build(55),
  );
  // centre panels, a few millimetres proud of the hollow between the bolsters
  const half = w - 0.105;
  const panels = new Sculpt();
  panels.sheet(
    [zFront + 0.05, zFront + 0.2, zRear - 0.05].map((z, i): Vec3[] => [
      [x - half, top + [0.014, 0.008, -0.006][i], z],
      [x + half, top + [0.014, 0.008, -0.006][i], z],
    ]),
    Y,
  );
  panels.sheet(
    [0.07, 0.3, 0.52].map((s): Vec3[] => {
      const o = along(along(foot, axis, s), fwd, 0.004);
      const b = w * 0.95 - 0.1;
      return [
        [o[0] - b, o[1], o[2]],
        [o[0] + b, o[1], o[2]],
      ];
    }),
    fwd,
  );
  kit.accent.push(panels.build());
  // head restraints on the line of the backrest
  for (const rx of restraints) {
    const rings = [
      [height - 0.005, 0.8],
      [height + 0.03, 1],
      [height + 0.13, 1],
      [height + 0.165, 0.8],
    ].map(([s, k]) => place(roundRect(0.25 * k, 0.085 * k, 0.03 * k, 1), along(along([x + rx, foot[1], foot[2]], axis, s), fwd, -0.03), X, fwd));
    kit.fabric.push(new Sculpt().tube(rings, true, true).build(60));
  }
}

/** The driving-school car with its interior and mirrors. */
export class PlayerCar {
  readonly root = new THREE.Group();
  readonly exterior: CarExterior;
  readonly cockpit = new THREE.Group();
  /** driver's eye point in car coordinates (seat position) */
  readonly eye = new THREE.Vector3(-0.36, 1.2, 0.2);
  readonly mirrors: Mirror[] = [];
  /** the centre display: its picture of a map, or the live map (setMapOnScreen) drawn into `mapCanvas` */
  private screen!: THREE.Mesh;
  private screenStill!: THREE.Texture;
  readonly mapCanvas = Object.assign(document.createElement('canvas'), { width: 512, height: 288 });
  readonly mapTexture = new THREE.CanvasTexture(this.mapCanvas);
  private readonly panel = new InstrumentPanel();
  private readonly steering = new THREE.Group();
  private readonly lever = new THREE.Group();
  private readonly handbrake = new THREE.Group();
  private readonly pedals: THREE.Group[] = [];
  private readonly stalk = new THREE.Group();
  private leverX = 0;
  private leverZ = 0;
  private gate = 0;
  // ---- see-through cabin (setCabinOpacity) ----
  /** parts that turn see-through, each with a twin that only writes depth; layer 1 = the controls in front */
  private readonly ghosts: Array<{ mesh: THREE.Mesh; twin: THREE.Mesh; layer: number }> = [];
  private readonly ghostMaterials: THREE.Material[] = [];
  private cabinOpacity = 1;
  private readonly depthOnly = new THREE.MeshBasicMaterial({
    colorWrite: false,
    // sorted with the see-through parts, drawn just before them
    transparent: true,
    // A hair behind the surface it belongs to (micrometres at arm's length), so that surface
    // passes the depth test even where a graphics chip rounds two shaders' depths differently.
    polygonOffset: true,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 6,
  });

  constructor() {
    this.exterior = new CarExterior(0xc9cdd2, {
      plate: 'KS FS 2026',
      seeThroughGlass: true,
      roofSign: true,
      noMirrorHousings: true,
      lettering: 'maureranton.com',
      ownMaterials: true,
    });
    const sh = this.exterior.shell;
    this.root.add(this.exterior.group, this.cockpit);
    const hw = sh.halfWidth;
    const belt = sh.beltY;
    const zc = sh.zCowl;
    const ex = this.eye.x;

    const mats = {
      soft: cabinMaterial(0x40444b),
      hard: cabinMaterial(0x575d65),
      pale: cabinMaterial(0xb9bbb8),
      fabric: cabinMaterial(0x4a5466),
      accent: cabinMaterial(0x77849a),
      carpet: cabinMaterial(0x2c2e33),
      silver: cabinMaterial(0xb9bec4, 50),
      black: cabinMaterial(0x1a1c20),
    };
    const leather = cabinMaterial(0x2a2c31, 18);
    const kit: Kit = { soft: [], hard: [], pale: [], fabric: [], accent: [], carpet: [], silver: [], black: [] };
    const part = (geo: THREE.BufferGeometry, mat: THREE.Material, layer = 0, parent: THREE.Object3D = this.cockpit): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      parent.add(m);
      this.ghost(m, layer);
      return m;
    };

    // ---- shell seen from inside ---------------------------------------------
    part(sh.lining, mats.carpet);
    part(sh.headliner, mats.pale);
    part(sh.pillarTrim, mats.pale);

    // ---- dashboard, instrument hood, console, doors, seats -------------------
    const dash = buildDashboard(sh, kit);
    // The cluster stands where the driver sees it through the upper half of the
    // steering wheel: its top just under the rim, its foot just above the hub.
    const cluster: ClusterPlace = { centre: [ex, 0.905, zc + 0.435], tilt: 0.32, width: 0.36, height: 0.12 };
    buildBinnacle(kit, cluster, dash.browY(ex));
    buildConsole(kit, dash.browZ(0));
    buildDoor(sh, kit, -1, zc + 0.1, sh.zPillarB - 0.04, true);
    buildDoor(sh, kit, 1, zc + 0.1, sh.zPillarB - 0.04, true);
    buildDoor(sh, kit, -1, sh.zPillarB + 0.04, sh.zRoofRear - 0.15, false);
    buildDoor(sh, kit, 1, sh.zPillarB + 0.04, sh.zRoofRear - 0.15, false);
    buildSeat(kit, ex, -0.15, 0.5, 0.3, [0]);
    buildSeat(kit, -ex, -0.15, 0.5, 0.3, [0]);
    buildSeat(kit, 0, 0.86, 1.3, 0.36, [-0.36, 0.36]);
    // parcel shelf behind the rear seat
    kit.carpet.push(
      new Sculpt()
        .sheet(
          [
            [
              [-hw + 0.1, 0.985, 1.49],
              [hw - 0.1, 0.985, 1.49],
            ],
            [
              [-hw + 0.1, 0.975, sh.zTail + 0.02],
              [hw - 0.1, 0.975, sh.zTail + 0.02],
            ],
          ],
          Y,
        )
        .build(),
    );
    // seat belts hanging on the B pillars with their tongues, footrest beside the clutch
    for (const side of [-1, 1]) {
      // from the turning loop high on the pillar (which leans in with the side glass) to the reel at its foot
      const a: Vec3 = [side * (hw * 0.8 - 0.004), 1.22, sh.zPillarB - 0.023];
      const b: Vec3 = [side * (hw - 0.065), 0.5, sh.zPillarB - 0.023];
      const a2: Vec3 = [a[0], a[1], a[2] + 0.046];
      const b2: Vec3 = [b[0], b[1], b[2] + 0.046];
      kit.black.push(new Sculpt().quad(a, a2, b2, b).quad(a, b, b2, a2).build());
      kit.silver.push(box(0.012, 0.03, 0.06, a[0], a[1] + 0.012, sh.zPillarB));
      kit.silver.push(box(0.01, 0.05, 0.032, a[0] + (b[0] - a[0]) * 0.55 - side * 0.006, 0.824, sh.zPillarB, 0, 0, side * 0.16));
    }
    kit.black.push(box(0.1, 0.02, 0.24, ex - 0.36, 0.34, zc + 0.19, -0.9));
    // sun visors folded up against the roof lining, and the roof lamp
    const roofAt = (x: number): number => sh.roofY - 0.004 - 0.051 * (Math.abs(x) / (hw * 0.74)) - 0.025;
    for (const side of [-1, 1]) {
      kit.pale.push(box(0.33, 0.014, 0.15, side * 0.465, roofAt(0.465) - 0.008, sh.zRoofFront + 0.105, 0.01, 0, -side * 0.077));
    }
    kit.hard.push(box(0.15, 0.014, 0.085, 0.03, roofAt(0.03) - 0.006, sh.zRoofFront + 0.2));
    kit.pale.push(box(0.05, 0.004, 0.06, -0.005, roofAt(0.03) - 0.014, sh.zRoofFront + 0.2), box(0.05, 0.004, 0.06, 0.065, roofAt(0.03) - 0.014, sh.zRoofFront + 0.2));

    for (const name of Object.keys(kit) as Array<keyof Kit>) {
      if (kit[name].length) part(merge(kit[name]), mats[name]);
    }

    // ---- instrument cluster and centre display: self-lit pictures ------------
    const dial = new THREE.Mesh(new THREE.PlaneGeometry(cluster.width, cluster.height), new THREE.MeshBasicMaterial({ map: this.panel.texture, toneMapped: false }));
    dial.name = 'cluster';
    dial.position.set(cluster.centre[0], cluster.centre[1], cluster.centre[2]);
    dial.rotation.x = -cluster.tilt;
    this.cockpit.add(dial);
    // centre display, standing on the stack and turned a little towards the driver
    const display = new THREE.Group();
    display.position.set(0, dash.browY(0) - 0.025, dash.browZ(0) + 0.05);
    display.rotation.set(-0.2, -0.13, 0, 'YXZ');
    const bezel = new Sculpt().tube([0, -0.008, -0.016].map((z, i) => place(roundRect(i === 2 ? 0.25 : 0.262, i === 2 ? 0.14 : 0.152, 0.014, 1), [0, 0, z], X, Y)), true, true).build(50);
    part(bezel, mats.black, 0, display);
    part(box(0.07, 0.07, 0.03, 0, -0.07, -0.028), mats.hard, 0, display);
    // (navigation is drawn on it by the HUD layer later)
    this.screenStill = screenTexture();
    this.mapTexture.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.244, 0.134), new THREE.MeshBasicMaterial({ map: this.screenStill, toneMapped: false }));
    screen.name = 'screen';
    this.screen = screen;
    screen.position.z = 0.0012;
    display.add(screen);
    this.cockpit.add(display);

    // ---- steering wheel -------------------------------------------------------
    // Rim plane in the wheel's own XY plane, +Z towards the driver; the hub lies
    // deeper than the rim (a dished wheel).
    const R = 0.17;
    const rim = bare(new THREE.TorusGeometry(R, 0.0155, 8, 44));
    part(rim, leather, 1, this.steering);
    const hubRings = [
      [-0.085, 0.8, 0.9],
      [-0.05, 1, 1],
      [-0.03, 1, 1],
      [-0.022, 0.86, 0.84],
    ].map(([z, kw, kh]) => softRing(0.074 * kw, 0.05 * kh, 0.058 * kh, 16).map(([u, v]): Vec3 => [u, v - 0.004, z]));
    const wheelHard = new Sculpt().tube(hubRings, true, true);
    // spokes at 9, 3 and 6 o'clock, sloping from the hub out to the rim
    const spoke = (angle: number, wHub: number, wRim: number): void => {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const rings = [
        [0.05, wHub, -0.04],
        [0.1, (wHub + wRim) / 2, -0.022],
        [R - 0.006, wRim, -0.004],
      ].map(([r, wd, z]) =>
        roundRect(wd, 0.016, 0.006, 1).map(([u, v]): Vec3 => [c * r - s * u, s * r + c * u, z + v]),
      );
      wheelHard.tube(rings);
    };
    spoke(Math.PI - 0.07, 0.056, 0.04);
    spoke(0.07, 0.056, 0.04);
    spoke(-Math.PI / 2, 0.05, 0.034);
    part(wheelHard.build(50), mats.soft, 1, this.steering);
    const surround = [-0.04, -0.031].map((z) => softRing(0.074 * 1.06, 0.05 * 1.07, 0.058 * 1.06, 16).map(([u, v]): Vec3 => [u, v - 0.004, z]));
    part(new Sculpt().tube(surround, false, true).build(50), mats.silver, 1, this.steering);
    // switch pads on the side spokes, a bright clasp on the lower one
    part(merge([box(0.04, 0.028, 0.004, -0.098, -0.004, -0.0125, 0, -0.2), box(0.04, 0.028, 0.004, 0.098, -0.004, -0.0125, 0, 0.2)]), mats.black, 1, this.steering);
    part(box(0.03, 0.05, 0.004, 0, -0.112, -0.0105, 0.2), mats.silver, 1, this.steering);
    // top-centre marker so the wheel position reads at a glance
    const marker = new THREE.Mesh(
      bare(new THREE.TorusGeometry(R, 0.0165, 8, 2, 0.085).rotateZ(Math.PI / 2 - 0.0425)),
      new THREE.MeshBasicMaterial({ color: 0xd8dde2 }),
    );
    this.steering.add(marker);
    const column = new THREE.Group();
    // The top of the rim stays just under the line of sight to the base of the windscreen.
    column.position.set(ex, 0.907, -0.27);
    column.rotation.x = -0.42; // the wheel's axis tilts up towards the driver
    column.add(this.steering);
    // column shroud from behind the hub into the dashboard
    const shroud = [
      [-0.05, 0.1, 0.085],
      [-0.12, 0.118, 0.1],
      [-0.3, 0.14, 0.12],
    ].map(([z, w, h]) => place(roundRect(w, h, 0.03), [0, -0.012, z], X, Y));
    part(new Sculpt().tube(shroud, true).build(50), mats.hard, 0, column);
    // indicator stalk (left) and wiper stalk (right) do not turn with the wheel
    const stalkGeo = (side: number): THREE.BufferGeometry =>
      merge([
        bare(new THREE.CylinderGeometry(0.0055, 0.008, 0.14, 8).rotateZ(side * Math.PI / 2).translate(side * 0.125, 0, 0)),
        bare(new THREE.CylinderGeometry(0.0105, 0.0105, 0.036, 8).rotateZ(side * Math.PI / 2).translate(side * 0.2, 0, 0)),
      ]);
    this.stalk.position.set(0, 0.04, -0.085);
    part(stalkGeo(-1), mats.black, 1, this.stalk);
    const wiper = part(stalkGeo(1), mats.black, 1, column);
    wiper.position.set(0, 0.04, -0.085);
    wiper.rotation.z = -0.06;
    column.add(this.stalk);
    this.cockpit.add(column);

    // ---- gear lever, handbrake, pedals ---------------------------------------
    this.lever.position.set(0, 0.505, -0.12);
    // (the gaiter's skirt reaches down into the console, so tilting the lever opens no gap under it)
    const boot: Vec3[][] = [
      [-0.022, 0.05, 0.063],
      [0.05, 0.03, 0.036],
      [0.095, 0.014, 0.016],
    ].map(([y, a, b]) => {
      const ring: Vec3[] = [];
      for (let i = 0; i < 10; i++) {
        const an = (i / 10) * Math.PI * 2;
        // a little pleated, like a leather gaiter
        const k = i % 2 === 0 ? 1 : 0.9;
        ring.push([Math.cos(an) * a * k, y, -Math.sin(an) * b * k]);
      }
      return ring;
    });
    part(new Sculpt().tube(boot).build(35), leather, 1, this.lever);
    part(bare(new THREE.CylinderGeometry(0.0075, 0.0075, 0.12, 8).translate(0, 0.14, 0)), mats.silver, 1, this.lever);
    part(bare(new THREE.SphereGeometry(0.027, 12, 8).scale(1, 0.9, 1.05).translate(0, 0.205, 0)), leather, 1, this.lever);
    this.cockpit.add(this.lever);

    this.handbrake.position.set(0.058, 0.525, 0.25);
    const grip = [
      [0.01, 0.03, 0.026],
      [-0.07, 0.03, 0.026],
      [-0.1, 0.036, 0.034],
      [-0.2, 0.036, 0.034],
      [-0.212, 0.026, 0.024],
    ].map(([z, w, h]) => place(roundRect(w, h, 0.01, 1), [0, 0.016, z], X, Y));
    part(new Sculpt().tube(grip, true, true).build(50), leather, 1, this.handbrake);
    part(bare(new THREE.CylinderGeometry(0.008, 0.008, 0.014, 8).rotateX(Math.PI / 2).translate(0, 0.016, -0.218)), mats.silver, 1, this.handbrake);
    this.cockpit.add(this.handbrake);

    const pedalX = [ex - 0.19, ex - 0.05, ex + 0.11];
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Group();
      p.position.set(pedalX[i], 0.52, zc + 0.15);
      part(box(0.016, 0.22, 0.012, 0, -0.11, 0), mats.black, 0, p);
      part(i === 2 ? box(0.046, 0.12, 0.014, 0, -0.2, 0.006) : box(0.07, 0.06, 0.014, 0, -0.23, 0.006), mats.black, 0, p);
      p.rotation.x = -0.5;
      this.pedals.push(p);
      this.cockpit.add(p);
    }

    // ---- mirrors ---------------------------------------------------------------
    // Inside mirror: small, curved and tucked up under the roof's front edge.
    // There it stays clear of the stretch of windscreen in which the traffic
    // lights of a junction appear to the car waiting first at the line.
    const inner = new THREE.Vector3(ex + 0.172, sh.roofY - 0.077, sh.zRoofFront + 0.044);
    this.mirrors.push(
      new Mirror({
        name: 'inside',
        centre: inner,
        width: 0.15,
        height: 0.042,
        normal: mirrorNormal(inner, this.eye, new THREE.Vector3(0, -0.03, 1)),
        convex: 1.5,
        resolution: [512, 160],
      }),
    );
    for (const side of [-1, 1]) {
      // at the front corner of the door glass: there the left one is inside the
      // forward view on an ordinary screen (about 36° off the line of sight)
      const c = new THREE.Vector3(side * (hw + 0.1), belt + 0.06, zc + 0.28);
      this.mirrors.push(
        new Mirror({
          name: side < 0 ? 'left' : 'right',
          centre: c,
          width: 0.17,
          height: 0.105,
          normal: mirrorNormal(c, this.eye, new THREE.Vector3(side * 0.16, -0.06, 1)),
          convex: side < 0 ? 1.25 : 1.6,
          resolution: [320, 200],
        }),
      );
    }
    // Housings: a rounded shell behind each glass.  They stay solid when the
    // cabin is see-through – a mirror must always read as a mirror.
    const shellPaint = this.exterior.paint.clone();
    const mirrorPlastic = cabinMaterial(0x24262a);
    this.mirrors.forEach((m, i) => {
      const s = m.spec;
      const n = s.normal.clone().normalize();
      const up = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
      const right = new THREE.Vector3().crossVectors(up, n);
      const depth = i === 0 ? 0.024 : 0.085;
      const rings = [
        [0.002, 1],
        [0.4, 1],
        [0.8, 0.82],
        [1, 0.5],
      ].map(([back, k]) => {
        const o = s.centre.clone().addScaledVector(n, -back * depth);
        return place(roundRect((s.width + 0.022) * k, (s.height + 0.022) * k, 0.018 * k, 2), [o.x, o.y, o.z], [right.x, right.y, right.z], [up.x, up.y, up.z]);
      });
      this.cockpit.add(m.mesh, new THREE.Mesh(new Sculpt().tube(rings, true, true).build(50), i === 0 ? mirrorPlastic : shellPaint));
    });
    // stem of the inside mirror up to the roof's front edge, feet of the door mirrors
    const stem = new Sculpt().tube(
      [
        [inner.x + 0.02, inner.y + 0.012, inner.z - 0.02],
        [inner.x + 0.035, sh.roofY - 0.036, sh.zRoofFront + 0.012],
      ].map((o, i) => place(roundRect(i === 0 ? 0.022 : 0.04, i === 0 ? 0.022 : 0.03, 0.006, 1), o as Vec3, X, [0, 0.5, 0.87])),
      true,
      true,
    );
    const feet = [stem.build(50)];
    for (const side of [-1, 1]) {
      // a short arm from the door, slimmer towards the housing it carries
      const arm = [
        [hw - 0.035, 0.066, 0.038],
        [hw + 0.03, 0.056, 0.032],
        [hw + 0.092, 0.042, 0.022],
      ].map(([x, d, h]) => place(roundRect(d, h, 0.009, 1), [side * x, belt - 0.013, zc + 0.264], Z, Y));
      feet.push(new Sculpt().tube(arm, false, true).build(50));
    }
    this.cockpit.add(new THREE.Mesh(merge(feet), mirrorPlastic));

    // ---- see-through cabin: the body belongs to it as well --------------------
    for (const m of this.exterior.solids) this.ghost(m, 0);
  }

  /**
   * How solid the cabin looks from the driver's seat: 1 = as built, smaller
   * values let the road show through dashboard, pillars, doors, roof, bonnet
   * and steering wheel (0.2 = strongly see-through).  Instruments, displays
   * and mirrors stay solid.  Seen from outside the car is always solid.
   *
   * The see-through parts are drawn as one layer: all of them first write
   * their depth only, then each is blended where it is the nearest of them.
   * So every pixel gets exactly one veil – no part shows through another, no
   * order to get wrong, nothing to flicker.  The controls in front (steering
   * wheel, stalks, levers) form a second layer of the same kind so that they
   * stand out against the dashboard behind them.
   */
  /** The live map on the centre display (true), or its still picture. */
  setMapOnScreen(on: boolean): void {
    const m = this.screen.material as THREE.MeshBasicMaterial;
    const want = on ? this.mapTexture : this.screenStill;
    if (m.map !== want) {
      m.map = want;
      m.needsUpdate = true;
    }
  }

  setCabinOpacity(opacity: number): void {
    const o = Number.isFinite(opacity) ? Math.min(1, Math.max(0.05, opacity)) : 1;
    const on = o < 0.995;
    const was = this.cabinOpacity < 1;
    this.cabinOpacity = on ? o : 1;
    if (on === was) return;
    for (const g of this.ghosts) {
      g.twin.visible = on;
      // draw order: depth of the cabin, cabin, depth of the controls, controls (then the glass, 5)
      g.mesh.renderOrder = on ? (g.layer === 0 ? 2 : 4) : 0;
    }
    for (const m of this.ghostMaterials) {
      m.transparent = on;
      m.opacity = 1;
      m.needsUpdate = true;
    }
  }

  /** Register a part of the see-through cabin. */
  private ghost(mesh: THREE.Mesh, layer: number): void {
    const twin = new THREE.Mesh(mesh.geometry, this.depthOnly);
    twin.visible = false;
    twin.renderOrder = layer === 0 ? 1 : 3;
    mesh.add(twin);
    this.ghosts.push({ mesh, twin, layer });
    const mat = mesh.material as THREE.Material;
    if (this.ghostMaterials.includes(mat)) return;
    this.ghostMaterials.push(mat);
    // Decided per picture: only the driver's own view from inside is see-through,
    // not the mirror pictures and not a camera outside the car.
    mat.onBeforeRender = (_renderer, _scene, camera) => {
      mat.opacity = this.cabinOpacity < 1 && this.seesFromInside(camera) ? this.cabinOpacity : 1;
    };
  }

  private readonly tmp = new THREE.Vector3();

  private seesFromInside(camera: THREE.Camera): boolean {
    for (const m of this.mirrors) if (m.camera === camera) return false;
    const sh = this.exterior.shell;
    const p = this.root.worldToLocal(this.tmp.setFromMatrixPosition(camera.matrixWorld));
    return Math.abs(p.x) < sh.halfWidth && p.y > 0.25 && p.y < sh.roofY && p.z > sh.zCowl - 0.1 && p.z < sh.zTail;
  }

  update(s: CarVisualState, dt: number, now: number): void {
    this.panel.update(s, now);
    this.exterior.setWheels(s.wheelSteer, s.wheelSpin, s.wheelY);
    this.exterior.setLamps({
      low: s.lowBeam,
      high: s.highBeam,
      brake: s.braking,
      reverse: s.reversing,
      left: s.blinkOn && (s.hazard || s.indicator < 0),
      right: s.blinkOn && (s.hazard || s.indicator > 0),
    });
    this.steering.rotation.z = -s.steerWheel;
    this.stalk.rotation.z = s.indicator * 0.16; // up = right, down = left

    // H gate: R far left forward, 1/2 left, 3/4 middle, 5/6 right
    let tx = 0;
    let tz = 0;
    const g = s.gear;
    if (!s.automatic) {
      if (g === -1) {
        tx = -1.5;
        tz = -1;
      } else if (g > 0) {
        tx = Math.floor((g - 1) / 2) - 1;
        tz = g % 2 === 1 ? -1 : 1;
      }
      if (g !== 0) this.gate = tx;
      else tx = this.gate * 0.0; // neutral springs to the 3/4 plane
    } else {
      tz = g === -2 ? -1.5 : g === -1 ? -0.75 : g === 0 ? 0 : 0.75;
    }
    const k = Math.min(1, Math.max(0, dt * 14));
    this.leverX += (tx - this.leverX) * k;
    this.leverZ += (tz - this.leverZ) * k;
    this.lever.rotation.z = -this.leverX * 0.17;
    this.lever.rotation.x = this.leverZ * 0.2;
    this.handbrake.rotation.x = s.handbrakeLever * 0.42;
    // pads hang towards the driver; pressing swings them forward (an automatic has no clutch pedal)
    this.pedals[0].visible = !s.automatic;
    this.pedals[0].rotation.x = -0.5 + s.clutch * 0.32;
    this.pedals[1].rotation.x = -0.5 + s.brake * 0.22;
    this.pedals[2].rotation.x = -0.5 + s.throttle * 0.28;
  }

  dispose(): void {
    for (const m of this.mirrors) m.dispose();
  }
}

export { COMPACT_DIMS };
