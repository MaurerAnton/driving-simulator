// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Streams the Hessen LoD2 CityGML file (≈ 450 MB) and writes a compact JSON
 * with one record per building (part): function code, roof type and the
 * boundary polygons in world coordinates.
 *
 *   node tools/lod2-extract.ts [path/to/Gemeinde-LoD2.gml]
 *
 * Output: data/work/lod2-buildings.json
 */
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SaxesParser } from 'saxes';
import { WORLD_ORIGIN_E, WORLD_ORIGIN_N } from '../src/geo/utm.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = resolve(root, process.argv[2] ?? 'data/raw/lod2/Baunatal-LoD2.gml');
const output = resolve(root, 'data/work/lod2-buildings.json');
if (!existsSync(input)) {
  console.error(`Missing ${input} – download the LoD2 archive from gds.hessen.de (see docs/MAP_DATA.md).`);
  process.exit(1);
}

/** surface kinds: 0 wall, 1 roof, 2 ground, 3 other */
interface Unit {
  id: string;
  fn: string;
  roof: string;
  /** [kind, x,y,z, x,y,z, …] per polygon (ring not closed) */
  polys: number[][];
}

const units: Unit[] = [];
const stack: Unit[] = [];
let surfaceKind = -1;
let inPosList = false;
let inExterior = false;
let textTarget: 'fn' | 'roof' | 'pos' | null = null;
let text = '';
let buildings = 0;

const KIND: Record<string, number> = {
  'bldg:WallSurface': 0,
  'bldg:RoofSurface': 1,
  'bldg:GroundSurface': 2,
  'bldg:ClosureSurface': 3,
  'bldg:OuterCeilingSurface': 3,
  'bldg:OuterFloorSurface': 3,
};

const parser = new SaxesParser({ xmlns: false });
parser.on('opentag', (tag) => {
  const name = tag.name;
  if (name === 'bldg:Building' || name === 'bldg:BuildingPart') {
    const parent = stack[stack.length - 1];
    const u: Unit = {
      id: String(tag.attributes['gml:id'] ?? ''),
      fn: parent?.fn ?? '',
      roof: parent?.roof ?? '',
      polys: [],
    };
    stack.push(u);
    if (name === 'bldg:Building') buildings++;
  } else if (name in KIND) {
    surfaceKind = KIND[name];
  } else if (name === 'gml:exterior') {
    inExterior = true;
  } else if (name === 'gml:posList' && surfaceKind >= 0 && inExterior) {
    inPosList = true;
    textTarget = 'pos';
    text = '';
  } else if (name === 'bldg:function' && stack.length) {
    textTarget = 'fn';
    text = '';
  } else if (name === 'bldg:roofType' && stack.length) {
    textTarget = 'roof';
    text = '';
  }
});
parser.on('text', (t) => {
  if (textTarget) text += t;
});
parser.on('closetag', (tag) => {
  const name = tag.name;
  const cur = stack[stack.length - 1];
  if (name === 'gml:posList' && inPosList) {
    inPosList = false;
    textTarget = null;
    const nums = text.trim().split(/\s+/).map(Number);
    let n = Math.floor(nums.length / 3);
    // drop the repeated closing vertex
    if (
      n > 3 &&
      nums[0] === nums[(n - 1) * 3] &&
      nums[1] === nums[(n - 1) * 3 + 1] &&
      nums[2] === nums[(n - 1) * 3 + 2]
    ) {
      n--;
    }
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
  } else if (name === 'bldg:function' && textTarget === 'fn') {
    if (cur) cur.fn = text.trim();
    textTarget = null;
  } else if (name === 'bldg:roofType' && textTarget === 'roof') {
    if (cur) cur.roof = text.trim();
    textTarget = null;
  } else if (name === 'gml:exterior') {
    inExterior = false;
  } else if (name in KIND) {
    surfaceKind = -1;
  } else if (name === 'bldg:Building' || name === 'bldg:BuildingPart') {
    const u = stack.pop()!;
    if (u.polys.length > 0) units.push(u);
  }
});
parser.on('error', (e) => {
  console.error('XML error:', e.message);
});

const total = statSync(input).size;
let read = 0;
let lastPct = -1;
const t0 = Date.now();
const stream = createReadStream(input, { encoding: 'utf8', highWaterMark: 1 << 20 });
stream.on('data', (chunk) => {
  parser.write(chunk as string);
  read += Buffer.byteLength(chunk as string);
  const pct = Math.floor((read / total) * 20);
  if (pct !== lastPct) {
    lastPct = pct;
    process.stdout.write(`\r[lod2] ${pct * 5}%  ${units.length} units  ${((Date.now() - t0) / 1000).toFixed(0)}s `);
  }
});
stream.on('end', () => {
  parser.close();
  mkdirSync(dirname(output), { recursive: true });
  const parts = ['{"source":"Hessische Verwaltung für Bodenmanagement und Geoinformation, 3D-Gebäudemodelle LoD2","units":[\n'];
  parts.push(units.map((u) => JSON.stringify(u)).join(',\n'));
  parts.push('\n]}\n');
  writeFileSync(output, parts.join(''));
  console.log(
    `\n[lod2] ${buildings} buildings, ${units.length} units with geometry → ${output} (${(statSync(output).size / 1048576).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
});
