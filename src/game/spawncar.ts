// SPDX-License-Identifier: AGPL-3.0-only
/**
 * "A car here": on foot – or at the controls of a crane – the player can have
 * a car put down beside them, at a place tapped on the 3D picture, or at a
 * place chosen on the large map.  It stands there, engine off, until it is
 * tapped (or the door key is pressed beside it): then the player sits in it,
 * and a free drive with it begins where it stands.  The vehicle driven till
 * then stays where it was left – and can be tapped to be driven again.
 *
 * Only where the world is in memory (the loaded tiles, a dashed line round
 * them on the large map) and only where a car stands free: in the lane of the
 * nearest road if there is one near – or, with "place precisely", at the
 * very place chosen – never in a wall nor inside a building (the reckoning:
 * game/spawnplace.ts).
 *
 * The button: a round one at the left edge, shown whenever a car may be put
 * down.  A tap on it, then a tap on the ground: the car stands there.  A
 * second tap on the button instead: beside the player.  The game (game.ts)
 * tells this what it needs through `SpawnCarHost`, and does the change of
 * vehicle itself (`enter`).
 */

import * as THREE from 'three';
import { CarExterior } from '../render/car.ts';
import type { SceneryCollider } from '../sim/collision.ts';
import type { VehicleKind } from './vehicles.ts';
import { Footprints, LoadedArea, besidePlace, freeNear, inBuilding, outlinePoints, rayBox, rayGround } from './spawnplace.ts';
import type { Outline, TileBox } from './spawnplace.ts';

/** A vehicle standing on the map that the player can get into. */
export interface Parked {
  kind: VehicleKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  outline: Outline;
  height: number;
  /** what draws it */
  root: THREE.Object3D;
  /** drawn by a car of this module's own (else by the game's model of that vehicle, left where it stood) */
  own: boolean;
}

/** The vehicle the player leaves behind when getting into a parked one (root null: a car – drawn by one of this module's own). */
export interface LeftVehicle {
  kind: VehicleKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  outline: Outline;
  height: number;
  root: THREE.Object3D | null;
}

export interface SpawnCarHost {
  scene: THREE.Scene;
  camera: THREE.Camera;
  canvas: HTMLCanvasElement;
  /** where the button goes */
  ui: HTMLElement;
  collider: SceneryCollider;
  /** the terrain's height (NaN: not loaded) and the height of what one stands on there (a road, a bridge) */
  heightAt(x: number, z: number): number;
  ground(x: number, z: number): number;
  /** may a car be put down now (on foot, at a crane – in a free drive)? may a parked vehicle be got into now? */
  canSpawn(): boolean;
  canEnter(): boolean;
  /** where the player is (on foot: the person; at a crane: the crane) and which way they face */
  player(): { x: number; z: number; yaw: number };
  /** what a car must keep clear of besides the scenery: the player's vehicle and the person on foot (circles x, z, r) */
  others(): ReadonlyArray<{ x: number; z: number; r: number }>;
  /** a place in a lane of a road near (x, z) – the roads round there are loaded – or null */
  roadSpot(x: number, z: number, maxDist: number): { x: number; z: number; yaw: number } | null;
  /** "place precisely": at the very place chosen, not in the nearest lane */
  exact(): boolean;
  /** the car's paint */
  paint(): number;
  /** the car being put down: its outline */
  carOutline: Outline;
  /** into it: the game begins a free drive with it there */
  enter(p: Parked): void;
  tip(text: string): void;
  t(key: string): string;
}

/** a car's height (m), for a tap on it */
const CAR_HEIGHT = 1.6;

export class SpawnCars {
  readonly area = new LoadedArea();
  readonly footprints = new Footprints();
  /** the car put down, waiting; the vehicle left behind */
  car: Parked | null = null;
  left: Parked | null = null;
  /** the button was tapped: the next tap on the ground puts the car there */
  picking = false;
  private readonly host: SpawnCarHost;
  private readonly button: HTMLButtonElement;
  private shown = false;
  /** the cars of this module's own (at most two are needed: the one put down, a car left behind) */
  private readonly pool: CarExterior[] = [];
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private down: { id: number; x: number; y: number; t: number } | null = null;

  constructor(host: SpawnCarHost) {
    this.host = host;
    const b = (this.button = document.createElement('button'));
    b.type = 'button';
    b.className = 'spawn-car';
    // (styled here: one round button at the left edge, below the middle – the middle of the screen stays free)
    Object.assign(b.style, {
      position: 'absolute',
      left: '12px',
      top: '58%',
      width: '56px',
      height: '56px',
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.75)',
      background: 'rgba(16,24,34,0.72)',
      color: '#fff',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0',
      zIndex: '6',
      pointerEvents: 'auto',
      touchAction: 'manipulation',
    } satisfies Partial<CSSStyleDeclaration>);
    b.innerHTML =
      '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 15v-3l2-4h9l3 4h2a2 2 0 0 1 2 2v1h-2"/><circle cx="7" cy="16" r="1.8"/><circle cx="16" cy="16" r="1.8"/><path d="M9 16h5"/><path d="M19 3v6M16 6h6"/></svg>';
    b.onclick = (e) => {
      e.stopPropagation();
      this.pressed();
    };
    host.ui.append(b);
    const c = host.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    });
    c.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10 || performance.now() - d.t > 450) return;
      this.tap(e.clientX, e.clientY);
    });
  }

  /** A tile of the world came or went: the loaded area, the footprints of its buildings. */
  tile(key: string, box: TileBox, pts: ArrayLike<number> | null, counts: ArrayLike<number> | null, loaded: boolean): void {
    this.area.set(key, box, loaded);
    if (loaded) this.footprints.set(key, pts, counts);
    else this.footprints.remove(key);
  }

  /** Every frame: the button shown when a car may be put down. */
  frame(): void {
    const on = this.host.canSpawn();
    if (!on) this.picking = false;
    if (on !== this.shown) {
      this.shown = on;
      this.button.style.display = on ? 'flex' : 'none';
    }
    if (on) {
      const label = this.host.t('spawnCar');
      if (this.button.title !== label) {
        this.button.title = label;
        this.button.setAttribute('aria-label', label);
      }
      this.button.style.background = this.picking ? 'rgba(56,182,255,0.85)' : 'rgba(16,24,34,0.72)';
    }
  }

  private pressed(): void {
    if (!this.host.canSpawn()) return;
    if (!this.picking) {
      this.picking = true;
      this.host.tip(this.host.t('spawnCarPick'));
      return;
    }
    this.picking = false;
    this.spawnBeside();
  }

  /**
   * Is a car free standing at (x, z), facing yaw: on the loaded area, on
   * known ground, in no wall, inside no building – and (`others`) clear of
   * the player and the player's vehicle.
   */
  free(x: number, z: number, yaw: number, o: Outline = this.host.carOutline, others = true): boolean {
    const h = this.host;
    if (!this.area.has(x, z, Math.max(o.front, o.rear) + 2) || Number.isNaN(h.heightAt(x, z))) return false;
    if (inBuilding(x, z, yaw, o, (px, pz) => this.footprints.inside(px, pz))) return false;
    const y = h.ground(x, z);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    // (circles along its axis, as wide as the car, a hand's breadth to spare)
    const r = o.hw + 0.15;
    const near = others ? h.others() : [];
    for (let a = -o.rear + o.hw; a <= o.front - o.hw + 0.01; a += Math.max(0.5, o.hw)) {
      const cx = x + fx * a;
      const cz = z + fz * a;
      if (h.collider.circleBlocked(cx, y, cz, r)) return false;
      for (const k of near) if (Math.hypot(cx - k.x, cz - k.z) < r + k.r) return false;
    }
    return true;
  }

  /** May a car be put at (x, z)?  (On the loaded area, a few metres inside its edge.) */
  canPlaceAt(x: number, z: number): boolean {
    return this.area.has(x, z, 6) && !Number.isNaN(this.host.heightAt(x, z));
  }

  /** The car, beside the player (in the lane of the road there, if one is near). */
  spawnBeside(): boolean {
    const p = this.host.player();
    const ok = (x: number, z: number, yaw: number): boolean => this.free(x, z, yaw);
    let at: { x: number; z: number; yaw: number } | null = null;
    if (!this.host.exact()) {
      const road = this.host.roadSpot(p.x, p.z, 40);
      if (road) at = freeNear(road.x, road.z, road.yaw, ok, 12);
    }
    at ??= besidePlace(p.x, p.z, p.yaw, ok);
    return this.put(at);
  }

  /** The car at a place chosen (tapped on the 3D picture, or on the map). */
  spawnAt(x: number, z: number, yaw?: number): boolean {
    const h = this.host;
    if (!this.canPlaceAt(x, z)) {
      h.tip(h.t('spawnCarOutside'));
      return false;
    }
    const ok = (px: number, pz: number, py: number): boolean => this.free(px, pz, py);
    let at: { x: number; z: number; yaw: number } | null = null;
    if (!h.exact()) {
      const road = h.roadSpot(x, z, 60);
      if (road) at = freeNear(road.x, road.z, road.yaw, ok, 15);
    }
    if (!at) {
      // (facing along the road nearest, if one is near; else the way the player faces)
      const road = h.roadSpot(x, z, 30);
      at = freeNear(x, z, yaw ?? road?.yaw ?? h.player().yaw, ok, 20);
    }
    return this.put(at);
  }

  private put(at: { x: number; z: number; yaw: number } | null): boolean {
    const h = this.host;
    if (!at) {
      h.tip(h.t('spawnCarNoRoom'));
      return false;
    }
    if (this.car) this.drop(this.car, 'car');
    const ext = this.exterior();
    const y = h.ground(at.x, at.z);
    this.car = { kind: 'car', x: at.x, y, z: at.z, yaw: at.yaw, outline: h.carOutline, height: CAR_HEIGHT, root: ext.group, own: true };
    this.stand(this.car, 'car');
    h.tip(h.t('spawnCarReady'));
    return true;
  }

  /** A car of this module's own that is not in use, painted as the player's. */
  private exterior(): CarExterior {
    let e = this.pool.find((x) => x.group.parent === null);
    if (!e) {
      e = new CarExterior(0xc9cdd2, { plate: 'KS FS 2026', seeThroughGlass: true, roofSign: true, noMirrorHousings: true, lettering: 'maureranton.com', ownMaterials: true });
      this.pool.push(e);
    }
    e.paint.color.setHex(this.host.paint());
    return e;
  }

  /** A parked vehicle in its place: drawn (if it is one of ours), and in the way of others. */
  private stand(p: Parked, slot: 'car' | 'left'): void {
    if (p.own) {
      p.root.position.set(p.x, p.y + 0.02, p.z);
      p.root.rotation.set(0, p.yaw, 0);
      p.root.visible = true;
      this.host.scene.add(p.root);
      p.root.updateMatrixWorld(true);
    }
    const pts = outlinePoints(p.x, p.z, p.yaw, p.outline).slice(6);
    // (the corners in order round it: front right, front left, rear left, rear right)
    const ring = Float32Array.of(pts[0], pts[1], pts[2], pts[3], pts[6], pts[7], pts[4], pts[5]);
    this.host.collider.add({ key: `parked:${slot}`, rings: ring, ringCounts: Uint16Array.of(4), segments: null, discs: [] });
  }

  /** A parked vehicle gone: out of the way, and ours back into the pool. */
  private drop(p: Parked, slot: 'car' | 'left'): void {
    this.host.collider.remove(`parked:${slot}`);
    if (p.own) this.host.scene.remove(p.root);
    if (slot === 'car') this.car = null;
    else this.left = null;
  }

  /** Is this the model of the vehicle left behind (the game keeps it drawn where it stands)? */
  keeps(root: THREE.Object3D): boolean {
    return !!this.left && !this.left.own && this.left.root === root;
  }

  /**
   * The player gets into `p`: it is no longer parked – and the vehicle driven
   * till now (if it is one that can stay) is left standing where it is.
   */
  swap(p: Parked, from: LeftVehicle | null): void {
    if (this.car === p) this.drop(p, 'car');
    if (this.left === p) this.drop(p, 'left');
    if (this.left) this.drop(this.left, 'left');
    if (!from) return;
    const root = from.root ?? this.exterior().group;
    this.left = { kind: from.kind, x: from.x, y: from.y, z: from.z, yaw: from.yaw, outline: from.outline, height: from.height, root, own: from.root === null };
    if (this.left.own) this.left.y = this.host.ground(from.x, from.z);
    this.stand(this.left, 'left');
  }

  /** Nothing parked any more (back to the menu). */
  clear(): void {
    if (this.car) this.drop(this.car, 'car');
    if (this.left) this.drop(this.left, 'left');
    this.picking = false;
  }

  /** The parked vehicle somebody on foot at (x, z) stands beside (within `reach` metres of its outline), or null. */
  near(x: number, z: number, reach = 1.6): Parked | null {
    for (const p of [this.car, this.left]) {
      if (!p) continue;
      const dx = x - p.x;
      const dz = z - p.z;
      const along = -dx * Math.sin(p.yaw) - dz * Math.cos(p.yaw);
      const side = dx * Math.cos(p.yaw) - dz * Math.sin(p.yaw);
      if (along <= p.outline.front + reach && along >= -p.outline.rear - reach && Math.abs(side) <= p.outline.hw + reach) return p;
    }
    return null;
  }

  /** A tap on the 3D picture: into a parked vehicle tapped – or, after the button, the car put down where the ground was tapped. */
  /** Is a tap at (cx, cy) this module's – a place for a car being picked, or a parked vehicle tapped to get in (for the other taps on the picture: ui/worldtap.ts)? */
  claims(cx: number, cy: number): boolean {
    if (this.picking) return true;
    const h = this.host;
    if ((!this.car && !this.left) || !h.canEnter()) return false;
    const r = h.canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    this.ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, h.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    for (const p of [this.car, this.left]) {
      if (!p) continue;
      const t = rayBox(o.x, o.y, o.z, d.x, d.y, d.z, { x: p.x, y: p.y, z: p.z, yaw: p.yaw, height: p.height, ...p.outline });
      if (t >= 0 && t < 400) return true;
    }
    return false;
  }

  private tap(cx: number, cy: number): void {
    const h = this.host;
    const enter = h.canEnter();
    if (!enter && !this.picking) return;
    if (!this.car && !this.left && !this.picking) return;
    const r = h.canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, h.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    if (enter) {
      let best: Parked | null = null;
      let bt = Infinity;
      for (const p of [this.car, this.left]) {
        if (!p) continue;
        const t = rayBox(o.x, o.y, o.z, d.x, d.y, d.z, { x: p.x, y: p.y, z: p.z, yaw: p.yaw, height: p.height, ...p.outline });
        if (t >= 0 && t < bt) {
          bt = t;
          best = p;
        }
      }
      if (best && bt < 400) {
        this.picking = false;
        h.enter(best);
        return;
      }
    }
    if (this.picking && h.canSpawn()) {
      const g = rayGround(o.x, o.y, o.z, d.x, d.y, d.z, (x, z) => h.heightAt(x, z));
      if (!g) return;
      this.picking = false;
      this.spawnAt(g.x, g.z);
    }
  }
}
