// SPDX-License-Identifier: AGPL-3.0-only
/** Sky dome, sun and ambient light.  Colours are derived from the sun height. */
import * as THREE from 'three';

export class Sky {
  readonly dome: THREE.Mesh;
  readonly sun = new THREE.DirectionalLight(0xfff4e0, 3.0);
  readonly hemi = new THREE.HemisphereLight(0xbfd6ff, 0x6b6a55, 1.1);
  readonly fog = new THREE.Fog(0xc4d4e4, 300, 2400);
  private readonly lightRight = new THREE.Vector3();
  private readonly lightUp = new THREE.Vector3();
  private readonly uniforms = {
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
    uZenith: { value: new THREE.Color(0x3f78c8) },
    uHorizon: { value: new THREE.Color(0xc4d4e4) },
    uSunColor: { value: new THREE.Color(0xfff2d0) },
  };

  constructor() {
    const geo = new THREE.SphereGeometry(1, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = modelViewMatrix * vec4(position, 0.0);
          gl_Position = projectionMatrix * vec4(p.xyz, 1.0);
          gl_Position.z = gl_Position.w; // at the far plane
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uSunColor;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -0.2, 1.0);
          float t = pow(1.0 - max(h, 0.0), 3.2);
          vec3 col = mix(uZenith, uHorizon, t);
          // below the horizon: fade to the fog colour so distant terrain blends in
          col = mix(col, uHorizon, smoothstep(0.0, -0.08, d.y));
          float s = max(dot(d, uSunDir), 0.0);
          col += uSunColor * (pow(s, 900.0) * 6.0 + pow(s, 24.0) * 0.22 + pow(s, 4.0) * 0.06);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.dome.name = 'sky';
    this.setSun(52, 215);
  }

  /** Sun elevation above the horizon and compass azimuth (degrees, 180 = south). */
  setSun(elevationDeg: number, azimuthDeg: number): void {
    const el = (elevationDeg * Math.PI) / 180;
    const az = (azimuthDeg * Math.PI) / 180;
    // compass azimuth: 0 = north (-Z), 90 = east (+X)
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    this.uniforms.uSunDir.value.copy(dir);
    this.sun.position.copy(dir).multiplyScalar(400);
    const day = THREE.MathUtils.smoothstep(elevationDeg, -4, 18);
    const warm = 1 - THREE.MathUtils.smoothstep(elevationDeg, 2, 30);
    this.sun.color.setRGB(1, 0.96 - 0.3 * warm, 0.88 - 0.5 * warm);
    this.sun.intensity = 3.2 * day;
    this.hemi.intensity = 0.25 + 0.95 * day;
    const zenith = new THREE.Color(0x0a1020).lerp(new THREE.Color(0x3a74c6), day);
    const horizon = new THREE.Color(0x1a2030).lerp(new THREE.Color(0xc2d3e4), day);
    horizon.lerp(new THREE.Color(0xf0b890), warm * day * 0.45);
    this.uniforms.uZenith.value.copy(zenith);
    this.uniforms.uHorizon.value.copy(horizon);
    this.fog.color.copy(horizon);
  }

  /** Keep the dome centred on the camera and the shadow frustum around the focus point. */
  follow(camera: THREE.Camera, focus: THREE.Vector3): void {
    this.dome.position.copy(camera.position);
    this.dome.scale.setScalar(1);
    const dir = this.uniforms.uSunDir.value;
    let fx = focus.x;
    let fy = focus.y;
    let fz = focus.z;
    if (this.sun.castShadow) {
      // The shadow box moves with the car.  Moved in whole texels of the shadow map (along the
      // light's own axes) the edges of the shadows stay still instead of crawling.
      const cam = this.sun.shadow.camera;
      const texel = (cam.right - cam.left) / this.sun.shadow.mapSize.x;
      const r = this.lightRight.set(dir.z, 0, -dir.x).normalize(); // up × dir
      const u = this.lightUp.crossVectors(dir, r);
      const a = Math.round((fx * r.x + fz * r.z) / texel) * texel;
      const b = Math.round((fx * u.x + fy * u.y + fz * u.z) / texel) * texel;
      const c = fx * dir.x + fy * dir.y + fz * dir.z;
      fx = r.x * a + u.x * b + dir.x * c;
      fy = u.y * b + dir.y * c;
      fz = r.z * a + u.z * b + dir.z * c;
    }
    this.sun.position.set(fx + dir.x * 300, fy + dir.y * 300, fz + dir.z * 300);
    this.sun.target.position.set(fx, fy, fz);
    this.sun.target.updateMatrixWorld();
  }
}
