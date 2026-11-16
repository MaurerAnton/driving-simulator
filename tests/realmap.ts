// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The real map for tests that drive or look things up on it: opened the way
 * the game opens it (src/world/loader.ts), from public/map – or from the
 * folder MAP_DIR names.  The map is not part of the repository (it is built,
 * or fetched: see docs/MAP_DATA.md); tests that need it are skipped without it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainNetwork } from '../src/game/address.ts';
import { followMap } from '../src/sim/follow.ts';
import type { MapFollowers } from '../src/sim/follow.ts';
import { LaneGraph } from '../src/world/lanes.ts';
import type { Lane } from '../src/world/lanes.ts';
import { MapLoader } from '../src/world/loader.ts';
import { NetIndex } from '../src/world/netindex.ts';
import { wayOf } from '../src/world/routegraph.ts';
import type { World } from '../src/world/world.ts';
import { diskFiles } from '../tools/mapgen/mapfiles.ts';

export const mapDir = fileURLToPath(new URL(`../${(process.env.MAP_DIR ?? 'public/map').replace(/\/$/, '')}/`, import.meta.url));
export const haveMap = existsSync(join(mapDir, 'map.json')) || existsSync(join(mapDir, 'world.json'));

export interface RealMap {
  map: MapLoader;
  world: World;
  lanes: LaneGraph;
  /** what follows the road network as it is loaded: set `traffic` and `signals` to have them follow, too */
  followers: MapFollowers;
  /** the roads of the whole map (a map in pieces), for ways and places beyond what is loaded */
  index: NetIndex | null;
  /** is a lane part of the network one can drive around in? */
  usable(lane: Lane): boolean;
}

export async function openRealMap(): Promise<RealMap> {
  const map = await MapLoader.open(diskFiles(mapDir));
  const world = map.world;
  const lanes = new LaneGraph(world);
  const followers: MapFollowers = { lanes };
  followMap(map, followers);
  const net = await map.net();
  const index = net ? new NetIndex(net) : null;
  let main: Set<number> | null = null;
  return {
    map,
    world,
    lanes,
    followers,
    index,
    usable(lane: Lane): boolean {
      if (index) return index.main[wayOf(lane)] === 1;
      main ??= mainNetwork(world, lanes);
      return main.has(lane.id);
    },
  };
}
