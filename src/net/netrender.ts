// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The other players of a session in the world: each one's vehicle drawn
 * with the models the game has for its kind (the traffic's car body, the
 * bus, the lorries, the tractor, the motorcycles; a person for somebody on
 * foot; a plain block for what has no model to spare – the tram, the
 * aeroplane, the cranes), a name over it, and the boxes they stand in for
 * the player's collider (the player's vehicle stops at them: nothing more
 * is shared – no physics between players).
 */
import * as THREE from 'three';
import type { CarVisualState } from '../render/car.ts';
import { CarExterior } from '../render/car.ts';
import { PlayerBike, PlayerBus, PlayerTractor } from '../render/fleet.ts';
import type { VehicleModel } from '../render/fleet.ts';
import { PlayerTruck } from '../render/truck.ts';
import { PlayerRigid, PlayerSemi } from '../render/semitruck.ts';
import { PeopleRenderer } from '../render/people.ts';
import type { PersonPose } from '../render/people.ts';
import { LIGHT_TRUCK, MINIBUS } from '../sim/vehicle/fleet.ts';
import { VEHICLES, vehicleKind } from '../game/vehicles.ts';
import type { VehicleDef } from '../game/vehicles.ts';
import { LIGHT_HIGH, LIGHT_HAZARD, LIGHT_LOW, LIGHT_REVERSE } from './multiplayer.ts';
import type { Snapshot } from './multiplayer.ts';

/** One of the others, as the game hands it over to be drawn. */
export interface Shown {
  id: string;
  name: string;
  s: Snapshot;
}

/** a box another player's vehicle stands in (for the collider and the traffic) */
export interface PlayerBox {
  x: number;
  y: number;
  z: number;
  yaw: number;
  length: number;
  width: number;
  speed: number;
}

interface Drawn {
  key: string;
  root: THREE.Object3D;
  model: VehicleModel | null;
  car: CarExterior | null;
  tag: THREE.Sprite;
  tagText: string;
  def: VehicleDef;
  spin: number;
}

/** a fresh visual state for the models' update (lamps, wheels) */
function visualState(): CarVisualState {
  return {
    speedKmh: 0, rpm: 900, gear: 1, indicator: 0, hazard: false, blinkOn: false, lowBeam: true, highBeam: false, handbrake: false, ignition: true, engineRunning: true, abs: false, seatbelt: true, fuel: 0.6, automatic: true, showGear: false, odometerKm: 0,
    steerWheel: 0, wheelSteer: [0, 0, 0, 0], wheelSpin: [0, 0, 0, 0], wheelY: [0.48, 0.48, 0.48, 0.48], clutch: 0, brake: 0, throttle: 0, handbrakeLever: 0, braking: false, reversing: false,
  };
}

/** A label of a name, drawn on a small canvas – a sprite that always faces the camera. */
function nameTag(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.font = '600 30px system-ui, sans-serif';
    const w = Math.min(248, g.measureText(text).width + 28);
    g.fillStyle = 'rgba(12, 20, 30, 0.72)';
    g.beginPath();
    g.roundRect((256 - w) / 2, 8, w, 48, 22);
    g.fill();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 33, 230);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true, sizeAttenuation: true });
  const s = new THREE.Sprite(m);
  s.scale.set(2.4, 0.6, 1);
  s.renderOrder = 5;
  return s;
}

function disposeTag(s: THREE.Sprite): void {
  s.material.map?.dispose();
  s.material.dispose();
}

/** The model for a kind of vehicle (the key: what can be reused for another player of the same model). */
function makeModel(def: VehicleDef, paint: string): { key: string; root: THREE.Object3D; model: VehicleModel | null; car: CarExterior | null } {
  switch (def.model) {
    case 'car': {
      const car = new CarExterior(new THREE.Color(paint).getHex());
      return { key: 'car', root: car.group, model: null, car };
    }
    case 'bus':
      return one('bus', new PlayerBus());
    case 'minibus':
      return one('minibus', new PlayerBus(MINIBUS));
    case 'truck':
      return one('truck', new PlayerTruck());
    case 'truckLight':
      return one('truckLight', new PlayerTruck(LIGHT_TRUCK));
    case 'truckHeavy':
      return one('truckHeavy', new PlayerRigid());
    case 'semi':
      return one('semi', new PlayerSemi());
    case 'tractor':
      return one('tractor', new PlayerTractor());
    case 'motorcycle': {
      const v = def.kind === 'moped' ? 'moped' : def.kind === 'motorcycle125' ? 'light' : def.kind === 'motorcycle35' ? 'mid' : 'big';
      return one(`bike:${v}`, new PlayerBike(v));
    }
    default: {
      // a block of the vehicle's size (what has no light model: the tram, the aeroplane, the cranes, the forklift)
      const o = def.outline;
      const len = Math.max(1, o.front + o.rear);
      const h = def.model === 'tram' ? 3.4 : def.model === 'plane' ? 2.2 : 2.6;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(o.hw * 2, h, len), new THREE.MeshLambertMaterial({ color: new THREE.Color(paint) }));
      mesh.position.set(0, h / 2, (o.rear - o.front) / 2);
      mesh.castShadow = true;
      const g = new THREE.Group();
      g.add(mesh);
      return { key: `block:${def.kind}`, root: g, model: null, car: null };
    }
  }
}

function one(key: string, m: VehicleModel): { key: string; root: THREE.Object3D; model: VehicleModel; car: null } {
  for (const mirror of m.mirrors) mirror.setEnabled(false);
  m.root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });
  return { key, root: m.root, model: m, car: null };
}

export class RemotePlayers {
  readonly group = new THREE.Group();
  private readonly drawn = new Map<string, Drawn>();
  /** the people on foot among them */
  private readonly people = new PeopleRenderer(16);
  private readonly poses: PersonPose[] = [];
  private readonly tags = new Map<string, { tag: THREE.Sprite; text: string }>();
  private readonly vs = visualState();
  /** where they stand, for the collider and the traffic */
  readonly boxes: PlayerBox[] = [];

  constructor() {
    this.group.name = 'other players';
    this.group.add(this.people.group);
  }

  /** Draw them as they are now (`time`: seconds, for the indicators' blinking). */
  update(list: readonly Shown[], time: number, dt: number): void {
    const seen = new Set<string>();
    const poses = this.poses;
    let np = 0;
    this.boxes.length = 0;
    const blink = Math.floor(time * 3) % 2 === 0;
    for (const p of list) {
      const s = p.s;
      const kind = vehicleKind(s.kind) ?? 'car';
      const def = VEHICLES[kind];
      if (kind === 'pedestrian' || def.model === 'walker') {
        if (np >= 16) continue;
        const q = (poses[np++] ??= { x: 0, y: 0, z: 0, yaw: 0, walk: -1, look: 0 });
        q.x = s.x;
        q.y = s.y;
        q.z = s.z;
        q.yaw = s.yaw;
        q.walk = s.walker?.moving ? (s.walker.walk ?? time * 1.4) : -1;
        q.look = (hash(p.id) % 60) + 1;
        this.tag(p.id, p.name, s.x, s.y + 2.1, s.z, seen);
        this.boxes.push({ x: s.x, y: s.y, z: s.z, yaw: s.yaw, length: 0.6, width: 0.6, speed: s.speed });
        continue;
      }
      seen.add(p.id);
      const paint = s.paint ?? '#c8ccd2';
      let d = this.drawn.get(p.id);
      const key = def.model === 'car' ? 'car' : null;
      if (d && (d.def !== def || (key === 'car' && d.key !== 'car'))) {
        this.drop(p.id, d);
        d = undefined;
      }
      if (!d) {
        const m = makeModel(def, paint);
        d = { ...m, tag: nameTag(p.name), tagText: p.name, def, spin: 0 };
        this.group.add(d.root, d.tag);
        this.drawn.set(p.id, d);
      }
      if (d.car) d.car.paint.color.set(paint);
      if (d.tagText !== p.name) {
        this.group.remove(d.tag);
        disposeTag(d.tag);
        d.tag = nameTag(p.name);
        d.tagText = p.name;
        this.group.add(d.tag);
      }
      d.root.position.set(s.x, s.y, s.z);
      d.root.rotation.set(s.pitch, s.yaw, s.roll, 'YXZ');
      const o = def.outline;
      d.tag.position.set(s.x, s.y + (def.model === 'car' || def.model === 'motorcycle' ? 2.1 : 4.2), s.z);
      d.spin += (s.speed / 0.33) * dt;
      const low = (s.lights & LIGHT_LOW) !== 0;
      const hazard = (s.lights & LIGHT_HAZARD) !== 0;
      if (d.car) {
        const r = d.car.dims.wheelRadius;
        const st = s.steer * 0.6;
        d.car.setWheels([st, st, 0, 0], [d.spin, d.spin, d.spin, d.spin], [r, r, r, r]);
        d.car.setLamps({ low, high: (s.lights & LIGHT_HIGH) !== 0, brake: s.brake, reverse: (s.lights & LIGHT_REVERSE) !== 0, left: blink && (hazard || s.signal < 0), right: blink && (hazard || s.signal > 0) });
      } else if (d.model) {
        const v = this.vs;
        v.speedKmh = Math.abs(s.speed) * 3.6;
        v.wheelSpin.fill(d.spin);
        v.wheelSteer[0] = v.wheelSteer[1] = s.steer * 0.6;
        v.indicator = s.signal;
        v.hazard = hazard;
        v.blinkOn = blink;
        v.lowBeam = low;
        v.highBeam = (s.lights & LIGHT_HIGH) !== 0;
        v.braking = s.brake;
        v.reversing = (s.lights & LIGHT_REVERSE) !== 0;
        d.model.update(v, dt, time);
      }
      // (the box: the middle of its length, measured from the model's origin)
      const mid = (o.rear - o.front) / 2;
      this.boxes.push({ x: s.x + Math.sin(s.yaw) * mid, y: s.y, z: s.z + Math.cos(s.yaw) * mid, yaw: s.yaw, length: o.front + o.rear, width: o.hw * 2, speed: s.speed });
    }
    poses.length = np;
    this.people.update(poses, time);
    for (const [id, d] of this.drawn) if (!seen.has(id)) this.drop(id, d);
    for (const [id, t] of this.tags) {
      if (seen.has(`tag:${id}`)) continue;
      this.group.remove(t.tag);
      disposeTag(t.tag);
      this.tags.delete(id);
    }
  }

  /** a name over somebody on foot */
  private tag(id: string, name: string, x: number, y: number, z: number, seen: Set<string>): void {
    let t = this.tags.get(id);
    if (t && t.text !== name) {
      this.group.remove(t.tag);
      disposeTag(t.tag);
      t = undefined;
    }
    if (!t) {
      t = { tag: nameTag(name), text: name };
      this.tags.set(id, t);
      this.group.add(t.tag);
    }
    t.tag.position.set(x, y, z);
    seen.add(`tag:${id}`);
  }

  private drop(id: string, d: Drawn): void {
    this.group.remove(d.root, d.tag);
    disposeTag(d.tag);
    // (the models are small to keep: let them go – a player who comes back gets a new one)
    d.root.traverse((o) => {
      if (o instanceof THREE.Mesh && d.key.startsWith('block:')) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.drawn.delete(id);
  }

  clear(): void {
    this.update([], 0, 0);
  }

  /**
   * The boxes as lines for the collider (sim/collision.ts: x1, z1, x2, z2, y per
   * side): the player's vehicle stops against them like against a wall.
   */
  segments(): Float32Array {
    const out = new Float32Array(this.boxes.length * 20);
    let i = 0;
    for (const b of this.boxes) {
      const s = Math.sin(b.yaw);
      const c = Math.cos(b.yaw);
      // (forward = (−sin, −cos); right = (cos, −sin))
      const hl = b.length / 2;
      const hw = b.width / 2;
      const corner = (f: number, r: number): [number, number] => [b.x - s * f + c * r, b.z - c * f - s * r];
      const pts = [corner(hl, -hw), corner(hl, hw), corner(-hl, hw), corner(-hl, -hw)];
      for (let k = 0; k < 4; k++) {
        const a = pts[k];
        const e = pts[(k + 1) % 4];
        out[i++] = a[0];
        out[i++] = a[1];
        out[i++] = e[0];
        out[i++] = e[1];
        out[i++] = b.y;
      }
    }
    return out;
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
