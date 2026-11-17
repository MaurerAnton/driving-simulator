// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The theory lessons: every script on its place – the places fit on the
 * practice yard, the vehicles keep to the asphalt, nobody touches anybody,
 * nobody drives backwards or brakes like a wall; at each question the
 * actors it is about are there, and afterwards the scene plays out the
 * answer – whoever goes first really is first through the place both use.
 * Some rules checked on their own (the zebra, the school bus, the gap to
 * the cyclist, the indicator in the roundabout, the green arrow, the zip),
 * the texts, and how a run of a lesson stops, is answered and goes on.
 *
 *   node --test tests/game/theory.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import en from '../../src/i18n/en.ts';
import { THEORY, TheoryRun, actorName, allTheoryKeys, answerKey, blinkAt, corners, lightAt, markAt, newPose, outlinesTouch, poseAt, prepare, progressAt, sideAt } from '../../src/game/theory.ts';
import type { ActorRun, LessonDef, Pose, Scene } from '../../src/game/theory.ts';
import { covers, lanePath, pathPoint, newPathPoint } from '../../src/game/theorystage.ts';

const DT = 0.05;
const scenes = new Map<string, Scene>(THEORY.map((l) => [l.id, prepare(l)]));
const sceneOf = (id: string): Scene => scenes.get(id) as Scene;
const actor = (s: Scene, id: string): ActorRun => s.actors.find((a) => a.def.id === id) as ActorRun;
const pose = (r: ActorRun, t: number): Pose => poseAt(r, t, newPose());
const isPerson = (r: ActorRun): boolean => r.def.kind === 'person' || r.def.kind === 'child';

/** Every moment of a lesson, a step of DT apart. */
function times(l: LessonDef, from = 0): number[] {
  const out: number[] = [];
  for (let t = from; t <= l.end + 1e-9; t += DT) out.push(t);
  return out;
}

test('there are about a dozen lessons, each with its texts, steps and a rule', () => {
  assert.ok(THEORY.length >= 10 && THEORY.length <= 16, `${THEORY.length} lessons`);
  assert.equal(new Set(THEORY.map((l) => l.id)).size, THEORY.length, 'no lesson twice');
  for (const key of allTheoryKeys()) assert.ok(en[key], `missing text ${key}`);
  for (const key of ['theory.title', 'theory.desc', 'theory.listText', 'theory.loading', 'theory.help', 'theory.right', 'theory.wrong', 'theory.goOn', 'theory.again', 'theory.next', 'theory.list', 'theory.done', 'theory.score', 'theory.who.me']) assert.ok(en[key], `missing text ${key}`);
  assert.ok(en['theory.score'].includes('{right}') && en['theory.score'].includes('{count}'));
  for (const l of THEORY) {
    assert.ok(l.steps.length >= 1 && l.steps.length <= 3, `${l.id}: one to three questions`);
    let last = 0;
    l.steps.forEach((s, i) => {
      assert.ok(s.at > last && s.at < l.end, `${l.id} step ${i + 1}: in order, before the end`);
      last = s.at;
      assert.ok(s.answers.includes(s.right), `${l.id} step ${i + 1}: the right answer is offered`);
      assert.ok(s.answers.length >= 2, `${l.id} step ${i + 1}: a choice`);
      assert.match(s.ref, /(§ \d+|Anlage \d+) .*StVO|StVO/, `${l.id} step ${i + 1}: names the rule`);
      for (const a of s.answers) assert.ok(en[answerKey(l, i + 1, a)], `${l.id} step ${i + 1}: text of answer ${a}`);
      if (s.blind) assert.ok(l.actors.some((x) => x.id === s.blind));
    });
    assert.ok(l.actors.some((a) => a.kind === 'me'), `${l.id}: you are in it`);
    assert.equal(new Set(l.actors.map((a) => a.id)).size, l.actors.length, `${l.id}: actors by distinct names`);
  }
});

test('marks of a path: by name, ± metres, or plain metres', () => {
  const p = lanePath(0, 50, -50, { line: 40 });
  assert.equal(markAt(p, 'line'), 40);
  assert.equal(markAt(p, 'line-12'), 28);
  assert.equal(markAt(p, 'line+2.5'), 42.5);
  assert.equal(markAt(p, 'end'), 100);
  assert.equal(markAt(p, 17), 17);
  assert.throws(() => markAt(p, 'nowhere+3'));
  const r = sceneOf('roundabout');
  assert.ok(markAt(actor(r, 'me').path, 'pass:E+2') > markAt(actor(r, 'me').path, 'ring'));
});

test('a script passes through its keys: their places and speeds, smoothly; on at the last speed after the last', () => {
  for (const s of scenes.values()) {
    for (const r of s.actors) {
      const prog = { s: 0, v: 0, a: 0, started: false };
      for (const k of r.keys) {
        progressAt(r.keys, k.t, prog);
        assert.ok(Math.abs(prog.s - k.s) < 1e-6 && Math.abs(prog.v - k.v) < 1e-6, `${s.lesson.id}/${r.def.id} at ${k.t}`);
      }
      for (let i = 1; i < r.keys.length; i++) assert.ok(r.keys[i].t > r.keys[i - 1].t, `${s.lesson.id}/${r.def.id}: keys in order of time`);
      const last = r.keys[r.keys.length - 1];
      progressAt(r.keys, last.t + 2, prog);
      assert.ok(Math.abs(prog.s - (last.s + 2 * last.v)) < 1e-9);
    }
  }
  // sideways: smoothly to the new place, and the indicators by their times
  const zip = sceneOf('zip');
  const me = actor(zip, 'me').def;
  assert.equal(sideAt(me, 7).off, 0);
  assert.ok(Math.abs(sideAt(me, 7.1 + 1.2).off - 3.25 / 2) < 1e-9, 'half way at half time');
  assert.ok(Math.abs(sideAt(me, 20).off - 3.25) < 1e-9);
  assert.equal(sideAt(me, 20).rate, 0);
  assert.equal(blinkAt(me, 5), 0);
  assert.equal(blinkAt(me, 6), -1);
  assert.equal(blinkAt(me, 10), 0);
});

test('every place fits on the practice yard (150 × 66 m), the way you drive along its long side', () => {
  for (const s of scenes.values()) {
    const [x0, z0, x1, z1] = s.stage.bounds;
    assert.ok(x0 >= -33 && x1 <= 33, `${s.lesson.id}: across ${x0}…${x1}`);
    assert.ok(z0 >= -75 && z1 <= 75, `${s.lesson.id}: along ${z0}…${z1}`);
    assert.ok(s.stage.surfaces.some((x) => x.kind === 'asphalt'));
  }
});

test('the outlines of each place are simple: no edge crosses another (they are cut into triangles to be drawn)', () => {
  const cross = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean => {
    const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
    const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
    const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
    return d1 * d2 < -1e-9 && d3 * d4 < -1e-9;
  };
  for (const s of scenes.values()) {
    for (const surface of s.stage.surfaces) {
      if (surface.kind === 'paint' || surface.kind === 'steel') continue;
      for (const ring of [surface.ring, ...(surface.holes ?? [])]) {
        const n = ring.length / 2;
        assert.ok(n >= 3, `${s.lesson.id}: an outline of ${n} points`);
        for (let i = 0; i < n; i++) {
          for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue;
            const [ax, az, bx, bz] = [ring[i * 2], ring[i * 2 + 1], ring[((i + 1) % n) * 2], ring[((i + 1) % n) * 2 + 1]];
            const [cx, cz, dx, dz] = [ring[j * 2], ring[j * 2 + 1], ring[((j + 1) % n) * 2], ring[((j + 1) % n) * 2 + 1]];
            assert.ok(!cross(ax, az, bx, bz, cx, cz, dx, dz), `${s.lesson.id}: the outline of a ${surface.kind} crosses itself (edges ${i} and ${j})`);
          }
        }
      }
    }
  }
});

test('nobody goes backwards, speeds and braking stay those of the road', () => {
  const top: Record<string, number> = { me: 17, car: 21.5, van: 15, bus: 9, truck: 17, tram: 12, bike: 7, person: 1.8, child: 1.9 };
  for (const s of scenes.values()) {
    for (const r of s.actors) {
      for (const t of times(s.lesson)) {
        const p = pose(r, t);
        if (!p.visible) continue;
        const what = `${s.lesson.id}/${r.def.id} at ${t.toFixed(2)}`;
        assert.ok(p.v > -0.05, `${what}: backwards`);
        assert.ok(p.v <= top[r.def.kind] + 1e-6, `${what}: ${p.v.toFixed(1)} m/s`);
        assert.ok(Math.abs(p.a) <= (isPerson(r) ? 1.5 : 3.6), `${what}: ${p.a.toFixed(1)} m/s²`);
      }
    }
  }
});

test('nobody touches anybody (but the children getting off the bus they come out of)', () => {
  for (const s of scenes.values()) {
    const poses = s.actors.map(() => newPose());
    for (const t of times(s.lesson)) {
      s.actors.forEach((r, i) => poseAt(r, t, poses[i]));
      for (let i = 0; i < s.actors.length; i++) {
        for (let j = i + 1; j < s.actors.length; j++) {
          const a = s.actors[i];
          const b = s.actors[j];
          if (!poses[i].visible || !poses[j].visible || a.def.leaves === b.def.id || b.def.leaves === a.def.id) continue;
          const grow = isPerson(a) && isPerson(b) ? 0.1 : 0.2;
          assert.ok(!outlinesTouch(corners(a, poses[i], grow), corners(b, poses[j], grow)), `${s.lesson.id}: ${a.def.id} and ${b.def.id} touch at ${t.toFixed(2)}`);
        }
      }
    }
  }
});

test('vehicles keep to the asphalt, people to the pavements and crossings', () => {
  for (const s of scenes.values()) {
    const road = s.stage.surfaces.filter((x) => x.kind === 'asphalt' || x.kind === 'apron');
    const ground = s.stage.surfaces.filter((x) => x.kind === 'asphalt' || x.kind === 'walk');
    const [x0, z0, x1, z1] = s.stage.bounds;
    for (const r of s.actors) {
      for (const t of times(s.lesson)) {
        const p = pose(r, t);
        if (!p.visible) continue;
        // (only while all of it is on the place: it comes from beyond its edge and leaves past it)
        const c = corners(r, p);
        let inside = true;
        for (let k = 0; k < 8; k += 2) if (c[k] < x0 + 0.5 || c[k] > x1 - 0.5 || c[k + 1] < z0 + 0.5 || c[k + 1] > z1 - 0.5) inside = false;
        if (!inside) continue;
        if (isPerson(r)) {
          assert.ok(ground.some((g) => covers(g, p.x, p.z)), `${s.lesson.id}/${r.def.id} on nothing at ${t.toFixed(2)} (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
        } else {
          for (let k = 0; k < 8; k += 2) assert.ok(road.some((g) => covers(g, c[k], c[k + 1])), `${s.lesson.id}/${r.def.id} off the road at ${t.toFixed(2)} (${c[k].toFixed(1)}, ${c[k + 1].toFixed(1)})`);
        }
      }
    }
  }
});

test('at each question, those it is about are there – and you are', () => {
  for (const s of scenes.values()) {
    for (const step of s.lesson.steps) {
      assert.ok(pose(actor(s, 'me'), step.at).visible, `${s.lesson.id} at ${step.at}: you`);
      for (const a of step.answers) {
        const r = s.actors.find((x) => x.def.id === a);
        if (r) assert.ok(pose(r, step.at).visible, `${s.lesson.id} at ${step.at}: ${a}`);
      }
    }
  }
});

/**
 * "Who goes first?" played out: from the question on, wherever the right one
 * and another of the answers both go, the right one has left before the
 * other comes (a grid of half metres over the place).
 */
test('whoever goes first is first through the place they share', () => {
  const CELL = 0.5;
  for (const s of scenes.values()) {
    for (const step of s.lesson.steps) {
      const movers = step.answers.filter((a) => s.actors.some((x) => x.def.id === a));
      if (movers.length < 2 || !movers.includes(step.right)) continue;
      const cells = (r: ActorRun): Map<string, [number, number]> => {
        const out = new Map<string, [number, number]>();
        for (const t of times(s.lesson, step.at)) {
          const p = pose(r, t);
          if (!p.visible) continue;
          const c = corners(r, p, isPerson(r) ? 0.25 : 0.15);
          let minX = Infinity;
          let maxX = -Infinity;
          let minZ = Infinity;
          let maxZ = -Infinity;
          for (let k = 0; k < 8; k += 2) {
            minX = Math.min(minX, c[k]);
            maxX = Math.max(maxX, c[k]);
            minZ = Math.min(minZ, c[k + 1]);
            maxZ = Math.max(maxZ, c[k + 1]);
          }
          for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx++) {
            for (let gz = Math.floor(minZ / CELL); gz <= Math.floor(maxZ / CELL); gz++) {
              const x = (gx + 0.5) * CELL;
              const z = (gz + 0.5) * CELL;
              // (inside the outline itself, not only its box)
              if (!outlinesTouch(c, [x - 0.01, z - 0.01, x + 0.01, z - 0.01, x + 0.01, z + 0.01, x - 0.01, z + 0.01])) continue;
              const key = `${gx},${gz}`;
              const was = out.get(key);
              if (was) was[1] = t;
              else out.set(key, [t, t]);
            }
          }
        }
        return out;
      };
      const first = cells(actor(s, step.right));
      for (const other of movers) {
        if (other === step.right) continue;
        const then = cells(actor(s, other));
        let shared = 0;
        for (const [key, [inFirst]] of then) {
          const f = first.get(key);
          if (!f) continue;
          shared++;
          assert.ok(f[1] < inFirst, `${s.lesson.id} at ${step.at}: ${other} is at ${key} at ${inFirst.toFixed(2)} before ${step.right} has left it (${f[1].toFixed(2)})`);
        }
        // (where the two ways do not meet at all, there is nothing to go first through: the question is about the way of another)
        void shared;
      }
    }
  }
});

test('the zebra crossing: you stop before it while somebody is on it', () => {
  const s = sceneOf('zebra');
  const me = actor(s, 'me');
  const line = markAt(me.path, 'zebra');
  for (const t of times(s.lesson)) {
    const onIt = ['walker', 'walker2'].some((id) => {
      const p = pose(actor(s, id), t);
      return p.visible && Math.abs(p.z) < 2.2 && Math.abs(p.x) < 3.4;
    });
    if (onIt) assert.ok(pose(me, t).s <= line + 0.05, `at ${t.toFixed(2)} you are on the crossing with people on it`);
  }
});

test('the school bus: not overtaken while it goes to its stop, passed at walking pace while it stands there', () => {
  const s = sceneOf('schoolBus');
  const me = actor(s, 'me');
  const bus = actor(s, 'bus');
  for (const t of times(s.lesson)) {
    const b = pose(bus, t);
    const m = pose(me, t);
    // (both on the same lane path: s is the nose)
    const busTail = b.s - 12;
    if (b.v > 0.05) assert.ok(m.s < busTail, `at ${t.toFixed(2)} you are beside the moving bus`);
    else if (m.s > busTail - 1 && m.s < b.s + 4.5) assert.ok(m.v <= 7 / 3.6 + 0.01, `at ${t.toFixed(2)} you pass the standing bus at ${(m.v * 3.6).toFixed(1)} km/h`);
  }
  assert.equal(blinkAt(bus.def, 3), 2, 'its hazard lights are on');
});

test('the cyclist: overtaken with at least 1.5 m to the side, and not while the oncoming car comes', () => {
  const s = sceneOf('overtake');
  const me = actor(s, 'me');
  const bike = actor(s, 'bike');
  const car = actor(s, 'white');
  let beside = 0;
  for (const t of times(s.lesson)) {
    const m = pose(me, t);
    const b = pose(bike, t);
    const c = pose(car, t);
    // side by side: some of you is level with some of the bicycle
    const level = m.s > b.s - 1.75 && m.s - 4.28 < b.s;
    if (level) {
      beside++;
      const gap = Math.abs(m.x - b.x) - 1.79 / 2 - 0.62 / 2;
      assert.ok(gap >= 1.5, `at ${t.toFixed(2)} only ${gap.toFixed(2)} m to the side`);
      // (the oncoming car: not between your nose and 40 m ahead of it)
      const ahead = m.z - c.z;
      assert.ok(!c.visible || ahead < -5 || ahead > 40, `at ${t.toFixed(2)} you overtake with the oncoming car ${ahead.toFixed(1)} m ahead`);
    }
  }
  assert.ok(beside > 0, 'you overtake it');
});

test('the roundabout: no indicator going in, right before going out', () => {
  const s = sceneOf('roundabout');
  const me = actor(s, 'me');
  const ring = markAt(me.path, 'ring');
  const line = markAt(me.path, 'line');
  const exit = markAt(me.path, 'exit');
  for (const t of times(s.lesson)) {
    const p = pose(me, t);
    if (p.s >= line && p.s <= ring + 2) assert.equal(p.blink, 0, `at ${t.toFixed(2)} indicating on the way in`);
    if (p.s >= exit - 8 && p.s <= exit) assert.equal(p.blink, 1, `at ${t.toFixed(2)} not indicating before the exit`);
  }
});

test('the green arrow: you stop at the line before you turn on red, and wait for the person crossing', () => {
  const s = sceneOf('greenArrow');
  const me = actor(s, 'me');
  const line = markAt(me.path, 'line');
  let stood = 0;
  for (const t of times(s.lesson)) {
    const p = pose(me, t);
    assert.equal(lightAt(s, 'ns', t), 'R', 'your light is red throughout');
    if (Math.abs(p.s - line) < 0.05 && p.v < 0.05) stood += DT;
    if (p.s > line + 0.05) assert.ok(stood >= 1, `at ${t.toFixed(2)} over the line without having stopped`);
  }
  assert.ok(s.stage.lights.some((l) => l.arrow), 'the green-arrow sign hangs at your light');
});

test('the left turn and the tram: you wait with your indicator on; the bend of the priority road is indicated', () => {
  for (const id of ['leftTurn', 'tram']) {
    const s = sceneOf(id);
    const me = actor(s, 'me');
    assert.equal(blinkAt(me.def, s.lesson.steps[0].at), -1, `${id}: indicating left while waiting`);
  }
  const bend = sceneOf('bend');
  const me = actor(bend, 'me');
  // (not before the question about it – that would give the answer away – but as you go into the bend)
  assert.equal(blinkAt(me.def, bend.lesson.steps[0].at), 0);
  const t = me.keys.find((k) => k.s >= markAt(me.path, 'in'))?.t ?? 0;
  assert.equal(blinkAt(me.def, t), -1);
});

test('the zip: you merge where your lane ends, after the blue car and before the green one', () => {
  const s = sceneOf('zip');
  const me = actor(s, 'me');
  // (the lane ends from z = −20 on: both lanes' paths begin at z = 72, so s = 72 − z)
  const [t0] = me.def.side?.[0] ?? [0];
  assert.ok(pose(me, t0).s > 72 + 10, 'you change lanes only near the end of yours');
  const order = ['l1', 'r1', 'l2', 'me', 'l3', 'l4'].map((id) => pose(actor(s, id), s.lesson.end).s);
  for (let i = 1; i < order.length; i++) assert.ok(order[i] < order[i - 1], 'taking turns: l1, r1, l2, you, l3, l4');
});

test('a run stops at each question, counts the answers, plays on and ends', () => {
  const s = sceneOf('roundabout');
  const run = new TheoryRun(s);
  assert.equal(run.phase, 'play');
  assert.equal(run.answer('red'), null, 'no question open');
  let stops = 0;
  for (let i = 0; i < 2000 && run.phase === 'play'; i++) if (run.advance(0.1)) stops++;
  assert.equal(stops, 1);
  assert.equal(run.phase, 'ask');
  assert.equal(run.t, s.lesson.steps[0].at, 'stopped exactly at the question');
  const t = run.t;
  run.advance(1);
  assert.equal(run.t, t, 'the clock stands while asking');
  assert.equal(run.answer('nobody'), null, 'not one of the answers');
  assert.equal(run.answer('me'), false);
  assert.equal(run.phase, 'told');
  assert.equal(run.picked, 'me');
  run.advance(1);
  assert.equal(run.t, t, '… and while telling why');
  run.goOn();
  assert.equal(run.phase, 'play');
  while (run.phase === 'play') run.advance(0.1);
  assert.equal(run.step, 1);
  assert.equal(run.answer('none'), true);
  run.goOn();
  while (run.phase === 'play') run.advance(0.1);
  assert.equal(run.answer('right'), true);
  run.goOn();
  while (run.phase === 'play') run.advance(0.1);
  assert.equal(run.phase, 'end');
  assert.equal(run.t, s.lesson.end);
  assert.equal(run.right, 2);
  run.restart();
  assert.equal(run.phase, 'play');
  assert.equal(run.t, 0);
  assert.equal(run.right, 0);
});

test('a run can start at a moment of its script (for pictures): the questions before it count as answered', () => {
  const s = sceneOf('roundabout');
  const run = new TheoryRun(s);
  run.skipTo(s.lesson.steps[1].at);
  assert.equal(run.phase, 'ask');
  assert.equal(run.step, 1);
  assert.equal(run.right, 1);
  assert.equal(run.t, s.lesson.steps[1].at);
  run.skipTo(1);
  assert.equal(run.phase, 'play');
  assert.equal(run.t, 1);
  assert.equal(run.right, 0);
  run.skipTo(99);
  assert.equal(run.phase, 'end');
  assert.equal(run.t, s.lesson.end);
  assert.equal(run.right, s.lesson.steps.length);
});

test('names: you, the others by their colour or kind; answers of their own by the lesson', () => {
  const rbl = THEORY.find((l) => l.id === 'rbl') as LessonDef;
  assert.equal(actorName(rbl.actors[0]), 'theory.who.me');
  assert.equal(answerKey(rbl, 1, 'blue'), 'theory.who.blue');
  assert.equal(answerKey(rbl, 1, '!yes'), 'theory.a.yes');
  assert.equal(answerKey(rbl, 2, 'fast'), 'theory.rbl.2.fast');
});

test('paths are smooth: no kink sharper than a car can steer', () => {
  const a = newPathPoint();
  const b = newPathPoint();
  for (const s of scenes.values()) {
    for (const [name, p] of Object.entries(s.stage.paths)) {
      // people turn on the spot; the ways of vehicles must not bend more than a car's lock allows (r ≥ 4.5 m)
      if (s.actors.every((r) => r.path !== p || isPerson(r))) continue;
      for (let d = 1; d < p.len - 1; d += 0.5) {
        pathPoint(p, d - 0.5, a);
        pathPoint(p, d + 0.5, b);
        const turn = Math.abs(Math.atan2(a.dx * b.dz - a.dz * b.dx, a.dx * b.dx + a.dz * b.dz));
        assert.ok(turn < 1 / 4.5 + 0.05, `${s.lesson.id}/${name} bends ${turn.toFixed(2)} rad in a metre at ${d}`);
      }
    }
  }
});
