// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where a green arrow hangs beside a traffic light.
 *
 * The map says nothing about it, so it is worked out: an approach gets an
 * arrow for turning right where that turn is in nobody's way for a good part
 * of the time its own light is red.  Typically the main road at a T-junction,
 * on the side the side road joins: while the side road has green, the only
 * vehicles that could meet the ones turning right into it – those coming the
 * other way and turning left – have red.
 *
 * Looked at for each approach of a junction with lights:
 *
 *  - the paths through the junction that cross or join the right turn: the
 *    groups of their lights must be red while the arrow is lit (`foes`);
 *  - no pedestrian light across the approach itself: people cross there
 *    exactly while its light is red;
 *  - a pedestrian light across the road the turn leads into: the vehicles
 *    there must have green while the arrow is lit, for the people have red
 *    then (`friends`);
 *  - whether, by the programme of the lights, that leaves the arrow lit long
 *    enough to be worth it.
 *
 * Only junctions that are one junction: where the carriageways of a dual
 * road cross in several, the vehicles between them are let in by the light
 * of another approach, and what is free when cannot be told from one of
 * them.
 */
import { hash01 } from '../core/geom.ts';
import { LaneGraph, TURN } from '../world/lanes.ts';
import type { Lane } from '../world/lanes.ts';
import { CTRL, ROLE, XING } from '../world/types.ts';
import type { Arm, Node, World } from '../world/world.ts';
import type { Arrow, SignalSystem } from './signals.ts';

/** an arrow must be lit for at least this long in every cycle (s) */
const WORTH = 8;
/** a pedestrian light this near the junction belongs to it (m along the road) */
const NEAR = 60;
/** junctions of one controller this near each other are parts of one big junction (m along the road) */
const PART = 70;

/** The junctions of the same controller a few metres along the roads from `node` (through mere joints). */
function partners(node: Node): Node[] {
  const out: Node[] = [];
  for (const arm of node.arms) {
    let edge = arm.edge;
    let at = node;
    let dist = 0;
    for (let hop = 0; hop < 6; hop++) {
      dist += edge.len;
      if (dist > PART) break;
      const far = edge.a === at ? edge.b : edge.a;
      if (far === node) break;
      if (far.sc === node.sc) {
        out.push(far);
        break;
      }
      if (far.stub || far.arms.length !== 2) break;
      const on = far.arms.find((a) => a.edge !== edge);
      if (!on) break;
      at = far;
      edge = on.edge;
    }
  }
  return out;
}

/** The lanes that arrive at a junction on an approach. */
function lanesOn(graph: LaneGraph, arm: Arm): Lane[] {
  const el = graph.edgeLanes[arm.edge.id];
  if (!el) return [];
  return [...el.fwd, ...el.back].filter((l) => l.armTo === arm);
}

/** How far from the junction the pedestrian lights across an arm are (those of the junction's own controller or any other). */
function crossingsNear(arm: Arm): Array<{ dist: number; sc: number; g: number }> {
  const out: Array<{ dist: number; sc: number; g: number }> = [];
  for (const x of arm.edge.xings) {
    if (x.k !== XING.SIGNAL || x.sc === undefined) continue;
    const dist = arm.out ? x.s : arm.edge.len - x.s;
    if (dist < NEAR) out.push({ dist, sc: x.sc, g: x.g ?? 0 });
  }
  return out;
}

/**
 * The arrow an approach could have – or null: there is no right turn, it is
 * never free, or people cross where the vehicles would start.
 */
export function findArrow(world: World, graph: LaneGraph, signals: SignalSystem, node: Node, arm: Arm): Arrow | null {
  if (node.stub || node.dark || node.ctrl !== CTRL.SIGNALS || node.sc < 0 || arm.sg < 0 || !arm.isApproach) return null;
  const controller = world.signals[node.sc];
  if (!controller || controller.ped || controller.groups < 2) return null;
  // the turns to the right, from the lane at the kerb
  const lane = lanesOn(graph, arm).find((l) => l.idx === 0);
  if (!lane) return null;
  const turns = lane.out.filter((c) => c.turn === TURN.RIGHT && LaneGraph.drivable(c.to.edge, true));
  if (turns.length === 0) return null;
  if (crossingsNear(arm).length > 0) return null;
  if (partners(node).length > 0) return null;
  graph.resolveNode(node.id);
  const foes = new Set<number>();
  const friends = new Set<number>();
  for (const c of turns) {
    for (const k of c.conflicts) {
      const from = k.other.from.armTo;
      if (from === arm) continue;
      if (from.sg < 0) {
        // an approach without a light: a driveway waits for everybody anyway – anything else, and nobody knows when it is free
        if (from.role !== ROLE.MINOR || k.yield) return null;
        continue;
      }
      foes.add(from.sg);
    }
    // the people crossing the road the turn leads into
    const exit = node.arms.find((a) => a.edge === c.to.edge && a !== arm);
    if (!exit) continue;
    for (const x of crossingsNear(exit)) {
      if (x.sc !== node.sc) return null;
      friends.add(x.g);
    }
  }
  // (a group cannot be asked to be red and green at once)
  for (const g of friends) if (foes.has(g) || g === arm.sg) return null;
  const list = [...foes].sort((a, b) => a - b);
  const pals = [...friends].sort((a, b) => a - b);
  if (signals.arrowTime(node.sc, arm.sg, list, pals) < WORTH) return null;
  return { controller: node.sc, own: arm.sg, foes: list, friends: pals, state: -1, since: 0 };
}

/**
 * Put up the arrows of the junctions in `nodes` (those that have just been
 * loaded) – at a `share` of the approaches that could have one, always the
 * same ones.  Returns how many.
 */
export function markArrows(world: World, graph: LaneGraph, signals: SignalSystem, nodes: Iterable<Node>, share = 1): number {
  let n = 0;
  for (const node of nodes) {
    if (node.ctrl !== CTRL.SIGNALS || node.sc < 0) continue;
    // (a part of a bigger junction has come: what was taken for a junction of its own is none)
    for (const p of partners(node)) for (const arm of p.arms) signals.arrows.delete(arm);
    for (const arm of node.arms) {
      if (signals.arrows.has(arm)) continue;
      if (hash01(node.id * 31 + arm.edge.id * 17 + 5) >= share) continue;
      const a = findArrow(world, graph, signals, node, arm);
      if (!a) continue;
      signals.arrows.set(arm, a);
      n++;
    }
  }
  return n;
}

/** Take down the arrows of junctions that are no longer loaded. */
export function dropArrows(signals: SignalSystem, nodes: Iterable<Node>): void {
  for (const node of nodes) for (const arm of node.arms) signals.arrows.delete(arm);
}
