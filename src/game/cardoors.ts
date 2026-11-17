// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The parts of a vehicle that open, and the seats of the car – the logic,
 * without anything drawn (render/caropen.ts and render/rearopen.ts move
 * the parts, game/openplay.ts puts it into the game).
 *
 * The car has six: its four side doors, the bonnet and the tailgate; a
 * truck's box body its two rear wing doors; a trailer its tailgate (the
 * car's box trailer) or its rear doors (the truck's).  Each is open by a
 * number from 0 (shut) to 1 (wide open) that moves towards where it is
 * wanted at the pace that part swings.
 *
 * Getting in or out of the car (Boarding) is three steps: the door of that
 * seat opens (unless it stands open already), one moves between the place
 * beside it and the seat, the door is pulled shut.  Each door belongs to
 * a seat: the front left one to the driver's, the front right one to the
 * front passenger's, the rear ones to the rear seats behind them.
 */

export type DoorId = 'fl' | 'fr' | 'rl' | 'rr';
export type OpeningId = DoorId | 'bonnet' | 'boot' | 'body' | 'trailer';
export type SeatId = 'driver' | 'front' | 'rearLeft' | 'rearRight';

export const DOORS: readonly DoorId[] = ['fl', 'fr', 'rl', 'rr'];
/** the car's parts in the order render/caropen.ts builds them */
export const CAR_OPENINGS: readonly OpeningId[] = ['fl', 'fr', 'rl', 'rr', 'bonnet', 'boot'];

const SEAT_OF: Record<DoorId, SeatId> = { fl: 'driver', fr: 'front', rl: 'rearLeft', rr: 'rearRight' };

export function isDoor(id: OpeningId): id is DoorId {
  return id === 'fl' || id === 'fr' || id === 'rl' || id === 'rr';
}

/** The seat a door leads to. */
export function seatOfDoor(door: DoorId): SeatId {
  return SEAT_OF[door];
}

/** The door beside a seat. */
export function doorOfSeat(seat: SeatId): DoorId {
  return seat === 'driver' ? 'fl' : seat === 'front' ? 'fr' : seat === 'rearLeft' ? 'rl' : 'rr';
}

/** Where the eyes are in each seat of the car (car frame: x right, y up, −z ahead). */
export const SEAT_EYE: Record<SeatId, readonly [number, number, number]> = {
  driver: [-0.36, 1.2, 0.2],
  front: [0.36, 1.2, 0.2],
  rearLeft: [-0.36, 1.16, 1.2],
  rearRight: [0.36, 1.16, 1.2],
};

/** seconds a part takes from shut to wide open */
const SWING: Record<OpeningId, number> = { fl: 0.75, fr: 0.75, rl: 0.75, rr: 0.75, bonnet: 1.3, boot: 1.3, body: 2.4, trailer: 1.8 };

/** What happened to a part in a step: it began to open, or it came to be shut. */
export interface OpeningEvent {
  id: OpeningId;
  what: 'opening' | 'shut';
}

/** How far each part is open, and where it is going. */
export class Openings {
  private readonly value = new Map<OpeningId, number>();
  private readonly target = new Map<OpeningId, number>();

  /** How far it is open now: 0 shut … 1 wide open. */
  get(id: OpeningId): number {
    return this.value.get(id) ?? 0;
  }

  /** Whether it is being opened (or stands open) – rather than being shut (or shut). */
  wanted(id: OpeningId): boolean {
    return (this.target.get(id) ?? 0) > 0.5;
  }

  set(id: OpeningId, open: boolean): void {
    this.target.set(id, open ? 1 : 0);
  }

  /** Open it if it is shut or being shut, shut it otherwise; returns whether it is now to be open. */
  toggle(id: OpeningId): boolean {
    const open = !this.wanted(id);
    this.set(id, open);
    return open;
  }

  /** Anything not quite shut? */
  get anyOpen(): boolean {
    for (const v of this.value.values()) if (v > 0) return true;
    for (const t of this.target.values()) if (t > 0) return true;
    return false;
  }

  /** Move every part on by `dt` seconds; `events` gets what began to open and what came to be shut. */
  step(dt: number, events: OpeningEvent[] = []): OpeningEvent[] {
    for (const [id, t] of this.target) {
      const v = this.value.get(id) ?? 0;
      if (v === t) continue;
      const k = dt / SWING[id];
      const n = t > v ? Math.min(t, v + k) : Math.max(t, v - k);
      if (v === 0 && n > 0) events.push({ id, what: 'opening' });
      if (n === 0) events.push({ id, what: 'shut' });
      this.value.set(id, n);
    }
    return events;
  }

  /** Everything shut at once (a new drive). */
  reset(): void {
    this.value.clear();
    this.target.clear();
  }
}

/** A place on the ground where one stands to open something (world x, z), and what. */
export interface OpeningSpot {
  id: OpeningId;
  x: number;
  z: number;
}

/** A part of the vehicle in the plan: as game/onfoot.ts WalkUnit has it. */
export interface SpotUnit {
  x: number;
  z: number;
  yaw: number;
  front: number;
  rear: number;
  hw: number;
}

/** The point `ahead` metres ahead of and `right` metres to the right of a unit's origin. */
function at(u: SpotUnit, ahead: number, right: number): { x: number; z: number } {
  const s = Math.sin(u.yaw);
  const c = Math.cos(u.yaw);
  return { x: u.x - s * ahead + c * right, z: u.z - c * ahead - s * right };
}

/**
 * Where one stands for each of the car's parts: beside each door (the front
 * ones where the driver stands to get in, `frontAhead` metres ahead of the
 * origin; the rear ones a little ahead of their rear edge, clear of where
 * they swing), in front of the bonnet, behind the tailgate.  `edges`: z
 * (car frame, −z ahead) of the rear doors' rear edge, of the nose and of
 * the tail.
 */
export function carSpots(u: SpotUnit, edges: { frontAhead: number; rearDoorRear: number; nose: number; tail: number }): OpeningSpot[] {
  const side = u.hw + 0.6;
  const list: Array<[OpeningId, number, number]> = [
    ['fl', edges.frontAhead, -side],
    ['fr', edges.frontAhead, side],
    ['rl', -(edges.rearDoorRear - 0.2), -side],
    ['rr', -(edges.rearDoorRear - 0.2), side],
    ['bonnet', -edges.nose + 0.75, 0],
    ['boot', -edges.tail - 0.75, 0],
  ];
  return list.map(([id, ahead, right]) => ({ id, ...at(u, ahead, right) }));
}

/** The spot behind a unit (its rear doors, its tailgate). */
export function rearSpot(id: OpeningId, u: SpotUnit): OpeningSpot {
  return { id, ...at(u, -u.rear - 0.8, 0) };
}

/** The spot nearest to (x, z) within `reach` metres, if any. */
export function nearestSpot(spots: readonly OpeningSpot[], x: number, z: number, reach = 1.2): OpeningSpot | null {
  let best: OpeningSpot | null = null;
  let bestD = reach;
  for (const s of spots) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** What one can do standing at a part: open or shut it – and at a door of the car, get in there. */
export type FootAct = 'open' | 'close' | 'enter';

export function footActs(id: OpeningId, openings: Openings, canEnter: boolean): FootAct[] {
  const out: FootAct[] = [openings.wanted(id) ? 'close' : 'open'];
  if (isDoor(id) && canEnter) out.push('enter');
  return out;
}

export type BoardPhase = 'open' | 'move' | 'close' | 'done';

/** seconds from beside the door into the seat, or out of it */
export const MOVE_TIME = 0.85;

/** What a step of getting in or out brought. */
export interface BoardStep {
  /** the move between seat and street began (in: one leaves the street; out: one is put beside the door) */
  start: boolean;
  /** the move ended (in: one sits) */
  arrive: boolean;
  /** the door is shut again: all done */
  done: boolean;
}

/**
 * Getting into a seat of the car or out of it: the door of that seat opens,
 * one moves, the door is shut.  Driven by the parts' numbers in `Openings`
 * (the door's swing sets the pace of the first and the last step).
 */
export class Boarding {
  phase: BoardPhase = 'open';
  /** seconds into the move */
  private t = 0;
  readonly way: 'in' | 'out';
  readonly door: DoorId;
  readonly seat: SeatId;

  constructor(way: 'in' | 'out', door: DoorId) {
    this.way = way;
    this.door = door;
    this.seat = seatOfDoor(door);
  }

  /** How far the camera has come from where it was to where it goes: 0 … 1 (eased). */
  get blend(): number {
    if (this.phase === 'open') return 0;
    if (this.phase !== 'move') return 1;
    const k = Math.min(1, this.t / MOVE_TIME);
    return k * k * (3 - 2 * k);
  }

  step(dt: number, o: Openings): BoardStep {
    const r: BoardStep = { start: false, arrive: false, done: false };
    if (this.phase === 'open') {
      o.set(this.door, true);
      // (wide enough to pass a little before it is fully open)
      if (o.get(this.door) >= 0.85) {
        this.phase = 'move';
        this.t = 0;
        r.start = true;
      }
    } else if (this.phase === 'move') {
      this.t += dt;
      if (this.t >= MOVE_TIME) {
        this.phase = 'close';
        r.arrive = true;
        o.set(this.door, false);
      }
    } else if (this.phase === 'close') {
      o.set(this.door, false);
      if (o.get(this.door) <= 0) {
        this.phase = 'done';
        r.done = true;
      }
    }
    return r;
  }
}
