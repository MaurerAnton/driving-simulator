// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The emergency vehicles (render/emergency.ts EmergencyModel) side by side:
 * the police patrol car, the ambulance, the fire engine and the emergency
 * doctor's car.  Params: only (police | ambulance | fire | doctor: that one
 * alone), lights (0: off; on by default), sign (1: the police car's
 * "STOP POLIZEI" sign raised).  t (s) is where the lights are in their
 * rhythm: 0 – the left blue lamps and the left headlight flash –, 0.43 – the
 * right ones –, 0.3 – none of the blue ones.
 * e.g. node tools/dev/modelshot.mjs emergency out.png 30:15:1.6,150:15:1.6 1600 900 "t=0.43&sign=1"
 */
import { EmergencyModel } from '../../../src/render/emergency.ts';
import { EM } from '../../../src/sim/emergency.ts';
import type { PreviewScene, SceneContext } from '../models.ts';

const KINDS: Record<string, number> = { police: EM.POLICE, ambulance: EM.AMBULANCE, fire: EM.FIRE, doctor: EM.DOCTOR };

export function build({ THREE, scene, params }: SceneContext): PreviewScene {
  const only = params.get('only') ?? '';
  const kinds = only in KINDS ? [KINDS[only]] : [EM.POLICE, EM.AMBULANCE, EM.FIRE, EM.DOCTOR];
  const lights = params.get('lights') !== '0';
  const models: EmergencyModel[] = [];
  // (side by side across the road, noses to −z)
  let x = -((kinds.length - 1) * 3.4) / 2;
  for (const kind of kinds) {
    const m = new EmergencyModel(kind);
    m.group.position.set(x, 0, 0);
    m.setMotion(0, false, false, false);
    m.setSign(params.get('sign') === '1');
    scene.add(m.group);
    models.push(m);
    x += 3.4;
  }
  return {
    target: new THREE.Vector3(0, 1.3, 0),
    radius: Math.max(4.5, kinds.length * 1.9),
    update(t: number): void {
      for (const m of models) m.setLights(lights, t);
    },
  };
}
