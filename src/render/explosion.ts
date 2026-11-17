// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A vehicle that hits a building hard goes up in flames: a flash, a ball of
 * fire that swells and rises, dark smoke that climbs and spreads for a long
 * while, pieces flying and bouncing over the road, and a burnt patch where
 * it was.  Drawn with a few dozen sprites and one instanced mesh: cheap
 * enough for a phone, and gone again (`clear`) when the player takes a new
 * vehicle and drives off.
 */

import * as THREE from 'three';

/** a soft round blob for the sprites: `inner` colour in the middle, fading out */
function blobTexture(stops: Array<[number, string]>): THREE.CanvasTexture {
  const n = 64;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    for (const [at, col] of stops) grad.addColorStop(at, col);
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const FIRE = 14;
const SMOKE = 18;
const PIECES = 36;
/** how long the smoke rises (s) – the burnt patch and the pieces stay until `clear` */
const SMOKE_TIME = 11;
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();

interface Puff {
  sprite: THREE.Sprite;
  /** offset from the middle at the start, its speed, when it starts, how big it grows */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  delay: number;
  size: number;
}

export class Explosion {
  readonly group = new THREE.Group();
  private readonly fire: Puff[] = [];
  private readonly smoke: Puff[] = [];
  private readonly pieces: THREE.InstancedMesh;
  /** per piece: position, velocity, spin (x, y, z each), and whether it lies still */
  private readonly pp = new Float32Array(PIECES * 3);
  private readonly pv = new Float32Array(PIECES * 3);
  private readonly pr = new Float32Array(PIECES * 3);
  private readonly pw = new Float32Array(PIECES * 3);
  private readonly ps = new Float32Array(PIECES);
  private readonly scorch: THREE.Mesh;
  private readonly flash = new THREE.PointLight(0xffb060, 0, 70, 1.6);
  private readonly fireMat: THREE.SpriteMaterial[] = [];
  private readonly smokeMat: THREE.SpriteMaterial[] = [];
  /** seconds since the blast (-1: none) */
  private t = -1;
  private readonly at = new THREE.Vector3();
  /** the ground height under a point (for the pieces to land on) */
  private ground: (x: number, z: number) => number = () => this.at.y;
  private rand = Math.random;

  constructor() {
    this.group.name = 'explosion';
    this.group.visible = false;
    const fireTex = blobTexture([[0, 'rgba(255,255,235,1)'], [0.25, 'rgba(255,214,120,0.95)'], [0.55, 'rgba(255,120,30,0.6)'], [1, 'rgba(120,30,0,0)']]);
    const smokeTex = blobTexture([[0, 'rgba(60,58,56,0.9)'], [0.5, 'rgba(48,46,44,0.55)'], [1, 'rgba(40,40,40,0)']]);
    for (let i = 0; i < FIRE; i++) {
      const m = new THREE.SpriteMaterial({ map: fireTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
      this.fireMat.push(m);
      const s = new THREE.Sprite(m);
      s.renderOrder = 3;
      this.fire.push({ sprite: s, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, delay: 0, size: 1 });
      this.group.add(s);
    }
    for (let i = 0; i < SMOKE; i++) {
      const m = new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, fog: true });
      this.smokeMat.push(m);
      const s = new THREE.Sprite(m);
      s.renderOrder = 2;
      this.smoke.push({ sprite: s, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, delay: 0, size: 1 });
      this.group.add(s);
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.pieces = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.3 }), PIECES);
    this.pieces.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pieces.frustumCulled = false;
    this.pieces.castShadow = true;
    this.group.add(this.pieces);
    // the burnt patch: dark in the middle, fading at its edge
    const scorchTex = blobTexture([[0, 'rgba(10,8,6,0.92)'], [0.6, 'rgba(20,16,12,0.6)'], [1, 'rgba(30,26,20,0)']]);
    this.scorch = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: scorchTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    );
    this.scorch.renderOrder = 1;
    this.group.add(this.scorch, this.flash);
  }

  /** Is something of it still to be seen? */
  get active(): boolean {
    return this.t >= 0;
  }

  /**
   * The blast at (x, y, z) – the vehicle's middle on the ground – with
   * pieces in the vehicle's colour; `ground` gives the height of the ground
   * where a piece comes down.
   */
  start(x: number, y: number, z: number, colour: THREE.ColorRepresentation, ground?: (x: number, z: number) => number, rand: () => number = Math.random): void {
    this.at.set(x, y, z);
    this.ground = ground ?? (() => y);
    this.rand = rand;
    this.t = 0;
    this.group.visible = true;
    const r = this.rand;
    for (const f of this.fire) {
      const a = r() * Math.PI * 2;
      const out = 0.5 + r() * 1.8;
      f.x = Math.cos(a) * out;
      f.z = Math.sin(a) * out;
      f.y = 0.4 + r() * 1.2;
      f.vx = Math.cos(a) * (1 + r() * 3);
      f.vz = Math.sin(a) * (1 + r() * 3);
      f.vy = 2 + r() * 4;
      f.delay = r() * 0.25;
      f.size = 5 + r() * 4;
    }
    for (const s of this.smoke) {
      const a = r() * Math.PI * 2;
      const out = r() * 2;
      s.x = Math.cos(a) * out;
      s.z = Math.sin(a) * out;
      s.y = 1 + r() * 1.5;
      s.vx = Math.cos(a) * (0.3 + r() * 0.8) + 0.6;
      s.vz = Math.sin(a) * (0.3 + r() * 0.8);
      s.vy = 1.2 + r() * 1.6;
      s.delay = 0.25 + r() * 2.5;
      s.size = 9 + r() * 8;
    }
    const base = new THREE.Color(colour);
    const dark = new THREE.Color(0x2a2826);
    const col = new THREE.Color();
    for (let i = 0; i < PIECES; i++) {
      const a = r() * Math.PI * 2;
      const up = 0.25 + r() * 0.9;
      const sp = 5 + r() * 10;
      this.pp[i * 3] = x + Math.cos(a) * 0.8;
      this.pp[i * 3 + 1] = y + 0.6 + r() * 0.8;
      this.pp[i * 3 + 2] = z + Math.sin(a) * 0.8;
      this.pv[i * 3] = Math.cos(a) * sp * (1 - up * 0.5);
      this.pv[i * 3 + 1] = sp * up;
      this.pv[i * 3 + 2] = Math.sin(a) * sp * (1 - up * 0.5);
      for (let k = 0; k < 3; k++) {
        this.pr[i * 3 + k] = r() * Math.PI;
        this.pw[i * 3 + k] = (r() - 0.5) * 14;
      }
      this.ps[i] = 0;
      col.copy(i % 3 === 0 ? dark : base).multiplyScalar(0.55 + r() * 0.4);
      this.pieces.setColorAt(i, col);
    }
    if (this.pieces.instanceColor) this.pieces.instanceColor.needsUpdate = true;
    this.scorch.position.set(x, this.ground(x, z) + 0.03, z);
    this.scorch.scale.setScalar(0.2);
    this.flash.position.set(x, y + 2, z);
    this.update(0);
  }

  /** Time passes: the fire swells and fades, the smoke climbs, the pieces fly and come to rest. */
  update(dt: number): void {
    if (this.t < 0) return;
    this.t += dt;
    const t = this.t;
    const at = this.at;
    // the flash: at once, gone within half a second
    this.flash.intensity = t < 0.6 ? 900 * (1 - t / 0.6) ** 2 : 0;
    this.flash.visible = t < 0.6;
    // the ball of fire
    for (let i = 0; i < FIRE; i++) {
      const f = this.fire[i];
      const life = t - f.delay;
      const m = this.fireMat[i];
      if (life < 0 || life > 1.9) {
        f.sprite.visible = false;
        continue;
      }
      f.sprite.visible = true;
      const k = life / 1.9;
      const drag = 1 - Math.exp(-2.5 * life);
      f.sprite.position.set(at.x + f.x + (f.vx / 2.5) * drag, at.y + f.y + (f.vy / 2.5) * drag + life * 1.2, at.z + f.z + (f.vz / 2.5) * drag);
      f.sprite.scale.setScalar(f.size * (0.25 + 0.75 * Math.min(1, life / 0.45)) * (1 + 0.3 * k));
      m.opacity = k < 0.2 ? 1 : Math.max(0, 1 - (k - 0.2) / 0.8);
      // white-hot, then orange, then a dull red
      m.color.setRGB(1, Math.max(0.25, 1 - k * 1.1), Math.max(0.08, 0.8 - k * 1.6));
    }
    // the smoke
    for (let i = 0; i < SMOKE; i++) {
      const s = this.smoke[i];
      const life = t - s.delay;
      const m = this.smokeMat[i];
      if (life < 0 || life > SMOKE_TIME) {
        s.sprite.visible = false;
        continue;
      }
      s.sprite.visible = true;
      const k = life / SMOKE_TIME;
      s.sprite.position.set(at.x + s.x + s.vx * life, at.y + s.y + s.vy * life * (1 - k * 0.35), at.z + s.z + s.vz * life);
      s.sprite.scale.setScalar(s.size * (0.3 + 0.7 * Math.sqrt(k)));
      m.opacity = 0.62 * Math.min(1, life / 0.8) * (1 - k) ** 1.4;
    }
    // the pieces: thrown, falling, bouncing, then lying where they came to rest
    for (let i = 0; i < PIECES; i++) {
      const j = i * 3;
      if (this.ps[i] === 0 && dt > 0) {
        this.pv[j + 1] -= 9.81 * dt;
        this.pp[j] += this.pv[j] * dt;
        this.pp[j + 1] += this.pv[j + 1] * dt;
        this.pp[j + 2] += this.pv[j + 2] * dt;
        for (let k = 0; k < 3; k++) this.pr[j + k] += this.pw[j + k] * dt;
        const g = this.ground(this.pp[j], this.pp[j + 2]) + 0.06;
        if (this.pp[j + 1] < g) {
          this.pp[j + 1] = g;
          if (this.pv[j + 1] < -1.2) {
            // a bounce, losing most of its speed
            this.pv[j + 1] *= -0.3;
            this.pv[j] *= 0.55;
            this.pv[j + 2] *= 0.55;
            for (let k = 0; k < 3; k++) this.pw[j + k] *= 0.5;
          } else {
            this.ps[i] = 1;
            this.pr[j] = 0;
            this.pr[j + 2] = 0;
          }
        }
      }
      const size = 0.12 + ((i * 37) % 11) * 0.03;
      tmpS.set(size * 2.2, size * 0.5, size * 1.5);
      tmpQ.setFromEuler(tmpE.set(this.pr[j], this.pr[j + 1], this.pr[j + 2]));
      tmpP.set(this.pp[j], this.pp[j + 1], this.pp[j + 2]);
      tmpM.compose(tmpP, tmpQ, tmpS);
      this.pieces.setMatrixAt(i, tmpM);
    }
    this.pieces.instanceMatrix.needsUpdate = true;
    // the burnt patch spreads with the fire
    this.scorch.scale.setScalar(Math.min(1, 0.2 + t * 1.6));
  }

  /** All of it gone (a new vehicle, a new drive). */
  clear(): void {
    this.t = -1;
    this.group.visible = false;
    this.flash.intensity = 0;
  }
}
