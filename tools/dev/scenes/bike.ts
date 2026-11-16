// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The player's motorcycle with its rider (render/bike.ts PlayerBike).
 * Params: variant (moped | light | mid | big), lean (deg), steer (deg, at the
 * road), brake (1: braking), ind (-1 | 1: an indicator lit, 2: hazard),
 * dive / squat (m the front and rear wheel stand higher: the suspension
 * compressed), rider (0: nobody on it), look (where the eye view looks: gaze –
 * the bike's own gaze below the horizon, the default –, level, or a number of
 * degrees below the horizon).  The eye view leans with the bike as the game's
 * camera does only in position: the preview's camera does not roll.
 */
import { PlayerBike } from '../../../src/render/fleet.ts';
import type { BikeVariant } from '../../../src/render/bike.ts';
import type { PreviewScene, SceneContext } from '../models.ts';
import { standing } from './state.ts';

export function build({ THREE, scene, params }: SceneContext): PreviewScene {
  const variant = (params.get('variant') ?? 'big') as BikeVariant;
  const bike = new PlayerBike(variant);
  scene.add(bike.root);
  bike.setLean((Number(params.get('lean') ?? 0) * Math.PI) / 180);
  if (params.get('rider') === '0') bike.setRider(false);
  const steer = (Number(params.get('steer') ?? 0) * Math.PI) / 180;
  const ind = Number(params.get('ind') ?? 0);
  const r = 0.31;
  const dive = Number(params.get('dive') ?? 0);
  const squat = Number(params.get('squat') ?? 0);
  const state = standing({
    wheelSteer: [steer, steer, 0, 0],
    wheelY: [r + dive, r + dive, r + squat, r + squat],
    braking: params.get('brake') === '1',
    indicator: ind === 2 ? 0 : ind,
    hazard: ind === 2,
    blinkOn: ind !== 0,
    speedKmh: 48,
    rpm: 5200,
    gear: 3,
  });
  // (the lean follows smoothly: a few long steps settle it)
  for (let i = 0; i < 20; i++) bike.update(state, 1, i);
  // the camera of the rider's eyes swings with the lean about the line on the road, as in the game
  const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -bike.leaning);
  const eye = bike.eye.clone().applyQuaternion(roll);
  const lk = params.get('look') ?? 'gaze';
  const down = lk === 'gaze' ? bike.gaze : lk === 'level' ? 0 : (Number(lk) * Math.PI) / 180;
  return {
    target: new THREE.Vector3(0, 0.7, 0),
    radius: 1.2,
    eye,
    look: eye.clone().add(new THREE.Vector3(0, -Math.sin(down), -Math.cos(down)).multiplyScalar(10)),
  };
}
