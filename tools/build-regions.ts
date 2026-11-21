// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Put the files of a map (a release's `map/` folder, unpacked) into map-assets
 * as a region the game can load: its map.json, its road network and its small
 * files, under `map-assets/regions/<id>/`, plus the entry for `regions.json`.
 *
 *   node tools/build-regions.ts --map work/map --id bremen --zone 32 \
 *        --name Bremen [--tiles 34.tar] [--out map-assets] [--index regions.json]
 *
 * A region is a map of its own: the game loads one at a time (world/regionfiles.ts
 * reads its files; the first index sets the world frame to its origin).  What a
 * region needs, and what this copies:
 *
 *   map.json              the index: extent, places, spawns, tile/chunk sets  (required)
 *   net.bin.gz            every road of it in a few numbers                  (required for a map in pieces)
 *   w/<cx>_<cz>.json.gz   the road network in chunks                         (the pieces)
 *   rails/stops/lines/timetable/far/air  the small files, when the map has them (optional)
 *
 * The tiles are NOT copied: they are already in map-assets as parts (index.json
 * + N.tar, made by .github/workflows/map-assets-parts.yml), and `tiles` names
 * which parts hold this region's tiles.
 *
 * `--zone` is the UTM zone the region's origin lies in: a map.json carries its
 * origin in easting/northing but no latitude/longitude, so the zone cannot be
 * read from it (the map is built in one zone; the builder knows which).
 *
 * The index entry is written into `--index` (regions.json): this region's id,
 * name, box (from map.json meta), map path, the parts that carry its tiles, and
 * its zone.  An entry with the same id is replaced; the rest are kept.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Region, RegionIndex } from '../src/world/regions.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const value = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

const mapDir = value('--map');
const id = value('--id');
if (!mapDir || !id) {
  console.error('usage: node tools/build-regions.ts --map <map-folder> --id <region> --zone <utm-zone> [--name <name>] [--tiles <part.tar> ...] [--out <dir>] [--index <regions.json>]');
  process.exit(1);
}
const zone = Number(value('--zone'));
const name = value('--name') ?? id;
const out = resolve(root, value('--out') ?? 'map-assets');
const indexPath = resolve(root, value('--index') ?? join(out, 'regions.json'));
const tiles = argv.reduce<string[]>((acc, a, i) => (a === '--tiles' ? [...acc, argv[i + 1]] : acc), []);
if (!Number.isFinite(zone) || zone < 1 || zone > 60) {
  console.error(`--zone must be a UTM zone (1…60), got ${value('--zone')}`);
  process.exit(1);
}

/** The small files a region carries when its map has them. */
const SMALL = ['rails.json.gz', 'stops.json.gz', 'lines.json.gz', 'timetable.json.gz', 'far.bin.gz', 'air.json.gz'];

const mapJsonPath = join(mapDir, 'map.json');
if (!existsSync(mapJsonPath)) {
  console.error(`no map.json in ${mapDir} – a region needs a map in pieces (map.json + w/)`);
  process.exit(1);
}
const mapJson = JSON.parse(readFileSync(mapJsonPath, 'utf8')) as { meta?: { name?: string; minX?: number; maxX?: number; minZ?: number; maxZ?: number } };
const meta = mapJson.meta ?? {};
if (typeof meta.minX !== 'number' || typeof meta.maxX !== 'number' || typeof meta.minZ !== 'number' || typeof meta.maxZ !== 'number') {
  console.error('map.json meta has no extent (minX/maxX/minZ/maxZ) – a region needs one');
  process.exit(1);
}
const box: [number, number, number, number] = [meta.minX, meta.minZ, meta.maxX, meta.maxZ];

// the region's folder: map.json, net.bin.gz, w/, and the small files that are there
const dest = join(out, 'regions', id);
mkdirSync(join(dest, 'w'), { recursive: true });
cpSync(mapJsonPath, join(dest, 'map.json'));
let copied = 1;
const wDir = join(mapDir, 'w');
if (existsSync(wDir)) {
  for (const f of readdirSync(wDir)) {
    if (!f.endsWith('.json.gz')) continue;
    cpSync(join(wDir, f), join(dest, 'w', f));
    copied++;
  }
}
if (existsSync(join(mapDir, 'net.bin.gz'))) {
  cpSync(join(mapDir, 'net.bin.gz'), join(dest, 'net.bin.gz'));
  copied++;
} else {
  console.warn('no net.bin.gz – routes and the big map will not work for this region');
}
let small = 0;
for (const f of SMALL) {
  if (existsSync(join(mapDir, f))) {
    cpSync(join(mapDir, f), join(dest, f));
    small++;
  }
}

// the index entry: this region, with its box, its map path, its tiles, its zone
const entry: Region = {
  id,
  name: typeof meta.name === 'string' && meta.name ? meta.name : name,
  box,
  map: `regions/${id}/map.json`,
  tiles,
  zone,
};
let index: RegionIndex = { latest: '', regions: [] };
if (existsSync(indexPath)) {
  try {
    const old = JSON.parse(readFileSync(indexPath, 'utf8')) as RegionIndex;
    if (Array.isArray(old.regions)) index = old;
  } catch {
    console.warn(`${indexPath} is not readable – a new one is written`);
  }
}
const kept = index.regions.filter((r) => r.id !== id);
index.regions = [...kept, entry];
if (!index.latest || index.latest === id) index.latest = index.regions[0]?.id ?? id;
mkdirSync(dirname(indexPath), { recursive: true });
writeFileSync(indexPath, JSON.stringify(index, null, 2));

const bytes = (p: string): number => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};
console.log(
  JSON.stringify(
    {
      id,
      name: entry.name,
      zone,
      box,
      map_bytes: bytes(join(dest, 'map.json')),
      net_bytes: bytes(join(dest, 'net.bin.gz')),
      chunks: existsSync(join(dest, 'w')) ? readdirSync(join(dest, 'w')).length : 0,
      small,
      tiles: tiles.length,
      files: copied + small,
      index: indexPath,
      regions: index.regions.length,
    },
    null,
    2,
  ),
);
