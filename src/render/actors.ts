// SPDX-License-Identifier: AGPL-3.0-only
/** Moving things in the scene: traffic cars, pedestrians, cyclists and traffic-light heads. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { newPolySample, samplePolyline } from '../core/geom.ts';
import { SIG } from '../sim/signals.ts';
import type { SignalSystem } from '../sim/signals.ts';
import type { Cyclist } from '../sim/cyclists.ts';
import type { Pedestrian, TrafficCar } from '../sim/traffic.ts';
import { BUS_STYLE } from '../sim/traffic.ts';
import type { CarVisualState } from './car.ts';
import { PlayerBus } from './fleet.ts';
import { CTRL, KERB_H, XING } from '../world/types.ts';
import type { Arm, World } from '../world/world.ts';
import { CarExterior } from './car.ts';
import { COMPACT_DIMS } from './carBody.ts';
import type { CarDims } from './carBody.ts';
import { CyclistModel } from './cyclist.ts';

const STYLES: CarDims[] = [
  COMPACT_DIMS,
  { ...COMPACT_DIMS, length: 4.6, height: 1.5, wheelbase: 2.7, tail: 1 },
  { ...COMPACT_DIMS, length: 4.45, height: 1.42, wheelbase: 2.68, tail: 2 },
];

export class TrafficRenderer {
  readonly group = new THREE.Group();
  private readonly cars = new Map<number, CarExterior>();
  private readonly pool: CarExterior[][] = [[], [], []];
  private readonly peds = new Map<number, THREE.Group>();
  private readonly cyclists = new Map<number, CyclistModel>();
  private readonly cyclistPool: CyclistModel[] = [];
  /** the city buses of the traffic (the bus one learns with, seen from outside) */
  private readonly buses = new Map<number, PlayerBus>();
  private readonly busPool: PlayerBus[] = [];
  private readonly busState: CarVisualState = {
    speedKmh: 0, rpm: 800, gear: 1, indicator: 0, hazard: false, blinkOn: false, lowBeam: true, highBeam: false, handbrake: false, ignition: true, engineRunning: true, abs: false, seatbelt: true, fuel: 0.6, automatic: true, showGear: false, odometerKm: 0,
    steerWheel: 0, wheelSteer: [0, 0, 0, 0], wheelSpin: [0, 0, 0, 0], wheelY: [0.48, 0.48, 0.48, 0.48], clutch: 0, brake: 0, throttle: 0, handbrakeLever: 0, braking: false, reversing: false,
  };
  private readonly pedGeo: { body: THREE.BufferGeometry; leg: THREE.BufferGeometry; head: THREE.BufferGeometry };
  private readonly skin = new THREE.MeshLambertMaterial({ color: 0xd9a989 });
  private readonly trousers = new THREE.MeshLambertMaterial({ color: 0x2a2d33 });

  constructor() {
    this.group.name = 'traffic';
    const body = new THREE.BoxGeometry(0.4, 0.62, 0.24).translate(0, 1.13, 0);
    const leg = new THREE.BoxGeometry(0.14, 0.82, 0.16).translate(0, -0.41, 0);
    const head = new THREE.SphereGeometry(0.115, 10, 8).translate(0, 1.58, 0);
    this.pedGeo = { body, leg, head };
  }

  update(cars: TrafficCar[], peds: Pedestrian[], time: number, cyclists: readonly Cyclist[] = []): void {
    const seen = new Set<number>();
    const blinkOn = Math.floor(time * 3) % 2 === 0;
    const seenB = new Set<number>();
    for (const c of cars) {
      if (c.style === BUS_STYLE) {
        // a city bus: the lamps say where it is going (to the stop, out of it)
        seenB.add(c.id);
        let b = this.buses.get(c.id);
        if (!b) {
          b = this.busPool.pop() ?? new PlayerBus();
          b.root.traverse((o) => {
            if (o instanceof THREE.Mesh) o.castShadow = true;
          });
          this.buses.set(c.id, b);
          this.group.add(b.root);
        }
        b.root.position.set(c.x, c.y, c.z);
        b.root.rotation.set(c.pitch, c.yaw, 0, 'YXZ');
        const st = this.busState;
        st.wheelSpin.fill(c.wheelSpin);
        st.indicator = c.blinker;
        st.blinkOn = blinkOn;
        st.braking = c.braking;
        st.speedKmh = c.v * 3.6;
        b.update(st, 0, time);
        continue;
      }
      seen.add(c.id);
      let m = this.cars.get(c.id);
      if (!m) {
        m = this.pool[c.style].pop() ?? new CarExterior(c.color, { dims: STYLES[c.style] });
        m.paint.color.set(c.color);
        this.cars.set(c.id, m);
        this.group.add(m.group);
      }
      m.group.position.set(c.x, c.y, c.z);
      m.group.rotation.set(c.pitch, c.yaw, 0, 'YXZ');
      const r = m.dims.wheelRadius;
      m.setWheels([0, 0, 0, 0], [c.wheelSpin, c.wheelSpin, c.wheelSpin, c.wheelSpin], [r, r, r, r]);
      m.setLamps({ low: true, high: false, brake: c.braking, reverse: false, left: blinkOn && c.blinker < 0, right: blinkOn && c.blinker > 0 });
    }
    for (const [id, m] of this.cars) {
      if (seen.has(id)) continue;
      this.group.remove(m.group);
      const style = STYLES.indexOf(m.dims);
      this.pool[style < 0 ? 0 : style].push(m);
      this.cars.delete(id);
    }
    for (const [id, b] of this.buses) {
      if (seenB.has(id)) continue;
      this.group.remove(b.root);
      this.busPool.push(b);
      this.buses.delete(id);
    }
    const seenP = new Set<number>();
    for (const p of peds) {
      seenP.add(p.id);
      let g = this.peds.get(p.id);
      if (!g) {
        g = new THREE.Group();
        const shirt = new THREE.MeshLambertMaterial({ color: p.colour });
        g.add(new THREE.Mesh(this.pedGeo.body, shirt), new THREE.Mesh(this.pedGeo.head, this.skin));
        for (const side of [-1, 1]) {
          const leg = new THREE.Mesh(this.pedGeo.leg, this.trousers);
          leg.position.set(side * 0.1, 0.83, 0);
          g.add(leg);
        }
        this.peds.set(p.id, g);
        this.group.add(g);
      }
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = p.yaw;
      const swing = p.state === 'cross' ? Math.sin(p.phase) * 0.55 : 0;
      (g.children[2] as THREE.Mesh).rotation.x = swing;
      (g.children[3] as THREE.Mesh).rotation.x = -swing;
    }
    for (const [id, g] of this.peds) {
      if (seenP.has(id)) continue;
      this.group.remove(g);
      this.peds.delete(id);
    }
    const seenC = new Set<number>();
    for (const c of cyclists) {
      seenC.add(c.id);
      let m = this.cyclists.get(c.id);
      if (!m) {
        m = this.cyclistPool.pop() ?? new CyclistModel(c.colour);
        m.setColour(c.colour);
        this.cyclists.set(c.id, m);
        this.group.add(m.group);
      }
      m.group.position.set(c.x, c.y, c.z);
      m.group.rotation.y = c.yaw;
      m.pose(c.phase, c.roll, c.down > 0);
    }
    for (const [id, m] of this.cyclists) {
      if (seenC.has(id)) continue;
      this.group.remove(m.group);
      this.cyclistPool.push(m);
      this.cyclists.delete(id);
    }
  }
}

interface Head {
  controller: number;
  group: number;
  /** index of the first of the three lamp instances */
  lamp: number;
  state: number;
}

/** The green arrow beside a head: an amber and a green arrow lamp. */
interface ArrowHead {
  arm: Arm;
  /** index of the first of its two lamp instances */
  lamp: number;
  state: number;
}

/** An arrow pointing along +X, 17 cm long (a lamp of an arrow light). */
function arrowShape(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.085, -0.022);
  s.lineTo(0.01, -0.022);
  s.lineTo(0.01, -0.062);
  s.lineTo(0.085, 0);
  s.lineTo(0.01, 0.062);
  s.lineTo(0.01, 0.022);
  s.lineTo(-0.085, 0.022);
  s.closePath();
  return new THREE.ShapeGeometry(s);
}

/** All traffic-light heads of the map (a few hundred instances at most). */
export class SignalRenderer {
  readonly group = new THREE.Group();
  private readonly heads: Head[] = [];
  private lamps!: THREE.InstancedMesh;
  private housing: THREE.InstancedMesh | null = null;
  /** the green arrows beside some of the heads */
  private readonly arrowHeads: ArrowHead[] = [];
  private arrowLamps: THREE.InstancedMesh | null = null;
  private arrowHousing: THREE.InstancedMesh | null = null;
  /** positions of the poles for the collision system: x, y, z, radius */
  readonly poles: number[] = [];

  constructor(world: World, signals?: SignalSystem) {
    this.group.name = 'signals';
    this.rebuild(world, signals);
  }

  /**
   * Set the heads up anew: for the signals of the roads that are loaded now
   * (the network comes in pieces).  With `signals`, the green arrows it
   * knows of are hung beside the heads of their approaches.
   */
  rebuild(world: World, signals?: SignalSystem): void {
    for (const m of [this.housing, this.housing ? this.lamps : null, this.arrowHousing, this.arrowLamps]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.arrowHousing = null;
    this.arrowLamps = null;
    this.heads.length = 0;
    this.arrowHeads.length = 0;
    this.poles.length = 0;
    const tmp = newPolySample();
    const placements: Array<{ x: number; y: number; z: number; yaw: number; controller: number; group: number; overRoad: number; arrow: Arm | null }> = [];
    const place = (edge: World['edges'][number], s: number, dir: number, controller: number, grp: number, side: number, arrow: Arm | null = null): void => {
      samplePolyline(edge.pl, Math.max(0.2, Math.min(edge.len - 0.2, s)), tmp);
      const lat = -dir * side; // driver's right when side = 1
      const sw = lat > 0 ? edge.swL : edge.swR;
      const out = edge.width / 2 + (sw > 0 ? 0.55 : 0.9);
      const x = tmp.x + tmp.tz * out * lat;
      const z = tmp.z - tmp.tx * out * lat;
      const y = world.edgeY(edge, s, x, z) + (sw > 0 ? KERB_H : -0.1);
      const fx = -tmp.tx * dir;
      const fz = -tmp.tz * dir;
      placements.push({ x, y, z, yaw: Math.atan2(-fx, -fz), controller, group: grp, overRoad: 0, arrow });
    };
    for (const node of world.allNodes) {
      // (lights that are out of order stand there all the same – and flash)
      if (node.stub || (node.ctrl !== CTRL.SIGNALS && !node.dark) || node.sc < 0) continue;
      for (const arm of node.arms) {
        if (arm.lamp < 0 || !arm.isApproach) continue;
        const e = arm.edge;
        const dir = arm.out ? -1 : 1;
        // the pole stands a little beyond the stop line so the first car can still see it
        const d = Math.max(arm.cut + 0.3, arm.stopS - 2.6);
        const s = arm.out ? d : e.len - d;
        // (the arrow for turning right hangs beside the head at the right-hand kerb)
        place(e, s, dir, node.sc, arm.lamp, 1, signals?.arrows.has(arm) ? arm : null);
        const lanesIn = arm.out ? e.lanesB : e.lanesF;
        if (lanesIn >= 2 || e.lanesF === 0 || e.lanesB === 0) place(e, s, dir, node.sc, arm.lamp, -1);
      }
    }
    for (const c of world.crossings) {
      if (c.k !== XING.SIGNAL || c.sc === undefined) continue;
      const e = world.edges[c.e];
      // crossings that belong to a junction are served by its heads
      const nearA = (e.a.ctrl === CTRL.SIGNALS || e.a.dark) && c.s < 40;
      const nearB = (e.b.ctrl === CTRL.SIGNALS || e.b.dark) && e.len - c.s < 40;
      if (nearA || nearB) continue;
      if (e.lanesF > 0) place(e, c.s + c.w / 2 + 0.8, 1, c.sc, c.g ?? 0, 1);
      if (e.lanesB > 0) place(e, c.s - c.w / 2 - 0.8, -1, c.sc, c.g ?? 0, 1);
    }

    const n = placements.length;
    const pole = new THREE.CylinderGeometry(0.055, 0.065, 3.5, 8, 1, true).translate(0, 1.75, 0);
    const box = new THREE.BoxGeometry(0.3, 0.92, 0.22).translate(0, 3.0, 0.02);
    const visor = new THREE.BoxGeometry(0.34, 0.03, 0.2).translate(0, 3.47, -0.16);
    const merged = mergeGeometries([pole.toNonIndexed(), box.toNonIndexed(), visor.toNonIndexed()].map((g) => {
      g.deleteAttribute('uv');
      return g;
    }), false)!;
    merged.computeVertexNormals();
    const housing = new THREE.InstancedMesh(merged, new THREE.MeshLambertMaterial({ color: 0x1d2022 }), Math.max(1, n));
    const lampGeo = new THREE.CircleGeometry(0.095, 14);
    this.lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true }), Math.max(1, n * 3));
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const off = new THREE.Vector3();
    const dark = new THREE.Color(0x111111);
    placements.forEach((p, i) => {
      // the head faces along its local -Z (same convention as sign plates)
      q.setFromAxisAngle(up, p.yaw);
      m4.compose(new THREE.Vector3(p.x, p.y - 0.25, p.z), q, new THREE.Vector3(1, 1, 1));
      housing.setMatrixAt(i, m4);
      for (let k = 0; k < 3; k++) {
        off.set(0, 3.0 + 0.29 - k * 0.29 - 0.25, -0.095).applyQuaternion(q);
        // CircleGeometry faces +Z: turn it round to face -Z
        const ql = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(up, Math.PI));
        m4.compose(new THREE.Vector3(p.x + off.x, p.y + off.y, p.z + off.z), ql, new THREE.Vector3(1, 1, 1));
        this.lamps.setMatrixAt(i * 3 + k, m4);
        this.lamps.setColorAt(i * 3 + k, dark);
      }
      this.heads.push({ controller: p.controller, group: p.group, lamp: i * 3, state: -1 });
      this.poles.push(p.x, p.y, p.z, 0.08);
    });
    housing.count = n;
    this.lamps.count = n * 3;
    housing.instanceMatrix.needsUpdate = true;
    this.lamps.instanceMatrix.needsUpdate = true;
    housing.frustumCulled = false;
    this.lamps.frustumCulled = false;
    this.housing = housing;
    this.group.add(housing, this.lamps);

    // ---- the green arrows: a smaller head with two arrow lamps (amber, green) on the kerb side of the main one ----
    const withArrow = placements.filter((p) => p.arrow);
    if (withArrow.length === 0) return;
    // (seen from the approaching car, to the right of the head is its local -X)
    const SIDE = -0.34;
    const small = new THREE.BoxGeometry(0.3, 0.63, 0.22).translate(SIDE, 2.855, 0.02).toNonIndexed();
    small.deleteAttribute('uv');
    small.computeVertexNormals();
    const arrowHousing = new THREE.InstancedMesh(small, new THREE.MeshLambertMaterial({ color: 0x1d2022 }), withArrow.length);
    const arrowLamps = new THREE.InstancedMesh(arrowShape(), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true }), withArrow.length * 2);
    const turned = new THREE.Quaternion().setFromAxisAngle(up, Math.PI);
    withArrow.forEach((p, i) => {
      q.setFromAxisAngle(up, p.yaw);
      m4.compose(new THREE.Vector3(p.x, p.y - 0.25, p.z), q, new THREE.Vector3(1, 1, 1));
      arrowHousing.setMatrixAt(i, m4);
      // (the shape faces +Z and points along +X: turned round it faces the car and points to its right)
      const ql = q.clone().multiply(turned);
      for (let k = 0; k < 2; k++) {
        off.set(SIDE, 3.0 - k * 0.29 - 0.25, -0.095).applyQuaternion(q);
        m4.compose(new THREE.Vector3(p.x + off.x, p.y + off.y, p.z + off.z), ql, new THREE.Vector3(1, 1, 1));
        arrowLamps.setMatrixAt(i * 2 + k, m4);
        arrowLamps.setColorAt(i * 2 + k, dark);
      }
      this.arrowHeads.push({ arm: p.arrow as Arm, lamp: i * 2, state: -9 });
    });
    arrowHousing.instanceMatrix.needsUpdate = true;
    arrowLamps.instanceMatrix.needsUpdate = true;
    arrowHousing.frustumCulled = false;
    arrowLamps.frustumCulled = false;
    this.arrowHousing = arrowHousing;
    this.arrowLamps = arrowLamps;
    this.group.add(arrowHousing, arrowLamps);
  }

  update(signals: SignalSystem): void {
    const red = new THREE.Color(0xff2a1a);
    const amber = new THREE.Color(0xffb000);
    const green = new THREE.Color(0x1aff6a);
    const dark = new THREE.Color(0x141414);
    let changed = false;
    // (out of order: the amber lamp flashes, once a second)
    const flash = signals.time % 1 < 0.5;
    for (const h of this.heads) {
      let st = signals.get(h.controller, h.group);
      if (st === SIG.FLASH && !flash) st = -1;
      if (st === h.state) continue;
      h.state = st;
      changed = true;
      this.lamps.setColorAt(h.lamp, st === SIG.RED || st === SIG.RED_AMBER ? red : dark);
      this.lamps.setColorAt(h.lamp + 1, st === SIG.AMBER || st === SIG.RED_AMBER || st === SIG.FLASH ? amber : dark);
      this.lamps.setColorAt(h.lamp + 2, st === SIG.GREEN ? green : dark);
    }
    if (changed && this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
    if (!this.arrowLamps) return;
    changed = false;
    for (const h of this.arrowHeads) {
      const st = signals.arrow(h.arm);
      if (st === h.state) continue;
      h.state = st;
      changed = true;
      this.arrowLamps.setColorAt(h.lamp, st === SIG.AMBER ? amber : dark);
      this.arrowLamps.setColorAt(h.lamp + 1, st === SIG.GREEN ? green : dark);
    }
    if (changed && this.arrowLamps.instanceColor) this.arrowLamps.instanceColor.needsUpdate = true;
  }
}
