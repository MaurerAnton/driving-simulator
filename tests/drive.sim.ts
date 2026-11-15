// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A virtual learner driver on the real map (headless, no rendering):
 *
 *   node tests/drive.sim.ts [lessonId ...]
 *
 * It follows the navigation of each lesson with the real vehicle model and
 * obeys the rules it can perceive: speed limits, traffic lights, stop signs,
 * indicators, shoulder checks.  A law-abiding drive must produce no serious
 * findings – every one reported here is either a bug in the rule monitor or
 * in the map data, and worth looking at.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { LESSONS, Navigator, findTarget } from '../src/game/nav.ts';
import { WorldGround } from '../src/sim/ground.ts';
import { RuleMonitor } from '../src/sim/rules.ts';
import { SIG, SignalSystem } from '../src/sim/signals.ts';
import { Traffic } from '../src/sim/traffic.ts';
import { COMPACT_CAR_AUTOMATIC, Vehicle } from '../src/sim/vehicle/index.ts';
import { newPolySample, projectOnPolyline, samplePolyline } from '../src/core/geom.ts';
import { LaneGraph, TURN, lanePoint } from '../src/world/lanes.ts';
import type { Connector, Lane } from '../src/world/lanes.ts';
import { tileKey, unpackTile } from '../src/world/tilefmt.ts';
import { CTRL, EF, ROLE } from '../src/world/types.ts';
import type { WorldJson } from '../src/world/types.ts';
import { World, newSurfaceHit } from '../src/world/world.ts';

const root = new URL('../public/map/', import.meta.url);
const json = JSON.parse(readFileSync(new URL('world.json', root), 'utf8')) as WorldJson;
const world = new World(json);
const graph = new LaneGraph(world);

/** Terrain straight from the tile files. */
const tileCache = new Map<string, { h: Float32Array; n: number; cov: Uint8Array; cn: number } | null>();
const terrain = {
  tile(x: number, z: number) {
    const { minX, minZ, tileSize } = json.meta;
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
    const i = Math.min(t.n - 2, Math.floor(fx * (t.n - 1)));
    const j = Math.min(t.n - 2, Math.floor(fz * (t.n - 1)));
    return t.h[j * t.n + i];
  },
  coverAt(x: number, z: number): number {
    const { t, fx, fz } = this.tile(x, z);
    if (!t) return 0;
    return t.cov[Math.min(t.cn - 1, Math.floor(fz * t.cn)) * t.cn + Math.min(t.cn - 1, Math.floor(fx * t.cn))];
  },
};

const DT = 1 / 120;
const smp = newPolySample();
const hit = newSurfaceHit();

function runLesson(id: string, spawnIdx: number, obey = true): { km: number; minutes: number; findings: string[]; done: boolean } {
  const lesson = LESSONS.find((l) => l.id === id)!;
  const signals = new SignalSystem(world.signals);
  const traffic = new Traffic(world, graph, signals);
  traffic.targetCount = 0;
  const rules = new RuleMonitor(world, graph, signals, traffic);
  rules.strict = true;
  const nav = new Navigator(graph);
  const ground = new WorldGround(world, terrain);
  const v = new Vehicle(COMPACT_CAR_AUTOMATIC, ground);
  const sp = json.spawns[spawnIdx];
  const ty = terrain.heightAt(sp.x, sp.z);
  const y0 = world.surfaceAt(sp.x, sp.z, ty + 3, hit) ? hit.y : ty;
  v.teleport(sp.x, y0 + 0.02, sp.z, sp.yaw);
  v.resetDrivetrain(true);
  const mpos = new Float64Array(3);
  let targetIdx = 0;
  let home: Lane['edge'] | null = null;
  const visited = new Set<Lane['edge']>();
  let indicator = 0;
  let look = 0;
  let stoppedFor = 0;
  let t = 0;
  let done = false;
  let stuck = 0;
  let lastTurn = 0;
  let lastNext: Connector | null = null;
  const proj = { s: 0, off: 0, d2: 0, seg: 0 };
  const maxT = 60 * 40;
  while (t < maxT && !done) {
    v.getModelPosition(mpos);
    const lane = (rules as unknown as { lane: Lane | null }).lane;
    const laneS = (rules as unknown as { laneS: number }).laneS;
    // --- navigation ---
    if (lane) {
      if (!home) home = lane.edge;
      if (!nav.goal) {
        const goal = findTarget(world, graph, lesson.targets[targetIdx], mpos[0], mpos[2], lane, home, visited);
        if (!goal) {
          targetIdx++;
          if (targetIdx >= lesson.targets.length) done = true;
          continue;
        }
        visited.add(goal);
        nav.setGoal(goal, lane);
      }
      const h = nav.update(DT, lane, laneS, mpos[0], mpos[2]);
      rules.allowed = new Set(nav.routeLanes.map((l) => l.edge));
      if (h.done) {
        targetIdx++;
        nav.clear();
        if (targetIdx >= lesson.targets.length) done = true;
      }
    }
    // --- path: current lane, then the route's connectors ---
    const route = nav.route ?? [];
    let next: Connector | null = null;
    if (lane) next = route.find((c) => c.from === lane) ?? (lane.out.length === 1 ? lane.out[0] : null);
    if (next) lastNext = next;
    else if (!lane) next = lastNext;
    // pure pursuit target point: lookahead along lane → connector → next lane
    const speed = Math.max(0, v.speed);
    // look less far ahead in tight turns so the corner is not cut
    const tight = next !== null && next.turn !== TURN.STRAIGHT && next.len < 25;
    const la = tight ? 2.6 + speed * 0.45 : 5 + speed * 0.9;
    let tx = mpos[0] - Math.sin(v.yaw) * 5;
    let tz = mpos[2] - Math.cos(v.yaw) * 5;
    let limit = 8;
    let distToLine = Infinity;
    let mustStop = false;
    let crossStop = false;
    let turn = 0;
    // inside a junction the monitor's lane position is frozen: measure along the connector instead
    const inJunction = world.surfaceAt(mpos[0], mpos[2], mpos[1] + 0.6, hit) && hit.node !== null && hit.node.arms.length > 1;
    if ((inJunction || !lane) && next) {
      projectOnPolyline(next.pl, mpos[0], mpos[2], proj);
      const sj = proj.s + la;
      if (sj <= next.len) samplePolyline(next.pl, sj, smp);
      else lanePoint(next.to, Math.min(next.to.len, sj - next.len), smp);
      tx = smp.x;
      tz = smp.z;
      limit = next.turn === TURN.STRAIGHT ? Math.min(Number.isFinite(next.to.limit) ? next.to.limit : 36, 14) : 4.5;
      turn = lastTurn;
    } else if (lane) {
      const centre = laneS - 2.14;
      limit = Number.isFinite(lane.limit) ? lane.limit : 36;
      if (lane.edge.zone === 7) limit = 1.7;
      if (lane.edge.cls >= 13) limit = Math.min(limit, 6);
      let s = centre + la;
      if (s <= lane.len) {
        lanePoint(lane, s, smp);
        tx = smp.x;
        tz = smp.z;
      } else if (next) {
        s -= lane.len;
        if (s <= next.len) samplePolyline(next.pl, s, smp);
        else lanePoint(next.to, Math.min(next.to.len, s - next.len), smp);
        tx = smp.x;
        tz = smp.z;
      }
      distToLine = lane.stopAt - laneS;
      const node = lane.to;
      const arm = lane.armTo;
      if (next && node.arms.length > 2) {
        turn = next.turn === TURN.LEFT ? -1 : next.turn === TURN.RIGHT ? 1 : 0;
        // roundabout: indicate right only when leaving
        const ring = (lane.edge.flags & EF.ROUNDABOUT) !== 0;
        if (node.ctrl === CTRL.ROUNDABOUT) turn = ring && !(next.to.edge.flags & EF.ROUNDABOUT) ? 1 : 0;
        if (obey && arm.sg >= 0 && node.sc >= 0) {
          const st = signals.get(node.sc, arm.sg);
          if (st === SIG.RED || st === SIG.RED_AMBER) mustStop = true;
          if (st === SIG.AMBER && (speed * speed) / (2 * Math.max(distToLine, 0.5)) < 3) mustStop = distToLine > 0;
        } else if (obey && arm.role === ROLE.STOP && stoppedFor < 1) mustStop = true;
        // slow down for the turn
        if (next.turn !== TURN.STRAIGHT && distToLine < 45) limit = Math.min(limit, 4.5 + Math.max(0, distToLine) * 0.12);
        else if (arm.role !== ROLE.PRIORITY && distToLine < 30) limit = Math.min(limit, 7);
      }
      // the junction after the next (short lanes in between): be able to stop there, too
      if (obey && next && !mustStop) {
        const l2 = next.to;
        const d2 = lane.len - laneS + next.len + l2.stopAt;
        const a2 = l2.armTo;
        if (d2 < 70 && l2.to.arms.length > 2 && ((a2.sg >= 0 && l2.to.sc >= 0 && signals.get(l2.to.sc, a2.sg) !== SIG.GREEN) || a2.role === ROLE.STOP)) {
          limit = Math.min(limit, Math.sqrt(2 * 2.0 * Math.max(d2 - 2, 0.5)));
        }
      }
      // pedestrian lights between junctions
      if (obey) {
        for (const c of world.crossings) {
          if (c.e !== lane.edge.id || c.sc === undefined) continue;
          const pos = lane.dir > 0 ? c.s - lane.s0 : lane.s0 - c.s;
          const d = pos - c.w / 2 - laneS;
          if (d < -0.5 || d > 70) continue;
          const st = signals.get(c.sc, c.g ?? 0);
          if (st === SIG.RED || st === SIG.RED_AMBER || (st === SIG.AMBER && (speed * speed) / (2 * Math.max(d, 0.5)) < 3)) {
            const dd = Math.max(0, d - 1.5);
            limit = Math.min(limit, Math.sqrt(2 * 2.2 * dd));
            if (dd < 0.6) crossStop = true;
          }
        }
      }
      if (distToLine > 45 || distToLine < -3) turn = 0;
      lastTurn = turn;
    } else {
      // inside a junction or off the lane: keep following the last planned connector
      limit = 5;
    }
    indicator = turn;
    look = turn !== 0 && distToLine < 25 ? (turn < 0 ? 1.6 : -1.6) : 0;
    // --- controls ---
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    const dx = tx - mpos[0];
    const dz = tz - mpos[2];
    const lat = dx * Math.cos(v.yaw) - dz * Math.sin(v.yaw); // + = target to the right
    const fwd = dx * fx + dz * fz;
    const curv = (2 * lat) / Math.max(dx * dx + dz * dz, 1);
    const steer = Math.max(-1, Math.min(1, (Math.atan(2.63 * curv) / 0.576) * (fwd > 0 ? 1 : 3)));
    // keep the lateral acceleration comfortable
    const vCurve = Math.sqrt(2.2 / Math.max(Math.abs(curv), 0.002));
    let target = Math.min(limit * 0.94, vCurve);
    let brake = 0;
    if (mustStop && distToLine > -1) {
      const d = Math.max(0, distToLine - 1.2);
      target = Math.min(target, Math.sqrt(2 * 2.2 * d));
      if (d < 0.6) {
        target = 0;
        brake = 0.5;
      }
    }
    if (crossStop) {
      target = 0;
      brake = 0.5;
    }
    if (v.speed < 0.15 && mustStop && distToLine < 4) stoppedFor += DT;
    else if (!mustStop && distToLine > 12) stoppedFor = 0;
    let throttle = 0;
    const err = target - v.speed;
    if (err > 0) throttle = Math.min(0.6, err * 0.35);
    else brake = Math.max(brake, Math.min(0.8, -err * 0.3));
    v.step(DT, { steer, throttle: brake > 0 ? 0 : throttle, brake, clutch: 0, handbrake: 0, gear: 1, ignition: true, starter: false });
    signals.update(DT);
    v.getModelPosition(mpos);
    rules.update(DT, { x: mpos[0], y: mpos[1], z: mpos[2], yaw: v.yaw, speed: v.speed, indicator, hazard: false, lookYaw: look, seatbelt: true, handbrake: 0, stalled: false, hitScenery: 0, length: 4.28 }, []);
    if (process.env.DRIVE_DEBUG && t < Number(process.env.DRIVE_DEBUG) && t > Number(process.env.DRIVE_FROM ?? 0) && Math.abs(t * 2 - Math.round(t * 2)) < DT) {
      const armD = lane ? lane.armTo : null;
      console.log(`   arm role=${armD?.role} sg=${armD?.sg} sc=${lane?.to.sc} ctrl=${lane?.to.ctrl} sig=${armD && armD.sg >= 0 && lane!.to.sc >= 0 ? signals.get(lane!.to.sc, armD.sg) : '-'} dist=${distToLine.toFixed(1)} mustStop=${mustStop} cross=${crossStop} stopAt=${lane?.stopAt.toFixed(1)}`);
      const on = world.surfaceAt(mpos[0], mpos[2], mpos[1] + 0.6, hit);
      console.log(`t=${t.toFixed(1)} pos=(${mpos[0].toFixed(1)},${mpos[2].toFixed(1)},${mpos[1].toFixed(2)}) v=${v.speed.toFixed(1)} yaw=${v.yaw.toFixed(2)} lane=${lane ? `${lane.id}/e${lane.edge.id} s=${laneS.toFixed(1)}/${lane.len.toFixed(1)}` : '-'} surf=${on ? (hit.node ? `node${hit.node.id}` : `e${hit.edge!.id} z${hit.zone} off=${hit.off.toFixed(1)}`) : 'NONE'} next=${next ? `c${next.id} turn${next.turn} len=${next.len.toFixed(1)}→e${next.to.edge.id}` : '-'} tgt=(${tx.toFixed(1)},${tz.toFixed(1)}) steer=${steer.toFixed(2)} thr=${throttle.toFixed(2)} brk=${brake.toFixed(2)} lim=${limit.toFixed(1)}`);
    }
    t += DT;
    stuck = Math.abs(v.speed) < 0.1 && !mustStop && !crossStop ? stuck + DT : 0;
    if (stuck > 25) break;
  }
  const findings = rules.log.map((f) => `${f.severity}:${f.id}@(${f.x.toFixed(0)},${f.z.toFixed(0)}) t=${f.time.toFixed(0)}s ${JSON.stringify(f.data)}`);
  return { km: v.odometer / 1000, minutes: t / 60, findings, done };
}

const ids = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const list = ids.length ? ids : ['rbl', 'priority', 'signals', 'roundabout', 'rural', 'motorway', 'exam'];
let serious = 0;
for (const id of list) {
  const t0 = Date.now();
  const r = runLesson(id, 0);
  console.log(`${id}: ${r.done ? 'completed' : 'NOT completed'}, ${r.km.toFixed(2)} km in ${r.minutes.toFixed(1)} sim-min (${((Date.now() - t0) / 1000).toFixed(0)} s wall), ${r.findings.length} findings`);
  for (const f of r.findings) {
    console.log(`   ${f}`);
    if (!f.startsWith('hint')) serious++;
  }
}
console.log(serious === 0 ? 'OK: a law-abiding drive produced no faults' : `${serious} fault(s) reported for a law-abiding drive – investigate`);
