// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Preview of one model (or a small group of them) without the map: the
 * scene module tools/dev/scenes/<name>.ts builds it, this page lights it as
 * the game does and draws it from several sides into one picture.
 *
 *   npx vite --port 5181            (any free port)
 *   node tools/dev/modelshot.mjs <scene> out.png [views] [width] [height]
 *
 * Query: ?scene=<name>&views=<list>&t=<seconds of animation>, where a view is
 *   yaw:pitch:distance   (degrees around the model – 0 = from the front, 90 = from
 *                         its right side –, degrees above the horizon, multiples of
 *                         the scene's radius), or
 *   eye                  (the scene's own eye point and direction: the driver's seat)
 * e.g. views=30:15:1.6,90:0:1.6,180:20:1.6,eye – the default.
 * Further parameters are handed to the scene (params).
 */
import * as THREE from 'three';

export interface SceneContext {
  THREE: typeof THREE;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  params: URLSearchParams;
}

export interface PreviewScene {
  /** what the cameras look at, and how big the thing is (m) */
  target: THREE.Vector3;
  radius: number;
  /** the driver's eye and the point it looks at (the view "eye") */
  eye?: THREE.Vector3;
  look?: THREE.Vector3;
  /** move things to time t (s) before the picture is taken */
  update?(t: number): void;
}

declare global {
  interface Window {
    __ready?: boolean;
    __error?: string;
  }
}

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const name = q.get('scene') ?? 'plane';
  const views = (q.get('views') ?? '30:15:1.6,90:0:1.6,180:20:1.6,eye').split(',');
  const w = innerWidth;
  const h = innerHeight;

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(w, h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.autoClear = false;
  document.body.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9db4c8);
  // the game's daylight (render/sky.ts)
  const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x6b6a55, 1.2);
  const sun = new THREE.DirectionalLight(0xfff4e0, 3.2);
  sun.position.set(-30, 45, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -20;
  sc.right = 20;
  sc.top = 20;
  sc.bottom = -20;
  sc.near = 1;
  sc.far = 150;
  scene.add(hemi, sun, sun.target);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshLambertMaterial({ color: 0x7d8a69 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  // a strip of asphalt, a metre grid on it: to judge sizes
  const road = new THREE.Mesh(new THREE.PlaneGeometry(8, 400), new THREE.MeshLambertMaterial({ color: 0x55575b }));
  road.rotation.x = -Math.PI / 2;
  road.position.y = 0.005;
  road.receiveShadow = true;
  scene.add(road);
  const grid = new THREE.GridHelper(40, 40, 0x333333, 0x666666);
  grid.position.y = 0.01;
  scene.add(grid);

  const mod = (await import(`./scenes/${name}.ts`)) as { build(ctx: SceneContext): PreviewScene | Promise<PreviewScene> };
  const s = await mod.build({ THREE, scene, renderer, params: q });
  s.update?.(Number(q.get('t') ?? 0));

  // the views side by side in a grid
  const cols = Math.ceil(Math.sqrt(views.length));
  const rows = Math.ceil(views.length / cols);
  const vw = Math.floor(w / cols);
  const vh = Math.floor(h / rows);
  renderer.setScissorTest(true);
  renderer.clear();
  views.forEach((v, i) => {
    const cam = new THREE.PerspectiveCamera(v === 'eye' ? 70 : 40, vw / vh, 0.05, 2000);
    if (v === 'eye' && s.eye) {
      cam.position.copy(s.eye);
      cam.lookAt(s.look ?? s.target);
    } else {
      const [yaw = 30, pitch = 15, dist = 1.6] = v.split(':').map(Number);
      const r = s.radius * dist * 2.2;
      const a = (yaw * Math.PI) / 180;
      const p = (pitch * Math.PI) / 180;
      // yaw 0: in front of the model (models look towards -z), 90: on its right (+x)
      cam.position.set(s.target.x + Math.sin(a) * Math.cos(p) * r, s.target.y + Math.sin(p) * r, s.target.z - Math.cos(a) * Math.cos(p) * r);
      cam.lookAt(s.target);
    }
    const x = (i % cols) * vw;
    const y = h - (Math.floor(i / cols) + 1) * vh;
    renderer.setViewport(x, y, vw, vh);
    renderer.setScissor(x, y, vw, vh);
    renderer.render(scene, cam);
  });
  window.__ready = true;
}

main().catch((e: unknown) => {
  window.__error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  window.__ready = true;
});
