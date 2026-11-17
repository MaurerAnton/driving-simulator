// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The screen in the cockpit of the truck, the bus, the tractor and on the
 * tram's desk: in the driver's seat it shows the live map – the one of the
 * HUD's corner, which is hidden meanwhile (ui/hud.ts `screen`) – and
 * otherwise a still picture of a map.  (The car's centre display is built
 * with its dashboard, render/car.ts.)
 *
 * A dark bezel with the lit picture in it, on a short arm to whatever it is
 * fixed to, and turned so that the driver looks at it square on.  It stays
 * solid when the cab is drawn see-through, like the instruments.
 */
import * as THREE from 'three';

/** A vehicle's screen as the game hands it to the HUD: what to draw the map on, and the switch between the map and the still picture. */
export interface VehicleScreen {
  readonly canvas: HTMLCanvasElement;
  /** told after each picture the HUD drew into the canvas */
  drawn(): void;
  /** the live map (true) or the still picture */
  setLive(on: boolean): void;
}

/** the picture's pixels: the size of the car's centre display (the HUD draws its map to fit any) */
const W = 512;
const H = 288;

const BEZEL = new THREE.MeshLambertMaterial({ color: 0x16181b });
let stillPicture: THREE.CanvasTexture | null = null;

/** The still picture: streets, a route and the arrow of the vehicle, and a column of tiles – drawn once for all screens. */
function still(): THREE.CanvasTexture {
  if (stillPicture) return stillPicture;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d')!;
  x.fillStyle = '#121d29';
  x.fillRect(0, 0, W, H);
  x.lineCap = 'round';
  x.lineJoin = 'round';
  const line = (pts: number[][], colour: string, width: number): void => {
    x.strokeStyle = colour;
    x.lineWidth = width;
    x.beginPath();
    pts.forEach(([px, py], i) => (i === 0 ? x.moveTo(px, py) : x.lineTo(px, py)));
    x.stroke();
  };
  for (const s of [
    [[-10, 70], [180, 58], [380, 34]],
    [[-10, 200], [200, 180], [380, 160]],
    [[70, -10], [92, 130], [104, 300]],
    [[262, -10], [270, 150], [282, 300]],
  ]) line(s, '#2c3d50', 16);
  line([[100, 300], [96, 190], [200, 180], [268, 172], [266, 40], [262, -10]], '#3d8bff', 8);
  x.fillStyle = '#eef2f5';
  x.beginPath();
  x.moveTo(98, 210);
  x.lineTo(113, 246);
  x.lineTo(98, 238);
  x.lineTo(83, 246);
  x.closePath();
  x.fill();
  x.fillStyle = '#0e1822';
  x.fillRect(380, 0, W - 380, H);
  ['#3d8bff', '#35c06a', '#ffb020'].forEach((colour, i) => {
    x.fillStyle = '#1a2836';
    x.fillRect(404, 26 + i * 80, 84, 62);
    x.fillStyle = colour;
    x.beginPath();
    x.arc(446, 57 + i * 80, 14, 0, Math.PI * 2);
    x.fill();
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return (stillPicture = t);
}

export class NavScreen implements VehicleScreen {
  readonly canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  readonly group = new THREE.Group();
  private readonly texture = new THREE.CanvasTexture(this.canvas);
  private readonly face: THREE.Mesh;

  /** `width`: of the picture (m); the height follows from its 16 : 9. */
  constructor(width: number) {
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const h = (width * H) / W;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(width + 0.024, h + 0.024, 0.022), BEZEL);
    frame.position.z = -0.012;
    // a self-lit picture, as bright by night as by day
    this.face = new THREE.Mesh(new THREE.PlaneGeometry(width, h), new THREE.MeshBasicMaterial({ map: still(), toneMapped: false }));
    this.face.name = 'screen';
    this.face.position.z = 0.0012;
    this.group.add(frame, this.face);
    this.group.name = 'nav screen';
  }

  /**
   * Fix it in `parent` with its middle at `at`, turned to face `eye` (both in
   * the parent's coordinates), on an arm back to `mount` (the dashboard, a
   * post of the cab).
   */
  place(parent: THREE.Object3D, at: THREE.Vector3, eye: THREE.Vector3, mount?: THREE.Vector3): this {
    const d = eye.clone().sub(at);
    this.group.position.copy(at);
    // (a plane looks along +z: turned about y towards the eye, then tilted up or down to it)
    this.group.rotation.set(-Math.asin(Math.max(-1, Math.min(1, d.y / d.length()))), Math.atan2(d.x, d.z), 0, 'YXZ');
    parent.add(this.group);
    if (mount) {
      // the arm: from behind the middle of the screen to the mount
      const from = at.clone().addScaledVector(d.normalize(), -0.03);
      const along = mount.clone().sub(from);
      const len = along.length();
      if (len > 0.01) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, len), BEZEL);
        arm.position.copy(from).add(mount).multiplyScalar(0.5);
        arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), along.divideScalar(len));
        parent.add(arm);
      }
    }
    return this;
  }

  setLive(on: boolean): void {
    const m = this.face.material as THREE.MeshBasicMaterial;
    const want = on ? this.texture : still();
    if (m.map !== want) {
      m.map = want;
      m.needsUpdate = true;
    }
  }

  drawn(): void {
    this.texture.needsUpdate = true;
  }
}
