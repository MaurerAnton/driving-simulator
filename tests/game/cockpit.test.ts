// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The cockpit: the map on the vehicle's screen became the default (stored
 * settings of before are moved over once), the finer vehicles belong to the
 * "very high" graphics, and the mirror key goes round the mirrors a vehicle
 * has (game/cockpit.ts).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MIRROR_ORDER, MirrorLook, mirrorAt, zoomAspect, zoomPanel } from '../../src/game/cockpit.ts';
import { DEFAULT_SETTINGS, GRAPHICS_PRESETS, SETTINGS_VERSION, loadSettings, saveSettings } from '../../src/game/settings.ts';
import * as THREE from 'three';
import { Mirror, mirrorNormal } from '../../src/render/mirrors.ts';

/** A browser's storage, as far as the settings use it. */
function storage(entries: Record<string, string> = {}): Map<string, string> {
  const m = new Map(Object.entries(entries));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) },
  });
  return m;
}
const KEY = 'fahrsim-baunatal.settings.v2';
const OLD_KEY = 'fahrsim-baunatal.settings.v1';

test('the map is on the vehicle’s screen by default, and settings are written with their version', () => {
  storage();
  const s = loadSettings();
  assert.equal(s.mapOnScreen, true);
  assert.equal(s.version, SETTINGS_VERSION);
  assert.equal(DEFAULT_SETTINGS.mapOnScreen, true);
  const m = storage();
  saveSettings(s);
  assert.equal(JSON.parse(m.get(KEY)!).version, SETTINGS_VERSION);
});

test('settings stored before 1.4.0: the old default (map in the corner) is moved over to the new one, once', () => {
  // as 1.3.0 stored them: every setting, the map's then default among them, no version
  storage({ [KEY]: JSON.stringify({ lang: 'de', mapOnScreen: false, quality: 'high', volume: 0.4 }) });
  const s = loadSettings();
  assert.equal(s.mapOnScreen, true);
  assert.equal(s.version, SETTINGS_VERSION);
  // (what else was chosen stays)
  assert.equal(s.volume, 0.4);
  assert.equal(s.lang, 'de');
  // … the player switches it off again: that choice is kept from now on
  s.mapOnScreen = false;
  const m = storage();
  saveSettings(s);
  storage({ [KEY]: m.get(KEY)! });
  assert.equal(loadSettings().mapOnScreen, false);
  // and the settings of the versions before the playtest move over the same way
  storage({ [OLD_KEY]: JSON.stringify({ mapOnScreen: false }) });
  assert.equal(loadSettings().mapOnScreen, true);
});

test('a stored version of the future or nonsense does not break the migration', () => {
  storage({ [KEY]: JSON.stringify({ version: 3, mapOnScreen: false }) });
  assert.equal(loadSettings().mapOnScreen, false);
  storage({ [KEY]: JSON.stringify({ version: 'x', mapOnScreen: false }) });
  assert.equal(loadSettings().mapOnScreen, true);
  storage({ [KEY]: JSON.stringify({ version: 2, mapOnScreen: 'yes' }) });
  assert.equal(loadSettings().mapOnScreen, true);
});

test('the finer vehicles belong to the "very high" preset only, also for settings stored before they existed', () => {
  for (const q of ['low', 'medium', 'high'] as const) assert.equal(GRAPHICS_PRESETS[q].vehicleDetail, false, q);
  assert.equal(GRAPHICS_PRESETS.ultra.vehicleDetail, true);
  const g = (quality: string, graphics?: object): boolean => {
    storage({ [KEY]: JSON.stringify({ version: 2, quality, ...(graphics ? { graphics } : {}) }) });
    return loadSettings().graphics.vehicleDetail;
  };
  // stored graphics of before: as the preset of then would have them
  assert.equal(g('ultra', { shadows: 'far', viewDistance: 3000, propDensity: 1, facades: true, propShadows: true, farView: 20000 }), true);
  assert.equal(g('high', { shadows: 'far', viewDistance: 2000, propDensity: 1, facades: true, propShadows: true, farView: 12000 }), false);
  assert.equal(g('custom', { shadows: 'far', viewDistance: 2000, propDensity: 1, facades: true, propShadows: true, farView: 12000 }), false);
  assert.equal(g('ultra'), true);
  // chosen in the advanced settings: kept, whatever the preset was
  assert.equal(g('custom', { ...GRAPHICS_PRESETS.medium, vehicleDetail: true }), true);
  assert.equal(g('custom', { ...GRAPHICS_PRESETS.ultra, vehicleDetail: false }), false);
});

test('the mirror key goes round the mirrors a vehicle has: left, right, inside, off', () => {
  assert.deepEqual(MIRROR_ORDER, ['left', 'right', 'inside']);
  const car = ['inside', 'left', 'right'];
  const look = new MirrorLook();
  assert.equal(look.shown, null);
  assert.deepEqual([look.next(car), look.next(car), look.next(car), look.next(car), look.next(car)], ['left', 'right', 'inside', null, 'left']);
  // a truck, a bus, a tractor: no inside mirror
  const truck = ['left', 'right'];
  look.close();
  assert.deepEqual([look.next(truck), look.next(truck), look.next(truck)], ['left', 'right', null]);
  // the tram's cab, an aeroplane: nothing to look into
  assert.equal(look.next([]), null);
  assert.equal(look.next([]), null);
});

test('a tap on a mirror shows it, a second tap puts it away; a mirror the vehicle lacks is shown no more', () => {
  const car = ['inside', 'left', 'right'];
  const look = new MirrorLook();
  assert.equal(look.pick('right', car), 'right');
  assert.equal(look.pick('left', car), 'left');
  assert.equal(look.pick('left', car), null);
  assert.equal(look.pick('inside', ['left', 'right']), null);
  // from the inside mirror the key goes on to "off"
  look.pick('inside', car);
  assert.equal(look.next(car), null);
  // the car's inside mirror shown, then the truck is driven: none
  look.pick('inside', car);
  assert.equal(look.keep(['left', 'right']), null);
  look.pick('left', car);
  assert.equal(look.keep(['left', 'right']), 'left');
});

test('which mirror a tap means: its glass, or close enough to it on a small screen', () => {
  const boxes = [
    { name: 'left', x0: 40, y0: 300, x1: 120, y1: 350, distance: 0.9 },
    { name: 'inside', x0: 600, y0: 40, x1: 760, y1: 80, distance: 0.5 },
    { name: 'right', x0: 1500, y0: 320, x1: 1540, y1: 345, distance: 1.6 },
  ];
  assert.equal(mirrorAt(80, 320, boxes), 'left');
  assert.equal(mirrorAt(680, 60, boxes), 'inside');
  // a finger beside the small glass of the right mirror
  assert.equal(mirrorAt(1555, 333, boxes), 'right');
  assert.equal(mirrorAt(1600, 333, boxes), null);
  assert.equal(mirrorAt(900, 500, boxes), null);
  // two near each other: the one the tap is inside, then the nearer one
  const two = [
    { name: 'a', x0: 0, y0: 0, x1: 100, y1: 100, distance: 2 },
    { name: 'b', x0: 90, y0: 0, x1: 200, y1: 100, distance: 1 },
  ];
  assert.equal(mirrorAt(50, 50, two), 'a');
  assert.equal(mirrorAt(95, 50, two), 'b');
  assert.equal(mirrorAt(105, 50, two), 'b');
});

test('the panel a mirror is shown in fits the upper half of the screen, centred', () => {
  // a car's door mirror (17 × 10.5 cm), its inside mirror (15 × 4.2), a truck's tall one (22 × 40)
  assert.ok(Math.abs(zoomAspect(0.17, 0.105) - 0.17 / 0.105) < 1e-9);
  assert.equal(zoomAspect(0.15, 0.042), 2.6);
  assert.equal(zoomAspect(0.22, 0.4), 1.4);
  for (const [w, h, top] of [
    [1920, 1080, 10],
    [844, 390, 52],
    [390, 844, 52],
    [1280, 720, 10],
  ]) {
    for (const aspect of [1.4, 1.62, 2.6]) {
      const r = zoomPanel(w, h, aspect, top);
      assert.ok(r.y === top, `top ${w}×${h}`);
      assert.ok(r.y + r.h <= h * 0.5 + top + 1, `height ${w}×${h} ${aspect}: ${r.h}`);
      assert.ok(r.w <= w * 0.94 + 1, `width ${w}×${h} ${aspect}: ${r.w}`);
      assert.ok(Math.abs(r.x + r.w / 2 - w / 2) <= 1, 'centred');
      assert.ok(Math.abs(r.w / r.h - aspect) < 0.02, 'its shape');
    }
  }
  // as large as the screen allows: on a desktop down to the middle of it
  assert.equal(zoomPanel(1920, 1080, 1.62, 10).h, 538);
});

test('looking into a mirror: what the glass shows, in the shape of the panel – at least so much of it', () => {
  // the car's door mirrors and the driver's eye (render/car.ts): a metre and more from the eye, they show only a few degrees
  const eye = new THREE.Vector3(-0.36, 1.2, 0.2);
  const door = (side: number, convex: number): Mirror => {
    const centre = new THREE.Vector3(side * 0.995, 1.0163, -0.675);
    return new Mirror({ name: side < 0 ? 'left' : 'right', centre, width: 0.17, height: 0.105, normal: mirrorNormal(centre, eye, new THREE.Vector3(side * 0.16, -0.06, 1)), convex, resolution: [16, 16] });
  };
  const car = new THREE.Matrix4();
  // (the frustum's tangents across and up, from the projection: 2 / m00, 2 / m11 – width and height at a distance of 1)
  const tans = (m: Mirror): [number, number] => {
    const e = m.camera.projectionMatrix.elements;
    return [2 / e[0], 2 / e[5]];
  };
  const minTan = Math.tan((7 * Math.PI) / 180);
  for (const m of [door(-1, 1.25), door(1, 1.6)]) {
    assert.equal(m.aim(car, eye, 300), true);
    const [w0, h0] = tans(m);
    assert.ok(Math.abs(w0 / h0 - 0.17 / 0.105) < 1e-6, 'the glass itself');
    assert.ok(h0 / 2 < minTan, `${m.spec.name}: a narrow view of its own (${((Math.atan(h0 / 2) * 360) / Math.PI).toFixed(1)}°)`);
    assert.equal(m.aim(car, eye, 300, 1, 2, minTan), true);
    const [w1, h1] = tans(m);
    assert.ok(Math.abs(w1 / h1 - 2) < 1e-6, 'the shape of the panel');
    assert.ok(Math.abs(h1 / 2 - minTan) < 1e-9, 'widened to the least angle');
    // a car moved and turned: the same view, in its new place
    const moved = new THREE.Matrix4().makeRotationY(0.7).setPosition(30, 2, -40);
    assert.equal(m.aim(moved, eye.clone().applyMatrix4(moved), 300, 1, 2, minTan), true);
    const [w2, h2] = tans(m);
    assert.ok(Math.abs(w2 - w1) < 1e-9 && Math.abs(h2 - h1) < 1e-9);
  }
  // a wide view of its own is not narrowed: the least angle only widens
  const wide = door(-1, 6);
  wide.aim(car, eye, 300);
  const [, hw] = tans(wide);
  wide.aim(car, eye, 300, 1, 0, minTan);
  assert.ok(Math.abs(tans(wide)[1] - hw) < 1e-9);
  // an eye behind the glass sees nothing in it
  assert.equal(door(-1, 1.25).aim(car, new THREE.Vector3(-1.2, 1.0, -1.2), 300), false);
});
