// SPDX-License-Identifier: AGPL-3.0-only
/** Traffic-light controllers: fixed-time programmes with the German sequence green → amber → red → red+amber → green. */
import type { SignalControllerJson } from '../world/types.ts';

export const SIG = { RED: 0, RED_AMBER: 1, GREEN: 2, AMBER: 3 } as const;

const CODE: Record<string, number> = { R: SIG.RED, Y: SIG.RED_AMBER, G: SIG.GREEN, A: SIG.AMBER };

export class SignalSystem {
  readonly controllers: SignalControllerJson[];
  private readonly cycle: number[];
  /** current state per controller and group */
  private readonly state: Uint8Array[];
  /** seconds since the current state of a group began */
  private readonly since: Float32Array[];
  time = 0;

  constructor(controllers: SignalControllerJson[]) {
    this.controllers = controllers;
    this.cycle = controllers.map((c) => c.phases.reduce((a, p) => a + p.d, 0));
    this.state = controllers.map((c) => new Uint8Array(c.groups));
    this.since = controllers.map((c) => new Float32Array(c.groups));
    this.update(0);
  }

  update(dt: number): void {
    this.time += dt;
    for (let i = 0; i < this.controllers.length; i++) {
      const c = this.controllers[i];
      let t = (this.time + c.off) % this.cycle[i];
      let phase = c.phases[c.phases.length - 1];
      for (const p of c.phases) {
        if (t < p.d) {
          phase = p;
          break;
        }
        t -= p.d;
      }
      const st = this.state[i];
      const since = this.since[i];
      for (let g = 0; g < c.groups; g++) {
        const s = CODE[phase.s[g]] ?? SIG.RED;
        if (s !== st[g]) {
          st[g] = s;
          since[g] = 0;
        } else since[g] += dt;
      }
    }
  }

  get(controller: number, group: number): number {
    const st = this.state[controller];
    return st ? st[Math.min(group, st.length - 1)] : SIG.GREEN;
  }

  /** Seconds the group has been showing its current state. */
  age(controller: number, group: number): number {
    const s = this.since[controller];
    return s ? s[Math.min(group, s.length - 1)] : 0;
  }
}
