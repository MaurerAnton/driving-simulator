// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The pedestrian lights (world/pedlights.ts says where they stand): a head
 * with the red standing and the green walking figure, facing across the
 * road, and the yellow box with the button and the lamp "Signal kommt".
 * Everything instanced – a town has hundreds of them.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SignalSystem } from '../sim/signals.ts';
import type { PedPole } from '../world/pedlights.ts';

const HEAD_Y = 2.25;
const BOX_Y = 1.05;

/** The two figures side by side, white on dark (the lamp's colour comes from the instance). */
function figures(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#161616';
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#ffffff';
  g.lineCap = 'round';
  // standing: head, body, arms down, legs together
  g.beginPath();
  g.arc(32, 13, 6, 0, Math.PI * 2);
  g.fill();
  g.fillRect(25, 21, 14, 20);
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(22, 23);
  g.lineTo(21, 38);
  g.moveTo(42, 23);
  g.lineTo(43, 38);
  g.moveTo(29, 41);
  g.lineTo(29, 58);
  g.moveTo(35, 41);
  g.lineTo(35, 58);
  g.stroke();
  // walking: leaning forwards, legs and arms apart
  g.beginPath();
  g.arc(98, 12, 6, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 9;
  g.beginPath();
  g.moveTo(96, 22);
  g.lineTo(93, 38);
  g.stroke();
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(95, 24);
  g.lineTo(84, 33);
  g.moveTo(96, 24);
  g.lineTo(107, 32);
  g.moveTo(93, 38);
  g.lineTo(84, 57);
  g.moveTo(93, 38);
  g.lineTo(104, 57);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** "Signal kommt" in white on black. */
function requestText(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 48;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#101010';
  g.fillRect(0, 0, 128, 48);
  g.fillStyle = '#ffffff';
  g.font = 'bold 19px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('Signal', 64, 15);
  g.fillText('kommt', 64, 35);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A quad facing −z, showing the part u0…u1 of a texture. */
function quad(w: number, h: number, u0: number, u1: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) < 0.5 ? u0 : u1);
  // (PlaneGeometry faces +z: turned round)
  g.rotateY(Math.PI);
  return g;
}

const RED = new THREE.Color(1, 0.16, 0.1);
const GREEN = new THREE.Color(0.25, 1, 0.5);
const OFF = new THREE.Color(0.13, 0.13, 0.13);
const WHITE = new THREE.Color(1, 0.95, 0.85);

export class PedLightRenderer {
  readonly group = new THREE.Group();
  private poles: readonly PedPole[] = [];
  private meshes: THREE.InstancedMesh[] = [];
  private red: THREE.InstancedMesh | null = null;
  private green: THREE.InstancedMesh | null = null;
  private lamp: THREE.InstancedMesh | null = null;
  /** what each pole shows now: 0 red, 1 green, 2 dark (−1: not set yet); the request lamp */
  private shown = new Int8Array(0);
  private asked = new Int8Array(0);
  private readonly figureTex = figures();
  private readonly requestTex = requestText();
  // (in front of the face of the head and of the box, also from afar: drawn nearer than the faces they lie on)
  private readonly figureMat = new THREE.MeshBasicMaterial({ map: this.figureTex, fog: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  private readonly requestMat = new THREE.MeshBasicMaterial({ map: this.requestTex, fog: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  private readonly housingMat = new THREE.MeshLambertMaterial({ color: 0x1d2022 });
  private readonly boxMat = new THREE.MeshLambertMaterial({ color: 0xe8b800 });

  constructor() {
    this.group.name = 'pedestrian lights';
  }

  /** Set the lights up anew (the road network comes in pieces). */
  rebuild(poles: readonly PedPole[]): void {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
    this.meshes = [];
    this.poles = poles;
    const n = poles.length;
    this.shown = new Int8Array(n).fill(-1);
    this.asked = new Int8Array(n).fill(-1);
    if (n === 0) {
      this.red = this.green = this.lamp = null;
      return;
    }
    const bare = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
      const k = g.index ? g.toNonIndexed() : g;
      k.deleteAttribute('uv');
      return k;
    };
    // pole and head (the head turned to face across the road is placed by the instance; the pole is round)
    const housing = mergeGeometries([bare(new THREE.CylinderGeometry(0.045, 0.05, HEAD_Y + 0.35, 8, 1, true).translate(0, (HEAD_Y + 0.35) / 2, 0)), bare(new THREE.BoxGeometry(0.26, 0.62, 0.17).translate(0, HEAD_Y, 0.05))], false)!;
    housing.computeVertexNormals();
    // the box with its button, on the pole (turned by its own instance)
    const box = mergeGeometries([bare(new THREE.BoxGeometry(0.13, 0.26, 0.1).translate(0, BOX_Y, -0.09)), bare(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 12).rotateX(Math.PI / 2).translate(0, BOX_Y - 0.06, -0.145))], false)!;
    box.computeVertexNormals();
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, count: number): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.frustumCulled = false;
      this.meshes.push(m);
      this.group.add(m);
      return m;
    };
    const housingMesh = mk(housing, this.housingMat, n);
    const boxMesh = mk(box, this.boxMat, n);
    // (the face of the head is at z −0.035, that of the box at −0.14: the lamps a few millimetres in front)
    const red = (this.red = mk(quad(0.2, 0.2, 0, 0.5).translate(0, HEAD_Y + 0.15, -0.039), this.figureMat, n));
    const green = (this.green = mk(quad(0.2, 0.2, 0.5, 1).translate(0, HEAD_Y - 0.15, -0.039), this.figureMat, n));
    const lamp = (this.lamp = mk(quad(0.1, 0.0375, 0, 1).translate(0, BOX_Y + 0.07, -0.144), this.requestMat, n));
    housingMesh.castShadow = true;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const at = new THREE.Vector3();
    poles.forEach((p, i) => {
      at.set(p.x, p.y, p.z);
      q.setFromAxisAngle(up, p.yaw);
      m4.compose(at, q, one);
      housingMesh.setMatrixAt(i, m4);
      red.setMatrixAt(i, m4);
      green.setMatrixAt(i, m4);
      red.setColorAt(i, OFF);
      green.setColorAt(i, OFF);
      q.setFromAxisAngle(up, p.boxYaw);
      m4.compose(at, q, one);
      boxMesh.setMatrixAt(i, m4);
      lamp.setMatrixAt(i, m4);
      lamp.setColorAt(i, OFF);
    });
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }

  update(signals: SignalSystem): void {
    if (!this.red || !this.green || !this.lamp) return;
    let lit = false;
    let asked = false;
    this.poles.forEach((p, i) => {
      const st = signals.pedestrian(p.controller, p.group);
      const v = st === 'green' ? 1 : st === 'red' ? 0 : 2;
      if (v !== this.shown[i]) {
        this.shown[i] = v;
        this.red!.setColorAt(i, v === 0 ? RED : OFF);
        this.green!.setColorAt(i, v === 1 ? GREEN : OFF);
        lit = true;
      }
      const a = signals.requested(p.controller) && st === 'red' ? 1 : 0;
      if (a !== this.asked[i]) {
        this.asked[i] = a;
        this.lamp!.setColorAt(i, a ? WHITE : OFF);
        asked = true;
      }
    });
    if (lit) {
      if (this.red.instanceColor) this.red.instanceColor.needsUpdate = true;
      if (this.green.instanceColor) this.green.instanceColor.needsUpdate = true;
    }
    if (asked && this.lamp.instanceColor) this.lamp.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.rebuild([]);
    this.figureTex.dispose();
    this.requestTex.dispose();
    this.figureMat.dispose();
    this.requestMat.dispose();
    this.housingMat.dispose();
    this.boxMat.dispose();
  }
}
