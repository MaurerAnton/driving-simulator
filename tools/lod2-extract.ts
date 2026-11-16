// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Streams a Hessen LoD2 CityGML file (≈ 450 MB for Baunatal, 2 GB for
 * Kassel) and keeps one compact record per building (part): function code,
 * roof type and the boundary polygons in world coordinates.
 *
 *   node tools/lod2-extract.ts --name Baunatal path/to/Baunatal-LoD2.gml
 *   unzip -p Baunatal-LoD2.zip '*.gml' | node tools/lod2-extract.ts --name Baunatal -
 *
 * Output: data/work/lod2/<name>/<bx>_<bz>.ndjson.gz – one building per line,
 * sorted into squares of 2 km (by the middle of the building), so that the
 * map build can read the buildings of one area without the rest.
 * tools/fetch-geodata.py runs this for every municipality it downloads.
 */
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { WORLD_ORIGIN_E, WORLD_ORIGIN_N } from '../src/geo/utm.ts';
import { LOD2_BIN, lod2BinKey } from './mapgen/store.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
let name = '';
let input = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--name') name = argv[++i] ?? '';
  else input = argv[i];
}
if (!name || !input || /[/\\]/.test(name)) {
  console.error('usage: node tools/lod2-extract.ts --name <municipality> <file.gml | ->');
  process.exit(1);
}
if (input !== '-' && !existsSync(resolve(root, input))) {
  console.error(`Missing ${input} – download the LoD2 archives from gds.hessen.de (see docs/MAP_DATA.md).`);
  process.exit(1);
}
const outDir = resolve(root, 'data/work/lod2', name);

/** surface kinds: 0 wall, 1 roof, 2 ground, 3 other */
interface Unit {
  id: string;
  fn: string;
  roof: string;
  /** [kind, x,y,z, x,y,z, …] per polygon (ring not closed) */
  polys: number[][];
}

const bins = new Map<string, string[]>();
let written = 0;
let buildings = 0;
const t0 = Date.now();

const KIND: Record<string, number> = {
  'bldg:WallSurface': 0,
  'bldg:RoofSurface': 1,
  'bldg:GroundSurface': 2,
  'bldg:ClosureSurface': 3,
  'bldg:OuterCeilingSurface': 3,
  'bldg:OuterFloorSurface': 3,
};

function keep(u: Unit): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const poly of u.polys) {
    for (let i = 1; i < poly.length; i += 3) {
      if (poly[i] < minX) minX = poly[i];
      if (poly[i] > maxX) maxX = poly[i];
      if (poly[i + 2] < minZ) minZ = poly[i + 2];
      if (poly[i + 2] > maxZ) maxZ = poly[i + 2];
    }
  }
  const key = lod2BinKey((minX + maxX) / 2, (minZ + maxZ) / 2);
  let list = bins.get(key);
  if (!list) bins.set(key, (list = []));
  list.push(JSON.stringify(u));
  written++;
}

const stack: Unit[] = [];
let surfaceKind = -1;
let inPosList = false;
let inExterior = false;
let textTarget: 'fn' | 'roof' | 'pos' | null = null;
let text = '';

const parser = new SaxesParser({ xmlns: false });
parser.on('opentag', (tag) => {
  const tagName = tag.name;
  if (tagName === 'bldg:Building' || tagName === 'bldg:BuildingPart') {
    const parent = stack[stack.length - 1];
    const u: Unit = {
      id: String(tag.attributes['gml:id'] ?? ''),
      fn: parent?.fn ?? '',
      roof: parent?.roof ?? '',
      polys: [],
    };
    stack.push(u);
    if (tagName === 'bldg:Building') buildings++;
  } else if (tagName in KIND) {
    surfaceKind = KIND[tagName];
  } else if (tagName === 'gml:exterior') {
    inExterior = true;
  } else if (tagName === 'gml:posList' && surfaceKind >= 0 && inExterior) {
    inPosList = true;
    textTarget = 'pos';
    text = '';
  } else if (tagName === 'bldg:function' && stack.length) {
    textTarget = 'fn';
    text = '';
  } else if (tagName === 'bldg:roofType' && stack.length) {
    textTarget = 'roof';
    text = '';
  }
});
parser.on('text', (t) => {
  if (textTarget) text += t;
});
parser.on('closetag', (tag) => {
  const tagName = tag.name;
  const cur = stack[stack.length - 1];
  if (tagName === 'gml:posList' && inPosList) {
    inPosList = false;
    textTarget = null;
    const nums = text.trim().split(/\s+/).map(Number);
    let n = Math.floor(nums.length / 3);
    // drop the repeated closing vertex
    if (n > 3 && nums[0] === nums[(n - 1) * 3] && nums[1] === nums[(n - 1) * 3 + 1] && nums[2] === nums[(n - 1) * 3 + 2]) n--;
    if (n >= 3 && cur) {
      const poly: number[] = [surfaceKind];
      for (let i = 0; i < n; i++) {
        poly.push(
          Math.round((nums[i * 3] - WORLD_ORIGIN_E) * 100) / 100,
          Math.round(nums[i * 3 + 2] * 100) / 100,
          Math.round(-(nums[i * 3 + 1] - WORLD_ORIGIN_N) * 100) / 100,
        );
      }
      cur.polys.push(poly);
    }
  } else if (tagName === 'bldg:function' && textTarget === 'fn') {
    if (cur) cur.fn = text.trim();
    textTarget = null;
  } else if (tagName === 'bldg:roofType' && textTarget === 'roof') {
    if (cur) cur.roof = text.trim();
    textTarget = null;
  } else if (tagName === 'gml:exterior') {
    inExterior = false;
  } else if (tagName in KIND) {
    surfaceKind = -1;
  } else if (tagName === 'bldg:Building' || tagName === 'bldg:BuildingPart') {
    const u = stack.pop()!;
    if (u.polys.length > 0) keep(u);
  }
});
let xmlErrors = 0;
parser.on('error', (e) => {
  if (xmlErrors++ < 3) console.error('XML error:', e.message);
});

const stream = input === '-' ? process.stdin : createReadStream(resolve(root, input), { highWaterMark: 1 << 20 });
stream.setEncoding('utf8');
await new Promise<void>((done, fail) => {
  stream.on('data', (chunk) => parser.write(chunk as string));
  stream.on('error', fail);
  stream.on('end', () => {
    parser.close();
    done();
  });
});

// (written only when the whole file was read: a half-read municipality leaves nothing behind)
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
let bytes = 0;
for (const [key, lines] of bins) {
  const gz = gzipSync(lines.join('\n') + '\n', { level: 6 });
  writeFileSync(resolve(outDir, `${key}.ndjson.gz`), gz);
  bytes += gz.length;
}
console.log(
  `[lod2] ${name}: ${buildings} buildings, ${written} units with geometry in ${bins.size} squares of ${LOD2_BIN / 1000} km ` +
    `(${(bytes / 1048576).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)} s`,
);
