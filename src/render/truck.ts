// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The truck of the class-CE lessons and its centre-axle trailer: a two-axle
 * distribution truck with a box body, 8.2 m long, and a tandem trailer of
 * 7.9 m.  Simple shapes, generic livery – no real vehicle is reproduced.
 *
 * Both are built around the points the physics use: the truck around the
 * ground point below the middle of its wheelbase, the trailer around the
 * middle of its axle group (x right, y up, z back, the front towards -z).
 */
import * as THREE from 'three';
import { TANDEM_TRAILER } from '../sim/trailer.ts';
import { TRUCK, TRUCK_HITCH } from '../sim/vehicle/index.ts';
import type { CarVisualState } from './car.ts';
import { InstrumentPanel } from './instruments.ts';
import { Mirror } from './mirrors.ts';

export const WHITE = new THREE.MeshLambertMaterial({ color: 0xeef0ee });
export const CAB = new THREE.MeshLambertMaterial({ color: 0x1f5fa8 });
export const DARK = new THREE.MeshLambertMaterial({ color: 0x1b1d20 });
export const FRAME = new THREE.MeshLambertMaterial({ color: 0x33373c });
export const TYRE = new THREE.MeshLambertMaterial({ color: 0x141516 });
export const RIM = new THREE.MeshLambertMaterial({ color: 0xb4b8bc });
/** window glass: tinted, seen through from both sides */
export const GLASS = new THREE.MeshPhongMaterial({ color: 0x0c1418, shininess: 120, specular: 0x8fa4b4, transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false });
export const LAMP = new THREE.MeshBasicMaterial({ color: 0xfff3cf });
export const TAIL = new THREE.MeshBasicMaterial({ color: 0xb01410 });
export const AMBER = new THREE.MeshBasicMaterial({ color: 0xff9a1a });

export type Facing = 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';

/**
 * A flat rectangle looking along an axis.  `a` runs across it (x, or z for a
 * panel facing x), `b` up it (y, or z for a panel facing up or down), `at`
 * is where it stands on the axis it faces.
 */
export function panel(facing: Facing, a0: number, a1: number, b0: number, b1: number, at: number, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(a1 - a0), Math.abs(b1 - b0)), material);
  const a = (a0 + a1) / 2;
  const b = (b0 + b1) / 2;
  if (facing === 'z+' || facing === 'z-') {
    m.position.set(a, b, at);
    if (facing === 'z-') m.rotation.y = Math.PI;
  } else if (facing === 'x+' || facing === 'x-') {
    m.position.set(at, b, a);
    m.rotation.y = facing === 'x+' ? Math.PI / 2 : -Math.PI / 2;
  } else {
    m.position.set(a, at, b);
    m.rotation.x = facing === 'y+' ? -Math.PI / 2 : Math.PI / 2;
  }
  return m;
}

/** A box from x0…x1, y0…y1, z0…z1. */
export function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, material: THREE.Material, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), material);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.castShadow = shadow;
  return m;
}

/** A wheel (or a twin wheel) lying on the x axis, its middle at the origin. */
export function wheel(radius: number, width: number): THREE.Group {
  const g = new THREE.Group();
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 20), TYRE);
  tyre.rotation.z = Math.PI / 2;
  tyre.castShadow = true;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.58, radius * 0.58, width + 0.02, 12), RIM);
  rim.rotation.z = Math.PI / 2;
  g.add(tyre, rim);
  return g;
}

/** Large lettering on a plate: dark on white, readable from the chase camera. */
export function lettering(text: string, width: number, height: number): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = Math.round((1024 * height) / width);
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#eef0ee';
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = '#143e73';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  let size = canvas.height * 0.62;
  c.font = `800 ${size}px system-ui, "Segoe UI", Roboto, "Noto Sans", sans-serif`;
  const w = c.measureText(text).width;
  if (w > canvas.width * 0.92) {
    size *= (canvas.width * 0.92) / w;
    c.font = `800 ${size}px system-ui, "Segoe UI", Roboto, "Noto Sans", sans-serif`;
  }
  c.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshLambertMaterial({ map: tex }));
}

/** The plates with the lettering on both sides and on the rear doors of a box body. */
function letterBox(group: THREE.Group, text: string, hw: number, yMid: number, zMid: number, zRear: number, sideLen: number): void {
  for (const side of [-1, 1]) {
    const plate = lettering(text, sideLen, sideLen * 0.16);
    plate.position.set(side * (hw + 0.012), yMid, zMid);
    plate.rotation.y = (side * Math.PI) / 2;
    group.add(plate);
  }
  const rear = lettering(text, hw * 1.7, hw * 1.7 * 0.16);
  rear.position.set(0, yMid, zRear + 0.012);
  group.add(rear);
}

export const BRAND = 'maureranton.com';

export class PlayerTruck {
  readonly root = new THREE.Group();
  /** the trailer: a group of its own, placed in the world by the game */
  readonly trailer = new THREE.Group();
  /** the driver's eyes (truck coordinates) */
  readonly eye = new THREE.Vector3(-0.62, 2.42, -2.55);
  readonly mirrors: Mirror[] = [];
  private readonly wheels: THREE.Group[] = [];
  private readonly trailerWheels: THREE.Group[] = [];
  private readonly steering = new THREE.Group();
  private readonly brakeLamps: THREE.Mesh[] = [];
  private readonly indicators: Array<{ mesh: THREE.Mesh; side: number }> = [];
  private readonly leg: THREE.Mesh;
  private readonly cabin = new THREE.Group();
  private readonly panel = new InstrumentPanel();
  /** the inside of the cab's walls (seen only from within) and what is fitted in the cab */
  private readonly lining = new THREE.MeshLambertMaterial({ color: 0x565b63, side: THREE.BackSide });
  private readonly fittings = new THREE.MeshLambertMaterial({ color: 0x30343a });
  private readonly off = new THREE.MeshLambertMaterial({ color: 0x3a2d2a });

  constructor() {
    const s = TRUCK;
    const root = this.root;
    root.name = 'truck';
    const axle = s.wheelbase / 2;
    const hw = (s.width ?? 2.5) / 2;
    const front = -(axle + 1.4);
    const rear = axle + 2.1;

    // ---- chassis and bumper
    root.add(box(-0.45, 0.45, 0.62, 0.98, front + 0.3, rear - 0.1, FRAME));
    root.add(box(-hw + 0.03, hw - 0.03, 0.42, 0.95, front, front + 0.35, DARK)); // bumper
    for (const side of [-1, 1]) {
      root.add(box(side * hw - 0.34 * (side > 0 ? 1 : 0), side * hw + 0.34 * (side < 0 ? 1 : 0), 0.5, 0.92, axle - 1.9, axle - 0.75, FRAME)); // side guard
      root.add(box(side * (hw - 0.42) - 0.16, side * (hw - 0.42) + 0.16, 0.62, 0.84, front - 0.02, front + 0.02, LAMP, false));
    }

    // ---- the cab: a shell of panels with openings for the windows.  Each panel has two faces –
    // paint outside, lining inside – so that from the driver's seat only the lining is seen
    // (and can be made see-through) while mirrors and the camera outside see the paint.
    const cx = hw - 0.05;
    const cy0 = 0.95;
    const cy1 = 3.0;
    const cz0 = front + 0.02;
    const cz1 = front + 1.85;
    // windscreen and door windows
    const wy0 = 1.88;
    const wy1 = 2.86;
    const sy1 = 2.76;
    const sz0 = front + 0.12;
    const sz1 = front + 1.3;
    const pillar = 0.07;
    const cab = new THREE.Group();
    const wall = (facing: Facing, a0: number, a1: number, b0: number, b1: number, at: number): void => {
      const outer = panel(facing, a0, a1, b0, b1, at, CAB);
      outer.castShadow = true;
      cab.add(outer, panel(facing, a0, a1, b0, b1, at, this.lining));
    };
    // front: below and above the windscreen, a pillar at each side
    wall('z-', -cx, cx, cy0, wy0, cz0);
    wall('z-', -cx, cx, wy1, cy1, cz0);
    for (const side of [-1, 1]) wall('z-', side * cx, side * (cx - pillar), wy0, wy1, cz0);
    cab.add(panel('z-', -cx + pillar, cx - pillar, wy0, wy1, cz0 + 0.01, GLASS));
    cab.add(panel('z-', -0.85, 0.85, 1.05, 1.6, cz0 - 0.012, DARK)); // grille
    for (const side of [-1, 1]) {
      const f: Facing = side > 0 ? 'x+' : 'x-';
      wall(f, cz0, cz1, cy0, wy0, side * cx);
      wall(f, cz0, cz1, sy1, cy1, side * cx);
      wall(f, cz0, sz0, wy0, sy1, side * cx);
      wall(f, sz1, cz1, wy0, sy1, side * cx);
      cab.add(panel(f, sz0, sz1, wy0, sy1, side * (cx - 0.01), GLASS));
    }
    wall('z+', -cx, cx, cy0, cy1, cz1);
    wall('y+', -cx, cx, cz0, cz1, cy1);
    wall('y-', -cx, cx, cz0, cz1, cy0);
    root.add(cab);
    const bodyFront = front + 2.0;
    root.add(box(-hw, hw, 1.12, 3.6, bodyFront, rear, WHITE));
    root.add(box(-hw + 0.05, hw - 0.05, 0.5, 0.62, rear - 0.12, rear, FRAME)); // underrun bar
    letterBox(root, BRAND, hw, 2.55, (bodyFront + rear) / 2, rear, rear - bodyFront - 0.8);
    // tail lamps and indicators
    for (const side of [-1, 1]) {
      const stop = box(side * (hw - 0.3) - 0.14, side * (hw - 0.3) + 0.14, 0.78, 0.98, rear - 0.02, rear + 0.02, TAIL, false);
      this.brakeLamps.push(stop);
      root.add(stop);
      for (const z of [front - 0.02, rear + 0.02]) {
        const ind = box(side * (hw - 0.08) - 0.07, side * (hw - 0.08) + 0.07, 0.8, 0.96, z - 0.02, z + 0.02, this.off, false);
        this.indicators.push({ mesh: ind, side });
        root.add(ind);
      }
    }
    // the trailer coupling
    root.add(box(-0.12, 0.12, TRUCK_HITCH.height - 0.1, TRUCK_HITCH.height + 0.1, axle + TRUCK_HITCH.behindRearAxle - 0.15, axle + TRUCK_HITCH.behindRearAxle + 0.1, DARK));

    // ---- wheels: front single, rear twin
    const t = s.track / 2;
    for (const [x, z, w] of [
      [-t, -axle, 0.3],
      [t, -axle, 0.3],
      [-t + 0.08, axle, 0.6],
      [t - 0.08, axle, 0.6],
    ]) {
      const g = wheel(s.wheelRadius, w);
      g.position.set(x, s.wheelRadius, z);
      this.wheels.push(g);
      root.add(g);
    }

    // ---- inside the cab: dashboard, instruments, steering wheel, seats
    const cabin = this.cabin;
    const ex = this.eye.x;
    const fit = this.fittings;
    cabin.add(box(-cx + 0.02, cx - 0.02, 1.45, wy0 - 0.02, cz0 + 0.02, cz0 + 0.5, fit, false)); // dashboard
    // the instruments stand at the foot of the windscreen, where the driver sees them over the wheel
    cabin.add(box(ex - 0.33, ex + 0.33, wy0 - 0.02, wy0 + 0.2, cz0 + 0.06, cz0 + 0.24, fit, false));
    const dial = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.17), new THREE.MeshBasicMaterial({ map: this.panel.texture, toneMapped: false }));
    dial.position.set(ex, wy0 + 0.095, cz0 + 0.245);
    cabin.add(dial);
    // the big, flat steering wheel of a truck
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.022, 8, 28), fit);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.035, 0.02), fit);
    const spoke2 = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.23, 0.02), fit);
    spoke2.position.y = -0.115;
    this.steering.add(rim, spoke, spoke2);
    const column = new THREE.Group();
    column.position.set(ex, 1.93, cz0 + 0.7);
    column.rotation.x = -0.95; // nearly lying, as in a truck
    column.add(this.steering);
    cabin.add(column);
    for (const x of [ex, -ex]) {
      cabin.add(box(x - 0.26, x + 0.26, 1.3, 1.46, cz1 - 0.72, cz1 - 0.2, fit, false)); // seat
      cabin.add(box(x - 0.26, x + 0.26, 1.46, 2.32, cz1 - 0.3, cz1 - 0.16, fit, false)); // its back
    }
    root.add(cabin);

    // ---- mirrors: one large one at each door, showing the side of the body and of the trailer
    for (const side of [-1, 1]) {
      // (on arms ahead of the doors: the left one is in view when looking straight ahead)
      const c = new THREE.Vector3(side * (hw + 0.26), 2.42, front + 0.1);
      // the glass faces the bisector between the eye and the view to the rear along the body
      const toEye = this.eye.clone().sub(c).normalize();
      const back = new THREE.Vector3(side * 0.06, -0.05, 1).normalize();
      const normal = toEye.add(back).normalize();
      const mirror = new Mirror({ name: side < 0 ? 'left' : 'right', centre: c, width: 0.22, height: 0.4, normal, convex: side < 0 ? 1.35 : 1.7, resolution: [256, 448] });
      this.mirrors.push(mirror);
      root.add(mirror.mesh);
      // arm and housing
      // two arms, above and below the glass
      for (const y of [c.y + 0.235, c.y - 0.275]) root.add(box(side * hw - (side < 0 ? 0.3 : 0), side * hw + (side > 0 ? 0.3 : 0), y, y + 0.04, front + 0.04, front + 0.08, DARK, false));
      // the housing lies behind the glass and is turned with it (a box square to the truck would
      // stick out in front of the turned glass and fill the mirror picture)
      root.add(mirror.makeHousing(0.05, DARK, 0.02));
    }

    // ---- the trailer, around the middle of its axle group
    const tr = TANDEM_TRAILER;
    const tg = this.trailer;
    tg.name = 'trailer';
    const thw = tr.width / 2;
    const tFront = -(tr.hitchToAxle - tr.bodyFront);
    const tRear = tr.length - tr.hitchToAxle;
    tg.add(box(-thw, thw, 1.12, tr.height, tFront, tRear, WHITE));
    tg.add(box(-0.5, 0.5, 0.7, 1.12, tFront, tRear - 0.1, FRAME));
    tg.add(box(-thw + 0.05, thw - 0.05, 0.5, 0.62, tRear - 0.12, tRear, FRAME));
    // the rigid drawbar and its eye
    tg.add(box(-0.09, 0.09, TRUCK_HITCH.height - 0.09, TRUCK_HITCH.height + 0.09, -tr.hitchToAxle, tFront + 0.2, FRAME));
    for (const side of [-1, 1]) {
      const strut = box(-0.05, 0.05, TRUCK_HITCH.height - 0.07, TRUCK_HITCH.height + 0.07, -tr.hitchToAxle + 0.2, tFront + 0.2, FRAME);
      strut.rotation.y = side * 0.32;
      strut.position.x = side * 0.28;
      tg.add(strut);
      const stop = box(side * (thw - 0.3) - 0.14, side * (thw - 0.3) + 0.14, 0.78, 0.98, tRear - 0.02, tRear + 0.02, TAIL, false);
      this.brakeLamps.push(stop);
      tg.add(stop);
      const ind = box(side * (thw - 0.08) - 0.07, side * (thw - 0.08) + 0.07, 0.8, 0.96, tRear, tRear + 0.04, this.off, false);
      this.indicators.push({ mesh: ind, side });
      tg.add(ind);
      tg.add(box(side * thw - 0.3 * (side > 0 ? 1 : 0), side * thw + 0.3 * (side < 0 ? 1 : 0), 0.5, 0.9, tFront + 0.3, -tr.axleSpread / 2 - 0.6, FRAME));
      for (const z of [-tr.axleSpread / 2, tr.axleSpread / 2]) {
        const g = wheel(tr.wheelRadius, 0.36);
        g.position.set(side * (tr.track / 2), tr.wheelRadius, z);
        this.trailerWheels.push(g);
        tg.add(g);
      }
    }
    // the support leg under the drawbar: down when the trailer stands alone
    this.leg = box(-0.06, 0.06, 0, TRUCK_HITCH.height - 0.1, -tr.hitchToAxle + 0.75, -tr.hitchToAxle + 0.87, FRAME);
    tg.add(this.leg);
    letterBox(tg, BRAND, thw, 2.55, (tFront + tRear) / 2, tRear, tRear - tFront - 0.8);
  }

  /**
   * How solid the inside of the cab looks from the driver's seat: 1 = solid,
   * less = the road shows through lining, dashboard and steering wheel.
   * (From outside the cab is always solid: its paint is another face.)
   */
  setCabinOpacity(opacity: number): void {
    const o = Number.isFinite(opacity) ? Math.min(1, Math.max(0.05, opacity)) : 1;
    const solid = o >= 0.995;
    for (const m of [this.lining, this.fittings]) {
      if (m.transparent === solid) m.needsUpdate = true;
      m.transparent = !solid;
      m.depthWrite = solid;
      m.opacity = solid ? 1 : o;
    }
  }

  /** The truck's moving parts and lamps. */
  update(s: CarVisualState, _dt: number, now: number): void {
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.position.y = TRUCK.wheelRadius + (s.wheelY[i] ?? 0);
      w.rotation.set(-(s.wheelSpin[i] ?? 0), i < 2 ? -(s.wheelSteer[i] ?? 0) : 0, 0, 'YXZ');
    }
    this.steering.rotation.z = -s.steerWheel;
    for (const lamp of this.brakeLamps) lamp.material = s.braking ? LAMP_STOP : TAIL;
    const on = s.blinkOn && s.ignition;
    for (const ind of this.indicators) ind.mesh.material = on && (s.hazard || s.indicator === ind.side) ? AMBER : this.off;
    this.panel.update(s, now);
  }

  /** Where the trailer is (the middle of its axle group on the ground), and whether it stands on its leg. */
  setTrailer(x: number, y: number, z: number, yaw: number, pitch: number, wheelSpin: number, coupled: boolean): void {
    const t = this.trailer;
    t.position.set(x, y, z);
    t.rotation.set(pitch, yaw, 0, 'YXZ');
    for (const w of this.trailerWheels) w.rotation.x = -wheelSpin;
    this.leg.visible = !coupled;
  }

  dispose(): void {
    for (const m of this.mirrors) m.target.dispose();
  }
}

export const LAMP_STOP = new THREE.MeshBasicMaterial({ color: 0xff3a2a });
