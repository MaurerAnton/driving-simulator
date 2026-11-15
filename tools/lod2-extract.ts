// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Streams the Hessen LoD2 CityGML files (≈ 450 MB for Baunatal, 2 GB for
 * Kassel) and writes a compact JSON with one record per building (part):
 * function code, roof type and the boundary polygons in world coordinates.
 *
 *   node tools/lod2-extract.ts [path/to/Gemeinde-LoD2.gml …]
 *
 * Without arguments: every *.gml in data/raw/lod2.
 * Output: data/work/lod2-buildings.json – one building per line, so that it
 * can be written and read piece by piece.
 */
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, statSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SaxesParser } from 'saxes';
import { WORLD_ORIGIN_E, WORLD_ORIGIN_N } from '../src/geo/utm.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lod2Dir = resolve(root, 'data/raw/lod2');
const inputs =
  process.argv.length > 2
    ? process.argv.slice(2).map((f) => resolve(root, f))
    : existsSync(lod2Dir)
      ? readdirSync(lod2Dir)
          .filter((f) => f.endsWith('.gml'))
          .sort()
          .map((f) => resolve(lod2Dir, f))
      : [];
const output = resolve(root, 'data/work/lod2-buildings.json');
const missing = inputs.filter((f) => !existsSync(f));
if (inputs.length === 0 || missing.length > 0) {
  console.error(`Missing ${missing[0] ?? `${lod2Dir}/*.gml`} – download the LoD2 archives from gds.hessen.de (see docs/MAP_DATA.md).`);
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

mkdirSync(dirname(output), { recursive: true });
const out = openSync(output, 'w');
writeSync(out, '{"source":"Hessische Verwaltung für Bodenmanagement und Geoinformation, 3D-Gebäudemodelle LoD2","units":[\n');
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

/** Reads one CityGML file; its buildings are appended to the output as they are completed. */
function extract(input: string): Promise<void> {
  return new Promise((done, fail) => {
    const stack: Unit[] = [];
    let surfaceKind = -1;
    let inPosList = false;
    let inExterior = false;
    let textTarget: 'fn' | 'roof' | 'pos' | null = null;
    let text = '';

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
        if (u.polys.length > 0) {
          writeSync(out, `${written > 0 ? ',\n' : ''}${JSON.stringify(u)}`);
          written++;
        }
      }
    });
    parser.on('error', (e) => {
      console.error('XML error:', e.message);
    });

    const total = statSync(input).size;
    let read = 0;
    let lastPct = -1;
    const stream = createReadStream(input, { encoding: 'utf8', highWaterMark: 1 << 20 });
    stream.on('data', (chunk) => {
      parser.write(chunk as string);
      read += Buffer.byteLength(chunk as string);
      const pct = Math.floor((read / total) * 20);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(`\r[lod2] ${input.split('/').pop()}: ${pct * 5}%  ${written} units  ${((Date.now() - t0) / 1000).toFixed(0)}s `);
      }
    });
    stream.on('error', fail);
    stream.on('end', () => {
      parser.close();
      process.stdout.write('\n');
      done();
    });
  });
}

for (const input of inputs) await extract(input);
writeSync(out, '\n]}\n');
closeSync(out);
console.log(`[lod2] ${buildings} buildings, ${written} units with geometry → ${output} (${(statSync(output).size / 1048576).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
