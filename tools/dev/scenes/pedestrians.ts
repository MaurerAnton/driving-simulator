// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The people of the town on foot (render/people.ts, as sim/pedestrians.ts
 * moves them): a pavement with its kerb along a road, and on it four rows of
 * people facing the road (−z):
 *  - at the kerb, looking left, ahead, right – as before they cross;
 *  - walking along the pavement, some leaning into it (in a hurry);
 *  - under umbrellas, standing and walking (in the rain);
 *  - starting at something: a horn, a car too close (startle 1 and 0.5).
 *
 * Params: t (seconds: how far the walkers have walked), look=<n> (the first
 * look number; each next person the next one), focus=x,y,z and radius (what
 * the views look at), eye=x,y,z and look=x,y,z (the view "eye": a driver on
 * the road in front of them).
 *
 *   node tools/dev/modelshot.mjs pedestrians out.png 20:12:1.4,eye,300:8:1.2
 */
import { PeopleRenderer } from '../../../src/render/people.ts';
import type { PersonPose } from '../../../src/render/people.ts';
import type { PreviewScene, SceneContext } from '../models.ts';

export function build({ THREE, scene, params }: SceneContext): PreviewScene {
  const vec = (key: string, fallback: [number, number, number]): InstanceType<typeof THREE.Vector3> => {
    const v = (params.get(key) ?? '').split(',').map(Number);
    return v.length === 3 && v.every(Number.isFinite) ? new THREE.Vector3(v[0], v[1], v[2]) : new THREE.Vector3(...fallback);
  };
  // ---- the road (z < 0), the kerb at z = 0, the pavement behind it (12 cm up)
  const road = new THREE.Mesh(new THREE.PlaneGeometry(40, 12), new THREE.MeshLambertMaterial({ color: 0x55585c }));
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0, -6);
  road.receiveShadow = true;
  const pave = new THREE.Mesh(new THREE.BoxGeometry(40, 0.12, 9), new THREE.MeshLambertMaterial({ color: 0xa8a49c }));
  pave.position.set(0, 0.06, 4.5);
  pave.receiveShadow = true;
  scene.add(road, pave);

  const first = Number(params.get('look') ?? 101);
  const people = new PeopleRenderer(32);
  scene.add(people.group);
  const poses: PersonPose[] = [];
  const at = (x: number, z: number, extra: Partial<PersonPose>, n: number): void => {
    poses.push({ x, y: 0.12, z, yaw: 0, walk: -1, look: first + n * 37, ...extra });
  };
  let n = 0;
  // at the kerb: left, ahead, right (and once more each way: other looks)
  for (const [i, head] of [0.85, 0, -0.85, 0.5, -0.5].entries()) at(-6 + i * 2.4, 0.5, { head }, n++);
  // under umbrellas: two standing, three walking along (eastwards)
  for (let i = 0; i < 2; i++) at(-6 + i * 2.4, 4.6, { umbrella: true, head: 0.3 }, n++);
  const walkers: Array<{ pose: PersonPose; x0: number; speed: number }> = [];
  const walk = (x0: number, z: number, speed: number, extra: Partial<PersonPose>): void => {
    at(x0, z, { yaw: -Math.PI / 2, walk: 0, ...extra }, n++);
    walkers.push({ pose: poses[poses.length - 1], x0, speed });
  };
  for (let i = 0; i < 3; i++) walk(-1 + i * 2.6, 4.6, 1.3, { umbrella: true, lean: 0.05 });
  // walking: at an ordinary pace, and two in a hurry
  for (let i = 0; i < 3; i++) walk(-7 + i * 2.6, 2.4, 1.3, {});
  for (let i = 0; i < 2; i++) walk(1.5 + i * 2.6, 2.4, 1.9, { lean: 0.07 });
  // starting at a horn
  at(-6, 7, { startle: 1, head: 0.6 }, n++);
  at(-3.6, 7, { startle: 0.5, head: -0.4 }, n++);
  at(-1.2, 7, { startle: 1, yaw: -Math.PI / 2, walk: 3.1 }, n++);

  const update = (t: number): void => {
    for (const w of walkers) {
      w.pose.walk = w.speed * t;
      w.pose.x = w.x0 + w.speed * t;
    }
    people.update(poses, t);
  };
  update(Number(params.get('t') ?? 0.4));
  return {
    target: vec('focus', [0, 1, 3.5]),
    radius: Number(params.get('radius') ?? 9),
    eye: vec('eye', [-2, 1.4, -6]),
    look: vec('look', [0, 1, 3]),
    update,
  };
}
