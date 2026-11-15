// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Make your own street-level pictures available to the "reality view" of a
 * self-hosted copy of the simulator:
 *
 *   1. put the pictures (and the list your download tool wrote, if any)
 *      into  public/panos/
 *   2. npm run panos:index
 *
 * The folder is scanned for JPEG, PNG and WebP files.  Where each picture
 * belongs is read from its EXIF/XMP metadata, from a list next to it (JSON,
 * GeoJSON, CSV or a GeoPackage `metadata.gpkg`) or from its file name; the
 * result is written to  public/panos/index.json  for the game.
 *
 *   node tools/panos/index-panos.ts [folder]
 *
 * Mind the licence of what you put there: the folder is ignored by git on
 * purpose, and pictures you have no right to publish (Google Street View,
 * for one) must stay on your own machine.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORLD_MAX_E, WORLD_MAX_N, WORLD_MIN_E, WORLD_MIN_N, latLonToUtm32 } from '../../src/geo/utm.ts';
import { readImageMeta } from '../../src/reality/imagemeta.ts';
import { IMAGE_FILE, LIST_FILE, describeLocal, parseList } from '../../src/reality/local.ts';
import type { ListEntry, PanoIndex } from '../../src/reality/local.ts';
import { readGeoPackage } from './gpkg.ts';

/** Inside the simulated area (with a margin)? */
export function inMap(lat: number, lon: number): boolean {
  const [e, n] = latLonToUtm32(lat, lon);
  return e > WORLD_MIN_E - 500 && e < WORLD_MAX_E + 500 && n > WORLD_MIN_N - 500 && n < WORLD_MAX_N + 500;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

function head(path: string, bytes: number): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const buf = new Uint8Array(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export interface IndexReport {
  index: PanoIndex;
  placed: number;
  outside: number;
  panoramas: number;
  unplaced: string[];
  lists: number;
}

export async function indexFolder(folder: string): Promise<IndexReport> {
  const files: string[] = [];
  walk(folder, files);
  const list: ListEntry[] = [];
  let lists = 0;
  for (const f of files) {
    const rel = relative(folder, f);
    if (rel === 'index.json') continue;
    let found: ListEntry[] = [];
    if (/\.gpkg$/i.test(f)) found = await readGeoPackage(f);
    else if (LIST_FILE.test(f)) found = parseList(readFileSync(f, 'utf8'));
    if (found.length > 0) {
      lists++;
      list.push(...found);
    }
  }
  const report: IndexReport = { index: { images: [] }, placed: 0, outside: 0, panoramas: 0, unplaced: [], lists };
  for (const f of files) {
    if (!IMAGE_FILE.test(f)) continue;
    const rel = relative(folder, f).split(sep).join('/');
    const img = describeLocal({ name: rel, meta: readImageMeta(head(f, 512 * 1024)), url: rel }, list, inMap);
    const fin = (v: number, digits = 0): number | null => (Number.isFinite(v) ? Number(v.toFixed(digits)) : null);
    report.index.images.push({ file: rel, lat: fin(img.lat, 7), lon: fin(img.lon, 7), heading: fin(img.heading, 1), time: fin(img.time), pano: img.pano });
    if (img.pano) report.panoramas++;
    if (!img.located) report.unplaced.push(rel);
    else {
      report.placed++;
      if (!inMap(img.lat, img.lon)) report.outside++;
    }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = resolve(process.argv[2] ?? fileURLToPath(new URL('../../public/panos/', import.meta.url)));
  const r = await indexFolder(folder);
  writeFileSync(join(folder, 'index.json'), `${JSON.stringify(r.index, null, 1)}\n`);
  const n = r.index.images.length;
  console.log(`${n} picture${n === 1 ? '' : 's'} in ${folder}: ${r.placed} with a position (${r.outside} outside the map), ${r.panoramas} panorama${r.panoramas === 1 ? '' : 's'}, ${r.lists} list file${r.lists === 1 ? '' : 's'} read`);
  if (r.unplaced.length > 0) {
    console.log(`No position found for ${r.unplaced.length} (they can still be pinned to a place in the game):`);
    for (const f of r.unplaced.slice(0, 20)) console.log(`  ${f}`);
    if (r.unplaced.length > 20) console.log(`  … and ${r.unplaced.length - 20} more`);
  }
  console.log(`Wrote ${join(folder, 'index.json')}`);
}
