// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The main menu as a stage (src/ui/stage.ts): the order the vehicles come in
 * when swiped, the kinds of vehicle, the trailer that goes with a vehicle,
 * what can be done with each, where a drive begins, how the camera frames
 * the vehicle – and that the stage is the menu of new players while a menu
 * stored before stays.
 *
 *   node --test tests/ui/stage.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Settings } from '../../src/game/settings.ts';
import { VEHICLES, VEHICLE_KINDS } from '../../src/game/vehicles.ts';
import type { VehicleKind } from '../../src/game/vehicles.ts';
import type { RunwayChoice, TramStopChoice } from '../../src/ui/hud.ts';
import { cycleGroup, cycleVehicle, frameOf, groupOf, pickMode, shortName, stageFrame, stageGroups, stageModes, stagePlace, startFromSpot, trailerPartner } from '../../src/ui/stage.ts';
import type { SpawnJson } from '../../src/world/types.ts';

// (a stand-in for the browser's storage, for the settings)
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});

const groups = stageGroups();

test('the kinds of vehicle: every vehicle in one of them, in the order of the licence classes', () => {
  const all = groups.flatMap((g) => g.kinds);
  assert.deepEqual([...all].sort(), [...VEHICLE_KINDS].sort(), 'every vehicle once');
  assert.equal(new Set(all).size, all.length);
  const ids = groups.map((g) => g.id);
  for (const id of ['car', 'moto', 'truck', 'bus', 'tractor', 'tram', 'plane', 'foot']) assert.ok(ids.includes(id), id);
  assert.deepEqual(ids.slice(0, 5), ['car', 'moto', 'truck', 'bus', 'tractor']);
  assert.deepEqual(groups.find((g) => g.id === 'moto')?.kinds, ['moped', 'motorcycle125', 'motorcycle35', 'motorcycle']);
  assert.deepEqual(groups.find((g) => g.id === 'truck')?.kinds, ['lightTruck', 'lightTruckTrailer', 'truckSolo', 'truck']);
  assert.deepEqual(groups.find((g) => g.id === 'bus')?.kinds, ['minibus', 'minibusTrailer', 'bus', 'busTrailer']);
  // a vehicle of a model the menu does not know is a kind of its own; a crane is known by its name
  assert.equal(groupOf({ kind: 'mobileCrane' as VehicleKind, model: 'crane' as never }), 'crane');
  assert.equal(groupOf({ kind: 'crane' as VehicleKind, model: 'truck' }), 'truck', 'a crane on a truck chassis drawn as a truck is a truck');
  assert.equal(groupOf({ kind: 'digger' as VehicleKind, model: 'excavator' as never }), 'excavator');
  const more = stageGroups(['car', 'digger' as VehicleKind, 'carTrailer'], { ...VEHICLES, digger: { kind: 'digger' as VehicleKind, model: 'excavator' as never, licence: 'L', trailer: null } });
  assert.deepEqual(more.map((g) => [g.id, g.kinds]), [['car', ['car', 'carTrailer']], ['excavator', ['digger']]]);
});

test('swiping goes through every vehicle kind by kind, and round again', () => {
  const order = groups.flatMap((g) => g.kinds);
  assert.equal(cycleVehicle(groups, 'car', 1), 'carTrailer');
  assert.equal(cycleVehicle(groups, 'carTrailer', 1), 'moped');
  assert.equal(cycleVehicle(groups, 'car', -1), order[order.length - 1], 'from the first back to the last');
  assert.equal(cycleVehicle(groups, order[order.length - 1], 1), 'car', 'from the last on to the first');
  const seen = new Set<VehicleKind>();
  let k: VehicleKind = 'car';
  for (let i = 0; i < order.length; i++) {
    seen.add(k);
    k = cycleVehicle(groups, k, 1);
  }
  assert.equal(k, 'car');
  assert.equal(seen.size, order.length, 'each vehicle once on the way round');
  assert.equal(cycleVehicle([], 'bus', 1), 'bus');
});

test('the kinds: the next kind brings the vehicle last chosen of it, else its first', () => {
  assert.equal(cycleGroup(groups, 'car', 1), 'moped');
  assert.equal(cycleGroup(groups, 'carTrailer', 1), 'moped');
  assert.equal(cycleGroup(groups, 'car', 1, new Map([['moto', 'motorcycle35' as VehicleKind]])), 'motorcycle35');
  assert.equal(cycleGroup(groups, 'moped', -1, new Map([['car', 'carTrailer' as VehicleKind]])), 'carTrailer');
  const lastGroup = groups[groups.length - 1];
  assert.equal(cycleGroup(groups, 'car', -1), lastGroup.kinds[0], 'before the first kind: the last');
  // (a remembered vehicle that is not of that kind does not count)
  assert.equal(cycleGroup(groups, 'car', 1, new Map([['moto', 'bus' as VehicleKind]])), 'moped');
});

test('the trailer that goes with a vehicle: its licence class with an E', () => {
  const pairs: Array<[VehicleKind, VehicleKind]> = [['car', 'carTrailer'], ['lightTruck', 'lightTruckTrailer'], ['truckSolo', 'truck'], ['minibus', 'minibusTrailer'], ['bus', 'busTrailer']];
  for (const [solo, pair] of pairs) {
    assert.equal(trailerPartner(solo), pair, solo);
    assert.equal(trailerPartner(pair), solo, pair);
  }
  for (const k of ['motorcycle', 'moped', 'tractor', 'tractorSlow', 'tram', 'plane', 'pedestrian'] as VehicleKind[]) assert.equal(trailerPartner(k), null, k);
});

test('the name beside the badge leaves out the licence class in brackets – in every script', () => {
  assert.equal(shortName('Car (class B)', 'B'), 'Car');
  assert.equal(shortName('Car with trailer (class BE)', 'BE'), 'Car with trailer');
  assert.equal(shortName('Light motorcycle, 125 cm³ (class A1)', 'A1'), 'Light motorcycle, 125 cm³');
  assert.equal(shortName('Pkw (Klasse B)', 'B'), 'Pkw');
  assert.equal(shortName('Light aeroplane (PPL)', 'PPL'), 'Light aeroplane');
  assert.equal(shortName('小汽车（B 类）', 'B'), '小汽车');
  assert.equal(shortName('乗用車（Bクラス）', 'B'), '乗用車');
  assert.equal(shortName('سيارة (الفئة B)', 'B'), 'سيارة');
  assert.equal(shortName('Truck 7.5 t (class C1)', 'C1'), 'Truck 7.5 t');
  // brackets that say something else, a class that is only part of a word, no class at all: as it is
  assert.equal(shortName('Tram (Kassel)', 'BOStrab'), 'Tram (Kassel)');
  assert.equal(shortName('Car (class BE)', 'B'), 'Car (class BE)');
  assert.equal(shortName('On foot', ''), 'On foot');
  assert.equal(shortName('(class B)', 'B'), '(class B)');
  // every vehicle of the game keeps a name
  for (const k of VEHICLE_KINDS) assert.ok(shortName(k, VEHICLES[k].licence).length > 0);
});

test('what can be done with a vehicle: as the other menus offer it', () => {
  const ids = (k: VehicleKind, yard = true): string[] => stageModes(k, yard).map((m) => m.id);
  const car = ids('car');
  assert.deepEqual(car.slice(0, 4), ['free', 'demo', 'tour', 'show']);
  assert.equal(car[car.length - 1], 'exam', 'the test last');
  assert.ok(car.includes('basics') && car.includes('rbl') && car.includes('motorway'));
  assert.ok(!car.includes('ceExam') && !car.includes('busLine') && !car.includes('tramLine'));
  assert.ok(!ids('car', false).includes('show'), 'no test place without a practice yard');
  const truck = ids('truck');
  assert.equal(truck[4], 'ceCouple', 'the tasks on the yard before the drives');
  assert.equal(truck[truck.length - 1], 'ceExam');
  assert.ok(!truck.includes('exam'));
  assert.ok(!ids('truck', false).some((id) => id.startsWith('ceC') || id === 'ceRamp'), 'no yard, no yard tasks');
  assert.ok(ids('bus').includes('busLine') && ids('minibusTrailer').includes('busLine'));
  assert.deepEqual(ids('tram'), ['free', 'demo', 'tramLine']);
  assert.deepEqual(ids('plane'), ['free']);
  assert.deepEqual(ids('pedestrian'), ['free', 'show']);
  assert.ok(!ids('tractor').includes('motorway') && ids('tractor').includes('exam'));
  const groupsOf = stageModes('car', true).map((m) => m.group);
  assert.deepEqual([...new Set(groupsOf)], ['drive', 'lesson', 'exam']);
});

test('the way to play chosen is kept while the vehicle has it', () => {
  const car = stageModes('car', true);
  const tram = stageModes('tram', true);
  assert.equal(pickMode(car, 'rbl'), 'rbl');
  assert.equal(pickMode(tram, 'rbl'), 'free', 'the tram has no such lesson: a free drive');
  assert.equal(pickMode(tram, 'demo'), 'demo');
  assert.equal(pickMode([], 'exam'), 'free');
});

const spawns: SpawnJson[] = [
  { name: 'Marktplatz', x: 10, z: 20, yaw: 0.5, kind: 'parking', g: 'Baunatal' },
  { name: 'Rathaus', x: 30, z: 40, yaw: 1, kind: 'street', g: 'Baunatal' },
  { name: 'Königsplatz', x: 6700, z: -7000, yaw: 2, kind: 'street', g: 'Kassel' },
];
const stops: TramStopChoice[] = [
  { name: 'Rathaus', town: 'Baunatal', x: 35, z: 45 },
  { name: 'Königsplatz', town: 'Kassel', x: 6705, z: -7004 },
  { name: 'Wilhelmshöhe', town: 'Kassel', x: 4000, z: -6000 },
];
const runways: RunwayChoice[] = [
  { field: 'Flughafen Kassel (EDVK)', end: '09', x: -5000, z: -20000, yaw: 1.6 },
  { field: 'Flughafen Kassel (EDVK)', end: '27', x: -3000, z: -20000, yaw: -1.5 },
  { field: 'Segelfluggelände', end: '04', x: 9000, z: 3000, yaw: 0.7 },
];
const lastStart = (o: Partial<Settings['lastStart']> = {}): Settings['lastStart'] => ({ spawn: 0, address: null, ...o });

test('where the drive begins: the start point, an address, a stop, the end of a runway', () => {
  const road = stagePlace('car', lastStart({ spawn: 1 }), spawns, null, null);
  assert.equal(road.state, 'ok');
  assert.deepEqual(road.request, { spawn: 1, address: undefined });
  assert.deepEqual(road.preview, { kind: 'car', x: 30, z: 40, yaw: 1 });
  assert.equal(road.town, 'Baunatal');
  assert.equal(road.name, 'Rathaus');
  assert.equal(stagePlace('bus', lastStart({ spawn: 99 }), spawns, null, null).request.spawn, 2, 'a start point the map does not have: its last');
  const address = { label: 'Am Stadtpark 5, Baunatal', street: 'Am Stadtpark', x: 55, z: 66, exact: true };
  const at = stagePlace('motorcycle', lastStart({ spawn: 2, address }), spawns, null, null);
  assert.deepEqual(at.request, { spawn: 2, address });
  assert.deepEqual(at.preview, { kind: 'motorcycle', x: 55, z: 66, yaw: 2 });
  assert.equal(at.town, '');
  assert.equal(at.name, address.label);
  assert.equal(stagePlace('car', lastStart(), [], null, null).state, 'none');

  // the tram: at the stop of the last drive – else in the middle of Kassel; its list read later
  assert.equal(stagePlace('tram', lastStart(), spawns, null, null).state, 'loading');
  assert.equal(stagePlace('tram', lastStart(), spawns, [], null).state, 'none');
  const first = stagePlace('tram', lastStart(), spawns, stops, null);
  assert.equal(first.name, 'Königsplatz');
  assert.deepEqual(first.preview, { kind: 'tram', x: 6705, z: -7004, yaw: 0, stop: stops[1] });
  const kept = stagePlace('tram', lastStart({ tramStop: 'Wilhelmshöhe|Kassel' }), spawns, stops, null);
  assert.equal(kept.request.stop, stops[2]);
  assert.equal(kept.town, 'Kassel');

  // the aeroplane: at the end of the runway of the last flight – else the first of the map's
  assert.equal(stagePlace('plane', lastStart(), spawns, stops, null).state, 'loading');
  const plane = stagePlace('plane', lastStart({ runway: 'Segelfluggelände|04' }), spawns, stops, runways);
  assert.equal(plane.request.runway, runways[2]);
  assert.equal(plane.runway, '04');
  assert.equal(plane.town, 'Segelfluggelände');
  assert.deepEqual(plane.preview, { kind: 'plane', x: 9000, z: 3000, yaw: 0.7 });
  assert.equal(stagePlace('plane', lastStart({ runway: 'gone|99' }), spawns, stops, runways).request.runway, runways[0]);
});

test('a place tapped on the map: there – or the stop, the runway nearest to it', () => {
  const spot = { name: 'Kasseler Straße', x: 6600, z: -6900 };
  const car = lastStart();
  assert.ok(startFromSpot('car', car, spot, stops, runways, 'Road without a name'));
  assert.deepEqual(car.address, { label: 'Kasseler Straße', street: 'Kasseler Straße', x: 6600, z: -6900, exact: false });
  const nameless = lastStart();
  startFromSpot('pedestrian', nameless, { name: '', x: 1, z: 2 }, null, null, 'Road without a name');
  assert.equal(nameless.address?.label, 'Road without a name');
  const tram = lastStart();
  assert.ok(startFromSpot('tram', tram, spot, stops, runways));
  assert.equal(tram.tramStop, 'Königsplatz|Kassel');
  assert.equal(tram.address, null, 'the start point of the road vehicles stays');
  const plane = lastStart();
  assert.ok(startFromSpot('plane', plane, { name: '', x: -3100, z: -19900 }, stops, runways));
  assert.equal(plane.runway, 'Flughafen Kassel (EDVK)|27');
  assert.equal(startFromSpot('tram', lastStart(), spot, null, runways), false, 'no stops read yet: nothing changes');
});

test('the camera: the vehicle large in the picture, whole, a little above its middle', () => {
  const half = (fov: number): number => Math.tan((fov * Math.PI) / 360);
  for (const [kind, radius] of [['car', 8], ['motorcycle', 5.5], ['bus', 15], ['truck', 25], ['carTrailer', 12], ['pedestrian', 4.2], ['plane', 15], ['tram', 23.5]] as const) {
    for (const aspect of [16 / 9, 844 / 390, 4 / 3, 390 / 844]) {
      const f = frameOf(100, kind, radius, aspect);
      const def = VEHICLES[kind];
      // (how far it reaches from the middle the camera circles: its longer end, its half span – the trailer behind it)
      const reach = kind === 'tram' ? (radius - 7) / 1.1 : Math.max(def.outline.front, def.outline.rear, def.outline.hw, def.trailer ? radius * 0.55 : 0);
      // seen from the side its longer end stays within the picture …
      assert.ok(reach / f.dist <= half(f.fov) * aspect * 1.0001, `${kind} ${aspect.toFixed(2)}: whole`);
      // … and it fills a good part of it (or of the height, for whoever is taller than long)
      const share = Math.max(reach / f.dist / (half(f.fov) * aspect), 1.6 / f.dist / half(f.fov));
      assert.ok(share > 0.3, `${kind} ${aspect.toFixed(2)}: large (${share.toFixed(2)})`);
      assert.ok(f.dist > reach, `${kind}: the camera outside it`);
      assert.ok(f.rise > 0 && f.aim < 0, 'from a little above, aimed a little below its middle');
    }
  }
  // an upright screen: a wider lens
  assert.ok(frameOf(0, 'car', 8, 0.46).fov > frameOf(0, 'car', 8, 1.78).fov);
  // it circles …
  assert.notEqual(frameOf(0, 'car', 8, 1.5).angle, frameOf(10, 'car', 8, 1.5).angle);
  // … and comes in from further away when the vehicle changed
  const now = frameOf(50, 'car', 8, 1.5, 50);
  const later = frameOf(52, 'car', 8, 1.5, 50);
  assert.ok(now.dist > later.dist * 1.25, 'further away at first');
  assert.ok(Math.abs(later.dist - frameOf(52, 'car', 8, 1.5).dist) < 1e-9, 'there after a moment');
  // (the frame of the menu: the coming in begins anew with another vehicle)
  stageFrame(10, 'car', 8, 1.5);
  const settled = stageFrame(20, 'car', 8, 1.5);
  const changed = stageFrame(20, 'bus', 15, 1.5);
  assert.ok(changed.dist > frameOf(20, 'bus', 15, 1.5).dist * 1.3);
  assert.equal(settled.dist, frameOf(20, 'car', 8, 1.5).dist);
});

test('the main menu: the stage for new players, a menu chosen stays – the rows, the default of 1.3.0, become the stage once', async () => {
  const { loadSettings, DEFAULT_SETTINGS } = await import('../../src/game/settings.ts');
  const KEY = 'fahrsim-baunatal.settings.v2';
  store.clear();
  assert.equal(DEFAULT_SETTINGS.menuStyle, 'stage');
  assert.equal(loadSettings().menuStyle, 'stage', 'nothing stored: a new player');
  for (const style of ['carousel', 'classic', 'stage'] as const) {
    // (written by 1.4.0 or later: what was chosen stays)
    store.set(KEY, JSON.stringify({ vehicle: 'bus', menuStyle: style, version: 2 }));
    const s = loadSettings();
    assert.equal(s.menuStyle, style, `${style} stays`);
    assert.equal(s.vehicle, 'bus');
  }
  // written by 1.3.0, which stored its default: the rows become the stage once, a list chosen stays a list
  store.set(KEY, JSON.stringify({ vehicle: 'bus', menuStyle: 'carousel' }));
  assert.equal(loadSettings().menuStyle, 'stage');
  store.set(KEY, JSON.stringify({ vehicle: 'bus', menuStyle: 'classic' }));
  assert.equal(loadSettings().menuStyle, 'classic');
  // stored before there was a choice of menus (before 1.3.0), or something unknown: the stage
  store.set(KEY, JSON.stringify({ vehicle: 'truck' }));
  assert.equal(loadSettings().menuStyle, 'stage');
  store.set(KEY, JSON.stringify({ menuStyle: 'cards' }));
  assert.equal(loadSettings().menuStyle, 'stage');
  // the settings of the versions before the playtest
  store.clear();
  store.set('fahrsim-baunatal.settings.v1', JSON.stringify({ menuStyle: 'classic' }));
  assert.equal(loadSettings().menuStyle, 'classic');
  store.clear();
});
