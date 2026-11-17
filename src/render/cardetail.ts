// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The player's car in finer detail – for the "very high" graphics only
 * (Graphics.vehicleDetail): built the first time it is switched on, and
 * hidden again (with the plain parts back) when it is switched off.
 *
 * Outside: panel gaps of the doors, the bonnet and the tailgate, door
 * handles, a black B pillar, rubber seals along the windows and a black band
 * round the windscreen, the scuttle under the windscreen with its two wipers,
 * headlamps and tail lamps that follow the curve of the body (housing,
 * reflectors and projectors, daytime running light, indicator, clear cover –
 * lit by the same materials as the plain lamps), lower air intakes with a
 * honeycomb mesh and fog lamps, number plates with their seals in a holder,
 * badges, an indicator repeater on each door mirror, the exhaust tip, the
 * roof antenna, the fuel flap, and the wheels: tyres with sidewalls and
 * tread, open alloy rims with nuts and a centre cap, brake discs and calipers.
 *
 * Inside: the instrument cluster in chrome-ringed dials with 3D needle hubs,
 * the steering wheel's airbag pad with its badge, buttons on the spokes,
 * grips and stitching, ribbed stalk ends, a shift pattern on the gear knob
 * (or the P R N D of an automatic beside the selector), the defroster grille
 * and tweeters on the dashboard, hazard and start buttons, the light switch,
 * a lock in the glove box, switches, lock pins, pockets and tweeters on the
 * doors, seat-belt buckles, sun-visor clips and mirror lids, grab handles,
 * buttons in the roof console, the sensor housing behind the rear-view mirror,
 * ribbed rubber on the pedals.
 *
 * Parts that share a material are merged into one mesh, the wheels are
 * drawn as instances: the whole of it costs a few dozen draw calls.  The
 * parts the driver can see are handed to the see-through cabin (`ghosts`).
 */
import * as THREE from 'three';
import { cabinMaterial } from './car.ts';
import type { CarExterior, CarVisualState } from './car.ts';
import { bodyProfile } from './carBody.ts';
import { Frame, Parts, Surface, WheelSet, drape, lathe, plateTexture, ribbon, tubeOf } from './detailkit.ts';
import type { Hit, V3 } from './detailkit.ts';
import type { Mirror } from './mirrors.ts';

/** What the finer model is fixed to: the parts of the player's car (render/car.ts PlayerCar). */
export interface CarParts {
  exterior: CarExterior;
  cockpit: THREE.Group;
  mirrors: Mirror[];
  steering: THREE.Group;
  lever: THREE.Group;
  handbrake: THREE.Group;
  pedals: THREE.Group[];
  stalk: THREE.Group;
  eye: THREE.Vector3;
}

const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

// materials of the outside (the inside's are made per car, as the cabin's: render/car.ts cabinMaterial)
const GAP = new THREE.MeshLambertMaterial({ color: 0x0a0b0c, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
// (the parts that open leave the gaps along their edges on the body: render/caropen.ts)
GAP.name = 'panel gap';
const GLOSS_BLACK = new THREE.MeshPhongMaterial({ color: 0x0e0f11, shininess: 70, specular: 0x4a4f55, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
const RUBBER = new THREE.MeshLambertMaterial({ color: 0x141517 });
const PLASTIC = new THREE.MeshLambertMaterial({ color: 0x1d1f22, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
const CHROME = new THREE.MeshPhongMaterial({ color: 0xd6dbe0, shininess: 110, specular: 0xffffff });
const HOUSING = new THREE.MeshPhongMaterial({ color: 0x15171a, shininess: 60, specular: 0x5a6068 });
const ENAMEL = new THREE.MeshPhongMaterial({ color: 0x18305e, shininess: 80, specular: 0x8899bb });
/** the clear covers of the lamps: only a sheen over what is under them */
const LENS = new THREE.MeshPhongMaterial({ color: 0xdfe8ee, transparent: true, opacity: 0.16, shininess: 140, specular: 0xffffff, depthWrite: false });
const TYRE = new THREE.MeshLambertMaterial({ color: 0x1b1c1e });
const METAL = new THREE.MeshPhongMaterial({ color: 0xc3c7cb, vertexColors: true, shininess: 70, specular: 0x777777 });
const CALIPER = new THREE.MeshPhongMaterial({ color: 0x9a1d17, shininess: 40, specular: 0x553333 });

/** A rounded-rectangle outline (w × h, corner radius r) in the x-y plane, counter-clockwise. */
function rounded(w: number, h: number, r: number, seg = 3): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [cx, cy, a0] of [
    [w / 2 - r, -h / 2 + r, -90],
    [w / 2 - r, h / 2 - r, 0],
    [-w / 2 + r, h / 2 - r, 90],
    [-w / 2 + r, -h / 2 + r, 180],
  ]) {
    for (let i = 0; i <= seg; i++) {
      const a = ((a0 + (90 * i) / seg) * Math.PI) / 180;
      out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return out;
}

/** A flat outline in a frame, pushed out to `w` (a ring of points for tubeOf). */
function ringIn(f: Frame, outline: Array<[number, number]>, w: number): V3[] {
  return outline.map(([u, v]): V3 => {
    const p = f.at(u, v, w);
    return [p.x, p.y, p.z];
  });
}

/** A slab with rounded corners: an outline in a frame, from w0 to w1 off it (both ends closed). */
function slab(f: Frame, outline: Array<[number, number]>, w0: number, w1: number): THREE.BufferGeometry {
  return tubeOf([ringIn(f, outline, w0), ringIn(f, outline, w1)]);
}

export class CarDetail {
  /** the meshes the see-through cabin is to take in, with their layer (1: the controls in front) */
  readonly ghosts: Array<[THREE.Mesh, number]> = [];
  private readonly car: CarParts;
  /** what the finer model added (shown with it) and what of the plain model it hides */
  private readonly added: THREE.Object3D[] = [];
  private readonly plain: THREE.Object3D[] = [];
  private readonly wheels: WheelSet;
  private readonly wheelPos = new THREE.Vector3();
  /** the shift pattern on the knob (a manual gearbox) and the P R N D beside the selector (an automatic) */
  private readonly pattern: THREE.Object3D;
  private readonly selector: THREE.Mesh;
  private readonly selectorCanvas: HTMLCanvasElement;
  private readonly selectorTexture: THREE.CanvasTexture;
  private selectorShown = '';
  private on = false;
  private automatic = false;

  constructor(car: CarParts) {
    this.car = car;
    const ext = car.exterior;
    const sh = ext.shell;
    const at = bodyProfile(ext.dims);
    const body = new Surface([sh.paint, sh.pillars, sh.trim]);
    const glassy = new Surface([sh.glass, sh.paint, sh.pillars]);
    const out = new Parts();
    const paint = ext.paint;
    const hw = sh.halfWidth;

    // ================================================================ outside ====
    // ---- panel gaps: doors, sill, bonnet, tailgate ------------------------------
    const gap = (pts: Hit[], width = 0.0065): void => {
      if (pts.length > 1) out.add(GAP, ribbon(pts, width, 0.0022));
    };
    /** a path on the surface through control points [x, y, z], each seen along its own direction */
    const path = (ctrl: Array<[THREE.Vector3, THREE.Vector3]>, step = 0.02, s = body): Hit[] => {
      const pts: Hit[] = [];
      for (let i = 0; i + 1 < ctrl.length; i++) {
        const [a, da] = ctrl[i];
        const [b, db] = ctrl[i + 1];
        const n = Math.max(1, Math.ceil(a.distanceTo(b) / step));
        for (let k = i === 0 ? 0 : 1; k <= n; k++) {
          const t = k / n;
          const h = s.onto(a.clone().lerp(b, t), da.clone().lerp(db, t));
          if (h) pts.push(h);
        }
      }
      return pts;
    };
    const belt = (z: number): number => at(z)[4][1];
    for (const s of [-1, 1]) {
      const side = v3(-s, 0, 0);
      const flank = (z: number, y: number): [THREE.Vector3, THREE.Vector3] => [v3(s * hw, y, z), side];
      const zF = sh.zCowl + 0.105;
      const zB = sh.zPillarB;
      const zR = sh.zAxleR - 0.255;
      // the front door's front edge, the gap between the doors, the rear door's edge round the wheel arch, the sill
      gap(path([flank(zF, 0.37), flank(zF, belt(zF) - 0.02)]));
      gap(path([flank(zB, 0.37), flank(zB, belt(zB) - 0.012)]));
      gap(path([flank(zR, belt(zR) - 0.012), flank(zR, 0.63), flank(zR - 0.07, 0.55), flank(zR - 0.13, 0.42), flank(zR - 0.16, 0.37)]));
      gap(path([flank(zF, 0.37), flank(zR - 0.16, 0.37)], 0.05));
      // the bonnet's sides along the top of the wings, from the scuttle to its front
      const top = v3(0, -1, 0);
      const bonnetX = (z: number): number => s * (at(z)[5][0] - 0.05);
      const bonnet: Array<[THREE.Vector3, THREE.Vector3]> = [];
      for (let z = sh.zCowl - 0.09; z > sh.zFront + 0.1; z -= 0.08) bonnet.push([v3(bonnetX(z), 1.2, z), top]);
      bonnet.push([v3(bonnetX(sh.zFront + 0.105), 1.2, sh.zFront + 0.105), top]);
      gap(path(bonnet));
      // the tailgate: down the C pillar beside the rear window, over the corner inside the tail lamps, across the tail
      const zt = sh.zTail;
      // (on the pillar beside the rear window, a little below the roof's edge, seen square on)
      const cp = (z: number): [THREE.Vector3, THREE.Vector3] => {
        const [x4, y4] = at(z)[4];
        const [x5, y5] = at(z)[5];
        const n = new THREE.Vector2(y5 - y4, x4 - x5).normalize();
        const px = x5 + (x4 - x5) * 0.08;
        const py = y5 + (y4 - y5) * 0.08;
        return [v3(s * (px + n.x * 0.1), py + n.y * 0.1, z), v3(-s * n.x, -n.y, 0)];
      };
      const back = v3(0, -0.6, -0.8);
      gap(
        path([
          cp(sh.zRoofRear + 0.01),
          cp((sh.zRoofRear + zt) / 2),
          cp(zt - 0.01),
          [v3(s * 0.4, 1.3, zt + 0.07), back],
          [v3(s * 0.385, 1.3, sh.zRear - 0.06), back],
          [v3(s * 0.385, 0.745, sh.zRear + 0.3), v3(0, 0, -1)],
        ]),
      );
    }
    // the bonnet's front edge and the tailgate's lower edge, across
    gap(path([[v3(-(at(sh.zFront + 0.105)[5][0] - 0.05), 1.2, sh.zFront + 0.105), v3(0, -1, 0)], [v3(at(sh.zFront + 0.105)[5][0] - 0.05, 1.2, sh.zFront + 0.105), v3(0, -1, 0)]], 0.05));
    gap(path([[v3(-0.385, 0.745, sh.zRear + 0.3), v3(0, 0, -1)], [v3(0.385, 0.745, sh.zRear + 0.3), v3(0, 0, -1)]], 0.05));
    // the roof's rear edge over the tailgate
    gap(path([[v3(-(at(sh.zRoofRear + 0.01)[5][0] - 0.02), 2, sh.zRoofRear + 0.01), v3(0, -1, 0)], [v3(at(sh.zRoofRear + 0.01)[5][0] - 0.02, 2, sh.zRoofRear + 0.01), v3(0, -1, 0)]], 0.05));

    // ---- black trim: the B pillars, seals along the windows, the band round the windscreen, the scuttle ----
    for (const s of [-1, 1]) {
      const side = v3(-s, 0, 0);
      const zb = sh.zPillarB;
      // the B pillar between the windows
      out.add(GLOSS_BLACK, drape(body, (u, v) => v3(s * 1.4, belt(zb) + 0.004 + (at(zb)[5][1] - belt(zb) - 0.012) * v, zb - 0.044 + 0.088 * u), side, 3, 8, 0.0016));
      // the seal along the foot of the side windows, and the trim along their top
      const z0 = sh.zCowl + 0.125;
      const z1 = sh.zRoofRear - 0.17;
      const seal: Hit[] = [];
      const head: Hit[] = [];
      for (let z = z0; z <= z1 + 1e-6; z += 0.04) {
        const p = at(z);
        const h = glassy.onto(v3(s * hw, p[4][1] + 0.009, z), side);
        if (h) seal.push(h);
        if (z > sh.zRoofFront - 0.02) {
          const t = glassy.onto(v3(s * hw, p[5][1] - 0.012, z), side);
          if (t) head.push(t);
        }
      }
      if (seal.length > 1) out.add(GLOSS_BLACK, ribbon(seal, 0.016, 0.0018));
      if (head.length > 1) out.add(GLOSS_BLACK, ribbon(head, 0.014, 0.0018));
    }
    // the black band round the windscreen (along its foot and its top) and the scuttle panel under it
    const down = v3(0, -1, 0);
    const across = (z: number, x: number, n = 24): Hit[] => {
      const pts: Hit[] = [];
      for (let i = 0; i <= n; i++) {
        const h = glassy.onto(v3(-x + (2 * x * i) / n, 2, z), down);
        if (h) pts.push(h);
      }
      return pts;
    };
    out.add(GLOSS_BLACK, ribbon(across(sh.zCowl + 0.03, at(sh.zCowl + 0.03)[5][0] - 0.02), 0.045, 0.0016));
    out.add(GLOSS_BLACK, ribbon(across(sh.zRoofFront - 0.025, at(sh.zRoofFront - 0.025)[5][0] - 0.03), 0.04, 0.0016));
    const zs0 = sh.zCowl - 0.085;
    out.add(PLASTIC, drape(body, (u, v) => v3((at(zs0)[5][0] - 0.035) * (2 * u - 1), 2, zs0 + 0.082 * v), down, 16, 2, 0.002));
    // slots of the scuttle's air intake
    for (let i = 0; i < 9; i++) {
      const x = -0.42 + i * 0.105;
      const h = body.onto(v3(x, 2, zs0 + 0.04), down);
      if (h) out.add(GAP, Frame.on(h.p, h.n, v3(0, 0, -1)).box(0.08, 0.012, 0.004, 0, 0, 0.003));
    }

    // ---- the wipers, parked on the windscreen just above its foot ---------------
    const wiperParts = new Parts();
    for (const [x0, x1, zz, px] of [
      [-0.72, -0.06, sh.zCowl + 0.05, -0.47],
      [0.0, 0.6, sh.zCowl + 0.065, 0.16],
    ]) {
      const a = glassy.onto(v3(x0, 2, zz), down);
      const b = glassy.onto(v3(x1, 2, zz), down);
      const pivot = body.onto(v3(px, 2, sh.zCowl - 0.04), down);
      if (!a || !b || !pivot) continue;
      const n = a.n.clone().add(b.n).normalize();
      const dir = b.p.clone().sub(a.p);
      const len = dir.length();
      dir.normalize();
      // the blade: rubber on a slim carrier
      const f = new Frame(a.p.clone().add(b.p).multiplyScalar(0.5), dir, n.clone().cross(dir).negate(), n);
      wiperParts.add(RUBBER, f.box(len, 0.016, 0.01, 0, 0, 0.008), f.box(len * 0.9, 0.01, 0.012, 0, 0, 0.018));
      // the arm from the pivot to the middle of the blade
      const tip = f.at(0, 0, 0.024);
      const foot = pivot.p.clone().addScaledVector(pivot.n, 0.02);
      const arm = tip.clone().sub(foot);
      const fa = new Frame(foot.clone().add(tip).multiplyScalar(0.5), arm.clone().normalize(), pivot.n);
      wiperParts.add(RUBBER, fa.box(arm.length(), 0.012, 0.01), Frame.on(foot, pivot.n).cyl(0.018, 0.03, 0, 0, -0.008, 12));
    }
    this.keep(wiperParts.build(ext.group, 'wipers', true), 0);

    // ---- headlamps: following the curve of the nose, from the face up onto the bonnet's edge ----
    const lampParts = new Parts();
    // (rays from in front and above, down onto the nose: the low ones meet its face, the high ones the bonnet's edge)
    const front = v3(0, -0.6, 0.8);
    const zO = sh.zFront - 0.2;
    for (const s of [-1, 1]) {
      const xs = (u: number): number => s * (0.3 + 0.42 * u);
      const ys = (v: number): number => 0.778 + 0.15 * v;
      const o = (u: number, v: number): THREE.Vector3 => v3(xs(u), ys(v), zO);
      lampParts.add(HOUSING, drape(body, o, front, 14, 5, 0.004));
      // the daytime running light along its lower edge, the indicator at its outer end
      const drl: Hit[] = [];
      for (let i = 0; i <= 12; i++) {
        const h = body.hit(o(0.05 + 0.72 * (i / 12), 0.07), front);
        if (h) drl.push(h);
      }
      if (drl.length > 1) lampParts.add(ext.head, ribbon(drl, 0.011, 0.0065));
      lampParts.add(s < 0 ? ext.blinkL : ext.blinkR, drape(body, (u, v) => o(0.82 + 0.16 * u, 0.12 + 0.6 * v), front, 3, 3, 0.0065));
      // two projectors in chrome bowls, their lenses lit by the lamps' material
      for (const u of [0.3, 0.6]) {
        const h = body.hit(o(u, 0.55), front);
        if (!h) continue;
        const f = Frame.on(h.p, h.n);
        lampParts.add(CHROME, f.ring(0.026, 0.004, 0, 0, 0.007, 20), f.disc(0.025, 0, 0, 0.0055, 20));
        lampParts.add(ext.head, f.cyl(0.0125, 0.012, 0, 0, 0.012, 16));
      }
      // the clear cover over it all
      lampParts.add(LENS, drape(body, o, front, 14, 5, 0.013));
    }

    // ---- tail lamps: over the rear corners, round onto the flanks --------------
    const rear = v3(0, -0.6, -0.8);
    const zT = sh.zRear + 0.2;
    for (const s of [-1, 1]) {
      const xs = (u: number): number => s * (0.4 + 0.44 * u);
      const ys = (v: number): number => 0.985 + 0.2 * v;
      const o = (u: number, v: number): THREE.Vector3 => v3(xs(u), ys(v), zT);
      const part = (u0: number, u1: number, v0: number, v1: number, nu: number): THREE.BufferGeometry =>
        drape(body, (u, v) => o(u0 + (u1 - u0) * u, v0 + (v1 - v0) * v), rear, nu, 4, 0.0075);
      lampParts.add(HOUSING, drape(body, o, rear, 14, 5, 0.004));
      lampParts.add(ext.reverse, part(0.02, 0.12, 0.12, 0.88, 2));
      lampParts.add(s < 0 ? ext.blinkL : ext.blinkR, part(0.14, 0.27, 0.12, 0.88, 2));
      lampParts.add(ext.tail, part(0.29, 0.98, 0.08, 0.92, 10));
      // chrome ribs across the red
      for (const v of [0.3, 0.5, 0.7]) {
        const rib: Hit[] = [];
        for (let i = 0; i <= 10; i++) {
          const h = body.onto(o(0.3 + 0.67 * (i / 10), v), rear);
          if (h) rib.push(h);
        }
        if (rib.length > 1) lampParts.add(CHROME, ribbon(rib, 0.0035, 0.0095));
      }
      lampParts.add(LENS, drape(body, o, rear, 14, 5, 0.013));
    }
    this.keep(lampParts.build(ext.group, 'lamps'), 0);
    this.hide(...ext.lampMeshes);

    // ---- lower air intakes with a honeycomb mesh, and fog lamps -------------------
    const nose = sh.noseOutline;
    const halfAt = (y: number): number => {
      let w = Infinity;
      for (let i = 0; i + 1 < nose.length; i++) {
        const [x0, y0] = nose[i];
        const [x1, y1] = nose[i + 1];
        if (y0 === y1 || y < Math.min(y0, y1) || y > Math.max(y0, y1)) continue;
        w = Math.min(w, x0 + ((x1 - x0) * (y - y0)) / (y1 - y0));
      }
      return w === Infinity ? 0 : w;
    };
    const zf = sh.zFront;
    const faceF = new Frame(v3(0, 0, zf), v3(-1, 0, 0), v3(0, 1, 0), v3(0, 0, -1));
    const cells: THREE.Matrix4[] = [];
    for (const s of [-1, 1]) {
      const y0 = 0.318;
      const y1 = 0.428;
      const xi = 0.31;
      const xo = (y: number): number => halfAt(y) - 0.115;
      // the dark opening, its frame
      const outline: Array<[number, number]> = [
        [s * xi, y0],
        [s * xo(y0), y0],
        [s * xo(y1), y1],
        [s * xi, y1],
      ];
      const open = outline.map(([x, y]) => faceF.at(-x, y, 0.0015));
      const g = new THREE.BufferGeometry().setFromPoints(s > 0 ? [open[0], open[2], open[1], open[0], open[3], open[2]] : [open[0], open[1], open[2], open[0], open[2], open[3]]);
      g.computeVertexNormals();
      out.add(PLASTIC, g);
      for (let i = 0; i < 4; i++) {
        const [xa, ya] = outline[i];
        const [xb, yb] = outline[(i + 1) % 4];
        const mid = faceF.at(-(xa + xb) / 2, (ya + yb) / 2, 0.004);
        const d = v3(xb - xa, yb - ya, 0);
        const len = d.length() + 0.012;
        const f = new Frame(mid, d.normalize(), v3(0, 0, -1).cross(d).normalize(), v3(0, 0, -1));
        out.add(GLOSS_BLACK, f.box(len, 0.012, 0.008));
      }
      // the cells of the mesh, in rows inside the frame
      const r = 0.0105;
      for (let row = 0, y = y0 + 0.014; y < y1 - 0.01; row++, y += r * 1.55) {
        for (let x = xi + 0.016 + (row % 2) * r * 0.9; x < xo(y) - 0.012; x += r * 1.8) {
          cells.push(new THREE.Matrix4().makeTranslation(s * x, y, zf - 0.004));
        }
      }
      // the fog lamp at the outer end
      const fl = new Frame(v3(s * (halfAt(0.373) - 0.07), 0.373, zf - 0.002), v3(-1, 0, 0), v3(0, 1, 0), v3(0, 0, -1));
      out.add(CHROME, fl.ring(0.03, 0.005, 0, 0, 0.004, 20), fl.disc(0.029, 0, 0, 0.002, 20));
      out.add(ext.head, fl.cyl(0.016, 0.01, 0, 0, 0.007, 16));
    }
    // one hexagonal cell, drawn as many times as there are cells
    const hex: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      hex.push(new THREE.BoxGeometry(0.0108, 0.0022, 0.006).translate(0, 0.0094, 0).rotateZ(a));
    }
    const cellGeo = tubeFree(hex);
    const honeycomb = new THREE.InstancedMesh(cellGeo, PLASTIC, cells.length);
    cells.forEach((m, i) => honeycomb.setMatrixAt(i, m));
    honeycomb.name = 'grille mesh';
    ext.group.add(honeycomb);
    this.added.push(honeycomb);

    // ---- number plates with their seals, in holders ------------------------------
    const plateF = new Frame(v3(0, 0.36, zf - 0.017), v3(-1, 0, 0), v3(0, 1, 0), v3(0, 0, -1));
    const plateR = new Frame(v3(0, 0.66, sh.zRear + 0.017), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1));
    for (const [f, rearPlate] of [
      [plateF, false],
      [plateR, true],
    ] as Array<[Frame, boolean]>) {
      out.add(GLOSS_BLACK, slab(f, rounded(0.548, 0.136, 0.012), -0.006, 0.002));
      for (const u of [-0.205, 0.205]) out.add(CHROME, f.cyl(0.0045, 0.004, u, 0, 0.0045, 10));
      const plate = new THREE.Mesh(f.put(new THREE.PlaneGeometry(0.52, 0.11).translate(0, 0, 0.0025)), new THREE.MeshBasicMaterial({ map: plateTexture('KS FS 2026', rearPlate) }));
      plate.name = rearPlate ? 'number plate rear' : 'number plate front';
      ext.group.add(plate);
      this.added.push(plate);
    }

    // ---- badges on the nose and the tailgate --------------------------------------
    const badge = (h: Hit | null, up: THREE.Vector3): void => {
      if (!h) return;
      const f = Frame.on(h.p, h.n, up);
      const oval = rounded(0.085, 0.046, 0.0225, 4);
      out.add(CHROME, slab(f, oval, 0.001, 0.005));
      out.add(ENAMEL, slab(f, rounded(0.074, 0.036, 0.018, 4), 0.005, 0.0065));
      out.add(CHROME, f.box(0.052, 0.006, 0.003, 0, 0, 0.007), f.box(0.006, 0.026, 0.003, -0.012, 0, 0.007));
    };
    badge(body.hit(v3(0, 0.86, zO), front), v3(0, 0.8, 0.6));
    badge(body.hit(v3(0, 1.08, zT), rear), v3(0, 0.8, -0.6));

    // ---- door handles (body colour, in a dark recess) and the lock of the driver's door ----
    const handles = new Parts();
    for (const s of [-1, 1]) {
      for (const [z, y] of [
        [sh.zPillarB - 0.24, belt(sh.zPillarB - 0.24) - 0.095],
        [sh.zAxleR - 0.37, belt(sh.zAxleR - 0.37) - 0.095],
      ]) {
        const h = body.onto(v3(s * hw, y, z), v3(-s, 0, 0));
        if (!h) continue;
        const f = Frame.on(h.p, h.n);
        out.add(GAP, slab(f, rounded(0.15, 0.05, 0.022, 3), 0.0004, 0.0016));
        handles.add(paint, tubeOf([ringIn(f, rounded(0.135, 0.022, 0.01, 3), 0.004), ringIn(f, rounded(0.14, 0.026, 0.012, 3), 0.014), ringIn(f, rounded(0.13, 0.02, 0.009, 3), 0.022)]));
        if (s < 0 && z < sh.zPillarB) out.add(CHROME, f.cyl(0.0085, 0.006, s * 0.058, 0, 0.018, 12));
      }
    }
    this.keep(handles.build(ext.group, 'door handles', true), 0);

    // ---- the fuel flap on the right rear wing --------------------------------------
    {
      const h = body.onto(v3(hw, 0.79, sh.zAxleR + 0.02), v3(-1, 0, 0));
      if (h) {
        const f = Frame.on(h.p, h.n);
        const loop = rounded(0.17, 0.115, 0.03, 3).map(([u, v]): Hit => ({ p: f.at(u, v), n: h.n }));
        loop.push(loop[0], loop[1]);
        out.add(GAP, ribbon(loop, 0.005, 0.0022));
        out.add(GAP, f.box(0.012, 0.03, 0.002, -0.075, 0, 0.002));
      }
    }

    // ---- the exhaust tip under the tail, the antenna on the roof --------------------
    {
      const f = new Frame(v3(-0.44, 0.27, sh.zRear - 0.03), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1));
      out.add(CHROME, f.cyl(0.034, 0.13, 0, 0, 0, 18), f.ring(0.034, 0.003, 0, 0, 0.065, 18));
      out.add(GAP, f.disc(0.03, 0, 0, 0.064, 18));
      const roof = body.onto(v3(0, 2, sh.zRoofRear - 0.12), down);
      if (roof) {
        const fin: V3[][] = [];
        for (const [dz, hh, ww] of [
          [-0.085, 0.004, 0.012],
          [-0.05, 0.026, 0.036],
          [0.0, 0.05, 0.048],
          [0.045, 0.058, 0.046],
          [0.07, 0.034, 0.042],
          [0.08, 0.006, 0.036],
        ]) {
          const b = roof.p.clone().add(v3(0, -0.003, dz));
          fin.push(
            [
              [-ww / 2, 0],
              [ww / 2, 0],
              [ww * 0.32, hh * 0.72],
              [0, hh],
              [-ww * 0.32, hh * 0.72],
            ].map(([x, y]): V3 => [b.x + x, b.y + y, b.z]),
          );
        }
        out.add(GLOSS_BLACK, tubeOf(fin));
      }
    }

    // ---- the indicator repeaters on the door mirrors' housings ----------------------
    for (const m of car.mirrors) {
      if (m.spec.name === 'inside') continue;
      const s = m.spec.name === 'left' ? -1 : 1;
      const n = m.spec.normal.clone().normalize();
      const up = v3(0, 1, 0).addScaledVector(n, -n.y).normalize();
      const right = new THREE.Vector3().crossVectors(up, n);
      const outward = right.clone().multiplyScalar(s);
      const c = m.spec.centre.clone().addScaledVector(n, -0.055).addScaledVector(outward, m.spec.width / 2 - 0.002).addScaledVector(up, -m.spec.height * 0.18);
      const f = new Frame(c, n.clone().negate(), up, outward);
      out.add(s < 0 ? ext.blinkL : ext.blinkR, f.box(0.055, 0.016, 0.006));
    }

    this.keep(out.build(ext.group, 'body detail', false), 0);

    // ---- the wheels ---------------------------------------------------------------------
    const d = ext.dims;
    this.wheels = new WheelSet({ radius: d.wheelRadius, width: d.tyreWidth, rim: d.wheelRadius * 0.66, spokes: 10, nuts: 5, disc: true }, [-1, 1, -1, 1], { tyre: TYRE, metal: METAL, caliper: CALIPER });
    ext.group.add(this.wheels.group);
    this.added.push(this.wheels.group);
    for (const sp of ext.wheelSpinners) this.hide(...sp.children);
    // (where the plain ones stand now – before the first update, in a menu, the instances would all stand in the middle)
    this.placeWheels();

    // ================================================================= inside ====
    const soft = cabinMaterial(0x40444b);
    const hard = cabinMaterial(0x575d65);
    const pale = cabinMaterial(0xb9bbb8);
    const silver = cabinMaterial(0xb9bec4, 50);
    const black = cabinMaterial(0x1a1c20);
    const gloss = cabinMaterial(0x16181b, 60);
    const grip = cabinMaterial(0x1f2125, 12);
    const stitch = cabinMaterial(0x8d939a);
    const red = cabinMaterial(0xb3241c, 30);
    const inside = new Parts();
    const cockpit = car.cockpit;
    const ex = car.eye.x;
    const zc = sh.zCowl;
    const xe = hw * 0.975 - 0.022;
    // (the dashboard's shape as render/car.ts buildDashboard makes it)
    const browZ = (x: number): number => zc + 0.385 + 0.05 * Math.abs(x / xe) ** 3;
    const browY = (x: number): number => sh.beltY + 0.002 - 0.012 * (x / xe) ** 2;
    const cowlAt = (x: number): number => sh.cowlY + (sh.cowlCrownY - sh.cowlY) * (1 - Math.abs(x) / (hw * 0.9));
    const dashTop = (x: number, z: number): number => {
      const zf0 = zc + 0.004;
      const yf = cowlAt(x) - 0.014;
      const s = Math.max(0, Math.min(1, (z - zf0) / (browZ(x) - 0.032 - zf0)));
      return yf + (browY(x) - yf) * s + 0.006 * Math.sin(Math.PI * s);
    };
    const onDash = (x: number, z: number, lift = 0.0015): Frame => new Frame(v3(x, dashTop(x, z) + lift, z), v3(1, 0, 0), v3(0, 0, -1), v3(0, 1, 0));

    // ---- the dashboard: defroster grille along the windscreen, tweeters, buttons ----
    {
      const z = zc + 0.06;
      const rows: Hit[][] = [];
      for (const dz of [-0.022, 0.022]) {
        const row: Hit[] = [];
        for (let i = 0; i <= 12; i++) {
          const x = -0.3 + 0.05 * i;
          row.push({ p: v3(x, dashTop(x, z + dz) + 0.0015, z + dz), n: v3(0, 1, 0) });
        }
        rows.push(row);
      }
      inside.add(black, sheetRows(rows));
      for (let k = 0; k < 6; k++) {
        const dz = -0.016 + k * 0.0064;
        const row: Hit[] = [];
        for (let i = 0; i <= 12; i++) {
          const x = -0.29 + (0.58 * i) / 12;
          row.push({ p: v3(x, dashTop(x, z + dz) + 0.0035, z + dz), n: v3(0, 1, 0) });
        }
        inside.add(hard, ribbon(row, 0.0022, 0));
      }
      for (const s of [-1, 1]) {
        const f = onDash(s * 0.6, zc + 0.15);
        inside.add(black, f.disc(0.03, 0, 0, 0.0005, 18));
        inside.add(silver, f.ring(0.031, 0.0022, 0, 0, 0.001, 18));
        // the side windows' demister slots at the ends
        const g = onDash(s * (xe - 0.06), zc + 0.12);
        inside.add(black, g.box(0.05, 0.09, 0.002, 0, 0, 0.001));
      }
      // hazard button between the middle vents, on the face of the centre stack
      const ys = browY(0);
      const zs = browZ(0);
      const lean = Math.atan2(0.052 - 0.03, ys - 0.075 - 0.72);
      const onFace = (y: number): number => zs + 0.03 + (ys - 0.075 - y) * Math.tan(lean);
      const yh = ys - 0.118;
      const fh = new Frame(v3(0, yh, onFace(yh)), v3(1, 0, 0), v3(0, Math.cos(lean), -Math.sin(lean)));
      inside.add(red, fh.box(0.02, 0.016, 0.008, 0, 0, 0.004));
      // the start button right of the steering column, the light switch left of it
      const lowerZ = (x: number, y: number): number => browZ(x) + 0.004 - ((browY(x) - 0.1 - y) / 0.1) * 0.002;
      const fs = new Frame(v3(ex + 0.145, 0.8, lowerZ(ex + 0.145, 0.8)), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1));
      inside.add(silver, fs.ring(0.0135, 0.0028, 0, 0, 0.004, 18));
      inside.add(black, fs.cyl(0.012, 0.006, 0, 0, 0.004, 18));
      const fl = new Frame(v3(ex - 0.26, 0.82, lowerZ(ex - 0.26, 0.82)), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1));
      inside.add(silver, fl.ring(0.02, 0.003, 0, 0, 0.004, 18));
      inside.add(black, fl.cyl(0.017, 0.014, 0, 0, 0.008, 18), fl.box(0.006, 0.026, 0.006, 0, 0, 0.017));
      // the glove box's lock
      const gx = 0.62;
      const fg = new Frame(v3(gx, browY(gx) - 0.124, browZ(gx) + 0.01), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1));
      inside.add(silver, fg.cyl(0.009, 0.005, 0, 0, 0.002, 14));
      inside.add(black, fg.box(0.003, 0.009, 0.002, 0, 0, 0.005));
    }

    // ---- doors: switch panels, lock pins, pockets, tweeters -------------------------
    {
      const xg = hw * 0.975 - 0.006;
      const sill = (z: number): number => sh.beltY - 0.004 - (sh.beltY - (sh.cowlY - 0.015)) * Math.max(0, Math.min(1, (sh.zRoofFront - z) / (sh.zRoofFront - zc)));
      const armY = 0.735;
      const doors: Array<[number, number, number, boolean]> = [
        [-1, zc + 0.1, sh.zPillarB - 0.04, true],
        [1, zc + 0.1, sh.zPillarB - 0.04, true],
        [-1, sh.zPillarB + 0.04, sh.zRoofRear - 0.15, false],
        [1, sh.zPillarB + 0.04, sh.zRoofRear - 0.15, false],
      ];
      for (const [s, z0, z1, frontDoor] of doors) {
        const len = z1 - z0;
        const zp = z0 + len * 0.6;
        // the switch panel on the armrest (the driver's has its four switches already)
        const sp = new Frame(v3(s * (xg - 0.12), armY + 0.034, zp - len * 0.18), v3(0, 0, 1), v3(-s * Math.sin(0.12), Math.cos(0.12), 0));
        inside.add(gloss, sp.box(0.1, 0.004, 0.03));
        if (!(frontDoor && s < 0)) inside.add(silver, sp.box(0.022, 0.006, 0.012, 0, 0.004, 0));
        // the lock pin at the back of the sill
        const zl = z1 - 0.07;
        inside.add(silver, new Frame(v3(s * (xg - 0.035), sill(zl) + 0.006, zl), v3(1, 0, 0), v3(0, 0, -1), v3(0, 1, 0)).cyl(0.0045, 0.024, 0, 0, 0.004, 10));
        // the pocket along the foot of the panel
        inside.add(hard, new Frame(v3(s * (xg - 0.095), 0.37, z0 + len * 0.5), v3(0, 0, 1), v3(0, 1, 0)).box(len * 0.72, 0.05, 0.016));
        // a tweeter in the front corner of a front door
        if (frontDoor) {
          const zt0 = z0 + 0.07;
          const ft = new Frame(v3(s * (xg - 0.077), sill(zt0) - 0.045, zt0), v3(0, 0, s), v3(0, 1, 0), v3(-s, 0, 0));
          inside.add(black, ft.disc(0.022, 0, 0, 0.002, 16));
          inside.add(silver, ft.ring(0.023, 0.0022, 0, 0, 0.002, 16));
        }
      }
    }

    // ---- seat-belt buckles, the belts' height adjusters on the B pillars ----------------
    for (const s of [-1, 1]) {
      const x = s * 0.106;
      const f = new Frame(v3(x, 0.52, 0.29), v3(0, 0, 1), v3(0, 1, 0));
      inside.add(black, f.box(0.035, 0.07, 0.016), f.box(0.02, 0.12, 0.012, 0, -0.09, 0));
      inside.add(red, f.box(0.012, 0.008, 0.012, 0, 0.037, 0));
      // (the pillar's lining runs up and in along the side glass)
      const p = at(sh.zPillarB);
      const [x4, y4] = p[4];
      const [x5, y5] = p[5];
      const yb = 1.15;
      const xb = x4 + ((x5 - x4) * (yb - y4)) / (y5 - y4) - 0.03;
      const pb = new Frame(v3(s * xb, yb, sh.zPillarB), v3(0, 0, s), v3(s * (x5 - x4), y5 - y4, 0).normalize());
      inside.add(black, pb.box(0.016, 0.08, 0.006));
    }

    // ---- the roof: sun-visor clips and mirror lids, grab handles, the console's buttons, the mirror's sensor ----
    {
      const roofAt = (x: number): number => sh.roofY - 0.004 - 0.051 * (Math.abs(x) / (hw * 0.74)) - 0.025;
      for (const s of [-1, 1]) {
        const vx = s * 0.465;
        const vf = new Frame(v3(vx, roofAt(0.465) - 0.008, sh.zRoofFront + 0.105), v3(Math.cos(0.077), -s * Math.sin(0.077), 0), v3(s * Math.sin(0.077), Math.cos(0.077), 0));
        inside.add(hard, vf.box(0.17, 0.002, 0.085, 0.02, -0.0075, 0));
        inside.add(pale, new Frame(v3(s * 0.285, roofAt(0.285) - 0.012, sh.zRoofFront + 0.06), v3(1, 0, 0), v3(0, 1, 0)).box(0.03, 0.012, 0.026));
        inside.add(pale, new Frame(v3(s * 0.66, roofAt(0.66) - 0.012, sh.zRoofFront + 0.06), v3(1, 0, 0), v3(0, 1, 0)).box(0.035, 0.016, 0.03));
      }
      // grab handles over the passenger's door and the rear doors
      for (const [s, z] of [
        [1, (sh.zRoofFront + sh.zPillarB) / 2 + 0.02],
        [-1, (sh.zPillarB + sh.zRoofRear) / 2],
        [1, (sh.zPillarB + sh.zRoofRear) / 2],
      ]) {
        // (from the corner of the lining, where roof and side glass meet, down and in)
        const x = s * (at(z)[5][0] - 0.03);
        const y = at(z)[5][1] - 0.03;
        const f = new Frame(v3(x, y, z), v3(0, 0, 1), v3(s * 0.5, 0.87, 0));
        inside.add(hard, f.box(0.19, 0.014, 0.016, 0, -0.045, 0), f.box(0.014, 0.045, 0.014, -0.085, -0.0225, 0), f.box(0.014, 0.045, 0.014, 0.085, -0.0225, 0));
      }
      const cz = sh.zRoofFront + 0.2;
      const cy = roofAt(0.03) - 0.014;
      for (const dx of [0.012, 0.048]) inside.add(black, new Frame(v3(dx, cy - 0.001, cz - 0.04), v3(1, 0, 0), v3(0, 0, -1), v3(0, -1, 0)).box(0.014, 0.012, 0.004));
      inside.add(red, new Frame(v3(0.03, cy - 0.001, cz + 0.042), v3(1, 0, 0), v3(0, 0, -1), v3(0, -1, 0)).box(0.018, 0.01, 0.005));
      const mirror = car.mirrors.find((m) => m.spec.name === 'inside');
      if (mirror) {
        const c = mirror.spec.centre;
        inside.add(black, new Frame(v3(c.x + 0.035, sh.roofY - 0.05, sh.zRoofFront - 0.008), v3(1, 0, 0), v3(0, 1, 0)).box(0.085, 0.034, 0.045));
      }
    }
    this.keep(inside.build(cockpit, 'cockpit detail'), 0);

    // ---- the instrument cluster: dials in chrome rings, needle hubs, the centre display's frame ----
    const dial = cockpit.getObjectByName('cluster') as THREE.Mesh | undefined;
    if (dial) {
      const w = (dial.geometry as THREE.PlaneGeometry).parameters.width;
      const h = (dial.geometry as THREE.PlaneGeometry).parameters.height;
      const k = w / 768;
      const cl = new Parts();
      const f = new Frame(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0));
      for (const u of [(150 - 384) * k, (618 - 384) * k]) {
        const r = 116 * k;
        cl.add(silver, f.ring(r + 0.002, 0.0017, u, 0, 0.004, 40));
        // the cup round the dial (seen from inside) and the needle's hub
        cl.add(black, lathe([[r + 0.004, 0.0035], [r + 0.004, 0]], 32).rotateY(-Math.PI / 2).translate(u, 0, 0));
        cl.add(gloss, f.cyl(0.0075, 0.005, u, 0, 0.0025, 14));
      }
      const cw = 100 * k;
      const chh = (100 / 256) * h;
      for (const [bw, bh, bu, bv] of [
        [2 * cw + 0.004, 0.002, 0, chh],
        [2 * cw + 0.004, 0.002, 0, -chh],
        [0.002, 2 * chh, -cw, 0],
        [0.002, 2 * chh, cw, 0],
      ]) cl.add(silver, f.box(bw, bh, 0.002, bu, bv, 0.001));
      // (solid like the instruments when the cabin is see-through)
      this.keep(cl.build(dial, 'cluster detail'), -1);
    }

    // ---- the steering wheel: airbag pad with its badge, buttons on the spokes, grips, stitching ----
    {
      const sw = new Parts();
      const R = 0.17;
      const ring = (a: number, b: number, c: number, z: number, n = 18): V3[] => {
        const pts: V3[] = [];
        for (let i = 0; i < n; i++) {
          const phi = (i / n) * Math.PI * 2;
          const cs = Math.cos(phi);
          const sn = Math.sin(phi);
          pts.push([a * Math.sign(cs) * Math.sqrt(Math.abs(cs)), (sn >= 0 ? b : c) * Math.sign(sn) * Math.sqrt(Math.abs(sn)) - 0.004, z]);
        }
        return pts;
      };
      sw.add(grip, tubeOf([ring(0.06, 0.039, 0.045, -0.0215), ring(0.058, 0.037, 0.043, -0.015), ring(0.05, 0.031, 0.037, -0.0105), ring(0.03, 0.019, 0.022, -0.0088)]));
      const fb = new Frame(v3(0, -0.002, -0.0082), v3(1, 0, 0), v3(0, 1, 0));
      sw.add(silver, fb.ring(0.0105, 0.0016, 0, 0, 0, 20), fb.box(0.016, 0.003, 0.0015, 0, 0, 0.0005));
      for (const s of [-1, 1]) {
        const ry = s * 0.2;
        const pf = new Frame(v3(s * 0.098, -0.004, -0.0125), v3(Math.cos(ry), 0, -Math.sin(ry)), v3(0, 1, 0));
        sw.add(silver, pf.ring(0.0075, 0.0013, -s * 0.006, 0.002, 0.0028, 16));
        sw.add(gloss, pf.cyl(0.0042, 0.003, -s * 0.006, 0.002, 0.0028, 12));
        for (const dv of [-0.0075, 0.0075]) sw.add(gloss, pf.box(0.008, 0.0055, 0.003, s * 0.011, dv, 0.0028));
      }
      // the grips at a quarter to three, the stitching round the inside of the rim
      for (const centre of [0, Math.PI]) sw.add(grip, new THREE.TorusGeometry(R, 0.0164, 8, 10, 0.85).rotateZ(centre - 0.425));
      sw.add(stitch, new THREE.TorusGeometry(R - 0.009, 0.0008, 4, 72).translate(0, 0, 0.0122));
      this.keep(sw.build(car.steering, 'steering wheel detail'), 1);
    }

    // ---- ribbed ends of the stalks -------------------------------------------------------
    {
      const st = new Parts();
      for (const x of [-0.19, -0.21]) st.add(silver, new THREE.TorusGeometry(0.0108, 0.0011, 5, 16).rotateY(Math.PI / 2).translate(x, 0, 0));
      this.keep(st.build(car.stalk, 'stalk detail'), 1);
      const column = car.stalk.parent;
      if (column) {
        const right = new THREE.Group();
        right.position.set(0, 0.04, -0.085);
        right.rotation.z = -0.06;
        column.add(right);
        this.added.push(right);
        const sr = new Parts();
        for (const x of [0.19, 0.21]) sr.add(silver, new THREE.TorusGeometry(0.0108, 0.0011, 5, 16).rotateY(Math.PI / 2).translate(x, 0, 0));
        for (const m of sr.build(right, 'stalk detail')) this.ghosts.push([m, 1]);
      }
    }

    // ---- the gear knob's shift pattern, the selector's P R N D, a chrome collar --------------
    {
      const lv = new Parts();
      lv.add(silver, new THREE.TorusGeometry(0.0105, 0.0024, 6, 18).rotateX(Math.PI / 2).translate(0, 0.182, 0));
      this.keep(lv.build(car.lever, 'gear lever detail'), 1);
      const tex = new THREE.CanvasTexture(patternCanvas());
      tex.colorSpace = THREE.SRGBColorSpace;
      const top = new THREE.Mesh(knobCap(), new THREE.MeshLambertMaterial({ map: tex, emissive: 0x444444, emissiveMap: tex }));
      top.name = 'shift pattern';
      car.lever.add(top);
      this.added.push(top);
      this.pattern = top;
      this.selectorCanvas = document.createElement('canvas');
      this.selectorCanvas.width = 64;
      this.selectorCanvas.height = 128;
      this.selectorTexture = new THREE.CanvasTexture(this.selectorCanvas);
      this.selectorTexture.colorSpace = THREE.SRGBColorSpace;
      this.selector = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.06).rotateX(-Math.PI / 2).translate(0.075, 0.5115, -0.12), new THREE.MeshBasicMaterial({ map: this.selectorTexture, toneMapped: false }));
      this.selector.name = 'selector display';
      cockpit.add(this.selector);
      this.added.push(this.selector);
    }

    // ---- the handbrake's slot, ribbed rubber on the pedals --------------------------------------
    {
      const hb = new Parts();
      hb.add(black, new Frame(v3(0.058, 0.5105, 0.12), v3(1, 0, 0), v3(0, 0, -1), v3(0, 1, 0)).box(0.05, 0.18, 0.002));
      this.keep(hb.build(cockpit, 'handbrake detail'), 0);
      car.pedals.forEach((p, i) => {
        const pp = new Parts();
        const throttle = i === 2;
        const n = throttle ? 8 : 5;
        for (let k = 0; k < n; k++) {
          const y = throttle ? -0.25 + (k * 0.1) / (n - 1) : -0.252 + (k * 0.044) / (n - 1);
          pp.add(black, new THREE.BoxGeometry(throttle ? 0.04 : 0.062, 0.0035, 0.004).translate(0, y, 0.0145));
        }
        this.keep(pp.build(p, 'pedal detail'), 0);
      });
    }
  }

  /** What the finer model added (for the parts that open to take theirs: render/caropen.ts). */
  get meshes(): readonly THREE.Object3D[] {
    return this.added;
  }

  /** Keep the meshes as part of the finer model (and of the see-through cabin, in `layer`; −1: never see-through). */
  private keep(meshes: THREE.Mesh[], layer: number): void {
    for (const m of meshes) {
      this.added.push(m);
      // (transparent ones – the lamps' clear covers – stay as they are)
      if (layer >= 0 && !(m.material as THREE.Material).transparent) this.ghosts.push([m, layer]);
    }
  }

  /** Parts of the plain model that the finer one takes the place of. */
  private hide(...objects: THREE.Object3D[]): void {
    this.plain.push(...objects);
  }

  show(on: boolean): void {
    this.on = on;
    for (const o of this.added) o.visible = on;
    for (const o of this.plain) o.visible = !on;
    this.pattern.visible = on && !this.automatic;
    this.selector.visible = on && this.automatic;
    if (on) this.selectorShown = '';
  }

  /** The detailed wheels where the plain ones stand (their steering and turning). */
  private placeWheels(): void {
    const ext = this.car.exterior;
    for (let i = 0; i < 4; i++) {
      const w = ext.wheels[i];
      this.wheels.place(i, this.wheelPos.copy(w.position), -w.rotation.y, -ext.wheelSpinners[i].rotation.x);
    }
  }

  /** The moving parts: the wheels as the plain ones stand, the gear knob or the selector's display. */
  update(s: CarVisualState): void {
    this.placeWheels();
    this.automatic = s.automatic;
    this.pattern.visible = this.on && !s.automatic;
    const want = s.automatic ? `${s.gear}` : '';
    this.selector.visible = this.on && s.automatic;
    if (s.automatic && want !== this.selectorShown) {
      this.selectorShown = want;
      drawSelector(this.selectorCanvas, s.gear);
      this.selectorTexture.needsUpdate = true;
    }
  }
}

/** A sheet through two rows of points with their normals (no lift). */
function sheetRows(rows: Hit[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  for (let j = 0; j + 1 < rows.length; j++) {
    for (let i = 0; i + 1 < rows[j].length; i++) {
      const a = rows[j][i];
      const b = rows[j][i + 1];
      const c = rows[j + 1][i + 1];
      const d = rows[j + 1][i];
      const f = new THREE.Vector3().subVectors(b.p, a.p).cross(new THREE.Vector3().subVectors(d.p, a.p));
      const quad = f.dot(a.n) >= 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
      for (const h of quad) {
        pos.push(h.p.x, h.p.y, h.p.z);
        nrm.push(h.n.x, h.n.y, h.n.z);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/** The top of the gear knob (a cap of its sphere, render/car.ts), with the picture laid flat over it from above. */
function knobCap(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.0274, 20, 4, 0, Math.PI * 2, 0, 0.55);
  g.scale(1, 0.9, 1.05).translate(0, 0.205, 0);
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const r = 0.0274 * Math.sin(0.55);
  // (seen from above: x to the right, forwards – towards −z – up the picture)
  for (let i = 0; i < pos.count; i++) uv.setXY(i, 0.5 + pos.getX(i) / (2 * r), 0.5 - pos.getZ(i) / (2 * r * 1.05));
  return g;
}

/** Boxes merged as they are (for a small repeated part). */
function tubeFree(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const p = new Parts();
  const tmp = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial();
  p.add(mat, ...parts);
  const [m] = p.build(tmp, 'cell');
  return m.geometry;
}

/** The shift pattern on the knob: 1 3 5 above, 2 4 6 below, R at the left. */
function patternCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const x = c.getContext('2d')!;
  x.fillStyle = '#16181b';
  x.fillRect(0, 0, 128, 128);
  x.strokeStyle = '#d9dde2';
  x.lineWidth = 5;
  x.lineCap = 'round';
  x.beginPath();
  for (const gx of [28, 64, 100]) {
    x.moveTo(gx, 34);
    x.lineTo(gx, 94);
  }
  x.moveTo(28, 64);
  x.lineTo(100, 64);
  x.stroke();
  x.fillStyle = '#d9dde2';
  x.font = '700 22px Arial, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  ['1', '3', '5'].forEach((d, i) => x.fillText(d, 28 + i * 36, 20));
  ['2', '4', '6'].forEach((d, i) => x.fillText(d, 28 + i * 36, 110));
  x.fillText('R', 10, 64);
  return c;
}

/** The selector's display: P R N D, the one engaged lit. */
function drawSelector(c: HTMLCanvasElement, gear: number): void {
  const x = c.getContext('2d');
  if (!x) return;
  x.fillStyle = '#0d0f12';
  x.fillRect(0, 0, 64, 128);
  x.font = '700 24px Arial, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  const on = gear === -2 ? 'P' : gear === -1 ? 'R' : gear === 0 ? 'N' : 'D';
  ['P', 'R', 'N', 'D'].forEach((l, i) => {
    x.fillStyle = l === on ? '#ffffff' : '#5b636c';
    x.fillText(l, 32, 18 + i * 30);
  });
}
