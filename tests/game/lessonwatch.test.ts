// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Watching a lesson (game/lessonwatch.ts) and the lesson's start panel's map
 * of the districts (ui/lessonstart.ts): which lessons can be watched, how
 * the autopilot's commands reach the pedals, that the player's hands take
 * the car over, and that a tap on the map picks the district under it.
 *
 *   node --test tests/game/lessonwatch.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { areaChoices } from '../../src/game/lessonplaces.ts';
import { LessonWatch, canWatch } from '../../src/game/lessonwatch.ts';
import type { WatchControls } from '../../src/game/lessonwatch.ts';
import { LESSONS } from '../../src/game/nav.ts';
import { DEFAULT_SETTINGS } from '../../src/game/settings.ts';
import type { AutoCommand, AutoDriver } from '../../src/sim/autodriver.ts';
import type { DriverInput, Vehicle } from '../../src/sim/vehicle/index.ts';
import { districtAt, districtFrame } from '../../src/ui/lessonstart.ts';
import type { SpawnJson } from '../../src/world/types.ts';

test('the lessons on the road can be watched – not those about the player’s own hands', () => {
  const watchable = LESSONS.filter((l) => canWatch(l)).map((l) => l.id);
  for (const id of ['rbl', 'priority', 'signals', 'roundabout', 'rural', 'motorway', 'exam']) assert.ok(watchable.includes(id), id);
  for (const id of ['basics', 'ceCouple', 'ceCorner', 'ceRamp', 'tramLine', 'busLine', 'ceExam']) assert.ok(!watchable.includes(id), id);
  assert.equal(canWatch(null), false);
  assert.equal(DEFAULT_SETTINGS.lessonWatch, false, 'driven unless chosen');
});

/** a driver that always says the same */
function fakeDriver(cmd: Partial<AutoCommand>): AutoDriver & { resets: number } {
  const full: AutoCommand = { steer: 0.2, throttle: 0.6, brake: 0, indicator: 1, look: 0.3, remark: 'turn', waiting: false, arrived: false, turnRound: null, ...cmd };
  const d = { resets: 0, step: () => full, reset() {
    d.resets++;
  } };
  return d as unknown as AutoDriver & { resets: number };
}

const controls = (): WatchControls => ({ steer: 0, throttle: 0, brake: 0, handbrake: 1, gear: 0, indicator: 0, ignition: false, seatbelt: false, hazard: true });
const inputs = (): DriverInput => ({ steer: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 1, gear: 0, ignition: false, starter: false });
const vehicle = { engineRunning: false } as unknown as Vehicle;

test('the autopilot drives: its commands on the pedals, the parking brake off, belt and engine on', () => {
  const drv = fakeDriver({});
  const w = new LessonWatch(drv);
  const c = controls();
  const d = inputs();
  // (placed with the parking brake on: that is no hand on the controls)
  assert.equal(w.control(1 / 60, vehicle, [0, 0, 0], [], true, c, d), 'driving');
  assert.equal(drv.resets, 1);
  assert.equal(c.handbrake, 0);
  assert.equal(c.seatbelt, true);
  assert.equal(c.ignition, true);
  assert.equal(c.hazard, false);
  assert.equal(c.indicator, 1);
  assert.equal(d.throttle, 0.6);
  assert.equal(d.steer, 0.2);
  assert.equal(d.handbrake, 0);
  assert.equal(d.gear, 1);
  assert.equal(d.starter, true, 'it starts the engine');
  assert.equal(w.look, 0.3);
  assert.equal(w.text((k) => k), 'demo.turn', 'the instructor says why');
  // until the lesson's way is known it stands
  const d2 = inputs();
  w.control(1 / 60, vehicle, [0, 0, 0], [], false, c, d2);
  assert.equal(d2.throttle, 0);
  assert.equal(d2.brake, 0.5);
  const quiet = new LessonWatch(fakeDriver({ remark: '' }));
  quiet.control(1 / 60, vehicle, [0, 0, 0], [], true, controls(), inputs());
  assert.equal(quiet.text((k) => k), 'lessonWatch.running');
});

test('the player takes over by steering, braking or accelerating – not by a touch', () => {
  const w = new LessonWatch(fakeDriver({}));
  const c = controls();
  w.control(1 / 60, vehicle, [0, 0, 0], [], true, c, inputs());
  c.steer = 0.2;
  for (let i = 0; i < 30; i++) assert.equal(w.control(1 / 60, vehicle, [0, 0, 0], [], true, c, inputs()), 'driving', 'a wheel not quite centred');
  c.brake = 0.5;
  assert.equal(w.control(0.1, vehicle, [0, 0, 0], [], true, c, inputs()), 'driving', 'a moment');
  assert.equal(w.control(0.1, vehicle, [0, 0, 0], [], true, c, inputs()), 'taken');
});

test('the map of the districts: every district on the picture, a tap picks the one under it', () => {
  const spawns: SpawnJson[] = [
    { name: 'Altenbauna – Parkplatz', x: 0, z: 0, yaw: 0, kind: 'street' },
    { name: 'Großenritte – Parkplatz', x: -3000, z: 1500, yaw: 0, kind: 'street' },
    { name: 'Kassel Mitte – Parkplatz', x: 2000, z: -9000, yaw: 0, kind: 'street' },
    { name: 'Rengershausen – Parkplatz', x: 1200, z: -2500, yaw: 0, kind: 'street' },
  ];
  const areas = areaChoices(spawns);
  assert.equal(areas.length, 4);
  const W = 640;
  const H = 400;
  const f = districtFrame(areas, W, H);
  for (const a of areas) {
    const [x, y] = f.toPx(a.x, a.z);
    assert.ok(x >= 0 && x <= W && y >= 0 && y <= H, `${a.name} on the picture`);
  }
  // north is up, east is right
  const [kx, ky] = f.toPx(2000, -9000);
  const [gx, gy] = f.toPx(-3000, 1500);
  assert.ok(ky < gy && kx > gx);
  for (let i = 0; i < areas.length; i++) {
    const [x, y] = f.toPx(areas[i].x, areas[i].z);
    assert.equal(districtAt(areas, f, x + 5, y - 5), i, areas[i].name);
  }
  assert.equal(districtAt(areas, f, -500, -500), -1, 'nothing there');
  // one district only, or none: still a frame
  const one = districtFrame(areas.slice(0, 1), W, H);
  assert.deepEqual(one.toPx(areas[0].x, areas[0].z), [W / 2, H / 2]);
  assert.ok(Number.isFinite(districtFrame([], W, H).toPx(0, 0)[0]));
});
