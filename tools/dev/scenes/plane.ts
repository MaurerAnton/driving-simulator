// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The light aeroplane (render/plane.ts) standing on its wheels.  Params:
 *   interior=0            the parked aeroplane without a cockpit
 *   aileron, elevator, rudder (rad), flaps (deg), steer (rad), comp (main strut compression, m)
 *   rpm, prop (propeller angle, rad), throttle (0…1), pitch, roll (yoke −1…1), pedals (−1…1)
 *   lights=0              all lights off (default: all on, strobes and beacon flashing at t = 0)
 *   ias, alt, vs, hdg, att (pitch, deg), bank (deg), slip, turn (deg/s), fuel, brake=1, stall=1
 *   look, glance          how far the pilot's eye looks down and to the left (deg) in the view "eye"
 *   focus=x,y,z, radius   what the other views look at (aeroplane coordinates) and how far away they are
 *   opacity               the cabin's opacity (setCabinOpacity)
 */
import { PlaneModel } from '../../../src/render/plane.ts';
import type { PlaneVisualState } from '../../../src/render/plane.ts';
import { TRAINER } from '../../../src/sim/flightspec.ts';
import type { PreviewScene, SceneContext } from '../models.ts';

export function build({ THREE, scene, params }: SceneContext): PreviewScene {
  const num = (key: string, d: number): number => {
    const v = params.get(key);
    return v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v);
  };
  const plane = new PlaneModel({ interior: params.get('interior') !== '0' });
  scene.add(plane.root);
  plane.setCabinOpacity(num('opacity', 1));
  const comp = num('comp', 0.04);
  const lit = params.get('lights') !== '0';
  const rpm = num('rpm', 0);
  const state: PlaneVisualState = {
    aileron: num('aileron', 0),
    elevator: num('elevator', 0),
    rudder: num('rudder', 0),
    flapsDeg: num('flaps', 0),
    throttle: num('throttle', rpm > 0 ? 0.6 : 0),
    rpm,
    propAngle: num('prop', 0.4),
    wheels: [
      // the nose strut a little less loaded, so that the aeroplane stands level
      { compression: Math.max(0, comp - 0.02), spin: 0, steer: num('steer', 0) },
      { compression: comp, spin: 0, steer: 0 },
      { compression: comp, spin: 0, steer: 0 },
    ],
    yoke: { pitch: num('pitch', 0), roll: num('roll', 0) },
    pedals: num('pedals', 0),
    lights: { nav: lit, beacon: lit, strobe: lit, landing: lit, taxi: lit },
    iasKt: num('ias', 95),
    altitudeFt: num('alt', 2350),
    vsFpm: num('vs', 500),
    headingDeg: num('hdg', 75),
    pitchDeg: num('att', 5),
    bankDeg: num('bank', 15),
    slip: num('slip', 0.2),
    turnRateDegS: num('turn', 2),
    rpmGauge: num('rpmGauge', rpm || 2350),
    fuel: num('fuel', 0.7),
    flapsGauge: num('flaps', 0),
    stallWarning: params.get('stall') === '1',
    parkingBrake: params.get('brake') === '1',
    engineOn: rpm > 0 || params.get('engine') === '1',
  };
  // the main wheels on the ground: the centre of mass stands their radius and their strut's length above it
  const main = TRAINER.gear[1];
  plane.root.position.y = -(main.y + comp) + main.radius;
  plane.update(state, 0.05, 0.02);
  const eye = plane.eye.clone().add(plane.root.position);
  const down = (num('look', 9) * Math.PI) / 180;
  const left = (num('glance', 0) * Math.PI) / 180;
  const focus = (params.get('focus') ?? '0,0.15,1.2').split(',').map(Number);
  return {
    target: new THREE.Vector3(focus[0] ?? 0, (focus[1] ?? 0) + plane.root.position.y, focus[2] ?? 0),
    radius: num('radius', 4.4),
    eye,
    look: eye.clone().add(new THREE.Vector3(-Math.sin(left) * Math.cos(down), -Math.sin(down), -Math.cos(left) * Math.cos(down)).multiplyScalar(10)),
    update(t: number): void {
      plane.update(state, 0.05, t || 0.02);
    },
  };
}
