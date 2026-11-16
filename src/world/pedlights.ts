// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The pedestrian lights of the signalised crossings: on each kerb a pole
 * with a head that faces the other kerb (one looks across the road at the
 * light one walks towards) and a box with the button and the lamp "Signal
 * kommt", where the people wait.
 *
 * At a crossing of its own the poles are those of the vehicles' lights
 * (render/actors.ts puts them a little beyond the stripes, on the right of
 * each direction); at a junction they stand at the crossing.
 */
import { newPolySample, samplePolyline } from '../core/geom.ts';
import type { CrossingJson } from './types.ts';
import { KERB_H, XING } from './types.ts';
import type { World } from './world.ts';

export interface PedPole {
  crossing: CrossingJson;
  /** the controller, and the group of the vehicles that cross the stripes (the pedestrians walk while it has red) */
  controller: number;
  group: number;
  x: number;
  y: number;
  z: number;
  /** the way the head faces (towards the people on the other kerb; 0 = north, + = left) */
  yaw: number;
  /** the way the button box faces (towards the stripes, along the kerb) */
  boxYaw: number;
}

const tmp = newPolySample();

/** The poles of the pedestrian lights of every signalised crossing that is loaded. */
export function pedPoles(world: World): PedPole[] {
  const out: PedPole[] = [];
  for (const c of world.crossings) {
    if (c.k !== XING.SIGNAL || c.sc === undefined) continue;
    const e = world.edges[c.e];
    if (!e) continue;
    for (const side of [1, -1]) {
      // right of the edge's direction (side −1) beyond the stripes, left of it before them
      const s = Math.max(0.2, Math.min(e.len - 0.2, c.s - side * (c.w / 2 + 0.8)));
      samplePolyline(e.pl, s, tmp);
      const sw = side > 0 ? e.swL : e.swR;
      const out1 = e.width / 2 + (sw > 0 ? 0.55 : 0.9);
      // left of the edge direction is (tz, −tx)
      const x = tmp.x + tmp.tz * out1 * side;
      const z = tmp.z - tmp.tx * out1 * side;
      const y = world.edgeY(e, s, x, z) + (sw > 0 ? KERB_H : -0.1);
      // the head looks across the road, to the other kerb
      const fx = -tmp.tz * side;
      const fz = tmp.tx * side;
      // the box looks along the kerb back to the stripes
      const bx = tmp.tx * side;
      const bz = tmp.tz * side;
      out.push({ crossing: c, controller: c.sc, group: c.g ?? 0, x, y, z, yaw: Math.atan2(-fx, -fz), boxYaw: Math.atan2(-bx, -bz) });
    }
  }
  return out;
}

/** The pole whose button is within reach of somebody standing at (x, z) – null if there is none. */
export function poleInReach(poles: readonly PedPole[], x: number, z: number, reach = 1.4): PedPole | null {
  let best: PedPole | null = null;
  let bd = reach;
  for (const p of poles) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}
