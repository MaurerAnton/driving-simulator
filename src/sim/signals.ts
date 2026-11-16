// SPDX-License-Identifier: AGPL-3.0-only
/** Traffic-light controllers: fixed-time programmes with the German sequence green → amber → red → red+amber → green. */
import type { SignalControllerJson } from '../world/types.ts';

export const SIG = { RED: 0, RED_AMBER: 1, GREEN: 2, AMBER: 3 } as const;

const CODE: Record<string, number> = { R: SIG.RED, Y: SIG.RED_AMBER, G: SIG.GREEN, A: SIG.AMBER };

export class SignalSystem {
  /** by their number in the map – with gaps where the map is not loaded */
  readonly controllers: SignalControllerJson[];
  /** the numbers of the controllers that are running */
  private readonly ids: number[] = [];
  private readonly cycle: number[] = [];
  /** current state per controller and group */
  private readonly state: Uint8Array[] = [];
  /** seconds since the current state of a group began */
  private readonly since: Float32Array[] = [];
  time = 0;

  constructor(controllers: SignalControllerJson[]) {
    this.controllers = controllers;
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
      fresh = true;
    });
    if (fresh) this.update(0);
  }

  update(dt: number): void {
    this.time += dt;
    for (const i of this.ids) {
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
