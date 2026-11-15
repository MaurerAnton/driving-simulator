// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Working mirrors.
 *
 * Each mirror is rendered from the driver's eye reflected in the mirror
 * plane, through an off-axis frustum whose near rectangle is the mirror glass
 * itself.  The picture therefore changes correctly when the driver moves the
 * head, and the whole render target is spent on what the glass shows.
 */
import * as THREE from 'three';

export interface MirrorSpec {
  name: string;
  /** centre of the glass in car coordinates */
  centre: THREE.Vector3;
  width: number;
  height: number;
  /** unit normal of the glass (car coordinates), pointing at the cabin side */
  normal: THREE.Vector3;
  /** > 1 widens the field of view like a convex mirror */
  convex: number;
  resolution: [number, number];
}

const _n = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _c = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _virt = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _back = new THREE.Vector3();
const _rel = new THREE.Vector3();

export class Mirror {
  readonly spec: MirrorSpec;
  readonly mesh: THREE.Mesh;
  readonly target: THREE.WebGLRenderTarget;
  readonly camera = new THREE.PerspectiveCamera();
  private readonly localRight = new THREE.Vector3();
  private readonly localUp = new THREE.Vector3();
  enabled = true;

  constructor(spec: MirrorSpec) {
    this.spec = spec;
    this.target = new THREE.WebGLRenderTarget(spec.resolution[0], spec.resolution[1], {
      depthBuffer: true,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      samples: 0,
      // linear, un-tonemapped picture; half floats avoid banding in the shadows
      type: THREE.HalfFloatType,
    });
    // glass frame: "up" is world up projected into the mirror plane
    const n = spec.normal.clone().normalize();
    this.localUp.set(0, 1, 0).addScaledVector(n, -n.y).normalize();
    // right as seen when looking AT the glass from the cabin: up × n
    this.localRight.crossVectors(this.localUp, n).normalize();
    const hw = spec.width / 2;
    const hh = spec.height / 2;
    const g = new THREE.BufferGeometry();
    const p = (sx: number, sy: number): number[] => [
      spec.centre.x + this.localRight.x * hw * sx + this.localUp.x * hh * sy,
      spec.centre.y + this.localRight.y * hw * sx + this.localUp.y * hh * sy,
      spec.centre.z + this.localRight.z * hw * sx + this.localUp.z * hh * sy,
    ];
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...p(-1, -1), ...p(1, -1), ...p(1, 1), ...p(-1, 1)]), 3));
    // The virtual camera looks at the glass from behind, where the viewer's
    // right-hand edge is on ITS left: u runs right → left for the viewer.
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, 0, 1, 1, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    // tone mapping and sRGB encoding happen here, when the glass is drawn to the screen
    const mat = new THREE.MeshBasicMaterial({ map: this.target.texture, fog: false });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = `mirror ${spec.name}`;
    this.camera.matrixAutoUpdate = false;
  }

  /** A housing behind the glass, aligned with it (car coordinates). */
  makeHousing(depth: number, material: THREE.Material, border = 0.012): THREE.Mesh {
    const s = this.spec;
    const g = new THREE.BoxGeometry(s.width + border * 2, s.height + border * 2, depth);
    const n = s.normal.clone().normalize();
    const basis = new THREE.Matrix4().makeBasis(this.localRight, this.localUp, n);
    g.applyMatrix4(basis);
    const c = s.centre.clone().addScaledVector(n, -depth / 2 - 0.002);
    g.translate(c.x, c.y, c.z);
    g.deleteAttribute('uv');
    return new THREE.Mesh(g, material);
  }

  /** Show a neutral grey instead of a stale picture when the mirror is switched off. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    const mat = this.mesh.material as THREE.MeshBasicMaterial;
    mat.map = on ? this.target.texture : null;
    mat.color.set(on ? 0xffffff : 0x1c2228);
    mat.needsUpdate = true;
  }

  /**
   * Render the mirror picture.  `carMatrix` is the car's world matrix,
   * `eyeWorld` the driver's eye in world space.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, carMatrix: THREE.Matrix4, eyeWorld: THREE.Vector3, far: number): void {
    if (!this.enabled) return;
    const s = this.spec;
    _c.copy(s.centre).applyMatrix4(carMatrix);
    _n.copy(s.normal).transformDirection(carMatrix);
    _up.copy(this.localUp).transformDirection(carMatrix);
    _right.copy(this.localRight).transformDirection(carMatrix);
    _eye.copy(eyeWorld);
    // distance of the eye in front of the glass
    const d = _tmp.subVectors(_eye, _c).dot(_n);
    if (d < 0.02) return; // eye behind the mirror
    // mirror image of the eye
    _virt.copy(_eye).addScaledVector(_n, -2 * d);
    // camera basis: looks along +n (through the glass into the reflected world);
    // its right-hand side is the viewer's left
    const camRight = _tmp.copy(_right).negate();
    _back.copy(_n).negate();
    // write the local matrix: the renderer re-derives matrixWorld from it
    this.camera.matrix.makeBasis(camRight, _up, _back).setPosition(_virt);
    this.camera.matrixWorld.copy(this.camera.matrix);
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    // off-axis frustum: the glass rectangle sits in the near plane
    _rel.subVectors(_c, _virt);
    const cx = _rel.dot(camRight);
    const cy = _rel.dot(_up);
    const hw = (s.width / 2) * s.convex;
    const hh = (s.height / 2) * s.convex;
    const near = d;
    this.camera.projectionMatrix.makePerspective(cx - hw, cx + hw, cy + hh, cy - hh, near, far);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    const prevTarget = renderer.getRenderTarget();
    const prevVisible = this.mesh.visible;
    this.mesh.visible = false;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    this.mesh.visible = prevVisible;
  }

  dispose(): void {
    this.target.dispose();
    this.mesh.geometry.dispose();
  }
}

/** Glass normal that shows the driver the direction `look` (car coordinates). */
export function mirrorNormal(centre: THREE.Vector3, eye: THREE.Vector3, look: THREE.Vector3): THREE.Vector3 {
  const toEye = eye.clone().sub(centre).normalize();
  return toEye.add(look.clone().normalize()).normalize();
}
