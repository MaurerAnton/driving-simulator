// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trams with their doors (render/trams.ts): two on straight tracks running north, the one on the
 * left (x -6) with its doors shut, the one on the right (x 0) with them open – as far as `doors`
 * says.
 *
 * Params: kind=tram|light|train (tram by default), set=single|double|trailer, doors=0…1 (the doors
 * of the right one; 1 by default), detail=0 (the plain bodies of the low graphics setting),
 * focus=x,y,z and radius (what the views look at), eye=x,y,z and look=x,y,z (the view "eye": somebody
 * on the platform beside a door of the right one).  The shut doors from close by: the view 270:3:0.45.
 *
 *   node tools/dev/modelshot.mjs tram out.png 50:8:1,310:8:1,eye,270:3:0.45
 */
import { RailActors } from '../../../src/render/trams.ts';
import { carLayout, consistOf } from '../../../src/sim/rail.ts';
import type { RailVehicle, TramSet } from '../../../src/sim/rail.ts';
import { RAIL } from '../../../src/world/types.ts';
import type { PreviewScene, SceneContext } from '../models.ts';

export function build({ THREE, scene, params }: SceneContext): PreviewScene {
  const vec = (key: string, fallback: [number, number, number]): InstanceType<typeof THREE.Vector3> => {
    const v = (params.get(key) ?? '').split(',').map(Number);
    return v.length === 3 && v.every(Number.isFinite) ? new THREE.Vector3(v[0], v[1], v[2]) : new THREE.Vector3(...fallback);
  };
  const kind = params.get('kind') === 'light' ? RAIL.LIGHT : params.get('kind') === 'train' ? RAIL.TRAIN : RAIL.TRAM;
  const set = (['single', 'double', 'trailer'].includes(params.get('set') ?? '') ? params.get('set') : 'single') as TramSet;
  const consist = consistOf(kind, set);

  // ---- the tracks: a paved bed with two rails each (only for this picture)
  for (const x of [0, -6]) {
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 240), new THREE.MeshLambertMaterial({ color: 0x6d6a66 }));
    bed.rotation.x = -Math.PI / 2;
    bed.position.set(x, 0.008, 0);
    bed.receiveShadow = true;
    scene.add(bed);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.03, 240), new THREE.MeshLambertMaterial({ color: 0x8a8580 }));
      rail.position.set(x + side * 0.7175, 0.02, 0);
      scene.add(rail);
    }
  }

  // ---- the two vehicles, their fronts to the north (-z)
  const trams = new RailActors();
  trams.detail = params.get('detail') !== '0';
  /** a vehicle on the track at x, its front end at z `front` */
  const vehicle = (id: number, x: number, front: number, doors: number): RailVehicle => {
    const cars = carLayout(consist).map((r) => ({ x, y: 0, z: front + r.start + r.len / 2, yaw: 0, pitch: 0 }));
    return { id, kind, consist, cars, panto: 1, doors } as unknown as RailVehicle;
  };
  const doors = Math.max(0, Math.min(1, Number(params.get('doors') ?? 1)));
  trams.update([vehicle(1, -6, -12, 0), vehicle(2, 0, -15, Number.isFinite(doors) ? doors : 1)]);
  scene.add(trams.group);

  return {
    target: vec('focus', [-3, 1.5, -8]),
    radius: Number(params.get('radius') ?? 9),
    eye: vec('eye', [4.5, 1.7, -3]),
    look: vec('look', [1.2, 1.3, -8]),
  };
}
