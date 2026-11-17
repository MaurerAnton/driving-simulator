// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Traffic-light controllers: fixed-time programmes with the German sequence
 * green → amber → red → red+amber → green.
 *
 * Three things beyond that:
 *
 *  - The light of a pedestrian crossing (one that belongs to no junction)
 *    waits on green for the vehicles until somebody presses the button at
 *    its pole ("Signal kommt"): then, after a least green for the vehicles,
 *    the programme runs once through the pedestrians' time and comes back to
 *    rest.  The people of the traffic press it as well.
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
 *
 *  - How long a light still shows what it shows (`change`, for the small
 *    timers over the heads: ui/signaltimers.ts) – and, on a tap on such a
 *    timer, the programme put forward to the end of the phase that runs
 *    (`skip`).  Only a main phase is cut short, never an amber, a red-amber
 *    or the moment of red for all between them, and none to less than a few
 *    seconds: the light goes on through its sequence as always, and whoever
 *    has just got green still gets going.
 */
import { hash01 } from '../core/geom.ts';
import type { SignalControllerJson } from '../world/types.ts';
import type { Arm } from '../world/world.ts';

/** FLASH: out of order, flashing amber – no light at all as far as the rules go */
export const SIG = { RED: 0, RED_AMBER: 1, GREEN: 2, AMBER: 3, FLASH: 4 } as const;

const CODE: Record<string, number> = { R: SIG.RED, Y: SIG.RED_AMBER, G: SIG.GREEN, A: SIG.AMBER };

/** a pedestrian crossing's light gives the vehicles at least this much green before a press is served (s) */
const PED_LEAST_GREEN = 8;
/** the vehicles have had red this long when the pedestrians get green (s) */
export const PED_CLEAR = 1.5;

/** how long an arrow shows amber when its time is over (s) */
const ARROW_AMBER = 3;
/** a stream must have had red for this long before an arrow that crosses it comes on (s) */
const ARROW_CLEAR = 1.5;

/** a phase cut short by a tap on its timer still runs this long from its start (s): the first car gets going, people on foot get across */
export const SKIP_LEAST = 6;
/** phases this short or shorter are the change between two main phases (all red), never cut short (s) */
const CLEARANCE = 2;

/** What a light is going to do: in how many seconds, and what it shows then (SIG; −1: dark, for an arrow). */
export interface SignalChange {
  left: number;
  next: number;
}

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

/** What the controllers around a place showed at a moment (SignalSystem.snapshot) – for a replay to show it again. */
export interface SignalSnapshot {
  time: number;
  ids: Int32Array;
  /** per controller: how many groups (the states and ages follow in that order), its own clock, its request */
  groups: Uint8Array;
  local: Float32Array;
  asked: Uint8Array;
  states: Uint8Array;
  ages: Float32Array;
  arrows: Array<[Arm, number, number]>;
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
  /**
   * A pedestrian crossing's own clock in its programme (it stands still at
   * rest) – for the other controllers, how far a tap on a timer has put their
   * programme forward (`skip`) –, and whether the button was pressed.
   */
  private readonly local: number[] = [];
  private readonly asked: boolean[] = [];
  private readonly lightsOut: (controller: number) => boolean;
  /** when each green arrow is going to change next (worked out once, again after it changed or a programme was put forward) */
  private readonly arrowNext = new Map<Arm, { state: number; at: number; next: number; epoch: number }>();
  /** counts every skip and restore: what was worked out ahead before is out of date */
  private epoch = 0;
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
      // (… and it begins at rest: green for the vehicles, long enough that a press is served soon)
      this.local[i] = c.ped ? Math.min(PED_LEAST_GREEN, c.phases[0]?.d ?? 0) : 0;
      this.asked[i] = false;
      fresh = true;
    });
    if (fresh) this.update(0);
  }

  /** What group `g` of a controller shows `ahead` seconds from now (by its programme). */
  private programmed(i: number, g: number, ahead: number): number {
    const c = this.controllers[i];
    let t = ((c.ped ? this.local[i] : this.time + c.off + this.local[i]) + ahead) % this.cycle[i];
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
      if (c.ped) {
        // at rest on the vehicles' green until the button is pressed; then once round
        const green = c.phases[0]?.d ?? 0;
        let t = this.local[i] + dt;
        if (this.local[i] < green) {
          if (this.asked[i] && t >= PED_LEAST_GREEN) t = Math.max(t, green);
          else t = Math.min(t, green - 0.01);
        }
        // (a request is used up when the pedestrians get green – one made after that waits for the next round)
        if (t >= this.cycle[i]) t -= this.cycle[i];
        this.local[i] = t;
      }
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
   * The button at a pedestrian light is pressed.  A pedestrian crossing's
   * light then soon gives the pedestrians green; at a junction the light runs
   * by its programme all the same – the lamp on the box says the request was
   * taken either way.  Returns whether it was new.
   */
  request(controller: number): boolean {
    if (!this.state[controller] || this.dark[controller] || this.asked[controller]) return false;
    this.asked[controller] = true;
    return true;
  }

  /**
   * The state of the controllers within `radius` of (x, z): what each group
   * shows and for how long, the crossings' own clocks and requests, the
   * arrows.  `restore` puts it back (a replay; the live state around it).
   */
  snapshot(x: number, z: number, radius: number): SignalSnapshot {
    const ids: number[] = [];
    const groups: number[] = [];
    const local: number[] = [];
    const asked: number[] = [];
    const states: number[] = [];
    const ages: number[] = [];
    const near = new Set<number>();
    for (const i of this.ids) {
      const c = this.controllers[i];
      const st = this.state[i];
      if (!c || !st || Math.abs(c.x - x) > radius || Math.abs(c.z - z) > radius) continue;
      near.add(i);
      ids.push(i);
      groups.push(st.length);
      local.push(this.local[i] ?? 0);
      asked.push(this.asked[i] ? 1 : 0);
      for (let g = 0; g < st.length; g++) {
        states.push(st[g]);
        ages.push(this.since[i][g]);
      }
    }
    const arrows: Array<[Arm, number, number]> = [];
    for (const [arm, a] of this.arrows) if (near.has(a.controller)) arrows.push([arm, a.state, a.since]);
    return { time: this.time, ids: Int32Array.from(ids), groups: Uint8Array.from(groups), local: Float32Array.from(local), asked: Uint8Array.from(asked), states: Uint8Array.from(states), ages: Float32Array.from(ages), arrows };
  }

  /** Put back what `snapshot` took (controllers no longer loaded are left out). */
  restore(s: SignalSnapshot): void {
    this.time = s.time;
    this.epoch++;
    let k = 0;
    for (let n = 0; n < s.ids.length; n++) {
      const i = s.ids[n];
      const count = s.groups[n];
      const st = this.state[i];
      if (st && st.length === count) {
        this.local[i] = s.local[n];
        this.asked[i] = s.asked[n] === 1;
        for (let g = 0; g < count; g++) {
          st[g] = s.states[k + g];
          this.since[i][g] = s.ages[k + g];
        }
      }
      k += count;
    }
    for (const [arm, state, since] of s.arrows) {
      const a = this.arrows.get(arm);
      if (a) {
        a.state = state;
        a.since = since;
      }
    }
  }

  /** Is a request waiting at this controller ("Signal kommt")? */
  requested(controller: number): boolean {
    return this.asked[controller] === true;
  }

  /**
   * What the pedestrians see at a crossing whose vehicles have group `g`:
   * green while those vehicles have had red for a moment, red otherwise –
   * dark when the light is out of order.  (A request is taken back once the
   * pedestrians have green: the lamp "Signal kommt" goes out.)
   */
  pedestrian(controller: number, group: number): 'green' | 'red' | 'dark' {
    const st = this.get(controller, group);
    if (st === SIG.FLASH) return 'dark';
    const go = st === SIG.RED && this.age(controller, group) > PED_CLEAR;
    if (go) this.asked[controller] = false;
    return go ? 'green' : 'red';
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

  /** Where a controller's programme stands: the phase (its index), how long it has run, how long it has left. */
  private phaseAt(i: number): { k: number; into: number; left: number } {
    const c = this.controllers[i];
    const cycle = this.cycle[i];
    let t = (((c.ped ? this.local[i] : this.time + c.off + this.local[i]) % cycle) + cycle) % cycle;
    for (let k = 0; k < c.phases.length; k++) {
      const d = c.phases[k].d;
      if (t < d) return { k, into: t, left: d - t };
      t -= d;
    }
    const k = c.phases.length - 1;
    return { k, into: c.phases[k].d, left: 0 };
  }

  /** What group `g` shows in phase `k` of controller `i`'s programme. */
  private codeOf(i: number, k: number, g: number): number {
    const s = this.controllers[i].phases[k].s;
    return CODE[s[Math.min(g, s.length - 1)]] ?? SIG.RED;
  }

  /**
   * When group `group` of a controller changes next, and to what.  Infinity
   * while a pedestrian crossing's light rests on the vehicles' green with
   * nobody asking (it waits for the button).  Null where there is nothing to
   * count: no such controller running, or it is out of order.
   */
  change(controller: number, group: number): SignalChange | null {
    const c = this.controllers[controller];
    if (!c || !this.state[controller] || this.dark[controller] || c.phases.length === 0) return null;
    const n = c.phases.length;
    const { k, into, left } = this.phaseAt(controller);
    const now = this.codeOf(controller, k, group);
    let sum = left;
    if (c.ped && k === 0) {
      // at rest until somebody asks – then after the least green
      if (!this.asked[controller]) return { left: Infinity, next: this.codeOf(controller, 1 % n, group) };
      sum = Math.max(0, PED_LEAST_GREEN - into);
    }
    for (let j = 1; j <= n; j++) {
      const kk = (k + j) % n;
      const s = this.codeOf(controller, kk, group);
      if (s !== now) return { left: sum, next: s };
      // (round to the resting phase of a pedestrian crossing: there it waits for the button)
      if (c.ped && kk === 0) return { left: Infinity, next: this.codeOf(controller, 1 % n, group) };
      sum += c.phases[kk].d;
    }
    return { left: Infinity, next: now };
  }

  /** In how many seconds group `group` begins to show `want` (0: it shows it now) – Infinity where it does not before a crossing's light rests. */
  private until(i: number, group: number, want: number): number {
    const c = this.controllers[i];
    const n = c.phases.length;
    const { k, into, left } = this.phaseAt(i);
    if (this.codeOf(i, k, group) === want) return 0;
    let sum = left;
    if (c.ped && k === 0) {
      if (!this.asked[i]) return Infinity;
      sum = Math.max(0, PED_LEAST_GREEN - into);
    }
    for (let j = 1; j <= n; j++) {
      const kk = (k + j) % n;
      if (this.codeOf(i, kk, group) === want) return sum;
      if (c.ped && kk === 0) return Infinity;
      sum += c.phases[kk].d;
    }
    return Infinity;
  }

  /**
   * When the pedestrians' light at a crossing whose vehicles have group
   * `group` changes next: `next` is SIG.GREEN or SIG.RED – of the people on
   * foot.  Null where the light is out of order.
   */
  pedestrianChange(controller: number, group: number): SignalChange | null {
    const veh = this.change(controller, group);
    if (!veh) return null;
    if (this.get(controller, group) === SIG.RED) {
      const age = this.age(controller, group);
      // (green for them a moment after the vehicles got red; red again when the vehicles get red-amber)
      return age > PED_CLEAR ? { left: veh.left, next: SIG.RED } : { left: PED_CLEAR - age, next: SIG.GREEN };
    }
    return { left: this.until(controller, group, SIG.RED) + PED_CLEAR, next: SIG.GREEN };
  }

  /**
   * When the green arrow of an approach changes next: `next` is SIG.GREEN,
   * SIG.AMBER or −1 (dark).  Null where there is none, or its light is out of
   * order.  (Looked for in the programme a quarter of a second at a time –
   * once, and again after the arrow changed or a programme was put forward.)
   */
  arrowChange(arm: Arm): SignalChange | null {
    const a = this.arrows.get(arm);
    if (!a || !this.state[a.controller] || this.dark[a.controller]) return null;
    if (a.state === SIG.AMBER) {
      // amber for its seconds – or until the main light turns green, which says the same and more
      const main = this.change(a.controller, a.own);
      let left = Math.max(0, ARROW_AMBER - a.since);
      if (main && main.next === SIG.GREEN) left = Math.min(left, main.left);
      return { left, next: -1 };
    }
    let known = this.arrowNext.get(arm);
    if (!known || known.state !== a.state || known.epoch !== this.epoch || known.at < this.time - 0.5) {
      const i = a.controller;
      const at = (g: number, d: number): number => this.programmed(i, g, d);
      const lit = (d: number): boolean => {
        const mine = at(a.own, d);
        if (!(mine === SIG.RED_AMBER || (mine === SIG.RED && at(a.own, d - ARROW_CLEAR) === SIG.RED))) return false;
        for (const g of a.foes) {
          if (g === a.own) continue;
          if (at(g, d) !== SIG.RED || at(g, d - ARROW_CLEAR) !== SIG.RED || at(g, d + ARROW_AMBER + 1) !== SIG.RED) return false;
        }
        for (const g of a.friends) if (at(g, d) !== SIG.GREEN) return false;
        return true;
      };
      // lit now: when does it go out – dark now: when does it come on
      const want = a.state !== SIG.GREEN;
      let found = Infinity;
      for (let d = 0.25; d <= this.cycle[i] + 1; d += 0.25) {
        if (lit(d) === want) {
          found = d;
          break;
        }
      }
      // (going out while the main light turns green, it goes dark at once)
      const next = want ? SIG.GREEN : found < Infinity && at(a.own, found) === SIG.GREEN ? -1 : SIG.AMBER;
      known = { state: a.state, at: this.time + found, next, epoch: this.epoch };
      this.arrowNext.set(arm, known);
    }
    return { left: Math.max(0, known.at - this.time), next: known.next };
  }

  /**
   * A tap on a timer: the controller goes on to the end of the main phase
   * that runs – at once, or once that phase has run SKIP_LEAST seconds – and
   * from there through amber, the moment of red for all and red-amber as its
   * programme has them.  A pedestrian crossing's light at rest is asked as by
   * its button (served after the least green for the vehicles).  An amber, a
   * red-amber or a clearance phase runs as it is.  Returns whether anything
   * was put forward.
   */
  skip(controller: number): boolean {
    const c = this.controllers[controller];
    if (!c || !this.state[controller] || this.dark[controller] || c.phases.length < 2) return false;
    const { k, into, left } = this.phaseAt(controller);
    const p = c.phases[k];
    if (p.d <= CLEARANCE || /[AY]/.test(p.s)) return false;
    if (c.ped && k === 0) {
      if (this.asked[controller] && into >= PED_LEAST_GREEN) return false;
      this.asked[controller] = true;
      this.epoch++;
      return true;
    }
    // (how long the phase has really been showing: since the last of its lights changed – a tap before
    // may have put the programme's clock forward)
    let shown = into;
    for (const s of this.since[controller]) shown = Math.min(shown, s);
    const jump = left - Math.max(0, SKIP_LEAST - shown);
    if (jump <= 0.05) return false;
    this.local[controller] += jump;
    this.epoch++;
    return true;
  }
}
