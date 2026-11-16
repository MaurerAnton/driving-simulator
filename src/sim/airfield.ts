// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The airfields of the map as the aeroplane's wheels meet them: a paved
 * runway, taxiway or apron is firm and rolls like a road, a grass runway
 * like a mown field – wherever else the ground is what the world says.
 * Also where an aeroplane is put to begin: at the end of a runway, lined up
 * along it.
 */
import { pointInRing } from '../core/geom.ts';
import type { AirfieldJson, RunwayJson } from '../world/types.ts';
import type { Ground, GroundSample } from './vehicle/types.ts';

/** a surface the map calls paved */
/** how far above the ground the surfaces of an airfield are drawn (render/airfield.ts: 0.07 to 0.09 m) */
export const SURFACE_LIFT = 0.08;

export function paved(surface: string): boolean {
  return !/grass|ground|dirt|earth|gravel|sand|unpaved|compacted/.test(surface);
}

interface Strip {
  /** the middle line and its direction, its length and half its width */
  x1: number;
  z1: number;
  ux: number;
  uz: number;
  len: number;
  hw: number;
  paved: boolean;
}

export class AirfieldGround implements Ground {
  private readonly base: Ground;
  private readonly strips: Strip[] = [];
  private readonly aprons: Float64Array[] = [];

  constructor(base: Ground, fields: readonly AirfieldJson[]) {
    this.base = base;
    for (const f of fields) {
      for (const r of f.runways) this.addStrip(r.x1, r.z1, r.x2, r.z2, r.w, paved(r.s));
      for (const t of f.taxiways) for (let i = 0; i + 3 < t.p.length; i += 2) this.addStrip(t.p[i], t.p[i + 1], t.p[i + 2], t.p[i + 3], t.w, paved(t.s));
      for (const a of f.aprons) if (paved(a.s) && a.p.length >= 6) this.aprons.push(Float64Array.from(a.p));
    }
  }

  private addStrip(x1: number, z1: number, x2: number, z2: number, w: number, isPaved: boolean): void {
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 1) return;
    this.strips.push({ x1, z1, ux: (x2 - x1) / len, uz: (z2 - z1) / len, len, hw: w / 2, paved: isPaved });
  }

  /** On a strip of the airfield: paved (1), grass (0) – or not on one (-1). */
  surfaceAt(x: number, z: number): number {
    let grass = false;
    for (const s of this.strips) {
      const dx = x - s.x1;
      const dz = z - s.z1;
      const along = dx * s.ux + dz * s.uz;
      if (along < -s.hw || along > s.len + s.hw) continue;
      if (Math.abs(-dx * s.uz + dz * s.ux) > s.hw) continue;
      if (s.paved) return 1;
      grass = true;
    }
    for (const a of this.aprons) if (pointInRing(x, z, a)) return 1;
    return grass ? 0 : -1;
  }

  sample(x: number, z: number, yRef: number, out: GroundSample): void {
    this.base.sample(x, z, yRef, out);
    const s = this.surfaceAt(x, z);
    // (the runways, taxiways and aprons are drawn a few centimetres above the ground: the wheels roll on them)
    if (s >= 0) out.y += SURFACE_LIFT;
    if (s === 1) {
      out.grip = Math.max(out.grip, 1);
      out.rolling = 1;
    } else if (s === 0) {
      out.grip = Math.min(out.grip, 0.8);
      out.rolling = Math.min(out.rolling, 2.2);
    }
  }
}

/** Where to begin on a runway: 60 m in from one end, lined up along it (yaw as everywhere in the game: 0 north, + left). */
export function runwayStart(r: RunwayJson, fromSecond: boolean): { x: number; z: number; yaw: number } {
  const [ax, az, bx, bz] = fromSecond ? [r.x2, r.z2, r.x1, r.z1] : [r.x1, r.z1, r.x2, r.z2];
  const len = Math.hypot(bx - ax, bz - az) || 1;
  const ux = (bx - ax) / len;
  const uz = (bz - az) / len;
  const k = Math.min(60, len * 0.1);
  return { x: ax + ux * k, z: az + uz * k, yaw: Math.atan2(-ux, -uz) };
}

/**
 * The name of a runway end as it is painted on it: the magnetic heading in
 * tens of degrees ("09", "27") – from the map's "09/27" where it says, else
 * from its direction (north as the map's grid north).
 */
export function runwayEnd(r: RunwayJson, fromSecond: boolean): string {
  const parts = r.ref.split('/').map((s) => s.trim());
  if (parts.length === 2 && parts[0] && parts[1]) return fromSecond ? parts[1] : parts[0];
  const [ax, az, bx, bz] = fromSecond ? [r.x2, r.z2, r.x1, r.z1] : [r.x1, r.z1, r.x2, r.z2];
  const heading = ((Math.atan2(bx - ax, -(bz - az)) * 180) / Math.PI + 360) % 360;
  const n = Math.round(heading / 10) || 36;
  return String(n).padStart(2, '0');
}
