// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The cars you see: body shell, wheels, lights – and for the player's car the
 * complete cockpit (dashboard, instruments, steering wheel, gear lever,
 * handbrake, pedals, seats) plus the three mirrors.
 *
 * Car frame: origin on the ground below the middle of the wheelbase,
 * +X right, +Y up, -Z forward.  Left-hand drive.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COMPACT_DIMS, buildCarShell, buildWheel } from './carBody.ts';
import type { CarDims, CarShell } from './carBody.ts';
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

function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')));
  g.translate(x, y, z);
  g.deleteAttribute('uv');
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = parts.map((p) => {
    const g = p.index ? p.toNonIndexed() : p;
    g.deleteAttribute('uv');
    return g;
  });
  const g = mergeGeometries(clean, false)!;
  g.computeVertexNormals();
  return g;
}

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

const SHELL_CACHE = new Map<string, CarShell>();
function shellFor(d: CarDims): CarShell {
  const key = JSON.stringify(d);
  let s = SHELL_CACHE.get(key);
  if (!s) SHELL_CACHE.set(key, (s = buildCarShell(d)));
  return s;
}

const MAT = {
  trim: new THREE.MeshLambertMaterial({ color: 0x17191b }),
  pillar: new THREE.MeshLambertMaterial({ color: 0x565b62, emissive: 0x2c3035 }),
  tyre: new THREE.MeshLambertMaterial({ color: 0x151617 }),
  rim: new THREE.MeshPhongMaterial({ color: 0xb9bdc2, shininess: 60, specular: 0x555555 }),
  glassDark: new THREE.MeshPhongMaterial({ color: 0x0c1418, shininess: 140, specular: 0x9fb4c4 }),
  lampOff: new THREE.MeshLambertMaterial({ color: 0x3a2d2a }),
};

/** Body, wheels and lamps – everything a car shows from outside. */
export class CarExterior {
  readonly group = new THREE.Group();
  readonly dims: CarDims;
  readonly shell: CarShell;
  readonly wheels: THREE.Group[] = [];
  private readonly wheelSpinners: THREE.Group[] = [];
  readonly paint: THREE.MeshPhongMaterial;
  readonly glass: THREE.Material;
  private readonly head: THREE.MeshBasicMaterial;
  private readonly tail: THREE.MeshBasicMaterial;
  private readonly reverse: THREE.MeshBasicMaterial;
  private readonly blinkL: THREE.MeshBasicMaterial;
  private readonly blinkR: THREE.MeshBasicMaterial;

  constructor(color: number, opts: { dims?: CarDims; plate?: string; seeThroughGlass?: boolean; roofSign?: boolean; noMirrorHousings?: boolean } = {}) {
    const d = (this.dims = opts.dims ?? COMPACT_DIMS);
    const sh = (this.shell = shellFor(d));
    this.paint = new THREE.MeshPhongMaterial({ color, shininess: 90, specular: 0x777777 });
    this.glass = opts.seeThroughGlass
      ? new THREE.MeshPhongMaterial({ color: 0x9fc0d0, transparent: true, opacity: 0.16, shininess: 160, specular: 0xffffff, depthWrite: false })
      : MAT.glassDark;
    const g = this.group;
    const body = new THREE.Mesh(sh.paint, this.paint);
    body.castShadow = true;
    g.add(body);
    const glass = new THREE.Mesh(sh.glass, this.glass);
    glass.renderOrder = 5;
    g.add(glass, new THREE.Mesh(sh.trim, MAT.trim), new THREE.Mesh(sh.pillars, MAT.pillar));

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
    for (const [geo, mat] of lamps) g.add(new THREE.Mesh(geo, mat));
    // grille and number plates
    g.add(new THREE.Mesh(box(0.86, 0.14, 0.04, 0, 0.5, sh.zFront + 0.05), MAT.trim));
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
    if (opts.roofSign) {
      const tex = roofSignTexture();
      const sm = new THREE.MeshBasicMaterial({ map: tex });
      const base = new THREE.Mesh(box(0.86, 0.16, 0.2, 0, sh.roofY + 0.085, 0.25), new THREE.MeshLambertMaterial({ color: 0xf2f2ee }));
      const f = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.15), sm);
      f.position.set(0, sh.roofY + 0.085, 0.25 - 0.101);
      f.rotation.y = Math.PI;
      const r = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.15), sm);
      r.position.set(0, sh.roofY + 0.085, 0.25 + 0.101);
      g.add(base, f, r);
    }
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

/** The driving-school car with its interior and mirrors. */
export class PlayerCar {
  readonly root = new THREE.Group();
  readonly exterior: CarExterior;
  readonly cockpit = new THREE.Group();
  /** driver's eye point in car coordinates (seat position) */
  readonly eye = new THREE.Vector3(-0.36, 1.2, 0.2);
  readonly mirrors: Mirror[] = [];
  private readonly panel = new InstrumentPanel();
  private readonly steering = new THREE.Group();
  private readonly lever = new THREE.Group();
  private readonly handbrake = new THREE.Group();
  private readonly pedals: THREE.Group[] = [];
  private readonly stalk = new THREE.Group();
  private leverX = 0;
  private leverZ = 0;
  private gate = 0;

  constructor() {
    this.exterior = new CarExterior(0xc9cdd2, { plate: 'KS FS 2026', seeThroughGlass: true, roofSign: true, noMirrorHousings: true });
    const sh = this.exterior.shell;
    this.root.add(this.exterior.group, this.cockpit);
    const hw = sh.halfWidth;
    const belt = sh.beltY;
    const zc = sh.zCowl;

    // The cabin gets little direct light; a self-lit share keeps it readable
    // instead of a black hole (what your eyes do when they adapt).
    const plastic = new THREE.MeshLambertMaterial({ color: 0x464b51, emissive: 0x2a2d31 });
    const plasticLight = new THREE.MeshLambertMaterial({ color: 0x62686f, emissive: 0x34383d });
    const fabric = new THREE.MeshLambertMaterial({ color: 0x525966, emissive: 0x2a2f37 });
    const metal = new THREE.MeshPhongMaterial({ color: 0x9a9fa5, shininess: 50, emissive: 0x202224 });
    const lining = new THREE.Mesh(sh.lining, new THREE.MeshLambertMaterial({ color: 0x6a7079, emissive: 0x3a3f46 }));
    this.cockpit.add(lining);

    // ---- dashboard: side profile extruded across the car -------------------
    const prof = new THREE.Shape();
    prof.moveTo(zc + 0.02, belt + 0.0);
    prof.lineTo(zc + 0.3, belt + 0.075);
    prof.lineTo(zc + 0.44, belt + 0.06);
    prof.lineTo(zc + 0.49, belt - 0.06);
    prof.lineTo(zc + 0.44, belt - 0.36);
    prof.lineTo(zc + 0.2, belt - 0.5);
    prof.lineTo(zc + 0.02, belt - 0.5);
    prof.closePath();
    const dashW = (hw - 0.04) * 2;
    const dash = new THREE.ExtrudeGeometry(prof, { depth: dashW, bevelEnabled: false });
    // shape x → car z, extrusion → car x
    dash.rotateY(-Math.PI / 2);
    dash.translate(dashW / 2, 0, 0);
    dash.deleteAttribute('uv');
    const dx = this.eye.x;
    const statics: THREE.BufferGeometry[] = [dash.index ? dash.toNonIndexed() : dash];
    // instrument binnacle and centre stack
    statics.push(box(0.4, 0.05, 0.2, dx, belt + 0.145, zc + 0.37, 0.1));
    statics.push(box(0.03, 0.13, 0.2, dx - 0.2, belt + 0.09, zc + 0.37));
    statics.push(box(0.03, 0.13, 0.2, dx + 0.2, belt + 0.09, zc + 0.37));
    statics.push(box(0.26, 0.4, 0.09, 0, belt - 0.27, zc + 0.47, -0.12));
    // tunnel console and armrest
    statics.push(box(0.2, 0.3, 1.0, 0, 0.37, 0.0));
    statics.push(box(0.18, 0.09, 0.32, 0, 0.56, 0.46));
    // steering column shroud
    statics.push(box(0.11, 0.09, 0.22, dx, belt - 0.04, zc + 0.5, -0.42));
    this.cockpit.add(new THREE.Mesh(merge(statics), plastic));

    // seats
    const seat = (x: number): THREE.BufferGeometry[] => [
      box(0.5, 0.13, 0.5, x, 0.36, 0.3, 0.06),
      box(0.48, 0.62, 0.11, x, 0.72, 0.58, 0.28),
      box(0.25, 0.17, 0.09, x, 1.13, 0.69, 0.2),
    ];
    const seats = [
      ...seat(-0.37),
      ...seat(0.37),
      box(1.28, 0.15, 0.5, 0, 0.39, 1.1, 0.05),
      box(1.28, 0.56, 0.11, 0, 0.72, 1.38, 0.32),
      box(0.24, 0.16, 0.08, -0.38, 1.08, 1.47, 0.2),
      box(0.24, 0.16, 0.08, 0.38, 1.08, 1.47, 0.2),
    ];
    this.cockpit.add(new THREE.Mesh(merge(seats), fabric));

    // instrument cluster
    const cluster = new THREE.Mesh(new THREE.PlaneGeometry(0.33, 0.11), new THREE.MeshBasicMaterial({ map: this.panel.texture, toneMapped: false }));
    cluster.position.set(dx, belt + 0.062, zc + 0.452);
    cluster.rotation.x = -0.24;
    this.cockpit.add(cluster);
    // centre screen (navigation is drawn on it by the HUD layer later)
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.21, 0.12), new THREE.MeshBasicMaterial({ color: 0x0c1014 }));
    screen.position.set(0, belt - 0.13, zc + 0.502);
    screen.rotation.x = -0.12;
    this.cockpit.add(screen);

    // ---- steering wheel ----------------------------------------------------
    const R = 0.185;
    const wheelParts: THREE.BufferGeometry[] = [];
    const rim = new THREE.TorusGeometry(R, 0.0165, 8, 40);
    rim.deleteAttribute('uv');
    wheelParts.push(rim.toNonIndexed());
    const hub = new THREE.CylinderGeometry(0.058, 0.064, 0.05, 16).rotateX(Math.PI / 2).translate(0, 0, -0.012);
    hub.deleteAttribute('uv');
    wheelParts.push(hub.toNonIndexed());
    wheelParts.push(box(R - 0.045, 0.036, 0.022, -(R + 0.045) / 2, 0.004, -0.004));
    wheelParts.push(box(R - 0.045, 0.036, 0.022, (R + 0.045) / 2, 0.004, -0.004));
    wheelParts.push(box(0.04, R - 0.05, 0.022, 0, -(R + 0.05) / 2, -0.004));
    const wheelMesh = new THREE.Mesh(merge(wheelParts), plasticLight);
    // top-centre marker so the wheel position reads at a glance
    const marker = new THREE.Mesh(box(0.012, 0.02, 0.036, 0, R, 0), new THREE.MeshBasicMaterial({ color: 0xd8dde2 }));
    this.steering.add(wheelMesh, marker);
    const column = new THREE.Group();
    column.position.set(dx, belt - 0.005, zc + 0.6);
    column.rotation.x = -0.42; // the wheel's axis tilts up towards the driver
    column.add(this.steering);
    // indicator stalk (left) and wiper stalk (right) do not turn with the wheel
    this.stalk.add(new THREE.Mesh(box(0.13, 0.016, 0.016, -0.135, 0, -0.07), plastic));
    column.add(this.stalk, new THREE.Mesh(box(0.13, 0.016, 0.016, 0.135, 0.01, -0.07), plastic));
    this.cockpit.add(column);

    // ---- gear lever, handbrake, pedals -------------------------------------
    this.lever.position.set(0, 0.5, -0.14);
    const boot = new THREE.CylinderGeometry(0.014, 0.05, 0.075, 10).translate(0, 0.045, 0);
    boot.deleteAttribute('uv');
    const shaft = new THREE.CylinderGeometry(0.0075, 0.0075, 0.13, 6).translate(0, 0.13, 0);
    shaft.deleteAttribute('uv');
    this.lever.add(new THREE.Mesh(merge([boot.toNonIndexed()]), plastic), new THREE.Mesh(merge([shaft.toNonIndexed()]), metal));
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.027, 12, 10), plasticLight);
    knob.position.y = 0.2;
    this.lever.add(knob);
    this.cockpit.add(this.lever);

    this.handbrake.position.set(0.075, 0.515, 0.28);
    this.handbrake.add(new THREE.Mesh(box(0.032, 0.03, 0.23, 0, 0.012, -0.115), plasticLight));
    this.cockpit.add(this.handbrake);

    const pedalX = [-0.55, -0.41, -0.25];
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Group();
      p.position.set(pedalX[i], 0.4, zc + 0.16);
      p.add(new THREE.Mesh(box(0.016, 0.2, 0.012, 0, -0.1, 0), metal), new THREE.Mesh(box(i === 2 ? 0.05 : 0.065, 0.075, 0.014, 0, -0.21, 0.004), plasticLight));
      p.rotation.x = -0.5;
      this.pedals.push(p);
      this.cockpit.add(p);
    }

    // ---- mirrors -----------------------------------------------------------
    const inner = new THREE.Vector3(0.02, sh.roofY - 0.175, sh.zRoofFront - 0.115);
    this.cockpit.add(new THREE.Mesh(box(0.02, 0.09, 0.02, inner.x, inner.y + 0.075, inner.z - 0.03), plastic));
    this.mirrors.push(
      new Mirror({
        name: 'inside',
        centre: inner,
        width: 0.245,
        height: 0.066,
        normal: mirrorNormal(inner, this.eye, new THREE.Vector3(0, -0.035, 1)),
        convex: 1,
        resolution: [512, 160],
      }),
    );
    for (const side of [-1, 1]) {
      // at the front corner of the door glass: there the left one is inside the
      // forward view on an ordinary screen (about 39° off the line of sight)
      const c = new THREE.Vector3(side * (hw + 0.1), belt + 0.06, sh.zCowl + 0.28);
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
    this.mirrors.forEach((m, i) => {
      this.cockpit.add(m.mesh, m.makeHousing(i === 0 ? 0.025 : 0.085, i === 0 ? plastic : this.exterior.paint));
    });
    // stalks that carry the door mirrors
    for (const side of [-1, 1]) this.cockpit.add(new THREE.Mesh(box(0.1, 0.03, 0.05, side * (hw + 0.03), belt + 0.03, sh.zCowl + 0.255), plastic));
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
    const k = Math.min(1, dt * 14);
    this.leverX += (tx - this.leverX) * k;
    this.leverZ += (tz - this.leverZ) * k;
    this.lever.rotation.z = -this.leverX * 0.17;
    this.lever.rotation.x = this.leverZ * 0.2;
    this.handbrake.rotation.x = s.handbrakeLever * 0.42;
    // pads hang towards the driver; pressing swings them forward
    this.pedals[0].rotation.x = -0.5 + s.clutch * 0.32;
    this.pedals[1].rotation.x = -0.5 + s.brake * 0.22;
    this.pedals[2].rotation.x = -0.5 + s.throttle * 0.28;
  }

  dispose(): void {
    for (const m of this.mirrors) m.dispose();
  }
}

export { COMPACT_DIMS };
