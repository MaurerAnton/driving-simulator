// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The manifest of a map release: which files it holds, how big they are and
 * their SHA-256 – so `tools/fetch-map.ts` reads the names instead of having
 * them written into it (map.tar, tiles-patch.tar, the small files beside them).
 *
 *   node tools/map-files.ts --tag karte-YYYY-MM-DD [--out map-files.json]
 *   node tools/map-files.ts --check            # the manifest of the release in map.release
 *
 * Run it after the files are uploaded to the release (or with the local files
 * before), and upload the manifest with them.  A release without one is still
 * fetched: fetch-map falls back to the names it knows (map.tar, tiles-patch.tar,
 * the small files), so an older release keeps working.
 *
 * What it names: `map.tar` or the parts `map.tar.00 …` (whichever the release
 * has), `tiles-patch.tar`, and the small files that may sit beside them
 * (the timetable, the bus lines, the extra signs, the services).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const value = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const flag = (name: string): boolean => argv.includes(name);

/** The small files that may sit beside the map in a release, put into the map folder. */
export const EXTRA = ['timetable.json.gz', 'buslines.json.gz', 'signs.json.gz', 'services.json.gz'];

/** One file of a release. */
export interface MapFile {
  /** the name of the asset in the release */
  name: string;
  bytes: number;
  sha256: string;
}

/** The manifest: which files a release holds, with their size and checksum. */
export interface MapFilesManifest {
  v: 1;
  kind: 'map-files';
  /** the release tag these files belong to */
  tag: string;
  /** when it was written (ISO) */
  at: string;
  files: MapFile[];
}

/** The SHA-256 and the size of a file. */
function digest(path: string): { bytes: number; sha256: string } {
  const buf = readFileSync(path);
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

/** The names of a release's files, as `gh release view` lists them. */
export function releaseAssets(tag: string): string[] {
  const r = spawnSync('gh', ['release', 'view', tag, '--json', 'assets', '-q', '.assets[].name'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh release view ${tag}: ${r.stderr || r.stdout}`);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Is `name` one of the map's files (the tar, its parts, the patch, the small files)? */
export function isMapFile(name: string): boolean {
  return name === 'map.tar' || /^map\.tar\.\d+$/.test(name) || name === 'tiles-patch.tar' || EXTRA.includes(name);
}

/** The manifest of a release: its map files, with their size and checksum. */
export function manifestOf(tag: string, names: string[], dir = ''): MapFilesManifest {
  const files: MapFile[] = [];
  for (const name of names) {
    if (!isMapFile(name)) continue;
    const local = dir ? resolve(dir, name) : '';
    if (local && existsSync(local)) files.push({ name, ...digest(local) });
    else files.push({ name, bytes: 0, sha256: '' }); // (not here: the name is what matters; a check fills the rest)
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { v: 1, kind: 'map-files', tag, at: new Date().toISOString(), files };
}

if (flag('--check')) {
  const tag = readFileSync(resolve(root, 'map.release'), 'utf8').trim();
  const names = releaseAssets(tag);
  const m = manifestOf(tag, names);
  console.log(JSON.stringify(m, null, 1));
  process.exit(0);
}

const tag = value('--tag');
if (!tag) {
  console.error('usage: node tools/map-files.ts --tag karte-YYYY-MM-DD [--out map-files.json]');
  process.exit(1);
}
const names = releaseAssets(tag);
const m = manifestOf(tag, names, resolve(root, 'data/work'));
const out = resolve(root, value('--out') ?? 'map-files.json');
writeFileSync(out, JSON.stringify(m, null, 1) + '\n');
console.log(`[map-files] ${m.files.length} files of ${tag} → ${out}`);
for (const f of m.files) console.log(`  ${f.name}  ${f.bytes} bytes  ${f.sha256.slice(0, 16)}…`);
