// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A virtual learner driver on the real map (headless, no rendering):
 *
 *   node tests/drive.sim.ts [lessonId ...]
 *   node tests/drive.sim.ts --truck [lessonId ...]     # the truck with its trailer (class CE)
 *   node tests/drive.sim.ts --traffic [lessonId ...]   # among the ambient traffic
 *
 * It follows the navigation of each lesson with the real vehicle model and
 * obeys the rules it can perceive: speed limits, traffic lights, stop signs,
 * indicators, shoulder checks.  A law-abiding drive must produce no serious
 * findings – every one reported here is either a bug in the rule monitor or
 * in the map data, and worth looking at.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { LESSONS, Navigator, findTarget } from '../src/game/nav.ts';
import { WorldGround } from '../src/sim/ground.ts';
import { AutoDriver } from '../src/sim/autodriver.ts';
import { RuleMonitor } from '../src/sim/rules.ts';
import { SIG, SignalSystem } from '../src/sim/signals.ts';
import { Traffic } from '../src/sim/traffic.ts';
import { COMPACT_CAR_AUTOMATIC, TRUCK, Vehicle } from '../src/sim/vehicle/index.ts';
import { TANDEM_TRAILER, Trailer } from '../src/sim/trailer.ts';
import { findRoadSpot, mainNetwork } from '../src/game/address.ts';
import { newPolySample, projectOnPolyline, samplePolyline } from '../src/core/geom.ts';
import { LaneGraph, TURN, lanePoint } from '../src/world/lanes.ts';
import type { Connector, Lane } from '../src/world/lanes.ts';
import { tileKey, unpackTile } from '../src/world/tilefmt.ts';
import { CLS, CTRL, EF, ROLE } from '../src/world/types.ts';
import { newSurfaceHit } from '../src/world/world.ts';
import { MapLoader } from '../src/world/loader.ts';
import { NetIndex } from '../src/world/netindex.ts';
import { quickestToEdge, wayOf } from '../src/world/routegraph.ts';
import { followMap } from '../src/sim/follow.ts';
import type { MapFollowers } from '../src/sim/follow.ts';
import { diskFiles } from '../tools/mapgen/mapfiles.ts';
import { fitJunctionPlane } from '../tools/mapgen/elevation.ts';
import type { PlaneArm } from '../tools/mapgen/elevation.ts';

// (MAP_DIR: another map folder than public/map)
const root = new URL(`../${(process.env.MAP_DIR ?? 'public/map').replace(/\/$/, '')}/`, import.meta.url);
// The map as the game loads it: in one piece, or the road network in chunks that follow the car.
const map = await MapLoader.open(diskFiles(fileURLToPath(root)));
const world = map.world;
const json = world.json;
const graph = new LaneGraph(world);
const followers: MapFollowers = { lanes: graph };
followMap(map, followers);

/**
 * DRIVE_PLANES=1: the planes of the junctions as the map build of today would
 * fit them (tools/mapgen/elevation.ts), on a map that was built before – to
 * see what a change of that fit does to the drives without building the map.
 */
const replaned = new WeakSet<object>();
function replane(): void {
  if (process.env.DRIVE_PLANES !== '1') return;
  for (const n of world.allNodes) {
    if (n.stub || replaned.has(n)) continue;
    replaned.add(n);
    const arms: PlaneArm[] = [];
    for (const a of n.arms) {
      const e = a.edge;
      const p = e.pl.pts;
      const cum = e.pl.cum;
      const last = cum.length - 1;
      const isA = e.a === n;
      // ~10 m along the arm
      let j = isA ? 0 : last;
      while (isA ? j < last && cum[j] < 10 : j > 0 && e.len - cum[j] < 10) j += isA ? 1 : -1;
      const dx = p[j * 3] - n.x;
      const dz = p[j * 3 + 2] - n.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.5) continue;
      arms.push({ ux: dx / d, uz: dz / d, m: (p[j * 3 + 1] - n.y) / d, w: e.tier + 1 });
    }
    const [gx, gz] = fitJunctionPlane(arms);
    n.gx = gx;
    n.gz = gz;
  }
}
/** the roads of the whole map, for ways that lead beyond what is loaded (a map in pieces) */
const netData = await map.net();
const index = netData ? new NetIndex(netData) : null;

/** Terrain straight from the tile files. */
const tileCache = new Map<string, { h: Float32Array; n: number; cov: Uint8Array; cn: number } | null>();
const terrain = {
  tile(x: number, z: number) {
    const { x0: minX, z0: minZ, size: tileSize } = map.tiles;
    const ix = Math.floor((x - minX) / tileSize);
    const iz = Math.floor((z - minZ) / tileSize);
    const key = tileKey(ix, iz);
    let t = tileCache.get(key);
    if (t === undefined) {
      try {
        const buf = gunzipSync(readFileSync(new URL(`tiles/${key}.fsb`, root)));
        const u = unpackTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
        const hgt = u.get('hgt') as Uint16Array;
        const h = new Float32Array(hgt.length);
        for (let i = 0; i < h.length; i++) h[i] = u.header.terrainMin + hgt[i] * u.header.terrainScale;
        t = { h, n: u.header.terrainN, cov: (u.get('cov') as Uint8Array).slice(), cn: u.header.coverN };
      } catch {
        t = null;
      }
      tileCache.set(key, t);
    }
    return { t, fx: (x - (minX + ix * tileSize)) / tileSize, fz: (z - (minZ + iz * tileSize)) / tileSize };
  },
  heightAt(x: number, z: number): number {
    const { t, fx, fz } = this.tile(x, z);
    if (!t) return NaN;
    // same triangle interpolation as the game (src/render/tiles.ts)
    const n = t.n;
    const gx = Math.max(0, Math.min(n - 1.0001, fx * (n - 1)));
    const gz = Math.max(0, Math.min(n - 1.0001, fz * (n - 1)));
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const tx = gx - i;
    const tz = gz - j;
    const k = j * n + i;
    const h00 = t.h[k];
    const h10 = t.h[k + 1];
    const h01 = t.h[k + n];
    const h11 = t.h[k + n + 1];
    return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  },
  coverAt(x: number, z: number): number {
    const { t, fx, fz } = this.tile(x, z);
    if (!t) return 0;
    return t.cov[Math.min(t.cn - 1, Math.floor(fz * t.cn)) * t.cn + Math.min(t.cn - 1, Math.floor(fx * t.cn))];
  },
};

const DT = 1 / 120;

/**
 * Tracing for debugging a finding: DRIVE_DEBUG=<until s> [DRIVE_FROM=<from s>]
 * prints the driver's state twice a second in that time window,
 * DRIVE_NEAR=<x>,<z>,<radius m> whenever the car is near that point;
 * DRIVE_UNTIL=<s> ends the drive early; DRIVE_AT="x,z" starts on the road
 * nearest to that place; DRIVE_VIA="x,z;x,z" replaces the
 * lesson's destinations by the roads nearest to these points (with
 * DRIVE_HALT=1 the car comes to a halt at the last one, as on a
 * demonstration drive of the game); DRIVE_NAV=1 prints every destination
 * with its route.
 */
const NEAR = (process.env.DRIVE_NEAR ?? '').split(',').map(Number);
/** DRIVE_AT="x,z": start on the road nearest to this place (to look at a spot far from the start points) */
const AT = (process.env.DRIVE_AT ?? '').split(',').filter(Boolean).map(Number);
/** DRIVE_VIA="x,z;x,z;…": destinations to drive to one after the other (nearest road to each point) */
const VIA = (process.env.DRIVE_VIA ?? '')
  .split(';')
  .filter((p) => p.includes(','))
  .map((p) => p.split(',').map(Number));
function traceHere(t: number, x: number, z: number): boolean {
  if (process.env.DRIVE_DEBUG && t < Number(process.env.DRIVE_DEBUG) && t > Number(process.env.DRIVE_FROM ?? 0)) return true;
  return NEAR.length === 3 && Math.hypot(x - NEAR[0], z - NEAR[1]) < NEAR[2];
}
const smp = newPolySample();
const hit = newSurfaceHit();

/** The truck with its trailer instead of the car: longer, slower in turns, 60 km/h outside town, 80 on the motorway. */
const TRUCK_RUN = process.env.DRIVE_TRUCK === '1' || process.argv.includes('--truck');
const SPEC = TRUCK_RUN ? TRUCK : COMPACT_CAR_AUTOMATIC;
/** from the model origin to the front bumper */
const FRONT = TRUCK_RUN ? 3.75 : 2.14;
const HALT = process.env.DRIVE_HALT === '1';
/** DRIVE_TRAFFIC=1: among the ambient traffic, which the driver then has to mind (distance, right of way, pedestrians) */
const WITH_TRAFFIC = process.env.DRIVE_TRAFFIC === '1' || process.argv.includes('--traffic');

async function runLesson(id: string, spawnIdx: number, obey = true): Promise<{ km: number; minutes: number; findings: string[]; done: boolean; where: string }> {
  const lesson = LESSONS.find((l) => l.id === id)!;
  let sp = json.spawns[spawnIdx];
  if (AT.length === 2) {
    // DRIVE_AT: from the road nearest to a place instead of the start point
    await map.loadAround(AT[0], AT[1]);
    replane();
    sp = findRoadSpot(world, graph, AT[0], AT[1], '', 300, index ? (l) => index.main[wayOf(l)] === 1 : undefined) ?? sp;
  }
  await map.loadAround(sp.x, sp.z);
  replane();
  const signals = new SignalSystem(world.signals);
  const traffic = new Traffic(world, graph, signals);
  followers.traffic = traffic;
  followers.signals = signals;
  traffic.targetCount = WITH_TRAFFIC ? 24 : 0;
  const rules = new RuleMonitor(world, graph, signals, traffic);
  rules.strict = true;
  rules.truck = TRUCK_RUN;
  const nav = new Navigator(graph);
  const ground = new WorldGround(world, terrain);
  const v = new Vehicle(SPEC, ground);
  if (TRUCK_RUN) {
    // as in the game: the combination starts on a road wide enough for it, not in the car park
    const wide = (e: Lane['edge']): boolean => (e.cls === CLS.PRIMARY || e.cls === CLS.SECONDARY || e.cls === CLS.TERTIARY) && e.len - e.cutA - e.cutB > 60;
    const main = index ? null : mainNetwork(world, graph);
    sp = findRoadSpot(world, graph, sp.x, sp.z, '', 900, (l) => (index ? index.main[wayOf(l)] === 1 : (main as Set<number>).has(l.id)), wide, 20) ?? sp;
  }
  const trailer = TRUCK_RUN ? new Trailer(TANDEM_TRAILER, ground) : null;
  const ty = terrain.heightAt(sp.x, sp.z);
  const y0 = world.surfaceAt(sp.x, sp.z, ty + 3, hit) ? hit.y : ty;
  v.teleport(sp.x, y0 + 0.02, sp.z, sp.yaw);
  v.resetDrivetrain(true);
  trailer?.coupleBehind(v);
  let sharpest = 0;
  const driver = new AutoDriver(world, signals, rules, WITH_TRAFFIC ? traffic : null, { spec: SPEC, front: FRONT, truck: TRUCK_RUN, obey });
  let crashes = 0;
  let turned = 0;
  const mpos = new Float64Array(3);
  let targetIdx = 0;
  let home: Lane['edge'] | null = null;
  const visited = new Set<Lane['edge']>();
  let indicator = 0;
  let look = 0;
  let t = 0;
  let done = false;
  let stuck = 0;
  let waited = 0;
  const maxT = Number(process.env.DRIVE_UNTIL ?? 60 * 40);
  let mapT = 0;
  while (t < maxT && !done) {
    v.getModelPosition(mpos);
    // the road network follows the car: what is missing around it is loaded, what lies far behind is dropped
    if (map.pieces && t >= mapT) {
      mapT = t + 0.5;
      await map.loadAround(mpos[0], mpos[2]);
      map.update(mpos[0], mpos[2], Infinity);
      replane();
    }
    const lane = rules.laneNow;
    const laneS = rules.laneFront;
    // --- navigation ---
    if (lane) {
      if (!home) home = lane.edge;
      if (!nav.busy) {
        let goal: Lane['edge'] | null = null;
        if (VIA.length > 0) {
          // debugging: drive past the given points instead of the lesson's destinations
          if (targetIdx >= VIA.length) {
            done = true;
            continue;
          }
          driver.halt = HALT && targetIdx === VIA.length - 1 ? { x: VIA[targetIdx][0], z: VIA[targetIdx][1] } : null;
          if (index) {
            // (a map in pieces: the way there over the roads of the whole map, as the game plans it – the place may lie far beyond what is loaded)
            const main = (e: number): boolean => index.main[e * 2] === 1 || index.main[e * 2 + 1] === 1;
            const to = index.nearest(VIA[targetIdx][0], VIA[targetIdx][1], 200, main) ?? index.nearest(VIA[targetIdx][0], VIA[targetIdx][1], 150);
            // (as in the game: the place to halt at lies on the road, not at the house beside it)
            if (driver.halt && to) driver.halt = { x: to.x, z: to.z };
            const ways = to ? (to.edge === lane.edge.id ? [] : quickestToEdge(index.graph, wayOf(lane), to.edge)) : null;
            if (ways) {
              nav.net = index.graph;
              nav.setWays(ways, lane, false);
              if (process.env.DRIVE_NAV) console.log(`nav t=${t.toFixed(0)} target ${targetIdx}: ${ways.length} ways, ${(ways.reduce((a, w) => a + index.graph.len[w], 0) / 1000).toFixed(1)} km`);
              continue;
            }
          } else if (world.nearestRoad(VIA[targetIdx][0], VIA[targetIdx][1], 40, 0, hit)) goal = hit.edge;
        } else goal = findTarget(world, graph, lesson.targets[targetIdx], mpos[0], mpos[2], lane, home, visited);
        if (!goal) {
          targetIdx++;
          if (targetIdx >= (VIA.length || lesson.targets.length)) done = true;
          continue;
        }
        visited.add(goal);
        nav.setGoal(goal, lane);
        if (process.env.DRIVE_NAV) {
          const r = nav.route ?? [];
          console.log(`nav t=${t.toFixed(0)} target ${targetIdx} → e${goal.id} "${goal.name}" (${goal.a.x.toFixed(0)},${goal.a.z.toFixed(0)})–(${goal.b.x.toFixed(0)},${goal.b.z.toFixed(0)}) len=${goal.len.toFixed(0)} cut=${goal.cutA.toFixed(1)}/${goal.cutB.toFixed(1)} lanes=${goal.lanesF}/${goal.lanesB} from lane ${lane.id}/e${lane.edge.id}; route ${r.length} connectors: ${r.map((c) => `e${c.to.edge.id}${'SLRU'[c.turn]}`).join(' ')}`);
        }
      }
      const h = nav.update(DT, lane, laneS, mpos[0], mpos[2]);
      rules.allowed = new Set(nav.routeLanes.map((l) => l.edge));
      if (h.done && !driver.halt) {
        targetIdx++;
        nav.clear();
        if (targetIdx >= (VIA.length || lesson.targets.length)) done = true;
      }
    }
    // --- the driver: path, rules, controls (src/sim/autodriver.ts – the same one drives the demonstration drives of the game) ---
    const route = nav.route ?? [];
    const cmd = driver.step(DT, v, mpos, route);
    const { next, tx, tz, limit, distToLine, mustStop, crossStop } = driver.seen;
    indicator = cmd.indicator;
    look = cmd.look;
    const { steer, throttle, brake } = cmd;
    if (cmd.turnRound) {
      // the end of a street the way leads back out of: as in the game, the car is turned round on the spot
      const to = cmd.turnRound.to;
      lanePoint(to, Math.min(3, to.len / 2), smp);
      const ty2 = world.surfaceAt(smp.x, smp.z, smp.y + 1.5, hit) ? hit.y : smp.y;
      v.teleport(smp.x, ty2 + 0.05, smp.z, Math.atan2(-smp.tx, -smp.tz));
      trailer?.coupleBehind(v);
      driver.reset();
      turned++;
      continue;
    }
    if (cmd.arrived && driver.halt) {
      console.log(`   halted ${Math.hypot(mpos[0] - driver.halt.x, mpos[2] - driver.halt.z).toFixed(1)} m from the place asked for, at ${v.speed.toFixed(2)} m/s`);
      done = true;
    }
    const input = { steer, throttle, brake, clutch: 0, handbrake: 0, gear: 1, ignition: true, starter: false };
    v.step(DT, input);
    if (trailer) {
      trailer.step(DT, v, input);
      sharpest = Math.max(sharpest, Math.abs(trailer.articulation));
    }
    signals.update(DT);
    v.getModelPosition(mpos);
    if (WITH_TRAFFIC) {
      // (the traffic wants the middle of the vehicle's length)
      const mid = (SPEC.length ?? 4.28) / 2 - FRONT;
      traffic.update(DT, { x: mpos[0] + Math.sin(v.yaw) * mid, y: mpos[1], z: mpos[2] + Math.cos(v.yaw) * mid, yaw: v.yaw, speed: v.speed, length: SPEC.length ?? 4.28, width: SPEC.width ?? 1.79 });
      for (const e of traffic.events) if (e.type === 'collision') crashes++;
    }
    rules.update(DT, { x: mpos[0], y: mpos[1], z: mpos[2], yaw: v.yaw, speed: v.speed, indicator, hazard: false, lookYaw: look, seatbelt: true, handbrake: 0, stalled: false, hitScenery: 0, length: SPEC.length ?? 4.28, front: FRONT }, WITH_TRAFFIC ? traffic.events : []);
    if (traceHere(t, mpos[0], mpos[2]) && Math.abs(t * 2 - Math.round(t * 2)) < DT) {
      const armD = lane ? lane.armTo : null;
      console.log(`   arm role=${armD?.role} sg=${armD?.sg} sc=${lane?.to.sc} ctrl=${lane?.to.ctrl} sig=${armD && armD.sg >= 0 && lane!.to.sc >= 0 ? signals.get(lane!.to.sc, armD.sg) : '-'} dist=${distToLine.toFixed(1)} mustStop=${mustStop} cross=${crossStop} stopAt=${lane?.stopAt.toFixed(1)}`);
      const on = world.surfaceAt(mpos[0], mpos[2], mpos[1] + 0.6, hit);
      console.log(`t=${t.toFixed(1)} pos=(${mpos[0].toFixed(1)},${mpos[2].toFixed(1)},${mpos[1].toFixed(2)}) v=${v.speed.toFixed(1)} yaw=${v.yaw.toFixed(2)} lane=${lane ? `${lane.id}/e${lane.edge.id} s=${laneS.toFixed(1)}/${lane.len.toFixed(1)}` : '-'} surf=${on ? (hit.node ? `node${hit.node.id}` : `e${hit.edge!.id} z${hit.zone} off=${hit.off.toFixed(1)}`) : 'NONE'} next=${next ? `c${next.id} turn${next.turn} len=${next.len.toFixed(1)}→e${next.to.edge.id}` : '-'} tgt=(${tx.toFixed(1)},${tz.toFixed(1)}) steer=${steer.toFixed(2)} thr=${throttle.toFixed(2)} brk=${brake.toFixed(2)} lim=${limit.toFixed(1)}`);
    }
    if (WITH_TRAFFIC && traceHere(t, mpos[0], mpos[2]) && Math.abs(t * 2 - Math.round(t * 2)) < DT) {
      // who is around: the cars within 30 m, with where they are on their way
      for (const o of traffic.cars) {
        const d = Math.hypot(o.x - mpos[0], o.z - mpos[2]);
        if (d < 30) console.log(`      car ${o.id} ${d.toFixed(1)} m away at (${o.x.toFixed(1)},${o.z.toFixed(1)}) v=${o.v.toFixed(1)} ${o.lane ? `lane ${o.lane.id}/e${o.lane.edge.id} s=${o.s.toFixed(1)}/${o.lane.len.toFixed(1)}` : `conn c${o.conn?.id} s=${o.s.toFixed(1)}`} next=c${o.next?.id ?? '-'}${o.blockedByPlayer > 0 ? ' brakes for us' : ''}`);
      }
      console.log(`      gap ahead ${driver.seen.gap.toFixed(1)} remark "${cmd.remark}" waiting=${cmd.waiting}`);
    }
    t += DT;
    stuck = Math.abs(v.speed) < 0.1 && !cmd.waiting ? stuck + DT : 0;
    if (stuck > 25) break;
    // waiting for a light or for the traffic is fine – but not for ever
    waited = Math.abs(v.speed) < 0.1 ? waited + DT : 0;
    if (waited > 240) break;
  }
  if (trailer) console.log(`   trailer: sharpest angle to the truck ${((sharpest * 180) / Math.PI).toFixed(0)}°`);
  if (WITH_TRAFFIC) console.log(`   among ${traffic.cars.length} cars: ${crashes} collision(s)`);
  if (turned) console.log(`   turned round at the end of a street ${turned} time(s)`);
  const findings = rules.log.map((f) => `${f.severity}:${f.id}@(${f.x.toFixed(0)},${f.z.toFixed(0)}) t=${f.time.toFixed(0)}s ${JSON.stringify(f.data)}`);
  let where = '';
  if (!done) {
    const l = rules.laneNow;
    const arm = l?.armTo;
    where = ` – ${stuck > 25 ? 'stuck' : 'out of time'} at (${mpos[0].toFixed(0)},${mpos[2].toFixed(0)}) v=${v.speed.toFixed(1)} m/s, target ${targetIdx + 1}/${VIA.length || lesson.targets.length}${nav.goal ? ` e${nav.goal.id}` : ''}, ${l ? `lane ${l.id}/e${l.edge.id} at ${(rules as unknown as { laneS: number }).laneS.toFixed(1)}/${l.len.toFixed(1)} m, stop line ${l.stopAt.toFixed(1)}, node n${l.to.id} ctrl ${l.to.ctrl} role ${arm?.role} signal ${arm && arm.sg >= 0 && l.to.sc >= 0 ? signals.get(l.to.sc, arm.sg) : '-'}` : 'no lane'}, waited ${waited.toFixed(0)} s`;
  }
  return { km: v.odometer / 1000, minutes: t / 60, findings, done, where };
}

const ids = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const list = ids.length ? ids : ['rbl', 'priority', 'signals', 'roundabout', 'rural', 'motorway', 'exam'];
let serious = 0;
for (const id of list) {
  const t0 = Date.now();
  const r = await runLesson(id, 0);
  console.log(`${id}: ${r.done ? 'completed' : 'NOT completed'}, ${r.km.toFixed(2)} km in ${r.minutes.toFixed(1)} sim-min (${((Date.now() - t0) / 1000).toFixed(0)} s wall), ${r.findings.length} findings${r.where}`);
  if (!r.done) serious++;
  for (const f of r.findings) {
    console.log(`   ${f}`);
    if (!f.startsWith('hint')) serious++;
  }
}
console.log(serious === 0 ? 'OK: a law-abiding drive produced no faults' : `${serious} fault(s) reported for a law-abiding drive – investigate`);
