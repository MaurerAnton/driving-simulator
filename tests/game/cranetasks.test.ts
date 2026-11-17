// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The work with a crane on the construction site (src/game/cranetasks.ts):
 * the site's layout (nothing lies in anything else, every load and every
 * place within its crane's reach and load chart), the guided start step by
 * step, the judging of a task, the faults told – and a whole task done with
 * the real tower crane (src/sim/crane.ts) by a simple automatic operator.
 *
 *   node --test tests/game/cranetasks.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { YardFrame } from '../../src/game/ce.ts';
import { BUILDING, CraneTasks, DELIVERY, GUIDE, LOAD_DEFS, OFFICES, PLANS, SITE_LOADS, STANDS, TOWER_SITE, inZone, loadFootprint, scoreTask, siteWorld, yawOff } from '../../src/game/cranetasks.ts';
import type { CraneSnapshot, SiteRect, WorldLoad } from '../../src/game/cranetasks.ts';
import { Crane, LOADER_CRANE, LOADER_GEOMETRY, MOBILE_CRANE, TOWER_CRANE, boomDir, capacity, towerCapacity } from '../../src/sim/crane.ts';
import type { Box3, CraneEvents, CraneType, CraneWorld, Lmi } from '../../src/sim/crane.ts';

const YARD = { x: 5665, z: -455, len: 150, wid: 66, rot: 0 };
const flat = (): number => 0;

/** a rectangle of the site in the plan, its half-sizes along u and w for a load of a kind turned by yaw */
function rectOf(u: number, w: number, hu: number, hw: number): SiteRect {
  return { u0: u - hu, u1: u + hu, w0: w - hw, w1: w + hw };
}

const overlap = (a: SiteRect, b: SiteRect, gap = 0): boolean => a.u0 < b.u1 + gap && b.u0 < a.u1 + gap && a.w0 < b.w1 + gap && b.w0 < a.w1 + gap;

/** where each crane's slewing axis is on the site (u, w), working from its stand – the tower crane from its base */
function axisOf(type: CraneType): [number, number] {
  if (type === 'tower') return [TOWER_SITE.u, TOWER_SITE.w];
  const st = STANDS[type].pose;
  // (facing along +u: the carrier's z, backwards, is −u)
  const z = type === 'mobile' ? MOBILE_CRANE.slewZ : LOADER_CRANE.slewZ;
  return [st.u - z, st.w];
}

test('the site: nothing lies in anything else – the loads, the places they go, the building, the tower crane, the truck, the offices', () => {
  const solids: Array<[string, SiteRect]> = [
    ['building', BUILDING],
    ['scaffold S', BUILDING.scaffold[0]],
    ['scaffold E', BUILDING.scaffold[1]],
    ['tower crane', rectOf(TOWER_SITE.u, TOWER_SITE.w, TOWER_SITE.base, TOWER_SITE.base)],
    ['truck', { u0: DELIVERY.bed.u0, u1: DELIVERY.cab.u1, w0: DELIVERY.cab.w0, w1: DELIVERY.cab.w1 }],
    ...OFFICES.map((o, i): [string, SiteRect] => [`office ${i}`, o]),
  ];
  const things: Array<[string, SiteRect, CraneType | 'site']> = [];
  for (const type of ['tower', 'mobile', 'loader'] as CraneType[]) {
    for (const l of PLANS[type].loads) {
      if (l.bed) continue;
      const def = LOAD_DEFS[l.kind];
      things.push([`${type} load ${l.id}`, rectOf(l.u, l.w, def.hx, def.hz), type]);
    }
    for (const t of PLANS[type].tasks) {
      const z = PLANS[type].zones.find((x) => x.id === t.zone)!;
      if (z.y !== 'ground' || z.bed) continue;
      const def = LOAD_DEFS[PLANS[type].loads.find((x) => x.id === t.load)!.kind];
      things.push([`${type} place ${z.id}`, rectOf(z.u, z.w, def.hx + z.hu, def.hz + z.hw), type]);
    }
  }
  for (const l of SITE_LOADS) things.push([`load ${l.id}`, rectOf(l.u, l.w, LOAD_DEFS[l.kind].hx, LOAD_DEFS[l.kind].hz), 'site']);
  for (const [name, r] of things) {
    for (const [sname, s] of solids) assert.ok(!overlap(r, s), `${name} lies in the ${sname}`);
    // (within the yard)
    assert.ok(r.u0 > -YARD.len / 2 && r.u1 < YARD.len / 2 && r.w0 > -YARD.wid / 2 && r.w1 < YARD.wid / 2, `${name} beyond the yard`);
  }
  for (let i = 0; i < things.length; i++) {
    for (let j = i + 1; j < things.length; j++) {
      const [a, ra, ta] = things[i];
      const [b, rb, tb] = things[j];
      // (a crane's own loads and places may not meet; other cranes' loads lie about for good)
      if (ta !== tb && ta !== 'site' && tb !== 'site') continue;
      assert.ok(!overlap(ra, rb, 0.1), `${a} and ${b} lie in each other`);
    }
  }
  // the stands lie clear of everything
  for (const [type, st] of Object.entries(STANDS)) for (const [sname, s] of solids) assert.ok(!overlap(st.area, s), `the ${type} stand lies in the ${sname}`);
});

test("every task: its load and its place within its crane's reach – and within its load chart, with room to spare", () => {
  for (const type of ['tower', 'mobile', 'loader'] as CraneType[]) {
    const plan = PLANS[type];
    const [au, aw] = axisOf(type);
    const spec = type === 'tower' ? TOWER_CRANE : type === 'mobile' ? MOBILE_CRANE : LOADER_CRANE;
    const ids = new Set(plan.loads.map((l) => l.id));
    assert.equal(ids.size, plan.loads.length, `${type}: loads named once`);
    for (const t of plan.tasks) {
      const l = plan.loads.find((x) => x.id === t.load);
      const z = plan.zones.find((x) => x.id === t.zone);
      assert.ok(l && z, `${type}: ${t.load} → ${t.zone}`);
      const def = LOAD_DEFS[l!.kind];
      const need = (def.t + spec.hook) / 0.95;
      // (a load on the loader's own flatbed: its place there, from the column)
      const radius = (u: number, w: number, bed?: { x: number; z: number }): number => (bed ? Math.hypot(bed.x, bed.z - LOADER_CRANE.slewZ) : Math.hypot(u - au, w - aw));
      for (const [what, r] of [
        ['load', radius(l!.u, l!.w, l!.bed)],
        ['place', radius(z!.u, z!.w, z!.bed)],
      ] as Array<[string, number]>) {
        const cap = type === 'tower' ? towerCapacity(r) : type === 'mobile' ? capacity('mobile', 'full', r, 34) : capacity('loader', 'full', r);
        const reach = type === 'tower' ? 48.5 : type === 'mobile' ? 32 : LOADER_GEOMETRY.pinA + LOADER_GEOMETRY.inner + LOADER_GEOMETRY.outer1;
        assert.ok(r <= reach, `${type} ${t.load}: the ${what} at ${r.toFixed(1)} m is out of reach`);
        assert.ok(cap >= need, `${type} ${t.load} (${def.t} t): the ${what} at ${r.toFixed(1)} m – the chart allows ${cap.toFixed(2)} t`);
      }
    }
    assert.equal(GUIDE[type][GUIDE[type].length - 1], 'release');
  }
});

test('the score of a task: precise, calm, gentle and quick is three stars – a swinging, slow, overloaded one none', () => {
  const best = scoreTask({ time: 60, par: 120, offset: 0.05, swing: 0.2, landing: 0.1, overload: false, hits: 0 });
  assert.equal(best.score, 100);
  assert.equal(best.stars, 3);
  const worst = scoreTask({ time: 400, par: 100, offset: 0.7, swing: 2.5, landing: 1.2, overload: true, hits: 3 });
  assert.equal(worst.score, 0);
  assert.equal(worst.stars, 0);
  const mid = scoreTask({ time: 150, par: 120, offset: 0.25, swing: 0.8, landing: 0.3, overload: false, hits: 0 });
  assert.ok(mid.stars >= 1 && mid.stars <= 2, `${mid.score}`);
});

test('in the world: the site turned with its yard – zones keep their frame, a load turned round lies the same way', () => {
  for (const rot of [0, 1]) {
    const f = new YardFrame({ ...YARD, rot });
    const geo = siteWorld(f, 140);
    assert.ok(geo.solids.every((b) => b.x1 > b.x0 && b.z1 > b.z0 && b.y1 > b.y0));
    const t = new CraneTasks('tower', f, () => 140, 140);
    const zone = t.zones.find((z) => z.id === 'tCont')!;
    const p = inZone(zone, zone.x, zone.z);
    assert.ok(Math.abs(p.du) < 1e-9 && Math.abs(p.dw) < 1e-9);
    // a step along the site's u is a step along the zone's u
    const [x, z] = f.toWorld(24 + 0.5, -12.5);
    const q = inZone(zone, x, z);
    assert.ok(Math.abs(q.du - 0.5) < 1e-9 && Math.abs(q.dw) < 1e-9, `rot ${rot}: ${q.du}, ${q.dw}`);
    const l = t.loads.find((x) => x.id === 'tB1')!;
    assert.equal(l.y, 140, 'the pallet stands on the ground');
  }
  assert.ok(yawOff(0.1, 0.1 + Math.PI) < 1e-9, 'turned round lies the same way');
  assert.ok(Math.abs(yawOff(0, Math.PI / 2) - Math.PI / 2) < 1e-9);
});

// ------------------------------------------------------------------------------------ the guided start

/** a snapshot of a crane at rest, to be changed step by step */
function snapshot(over: Partial<CraneSnapshot> = {}): CraneSnapshot {
  const lmi: Lmi = { load: 0.4, capacity: 10, ratio: 0.04, radius: 8, length: 10, angle: 0, hookHeight: 3, setting: 'tyres', wind: 3, windLimit: 13, incline: 0.1, tipping: 0.1, warn: false, stop: false, notLevel: false, levelGood: 0.3 };
  const events: CraneEvents = { hit: 0, landed: 0, liftedOff: false, cut: false };
  return {
    time: 1,
    vx: 0,
    vz: 0,
    yaw: 0,
    speed: 0,
    handbrake: false,
    operating: false,
    beams: 0,
    padsDown: false,
    onOutriggers: false,
    incline: 0.8,
    stowed: true,
    luff: 0,
    unfolded: false,
    head: { x: 0, y: 3, z: 0 },
    hook: { x: 0, y: 1.5, z: 0 },
    hooked: null,
    resting: false,
    clearance: 1,
    swing: 0,
    lmi,
    events,
    tipped: false,
    ...over,
  };
}

test('the guided start of the mobile crane: drive, park, change over, outriggers, jacks, level, boom up, sling, lift, move, set down, let go', () => {
  const f = new YardFrame(YARD);
  const t = new CraneTasks('mobile', f, flat, 0);
  const st = t.stand!;
  const tg = t.target()!;
  const load = tg.load;
  const zone = tg.zone;
  const seen: string[] = [];
  let time = 1;
  const go = (s: Partial<CraneSnapshot>): void => {
    time += 0.5;
    const ev = t.update(snapshot({ time, ...s }));
    if (ev.stepDone) seen.push(String(t.step));
  };
  // driving towards the stand, not there yet
  go({ vx: st.x - 60, vz: st.z, yaw: st.yaw, speed: 8 });
  assert.equal(t.step, 'drive');
  go({ vx: st.x - 10, vz: st.z, yaw: st.yaw, speed: 3 });
  assert.equal(t.step, 'park');
  // in the stand but turned across it: not parked
  go({ vx: st.x, vz: st.z, yaw: st.yaw + 1, speed: 0, handbrake: true });
  assert.equal(t.step, 'park');
  go({ vx: st.x + 0.5, vz: st.z + 0.3, yaw: st.yaw + 0.05, speed: 0, handbrake: true });
  assert.equal(t.step, 'operate');
  const at = { vx: st.x, vz: st.z, yaw: st.yaw, handbrake: true, operating: true };
  go({ ...at });
  assert.equal(t.step, 'beams');
  go({ ...at, beams: 0.6 });
  assert.equal(t.step, 'beams', 'half out is not enough here');
  go({ ...at, beams: 1 });
  go({ ...at, beams: 1, padsDown: true, onOutriggers: true, incline: 0.7 });
  assert.equal(t.step, 'level');
  go({ ...at, beams: 1, padsDown: true, onOutriggers: true, incline: 0.2 });
  assert.equal(t.step, 'raise');
  const up = { ...at, beams: 1, padsDown: true, onOutriggers: true, incline: 0.2, stowed: false };
  go({ ...up, luff: 35 });
  assert.equal(t.step, 'over');
  go({ ...up, luff: 35, head: { x: load.x + 0.5, y: 15, z: load.z }, hook: { x: load.x + 0.5, y: 8, z: load.z } });
  assert.equal(t.step, 'lower');
  const top = load.y + 2 * load.def.hy;
  go({ ...up, luff: 35, head: { x: load.x, y: 15, z: load.z }, hook: { x: load.x, y: top + 1.6, z: load.z }, resting: true, clearance: 0 });
  assert.equal(t.step, 'attach');
  load.hooked = true;
  go({ ...up, luff: 35, head: { x: load.x, y: 15, z: load.z }, hook: { x: load.x, y: top + 2.8, z: load.z }, hooked: load.id, resting: true });
  assert.equal(t.step, 'lift');
  go({ ...up, luff: 35, head: { x: load.x, y: 15, z: load.z }, hook: { x: load.x, y: top + 5, z: load.z }, hooked: load.id, resting: false, clearance: 2, swing: 0.4 });
  assert.equal(t.step, 'move');
  go({ ...up, luff: 35, head: { x: zone.x, y: 15, z: zone.z }, hook: { x: zone.x + 1, y: 6, z: zone.z }, hooked: load.id, clearance: 2, swing: 0.9 });
  assert.equal(t.step, 'setDown');
  go({ ...up, luff: 35, head: { x: zone.x, y: 15, z: zone.z }, hook: { x: zone.x + 0.1, y: 4, z: zone.z }, hooked: load.id, resting: true, clearance: 0, events: { hit: 0, landed: 0.22, liftedOff: false, cut: false } });
  assert.equal(t.step, 'release');
  // let go on the mark
  load.hooked = false;
  load.x = zone.x + 0.1;
  load.z = zone.z;
  const ev = t.update(snapshot({ ...up, time: time + 1, hook: { x: zone.x, y: 4, z: zone.z } }));
  assert.ok(ev.taskDone, 'the guided task is done');
  assert.equal(t.stage, 'tasks');
  assert.equal(t.task, 1);
  const r = t.results[0];
  assert.ok(Math.abs(r.offset - 0.1) < 1e-9 && Math.abs(r.swing - 0.9) < 1e-9 && Math.abs(r.landing - 0.22) < 1e-9, JSON.stringify(r));
  assert.deepEqual(seen, ['park', 'operate', 'beams', 'jacks', 'level', 'raise', 'over', 'lower', 'attach', 'lift', 'move', 'setDown', 'release']);
});

test('the tasks after the guide: on the truck the load must lie on its bed, not beside it; the faults are told once in a while', () => {
  const f = new YardFrame(YARD);
  const t = new CraneTasks('mobile', f, flat, 0);
  // the guide's task is done
  const g = t.target()!;
  g.load.x = g.zone.x;
  g.load.z = g.zone.z;
  t.update(snapshot({ time: 2 }));
  assert.equal(t.stage, 'tasks');
  const { load, zone } = t.target()!;
  assert.equal(zone.id, 'mTruck');
  // set down beside the truck, on the ground: not done
  load.x = zone.x;
  load.z = zone.z;
  load.y = 0;
  assert.ok(!t.inPlace(load, zone));
  t.update(snapshot({ time: 3 }));
  assert.equal(t.task, 1);
  // on its bed
  load.y = zone.y;
  assert.ok(t.inPlace(load, zone));
  // the faults: an overload cut-off with the load on, a hit, a hard landing – each told, and not again at once
  load.y = 0;
  const ev = t.update(snapshot({ time: 4, hooked: load.id, operating: true, lmi: { ...snapshot().lmi, stop: true, ratio: 1.04 }, events: { hit: 0.6, landed: 0.7, liftedOff: false, cut: true } }));
  const ids = ev.faults.map((x) => x.id).sort();
  assert.deepEqual(ids, ['craneHardLanding', 'craneLoadHit', 'craneOverload']);
  const again = t.update(snapshot({ time: 4.5, hooked: load.id, operating: true, lmi: { ...snapshot().lmi, stop: true, ratio: 1.04 }, events: { hit: 0.6, landed: 0, liftedOff: false, cut: true } }));
  assert.equal(again.faults.length, 0, 'not told again at once');
  // a load lifted with the hook off its middle is pulled at an angle
  const ev2 = t.update(snapshot({ time: 20, hooked: load.id, operating: true, head: { x: 3, y: 10, z: 0 }, hook: { x: 0, y: 4, z: 0 }, events: { hit: 0, landed: 0, liftedOff: true, cut: false } }));
  assert.deepEqual(ev2.faults.map((x) => x.id), ['craneDiagonalPull']);
});

test("which load the hook can take: its crane's own, the hook low over its middle", () => {
  const f = new YardFrame(YARD);
  const t = new CraneTasks('tower', f, flat, 0);
  const l = t.loads.find((x) => x.id === 'tB2')!;
  const top = l.y + 2 * l.def.hy;
  const drop = TOWER_CRANE.hookDrop;
  assert.equal(t.reachable({ x: l.x + 0.3, y: top + drop + 0.2, z: l.z }, drop)?.id, 'tB2');
  assert.equal(t.reachable({ x: l.x + 0.3, y: top + drop + 3, z: l.z }, drop), null, 'too high above it');
  assert.equal(t.reachable({ x: l.x + 2, y: top + drop + 0.2, z: l.z }, drop), null, 'beside it');
  const fixed = t.loads.find((x) => x.fixed)!;
  assert.equal(t.reachable({ x: fixed.x, y: fixed.y + 2 * fixed.def.hy + drop, z: fixed.z }, drop), null, 'nobody\'s to move');
});

// ------------------------------------------------------------------------------------ a whole task with the real crane

/** The world round the crane as the game makes it (game/craneplay.ts): the site's slabs and solids, the loads lying about. */
function siteCraneWorld(geo: ReturnType<typeof siteWorld>, loads: readonly WorldLoad[]): CraneWorld {
  const wind = { x: 0, z: 0, gust: 1 };
  return {
    floor: (x, z, hx, hz, y) => {
      let best = 0;
      for (const p of geo.platforms) if (p.y <= y + 0.05 && p.y > best && !(x + hx <= p.x0 || x - hx >= p.x1 || z + hz <= p.z0 || z - hz >= p.z1)) best = p.y;
      for (const l of loads) {
        if (l.hooked) continue;
        const t = l.y + 2 * l.def.hy;
        const [fx, fz] = loadFootprint(l.def, l.yaw);
        if (t <= y + 0.05 && t > best && !(x + hx <= l.x - fx || x - hx >= l.x + fx || z + hz <= l.z - fz || z - hz >= l.z + fz)) best = t;
      }
      return best;
    },
    boxes: () => {
      const out: Box3[] = [...geo.solids];
      for (const l of loads) {
        if (l.hooked) continue;
        const [fx, fz] = loadFootprint(l.def, l.yaw);
        out.push({ x0: l.x - fx, x1: l.x + fx, z0: l.z - fz, z1: l.z + fz, y0: l.y, y1: l.y + 2 * l.def.hy });
      }
      return out;
    },
    ground: flat,
    wind: () => wind,
  };
}

test('a whole task with the tower crane: over the pallet, slung, lifted, carried, set down on its mark – judged', () => {
  const f = new YardFrame(YARD);
  const tasks = new CraneTasks('tower', f, flat, 0);
  const geo = siteWorld(f, 0);
  const world = siteCraneWorld(geo, tasks.loads);
  const c = new Crane('tower');
  const [bx, bz] = f.toWorld(TOWER_SITE.u, TOWER_SITE.w);
  c.place(bx, 0, bz, f.yawToWorld(TOWER_SITE.yaw));
  const { load, zone } = tasks.target()!;
  const DT = 1 / 240;
  let time = 0;
  const events: CraneEvents = { hit: 0, landed: 0, liftedOff: false, cut: false };
  /** steer the crane's head to (x, z) and its hook to height y – gently, as an operator would */
  const steer = (x: number, z: number, y: number): number => {
    const [cx, cz] = c.toCarrier(x, z);
    const slew = Math.atan2(-cx, -cz);
    let ds = slew - c.q.slew;
    ds -= Math.PI * 2 * Math.round(ds / (Math.PI * 2));
    const r = Math.hypot(cx, cz);
    c.cmd.slew = Math.max(-1, Math.min(1, ds / 0.3));
    c.cmd.boom = Math.max(-1, Math.min(1, (r - c.q.trolley) / 4));
    c.cmd.hoist = Math.max(-1, Math.min(1, (y - c.hook.y) / 2));
    return Math.hypot(c.head.x - x, c.head.z - z);
  };
  const snap = (): CraneSnapshot =>
    snapshot({ time, operating: true, stowed: false, head: { x: c.head.x, y: c.head.y, z: c.head.z }, hook: { x: c.hook.x, y: c.hook.y, z: c.hook.z }, hooked: c.load?.id ?? null, resting: c.resting, clearance: c.clearance, swing: c.swing, lmi: c.lmi, events, tipped: c.tipped !== null });
  const step = (): void => {
    c.step(DT, world);
    time += DT;
    events.hit = Math.max(events.hit, c.events.hit);
    events.landed = Math.max(events.landed, c.events.landed);
    events.liftedOff ||= c.events.liftedOff;
    events.cut ||= c.events.cut;
    if (c.load) {
      load.x = c.hook.x;
      load.z = c.hook.z;
      load.y = c.hook.y - c.drop();
    }
    // (the work looks a few times a second, as the game's frames do)
    if (Math.round(time / DT) % 8 === 0) {
      tasks.update(snap());
      events.hit = 0;
      events.landed = 0;
      events.liftedOff = false;
      events.cut = false;
    }
  };
  const until = (seconds: number, done: () => boolean): boolean => {
    for (let i = 0; i < seconds / DT; i++) {
      step();
      if (done()) return true;
    }
    return false;
  };
  const top = load.y + 2 * load.def.hy;
  /** the hook hangs still: near its plumb line and hardly moving across it (not just passing through it) */
  const calm = (off: number): boolean => c.swing < off && Math.hypot(c.hook.vx - c.head.vx, c.hook.vz - c.head.vz) < 0.06;
  // over the pallet, the hook high, then calm
  assert.ok(until(300, () => steer(load.x, load.z, 14) < 0.15 && calm(0.15) && Math.abs(c.v.slew) < 0.003));
  // down onto it, creeping at the end
  assert.ok(until(120, () => (steer(load.x, load.z, top - 1) , tasks.reachable(c.hook, TOWER_CRANE.hookDrop) !== null && c.hook.y - TOWER_CRANE.hookDrop - top < 0.3)));
  c.cmd.hoist = 0;
  until(1, () => false);
  const l = tasks.reachable(c.hook, TOWER_CRANE.hookDrop);
  assert.equal(l?.id, load.id, 'the hook can take the pallet');
  load.hooked = true;
  c.attach({ id: load.id, t: load.def.t, hx: load.def.hx, hy: load.def.hy, hz: load.def.hz, sling: load.def.sling, yaw: load.yaw, area: load.def.area }, load.x, top, load.z);
  // up to a safe height, over the mark, let the swing settle, down onto it
  assert.ok(until(120, () => (steer(load.x, load.z, 12), c.hook.y > 11.5)), 'lifted');
  assert.ok(until(400, () => steer(zone.x, zone.z, 12) < 0.12 && calm(0.12) && Math.abs(c.v.slew) < 0.003 && Math.abs(c.v.trolley) < 0.02), `carried over the mark (${Math.hypot(c.head.x - zone.x, c.head.z - zone.z).toFixed(2)} m, swing ${c.swing.toFixed(2)})`);
  assert.ok(until(200, () => (steer(zone.x, zone.z, -5), c.resting)), 'set down');
  // (standing: hands off the slewing and the trolley, only the rope paid out until the slings go slack)
  c.cmd.slew = 0;
  c.cmd.boom = 0;
  c.cmd.hoist = -0.3;
  until(6, () => c.slack > 0.05);
  c.cmd.hoist = 0;
  assert.ok(c.tension < 0.3 * load.def.t * 9.81, 'the slings slack');
  // let go: the load stands where it was set down
  load.x = c.hook.x;
  load.z = c.hook.z;
  load.y = c.hook.y - c.drop();
  c.release();
  load.hooked = false;
  until(2, () => tasks.results.length > 0);
  assert.equal(tasks.results.length, 1, 'judged');
  const r = tasks.results[0];
  assert.ok(r.offset < 0.4, `set down ${(r.offset * 100).toFixed(0)} cm off the mark`);
  assert.ok(r.hits === 0 && !r.overload, `nothing hit (${r.hits}), not overloaded`);
  assert.ok(r.stars >= 1, `a fair score: ${r.score} (${r.stars} stars), ${r.time.toFixed(0)} s, swing ${r.swing.toFixed(2)} m, landing ${r.landing.toFixed(2)} m/s`);
  assert.equal(tasks.stage, 'tasks');
  // (the pallet stands on the ground of its mark)
  assert.ok(Math.abs(load.y) < 0.02);
  void boomDir;
});
