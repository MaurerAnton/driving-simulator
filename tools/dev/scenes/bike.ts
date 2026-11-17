// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The player's motorcycle with its rider (render/bike.ts PlayerBike).
 * Params: variant (moped | light | mid | big), speed (km/h, default 48; below
 * 3 the rider stands, a foot on the road), lean (deg), steer (deg, at the road;
 * by default as far as that lean needs at that speed – the curve v²/(g·tan lean) –,
 * so that the rider looks through the bend he leans into), throttle and brake
 * (0 … 1), ind (-1 | 1: an indicator lit, 2: hazard), check (s since the
 * indicator came on: the shoulder check that far – with ind, default 1), time
 * (s the rider has been at it: his glances and breathing; default 3), dive /
 * squat (m the front and rear wheel stand higher: the suspension compressed),
 * rider (0: nobody on it), look (where the eye view looks: gaze – the bike's
 * own gaze below the horizon, the default –, level, or a number of degrees
 * below the horizon).  The eye view leans with the bike as the game's camera
 * does only in position: the preview's camera does not roll.
 * e.g. lean=35&views=180:10:1.3,0:5:1.3,90:0:1.3,eye – a bend to the right.
 */
import { PlayerBike } from '../../../src/render/fleet.ts';
import type { BikeVariant } from '../../../src/render/bike.ts';
import { MOTORCYCLE } from '../../../src/sim/vehicle/fleet.ts';
import type { PreviewScene, SceneContext } from '../models.ts';
import { standing } from './state.ts';

/** a frame of the game, roughly: the rider is moved in steps of it */
const STEP = 1 / 20;

export function build({ THREE, scene, params }: SceneContext): PreviewScene {
  const deg = (key: string): number => (Number(params.get(key) ?? 0) * Math.PI) / 180;
  const variant = (params.get('variant') ?? 'big') as BikeVariant;
  const bike = new PlayerBike(variant);
  scene.add(bike.root);
  const lean = deg('lean');
  bike.setLean(lean);
  if (params.get('rider') === '0') bike.setRider(false);
  const kmh = Number(params.get('speed') ?? 48);
  const v = kmh / 3.6;
  // (the wheel's angle for the curve that lean rides at that speed: r = v² / (g · tan lean), angle = atan(wheelbase / r))
  const steer = params.has('steer') ? deg('steer') : v > 1 ? Math.atan((9.81 * Math.tan(lean) * MOTORCYCLE.wheelbase) / (v * v)) : 0;
  const check = params.get('check');
  const ind = Number(params.get('ind') ?? (check !== null ? 1 : 0));
  const brake = Number(params.get('brake') ?? 0);
  const r = 0.31;
  const dive = Number(params.get('dive') ?? 0);
  const squat = Number(params.get('squat') ?? 0);
  const state = standing({
    wheelSteer: [steer, steer, 0, 0],
    wheelY: [r + dive, r + dive, r + squat, r + squat],
    throttle: Number(params.get('throttle') ?? (kmh > 0 ? 0.2 : 0)),
    brake,
    braking: brake > 0.03,
    indicator: ind === 2 ? 0 : ind,
    hazard: ind === 2,
    blinkOn: ind !== 0,
    speedKmh: kmh,
    rpm: kmh > 0 ? 5200 : 1300,
    gear: kmh > 0 ? 3 : 1,
  });
  // the rider settles in, frame by frame (the lean, his glances and his feet follow smoothly) – for a
  // shoulder check without the indicator first, then with it for `check` seconds
  const settle = Math.max(2, Number(params.get('time') ?? 3) - Number(check ?? 0));
  const before = check !== null ? { ...state, indicator: 0, hazard: false, blinkOn: false } : state;
  let now = 0;
  for (let i = 0; i < settle / STEP; i++) bike.update(before, STEP, (now += STEP));
  if (check !== null) for (let i = 0; i < Number(check) / STEP; i++) bike.update(state, STEP, (now += STEP));
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
