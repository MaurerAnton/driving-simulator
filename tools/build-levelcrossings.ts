// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the level crossings of the region are equipped with, as OpenStreetMap
 * says (crossing:barrier, crossing:light, crossing:bell on the nodes tagged
 * railway=level_crossing or railway=tram_level_crossing), written into
 * src/world/levelcrossings.data.ts.
 *
 * The map itself knows only where a road crosses a track (CrossingJson,
 * XING.RAIL / XING.TRAM, by tools/mapgen/control.ts) – not the barriers or
 * lights.  Building that into the map would change its bytes everywhere,
 * so the game reads it from this small list instead and matches it to the
 * crossings of the map by position (src/world/levelxing.ts).  Only nodes
 * with at least one of those tags are listed; the others are guessed from
 * the road (see `equipmentFor` there).
 *
 * Reads the extract of tools/osm-extract.ts (data/work/osm/b_*.json.gz):
 *
 *   node tools/build-levelcrossings.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const DIR = process.env.OSM_DIR ?? 'data/work/osm';
const OUT = process.env.OUT ?? 'src/world/levelcrossings.data.ts';

const barrierCode = (v: string | undefined): string => {
  switch (v) {
    case 'no':
      return 'n';
    case 'half':
      return 'h';
    case 'double_half':
      return 'd';
    case 'full':
      return 'f';
    case 'yes':
      return 'y';
    default:
      return '-';
  }
};
const yesNo = (v: string | undefined): string => (v === 'yes' ? 'y' : v === 'no' ? 'n' : '-');

const seen = new Set<number>();
const rows: string[] = [];
for (const f of readdirSync(DIR).sort()) {
  if (!f.endsWith('.json.gz')) continue;
  const text = gunzipSync(readFileSync(`${DIR}/${f}`)).toString();
  for (const line of text.split('\n')) {
    if (!line.includes('level_crossing')) continue;
    const m = /^\[(\d+),(-?[\d.]+),(-?[\d.]+),(\{.*\})\]/.exec(line);
    if (!m) continue;
    const id = Number(m[1]);
    if (seen.has(id)) continue;
    const t = JSON.parse(m[4]) as Record<string, string>;
    if (t.railway !== 'level_crossing' && t.railway !== 'tram_level_crossing') continue;
    const b = barrierCode(t['crossing:barrier']);
    const l = yesNo(t['crossing:light']);
    const bell = yesNo(t['crossing:bell']);
    // (a road's traffic lights at the crossing: 's' – the junction's signals rule it, not lights of the railway)
    const signals = t.crossing === 'traffic_signals' ? 's' : t.crossing === 'uncontrolled' ? 'u' : '-';
    if (b === '-' && l === '-' && bell === '-' && signals === '-') continue;
    seen.add(id);
    const kind = t.railway === 'level_crossing' ? 'r' : 't';
    rows.push(`${Math.round(Number(m[2]))} ${Math.round(Number(m[3]))} ${kind}${b}${l}${bell}${signals}`);
  }
}
rows.sort();
const body = rows.join(';');
writeFileSync(
  OUT,
  `// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The equipment of the level crossings of the region, from OpenStreetMap
 * (© OpenStreetMap contributors, ODbL 1.0) – written by
 * tools/build-levelcrossings.ts, read by src/world/levelxing.ts.
 *
 * Records parted by ';': "x z" (world metres, rounded) and five letters –
 * the railway (r: level_crossing, t: tram_level_crossing), the barriers
 * (n none, h half, d double half, f full, y some), the lights (y, n), the
 * bell (y, n), and the road's own control (s: traffic signals,
 * u: uncontrolled); '-': the map does not say.
 */
export const LEVEL_CROSSING_DATA = ${JSON.stringify(body)};
`,
);
console.log(`${rows.length} level crossings with equipment tags → ${OUT}`);
