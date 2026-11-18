// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The emergency vehicles as they are seen: the police patrol car, the
 * ambulance (a Rettungswagen: a van with a box body), the fire engine (a
 * rescue pumper, HLF) and the emergency doctor's car (NEF) – each in the
 * livery such vehicles wear in Germany, with the blue lights that flash while
 * it is on a call: double flashes, left and right in turn, the headlights
 * flashing in turn with them.  The police car also has the "STOP POLIZEI"
 * sign that rises from its roof to stop the traffic (a road closure shows it).
 * Simple shapes and pictures drawn on a canvas; no real vehicle and no maker
 * is reproduced.
 *
 * Each is built around the point the traffic places it by – the ground below
 * the middle of its length –, x to the right, y up, the front towards −z.
 * EmergencyFleet draws those of the traffic (src/sim/emergency.ts): which one
 * a car is, and whether its lights are on, it reads from the car's style.
 */
import * as THREE from 'three';
import { EM, emKind, emLit } from '../sim/emergency.ts';
import type { TrafficCar } from '../sim/traffic.ts';
import { CarExterior } from './car.ts';
import { COMPACT_DIMS } from './carBody.ts';
import type { CarDims } from './carBody.ts';

const WHITE = new THREE.MeshLambertMaterial({ color: 0xf2f2ee });
const FIRE_RED = new THREE.MeshLambertMaterial({ color: 0xb3201c });
const DARK = new THREE.MeshLambertMaterial({ color: 0x1b1d20 });
const FRAME = new THREE.MeshLambertMaterial({ color: 0x33373c });
const STEEL = new THREE.MeshLambertMaterial({ color: 0xb9bec4 });
const TYRE = new THREE.MeshLambertMaterial({ color: 0x141516 });
const RIM = new THREE.MeshLambertMaterial({ color: 0xb4b8bc });
const GLASS = new THREE.MeshPhongMaterial({ color: 0x0c1418, shininess: 140, specular: 0x9fb4c4 });
/** the housing of a light bar, and the clear lamp in its middle */
const BAR = new THREE.MeshLambertMaterial({ color: 0x24282d });
const CLEAR = new THREE.MeshBasicMaterial({ color: 0xd9dfe4 });
const HEAD = new THREE.MeshBasicMaterial({ color: 0xfff3cf });
/** a headlight flashing (it is drawn over the headlight while it is lit) */
const FLASH = new THREE.MeshBasicMaterial({ color: 0xffffff });
const TAIL = new THREE.MeshBasicMaterial({ color: 0xa01410 });
const STOP = new THREE.MeshBasicMaterial({ color: 0xff3a2a });
const AMBER = new THREE.MeshBasicMaterial({ color: 0xffa010 });
const AMBER_OFF = new THREE.MeshLambertMaterial({ color: 0x6a3a08 });
const BLUE_ON = new THREE.Color(0x6a9cff);
const BLUE_OFF = new THREE.Color(0x1c2a52);

/** the blue of the police's livery, and the fluorescent red of the rescue services' */
const POLICE_BLUE = '#1d4f9c';
const SIGNAL_RED = '#e8321e';

/** A box from x0…x1, y0…y1, z0…z1. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, material: THREE.Material, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), material);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.castShadow = shadow;
  return m;
}

/** From `inner` to `outer` metres out from the middle on one side (1 right, −1 left), as x0 < x1. */
function across(side: number, inner: number, outer: number): [number, number] {
  return side > 0 ? [inner, outer] : [-outer, -inner];
}

/** A wheel lying on the x axis (a twin wheel when wide), its middle at the origin; turned about x it rolls. */
function wheel(radius: number, width: number): THREE.Group {
  const g = new THREE.Group();
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 20), TYRE);
  tyre.rotation.z = Math.PI / 2;
  tyre.castShadow = true;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.58, radius * 0.58, width + 0.02, 10), RIM);
  rim.rotation.z = Math.PI / 2;
  // (a spoke, so that it is seen to turn)
  const spoke = new THREE.Mesh(new THREE.BoxGeometry(width + 0.03, radius * 0.9, radius * 0.14), DARK);
  g.add(tyre, rim, spoke);
  return g;
}

/**
 * A body seen from the side – an outline of (z, y) points – made solid
 * across the vehicle, `width` wide.  (The outline is a shape in its own
 * plane, pushed out along its third axis: turned, that axis runs across.)
 */
function sideSolid(outline: Array<[number, number]>, width: number, material: THREE.Material): THREE.Mesh {
  const s = new THREE.Shape();
  outline.forEach(([z, y], i) => (i === 0 ? s.moveTo(z, y) : s.lineTo(z, y)));
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: width, bevelEnabled: false });
  g.rotateY(-Math.PI / 2);
  g.translate(width / 2, 0, 0);
  const m = new THREE.Mesh(g, material);
  m.castShadow = true;
  return m;
}

/** A flat picture or pane: `w` × `h`, its middle at (x, y, z), facing along +x, −x, +z or −z. */
function plate(w: number, h: number, x: number, y: number, z: number, facing: 'x+' | 'x-' | 'z+' | 'z-', material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  m.position.set(x, y, z);
  // (a plane faces +z: turned to face its way – facing ±x its +u runs towards −z on the right side, +z on the left)
  m.rotation.y = facing === 'z+' ? 0 : facing === 'z-' ? Math.PI : facing === 'x+' ? Math.PI / 2 : -Math.PI / 2;
  return m;
}

function canvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d') as CanvasRenderingContext2D };
}

function texture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const FONT = '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", "Noto Sans", "DejaVu Sans", sans-serif';

/** Write a word, as large as fits the box (x, y the middle; w × h at most), in one colour. */
function word(g: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, h: number, colour: string): void {
  let size = h;
  g.font = `800 ${size}px ${FONT}`;
  const tw = g.measureText(text).width;
  if (tw > w) {
    size *= w / tw;
    g.font = `800 ${size}px ${FONT}`;
  }
  g.fillStyle = colour;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x, y);
}

const cache = new Map<string, THREE.Texture>();
function cached(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = cache.get(key);
  if (!t) cache.set(key, (t = make()));
  return t;
}

/** The soft round glow of a lamp that is lit (white: the sprite gives it its colour). */
function glow(): THREE.Texture {
  return cached('glow', () => {
    const { c, g } = canvas(64, 64);
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.2, 'rgba(255,255,255,0.7)');
    r.addColorStop(0.5, 'rgba(255,255,255,0.16)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  });
}

/** A band of colour with a word on it in white (the doors of the police car and of the doctor's car). */
function bandTexture(text: string, colour: string): THREE.Texture {
  return cached(`band:${text}`, () => {
    const { c, g } = canvas(1024, 160);
    g.fillStyle = colour;
    g.fillRect(0, 0, 1024, 160);
    // (a thin light line along its top edge, as the reflecting strips do)
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(0, 0, 1024, 10);
    word(g, text, 512, 88, 860, 112, '#ffffff');
    return texture(c);
  });
}

/**
 * The side of the ambulance's box: white, the fluorescent red band with the
 * word over it, a frosted window, the blue star of life.  `frontRight`: the
 * front of the vehicle is at the right of the picture (its right side).
 */
function ambulanceSide(frontRight: boolean): THREE.Texture {
  return cached(`rtw:${frontRight}`, () => {
    const { c, g } = canvas(1024, 464);
    g.fillStyle = '#f2f2ee';
    g.fillRect(0, 0, 1024, 464);
    const x = (u: number, w: number): number => (frontRight ? 1024 - u - w : u);
    // the frosted window towards the front, a narrow one at the back
    g.fillStyle = '#c9d3d8';
    g.fillRect(x(40, 300), 56, 300, 120);
    g.fillRect(x(840, 120), 56, 120, 120);
    // the band, and a thin one lower down
    g.fillStyle = SIGNAL_RED;
    g.fillRect(0, 250, 1024, 62);
    g.fillRect(0, 380, 1024, 22);
    word(g, 'RETTUNGSDIENST', 512, 222, 760, 46, SIGNAL_RED);
    // the star of life
    const sx = frontRight ? 1024 - 470 - 70 : 470 + 70;
    g.save();
    g.translate(sx, 110);
    g.fillStyle = '#1f4fa8';
    for (let k = 0; k < 3; k++) {
      g.rotate(Math.PI / 3);
      g.fillRect(-18, -62, 36, 124);
    }
    g.fillStyle = '#ffffff';
    g.fillRect(-3, -44, 6, 88);
    g.restore();
    return texture(c);
  });
}

/** The back of a box body: two doors with windows (or a roller shutter), the red and white warning stripes below. */
function rearTexture(shutter: boolean): THREE.Texture {
  return cached(`rear:${shutter}`, () => {
    const { c, g } = canvas(512, 512);
    g.fillStyle = shutter ? '#b3201c' : '#f2f2ee';
    g.fillRect(0, 0, 512, 512);
    if (shutter) {
      g.fillStyle = '#aeb4ba';
      g.fillRect(40, 30, 432, 330);
      g.fillStyle = '#8d949b';
      for (let y = 40; y < 360; y += 16) g.fillRect(40, y, 432, 4);
    } else {
      g.fillStyle = '#c9d3d8';
      g.fillRect(40, 40, 190, 150);
      g.fillRect(282, 40, 190, 150);
      g.fillStyle = '#9aa1a8';
      g.fillRect(253, 0, 6, 512);
    }
    // warning stripes, slanting down to the outside on each half
    g.save();
    g.beginPath();
    g.rect(0, 392, 512, 120);
    g.clip();
    g.fillStyle = '#ffffff';
    g.fillRect(0, 392, 512, 120);
    g.fillStyle = shutter ? '#d01e1e' : SIGNAL_RED;
    for (let k = -6; k < 12; k++) {
      for (const half of [0, 1]) {
        const x0 = half === 0 ? k * 56 : 512 - k * 56;
        const dir = half === 0 ? 1 : -1;
        g.beginPath();
        g.moveTo(x0, 392);
        g.lineTo(x0 + dir * 28, 392);
        g.lineTo(x0 + dir * 28 - dir * 120, 512);
        g.lineTo(x0 - dir * 120, 512);
        g.closePath();
        g.fill();
      }
    }
    g.restore();
    return texture(c);
  });
}

/** The side of the fire engine's body: roller shutters between red posts, a white strip along the bottom. */
function fireSide(): THREE.Texture {
  return cached('hlf', () => {
    const { c, g } = canvas(1024, 400);
    g.fillStyle = '#b3201c';
    g.fillRect(0, 0, 1024, 400);
    for (let k = 0; k < 3; k++) {
      const x0 = 24 + k * 336;
      g.fillStyle = '#b8bec4';
      g.fillRect(x0, 24, 312, 300);
      g.fillStyle = '#939aa1';
      for (let y = 34; y < 324; y += 14) g.fillRect(x0, y, 312, 3);
      // the handle bar at the foot of the shutter
      g.fillStyle = '#5c6268';
      g.fillRect(x0, 300, 312, 14);
    }
    g.fillStyle = '#f4f4f0';
    g.fillRect(0, 346, 1024, 26);
    return texture(c);
  });
}

/** White letters on the red of the fire engine: on its doors and over its windscreen. */
function fireWord(): THREE.Texture {
  return cached('feuerwehr', () => {
    const { c, g } = canvas(1024, 192);
    g.fillStyle = '#b3201c';
    g.fillRect(0, 0, 1024, 192);
    word(g, 'FEUERWEHR', 512, 100, 940, 150, '#ffffff');
    return texture(c);
  });
}

/** The police's sign that rises from the roof: red lamps on black, "STOP" over "POLIZEI". */
function stopSignTexture(): THREE.Texture {
  return cached('stop', () => {
    const { c, g } = canvas(512, 160);
    g.fillStyle = '#060606';
    g.fillRect(0, 0, 512, 160);
    word(g, 'STOP', 256, 52, 440, 84, '#ff2412');
    word(g, 'POLIZEI', 256, 124, 440, 54, '#ff2412');
    // a grid of dark lines: the letters made of lamps
    g.fillStyle = '#060606';
    for (let x = 0; x < 512; x += 6) g.fillRect(x, 0, 2, 160);
    for (let y = 0; y < 160; y += 6) g.fillRect(0, y, 512, 2);
    return texture(c);
  });
}

/**
 * The flashing lamps of one vehicle.  The blue lamps belong to one of two
 * groups that give double flashes in turn (the left and the right half of a
 * light bar, …); the headlights flash in turn, left and right.  Lit, a lamp
 * shines brightly and has a glow round it that is seen from afar.
 */
class Flashers {
  // (bright as they are: not toned down with the rest of the picture)
  private readonly lens = [0, 1].map(() => new THREE.MeshBasicMaterial({ color: BLUE_OFF, toneMapped: false }));
  private readonly glowMat = [0, 1].map(() => new THREE.SpriteMaterial({ map: glow(), color: 0x4f86ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
  private readonly glows: THREE.Sprite[][] = [[], []];
  private readonly heads: THREE.Object3D[][] = [[], []];
  /** what is lit now (bits), to change the materials only when that changes */
  private state = -1;

  /** A blue lamp from x0…x1, y0…y1, z0…z1, flashing with group `k`, with a glow `size` metres across. */
  lamp(parent: THREE.Object3D, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, k: number, size: number): void {
    parent.add(box(x0, x1, y0, y1, z0, z1, this.lens[k], false));
    const s = new THREE.Sprite(this.glowMat[k]);
    s.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    s.scale.setScalar(size);
    s.visible = false;
    parent.add(s);
    this.glows[k].push(s);
  }

  /** What is shown over a headlight while it flashes (k: 0 the left one, 1 the right one). */
  head(parent: THREE.Object3D, flash: THREE.Object3D, k: number): void {
    flash.visible = false;
    parent.add(flash);
    this.heads[k].push(flash);
  }

  update(on: boolean, t: number): void {
    let st = 0;
    if (on) {
      // double flashes, the two groups in turn; the headlights in turn, the same rhythm
      const ph = ((t % 0.8) + 0.8) % 0.8;
      const a = ph < 0.07 || (ph >= 0.13 && ph < 0.2);
      const b = (ph >= 0.4 && ph < 0.47) || (ph >= 0.53 && ph < 0.6);
      st = 1 | (a ? 2 : 0) | (b ? 4 : 0) | (ph < 0.4 ? 8 : 16);
    }
    if (st === this.state) return;
    this.state = st;
    for (let k = 0; k < 2; k++) {
      const lit = (st & (k === 0 ? 2 : 4)) !== 0;
      this.lens[k].color.copy(lit ? BLUE_ON : BLUE_OFF);
      for (const s of this.glows[k]) s.visible = lit;
      const head = (st & (k === 0 ? 8 : 16)) !== 0;
      for (const h of this.heads[k]) h.visible = head;
    }
  }
}

/** A light bar across a roof, `width` wide, its foot at height y, its middle at z: two blue halves (left group 0, right 1), a clear lamp between them. */
function lightBar(parent: THREE.Object3D, f: Flashers, width: number, y: number, z: number, depth = 0.26): void {
  const h = 0.1;
  parent.add(box(-width / 2, width / 2, y, y + 0.035, z - depth / 2, z + depth / 2, BAR, false));
  const half = (width - 0.18) / 2;
  const y0 = y + 0.035;
  f.lamp(parent, -width / 2, -width / 2 + half, y0, y0 + h, z - depth / 2, z + depth / 2, 0, 1.1);
  f.lamp(parent, width / 2 - half, width / 2, y0, y0 + h, z - depth / 2, z + depth / 2, 1, 1.1);
  parent.add(box(-0.09, 0.09, y0, y0 + h * 0.8, z - depth / 2 + 0.02, z + depth / 2 - 0.02, CLEAR, false));
}

/**
 * A strip lying on the flank of a car between z0 and z1, following the body
 * across from `y0` up to `y1` (`xs`: how far out the body is at y0, at the
 * widest crease `ym` and at y1), on the right (side 1) or the left (−1).  Its
 * picture reads from the back to the front on the right, the other way on
 * the left – from outside, left to right either way.
 */
function flankStrip(xs: [number, number, number], y0: number, ym: number, y1: number, z0: number, z1: number, side: number, material: THREE.Material): THREE.Mesh {
  const ys = [y0, ym, y1];
  const vs = [0, (ym - y0) / (y1 - y0), 1];
  const pos: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (const [z, u] of [[z1, 0], [z0, 1]] as Array<[number, number]>) {
      pos.push(side * (xs[i] + 0.006), ys[i], z);
      uv.push(side > 0 ? u : 1 - u, vs[i]);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < 2; i++) {
    const a = i * 2;
    // (facing out: to the right on the right side; the other way round on the left)
    if (side > 0) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.renderOrder = 4;
  return m;
}

/** the patrol car: an estate; the doctor's car: a taller one, a little bigger */
const POLICE_DIMS: CarDims = { ...COMPACT_DIMS, length: 4.75, width: 1.84, height: 1.5, wheelbase: 2.8, track: 1.58, wheelRadius: 0.33, tyreWidth: 0.225, frontOverhang: 0.93, tail: 1 };
const DOCTOR_DIMS: CarDims = { ...COMPACT_DIMS, length: 4.85, width: 1.9, height: 1.66, wheelbase: 2.85, track: 1.62, wheelRadius: 0.35, tyreWidth: 0.235, frontOverhang: 0.95, tail: 1 };

/** One emergency vehicle as it is seen. */
export class EmergencyModel {
  /** placed where the vehicle is: the ground below the middle of its length */
  readonly group = new THREE.Group();
  /** EM */
  readonly kind: number;
  private readonly flash = new Flashers();
  /** the car body of the police car and the doctor's car (the others are built here of boxes) */
  private car: CarExterior | null = null;
  private readonly wheels: THREE.Object3D[] = [];
  private wheelRadius = 0.33;
  private readonly brakes: THREE.Mesh[] = [];
  private readonly blinkers: Array<{ mesh: THREE.Mesh; side: number }> = [];
  /** the police's "STOP POLIZEI" sign on the roof (raised while shown) */
  private sign: THREE.Object3D | null = null;

  constructor(kind: number) {
    this.kind = kind;
    this.group.name = ['police car', 'ambulance', 'fire engine', "emergency doctor's car"][kind] ?? 'emergency vehicle';
    if (kind === EM.AMBULANCE) this.buildAmbulance();
    else if (kind === EM.FIRE) this.buildFireEngine();
    else this.buildCar(kind === EM.DOCTOR);
  }

  /** The blue lights – and the headlights flashing in turn – on or off; `time` (s) sets where they are in their rhythm. */
  setLights(on: boolean, time: number): void {
    this.flash.update(on, time);
  }

  /** The police car's "STOP POLIZEI" sign raised on the roof, or folded away. */
  setSign(on: boolean): void {
    if (this.sign) this.sign.visible = on;
  }

  /** The wheels turned by `spin` (rolled spin × 0.31 m, as the traffic counts it), the brake lamps, the indicators as they blink now. */
  setMotion(spin: number, braking: boolean, left: boolean, right: boolean, steer = 0): void {
    if (this.car) {
      const r = this.car.dims.wheelRadius;
      const a = (spin * 0.31) / r;
      this.car.setWheels([steer, steer, 0, 0], [a, a, a, a], [r, r, r, r]);
      this.car.setLamps({ low: true, high: false, brake: braking, reverse: false, left, right });
      return;
    }
    const a = (spin * 0.31) / this.wheelRadius;
    // (the front two steered: + to the right, as the car models take it)
    this.wheels.forEach((w, i) => w.rotation.set(-a, i < 2 ? -steer : 0, 0, 'YXZ'));
    for (const b of this.brakes) b.material = braking ? STOP : TAIL;
    for (const k of this.blinkers) k.mesh.material = (k.side < 0 ? left : right) ? AMBER : AMBER_OFF;
  }

  /**
   * The police car (silver, a blue band along the doors with POLIZEI on it)
   * or the doctor's car (white, a red band, NOTARZT): a car body with a light
   * bar on the roof, blue flashers in the grille.
   */
  private buildCar(doctor: boolean): void {
    const dims = doctor ? DOCTOR_DIMS : POLICE_DIMS;
    const text = doctor ? 'NOTARZT' : 'POLIZEI';
    const colour = doctor ? SIGNAL_RED : POLICE_BLUE;
    const ext = new CarExterior(doctor ? 0xf2f2ee : 0xc9ced3, { dims, lettering: text });
    this.car = ext;
    const sh = ext.shell;
    const body = ext.group;
    // (the car is built around the middle of its wheelbase: moved to the middle of its length)
    body.position.z = -(sh.zFront + sh.zRear) / 2;
    this.group.add(body);
    // the word on the bumpers in the colour of the livery
    body.traverse((o) => {
      if (o instanceof THREE.Mesh && o.name.startsWith('lettering')) (o.material as THREE.MeshLambertMaterial).color.set(colour);
    });
    // the band along the doors, between the wheel arches
    const hw = sh.halfWidth;
    const z0 = sh.zAxleF + dims.wheelRadius + 0.14;
    const z1 = sh.zAxleR - dims.wheelRadius - 0.14;
    const band = new THREE.MeshLambertMaterial({ map: bandTexture(text, colour), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const ym = 0.63;
    const y0 = 0.46;
    const y1 = Math.min(sh.beltY - 0.06, 0.82);
    // (how far out the flank is: the widest crease at ym, a little less above and below)
    const out = (y: number): number => (y < ym ? hw * (0.985 + (0.015 * (y - 0.33)) / (ym - 0.33)) : hw * (1 - (0.025 * (y - ym)) / Math.max(0.05, sh.beltY - ym)));
    for (const side of [-1, 1]) body.add(flankStrip([out(y0), out(ym), out(y1)], y0, ym, y1, z0, z1, side, band));
    // the light bar on the roof, a little behind the top of the windscreen
    const barZ = sh.zRoofFront + 0.32;
    lightBar(body, this.flash, 1.12, sh.roofY - 0.025, barZ);
    // blue flashers in the grille, low on the nose
    for (const side of [-1, 1]) this.flash.lamp(body, side * 0.3 - 0.075, side * 0.3 + 0.075, 0.42, 0.48, sh.zFront - 0.02, sh.zFront + 0.01, side < 0 ? 0 : 1, 0.55);
    // the headlights flashing in turn: a bright cover over each
    for (const side of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.37, 0.115, 0.06);
      g.applyMatrix4(new THREE.Matrix4().makeRotationY(side * -0.35));
      g.translate(side * hw * 0.62, 0.635, sh.zFront + 0.11);
      this.flash.head(body, new THREE.Mesh(g, FLASH), side < 0 ? 0 : 1);
    }
    if (doctor) return;
    // the sign that rises behind the light bar: "STOP POLIZEI" to the traffic behind
    const sign = new THREE.Group();
    sign.add(box(-0.47, 0.47, 0, 0.3, -0.025, 0.015, BAR, false));
    const face = plate(0.9, 0.27, 0, 0.15, 0.017, 'z+', new THREE.MeshBasicMaterial({ map: stopSignTexture(), toneMapped: false }));
    sign.add(face);
    sign.position.set(0, sh.roofY + 0.06, barZ + 0.24);
    sign.visible = false;
    body.add(sign);
    this.sign = sign;
  }

  /**
   * The ambulance: a van's cab with a box body behind it, white with the
   * fluorescent red band; blue lamps at the corners of the box, in the grille,
   * and a light bar on the cab.
   */
  private buildAmbulance(): void {
    const len = 6.95;
    const wb = 3.66;
    const zf = -(wb / 2 + 1.0);
    const zr = zf + len;
    const g = new THREE.Group();
    g.position.z = -(zf + zr) / 2;
    this.group.add(g);
    const cw = 2.02;
    const zBox = zf + 2.0;
    // the cab: bonnet, sloping windscreen, roof
    g.add(sideSolid([[zf, 0.42], [zf, 0.98], [zf + 0.22, 1.12], [zf + 0.85, 1.2], [zf + 1.45, 2.22], [zBox + 0.05, 2.28], [zBox + 0.05, 0.42]], cw, WHITE));
    // its windscreen and side windows, the grille, the bumper
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(cw - 0.16, 1.08), GLASS);
    const a = new THREE.Vector3(0, 1.26, zf + 0.89);
    const b = new THREE.Vector3(0, 2.16, zf + 1.42);
    screen.position.copy(a).add(b).multiplyScalar(0.5);
    // (facing forwards and up: away from the slope of the cab)
    const n = new THREE.Vector3(0, b.z - a.z, -(b.y - a.y)).normalize();
    screen.position.addScaledVector(n, 0.012);
    screen.lookAt(screen.position.clone().add(n));
    g.add(screen);
    for (const side of [-1, 1]) g.add(plate(0.52, 0.72, side * (cw / 2 + 0.006), 1.72, zf + 1.68, side > 0 ? 'x+' : 'x-', GLASS));
    g.add(plate(1.1, 0.3, 0, 0.8, zf - 0.006, 'z-', DARK));
    g.add(box(-cw / 2 - 0.02, cw / 2 + 0.02, 0.3, 0.56, zf - 0.06, zf + 0.25, DARK));
    for (const side of [-1, 1]) {
      g.add(box(side * 0.74 - 0.16, side * 0.74 + 0.16, 0.8, 0.94, zf - 0.03, zf + 0.01, HEAD, false));
      // (the headlights flashing in turn: drawn a little in front of them)
      const flash = box(side * 0.74 - 0.17, side * 0.74 + 0.17, 0.795, 0.945, zf - 0.04, zf + 0.005, FLASH, false);
      this.flash.head(g, flash, side < 0 ? 0 : 1);
      const ind = box(side * 0.95 - 0.04, side * 0.95 + 0.04, 0.82, 0.92, zf - 0.03, zf + 0.01, AMBER_OFF, false);
      this.blinkers.push({ mesh: ind, side });
      g.add(ind);
      // the mirror on its arm
      g.add(box(side * (cw / 2) - 0.02, side * (cw / 2 + 0.24), 1.86, 1.9, zf + 1.3, zf + 1.34, DARK, false));
      g.add(box(side * (cw / 2 + 0.2) - 0.05, side * (cw / 2 + 0.2) + 0.05, 1.62, 1.98, zf + 1.28, zf + 1.36, DARK, false));
      // blue flashers in the grille
      this.flash.lamp(g, side * 0.36 - 0.08, side * 0.36 + 0.08, 0.66, 0.74, zf - 0.03, zf + 0.01, side < 0 ? 0 : 1, 0.6);
    }
    // the box: white, the livery on its sides, doors at the back
    const bw = 2.3;
    g.add(box(-bw / 2, bw / 2, 0.62, 2.88, zBox, zr, WHITE));
    for (const side of [-1, 1]) {
      const m = new THREE.MeshLambertMaterial({ map: ambulanceSide(side > 0) });
      g.add(plate(zr - zBox - 0.1, 2.06, side * (bw / 2 + 0.006), 1.72, (zBox + zr) / 2, side > 0 ? 'x+' : 'x-', m));
    }
    g.add(plate(bw - 0.12, 2.1, 0, 1.72, zr + 0.006, 'z+', new THREE.MeshLambertMaterial({ map: rearTexture(false) })));
    g.add(box(-bw / 2, bw / 2, 0.4, 0.62, zr - 0.25, zr + 0.06, DARK));
    // lamps at the back
    for (const side of [-1, 1]) {
      const stop = box(side * 1.02 - 0.1, side * 1.02 + 0.1, 0.72, 1.02, zr + 0.006, zr + 0.03, TAIL, false);
      this.brakes.push(stop);
      g.add(stop);
      const ind = box(side * 1.02 - 0.1, side * 1.02 + 0.1, 1.04, 1.16, zr + 0.006, zr + 0.03, AMBER_OFF, false);
      this.blinkers.push({ mesh: ind, side });
      g.add(ind);
      // blue lamps at the four upper corners of the box (seen from the front, the side and the back)
      const [x0, x1] = across(side, bw / 2 - 0.13, bw / 2 + 0.05);
      this.flash.lamp(g, x0, x1, 2.7, 2.86, zBox - 0.05, zBox + 0.2, side < 0 ? 0 : 1, 0.95);
      this.flash.lamp(g, x0, x1, 2.7, 2.86, zr - 0.2, zr + 0.05, side < 0 ? 0 : 1, 0.95);
    }
    // a low light bar on the cab, in front of the box
    lightBar(g, this.flash, 1.5, 2.25, zf + 1.78, 0.24);
    this.addWheels(g, 0.36, wb, 1.72, 0.24, 0.42);
  }

  /**
   * The fire engine: a crew cab in front of a body with roller shutters,
   * red with white strips, a ladder on the roof; a light bar on the cab,
   * blue lamps at the back corners and in the bumper.
   */
  private buildFireEngine(): void {
    const len = 8.6;
    const wb = 4.2;
    const zf = -(wb / 2 + 1.45);
    const zr = zf + len;
    const g = new THREE.Group();
    g.position.z = -(zf + zr) / 2;
    this.group.add(g);
    const w = 2.5;
    const zBody = zf + 2.8;
    // the cab, nearly upright, the crew's seats behind the driver's
    g.add(sideSolid([[zf, 0.72], [zf, 1.92], [zf + 0.16, 2.96], [zf + 0.3, 3.04], [zf + 2.75, 3.04], [zf + 2.75, 0.72]], w, FIRE_RED));
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.3, 0.86), GLASS);
    const a = new THREE.Vector3(0, 1.98, zf + 0.01);
    const b = new THREE.Vector3(0, 2.86, zf + 0.15);
    screen.position.copy(a).add(b).multiplyScalar(0.5);
    const n = new THREE.Vector3(0, b.z - a.z, -(b.y - a.y)).normalize();
    screen.position.addScaledVector(n, 0.012);
    screen.lookAt(screen.position.clone().add(n));
    g.add(screen);
    const word = new THREE.MeshLambertMaterial({ map: fireWord() });
    g.add(plate(1.5, 0.28, 0, 1.68, zf - 0.008, 'z-', word));
    for (const side of [-1, 1]) {
      const f = side > 0 ? 'x+' : 'x-';
      // the windows: the driver's and the crew's
      g.add(plate(0.86, 0.78, side * (w / 2 + 0.006), 2.42, zf + 0.78, f, GLASS));
      g.add(plate(1.0, 0.72, side * (w / 2 + 0.006), 2.45, zf + 2.05, f, GLASS));
      g.add(plate(1.0, 0.19, side * (w / 2 + 0.006), 1.78, zf + 0.78, f, word));
      // the steps up to the doors, the mirrors
      const [s0, s1] = across(side, w / 2 - 0.1, w / 2 + 0.12);
      g.add(box(s0, s1, 0.5, 0.56, zf + 0.35, zf + 2.55, FRAME));
      g.add(box(side * (w / 2 + 0.1) - 0.06, side * (w / 2 + 0.1) + 0.06, 2.0, 2.5, zf + 0.1, zf + 0.18, DARK, false));
      // headlights (and their flashing), indicators, blue flashers in the bumper
      g.add(box(side * 0.92 - 0.16, side * 0.92 + 0.16, 1.05, 1.22, zf - 0.03, zf + 0.02, HEAD, false));
      this.flash.head(g, box(side * 0.92 - 0.17, side * 0.92 + 0.17, 1.045, 1.225, zf - 0.04, zf + 0.01, FLASH, false), side < 0 ? 0 : 1);
      const ind = box(side * 1.14 - 0.05, side * 1.14 + 0.05, 1.06, 1.2, zf - 0.03, zf + 0.02, AMBER_OFF, false);
      this.blinkers.push({ mesh: ind, side });
      g.add(ind);
      this.flash.lamp(g, side * 0.42 - 0.09, side * 0.42 + 0.09, 0.66, 0.76, zf - 0.11, zf - 0.07, side < 0 ? 0 : 1, 0.65);
    }
    g.add(box(-w / 2 - 0.02, w / 2 + 0.02, 0.52, 0.9, zf - 0.08, zf + 0.25, DARK));
    // the body with its shutters, the ladder on the roof
    g.add(box(-w / 2, w / 2, 0.85, 3.22, zBody, zr, FIRE_RED));
    const shutters = new THREE.MeshLambertMaterial({ map: fireSide() });
    for (const side of [-1, 1]) g.add(plate(zr - zBody - 0.12, 2.3, side * (w / 2 + 0.006), 2.0, (zBody + zr) / 2, side > 0 ? 'x+' : 'x-', shutters));
    g.add(plate(w - 0.1, 2.3, 0, 2.0, zr + 0.006, 'z+', new THREE.MeshLambertMaterial({ map: rearTexture(true) })));
    for (const x of [-0.26, 0.26]) g.add(box(x - 0.03, x + 0.03, 3.26, 3.34, zBody + 0.3, zr - 0.2, STEEL, false));
    for (let z = zBody + 0.45; z < zr - 0.3; z += 0.32) g.add(box(-0.26, 0.26, 3.28, 3.31, z - 0.015, z + 0.015, STEEL, false));
    g.add(box(-w / 2 + 0.1, w / 2 - 0.1, 0.45, 0.85, zr - 0.3, zr + 0.05, DARK));
    for (const side of [-1, 1]) {
      const stop = box(side * 1.08 - 0.1, side * 1.08 + 0.1, 0.95, 1.25, zr + 0.006, zr + 0.03, TAIL, false);
      this.brakes.push(stop);
      g.add(stop);
      const ind = box(side * 1.08 - 0.1, side * 1.08 + 0.1, 1.27, 1.39, zr + 0.006, zr + 0.03, AMBER_OFF, false);
      this.blinkers.push({ mesh: ind, side });
      g.add(ind);
      // blue lamps at the back corners, high up
      const [x0, x1] = across(side, w / 2 - 0.16, w / 2 + 0.04);
      this.flash.lamp(g, x0, x1, 3.1, 3.3, zr - 0.2, zr + 0.05, side < 0 ? 0 : 1, 1.0);
    }
    lightBar(g, this.flash, 1.75, 3.04, zf + 0.5, 0.28);
    this.addWheels(g, 0.52, wb, 2.06, 0.32, 0.6);
  }

  /** The wheels of a vehicle built of boxes: single at the front, twin at the back. */
  private addWheels(g: THREE.Group, r: number, wb: number, track: number, front: number, rear: number): void {
    this.wheelRadius = r;
    for (const [x, z, wd] of [
      [-track / 2, -wb / 2, front],
      [track / 2, -wb / 2, front],
      [-track / 2 + 0.04, wb / 2, rear],
      [track / 2 - 0.04, wb / 2, rear],
    ]) {
      const wh = wheel(r, wd);
      wh.position.set(x, r, z);
      this.wheels.push(wh);
      g.add(wh);
    }
  }
}

/** A police patrol car as seen – for whatever else shows one (a road closure: lights on, the STOP sign raised). */
export function buildPoliceCar(): EmergencyModel {
  return new EmergencyModel(EM.POLICE);
}

/** The emergency vehicles among the traffic: each drawn where it is, its lights as its style says. */
export class EmergencyFleet {
  readonly group = new THREE.Group();
  private readonly shown = new Map<number, EmergencyModel>();
  private readonly pool: EmergencyModel[][] = [[], [], [], []];
  private readonly seen = new Set<number>();

  constructor() {
    this.group.name = 'emergency vehicles';
  }

  update(cars: readonly TrafficCar[], time: number): void {
    const blinkOn = Math.floor(time * 3) % 2 === 0;
    const seen = this.seen;
    seen.clear();
    for (const c of cars) {
      const kind = emKind(c.style);
      if (kind < 0) continue;
      seen.add(c.id);
      let m = this.shown.get(c.id);
      if (m && m.kind !== kind) {
        this.release(c.id, m);
        m = undefined;
      }
      if (!m) {
        m = this.pool[kind].pop() ?? new EmergencyModel(kind);
        m.setSign(false);
        this.shown.set(c.id, m);
        this.group.add(m.group);
      }
      // (where it is drawn: eased through the corners of its way – sim/smoothpose.ts)
      const d = c.drawn ?? c;
      m.group.position.set(d.x, c.y, d.z);
      m.group.rotation.set(c.pitch, d.yaw, 0, 'YXZ');
      m.setMotion(c.wheelSpin, c.braking, blinkOn && c.blinker < 0, blinkOn && c.blinker > 0, c.drawn?.steer ?? 0);
      // (each in a rhythm of its own)
      m.setLights(emLit(c.style), time + (c.id % 7) * 0.13);
    }
    for (const [id, m] of this.shown) if (!seen.has(id)) this.release(id, m);
  }

  private release(id: number, m: EmergencyModel): void {
    this.group.remove(m.group);
    this.pool[m.kind].push(m);
    this.shown.delete(id);
  }
}
