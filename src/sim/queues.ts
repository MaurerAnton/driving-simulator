// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Queues in the traffic: where cars stand or crawl one behind another – at a
 * red light, before roadworks, behind something that blocks the way – how
 * many they are, how long the queue is from the front of the first to the
 * back of the last, and, where it can be told cheaply, how long the last one
 * will wait: at a red light the time until green and a couple of seconds
 * for each car ahead to move off, at a bus stop the bus's time there.
 *
 * A queue is followed back from its head along the lanes and the paths
 * through the junctions behind it (the queue from a light may reach back
 * over the junction before).  The labels over the queues are src/ui/queuelabels.ts.
 */
import type { Connector, Lane } from '../world/lanes.ts';
import { SIG } from './signals.ts';
import type { SignalSystem } from './signals.ts';
import type { TrafficCar } from './traffic.ts';

/** slower than this (m/s) a car stands or crawls */
export const QUEUE_SLOW = 2.5;
/** at most this between one car's back and the next one's front (m) */
export const QUEUE_GAP = 12;
/** a queue has at least this many cars */
export const QUEUE_MIN = 3;
/** seconds for each car of a queue to move off once the first one goes */
const PER_CAR = 1.9;

export interface Queue {
  /** the first car (at the front) and the last one (at its end: where its label goes) */
  head: TrafficCar;
  tail: TrafficCar;
  cars: number;
  /** from the front of the first car to the back of the last (m) */
  length: number;
  /** seconds the last car can expect to wait before it moves on (NaN: cannot be told) */
  wait: number;
}

type Piece = Lane | Connector;

const isLane = (p: Piece): p is Lane => 'edge' in p;

export class QueueMeter {
  private readonly slow = new Map<Piece, TrafficCar[]>();
  private readonly lists: TrafficCar[][] = [];
  private readonly followers = new Set<TrafficCar>();
  private readonly used = new Set<TrafficCar>();
  private readonly found = { car: null as TrafficCar | null, gap: 0 };

  /** The queues among `cars` (written into `out`, which is returned). */
  measure(cars: readonly TrafficCar[], signals: SignalSystem | null, out: Queue[] = []): Queue[] {
    out.length = 0;
    const slow = this.slow;
    for (const l of slow.values()) {
      l.length = 0;
      this.lists.push(l);
    }
    slow.clear();
    for (const c of cars) {
      if (c.v >= QUEUE_SLOW) continue;
      const piece = c.lane ?? c.conn;
      if (!piece) continue;
      let l = slow.get(piece);
      if (!l) slow.set(piece, (l = this.lists.pop() ?? []));
      l.push(c);
    }
    for (const l of slow.values()) if (l.length > 1) l.sort((a, b) => b.s - a.s);
    // whoever has a slow car right in front of them is not the head of a queue
    const followers = this.followers;
    followers.clear();
    for (const l of slow.values()) for (const c of l) if (this.behind(c)) followers.add(this.found.car as TrafficCar);
    const used = this.used;
    used.clear();
    for (const l of slow.values()) {
      for (const head of l) {
        if (followers.has(head) || used.has(head)) continue;
        used.add(head);
        let n = 1;
        let length = head.length;
        let tail = head;
        while (n < 400 && this.behind(tail)) {
          const next = this.found.car as TrafficCar;
          if (used.has(next)) break;
          used.add(next);
          length += this.found.gap + next.length;
          tail = next;
          n++;
        }
        if (n < QUEUE_MIN) continue;
        out.push({ head, tail, cars: n, length, wait: signals ? waitOf(head, n, signals) : NaN });
      }
    }
    return out;
  }

  /** The slow car right behind `c` (within QUEUE_GAP of its back) – in `found` – or false. */
  private behind(c: TrafficCar): boolean {
    const piece = (c.lane ?? c.conn) as Piece;
    const rear = c.s - c.length / 2;
    const f = this.found;
    f.car = null;
    f.gap = Infinity;
    // on the same lane or path
    const here = this.slow.get(piece);
    if (here) {
      const i = here.indexOf(c);
      for (let k = i + 1; k < here.length; k++) {
        const o = here[k];
        if (o.s >= c.s) continue;
        const gap = rear - (o.s + o.length / 2);
        if (gap <= QUEUE_GAP) {
          f.car = o;
          f.gap = Math.max(0, gap);
          return true;
        }
        return false;
      }
    }
    if (rear > QUEUE_GAP) return false;
    // … else on what leads into it
    // (`slack`: a path through a junction between the two – nobody waits in the junction, so its length does not count)
    let eff = Infinity;
    const take = (list: TrafficCar[] | undefined, offset: number, only: Connector | null, slack: number): void => {
      if (!list) return;
      for (const o of list) {
        if (only && o.next !== only) continue;
        const gap = offset - (o.s + o.length / 2);
        if (gap - slack < eff) {
          eff = gap - slack;
          f.gap = gap;
          f.car = o;
        }
        // (sorted: the first that leads there is the nearest)
        break;
      }
    };
    if (isLane(piece)) {
      for (const cin of piece.in) {
        take(this.slow.get(cin), rear + cin.len, null, 0);
        take(this.slow.get(cin.from), rear + cin.len + cin.from.len, cin, cin.len);
      }
    } else take(this.slow.get(piece.from), rear + piece.from.len, null, 0);
    if (!f.car || eff > QUEUE_GAP) {
      f.car = null;
      return false;
    }
    f.gap = Math.max(0, f.gap);
    return true;
  }
}

/** How long the last of `n` cars waits behind `head` (s; NaN: cannot be told). */
function waitOf(head: TrafficCar, n: number, signals: SignalSystem): number {
  // a bus at its stop: its time there
  if (head.bus && head.bus.dwell > 0) return head.bus.dwell + PER_CAR * (n - 1);
  const lane = head.lane;
  if (!lane) return NaN;
  const arm = lane.armTo;
  const sc = lane.to.sc;
  if (arm.sg < 0 || sc < 0 || lane.stopAt - head.s - head.length / 2 > 15 || signals.isDark(sc)) return NaN;
  const st = signals.get(sc, arm.sg);
  const move = PER_CAR * (n - 1) + 1;
  if (st === SIG.GREEN) return move;
  const ch = signals.change(sc, arm.sg);
  if (!ch || !Number.isFinite(ch.left)) return NaN;
  // red: then red-amber (a second or so), then green
  if (st === SIG.RED) return ch.left + 1 + move;
  if (st === SIG.RED_AMBER) return ch.left + move;
  return NaN;
}
