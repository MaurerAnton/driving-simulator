// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A tram and bus stop with everything that belongs to it (render/stopmodels.ts) and people at it
 * (render/people.ts): a platform beside the track, a shelter, the stop sign with a long name, a
 * bench, a bin, a departure board, the Sh 7 board, a tram signal, a points signal, the pantograph
 * signs, masts with the overhead line, a tram at the platform.  The tram comes from the north
 * (−z) and runs south: everything it is meant to see faces north.
 *
 * Params: aspect (F0 … F5, dark – the tram signal; F1 by default), switch (W1 … W13), request=1
 * (the A lamp), t (seconds: the people walk), tram=0 (no tram), merge=1 (fold the stop with
 * mergeStatic), lineup=1 (48 looks side by side instead of the stop's people), focus=x,y,z and
 * radius (what the views look at), eye=x,y,z and look=x,y,z (the view "eye"; by default somebody
 * arriving at the north end of the platform).  lineup=2: 24 looks sitting on benches;
 * signals=1: every tram and points signal aspect side by side west of the road.
 */
import { PeopleRenderer } from '../../../src/render/people.ts';
import type { PersonPose } from '../../../src/render/people.ts';
import {
  CONTACT_WIRE_HEIGHT,
  DepartureBoard,
  SwitchSignal,
  TramSignal,
  bench,
  benchSeats,
  bin,
  catenaryMast,
  contactWire,
  mergeStatic,
  pantographSign,
  platform,
  shelter,
  shelterSeats,
  stopBoard,
  stopSign,
} from '../../../src/render/stopmodels.ts';
import type { SwitchAspect, TramAspect } from '../../../src/render/stopmodels.ts';
import { RailActors } from '../../../src/render/trams.ts';
import type { RailVehicle } from '../../../src/sim/rail.ts';
import { RAIL } from '../../../src/world/types.ts';
import type { PreviewScene, SceneContext } from '../models.ts';

/** the middle of the track, the platform beside it (east), its height */
const TRACK_X = 6;
const EDGE_X = 7.25;
const PLATFORM_W = 3;
const PLATFORM_H = 0.25;

export function build({ THREE, scene, params }: SceneContext): PreviewScene {
  const vec = (key: string, fallback: [number, number, number]): InstanceType<typeof THREE.Vector3> => {
    const v = (params.get(key) ?? '').split(',').map(Number);
    return v.length === 3 && v.every(Number.isFinite) ? new THREE.Vector3(v[0], v[1], v[2]) : new THREE.Vector3(...fallback);
  };
  const stop = new THREE.Group();
  stop.name = 'stop';
  const at = (o: InstanceType<typeof THREE.Object3D>, x: number, y: number, z: number, yaw = 0): void => {
    o.position.set(x, y, z);
    o.rotation.y = yaw;
    stop.add(o);
  };
  const north = 0;
  const west = Math.PI / 2;

  // ---- the track: a paved bed with two rails (only for this picture)
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 240), new THREE.MeshLambertMaterial({ color: 0x6d6a66 }));
  bed.rotation.x = -Math.PI / 2;
  bed.position.set(TRACK_X, 0.006, 0);
  bed.receiveShadow = true;
  scene.add(bed);
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.03, 240), new THREE.MeshLambertMaterial({ color: 0x8a8580 }));
    rail.position.set(TRACK_X + side * 0.7175, 0.02, 0);
    scene.add(rail);
  }

  // ---- the platform and what stands on it
  const px = EDGE_X + PLATFORM_W / 2;
  // (platform and wire place themselves at their first point)
  stop.add(platform([[px, 0, 20], [px, 0, 0], [px, 0, -20]], PLATFORM_W, PLATFORM_H, -1));
  const shelterAt = new THREE.Vector3(px + 0.55, PLATFORM_H, 2);
  at(shelter(3.6), shelterAt.x, shelterAt.y, shelterAt.z, west);
  at(stopSign('both', 'Kassel Wilhelmshöhe (Park Schönfeld)'), px + 1.05, PLATFORM_H, -6, north);
  at(bench(), px + 1.0, PLATFORM_H, 9, west);
  at(bin(), px + 1.2, PLATFORM_H, 5.4, west);
  at(stopBoard(), EDGE_X + 0.3, PLATFORM_H, 17, north);
  const board = new DepartureBoard();
  board.set(
    [
      { line: '4', destination: 'Kaufungen Papierfabrik', minutes: 2 },
      { line: '7', destination: 'Mattenberg', minutes: 9 },
      { line: '1', destination: 'Holländische Straße', minutes: 14 },
    ],
    '12:41',
  );
  at(board.group, px + 1.1, PLATFORM_H, -2.6, west);

  // ---- signals beside the track (on the driver's right: west, as the tram runs south)
  const signal = new TramSignal();
  signal.set((params.get('aspect') ?? 'F1') as TramAspect);
  signal.setRequest(params.get('request') === '1');
  at(signal.group, TRACK_X - 1.55, 0, 24, north);
  const points = new SwitchSignal();
  points.set((params.get('switch') ?? 'W2') as SwitchAspect);
  at(points.group, TRACK_X - 1.4, 0, 31, north);
  at(pantographSign(false), TRACK_X - 1.6, 0, -30, north);
  at(pantographSign(true), TRACK_X - 1.6, 0, -42, north);
  if (params.get('signals') === '1') {
    // every aspect side by side in the open, west of the road (the A lamp lit on F4's head)
    const tram: TramAspect[] = ['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'dark'];
    tram.forEach((a, i) => {
      const s = new TramSignal();
      s.set(a);
      s.setRequest(a === 'F4');
      at(s.group, -24 + i * 1.3, 0, 24, north);
    });
    const switches: SwitchAspect[] = ['W1', 'W2', 'W3', 'W11', 'W12', 'W13', 'dark'];
    switches.forEach((a, i) => {
      const s = new SwitchSignal();
      s.set(a);
      at(s.group, -24 + i * 1.3, 0, 21.5, north);
    });
  }

  // ---- the overhead line: masts west of the track, the wire over its middle
  for (const z of [-35, 0, 35]) at(catenaryMast(1.6), TRACK_X - 1.6, 0, z, north);
  const wire: number[] = [];
  for (let z = -120; z <= 120; z += 10) wire.push(TRACK_X, CONTACT_WIRE_HEIGHT, z);
  stop.add(contactWire(new Float32Array(wire)));

  scene.add(params.get('merge') === '1' ? mergeStatic(stop) : stop);
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshLambertMaterial) o.receiveShadow = true;
  });

  // ---- a tram at the platform, its front at the Sh 7 board
  if (params.get('tram') !== '0') {
    const trams = new RailActors();
    const cars = [0, 1, 2].map((i) => ({ x: TRACK_X, y: 0, z: 17 - 4.7 - i * 10.1, yaw: Math.PI, pitch: 0 }));
    trams.update([{ id: 1, kind: RAIL.TRAM, cars } as unknown as RailVehicle]);
    scene.add(trams.group);
  }

  // ---- the people
  const people = new PeopleRenderer();
  scene.add(people.group);
  const lineup = params.get('lineup') === '1';
  // lineup=2: 24 looks sitting on eight benches in the open, facing north (focus=-30.7,0.8,-10.5)
  const seated = params.get('lineup') === '2';
  const benches: Array<[number, number]> = [];
  if (seated) {
    for (let j = 0; j < 8; j++) benches.push([-34 + (j % 4) * 2.2, -12 + Math.floor(j / 4) * 3]);
    for (const [x, z] of benches) {
      const b = bench();
      b.position.set(x, 0, z);
      scene.add(b);
    }
  }
  const toWorld = (o: InstanceType<typeof THREE.Vector3>, yaw: number, x: number, z: number): [number, number] => [o.x + Math.cos(yaw) * x + Math.sin(yaw) * z, o.z - Math.sin(yaw) * x + Math.cos(yaw) * z];
  const update = (t: number): void => {
    const list: PersonPose[] = [];
    if (seated) {
      benches.forEach(([x, z], j) => benchSeats().forEach(([sx, sz], k) => list.push({ x: x + sx, y: 0, z: z + sz, yaw: 0, walk: -1, look: j * 3 + k + 1, sit: true })));
      people.update(list, t);
      return;
    }
    if (lineup) {
      // 48 looks in four rows of twelve, facing north, in the open west of the road (focus=-28.8,0.9,-8.1)
      for (let i = 0; i < 48; i++) {
        const row = Math.floor(i / 12);
        list.push({ x: -34 + (i % 12) * 0.9 + (row % 2) * 0.45, y: 0, z: -12 + row * 2.6, yaw: 0, walk: -1, look: i + 1 });
      }
      people.update(list, t);
      return;
    }
    // sitting in the shelter and on the bench
    shelterSeats(3.6).slice(0, 4).forEach(([sx, sz], i) => {
      if (i === 2) return;
      const [x, z] = toWorld(shelterAt, west, sx, sz);
      list.push({ x, y: PLATFORM_H, z, yaw: west, walk: -1, look: 11 + i, sit: true });
    });
    benchSeats().slice(0, 2).forEach(([sx, sz], i) => {
      const [x, z] = toWorld(new THREE.Vector3(px + 1.0, 0, 9), west, sx, sz);
      list.push({ x, y: PLATFORM_H, z, yaw: west, walk: -1, look: 21 + i, sit: true });
    });
    // waiting near the edge, facing the track
    const waiting: Array<[number, number, number]> = [[8.2, -4, 0.2], [8.0, -1.2, -0.3], [8.4, 6.0, 0.1], [8.1, 7.0, 0.5], [8.6, 11.5, -0.2], [7.9, 13.0, 0.0], [9.0, -8.5, 0.8], [8.5, 0.9, 0.3]];
    waiting.forEach(([x, z, turn], i) => list.push({ x, y: PLATFORM_H, z, yaw: west + turn, walk: -1, look: 31 + i }));
    // walking along the platform, both ways, at their own pace (one slow, with a stick perhaps)
    const walkers: Array<[number, number, number, number]> = [[9.3, -18, 1.35, 0], [9.0, 16, -1.3, 3], [8.0, -14, 1.2, 7], [9.6, 18, -1.4, 1], [8.8, -10, 0.8, 5], [9.5, 12, -1.1, 9]];
    walkers.forEach(([x, z0, v, phase], i) => {
      const d = (((t + phase) * Math.abs(v)) % 30) + 0.5;
      list.push({ x, y: PLATFORM_H, z: z0 + Math.sign(v) * d, yaw: v > 0 ? Math.PI : 0, walk: d, look: 41 + i });
    });
    // two getting off the tram and walking away across the platform
    for (const [i, z] of [[0, 4.2], [1, -6.8]] as const) {
      const d = ((t * 1.25 + i * 1.7) % 3.2) + 0.2;
      list.push({ x: EDGE_X + d, y: PLATFORM_H, z, yaw: -Math.PI / 2, walk: d, look: 51 + i });
    }
    people.update(list, t);
  };

  return {
    target: vec('focus', [px, 1.3, 1]),
    radius: Number(params.get('radius') ?? 9),
    // somebody arriving at the north end of the platform (a tram driver 80 m before the signal:
    // tram=0&eye=6.6,2.6,-56&look=4.6,2.4,24)
    eye: vec('eye', [px - 0.6, 1.65, -19]),
    look: vec('look', [px, 1.3, 2]),
    update,
  };
}
