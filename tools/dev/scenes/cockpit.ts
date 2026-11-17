// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The player's vehicles in the finer detail of the "very high" graphics
 * (render/cardetail.ts, render/fleetdetail.ts) – or plain, to compare.
 *
 * Params: vehicle (car | truck | lighttruck | bus | minibus | tractor; car by
 * default), detail=0 (the plain model of the other presets), steer (deg at
 * the road), ind (-1 | 1: an indicator lit, 2: hazard), brake=1, auto=1 (the
 * car's selector instead of the shift pattern), live=1 (the map's picture
 * on the vehicle's screen instead of its still one – drawn blank here).
 * The view "eye" is the driver's seat.
 *
 *   node tools/dev/modelshot.mjs cockpit out.png 30:12:1.4,160:15:1.4,90:2:0.9,eye
 *   node tools/dev/modelshot.mjs cockpit out.png 25:10:1.5,eye 1200 900 vehicle=truck
 */
import { PlayerCar } from '../../../src/render/car.ts';
import { PlayerBus, PlayerTractor } from '../../../src/render/fleet.ts';
import { PlayerTruck } from '../../../src/render/truck.ts';
import { LIGHT_TRUCK, MINIBUS } from '../../../src/sim/vehicle/fleet.ts';
import type { PreviewScene, SceneContext } from '../models.ts';
import { standing } from './state.ts';

export function build({ THREE, scene, params }: SceneContext): PreviewScene {
  const kind = params.get('vehicle') ?? 'car';
  const detail = params.get('detail') !== '0';
  const steer = (Number(params.get('steer') ?? 0) * Math.PI) / 180;
  const ind = Number(params.get('ind') ?? 0);
  const brake = params.get('brake') === '1';
  const model =
    kind === 'truck' ? new PlayerTruck() : kind === 'lighttruck' ? new PlayerTruck(LIGHT_TRUCK) : kind === 'bus' ? new PlayerBus() : kind === 'minibus' ? new PlayerBus(MINIBUS) : kind === 'tractor' ? new PlayerTractor() : new PlayerCar();
  model.setDetail(detail);
  const r = model instanceof PlayerCar ? 0.316 : model instanceof PlayerTractor ? 0.72 : model instanceof PlayerBus ? (kind === 'minibus' ? 0.38 : 0.5) : kind === 'lighttruck' ? 0.42 : 0.49;
  const state = standing({
    steerWheel: steer * 15,
    wheelSteer: [steer, steer, 0, 0],
    wheelSpin: [0.4, 0.4, 0.4, 0.4],
    wheelY: [r, r, r, r],
    indicator: ind === 2 ? 0 : ind,
    hazard: ind === 2,
    blinkOn: ind !== 0,
    brake: brake ? 0.6 : 0,
    braking: brake,
    automatic: params.get('auto') === '1',
    gear: params.get('auto') === '1' ? 1 : 2,
  });
  model.update(state, 0.05, 1);
  if (model instanceof PlayerCar) model.setMapOnScreen(params.get('live') === '1');
  else model.navScreen.setLive(params.get('live') === '1');
  scene.add(model.root);
  if (model instanceof PlayerTruck && kind === 'truck') {
    // the trailer behind it, coupled
    model.setTrailer(0, 0, 4.7 / 2 + 1.2 + 5.4, 0, 0, 0.4, true);
    scene.add(model.trailer);
  }
  const big = !(model instanceof PlayerCar);
  const eye = model.eye.clone();
  return {
    target: new THREE.Vector3(0, big ? 1.4 : 0.7, 0),
    radius: big ? (kind === 'tractor' ? 3 : 6.5) : 2.6,
    eye,
    look: eye.clone().add(new THREE.Vector3(0.05, -0.35, -1)),
  };
}
