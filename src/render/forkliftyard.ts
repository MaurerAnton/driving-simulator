// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The forklift's place on the practice yard, drawn (game/forklifttasks.ts
 * says what is where): the pallet rack – blue uprights with their bracing,
 * orange beams –, the flatbed truck with its side open, the markings on the
 * floor (the aisle, the places the pallets wait in, the green place of the
 * guided start), the pallets (render/loading.ts draws them, as for the
 * truck being loaded at a depot) and the crate of 3.6 t with its weight
 * written on it, and green arrows over what is to be taken now.
 *
 * The fixed parts are built in the yard's frame (u along it, w across,
 * metres above the floor) – a group placed and turned as the yard is –,
 * the pallets in the world, each frame where the simulation has them.
 */
import * as THREE from 'three';
import type { YardFrame } from '../game/ce.ts';
import { FORK_AREA, GUIDE_ZONE, RACK, TRUCK, slotOf } from '../game/forklifttasks.ts';
import type { OBox, Pallet } from '../sim/forklift.ts';
import { palletModel } from './loading.ts';

const lam = (c: number): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color: c });
const M = {
  upright: lam(0x1f4fa0),
  beam: lam(0xe0661a),
  yellow: new THREE.MeshBasicMaterial({ color: 0xf2c200 }),
  white: new THREE.MeshBasicMaterial({ color: 0xe9ece8 }),
  green: new THREE.MeshBasicMaterial({ color: 0x2fd36a }),
  greenFill: new THREE.MeshBasicMaterial({ color: 0x2fd36a, transparent: true, opacity: 0.25, depthWrite: false }),
  cab: lam(0xdfe3e6),
  cabStripe: lam(0x1f5fa8),
  glass: lam(0x1d2a35),
  chassis: lam(0x1d1f22),
  floor: lam(0x6e5236),
  tyre: lam(0x1b1c1e),
  rim: lam(0xa9adb2),
  arrow: new THREE.MeshBasicMaterial({ color: 0x35e07a }),
  floorPaint: lam(0x7d8186),
};

function box(g: THREE.Object3D, m: THREE.Material, u0: number, y0: number, w0: number, u1: number, y1: number, w1: number, shadow = true): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(u1 - u0), Math.abs(y1 - y0), Math.abs(w1 - w0)), m);
  mesh.position.set((u0 + u1) / 2, (y0 + y1) / 2, (w0 + w1) / 2);
  mesh.castShadow = shadow;
  mesh.receiveShadow = shadow;
  g.add(mesh);
  return mesh;
}

/** A line painted on the floor from (u0, w0) to (u1, w1). */
function line(g: THREE.Object3D, m: THREE.Material, u0: number, w0: number, u1: number, w1: number, width = 0.1): void {
  const len = Math.hypot(u1 - u0, w1 - w0);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(len, width), m);
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = -Math.atan2(w1 - w0, u1 - u0);
  mesh.position.set((u0 + u1) / 2, 0.012, (w0 + w1) / 2);
  g.add(mesh);
}

function frameLines(g: THREE.Object3D, m: THREE.Material, u0: number, w0: number, u1: number, w1: number, width = 0.1): void {
  line(g, m, u0, w0, u1, w0, width);
  line(g, m, u1, w0, u1, w1, width);
  line(g, m, u1, w1, u0, w1, width);
  line(g, m, u0, w1, u0, w0, width);
}

/** The weight written on the crate's side. */
function weightSign(text: string): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const x = c.getContext('2d')!;
  x.fillStyle = '#f2c200';
  x.fillRect(0, 0, 256, 128);
  x.fillStyle = '#111';
  x.font = '700 64px "Roboto Condensed", Arial, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(text, 128, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.3), new THREE.MeshBasicMaterial({ map: tex }));
}

export class ForkYardScene {
  readonly group = new THREE.Group();
  /** the fixed parts, in the yard's frame */
  private readonly fixed = new THREE.Group();
  private readonly palletGroup = new THREE.Group();
  private readonly pallets = new Map<string, THREE.Group>();
  private readonly arrows: THREE.Mesh[] = [];
  private readonly zoneMark = new THREE.Group();
  private readonly bedMark = new THREE.Group();
  private readonly slotMark = new THREE.Group();
  private builtFor = '';
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly e = new THREE.Euler();

  constructor() {
    this.group.name = 'forklift place';
    this.group.add(this.fixed, this.palletGroup);
    this.group.visible = false;
  }

  /** Lay the place out (once for a yard) on the floor `y0`; `low`: the low graphics preset. */
  show(frame: YardFrame, y0: number, low: boolean): void {
    const key = `${frame.yard.x}|${frame.yard.z}|${frame.yard.rot}|${y0.toFixed(2)}|${low}`;
    this.group.visible = true;
    if (key === this.builtFor) return;
    this.builtFor = key;
    this.clearFixed();
    const [ox, oz] = frame.toWorld(0, 0);
    this.fixed.position.set(ox, y0, oz);
    this.fixed.rotation.y = frame.yawToWorld(0);
    this.build(low);
  }

  hide(): void {
    this.group.visible = false;
  }

  private clearFixed(): void {
    this.fixed.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.fixed.clear();
    this.arrows.length = 0;
    this.zoneMark.clear();
    this.bedMark.clear();
    this.slotMark.clear();
  }

  private build(low: boolean): void {
    const g = this.fixed;
    // ---- the floor: the area's edge, the aisle in front of the rack, the places the pallets wait in
    const A = FORK_AREA;
    frameLines(g, M.yellow, A.u0, A.w0, A.u1, A.w1, 0.12);
    line(g, M.yellow, RACK.u0 - 1, RACK.wFront + 0.6, RACK.u0 + RACK.bay * RACK.bays + 1, RACK.wFront + 0.6, 0.1);
    frameLines(g, M.white, -20.3, -4.8, -16.1, -3.2, 0.06);
    frameLines(g, M.white, -28.6, -3.8, -27.4, -2.2, 0.06);
    // ---- the rack
    const R = RACK;
    for (let k = 0; k <= R.bays; k++) {
      const u = R.u0 + k * R.bay;
      for (const w of [R.wFront, R.wBack]) box(g, M.upright, u - 0.05, 0, w - 0.05, u + 0.05, R.height, w + 0.05);
      // the bracing between the front and the back upright, and its foot plates
      if (!low) {
        for (let i = 0; i < 5; i++) {
          const y0 = 0.2 + i * 0.72;
          const y1 = y0 + 0.72;
          const d = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, Math.hypot(y1 - y0, R.wFront - R.wBack), 6), M.upright);
          d.position.set(u, (y0 + y1) / 2, (R.wFront + R.wBack) / 2);
          d.rotation.x = (i % 2 === 0 ? 1 : -1) * Math.atan2(R.wFront - R.wBack, y1 - y0);
          g.add(d);
        }
        for (const w of [R.wFront, R.wBack]) box(g, M.upright, u - 0.08, 0, w - 0.08, u + 0.08, 0.02, w + 0.08, false);
      }
      box(g, M.upright, u - 0.03, 0.15, R.wBack, u + 0.03, 0.2, R.wFront, false);
      box(g, M.upright, u - 0.03, R.height - 0.2, R.wBack, u + 0.03, R.height - 0.15, R.wFront, false);
    }
    for (let b = 0; b < R.bays; b++) {
      const ua = R.u0 + b * R.bay + 0.05;
      const ub = R.u0 + (b + 1) * R.bay - 0.05;
      for (const lv of R.levels) {
        box(g, M.beam, ua, lv - R.beam, R.wFront - 0.08, ub, lv, R.wFront);
        box(g, M.beam, ua, lv - R.beam, R.wBack, ub, lv, R.wBack + 0.08);
        if (!low) for (const t of [0.25, 0.5, 0.75]) box(g, M.upright, ua + (ub - ua) * t - 0.02, lv - 0.04, R.wBack, ua + (ub - ua) * t + 0.02, lv, R.wFront, false);
      }
    }
    // ---- the truck: its cab, chassis, wheels and its floor, the headboard; the side towards the rack open
    const T = TRUCK;
    box(g, M.chassis, T.chassis.u0, T.chassis.y0, T.chassis.w0, T.chassis.u1 + 2.4, T.chassis.y1, T.chassis.w1);
    box(g, M.floor, T.bed.u0, T.bed.y - 0.12, T.bed.w0, T.bed.u1, T.bed.y, T.bed.w1);
    box(g, M.chassis, T.bed.u0, T.bed.y - 0.22, T.bed.w0, T.bed.u1, T.bed.y - 0.12, T.bed.w0 + 0.06);
    box(g, M.chassis, T.bed.u0, T.bed.y - 0.22, T.bed.w1 - 0.06, T.bed.u1, T.bed.y - 0.12, T.bed.w1);
    box(g, M.cabStripe, T.head.u0, T.head.y0, T.head.w0, T.head.u1, T.head.y1, T.head.w1);
    // (the curtain's frame: the posts along the far side, the roof rail – the near side is open)
    if (!low) {
      for (let u = T.bed.u0 + 0.05; u <= T.bed.u1; u += 1.85) box(g, M.chassis, u - 0.04, T.bed.y, T.bed.w1 - 0.08, u + 0.04, T.bed.y + 2.5, T.bed.w1);
      box(g, M.chassis, T.bed.u0, T.bed.y + 2.5, T.bed.w1 - 0.1, T.bed.u1, T.bed.y + 2.58, T.bed.w1);
      box(g, M.chassis, T.bed.u0, T.bed.y, T.bed.w0, T.bed.u0 + 0.08, T.bed.y + 0.5, T.bed.w1);
    }
    box(g, M.cab, T.cab.u0, T.cab.y0 + 0.5, T.cab.w0, T.cab.u1, T.cab.y1, T.cab.w1);
    box(g, M.cabStripe, T.cab.u0, T.cab.y0 + 0.5, T.cab.w0 - 0.01, T.cab.u1, T.cab.y0 + 0.75, T.cab.w1 + 0.01);
    box(g, M.glass, T.cab.u1 - 0.02, 1.85, T.cab.w0 + 0.15, T.cab.u1 + 0.01, 2.7, T.cab.w1 - 0.15, false);
    for (const w of [T.cab.w0 - 0.01, T.cab.w1 + 0.01]) box(g, M.glass, T.cab.u1 - 1.0, 1.9, w - 0.005, T.cab.u1 - 0.2, 2.65, w + 0.005, false);
    box(g, M.chassis, T.cab.u1 - 0.1, 0.45, T.cab.w0, T.cab.u1 + 0.12, 0.85, T.cab.w1);
    for (const u of T.wheels) {
      for (const w of [T.bed.w0 + 0.25, T.bed.w1 - 0.25]) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(T.wheelR, T.wheelR, 0.4, low ? 12 : 20), M.tyre);
        t.rotation.x = Math.PI / 2;
        t.position.set(u, T.wheelR, w);
        t.castShadow = true;
        g.add(t);
        const r = new THREE.Mesh(new THREE.CylinderGeometry(T.wheelR * 0.55, T.wheelR * 0.55, 0.42, 12), M.rim);
        r.rotation.x = Math.PI / 2;
        r.position.copy(t.position);
        g.add(r);
      }
    }
    // ---- the marks shown when they are wanted: the green place, the truck's floor, the slot up in the rack
    const Z = GUIDE_ZONE;
    frameLines(this.zoneMark, M.green, Z.u - Z.hu, Z.w - Z.hw, Z.u + Z.hu, Z.w + Z.hw, 0.12);
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(Z.hu * 2, Z.hw * 2), M.greenFill);
    fill.rotation.x = -Math.PI / 2;
    fill.position.set(Z.u, 0.014, Z.w);
    this.zoneMark.add(fill);
    const bedFill = new THREE.Mesh(new THREE.PlaneGeometry(T.bed.u1 - T.bed.u0, T.bed.w1 - T.bed.w0), M.greenFill);
    bedFill.rotation.x = -Math.PI / 2;
    bedFill.position.set((T.bed.u0 + T.bed.u1) / 2, T.bed.y + 0.01, (T.bed.w0 + T.bed.w1) / 2);
    this.bedMark.add(bedFill);
    const ts = slotOf(1, 0);
    const top = R.levels[1];
    box(this.slotMark, M.green, ts.u - 0.45, top + 0.005, R.wFront - 0.1, ts.u + 0.45, top + 0.04, R.wFront - 0.06, false);
    box(this.slotMark, M.green, ts.u - 0.45, top + 0.005, R.wBack + 0.06, ts.u + 0.45, top + 0.04, R.wBack + 0.1, false);
    const slotFill = new THREE.Mesh(new THREE.PlaneGeometry(0.9, R.wFront - R.wBack), M.greenFill);
    slotFill.rotation.x = -Math.PI / 2;
    slotFill.position.set(ts.u, top + 0.02, (R.wFront + R.wBack) / 2);
    this.slotMark.add(slotFill);
    g.add(this.zoneMark, this.bedMark, this.slotMark);
  }

  /** A pallet's drawing (made the first time it is seen). */
  private palletOf(p: Pallet): THREE.Group {
    let m = this.pallets.get(p.id);
    if (!m) {
      m = palletModel({ height: p.def.goods, kind: p.def.kind, mass: p.def.mass });
      if (p.def.mass > 2500) {
        // the crate: its weight on both sides
        for (const s of [-1, 1]) {
          const sign = weightSign(`${(p.def.mass / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1 })} t`);
          sign.position.set(s * (p.def.wid / 2 - 0.01), p.def.base + p.def.goods * 0.6, 0);
          sign.rotation.y = (s * Math.PI) / 2;
          m.add(sign);
        }
      }
      this.pallets.set(p.id, m);
      this.palletGroup.add(m);
    }
    return m;
  }

  /**
   * The pallets where they are (the one on the forks leaning with the
   * mast: `fork` its yaw and tilt), the arrows over those to take, the
   * marks of where they go.
   */
  update(pallets: readonly Pallet[], fork: { yaw: number; tilt: number } | null, targets: { pallets: readonly string[]; zone: OBox | null; bed: boolean; slot: boolean }, now: number): void {
    for (const p of pallets) {
      const m = this.palletOf(p);
      m.position.set(p.x, p.y, p.z);
      if (p.fork && fork) {
        this.q.setFromEuler(this.e.set(0, fork.yaw, 0));
        this.q2.setFromEuler(this.e.set(fork.tilt, 0, 0));
        this.q.multiply(this.q2);
        this.q2.setFromEuler(this.e.set(0, p.yaw - fork.yaw, 0));
        m.quaternion.copy(this.q.multiply(this.q2));
      } else m.quaternion.setFromEuler(this.e.set(0, p.yaw, 0));
    }
    // the arrows: one over each pallet to take, bobbing
    while (this.arrows.length < targets.pallets.length) {
      const a = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.45, 12), M.arrow);
      a.rotation.x = Math.PI;
      this.arrows.push(a);
      this.group.add(a);
    }
    this.arrows.forEach((a, i) => {
      const id = targets.pallets[i];
      const p = id ? pallets.find((x) => x.id === id) : undefined;
      a.visible = !!p;
      if (p) a.position.set(p.x, p.y + p.def.base + p.def.goods + 0.55 + Math.sin(now * 3 + i) * 0.1, p.z);
    });
    this.zoneMark.visible = !!targets.zone && !targets.slot;
    this.bedMark.visible = targets.bed;
    this.slotMark.visible = targets.slot;
  }
}
