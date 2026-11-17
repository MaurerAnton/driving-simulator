// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The cranes (render/crane.ts), posed by their simulation (sim/crane.ts):
 * the tower crane, the mobile crane set up on its outriggers with its boom
 * raised and out, the loader crane on its outriggers unfolded – each with a
 * load on its hook – or one of them alone.
 *
 * Params: crane=tower|mobile|loader|all (all by default), detail=0 (the
 * parts of the low graphics preset), luff=degrees and tele=0…1 (the mobile
 * crane's boom), slew=degrees, stowed=1 (folded as it drives), focus=x,y,z
 * and radius (what the views look at), eye=x,y,z and look=x,y,z (the view
 * "eye": the operator's seat of the crane shown).
 *
 *   node tools/dev/modelshot.mjs crane out.png 30:15:1.2,120:10:1.2,eye
 *   node tools/dev/modelshot.mjs "crane&crane=mobile" out.png 40:12:1.4,200:20:1.4,eye
 */
import { makeCraneModel } from '../../../src/render/crane.ts';
import type { CraneModel } from '../../../src/render/crane.ts';
import { Crane } from '../../../src/sim/crane.ts';
import type { CraneType, CraneWorld } from '../../../src/sim/crane.ts';
import type { PreviewScene, SceneContext } from '../models.ts';

const DT = 1 / 240;

export function build({ THREE, scene, params }: SceneContext): PreviewScene {
  const vec = (key: string, fallback: [number, number, number]): InstanceType<typeof THREE.Vector3> => {
    const v = (params.get(key) ?? '').split(',').map(Number);
    return v.length === 3 && v.every(Number.isFinite) ? new THREE.Vector3(v[0], v[1], v[2]) : new THREE.Vector3(...fallback);
  };
  const which = (params.get('crane') ?? 'all') as CraneType | 'all';
  const detail = params.get('detail') === '0' ? 'low' : 'full';
  const stowed = params.get('stowed') === '1';
  const deg = (key: string, fallback: number): number => ((Number(params.get(key) ?? fallback) || 0) * Math.PI) / 180;
  const world: CraneWorld = { floor: () => 0, boxes: () => [], ground: () => 0, wind: () => ({ x: 3, z: 1, gust: 1.3 }) };
  const shown: Array<{ model: CraneModel; crane: Crane }> = [];

  /** a crane at (x, z), facing north, posed as asked, a pallet on its hook */
  const place = (type: CraneType, x: number, z: number): { model: CraneModel; crane: Crane } => {
    const c = new Crane(type);
    c.place(x, 0, z, 0);
    if (!stowed) {
      if (type !== 'tower') {
        c.cmd.beams = 1;
        for (let i = 0; i < 16 / DT; i++) c.step(DT, world);
        c.cmd.beams = 0;
        c.cmd.jacks = 1;
        for (let i = 0; i < 20 / DT && !c.onOutriggers(world); i++) c.step(DT, world);
        for (let i = 0; i < 1 / DT; i++) c.step(DT, world);
        c.cmd.jacks = 0;
      }
      if (type === 'mobile') {
        c.q.luff = deg('luff', 50);
        c.q.tele = Math.max(0, Math.min(1, Number(params.get('tele') ?? 0.45)));
      } else if (type === 'loader') {
        c.q.inner = deg('inner', 25);
        c.q.outer = deg('outer', -35);
        c.q.ext = Math.max(0, Math.min(1, Number(params.get('ext') ?? 0.6)));
      } else c.q.trolley = 24;
      c.q.slew = deg('slew', type === 'tower' ? 35 : 70);
      c.q.rope = type === 'tower' ? 18 : type === 'mobile' ? 8 : c.q.rope;
      c.place(x, 0, z, 0);
      c.lift = type === 'mobile' ? 0.18 : 0;
      c.attach({ id: 'p', t: 1.2, hx: 0.6, hy: 0.55, hz: 0.5, sling: 1.6, yaw: 0, area: 1.4 }, c.hook.x, c.hook.y - c.spec.hookDrop - 1.6, c.hook.z);
      for (let i = 0; i < 4 / DT; i++) c.step(DT, world);
    }
    const m = makeCraneModel(type, detail);
    m.root.position.set(x, 0, z);
    scene.add(m.root);
    m.root.updateMatrixWorld(true);
    m.pose(c, 1);
    return { model: m, crane: c };
  };
  if (which === 'all' || which === 'tower') shown.push(place('tower', which === 'all' ? -30 : 0, which === 'all' ? -10 : 0));
  if (which === 'all' || which === 'mobile') shown.push(place('mobile', which === 'all' ? 6 : 0, 0));
  if (which === 'all' || which === 'loader') shown.push(place('loader', which === 'all' ? 22 : 0, 0));
  // the pallets on the hooks
  const palletGeo = new THREE.BoxGeometry(1.2, 1.1, 1.0);
  const palletMat = new THREE.MeshLambertMaterial({ color: 0xcfc6b4 });
  for (const s of shown) {
    if (!s.crane.load) continue;
    const p = new THREE.Mesh(palletGeo, palletMat);
    p.position.set(s.crane.hook.x, s.crane.hook.y - s.crane.drop() + 0.55, s.crane.hook.z);
    p.castShadow = true;
    scene.add(p);
  }
  const first = shown[0];
  const eye = new THREE.Vector3();
  first.model.operatorEye(eye);
  const big = which === 'tower' || which === 'all';
  return {
    target: vec('focus', big ? [0, 14, 0] : [0, 3, 0]),
    radius: Number(params.get('radius') ?? (big ? 40 : 14)),
    eye: vec('eye', [eye.x, eye.y, eye.z]),
    look: vec('look', [first.crane.hook.x, first.crane.hook.y - 1, first.crane.hook.z]),
    update: (t: number) => {
      for (const s of shown) {
        s.model.update({ wheelY: [], wheelSpin: [], wheelSteer: [], blinkOn: false, ignition: true, hazard: false, indicator: 0, braking: false } as never, 0, t);
        s.model.pose(s.crane, t);
      }
    },
  };
}
