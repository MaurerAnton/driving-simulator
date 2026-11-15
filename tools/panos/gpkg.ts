// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Positions from a GeoPackage (`metadata.gpkg`), the format in which some
 * street-view download tools keep their list of panoramas: one row per
 * panorama with its id, date and a point.
 *
 * Uses Node's built-in SQLite; without it the file is simply skipped.
 */
import { parseList } from '../../src/reality/local.ts';
import type { ListEntry } from '../../src/reality/local.ts';

/** Longitude / latitude of a GeoPackage point geometry, or null for anything else. */
export function gpkgPoint(blob: Uint8Array): { x: number; y: number; srs: number } | null {
  if (blob.length < 8 + 21 || blob[0] !== 0x47 || blob[1] !== 0x50) return null;
  const flags = blob[3];
  if (flags & 0x10) return null; // empty geometry
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const srs = view.getInt32(4, (flags & 1) === 1);
  const envelope = [0, 32, 48, 48, 64][(flags >> 1) & 7] ?? 0;
  const wkb = 8 + envelope;
  if (wkb + 21 > blob.length) return null;
  const le = blob[wkb] === 1;
  const type = view.getUint32(wkb + 1, le);
  // point, with or without Z/M (ISO numbers and the EWKB flag bits)
  if ((type & 0xffff) % 1000 !== 1) return null;
  return { x: view.getFloat64(wkb + 5, le), y: view.getFloat64(wkb + 13, le), srs };
}

interface Db {
  prepare(sql: string): { all(): Array<Record<string, unknown>> };
  close(): void;
}

export async function readGeoPackage(path: string): Promise<ListEntry[]> {
  let db: Db;
  try {
    const sqlite = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string, o?: object) => Db };
    db = new sqlite.DatabaseSync(path, { readOnly: true });
  } catch {
    return [];
  }
  const records: Array<Record<string, unknown>> = [];
  try {
    const tables = db.prepare("SELECT c.table_name AS t, g.column_name AS g FROM gpkg_contents c JOIN gpkg_geometry_columns g ON g.table_name = c.table_name WHERE c.data_type = 'features'").all();
    for (const { t, g } of tables) {
      if (typeof t !== 'string' || typeof g !== 'string' || /["\0]/.test(t)) continue;
      for (const row of db.prepare(`SELECT * FROM "${t}"`).all()) {
        const blob = row[g];
        if (!(blob instanceof Uint8Array)) continue;
        const p = gpkgPoint(blob);
        // only plain longitude/latitude (WGS 84) – what these tools write
        if (!p || (p.srs !== 4326 && p.srs !== 0 && p.srs !== -1)) continue;
        const rec: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          if (k !== g && k !== 'fid' && (typeof v === 'string' || typeof v === 'number')) rec[k] = v;
        }
        rec.lon = p.x;
        rec.lat = p.y;
        records.push(rec);
      }
    }
  } catch {
    /* not a GeoPackage after all */
  } finally {
    db.close();
  }
  return parseList(JSON.stringify(records));
}
