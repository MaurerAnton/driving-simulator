// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The parts that open and the seats of the car, in the game: what the game
 * (game/game.ts) asks of them through a few short hooks.
 *
 * On foot beside the vehicle one opens and shuts what is where one stands
 * – a door of the car, its bonnet or tailgate, the rear doors of a truck's
 * box, the back of a trailer – with the key . (full stop) or a button, and at a door
 * of the car one gets in with G or "Get in": into the seat of that door,
 * the driver's or a passenger's.  Getting in or out of the car is no fade
 * to black any more: the door opens, one moves between the street and the
 * seat, the door is pulled shut (the other vehicles keep their fade).
 *
 * In a passenger's seat the car is not driven: what the player's keys,
 * pedals and buttons would do to it is held off, the instructor's rules do
 * not judge, the HUD says where one sits.  The demonstration drive drives
 * on with the player beside the empty driver's seat or in the back –
 * watching it is what the passenger's seat is for.
 */
import type * as THREE from 'three';
import type { Controls } from '../input/input.ts';
import { tr } from '../i18n/index.ts';
import type { PlayerCar } from '../render/car.ts';
import { setTrailerOpen } from '../render/rearopen.ts';
import type { PlayerTruck } from '../render/truck.ts';
import { OpenButtons } from '../ui/openbuttons.ts';
import type { OpenButton } from '../ui/openbuttons.ts';
import { Boarding, CAR_OPENINGS, Openings, SEAT_EYE, carSpots, doorOfSeat, footActs, isDoor, nearestSpot, rearSpot } from './cardoors.ts';
import type { BoardStep, DoorId, OpeningEvent, OpeningId, OpeningSpot, SeatId } from './cardoors.ts';
import type { OnFoot, WalkVehicle } from './onfoot.ts';

/** What the car's controls would make it do: held off while a passenger sits in it. */
interface DriveOut {
  steer: number;
  throttle: number;
  brake: number;
  clutch: number;
  handbrake: number;
  gear: number;
  ignition: boolean;
  starter: boolean;
}

const SEAT_TEXT: Record<SeatId, string> = { driver: 'seatDriver', front: 'seatFront', rearLeft: 'seatRearLeft', rearRight: 'seatRearRight' };

/** the key that opens and shuts (game: input action 'open') */
export const OPEN_KEY = 'Period';

export class OpenPlay {
  readonly openings = new Openings();
  /** getting into a seat of the car or out of it, step by step */
  board: Boarding | null = null;
  seat: SeatId = 'driver';
  private spots: OpeningSpot[] = [];
  /** the person on foot the spots were found for (another – after a crash, out of the aeroplane – has none) */
  private spotsFor: OnFoot | null = null;
  private readonly carValues = new Float32Array(CAR_OPENINGS.length);
  private readonly pushed = new Map<object, number>();
  private readonly events: OpeningEvent[] = [];
  private held: { gear: number; ignition: boolean } | null = null;
  private ui: OpenButtons | null = null;

  get passenger(): boolean {
    return this.seat !== 'driver';
  }

  get busy(): boolean {
    return this.board !== null;
  }

  /** The camera on its way between the street and the seat, and how far it has come (0 … 1). */
  get blending(): boolean {
    return this.board?.phase === 'move';
  }

  get blend(): number {
    return this.board?.blend ?? 1;
  }

  /** A new drive (or another vehicle): everything shut, in the driver's seat. */
  reset(car: PlayerCar | null): void {
    this.openings.reset();
    this.board = null;
    this.spots = [];
    this.setSeat(car, 'driver');
  }

  /** Sit in this seat: the car's eye point moves there. */
  setSeat(car: PlayerCar | null, seat: SeatId): void {
    this.seat = seat;
    this.held = null;
    const e = SEAT_EYE[seat];
    car?.eye.set(e[0], e[1], e[2]);
  }

  /**
   * Somebody is on foot beside the vehicle (its parts as `wv` has them):
   * where its parts are opened – and, getting out of the car, the person
   * stands beside the door that was used.
   */
  walk(w: OnFoot, wv: WalkVehicle, car: PlayerCar | null, truck: boolean): void {
    const u = wv.units[0];
    const spots: OpeningSpot[] = [];
    if (u && car) {
      const sh = car.exterior.shell;
      spots.push(...carSpots(u, { frontAhead: wv.door, rearDoorRear: sh.zAxleR - 0.255, nose: sh.zFront, tail: sh.zRear }));
    } else if (u && truck) spots.push(rearSpot('body', u));
    const t = wv.units[1];
    if (t) spots.push(rearSpot('trailer', t));
    this.spots = spots;
    this.spotsFor = w;
    const b = this.board;
    if (b && b.way === 'out') {
      const s = spots.find((p) => p.id === b.door);
      if (s) {
        w.x = s.x;
        w.z = s.z;
      }
    }
  }

  /** What is where the person stands (null: nothing to open here). */
  at(w: OnFoot | null): OpeningSpot | null {
    return w && w === this.spotsFor ? nearestSpot(this.spots, w.x, w.z) : null;
  }

  /** Open or shut what is there; returns what it was (null: nothing). */
  toggleAt(w: OnFoot | null): OpeningId | null {
    const s = this.at(w);
    if (!s || this.board) return null;
    this.openings.toggle(s.id);
    return s.id;
  }

  /** Into the seat of this door of the car. */
  beginIn(door: DoorId): void {
    this.board = new Boarding('in', door);
  }

  /** Out of the car, through the door of the seat one sits in. */
  beginOut(): void {
    this.board = new Boarding('out', doorOfSeat(this.seat));
  }

  /**
   * One step: the parts move on, getting in or out goes on.  `click` gets
   * the sounds (a door opened, a door shut).
   */
  step(dt: number, click: (kind: 'door' | 'doorShut') => void): BoardStep {
    const ev = this.events;
    ev.length = 0;
    this.openings.step(dt, ev);
    for (const e of ev) click(e.what === 'opening' ? 'door' : 'doorShut');
    const b = this.board;
    if (!b) return { start: false, arrive: false, done: false };
    const r = b.step(dt, this.openings);
    if (r.done) this.board = null;
    return r;
  }

  /** Show the parts as far open as they are: the car's, a truck's box, a trailer's back. */
  pose(car: PlayerCar | null, truck: PlayerTruck | null, trailer: THREE.Object3D | null): void {
    const o = this.openings;
    if (car) {
      CAR_OPENINGS.forEach((id, i) => (this.carValues[i] = o.get(id)));
      car.setOpenings(this.carValues);
    }
    if (truck) this.push(truck.body, o.get('body'), (v) => truck.body.setDoors(v));
    if (trailer) this.push(trailer, o.get('trailer'), (v) => setTrailerOpen(trailer, v));
  }

  /** (only when it changed: the loading of goods works the truck's doors as well) */
  private push(key: object, v: number, set: (v: number) => void): void {
    if ((this.pushed.get(key) ?? 0) === v) return;
    this.pushed.set(key, v);
    set(v);
  }

  /**
   * In a passenger's seat: the car does nothing the player's controls say –
   * it stands as it was left (or the demonstration drive drives it, then
   * only the hands on the controls are held off, so as not to take it over).
   */
  idle(c: Controls, d: DriveOut, demo: boolean, parkedSteer: number): void {
    if (!this.passenger) return;
    c.steer = d.steer = parkedSteer;
    c.throttle = d.throttle = 0;
    c.brake = d.brake = 0;
    c.clutch = d.clutch = 0;
    d.starter = false;
    if (demo) {
      c.handbrake = d.handbrake = 0;
      this.held = null;
      return;
    }
    if (!this.held) this.held = { gear: c.gear, ignition: c.ignition };
    c.handbrake = d.handbrake = 1;
    c.gear = d.gear = this.held.gear;
    c.ignition = d.ignition = this.held.ignition;
  }

  /** The buttons near the person on foot (or none), and what a tap on them does. */
  buttons(parent: HTMLElement, list: readonly OpenButton[], onTap: (id: string) => void): void {
    if (!this.ui) {
      if (list.length === 0) return;
      this.ui = new OpenButtons(parent, onTap);
    }
    this.ui.show(list);
  }

  /** What can be done where the person stands: the tip line, and the buttons. */
  walkHud(w: OnFoot | null, touch: boolean, lang: string, canEnter: boolean): { tip: string; action: string; buttons: OpenButton[] } | null {
    const s = this.at(w);
    if (!s || this.board) return null;
    const o = this.openings;
    const acts = footActs(s.id, o, canEnter && isDoor(s.id));
    const what = this.label(s.id, o.wanted(s.id), lang);
    const buttons: OpenButton[] = acts.map((a) => ({ id: a, label: a === 'enter' ? tr('getInSeat', lang) : what }));
    if (isDoor(s.id) && canEnter) {
      const seat = tr(SEAT_TEXT[s.id === 'fl' ? 'driver' : s.id === 'fr' ? 'front' : s.id === 'rl' ? 'rearLeft' : 'rearRight'], lang);
      return { tip: tr(touch ? 'doorTipTouch' : o.wanted(s.id) ? 'doorTipOpen' : 'doorTip', lang, { seat }), action: 'KeyG', buttons };
    }
    return { tip: tr(touch ? 'openTipTouch' : 'openTip', lang, { what }), action: OPEN_KEY, buttons };
  }

  /** In a passenger's seat: where one sits, and how to get out (when the car stands). */
  seatTip(touch: boolean, lang: string, canGetOut: boolean): string {
    const seat = tr(SEAT_TEXT[this.seat], lang);
    return canGetOut ? tr(touch ? 'seatTipTouch' : 'seatTip', lang, { seat }) : tr('seatRiding', lang, { seat });
  }

  private label(id: OpeningId, open: boolean, lang: string): string {
    const k = isDoor(id) ? 'Door' : id === 'bonnet' ? 'Bonnet' : id === 'boot' ? 'Boot' : id === 'body' ? 'Rear' : 'Trailer';
    return tr(`${open ? 'close' : 'open'}${k}`, lang);
  }
}
