// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the forklift's drive is made of besides the forklift itself (no
 * three.js, no page – the game, game/forkliftplay.ts, uses these):
 *
 *  - its ways to play: "Forklift work" (`FORK_WORK_MODE`) is the tasks on
 *    the forklift yard; any other way – the free drive, the test place –
 *    begins where the menu put it;
 *  - its cameras, in the order the camera key (V) goes through them: from
 *    the side, where the drive starts – the forks, the load and the mast in
 *    view –, from the operator's seat, from behind, the free camera;
 *  - getting off beside the seat and on again within a few steps of it.
 */

/** The way to play (the menu's mode) of the work on the forklift yard: its tasks; any other is a free drive. */
export const FORK_WORK_MODE = 'forklift';

/** The forklift's cameras, in the order V goes through them: from the side (the start), the seat, behind, free. */
export type ForkView = 'side' | 'cockpit' | 'chase' | 'free';
export const FORK_VIEWS: readonly ForkView[] = ['side', 'cockpit', 'chase', 'free'];
/**
 * The view from the side: the camera circling the forklift rests on its
 * left (the operator's side), a little ahead – the forks, the load and the
 * mast in view (radians, as Input.orbitRest: 0 behind, + to the right).
 */
export const FORK_SIDE_YAW = -(Math.PI / 2 + 0.35);

/** The next camera after this one (V). */
export function nextForkView(v: ForkView): ForkView {
  return FORK_VIEWS[(FORK_VIEWS.indexOf(v) + 1) % FORK_VIEWS.length];
}

/** What the game's camera is for a view of the forklift: its mode, and where the camera circling it rests. */
export function forkCamera(v: ForkView): { mode: 'cockpit' | 'chase' | 'free'; rest: number } {
  return v === 'side' ? { mode: 'chase', rest: FORK_SIDE_YAW } : { mode: v, rest: 0 };
}

/** how far from the forklift's middle the operator stands after getting off (half its width and a step) */
const OFF_SIDE = 1.35;
/** within this of its middle the operator can get on again (m) */
const ON_REACH = 3.2;

/** Where the operator stands after getting off: beside the seat, on the left (`side` −1) or the right (1), facing the way it faces. */
export function forkliftExit(x: number, z: number, yaw: number, side = -1): { x: number; z: number; yaw: number } {
  // (to the right is (cos yaw, −sin yaw))
  return { x: x + Math.cos(yaw) * side * OFF_SIDE, z: z - Math.sin(yaw) * side * OFF_SIDE, yaw };
}

/** Can somebody standing at (x, z) get on the forklift whose middle is at (fx, fz)? */
export function nearForklift(fx: number, fz: number, x: number, z: number): boolean {
  return Math.hypot(x - fx, z - fz) <= ON_REACH;
}
