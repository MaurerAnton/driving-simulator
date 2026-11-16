// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Keeps what is derived from the road network in step with it where the
 * network comes in pieces (world/loader.ts): the lanes, the roads cars may
 * appear on, the signal controllers and the green arrows beside their
 * lights.  The same for the game and for the tests that drive on the real
 * map.
 */
import type { LaneGraph } from '../world/lanes.ts';
import type { MapLoader } from '../world/loader.ts';
import { dropArrows, markArrows } from './arrows.ts';
import type { SignalSystem } from './signals.ts';
import type { Traffic } from './traffic.ts';

export interface MapFollowers {
  lanes: LaneGraph;
  traffic?: Traffic | null;
  signals?: SignalSystem | null;
  /** called after every change (for what is drawn: the signal heads) */
  changed?: () => void;
}

/** `who` may be swapped for another set later (its fields are read at each change). */
export function followMap(map: MapLoader, who: MapFollowers): void {
  map.listen({
    added: (c) => {
      for (const e of c.edges) who.lanes.addEdge(e);
      for (const n of c.nodes) who.lanes.completeNode(n);
      who.traffic?.addRoads(c.edges);
      who.signals?.sync();
      if (who.signals) markArrows(map.world, who.lanes, who.signals, c.nodes);
      who.changed?.();
    },
    removed: (c) => {
      who.traffic?.removeRoads(c.edges);
      if (who.signals) dropArrows(who.signals, c.nodes);
      for (const n of c.nodes) who.lanes.removeNode(n);
      for (const e of c.edges) who.lanes.removeEdge(e);
      who.changed?.();
    },
  });
}
