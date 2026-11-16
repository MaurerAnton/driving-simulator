// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Headless soak run of the ambient traffic on the real map (not a unit test):
 *   node tests/traffic.sim.ts [minutes]
 * Reports flow, stalemates and car-to-car overlaps.
 */
import { SignalSystem } from '../src/sim/signals.ts';
import { Traffic, boxesOverlap } from '../src/sim/traffic.ts';
import type { PlayerState } from '../src/sim/traffic.ts';
import { openRealMap } from './realmap.ts';

const minutes = Number(process.argv[2] ?? 4);
const real = await openRealMap();
const { world, lanes: graph, map } = real;
const signals = new SignalSystem(world.signals);
const traffic = new Traffic(world, graph, signals);
real.followers.traffic = traffic;
real.followers.signals = signals;
traffic.targetCount = 45;
const places: Array<[string, number, number]> = [
  ['town centre', 690, -295],
  ['A49 junction', 1450, 2780],
  ['Großenritte', -1160, 500],
];
for (const [name, x, z] of places) {
  traffic.clear();
  // (the road network may come in pieces: the piece around the place)
  await map.loadAround(x, z, 1500);
  // the "player" is parked off the road, high above nothing: only a spawn anchor
  const player: PlayerState = { x, y: [...world.allNodes].reduce((best, n) => (Math.hypot(n.x - x, n.z - z) < Math.hypot(best.x - x, best.z - z) ? n : best)).y, z, yaw: 0, speed: 0, length: 4.3, width: 1.8 };
  player.x += 3000 * 0; // keep in place
  const dt = 1 / 30;
  let overlaps = 0;
  let maxWait = 0;
  let removedStuck = 0;
  let speedSum = 0;
  let samples = 0;
  let nan = 0;
  const seenOverlap = new Set<string>();
  const t0 = Date.now();
  let lastCount = 0;
  for (let step = 0; step < minutes * 60 * 30; step++) {
    signals.update(dt);
    const before = traffic.cars.length;
    // park the anchor 40 m above the ground so no car ever brakes for it
    traffic.update(dt, { ...player, y: player.y + 40 });
    if (traffic.cars.length < before) removedStuck += traffic.cars.filter((c) => c.stuck > 44).length;
    lastCount = traffic.cars.length;
    for (const c of traffic.cars) {
      if (!Number.isFinite(c.x + c.z + c.v)) nan++;
      speedSum += c.v;
      samples++;
      maxWait = Math.max(maxWait, c.stuck);
    }
    if (step % 6 === 0) {
      const cars = traffic.cars;
      for (let i = 0; i < cars.length; i++) {
        for (let j = i + 1; j < cars.length; j++) {
          const a = cars[i];
          const b = cars[j];
          if (Math.abs(a.x - b.x) > 6 || Math.abs(a.z - b.z) > 6 || Math.abs(a.y - b.y) > 2.5) continue;
          if (boxesOverlap(a.x, a.z, a.yaw, a.length / 2 - 0.25, a.width / 2 - 0.2, b.x, b.z, b.yaw, b.length / 2 - 0.25, b.width / 2 - 0.2)) {
            const key = `${a.id}:${b.id}`;
            if (!seenOverlap.has(key)) {
              seenOverlap.add(key);
              overlaps++;
              if (a.conn && a.conn === b.conn && overlaps <= 12) {
                const rear = a.s < b.s ? a : b;
                const front = a.s < b.s ? b : a;
                console.log(`   same-conn: node ${a.conn.node.id} len ${a.conn.len.toFixed(1)} turn ${a.conn.turn} | rear id${rear.id} s=${rear.s.toFixed(2)} v=${rear.v.toFixed(2)} a=${rear.a.toFixed(2)} | front id${front.id} s=${front.s.toFixed(2)} v=${front.v.toFixed(2)} a=${front.a.toFixed(2)} stuck=${front.stuck.toFixed(1)} | pos rear (${rear.x.toFixed(1)},${rear.z.toFixed(1)}) front (${front.x.toFixed(1)},${front.z.toFixed(1)}) yaw ${rear.yaw.toFixed(2)}/${front.yaw.toFixed(2)}`);
              } else if (a.conn && b.conn && overlaps <= 12) {
                const k = a.conn.conflicts.find((q) => q.other === b.conn);
                console.log(
                  `   detail: node ${a.conn.node.id} arms ${a.conn.node.arms.length} | A: lane${a.conn.from.id}(e${a.conn.from.edge.id} idx${a.conn.from.idx}/${a.conn.from.count} role${a.conn.from.armTo.role} sg${a.conn.from.armTo.sg})→lane${a.conn.to.id} s=${a.s.toFixed(1)}/${a.conn.len.toFixed(1)} | B: lane${b.conn.from.id}(e${b.conn.from.edge.id} idx${b.conn.from.idx}/${b.conn.from.count} role${b.conn.from.armTo.role} sg${b.conn.from.armTo.sg})→lane${b.conn.to.id} s=${b.s.toFixed(1)}/${b.conn.len.toFixed(1)} | conflict ${k ? `sA=${k.sSelf.toFixed(1)} sB=${k.sOther.toFixed(1)} merge=${k.merge} Ayields=${k.yield}` : 'NONE'} same=${a.conn === b.conn}`,
                );
              }
              if (overlaps <= 6) {
                const where = (c: typeof a): string => (c.conn ? `conn@node${c.conn.node.id}(ctrl ${c.conn.node.ctrl}, turn ${c.conn.turn})` : `lane e${c.lane!.edge.id} cls${c.lane!.edge.cls} s=${c.s.toFixed(0)}/${c.lane!.len.toFixed(0)}`);
                console.log(`   overlap: ${where(a)} v=${a.v.toFixed(1)}  ×  ${where(b)} v=${b.v.toFixed(1)}`);
              }
            }
          }
        }
      }
    }
  }
  console.log(
    `${name}: ${lastCount} cars, mean speed ${((speedSum / Math.max(samples, 1)) * 3.6).toFixed(1)} km/h, longest standstill ${maxWait.toFixed(0)} s, removed as stuck ${removedStuck}, overlaps ${overlaps}, NaN ${nan}, ${(Date.now() - t0) / 1000}s wall for ${minutes} min`,
  );
}
