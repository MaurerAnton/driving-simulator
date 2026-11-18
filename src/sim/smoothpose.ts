// SPDX-License-Identifier: AGPL-3.0-only
/**
 * How the cars of the traffic turn and move smoothly.
 *
 * A car of the traffic (src/sim/traffic.ts) rides on polylines: its lane's
 * road, and through a junction a curve of a handful of straight pieces.  Its
 * heading taken from the piece it is on turns by a whole corner of the line
 * at once – 15° on one picture, 30° on the next – and a lane drawn beside the
 * middle of its road jumps sideways at each bend of that road.
 *
 * Here instead:
 * - the heading is that of the chord between two points of its way, half a
 *   wheelbase behind and ahead of it (as its axles would stand) – it turns
 *   gradually through each corner, with no lag on the curve as a whole;
 * - what turns it besides its way (moving over to another lane, going round
 *   something) eases in rather than jumping;
 * - its place moves on along its heading by the distance it drove, and is
 *   drawn towards the place its way gives – a jump sideways becomes a gentle
 *   drift over a metre or two (a real jump, many metres, is taken at once);
 * - its front wheels are steered by how fast it turns for the way it goes.
 */

import { samplePolyline, newPolySample } from '../core/geom.ts';
import type { Polyline3 } from '../core/geom.ts';

/** the drift towards the place the way gives: over this distance driven (m) – and, standing, this time (s) */
const PLACE_DIST = 1.4;
const PLACE_TIME = 0.3;
/** a jump of more than this (m) is taken at once */
const SNAP = 4;
/** the turn besides its way eases in over this distance (m) and time (s) */
const EXTRA_DIST = 0.9;
const EXTRA_TIME = 0.2;
/** what is left of a jump in the heading itself (where two pieces of its way meet) eases out over this distance and time */
const YAW_DIST = 0.35;
const YAW_TIME = 0.1;
/** the steering of the front wheels follows within this time (s), up to this angle (rad) */
const STEER_TIME = 0.12;
const STEER_MAX = 0.62;

/** An angle brought to (−π, π]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** The heading (yaw: 0 north, + to the left) from point a to point b on the ground; NaN where they fall together. */
export function chordYaw(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  if (dx * dx + dz * dz < 1e-6) return NaN;
  return Math.atan2(-dx, -dz);
}

const sa = newPolySample();
const sb = newPolySample();

/** The heading of the chord of a polyline from s − h to s + h (both kept on it) – NaN where it is too short. */
export function chordYawOn(pl: Polyline3, s: number, h: number): number {
  samplePolyline(pl, s - h, sa);
  samplePolyline(pl, s + h, sb);
  return chordYaw(sa.x, sa.z, sb.x, sb.z);
}

/** Half the chord a vehicle of this length turns by (m): about half its wheelbase. */
export function chordHalf(length: number): number {
  return Math.max(1.1, Math.min(3.2, length * 0.28));
}

/** The pose that is eased: where it is drawn, which way it faces, the turn besides its way, its front wheels. */
export interface EasedPose {
  x: number;
  z: number;
  yaw: number;
  /** the turn besides its way (rad), eased in */
  yawX?: number;
  /** the front wheels' angle (rad, + to the right, as the car models take it) */
  steer?: number;
}

/**
 * One step of a car's pose: `wayYaw` the heading its way gives (the chord),
 * `extra` the turn besides it (moving over, going round something), (rawX,
 * rawZ) where its way puts it; `ds` how far it drove, `dt` the time,
 * `wheelbase` for the steering.  Updates `p`.
 */
export function easePose(p: EasedPose, rawX: number, rawZ: number, wayYaw: number, extra: number, ds: number, dt: number, wheelbase: number): void {
  const ge = 1 - Math.exp(-(ds / EXTRA_DIST + dt / EXTRA_TIME));
  const yawX = (p.yawX ?? 0) + wrapAngle(extra - (p.yawX ?? 0)) * ge;
  p.yawX = yawX;
  const target = wayYaw + yawX;
  const old = p.yaw;
  let d = wrapAngle(target - old);
  // (a turn of more than ~70° at once is no corner of its way: it was put somewhere else)
  if (Math.abs(d) < 1.2) d *= 1 - Math.exp(-(ds / YAW_DIST + dt / YAW_TIME));
  const yaw = wrapAngle(old + d);
  // its place: on along its heading, drawn towards where its way puts it
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const px = p.x + fx * ds;
  const pz = p.z + fz * ds;
  const ex = rawX - px;
  const ez = rawZ - pz;
  if (ex * ex + ez * ez > SNAP * SNAP) {
    p.x = rawX;
    p.z = rawZ;
  } else {
    const gp = 1 - Math.exp(-(ds / PLACE_DIST + dt / PLACE_TIME));
    p.x = px + ex * gp;
    p.z = pz + ez * gp;
  }
  // the front wheels: the curvature driven (turn per metre) times the wheelbase (standing: as they were)
  let steer = p.steer ?? 0;
  if (ds > 1e-3 && Math.abs(d) < 1.2) {
    const want = Math.max(-STEER_MAX, Math.min(STEER_MAX, -Math.atan((wheelbase * d) / ds)));
    steer += (want - steer) * (1 - Math.exp(-dt / STEER_TIME));
  }
  p.steer = steer;
  p.yaw = yaw;
}
