// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Traffic-light controllers: fixed-time programmes with the German sequence
 * green → amber → red → red+amber → green.
 *
 * Two things beyond that:
 *
 *  - Lights that are out of order.  A few controllers – other ones every
 *    day – show nothing but a flashing amber.  Their junctions are ruled by
 *    the signs that stand there, or by right before left (the world is told
 *    which ones when it is put together, see `World.lightsOut`).
 *
 *  - The green arrow: beside the light of some approaches hangs a second
 *    one with an arrow to the right.  It is lit while everybody whose way
 *    crosses that of the vehicles turning right has red: then turning right
 *    is allowed although the main light is red (§ 37 Abs. 2 Nr. 1 StVO).
 *    Which approaches have one is worked out from the paths through the
 *    junction (sim/arrows.ts).
 */
import { hash01 } from '../core/geom.ts';
import type { SignalControllerJson } from '../world/types.ts';
import type { Arm } from '../world/world.ts';

/** FLASH: out of order, flashing amber – no light at all as far as the rules go */
export const SIG = { RED: 0, RED_AMBER: 1, GREEN: 2, AMBER: 3, FLASH: 4 } as const;

const CODE: Record<string, number> = { R: SIG.RED, Y: SIG.RED_AMBER, G: SIG.GREEN, A: SIG.AMBER };

/** how long an arrow shows amber when its time is over (s) */
const ARROW_AMBER = 3;
/** a stream must have had red for this long before an arrow that crosses it comes on (s) */
const ARROW_CLEAR = 1.5;

/**
 * Which controllers are out of order: a `share` of them, picked by their
 * number and `seed` (the game gives the day, so that other lights are out
 * tomorrow).
 */
export function lightsOutBy(seed: number, share: number): (controller: number) => boolean {
  return (i) => share > 0 && hash01(i * 7919 + seed * 104729 + 17) < share;
}

/** The green arrow of an approach. */
export interface Arrow {
  /** the controller, and the group of the main light it hangs beside */
  controller: number;
  own: number;
  /** the groups that must have red while it is lit (those whose vehicles cross the way of the ones turning right) */
  foes: number[];
  /** the groups that must have green while it is lit (the people at a crossing the turn leads over have red then) */
  friends: number[];
  /** dark (-1), SIG.GREEN or SIG.AMBER */
  state: number;
  /** seconds in that state */
  since: number;
}

export class SignalSystem {
  /** by their number in the map – with gaps where the map is not loaded */
  readonly controllers: SignalControllerJson[];
  /** the green arrows, by the approach they belong to */
  readonly arrows = new Map<Arm, Arrow>();
  /** the numbers of the controllers that are running */
  private readonly ids: number[] = [];
  private readonly cycle: number[] = [];
  /** current state per controller and group */
  private readonly state: Uint8Array[] = [];
  /** seconds since the current state of a group began */
  private readonly since: Float32Array[] = [];
  /** out of order */
  private readonly dark: boolean[] = [];
  private readonly lightsOut: (controller: number) => boolean;
  time = 0;

  constructor(controllers: SignalControllerJson[], lightsOut: (controller: number) => boolean = () => false) {
    this.controllers = controllers;
    this.lightsOut = lightsOut;
    this.sync();
  }

  /**
   * Take up the controllers that were added to the list since (the road
   * network comes in pieces).  Each starts where its programme stands by the
   * clock, so that a junction shows the same lights whenever it is loaded.
   */
  sync(): void {
    let fresh = false;
    this.controllers.forEach((c, i) => {
      if (this.state[i]) return;
      this.ids.push(i);
      this.cycle[i] = c.phases.reduce((a, p) => a + p.d, 0);
      this.state[i] = new Uint8Array(c.groups);
      this.since[i] = new Float32Array(c.groups);
      // (the light of a pedestrian crossing is never out: people could not cross there otherwise)
      this.dark[i] = !c.ped && this.lightsOut(i);
      fresh = true;
    });
    if (fresh) this.update(0);
  }

  /** What group `g` of a controller shows `ahead` seconds from now (by its programme). */
  private programmed(i: number, g: number, ahead: number): number {
    const c = this.controllers[i];
    let t = (this.time + ahead + c.off) % this.cycle[i];
    if (t < 0) t += this.cycle[i];
    let phase = c.phases[c.phases.length - 1];
    for (const p of c.phases) {
      if (t < p.d) {
        phase = p;
        break;
      }
      t -= p.d;
    }
    return CODE[phase.s[Math.min(g, phase.s.length - 1)]] ?? SIG.RED;
  }

  update(dt: number): void {
    this.time += dt;
    for (const i of this.ids) {
      const c = this.controllers[i];
      const st = this.state[i];
      const since = this.since[i];
      for (let g = 0; g < c.groups; g++) {
        const s = this.programmed(i, g, 0);
        if (s !== st[g]) {
          st[g] = s;
          since[g] = 0;
        } else since[g] += dt;
      }
    }
    for (const a of this.arrows.values()) {
      const lit = this.arrowLit(a);
      if (lit) {
        if (a.state !== SIG.GREEN) {
          a.state = SIG.GREEN;
          a.since = 0;
        } else a.since += dt;
      } else if (a.state === SIG.GREEN) {
        // over: amber for a moment – unless the main light has just turned green, which says the same and more
        a.state = this.get(a.controller, a.own) === SIG.GREEN ? -1 : SIG.AMBER;
        a.since = 0;
      } else {
        a.since += dt;
        if (a.state === SIG.AMBER && (a.since >= ARROW_AMBER || this.get(a.controller, a.own) === SIG.GREEN)) {
          a.state = -1;
          a.since = 0;
        }
      }
    }
  }

  /** Should the arrow be lit now? */
  private arrowLit(a: Arrow): boolean {
    const st = this.state[a.controller];
    if (!st || this.dark[a.controller]) return false;
    const since = this.since[a.controller];
    const own = st[Math.min(a.own, st.length - 1)];
    // Only while the main light is red (with the full green the arrow is not needed) – and has been
    // for a moment: those who come the other way and turn left across have the same light.
    if (own !== SIG.RED_AMBER && !(own === SIG.RED && since[Math.min(a.own, st.length - 1)] >= ARROW_CLEAR)) return false;
    for (const g of a.foes) {
      if (g === a.own) continue;
      const s = st[Math.min(g, st.length - 1)];
      if (s !== SIG.RED || since[Math.min(g, st.length - 1)] < ARROW_CLEAR) return false;
      // … and the arrow has gone out a second before their red ends
      if (this.programmed(a.controller, g, ARROW_AMBER + 1) !== SIG.RED) return false;
    }
    for (const g of a.friends) if (st[Math.min(g, st.length - 1)] !== SIG.GREEN) return false;
    return true;
  }

  /** What a group shows; SIG.FLASH if its controller is out of order. */
  get(controller: number, group: number): number {
    const st = this.state[controller];
    if (!st) return SIG.GREEN;
    if (this.dark[controller]) return SIG.FLASH;
    return st[Math.min(group, st.length - 1)];
  }

  /** Seconds the group has been showing its current state. */
  age(controller: number, group: number): number {
    const s = this.since[controller];
    return s ? s[Math.min(group, s.length - 1)] : 0;
  }

  /** Is this controller out of order? */
  isDark(controller: number): boolean {
    return this.dark[controller] === true;
  }

  /**
   * What the green arrow of an approach shows: SIG.GREEN (those who turn
   * right may go although the main light is red), SIG.AMBER (its time is
   * over) or -1 (dark – or there is none).
   */
  arrow(arm: Arm): number {
    const a = this.arrows.get(arm);
    return a ? a.state : -1;
  }

  /**
   * How many seconds of a cycle an arrow with these groups would be lit
   * (to see whether it is worth putting one up).
   */
  arrowTime(controller: number, own: number, foes: number[], friends: number[]): number {
    const c = this.controllers[controller];
    const cycle = this.cycle[controller];
    if (!c || !cycle || this.dark[controller]) return 0;
    const step = 0.5;
    let lit = 0;
    // (from the programme alone: a group's state at a time, and for how long it has had it)
    const at = (g: number, t: number): number => this.programmed(controller, g, t - this.time);
    for (let t = 0; t < cycle; t += step) {
      const mine = at(own, t);
      let ok = mine === SIG.RED_AMBER || (mine === SIG.RED && at(own, t - ARROW_CLEAR) === SIG.RED);
      for (const g of foes) {
        if (g === own) continue;
        ok &&= at(g, t) === SIG.RED && at(g, t - ARROW_CLEAR) === SIG.RED && at(g, t + ARROW_AMBER + 1) === SIG.RED;
      }
      for (const g of friends) ok &&= at(g, t) === SIG.GREEN;
      if (ok) lit += step;
    }
    return lit;
  }
}
